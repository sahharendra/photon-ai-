'use strict';
// CodeCraft provider — unit tests (all mocked, no real API calls, no credits consumed).
const { describe, it, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ── Helpers ──────────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function makeFetch(responses) {
  let idx = 0;
  return async (url, opts) => {
    const resp = responses[idx++] || responses[responses.length - 1];
    if (resp instanceof Error) throw resp;
    const { status = 200, body = {}, headers = {} } = resp;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers[k.toLowerCase()] || null },
      json: async () => body,
      body: null,
    };
  };
}

// Builds a fake SSE ReadableStream from an array of SSE lines.
function makeSseStream(lines) {
  const encoder = new TextEncoder();
  const chunks = lines.map(l => encoder.encode(l + '\n'));
  let idx = 0;
  const reader = {
    read: async () => idx < chunks.length ? { done: false, value: chunks[idx++] } : { done: true, value: undefined },
    releaseLock: () => {},
  };
  return { getReader: () => reader };
}

function modelsResp(ids) {
  return { status: 200, body: { data: ids.map(id => ({ id, name: id, owned_by: 'codecraft', pricing: { prompt: '0', completion: '0' } })) } };
}
function chatResp(text) {
  return { status: 200, body: { id: 'x', choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }, model: 'cc-model' } };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('codecraft-config', () => {
  const { createCodeCraftConfig, readEnvKey, maskKey, isModelFree } = require('../codecraft-config');

  it('readEnvKey returns null when no key', () => {
    assert.equal(readEnvKey({}), null);
    assert.equal(readEnvKey({ CODECRAFT_API_KEY: '' }), null);
    assert.equal(readEnvKey({ CODECRAFT_API_KEY: '  ' }), null);
  });

  it('readEnvKey returns trimmed key when present', () => {
    assert.equal(readEnvKey({ CODECRAFT_API_KEY: 'sk-abc123' }), 'sk-abc123');
    assert.equal(readEnvKey({ CODECRAFT_API_KEY: '  sk-abc123  ' }), 'sk-abc123');
  });

  it('maskKey never returns the full secret', () => {
    const secret = 'sk-secretkey1234567890';
    const masked = maskKey(secret);
    assert.ok(!masked.includes(secret), 'maskKey must not include full secret');
    assert.ok(masked.includes('•'), 'maskKey must include masking characters');
    assert.ok(masked.length <= 16, 'masked key must be short');
  });

  it('isModelFree returns true when no pricing', () => {
    assert.ok(isModelFree({ id: 'x' }));
    assert.ok(isModelFree({ id: 'x', pricing: null }));
  });

  it('isModelFree returns true when prompt=0 and completion=0', () => {
    assert.ok(isModelFree({ pricing: { prompt: '0', completion: '0' } }));
    assert.ok(isModelFree({ pricing: { prompt: 0, completion: 0 } }));
  });

  it('isModelFree returns false for paid model', () => {
    assert.ok(!isModelFree({ pricing: { prompt: '0.0001', completion: '0.0002' } }));
  });

  it('default spending policy is block', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    assert.equal(cfg.spendingPolicy(), 'block');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('default enabled state is false', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    assert.equal(cfg.isEnabled(), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('setEnabled persists to disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    cfg.setEnabled(true);
    assert.ok(cfg.isEnabled());
    // Reload from disk.
    const cfg2 = createCodeCraftConfig({ dir, env: {} });
    assert.ok(cfg2.isEnabled());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('setSpendingPolicy rejects invalid value', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    assert.throws(() => cfg.setSpendingPolicy('unlimited'), { code: 'invalid_spending_policy' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('view() never includes the raw API key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: { CODECRAFT_API_KEY: 'sk-supersecret' } });
    const v = cfg.view({ CODECRAFT_API_KEY: 'sk-supersecret' });
    const json = JSON.stringify(v);
    assert.ok(!json.includes('sk-supersecret'), 'view() must not expose raw API key');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('codecraft-provider: configured()', () => {
  const { createCodeCraftProvider } = require('../codecraft-provider');
  const { createCodeCraftConfig } = require('../codecraft-config');

  it('returns false with no key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    cfg.setEnabled(true); cfg.setSpendingPolicy('allow_free_only');
    const p = createCodeCraftProvider({ HttpError, env: {}, fetchImpl: makeFetch([]), config: cfg });
    assert.equal(p.configured(), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns true when key is set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    const p = createCodeCraftProvider({ HttpError, env: { CODECRAFT_API_KEY: 'sk-test' }, fetchImpl: makeFetch([]), config: cfg });
    assert.equal(p.configured(), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('codecraft-provider: status() key security', () => {
  const { createCodeCraftProvider } = require('../codecraft-provider');
  const { createCodeCraftConfig } = require('../codecraft-config');

  it('status() never contains the raw API key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const secret = 'sk-mycraftsecretkey99';
    const cfg = createCodeCraftConfig({ dir, env: {} });
    const p = createCodeCraftProvider({ HttpError, env: { CODECRAFT_API_KEY: secret }, fetchImpl: makeFetch([]), config: cfg });
    const st = p.status();
    const json = JSON.stringify(st);
    assert.ok(!json.includes(secret), 'status() must not expose raw API key');
    assert.ok(st.maskedKey && st.maskedKey.includes('•'), 'maskedKey must contain masking characters');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('codecraft-provider: testConnection()', () => {
  const { createCodeCraftProvider } = require('../codecraft-provider');
  const { createCodeCraftConfig } = require('../codecraft-config');

  it('returns ok with valid key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    const fetch = makeFetch([modelsResp(['model-a', 'model-b'])]);
    const p = createCodeCraftProvider({ HttpError, env: { CODECRAFT_API_KEY: 'sk-valid' }, fetchImpl: fetch, config: cfg });
    const result = await p.testConnection();
    assert.equal(result.ok, true);
    assert.equal(result.modelCount, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns invalid_api_key on 401', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    const fetch = makeFetch([{ status: 401, body: { error: { message: 'Unauthorized' } } }]);
    const p = createCodeCraftProvider({ HttpError, env: { CODECRAFT_API_KEY: 'sk-bad' }, fetchImpl: fetch, config: cfg });
    const result = await p.testConnection();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_api_key');
    // Key must NOT appear in the message.
    assert.ok(!result.message.includes('sk-bad'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns not_configured when no key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    const p = createCodeCraftProvider({ HttpError, env: {}, fetchImpl: makeFetch([]), config: cfg });
    const result = await p.testConnection();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_configured');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('codecraft-provider: zero-billing enforcement', () => {
  const { createCodeCraftProvider } = require('../codecraft-provider');
  const { createCodeCraftConfig } = require('../codecraft-config');

  it('blocks generate() when spendingPolicy is block (default)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    cfg.setEnabled(true);
    // spendingPolicy defaults to 'block' — do NOT change it.
    const fetch = makeFetch([chatResp('hello')]);
    const p = createCodeCraftProvider({ HttpError, env: { CODECRAFT_API_KEY: 'sk-valid' }, fetchImpl: fetch, config: cfg });
    await assert.rejects(() => p.generate({ model: 'cc-model', text: 'hi' }), { code: 'billing_blocked' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('allows generate() when spendingPolicy is allow_free_only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    cfg.setEnabled(true);
    cfg.setSpendingPolicy('allow_free_only');
    const fetch = makeFetch([chatResp('hello')]);
    const p = createCodeCraftProvider({ HttpError, env: { CODECRAFT_API_KEY: 'sk-valid' }, fetchImpl: fetch, config: cfg });
    const result = await p.generate({ model: 'cc-model', text: 'hi' });
    assert.equal(result.text, 'hello');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('blocks generate() when provider is disabled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    cfg.setEnabled(false);
    cfg.setSpendingPolicy('allow_free_only');
    const fetch = makeFetch([chatResp('hello')]);
    const p = createCodeCraftProvider({ HttpError, env: { CODECRAFT_API_KEY: 'sk-valid' }, fetchImpl: fetch, config: cfg });
    await assert.rejects(() => p.generate({ model: 'cc-model', text: 'hi' }), { code: 'provider_disabled' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('codecraft-provider: generate() error handling', () => {
  const { createCodeCraftProvider } = require('../codecraft-provider');
  const { createCodeCraftConfig } = require('../codecraft-config');

  function makeProvider(fetchResponses, dir) {
    const cfg = createCodeCraftConfig({ dir, env: {} });
    cfg.setEnabled(true);
    cfg.setSpendingPolicy('allow_free_only');
    return createCodeCraftProvider({
      HttpError,
      env: { CODECRAFT_API_KEY: 'sk-valid' },
      fetchImpl: makeFetch(fetchResponses),
      config: cfg,
      sleep: async () => {},  // no actual delay in tests
      random: () => 0,
    });
  }

  it('returns text on 200', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const p = makeProvider([chatResp('Great answer!')], dir);
    const result = await p.generate({ model: 'cc-model', text: 'question' });
    assert.equal(result.text, 'Great answer!');
    assert.ok(result.usage);
    assert.equal(result.usage.totalTokens, 8);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws invalid_api_key on 401 — not retried', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    // Three 401 responses; we should still only make ONE attempt.
    const responses = Array(3).fill({ status: 401, body: { error: { message: 'Unauthorized' } } });
    const fetched = [];
    const fetchSpy = async (url, opts) => { fetched.push(url); return makeFetch(responses)(url, opts); };
    const cfg = createCodeCraftConfig({ dir, env: {} });
    cfg.setEnabled(true); cfg.setSpendingPolicy('allow_free_only');
    const p = createCodeCraftProvider({ HttpError, env: { CODECRAFT_API_KEY: 'sk-bad' }, fetchImpl: fetchSpy, config: cfg, sleep: async () => {} });
    await assert.rejects(() => p.generate({ model: 'cc-model', text: 'q' }), { code: 'invalid_api_key' });
    assert.equal(fetched.length, 1, '401 must not be retried');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('retries on 429 (rate limit) with backoff', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const p = makeProvider([
      { status: 429, body: { error: { type: 'rate_limit_exceeded' } } },
      { status: 429, body: { error: { type: 'rate_limit_exceeded' } } },
      chatResp('ok'),
    ], dir);
    const result = await p.generate({ model: 'cc-model', text: 'hi' });
    assert.equal(result.text, 'ok');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws billing_required on 402 — not retried', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const p = makeProvider([{ status: 402, body: { error: { message: 'No credits' } } }], dir);
    await assert.rejects(() => p.generate({ model: 'cc-model', text: 'q' }), { code: 'billing_required' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws network_error on fetch TypeError', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const p = makeProvider([Object.assign(new TypeError('fetch failed'), { name: 'TypeError' })], dir);
    await assert.rejects(() => p.generate({ model: 'cc-model', text: 'q' }), { code: 'network_error' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws provider_timeout on AbortError', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const p = makeProvider([Object.assign(new Error('aborted'), { name: 'AbortError' })], dir);
    await assert.rejects(() => p.generate({ model: 'cc-model', text: 'q' }), { code: 'provider_timeout' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws provider_unavailable on 503', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    // 3 attempts (initial + 2 retries) all return 503.
    const p = makeProvider([
      { status: 503, body: {} },
      { status: 503, body: {} },
      { status: 503, body: {} },
    ], dir);
    await assert.rejects(() => p.generate({ model: 'cc-model', text: 'q' }), { code: 'provider_unavailable' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('error messages do not contain the raw API key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const secret = 'sk-secretkeyabc';
    const cfg = createCodeCraftConfig({ dir, env: {} });
    cfg.setEnabled(true); cfg.setSpendingPolicy('allow_free_only');
    const p = createCodeCraftProvider({
      HttpError, env: { CODECRAFT_API_KEY: secret },
      fetchImpl: makeFetch([{ status: 401, body: { error: { message: 'Invalid key' } } }]),
      config: cfg, sleep: async () => {},
    });
    try { await p.generate({ model: 'cc-model', text: 'q' }); }
    catch (err) {
      assert.ok(!JSON.stringify(err).includes(secret), 'error must not contain raw key');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('codecraft-provider: streaming', () => {
  const { createCodeCraftProvider } = require('../codecraft-provider');
  const { createCodeCraftConfig } = require('../codecraft-config');

  it('yields delta events and a done event', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    cfg.setEnabled(true); cfg.setSpendingPolicy('allow_free_only');

    const sseLines = [
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":" World"},"finish_reason":"stop"}]}',
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
      'data: [DONE]',
    ];
    const sseStream = makeSseStream(sseLines);

    const fetchImpl = async () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({}),
      body: sseStream,
    });

    const p = createCodeCraftProvider({ HttpError, env: { CODECRAFT_API_KEY: 'sk-valid' }, fetchImpl, config: cfg });
    const events = [];
    for await (const event of p.streamGenerate({ model: 'cc-model', text: 'hi' })) events.push(event);

    const deltas = events.filter(e => e.type === 'delta');
    const done = events.find(e => e.type === 'done');
    assert.ok(deltas.length >= 1, 'must have delta events');
    assert.ok(done, 'must have done event');
    assert.equal(done.text, 'Hello World');
    assert.equal(done.usage.totalTokens, 7);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throws billing_blocked on stream when policy is block', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    cfg.setEnabled(true);
    // spending policy is 'block' (default)
    const p = createCodeCraftProvider({ HttpError, env: { CODECRAFT_API_KEY: 'sk-valid' }, fetchImpl: makeFetch([]), config: cfg });
    const gen = p.streamGenerate({ model: 'cc-model', text: 'hi' });
    await assert.rejects(async () => { for await (const _ of gen) {} }, { code: 'billing_blocked' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('codecraft-provider: model discovery', () => {
  const { createCodeCraftProvider } = require('../codecraft-provider');
  const { createCodeCraftConfig } = require('../codecraft-config');

  it('refreshModels() populates model list from API', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    const fetch = makeFetch([modelsResp(['model-x', 'model-y', 'model-z'])]);
    const p = createCodeCraftProvider({ HttpError, env: { CODECRAFT_API_KEY: 'sk-valid' }, fetchImpl: fetch, config: cfg });
    await p.refreshModels(true);
    const st = p.status();
    assert.equal(st.modelCount, 3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refreshModels() uses cache within TTL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    let callCount = 0;
    const fetchImpl = async (url) => { callCount++; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: [{ id: 'model-a', name: 'Model A', owned_by: 'cc', pricing: { prompt: '0', completion: '0' } }] }), body: null }; };
    const p = createCodeCraftProvider({ HttpError, env: { CODECRAFT_API_KEY: 'sk-valid' }, fetchImpl, config: cfg });
    await p.refreshModels();
    await p.refreshModels(); // should use cache
    assert.equal(callCount, 1, 'second call must use cache');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('codecraft-provider: token accounting', () => {
  const { createCodeCraftProvider } = require('../codecraft-provider');
  const { createCodeCraftConfig } = require('../codecraft-config');

  it('records usage counters after successful generate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    cfg.setEnabled(true); cfg.setSpendingPolicy('allow_free_only');
    const fetch = makeFetch([chatResp('hello')]);
    const p = createCodeCraftProvider({ HttpError, env: { CODECRAFT_API_KEY: 'sk-valid' }, fetchImpl: fetch, config: cfg });
    await p.generate({ model: 'cc-model', text: 'q' });
    const st = p.status();
    assert.equal(st.usage.requests, 1);
    assert.equal(st.usage.inputTokens, 5);
    assert.equal(st.usage.outputTokens, 3);
    assert.equal(st.usage.totalTokens, 8);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records failure counter after failed generate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const cfg = createCodeCraftConfig({ dir, env: {} });
    cfg.setEnabled(true); cfg.setSpendingPolicy('allow_free_only');
    const fetch = makeFetch([{ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }]);
    const p = createCodeCraftProvider({ HttpError, env: { CODECRAFT_API_KEY: 'sk-valid' }, fetchImpl: fetch, config: cfg, sleep: async () => {} });
    try { await p.generate({ model: 'cc-model', text: 'q' }); } catch {}
    const st = p.status();
    assert.ok(st.usage.failures > 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('codecraft-provider: fallback eligibility', () => {
  const { chooseFallback } = require('../provider-fallback');

  it('codecraft is eligible for fallback on provider_unavailable', () => {
    const result = chooseFallback({
      failureCode: 'provider_unavailable',
      primary: { id: 'gemini-2.0-flash' },
      candidates: [{ id: 'cc-model', provider: 'CodeCraft', available: true, free: true, capabilities: { text: true, vision: false, pdf: false } }],
      planId: 'basic',
      policy: { planAllows: () => true, allowPaid: () => false, paidBudgetOk: () => false },
    });
    assert.ok(result !== null, 'codecraft should be a valid fallback');
    assert.equal(result.option.provider, 'CodeCraft');
  });

  it('no fallback on invalid_api_key (non-eligible code)', () => {
    const result = chooseFallback({
      failureCode: 'invalid_api_key',
      primary: { id: 'gemini-2.0-flash' },
      candidates: [{ id: 'cc-model', provider: 'CodeCraft', available: true, free: true }],
      planId: 'basic',
      policy: { planAllows: () => true, allowPaid: () => false, paidBudgetOk: () => false },
    });
    assert.equal(result, null);
  });
});
