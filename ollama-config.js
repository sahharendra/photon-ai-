'use strict';
// Ollama Cloud & Local provider configuration and state manager for PHOTON AI.
//
// * Reads OLLAMA_API_KEY from backend environment (API.env / .env next to server.js).
// * Reads OLLAMA_BASE_URL (defaults to https://ollama.com if OLLAMA_API_KEY is present,
//   or http://127.0.0.1:11434 for local server).
// * Never stores the raw key; only masked key identifiers appear in status or logs.
// * State is persisted in .photon-ollama-config.json with mode 0600.
// * Spending policy: 'allow_free_only' allows access while strictly enforcing
//   zero unapproved billing. 'allow_all' allows all models. 'block' disables all requests.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_VERSION = 1;
const CONFIG_FILE = '.photon-ollama-config.json';
const MAX_RECENT_ERRORS = 20;
const MAX_MODELS = 200;

const SPENDING_POLICIES = Object.freeze(['allow_free_only', 'allow_all', 'block']);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,160}$/;
const NON_CHAT_ID = /(whisper|tts|embed|moderation|audio|transcribe)/i;

const DEFAULT_OLLAMA_MODELS = Object.freeze({
  'gemma4:31b': {
    id: 'gemma4:31b',
    name: 'Gemma 4 31B (Ollama)',
    ownedBy: 'ollama',
    created: 1794652000,
    enabled: true,
    contextWindow: 131072,
    free: true,
  },
  'deepseek-v4.1-flash': {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash (Ollama)',
    ownedBy: 'ollama',
    created: 1794652000,
    enabled: true,
    contextWindow: 131072,
    free: true,
  },
  'mistral-large-4': {
    id: 'mistral-large-4',
    name: 'Mistral Large 4 (Ollama)',
    ownedBy: 'ollama',
    created: 1794652000,
    enabled: true,
    contextWindow: 131072,
    free: true,
  },
  'kimi-k3': {
    id: 'kimi-k3',
    name: 'Kimi K3 (Ollama)',
    ownedBy: 'ollama',
    created: 1794652000,
    enabled: true,
    contextWindow: 131072,
    free: true,
  },
  'glm-5.3': {
    id: 'glm-5.3',
    name: 'GLM 5.3 (Ollama)',
    ownedBy: 'ollama',
    created: 1794652000,
    enabled: true,
    contextWindow: 131072,
    free: true,
  },
  'nemotron-3-super': {
    id: 'nemotron-3-super',
    name: 'Nemotron 3 Super (Ollama)',
    ownedBy: 'ollama',
    created: 1794652000,
    enabled: true,
    contextWindow: 131072,
    free: true,
  },
  'beam': {
    id: 'beam',
    name: 'Beam (Ollama)',
    ownedBy: 'ollama',
    created: 1794652000,
    enabled: true,
    contextWindow: 131072,
    free: true,
  },
  'minimax-m3.1-flash': {
    id: 'minimax-m3.1-flash',
    name: 'MiniMax M3.1 Flash (Ollama)',
    ownedBy: 'ollama',
    created: 1794652000,
    enabled: true,
    contextWindow: 131072,
    free: true,
  },
  'gpt-oss:20b': {
    id: 'gpt-oss:20b',
    name: 'GPT-OSS 20B (Ollama)',
    ownedBy: 'ollama',
    created: 1794652000,
    enabled: true,
    contextWindow: 131072,
    free: true,
  },
});

function readEnvKey(env) {
  const source = env || process.env;
  const raw = source.OLLAMA_API_KEY || source.OLLAMA_KEY || '';
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readEnvBaseUrl(env) {
  const source = env || process.env;
  const raw = source.OLLAMA_BASE_URL || source.OLLAMA_HOST || '';
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim().replace(/\/+$/, '');
  }
  // If API key is present, default to Ollama Cloud
  if (readEnvKey(source)) {
    return 'https://ollama.com';
  }
  // Otherwise default to local Ollama
  return 'http://127.0.0.1:11434';
}

function maskKey(key) {
  if (!key || typeof key !== 'string') return null;
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '••••' + trimmed.slice(-2);
  const prefix = trimmed.slice(0, 5);
  const suffix = trimmed.slice(-4);
  return `${prefix}••••${suffix}`;
}

