'use strict';

const crypto = require('node:crypto');
const { SETTINGS_VERSION, PLAN_DAILY_LIMITS } = require('./photon-limits');
const { localDateKey, summarizeUsage } = require('./photon-usage');

const RULES_VERSION = 3;
const BILLING_PERIODS = Object.freeze(['free', 'monthly', 'yearly']);
const ALLOWANCE_POLICIES = Object.freeze(['immediate', 'next_billing_period']);

const ACTIVITY_ALIAS = Object.freeze({
  chat: 'text',
  text: 'text',
  voice: 'voice',
  image: 'image',
  video: 'video',
  code: 'code',
});

const DEFAULT_PLANS_V3 = Object.freeze([
  {
    id: 'basic',
    name: 'Free',
    price: 0,
    currency: 'INR',
    billingPeriod: 'free',
    interval: 'none',
    dailyTokens: PLAN_DAILY_LIMITS.basic,
    description: 'Perfect for trying Photon, casual chats and light creative work.',
    displayOrder: 1,
    enabled: true,
    builtIn: true,
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 399,
    currency: 'INR',
    billingPeriod: 'monthly',
    interval: 'month',
    dailyTokens: PLAN_DAILY_LIMITS.pro,
    description: 'More daily tokens for creators, students and professionals.',
    displayOrder: 2,
    enabled: true,
    builtIn: true,
  },
  {
    id: 'premium',
    name: 'Premium',
    price: 1499,
    currency: 'INR',
    billingPeriod: 'monthly',
    interval: 'month',
    dailyTokens: PLAN_DAILY_LIMITS.premium,
    description: 'Maximum daily tokens for heavy creators and developers.',
    displayOrder: 3,
    enabled: true,
    builtIn: true,
  },
]);

const DEFAULT_TOKEN_RULES_V3 = Object.freeze([
  {
    id: 'text',
    name: 'Text Generation',
    tokenCost: 1,
    chargeMode: 'flat',
    enabled: true,
    builtIn: true,
  },
  {
    id: 'image',
    name: 'Image Generation',
    tokenCost: 2,
    chargeMode: 'flat',
    enabled: true,
    builtIn: true,
  },
  {
    id: 'video',
    name: 'Video Generation',
    tokenCost: 5,
    chargeMode: 'flat',
    enabled: true,
    builtIn: true,
  },
  {
    id: 'code',
    name: 'Code Generation',
    tokenCost: 50,
    chargeMode: 'flat',
    enabled: true,
    builtIn: true,
  },
  {
    id: 'voice',
    name: 'Voice Generation',
    tokenCost: 1,
    chargeMode: 'flat',
    enabled: true,
    builtIn: true,
  },
]);

class PricingRuleError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function slugifyId(input, prefix = 'item') {
  const raw = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 32);
  return raw || `${prefix}_${crypto.randomBytes(3).toString('hex')}`;
}

function periodToLegacyInterval(billingPeriod) {
  if (billingPeriod === 'free') return 'none';
  if (billingPeriod === 'yearly') return 'year';
  return 'month';
}

function legacyIntervalToPeriod(interval, price) {
  const iv = String(interval || '').toLowerCase();
  if (iv === 'free' || iv === 'none' || Number(price) === 0) return 'free';
  if (iv === 'year' || iv === 'yearly') return 'yearly';
  return 'monthly';
}

function normalizePlanEntry(item, fallback, index, { migrateV3 = false } = {}) {
  const base = fallback || {
    id: slugifyId(item?.id || item?.name || `plan_${index + 1}`, 'plan'),
    name: 'Custom Plan',
    price: 0,
    currency: 'INR',
    billingPeriod: 'monthly',
    interval: 'month',
    dailyTokens: 100,
    description: '',
    displayOrder: index + 1,
    enabled: true,
    builtIn: false,
  };
  const id = String(item?.id || base.id).trim().toLowerCase();
  let rawName = String(item?.name ?? base.name).trim();
  if (migrateV3 && id === 'basic' && rawName === 'Basic') rawName = 'Free';
  const name = rawName.length >= 2 && rawName.length <= 40 ? rawName : base.name;

  const priceNum = Number(item?.price);
  const price = Number.isInteger(priceNum) && priceNum >= 0 && priceNum <= 10000000 ? priceNum : base.price;

  let billingPeriod = String(item?.billingPeriod || '').toLowerCase();
  if (!BILLING_PERIODS.includes(billingPeriod)) {
    billingPeriod = legacyIntervalToPeriod(item?.interval ?? base.billingPeriod, price);
  }
  if (id === 'basic' && price === 0) billingPeriod = 'free';
  if (price === 0 && billingPeriod !== 'free') billingPeriod = 'free';

  const dailyNum = Number(item?.dailyTokens);
  const dailyTokens = Number.isInteger(dailyNum) && dailyNum >= 1 && dailyNum <= 10000000 ? dailyNum : base.dailyTokens;

  const orderNum = Number(item?.displayOrder);
  const displayOrder = Number.isInteger(orderNum) && orderNum >= 1 && orderNum <= 999 ? orderNum : (base.displayOrder || index + 1);

  const description = String(item?.description ?? base.description ?? '').trim().slice(0, 240);
  const enabled = id === 'basic' ? true : item?.enabled !== false;

  return {
    id,
    name,
    price,
    currency: 'INR',
    billingPeriod,
    interval: periodToLegacyInterval(billingPeriod),
    dailyTokens,
    description,
    displayOrder,
    enabled,
    builtIn: Boolean(base.builtIn),
    ...(item?.updatedAt ? { updatedAt: String(item.updatedAt) } : {}),
    ...(item?.updatedBy ? { updatedBy: String(item.updatedBy) } : {}),
  };
}

