'use strict';
// PHOTON AI – Centralized Model Capability Detection & Model-by-Model Testing Service
//
// Capabilities:
// 1. Rigorous Modality & Task Classification:
//    - text_input, text_output
//    - image_input, image_output
//    - video_input, video_output
//    - supported_tasks
//    - category: exactly one of 'text' | 'image' | 'video'
//
// 2. Strict Boundary Rules:
//    - A model that accepts images is NOT an image generation model (image_output must be true).
//    - A model that understands video is NOT a video generation model (video_output must be true).
//    - A text model that writes SVG/image prompts is NOT an image/video model.
//    - Only models with image_output: true can be displayed or executed in IMAGE mode.
//    - Only models with video_output: true AND verified test status can be displayed or executed in VIDEO mode.
//    - If no verified video model is available, VIDEO mode shows 0 models and "No video generation models are currently available."
//
// 3. Model-by-Model Capability Testing & Registry:
//    - Independent testing stages: TEXT, IMAGE, VIDEO.
//    - Statuses: NOT_TESTED, TESTING, PASSED, FAILED, QUOTA_EXHAUSTED, UNSUPPORTED, PAID_ONLY, TEMPORARILY_UNAVAILABLE.
//    - Real execution prompts:
//      * TEXT: "Reply with exactly: PHOTON TEXT TEST SUCCESSFUL"
//      * IMAGE: "Generate a simple red apple on a clean white background."
//      * VIDEO: "Generate a short video of a red apple rotating slowly on a white background."

const CATEGORY_TEXT = 'text';
const CATEGORY_IMAGE = 'image';
const CATEGORY_VIDEO = 'video';

const ALL_CATEGORIES = Object.freeze([CATEGORY_TEXT, CATEGORY_IMAGE, CATEGORY_VIDEO]);

const STATUS_NOT_TESTED = 'NOT_TESTED';
const STATUS_TESTING = 'TESTING';
const STATUS_PASSED = 'PASSED';
const STATUS_FAILED = 'FAILED';
const STATUS_QUOTA_EXHAUSTED = 'QUOTA_EXHAUSTED';
const STATUS_UNSUPPORTED = 'UNSUPPORTED';
const STATUS_PAID_ONLY = 'PAID_ONLY';
const STATUS_TEMPORARILY_UNAVAILABLE = 'TEMPORARILY_UNAVAILABLE';

const TEST_PROMPTS = Object.freeze({
  text: 'Reply with exactly: PHOTON TEXT TEST SUCCESSFUL',
  image: 'Generate a simple red apple on a clean white background.',
  video: 'Generate a short video of a red apple rotating slowly on a white background.',
});

// Known text-to-image patterns across providers
const IMAGE_GEN_MODEL_REGEX = /^(?:@cf\/(?:black-forest-labs\/flux|stabilityai\/stable-diffusion|bytedance\/stable-diffusion|runwayml\/stable-diffusion)|flux|sana|turbo|dall-e|imagen|midjourney|stable-diffusion)/i;

// Known video generation patterns
const VIDEO_GEN_MODEL_REGEX = /(?:svd|stable-video|text-to-video|image-to-video|runway|luma-dream|cogvideox|sora|minimax-video|kling|seedance|wan-)/i;

// Known vision understanding (input only, text output) models
const VISION_INPUT_REGEX = /(?:vision|multimodal|vl|gpt-4o|gemini|claude-3|pixtral|qwen-vl)/i;

function normalizeCategory(cat) {
  const s = String(cat || '').toLowerCase().trim();
  if (s === 'image' || s === 'image generation' || s === 'text-to-image') return CATEGORY_IMAGE;
  if (s === 'video' || s === 'video generation' || s === 'text-to-video') return CATEGORY_VIDEO;
  return CATEGORY_TEXT;
}

function normalizeProviderId(name) {
  const s = String(name || '').toLowerCase().trim();
  if (s.includes('cloudflare')) return 'cloudflare_workers_ai';
  if (s.includes('pollinations')) return 'pollinations';
  if (s.includes('edenai') || s.includes('eden ai') || s.includes('eden')) return 'edenai';
  if (s.includes('openrouter')) return 'openrouter';
  if (s.includes('gemini') || s.includes('google')) return 'gemini';
  if (s.includes('groq')) return 'groq';
  if (s.includes('nvidia')) return 'nvidia';
  if (s.includes('openai')) return 'openai';
  if (s.includes('anthropic') || s.includes('claude')) return 'anthropic';
  if (s.includes('cohere')) return 'cohere';
  if (s.includes('stability')) return 'stability';
  if (s.includes('codecraft')) return 'codecraft';
  if (s.includes('llmtr')) return 'llmtr';
  if (s.includes('ollama')) return 'ollama';
  if (s.includes('runway')) return 'runway';
  if (s.includes('luma')) return 'luma';
  return s || 'unknown';
}

