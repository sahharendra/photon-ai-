'use strict';
// CodeCraft provider for PHOTON AI.
// - Reads CODECRAFT_API_KEY only from the backend environment (API.env / .env next to server.js).
// - Uses CodeCraft's OpenAI-compatible Chat Completions API.
// - API base: https://www.codecraftapi.com/v1  (override with CODECRAFT_API_BASE)
// - Models discovered from GET /models at startup and cached for 10 minutes.
// - Streaming via SSE (same OpenAI-compatible format as OpenRouter).
// - Zero-billing enforcement: requests are blocked when spendingPolicy === 'block' (default).
// - The API key never leaves this module: status(), mapError(), and all logs are key-free.

const { createCodeCraftConfig, readEnvKey, maskKey, MODEL_ID, isModelFree } = require('./codecraft-config');
const { parseRetryAfter, backoffDelay } = require('./gemini-provider');

const DEFAULT_API_BASE = 'https://www.codecraftapi.com/v1';
const MODEL_TTL_MS = 10 * 60 * 1000;       // successful model cache TTL
const MODEL_RETRY_MS = 60 * 1000;          // failure retry interval
const KEY_TIMEOUT_MS = 15 * 1000;          // connection test / model fetch
const REQUEST_TIMEOUT_MS = 90 * 1000;      // chat completions
const MAX_RETRIES = 2;                      // per transient failure (429 / 5xx / network)
const MAX_OUTPUT_TOKENS = 4096;

