'use strict';
// OpenRouter provider for PHOTON AI.
// - Reads OPENROUTER_API_KEY from the server environment (or API.env / .env next to server.js).
// - Uses OpenRouter's official OpenAI-compatible Chat Completions endpoint.
// - Free model IDs are discovered from GET /api/v1/models at runtime and only registered when
//   the live API actually returns them. Nothing is trusted just because it is in a list below.
// - The key never leaves this module: status() and every error message are key-free.

const { createOpenRouterKeyStore, createKeyManager, AUTH_CODES, TRANSIENT_CODES } = require('./openrouter-keys');
const { parseRetryAfter, backoffDelay } = require('./gemini-provider');

const DEFAULT_API_BASE = 'https://openrouter.ai/api/v1';
const MAX_RETRIES = 2;              // per key, for 429 / 5xx / network (Retry-After respected, exponential backoff)
const MAX_AUTH_KEYS = 3;            // at most this many keys are tried after authentication failures
const MAX_TOTAL_ATTEMPTS = 8;       // hard ceiling per request: never retry indefinitely
const VALIDATION_CONCURRENCY = 4;
const MODEL_TTL_MS = 10 * 60 * 1000;      // successful key + model cache
const MODEL_RETRY_MS = 60 * 1000;         // failed cache, retry sooner
const KEY_TIMEOUT_MS = 15 * 1000;
const REQUEST_TIMEOUT_MS = 90 * 1000;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_FREE_MODELS = 50;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,160}$/;

// Verified against https://openrouter.ai/api/v1/models on 2026-11-10. These are preference
// hints only: refreshModels() re-resolves each one against the live catalog (by exact ID, then
// by name) and registers only the models the API currently returns as free.
const PREFERRED_FREE_MODELS = Object.freeze([
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'NVIDIA Nemotron 3 Ultra', match: /nemotron\s*3\s*ultra/i },
  { id: 'dots-studio/dots-3-note-preview:free', label: 'Dots3-Note Preview', match: /dots\s*3[-\s]*note/i },
  { id: 'cohere/north-mini-code:free', label: 'Cohere North Mini Code', match: /north\s*mini\s*code/i },
  { id: 'openrouter/free', label: 'Free Models Router', match: /free\s*models?\s*router/i },
]);

function isFreeModel(model) {
  if (!model || typeof model.id !== 'string' || !MODEL_ID.test(model.id)) return false;
  const pricing = model.pricing && typeof model.pricing === 'object' ? model.pricing : null;
  // Pricing metadata is authoritative. Only when the catalog entry carries no pricing at all do we
  // fall back to the documented free naming (":free" variants and the free router).
  if (!pricing || (pricing.prompt === undefined && pricing.completion === undefined)) return model.id === 'openrouter/free' || model.id.endsWith(':free');
  const prompt = Number(pricing.prompt);
  const completion = Number(pricing.completion);
  const request = Number(pricing.request);
  const image = Number(pricing.image);
  if (Number.isFinite(request) && request > 0) return false;
  if (Number.isFinite(image) && image > 0) return false;
  return prompt === 0 && completion === 0;
}

function displayName(model) {
  const name = String(model.name || model.id).replace(/\s+/g, ' ').trim();
  return (name || model.id).slice(0, 80);
}

// Orders the curated free models first, then the rest of the live free catalog alphabetically.
function freeModelsFrom(list) {
  const free = (Array.isArray(list) ? list : [])
    .filter(isFreeModel)
    .map(model => ({ id: model.id, name: displayName(model), author: model.id.split('/')[0], contextLength: Number(model.context_length) || null, pricing: { prompt: String(model.pricing?.prompt ?? '0'), completion: String(model.pricing?.completion ?? '0') } }));
  const out = [];
  const used = new Set();
  for (const preferred of PREFERRED_FREE_MODELS) {
    const found = free.find(model => model.id === preferred.id) || free.find(model => preferred.match.test(model.name));
    if (found && !used.has(found.id)) {
      out.push({ ...found, preferred: true });
      used.add(found.id);
    }
  }
  const rest = free.filter(model => !used.has(model.id)).sort((a, b) => a.name.localeCompare(b.name));
  return [...out, ...rest].slice(0, MAX_FREE_MODELS);
}

