'use strict';
// Unit tests for openrouter-keys.js and the multi-key behaviour of openrouter-provider.js.
// IMPORTANT: these tests inject a fake `fetch` so they can exercise PHOTON's own key selection,
// retry and bookkeeping logic offline. They prove nothing about the real OpenRouter service; run
// `npm run test:live:openrouter` with real keys for that.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOpenRouterKeyStore, createKeyManager, discoverSlots, MAX_KEYS, FAILURE_THRESHOLD, COOLDOWN_BASE_MS } = require('../openrouter-keys');
const { createOpenRouterProvider, isFreeModel, freeModelsFrom } = require('../openrouter-provider');

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const quiet = { error() {}, log() {} };
const keyFor = n => `sk-or-v1-testkey${String(n).padStart(2, '0')}${'0123456789abcdef'.repeat(2)}`;
const envWith = (slots, extra = {}) => { const env = { ...extra }; for (const n of slots) env[n === 1 ? 'OPENROUTER_API_KEY' : `OPENROUTER_API_KEY_${n}`] = keyFor(n); return env; };
const slotOfKey = key => Number(/testkey(\d\d)/.exec(key || '')?.[1]) || null;
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const CATALOG = [
  { id: 'vendor/model-a:free', name: 'Model A (free)', pricing: { prompt: '0', completion: '0' }, context_length: 8192 },
  { id: 'vendor/paid-model', name: 'Paid', pricing: { prompt: '0.000001', completion: '0.000002' } },
  { id: 'openrouter/free', name: 'Free Models Router', pricing: { prompt: '0', completion: '0' } },
  { id: 'vendor/mislabelled:free', name: 'Not actually free', pricing: { prompt: '0.1', completion: '0.1' } },
  { id: 'vendor/no-pricing-meta:free', name: 'No pricing metadata' },
  { id: 'vendor/zero-price', name: 'Zero priced', pricing: { prompt: '0', completion: '0' } },
  { id: 'openrouter/auto', name: 'Auto', pricing: { prompt: '-1', completion: '-1' } },
];
const okChat = (extra = {}) => json(200, { model: 'vendor/model-a:free', choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 0 }, ...extra });

// behaviour({ url, key, kind: 'key'|'models'|'chat', init }) -> Response | throws
function harness({ slots = [1, 2, 3], behavior, extraEnv, clock } = {}) {
  const env = envWith(slots, extraEnv);
  const store = createOpenRouterKeyStore({ env, persist: false, logger: quiet });
  const calls = [];
  const delays = [];
  const fetchImpl = async (url, init = {}) => {
    const key = String(init.headers?.Authorization || '').replace('Bearer ', '');
    const kind = url.endsWith('/key') ? 'key' : url.endsWith('/models') ? 'models' : 'chat';
    const call = { url, key, slot: slotOfKey(key), kind, init };
    calls.push(call);
    const custom = behavior && await behavior(call);
    if (custom) return custom;
    if (kind === 'key') return json(200, { data: { label: 'test', is_free_tier: true } });
    if (kind === 'models') return json(200, { data: CATALOG });
    return okChat();
  };
  const provider = createOpenRouterProvider({ HttpError, env, fetchImpl, logger: quiet, keys: store, sleep: async ms => { delays.push(ms); }, random: () => 0.5, now: clock ? () => clock.t : undefined });
  const chatCalls = () => calls.filter(call => call.kind === 'chat');
  return { env, store, provider, calls, delays, chatCalls };
}
const ask = (provider, extra = {}) => provider.generate({ model: 'vendor/model-a:free', text: 'hi', history: [], ...extra });

