'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const {
  createArtifactsService,
  validateArtifactAttachments,
  isVisionCapableModel,
  getEligibleCopilotModels,
  parseFilesFromAiResponse,
} = require('../artifacts-service');
const {
  calculateArtifactTokenCost,
  normalizeSettings,
  reserveTokenSpend,
  commitTokenTransaction,
  refundTokenTransaction,
} = require('../pricing-rules-service');

// 1x1 transparent PNG base64 with genuine PNG magic bytes (0x89 0x50 0x4E 0x47)
const VALID_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// 1x1 JPEG base64 with genuine JPEG magic bytes (0xFF 0xD8)
const VALID_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

// Minimal 1x1 WEBP base64 with RIFF....WEBP magic bytes
const VALID_WEBP_BASE64 = 'UklGRjoAAABXRUJQVlA4IC4AAACyAgCdASoCAAEALmk0mk0iIiIiIgBoSygABc6WWgAA/vehgAAA';

function createMockHttpError(status, code, message) {
  const err = new Error(`${code}: ${message}`);
  err.status = status;
  err.code = code;
  return err;
}

test('Copilot Models: filters text/coding models strictly, excluding image and video generators', () => {
  const sampleModels = [
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', provider: 'Eden AI', category: 'text', text_output: true, image_input: true, available: true },
    { id: 'anthropic/claude-3-5-haiku', name: 'Claude 3.5 Haiku', provider: 'Eden AI', category: 'text', text_output: true, image_input: true, available: true },
    { id: 'qwen2.5-coder:3b', name: 'Qwen 2.5 Coder', provider: 'Ollama', category: 'text', text_output: true, image_input: false, available: true },
    { id: 'meta/llama-3.1-70b-instruct', name: 'Llama 3.1 70B', provider: 'Eden AI', category: 'text', text_output: true, image_input: false, available: true },
    // Image and video generation models that MUST be excluded from Copilot coding
    { id: 'flux', name: 'FLUX.1 Schnell', provider: 'Pollinations AI', category: 'image', text_output: false, image_output: true, available: true },
    { id: 'sana', name: 'Sana Ultra-Fast', provider: 'Pollinations AI', category: 'image', text_output: false, image_output: true, available: true },
    { id: 'turbo', name: 'SDXL Turbo', provider: 'Pollinations AI', category: 'image', text_output: false, image_output: true, available: true },
    { id: 'bytedance/dreamina-seedance-2-0-fast-260128', name: 'Seedance Video', provider: 'Eden AI', category: 'video', text_output: false, video_output: true, available: true },
    // Exhausted or unavailable models
    { id: 'exhausted-model', name: 'Exhausted Model', provider: 'Test', category: 'text', text_output: true, creditsExhausted: true, available: false },
  ];

  const eligible = getEligibleCopilotModels(sampleModels);

  // Must only contain the 4 valid text models
  assert.strictEqual(eligible.length, 4);
  assert.ok(!eligible.some(m => m.id === 'flux'), 'FLUX must be excluded');
  assert.ok(!eligible.some(m => m.id === 'sana'), 'Sana must be excluded');
  assert.ok(!eligible.some(m => m.id === 'turbo'), 'Turbo must be excluded');
  assert.ok(!eligible.some(m => m.id.includes('seedance')), 'Video model must be excluded');
  assert.ok(!eligible.some(m => m.id === 'exhausted-model'), 'Exhausted model must be excluded');

  // Must include text models with capability flags
  const gpt = eligible.find(m => m.id === 'openai/gpt-4o-mini');
  assert.ok(gpt);
  assert.strictEqual(gpt.hasVision, true);

  const qwen = eligible.find(m => m.id === 'qwen2.5-coder:3b');
  assert.ok(qwen);
  assert.strictEqual(qwen.hasVision, false);
});

test('Copilot Vision Detection: isVisionCapableModel correctly identifies vision vs text-only models', () => {
  // Vision capable models
  assert.strictEqual(isVisionCapableModel({ id: 'openai/gpt-4o-mini', image_input: true }), true);
  assert.strictEqual(isVisionCapableModel({ id: 'anthropic/claude-3-5-haiku', capabilities: { vision: true } }), true);
  assert.strictEqual(isVisionCapableModel({ id: 'google/gemini-2.0-flash-exp' }), true);
  assert.strictEqual(isVisionCapableModel({ id: 'meta-llama/llama-3.2-11b-vision-instruct' }), true);
  assert.strictEqual(isVisionCapableModel({ id: 'mistralai/pixtral-12b' }), true);
  assert.strictEqual(isVisionCapableModel({ id: 'custom-vl-model' }), true);

  // Non-vision text-only models
  assert.strictEqual(isVisionCapableModel({ id: 'qwen2.5-coder:3b', image_input: false }), false);
  assert.strictEqual(isVisionCapableModel({ id: 'meta/llama-3.1-70b-instruct' }), false);
  assert.strictEqual(isVisionCapableModel({ id: 'mistralai/mistral-7b-instruct' }), false);
});