function validationMessage(code) {
  switch (code) {
    case 'not_configured': return 'CodeCraft is not configured on this server. Add CODECRAFT_API_KEY to the backend .env or API.env.';
    case 'provider_disabled': return 'CodeCraft is disabled by the administrator.';
    case 'billing_blocked': return 'CodeCraft requests are blocked by the zero-billing policy. Set spendingPolicy to allow_free_only in the admin panel.';
    case 'invalid_api_key': return 'CodeCraft rejected the server API key. The administrator must update CODECRAFT_API_KEY.';
    case 'provider_forbidden': return 'The CodeCraft API key is not permitted to use this model.';
    case 'billing_required': return 'The CodeCraft account has no available credit or quota. Zero-billing policy is in effect.';
    case 'quota_or_rate_limit': return 'CodeCraft rate limit was reached. Wait a moment and retry.';
    case 'provider_unavailable': return 'CodeCraft is temporarily unavailable. Retry shortly.';
    case 'provider_overloaded': return 'CodeCraft is temporarily overloaded. Retry shortly.';
    case 'network_error': return 'Could not connect to CodeCraft. Check the server network and retry.';
    case 'provider_timeout': return 'CodeCraft took too long to respond. Please retry.';
    case 'invalid_model': return 'The selected CodeCraft model is unavailable or not enabled. Choose another model.';
    case 'empty_response': return 'CodeCraft returned an empty response. Please retry.';
    case 'content_filtered': return 'CodeCraft blocked this request under its content policy.';
    default: return 'CodeCraft could not complete this request.';
  }
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

function createCodeCraftProvider({ HttpError, env = process.env, fetchImpl = globalThis.fetch, logger = console, config, sleep, random, now = Date.now } = {}) {
  if (!HttpError) throw new Error('HttpError class is required');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');

  const wait = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const jitter = random || Math.random;
  const cfg = config || createCodeCraftConfig({ dir: env.PHOTON_DATA_DIR || process.cwd(), env, logger, now });

  const apiBase = String(env.CODECRAFT_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
  const modelsUrl = `${apiBase}/models`;
  const chatUrl = `${apiBase}/chat/completions`;

  let models = [];       // discovered + filtered model list
  let modelsAt = 0;
  let modelsOk = null;   // null=never checked, true=ok, false=error
  let modelsError = null;
  let inflight = null;

  function configured() { return Boolean(readEnvKey(env)); }
  function enabled() { return configured() && cfg.isEnabled(); }

  function secret() {
    const key = readEnvKey(env);
    if (!key) throw new HttpError(503, 'not_configured', validationMessage('not_configured'));
    return key;
  }

  function keyFormatWarning() {
    const key = readEnvKey(env);
    if (!key) return null;
    if (/\s/.test(key)) return 'CODECRAFT_API_KEY contains whitespace.';
    return null;
  }

  function authHeaders(key) {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    };
  }

  // Maps HTTP / network / abort errors to safe, key-free HttpErrors.
  function mapError(error) {
    if (error instanceof HttpError) return error;
    const status = Number(error?.status || error?.response?.status) || 0;
    const name = String(error?.name || error?.constructor?.name || '');
    const type = String(error?.error?.type || error?.error?.error?.type || '').toLowerCase();
    const detail = String(error?.error?.message || error?.message || '').toLowerCase();

    if (name === 'AbortError' || name === 'TimeoutError' || error?.code === 'ABORT_ERR' || error?.code === 'ETIMEDOUT')
      return new HttpError(504, 'provider_timeout', validationMessage('provider_timeout'));
    if (name === 'TypeError' || (!status && /fetch failed|network|enotfound|econn|socket|terminated|connect/.test(detail)))
      return new HttpError(502, 'network_error', validationMessage('network_error'));
    if (status === 401)
      return new HttpError(502, 'invalid_api_key', validationMessage('invalid_api_key'));
    if (status === 402 || type === 'insufficient_credits' || detail.includes('credit') || detail.includes('quota'))
      return new HttpError(402, 'billing_required', validationMessage('billing_required'));
    if (status === 403)
      return new HttpError(502, 'provider_forbidden', validationMessage('provider_forbidden'));
    if (status === 404)
      return new HttpError(502, 'invalid_model', validationMessage('invalid_model'));
    if (status === 408 || status === 504)
      return new HttpError(504, 'provider_timeout', validationMessage('provider_timeout'));
    if (status === 413)
      return new HttpError(413, 'request_too_large', 'The request is too large for CodeCraft. Shorten the message or attachments.');
    if (status === 429 || type === 'rate_limit_exceeded' || type === 'rate_limit_error')
      return new HttpError(429, 'quota_or_rate_limit', validationMessage('quota_or_rate_limit'));
    if (status === 529 || status === 502 || status === 503)
      return new HttpError(503, 'provider_unavailable', validationMessage('provider_unavailable'));
    if (status >= 500)
      return new HttpError(503, 'provider_unavailable', validationMessage('provider_unavailable'));
    if (status === 400) {
      if (/model.*(not found|invalid|does not exist|unavailable)|no endpoints found/.test(detail))
        return new HttpError(502, 'invalid_model', validationMessage('invalid_model'));
      if (/context|too many tokens|maximum.*tokens/.test(detail))
        return new HttpError(413, 'request_too_large', 'The conversation is too long for this CodeCraft model. Shorten the message or start a new chat.');
      if (/moderation|content policy|flagged|safety/.test(detail))
        return new HttpError(502, 'content_filtered', validationMessage('content_filtered'));
      return new HttpError(502, 'provider_rejected_request', 'CodeCraft could not process this request. Try simplifying the message.');
    }
    return new HttpError(502, 'provider_error', validationMessage('provider_error'));
  }

  function failureFrom(response, data, fallback) {
    const bodyCode = Number(data?.error?.code);
    const status = response.ok ? (Number.isFinite(bodyCode) && bodyCode >= 400 ? bodyCode : 502) : response.status;
    const mapped = mapError(Object.assign(new Error(data?.error?.message || fallback), { status, error: data }));
    const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
    if (retryAfterMs !== null && retryAfterMs !== undefined) mapped.retryAfterMs = retryAfterMs;
    return mapped;
  }

  // Zero-billing enforcement: check before every request.
  function assertSpendingPolicy(modelId) {
    const policy = cfg.spendingPolicy();
    if (policy === 'block') {
      throw new HttpError(402, 'billing_blocked', validationMessage('billing_blocked'));
    }
    if (policy === 'allow_free_only') {
      const m = cfg.modelState(modelId);
      if (m && m.pricing && !isModelFree(m)) {
        throw new HttpError(402, 'billing_blocked', 'This CodeCraft model has a non-zero price. Zero-billing policy is in effect.');
      }
    }
    // Policy 'allow_free_only' with no pricing info: allow (free-first assumption).
  }

  async function fetchModels(key) {
    let response;
    try {
      response = await fetchImpl(modelsUrl, {
        method: 'GET',
        headers: authHeaders(key),
        signal: AbortSignal.timeout(KEY_TIMEOUT_MS),
      });
    } catch (error) { throw mapError(error); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw failureFrom(response, data, 'CodeCraft model list failed');
    // OpenAI-compatible: { data: [...] } or just [...].
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    return list;
  }

  // Test connection with a real model list request.
  async function testConnection() {
    const started = Date.now();
    if (!configured()) return { ok: false, code: 'not_configured', status: 'not_configured', message: validationMessage('not_configured'), responseTimeMs: 0, testedAt: new Date().toISOString() };
    try {
      const key = secret();
      const list = await fetchModels(key);
      const modelCount = Array.isArray(list) ? list.length : 0;
      return { ok: true, code: 'ok', status: 'connected', modelCount, message: `Connected. ${modelCount} model(s) available.`, responseTimeMs: Date.now() - started, testedAt: new Date().toISOString(), maskedKey: maskKey(key) };
    } catch (error) {
      const mapped = mapError(error);
      return { ok: false, code: mapped.code, status: mapped.code, message: mapped.message, responseTimeMs: Date.now() - started, testedAt: new Date().toISOString() };
    }
  }

  // Never throws. Refreshes model catalog from API.
  async function refreshModels(force = false) {
    if (!configured()) { models = []; modelsOk = null; modelsError = null; modelsAt = 0; return models; }
    const ttl = modelsOk === false ? MODEL_RETRY_MS : MODEL_TTL_MS;
    if (!force && modelsAt && now() - modelsAt < ttl) return models;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const key = secret();
        const list = await fetchModels(key);
        cfg.setModels(list);
        // Build the in-memory model list from what we just discovered.
        models = Object.values(cfg.state.models).map(m => ({
          id: m.id,
          name: m.name,
          ownedBy: m.ownedBy,
          enabled: m.enabled,
          free: isModelFree(m),
          pricing: m.pricing,
        }));
        modelsOk = true;
        modelsError = null;
      } catch (error) {
        const mapped = mapError(error);
        modelsOk = false;
        modelsError = mapped.code;
        logger.error(JSON.stringify({ category: 'codecraft_models', code: mapped.code, status: mapped.status }));
      } finally {
        modelsAt = now();
        inflight = null;
      }
      return models;
    })();
    return inflight;
  }

  function status() {
    const key = readEnvKey(env);
    const validation = !configured() ? 'not_configured' : !cfg.isEnabled() ? 'provider_disabled' : modelsOk === null ? 'unchecked' : modelsOk ? 'ok' : modelsError;
    const cfgView = cfg.view(env);
    return {
      provider: 'CodeCraft',
      configured: configured(),
      enabled: enabled(),
      validated: configured() && cfg.isEnabled() && modelsOk === true,
      maskedKey: key ? maskKey(key) : null,
      keyFormatWarning: keyFormatWarning(),
      validation,
      endpoint: chatUrl,
      modelCount: models.length,
      enabledModelCount: models.filter(m => m.enabled).length,
      checkedAt: modelsAt ? new Date(modelsAt).toISOString() : null,
      models: cfgView.models,
      spendingPolicy: cfg.spendingPolicy(),
      monthlySpendLimitUsd: cfg.monthlySpendLimitUsd(),
      defaultModelId: cfg.defaultModelId(),
      usage: cfgView.usage,
      recentErrors: cfgView.recentErrors,
    };
  }

  function catalogEntries() {
    if (!configured()) {
      return [{ id: 'codecraft', name: 'CodeCraft AI', provider: 'CodeCraft', configured: false, supported: true, available: false, reason: validationMessage('not_configured') }];
    }
    if (!cfg.isEnabled()) {
      return [{ id: 'codecraft', name: 'CodeCraft AI', provider: 'CodeCraft', configured: true, supported: true, available: false, reason: validationMessage('provider_disabled') }];
    }
    if (models.length && modelsOk === true) {
      return models
        .filter(m => m.enabled)
        .map(m => ({
          id: m.id,
          name: m.name,
          provider: 'CodeCraft',
          configured: true,
          supported: true,
          available: true,
          free: Boolean(m.free),
          pricing: m.pricing,
          reason: '',
        }));
    }
    const reason = modelsOk === null ? 'CodeCraft models have not been loaded yet.' : validationMessage(modelsError);
    return [{ id: 'codecraft', name: 'CodeCraft AI', provider: 'CodeCraft', configured: true, supported: true, available: false, unavailable: true, reason }];
  }

  function extractText(message) {
    const content = message?.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) return content.filter(p => p && p.type === 'text').map(p => String(p.text || '')).join('').trim();
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
      if (file.kind === 'text') {
        parts.push({ type: 'text', text: '[Attached text file: ' + file.name + ']\n' + file.text + '\n[End attached file]' });
      } else if (file.mimeType === 'application/pdf') {
        parts.push({ type: 'text', text: '[Attached PDF: ' + file.name + ' — PDF inline not supported by CodeCraft; text extraction recommended]' });
      } else {
        parts.push({ type: 'image_url', image_url: { url: 'data:' + file.mimeType + ';base64,' + file.data } });
      }
    }
    parts.push({ type: 'text', text: body });
    return parts;
  }

  function buildMessages({ system, history, text, attachments } = {}) {
    const messages = [];
    const baseSystem = String(system || '').trim().slice(0, 80000);
    const languageRule = 'IMPORTANT: You must ALWAYS communicate and respond in English by default. Never reply in another language unless the user explicitly asks you to speak in that language.';
    const systemText = baseSystem
      ? (baseSystem.includes('ENGLISH') ? baseSystem : `${baseSystem}\n\n${languageRule}`)
      : languageRule;
    messages.push({ role: 'system', content: systemText });
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

  // Core retry loop for non-streaming requests.
  async function withRetry(operation, { signal, model } = {}) {
    if (!configured()) throw new HttpError(503, 'not_configured', validationMessage('not_configured'));
    if (!cfg.isEnabled()) throw new HttpError(503, 'provider_disabled', validationMessage('provider_disabled'));
    assertSpendingPolicy(model);
    const key = secret();
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await operation(key, attempt);
      } catch (raw) {
        if (signal?.aborted) throw new HttpError(499, 'request_aborted', 'The request was cancelled.');
        const mapped = raw instanceof HttpError ? raw : mapError(raw);
        lastError = mapped;
        // Non-retriable codes: return immediately.
        const nonRetriable = ['invalid_api_key', 'provider_forbidden', 'billing_required', 'billing_blocked',
          'provider_rejected_request', 'request_too_large', 'content_filtered', 'invalid_model',
          'not_configured', 'provider_disabled', 'request_aborted'];
        if (nonRetriable.includes(mapped.code)) throw mapped;
        if (attempt < MAX_RETRIES) {
          const delay = backoffDelay(attempt, mapped.retryAfterMs, jitter);
          logger.error(JSON.stringify({ category: 'codecraft_retry', code: mapped.code, attempt: attempt + 1, delay_ms: delay }));
          await wait(delay);
        }
      }
    }
    throw lastError || new HttpError(503, 'provider_unavailable', validationMessage('provider_unavailable'));
  }

  async function generate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS }) {
    if (!MODEL_ID.test(String(model || ''))) throw new HttpError(400, 'invalid_model', validationMessage('invalid_model'));
    const params = buildRequest({ model, system, history, text, attachments, maxTokens });
    const body = JSON.stringify(params);
    let data;
    try {
      data = await withRetry(async (key, attempt) => {
        let response;
        try {
          response = await fetchImpl(chatUrl, {
            method: 'POST',
            headers: authHeaders(key),
            body,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch (error) { throw mapError(error); }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.error) throw failureFrom(response, payload, 'CodeCraft request failed');
        return payload;
      }, { model });
    } catch (err) {
      cfg.recordFailure(err?.code || 'provider_error', err?.message || '', model);
      throw err;
    }

    const choice = data?.choices?.[0];
    const output = extractText(choice?.message);
    if (!output) throw new HttpError(502, 'empty_response', choice?.finish_reason === 'content_filter' ? validationMessage('content_filtered') : validationMessage('empty_response'));
    const usage = normalizeUsage(data?.usage);
    cfg.recordSuccess(model, usage);
    return { text: output, usage, stopReason: choice?.finish_reason || null, model: data?.model || model };
  }

  async function* streamGenerate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, signal }) {
    if (!MODEL_ID.test(String(model || ''))) throw new HttpError(400, 'invalid_model', validationMessage('invalid_model'));
    if (!configured()) throw new HttpError(503, 'not_configured', validationMessage('not_configured'));
    if (!cfg.isEnabled()) throw new HttpError(503, 'provider_disabled', validationMessage('provider_disabled'));
    assertSpendingPolicy(model);
    const key = secret();

    const params = buildRequest({ model, system, history, text, attachments, maxTokens, stream: true });
    const body = JSON.stringify(params);

    let response;
    try {
      response = await fetchImpl(chatUrl, {
        method: 'POST',
        headers: authHeaders(key),
        body,
        signal: combinedSignal(signal, REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (signal?.aborted) throw new HttpError(499, 'request_aborted', 'The request was cancelled.');
      throw mapError(error);
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw failureFrom(response, data, 'CodeCraft stream failed');
    }
    if (!response.body) throw new HttpError(502, 'provider_error', 'CodeCraft did not return a response stream.');

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
      if (event?.error) throw mapError(Object.assign(new Error(event.error.message || 'CodeCraft stream error'), { status: 502, error: event }));
      if (event?.model) responseModel = event.model;
      const choice = event?.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === 'string' && delta) { full += delta; yield { type: 'delta', text: delta }; }
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
    if (!output) throw new HttpError(502, 'empty_response', finishReason === 'content_filter' ? validationMessage('content_filtered') : validationMessage('empty_response'));
    const finalUsage = usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    cfg.recordSuccess(model, finalUsage);
    yield { type: 'done', text: output, usage: finalUsage, model: responseModel, stopReason: finishReason };
  }

  // Admin: test one specific model with a minimal real completion.
  async function testModel(id) {
    const started = Date.now();
    if (!MODEL_ID.test(String(id || ''))) return { ok: false, code: 'invalid_model', status: 'invalid_model', message: validationMessage('invalid_model'), responseTimeMs: 0, testedAt: new Date().toISOString() };
    if (!configured()) return { ok: false, code: 'not_configured', status: 'not_configured', message: validationMessage('not_configured'), responseTimeMs: 0, testedAt: new Date().toISOString() };
    if (!cfg.isEnabled()) return { ok: false, code: 'provider_disabled', status: 'provider_disabled', message: validationMessage('provider_disabled'), responseTimeMs: 0, testedAt: new Date().toISOString() };
    // Temporarily bypass spending policy for admin test (admin-initiated, not user request).
    const key = readEnvKey(env);
    if (!key) return { ok: false, code: 'not_configured', status: 'not_configured', message: validationMessage('not_configured'), responseTimeMs: 0, testedAt: new Date().toISOString() };
    try {
      const params = JSON.stringify({ model: id, messages: [{ role: 'user', content: 'Say ok.' }], max_tokens: 10 });
      let response;
      try {
        response = await fetchImpl(chatUrl, { method: 'POST', headers: authHeaders(key), body: params, signal: AbortSignal.timeout(KEY_TIMEOUT_MS) });
      } catch (error) { throw mapError(error); }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.error) throw failureFrom(response, data, 'Model test failed');
      const output = extractText(data?.choices?.[0]?.message);
      const usage = normalizeUsage(data?.usage);
      cfg.markModelVerified(id);
      return {
        ok: true,
        model: data?.model || id,
        modelName: id,
        provider: 'CodeCraft',
        usage,
        output,
        status: 'working',
        responseTimeMs: Date.now() - started,
        testedAt: new Date().toISOString(),
      };
    } catch (error) {
      const mapped = mapError(error);
      cfg.recordFailure(mapped.code, mapped.message, id);
      return {
        ok: false,
        model: id,
        modelName: id,
        provider: 'CodeCraft',
        code: mapped.code,
        status: 'failed',
        message: mapped.message,
        responseTimeMs: Date.now() - started,
        testedAt: new Date().toISOString(),
      };
    }
  }

  function resetCache() { models = []; modelsOk = null; modelsError = null; modelsAt = 0; }

  return {
    configured, enabled, status, refreshModels, catalogEntries,
    generate, streamGenerate, testConnection, testModel, resetCache,
    buildMessages, buildRequest, mapError,
    apiBase,
    get config() { return cfg; },
  };
}

module.exports = {
  createCodeCraftProvider,
  validationMessage,
  MODEL_ID,
  DEFAULT_API_BASE,
};