function normalizeTokenRuleEntry(rawRule, fallback, { migrateV3 = false, nowIso } = {}) {
  const base = fallback || {
    id: slugifyId(rawRule?.id || rawRule?.name, 'activity'),
    name: String(rawRule?.name || rawRule?.id || 'Custom Activity').trim(),
    tokenCost: 1,
    chargeMode: 'flat',
    enabled: true,
    builtIn: false,
  };
  const id = String(rawRule?.id || base.id).trim().toLowerCase();
  let costNum = Number(rawRule?.tokenCost);
  if (migrateV3 && id === 'code' && costNum === 100) costNum = 50;
  const tokenCost = Number.isInteger(costNum) && costNum >= 1 && costNum <= 1000000 ? costNum : base.tokenCost;
  const nameRaw = String(rawRule?.name ?? base.name).trim();
  const name = nameRaw.length >= 2 && nameRaw.length <= 50 ? nameRaw : base.name;
  return {
    id,
    name,
    tokenCost,
    chargeMode: 'flat',
    enabled: rawRule?.enabled !== false,
    builtIn: Boolean(base.builtIn),
    updatedAt: rawRule?.updatedAt ? String(rawRule.updatedAt) : (nowIso || new Date().toISOString()),
    updatedBy: rawRule?.updatedBy ? String(rawRule.updatedBy) : 'system',
  };
}

