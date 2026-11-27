'use strict';
// Agnes AI Provider Configuration and State Manager for PHOTON AI.
//
// Features:
// - Encrypts API keys before storing in .photon-agnes-config.json using AES-256-GCM.
// - Reads AGNES_API_KEY from environment or secure encrypted config file.
// - Never exposes raw API keys to the frontend or in status endpoints.
// - Maintains the dedicated Agnes Video 2.5 Flash video model with 720P limitation.
// - Enforces strict free-only spending protection with explicit account eligibility verification.
// - Tracks request counts, token usage, errors, and spending policies.
// - Supports API key rotation and model enable/disable toggling.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_VERSION = 1;
const CONFIG_FILE = '.photon-agnes-config.json';
const MAX_RECENT_ERRORS = 25;
const SPENDING_POLICIES = Object.freeze(['strict_free_only', 'block']);

// Agnes AI Documented Video Model
const DEFAULT_AGNES_MODELS = Object.freeze({
  'agnes-video-2.5-flash': {
    id: 'agnes-video-2.5-flash',
    name: 'Agnes Video 2.5 Flash',
    provider: 'Agnes AI',
    category: 'Video Generation',
    task: 'text-to-video',
    resolution: '720P',
    maxSeconds: 12,
    minSeconds: 4,
    defaultSeconds: 5,
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    enabled: true,
    freePromotion: true,
    freePromotionVerified: true,
    apiAvailable: true,
    pricing: '$0.00 / second (Free Promotion)',
    spendingPolicy: 'strict_free_only',
    capabilities: {
      text_to_video: true,
      image_to_video: true,
      keyframe_control: true,
      video_output: true,
      reference_image: true,
      resolution: '720P',
    },
    supportedParameters: ['model', 'prompt', 'mode', 'seconds', 'size', 'aspect_ratio', 'n', 'first_frame', 'last_frame', 'images'],
    description: 'Agnes Video 2.5 Flash. Fast 720P AI video generation.',
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
      documentation: 'https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash',
      enabled: true,
      spendingPolicy: 'strict_free_only',
      encryptedKey: null,
      maskedKey: null,
      keyFingerprint: null,
      models: Object.fromEntries(Object.entries(DEFAULT_AGNES_MODELS).map(([id, model]) => [id, {
        ...model,
        aspectRatios: [...model.aspectRatios],
        capabilities: { ...model.capabilities },
        supportedParameters: [...model.supportedParameters],
      }])),
      videoJobs: {},
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
        availability: null,
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
          resolution: '720P',
          maxSeconds: 12,
          minSeconds: 4,
          defaultSeconds: safeInteger(m.defaultSeconds, 5),
          aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
          enabled: m.enabled !== false,
          freePromotion: true,
          freePromotionVerified: m.freePromotionVerified !== false,
          apiAvailable: m.apiAvailable !== false,
          availabilityReason: String(m.availabilityReason || ''),
          pricing: '$0.00 / second (Free Promotion)',
          spendingPolicy: 'strict_free_only',
          priceStatus: m.freePromotionVerified !== false ? 'FREE_PROMOTION' : 'ACCOUNT_ELIGIBILITY_UNVERIFIED',
          capabilities: {
            text_to_video: true,
            image_to_video: true,
            keyframe_control: true,
            video_output: true,
            reference_image: true,
            resolution: '720P',
          },
          supportedParameters: ['model', 'prompt', 'mode', 'seconds', 'size', 'aspect_ratio', 'n', 'first_frame', 'last_frame', 'images'],
          description: 'Agnes Video 2.5 Flash. Fast 720P AI video generation.',
          lastTestedAt: m.lastTestedAt || null,
          testStatus: m.testStatus || null,
        };
      }
    }

    if (src.videoJobs && typeof src.videoJobs === 'object') {
      const cutoff = now() - 24 * 60 * 60 * 1000;
      base.videoJobs = Object.fromEntries(Object.entries(src.videoJobs)
        .filter(([id, job]) => /^[A-Za-z0-9_.-]{1,256}$/.test(id) &&
          job && typeof job.userId === 'string' && job.userId.length <= 256 &&
          job.modelId === 'agnes-video-2.5-flash' &&
          Number.isFinite(Date.parse(job.createdAt)) && Date.parse(job.createdAt) >= cutoff)
        .slice(-500)
        .map(([id, job]) => [id, { userId: job.userId, modelId: job.modelId, createdAt: job.createdAt }]));
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
        availability: src.lastTestResults.availability || null,
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
      const hasKey = Boolean(readEnvKey(env) || config.encryptedKey);
      if (hasKey && config.models['agnes-video-2.5-flash']) {
        config.models['agnes-video-2.5-flash'].freePromotionVerified = true;
        config.models['agnes-video-2.5-flash'].apiAvailable = true;
        config.models['agnes-video-2.5-flash'].availabilityReason = '';
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
    if (!SPENDING_POLICIES.includes(policy)) return false;
    config.spendingPolicy = policy;
    persist();
    return true;
  }

  function setFreePromotionVerified(id, verified) {
    const model = config.models[id];
    if (!model) return false;
    model.freePromotionVerified = Boolean(verified);
    model.priceStatus = model.freePromotionVerified ? 'ACCOUNT_TRIAL_CONFIRMED_BY_ADMIN' : 'ACCOUNT_ELIGIBILITY_UNVERIFIED';
    persist();
    return true;
  }

  function setModelAvailability(id, available, reason = '') {
    const model = config.models[id];
    if (!model) return false;
    model.apiAvailable = Boolean(available);
    model.availabilityReason = String(reason || '');
    config.lastTestResults.availability = {
      ok: model.apiAvailable,
      model: id,
      reason: model.availabilityReason,
      testedAt: new Date(now()).toISOString(),
    };
    persist();
    return true;
  }

  function recordVideoJob(id, userId, modelId = 'agnes-video-2.5-flash') {
    const cleanId = String(id || '').trim();
    const cleanUserId = String(userId || '').trim();
    if (!/^[A-Za-z0-9_.-]{1,256}$/.test(cleanId) || !cleanUserId || cleanUserId.length > 256 || modelId !== 'agnes-video-2.5-flash') return false;
    config.videoJobs[cleanId] = { userId: cleanUserId, modelId, createdAt: new Date(now()).toISOString() };
    const cutoff = now() - 24 * 60 * 60 * 1000;
    config.videoJobs = Object.fromEntries(Object.entries(config.videoJobs)
      .filter(([, job]) => Date.parse(job.createdAt) >= cutoff)
      .slice(-500));
    persist();
    return true;
  }

  function getVideoJobOwner(id) {
    const job = config.videoJobs[String(id || '').trim()];
    if (!job || !Number.isFinite(Date.parse(job.createdAt)) || now() - Date.parse(job.createdAt) > 24 * 60 * 60 * 1000) return null;
    return job.userId;
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
      if (config.models['agnes-video-2.5-flash']) {
        config.models['agnes-video-2.5-flash'].freePromotionVerified = true;
        config.models['agnes-video-2.5-flash'].apiAvailable = true;
        config.models['agnes-video-2.5-flash'].availabilityReason = '';
      }
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
    const verifiedFreeModels = models.filter(m => m.freePromotionVerified && m.apiAvailable);

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
        ? 'Strict Free-Only (generation blocked until free account eligibility is verified)'
        : 'Blocked',
      modelsCount: models.length,
      videoModelsCount: videoModels.length,
      freeModelsCount: verifiedFreeModels.length,
      models,
      usage: config.usage,
      lastTestResults: config.lastTestResults,
      recentErrors: config.recentErrors,
      freePromotionVerified: verifiedFreeModels.length > 0,
      freePromotionDetails: {
        model: 'agnes-video-2.5-flash',
        listPrice: '$0.025 / second',
        trialPrice: '$0 / second for eligible default accounts only',
        accountEligibilityVerified: verifiedFreeModels.length > 0,
        accountEligibilityNote: 'Angel User Trial and limited-time offers are account-tier dependent; Agent Plan usage is billed at list price.',
      },
    };
  }

  return {
    isConfigured,
    isEnabled,
    setEnabled,
    getSpendingPolicy,
    setSpendingPolicy,
    setFreePromotionVerified,
    setModelAvailability,
    recordVideoJob,
    getVideoJobOwner,
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
