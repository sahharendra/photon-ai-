'use strict';
// GroqCloud provider — unit tests (100% mocked, no real API calls, no credits consumed).
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
    read: async () => idx < chunks.length ? { done: false, value: chunks[idx++] } : { done: true, value: undefined },
    releaseLock: () => {},
  };
  return { getReader: () => reader };
}

describe('groq-config', () => {
  const { createGroqConfig, readEnvKey, maskKey, isGroqChatModel } = require('../groq-config');

  it('readEnvKey returns trimmed key or null', () => {
    assert.equal(readEnvKey({}), null);
    assert.equal(readEnvKey({ GROQ_API_KEY: '' }), null);
    assert.equal(readEnvKey({ GROQ_API_KEY: '  ' }), null);
    assert.equal(readEnvKey({ GROQ_API_KEY: 'gsk_test123' }), 'gsk_test123');
  });

  it('maskKey hides secret parts', () => {
    const masked = maskKey('gsk_1234567890abcdef123456');
    assert.ok(masked.startsWith('gsk_'));
    assert.ok(masked.includes('•'));
    assert.ok(!masked.includes('abcdef'));
    assert.equal(maskKey(''), '••••');
  });

  it('isGroqChatModel filters audio/whisper models', () => {
    assert.equal(isGroqChatModel('llama-3.3-70b-versatile'), true);
    assert.equal(isGroqChatModel('mixtral-8x7b-32768'), true);
    assert.equal(isGroqChatModel('whisper-large-v3'), false);
    assert.equal(isGroqChatModel('distil-whisper-large-v3-en'), false);
    assert.equal(isGroqChatModel(''), false);
  });

  it('saves and normalizes config properly in temp directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-cfg-'));
    try {
      const cfg = createGroqConfig({ dir: tmpDir, env: {} });
      assert.equal(cfg.isEnabled(), true);
      assert.equal(cfg.getSpendingPolicy(), 'allow_free_only');

      cfg.setSpendingPolicy('block');
      assert.equal(cfg.getSpendingPolicy(), 'block');

      cfg.setEnabled(false);
      assert.equal(cfg.isEnabled(), false);

      cfg.recordUsage({ model: 'llama-3.3-70b-versatile', ok: true, inputTokens: 50, outputTokens: 25 });
      const snap = cfg.snapshot();
      assert.equal(snap.usage.requests, 1);
      assert.equal(snap.usage.inputTokens, 50);
      assert.equal(snap.usage.outputTokens, 25);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('groq-provider', () => {
  const { createGroqProvider } = require('../groq-provider');
  const { createGroqConfig } = require('../groq-config');

  it('configured() reports false when GROQ_API_KEY is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-pvd-'));
    try {
      const p = createGroqProvider({
        HttpError,
        env: {},
        config: createGroqConfig({ dir: tmpDir, env: {} }),
      });
      assert.equal(p.configured(), false);
      assert.equal(p.enabled(), false);
      const st = p.status();
      assert.equal(st.configured, false);
      assert.equal(st.validation, 'not_configured');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('testConnection() succeeds with valid mock response', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-pvd-'));
    try {
      const mockFetch = makeFetch([
        {
          status: 200,
          body: {
            data: [
              { id: 'llama-3.3-70b-versatile', created: 1700000000, context_window: 131072 },
              { id: 'llama-3.1-8b-instant', created: 1700000000, context_window: 131072 },
              { id: 'whisper-large-v3', created: 1700000000 },
            ],
          },
        },
      ]);

      const p = createGroqProvider({
        HttpError,
        env: { GROQ_API_KEY: 'gsk_valid_key_12345678' },
        config: createGroqConfig({ dir: tmpDir, env: { GROQ_API_KEY: 'gsk_valid_key_12345678' } }),
        fetchImpl: mockFetch,
      });

      assert.equal(p.configured(), true);
      const res = await p.testConnection();
      assert.equal(res.ok, true);
      assert.equal(res.modelCount, 2); // whisper is filtered out
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('testConnection() maps 401 invalid key error without exposing key', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-pvd-'));
    try {
      const mockFetch = makeFetch([
        {
          status: 401,
          body: { error: { message: 'Invalid API Key', type: 'invalid_request_error' } },
        },
      ]);

      const p = createGroqProvider({
        HttpError,
        env: { GROQ_API_KEY: 'gsk_bad_key_secret_xyz' },
        config: createGroqConfig({ dir: tmpDir, env: { GROQ_API_KEY: 'gsk_bad_key_secret_xyz' } }),
        fetchImpl: mockFetch,
      });

      const res = await p.testConnection();
      assert.equal(res.ok, false);
      assert.equal(res.code, 'invalid_api_key');
      assert.ok(!JSON.stringify(res).includes('secret_xyz'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('generate() sends chat completion and parses response', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-pvd-'));
    try {
      const mockFetch = makeFetch([
        {
          status: 200,
          body: {
            id: 'chatcmpl-123',
            model: 'llama-3.3-70b-versatile',
            choices: [{ message: { role: 'assistant', content: 'Hello from Groq in English!' } }],
            usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
          },
          headers: {
            'x-ratelimit-remaining-requests': '99',
            'x-ratelimit-remaining-tokens': '9999',
          },
        },
      ]);

      const p = createGroqProvider({
        HttpError,
        env: { GROQ_API_KEY: 'gsk_valid_key_12345678' },
        config: createGroqConfig({ dir: tmpDir, env: { GROQ_API_KEY: 'gsk_valid_key_12345678' } }),
        fetchImpl: mockFetch,
      });

      const res = await p.generate({
        model: 'llama-3.3-70b-versatile',
        text: 'hello',
      });

      assert.equal(res.text, 'Hello from Groq in English!');
      assert.equal(res.usage.totalTokens, 20);

      const st = p.status();
      assert.equal(st.usage.requests, 1);
      assert.equal(st.rateLimits.remainingRequests, 99);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('generate() blocks requests when spendingPolicy is block', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-pvd-'));
    try {
      const cfg = createGroqConfig({ dir: tmpDir, env: { GROQ_API_KEY: 'gsk_valid_key' } });
      cfg.setSpendingPolicy('block');

      const p = createGroqProvider({
        HttpError,
        env: { GROQ_API_KEY: 'gsk_valid_key' },
        config: cfg,
        fetchImpl: makeFetch([]),
      });

      await assert.rejects(
        () => p.generate({ text: 'hi' }),
        err => err.status === 402 && err.code === 'billing_blocked'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('streamGenerate() yields deltas and final done', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groq-pvd-'));
    try {
      const sseBody = makeSseStream([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}',
        'data: {"choices":[{"delta":{"content":" there!"}}]}',
        'data: [DONE]',
      ]);

      const mockFetch = makeFetch([
        {
          status: 200,
          bodyStream: sseBody,
          headers: {},
        },
      ]);

      const p = createGroqProvider({
        HttpError,
        env: { GROQ_API_KEY: 'gsk_valid_key' },
        config: createGroqConfig({ dir: tmpDir, env: { GROQ_API_KEY: 'gsk_valid_key' } }),
        fetchImpl: mockFetch,
      });

      const events = [];
      for await (const chunk of p.streamGenerate({ model: 'llama-3.3-70b-versatile', text: 'hi' })) {
        events.push(chunk);
      }

      assert.equal(events[0].type, 'delta');
      assert.equal(events[0].text, 'Hi');
      assert.equal(events[1].type, 'delta');
      assert.equal(events[1].text, ' there!');
      assert.equal(events[2].type, 'done');
      assert.equal(events[2].text, 'Hi there!');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
