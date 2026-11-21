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
//    - ADMIN_DISABLED (disabled by admin)
//    - UNKNOWN (unclassified failure)
//    - HEALTHY (ready for traffic)
// 2. Comprehensive provider adapters covering EVERY integrated provider:
//    - OpenRouter, Gemini, Groq, NVIDIA NIM, Cloudflare Workers AI, Cohere,
//      Stability AI, Pollinations AI, OpenAI, Anthropic, CodeCraft, LLMTR, Ollama,
//      and BaseQuotaAdapter for all future providers.
// 3. Granular multi-key & shared-account tracking:
//    - Multi-key awareness: healthy keys keep provider visible even if one key is exhausted.
//    - Shared account quotas: if shared account quota exhausts, hides the provider globally.
//    - Never rotates keys to bypass rate limits; never assumes multiple keys create extra account quota.
// 4. Automatic restoration without reload or logout:
//    - Background scheduler monitors resetAt timestamps and daily reset schedules (UTC / Pacific).
//    - Automatically restores HEALTHY status when reset time arrives.
// 5. Strict spending protection:
//    - Never executes paid generation calls for health checks.
//    - Zero automatic paid fallback or credit purchases.
// 6. Strict accounting separation:
//    - PHOTON customer tokens are strictly separated from provider quotas.
//    - Customer token availability does not override provider quota state, and provider exhaustion never touches customer balance.

const fs = require('node:fs');
const path = require('node:path');

const STATUS_HEALTHY = 'HEALTHY';
const STATUS_RATE_LIMITED = 'RATE_LIMITED';
const STATUS_QUOTA_EXHAUSTED = 'QUOTA_EXHAUSTED';
const STATUS_INSUFFICIENT_CREDITS = 'INSUFFICIENT_CREDITS';
const STATUS_INVALID_KEY = 'INVALID_KEY';
const STATUS_PERMISSION_DENIED = 'PERMISSION_DENIED';
const STATUS_TEMPORARILY_UNAVAILABLE = 'TEMPORARILY_UNAVAILABLE';
const STATUS_ADMIN_DISABLED = 'ADMIN_DISABLED';
const STATUS_DISABLED = STATUS_ADMIN_DISABLED; // Backward compatibility alias
const STATUS_UNKNOWN = 'UNKNOWN';

