'use strict';
// LLMTR / FreeLLMAPI provider configuration and state manager for PHOTON AI.
//
// * Reads LLMTR_API_KEY only from the backend environment (API.env / .env next to server.js).
// * Never stores the raw key; only masked key identifiers appear in status or logs.
// * State is persisted in .photon-llmtr-config.json with mode 0600.
// * Spending policy: 'allow_free_only' allows access to LLMTR free-tier models while
//   strictly enforcing zero unapproved billing. 'allow_all' allows all configured models.
//   'block' disables all requests.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_VERSION = 1;
const CONFIG_FILE = '.photon-llmtr-config.json';
const MAX_RECENT_ERRORS = 20;
const MAX_MODELS = 200;

const SPENDING_POLICIES = Object.freeze(['allow_free_only', 'allow_all', 'block']);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,160}$/;

const NON_CHAT_ID = /(whisper|tts|embed|moderation|audio|transcribe)/i;

const DEFAULT_LLMTR_MODELS = Object.freeze({
  'openai/gpt-5.4-mini': {
    id: 'openai/gpt-5.4-mini',
    name: 'GPT-5.4 Mini (LLMTR)',
    ownedBy: 'openai',
    created: 1794652020,
    enabled: true,
    contextWindow: 128000,
    free: true,
  },
  'openai/gpt-5.6-terra-pro': {
    id: 'openai/gpt-5.6-terra-pro',
    name: 'GPT-5.6 Terra Pro (LLMTR)',
    ownedBy: 'openai',
    created: 1794652020,
    enabled: true,
    contextWindow: 128000,
    free: true,
  },
  'openai/gpt-5.6-luna-pro': {
    id: 'openai/gpt-5.6-luna-pro',
    name: 'GPT-5.6 Luna Pro (LLMTR)',
    ownedBy: 'openai',
    created: 1794652020,
    enabled: true,
    contextWindow: 128000,
    free: true,
  },
  'anthropic/claude-sonnet-5.5': {
    id: 'anthropic/claude-sonnet-5.5',
    name: 'Claude Sonnet 5.5 (LLMTR)',
    ownedBy: 'anthropic',
    created: 1794652020,
    enabled: true,
    contextWindow: 200000,
    free: true,
  },
  'anthropic/claude-haiku-5.5': {
    id: 'anthropic/claude-haiku-5.5',
    name: 'Claude Haiku 5.5 (LLMTR)',
    ownedBy: 'anthropic',
    created: 1794652020,
    enabled: true,
    contextWindow: 200000,
    free: true,
  },
  'anthropic/claude-opus-5': {
    id: 'anthropic/claude-opus-5',
    name: 'Claude Opus 5 (LLMTR)',
    ownedBy: 'anthropic',
    created: 1794652020,
    enabled: true,
    contextWindow: 200000,
    free: true,
  },
  'anthropic/claude-opus-5.5': {
    id: 'anthropic/claude-opus-5.5',
    name: 'Claude Opus 5.5 (LLMTR)',
    ownedBy: 'anthropic',
    created: 1794652020,
    enabled: true,
    contextWindow: 200000,
    free: true,
  },
  'google/gemini-3.1-flash-lite': {
    id: 'google/gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash Lite (LLMTR)',
    ownedBy: 'google',
    created: 1794652020,
    enabled: true,
    contextWindow: 1048576,
    free: true,
  },
  'google/gemini-3.1-pro-preview': {
    id: 'google/gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro Preview (LLMTR)',
    ownedBy: 'google',
    created: 1794652020,
    enabled: true,
    contextWindow: 1048576,
    free: true,
  },
  'xai/grok-4.6': {
    id: 'xai/grok-4.6',
    name: 'Grok 4.6 (LLMTR)',
    ownedBy: 'xai',
    created: 1794652020,
    enabled: true,
    contextWindow: 131072,
    free: true,
  },
  'meta/llama-3.1-8b-instruct-16k': {
    id: 'meta/llama-3.1-8b-instruct-16k',
    name: 'Llama 3.1 8B Instruct 16k (LLMTR)',
    ownedBy: 'meta',
    created: 1794652020,
    enabled: true,
    contextWindow: 16384,
    free: true,
  },
  'greenpt/llama-3.3-70b-instruct-eu': {
    id: 'greenpt/llama-3.3-70b-instruct-eu',
    name: 'Llama 3.3 70B Instruct EU (LLMTR)',
    ownedBy: 'greenpt',
    created: 1794652020,
    enabled: true,
    contextWindow: 131072,
    free: true,
  },
  'openai/gpt-image-2.6-flare': {
    id: 'openai/gpt-image-2.6-flare',
    name: 'GPT Image 2.6 Flare (LLMTR)',
    ownedBy: 'openai',
    created: 1794652020,
    enabled: true,
    contextWindow: 128000,
    free: true,
  },
  'google/gemini-2.5-flash-image': {
    id: 'google/gemini-2.5-flash-image',
    name: 'Gemini 2.5 Flash Image (LLMTR)',
    ownedBy: 'google',
    created: 1794652020,
    enabled: true,
    contextWindow: 1048576,
    free: true,
  },
  'google/gemini-2.5-flash-native-audio-preview-12-2025': {
    id: 'google/gemini-2.5-flash-native-audio-preview-12-2025',
    name: 'Gemini 2.5 Flash Native Audio Preview (LLMTR)',
    ownedBy: 'google',
    created: 1794652020,
    enabled: true,
    contextWindow: 1048576,
    free: true,
  },
  'xai/grok-imagine-video-1.5-lite': {
    id: 'xai/grok-imagine-video-1.5-lite',
    name: 'Grok Imagine Video 1.5 Lite (LLMTR)',
    ownedBy: 'xai',
    created: 1794652020,
    enabled: true,
    contextWindow: 131072,
    free: true,
  },
});

