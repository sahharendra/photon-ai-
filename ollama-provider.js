'use strict';
// Ollama Cloud & Local Provider for PHOTON AI.
//
// * Supports both Ollama Cloud (https://ollama.com with OLLAMA_API_KEY)
//   and local Ollama instances (http://127.0.0.1:11434).
// * Never returns, logs, or prints the full API key.
// * Discovers models from GET /api/tags or GET /v1/models.
// * Streaming support via NDJSON / SSE.
// * Zero-billing safe spending policies.

const { createOllamaConfig, readEnvKey, readEnvBaseUrl, maskKey, MODEL_ID, isOllamaChatModel, isModelFree } = require('./ollama-config');
const { parseRetryAfter, backoffDelay } = require('./gemini-provider');

const MODEL_TTL_MS = 10 * 60 * 1000;
const MODEL_RETRY_MS = 60 * 1000;
const TAGS_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 120 * 1000;
const MAX_RETRIES = 2;
const MAX_OUTPUT_TOKENS = 4096;

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

function validationMessage(code) {
  switch (code) {
    case 'not_configured': return 'Ollama is not configured. Add OLLAMA_API_KEY in the admin panel or start a local Ollama server.';
    case 'provider_disabled': return 'Ollama is disabled by the administrator.';
    case 'billing_blocked': return 'Ollama requests are blocked by the spending policy.';
    case 'invalid_api_key': return 'Ollama rejected the API key. Please check your key at ollama.com/settings/keys.';
    case 'provider_forbidden': return 'The Ollama API key is not permitted to use this model.';
    case 'quota_or_rate_limit': return 'Ollama rate limit was reached. Please wait a moment and retry.';
    case 'network_error': return 'Could not connect to Ollama. Verify your internet connection or local server.';
    case 'provider_timeout': return 'Ollama took too long to respond. Please retry.';
    case 'invalid_model': return 'The selected Ollama model is unavailable or not installed.';
    case 'empty_response': return 'Ollama returned an empty response. Please retry.';
    case 'provider_unavailable': return 'Ollama service is temporarily unavailable.';
    case 'request_aborted': return 'The request was cancelled.';
    default: return 'The Ollama request could not be completed.';
  }
}

