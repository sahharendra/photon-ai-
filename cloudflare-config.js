'use strict';
// Cloudflare Workers AI provider configuration and non-secret state manager for PHOTON AI.
//
// * Reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN from backend environment (API.env / .env).
// * Never stores raw tokens; only masked credentials appear in status, APIs, or logs.
// * State is persisted in .photon-cloudflare-config.json with mode 0600.
// * Strict free-tier protection: tracks daily Neuron allowance (10,000 Neurons/day limit on Free tier)
//   with automatic 00:00 UTC daily reset and zero paid fallback.
// * Spending policy: 'allow_free_only' (enforces free tier only) or 'block' (blocks all requests).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_VERSION = 1;
const CONFIG_FILE = '.photon-cloudflare-config.json';
const MAX_RECENT_ERRORS = 20;
const MAX_MODELS = 200;

// Workers AI Free tier documented daily quota: 10,000 Neurons per day
const DEFAULT_DAILY_NEURONS_LIMIT = 10000;
// Conservative estimate: ~1 Neuron per ~100 tokens (or ~10 Neurons per chat request minimum)
const MIN_NEURONS_PER_REQUEST = 10;
const NEURONS_PER_100_TOKENS = 1;

const SPENDING_POLICIES = Object.freeze(['allow_free_only', 'block']);
const MODEL_ID = /^(@[A-Za-z0-9_-]+\/)?[A-Za-z0-9][A-Za-z0-9._:/-]{0,160}$/;

// Non-chat models to exclude from chat completion routing
const NON_CHAT_ID = /(embed|rerank|clip|whisper|tts|audio|transcription|sdxl|stable-diffusion|flux|bge-|resnet)/i;

// Curated default free-tier eligible Workers AI chat models
const DEFAULT_CLOUDFLARE_MODELS = Object.freeze({
  '@cf/meta/llama-3.1-8b-instruct': {
    id: '@cf/meta/llama-3.1-8b-instruct',
    name: 'Llama 3.1 8B Instruct (Cloudflare Workers AI)',
    task: 'text-generation',
    enabled: true,
    freeTierEligible: true,
    contextWindow: 131072,
  },
  '@cf/meta/llama-3-8b-instruct': {
    id: '@cf/meta/llama-3-8b-instruct',
    name: 'Llama 3 8B Instruct (Cloudflare Workers AI)',
    task: 'text-generation',
    enabled: true,
    freeTierEligible: true,
    contextWindow: 8192,
  },
  '@cf/qwen/qwen2.5-7b-instruct': {
    id: '@cf/qwen/qwen2.5-7b-instruct',
    name: 'Qwen 2.5 7B Instruct (Cloudflare Workers AI)',
    task: 'text-generation',
    enabled: true,
    freeTierEligible: true,
    contextWindow: 32768,
  },
  '@cf/mistral/mistral-7b-instruct-v0.2': {
    id: '@cf/mistral/mistral-7b-instruct-v0.2',
    name: 'Mistral 7B Instruct v0.2 (Cloudflare Workers AI)',
    task: 'text-generation',
    enabled: true,
    freeTierEligible: true,
    contextWindow: 32768,
  },
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': {
    id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    name: 'DeepSeek R1 Distill Qwen 32B (Cloudflare Workers AI)',
    task: 'text-generation',
    enabled: true,
    freeTierEligible: true,
    contextWindow: 32768,
  },
});

// Curated default free-tier eligible Workers AI text-to-image models
const CLOUDFLARE_DEFAULT_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const CLOUDFLARE_IMAGE_MODELS = Object.freeze({
  '@cf/black-forest-labs/flux-1-schnell': {
    id: '@cf/black-forest-labs/flux-1-schnell',
    name: 'FLUX.1 Schnell (Cloudflare Workers AI)',
    provider: 'Cloudflare Workers AI',
    task: 'text-to-image',
    category: 'Image Generation',
    enabled: true,
    freeTierEligible: true,
    steps: 4,
    description: 'High-speed 12B parameter state-of-the-art text-to-image generator',
  },
  '@cf/stabilityai/stable-diffusion-xl-base-1.0': {
    id: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
    name: 'Stable Diffusion XL Base 1.0 (Cloudflare Workers AI)',
    provider: 'Cloudflare Workers AI',
    task: 'text-to-image',
    category: 'Image Generation',
    enabled: true,
    freeTierEligible: true,
    steps: 20,
    description: 'High-resolution photo and vector generation with SDXL Base 1.0',
  },
  '@cf/bytedance/stable-diffusion-xl-lightning': {
    id: '@cf/bytedance/stable-diffusion-xl-lightning',
    name: 'SDXL Lightning (Cloudflare Workers AI)',
    provider: 'Cloudflare Workers AI',
    task: 'text-to-image',
    category: 'Image Generation',
    enabled: true,
    freeTierEligible: true,
    steps: 4,
    description: 'Sub-second lightning-fast text-to-image inference',
  },
  '@cf/runwayml/stable-diffusion-v1-5': {
    id: '@cf/runwayml/stable-diffusion-v1-5',
    name: 'Stable Diffusion v1.5 (Cloudflare Workers AI)',
    provider: 'Cloudflare Workers AI',
    task: 'text-to-image',
    category: 'Image Generation',
    enabled: true,
    freeTierEligible: true,
    steps: 20,
    description: 'Classic Stable Diffusion 1.5 text-to-image generation',
  },
});

