'use strict';
// Starts the real server.js as a child process and checks the public config/admin surfaces.
// Chat endpoints require a Firebase ID token, so authenticated chat is covered by
// scripts/test-claude-live.js and scripts/test-openrouter-live.js.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
function start(env, port) {
  // Run from a temp copy so API.env / the live data file in the project are never read or modified.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-'));
  const filesToCopy = fs.readdirSync(ROOT).filter(f => (f.endsWith('.js') || f.endsWith('.html') || f.endsWith('.json')) && !f.includes('package') && !f.includes('test'));
  for (const f of filesToCopy) {
    try { fs.copyFileSync(path.join(ROOT, f), path.join(dir, f)); } catch (_) {}
  }
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  const clean = { ...process.env };
  for (const name of Object.keys(clean)) if (/^(ANTHROPIC_API_KEY|OPENROUTER_API_KEY(?:_\d+)?|OPENROUTER_API_BASE|GEMINI_API_BASE|GEMINI_MODEL_ALLOW|GEMINI_MODEL_DENY|GEMINI_API_KEY(?:_\d+)?|OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_MODEL_ALLOW|OPENAI_MODEL_DENY|OLLAMA_BASE_URL|OLLAMA_ENABLED)$/.test(name)) delete clean[name];
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...clean, PORT: String(port), PHOTON_ADMIN_PASSWORD: 'test-admin-pass', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
    const iv = setInterval(() => { if (out.includes('PHOTON AI running')) { clearInterval(iv); clearTimeout(t); resolve({ child, port, dir, logs: () => out }); } }, 50);
  });
}
const get = (port, p, headers) => fetch(`http://127.0.0.1:${port}${p}`, { headers }).then(async r => ({ status: r.status, text: await r.text() }));
const adminHeaders = { Authorization: 'Basic ' + Buffer.from('admin:test-admin-pass').toString('base64') };
function waitFor(logs, text, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (logs().includes(text)) { clearInterval(iv); resolve(); }
      else if (Date.now() - started > timeout) { clearInterval(iv); reject(new Error('timed out waiting for log: ' + text + '\n' + logs())); }
    }, 50);
  });
}
function stubOpenRouter(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/api/v1` }));
  });
}
function stubGemini(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/v1beta` }));
  });
}

test('without provider keys: Gemini, Claude, GPT and Llama are listed as not configured', async () => {
  const s = await start({}, 34561);
  try {
    const r = await get(s.port, '/api/profile/config');
    assert.strictEqual(r.status, 200);
    const models = JSON.parse(r.text).data.models;
    const ids = models.map(m => m.id);
    for (const id of ['openai', 'llama-4']) assert.ok(ids.includes(id), id);
    const google = models.filter(m => m.provider === 'Google');
    assert.ok(google.length >= 1);
    assert.ok(google.every(m => m.available === false && /not configured/.test(m.reason)));
    assert.ok(!ids.includes('gemini-2.5-flash'), 'no hardcoded Gemini model id');
    const claude = models.filter(m => m.provider === 'Anthropic');
    assert.ok(claude.length >= 1 && claude.every(m => m.available === false && /not configured/.test(m.reason)));
    assert.ok(!ids.includes('claude-sonnet-4'), 'no hardcoded Claude model id');
    assert.match(s.logs(), /Anthropic configured: false/);
    assert.match(s.logs(), /Gemini configured: false/);
  } finally { s.child.kill(); }
});

test('conversation search and retrieval require authentication', async () => {
  const s = await start({}, 34571);
  try {
    const search = await get(s.port, '/api/conversations/search?q=hello');
    const conversation = await get(s.port, '/api/conversations/c123');
    const workspace = await get(s.port, '/api/sync/workspace');
    const attachment = await get(s.port, '/api/attachments/att-private');
    assert.strictEqual(search.status, 401);
    assert.strictEqual(conversation.status, 401);
    assert.strictEqual(workspace.status, 401);
    assert.strictEqual(attachment.status, 401);
  } finally { s.child.kill(); }
});

