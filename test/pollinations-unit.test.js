'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  createPollinationsConfig,
  readEnvKey,
  maskKey,
  getUtcMonthKey
} = require('../pollinations-config');

const {
  createPollinationsProvider
} = require('../pollinations-provider');

class MockHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

describe('pollinations-config', () => {
  test('readEnvKey returns trimmed key or null', () => {
    assert.equal(readEnvKey({}), null);
    assert.equal(readEnvKey({ POLLINATIONS_API_KEY: '   ' }), null);
    assert.equal(readEnvKey({ POLLINATIONS_API_KEY: '  sk_test123456789  ' }), 'sk_test123456789');
  });

  test('maskKey masks secret parts and never reveals the whole key', () => {
    assert.equal(maskKey(null), null);
    assert.equal(maskKey(''), null);
    assert.equal(maskKey('1234'), '••••34');
    assert.equal(maskKey('sk_live_abcdef1234567890'), 'sk_live••••7890');
    assert.equal(maskKey('sk_live_abcdef1234567890').includes('abcdef'), false);
  });

  test('budget cap and monthly spend tracking with rollover', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollinations-test-'));
    try {
      const cfg = createPollinationsConfig({ dir: tmpDir, env: { POLLINATIONS_API_KEY: 'sk_mock_123' } });
      assert.equal(cfg.isConfigured(), true);
      assert.equal(cfg.isEnabled(), true);
      assert.equal(cfg.getSpendingPolicy(), 'allow_budgeted_only');
      assert.equal(cfg.isBudgetExhausted(), false);

      cfg.setMonthlyBudgetCapUsd(1.0);
      assert.equal(cfg.getMonthlyBudgetCapUsd(), 1.0);

      // Record request under cap
      cfg.recordRequestSuccess({ costUsd: 0.40, pollenSpent: 10 });
      assert.equal(cfg.getCurrentMonthSpendUsd(), 0.40);
      assert.equal(cfg.isBudgetExhausted(), false);

      // Record request exceeding cap
      cfg.recordRequestSuccess({ costUsd: 0.70, pollenSpent: 20 });
      assert.equal(cfg.getCurrentMonthSpendUsd(), 1.10);
      assert.equal(cfg.isBudgetExhausted(), true);

      // Setting policy to block stops all
      cfg.setSpendingPolicy('block');
      assert.equal(cfg.isBudgetExhausted(), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('model enabled toggling and custom models', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollinations-test2-'));
    try {
      const cfg = createPollinationsConfig({ dir: tmpDir, env: {} });
      const models = cfg.getModels();
      assert.ok(models.length >= 3);
      const m1 = models[0];

      cfg.setModelEnabled(m1.id, false);
      assert.equal(cfg.getModel(m1.id).enabled, false);

      cfg.setModelEnabled(m1.id, true);
      assert.equal(cfg.getModel(m1.id).enabled, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('pollinations-provider', () => {
  test('unconfigured returns not_configured and fails fast', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollinations-prov-'));
    try {
      const cfg = createPollinationsConfig({ dir: tmpDir, env: {} });
      const prov = createPollinationsProvider({ HttpError: MockHttpError, config: cfg });

      assert.equal(prov.configured(), false);
      const res = await prov.testConnection();
      assert.equal(res.ok, false);
      assert.equal(res.code, 'missing_key');

      await assert.rejects(
        async () => prov.generateImage({ prompt: 'test' }),
        /not configured/i
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('testConnection handles 200 OK with key metadata', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollinations-prov2-'));
    try {
      const cfg = createPollinationsConfig({ dir: tmpDir, env: { POLLINATIONS_API_KEY: 'sk_valid_key_12345' } });

      const mockFetch = async (url) => {
        if (url.includes('/account/key')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              valid: true,
              type: 'secret',
              pollenBudget: 15.5,
              userId: 'user_xyz'
            }),
            text: async () => '{}'
          };
        }
        if (url.includes('/account/balance')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ balance: 15.5 }),
            text: async () => '{}'
          };
        }
        if (url.includes('/image/models')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              { name: 'black-forest-labs/flux.1-schnell', title: 'FLUX.1 Schnell', publisher: 'BFL' }
            ],
            text: async () => '[]'
          };
        }
        return { ok: false, status: 404, text: async () => 'Not Found' };
      };

      const prov = createPollinationsProvider({ HttpError: MockHttpError, config: cfg, fetchFn: mockFetch });
      const res = await prov.testConnection();

      assert.equal(res.ok, true);
      assert.equal(res.status, 'ok');
      assert.equal(res.accountKeyInfo.pollenBudget, 15.5);
      assert.equal(prov.status().validation, 'ok');
      assert.equal(prov.status().maskedApiKey, 'sk_vali••••2345');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('testConnection maps 401 invalid key without leaking key', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollinations-prov3-'));
    try {
      const secret = 'sk_super_secret_unauthorized_token';
      const cfg = createPollinationsConfig({ dir: tmpDir, env: { POLLINATIONS_API_KEY: secret } });

      const mockFetch = async () => ({
        ok: false,
        status: 401,
        text: async () => '{"error":{"message":"Unauthorized key"}}'
      });

      const prov = createPollinationsProvider({ HttpError: MockHttpError, config: cfg, fetchFn: mockFetch });
      const res = await prov.testConnection();

      assert.equal(res.ok, false);
      assert.equal(res.status, 'invalid_api_key');
      assert.equal(res.code, 'invalid_api_key');
      assert.equal(res.message.includes(secret), false);
      assert.equal(JSON.stringify(prov.status()).includes(secret), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('testConnection maps 402 budget exhausted', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollinations-prov4-'));
    try {
      const cfg = createPollinationsConfig({ dir: tmpDir, env: { POLLINATIONS_API_KEY: 'sk_zero_budget' } });

      const mockFetch = async () => ({
        ok: false,
        status: 402,
        text: async () => '{"error":{"message":"Pollen budget exhausted"}}'
      });

      const prov = createPollinationsProvider({ HttpError: MockHttpError, config: cfg, fetchFn: mockFetch });
      const res = await prov.testConnection();

      assert.equal(res.ok, false);
      assert.equal(res.status, 'budget_exhausted');
      assert.equal(res.code, 'budget_exhausted');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('testModel sends exact prompt and verifies returned image data', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollinations-prov5-'));
    try {
      const cfg = createPollinationsConfig({ dir: tmpDir, env: { POLLINATIONS_API_KEY: 'sk_test_key' } });

      const mockFetch = async (url, opts) => {
        if (url.includes('/v1/images/generations')) {
          const body = JSON.parse(opts.body);
          assert.equal(body.model, 'tongyi-mai/z-image-turbo');
          assert.equal(body.size, '512x512');
          return {
            ok: true,
            status: 200,
            headers: { 'x-pollinations-cost': '0.004' },
            json: async () => ({
              created: 1700000000,
              data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }]
            }),
            text: async () => '{}'
          };
        }
        return { ok: false, status: 404, text: async () => 'Not found' };
      };

      const prov = createPollinationsProvider({ HttpError: MockHttpError, config: cfg, fetchFn: mockFetch });
      const res = await prov.testModel('tongyi-mai/z-image-turbo');

      assert.equal(res.ok, true);
      assert.equal(res.model, 'tongyi-mai/z-image-turbo');
      assert.equal(res.hasImage, true);
      assert.ok(res.responseTimeMs >= 0);
      assert.equal(res.costUsd, 0.004);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('generateImage generates real image and enforces budget cap', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pollinations-prov6-'));
    try {
      const cfg = createPollinationsConfig({ dir: tmpDir, env: { POLLINATIONS_API_KEY: 'sk_test_key' } });
      cfg.setMonthlyBudgetCapUsd(0.01); // Very low cap

      const mockFetch = async (url, opts) => {
        if (url.includes('/v1/images/generations')) {
          const body = JSON.parse(opts.body);
          assert.equal(body.prompt, 'Cyberpunk neon cat');
          return {
            ok: true,
            status: 200,
            headers: { 'x-pollinations-cost': '0.008' },
            json: async () => ({
              created: 1700000000,
              data: [{ url: 'https://media.pollinations.ai/image-xyz.png' }]
            }),
            text: async () => '{}'
          };
        }
        return { ok: false, status: 404, text: async () => 'Not found' };
      };

      const prov = createPollinationsProvider({ HttpError: MockHttpError, config: cfg, fetchFn: mockFetch });

      // First generation succeeds
      const gen1 = await prov.generateImage({ prompt: 'Cyberpunk neon cat' });
      assert.equal(gen1.url, 'https://media.pollinations.ai/image-xyz.png');
      assert.equal(gen1.prompt, 'Cyberpunk neon cat');

      // Now record additional cost to exhaust cap
      cfg.recordRequestSuccess({ costUsd: 0.005 });
      assert.equal(cfg.isBudgetExhausted(), true);

      // Second generation must be blocked by strict spending policy
      await assert.rejects(
        async () => prov.generateImage({ prompt: 'Another image' }),
        (err) => err.code === 'budget_exhausted' && err.status === 402
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