function isCloudflareImageModel(id) {
  const value = String(id || '').trim();
  if (!MODEL_ID.test(value)) return false;
  return Boolean(CLOUDFLARE_IMAGE_MODELS[value]) || /(sdxl|stable-diffusion|flux)/i.test(value);
}

function readEnvCredentials(env) {
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const apiToken = String(env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_KEY || '').trim();
  const apiToken2 = String(
    env.CLOUDFLARE_API_TOKEN_2 ||
    env.CLOUDFLARE_API_KEY_2 ||
    env.CLOUDFLARE_IMAGE_API_TOKEN ||
    env.CLOUDFLARE_IMAGE_API_KEY ||
    ''
  ).trim();
  return {
    accountId: accountId || null,
    apiToken: apiToken || null,
    apiToken2: apiToken2 || null,
  };
}

function maskAccountId(accountId) {
  if (!accountId || accountId.length < 6) return '••••';
  const prefix = accountId.slice(0, 6);
  return `${prefix}${'•'.repeat(Math.max(8, accountId.length - 6))}`;
}

function maskToken(token) {
  if (!token || token.length < 8) return '••••••••';
  const prefix = token.slice(0, 4);
  const suffix = token.slice(-4);
  return `${prefix}${'•'.repeat(Math.min(16, Math.max(8, token.length - 8)))}${suffix}`;
}

function isCloudflareChatModel(id) {
  const value = String(id || '').trim();
  if (!MODEL_ID.test(value) || NON_CHAT_ID.test(value)) return false;
  return true;
}