function classifyModelCapabilities(model = {}) {
  const id = String(model.id || '').trim();
  const task = String(model.task || '').trim().toLowerCase();
  const rawCat = String(model.category || '').trim().toLowerCase();
  const desc = String(model.description || '').toLowerCase();
  const rawCaps = model.capabilities || {};
  const prov = normalizeProviderId(model.provider || model.providerId);

  let text_input = true;
  let text_output = false;
  let image_input = false;
  let image_output = false;
  let video_input = false;
  let video_output = false;
  let category = CATEGORY_TEXT;
  const supported_tasks = [];

  // Check 1: Video generation model - only if explicitly provided with video task
  const isExplicitVideo = (task === 'text-to-video' || task === 'image-to-video' || task === 'video-generation' || rawCat.includes('video')) &&
    !id.includes('caption') && !id.includes('transcription');
  const isVideoRegex = VIDEO_GEN_MODEL_REGEX.test(id) && (rawCat.includes('video') || task.includes('video')) &&
    !id.includes('caption') && !id.includes('transcription');

  if (isExplicitVideo || isVideoRegex) {
    video_output = true;
    text_output = false;
    image_output = false;
    category = CATEGORY_VIDEO;
    text_input = true;
    image_input = task === 'image-to-video' || /img2vid|image-to-video/i.test(id);
    supported_tasks.push(image_input ? 'image-to-video' : 'text-to-video', 'video-generation');
    return {
      text_input,
      text_output,
      image_input,
      image_output,
      video_input,
      video_output,
      category,
      supported_tasks,
    };
  }

  // Check 2: Image generation model
  const isExplicitImage = task === 'text-to-image' || task === 'image-to-image' || rawCat.includes('image') || rawCaps.image_output;
  const isImageRegex = (IMAGE_GEN_MODEL_REGEX.test(id) || prov === 'pollinations' || id === 'flux' || id === 'sana' || id === 'turbo') &&
    !id.includes('ocr') && !id.includes('caption') && !id.includes('vision') && !id.includes('llama') && !id.includes('mistral');

  if (isExplicitImage || isImageRegex) {
    image_output = true;
    text_output = false;
    video_output = false;
    category = CATEGORY_IMAGE;
    text_input = true;
    image_input = task === 'image-to-image' || /img2img|image-to-image/i.test(id);
    supported_tasks.push(image_input ? 'image-to-image' : 'text-to-image', 'image-generation');
    return {
      text_input,
      text_output,
      image_input,
      image_output,
      video_input,
      video_output,
      category,
      supported_tasks,
    };
  }

  // Check 3: Text generation model (General Chat, Code, Reasoning, Multimodal input understanding)
  text_output = true;
  category = CATEGORY_TEXT;

  if (rawCaps.vision || VISION_INPUT_REGEX.test(id) || /vision|multimodal/i.test(desc)) {
    image_input = true;
    supported_tasks.push('vision-understanding');
  }
  if (rawCaps.pdf) {
    supported_tasks.push('document-analysis');
  }
  if (rawCaps.video || /gemini-1\.5|gemini-2/i.test(id)) {
    video_input = true;
    supported_tasks.push('video-understanding');
  }

  supported_tasks.push('text-generation', 'chat', 'reasoning');
  if (/coder|code|deepseek-coder/i.test(id)) {
    supported_tasks.push('coding');
  }

  return {
    text_input,
    text_output,
    image_input,
    image_output,
    video_input,
    video_output,
    category,
    supported_tasks,
  };
}

