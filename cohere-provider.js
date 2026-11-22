'use strict';
// Cohere provider adapter for PHOTON AI.
//
// * Uses Cohere's official API endpoints:
//   - GET https://api.cohere.com/v1/models?endpoint=chat (auth check & model discovery)
//   - POST https://api.cohere.com/v2/chat (chat completions & SSE streaming)
// * Strict key isolation: keys never leave this module or appear in frontend logs.
// * Maps status codes accurately: 200 (connected), 401 (invalid_key), 402 (billing_required),
//   403 (forbidden), 429 (rate_limited), 5xx (provider_unavailable), network/timeout (network_error).

const {
  createCohereConfig,
  readEnvKey,
  maskKey,
  fingerprint,
  isCohereChatModel,
  prettyName,
  DEFAULT_COHERE_MODELS,
  MODEL_ID,
} = require('./cohere-config');

const DEFAULT_API_BASE = 'https://api.cohere.com';
const MODEL_TTL_MS = 10 * 60 * 1000;
const MODEL_RETRY_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 90 * 1000;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_RETRIES = 2;

function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60000);
  const parsed = Date.parse(header);
  if (Number.isFinite(parsed)) return Math.max(0, Math.min(parsed - Date.now(), 60000));
  return null;
}

function combinedSignal(userSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!userSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([userSignal, timeoutSignal]);
  }
  return timeoutSignal;
}

