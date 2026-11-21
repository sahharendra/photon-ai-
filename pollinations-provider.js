'use strict';
// Pollinations AI Provider for PHOTON AI
//
// Key Features:
// - Completely FREE Text-to-Image generation using FLUX, Sana, and Turbo models.
// - Zero credit card requirement.
// - Direct high-speed image generation returning valid JPEG/PNG image data.
// - Configurable optional API key for high-volume or premium Pollinations endpoints.
// - Safe URL parameter encoding, dimensions support (width/height), seed, and nologo options.
// - Zero billing protection: strictly rejects paid-only video/image models unless explicitly configured.

const { maskKey } = require('./gemini-keys');

const DEFAULT_IMAGE_MODELS = [
  { id: 'flux', name: 'FLUX.1 Schnell (Pollinations Free)', provider: 'Pollinations AI', free: true, category: 'Image Generation', task: 'text-to-image' },
  { id: 'sana', name: 'Sana Ultra-Fast (Pollinations Free)', provider: 'Pollinations AI', free: true, category: 'Image Generation', task: 'text-to-image' },
  { id: 'turbo', name: 'SDXL Turbo (Pollinations Free)', provider: 'Pollinations AI', free: true, category: 'Image Generation', task: 'text-to-image' },
];

function createPollinationsProvider({ HttpError, env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  let isEnabled = true;
  let customApiKey = env.POLLINATIONS_API_KEY || '';
  let lastTestResult = null;

  function configured() {
    // Pollinations free image generation works with or without an API key
    return true;
  }

  function enabled() {
    return isEnabled;
  }

  function setEnabled(val) {
    isEnabled = Boolean(val);
  }

  function setApiKey(key) {
    customApiKey = String(key || '').trim();
    if (customApiKey) env.POLLINATIONS_API_KEY = customApiKey;
    else delete env.POLLINATIONS_API_KEY;
  }

  function getApiKey() {
    return customApiKey;
  }

  function catalogEntries() {
    if (!isEnabled) {
      return [{
        id: 'pollinations',
        name: 'Pollinations AI Free Image',
        provider: 'Pollinations AI',
        providerId: 'pollinations',
        configured: true,
        supported: true,
        available: false,
        free: true,
        category: 'Image Generation',
        task: 'text-to-image',
        reason: 'Pollinations AI is disabled by the administrator.',
      }];
    }

    return DEFAULT_IMAGE_MODELS.map(m => ({
      id: m.id,
      name: m.name,
      provider: 'Pollinations AI',
      providerId: 'pollinations',
      configured: true,
      supported: true,
      available: true,
      free: true,
      pricingVerified: true,
      category: 'Image Generation',
      task: 'text-to-image',
      capabilities: { text: false, image_output: true, vision: false },
      description: `${m.name} - Free unlimited high-speed AI image generation.`,
      reason: '',
    }));
  }

  async function generateImage({ prompt, model = 'flux', width = 1024, height = 1024, seed = null, signal, _isRetry = false } = {}) {
    if (!isEnabled) {
      throw new HttpError(503, 'provider_disabled', 'Pollinations AI is currently disabled.');
    }
    const cleanPrompt = String(prompt || '').trim() || 'A modern futuristic cityscape at sunrise, 4k ultra-detailed';
    const chosenModel = String(model || 'flux').replace(/^pollinations\//, '').trim();

    const params = new URLSearchParams({
      width: String(Math.min(2048, Math.max(256, Number(width) || 1024))),
      height: String(Math.min(2048, Math.max(256, Number(height) || 1024))),
      model: chosenModel,
      nologo: 'true',
    });
    if (seed) params.set('seed', String(seed));
    if (customApiKey) params.set('key', customApiKey);

    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?${params.toString()}`;

    const timeoutSignal = AbortSignal.timeout(60000);
    const combined = signal ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal) : timeoutSignal;

    const started = Date.now();
    let res;
    try {
      res = await fetchImpl(imageUrl, {
        method: 'GET',
        headers: {
          'Accept': 'image/jpeg,image/png,image/*;q=0.8',
          'User-Agent': 'Photon-AI-Image-Client/2.0',
        },
        signal: combined,
      });
    } catch (err) {
      logger.error('Pollinations fetch error:', err.message);
      throw new HttpError(502, 'provider_error', `Could not connect to Pollinations AI image service: ${err.message}`);
    }

    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const rawBuffer = Buffer.from(await res.arrayBuffer());

    // Check if the response contains valid image binary data (even if HTTP 402/200 was sent)
    const isJpeg = rawBuffer.length > 100 && rawBuffer[0] === 0xFF && rawBuffer[1] === 0xD8;
    const isPng = rawBuffer.length > 100 && rawBuffer[0] === 0x89 && rawBuffer[1] === 0x50 && rawBuffer[2] === 0x4E;
    const isValidImage = isJpeg || isPng;

    if (!res.ok && !isValidImage) {
      let errorMsg = '';
      let retryAfter = Number(res.headers.get('retry-after')) || 0;
      try {
        const json = JSON.parse(rawBuffer.toString('utf8'));
        if (json && json.error && json.error.message) {
          errorMsg = json.error.message;
        } else if (json && json.message) {
          errorMsg = json.message;
        }
      } catch (_) {
        // Strip non-printable and binary characters to avoid displaying garbage
        const textSlice = rawBuffer.toString('utf8', 0, 300).replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim();
        errorMsg = textSlice;
      }

      // Check for retry count inside the error text if header was absent (e.g. "Retry after 20s")
      if (!retryAfter && errorMsg) {
        const match = errorMsg.match(/retry\s+after\s+(\d+)s?/i) || errorMsg.match(/wait\s+(\d+)\s*s/i);
        if (match) retryAfter = Number(match[1]);
      }

      const isRateLimit = res.status === 402 || res.status === 429 || /FREE_LIMIT|Free limit|every 45 seconds/i.test(errorMsg);

      if (isRateLimit) {
        // If retry-after is reasonably short (<= 25 seconds) and we haven't already retried, wait and retry once
        if (!_isRetry && retryAfter > 0 && retryAfter <= 25 && (!signal || !signal.aborted)) {
          logger.log(`[Pollinations] Free rate-limit reached. Waiting ${retryAfter + 1}s before automatic retry...`);
          await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
          return generateImage({ prompt, model, width, height, seed, signal, _isRetry: true });
        }

        const waitNotice = retryAfter > 0 ? ` Please retry in ${retryAfter} seconds.` : ' Please wait 45 seconds between free generations.';
        throw new HttpError(
          429,
          'rate_limit_exceeded',
          `Pollinations free tier rate limit: 1 image every 45 seconds per IP.${waitNotice} (Tip: Add a free API key from https://enter.pollinations.ai in Admin Settings to eliminate this wait).`
        );
      }

      throw new HttpError(res.status, 'provider_error', `Pollinations service error (${res.status}): ${errorMsg || 'Generation failed.'}`);
    }

    if (rawBuffer.length < 100) {
      throw new HttpError(502, 'empty_response', 'Pollinations returned an invalid or empty image.');
    }

    const effectiveContentType = isPng ? 'image/png' : (isJpeg ? 'image/jpeg' : contentType);
    const base64 = rawBuffer.toString('base64');
    const dataUrl = `data:${effectiveContentType};base64,${base64}`;

    return {
      success: true,
      dataUrl,
      imageUrl,
      bytes: rawBuffer.length,
      contentType: effectiveContentType,
      model: chosenModel,
      provider: 'Pollinations AI',
      durationMs: Date.now() - started,
    };
  }

  async function testConnection() {
    const started = Date.now();
    try {
      // Test with a tiny test prompt
      const result = await generateImage({
        prompt: 'PHOTON AI TEST APPLE',
        model: 'flux',
        width: 256,
        height: 256,
      });
      lastTestResult = {
        ok: true,
        testedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        message: 'Successfully generated test image with Pollinations AI (FLUX).',
      };
      return lastTestResult;
    } catch (err) {
      lastTestResult = {
        ok: false,
        testedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        error: err.message,
        message: `Pollinations connection failed: ${err.message}`,
      };
      return lastTestResult;
    }
  }

  function status() {
    return {
      provider: 'Pollinations AI',
      providerId: 'pollinations',
      enabled: isEnabled,
      configured: true,
      hasCustomKey: Boolean(customApiKey),
      maskedKey: customApiKey ? maskKey(customApiKey) : 'None (Using Free Public Tier)',
      models: DEFAULT_IMAGE_MODELS,
      lastTestResult,
      isFree: true,
      creditCardRequired: false,
      spendingPolicy: 'strict_free_only',
    };
  }

  return {
    configured,
    enabled,
    setEnabled,
    setApiKey,
    getApiKey,
    catalogEntries,
    generateImage,
    testConnection,
    status,
    DEFAULT_IMAGE_MODELS,
  };
}

module.exports = {
  createPollinationsProvider,
  DEFAULT_IMAGE_MODELS,
};
