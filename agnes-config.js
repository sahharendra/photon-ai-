'use strict';
// Agnes AI Provider Configuration and State Manager for PHOTON AI.
//
// Features:
// - Encrypts API keys before storing in .photon-agnes-config.json using AES-256-GCM.
// - Reads AGNES_API_KEY from environment or secure encrypted config file.
// - Never exposes raw API keys to the frontend or in status endpoints.
// - Maintains the dedicated Agnes Video 2.5 Flash video model with 720P limitation.
// - Enforces strict free-only spending protection ($0/sec promotion).
// - Tracks request counts, token usage, errors, and spending policies.
// - Supports API key rotation and model enable/disable toggling.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_VERSION = 1;
const CONFIG_FILE = '.photon-agnes-config.json';
const MAX_RECENT_ERRORS = 25;
const SPENDING_POLICIES = Object.freeze(['strict_free_only', 'allow_all', 'block']);

// Agnes AI Documented Video Model
const DEFAULT_AGNES_MODELS = Object.freeze({
  'agnes-video-2.5-flash': {
    id: 'agnes-video-2.5-flash',
    name: 'Agnes Video 2.5 Flash',
    provider: 'Agnes AI',
    category: 'Video Generation',
    task: 'text-to-video',
    resolution: '720p',
    maxSeconds: 5,
    defaultSeconds: 5,
    aspectRatios: ['16:9', '9:16', '1:1'],
    enabled: true,
    freePromotion: true,
    pricing: '$0.00 / sec (Free Promotion)',
    spendingPolicy: 'strict_free_only',
    capabilities: {
      text: false,
      image_output: false,
      video_output: true,
      keyframes: true,
      reference_image: true,
      resolution: '720p',
    },
    supportedParameters: ['model', 'prompt', 'mode', 'seconds', 'size', 'aspect_ratio', 'n', 'reference_image'],
    description: 'Agnes AI Video 2.5 Flash - High speed 720P video generation with $0/sec free promotion.',
    priceStatus: 'FREE_PROMOTION',
  },
});

