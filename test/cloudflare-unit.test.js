'use strict';
// Cloudflare Workers AI provider — unit tests (100% mocked, no real API calls, zero credits/neurons consumed).
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

describe('cloudflare-config', () => {
  const {
    createCloudflareConfig,
    readEnvCredentials,
    maskAccountId,
    maskToken,
    isCloudflareChatModel,
    getUtcDayKey,
  } = require('../cloudflare-config');

  it('readEnvCredentials returns trimmed credentials or null', () => {
    assert.deepEqual(readEnvCredentials({}), { accountId: null, apiToken: null, apiToken2: null });
    assert.deepEqual(readEnvCredentials({ CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: ' ', CLOUDFLARE_API_TOKEN_2: ' ' }), { accountId: null, apiToken: null, apiToken2: null });
    assert.deepEqual(
      readEnvCredentials({
        CLOUDFLARE_ACCOUNT_ID: 'abc1234567890def1234567890abcdef',
        CLOUDFLARE_API_TOKEN: 'cf_tok_secret_9988',
        CLOUDFLARE_API_TOKEN_2: 'cf_img_tok_5566',
      }),
      {
        accountId: 'abc1234567890def1234567890abcdef',
        apiToken: 'cf_tok_secret_9988',
        apiToken2: 'cf_img_tok_5566',
      }
    );
  });

  it('maskAccountId and maskToken hide secret parts', () => {
    const maskedAcct = maskAccountId('1234567890abcdef1234567890abcdef');
    assert.ok(maskedAcct.startsWith('123456'));
    assert.ok(maskedAcct.includes('•'));
    assert.ok(!maskedAcct.includes('abcdef1234567890abcdef'));

    const maskedTok = maskToken('cf_secret_token_1234567890');
    assert.ok(maskedTok.startsWith('cf_s'));
    assert.ok(maskedTok.endsWith('7890'));
    assert.ok(maskedTok.includes('•'));
    assert.ok(!maskedTok.includes('secret_token'));
  });

  it('isCloudflareChatModel filters non-chat tasks (embedding, audio, transcription, etc.)', () => {
    assert.equal(isCloudflareChatModel('@cf/meta/llama-3.1-8b-instruct'), true);
    assert.equal(isCloudflareChatModel('@cf/qwen/qwen2.5-7b-instruct'), true);
    assert.equal(isCloudflareChatModel('@cf/baai/bge-base-en-v1.5'), false); // embedding
    assert.equal(isCloudflareChatModel('@cf/openai/whisper'), false); // audio
    assert.equal(isCloudflareChatModel('@cf/stabilityai/stable-diffusion-xl-base-1.0'), false); // image
    assert.equal(isCloudflareChatModel(''), false);
  });

  it('getUtcDayKey formats YYYY-MM-DD in UTC', () => {
    const key = getUtcDayKey(Date.UTC(2026, 10, 20, 16, 0, 0));
    assert.equal(key, '2026-11-20');
  });

  it('tracks daily neuron consumption and enforces 10,000 free neuron daily limit', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cfg-'));
    try {
      let mockTime = Date.UTC(2026, 10, 20, 10, 0, 0);
      const cfg = createCloudflareConfig({ dir: tmpDir, env: {}, now: () => mockTime });

      assert.equal(cfg.isEnabled(), true);
      assert.equal(cfg.getSpendingPolicy(), 'allow_free_only');
      assert.equal(cfg.getDailyNeuronsLimit(), 10000);
      assert.equal(cfg.getRemainingDailyNeurons(), 10000);
      assert.equal(cfg.isDailyQuotaExhausted(), false);

      // Record small usage
      cfg.recordUsage({ model: '@cf/meta/llama-3.1-8b-instruct', ok: true, inputTokens: 500, outputTokens: 500 });
      assert.equal(cfg.isDailyQuotaExhausted(), false);
      assert.ok(cfg.getRemainingDailyNeurons() < 10000);

      // Record large usage exceeding 10,000 neurons
      cfg.recordUsage({ model: '@cf/meta/llama-3.1-8b-instruct', ok: true, neurons: 10500 });
      assert.equal(cfg.isDailyQuotaExhausted(), true);
      assert.equal(cfg.getRemainingDailyNeurons(), 0);

      // Simulate midnight 00:00 UTC rollover to next day
      mockTime = Date.UTC(2026, 10, 21, 0, 1, 0);
      assert.equal(cfg.isDailyQuotaExhausted(), false);
      assert.equal(cfg.getRemainingDailyNeurons(), 10000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('cloudflare-provider', () => {
  const { createCloudflareConfig } = require('../cloudflare-config');
  const { createCloudflareProvider } = require('../cloudflare-provider');

  it('missing credentials -> configured() is false and testConnection returns not_configured', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-p1-'));
    try {
      const cfg = createCloudflareConfig({ dir: tmpDir, env: {} });
      const provider = createCloudflareProvider({ HttpError, env: {}, config: cfg, fetchImpl: makeFetch([]) });
      assert.equal(provider.configured(), false);
      assert.equal(provider.enabled(), false);

      const conn = await provider.testConnection();
      assert.equal(conn.ok, false);
      assert.equal(conn.code, 'not_configured');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('valid credentials -> testConnection discovers models and masks credentials in status()', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-p2-'));
    const env = {
      CLOUDFLARE_ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      CLOUDFLARE_API_TOKEN: 'cf_token_super_secret_xyz123',
    };
    try {
      const cfg = createCloudflareConfig({ dir: tmpDir, env });
      const fetchImpl = makeFetch([
        {
          status: 200,
          body: {
            success: true,
            data: [
              { id: '@cf/meta/llama-3.1-8b-instruct', name: 'Llama 3.1 8B Instruct', context_window: 131072 },
              { id: '@cf/openai/whisper', name: 'Whisper Audio' }, // excluded
            ],
          },
        },
      ]);
      const provider = createCloudflareProvider({ HttpError, env, config: cfg, fetchImpl });
      assert.equal(provider.configured(), true);

      const conn = await provider.testConnection();
      assert.equal(conn.ok, true);
      assert.equal(conn.status, 'connected');
      assert.ok(conn.modelCount >= 1);
      assert.ok(conn.maskedToken.includes('•'));
      assert.ok(!conn.maskedToken.includes('super_secret'));

      const st = provider.status();
      assert.equal(st.configured, true);
      assert.equal(st.validation, 'ok');
      assert.equal(st.identifier, 'cloudflare_workers_ai');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('invalid token (401) -> maps to invalid_api_token without leaking token', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-p3-'));
    const env = {
      CLOUDFLARE_ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      CLOUDFLARE_API_TOKEN: 'bad_token_12345',
    };
    try {
      const cfg = createCloudflareConfig({ dir: tmpDir, env });
      const fetchImpl = makeFetch([
        {
          status: 401,
          body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
        },
      ]);
      const provider = createCloudflareProvider({ HttpError, env, config: cfg, fetchImpl });
      const conn = await provider.testConnection();
      assert.equal(conn.ok, false);
      assert.equal(conn.code, 'invalid_api_token');
      assert.ok(!JSON.stringify(conn).includes('bad_token_12345'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('zero-billing & quota exhaustion blocks requests without paid fallback', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-p4-'));
    const env = {
      CLOUDFLARE_ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      CLOUDFLARE_API_TOKEN: 'cf_token_valid',
    };
    try {
      const cfg = createCloudflareConfig({ dir: tmpDir, env });
      const provider = createCloudflareProvider({ HttpError, env, config: cfg, fetchImpl: makeFetch([]) });

      // 1. Spending policy: block
      cfg.setSpendingPolicy('block');
      await assert.rejects(
        () => provider.generate({ model: '@cf/meta/llama-3.1-8b-instruct', text: 'Hello' }),
        err => err.code === 'billing_blocked'
      );

      // 2. Spending policy: allow_free_only, but daily neurons exhausted
      cfg.setSpendingPolicy('allow_free_only');
      cfg.recordUsage({ model: '@cf/meta/llama-3.1-8b-instruct', ok: true, neurons: 15000 });
      assert.equal(cfg.isDailyQuotaExhausted(), true);

      await assert.rejects(
        () => provider.generate({ model: '@cf/meta/llama-3.1-8b-instruct', text: 'Hello' }),
        err => err.code === 'quota_exhausted'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('generate() sends OpenAI-compatible payload and returns clean text + usage', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-p5-'));
    const env = {
      CLOUDFLARE_ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      CLOUDFLARE_API_TOKEN: 'cf_token_valid',
    };
    try {
      const cfg = createCloudflareConfig({ dir: tmpDir, env });
      let capturedBody = null;
      let capturedHeaders = null;
      const fetchImpl = async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        capturedHeaders = opts.headers;
        return {
          ok: true,
          status: 200,
          headers: {},
          json: async () => ({
            choices: [
              {
                message: { role: 'assistant', content: 'PHOTON Cloudflare connection successful.' },
              },
            ],
            usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
          }),
        };
      };

      const provider = createCloudflareProvider({ HttpError, env, config: cfg, fetchImpl });
      const res = await provider.generate({
        model: '@cf/meta/llama-3.1-8b-instruct',
        system: 'You are Photon.',
        text: 'Reply with: PHOTON Cloudflare connection successful.',
      });

      assert.equal(res.text, 'PHOTON Cloudflare connection successful.');
      assert.equal(res.usage.totalTokens, 23);
      assert.equal(capturedHeaders.Authorization, 'Bearer cf_token_valid');
      assert.equal(capturedBody.model, '@cf/meta/llama-3.1-8b-instruct');
      assert.ok(capturedBody.messages.some(m => m.role === 'system'));
      assert.ok(capturedBody.messages.some(m => m.role === 'user'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('streamGenerate() yields delta events and final done payload', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-p6-'));
    const env = {
      CLOUDFLARE_ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      CLOUDFLARE_API_TOKEN: 'cf_token_valid',
    };
    try {
      const cfg = createCloudflareConfig({ dir: tmpDir, env });
      const streamBody = makeSseStream([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        'data: {"choices":[{"delta":{"content":" from Cloudflare!"}}]}',
        'data: [DONE]',
      ]);
      const fetchImpl = async () => ({
        ok: true,
        status: 200,
        headers: {},
        body: streamBody,
      });

      const provider = createCloudflareProvider({ HttpError, env, config: cfg, fetchImpl });
      const events = [];
      for await (const ev of provider.streamGenerate({ model: '@cf/meta/llama-3.1-8b-instruct', text: 'Hi' })) {
        events.push(ev);
      }

      assert.equal(events.length, 3);
      assert.equal(events[0].type, 'delta');
      assert.equal(events[0].text, 'Hello');
      assert.equal(events[1].type, 'delta');
      assert.equal(events[1].text, ' from Cloudflare!');
      assert.equal(events[2].type, 'done');
      assert.equal(events[2].text, 'Hello from Cloudflare!');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('testModel() sends prompt to exact model and reports latency', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-p7-'));
    const env = {
      CLOUDFLARE_ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      CLOUDFLARE_API_TOKEN: 'cf_token_valid',
    };
    try {
      const cfg = createCloudflareConfig({ dir: tmpDir, env });
      const fetchImpl = async (url, opts) => ({
        ok: true,
        status: 200,
        headers: {},
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'PHOTON Cloudflare connection successful.' } }],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
        }),
      });

      const provider = createCloudflareProvider({ HttpError, env, config: cfg, fetchImpl });
      const result = await provider.testModel('@cf/meta/llama-3.1-8b-instruct');
      assert.equal(result.ok, true);
      assert.equal(result.model, '@cf/meta/llama-3.1-8b-instruct');
      assert.equal(result.status, 'working');
      assert.ok(result.responseTimeMs >= 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('imageCatalogEntries() returns text-to-image models', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-img1-'));
    try {
      const env = {
        CLOUDFLARE_ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        CLOUDFLARE_API_TOKEN: 'cf_token_valid',
      };
      const cfg = createCloudflareConfig({ dir: tmpDir, env });
      const provider = createCloudflareProvider({ HttpError, env, config: cfg });
      const catalog = provider.imageCatalogEntries();
      assert.ok(Array.isArray(catalog));
      assert.ok(catalog.length >= 4);
      const flux = catalog.find(m => m.id === '@cf/black-forest-labs/flux-1-schnell');
      assert.ok(flux);
      assert.equal(flux.available, true);
      assert.equal(flux.category, 'Image Generation');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('generateImage() returns image data url from binary stream', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-img2-'));
    const env = {
      CLOUDFLARE_ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      CLOUDFLARE_API_TOKEN: 'cf_token_valid',
    };
    try {
      const cfg = createCloudflareConfig({ dir: tmpDir, env });
      const samplePngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      const fetchImpl = async (url, opts) => {
        assert.ok(url.includes('/ai/run/@cf/black-forest-labs/flux-1-schnell'));
        assert.equal(opts.headers['Authorization'], 'Bearer cf_token_valid');
        const body = JSON.parse(opts.body);
        assert.equal(body.prompt, 'a futuristic city at sunset');
        return {
          ok: true,
          status: 200,
          headers: { get: k => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
          arrayBuffer: async () => samplePngBytes.buffer.slice(samplePngBytes.byteOffset, samplePngBytes.byteOffset + samplePngBytes.byteLength),
        };
      };

      const provider = createCloudflareProvider({ HttpError, env, config: cfg, fetchImpl });
      const res = await provider.generateImage({
        prompt: 'a futuristic city at sunset',
        model: '@cf/black-forest-labs/flux-1-schnell',
      });

      assert.equal(res.success, true);
      assert.equal(res.mimeType, 'image/png');
      assert.ok(res.dataUrl.startsWith('data:image/png;base64,'));
      assert.equal(res.model, '@cf/black-forest-labs/flux-1-schnell');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('testImageModel() executes quick test and returns working status', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-img3-'));
    const env = {
      CLOUDFLARE_ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      CLOUDFLARE_API_TOKEN: 'cf_token_valid',
    };
    try {
      const cfg = createCloudflareConfig({ dir: tmpDir, env });
      const fakeBytes = Buffer.from('fake-image-bytes');
      const fetchImpl = async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => fakeBytes.buffer.slice(fakeBytes.byteOffset, fakeBytes.byteOffset + fakeBytes.byteLength),
      });

      const provider = createCloudflareProvider({ HttpError, env, config: cfg, fetchImpl });
      const res = await provider.testImageModel('@cf/black-forest-labs/flux-1-schnell');
      assert.equal(res.ok, true);
      assert.equal(res.status, 'working');
      assert.equal(res.model, '@cf/black-forest-labs/flux-1-schnell');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('generateImage() uses CLOUDFLARE_API_TOKEN_2 as dedicated image token and reports status', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-tok2-'));
    const env = {
      CLOUDFLARE_ACCOUNT_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      CLOUDFLARE_API_TOKEN: 'cf_text_token_primary',
      CLOUDFLARE_API_TOKEN_2: 'cf_image_token_secondary_9988',
    };
    try {
      const cfg = createCloudflareConfig({ dir: tmpDir, env });
      let tokenUsed = null;
      const fakeBytes = Buffer.from('image-token-2-test-bytes');
      const fetchImpl = async (url, opts) => {
        tokenUsed = opts?.headers?.Authorization || opts?.headers?.authorization;
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'image/png' },
          arrayBuffer: async () => fakeBytes.buffer.slice(fakeBytes.byteOffset, fakeBytes.byteOffset + fakeBytes.byteLength),
        };
      };

      const provider = createCloudflareProvider({ HttpError, env, config: cfg, fetchImpl });
      assert.equal(provider.imageConfigured(), true);
      const st = provider.status();
      assert.equal(st.hasImageToken, true);
      assert.ok(st.maskedToken2.includes('9988'));

      const res = await provider.generateImage({
        prompt: 'a glowing cosmic flower',
        model: '@cf/black-forest-labs/flux-1-schnell',
      });
      assert.equal(res.success, true);
      assert.equal(tokenUsed, 'Bearer cf_image_token_secondary_9988');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
