'use strict';
// NVIDIA NIM provider — unit tests (100% mocked, no real API calls, no credits consumed).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
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
      headers: {
        get: k => headers[k.toLowerCase()] || null,
        ...headers,
      },
      json: async () => body,
      body: resp.bodyStream || null,
    };
  };
}

function makeSseStream(lines) {
  const encoder = new TextEncoder();
  const chunks = lines.map(l => encoder.encode(l + '\n'));
  let idx = 0;
  const reader = {
    read: async () => (idx < chunks.length ? { done: false, value: chunks[idx++] } : { done: true, value: undefined }),
    releaseLock: () => {},
  };
  return { getReader: () => reader };
}

describe('nvidia-config', () => {
  const { createNvidiaConfig, readEnvKey, maskKey, isNvidiaChatModel } = require('../nvidia-config');

  it('readEnvKey returns trimmed key or null', () => {
    assert.equal(readEnvKey({}), null);
    assert.equal(readEnvKey({ NVIDIA_API_KEY: '' }), null);
    assert.equal(readEnvKey({ NVIDIA_API_KEY: '  ' }), null);
    assert.equal(readEnvKey({ NVIDIA_API_KEY: 'nvapi-test123' }), 'nvapi-test123');
  });

  it('maskKey hides secret parts', () => {
    const masked = maskKey('nvapi-1234567890abcdef123456');
    assert.ok(masked.startsWith('nvapi-'));
    assert.ok(masked.includes('•'));
    assert.ok(!masked.includes('abcdef'));
    assert.equal(maskKey(''), '••••');
  });

  it('isNvidiaChatModel filters embedding/audio/image models', () => {
    assert.equal(isNvidiaChatModel('meta/llama-3.3-70b-instruct'), true);
    assert.equal(isNvidiaChatModel('nvidia/llama-3.1-nemotron-70b-instruct'), true);
    assert.equal(isNvidiaChatModel('nvidia/nv-embedqa-e5-v5'), false);
    assert.equal(isNvidiaChatModel('nvidia/nv-rerankqa-mistral-4b-v3'), false);
    assert.equal(isNvidiaChatModel('stabilityai/sdxl-turbo'), false);
    assert.equal(isNvidiaChatModel(''), false);
  });

  it('saves and tracks usage/errors cleanly in temp directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-cfg-'));
    try {
      const cfg = createNvidiaConfig({ dir: tmpDir, env: {} });
      assert.equal(cfg.isEnabled(), true);
      assert.equal(cfg.getSpendingPolicy(), 'allow_free_only');

      cfg.setSpendingPolicy('block');
      assert.equal(cfg.getSpendingPolicy(), 'block');

      cfg.setEnabled(false);
      assert.equal(cfg.isEnabled(), false);

      cfg.recordUsage({ model: 'meta/llama-3.3-70b-instruct', ok: true, inputTokens: 60, outputTokens: 40 });
      const snap = cfg.snapshot();
      assert.equal(snap.usage.requests, 1);
      assert.equal(snap.usage.inputTokens, 60);
      assert.equal(snap.usage.outputTokens, 40);
      assert.equal(snap.usage.totalTokens, 100);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('nvidia-provider', () => {
  const { createNvidiaConfig } = require('../nvidia-config');
  const { createNvidiaProvider } = require('../nvidia-provider');
  const quiet = { log() {}, error() {}, warn() {} };
  const noopSleep = async () => {};

  it('missing key -> configured() is false and testConnection fails safely', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-prov-'));
    try {
      const cfg = createNvidiaConfig({ dir: tmpDir, env: {} });
      const nv = createNvidiaProvider({ HttpError, env: {}, config: cfg, logger: quiet, sleep: noopSleep });
      assert.equal(nv.configured(), false);
      const conn = await nv.testConnection();
      assert.equal(conn.ok, false);
      assert.equal(conn.code, 'not_configured');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('valid key -> testConnection discovers chat models and masks key in status()', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-prov-'));
    const secret = 'nvapi-SECRETKEYVALUE1234567890ABCDEF';
    try {
      const env = { NVIDIA_API_KEY: secret };
      const cfg = createNvidiaConfig({ dir: tmpDir, env });
      const fetchImpl = makeFetch([
        {
          status: 200,
          body: {
            data: [
              { id: 'meta/llama-3.3-70b-instruct', owned_by: 'meta', created: 1700000000 },
              { id: 'nvidia/nv-embedqa-e5-v5', owned_by: 'nvidia', created: 1700000001 },
            ],
          },
        },
      ]);
      const nv = createNvidiaProvider({ HttpError, env, config: cfg, fetchImpl, logger: quiet, sleep: noopSleep });
      const res = await nv.testConnection();
      assert.equal(res.ok, true);
      assert.equal(res.modelCount, 1);

      const st = nv.status();
      assert.equal(st.configured, true);
      assert.equal(st.modelCount, 1);
      assert.ok(!JSON.stringify(st).includes(secret));
      assert.ok(st.maskedKey.startsWith('nvapi-'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('invalid key (401) -> maps to invalid_api_key without leaking key', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-prov-'));
    const secret = 'nvapi-INVALIDKEYLEAKCHECK12345678';
    try {
      const env = { NVIDIA_API_KEY: secret };
      const cfg = createNvidiaConfig({ dir: tmpDir, env });
      const fetchImpl = makeFetch([
        { status: 401, body: { error: { message: `Invalid key ${secret}` } } },
      ]);
      const nv = createNvidiaProvider({ HttpError, env, config: cfg, fetchImpl, logger: quiet, sleep: noopSleep });
      const conn = await nv.testConnection();
      assert.equal(conn.ok, false);
      assert.equal(conn.code, 'invalid_api_key');
      assert.ok(!conn.message.includes(secret));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('zero-billing enforcement blocks requests when spendingPolicy is block', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-prov-'));
    try {
      const env = { NVIDIA_API_KEY: 'nvapi-validkey1234567890' };
      const cfg = createNvidiaConfig({ dir: tmpDir, env });
      cfg.setSpendingPolicy('block');
      let called = false;
      const nv = createNvidiaProvider({
        HttpError,
        env,
        config: cfg,
        fetchImpl: async () => { called = true; throw new Error('Should not be called'); },
        logger: quiet,
        sleep: noopSleep,
      });
      await assert.rejects(
        nv.generate({ model: 'meta/llama-3.3-70b-instruct', text: 'hi' }),
        err => err.code === 'billing_blocked'
      );
      assert.equal(called, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('generate() sends OpenAI payload with English instruction and tracks tokens', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-prov-'));
    try {
      const env = { NVIDIA_API_KEY: 'nvapi-validkey1234567890' };
      const cfg = createNvidiaConfig({ dir: tmpDir, env });
      let capturedPayload = null;
      const fetchImpl = async (url, opts) => {
        capturedPayload = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            model: 'meta/llama-3.3-70b-instruct',
            choices: [{ message: { content: 'Hello from NVIDIA NIM!' } }],
            usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
          }),
        };
      };
      const nv = createNvidiaProvider({ HttpError, env, config: cfg, fetchImpl, logger: quiet, sleep: noopSleep });
      const res = await nv.generate({ model: 'meta/llama-3.3-70b-instruct', text: 'hello' });
      assert.equal(res.text, 'Hello from NVIDIA NIM!');
      assert.equal(res.usage.totalTokens, 28);
      assert.ok(capturedPayload.messages[0].content.includes('English'));
      assert.equal(nv.status().usage.totalTokens, 28);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('streamGenerate() yields delta chunks and done event', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-prov-'));
    try {
      const env = { NVIDIA_API_KEY: 'nvapi-validkey1234567890' };
      const cfg = createNvidiaConfig({ dir: tmpDir, env });
      const sse = makeSseStream([
        'data: {"choices":[{"delta":{"content":"Hello "}}]}',
        'data: {"choices":[{"delta":{"content":"NVIDIA"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
        'data: [DONE]',
      ]);
      const fetchImpl = makeFetch([{ status: 200, bodyStream: sse }]);
      const nv = createNvidiaProvider({ HttpError, env, config: cfg, fetchImpl, logger: quiet, sleep: noopSleep });
      const events = [];
      for await (const ev of nv.streamGenerate({ model: 'meta/llama-3.3-70b-instruct', text: 'hi' })) {
        events.push(ev);
      }
      assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), 'Hello NVIDIA');
      const done = events.find(e => e.type === 'done');
      assert.equal(done.text, 'Hello NVIDIA');
      assert.equal(done.usage.totalTokens, 12);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('maps 429, 403, 404, 5xx, and timeouts safely', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-prov-'));
    try {
      const env = { NVIDIA_API_KEY: 'nvapi-validkey1234567890' };
      const cfg = createNvidiaConfig({ dir: tmpDir, env });
      const nv = createNvidiaProvider({ HttpError, env, config: cfg, logger: quiet, sleep: noopSleep });

      assert.equal(nv.mapError({ status: 400, error: { message: 'bad request' } }).code, 'invalid_request');
      assert.equal(nv.mapError({ status: 401 }).code, 'invalid_api_key');
      assert.equal(nv.mapError({ status: 402 }).code, 'billing_required');
      assert.equal(nv.mapError({ status: 403 }).code, 'provider_forbidden');
      assert.equal(nv.mapError({ status: 404 }).code, 'invalid_model');
      assert.equal(nv.mapError({ status: 429 }).code, 'quota_or_rate_limit');
      assert.equal(nv.mapError({ status: 500 }).code, 'provider_unavailable');
      assert.equal(nv.mapError({ status: 503 }).code, 'provider_overloaded');
      assert.equal(nv.mapError({ name: 'TimeoutError' }).code, 'provider_timeout');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('profile models section UI helpers', () => {
  it('selects 5 featured NVIDIA models, deduplicates catalogue, shows verified pricing only, and preserves Recent Activity', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(html.includes('id="models"'), 'existing Models section card is present');
    assert.ok(html.includes('data-view-all-models'), 'View All models button is present');
    assert.ok(html.includes('id="activity"'), 'Recent Activity card is preserved');
    assert.ok(html.includes('function showAllActivity()'), 'Recent Activity modal is preserved');

    const fnMatch = html.match(/function profileModelIcon[\s\S]*?function profileModelRowMarkup\([\s\S]*?\n/);
    assert.ok(fnMatch, 'model helper functions found in index.html');
    const vm = require('node:vm');
    const ctx = {
      esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      profileEscape: v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    };
    vm.runInNewContext(fnMatch[0], ctx);

    const sample = [
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B', provider: 'NVIDIA', available: true, configured: true, free: true, pricingVerified: true, description: 'Reasoning & chat · 131k context' },
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B Duplicate', provider: 'NVIDIA', available: true, configured: true, free: true, pricingVerified: true },
      { id: 'meta/llama-3.2-90b-vision-instruct', name: 'Llama 3.2 90B Vision', provider: 'NVIDIA', available: true, configured: true, free: true, pricingVerified: true },
      { id: 'mistralai/mistral-large-2-instruct', name: 'Mistral Large 2', provider: 'NVIDIA', available: true, configured: true, free: true, pricingVerified: true },
      { id: 'deepseek-ai/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', provider: 'NVIDIA', available: true, configured: true, free: true, pricingVerified: true },
      { id: '01-ai/yi-large', name: 'Yi Large', provider: 'NVIDIA', available: true, configured: true, free: true, pricingVerified: true },
      { id: 'allam-2-7b', name: 'ALLaM 2 7B', provider: 'Groq', available: true, configured: true, free: true, pricingVerified: true },
      { id: 'openai', name: 'OpenAI GPT', provider: 'OpenAI', available: false, configured: false, free: false, pricingVerified: false },
    ];

    const catalog = ctx.profileModelCatalog(sample);
    assert.equal(catalog.length, 6, 'deduplicates duplicate entries and excludes unavailable unconfigured models');

    const featured = ctx.featuredProfileModels(sample);
    assert.equal(featured.length, 5, 'shows exactly 5 featured models');
    assert.ok(featured.every(m => m.provider === 'NVIDIA'), 'all 5 featured models are from NVIDIA when 5 are available');

    const rowVerified = ctx.profileModelRowMarkup(sample[0], 'nvidia/llama-3.1-nemotron-70b-instruct', 'basic');
    assert.ok(rowVerified.includes('Free') && rowVerified.includes('Default') && rowVerified.includes('Nemotron 70B'));
    const rowUnverified = ctx.profileModelRowMarkup({ id: 'custom-m', name: 'Custom', provider: 'Other', available: true, free: false, pricingVerified: false }, '', 'pro');
    assert.ok(!rowUnverified.includes('>Free<') && !rowUnverified.includes('>Paid<'), 'does not display Free/Paid badge when pricingVerified is false');
  });
});
