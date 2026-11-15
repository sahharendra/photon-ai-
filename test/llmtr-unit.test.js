'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  createLlmtrConfig,
  readEnvKey,
  maskKey,
  isLlmtrChatModel,
  isModelFree,
  DEFAULT_LLMTR_MODELS,
} = require('../llmtr-config');

const {
  createLlmtrProvider,
  validationMessage,
} = require('../llmtr-provider');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

describe('llmtr-config', () => {
  it('readEnvKey reads LLMTR_API_KEY and FREELLMAPI_API_KEY', () => {
    assert.equal(readEnvKey({}), null);
    assert.equal(readEnvKey({ LLMTR_API_KEY: '  llmt.test1234  ' }), 'llmt.test1234');
    assert.equal(readEnvKey({ FREELLMAPI_API_KEY: 'free-key' }), 'free-key');
  });

  it('maskKey masks secret parts', () => {
    assert.equal(maskKey(null), null);
    assert.equal(maskKey('short'), '••••rt');
    assert.equal(maskKey('llmt.7659abc1234'), 'llmt.••••1234');
  });

  it('isModelFree identifies free models', () => {
    assert.equal(isModelFree('openai/gpt-5.4-mini'), true);
    assert.equal(isModelFree({ id: 'any-model', pricing: { prompt: 0, completion: 0 } }), true);
    assert.equal(isModelFree({ id: 'paid-model', pricing: { prompt: 0.001, completion: 0.002 } }), false);
  });

  it('isLlmtrChatModel filters non-chat models', () => {
    assert.equal(isLlmtrChatModel('openai/gpt-5.4-mini'), true);
    assert.equal(isLlmtrChatModel('whisper-large-v3'), false);
    assert.equal(isLlmtrChatModel('text-embedding-004'), false);
  });

  it('manages state in temp directory cleanly', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmtr-test-'));
    try {
      const cfg = createLlmtrConfig({ dir: tmp, env: { LLMTR_API_KEY: 'llmt.test-key' } });
      assert.equal(cfg.isEnabled(), false);
      cfg.setEnabled(true);
      assert.equal(cfg.isEnabled(), true);

      assert.equal(cfg.getSpendingPolicy(), 'block');
      cfg.setSpendingPolicy('allow_free_only');
      assert.equal(cfg.getSpendingPolicy(), 'allow_free_only');

      const snap = cfg.snapshot();
      assert.equal(snap.provider, 'LLMTR');
      assert.equal(snap.enabled, true);
      assert.equal(snap.spendingPolicy, 'allow_free_only');
      assert.ok(Object.keys(snap.models).length >= 4);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('llmtr-provider', () => {
  it('configured() returns false when no key, true when key present', () => {
    const p1 = createLlmtrProvider({ HttpError, env: {} });
    assert.equal(p1.configured(), false);

    const p2 = createLlmtrProvider({ HttpError, env: { LLMTR_API_KEY: 'llmt.1234' } });
    assert.equal(p2.configured(), true);
  });

  it('status() masks raw API key', () => {
    const p = createLlmtrProvider({ HttpError, env: { LLMTR_API_KEY: 'llmt.7659verysecret' } });
    const st = p.status();
    assert.equal(st.configured, true);
    assert.ok(!JSON.stringify(st).includes('verysecret'));
    assert.match(st.maskedKey, /••••/);
  });

  it('catalogEntries() auto-enables and returns seeded models', () => {
    const p = createLlmtrProvider({ HttpError, env: { LLMTR_API_KEY: 'llmt.1234' } });
    const entries = p.catalogEntries();
    assert.ok(entries.length >= 4);
    assert.ok(entries.some(m => m.id === 'openai/gpt-5.4-mini'));
    assert.ok(entries.every(m => m.provider === 'LLMTR'));
  });

  it('maps errors correctly', () => {
    const p = createLlmtrProvider({ HttpError, env: {} });
    assert.equal(p.mapError({ status: 401 }).code, 'invalid_api_key');
    assert.equal(p.mapError({ status: 403 }).code, 'provider_forbidden');
    assert.equal(p.mapError({ status: 402 }).code, 'billing_required');
    assert.equal(p.mapError({ status: 429 }).code, 'quota_or_rate_limit');
    assert.equal(p.mapError({ status: 404 }).code, 'invalid_model');
    assert.equal(p.mapError({ status: 504 }).code, 'provider_timeout');
  });

  it('enforces spending policy', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmtr-spend-'));
    try {
      const cfg = createLlmtrConfig({ dir: tmp, env: { LLMTR_API_KEY: 'llmt.1234' } });
      const p = createLlmtrProvider({ HttpError, env: { LLMTR_API_KEY: 'llmt.1234' }, cfg, dir: tmp });

      // Default policy is block -> throws billing_blocked
      cfg.setEnabled(true);
      cfg.setSpendingPolicy('block');
      await assert.rejects(
        () => p.generate({ model: 'openai/gpt-5.4-mini', text: 'hi' }),
        { code: 'billing_blocked' }
      );

      // allow_free_only blocks paid model
      cfg.state.models['paid-test-model'] = { id: 'paid-test-model', free: false };
      cfg.setSpendingPolicy('allow_free_only');
      await assert.rejects(
        () => p.generate({ model: 'paid-test-model', text: 'hi' }),
        { code: 'billing_required' }
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('generate() calls chat completions endpoint with mock fetch', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmtr-gen-'));
    try {
      const mockFetch = async (url, opts) => {
        assert.ok(url.includes('/chat/completions'));
        assert.equal(opts.headers.Authorization, 'Bearer llmt.validkey');
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'Hello from LLMTR!' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        };
      };

      const cfg = createLlmtrConfig({ dir: tmp, env: { LLMTR_API_KEY: 'llmt.validkey' } });
      cfg.setEnabled(true);
      cfg.setSpendingPolicy('allow_free_only');
      const p = createLlmtrProvider({
        HttpError,
        env: { LLMTR_API_KEY: 'llmt.validkey' },
        cfg,
        fetchImpl: mockFetch,
        dir: tmp,
      });

      const res = await p.generate({
        model: 'openai/gpt-5.4-mini',
        text: 'hello',
      });

      assert.equal(res.text, 'Hello from LLMTR!');
      assert.equal(res.usage.totalTokens, 15);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('testConnection() returns success with mock fetch', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 'openai/gpt-5.4-mini', name: 'GPT-5.4 Mini' },
          { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5' },
        ],
      }),
    });

    const p = createLlmtrProvider({
      HttpError,
      env: { LLMTR_API_KEY: 'llmt.validkey' },
      fetchImpl: mockFetch,
    });

    const res = await p.testConnection();
    assert.equal(res.ok, true);
    assert.equal(res.modelCount, 2);
  });
});
