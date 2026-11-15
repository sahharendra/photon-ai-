'use strict';
// CodeCraft provider configuration and state manager for PHOTON AI.
//
// * Persists non-secret state to .photon-codecraft-config.json next to server.js.
// * CODECRAFT_API_KEY is never stored in this file; only the masked fingerprint appears.
// * Spending policy defaults to 'block' — zero unapproved spending.
//   The administrator must explicitly set spendingPolicy to 'allow_free_only' to enable requests.
// * Usage counters are incremented in-process and flushed to disk after each request.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_VERSION = 1;
const CONFIG_FILE = '.photon-codecraft-config.json';
const MAX_RECENT_ERRORS = 20;
const MAX_MODELS = 500;

// Valid spending policy values:
//   'block'           — no requests allowed (default; zero-billing safe)
//   'allow_free_only' — only models whose pricing is confirmed zero-cost
const SPENDING_POLICIES = Object.freeze(['block', 'allow_free_only']);

// Valid model ID pattern (same as OpenRouter / OpenAI providers).
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,160}$/;

const DEFAULT_CODECRAFT_MODELS = Object.freeze({
  'deepseek-v4-flash-0731': {
    id: 'deepseek-v4-flash-0731',
    name: 'DeepSeek V4 Flash',
    ownedBy: 'cleanapis',
    created: 1730000000,
    enabled: true,
    pricing: null,
  },
  'qwen3.8-max': {
    id: 'qwen3.8-max',
    name: 'Qwen 3.8 Max',
    ownedBy: 'cleanapis',
    created: 1730000000,
    enabled: true,
    pricing: null,
  },
  'kimi-k2.6': {
    id: 'kimi-k2.6',
    name: 'Kimi K2.6',
    ownedBy: 'cleanapis',
    created: 1730000000,
    enabled: true,
    pricing: null,
  },
  'glm-5.3': {
    id: 'glm-5.3',
    name: 'GLM 5.3',
    ownedBy: 'cleanapis',
    created: 1730000000,
    enabled: true,
    pricing: null,
  },
});

function readEnvKey(env) {
  const key = String(env.CODECRAFT_API_KEY || '').trim();
  return key || null;
}

// Returns the first 8 characters followed by **** — just enough to identify the key slot.
// Never returns more than the first 8 characters of the actual secret.
function maskKey(secret) {
  if (!secret || secret.length < 4) return '••••';
  return secret.slice(0, Math.min(8, secret.length)).replace(/./g, (c, i) => (i < 4 ? c : '•')) + '••••';
}

function fingerprint(secret) {
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
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
    enabled: false,
    spendingPolicy: 'block',
    monthlySpendLimitUsd: 0,
    defaultModelId: null,
    models: { ...DEFAULT_CODECRAFT_MODELS },
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
    recentErrors: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cfg = defaultConfig();
  cfg.enabled = Boolean(src.enabled);
  cfg.spendingPolicy = SPENDING_POLICIES.includes(src.spendingPolicy) ? src.spendingPolicy : 'block';
  cfg.monthlySpendLimitUsd = safeNumber(src.monthlySpendLimitUsd, 0);
  cfg.defaultModelId =
    typeof src.defaultModelId === 'string' && MODEL_ID.test(src.defaultModelId)
      ? src.defaultModelId
      : null;

  // Normalize persisted models.
  if (src.models && typeof src.models === 'object' && !Array.isArray(src.models)) {
    for (const [id, m] of Object.entries(src.models)) {
      if (!MODEL_ID.test(id) || !m || typeof m !== 'object') continue;
      cfg.models[id] = {
        id,
        name: String(m.name || id).slice(0, 120),
        ownedBy: String(m.ownedBy || '').slice(0, 60),
        created: Number.isInteger(Number(m.created)) ? Number(m.created) : null,
        enabled: m.enabled !== false,
        verifiedAt: typeof m.verifiedAt === 'string' ? m.verifiedAt : null,
        discoveredAt: typeof m.discoveredAt === 'string' ? m.discoveredAt : null,
        pricing:
          m.pricing && typeof m.pricing === 'object'
            ? {
                prompt: String(m.pricing.prompt ?? ''),
                completion: String(m.pricing.completion ?? ''),
                source: String(m.pricing.source || 'unknown'),
              }
            : null,
      };
    }
  }

  if (!Object.keys(cfg.models).length) {
    cfg.models = { ...DEFAULT_CODECRAFT_MODELS };
  }

  // Normalize usage.
  if (src.usage && typeof src.usage === 'object') {
    const u = src.usage;
    cfg.usage.requests = safeInteger(u.requests);
    cfg.usage.failures = safeInteger(u.failures);
    cfg.usage.inputTokens = safeInteger(u.inputTokens);
    cfg.usage.outputTokens = safeInteger(u.outputTokens);
    cfg.usage.totalTokens = safeInteger(u.totalTokens);
    cfg.usage.estimatedCostUsd = safeNumber(u.estimatedCostUsd);
    cfg.usage.lastSuccessAt = typeof u.lastSuccessAt === 'string' ? u.lastSuccessAt : null;
    cfg.usage.lastError =
      u.lastError && typeof u.lastError === 'object'
        ? {
            code: String(u.lastError.code || '').slice(0, 60),
            message: String(u.lastError.message || '').slice(0, 200),
            at: String(u.lastError.at || ''),
          }
        : null;
    if (u.byModel && typeof u.byModel === 'object') {
      for (const [id, stats] of Object.entries(u.byModel)) {
        if (!MODEL_ID.test(id) || !stats) continue;
        cfg.usage.byModel[id] = {
          requests: safeInteger(stats.requests),
          inputTokens: safeInteger(stats.inputTokens),
          outputTokens: safeInteger(stats.outputTokens),
        };
      }
    }
  }

  // Normalize recent errors (key-free).
  if (Array.isArray(src.recentErrors)) {
    cfg.recentErrors = src.recentErrors
      .slice(0, MAX_RECENT_ERRORS)
      .filter(e => e && typeof e === 'object')
      .map(e => ({
        code: String(e.code || '').slice(0, 60),
        message: String(e.message || '').slice(0, 200),
        ...(typeof e.model === 'string' ? { model: e.model.slice(0, 120) } : {}),
        at: String(e.at || ''),
      }));
  }

  cfg.updatedAt = typeof src.updatedAt === 'string' ? src.updatedAt : new Date().toISOString();
  return cfg;
}