// ---------------------------------------------------------------- key store
test('slots: OPENROUTER_API_KEY and _2.._10 are read; _1, _0 and _11 are reported, not used', () => {
  const env = envWith([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { OPENROUTER_API_KEY_1: keyFor(21), OPENROUTER_API_KEY_0: keyFor(22), OPENROUTER_API_KEY_11: keyFor(23), UNRELATED: 'x' });
  const { keys, ignored } = discoverSlots(env);
  assert.deepStrictEqual(keys.map(k => k.slot), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepStrictEqual(ignored, ['OPENROUTER_API_KEY_0', 'OPENROUTER_API_KEY_1', 'OPENROUTER_API_KEY_11']);
});

test('missing keys: not configured, clear catalog entry, generate refuses without any request', async () => {
  const h = harness({ slots: [] });
  assert.strictEqual(h.provider.configured(), false);
  assert.strictEqual(h.provider.status().validation, 'not_configured');
  assert.strictEqual(h.provider.catalogEntries()[0].available, false);
  await assert.rejects(ask(h.provider), e => e.code === 'provider_not_configured');
  assert.strictEqual(h.calls.length, 0);
});

test('store: list() never contains secrets; keys are masked; state file has no key material', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkeys-'));
  const env = {};
  const store = createOpenRouterKeyStore({ dir, env, logger: quiet });
  const secret = keyFor(7);
  store.add({ label: 'Main', key: secret });
  store.recordValidation(store.list()[0].id, 'ok');
  store.flush();
  const listed = JSON.stringify(store.list());
  assert.ok(!listed.includes(secret));
  assert.match(store.list()[0].masked, /^sk-o.*0f$|^sk-o/);
  assert.ok(!fs.readFileSync(path.join(dir, '.photon-openrouter-keys.json'), 'utf8').includes(secret));
  assert.ok(fs.readFileSync(path.join(dir, 'API.env'), 'utf8').includes('OPENROUTER_API_KEY=' + secret));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, 'API.env')).mode & 0o777, 0o600);
});

test('store: up to 10 keys, 11th rejected, duplicates and malformed keys rejected, slots reused after delete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkeys-'));
  const env = {};
  const store = createOpenRouterKeyStore({ dir, env, logger: quiet });
  for (let n = 1; n <= MAX_KEYS; n++) assert.strictEqual(store.add({ key: keyFor(n) }).slot, n);
  assert.throws(() => store.add({ key: keyFor(11) }), e => e.code === 'key_limit');
  assert.throws(() => store.add({ key: keyFor(3) }), e => e.code === 'duplicate_key');
  assert.throws(() => store.add({ key: 'not-a-key' }), e => e.code === 'invalid_key');
  const third = store.list().find(k => k.slot === 3);
  store.remove(third.id);
  assert.strictEqual(store.list().length, 9);
  assert.ok(!('OPENROUTER_API_KEY_3' in env));
  assert.ok(!fs.readFileSync(path.join(dir, 'API.env'), 'utf8').includes(keyFor(3)));
  assert.strictEqual(store.add({ key: keyFor(12) }).slot, 3);
});

test('store: validation, enabled flag and label persist across a restart (state only, not secrets)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkeys-'));
  const env = {};
  const first = createOpenRouterKeyStore({ dir, env, logger: quiet });
  const added = first.add({ label: 'Alpha', key: keyFor(1) });
  first.update(added.id, { enabled: false });
  first.recordValidation(added.id, 'invalid_api_key', { message: 'rejected' });
  const second = createOpenRouterKeyStore({ dir, env, logger: quiet });
  const item = second.list()[0];
  assert.strictEqual(item.label, 'Alpha');
  assert.strictEqual(item.enabled, false);
  assert.strictEqual(item.lastValidation.status, 'invalid_api_key');
});

test('store: rotating a key in place resets its validation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkeys-'));
  const env = {};
  const store = createOpenRouterKeyStore({ dir, env, logger: quiet });
  const added = store.add({ key: keyFor(1) });
  store.recordValidation(added.id, 'ok');
  const rotated = store.update(added.id, { key: keyFor(2) });
  assert.strictEqual(rotated.slot, 1);
  assert.strictEqual(rotated.lastValidation, null);
  assert.strictEqual(env.OPENROUTER_API_KEY, keyFor(2));
});

