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

test('AgnesConfig: documents Flash model capabilities without assuming trial eligibility', (t) => {
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
  assert.equal(model.resolution, '720P');
  assert.equal(model.minSeconds, 4);
  assert.equal(model.maxSeconds, 12);
  assert.equal(model.freePromotion, true);
  assert.equal(model.freePromotionVerified, false);
  assert.equal(model.apiAvailable, false);
  assert.deepEqual(model.aspectRatios, ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);

  // Verify capabilities are video-only
  assert.equal(model.capabilities.text_to_video, true);
  assert.equal(model.capabilities.image_to_video, true);
  assert.equal(model.capabilities.video_output, true, 'Must have video_output: true');
  assert.equal(model.capabilities.resolution, '720P');
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
  assert.equal(catalog[0].category, 'video');
  assert.equal(catalog[0].available, false);
  assert.equal(catalog[0].free, false);
  assert.equal(catalog[0].task, 'text-to-video');
  assert.ok(!JSON.stringify(catalog).includes(secretKey), 'Secret must not be exposed in catalogEntries()');
});

test('AgnesProvider: connection check confirms model access but never assumes free eligibility', async (t) => {
  const tmpDir = path.join(__dirname, '..', '.tmp_test_agnes_availability_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const config = createAgnesConfig({ dir: tmpDir, env: {} });
  config.setKey('ag-model-list-key');
  const provider = createAgnesProvider({
    HttpError: MockHttpError,
    config,
    fetchImpl: async (url, options) => {
      assert.equal(url, `${API_BASE_URL}/models`);
      assert.equal(options.headers.Authorization, 'Bearer ag-model-list-key');
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: FLASH_MODEL_ID }] }) };
    },
  });

  const result = await provider.testConnection();
  assert.equal(result.ok, true);
  assert.equal(result.modelAvailable, true);
  assert.equal(provider.catalogEntries()[0].available, false);
  assert.equal(provider.catalogEntries()[0].free, false);

  config.setFreePromotionVerified(FLASH_MODEL_ID, true);
  assert.equal(provider.catalogEntries()[0].available, true);
  assert.equal(provider.catalogEntries()[0].free, true);
});

test('AgnesConfig: persists Agnes job ownership and rejects other users', (t) => {
  const tmpDir = path.join(__dirname, '..', '.tmp_test_agnes_jobs_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const config = createAgnesConfig({ dir: tmpDir, env: {} });
  assert.equal(config.recordVideoJob('video-123', 'user-abc'), true);
  assert.equal(config.getVideoJobOwner('video-123'), 'user-abc');
  const reloaded = createAgnesConfig({ dir: tmpDir, env: {} });
  assert.equal(reloaded.getVideoJobOwner('video-123'), 'user-abc');
  assert.equal(reloaded.getVideoJobOwner('video-123') === 'someone-else', false);
  assert.equal(reloaded.recordVideoJob('../bad-id', 'user-abc'), false);
});

test('AgnesProvider: asynchronous video creation and polling flow', async (t) => {
  const tmpDir = path.join(__dirname, '..', '.tmp_test_agnes_flow_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const config = createAgnesConfig({ dir: tmpDir, env: {} });
  config.setKey('ag-test-valid-key');
  config.setModelAvailability(FLASH_MODEL_ID, true);
  config.setFreePromotionVerified(FLASH_MODEL_ID, true);

  let pollCount = 0;
  const mockFetch = async (url, options = {}) => {
    const urlStr = String(url);

    // 1. Video creation endpoint
    if (urlStr === `${API_BASE_URL}/videos` && options.method === 'POST') {
      assert.equal(options.headers['Authorization'], 'Bearer ag-test-valid-key');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'agnes-video-2.5-flash');
      assert.equal(body.prompt, 'a rotating red apple');
      assert.equal(body.mode, 'text');
      assert.equal(body.size, '720P');
      assert.equal(body.seconds, '5');
      assert.equal(body.aspect_ratio, '16:9');
      assert.equal(body.n, 1);

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
          url: 'https://cdn.agnes-ai.com/videos/vid-test-12345.mp4',
        }),
      };
    }

    // 3. Validate video MIME type and container signature using a bounded range request.
    if (urlStr.includes('cdn.agnes-ai.com/videos/vid-test-12345.mp4')) {
      const signature = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
      return {
        ok: true,
        status: 206,
        headers: new Map([
          ['content-type', 'video/mp4'],
          ['content-length', '16'],
        ]),
        body: { getReader: () => ({ read: async () => ({ done: false, value: signature }), cancel: async () => {} }) },
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
    size: '720P',
    aspect_ratio: '16:9',
  });

  assert.equal(outcome.success, true);
  assert.equal(outcome.videoId, 'vid-test-12345');
  assert.equal(outcome.videoUrl, 'https://cdn.agnes-ai.com/videos/vid-test-12345.mp4');
  assert.equal(outcome.resolution, '720P');
  assert.equal(outcome.durationSeconds, 5);
  assert.equal(outcome.provider, 'Agnes AI');
  assert.ok(pollCount >= 2);
});

