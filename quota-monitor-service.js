'use strict';
// Centralized Automatic API Quota Monitoring & Provider/Model Visibility Service for PHOTON AI.
//
// Key capabilities:
// 1. Automatic quota detection & differentiation:
//    - RATE_LIMITED (temporary RPM/TPM, Retry-After)
//    - QUOTA_EXHAUSTED (daily/monthly limits reached, RPD/TPD)
//    - INSUFFICIENT_CREDITS (0 balance / payment required)
//    - INVALID_KEY (401 invalid key)
//    - PERMISSION_DENIED (403 forbidden)
//    - TEMPORARILY_UNAVAILABLE (5xx provider error / outage)
//    - DISABLED (disabled by admin)
//    - HEALTHY (ready for traffic)
// 2. Granular tracking:
//    - Per-model rate limits vs per-provider exhaustion.
//    - Multi-key awareness (slot tracking): healthy keys keep provider alive even if one key is exhausted.
// 3. Automatic restoration:
//    - Background scheduler monitors resetAt timestamps and daily reset schedules (UTC/Pacific).
//    - Automatically restores HEALTHY status when reset time arrives without admin intervention or full app reload.
// 4. Strict spending protection:
//    - Never executes paid generation calls for health checks.
//    - Zero automatic paid fallback or automatic credit purchases.

const fs = require('node:fs');
const path = require('node:path');

const STATUS_HEALTHY = 'HEALTHY';
const STATUS_RATE_LIMITED = 'RATE_LIMITED';
const STATUS_QUOTA_EXHAUSTED = 'QUOTA_EXHAUSTED';
const STATUS_INSUFFICIENT_CREDITS = 'INSUFFICIENT_CREDITS';
const STATUS_INVALID_KEY = 'INVALID_KEY';
const STATUS_PERMISSION_DENIED = 'PERMISSION_DENIED';
const STATUS_TEMPORARILY_UNAVAILABLE = 'TEMPORARILY_UNAVAILABLE';
const STATUS_DISABLED = 'DISABLED';
const STATUS_UNKNOWN = 'UNKNOWN';

const ALL_STATUSES = Object.freeze([
  STATUS_HEALTHY,
  STATUS_RATE_LIMITED,
  STATUS_QUOTA_EXHAUSTED,
  STATUS_INSUFFICIENT_CREDITS,
  STATUS_INVALID_KEY,
  STATUS_PERMISSION_DENIED,
  STATUS_TEMPORARILY_UNAVAILABLE,
  STATUS_DISABLED,
  STATUS_UNKNOWN,
]);

// Calculates the next occurrence of a specific UTC hour (e.g. 0 for midnight UTC, 8 for 08:00 UTC / midnight Pacific)
function getNextUtcHourTimestamp(targetHourUtc = 0) {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    targetHourUtc,
    0,
    0,
    0
  ));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime();
}

// Parses Retry-After header (seconds or HTTP date) to milliseconds
function parseRetryAfterHeader(val) {
  if (!val) return 0;
  const num = Number(val);
  if (Number.isFinite(num) && num > 0) {
    return Math.min(num * 1000, 24 * 3600 * 1000);
  }
  const dateMs = Date.parse(val);
  if (Number.isFinite(dateMs) && dateMs > Date.now()) {
    return Math.min(dateMs - Date.now(), 24 * 3600 * 1000);
  }
  return 0;
}

// Parses string durations like "12h4m30s", "45s", "2.5s", "10m"
function parseDurationToMs(str) {
  if (!str) return 0;
  const s = String(str).trim();
  let totalMs = 0;
  const hMatch = /(\d+(?:\.\d+)?)\s*h/i.exec(s);
  const mMatch = /(\d+(?:\.\d+)?)\s*m(?!s)/i.exec(s);
  const sMatch = /(\d+(?:\.\d+)?)\s*s/i.exec(s);
  const msMatch = /(\d+(?:\.\d+)?)\s*ms/i.exec(s);

  if (hMatch) totalMs += parseFloat(hMatch[1]) * 3600 * 1000;
  if (mMatch) totalMs += parseFloat(mMatch[1]) * 60 * 1000;
  if (sMatch) totalMs += parseFloat(sMatch[1]) * 1000;
  if (msMatch) totalMs += parseFloat(msMatch[1]);

  if (!totalMs) {
    const rawNum = parseFloat(s);
    if (Number.isFinite(rawNum) && rawNum > 0) totalMs = rawNum * 1000;
  }
  return Math.max(0, Math.min(totalMs, 30 * 24 * 3600 * 1000));
}