const ALLOWED_LLMTR_MODEL_IDS = new Set(Object.keys(DEFAULT_LLMTR_MODELS));

function readEnvKey(env) {
  const source = env || process.env;
  const raw = source.LLMTR_API_KEY || source.FREELLMAPI_API_KEY || '';
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function maskKey(key) {
  if (!key || typeof key !== 'string') return null;
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '••••' + trimmed.slice(-2);
  const prefix = trimmed.slice(0, 5);
  const suffix = trimmed.slice(-4);
  return `${prefix}••••${suffix}`;
}

function isLlmtrChatModel(model) {
  if (!model) return false;
  const id = typeof model === 'string' ? model : model.id;
  if (!id || typeof id !== 'string') return false;
  return ALLOWED_LLMTR_MODEL_IDS.has(id) || ALLOWED_LLMTR_MODEL_IDS.has(id.toLowerCase());
}

function isModelFree(model) {
  if (!model) return true;
  if (typeof model === 'object' && model.free !== undefined) return Boolean(model.free);
  const id = typeof model === 'string' ? model : model.id;
  if (id && id.includes('free')) return true;
  if (id && DEFAULT_LLMTR_MODELS[id]) return Boolean(DEFAULT_LLMTR_MODELS[id].free);
  const pricing = model && typeof model === 'object' ? model.pricing : null;
  if (!pricing) return true;
  const prompt = Number(pricing.prompt ?? 0);
  const completion = Number(pricing.completion ?? 0);
  return prompt === 0 && completion === 0;
}

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    enabled: false,
    spendingPolicy: 'block',
    defaultModelId: 'openai/gpt-5.4-mini',
    models: { ...DEFAULT_LLMTR_MODELS },
    usage: {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastUsedAt: null,
      lastError: null,
    },
    rateLimits: {
      requestsRemaining: null,
      tokensRemaining: null,
      resetTime: null,
    },
    recentErrors: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeConfig(loaded) {
  const base = defaultConfig();
  if (!loaded || typeof loaded !== 'object') return base;

  const enabled = typeof loaded.enabled === 'boolean' ? loaded.enabled : base.enabled;
  const spendingPolicy = SPENDING_POLICIES.includes(loaded.spendingPolicy) ? loaded.spendingPolicy : base.spendingPolicy;
  const defaultModelId = typeof loaded.defaultModelId === 'string' && ALLOWED_LLMTR_MODEL_IDS.has(loaded.defaultModelId)
    ? loaded.defaultModelId : base.defaultModelId;

  const rawModels = (loaded.models && typeof loaded.models === 'object') ? loaded.models : {};
  const models = { ...DEFAULT_LLMTR_MODELS };
  for (const [key, val] of Object.entries(rawModels)) {
    if (!val || typeof val !== 'object' || !val.id) continue;
    if (!ALLOWED_LLMTR_MODEL_IDS.has(val.id)) continue;
    models[val.id] = {
      ...(DEFAULT_LLMTR_MODELS[val.id] || {}),
      id: String(val.id),
      name: String(val.name || (DEFAULT_LLMTR_MODELS[val.id] && DEFAULT_LLMTR_MODELS[val.id].name) || val.id),
      ownedBy: String(val.ownedBy || (DEFAULT_LLMTR_MODELS[val.id] && DEFAULT_LLMTR_MODELS[val.id].ownedBy) || 'llmtr'),
      created: typeof val.created === 'number' ? val.created : 0,
      enabled: val.enabled !== false,
      contextWindow: typeof val.contextWindow === 'number' ? val.contextWindow : 131072,
      free: isModelFree(val),
    };
  }

  const usage = { ...base.usage, ...(loaded.usage || {}) };
  const recentErrors = Array.isArray(loaded.recentErrors)
    ? loaded.recentErrors.slice(0, MAX_RECENT_ERRORS)
    : [];

  return {
    version: CONFIG_VERSION,
    enabled,
    spendingPolicy,
    defaultModelId,
    models,
    usage,
    rateLimits: { ...base.rateLimits, ...(loaded.rateLimits || {}) },
    recentErrors,
    updatedAt: loaded.updatedAt || base.updatedAt,
  };
}

function createLlmtrConfig({ dir = process.cwd(), env = process.env, logger = console } = {}) {
  const stateFile = path.join(dir, CONFIG_FILE);
  let config = load();

  function load() {
    try {
      if (fs.existsSync(stateFile)) {
        const text = fs.readFileSync(stateFile, 'utf8');
        return normalizeConfig(JSON.parse(text));
      }
    } catch (err) {
      logger.warn(`[llmtr-config] failed to read ${stateFile}, falling back to defaults: ${err.message}`);
    }
    return defaultConfig();
  }

  function save() {
    config.updatedAt = new Date().toISOString();
    try {
      const text = JSON.stringify(config, null, 2);
      fs.writeFileSync(stateFile, text, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      logger.error(`[llmtr-config] failed to write ${stateFile}: ${err.message}`);
    }
  }

  function isEnabled() { return config.enabled; }
  function setEnabled(flag) {
    config.enabled = Boolean(flag);
    save();
    return config.enabled;
  }

  function getSpendingPolicy() { return config.spendingPolicy; }
  function setSpendingPolicy(policy) {
    if (!SPENDING_POLICIES.includes(policy)) {
      throw new Error(`Invalid spendingPolicy: ${policy}. Must be one of: ${SPENDING_POLICIES.join(', ')}`);
    }
    config.spendingPolicy = policy;
    save();
    return config.spendingPolicy;
  }

  function getDefaultModelId() { return config.defaultModelId; }
  function setDefaultModelId(id) {
    if (typeof id !== 'string' || !MODEL_ID.test(id)) {
      throw new Error(`Invalid model ID: ${id}`);
    }
    config.defaultModelId = id;
    save();
    return config.defaultModelId;
  }

  function setModels(list) {
    if (!Array.isArray(list)) return;
    const next = { ...DEFAULT_LLMTR_MODELS };
    for (const m of list) {
      const id = m.id || m.name;
      if (!id || !ALLOWED_LLMTR_MODEL_IDS.has(id)) continue;
      const prev = config.models[id] || DEFAULT_LLMTR_MODELS[id];
      next[id] = {
        id,
        name: m.name || (prev && prev.name) || id,
        ownedBy: m.owned_by || m.ownedBy || (prev && prev.ownedBy) || 'llmtr',
        created: m.created || (prev && prev.created) || 0,
        enabled: prev ? prev.enabled !== false : true,
        contextWindow: m.context_length || m.contextWindow || (prev && prev.contextWindow) || 131072,
        free: isModelFree(m),
      };
    }
    config.models = next;
    save();
  }

  function setModelEnabled(id, enabled) {
    if (!config.models[id]) {
      throw new Error(`Model not found in config: ${id}`);
    }
    config.models[id].enabled = Boolean(enabled);
    save();
    return config.models[id].enabled;
  }

  function recordSuccess({ inputTokens = 0, outputTokens = 0 } = {}) {
    config.usage.totalRequests += 1;
    config.usage.successfulRequests += 1;
    config.usage.inputTokens += Math.max(0, Number(inputTokens) || 0);
    config.usage.outputTokens += Math.max(0, Number(outputTokens) || 0);
    config.usage.lastUsedAt = new Date().toISOString();
    save();
  }

  function recordFailure(error) {
    config.usage.totalRequests += 1;
    config.usage.failedRequests += 1;
    config.usage.lastUsedAt = new Date().toISOString();
    if (error) {
      const rec = {
        at: new Date().toISOString(),
        code: error.code || 'unknown',
        status: error.status || 500,
        message: String(error.message || '').slice(0, 200),
      };
      config.usage.lastError = rec;
      config.recentErrors = [rec, ...config.recentErrors].slice(0, MAX_RECENT_ERRORS);
    }
    save();
  }

  function snapshot() {
    return {
      provider: 'LLMTR',
      enabled: isEnabled(),
      spendingPolicy: getSpendingPolicy(),
      defaultModelId: getDefaultModelId(),
      models: { ...config.models },
      usage: { ...config.usage },
      rateLimits: { ...config.rateLimits },
      recentErrors: [...config.recentErrors],
      updatedAt: config.updatedAt,
      stateFile,
    };
  }

  return {
    stateFile,
    isEnabled,
    setEnabled,
    getSpendingPolicy,
    setSpendingPolicy,
    getDefaultModelId,
    setDefaultModelId,
    setModels,
    setModelEnabled,
    recordSuccess,
    recordFailure,
    snapshot,
    view: snapshot,
    get state() { return config; },
  };
}

module.exports = {
  createLlmtrConfig,
  readEnvKey,
  maskKey,
  isLlmtrChatModel,
  isModelFree,
  DEFAULT_LLMTR_MODELS,
  CONFIG_VERSION,
  CONFIG_FILE,
  SPENDING_POLICIES,
  MODEL_ID,
};