function isOllamaChatModel(model) {
  if (!model) return false;
  const id = typeof model === 'string' ? model : model.id;
  if (!id || typeof id !== 'string') return false;
  return !NON_CHAT_ID.test(id);
}

function isModelFree(model) {
  if (!model) return true;
  if (typeof model === 'object' && model.free !== undefined) return Boolean(model.free);
  const id = typeof model === 'string' ? model : model.id;
  if (id && id.includes('free')) return true;
  if (id && DEFAULT_OLLAMA_MODELS[id]) return Boolean(DEFAULT_OLLAMA_MODELS[id].free);
  return true;
}

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    enabled: true,
    spendingPolicy: 'allow_free_only',
    defaultModelId: 'gemma4:31b',
    models: { ...DEFAULT_OLLAMA_MODELS },
    usage: {
      requests: 0,
      failures: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      lastSuccessAt: null,
      lastError: null,
      byModel: {},
    },
    recentErrors: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cfg = defaultConfig();
  cfg.enabled = src.enabled !== false;
  cfg.spendingPolicy = SPENDING_POLICIES.includes(src.spendingPolicy) ? src.spendingPolicy : 'allow_free_only';
  cfg.defaultModelId = typeof src.defaultModelId === 'string' && MODEL_ID.test(src.defaultModelId) ? src.defaultModelId : 'gemma4:31b';

  if (src.models && typeof src.models === 'object' && !Array.isArray(src.models)) {
    for (const [id, m] of Object.entries(src.models)) {
      if (!MODEL_ID.test(id) || !m || typeof m !== 'object') continue;
      cfg.models[id] = {
        id,
        name: String(m.name || id).slice(0, 80),
        ownedBy: String(m.ownedBy || 'ollama').slice(0, 40),
        created: Number(m.created) || null,
        enabled: m.enabled !== false,
        contextWindow: Number(m.contextWindow) || 131072,
        free: m.free !== undefined ? Boolean(m.free) : true,
      };
    }
  }

  if (src.usage && typeof src.usage === 'object') {
    cfg.usage.requests = Number(src.usage.requests) || 0;
    cfg.usage.failures = Number(src.usage.failures) || 0;
    cfg.usage.inputTokens = Number(src.usage.inputTokens) || 0;
    cfg.usage.outputTokens = Number(src.usage.outputTokens) || 0;
    cfg.usage.totalTokens = Number(src.usage.totalTokens) || 0;
    cfg.usage.lastSuccessAt = src.usage.lastSuccessAt || null;
    cfg.usage.lastError = src.usage.lastError || null;
    if (src.usage.byModel && typeof src.usage.byModel === 'object') {
      cfg.usage.byModel = { ...src.usage.byModel };
    }
  }

  if (Array.isArray(src.recentErrors)) {
    cfg.recentErrors = src.recentErrors.slice(0, MAX_RECENT_ERRORS).map(e => ({
      at: String(e.at || new Date().toISOString()),
      code: String(e.code || 'unknown').slice(0, 60),
      message: String(e.message || '').slice(0, 300),
    }));
  }

  return cfg;
}

