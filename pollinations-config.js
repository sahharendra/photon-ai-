'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILENAME = '.photon-pollinations-config.json';
const DEFAULT_MONTHLY_BUDGET_USD = 5.0; // conservative spending cap

const DEFAULT_IMAGE_MODELS = [
  {
    id: 'black-forest-labs/flux.1-schnell',
    name: 'FLUX.1 Schnell',
    publisher: 'Black Forest Labs',
    enabled: true,
    capabilities: { image: true, text: true },
    pricing: { currency: 'pollen', completionImageTokens: '0.0006' },
    defaultSize: '1024x1024',
    contextLength: 1024,
    description: 'Ultra-fast state-of-the-art open-source text-to-image model.'
  },
  {
    id: 'tongyi-mai/z-image-turbo',
    name: 'Z-Image Turbo',
    publisher: 'Alibaba',
    enabled: true,
    capabilities: { image: true, text: true },
    pricing: { currency: 'pollen', completionImageTokens: '0.004' },
    defaultSize: '1024x1024',
    contextLength: 1024,
    description: 'Quickly generate a sharp image with built-in upscaling.'
  },
  {
    id: 'stability-ai/stable-diffusion-3.5-large',
    name: 'Stable Diffusion 3.5 Large',
    publisher: 'Stability AI',
    enabled: true,
    capabilities: { image: true, text: true },
    pricing: { currency: 'pollen', completionImageTokens: '0.08' },
    defaultSize: '1024x1024',
    contextLength: 1024,
    description: 'High-fidelity Stable Diffusion 3.5 model from Stability AI.'
  },
  {
    id: 'recraft/recraft-v4.1-flash',
    name: 'Recraft V4.1 Flash',
    publisher: 'Recraft',
    enabled: true,
    capabilities: { image: true, text: true },
    pricing: { currency: 'pollen', completionImageTokens: '0.007' },
    defaultSize: '1024x1024',
    contextLength: 1024,
    description: 'Fast design and raster image generation by Recraft.'
  },
  {
    id: 'bytedance/seedream-5.0-flash',
    name: 'Seedream 5.0 Flash',
    publisher: 'ByteDance',
    enabled: true,
    capabilities: { image: true, text: true },
    pricing: { currency: 'pollen', completionImageTokens: '0.01899' },
    defaultSize: '1024x1024',
    contextLength: 1024,
    description: 'ByteDance rapid generative image model.'
  }
];

function readEnvKey(env = process.env) {
  const raw = env.POLLINATIONS_API_KEY || '';
  const trimmed = String(raw).trim();
  return trimmed || null;
}

function maskKey(key) {
  if (!key || typeof key !== 'string') return null;
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '••••' + trimmed.slice(-2);
  const prefix = trimmed.startsWith('sk_') ? trimmed.slice(0, 7) : trimmed.slice(0, 4);
  return `${prefix}••••${trimmed.slice(-4)}`;
}

function getUtcMonthKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function safeNumber(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function createPollinationsConfig({ dir = process.cwd(), env = process.env } = {}) {
  const configPath = path.join(dir, CONFIG_FILENAME);

  function loadDiskState() {
    try {
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(raw);
      }
    } catch {
      // Corrupt file or permission issue; start fresh
    }
    return {};
  }

  function saveDiskState(data) {
    try {
      fs.writeFileSync(configPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch {
      // Best-effort persistence
    }
  }

  let state = loadDiskState();

  // Ensure default structures
  if (typeof state.enabled !== 'boolean') state.enabled = true;
  if (!state.spendingPolicy) state.spendingPolicy = 'allow_budgeted_only'; // 'allow_budgeted_only' | 'allow_free_only' | 'block'
  if (typeof state.monthlyBudgetCapUsd !== 'number') state.monthlyBudgetCapUsd = DEFAULT_MONTHLY_BUDGET_USD;
  if (!state.currentMonthKey) state.currentMonthKey = getUtcMonthKey();
  if (!state.models || typeof state.models !== 'object') {
    state.models = {};
    for (const m of DEFAULT_IMAGE_MODELS) {
      state.models[m.id] = { ...m };
    }
  }
  if (!state.usage || typeof state.usage !== 'object') {
    state.usage = {
      requests: 0,
      failures: 0,
      costUsd: 0,
      pollenSpent: 0,
      lastSuccessAt: null,
      lastError: null,
      monthlyUsage: {}
    };
  }

  function checkMonthlyRollover() {
    const currentKey = getUtcMonthKey();
    if (state.currentMonthKey !== currentKey) {
      state.currentMonthKey = currentKey;
      if (!state.usage.monthlyUsage) state.usage.monthlyUsage = {};
      if (!state.usage.monthlyUsage[currentKey]) {
        state.usage.monthlyUsage[currentKey] = { requests: 0, costUsd: 0, pollenSpent: 0 };
      }
      saveDiskState(state);
    }
  }

  checkMonthlyRollover();

  return {
    getApiKey() {
      return readEnvKey(env);
    },
    isConfigured() {
      return Boolean(readEnvKey(env));
    },
    getMaskedKey() {
      return maskKey(readEnvKey(env));
    },
    isEnabled() {
      return state.enabled !== false;
    },
    setEnabled(val) {
      state.enabled = Boolean(val);
      saveDiskState(state);
    },
    getSpendingPolicy() {
      return state.spendingPolicy || 'allow_budgeted_only';
    },
    setSpendingPolicy(policy) {
      const allowed = ['allow_budgeted_only', 'allow_free_only', 'block'];
      if (allowed.includes(policy)) {
        state.spendingPolicy = policy;
        saveDiskState(state);
      }
    },
    getMonthlyBudgetCapUsd() {
      return state.monthlyBudgetCapUsd != null ? state.monthlyBudgetCapUsd : DEFAULT_MONTHLY_BUDGET_USD;
    },
    setMonthlyBudgetCapUsd(cap) {
      const num = safeNumber(cap, DEFAULT_MONTHLY_BUDGET_USD);
      state.monthlyBudgetCapUsd = Math.max(0, num);
      saveDiskState(state);
    },
    getDefaultModelId() {
      return state.defaultModelId || 'black-forest-labs/flux.1-schnell';
    },
    setDefaultModelId(id) {
      state.defaultModelId = id ? String(id).trim() : null;
      saveDiskState(state);
    },
    getCurrentMonthSpendUsd() {
      checkMonthlyRollover();
      const currentKey = state.currentMonthKey || getUtcMonthKey();
      return state.usage?.monthlyUsage?.[currentKey]?.costUsd || 0;
    },
    getCurrentMonthRequests() {
      checkMonthlyRollover();
      const currentKey = state.currentMonthKey || getUtcMonthKey();
      return state.usage?.monthlyUsage?.[currentKey]?.requests || 0;
    },
    isBudgetExhausted() {
      if (state.spendingPolicy === 'block') return true;
      const spent = this.getCurrentMonthSpendUsd();
      const cap = this.getMonthlyBudgetCapUsd();
      return cap > 0 && spent >= cap;
    },
    recordRequestSuccess({ costUsd = 0, pollenSpent = 0 } = {}) {
      checkMonthlyRollover();
      const currentKey = state.currentMonthKey || getUtcMonthKey();
      const cost = Math.max(0, safeNumber(costUsd, 0));
      const pollen = Math.max(0, safeNumber(pollenSpent, 0));

      state.usage.requests = (state.usage.requests || 0) + 1;
      state.usage.costUsd = (state.usage.costUsd || 0) + cost;
      state.usage.pollenSpent = (state.usage.pollenSpent || 0) + pollen;
      state.usage.lastSuccessAt = new Date().toISOString();
      state.usage.lastError = null;

      if (!state.usage.monthlyUsage) state.usage.monthlyUsage = {};
      if (!state.usage.monthlyUsage[currentKey]) {
        state.usage.monthlyUsage[currentKey] = { requests: 0, costUsd: 0, pollenSpent: 0 };
      }
      const m = state.usage.monthlyUsage[currentKey];
      m.requests = (m.requests || 0) + 1;
      m.costUsd = (m.costUsd || 0) + cost;
      m.pollenSpent = (m.pollenSpent || 0) + pollen;

      saveDiskState(state);
    },
    recordRequestFailure(error) {
      state.usage.failures = (state.usage.failures || 0) + 1;
      state.usage.lastError = {
        code: error?.code || 'error',
        message: error?.message || 'Request failed',
        at: new Date().toISOString()
      };
      saveDiskState(state);
    },
    getUsage() {
      checkMonthlyRollover();
      return {
        ...state.usage,
        currentMonthSpendUsd: this.getCurrentMonthSpendUsd(),
        currentMonthRequests: this.getCurrentMonthRequests(),
        monthlyBudgetCapUsd: this.getMonthlyBudgetCapUsd(),
        isBudgetExhausted: this.isBudgetExhausted()
      };
    },
    getModels() {
      return Object.values(state.models || {});
    },
    getModel(id) {
      return state.models?.[id] || null;
    },
    setModelEnabled(id, enabled) {
      if (!id || typeof id !== 'string') throw new Error('Invalid model ID');
      if (!state.models[id]) {
        state.models[id] = { id, name: id, enabled: Boolean(enabled) };
      } else {
        state.models[id].enabled = Boolean(enabled);
      }
      saveDiskState(state);
    },
    updateDiscoveredModels(modelsList = []) {
      if (!Array.isArray(modelsList)) return;
      for (const m of modelsList) {
        if (!m || !m.name) continue;
        const id = m.name;
        const existing = state.models[id];
        state.models[id] = {
          id,
          name: m.title || id,
          publisher: m.publisher || 'Pollinations',
          enabled: existing ? existing.enabled : true,
          aliases: Array.isArray(m.aliases) ? m.aliases : [],
          capabilities: { image: true, text: true },
          pricing: m.pricing || { currency: 'pollen' },
          defaultSize: '1024x1024',
          description: m.description || '',
          input_modalities: m.input_modalities || ['text'],
          output_modalities: m.output_modalities || ['image'],
          supported_endpoints: m.supported_endpoints || []
        };
      }
      saveDiskState(state);
    },
    getRawState() {
      return state;
    }
  };
}

module.exports = {
  createPollinationsConfig,
  readEnvKey,
  maskKey,
  getUtcMonthKey,
  DEFAULT_IMAGE_MODELS
};