function validationMessage(code) {
  switch (code) {
    case 'not_configured': return 'OpenRouter is not configured on this server. Add OPENROUTER_API_KEY to the backend .env or API.env.';
    case 'invalid_api_key': return 'OpenRouter rejected the server API key. The administrator must update OPENROUTER_API_KEY.';
    case 'provider_forbidden': return 'The OpenRouter API key is not permitted to use this model.';
    case 'billing_required': return 'The OpenRouter account has no available credit.';
    case 'quota_or_rate_limit': return 'OpenRouter rate limit was reached. Free models are limited; wait a moment and retry.';
    case 'provider_unavailable': return 'OpenRouter is temporarily unavailable. Retry shortly.';
    case 'network_error': return 'Could not connect to OpenRouter. Check the server network and retry.';
    case 'provider_timeout': return 'OpenRouter took too long to respond. Please retry.';
    case 'invalid_model': return 'The selected OpenRouter model is unavailable. Choose another model.';
    case 'no_valid_key': return 'No valid OpenRouter key is currently available. Check the keys in the admin panel.';
    case 'empty_response': return 'OpenRouter returned an empty response. Please retry.';
    case 'content_filtered': return 'OpenRouter blocked this request under its content policy.';
    default: return 'OpenRouter could not be validated. Check the server logs and retry.';
  }
}