test('without OPENROUTER_API_KEY: free models listed as not configured', async () => {
  const s = await start({}, 34565);
  try {
    const r = await get(s.port, '/api/profile/config');
    assert.strictEqual(r.status, 200);
    const models = JSON.parse(r.text).data.models;
    const openrouter = models.filter(m => m.provider === 'OpenRouter');
    assert.ok(openrouter.length >= 1);
    assert.ok(openrouter.every(m => m.configured === false && m.available === false && /not configured/.test(m.reason)));
    assert.ok(!models.some(m => m.provider === 'OpenRouter' && m.available), 'no free model may be offered without a key');
    await waitFor(s.logs, 'OpenRouter configured: false');
    assert.match(s.logs(), /OpenRouter configured: false/);
  } finally { s.child.kill(); }
});

test('with a bogus key: Claude not selectable, key never appears in responses or logs', async () => {
  const bogus = 'sk-ant-integration-bogus-0000000000000000';
  const s = await start({ ANTHROPIC_API_KEY: bogus }, 34562);
  try {
    await new Promise(r => setTimeout(r, 1500));
    const cfg = await get(s.port, '/api/profile/config');
    const claude = JSON.parse(cfg.text).data.models.filter(m => m.provider === 'Anthropic');
    assert.ok(claude.every(m => m.available === false));
    const admin = await get(s.port, '/api/admin/provider-status', adminHeaders);
    assert.strictEqual(admin.status, 200);
    const status = JSON.parse(admin.text).data.anthropic;
    assert.strictEqual(status.configured, true);
    assert.notStrictEqual(status.validation, 'ok');
    for (const blob of [cfg.text, admin.text, s.logs()]) assert.ok(!blob.includes(bogus));
  } finally { s.child.kill(); }
});

test('with a rejected OpenRouter key: validation fails, no models offered, key never leaks', async () => {
  const bogus = 'sk-or-v1-integration-bogus-0000000000000000';
  const stub = await stubOpenRouter((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'No auth credentials found', type: 'authentication_error' } }));
  });
  const s = await start({ OPENROUTER_API_KEY: bogus, OPENROUTER_API_BASE: stub.base }, 34566);
  try {
    await waitFor(s.logs, 'OpenRouter configured: false');
    const cfg = await get(s.port, '/api/profile/config');
    const openrouter = JSON.parse(cfg.text).data.models.filter(m => m.provider === 'OpenRouter');
    assert.ok(openrouter.length >= 1);
    assert.ok(openrouter.every(m => m.available === false && /rejected the server API key/i.test(m.reason)));
    const admin = await get(s.port, '/api/admin/provider-status', adminHeaders);
    assert.strictEqual(admin.status, 200);
    const status = JSON.parse(admin.text).data.openrouter;
    assert.strictEqual(status.configured, true);
    assert.strictEqual(status.validated, false);
    assert.strictEqual(status.validation, 'invalid_api_key');
    assert.ok(!status.models.length);
    for (const blob of [cfg.text, admin.text, s.logs()]) assert.ok(!blob.includes(bogus));
  } finally { s.child.kill(); stub.server.close(); }
});