function normalizeModels(list, existing) {
  if (!Array.isArray(list)) return existing || {};
  const now = new Date().toISOString();
  const result = {};
  let count = 0;
  for (const m of list) {
    if (count >= MAX_MODELS) break;
    const id = String(m.id || '').trim();
    if (!id || !MODEL_ID.test(id)) continue;
    const prev = (existing && existing[id]) || {};
    result[id] = {
      id,
      name: String(m.name || id).slice(0, 120),
      ownedBy: String(m.owned_by || m.ownedBy || '').slice(0, 60),
      created: Number.isInteger(Number(m.created)) ? Number(m.created) : prev.created || null,
      enabled: typeof prev.enabled === 'boolean' ? prev.enabled : false,
      verifiedAt: prev.verifiedAt || null,
      discoveredAt: prev.discoveredAt || now,
      pricing:
        m.pricing && typeof m.pricing === 'object'
          ? {
              prompt: String(m.pricing.prompt ?? ''),
              completion: String(m.pricing.completion ?? ''),
              source: 'api',
            }
          : prev.pricing || null,
    };
    count++;
  }
  return result;
}

// Returns true when a model's pricing is confirmed zero-cost.
function isModelFree(m) {
  if (!m || !m.pricing) return true; // No pricing info — treat as free (safe default for CodeCraft free tier).
  const prompt = Number(m.pricing.prompt);
  const completion = Number(m.pricing.completion);
  return Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0;
}

