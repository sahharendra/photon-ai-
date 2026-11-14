'use strict';
// OpenAI GPT provider for PHOTON AI.
//
// * Uses the official `openai` JavaScript SDK, loaded lazily so the rest of PHOTON keeps working
//   when the package has not been installed yet.
// * OPENAI_API_KEY is read only from the backend environment. It is never returned by status(),
//   stored in the config file, written to a log or included in an error message.
// * Models are discovered with GET /v1/models. Discovery only proves visibility, not access or
//   pricing, so every model stays disabled until an administrator verifies it with a tiny real
//   completion.
// * Retry policy: 429 and 5xx/network/timeout failures are retried with bounded exponential
//   backoff and Retry-After support. Authentication, billing, invalid-request and invalid-model
//   failures are returned immediately. A request is never retried forever.

const { parseRetryAfter, backoffDelay } = require('./gemini-provider');
const { maskKey } = require('./gemini-keys');
const {
  createOpenAIConfig, readEnvKeys, normalizeModels, describeModel, lookupMetadata, costUsdFor, priceFor, MODEL_ID,
} = require('./openai-config');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MODEL_TTL_MS = 10 * 60 * 1000;
const MODEL_RETRY_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const MAX_RETRIES = 2;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_MODELS = 200;
const TRANSIENT_CODES = new Set(['provider_unavailable', 'network_error', 'provider_timeout', 'provider_overloaded']);
const RETRYABLE_CODES = new Set(['quota_or_rate_limit', ...TRANSIENT_CODES]);
// Key-specific exhaustion: when a second backend key is configured, PHOTON may try it once for the
// same provider. This is never used to switch providers and is bounded to the configured slots.
const KEY_FAILOVER_CODES = new Set(['quota_or_rate_limit', 'billing_required']);

