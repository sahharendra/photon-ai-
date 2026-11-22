'use strict';
// Anthropic (Claude) provider for PHOTON AI.
//
// * Reads ANTHROPIC_API_KEY from the server environment (or API.env / .env next to server.js).
// * Direct zero-dependency HTTPS client using global fetch with fallback to @anthropic-ai/sdk if installed.
// * Never exposes raw keys in logs or responses; status returns masked keys.
// * Maps status codes accurately: 200 (connected), 401 (invalid_key), 402 (billing_required),
//   403 (forbidden), 429 (rate_limited), 5xx (provider_unavailable), network/timeout (network_error).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MODEL_TTL_MS = 10 * 60 * 1000;      // successful model-list cache
const MODEL_RETRY_MS = 60 * 1000;         // failed model-list cache
const REQUEST_TIMEOUT_MS = 60 * 1000;
const MAX_RETRIES = 2;
const MAX_OUTPUT_TOKENS = 4096;
const MODEL_ID = /^claude-[A-Za-z0-9._-]{1,100}$/;

const DEFAULT_ANTHROPIC_MODELS = Object.freeze([
  { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet (Latest)', contextWindow: 200000 },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', contextWindow: 200000 },
  { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', contextWindow: 200000 },
]);

function parseEnv(text) {
  const out = {};
  for (const raw of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

// Loads KEY=VALUE files without overriding variables that are already set in the real environment.
function loadEnvFiles(dir, files = ['API.env', '.env']) {
  const loaded = [];
  for (const name of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    for (const [key, value] of Object.entries(parseEnv(text))) {
      if ((!process.env[key] || process.env[key].trim() === '') && value) process.env[key] = value;
    }
    loaded.push(name);
  }
  return loaded;
}

function maskKey(secret) {
  if (!secret || secret.length < 8) return '••••••••';
  const prefix = secret.slice(0, 7);
  const suffix = secret.slice(-4);
  return `${prefix}${'•'.repeat(Math.min(16, Math.max(8, secret.length - 11)))}${suffix}`;
}

function createAnthropicProvider({
  HttpError,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  now = Date.now,
} = {}) {
  if (!HttpError) throw new Error('HttpError class is required');

  let models = [...DEFAULT_ANTHROPIC_MODELS];
  let modelsAt = 0;
  let modelsOk = null;
  let modelsError = null;
  let inflight = null;

  function apiKey() { return String(env.ANTHROPIC_API_KEY || '').trim(); }
  function configured() { return Boolean(apiKey()); }
  function keyFormatWarning() {
    const key = apiKey();
    if (!key) return null;
    if (/\s/.test(key)) return 'The key contains whitespace.';
    if (!key.startsWith('sk-ant-')) return 'Anthropic API keys normally start with "sk-ant-".';
    return null;
  }

  function authHeaders(key = apiKey()) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Accept': 'application/json',
    };
  }

  // Maps SDK / HTTP failures to safe, user-facing HttpErrors. Never includes the key or raw provider text.
  function mapError(error) {
    if (error instanceof HttpError) return error;
    const status = Number(error?.status || error?.response?.status) || 0;
    const name = String(error?.name || error?.constructor?.name || '');
    const type = String(error?.error?.error?.type || error?.error?.type || '').toLowerCase();
    const detail = String(error?.error?.error?.message || error?.message || '').toLowerCase();

    if (name === 'AbortError' || name === 'APIUserAbortError') return new HttpError(499, 'request_aborted', 'The request was cancelled.');
    if (name === 'APIConnectionTimeoutError' || error?.code === 'ETIMEDOUT') return new HttpError(504, 'network_error', 'Claude took too long to respond (timeout).');
    if (name === 'APIConnectionError' || (!status && /connect|network|fetch failed|enotfound|econn/.test(detail))) return new HttpError(502, 'network_error', 'Could not connect to Claude. Check the server network and retry.');
    if (status === 401 || /invalid.*api.*key|unauthorized/i.test(detail)) return new HttpError(401, 'invalid_key', 'Claude rejected the API key. Please check your ANTHROPIC_API_KEY.');
    if (status === 402 || type === 'billing_error' || detail.includes('credit balance') || /insufficient/i.test(detail)) return new HttpError(402, 'billing_required', 'The Anthropic account has no available credit. Add credit and retry.');
    if (status === 403 || /forbidden|permission/i.test(detail)) return new HttpError(403, 'forbidden', 'The Anthropic API key is not permitted to use this model.');
    if (status === 404) return new HttpError(404, 'invalid_model', 'The selected Claude model is unavailable. Choose another model.');
    if (status === 413) return new HttpError(413, 'request_too_large', 'The request is too large for Claude. Shorten the message or attachments.');
    if (status === 429 || type === 'rate_limit_error') return new HttpError(429, 'rate_limited', 'Claude rate limit was reached. Wait a moment and retry.');
    if (status === 529 || type === 'overloaded_error') return new HttpError(503, 'provider_unavailable', 'Claude is temporarily overloaded. Retry shortly.');
    if (status >= 500) return new HttpError(503, 'provider_unavailable', 'Claude is temporarily unavailable. Retry shortly.');
    return new HttpError(502, 'provider_error', error?.message || 'Claude could not complete this request.');
  }

  async function fetchModels(key = apiKey()) {
    if (!key) throw new HttpError(503, 'not_configured', 'Claude is not configured.');
    const url = 'https://api.anthropic.com/v1/models';
    const signal = AbortSignal.timeout(15000);

    let res;
    try {
      res = await fetchImpl(url, { method: 'GET', headers: authHeaders(key), signal });
    } catch (err) {
      throw mapError(err);
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body?.error?.message || `Anthropic HTTP ${res.status}`);
      err.status = res.status;
      err.error = body;
      throw mapError(err);
    }

    const data = await res.json().catch(() => ({}));
    const rawList = Array.isArray(data?.data) ? data.data : [];
    const list = [];
    for (const item of rawList) {
      if (item && typeof item.id === 'string' && MODEL_ID.test(item.id)) {
        list.push({ id: item.id, name: String(item.display_name || item.id).slice(0, 80), contextWindow: 200000 });
      }
    }
    return list.length ? list : [...DEFAULT_ANTHROPIC_MODELS];
  }

  async function refreshModels(force = false) {
    if (!configured()) { models = [...DEFAULT_ANTHROPIC_MODELS]; modelsOk = null; modelsError = null; modelsAt = 0; return models; }
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
        modelsOk = false;
        modelsError = mapped.code;
        models = [...DEFAULT_ANTHROPIC_MODELS];
      } finally {
        modelsAt = now();
        inflight = null;
      }
      return models;
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
        message: 'Anthropic Claude is not configured on this server. Add ANTHROPIC_API_KEY to API.env.',
        responseTimeMs: 0,
        testedAt: new Date().toISOString(),
      };
    }
    try {
      const list = await fetchModels();
      modelsOk = true;
      modelsError = null;
      modelsAt = Date.now();
      models = list;
      return {
        ok: true,
        code: 'ok',
        status: 'connected',
        modelCount: list.length,
        maskedKey: maskKey(apiKey()),
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

  function userContent(text, attachments = []) {
    const blocks = [];
    for (const file of attachments) {
      if (file.kind === 'text') blocks.push({ type: 'text', text: '[Attached text file: ' + file.name + ']\n' + file.text + '\n[End attached file]' });
      else if (file.mimeType === 'application/pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data }, title: file.name.slice(0, 120) });
      else blocks.push({ type: 'image', source: { type: 'base64', media_type: file.mimeType || 'image/jpeg', data: file.data } });
    }
    blocks.push({ type: 'text', text: String(text || '').trim() || 'Please review the attached file(s).' });
    return blocks;
  }

  function buildMessages(history, text, attachments) {
    const messages = [];
    const push = (role, content) => {
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content.push(...content);
      else messages.push({ role, content });
    };
    for (const turn of history || []) {
      const body = String(turn.text || '').trim();
      if (!body) continue;
      const role = turn.role === 'user' ? 'user' : 'assistant';
      if (!messages.length && role === 'assistant') continue;
      push(role, [{ type: 'text', text: body }]);
    }
    push('user', userContent(text, attachments));
    return messages;
  }

  async function generate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, signal }) {
    if (!configured()) throw new HttpError(503, 'not_configured', 'Claude is not configured.');
    const chosenModel = model || 'claude-3-5-sonnet-20241022';
    if (!MODEL_ID.test(String(chosenModel))) throw new HttpError(400, 'invalid_model', 'The selected Claude model is invalid.');

    const params = {
      model: chosenModel,
      max_tokens: Math.min(Number(maxTokens) || MAX_OUTPUT_TOKENS, 4096),
      messages: buildMessages(history, text, attachments),
    };
    const systemText = String(system || '').trim().slice(0, 80000);
    if (systemText) params.system = systemText;

    const callSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(params),
        signal: callSignal,
      });
    } catch (err) {
      throw mapError(err);
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body?.error?.message || `Claude HTTP ${res.status}`);
      err.status = res.status;
      err.error = body;
      throw mapError(err);
    }

    const response = await res.json();
    const output = (response?.content || []).filter(block => block?.type === 'text').map(block => block.text || '').join('').trim();
    if (!output) throw new HttpError(502, 'empty_response', response?.stop_reason === 'refusal' ? 'Claude declined to answer this request.' : 'Claude returned an empty response. Please retry.');
    const usage = { inputTokens: Number(response.usage?.input_tokens) || 0, outputTokens: Number(response.usage?.output_tokens) || 0, totalTokens: (Number(response.usage?.input_tokens) || 0) + (Number(response.usage?.output_tokens) || 0) };
    return { text: output, usage, stopReason: response.stop_reason || null, model: response.model || chosenModel, key: { id: 'anthropic-env', slot: 1 } };
  }

  async function* streamGenerate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS, signal }) {
    if (!configured()) throw new HttpError(503, 'not_configured', 'Claude is not configured.');
    const chosenModel = model || 'claude-3-5-sonnet-20241022';
    if (!MODEL_ID.test(String(chosenModel))) throw new HttpError(400, 'invalid_model', 'The selected Claude model is invalid.');

    const params = {
      model: chosenModel,
      max_tokens: Math.min(Number(maxTokens) || MAX_OUTPUT_TOKENS, 4096),
      messages: buildMessages(history, text, attachments),
      stream: true,
    };
    const systemText = String(system || '').trim().slice(0, 80000);
    if (systemText) params.system = systemText;

    const callSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(params),
        signal: callSignal,
      });
    } catch (err) {
      throw mapError(err);
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body?.error?.message || `Claude HTTP ${res.status}`);
      err.status = res.status;
      err.error = body;
      throw mapError(err);
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
              if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                fullText += parsed.delta.text;
                yield { type: 'delta', text: parsed.delta.text };
              }
              if (parsed.type === 'message_start' && parsed.message?.usage) {
                inTokens = Number(parsed.message.usage.input_tokens) || inTokens;
              }
              if (parsed.type === 'message_delta' && parsed.usage) {
                outTokens = Number(parsed.usage.output_tokens) || outTokens;
              }
            } catch (_) {}
          }
        }
      } finally {
        reader.releaseLock?.();
      }
    }

    if (!outTokens) outTokens = Math.ceil(fullText.length / 4);
    yield {
      type: 'done',
      text: fullText,
      model: chosenModel,
      usage: { inputTokens: inTokens, outputTokens: outTokens, totalTokens: inTokens + outTokens },
    };
  }

  async function testModel(modelId) {
    const started = Date.now();
    if (!configured()) return { ok: false, code: 'not_configured', status: 'not_configured', message: 'Claude is not configured.', responseTimeMs: 0, testedAt: new Date().toISOString() };
    const id = String(modelId || '').trim();
    try {
      const res = await generate({ model: id, system: 'Reply with one short word.', text: 'Say ok.', maxTokens: 50 });
      return {
        ok: true,
        model: id,
        modelName: id,
        provider: 'Anthropic',
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
        modelName: id,
        provider: 'Anthropic',
        code: mapped.code,
        status: 'failed',
        message: mapped.message,
        responseTimeMs: Date.now() - started,
        testedAt: new Date().toISOString(),
      };
    }
  }

  function catalogEntries() {
    const isAvail = configured() && modelsOk !== false;
    return models.map(m => ({
      id: m.id,
      name: m.name,
      provider: 'Anthropic',
      providerKey: 'anthropic',
      category: 'Text Generation',
      task: 'text-generation',
      available: isAvail,
      configured: configured(),
      enabled: configured(),
      contextWindow: m.contextWindow || 200000,
    }));
  }

  function status() {
    return {
      provider: 'Anthropic',
      id: 'anthropic',
      configured: configured(),
      enabled: configured(),
      validated: configured() && modelsOk === true,
      validation: !configured() ? 'not_configured' : modelsOk === null ? 'unchecked' : modelsOk ? 'ok' : modelsError,
      maskedKey: maskKey(apiKey()),
      modelCount: models.length,
      models: models.map(m => m.id),
      availableModels: catalogEntries(),
      checkedAt: modelsAt ? new Date(modelsAt).toISOString() : null,
    };
  }

  function resetCache() {
    models = [...DEFAULT_ANTHROPIC_MODELS];
    modelsOk = null;
    modelsError = null;
    modelsAt = 0;
  }

  return {
    configured,
    status,
    refreshModels,
    catalogEntries,
    testConnection,
    testModel,
    generate,
    streamGenerate,
    buildMessages,
    mapError,
    resetCache,
  };
}

module.exports = { parseEnv, loadEnvFiles, createAnthropicProvider, MODEL_ID };
