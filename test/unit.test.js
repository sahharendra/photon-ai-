'use strict';
// Unit tests for the Anthropic provider wrapper. A stub SDK is injected ONLY to exercise this module's own
// logic (env parsing, message building, error mapping, model discovery). It says nothing about real Claude
// behaviour - run `npm run test:live` with a real key for that.
const test = require('node:test');
const assert = require('node:assert');
const { parseEnv, createAnthropicProvider } = require('../anthropic-provider');

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const quiet = { error() {}, log() {} };
const KEY = 'sk-ant-unit-test-key-0000000000000000';
function stubSdk(handlers) {
  return function Anthropic(opts) {
    this.opts = opts;
    this.messages = { create: async params => handlers.create(params, opts) };
    this.models = { list: () => handlers.list(opts) };
  };
}
const make = (handlers, env = { ANTHROPIC_API_KEY: KEY }) => createAnthropicProvider({ HttpError, env, logger: quiet, loadSdk: () => stubSdk(handlers) });
async function* asyncList(items) { for (const i of items) yield i; }

test('parseEnv handles CRLF, BOM, quotes, comments, export', () => {
  const out = parseEnv('\uFEFF# c\r\nANTHROPIC_API_KEY="abc"\r\nexport X=1\r\n bad line\r\nY = two words \r\n');
  assert.deepStrictEqual(out, { ANTHROPIC_API_KEY: 'abc', X: '1', Y: 'two words' });
});

test('missing key: not configured, clear error, no SDK call', async () => {
  const p = make({}, {});
  assert.strictEqual(p.configured(), false);
  assert.strictEqual(p.status().validation, 'not_configured');
  assert.strictEqual(p.catalogEntries()[0].configured, false);
  await assert.rejects(p.generate({ model: 'claude-x', text: 'hi' }), e => e.code === 'provider_not_configured' && e.status === 503);
});

test('missing SDK package gives install hint', async () => {
  const p = createAnthropicProvider({ HttpError, env: { ANTHROPIC_API_KEY: KEY }, logger: quiet, loadSdk: () => { throw Object.assign(new Error('nope'), { code: 'MODULE_NOT_FOUND' }); } });
  await assert.rejects(p.generate({ model: 'claude-x', text: 'hi' }), e => e.code === 'provider_not_installed');
});

test('key format warning, key never in status', () => {
  const p = make({}, { ANTHROPIC_API_KEY: 'not-a-real-prefix-key' });
  assert.match(p.status().keyFormatWarning, /sk-ant-/);
  assert.ok(!JSON.stringify(p.status()).includes('not-a-real-prefix-key'));
});

test('model discovery uses the account list, no hardcoded ids', async () => {
  const p = make({ list: () => asyncList([{ id: 'claude-alpha-1', display_name: 'Claude Alpha' }, { id: 'bad id!', display_name: 'x' }, { id: 'claude-beta-2' }]) });
  await p.refreshModels(true);
  const entries = p.catalogEntries();
  assert.deepStrictEqual(entries.map(e => e.id), ['claude-alpha-1', 'claude-beta-2']);
  assert.strictEqual(entries[0].name, 'Claude Alpha');
  assert.strictEqual(p.status().validation, 'ok');
  assert.ok(!entries.some(e => e.id === 'claude-sonnet-4'));
});

test('model discovery failure with bad key is reported, key not leaked', async () => {
  const err = Object.assign(new Error('401 invalid x-api-key ' + KEY), { status: 401, name: 'AuthenticationError' });
  const p = make({ list: () => { throw err; } });
  await p.refreshModels(true);
  assert.strictEqual(p.status().validation, 'invalid_api_key');
  assert.strictEqual(p.catalogEntries()[0].unavailable, true);
  assert.ok(!JSON.stringify(p.status()).includes(KEY));
});