const ALL_STATUSES = Object.freeze([
  STATUS_HEALTHY,
  STATUS_RATE_LIMITED,
  STATUS_QUOTA_EXHAUSTED,
  STATUS_INSUFFICIENT_CREDITS,
  STATUS_INVALID_KEY,
  STATUS_PERMISSION_DENIED,
  STATUS_TEMPORARILY_UNAVAILABLE,
  STATUS_ADMIN_DISABLED,
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
  if (s.includes('stability')) return 'stability';
  if (s.includes('pollinations')) return 'pollinations';
  if (s.includes('edenai') || s.includes('eden ai') || s.includes('eden')) return 'edenai';
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
    case 'stability': return 'Stability AI';
    case 'pollinations': return 'Pollinations AI';
    case 'edenai': return 'Eden AI';
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

  classifyError({ status, code, message = '', headers = {}, modelId, keySlot } = {}) {
    const s = Number(status) || 0;
    const msg = String(message || '').toLowerCase();
    const c = String(code || '').toLowerCase();

    if (s === 401 || /invalid.*api.*key|unauthorized|api key not valid|invalid.*token|authentication/i.test(msg)) {
      return {
        status: STATUS_INVALID_KEY,
        scope: 'key',
        reason: 'API key is invalid or revoked.',
        resetAt: null,
      };
    }

    if (s === 403 || /forbidden|permission_denied|access_denied|not_allowed/i.test(msg)) {
      return {
        status: STATUS_PERMISSION_DENIED,
        scope: 'key',
        reason: 'Permission denied for this key or model.',
        resetAt: null,
      };
    }

    if (s === 402 || /insufficient.*credit|zero.*balance|billing.*required|prepayment|out of credits|insufficient_quota/i.test(msg)) {
      return {
        status: STATUS_INSUFFICIENT_CREDITS,
        scope: 'provider',
        reason: 'Account balance or credits exhausted. Top-up required.',
        resetAt: null,
      };
    }

    if (s === 429 || /rate.*limit|quota|too many requests|resource_exhausted/i.test(msg)) {
      const retryAfterSec = parseRetryAfterHeader(headers['retry-after'] || headers['Retry-After']);
      if (/day|daily|per-day|quota.*exceeded|monthly|limit_reached/i.test(msg)) {
        return {
          status: STATUS_QUOTA_EXHAUSTED,
          scope: modelId ? 'model' : 'provider',
          reason: 'Daily free allocation or quota exhausted.',
          resetAt: this.calculateDailyResetTimestamp(headers),
        };
      }

      // Temporary rate limit (RPM/TPM)
      const durationMs = retryAfterSec > 0 ? retryAfterSec : 60000;
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
    return getNextUtcHourTimestamp(0);
  }

  // Probe method that costs ZERO paid credits (metadata or ping only)
  async probeFreeHealth({ fetchImpl = globalThis.fetch, apiKey, accountId, endpoint } = {}) {
    return { ok: true, status: STATUS_HEALTHY };
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

  async probeFreeHealth({ fetchImpl = globalThis.fetch, apiKey } = {}) {
    if (!apiKey) return { ok: false, status: STATUS_INVALID_KEY };
    try {
      const res = await fetchImpl('https://openrouter.ai/api/v1/auth/key', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 401) return { ok: false, status: STATUS_INVALID_KEY };
      if (res.status === 402) return { ok: false, status: STATUS_INSUFFICIENT_CREDITS };
      if (!res.ok) return { ok: false, status: STATUS_TEMPORARILY_UNAVAILABLE };
      const data = await res.json().catch(() => ({}));
      const limit = data?.data?.limit;
      const usage = data?.data?.usage || 0;
      if (limit != null && usage >= limit) {
        return { ok: false, status: STATUS_QUOTA_EXHAUSTED, reason: 'OpenRouter key spend limit reached.' };
      }
      return { ok: true, status: STATUS_HEALTHY };
    } catch {
      return { ok: false, status: STATUS_TEMPORARILY_UNAVAILABLE };
    }
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

  async probeFreeHealth({ fetchImpl = globalThis.fetch, apiKey } = {}) {
    if (!apiKey) return { ok: false, status: STATUS_INVALID_KEY };
    try {
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 400 || res.status === 401) return { ok: false, status: STATUS_INVALID_KEY };
      if (res.status === 429) return { ok: false, status: STATUS_RATE_LIMITED };
      return { ok: res.ok, status: res.ok ? STATUS_HEALTHY : STATUS_TEMPORARILY_UNAVAILABLE };
    } catch {
      return { ok: false, status: STATUS_TEMPORARILY_UNAVAILABLE };
    }
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

  async probeFreeHealth({ fetchImpl = globalThis.fetch, apiKey } = {}) {
    if (!apiKey) return { ok: false, status: STATUS_INVALID_KEY };
    try {
      const res = await fetchImpl('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 401) return { ok: false, status: STATUS_INVALID_KEY };
      if (res.status === 429) return { ok: false, status: STATUS_RATE_LIMITED };
      return { ok: res.ok, status: res.ok ? STATUS_HEALTHY : STATUS_TEMPORARILY_UNAVAILABLE };
    } catch {
      return { ok: false, status: STATUS_TEMPORARILY_UNAVAILABLE };
    }
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

  async probeFreeHealth({ fetchImpl = globalThis.fetch, accountId, apiToken } = {}) {
    if (!accountId || !apiToken) return { ok: false, status: STATUS_INVALID_KEY };
    try {
      const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search`, {
        headers: { 'Authorization': `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 401 || res.status === 403) return { ok: false, status: STATUS_INVALID_KEY };
      return { ok: res.ok, status: res.ok ? STATUS_HEALTHY : STATUS_TEMPORARILY_UNAVAILABLE };
    } catch {
      return { ok: false, status: STATUS_TEMPORARILY_UNAVAILABLE };
    }
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
        reason: 'Cohere trial rate limit reached (10 RPM). Resets in 60 seconds.',
        resetAt: Date.now() + (retryAfter || 60000),
      };
    }
    return super.classifyError(opts);
  }

  async probeFreeHealth({ fetchImpl = globalThis.fetch, apiKey } = {}) {
    if (!apiKey) return { ok: false, status: STATUS_INVALID_KEY };
    try {
      const res = await fetchImpl('https://api.cohere.com/v1/models?endpoint=chat', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 401) return { ok: false, status: STATUS_INVALID_KEY };
      if (res.status === 429) return { ok: false, status: STATUS_RATE_LIMITED };
      return { ok: res.ok, status: res.ok ? STATUS_HEALTHY : STATUS_TEMPORARILY_UNAVAILABLE };
    } catch {
      return { ok: false, status: STATUS_TEMPORARILY_UNAVAILABLE };
    }
  }
}

class NvidiaQuotaAdapter extends BaseQuotaAdapter {
  constructor() { super('nvidia'); }

  classifyError(opts = {}) {
    const { status, headers = {} } = opts;
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

  async probeFreeHealth({ fetchImpl = globalThis.fetch, apiKey } = {}) {
    if (!apiKey) return { ok: false, status: STATUS_INVALID_KEY };
    try {
      const res = await fetchImpl('https://integrate.api.nvidia.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 401) return { ok: false, status: STATUS_INVALID_KEY };
      if (res.status === 429) return { ok: false, status: STATUS_RATE_LIMITED };
      return { ok: res.ok, status: res.ok ? STATUS_HEALTHY : STATUS_TEMPORARILY_UNAVAILABLE };
    } catch {
      return { ok: false, status: STATUS_TEMPORARILY_UNAVAILABLE };
    }
  }
}

class StabilityAiQuotaAdapter extends BaseQuotaAdapter {
  constructor() { super('stability'); }

  classifyError(opts = {}) {
    const { status, message = '', headers = {} } = opts;
    const msg = String(message).toLowerCase();
    if (status === 402 || msg.includes('insufficient_balance') || msg.includes('credits') || msg.includes('zero balance')) {
      return {
        status: STATUS_INSUFFICIENT_CREDITS,
        scope: 'provider',
        reason: 'Stability AI credit balance exhausted. Top up credits to restore.',
        resetAt: null,
      };
    }
    if (status === 429) {
      const retryAfter = parseRetryAfterHeader(headers['retry-after']);
      return {
        status: STATUS_RATE_LIMITED,
        scope: 'provider',
        reason: 'Stability AI rate limit reached.',
        resetAt: Date.now() + (retryAfter || 60000),
      };
    }
    return super.classifyError(opts);
  }

  async probeFreeHealth({ fetchImpl = globalThis.fetch, apiKey } = {}) {
    if (!apiKey) return { ok: false, status: STATUS_INVALID_KEY };
    try {
      const res = await fetchImpl('https://api.stability.ai/v1/user/balance', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 401) return { ok: false, status: STATUS_INVALID_KEY };
      if (!res.ok) return { ok: false, status: STATUS_TEMPORARILY_UNAVAILABLE };
      const body = await res.json().catch(() => ({}));
      if (body.credits != null && Number(body.credits) <= 0) {
        return { ok: false, status: STATUS_INSUFFICIENT_CREDITS, reason: 'Stability AI zero balance.' };
      }
      return { ok: true, status: STATUS_HEALTHY };
    } catch {
      return { ok: false, status: STATUS_TEMPORARILY_UNAVAILABLE };
    }
  }
}

class EdenAiQuotaAdapter extends BaseQuotaAdapter {
  constructor() { super('edenai'); }

  classifyError(opts = {}) {
    const { status, message = '' } = opts;
    const msg = String(message).toLowerCase();
    if (status === 401 || status === 403 || msg.includes('unauthorized') || msg.includes('invalid_api_key')) {
      return {
        status: STATUS_INVALID_KEY,
        scope: 'key',
        reason: 'Eden AI API key is invalid or unauthorized.',
        resetAt: null,
      };
    }
    if (status === 402 || msg.includes('insufficient_credits') || msg.includes('insufficient credits') || msg.includes('credit')) {
      return {
        status: STATUS_INSUFFICIENT_CREDITS,
        scope: 'provider',
        reason: 'Eden AI account has insufficient credits.',
        resetAt: null,
      };
    }
    if (status === 429 || msg.includes('rate_limit') || msg.includes('rate limit')) {
      return {
        status: STATUS_RATE_LIMITED,
        scope: 'provider',
        reason: 'Eden AI rate limit reached. Resets in 60 seconds.',
        resetAt: Date.now() + 60000,
      };
    }
    return super.classifyError(opts);
  }
}

class PollinationsAiQuotaAdapter extends BaseQuotaAdapter {
  constructor() { super('pollinations'); }

  classifyError(opts = {}) {
    const { status, message = '' } = opts;
    const msg = String(message).toLowerCase();
    if (status === 402 || msg.includes('insufficient_credits') || msg.includes('pollen') || msg.includes('prepaid')) {
      return {
        status: STATUS_INSUFFICIENT_CREDITS,
        scope: 'provider',
        reason: 'Pollinations AI prepaid pollen credits exhausted.',
        resetAt: null,
      };
    }
    if (status === 429) {
      return {
        status: STATUS_RATE_LIMITED,
        scope: 'provider',
        reason: 'Pollinations AI rate limit reached.',
        resetAt: Date.now() + 60000,
      };
    }
    return super.classifyError(opts);
  }
}

class OpenAiQuotaAdapter extends BaseQuotaAdapter {
  constructor() { super('openai'); }

  classifyError(opts = {}) {
    const { status, message = '', headers = {} } = opts;
    const msg = String(message).toLowerCase();
    if (status === 429 && (msg.includes('insufficient_quota') || msg.includes('billing') || msg.includes('quota'))) {
      return {
        status: STATUS_INSUFFICIENT_CREDITS,
        scope: 'provider',
        reason: 'OpenAI quota or credit limit exhausted. Check your plan and billing details.',
        resetAt: null,
      };
    }
    if (status === 429) {
      const retryAfter = parseRetryAfterHeader(headers['retry-after']);
      return {
        status: STATUS_RATE_LIMITED,
        scope: opts.modelId ? 'model' : 'provider',
        reason: 'OpenAI rate limit reached (RPM/TPM).',
        resetAt: Date.now() + (retryAfter || 60000),
      };
    }
    return super.classifyError(opts);
  }

  async probeFreeHealth({ fetchImpl = globalThis.fetch, apiKey } = {}) {
    if (!apiKey) return { ok: false, status: STATUS_INVALID_KEY };
    try {
      const res = await fetchImpl('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 401) return { ok: false, status: STATUS_INVALID_KEY };
      if (res.status === 429) return { ok: false, status: STATUS_RATE_LIMITED };
      return { ok: res.ok, status: res.ok ? STATUS_HEALTHY : STATUS_TEMPORARILY_UNAVAILABLE };
    } catch {
      return { ok: false, status: STATUS_TEMPORARILY_UNAVAILABLE };
    }
  }
}

class AnthropicQuotaAdapter extends BaseQuotaAdapter {
  constructor() { super('anthropic'); }

  classifyError(opts = {}) {
    const { status, message = '', headers = {} } = opts;
    const msg = String(message).toLowerCase();
    if (msg.includes('credit balance is too low') || msg.includes('insufficient_credits')) {
      return {
        status: STATUS_INSUFFICIENT_CREDITS,
        scope: 'provider',
        reason: 'Anthropic account credit balance is too low.',
        resetAt: null,
      };
    }
    if (status === 429) {
      const retryAfter = parseRetryAfterHeader(headers['retry-after']);
      return {
        status: STATUS_RATE_LIMITED,
        scope: opts.modelId ? 'model' : 'provider',
        reason: 'Anthropic rate limit reached.',
        resetAt: Date.now() + (retryAfter || 60000),
      };
    }
    return super.classifyError(opts);
  }
}

class CodeCraftQuotaAdapter extends BaseQuotaAdapter {
  constructor() { super('codecraft'); }
  classifyError(opts = {}) {
    const { status, message = '' } = opts;
    const msg = String(message).toLowerCase();
    if (status === 402 || msg.includes('balance') || msg.includes('credits')) {
      return { status: STATUS_INSUFFICIENT_CREDITS, scope: 'provider', reason: 'CodeCraft credits exhausted.', resetAt: null };
    }
    if (status === 429) {
      return { status: STATUS_RATE_LIMITED, scope: 'provider', reason: 'CodeCraft rate limit reached.', resetAt: Date.now() + 60000 };
    }
    return super.classifyError(opts);
  }
}

class LlmtrQuotaAdapter extends BaseQuotaAdapter {
  constructor() { super('llmtr'); }
  classifyError(opts = {}) {
    const { status, message = '' } = opts;
    const msg = String(message).toLowerCase();
    if (status === 402 || msg.includes('balance') || msg.includes('credits')) {
      return { status: STATUS_INSUFFICIENT_CREDITS, scope: 'provider', reason: 'LLMTR credits exhausted.', resetAt: null };
    }
    if (status === 429) {
      return { status: STATUS_RATE_LIMITED, scope: 'provider', reason: 'LLMTR rate limit reached.', resetAt: Date.now() + 60000 };
    }
    return super.classifyError(opts);
  }
}

class OllamaQuotaAdapter extends BaseQuotaAdapter {
  constructor() { super('ollama'); }
  classifyError(opts = {}) {
    const { status, code = '', message = '' } = opts;
    if (status === 503 || code === 'ECONNREFUSED' || /connect/i.test(message)) {
      return { status: STATUS_TEMPORARILY_UNAVAILABLE, scope: 'provider', reason: 'Ollama service offline or unreachable.', resetAt: Date.now() + 30000 };
    }
    return super.classifyError(opts);
  }
}

// ---------------------------------------------------------------------------
// Central Quota Monitor Service
// ---------------------------------------------------------------------------

function createQuotaMonitorService({ dir = process.cwd(), env = process.env, logger = console } = {}) {
  const adapters = {
    openrouter: new OpenRouterQuotaAdapter(),
    gemini: new GeminiQuotaAdapter(),
    groq: new GroqQuotaAdapter(),
    nvidia: new NvidiaQuotaAdapter(),
    cloudflare: new CloudflareQuotaAdapter(),
    cohere: new CohereQuotaAdapter(),
    stability: new StabilityAiQuotaAdapter(),
    pollinations: new PollinationsAiQuotaAdapter(),
    edenai: new EdenAiQuotaAdapter(),
    openai: new OpenAiQuotaAdapter(),
    anthropic: new AnthropicQuotaAdapter(),
    codecraft: new CodeCraftQuotaAdapter(),
    llmtr: new LlmtrQuotaAdapter(),
    ollama: new OllamaQuotaAdapter(),
    default: new BaseQuotaAdapter('default'),
  };

  // State maps:
  // providers[norm] = {
  //   providerId: norm,
  //   providerName: displayProviderName(norm),
  //   status: STATUS_HEALTHY,
  //   errorReason: null,
  //   resetAt: null,
  //   sharedAccountExhausted: false,
  //   lastSuccessAt: null,
  //   lastFailureAt: null,
  //   lastCheckedAt: new Date().toISOString(),
  //   keys: { [slot]: { keySlot, status, errorReason, resetAt, lastSuccessAt, lastFailureAt, isSharedAccount } },
  //   models: { [modelId]: { modelId, status, errorReason, resetAt, lastSuccessAt, lastFailureAt } }
  // }
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
        sharedAccountExhausted: false,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastCheckedAt: new Date().toISOString(),
        keys: {},
        models: {},
      };
    }
    return providers[norm];
  }

  function registerProviderKey(providerName, keySlot, { key = '', accountId = '', maskedKey = '', isSharedAccount = false } = {}) {
    const norm = normalizeProviderName(providerName);
    const p = ensureProviderState(norm);
    const slot = String(keySlot || 'default');
    if (!p.keys[slot]) {
      p.keys[slot] = {
        keySlot: slot,
        status: STATUS_HEALTHY,
        errorReason: null,
        resetAt: null,
        maskedKey: maskedKey || (key ? `${key.slice(0, 4)}...${key.slice(-4)}` : ''),
        isSharedAccount: Boolean(isSharedAccount),
        lastSuccessAt: null,
        lastFailureAt: null,
      };
    }
    return p.keys[slot];
  }

  function ensureModelState(providerName, modelId) {
    const p = ensureProviderState(providerName);
    const mid = String(modelId || '').trim();
    if (!mid) return null;
    if (!p.models[mid]) {
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

  // Recomputes overall provider status considering multi-key slots and shared account constraints
  function recomputeProviderOverallStatus(providerName) {
    const norm = normalizeProviderName(providerName);
    const p = ensureProviderState(norm);

    // If marked disabled by admin, keep it disabled
    if (p.status === STATUS_ADMIN_DISABLED) {
      return;
    }

    // 1. Shared account quota exhaustion takes absolute precedence
    if (p.sharedAccountExhausted) {
      if (p.resetAt && Date.now() >= Date.parse(p.resetAt)) {
        p.sharedAccountExhausted = false;
        p.status = STATUS_HEALTHY;
        p.errorReason = null;
        p.resetAt = null;
      } else {
        p.status = STATUS_QUOTA_EXHAUSTED;
        return;
      }
    }

    const keyList = Object.values(p.keys);
    const modelList = Object.values(p.models);

    // 2. Multi-key logic:
    // If provider has configured keys:
    if (keyList.length > 0) {
      const healthyKeys = keyList.filter(k => k.status === STATUS_HEALTHY);
      if (healthyKeys.length > 0) {
        // At least one usable key is healthy -> provider is available
        p.status = STATUS_HEALTHY;
        p.errorReason = null;
        p.resetAt = null;
        return;
      }

      // All keys are non-healthy. Classify provider status based on the collective state
      const allExhausted = keyList.every(k => k.status === STATUS_QUOTA_EXHAUSTED || k.status === STATUS_INSUFFICIENT_CREDITS);
      const allInvalid = keyList.every(k => k.status === STATUS_INVALID_KEY);
      const allRateLimited = keyList.every(k => k.status === STATUS_RATE_LIMITED);

      if (allExhausted) {
        p.status = STATUS_QUOTA_EXHAUSTED;
        p.errorReason = 'All configured API keys have exhausted their available quota or credits.';
      } else if (allInvalid) {
        p.status = STATUS_INVALID_KEY;
        p.errorReason = 'All configured API keys are invalid or revoked.';
      } else if (allRateLimited) {
        p.status = STATUS_RATE_LIMITED;
        p.errorReason = 'All configured API keys are temporarily rate-limited.';
      } else {
        const worst = keyList[0];
        p.status = worst.status;
        p.errorReason = worst.errorReason;
        p.resetAt = worst.resetAt;
      }
      return;
    }

    // 3. Model-level checks if no discrete keys are tracked
    if (modelList.length > 0) {
      const anyHealthy = modelList.some(m => m.status === STATUS_HEALTHY);
      if (anyHealthy) {
        p.status = STATUS_HEALTHY;
        p.errorReason = null;
        p.resetAt = null;
        return;
      }
      const allExhausted = modelList.every(m => m.status === STATUS_QUOTA_EXHAUSTED || m.status === STATUS_INSUFFICIENT_CREDITS);
      if (allExhausted) {
        p.status = STATUS_QUOTA_EXHAUSTED;
        p.errorReason = 'All models for this provider are currently quota exhausted.';
        p.resetAt = modelList[0]?.resetAt || null;
      }
    }
  }

  // Records a failed API request and updates quota status accordingly
  function recordError({ providerName, modelId, keySlot = 'default', status, code, message, headers = {}, isSharedAccount = false } = {}) {
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

    // Account-level vs Key-level determination:
    // If the failure is account-wide (e.g. insufficient credits, shared account exhausted, or no keySlot specified)
    if (classified.status === STATUS_INSUFFICIENT_CREDITS || isSharedAccount || (classified.scope === 'provider' && (!keySlot || keySlot === 'default'))) {
      p.sharedAccountExhausted = (classified.status === STATUS_QUOTA_EXHAUSTED || classified.status === STATUS_INSUFFICIENT_CREDITS);
      p.status = classified.status;
      p.errorReason = classified.reason;
      p.resetAt = classified.resetAt ? new Date(classified.resetAt).toISOString() : null;
      // Mark all keys sharing this account
      for (const k of Object.values(p.keys)) {
        k.status = classified.status;
        k.errorReason = classified.reason;
        k.resetAt = p.resetAt;
      }
    } else {
      recomputeProviderOverallStatus(norm);
    }

    logger.warn(`[QuotaMonitor] ${p.providerName}${modelId ? ' (' + modelId + ')' : ''}${keySlot ? ' [slot ' + keySlot + ']' : ''} marked as ${classified.status}: ${classified.reason}${classified.resetAt ? ' (resets at ' + new Date(classified.resetAt).toISOString() + ')' : ''}`);
    return classified;
  }

  // Records a successful API request and clears transient rate limits
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

  // Provider-level availability check
  function getProviderAvailability(providerName) {
    const norm = normalizeProviderName(providerName);
    const p = ensureProviderState(norm);

    if (p.status === STATUS_ADMIN_DISABLED) {
      return {
        available: false,
        status: STATUS_ADMIN_DISABLED,
        reason: `${p.providerName} is disabled by the administrator.`,
        resetAt: null,
      };
    }

    if (p.status === STATUS_INVALID_KEY || p.status === STATUS_PERMISSION_DENIED) {
      return {
        available: false,
        status: p.status,
        reason: p.errorReason || `${p.providerName} API key is invalid or lacks permission.`,
        resetAt: null,
      };
    }

    if (p.status === STATUS_INSUFFICIENT_CREDITS) {
      return {
        available: false,
        status: STATUS_INSUFFICIENT_CREDITS,
        reason: p.errorReason || `${p.providerName} account credit balance is exhausted.`,
        resetAt: null,
      };
    }

    // Provider-level quota exhaustion
    if (p.status === STATUS_QUOTA_EXHAUSTED) {
      if (p.resetAt && Date.now() >= Date.parse(p.resetAt)) {
        p.status = STATUS_HEALTHY;
        p.sharedAccountExhausted = false;
        p.errorReason = null;
        p.resetAt = null;
      } else {
        // Check if there are keys and any key is healthy
        const keyList = Object.values(p.keys);
        const hasHealthyKey = keyList.length > 1 && keyList.some(k => k.status === STATUS_HEALTHY);
        if (!hasHealthyKey || p.sharedAccountExhausted) {
          return {
            available: false,
            status: STATUS_QUOTA_EXHAUSTED,
            reason: p.errorReason || `${p.providerName} quota exhausted.`,
            resetAt: p.resetAt,
          };
        }
      }
    }

    if (p.status === STATUS_RATE_LIMITED) {
      if (p.resetAt && Date.now() >= Date.parse(p.resetAt)) {
        p.status = STATUS_HEALTHY;
        p.errorReason = null;
        p.resetAt = null;
      } else {
        const keyList = Object.values(p.keys);
        const hasHealthyKey = keyList.length > 1 && keyList.some(k => k.status === STATUS_HEALTHY);
        if (!hasHealthyKey) {
          return {
            available: false,
            status: STATUS_RATE_LIMITED,
            reason: p.errorReason || `${p.providerName} is currently rate limited.`,
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

  // Model-level availability check
  function getModelAvailability(providerName, modelId) {
    const norm = normalizeProviderName(providerName);
    const p = ensureProviderState(norm);
    const mid = String(modelId || '').trim();

    // 1. If provider is globally unavailable, ALL its models are unavailable
    const provAvail = getProviderAvailability(norm);
    if (!provAvail.available) {
      return provAvail;
    }

    // 2. Check specific model status
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

    return {
      available: true,
      status: STATUS_HEALTHY,
      reason: '',
      resetAt: null,
    };
  }

  // Throws error if request to this model/provider is blocked by quota
  function assertModelRequestAllowed(providerName, modelId) {
    const check = getModelAvailability(providerName, modelId);
    if (!check.available) {
      const resetMsg = check.resetAt ? ` Resets at ${new Date(check.resetAt).toISOString()}.` : '';
      const err = new Error(`${check.reason}${resetMsg}`);
      err.code = check.status.toLowerCase();
      err.status = (check.status === STATUS_RATE_LIMITED) ? 429 : 402;
      err.resetAt = check.resetAt;
      throw err;
    }
  }

  // Background evaluator: automatically restores models and providers whose resetAt timestamps have arrived
  function checkAndRestoreAll() {
    if (isChecking) return;
    isChecking = true;
    try {
      const nowMs = Date.now();
      for (const p of Object.values(providers)) {
        // Check provider-level resetAt
        if (p.resetAt && nowMs >= Date.parse(p.resetAt)) {
          p.status = STATUS_HEALTHY;
          p.sharedAccountExhausted = false;
          p.errorReason = null;
          p.resetAt = null;
          logger.info(`[QuotaMonitor] Restored provider ${p.providerName} to HEALTHY (reset timestamp reached).`);
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

  function startBackgroundMonitoring(intervalMs = 15000) {
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

  function getStatusSnapshot() {
    checkAndRestoreAll();
    const result = {
      timestamp: new Date().toISOString(),
      providers: {},
    };

    for (const [id, p] of Object.entries(providers)) {
      const modelEntries = Object.values(p.models);
      const availCount = modelEntries.filter(m => m.status === STATUS_HEALTHY).length;
      const exCount = modelEntries.filter(m => m.status !== STATUS_HEALTHY).length;

      result.providers[id] = {
        id,
        provider: p.providerName,
        status: p.status,
        errorReason: p.errorReason,
        resetAt: p.resetAt,
        sharedAccountExhausted: Boolean(p.sharedAccountExhausted),
        availableModels: availCount,
        exhaustedModels: exCount,
        lastSuccessAt: p.lastSuccessAt,
        lastFailureAt: p.lastFailureAt,
        lastChecked: p.lastCheckedAt,
        keys: Object.values(p.keys).map(k => ({
          slot: k.keySlot,
          status: k.status,
          errorReason: k.errorReason,
          resetAt: k.resetAt,
        })),
        models: modelEntries.map(m => ({
          id: m.modelId,
          status: m.status,
          errorReason: m.errorReason,
          resetAt: m.resetAt,
        })),
      };
    }
    return result;
  }

  function simulateQuotaEvent({ providerName, modelId, keySlot, status, errorReason, resetInMs, sharedAccount = false } = {}) {
    const norm = normalizeProviderName(providerName);
    const p = ensureProviderState(norm);
    const resetAt = resetInMs ? new Date(Date.now() + resetInMs).toISOString() : null;

    if (modelId) {
      const m = ensureModelState(norm, modelId);
      if (m) {
        m.status = status || STATUS_QUOTA_EXHAUSTED;
        m.errorReason = errorReason || 'Simulated model quota event';
        m.resetAt = resetAt;
      }
    }

    if (keySlot) {
      const k = ensureKeyState(norm, keySlot);
      if (k) {
        k.status = status || STATUS_QUOTA_EXHAUSTED;
        k.errorReason = errorReason || 'Simulated key quota event';
        k.resetAt = resetAt;
      }
    }

    if (sharedAccount || (!modelId && !keySlot)) {
      p.status = status || STATUS_QUOTA_EXHAUSTED;
      p.sharedAccountExhausted = (status === STATUS_QUOTA_EXHAUSTED || status === STATUS_INSUFFICIENT_CREDITS);
      p.errorReason = errorReason || 'Simulated provider quota event';
      p.resetAt = resetAt;
      for (const k of Object.values(p.keys)) {
        k.status = p.status;
        k.errorReason = p.errorReason;
        k.resetAt = p.resetAt;
      }
    } else {
      recomputeProviderOverallStatus(norm);
    }
  }

  function simulateRestore({ providerName, modelId, keySlot } = {}) {
    const norm = normalizeProviderName(providerName);
    const p = ensureProviderState(norm);

    if (modelId) {
      const m = ensureModelState(norm, modelId);
      if (m) {
        m.status = STATUS_HEALTHY;
        m.errorReason = null;
        m.resetAt = null;
      }
    }

    if (keySlot) {
      const k = ensureKeyState(norm, keySlot);
      if (k) {
        k.status = STATUS_HEALTHY;
        k.errorReason = null;
        k.resetAt = null;
      }
    }

    if (!modelId && !keySlot) {
      p.status = STATUS_HEALTHY;
      p.sharedAccountExhausted = false;
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

    recomputeProviderOverallStatus(norm);
  }

  function resetAllToHealthy() {
    for (const p of Object.values(providers)) {
      p.status = STATUS_HEALTHY;
      p.sharedAccountExhausted = false;
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
    STATUS_ADMIN_DISABLED,
    STATUS_DISABLED,
    STATUS_UNKNOWN,
    ALL_STATUSES,
    getAdapter,
    registerProviderKey,
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
    simulateRestore,
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
  STATUS_ADMIN_DISABLED,
  STATUS_DISABLED,
  STATUS_UNKNOWN,
  ALL_STATUSES,
  createQuotaMonitorService,
  parseRetryAfterHeader,
  parseDurationToMs,
  getNextUtcHourTimestamp,
  BaseQuotaAdapter,
  OpenRouterQuotaAdapter,
  GeminiQuotaAdapter,
  GroqQuotaAdapter,
  NvidiaQuotaAdapter,
  CloudflareQuotaAdapter,
  CohereQuotaAdapter,
  StabilityAiQuotaAdapter,
  PollinationsAiQuotaAdapter,
  EdenAiQuotaAdapter,
  OpenAiQuotaAdapter,
  AnthropicQuotaAdapter,
  CodeCraftQuotaAdapter,
  LlmtrQuotaAdapter,
  OllamaQuotaAdapter,
};
