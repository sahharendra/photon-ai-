'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RULES_VERSION,
  normalizeSettings,
  upsertPlan,
  togglePlanStatus,
  upsertTokenRule,
  toggleTokenRuleStatus,
  saveBulkSettings,
  getPublicPlans,
  resolveEffectivePlan,
  getEffectiveDailyLimit,
  reserveTokenSpend,
  commitTokenTransaction,
  refundTokenTransaction,
  verifyConfiguration,
} = require('../pricing-rules-service');
const { summarizeUsage } = require('../photon-usage');

const ROOT = path.join(__dirname, '..');
const FILES = ['server.js', 'anthropic-provider.js', 'openrouter-provider.js', 'openrouter-keys.js', 'gemini-keys.js', 'gemini-provider.js', 'openai-config.js', 'openai-provider.js', 'ollama-provider.js', 'codecraft-config.js', 'codecraft-provider.js', 'groq-config.js', 'groq-provider.js', 'nvidia-config.js', 'nvidia-provider.js', 'provider-fallback.js', 'provider-access-service.js', 'dashboard-analytics.js', 'photon-limits.js', 'photon-usage.js', 'photon-admin-users.js', 'photon-admin-subscriptions.js', 'pricing-rules-service.js', 'cashfree-service.js', 'razorpay-service.js', 'index.html', 'admin.html'];

