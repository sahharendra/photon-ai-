'use strict';
// Cohere API provider — unit tests (100% mocked, zero trial credits consumed).
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

describe('cohere-config', () => {
  const {
    createCohereConfig,
    readEnvKey,
    maskKey,
    isCohereChatModel,
    getUtcMonthKey,
  } = require('../cohere-config');

  it('readEnvKey returns trimmed key or null', () => {
    assert.equal(readEnvKey({}), null);
    assert.equal(readEnvKey({ COHERE_API_KEY: '' }), null);
    assert.equal(readEnvKey({ COHERE_API_KEY: '  ' }), null);
    assert.equal(readEnvKey({ COHERE_API_KEY: 'co_test_key_12345' }), 'co_test_key_12345');
  });

  it('maskKey hides secret parts', () => {
    const masked = maskKey('cohere_secret_key_abcdef1234');
    assert.ok(masked.startsWith('cohere'));
    assert.ok(masked.endsWith('1234'));
    assert.ok(masked.includes('•'));
    assert.ok(!masked.includes('abcdef'));
    assert.equal(maskKey(''), '••••');
  });

  it('isCohereChatModel filters embedding, rerank, and non-chat models', () => {
    assert.equal(isCohereChatModel('command-r-08-2024'), true);
    assert.equal(isCohereChatModel('command-r-plus'), true);
    assert.equal(isCohereChatModel('c4ai-aya-expanse-32b'), true);
    assert.equal(isCohereChatModel('embed-english-v3.0'), false);
    assert.equal(isCohereChatModel('rerank-v3.5'), false);
    assert.equal(isCohereChatModel('classify-2022-02-15'), false);
    assert.equal(isCohereChatModel(''), false);
  });

  it('getUtcMonthKey formats YYYY-MM in UTC', () => {
    const month = getUtcMonthKey(Date.UTC(2026, 10, 20));
    assert.equal(month, '2026-11');
  });

  it('tracks monthly trial requests and rolls over on month boundary', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-cfg-'));
    try {
      let mockTime = Date.UTC(2026, 10, 20); // November 2026
      const cfg = createCohereConfig({ dir: tmpDir, env: {}, now: () => mockTime });

      assert.equal(cfg.isEnabled(), true);
      assert.equal(cfg.getKeyType(), 'trial');
      assert.equal(cfg.getMonthlyTrialLimit(), 1000);
      assert.equal(cfg.getRemainingTrialRequests(), 1000);
      assert.equal(cfg.isMonthlyTrialExhausted(), false);

      // Record trial requests
      cfg.recordUsage({ model: 'command-r', ok: true, inputTokens: 50, outputTokens: 25 });
      assert.equal(cfg.getRemainingTrialRequests(), 999);

      // Simulate reaching limit
      cfg.setMonthlyTrialLimit(10);
      for (let i = 0; i < 9; i++) {
        cfg.recordUsage({ model: 'command-r', ok: true, inputTokens: 10, outputTokens: 10 });
      }
      assert.equal(cfg.isMonthlyTrialExhausted(), true);
      assert.equal(cfg.getRemainingTrialRequests(), 0);

      // Simulate month rollover to December 2026
      mockTime = Date.UTC(2026, 11, 1);
      assert.equal(cfg.isMonthlyTrialExhausted(), false);
      assert.equal(cfg.getRemainingTrialRequests(), 10);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('cohere-provider', () => {
  const { createCohereConfig } = require('../cohere-config');
  const { createCohereProvider } = require('../cohere-provider');

  it('missing key -> configured() is false and testConnection returns not_configured', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-p1-'));
    try {
      const cfg = createCohereConfig({ dir: tmpDir, env: {} });
      const provider = createCohereProvider({ HttpError, env: {}, config: cfg, fetchImpl: makeFetch([]) });
      assert.equal(provider.configured(), false);

      const conn = await provider.testConnection();
      assert.equal(conn.ok, false);
      assert.equal(conn.code, 'not_configured');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('valid key -> testConnection discovers models and labels Trial – Development Only', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-p2-'));
    const env = { COHERE_API_KEY: 'cohere_valid_test_key_9999' };
    try {
      const cfg = createCohereConfig({ dir: tmpDir, env });
      const fetchImpl = makeFetch([
        {
          status: 200,
          body: {
            models: [
              { name: 'command-r-08-2024', endpoints: ['chat'], context_length: 128000 },
              { name: 'embed-english-v3.0', endpoints: ['embed'] }, // filtered out
            ],
          },
        },
      ]);
      const provider = createCohereProvider({ HttpError, env, config: cfg, fetchImpl });
      assert.equal(provider.configured(), true);

      const conn = await provider.testConnection();
      assert.equal(conn.ok, true);
      assert.equal(conn.status, 'connected');
      assert.ok(conn.modelCount >= 1);
      assert.ok(conn.maskedKey.includes('•'));
      assert.ok(!conn.maskedKey.includes('test_key'));

      const st = provider.status();
      assert.equal(st.configured, true);
      assert.equal(st.validation, 'ok');
      assert.equal(st.keyTypeLabel, 'Trial – Development Only');
      assert.equal(st.protocol, 'Cohere API v2');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('invalid key (401) -> maps to invalid_api_key without leaking key', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-p3-'));
    const env = { COHERE_API_KEY: 'bad_key_secret_123' };
    try {
      const cfg = createCohereConfig({ dir: tmpDir, env });
      const fetchImpl = makeFetch([
        {
          status: 401,
          body: { message: 'invalid api token' },
        },
      ]);
      const provider = createCohereProvider({ HttpError, env, config: cfg, fetchImpl });
      const conn = await provider.testConnection();
      assert.equal(conn.ok, false);
      assert.equal(conn.code, 'invalid_api_key');
      assert.ok(!JSON.stringify(conn).includes('bad_key_secret_123'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('strict trial protection: blocks commercial production traffic under trial key', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-p4-'));
    const env = { COHERE_API_KEY: 'cohere_trial_key' };
    try {
      const cfg = createCohereConfig({ dir: tmpDir, env });
      const provider = createCohereProvider({ HttpError, env, config: cfg, fetchImpl: makeFetch([]) });

      // Customer traffic in production with trial key MUST be blocked
      await assert.rejects(
        () => provider.generate({ model: 'command-r', text: 'Hello', isProductionTraffic: true }),
        err => err.code === 'trial_restricted'
      );

      // Development / test requests are allowed
      const devFetch = async () => ({
        ok: true,
        status: 200,
        headers: {},
        json: async () => ({
          message: { role: 'assistant', content: [{ type: 'text', text: 'Dev test response' }] },
          usage: { tokens: { input_tokens: 5, output_tokens: 3 } },
        }),
      });
      const devProvider = createCohereProvider({ HttpError, env, config: cfg, fetchImpl: devFetch });
      const res = await devProvider.generate({ model: 'command-r', text: 'Hello', isProductionTraffic: false });
      assert.equal(res.text, 'Dev test response');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('generate() sends Cohere v2 payload and extracts content and usage', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-p5-'));
    const env = { COHERE_API_KEY: 'cohere_key_123' };
    try {
      const cfg = createCohereConfig({ dir: tmpDir, env });
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
            id: 'gen-uuid-1',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'PHOTON Cohere integration successful.' }],
            },
            usage: {
              tokens: { input_tokens: 14, output_tokens: 6 },
            },
          }),
        };
      };

      const provider = createCohereProvider({ HttpError, env, config: cfg, fetchImpl });
      const res = await provider.generate({
        model: 'command-r-08-2024',
        system: 'You are Photon.',
        text: 'Reply with: PHOTON Cohere integration successful.',
      });

      assert.equal(res.text, 'PHOTON Cohere integration successful.');
      assert.equal(res.usage.totalTokens, 20);
      assert.equal(capturedHeaders.Authorization, 'Bearer cohere_key_123');
      assert.equal(capturedBody.model, 'command-r-08-2024');
      assert.ok(capturedBody.messages.some(m => m.role === 'system'));
      assert.ok(capturedBody.messages.some(m => m.role === 'user'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('streamGenerate() yields delta events and final done payload', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-p6-'));
    const env = { COHERE_API_KEY: 'cohere_key_123' };
    try {
      const cfg = createCohereConfig({ dir: tmpDir, env });
      const streamBody = makeSseStream([
        'data: {"delta":{"message":{"content":{"text":"Hello"}}}}',
        'data: {"delta":{"message":{"content":{"text":" from Cohere v2!"}}}}',
        'data: [DONE]',
      ]);
      const fetchImpl = async () => ({
        ok: true,
        status: 200,
        headers: {},
        body: streamBody,
      });

      const provider = createCohereProvider({ HttpError, env, config: cfg, fetchImpl });
      const events = [];
      for await (const ev of provider.streamGenerate({ model: 'command-r', text: 'Hi' })) {
        events.push(ev);
      }

      assert.equal(events.length, 3);
      assert.equal(events[0].type, 'delta');
      assert.equal(events[0].text, 'Hello');
      assert.equal(events[1].type, 'delta');
      assert.equal(events[1].text, ' from Cohere v2!');
      assert.equal(events[2].type, 'done');
      assert.equal(events[2].text, 'Hello from Cohere v2!');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('testModel() sends prompt to exact model and reports latency', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-p7-'));
    const env = { COHERE_API_KEY: 'cohere_key_123' };
    try {
      const cfg = createCohereConfig({ dir: tmpDir, env });
      const fetchImpl = async () => ({
        ok: true,
        status: 200,
        headers: {},
        json: async () => ({
          message: { role: 'assistant', content: [{ type: 'text', text: 'PHOTON Cohere integration successful.' }] },
          usage: { tokens: { input_tokens: 10, output_tokens: 5 } },
        }),
      });

      const provider = createCohereProvider({ HttpError, env, config: cfg, fetchImpl });
      const result = await provider.testModel('command-r-08-2024');
      assert.equal(result.ok, true);
      assert.equal(result.model, 'command-r-08-2024');
      assert.equal(result.status, 'working');
      assert.ok(result.responseTimeMs >= 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('model discovery handles endpoint=chat, page_size=1000, pagination, and excludes deprecated models', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-p8-'));
    const env = { COHERE_API_KEY: 'cohere_pagination_key' };
    const recordedUrls = [];
    try {
      const cfg = createCohereConfig({ dir: tmpDir, env });
      const fetchImpl = async (url) => {
        recordedUrls.push(url.toString());
        if (recordedUrls.length === 1) {
          return {
            ok: true,
            status: 200,
            headers: {},
            json: async () => ({
              models: [
                { name: 'command-r-08-2024', endpoints: ['chat'], is_deprecated: false },
                { name: 'old-deprecated-chat', endpoints: ['chat'], is_deprecated: true },
              ],
              next_page_token: 'page2_token',
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: {},
          json: async () => ({
            models: [
              { name: 'c4ai-aya-expanse-32b', endpoints: ['chat'] },
            ],
          }),
        };
      };

      const provider = createCohereProvider({ HttpError, env, config: cfg, fetchImpl });
      const discovered = await provider.refreshModels(true);
      assert.ok(recordedUrls[0].includes('endpoint=chat'));
      assert.ok(recordedUrls[0].includes('page_size=1000'));
      assert.ok(recordedUrls[1].includes('page_token=page2_token'));

      const ids = discovered.map(m => m.id);
      assert.ok(ids.includes('command-r-08-2024'));
      assert.ok(ids.includes('c4ai-aya-expanse-32b'));
      assert.ok(!ids.includes('old-deprecated-chat'), 'deprecated model must be excluded');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
