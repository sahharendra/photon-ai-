'use strict';
// PHOTON AI – Centralized Model Capability Detection & Classification Service
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
//    - Only models with video_output: true can be displayed or executed in VIDEO mode.
//    - If no video provider is configured, VIDEO mode shows "No video generation models are currently available."

const CATEGORY_TEXT = 'text';
const CATEGORY_IMAGE = 'image';
const CATEGORY_VIDEO = 'video';

const ALL_CATEGORIES = Object.freeze([CATEGORY_TEXT, CATEGORY_IMAGE, CATEGORY_VIDEO]);

// Known text-to-image patterns across providers
const IMAGE_GEN_MODEL_REGEX = /^(?:@cf\/(?:black-forest-labs\/flux|stabilityai\/stable-diffusion|bytedance\/stable-diffusion|runwayml\/stable-diffusion)|dall-e|imagen|midjourney|stable-diffusion|flux)/i;

// Known video generation patterns across providers
const VIDEO_GEN_MODEL_REGEX = /(?:svd|stable-video|text-to-video|image-to-video|runway|luma-dream|cogvideox|sora|minimax-video)/i;

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
  if (s.includes('openrouter')) return 'openrouter';
  if (s.includes('gemini') || s.includes('google')) return 'gemini';
  if (s.includes('groq')) return 'groq';
  if (s.includes('nvidia')) return 'nvidia';
  if (s.includes('openai')) return 'openai';
  if (s.includes('anthropic') || s.includes('claude')) return 'anthropic';
  if (s.includes('cohere')) return 'cohere';
  if (s.includes('stability')) return 'stability';
  if (s.includes('pollinations')) return 'pollinations';
  if (s.includes('codecraft')) return 'codecraft';
  if (s.includes('llmtr')) return 'llmtr';
  if (s.includes('ollama')) return 'ollama';
  if (s.includes('runway')) return 'runway';
  if (s.includes('luma')) return 'luma';
  return s || 'unknown';
}

function classifyModelCapabilities(model = {}) {
  const id = String(model.id || '').trim();
  const name = String(model.name || id).trim();
  const task = String(model.task || '').trim().toLowerCase();
  const rawCat = String(model.category || '').trim().toLowerCase();
  const desc = String(model.description || '').toLowerCase();
  const rawCaps = model.capabilities || {};

  let text_input = true;
  let text_output = false;
  let image_input = false;
  let image_output = false;
  let video_input = false;
  let video_output = false;
  let category = CATEGORY_TEXT;
  const supported_tasks = [];

  // Check 1: Video generation model
  const isExplicitVideo = task === 'text-to-video' || task === 'image-to-video' || task === 'video-generation' || rawCat.includes('video');
  const isVideoRegex = VIDEO_GEN_MODEL_REGEX.test(id) && !id.includes('caption') && !id.includes('transcription');

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
  const isExplicitImage = task === 'text-to-image' || task === 'image-to-image' || rawCat.includes('image');
  const isImageRegex = IMAGE_GEN_MODEL_REGEX.test(id) && !id.includes('ocr') && !id.includes('caption') && !id.includes('vision');

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

  // Multimodal input understanding checks:
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
    last_checked_at: new Date().toISOString(),
  };
}

class ModelCapabilityService {
  constructor({ quotaMonitor = null, logger = console } = {}) {
    this.quotaMonitor = quotaMonitor;
    this.logger = logger;
    this.models = new Map();
    this.videoJobs = new Map();
  }

  // Registers and classifies an array of models
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
      const enriched = enrichModelWithCapabilities(raw, quotaStatus);
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
    let list = Array.from(this.models.values()).filter(m => m.category === normCat);
    if (availableOnly) {
      list = list.filter(m => m.available && !m.creditsExhausted);
    }
    if (typeof planFilter === 'function') {
      list = list.filter(planFilter);
    }
    return list;
  }

  // Returns counts of available & total models per category
  getCategoryStats({ planFilter = null } = {}) {
    const stats = {
      [CATEGORY_TEXT]: { total: 0, available: 0, models: [] },
      [CATEGORY_IMAGE]: { total: 0, available: 0, models: [] },
      [CATEGORY_VIDEO]: { total: 0, available: 0, models: [] },
    };

    for (const m of this.models.values()) {
      if (typeof planFilter === 'function' && !planFilter(m)) continue;
      const cat = m.category;
      if (stats[cat]) {
        stats[cat].total += 1;
        if (m.available && !m.creditsExhausted) {
          stats[cat].available += 1;
        }
        stats[cat].models.push({
          id: m.id,
          name: m.name,
          provider: m.provider,
          available: m.available,
          free: m.free,
        });
      }
    }

    return stats;
  }

  // Validates that a model can handle the requested generation category
  assertModelCapability(modelId, requestedCategory) {
    const normReq = normalizeCategory(requestedCategory);
    const m = this.getModel(modelId);
    if (!m) {
      // If model not found in local registry, check if it's an alias or throw
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

    if (normReq === CATEGORY_VIDEO && !m.video_output) {
      const err = new Error(`Model '${m.name}' does not support video generation (category is ${m.category}).`);
      err.code = 'unsupported_capability';
      err.status = 400;
      throw err;
    }

    if (!m.available || m.creditsExhausted) {
      const err = new Error(`Model '${m.name}' is currently unavailable due to exhausted quota.`);
      err.code = 'quota_exhausted';
      err.status = 429;
      throw err;
    }

    return true;
  }

  // Audits provider configuration and returns capability breakdown
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
      });
      if (m.category === CATEGORY_TEXT) matrix[p].text_models_count += 1;
      if (m.category === CATEGORY_IMAGE) matrix[p].image_models_count += 1;
      if (m.category === CATEGORY_VIDEO) matrix[p].video_models_count += 1;
    }

    // Convert sets to arrays
    const out = {};
    for (const [k, v] of Object.entries(matrix)) {
      out[k] = {
        ...v,
        supported_categories: Array.from(v.supported_categories),
      };
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Asynchronous Video Generation Workflow Management
  // ---------------------------------------------------------------------------

  createVideoJob({ prompt, modelId, uid = 'anonymous', metadata = {} } = {}) {
    const model = this.getModel(modelId);
    if (!model || !model.video_output) {
      // Check if any video model is configured
      const videoModels = this.getModelsByCategory(CATEGORY_VIDEO, { availableOnly: true });
      if (!videoModels.length) {
        const err = new Error('No video generation models are currently available. Please configure a video generation provider API key.');
        err.code = 'no_video_provider';
        err.status = 503;
        throw err;
      }
    }

    const jobId = 'vid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const job = {
      jobId,
      prompt,
      model: modelId,
      uid,
      status: 'processing', // 'queued' | 'processing' | 'completed' | 'failed'
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
  classifyModelCapabilities,
  enrichModelWithCapabilities,
  createModelCapabilityService,
};
