'use strict';

const https = require('https');
const http = require('http');

const POLLINATIONS_BASE_URL = 'https://gen.pollinations.ai';
const DEFAULT_TIMEOUT_MS = 60000;

function createPollinationsProvider({
  HttpError,
  env = process.env,
  config,
  fetchFn = null
} = {}) {
  let recentErrors = [];
  let lastValidation = 'not_checked';
  let accountKeyInfo = null;
  let accountBalanceInfo = null;

  function pushError(err, model = null) {
    const entry = {
      code: err?.code || 'error',
      message: err?.message || 'Unknown Pollinations error',
      at: new Date().toISOString(),
      ...(model ? { model } : {})
    };
    recentErrors.unshift(entry);
    if (recentErrors.length > 20) recentErrors.pop();
    config?.recordRequestFailure?.(entry);
  }

  async function rawFetch(urlStr, options = {}) {
    if (fetchFn) return fetchFn(urlStr, options);

    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const reqOptions = {
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || DEFAULT_TIMEOUT_MS
      };

      const req = transport.request(url, reqOptions, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          const bodyText = bodyBuffer.toString('utf8');
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: res.headers,
            text: async () => bodyText,
            json: async () => {
              try {
                return JSON.parse(bodyText);
              } catch (e) {
                throw new Error(`Invalid JSON response: ${bodyText.slice(0, 100)}`);
              }
            },
            buffer: async () => bodyBuffer
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout to Pollinations AI'));
      });

      req.on('error', reject);

      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }

  function getAuthHeaders() {
    const key = config.getApiKey();
    if (!key) throw new (HttpError || Error)(401, 'not_configured', 'Pollinations API key is not configured.');
    return {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'User-Agent': 'PhotonAI-Image/1.0'
    };
  }

  return {
    configured() {
      return config.isConfigured();
    },

    status() {
      const models = config.getModels();
      const usage = config.getUsage();
      const isExhausted = config.isBudgetExhausted();

      return {
        provider: 'Pollinations AI',
        providerId: 'pollinations',
        category: 'Image Generation',
        configured: config.isConfigured(),
        enabled: config.isEnabled(),
        validation: lastValidation,
        maskedApiKey: config.getMaskedKey(),
        spendingPolicy: config.getSpendingPolicy(),
        monthlyBudgetCapUsd: config.getMonthlyBudgetCapUsd(),
        currentMonthSpendUsd: config.getCurrentMonthSpendUsd(),
        isBudgetExhausted: isExhausted,
        defaultModelId: config.getDefaultModelId(),
        modelCount: models.length,
        enabledModelCount: models.filter(m => m.enabled).length,
        models,
        usage,
        accountKeyInfo,
        accountBalanceInfo,
        recentErrors
      };
    },

    async testConnection() {
      if (!config.isConfigured()) {
        lastValidation = 'not_configured';
        return {
          ok: false,
          status: 'not_configured',
          code: 'missing_key',
          message: 'POLLINATIONS_API_KEY is not configured in environment or admin settings.'
        };
      }

      const key = config.getApiKey();
      if (!key.startsWith('sk_') && !key.startsWith('pk_')) {
        // Warn if not standard key format, but continue
      }

      const startTime = Date.now();
      try {
        // First try GET /account/key
        const res = await rawFetch(`${POLLINATIONS_BASE_URL}/account/key`, {
          method: 'GET',
          headers: getAuthHeaders()
        });

        const latencyMs = Date.now() - startTime;

        if (res.status === 401) {
          lastValidation = 'invalid_api_key';
          const err = { code: 'invalid_api_key', message: 'Pollinations API key is invalid or unrecognized.' };
          pushError(err);
          return { ok: false, status: 'invalid_api_key', code: err.code, message: err.message, responseTimeMs: latencyMs };
        }

        if (res.status === 402) {
          lastValidation = 'budget_exhausted';
          const err = { code: 'budget_exhausted', message: 'Pollinations Pollen budget or account balance is exhausted (HTTP 402).' };
          pushError(err);
          return { ok: false, status: 'budget_exhausted', code: err.code, message: err.message, responseTimeMs: latencyMs };
        }

        if (res.status === 403) {
          // Key might be valid for generation but restricted from /account/key
          lastValidation = 'forbidden';
          const err = { code: 'permission_denied', message: 'Key lacks permission to read account details (HTTP 403). It may still generate images.' };
          pushError(err);
          return { ok: false, status: 'forbidden', code: err.code, message: err.message, responseTimeMs: latencyMs };
        }

        if (!res.ok) {
          lastValidation = 'error';
          const text = await res.text().catch(() => '');
          const err = { code: `http_${res.status}`, message: `Pollinations API returned HTTP ${res.status}: ${text.slice(0, 150)}` };
          pushError(err);
          return { ok: false, status: 'error', code: err.code, message: err.message, responseTimeMs: latencyMs };
        }

        const data = await res.json();
        accountKeyInfo = {
          valid: data.valid !== false,
          type: data.type || 'secret',
          name: data.name || null,
          pollenBudget: data.pollenBudget != null ? data.pollenBudget : null,
          questPollenOnly: Boolean(data.questPollenOnly),
          userId: data.userId || null,
          expiresAt: data.expiresAt || null
        };

        // If key has budget info, check /account/balance if possible
        try {
          const balRes = await rawFetch(`${POLLINATIONS_BASE_URL}/account/balance`, {
            method: 'GET',
            headers: getAuthHeaders()
          });
          if (balRes.ok) {
            accountBalanceInfo = await balRes.json();
          }
        } catch {
          // Optional balance endpoint check
        }

        lastValidation = 'ok';
        // Auto-refresh models on successful connection test
        await this.refreshModels().catch(() => {});

        return {
          ok: true,
          status: 'ok',
          message: `Connected successfully. Key type: ${data.type || 'secret'}, Pollen budget: ${data.pollenBudget != null ? data.pollenBudget : 'unlimited/account'}.`,
          responseTimeMs: latencyMs,
          accountKeyInfo,
          accountBalanceInfo,
          modelCount: config.getModels().length
        };
      } catch (error) {
        lastValidation = 'network_error';
        const err = { code: 'network_error', message: error?.message || 'Network error connecting to Pollinations AI.' };
        pushError(err);
        return {
          ok: false,
          status: 'network_error',
          code: err.code,
          message: err.message,
          responseTimeMs: Date.now() - startTime
        };
      }
    },

    async refreshModels(force = false) {
      try {
        const res = await rawFetch(`${POLLINATIONS_BASE_URL}/image/models`, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });
        if (res.ok) {
          const list = await res.json();
          if (Array.isArray(list) && list.length > 0) {
            config.updateDiscoveredModels(list);
            return { ok: true, count: list.length, models: config.getModels() };
          }
        }
      } catch (err) {
        if (force) {
          pushError({ code: 'models_fetch_failed', message: err?.message || 'Failed to fetch Pollinations image models' });
        }
      }
      return { ok: false, count: config.getModels().length, models: config.getModels() };
    },

    async testModel(modelId) {
      if (!config.isConfigured()) {
        throw new (HttpError || Error)(401, 'not_configured', 'Pollinations API key is not configured.');
      }
      if (!config.isEnabled()) {
        throw new (HttpError || Error)(403, 'provider_disabled', 'Pollinations provider is disabled in settings.');
      }
      if (config.isBudgetExhausted()) {
        throw new (HttpError || Error)(402, 'budget_exhausted', 'Pollinations spending cap or budget has been reached. Generation blocked.');
      }

      const id = String(modelId || config.getDefaultModelId()).trim();
      const startTime = Date.now();

      const payload = {
        prompt: 'Minimal geometric circle in red and gold vector style',
        model: id,
        n: 1,
        size: '512x512',
        response_format: 'b64_json'
      };

      try {
        const res = await rawFetch(`${POLLINATIONS_BASE_URL}/v1/images/generations`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(payload)
        });

        const latencyMs = Date.now() - startTime;

        if (res.status === 401) {
          const err = { code: 'invalid_api_key', message: 'Pollinations API key was rejected as unauthorized.' };
          pushError(err, id);
          return { ok: false, status: 'invalid_api_key', code: err.code, message: err.message, responseTimeMs: latencyMs };
        }
        if (res.status === 402) {
          const err = { code: 'budget_exhausted', message: 'Pollinations budget exhausted (HTTP 402).' };
          pushError(err, id);
          return { ok: false, status: 'budget_exhausted', code: err.code, message: err.message, responseTimeMs: latencyMs };
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = { code: `http_${res.status}`, message: `Model test returned HTTP ${res.status}: ${text.slice(0, 150)}` };
          pushError(err, id);
          return { ok: false, status: 'error', code: err.code, message: err.message, responseTimeMs: latencyMs };
        }

        const data = await res.json();
        const imgObj = data?.data?.[0];
        const hasB64 = Boolean(imgObj?.b64_json);
        const hasUrl = Boolean(imgObj?.url);

        if (!hasB64 && !hasUrl) {
          const err = { code: 'invalid_response', message: 'Pollinations response missing image data' };
          pushError(err, id);
          return { ok: false, status: 'invalid_response', code: err.code, message: err.message, responseTimeMs: latencyMs };
        }

        const costHeader = res.headers?.['x-pollinations-cost'] || res.headers?.['x-cost-usd'];
        const costUsd = costHeader ? parseFloat(costHeader) : 0.001;
        config.recordRequestSuccess({ costUsd, pollenSpent: 1 });

        return {
          ok: true,
          status: 'ok',
          model: id,
          responseTimeMs: latencyMs,
          costUsd,
          hasImage: true,
          previewUrl: imgObj.url || (imgObj.b64_json ? `data:image/png;base64,${imgObj.b64_json.slice(0, 50)}...` : null),
          reply: `Generated 512x512 image in ${latencyMs}ms using ${id}.`
        };
      } catch (error) {
        const latencyMs = Date.now() - startTime;
        const err = { code: error?.code || 'generation_error', message: error?.message || 'Failed to generate test image.' };
        pushError(err, id);
        return {
          ok: false,
          status: 'error',
          code: err.code,
          message: err.message,
          responseTimeMs: latencyMs
        };
      }
    },

    async generateImage({
      prompt,
      model,
      size = '1024x1024',
      aspect_ratio = null,
      seed = null,
      output_format = 'png',
      response_format = 'b64_json',
      user = null
    } = {}) {
      if (!config.isConfigured()) {
        throw new (HttpError || Error)(401, 'not_configured', 'Pollinations API key is not configured.');
      }
      if (!config.isEnabled()) {
        throw new (HttpError || Error)(403, 'provider_disabled', 'Pollinations provider is disabled in settings.');
      }
      if (config.isBudgetExhausted()) {
        throw new (HttpError || Error)(402, 'budget_exhausted', 'Pollinations budget cap has been reached. Generation blocked by strict spending policy.');
      }
      if (!prompt || typeof prompt !== 'string') {
        throw new (HttpError || Error)(400, 'invalid_prompt', 'Prompt is required.');
      }

      const chosenModel = String(model || config.getDefaultModelId()).trim();
      const startTime = Date.now();

      const payload = {
        prompt: prompt.trim(),
        model: chosenModel,
        n: 1,
        size: size || '1024x1024',
        response_format: response_format || 'b64_json',
        output_format: output_format || 'png',
        ...(aspect_ratio ? { aspect_ratio } : {}),
        ...(seed !== null && seed !== undefined ? { seed: Number(seed) } : {}),
        ...(user ? { user: String(user) } : {})
      };

      const res = await rawFetch(`${POLLINATIONS_BASE_URL}/v1/images/generations`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload)
      });

      const latencyMs = Date.now() - startTime;

      if (res.status === 401) {
        const err = new (HttpError || Error)(401, 'invalid_api_key', 'Pollinations API key rejected.');
        pushError(err, chosenModel);
        throw err;
      }
      if (res.status === 402) {
        const err = new (HttpError || Error)(402, 'budget_exhausted', 'Pollinations Pollen budget exhausted (HTTP 402).');
        pushError(err, chosenModel);
        throw err;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new (HttpError || Error)(res.status, 'generation_failed', `Pollinations generation failed (HTTP ${res.status}): ${text.slice(0, 150)}`);
        pushError(err, chosenModel);
        throw err;
      }

      const data = await res.json();
      const imgObj = data?.data?.[0];
      if (!imgObj || (!imgObj.b64_json && !imgObj.url)) {
        const err = new (HttpError || Error)(500, 'invalid_response', 'No image data returned from Pollinations.');
        pushError(err, chosenModel);
        throw err;
      }

      const costHeader = res.headers?.['x-pollinations-cost'] || res.headers?.['x-cost-usd'];
      const costUsd = costHeader ? parseFloat(costHeader) : 0.002;
      config.recordRequestSuccess({ costUsd, pollenSpent: 1 });

      return {
        url: imgObj.url || null,
        b64_json: imgObj.b64_json || null,
        format: output_format,
        model: chosenModel,
        prompt: prompt.trim(),
        latencyMs,
        costUsd,
        created: data.created || Math.floor(Date.now() / 1000)
      };
    },

    catalogEntries() {
      if (!config.isConfigured() || !config.isEnabled()) return [];
      const exhausted = config.isBudgetExhausted();
      return config.getModels().map(m => ({
        id: m.id,
        name: m.name,
        provider: 'Pollinations AI',
        providerId: 'pollinations',
        category: 'image',
        configured: true,
        supported: true,
        available: Boolean(m.enabled && !exhausted),
        free: false,
        pricing: m.pricing || { currency: 'pollen' },
        description: m.description || '',
        publisher: m.publisher || 'Pollinations',
        reason: exhausted ? 'Pollinations spending cap reached.' : (!m.enabled ? 'Disabled by admin.' : '')
      }));
    }
  };
}

module.exports = {
  createPollinationsProvider,
  POLLINATIONS_BASE_URL
};
