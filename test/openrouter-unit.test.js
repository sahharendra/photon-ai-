'use strict';
// Unit tests for the OpenRouter provider, PHOTON plan limits, and usage accounting.
// A stub fetch is injected ONLY to exercise this module's own logic. Real authentication,
// free-model discovery, chat and streaming are covered by scripts/test-openrouter-live.js.
const test = require('node:test');
const assert = require('node:assert');
const {
  createOpenRouterProvider, isFreeModel, freeModelsFrom, validationMessage, MODEL_ID, PREFERRED_FREE_MODELS,
} = require('../openrouter-provider');
const { SETTINGS_VERSION, PLAN_DAILY_LIMITS, canSpend, remaining } = require('../photon-limits');
const { localDateKey, summarizeUsage } = require('../photon-usage');

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const quiet = { error() {}, log() {} };
const KEY = 'sk-or-v1-unit-test-key-0000000000000000';

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, body: null };
}
function streamResponse(chunks, status = 200) {
  let i = 0;
  const encoder = new TextEncoder();
  return {
    ok: status >= 200 && status < 300,
    status,
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
const freeCatalog = {
  data: [
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'NVIDIA: Nemotron 3 Ultra', pricing: { prompt: '0', completion: '0' }, context_length: 131072 },
    { id: 'dots-studio/dots-3-note-preview:free', name: 'Dots Studio: Dots3-Note Preview', pricing: { prompt: '0', completion: '0' } },
    { id: 'cohere/north-mini-code:free', name: 'Cohere: North Mini Code', pricing: { prompt: '0', completion: '0' } },
    { id: 'openrouter/free', name: 'Free Models Router', pricing: { prompt: '0', completion: '0' } },
    { id: 'acme/zero-priced', name: 'Acme Zero', pricing: { prompt: '0', completion: '0', request: '0' } },
    { id: 'acme/paid-model', name: 'Acme Paid', pricing: { prompt: '0.000001', completion: '0.000002' } },
    { id: 'acme/request-fee', name: 'Acme Request Fee', pricing: { prompt: '0', completion: '0', request: '0.01' } },
    { id: 'bad id!', name: 'Bad' },
  ],
};
function make(fetchImpl, env = { OPENROUTER_API_KEY: KEY }) {
  return createOpenRouterProvider({ HttpError, env, logger: quiet, fetchImpl });
}
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const path = String(url).replace('https://openrouter.ai/api/v1', '');
    const route = routes[path];
    if (!route) throw new Error('unexpected request: ' + url);
    return typeof route === 'function' ? route(opts) : route;
  };
  fn.calls = calls;
  return fn;
}

test('missing key: not configured, no network call, clear error', async () => {
  const fetchImpl = fakeFetch({});
  const p = make(fetchImpl, {});
  assert.strictEqual(p.configured(), false);
  assert.strictEqual(p.status().validation, 'not_configured');
  assert.strictEqual(p.catalogEntries()[0].configured, false);
  assert.match(p.catalogEntries()[0].reason, /not configured/i);
  await p.refreshModels(true);
  assert.strictEqual(fetchImpl.calls.length, 0);
  await assert.rejects(p.generate({ model: 'openrouter/free', text: 'hi' }), e => e.code === 'provider_not_configured' && e.status === 503);
});

test('key validation uses GET /key with the server bearer token', async () => {
  let seen;
  const p = make(fakeFetch({
    '/key': opts => { seen = opts; return jsonResponse({ data: { label: 'test key', usage: 0, limit: null } }); },
    '/models': jsonResponse(freeCatalog),
  }));
  const key = await p.validateKey();
  assert.strictEqual(key.label, 'test key');
  assert.strictEqual(seen.headers.Authorization, 'Bearer ' + KEY);
  assert.strictEqual(seen.headers['X-Title'], 'PHOTON AI');
  assert.ok(seen.headers['HTTP-Referer']);
});