function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const suppliedPlans = Array.isArray(input.plans) ? input.plans : [];
  const rulesVersion = Number(input.rulesVersion) || 0;
  const migrateDailyLimits = !Number.isInteger(Number(input.settingsVersion)) || Number(input.settingsVersion) < SETTINGS_VERSION;
  const migrateV3 = rulesVersion < RULES_VERSION;
  const nowIso = new Date().toISOString();

  const mergedPlans = [];
  const seenPlanIds = new Set();

  for (const base of DEFAULT_PLANS_V3) {
    const saved = suppliedPlans.find(item => item && String(item.id || '').toLowerCase() === base.id) || {};
    const effective = migrateDailyLimits ? { ...saved, dailyTokens: base.dailyTokens } : saved;
    const normalized = normalizePlanEntry(effective, base, mergedPlans.length, { migrateV3 });
    mergedPlans.push(normalized);
    seenPlanIds.add(normalized.id);
  }

  for (const extra of suppliedPlans) {
    if (!extra || typeof extra !== 'object') continue;
    const id = slugifyId(extra.id || extra.name, 'plan');
    if (seenPlanIds.has(id)) continue;
    seenPlanIds.add(id);
    mergedPlans.push(normalizePlanEntry({ ...extra, id }, null, mergedPlans.length, { migrateV3: false }));
  }

  mergedPlans.sort((a, b) => (a.displayOrder - b.displayOrder) || a.name.localeCompare(b.name));

  const legacyCosts = input.tokenCosts && typeof input.tokenCosts === 'object' ? input.tokenCosts : {};
  const suppliedRules = Array.isArray(input.tokenRules) ? input.tokenRules : [];
  const mergedRules = [];
  const seenRuleIds = new Set();

  for (const base of DEFAULT_TOKEN_RULES_V3) {
    const savedRule = suppliedRules.find(r => r && String(r.id || '').toLowerCase() === base.id);
    const legacyVal = legacyCosts[base.id];
    const source = savedRule || (legacyVal !== undefined ? { id: base.id, name: base.name, tokenCost: legacyVal } : { ...base });
    const normalized = normalizeTokenRuleEntry(source, base, { migrateV3, nowIso });
    mergedRules.push(normalized);
    seenRuleIds.add(normalized.id);
  }

  for (const extraRule of suppliedRules) {
    if (!extraRule || typeof extraRule !== 'object') continue;
    const id = slugifyId(extraRule.id || extraRule.name, 'activity');
    if (seenRuleIds.has(id)) continue;
    seenRuleIds.add(id);
    mergedRules.push(normalizeTokenRuleEntry({ ...extraRule, id }, null, { migrateV3: false, nowIso }));
  }

  const tokenCosts = {};
  for (const rule of mergedRules) tokenCosts[rule.id] = rule.tokenCost;

  const allowancePolicy = ALLOWANCE_POLICIES.includes(input.allowancePolicy)
    ? input.allowancePolicy
    : 'immediate';

  const razorpayRaw = (input.razorpay && typeof input.razorpay === 'object')
    ? input.razorpay
    : (input.cashfree && typeof input.cashfree === 'object') ? input.cashfree : {};
  const razorpay = {
    enabled: razorpayRaw.enabled !== false,
    mode: razorpayRaw.mode === 'live' || razorpayRaw.mode === 'production' ? 'live' : 'test',
    ...(razorpayRaw.lastConnectionCheck ? { lastConnectionCheck: razorpayRaw.lastConnectionCheck } : {}),
    ...(razorpayRaw.lastWebhookAt ? { lastWebhookAt: razorpayRaw.lastWebhookAt } : {}),
    ...(razorpayRaw.lastWebhookEvent ? { lastWebhookEvent: razorpayRaw.lastWebhookEvent } : {}),
  };

  const cashfreeRaw = (input.cashfree && typeof input.cashfree === 'object')
    ? input.cashfree
    : (input.razorpay && typeof input.razorpay === 'object') ? input.razorpay : {};
  const cashfree = {
    enabled: cashfreeRaw.enabled !== false,
    mode: cashfreeRaw.mode === 'production' ? 'production' : 'sandbox',
    ...(cashfreeRaw.lastConnectionCheck ? { lastConnectionCheck: cashfreeRaw.lastConnectionCheck } : {}),
    ...(cashfreeRaw.lastWebhookAt ? { lastWebhookAt: cashfreeRaw.lastWebhookAt } : {}),
    ...(cashfreeRaw.lastWebhookEvent ? { lastWebhookEvent: cashfreeRaw.lastWebhookEvent } : {}),
  };

  const activeGateway = input.activeGateway === 'cashfree' ? 'cashfree' : 'razorpay';

  const directUpiRaw = (input.directUpi && typeof input.directUpi === 'object') ? input.directUpi : {};
  const directUpi = {
    enabled: directUpiRaw.enabled !== false,
    upiId: String(directUpiRaw.upiId || '9773747095@yapl').trim(),
    payeeName: String(directUpiRaw.payeeName || 'Photon AI').trim(),
    qrImageUrl: '/upi-qr.jpg',
  };

  const privateModeRaw = (input.privateMode && typeof input.privateMode === 'object')
    ? input.privateMode
    : (input.maintenance && typeof input.maintenance === 'object') ? input.maintenance : {};
  const privateMode = {
    enabled: privateModeRaw.enabled !== undefined ? Boolean(privateModeRaw.enabled) : true,
    passcode: String(privateModeRaw.passcode || process.env.PHOTON_PRIVATE_PASSCODE || 'photon2026').trim(),
    message: String(privateModeRaw.message || 'Photon AI is currently in private preview & maintenance. Public access will reopen in a few days!').trim(),
  };

  return {
    plans: mergedPlans,
    tokenCosts,
    tokenRules: mergedRules,
    allowancePolicy,
    razorpay,
    cashfree,
    activeGateway,
    directUpi,
    privateMode,
    settingsVersion: SETTINGS_VERSION,
    rulesVersion: RULES_VERSION,
  };
}

