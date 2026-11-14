'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isProviderAllowedForPlan,
  isModelAllowedForPlan,
  filterModelsForPlan,
  validateProviderAccess,
  ProviderAccessError,
} = require('../provider-access-service');

test('Basic plan allows ONLY OpenRouter and CodeCraft', () => {
  assert.equal(isProviderAllowedForPlan('OpenRouter', 'basic'), true);
  assert.equal(isProviderAllowedForPlan('CodeCraft', 'basic'), true);
  assert.equal(isProviderAllowedForPlan('Groq', 'basic'), false);
  assert.equal(isProviderAllowedForPlan('NVIDIA', 'basic'), false);
  assert.equal(isProviderAllowedForPlan('OpenAI', 'basic'), false);
  assert.equal(isProviderAllowedForPlan('Google', 'basic'), false);
});

test('Pro plan allows ONLY OpenRouter, CodeCraft, and Groq', () => {
  assert.equal(isProviderAllowedForPlan('OpenRouter', 'pro'), true);
  assert.equal(isProviderAllowedForPlan('CodeCraft', 'pro'), true);
  assert.equal(isProviderAllowedForPlan('Groq', 'pro'), true);
  assert.equal(isProviderAllowedForPlan('NVIDIA', 'pro'), false);
  assert.equal(isProviderAllowedForPlan('OpenAI', 'pro'), false);
  assert.equal(isProviderAllowedForPlan('Google', 'pro'), false);
});

test('Premium plan allows all enabled providers', () => {
  assert.equal(isProviderAllowedForPlan('OpenRouter', 'premium'), true);
  assert.equal(isProviderAllowedForPlan('CodeCraft', 'premium'), true);
  assert.equal(isProviderAllowedForPlan('Groq', 'premium'), true);
  assert.equal(isProviderAllowedForPlan('NVIDIA', 'premium'), true);
  assert.equal(isProviderAllowedForPlan('OpenAI', 'premium'), true);
  assert.equal(isProviderAllowedForPlan('Google', 'premium'), true);
});

test('filterModelsForPlan strictly filters models by subscription plan', () => {
  const models = [
    { id: 'or-1', name: 'OR Model', provider: 'OpenRouter' },
    { id: 'cc-1', name: 'CC Model', provider: 'CodeCraft' },
    { id: 'gq-1', name: 'Groq Model', provider: 'Groq' },
    { id: 'nv-1', name: 'Nvidia Model', provider: 'NVIDIA' },
    { id: 'oa-1', name: 'OpenAI Model', provider: 'OpenAI' },
    { id: 'gm-1', name: 'Gemini Model', provider: 'Google' },
  ];

  const basicModels = filterModelsForPlan(models, 'basic');
  assert.deepEqual(basicModels.map(m => m.id), ['or-1', 'cc-1']);

  const proModels = filterModelsForPlan(models, 'pro');
  assert.deepEqual(proModels.map(m => m.id), ['or-1', 'cc-1', 'gq-1']);

  const premiumModels = filterModelsForPlan(models, 'premium');
  assert.deepEqual(premiumModels.map(m => m.id), ['or-1', 'cc-1', 'gq-1', 'nv-1', 'oa-1', 'gm-1']);
});

test('validateProviderAccess throws 403 ProviderAccessError when restricted', () => {
  assert.throws(
    () => validateProviderAccess('basic', { id: 'nv-1', provider: 'NVIDIA' }),
    err => {
      assert.ok(err instanceof ProviderAccessError);
      assert.equal(err.status, 403);
      assert.equal(err.code, 'provider_plan_restricted');
      assert.equal(err.message, 'This AI provider is not available on your current subscription plan. Please upgrade your plan.');
      return true;
    }
  );

  assert.throws(
    () => validateProviderAccess('pro', { id: 'nv-1', provider: 'NVIDIA' }),
    err => {
      assert.equal(err.status, 403);
      return true;
    }
  );

  // Premium should not throw
  assert.doesNotThrow(() => validateProviderAccess('premium', { id: 'nv-1', provider: 'NVIDIA' }));
});
