'use strict';
// Eden AI Provider Configuration and State Manager for PHOTON AI.
//
// Features:
// - Encrypts API keys before storing in .photon-edenai-config.json using AES-256-GCM.
// - Reads EDENAI_API_KEY from environment or secure encrypted config file.
// - Never exposes raw API keys to the frontend or in status endpoints.
// - Discovers and maintains models across Text Generation, Image Generation, and Video Generation.
// - Tracks request counts, token usage, errors, and spending policies.
// - Supports API key rotation and model enable/disable toggling.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_VERSION = 1;
const CONFIG_FILE = '.photon-edenai-config.json';
const MAX_RECENT_ERRORS = 25;
const SPENDING_POLICIES = Object.freeze(['allow_all', 'allow_free_only', 'block']);

// Default vetted Eden AI models across capabilities
const DEFAULT_EDENAI_MODELS = Object.freeze({
  // Text Models
  'openai/gpt-4o-mini': {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o Mini (Eden AI - OpenAI)',
    provider: 'Eden AI',
    subprovider: 'openai',
    category: 'Text Generation',
    task: 'text-generation',
    contextWindow: 128000,
    enabled: true,
    pricing: '$0.00000015 / in · $0.0000006 / out',
    capabilities: { text: true, vision: true, pdf: true, image_output: false, video_output: false },
    supportedParameters: ['temperature', 'max_tokens', 'top_p', 'stream'],
  },
  'anthropic/claude-3-5-haiku': {
    id: 'anthropic/claude-3-5-haiku',
    name: 'Claude 3.5 Haiku (Eden AI - Anthropic)',
    provider: 'Eden AI',
    subprovider: 'anthropic',
    category: 'Text Generation',
    task: 'text-generation',
    contextWindow: 200000,
    enabled: true,
    pricing: '$0.000001 / in · $0.000005 / out',
    capabilities: { text: true, vision: true, pdf: false, image_output: false, video_output: false },
    supportedParameters: ['temperature', 'max_tokens', 'top_p', 'stream'],
  },
  'meta/llama-3.1-70b-instruct': {
    id: 'meta/llama-3.1-70b-instruct',
    name: 'Llama 3.1 70B Instruct (Eden AI - Meta)',
    provider: 'Eden AI',
    subprovider: 'meta',
    category: 'Text Generation',
    task: 'text-generation',
    contextWindow: 131072,
    enabled: true,
    pricing: '$0.0000004 / in · $0.0000009 / out',
    capabilities: { text: true, vision: false, pdf: false, image_output: false, video_output: false },
    supportedParameters: ['temperature', 'max_tokens', 'top_p', 'stream'],
  },
  // Image Models
  'stabilityai/sd3.5-medium': {
    id: 'stabilityai/sd3.5-medium',
    name: 'Stable Diffusion 3.5 Medium (Eden AI - Stability)',
    provider: 'Eden AI',
    subprovider: 'stabilityai',
    category: 'Image Generation',
    task: 'text-to-image',
    contextWindow: 0,
    enabled: true,
    pricing: '$0.035 / image',
    capabilities: { text: false, vision: false, pdf: false, image_output: true, video_output: false },
    supportedParameters: ['size', 'n', 'prompt'],
  },
  'stabilityai/sd3.5-large': {
    id: 'stabilityai/sd3.5-large',
    name: 'Stable Diffusion 3.5 Large (Eden AI - Stability)',
    provider: 'Eden AI',
    subprovider: 'stabilityai',
    category: 'Image Generation',
    task: 'text-to-image',
    contextWindow: 0,
    enabled: true,
    pricing: '$0.065 / image',
    capabilities: { text: false, vision: false, pdf: false, image_output: true, video_output: false },
    supportedParameters: ['size', 'n', 'prompt'],
  },
  // Video Models
  'bytedance/dreamina-seedance-2-0-fast-260128': {
    id: 'bytedance/dreamina-seedance-2-0-fast-260128',
    name: 'Dreamina Seedance 2.0 Fast (Eden AI - Bytedance)',
    provider: 'Eden AI',
    subprovider: 'bytedance',
    category: 'Video Generation',
    task: 'text-to-video',
    contextWindow: 0,
    enabled: true,
    pricing: '$5.60 / M tokens',
    capabilities: { text: false, vision: false, pdf: false, image_output: false, video_output: true },
    supportedParameters: ['prompt', 'seconds', 'size'],
  },
  'pruna/p-video': {
    id: 'pruna/p-video',
    name: 'Pruna P-Video (Eden AI - Pruna)',
    provider: 'Eden AI',
    subprovider: 'pruna',
    category: 'Video Generation',
    task: 'text-to-video',
    contextWindow: 0,
    enabled: true,
    pricing: '$0.02 / second',
    capabilities: { text: false, vision: false, pdf: false, image_output: false, video_output: true },
    supportedParameters: ['prompt', 'seconds', 'size'],
  },
});