function validatePlanPayload(input, existingPlans = [], { isNew = false, planId = null } = {}) {
  if (!input || typeof input !== 'object') throw new PricingRuleError(400, 'invalid_plan', 'Plan payload is required.');
  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 40) {
    throw new PricingRuleError(400, 'invalid_plan_name', 'Plan name must be 2–40 characters.');
  }

  const resolvedId = isNew
    ? slugifyId(input.id || name, 'plan')
    : String(planId || input.id || '').trim().toLowerCase();

  if (!/^[a-z0-9_-]{2,32}$/.test(resolvedId)) {
    throw new PricingRuleError(400, 'invalid_plan_id', 'Plan ID must be 2–32 lowercase letters, numbers, hyphens, or underscores.');
  }
  if (isNew && existingPlans.some(p => p.id === resolvedId)) {
    throw new PricingRuleError(409, 'duplicate_plan_id', `A plan with ID "${resolvedId}" already exists.`);
  }
  if (existingPlans.some(p => p.id !== resolvedId && p.name.toLowerCase() === name.toLowerCase())) {
    throw new PricingRuleError(409, 'duplicate_plan_name', `Another plan is already named "${name}".`);
  }

  const price = Number(input.price);
  if (!Number.isInteger(price) || price < 0 || price > 10000000) {
    throw new PricingRuleError(400, 'invalid_plan_price', 'Plan price must be an integer between 0 and 10,000,000 INR.');
  }

  let billingPeriod = String(input.billingPeriod || '').toLowerCase();
  if (!BILLING_PERIODS.includes(billingPeriod)) {
    billingPeriod = legacyIntervalToPeriod(input.interval, price);
  }
  if (billingPeriod === 'free' && price !== 0) {
    throw new PricingRuleError(400, 'invalid_billing_period', 'Free plans must have a price of 0 INR.');
  }
  if (billingPeriod !== 'free' && price <= 0) {
    throw new PricingRuleError(400, 'invalid_billing_period', 'Monthly and yearly plans must have a price greater than 0 INR.');
  }
  if (resolvedId === 'basic' && input.enabled === false) {
    throw new PricingRuleError(400, 'cannot_disable_free_plan', 'The default Free plan cannot be disabled.');
  }

  const dailyTokens = Number(input.dailyTokens);
  if (!Number.isInteger(dailyTokens) || dailyTokens < 1 || dailyTokens > 10000000) {
    throw new PricingRuleError(400, 'invalid_daily_tokens', 'Daily tokens must be an integer between 1 and 10,000,000.');
  }

  const displayOrder = input.displayOrder === undefined ? (existingPlans.find(p => p.id === resolvedId)?.displayOrder || existingPlans.length + 1) : Number(input.displayOrder);
  if (!Number.isInteger(displayOrder) || displayOrder < 1 || displayOrder > 999) {
    throw new PricingRuleError(400, 'invalid_display_order', 'Display order must be an integer between 1 and 999.');
  }

  const description = String(input.description ?? existingPlans.find(p => p.id === resolvedId)?.description ?? '').trim().slice(0, 240);
  const existing = existingPlans.find(p => p.id === resolvedId);

  return {
    id: resolvedId,
    name,
    price,
    currency: 'INR',
    billingPeriod,
    interval: periodToLegacyInterval(billingPeriod),
    dailyTokens,
    description,
    displayOrder,
    enabled: resolvedId === 'basic' ? true : input.enabled !== false,
    builtIn: Boolean(existing?.builtIn || ['basic', 'pro', 'premium'].includes(resolvedId)),
  };
}

function validateRulePayload(input, existingRules = [], { isNew = false, ruleId = null } = {}) {
  if (!input || typeof input !== 'object') throw new PricingRuleError(400, 'invalid_rule', 'Token rule payload is required.');
  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 50) {
    throw new PricingRuleError(400, 'invalid_rule_name', 'Activity name must be 2–50 characters.');
  }
  const resolvedId = isNew
    ? slugifyId(input.id || name, 'activity')
    : String(ruleId || input.id || '').trim().toLowerCase();

  if (!/^[a-z0-9_-]{2,32}$/.test(resolvedId)) {
    throw new PricingRuleError(400, 'invalid_rule_id', 'Activity identifier must be 2–32 lowercase letters, numbers, underscores, or hyphens.');
  }
  if (isNew && existingRules.some(r => r.id === resolvedId)) {
    throw new PricingRuleError(409, 'duplicate_rule_id', `Activity rule "${resolvedId}" already exists.`);
  }
  const tokenCost = Number(input.tokenCost);
  if (!Number.isInteger(tokenCost) || tokenCost < 1 || tokenCost > 1000000) {
    throw new PricingRuleError(400, 'invalid_token_cost', 'Activity token cost must be an integer from 1 to 1,000,000 tokens.');
  }
  const existing = existingRules.find(r => r.id === resolvedId);
  return {
    id: resolvedId,
    name,
    tokenCost,
    chargeMode: 'flat',
    enabled: input.enabled !== false,
    builtIn: Boolean(existing?.builtIn || DEFAULT_TOKEN_RULES_V3.some(r => r.id === resolvedId)),
  };
}

function appendPricingAuditLog(store, { actor, action, targetType, targetId, before, after }) {
  store.pricingAuditLogs ||= [];
  store.pricingAuditLogs.unshift({
    id: crypto.randomUUID(),
    actor: String(actor || 'admin'),
    action: String(action || 'update'),
    targetType: String(targetType || 'settings'),
    targetId: String(targetId || ''),
    before: before ?? null,
    after: after ?? null,
    at: new Date().toISOString(),
  });
  store.pricingAuditLogs = store.pricingAuditLogs.slice(0, 500);
}

