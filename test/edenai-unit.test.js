'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createEdenAiConfig,
  encryptKey,
  decryptKey,
  maskKey,
  fingerprint,
} = require('../edenai-config');

const { createEdenAiProvider } = require('../edenai-provider');
const { createQuotaMonitorService, EdenAiQuotaAdapter } = require('../quota-monitor-service');
const { isModelAllowedForPlan, normalizeProviderName } = require('../provider-access-service');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// -----------------------------------------------------------------------------
// 1. CONFIGURATION & AES-256 ENCRYPTION TESTS
// -----------------------------------------------------------------------------

test('Eden AI Config: AES-256-GCM encrypts and decrypts API key correctly', () => {
  const sampleKey = 'eden-live-key-xyz1234567890abcdefghijklmnopqrstuvwxyz';
  const encrypted = encryptKey(sampleKey);

  assert.ok(encrypted, 'Ciphertext should be non-empty');
  assert.notStrictEqual(encrypted, sampleKey, 'Ciphertext must not match raw key');
  assert.strictEqual(encrypted.split(':').length, 3, 'Must contain IV, AuthTag, and Ciphertext separated by colons');

  const decrypted = decryptKey(encrypted);
  assert.strictEqual(decrypted, sampleKey, 'Decrypted key must match original');
});

test('Eden AI Config: masks keys securely and generates deterministic fingerprints', () => {
  const sampleKey = 'eden-secret-token-abcdef1234';
  const masked = maskKey(sampleKey);

  assert.ok(masked.includes('••••••••'));
  assert.ok(!masked.includes('secret-token'), 'Sensitive segment must be masked');
  assert.ok(masked.endsWith('1234'));

  const fp1 = fingerprint(sampleKey);
  const fp2 = fingerprint(sampleKey);
  assert.strictEqual(fp1, fp2);
  assert.strictEqual(fp1.length, 16);
});

test('Eden AI Config: manages spending policies, model toggles, and usage statistics', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-edenai-test-'));
  const cfg = createEdenAiConfig({ dir: tmpDir, env: {} });

  // Key setting & masking
  cfg.setKey('eden-test-key-9999');
  assert.strictEqual(cfg.isConfigured(), true);
  assert.strictEqual(cfg.getKey(), 'eden-test-key-9999');
  const st = cfg.status();
  assert.strictEqual(st.hasKey, true);
  assert.strictEqual(st.maskedKey.endsWith('9999'), true);
  assert.ok(!JSON.stringify(st).includes('eden-test-key-9999'), 'Raw key must NEVER appear in status output');

  // Spending policy
  cfg.setSpendingPolicy('allow_free_only');
  assert.strictEqual(cfg.getSpendingPolicy(), 'allow_free_only');

  // Model toggling
  const models = cfg.getModels();
  assert.ok(models.length >= 3);
  const firstId = models[0].id;
  cfg.setModelEnabled(firstId, false);
  assert.strictEqual(cfg.getModel(firstId).enabled, false);
  cfg.setModelEnabled(firstId, true);
  assert.strictEqual(cfg.getModel(firstId).enabled, true);

  // Usage recording
  cfg.recordUsage({ capability: 'text', inputTokens: 50, outputTokens: 100, totalTokens: 150 });
  cfg.recordUsage({ capability: 'image' });
  cfg.recordUsage({ capability: 'video' });
  const updatedSt = cfg.status();
  assert.strictEqual(updatedSt.usage.requests, 3);
  assert.strictEqual(updatedSt.usage.totalTokens, 150);
  assert.strictEqual(updatedSt.usage.byCapability.text.tokens, 150);
  assert.strictEqual(updatedSt.usage.byCapability.image.images, 1);
  assert.strictEqual(updatedSt.usage.byCapability.video.jobs, 1);

  // Clean up
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// -----------------------------------------------------------------------------
// 2. PROVIDER API & CAPABILITY VERIFICATION TESTS
// -----------------------------------------------------------------------------

test('Eden AI Provider: testConnection succeeds on 200 and fails cleanly on 401 without key exposure', async () => {
  // Test valid key
  const mockFetchValid = async (url) => {
    assert.ok(url.includes('/models'));
    return {
      ok: true,
      status: 200,
      json: async () => ({ object: 'list', data: [{ id: 'openai/gpt-4o' }] }),
    };
  };

  const env = { EDENAI_API_KEY: 'eden-valid-key-1234' };
  const provider = createEdenAiProvider({ HttpError, env, fetchImpl: mockFetchValid });
  const resValid = await provider.testConnection();
  assert.strictEqual(resValid.ok, true);
  assert.ok(resValid.message.includes('Successfully connected'));

  // Test invalid key
  const mockFetchInvalid = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: 'Invalid API Key provided', code: 'invalid_api_key' } }),
  });

  const providerInvalid = createEdenAiProvider({ HttpError, env, fetchImpl: mockFetchInvalid });
  const resInvalid = await providerInvalid.testConnection();
  assert.strictEqual(resInvalid.ok, false);
  assert.strictEqual(resInvalid.code, 'invalid_api_key');
  assert.ok(resInvalid.message.includes('Invalid API Key'));
  assert.ok(!resInvalid.message.includes('eden-valid-key-1234'), 'Must not leak key');
});

