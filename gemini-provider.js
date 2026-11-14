'use strict';
// Google Gemini provider for PHOTON AI.
//
// * Keys are supplied by gemini-keys.js. This module never reads GEMINI_API_KEY itself, never
//   puts a key in an error/log message, and never returns one over HTTP.
// * Models are discovered live from GET /v1beta/models so outdated IDs are never hardcoded.
// * Retry policy:
//     - 429 / rate limit  -> exponential backoff, honour Retry-After, retry the SAME key.
//                            Never rotate keys: keys in one Google Cloud project share quota.
//     - 5xx / network     -> bounded exponential backoff on the same key.
//     - 401/403 auth      -> disable rotation for that request? No: mark the key and move to
//                            another key (at most MAX_AUTH_KEYS keys per request).
//     - Everything else   -> surface the mapped error immediately. Never retries forever.

const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_TTL_MS = 10 * 60 * 1000;
const MODEL_RETRY_MS = 60 * 1000;
const MODEL_TIMEOUT_MS = 20 * 1000;
const REQUEST_TIMEOUT_MS = 90 * 1000;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_RETRIES = 2;               // per key, for 429 / 5xx / network
const MAX_AUTH_KEYS = 2;             // rotate to at most this many keys on auth failures
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;
const MAX_RETRY_AFTER_MS = 15000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const MAX_MODELS = 200;

const CHAT_ID = /^(gemini|gemma|learnlm)-/i;
const NON_CHAT_ID = /(embedding|aqa|imagen|veo|tts|audio|live|image-generation|-image$|native-audio)/i;

function isChatModel(model) {
  const id = String(model?.id || '');
  if (!id || !CHAT_ID.test(id) || NON_CHAT_ID.test(id)) return false;
  if (Array.isArray(model?.supportedGenerationMethods) && !model.supportedGenerationMethods.includes('generateContent')) return false;
  return true;
}

// Parses GEMINI_MODEL_ALLOW / GEMINI_MODEL_DENY. Entries are exact IDs or prefix globs ("gemini-2.5-*").
function matchesList(id, raw) {
  const list = String(raw || '').split(',').map(item => item.trim()).filter(Boolean);
  return list.some(entry => entry.endsWith('*') ? id.startsWith(entry.slice(0, -1)) : id === entry);
}

function modelVersion(id) {
  const match = /(\d+(?:\.\d+)?)/.exec(id);
  return match ? Number(match[1]) : 0;
}

function compareModels(a, b) {
  const version = modelVersion(b.id) - modelVersion(a.id);
  if (version) return version;
  if (a.flash !== b.flash) return a.flash ? -1 : 1;
  return a.id.localeCompare(b.id);
}

function normalizeModels(rawList, env = process.env) {
  const allow = String(env.GEMINI_MODEL_ALLOW || '').trim();
  const deny = String(env.GEMINI_MODEL_DENY || '').trim();
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    const id = String(raw?.name || raw?.id || '').replace(/^models\//, '');
    if (!MODEL_ID.test(id) || seen.has(id)) continue;
    if (!isChatModel({ ...raw, id })) continue;
    if (allow && !matchesList(id, allow)) continue;
    if (deny && matchesList(id, deny)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(raw.displayName || id).replace(/\s+/g, ' ').trim().slice(0, 80) || id,
      flash: /flash/i.test(id),
      inputTokenLimit: Number(raw.inputTokenLimit) || null,
      outputTokenLimit: Number(raw.outputTokenLimit) || null,
      supportedGenerationMethods: Array.isArray(raw.supportedGenerationMethods) ? raw.supportedGenerationMethods : ['generateContent'],
    });
  }
  return out.sort(compareModels).slice(0, MAX_MODELS);
}

// Safe, key-free explanation for the admin UI and the model selector.
function validationMessage(code) {
  switch (code) {
    case 'not_configured': return 'Gemini is not configured on this server. Add a Gemini API key in the admin panel.';
    case 'invalid_api_key': return 'Gemini rejected the server API key. The administrator must update it.';
    case 'provider_forbidden': return 'The Gemini API key is not permitted to use this model.';
    case 'billing_required': return 'Gemini billing is unavailable. Restore AI Studio credits and retry.';
    case 'quota_or_rate_limit': return 'Gemini quota or rate limit was reached. Check the project quota and retry.';
    case 'provider_unavailable': return 'Gemini is temporarily unavailable. Retry shortly.';
    case 'network_error': return 'Could not connect to Gemini. Check the server network and retry.';
    case 'provider_timeout': return 'Gemini took too long to respond. Please retry.';
    case 'no_chat_models': return 'No Gemini chat models are available for this account.';
    default: return 'Gemini models could not be loaded from Google.';
  }
}