function syncDerivedTokenCosts(settings) {
  const tokenCosts = {};
  for (const r of settings.tokenRules || []) tokenCosts[r.id] = r.tokenCost;
  settings.tokenCosts = tokenCosts;
  settings.plans.sort((a, b) => (a.displayOrder - b.displayOrder) || a.name.localeCompare(b.name));
  settings.rulesVersion = RULES_VERSION;
}

function upsertPlan(store, input, { actor = 'admin', isNew = false, planId = null } = {}) {
  store.settings = normalizeSettings(store.settings);
  const validated = validatePlanPayload(input, store.settings.plans, { isNew, planId });
  const nowIso = new Date().toISOString();
  const idx = store.settings.plans.findIndex(p => p.id === validated.id);
  const before = idx >= 0 ? { ...store.settings.plans[idx] } : null;
  const saved = { ...validated, updatedAt: nowIso, updatedBy: String(actor || 'admin') };

  if (idx >= 0) store.settings.plans[idx] = saved;
  else store.settings.plans.push(saved);

  syncDerivedTokenCosts(store.settings);
  appendPricingAuditLog(store, {
    actor,
    action: idx >= 0 ? 'plan_updated' : 'plan_created',
    targetType: 'plan',
    targetId: saved.id,
    before,
    after: saved,
  });
  return saved;
}

function togglePlanStatus(store, planId, enabled, { actor = 'admin' } = {}) {
  store.settings = normalizeSettings(store.settings);
  const id = String(planId || '').trim().toLowerCase();
  const idx = store.settings.plans.findIndex(p => p.id === id);
  if (idx < 0) throw new PricingRuleError(404, 'plan_not_found', 'Plan not found.');
  if (id === 'basic' && !enabled) throw new PricingRuleError(400, 'cannot_disable_free_plan', 'The default Free plan cannot be disabled.');
  const before = { ...store.settings.plans[idx] };
  store.settings.plans[idx] = {
    ...before,
    enabled: Boolean(enabled),
    updatedAt: new Date().toISOString(),
    updatedBy: String(actor || 'admin'),
  };
  appendPricingAuditLog(store, {
    actor,
    action: enabled ? 'plan_enabled' : 'plan_disabled',
    targetType: 'plan',
    targetId: id,
    before,
    after: store.settings.plans[idx],
  });
  return store.settings.plans[idx];
}

function upsertTokenRule(store, input, { actor = 'admin', isNew = false, ruleId = null } = {}) {
  store.settings = normalizeSettings(store.settings);
  const validated = validateRulePayload(input, store.settings.tokenRules, { isNew, ruleId });
  const nowIso = new Date().toISOString();
  const idx = store.settings.tokenRules.findIndex(r => r.id === validated.id);
  const before = idx >= 0 ? { ...store.settings.tokenRules[idx] } : null;
  const saved = { ...validated, updatedAt: nowIso, updatedBy: String(actor || 'admin') };

  if (idx >= 0) store.settings.tokenRules[idx] = saved;
  else store.settings.tokenRules.push(saved);

  syncDerivedTokenCosts(store.settings);
  appendPricingAuditLog(store, {
    actor,
    action: idx >= 0 ? 'token_rule_updated' : 'token_rule_created',
    targetType: 'token_rule',
    targetId: saved.id,
    before,
    after: saved,
  });
  return saved;
}

function toggleTokenRuleStatus(store, ruleId, enabled, { actor = 'admin' } = {}) {
  store.settings = normalizeSettings(store.settings);
  const id = String(ruleId || '').trim().toLowerCase();
  const idx = store.settings.tokenRules.findIndex(r => r.id === id);
  if (idx < 0) throw new PricingRuleError(404, 'rule_not_found', 'Activity rule not found.');
  const before = { ...store.settings.tokenRules[idx] };
  store.settings.tokenRules[idx] = {
    ...before,
    enabled: Boolean(enabled),
    updatedAt: new Date().toISOString(),
    updatedBy: String(actor || 'admin'),
  };
  syncDerivedTokenCosts(store.settings);
  appendPricingAuditLog(store, {
    actor,
    action: enabled ? 'token_rule_enabled' : 'token_rule_disabled',
    targetType: 'token_rule',
    targetId: id,
    before,
    after: store.settings.tokenRules[idx],
  });
  return store.settings.tokenRules[idx];
}

