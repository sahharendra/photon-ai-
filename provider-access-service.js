'use strict';

/**
 * PHOTON AI — Centralized Provider Access Service
 *
 * Enforces plan-based AI provider and model access controls across the application.
 *
 * Rules:
 * - Basic Plan: ONLY OpenRouter and CodeCraft.
 * - Pro Plan: ONLY OpenRouter, CodeCraft, and Groq.
 * - Premium Plan: ALL enabled and available providers (OpenRouter, CodeCraft, Groq, NVIDIA, OpenAI, Google Gemini, etc.).
 */

const PLAN_ALLOWED_PROVIDERS = Object.freeze({
  basic: Object.freeze(['openrouter', 'codecraft', 'ollama', 'llmtr', 'cloudflare', 'pollinations']),
  free: Object.freeze(['openrouter', 'codecraft', 'ollama', 'llmtr', 'cloudflare', 'pollinations']),
  pro: Object.freeze(['openrouter', 'codecraft', 'groq', 'ollama', 'llmtr', 'cloudflare', 'pollinations']),
  premium: Object.freeze(['openrouter', 'codecraft', 'groq', 'nvidia', 'openai', 'google', 'ollama', 'llmtr', 'cloudflare', 'pollinations', '*']),
});

const PROVIDER_ALIASES = Object.freeze({
  'openrouter': 'openrouter',
  'open-router': 'openrouter',
  'codecraft': 'codecraft',
  'code-craft': 'codecraft',
  'groq': 'groq',
  'groqcloud': 'groq',
  'nvidia': 'nvidia',
  'nvidia nim': 'nvidia',
  'nvidianim': 'nvidia',
  'nim': 'nvidia',
  'openai': 'openai',
  'google': 'google',
  'gemini': 'google',
  'google gemini': 'google',
  'meta': 'meta',
  'anthropic': 'anthropic',
  'llmtr': 'llmtr',
  'freellmapi': 'llmtr',
  'ollama': 'ollama',
  'ollama cloud': 'ollama',
  'ollamacloud': 'ollama',
  'cloudflare': 'cloudflare',
  'cloudflare ai': 'cloudflare',
  'cloudflare workers ai': 'cloudflare',
  'cloudflare_workers_ai': 'cloudflare',
  'pollinations': 'pollinations',
  'pollinations ai': 'pollinations',
  'pollinationsai': 'pollinations',
});

function normalizePlanId(planId) {
  const p = String(planId || 'basic').trim().toLowerCase();
  if (p === 'free' || p === 'basic') return 'basic';
  if (p === 'pro') return 'pro';
  if (p === 'premium') return 'premium';
  return p;
}

function normalizeProviderName(provider) {
  if (!provider) return '';
  const clean = String(provider).trim().toLowerCase().replace(/[\s_-]+/g, '');
  for (const [alias, canonical] of Object.entries(PROVIDER_ALIASES)) {
    if (alias.replace(/[\s_-]+/g, '') === clean) return canonical;
  }
  return clean;
}

function getAllowedProvidersForPlan(planId) {
  const normalized = normalizePlanId(planId);
  return PLAN_ALLOWED_PROVIDERS[normalized] || PLAN_ALLOWED_PROVIDERS.basic;
}

function isProviderAllowedForPlan(provider, planId) {
  const allowed = getAllowedProvidersForPlan(planId);
  if (allowed.includes('*')) return true;
  const canonical = normalizeProviderName(provider);
  return allowed.includes(canonical);
}

function isModelAllowedForPlan(modelOption, planId) {
  if (!modelOption) return false;
  // If model is disabled or unavailable globally, it is not eligible
  if (modelOption.enabled === false) return false;
  if (modelOption.configured === false) return false;

  // Free models are available to all subscription tiers (Basic/Free, Pro, Premium)
  if (modelOption.free === true) return true;

  const provider = modelOption.provider || '';
  return isProviderAllowedForPlan(provider, planId);
}

function filterModelsForPlan(models, planId) {
  if (!Array.isArray(models)) return [];
  const normalized = normalizePlanId(planId);
  return models.filter(m => {
    if (!m) return false;
    return isModelAllowedForPlan(m, normalized);
  });
}

class ProviderAccessError extends Error {
  constructor(message = 'This AI provider is not available on your current subscription plan. Please upgrade your plan.') {
    super(message);
    this.name = 'ProviderAccessError';
    this.status = 403;
    this.code = 'provider_plan_restricted';
  }
}

function validateProviderAccess(planId, modelOption) {
  const normalized = normalizePlanId(planId);
  if (!isModelAllowedForPlan(modelOption, normalized)) {
    throw new ProviderAccessError();
  }
}

function getEligibleDefaultModel(models, planId, preferredModelId) {
  const eligible = filterModelsForPlan(models, planId).filter(m => m.available !== false);
  if (!eligible.length) return null;
  if (preferredModelId) {
    const match = eligible.find(m => m.id === preferredModelId);
    if (match) return match.id;
  }
  return eligible[0].id;
}

module.exports = {
  PLAN_ALLOWED_PROVIDERS,
  ProviderAccessError,
  normalizePlanId,
  normalizeProviderName,
  getAllowedProvidersForPlan,
  isProviderAllowedForPlan,
  isModelAllowedForPlan,
  filterModelsForPlan,
  validateProviderAccess,
  getEligibleDefaultModel,
};
