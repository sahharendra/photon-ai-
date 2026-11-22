'use strict';
// NVIDIA NIM provider for PHOTON AI.
//
// * Reads NVIDIA_API_KEY only from backend environment (API.env / .env next to server.js).
// * Never returns, logs, or prints the full API key.
// * Base URL: https://integrate.api.nvidia.com/v1 (override with NVIDIA_BASE_URL).
// * Chat completions: /chat/completions (OpenAI-compatible).
// * Model discovery: GET /models.
// * SSE streaming support with usage reporting.
// * Zero-billing safe: strict zero unapproved spending policy enforced before any request.

const { createNvidiaConfig, readEnvKey, maskKey, MODEL_ID, isNvidiaChatModel } = require('./nvidia-config');
const { parseRetryAfter, backoffDelay } = require('./gemini-provider');

const DEFAULT_API_BASE = 'https://integrate.api.nvidia.com/v1';
const MODEL_TTL_MS = 10 * 60 * 1000;
const MODEL_RETRY_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 90 * 1000;
const MAX_RETRIES = 2;
const MAX_OUTPUT_TOKENS = 4096;

function validationMessage(code) {
  switch (code) {
    case 'not_configured': return 'NVIDIA NIM is not configured on this server. Add NVIDIA_API_KEY to API.env or .env.';
    case 'provider_disabled': return 'NVIDIA NIM is disabled by the administrator.';
    case 'billing_blocked': return 'NVIDIA NIM requests are blocked by the zero-billing policy. Set spendingPolicy to allow_free_only in the admin panel.';
    case 'invalid_api_key': return 'NVIDIA NIM rejected the API key. Please check NVIDIA_API_KEY in API.env.';
    case 'provider_forbidden': return 'The NVIDIA API key is not permitted to use this model.';
    case 'billing_required': return 'The NVIDIA NIM account has no available free credits or trial quota. Zero-billing protection is in effect.';
    case 'quota_or_rate_limit': return 'NVIDIA NIM rate limit was reached. Please wait a moment and retry.';
    case 'provider_unavailable': return 'NVIDIA NIM is temporarily unavailable. Retry shortly.';
    case 'provider_overloaded': return 'NVIDIA NIM is temporarily overloaded. Retry shortly.';
    case 'network_error': return 'Could not connect to NVIDIA NIM. Check server internet connectivity and retry.';
    case 'provider_timeout': return 'NVIDIA NIM took too long to respond. Please retry.';
    case 'invalid_model': return 'The selected NVIDIA NIM model is unavailable or not enabled. Choose another model.';
    case 'empty_response': return 'NVIDIA NIM returned an empty response. Please retry.';
    case 'content_filtered': return 'NVIDIA NIM blocked this request under its safety policy.';
    default: return 'NVIDIA NIM could not complete this request.';
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

function createNvidiaProvider({
  HttpError,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  config,
  sleep,
  random,
  now = Date.now,
} = {}) {
  if (!HttpError) throw new Error('HttpError class is required');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');

  const wait = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const jitter = random || Math.random;
  const cfg = config || createNvidiaConfig({ dir: env.PHOTON_DATA_DIR || process.cwd(), env, logger, now });

  const apiBase = String(env.NVIDIA_BASE_URL || env.NVIDIA_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
  const modelsUrl = `${apiBase}/models`;
  const chatUrl = `${apiBase}/chat/completions`;

  let models = [];
  let modelsAt = 0;
  let modelsOk = null;
  let modelsError = null;
  let inflight = null;

  function configured() {
    return Boolean(readEnvKey(env));
  }

  function enabled() {
    return configured() && cfg.isEnabled();
  }

  function secret() {
    const key = readEnvKey(env);
    if (!key) throw new HttpError(503, 'not_configured', validationMessage('not_configured'));
    return key;
  }

  function keyFormatWarning() {
    const key = readEnvKey(env);
    if (!key) return null;
    if (/\s/.test(key)) return 'NVIDIA_API_KEY contains whitespace.';
    if (!key.startsWith('nvapi-')) return 'NVIDIA_API_KEY typically starts with "nvapi-".';
    return null;
  }

  function authHeaders(key) {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'Accept': 'application/json',
    };
  }

  function extractRateLimitHeaders(headers) {
    if (!headers) return {};
    const get = k => {
      if (typeof headers.get === 'function') return headers.get(k);
      return headers[k] ?? headers[k.toLowerCase()];
    };
    return {
      'x-ratelimit-remaining-requests': get('x-ratelimit-remaining-requests'),
      'x-ratelimit-remaining-tokens': get('x-ratelimit-remaining-tokens'),
      'x-ratelimit-reset-requests': get('x-ratelimit-reset-requests'),
      'x-ratelimit-reset-tokens': get('x-ratelimit-reset-tokens'),
      'retry-after': get('retry-after') || get('Retry-After'),
    };
  }

  function mapError(error) {
    if (error instanceof HttpError) return error;
    const status = Number(error?.status || error?.response?.status) || 0;
    const name = String(error?.name || error?.constructor?.name || '');
    const code = String(error?.code || '').toLowerCase();
    const type = String(error?.error?.type || error?.type || '').toLowerCase();
    const detail = String(error?.error?.message || error?.message || '').toLowerCase();

    if (name === 'AbortError' || code === 'abort_err') {
      return new HttpError(499, 'request_aborted', 'The request was cancelled.');
    }
    if (name === 'TimeoutError' || code === 'etimedout' || code === 'provider_timeout') {
      return new HttpError(504, 'provider_timeout', validationMessage('provider_timeout'));
    }
    if (code === 'enotfound' || code === 'econnrefused' || code === 'econnreset' || /network|fetch failed|socket/.test(detail)) {
      return new HttpError(502, 'network_error', validationMessage('network_error'));
    }
    if (status === 401 || /invalid.*api.*key|unauthorized/i.test(detail)) {
      return new HttpError(502, 'invalid_api_key', validationMessage('invalid_api_key'));
    }
    if (status === 402 || /quota|credit|insufficient|payment|billing/i.test(detail)) {
      return new HttpError(402, 'billing_required', validationMessage('billing_required'));
    }
    if (status === 403 || /forbidden|permission/i.test(detail)) {
      return new HttpError(502, 'provider_forbidden', validationMessage('provider_forbidden'));
    }
    if (status === 404 || /model.*not.*found/i.test(detail)) {
      return new HttpError(502, 'invalid_model', validationMessage('invalid_model'));
    }
    if (status === 429 || type === 'rate_limit_exceeded' || /rate.*limit/i.test(detail)) {
      if (/quota|credit|insufficient/i.test(detail)) {
        return new HttpError(402, 'billing_required', validationMessage('billing_required'));
      }
      return new HttpError(429, 'quota_or_rate_limit', validationMessage('quota_or_rate_limit'));
    }
    if (status === 413 || /too large|maximum.*tokens/i.test(detail)) {
      return new HttpError(413, 'request_too_large', 'The conversation exceeds the NVIDIA NIM context window limit.');
    }
    if (status === 400) {
      if (/content.*filter|safety/i.test(detail)) {
        return new HttpError(502, 'content_filtered', validationMessage('content_filtered'));
      }
      return new HttpError(400, 'invalid_request', 'NVIDIA NIM rejected this request. Try simplifying the prompt.');
    }
    if (status === 503 || status === 529 || /overloaded/i.test(detail)) {
      return new HttpError(503, 'provider_overloaded', validationMessage('provider_overloaded'));
    }
    if (status >= 500) {
      return new HttpError(503, 'provider_unavailable', validationMessage('provider_unavailable'));
    }

    return new HttpError(502, 'provider_error', validationMessage('provider_error'));
  }

  function assertBillingPolicy() {
    const policy = cfg.getSpendingPolicy();
    if (policy === 'block') {
      throw new HttpError(402, 'billing_blocked', validationMessage('billing_blocked'));
    }
  }

  async function fetchModels() {
    const key = secret();
    const signal = AbortSignal.timeout(15000);
    let res;
    try {
      res = await fetchImpl(modelsUrl, {
        method: 'GET',
        headers: authHeaders(key),
        signal,
      });
    } catch (err) {
      throw mapError(err);
    }

    const rlHeaders = extractRateLimitHeaders(res.headers);
    cfg.updateRateLimits(rlHeaders);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body?.error?.message || `NVIDIA NIM returned HTTP ${res.status}`);
      err.status = res.status;
      err.error = body?.error;
      throw mapError(err);
    }

    const payload = await res.json().catch(() => ({}));
    const rawList = Array.isArray(payload.data) ? payload.data : [];
    const chatOnly = rawList.filter(m => isNvidiaChatModel(m.id));
    return cfg.syncDiscoveredModels(chatOnly);
  }

  async function refreshModels(force = false) {
    if (!configured()) {
      models = [];
      modelsOk = null;
      modelsError = null;
      modelsAt = 0;
      return [];
    }

    const ttl = modelsOk === false ? MODEL_RETRY_MS : MODEL_TTL_MS;
    if (!force && modelsAt && (now() - modelsAt < ttl) && models.length > 0) {
      return models;
    }

    if (inflight) return inflight;

    inflight = (async () => {
      try {
        const dict = await fetchModels();
        models = Object.values(dict);
        modelsOk = true;
        modelsError = null;
      } catch (err) {
        const mapped = mapError(err);
        modelsOk = false;
        modelsError = mapped.code;
        if (mapped.code === 'invalid_api_key' || mapped.code === 'provider_forbidden' || mapped.code === 'billing_required') {
          models = [];
        }
        logger.error(JSON.stringify({ category: 'nvidia_refresh_models', code: mapped.code, status: mapped.status }));
      } finally {
        modelsAt = now();
        inflight = null;
      }
      return models;
    })();

    return inflight;
  }

  function catalogEntries() {
    if (!configured()) {
      return [{ id: 'nvidia', name: 'NVIDIA NIM', provider: 'NVIDIA', configured: false, supported: true, available: false, free: true, reason: validationMessage('not_configured') }];
    }
    if (!enabled()) {
      return [{ id: 'nvidia', name: 'NVIDIA NIM', provider: 'NVIDIA', configured: true, supported: true, available: false, free: true, reason: validationMessage('provider_disabled') }];
    }

    const snap = cfg.snapshot();
    const modelList = Object.values(snap.models || {});
    const active = modelList.filter(m => m.enabled);

    if (!active.length) {
      return [{
        id: 'nvidia',
        name: 'NVIDIA NIM',
        provider: 'NVIDIA',
        configured: true,
        supported: true,
        available: false,
        free: true,
        reason: modelsOk === false ? validationMessage(modelsError) : 'No NVIDIA NIM models discovered or enabled yet.',
      }];
    }

    return active.map(m => ({
      id: m.id,
      name: m.name,
      provider: 'NVIDIA',
      configured: true,
      supported: true,
      available: true,
      free: true,
      contextLength: m.contextWindow || 131072,
      capabilities: { text: true, vision: m.id.includes('vision') || m.id.includes('vl'), pdf: false },
      reason: '',
    }));
  }

  function buildMessages({ system, history = [], text, attachments = [] } = {}) {
    const messages = [];
    const baseSystem = String(system || '').trim();
    const languageRule = 'IMPORTANT: You must ALWAYS communicate and respond in English by default. Never reply in another language unless the user explicitly asks you to speak in that language.';
    const systemContent = baseSystem
      ? (baseSystem.includes('ENGLISH') ? baseSystem : `${baseSystem}\n\n${languageRule}`)
      : languageRule;
    messages.push({ role: 'system', content: systemContent });

    for (const turn of history) {
      const content = String(turn?.parts?.[0]?.text || turn?.text || turn?.content || '').trim();
      if (!content) continue;
      const role = turn.role === 'assistant' || turn.role === 'model' ? 'assistant' : 'user';
      messages.push({ role, content });
    }

    let userText = String(text || '').trim();
    const hasInline = attachments.some(att => att.kind === 'inline' && att.data);

    if (hasInline) {
      const parts = [];
      let textContent = userText;
      for (const att of attachments) {
        if (att.kind === 'text') {
          textContent += `\n\n[Attached text file: ${att.name}]\n${att.text}\n[End attached file]`;
        }
      }
      if (textContent) {
        parts.push({ type: 'text', text: textContent });
      }
      for (const att of attachments) {
        if (att.kind === 'inline' && att.data) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${att.mimeType || 'image/jpeg'};base64,${att.data}` },
          });
        }
      }
      messages.push({ role: 'user', content: parts.length > 0 ? parts : (userText || 'Please review the attached file(s).') });
    } else {
      if (attachments.length > 0) {
        for (const att of attachments) {
          if (att.kind === 'text') {
            userText += `\n\n[Attached text file: ${att.name}]\n${att.text}\n[End attached file]`;
          }
        }
      }
      if (userText) {
        messages.push({ role: 'user', content: userText });
      }
    }

    return messages;
  }

  async function withRetry(operation) {
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await operation(attempt);
      } catch (raw) {
        const mapped = raw instanceof HttpError ? raw : mapError(raw);
        lastError = mapped;
        const retryable = ['quota_or_rate_limit', 'provider_unavailable', 'provider_overloaded', 'network_error', 'provider_timeout'].includes(mapped.code);
        if (!retryable || attempt >= MAX_RETRIES) throw mapped;

        const delay = backoffDelay(attempt, mapped.retryAfterMs, jitter);
        logger.error(JSON.stringify({ category: 'nvidia_retry', attempt: attempt + 1, code: mapped.code, delayMs: delay }));
        await wait(delay);
      }
    }
    throw lastError || new HttpError(502, 'provider_error', 'NVIDIA NIM request failed after retries.');
  }

  async function generate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, signal }) {
    if (!configured()) throw new HttpError(503, 'not_configured', validationMessage('not_configured'));
    if (!enabled()) throw new HttpError(503, 'provider_disabled', validationMessage('provider_disabled'));
    assertBillingPolicy();

    const chosenModel = model || cfg.getDefaultModelId() || 'meta/llama-3.3-70b-instruct';
    const key = secret();
    const messages = buildMessages({ system, history, text, attachments });
    const payload = {
      model: chosenModel,
      messages,
      max_tokens: Math.max(1, Math.min(Number(maxTokens) || MAX_OUTPUT_TOKENS, 32768)),
      temperature: 0.7,
    };

    const callSignal = combinedSignal(signal, REQUEST_TIMEOUT_MS);

    try {
      const response = await withRetry(async () => {
        let res;
        try {
          res = await fetchImpl(chatUrl, {
            method: 'POST',
            headers: authHeaders(key),
            body: JSON.stringify(payload),
            signal: callSignal,
          });
        } catch (err) {
          throw mapError(err);
        }

        const rl = extractRateLimitHeaders(res.headers);
        cfg.updateRateLimits(rl);

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const err = new Error(body?.error?.message || `HTTP ${res.status}`);
          err.status = res.status;
          err.error = body?.error;
          const mapped = mapError(err);
          const ra = parseRetryAfter(rl['retry-after']);
          if (ra) mapped.retryAfterMs = ra;
          throw mapped;
        }

        return res.json();
      });

      const choice = response?.choices?.[0];
      const outputText = String(choice?.message?.content || '').trim();
      const usage = {
        inputTokens: Number(response?.usage?.prompt_tokens) || 0,
        outputTokens: Number(response?.usage?.completion_tokens) || 0,
        totalTokens: Number(response?.usage?.total_tokens) || 0,
      };

      cfg.recordUsage({ model: chosenModel, ok: true, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });

      return {
        text: outputText,
        model: response?.model || chosenModel,
        usage,
        key: { id: 'nvidia-env', slot: 1 },
      };
    } catch (err) {
      const mapped = mapError(err);
      cfg.recordUsage({ model: chosenModel, ok: false, error: mapped });
      throw mapped;
    }
  }

  async function* streamGenerate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, signal }) {
    if (!configured()) throw new HttpError(503, 'not_configured', validationMessage('not_configured'));
    if (!enabled()) throw new HttpError(503, 'provider_disabled', validationMessage('provider_disabled'));
    assertBillingPolicy();

    const chosenModel = model || cfg.getDefaultModelId() || 'meta/llama-3.3-70b-instruct';
    const key = secret();
    const messages = buildMessages({ system, history, text, attachments });
    const payload = {
      model: chosenModel,
      messages,
      max_tokens: Math.max(1, Math.min(Number(maxTokens) || MAX_OUTPUT_TOKENS, 32768)),
      temperature: 0.7,
      stream: true,
    };

    const callSignal = combinedSignal(signal, REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(chatUrl, {
        method: 'POST',
        headers: authHeaders(key),
        body: JSON.stringify(payload),
        signal: callSignal,
      });
    } catch (err) {
      const mapped = mapError(err);
      cfg.recordUsage({ model: chosenModel, ok: false, error: mapped });
      throw mapped;
    }

    const rl = extractRateLimitHeaders(res.headers);
    cfg.updateRateLimits(rl);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body?.error?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.error = body?.error;
      const mapped = mapError(err);
      cfg.recordUsage({ model: chosenModel, ok: false, error: mapped });
      throw mapped;
    }

    let fullText = '';
    let promptTokens = 0;
    let completionTokens = 0;

    const reader = res.body?.getReader ? res.body.getReader() : null;
    if (reader) {
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;
            if (trimmed === 'data: [DONE]') break;
            if (trimmed.startsWith('data: ')) {
              try {
                const chunk = JSON.parse(trimmed.slice(6));
                const delta = chunk?.choices?.[0]?.delta?.content;
                if (delta) {
                  fullText += delta;
                  yield { type: 'delta', text: delta };
                }
                if (chunk?.usage) {
                  promptTokens = Number(chunk.usage.prompt_tokens) || promptTokens;
                  completionTokens = Number(chunk.usage.completion_tokens) || completionTokens;
                }
              } catch {}
            }
          }
        }
      } catch (err) {
        const mapped = mapError(err);
        cfg.recordUsage({ model: chosenModel, ok: false, error: mapped });
        throw mapped;
      }
    }

    if (!promptTokens) promptTokens = Math.ceil(text?.length / 4) || 10;
    if (!completionTokens) completionTokens = Math.ceil(fullText.length / 4) || 10;
    const usage = { inputTokens: promptTokens, outputTokens: completionTokens, totalTokens: promptTokens + completionTokens };

    cfg.recordUsage({ model: chosenModel, ok: true, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    yield {
      type: 'done',
      text: fullText,
      usage,
      model: chosenModel,
      key: { id: 'nvidia-env', slot: 1 },
    };
  }

  async function testConnection() {
    const started = Date.now();
    if (!configured()) {
      return { ok: false, code: 'not_configured', status: 'not_configured', message: validationMessage('not_configured'), responseTimeMs: 0, testedAt: new Date().toISOString() };
    }
    try {
      const dict = await fetchModels();
      const count = Object.keys(dict).length;
      return { ok: true, code: 'ok', status: 'connected', modelCount: count, maskedKey: maskKey(readEnvKey(env)), responseTimeMs: Date.now() - started, testedAt: new Date().toISOString() };
    } catch (err) {
      const mapped = mapError(err);
      return { ok: false, code: mapped.code, status: mapped.code, message: mapped.message, responseTimeMs: Date.now() - started, testedAt: new Date().toISOString() };
    }
  }

  async function testModel(modelId) {
    const started = Date.now();
    if (!configured()) {
      return { ok: false, code: 'not_configured', status: 'not_configured', message: validationMessage('not_configured'), responseTimeMs: 0, testedAt: new Date().toISOString() };
    }
    const id = String(modelId || '').trim();
    if (!id || !MODEL_ID.test(id)) {
      return { ok: false, code: 'invalid_model', status: 'invalid_model', message: 'Invalid model ID.', responseTimeMs: 0, testedAt: new Date().toISOString() };
    }

    const snap = cfg.snapshot();
    const modelMeta = snap.models?.[id] || {};
    try {
      const res = await generate({
        model: id,
        system: 'Reply with one short word.',
        text: 'Say ok.',
        maxTokens: 10,
      });
      cfg.markModelVerified(id);
      return {
        ok: true,
        model: id,
        modelName: modelMeta.name || id,
        provider: 'NVIDIA NIM',
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
        modelName: modelMeta.name || id,
        provider: 'NVIDIA NIM',
        code: mapped.code,
        status: 'failed',
        message: mapped.message,
        responseTimeMs: Date.now() - started,
        testedAt: new Date().toISOString(),
      };
    }
  }

  function status() {
    const snap = cfg.snapshot();
    const key = readEnvKey(env);
    const modelList = Object.values(snap.models || {});

    const validation = !configured()
      ? 'not_configured'
      : !enabled()
      ? 'provider_disabled'
      : modelsOk === null
      ? 'unchecked'
      : modelsOk
      ? 'ok'
      : modelsError;

    return {
      provider: 'NVIDIA NIM',
      identifier: 'nvidia_nim',
      category: 'LLM / Text Generation',
      protocol: 'OpenAI-compatible',
      apiBase,
      chatEndpoint: '/chat/completions',
      modelsEndpoint: '/models',
      configured: configured(),
      enabled: enabled(),
      validated: configured() && enabled() && modelsOk === true,
      validation,
      keyFormatWarning: keyFormatWarning(),
      maskedKey: maskKey(key),
      spendingPolicy: snap.spendingPolicy,
      defaultModelId: snap.defaultModelId,
      modelCount: modelList.length,
      enabledModelCount: modelList.filter(m => m.enabled).length,
      checkedAt: modelsAt ? new Date(modelsAt).toISOString() : null,
      models: modelList,
      usage: snap.usage,
      rateLimits: snap.rateLimits,
      recentErrors: snap.recentErrors,
    };
  }

  return {
    configured,
    enabled,
    status,
    refreshModels,
    catalogEntries,
    generate,
    streamGenerate,
    testConnection,
    testModel,
    mapError,
    cfg,
  };
}

module.exports = {
  createNvidiaProvider,
  validationMessage,
  DEFAULT_API_BASE,
  MAX_RETRIES,
};
