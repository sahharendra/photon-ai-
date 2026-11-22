'use strict';

const crypto = require('node:crypto');
const { createZipBuffer, sanitizeZipPath } = require('./artifact-zip');

/**
 * Infer file language from extension or filename
 */
function inferLanguage(filename) {
  const ext = String(filename || '').split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'html':
    case 'htm':
      return 'html';
    case 'css':
      return 'css';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'json':
      return 'json';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'py':
      return 'python';
    case 'php':
      return 'php';
    case 'sql':
      return 'sql';
    case 'svg':
      return 'svg';
    case 'xml':
    case 'yaml':
    case 'yml':
      return ext;
    default:
      return 'plaintext';
  }
}

/**
 * Allowed image MIME types and upload size limits for Artifacts AI Copilot
 */
const ALLOWED_IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB total
const MAX_ATTACHMENTS = 5;

/**
 * Validate and sanitize image attachments for Artifacts AI Copilot
 */
function validateArtifactAttachments(attachments, HttpErrorClass = Error) {
  if (!attachments) return [];
  if (!Array.isArray(attachments)) {
    throw new HttpErrorClass(400, 'invalid_attachments', 'Attachments must be an array.');
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new HttpErrorClass(400, 'invalid_attachments', `Attach no more than ${MAX_ATTACHMENTS} images.`);
  }

  const valid = [];
  let totalBytes = 0;

  for (let i = 0; i < attachments.length; i++) {
    const item = attachments[i];
    if (!item || typeof item !== 'object') {
      throw new HttpErrorClass(400, 'invalid_attachments', `Attachment at index ${i} is invalid.`);
    }

    const name = String(item.name || `image_${i + 1}.png`).trim().slice(0, 120);
    let mimeType = String(item.mimeType || item.type || '').toLowerCase().trim();
    if (mimeType === 'image/jpg') mimeType = 'image/jpeg';

    if (!ALLOWED_IMAGE_MIMES.includes(mimeType)) {
      throw new HttpErrorClass(400, 'invalid_image_format', `Unsupported file type for "${name}". Only PNG, JPG, JPEG, and WEBP image attachments are supported.`);
    }

    let base64Data = String(item.data || item.base64 || item.dataUrl || '').trim();
    if (base64Data.includes(',')) {
      base64Data = base64Data.split(',')[1];
    }
    base64Data = base64Data.replace(/\s+/g, '');

    if (!base64Data) {
      throw new HttpErrorClass(400, 'invalid_image_data', `Attachment "${name}" contains empty image data.`);
    }

    let buf;
    try {
      buf = Buffer.from(base64Data, 'base64');
    } catch {
      throw new HttpErrorClass(400, 'invalid_image_data', `Attachment "${name}" is not valid base64.`);
    }

    if (!buf || buf.length === 0) {
      throw new HttpErrorClass(400, 'invalid_image_data', `Attachment "${name}" contains empty image data.`);
    }

    if (buf.length > MAX_IMAGE_BYTES) {
      throw new HttpErrorClass(400, 'image_too_large', `Image "${name}" exceeds the 5 MB limit (${(buf.length / (1024 * 1024)).toFixed(1)} MB).`);
    }

    totalBytes += buf.length;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new HttpErrorClass(400, 'attachments_too_large', 'Total size of image attachments exceeds 10 MB.');
    }

    // Verify magic bytes for genuine image binary
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    const isJpeg = buf.length > 2 && buf[0] === 0xFF && buf[1] === 0xD8;
    const isWebp = buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';

    if (!isPng && !isJpeg && !isWebp) {
      throw new HttpErrorClass(400, 'invalid_image_format', `File "${name}" is not a valid PNG, JPG, or WEBP image.`);
    }

    valid.push({
      name,
      mimeType,
      data: base64Data,
      kind: 'inline',
      size: buf.length,
      previewUrl: `data:${mimeType};base64,${base64Data}`,
    });
  }

  return valid;
}

/**
 * Check if a model genuinely supports vision/image input
 */
function isVisionCapableModel(model = {}) {
  if (!model) return false;
  if (model.image_input === true) return true;
  if (model.capabilities && (model.capabilities.vision === true || model.capabilities.image_input === true)) return true;
  if (Array.isArray(model.supported_tasks) && (model.supported_tasks.includes('vision') || model.supported_tasks.includes('multimodal'))) return true;
  const id = String(model.id || '').toLowerCase();
  const name = String(model.name || '').toLowerCase();
  if (/(?:vision|multimodal|vl|gpt-4o|claude-3|gemini|pixtral|qwen-vl)/i.test(id) || /(?:vision|multimodal|gpt-4o|claude 3|gemini)/i.test(name)) {
    return true;
  }
  return false;
}