test('with a validated OpenRouter key: live free models become selectable', async () => {
  const stub = await stubOpenRouter((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/key')) return res.end(JSON.stringify({ data: { label: 'integration key', usage: 0 } }));
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [
      { id: 'openrouter/free', name: 'Free Models Router', pricing: { prompt: '0', completion: '0' } },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'NVIDIA: Nemotron 3 Ultra (free)', pricing: { prompt: '0', completion: '0' } },
      { id: 'acme/paid-model', name: 'Acme Paid', pricing: { prompt: '0.000001', completion: '0.000002' } },
    ] }));
    res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  const s = await start({ OPENROUTER_API_KEY: 'sk-or-v1-integration-valid-0000000000000000', OPENROUTER_API_BASE: stub.base }, 34568);
  try {
    await waitFor(s.logs, 'OpenRouter configured: true');
    const cfg = await get(s.port, '/api/profile/config');
    const openrouter = JSON.parse(cfg.text).data.models.filter(m => m.provider === 'OpenRouter');
    const ids = openrouter.map(m => m.id);
    assert.ok(ids.includes('openrouter/free'), 'openrouter/free must be registered');
    assert.ok(ids.includes('nvidia/nemotron-3-ultra-550b-a55b:free'), 'curated free model must be registered');
    assert.ok(!ids.includes('acme/paid-model'), 'paid models must not be offered as free');
    assert.ok(openrouter.every(m => m.available && m.free), 'free models must be selectable');
    assert.match(s.logs(), /OpenRouter configured: true \(ok; keys: 1 total, 1 enabled, 1 valid, 0 invalid, 0 temporarily unavailable; 2 free models available\)/);
  } finally { s.child.kill(); stub.server.close(); }
});

