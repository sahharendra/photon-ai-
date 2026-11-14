'use strict';
// GroqCloud provider configuration and non-secret state manager for PHOTON AI.
//
// * Reads GROQ_API_KEY only from the backend environment (API.env / .env next to server.js).
// * Never stores the raw key; only masked key identifiers appear in status or logs.
// * State is persisted in .photon-groq-config.json with mode 0600.
// * Spending policy: 'allow_free_only' allows access to Groq free-tier models while
//   strictly enforcing zero unapproved billing. 'block' disables all requests.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_VERSION = 1;
const CONFIG_FILE = '.photon-groq-config.json';
const MAX_RECENT_ERRORS = 20;
const MAX_MODELS = 200;

const SPENDING_POLICIES = Object.freeze(['allow_free_only', 'block']);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,160}$/;

// Known chat/completion models on Groq
const NON_CHAT_ID = /(whisper|tts|embed|moderation|audio|transcribe)/i;

function readEnvKey(env) {
  const key = String(env.GROQ_API_KEY || '').trim();
  return key || null;
}

function maskKey(secret) {
  if (!secret || secret.length < 4) return '••••';
  if (secret.startsWith('gsk_')) {
    const visible = secret.slice(0, 7);
    const masked = '•'.repeat(Math.min(16, Math.max(8, secret.length - 11)));
    const ending = secret.slice(-4);
    return `${visible}${masked}${ending}`;
  }
  return secret.slice(0, Math.min(8, secret.length)).replace(/./g, (c, i) => (i < 4 ? c : '•')) + '••••';
}

function fingerprint(secret) {
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

function isGroqChatModel(id) {
  const value = String(id || '').trim();
  if (!MODEL_ID.test(value) || NON_CHAT_ID.test(value)) return false;
  return true;
}

function prettyName(id) {
  const value = String(id || '').trim();
  if (value.startsWith('llama-3.3-70b')) return 'Llama 3.3 70B (Groq)';
  if (value.startsWith('llama-3.1-8b')) return 'Llama 3.1 8B (Groq)';
  if (value.startsWith('llama-3.2-11b')) return 'Llama 3.2 11B Vision (Groq)';
  if (value.startsWith('llama-3.2-90b')) return 'Llama 3.2 90B Vision (Groq)';
  if (value.startsWith('mixtral-8x7b')) return 'Mixtral 8x7B (Groq)';
  if (value.startsWith('gemma2-9b')) return 'Gemma 2 9B (Groq)';
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 80) + ' (Groq)';
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function safeInteger(value, fallback = 0) {
  const n = Math.round(Number(value));
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    enabled: true,
    spendingPolicy: 'allow_free_only',
    monthlySpendLimitUsd: 0,
    defaultModelId: null,
    models: {},
    usage: {
      requests: 0,
      failures: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      lastSuccessAt: null,
      lastError: null,
      byModel: {},
    },
    rateLimits: {
      remainingRequests: null,
      remainingTokens: null,
      resetRequests: null,
      resetTokens: null,
      lastUpdated: null,
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
  cfg.monthlySpendLimitUsd = safeNumber(src.monthlySpendLimitUsd, 0);
  cfg.defaultModelId = typeof src.defaultModelId === 'string' && MODEL_ID.test(src.defaultModelId) ? src.defaultModelId : null;

  if (src.models && typeof src.models === 'object' && !Array.isArray(src.models)) {
    for (const [id, m] of Object.entries(src.models)) {
      if (!MODEL_ID.test(id) || !m || typeof m !== 'object') continue;
      cfg.models[id] = {
        id,
        name: String(m.name || prettyName(id)).slice(0, 120),
        ownedBy: String(m.ownedBy || 'Groq').slice(0, 60),
        created: Number.isInteger(Number(m.created)) ? Number(m.created) : null,
        enabled: m.enabled !== false,
        verifiedAt: typeof m.verifiedAt === 'string' ? m.verifiedAt : null,
        discoveredAt: typeof m.discoveredAt === 'string' ? m.discoveredAt : null,
        contextWindow: Number.isInteger(Number(m.contextWindow)) ? Number(m.contextWindow) : 131072,
      };
    }
  }

  const u = src.usage && typeof src.usage === 'object' ? src.usage : {};
  cfg.usage = {
    requests: safeInteger(u.requests),
    failures: safeInteger(u.failures),
    inputTokens: safeInteger(u.inputTokens),
    outputTokens: safeInteger(u.outputTokens),
    totalTokens: safeInteger(u.totalTokens),
    estimatedCostUsd: 0, // Groq free tier models have 0 USD cost
    lastSuccessAt: typeof u.lastSuccessAt === 'string' ? u.lastSuccessAt : null,
    lastError: u.lastError && typeof u.lastError === 'object' ? u.lastError : null,
    byModel: {},
  };

  if (u.byModel && typeof u.byModel === 'object') {
    for (const [id, bm] of Object.entries(u.byModel)) {
      if (!MODEL_ID.test(id) || !bm || typeof bm !== 'object') continue;
      cfg.usage.byModel[id] = {
        requests: safeInteger(bm.requests),
        failures: safeInteger(bm.failures),
        inputTokens: safeInteger(bm.inputTokens),
        outputTokens: safeInteger(bm.outputTokens),
        totalTokens: safeInteger(bm.totalTokens),
      };
    }
  }

  if (src.rateLimits && typeof src.rateLimits === 'object') {
    cfg.rateLimits = {
      remainingRequests: src.rateLimits.remainingRequests != null ? Number(src.rateLimits.remainingRequests) : null,
      remainingTokens: src.rateLimits.remainingTokens != null ? Number(src.rateLimits.remainingTokens) : null,
      resetRequests: typeof src.rateLimits.resetRequests === 'string' ? src.rateLimits.resetRequests : null,
      resetTokens: typeof src.rateLimits.resetTokens === 'string' ? src.rateLimits.resetTokens : null,
      lastUpdated: typeof src.rateLimits.lastUpdated === 'string' ? src.rateLimits.lastUpdated : null,
    };
  }

  if (Array.isArray(src.recentErrors)) {
    cfg.recentErrors = src.recentErrors.slice(0, MAX_RECENT_ERRORS).filter(e => e && typeof e === 'object');
  }

  return cfg;
}

function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      fs.renameSync(tmp, filePath);
    } catch {
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tmp, filePath);
    }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