// ---------------------------------------------------------------- validation (real-request path, fake transport)
test('valid keys: all 10 slots are validated with a request each and none is trusted just for existing', async () => {
  const h = harness({ slots: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  assert.strictEqual(h.provider.status().validKeys, 0);          // present in env but not validated yet
  assert.strictEqual(h.provider.status().validated, false);
  await h.provider.refreshModels(true);
  const status = h.provider.status();
  assert.strictEqual(h.calls.filter(c => c.kind === 'key').length, 10);
  assert.deepStrictEqual([status.totalKeys, status.enabledKeys, status.validKeys, status.invalidKeys], [10, 10, 10, 0]);
  assert.strictEqual(status.validated, true);
});

test('invalid and revoked keys are identified, shown with a clear error and never selected', async () => {
  const bad = new Set([keyFor(2), keyFor(4)]);
  const h = harness({ slots: [1, 2, 3, 4], behavior: ({ key, kind }) => (kind === 'key' && bad.has(key) ? json(401, { error: { message: 'User not found.', code: 401 } }) : null) });
  await h.provider.refreshModels(true);
  const status = h.provider.status();
  assert.deepStrictEqual([status.validKeys, status.invalidKeys], [2, 2]);
  const rejected = status.keys.find(k => k.slot === 2);
  assert.strictEqual(rejected.lastValidation.status, 'invalid_api_key');
  assert.match(rejected.lastValidation.message, /rejected/i);
  assert.strictEqual(rejected.health.state, 'invalid');
  const used = [];
  for (let i = 0; i < 4; i++) used.push((await ask(h.provider)).key.slot);
  assert.deepStrictEqual(used, [1, 3, 1, 3]);
});

test('disabled keys are skipped; disabling every key makes OpenRouter unconfigured', async () => {
  const h = harness({ slots: [1, 2, 3] });
  await h.provider.refreshModels(true);
  h.store.update(h.store.list().find(k => k.slot === 2).id, { enabled: false });
  const used = [];
  for (let i = 0; i < 4; i++) used.push((await ask(h.provider)).key.slot);
  assert.deepStrictEqual(used, [1, 3, 1, 3]);
  for (const k of h.store.list()) h.store.update(k.id, { enabled: false });
  assert.strictEqual(h.provider.configured(), false);
});

test('a key that fails validation with a transient error is not marked invalid', async () => {
  const h = harness({ slots: [1, 2], behavior: ({ key, kind }) => (kind === 'key' && key === keyFor(1) ? json(503, { error: { message: 'down' } }) : null) });
  await h.provider.refreshModels(true);
  const k1 = h.provider.status().keys.find(k => k.slot === 1);
  assert.strictEqual(k1.lastValidation.status, 'provider_unavailable');
  assert.strictEqual(k1.health.state, 'unverified');
  assert.strictEqual(h.provider.status().invalidKeys, 0);
});

// ---------------------------------------------------------------- selection and failure handling
test('round-robin: valid keys are used in turn', async () => {
  const h = harness({ slots: [1, 2, 3] });
  const used = [];
  for (let i = 0; i < 7; i++) used.push((await ask(h.provider)).key.slot);
  assert.deepStrictEqual(used, [1, 2, 3, 1, 2, 3, 1]);
});

test('authentication failure on a revoked key fails over to the next key and remembers the revocation', async () => {
  const h = harness({ slots: [1, 2], behavior: ({ key, kind }) => (kind === 'chat' && key === keyFor(1) ? json(401, { error: { message: 'No auth credentials found', code: 401 } }) : null) });
  const result = await ask(h.provider);
  assert.strictEqual(result.key.slot, 2);
  const k1 = h.provider.status().keys.find(k => k.slot === 1);
  assert.strictEqual(k1.lastValidation.status, 'invalid_api_key');
  assert.strictEqual(k1.stats.lastError.code, 'invalid_api_key');
  const before = h.chatCalls().length;
  await ask(h.provider);
  assert.ok(h.chatCalls().slice(before).every(c => c.slot === 2), 'revoked key is not tried again');
});

test('authentication failures on every key stop after a bounded number of keys', async () => {
  const h = harness({ slots: [1, 2, 3, 4, 5], behavior: ({ kind }) => (kind === 'chat' ? json(401, { error: { message: 'bad key' } }) : null) });
  await assert.rejects(ask(h.provider), e => e.code === 'invalid_api_key' && !e.message.includes('sk-or'));
  assert.strictEqual(h.chatCalls().length, 3);
});

test('HTTP 429 honours Retry-After, retries the SAME key only, then reports the rate limit (no rotation)', async () => {
  const h = harness({ slots: [1, 2, 3], behavior: ({ kind }) => (kind === 'chat' ? json(429, { error: { message: 'rate limited', code: 429 } }, { 'retry-after': '2' }) : null) });
  await assert.rejects(ask(h.provider), e => e.code === 'quota_or_rate_limit' && e.status === 429);
  assert.strictEqual(h.chatCalls().length, 3);
  assert.deepStrictEqual([...new Set(h.chatCalls().map(c => c.slot))], [1], 'other keys are never used to get around a rate limit');
  assert.deepStrictEqual(h.delays, [2000, 2000]);
  for (const k of h.provider.status().keys) assert.notStrictEqual(k.health.state, 'invalid');
});

test('429 without Retry-After uses exponential backoff with a cap', async () => {
  const h = harness({ slots: [1], behavior: ({ kind }) => (kind === 'chat' ? json(429, { error: { message: 'slow down' } }) : null) });
  await assert.rejects(ask(h.provider), e => e.code === 'quota_or_rate_limit');
  assert.deepStrictEqual(h.delays, [500, 1000]);
});

test('a 429 that clears is retried successfully on the same key', async () => {
  let n = 0;
  const h = harness({ slots: [1, 2], behavior: ({ kind }) => (kind === 'chat' && ++n === 1 ? json(429, { error: { message: 'busy' } }, { 'retry-after': '1' }) : null) });
  const result = await ask(h.provider);
  assert.strictEqual(result.key.slot, 1);
  assert.strictEqual(h.chatCalls().length, 2);
});

test('billing errors are returned immediately and never trigger key rotation', async () => {
  const h = harness({ slots: [1, 2], behavior: ({ kind }) => (kind === 'chat' ? json(402, { error: { message: 'Insufficient credits' } }) : null) });
  await assert.rejects(ask(h.provider), e => e.code === 'billing_required');
  assert.strictEqual(h.chatCalls().length, 1);
});

test('provider timeouts: retried with backoff, one failover to another key, then a bounded failure', async () => {
  const h = harness({ slots: [1, 2, 3], behavior: ({ kind }) => { if (kind === 'chat') throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }); return null; } });
  await assert.rejects(ask(h.provider), e => e.code === 'provider_timeout' && e.status === 504);
  assert.strictEqual(h.chatCalls().length, 6);              // 3 attempts on key 1 + 3 on key 2, never a third key
  assert.deepStrictEqual([...new Set(h.chatCalls().map(c => c.slot))], [1, 2]);
  assert.deepStrictEqual(h.delays, [500, 1000, 500, 1000]);
});