test('Image Attachment Validation: accepts PNG, JPG, JPEG, and WEBP formats with size checks', () => {
  const validAttachments = [
    { name: 'mockup.png', mimeType: 'image/png', data: VALID_PNG_BASE64 },
    { name: 'photo.jpg', mimeType: 'image/jpeg', data: VALID_JPEG_BASE64 },
    { name: 'layout.webp', mimeType: 'image/webp', data: VALID_WEBP_BASE64 },
  ];

  const sanitized = validateArtifactAttachments(validAttachments, createMockHttpError);
  assert.strictEqual(sanitized.length, 3);
  assert.strictEqual(sanitized[0].name, 'mockup.png');
  assert.strictEqual(sanitized[0].mimeType, 'image/png');
  assert.ok(sanitized[0].size > 0);
  assert.ok(sanitized[0].previewUrl.startsWith('data:image/png;base64,'));
});

test('Image Attachment Validation: rejects invalid formats, corrupted data, and oversized files', () => {
  // 1. Invalid MIME type (e.g. svg, gif, pdf, exe)
  assert.throws(() => {
    validateArtifactAttachments([{ name: 'icon.svg', mimeType: 'image/svg+xml', data: 'PHN2Zz48L3N2Zz4=' }], createMockHttpError);
  }, /invalid_image_format/);

  // 2. Empty or invalid base64 data
  assert.throws(() => {
    validateArtifactAttachments([{ name: 'blank.png', mimeType: 'image/png', data: '' }], createMockHttpError);
  }, /invalid_image_data/);

  // 3. Fake image extension with text payload (magic byte verification)
  const fakeBase64 = Buffer.from('Plain text content that is not an image').toString('base64');
  assert.throws(() => {
    validateArtifactAttachments([{ name: 'fake.png', mimeType: 'image/png', data: fakeBase64 }], createMockHttpError);
  }, /invalid_image_format/);

  // 4. Exceeds max attachments (max 5)
  assert.throws(() => {
    validateArtifactAttachments([
      { name: '1.png', mimeType: 'image/png', data: VALID_PNG_BASE64 },
      { name: '2.png', mimeType: 'image/png', data: VALID_PNG_BASE64 },
      { name: '3.png', mimeType: 'image/png', data: VALID_PNG_BASE64 },
      { name: '4.png', mimeType: 'image/png', data: VALID_PNG_BASE64 },
      { name: '5.png', mimeType: 'image/png', data: VALID_PNG_BASE64 },
      { name: '6.png', mimeType: 'image/png', data: VALID_PNG_BASE64 },
    ], createMockHttpError);
  }, /invalid_attachments/);
});

test('Vision Model Routing: rejects image attachments when text-only model is selected with vision suggestions', async () => {
  const store = {
    settings: normalizeSettings(),
    tokenTransactions: [],
    activities: { u1: [] },
    artifacts: {
      u1: [{
        id: 'art_123',
        uid: 'u1',
        title: 'Dashboard App',
        files: [{ name: 'index.html', path: 'index.html', content: '<h1>Dashboard</h1>', language: 'html' }],
        model: 'qwen2.5-coder:3b', // text-only model
        versions: [{ version: 1, files: [] }],
        chatHistory: [],
      }]
    }
  };

  const service = createArtifactsService({
    store,
    loadStore: () => store,
    saveStore: () => {},
    withStoreLock: fn => fn(),
    generateProvider: async () => {},
    resolveModel: async id => ({ id, name: 'Qwen 2.5 Coder', provider: 'Ollama', image_input: false }),
    providerKey: () => 'ollama',
    calculateArtifactTokenCost: () => 50,
    reserveTokenSpend: () => ({ transaction: { id: 'tx-1' } }),
    commitTokenTransaction: () => {},
    refundTokenTransaction: () => {},
    addActivity: () => {},
    availableModels: () => [
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', image_input: true, available: true, category: 'text' },
      { id: 'anthropic/claude-3-5-haiku', name: 'Claude 3.5 Haiku', image_input: true, available: true, category: 'text' }
    ],
    HttpError: createMockHttpError,
  });

  // Attempt to edit artifact with screenshot using text-only model
  await assert.rejects(async () => {
    await service.editArtifact({
      uid: 'u1',
      id: 'art_123',
      instruction: 'Make this website look like the attached screenshot',
      modelId: 'qwen2.5-coder:3b',
      attachments: [{ name: 'screenshot.png', mimeType: 'image/png', data: VALID_PNG_BASE64 }],
    });
  }, err => {
    assert.strictEqual(err.code, 'vision_unsupported');
    assert.ok(err.message.includes('text-only'));
    assert.ok(err.message.includes('GPT-4o Mini') || err.message.includes('Claude 3.5 Haiku'));
    return true;
  });
});