function createOllamaProvider({
  HttpError,
  env = process.env,
  fetchImpl = globalThis.fetch,
  cfg = null,
  dir = process.cwd(),
  logger = console,
  sleep,
  random,
  now = Date.now,
} = {}) {
  if (!HttpError) throw new Error('HttpError class is required');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');

  const wait = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const jitter = random || Math.random;
  const config = cfg || createOllamaConfig({ dir, env, logger });

  let models = [];
  let modelsAt = 0;
  let modelsOk = null;
  let modelsError = null;
  let inflight = null;

  function apiKey() { return readEnvKey(env); }
  function baseUrl() { return readEnvBaseUrl(env); }
  function isCloud() { return Boolean(apiKey() || baseUrl().includes('ollama.com')); }
  function configured() { return Boolean(apiKey() || (env.OLLAMA_ENABLED !== '0' && baseUrl())); }
  function enabled() { return config.isEnabled(); }

  function getHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const key = apiKey();
    if (key) {
      headers['Authorization'] = `Bearer ${key}`;
    }
    return headers;
  }

  function mapError(error, statusHint) {
    if (error instanceof HttpError) return error;
    const status = Number(error?.status || statusHint) || 0;
    const name = String(error?.name || error?.constructor?.name || '');
    const detail = String(error?.error?.message || error?.message || '').toLowerCase();

    if (name === 'AbortError' || name === 'TimeoutError' || error?.code === 'ABORT_ERR') {
      return new HttpError(504, 'provider_timeout', validationMessage('provider_timeout'));
    }
    if (status === 401 || detail.includes('unauthorized') || detail.includes('invalid api key')) {
      return new HttpError(401, 'invalid_api_key', validationMessage('invalid_api_key'));
    }
    if (status === 403 || detail.includes('forbidden')) {
      return new HttpError(403, 'provider_forbidden', validationMessage('provider_forbidden'));
    }
    if (status === 429 || detail.includes('rate limit') || detail.includes('quota')) {
      return new HttpError(429, 'quota_or_rate_limit', validationMessage('quota_or_rate_limit'));
    }
    if (status === 404 || detail.includes('not found') || detail.includes('model')) {
      return new HttpError(502, 'invalid_model', validationMessage('invalid_model'));
    }
    if (!status && /fetch failed|network|enotfound|econn|socket|connect|terminated/.test(detail + ' ' + name.toLowerCase())) {
      return new HttpError(502, 'network_error', validationMessage('network_error'));
    }
    if (status >= 500) {
      return new HttpError(503, 'provider_unavailable', validationMessage('provider_unavailable'));
    }
    return new HttpError(502, 'provider_error', detail ? `Ollama error: ${detail}` : validationMessage('provider_error'));
  }

  async function withRetry(operation, { signal } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) throw new HttpError(499, 'request_aborted', validationMessage('request_aborted'));
      try {
        return await operation(attempt);
      } catch (raw) {
        if (signal?.aborted) throw new HttpError(499, 'request_aborted', validationMessage('request_aborted'));
        const mapped = raw instanceof HttpError ? raw : mapError(raw);
        lastError = mapped;
        const retryable = ['provider_unavailable', 'network_error', 'provider_timeout'].includes(mapped.code);
        if (!retryable || attempt >= MAX_RETRIES) throw mapped;
        const delay = backoffDelay(attempt, mapped.retryAfterMs, jitter);
        logger.error(JSON.stringify({ category: 'ollama_retry', code: mapped.code, attempt: attempt + 1, delay_ms: delay }));
        await wait(delay);
      }
    }
    throw lastError || new HttpError(502, 'provider_error', validationMessage('provider_error'));
  }

  async function fetchModels() {
    const base = baseUrl();
    const tagsUrl = `${base}/api/tags`;
    let response;
    try {
      response = await fetchImpl(tagsUrl, {
        method: 'GET',
        headers: getHeaders(),
        signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
      });
    } catch (error) {
      // Fallback: try /v1/models if /api/tags failed
      try {
        const v1Url = `${base}/v1/models`;
        const v1Res = await fetchImpl(v1Url, {
          method: 'GET',
          headers: getHeaders(),
          signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
        });
        if (v1Res.ok) {
          const v1Data = await v1Res.json().catch(() => ({}));
          const list = Array.isArray(v1Data?.data) ? v1Data.data : [];
          const out = [];
          for (const item of list) {
            const id = String(item?.id || '');
            if (!MODEL_ID.test(id) || !isOllamaChatModel(id)) continue;
            out.push({
              id,
              name: String(item?.name || id).slice(0, 80),
              ownedBy: 'ollama',
              created: Number(item?.created) || null,
              contextWindow: 131072,
              free: true,
            });
          }
          if (out.length) return out;
        }
      } catch {}
      throw mapError(error);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw mapError(Object.assign(new Error(data?.error || 'Ollama model list failed'), { status: response.status }));
    }

    const list = Array.isArray(data?.models) ? data.models : [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      const id = String(raw?.name || raw?.model || '');
      if (!MODEL_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: String(raw?.name || id).slice(0, 80),
        size: Number(raw?.size) || null,
        modifiedAt: raw?.modified_at ? String(raw.modified_at).slice(0, 40) : null,
        family: raw?.details?.family ? String(raw.details.family).slice(0, 40) : null,
        parameterSize: raw?.details?.parameter_size ? String(raw.details.parameter_size).slice(0, 40) : null,
        ownedBy: 'ollama',
        created: raw?.modified_at ? Math.floor(new Date(raw.modified_at).getTime() / 1000) : null,
        contextWindow: 131072,
        free: true,
      });
    }

    if (out.length) {
      config.recordDiscoveredModels(out);
    }
    return out;
  }

  async function refreshModels(force = false) {
    if (!configured()) {
      models = [];
      modelsOk = null;
      modelsError = null;
      modelsAt = 0;
      return models;
    }
    const ttl = modelsOk === false ? MODEL_RETRY_MS : MODEL_TTL_MS;
    if (!force && modelsAt && (now() - modelsAt < ttl)) return models;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        models = await fetchModels();
        modelsOk = true;
        modelsError = null;
      } catch (error) {
        const mapped = mapError(error);
        models = [];
        modelsOk = false;
        modelsError = mapped.code;
        logger.error(JSON.stringify({ category: 'ollama_models', code: mapped.code, status: mapped.status }));
      } finally {
        modelsAt = now();
        inflight = null;
      }
      return models;
    })();
    return inflight;
  }

  function defaultModelId() {
    const configuredDefault = config.getDefaultModelId();
    if (configuredDefault && config.isModelEnabled(configuredDefault)) return configuredDefault;
    const all = config.getModels();
    const enabled = Object.values(all).filter(m => m.enabled);
    if (enabled.length) return enabled[0].id;
    return 'gemma4:31b';
  }

  function validateModel(id) {
    if (!MODEL_ID.test(String(id || ''))) throw new HttpError(400, 'invalid_model', 'The selected Ollama model is invalid.');
    if (!configured()) throw new HttpError(503, 'not_configured', validationMessage('not_configured'));
    if (!enabled()) throw new HttpError(403, 'provider_disabled', validationMessage('provider_disabled'));
    const policy = config.getSpendingPolicy();
    if (policy === 'block') throw new HttpError(403, 'billing_blocked', validationMessage('billing_blocked'));
  }

  function userContent(text, attachments = []) {
    const body = String(text || '').trim() || 'Please review the attached file(s).';
    if (!attachments.length) return body;
    const parts = [];
    for (const file of attachments) {
      if (file.kind === 'text') parts.push('[Attached text file: ' + file.name + ']\n' + file.text + '\n[End attached file]');
      else parts.push('[Attached file: ' + file.name + ']');
    }
    parts.push(body);
    return parts.join('\n\n');
  }

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
    return {
      model,
      messages: buildMessages({ system, history, text, attachments }),
      stream: Boolean(stream),
      options: { num_predict: Math.max(1, Math.min(Number(maxTokens) || MAX_OUTPUT_TOKENS, 32768)) },
    };
  }

  function normalizeUsage(data) {
    const inputTokens = Number(data?.prompt_eval_count || data?.usage?.prompt_tokens) || 0;
    const outputTokens = Number(data?.eval_count || data?.usage?.completion_tokens) || 0;
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cost: 0 };
  }

  async function generate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, signal }) {
    validateModel(model);
    const targetModel = model || defaultModelId();
    const chatUrl = `${baseUrl()}/api/chat`;
    const body = JSON.stringify(buildRequest({ model: targetModel, system, history, text, attachments, maxTokens }));
    try {
      const data = await withRetry(async () => {
        let response;
        try {
          response = await fetchImpl(chatUrl, {
            method: 'POST',
            headers: getHeaders(),
            body,
            signal: combinedSignal(signal, REQUEST_TIMEOUT_MS),
          });
        } catch (error) {
          if (signal?.aborted) throw new HttpError(499, 'request_aborted', validationMessage('request_aborted'));
          throw mapError(error);
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.error) {
          throw mapError(Object.assign(new Error(payload?.error || 'Ollama request failed'), { status: response.status, error: payload }));
        }
        return payload;
      }, { signal });

      const output = String(data?.message?.content || '').trim();
      if (!output) throw new HttpError(502, 'empty_response', validationMessage('empty_response'));

      const usage = normalizeUsage(data);
      config.recordSuccess({ modelId: targetModel, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });

      return {
        text: output,
        usage,
        cost: 0,
        stopReason: data?.done_reason || null,
        model: data?.model || targetModel,
        key: { id: isCloud() ? 'ollama-cloud' : 'ollama-local', slot: 1 },
        local: !isCloud(),
        free: true,
      };
    } catch (err) {
      config.recordError({ code: err.code || 'provider_error', message: err.message });
      throw err;
    }
  }

  async function* streamGenerate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, signal }) {
    validateModel(model);
    const targetModel = model || defaultModelId();
    const chatUrl = `${baseUrl()}/api/chat`;
    const body = JSON.stringify(buildRequest({ model: targetModel, system, history, text, attachments, maxTokens, stream: true }));

    let response;
    try {
      response = await withRetry(async () => {
        let res;
        try {
          res = await fetchImpl(chatUrl, {
            method: 'POST',
            headers: getHeaders(),
            body,
            signal: combinedSignal(signal, REQUEST_TIMEOUT_MS),
          });
        } catch (error) {
          if (signal?.aborted) throw new HttpError(499, 'request_aborted', validationMessage('request_aborted'));
          throw mapError(error);
        }
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw mapError(Object.assign(new Error(payload?.error || 'Ollama stream failed'), { status: res.status, error: payload }));
        }
        if (!res.body) throw new HttpError(502, 'provider_error', 'Ollama server did not return a response stream.');
        return res;
      }, { signal });
    } catch (err) {
      config.recordError({ code: err.code || 'provider_error', message: err.message });
      throw err;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let usage = null;
    let finishReason = null;

    function* consumeLine(rawLine) {
      const line = String(rawLine || '').trim();
      if (!line) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event?.error) throw mapError(Object.assign(new Error(event.error), { status: 502, error: event }));
      const delta = event?.message?.content;
      if (typeof delta === 'string' && delta) {
        full += delta;
        yield { type: 'delta', text: delta };
      }
      if (event?.done) {
        usage = normalizeUsage(event);
        finishReason = event?.done_reason || null;
      }
    }

    try {
      while (true) {
        let chunk;
        try { chunk = await reader.read(); } catch (error) {
          if (signal?.aborted) throw new HttpError(499, 'request_aborted', validationMessage('request_aborted'));
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

    const totalUsage = usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
    config.recordSuccess({ modelId: targetModel, inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens });

    yield {
      type: 'done',
      usage: totalUsage,
      text: full,
      stopReason: finishReason,
      model: targetModel,
    };
  }

  async function testConnection() {
    const t0 = now();
    try {
      const discovered = await fetchModels();
      const duration = now() - t0;
      return {
        ok: true,
        modelCount: discovered.length,
        responseTimeMs: duration,
        endpoint: baseUrl(),
        isCloud: isCloud(),
      };
    } catch (err) {
      const duration = now() - t0;
      return {
        ok: false,
        code: err.code || 'connection_failed',
        error: err.message || 'Connection test failed',
        responseTimeMs: duration,
        endpoint: baseUrl(),
        isCloud: isCloud(),
      };
    }
  }

  function catalogEntries() {
    const isConfig = configured();
    const isEn = enabled();
    const allModels = config.getModels();
    return Object.values(allModels).map(m => ({
      id: m.id,
      name: m.name || m.id,
      provider: 'Ollama',
      configured: isConfig,
      supported: true,
      available: isConfig && isEn && m.enabled,
      free: Boolean(m.free),
      contextLength: m.contextWindow || 131072,
      capabilities: { text: true, vision: false, pdf: false },
      reason: !isConfig ? 'Ollama API key or server not configured' : (!isEn ? 'Ollama is disabled' : (!m.enabled ? 'Model is disabled' : '')),
    }));
  }

  function status() {
    const cfgView = config.view();
    return {
      configured: configured(),
      enabled: enabled(),
      spendingPolicy: config.getSpendingPolicy(),
      hasKey: Boolean(apiKey()),
      maskedKey: maskKey(apiKey()),
      endpoint: baseUrl(),
      isCloud: isCloud(),
      defaultModelId: defaultModelId(),
      modelCount: Object.keys(config.getModels()).length,
      models: config.getModels(),
      usage: config.getUsage(),
      recentErrors: config.getRecentErrors(),
      modelsOk,
      modelsError,
    };
  }

  return {
    configured,
    enabled,
    isCloud,
    baseUrl,
    defaultModelId,
    refreshModels,
    generate,
    streamGenerate,
    testConnection,
    catalogEntries,
    status,
    resetCache() { models = []; modelsAt = 0; modelsOk = null; },
  };
}

module.exports = {
  createOllamaProvider,
  DEFAULT_BASE_URL: 'https://ollama.com',
};
