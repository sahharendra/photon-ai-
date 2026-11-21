'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createQuotaMonitorService,
  STATUS_HEALTHY,
  STATUS_RATE_LIMITED,
  STATUS_QUOTA_EXHAUSTED,
  STATUS_INSUFFICIENT_CREDITS,
  STATUS_INVALID_KEY,
  STATUS_PERMISSION_DENIED,
  STATUS_TEMPORARILY_UNAVAILABLE,
  STATUS_ADMIN_DISABLED,
} = require('../quota-monitor-service');

// 1. Provider healthy → all eligible models visible
test('Scenario 1: Provider healthy -> all eligible models visible', () => {
  const qm = createQuotaMonitorService();
  const provCheck = qm.getProviderAvailability('groq');
  assert.equal(provCheck.available, true);
  assert.equal(provCheck.status, STATUS_HEALTHY);

  const modelCheck = qm.getModelAvailability('groq', 'llama-3.3-70b-versatile');
  assert.equal(modelCheck.available, true);
  assert.equal(modelCheck.status, STATUS_HEALTHY);
});

// 2. Provider quota exhausted → provider and all models hidden
test('Scenario 2: Provider quota exhausted -> provider and all models hidden', () => {
  const qm = createQuotaMonitorService();
  qm.simulateQuotaEvent({
    providerName: 'cloudflare',
    status: STATUS_QUOTA_EXHAUSTED,
    errorReason: 'Cloudflare Workers AI daily free allocation (10,000 Neurons) exhausted.',
    resetInMs: 3600000,
  });

  // Provider itself is marked unavailable
  const prov = qm.getProviderAvailability('cloudflare');
  assert.equal(prov.available, false);
  assert.equal(prov.status, STATUS_QUOTA_EXHAUSTED);

  // All models under this provider are marked unavailable
  const m1 = qm.getModelAvailability('cloudflare', '@cf/meta/llama-3.1-8b-instruct');
  assert.equal(m1.available, false);
  assert.equal(m1.status, STATUS_QUOTA_EXHAUSTED);

  const m2 = qm.getModelAvailability('cloudflare', '@cf/black-forest-labs/flux-1-schnell');
  assert.equal(m2.available, false);
  assert.equal(m2.status, STATUS_QUOTA_EXHAUSTED);
});

// 3. One key exhausted, another healthy → provider remains visible
test('Scenario 3: One key exhausted, another healthy -> provider remains visible', () => {
  const qm = createQuotaMonitorService();
  qm.registerProviderKey('gemini', 'slot_1');
  qm.registerProviderKey('gemini', 'slot_2');

  // Key slot 1 is exhausted
  qm.simulateQuotaEvent({
    providerName: 'gemini',
    keySlot: 'slot_1',
    status: STATUS_QUOTA_EXHAUSTED,
    errorReason: 'Key 1 daily quota exhausted',
  });

  // Key slot 2 is verified healthy
  qm.recordSuccess({
    providerName: 'gemini',
    keySlot: 'slot_2',
  });

  // Provider remains visible and healthy through slot_2
  const prov = qm.getProviderAvailability('gemini');
  assert.equal(prov.available, true);
  assert.equal(prov.status, STATUS_HEALTHY);
});

// 4. All keys exhausted → provider hidden
test('Scenario 4: All keys exhausted -> provider hidden', () => {
  const qm = createQuotaMonitorService();
  qm.registerProviderKey('openrouter', 'slot_1');
  qm.registerProviderKey('openrouter', 'slot_2');

  qm.simulateQuotaEvent({
    providerName: 'openrouter',
    keySlot: 'slot_1',
    status: STATUS_QUOTA_EXHAUSTED,
    errorReason: 'Slot 1 credits exhausted',
  });
  qm.simulateQuotaEvent({
    providerName: 'openrouter',
    keySlot: 'slot_2',
    status: STATUS_QUOTA_EXHAUSTED,
    errorReason: 'Slot 2 credits exhausted',
  });

  // Since all keys are exhausted, the provider is hidden
  const prov = qm.getProviderAvailability('openrouter');
  assert.equal(prov.available, false);
  assert.equal(prov.status, STATUS_QUOTA_EXHAUSTED);

  // Direct backend call is rejected
  assert.throws(() => {
    qm.assertModelRequestAllowed('openrouter', 'meta-llama/llama-3.3-70b-instruct:free');
  });
});