test('a second backend instance refuses to start on the same install', async () => {
  const s = await start({}, 34567);
  try {
    const clean = { ...process.env };
    for (const name of Object.keys(clean)) if (/^(ANTHROPIC_API_KEY|OPENROUTER_API_KEY(?:_\d+)?|OPENROUTER_API_BASE|GEMINI_API_BASE|GEMINI_MODEL_ALLOW|GEMINI_MODEL_DENY|GEMINI_API_KEY(?:_\d+)?|OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_MODEL_ALLOW|OPENAI_MODEL_DENY|OLLAMA_BASE_URL|OLLAMA_ENABLED)$/.test(name)) delete clean[name];
    const second = spawn(process.execPath, ['server.js'], { cwd: s.dir, env: { ...clean, PORT: '34569', PHOTON_ADMIN_PASSWORD: 'test-admin-pass' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; second.stdout.on('data', d => out += d); second.stderr.on('data', d => out += d);
    const code = await new Promise(resolve => second.on('exit', resolve));
    assert.notStrictEqual(code, 0);
    assert.match(out, /already running|single-instance lock/i);
    const r = await get(s.port, '/api/profile/config');
    assert.strictEqual(r.status, 200, 'the first instance must keep serving');
  } finally { s.child.kill(); }
});

test('admin provider-status requires admin auth', async () => {
  const s = await start({}, 34563);
  try { assert.strictEqual((await get(s.port, '/api/admin/provider-status')).status, 401); } finally { s.child.kill(); }
});

test('chat routes still require authentication', async () => {
  const s = await start({}, 34564);
  try {
    for (const route of ['/api/chat', '/api/chat/stream']) {
      const r = await fetch(`http://127.0.0.1:${s.port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.strictEqual(r.status, 401, route);
    }
  } finally { s.child.kill(); }
});

test('with a validated Gemini key: live models become selectable and the key never leaks', async () => {
  const key = 'AIzaSyIntegrationValidKey0000000000000000000';
  const stub = await stubGemini((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/v1beta/models')) return res.end(JSON.stringify({ models: [
      { name: 'models/gemini-3-pro-preview', displayName: 'Gemini 3 Pro Preview', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
    ] }));
    res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  const s = await start({ GEMINI_API_KEY: key, GEMINI_API_BASE: stub.base }, 34570);
  try {
    await waitFor(s.logs, 'Gemini configured: true');
    const cfg = await get(s.port, '/api/profile/config');
    const google = JSON.parse(cfg.text).data.models.filter(m => m.provider === 'Google');
    const ids = google.map(m => m.id);
    assert.ok(ids.includes('gemini-2.5-flash'));
    assert.ok(ids.includes('gemini-3-pro-preview'));
    assert.ok(!ids.includes('text-embedding-004'), 'non-chat models must be excluded');
    assert.ok(google.every(m => m.available === true));
    const admin = await get(s.port, '/api/admin/provider-status', adminHeaders);
    const status = JSON.parse(admin.text).data.gemini;
    assert.strictEqual(status.configured, true);
    assert.strictEqual(status.validation, 'ok');
    assert.strictEqual(status.enabledKeyCount, 1);
    assert.ok(status.keys[0].masked && !status.keys[0].masked.includes(key));
    for (const blob of [cfg.text, admin.text, s.logs()]) assert.ok(!blob.includes(key));
    assert.match(s.logs(), /Gemini configured: true \(1 enabled key; 2 models available\)/);
  } finally { s.child.kill(); stub.server.close(); }
});

test('with a rejected Gemini key: no models are offered and the key never leaks', async () => {
  const key = 'AIzaSyIntegrationRejectedKey000000000000000';
  const stub = await stubGemini((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }));
  });
  const s = await start({ GEMINI_API_KEY: key, GEMINI_API_BASE: stub.base }, 34571);
  try {
    await waitFor(s.logs, 'Gemini configured: false');
    const cfg = await get(s.port, '/api/profile/config');
    const google = JSON.parse(cfg.text).data.models.filter(m => m.provider === 'Google');
    assert.ok(google.length >= 1);
    assert.ok(google.every(m => m.available === false && /rejected the server API key/i.test(m.reason)));
    const admin = await get(s.port, '/api/admin/provider-status', adminHeaders);
    const status = JSON.parse(admin.text).data.gemini;
    assert.strictEqual(status.configured, true);
    assert.strictEqual(status.validation, 'invalid_api_key');
    assert.strictEqual(status.keyCount, 1);
    for (const blob of [cfg.text, admin.text, s.logs()]) assert.ok(!blob.includes(key));
  } finally { s.child.kill(); stub.server.close(); }
});

test('admin Gemini key management requires auth and never returns a saved key', async () => {
  const key = 'AIzaSyAdminManagedKey00000000000000000000';
  const s = await start({}, 34572);
  const post = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${s.port}${p}`, { method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
  const put = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${s.port}${p}`, { method: 'PUT', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
  const del = async p => {
    const r = await fetch(`http://127.0.0.1:${s.port}${p}`, { method: 'DELETE', headers: adminHeaders });
    return { status: r.status, text: await r.text() };
  };
  try {
    assert.strictEqual((await get(s.port, '/api/admin/gemini')).status, 401, 'auth required');
    const empty = await get(s.port, '/api/admin/gemini', adminHeaders);
    assert.strictEqual(empty.status, 200);
    assert.deepStrictEqual(JSON.parse(empty.text).data.keys, []);

    const added = await post('/api/admin/gemini/keys', { label: 'Integration key', key });
    assert.strictEqual(added.status, 201);
    const addedKey = JSON.parse(added.text).data.key;
    assert.strictEqual(addedKey.label, 'Integration key');
    assert.ok(addedKey.masked && !added.text.includes(key), 'the full key must never be returned');
    assert.ok(fs.readFileSync(path.join(s.dir, 'API.env'), 'utf8').includes(key), 'key is stored in the server secret file');

    const listed = JSON.parse((await get(s.port, '/api/admin/gemini', adminHeaders)).text).data;
    assert.strictEqual(listed.keys.length, 1);
    assert.ok(!JSON.stringify(listed).includes(key));

    const disabled = await put('/api/admin/gemini/keys/' + addedKey.id, { enabled: false });
    assert.strictEqual(disabled.status, 200);
    assert.strictEqual(JSON.parse(disabled.text).data.key.enabled, false);
    assert.ok(!disabled.text.includes(key));

    const removed = await del('/api/admin/gemini/keys/' + addedKey.id);
    assert.strictEqual(removed.status, 200);
    const after = JSON.parse((await get(s.port, '/api/admin/gemini', adminHeaders)).text).data;
    assert.deepStrictEqual(after.keys, []);
    assert.ok(!fs.readFileSync(path.join(s.dir, 'API.env'), 'utf8').includes(key), 'deleted key is removed from the secret file');
  } finally { s.child.kill(); }
});
