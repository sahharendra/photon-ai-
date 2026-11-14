'use strict';
// Unit tests for the multi-key Gemini support. No network access: fetch, sleep and the key
// store's temp files are injected/stubbed so only PHOTON's own logic is exercised.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createGeminiKeyStore, discoverKeys, maskKey, fingerprint, upsertEnvValue, removeEnvValue,
} = require('../gemini-keys');
const {
  createGeminiProvider, normalizeModels, parseRetryAfter, backoffDelay, MODEL_ID, MAX_RETRIES,
} = require('../gemini-provider');

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const quiet = { error() {}, log() {} };

const KEY_A = 'AIzaSyUnitTestKeyAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'AIzaSyUnitTestKeyBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const KEY_C = 'AIzaSyUnitTestKeyCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'photon-gemini-')); }

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
    body: null,
  };
}

function streamResponse(chunks, status = 200) {
  let i = 0;
  const encoder = new TextEncoder();
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          read: async () => (i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]) } : { done: true, value: undefined }),
          releaseLock() {},
        };
      },
    },
  };
}

function makeStore(env = {}) {
  const dir = tmpDir();
  return createGeminiKeyStore({ dir, env, logger: quiet });
}

function makeProvider(store, fetchImpl, options = {}) {
  const sleeps = [];
  const provider = createGeminiProvider({
    HttpError,
    keys: store,
    fetchImpl,
    logger: quiet,
    sleep: async ms => { sleeps.push(ms); },
    random: () => 0.5,
    ...options,
  });
  return { provider, sleeps };
}

const modelList = {
  models: [
    { name: 'models/gemini-3-pro-preview', displayName: 'Gemini 3 Pro Preview', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1000000 },
    { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576 },
    { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-2.5-flash-image', displayName: 'Flash Image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/imagen-4.0', displayName: 'Imagen', supportedGenerationMethods: ['generateContent'] },
  ],
};

// ---------------------------------------------------------------------------
// Key discovery / masking
// ---------------------------------------------------------------------------

test('discoverKeys reads any number of configured keys in suffix order', () => {
  const found = discoverKeys({ GEMINI_API_KEY_3: KEY_C, GEMINI_API_KEY: KEY_A, GEMINI_API_KEY_2: KEY_B, UNRELATED: 'x' });
  assert.deepStrictEqual(found.map(item => item.value), [KEY_A, KEY_B, KEY_C]);
  assert.deepStrictEqual(found.map(item => item.suffix), [1, 2, 3]);
});

test('discoverKeys ignores empty and unrelated variables', () => {
  assert.deepStrictEqual(discoverKeys({ GEMINI_API_KEY: '   ', GEMINI_API_KEY_2: '', OTHER_KEY: KEY_A }), []);
});

test('maskKey never returns the full key', () => {
  const masked = maskKey(KEY_A);
  assert.ok(!masked.includes(KEY_A));
  assert.strictEqual(masked.startsWith(KEY_A.slice(0, 4)), true);
  assert.strictEqual(masked.endsWith(KEY_A.slice(-4)), true);
  assert.strictEqual(maskKey('short'), '••••••••');
});

test('fingerprint is stable and hides the secret', () => {
  assert.strictEqual(fingerprint(KEY_A), fingerprint(KEY_A));
  assert.notStrictEqual(fingerprint(KEY_A), fingerprint(KEY_B));
  assert.ok(!fingerprint(KEY_A).includes(KEY_A));
});

// ---------------------------------------------------------------------------
// Key store: add / edit / enable / delete
// ---------------------------------------------------------------------------

test('key store adds a key to the secret file and lists only a masked fingerprint', () => {
  const env = {};
  const store = makeStore(env);
  const created = store.add({ label: 'Work key', key: KEY_A });

  assert.strictEqual(created.label, 'Work key');
  assert.strictEqual(created.masked, maskKey(KEY_A));
  assert.ok(!JSON.stringify(created).includes(KEY_A));
  assert.strictEqual(env.GEMINI_API_KEY, KEY_A);

  const text = fs.readFileSync(store.secretFile, 'utf8');
  assert.ok(text.includes('GEMINI_API_KEY=' + KEY_A));

  const state = fs.readFileSync(store.statePath, 'utf8');
  assert.ok(!state.includes(KEY_A), 'state file must not contain the key');

  assert.strictEqual(store.list().length, 1);
  assert.strictEqual(store.secretFor(created.id), KEY_A);
});

test('key store assigns GEMINI_API_KEY_2, _3 for additional keys', () => {
  const env = {};
  const store = makeStore(env);
  store.add({ label: 'One', key: KEY_A });
  store.add({ label: 'Two', key: KEY_B });
  store.add({ label: 'Three', key: KEY_C });
  assert.strictEqual(env.GEMINI_API_KEY, KEY_A);
  assert.strictEqual(env.GEMINI_API_KEY_2, KEY_B);
  assert.strictEqual(env.GEMINI_API_KEY_3, KEY_C);
});

test('key store rejects empty, malformed and duplicate keys', () => {
  const store = makeStore({});
  assert.throws(() => store.add({ key: '' }), /required/i);
  assert.throws(() => store.add({ key: 'too-short' }), /Gemini API key/i);
  store.add({ key: KEY_A });
  assert.throws(() => store.add({ key: KEY_A }), /already configured/i);
});

test('key store edits labels, toggles enabled state, rotates and deletes', () => {
  const env = {};
  const store = makeStore(env);
  const created = store.add({ label: 'Primary', key: KEY_A });

  const edited = store.update(created.id, { label: 'Renamed' });
  assert.strictEqual(edited.label, 'Renamed');

  store.update(created.id, { enabled: false });
  assert.strictEqual(store.list()[0].enabled, false);
  assert.deepStrictEqual(store.select().map(k => k.id), []);

  const rotated = store.update(created.id, { key: KEY_B });
  assert.notStrictEqual(rotated.id, created.id);
  assert.strictEqual(rotated.label, 'Renamed');
  assert.strictEqual(env.GEMINI_API_KEY, KEY_B);
  assert.ok(!fs.readFileSync(store.secretFile, 'utf8').includes(KEY_A));

  store.remove(rotated.id);
  assert.strictEqual(store.list().length, 0);
  assert.strictEqual(env.GEMINI_API_KEY, undefined);
});

test('env file helpers preserve unrelated lines and update in place', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'API.env');
  fs.writeFileSync(file, '# comment\r\nOTHER=1\r\nGEMINI_API_KEY=old\r\n');
  upsertEnvValue(file, 'GEMINI_API_KEY', 'new');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('# comment'));
  assert.ok(text.includes('OTHER=1'));
  assert.ok(text.includes('GEMINI_API_KEY=new'));
  assert.ok(!text.includes('GEMINI_API_KEY=old'));
  removeEnvValue(file, 'GEMINI_API_KEY');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('GEMINI_API_KEY'));
});