test('a transient 5xx on the first key recovers on another key', async () => {
  const h = harness({ slots: [1, 2], behavior: ({ kind, key }) => (kind === 'chat' && key === keyFor(1) ? json(503, { error: { message: 'upstream down' } }) : null) });
  const result = await ask(h.provider);
  assert.strictEqual(result.key.slot, 2);
});

test('failure recovery: repeated transient failures pause a key with exponential backoff, then it returns', async () => {
  const clock = { t: 1_000_000 };
  let failing = true;
  const h = harness({ slots: [1], clock, behavior: ({ kind }) => { if (kind === 'chat' && failing) throw Object.assign(new Error('socket hang up'), { name: 'TypeError' }); return null; } });
  for (let i = 0; i < FAILURE_THRESHOLD; i++) await assert.rejects(ask(h.provider), e => e.code === 'network_error');
  let k = h.provider.status().keys[0];
  assert.strictEqual(k.health.state, 'cooling_down');
  assert.strictEqual(h.provider.status().temporarilyUnavailableKeys, 1);
  const callsWhilePaused = h.chatCalls().length;
  await assert.rejects(ask(h.provider), e => e.code === 'no_valid_key');
  assert.strictEqual(h.chatCalls().length, callsWhilePaused, 'no request is sent while the key is paused');
  clock.t += COOLDOWN_BASE_MS + 1;
  failing = false;
  const result = await ask(h.provider);
  assert.strictEqual(result.text, 'hello');
  k = h.provider.status().keys[0];
  assert.strictEqual(k.health.state, 'active');
  assert.strictEqual(k.health.consecutiveFailures, 0);
});

