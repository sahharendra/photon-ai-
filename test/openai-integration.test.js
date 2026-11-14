'use strict';
// Starts the real server.js from a temp copy against LOCAL stand-ins for the OpenAI and Ollama
// HTTP APIs. No real OpenAI request or credit is used. Authenticated chat needs a Firebase token,
// so this test covers startup, admin control, model gating, usage and secret protection through
// the public/admin surfaces.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const FILES = ['server.js', 'anthropic-provider.js', 'openrouter-provider.js', 'openrouter-keys.js', 'gemini-keys.js', 'gemini-provider.js', 'openai-config.js', 'openai-provider.js', 'ollama-provider.js', 'codecraft-config.js', 'codecraft-provider.js', 'groq-config.js', 'groq-provider.js', 'nvidia-config.js', 'nvidia-provider.js', 'provider-fallback.js', 'provider-access-service.js', 'dashboard-analytics.js', 'photon-limits.js', 'photon-usage.js', 'photon-admin-users.js', 'photon-admin-subscriptions.js', 'pricing-rules-service.js', 'cashfree-service.js', 'index.html', 'admin.html'];
const SECRET = 'sk-itest-SUPERSECRET-0123456789abcdef';
const MODEL = 'gpt-5-mini';

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function fakeOpenAI({ validKey = SECRET, models = [{ id: MODEL, owned_by: 'openai' }, { id: 'text-embedding-3-small', owned_by: 'openai' }], onChat } = {}) {
  const seen = { models: 0, chats: [] };
  const server = http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      seen.models += 1;
      if (token !== validKey) return send(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
      return send(200, { object: 'list', data: models.map(model => ({ id: model.id, object: 'model', created: 1700000000, owned_by: model.owned_by || 'openai' })), has_more: false });
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
      const body = await readJson(req).catch(() => ({}));
      seen.chats.push(body);
      if (token !== validKey) return send(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
      if (onChat) return onChat({ req, res, body, send, seen });
      return send(200, { id: 'chatcmpl-itest', object: 'chat.completion', model: body.model || MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } });
    }
    send(404, { error: { message: 'not found', type: 'invalid_request_error', code: 'not_found' } });
  });
  return { server, seen };
}

function fakeOllama({ models = [{ name: 'gemma3:4b', details: { family: 'gemma', parameter_size: '4B' } }] } = {}) {
  const seen = { tags: 0, chats: [], auth: [] };
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    seen.auth.push(String(req.headers.authorization || ''));
    if (req.method === 'GET' && req.url.startsWith('/api/tags')) {
      seen.tags += 1;
      return send(200, { models });
    }
    if (req.method === 'POST' && req.url.startsWith('/api/chat')) {
      const body = await readJson(req).catch(() => ({}));
      seen.chats.push(body);
      return send(200, { model: body.model || 'gemma3:4b', message: { role: 'assistant', content: 'local answer' }, prompt_eval_count: 5, eval_count: 2, done: true });
    }
    send(404, { message: 'not found' });
  });
  return { server, seen };
}

async function startPhoton({ port, openai, ollama }) {
  const openAiFake = fakeOpenAI(openai);
  const ollamaFake = fakeOllama(ollama);
  const openAiPort = await listen(openAiFake.server);
  const ollamaPort = await listen(ollamaFake.server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-openai-'));
  for (const file of FILES) fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(GEMINI|ANTHROPIC|OPENAI|OLLAMA|OPENROUTER_API_KEY|PHOTON_ADMIN_NO_AUTH)/.test(name)) delete env[name];
  Object.assign(env, {
    PORT: String(port),
    NODE_ENV: 'production',
    PHOTON_ADMIN_PASSWORD: 'itest-admin-pass',
    OPENAI_API_KEY: SECRET,
    OPENAI_BASE_URL: `http://127.0.0.1:${openAiPort}/v1`,
    OLLAMA_BASE_URL: `http://127.0.0.1:${ollamaPort}`,
  });
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (/OpenAI configured:/.test(logs) && /Ollama local:/.test(logs)) { clearInterval(iv); resolve(); }
      else if (Date.now() - started > 20000) { clearInterval(iv); reject(new Error('server did not finish startup diagnostics:\n' + logs)); }
    }, 50);
  });
  const auth = { Authorization: 'Basic ' + Buffer.from('admin:itest-admin-pass').toString('base64') };
  const call = async (method, route, body, headers = auth) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  const stop = () => { child.kill(); openAiFake.server.close(); ollamaFake.server.close(); };
  return { call, dir, logs: () => logs, openai: openAiFake, ollama: ollamaFake, stop };
}