function normalizeProviderName(name) {
  const s = String(name || '').toLowerCase().trim();
  if (s.includes('openrouter')) return 'openrouter';
  if (s.includes('gemini') || s.includes('google')) return 'gemini';
  if (s.includes('groq')) return 'groq';
  if (s.includes('nvidia')) return 'nvidia';
  if (s.includes('cloudflare')) return 'cloudflare';
  if (s.includes('cohere')) return 'cohere';
  if (s.includes('openai')) return 'openai';
  if (s.includes('anthropic') || s.includes('claude')) return 'anthropic';
  if (s.includes('codecraft')) return 'codecraft';
  if (s.includes('llmtr')) return 'llmtr';
  if (s.includes('ollama')) return 'ollama';
  return s || 'unknown';
}

function displayProviderName(norm) {
  switch (norm) {
    case 'openrouter': return 'OpenRouter';
    case 'gemini': return 'Google Gemini';
    case 'groq': return 'Groq';
    case 'nvidia': return 'NVIDIA NIM';
    case 'cloudflare': return 'Cloudflare Workers AI';
    case 'cohere': return 'Cohere';
    case 'openai': return 'OpenAI';
    case 'anthropic': return 'Anthropic';
    case 'codecraft': return 'CodeCraft';
    case 'llmtr': return 'LLMTR';
    case 'ollama': return 'Ollama';
    default: return norm.charAt(0).toUpperCase() + norm.slice(1);
  }
}

// ---------------------------------------------------------------------------
// Provider-Specific Quota Error Adapters
// ---------------------------------------------------------------------------

class BaseQuotaAdapter {
  constructor(providerId) {
    this.providerId = providerId;
  }

  // Analyzes error status, headers and body to categorize quota state
  classifyError({ status, code, message = '', headers = {}, modelId, keySlot } = {}) {
    const s = Number(status) || 0;
    const msg = String(message || '').toLowerCase();
    const c = String(code || '').toLowerCase();

    if (s === 401 || /invalid.*api.*key|unauthorized|api key not valid|invalid.*token/i.test(msg)) {
      return {
        status: STATUS_INVALID_KEY,
        scope: 'key',
        reason: 'API key is invalid or revoked.',
        resetAt: null,
      };
    }

    if (s === 403 || /forbidden|permission_denied/i.test(msg)) {
      return {
        status: STATUS_PERMISSION_DENIED,
        scope: 'key',
        reason: 'Permission denied for this key or model.',
        resetAt: null,
      };
    }

    if (s === 402 || /insufficient.*credit|zero.*balance|billing.*required|prepayment/i.test(msg)) {
      return {
        status: STATUS_INSUFFICIENT_CREDITS,
        scope: 'provider',
        reason: 'Account balance or credits exhausted. Top-up required.',
        resetAt: null,
      };
    }

    if (s === 429 || /rate.*limit|quota|too many requests|resource_exhausted/i.test(msg)) {
      // Determine if it's daily quota exhaustion vs temporary RPM/TPM rate limit
      const retryAfterSec = parseRetryAfterHeader(headers['retry-after'] || headers['Retry-After']);
      if (/day|daily|per-day|quota.*exceeded|monthly/i.test(msg)) {
        return {
          status: STATUS_QUOTA_EXHAUSTED,
          scope: modelId ? 'model' : 'provider',
          reason: 'Daily free allocation or quota exhausted.',
          resetAt: this.calculateDailyResetTimestamp(headers),
        };
      }

      // Temporary rate limit (RPM/TPM)
      const durationMs = retryAfterSec ? retryAfterSec : 60000;
      return {
        status: STATUS_RATE_LIMITED,
        scope: modelId ? 'model' : 'provider',
        reason: 'Temporary rate limit reached (requests or tokens per minute).',
        resetAt: Date.now() + durationMs,
      };
    }

    if (s >= 500 && s < 600) {
      return {
        status: STATUS_TEMPORARILY_UNAVAILABLE,
        scope: 'provider',
        reason: `Provider server returned HTTP ${s}. Temporary outage.`,
        resetAt: Date.now() + 30000,
      };
    }

    return {
      status: STATUS_UNKNOWN,
      scope: 'model',
      reason: message || 'Unknown provider error occurred.',
      resetAt: null,
    };
  }

