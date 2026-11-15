'use strict';
// LLMTR / FreeLLMAPI provider for PHOTON AI.
//
// * Reads LLMTR_API_KEY from backend environment (API.env / .env next to server.js).
// * Never returns, logs, or prints the full API key.
// * Base URL: https://llmtr.com/v1 (override with LLMTR_API_BASE).
// * Chat completions: /chat/completions (OpenAI compatible).
// * Model discovery: GET /models.
// * SSE streaming support with usage reporting.
// * Zero-billing safe: strict spending policy enforced before any request.

const { createLlmtrConfig, readEnvKey, maskKey, MODEL_ID, isLlmtrChatModel, isModelFree } = require('./llmtr-config');
const { parseRetryAfter, backoffDelay } = require('./gemini-provider');

const DEFAULT_API_BASE = 'https://llmtr.com/v1';
const MODEL_TTL_MS = 10 * 60 * 1000;
const MODEL_RETRY_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 90 * 1000;
const MAX_RETRIES = 2;
const MAX_OUTPUT_TOKENS = 4096;

function validationMessage(code) {
  switch (code) {
    case 'not_configured': return 'LLMTR is not configured on this server. Add LLMTR_API_KEY to API.env or .env.';
    case 'provider_disabled': return 'LLMTR is disabled by the administrator.';
    case 'billing_blocked': return 'LLMTR requests are blocked by the zero-billing policy. Set spendingPolicy to allow_free_only or allow_all in the admin panel.';
    case 'invalid_api_key': return 'LLMTR rejected the API key. Please check LLMTR_API_KEY in API.env.';
    case 'provider_forbidden': return 'The LLMTR API key is not permitted to use this model.';
    case 'billing_required': return 'The LLMTR account has no available credit or free quota. Zero-billing protection is in effect.';
    case 'quota_or_rate_limit': return 'LLMTR rate limit was reached. Please wait a moment and retry.';
    case 'provider_unavailable': return 'LLMTR is temporarily unavailable. Retry shortly.';
    case 'provider_overloaded': return 'LLMTR is temporarily overloaded. Retry shortly.';
    case 'network_error': return 'Could not connect to LLMTR. Check server internet connectivity and retry.';
    case 'provider_timeout': return 'LLMTR took too long to respond. Please retry.';
    case 'invalid_model': return 'The selected LLMTR model is unavailable or not enabled. Choose another model.';
    case 'empty_response': return 'LLMTR returned an empty response. Please retry.';
    case 'content_filtered': return 'LLMTR blocked this request under its safety policy.';
    default: return 'LLMTR could not complete this request.';
  }
}

