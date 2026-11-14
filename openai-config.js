'use strict';
// OpenAI configuration and non-secret provider state for PHOTON AI.
//
// Security model
// --------------
// * OPENAI_API_KEY is read only from the backend environment (API.env / .env next to server.js).
//   This module never writes it, never returns it and never stores it.
// * Only non-secret state is persisted in .photon-openai-config.json (mode 0600):
//   provider/model activation, pricing overrides, paid-fallback policy, usage counters and the
//   last key-free error records.
// * OpenAI's /v1/models endpoint proves what an account can see, not what it may call and never
//   returns pricing. A discovered model therefore starts disabled and must be verified by an
//   administrator with a real tiny completion before it becomes selectable.
// * No OpenAI model is ever marked free. Costs are always labelled as estimates.

const fs = require('node:fs');
const path = require('node:path');
const { maskKey } = require('./gemini-keys');
const { matchesList } = require('./gemini-provider');

const STATE_FILE = '.photon-openai-config.json';
const STATE_VERSION = 1;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,160}$/;
const MAX_MODELS = 200;
const MAX_RECENT_ERRORS = 20;
const DEFAULT_MIN_PLAN = 'pro';
const PLAN_TIERS = Object.freeze(['basic', 'pro', 'premium']);

// Published list prices in USD per 1 million tokens (2026 reference). They are defaults only:
// an administrator can override any model's prices in the panel and every cost is estimated.
const KNOWN_MODELS = Object.freeze({
  'gpt-5': { name: 'GPT-5', contextWindow: 400000, maxOutput: 128000, vision: true, reasoning: true, inputPer1M: 1.25, outputPer1M: 10 },
  'gpt-5.1': { name: 'GPT-5.1', contextWindow: 400000, maxOutput: 128000, vision: true, reasoning: true, inputPer1M: 1.25, outputPer1M: 10 },
  'gpt-5-mini': { name: 'GPT-5 mini', contextWindow: 400000, maxOutput: 128000, vision: true, reasoning: true, inputPer1M: 0.25, outputPer1M: 2 },
  'gpt-5-nano': { name: 'GPT-5 nano', contextWindow: 400000, maxOutput: 128000, vision: true, reasoning: true, inputPer1M: 0.05, outputPer1M: 0.4 },
  'gpt-4.1': { name: 'GPT-4.1', contextWindow: 1047576, maxOutput: 32768, vision: true, reasoning: false, inputPer1M: 2, outputPer1M: 8 },
  'gpt-4.1-mini': { name: 'GPT-4.1 mini', contextWindow: 1047576, maxOutput: 32768, vision: true, reasoning: false, inputPer1M: 0.4, outputPer1M: 1.6 },
  'gpt-4.1-nano': { name: 'GPT-4.1 nano', contextWindow: 1047576, maxOutput: 32768, vision: true, reasoning: false, inputPer1M: 0.1, outputPer1M: 0.4 },
  'gpt-4o': { name: 'GPT-4o', contextWindow: 128000, maxOutput: 16384, vision: true, reasoning: false, inputPer1M: 2.5, outputPer1M: 10 },
  'gpt-4o-mini': { name: 'GPT-4o mini', contextWindow: 128000, maxOutput: 16384, vision: true, reasoning: false, inputPer1M: 0.15, outputPer1M: 0.6 },
  'chatgpt-4o-latest': { name: 'ChatGPT-4o', contextWindow: 128000, maxOutput: 16384, vision: true, reasoning: false, inputPer1M: 5, outputPer1M: 15 },
  'gpt-4-turbo': { name: 'GPT-4 Turbo', contextWindow: 128000, maxOutput: 4096, vision: true, reasoning: false, inputPer1M: 10, outputPer1M: 30 },
  'gpt-3.5-turbo': { name: 'GPT-3.5 Turbo', contextWindow: 16385, maxOutput: 4096, vision: false, reasoning: false, inputPer1M: 0.5, outputPer1M: 1.5 },
  'o1': { name: 'o1', contextWindow: 200000, maxOutput: 100000, vision: true, reasoning: true, inputPer1M: 15, outputPer1M: 60, minPlan: 'premium' },
  'o1-mini': { name: 'o1-mini', contextWindow: 128000, maxOutput: 65536, vision: false, reasoning: true, inputPer1M: 1.1, outputPer1M: 4.4, minPlan: 'premium' },
  'o3': { name: 'o3', contextWindow: 200000, maxOutput: 100000, vision: true, reasoning: true, inputPer1M: 2, outputPer1M: 8, minPlan: 'premium' },
  'o3-mini': { name: 'o3-mini', contextWindow: 200000, maxOutput: 100000, vision: false, reasoning: true, inputPer1M: 1.1, outputPer1M: 4.4, minPlan: 'premium' },
  'o4-mini': { name: 'o4-mini', contextWindow: 200000, maxOutput: 100000, vision: true, reasoning: true, inputPer1M: 1.1, outputPer1M: 4.4, minPlan: 'premium' },
});

