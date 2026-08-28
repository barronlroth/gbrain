import type { Recipe } from '../types.ts';
import { resolveCodexBaseURL, createCodexResponsesFetch } from '../codex-oauth.ts';

const CODEX_CHAT_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4', 'gpt-5.4-mini',
  'gpt-5.3-codex', 'gpt-5.3-codex-spark',
];

export const openaiCodex: Recipe = {
  id: 'openai-codex',
  name: 'OpenAI Codex OAuth',
  tier: 'native',
  implementation: 'openai-codex',
  auth_env: {
    required: [],
    optional: ['HERMES_HOME', 'HERMES_PROFILE', 'HERMES_CODEX_BASE_URL'],
    setup_url: 'https://hermes-agent.nousresearch.com/docs/integrations/providers',
  },
  touchpoints: {
    chat: {
      models: CODEX_CHAT_MODELS,
      supports_tools: true,
      supports_subagent_loop: true,
      // GBrain's flag controls explicit Anthropic-style cacheControl metadata.
      // OpenAI prompt caching is automatic and must not use that mapping.
      supports_prompt_cache: false,
      // Deliberately no recipe-wide context cap: the Codex catalog is
      // heterogeneous (Spark is 128K; Terra/Sol and most others are 272K).
      // A single value is either unsafe or needlessly wasteful.
      price_last_verified: '2026-08-01',
    },
  },
  aliases: {
    'gpt-5.6': 'gpt-5.6-sol',
  },
  setup_hint: 'Authenticate Codex OAuth with Hermes: `hermes auth add openai-codex`. GBrain reads Hermes-owned access tokens but never consumes Codex CLI refresh tokens.',
  resolveOpenAICompatConfig(env) {
    return {
      baseURL: resolveCodexBaseURL(env),
      fetch: createCodexResponsesFetch(env),
    };
  },
};
