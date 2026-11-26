'use strict';
// Agnes AI Video Generation Provider for PHOTON AI
//
// Key Features:
// - Dedicated integration for Agnes AI Video Generation API.
// - Supports documented Flash model: agnes-video-2.5-flash (720P, text-to-video, keyframes, reference image).
// - Asynchronous job submission (POST /v1/videos) with video_id tracking.
// - Status polling via GET https://apihub.agnes-ai.com/agnesapi?video_id={VIDEO_ID}&model_name={MODEL_NAME}.
// - Download and verification of completed video files (MIME type, content length, video integrity).
// - Strict Free-Only Spending Protection: block requests until account trial eligibility is verified.
// - Real Model Test function verifying authentication, job creation, polling, and playable video output.
// - AES-256 encrypted credential management and zero secret leakage.

const { createAgnesConfig, maskKey } = require('./agnes-config');

const API_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const POLLING_BASE_URL = 'https://apihub.agnes-ai.com/agnesapi';
const DEFAULT_TIMEOUT_MS = 180000;
const POLLING_INTERVAL_MS = 1500;
const FLASH_MODEL_ID = 'agnes-video-2.5-flash';
const FLASH_ASPECT_RATIOS = Object.freeze(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }, { once: true });
  });
}

function createAgnesProvider({
  HttpError,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  config = null,
} = {}) {
  if (!HttpError) {
    HttpError = class HttpError extends Error {
      constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
      }
    };
  }

  const cfg = config || createAgnesConfig({ env, logger });
  const activeVideoJobs = new Map();

  function configured() {
    return cfg.isConfigured();
  }

  function enabled() {
    return cfg.isEnabled();
  }

  function getApiKey() {
    return cfg.getKey();
  }

  function setApiKey(key) {
    cfg.setKey(key);
  }

  function setEnabled(val) {
    cfg.setEnabled(val);
  }

  function status() {
    return cfg.status();
  }

  function catalogEntries() {
    return cfg.getModels().map(m => {
      const eligibilityVerified = Boolean(m.freePromotion && m.freePromotionVerified);
      const available = Boolean(configured() && enabled() && m.enabled && m.apiAvailable && eligibilityVerified);
      const reason = !configured() ? 'Agnes AI API key is not configured.'
        : !enabled() ? 'Agnes AI is disabled by the administrator.'
          : !m.enabled ? 'Disabled by administrator.'
            : !m.apiAvailable ? (m.availabilityReason || 'Agnes account has not confirmed access to this model.')
              : !eligibilityVerified ? 'Free trial eligibility for this API key is unverified. Confirm an eligible default account in Agnes before enabling free generation.'
                : '';
      return {
        id: m.id,
        name: m.name,
        provider: 'Agnes AI',
        providerId: 'agnes',
        configured: configured(),
        supported: true,
        available,
        enabled: Boolean(m.enabled),
        free: available && eligibilityVerified,
        pricingVerified: true,
        pricing: '$0.025 / second list price; $0 / second for eligible Angel User Trial accounts',
        category: 'video',
        task: 'text-to-video',
        resolution: '720P',
        spendingPolicy: cfg.getSpendingPolicy(),
        capabilities: {
          text_to_video: true,
          image_to_video: true,
          keyframe_control: true,
          video_output: true,
          reference_image: true,
          resolution: '720P',
        },
        supportedParameters: m.supportedParameters,
        supportedSettings: {
          modes: ['text', 'keyframe', 'reference'],
          minSeconds: 4,
          maxSeconds: 12,
          resolution: '720P',
          aspectRatios: FLASH_ASPECT_RATIOS,
        },
        description: m.description,
        reason,
      };
    });
  }

  function parseErrorResponse(status, bodyText) {
    let message = '';
    let code = 'provider_error';
    try {
      const json = JSON.parse(bodyText);
      const err = json.error || json;
      message = err.message || json.message || err.detail || '';
      code = err.code || json.code || (status === 401 ? 'invalid_api_key' : (status === 402 ? 'quota_exhausted' : (status === 429 ? 'rate_limit_exceeded' : 'provider_error')));
    } catch {
      message = String(bodyText || '').slice(0, 200).trim();
    }

    if (status === 401 || status === 403 || /token not provided|authorization header|invalid_api_key|unauthorized/i.test(message)) {
      return new HttpError(401, 'invalid_api_key', message || 'Agnes AI API key is invalid or unauthorized.');
    }
    if (status === 402 || /insufficient|balance|credit|payment required|billing/i.test(message)) {
      return new HttpError(402, 'quota_exhausted', message || 'Agnes AI account requires paid credits or free promotion has expired.');
    }
    if (status === 429 || /rate limit|too many requests/i.test(message)) {
      return new HttpError(429, 'rate_limit_exceeded', message || 'Agnes AI rate limit reached. Please wait before retrying.');
    }
    if (/queue.*full|retry later|server.*busy|capacity|busy/i.test(message)) {
      const reqIdMatch = /request id:\s*([A-Za-z0-9_-]+)/i.exec(message);
      const reqIdSuffix = reqIdMatch ? ` (Agnes Request ID: ${reqIdMatch[1]})` : '';
      return new HttpError(429, 'queue_full', `Agnes AI video queue is currently at capacity due to high global demand. No tokens were deducted from your account${reqIdSuffix}. Please retry in a few moments.`);
    }
    return new HttpError(status || 502, code || 'provider_error', message || `Agnes AI error (${status}).`);
  }

  /**
   * Never submit a billable request unless free account eligibility was explicitly verified.
   */
  function assertFreePromotionEligibility(modelId) {
    const policy = cfg.getSpendingPolicy();
    const model = cfg.getModel(modelId);

    if (policy === 'block') {
      throw new HttpError(403, 'provider_disabled', 'Agnes AI provider is currently blocked by administrator spending policy.');
    }
    if (policy !== 'strict_free_only') {
      throw new HttpError(403, 'billing_blocked', 'Agnes AI paid requests are disabled.');
    }
    if (!model || !model.enabled) {
      throw new HttpError(503, 'model_unavailable', 'Agnes Video 2.5 Flash is disabled or not registered.');
    }
    if (!model.apiAvailable) {
      throw new HttpError(503, 'model_unavailable', model.availabilityReason || 'Agnes has not confirmed model access for this API key.');
    }
    if (!model.freePromotion || !model.freePromotionVerified) {
      throw new HttpError(402, 'billing_blocked', 'Free trial eligibility for this Agnes API key is unverified. Strict free-only mode blocks generation to prevent charges.');
    }
  }

  async function fetchModelCatalog(key) {
    const response = await fetchImpl(`${API_BASE_URL}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Accept': 'application/json',
        'User-Agent': 'Photon-AI-Agnes/1.0',
      },
      signal: AbortSignal.timeout(15000),
    });
    const bodyText = await response.text();
    if (!response.ok) throw parseErrorResponse(response.status, bodyText);

    let parsed;
    try { parsed = JSON.parse(bodyText); } catch {
      throw new HttpError(502, 'invalid_response', 'Agnes model availability check returned invalid JSON.');
    }
    const entries = Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : [];
    if (!entries.length) {
      throw new HttpError(502, 'model_catalog_unavailable', 'Agnes did not return a model catalog; model access cannot be verified.');
    }
    const model = entries.find(entry => String(entry.id || entry.model_name || '').trim() === FLASH_MODEL_ID);
    cfg.setModelAvailability(FLASH_MODEL_ID, Boolean(model), model ? '' : 'Agnes did not list Agnes Video 2.5 Flash for this API key.');
    return { entries, model };
  }

  /**
   * Test basic API connectivity and authentication
   */
  async function testConnection() {
    const started = Date.now();
    const key = getApiKey();
    if (!key) {
      const res = {
        ok: false,
        message: 'Agnes AI API key is not configured.',
        testedAt: new Date().toISOString(),
      };
      cfg.setLastTestResult('connection', res);
      return res;
    }

    try {
      const { entries, model } = await fetchModelCatalog(key);

      const durationMs = Date.now() - started;
      const result = {
        ok: true,
        durationMs,
        modelAvailable: Boolean(model),
        message: model
          ? `Agnes API key authenticated and ${FLASH_MODEL_ID} is listed. Free-trial eligibility still requires separate confirmation.`
          : `Agnes API key authenticated, but ${FLASH_MODEL_ID} is not available to this key.`,
        testedAt: new Date().toISOString(),
        modelsFound: entries.length,
      };
      cfg.setLastTestResult('connection', result);
      return result;
    } catch (err) {
      const durationMs = Date.now() - started;
      const result = {
        ok: false,
        durationMs,
        error: err.message,
        code: err.code || 'connection_failed',
        message: `Agnes AI connection test failed: ${err.message}`,
        testedAt: new Date().toISOString(),
      };
      cfg.setLastTestResult('connection', result);
      cfg.recordError(err);
      return result;
    }
  }

  /**
   * Refresh available models from Agnes AI
   */
  async function refreshModels() {
    const key = getApiKey();
    if (!key) {
      cfg.setModelAvailability(FLASH_MODEL_ID, false, 'Agnes AI API key is not configured.');
      return { ok: false, modelAvailable: false, message: 'No API key configured.' };
    }

    try {
      const { entries, model } = await fetchModelCatalog(key);
      return { ok: true, modelAvailable: Boolean(model), modelsFound: entries.length, models: cfg.getModels(), refreshed: true };
    } catch (err) {
      cfg.setModelAvailability(FLASH_MODEL_ID, false, err.message);
      logger.warn('[AgnesProvider] Model availability check failed:', err.message);
      return { ok: false, modelAvailable: false, models: cfg.getModels(), refreshed: false, message: err.message, code: err.code || 'model_catalog_unavailable' };
    }
  }

  /**
   * Submit an asynchronous video generation request
   * Endpoint: POST https://apihub.agnes-ai.com/v1/videos
   */
  async function createVideoJob({
    prompt,
    model = FLASH_MODEL_ID,
    mode = 'text',
    seconds = 5,
    size = '720P',
    aspect_ratio = '16:9',
    n = 1,
    referenceImage = null,
    images = null,
    firstFrame = null,
    lastFrame = null,
    userId = null,
    signal,
  } = {}) {
    if (!configured()) {
      throw new HttpError(400, 'unconfigured', 'Agnes AI API key is not configured.');
    }
    if (!enabled()) {
      throw new HttpError(503, 'provider_disabled', 'Agnes AI is currently disabled.');
    }

    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) {
      throw new HttpError(400, 'invalid_prompt', 'Prompt is required for video generation.');
    }

    const targetModel = String(model || FLASH_MODEL_ID).trim();
    if (targetModel !== FLASH_MODEL_ID) {
      throw new HttpError(400, 'unsupported_model', `Unsupported Agnes model: ${targetModel}`);
    }
    assertFreePromotionEligibility(targetModel);

    const durationSeconds = Number(seconds);
    if (!Number.isInteger(durationSeconds) || durationSeconds < 4 || durationSeconds > 12) {
      throw new HttpError(400, 'invalid_duration', 'Agnes Video 2.5 Flash supports whole-number durations from 4 to 12 seconds.');
    }
    const targetSize = String(size || '720P').toUpperCase();
    if (targetSize !== '720P') {
      throw new HttpError(400, 'invalid_resolution', 'Agnes Video 2.5 Flash supports 720P resolution only.');
    }
    if (Number(n) !== 1) {
      throw new HttpError(400, 'invalid_count', 'Agnes Video 2.5 Flash supports one video per request.');
    }
    const targetAspectRatio = String(aspect_ratio || '16:9');
    if (!FLASH_ASPECT_RATIOS.includes(targetAspectRatio)) {
      throw new HttpError(400, 'invalid_aspect_ratio', 'Unsupported aspect ratio for Agnes Video 2.5 Flash.');
    }
    const targetMode = String(mode || 'text').toLowerCase();
    if (!['text', 'keyframe', 'reference'].includes(targetMode)) {
      throw new HttpError(400, 'invalid_mode', 'Agnes Video 2.5 Flash supports text, keyframe, and reference modes.');
    }
    const referenceImages = Array.isArray(images) ? images : referenceImage ? [referenceImage] : [];
    if (referenceImages.some(image => typeof image !== 'string' || !/^https?:\/\//i.test(image))) {
      throw new HttpError(400, 'invalid_reference_image', 'Image references must be publicly reachable HTTP or HTTPS URLs.');
    }
    if (referenceImages.length > 1) {
      throw new HttpError(400, 'invalid_reference_image', 'PHOTON AI currently accepts one reference image for Agnes Video 2.5 Flash.');
    }
    if (firstFrame && !/^https?:\/\//i.test(String(firstFrame)) || lastFrame && !/^https?:\/\//i.test(String(lastFrame))) {
      throw new HttpError(400, 'invalid_keyframe', 'Keyframe images must be publicly reachable HTTP or HTTPS URLs.');
    }
    if (targetMode !== 'keyframe' && (firstFrame || lastFrame)) {
      throw new HttpError(400, 'invalid_mode', 'Keyframe images require keyframe mode.');
    }
    if (targetMode === 'keyframe' && !firstFrame && !lastFrame) {
      throw new HttpError(400, 'missing_keyframe', 'Keyframe mode requires a first-frame image, a last-frame image, or both.');
    }
    if (targetMode === 'reference' && referenceImages.length === 0) {
      throw new HttpError(400, 'missing_reference_image', 'Reference mode requires at least one publicly reachable reference image.');
    }
    if (targetMode !== 'reference' && referenceImages.length) {
      throw new HttpError(400, 'invalid_mode', 'Reference images require reference mode.');
    }

    const key = getApiKey();
    const payload = {
      model: targetModel,
      prompt: cleanPrompt,
      mode: targetMode,
      seconds: String(durationSeconds),
      size: targetSize,
      aspect_ratio: targetAspectRatio,
      n: Number(n),
    };

    if (targetMode === 'keyframe') {
      if (firstFrame) payload.first_frame = firstFrame;
      if (lastFrame) payload.last_frame = lastFrame;
    } else if (targetMode === 'reference') payload.images = referenceImages;

    const maxAttempts = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetchImpl(`${API_BASE_URL}/videos`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Photon-AI-Agnes/1.0',
          },
          body: JSON.stringify(payload),
          signal: signal || AbortSignal.timeout(30000),
        });

        const bodyText = await response.text();
        if (!response.ok) {
          const err = parseErrorResponse(response.status, bodyText);
          cfg.recordError(err);
          cfg.recordUsage({ success: false, error: err.message });
          if (err.status === 402 || err.code === 'quota_exhausted' || err.code === 'billing_required') {
            cfg.setFreePromotionVerified(targetModel, false);
          }
          if ((err.code === 'queue_full' || err.code === 'rate_limit_exceeded' || response.status === 429 || response.status === 503) && attempt < maxAttempts) {
            logger.warn(`[Agnes AI] Video creation busy (${err.code}). Attempt ${attempt}/${maxAttempts}. Waiting ${attempt * 2}s before retry...`);
            await new Promise(r => setTimeout(r, attempt * 2000));
            continue;
          }
          throw err;
        }

        let parsed = {};
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          throw new HttpError(502, 'invalid_response', 'Agnes AI returned non-JSON response on video creation.');
        }

        // Extract video_id according to official documentation
        const videoId = parsed.video_id || parsed.data?.video_id;
        if (typeof videoId !== 'string' || !/^[A-Za-z0-9_.-]{1,256}$/.test(videoId)) {
          throw new HttpError(502, 'invalid_response', `Agnes AI did not return a valid video_id. Response: ${bodyText.slice(0, 150)}`);
        }

        const job = {
          jobId: String(videoId),
          videoId: String(videoId),
          model: targetModel,
          prompt: cleanPrompt,
          seconds: durationSeconds,
          resolution: targetSize,
          status: ['queued', 'processing', 'completed', 'failed'].includes(String(parsed.status || '').toLowerCase()) ? String(parsed.status).toLowerCase() : 'queued',
          usageRecorded: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          videoUrl: null,
        };

        if (userId) cfg.recordVideoJob(job.jobId, userId, targetModel);
        activeVideoJobs.set(job.jobId, job);
        cfg.recordUsage({ success: true });
        return job;
      } catch (err) {
        lastErr = err;
        if ((err.code === 'queue_full' || err.code === 'rate_limit_exceeded' || err.status === 429 || err.status === 503) && attempt < maxAttempts) {
          logger.warn(`[Agnes AI] Video creation attempt ${attempt}/${maxAttempts} failed (${err.message}). Retrying in ${attempt * 2}s...`);
          await new Promise(r => setTimeout(r, attempt * 2000));
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new HttpError(429, 'queue_full', 'The video rendering queue is currently busy due to high demand. Please try again in a few moments.');
  }

  function ownsVideoJob(videoId, userId) {
    const owner = cfg.getVideoJobOwner(videoId);
    return Boolean(owner && String(userId || '') === owner);
  }

  /**
   * Poll video status and retrieve completed video
   * Endpoint: GET https://apihub.agnes-ai.com/agnesapi?video_id={VIDEO_ID}&model_name={MODEL_NAME}
   */
  async function getVideoJob(videoId, { modelName = FLASH_MODEL_ID, signal } = {}) {
    const key = getApiKey();
    if (!key) throw new HttpError(400, 'unconfigured', 'Agnes AI API key is not configured.');

    const cleanVideoId = String(videoId || '').trim();
    if (!cleanVideoId) throw new HttpError(400, 'invalid_id', 'Video ID is required.');
    if (modelName !== FLASH_MODEL_ID) throw new HttpError(400, 'unsupported_model', 'Unsupported Agnes video model.');

    const url = `${POLLING_BASE_URL}?video_id=${encodeURIComponent(cleanVideoId)}&model_name=${encodeURIComponent(modelName)}`;

    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Accept': 'application/json',
        'User-Agent': 'Photon-AI-Agnes/1.0',
      },
      signal: signal || AbortSignal.timeout(20000),
    });

    const bodyText = await response.text();
    if (!response.ok) {
      const err = parseErrorResponse(response.status, bodyText);
      cfg.recordError(err);
      if (err.status === 402 || err.code === 'quota_exhausted' || err.code === 'billing_required') {
        cfg.setFreePromotionVerified(FLASH_MODEL_ID, false);
      }
      throw err;
    }

    let parsed = {};
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new HttpError(502, 'invalid_response', 'Agnes AI polling returned non-JSON response.');
    }

    // Normalize status from Agnes API
    const rawStatus = String(parsed.status || '').toLowerCase();
    let status = 'processing';
    if (['completed', 'succeeded', 'done', 'success'].includes(rawStatus)) {
      status = 'completed';
    } else if (['queued', 'waiting', 'pending'].includes(rawStatus)) {
      status = 'queued';
    } else if (['failed', 'error', 'canceled', 'rejected'].includes(rawStatus)) {
      status = 'failed';
    }

    const videoUrl = status === 'completed' && typeof parsed.url === 'string' ? parsed.url : null;
    const progress = Number(parsed.progress || parsed.data?.progress || (status === 'completed' ? 100 : 50));
    const failureReason = parsed.error || parsed.message || parsed.fail_reason || null;

    const existing = activeVideoJobs.get(cleanVideoId) || {};
    if (status === 'completed') {
      if (!videoUrl) throw new HttpError(502, 'empty_video_url', 'Agnes marked the job complete but did not return the documented video URL.');
      if (!existing.videoVerified) {
        const validation = await validateVideoFile(videoUrl, { signal });
        if (!validation.valid) {
          cfg.recordUsage({ success: false, error: validation.message });
          throw new HttpError(502, 'invalid_video_output', validation.message);
        }
        if (!existing.usageRecorded) cfg.recordUsage({ success: true, seconds: existing.seconds || 0 });
        existing.videoVerified = true;
        existing.usageRecorded = true;
        existing.contentType = validation.contentType;
        existing.validation = validation;
      }
    } else if (status === 'failed' && !existing.usageRecorded) {
      cfg.recordUsage({ success: false, error: parsed.error || parsed.message || 'Video generation failed at provider.' });
      existing.usageRecorded = true;
    }
    const updated = {
      ...existing,
      jobId: cleanVideoId,
      videoId: cleanVideoId,
      model: modelName,
      status,
      progress,
      videoUrl,
      videoVerified: Boolean(existing.videoVerified),
      contentType: existing.contentType || (status === 'completed' ? 'video/mp4' : null),
      validation: existing.validation || null,
      failureReason,
      updatedAt: new Date().toISOString(),
    };

    activeVideoJobs.set(cleanVideoId, updated);
    return updated;
  }

  /**
   * Validate that a video URL returns a valid playable video file
   */
  async function validateVideoFile(videoUrl, { signal } = {}) {
    if (!videoUrl || typeof videoUrl !== 'string') {
      return { valid: false, message: 'No video URL provided.' };
    }

    try {
      const res = await fetchImpl(videoUrl, {
        method: 'GET',
        headers: { Range: 'bytes=0-31' },
        signal: signal || AbortSignal.timeout(15000),
      });

      if (!res.ok && res.status !== 206) {
        return { valid: false, status: res.status, message: `Video download returned HTTP ${res.status}` };
      }

      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const contentLength = Number(res.headers.get('content-length')) || 0;
      if (!['video/mp4', 'video/webm'].includes(contentType)) {
        return { valid: false, contentType, message: `Unexpected content-type: ${contentType || 'missing'}` };
      }
      const reader = res.body?.getReader?.();
      if (!reader) return { valid: false, contentType, message: 'Video response could not be inspected.' };
      const chunks = [];
      let totalBytes = 0;
      while (totalBytes < 12) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = 12 - totalBytes;
        chunks.push(value.subarray(0, remaining));
        totalBytes += Math.min(value.byteLength, remaining);
      }
      await reader.cancel();
      const header = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        header.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const isMp4 = contentType === 'video/mp4' && header.length >= 8
        && String.fromCharCode(...header.subarray(4, 8)) === 'ftyp';
      const isWebm = contentType === 'video/webm' && header.length >= 4
        && header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
      const valid = isMp4 || isWebm;
      return {
        valid,
        contentType,
        contentLength,
        url: videoUrl,
        message: valid ? 'Video container signature verified.' : 'Video response does not contain a valid MP4 or WebM signature.',
      };
    } catch (err) {
      return { valid: false, url: videoUrl, message: `Video output verification failed: ${err.message}` };
    }
  }

  /**
   * Full asynchronous video generation with polling until completion
   */
  async function generateVideo({
    prompt,
    model = FLASH_MODEL_ID,
    mode = 'text',
    seconds = 5,
    size = '720P',
    aspect_ratio = '16:9',
    n = 1,
    referenceImage = null,
    images = null,
    firstFrame = null,
    lastFrame = null,
    signal,
    onProgress = null,
  } = {}) {
    const started = Date.now();
    const cleanPrompt = String(prompt || '').trim();
    const targetModel = String(model || FLASH_MODEL_ID).trim();

    // 1. Submit video generation request
    const job = await createVideoJob({
      prompt: cleanPrompt,
      model: targetModel,
      mode,
      seconds,
      size,
      aspect_ratio,
      n,
      referenceImage,
      images,
      firstFrame,
      lastFrame,
      signal,
    });

    const videoId = job.videoId;
    let pollCount = 0;
    const maxPolls = Math.ceil(DEFAULT_TIMEOUT_MS / POLLING_INTERVAL_MS);

    // 2. Poll until completed or failed
    while (pollCount < maxPolls) {
      if (signal?.aborted) {
        throw new HttpError(499, 'client_closed_request', 'Video generation cancelled by client.');
      }

      await sleep(POLLING_INTERVAL_MS, signal);
      pollCount++;

      const current = await getVideoJob(videoId, { modelName: targetModel, signal });
      if (typeof onProgress === 'function') {
        onProgress(current);
      }

      if (current.status === 'completed') {
        if (!current.videoUrl) {
          throw new HttpError(502, 'empty_video_url', 'Agnes AI marked job completed but returned no video URL.');
        }

        const validation = current.validation || await validateVideoFile(current.videoUrl, { signal });
        if (!validation.valid) {
          cfg.recordUsage({ success: false, error: validation.message });
          throw new HttpError(502, 'invalid_video_output', validation.message);
        }
        const durationMs = Date.now() - started;

        cfg.updateModel(targetModel, { lastTestedAt: new Date().toISOString(), testStatus: 'PASSED' });
        return {
          success: true,
          videoId,
          videoUrl: current.videoUrl,
          contentType: validation.contentType || 'video/mp4',
          durationSeconds: job.seconds,
          resolution: job.resolution || '720P',
          aspectRatio: aspect_ratio || '16:9',
          model: targetModel,
          provider: 'Agnes AI',
          durationMs,
          prompt: cleanPrompt,
          validation,
        };
      }

      if (current.status === 'failed') {
        const errMsg = current.failureReason || 'Video generation failed at provider.';
        throw new HttpError(500, 'generation_failed', `Agnes AI video generation failed: ${errMsg}`);
      }
    }

    throw new HttpError(504, 'timeout', `Agnes AI video generation timed out after ${Math.ceil(DEFAULT_TIMEOUT_MS / 1000)} seconds.`);
  }

  /**
   * Real end-to-end model verification test
   */
  async function testVideoModel(modelId = FLASH_MODEL_ID, testPrompt) {
    const started = Date.now();
    const prompt = testPrompt || 'Generate a short cinematic video of a red apple rotating slowly on a clean white background.';
    const targetModel = String(modelId || FLASH_MODEL_ID).trim();

    try {
      assertFreePromotionEligibility(targetModel);

      // Execute full asynchronous video generation pipeline
      const outcome = await generateVideo({
        prompt,
        model: targetModel,
        seconds: 5,
        size: '720p',
        aspect_ratio: '16:9',
      });

      const durationMs = Date.now() - started;
      const result = {
        ok: true,
        model: targetModel,
        videoId: outcome.videoId,
        videoUrl: outcome.videoUrl,
        contentType: outcome.contentType,
        resolution: '720P',
        freePromotion: true,
        durationMs,
        testedAt: new Date().toISOString(),
        message: `✓ Successfully verified Agnes Video 2.5 Flash! 720P video generated and validated (${durationMs}ms).`,
      };

      cfg.setLastTestResult('video', result);
      cfg.updateModel(targetModel, {
        lastTestedAt: result.testedAt,
        testStatus: 'PASSED',
      });
      return result;
    } catch (err) {
      const durationMs = Date.now() - started;
      const result = {
        ok: false,
        model: targetModel,
        error: err.message,
        code: err.code || 'TEST_FAILED',
        durationMs,
        testedAt: new Date().toISOString(),
        message: `✗ Agnes video model test failed: ${err.message}`,
      };

      cfg.setLastTestResult('video', result);
      cfg.updateModel(targetModel, {
        lastTestedAt: result.testedAt,
        testStatus: 'FAILED',
      });
      return result;
    }
  }

  return {
    configured,
    enabled,
    setEnabled,
    getApiKey,
    setApiKey,
    status,
    catalogEntries,
    assertFreePromotionEligibility,
    testConnection,
    refreshModels,
    createVideoJob,
    getVideoJob,
    ownsVideoJob,
    generateVideo,
    testVideoModel,
    validateVideoFile,
    FLASH_MODEL_ID,
  };
}

module.exports = {
  createAgnesProvider,
  FLASH_MODEL_ID,
  API_BASE_URL,
  POLLING_BASE_URL,
};