  calculateDailyResetTimestamp(headers = {}) {
    // Default daily reset is midnight UTC
    return getNextUtcHourTimestamp(0);
  }
}

class OpenRouterQuotaAdapter extends BaseQuotaAdapter {
  constructor() { super('openrouter'); }

  classifyError(opts = {}) {
    const { status, message = '', headers = {} } = opts;
    const msg = String(message).toLowerCase();
    if (status === 402 || msg.includes('credit') || msg.includes('balance') || msg.includes('insufficient')) {
      return {
        status: STATUS_INSUFFICIENT_CREDITS,
        scope: 'provider',
        reason: 'OpenRouter credit balance exhausted. Add credits to restore.',
        resetAt: null,
      };
    }
    if (status === 429) {
      const retryAfter = parseRetryAfterHeader(headers['retry-after']);
      const resetHeader = headers['x-ratelimit-reset'];
      let resetAt = null;
      if (retryAfter > 0) resetAt = Date.now() + retryAfter;
      else if (resetHeader) {
        const ms = parseDurationToMs(resetHeader);
        if (ms > 0) resetAt = Date.now() + ms;
      }
      return {
        status: STATUS_RATE_LIMITED,
        scope: opts.modelId ? 'model' : 'provider',
        reason: 'OpenRouter free-tier rate limit reached. Resets shortly.',
        resetAt: resetAt || (Date.now() + 60000),
      };
    }
    return super.classifyError(opts);
  }
}

class GeminiQuotaAdapter extends BaseQuotaAdapter {
  constructor() { super('gemini'); }

  calculateDailyResetTimestamp() {
    // Google Gemini Free Tier resets at midnight US Pacific Time (08:00 UTC)
    return getNextUtcHourTimestamp(8);
  }

  classifyError(opts = {}) {
    const { status, message = '', headers = {} } = opts;
    const msg = String(message).toLowerCase();

    if (status === 429 || msg.includes('resource_exhausted')) {
      if (msg.includes('per day') || msg.includes('rpd') || msg.includes('daily')) {
        return {
          status: STATUS_QUOTA_EXHAUSTED,
          scope: 'model',
          reason: 'Gemini free tier daily request quota exhausted. Resets at midnight Pacific Time.',
          resetAt: this.calculateDailyResetTimestamp(),
        };
      }
      // Per minute rate limit
      const retryAfter = parseRetryAfterHeader(headers['retry-after']);
      return {
        status: STATUS_RATE_LIMITED,
        scope: 'model',
        reason: 'Gemini requests-per-minute (RPM) limit reached.',
        resetAt: Date.now() + (retryAfter || 60000),
      };
    }
    return super.classifyError(opts);
  }
}

class GroqQuotaAdapter extends BaseQuotaAdapter {
  constructor() { super('groq'); }

