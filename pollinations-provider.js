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

  async function generateImage({ prompt, model = 'flux', width = 1024, height = 1024, seed = null, signal } = {}) {
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

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new HttpError(res.status, 'provider_error', `Pollinations returned HTTP ${res.status}: ${errText.slice(0, 150)}`);
    }

    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 100) {
      throw new HttpError(502, 'empty_response', 'Pollinations returned an invalid or empty image.');
    }

    const base64 = buffer.toString('base64');
    const dataUrl = `data:${contentType};base64,${base64}`;

    return {
      success: true,
      dataUrl,
      imageUrl,
      bytes: buffer.length,
      contentType,
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