test('free model discovery registers only live free models, preferred first', async () => {
  const fetchImpl = fakeFetch({ '/key': jsonResponse({ data: {} }), '/models': jsonResponse(freeCatalog) });
  const p = make(fetchImpl);
  const models = await p.refreshModels(true);
  const ids = models.map(m => m.id);
  assert.deepStrictEqual(ids.slice(0, 4), PREFERRED_FREE_MODELS.map(m => m.id));
  assert.ok(ids.includes('acme/zero-priced'));
  assert.ok(!ids.includes('acme/paid-model'));
  assert.ok(!ids.includes('acme/request-fee'));
  assert.ok(!ids.includes('bad id!'));
  const entries = p.catalogEntries();
  assert.ok(entries.every(e => e.available && e.free && e.provider === 'OpenRouter'));
  assert.strictEqual(p.status().validated, true);
  assert.strictEqual(p.status().validation, 'ok');
  assert.strictEqual(p.status().freeModelCount, ids.length);
  assert.ok(!fetchImpl.calls.some(c => c.url.includes('/chat/completions')));
});

test('free model helpers reject paid, request-fee, image-fee and malformed ids', () => {
  assert.strictEqual(isFreeModel({ id: 'openrouter/free' }), true);
  assert.strictEqual(isFreeModel({ id: 'x/y:free' }), true);
  assert.strictEqual(isFreeModel({ id: 'x/y', pricing: { prompt: '0', completion: '0' } }), true);
  assert.strictEqual(isFreeModel({ id: 'x/y', pricing: { prompt: '0', completion: '0', image: '0.1' } }), false);
  assert.strictEqual(isFreeModel({ id: 'x/y', pricing: { prompt: '0.1', completion: '0' } }), false);
  assert.strictEqual(isFreeModel({ id: '../evil', pricing: { prompt: '0', completion: '0' } }), false);
  assert.strictEqual(MODEL_ID.test('vendor/model:free'), true);
  assert.strictEqual(MODEL_ID.test('../evil'), false);
  const out = freeModelsFrom([{ id: 'z/z:free', name: 'Z' }, { id: 'a/a:free', name: 'A' }]);
  assert.deepStrictEqual(out.map(m => m.id), ['a/a:free', 'z/z:free']);
});

test('invalid key: validation reports invalid_api_key, models cleared, key never leaked', async () => {
  const p = make(fakeFetch({
    '/key': jsonResponse({ error: { message: 'No auth credentials found' } }, 401),
    '/models': jsonResponse(freeCatalog),
    '/chat/completions': jsonResponse({ error: { message: 'No auth credentials found' } }, 401),
  }));
  await p.refreshModels(true);
  const status = p.status();
  assert.strictEqual(status.configured, true);
  assert.strictEqual(status.validated, false);
  assert.strictEqual(status.validation, 'invalid_api_key');
  assert.strictEqual(status.modelCount, 0);
  assert.strictEqual(p.catalogEntries()[0].unavailable, true);
  assert.match(p.catalogEntries()[0].reason, /rejected the server API key/i);
  assert.ok(!JSON.stringify(status).includes(KEY));
  await assert.rejects(p.generate({ model: 'openrouter/free', text: 'x' }), e => e.code === 'invalid_api_key' && !e.message.includes(KEY));
});

test('rate-limited key check is mapped and not treated as valid', async () => {
  const p = make(fakeFetch({ '/key': jsonResponse({ error: { message: 'Rate limit exceeded' } }, 429), '/models': jsonResponse(freeCatalog) }));
  await p.refreshModels(true);
  assert.strictEqual(p.status().validation, 'quota_or_rate_limit');
  assert.strictEqual(p.status().validated, false);
  assert.match(validationMessage('quota_or_rate_limit'), /rate limit/i);
});

test('buildMessages adds system, drops leading assistant, merges same roles and maps attachments', () => {
  const p = make(fakeFetch({}));
  const messages = p.buildMessages({
    system: 'be brief',
    history: [
      { role: 'assistant', text: 'orphan' },
      { role: 'user', text: 'a' },
      { role: 'user', text: 'b' },
      { role: 'assistant', text: 'c' },
    ],
    text: 'now',
    attachments: [
      { kind: 'text', name: 'n.txt', text: 'T' },
      { kind: 'inline', name: 'i.png', mimeType: 'image/png', data: 'AAAA' },
      { kind: 'inline', name: 'd.pdf', mimeType: 'application/pdf', data: 'BBBB' },
    ],
  });
  assert.deepStrictEqual(messages.map(m => m.role), ['system', 'user', 'assistant', 'user']);
  assert.strictEqual(messages[1].content, 'a\n\nb');
  assert.deepStrictEqual(messages[3].content.map(part => part.type), ['text', 'image_url', 'file', 'text']);
});