test('cooldown doubles with each further consecutive failure and is capped', () => {
  const clock = { t: 0 };
  const store = createOpenRouterKeyStore({ env: envWith([1]), persist: false, logger: quiet });
  const manager = createKeyManager({ store, now: () => clock.t });
  const id = store.list()[0].id;
  store.recordValidation(id, 'ok');
  const pauses = [];
  for (let i = 1; i <= 9; i++) { manager.reportFailure(id, 'network_error', {}); pauses.push(Date.parse(manager.describe(store.list()[0]).cooldownUntil || new Date(0).toISOString()) - clock.t); }
  assert.strictEqual(pauses[FAILURE_THRESHOLD - 1], COOLDOWN_BASE_MS);
  assert.strictEqual(pauses[FAILURE_THRESHOLD], COOLDOWN_BASE_MS * 2);
  assert.strictEqual(pauses[8], 10 * 60 * 1000);
});

test('attempts are hard-capped even if every key keeps failing transiently', async () => {
  const h = harness({ slots: [1, 2, 3, 4, 5, 6], behavior: ({ kind }) => (kind === 'chat' ? json(502, { error: { message: 'bad gateway' } }) : null) });
  await assert.rejects(ask(h.provider), e => e.code === 'provider_unavailable');
  assert.ok(h.chatCalls().length <= 8);
});

test('usage tracking: tokens, cost, model, status and the key used are recorded without any secret', async () => {
  const h = harness({ slots: [1, 2] });
  const result = await ask(h.provider);
  assert.deepStrictEqual(result.usage, { inputTokens: 5, outputTokens: 2, totalTokens: 7, cost: 0 });
  assert.strictEqual(result.model, 'vendor/model-a:free');
  const recent = h.provider.status().recentRequests[0];
  assert.strictEqual(recent.status, 'ok');
  assert.strictEqual(recent.model, 'vendor/model-a:free');
  assert.strictEqual(recent.totalTokens, 7);
  assert.strictEqual(recent.keyId, result.key.id);
  assert.ok(!JSON.stringify(h.provider.status()).includes(keyFor(1)));
  const k = h.provider.status().keys.find(item => item.id === result.key.id);
  assert.strictEqual(k.stats.successCount, 1);
  assert.ok(k.stats.lastSuccessAt);
  assert.strictEqual(h.provider.status().lastSuccessfulRequestAt, k.stats.lastSuccessAt);
});