describe('Pricing & Token Rules Service Unit Tests', () => {
  it('1: seeds initial v3 plans & AI activity token rules and migrates legacy v2 defaults cleanly', () => {
    const fresh = normalizeSettings(null);
    assert.equal(fresh.rulesVersion, RULES_VERSION);
    assert.deepEqual(fresh.plans.map(p => [p.id, p.name, p.price, p.dailyTokens]), [
      ['basic', 'Free', 0, 50],
      ['pro', 'Pro', 399, 200],
      ['premium', 'Premium', 1499, 2000],
    ]);
    assert.deepEqual(fresh.tokenCosts, { text: 1, image: 2, video: 5, code: 50, voice: 1 });

    // Legacy v2 store migrates Basic -> Free and code 100 -> 50 once
    const migrated = normalizeSettings({
      settingsVersion: 2,
      plans: [{ id: 'basic', name: 'Basic', price: 0, dailyTokens: 50 }],
      tokenCosts: { text: 1, voice: 1, image: 2, video: 5, code: 100 },
    });
    assert.equal(migrated.plans.find(p => p.id === 'basic').name, 'Free');
    assert.equal(migrated.tokenCosts.code, 50);

    // Already on rulesVersion 3 preserves admin-customized values
    const kept = normalizeSettings({
      settingsVersion: 2,
      rulesVersion: 3,
      plans: [{ id: 'basic', name: 'Starter', price: 0, dailyTokens: 75, billingPeriod: 'free', displayOrder: 1 }],
      tokenRules: [{ id: 'code', name: 'Code Gen', tokenCost: 85, enabled: true }],
    });
    assert.equal(kept.plans.find(p => p.id === 'basic').name, 'Starter');
    assert.equal(kept.plans.find(p => p.id === 'basic').dailyTokens, 75);
    assert.equal(kept.tokenCosts.code, 85);
  });

  it('2: creates, edits, validates, and toggles custom plans with audit logging', () => {
    const store = { settings: normalizeSettings(null) };
    const created = upsertPlan(store, {
      name: 'Studio',
      price: 799,
      billingPeriod: 'monthly',
      dailyTokens: 600,
      description: 'For independent creators',
      displayOrder: 2,
    }, { actor: 'admin@just4madam.com', isNew: true });

    assert.equal(created.id, 'studio');
    assert.equal(created.price, 799);
    assert.equal(getPublicPlans(store).map(p => p.id).join(','), 'basic,pro,studio,premium');

    // Validation rejections
    assert.throws(() => upsertPlan(store, { name: 'Bad Free', price: 99, billingPeriod: 'free', dailyTokens: 10 }, { isNew: true }), /Free plans must have a price of 0/);
    assert.throws(() => upsertPlan(store, { name: 'Free', price: 0, billingPeriod: 'free', dailyTokens: 10 }, { isNew: true }), /already named/);
    assert.throws(() => togglePlanStatus(store, 'basic', false), /cannot be disabled/);

    // Disable custom plan hides it from public catalog while preserving in store
    togglePlanStatus(store, 'studio', false, { actor: 'admin-1' });
    assert.equal(getPublicPlans(store).some(p => p.id === 'studio'), false);
    assert.equal(store.settings.plans.some(p => p.id === 'studio'), true);
    assert.ok(store.pricingAuditLogs.length >= 2);
  });

  it('3: manages AI activity token rules, custom rules, enable/disable, and audit trail', () => {
    const store = { settings: normalizeSettings(null) };
    upsertTokenRule(store, { name: 'Deep Research', id: 'deep_research', tokenCost: 15, enabled: true }, { actor: 'admin-a', isNew: true });
    assert.equal(store.settings.tokenCosts.deep_research, 15);

    saveBulkSettings(store, {
      plans: store.settings.plans,
      tokenRules: store.settings.tokenRules.map(r => {
        if (r.id === 'text') return { ...r, tokenCost: 2 };
        if (r.id === 'image') return { ...r, tokenCost: 10 };
        if (r.id === 'video') return { ...r, tokenCost: 20 };
        if (r.id === 'code') return { ...r, tokenCost: 100 };
        return r;
      }),
    }, { actor: 'admin-b' });

    assert.deepEqual(
      [store.settings.tokenCosts.text, store.settings.tokenCosts.image, store.settings.tokenCosts.video, store.settings.tokenCosts.code],
      [2, 10, 20, 100],
    );

    toggleTokenRuleStatus(store, 'image', false, { actor: 'admin-b' });
    const prof = { uid: 'u1', plan: 'pro', timezone: 'UTC' };
    assert.throws(
      () => reserveTokenSpend(store, { uid: 'u1', activityKey: 'image', requestId: 'req-img-1', profile: prof }),
      err => err.status === 403 && err.code === 'activity_disabled',
    );
  });

  it('4: enforces atomic token reservation, idempotent requestId, daily exhaustion, and failure refund', () => {
    const store = { settings: normalizeSettings(null), activities: { u1: [] }, tokenTransactions: [] };
    const profile = { uid: 'u1', plan: 'basic', timezone: 'UTC' };
    // Make code cost 30 so 1 fits in 50 daily tokens, 2nd exceeds 50
    upsertTokenRule(store, { id: 'code', name: 'Code Generation', tokenCost: 30, enabled: true });

    const r1 = reserveTokenSpend(store, { uid: 'u1', activityKey: 'code', requestId: 'req-code-1', profile });
    assert.equal(r1.transaction.tokensCharged, 30);
    assert.equal(r1.transaction.balanceBefore, 50);
    assert.equal(r1.transaction.balanceAfter, 20);

    // Same requestId is idempotent (no double-deduction)
    const r1Dup = reserveTokenSpend(store, { uid: 'u1', activityKey: 'code', requestId: 'req-code-1', profile });
    assert.equal(r1Dup.idempotent, true);
    assert.equal(r1Dup.transaction.id, r1.transaction.id);

    // Next distinct request requiring 30 fails with 429 daily_limit because 20 remaining < 30
    assert.throws(
      () => reserveTokenSpend(store, { uid: 'u1', activityKey: 'code', requestId: 'req-code-2', profile }),
      err => err.status === 429 && err.code === 'daily_limit',
    );

    // Provider fails -> refund restores full 50 balance
    refundTokenTransaction(store, r1.transaction.id, 'upstream_timeout');
    assert.equal(r1.transaction.status, 'refunded');
    const r2 = reserveTokenSpend(store, { uid: 'u1', activityKey: 'code', requestId: 'req-code-2', profile });
    commitTokenTransaction(store, r2.transaction.id, { provider: 'nvidia', model: 'llama' });
    assert.equal(r2.transaction.status, 'completed');
    assert.equal(summarizeUsage(store.activities.u1, 'UTC').used, 0);
  });

  it('5: respects allowancePolicy (immediate vs next_billing_period) without mutating historical invoices', () => {
    const store = { settings: normalizeSettings(null) };
    const futureExpiry = new Date(Date.now() + 15 * 86400_000).toISOString();
    const activePro = {
      uid: 'upro',
      plan: 'pro',
      subscription: { status: 'active', grantedDailyTokens: 200, nextRenewalDate: futureExpiry },
    };

    // Admin increases Pro daily allowance 200 -> 500 under immediate policy (requires verified payment!)
    activePro.subscription.paymentTaken = true;
    store.subscriptions = [{ uid: 'upro', plan: 'pro', paymentTaken: true, status: 'active', grantedDailyTokens: 200, nextRenewalDate: futureExpiry }];
    upsertPlan(store, { id: 'pro', name: 'Pro', price: 399, billingPeriod: 'monthly', dailyTokens: 500 });
    assert.equal(getEffectiveDailyLimit(activePro, store), 500);

    // Under next_billing_period policy, active subscriber retains locked 200 until nextRenewalDate
    saveBulkSettings(store, {
      plans: store.settings.plans,
      tokenRules: store.settings.tokenRules,
      allowancePolicy: 'next_billing_period',
    });
    assert.equal(getEffectiveDailyLimit(activePro, store), 200);

    // Legacy unverified demo selection resolves strictly to Free (basic) plan & gets Free plan's live dailyTokens!
    const demoUser = { uid: 'udemo', plan: 'premium', subscription: { status: 'demo', paymentTaken: false }, timezone: 'UTC' };
    upsertPlan(store, { id: 'basic', name: 'Free', price: 0, billingPeriod: 'free', dailyTokens: 100 });
    const resolvedDemo = resolveEffectivePlan(demoUser, store);
    assert.equal(resolvedDemo.planId, 'basic');
    assert.equal(getEffectiveDailyLimit(demoUser, store), 100);
  });

  it('6: enforces exact updated deductions (Text=3, Image=10, Video=25, Code=100), concurrent boundary isolation, and dry-run verifyConfiguration', () => {
    const store = {
      settings: normalizeSettings(null),
      activities: { uconc: [] },
      tokenTransactions: [],
    };
    const now = Date.now();
    // Set Free=150, Text=3, Image=10, Video=25, Code=100
    saveBulkSettings(store, {
      plans: store.settings.plans.map(p => (p.id === 'basic' ? { ...p, dailyTokens: 150 } : p)),
      tokenRules: store.settings.tokenRules.map(r => {
        if (r.id === 'text') return { ...r, tokenCost: 3 };
        if (r.id === 'image') return { ...r, tokenCost: 10 };
        if (r.id === 'video') return { ...r, tokenCost: 25 };
        if (r.id === 'code') return { ...r, tokenCost: 100 };
        return r;
      }),
    }, { actor: 'admin@just4madam.com' });

    const profile = { uid: 'uconc', plan: 'basic', timezone: 'UTC' };
    const rText = reserveTokenSpend(store, { uid: 'uconc', activityKey: 'chat', requestId: 'c1', profile, now });
    const rImg = reserveTokenSpend(store, { uid: 'uconc', activityKey: 'image', requestId: 'c2', profile, now });
    const rVid = reserveTokenSpend(store, { uid: 'uconc', activityKey: 'video', requestId: 'c3', profile, now });
    assert.equal(rText.transaction.tokensCharged, 3);
    assert.equal(rImg.transaction.tokensCharged, 10);
    assert.equal(rVid.transaction.tokensCharged, 25);

    // Concurrent total reserved = 3 + 10 + 25 = 38 of 150 -> 112 left, so Code(100) succeeds leaving 12!
    const rCode = reserveTokenSpend(store, { uid: 'uconc', activityKey: 'code', requestId: 'c4', profile, now });
    assert.equal(rCode.transaction.tokensCharged, 100);
    assert.equal(rCode.transaction.balanceAfter, 12);

    // Next concurrent Video(25) fails because only 12 remains across pending concurrent requests!
    assert.throws(
      () => reserveTokenSpend(store, { uid: 'uconc', activityKey: 'video', requestId: 'c5', profile, now }),
      err => err.status === 429 && err.code === 'daily_limit',
    );

    // Old day pending transaction must NOT block today's quota
    store.tokenTransactions.push({
      id: 'stale-tx',
      uid: 'uconc',
      status: 'pending',
      tokensCharged: 999,
      day: '2025-01-01',
    });
    const rImg2 = reserveTokenSpend(store, { uid: 'uconc', activityKey: 'image', requestId: 'c6', profile, now });
    assert.equal(rImg2.transaction.balanceAfter, 2);

    // verifyConfiguration returns synced dry-run values without modifying transactions or quota
    const txCountBefore = store.tokenTransactions.length;
    const report = verifyConfiguration({ store, savedOnDisk: { settings: store.settings } });
    assert.equal(report.status, 'synced');
    assert.equal(store.tokenTransactions.length, txCountBefore);
    const map = Object.fromEntries(report.testCalculations.map(t => [t.activityId, t.tokensPerRequest]));
    assert.deepEqual({ text: map.text, image: map.image, video: map.video, code: map.code }, { text: 3, image: 10, video: 25, code: 100 });
  });
});

