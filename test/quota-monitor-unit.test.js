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
} = require('../quota-monitor-service');

test('Scenario 1: Provider healthy -> provider and models visible', () => {
  const qm = createQuotaMonitorService();
  const provCheck = qm.getProviderAvailability('groq');
  assert.equal(provCheck.available, true);
  assert.equal(provCheck.status, STATUS_HEALTHY);

  const modelCheck = qm.getModelAvailability('groq', 'llama-3.3-70b-versatile');
  assert.equal(modelCheck.available, true);
  assert.equal(modelCheck.status, STATUS_HEALTHY);
});

test('Scenario 2: One model exhausted -> only that model hidden', () => {
  const qm = createQuotaMonitorService();
  // Groq rate limits specific model llama-3.3-70b-versatile
  qm.simulateQuotaEvent({
    providerName: 'groq',
    modelId: 'llama-3.3-70b-versatile',
    status: STATUS_QUOTA_EXHAUSTED,
    errorReason: 'Tokens per day limit reached',
    resetInMs: 3600000,
  });

  // The exhausted model is hidden / unavailable
  const m1 = qm.getModelAvailability('groq', 'llama-3.3-70b-versatile');
  assert.equal(m1.available, false);
  assert.equal(m1.status, STATUS_QUOTA_EXHAUSTED);

  // Another Groq model remains healthy & available
  const m2 = qm.getModelAvailability('groq', 'llama-3.1-8b-instant');
  assert.equal(m2.available, true);
  assert.equal(m2.status, STATUS_HEALTHY);

  // The provider itself remains available because m2 is available
  const prov = qm.getProviderAvailability('groq');
  assert.equal(prov.available, true);
});

test('Scenario 3: All models exhausted -> provider marked exhausted', () => {
  const qm = createQuotaMonitorService();
  qm.simulateQuotaEvent({
    providerName: 'cloudflare',
    status: STATUS_QUOTA_EXHAUSTED,
    errorReason: 'Daily 10,000 neurons limit exhausted',
    resetInMs: 3600000,
  });

  const prov = qm.getProviderAvailability('cloudflare');
  assert.equal(prov.available, false);
  assert.equal(prov.status, STATUS_QUOTA_EXHAUSTED);

  const m = qm.getModelAvailability('cloudflare', '@cf/meta/llama-3.1-8b-instruct');
  assert.equal(m.available, false);
});

test('Scenario 4: One key exhausted, another healthy -> provider remains visible', () => {
  const qm = createQuotaMonitorService();
  // Key slot 1 is exhausted
  qm.simulateQuotaEvent({
    providerName: 'gemini',
    keySlot: 'slot_1',
    status: STATUS_QUOTA_EXHAUSTED,
    errorReason: 'Key 1 exhausted',
  });
  // Key slot 2 is healthy
  qm.recordSuccess({
    providerName: 'gemini',
    keySlot: 'slot_2',
  });

  // Overall provider remains available because slot_2 is healthy
  const prov = qm.getProviderAvailability('gemini');
  assert.equal(prov.available, true);
  assert.equal(prov.status, STATUS_HEALTHY);
});

test('Scenario 5: Daily quota reset -> models automatically restored', async () => {
  const qm = createQuotaMonitorService();
  // Model exhausted with reset in 20ms
  qm.simulateQuotaEvent({
    providerName: 'groq',
    modelId: 'llama-3.1-8b-instant',
    status: STATUS_QUOTA_EXHAUSTED,
    resetInMs: 20,
  });

  assert.equal(qm.getModelAvailability('groq', 'llama-3.1-8b-instant').available, false);

  // Wait 30ms for reset time to pass
  await new Promise(r => setTimeout(r, 30));

  // Trigger evaluation
  qm.checkAndRestoreAll();

  // Model is automatically restored to healthy
  const restored = qm.getModelAvailability('groq', 'llama-3.1-8b-instant');
  assert.equal(restored.available, true);
  assert.equal(restored.status, STATUS_HEALTHY);
});

