'use strict';
// Shared provider-fallback policy for PHOTON AI. This module never talks to a provider itself:
// server.js asks it which already-available model, if any, may receive one fallback hop.
//
// Safety rules
// ------------
// * Only short-lived availability failures are eligible. Authentication, billing/credit, rate
//   limit, invalid-request, content-policy, plan and cancellation failures are never retried on
//   another provider.
// * The user's chosen model is always tried first. Fallback never overrides that preference.
// * Free/local destinations (OpenRouter free models, local Ollama) are the default. A paid
//   destination (OpenAI, Anthropic, Gemini) is used only when the administrator explicitly opted
//   in and the configured spend limit still has headroom.
// * Capabilities and the customer's plan are checked before a candidate is eligible.

const FALLBACK_CODES = Object.freeze([
  'provider_unavailable',
  'provider_overloaded',
  'network_error',
  'provider_timeout',
  'invalid_model',
  'provider_error',
  'empty_response',
  'not_configured',
  'invalid_api_token',
  'invalid_api_key',
  'billing_required',
  'quota_exhausted',
  'quota_or_rate_limit',
]);
const FALLBACK_SET = new Set(FALLBACK_CODES);
const FREE_PROVIDERS = new Set([
  'OpenRouter',
  'Ollama',
  'Cloudflare Workers AI',
  'Groq',
  'NVIDIA NIM',
  'CodeCraft',
  'LLMTR',
]);
const PAID_PROVIDERS = new Set(['OpenAI', 'Anthropic', 'Google']);

function fallbackEligible(code) { return FALLBACK_SET.has(String(code || '')); }

function isFreeDestination(option) {
  if (!option) return false;
  return option.free === true || option.local === true || FREE_PROVIDERS.has(option.provider);
}

function isPaidDestination(option) {
  if (!option) return false;
  if (isFreeDestination(option)) return false;
  return PAID_PROVIDERS.has(option.provider);
}

function capabilityNeeds(attachments = []) {
  let requiresVision = false;
  let requiresPdf = false;
  for (const file of Array.isArray(attachments) ? attachments : []) {
    if (!file || file.kind === 'text') continue;
    const mime = String(file.mimeType || '').toLowerCase();
    if (mime === 'application/pdf') requiresPdf = true;
    else if (mime.startsWith('image/')) requiresVision = true;
  }
  return { requiresVision, requiresPdf };
}

function capabilityOk(option, context = {}) {
  const caps = option?.capabilities || {};
  const needs = context.needs || capabilityNeeds(context.attachments);
  if (needs.requiresVision && caps.vision !== true) return false;
  if (needs.requiresPdf && caps.pdf !== true) return false;
  return true;
}

// Chooses at most one fallback destination. Returns null when no safe candidate remains.
function chooseFallback({ failureCode, primary, candidates, planId, context = {}, policy = {} } = {}) {
  if (!fallbackEligible(failureCode)) return null;
  if (!primary || !primary.id) return null;
  const planAllows = typeof policy.planAllows === 'function' ? policy.planAllows : () => true;
  const allowPaid = typeof policy.allowPaid === 'function' ? policy.allowPaid : () => false;
  const paidBudgetOk = typeof policy.paidBudgetOk === 'function' ? policy.paidBudgetOk : () => false;
  const needs = context.needs || capabilityNeeds(context.attachments);
  const list = (Array.isArray(candidates) ? candidates : [])
    .filter(option => option && option.id && option.id !== primary.id && option.available === true)
    .filter(option => capabilityOk(option, { needs }))
    .filter(option => planAllows(option, planId))
    .filter(option => {
      if (isFreeDestination(option)) return true;
      if (!isPaidDestination(option)) return false;      // unknown providers are not fallback targets
      return Boolean(allowPaid(option, context)) && Boolean(paidBudgetOk(option, context));
    });
  if (!list.length) return null;
  // Free/local first; then the order supplied by the caller (the user's catalog order). This keeps
  // fallback deterministic and makes an accidental paid switch very unlikely.
  const ordered = [...list].sort((a, b) => Number(isFreeDestination(b)) - Number(isFreeDestination(a)));
  return { option: ordered[0], from: primary.id, reason: failureCode, paid: isPaidDestination(ordered[0]) };
}

module.exports = {
  FALLBACK_CODES,
  fallbackEligible,
  isFreeDestination,
  isPaidDestination,
  capabilityNeeds,
  capabilityOk,
  chooseFallback,
};
