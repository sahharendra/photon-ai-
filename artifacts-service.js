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

  function createArtifact(uid, { title, type = 'html', description = '', files = [], model = '', provider = '' } = {}) {
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

    const clone = {
      ...original,
      id: cloneId,
      uid,
      title: `Copy of ${original.title}`.slice(0, 100),
      files: cloneFiles,
      createdAt: nowIso,
      updatedAt: nowIso,
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
    profile,
    requestId,
  }) {
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt || cleanPrompt.length > 32000) {
      throw new HttpError(400, 'invalid_prompt', 'Enter a prompt up to 32,000 characters.');
    }

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

    // Token calculation:
    // Estimate input tokens (rule of thumb: ~4 chars per token, minimum input length)
    const estimatedInputTokens = Math.max(1, Math.ceil(cleanPrompt.length / 4));
    const tokenCharge = calculateArtifactTokenCost(estimatedInputTokens, artifactPricing);

    // 1. Reserve tokens atomically
    const reserved = await withStoreLock(() => {
      const resTx = reserveTokenSpend(store, {
        uid,
        activityKey: 'code',
        requestId: requestId || `art_gen_${Date.now()}`,
        profile,
        provider: 'AI Provider',
        model: modelId || 'gemini-2.0-flash',
        overrideCost: tokenCharge,
      });
      saveStore();
      return resTx;
    });

    const option = await resolveModel(modelId || 'gemini-2.0-flash');
    const pKey = providerKey(option);

    const systemPrompt = `You are an elite full-stack engineer and UI/UX designer generating production-quality deliverables for PHOTON AI Artifacts.
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

    let aiResult;
    try {
      aiResult = await generateProvider({
        providerName: pKey,
        modelId: option.id,
        system: systemPrompt,
        text: `Create this artifact: ${cleanPrompt}\nRequested category/type: ${type}`,
      });
    } catch (err) {
      // Refund reserved tokens on generation failure
      refundTokenTransaction(store, reserved.transaction.id, err?.code || 'generation_failed');
      saveStore();
      throw err;
    }

    const responseText = String(aiResult?.text || '').trim();
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

    // Reconcile actual token cost using returned usage if available
    let finalCost = tokenCharge;
    if (aiResult.usage && Number.isInteger(aiResult.usage.inputTokens)) {
      finalCost = calculateArtifactTokenCost(
        aiResult.usage.inputTokens,
        artifactPricing,
        aiResult.usage.outputTokens || 0
      );
    }

    // Commit token transaction
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

    // Create and save artifact
    const artifact = createArtifact(uid, {
      title,
      type: inferProjectType(parsedFiles),
      description: cleanPrompt,
      files: parsedFiles,
      model: option.id,
      provider: option.provider,
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
    profile,
    requestId,
  }) {
    const art = getArtifact(uid, id);
    const cleanInstruction = String(instruction || '').trim();
    if (!cleanInstruction) throw new HttpError(400, 'invalid_instruction', 'Please enter an editing instruction.');

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

    const currentFilesSummary = (art.files || [])
      .map(f => `--- FILE: ${f.name} ---\n${f.content}`)
      .join('\n\n');

    const estimatedInputTokens = Math.max(1, Math.ceil((cleanInstruction.length + currentFilesSummary.length) / 4));
    const tokenCharge = calculateArtifactTokenCost(estimatedInputTokens, artifactPricing);

    const reserved = await withStoreLock(() => {
      const resTx = reserveTokenSpend(store, {
        uid,
        activityKey: 'code',
        requestId: requestId || `art_edit_${Date.now()}`,
        profile,
        provider: 'AI Provider',
        model: modelId || art.model || 'gemini-2.0-flash',
        overrideCost: tokenCharge,
      });
      saveStore();
      return resTx;
    });

    const option = await resolveModel(modelId || art.model || 'gemini-2.0-flash');
    const pKey = providerKey(option);

    const systemPrompt = `You are an expert software engineer updating an existing project deliverable.
Targeted edit instruction from user: "${cleanInstruction}"
RULES:
1. Modify the existing files to fulfill the user's instruction precisely.
2. Return ONLY the updated or new files inside fenced code blocks with the exact filename in the opening fence.
3. Preserve all existing working code, structure, and files that do not need changes.
4. On the very first line of your response, write a 1-sentence summary of what you changed.`;

    let aiResult;
    try {
      aiResult = await generateProvider({
        providerName: pKey,
        modelId: option.id,
        system: systemPrompt,
        text: `CURRENT PROJECT FILES:\n${currentFilesSummary}\n\nUSER INSTRUCTION:\n${cleanInstruction}`,
      });
    } catch (err) {
      refundTokenTransaction(store, reserved.transaction.id, err?.code || 'editing_failed');
      saveStore();
      throw err;
    }

    const responseText = String(aiResult?.text || '').trim();
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

    const updatedArtifact = updateArtifact(uid, id, {
      files: mergedFiles,
      createVersion: true,
      versionPrompt: cleanInstruction,
      versionSummary: summary,
    });

    return {
      artifact: updatedArtifact,
      summary,
      modifiedFiles: updatedFiles.map(f => f.name),
      tokensCharged: finalCost,
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
    inferLanguage,
    parseFilesFromAiResponse,
    inferProjectType,
  };
}

module.exports = {
  createArtifactsService,
  inferLanguage,
  parseFilesFromAiResponse,
  inferProjectType,
};