function saveBulkSettings(store, body, { actor = 'admin' } = {}) {
  const current = normalizeSettings(store.settings);
  const submittedPlans = body?.plans;
  const submittedRules = body?.tokenRules;
  const submittedCosts = body?.tokenCosts;

  if (!Array.isArray(submittedPlans) || (!Array.isArray(submittedRules) && (!submittedCosts || typeof submittedCosts !== 'object'))) {
    throw new PricingRuleError(400, 'invalid_settings', 'Plan definitions and token rules/costs are required.');
  }

  const nextPlans = [];
  const seenIds = new Set();
  for (const item of submittedPlans) {
    if (!item || typeof item !== 'object') throw new PricingRuleError(400, 'invalid_settings', 'Each plan entry must be an object.');
    const existing = current.plans.find(p => p.id === String(item.id || '').toLowerCase());
    const validated = validatePlanPayload({
      description: existing?.description || '',
      displayOrder: existing?.displayOrder || nextPlans.length + 1,
      billingPeriod: existing?.billingPeriod,
      enabled: existing ? existing.enabled : true,
      ...item,
    }, nextPlans, { isNew: false, planId: item.id });
    if (seenIds.has(validated.id)) throw new PricingRuleError(400, 'duplicate_plan_id', `Duplicate plan "${validated.id}".`);
    seenIds.add(validated.id);
    nextPlans.push({ ...validated, updatedAt: new Date().toISOString(), updatedBy: String(actor || 'admin') });
  }
  if (!nextPlans.some(p => p.id === 'basic')) {
    throw new PricingRuleError(400, 'invalid_settings', 'The Free (basic) plan must be included.');
  }

  const nextRules = [];
  const seenRuleIds = new Set();
  if (Array.isArray(submittedRules)) {
    for (const r of submittedRules) {
      const existing = current.tokenRules.find(x => x.id === String(r?.id || '').toLowerCase());
      const validated = validateRulePayload({
        name: existing?.name || r?.id,
        enabled: existing ? existing.enabled : true,
        ...r,
      }, nextRules, { isNew: false, ruleId: r?.id });
      if (seenRuleIds.has(validated.id)) throw new PricingRuleError(400, 'duplicate_rule_id', `Duplicate activity rule "${validated.id}".`);
      seenRuleIds.add(validated.id);
      nextRules.push({ ...validated, updatedAt: new Date().toISOString(), updatedBy: String(actor || 'admin') });
    }
  } else {
    for (const existing of current.tokenRules) {
      const rawVal = submittedCosts[existing.id];
      const val = rawVal === undefined ? existing.tokenCost : Number(rawVal);
      if (!Number.isInteger(val) || val < 1 || val > 1000000) {
        throw new PricingRuleError(400, 'invalid_settings', 'Activity costs must be integers from 1 to 1,000,000 tokens.');
      }
      nextRules.push({
        ...existing,
        tokenCost: val,
        updatedAt: new Date().toISOString(),
        updatedBy: String(actor || 'admin'),
      });
    }
  }

  const allowancePolicy = body?.allowancePolicy !== undefined
    ? (ALLOWANCE_POLICIES.includes(body.allowancePolicy) ? body.allowancePolicy : (() => { throw new PricingRuleError(400, 'invalid_allowance_policy', 'Allowance policy must be immediate or next_billing_period.'); })())
    : current.allowancePolicy;

  const nextSettings = {
    ...current,
    plans: nextPlans,
    tokenRules: nextRules,
    allowancePolicy,
    settingsVersion: SETTINGS_VERSION,
    rulesVersion: RULES_VERSION,
  };
  syncDerivedTokenCosts(nextSettings);

  appendPricingAuditLog(store, {
    actor,
    action: 'bulk_settings_updated',
    targetType: 'settings',
    targetId: 'pricing_and_tokens',
    before: { plans: current.plans, tokenCosts: current.tokenCosts, allowancePolicy: current.allowancePolicy },
    after: { plans: nextSettings.plans, tokenCosts: nextSettings.tokenCosts, allowancePolicy: nextSettings.allowancePolicy },
  });

  store.settings = nextSettings;
  return nextSettings;
}

function getPublicPlans(store, { includePlanId = null } = {}) {
  const settings = normalizeSettings(store?.settings);
  return settings.plans.filter(p => p.enabled || (includePlanId && p.id === includePlanId));
}

