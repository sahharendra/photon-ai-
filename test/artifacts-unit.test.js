'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createZipBuffer, sanitizeZipPath, crc32 } = require('../artifact-zip');
const {
  calculateArtifactTokenCost,
  normalizeSettings,
  reserveTokenSpend,
  commitTokenTransaction,
  refundTokenTransaction,
} = require('../pricing-rules-service');
const {
  createArtifactsService,
  inferLanguage,
  parseFilesFromAiResponse,
  inferProjectType,
} = require('../artifacts-service');
const { createPollinationsProvider } = require('../pollinations-provider');

// -----------------------------------------------------------------------------
// 1. ZIP CREATION & PATH SANITIZATION TESTS
// -----------------------------------------------------------------------------

test('ZIP generator: sanitizeZipPath strips directory traversal and leading slashes', () => {
  assert.strictEqual(sanitizeZipPath('../../etc/passwd'), 'etc/passwd');
  assert.strictEqual(sanitizeZipPath('/absolute/path/file.txt'), 'absolute/path/file.txt');
  assert.strictEqual(sanitizeZipPath('nested\\folder\\file.js'), 'nested/folder/file.js');
  assert.strictEqual(sanitizeZipPath(''), 'file.txt');
  assert.strictEqual(sanitizeZipPath('....//....//hello.html'), 'hello.html');
});

test('ZIP generator: crc32 calculates correct checksum for known strings', () => {
  const buf = Buffer.from('123456789', 'utf8');
  assert.strictEqual(crc32(buf), 0xcbf43926);
});

test('ZIP generator: produces valid standard ZIP archive buffer with PKWARE magic bytes', () => {
  const files = [
    { path: 'index.html', content: '<!DOCTYPE html><html><body><h1>Hello</h1></body></html>' },
    { path: 'css/style.css', content: 'body { margin: 0; background: #000; }' },
    { path: 'js/main.js', content: 'console.log("Photon Artifact");' },
  ];
  const zip = createZipBuffer(files);
  assert.ok(Buffer.isBuffer(zip));
  assert.ok(zip.length > 100);
  // PKWARE magic bytes: 0x50 0x4B 0x03 0x04 ('PK\x03\x04')
  assert.strictEqual(zip[0], 0x50);
  assert.strictEqual(zip[1], 0x4b);
  assert.strictEqual(zip[2], 0x03);
  assert.strictEqual(zip[3], 0x04);
});

// -----------------------------------------------------------------------------
// 2. TOKEN PRICING & CALCULATION TESTS
// -----------------------------------------------------------------------------

test('Token pricing: calculateArtifactTokenCost enforces 50-token minimum and usage surcharge table', () => {
  const pricing = {
    baseCost: 50,
    includedTokens: 1000,
    surchargePerBlock: 1,
    blockSize: 1000,
    enabled: true,
  };

  // Exact specification test table:
  // 500 input tokens -> 50
  assert.strictEqual(calculateArtifactTokenCost(500, pricing), 50);
  // 1000 input tokens -> 50 (boundary of included base)
  assert.strictEqual(calculateArtifactTokenCost(1000, pricing), 50);
  // 1001 input tokens -> 51 (starts next block)
  assert.strictEqual(calculateArtifactTokenCost(1001, pricing), 51);
  // 2000 input tokens -> 51
  assert.strictEqual(calculateArtifactTokenCost(2000, pricing), 51);
  // 2001 input tokens -> 52
  assert.strictEqual(calculateArtifactTokenCost(2001, pricing), 52);
  // 3000 input tokens -> 52
  assert.strictEqual(calculateArtifactTokenCost(3000, pricing), 52);
  // 5000 input tokens -> 54
  assert.strictEqual(calculateArtifactTokenCost(5000, pricing), 54);
  // 10000 input tokens -> 59
  assert.strictEqual(calculateArtifactTokenCost(10000, pricing), 59);
});