  classifyError(opts = {}) {
    const { status, message = '', headers = {} } = opts;
    const msg = String(message).toLowerCase();

    if (status === 429) {
      const isDailyTokens = msg.includes('tokens per day') || msg.includes('tpd');
      const isDailyRequests = msg.includes('requests per day') || msg.includes('rpd');
      const resetTokens = headers['x-ratelimit-reset-tokens'];
      const resetRequests = headers['x-ratelimit-reset-requests'];
      const retryAfter = parseRetryAfterHeader(headers['retry-after']);

      if (isDailyTokens || isDailyRequests) {
        const durationStr = isDailyTokens ? resetTokens : resetRequests;
        const ms = parseDurationToMs(durationStr);
        return {
          status: STATUS_QUOTA_EXHAUSTED,
          scope: opts.modelId ? 'model' : 'provider',
          reason: `Groq daily ${isDailyTokens ? 'token' : 'request'} quota exhausted.`,
          resetAt: ms > 0 ? Date.now() + ms : getNextUtcHourTimestamp(0),
        };
      }

      // Per-minute limits (TPM / RPM)
      const durationStr = resetTokens || resetRequests;
      const ms = parseDurationToMs(durationStr);
      return {
        status: STATUS_RATE_LIMITED,
        scope: opts.modelId ? 'model' : 'provider',
        reason: 'Groq per-minute rate limit reached (RPM/TPM).',
        resetAt: Date.now() + (retryAfter || ms || 30000),
      };
    }
    return super.classifyError(opts);
  }
}

class CloudflareQuotaAdapter extends BaseQuotaAdapter {
  constructor() { super('cloudflare'); }

  calculateDailyResetTimestamp() {
    // Cloudflare Workers AI free tier resets at 00:00:00 UTC
    return getNextUtcHourTimestamp(0);
  }

  classifyError(opts = {}) {
    const { status, message = '' } = opts;
    const msg = String(message).toLowerCase();

    if (status === 402 || msg.includes('neuron') || msg.includes('quota_exhausted') || msg.includes('daily free neuron allocation')) {
      return {
        status: STATUS_QUOTA_EXHAUSTED,
        scope: 'provider',
        reason: 'Cloudflare Workers AI daily free allocation (10,000 Neurons) exhausted. Resets at 00:00 UTC.',
        resetAt: this.calculateDailyResetTimestamp(),
      };
    }
    return super.classifyError(opts);
  }
}

class CohereQuotaAdapter extends BaseQuotaAdapter {
  constructor() { super('cohere'); }

  classifyError(opts = {}) {
    const { status, message = '', headers = {} } = opts;
    const msg = String(message).toLowerCase();

    if (status === 429) {
      const retryAfter = parseRetryAfterHeader(headers['retry-after']);
      return {
        status: STATUS_RATE_LIMITED,
        scope: 'model',
        reason: 'Cohere trial rate limit reached. Resets in 60 seconds.',
        resetAt: Date.now() + (retryAfter || 60000),
      };
    }
    return super.classifyError(opts);
  }
}

class NvidiaQuotaAdapter extends BaseQuotaAdapter {
  constructor() { super('nvidia'); }

  classifyError(opts = {}) {
    const { status, message = '', headers = {} } = opts;
    if (status === 429) {
      const retryAfter = parseRetryAfterHeader(headers['retry-after']);
      return {
        status: STATUS_RATE_LIMITED,
        scope: opts.modelId ? 'model' : 'provider',
        reason: 'NVIDIA NIM rate limit reached.',
        resetAt: Date.now() + (retryAfter || 60000),
      };
    }
    return super.classifyError(opts);
  }
}

// ---------------------------------------------------------------------------
// Central Quota Monitor Service
// ---------------------------------------------------------------------------

