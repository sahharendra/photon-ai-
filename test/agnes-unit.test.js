'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAgnesConfig, maskKey } = require('../agnes-config');
const { createAgnesProvider, FLASH_MODEL_ID, API_BASE_URL, POLLING_BASE_URL } = require('../agnes-provider');

class MockHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

test('AgnesConfig: AES-256-GCM key encryption and secret masking', (t) => {
  const tmpDir = path.join(__dirname, '..', '.tmp_test_agnes_config_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const config = createAgnesConfig({ dir: tmpDir, env: {} });
  assert.equal(config.isConfigured(), false);
  assert.equal(config.getKey(), null);
  assert.equal(config.getMaskedKey(), null);

  // Set API Key
  const secretKey = 'ag-test-secret-key-1234567890abcdef';
  config.setKey(secretKey);

  assert.equal(config.isConfigured(), true);
  assert.equal(config.getKey(), secretKey);

  const masked = config.getMaskedKey();
  assert.match(masked, /^ag-tes••••••••cdef$/);
  assert.ok(!masked.includes('1234567890'));

  // Ensure key is encrypted on disk
  const rawDisk = fs.readFileSync(path.join(tmpDir, '.photon-agnes-config.json'), 'utf8');
  assert.ok(!rawDisk.includes(secretKey), 'Raw API key must never be stored in plain text');
  assert.ok(rawDisk.includes('encryptedKey'));

  // Reload from disk
  const reloaded = createAgnesConfig({ dir: tmpDir, env: {} });
  assert.equal(reloaded.isConfigured(), true);
  assert.equal(reloaded.getKey(), secretKey);

  // Remove key
  config.setKey('');
  assert.equal(config.isConfigured(), false);
  assert.equal(config.getKey(), null);
});

test('AgnesConfig: model registration strictly categorized as VIDEO with 720P limitation', (t) => {
  const tmpDir = path.join(__dirname, '..', '.tmp_test_agnes_models_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const config = createAgnesConfig({ dir: tmpDir, env: {} });
  const model = config.getModel(FLASH_MODEL_ID);

  assert.ok(model, 'Default Flash model must exist');
  assert.equal(model.id, 'agnes-video-2.5-flash');
  assert.equal(model.category, 'Video Generation');
  assert.equal(model.task, 'text-to-video');
  assert.equal(model.resolution, '720p');
  assert.equal(model.maxSeconds, 5);
  assert.equal(model.freePromotion, true);

  // Verify capabilities are video-only
  assert.equal(model.capabilities.text, false, 'Must not be registered as text model');
  assert.equal(model.capabilities.image_output, false, 'Must not be registered as image model');
  assert.equal(model.capabilities.video_output, true, 'Must have video_output: true');
  assert.equal(model.capabilities.resolution, '720p');
});

test('AgnesProvider: status and catalogEntries zero secret leakage', (t) => {
  const tmpDir = path.join(__dirname, '..', '.tmp_test_agnes_prov_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const secretKey = 'ag-live-production-secret-987654321';
  const config = createAgnesConfig({ dir: tmpDir, env: {} });
  config.setKey(secretKey);

  const provider = createAgnesProvider({
    HttpError: MockHttpError,
    config,
  });

  const st = provider.status();
  assert.equal(st.configured, true);
  assert.equal(st.enabled, true);
  assert.ok(!JSON.stringify(st).includes(secretKey), 'Secret must not be exposed in status()');

  const catalog = provider.catalogEntries();
  assert.ok(Array.isArray(catalog));
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].id, FLASH_MODEL_ID);
  assert.equal(catalog[0].category, 'Video Generation');
  assert.equal(catalog[0].task, 'text-to-video');
  assert.ok(!JSON.stringify(catalog).includes(secretKey), 'Secret must not be exposed in catalogEntries()');
});

test('AgnesProvider: asynchronous video creation and polling flow', async (t) => {
  const tmpDir = path.join(__dirname, '..', '.tmp_test_agnes_flow_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const config = createAgnesConfig({ dir: tmpDir, env: {} });
  config.setKey('ag-test-valid-key');

  let pollCount = 0;
  const mockFetch = async (url, options = {}) => {
    const urlStr = String(url);

    // 1. Video creation endpoint
    if (urlStr === `${API_BASE_URL}/videos` && options.method === 'POST') {
      assert.equal(options.headers['Authorization'], 'Bearer ag-test-valid-key');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'agnes-video-2.5-flash');
      assert.equal(body.prompt, 'a rotating red apple');
      assert.equal(body.size, '720p');
      assert.equal(body.seconds, 5);

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          video_id: 'vid-test-12345',
          status: 'queued',
        }),
        json: async () => ({
          success: true,
          video_id: 'vid-test-12345',
          status: 'queued',
        }),
      };
    }

    // 2. Polling endpoint
    if (urlStr.includes('/agnesapi') && urlStr.includes('video_id=vid-test-12345')) {
      assert.equal(options.headers['Authorization'], 'Bearer ag-test-valid-key');
      assert.ok(urlStr.includes('model_name=agnes-video-2.5-flash'));
      pollCount++;

      if (pollCount === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            status: 'processing',
            progress: 45,
          }),
        };
      }

      // Return completed on second poll
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          status: 'completed',
          progress: 100,
          video_url: 'https://cdn.agnes-ai.com/videos/vid-test-12345.mp4',
        }),
      };
    }

    // 3. Validation HEAD request
    if (urlStr.includes('cdn.agnes-ai.com/videos/vid-test-12345.mp4')) {
      return {
        ok: true,
        status: 200,
        headers: new Map([
          ['content-type', 'video/mp4'],
          ['content-length', '2048576'],
        ]),
      };
    }

    return { ok: false, status: 404, text: async () => 'Not found' };
  };

  const provider = createAgnesProvider({
    HttpError: MockHttpError,
    fetchImpl: mockFetch,
    config,
  });

  const outcome = await provider.generateVideo({
    prompt: 'a rotating red apple',
    model: 'agnes-video-2.5-flash',
    seconds: 5,
    size: '720p',
    aspect_ratio: '16:9',
  });

  assert.equal(outcome.success, true);
  assert.equal(outcome.videoId, 'vid-test-12345');
  assert.equal(outcome.videoUrl, 'https://cdn.agnes-ai.com/videos/vid-test-12345.mp4');
  assert.equal(outcome.resolution, '720p');
  assert.equal(outcome.durationSeconds, 5);
  assert.equal(outcome.provider, 'Agnes AI');
  assert.ok(pollCount >= 2);
});