test('buildMessages merges same-role turns, drops leading assistant, ends with user, maps attachments', () => {
  const p = make({});
  const msgs = p.buildMessages(
    [{ role: 'assistant', text: 'orphan' }, { role: 'user', text: 'a' }, { role: 'user', text: 'b' }, { role: 'model', text: 'c' }],
    'now', [{ kind: 'text', name: 'n.txt', text: 'T' }, { kind: 'inline', name: 'i.png', mimeType: 'image/png', data: 'AAAA' }, { kind: 'inline', name: 'd.pdf', mimeType: 'application/pdf', data: 'BBBB' }]);
  assert.deepStrictEqual(msgs.map(m => m.role), ['user', 'assistant', 'user']);
  assert.strictEqual(msgs[0].content.length, 2);
  const last = msgs[2].content.map(b => b.type);
  assert.deepStrictEqual(last, ['text', 'image', 'document', 'text']);
});

test('generate sends system + history and returns real usage numbers from the response', async () => {
  let seen;
  const p = make({ create: async params => { seen = params; return { content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }], usage: { input_tokens: 11, output_tokens: 7 }, stop_reason: 'end_turn', model: params.model }; } });
  const r = await p.generate({ model: 'claude-alpha-1', system: 'be brief', history: [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }], text: 'q2' });
  assert.strictEqual(r.text, 'hello world');
  assert.deepStrictEqual(r.usage, { inputTokens: 11, outputTokens: 7 });
  assert.strictEqual(seen.system, 'be brief');
  assert.strictEqual(seen.messages.length, 3);
  assert.ok(seen.max_tokens > 0);
});

test('generate rejects invalid model ids and empty responses', async () => {
  const p = make({ create: async () => ({ content: [], usage: {}, stop_reason: 'end_turn' }) });
  await assert.rejects(p.generate({ model: '../evil', text: 'x' }), e => e.code === 'invalid_model');
  await assert.rejects(p.generate({ model: 'claude-a', text: 'x' }), e => e.code === 'empty_response');
});

test('error mapping covers auth, billing, model, rate limit, overload, 5xx, timeout, network', () => {
  const p = make({});
  const m = e => p.mapError(e);
  const E = (status, extra = {}) => Object.assign(new Error('raw secret ' + KEY), { status, ...extra });
  assert.strictEqual(m(E(401)).code, 'invalid_api_key');
  assert.strictEqual(m(E(403)).code, 'provider_forbidden');
  assert.strictEqual(m(E(404)).code, 'invalid_model');
  assert.strictEqual(m(E(429)).status, 429);
  assert.strictEqual(m(E(529)).code, 'provider_overloaded');
  assert.strictEqual(m(E(500)).code, 'provider_unavailable');
  assert.strictEqual(m(E(400, { message: 'Your credit balance is too low' })).code, 'billing_required');
  assert.strictEqual(m(E(400)).code, 'provider_rejected_request');
  assert.strictEqual(m(Object.assign(new Error('t'), { name: 'APIConnectionTimeoutError' })).code, 'provider_timeout');
  assert.strictEqual(m(Object.assign(new Error('fetch failed'), { name: 'APIConnectionError' })).code, 'network_error');
  for (const status of [401, 403, 404, 429, 500, 529]) assert.ok(!m(E(status)).message.includes(KEY));
});

test('generate maps provider failures without leaking the key', async () => {
  const p = make({ create: async () => { throw Object.assign(new Error('x-api-key ' + KEY), { status: 429, name: 'RateLimitError' }); } });
  await assert.rejects(p.generate({ model: 'claude-a', text: 'x' }), e => e.code === 'quota_or_rate_limit' && !e.message.includes(KEY));
});

test('client is created with timeout and retries and the server key', async () => {
  let opts;
  const p = make({ create: async (_, o) => { opts = o; return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }; } });
  await p.generate({ model: 'claude-a', text: 'x' });
  assert.strictEqual(opts.apiKey, KEY); assert.ok(opts.timeout >= 30000); assert.ok(opts.maxRetries >= 1);
});
