'use strict';
// Minimal local Ollama provider for PHOTON AI (Gemma and other local models).
//
// * No API key is used. The endpoint is local by default (http://127.0.0.1:11434) and nothing is
//   sent anywhere else unless OLLAMA_BASE_URL explicitly points at another host.
// * Models are discovered live from GET /api/tags. Nothing is hardcoded and a model is offered
//   only while the local server actually returns it.
// * Local models are classified as free, so they can participate in the safe fallback policy
//   without ever switching a user to a paid provider.
// * The server still starts when Ollama is not installed or not running.

const { parseRetryAfter, backoffDelay } = require('./gemini-provider');

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const MODEL_TTL_MS = 60 * 1000;
const MODEL_RETRY_MS = 30 * 1000;
const TAGS_TIMEOUT_MS = 2500;
const REQUEST_TIMEOUT_MS = 120 * 1000;
const MAX_RETRIES = 2;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_MODELS = 100;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,160}$/;

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
    case 'not_configured': return 'No local Ollama endpoint is configured. Set OLLAMA_BASE_URL or start Ollama.';
    case 'provider_disabled': return 'Local Ollama is disabled by the administrator.';
    case 'network_error': return 'No local Ollama server responded. Start Ollama and pull a model such as gemma.';
    case 'provider_timeout': return 'The local Ollama server took too long to respond.';
    case 'invalid_model': return 'That local Ollama model is not installed.';
    case 'provider_unavailable': return 'The local Ollama server is temporarily unavailable.';
    case 'empty_response': return 'The local Ollama model returned an empty response. Please retry.';
    case 'unsupported_attachment': return 'The local Ollama adapter accepts text attachments only. Attach an image-free or text version of the file.';
    case 'request_aborted': return 'The request was cancelled.';
    default: return 'The local Ollama request could not be completed.';
  }
}

