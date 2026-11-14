'use strict';
// Anthropic (Claude) provider for PHOTON AI.
// - Reads ANTHROPIC_API_KEY from the server environment (or API.env / .env next to server.js).
// - Uses the official @anthropic-ai/sdk, loaded lazily so the server still starts (and Gemini keeps
//   working) if the package has not been installed yet.
// - The key never leaves this module: status() and every error message are key-free.
const fs = require('node:fs');
const path = require('node:path');

const MODEL_TTL_MS = 10 * 60 * 1000;      // successful model-list cache
const MODEL_RETRY_MS = 60 * 1000;         // failed model-list cache
const REQUEST_TIMEOUT_MS = 60 * 1000;
const MAX_RETRIES = 2;                    // SDK retries 429/5xx/connection errors with backoff
const MAX_OUTPUT_TOKENS = 4096;
const MODEL_ID = /^claude-[A-Za-z0-9._-]{1,100}$/;

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
      if (!process.env[key] && value) process.env[key] = value;
    }
    loaded.push(name);
  }
  return loaded;
}

function createAnthropicProvider({ HttpError, env = process.env, loadSdk, logger = console } = {}) {
  if (!HttpError) throw new Error('HttpError class is required');
  let client = null; let clientKey = null;
  let models = []; let modelsAt = 0; let modelsOk = null; let modelsError = null; let inflight = null;
  const sdkLoader = loadSdk || (() => require('@anthropic-ai/sdk'));

  function apiKey() { return String(env.ANTHROPIC_API_KEY || '').trim(); }
  function configured() { return Boolean(apiKey()); }
  function keyFormatWarning() {
    const key = apiKey();
    if (!key) return null;
    if (/\s/.test(key)) return 'The key contains whitespace.';
    if (!key.startsWith('sk-ant-')) return 'Anthropic API keys normally start with "sk-ant-".';
    return null;
  }

  function getClient() {
    const key = apiKey();
    if (!key) throw new HttpError(503, 'provider_not_configured', 'Claude is not configured on this server.');
    if (client && clientKey === key) return client;
    let mod;
    try { mod = sdkLoader(); } catch (error) {
      logger.error(JSON.stringify({ category: 'anthropic_sdk_missing', code: error?.code || 'unknown' }));
      throw new HttpError(503, 'provider_not_installed', 'Claude support is not installed on this server. Run "npm install @anthropic-ai/sdk" and restart.');
    }
    const Anthropic = mod?.default || mod?.Anthropic || mod;
    client = new Anthropic({ apiKey: key, timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
    clientKey = key;
    return client;
  }

  // Maps SDK / HTTP failures to safe, user-facing HttpErrors. Never includes the key or raw provider text.
  function mapError(error) {
    if (error instanceof HttpError) return error;
    const status = Number(error?.status) || 0;
    const name = String(error?.name || error?.constructor?.name || '');
    const type = String(error?.error?.error?.type || error?.error?.type || '').toLowerCase();
    const detail = String(error?.error?.error?.message || error?.message || '').toLowerCase();
    if (name === 'APIConnectionTimeoutError' || error?.code === 'ETIMEDOUT') return new HttpError(504, 'provider_timeout', 'Claude took too long to respond. Please retry.');
    if (name === 'APIConnectionError' || (!status && /connect|network|fetch failed|enotfound|econn/.test(detail))) return new HttpError(502, 'network_error', 'Could not connect to Claude. Check the server network and retry.');
    if (name === 'APIUserAbortError') return new HttpError(499, 'request_aborted', 'The request was cancelled.');
    if (status === 401) return new HttpError(502, 'invalid_api_key', 'Claude rejected the server API key. The administrator must update ANTHROPIC_API_KEY.');
    if (status === 402 || type === 'billing_error' || detail.includes('credit balance')) return new HttpError(402, 'billing_required', 'The Anthropic account has no available credit. The administrator must add credit and retry.');
    if (status === 403) return new HttpError(502, 'provider_forbidden', 'The Anthropic API key is not permitted to use this model.');
    if (status === 404) return new HttpError(502, 'invalid_model', 'The selected Claude model is unavailable. Choose another model.');
    if (status === 413) return new HttpError(413, 'request_too_large', 'The request is too large for Claude. Shorten the message or attachments.');
    if (status === 429 || type === 'rate_limit_error') return new HttpError(429, 'quota_or_rate_limit', 'Claude rate limit was reached. Wait a moment and retry.');
    if (status === 529 || type === 'overloaded_error') return new HttpError(503, 'provider_overloaded', 'Claude is temporarily overloaded. Retry shortly.');
    if (status >= 500) return new HttpError(503, 'provider_unavailable', 'Claude is temporarily unavailable. Retry shortly.');
    if (status === 400) return new HttpError(502, 'provider_rejected_request', 'Claude could not process this request. Try simplifying the message or attachments.');
    return new HttpError(502, 'provider_error', 'Claude could not complete this request.');
  }

  async function fetchModels() {
    const list = [];
    for await (const item of getClient().models.list({ limit: 100 })) {
      if (item && typeof item.id === 'string' && MODEL_ID.test(item.id)) list.push({ id: item.id, name: String(item.display_name || item.id).slice(0, 80) });
      if (list.length >= 100) break;
    }
    return list;
  }

  // Never throws. Refreshes the cached account model list from the live API.
  async function refreshModels(force = false) {
    if (!configured()) { models = []; modelsOk = null; modelsError = null; modelsAt = 0; return models; }
    const ttl = modelsOk === false ? MODEL_RETRY_MS : MODEL_TTL_MS;
    if (!force && modelsAt && Date.now() - modelsAt < ttl) return models;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        models = await fetchModels(); modelsOk = true; modelsError = null;
      } catch (error) {
        const mapped = mapError(error);
        modelsOk = false; modelsError = mapped.code;
        if (mapped.code === 'invalid_api_key' || mapped.code === 'provider_forbidden') models = [];
        logger.error(JSON.stringify({ category: 'anthropic_models', code: mapped.code, status: mapped.status }));
      } finally { modelsAt = Date.now(); inflight = null; }
      return models;
    })();
    return inflight;
  }

  function status() {
    return {
      configured: configured(),
      keyFormatWarning: keyFormatWarning(),
      validation: !configured() ? 'not_configured' : modelsOk === null ? 'unchecked' : modelsOk ? 'ok' : modelsError,
      modelCount: models.length,
      checkedAt: modelsAt ? new Date(modelsAt).toISOString() : null,
    };
  }

  function catalogEntries() {
    if (!configured()) return [{ id: 'claude', name: 'Claude', provider: 'Anthropic', configured: false, supported: true, reason: 'Anthropic is not configured on this server.' }];
    if (models.length) return models.map(m => ({ id: m.id, name: m.name, provider: 'Anthropic', configured: true, supported: true, reason: '' }));
    return [{ id: 'claude', name: 'Claude', provider: 'Anthropic', configured: true, supported: true, reason: modelsOk === false ? 'Claude models could not be loaded from the Anthropic account.' : 'Claude models have not been loaded yet.', unavailable: true }];
  }

  function userContent(text, attachments = []) {
    const blocks = [];
    for (const file of attachments) {
      if (file.kind === 'text') blocks.push({ type: 'text', text: '[Attached text file: ' + file.name + ']\n' + file.text + '\n[End attached file]' });
      else if (file.mimeType === 'application/pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data }, title: file.name.slice(0, 120) });
      else blocks.push({ type: 'image', source: { type: 'base64', media_type: file.mimeType, data: file.data } });
    }
    blocks.push({ type: 'text', text: String(text || '').trim() || 'Please review the attached file(s).' });
    return blocks;
  }

  // history: [{ role: 'user'|'assistant'|'model', text }] oldest first. Anthropic requires alternating roles
  // that start with "user", so consecutive same-role turns are merged and leading assistant turns dropped.
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

  async function generate({ model, system, history, text, attachments, maxTokens = MAX_OUTPUT_TOKENS }) {
    if (!MODEL_ID.test(String(model || ''))) throw new HttpError(400, 'invalid_model', 'The selected Claude model is invalid.');
    const params = { model, max_tokens: maxTokens, messages: buildMessages(history, text, attachments) };
    const systemText = String(system || '').trim().slice(0, 80000);
    if (systemText) params.system = systemText;
    let response;
    try { response = await getClient().messages.create(params); } catch (error) {
      const mapped = mapError(error);
      logger.error(JSON.stringify({ category: 'anthropic_request', code: mapped.code, status: mapped.status, provider_status: error?.status || null, request_id: error?.requestID || error?.request_id || null }));
      throw mapped;
    }
    const output = (response?.content || []).filter(block => block?.type === 'text').map(block => block.text || '').join('').trim();
    if (!output) throw new HttpError(502, 'empty_response', response?.stop_reason === 'refusal' ? 'Claude declined to answer this request.' : 'Claude returned an empty response. Please retry.');
    const usage = { inputTokens: Number(response.usage?.input_tokens) || 0, outputTokens: Number(response.usage?.output_tokens) || 0 };
    return { text: output, usage, stopReason: response.stop_reason || null, model: response.model || model };
  }

  return { configured, status, refreshModels, catalogEntries, generate, buildMessages, mapError, getClient };
}

module.exports = { parseEnv, loadEnvFiles, createAnthropicProvider, MODEL_ID };