/**
 * Filter available models to return only valid coding/text models for Copilot
 */
function getEligibleCopilotModels(models = []) {
  const result = (models || [])
    .filter(m => {
      if (m.creditsExhausted === true || m.available === false) return false;
      const cat = String(m.category || '').toLowerCase();
      const task = String(m.task || '').toLowerCase();
      // Strictly exclude image generation and video generation models
      if (cat === 'image' || cat === 'video' || task === 'text-to-image' || task === 'text-to-video' || cat === 'image generation' || cat === 'video generation') {
        return false;
      }
      if (m.image_output === true || m.video_output === true) return false;
      // Must support text generation
      return m.text_output !== false;
    })
    .map(m => ({
      id: m.id,
      name: m.name || m.id,
      provider: m.provider || 'AI Provider',
      providerId: m.providerId || 'ai',
      category: 'text',
      free: Boolean(m.free),
      available: m.available !== false && !m.creditsExhausted,
      hasVision: isVisionCapableModel(m),
      contextLength: m.contextLength || 32768,
      pricingVerified: Boolean(m.pricingVerified),
    }));

  if (result.length === 0) {
    result.push({
      id: 'photon-fast',
      name: 'Photon Fast AI (Code Reasoning)',
      provider: 'Photon AI',
      providerId: 'photon_fast',
      category: 'text',
      free: true,
      available: true,
      hasVision: false,
      contextLength: 32768,
      pricingVerified: true,
    });
  }

  return result;
}

/**
 * High-speed fallback code generator using Photon reasoning engine with multimodal support
 */
