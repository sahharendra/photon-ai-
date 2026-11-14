'use strict';
// Unit tests for the OpenAI provider, its config/state module, the Ollama adapter and the shared
// fallback policy. Everything is mocked: no real OpenAI request and no credit is ever used.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createOpenAIConfig, normalizeModels, lookupMetadata, costUsdFor, priceFor, describeModel, isOpenAIChatModel, STATE_FILE,
} = require('../openai-config');
const { createOpenAIProvider, validationMessage } = require('../openai-provider');
const { createOllamaProvider } = require('../ollama-provider');
const { chooseFallback, fallbackEligible, capabilityNeeds, isFreeDestination, isPaidDestination } = require('../provider-fallback');

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const SECRET = 'sk-test-SUPERSECRET-0123456789abcdef';
const MODEL = 'gpt-5-mini';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'photon-openai-unit-')); }

function sdkError(status, code, message = 'provider error', headers = null) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (headers) error.headers = { get: name => (name.toLowerCase() === 'retry-after' ? headers : null) };
  return error;
}

// Minimal stand-in for the official SDK. `create` answers chat completions and `list` returns
// GET /v1/models. Both are injected, so the real package is never called.
function fakeSdk({ create, list }) {
  class FakeOpenAI {
    constructor(options) {
      this.options = options;
      this.chat = { completions: { create: (params, requestOptions) => create(params, requestOptions) } };
      this.models = { list: query => list(query) };
    }
  }
  return { default: FakeOpenAI, OpenAI: FakeOpenAI };
}

function completion({ text = 'Hello from the mock model.', usage = { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }, model = MODEL } = {}) {
  return { model, choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage };
}

function makeProvider({ dir = tmpDir(), create, list, env = {}, logger, sleep, random, now } = {}) {
  const config = createOpenAIConfig({ dir, env: { OPENAI_API_KEY: SECRET, ...env }, logger: logger || { error() {} } });
  const provider = createOpenAIProvider({
    HttpError,
    env: { OPENAI_API_KEY: SECRET, ...env },
    config,
    loadSdk: () => fakeSdk({ create, list: list || (() => []) }),
    logger: logger || { error() {} },
    sleep: sleep || (async () => {}),
    random: random || (() => 0.5),
    now,
  });
  return { config, provider, dir };
}

async function activate(provider, config, id = MODEL) {
  await provider.refreshModels(true);
  config.markModelVerified(id);
  config.setModelEnabled(id, true);
}

test('model discovery filters non-chat ids and honours allow/deny globs', () => {
  const list = [
    { id: 'gpt-5-mini', owned_by: 'openai' },
    { id: 'gpt-4o-2024-11-20', owned_by: 'openai' },
    { id: 'o3-mini', owned_by: 'openai' },
    { id: 'text-embedding-3-large', owned_by: 'openai' },
    { id: 'whisper-1', owned_by: 'openai' },
    { id: 'dall-e-3', owned_by: 'openai' },
    { id: 'ft:gpt-4o:acme:custom', owned_by: 'acme' },
    { id: 'not a model', owned_by: 'acme' },
  ];
  const ids = normalizeModels(list, {}).map(model => model.id);
  assert.deepStrictEqual(ids, ['gpt-5-mini', 'gpt-4o-2024-11-20', 'o3-mini', 'ft:gpt-4o:acme:custom']);
  assert.ok(isOpenAIChatModel('gpt-5'));
  assert.ok(!isOpenAIChatModel('text-embedding-3-small'));
  assert.deepStrictEqual(normalizeModels(list, { OPENAI_MODEL_ALLOW: 'gpt-5-*' }).map(m => m.id), ['gpt-5-mini']);
  assert.deepStrictEqual(normalizeModels(list, { OPENAI_MODEL_DENY: 'o3-*' }).map(m => m.id), ['gpt-5-mini', 'gpt-4o-2024-11-20', 'ft:gpt-4o:acme:custom']);
});