function createLlmtrProvider({
  HttpError,
  env = process.env,
  fetchImpl = globalThis.fetch,
  cfg = null,
  dir = process.cwd(),
  logger = console,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A valid fetch function is required');

  const config = cfg || createLlmtrConfig({ dir, env, logger });

  let models = [];
  let modelsOk = null;
  let modelsError = null;
  let modelsAt = 0;
  let inflight = null;

  function configured() { return Boolean(readEnvKey(env)); }
  function enabled() { return config.isEnabled(); }
  function secret() { return readEnvKey(env); }

  function baseEndpoint() {
    const raw = (env.LLMTR_API_BASE || env.FREELLMAPI_API_BASE || DEFAULT_API_BASE).trim();
    return raw.replace(/\/+$/, '');
  }

  function chatUrl() { return `${baseEndpoint()}/chat/completions`; }
  function modelsUrl() { return `${baseEndpoint()}/models`; }

  function mapError(err, statusHint) {
    if (err instanceof HttpError) return err;
    const status = err?.status || statusHint;
    const msg = String(err?.message || '').toLowerCase();

    if (status === 401 || msg.includes('unauthorized') || msg.includes('invalid api key') || msg.includes('authentication')) {
      return new HttpError(401, 'invalid_api_key', validationMessage('invalid_api_key'));
    }
    if (status === 403 || msg.includes('forbidden') || msg.includes('permission denied')) {
      return new HttpError(403, 'provider_forbidden', validationMessage('provider_forbidden'));
    }
    if (status === 402 || msg.includes('insufficient_quota') || msg.includes('quota exceeded') || msg.includes('billing')) {
      return new HttpError(402, 'billing_required', validationMessage('billing_required'));
    }
    if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests')) {
      return new HttpError(429, 'quota_or_rate_limit', validationMessage('quota_or_rate_limit'));
    }
    if (status === 404 || msg.includes('model not found') || msg.includes('does not exist')) {
      return new HttpError(404, 'invalid_model', validationMessage('invalid_model'));
    }
    if (status === 503 || msg.includes('service unavailable')) {
      return new HttpError(503, 'provider_unavailable', validationMessage('provider_unavailable'));
    }
    if (status === 504 || err?.name === 'TimeoutError' || msg.includes('timeout')) {
      return new HttpError(504, 'provider_timeout', validationMessage('provider_timeout'));
    }
    if (msg.includes('fetch failed') || msg.includes('enotfound') || msg.includes('econnrefused')) {
      return new HttpError(503, 'network_error', validationMessage('network_error'));
    }

    return new HttpError(status && status >= 400 && status < 600 ? status : 502, 'provider_unavailable', validationMessage('provider_unavailable'));
  }

  async function fetchModels(key) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetchImpl(modelsUrl(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          'User-Agent': 'PhotonAI/1.0',
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Models endpoint HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const json = await res.json();
      const rawList = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
      return rawList.filter(isLlmtrChatModel);
    } finally {
      clearTimeout(timeout);
    }
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
    if (!force && modelsAt && now() - modelsAt < ttl) return models;
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        const key = secret();
        const list = await fetchModels(key);
        config.setModels(list);
        models = list.map(m => ({
          id: m.id,
          name: m.name || m.id,
          ownedBy: m.owned_by || m.ownedBy || 'llmtr',
          enabled: true,
          free: isModelFree(m),
        }));
        modelsOk = true;
        modelsError = null;
      } catch (error) {
        const mapped = mapError(error);
        modelsOk = false;
        modelsError = mapped.code;
        logger.error(`[llmtr-provider] refreshModels failed: ${mapped.code} (${mapped.message})`);
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
      return [{ id: 'llmtr', name: 'LLMTR', provider: 'LLMTR', configured: false, supported: true, available: false, free: true, reason: validationMessage('not_configured') }];
    }
    if (!enabled()) {
      config.setEnabled(true);
    }

    const snap = (typeof config.snapshot === 'function' ? config.snapshot() : (typeof config.view === 'function' ? config.view() : {}));
    const rawModels = (snap && snap.models) || {};
    const modelList = Array.isArray(rawModels) ? rawModels : Object.values(rawModels);
    const active = modelList.filter(m => m.enabled !== false);

    if (!active.length) {
      return [{
        id: 'llmtr',
        name: 'LLMTR',
        provider: 'LLMTR',
        configured: true,
        supported: true,
        available: false,
        free: true,
        reason: modelsOk === false ? validationMessage(modelsError) : 'No LLMTR models discovered or enabled yet.',
      }];
    }

    return active.map(m => ({
      id: m.id,
      name: m.name,
      provider: 'LLMTR',
      configured: true,
      supported: true,
      available: true,
      free: m.free !== undefined ? Boolean(m.free) : isModelFree(m),
      contextLength: m.contextWindow || 131072,
      capabilities: { text: true, vision: m.id.includes('vision') || m.id.includes('gemma-4') || m.id.includes('glimmer'), pdf: false },
      reason: '',
    }));
  }

  async function testConnection() {
    if (!configured()) {
      return { ok: false, error: validationMessage('not_configured'), code: 'not_configured', status: 400 };
    }
    try {
      const key = secret();
      const list = await fetchModels(key);
      config.setModels(list);
      modelsOk = true;
      modelsError = null;
      modelsAt = now();
      return { ok: true, modelCount: list.length, models: list.slice(0, 20).map(m => m.id) };
    } catch (err) {
      const mapped = mapError(err);
      return { ok: false, error: mapped.message, code: mapped.code, status: mapped.status };
    }
  }

  function enforceSpendingPolicy(modelId) {
    if (!enabled()) throw new HttpError(403, 'provider_disabled', validationMessage('provider_disabled'));
    const policy = config.getSpendingPolicy();
    if (policy === 'block') throw new HttpError(402, 'billing_blocked', validationMessage('billing_blocked'));
    if (policy === 'allow_free_only') {
      const modelObj = (config.state.models || {})[modelId];
      const isFree = modelObj ? modelObj.free : isModelFree(modelId);
      if (!isFree) {
        throw new HttpError(402, 'billing_required', 'Zero-billing policy active: this paid model is blocked under allow_free_only policy.');
      }
    }
  }

  function buildMessages({ system, history = [], text, attachments = [] }) {
    const messages = [];
    if (system && typeof system === 'string' && system.trim()) {
      messages.push({ role: 'system', content: system.trim() });
    }
    for (const h of history) {
      if (!h || !h.text) continue;
      messages.push({
        role: h.role === 'user' ? 'user' : 'assistant',
        content: String(h.text),
      });
    }

    let userContent = String(text || '');
    if (attachments && attachments.length > 0) {
      const parts = [{ type: 'text', text: userContent }];
      for (const att of attachments) {
        if (att && att.mimeType && att.mimeType.startsWith('image/') && att.data) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${att.mimeType};base64,${att.data}` },
          });
        }
      }
      messages.push({ role: 'user', content: parts.length > 1 ? parts : userContent });
    } else {
      messages.push({ role: 'user', content: userContent });
    }

    return messages;
  }

  async function generate({ model, text, attachments, system, history, maxTokens }) {
    if (!configured()) throw new HttpError(503, 'not_configured', validationMessage('not_configured'));
    enforceSpendingPolicy(model);

    const key = secret();
    const messages = buildMessages({ system, history, text, attachments });
    const payload = {
      model,
      messages,
      max_tokens: Math.min(Number(maxTokens) || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
      stream: false,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(chatUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          'User-Agent': 'PhotonAI/1.0',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const textErr = await res.text().catch(() => '');
        throw mapError(new Error(textErr), res.status);
      }

      const json = await res.json();
      const choice = json.choices?.[0];
      const replyText = choice?.message?.content || '';
      if (!replyText.trim()) throw new HttpError(502, 'empty_response', validationMessage('empty_response'));

      const usage = json.usage || {};
      config.recordSuccess({ inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens });

      return {
        text: replyText,
        usage: {
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
        },
        key: { id: 'llmtr', provider: 'LLMTR' },
      };
    } catch (err) {
      const mapped = mapError(err);
      config.recordFailure(mapped);
      throw mapped;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function* streamGenerate({ model, text, attachments, system, history, maxTokens, signal }) {
    if (!configured()) throw new HttpError(503, 'not_configured', validationMessage('not_configured'));
    enforceSpendingPolicy(model);

    const key = secret();
    const messages = buildMessages({ system, history, text, attachments });
    const payload = {
      model,
      messages,
      max_tokens: Math.min(Number(maxTokens) || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
      stream: true,
    };

    const res = await fetchImpl(chatUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        Accept: 'text/event-stream',
        'User-Agent': 'PhotonAI/1.0',
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const textErr = await res.text().catch(() => '');
      const mapped = mapError(new Error(textErr), res.status);
      config.recordFailure(mapped);
      throw mapped;
    }

    yield { type: 'meta', provider: 'LLMTR', model };

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf8');
    let buffer = '';
    let totalInput = 0;
    let totalOutput = 0;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') break;
          try {
            const data = JSON.parse(dataStr);
            const delta = data.choices?.[0]?.delta?.content;
            if (delta) {
              totalOutput += 1;
              yield { type: 'delta', text: delta };
            }
            if (data.usage) {
              totalInput = data.usage.prompt_tokens || totalInput;
              totalOutput = data.usage.completion_tokens || totalOutput;
            }
          } catch {}
        }
      }
      config.recordSuccess({ inputTokens: totalInput, outputTokens: totalOutput });
      yield {
        type: 'done',
        provider: 'LLMTR',
        model,
        usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens: totalInput + totalOutput },
      };
    } catch (err) {
      const mapped = mapError(err);
      config.recordFailure(mapped);
      throw mapped;
    }
  }

  function status() {
    const rawKey = secret();
    return {
      provider: 'LLMTR',
      configured: configured(),
      enabled: enabled(),
      maskedKey: maskKey(rawKey),
      endpoint: baseEndpoint(),
      modelCount: Object.keys(config.state.models || {}).length,
      spendingPolicy: config.getSpendingPolicy(),
      models: config.snapshot().models,
      usage: config.state.usage,
      recentErrors: config.state.recentErrors,
    };
  }

  function resetCache() {
    models = [];
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
    generate,
    streamGenerate,
    resetCache,
    config,
    mapError,
  };
}

module.exports = {
  createLlmtrProvider,
  validationMessage,
  DEFAULT_API_BASE,
};
