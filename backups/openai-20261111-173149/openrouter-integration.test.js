'use strict';
// Starts the real server.js (from a temp copy, so the project's API.env and data are never touched)
// against a LOCAL stand-in for the OpenRouter HTTP API, then exercises the admin API end to end.
// This verifies PHOTON's own wiring (routes, key files, masking, limits, diagnostics). It does not
// verify real OpenRouter behaviour, and chat endpoints are not covered here because they require a
// Firebase ID token (see scripts/test-openrouter-live.js).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const FILES = ['server.js', 'anthropic-provider.js', 'openrouter-provider.js', 'openrouter-keys.js', 'gemini-keys.js', 'gemini-provider.js', 'photon-limits.js', 'photon-usage.js', 'index.html', 'admin.html'];
const keyFor = n => `sk-or-v1-itest${String(n).padStart(2, '0')}${'abcdef0123456789'.repeat(2)}`;
const CATALOG = [
  { id: 'vendor/model-a:free', name: 'Model A (free)', pricing: { prompt: '0', completion: '0' }, context_length: 8192 },
  { id: 'vendor/paid', name: 'Paid', pricing: { prompt: '0.000001', completion: '0.000001' } },
];

function fakeOpenRouter(valid) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const token = String(req.headers.authorization || '').replace('Bearer ', '');
    seen.push({ method: req.method, url: req.url, token });
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/api/v1/key') return valid.has(token) ? send(200, { data: { label: 'itest', is_free_tier: true } }) : send(401, { error: { message: 'User not found.', code: 401 } });
    if (req.url === '/api/v1/models') return send(200, { data: CATALOG });
    if (req.url === '/api/v1/chat/completions') {
      if (!valid.has(token)) return send(401, { error: { message: 'bad key', code: 401 } });
      return send(200, { model: 'vendor/model-a:free', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0 } });
    }
    return send(404, { error: { message: 'not found' } });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

async function startPhoton({ slots = [], valid, port }) {
  const fake = await fakeOpenRouter(valid);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-or-'));
  for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'API.env'), slots.map(n => (n === 1 ? 'OPENROUTER_API_KEY' : `OPENROUTER_API_KEY_${n}`) + '=' + keyFor(n)).join('\n') + '\n');
  const env = { ...process.env, PORT: String(port), PHOTON_ADMIN_PASSWORD: 'itest-admin-pass', OPENROUTER_API_BASE: `http://127.0.0.1:${fake.port}/api/v1`, NODE_ENV: 'production' };
  for (const name of Object.keys(env)) if (/^(GEMINI|ANTHROPIC|OPENROUTER_API_KEY|PHOTON_ADMIN_NO_AUTH)/.test(name)) delete env[name];
  env.OPENROUTER_API_BASE = `http://127.0.0.1:${fake.port}/api/v1`;
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not finish startup diagnostics:\n' + logs)), 15000);
    const iv = setInterval(() => { if (/OpenRouter configured:/.test(logs)) { clearInterval(iv); clearTimeout(t); resolve(); } }, 50);
  });
  const auth = { Authorization: 'Basic ' + Buffer.from('admin:itest-admin-pass').toString('base64') };
  const call = async (method, p, body, headers = auth) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  return { call, dir, fake, logs: () => logs, stop: () => { child.kill(); fake.server.close(); } };
}
const noSecrets = (...blobs) => { for (const b of blobs) assert.ok(!/sk-or-v1-itest/.test(b), 'a key leaked: ' + String(b).slice(0, 200)); };