test('selection skips disabled keys and is least-recently-used first', () => {
  const env = { GEMINI_API_KEY: KEY_A, GEMINI_API_KEY_2: KEY_B };
  const store = makeStore(env);
  const [first, second] = store.all();
  store.markUsed(first.id);
  const ordered = store.select();
  assert.strictEqual(ordered[0].id, second.id, 'never-used key should be selected first');
  assert.deepStrictEqual(store.select({ exclude: [second.id] }).map(k => k.id), [first.id]);
});

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

test('normalizeModels keeps chat models, drops embeddings/images, and sorts newest first', () => {
  const list = normalizeModels(modelList.models, {});
  const ids = list.map(model => model.id);
  assert.ok(ids.includes('gemini-3-pro-preview'));
  assert.ok(ids.includes('gemini-2.5-flash'));
  assert.ok(ids.includes('gemini-2.5-pro'));
  assert.ok(!ids.includes('text-embedding-004'));
  assert.ok(!ids.includes('gemini-2.5-flash-image'));
  assert.ok(!ids.includes('imagen-4.0'));
  assert.strictEqual(ids[0], 'gemini-3-pro-preview');
});

test('normalizeModels applies central allow/deny configuration', () => {
  const allow = normalizeModels(modelList.models, { GEMINI_MODEL_ALLOW: 'gemini-2.5-*' });
  assert.deepStrictEqual(allow.map(m => m.id).sort(), ['gemini-2.5-flash', 'gemini-2.5-pro']);
  const denied = normalizeModels(modelList.models, { GEMINI_MODEL_DENY: 'gemini-3-*' });
  assert.ok(!denied.some(m => m.id.startsWith('gemini-3-')));
});

// ---------------------------------------------------------------------------
// Backoff helpers
// ---------------------------------------------------------------------------