test('Scenario 6: Temporary 429 -> model hidden temporarily and restored after recovery', async () => {
  const qm = createQuotaMonitorService();
  // Temporary 429 rate limit with short reset
  qm.simulateQuotaEvent({
    providerName: 'nvidia',
    modelId: 'nvidia/llama-3.1-nemotron-70b-instruct',
    status: STATUS_RATE_LIMITED,
    resetInMs: 25,
  });

  assert.equal(qm.getModelAvailability('nvidia', 'nvidia/llama-3.1-nemotron-70b-instruct').available, false);

  await new Promise(r => setTimeout(r, 35));
  qm.checkAndRestoreAll();

  assert.equal(qm.getModelAvailability('nvidia', 'nvidia/llama-3.1-nemotron-70b-instruct').available, true);
});

test('Scenario 7: Invalid key -> provider marked INVALID_KEY', () => {
  const qm = createQuotaMonitorService();
  qm.recordError({
    providerName: 'groq',
    status: 401,
    message: 'Invalid API Key provided',
  });

  const prov = qm.getProviderAvailability('groq');
  assert.equal(prov.available, false);
  assert.equal(prov.status, STATUS_INVALID_KEY);
});

test('Scenario 8: Direct API call to exhausted model -> rejected by backend', () => {
  const qm = createQuotaMonitorService();
  qm.simulateQuotaEvent({
    providerName: 'openrouter',
    modelId: 'meta-llama/llama-3.3-70b-instruct:free',
    status: STATUS_QUOTA_EXHAUSTED,
    errorReason: 'Free credits exhausted',
  });

  assert.throws(() => {
    qm.assertModelRequestAllowed('openrouter', 'meta-llama/llama-3.3-70b-instruct:free');
  }, (err) => {
    return err.code === 'quota_exhausted' && err.status === 402;
  });
});

test('Scenario 9: Quota error classification across providers', () => {
  const qm = createQuotaMonitorService();

  // OpenRouter insufficient credits
  const orRes = qm.recordError({
    providerName: 'openrouter',
    status: 402,
    message: 'User credit balance is zero',
  });
  assert.equal(orRes.status, STATUS_INSUFFICIENT_CREDITS);

  // Gemini Resource Exhausted with Daily note
  const gemRes = qm.recordError({
    providerName: 'gemini',
    status: 429,
    message: 'Resource exhausted: rate limit exceeded per day',
  });
  assert.equal(gemRes.status, STATUS_QUOTA_EXHAUSTED);

  // Cloudflare daily neuron exhaustion
  const cfRes = qm.recordError({
    providerName: 'cloudflare',
    status: 402,
    message: 'Cloudflare Workers AI daily free neuron allocation exhausted',
  });
  assert.equal(cfRes.status, STATUS_QUOTA_EXHAUSTED);
});

test('Scenario 10: Status snapshot produces complete, clean output for admin dashboard', () => {
  const qm = createQuotaMonitorService();
  qm.simulateQuotaEvent({
    providerName: 'groq',
    modelId: 'mixtral-8x7b-32768',
    status: STATUS_RATE_LIMITED,
    errorReason: 'RPM exceeded',
  });

  const snap = qm.getStatusSnapshot();
  assert.ok(snap.timestamp);
  assert.ok(snap.providers.groq);
  assert.equal(snap.providers.groq.name, 'Groq');
  const m = snap.providers.groq.models.find(x => x.id === 'mixtral-8x7b-32768');
  assert.ok(m);
  assert.equal(m.status, STATUS_RATE_LIMITED);
});

test('Scenario 11: Provider disabled by admin -> remains hidden', () => {
  const qm = createQuotaMonitorService();
  qm.simulateQuotaEvent({
    providerName: 'cohere',
    status: 'DISABLED',
    errorReason: 'Disabled by administrator in AI provider settings',
  });

  const prov = qm.getProviderAvailability('cohere');
  assert.equal(prov.available, false);
  assert.equal(prov.status, 'DISABLED');
});

test('Scenario 12: Zero-billing protection: never marks unknown quota as available', () => {
  const qm = createQuotaMonitorService();
  qm.simulateQuotaEvent({
    providerName: 'openrouter',
    status: STATUS_INSUFFICIENT_CREDITS,
    errorReason: 'Zero balance',
  });

  // Check that without positive credit verification, it does not magically restore
  qm.checkAndRestoreAll();
  const prov = qm.getProviderAvailability('openrouter');
  assert.equal(prov.available, false);
  assert.equal(prov.status, STATUS_INSUFFICIENT_CREDITS);
});