test('published pricing, dated snapshots and cost maths are estimated per million tokens', () => {
  assert.strictEqual(lookupMetadata('gpt-5-mini-2025-08-07').name, 'GPT-5 mini');
  assert.strictEqual(lookupMetadata('unknown-model'), null);
  const pricing = priceFor('gpt-5-mini', null);
  assert.deepStrictEqual(pricing, { inputPer1M: 0.25, outputPer1M: 2, source: 'published' });
  // 1,000,000 input tokens at $0.25 + 500,000 output at $2 = $1.25
  assert.strictEqual(costUsdFor(pricing, { inputTokens: 1000000, outputTokens: 500000 }), 1.25);
  assert.ok(Number.isNaN(costUsdFor({ inputPer1M: null, outputPer1M: null }, { inputTokens: 1, outputTokens: 1 })));
  const override = priceFor('gpt-5-mini', { pricing: { inputPer1M: 1, outputPer1M: 2 } });
  assert.deepStrictEqual(override, { inputPer1M: 1, outputPer1M: 2, source: 'override' });
});

test('a discovered model stays disabled and unverified until explicitly verified and enabled', () => {
  const state = { enabled: false, verifiedAt: null, planTier: null, pricing: null };
  const before = describeModel({ id: MODEL, name: 'GPT-5 mini' }, state, true);
  assert.strictEqual(before.available, false);
  assert.strictEqual(before.free, false);
  assert.strictEqual(before.minPlan, 'pro');
  const after = describeModel({ id: MODEL, name: 'GPT-5 mini' }, { ...state, enabled: true, verifiedAt: '2026-01-01T00:00:00.000Z' }, true);
  assert.strictEqual(after.available, true);
  assert.strictEqual(after.estimatedCosts, true);
});

test('config persists only non-secret state and enforces verification before enablement', () => {
  const dir = tmpDir();
  const config = createOpenAIConfig({ dir, env: { OPENAI_API_KEY: SECRET } });
  config.syncModels([{ id: MODEL, name: 'GPT-5 mini', ownedBy: 'openai' }]);
  assert.throws(() => config.setModelEnabled(MODEL, true), /Test this model successfully/);
  config.markModelVerified(MODEL);
  config.setModelEnabled(MODEL, true);
  config.setModelPricing(MODEL, 0.5, 2.5);
  config.setModelPlan(MODEL, 'premium');
  config.setMonthlySpendLimitUsd(5);
  assert.strictEqual(config.allowPaidFallback(), false);
  config.setAllowPaidFallback(true);
  assert.strictEqual(config.canSpendPaid(1), true);
  assert.strictEqual(config.canSpendPaid(6), false);
  config.recordUsage({ model: MODEL, usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }, costUsd: 0.002, ok: true });
  config.recordUsage({ model: MODEL, ok: false, code: 'quota_or_rate_limit', status: 429, message: 'rate limited' });
  const snapshot = config.snapshot();
  assert.strictEqual(snapshot.usage.requests, 2);
  assert.strictEqual(snapshot.usage.failures, 1);
  assert.strictEqual(snapshot.usage.totalTokens, 1500);
  assert.strictEqual(snapshot.usage.byModel[MODEL].failures, 1);
  assert.strictEqual(snapshot.spend.costUsd, 0.002);
  assert.ok(snapshot.maskedKey && snapshot.maskedKey !== SECRET);
  const onDisk = fs.readFileSync(path.join(dir, STATE_FILE), 'utf8');
  assert.ok(!onDisk.includes(SECRET), 'the API key must never be persisted');
  assert.match(onDisk, /"pricing"/);
});

test('a successful request returns text, usage and an estimated cost without leaking the key', async () => {
  const seen = [];
  const logs = [];
  const { provider, config } = makeProvider({
    create: async params => { seen.push(params); return completion(); },
    list: () => [{ id: MODEL, owned_by: 'openai' }],
    logger: { error: message => logs.push(String(message)) },
  });
  await activate(provider, config);
  const result = await provider.generate({ model: MODEL, system: 'Be brief.', history: [{ role: 'user', text: 'earlier' }, { role: 'model', text: 'answer' }], text: 'Hello' });
  assert.strictEqual(result.text, 'Hello from the mock model.');
  assert.deepStrictEqual(result.usage, { inputTokens: 9, outputTokens: 3, totalTokens: 12 });
  assert.strictEqual(result.estimated, true);
  assert.strictEqual(result.cost, Math.round(((9 * 0.25 + 3 * 2) / 1e6) * 1e8) / 1e8);
  assert.strictEqual(seen[0].messages[0].role, 'system');
  assert.deepStrictEqual(seen[0].messages.slice(1).map(m => m.role), ['user', 'assistant', 'user']);
  assert.strictEqual(seen[0].messages.at(-1).content, 'Hello');
  assert.strictEqual(config.usage().requests, 1);
  assert.strictEqual(config.usage().totalTokens, 12);
  assert.ok(!JSON.stringify(provider.status()).includes(SECRET));
  assert.ok(!JSON.stringify(logs).includes(SECRET));
  assert.strictEqual(provider.status().maskedKey.includes(SECRET), false);
});