test('cost is only reported when the API returns it', async () => {
  const h = harness({ slots: [1], behavior: ({ kind }) => (kind === 'chat' ? okChat({ usage: { prompt_tokens: 1, completion_tokens: 1 } }) : null) });
  const result = await ask(h.provider);
  assert.deepStrictEqual(result.usage, { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
});

test('secrets never appear in logs or error messages', async () => {
  const lines = [];
  const env = envWith([1, 2]);
  const store = createOpenRouterKeyStore({ env, persist: false, logger: quiet });
  const provider = createOpenRouterProvider({ HttpError, env, keys: store, logger: { error: line => lines.push(line) }, sleep: async () => {}, random: () => 0.5,
    fetchImpl: async (url, init = {}) => { const kind = url.endsWith('/key') ? 'key' : 'chat'; if (kind === 'key') return json(200, { data: {} }); return json(401, { error: { message: 'Invalid key ' + String(init.headers.Authorization) } }); } });
  await assert.rejects(ask(provider), e => !e.message.includes('sk-or-v1-testkey'));
  assert.ok(lines.length > 0);
  for (const line of lines) assert.ok(!line.includes('sk-or-v1-testkey'), line);
});

// ---------------------------------------------------------------- streaming
function sse(chunks, status = 200) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const c of chunks) controller.enqueue(encoder.encode(c)); controller.close(); } }), { status, headers: { 'content-type': 'text/event-stream' } });
}
const streamChunks = [
  'data: {"model":"vendor/model-a:free","choices":[{"delta":{"content":"Hel"}}]}\n\n',
  ': OPENROUTER PROCESSING\n\n',
  'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,"cost":0}}\n\n',
  'data: [DONE]\n\n',
];
async function collect(iterator) { const events = []; for await (const e of iterator) events.push(e); return events; }

test('streaming: deltas, final text, usage and the serving key are delivered', async () => {
  const h = harness({ slots: [1, 2], behavior: ({ kind, init }) => (kind === 'chat' ? (JSON.parse(init.body).stream === true ? sse(streamChunks) : null) : null) });
  const events = await collect(h.provider.streamGenerate({ model: 'vendor/model-a:free', text: 'hi', history: [] }));
  assert.deepStrictEqual(events.filter(e => e.type === 'delta').map(e => e.text), ['Hel', 'lo']);
  const done = events.at(-1);
  assert.strictEqual(done.type, 'done');
  assert.strictEqual(done.text, 'Hello');
  assert.deepStrictEqual(done.usage, { inputTokens: 4, outputTokens: 2, totalTokens: 6, cost: 0 });
  assert.strictEqual(done.key.slot, 1);
  assert.strictEqual(JSON.parse(h.chatCalls()[0].init.body).stream_options.include_usage, true);
});

test('streaming: a revoked key is skipped before any output starts; next key serves the stream', async () => {
  const h = harness({ slots: [1, 2], behavior: ({ kind, key }) => (kind === 'chat' ? (key === keyFor(1) ? json(401, { error: { message: 'bad' } }) : sse(streamChunks)) : null) });
  const events = await collect(h.provider.streamGenerate({ model: 'vendor/model-a:free', text: 'hi', history: [] }));
  assert.strictEqual(events.at(-1).key.slot, 2);
  assert.strictEqual(events.filter(e => e.type === 'delta').length, 2);
});

test('streaming: 429 before the stream retries the same key only and then errors', async () => {
  const h = harness({ slots: [1, 2], behavior: ({ kind }) => (kind === 'chat' ? json(429, { error: { message: 'busy' } }, { 'retry-after': '1' }) : null) });
  await assert.rejects(collect(h.provider.streamGenerate({ model: 'vendor/model-a:free', text: 'hi', history: [] })), e => e.code === 'quota_or_rate_limit');
  assert.deepStrictEqual([...new Set(h.chatCalls().map(c => c.slot))], [1]);
});

test('streaming: an empty stream is an error, not a silent success', async () => {
  const h = harness({ slots: [1], behavior: ({ kind }) => (kind === 'chat' ? sse(['data: [DONE]\n\n']) : null) });
  await assert.rejects(collect(h.provider.streamGenerate({ model: 'vendor/model-a:free', text: 'hi', history: [] })), e => e.code === 'empty_response');
});