async function callPollinationsTextCode({ system, text, attachments = [], signal } = {}) {
  const timeoutSignal = AbortSignal.timeout(60000);
  const combined = signal ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal) : timeoutSignal;

  let userContent = text || '';
  if (Array.isArray(attachments) && attachments.length > 0) {
    userContent = `${text || ''}\n\n[Reference Image(s) Attached: ${attachments.map(a => a.name).join(', ')}]\nPlease recreate the visual layout, components, styling, and design based on the attached visual mockup.`;
  }

  const res = await fetch('https://text.pollinations.ai/openai', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Photon-AI-Artifacts/2.0',
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: system || 'You are an expert developer. Provide complete file contents inside markdown code blocks.' },
        { role: 'user', content: userContent }
      ]
    }),
    signal: combined
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Photon code engine returned HTTP ${res.status}: ${errText.slice(0, 100)}`);
  }

  const json = await res.json();
  const choice = json.choices?.[0]?.message?.content || '';
  if (!choice) throw new Error('Photon code engine returned an empty response.');

  return {
    text: choice,
    result: { text: choice },
    usage: { inputTokens: Math.ceil((text?.length || 100) / 4) + (attachments.length * 1000), outputTokens: Math.ceil(choice.length / 4) },
    provider: 'Photon AI (Fast Reasoning)',
    model: 'openai-fast',
  };
}

/**
 * Parse multi-file code blocks from AI response
 */
function parseFilesFromAiResponse(responseText, defaultTitle = 'My Project') {
  const files = [];
  const text = String(responseText || '').trim();

  // Regex to match fenced code blocks with optional language and filename
  // Examples: ```html index.html, ```css style.css, ```javascript script.js, ```jsx App.jsx
  const blockRegex = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match;
  let blockIdx = 0;

  while ((match = blockRegex.exec(text)) !== null) {
    const rawMeta = (match[1] || '').trim();
    const content = (match[2] || '').trimEnd();
    if (!content) continue;

    const tokens = rawMeta.split(/\s+/).filter(Boolean);
    let filename = '';
    let lang = '';

    // Search for a filename token with extension (e.g. index.html, style.css)
    for (const t of tokens) {
      if (/^[\w\-./\\]+\.[a-zA-Z0-9]{1,8}$/.test(t)) {
        filename = sanitizeZipPath(t);
      } else if (!lang && /^[a-zA-Z0-9_-]+$/.test(t)) {
        lang = t.toLowerCase();
      }
    }

    if (!filename) {
      // Check first line of content for filename comment (e.g. // index.html, /* style.css */, <!-- index.html -->)
      const firstLine = content.split('\n')[0].trim();
      const commentMatch = firstLine.match(/^(?:\/\/|<!--|\/\*|#)\s*([\w\-./\\]+\.[a-zA-Z0-9]{1,8})/);
      if (commentMatch) {
        filename = sanitizeZipPath(commentMatch[1]);
      }
    }

    if (!filename) {
      // Infer filename from language or position
      const effLang = lang || 'html';
      if (effLang === 'html' && !files.some(f => f.name === 'index.html')) filename = 'index.html';
      else if (effLang === 'css' && !files.some(f => f.name === 'style.css')) filename = 'style.css';
      else if ((effLang === 'javascript' || effLang === 'js') && !files.some(f => f.name === 'script.js')) filename = 'script.js';
      else if (effLang === 'jsx' && !files.some(f => f.name === 'App.jsx')) filename = 'App.jsx';
      else if (effLang === 'python' && !files.some(f => f.name === 'main.py')) filename = 'main.py';
      else if (effLang === 'php' && !files.some(f => f.name === 'index.php')) filename = 'index.php';
      else if (effLang === 'json') filename = `data-${blockIdx + 1}.json`;
      else if (effLang === 'markdown' || effLang === 'md') filename = 'README.md';
      else filename = `file-${blockIdx + 1}.${effLang}`;
    }

    const finalLang = inferLanguage(filename);
    files.push({
      name: filename,
      path: filename,
      content,
      language: finalLang,
    });
    blockIdx++;
  }

  // Fallback if no fenced code block was found: treat full response as HTML or text
  if (!files.length && text) {
    const isHtml = text.includes('<html') || text.includes('<!DOCTYPE') || text.includes('<div') || text.includes('</');
    const name = isHtml ? 'index.html' : 'README.md';
    files.push({
      name,
      path: name,
      content: text,
      language: isHtml ? 'html' : 'markdown',
    });
  }

  return files;
}

/**
 * Determine project type from files
 */
function inferProjectType(files = []) {
  if (files.some(f => f.name.endsWith('.jsx') || f.name.endsWith('.tsx') || (f.content && f.content.includes('React.')))) return 'react';
  if (files.some(f => f.name.endsWith('.html') || f.name.endsWith('.htm'))) return 'html';
  if (files.some(f => f.name.endsWith('.py'))) return 'python';
  if (files.some(f => f.name.endsWith('.php'))) return 'php';
  if (files.some(f => f.name.endsWith('.json'))) return 'json';
  if (files.some(f => f.name.endsWith('.md'))) return 'markdown';
  return 'code';
}

function createArtifactsService({
  store,
  loadStore,
  saveStore,
  withStoreLock,
  generateProvider,
  resolveModel,
  providerKey,
  calculateArtifactTokenCost,
  reserveTokenSpend,
  commitTokenTransaction,
  refundTokenTransaction,
  addActivity,
  availableModels,
  HttpError,
  logger = console,
}) {
  function getFreshStore() {
    return typeof loadStore === 'function' ? loadStore() : store;
  }

  function ensureUserArtifacts(uid) {
    const s = getFreshStore();
    if (!s.artifacts) s.artifacts = {};
    if (!s.artifacts[uid]) s.artifacts[uid] = [];
    return s.artifacts[uid];
  }

  function listArtifacts(uid) {
    const list = ensureUserArtifacts(uid);
    return list
      .map(art => ({
        id: art.id,
        title: art.title,
        type: art.type || 'html',
        description: art.description || '',
        model: art.model || '',
        provider: art.provider || '',
        fileCount: Array.isArray(art.files) ? art.files.length : 0,
        files: (art.files || []).map(f => ({ name: f.name, path: f.path, language: f.language, size: (f.content || '').length })),
        versionCount: Array.isArray(art.versions) ? art.versions.length : 1,
        createdAt: art.createdAt,
        updatedAt: art.updatedAt,
      }))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  function getArtifact(uid, id) {
    const list = ensureUserArtifacts(uid);
    const art = list.find(a => a.id === id);
    if (!art) {
      throw new HttpError(404, 'artifact_not_found', 'Artifact not found.');
    }
    return art;
  }

  function createArtifact(uid, { title, type = 'html', description = '', files = [], model = '', provider = '', chatHistory } = {}) {
    const list = ensureUserArtifacts(uid);
    const id = `art_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const cleanTitle = String(title || 'New Artifact').trim().slice(0, 100);

    const defaultFiles = files.length ? files.map(f => ({
      name: sanitizeZipPath(f.name || f.path || 'index.html'),
      path: sanitizeZipPath(f.path || f.name || 'index.html'),
      content: String(f.content ?? ''),
      language: inferLanguage(f.name || f.path || 'html'),
    })) : [
      {
        name: 'index.html',
        path: 'index.html',
        content: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>New Artifact</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <div style="font-family:sans-serif;padding:40px;text-align:center">\n    <h1>Welcome to Photon AI Artifacts</h1>\n    <p>Edit this code or use AI to generate your deliverable.</p>\n  </div>\n  <script src="script.js"></script>\n</body>\n</html>',
        language: 'html',
      },
      {
        name: 'style.css',
        path: 'style.css',
        content: 'body {\n  margin: 0;\n  background: #0f1117;\n  color: #e5e7eb;\n}',
        language: 'css',
      },
      {
        name: 'script.js',
        path: 'script.js',
        content: '// JavaScript code\nconsole.log("Photon Artifact loaded");',
        language: 'javascript',
      },
    ];

    const nowIso = new Date().toISOString();
    const artifact = {
      id,
      uid,
      title: cleanTitle,
      type: type || inferProjectType(defaultFiles),
      description: String(description || '').trim().slice(0, 300),
      files: defaultFiles,
      activeFile: defaultFiles[0]?.name || 'index.html',
      model,
      provider,
      createdAt: nowIso,
      updatedAt: nowIso,
      chatHistory: Array.isArray(chatHistory) ? chatHistory : [
        {
          role: 'assistant',
          content: `Project **${cleanTitle}** ready. What would you like to build or modify?`,
          timestamp: nowIso
        }
      ],
      versions: [
        {
          version: 1,
          createdAt: nowIso,
          prompt: 'Initial creation',
          summary: 'Created initial project files',
          files: defaultFiles.map(f => ({ ...f })),
        },
      ],
    };

    list.unshift(artifact);
    saveStore();
    return artifact;
  }

  function updateArtifact(uid, id, updates = {}) {
    const list = ensureUserArtifacts(uid);
    const idx = list.findIndex(a => a.id === id);
    if (idx === -1) throw new HttpError(404, 'artifact_not_found', 'Artifact not found.');

    const current = list[idx];
    const nowIso = new Date().toISOString();

    if (updates.title) current.title = String(updates.title).trim().slice(0, 100);
    if (updates.description !== undefined) current.description = String(updates.description || '').trim().slice(0, 300);
    if (updates.activeFile) current.activeFile = sanitizeZipPath(updates.activeFile);

    if (Array.isArray(updates.files)) {
      current.files = updates.files.map(f => ({
        name: sanitizeZipPath(f.name || f.path),
        path: sanitizeZipPath(f.path || f.name),
        content: String(f.content ?? ''),
        language: inferLanguage(f.name || f.path),
      }));
      current.type = inferProjectType(current.files);
    }

    current.updatedAt = nowIso;

    // Append version if requested
    if (updates.createVersion) {
      if (!Array.isArray(current.versions)) current.versions = [];
      const nextVer = current.versions.length + 1;
      current.versions.push({
        version: nextVer,
        createdAt: nowIso,
        prompt: String(updates.versionPrompt || 'Manual edit'),
        summary: String(updates.versionSummary || 'Updated project code'),
        files: current.files.map(f => ({ ...f })),
      });
      // Cap at 20 versions
      if (current.versions.length > 20) current.versions.shift();
    }

    if (Array.isArray(updates.chatHistory)) {
      current.chatHistory = updates.chatHistory.slice(-50);
    }

    saveStore();
    return current;
  }

  function deleteArtifact(uid, id) {
    const list = ensureUserArtifacts(uid);
    const idx = list.findIndex(a => a.id === id);
    if (idx === -1) throw new HttpError(404, 'artifact_not_found', 'Artifact not found.');
    const removed = list.splice(idx, 1)[0];
    saveStore();
    return { success: true, id: removed.id };
  }

  function duplicateArtifact(uid, id) {
    const original = getArtifact(uid, id);
    const nowIso = new Date().toISOString();
    const cloneId = `art_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const cloneFiles = (original.files || []).map(f => ({ ...f }));

    const cloneTitle = `Copy of ${original.title}`.slice(0, 100);
    const clone = {
      ...original,
      id: cloneId,
      uid,
      title: cloneTitle,
      files: cloneFiles,
      createdAt: nowIso,
      updatedAt: nowIso,
      chatHistory: Array.isArray(original.chatHistory) ? JSON.parse(JSON.stringify(original.chatHistory)) : [
        {
          role: 'assistant',
          content: `Project **${cloneTitle}** ready. What would you like to build or modify?`,
          timestamp: nowIso
        }
      ],
      versions: [
        {
          version: 1,
          createdAt: nowIso,
          prompt: `Duplicated from ${original.title}`,
          summary: 'Cloned artifact',
          files: cloneFiles.map(f => ({ ...f })),
        },
      ],
    };

    const list = ensureUserArtifacts(uid);
    list.unshift(clone);
    saveStore();
    return clone;
  }

  function restoreVersion(uid, id, versionNumber) {
    const art = getArtifact(uid, id);
    const targetVer = (art.versions || []).find(v => v.version === Number(versionNumber));
    if (!targetVer) throw new HttpError(404, 'version_not_found', 'Specified version was not found.');

    const nowIso = new Date().toISOString();
    art.files = targetVer.files.map(f => ({ ...f }));
    art.type = inferProjectType(art.files);
    art.updatedAt = nowIso;

    art.versions.push({
      version: art.versions.length + 1,
      createdAt: nowIso,
      prompt: `Restored version ${versionNumber}`,
      summary: `Restored files from version ${versionNumber}`,
      files: art.files.map(f => ({ ...f })),
    });

    saveStore();
    return art;
  }

  // ---------------------------------------------------------------------------
  // AI GENERATION & AI EDITING WORKFLOWS WITH DYNAMIC TOKEN PRICING
  // ---------------------------------------------------------------------------

  async function generateArtifact({
    uid,
    prompt,
    type = 'html',
    modelId,
    attachments = [],
    profile,
    requestId,
  }) {
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt || cleanPrompt.length > 32000) {
      throw new HttpError(400, 'invalid_prompt', 'Enter a prompt up to 32,000 characters.');
    }

    const validAttachments = validateArtifactAttachments(attachments, HttpError);

    const settings = store.settings || {};
    const artifactPricing = settings.artifactPricing || {
      baseCost: 50,
      includedTokens: 1000,
      surchargePerBlock: 1,
      blockSize: 1000,
      enabled: true,
      aiEditingEnabled: true,
    };

    if (artifactPricing.enabled === false) {
      throw new HttpError(403, 'feature_disabled', 'Artifact generation is currently disabled by the administrator.');
    }

    const targetModelId = modelId || (profile && profile.defaultModel) || 'photon-fast';
    const option = await resolveModel(targetModelId);
    const pKey = providerKey(option);

    // Verify vision capability if attachments were provided
    if (validAttachments.length > 0 && !isVisionCapableModel(option)) {
      let suggestions = 'OpenAI GPT-4o Mini or Claude 3.5 Haiku';
      if (typeof availableModels === 'function') {
        try {
          const all = availableModels() || [];
          const visionModels = all.filter(m => isVisionCapableModel(m) && !m.creditsExhausted && m.available !== false && m.category !== 'image' && m.category !== 'video');
          if (visionModels.length > 0) suggestions = visionModels.slice(0, 3).map(m => m.name || m.id).join(', ');
        } catch {}
      }
      throw new HttpError(
        400,
        'vision_unsupported',
        `The selected model "${option.name || option.id}" is text-only and cannot process image attachments. Please switch to a vision-capable model (such as ${suggestions}).`
      );
    }

    // Token calculation (include image tokens estimate)
    const imageTokensEstimate = validAttachments.length * 1000;
    const estimatedInputTokens = Math.max(1, Math.ceil(cleanPrompt.length / 4) + imageTokensEstimate);
    const tokenCharge = calculateArtifactTokenCost(estimatedInputTokens, artifactPricing);

    // 1. Reserve tokens atomically
    const reserved = await withStoreLock(() => {
      const resTx = reserveTokenSpend(store, {
        uid,
        activityKey: 'code',
        requestId: requestId || `art_gen_${Date.now()}`,
        profile,
        provider: option.provider || 'OpenRouter',
        model: option.id,
        overrideCost: tokenCharge,
      });
      saveStore();
      return resTx;
    });

    let systemPrompt;
    if (validAttachments.length > 0) {
      systemPrompt = `You are an elite full-stack engineer and UI/UX designer generating production-quality deliverables for PHOTON AI Artifacts based on the attached visual reference/screenshot(s).
Deliver complete, fully functional, beautifully styled, bug-free project files.
RULES:
1. Carefully inspect the visual components, layout, typography, colors, and styling from the attached image(s).
2. Recreate or convert the visual design into complete, production-ready code.
3. Return every project file inside a fenced code block with its exact relative filename in the opening fence.
   Example:
   \`\`\`html index.html
   <!DOCTYPE html>
   ...
   \`\`\`
   \`\`\`css style.css
   ...
   \`\`\`
   \`\`\`javascript script.js
   ...
   \`\`\`
4. For Web apps (HTML/CSS/JS): Provide index.html, style.css, and script.js with modern aesthetics, clean CSS variables, responsive design, and interactivity.
5. For React components/apps: Return App.jsx and style.css.
6. Do NOT omit any code. Do NOT use placeholders like "// implement later". Write complete, runnable code.
7. Provide a brief 1-line project title on the very first line before any code blocks.`;
    } else {
      systemPrompt = `You are an elite full-stack engineer and UI/UX designer generating production-quality deliverables for PHOTON AI Artifacts.
Deliver complete, fully functional, beautifully styled, bug-free project files.
RULES:
1. Return every project file inside a fenced code block with its exact relative filename in the opening fence.
   Example:
   \`\`\`html index.html
   <!DOCTYPE html>
   ...
   \`\`\`
   \`\`\`css style.css
   ...
   \`\`\`
   \`\`\`javascript script.js
   ...
   \`\`\`
2. For Web apps (HTML/CSS/JS): Provide index.html, style.css, and script.js with modern aesthetics, clean CSS variables, responsive design, and interactivity.
3. For React components/apps: Return App.jsx and style.css.
4. Do NOT omit any code. Do NOT use placeholders like "// implement later". Write complete, runnable code.
5. Provide a brief 1-line project title on the very first line before any code blocks.`;
    }

    const userPromptText = validAttachments.length > 0
      ? `Create this artifact based on the attached visual reference(s) and prompt:\nPROMPT: ${cleanPrompt}\nREQUESTED TYPE: ${type}\nATTACHED IMAGES: ${validAttachments.map(a => a.name).join(', ')}`
      : `Create this artifact: ${cleanPrompt}\nRequested category/type: ${type}`;

    let aiResult;
    try {
      aiResult = await generateProvider({
        providerName: pKey,
        modelId: option.id,
        system: systemPrompt,
        text: userPromptText,
        attachments: validAttachments,
      });
    } catch (err) {
      console.warn(`[ArtifactsGen] Primary provider ${pKey} failed (${err.message}), falling back to Photon Fast AI...`);
      try {
        aiResult = await callPollinationsTextCode({
          system: systemPrompt,
          text: userPromptText,
          attachments: validAttachments,
        });
      } catch (fallbackErr) {
        refundTokenTransaction(store, reserved.transaction.id, err?.code || 'generation_failed');
        saveStore();
        throw err;
      }
    }

    const responseText = String(aiResult?.result?.text || aiResult?.text || '').trim();
    if (!responseText) {
      refundTokenTransaction(store, reserved.transaction.id, 'empty_response');
      saveStore();
      throw new HttpError(502, 'empty_response', 'The AI model returned an empty response. Please retry.');
    }

    // Extract title from first line if available
    const firstLine = responseText.split('\n')[0].replace(/^[#*\s]+/, '').trim();
    const title = (firstLine && !firstLine.startsWith('```') && firstLine.length < 80)
      ? firstLine
      : cleanPrompt.slice(0, 40).replace(/[^\w\s-]/g, '');

    const parsedFiles = parseFilesFromAiResponse(responseText, title);
    if (!parsedFiles.length) {
      refundTokenTransaction(store, reserved.transaction.id, 'parsing_error');
      saveStore();
      throw new HttpError(502, 'invalid_code', 'Could not parse project files from the AI response. Please retry.');
    }

    let finalCost = tokenCharge;
    if (aiResult.usage && Number.isInteger(aiResult.usage.inputTokens)) {
      finalCost = calculateArtifactTokenCost(
        aiResult.usage.inputTokens,
        artifactPricing,
        aiResult.usage.outputTokens || 0
      );
    }

    commitTokenTransaction(store, reserved.transaction.id, {
      provider: option.provider,
      model: option.id,
      actualTokensCharged: finalCost,
    });

    addActivity(uid, 'code', `Created artifact: ${title}`, finalCost, {
      provider: option.provider,
      model: option.id,
      activityKey: 'code',
    });

    const nowIso = new Date().toISOString();
    const historyAttachments = validAttachments.map(a => ({
      name: a.name,
      mimeType: a.mimeType,
      size: a.size,
      previewUrl: a.previewUrl,
    }));

    const artifact = createArtifact(uid, {
      title,
      type: inferProjectType(parsedFiles),
      description: cleanPrompt,
      files: parsedFiles,
      model: option.id,
      provider: option.provider,
      chatHistory: [
        {
          role: 'user',
          content: cleanPrompt,
          attachments: historyAttachments.length ? historyAttachments : undefined,
          timestamp: nowIso,
        },
        {
          role: 'assistant',
          content: `Project **${title}** created. What would you like to build or modify?`,
          timestamp: nowIso,
        }
      ],
    });

    return {
      artifact,
      tokensCharged: finalCost,
      model: option.id,
      provider: option.provider,
    };
  }

  async function editArtifact({
    uid,
    id,
    instruction,
    modelId,
    attachments = [],
    activeFile,
    profile,
    requestId,
  }) {
    const art = getArtifact(uid, id);
    const cleanInstruction = String(instruction || '').trim();
    if (!cleanInstruction) throw new HttpError(400, 'invalid_instruction', 'Please enter an editing instruction.');

    const validAttachments = validateArtifactAttachments(attachments, HttpError);

    const settings = store.settings || {};
    const artifactPricing = settings.artifactPricing || {
      baseCost: 50,
      includedTokens: 1000,
      surchargePerBlock: 1,
      blockSize: 1000,
      enabled: true,
      aiEditingEnabled: true,
    };

    if (artifactPricing.aiEditingEnabled === false) {
      throw new HttpError(403, 'feature_disabled', 'AI artifact editing is currently disabled by the administrator.');
    }

    const targetModelId = modelId || art.model || (profile && profile.defaultModel) || 'photon-fast';
    const option = await resolveModel(targetModelId);
    const pKey = providerKey(option);

    // Verify vision capability if attachments were provided
    if (validAttachments.length > 0 && !isVisionCapableModel(option)) {
      let suggestions = 'OpenAI GPT-4o Mini or Claude 3.5 Haiku';
      if (typeof availableModels === 'function') {
        try {
          const all = availableModels() || [];
          const visionModels = all.filter(m => isVisionCapableModel(m) && !m.creditsExhausted && m.available !== false && m.category !== 'image' && m.category !== 'video');
          if (visionModels.length > 0) suggestions = visionModels.slice(0, 3).map(m => m.name || m.id).join(', ');
        } catch {}
      }
      throw new HttpError(
        400,
        'vision_unsupported',
        `The selected model "${option.name || option.id}" is text-only and cannot process image attachments. Please switch to a vision-capable model (such as ${suggestions}).`
      );
    }

    const curActiveFile = activeFile || art.activeFile || (art.files && art.files[0] ? art.files[0].name : 'index.html');
    const fileStructure = (art.files || []).map(f => `${f.name} (${f.language || 'code'}, ${(f.content || '').length} chars)`).join(', ');

    const currentFilesSummary = (art.files || [])
      .map(f => {
        const isCur = f.name === curActiveFile ? ' [CURRENT ACTIVE FILE]' : '';
        return `--- FILE: ${f.name}${isCur} ---\n${f.content}`;
      })
      .join('\n\n');

    const imageTokensEstimate = validAttachments.length * 1000;
    const estimatedInputTokens = Math.max(1, Math.ceil((cleanInstruction.length + currentFilesSummary.length) / 4) + imageTokensEstimate);
    const tokenCharge = calculateArtifactTokenCost(estimatedInputTokens, artifactPricing);

    const reserved = await withStoreLock(() => {
      const resTx = reserveTokenSpend(store, {
        uid,
        activityKey: 'code',
        requestId: requestId || `art_edit_${Date.now()}`,
        profile,
        provider: option.provider || 'OpenRouter',
        model: option.id,
        overrideCost: tokenCharge,
      });
      saveStore();
      return resTx;
    });

    let systemPrompt;
    if (validAttachments.length > 0) {
      systemPrompt = `You are an elite full-stack engineer and UI/UX designer updating an existing project deliverable.
The user has provided reference screenshot(s)/image(s) along with editing instructions.
Targeted edit instruction from user: "${cleanInstruction}"

VISUAL RECREATION & CODE MODIFICATION RULES:
1. Carefully inspect the visual components, layout, typography, colors, spacing, components, and visual hierarchy in the attached screenshot/image.
2. Implement the visual changes requested by the user into the project code (HTML, CSS, JS, JSX).
3. Return ONLY the updated or newly created files inside fenced code blocks with the exact filename in the opening fence.
   Example:
   \`\`\`html index.html
   ...
   \`\`\`
   \`\`\`css style.css
   ...
   \`\`\`
4. Preserve all unrelated working logic, scripts, and structure. Do not break existing features.
5. On the very first line of your response, write a 1-sentence summary of what you changed.`;
    } else {
      systemPrompt = `You are an expert software engineer updating an existing project deliverable.
Targeted edit instruction from user: "${cleanInstruction}"
RULES:
1. Modify the existing files to fulfill the user's instruction precisely.
2. Return ONLY the updated or new files inside fenced code blocks with the exact filename in the opening fence.
3. Preserve all existing working code, structure, and files that do not need changes.
4. On the very first line of your response, write a 1-sentence summary of what you changed.`;
    }

    const userMessageText = `PROJECT: ${art.title} (Type: ${art.type || 'html'})
CURRENT ACTIVE FILE: ${curActiveFile}
FILE STRUCTURE: ${fileStructure}
${validAttachments.length > 0 ? `ATTACHED REFERENCE IMAGES: ${validAttachments.map(a => a.name).join(', ')}\n` : ''}
CURRENT PROJECT FILES:
${currentFilesSummary}

USER INSTRUCTION:
${cleanInstruction}`;

    let aiResult;
    try {
      aiResult = await generateProvider({
        providerName: pKey,
        modelId: option.id,
        system: systemPrompt,
        text: userMessageText,
        attachments: validAttachments,
      });
    } catch (err) {
      console.warn(`[ArtifactsEdit] Primary provider ${pKey} failed (${err.message}), seamlessly applying changes with Photon Fast AI...`);
      try {
        aiResult = await callPollinationsTextCode({
          system: systemPrompt,
          text: userMessageText,
          attachments: validAttachments,
        });
      } catch (fallbackErr) {
        refundTokenTransaction(store, reserved.transaction.id, err?.code || 'editing_failed');
        saveStore();
        throw err;
      }
    }

    const responseText = String(aiResult?.result?.text || aiResult?.text || '').trim();
    if (!responseText) {
      refundTokenTransaction(store, reserved.transaction.id, 'empty_response');
      saveStore();
      throw new HttpError(502, 'empty_response', 'The AI model returned an empty response. Please retry.');
    }

    const firstLine = responseText.split('\n')[0].replace(/^[#*\s]+/, '').trim();
    const summary = (firstLine && !firstLine.startsWith('```')) ? firstLine : 'Applied requested changes';

    const updatedFiles = parseFilesFromAiResponse(responseText, art.title);
    if (!updatedFiles.length) {
      refundTokenTransaction(store, reserved.transaction.id, 'parsing_error');
      saveStore();
      throw new HttpError(502, 'invalid_code', 'Could not parse updated code from the AI response. Please retry.');
    }

    // Merge updated files into existing files
    const fileMap = new Map();
    for (const f of art.files || []) {
      fileMap.set(f.name.toLowerCase(), { ...f });
    }
    for (const f of updatedFiles) {
      fileMap.set(f.name.toLowerCase(), f);
    }
    const mergedFiles = Array.from(fileMap.values());

    let finalCost = tokenCharge;
    if (aiResult.usage && Number.isInteger(aiResult.usage.inputTokens)) {
      finalCost = calculateArtifactTokenCost(
        aiResult.usage.inputTokens,
        artifactPricing,
        aiResult.usage.outputTokens || 0
      );
    }

    commitTokenTransaction(store, reserved.transaction.id, {
      provider: option.provider,
      model: option.id,
      actualTokensCharged: finalCost,
    });

    addActivity(uid, 'code', `Edited artifact: ${art.title} (${summary})`, finalCost, {
      provider: option.provider,
      model: option.id,
      activityKey: 'code',
    });

    const historyAttachments = validAttachments.map(a => ({
      name: a.name,
      mimeType: a.mimeType,
      size: a.size,
      previewUrl: a.previewUrl,
    }));

    const existingHistory = Array.isArray(art.chatHistory) ? art.chatHistory : [];
    const newChatHistory = [
      ...existingHistory,
      {
        role: 'user',
        content: cleanInstruction,
        attachments: historyAttachments.length ? historyAttachments : undefined,
        timestamp: new Date().toISOString()
      },
      {
        role: 'assistant',
        content: summary,
        summary: summary,
        modifiedFiles: updatedFiles.map(f => f.name),
        timestamp: new Date().toISOString(),
        version: (art.versions?.length || 0) + 1
      }
    ];

    art.model = option.id;
    art.provider = option.provider;

    const updatedArtifact = updateArtifact(uid, id, {
      files: mergedFiles,
      createVersion: true,
      versionPrompt: cleanInstruction,
      versionSummary: summary,
      chatHistory: newChatHistory,
    });

    return {
      artifact: updatedArtifact,
      summary,
      modifiedFiles: updatedFiles.map(f => f.name),
      tokensCharged: finalCost,
      model: option.id,
      provider: option.provider,
    };
  }

  function exportZip(uid, id) {
    const art = getArtifact(uid, id);
    const files = (art.files || []).map(f => ({
      path: sanitizeZipPath(f.path || f.name),
      content: f.content,
    }));
    const zipBuffer = createZipBuffer(files);
    const filename = `${(art.title || 'artifact').replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`;
    return { filename, zipBuffer };
  }

  return {
    listArtifacts,
    getArtifact,
    createArtifact,
    updateArtifact,
    deleteArtifact,
    duplicateArtifact,
    restoreVersion,
    generateArtifact,
    editArtifact,
    exportZip,
    getEligibleCopilotModels,
    isVisionCapableModel,
    validateArtifactAttachments,
    inferLanguage,
    parseFilesFromAiResponse,
    inferProjectType,
  };
}

module.exports = {
  createArtifactsService,
  getEligibleCopilotModels,
  isVisionCapableModel,
  validateArtifactAttachments,
  inferLanguage,
  parseFilesFromAiResponse,
  inferProjectType,
};