test('a model must be enabled before it can be called', async () => {
  const { provider } = makeProvider({ create: async () => completion(), list: () => [{ id: MODEL }] });
  await provider.refreshModels(true);
  await assert.rejects(() => provider.generate({ model: MODEL, text: 'hi' }), error => error.code === 'invalid_model' && error.status === 503);
  assert.strictEqual(provider.catalogEntries()[0].available, false);
  const tested = await provider.testModel(MODEL);
  assert.strictEqual(tested.ok, true);
  // Verification alone never enables the model.
  assert.strictEqual(provider.status().models.find(m => m.id === MODEL).available, false);
});

test('429 is retried with Retry-After and then succeeds', async () => {
  let attempts = 0;
  const delays = [];
  const { provider, config } = makeProvider({
    create: async () => { attempts++; if (attempts === 1) throw sdkError(429, 'rate_limit_exceeded', 'slow down', '0.25'); return completion(); },
    list: () => [{ id: MODEL }],
    sleep: async ms => delays.push(ms),
  });
  await activate(provider, config);
  const result = await provider.generate({ model: MODEL, text: 'hi' });
  assert.strictEqual(result.text, 'Hello from the mock model.');
  assert.strictEqual(attempts, 2);
  assert.deepStrictEqual(delays, [250]);
});

test('exhausted credits map to billing_required and are never retried', async () => {
  let attempts = 0;
  const { provider, config } = makeProvider({
    create: async () => { attempts++; throw sdkError(429, 'insufficient_quota', 'You exceeded your current quota.'); },
    list: () => [{ id: MODEL }],
  });
  await activate(provider, config);
  await assert.rejects(() => provider.generate({ model: MODEL, text: 'hi' }), error => error.code === 'billing_required' && error.status === 402);
  assert.strictEqual(attempts, 1);
  assert.match(validationMessage('billing_required'), /ChatGPT subscriptions do not provide API credit/);
  assert.strictEqual(provider.status().usage.failures, 1);
});

