'use strict';
// Cohere provider configuration and non-secret state manager for PHOTON AI.
//
// * Reads COHERE_API_KEY from backend environment (API.env / .env next to server.js).
// * Never stores the raw key; only masked key identifiers appear in status, APIs, or logs.
// * State is persisted in .photon-cohere-config.json with mode 0600.
// * Strict Free Trial Protection:
//   - Cohere Trial keys are for development and testing only; blocked from public commercial traffic.
//   - Key type: 'trial' (default) or 'production'.
//   - Displays "Trial – Development Only".
//   - Monthly request tracking with automatic monthly rollover.
//   - Zero paid fallback; no automatic upgrades or billing.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_VERSION = 1;
const CONFIG_FILE = '.photon-cohere-config.json';
const MAX_RECENT_ERRORS = 20;
const MAX_MODELS = 200;

// Monthly trial limit (Cohere trial allows ~1,000 calls/month without charge)
const DEFAULT_MONTHLY_TRIAL_LIMIT = 1000;
const SPENDING_POLICIES = Object.freeze(['allow_free_only', 'block']);
const KEY_TYPES = Object.freeze(['trial', 'production']);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,160}$/;

// Non-chat models to exclude from chat completion routing
const NON_CHAT_ID = /(embed|rerank|classify|multilingual-22-12|embed-|rerank-)/i;

// Curated default Cohere chat models
const DEFAULT_COHERE_MODELS = Object.freeze({
  'command-r-08-2024': {
    id: 'command-r-08-2024',
    name: 'Command R (08-2024) (Cohere)',
    enabled: true,
    contextWindow: 128000,
  },
  'command-r-plus-08-2024': {
    id: 'command-r-plus-08-2024',
    name: 'Command R+ (08-2024) (Cohere)',
    enabled: true,
    contextWindow: 128000,
  },
  'command-r7b-12-2024': {
    id: 'command-r7b-12-2024',
    name: 'Command R7B (12-2024) (Cohere)',
    enabled: true,
    contextWindow: 128000,
  },
  'c4ai-aya-expanse-32b': {
    id: 'c4ai-aya-expanse-32b',
    name: 'Aya Expanse 32B (Cohere)',
    enabled: true,
    contextWindow: 128000,
  },
  'c4ai-aya-expanse-8b': {
    id: 'c4ai-aya-expanse-8b',
    name: 'Aya Expanse 8B (Cohere)',
    enabled: true,
    contextWindow: 128000,
  },
});

function readEnvKey(env) {
  const key = String(env.COHERE_API_KEY || '').trim();
  return key || null;
}

function maskKey(secret) {
  if (!secret || secret.length < 4) return '••••';
  const prefix = secret.slice(0, Math.min(6, secret.length));
  const suffix = secret.slice(-4);
  const maskedLength = Math.min(16, Math.max(6, secret.length - 10));
  return `${prefix}${'•'.repeat(maskedLength)}${suffix}`;
}

function isCohereChatModel(id) {
  const value = String(id || '').trim();
  if (!MODEL_ID.test(value) || NON_CHAT_ID.test(value)) return false;
  return true;
}

function getUtcMonthKey(timestamp) {
  const d = new Date(timestamp);
  return d.toISOString().slice(0, 7); // YYYY-MM
}