function getEncryptionKey() {
  const secret = process.env.PHOTON_SECRET || process.env.PHOTON_ADMIN_PASSWORD || 'photon-edenai-master-key-seed';
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptKey(plainText) {
  if (!plainText) return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptKey(cipherText) {
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

function readEnvKey(env = process.env) {
  return String(env.EDENAI_API_KEY || '').trim() || null;
}

function maskKey(secret) {
  if (!secret || secret.length < 4) return '••••';
  const prefix = secret.slice(0, Math.min(6, Math.floor(secret.length / 3)));
  const suffix = secret.slice(-4);
  return `${prefix}••••••••${suffix}`;
}

function fingerprint(secret) {
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

function safeInteger(value, fallback = 0) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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

function createEdenAiConfig({ dir = process.cwd(), env = process.env, logger = console, now = Date.now } = {}) {
  const stateFile = path.join(dir, CONFIG_FILE);
  let config;

  function normalizeConfig(src) {
    const base = {
      version: CONFIG_VERSION,
      provider: 'Eden AI',
      providerSlug: 'edenai',
      website: 'https://www.edenai.co/',
      documentation: 'https://docs.edenai.co/',
      enabled: true,
      spendingPolicy: 'allow_all',
      encryptedKey: null,
      maskedKey: null,
      keyFingerprint: null,
      models: { ...DEFAULT_EDENAI_MODELS },
      usage: {
        requests: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        lastSuccessAt: null,
        lastError: null,
        byCapability: {
          text: { requests: 0, failures: 0, tokens: 0 },
          image: { requests: 0, failures: 0, images: 0 },
          video: { requests: 0, failures: 0, jobs: 0 },
        },
      },
      lastTestResults: {
        connection: null,
        text: null,
        image: null,
        video: null,
      },
      recentErrors: [],
      updatedAt: new Date(now()).toISOString(),
    };

    if (!src || typeof src !== 'object') return base;

    base.enabled = src.enabled !== false;
    base.spendingPolicy = SPENDING_POLICIES.includes(src.spendingPolicy) ? src.spendingPolicy : 'allow_all';
    base.encryptedKey = typeof src.encryptedKey === 'string' ? src.encryptedKey : null;
    base.maskedKey = typeof src.maskedKey === 'string' ? src.maskedKey : null;
    base.keyFingerprint = typeof src.keyFingerprint === 'string' ? src.keyFingerprint : null;

    if (src.models && typeof src.models === 'object') {
      base.models = {};
      for (const [id, m] of Object.entries(src.models)) {
        if (!m || typeof m !== 'object') continue;
        base.models[id] = {
          id: String(m.id || id),
          name: String(m.name || id),
          provider: 'Eden AI',
          subprovider: String(m.subprovider || 'edenai'),
          category: String(m.category || 'Text Generation'),
          task: String(m.task || 'text-generation'),
          contextWindow: safeInteger(m.contextWindow, 4096),
          enabled: m.enabled !== false,
          pricing: String(m.pricing || 'Standard rate'),
          capabilities: m.capabilities || { text: true, vision: false, pdf: false, image_output: false, video_output: false },
          supportedParameters: Array.isArray(m.supportedParameters) ? m.supportedParameters : ['temperature', 'max_tokens'],
          lastTestedAt: m.lastTestedAt || null,
          testResult: m.testResult || null,
        };
      }
    }
    if (!Object.keys(base.models).length) {
      base.models = { ...DEFAULT_EDENAI_MODELS };
    }

    if (src.usage && typeof src.usage === 'object') {
      base.usage = {
        requests: safeInteger(src.usage.requests),
        failures: safeInteger(src.usage.failures),
        inputTokens: safeInteger(src.usage.inputTokens),
        outputTokens: safeInteger(src.usage.outputTokens),
        totalTokens: safeInteger(src.usage.totalTokens),
        lastSuccessAt: src.usage.lastSuccessAt || null,
        lastError: src.usage.lastError || null,
        byCapability: src.usage.byCapability || base.usage.byCapability,
      };
    }

    if (src.lastTestResults && typeof src.lastTestResults === 'object') {
      base.lastTestResults = {
        connection: src.lastTestResults.connection || null,
        text: src.lastTestResults.text || null,
        image: src.lastTestResults.image || null,
        video: src.lastTestResults.video || null,
      };
    }

    if (Array.isArray(src.recentErrors)) {
      base.recentErrors = src.recentErrors.slice(0, MAX_RECENT_ERRORS);
    }

    return base;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    config = normalizeConfig(raw);
  } catch {
    config = normalizeConfig(null);
  }

  // If environment has a key, ensure encrypted config is up to date
  const envKey = readEnvKey(env);
  if (envKey && (!config.encryptedKey || config.keyFingerprint !== fingerprint(envKey))) {
    config.encryptedKey = encryptKey(envKey);
    config.maskedKey = maskKey(envKey);
    config.keyFingerprint = fingerprint(envKey);
    save();
  }

  function save() {
    config.updatedAt = new Date(now()).toISOString();
    try {
      atomicWriteJson(stateFile, config);
    } catch (err) {
      logger.error(JSON.stringify({ category: 'edenai_config_save', error: err?.message || 'write_failed' }));
    }
  }

  function getKey() {
    // 1. Check environment variable
    const envVal = readEnvKey(env);
    if (envVal) return envVal;
    // 2. Decrypt saved encrypted key
    if (config.encryptedKey) {
      return decryptKey(config.encryptedKey);
    }
    return null;
  }

  function setKey(plainKey) {
    const clean = String(plainKey || '').trim();
    if (clean) {
      env.EDENAI_API_KEY = clean;
      config.encryptedKey = encryptKey(clean);
      config.maskedKey = maskKey(clean);
      config.keyFingerprint = fingerprint(clean);
    } else {
      delete env.EDENAI_API_KEY;
      config.encryptedKey = null;
      config.maskedKey = null;
      config.keyFingerprint = null;
    }
    save();
  }

  function isConfigured() {
    return Boolean(getKey());
  }

  function isEnabled() {
    return isConfigured() && config.enabled !== false;
  }

  function setEnabled(val) {
    config.enabled = Boolean(val);
    save();
  }

  function getSpendingPolicy() {
    return config.spendingPolicy || 'allow_all';
  }

  function setSpendingPolicy(policy) {
    if (!SPENDING_POLICIES.includes(policy)) {
      throw new Error(`Invalid spending policy: ${policy}. Must be one of: ${SPENDING_POLICIES.join(', ')}`);
    }
    config.spendingPolicy = policy;
    save();
  }

  function getModels() {
    return Object.values(config.models);
  }

  function getModel(id) {
    return config.models[id] || null;
  }

  function setModelEnabled(id, enabled) {
    if (!config.models[id]) {
      throw new Error(`Model not found in Eden AI catalogue: ${id}`);
    }
    config.models[id].enabled = Boolean(enabled);
    save();
  }

  function updateDiscoveredModels(modelList = []) {
    let changed = false;
    for (const m of modelList) {
      if (!m || !m.id) continue;
      const existing = config.models[m.id];
      config.models[m.id] = {
        id: m.id,
        name: m.name || (existing && existing.name) || m.id,
        provider: 'Eden AI',
        subprovider: m.subprovider || (existing && existing.subprovider) || 'edenai',
        category: m.category || (existing && existing.category) || 'Text Generation',
        task: m.task || (existing && existing.task) || 'text-generation',
        contextWindow: m.contextWindow || (existing && existing.contextWindow) || 4096,
        enabled: existing ? existing.enabled : true,
        pricing: m.pricing || (existing && existing.pricing) || 'Standard rate',
        capabilities: m.capabilities || (existing && existing.capabilities) || { text: true, vision: false, pdf: false, image_output: false, video_output: false },
        supportedParameters: m.supportedParameters || (existing && existing.supportedParameters) || ['temperature', 'max_tokens'],
        lastTestedAt: (existing && existing.lastTestedAt) || null,
        testResult: (existing && existing.testResult) || null,
      };
      changed = true;
    }
    if (changed) save();
  }

  function recordUsage({ capability = 'text', inputTokens = 0, outputTokens = 0, totalTokens = 0, isError = false } = {}) {
    config.usage.requests = (config.usage.requests || 0) + 1;
    if (isError) {
      config.usage.failures = (config.usage.failures || 0) + 1;
    } else {
      config.usage.lastSuccessAt = new Date(now()).toISOString();
    }
    const cap = String(capability).toLowerCase();
    if (!config.usage.byCapability) {
      config.usage.byCapability = {
        text: { requests: 0, failures: 0, tokens: 0 },
        image: { requests: 0, failures: 0, images: 0 },
        video: { requests: 0, failures: 0, jobs: 0 },
      };
    }
    const capStats = config.usage.byCapability[cap] || { requests: 0, failures: 0 };
    capStats.requests = (capStats.requests || 0) + 1;
    if (isError) {
      capStats.failures = (capStats.failures || 0) + 1;
    } else {
      if (cap === 'text') {
        const inp = safeInteger(inputTokens);
        const out = safeInteger(outputTokens);
        const tot = safeInteger(totalTokens, inp + out);
        config.usage.inputTokens = (config.usage.inputTokens || 0) + inp;
        config.usage.outputTokens = (config.usage.outputTokens || 0) + out;
        config.usage.totalTokens = (config.usage.totalTokens || 0) + tot;
        capStats.tokens = (capStats.tokens || 0) + tot;
      } else if (cap === 'image') {
        capStats.images = (capStats.images || 0) + 1;
      } else if (cap === 'video') {
        capStats.jobs = (capStats.jobs || 0) + 1;
      }
    }
    config.usage.byCapability[cap] = capStats;
    save();
  }

  function recordError(err) {
    const errorEntry = {
      timestamp: new Date(now()).toISOString(),
      code: err?.code || 'error',
      message: String(err?.message || 'Unknown error').replace(/[A-Za-z0-9_-]{24,}/g, '••••'),
      status: err?.status || 500,
    };
    config.usage.lastError = errorEntry;
    config.recentErrors.unshift(errorEntry);
    if (config.recentErrors.length > MAX_RECENT_ERRORS) {
      config.recentErrors.length = MAX_RECENT_ERRORS;
    }
    save();
  }

  function recordTestResult(capability, result) {
    if (!config.lastTestResults) config.lastTestResults = {};
    config.lastTestResults[capability] = {
      ...result,
      recordedAt: new Date(now()).toISOString(),
    };
    save();
  }

  function status() {
    const key = getKey();
    const isConfig = Boolean(key);
    return {
      provider: 'Eden AI',
      providerSlug: 'edenai',
      website: config.website,
      documentation: config.documentation,
      configured: isConfig,
      enabled: isEnabled(),
      hasKey: isConfig,
      maskedKey: isConfig ? (config.maskedKey || maskKey(key)) : null,
      keyFingerprint: isConfig ? (config.keyFingerprint || fingerprint(key)) : null,
      spendingPolicy: config.spendingPolicy,
      modelCount: Object.keys(config.models).length,
      models: Object.values(config.models),
      usage: config.usage,
      lastTestResults: config.lastTestResults,
      recentErrors: config.recentErrors,
      updatedAt: config.updatedAt,
    };
  }

  return {
    getKey,
    setKey,
    isConfigured,
    isEnabled,
    setEnabled,
    getSpendingPolicy,
    setSpendingPolicy,
    getModels,
    getModel,
    setModelEnabled,
    updateDiscoveredModels,
    recordUsage,
    recordError,
    recordTestResult,
    status,
    encryptKey,
    decryptKey,
    maskKey,
    fingerprint,
    DEFAULT_EDENAI_MODELS,
  };
}

module.exports = {
  createEdenAiConfig,
  encryptKey,
  decryptKey,
  readEnvKey,
  maskKey,
  fingerprint,
  DEFAULT_EDENAI_MODELS,
};