const CHAT_ID = /^(gpt-|chatgpt-|o[1-9](?:-|$)|ft:gpt-|ft:o[1-9])/i;
const NON_CHAT_ID = /(embedding|whisper|tts|dall-e|moderation|audio|realtime|transcribe|image|sora|babbage|davinci|curie|ada|search|computer-use)/i;

function isOpenAIChatModel(id) {
  const value = String(id || '');
  if (!MODEL_ID.test(value) || NON_CHAT_ID.test(value) || !CHAT_ID.test(value)) return false;
  return true;
}

// Exact ID first, then a dated snapshot such as gpt-5-2025-08-07, then the longest known
// family prefix (gpt-4.1-mini-2025-04-14 -> gpt-4.1-mini).
function lookupMetadata(id) {
  const value = String(id || '');
  if (KNOWN_MODELS[value]) return KNOWN_MODELS[value];
  const undated = value.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (KNOWN_MODELS[undated]) return KNOWN_MODELS[undated];
  const keys = Object.keys(KNOWN_MODELS).sort((a, b) => b.length - a.length);
  const family = keys.find(key => value.startsWith(key + '-'));
  return family ? KNOWN_MODELS[family] : null;
}

function prettyName(id) {
  const meta = lookupMetadata(id);
  if (meta && meta.name) return meta.name;
  return String(id || 'OpenAI model').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 80);
}

function normalizeModels(list, env = process.env) {
  const allow = String(env.OPENAI_MODEL_ALLOW || '').trim();
  const deny = String(env.OPENAI_MODEL_DENY || '').trim();
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const id = String(raw?.id || raw?.name || '').trim();
    if (!isOpenAIChatModel(id) || seen.has(id)) continue;
    if (allow && !matchesList(id, allow)) continue;
    if (deny && matchesList(id, deny)) continue;
    seen.add(id);
    out.push({ id, name: prettyName(id), ownedBy: raw?.owned_by ? String(raw.owned_by).slice(0, 80) : null, created: Number(raw?.created) || null });
  }
  const rank = id => {
    const keys = Object.keys(KNOWN_MODELS);
    const exact = keys.indexOf(id);
    if (exact >= 0) return exact;
    const family = keys.findIndex(key => id.startsWith(key + '-'));
    return family >= 0 ? family : keys.length;
  };
  return out.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id)).slice(0, MAX_MODELS);
}

function finitePrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function priceFor(modelId, modelState) {
  const override = modelState && modelState.pricing ? modelState.pricing : null;
  const inputOverride = finitePrice(override?.inputPer1M);
  const outputOverride = finitePrice(override?.outputPer1M);
  if (inputOverride !== null && outputOverride !== null) return { inputPer1M: inputOverride, outputPer1M: outputOverride, source: 'override' };
  const meta = lookupMetadata(modelId);
  const input = finitePrice(meta?.inputPer1M);
  const output = finitePrice(meta?.outputPer1M);
  if (input !== null && output !== null) return { inputPer1M: input, outputPer1M: output, source: 'published' };
  return { inputPer1M: null, outputPer1M: null, source: 'unknown' };
}