function validationMessage(code) {
  switch (code) {
    case 'not_configured': return 'OpenAI is not configured on this server. Add OPENAI_API_KEY to the backend .env or API.env.';
    case 'provider_disabled': return 'OpenAI is disabled by the administrator.';
    case 'invalid_api_key': return 'OpenAI rejected the server API key. The administrator must update OPENAI_API_KEY.';
    case 'provider_forbidden': return 'The OpenAI API key is not permitted to use this model.';
    case 'billing_required': return 'The OpenAI account has no available API credit or has reached its quota. ChatGPT subscriptions do not provide API credit.';
    case 'quota_or_rate_limit': return 'OpenAI rate limit was reached. Wait a moment and retry.';
    case 'provider_unavailable': return 'OpenAI is temporarily unavailable. Retry shortly.';
    case 'provider_overloaded': return 'OpenAI is temporarily overloaded. Retry shortly.';
    case 'network_error': return 'Could not connect to OpenAI. Check the server network and retry.';
    case 'provider_timeout': return 'OpenAI took too long to respond. Please retry.';
    case 'invalid_model': return 'The selected OpenAI model is unavailable or is not enabled. Choose another model.';
    case 'empty_response': return 'OpenAI returned an empty response. Please retry.';
    case 'content_filtered': return 'OpenAI blocked this request under its content policy.';
    case 'unsupported_attachment': return 'OpenAI chat does not accept PDF attachments on this server. Attach an image or a text version of the file.';
    case 'provider_not_installed': return 'OpenAI support is not installed on this server. Run "npm install openai" and restart.';
    default: return 'OpenAI could not complete this request.';
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

function createOpenAIProvider({ HttpError, env = process.env, loadSdk, config, logger = console, sleep, random, now = Date.now } = {}) {
  if (!HttpError) throw new Error('HttpError class is required');
  const settings = config || createOpenAIConfig({ dir: env.PHOTON_DATA_DIR || process.cwd(), env, logger, now });
  const wait = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const jitter = random || Math.random;
  const sdkLoader = loadSdk || (() => require('openai'));
  const baseURL = String(env.OPENAI_BASE_URL || '').trim() || DEFAULT_BASE_URL;
  const clients = new Map();
  let models = [];
  let modelsAt = 0;
  let modelsOk = null;
  let modelsError = null;
  let inflight = null;

  function keyEntries() { return readEnvKeys(env); }
  function apiKey() { return keyEntries()[0]?.key || ''; }
  function configured() { return keyEntries().length > 0; }
  function enabled() { return settings.providerEnabled(); }
  function maskedKey() { return keyEntries()[0]?.masked || null; }
  function maskedKeys() { return keyEntries().map(entry => ({ slot: entry.slot, name: entry.name, masked: entry.masked })); }

  function getClient(slot) {
    const entries = keyEntries();
    if (!entries.length) throw new HttpError(503, 'provider_not_configured', validationMessage('not_configured'));
    const entry = entries.find(item => item.slot === slot) || entries[0];
    const cached = clients.get(entry.slot);
    if (cached && cached.key === entry.key) return cached.client;
    let mod;
    try { mod = sdkLoader(); } catch (error) {
      logger.error(JSON.stringify({ category: 'openai_sdk_missing', code: error?.code || 'unknown' }));
      throw new HttpError(503, 'provider_not_installed', validationMessage('provider_not_installed'));
    }
    const OpenAI = mod?.default || mod?.OpenAI || mod;
    if (typeof OpenAI !== 'function') throw new HttpError(503, 'provider_not_installed', validationMessage('provider_not_installed'));
    const client = new OpenAI({ apiKey: entry.key, baseURL, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
    clients.set(entry.slot, { key: entry.key, client });
    return client;
  }

  function retryAfterFrom(error) {
    const headers = error?.headers;
    let value = null;
    if (headers && typeof headers.get === 'function') value = headers.get('retry-after');
    else if (headers && typeof headers === 'object') value = headers['retry-after'] ?? headers['Retry-After'];
    return parseRetryAfter(value);
  }

  // Maps SDK / HTTP / network failures to safe, user-facing HttpErrors. The key and raw provider
  // text are never included in the returned message.
  function mapError(error) {
    if (error instanceof HttpError) return error;
    const status = Number(error?.status || error?.response?.status) || 0;
    const name = String(error?.name || error?.constructor?.name || '');
    const code = String(error?.code || error?.error?.code || '').toLowerCase();
    const type = String(error?.type || error?.error?.type || '').toLowerCase();
    const detail = String(error?.error?.message || error?.message || '').toLowerCase();
    const mapped = (() => {
      if (name === 'APIUserAbortError' || name === 'AbortError' || code === 'abort_err') return new HttpError(499, 'request_aborted', 'The request was cancelled.');
      if (name === 'APIConnectionTimeoutError' || name === 'TimeoutError' || code === 'etimedout') return new HttpError(504, 'provider_timeout', validationMessage('provider_timeout'));
      if (name === 'APIConnectionError' || (!status && /fetch failed|network|enotfound|econn|socket|terminated|connect|dns/.test(detail))) return new HttpError(502, 'network_error', validationMessage('network_error'));
      if (status === 401 || code === 'invalid_api_key') return new HttpError(502, 'invalid_api_key', validationMessage('invalid_api_key'));
      if (status === 402 || code === 'billing_hard_limit_reached') return new HttpError(402, 'billing_required', validationMessage('billing_required'));
      if (status === 403) return new HttpError(502, 'provider_forbidden', validationMessage('provider_forbidden'));
      if (status === 404) return new HttpError(502, 'invalid_model', validationMessage('invalid_model'));
      if (status === 408 || status === 504) return new HttpError(504, 'provider_timeout', validationMessage('provider_timeout'));
      if (status === 413) return new HttpError(413, 'request_too_large', 'The request is too large for OpenAI. Shorten the message or attachments.');
      if (status === 429 || type === 'rate_limit_error' || code === 'rate_limit_exceeded') {
        if (code === 'insufficient_quota' || type === 'insufficient_quota' || /insufficient_quota|exceeded your current quota|billing|credit/.test(detail + ' ' + code)) return new HttpError(402, 'billing_required', validationMessage('billing_required'));
        return new HttpError(429, 'quota_or_rate_limit', validationMessage('quota_or_rate_limit'));
      }
      if (status === 529 || type === 'overloaded_error') return new HttpError(503, 'provider_overloaded', validationMessage('provider_overloaded'));
      if (status >= 500) return new HttpError(503, 'provider_unavailable', validationMessage('provider_unavailable'));
      if (code === 'insufficient_quota' || /insufficient_quota|exceeded your current quota/.test(detail)) return new HttpError(402, 'billing_required', validationMessage('billing_required'));
      if (status === 400) {
        if (/model.*(not found|invalid|does not exist|unavailable)/.test(detail)) return new HttpError(502, 'invalid_model', validationMessage('invalid_model'));
        if (/context|too many tokens|maximum.*tokens/.test(detail)) return new HttpError(413, 'request_too_large', 'The conversation is too long for this OpenAI model. Shorten the message or start a new chat.');
        if (/moderation|content policy|flagged|safety/.test(detail)) return new HttpError(502, 'content_filtered', validationMessage('content_filtered'));
        return new HttpError(502, 'provider_rejected_request', 'OpenAI could not process this request. Try simplifying the message or attachments.');
      }
      if (/model.*(not found|invalid|does not exist|unavailable)/.test(detail)) return new HttpError(502, 'invalid_model', validationMessage('invalid_model'));
      return new HttpError(502, 'provider_error', 'OpenAI could not complete this request.');
    })();
    const retryAfterMs = retryAfterFrom(error);
    if (retryAfterMs !== null && retryAfterMs !== undefined) mapped.retryAfterMs = retryAfterMs;
    return mapped;
  }

  async function withRetry(operation, { signal, model } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) throw new HttpError(499, 'request_aborted', 'The request was cancelled.');
      try {
        return await operation(attempt);
      } catch (raw) {
        if (signal?.aborted) throw new HttpError(499, 'request_aborted', 'The request was cancelled.');
        const mapped = raw instanceof HttpError ? raw : mapError(raw);
        lastError = mapped;
        if (!RETRYABLE_CODES.has(mapped.code) || attempt >= MAX_RETRIES) throw mapped;
        const delay = backoffDelay(attempt, mapped.retryAfterMs, jitter);
        logger.error(JSON.stringify({ category: 'openai_retry', code: mapped.code, status: mapped.status, attempt: attempt + 1, delay_ms: delay, model: model || null }));
        await wait(delay);
      }
    }
    throw lastError || new HttpError(502, 'provider_error', 'OpenAI could not complete this request.');
  }

  async function fetchModels() {
    const current = getClient();
    const list = [];
    for await (const item of current.models.list({ limit: 100 })) {
      list.push(item);
      if (list.length >= MAX_MODELS) break;
    }
    return normalizeModels(list, env);
  }

  async function refreshModels(force = false) {
    if (!configured()) { models = []; modelsOk = null; modelsError = null; modelsAt = 0; return models; }
    const ttl = modelsOk === false ? MODEL_RETRY_MS : MODEL_TTL_MS;
    if (!force && modelsAt && now() - modelsAt < ttl) return models;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        models = await fetchModels();
        settings.syncModels(models);
        modelsOk = true;
        modelsError = null;
      } catch (error) {
        const mapped = mapError(error);
        modelsOk = false;
        modelsError = mapped.code;
        if (['invalid_api_key', 'provider_forbidden', 'billing_required'].includes(mapped.code)) models = [];
        logger.error(JSON.stringify({ category: 'openai_models', code: mapped.code, status: mapped.status }));
      } finally {
        modelsAt = now();
        inflight = null;
      }
      return models;
    })();
    return inflight;
  }

  function normalizeUsage(usage) {
    const inputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens) || 0;
    const outputTokens = Number(usage?.completion_tokens ?? usage?.output_tokens) || 0;
    const totalTokens = Number(usage?.total_tokens) || inputTokens + outputTokens;
    const cachedTokens = Number(usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens) || 0;
    return { inputTokens, outputTokens, totalTokens, ...(cachedTokens ? { cachedTokens } : {}) };
  }

  function pricingFor(model) { return priceFor(model, settings.modelState(model)); }
  function costFor(model, usage) { const cost = costUsdFor(pricingFor(model), usage); return Number.isFinite(cost) ? cost : null; }

  function modelReady(id) {
    const state = settings.modelState(id);
    return Boolean(state && state.enabled === true && state.verifiedAt);
  }

  function requireModel(id) {
    if (!MODEL_ID.test(String(id || ''))) throw new HttpError(400, 'invalid_model', 'The selected OpenAI model is invalid.');
    if (!configured()) throw new HttpError(503, 'provider_not_configured', validationMessage('not_configured'));
    if (!enabled()) throw new HttpError(503, 'provider_disabled', validationMessage('provider_disabled'));
    if (!modelReady(id)) throw new HttpError(503, 'invalid_model', 'That OpenAI model is not enabled. An administrator must verify and enable it in the admin panel.');
  }

  function userContent(text, attachments = []) {
    const body = String(text || '').trim() || 'Please review the attached file(s).';
    if (!attachments.length) return body;
    const parts = [];
    for (const file of attachments) {
      if (file.kind === 'text') parts.push({ type: 'text', text: '[Attached text file: ' + file.name + ']\n' + file.text + '\n[End attached file]' });
      else if (file.mimeType === 'application/pdf') throw new HttpError(415, 'unsupported_attachment', validationMessage('unsupported_attachment'));
      else parts.push({ type: 'image_url', image_url: { url: 'data:' + file.mimeType + ';base64,' + file.data } });
    }
    parts.push({ type: 'text', text: body });
    return parts;
  }

  // history: [{ role: 'user'|'assistant'|'model', text }] oldest first. Consecutive same-role turns
  // are merged and a leading assistant turn is dropped so the conversation starts with the user.
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
    const limit = Math.max(1, Math.min(Number(maxTokens) || MAX_OUTPUT_TOKENS, 128000));
    const reasoning = lookupMetadata(model)?.reasoning === true;
    const params = {
      model,
      messages: buildMessages({ system, history, text, attachments }),
      [reasoning ? 'max_completion_tokens' : 'max_tokens']: limit,
    };
    if (stream) {
      params.stream = true;
      params.stream_options = { include_usage: true };
    }
    return params;
  }

  function extractText(message) {
    const content = message?.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) return content.filter(part => part && (part.type === 'text' || part.type === 'output_text')).map(part => String(part.text || '')).join('').trim();
    return '';
  }

  async function runCompletion({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, signal, enforceActivation = true }) {
    if (enforceActivation) requireModel(model);
    else if (!MODEL_ID.test(String(model || ''))) throw new HttpError(400, 'invalid_model', 'The selected OpenAI model is invalid.');
    const params = buildRequest({ model, system, history, text, attachments, maxTokens });
    let response;
    try {
      response = await withRetry(() => getClient().chat.completions.create(params, { signal: combinedSignal(signal, REQUEST_TIMEOUT_MS) }), { signal, model });
    } catch (error) {
      const mapped = mapError(error);
      settings.recordUsage({ model, ok: false, code: mapped.code, message: mapped.message, status: mapped.status, usage: null, costUsd: 0 });
      logger.error(JSON.stringify({ category: 'openai_request', code: mapped.code, status: mapped.status, model }));
      throw mapped;
    }
    const choice = response?.choices?.[0];
    const output = extractText(choice?.message);
    const usage = normalizeUsage(response?.usage);
    const cost = costFor(model, usage);
    if (!output) {
      const mapped = new HttpError(502, 'empty_response', choice?.finish_reason === 'content_filter' ? validationMessage('content_filtered') : validationMessage('empty_response'));
      settings.recordUsage({ model, ok: false, code: mapped.code, message: mapped.message, status: mapped.status, usage, costUsd: cost || 0 });
      throw mapped;
    }
    settings.recordUsage({ model, ok: true, usage, costUsd: cost || 0 });
    return { text: output, usage, cost: cost === null ? undefined : cost, estimated: true, stopReason: choice?.finish_reason || null, model: response?.model || model, key: { id: 'openai-env', slot: 1 } };
  }

  async function generate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, signal }) {
    return runCompletion({ model, system, history, text, attachments, maxTokens, signal });
  }

  async function* streamGenerate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, signal }) {
    requireModel(model);
    const params = buildRequest({ model, system, history, text, attachments, maxTokens, stream: true });
    let stream;
    try {
      stream = await withRetry(() => getClient().chat.completions.create(params, { signal: combinedSignal(signal, REQUEST_TIMEOUT_MS) }), { signal, model });
    } catch (error) {
      const mapped = mapError(error);
      settings.recordUsage({ model, ok: false, code: mapped.code, message: mapped.message, status: mapped.status, usage: null, costUsd: 0 });
      logger.error(JSON.stringify({ category: 'openai_stream', code: mapped.code, status: mapped.status, model }));
      throw mapped;
    }
    let full = '';
    let usage = null;
    let responseModel = model;
    let finishReason = null;
    try {
      for await (const chunk of stream) {
        if (signal?.aborted) throw new HttpError(499, 'request_aborted', 'The request was cancelled.');
        if (chunk?.model) responseModel = chunk.model;
        const choice = chunk?.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta) {
          full += delta;
          yield { type: 'delta', text: delta };
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk?.usage) usage = normalizeUsage(chunk.usage);
      }
    } catch (error) {
      const mapped = mapError(error);
      settings.recordUsage({ model, ok: false, code: mapped.code, message: mapped.message, status: mapped.status, usage, costUsd: costFor(model, usage) || 0 });
      throw mapped;
    }
    const output = full.trim();
    const cost = costFor(model, usage || { inputTokens: 0, outputTokens: 0 });
    if (!output) {
      const mapped = new HttpError(502, 'empty_response', finishReason === 'content_filter' ? validationMessage('content_filtered') : validationMessage('empty_response'));
      settings.recordUsage({ model, ok: false, code: mapped.code, message: mapped.message, status: mapped.status, usage, costUsd: cost || 0 });
      throw mapped;
    }
    settings.recordUsage({ model, ok: true, usage, costUsd: cost || 0 });
    yield { type: 'done', text: output, usage, cost: cost === null ? undefined : cost, estimated: true, model: responseModel, stopReason: finishReason, key: { id: 'openai-env', slot: 1 } };
  }

  function status() {
    const state = settings.snapshot();
    const list = Object.keys(state.models || {}).map(id => {
      const saved = state.models[id];
      return describeModel({ id, name: saved.name, ownedBy: saved.ownedBy, created: saved.created }, saved, enabled());
    });
    const validation = !configured() ? 'not_configured' : !enabled() ? 'provider_disabled' : modelsOk === null ? 'unchecked' : modelsOk ? 'ok' : modelsError;
    return {
      provider: 'OpenAI',
      configured: configured(),
      enabled: enabled(),
      validated: configured() && enabled() && modelsOk === true,
      validation,
      keyFormatWarning: settings.keyFormatWarning(),
      maskedKey: maskedKey(),
      modelCount: list.length,
      enabledModelCount: list.filter(item => item.enabled).length,
      availableModelCount: list.filter(item => item.available).length,
      checkedAt: modelsAt ? new Date(modelsAt).toISOString() : null,
      endpoint: baseURL,
      models: list,
      usage: state.usage,
      spend: state.spend,
      allowPaidFallback: state.allowPaidFallback,
      monthlySpendLimitUsd: state.monthlySpendLimitUsd,
      recentErrors: state.recentErrors,
      estimatedCosts: true,
    };
  }

  function catalogEntries() {
    if (!configured()) {
      return [{ id: 'openai', name: 'OpenAI GPT', provider: 'OpenAI', configured: false, supported: true, available: false, free: false, reason: validationMessage('not_configured') }];
    }
    if (!enabled()) {
      return [{ id: 'openai', name: 'OpenAI GPT', provider: 'OpenAI', configured: true, supported: true, available: false, free: false, reason: validationMessage('provider_disabled') }];
    }
    const state = settings.snapshot();
    const entries = Object.keys(state.models || {}).map(id => {
      const saved = state.models[id];
      return describeModel({ id, name: saved.name, ownedBy: saved.ownedBy, created: saved.created }, saved, enabled());
    }).filter(item => item.available && modelsOk === true);
    if (entries.length) {
      return entries.map(item => ({
        id: item.id,
        name: item.name,
        provider: 'OpenAI',
        configured: true,
        supported: true,
        available: true,
        free: false,
        capabilities: item.capabilities,
        pricing: item.pricing,
        contextLength: item.contextWindow,
        maxOutput: item.maxOutput,
        minPlan: item.minPlan,
        estimatedCosts: true,
        reason: '',
      }));
    }
    const reason = modelsOk === false ? validationMessage(modelsError) : modelsOk === null ? 'OpenAI models have not been loaded yet.' : 'No OpenAI model is enabled yet. An administrator must verify and enable a model in the admin panel.';
    return [{ id: 'openai', name: 'OpenAI GPT', provider: 'OpenAI', configured: true, supported: true, available: false, free: false, reason }];
  }

  async function testConnection() {
    const started = now();
    if (!configured()) return { ok: false, code: 'not_configured', status: 'not_configured', message: validationMessage('not_configured'), responseTimeMs: 0, checkedAt: new Date(now()).toISOString() };
    try {
      models = await fetchModels();
      settings.syncModels(models);
      modelsOk = true;
      modelsError = null;
      modelsAt = now();
      return { ok: true, code: 'ok', status: 'connected', modelCount: models.length, maskedKey: maskedKey(), responseTimeMs: now() - started, checkedAt: new Date(now()).toISOString() };
    } catch (error) {
      const mapped = mapError(error);
      modelsOk = false;
      modelsError = mapped.code;
      modelsAt = now();
      logger.error(JSON.stringify({ category: 'openai_connection_check', code: mapped.code, status: mapped.status }));
      return { ok: false, code: mapped.code, status: mapped.code, message: mapped.message, maskedKey: maskedKey(), responseTimeMs: now() - started, checkedAt: new Date(now()).toISOString() };
    }
  }

  // One tiny real completion used by the admin panel. It verifies the model, then the admin can
  // enable it explicitly (verification alone never makes a model selectable).
  async function testModel(id) {
    const started = now();
    if (!MODEL_ID.test(String(id || ''))) return { ok: false, code: 'invalid_model', status: 'invalid_model', message: validationMessage('invalid_model'), responseTimeMs: 0, testedAt: new Date(now()).toISOString() };
    if (!configured()) return { ok: false, code: 'not_configured', status: 'not_configured', message: validationMessage('not_configured'), responseTimeMs: 0, testedAt: new Date(now()).toISOString() };
    await refreshModels(modelExists(id) ? false : true);
    if (!modelExists(id)) return { ok: false, code: 'invalid_model', status: 'invalid_model', message: 'That model is not visible to the OpenAI account. Refresh the model list first.', responseTimeMs: 0, testedAt: new Date(now()).toISOString() };
    const meta = settings.modelState(id) || {};
    try {
      const result = await runCompletion({ model: id, system: 'Reply with one short word.', history: [], text: 'Say ok.', maxTokens: 256, enforceActivation: false });
      settings.markModelVerified(id);
      return {
        ok: true,
        model: result.model || id,
        modelName: meta.name || id,
        provider: 'OpenAI',
        usage: result.usage,
        cost: result.cost,
        estimated: true,
        status: 'working',
        reply: 'ok',
        responseTimeMs: now() - started,
        testedAt: new Date(now()).toISOString(),
        key: { id: 'openai-env', slot: 1 },
      };
    } catch (error) {
      const mapped = mapError(error);
      return {
        ok: false,
        model: id,
        modelName: meta.name || id,
        provider: 'OpenAI',
        code: mapped.code,
        status: 'failed',
        message: mapped.message,
        responseTimeMs: now() - started,
        testedAt: new Date(now()).toISOString(),
      };
    }
  }

  function modelExists(id) { return models.some(model => model.id === id) || Boolean(settings.modelState(id)); }

  function estimateCost({ model, text, history, attachments, maxTokens = MAX_OUTPUT_TOKENS } = {}) {
    let chars = String(text || '').length;
    for (const turn of history || []) chars += String(turn?.text || '').length;
    let images = 0;
    for (const file of attachments || []) {
      if (file.kind === 'text') chars += String(file.text || '').length;
      else images += 1;
    }
    const inputTokens = Math.ceil(chars / 4) + images * 1000;
    const outputTokens = Math.max(1, Math.min(Number(maxTokens) || MAX_OUTPUT_TOKENS, 128000));
    const cost = costUsdFor(pricingFor(model), { inputTokens, outputTokens });
    return Number.isFinite(cost) ? cost : NaN;
  }

  function canSpendPaid(context = {}) {
    if (!settings.allowPaidFallback()) return false;
    if (!(settings.monthlySpendLimitUsd() > 0)) return false;
    const estimate = estimateCost(context);
    return Number.isFinite(estimate) && settings.canSpendPaid(estimate);
  }

  function resetCache() { models = []; modelsOk = null; modelsError = null; modelsAt = 0; }

  return {
    configured, enabled, status, refreshModels, catalogEntries, generate, streamGenerate,
    buildMessages, buildRequest, mapError, testConnection, testModel, estimateCost, canSpendPaid,
    resetCache, settings, baseURL,
  };
}

module.exports = {
  createOpenAIProvider,
  validationMessage,
  combinedSignal,
  DEFAULT_BASE_URL,
  TRANSIENT_CODES,
  RETRYABLE_CODES,
  MAX_RETRIES,
  MAX_OUTPUT_TOKENS,
};
