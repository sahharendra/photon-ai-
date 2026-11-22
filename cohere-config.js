'use strict';
// Cohere provider configuration and non-secret state manager for PHOTON AI.
//
// * Reads COHERE_API_KEY from the backend environment (API.env / .env) or encrypted config.
// * Never stores the raw key unencrypted; only masked identifiers appear in status or logs.
// * State is persisted in .photon-cohere-config.json with mode 0600.
// * Spending policy: 'allow_free_only' allows free/trial access (10 RPM limit).
//   'block' disables all requests.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_VERSION = 1;
const CONFIG_FILE = '.photon-cohere-config.json';
const MAX_RECENT_ERRORS = 20;
const MAX_MODELS = 200;

const SPENDING_POLICIES = Object.freeze(['allow_free_only', 'block']);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,160}$/;

// Known non-chat models on Cohere
const NON_CHAT_ID = /(embed|rerank|classify|summarize|tokenize)/i;

const DEFAULT_COHERE_MODELS = Object.freeze({
  'command-r-plus-08-2024': {
    id: 'command-r-plus-08-2024',
    name: 'Command R+ (Cohere)',
    ownedBy: 'Cohere',
    enabled: true,
    contextWindow: 128000,
  },
  'command-r-08-2024': {
    id: 'command-r-08-2024',
    name: 'Command R (Cohere)',
    ownedBy: 'Cohere',
    enabled: true,
    contextWindow: 128000,
  },
  'command-light': {
    id: 'command-light',
    name: 'Command Light (Cohere)',
    ownedBy: 'Cohere',
    enabled: true,
    contextWindow: 4096,
  },
  'command-r': {
    id: 'command-r',
    name: 'Command R Default (Cohere)',
    ownedBy: 'Cohere',
    enabled: true,
    contextWindow: 128000,
  },
});

function getEncryptionKey() {
  const secret = process.env.PHOTON_SECRET || process.env.PHOTON_ADMIN_PASSWORD || 'photon-cohere-master-seed-key';
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptToken(plainText) {
  if (!plainText) return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptToken(cipherText) {
  if (!cipherText || typeof cipherText !== 'string') return null;
  const parts = cipherText.split(':');
  if (parts.length !== 3) return null;
  try {
    const [ivHex, authTagHex, encryptedHex] = parts;
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

function readEnvKey(env = process.env, config = null) {
  let key = String(env.COHERE_API_KEY || '').trim();
  if (!key && config?.encryptedKey) {
    const dec = decryptToken(config.encryptedKey);
    if (dec) {
      key = dec;
      env.COHERE_API_KEY = dec;
    }
  }
  return key || null;
}

function maskKey(secret) {
  if (!secret || secret.length < 4) return '••••';
  const prefix = secret.slice(0, 4);
  const suffix = secret.slice(-4);
  return `${prefix}${'•'.repeat(Math.min(16, Math.max(8, secret.length - 8)))}${suffix}`;
}

function fingerprint(secret) {
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

function isCohereChatModel(id) {
  const value = String(id || '').trim();
  if (!MODEL_ID.test(value) || NON_CHAT_ID.test(value)) return false;
  return true;
}

function prettyName(id) {
  const value = String(id || '').trim();
  if (value.includes('command-r-plus')) return 'Command R+ (Cohere)';
  if (value.includes('command-r')) return 'Command R (Cohere)';
  if (value.includes('command-light')) return 'Command Light (Cohere)';
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
    defaultModelId: 'command-r-plus-08-2024',
    encryptedKey: null,
    models: { ...DEFAULT_COHERE_MODELS },
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

  // Decrypt on startup if env not populated
  readEnvKey(env, config);

  function save() {
    config.updatedAt = new Date(now()).toISOString();
    try {
      atomicWriteJson(stateFile, config);
    } catch (err) {
      logger.error('Failed to persist Cohere config:', err.message);
    }
  }

  function normalizeConfig(raw) {
    const base = defaultConfig();
    if (!raw || typeof raw !== 'object') return base;

    const out = {
      version: CONFIG_VERSION,
      enabled: raw.enabled !== false,
      spendingPolicy: SPENDING_POLICIES.includes(raw.spendingPolicy) ? raw.spendingPolicy : 'allow_free_only',
      defaultModelId: raw.defaultModelId || 'command-r-plus-08-2024',
      encryptedKey: raw.encryptedKey || null,
      models: {},
      usage: {
        requests: safeInteger(raw.usage?.requests),
        failures: safeInteger(raw.usage?.failures),
        inputTokens: safeInteger(raw.usage?.inputTokens),
        outputTokens: safeInteger(raw.usage?.outputTokens),
        totalTokens: safeInteger(raw.usage?.totalTokens),
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
        ownedBy: m?.ownedBy || 'Cohere',
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

  function setStoredKey(key) {
    const clean = String(key || '').trim();
    config.encryptedKey = clean ? encryptToken(clean) : null;
    if (clean) env.COHERE_API_KEY = clean;
    else delete env.COHERE_API_KEY;
    save();
  }

  function clearStoredKey() {
    config.encryptedKey = null;
    delete env.COHERE_API_KEY;
    save();
  }

  function getStoredKey() {
    return readEnvKey(env, config);
  }

  function isEnabled() { return config.enabled; }
  function setEnabled(flag) { config.enabled = Boolean(flag); save(); }
  function getSpendingPolicy() { return config.spendingPolicy; }
  function setSpendingPolicy(policy) {
    if (!SPENDING_POLICIES.includes(policy)) throw new Error(`Invalid policy: ${policy}`);
    config.spendingPolicy = policy; save();
  }
  function getDefaultModelId() { return config.defaultModelId; }
  function setDefaultModelId(id) { config.defaultModelId = id || null; save(); }

  function syncDiscoveredModels(discoveredList) {
    if (!Array.isArray(discoveredList)) return config.models;
    const next = {};
    for (const item of discoveredList) {
      const id = String(item?.name || item?.id || '').trim();
      if (!isCohereChatModel(id)) continue;
      const prev = config.models[id] || {};
      next[id] = {
        id,
        name: prev.name || prettyName(id),
        ownedBy: item.organization_id || 'Cohere',
        enabled: prev.enabled !== undefined ? prev.enabled : true,
        contextWindow: safeInteger(item.context_length, prev.contextWindow || 128000),
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
    const u = config.usage;
    u.requests += 1;
    if (ok) {
      const inTok = safeInteger(inputTokens);
      const outTok = safeInteger(outputTokens);
      const totalTok = inTok + outTok;
      u.inputTokens += inTok;
      u.outputTokens += outTok;
      u.totalTokens += totalTok;
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
    const get = k => (typeof headers.get === 'function' ? headers.get(k) : headers[k] || headers[k.toLowerCase()]);
    const remReq = safeInteger(get('x-ratelimit-remaining-requests') || get('x-trial-endpoint-call-limit'), null);
    if (remReq !== null) {
      config.rateLimits = {
        remainingRequests: remReq,
        remainingTokens: null,
        resetRequests: safeInteger(get('x-ratelimit-reset-requests'), null),
        resetTokens: null,
        lastUpdated: new Date(now()).toISOString(),
      };
      save();
    }
  }

  function snapshot() {
    return {
      provider: 'Cohere',
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
    recordUsage,
    updateRateLimits,
    setStoredKey,
    clearStoredKey,
    getStoredKey,
    snapshot,
  };
}

module.exports = {
  createCohereConfig,
  readEnvKey,
  maskKey,
  fingerprint,
  isCohereChatModel,
  prettyName,
  DEFAULT_COHERE_MODELS,
  CONFIG_FILE,
  MODEL_ID,
};