// Returns NaN when prices are unknown: a paid fallback must never assume a cost of zero.
function costUsdFor(pricing, usage) {
  const inputPrice = finitePrice(pricing?.inputPer1M);
  const outputPrice = finitePrice(pricing?.outputPer1M);
  if (inputPrice === null || outputPrice === null) return NaN;
  const input = Number(usage?.inputTokens ?? usage?.input_tokens) || 0;
  const output = Number(usage?.outputTokens ?? usage?.output_tokens) || 0;
  const usd = (input * inputPrice + output * outputPrice) / 1e6;
  return Math.round(usd * 1e8) / 1e8;
}

function describeModel(discovered, modelState, providerEnabled = true) {
  const id = String(discovered?.id || '');
  const meta = lookupMetadata(id) || {};
  const verifiedAt = modelState?.verifiedAt || null;
  const enabled = modelState?.enabled === true;
  const pricing = priceFor(id, modelState);
  return {
    id,
    name: String(discovered?.name || prettyName(id)).slice(0, 80),
    provider: 'OpenAI',
    ownedBy: discovered?.ownedBy || null,
    contextWindow: Number(meta.contextWindow) || null,
    maxOutput: Number(meta.maxOutput) || null,
    vision: meta.vision === true,
    reasoning: meta.reasoning === true,
    capabilities: { text: true, vision: meta.vision === true, pdf: false, reasoning: meta.reasoning === true },
    pricing,
    minPlan: PLAN_TIERS.includes(modelState?.planTier) ? modelState.planTier : (meta.minPlan || DEFAULT_MIN_PLAN),
    enabled,
    verifiedAt,
    available: Boolean(providerEnabled && enabled && verifiedAt),
    free: false,
    estimatedCosts: true,
  };
}

function emptyUsage() {
  return {
    requests: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    lastSuccessAt: null,
    lastError: null,
    byModel: {},
  };
}

function normalizeUsage(raw) {
  const base = emptyUsage();
  const input = raw && typeof raw === 'object' ? raw : {};
  for (const key of ['requests', 'failures', 'inputTokens', 'outputTokens', 'totalTokens']) {
    const value = Number(input[key]);
    if (Number.isFinite(value) && value >= 0) base[key] = Math.floor(value);
  }
  const cost = Number(input.estimatedCostUsd);
  if (Number.isFinite(cost) && cost >= 0) base.estimatedCostUsd = Math.round(cost * 1e6) / 1e6;
  base.lastSuccessAt = typeof input.lastSuccessAt === 'string' ? input.lastSuccessAt : null;
  base.lastError = input.lastError && typeof input.lastError === 'object' ? sanitizeError(input.lastError) : null;
  if (input.byModel && typeof input.byModel === 'object') {
    for (const [id, item] of Object.entries(input.byModel)) {
      if (!MODEL_ID.test(id) || !item) continue;
      const entry = emptyUsage();
      for (const key of ['requests', 'failures', 'inputTokens', 'outputTokens', 'totalTokens']) {
        const value = Number(item[key]);
        if (Number.isFinite(value) && value >= 0) entry[key] = Math.floor(value);
      }
      const modelCost = Number(item.estimatedCostUsd);
      if (Number.isFinite(modelCost) && modelCost >= 0) entry.estimatedCostUsd = Math.round(modelCost * 1e6) / 1e6;
      base.byModel[id] = {
        requests: entry.requests,
        failures: entry.failures,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        totalTokens: entry.totalTokens,
        estimatedCostUsd: entry.estimatedCostUsd,
      };
    }
  }
  return base;
}