function parseRetryAfter(value) {  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  let ms;
  if (/^\d+(?:\.\d+)?$/.test(text)) ms = Number(text) * 1000;
  else {
    const at = Date.parse(text);
    if (!Number.isFinite(at)) return null;
    ms = at - Date.now();
  }
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

function backoffDelay(attempt, retryAfterMs, random = Math.random) {
  if (Number.isFinite(retryAfterMs)) return Math.max(0, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt)));
  return Math.round(base * (0.75 + random() * 0.5));
}

function createGeminiProvider({ HttpError, keys, env = process.env, fetchImpl = globalThis.fetch, logger = console, sleep, random } = {}) {
  if (!HttpError) throw new Error('HttpError class is required');
  if (!keys) throw new Error('A Gemini key store is required');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');

  const wait = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const jitter = random || Math.random;
  const apiBase = String(env.GEMINI_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
  const modelsUrl = `${apiBase}/models`;

  let models = [];
  let modelsAt = 0;
  let modelsOk = null;
  let modelsError = null;
  let inflight = null;

  function enabledKeys() { return keys.list().filter(item => item.enabled); }
  function configured() { return enabledKeys().length > 0; }

  function combinedSignal(signal, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!signal) return timeout;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    timeout.addEventListener('abort', abort, { once: true });
    return controller.signal;
  }

  function mapError(error) {
    if (error instanceof HttpError) return error;
    const status = Number(error?.status) || 0;
    const name = String(error?.name || error?.constructor?.name || '');
    const detail = String(error?.message || '').toLowerCase();
    const retryAfterMs = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : null;
    const wrap = (code, message, httpStatus = 502) => {
      const mapped = new HttpError(httpStatus, code, message);
      mapped.retryAfterMs = retryAfterMs;
      return mapped;
    };
    if (name === 'AbortError' || name === 'TimeoutError' || error?.code === 'ABORT_ERR' || error?.code === 'ETIMEDOUT') return wrap('provider_timeout', 'Gemini took too long to respond. Please retry.', 504);
    if (name === 'TypeError' || (!status && /fetch failed|network|enotfound|econn|socket|terminated|connect/.test(detail))) return wrap('network_error', 'Could not connect to Gemini. Check the server network and retry.');
    if (status === 401) return wrap('invalid_api_key', 'Gemini rejected the server API key. The administrator must update it.');
    if (status === 402 || detail.includes('prepayment') || detail.includes('billing')) return wrap('billing_required', 'Gemini billing is unavailable. Restore AI Studio credits and retry.', 402);
    if (status === 403) {
      if (/quota|rate limit|exceeded/.test(detail)) return wrap('quota_or_rate_limit', 'Gemini quota or rate limit was reached. Check the project quota and retry.', 429);
      return wrap('provider_forbidden', 'The Gemini API key is not permitted to use this model.');
    }
    if (status === 404) return wrap('invalid_model', 'The selected Gemini model is unavailable. Choose another model.');
    if (status === 408 || status === 504) return wrap('provider_timeout', 'Gemini took too long to respond. Please retry.', 504);
    if (status === 413) return wrap('request_too_large', 'The request is too large for Gemini. Shorten the message or attachments.', 413);
    if (status === 429) return wrap('quota_or_rate_limit', 'Gemini quota or rate limit was reached. Check the project quota and retry.', 429);
    if (status >= 500) return wrap('provider_unavailable', 'Gemini is temporarily unavailable. Retry shortly.', 503);
    if (status === 400) {
      if (/api key not valid|api_key_invalid|api key expired/.test(detail)) return wrap('invalid_api_key', 'Gemini rejected the server API key. The administrator must update it.');
      if (/quota|rate limit/.test(detail)) return wrap('quota_or_rate_limit', 'Gemini quota or rate limit was reached. Check the project quota and retry.', 429);
      if (/model.*(not found|invalid|does not exist|unsupported)/.test(detail)) return wrap('invalid_model', 'The selected Gemini model is unavailable. Choose another model.');
      return wrap('provider_rejected_request', 'Gemini could not process this request. Try simplifying the message or attachments.');
    }
    return wrap('provider_error', 'Gemini could not complete this request.');
  }

  async function httpError(response) {
    const data = await response.json().catch(() => ({}));
    const detail = String(data?.error?.message || '').toLowerCase();
    const error = new Error(detail || 'Gemini request failed');
    error.status = response.status;
    error.retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
    return mapError(error);
  }

  function authFailure(code) {
    return code === 'invalid_api_key' || code === 'provider_forbidden';
  }
  function retryable(code) {
    return code === 'quota_or_rate_limit' || code === 'provider_unavailable' || code === 'network_error' || code === 'provider_timeout';
  }

  // Runs `operation(key)` under the retry / rotation policy described at the top of this file.
  async function withKey(operation, { signal } = {}) {
    const available = keys.select();
    if (!available.length) throw new HttpError(503, 'provider_not_configured', 'Gemini is not configured on this server. Add a Gemini API key in the admin panel.');
    let lastError = null;
    let authTried = 0;
    for (const key of available) {
      if (authTried >= MAX_AUTH_KEYS) break;
      keys.markUsed(key.id);
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const result = await operation(key, attempt);
          keys.recordValidation(key.id, 'ok', { modelCount: models.length || undefined });
          return result;
        } catch (raw) {
          if (signal?.aborted) throw new HttpError(499, 'request_aborted', 'The request was cancelled.');
          const mapped = raw instanceof HttpError ? raw : mapError(raw);
          if (authFailure(mapped.code)) {
            keys.recordValidation(key.id, mapped.code);
            lastError = mapped;
            authTried++;
            logger.error(JSON.stringify({ category: 'gemini_key_auth', code: mapped.code, key: key.id }));
            break; // try the next key
          }
          if (retryable(mapped.code) && attempt < MAX_RETRIES) {
            const delay = backoffDelay(attempt, mapped.retryAfterMs, jitter);
            logger.error(JSON.stringify({ category: 'gemini_retry', code: mapped.code, status: mapped.status, attempt: attempt + 1, delay_ms: delay, key: key.id }));
            await wait(delay);
            continue;
          }
          // Quota errors are never retried on another key: that would bypass Google's limits.
          logger.error(JSON.stringify({ category: 'gemini_request', code: mapped.code, status: mapped.status, key: key.id }));
          throw mapped;
        }
      }
    }
    throw lastError || new HttpError(503, 'provider_not_configured', 'Gemini is not configured on this server. Add a Gemini API key in the admin panel.');
  }

  function buildBody({ contents, systemInstruction, maxOutputTokens = MAX_OUTPUT_TOKENS }) {
    const body = { contents: Array.isArray(contents) ? contents : [], generationConfig: { maxOutputTokens: Math.max(1, Math.min(Number(maxOutputTokens) || MAX_OUTPUT_TOKENS, 32000)) } };
    const systemText = String(systemInstruction || '').trim().slice(0, 80000);
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
    return body;
  }

  function extractText(data) {
    return (data?.candidates?.[0]?.content?.parts || []).map(part => part?.text || '').join('').trim();
  }

  function normalizeUsage(meta) {
    if (!meta) return null;
    const inputTokens = Number(meta.promptTokenCount) || 0;
    const outputTokens = Number(meta.candidatesTokenCount) || 0;
    const totalTokens = Number(meta.totalTokenCount) || inputTokens + outputTokens;
    return { inputTokens, outputTokens, totalTokens };
  }

  async function listModelsForKey(secretKey) {
    const response = await fetchImpl(modelsUrl + '?pageSize=1000', { method: 'GET', headers: { 'x-goog-api-key': secretKey }, signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) });
    if (!response.ok) throw await httpError(response);
    const data = await response.json().catch(() => ({}));
    return Array.isArray(data?.models) ? data.models : [];
  }

  // Never throws. Refreshes the live model catalog using the configured keys.
  async function refreshModels(force = false) {
    if (!configured()) { models = []; modelsOk = null; modelsError = null; modelsAt = 0; return models; }
    const ttl = modelsOk === false ? MODEL_RETRY_MS : MODEL_TTL_MS;
    if (!force && modelsAt && Date.now() - modelsAt < ttl) return models;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const raw = await withKey(key => listModelsForKey(key.secret));
        models = normalizeModels(raw, env);
        modelsOk = models.length > 0;
        modelsError = modelsOk ? null : 'no_chat_models';
      } catch (error) {
        const mapped = mapError(error);
        modelsOk = false;
        modelsError = mapped.code;
        if (authFailure(mapped.code) || mapped.code === 'billing_required') models = [];
        logger.error(JSON.stringify({ category: 'gemini_models', code: mapped.code, status: mapped.status }));
      } finally {
        modelsAt = Date.now();
        inflight = null;
      }
      return models;
    })();
    return inflight;
  }

  function status() {
    const all = keys.list();
    const enabled = all.filter(item => item.enabled);
    const validation = !enabled.length ? 'not_configured' : modelsOk === null ? 'unchecked' : modelsOk ? 'ok' : modelsError;
    return {
      provider: 'Google Gemini',
      configured: enabled.length > 0,
      keyCount: all.length,
      enabledKeyCount: enabled.length,
      validation,
      modelCount: models.length,
      checkedAt: modelsAt ? new Date(modelsAt).toISOString() : null,
      models: models.map(model => model.id),
      keys: all.map(item => ({ id: item.id, label: item.label, masked: item.masked, enabled: item.enabled, lastValidation: item.lastValidation })),
    };
  }

  function catalogEntries() {
    if (!configured()) {
      return [{ id: 'gemini', name: 'Google Gemini', provider: 'Google', configured: false, supported: true, available: false, reason: 'Gemini is not configured on this server. Add a Gemini API key in the admin panel.' }];
    }
    if (models.length) {
      return models.map(model => ({ id: model.id, name: model.name, provider: 'Google', configured: true, supported: true, available: true, reason: '' }));
    }
    const reason = modelsOk === false ? validationMessage(modelsError) : 'Gemini models have not been loaded yet.';
    return [{ id: 'gemini', name: 'Google Gemini', provider: 'Google', configured: true, supported: true, available: false, unavailable: true, reason }];
  }

  function defaultModelId() {
    return models.length ? models[0].id : null;
  }

  async function generate({ model, contents, systemInstruction, maxOutputTokens = MAX_OUTPUT_TOKENS, signal } = {}) {
    if (!MODEL_ID.test(String(model || ''))) throw new HttpError(400, 'invalid_model', 'The selected Gemini model is invalid.');
    const body = buildBody({ contents, systemInstruction, maxOutputTokens });
    return withKey(async (key) => {
      let response;
      try {
        response = await fetchImpl(`${apiBase}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key.secret },
          body: JSON.stringify(body),
          signal: combinedSignal(signal, REQUEST_TIMEOUT_MS),
        });
      } catch (error) { throw mapError(error); }
      if (!response.ok) throw await httpError(response);
      const data = await response.json().catch(() => ({}));
      const text = extractText(data);
      if (!text) throw new HttpError(502, 'empty_response', data?.promptFeedback?.blockReason ? 'Gemini blocked this request under its safety policy.' : 'Gemini returned an empty response. Please retry.');
      return { text, usage: normalizeUsage(data?.usageMetadata), model: data?.modelVersion || model };
    }, { signal });
  }

  async function* streamGenerate({ model, contents, systemInstruction, maxOutputTokens = MAX_OUTPUT_TOKENS, signal } = {}) {
    if (!MODEL_ID.test(String(model || ''))) throw new HttpError(400, 'invalid_model', 'The selected Gemini model is invalid.');
    const body = buildBody({ contents, systemInstruction, maxOutputTokens });
    const response = await withKey(async (key) => {
      let result;
      try {
        result = await fetchImpl(`${apiBase}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key.secret },
          body: JSON.stringify(body),
          signal: combinedSignal(signal, REQUEST_TIMEOUT_MS),
        });
      } catch (error) { throw mapError(error); }
      if (!result.ok) throw await httpError(result);
      return result;
    }, { signal });

    if (!response.body) throw new HttpError(502, 'provider_error', 'Gemini did not return a response stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let usage = null;
    let promptBlocked = false;

    function* consumeLine(rawLine) {
      const line = String(rawLine || '').replace(/\r$/, '');
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let event;
      try { event = JSON.parse(payload); } catch { return; }
      if (event?.error) throw mapError(Object.assign(new Error(event.error.message || 'Gemini stream error'), { status: 502, retryAfterMs: null }));
      if (event?.promptFeedback?.blockReason) promptBlocked = true;
      const parts = event?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (typeof part?.text === 'string' && part.text) {
          full += part.text;
          yield { type: 'delta', text: part.text };
        }
      }
      if (event?.usageMetadata) usage = normalizeUsage(event.usageMetadata);
    }

    try {
      while (true) {
        let chunk;
        try { chunk = await reader.read(); }
        catch (error) {
          if (signal?.aborted) throw new HttpError(499, 'request_aborted', 'The request was cancelled.');
          throw mapError(error);
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          yield* consumeLine(line);
        }
      }
      if (buffer.trim()) yield* consumeLine(buffer);
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }

    const output = full.trim();
    if (!output) throw new HttpError(502, 'empty_response', promptBlocked ? 'Gemini blocked this request under its safety policy.' : 'Gemini returned an empty response. Please retry.');
    yield { type: 'done', text: output, usage };
  }

  // Validates one specific key (admin "Test connection"). Never returns the key.
  async function testKey(id) {
    const started = Date.now();
    const secret = keys.secretFor(id);
    if (!secret) throw new HttpError(404, 'key_not_found', 'That Gemini key no longer exists.');
    try {
      const raw = await listModelsForKey(secret);
      const list = normalizeModels(raw, env);
      keys.recordValidation(id, 'ok', { modelCount: list.length });
      if (!models.length && list.length) { models = list; modelsOk = true; modelsAt = Date.now(); }
      return { id, status: 'ok', modelCount: list.length, checkedAt: new Date().toISOString(), responseTimeMs: Date.now() - started };
    } catch (error) {
      const mapped = mapError(error);
      keys.recordValidation(id, mapped.code);
      return { id, status: mapped.code, message: mapped.message, checkedAt: new Date().toISOString(), responseTimeMs: Date.now() - started };
    }
  }

  async function testModel(modelId) {
    const started = Date.now();
    if (!configured()) {
      return { ok: false, code: 'not_configured', status: 'not_configured', message: validationMessage('not_configured'), responseTimeMs: 0, testedAt: new Date().toISOString() };
    }
    const id = String(modelId || '').trim();
    if (!id) {
      return { ok: false, code: 'invalid_model', status: 'invalid_model', message: 'Invalid model ID.', responseTimeMs: 0, testedAt: new Date().toISOString() };
    }
    try {
      const res = await generate({
        model: id,
        contents: [{ role: 'user', parts: [{ text: 'Say ok.' }] }],
        systemInstruction: 'Reply with one short word.',
        maxOutputTokens: 10,
      });
      return {
        ok: true,
        model: id,
        modelName: id,
        provider: 'Google Gemini',
        reply: res.text,
        usage: res.usage,
        status: 'working',
        responseTimeMs: Date.now() - started,
        testedAt: new Date().toISOString(),
      };
    } catch (err) {
      const mapped = mapError(err);
      return {
        ok: false,
        model: id,
        modelName: id,
        provider: 'Google Gemini',
        code: mapped.code,
        status: 'failed',
        message: mapped.message,
        responseTimeMs: Date.now() - started,
        testedAt: new Date().toISOString(),
      };
    }
  }

  async function testAll() {
    const results = [];
    for (const key of keys.list()) results.push(await testKey(key.id));
    return results;
  }

  function resetCache() { models = []; modelsOk = null; modelsError = null; modelsAt = 0; }

  return {
    configured, status, refreshModels, catalogEntries, defaultModelId,
    generate, streamGenerate, testKey, testAll, testModel, mapError, resetCache,
    apiBase, modelsUrl,
  };
}

module.exports = {
  createGeminiProvider,
  normalizeModels,
  isChatModel,
  matchesList,
  validationMessage,
  parseRetryAfter,
  backoffDelay,
  MODEL_ID,
  DEFAULT_API_BASE,
  MAX_RETRIES,
  MAX_AUTH_KEYS,
};