test('OpenAI startup, discovery, verification, enablement and usage are admin-controlled', async () => {
  const s = await startPhoton({ port: 34611 });
  try {
    let config = await s.call('GET', '/api/profile/config', null, {});
    assert.strictEqual(config.status, 200);
    const before = config.json.data.models.filter(model => model.provider === 'OpenAI');
    assert.strictEqual(before.length, 1);
    assert.strictEqual(before[0].configured, true);
    assert.strictEqual(before[0].available, false, 'no GPT model is selectable before verification');
    assert.strictEqual(before[0].free, false);
    assert.match(before[0].reason, /must verify and enable/i);

    const status = await s.call('GET', '/api/admin/openai');
    assert.strictEqual(status.status, 200);
    const data = status.json.data;
    assert.strictEqual(data.status.configured, true);
    assert.strictEqual(data.status.validation, 'ok');
    assert.strictEqual(data.status.modelCount, 1);
    assert.strictEqual(data.status.enabledModelCount, 0);
    assert.ok(data.maskedKey && data.maskedKey !== SECRET);
    assert.ok(!status.text.includes(SECRET));
    assert.ok(data.models.every(model => model.available === false && model.pricing.source === 'published'));

    // Enabling an unverified model performs one tiny real completion, then still requires the PUT.
    const enabled = await s.call('PUT', `/api/admin/openai/models/${MODEL}`, { enabled: true });
    assert.strictEqual(enabled.status, 200);
    assert.ok(s.openai.seen.chats.length >= 1);
    const model = enabled.json.data.models.find(item => item.id === MODEL);
    assert.strictEqual(model.available, true);
    assert.ok(model.verifiedAt);
    assert.strictEqual(enabled.json.data.status.usage.requests >= 1, true);

    config = await s.call('GET', '/api/profile/config', null, {});
    const after = config.json.data.models.find(item => item.id === MODEL);
    assert.ok(after, 'enabled GPT model must be listed');
    assert.strictEqual(after.available, true);
    assert.strictEqual(after.free, false);
    assert.strictEqual(after.estimatedCosts, true);
    assert.strictEqual(after.minPlan, 'pro');
    assert.ok(after.pricing && after.pricing.source === 'published');
    assert.ok(!config.text.includes(SECRET));

    const providerStatus = await s.call('GET', '/api/admin/provider-status');
    assert.strictEqual(providerStatus.status, 200);
    assert.ok(providerStatus.json.data.openai);
    assert.ok(providerStatus.json.data.ollama);
    assert.ok(!providerStatus.text.includes(SECRET));

    const disabled = await s.call('PUT', '/api/admin/openai', { enabled: false });
    assert.strictEqual(disabled.status, 200);
    config = await s.call('GET', '/api/profile/config', null, {});
    assert.ok(!config.json.data.models.some(item => item.id === MODEL && item.available), 'a disabled provider advertises nothing');
    assert.match(s.logs(), /OpenAI configured: true/);
  } finally { s.stop(); }
});

test('a rejected OpenAI key is reported safely and never advertised', async () => {
  const s = await startPhoton({ port: 34612, openai: { validKey: 'sk-a-different-valid-key-000000000' } });
  try {
    const status = await s.call('GET', '/api/admin/openai');
    assert.strictEqual(status.json.data.status.validation, 'invalid_api_key');
    assert.strictEqual(status.json.data.status.validated, false);
    assert.ok(!status.text.includes(SECRET));
    const config = await s.call('GET', '/api/profile/config', null, {});
    assert.ok(!config.json.data.models.some(model => model.provider === 'OpenAI' && model.available));
    assert.ok(!config.text.includes(SECRET));
    const check = await s.call('POST', '/api/admin/openai/connection', {});
    assert.strictEqual(check.status, 200);
    assert.strictEqual(check.json.data.result.ok, false);
    assert.strictEqual(check.json.data.result.code, 'invalid_api_key');
    assert.ok(!check.text.includes(SECRET));
  } finally { s.stop(); }
});