function enrichModelWithCapabilities(model = {}, quotaStatus = 'HEALTHY') {
  const caps = classifyModelCapabilities(model);
  const provId = model.providerId || normalizeProviderId(model.provider);

  const isAvailable = Boolean(model.available !== false && !model.creditsExhausted && quotaStatus !== 'QUOTA_EXHAUSTED' && quotaStatus !== 'INSUFFICIENT_CREDITS');

  return {
    id: model.id,
    name: model.name || model.id,
    provider: model.provider || 'AI Provider',
    provider_id: provId,
    model_id: model.id,
    model_name: model.name || model.id,
    category: caps.category,
    text_input: caps.text_input,
    text_output: caps.text_output,
    image_input: caps.image_input,
    image_output: caps.image_output,
    video_input: caps.video_input,
    video_output: caps.video_output,
    supported_tasks: caps.supported_tasks,
    configured: Boolean(model.configured !== false),
    supported: Boolean(model.supported !== false),
    available: isAvailable,
    enabled: Boolean(model.enabled !== false),
    free: Boolean(model.free),
    pricingVerified: Boolean(model.pricingVerified),
    contextLength: model.contextLength || model.contextWindow || 0,
    description: model.description || '',
    reason: model.reason || '',
    key_status: model.configured ? 'configured' : 'missing',
    quota_status: quotaStatus,
    availability_status: isAvailable ? 'available' : (model.creditsExhausted ? 'credits_exhausted' : 'unavailable'),
    text_test_status: caps.text_output ? STATUS_NOT_TESTED : STATUS_UNSUPPORTED,
    image_test_status: caps.image_output ? STATUS_NOT_TESTED : STATUS_UNSUPPORTED,
    video_test_status: caps.video_output ? STATUS_NOT_TESTED : STATUS_UNSUPPORTED,
    text_tested_at: null,
    image_tested_at: null,
    video_tested_at: null,
    last_error: null,
    last_successful_test: null,
    last_checked_at: new Date().toISOString(),
  };
}

class ModelCapabilityService {
  constructor({ quotaMonitor = null, logger = console } = {}) {
    this.quotaMonitor = quotaMonitor;
    this.logger = logger;
    this.models = new Map();
    this.testResults = new Map();
    this.videoJobs = new Map();
  }

  registerModels(modelList = []) {
    if (!Array.isArray(modelList)) return;
    for (const raw of modelList) {
      if (!raw || !raw.id) continue;
      const provKey = normalizeProviderId(raw.provider || raw.providerId);
      let quotaStatus = 'HEALTHY';
      if (this.quotaMonitor) {
        const check = this.quotaMonitor.getModelAvailability(provKey, raw.id);
        quotaStatus = check.status || 'HEALTHY';
      }
      const existing = this.models.get(raw.id);
      const enriched = enrichModelWithCapabilities(raw, quotaStatus);
      if (existing) {
        enriched.text_test_status = existing.text_test_status || enriched.text_test_status;
        enriched.image_test_status = existing.image_test_status || enriched.image_test_status;
        enriched.video_test_status = existing.video_test_status || enriched.video_test_status;
        enriched.text_tested_at = existing.text_tested_at || enriched.text_tested_at;
        enriched.image_tested_at = existing.image_tested_at || enriched.image_tested_at;
        enriched.video_tested_at = existing.video_tested_at || enriched.video_tested_at;
        enriched.last_error = existing.last_error || enriched.last_error;
        enriched.last_successful_test = existing.last_successful_test || enriched.last_successful_test;
      }
      this.models.set(enriched.id, enriched);
    }
  }

  getModel(modelId) {
    return this.models.get(String(modelId || '').trim()) || null;
  }

  getAllModels({ category = null, planFilter = null } = {}) {
    let list = Array.from(this.models.values());
    if (category) {
      const normCat = normalizeCategory(category);
      list = list.filter(m => m.category === normCat);
    }
    if (typeof planFilter === 'function') {
      list = list.filter(planFilter);
    }
    return list;
  }

  getModelsByCategory(category, { planFilter = null, availableOnly = false } = {}) {
    const normCat = normalizeCategory(category);
    let list = Array.from(this.models.values()).filter(m => {
      if (normCat === CATEGORY_TEXT) {
        return m.text_output && m.text_test_status !== STATUS_FAILED;
      }
      if (normCat === CATEGORY_IMAGE) {
        return m.image_output && m.image_test_status !== STATUS_FAILED;
      }
      if (normCat === CATEGORY_VIDEO) {
        // Strict: only return if video_output is true AND video test passed
        return m.video_output && m.video_test_status === STATUS_PASSED;
      }
      return m.category === normCat;
    });

    if (availableOnly) {
      list = list.filter(m => {
        if (!m.available || m.creditsExhausted) return false;
        if (this.quotaMonitor) {
          const provAvail = this.quotaMonitor.getProviderAvailability(m.provider);
          if (!provAvail.available) return false;
          const modelAvail = this.quotaMonitor.getModelAvailability(m.provider, m.id);
          if (!modelAvail.available) return false;
        }
        return true;
      });
    }
    if (typeof planFilter === 'function') {
      list = list.filter(planFilter);
    }
    return list;
  }