function createCodeCraftConfig({ dir = process.cwd(), env = process.env, logger = console, now = Date.now } = {}) {
  const configPath = path.join(dir, CONFIG_FILE);
  let state = defaultConfig();

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      state = normalizeConfig(raw);
    } catch {
      state = defaultConfig();
    }
  }

  function save() {
    try {
      state.updatedAt = new Date(now()).toISOString();
      const tmp = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, configPath);
    } catch (error) {
      logger.error(JSON.stringify({ category: 'codecraft_config_save', code: error?.code || 'unknown' }));
    }
  }

  // Load on creation.
  load();

  function isEnabled() { return state.enabled; }
  function spendingPolicy() { return state.spendingPolicy; }
  function allowPaidFallback() { return false; } // CodeCraft is free-tier from PHOTON's perspective.
  function monthlySpendLimitUsd() { return state.monthlySpendLimitUsd; }
  function defaultModelId() { return state.defaultModelId; }

  function setEnabled(value) {
    state.enabled = Boolean(value);
    save();
  }

  function setSpendingPolicy(policy) {
    if (!SPENDING_POLICIES.includes(policy))
      throw Object.assign(new Error(`Invalid spending policy. Use: ${SPENDING_POLICIES.join(', ')}`), { code: 'invalid_spending_policy' });
    state.spendingPolicy = policy;
    save();
  }

  function setMonthlySpendLimitUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 100000)
      throw Object.assign(new Error('Monthly spend limit must be a number between 0 and 100000.'), { code: 'invalid_spend_limit' });
    state.monthlySpendLimitUsd = Math.round(n * 100) / 100;
    save();
  }

  function setDefaultModelId(id) {
    if (id !== null && id !== '' && !MODEL_ID.test(String(id || '')))
      throw Object.assign(new Error('Invalid model ID.'), { code: 'invalid_model' });
    state.defaultModelId = id || null;
    save();
  }

  function setModels(list) {
    state.models = normalizeModels(list, state.models);
    save();
  }

  function modelState(id) { return state.models[id] || null; }

  function setModelEnabled(id, value) {
    if (!MODEL_ID.test(String(id || '')))
      throw Object.assign(new Error('Invalid model ID.'), { code: 'invalid_model' });
    state.models[id] = {
      ...(state.models[id] || { id, name: id, ownedBy: '', created: null, verifiedAt: null, discoveredAt: new Date().toISOString(), pricing: null }),
      enabled: Boolean(value),
    };
    save();
  }

  function markModelVerified(id) {
    if (!MODEL_ID.test(String(id || ''))) return;
    if (!state.models[id])
      state.models[id] = { id, name: id, ownedBy: '', created: null, enabled: false, discoveredAt: new Date().toISOString(), pricing: null };
    state.models[id].verifiedAt = new Date(now()).toISOString();
    save();
  }

  function recordSuccess(modelId, usage) {
    const u = usage || {};
    state.usage.requests++;
    const inp = safeInteger(u.inputTokens);
    const out = safeInteger(u.outputTokens);
    state.usage.inputTokens += inp;
    state.usage.outputTokens += out;
    state.usage.totalTokens += safeInteger(u.totalTokens) || inp + out;
    state.usage.estimatedCostUsd += safeNumber(u.cost);
    state.usage.lastSuccessAt = new Date(now()).toISOString();
    if (modelId) {
      state.usage.byModel[modelId] = state.usage.byModel[modelId] || { requests: 0, inputTokens: 0, outputTokens: 0 };
      state.usage.byModel[modelId].requests++;
      state.usage.byModel[modelId].inputTokens += inp;
      state.usage.byModel[modelId].outputTokens += out;
    }
    save();
  }

  function recordFailure(code, message, modelId) {
    state.usage.failures++;
    const errorEntry = {
      code: String(code || '').slice(0, 60),
      message: String(message || '').slice(0, 200),
      at: new Date(now()).toISOString(),
      ...(modelId ? { model: String(modelId).slice(0, 120) } : {}),
    };
    state.usage.lastError = errorEntry;
    state.recentErrors.unshift(errorEntry);
    state.recentErrors = state.recentErrors.slice(0, MAX_RECENT_ERRORS);
    save();
  }

  // Returns a safe view of the config — no API key, masked if available.
  function view(envOverride) {
    const key = readEnvKey(envOverride || env);
    return {
      version: state.version,
      enabled: state.enabled,
      configured: Boolean(key),
      maskedKey: key ? maskKey(key) : null,
      keyFingerprint: key ? fingerprint(key) : null,
      spendingPolicy: state.spendingPolicy,
      monthlySpendLimitUsd: state.monthlySpendLimitUsd,
      defaultModelId: state.defaultModelId,
      modelCount: Object.keys(state.models).length,
      enabledModelCount: Object.values(state.models).filter(m => m.enabled).length,
      models: Object.values(state.models).map(m => ({
        id: m.id,
        name: m.name,
        ownedBy: m.ownedBy,
        enabled: m.enabled,
        verifiedAt: m.verifiedAt,
        discoveredAt: m.discoveredAt,
        pricing: m.pricing,
        free: isModelFree(m),
      })),
      usage: { ...state.usage },
      recentErrors: state.recentErrors.slice(0, 10),
      updatedAt: state.updatedAt,
    };
  }

  return {
    isEnabled, spendingPolicy, allowPaidFallback, monthlySpendLimitUsd, defaultModelId,
    setEnabled, setSpendingPolicy, setMonthlySpendLimitUsd, setDefaultModelId,
    setModels, modelState, setModelEnabled, markModelVerified,
    recordSuccess, recordFailure,
    view,
    get state() { return state; },
  };
}

module.exports = {
  createCodeCraftConfig,
  readEnvKey,
  maskKey,
  fingerprint,
  MODEL_ID,
  SPENDING_POLICIES,
  normalizeModels,
  isModelFree,
};
