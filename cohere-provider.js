'use strict';
// Cohere API provider for PHOTON AI.
//
// * Uses official Cohere API v2: https://api.cohere.com/v2/chat.
// * Reads COHERE_API_KEY only from backend environment (API.env / .env next to server.js).
// * Never returns, logs, or prints raw API keys.
// * Model discovery: GET https://api.cohere.com/v1/models (chat endpoints).
// * SSE streaming support via /v2/chat with stream: true.
// * Strict Free Trial Protection:
//   - Cohere Trial keys are restricted to development/testing; blocked from commercial customer traffic.
//   - Monthly trial request limit enforced with zero paid fallback.
//   - Production keys require explicit administrator authorization for paid usage.

const {
  createCohereConfig,
  readEnvKey,
  maskKey,
  MODEL_ID,
  isCohereChatModel,
} = require('./cohere-config');
const { parseRetryAfter, backoffDelay } = require('./gemini-provider');

const COHERE_API_BASE = 'https://api.cohere.com';
const MODEL_TTL_MS = 10 * 60 * 1000;
const MODEL_RETRY_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 90 * 1000;
const MAX_RETRIES = 2;
const MAX_OUTPUT_TOKENS = 4096;

function validationMessage(code) {
  switch (code) {
    case 'not_configured':
      return 'Cohere is not configured. Add COHERE_API_KEY in the admin panel or environment.';
    case 'provider_disabled':
      return 'Cohere is disabled by the administrator.';
    case 'trial_restricted':
      return 'Cohere Trial API keys are restricted to development/testing only and cannot serve public commercial production traffic.';
    case 'billing_unauthorized':
      return 'Cohere Production key requires explicit administrator authorization for paid billing in the admin panel.';
    case 'billing_blocked':
      return 'Cohere requests are blocked by the spending policy. Set spendingPolicy to allow_free_only in the admin panel.';
    case 'quota_exhausted':
    case 'billing_required':
      return 'Cohere monthly trial request allowance has been exhausted for this month. Zero-billing protection prevents unapproved charges.';
    case 'invalid_api_key':
      return 'Cohere rejected the API key. Please verify COHERE_API_KEY in the admin panel.';
    case 'provider_forbidden':
      return 'Cohere API key does not have permission to access this model or resource.';
    case 'quota_or_rate_limit':
      return 'Cohere rate limit reached (Trial keys allow limited requests/minute). Please wait a moment and retry.';
    case 'provider_unavailable':
      return 'Cohere is temporarily unavailable. Retry shortly.';
    case 'provider_overloaded':
      return 'Cohere is temporarily overloaded. Retry shortly.';
    case 'network_error':
      return 'Could not connect to Cohere. Check server internet connectivity and retry.';
    case 'provider_timeout':
      return 'Cohere took too long to respond. Please retry.';
    case 'invalid_model':
      return 'The selected Cohere model is unavailable or not enabled. Choose another model.';
    case 'empty_response':
      return 'Cohere returned an empty response. Please retry.';
    default:
      return 'Cohere could not complete this request.';
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

function createCohereProvider({
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
  const cfg = config || createCohereConfig({ dir: env.PHOTON_DATA_DIR || process.cwd(), env, logger, now });

  const apiBase = String(env.COHERE_BASE_URL || env.COHERE_API_BASE || COHERE_API_BASE).replace(/\/+$/, '');
  const chatUrl = `${apiBase}/v2/chat`;
  const modelsUrl = `${apiBase}/v1/models`;

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

  function authHeaders(key) {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'Accept': 'application/json',
    };
  }

  function keyFormatWarning() {
    const key = readEnvKey(env);
    if (!key) return null;
    if (/\s/.test(key)) return 'COHERE_API_KEY contains whitespace.';
    return null;
  }

  function extractRateLimitHeaders(headers) {
    if (!headers) return {};
    const get = k => (typeof headers.get === 'function' ? headers.get(k) : headers[k] ?? headers[k?.toLowerCase()]);
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
    if (status === 401 || /invalid.*api.*key|unauthorized|invalid token/i.test(detail)) {
      return new HttpError(502, 'invalid_api_key', validationMessage('invalid_api_key'));
    }
    if (status === 403 || /forbidden|permission/i.test(detail)) {
      return new HttpError(502, 'provider_forbidden', validationMessage('provider_forbidden'));
    }
    if (status === 404 || /model.*not.*found/i.test(detail)) {
      return new HttpError(502, 'invalid_model', validationMessage('invalid_model'));
    }
    if (status === 429 || /rate.*limit|too many requests/i.test(detail)) {
      return new HttpError(429, 'quota_or_rate_limit', validationMessage('quota_or_rate_limit'));
    }
    if (status === 402 || /quota|billing|credit|trial.*exhausted/i.test(detail)) {
      return new HttpError(402, 'quota_exhausted', validationMessage('quota_exhausted'));
    }
    if (status >= 500) {
      return new HttpError(503, 'provider_unavailable', validationMessage('provider_unavailable'));
    }
    return new HttpError(502, 'provider_error', validationMessage('provider_error'));
  }

  function assertTrialPolicy({ isProductionTraffic = false } = {}) {
    const policy = cfg.getSpendingPolicy();
    if (policy === 'block') {
      throw new HttpError(402, 'billing_blocked', validationMessage('billing_blocked'));
    }

    const keyType = cfg.getKeyType();
    if (keyType === 'trial') {
      // Mandatory restriction: Trial keys cannot serve commercial public customer traffic
      if (isProductionTraffic) {
        throw new HttpError(403, 'trial_restricted', validationMessage('trial_restricted'));
      }
      if (cfg.isMonthlyTrialExhausted()) {
        throw new HttpError(402, 'quota_exhausted', validationMessage('quota_exhausted'));
      }
    } else if (keyType === 'production') {
      if (!cfg.isProductionAuthorized()) {
        throw new HttpError(403, 'billing_unauthorized', validationMessage('billing_unauthorized'));
      }
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
      const err = new Error(body?.message || `Cohere returned HTTP ${res.status}`);
      err.status = res.status;
      throw mapError(err);
    }

    const payload = await res.json().catch(() => ({}));
    const rawList = Array.isArray(payload.models) ? payload.models : (Array.isArray(payload.data) ? payload.data : []);
    const chatOnly = rawList.filter(m => isCohereChatModel(m.name || m.id));
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
        if (mapped.code === 'invalid_api_key' || mapped.code === 'provider_forbidden') {
          models = [];
        }
        logger.error(JSON.stringify({ category: 'cohere_refresh_models', code: mapped.code, status: mapped.status }));
      } finally {
        modelsAt = now();
        inflight = null;
      }
      return models;
    })();

    return inflight;
  }

  function catalogEntries() {
    const isTrial = cfg.getKeyType() === 'trial';
    if (!configured()) {
      return [{ id: 'cohere', name: 'Cohere', provider: 'Cohere', providerId: 'cohere', configured: false, supported: true, available: false, free: true, reason: validationMessage('not_configured') }];
    }
    if (!enabled()) {
      return [{ id: 'cohere', name: 'Cohere', provider: 'Cohere', providerId: 'cohere', configured: true, supported: true, available: false, free: true, reason: validationMessage('provider_disabled') }];
    }

    const snap = cfg.snapshot();
    const modelList = Object.values(snap.models || {});
    const active = modelList.filter(m => m.enabled);

    if (!active.length) {
      return [{
        id: 'cohere',
        name: 'Cohere',
        provider: 'Cohere',
        providerId: 'cohere',
        configured: true,
        supported: true,
        available: false,
        free: true,
        reason: modelsOk === false ? validationMessage(modelsError) : 'No Cohere models discovered or enabled yet.',
      }];
    }

    return active.map(m => ({
      id: m.id,
      name: m.name + (isTrial ? ' (Trial)' : ''),
      provider: 'Cohere',
      providerId: 'cohere',
      configured: true,
      supported: true,
      available: Boolean(configured() && enabled() && !snap.isMonthlyTrialExhausted),
      free: isTrial,
      trial: isTrial,
      contextLength: m.contextWindow || 128000,
      capabilities: { text: true, vision: false, pdf: false },
      reason: snap.isMonthlyTrialExhausted ? validationMessage('quota_exhausted') : '',
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
        logger.error(JSON.stringify({ category: 'cohere_retry', attempt: attempt + 1, code: mapped.code, delayMs: delay }));
        await wait(delay);
      }
    }
    throw lastError || new HttpError(502, 'provider_error', 'Cohere request failed after retries.');
  }

  async function generate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, signal, isProductionTraffic = false }) {
    if (!configured()) throw new HttpError(503, 'not_configured', validationMessage('not_configured'));
    if (!enabled()) throw new HttpError(503, 'provider_disabled', validationMessage('provider_disabled'));
    assertTrialPolicy({ isProductionTraffic });

    const chosenModel = model || cfg.getDefaultModelId() || 'command-r-08-2024';
    const key = secret();
    const messages = buildMessages({ system, history, text, attachments });
    const payload = {
      model: chosenModel,
      messages,
      max_tokens: Math.max(1, Math.min(Number(maxTokens) || MAX_OUTPUT_TOKENS, 4096)),
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
          const errMsg = body?.message || `Cohere HTTP ${res.status}`;
          const err = new Error(errMsg);
          err.status = res.status;
          err.error = body;
          const mapped = mapError(err);
          const ra = parseRetryAfter(rl['retry-after']);
          if (ra) mapped.retryAfterMs = ra;
          throw mapped;
        }

        return res.json();
      });

      // Extract generated text from Cohere v2 format: response.message.content[0].text or text
      let outputText = '';
      if (Array.isArray(response?.message?.content)) {
        outputText = response.message.content.map(c => c.text || '').join('');
      } else if (typeof response?.message?.content === 'string') {
        outputText = response.message.content;
      } else if (response?.text) {
        outputText = response.text;
      }
      outputText = outputText.trim();

      const usage = {
        inputTokens: Number(response?.usage?.tokens?.input_tokens || response?.usage?.input_tokens) || Math.ceil((text?.length || 10) / 4),
        outputTokens: Number(response?.usage?.tokens?.output_tokens || response?.usage?.output_tokens) || Math.ceil((outputText.length || 10) / 4),
        totalTokens: 0,
      };
      usage.totalTokens = usage.inputTokens + usage.outputTokens;

      cfg.recordUsage({ model: chosenModel, ok: true, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });

      return {
        text: outputText,
        model: response?.model || chosenModel,
        usage,
        key: { id: 'cohere-env', slot: 1 },
      };
    } catch (err) {
      const mapped = mapError(err);
      cfg.recordUsage({ model: chosenModel, ok: false, error: mapped });
      throw mapped;
    }
  }

  async function* streamGenerate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, signal, isProductionTraffic = false }) {
    if (!configured()) throw new HttpError(503, 'not_configured', validationMessage('not_configured'));
    if (!enabled()) throw new HttpError(503, 'provider_disabled', validationMessage('provider_disabled'));
    assertTrialPolicy({ isProductionTraffic });

    const chosenModel = model || cfg.getDefaultModelId() || 'command-r-08-2024';
    const key = secret();
    const messages = buildMessages({ system, history, text, attachments });
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
      const errMsg = body?.message || `Cohere HTTP ${res.status}`;
      const err = new Error(errMsg);
      err.status = res.status;
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
                // Cohere v2 streaming: chunk.delta.message.content.text
                const delta = chunk?.delta?.message?.content?.text || chunk?.text;
                if (delta) {
                  fullText += delta;
                  yield { type: 'delta', text: delta };
                }
                const usageData = chunk?.delta?.usage?.tokens || chunk?.usage?.tokens;
                if (usageData) {
                  promptTokens = Number(usageData.input_tokens) || promptTokens;
                  completionTokens = Number(usageData.output_tokens) || completionTokens;
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
      key: { id: 'cohere-env', slot: 1 },
    };
  }

  async function testConnection() {
    const started = Date.now();
    if (!configured()) {
      return {
        ok: false,
        code: 'not_configured',
        status: 'not_configured',
        message: validationMessage('not_configured'),
        responseTimeMs: 0,
        testedAt: new Date().toISOString(),
      };
    }

    const key = secret();
    try {
      const dict = await fetchModels();
      models = Object.values(dict);
      modelsOk = true;
      modelsError = null;
      modelsAt = now();
      const count = Object.keys(dict).length;
      return {
        ok: true,
        code: 'ok',
        status: 'connected',
        modelCount: count,
        maskedKey: maskKey(key),
        keyType: cfg.getKeyType(),
        responseTimeMs: Date.now() - started,
        testedAt: new Date().toISOString(),
      };
    } catch (err) {
      const mapped = mapError(err);
      modelsOk = false;
      modelsError = mapped.code;
      modelsAt = now();
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

  async function testModel(modelId) {
    const started = Date.now();
    if (!configured()) {
      return {
        ok: false,
        code: 'not_configured',
        status: 'not_configured',
        message: validationMessage('not_configured'),
        responseTimeMs: 0,
        testedAt: new Date().toISOString(),
      };
    }

    const id = String(modelId || '').trim();
    if (!id || !MODEL_ID.test(id)) {
      return {
        ok: false,
        code: 'invalid_model',
        status: 'invalid_model',
        message: 'Invalid model ID format.',
        responseTimeMs: 0,
        testedAt: new Date().toISOString(),
      };
    }

    const snap = cfg.snapshot();
    const modelMeta = snap.models?.[id] || {};

    try {
      // testModel runs in development test mode (isProductionTraffic: false)
      const res = await generate({
        model: id,
        system: 'Reply with one short word.',
        text: 'Reply with: PHOTON Cohere integration successful.',
        maxTokens: 50,
        isProductionTraffic: false,
      });
      cfg.markModelVerified(id);
      return {
        ok: true,
        model: id,
        modelName: modelMeta.name || id,
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
        modelName: modelMeta.name || id,
        provider: 'Cohere',
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
      provider: 'Cohere',
      id: 'cohere',
      identifier: 'cohere',
      category: 'LLM / Text Generation',
      protocol: 'Cohere API v2',
      apiVersion: 'v2',
      apiBase,
      chatEndpoint: '/v2/chat',
      modelsEndpoint: '/v1/models',
      configured: configured(),
      enabled: enabled(),
      validated: configured() && enabled() && modelsOk === true,
      validation,
      keyType: snap.keyType, // 'trial' or 'production'
      keyTypeLabel: snap.keyType === 'trial' ? 'Trial – Development Only' : 'Production',
      productionAuthorized: snap.productionAuthorized,
      environmentAvailability: snap.keyType === 'trial' ? 'Development / Testing Only' : (snap.productionAuthorized ? 'Production Authorized' : 'Production Unauthorized'),
      keyFormatWarning: keyFormatWarning(),
      maskedKey: maskKey(key),
      spendingPolicy: snap.spendingPolicy,
      monthlyTrialLimit: snap.monthlyTrialLimit,
      remainingTrialRequests: snap.remainingTrialRequests,
      isMonthlyTrialExhausted: snap.isMonthlyTrialExhausted,
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
  createCohereProvider,
  validationMessage,
  COHERE_API_BASE,
  MAX_RETRIES,
};