test('generate sends the OpenAI-compatible payload and returns real usage', async () => {
  let body;
  const p = make(fakeFetch({
    '/chat/completions': opts => {
      body = JSON.parse(opts.body);
      return jsonResponse({
        model: 'openrouter/free',
        choices: [{ message: { role: 'assistant', content: 'hello world' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      });
    },
  }));
  const result = await p.generate({ model: 'openrouter/free', system: 'be brief', history: [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }], text: 'q2', maxTokens: 64 });
  assert.strictEqual(result.text, 'hello world');
  assert.deepStrictEqual(result.usage, { inputTokens: 12, outputTokens: 8, totalTokens: 20 });
  assert.strictEqual(result.stopReason, 'stop');
  assert.strictEqual(body.model, 'openrouter/free');
  assert.strictEqual(body.max_tokens, 64);
  assert.deepStrictEqual(body.messages.map(m => m.role), ['system', 'user', 'assistant', 'user']);
  assert.strictEqual(body.stream, undefined);
});

test('generate rejects invalid model ids and empty responses', async () => {
  const p = make(fakeFetch({ '/chat/completions': jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }) }));
  await assert.rejects(p.generate({ model: '../evil', text: 'x' }), e => e.code === 'invalid_model');
  await assert.rejects(p.generate({ model: 'openrouter/free', text: 'x' }), e => e.code === 'empty_response');
});

test('streamGenerate yields deltas, honours stream_options, and reports usage', async () => {
  let body;
  const sse = [
    'data: {"model":"openrouter/free","choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"model":"openrouter/free","choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"model":"openrouter/free","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
    'data: [DONE]\n\n',
  ];
  const p = make(fakeFetch({ '/chat/completions': opts => { body = JSON.parse(opts.body); return streamResponse(sse); } }));
  const events = [];
  for await (const event of p.streamGenerate({ model: 'openrouter/free', text: 'hi', maxTokens: 32 })) events.push(event);
  assert.deepStrictEqual(events.filter(e => e.type === 'delta').map(e => e.text), ['Hel', 'lo']);
  const done = events.find(e => e.type === 'done');
  assert.strictEqual(done.text, 'Hello');
  assert.deepStrictEqual(done.usage, { inputTokens: 5, outputTokens: 2, totalTokens: 7 });
  assert.strictEqual(done.stopReason, 'stop');
  assert.strictEqual(body.stream, true);
  assert.deepStrictEqual(body.stream_options, { include_usage: true });
});

test('streamGenerate maps provider error events and empty streams', async () => {
  const p = make(fakeFetch({
    '/chat/completions': streamResponse(['data: {"error":{"message":"upstream overloaded"}}\n\n']),
  }));
  await assert.rejects(async () => { for await (const _ of p.streamGenerate({ model: 'openrouter/free', text: 'x' })) {} }, e => e.code === 'provider_unavailable' || e.code === 'provider_error');
  const empty = make(fakeFetch({ '/chat/completions': streamResponse(['data: [DONE]\n\n']) }));
  await assert.rejects(async () => { for await (const _ of empty.streamGenerate({ model: 'openrouter/free', text: 'x' })) {} }, e => e.code === 'empty_response');
});

