'use strict';
// Replicate Video Generation Provider Configuration and State Manager for PHOTON AI.
//
// Features:
// - Encrypts API tokens before storing in .photon-replicate-config.json using AES-256-GCM.
// - Reads REPLICATE_API_TOKEN from environment or secure encrypted config file.
// - Never exposes raw API tokens to the frontend or in status endpoints.
// - Maintains candidate and discovered Replicate video generation models.
// - Enforces strict free-only spending protection (blocks paid-only and unverified models).
// - Tracks request counts, video jobs, token usage, errors, and spending policies.
// - Supports API token rotation and model enable/disable toggling.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_VERSION = 1;
const CONFIG_FILE = '.photon-replicate-config.json';
const MAX_RECENT_ERRORS = 25;
const SPENDING_POLICIES = Object.freeze(['strict_free_only', 'allow_all', 'block']);

// Candidate Replicate Video Generation Models to investigate
const CANDIDATE_REPLICATE_MODELS = Object.freeze({
  'minimax/video-01': {
    id: 'minimax/video-01',
    owner: 'minimax',
    name: 'video-01',
    displayName: 'MiniMax Video-01',
    provider: 'Replicate',
    category: 'Video Generation',
    task: 'text-to-video',
    resolution: '720p',
    maxSeconds: 6,
    defaultSeconds: 6,
    aspectRatios: ['16:9', '9:16', '1:1'],
    enabled: true,
    freeEligibility: 'FREE_ELIGIBILITY_UNKNOWN',
    pricing: 'Pay-as-you-go / Account trial',
    spendingPolicy: 'strict_free_only',
    billingRequired: true,
    capabilities: {
      text: false,
      image_output: false,
      video_output: true,
      text_to_video: true,
      image_to_video: true,
      reference_image: true,
      resolution: '720p',
    },
    inputSchema: {
      prompt: { type: 'string', required: true },
      prompt_optimizer: { type: 'boolean', default: true },
      first_frame_image: { type: 'string', description: 'URI or URL for image-to-video' },
    },
    description: 'MiniMax Video-01 - Cinematic video generation with physics accuracy and dynamic motion.',
    testStatus: 'NOT_TESTED',
  },
  'minimax/video-01-live': {
    id: 'minimax/video-01-live',
    owner: 'minimax',
    name: 'video-01-live',
    displayName: 'MiniMax Video-01 Live',
    provider: 'Replicate',
    category: 'Video Generation',
    task: 'image-to-video',
    resolution: '720p',
    maxSeconds: 5,
    defaultSeconds: 5,
    aspectRatios: ['16:9', '9:16', '1:1'],
    enabled: true,
    freeEligibility: 'FREE_ELIGIBILITY_UNKNOWN',
    pricing: 'Pay-as-you-go / Account trial',
    spendingPolicy: 'strict_free_only',
    billingRequired: true,
    capabilities: {
      text: false,
      image_output: false,
      video_output: true,
      text_to_video: false,
      image_to_video: true,
      reference_image: true,
      resolution: '720p',
    },
    inputSchema: {
      prompt: { type: 'string', required: true },
      first_frame_image: { type: 'string', required: true },
    },
    description: 'MiniMax Video-01 Live - Fast image animation and motion transfer.',
    testStatus: 'NOT_TESTED',
  },
  'bytedance/seedance-1-lite': {
    id: 'bytedance/seedance-1-lite',
    owner: 'bytedance',
    name: 'seedance-1-lite',
    displayName: 'ByteDance SeaDance 1 Lite',
    provider: 'Replicate',
    category: 'Video Generation',
    task: 'text-to-video',
    resolution: '720p',
    maxSeconds: 5,
    defaultSeconds: 5,
    aspectRatios: ['16:9', '9:16', '1:1'],
    enabled: true,
    freeEligibility: 'FREE_ELIGIBILITY_UNKNOWN',
    pricing: 'Pay-as-you-go / Account trial',
    spendingPolicy: 'strict_free_only',
    billingRequired: true,
    capabilities: {
      text: false,
      image_output: false,
      video_output: true,
      text_to_video: true,
      image_to_video: true,
      reference_image: true,
      resolution: '720p',
    },
    inputSchema: {
      prompt: { type: 'string', required: true },
      image: { type: 'string', description: 'Reference image' },
      aspect_ratio: { type: 'string', default: '16:9' },
    },
    description: 'ByteDance SeaDance 1 Lite - Efficient high-definition video generation.',
    testStatus: 'NOT_TESTED',
  },
  'bytedance/seedance-1-pro': {
    id: 'bytedance/seedance-1-pro',
    owner: 'bytedance',
    name: 'seedance-1-pro',
    displayName: 'ByteDance SeaDance 1 Pro',
    provider: 'Replicate',
    category: 'Video Generation',
    task: 'text-to-video',
    resolution: '1080p',
    maxSeconds: 6,
    defaultSeconds: 5,
    aspectRatios: ['16:9', '9:16', '1:1'],
    enabled: true,
    freeEligibility: 'FREE_ELIGIBILITY_UNKNOWN',
    pricing: 'Pay-as-you-go / Account trial',
    spendingPolicy: 'strict_free_only',
    billingRequired: true,
    capabilities: {
      text: false,
      image_output: false,
      video_output: true,
      text_to_video: true,
      image_to_video: true,
      reference_image: true,
      resolution: '1080p',
    },
    inputSchema: {
      prompt: { type: 'string', required: true },
      image: { type: 'string', description: 'Reference image' },
      aspect_ratio: { type: 'string', default: '16:9' },
    },
    description: 'ByteDance SeaDance 1 Pro - Studio-grade 1080P video generation.',
    testStatus: 'NOT_TESTED',
  },
  'google/veo-3': {
    id: 'google/veo-3',
    owner: 'google',
    name: 'veo-3',
    displayName: 'Google Veo 3',
    provider: 'Replicate',
    category: 'Video Generation',
    task: 'text-to-video',
    resolution: '1080p',
    maxSeconds: 5,
    defaultSeconds: 5,
    aspectRatios: ['16:9', '9:16'],
    enabled: true,
    freeEligibility: 'FREE_ELIGIBILITY_UNKNOWN',
    pricing: 'Pay-as-you-go / Preview',
    spendingPolicy: 'strict_free_only',
    billingRequired: true,
    capabilities: {
      text: false,
      image_output: false,
      video_output: true,
      text_to_video: true,
      image_to_video: false,
      reference_image: false,
      resolution: '1080p',
    },
    inputSchema: {
      prompt: { type: 'string', required: true },
      aspect_ratio: { type: 'string', default: '16:9' },
    },
    description: 'Google Veo 3 - Advanced high-fidelity video generation.',
    testStatus: 'NOT_TESTED',
  },
});