test('parseRetryAfter accepts seconds, HTTP dates and enforces a cap', () => {
  assert.strictEqual(parseRetryAfter('2'), 2000);
  const future = new Date(Date.now() + 3000).toUTCString();
  const parsed = parseRetryAfter(future);
  assert.ok(parsed > 0 && parsed <= 15000);
  assert.strictEqual(parseRetryAfter('99999'), 15000);
  assert.strictEqual(parseRetryAfter(null), null);
});

test('backoffDelay honours Retry-After and otherwise grows exponentially with jitter', () => {
  assert.strictEqual(backoffDelay(0, 2500, () => 0.5), 2500);
  const first = backoffDelay(0, null, () => 0.5);
  const second = backoffDelay(1, null, () => 0.5);
  const third = backoffDelay(2, null, () => 0.5);
  assert.ok(first < second && second <= third);
  assert.ok(third <= 8000);
});

// ---------------------------------------------------------------------------
// Provider behaviour
// ---------------------------------------------------------------------------

test('generate returns text and normalized usage using a configured key', async () => {
  const store = makeStore({ GEMINI_API_KEY: KEY_A });
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return jsonResponse({ candidates: [{ content: { parts: [{ text: ' Hello ' }, { text: 'world' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 19 }, modelVersion: 'gemini-2.5-flash' });
  };
  const { provider } = makeProvider(store, fetchImpl);
  const result = await provider.generate({ model: 'gemini-2.5-flash', contents: [{ role: 'user', parts: [{ text: 'hi' }] }], systemInstruction: 'be brief' });
  assert.strictEqual(result.text, 'Hello world');
  assert.deepStrictEqual(result.usage, { inputTokens: 12, outputTokens: 7, totalTokens: 19 });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].opts.headers['x-goog-api-key'], KEY_A);
  assert.ok(calls[0].url.includes(':generateContent'));
  assert.ok(calls[0].opts.body.includes('be brief'));
});

test('generate rejects an invalid model id before calling the API', async () => {
  const store = makeStore({ GEMINI_API_KEY: KEY_A });
  const { provider } = makeProvider(store, async () => { throw new Error('should not be called'); });
  await assert.rejects(provider.generate({ model: 'bad model!', contents: [] }), error => error.code === 'invalid_model');
  assert.strictEqual(MODEL_ID.test('gemini-2.5-flash'), true);
});

test('an authentication failure rotates to another configured key exactly once', async () => {
  const store = makeStore({ GEMINI_API_KEY: KEY_A, GEMINI_API_KEY_2: KEY_B });
  const used = [];
  const fetchImpl = async (url, opts) => {
    const key = opts.headers['x-goog-api-key'];
    used.push(key);
    if (key === KEY_A) return jsonResponse({ error: { message: 'API key not valid' } }, 400);
    return jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: {} });
  };
  const { provider } = makeProvider(store, fetchImpl);
  const result = await provider.generate({ model: 'gemini-2.5-flash', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
  assert.strictEqual(result.text, 'ok');
  assert.deepStrictEqual(used, [KEY_A, KEY_B]);
  const bad = store.list().find(item => item.masked === maskKey(KEY_A));
  assert.strictEqual(bad.lastValidation.status, 'invalid_api_key');
});

test('quota errors retry the same key with backoff and never rotate keys', async () => {
  const store = makeStore({ GEMINI_API_KEY: KEY_A, GEMINI_API_KEY_2: KEY_B });
  const used = [];
  const fetchImpl = async (url, opts) => {
    used.push(opts.headers['x-goog-api-key']);
    return jsonResponse({ error: { message: 'Quota exceeded' } }, 429, { 'retry-after': '1' });
  };
  const { provider, sleeps } = makeProvider(store, fetchImpl);
  await assert.rejects(provider.generate({ model: 'gemini-2.5-flash', contents: [] }), error => error.code === 'quota_or_rate_limit' && error.status === 429);
  assert.deepStrictEqual(new Set(used), new Set([KEY_A]), 'must not switch keys to bypass quota');
  assert.strictEqual(used.length, MAX_RETRIES + 1);
  assert.ok(sleeps.length >= 1);
  assert.ok(sleeps.every(ms => ms === 1000), 'Retry-After must be respected');
});

test('server errors are retried a bounded number of times on the same key', async () => {
  const store = makeStore({ GEMINI_API_KEY: KEY_A });
  const used = [];
  const fetchImpl = async (url, opts) => {
    used.push(opts.headers['x-goog-api-key']);
    return jsonResponse({ error: { message: 'backend error' } }, 500);
  };
  const { provider, sleeps } = makeProvider(store, fetchImpl);
  await assert.rejects(provider.generate({ model: 'gemini-2.5-flash', contents: [] }), error => error.code === 'provider_unavailable');
  assert.strictEqual(used.length, MAX_RETRIES + 1);
  assert.strictEqual(used.length < 10, true, 'retries must not be unlimited');
  assert.strictEqual(sleeps.length, MAX_RETRIES);
});

test('errors never include the API key', async () => {
  const store = makeStore({ GEMINI_API_KEY: KEY_A, GEMINI_API_KEY_2: KEY_B });
  const fetchImpl = async () => jsonResponse({ error: { message: 'API key not valid: ' + KEY_A } }, 400);
  const { provider } = makeProvider(store, fetchImpl);
  try {
    await provider.generate({ model: 'gemini-2.5-flash', contents: [] });
    assert.fail('expected a failure');
  } catch (error) {
    assert.ok(!String(error.message).includes(KEY_A));
    assert.ok(!String(error.message).includes(KEY_B));
    assert.strictEqual(error.code, 'invalid_api_key');
  }
});

test('no configured keys produces a clear not-configured error', async () => {
  const store = makeStore({});
  const { provider } = makeProvider(store, async () => { throw new Error('must not be called'); });
  await assert.rejects(provider.generate({ model: 'gemini-2.5-flash', contents: [] }), error => error.code === 'provider_not_configured' && error.status === 503);
  assert.strictEqual(provider.configured(), false);
});

test('refreshModels discovers the live catalog and exposes available entries', async () => {
  const store = makeStore({ GEMINI_API_KEY: KEY_A });
  const fetchImpl = async url => {
    assert.ok(String(url).includes('/models?pageSize=1000'));
    return jsonResponse(modelList);
  };
  const { provider } = makeProvider(store, fetchImpl);
  await provider.refreshModels(true);
  const status = provider.status();
  assert.strictEqual(status.validation, 'ok');
  assert.strictEqual(status.keyCount, 1);
  const entries = provider.catalogEntries();
  assert.ok(entries.every(entry => entry.provider === 'Google' && entry.available));
  assert.ok(entries.some(entry => entry.id === 'gemini-2.5-flash'));
  assert.strictEqual(provider.defaultModelId(), 'gemini-3-pro-preview');
});

test('catalog exposes a placeholder when no key is configured', () => {
  const store = makeStore({});
  const { provider } = makeProvider(store, async () => { throw new Error('must not be called'); });
  const entries = provider.catalogEntries();
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].configured, false);
  assert.strictEqual(entries[0].available, false);
  assert.ok(entries[0].reason.includes('not configured'));
});