  getCategoryStats({ planFilter = null } = {}) {
    const stats = {
      [CATEGORY_TEXT]: { total: 0, available: 0, models: [] },
      [CATEGORY_IMAGE]: { total: 0, available: 0, models: [] },
      [CATEGORY_VIDEO]: { total: 0, available: 0, models: [] },
    };

    for (const m of this.models.values()) {
      if (typeof planFilter === 'function' && !planFilter(m)) continue;
      
      let isAvail = Boolean(m.available && !m.creditsExhausted);
      if (isAvail && this.quotaMonitor) {
        const provAvail = this.quotaMonitor.getProviderAvailability(m.provider);
        const modelAvail = this.quotaMonitor.getModelAvailability(m.provider, m.id);
        if (!provAvail.available || !modelAvail.available) isAvail = false;
      }

      if (m.text_output && m.text_test_status !== STATUS_FAILED) {
        stats[CATEGORY_TEXT].total += 1;
        if (isAvail) stats[CATEGORY_TEXT].available += 1;
        stats[CATEGORY_TEXT].models.push({ id: m.id, name: m.name, provider: m.provider, available: isAvail, free: m.free });
      }

      if (m.image_output && m.image_test_status !== STATUS_FAILED) {
        stats[CATEGORY_IMAGE].total += 1;
        if (isAvail) stats[CATEGORY_IMAGE].available += 1;
        stats[CATEGORY_IMAGE].models.push({ id: m.id, name: m.name, provider: m.provider, available: isAvail, free: m.free });
      }

      if (m.video_output && m.video_test_status === STATUS_PASSED) {
        stats[CATEGORY_VIDEO].total += 1;
        if (isAvail) stats[CATEGORY_VIDEO].available += 1;
        stats[CATEGORY_VIDEO].models.push({ id: m.id, name: m.name, provider: m.provider, available: isAvail, free: m.free });
      }
    }

    return stats;
  }