test('OpenAI rate limits are retried with Retry-After before surfacing success', async () => {
  let calls = 0;
  const s = await startPhoton({
    port: 34613,
    openai: {
      onChat: async ({ res, body, send }) => {
        calls += 1;
        if (calls === 1) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
          res.end(JSON.stringify({ error: { message: 'Rate limit reached', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }));
          return;
        }
        return send(200, { model: body.model, choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
      },
    },
  });
  try {
    const result = await s.call('POST', '/api/admin/openai/test-model', { model: MODEL });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.json.data.result.ok, true);
    assert.strictEqual(calls, 2, '429 must be retried once');
  } finally { s.stop(); }
});

test('exhausted OpenAI credits are reported as billing_required and are not retried', async () => {
  let calls = 0;
  const s = await startPhoton({
    port: 34614,
    openai: {
      onChat: async ({ res }) => {
        calls += 1;
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } }));
      },
    },
  });
  try {
    const result = await s.call('POST', '/api/admin/openai/test-model', { model: MODEL });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.json.data.result.ok, false);
    assert.strictEqual(result.json.data.result.code, 'billing_required');
    assert.strictEqual(calls, 1, 'billing failures are never retried');
    assert.strictEqual(result.json.data.usage.failures, 1);
    assert.match(result.json.data.result.message, /ChatGPT subscriptions do not provide API credit/);
  } finally { s.stop(); }
});

test('a model that cannot complete a tiny test cannot be enabled', async () => {
  const s = await startPhoton({
    port: 34615,
    openai: {
      onChat: async ({ res, body }) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'The model `' + (body.model || '') + '` does not exist or you do not have access to it.', type: 'invalid_request_error', code: 'model_not_found' } }));
      },
    },
  });
  try {
    const result = await s.call('PUT', `/api/admin/openai/models/${MODEL}`, { enabled: true });
    assert.strictEqual(result.status, 400);
    assert.ok(['invalid_model', 'model_not_verified'].includes(result.json.error.code), result.json.error.code);
    const status = await s.call('GET', '/api/admin/openai');
    const model = status.json.data.models.find(item => item.id === MODEL);
    assert.strictEqual(model.enabled, false);
    assert.strictEqual(model.available, false);
  } finally { s.stop(); }
});

test('local Ollama is discovered, offered as free, and tested without an API key', async () => {
  const s = await startPhoton({ port: 34616 });
  try {
    const status = await s.call('GET', '/api/admin/ollama');
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.json.data.connected, true);
    assert.strictEqual(status.json.data.free, true);
    assert.strictEqual(status.json.data.defaultModel, 'gemma3:4b');

    const config = await s.call('GET', '/api/profile/config', null, {});
    const local = config.json.data.models.find(model => model.id === 'gemma3:4b');
    assert.ok(local, 'local model must be listed');
    assert.strictEqual(local.available, true);
    assert.strictEqual(local.free, true);
    assert.strictEqual(local.local, true);
    assert.strictEqual(local.provider, 'Ollama');

    const tested = await s.call('POST', '/api/admin/ollama/test', {});
    assert.strictEqual(tested.status, 200);
    assert.strictEqual(tested.json.data.result.ok, true);
    assert.ok(s.ollama.seen.auth.every(value => value === ''), 'Ollama must never send an API key header');
  } finally { s.stop(); }
});

test('concurrent OpenAI admin test-model requests each complete and are counted', async () => {
  const s = await startPhoton({
    port: 34617,
    openai: {
      onChat: async ({ res, body, send }) => {
        await new Promise(resolve => setTimeout(resolve, 40));
        return send(200, { model: body.model, choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
      },
    },
  });
  try {
    const [a, b] = await Promise.all([
      s.call('POST', '/api/admin/openai/test-model', { model: MODEL }),
      s.call('POST', '/api/admin/openai/test-model', { model: MODEL }),
    ]);
    assert.strictEqual(a.json.data.result.ok, true);
    assert.strictEqual(b.json.data.result.ok, true);
    const status = await s.call('GET', '/api/admin/openai');
    assert.ok(status.json.data.usage.requests >= 2);
    assert.strictEqual(status.json.data.usage.byModel[MODEL].requests >= 2, true);
    assert.ok(status.json.data.usage.totalTokens >= 12);
  } finally { s.stop(); }
});