test('Image-Based Code Editing: vision model receives screenshot and generates updated code', async () => {
  let passedToProvider = null;

  const store = {
    settings: normalizeSettings(),
    tokenTransactions: [],
    activities: { u1: [] },
    artifacts: {
      u1: [{
        id: 'art_456',
        uid: 'u1',
        title: 'Landing Page',
        files: [
          { name: 'index.html', path: 'index.html', content: '<div>Original Header</div>', language: 'html' },
          { name: 'style.css', path: 'style.css', content: 'body { color: black; }', language: 'css' },
          { name: 'script.js', path: 'script.js', content: 'console.log("active");', language: 'javascript' }
        ],
        model: 'openai/gpt-4o-mini',
        versions: [{ version: 1, files: [] }],
        chatHistory: [],
      }]
    }
  };

  const service = createArtifactsService({
    store,
    loadStore: () => store,
    saveStore: () => {},
    withStoreLock: fn => fn(),
    generateProvider: async args => {
      passedToProvider = args;
      return {
        result: {
          text: `Updated header and styling according to reference screenshot\n\`\`\`html index.html\n<header class="hero"><h1>New Design from Screenshot</h1></header>\n\`\`\`\n\`\`\`css style.css\n.hero { background: #6366f1; color: white; padding: 40px; }\n\`\`\``
        },
        usage: { inputTokens: 1200, outputTokens: 350 },
      };
    },
    resolveModel: async id => ({ id, name: 'GPT-4o Mini', provider: 'Eden AI', image_input: true }),
    providerKey: () => 'edenai',
    calculateArtifactTokenCost: () => 51,
    reserveTokenSpend: () => ({ transaction: { id: 'tx-2' } }),
    commitTokenTransaction: () => {},
    refundTokenTransaction: () => {},
    addActivity: () => {},
    availableModels: () => [],
    HttpError: createMockHttpError,
  });

  const result = await service.editArtifact({
    uid: 'u1',
    id: 'art_456',
    instruction: 'Convert this screenshot design into HTML and CSS',
    modelId: 'openai/gpt-4o-mini',
    attachments: [{ name: 'ui-mockup.png', mimeType: 'image/png', data: VALID_PNG_BASE64 }],
    activeFile: 'index.html',
  });

  // 1. Verify attachments were forwarded to provider
  assert.ok(passedToProvider);
  assert.strictEqual(passedToProvider.attachments.length, 1);
  assert.strictEqual(passedToProvider.attachments[0].name, 'ui-mockup.png');
  assert.strictEqual(passedToProvider.attachments[0].mimeType, 'image/png');

  // 2. Verify visual rules in system prompt
  assert.ok(passedToProvider.system.includes('VISUAL RECREATION & CODE MODIFICATION RULES'));
  assert.ok(passedToProvider.text.includes('ATTACHED REFERENCE IMAGES: ui-mockup.png'));
  assert.ok(passedToProvider.text.includes('[CURRENT ACTIVE FILE]'));

  // 3. Verify modified files were merged into artifact
  assert.ok(result.artifact);
  const updatedHtml = result.artifact.files.find(f => f.name === 'index.html');
  const updatedCss = result.artifact.files.find(f => f.name === 'style.css');
  const preservedJs = result.artifact.files.find(f => f.name === 'script.js');

  assert.ok(updatedHtml.content.includes('New Design from Screenshot'));
  assert.ok(updatedCss.content.includes('.hero { background: #6366f1;'));
  // Unrelated code preserved:
  assert.strictEqual(preservedJs.content, 'console.log("active");');

  // 4. Verify chatHistory contains the user prompt and attachment preview
  const lastUserMsg = result.artifact.chatHistory.find(m => m.role === 'user');
  assert.ok(lastUserMsg);
  assert.ok(lastUserMsg.attachments);
  assert.strictEqual(lastUserMsg.attachments[0].name, 'ui-mockup.png');

  // 5. Verify model preference saved
  assert.strictEqual(result.artifact.model, 'openai/gpt-4o-mini');
});