function createOllamaConfig({ dir = process.cwd(), env = process.env, logger = console } = {}) {
  const filePath = path.join(dir, CONFIG_FILE);
  let state = load();

  function load() {
    try {
      if (!fs.existsSync(filePath)) return defaultConfig();
      const content = fs.readFileSync(filePath, 'utf8');
      return normalizeConfig(JSON.parse(content));
    } catch (err) {
      logger.error('Failed to load Ollama config, using defaults:', err.message);
      return defaultConfig();
    }
  }

  function save() {
    state.updatedAt = new Date().toISOString();
    try {
      const serialized = JSON.stringify(state, null, 2);
      fs.writeFileSync(filePath, serialized, { mode: 0o600 });
    } catch (err) {
      logger.error('Failed to save Ollama config:', err.message);
    }
  }

  function view() {
    const rawKey = readEnvKey(env);
    const baseUrl = readEnvBaseUrl(env);
    return {
      version: state.version,
      configured: Boolean(rawKey || (env.OLLAMA_ENABLED !== '0' && baseUrl)),
      hasKey: Boolean(rawKey),
      maskedKey: maskKey(rawKey),
      endpoint: baseUrl,
      isCloud: Boolean(rawKey || baseUrl.includes('ollama.com')),
      enabled: state.enabled,
      spendingPolicy: state.spendingPolicy,
      defaultModelId: state.defaultModelId,
      modelCount: Object.keys(state.models).length,
      models: { ...state.models },
      usage: { ...state.usage, byModel: { ...state.usage.byModel } },
      recentErrors: [...state.recentErrors],
      updatedAt: state.updatedAt,
    };
  }

  return {
    view,
    snapshot: view,
    isEnabled() { return state.enabled && (env.OLLAMA_ENABLED !== '0'); },
    setEnabled(value) {
      state.enabled = Boolean(value);
      save();
      return view();
    },
    getSpendingPolicy() { return state.spendingPolicy; },
    setSpendingPolicy(policy) {
      if (!SPENDING_POLICIES.includes(policy)) throw new Error('Invalid spending policy: ' + policy);
      state.spendingPolicy = policy;
      save();
      return view();
    },
    getDefaultModelId() { return state.defaultModelId; },
    setDefaultModelId(id) {
      if (id && !MODEL_ID.test(id)) throw new Error('Invalid model ID');
      state.defaultModelId = id;
      save();
      return view();
    },
    getModels() { return { ...state.models }; },
    isModelEnabled(id) {
      const model = state.models[id];
      return Boolean(model && model.enabled);
    },
    setModelEnabled(id, enabled) {
      if (!MODEL_ID.test(id)) throw new Error('Invalid model ID: ' + id);
      if (!state.models[id]) {
        state.models[id] = {
          id,
          name: id,
          ownedBy: 'ollama',
          created: Math.floor(Date.now() / 1000),
          enabled: Boolean(enabled),
          contextWindow: 131072,
          free: true,
        };
      } else {
        state.models[id].enabled = Boolean(enabled);
      }
      save();
      return view();
    },
    recordDiscoveredModels(models) {
      if (!Array.isArray(models)) return;
      let changed = false;
      for (const m of models) {
        const id = m.id || m.name;
        if (!id || !MODEL_ID.test(id) || !isOllamaChatModel(id)) continue;
        const existing = state.models[id];
        const updated = {
          id,
          name: m.name || (existing && existing.name) || id,
          ownedBy: m.ownedBy || (existing && existing.ownedBy) || 'ollama',
          created: m.created || (existing && existing.created) || Math.floor(Date.now() / 1000),
          enabled: existing ? existing.enabled : true,
          contextWindow: m.contextWindow || (existing && existing.contextWindow) || 131072,
          free: isModelFree(m),
        };
        if (!existing || JSON.stringify(existing) !== JSON.stringify(updated)) {
          state.models[id] = updated;
          changed = true;
        }
      }
      if (changed) save();
    },
    recordSuccess({ modelId, inputTokens = 0, outputTokens = 0 } = {}) {
      state.usage.requests += 1;
      state.usage.inputTokens += inputTokens;
      state.usage.outputTokens += outputTokens;
      state.usage.totalTokens += (inputTokens + outputTokens);
      state.usage.lastSuccessAt = new Date().toISOString();
      if (modelId) {
        if (!state.usage.byModel[modelId]) state.usage.byModel[modelId] = { requests: 0, inputTokens: 0, outputTokens: 0 };
        state.usage.byModel[modelId].requests += 1;
        state.usage.byModel[modelId].inputTokens += inputTokens;
        state.usage.byModel[modelId].outputTokens += outputTokens;
      }
      save();
    },
    recordError({ code = 'unknown', message = '' } = {}) {
      state.usage.failures += 1;
      state.usage.lastError = { code, at: new Date().toISOString() };
      state.recentErrors.unshift({
        at: new Date().toISOString(),
        code: String(code).slice(0, 60),
        message: String(message).slice(0, 300),
      });
      if (state.recentErrors.length > MAX_RECENT_ERRORS) state.recentErrors.length = MAX_RECENT_ERRORS;
      save();
    },
    getUsage() { return { ...state.usage, byModel: { ...state.usage.byModel } }; },
    getRecentErrors() { return [...state.recentErrors]; },
    reset() {
      state = defaultConfig();
      save();
      return view();
    },
  };
}

module.exports = {
  createOllamaConfig,
  readEnvKey,
  readEnvBaseUrl,
  maskKey,
  isOllamaChatModel,
  isModelFree,
  DEFAULT_OLLAMA_MODELS,
  CONFIG_FILE,
  MODEL_ID,
};