function createOllamaProvider({ HttpError, env = process.env, fetchImpl = globalThis.fetch, logger = console, sleep, random, now = Date.now } = {}) {
  if (!HttpError) throw new Error('HttpError class is required');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  const wait = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const jitter = random || Math.random;
  const baseUrl = String(env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const tagsUrl = `${baseUrl}/api/tags`;
  const chatUrl = `${baseUrl}/api/chat`;
  const disabled = env.OLLAMA_ENABLED === '0';
  let models = [];
  let modelsAt = 0;
  let modelsOk = null;
  let modelsError = null;
  let inflight = null;

  // Absent an explicit OLLAMA_BASE_URL the default localhost endpoint is used. "configured" means
  // the adapter is allowed to try; "connected" means a live /api/tags request succeeded.
  function configured() { return !disabled && Boolean(baseUrl); }
  function connected() { return configured() && modelsOk === true; }

  function mapError(error) {
    if (error instanceof HttpError) return error;
    const status = Number(error?.status) || 0;
    const name = String(error?.name || error?.constructor?.name || '');
    const detail = String(error?.error?.message || error?.message || '').toLowerCase();
    if (name === 'AbortError' || name === 'TimeoutError' || error?.code === 'ABORT_ERR') return new HttpError(504, 'provider_timeout', validationMessage('provider_timeout'));
    if (!status && /fetch failed|network|enotfound|econn|socket|connect|terminated/.test(detail + ' ' + name.toLowerCase())) return new HttpError(502, 'network_error', validationMessage('network_error'));
    if (status === 404) return new HttpError(502, 'invalid_model', validationMessage('invalid_model'));
    if (status === 400) return new HttpError(502, 'provider_rejected_request', 'The local Ollama server rejected this request.');
    if (status >= 500) return new HttpError(503, 'provider_unavailable', validationMessage('provider_unavailable'));
    return new HttpError(502, 'provider_error', 'The local Ollama request could not be completed.');
  }

  async function withRetry(operation, { signal } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) throw new HttpError(499, 'request_aborted', validationMessage('request_aborted'));
      try { return await operation(attempt); }
      catch (raw) {
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
    let response;
    try { response = await fetchImpl(tagsUrl, { method: 'GET', signal: AbortSignal.timeout(TAGS_TIMEOUT_MS) }); }
    catch (error) { throw mapError(error); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw mapError(Object.assign(new Error(data?.error || 'Ollama model list failed'), { status: response.status }));
    const list = Array.isArray(data?.models) ? data.models : [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      const id = String(raw?.name || raw?.model || '');
      if (!MODEL_ID.test(id) || seen.has(id)) continue;
      // Ollama cloud models (for example "name:cloud") run on Ollama's servers and need a separate
      // account/plan. They are neither local nor guaranteed free, so they are never advertised as
      // free/local fallback destinations.
      if (/:cloud$/i.test(id) || raw?.remote_host || raw?.remote_model) continue;
      seen.add(id);
      out.push({
        id,
        name: String(raw?.name || id).slice(0, 80),
        size: Number(raw?.size) || null,
        modifiedAt: raw?.modified_at ? String(raw.modified_at).slice(0, 40) : null,
        family: raw?.details?.family ? String(raw.details.family).slice(0, 40) : null,
        parameterSize: raw?.details?.parameter_size ? String(raw.details.parameter_size).slice(0, 40) : null,
      });
    }
    return out.sort((a, b) => {
      const gemmaA = /^gemma/i.test(a.id) ? 0 : 1;
      const gemmaB = /^gemma/i.test(b.id) ? 0 : 1;
      return gemmaA - gemmaB || a.id.localeCompare(b.id);
    }).slice(0, MAX_MODELS);
  }

  async function refreshModels(force = false) {
    if (!configured()) { models = []; modelsOk = null; modelsError = null; modelsAt = 0; return models; }
    const ttl = modelsOk === false ? MODEL_RETRY_MS : MODEL_TTL_MS;
    if (!force && modelsAt && now() - modelsAt < ttl) return models;
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
    if (!models.length) return null;
    return (models.find(model => /^gemma/i.test(model.id)) || models[0]).id;
  }

  function validateModel(id) {
    if (!MODEL_ID.test(String(id || ''))) throw new HttpError(400, 'invalid_model', 'The selected local model is invalid.');
    if (!configured()) throw new HttpError(503, 'provider_not_configured', validationMessage('not_configured'));
    if (!models.some(model => model.id === id)) throw new HttpError(503, 'invalid_model', validationMessage('invalid_model'));
  }

  function userContent(text, attachments = []) {
    const body = String(text || '').trim() || 'Please review the attached file(s).';
    if (!attachments.length) return body;
    const parts = [];
    for (const file of attachments) {
      if (file.kind === 'text') parts.push('[Attached text file: ' + file.name + ']\n' + file.text + '\n[End attached file]');
      else throw new HttpError(415, 'unsupported_attachment', validationMessage('unsupported_attachment'));
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
    const inputTokens = Number(data?.prompt_eval_count) || 0;
    const outputTokens = Number(data?.eval_count) || 0;
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cost: 0 };
  }

  async function generate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, signal }) {
    validateModel(model);
    const body = JSON.stringify(buildRequest({ model, system, history, text, attachments, maxTokens }));
    const data = await withRetry(async () => {
      let response;
      try {
        response = await fetchImpl(chatUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: combinedSignal(signal, REQUEST_TIMEOUT_MS) });
      } catch (error) {
        if (signal?.aborted) throw new HttpError(499, 'request_aborted', validationMessage('request_aborted'));
        throw mapError(error);
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.error) throw mapError(Object.assign(new Error(payload?.error || 'Ollama request failed'), { status: response.status, error: payload }));
      return payload;
    }, { signal });
    const output = String(data?.message?.content || '').trim();
    if (!output) throw new HttpError(502, 'empty_response', validationMessage('empty_response'));
    return { text: output, usage: normalizeUsage(data), cost: 0, stopReason: data?.done_reason || null, model: data?.model || model, key: { id: 'ollama-local', slot: 1 }, local: true, free: true };
  }

  async function* streamGenerate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, signal }) {
    validateModel(model);
    const body = JSON.stringify(buildRequest({ model, system, history, text, attachments, maxTokens, stream: true }));
    const response = await withRetry(async () => {
      let res;
      try {
        res = await fetchImpl(chatUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: combinedSignal(signal, REQUEST_TIMEOUT_MS) });
      } catch (error) {
        if (signal?.aborted) throw new HttpError(499, 'request_aborted', validationMessage('request_aborted'));
        throw mapError(error);
      }
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw mapError(Object.assign(new Error(payload?.error || 'Ollama stream failed'), { status: res.status, error: payload }));
      }
      if (!res.body) throw new HttpError(502, 'provider_error', 'The local Ollama server did not return a response stream.');
      return res;
    }, { signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let usage = null;
    let responseModel = model;
    let finishReason = null;
    function* consumeLine(rawLine) {
      const line = String(rawLine || '').trim();
      if (!line) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event?.error) throw mapError(Object.assign(new Error(event.error), { status: 502, error: event }));
      if (event?.model) responseModel = event.model;
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
    const output = full.trim();
    if (!output) throw new HttpError(502, 'empty_response', validationMessage('empty_response'));
    yield { type: 'done', text: output, usage, cost: 0, model: responseModel, stopReason: finishReason, key: { id: 'ollama-local', slot: 1 }, local: true, free: true };
  }

  async function testConnection() {
    if (!configured()) return { ok: false, code: 'not_configured', message: validationMessage('not_configured'), checkedAt: new Date(now()).toISOString() };
    try {
      models = await fetchModels();
      modelsOk = true;
      modelsError = null;
      modelsAt = now();
      return { ok: true, code: 'ok', modelCount: models.length, defaultModel: defaultModelId(), checkedAt: new Date(now()).toISOString() };
    } catch (error) {
      const mapped = mapError(error);
      models = [];
      modelsOk = false;
      modelsError = mapped.code;
      modelsAt = now();
      return { ok: false, code: mapped.code, status: mapped.status, message: mapped.message, checkedAt: new Date(now()).toISOString() };
    }
  }

  async function testModel(id) {
    await refreshModels();
    if (!models.some(model => model.id === id)) return { ok: false, code: 'invalid_model', message: validationMessage('invalid_model') };
    try {
      const result = await generate({ model: id, system: 'Reply with one short word.', history: [], text: 'Say ok.', maxTokens: 16 });
      return { ok: true, model: result.model, usage: result.usage, cost: 0, local: true };
    } catch (error) {
      const mapped = mapError(error);
      return { ok: false, code: mapped.code, message: mapped.message };
    }
  }

  function status() {
    const validation = !configured() ? 'not_configured' : modelsOk === null ? 'unchecked' : modelsOk ? 'ok' : modelsError;
    return {
      provider: 'Ollama',
      configured: configured(),
      connected: connected(),
      validated: connected(),
      validation,
      local: true,
      free: true,
      modelCount: models.length,
      checkedAt: modelsAt ? new Date(modelsAt).toISOString() : null,
      endpoint: baseUrl,
      defaultModel: defaultModelId(),
      models: models.map(model => ({ id: model.id, name: model.name, family: model.family, parameterSize: model.parameterSize, available: true, free: true, local: true })),
    };
  }

  function catalogEntries() {
    if (!configured()) {
      return [{ id: 'ollama', name: 'Local Ollama', provider: 'Ollama', configured: false, supported: true, available: false, free: true, local: true, reason: validationMessage('not_configured') }];
    }
    if (models.length && modelsOk === true) {
      return models.map(model => ({
        id: model.id,
        name: model.name,
        provider: 'Ollama',
        configured: true,
        supported: true,
        available: true,
        free: true,
        local: true,
        capabilities: { text: true, vision: false, pdf: false },
        contextLength: null,
        reason: '',
      }));
    }
    const reason = modelsOk === false ? validationMessage(modelsError) : modelsOk === null ? 'Local Ollama models have not been loaded yet.' : 'No local Ollama models are installed. Run "ollama pull gemma".';
    return [{ id: 'ollama', name: 'Local Ollama', provider: 'Ollama', configured: true, supported: true, available: false, free: true, local: true, reason }];
  }

  function resetCache() { models = []; modelsOk = null; modelsError = null; modelsAt = 0; }

  return { configured, connected, status, refreshModels, catalogEntries, generate, streamGenerate, testConnection, testModel, buildMessages, buildRequest, mapError, resetCache, defaultModelId, baseUrl };
}

module.exports = { createOllamaProvider, validationMessage, DEFAULT_BASE_URL, MODEL_ID };