test('Token Accounting: atomic reservation, usage deduction, and failure refunds', async () => {
  let reservedCount = 0;
  let committedCount = 0;
  let refundedCount = 0;

  const store = {
    settings: normalizeSettings(),
    tokenTransactions: [],
    activities: { u1: [] },
    artifacts: {
      u1: [{
        id: 'art_tok',
        uid: 'u1',
        title: 'Token Test',
        files: [{ name: 'index.html', path: 'index.html', content: 'test', language: 'html' }],
        model: 'openai/gpt-4o-mini',
        versions: [{ version: 1, files: [] }],
        chatHistory: [],
      }]
    }
  };

  const service = createArtifactsService({
    store,
    loadStore: () => store,
    saveStore: () => {},
    withStoreLock: fn => fn(),
    generateProvider: async () => {
      // Empty response from AI model triggers immediate refund without external network fallback
      return { result: { text: '' } };
    },
    resolveModel: async id => ({ id, name: 'GPT-4o Mini', provider: 'Eden AI', image_input: true }),
    providerKey: () => 'edenai',
    calculateArtifactTokenCost: () => 52,
    reserveTokenSpend: () => {
      reservedCount++;
      return { transaction: { id: 'tx-fail-1' } };
    },
    commitTokenTransaction: () => { committedCount++; },
    refundTokenTransaction: () => { refundedCount++; },
    addActivity: () => {},
    availableModels: () => [],
    HttpError: createMockHttpError,
  });

  // Generation failure must trigger atomic refund
  await assert.rejects(async () => {
    await service.editArtifact({
      uid: 'u1',
      id: 'art_tok',
      instruction: 'Add animation',
      modelId: 'openai/gpt-4o-mini',
    });
  });

  assert.strictEqual(reservedCount, 1, 'Tokens must be reserved before calling AI');
  assert.strictEqual(committedCount, 0, 'Committed tokens must be 0 on failure');
  assert.strictEqual(refundedCount, 1, 'Tokens must be refunded atomically when AI fails');
});

test('Security & User Ownership: prevents unauthorized access to another user artifacts', () => {
  const store = {
    settings: normalizeSettings(),
    tokenTransactions: [],
    activities: {},
    artifacts: {
      victim_user: [{
        id: 'art_secret_99',
        uid: 'victim_user',
        title: 'Confidential Internal App',
        files: [{ name: 'secret.js', path: 'secret.js', content: 'const API_KEY="secret";' }],
      }]
    }
  };

  const service = createArtifactsService({
    store,
    loadStore: () => store,
    saveStore: () => {},
    withStoreLock: fn => fn(),
    generateProvider: async () => {},
    resolveModel: async () => {},
    providerKey: () => 'test',
    calculateArtifactTokenCost: () => 50,
    reserveTokenSpend: () => ({ transaction: { id: 'tx' } }),
    commitTokenTransaction: () => {},
    refundTokenTransaction: () => {},
    addActivity: () => {},
    HttpError: createMockHttpError,
  });

  // Attacker attempting to read or edit victim_user's artifact
  assert.throws(() => {
    service.getArtifact('attacker_user', 'art_secret_99');
  }, /artifact_not_found/);

  assert.throws(() => {
    service.deleteArtifact('attacker_user', 'art_secret_99');
  }, /artifact_not_found/);

  // Listing artifacts for attacker returns empty list
  const attackerArtifacts = service.listArtifacts('attacker_user');
  assert.strictEqual(attackerArtifacts.length, 0);
});

test('HTTP Integration: GET /api/artifacts/models returns eligible models with vision capability', async () => {
  const res = await fetch('http://127.0.0.1:3000/api/artifacts/models');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.success, true);
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.length > 0);

  // Strictly exclude image and video generation models
  assert.ok(!body.data.some(m => m.id === 'flux' || m.id === 'sana' || m.id === 'turbo'));
  assert.ok(!body.data.some(m => m.category === 'image' || m.category === 'video'));

  // Ensure vision capability flags are present
  const visionModel = body.data.find(m => m.hasVision === true);
  const textOnlyModel = body.data.find(m => m.hasVision === false);
  assert.ok(visionModel, 'Must contain at least one vision-capable model');
  assert.ok(textOnlyModel, 'Must contain at least one text-only model');
});