test('testKey records validation without exposing the key', async () => {
  const store = makeStore({ GEMINI_API_KEY: KEY_A });
  const { provider } = makeProvider(store, async () => jsonResponse(modelList));
  const id = store.list()[0].id;
  const result = await provider.testKey(id);
  assert.strictEqual(result.status, 'ok');
  assert.ok(result.modelCount >= 3);
  assert.ok(!JSON.stringify(result).includes(KEY_A));
  assert.strictEqual(store.list()[0].lastValidation.status, 'ok');
});

test('testKey maps a rejected key to a safe status', async () => {
  const store = makeStore({ GEMINI_API_KEY: KEY_A });
  const { provider } = makeProvider(store, async () => jsonResponse({ error: { message: 'API key not valid' } }, 400));
  const id = store.list()[0].id;
  const result = await provider.testKey(id);
  assert.strictEqual(result.status, 'invalid_api_key');
  assert.ok(!JSON.stringify(result).includes(KEY_A));
});

test('streamGenerate yields deltas and a final usage payload', async () => {
  const store = makeStore({ GEMINI_API_KEY: KEY_A });
  const chunks = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}\n',
  ];
  const { provider } = makeProvider(store, async () => streamResponse(chunks));
  const events = [];
  for await (const event of provider.streamGenerate({ model: 'gemini-2.5-flash', contents: [] })) events.push(event);
  assert.deepStrictEqual(events.filter(e => e.type === 'delta').map(e => e.text), ['Hel', 'lo']);
  const done = events.find(e => e.type === 'done');
  assert.strictEqual(done.text, 'Hello');
  assert.deepStrictEqual(done.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
});