function createOpenRouterProvider({ HttpError, env = process.env, fetchImpl = globalThis.fetch, logger = console, keys, sleep, random, now = Date.now } = {}) {
  if (!HttpError) throw new Error('HttpError class is required');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');

  const wait = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const jitter = random || Math.random;
  // Without an injected key store (tests, scripts) keys are read from env only and never persisted.
  const store = keys || createOpenRouterKeyStore({ env, persist: false, logger });
  const manager = createKeyManager({ store, now });
  const apiBase = String(env.OPENROUTER_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
  const modelsUrl = `${apiBase}/models`;
  const keyUrl = `${apiBase}/key`;
  const chatUrl = `${apiBase}/chat/completions`;
  let models = [];
  let modelsAt = 0;
  let modelsOk = null;
  let modelsError = null;
  let inflight = null;

  function enabledKeys() { return store.list().filter(item => item.enabled); }
  function configured() { return enabledKeys().length > 0; }
  function keyFormatWarning() {
    for (const item of store.all().filter(entry => entry.enabled)) {
      if (/\s/.test(item.secret)) return `Key ${item.slot} contains whitespace.`;
      if (!item.secret.startsWith('sk-or-')) return `Key ${item.slot}: OpenRouter API keys normally start with "sk-or-".`;
    }
    return null;
  }

  function baseHeaders() {
    return {
      'Content-Type': 'application/json',
      'HTTP-Referer': String(env.OPENROUTER_SITE_URL || 'http://localhost:3001'),
      'X-Title': 'PHOTON AI',
    };
  }
  function authHeaders(secret) { return { ...baseHeaders(), Authorization: `Bearer ${secret}` }; }

  // Maps HTTP / network / abort failures to safe, user-facing HttpErrors. Never includes the key
  // or raw provider text in a response message.
  function mapError(error) {
    if (error instanceof HttpError) return error;
    const status = Number(error?.status || error?.response?.status) || 0;
    const name = String(error?.name || error?.constructor?.name || '');
    const type = String(error?.error?.type || error?.error?.error?.type || '').toLowerCase();
    const detail = String(error?.error?.message || error?.error?.error?.message || error?.message || '').toLowerCase();
    if (name === 'AbortError' || name === 'TimeoutError' || error?.code === 'ABORT_ERR' || error?.code === 'ETIMEDOUT') return new HttpError(504, 'provider_timeout', 'OpenRouter took too long to respond. Please retry.');
    if (name === 'TypeError' || (!status && /fetch failed|network|enotfound|econn|socket|terminated|connect/.test(detail))) return new HttpError(502, 'network_error', 'Could not connect to OpenRouter. Check the server network and retry.');
    if (status === 401) return new HttpError(502, 'invalid_api_key', 'OpenRouter rejected the server API key. The administrator must update OPENROUTER_API_KEY.');
    if (status === 402 || type === 'insufficient_credits' || detail.includes('credit')) return new HttpError(402, 'billing_required', 'The OpenRouter account has no available credit. The administrator must add credit and retry.');
    if (status === 403) return new HttpError(502, 'provider_forbidden', 'The OpenRouter API key is not permitted to use this model.');
    if (status === 404) return new HttpError(502, 'invalid_model', 'The selected OpenRouter model is unavailable. Choose another model.');
    if (status === 408 || status === 504) return new HttpError(504, 'provider_timeout', 'OpenRouter took too long to respond. Please retry.');
    if (status === 413) return new HttpError(413, 'request_too_large', 'The request is too large for OpenRouter. Shorten the message or attachments.');
    if (status === 429 || type === 'rate_limit_exceeded' || type === 'rate_limit_error') return new HttpError(429, 'quota_or_rate_limit', 'OpenRouter rate limit was reached. Free models are limited; wait a moment and retry.');
    if (status === 529 || status === 502 || status === 503) return new HttpError(503, 'provider_unavailable', 'OpenRouter is temporarily unavailable. Retry shortly.');
    if (status >= 500) return new HttpError(503, 'provider_unavailable', 'OpenRouter is temporarily unavailable. Retry shortly.');
    if (status === 400) {
      if (/model.*(not found|invalid|does not exist|unavailable)|no endpoints found/.test(detail)) return new HttpError(502, 'invalid_model', 'The selected OpenRouter model is unavailable. Choose another model.');
      if (/context|too many tokens|maximum.*tokens/.test(detail)) return new HttpError(413, 'request_too_large', 'The conversation is too long for this OpenRouter model. Shorten the message or start a new chat.');
      if (/moderation|content policy|flagged|safety/.test(detail)) return new HttpError(502, 'content_filtered', 'OpenRouter blocked this request under its content policy.');
      return new HttpError(502, 'provider_rejected_request', 'OpenRouter could not process this request. Try simplifying the message or attachments.');
    }
    if (/model.*(not found|invalid|does not exist|unavailable)|no endpoints found/.test(detail)) return new HttpError(502, 'invalid_model', 'The selected OpenRouter model is unavailable. Choose another model.');
    return new HttpError(502, 'provider_error', 'OpenRouter could not complete this request.');
  }

  // Real authenticated request (GET /key) for one specific secret. Throws a mapped, key-free error.
  async function requestKeyInfo(secret) {
    let response;
    try {
      response = await fetchImpl(keyUrl, { method: 'GET', headers: authHeaders(secret), signal: AbortSignal.timeout(KEY_TIMEOUT_MS) });
    } catch (error) { throw mapError(error); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw failureFrom(response, data, 'OpenRouter key check failed');
    return data?.data || {};
  }
  async function validateKey(secret) {
    const value = secret || store.all().find(item => item.enabled)?.secret;
    if (!value) throw new HttpError(503, 'provider_not_configured', 'OpenRouter is not configured on this server.');
    return requestKeyInfo(value);
  }

  // Builds the mapped error for a failed HTTP response, carrying a parsed Retry-After value.
  function failureFrom(response, data, fallback) {
    const bodyCode = Number(data?.error?.code);
    const status = response.ok ? (Number.isFinite(bodyCode) && bodyCode >= 400 ? bodyCode : 502) : response.status;
    const mapped = mapError(Object.assign(new Error(data?.error?.message || fallback), { status, error: data }));
    const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
    if (retryAfterMs !== null && retryAfterMs !== undefined) mapped.retryAfterMs = retryAfterMs;
    return mapped;
  }

  // Validates one key with a real request and records the result. Never throws, never returns the key.
  async function checkKey(item) {
    const checkedAt = new Date().toISOString();
    try {
      const info = await requestKeyInfo(item.secret);
      store.recordValidation(item.id, 'ok', { isFreeTier: typeof info.is_free_tier === 'boolean' ? info.is_free_tier : undefined });
      manager.clear(item.id);
      return { id: item.id, slot: item.slot, status: 'ok', checkedAt, isFreeTier: typeof info.is_free_tier === 'boolean' ? info.is_free_tier : null };
    } catch (error) {
      const mapped = mapError(error);
      store.recordValidation(item.id, mapped.code, { message: mapped.message });
      store.recordResult(item.id, false, { code: mapped.code, message: mapped.message });
      logger.error(JSON.stringify({ category: 'openrouter_key_check', code: mapped.code, status: mapped.status, key: item.id, slot: item.slot }));
      return { id: item.id, slot: item.slot, status: mapped.code, message: mapped.message, checkedAt };
    }
  }
  async function checkMany(items) {
    const results = [];
    let next = 0;
    const worker = async () => { while (next < items.length) { const item = items[next++]; results.push(await checkKey(item)); } };
    await Promise.all(Array.from({ length: Math.min(VALIDATION_CONCURRENCY, items.length) }, worker));
    return results;
  }
  // force: re-check every enabled key. Otherwise only never-checked, stale or transiently failed keys
  // (keys already known to be rejected are only re-tested from the admin panel).
  async function validateKeys(force = false) {
    const due = store.all().filter(item => {
      if (!item.enabled) return false;
      const validation = item.lastValidation;
      if (force || !validation) return true;
      if (AUTH_CODES.has(validation.status)) return false;
      return validation.status !== 'ok' || now() - Date.parse(validation.at) > MODEL_TTL_MS;
    });
    return checkMany(due);
  }

  async function fetchFreeModels() {
    let response;
    try {
      response = await fetchImpl(modelsUrl, { method: 'GET', headers: baseHeaders(), signal: AbortSignal.timeout(KEY_TIMEOUT_MS) });
    } catch (error) { throw mapError(error); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw mapError(Object.assign(new Error(data?.error?.message || 'OpenRouter model list failed'), { status: response.status, error: data }));
    const list = Array.isArray(data?.data) ? data.data : [];
    if (!list.length) throw new HttpError(502, 'provider_error', 'OpenRouter returned an empty model catalog.');
    return freeModelsFrom(list);
  }

  function summarizeFailureCode() {
    const failed = enabledKeys().map(item => item.lastValidation).filter(validation => validation && validation.status !== 'ok');
    if (failed.length && failed.every(validation => AUTH_CODES.has(validation.status))) return failed[0].status;
    return (failed.find(validation => !AUTH_CODES.has(validation.status)) || {}).status || 'provider_error';
  }

  // Never throws. Validates the keys with real requests, then refreshes the live free-model catalog.
  async function refreshModels(force = false) {
    if (!configured()) { models = []; modelsOk = null; modelsError = null; modelsAt = 0; return models; }
    const ttl = modelsOk === false ? MODEL_RETRY_MS : MODEL_TTL_MS;
    if (!force && modelsAt && now() - modelsAt < ttl) return models;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        await validateKeys(force);
        if (!manager.summary().validKeys) {
          const code = summarizeFailureCode();
          throw new HttpError(code === 'invalid_api_key' ? 502 : 503, code, validationMessage(code));
        }
        models = await fetchFreeModels();
        modelsOk = true;
        modelsError = null;
      } catch (error) {
        const mapped = mapError(error);
        modelsOk = false;
        modelsError = mapped.code;
        if (['invalid_api_key', 'provider_forbidden', 'billing_required'].includes(mapped.code)) models = [];
        logger.error(JSON.stringify({ category: 'openrouter_models', code: mapped.code, status: mapped.status }));
      } finally {
        modelsAt = now();
        inflight = null;
      }
      return models;
    })();
    return inflight;
  }

  function status() {
    const validation = !configured() ? 'not_configured' : modelsOk === null ? 'unchecked' : modelsOk ? 'ok' : modelsError;
    const summary = manager.summary();
    return {
      provider: 'OpenRouter',
      configured: configured(),
      validated: configured() && modelsOk === true,
      keyFormatWarning: keyFormatWarning(),
      validation,
      modelCount: models.length,
      freeModelCount: models.length,
      checkedAt: modelsAt ? new Date(modelsAt).toISOString() : null,
      endpoint: chatUrl,
      models: models.map(model => model.id),
      freeModels: models.map(model => ({ id: model.id, name: model.name, provider: model.author, pricing: model.pricing, contextLength: model.contextLength, available: true })),
      ...summary,
      keyCount: summary.totalKeys,
      enabledKeyCount: summary.enabledKeys,
      keys: manager.decorated(),
      recentRequests: manager.recentRequests(),
    };
  }

  function catalogEntries() {
    if (!configured()) {
      return [{ id: 'openrouter', name: 'OpenRouter Free Models', provider: 'OpenRouter', configured: false, supported: true, available: false, reason: validationMessage('not_configured') }];
    }
    if (models.length && modelsOk === true) {
      return models.map(model => ({ id: model.id, name: model.name, provider: 'OpenRouter', configured: true, supported: true, available: true, free: true, author: model.author, pricing: model.pricing, contextLength: model.contextLength, reason: '' }));
    }
    const reason = modelsOk === true ? 'No free OpenRouter models are currently available.' : modelsOk === false ? validationMessage(modelsError) : 'OpenRouter models have not been loaded yet.';
    return [{ id: 'openrouter', name: 'OpenRouter Free Models', provider: 'OpenRouter', configured: true, supported: true, available: false, unavailable: true, reason }];
  }

  // Confirms against the live catalog (refreshed if older than a minute) that a model is offered as
  // free right now, using the pricing metadata the API returned.
  async function verifyModel(id) {
    if (!MODEL_ID.test(String(id || ''))) return { ok: false, code: 'invalid_model', message: validationMessage('invalid_model') };
    await refreshModels(modelsAt > 0 && now() - modelsAt > 60 * 1000);
    if (modelsOk !== true) return { ok: false, code: modelsError || 'provider_error', message: validationMessage(modelsError) };
    const found = models.find(model => model.id === id);
    if (!found) return { ok: false, code: 'invalid_model', message: 'That model is not currently offered as a free OpenRouter model.' };
    return { ok: true, model: found };
  }

  function extractText(message) {
    const content = message?.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) return content.filter(part => part && (part.type === 'text' || part.type === 'output_text')).map(part => String(part.text || '')).join('').trim();
    return '';
  }

  function normalizeUsage(usage) {
    const inputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens) || 0;
    const outputTokens = Number(usage?.completion_tokens ?? usage?.output_tokens) || 0;
    const totalTokens = Number(usage?.total_tokens) || inputTokens + outputTokens;
    const cost = usage?.cost === undefined || usage?.cost === null ? NaN : Number(usage.cost);
    return { inputTokens, outputTokens, totalTokens, ...(Number.isFinite(cost) ? { cost } : {}) };
  }

  function userContent(text, attachments = []) {
    const body = String(text || '').trim() || 'Please review the attached file(s).';
    if (!attachments.length) return body;
    const parts = [];
    for (const file of attachments) {
      if (file.kind === 'text') parts.push({ type: 'text', text: '[Attached text file: ' + file.name + ']\n' + file.text + '\n[End attached file]' });
      else if (file.mimeType === 'application/pdf') parts.push({ type: 'file', file: { filename: String(file.name || 'document.pdf').slice(0, 120), file_data: 'data:application/pdf;base64,' + file.data } });
      else parts.push({ type: 'image_url', image_url: { url: 'data:' + file.mimeType + ';base64,' + file.data } });
    }
    parts.push({ type: 'text', text: body });
    return parts;
  }

  // history: [{ role: 'user'|'assistant'|'model', text }] oldest first.
  function buildMessages({ system, history, text, attachments } = {}) {
    const messages = [];
    const systemText = String(system || '').trim().slice(0, 80000);
    if (systemText) messages.push({ role: 'system', content: systemText });
    const push = (role, content) => {
      const last = messages[messages.length - 1];
      if (last && last.role === role && typeof last.content === 'string' && typeof content === 'string') last.content += '\n\n' + content;
      else messages.push({ role, content });
    };
    let sawUser = false;
    for (const turn of history || []) {
      const body = String(turn?.text || '').trim();
      if (!body) continue;
      const role = turn.role === 'user' ? 'user' : 'assistant';
      if (!sawUser && role === 'assistant') continue;
      if (role === 'user') sawUser = true;
      push(role, body.slice(0, 12000));
    }
    push('user', userContent(text, attachments));
    return messages;
  }

  function buildRequest({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, stream = false } = {}) {
    const params = {
      model,
      messages: buildMessages({ system, history, text, attachments }),
      max_tokens: Math.max(1, Math.min(Number(maxTokens) || MAX_OUTPUT_TOKENS, 32000)),
    };
    if (stream) {
      params.stream = true;
      params.stream_options = { include_usage: true };
    }
    return params;
  }

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

  // Runs `operation(key, attempt)` under the key-selection and retry policy:
  //  * keys are chosen round-robin among enabled, validated, not-paused keys;
  //  * invalid / revoked / forbidden keys are marked and the next key is tried (at most MAX_AUTH_KEYS);
  //  * HTTP 429 is retried on the SAME key after Retry-After / exponential backoff, never on another key
  //    (keys of one account share limits, and rotating would only try to evade them);
  //  * transient network / 5xx failures are retried with backoff, then fail over to one other key;
  //  * billing and request errors are returned immediately; total attempts are hard-capped.
  async function withKey(operation, { signal, model } = {}) {
    if (!configured()) throw new HttpError(503, 'provider_not_configured', validationMessage('not_configured'));
    const unchecked = store.all().filter(item => item.enabled && !item.lastValidation);
    if (unchecked.length) await checkMany(unchecked);
    const tried = [];
    let authFailures = 0;
    let failovers = 0;
    let attempts = 0;
    let lastError = null;
    while (attempts < MAX_TOTAL_ATTEMPTS) {
      const key = manager.acquire({ exclude: tried });
      if (!key) break;
      tried.push(key.id);
      for (let attempt = 0; attempt <= MAX_RETRIES && attempts < MAX_TOTAL_ATTEMPTS; attempt++) {
        attempts++;
        try {
          const out = await operation(key, attempt);
          manager.reportSuccess(key.id, { model, ...(out.info || {}) });
          return { value: out.value, key: { id: key.id, slot: key.slot, label: key.label } };
        } catch (raw) {
          if (signal?.aborted) throw new HttpError(499, 'request_aborted', 'The request was cancelled.');
          const mapped = raw instanceof HttpError ? raw : mapError(raw);
          lastError = mapped;
          const retryable = mapped.code === 'quota_or_rate_limit' || TRANSIENT_CODES.has(mapped.code);
          if (retryable && attempt < MAX_RETRIES && attempts < MAX_TOTAL_ATTEMPTS) {
            const delay = backoffDelay(attempt, mapped.retryAfterMs, jitter);
            logger.error(JSON.stringify({ category: 'openrouter_retry', code: mapped.code, status: mapped.status, attempt: attempt + 1, delay_ms: delay, key: key.id, slot: key.slot }));
            await wait(delay);
            continue;
          }
          manager.reportFailure(key.id, mapped.code, { message: mapped.message, retryAfterMs: mapped.retryAfterMs, model });
          logger.error(JSON.stringify({ category: 'openrouter_request', code: mapped.code, status: mapped.status, key: key.id, slot: key.slot }));
          if (AUTH_CODES.has(mapped.code)) {
            authFailures++;
            if (authFailures >= MAX_AUTH_KEYS) throw mapped;
            break;                                   // next key
          }
          if (TRANSIENT_CODES.has(mapped.code) && failovers < 1) { failovers++; break; }   // one hop to another key
          throw mapped;                              // 429, billing, bad request, empty/blocked, repeated transient
        }
      }
    }
    if (lastError) throw lastError;
    // No eligible key was acquired. If every enabled key was rejected for authentication, surface
    // that specific reason instead of a generic "no valid key" message.
    const enabled = enabledKeys();
    const rejected = enabled.filter(item => item.lastValidation && AUTH_CODES.has(item.lastValidation.status));
    if (enabled.length && rejected.length === enabled.length) throw new HttpError(502, 'invalid_api_key', validationMessage('invalid_api_key'));
    throw new HttpError(503, 'no_valid_key', validationMessage('no_valid_key'));
  }

  async function generate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS }) {
    if (!MODEL_ID.test(String(model || ''))) throw new HttpError(400, 'invalid_model', 'The selected OpenRouter model is invalid.');
    const params = buildRequest({ model, system, history, text, attachments, maxTokens });
    const body = JSON.stringify(params);
    const { value: data, key } = await withKey(async (current) => {
      let response;
      try {
        response = await fetchImpl(chatUrl, { method: 'POST', headers: authHeaders(current.secret), body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (error) { throw mapError(error); }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.error) throw failureFrom(response, payload, 'OpenRouter request failed');
      return { value: payload, info: normalizeUsage(payload?.usage) };
    }, { model });
    const choice = data?.choices?.[0];
    const output = extractText(choice?.message);
    if (!output) throw new HttpError(502, 'empty_response', choice?.finish_reason === 'content_filter' ? 'OpenRouter blocked this request under its content policy.' : 'OpenRouter returned an empty response. Please retry.');
    return { text: output, usage: normalizeUsage(data?.usage), stopReason: choice?.finish_reason || null, model: data?.model || model, key };
  }

  async function* streamGenerate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, signal }) {
    if (!MODEL_ID.test(String(model || ''))) throw new HttpError(400, 'invalid_model', 'The selected OpenRouter model is invalid.');
    const params = buildRequest({ model, system, history, text, attachments, maxTokens, stream: true });
    const body = JSON.stringify(params);
    // Key selection and failover only apply until the provider accepts the stream; once output has
    // started it is never replayed on another key.
    const { value: response, key } = await withKey(async (current) => {
      let res;
      try {
        res = await fetchImpl(chatUrl, { method: 'POST', headers: authHeaders(current.secret), body, signal: combinedSignal(signal, REQUEST_TIMEOUT_MS) });
      } catch (error) {
        if (signal?.aborted) throw new HttpError(499, 'request_aborted', 'The request was cancelled.');
        throw mapError(error);
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw failureFrom(res, data, 'OpenRouter stream failed');
      }
      if (!res.body) throw new HttpError(502, 'provider_error', 'OpenRouter did not return a response stream.');
      return { value: res, info: { stream: true } };
    }, { signal, model });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let usage = null;
    let responseModel = model;
    let finishReason = null;

    function* consumeLine(rawLine) {
      const line = String(rawLine || '').replace(/\r$/, '');
      if (!line || line.startsWith(':') || !line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let event;
      try { event = JSON.parse(payload); } catch { return; }
      if (event?.error) throw mapError(Object.assign(new Error(event.error.message || 'OpenRouter stream error'), { status: 502, error: event }));
      if (event?.model) responseModel = event.model;
      const choice = event?.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === 'string' && delta) {
        full += delta;
        yield { type: 'delta', text: delta };
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (event?.usage) usage = normalizeUsage(event.usage);
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
      try { reader.releaseLock(); } catch {}
    }

    const output = full.trim();
    if (!output) throw new HttpError(502, 'empty_response', finishReason === 'content_filter' ? 'OpenRouter blocked this request under its content policy.' : 'OpenRouter returned an empty response. Please retry.');
    yield { type: 'done', text: output, usage, model: responseModel, stopReason: finishReason, key };
  }

  // Admin "Test connection" for one key: a real GET /key request. Never returns the key.
  async function testKey(id) {
    const item = store.all().find(entry => entry.id === id);
    if (!item) throw new HttpError(404, 'key_not_found', 'That OpenRouter key no longer exists.');
    const result = await checkKey(item);
    if (result.status === 'ok' && modelsOk !== true) { modelsAt = 0; await refreshModels(); }
    return result;
  }
  async function testAll() {
    const results = [];
    for (const item of store.all()) results.push(await checkKey(item));
    modelsAt = 0;
    await refreshModels();
    return results;
  }
  // Admin "Test model": one tiny real completion through the normal key policy (uses free-tier quota).
  async function testModel(id) {
    const started = Date.now();
    const verified = await verifyModel(id);
    if (!verified.ok) return { ok: false, model: id, modelName: id, provider: 'OpenRouter', code: verified.code, status: 'failed', message: verified.message, responseTimeMs: 0, testedAt: new Date().toISOString() };
    try {
      const result = await generate({ model: id, system: 'Reply with one short word.', history: [], text: 'Say ok.', maxTokens: 256 });
      return {
        ok: true,
        model: result.model || id,
        modelName: id,
        provider: 'OpenRouter',
        usage: result.usage,
        reply: result.text || 'ok',
        status: 'working',
        responseTimeMs: Date.now() - started,
        testedAt: new Date().toISOString(),
        key: { id: result.key?.id, slot: result.key?.slot },
      };
    } catch (error) {
      const mapped = mapError(error);
      return {
        ok: false,
        model: id,
        modelName: id,
        provider: 'OpenRouter',
        code: mapped.code,
        status: 'failed',
        message: mapped.message,
        responseTimeMs: Date.now() - started,
        testedAt: new Date().toISOString(),
      };
    }
  }
  function resetCache() { models = []; modelsOk = null; modelsError = null; modelsAt = 0; }

  return { configured, status, refreshModels, catalogEntries, generate, streamGenerate, buildMessages, buildRequest, mapError, validateKey, verifyModel, testKey, testAll, testModel, resetCache, keyManager: manager, apiBase };
}

module.exports = {
  createOpenRouterProvider,
  isFreeModel,
  freeModelsFrom,
  validationMessage,
  MODEL_ID,
  PREFERRED_FREE_MODELS,
  DEFAULT_API_BASE,
};