function resolveEffectivePlan(profile, store, now = Date.now()) {
  const settings = normalizeSettings(store?.settings);
  const freePlan = settings.plans.find(p => p.id === 'basic') || settings.plans[0];
  if (!profile || typeof profile !== 'object') {
    return { planId: freePlan.id, plan: freePlan, isVerifiedPaid: false, subscription: null };
  }

  const uid = profile.uid;
  const subs = Array.isArray(store?.subscriptions) && uid
    ? store.subscriptions.filter(s => s && s.uid === uid)
    : [];
  const profileSub = profile.subscription && typeof profile.subscription === 'object' ? profile.subscription : null;

  const isVerifiedSubActive = s => {
    if (!s || s.paymentTaken !== true) return false;
    if (String(s.billingStatus || '').toLowerCase() === 'demo') return false;
    const st = String(s.status || '').toLowerCase();
    if (!['active', 'paid', 'trialing'].includes(st)) return false;
    const expMs = s.expiryDate ? Date.parse(s.expiryDate) : NaN;
    if (Number.isFinite(expMs) && expMs <= now) return false;
    return true;
  };

  const verifiedSub = subs.find(isVerifiedSubActive) || (isVerifiedSubActive(profileSub) ? profileSub : null);
  if (verifiedSub) {
    const matched = settings.plans.find(p => p.id === verifiedSub.plan) || freePlan;
    return {
      planId: matched.id,
      plan: matched,
      isVerifiedPaid: matched.id !== freePlan.id,
      subscription: verifiedSub,
    };
  }

  // Never grant a paid tier from an unverified demo selection or full refund
  if (profileSub && (profileSub.status === 'demo' || profileSub.status === 'refunded' || profileSub.paymentTaken === false)) {
    return { planId: freePlan.id, plan: freePlan, isVerifiedPaid: false, subscription: profileSub };
  }

  const rawId = String(profile.plan || freePlan.id).trim().toLowerCase();
  const explicitPlan = settings.plans.find(p => p.id === rawId) || freePlan;
  return {
    planId: explicitPlan.id,
    plan: explicitPlan,
    isVerifiedPaid: explicitPlan.id !== freePlan.id,
    subscription: profileSub,
  };
}

function getEffectiveDailyLimit(profile, store, now = Date.now()) {
  const settings = normalizeSettings(store?.settings);
  const resolved = resolveEffectivePlan(profile, store, now);
  if (settings.allowancePolicy === 'next_billing_period' && resolved.isVerifiedPaid && resolved.subscription) {
    const granted = Number(resolved.subscription.grantedDailyTokens);
    const nextRenewal = Date.parse(resolved.subscription.nextRenewalDate || resolved.subscription.expiryDate || '');
    if (Number.isInteger(granted) && granted > 0 && Number.isFinite(nextRenewal) && nextRenewal > now) {
      return granted;
    }
  }
  return resolved.plan.dailyTokens;
}

function resolveActivityRule(store, activityKey) {
  const settings = normalizeSettings(store?.settings);
  const rawKey = String(activityKey || 'text').trim().toLowerCase();
  const mappedId = ACTIVITY_ALIAS[rawKey] || rawKey;
  const rule = settings.tokenRules.find(r => r.id === mappedId) || settings.tokenRules.find(r => r.id === 'text');
  return rule;
}

function reservedTokensToday(store, uid, timezone, now = Date.now()) {
  const txList = Array.isArray(store?.tokenTransactions) ? store.tokenTransactions : [];
  if (!txList.length) return 0;
  const nowDay = localDateKey(now, timezone);
  return txList
    .filter(tx => tx && tx.uid === uid && tx.status === 'pending' && tx.day === nowDay)
    .reduce((sum, tx) => sum + (Number(tx.tokensCharged) || 0), 0);
}

function reserveTokenSpend(store, { uid, activityKey, requestId, profile, provider = '', model = '', now = Date.now() }) {
  store.settings = normalizeSettings(store.settings);
  store.tokenTransactions ||= [];
  store.activities ||= {};
  const rule = resolveActivityRule(store, activityKey);
  if (!rule) throw new PricingRuleError(400, 'unknown_activity', 'Unknown AI activity rule.');
  if (!rule.enabled) {
    throw new PricingRuleError(403, 'activity_disabled', `${rule.name} is currently disabled by the administrator.`);
  }

  const reqKey = requestId ? String(requestId).trim() : '';
  if (reqKey) {
    const existing = store.tokenTransactions.find(tx => tx.uid === uid && tx.requestId === reqKey);
    if (existing && (existing.status === 'completed' || existing.status === 'pending')) {
      return { idempotent: true, transaction: existing, rule };
    }
  }

  const timezone = profile?.timezone || 'Asia/Kolkata';
  const todayKey = localDateKey(now, timezone);
  const summary = summarizeUsage(store.activities[uid] || [], timezone, now);
  const pending = reservedTokensToday(store, uid, timezone, now);
  const limit = getEffectiveDailyLimit(profile, store, now);
  const cost = Number(rule.tokenCost);
  const balanceBefore = Math.max(0, limit - summary.used - pending);

  if (summary.used + pending + cost > limit) {
    throw new PricingRuleError(429, 'daily_limit', `Insufficient daily tokens for ${rule.name} (requires ${cost}, ${balanceBefore} remaining of ${limit}).`);
  }

  const tx = {
    id: crypto.randomUUID(),
    uid,
    requestId: reqKey || null,
    activityId: rule.id,
    activityName: rule.name,
    status: 'pending',
    tokensCharged: cost,
    balanceBefore,
    balanceAfter: Math.max(0, balanceBefore - cost),
    dailyLimit: limit,
    day: todayKey,
    provider: String(provider || ''),
    model: String(model || ''),
    createdAt: new Date(now).toISOString(),
  };

  store.tokenTransactions.unshift(tx);
  store.tokenTransactions = store.tokenTransactions.slice(0, 5000);
  return { idempotent: false, transaction: tx, rule };
}