function prettyName(id) {
  const value = String(id || '').trim();
  if (/command-r-plus/i.test(value)) return 'Command R+ (Cohere)';
  if (/command-r7b/i.test(value)) return 'Command R7B (Cohere)';
  if (/command-r/i.test(value)) return 'Command R (Cohere)';
  if (/aya.*32b/i.test(value)) return 'Aya Expanse 32B (Cohere)';
  if (/aya.*8b/i.test(value)) return 'Aya Expanse 8B (Cohere)';
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 80) + ' (Cohere)';
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
    keyType: 'trial', // 'trial' or 'production'
    productionAuthorized: false, // Explicit admin confirmation required for paid commercial keys
    monthlyTrialLimit: DEFAULT_MONTHLY_TRIAL_LIMIT,
    defaultModelId: 'command-r-08-2024',
    models: { ...DEFAULT_COHERE_MODELS },
    usage: {
      requests: 0,
      failures: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      trialRequestsThisMonth: 0,
      utcMonthKey: getUtcMonthKey(Date.now()),
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

function atomicWriteJson(targetPath, data) {
  const tmp = `${targetPath}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const serialized = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, serialized, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, targetPath);
}

function createCohereConfig({ dir = process.cwd(), env = process.env, logger = console, now = Date.now } = {}) {
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
      logger.error('Failed to persist Cohere config:', err.message);
    }
  }

  function checkUtcMonthRollover() {
    const currentMonth = getUtcMonthKey(now());
    if (config.usage.utcMonthKey !== currentMonth) {
      config.usage.utcMonthKey = currentMonth;
      config.usage.trialRequestsThisMonth = 0;
      save();
    }
  }

  function normalizeConfig(raw) {
    const base = defaultConfig();
    if (!raw || typeof raw !== 'object') return base;

    const out = {
      version: CONFIG_VERSION,
      enabled: raw.enabled !== false,
      spendingPolicy: SPENDING_POLICIES.includes(raw.spendingPolicy) ? raw.spendingPolicy : 'allow_free_only',
      keyType: KEY_TYPES.includes(raw.keyType) ? raw.keyType : 'trial',
      productionAuthorized: Boolean(raw.productionAuthorized),
      monthlyTrialLimit: safeInteger(raw.monthlyTrialLimit, DEFAULT_MONTHLY_TRIAL_LIMIT),
      defaultModelId: raw.defaultModelId || 'command-r-08-2024',
      models: {},
      usage: {
        requests: safeInteger(raw.usage?.requests),
        failures: safeInteger(raw.usage?.failures),
        inputTokens: safeInteger(raw.usage?.inputTokens),
        outputTokens: safeInteger(raw.usage?.outputTokens),
        totalTokens: safeInteger(raw.usage?.totalTokens),
        trialRequestsThisMonth: safeInteger(raw.usage?.trialRequestsThisMonth),
        utcMonthKey: raw.usage?.utcMonthKey || getUtcMonthKey(now()),
        lastSuccessAt: raw.usage?.lastSuccessAt || null,
        lastError: raw.usage?.lastError || null,
        byModel: {},
      },
      rateLimits: {
        remainingRequests: raw.rateLimits?.remainingRequests ?? null,
        remainingTokens: raw.rateLimits?.remainingTokens ?? null,
        resetRequests: raw.rateLimits?.resetRequests ?? null,
        resetTokens: raw.rateLimits?.resetTokens ?? null,
        lastUpdated: raw.rateLimits?.lastUpdated || null,
      },
      recentErrors: Array.isArray(raw.recentErrors) ? raw.recentErrors.slice(0, MAX_RECENT_ERRORS) : [],
      updatedAt: raw.updatedAt || new Date(now()).toISOString(),
    };

    const rawModels = raw.models && typeof raw.models === 'object' ? raw.models : DEFAULT_COHERE_MODELS;
    for (const [id, m] of Object.entries(rawModels)) {
      if (typeof id !== 'string' || !isCohereChatModel(id)) continue;
      out.models[id] = {
        id,
        name: m?.name || prettyName(id),
        enabled: m?.enabled !== false,
        contextWindow: safeInteger(m?.contextWindow, 128000),
        verifiedAt: m?.verifiedAt || null,
      };
    }

    if (!Object.keys(out.models).length) {
      out.models = { ...DEFAULT_COHERE_MODELS };
    }

    return out;
  }

  function isEnabled() {
    return config.enabled;
  }

  function setEnabled(flag) {
    config.enabled = Boolean(flag);
    save();
  }

  function getKeyType() {
    return config.keyType;
  }

  function setKeyType(type) {
    if (!KEY_TYPES.includes(type)) throw new Error('Invalid key type: ' + type);
    config.keyType = type;
    save();
  }

  function isProductionAuthorized() {
    return config.keyType === 'production' && config.productionAuthorized === true;
  }

  function setProductionAuthorized(flag) {
    config.productionAuthorized = Boolean(flag);
    save();
  }

  function getSpendingPolicy() {
    return config.spendingPolicy;
  }

  function setSpendingPolicy(policy) {
    if (!SPENDING_POLICIES.includes(policy)) {
      throw new Error(`Invalid spending policy: ${policy}. Must be one of: ${SPENDING_POLICIES.join(', ')}`);
    }
    config.spendingPolicy = policy;
    save();
  }

  function getMonthlyTrialLimit() {
    return config.monthlyTrialLimit;
  }

  function setMonthlyTrialLimit(limit) {
    config.monthlyTrialLimit = Math.max(1, safeInteger(limit, DEFAULT_MONTHLY_TRIAL_LIMIT));
    save();
  }

  function getRemainingTrialRequests() {
    checkUtcMonthRollover();
    return Math.max(0, config.monthlyTrialLimit - config.usage.trialRequestsThisMonth);
  }

  function isMonthlyTrialExhausted() {
    if (config.keyType === 'production') return false;
    checkUtcMonthRollover();
    return config.usage.trialRequestsThisMonth >= config.monthlyTrialLimit;
  }

  function getDefaultModelId() {
    return config.defaultModelId;
  }

  function setDefaultModelId(id) {
    if (id && !MODEL_ID.test(id)) throw new Error('Invalid model ID format.');
    config.defaultModelId = id || null;
    save();
  }

  function syncDiscoveredModels(discoveredList) {
    if (!Array.isArray(discoveredList)) return config.models;
    const next = {};

    for (const item of discoveredList) {
      const id = String(item?.name || item?.id || '').trim();
      if (!isCohereChatModel(id)) continue;
      // Only include models that support chat endpoints if endpoints are provided
      if (Array.isArray(item.endpoints) && !item.endpoints.includes('chat')) continue;
      const prev = config.models[id] || {};
      next[id] = {
        id,
        name: prev.name || prettyName(id),
        enabled: prev.enabled !== undefined ? prev.enabled : true,
        contextWindow: safeInteger(item.context_length || item.contextLength, prev.contextWindow || 128000),
        verifiedAt: prev.verifiedAt || null,
      };
      if (Object.keys(next).length >= MAX_MODELS) break;
    }

    if (Object.keys(next).length > 0) {
      config.models = next;
      if (config.defaultModelId && !next[config.defaultModelId]) {
        config.defaultModelId = Object.keys(next)[0] || null;
      }
      save();
    }
    return config.models;
  }

  function setModelEnabled(id, enabled) {
    if (!config.models[id]) throw new Error(`Model not found: ${id}`);
    config.models[id].enabled = Boolean(enabled);
    save();
  }

  function markModelVerified(id) {
    if (config.models[id]) {
      config.models[id].verifiedAt = new Date(now()).toISOString();
      save();
    }
  }

  function recordUsage({ model, ok, inputTokens = 0, outputTokens = 0, error = null }) {
    checkUtcMonthRollover();
    const u = config.usage;
    u.requests += 1;

    if (ok) {
      const inTok = safeInteger(inputTokens);
      const outTok = safeInteger(outputTokens);
      const totalTok = inTok + outTok;

      u.inputTokens += inTok;
      u.outputTokens += outTok;
      u.totalTokens += totalTok;
      if (config.keyType === 'trial') {
        u.trialRequestsThisMonth += 1;
      }
      u.lastSuccessAt = new Date(now()).toISOString();

      if (model) {
        if (!u.byModel[model]) u.byModel[model] = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        const bm = u.byModel[model];
        bm.requests += 1;
        bm.inputTokens += inTok;
        bm.outputTokens += outTok;
        bm.totalTokens += totalTok;
      }
    } else {
      u.failures += 1;
      const errObj = {
        at: new Date(now()).toISOString(),
        code: error?.code || 'error',
        message: String(error?.message || 'Unknown Cohere error').slice(0, 300),
        model: model || null,
      };
      u.lastError = errObj;
      config.recentErrors.unshift(errObj);
      if (config.recentErrors.length > MAX_RECENT_ERRORS) {
        config.recentErrors.length = MAX_RECENT_ERRORS;
      }
    }
    save();
  }

  function updateRateLimits(headers) {
    if (!headers || typeof headers !== 'object') return;
    const get = k => (typeof headers.get === 'function' ? headers.get(k) : headers[k] || headers[k?.toLowerCase()]);
    const remReq = safeInteger(get('x-ratelimit-remaining-requests'), null);
    const remTok = safeInteger(get('x-ratelimit-remaining-tokens'), null);
    const resetReq = safeInteger(get('x-ratelimit-reset-requests'), null);
    const resetTok = safeInteger(get('x-ratelimit-reset-tokens'), null);

    if (remReq !== null || remTok !== null) {
      config.rateLimits = {
        remainingRequests: remReq,
        remainingTokens: remTok,
        resetRequests: resetReq,
        resetTokens: resetTok,
        lastUpdated: new Date(now()).toISOString(),
      };
      save();
    }
  }

  function snapshot() {
    checkUtcMonthRollover();
    return {
      provider: 'Cohere',
      enabled: isEnabled(),
      spendingPolicy: getSpendingPolicy(),
      keyType: getKeyType(),
      productionAuthorized: isProductionAuthorized(),
      monthlyTrialLimit: getMonthlyTrialLimit(),
      remainingTrialRequests: getRemainingTrialRequests(),
      isMonthlyTrialExhausted: isMonthlyTrialExhausted(),
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
    getKeyType,
    setKeyType,
    isProductionAuthorized,
    setProductionAuthorized,
    getSpendingPolicy,
    setSpendingPolicy,
    getMonthlyTrialLimit,
    setMonthlyTrialLimit,
    getRemainingTrialRequests,
    isMonthlyTrialExhausted,
    getDefaultModelId,
    setDefaultModelId,
    syncDiscoveredModels,
    setModelEnabled,
    markModelVerified,
    recordUsage,
    updateRateLimits,
    snapshot,
  };
}

module.exports = {
  createCohereConfig,
  readEnvKey,
  maskKey,
  isCohereChatModel,
  prettyName,
  getUtcMonthKey,
  DEFAULT_MONTHLY_TRIAL_LIMIT,
  CONFIG_FILE,
  MODEL_ID,
};