test('Token pricing: reserveTokenSpend accepts overrideCost for dynamic charges', () => {
  const store = {
    settings: normalizeSettings(),
    tokenTransactions: [],
    activities: { user123: [] },
  };

  const res = reserveTokenSpend(store, {
    uid: 'user123',
    activityKey: 'code',
    requestId: 'req-001',
    profile: { plan: 'basic' },
    provider: 'Groq',
    model: 'llama-3.3-70b',
    overrideCost: 54, // Dynamic cost with usage surcharge
  });

  const tx = res.transaction;
  assert.strictEqual(tx.tokensCharged, 54);
  assert.strictEqual(tx.status, 'pending');

  commitTokenTransaction(store, tx.id, { actualTokensCharged: 54 });
  assert.strictEqual(tx.status, 'completed');
  assert.strictEqual(tx.tokensCharged, 54);
});

test('Token pricing: refundTokenTransaction refunds reserved tokens on failure', () => {
  const store = {
    settings: normalizeSettings(),
    tokenTransactions: [],
    activities: { user123: [] },
  };

  const res = reserveTokenSpend(store, {
    uid: 'user123',
    activityKey: 'code',
    requestId: 'req-002',
    profile: { plan: 'basic' },
    overrideCost: 50,
  });

  const tx = res.transaction;
  assert.strictEqual(tx.status, 'pending');
  refundTokenTransaction(store, tx.id, 'provider_error');
  assert.strictEqual(tx.status, 'refunded');
  assert.strictEqual(tx.refundReason, 'provider_error');
});

// -----------------------------------------------------------------------------
// 3. ARTIFACTS SERVICE CRUD & MULTI-FILE PARSING TESTS
// -----------------------------------------------------------------------------

test('Artifacts parser: inferLanguage and inferProjectType work accurately', () => {
  assert.strictEqual(inferLanguage('index.html'), 'html');
  assert.strictEqual(inferLanguage('style.css'), 'css');
  assert.strictEqual(inferLanguage('script.js'), 'javascript');
  assert.strictEqual(inferLanguage('App.jsx'), 'jsx');
  assert.strictEqual(inferLanguage('main.py'), 'python');
  assert.strictEqual(inferLanguage('data.json'), 'json');
  assert.strictEqual(inferLanguage('README.md'), 'markdown');

  assert.strictEqual(inferProjectType([{ name: 'index.html' }, { name: 'style.css' }]), 'html');
  assert.strictEqual(inferProjectType([{ name: 'App.jsx' }]), 'react');
  assert.strictEqual(inferProjectType([{ name: 'script.py' }]), 'python');
  assert.strictEqual(inferProjectType([{ name: 'doc.md' }]), 'markdown');
});

test('Artifacts parser: parseFilesFromAiResponse extracts multi-file code blocks from markdown fences', () => {
  const aiResponse = `
Here is your complete portfolio website:

\`\`\`html index.html
<!DOCTYPE html>
<html>
<head><link rel="stylesheet" href="style.css"></head>
<body><h1>My Portfolio</h1><script src="script.js"></script></body>
</html>
\`\`\`

\`\`\`css style.css
body { font-family: sans-serif; background: #111; color: #fff; }
\`\`\`

\`\`\`javascript script.js
console.log("Welcome to my portfolio!");
\`\`\`
`;

  const files = parseFilesFromAiResponse(aiResponse, 'Portfolio Project');
  assert.strictEqual(files.length, 3);
  assert.strictEqual(files[0].name, 'index.html');
  assert.strictEqual(files[0].language, 'html');
  assert.ok(files[0].content.includes('<h1>My Portfolio</h1>'));

  assert.strictEqual(files[1].name, 'style.css');
  assert.strictEqual(files[1].language, 'css');

  assert.strictEqual(files[2].name, 'script.js');
  assert.strictEqual(files[2].language, 'javascript');
});