test('startup validates every configured slot with a live request and reports counts, never secrets', async () => {
  const valid = new Set([keyFor(1), keyFor(2), keyFor(4)]);
  const s = await startPhoton({ slots: [1, 2, 3, 4], valid, port: 34601 });
  try {
    assert.match(s.logs(), /OpenRouter configured: true \(ok; keys: 4 total, 4 enabled, 3 valid, 1 invalid, 0 temporarily unavailable; 1 free models available/);
    assert.strictEqual(s.fake.seen.filter(r => r.url === '/api/v1/key').length, 4);
    noSecrets(s.logs());
    const overview = await s.call('GET', '/api/admin/openrouter');
    assert.strictEqual(overview.status, 200);
    const data = overview.json.data;
    assert.strictEqual(data.maxKeys, 10);
    assert.deepStrictEqual(data.keys.map(k => [k.slot, k.health.state]), [[1, 'active'], [2, 'active'], [3, 'invalid'], [4, 'active']]);
    assert.ok(data.keys.every(k => /^sk-o/.test(k.masked) && !('secret' in k)));
    assert.deepStrictEqual([data.status.totalKeys, data.status.enabledKeys, data.status.validKeys, data.status.invalidKeys, data.status.freeModelCount], [4, 4, 3, 1, 1]);
    assert.strictEqual(data.status.freeModels[0].id, 'vendor/model-a:free');
    noSecrets(overview.text, (await s.call('GET', '/api/admin/provider-status')).text);
  } finally { s.stop(); }
});

test('config lists the free model and keeps the other providers; admin routes require authentication', async () => {
  const s = await startPhoton({ slots: [1], valid: new Set([keyFor(1)]), port: 34602 });
  try {
    const config = await s.call('GET', '/api/profile/config', null, {});
    const models = config.json.data.models;
    assert.ok(models.some(m => m.id === 'vendor/model-a:free' && m.provider === 'OpenRouter' && m.available));
    assert.ok(!models.some(m => m.id === 'vendor/paid'));
    assert.ok(models.some(m => m.id === 'gpt-5') && models.some(m => m.provider === 'Anthropic') && models.some(m => m.provider === 'Google'), 'existing providers are still listed');
    noSecrets(config.text);
    for (const [method, p] of [['GET', '/api/admin/openrouter'], ['POST', '/api/admin/openrouter/test-all'], ['POST', '/api/admin/openrouter/keys'], ['DELETE', '/api/admin/openrouter/keys/0123456789abcdef']]) assert.strictEqual((await s.call(method, p, method === 'POST' ? {} : null, {})).status, 401, p);
  } finally { s.stop(); }
});

test('admin can add keys up to 10, is stopped at the 11th, can disable, test, edit and delete; secrets stay server-side', async () => {
  const valid = new Set(Array.from({ length: 12 }, (_, i) => keyFor(i + 1)));
  const s = await startPhoton({ slots: [], valid, port: 34603 });
  try {
    assert.strictEqual((await s.call('GET', '/api/admin/openrouter')).json.data.status.configured, false);
    for (let n = 1; n <= 10; n++) {
      const added = await s.call('POST', '/api/admin/openrouter/keys', { label: 'Key ' + n, key: keyFor(n) });
      assert.strictEqual(added.status, 201, added.text);
      assert.strictEqual(added.json.data.key.slot, n);
      noSecrets(added.text);
    }
    const eleventh = await s.call('POST', '/api/admin/openrouter/keys', { label: 'extra', key: keyFor(11) });
    assert.strictEqual(eleventh.status, 409);
    assert.strictEqual(eleventh.json.error.code, 'key_limit');
    assert.strictEqual((await s.call('POST', '/api/admin/openrouter/keys', { key: keyFor(3) })).json.error.code, 'duplicate_key');
    assert.strictEqual((await s.call('POST', '/api/admin/openrouter/keys', { key: 'nope' })).json.error.code, 'invalid_key');
    const env = fs.readFileSync(path.join(s.dir, 'API.env'), 'utf8');
    for (let n = 1; n <= 10; n++) assert.ok(env.includes(keyFor(n)), 'slot ' + n + ' written to API.env');

    const tested = await s.call('POST', '/api/admin/openrouter/test-all', {});
    assert.strictEqual(tested.status, 200);
    assert.ok(tested.json.data.results.length === 10 && tested.json.data.results.every(r => r.status === 'ok'));
    assert.strictEqual(tested.json.data.status.validKeys, 10);
    noSecrets(tested.text);

    const keys = tested.json.data.keys;
    const target = keys.find(k => k.slot === 5);
    const disabled = await s.call('PUT', '/api/admin/openrouter/keys/' + target.id, { enabled: false });
    assert.strictEqual(disabled.json.data.key.enabled, false);
    assert.strictEqual(disabled.json.data.status.enabledKeys, 9);
    const one = await s.call('POST', `/api/admin/openrouter/keys/${target.id}/test`, {});
    assert.strictEqual(one.json.data.result.status, 'ok');

    valid.delete(keyFor(7));                                         // simulate a revoked key
    const revoked = await s.call('POST', '/api/admin/openrouter/keys/' + keys.find(k => k.slot === 7).id + '/test', {});
    assert.strictEqual(revoked.json.data.result.status, 'invalid_api_key');
    const k7 = revoked.json.data.keys.find(k => k.slot === 7);
    assert.strictEqual(k7.health.state, 'invalid');
    assert.ok(k7.stats.lastError.code === 'invalid_api_key' && k7.lastValidation.at && k7.lastOkAt);
    assert.strictEqual(revoked.json.data.status.invalidKeys, 1);
    noSecrets(revoked.text);

    const deleted = await s.call('DELETE', '/api/admin/openrouter/keys/' + target.id);
    assert.strictEqual(deleted.json.data.status.totalKeys, 9);
    assert.ok(!fs.readFileSync(path.join(s.dir, 'API.env'), 'utf8').includes(keyFor(5)));
    const state = fs.readFileSync(path.join(s.dir, '.photon-openrouter-keys.json'), 'utf8');
    noSecrets(state, s.logs());
    assert.strictEqual((await s.call('DELETE', '/api/admin/openrouter/keys/' + target.id)).status, 404);
  } finally { s.stop(); }
});

test('admin model test sends one completion request through the key policy and reports usage and the key slot', async () => {
  const s = await startPhoton({ slots: [1, 2], valid: new Set([keyFor(1), keyFor(2)]), port: 34604 });
  try {
    const ok = await s.call('POST', '/api/admin/openrouter/test-model', { model: 'vendor/model-a:free' });
    assert.strictEqual(ok.json.data.result.ok, true);
    assert.strictEqual(ok.json.data.result.usage.totalTokens, 4);
    assert.ok([1, 2].includes(ok.json.data.result.key.slot));
    assert.ok(ok.json.data.status.lastSuccessfulRequestAt);
    const missing = await s.call('POST', '/api/admin/openrouter/test-model', { model: 'vendor/paid' });
    assert.strictEqual(missing.json.data.result.ok, false);
    assert.strictEqual(missing.json.data.result.code, 'invalid_model');
    noSecrets(ok.text, missing.text, s.logs());
  } finally { s.stop(); }
});

test('with no OpenRouter keys the server starts, says so, and the other providers are unaffected', async () => {
  const s = await startPhoton({ slots: [], valid: new Set(), port: 34605 });
  try {
    assert.match(s.logs(), /OpenRouter configured: false/);
    const config = await s.call('GET', '/api/profile/config', null, {});
    const or = config.json.data.models.filter(m => m.provider === 'OpenRouter');
    assert.ok(or.length === 1 && or[0].available === false && /not configured/i.test(or[0].reason));
    assert.ok(config.json.data.models.some(m => m.id === 'gpt-5'));
  } finally { s.stop(); }
});
