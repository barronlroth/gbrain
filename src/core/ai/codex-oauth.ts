import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { AIConfigError, AITransientError } from './errors.ts';
import { VERSION } from '../../version.ts';

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_ACCESS_TOKEN_EXPIRY_SKEW_SECONDS = 120;

type Env = Record<string, string | undefined>;
type AuthStore = Record<string, any>;

interface TokenSet {
  access_token: string;
  [key: string]: unknown;
}

export function resolveCodexBaseURL(env: Env): string {
  return (env.HERMES_CODEX_BASE_URL ?? '').trim().replace(/\/$/, '') || DEFAULT_CODEX_BASE_URL;
}

function platformHermesRoot(env: Env): string {
  if (process.platform === 'win32') {
    const localAppData = (env.LOCALAPPDATA ?? '').trim();
    return localAppData
      ? join(localAppData, 'hermes')
      : join((env.HOME ?? homedir()).trim() || homedir(), 'AppData', 'Local', 'hermes');
  }
  return join((env.HOME ?? homedir()).trim() || homedir(), '.hermes');
}

function hermesAuthPaths(env: Env): { profilePath?: string; globalPath: string } {
  const explicitHome = (env.HERMES_HOME ?? '').trim();
  if (explicitHome) {
    // Hermes exports HERMES_HOME as the exact active profile directory. Do
    // not append profiles/$HERMES_PROFILE here or a profile-scoped process
    // resolves .../profiles/work/profiles/work/auth.json.
    const activeHome = resolve(explicitHome);
    const parent = dirname(activeHome);
    const globalHome = parent.endsWith(`${process.platform === 'win32' ? '\\' : '/'}profiles`)
      ? dirname(parent)
      : activeHome;
    return globalHome === activeHome
      ? { globalPath: join(activeHome, 'auth.json') }
      : {
          profilePath: join(activeHome, 'auth.json'),
          globalPath: join(globalHome, 'auth.json'),
        };
  }
  const hermesHome = platformHermesRoot(env);
  const profile = (env.HERMES_PROFILE ?? '').trim();
  return {
    ...(profile && profile !== 'default'
      ? { profilePath: join(hermesHome, 'profiles', profile, 'auth.json') }
      : {}),
    globalPath: join(hermesHome, 'auth.json'),
  };
}

function readJsonFile(path: string): AuthStore | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AuthStore;
  } catch {
    return null;
  }
}

function asTokenSet(value: unknown): TokenSet | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const access = typeof obj.access_token === 'string' ? obj.access_token.trim() : '';
  return access ? { ...obj, access_token: access } as TokenSet : null;
}

function decodeJwtPayload(token: string): Record<string, any> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - (parts[1].length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, any>;
  } catch {
    return null;
  }
}

function accessTokenIsExpiring(token: string, skewSeconds = CODEX_ACCESS_TOKEN_EXPIRY_SKEW_SECONDS): boolean {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === 'number'
    ? exp <= Math.floor(Date.now() / 1000) + Math.max(0, skewSeconds)
    : false;
}

function providerPool(store: AuthStore | null): unknown[] {
  const pool = store?.credential_pool?.['openai-codex'];
  return Array.isArray(pool) ? pool : [];
}

function parseAbsoluteTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1_000_000_000_000 ? value / 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1_000_000_000_000 ? numeric / 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function exhaustedTtlSeconds(entry: Record<string, unknown>, soleCredential: boolean): number {
  const code = typeof entry.last_error_code === 'number' ? entry.last_error_code : null;
  const reason = typeof entry.failure_reason === 'string' ? entry.failure_reason : '';
  if (code === 401) return 5 * 60;
  const base = 60 * 60;
  if (reason === 'billing_unverified' && code !== 402) return 60;
  const billing = code === 402 || reason === 'billing';
  return soleCredential && !billing ? 60 : base;
}

function entryIsAvailable(entry: Record<string, unknown>, soleCredential: boolean): boolean {
  const status = typeof entry.last_status === 'string' ? entry.last_status.toLowerCase() : '';
  if (status === 'dead') return false;
  if (status === 'exhausted') {
    const resetAt = parseAbsoluteTimestamp(entry.last_error_reset_at);
    const statusAt = parseAbsoluteTimestamp(entry.last_status_at);
    const exhaustedUntil = resetAt ?? (statusAt === null
      ? null
      : statusAt + exhaustedTtlSeconds(entry, soleCredential));
    if (exhaustedUntil !== null && exhaustedUntil > Date.now() / 1000) return false;
  }
  return true;
}