test('Artifacts Service: CRUD operations and user ownership isolation', () => {
  const store = {
    artifacts: {},
    settings: normalizeSettings(),
    tokenTransactions: [],
    activities: {},
  };

  class HttpError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  const service = createArtifactsService({
    store,
    loadStore: () => store,
    saveStore: () => {},
    withStoreLock: fn => fn(),
    HttpError,
  });

  // User 1 creates an artifact
  const art1 = service.createArtifact('user_1', {
    title: 'Landing Page',
    type: 'html',
    files: [
      { name: 'index.html', content: '<h1>Home</h1>' },
      { name: 'style.css', content: 'h1 { color: red; }' },
    ],
  });

  assert.ok(art1.id);
  assert.strictEqual(art1.title, 'Landing Page');
  assert.strictEqual(art1.files.length, 2);

  // User 1 can list their artifact
  const list1 = service.listArtifacts('user_1');
  assert.strictEqual(list1.length, 1);
  assert.strictEqual(list1[0].id, art1.id);

  // User 2 sees 0 artifacts (isolation)
  const list2 = service.listArtifacts('user_2');
  assert.strictEqual(list2.length, 0);

  // User 2 cannot access user 1's artifact
  assert.throws(() => {
    service.getArtifact('user_2', art1.id);
  }, /not found/);

  // User 1 updates artifact
  const updated = service.updateArtifact('user_1', art1.id, {
    title: 'Updated Landing Page',
    files: [
      { name: 'index.html', content: '<h1>Updated</h1>' },
    ],
    createVersion: true,
    versionPrompt: 'Change heading',
  });

  assert.strictEqual(updated.title, 'Updated Landing Page');
  assert.strictEqual(updated.versions.length, 2);

  // User 1 restores version 1
  const restored = service.restoreVersion('user_1', art1.id, 1);
  assert.strictEqual(restored.files[0].content, '<h1>Home</h1>');

  // User 1 exports ZIP
  const { filename, zipBuffer } = service.exportZip('user_1', art1.id);
  assert.ok(filename.endsWith('.zip'));
  assert.ok(Buffer.isBuffer(zipBuffer));
  assert.strictEqual(zipBuffer[0], 0x50); // PK header

  // User 1 duplicates artifact
  const dup = service.duplicateArtifact('user_1', art1.id);
  assert.strictEqual(dup.title, 'Copy of Updated Landing Page');
  assert.notStrictEqual(dup.id, art1.id);

  // User 1 deletes artifact
  service.deleteArtifact('user_1', art1.id);
  assert.strictEqual(service.listArtifacts('user_1').length, 1); // only the copy remains
});

// -----------------------------------------------------------------------------
// 4. POLLINATIONS AI ROBUST BINARY DETECTION & RATE-LIMIT TESTS
// -----------------------------------------------------------------------------

test('Pollinations: recognizes valid JPEG binary even if HTTP 402 is returned', async () => {
  class HttpError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  // Create a fake JPEG buffer (SOI marker 0xFF 0xD8)
  const fakeJpeg = Buffer.alloc(5000);
  fakeJpeg[0] = 0xff;
  fakeJpeg[1] = 0xd8;
  fakeJpeg[2] = 0xff;
  fakeJpeg[3] = 0xe0;

  const mockFetch = async () => ({
    ok: false,
    status: 402,
    headers: { get: () => 'image/jpeg' },
    arrayBuffer: async () => fakeJpeg.buffer,
  });

  const pol = createPollinationsProvider({ HttpError, fetchImpl: mockFetch });
  const result = await pol.generateImage({ prompt: 'test' });
  assert.strictEqual(result.success, true);
  assert.ok(result.dataUrl.startsWith('data:image/jpeg;base64,'));
});

test('Pollinations: parses 45-second rate limit text and throws friendly error with remaining seconds', async () => {
  class HttpError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  const errJson = JSON.stringify({
    status: 402,
    success: false,
    error: {
      code: 'FREE_LIMIT',
      message: 'Free limit reached: 1 image every 45 seconds per IP. Retry after 35s',
    },
  });

  const mockFetch = async () => ({
    ok: false,
    status: 402,
    headers: { get: () => 'application/json' },
    arrayBuffer: async () => Uint8Array.from(Buffer.from(errJson, 'utf8')).buffer,
  });

  const pol = createPollinationsProvider({ HttpError, fetchImpl: mockFetch });
  await assert.rejects(
    async () => {
      await pol.generateImage({ prompt: 'test' });
    },
    err => {
      assert.strictEqual(err.status, 429);
      assert.strictEqual(err.code, 'rate_limit_exceeded');
      assert.ok(err.message.includes('1 image every 45 seconds per IP'));
      assert.ok(err.message.includes('35 seconds'));
      assert.ok(err.message.includes('enter.pollinations.ai'));
      return true;
    }
  );
});