function getEncryptionKey() {
  const secret = process.env.PHOTON_SECRET || process.env.PHOTON_ADMIN_PASSWORD || 'photon-replicate-master-seed-key';
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

function readEnvToken(env = process.env) {
  return String(env.REPLICATE_API_TOKEN || env.REPLICATE_API_KEY || '').trim() || null;
}

function maskToken(secret) {
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

function createReplicateConfig({ dir = process.cwd(), env = process.env, logger = console, now = Date.now } = {}) {
  const stateFile = path.join(dir, CONFIG_FILE);
  let config;

  function normalizeConfig(src) {
    const base = {
      version: CONFIG_VERSION,
      provider: 'Replicate',
      providerSlug: 'replicate',
      website: 'https://replicate.com/',
      documentation: 'https://replicate.com/docs/reference/http',
      enabled: true,
      spendingPolicy: 'strict_free_only',
      encryptedToken: null,
      maskedToken: null,
      tokenFingerprint: null,
      account: {
        username: null,
        name: null,
        type: null,
        hasBilling: null,
        freeAllowance: null,
        lastCheckedAt: null,
      },
      models: { ...CANDIDATE_REPLICATE_MODELS },
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
      lastTestResults: {},
      recentErrors: [],
      updatedAt: new Date(now()).toISOString(),
    };

    if (!src || typeof src !== 'object') return base;
    return {
      ...base,
      ...src,
      account: { ...base.account, ...(src.account || {}) },
      models: { ...base.models, ...(src.models || {}) },
      usage: { ...base.usage, ...(src.usage || {}) },
      recentErrors: Array.isArray(src.recentErrors) ? src.recentErrors.slice(0, MAX_RECENT_ERRORS) : [],
    };
  }

  function load() {
    try {
      if (fs.existsSync(stateFile)) {
        const raw = fs.readFileSync(stateFile, 'utf8');
        config = normalizeConfig(JSON.parse(raw));
        return;
      }
    } catch (err) {
      logger.warn?.(`Failed reading Replicate state file ${stateFile}:`, err.message);
    }

    config = normalizeConfig(null);

    // Sync from env if present
    const envToken = readEnvToken(env);
    if (envToken) {
      config.encryptedToken = encryptToken(envToken);
      config.maskedToken = maskToken(envToken);
      config.tokenFingerprint = fingerprint(envToken);
    }
  }

  function persist() {
    config.updatedAt = new Date(now()).toISOString();
    try {
      atomicWriteJson(stateFile, config);
    } catch (err) {
      logger.error?.(`Failed writing Replicate config file ${stateFile}:`, err.message);
    }
  }

  load();

  function isConfigured() {
    const envToken = readEnvToken(env);
    if (envToken) return true;
    return Boolean(config.encryptedToken && decryptToken(config.encryptedToken));
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

  function getToken() {
    const envToken = readEnvToken(env);
    if (envToken) return envToken;
    if (!config.encryptedToken) return null;
    return decryptToken(config.encryptedToken);
  }

  function setToken(plainToken) {
    const clean = String(plainToken || '').trim();
    if (clean) {
      config.encryptedToken = encryptToken(clean);
      config.maskedToken = maskToken(clean);
      config.tokenFingerprint = fingerprint(clean);
      env.REPLICATE_API_TOKEN = clean;
      process.env.REPLICATE_API_TOKEN = clean;
    } else {
      config.encryptedToken = null;
      config.maskedToken = null;
      config.tokenFingerprint = null;
      delete env.REPLICATE_API_TOKEN;
      delete process.env.REPLICATE_API_TOKEN;
    }
    persist();
  }

  function getMaskedToken() {
    const t = getToken();
    return t ? maskToken(t) : null;
  }

  function setAccountInfo(accountData) {
    if (accountData && typeof accountData === 'object') {
      config.account = {
        ...config.account,
        ...accountData,
        lastCheckedAt: new Date(now()).toISOString(),
      };
      persist();
    }
  }

  function getAccountInfo() {
    return { ...config.account };
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
    const hasToken = isConfigured();
    const masked = getMaskedToken();
    const models = getModels();
    const videoModels = models.filter(m => m.category === 'Video Generation');
    const freeModels = models.filter(m => m.freeEligibility === 'FREE_VERIFIED' || m.freeEligibility === 'FREE_PROMOTION');
    const trialModels = models.filter(m => m.freeEligibility === 'TRIAL_ONLY');
    const blockedPaidModels = models.filter(m => m.freeEligibility === 'PAID_ONLY' || m.freeEligibility === 'FREE_ELIGIBILITY_UNKNOWN');

    return {
      provider: 'Replicate',
      providerSlug: 'replicate',
      website: config.website,
      documentation: config.documentation,
      configured: hasToken,
      enabled: isEnabled(),
      maskedToken: masked,
      hasToken,
      spendingPolicy: getSpendingPolicy(),
      spendingPolicyDescription: getSpendingPolicy() === 'strict_free_only'
        ? 'Strict Free-Only (Paid models and unverified paid compute strictly blocked).'
        : (getSpendingPolicy() === 'allow_all' ? 'All tiers allowed' : 'Blocked'),
      account: config.account,
      modelsCount: models.length,
      videoModelsCount: videoModels.length,
      freeModelsCount: freeModels.length,
      trialModelsCount: trialModels.length,
      blockedPaidCount: blockedPaidModels.length,
      models,
      usage: config.usage,
      lastTestResults: config.lastTestResults,
      recentErrors: config.recentErrors,
    };
  }

  return {
    isConfigured,
    isEnabled,
    setEnabled,
    getSpendingPolicy,
    setSpendingPolicy,
    getToken,
    setToken,
    getMaskedToken,
    setAccountInfo,
    getAccountInfo,
    getModels,
    getModel,
    setModelEnabled,
    registerModel,
    updateModel,
    recordUsage,
    recordError,
    setLastTestResult,
    status,
    CANDIDATE_REPLICATE_MODELS,
  };
}

module.exports = {
  createReplicateConfig,
  CANDIDATE_REPLICATE_MODELS,
  maskToken,
};