function commitTokenTransaction(store, txId, meta = {}) {
  if (!txId || !Array.isArray(store?.tokenTransactions)) return null;
  const tx = store.tokenTransactions.find(item => item.id === txId);
  if (!tx) return null;
  tx.status = 'completed';
  if (meta.provider) tx.provider = String(meta.provider);
  if (meta.model) tx.model = String(meta.model);
  tx.completedAt = new Date().toISOString();
  return tx;
}

function refundTokenTransaction(store, txId, reason = 'upstream_failure') {
  if (!txId || !Array.isArray(store?.tokenTransactions)) return null;
  const tx = store.tokenTransactions.find(item => item.id === txId);
  if (!tx || tx.status === 'refunded') return tx || null;
  tx.status = 'refunded';
  tx.refundReason = String(reason || 'upstream_failure').slice(0, 120);
  tx.refundedAt = new Date().toISOString();
  return tx;
}

function verifyConfiguration({ store, savedOnDisk = null }) {
  const activeSettings = normalizeSettings(store?.settings);
  const dbSettings = savedOnDisk ? normalizeSettings(savedOnDisk.settings) : activeSettings;
  const inSync = JSON.stringify({ plans: activeSettings.plans, tokenRules: activeSettings.tokenRules, allowancePolicy: activeSettings.allowancePolicy }) ===
    JSON.stringify({ plans: dbSettings.plans, tokenRules: dbSettings.tokenRules, allowancePolicy: dbSettings.allowancePolicy });

  const updatedTimestamps = [
    ...activeSettings.plans.map(p => p.updatedAt).filter(Boolean),
    ...activeSettings.tokenRules.map(r => r.updatedAt).filter(Boolean),
  ].sort((a, b) => Date.parse(b) - Date.parse(a));

  const activityKeys = activeSettings.tokenRules.map(r => r.id);
  const testCalculations = activityKeys.map(key => {
    const rule = resolveActivityRule(store, key);
    return {
      activityId: rule.id,
      activityName: rule.name,
      enabled: rule.enabled,
      tokensPerRequest: rule.tokenCost,
      simulatedDeductionOnly: true,
    };
  });

  return {
    status: inSync ? 'synced' : 'drift',
    lastUpdatedAt: updatedTimestamps[0] || null,
    allowancePolicy: activeSettings.allowancePolicy,
    databaseSaved: {
      plans: dbSettings.plans.map(p => ({ id: p.id, name: p.name, price: p.price, dailyTokens: p.dailyTokens, billingPeriod: p.billingPeriod, enabled: p.enabled })),
      tokenCosts: dbSettings.tokenCosts,
    },
    activeBackend: {
      plans: activeSettings.plans.map(p => ({ id: p.id, name: p.name, price: p.price, dailyTokens: p.dailyTokens, billingPeriod: p.billingPeriod, enabled: p.enabled })),
      tokenCosts: activeSettings.tokenCosts,
    },
    testCalculations,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  RULES_VERSION,
  BILLING_PERIODS,
  ALLOWANCE_POLICIES,
  DEFAULT_PLANS_V3,
  DEFAULT_TOKEN_RULES_V3,
  PricingRuleError,
  slugifyId,
  normalizeSettings,
  validatePlanPayload,
  validateRulePayload,
  upsertPlan,
  togglePlanStatus,
  upsertTokenRule,
  toggleTokenRuleStatus,
  saveBulkSettings,
  getPublicPlans,
  resolveEffectivePlan,
  getEffectiveDailyLimit,
  resolveActivityRule,
  reserveTokenSpend,
  commitTokenTransaction,
  refundTokenTransaction,
  verifyConfiguration,
  appendPricingAuditLog,
};