function loadUsableCodexTokens(env: Env): TokenSet | null {
  const { profilePath, globalPath } = hermesAuthPaths(env);
  const profileStore = profilePath ? readJsonFile(profilePath) : null;
  const profilePool = providerPool(profileStore);
  const globalStore = readJsonFile(globalPath);
  const globalPool = providerPool(globalStore);

  // Match Hermes' provider-level shadowing: any profile entries make that
  // provider slice authoritative. Never bypass an exhausted/dead profile pool
  // by silently borrowing a global credential.
  const candidates = (profilePool.length > 0 ? profilePool : globalPool)
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      const aPriority = a.candidate && typeof a.candidate === 'object'
        && typeof (a.candidate as Record<string, unknown>).priority === 'number'
        ? (a.candidate as Record<string, number>).priority
        : 0;
      const bPriority = b.candidate && typeof b.candidate === 'object'
        && typeof (b.candidate as Record<string, unknown>).priority === 'number'
        ? (b.candidate as Record<string, number>).priority
        : 0;
      return aPriority - bPriority || a.index - b.index;
    })
    .map(({ candidate }) => candidate);
  const soleCredential = candidates.filter(candidate => {
    if (!candidate || typeof candidate !== 'object') return false;
    return String((candidate as Record<string, unknown>).last_status ?? '').toLowerCase() !== 'dead';
  }).length <= 1;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const entry = candidate as Record<string, unknown>;
    if (!entryIsAvailable(entry, soleCredential)) continue;
    const tokens = asTokenSet(entry);
    if (tokens && !accessTokenIsExpiring(tokens.access_token)) return tokens;
  }

  // Legacy singleton fallback is allowed only when neither authoritative pool
  // contains entries. GBrain never refreshes it: Hermes owns that lock-sensitive
  // lifecycle.
  if (profilePool.length === 0 && globalPool.length === 0) {
    const singletonStore = profilePath && profileStore ? profileStore : globalStore;
    const singleton = asTokenSet(singletonStore?.providers?.['openai-codex']?.tokens);
    if (singleton && !accessTokenIsExpiring(singleton.access_token)) return singleton;
  }
  return null;
}

/**
 * Read-only readiness check for the Hermes-owned Codex OAuth pool.
 * Uses the exact same profile shadowing, status, reset, and expiry rules as
 * request-time token resolution, but never refreshes or mutates credentials.
 */
export function hasUsableCodexOAuthAccessToken(env: Env): boolean {
  return loadUsableCodexTokens(env) !== null;
}

export async function resolveCodexOAuthAccessToken(env: Env): Promise<string> {
  const tokens = loadUsableCodexTokens(env);
  if (!tokens) {
    throw new AIConfigError(
      'No usable OpenAI Codex OAuth access token was found in Hermes auth state.',
      'Run `hermes auth add openai-codex`. GBrain deliberately does not consume Codex CLI refresh tokens or refresh Hermes credentials without Hermes locking.',
    );
  }
  return tokens.access_token;
}

function isOfficialCodexBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/$/, '');
    return url.protocol === 'https:'
      && url.hostname === 'chatgpt.com'
      && (url.port === '' || url.port === '443')
      && (path === '/backend-api/codex' || path.startsWith('/backend-api/codex/'));
  } catch {
    return false;
  }
}

function codexHeaders(token: string, baseUrl: string, source?: HeadersInit): Headers {
  const headers = new Headers(source);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  headers.set('accept', 'text/event-stream');
  headers.set('authorization', `Bearer ${token}`);
  headers.set('originator', 'codex_cli_rs');
  headers.set('user-agent', 'codex_cli_rs/0.0.0 (GBrain)');
  if (isOfficialCodexBaseUrl(baseUrl)) {
    headers.set('originator', 'hermes-agent');
    headers.set('user-agent', `HermesAgent/${VERSION}`);
  }
  const accountId = decodeJwtPayload(token)?.['https://api.openai.com/auth']?.chatgpt_account_id;
  if (typeof accountId === 'string' && accountId) {
    headers.set('ChatGPT-Account-ID', accountId);
  }
  return headers;
}

