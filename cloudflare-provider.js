'use strict';
// Cloudflare Workers AI provider for PHOTON AI.
//
// * Reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN only from backend environment (API.env / .env).
// * Never returns, logs, or prints raw tokens or keys.
// * Base URL: https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1
// * Chat completions: /chat/completions (OpenAI-compatible).
// * Model discovery: GET /models or /ai/models/search.
// * SSE streaming support with usage reporting.
// * Strict zero-billing & 10,000 Neurons/day free-tier quota protection with 00:00 UTC reset.

const {
  createCloudflareConfig,
  readEnvCredentials,
  maskAccountId,
  maskToken,
  MODEL_ID,
  isCloudflareChatModel,
  isCloudflareImageModel,
  CLOUDFLARE_IMAGE_MODELS,
  CLOUDFLARE_DEFAULT_IMAGE_MODEL,
} = require('./cloudflare-config');
const { parseRetryAfter, backoffDelay } = require('./gemini-provider');

const MODEL_TTL_MS = 10 * 60 * 1000;
const MODEL_RETRY_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 90 * 1000;
const MAX_RETRIES = 2;
const MAX_OUTPUT_TOKENS = 4096;

function validationMessage(code) {
  switch (code) {
    case 'not_configured':
      return 'Cloudflare Workers AI is not configured. Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the admin panel.';
    case 'missing_account_id':
      return 'Cloudflare Account ID is missing. Please set CLOUDFLARE_ACCOUNT_ID.';
    case 'missing_api_token':
      return 'Cloudflare API Token is missing. Please set CLOUDFLARE_API_TOKEN.';
    case 'provider_disabled':
      return 'Cloudflare Workers AI is disabled by the administrator.';
    case 'billing_blocked':
      return 'Cloudflare Workers AI requests are blocked by the spending policy. Set spendingPolicy to allow_free_only in the admin panel.';
    case 'quota_exhausted':
    case 'billing_required':
      return 'Cloudflare Workers AI daily free neuron allocation (10,000 Neurons) has been exhausted for today. Resets at 00:00 UTC. Zero-billing protection prevents unapproved charges.';
    case 'invalid_api_token':
    case 'invalid_api_key':
      return 'Cloudflare rejected the API Token. Please verify permissions (Workers AI: Read/Edit) on your Cloudflare API Token.';
    case 'invalid_account_id':
      return 'Cloudflare rejected the Account ID. Please verify CLOUDFLARE_ACCOUNT_ID.';
    case 'provider_forbidden':
      return 'Cloudflare API token lacks permission to run Workers AI inference for this account.';
    case 'quota_or_rate_limit':
      return 'Cloudflare Workers AI rate limit was reached. Please wait a moment and retry.';
    case 'provider_unavailable':
      return 'Cloudflare Workers AI is temporarily unavailable. Retry shortly.';
    case 'provider_overloaded':
      return 'Cloudflare Workers AI is temporarily overloaded. Retry shortly.';
    case 'network_error':
      return 'Could not connect to Cloudflare Workers AI. Check server internet connectivity and retry.';
    case 'provider_timeout':
      return 'Cloudflare Workers AI took too long to respond. Please retry.';
    case 'invalid_model':
      return 'The selected Cloudflare Workers AI model is unavailable or not enabled. Choose another model.';
    case 'empty_response':
      return 'Cloudflare Workers AI returned an empty response. Please retry.';
    default:
      return 'Cloudflare Workers AI could not complete this request.';
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

function createCloudflareProvider({
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
  const cfg = config || createCloudflareConfig({ dir: env.PHOTON_DATA_DIR || process.cwd(), env, logger, now });

  let models = [];
  let modelsAt = 0;
  let modelsOk = null;
  let modelsError = null;
  let inflight = null;

  function credentials() {
    return readEnvCredentials(env);
  }

  function configured() {
    const creds = credentials();
    return Boolean(creds.accountId && creds.apiToken);
  }

  function enabled() {
    return configured() && cfg.isEnabled();
  }

  function getBaseUrl() {
    const creds = credentials();
    if (!creds.accountId) throw new HttpError(503, 'missing_account_id', validationMessage('missing_account_id'));
    const override = env.CLOUDFLARE_BASE_URL || env.CLOUDFLARE_API_BASE;
    if (override) return String(override).replace(/\/+$/, '');
    return `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/v1`;
  }

  function authHeaders() {
    const creds = credentials();
    if (!creds.apiToken) throw new HttpError(503, 'missing_api_token', validationMessage('missing_api_token'));
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${creds.apiToken}`,
      'Accept': 'application/json',
    };
  }

  function keyFormatWarning() {
    const creds = credentials();
    if (!creds.accountId && !creds.apiToken) return null;
    const warnings = [];
    if (!creds.accountId) warnings.push('Missing CLOUDFLARE_ACCOUNT_ID.');
    else if (!/^[a-f0-9]{32}$/i.test(creds.accountId)) warnings.push('Account ID should typically be 32 hex characters.');
    if (!creds.apiToken) warnings.push('Missing CLOUDFLARE_API_TOKEN.');
    else if (/\s/.test(creds.apiToken)) warnings.push('API Token contains whitespace.');
    return warnings.length ? warnings.join(' ') : null;
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
    if (status === 401 || /unauthorized|invalid.*token|authentication/i.test(detail)) {
      return new HttpError(502, 'invalid_api_token', validationMessage('invalid_api_token'));
    }
    if (status === 403 || /forbidden|insufficient.*permission/i.test(detail)) {
      return new HttpError(502, 'provider_forbidden', validationMessage('provider_forbidden'));
    }
    if (status === 404 && /account/i.test(detail)) {
      return new HttpError(502, 'invalid_account_id', validationMessage('invalid_account_id'));
    }
    if (status === 404) {
      return new HttpError(502, 'invalid_model', validationMessage('invalid_model'));
    }
    if (status === 429 || /rate.*limit/i.test(detail)) {
      return new HttpError(429, 'quota_or_rate_limit', validationMessage('quota_or_rate_limit'));
    }
    if (status === 402 || /quota|neuron|exceeded|balance/i.test(detail)) {
      return new HttpError(402, 'quota_exhausted', validationMessage('quota_exhausted'));
    }
    if (status >= 500) {
      return new HttpError(503, 'provider_unavailable', validationMessage('provider_unavailable'));
    }
    return new HttpError(502, 'provider_error', validationMessage('provider_error'));
  }

  function assertFreeUsagePolicy() {
    const policy = cfg.getSpendingPolicy();
    if (policy === 'block') {
      throw new HttpError(402, 'billing_blocked', validationMessage('billing_blocked'));
    }
    if (cfg.isDailyQuotaExhausted()) {
      throw new HttpError(402, 'quota_exhausted', validationMessage('quota_exhausted'));
    }
  }

  async function fetchModels() {
    if (!configured()) throw new HttpError(503, 'not_configured', validationMessage('not_configured'));
    const apiBase = getBaseUrl();
    const modelsUrl = `${apiBase}/models`;
    const signal = AbortSignal.timeout(15000);

    let res;
    try {
      res = await fetchImpl(modelsUrl, {
        method: 'GET',
        headers: authHeaders(),
        signal,
      });
    } catch (err) {
      throw mapError(err);
    }

    const rlHeaders = extractRateLimitHeaders(res.headers);
    cfg.updateRateLimits(rlHeaders);

    if (!res.ok) {
      // Fallback: try Cloudflare native models search endpoint if OpenAI /models returned 404
      const creds = credentials();
      if (res.status === 404 && creds.accountId) {
        const altUrl = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/models/search`;
        try {
          const altRes = await fetchImpl(altUrl, { method: 'GET', headers: authHeaders(), signal: AbortSignal.timeout(15000) });
          if (altRes.ok) {
            const altData = await altRes.json().catch(() => ({}));
            const rawList = Array.isArray(altData.result) ? altData.result : [];
            const chatOnly = rawList.filter(m => isCloudflareChatModel(m.id || m.name));
            return cfg.syncDiscoveredModels(chatOnly);
          }
        } catch {}
      }

      const body = await res.json().catch(() => ({}));
      const errMsg = body?.errors?.[0]?.message || body?.error?.message || `Cloudflare returned HTTP ${res.status}`;
      const err = new Error(errMsg);
      err.status = res.status;
      throw mapError(err);
    }

    const payload = await res.json().catch(() => ({}));
    const rawList = Array.isArray(payload.data) ? payload.data : (Array.isArray(payload.result) ? payload.result : []);
    const chatOnly = rawList.filter(m => isCloudflareChatModel(m.id || m.name));
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
        if (mapped.code === 'invalid_api_token' || mapped.code === 'invalid_account_id' || mapped.code === 'provider_forbidden') {
          models = [];
        }
        logger.error(JSON.stringify({ category: 'cloudflare_refresh_models', code: mapped.code, status: mapped.status }));
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
      return [{ id: 'cloudflare', name: 'Cloudflare Workers AI', provider: 'Cloudflare Workers AI', providerId: 'cloudflare_workers_ai', configured: false, supported: true, available: false, free: true, reason: validationMessage('not_configured') }];
    }
    if (!enabled()) {
      return [{ id: 'cloudflare', name: 'Cloudflare Workers AI', provider: 'Cloudflare Workers AI', providerId: 'cloudflare_workers_ai', configured: true, supported: true, available: false, free: true, reason: validationMessage('provider_disabled') }];
    }

    const snap = cfg.snapshot();
    const modelList = Object.values(snap.models || {});
    const active = modelList.filter(m => m.enabled && m.freeTierEligible);

    const chatEntries = active.map(m => ({
      id: m.id,
      name: m.name,
      provider: 'Cloudflare Workers AI',
      providerId: 'cloudflare_workers_ai',
      configured: true,
      supported: true,
      available: !snap.isDailyQuotaExhausted,
      free: true,
      category: 'Text Generation',
      contextLength: m.contextWindow || 32768,
      capabilities: { text: true, vision: false, pdf: false },
      description: m.description || `General chat & reasoning · ${Math.round((m.contextWindow || 32768) / 1024)}k context`,
      reason: snap.isDailyQuotaExhausted ? validationMessage('quota_exhausted') : '',
    }));

    const imageEntries = imageCatalogEntries();
    const all = [...chatEntries, ...imageEntries];

    if (!all.length) {
      return [{
        id: 'cloudflare',
        name: 'Cloudflare Workers AI',
        provider: 'Cloudflare Workers AI',
        providerId: 'cloudflare_workers_ai',
        configured: true,
        supported: true,
        available: false,
        free: true,
        reason: modelsOk === false ? validationMessage(modelsError) : 'No Cloudflare Workers AI models discovered or enabled yet.',
      }];
    }

    return all;
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
        logger.error(JSON.stringify({ category: 'cloudflare_retry', attempt: attempt + 1, code: mapped.code, delayMs: delay }));
        await wait(delay);
      }
    }
    throw lastError || new HttpError(502, 'provider_error', 'Cloudflare Workers AI request failed after retries.');
  }

  async function generate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, signal }) {
    if (!configured()) throw new HttpError(503, 'not_configured', validationMessage('not_configured'));
    if (!enabled()) throw new HttpError(503, 'provider_disabled', validationMessage('provider_disabled'));
    assertFreeUsagePolicy();

    if (isCloudflareImageModel(model)) {
      const prompt = text || system || 'a beautiful illustration';
      const imgRes = await generateImage({ prompt, model, signal });
      return {
        text: `![${prompt}](${imgRes.dataUrl})`,
        image: imgRes.dataUrl,
        model: imgRes.model,
        usage: { inputTokens: 10, outputTokens: 50, totalTokens: 60 },
        key: { id: 'cloudflare-env', slot: 1 },
      };
    }

    const chosenModel = model || cfg.getDefaultModelId() || '@cf/meta/llama-3.1-8b-instruct';
    const apiBase = getBaseUrl();
    const chatUrl = `${apiBase}/chat/completions`;
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
            headers: authHeaders(),
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
          const errMsg = body?.errors?.[0]?.message || body?.error?.message || `Cloudflare HTTP ${res.status}`;
          const err = new Error(errMsg);
          err.status = res.status;
          err.error = body?.error;
          const mapped = mapError(err);
          const ra = parseRetryAfter(rl['retry-after']);
          if (ra) mapped.retryAfterMs = ra;
          throw mapped;
        }

        return res.json();
      });

      const choice = response?.choices?.[0] || response?.result;
      const outputText = String(choice?.message?.content || choice?.response || '').trim();
      const usage = {
        inputTokens: Number(response?.usage?.prompt_tokens) || Math.ceil((text?.length || 10) / 4),
        outputTokens: Number(response?.usage?.completion_tokens) || Math.ceil((outputText.length || 10) / 4),
        totalTokens: Number(response?.usage?.total_tokens) || 0,
      };
      if (!usage.totalTokens) usage.totalTokens = usage.inputTokens + usage.outputTokens;

      cfg.recordUsage({ model: chosenModel, ok: true, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });

      return {
        text: outputText,
        model: response?.model || chosenModel,
        usage,
        key: { id: 'cloudflare-env', slot: 1 },
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
    assertFreeUsagePolicy();

    if (isCloudflareImageModel(model)) {
      const prompt = text || system || 'a beautiful illustration';
      const imgRes = await generateImage({ prompt, model, signal });
      yield { type: 'delta', text: `![${prompt}](${imgRes.dataUrl})` };
      yield {
        type: 'done',
        text: `![${prompt}](${imgRes.dataUrl})`,
        message: `![${prompt}](${imgRes.dataUrl})`,
        image: imgRes.dataUrl,
        model: imgRes.model,
        usage: { inputTokens: 10, outputTokens: 50, totalTokens: 60 },
      };
      return;
    }

    const chosenModel = model || cfg.getDefaultModelId() || '@cf/meta/llama-3.1-8b-instruct';
    const apiBase = getBaseUrl();
    const chatUrl = `${apiBase}/chat/completions`;
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
        headers: authHeaders(),
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
      const errMsg = body?.errors?.[0]?.message || body?.error?.message || `Cloudflare HTTP ${res.status}`;
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
                const delta = chunk?.choices?.[0]?.delta?.content || chunk?.response;
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
      key: { id: 'cloudflare-env', slot: 1 },
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

    const creds = credentials();
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
        maskedAccountId: maskAccountId(creds.accountId),
        maskedToken: maskToken(creds.apiToken),
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
      const res = await generate({
        model: id,
        system: 'Reply with one short word.',
        text: 'Reply with: PHOTON Cloudflare connection successful.',
        maxTokens: 50,
      });
      cfg.markModelVerified(id);
      return {
        ok: true,
        model: id,
        modelName: modelMeta.name || id,
        provider: 'Cloudflare Workers AI',
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
        provider: 'Cloudflare Workers AI',
        code: mapped.code,
        status: 'failed',
        message: mapped.message,
        responseTimeMs: Date.now() - started,
        testedAt: new Date().toISOString(),
      };
    }
  }

  function imageCatalogEntries() {
    const isAvail = configured() && enabled() && !cfg.isDailyQuotaExhausted();
    return Object.values(CLOUDFLARE_IMAGE_MODELS).map(m => ({
      id: m.id,
      name: m.name,
      provider: 'Cloudflare Workers AI',
      providerKey: 'cloudflare',
      category: 'Image Generation',
      task: 'text-to-image',
      available: isAvail,
      configured: configured(),
      enabled: enabled(),
      free: true,
      freeTierEligible: true,
      pricingVerified: true,
      description: m.description,
      steps: m.steps,
    }));
  }

  async function generateImage({
    prompt,
    model = CLOUDFLARE_DEFAULT_IMAGE_MODEL,
    steps,
    signal,
  } = {}) {
    const creds = credentials();
    if (!creds.accountId || !creds.apiToken) {
      throw new HttpError(503, 'not_configured', validationMessage('not_configured'));
    }
    if (!enabled()) {
      throw new HttpError(403, 'provider_disabled', validationMessage('provider_disabled'));
    }
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) {
      throw new HttpError(400, 'invalid_prompt', 'Prompt is required for image generation.');
    }

    const targetModel = CLOUDFLARE_IMAGE_MODELS[model] ? model : CLOUDFLARE_DEFAULT_IMAGE_MODEL;
    const meta = CLOUDFLARE_IMAGE_MODELS[targetModel] || { name: targetModel, steps: 4 };

    // Check spending policy / quota
    const policy = cfg.getSpendingPolicy();
    if (policy === 'block') {
      throw new HttpError(403, 'billing_blocked', validationMessage('billing_blocked'));
    }
    if (cfg.isDailyQuotaExhausted()) {
      throw new HttpError(402, 'quota_exhausted', validationMessage('quota_exhausted'));
    }

    const numSteps = Number.isInteger(steps) && steps > 0 ? steps : meta.steps;
    const runUrl = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/run/${targetModel}`;

    const headers = {
      'Authorization': `Bearer ${creds.apiToken}`,
      'Content-Type': 'application/json',
      'Accept': 'image/*, application/json',
    };

    const combined = combinedSignal(signal, REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(runUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: cleanPrompt, steps: numSteps }),
        signal: combined,
      });
    } catch (err) {
      const mapped = mapError(err);
      throw new HttpError(mapped.status || 502, mapped.code, mapped.message);
    }

    if (!res.ok) {
      const status = res.status;
      let errBody = '';
      try {
        errBody = await res.text();
      } catch (_) {}
      let parsedErr = null;
      try {
        parsedErr = JSON.parse(errBody);
      } catch (_) {}

      const msg = (parsedErr && parsedErr.errors && parsedErr.errors[0] && parsedErr.errors[0].message) || errBody || res.statusText;
      let code = 'provider_error';
      if (status === 401 || status === 403) code = 'invalid_api_token';
      else if (status === 429) code = 'quota_or_rate_limit';
      else if (status >= 500) code = 'provider_unavailable';

      cfg.recordUsage({
        success: false,
        tokens: 0,
        neurons: 0,
        model: targetModel,
        errorCode: code,
        message: msg,
      });
      throw new HttpError(status, code, `Cloudflare image generation failed (${status}): ${msg}`);
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    let b64 = '';
    let mime = 'image/png';

    if (contentType.includes('application/json')) {
      const json = await res.json();
      if (json && json.result && json.result.image) {
        b64 = json.result.image;
        mime = 'image/jpeg';
      } else {
        throw new HttpError(502, 'empty_response', 'Cloudflare Workers AI did not return an image payload.');
      }
    } else {
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (!buffer.length) {
        throw new HttpError(502, 'empty_response', 'Cloudflare Workers AI returned empty image bytes.');
      }
      b64 = buffer.toString('base64');
      mime = contentType.startsWith('image/') ? contentType.split(';')[0] : 'image/png';
    }

    cfg.recordUsage({
      success: true,
      tokens: 0,
      neurons: 50,
      model: targetModel,
    });

    const dataUrl = `data:${mime};base64,${b64}`;
    return {
      success: true,
      image: dataUrl,
      dataUrl,
      b64_json: b64,
      mimeType: mime,
      model: targetModel,
      modelName: meta.name,
      provider: 'Cloudflare Workers AI',
      prompt: cleanPrompt,
    };
  }

  async function testImageModel(modelId = CLOUDFLARE_DEFAULT_IMAGE_MODEL) {
    const started = Date.now();
    try {
      const res = await generateImage({
        prompt: 'a minimalist glowing photon sphere',
        model: modelId,
        steps: 4,
      });
      return {
        ok: true,
        model: res.model,
        modelName: res.modelName,
        provider: 'Cloudflare Workers AI',
        status: 'working',
        responseTimeMs: Date.now() - started,
        testedAt: new Date().toISOString(),
      };
    } catch (err) {
      const mapped = mapError(err);
      return {
        ok: false,
        model: modelId,
        modelName: (CLOUDFLARE_IMAGE_MODELS[modelId] && CLOUDFLARE_IMAGE_MODELS[modelId].name) || modelId,
        provider: 'Cloudflare Workers AI',
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
    const creds = credentials();
    const modelList = Object.values(snap.models || {});
    const imageList = Object.values(CLOUDFLARE_IMAGE_MODELS);

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
      provider: 'Cloudflare Workers AI',
      id: 'cloudflare_workers_ai',
      identifier: 'cloudflare_workers_ai',
      category: 'LLM & Image Inference',
      protocol: 'OpenAI-compatible Chat & REST Image Run',
      apiBase: configured() ? getBaseUrl() : 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1',
      chatEndpoint: '/chat/completions',
      modelsEndpoint: '/models',
      configured: configured(),
      enabled: enabled(),
      validated: configured() && enabled() && modelsOk === true,
      validation,
      keyFormatWarning: keyFormatWarning(),
      maskedAccountId: maskAccountId(creds.accountId),
      maskedToken: maskToken(creds.apiToken),
      spendingPolicy: snap.spendingPolicy,
      dailyNeuronsLimit: snap.dailyNeuronsLimit,
      remainingDailyNeurons: snap.remainingDailyNeurons,
      isDailyQuotaExhausted: snap.isDailyQuotaExhausted,
      defaultModelId: snap.defaultModelId,
      modelCount: modelList.length,
      enabledModelCount: modelList.filter(m => m.enabled).length,
      imageModelCount: imageList.length,
      checkedAt: modelsAt ? new Date(modelsAt).toISOString() : null,
      models: modelList,
      imageModels: imageList,
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
    imageCatalogEntries,
    generate,
    generateImage,
    streamGenerate,
    testConnection,
    testModel,
    testImageModel,
    mapError,
    cfg,
  };
}

module.exports = {
  createCloudflareProvider,
  validationMessage,
  MAX_RETRIES,
};
