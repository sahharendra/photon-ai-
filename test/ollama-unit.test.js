'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  createOllamaConfig,
  readEnvKey,
  readEnvBaseUrl,
  maskKey,
  isOllamaChatModel,
  isModelFree,
  DEFAULT_OLLAMA_MODELS,
} = require('../ollama-config');

const {
  createOllamaProvider,
} = require('../ollama-provider');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

describe('ollama-config', () => {
  it('readEnvKey reads OLLAMA_API_KEY and OLLAMA_KEY', () => {
    assert.equal(readEnvKey({}), null);
    assert.equal(readEnvKey({ OLLAMA_API_KEY: '  8087c294test  ' }), '8087c294test');
    assert.equal(readEnvKey({ OLLAMA_KEY: 'test-key-2' }), 'test-key-2');
  });

  it('readEnvBaseUrl defaults to ollama.com when key present, localhost when not', () => {
    assert.equal(readEnvBaseUrl({}), 'http://127.0.0.1:11434');
    assert.equal(readEnvBaseUrl({ OLLAMA_API_KEY: 'my-key' }), 'https://ollama.com');
    assert.equal(readEnvBaseUrl({ OLLAMA_BASE_URL: 'http://custom:11434/' }), 'http://custom:11434');
  });

  it('maskKey masks secret parts', () => {
    assert.equal(maskKey(null), null);
    assert.equal(maskKey('short'), '••••rt');
    assert.equal(maskKey('8087c29412345678'), '8087c••••5678');
  });

  it('isModelFree identifies free models', () => {
    assert.equal(isModelFree('gemma4:31b'), true);
    assert.equal(isModelFree('deepseek-v4.1-flash'), true);
    assert.equal(isModelFree({ id: 'any-model', free: true }), true);
  });

  it('isOllamaChatModel filters non-chat models', () => {
    assert.equal(isOllamaChatModel('gemma4:31b'), true);
    assert.equal(isOllamaChatModel('whisper-large-v3'), false);
    assert.equal(isOllamaChatModel('text-embedding-004'), false);
  });

  it('manages state in temp directory cleanly', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-test-'));
    try {
      const cfg = createOllamaConfig({ dir: tmp, env: { OLLAMA_API_KEY: '8087c294-test' } });
      assert.equal(cfg.isEnabled(), true);
      assert.equal(cfg.getSpendingPolicy(), 'allow_free_only');

      cfg.setSpendingPolicy('allow_all');
      assert.equal(cfg.getSpendingPolicy(), 'allow_all');

      const snap = cfg.snapshot();
      assert.equal(snap.enabled, true);
      assert.equal(snap.spendingPolicy, 'allow_all');
      assert.equal(snap.hasKey, true);
      assert.match(snap.maskedKey, /8087c••••/);
      assert.ok(snap.modelCount >= 5);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('ollama-provider', () => {
  it('configured() returns true when key or local endpoint present', () => {
    const p1 = createOllamaProvider({ HttpError, env: {} });
    assert.equal(p1.configured(), true); // local fallback allowed by default

    const p2 = createOllamaProvider({ HttpError, env: { OLLAMA_ENABLED: '0' } });
    assert.equal(p2.configured(), false); // disabled

    const p3 = createOllamaProvider({ HttpError, env: { OLLAMA_API_KEY: '8087c294' } });
    assert.equal(p3.configured(), true);
    assert.equal(p3.isCloud(), true);
  });

  it('status() masks raw API key', () => {
    const p = createOllamaProvider({ HttpError, env: { OLLAMA_API_KEY: '8087c294verysecret' } });
    const st = p.status();
    assert.equal(st.configured, true);
    assert.ok(!JSON.stringify(st).includes('verysecret'));
    assert.match(st.maskedKey, /••••/);
  });

  it('catalogEntries() returns seeded models', () => {
    const p = createOllamaProvider({ HttpError, env: { OLLAMA_API_KEY: '8087c294' } });
    const entries = p.catalogEntries();
    assert.ok(entries.length >= 5);
    assert.ok(entries.some(m => m.id === 'gemma4:31b'));
    assert.ok(entries.some(m => m.id === 'deepseek-v4.1-flash'));
  });

  it('generate() calls fetch with Bearer token', async () => {
    let capturedHeaders = null;
    let capturedUrl = null;
    const mockFetch = async (url, opts) => {
      capturedUrl = url;
      capturedHeaders = opts.headers;
      return {
        ok: true,
        json: async () => ({
          model: 'gemma4:31b',
          message: { role: 'assistant', content: 'Hello from Ollama Cloud!' },
          prompt_eval_count: 5,
          eval_count: 10,
        }),
      };
    };

    const p = createOllamaProvider({
      HttpError,
      env: { OLLAMA_API_KEY: '8087c294secret' },
      fetchImpl: mockFetch,
    });

    const res = await p.generate({
      model: 'gemma4:31b',
      text: 'Hello!',
    });

    assert.equal(res.text, 'Hello from Ollama Cloud!');
    assert.equal(capturedUrl, 'https://ollama.com/api/chat');
    assert.equal(capturedHeaders['Authorization'], 'Bearer 8087c294secret');
    assert.equal(res.usage.inputTokens, 5);
    assert.equal(res.usage.outputTokens, 10);
  });
});