test('Eden AI Provider: discovers models across Text and Video endpoints', async () => {
  const mockFetch = async (url) => {
    if (url.includes('/videos/models')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          object: 'list',
          data: [
            { id: 'bytedance/dreamina-seedance-2-0-fast-260128', provider: 'bytedance', pricing: { price: 5.6 } },
            { id: 'pruna/p-video', provider: 'pruna', pricing: { price: 0.02 } },
          ],
        }),
      };
    }
    if (url.includes('/models')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          object: 'list',
          data: [
            {
              id: 'openai/gpt-4o',
              model_name: 'gpt-4o',
              owned_by: 'openai',
              context_length: 128000,
              capabilities: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
            },
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const env = { EDENAI_API_KEY: 'eden-test-key' };
  const provider = createEdenAiProvider({ HttpError, env, fetchImpl: mockFetch });
  const disc = await provider.refreshModels();

  assert.strictEqual(disc.success, true);
  assert.ok(disc.count >= 3);

  const entries = provider.catalogEntries();
  const textModel = entries.find(m => m.id === 'openai/gpt-4o');
  const videoModel = entries.find(m => m.id === 'bytedance/dreamina-seedance-2-0-fast-260128');
  const imageModel = entries.find(m => m.id.includes('stability'));

  assert.ok(textModel, 'Must discover text model');
  assert.strictEqual(textModel.category, 'Text Generation');
  assert.ok(videoModel, 'Must discover video model');
  assert.strictEqual(videoModel.category, 'Video Generation');
  assert.ok(imageModel, 'Must maintain image model');
  assert.strictEqual(imageModel.category, 'Image Generation');
});

test('Eden AI Provider: Stage 1 Text Generation generates chat completions with tokens and duration', async () => {
  const mockFetch = async (url, opts) => {
    assert.ok(url.includes('/chat/completions'));
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.model, 'openai/gpt-4o-mini');
    assert.strictEqual(body.messages[0].content, 'Hello from Photon');

    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-eden-123',
        choices: [{ message: { role: 'assistant', content: 'Greetings! How can I assist you today?' } }],
        usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
      }),
    };
  };

  const env = { EDENAI_API_KEY: 'eden-test-key' };
  const provider = createEdenAiProvider({ HttpError, env, fetchImpl: mockFetch });
  const result = await provider.generate({
    model: 'openai/gpt-4o-mini',
    text: 'Hello from Photon',
  });

  assert.strictEqual(result.text, 'Greetings! How can I assist you today?');
  assert.strictEqual(result.provider, 'Eden AI');
  assert.strictEqual(result.usage.totalTokens, 25);
  assert.ok(result.durationMs >= 0);

  // Test Stage 1 Text test runner
  const testRes = await provider.testTextModel('openai/gpt-4o-mini', 'Hello from Photon');
  assert.strictEqual(testRes.ok, true);
  assert.ok(testRes.message.includes('Text generation successful'));
});