function createGroqConfig({ dir = process.cwd(), env = process.env, logger = console, now = Date.now } = {}) {
  const stateFile = path.join(dir, CONFIG_FILE);
  let config;

  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    config = normalizeConfig(raw);
  } catch {
    config = normalizeConfig(null);
  }

  function save() {
    config.updatedAt = new Date(now()).toISOString();
    try {
      atomicWriteJson(stateFile, config);
    } catch (err) {
      logger.error(JSON.stringify({ category: 'groq_config_save', error: err?.message || 'write_failed' }));
    }
  }

  function isEnabled() {
    return config.enabled !== false;
  }

  function setEnabled(val) {
    config.enabled = Boolean(val);
    save();
    return config.enabled;
  }

  function getSpendingPolicy() {
    return config.spendingPolicy || 'allow_free_only';
  }

  function setSpendingPolicy(policy) {
    if (!SPENDING_POLICIES.includes(policy)) {
      const err = new Error(`Invalid spending policy: ${policy}. Must be one of: ${SPENDING_POLICIES.join(', ')}`);
      err.code = 'invalid_spending_policy';
      throw err;
    }
    config.spendingPolicy = policy;
    save();
    return config.spendingPolicy;
  }

  function getDefaultModelId() {
    return config.defaultModelId;
  }

  function setDefaultModelId(id) {
    if (id !== null && !MODEL_ID.test(String(id || ''))) {
      const err = new Error('Invalid model ID');
      err.code = 'invalid_model_id';
      throw err;
    }
    config.defaultModelId = id || null;
    save();
    return config.defaultModelId;
  }

  function syncDiscoveredModels(discoveredList) {
    const next = {};
    for (const m of Array.isArray(discoveredList) ? discoveredList : []) {
      const id = String(m?.id || '').trim();
      if (!isGroqChatModel(id)) continue;
      const prior = config.models[id] || {};
      next[id] = {
        id,
        name: String(m.name || prior.name || prettyName(id)).slice(0, 120),
        ownedBy: String(m.owned_by || m.ownedBy || prior.ownedBy || 'Groq').slice(0, 60),
        created: Number(m.created) || prior.created || null,
        enabled: prior.enabled !== false, // active by default once discovered
        verifiedAt: prior.verifiedAt || null,
        discoveredAt: prior.discoveredAt || new Date(now()).toISOString(),
        contextWindow: Number(m.context_window) || prior.contextWindow || 131072,
      };
    }
    config.models = next;
    save();
    return config.models;
  }

  function setModelEnabled(id, enabled) {
    const key = String(id || '').trim();
    if (!config.models[key]) {
      const err = new Error(`Model ${key} not found in Groq catalog.`);
      err.code = 'model_not_found';
      throw err;
    }
    config.models[key].enabled = Boolean(enabled);
    save();
    return config.models[key];
  }

  function markModelVerified(id) {
    const key = String(id || '').trim();
    if (config.models[key]) {
      config.models[key].verifiedAt = new Date(now()).toISOString();
      save();
    }
  }

  function updateRateLimits(headers = {}) {
    let changed = false;
    const reqRemaining = headers['x-ratelimit-remaining-requests'];
    const tokRemaining = headers['x-ratelimit-remaining-tokens'];
    const reqReset = headers['x-ratelimit-reset-requests'];
    const tokReset = headers['x-ratelimit-reset-tokens'];

    if (reqRemaining != null) {
      config.rateLimits.remainingRequests = Number(reqRemaining);
      changed = true;
    }
    if (tokRemaining != null) {
      config.rateLimits.remainingTokens = Number(tokRemaining);
      changed = true;
    }
    if (reqReset) {
      config.rateLimits.resetRequests = String(reqReset);
      changed = true;
    }
    if (tokReset) {
      config.rateLimits.resetTokens = String(tokReset);
      changed = true;
    }

    if (changed) {
      config.rateLimits.lastUpdated = new Date(now()).toISOString();
      save();
    }
  }

  function recordUsage({ model, ok, inputTokens = 0, outputTokens = 0, error = null }) {
    config.usage.requests += 1;
    const inTok = safeInteger(inputTokens);
    const outTok = safeInteger(outputTokens);
    const total = inTok + outTok;

    config.usage.inputTokens += inTok;
    config.usage.outputTokens += outTok;
    config.usage.totalTokens += total;

    if (model && MODEL_ID.test(model)) {
      if (!config.usage.byModel[model]) {
        config.usage.byModel[model] = { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      }
      const bm = config.usage.byModel[model];
      bm.requests += 1;
      bm.inputTokens += inTok;
      bm.outputTokens += outTok;
      bm.totalTokens += total;
      if (!ok) bm.failures += 1;
    }

    if (ok) {
      config.usage.lastSuccessAt = new Date(now()).toISOString();
    } else {
      config.usage.failures += 1;
      const rec = {
        at: new Date(now()).toISOString(),
        model: model || null,
        code: error?.code || 'provider_error',
        message: String(error?.message || '').slice(0, 200),
      };
      config.usage.lastError = rec;
      config.recentErrors = [rec, ...config.recentErrors].slice(0, MAX_RECENT_ERRORS);
    }
    save();
  }

  function snapshot() {
    return {
      provider: 'Groq',
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
    syncDiscoveredModels,
    setModelEnabled,
    markModelVerified,
    updateRateLimits,
    recordUsage,
    snapshot,
  };
}

module.exports = {
  createGroqConfig,
  readEnvKey,
  maskKey,
  fingerprint,
  isGroqChatModel,
  prettyName,
  MODEL_ID,
  CONFIG_FILE,
  SPENDING_POLICIES,
};