test('AgnesProvider: strict free-only spending protection', async (t) => {
  const tmpDir = path.join(__dirname, '..', '.tmp_test_agnes_free_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const config = createAgnesConfig({ dir: tmpDir, env: {} });
  config.setKey('ag-test-key');
  config.setSpendingPolicy('strict_free_only');

  // Register a fake paid model
  config.updateModel('agnes-paid-model', {
    id: 'agnes-paid-model',
    name: 'Agnes Paid Model',
    freePromotion: false,
    priceStatus: 'PAID',
    pricing: '$0.10 / sec',
  });

  const provider = createAgnesProvider({
    HttpError: MockHttpError,
    config,
  });

  await assert.rejects(
    async () => {
      await provider.createVideoJob({
        prompt: 'test prompt',
        model: 'agnes-paid-model',
      });
    },
    (err) => {
      assert.equal(err.status, 402);
      assert.equal(err.code, 'billing_blocked');
      assert.ok(err.message.includes('Strict free-only spending policy'));
      return true;
    }
  );
});

test('AgnesProvider: error classification for invalid key, rate limit and billing', (t) => {
  const tmpDir = path.join(__dirname, '..', '.tmp_test_agnes_errs_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const config = createAgnesConfig({ dir: tmpDir, env: {} });
  config.setKey('ag-test-key');

  const { AgnesAiQuotaAdapter } = require('../quota-monitor-service');
  const adapter = new AgnesAiQuotaAdapter();

  // Test 401 unauthorized
  const err401 = adapter.classifyError({ status: 401, message: 'Token not provided' });
  assert.equal(err401.status, 'INVALID_KEY');

  // Test 402 insufficient credits / promotion expired
  const err402 = adapter.classifyError({ status: 402, message: 'Account requires billing' });
  assert.equal(err402.status, 'INSUFFICIENT_CREDITS');

  // Test 429 rate limited
  const err429 = adapter.classifyError({ status: 429, message: 'Too many requests' });
  assert.equal(err429.status, 'RATE_LIMITED');
});