  assertModelCapability(modelId, requestedCategory) {
    const normReq = normalizeCategory(requestedCategory);
    const m = this.getModel(modelId);
    if (!m) {
      const err = new Error(`Model '${modelId}' is not registered.`);
      err.code = 'model_not_found';
      err.status = 404;
      throw err;
    }

    if (normReq === CATEGORY_TEXT && !m.text_output) {
      const err = new Error(`Model '${m.name}' does not support text generation (category is ${m.category}).`);
      err.code = 'unsupported_capability';
      err.status = 400;
      throw err;
    }

    if (normReq === CATEGORY_IMAGE && !m.image_output) {
      const err = new Error(`Model '${m.name}' does not support image generation (category is ${m.category}).`);
      err.code = 'unsupported_capability';
      err.status = 400;
      throw err;
    }

    if (normReq === CATEGORY_VIDEO) {
      if (!m.video_output || m.video_test_status !== STATUS_PASSED) {
        const err = new Error(`Model '${m.name}' does not support video generation or has not passed video generation testing.`);
        err.code = 'unsupported_capability';
        err.status = 400;
        throw err;
      }
    }

    if (!m.available || m.creditsExhausted) {
      const err = new Error(`Model '${m.name}' is currently unavailable due to exhausted quota.`);
      err.code = 'quota_exhausted';
      err.status = 429;
      throw err;
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // MODEL-BY-MODEL TESTING ENGINE
  // ---------------------------------------------------------------------------

  async testModelText(modelId, runner) {
    const m = this.getModel(modelId);
    if (!m) throw new Error(`Model '${modelId}' not found.`);
    if (!m.text_output) {
      m.text_test_status = STATUS_UNSUPPORTED;
      return { ok: false, status: STATUS_UNSUPPORTED, message: 'Model does not support text output.' };
    }

    const prompt = TEST_PROMPTS.text;
    m.text_test_status = STATUS_TESTING;
    const started = Date.now();
    try {
      const result = await runner({
        providerName: m.provider_id || normalizeProviderId(m.provider),
        modelId: m.id,
        text: prompt,
        category: CATEGORY_TEXT,
      });

      const responseText = String(result?.text || '').trim();
      if (!responseText) {
        throw new Error('Empty text response received from model.');
      }

      m.text_test_status = STATUS_PASSED;
      m.text_tested_at = new Date().toISOString();
      m.last_successful_test = new Date().toISOString();
      m.last_error = null;

      return {
        ok: true,
        status: STATUS_PASSED,
        modelId: m.id,
        provider: m.provider,
        durationMs: Date.now() - started,
        preview: responseText.slice(0, 100),
        usage: result?.usage || null,
        testedAt: m.text_tested_at,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      m.text_test_status = /quota|rate limit|credits/i.test(msg) ? STATUS_QUOTA_EXHAUSTED : STATUS_FAILED;
      m.text_tested_at = new Date().toISOString();
      m.last_error = msg;

      return {
        ok: false,
        status: m.text_test_status,
        modelId: m.id,
        provider: m.provider,
        durationMs: Date.now() - started,
        error: msg,
        testedAt: m.text_tested_at,
      };
    }
  }

  async testModelImage(modelId, runner) {
    const m = this.getModel(modelId);
    if (!m) throw new Error(`Model '${modelId}' not found.`);
    if (!m.image_output) {
      m.image_test_status = STATUS_UNSUPPORTED;
      return { ok: false, status: STATUS_UNSUPPORTED, message: 'Model does not support image generation.' };
    }

    const prompt = TEST_PROMPTS.image;
    m.image_test_status = STATUS_TESTING;
    const started = Date.now();
    try {
      const result = await runner({
        providerName: m.provider_id || normalizeProviderId(m.provider),
        modelId: m.id,
        text: prompt,
        category: CATEGORY_IMAGE,
      });

      if (!result?.dataUrl && !result?.imageUrl && !result?.image) {
        throw new Error('No valid image data or URL returned from model.');
      }

      m.image_test_status = STATUS_PASSED;
      m.image_tested_at = new Date().toISOString();
      m.last_successful_test = new Date().toISOString();
      m.last_error = null;

      return {
        ok: true,
        status: STATUS_PASSED,
        modelId: m.id,
        provider: m.provider,
        durationMs: Date.now() - started,
        hasImageBytes: Boolean(result.dataUrl || result.bytes),
        bytes: result.bytes || 0,
        contentType: result.contentType || 'image/jpeg',
        testedAt: m.image_tested_at,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      m.image_test_status = /quota|rate limit|credits/i.test(msg) ? STATUS_QUOTA_EXHAUSTED : STATUS_FAILED;
      m.image_tested_at = new Date().toISOString();
      m.last_error = msg;

      return {
        ok: false,
        status: m.image_test_status,
        modelId: m.id,
        provider: m.provider,
        durationMs: Date.now() - started,
        error: msg,
        testedAt: m.image_tested_at,
      };
    }
  }

  async testModelVideo(modelId, runner) {
    const m = this.getModel(modelId);
    if (!m) throw new Error(`Model '${modelId}' not found.`);
    if (!m.video_output) {
      m.video_test_status = STATUS_UNSUPPORTED;
      return { ok: false, status: STATUS_UNSUPPORTED, message: 'Model does not support video generation.' };
    }

    const prompt = TEST_PROMPTS.video;
    m.video_test_status = STATUS_TESTING;
    const started = Date.now();
    try {
      const result = await runner({
        providerName: m.provider_id || normalizeProviderId(m.provider),
        modelId: m.id,
        text: prompt,
        category: CATEGORY_VIDEO,
      });

      if (!result?.videoUrl && !result?.playable) {
        throw new Error('No valid playable video output or URL returned from provider.');
      }

      m.video_test_status = STATUS_PASSED;
      m.video_tested_at = new Date().toISOString();
      m.last_successful_test = new Date().toISOString();
      m.last_error = null;

      return {
        ok: true,
        status: STATUS_PASSED,
        modelId: m.id,
        provider: m.provider,
        durationMs: Date.now() - started,
        videoUrl: result.videoUrl,
        testedAt: m.video_tested_at,
      };
    } catch (err) {
      const msg = err?.message || String(err);
      const isPaid = /paid|credit|billing|usdc|key required/i.test(msg);
      m.video_test_status = isPaid ? STATUS_PAID_ONLY : (/quota|rate limit/i.test(msg) ? STATUS_QUOTA_EXHAUSTED : STATUS_FAILED);
      m.video_tested_at = new Date().toISOString();
      m.last_error = msg;

      return {
        ok: false,
        status: m.video_test_status,
        modelId: m.id,
        provider: m.provider,
        durationMs: Date.now() - started,
        error: msg,
        testedAt: m.video_tested_at,
      };
    }
  }

  async testModel(modelId, capability, runner) {
    const norm = String(capability || 'text').toLowerCase().trim();
    if (norm === 'image') return this.testModelImage(modelId, runner);
    if (norm === 'video') return this.testModelVideo(modelId, runner);
    return this.testModelText(modelId, runner);
  }

  // Model-by-Model Capability Diagnostics Report
  getModelCapabilityReport() {
    const report = [];
    for (const m of this.models.values()) {
      report.push({
        provider_id: m.provider_id,
        provider_name: m.provider,
        model_id: m.id,
        model_name: m.name,
        category: m.category,
        text_supported: Boolean(m.text_output),
        text_test_status: m.text_test_status || STATUS_NOT_TESTED,
        text_tested_at: m.text_tested_at,
        image_supported: Boolean(m.image_output),
        image_test_status: m.image_test_status || STATUS_NOT_TESTED,
        image_tested_at: m.image_tested_at,
        video_supported: Boolean(m.video_output),
        video_test_status: m.video_test_status || STATUS_UNSUPPORTED,
        video_tested_at: m.video_tested_at,
        availability_status: m.availability_status,
        quota_status: m.quota_status,
        free: m.free,
        pricing_status: m.free ? 'FREE' : 'PAID',
        last_error: m.last_error,
        last_successful_test: m.last_successful_test,
      });
    }
    return report;
  }

  auditProviderMatrix(providersConfig = {}) {
    const matrix = {};
    for (const m of this.models.values()) {
      const p = m.provider_id;
      if (!matrix[p]) {
        matrix[p] = {
          provider_id: p,
          provider_name: m.provider,
          configured: m.configured,
          supported_categories: new Set(),
          models: [],
          text_models_count: 0,
          image_models_count: 0,
          video_models_count: 0,
          quota_status: m.quota_status,
        };
      }
      matrix[p].supported_categories.add(m.category);
      matrix[p].models.push({
        id: m.id,
        name: m.name,
        category: m.category,
        available: m.available,
        free: m.free,
        text_test_status: m.text_test_status,
        image_test_status: m.image_test_status,
        video_test_status: m.video_test_status,
      });
      if (m.text_output) matrix[p].text_models_count += 1;
      if (m.image_output) matrix[p].image_models_count += 1;
      if (m.video_output && m.video_test_status === STATUS_PASSED) matrix[p].video_models_count += 1;
    }

    const out = {};
    for (const [k, v] of Object.entries(matrix)) {
      out[k] = {
        ...v,
        supported_categories: Array.from(v.supported_categories),
      };
    }
    return out;
  }

  createVideoJob({ prompt, modelId, uid = 'anonymous', metadata = {} } = {}) {
    const videoModels = this.getModelsByCategory(CATEGORY_VIDEO, { availableOnly: true });
    if (!videoModels.length) {
      const err = new Error('No video generation models are currently available. Please configure a video generation provider API key.');
      err.code = 'no_video_provider';
      err.status = 503;
      throw err;
    }

    const jobId = 'vid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const job = {
      jobId,
      prompt,
      model: modelId,
      uid,
      status: 'processing',
      progress: 10,
      videoUrl: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata,
    };

    this.videoJobs.set(jobId, job);
    return job;
  }

  getVideoJob(jobId) {
    return this.videoJobs.get(jobId) || null;
  }

  updateVideoJob(jobId, updates = {}) {
    const job = this.videoJobs.get(jobId);
    if (!job) return null;
    Object.assign(job, updates, { updatedAt: new Date().toISOString() });
    return job;
  }
}

function createModelCapabilityService(opts = {}) {
  return new ModelCapabilityService(opts);
}

module.exports = {
  CATEGORY_TEXT,
  CATEGORY_IMAGE,
  CATEGORY_VIDEO,
  ALL_CATEGORIES,
  STATUS_NOT_TESTED,
  STATUS_TESTING,
  STATUS_PASSED,
  STATUS_FAILED,
  STATUS_QUOTA_EXHAUSTED,
  STATUS_UNSUPPORTED,
  STATUS_PAID_ONLY,
  STATUS_TEMPORARILY_UNAVAILABLE,
  TEST_PROMPTS,
  classifyModelCapabilities,
  enrichModelWithCapabilities,
  createModelCapabilityService,
};