function createQuotaMonitorService({ dir = process.cwd(), logger = console } = {}) {
  const adapters = {
    openrouter: new OpenRouterQuotaAdapter(),
    gemini: new GeminiQuotaAdapter(),
    groq: new GroqQuotaAdapter(),
    nvidia: new NvidiaQuotaAdapter(),
    cloudflare: new CloudflareQuotaAdapter(),
    cohere: new CohereQuotaAdapter(),
    default: new BaseQuotaAdapter('default'),
  };

  // State maps
  // providers[norm] = { status, errorReason, resetAt, lastSuccessAt, lastFailureAt, lastCheckedAt, keys: { [keySlot]: ... }, models: { [modelId]: ... } }
  const providers = {};
  let monitorInterval = null;
  let isChecking = false;

  function getAdapter(providerName) {
    const norm = normalizeProviderName(providerName);
    return adapters[norm] || adapters.default;
  }

  function ensureProviderState(providerName) {
    const norm = normalizeProviderName(providerName);
    if (!providers[norm]) {
      providers[norm] = {
        providerId: norm,
        providerName: displayProviderName(norm),
        status: STATUS_HEALTHY,
        errorReason: null,
        resetAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastCheckedAt: new Date().toISOString(),
        keys: {},
        models: {},
      };
    }
    return providers[norm];
  }

  function ensureModelState(providerName, modelId) {
    const p = ensureProviderState(providerName);
    const mid = String(modelId || '').trim();
    if (!mid) return null;
    const isNew = !p.models[mid];
    if (isNew) {
      p.models[mid] = {
        modelId: mid,
        status: STATUS_HEALTHY,
        errorReason: null,
        resetAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
      };
      recomputeProviderOverallStatus(providerName);
    }
    return p.models[mid];
  }

  function ensureKeyState(providerName, keySlot = 'default') {
    const p = ensureProviderState(providerName);
    const slot = String(keySlot || 'default');
    if (!p.keys[slot]) {
      p.keys[slot] = {
        keySlot: slot,
        status: STATUS_HEALTHY,
        errorReason: null,
        resetAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
      };
    }
    return p.keys[slot];
  }

  // Records a failed API request and updates quota status accordingly
  function recordError({ providerName, modelId, keySlot = 'default', status, code, message, headers = {} } = {}) {
    const norm = normalizeProviderName(providerName);
    const p = ensureProviderState(norm);
    const adapter = getAdapter(norm);
    const classified = adapter.classifyError({ status, code, message, headers, modelId, keySlot });
    const nowIso = new Date().toISOString();

    p.lastFailureAt = nowIso;
    p.lastCheckedAt = nowIso;

    // Model-level tracking
    if (modelId) {
      const m = ensureModelState(norm, modelId);
      if (m) {
        m.status = classified.status;
        m.errorReason = classified.reason;
        m.resetAt = classified.resetAt ? new Date(classified.resetAt).toISOString() : null;
        m.lastFailureAt = nowIso;
      }
    }

    // Key-level tracking
    if (keySlot) {
      const k = ensureKeyState(norm, keySlot);
      if (k) {
        k.status = classified.status;
        k.errorReason = classified.reason;
        k.resetAt = classified.resetAt ? new Date(classified.resetAt).toISOString() : null;
        k.lastFailureAt = nowIso;
      }
    }

    // Determine overall provider status:
    // If scope is 'provider' or if it's an account-level event (insufficient credits, account quota)
    if (classified.scope === 'provider' || classified.status === STATUS_INSUFFICIENT_CREDITS || (!modelId && classified.status === STATUS_QUOTA_EXHAUSTED)) {
      p.status = classified.status;
      p.errorReason = classified.reason;
      p.resetAt = classified.resetAt ? new Date(classified.resetAt).toISOString() : null;
    } else {
      recomputeProviderOverallStatus(norm);
    }

    logger.warn(`[QuotaMonitor] ${p.providerName}${modelId ? ' (' + modelId + ')' : ''} marked as ${classified.status}: ${classified.reason}${classified.resetAt ? ' (resets at ' + new Date(classified.resetAt).toISOString() + ')' : ''}`);
    return classified;
  }

  // Records a successful API request and clears transient rate limits if safe
  function recordSuccess({ providerName, modelId, keySlot = 'default', usage = {} } = {}) {
    const norm = normalizeProviderName(providerName);
    const p = ensureProviderState(norm);
    const nowIso = new Date().toISOString();

    p.lastSuccessAt = nowIso;
    p.lastCheckedAt = nowIso;

    if (p.status === STATUS_RATE_LIMITED || p.status === STATUS_TEMPORARILY_UNAVAILABLE) {
      p.status = STATUS_HEALTHY;
      p.errorReason = null;
      p.resetAt = null;
    }

    if (modelId) {
      const m = ensureModelState(norm, modelId);
      if (m && (m.status === STATUS_RATE_LIMITED || m.status === STATUS_TEMPORARILY_UNAVAILABLE)) {
        m.status = STATUS_HEALTHY;
        m.errorReason = null;
        m.resetAt = null;
      }
      if (m) m.lastSuccessAt = nowIso;
    }

    if (keySlot) {
      const k = ensureKeyState(norm, keySlot);
      if (k && (k.status === STATUS_RATE_LIMITED || k.status === STATUS_TEMPORARILY_UNAVAILABLE)) {
        k.status = STATUS_HEALTHY;
        k.errorReason = null;
        k.resetAt = null;
      }
      if (k) k.lastSuccessAt = nowIso;
    }

    recomputeProviderOverallStatus(norm);
  }

  function recomputeProviderOverallStatus(norm) {
    const p = ensureProviderState(norm);
    const keyList = Object.values(p.keys);
    const modelList = Object.values(p.models);

    // If there are tracked keys and ANY key is healthy, the provider has healthy capacity!
    if (keyList.length > 0) {
      const hasHealthyKey = keyList.some(k => k.status === STATUS_HEALTHY);
      if (hasHealthyKey) {
        p.status = STATUS_HEALTHY;
        p.errorReason = null;
        p.resetAt = null;
        return;
      }
      const worst = keyList[0];
      p.status = worst.status;
      p.errorReason = worst.errorReason;
      p.resetAt = worst.resetAt;
      return;
    }

    // If models are tracked:
    if (modelList.length > 0) {
      const anyHealthy = modelList.some(m => m.status === STATUS_HEALTHY);
      if (anyHealthy) {
        p.status = STATUS_HEALTHY;
        p.errorReason = null;
        p.resetAt = null;
        return;
      }
      const allExhausted = modelList.every(m => m.status === STATUS_QUOTA_EXHAUSTED || m.status === STATUS_INSUFFICIENT_CREDITS || m.status === STATUS_RATE_LIMITED);
      if (allExhausted && modelList.length > 1) {
        p.status = modelList[0].status;
        p.errorReason = modelList[0].errorReason;
        p.resetAt = modelList[0].resetAt;
      }
    }
  }

  // Model-level availability check
  function getModelAvailability(providerName, modelId) {
    const norm = normalizeProviderName(providerName);
    const p = ensureProviderState(norm);
    const mid = String(modelId || '').trim();

    // If provider is completely out of credits or invalid key or disabled:
    if (p.status === STATUS_DISABLED || p.status === STATUS_INVALID_KEY || p.status === STATUS_INSUFFICIENT_CREDITS) {
      return {
        available: false,
        status: p.status,
        reason: p.errorReason || `${p.providerName} is unavailable.`,
        resetAt: p.resetAt,
      };
    }

    // Check specific model status
    if (mid) {
      const m = p.models[mid];
      if (m && m.status !== STATUS_HEALTHY) {
        if (m.resetAt && Date.now() >= Date.parse(m.resetAt)) {
          m.status = STATUS_HEALTHY;
          m.errorReason = null;
          m.resetAt = null;
        } else {
          return {
            available: false,
            status: m.status,
            reason: m.errorReason || `Model ${mid} is currently ${m.status.toLowerCase().replace(/_/g, ' ')}.`,
            resetAt: m.resetAt,
          };
        }
      }
    }

    // If provider-level quota is exhausted (all models share a single quota pool, e.g. Cloudflare daily neurons)
    if (p.status === STATUS_QUOTA_EXHAUSTED) {
      if (p.resetAt && Date.now() >= Date.parse(p.resetAt)) {
        p.status = STATUS_HEALTHY;
        p.errorReason = null;
        p.resetAt = null;
      } else {
        return {
          available: false,
          status: p.status,
          reason: p.errorReason || `${p.providerName} daily quota exhausted.`,
          resetAt: p.resetAt,
        };
      }
    }

    return {
      available: true,
      status: STATUS_HEALTHY,
      reason: '',
      resetAt: null,
    };
  }

  // Provider-level availability check
  function getProviderAvailability(providerName) {
    const norm = normalizeProviderName(providerName);
    const p = ensureProviderState(norm);

    // If provider is explicitly disabled or invalid key or zero credits
    if (p.status === STATUS_DISABLED || p.status === STATUS_INVALID_KEY || p.status === STATUS_INSUFFICIENT_CREDITS) {
      return {
        available: false,
        status: p.status,
        reason: p.errorReason || `${p.providerName} is unavailable.`,
        resetAt: p.resetAt,
      };
    }

    // Provider-level quota exhaustion (e.g. Cloudflare daily neurons or provider-wide limit)
    if (p.status === STATUS_QUOTA_EXHAUSTED) {
      if (p.resetAt && Date.now() >= Date.parse(p.resetAt)) {
        p.status = STATUS_HEALTHY;
        p.errorReason = null;
        p.resetAt = null;
      } else {
        // If there are tracked models and at least one is explicitly HEALTHY, provider is still available for that model
        const modelList = Object.values(p.models);
        const hasHealthyModel = modelList.length > 1 && modelList.some(m => m.status === STATUS_HEALTHY);
        if (!hasHealthyModel) {
          return {
            available: false,
            status: p.status,
            reason: p.errorReason || `${p.providerName} quota exhausted.`,
            resetAt: p.resetAt,
          };
        }
      }
    }

    return {
      available: true,
      status: STATUS_HEALTHY,
      reason: '',
      resetAt: null,
    };
  }

  // Throws or returns error if a direct request to this model is blocked by quota
  function assertModelRequestAllowed(providerName, modelId) {
    const check = getModelAvailability(providerName, modelId);
    if (!check.available) {
      const resetMsg = check.resetAt ? ` Resets at ${new Date(check.resetAt).toLocaleTimeString()} UTC.` : '';
      const err = new Error(`${check.reason}${resetMsg}`);
      err.code = check.status.toLowerCase();
      err.status = check.status === STATUS_RATE_LIMITED ? 429 : 402;
      err.resetAt = check.resetAt;
      throw err;
    }
  }

  // Periodic background quota and reset evaluator
  function checkAndRestoreAll() {
    if (isChecking) return;
    isChecking = true;
    try {
      const nowMs = Date.now();
      for (const p of Object.values(providers)) {
        // Check provider-level resetAt
        if (p.resetAt && nowMs >= Date.parse(p.resetAt)) {
          p.status = STATUS_HEALTHY;
          p.errorReason = null;
          p.resetAt = null;
          logger.info(`[QuotaMonitor] Restored provider ${p.providerName} to HEALTHY after resetAt passed.`);
        }

        // Check key-level resetAt
        for (const k of Object.values(p.keys)) {
          if (k.resetAt && nowMs >= Date.parse(k.resetAt)) {
            k.status = STATUS_HEALTHY;
            k.errorReason = null;
            k.resetAt = null;
            logger.info(`[QuotaMonitor] Restored key ${k.keySlot} (${p.providerName}) to HEALTHY.`);
          }
        }

        // Check model-level resetAt
        for (const m of Object.values(p.models)) {
          if (m.resetAt && nowMs >= Date.parse(m.resetAt)) {
            m.status = STATUS_HEALTHY;
            m.errorReason = null;
            m.resetAt = null;
            logger.info(`[QuotaMonitor] Restored model ${m.modelId} (${p.providerName}) to HEALTHY.`);
          }
        }

        recomputeProviderOverallStatus(p.providerId);
      }
    } finally {
      isChecking = false;
    }
  }

  function startBackgroundMonitoring(intervalMs = 30000) {
    if (monitorInterval) clearInterval(monitorInterval);
    monitorInterval = setInterval(checkAndRestoreAll, intervalMs);
    if (typeof monitorInterval.unref === 'function') monitorInterval.unref();
  }

  function stopBackgroundMonitoring() {
    if (monitorInterval) {
      clearInterval(monitorInterval);
      monitorInterval = null;
    }
  }

  // Full status report for Admin Dashboard
  function getStatusSnapshot() {
    checkAndRestoreAll();
    const result = {
      timestamp: new Date().toISOString(),
      providers: {},
    };

    for (const [id, p] of Object.entries(providers)) {
      result.providers[id] = {
        id,
        name: p.providerName,
        status: p.status,
        errorReason: p.errorReason,
        resetAt: p.resetAt,
        lastSuccessAt: p.lastSuccessAt,
        lastFailureAt: p.lastFailureAt,
        lastCheckedAt: p.lastCheckedAt,
        keys: Object.values(p.keys).map(k => ({
          slot: k.keySlot,
          status: k.status,
          errorReason: k.errorReason,
          resetAt: k.resetAt,
        })),
        models: Object.values(p.models).map(m => ({
          id: m.modelId,
          status: m.status,
          errorReason: m.errorReason,
          resetAt: m.resetAt,
        })),
      };
    }
    return result;
  }

  // Simulation method for testing without consuming credits
  function simulateQuotaEvent({ providerName, modelId, keySlot, status, errorReason, resetInMs } = {}) {
    const norm = normalizeProviderName(providerName);
    const p = ensureProviderState(norm);
    const resetAt = resetInMs ? new Date(Date.now() + resetInMs).toISOString() : null;

    if (modelId) {
      const m = ensureModelState(norm, modelId);
      if (m) {
        m.status = status || STATUS_QUOTA_EXHAUSTED;
        m.errorReason = errorReason || 'Simulated model quota exhaustion';
        m.resetAt = resetAt;
      }
    }

    if (keySlot) {
      const k = ensureKeyState(norm, keySlot);
      if (k) {
        k.status = status || STATUS_QUOTA_EXHAUSTED;
        k.errorReason = errorReason || 'Simulated key quota exhaustion';
        k.resetAt = resetAt;
      }
    }

    if (!modelId && !keySlot) {
      p.status = status || STATUS_QUOTA_EXHAUSTED;
      p.errorReason = errorReason || 'Simulated provider quota exhaustion';
      p.resetAt = resetAt;
    } else {
      recomputeProviderOverallStatus(norm);
    }
  }

  function resetAllToHealthy() {
    for (const p of Object.values(providers)) {
      p.status = STATUS_HEALTHY;
      p.errorReason = null;
      p.resetAt = null;
      for (const k of Object.values(p.keys)) {
        k.status = STATUS_HEALTHY;
        k.errorReason = null;
        k.resetAt = null;
      }
      for (const m of Object.values(p.models)) {
        m.status = STATUS_HEALTHY;
        m.errorReason = null;
        m.resetAt = null;
      }
    }
  }

  return {
    STATUS_HEALTHY,
    STATUS_RATE_LIMITED,
    STATUS_QUOTA_EXHAUSTED,
    STATUS_INSUFFICIENT_CREDITS,
    STATUS_INVALID_KEY,
    STATUS_PERMISSION_DENIED,
    STATUS_TEMPORARILY_UNAVAILABLE,
    STATUS_DISABLED,
    STATUS_UNKNOWN,
    ALL_STATUSES,
    recordError,
    recordSuccess,
    getModelAvailability,
    getProviderAvailability,
    assertModelRequestAllowed,
    checkAndRestoreAll,
    startBackgroundMonitoring,
    stopBackgroundMonitoring,
    getStatusSnapshot,
    simulateQuotaEvent,
    resetAllToHealthy,
  };
}

module.exports = {
  STATUS_HEALTHY,
  STATUS_RATE_LIMITED,
  STATUS_QUOTA_EXHAUSTED,
  STATUS_INSUFFICIENT_CREDITS,
  STATUS_INVALID_KEY,
  STATUS_PERMISSION_DENIED,
  STATUS_TEMPORARILY_UNAVAILABLE,
  STATUS_DISABLED,
  STATUS_UNKNOWN,
  ALL_STATUSES,
  createQuotaMonitorService,
  parseRetryAfterHeader,
  parseDurationToMs,
  getNextUtcHourTimestamp,
};