function sanitizeError(raw) {
  return {
    at: typeof raw.at === 'string' ? raw.at : new Date(0).toISOString(),
    code: String(raw.code || 'provider_error').slice(0, 80),
    status: Number(raw.status) || null,
    model: raw.model && MODEL_ID.test(String(raw.model)) ? String(raw.model) : null,
    message: String(raw.message || '').slice(0, 300),
  };
}

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function monthKey(time) {
  const date = new Date(time);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function defaultState() {
  return {
    version: STATE_VERSION,
    enabled: true,
    allowPaidFallback: false,
    monthlySpendLimitUsd: 0,
    models: {},
    usage: emptyUsage(),
    spend: { month: null, costUsd: 0 },
    recentErrors: [],
    updatedAt: null,
  };
}

function normalizeState(raw, now) {
  const base = defaultState();
  const input = raw && typeof raw === 'object' ? raw : {};
  base.version = STATE_VERSION;
  base.enabled = input.enabled !== false;
  base.allowPaidFallback = input.allowPaidFallback === true;
  const limit = Number(input.monthlySpendLimitUsd);
  base.monthlySpendLimitUsd = Number.isFinite(limit) && limit >= 0 && limit <= 1e9 ? Math.round(limit * 100) / 100 : 0;
  if (input.models && typeof input.models === 'object') {
    for (const [id, item] of Object.entries(input.models)) {
      if (!MODEL_ID.test(id) || !item || typeof item !== 'object') continue;
      const pricing = item.pricing && typeof item.pricing === 'object' ? {
        inputPer1M: finitePrice(item.pricing.inputPer1M),
        outputPer1M: finitePrice(item.pricing.outputPer1M),
      } : null;
      base.models[id] = {
        id,
        name: item.name ? String(item.name).slice(0, 80) : prettyName(id),
        ownedBy: item.ownedBy ? String(item.ownedBy).slice(0, 80) : null,
        created: Number(item.created) || null,
        enabled: item.enabled === true,
        verifiedAt: typeof item.verifiedAt === 'string' ? item.verifiedAt : null,
        planTier: PLAN_TIERS.includes(item.planTier) ? item.planTier : null,
        pricing: pricing && pricing.inputPer1M !== null && pricing.outputPer1M !== null ? pricing : null,
        discoveredAt: typeof item.discoveredAt === 'string' ? item.discoveredAt : null,
      };
    }
  }
  base.usage = normalizeUsage(input.usage);
  if (input.spend && typeof input.spend === 'object') {
    const cost = Number(input.spend.costUsd);
    base.spend = { month: typeof input.spend.month === 'string' ? input.spend.month : null, costUsd: Number.isFinite(cost) && cost >= 0 ? cost : 0 };
  }
  if (Array.isArray(input.recentErrors)) base.recentErrors = input.recentErrors.filter(item => item && typeof item === 'object').slice(0, MAX_RECENT_ERRORS).map(sanitizeError);
  base.updatedAt = typeof input.updatedAt === 'string' ? input.updatedAt : null;
  // A new month starts a new spend window; token/request totals remain lifetime counters.
  const currentMonth = monthKey(now());
  if (base.spend.month !== currentMonth) base.spend = { month: currentMonth, costUsd: 0 };
  return base;
}

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { fs.renameSync(tmp, file); } catch { fs.rmSync(file, { force: true }); fs.renameSync(tmp, file); }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

// Reads the optional OpenAI key slots from the backend environment. Slot 1 is OPENAI_API_KEY,
// slot 2 is OPENAI_API_KEY_2, and so on up to _10. Keys are trimmed and de-duplicated; the raw
// value is only ever used to create the SDK client and is never returned or persisted.
const KEY_SLOT_NAMES = Object.freeze(['OPENAI_API_KEY', ...Array.from({ length: 9 }, (_, index) => `OPENAI_API_KEY_${index + 2}`)]);
function readEnvKeys(env = {}) {
  const keys = [];
  const seen = new Set();
  KEY_SLOT_NAMES.forEach((name, index) => {
    const key = String(env[name] || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push({ slot: index + 1, name, key, masked: maskKey(key) });
  });
  return keys;
}

function createOpenAIConfig({ dir = process.cwd(), env = process.env, logger = console, now = Date.now } = {}) {
  const stateFile = path.join(dir, STATE_FILE);
  let state;
  try {
    state = normalizeState(JSON.parse(fs.readFileSync(stateFile, 'utf8')), now);
  } catch {
    state = normalizeState(null, now);
  }

  function save() {
    state.updatedAt = new Date(now()).toISOString();
    try { writeJson(stateFile, state); } catch (error) { logger.error(JSON.stringify({ category: 'openai_state_write', code: error?.code || 'unknown' })); }
  }

  function rollMonth() {
    const currentMonth = monthKey(now());
    if (state.spend.month !== currentMonth) {
      state.spend = { month: currentMonth, costUsd: 0 };
      save();
    }
  }

  function apiKey() { return readEnvKeys(env)[0]?.key || ''; }
  function configured() { return readEnvKeys(env).length > 0; }
  function providerEnabled() { return state.enabled !== false; }
  function allowPaidFallback() { return state.allowPaidFallback === true; }
  function monthlySpendLimitUsd() { return Number(state.monthlySpendLimitUsd) || 0; }

  function keyFormatWarning() {
    for (const entry of readEnvKeys(env)) {
      if (/\s/.test(entry.key)) return `The ${entry.name} value contains whitespace.`;
      if (!entry.key.startsWith('sk-')) return `${entry.name} normally starts with "sk-".`;
    }
    return null;
  }

  function modelState(id) {
    const item = state.models[id];
    return item ? clone(item) : null;
  }

  function ensureModel(id) {
    const value = String(id || '');
    if (!MODEL_ID.test(value)) {
      const error = new Error('That OpenAI model ID is invalid.');
      error.code = 'invalid_model';
      throw error;
    }
    if (!state.models[value]) state.models[value] = { id: value, name: prettyName(value), ownedBy: null, created: null, enabled: false, verifiedAt: null, planTier: null, pricing: null, discoveredAt: null };
    return state.models[value];
  }

  function syncModels(models) {
    const next = {};
    for (const model of Array.isArray(models) ? models : []) {
      const id = String(model?.id || '');
      if (!MODEL_ID.test(id)) continue;
      const prior = state.models[id] || {};
      next[id] = {
        id,
        name: String(model?.name || prior.name || prettyName(id)).slice(0, 80),
        ownedBy: model?.ownedBy ? String(model.ownedBy).slice(0, 80) : (prior.ownedBy || null),
        created: Number(model?.created) || prior.created || null,
        enabled: prior.enabled === true,
        verifiedAt: typeof prior.verifiedAt === 'string' ? prior.verifiedAt : null,
        planTier: PLAN_TIERS.includes(prior.planTier) ? prior.planTier : null,
        pricing: prior.pricing || null,
        discoveredAt: new Date(now()).toISOString(),
      };
    }
    state.models = next;
    save();
  }

  function setProviderEnabled(value) {
    state.enabled = Boolean(value);
    save();
    return providerEnabled();
  }

  function setAllowPaidFallback(value) {
    state.allowPaidFallback = Boolean(value);
    save();
    return allowPaidFallback();
  }

  function setMonthlySpendLimitUsd(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 1e9) {
      const error = new Error('The monthly spend limit must be between 0 and 1,000,000,000 USD.');
      error.code = 'invalid_spend_limit';
      throw error;
    }
    state.monthlySpendLimitUsd = Math.round(number * 100) / 100;
    save();
    return monthlySpendLimitUsd();
  }

  function markModelVerified(id) {
    const item = ensureModel(id);
    item.verifiedAt = new Date(now()).toISOString();
    save();
    return clone(item);
  }

  function setModelEnabled(id, enabled) {
    const item = ensureModel(id);
    if (enabled && !item.verifiedAt) {
      const error = new Error('Test this model successfully before enabling it.');
      error.code = 'model_not_verified';
      throw error;
    }
    item.enabled = Boolean(enabled);
    save();
    return clone(item);
  }

  function setModelPricing(id, input, output) {
    const item = ensureModel(id);
    const inputPrice = finitePrice(input);
    const outputPrice = finitePrice(output);
    if (inputPrice === null || outputPrice === null) {
      const error = new Error('Prices must be non-negative numbers in USD per 1M tokens.');
      error.code = 'invalid_pricing';
      throw error;
    }
    item.pricing = { inputPer1M: inputPrice, outputPer1M: outputPrice };
    save();
    return clone(item);
  }

  function clearModelPricing(id) {
    const item = ensureModel(id);
    item.pricing = null;
    save();
    return clone(item);
  }

  function setModelPlan(id, plan) {
    const item = ensureModel(id);
    if (plan !== null && plan !== undefined && plan !== '' && !PLAN_TIERS.includes(plan)) {
      const error = new Error('Choose the Basic, Pro or Premium plan tier.');
      error.code = 'invalid_plan';
      throw error;
    }
    item.planTier = PLAN_TIERS.includes(plan) ? plan : null;
    save();
    return clone(item);
  }

  function recordUsage({ model, usage, costUsd, ok, code, message, status } = {}) {
    rollMonth();
    const id = model && MODEL_ID.test(String(model)) ? String(model) : null;
    const inputTokens = Math.max(0, Math.floor(Number(usage?.inputTokens ?? usage?.input_tokens) || 0));
    const outputTokens = Math.max(0, Math.floor(Number(usage?.outputTokens ?? usage?.output_tokens) || 0));
    const totalTokens = Math.max(0, Math.floor(Number(usage?.totalTokens ?? usage?.total_tokens) || inputTokens + outputTokens));
    const cost = Number(costUsd);
    const safeCost = Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 1e6) / 1e6 : 0;
    state.usage.requests += 1;
    state.usage.inputTokens += inputTokens;
    state.usage.outputTokens += outputTokens;
    state.usage.totalTokens += totalTokens;
    state.usage.estimatedCostUsd = Math.round((state.usage.estimatedCostUsd + safeCost) * 1e6) / 1e6;
    if (id) {
      const item = state.usage.byModel[id] || { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
      item.requests += 1;
      item.inputTokens += inputTokens;
      item.outputTokens += outputTokens;
      item.totalTokens += totalTokens;
      item.estimatedCostUsd = Math.round((item.estimatedCostUsd + safeCost) * 1e6) / 1e6;
      if (ok === false) item.failures += 1;
      state.usage.byModel[id] = item;
    }
    if (ok === false) {
      state.usage.failures += 1;
      const record = sanitizeError({ at: new Date(now()).toISOString(), code: code || 'provider_error', status, model: id, message: message || '' });
      state.usage.lastError = record;
      state.recentErrors = [record, ...state.recentErrors].slice(0, MAX_RECENT_ERRORS);
    } else {
      state.usage.lastSuccessAt = new Date(now()).toISOString();
    }
    if (safeCost > 0) state.spend.costUsd = Math.round((state.spend.costUsd + safeCost) * 1e6) / 1e6;
    save();
  }

  function usage() {
    rollMonth();
    return clone(state.usage);
  }

  function spend() {
    rollMonth();
    return { month: state.spend.month, costUsd: state.spend.costUsd, monthlyLimitUsd: monthlySpendLimitUsd(), allowPaidFallback: allowPaidFallback() };
  }

  function canSpendPaid(costUsd) {
    rollMonth();
    if (!allowPaidFallback()) return false;
    const limit = monthlySpendLimitUsd();
    if (!(limit > 0)) return false;
    const cost = Number(costUsd);
    if (!Number.isFinite(cost) || cost < 0) return false;
    return state.spend.costUsd + cost <= limit + 1e-9;
  }

  function snapshot() {
    return {
      provider: 'OpenAI',
      enabled: providerEnabled(),
      configured: configured(),
      maskedKey: configured() ? maskKey(apiKey()) : null,
      keys: readEnvKeys(env).map(entry => ({ slot: entry.slot, name: entry.name, masked: entry.masked })),
      keyFormatWarning: keyFormatWarning(),
      allowPaidFallback: allowPaidFallback(),
      monthlySpendLimitUsd: monthlySpendLimitUsd(),
      spend: spend(),
      usage: usage(),
      recentErrors: clone(state.recentErrors),
      models: clone(state.models),
      updatedAt: state.updatedAt,
      stateFile,
    };
  }

  return {
    stateFile,
    snapshot,
    configured,
    providerEnabled,
    setProviderEnabled,
    allowPaidFallback,
    setAllowPaidFallback,
    monthlySpendLimitUsd,
    setMonthlySpendLimitUsd,
    keyFormatWarning,
    modelState,
    syncModels,
    markModelVerified,
    setModelEnabled,
    setModelPricing,
    clearModelPricing,
    setModelPlan,
    recordUsage,
    usage,
    spend,
    canSpendPaid,
  };
}

module.exports = {
  createOpenAIConfig,
  readEnvKeys,
  KEY_SLOT_NAMES,
  normalizeModels,
  normalizeState,
  describeModel,
  lookupMetadata,
  isOpenAIChatModel,
  costUsdFor,
  priceFor,
  prettyName,
  MODEL_ID,
  STATE_FILE,
  KNOWN_MODELS,
  PLAN_TIERS,
  DEFAULT_MIN_PLAN,
  MAX_MODELS,
};