describe('Pricing & Token Rules HTTP Integration Tests', () => {
  it('7: persists admin plan & token rule edits, passes /api/admin/pricing/verify, and propagates immediately to /api/profile/config', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-pricing-'));
    for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
    const port = 34581;
    const child = spawn(process.execPath, ['server.js'], {
      cwd: dir,
      env: { ...process.env, PORT: String(port), PHOTON_ADMIN_PASSWORD: 'pricing-admin-pass', NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server timeout: ' + out)), 8000);
      const iv = setInterval(() => { if (out.includes('PHOTON AI running')) { clearInterval(iv); clearTimeout(t); resolve(); } }, 50);
    });

    const authHeaders = {
      Authorization: 'Basic ' + Buffer.from('admin:pricing-admin-pass').toString('base64'),
      'Content-Type': 'application/json',
    };

    try {
      // Unauthenticated pricing create must fail 401
      const unauth = await fetch(`http://127.0.0.1:${port}/api/admin/pricing/plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hacked', price: 1, dailyTokens: 9999 }),
      });
      assert.equal(unauth.status, 401);

      // Admin adds custom plan + updates Free daily tokens to 100 & Text/Image/Video/Code rules
      const createPlan = await fetch(`http://127.0.0.1:${port}/api/admin/pricing/plans`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: 'Enterprise', price: 2999, billingPeriod: 'monthly', dailyTokens: 5000, displayOrder: 4 }),
      });
      assert.equal(createPlan.status, 201);

      const getSet = await fetch(`http://127.0.0.1:${port}/api/admin/settings`, { headers: authHeaders });
      const setJson = await getSet.json();
      const updatedPlans = setJson.data.plans.map(p => (p.id === 'basic' ? { ...p, dailyTokens: 100 } : p));
      const updatedRules = setJson.data.tokenRules.map(r => {
        if (r.id === 'text') return { ...r, tokenCost: 3 };
        if (r.id === 'image') return { ...r, tokenCost: 10 };
        if (r.id === 'video') return { ...r, tokenCost: 25 };
        if (r.id === 'code') return { ...r, tokenCost: 100 };
        return r;
      });
      const saveBulk = await fetch(`http://127.0.0.1:${port}/api/admin/settings`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ plans: updatedPlans, tokenRules: updatedRules }),
      });
      assert.equal(saveBulk.status, 200);

      // Configuration verification endpoint reports synced DB vs runtime & exact costs
      const verifyRes = await fetch(`http://127.0.0.1:${port}/api/admin/pricing/verify`, {
        method: 'POST',
        headers: authHeaders,
      });
      assert.equal(verifyRes.status, 200);
      const verifyJson = await verifyRes.json();
      assert.equal(verifyJson.data.status, 'synced');
      assert.equal(verifyJson.data.databaseSaved.plans.find(p => p.id === 'basic').dailyTokens, 100);
      assert.equal(verifyJson.data.activeBackend.tokenCosts.video, 25);

      // Public /api/profile/config immediately exposes new plan and updated rule costs
      const pubRes = await fetch(`http://127.0.0.1:${port}/api/profile/config`);
      assert.equal(pubRes.status, 200);
      const pubJson = await pubRes.json();
      assert.deepEqual(
        [pubJson.data.tokenCosts.text, pubJson.data.tokenCosts.image, pubJson.data.tokenCosts.video, pubJson.data.tokenCosts.code],
        [3, 10, 25, 100],
      );
      const basic = pubJson.data.plans.find(p => p.id === 'basic');
      const ent = pubJson.data.plans.find(p => p.id === 'enterprise');
      assert.equal(basic.dailyTokens, 100);
      assert.ok(ent && ent.dailyTokens === 5000 && ent.price === 2999);
    } finally {
      child.kill();
    }
  });
});