// ---------------------------------------------------------------- free models
test('free models come from pricing metadata, not from hardcoded ids', () => {
  assert.strictEqual(isFreeModel(CATALOG[0]), true);
  assert.strictEqual(isFreeModel(CATALOG[1]), false);
  assert.strictEqual(isFreeModel(CATALOG[2]), true);
  assert.strictEqual(isFreeModel(CATALOG[3]), false, 'a ":free" id with non-zero pricing is not free');
  assert.strictEqual(isFreeModel(CATALOG[4]), true, 'without pricing metadata the documented ":free" naming is the only signal');
  assert.strictEqual(isFreeModel(CATALOG[5]), true, 'zero pricing without a ":free" suffix is free');
  assert.strictEqual(isFreeModel(CATALOG[6]), false, 'variable pricing (-1) is not free');
  const free = freeModelsFrom(CATALOG).map(m => m.id);
  assert.ok(!free.includes('vendor/paid-model') && !free.includes('vendor/mislabelled:free'));
  assert.ok(free.includes('openrouter/free'));
  const entry = freeModelsFrom(CATALOG).find(m => m.id === 'vendor/model-a:free');
  assert.deepStrictEqual([entry.author, entry.pricing.prompt, entry.contextLength], ['vendor', '0', 8192]);
});

test('models exposed to PHOTON are exactly the live free catalog; nothing is added from a built-in list', async () => {
  const h = harness({ slots: [1] });
  await h.provider.refreshModels(true);
  const ids = h.provider.catalogEntries().map(m => m.id).sort();
  assert.deepStrictEqual(ids, ['openrouter/free', 'vendor/model-a:free', 'vendor/no-pricing-meta:free', 'vendor/zero-price']);
  assert.ok(h.provider.catalogEntries().every(m => m.available && m.free));
  assert.strictEqual(h.provider.status().freeModels.find(m => m.id === 'vendor/model-a:free').provider, 'vendor');
});

test('verifyModel confirms a model against the live catalog before it can be enabled', async () => {
  const h = harness({ slots: [1] });
  assert.strictEqual((await h.provider.verifyModel('vendor/model-a:free')).ok, true);
  const missing = await h.provider.verifyModel('vendor/removed-model:free');
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.code, 'invalid_model');
  assert.strictEqual((await h.provider.verifyModel('../etc/passwd')).ok, false);
});

test('no valid key means the catalog advertises nothing as available', async () => {
  const h = harness({ slots: [1, 2], behavior: ({ kind }) => (kind === 'key' ? json(401, { error: { message: 'nope' } }) : null) });
  await h.provider.refreshModels(true);
  assert.strictEqual(h.provider.status().validated, false);
  assert.ok(h.provider.catalogEntries().every(m => m.available === false));
  assert.strictEqual(h.provider.status().validation, 'invalid_api_key');
});

// ---------------------------------------------------------------- admin test-connection path
test('testKey and testAll use real requests, record results and never return the key', async () => {
  const h = harness({ slots: [1, 2], behavior: ({ kind, key }) => (kind === 'key' && key === keyFor(2) ? json(401, { error: { message: 'revoked' } }) : null) });
  const results = await h.provider.testAll();
  assert.deepStrictEqual(results.map(r => [r.slot, r.status]), [[1, 'ok'], [2, 'invalid_api_key']]);
  assert.ok(!JSON.stringify(results).includes('sk-or-v1-testkey'));
  const id = h.store.list().find(k => k.slot === 1).id;
  const single = await h.provider.testKey(id);
  assert.strictEqual(single.status, 'ok');
  await assert.rejects(h.provider.testKey('0000000000000000'), e => e.code === 'key_not_found');
  assert.ok(h.store.list().find(k => k.slot === 1).lastOkAt);
});