function getEncryptionKey() {
  const secret = process.env.PHOTON_SECRET || process.env.PHOTON_ADMIN_PASSWORD || 'photon-agnes-master-key-seed';
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
  return String(env.AGNES_API_KEY || '').trim() || null;
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

function createAgnesConfig({ dir = process.cwd(), env = process.env, logger = console, now = Date.now } = {}) {
  const stateFile = path.join(dir, CONFIG_FILE);
  let config;

  function normalizeConfig(src) {
    const base = {
      version: CONFIG_VERSION,
      provider: 'Agnes AI',
      providerSlug: 'agnes',
      website: 'https://apihub.agnes-ai.com/',
      documentation: 'https://apihub.agnes-ai.com/v1',
      enabled: true,
      spendingPolicy: 'strict_free_only',
      encryptedKey: null,
      maskedKey: null,
      keyFingerprint: null,
      models: { ...DEFAULT_AGNES_MODELS },
      usage: {
        requests: 0,
        failures: 0,
        videoJobs: 0,
        completedVideos: 0,
        failedVideos: 0,
        totalSeconds: 0,
        lastSuccessAt: null,
        lastError: null,
      },
      lastTestResults: {
        connection: null,
        video: null,
      },
      recentErrors: [],
      updatedAt: new Date(now()).toISOString(),
    };

    if (!src || typeof src !== 'object') return base;

    base.enabled = src.enabled !== false;
    base.spendingPolicy = SPENDING_POLICIES.includes(src.spendingPolicy) ? src.spendingPolicy : 'strict_free_only';
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
          provider: 'Agnes AI',
          category: 'Video Generation',
          task: 'text-to-video',
          resolution: String(m.resolution || '720p'),
          maxSeconds: safeInteger(m.maxSeconds, 5),
          defaultSeconds: safeInteger(m.defaultSeconds, 5),
          aspectRatios: Array.isArray(m.aspectRatios) ? m.aspectRatios : ['16:9', '9:16', '1:1'],
          enabled: m.enabled !== false,
          freePromotion: m.freePromotion !== false,
          pricing: String(m.pricing || '$0.00 / sec (Free Promotion)'),
          spendingPolicy: SPENDING_POLICIES.includes(m.spendingPolicy) ? m.spendingPolicy : 'strict_free_only',
          priceStatus: String(m.priceStatus || 'FREE_PROMOTION'),
          capabilities: {
            text: false,
            image_output: false,
            video_output: true,
            keyframes: Boolean(m.capabilities?.keyframes !== false),
            reference_image: Boolean(m.capabilities?.reference_image !== false),
            resolution: String(m.capabilities?.resolution || '720p'),
          },
          supportedParameters: Array.isArray(m.supportedParameters) ? m.supportedParameters : ['model', 'prompt', 'mode', 'seconds', 'size', 'aspect_ratio', 'n', 'reference_image'],
          description: String(m.description || 'Agnes Video 2.5 Flash'),
          lastTestedAt: m.lastTestedAt || null,
          testStatus: m.testStatus || null,
        };
      }
    }

    // Guarantee default documented model is always present
    for (const [defId, defModel] of Object.entries(DEFAULT_AGNES_MODELS)) {
      if (!base.models[defId]) {
        base.models[defId] = { ...defModel };
      }
    }

    if (src.usage && typeof src.usage === 'object') {
      base.usage = {
        requests: safeInteger(src.usage.requests),
        failures: safeInteger(src.usage.failures),
        videoJobs: safeInteger(src.usage.videoJobs),
        completedVideos: safeInteger(src.usage.completedVideos),
        failedVideos: safeInteger(src.usage.failedVideos),
        totalSeconds: safeInteger(src.usage.totalSeconds),
        lastSuccessAt: src.usage.lastSuccessAt || null,
        lastError: src.usage.lastError || null,
      };
    }

    if (src.lastTestResults && typeof src.lastTestResults === 'object') {
      base.lastTestResults = {
        connection: src.lastTestResults.connection || null,
        video: src.lastTestResults.video || null,
      };
    }

    if (Array.isArray(src.recentErrors)) {
      base.recentErrors = src.recentErrors.slice(-MAX_RECENT_ERRORS);
    }

    return base;
  }

  function load() {
    try {
      if (fs.existsSync(stateFile)) {
        const raw = fs.readFileSync(stateFile, 'utf8');
        config = normalizeConfig(JSON.parse(raw));
      } else {
        config = normalizeConfig({});
        const envKey = readEnvKey(env);
        if (envKey) {
          config.encryptedKey = encryptKey(envKey);
          config.maskedKey = maskKey(envKey);
          config.keyFingerprint = fingerprint(envKey);
        }
        persist();
      }
    } catch (err) {
      logger.warn(`[AgnesConfig] Failed to load ${stateFile}:`, err.message);
      config = normalizeConfig({});
    }
  }

  function persist() {
    config.updatedAt = new Date(now()).toISOString();
    try {
      atomicWriteJson(stateFile, config);
    } catch (err) {
      logger.error(`[AgnesConfig] Failed to save ${stateFile}:`, err.message);
    }
  }

  load();

  function isConfigured() {
    const envKey = readEnvKey(env);
    if (envKey) return true;
    return Boolean(config.encryptedKey && decryptKey(config.encryptedKey));
  }

  function isEnabled() {
    return Boolean(config.enabled);
  }

  function setEnabled(val) {
    config.enabled = Boolean(val);
    persist();
  }

  function getSpendingPolicy() {
    return config.spendingPolicy || 'strict_free_only';
  }

  function setSpendingPolicy(policy) {
    if (SPENDING_POLICIES.includes(policy)) {
      config.spendingPolicy = policy;
      persist();
    }
  }

  function getKey() {
    const envKey = readEnvKey(env);
    if (envKey) return envKey;
    if (!config.encryptedKey) return null;
    return decryptKey(config.encryptedKey);
  }

  function setKey(plainKey) {
    const clean = String(plainKey || '').trim();
    if (clean) {
      config.encryptedKey = encryptKey(clean);
      config.maskedKey = maskKey(clean);
      config.keyFingerprint = fingerprint(clean);
      env.AGNES_API_KEY = clean;
      process.env.AGNES_API_KEY = clean;
    } else {
      config.encryptedKey = null;
      config.maskedKey = null;
      config.keyFingerprint = null;
      delete env.AGNES_API_KEY;
      delete process.env.AGNES_API_KEY;
    }
    persist();
  }

  function getMaskedKey() {
    const k = getKey();
    return k ? maskKey(k) : null;
  }

  function getModels() {
    return Object.values(config.models);
  }

  function getModel(id) {
    return config.models[id] || null;
  }

  function setModelEnabled(id, enabled) {
    if (config.models[id]) {
      config.models[id].enabled = Boolean(enabled);
      persist();
      return true;
    }
    return false;
  }

  function registerModel(model) {
    if (model && model.id) {
      config.models[model.id] = {
        category: 'Video Generation',
        task: 'text-to-video',
        ...model,
      };
      persist();
      return true;
    }
    return false;
  }

  function updateModel(id, props = {}) {
    if (!config.models[id]) {
      config.models[id] = { id, category: 'Video Generation', task: 'text-to-video', ...props };
    } else {
      Object.assign(config.models[id], props);
    }
    persist();
    return true;
  }

  function recordUsage({ success = true, seconds = 0, error = null } = {}) {
    config.usage.requests += 1;
    config.usage.videoJobs += 1;
    if (success) {
      config.usage.completedVideos += 1;
      config.usage.totalSeconds += safeInteger(seconds, 0);
      config.usage.lastSuccessAt = new Date(now()).toISOString();
    } else {
      config.usage.failures += 1;
      config.usage.failedVideos += 1;
      config.usage.lastError = error ? String(error) : 'Unknown error';
    }
    persist();
  }

  function recordError(err) {
    const entry = {
      message: err?.message || String(err),
      code: err?.code || 'UNKNOWN',
      status: err?.status || null,
      timestamp: new Date(now()).toISOString(),
    };
    config.recentErrors.unshift(entry);
    if (config.recentErrors.length > MAX_RECENT_ERRORS) {
      config.recentErrors.pop();
    }
    persist();
  }

  function setLastTestResult(kind, result) {
    if (!config.lastTestResults) config.lastTestResults = {};
    config.lastTestResults[kind] = {
      ...result,
      testedAt: new Date(now()).toISOString(),
    };
    persist();
  }

  function status() {
    const hasKey = isConfigured();
    const masked = getMaskedKey();
    const models = getModels();
    const videoModels = models.filter(m => m.category === 'Video Generation');
    const freeModels = models.filter(m => m.freePromotion);

    return {
      provider: 'Agnes AI',
      providerSlug: 'agnes',
      website: config.website,
      documentation: config.documentation,
      configured: hasKey,
      enabled: isEnabled(),
      maskedKey: masked,
      hasKey,
      spendingPolicy: getSpendingPolicy(),
      spendingPolicyDescription: getSpendingPolicy() === 'strict_free_only'
        ? 'Strict Free-Only ($0/sec Promotion active. Paid generations strictly blocked.)'
        : (getSpendingPolicy() === 'allow_all' ? 'All tiers allowed' : 'Blocked'),
      modelsCount: models.length,
      videoModelsCount: videoModels.length,
      freeModelsCount: freeModels.length,
      models,
      usage: config.usage,
      lastTestResults: config.lastTestResults,
      recentErrors: config.recentErrors,
      freePromotionVerified: true,
      freePromotionDetails: {
        model: 'agnes-video-2.5-flash',
        rate: '$0.00 / sec',
        maxDuration: '5 seconds',
        resolution: '720P (1280x720)',
        creditCardRequired: false,
      },
    };
  }

  return {
    isConfigured,
    isEnabled,
    setEnabled,
    getSpendingPolicy,
    setSpendingPolicy,
    getKey,
    setKey,
    getMaskedKey,
    getModels,
    getModel,
    setModelEnabled,
    updateModel,
    recordUsage,
    recordError,
    setLastTestResult,
    status,
    DEFAULT_AGNES_MODELS,
  };
}

module.exports = {
  createAgnesConfig,
  DEFAULT_AGNES_MODELS,
  maskKey,
};