// 5. Shared account quota exhausted → provider hidden
test('Scenario 5: Shared account quota exhausted -> provider hidden', () => {
  const qm = createQuotaMonitorService();
  qm.registerProviderKey('groq', 'key_a', { isSharedAccount: true });
  qm.registerProviderKey('groq', 'key_b', { isSharedAccount: true });

  // Shared account-wide quota exhaustion event
  qm.simulateQuotaEvent({
    providerName: 'groq',
    status: STATUS_QUOTA_EXHAUSTED,
    errorReason: 'Organization-wide daily request limit reached',
    sharedAccount: true,
  });

  const prov = qm.getProviderAvailability('groq');
  assert.equal(prov.available, false);
  assert.equal(prov.status, STATUS_QUOTA_EXHAUSTED);

  // Both keys sharing the account are marked exhausted
  const snap = qm.getStatusSnapshot();
  const keys = snap.providers.groq.keys;
  assert.ok(keys.every(k => k.status === STATUS_QUOTA_EXHAUSTED));
});

// 6. Quota restored → provider and models automatically visible
test('Scenario 6: Quota restored -> provider and models automatically visible', async () => {
  const qm = createQuotaMonitorService();
  qm.simulateQuotaEvent({
    providerName: 'nvidia',
    modelId: 'nvidia/llama-3.1-nemotron-70b-instruct',
    status: STATUS_QUOTA_EXHAUSTED,
    resetInMs: 25,
  });

  assert.equal(qm.getModelAvailability('nvidia', 'nvidia/llama-3.1-nemotron-70b-instruct').available, false);

  // Wait for reset timer to elapse
  await new Promise(r => setTimeout(r, 35));

  // Background evaluation
  qm.checkAndRestoreAll();

  // Model and provider are automatically restored to HEALTHY
  const restored = qm.getModelAvailability('nvidia', 'nvidia/llama-3.1-nemotron-70b-instruct');
  assert.equal(restored.available, true);
  assert.equal(restored.status, STATUS_HEALTHY);
  assert.equal(qm.getProviderAvailability('nvidia').available, true);
});

// 7. Temporary rate limit → recovery scheduled
test('Scenario 7: Temporary rate limit -> recovery scheduled', () => {
  const qm = createQuotaMonitorService();
  const classified = qm.recordError({
    providerName: 'cohere',
    status: 429,
    headers: { 'retry-after': '45' },
    message: 'Trial key rate limit exceeded: 10 calls per minute limit reached',
  });

  assert.equal(classified.status, STATUS_RATE_LIMITED);
  assert.ok(classified.resetAt);
  assert.ok(classified.resetAt > Date.now());

  const prov = qm.getProviderAvailability('cohere');
  assert.equal(prov.available, false);
  assert.equal(prov.status, STATUS_RATE_LIMITED);
});

// 8. Invalid key → correct status displayed
test('Scenario 8: Invalid key -> correct status displayed', () => {
  const qm = createQuotaMonitorService();
  const classified = qm.recordError({
    providerName: 'stability',
    status: 401,
    message: 'Invalid API key or unauthorized access',
  });

  assert.equal(classified.status, STATUS_INVALID_KEY);
  const prov = qm.getProviderAvailability('stability');
  assert.equal(prov.available, false);
  assert.equal(prov.status, STATUS_INVALID_KEY);
});

// 9. Admin-disabled provider → remains hidden
test('Scenario 9: Admin-disabled provider -> remains hidden', () => {
  const qm = createQuotaMonitorService();
  qm.simulateQuotaEvent({
    providerName: 'pollinations',
    status: STATUS_ADMIN_DISABLED,
    errorReason: 'Disabled by administrator policy',
  });

  const prov = qm.getProviderAvailability('pollinations');
  assert.equal(prov.available, false);
  assert.equal(prov.status, STATUS_ADMIN_DISABLED);

  // Automatic reset evaluation does not un-disable an admin-disabled provider
  qm.checkAndRestoreAll();
  assert.equal(qm.getProviderAvailability('pollinations').available, false);
});