function createCohereProvider({
  HttpError,
  env = process.env,
  config: userCfg,
  fetchImpl = globalThis.fetch,
  logger = console,
  now = Date.now,
} = {}) {
  if (!HttpError) throw new Error('HttpError class is required');
  const cfg = userCfg || createCohereConfig({ env, logger, now });

  let models = Object.values(DEFAULT_COHERE_MODELS);
  let modelsAt = 0;
  let modelsOk = null;
  let modelsError = null;
  let inflight = null;

  function secret() {
    const fromEnv = String(env.COHERE_API_KEY || '').trim();
    if (fromEnv) return fromEnv;
    return (typeof cfg?.getStoredKey === 'function') ? cfg.getStoredKey() : readEnvKey(env);
  }

  function configured() {
    return Boolean(secret());
  }

  function enabled() {
    return configured() && cfg.isEnabled();
  }

  function authHeaders(key = secret()) {
    if (!key) throw new HttpError(503, 'not_configured', 'Cohere is not configured on this server.');
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'Accept': 'application/json',
    };
  }

  function mapError(error) {
    if (error instanceof HttpError) return error;
    const status = Number(error?.status || error?.response?.status) || 0;
    const name = String(error?.name || error?.constructor?.name || '');
    const code = String(error?.code || '').toLowerCase();
    const detail = String(error?.error?.message || error?.message || '').toLowerCase();

    if (name === 'AbortError' || code === 'abort_err') {
      return new HttpError(499, 'request_aborted', 'The request was cancelled.');
    }
    if (name === 'TimeoutError' || code === 'etimedout' || code === 'provider_timeout') {
      return new HttpError(504, 'network_error', 'Cohere took too long to respond (timeout).');
    }
    if (code === 'enotfound' || code === 'econnrefused' || code === 'econnreset' || /network|fetch failed|socket/.test(detail)) {
      return new HttpError(502, 'network_error', 'Could not connect to Cohere. Check server network and retry.');
    }
    if (status === 401 || /invalid.*api.*key|unauthorized|invalid token/i.test(detail)) {
      modelsOk = false;
      modelsError = 'invalid_key';
      return new HttpError(401, 'invalid_key', 'Cohere rejected the API key. Please check your COHERE_API_KEY.');
    }
    if (status === 403 || /forbidden|blocked|permission/i.test(detail)) {
      modelsOk = false;
      modelsError = 'forbidden';
      return new HttpError(403, 'forbidden', 'Cohere account or model access is forbidden.');
    }
    if (status === 402 || /insufficient.*credit|billing|quota exceeded/i.test(detail)) {
      return new HttpError(402, 'billing_required', 'Cohere trial quota or credits exhausted.');
    }
    if (status === 429 || /rate.*limit/i.test(detail)) {
      return new HttpError(429, 'rate_limited', 'Cohere rate limit reached (trial keys are limited to 10 RPM). Please wait a moment.');
    }
    if (status === 404 || /model.*not.*found/i.test(detail)) {
      return new HttpError(404, 'invalid_model', 'The selected Cohere model was not found.');
    }
    if (status >= 500) {
      return new HttpError(503, 'provider_unavailable', 'Cohere service is temporarily unavailable.');
    }
    return new HttpError(502, 'provider_error', error?.message || 'Cohere request failed.');
  }

  async function fetchModels(key = secret()) {
    if (!key) throw new HttpError(503, 'not_configured', 'Cohere is not configured.');
    const url = `${DEFAULT_API_BASE}/v1/models?endpoint=chat`;
    const signal = AbortSignal.timeout(15000);

    let res;
    try {
      res = await fetchImpl(url, { method: 'GET', headers: authHeaders(key), signal });
    } catch (err) {
      throw mapError(err);
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body?.message || `Cohere HTTP ${res.status}`);
      err.status = res.status;
      err.error = body;
      throw mapError(err);
    }

    const data = await res.json().catch(() => ({}));
    const rawList = Array.isArray(data?.models) ? data.models : [];
    return cfg.syncDiscoveredModels(rawList);
  }

  async function refreshModels(force = false) {
    if (!configured()) {
      models = Object.values(DEFAULT_COHERE_MODELS);
      modelsOk = null;
      modelsError = null;
      modelsAt = 0;
      return models;
    }

    const ttl = modelsOk === false ? MODEL_RETRY_MS : MODEL_TTL_MS;
    if (!force && modelsAt && now() - modelsAt < ttl) return models;
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        const dict = await fetchModels();
        models = Object.values(dict);
        modelsOk = true;
        modelsError = null;
        modelsAt = now();
        return models;
      } catch (err) {
        const mapped = mapError(err);
        modelsOk = false;
        modelsError = mapped.code;
        modelsAt = now();
        models = Object.values(DEFAULT_COHERE_MODELS);
        return models;
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  }

  async function testConnection() {
    const started = Date.now();
    if (!configured()) {
      return {
        ok: false,
        code: 'not_configured',
        status: 'not_configured',
        message: 'Cohere is not configured on this server. Add COHERE_API_KEY to API.env.',
        responseTimeMs: 0,
        testedAt: new Date().toISOString(),
      };
    }

    try {
      const dict = await fetchModels();
      const count = Object.keys(dict).length;
      modelsOk = true;
      modelsError = null;
      modelsAt = Date.now();
      models = Object.values(dict);
      return {
        ok: true,
        code: 'ok',
        status: 'connected',
        modelCount: count,
        maskedKey: maskKey(secret()),
        responseTimeMs: Date.now() - started,
        testedAt: new Date().toISOString(),
      };
    } catch (err) {
      const mapped = mapError(err);
      modelsOk = false;
      modelsError = mapped.code;
      modelsAt = Date.now();
      return {
        ok: false,
        code: mapped.code,
        status: mapped.code,
        message: mapped.message,
        responseTimeMs: Date.now() - started,
        testedAt: new Date().toISOString(),
      };
    }
  }

  function buildMessages({ system, history = [], text, attachments = [] } = {}) {
    const messages = [];
    const baseSystem = String(system || '').trim();
    if (baseSystem) {
      messages.push({ role: 'system', content: baseSystem });
    }

    for (const turn of history) {
      const body = String(turn?.parts?.[0]?.text || turn?.text || turn?.content || '').trim();
      if (!body) continue;
      const role = turn.role === 'assistant' || turn.role === 'model' ? 'assistant' : 'user';
      messages.push({ role, content: body });
    }

    let userText = String(text || '').trim();
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

    return messages;
  }

  async function generate({
    model,
    system,
    history,
    text,
    attachments,
    maxTokens = MAX_OUTPUT_TOKENS,
    signal,
  } = {}) {
    if (!configured()) throw new HttpError(503, 'not_configured', 'Cohere is not configured.');
    if (!enabled()) throw new HttpError(503, 'provider_disabled', 'Cohere is disabled in admin settings.');

    const chosenModel = model || cfg.getDefaultModelId() || 'command-r-plus-08-2024';
    const messages = buildMessages({ system, history, text, attachments });
    const url = `${DEFAULT_API_BASE}/v2/chat`;

    const payload = {
      model: chosenModel,
      messages,
      max_tokens: Math.max(1, Math.min(Number(maxTokens) || MAX_OUTPUT_TOKENS, 4096)),
      temperature: 0.7,
    };

    const callSignal = combinedSignal(signal, REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload),
        signal: callSignal,
      });
    } catch (err) {
      const mapped = mapError(err);
      cfg.recordUsage({ model: chosenModel, ok: false, error: mapped });
      throw mapped;
    }

    cfg.updateRateLimits(res.headers);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body?.message || `Cohere HTTP ${res.status}`);
      err.status = res.status;
      err.error = body;
      const mapped = mapError(err);
      cfg.recordUsage({ model: chosenModel, ok: false, error: mapped });
      throw mapped;
    }

    const data = await res.json();
    const content = data?.message?.content?.[0]?.text || '';
    const inTok = Number(data?.usage?.tokens?.input_tokens) || Math.ceil((text?.length || 10) / 4);
    const outTok = Number(data?.usage?.tokens?.output_tokens) || Math.ceil((content.length || 10) / 4);
    const usage = { inputTokens: inTok, outputTokens: outTok, totalTokens: inTok + outTok };

    cfg.recordUsage({ model: chosenModel, ok: true, inputTokens: inTok, outputTokens: outTok });

    return {
      text: content,
      model: data?.model || chosenModel,
      usage,
      key: { id: 'cohere-env', slot: 1 },
    };
  }

  async function* streamGenerate({
    model,
    system,
    history,
    text,
    attachments,
    maxTokens = MAX_OUTPUT_TOKENS,
    signal,
  } = {}) {
    if (!configured()) throw new HttpError(503, 'not_configured', 'Cohere is not configured.');
    if (!enabled()) throw new HttpError(503, 'provider_disabled', 'Cohere is disabled in admin settings.');

    const chosenModel = model || cfg.getDefaultModelId() || 'command-r-plus-08-2024';
    const messages = buildMessages({ system, history, text, attachments });
    const url = `${DEFAULT_API_BASE}/v2/chat`;

    const payload = {
      model: chosenModel,
      messages,
      max_tokens: Math.max(1, Math.min(Number(maxTokens) || MAX_OUTPUT_TOKENS, 4096)),
      temperature: 0.7,
      stream: true,
    };

    const callSignal = combinedSignal(signal, REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload),
        signal: callSignal,
      });
    } catch (err) {
      const mapped = mapError(err);
      cfg.recordUsage({ model: chosenModel, ok: false, error: mapped });
      throw mapped;
    }

    cfg.updateRateLimits(res.headers);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body?.message || `Cohere HTTP ${res.status}`);
      err.status = res.status;
      err.error = body;
      const mapped = mapError(err);
      cfg.recordUsage({ model: chosenModel, ok: false, error: mapped });
      throw mapped;
    }

    let fullText = '';
    let inTokens = Math.ceil((text?.length || 10) / 4);
    let outTokens = 0;

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
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const payloadStr = trimmed.slice(5).trim();
            if (payloadStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payloadStr);
              if (parsed.type === 'content-delta') {
                const deltaText = parsed.delta?.message?.content?.text || '';
                if (deltaText) {
                  fullText += deltaText;
                  yield { type: 'delta', text: deltaText };
                }
              }
              if (parsed.type === 'message-end' && parsed.delta?.usage?.tokens) {
                inTokens = Number(parsed.delta.usage.tokens.input_tokens) || inTokens;
                outTokens = Number(parsed.delta.usage.tokens.output_tokens) || outTokens;
              }
            } catch (_) {}
          }
        }
      } finally {
        reader.releaseLock?.();
      }
    } else {
      // Fallback for non-streaming reader
      const fallbackData = await res.json().catch(() => ({}));
      fullText = fallbackData?.message?.content?.[0]?.text || '';
      yield { type: 'delta', text: fullText };
    }

    if (!outTokens) outTokens = Math.ceil(fullText.length / 4);
    const usage = { inputTokens: inTokens, outputTokens: outTokens, totalTokens: inTokens + outTokens };
    cfg.recordUsage({ model: chosenModel, ok: true, inputTokens: inTokens, outputTokens: outTokens });

    yield {
      type: 'done',
      text: fullText,
      model: chosenModel,
      usage,
    };
  }

  async function testModel(modelId) {
    const started = Date.now();
    if (!configured()) {
      return { ok: false, code: 'not_configured', status: 'not_configured', message: 'Cohere is not configured.', responseTimeMs: 0, testedAt: new Date().toISOString() };
    }
    const id = String(modelId || '').trim();
    try {
      const res = await generate({
        model: id,
        system: 'Reply with one short word.',
        text: 'Say ok.',
        maxTokens: 50,
      });
      cfg.markModelVerified(id);
      return {
        ok: true,
        model: id,
        modelName: prettyName(id),
        provider: 'Cohere',
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
        modelName: prettyName(id),
        provider: 'Cohere',
        code: mapped.code,
        status: 'failed',
        message: mapped.message,
        responseTimeMs: Date.now() - started,
        testedAt: new Date().toISOString(),
      };
    }
  }

  function catalogEntries() {
    const isAvail = configured() && enabled() && modelsOk !== false;
    return models.map(m => ({
      id: m.id,
      name: m.name,
      provider: 'Cohere',
      providerKey: 'cohere',
      category: 'Text Generation',
      task: 'text-generation',
      available: isAvail,
      configured: configured(),
      enabled: enabled(),
      free: true,
      freeTierEligible: true,
      contextWindow: m.contextWindow || 128000,
    }));
  }

  function status() {
    const snap = cfg.snapshot();
    const key = secret();
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
      provider: 'Cohere',
      id: 'cohere',
      configured: configured(),
      enabled: enabled(),
      validated: configured() && enabled() && modelsOk === true,
      validation,
      maskedKey: maskKey(key),
      fingerprint: fingerprint(key),
      spendingPolicy: snap.spendingPolicy,
      defaultModelId: snap.defaultModelId,
      modelCount: Object.keys(snap.models || {}).length,
      models: Object.keys(snap.models || {}),
      availableModels: catalogEntries(),
      usage: snap.usage,
      rateLimits: snap.rateLimits,
      recentErrors: snap.recentErrors,
    };
  }

  function resetCache() {
    models = Object.values(DEFAULT_COHERE_MODELS);
    modelsOk = null;
    modelsError = null;
    modelsAt = 0;
  }

  return {
    configured,
    enabled,
    status,
    refreshModels,
    catalogEntries,
    testConnection,
    testModel,
    generate,
    streamGenerate,
    resetCache,
    mapError,
  };
}

module.exports = {
  createCohereProvider,
};
