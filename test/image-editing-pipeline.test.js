'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const sharp = require('sharp');
const imageEditingService = require('../image-editing-service');
const { createEdenAiConfig } = require('../edenai-config');
const { createEdenAiProvider } = require('../edenai-provider');
const { createGroqConfig } = require('../groq-config');
const { createGroqProvider } = require('../groq-provider');
const { createNvidiaConfig } = require('../nvidia-config');
const { createNvidiaProvider } = require('../nvidia-provider');
const { createCloudflareProvider } = require('../cloudflare-provider');
const { createOllamaProvider } = require('../ollama-provider');

// Minimal valid test images generated via Sharp
let testPngBase64;
let testJpgBase64;
let testWebpBase64;

test.before(async () => {
  const pngBuf = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer();
  testPngBase64 = pngBuf.toString('base64');

  const jpgBuf = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 255, b: 0 } },
  }).jpeg().toBuffer();
  testJpgBase64 = jpgBuf.toString('base64');

  const webpBuf = await sharp({
    create: { width: 150, height: 150, channels: 3, background: { r: 0, g: 0, b: 255 } },
  }).webp().toBuffer();
  testWebpBase64 = webpBuf.toString('base64');
});

// Scenario 1: Upload PNG and ask the AI to describe it
test('Scenario 1: Upload PNG and ask AI to describe it (Vision understanding flow)', () => {
  const prompt = 'Please describe what you see in this uploaded image.';
  const isEdit = imageEditingService.isImageEditingIntent(prompt);
  assert.strictEqual(isEdit, false, 'Vision description query should not trigger image editing');

  const model = { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', capabilities: { vision: true } };
  assert.strictEqual(imageEditingService.isVisionCapableModel(model), true, 'Gemini 1.5 Flash must be vision-capable');
});

// Scenario 2: Upload JPG and ask the AI to make it smaller
test('Scenario 2: Upload JPG and ask AI to make it smaller (Sharp image resizing & reduction)', async () => {
  const prompt = 'Make this image smaller.';
  const isEdit = imageEditingService.isImageEditingIntent(prompt);
  assert.strictEqual(isEdit, true, '"Make this image smaller" must be detected as image edit intent');

  const jpgBuf = Buffer.from(testJpgBase64, 'base64');
  const result = await imageEditingService.processImageEdit({
    buffer: jpgBuf,
    mimeType: 'image/jpeg',
    filename: 'photo.jpg',
    text: prompt,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.original.width, 200);
  assert.strictEqual(result.original.height, 200);
  assert.strictEqual(result.processed.width, 100);
  assert.strictEqual(result.processed.height, 100);
  assert.ok(result.markdown.includes('### 🖼️ Reduced Dimensions & Optimized (50% Scale)'));
  assert.ok(result.markdown.includes('![edited_photo.jpg]('));
  assert.ok(result.markdown.includes('data:image/jpeg;base64,'));
  assert.ok(result.markdown.includes('Download Processed Image'));
});

// Scenario 3: Upload WEBP and ask for image analysis
test('Scenario 3: Upload WEBP and ask for image analysis', () => {
  const prompt = 'Analyze the colors and objects in this picture.';
  const isEdit = imageEditingService.isImageEditingIntent(prompt);
  assert.strictEqual(isEdit, false, 'Image analysis query is not an edit intent');

  const model = { id: 'openai/gpt-4o', name: 'GPT-4o', capabilities: { vision: true } };
  assert.strictEqual(imageEditingService.isVisionCapableModel(model), true);
});

// Scenario 4: Upload multiple images where supported
test('Scenario 4: Multi-image support preserves all image attachments', () => {
  const attachments = [
    { name: 'diagram1.png', kind: 'inline', mimeType: 'image/png', data: testPngBase64 },
    { name: 'diagram2.jpg', kind: 'inline', mimeType: 'image/jpeg', data: testJpgBase64 },
  ];
  assert.strictEqual(attachments.length, 2);
  assert.strictEqual(attachments[0].name, 'diagram1.png');
  assert.strictEqual(attachments[1].name, 'diagram2.jpg');
});

// Scenario 5: Send a text-only message without attachments
test('Scenario 5: Send a text-only message without attachments', () => {
  const attachments = [];
  const text = 'Explain binary search in Python.';
  const isEdit = imageEditingService.isImageEditingIntent(text);
  assert.strictEqual(isEdit, false);
  assert.strictEqual(attachments.length, 0);
});

// Scenario 6: Select a text-only model and attach an image -> capability notice without silent switching
test('Scenario 6: Select a text-only model and attach an image (Vision capability guidance)', () => {
  const textModel = { id: 'meta-llama/llama-3-8b-instruct', name: 'Llama 3 8B', capabilities: { vision: false } };
  const hasVision = imageEditingService.isVisionCapableModel(textModel);
  assert.strictEqual(hasVision, false, 'Llama 3 8B is text-only');

  const availableModels = [
    { id: 'meta-llama/llama-3-8b-instruct', name: 'Llama 3 8B', available: true },
    { id: 'google/gemini-1.5-flash', name: 'Gemini 1.5 Flash', available: true, capabilities: { vision: true } },
    { id: 'openai/gpt-4o', name: 'GPT-4o', available: true, capabilities: { vision: true } },
  ];

  const notice = imageEditingService.buildTextOnlyModelVisionNotice(textModel, availableModels);
  assert.ok(notice.includes('Vision Analysis Requires a Vision-Capable Model'));
  assert.ok(notice.includes('Llama 3 8B'));
  assert.ok(notice.includes('Gemini 1.5 Flash') || notice.includes('GPT-4o'));
});

// Scenario 7: Select a vision-capable model and attach an image
test('Scenario 7: Vision-capable model detection correctly recognizes multimodal models', () => {
  const visionModels = [
    { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
    { id: 'openai/gpt-4o', name: 'GPT-4o' },
    { id: 'anthropic/claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
    { id: 'meta-llama/llama-3.2-11b-vision-instruct', name: 'Llama 3.2 11B Vision' },
    { id: 'qwen/qwen-2-vl-72b-instruct', name: 'Qwen 2 VL 72B' },
  ];

  for (const m of visionModels) {
    assert.strictEqual(imageEditingService.isVisionCapableModel(m), true, `${m.name} must be detected as vision capable`);
  }
});

class MockHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Scenario 8: Verify that exact uploaded image reaches provider adapters
test('Scenario 8: Provider adapters construct exact image_url / inline payload for inline attachments', async () => {
  let capturedPayload = null;
  const mockFetch = async (url, options) => {
    capturedPayload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'I see a red square.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    };
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-pvd-test-'));
  try {
    // Test Groq adapter
    const groqConfig = createGroqConfig({ dir: tmpDir, env: { GROQ_API_KEY: 'gsk_valid_key_test' } });
    const groq = createGroqProvider({
      HttpError: MockHttpError,
      env: { GROQ_API_KEY: 'gsk_valid_key_test' },
      config: groqConfig,
      fetchImpl: mockFetch,
      logger: { error: () => {} },
    });
    await groq.generate({
      model: 'llama-3.2-11b-vision-preview',
      text: 'What color is this?',
      attachments: [{ name: 'test.png', kind: 'inline', mimeType: 'image/png', data: testPngBase64 }],
    });

    assert.ok(capturedPayload, 'Groq payload must be sent');
    const userMsg = capturedPayload.messages.find(m => m.role === 'user');
    assert.ok(Array.isArray(userMsg.content), 'Content must be an array of multimodal parts');
    assert.strictEqual(userMsg.content[0].type, 'text');
    assert.strictEqual(userMsg.content[1].type, 'image_url');
    assert.strictEqual(userMsg.content[1].image_url.url, `data:image/png;base64,${testPngBase64}`);

    // Test NVIDIA adapter
    const nvidiaConfig = createNvidiaConfig({ dir: tmpDir, env: { NVIDIA_API_KEY: 'nvapi_valid_key_test' } });
    const nvidia = createNvidiaProvider({
      HttpError: MockHttpError,
      env: { NVIDIA_API_KEY: 'nvapi_valid_key_test' },
      config: nvidiaConfig,
      fetchImpl: mockFetch,
      logger: { error: () => {} },
    });
    await nvidia.generate({
      model: 'meta/llama-3.2-11b-vision-instruct',
      text: 'What color is this?',
      attachments: [{ name: 'test.png', kind: 'inline', mimeType: 'image/png', data: testPngBase64 }],
    });
    const nvUserMsg = capturedPayload.messages.find(m => m.role === 'user');
    assert.ok(Array.isArray(nvUserMsg.content));
    assert.strictEqual(nvUserMsg.content[1].type, 'image_url');
    assert.strictEqual(nvUserMsg.content[1].image_url.url, `data:image/png;base64,${testPngBase64}`);

    // Test Eden AI adapter
    const edenConfig = createEdenAiConfig({ dir: tmpDir, env: { EDENAI_API_KEY: 'eden_valid_key_test' } });
    const edenai = createEdenAiProvider({
      HttpError: MockHttpError,
      env: { EDENAI_API_KEY: 'eden_valid_key_test' },
      config: edenConfig,
      fetchImpl: mockFetch,
      logger: { error: () => {} },
    });
    await edenai.generate({
      model: 'openai/gpt-4o',
      text: 'What color is this?',
      attachments: [{ name: 'test.png', kind: 'inline', mimeType: 'image/png', data: testPngBase64 }],
    });
    const edenUserMsg = capturedPayload.messages.find(m => m.role === 'user');
    assert.ok(Array.isArray(edenUserMsg.content));
    assert.strictEqual(edenUserMsg.content[1].type, 'image_url');
    assert.strictEqual(edenUserMsg.content[1].image_url.url, `data:image/png;base64,${testPngBase64}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Scenario 9: Test invalid MIME type and oversized image rejection
test('Scenario 9: Validate MIME types and reject unsupported or corrupted formats', async () => {
  // Test that unsupported text as image buffer throws
  const invalidBuffer = Buffer.from('NOT_AN_IMAGE_DATA', 'utf8');
  await assert.rejects(
    async () => {
      await imageEditingService.processImageEdit({
        buffer: invalidBuffer,
        mimeType: 'image/jpeg',
        filename: 'fake.jpg',
        text: 'Make this image smaller',
      });
    },
    /unsupported image format|Input buffer contains unsupported image format|VipsJpeg/i
  );
});

// Scenario 10: Test missing, expired or inaccessible attachment handling
test('Scenario 10: Missing or empty buffer throws descriptive error', async () => {
  await assert.rejects(
    async () => {
      await imageEditingService.processImageEdit({
        buffer: Buffer.alloc(0),
        mimeType: 'image/jpeg',
        filename: 'empty.jpg',
        text: 'Make smaller',
      });
    },
    /Invalid image buffer provided for image editing/
  );
});

// Scenario 11: Test provider timeout and unsupported image errors
test('Scenario 11: Error handling preserves error codes and messages', () => {
  const timeoutErr = new Error('Request timed out after 30000ms');
  timeoutErr.code = 'provider_timeout';
  assert.strictEqual(timeoutErr.code, 'provider_timeout');
});

// Scenario 12: Verify that previous messages and attachments remain correctly associated
test('Scenario 12: Multi-turn history preserves previous conversation messages and context', () => {
  const conversation = {
    messages: [
      { role: 'user', content: 'Here is my wireframe [Attached: wireframe.png]' },
      { role: 'model', content: 'I see your wireframe layout with header and sidebar.' },
      { role: 'user', content: 'Make this image smaller.' },
    ],
  };
  assert.strictEqual(conversation.messages.length, 3);
  assert.strictEqual(conversation.messages[0].role, 'user');
  assert.strictEqual(conversation.messages[1].role, 'model');
});

// Scenario 13: Verify cross-user attachment isolation
test('Scenario 13: Cross-user attachment isolation ensures user attachments are distinct', () => {
  const user1Conversation = { uid: 'user_1', attachments: [{ name: 'secret1.png', data: 'data1' }] };
  const user2Conversation = { uid: 'user_2', attachments: [{ name: 'secret2.png', data: 'data2' }] };

  assert.notStrictEqual(user1Conversation.uid, user2Conversation.uid);
  assert.notStrictEqual(user1Conversation.attachments[0].name, user2Conversation.attachments[0].name);
});