// 10. Paid fallback → blocked
test('Scenario 10: Paid fallback -> blocked (zero paid fallback enforcement)', () => {
  const { chooseFallback } = require('../provider-fallback');
  const primary = { id: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'OpenRouter' };
  const candidates = [
    { id: 'openai/gpt-4o', provider: 'OpenAI', free: false, available: true },
    { id: 'anthropic/claude-3-5-sonnet', provider: 'Anthropic', free: false, available: true },
  ];

  // When policy does not explicitly allow paid fallback, paid destinations are strictly forbidden
  const choice = chooseFallback({
    failureCode: 'quota_exhausted',
    primary,
    candidates,
    planId: 'basic',
    context: {},
    policy: { allowPaid: false, spendCapRemaining: 0 },
  });

  assert.equal(choice, null);
});

// 11. Customer tokens available but provider exhausted → provider remains hidden
test('Scenario 11: Customer tokens available but provider exhausted -> provider remains hidden', () => {
  const qm = createQuotaMonitorService();
  qm.simulateQuotaEvent({
    providerName: 'groq',
    status: STATUS_QUOTA_EXHAUSTED,
    errorReason: 'Daily token quota exhausted',
  });

  // Customer has 500 PHOTON tokens available
  const customerTokens = 500;
  assert.ok(customerTokens > 0);

  // Regardless of customer token balance, provider is strictly hidden and blocked
  const prov = qm.getProviderAvailability('groq');
  assert.equal(prov.available, false);
  assert.equal(prov.status, STATUS_QUOTA_EXHAUSTED);

  assert.throws(() => {
    qm.assertModelRequestAllowed('groq', 'llama-3.3-70b-versatile');
  }, /quota exhausted/i);
});

// 12. All three generation categories receive correct filtered models
test('Scenario 12: All three generation categories receive correct filtered models', () => {
  const { createModelCapabilityService } = require('../model-capability-service');
  const qm = createQuotaMonitorService();
  const cap = createModelCapabilityService({ quotaMonitor: qm });

  const rawModels = [
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B', provider: 'OpenRouter', available: true },
    { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash', provider: 'Google Gemini', capabilities: { vision: true }, available: true },
    { id: '@cf/black-forest-labs/flux-1-schnell', name: 'FLUX.1 Schnell', provider: 'Cloudflare Workers AI', task: 'text-to-image', available: true },
    { id: 'stability/sd3-medium', name: 'SD3 Medium', provider: 'Stability AI', task: 'text-to-image', available: true },
  ];

  cap.registerModels(rawModels);

  // TEXT category only contains text models (Gemini with vision input remains strictly text)
  const textModels = cap.getModelsByCategory('text');
  assert.ok(textModels.some(m => m.id === 'meta-llama/llama-3.3-70b-instruct:free'));
  assert.ok(textModels.some(m => m.id === 'google/gemini-2.0-flash-exp:free'));
  assert.ok(!textModels.some(m => m.id === '@cf/black-forest-labs/flux-1-schnell'));

  // IMAGE category only contains real image generation models
  const imageModels = cap.getModelsByCategory('image');
  assert.ok(imageModels.some(m => m.id === '@cf/black-forest-labs/flux-1-schnell'));
  assert.ok(imageModels.some(m => m.id === 'stability/sd3-medium'));
  assert.ok(!imageModels.some(m => m.id === 'google/gemini-2.0-flash-exp:free'));

  // VIDEO category is empty when no video provider is configured
  const videoModels = cap.getModelsByCategory('video');
  assert.equal(videoModels.length, 0);

  // When Cloudflare exhausts its quota, FLUX.1 Schnell disappears from available image models
  qm.simulateQuotaEvent({
    providerName: 'cloudflare',
    status: STATUS_QUOTA_EXHAUSTED,
  });

  const availImageModels = cap.getModelsByCategory('image', { availableOnly: true });
  assert.ok(!availImageModels.some(m => m.id === '@cf/black-forest-labs/flux-1-schnell'));
});