function errorDetail(payload: Record<string, any> | null): string {
  if (!payload) return '';
  const candidate = payload.error ?? payload.response?.error ?? payload;
  if (typeof candidate === 'string') return candidate;
  if (typeof candidate?.message === 'string') return candidate.message;
  try { return JSON.stringify(candidate); } catch { return String(candidate); }
}

function parseCodexSse(text: string): Record<string, unknown> {
  let completed: Record<string, any> | null = null;
  const outputByIndex = new Map<number, unknown>();
  const textDeltas: string[] = [];

  for (const frame of text.split(/\r?\n\r?\n/)) {
    if (!frame.trim()) continue;
    let wireEvent = '';
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) wireEvent = line.slice('event:'.length).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join('\n');
    if (raw === '[DONE]') continue;

    let payload: Record<string, any>;
    try { payload = JSON.parse(raw) as Record<string, any>; } catch { continue; }
    // The decoded payload type is authoritative. Some proxies collapse every
    // SSE frame to a generic wire event while preserving the real event in
    // payload.type.
    const event = typeof payload.type === 'string' ? payload.type : wireEvent;

    if (event === 'response.output_item.done' && payload.item) {
      const idx = typeof payload.output_index === 'number' ? payload.output_index : outputByIndex.size;
      outputByIndex.set(idx, payload.item);
      continue;
    }
    if (event === 'response.output_text.delta' && typeof payload.delta === 'string') {
      textDeltas.push(payload.delta);
      continue;
    }
    if (event === 'response.completed' && payload.response) {
      completed = payload.response as Record<string, any>;
      continue;
    }
    if (event === 'response.failed' || event === 'response.incomplete' || event === 'error') {
      const detail = errorDetail(payload);
      throw new AITransientError(`OpenAI Codex stream ${event}${detail ? `: ${detail}` : ''}`);
    }
  }

  if (!completed) {
    throw new AITransientError('OpenAI Codex stream ended without response.completed.');
  }

  const doneOutput = [...outputByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item);
  if (doneOutput.length > 0) {
    completed.output = doneOutput;
  } else if (textDeltas.length > 0) {
    completed.output = [{
      id: 'msg_gbrain_codex_stream',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: textDeltas.join(''), annotations: [] }],
    }];
  }
  return completed;
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  const requestId = upstream.headers.get('x-request-id') ?? upstream.headers.get('openai-request-id');
  if (requestId) headers.set('x-request-id', requestId);
  return headers;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const obj = part as Record<string, unknown>;
    return typeof obj.text === 'string' ? obj.text : typeof obj.content === 'string' ? obj.content : '';
  }).filter(Boolean).join('\n');
}

function hoistDeveloperInstructions(body: Record<string, unknown>): void {
  if (typeof body.instructions === 'string' && body.instructions.trim()) return;
  if (!Array.isArray(body.input)) return;
  const instructionParts: string[] = [];
  const kept: unknown[] = [];
  for (const item of body.input) {
    if (!item || typeof item !== 'object') { kept.push(item); continue; }
    const obj = item as Record<string, unknown>;
    const role = typeof obj.role === 'string' ? obj.role : '';
    if (role === 'developer' || role === 'system') {
      const text = contentToText(obj.content).trim();
      if (text) instructionParts.push(text);
    } else {
      kept.push(item);
    }
  }
  if (instructionParts.length > 0) {
    body.instructions = instructionParts.join('\n\n');
    body.input = kept;
  }
}

export function createCodexResponsesFetch(env: Env): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const original = input instanceof Request ? input : new Request(input, init);
    const token = await resolveCodexOAuthAccessToken(env);
    const url = new URL(original.url);
    const headers = codexHeaders(token, resolveCodexBaseURL(env), original.headers);

    if (!url.pathname.endsWith('/responses')) {
      return fetch(original, { headers, signal: init?.signal ?? original.signal });
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await original.text()) as Record<string, unknown>;
    } catch (err) {
      throw new AIConfigError(`OpenAI Codex request body was not JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    body.stream = true;
    body.store = false;
    hoistDeveloperInstructions(body);
    delete body.max_output_tokens;

    const upstream = await fetch(url, {
      method: original.method || 'POST',
      headers,
      body: JSON.stringify(body),
      signal: init?.signal ?? original.signal,
    });
    if (!upstream.ok) return upstream;

    const completed = parseCodexSse(await upstream.text());
    return new Response(JSON.stringify(completed), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream),
    });
  }) as typeof fetch;
}
