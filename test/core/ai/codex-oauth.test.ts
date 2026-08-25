import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createCodexResponsesFetch,
  hasUsableCodexOAuthAccessToken,
  resolveCodexOAuthAccessToken,
} from '../../../src/core/ai/codex-oauth.ts';
import { openaiCodex } from '../../../src/core/ai/recipes/openai-codex.ts';
import {
  configureGateway,
  isAvailable,
  probeChatModel,
  resetGateway,
} from '../../../src/core/ai/gateway.ts';

function jwt(claims: Record<string, unknown>): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
}

function writeHermesToken(dir: string, accessToken: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    credential_pool: {
      'openai-codex': [{ source: 'manual:device_code', access_token: accessToken }],
    },
  }));
}

function writeHermesPool(dir: string, entries: Array<Record<string, unknown>>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    credential_pool: { 'openai-codex': entries },
  }));
}

function completedSse(output: unknown[] = []): string {
  return [
    'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"OK","annotations":[]}]}}',
    '',
    `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-5.6-sol', output, usage: { input_tokens: 1, output_tokens: 1 } } })}`,
    '',
  ].join('\n');
}

describe('openai-codex OAuth fetch wrapper', () => {
  test('is a chat-only provider without a false recipe-wide context cap', () => {
    expect(openaiCodex.implementation).toBe('openai-codex');
    expect(openaiCodex.touchpoints.expansion).toBeUndefined();
    expect(openaiCodex.touchpoints.chat?.models).toContain('gpt-5.6-luna-pro');
    expect(openaiCodex.touchpoints.chat?.models).toContain('gpt-5.3-codex');
    expect(openaiCodex.touchpoints.chat?.models).not.toContain('gpt-5.5-codex');
    expect(openaiCodex.touchpoints.chat?.max_context_tokens).toBeUndefined();
    expect(openaiCodex.aliases?.['gpt-5.6']).toBe('gpt-5.6-sol');
  });

  test('reads only a usable configured access token and never consumes Codex CLI auth', async () => {
    const hermesDir = mkdtempSync(join(tmpdir(), 'gbrain-primary-auth-empty-'));
    const codexDir = mkdtempSync(join(tmpdir(), 'gbrain-codex-cli-'));
    try {
      writeFileSync(join(codexDir, 'auth.json'), JSON.stringify({
        tokens: { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) },
      }));
      await expect(resolveCodexOAuthAccessToken({ HERMES_HOME: hermesDir, CODEX_HOME: codexDir })).rejects.toThrow(/auth state/);

      writeHermesToken(hermesDir, jwt({ exp: Math.floor(Date.now() / 1000) - 1 }));
      await expect(resolveCodexOAuthAccessToken({ HERMES_HOME: hermesDir })).rejects.toThrow(/No usable/);
    } finally {
      rmSync(hermesDir, { recursive: true, force: true });
      rmSync(codexDir, { recursive: true, force: true });
    }
  });

  test('profile entries shadow global credentials and dead or cooling entries stay unavailable', async () => {
    const hermesDir = mkdtempSync(join(tmpdir(), 'gbrain-profile-auth-'));
    const profileDir = join(hermesDir, 'profiles', 'work');
    const usableGlobal = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    try {
      writeHermesToken(hermesDir, usableGlobal);
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(join(profileDir, 'auth.json'), JSON.stringify({
        credential_pool: {
          'openai-codex': [{
            source: 'manual:dead',
            access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
            last_status: 'dead',
          }],
        },
      }));
      await expect(resolveCodexOAuthAccessToken({
        HERMES_HOME: hermesDir,
        HERMES_PROFILE: 'work',
      })).rejects.toThrow(/No usable/);

      writeFileSync(join(profileDir, 'auth.json'), JSON.stringify({
        credential_pool: {
          'openai-codex': [{
            source: 'manual:cooldown',
            access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
            last_status: 'exhausted',
            last_error_reset_at: Math.floor(Date.now() / 1000) + 3600,
          }],
        },
      }));
      await expect(resolveCodexOAuthAccessToken({
        HERMES_HOME: hermesDir,
        HERMES_PROFILE: 'work',
      })).rejects.toThrow(/No usable/);

      writeFileSync(join(profileDir, 'auth.json'), JSON.stringify({ credential_pool: {} }));
      expect(await resolveCodexOAuthAccessToken({
        HERMES_HOME: hermesDir,
        HERMES_PROFILE: 'work',
      })).toBe(usableGlobal);
    } finally {
      rmSync(hermesDir, { recursive: true, force: true });
    }
  });

  test('readiness uses the same Hermes credential-pool semantics as request-time auth', () => {
    const hermesDir = mkdtempSync(join(tmpdir(), 'gbrain-codex-readiness-'));
    const profileDir = join(hermesDir, 'profiles', 'work');
    const now = Math.floor(Date.now() / 1000);
    const usable = jwt({ exp: now + 3600 });
    const expiringAtSkew = jwt({ exp: now + 120 });
    try {
      expect(hasUsableCodexOAuthAccessToken({ HERMES_HOME: hermesDir })).toBe(false);

      writeHermesPool(hermesDir, [{ access_token: expiringAtSkew }]);
      expect(hasUsableCodexOAuthAccessToken({ HERMES_HOME: hermesDir })).toBe(false);

      writeHermesPool(hermesDir, [{ access_token: usable, last_status: 'dead' }]);
      expect(hasUsableCodexOAuthAccessToken({ HERMES_HOME: hermesDir })).toBe(false);

      writeHermesPool(hermesDir, [{ access_token: usable, last_status: 'exhausted' }]);
      expect(hasUsableCodexOAuthAccessToken({ HERMES_HOME: hermesDir })).toBe(false);

      writeHermesPool(hermesDir, [{
        access_token: usable,
        last_status: 'exhausted',
        last_error_reset_at: now + 3600,
      }]);
      expect(hasUsableCodexOAuthAccessToken({ HERMES_HOME: hermesDir })).toBe(false);

      writeHermesPool(hermesDir, [{
        access_token: usable,
        last_status: 'exhausted',
        last_error_reset_at: now - 1,
      }]);
      expect(hasUsableCodexOAuthAccessToken({ HERMES_HOME: hermesDir })).toBe(true);

      writeHermesPool(hermesDir, [{ access_token: usable }]);
      mkdirSync(profileDir, { recursive: true });
      writeHermesPool(profileDir, [{ access_token: usable, last_status: 'dead' }]);
      expect(hasUsableCodexOAuthAccessToken({
        HERMES_HOME: hermesDir,
        HERMES_PROFILE: 'work',
      })).toBe(false);

      writeHermesPool(profileDir, []);
      expect(hasUsableCodexOAuthAccessToken({
        HERMES_HOME: hermesDir,
        HERMES_PROFILE: 'work',
      })).toBe(true);

      writeHermesPool(profileDir, [{ access_token: usable }]);
      expect(hasUsableCodexOAuthAccessToken({
        HERMES_HOME: hermesDir,
        HERMES_PROFILE: 'work',
      })).toBe(true);
    } finally {
      rmSync(hermesDir, { recursive: true, force: true });
    }
  });

  test('gateway availability and chat probe fail closed when Codex OAuth is unusable', () => {
    const hermesDir = mkdtempSync(join(tmpdir(), 'gbrain-codex-gateway-readiness-'));
    try {
      configureGateway({
        chat_model: 'openai-codex:gpt-5.6-terra',
        env: { HERMES_HOME: hermesDir },
      });
      expect(isAvailable('chat')).toBe(false);
      expect(probeChatModel('openai-codex:gpt-5.6-terra')).toMatchObject({
        ok: false,
        reason: 'unavailable',
      });

      writeHermesToken(hermesDir, jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }));
      expect(isAvailable('chat')).toBe(true);
      expect(probeChatModel('openai-codex:gpt-5.6-terra')).toEqual({ ok: true });
    } finally {
      resetGateway();
      rmSync(hermesDir, { recursive: true, force: true });
    }
  });

  test('sets Codex headers, preserves cache routing, hoists instructions, and prefers done items', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-codex-oauth-'));
    try {
      writeHermesToken(dir, jwt({
        exp: Math.floor(Date.now() / 1000) + 3600,
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_test' },
      }));
      const priorFetch = globalThis.fetch;
      let capturedBody: Record<string, any> = {};
      let capturedHeaders = new Headers();
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body));
        return new Response(completedSse([{ type: 'message', content: [{ type: 'output_text', text: 'STALE' }] }]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as unknown as typeof fetch;

      try {
        const response = await createCodexResponsesFetch({ HERMES_HOME: dir })(
          'https://chatgpt.com/backend-api/codex/responses',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'gpt-5.6-sol',
              input: [
                { role: 'developer', content: 'Reply exactly OK.' },
                { role: 'user', content: [{ type: 'input_text', text: 'Say OK' }] },
              ],
              prompt_cache_key: 'stable-prefix-hash',
              max_output_tokens: 10,
            }),
          },
        );
        const json = await response.json() as Record<string, any>;
        expect(capturedHeaders.get('authorization')).toMatch(/^Bearer /);
        expect(capturedHeaders.get('originator')).toBe('codex_cli_rs');
        expect(capturedHeaders.get('user-agent')).toMatch(/^codex_cli_rs/);
        expect(capturedHeaders.get('chatgpt-account-id')).toBe('acct_test');
        expect(capturedBody.stream).toBe(true);
        expect(capturedBody.store).toBe(false);
        expect(capturedBody.instructions).toBe('Reply exactly OK.');
        expect(capturedBody.prompt_cache_key).toBe('stable-prefix-hash');
        expect(capturedBody).not.toHaveProperty('max_output_tokens');
        expect(json.output?.[0]?.content?.[0]?.text).toBe('OK');
      } finally {
        globalThis.fetch = priorFetch;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('assembles text deltas when no output_item.done arrives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-codex-delta-'));
    try {
      writeHermesToken(dir, jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }));
      const priorFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response([
        'data: {"type":"response.output_text.delta","delta":"hel"}', '',
        'data: {"type":"response.output_text.delta","delta":"lo"}', '',
        'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}', '',
      ].join('\n'), { status: 200 })) as unknown as typeof fetch;
      try {
        const response = await createCodexResponsesFetch({ HERMES_HOME: dir })(
          'https://chatgpt.com/backend-api/codex/responses',
          { method: 'POST', body: JSON.stringify({ input: [] }) },
        );
        const json = await response.json() as Record<string, any>;
        expect(json.output?.[0]?.content?.[0]?.text).toBe('hello');
      } finally { globalThis.fetch = priorFetch; }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('uses payload.type when the wire event is generic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-codex-event-type-'));
    try {
      writeHermesToken(dir, jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }));
      const priorFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response([
        'event: message',
        'data: {"type":"response.output_text.delta","delta":"payload-wins"}',
        '',
        'event: message',
        'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}',
        '',
      ].join('\n'), { status: 200 })) as unknown as typeof fetch;
      try {
        const response = await createCodexResponsesFetch({ HERMES_HOME: dir })(
          'https://chatgpt.com/backend-api/codex/responses',
          { method: 'POST', body: JSON.stringify({ input: [] }) },
        );
        const json = await response.json() as Record<string, any>;
        expect(json.output?.[0]?.content?.[0]?.text).toBe('payload-wins');
      } finally { globalThis.fetch = priorFetch; }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('surfaces failed and incomplete streams instead of returning partial output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-codex-failed-'));
    try {
      writeHermesToken(dir, jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }));
      const priorFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response(
        'data: {"type":"response.failed","response":{"error":{"message":"backend exploded"}}}\n\n',
        { status: 200 },
      )) as unknown as typeof fetch;
      try {
        await expect(createCodexResponsesFetch({ HERMES_HOME: dir })(
          'https://chatgpt.com/backend-api/codex/responses',
          { method: 'POST', body: JSON.stringify({ input: [] }) },
        )).rejects.toThrow(/backend exploded/);
      } finally { globalThis.fetch = priorFetch; }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