function getUtcDayKey(timestamp) {
  const d = new Date(timestamp);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

function prettyName(id) {
  const value = String(id || '').trim();
  const base = value.replace(/^@[^/]+\//, '');
  if (/llama.*3\.1.*8b/i.test(base)) return 'Llama 3.1 8B Instruct (Cloudflare Workers AI)';
  if (/llama.*3\.3.*70b/i.test(base)) return 'Llama 3.3 70B Instruct (Cloudflare Workers AI)';
  if (/llama.*3.*8b/i.test(base)) return 'Llama 3 8B Instruct (Cloudflare Workers AI)';
  if (/qwen.*7b/i.test(base)) return 'Qwen 2.5 7B Instruct (Cloudflare Workers AI)';
  if (/deepseek.*r1/i.test(base)) return 'DeepSeek R1 Distill Qwen (Cloudflare Workers AI)';
  if (/mistral.*7b/i.test(base)) return 'Mistral 7B Instruct (Cloudflare Workers AI)';
  return base.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 80) + ' (Cloudflare Workers AI)';
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
    dailyNeuronsLimit: DEFAULT_DAILY_NEURONS_LIMIT,
    defaultModelId: '@cf/meta/llama-3.1-8b-instruct',
    models: { ...DEFAULT_CLOUDFLARE_MODELS },
    usage: {
      requests: 0,
      failures: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedNeuronsUsedToday: 0,
      totalEstimatedNeuronsLifetime: 0,
      utcDayKey: getUtcDayKey(Date.now()),
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

function createCloudflareConfig({ dir = process.cwd(), env = process.env, logger = console, now = Date.now } = {}) {
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
      logger.error('Failed to persist Cloudflare config:', err.message);
    }
  }

  function checkUtcDayRollover() {
    const currentUtcDay = getUtcDayKey(now());
    if (config.usage.utcDayKey !== currentUtcDay) {
      config.usage.utcDayKey = currentUtcDay;
      config.usage.estimatedNeuronsUsedToday = 0;
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
      dailyNeuronsLimit: safeInteger(raw.dailyNeuronsLimit, DEFAULT_DAILY_NEURONS_LIMIT),
      defaultModelId: raw.defaultModelId || '@cf/meta/llama-3.1-8b-instruct',
      models: {},
      usage: {
        requests: safeInteger(raw.usage?.requests),
        failures: safeInteger(raw.usage?.failures),
        inputTokens: safeInteger(raw.usage?.inputTokens),
        outputTokens: safeInteger(raw.usage?.outputTokens),
        totalTokens: safeInteger(raw.usage?.totalTokens),
        estimatedNeuronsUsedToday: safeNumber(raw.usage?.estimatedNeuronsUsedToday),
        totalEstimatedNeuronsLifetime: safeNumber(raw.usage?.totalEstimatedNeuronsLifetime),
        utcDayKey: raw.usage?.utcDayKey || getUtcDayKey(now()),
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

    // Models
    const rawModels = raw.models && typeof raw.models === 'object' ? raw.models : DEFAULT_CLOUDFLARE_MODELS;
    for (const [id, m] of Object.entries(rawModels)) {
      if (typeof id !== 'string' || !isCloudflareChatModel(id)) continue;
      out.models[id] = {
        id,
        name: m?.name || prettyName(id),
        task: m?.task || 'text-generation',
        enabled: m?.enabled !== false,
        freeTierEligible: m?.freeTierEligible !== false,
        contextWindow: safeInteger(m?.contextWindow, 32768),
        verifiedAt: m?.verifiedAt || null,
      };
    }

    if (!Object.keys(out.models).length) {
      out.models = { ...DEFAULT_CLOUDFLARE_MODELS };
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

  function getDailyNeuronsLimit() {
    return config.dailyNeuronsLimit;
  }

  function setDailyNeuronsLimit(limit) {
    config.dailyNeuronsLimit = Math.max(100, safeInteger(limit, DEFAULT_DAILY_NEURONS_LIMIT));
    save();
  }

  function getRemainingDailyNeurons() {
    checkUtcDayRollover();
    return Math.max(0, config.dailyNeuronsLimit - config.usage.estimatedNeuronsUsedToday);
  }

  function isDailyQuotaExhausted() {
    checkUtcDayRollover();
    return config.usage.estimatedNeuronsUsedToday >= config.dailyNeuronsLimit;
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
      const id = String(item?.id || item?.name || '').trim();
      if (!isCloudflareChatModel(id)) continue;
      const prev = config.models[id] || {};
      next[id] = {
        id,
        name: item.name && item.name !== id ? item.name : (prev.name || prettyName(id)),
        task: item.task?.id || item.task || 'text-generation',
        enabled: prev.enabled !== undefined ? prev.enabled : true,
        freeTierEligible: !NON_CHAT_ID.test(id),
        contextWindow: safeInteger(item.context_window || item.contextWindow, prev.contextWindow || 32768),
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

  function recordUsage({ model, ok, inputTokens = 0, outputTokens = 0, neurons = 0, error = null }) {
    checkUtcDayRollover();
    const u = config.usage;
    u.requests += 1;

    if (ok) {
      const inTok = safeInteger(inputTokens);
      const outTok = safeInteger(outputTokens);
      const totalTok = inTok + outTok;
      // Calculate neurons: use provided or estimate
      const estNeurons = neurons > 0
        ? neurons
        : Math.max(MIN_NEURONS_PER_REQUEST, Math.ceil((totalTok / 100) * NEURONS_PER_100_TOKENS));

      u.inputTokens += inTok;
      u.outputTokens += outTok;
      u.totalTokens += totalTok;
      u.estimatedNeuronsUsedToday += estNeurons;
      u.totalEstimatedNeuronsLifetime += estNeurons;
      u.lastSuccessAt = new Date(now()).toISOString();

      if (model) {
        if (!u.byModel[model]) u.byModel[model] = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedNeurons: 0 };
        const bm = u.byModel[model];
        bm.requests += 1;
        bm.inputTokens += inTok;
        bm.outputTokens += outTok;
        bm.totalTokens += totalTok;
        bm.estimatedNeurons += estNeurons;
      }
    } else {
      u.failures += 1;
      const errObj = {
        at: new Date(now()).toISOString(),
        code: error?.code || 'error',
        message: String(error?.message || 'Unknown Cloudflare Workers AI error').slice(0, 300),
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
    checkUtcDayRollover();
    return {
      provider: 'Cloudflare Workers AI',
      enabled: isEnabled(),
      spendingPolicy: getSpendingPolicy(),
      dailyNeuronsLimit: getDailyNeuronsLimit(),
      remainingDailyNeurons: getRemainingDailyNeurons(),
      isDailyQuotaExhausted: isDailyQuotaExhausted(),
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
    getDailyNeuronsLimit,
    setDailyNeuronsLimit,
    getRemainingDailyNeurons,
    isDailyQuotaExhausted,
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
  createCloudflareConfig,
  readEnvCredentials,
  maskAccountId,
  maskToken,
  isCloudflareChatModel,
  isCloudflareImageModel,
  CLOUDFLARE_IMAGE_MODELS,
  CLOUDFLARE_DEFAULT_IMAGE_MODEL,
  prettyName,
  getUtcDayKey,
  DEFAULT_DAILY_NEURONS_LIMIT,
  CONFIG_FILE,
  MODEL_ID,
};
