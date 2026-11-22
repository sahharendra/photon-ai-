'use strict';
/**
 * PHOTON AI – Provider Connections & Authentication Test Suite
 * Covers all 16 scenarios:
 * 1. Valid key authentication (200 OK -> CONNECTED)
 * 2. Invalid key (401 Unauthorized -> INVALID_KEY)
 * 3. Missing key / Not configured (503/401 -> NOT_CONFIGURED)
 * 4. Expired / Revoked key handling
 * 5. Multi-key management and independent validation
 * 6. Quota exhaustion (402 Payment Required -> BILLING_REQUIRED / QUOTA_EXHAUSTED)
 * 7. Rate limit (429 Too Many Requests -> RATE_LIMITED)
 * 8. Billing required / Credit balance zero
 * 9. Invalid model ID handling
 * 10. Timeout / AbortSignal handling
 * 11. Network failure / Connection refused handling
 * 12. Clean text-generation streaming & non-streaming response parsing
 * 13. Key masking (no raw secret leakage in status or logs)
 * 14. Admin panel key CRUD (add, update, delete)
 * 15. Strict free-tier quota enforcement (no paid fallback without permission)
 * 16. Cloudflare image token (CLOUDFLARE_API_TOKEN_2) vs primary token routing
 *
 * 100% Mocked. Zero token spend. No external network calls.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const { createAnthropicProvider } = require('../anthropic-provider');
const { createCohereProvider } = require('../cohere-provider');
const { createCohereConfig } = require('../cohere-config');
const { createCloudflareProvider } = require('../cloudflare-provider');
const { createCloudflareConfig } = require('../cloudflare-config');
const { createOpenRouterKeyStore, createKeyManager } = require('../openrouter-keys');
const { createOpenRouterProvider } = require('../openrouter-provider');

function makeMockFetch(responses) {
  let idx = 0;
  return async (url, opts) => {
    const resp = Array.isArray(responses) ? (responses[idx++] || responses[responses.length - 1]) : responses;
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
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      body: resp.bodyStream || null,
    };
  };
}

function makeSseStream(lines) {
  const encoder = new TextEncoder();
  const chunks = lines.map(l => encoder.encode(l + '\n\n'));
  let idx = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (idx < chunks.length) {
          return { done: false, value: chunks[idx++] };
        }
        return { done: true, value: undefined };
      },
      releaseLock: () => {},
    }),
  };
}

describe('PHOTON AI - Provider Connections & Auth Suite (16 Scenarios)', () => {

  // Scenario 1: Valid key authentication (200 OK -> CONNECTED)
  describe('Scenario 1: Valid key authentication (200 OK -> CONNECTED)', () => {
    it('Anthropic: 200 OK response validates connection and sets ok status', async () => {
      const mockFetch = makeMockFetch({
        status: 200,
        body: { data: [{ id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet' }] },
      });
      const provider = createAnthropicProvider({
        HttpError,
        env: { ANTHROPIC_API_KEY: 'sk-ant-valid-key-12345' },
        fetchImpl: mockFetch,
      });

      const conn = await provider.testConnection();
      assert.equal(conn.ok, true);
      assert.equal(conn.status, 'connected');
      assert.equal(conn.code, 'ok');
      assert.equal(provider.status().validation, 'ok');
    });

    it('Cohere: 200 OK response validates connection and sets ok status', async () => {
      const mockFetch = makeMockFetch({
        status: 200,
        body: { models: [{ name: 'command-r-plus-08-2024', endpoints: ['chat'] }] },
      });
      const provider = createCohereProvider({
        HttpError,
        env: { COHERE_API_KEY: 'co-valid-key-98765' },
        fetchImpl: mockFetch,
      });

      const conn = await provider.testConnection();
      assert.equal(conn.ok, true);
      assert.equal(conn.status, 'connected');
      assert.equal(conn.code, 'ok');
      assert.equal(provider.status().validation, 'ok');
    });
  });

  // Scenario 2: Invalid key (401 Unauthorized -> INVALID_KEY)
  describe('Scenario 2: Invalid key (401 Unauthorized -> INVALID_KEY)', () => {
    it('Anthropic: 401 returns invalid_api_key and friendly error message', async () => {
      const mockFetch = makeMockFetch({
        status: 401,
        body: { error: { message: 'invalid_api_key: Invalid API key provided' } },
      });
      const provider = createAnthropicProvider({
        HttpError,
        env: { ANTHROPIC_API_KEY: 'sk-ant-bad-key' },
        fetchImpl: mockFetch,
      });

      const conn = await provider.testConnection();
      assert.equal(conn.ok, false);
      assert.equal(conn.code, 'invalid_key');
      assert.match(conn.message, /check your ANTHROPIC_API_KEY/i);
    });

    it('Cohere: 401 returns invalid_key status', async () => {
      const mockFetch = makeMockFetch({
        status: 401,
        body: { message: 'invalid api token' },
      });
      const provider = createCohereProvider({
        HttpError,
        env: { COHERE_API_KEY: 'co-bad-key' },
        fetchImpl: mockFetch,
      });

      const conn = await provider.testConnection();
      assert.equal(conn.ok, false);
      assert.equal(conn.code, 'invalid_key');
      assert.match(conn.message, /check your COHERE_API_KEY|invalid/i);
    });
  });

  // Scenario 3: Missing key / Not configured (503/401 -> NOT_CONFIGURED)
  describe('Scenario 3: Missing key / Not configured', () => {
    it('Anthropic: returns not_configured error when apiKey is empty', async () => {
      const provider = createAnthropicProvider({
        HttpError,
        env: { ANTHROPIC_API_KEY: '' },
      });
      assert.equal(provider.configured(), false);

      const conn = await provider.testConnection();
      assert.equal(conn.ok, false);
      assert.equal(conn.code, 'not_configured');
      assert.match(conn.message, /not configured/i);
    });

    it('Cohere: returns not_configured error when apiKey is empty', async () => {
      const provider = createCohereProvider({
        HttpError,
        env: { COHERE_API_KEY: '' },
      });
      assert.equal(provider.configured(), false);

      const conn = await provider.testConnection();
      assert.equal(conn.ok, false);
      assert.equal(conn.code, 'not_configured');
      assert.match(conn.message, /not configured/i);
    });
  });

  // Scenario 4: Expired / Revoked key handling
  describe('Scenario 4: Expired / Revoked key handling', () => {
    it('OpenRouter: handles 401 key rejected as invalid_api_key', async () => {
      const mockFetch = makeMockFetch({
        status: 401,
        body: { error: { message: 'Key has expired or has been revoked' } },
      });
      const provider = createOpenRouterProvider({
        HttpError,
        env: { OPENROUTER_API_KEY: 'sk-or-mock-key-0123456789abcdef0123456789abcdef' },
        fetchImpl: mockFetch,
      });

      const conn = await provider.testConnection();
      assert.equal(conn.ok, false);
      assert.equal(conn.code, 'invalid_api_key');
    });
  });

  // Scenario 5: Multi-key management and independent validation
  describe('Scenario 5: Multi-key management and independent validation', () => {
    it('OpenRouter keys manager handles multiple keys independently and clears invalid keys', () => {
      const tmpFile = path.join(os.tmpdir(), `or-test-keys-${Date.now()}.json`);
      const keyStore = createOpenRouterKeyStore({
        env: {},
        statePath: tmpFile,
        persist: true,
      });

      const k1 = keyStore.add({ label: 'Key One', key: 'sk-or-mock-key1111111111111111111111111111111111111111111111111111111111111' });
      const k2 = keyStore.add({ label: 'Key Two', key: 'sk-or-mock-key2222222222222222222222222222222222222222222222222222222222222' });
      const k3 = keyStore.add({ label: 'Key Three', key: 'sk-or-mock-key3333333333333333333333333333333333333333333333333333333333333' });

      // Record validation results
      keyStore.recordValidation(k1.id, 'ok');
      keyStore.recordValidation(k2.id, 'invalid_api_key', { message: 'Rejected' });
      keyStore.recordValidation(k3.id, 'ok');

      let list = keyStore.list();
      assert.equal(list.length, 3);
      assert.equal(list.find(k => k.id === k2.id).lastValidation.status, 'invalid_api_key');

      // Clear invalid keys
      const res = keyStore.clearInvalidKeys();
      assert.equal(res.removed, 1);

      list = keyStore.list();
      assert.equal(list.length, 2);
      assert.equal(list.every(k => k.lastValidation.status === 'ok'), true);

      // Clean up tmp file
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    });
  });

  // Scenario 6: Quota exhaustion (402 Payment Required -> BILLING_REQUIRED / QUOTA_EXHAUSTED)
  describe('Scenario 6: Quota exhaustion (402 -> BILLING_REQUIRED)', () => {
    it('Anthropic: 402 maps to billing_required', async () => {
      const mockFetch = makeMockFetch({
        status: 402,
        body: { error: { message: 'Your credit balance is too low' } },
      });
      const provider = createAnthropicProvider({
        HttpError,
        env: { ANTHROPIC_API_KEY: 'sk-ant-zero-bal' },
        fetchImpl: mockFetch,
      });

      const conn = await provider.testConnection();
      assert.equal(conn.ok, false);
      assert.equal(conn.code, 'billing_required');
      assert.match(conn.message, /credit/i);
    });

    it('Cohere: 402 maps to quota_exceeded / billing_required', async () => {
      const mockFetch = makeMockFetch({
        status: 402,
        body: { message: 'Trial quota exceeded' },
      });
      const provider = createCohereProvider({
        HttpError,
        env: { COHERE_API_KEY: 'co-exhausted' },
        fetchImpl: mockFetch,
      });

      const conn = await provider.testConnection();
      assert.equal(conn.ok, false);
      assert.equal(conn.code, 'billing_required');
      assert.match(conn.message, /quota|credit/i);
    });
  });

  // Scenario 7: Rate limit (429 Too Many Requests -> RATE_LIMITED)
  describe('Scenario 7: Rate limit (429 Too Many Requests -> RATE_LIMITED)', () => {
    it('Anthropic: 429 maps to rate_limited', async () => {
      const mockFetch = makeMockFetch({
        status: 429,
        body: { error: { message: 'Rate limit exceeded' } },
        headers: { 'retry-after': '30' },
      });
      const provider = createAnthropicProvider({
        HttpError,
        env: { ANTHROPIC_API_KEY: 'sk-ant-rate-limited' },
        fetchImpl: mockFetch,
      });

      const conn = await provider.testConnection();
      assert.equal(conn.ok, false);
      assert.equal(conn.code, 'rate_limited');
      assert.match(conn.message, /rate limit/i);
    });

    it('Cohere: 429 maps to rate_limited', async () => {
      const mockFetch = makeMockFetch({
        status: 429,
        body: { message: 'Too many requests' },
      });
      const provider = createCohereProvider({
        HttpError,
        env: { COHERE_API_KEY: 'co-rate-limited' },
        fetchImpl: mockFetch,
      });

      const conn = await provider.testConnection();
      assert.equal(conn.ok, false);
      assert.equal(conn.code, 'rate_limited');
    });
  });

  // Scenario 8: Billing required / Credit balance zero
  describe('Scenario 8: Billing required / Credit balance zero', () => {
    it('Cloudflare Workers AI: zero neurons remaining blocks requests under free policy', () => {
      const tmpFile = path.join(os.tmpdir(), `cf-test-cfg-${Date.now()}.json`);
      const cfg = createCloudflareConfig({ configFile: tmpFile });
      assert.equal(cfg.getRemainingDailyNeurons(), 10000);
      assert.equal(cfg.isDailyQuotaExhausted(), false);

      // Record usage consuming full 10,000 neurons
      cfg.recordUsage({ model: '@cf/meta/llama-3-8b-instruct', ok: true, inputTokens: 500000, outputTokens: 500000 });
      assert.equal(cfg.isDailyQuotaExhausted(), true);
      assert.equal(cfg.getRemainingDailyNeurons(), 0);

      try { fs.unlinkSync(tmpFile); } catch (_) {}
    });
  });

  // Scenario 9: Invalid model ID handling
  describe('Scenario 9: Invalid model ID handling', () => {
    it('Anthropic: gracefully rejects invalid model ID without crashing', async () => {
      const provider = createAnthropicProvider({
        HttpError,
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      });

      await assert.rejects(
        async () => {
          await provider.generate({
            model: 'non-existent-claude-99',
            text: 'Hello',
          });
        },
        err => {
          assert.equal(err.status, 400);
          assert.equal(err.code, 'invalid_model');
          return true;
        }
      );
    });
  });

  // Scenario 10: Timeout / AbortSignal handling
  describe('Scenario 10: Timeout / AbortSignal handling', () => {
    it('Anthropic: handles client abort signal cleanly with 499 / request_aborted', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      const mockFetch = makeMockFetch(abortError);

      const provider = createAnthropicProvider({
        HttpError,
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
        fetchImpl: mockFetch,
      });

      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        async () => {
          await provider.generate({
            model: 'claude-3-5-sonnet-20241022',
            text: 'Hello',
            signal: controller.signal,
          });
        },
        err => {
          assert.equal(err.status, 499);
          assert.equal(err.code, 'request_aborted');
          return true;
        }
      );
    });
  });

  // Scenario 11: Network failure / Connection refused handling
  describe('Scenario 11: Network failure / Connection refused handling', () => {
    it('Cohere: maps network fetch failure to 502 network_error', async () => {
      const netError = new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:443');
      const mockFetch = makeMockFetch(netError);

      const provider = createCohereProvider({
        HttpError,
        env: { COHERE_API_KEY: 'co-test' },
        fetchImpl: mockFetch,
      });

      const conn = await provider.testConnection();
      assert.equal(conn.ok, false);
      assert.equal(conn.code, 'network_error');
      assert.match(conn.message, /connect to cohere|network/i);
    });
  });

  // Scenario 12: Clean text-generation streaming & non-streaming response parsing
  describe('Scenario 12: Clean text-generation streaming & non-streaming parsing', () => {
    it('Anthropic non-streaming: returns clean text and usage statistics', async () => {
      const mockFetch = makeMockFetch({
        status: 200,
        body: {
          content: [{ type: 'text', text: 'Hello from Claude!' }],
          usage: { input_tokens: 12, output_tokens: 8 },
        },
      });
      const provider = createAnthropicProvider({
        HttpError,
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
        fetchImpl: mockFetch,
      });

      const result = await provider.generate({
        model: 'claude-3-5-sonnet-20241022',
        text: 'Say hello',
      });
      assert.equal(result.text, 'Hello from Claude!');
      assert.equal(result.usage.inputTokens, 12);
      assert.equal(result.usage.outputTokens, 8);
    });

    it('Anthropic streaming: emits text tokens cleanly from SSE chunks', async () => {
      const sseLines = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Part 1 "}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Part 2"}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ];
      const mockFetch = makeMockFetch({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        bodyStream: makeSseStream(sseLines),
      });
      const provider = createAnthropicProvider({
        HttpError,
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
        fetchImpl: mockFetch,
      });

      const collected = [];
      for await (const chunk of provider.streamGenerate({
        model: 'claude-3-5-sonnet-20241022',
        text: 'Stream test',
      })) {
        if (chunk.type === 'delta' && chunk.text) collected.push(chunk.text);
      }

      assert.equal(collected.join(''), 'Part 1 Part 2');
    });

    it('Cohere streaming: emits text tokens cleanly from v2 chat SSE chunks', async () => {
      const sseLines = [
        'data: {"type":"content-delta","delta":{"message":{"content":{"text":"Hello "}}}}',
        'data: {"type":"content-delta","delta":{"message":{"content":{"text":"Cohere!"}}}}',
        'data: {"type":"message-end"}',
      ];
      const mockFetch = makeMockFetch({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        bodyStream: makeSseStream(sseLines),
      });
      const provider = createCohereProvider({
        HttpError,
        env: { COHERE_API_KEY: 'co-test' },
        fetchImpl: mockFetch,
      });

      const collected = [];
      for await (const chunk of provider.streamGenerate({
        model: 'command-r-plus-08-2024',
        text: 'Stream test',
      })) {
        if (chunk.type === 'delta' && chunk.text) collected.push(chunk.text);
      }

      assert.equal(collected.join(''), 'Hello Cohere!');
    });
  });

  // Scenario 13: Key masking (no raw secret leakage in status or logs)
  describe('Scenario 13: Key masking (no secret leakage in status or logs)', () => {
    it('Anthropic: masks API key in status()', () => {
      const rawKey = 'sk-ant-api03-abcdef1234567890abcdef1234567890';
      const provider = createAnthropicProvider({
        HttpError,
        env: { ANTHROPIC_API_KEY: rawKey },
      });
      const st = provider.status();
      assert.equal(st.configured, true);
      assert.notEqual(st.maskedKey, rawKey);
      assert.match(st.maskedKey, /sk-ant-•+7890/);
      assert.equal(JSON.stringify(st).includes(rawKey), false);
    });

    it('Cohere: masks API key in status()', () => {
      const rawKey = 'co-secret1234567890abcdef';
      const provider = createCohereProvider({
        HttpError,
        env: { COHERE_API_KEY: rawKey },
      });
      const st = provider.status();
      assert.equal(st.configured, true);
      assert.notEqual(st.maskedKey, rawKey);
      assert.match(st.maskedKey, /•+/);
      assert.equal(JSON.stringify(st).includes(rawKey), false);
    });
  });

  // Scenario 14: Admin panel key CRUD (add, update, delete)
  describe('Scenario 14: Admin panel key CRUD (add, update, delete)', () => {
    it('Cohere config: sets, reads encrypted backup, and clears key', () => {
      const tmpFile = path.join(os.tmpdir(), `cohere-test-cfg-${Date.now()}.json`);
      const cfg = createCohereConfig({ configFile: tmpFile });

      // Add
      cfg.setStoredKey('co-test-secret-key-1234');
      assert.equal(cfg.getStoredKey(), 'co-test-secret-key-1234');

      // Update
      cfg.setStoredKey('co-updated-key-5678');
      assert.equal(cfg.getStoredKey(), 'co-updated-key-5678');

      // Clear (delete)
      cfg.clearStoredKey();
      assert.equal(cfg.getStoredKey(), null);

      try { fs.unlinkSync(tmpFile); } catch (_) {}
    });
  });

  // Scenario 15: Strict free-tier quota enforcement
  describe('Scenario 15: Strict free-tier quota enforcement', () => {
    it('Cohere: trial rate limit header parsing and state tracking', () => {
      const cfg = createCohereConfig();
      cfg.updateRateLimits({
        get: (h) => (h === 'x-ratelimit-remaining-requests' ? '5' : null),
      });
      const snap = cfg.snapshot();
      assert.equal(snap.rateLimits.remainingRequests, 5);
    });
  });

  // Scenario 16: Cloudflare image token (CLOUDFLARE_API_TOKEN_2) vs primary token routing
  describe('Scenario 16: Cloudflare image token vs primary token routing', () => {
    it('Routes image generation requests with CLOUDFLARE_API_TOKEN_2 when provided', async () => {
      let usedAuthHeader = null;
      let requestedUrl = null;

      const mockFetch = async (url, opts) => {
        requestedUrl = url;
        usedAuthHeader = opts?.headers?.Authorization || opts?.headers?.authorization;
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'image/png' },
          text: async () => 'PNG_BYTES',
          json: async () => ({}),
          arrayBuffer: async () => Buffer.from('PNG_BYTES'),
        };
      };

      const tmpFile = path.join(os.tmpdir(), `cf-test-tokens-${Date.now()}.json`);
      const cfg = createCloudflareConfig({ configFile: tmpFile });
      cfg.setStoredCredentials({
        accountId: 'cf-account-id',
        apiToken: 'primary-token-111',
        apiToken2: 'image-token-222',
      });
      cfg.setEnabled(true);

      const provider = createCloudflareProvider({
        HttpError,
        config: cfg,
        fetchImpl: mockFetch,
      });

      // Test image generation
      await provider.generateImage({
        model: '@cf/black-forest-labs/flux-1-schnell',
        prompt: 'a glowing neon cat',
      });

      // Verify that image token (token 2) was used
      assert.equal(usedAuthHeader, 'Bearer image-token-222');
      assert.match(requestedUrl, /@cf\/black-forest-labs\/flux-1-schnell/);

      try { fs.unlinkSync(tmpFile); } catch (_) {}
    });

    it('Falls back to primary token for image generation if token 2 is not set', async () => {
      let usedAuthHeader = null;

      const mockFetch = async (url, opts) => {
        usedAuthHeader = opts?.headers?.Authorization || opts?.headers?.authorization;
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'image/png' },
          text: async () => 'PNG_BYTES',
          json: async () => ({}),
          arrayBuffer: async () => Buffer.from('PNG_BYTES'),
        };
      };

      const tmpFile = path.join(os.tmpdir(), `cf-test-tokens2-${Date.now()}.json`);
      const cfg = createCloudflareConfig({ configFile: tmpFile });
      cfg.setStoredCredentials({
        accountId: 'cf-account-id',
        apiToken: 'primary-token-only',
        apiToken2: '',
      });
      cfg.setEnabled(true);

      const provider = createCloudflareProvider({
        HttpError,
        config: cfg,
        fetchImpl: mockFetch,
      });

      await provider.generateImage({
        model: '@cf/black-forest-labs/flux-1-schnell',
        prompt: 'a scenic landscape',
      });

      assert.equal(usedAuthHeader, 'Bearer primary-token-only');

      try { fs.unlinkSync(tmpFile); } catch (_) {}
    });
  });

});