test('AgnesProvider: keyframe and reference modes use official request fields', async (t) => {
  const tmpDir = path.join(__dirname, '..', '.tmp_test_agnes_modes_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const config = createAgnesConfig({ dir: tmpDir, env: {} });
  config.setKey('ag-mode-key');
  config.setModelAvailability(FLASH_MODEL_ID, true);
  config.setFreePromotionVerified(FLASH_MODEL_ID, true);
  const payloads = [];
  const provider = createAgnesProvider({
    HttpError: MockHttpError,
    config,
    fetchImpl: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ video_id: `vid-${payloads.length}` }) };
    },
  });

  await provider.createVideoJob({
    prompt: 'animate the scene',
    mode: 'keyframe',
    seconds: 12,
    size: '720P',
    aspect_ratio: '21:9',
    firstFrame: 'https://images.example.com/first.jpg',
    lastFrame: 'https://images.example.com/last.jpg',
  });
  await provider.createVideoJob({
    prompt: 'use this visual reference',
    mode: 'reference',
    images: ['https://images.example.com/ref.jpg'],
  });

  assert.equal(payloads[0].mode, 'keyframe');
  assert.equal(payloads[0].first_frame, 'https://images.example.com/first.jpg');
  assert.equal(payloads[0].last_frame, 'https://images.example.com/last.jpg');
  assert.equal(payloads[0].seconds, '12');
  assert.equal(payloads[0].size, '720P');
  assert.equal(payloads[0].aspect_ratio, '21:9');
  assert.equal(payloads[1].mode, 'reference');
  assert.deepEqual(payloads[1].images, ['https://images.example.com/ref.jpg']);
  assert.equal('reference_image' in payloads[1], false);

  await assert.rejects(() => provider.createVideoJob({ prompt: 'too long', seconds: 13 }), { code: 'invalid_duration' });
  await assert.rejects(() => provider.createVideoJob({ prompt: 'bad mode', mode: 'standard' }), { code: 'invalid_mode' });
  await assert.rejects(() => provider.createVideoJob({ prompt: 'multiple outputs', n: 2 }), { code: 'invalid_count' });
  await assert.rejects(() => provider.createVideoJob({ prompt: 'keyframe in text mode', firstFrame: 'https://images.example.com/first.jpg' }), { code: 'invalid_mode' });
  assert.equal(payloads.length, 2, 'Invalid options must be rejected before making a provider request.');
});

test('AgnesProvider: billing/quota response revokes free eligibility; invalid video response is rejected', async (t) => {
  const tmpDir = path.join(__dirname, '..', '.tmp_test_agnes_quota_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const config = createAgnesConfig({ dir: tmpDir, env: {} });
  config.setKey('ag-quota-key');
  config.setModelAvailability(FLASH_MODEL_ID, true);
  config.setFreePromotionVerified(FLASH_MODEL_ID, true);
  const provider = createAgnesProvider({
    HttpError: MockHttpError,
    config,
    fetchImpl: async () => ({
      ok: false,
      status: 402,
      text: async () => JSON.stringify({ error: { code: 'billing_required', message: 'Trial quota exhausted.' } }),
    }),
  });

  await assert.rejects(() => provider.createVideoJob({ prompt: 'must not use paid credits' }), { status: 402 });
  assert.equal(config.getModel(FLASH_MODEL_ID).freePromotionVerified, false);
  assert.equal(provider.catalogEntries()[0].available, false);

  const invalidOutputProvider = createAgnesProvider({
    HttpError: MockHttpError,
    config,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/html']]),
    }),
  });
  const validation = await invalidOutputProvider.validateVideoFile('https://cdn.example.com/not-a-video');
  assert.equal(validation.valid, false);
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
  config.setModelAvailability(FLASH_MODEL_ID, true);

  const provider = createAgnesProvider({
    HttpError: MockHttpError,
    config,
  });

  await assert.rejects(
    async () => {
      await provider.createVideoJob({
        prompt: 'test prompt',
        model: FLASH_MODEL_ID,
      });
    },
    (err) => {
      assert.equal(err.status, 402);
      assert.equal(err.code, 'billing_blocked');
      assert.ok(err.message.includes('eligibility'));
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

  // Test video queue is full error
  const errQueue = adapter.classifyError({ status: 429, message: 'video queue is full, please retry later (request id: 20261126160426871272621DwhhzeND)' });
  assert.equal(errQueue.status, 'RATE_LIMITED');
  assert.match(errQueue.reason, /video queue is busy/i);
});

test('AgnesProvider: auto-retries on video queue full before succeeding', async (t) => {
  const tmpDir = path.join(__dirname, '..', '.tmp_test_agnes_retry_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const config = createAgnesConfig({ dir: tmpDir, env: {} });
  config.setKey('ag-test-retry-key');
  config.setModelAvailability(FLASH_MODEL_ID, true);
  config.setFreePromotionVerified(FLASH_MODEL_ID, true);

  let attempts = 0;
  const mockFetch = async () => {
    attempts++;
    if (attempts === 1) {
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({
          error: { message: 'video queue is full, please retry later (request id: 20261126160426871272621DwhhzeND)' }
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ video_id: 'vid-success-after-retry' }),
    };
  };

  const provider = createAgnesProvider({
    HttpError: MockHttpError,
    fetchImpl: mockFetch,
    config,
  });

  const job = await provider.createVideoJob({
    prompt: 'make a video of apple falling down',
    model: FLASH_MODEL_ID,
  });

  assert.equal(attempts, 2, 'Should retry on queue full and succeed on second attempt');
  assert.equal(job.jobId, 'vid-success-after-retry');
  assert.equal(job.status, 'queued');
});