test('Eden AI Provider: Stage 2 Image Generation returns verified image dataUrl', async () => {
  const fakePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  const mockFetch = async (url) => {
    assert.ok(url.includes('/images/generations'));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        created: Date.now(),
        data: [{ b64_json: fakePngBase64 }],
      }),
    };
  };

  const env = { EDENAI_API_KEY: 'eden-test-key' };
  const provider = createEdenAiProvider({ HttpError, env, fetchImpl: mockFetch });
  const result = await provider.generateImage({
    model: 'stabilityai/sd3.5-medium',
    prompt: 'a red flower in bloom',
  });

  assert.strictEqual(result.success, true);
  assert.ok(result.dataUrl.startsWith('data:image/png;base64,'));
  assert.strictEqual(result.provider, 'Eden AI');

  // Test Stage 2 Image test runner
  const testRes = await provider.testImageModel('stabilityai/sd3.5-medium', 'a red flower');
  assert.strictEqual(testRes.ok, true);
  assert.ok(testRes.message.includes('Image generation successful'));
});

test('Eden AI Provider: Stage 3 Video Generation creates job or reports unsupported cleanly', async () => {
  // Test job creation when supported
  const mockFetch = async (url, opts) => {
    if (opts.method === 'POST') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'vid_job_98765', status: 'queued', model: 'bytedance/dreamina-seedance-2-0-fast-260128' }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'vid_job_98765', status: 'completed', video_url: 'https://edenai.run/video.mp4' }),
    };
  };

  const env = { EDENAI_API_KEY: 'eden-test-key' };
  const provider = createEdenAiProvider({ HttpError, env, fetchImpl: mockFetch });
  const job = await provider.createVideoJob({
    model: 'bytedance/dreamina-seedance-2-0-fast-260128',
    prompt: 'A gentle river flowing through mountains',
  });

  assert.strictEqual(job.success, true);
  assert.strictEqual(job.jobId, 'vid_job_98765');
  assert.strictEqual(job.status, 'queued');

  const poll = await provider.getVideoJob('vid_job_98765');
  assert.strictEqual(poll.status, 'completed');
  assert.strictEqual(poll.videoUrl, 'https://edenai.run/video.mp4');

  // Test Stage 3 Video test runner
  const testRes = await provider.testVideoModel('bytedance/dreamina-seedance-2-0-fast-260128', 'River flowing');
  assert.strictEqual(testRes.ok, true);
  assert.strictEqual(testRes.supported, true);
  assert.strictEqual(testRes.jobId, 'vid_job_98765');
});

// -----------------------------------------------------------------------------
// 3. QUOTA MONITOR & ACCESS CONTROL TESTS
// -----------------------------------------------------------------------------

test('Eden AI Quota Adapter: classifies 401, 402, and 429 correctly', () => {
  const adapter = new EdenAiQuotaAdapter();

  const c401 = adapter.classifyError({ status: 401, message: 'Invalid API key provided' });
  assert.strictEqual(c401.status, 'INVALID_KEY');

  const c402 = adapter.classifyError({ status: 402, message: 'insufficient_credits' });
  assert.strictEqual(c402.status, 'INSUFFICIENT_CREDITS');

  const c429 = adapter.classifyError({ status: 429, message: 'Rate limit exceeded' });
  assert.strictEqual(c429.status, 'RATE_LIMITED');
  assert.ok(c429.resetAt > Date.now());
});

test('Provider Access Service: recognizes edenai and respects tier permissions', () => {
  assert.strictEqual(normalizeProviderName('Eden AI'), 'edenai');
  assert.strictEqual(normalizeProviderName('edenai'), 'edenai');
  assert.strictEqual(normalizeProviderName('eden-ai'), 'edenai');

  const edenModel = { id: 'openai/gpt-4o-mini', provider: 'Eden AI' };
  assert.strictEqual(isModelAllowedForPlan(edenModel, 'basic'), true);
  assert.strictEqual(isModelAllowedForPlan(edenModel, 'pro'), true);
  assert.strictEqual(isModelAllowedForPlan(edenModel, 'premium'), true);
});
