'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CATEGORY_TEXT,
  CATEGORY_IMAGE,
  CATEGORY_VIDEO,
  classifyModelCapabilities,
  createModelCapabilityService,
} = require('../model-capability-service');

test('Scenario 1: Text chat and reasoning models are classified as TEXT with text_output: true', () => {
  const models = [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', provider: 'Groq' },
    { id: 'google/gemma-4-26b-a4b-it:free', name: 'Gemma 4 26B', provider: 'OpenRouter' },
    { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek R1', provider: 'OpenRouter' },
    { id: '@cf/meta/llama-3.1-8b-instruct', name: 'Llama 3.1 8B', provider: 'Cloudflare Workers AI' },
  ];

  for (const m of models) {
    const caps = classifyModelCapabilities(m);
    assert.equal(caps.category, CATEGORY_TEXT, `${m.id} must be in TEXT category`);
    assert.equal(caps.text_output, true, `${m.id} must have text_output: true`);
    assert.equal(caps.image_output, false, `${m.id} must NOT have image_output: true`);
    assert.equal(caps.video_output, false, `${m.id} must NOT have video_output: true`);
  }
});

test('Scenario 2: Multimodal vision-input models are NOT classified as image generators', () => {
  // A model that accepts images (like Gemini or GPT-4o) generates text, NOT images!
  const visionModels = [
    { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', provider: 'Google', capabilities: { vision: true, video: true } },
    { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI', capabilities: { vision: true } },
    { id: 'llama-3.2-11b-vision-preview', name: 'Llama 3.2 Vision', provider: 'Groq' },
  ];

  for (const m of visionModels) {
    const caps = classifyModelCapabilities(m);
    assert.equal(caps.category, CATEGORY_TEXT, `${m.id} must remain in TEXT category`);
    assert.equal(caps.text_output, true, `${m.id} must have text_output: true`);
    assert.equal(caps.image_input, true, `${m.id} must have image_input: true`);
    assert.equal(caps.image_output, false, `${m.id} must NOT have image_output: true`);
    assert.equal(caps.video_output, false, `${m.id} must NOT have video_output: true`);
  }
});

test('Scenario 3: Image generation models have image_output: true and category: IMAGE', () => {
  const imageModels = [
    { id: '@cf/black-forest-labs/flux-1-schnell', name: 'FLUX.1 Schnell', provider: 'Cloudflare Workers AI', task: 'text-to-image' },
    { id: '@cf/stabilityai/stable-diffusion-xl-base-1.0', name: 'SDXL Base 1.0', provider: 'Cloudflare Workers AI', task: 'text-to-image' },
    { id: '@cf/bytedance/stable-diffusion-xl-lightning', name: 'SDXL Lightning', provider: 'Cloudflare Workers AI', task: 'text-to-image' },
    { id: 'dall-e-3', name: 'DALL-E 3', provider: 'OpenAI', task: 'text-to-image' },
  ];

  for (const m of imageModels) {
    const caps = classifyModelCapabilities(m);
    assert.equal(caps.category, CATEGORY_IMAGE, `${m.id} must be in IMAGE category`);
    assert.equal(caps.image_output, true, `${m.id} must have image_output: true`);
    assert.equal(caps.text_output, false, `${m.id} must NOT have text_output: true`);
    assert.equal(caps.video_output, false, `${m.id} must NOT have video_output: true`);
  }
});

test('Scenario 4: Video generation models have video_output: true and category: VIDEO', () => {
  const videoModels = [
    { id: 'stabilityai/stable-video-diffusion', name: 'Stable Video Diffusion', provider: 'Stability AI', task: 'text-to-video' },
    { id: 'runway/gen-3-alpha', name: 'Runway Gen-3', provider: 'Runway', task: 'text-to-video' },
  ];

  for (const m of videoModels) {
    const caps = classifyModelCapabilities(m);
    assert.equal(caps.category, CATEGORY_VIDEO, `${m.id} must be in VIDEO category`);
    assert.equal(caps.video_output, true, `${m.id} must have video_output: true`);
    assert.equal(caps.text_output, false, `${m.id} must NOT have text_output: true`);
    assert.equal(caps.image_output, false, `${m.id} must NOT have image_output: true`);
  }
});

test('Scenario 5: Capability registry strictly isolates models by category', () => {
  const svc = createModelCapabilityService();
  svc.registerModels([
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3', provider: 'Groq', available: true },
    { id: 'gemini-2.0-flash', name: 'Gemini Flash', provider: 'Google', available: true },
    { id: '@cf/black-forest-labs/flux-1-schnell', name: 'Flux', provider: 'Cloudflare Workers AI', task: 'text-to-image', available: true },
    { id: '@cf/stabilityai/stable-diffusion-xl-base-1.0', name: 'SDXL', provider: 'Cloudflare Workers AI', task: 'text-to-image', available: true },
  ]);

  const textModels = svc.getModelsByCategory('text');
  const imageModels = svc.getModelsByCategory('image');
  const videoModels = svc.getModelsByCategory('video');

  assert.equal(textModels.length, 2, 'Must have exactly 2 text models');
  assert.equal(imageModels.length, 2, 'Must have exactly 2 image models');
  assert.equal(videoModels.length, 0, 'Must have 0 video models when none configured');

  assert(textModels.every(m => m.category === 'text' && m.text_output && !m.image_output));
  assert(imageModels.every(m => m.category === 'image' && m.image_output && !m.text_output));
});

test('Scenario 6: Mismatched capability assertion is rejected with HTTP 400', () => {
  const svc = createModelCapabilityService();
  svc.registerModels([
    { id: 'gemini-2.0-flash', name: 'Gemini Flash', provider: 'Google', available: true },
    { id: '@cf/black-forest-labs/flux-1-schnell', name: 'Flux', provider: 'Cloudflare Workers AI', task: 'text-to-image', available: true },
  ]);

  // Trying to use a text model for image generation
  assert.throws(() => {
    svc.assertModelCapability('gemini-2.0-flash', 'image');
  }, /does not support image generation/);

  // Trying to use an image model for text chat
  assert.throws(() => {
    svc.assertModelCapability('@cf/black-forest-labs/flux-1-schnell', 'text');
  }, /does not support text generation/);

  // Valid requests succeed
  assert.equal(svc.assertModelCapability('gemini-2.0-flash', 'text'), true);
  assert.equal(svc.assertModelCapability('@cf/black-forest-labs/flux-1-schnell', 'image'), true);
});

test('Scenario 7: When no video provider configured, video generation returns 503 error', () => {
  const svc = createModelCapabilityService();
  svc.registerModels([
    { id: 'gemini-2.0-flash', name: 'Gemini Flash', provider: 'Google', available: true },
    { id: '@cf/black-forest-labs/flux-1-schnell', name: 'Flux', provider: 'Cloudflare Workers AI', task: 'text-to-image', available: true },
  ]);

  const stats = svc.getCategoryStats();
  assert.equal(stats.video.total, 0);
  assert.equal(stats.video.available, 0);

  assert.throws(() => {
    svc.createVideoJob({ prompt: 'A sunset over the ocean', modelId: 'nonexistent-video-model' });
  }, /No video generation models are currently available/);
});

test('Scenario 8: Provider matrix shows capabilities per provider without credential leaks', () => {
  const svc = createModelCapabilityService();
  svc.registerModels([
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3', provider: 'Groq', available: true },
    { id: 'gemini-2.0-flash', name: 'Gemini Flash', provider: 'Google', available: true },
    { id: '@cf/meta/llama-3.1-8b-instruct', name: 'Llama 3.1 8B', provider: 'Cloudflare Workers AI', available: true },
    { id: '@cf/black-forest-labs/flux-1-schnell', name: 'Flux', provider: 'Cloudflare Workers AI', task: 'text-to-image', available: true },
  ]);

  const matrix = svc.auditProviderMatrix();
  assert(matrix.groq);
  assert.deepEqual(matrix.groq.supported_categories, ['text']);

  assert(matrix.gemini);
  assert.deepEqual(matrix.gemini.supported_categories, ['text']);

  assert(matrix.cloudflare_workers_ai);
  assert(matrix.cloudflare_workers_ai.supported_categories.includes('text'));
  assert(matrix.cloudflare_workers_ai.supported_categories.includes('image'));
  assert.equal(matrix.cloudflare_workers_ai.text_models_count, 1);
  assert.equal(matrix.cloudflare_workers_ai.image_models_count, 1);
});

test('Scenario 9: Pollinations AI models are automatically classified as IMAGE with free-tier access', () => {
  const { createPollinationsProvider } = require('../pollinations-provider');
  class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
  const pol = createPollinationsProvider({ HttpError });

  const entries = pol.catalogEntries();
  assert.equal(entries.length, 3);
  assert(entries.every(m => m.free === true));
  assert(entries.every(m => m.category === 'Image Generation'));

  const svc = createModelCapabilityService();
  svc.registerModels(entries);

  const imageModels = svc.getModelsByCategory('image');
  assert.equal(imageModels.length, 3);
  assert(imageModels.some(m => m.id === 'flux'));
  assert(imageModels.some(m => m.id === 'sana'));
  assert(imageModels.some(m => m.id === 'turbo'));
});

test('Scenario 10: Model-by-model real text test verification', async () => {
  const svc = createModelCapabilityService();
  svc.registerModels([
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3', provider: 'Groq', available: true },
  ]);

  const mockRunner = async ({ modelId, text, category }) => {
    assert.equal(category, 'text');
    assert.equal(text, 'Reply with exactly: PHOTON TEXT TEST SUCCESSFUL');
    return { text: 'PHOTON TEXT TEST SUCCESSFUL', usage: { inputTokens: 8, outputTokens: 6 } };
  };

  const res = await svc.testModelText('llama-3.3-70b-versatile', mockRunner);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'PASSED');
  assert(res.durationMs >= 0);

  const model = svc.getModel('llama-3.3-70b-versatile');
  assert.equal(model.text_test_status, 'PASSED');
  assert(model.text_tested_at);
});

test('Scenario 11: Model-by-model real image test verification', async () => {
  const svc = createModelCapabilityService();
  svc.registerModels([
    { id: 'flux', name: 'FLUX.1 Schnell', provider: 'Pollinations AI', free: true, task: 'text-to-image', available: true },
  ]);

  const mockRunner = async ({ modelId, text, category }) => {
    assert.equal(category, 'image');
    assert.equal(text, 'Generate a simple red apple on a clean white background.');
    return {
      success: true,
      dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg...',
      bytes: 19269,
      contentType: 'image/jpeg',
    };
  };

  const res = await svc.testModelImage('flux', mockRunner);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'PASSED');
  assert.equal(res.hasImageBytes, true);

  const model = svc.getModel('flux');
  assert.equal(model.image_test_status, 'PASSED');
  assert(model.image_tested_at);
});

test('Scenario 12: Video test marks model UNSUPPORTED when no video endpoint exists', async () => {
  const svc = createModelCapabilityService();
  svc.registerModels([
    { id: 'gemini-2.0-flash', name: 'Gemini Flash', provider: 'Google', available: true },
  ]);

  const mockRunner = async () => {};
  const res = await svc.testModelVideo('gemini-2.0-flash', mockRunner);
  assert.equal(res.ok, false);
  assert.equal(res.status, 'UNSUPPORTED');

  const model = svc.getModel('gemini-2.0-flash');
  assert.equal(model.video_test_status, 'UNSUPPORTED');
});

test('Scenario 13: Zero fake video models - VIDEO category is strictly 0 when no models passed', () => {
  const svc = createModelCapabilityService();
  svc.registerModels([
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3', provider: 'Groq', available: true },
    { id: 'flux', name: 'FLUX.1 Schnell', provider: 'Pollinations AI', free: true, task: 'text-to-image', available: true },
    { id: 'some-model-with-video-tag', name: 'Tagged Video Model', provider: 'Unknown', task: 'text-to-video', available: true },
  ]);

  // Model hasn't passed video testing
  const videoModels = svc.getModelsByCategory('video');
  assert.equal(videoModels.length, 0, 'No unverified model should be in VIDEO selector');

  const stats = svc.getCategoryStats();
  assert.equal(stats.video.total, 0, 'Category stats video count must be 0');
});

test('Agnes Video 2.5 Flash requires verified free account access, not a billable generation test', () => {
  const svc = createModelCapabilityService();
  svc.registerModels([
    {
      id: 'agnes-video-2.5-flash',
      name: 'Agnes Video 2.5 Flash',
      provider: 'Agnes AI',
      providerId: 'agnes',
      category: 'video',
      task: 'text-to-video',
      video_output: true,
      capabilities: { text_to_video: true, image_to_video: true },
      available: true,
      free: true,
      pricingVerified: true,
    },
    {
      id: 'agnes-unverified-model',
      name: 'Unverified Agnes model',
      provider: 'Agnes AI',
      providerId: 'agnes',
      category: 'video',
      task: 'text-to-video',
      video_output: true,
      available: false,
      free: false,
      pricingVerified: true,
    },
  ]);

  const videoModels = svc.getModelsByCategory('video', { availableOnly: true });
  assert.deepEqual(videoModels.map(model => model.id), ['agnes-video-2.5-flash']);
  assert.equal(videoModels[0].video_test_status, 'NOT_TESTED');
  assert.equal(videoModels[0].image_input, true);
  assert(videoModels[0].supported_tasks.includes('text-to-video'));
  assert(videoModels[0].supported_tasks.includes('image-to-video'));
  assert.equal(svc.assertModelCapability('agnes-video-2.5-flash', 'video'), true);
});

test('Scenario 14: Comprehensive model capability report generates full matrix without leaks', () => {
  const svc = createModelCapabilityService();
  svc.registerModels([
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3', provider: 'Groq', available: true, free: true },
    { id: 'flux', name: 'FLUX.1', provider: 'Pollinations AI', available: true, free: true, task: 'text-to-image' },
  ]);

  const report = svc.getModelCapabilityReport();
  assert.equal(report.length, 2);
  const groqReport = report.find(r => r.model_id === 'llama-3.3-70b-versatile');
  assert.equal(groqReport.text_supported, true);
  assert.equal(groqReport.image_supported, false);
  assert.equal(groqReport.pricing_status, 'FREE');

  const fluxReport = report.find(r => r.model_id === 'flux');
  assert.equal(fluxReport.text_supported, false);
  assert.equal(fluxReport.image_supported, true);
  assert.equal(fluxReport.pricing_status, 'FREE');
});
