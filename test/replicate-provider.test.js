'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createReplicateConfig, maskToken, CANDIDATE_REPLICATE_MODELS } = require('../replicate-config');
const { createReplicateProvider, API_BASE_URL } = require('../replicate-provider');

describe('Replicate Video Generation Provider Unit & Integration Tests', () => {
  let tmpDir;
  let testEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-replicate-test-'));
    testEnv = {
      PHOTON_SECRET: 'test-secret-salt-key-replicate-12345',
      REPLICATE_API_TOKEN: 'r8_test_token_live_abc123xyz456',
    };
  });

  it('1: Encrypts, persists, and masks Replicate API token with zero plaintext leakage', () => {
    const config = createReplicateConfig({ dir: tmpDir, env: {} });
    assert.equal(config.isConfigured(), false);
    assert.equal(config.getToken(), null);

    config.setToken('r8_real_secret_token_abcdef123456');
    assert.equal(config.isConfigured(), true);
    assert.equal(config.getToken(), 'r8_real_secret_token_abcdef123456');

    const masked = config.getMaskedToken();
    assert.ok(masked.startsWith('r8_rea'));
    assert.ok(masked.endsWith('3456'));
    assert.ok(masked.includes('••••'));
    assert.equal(masked.includes('secret'), false);

    // Verify stored config file on disk is encrypted
    const configFile = path.join(tmpDir, '.photon-replicate-config.json');
    assert.ok(fs.existsSync(configFile));
    const savedJson = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(savedJson.encryptedToken.includes('r8_real_secret_token'), false);
    assert.equal(savedJson.maskedToken, masked);

    // Verify status() does not leak plain token
    const st = config.status();
    assert.equal(st.configured, true);
    assert.equal(st.maskedToken, masked);
    assert.equal(st.hasToken, true);
    assert.equal(JSON.stringify(st).includes('r8_real_secret_token'), false);
  });

  it('2: Candidate video models register only video_output models with accurate schemas', () => {
    const config = createReplicateConfig({ dir: tmpDir, env: testEnv });
    const models = config.getModels();

    assert.ok(models.length >= 5);
    const candidateIds = Object.keys(CANDIDATE_REPLICATE_MODELS);
    for (const cid of candidateIds) {
      const found = models.find(m => m.id === cid);
      assert.ok(found, `Candidate model ${cid} must be registered`);
      assert.equal(found.category, 'Video Generation');
      assert.equal(found.capabilities.video_output, true);
      assert.equal(found.capabilities.image_output, false);
      assert.equal(found.capabilities.text, false);
    }
  });

  it('3: Strict Free-Only Spending Protection blocks pay-as-you-go models until free eligibility is verified', () => {
    const config = createReplicateConfig({ dir: tmpDir, env: testEnv });
    config.setSpendingPolicy('strict_free_only');
    const provider = createReplicateProvider({ config, env: testEnv });

    // Under strict_free_only, candidate models with FREE_ELIGIBILITY_UNKNOWN are marked available=false
    const entries = provider.catalogEntries();
    const mm01 = entries.find(m => m.id === 'minimax/video-01');
    assert.ok(mm01);
    assert.equal(mm01.available, false);
    assert.ok(mm01.reason.includes('Blocked in strict free-only mode'));

    // Switch policy to allow_all -> pay-as-you-go models become available
    config.setSpendingPolicy('allow_all');
    const entriesAllowed = provider.catalogEntries();
    const mm01Allowed = entriesAllowed.find(m => m.id === 'minimax/video-01');
    assert.ok(mm01Allowed);
    assert.equal(mm01Allowed.available, true);
  });

  it('4: Dynamic model input adapter constructs compliant schemas for MiniMax, SeaDance, and generic models', () => {
    const config = createReplicateConfig({ dir: tmpDir, env: testEnv });
    const provider = createReplicateProvider({ config, env: testEnv });

    // 1. MiniMax text-to-video with prompt optimizer
    const mmInput = provider.buildModelInput('minimax/video-01', {
      prompt: 'A red apple rotating on a white table',
      referenceImage: 'https://example.com/apple.jpg',
    });
    assert.equal(mmInput.prompt, 'A red apple rotating on a white table');
    assert.equal(mmInput.prompt_optimizer, true);
    assert.equal(mmInput.first_frame_image, 'https://example.com/apple.jpg');

    // 2. SeaDance Lite with aspect ratio
    const sdInput = provider.buildModelInput('bytedance/seedance-1-lite', {
      prompt: 'Cinematic drone shot of mountains',
      aspectRatio: '16:9',
      referenceImage: 'https://example.com/mountains.jpg',
    });
    assert.equal(sdInput.prompt, 'Cinematic drone shot of mountains');
    assert.equal(sdInput.aspect_ratio, '16:9');
    assert.equal(sdInput.image, 'https://example.com/mountains.jpg');

    // 3. Google Veo 3
    const veoInput = provider.buildModelInput('google/veo-3', {
      prompt: 'Hyperrealistic red apple',
      aspectRatio: '9:16',
    });
    assert.equal(veoInput.prompt, 'Hyperrealistic red apple');
    assert.equal(veoInput.aspect_ratio, '9:16');
  });

  it('5: Extracts video URL correctly across string, array, and object responses', () => {
    const config = createReplicateConfig({ dir: tmpDir, env: testEnv });
    const provider = createReplicateProvider({ config, env: testEnv });

    assert.equal(
      provider.extractVideoUrl('https://replicate.delivery/video1.mp4'),
      'https://replicate.delivery/video1.mp4'
    );
    assert.equal(
      provider.extractVideoUrl(['https://replicate.delivery/video2.mp4']),
      'https://replicate.delivery/video2.mp4'
    );
    assert.equal(
      provider.extractVideoUrl([{ url: 'https://replicate.delivery/video3.mp4' }]),
      'https://replicate.delivery/video3.mp4'
    );
    assert.equal(
      provider.extractVideoUrl({ url: 'https://replicate.delivery/video4.mp4' }),
      'https://replicate.delivery/video4.mp4'
    );
  });

  it('6: Handles Replicate test connection with valid account and billing details', async () => {
    const config = createReplicateConfig({ dir: tmpDir, env: testEnv });
    const fakeFetch = async (url, opts) => {
      assert.equal(url, `${API_BASE_URL}/account`);
      assert.equal(opts.headers.Authorization, `Bearer ${testEnv.REPLICATE_API_TOKEN}`);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          type: 'user',
          username: 'photontester',
          name: 'Photon Tester',
          has_billing: true,
        }),
      };
    };

    const provider = createReplicateProvider({ config, env: testEnv, fetchImpl: fakeFetch });
    const res = await provider.testConnection();

    assert.equal(res.ok, true);
    assert.equal(res.account.username, 'photontester');
    assert.equal(res.account.hasBilling, true);
    assert.ok(res.message.includes('@photontester'));

    // Check account persisted in config
    const acc = config.getAccountInfo();
    assert.equal(acc.username, 'photontester');
    assert.equal(acc.hasBilling, true);
  });

  it('7: Handles complete asynchronous video prediction lifecycle (create -> poll -> validate video)', async () => {
    const config = createReplicateConfig({ dir: tmpDir, env: testEnv });
    config.setSpendingPolicy('allow_all'); // Allow generation for test

    const predictionId = 'pred_test_abc123';
    let pollCount = 0;

    const fakeFetch = async (url, opts) => {
      // POST prediction creation
      if (url.includes('/predictions') && opts.method === 'POST') {
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({
            id: predictionId,
            status: 'starting',
            created_at: new Date().toISOString(),
          }),
        };
      }
      // GET prediction status polling
      if (url.includes(`/predictions/${predictionId}`) && (!opts.method || opts.method === 'GET')) {
        pollCount++;
        const st = pollCount >= 2 ? 'succeeded' : 'processing';
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: predictionId,
            status: st,
            output: 'https://replicate.delivery/output_apple_rotation.mp4',
            created_at: new Date().toISOString(),
          }),
        };
      }
      // HEAD validation of output video
      if (url.includes('output_apple_rotation.mp4')) {
        return {
          ok: true,
          status: 200,
          headers: new Map([
            ['content-type', 'video/mp4'],
            ['content-length', '2048576'],
          ]),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const provider = createReplicateProvider({ config, env: testEnv, fetchImpl: fakeFetch });
    const outcome = await provider.generateVideo({
      prompt: 'A red apple rotating slowly on clean white background',
      model: 'minimax/video-01',
      seconds: 5,
    });

    assert.equal(outcome.success, true);
    assert.equal(outcome.jobId, predictionId);
    assert.equal(outcome.videoUrl, 'https://replicate.delivery/output_apple_rotation.mp4');
    assert.equal(outcome.contentType, 'video/mp4');
    assert.equal(outcome.model, 'minimax/video-01');
    assert.equal(outcome.provider, 'Replicate');
  });

  it('8: testVideoModel verifies prompt and updates model status to PASSED on success, or PAID_ONLY on 402', async () => {
    const config = createReplicateConfig({ dir: tmpDir, env: testEnv });
    config.setSpendingPolicy('allow_all');

    // 1. Success test
    const fakeSuccessFetch = async (url, opts) => {
      if (opts?.method === 'POST') {
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({
            id: 'pred_success_1',
            status: 'succeeded',
            output: ['https://replicate.delivery/cinematic_apple.mp4'],
          }),
        };
      }
      if (url.includes('cinematic_apple.mp4')) {
        return {
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'video/mp4'], ['content-length', '1048576']]),
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'succeeded', output: 'https://replicate.delivery/cinematic_apple.mp4' }) };
    };

    const providerSuccess = createReplicateProvider({ config, env: testEnv, fetchImpl: fakeSuccessFetch });
    const resSuccess = await providerSuccess.testVideoModel('minimax/video-01');

    assert.equal(resSuccess.ok, true);
    assert.equal(resSuccess.freeEligibility, 'FREE_VERIFIED');
    const modelRecord = config.getModel('minimax/video-01');
    assert.equal(modelRecord.testStatus, 'PASSED');
    assert.equal(modelRecord.freeEligibility, 'FREE_VERIFIED');

    // 2. HTTP 402 payment required test
    const fake402Fetch = async () => ({
      ok: false,
      status: 402,
      text: async () => JSON.stringify({
        detail: 'You need to set up billing to run this model on Replicate.',
      }),
    });

    const provider402 = createReplicateProvider({ config, env: testEnv, fetchImpl: fake402Fetch });
    const res402 = await provider402.testVideoModel('bytedance/seedance-1-pro');

    assert.equal(res402.ok, false);
    assert.equal(res402.freeEligibility, 'PAID_ONLY');
    assert.equal(res402.billingRequired, true);
    const sdRecord = config.getModel('bytedance/seedance-1-pro');
    assert.equal(sdRecord.testStatus, 'PAID_ONLY');
    assert.equal(sdRecord.freeEligibility, 'PAID_ONLY');
  });
});