test('invalid keys and forbidden models fail immediately with safe messages', async () => {
  let attempts = 0;
  const { provider, config } = makeProvider({
    create: async () => { attempts++; throw sdkError(401, 'invalid_api_key', 'Incorrect API key provided: ' + SECRET); },
    list: () => [{ id: MODEL }],
    logger: { error() {} },
  });
  await activate(provider, config);
  await assert.rejects(() => provider.generate({ model: MODEL, text: 'hi' }), error => {
    assert.strictEqual(error.code, 'invalid_api_key');
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
  assert.strictEqual(attempts, 1);

  const second = makeProvider({ create: async () => { throw sdkError(403, 'permission_denied', 'forbidden'); }, list: () => [{ id: MODEL }] });
  await activate(second.provider, second.config);
  await assert.rejects(() => second.provider.generate({ model: MODEL, text: 'hi' }), error => error.code === 'provider_forbidden');
});

test('timeouts, network failures and overload are retried a bounded number of times', async () => {
  let attempts = 0;
  const { provider, config } = makeProvider({
    create: async () => {
      attempts++;
      const error = new Error('Connection timed out');
      error.name = 'APIConnectionTimeoutError';
      throw error;
    },
    list: () => [{ id: MODEL }],
  });
  await activate(provider, config);
  await assert.rejects(() => provider.generate({ model: MODEL, text: 'hi' }), error => error.code === 'provider_timeout');
  assert.strictEqual(attempts, 3, 'one initial attempt plus two retries');
});

test('concurrent requests each complete and aggregate usage once', async () => {
  let counter = 0;
  const { provider, config } = makeProvider({
    create: async () => { counter++; await Promise.resolve(); return completion({ text: 'reply-' + counter, usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }); },
    list: () => [{ id: MODEL }],
  });
  await activate(provider, config);
  const results = await Promise.all([
    provider.generate({ model: MODEL, text: 'one' }),
    provider.generate({ model: MODEL, text: 'two' }),
    provider.generate({ model: MODEL, text: 'three' }),
  ]);
  assert.strictEqual(results.length, 3);
  assert.ok(results.every(result => /^reply-/.test(result.text)));
  assert.strictEqual(config.usage().requests, 3);
  assert.strictEqual(config.usage().totalTokens, 12);
});

test('streaming reports deltas, usage and a cost estimate', async () => {
  const chunks = [
    { model: MODEL, choices: [{ delta: { content: 'Hel' } }] },
    { model: MODEL, choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
    { model: MODEL, choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
  ];
  const { provider, config } = makeProvider({
    create: async () => (async function* generator() { for (const chunk of chunks) yield chunk; })(),
    list: () => [{ id: MODEL }],
  });
  await activate(provider, config);
  const events = [];
  for await (const event of provider.streamGenerate({ model: MODEL, text: 'hi' })) events.push(event);
  assert.deepStrictEqual(events.filter(e => e.type === 'delta').map(e => e.text), ['Hel', 'lo']);
  const done = events.find(e => e.type === 'done');
  assert.strictEqual(done.text, 'Hello');
  assert.strictEqual(done.usage.totalTokens, 6);
  assert.strictEqual(done.estimated, true);
  assert.ok(done.cost > 0);
});

test('connection checks report validation state and never leak the key', async () => {
  const { provider } = makeProvider({ create: async () => completion(), list: () => [{ id: MODEL }] });
  const ok = await provider.testConnection();
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.modelCount, 1);
  assert.ok(!JSON.stringify(ok).includes(SECRET));

  const bad = makeProvider({ create: async () => completion(), list: () => { throw sdkError(401, 'invalid_api_key', 'bad key ' + SECRET); } });
  const failed = await bad.provider.testConnection();
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.code, 'invalid_api_key');
  assert.ok(!JSON.stringify(failed).includes(SECRET));
  assert.strictEqual(bad.provider.status().validated, false);
});

test('without OPENAI_API_KEY nothing is advertised and calls fail cleanly', async () => {
  const dir = tmpDir();
  const config = createOpenAIConfig({ dir, env: {} });
  const provider = createOpenAIProvider({ HttpError, env: {}, config, loadSdk: () => { throw new Error('must not load'); } });
  const entry = provider.catalogEntries()[0];
  assert.strictEqual(entry.configured, false);
  assert.strictEqual(entry.available, false);
  assert.strictEqual(entry.free, false);
  assert.match(entry.reason, /not configured/);
  assert.strictEqual(provider.status().configured, false);
  await assert.rejects(() => provider.generate({ model: MODEL, text: 'hi' }), error => error.code === 'provider_not_configured');
});

test('fallback policy chooses free/local destinations first and never silently spends', () => {
  assert.ok(fallbackEligible('provider_unavailable'));
  assert.ok(fallbackEligible('invalid_model'));
  assert.ok(!fallbackEligible('billing_required'));
  assert.ok(!fallbackEligible('invalid_api_key'));
  assert.ok(!fallbackEligible('quota_or_rate_limit'));
  assert.ok(!fallbackEligible('request_aborted'));

  const primary = { id: 'gpt-5-mini' };
  const paid = { id: 'claude-paid', provider: 'Anthropic', available: true, capabilities: { text: true } };
  const openaiPaid = { id: 'gpt-5', provider: 'OpenAI', available: true, capabilities: { text: true, vision: true } };
  const free = { id: 'vendor/free:free', provider: 'OpenRouter', available: true, free: true, capabilities: { text: true } };
  const local = { id: 'gemma3:4b', provider: 'Ollama', available: true, local: true, free: true, capabilities: { text: true } };
  assert.ok(isFreeDestination(free));
  assert.ok(isFreeDestination(local));
  assert.ok(isPaidDestination(openaiPaid));
  assert.ok(!isPaidDestination(free));

  const chosen = chooseFallback({ failureCode: 'provider_unavailable', primary, candidates: [openaiPaid, free, local], planId: 'basic' });
  assert.strictEqual(chosen.option.id, free.id);
  assert.strictEqual(chosen.paid, false);

  // With only paid candidates and no explicit opt-in there is no fallback at all.
  assert.strictEqual(chooseFallback({ failureCode: 'provider_unavailable', primary, candidates: [openaiPaid], planId: 'pro', policy: {} }), null);
  assert.strictEqual(chooseFallback({ failureCode: 'provider_unavailable', primary, candidates: [openaiPaid], planId: 'pro', policy: { allowPaid: () => true, paidBudgetOk: () => false } }), null);
  const paidChoice = chooseFallback({ failureCode: 'provider_unavailable', primary, candidates: [openaiPaid], planId: 'pro', policy: { allowPaid: () => true, paidBudgetOk: () => true } });
  assert.strictEqual(paidChoice.option.id, openaiPaid.id);
  assert.strictEqual(paidChoice.paid, true);

  // Plan gating and attachments are respected.
  assert.strictEqual(chooseFallback({ failureCode: 'provider_unavailable', primary, candidates: [openaiPaid], planId: 'basic', policy: { planAllows: () => false } }), null);
  const needs = capabilityNeeds([{ name: 'photo.png', mimeType: 'image/png', kind: 'inline' }]);
  assert.deepStrictEqual(needs, { requiresVision: true, requiresPdf: false });
  assert.strictEqual(chooseFallback({ failureCode: 'provider_unavailable', primary: { id: 'gemini-x' }, candidates: [free], context: { attachments: [{ name: 'photo.png', mimeType: 'image/png', kind: 'inline' }] } }), null);
  assert.strictEqual(chooseFallback({ failureCode: 'billing_required', primary, candidates: [free], planId: 'basic' }), null);
});

test('Ollama discovery, generation and failures are handled without any key', async () => {
  const requests = [];
  const models = [
    { name: 'gemma3:4b', details: { family: 'gemma', parameter_size: '4B' } },
    { name: 'glm-5.3-flash:cloud', details: { family: 'glm' } },
    { name: 'remote-model', remote_host: 'https://ollama.example' },
  ];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models }) };
    if (url.endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({ model: 'gemma3:4b', message: { role: 'assistant', content: 'local answer' }, prompt_eval_count: 5, eval_count: 2, done: true }) };
    throw new Error('unexpected URL ' + url);
  };
  const ollama = createOllamaProvider({ HttpError, env: {}, fetchImpl, logger: { error() {} } });
  await ollama.refreshModels();
  // Ollama cloud models need a separate account and are neither local nor free, so they are hidden.
  assert.deepStrictEqual(ollama.catalogEntries().map(item => item.id), ['gemma3:4b']);
  const entry = ollama.catalogEntries()[0];
  assert.strictEqual(entry.id, 'gemma3:4b');
  assert.strictEqual(entry.free, true);
  assert.strictEqual(entry.local, true);
  assert.strictEqual(entry.available, true);
  const result = await ollama.generate({ model: 'gemma3:4b', text: 'hello' });
  assert.strictEqual(result.text, 'local answer');
  assert.deepStrictEqual(result.usage, { inputTokens: 5, outputTokens: 2, totalTokens: 7, cost: 0 });
  assert.strictEqual(result.cost, 0);
  assert.strictEqual(result.free, true);
  assert.ok(!requests.some(request => request.options && request.options.headers && request.options.headers.Authorization));

  const offline = createOllamaProvider({
    HttpError,
    env: { OLLAMA_BASE_URL: 'http://127.0.0.1:9' },
    fetchImpl: async () => { const error = new Error('fetch failed'); error.code = 'ECONNREFUSED'; throw error; },
    logger: { error() {} },
  });
  await offline.refreshModels(true);
  assert.strictEqual(offline.status().connected, false);
  assert.strictEqual(offline.catalogEntries()[0].available, false);
  assert.match(offline.catalogEntries()[0].reason, /No local Ollama server responded/);
});