test('error mapping covers auth, billing, model, rate limit, timeout, network and 5xx without leaking the key', () => {
  const p = make(fakeFetch({}));
  const m = e => p.mapError(e);
  const E = (status, extra = {}) => Object.assign(new Error('raw secret ' + KEY), { status, ...extra });
  assert.strictEqual(m(E(401)).code, 'invalid_api_key');
  assert.strictEqual(m(E(402)).code, 'billing_required');
  assert.strictEqual(m(E(403)).code, 'provider_forbidden');
  assert.strictEqual(m(E(404)).code, 'invalid_model');
  assert.strictEqual(m(E(408)).code, 'provider_timeout');
  assert.strictEqual(m(E(413)).code, 'request_too_large');
  assert.strictEqual(m(E(429)).status, 429);
  assert.strictEqual(m(E(429)).code, 'quota_or_rate_limit');
  assert.strictEqual(m(E(502)).code, 'provider_unavailable');
  assert.strictEqual(m(E(503)).code, 'provider_unavailable');
  assert.strictEqual(m(E(500)).code, 'provider_unavailable');
  assert.strictEqual(m(E(400, { error: { message: 'model not found' } })).code, 'invalid_model');
  assert.strictEqual(m(E(400, { error: { message: 'maximum context length exceeded' } })).code, 'request_too_large');
  assert.strictEqual(m(E(400, { error: { message: 'moderation flagged' } })).code, 'content_filtered');
  assert.strictEqual(m(E(400)).code, 'provider_rejected_request');
  assert.strictEqual(m(Object.assign(new Error('t'), { name: 'TimeoutError' })).code, 'provider_timeout');
  assert.strictEqual(m(Object.assign(new Error('fetch failed'), { name: 'TypeError' })).code, 'network_error');
  for (const status of [401, 402, 403, 404, 429, 500, 502, 503]) assert.ok(!m(E(status)).message.includes(KEY));
});

test('key format warning is reported but the key never appears in status', () => {
  const p = make(fakeFetch({}), { OPENROUTER_API_KEY: 'not-an-openrouter-key' });
  assert.match(p.status().keyFormatWarning, /sk-or-/);
  assert.ok(!JSON.stringify(p.status()).includes('not-an-openrouter-key'));
});

test('PHOTON plan limits are Basic 50, Pro 200, Premium 2000 and enforced at the boundary', () => {
  assert.strictEqual(SETTINGS_VERSION, 2);
  assert.deepStrictEqual({ ...PLAN_DAILY_LIMITS }, { basic: 50, pro: 200, premium: 2000 });
  assert.strictEqual(canSpend(49, 1, 50), true);
  assert.strictEqual(canSpend(50, 1, 50), false);
  assert.strictEqual(canSpend(0, 100, 50), false);
  assert.strictEqual(canSpend(199, 1, 200), true);
  assert.strictEqual(canSpend(200, 1, 200), false);
  assert.strictEqual(canSpend(1999, 1, 2000), true);
  assert.strictEqual(canSpend(2000, 1, 2000), false);
  assert.strictEqual(canSpend('x', 1, 50), false);
  assert.strictEqual(remaining(50, 50), 0);
  assert.strictEqual(remaining(13, 50), 37);
  assert.strictEqual(remaining(300, 200), 0);
});

test('usage accounting separates PHOTON credits from actual provider tokens', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const activities = [
    { type: 'chat', tokens: 1, at: '2026-11-10T09:00:00Z', providerTokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    { type: 'chat', tokens: 1, at: '2026-11-10T10:00:00Z', providerTokens: { input_tokens: 4, output_tokens: 6 } },
    { type: 'code', tokens: 100, at: '2026-11-10T11:00:00Z' },
    { type: 'image', tokens: 2, at: '2026-11-09T23:00:00Z', providerTokens: { totalTokens: 99 } },
  ];
  const summary = summarizeUsage(activities, 'UTC', now);
  assert.strictEqual(localDateKey(now, 'UTC'), '2026-11-10');
  assert.strictEqual(summary.used, 102);
  assert.deepStrictEqual(summary.by, { chat: 2, voice: 0, code: 100, image: 0, video: 0 });
  assert.deepStrictEqual(summary.actual, { input: 14, output: 11, total: 25 });
  assert.strictEqual(summary.requests, 3);
  assert.deepStrictEqual(summarizeUsage([], 'UTC', now), { used: 0, by: { chat: 0, voice: 0, code: 0, image: 0, video: 0 }, actual: { input: 0, output: 0, total: 0 }, requests: 0 });
});
