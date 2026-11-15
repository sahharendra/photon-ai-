'use strict';
// Admin Users & Sign-ins Management tests covering all 15 required scenarios.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const {
  ensureStoreSchema,
  buildStoreIndexes,
  recordLoginEvent,
  recordPresenceHeartbeat,
  closeActiveSession,
  recordFailedLogin,
  isUserOnline,
  recordTokenUsage,
  queryAdminUsers,
  getAdminUserDetails,
  generateExportPayload,
} = require('../photon-admin-users');

const PLANS = [
  { id: 'basic', name: 'Free', price: 0, dailyTokens: 50 },
  { id: 'pro', name: 'Pro', price: 399, dailyTokens: 200 },
  { id: 'premium', name: 'Premium', price: 1499, dailyTokens: 2000 },
];

describe('photon-admin-users unit suite', () => {
  it('1-3: detects Google, Gmail/Password, and other OAuth methods accurately without guessing from @gmail.com', () => {
    const store = { profiles: {}, activities: {}, subscriptions: [] };
    ensureStoreSchema(store);
    const now = Date.parse('2026-11-11T10:00:00Z');

    // Scenario 1 & 2: New user registered via Google
    const pGoogle = { uid: 'uid-google-1', email: 'alice@gmail.com', fullName: 'Alice', username: 'alice', timezone: 'UTC', plan: 'basic', joinedAt: '2026-11-10T08:00:00Z' };
    store.profiles[pGoogle.uid] = pGoogle;
    recordLoginEvent({ store, profile: pGoogle, claims: { auth_time: Math.floor(now / 1000), firebase: { sign_in_provider: 'google.com' } }, req: { headers: { 'user-agent': 'Chrome/125 Windows' }, socket: { remoteAddress: '203.0.113.10' } }, photoURL: 'https://example.com/alice.jpg', now });

    // Scenario 3: @gmail.com email created with Email/Password -> Gmail (NOT Google!)
    const pEmail = { uid: 'uid-email-1', email: 'bob@gmail.com', fullName: 'Bob', username: 'bob', timezone: 'UTC', plan: 'basic', joinedAt: '2026-11-11T08:00:00Z' };
    store.profiles[pEmail.uid] = pEmail;
    recordLoginEvent({ store, profile: pEmail, claims: { auth_time: Math.floor(now / 1000), firebase: { sign_in_provider: 'password' } }, now });

    // Other OAuth provider + subsequent Google login (tracks primary creation vs recent)
    const pGithub = { uid: 'uid-gh-1', email: 'carol@dev.io', fullName: 'Carol', username: 'carol', timezone: 'UTC', plan: 'basic', joinedAt: '2026-11-09T08:00:00Z' };
    store.profiles[pGithub.uid] = pGithub;
    recordLoginEvent({ store, profile: pGithub, claims: { auth_time: Math.floor((now - 3600_000) / 1000), firebase: { sign_in_provider: 'github.com' } }, now: now - 3600_000 });
    recordLoginEvent({ store, profile: pGithub, claims: { auth_time: Math.floor(now / 1000), firebase: { sign_in_provider: 'google.com' } }, now });

    const indexes = buildStoreIndexes(store);
    const res = queryAdminUsers({ store, indexes, plans: PLANS, now });
    const byUid = Object.fromEntries(res.items.map(u => [u.uid, u]));

    assert.equal(byUid['uid-google-1'].signInMethod, 'Google');
    assert.equal(byUid['uid-google-1'].photoURL, 'https://example.com/alice.jpg');
    assert.equal(byUid['uid-email-1'].signInMethod, 'Gmail / Password');
    assert.equal(byUid['uid-github'] || byUid['uid-gh-1'].primarySignInMethod, 'GitHub');
    assert.equal(byUid['uid-gh-1'].signInMethod, 'Google');
    assert.deepEqual(byUid['uid-gh-1'].authMethods, ['GitHub', 'Google']);
  });

  it('4-5: counts multiple verified logins, ignores duplicate refreshes & failed attempts', () => {
    const store = { profiles: {}, activities: {}, subscriptions: [] };
    ensureStoreSchema(store);
    const t0 = Date.parse('2026-11-11T10:00:00Z');
    const prof = { uid: 'u1', email: 'u1@example.com', fullName: 'User One', timezone: 'UTC', plan: 'basic', joinedAt: '2026-11-01T00:00:00Z' };
    store.profiles.u1 = prof;

    // 1st login
    recordLoginEvent({ store, profile: prof, claims: { auth_time: Math.floor(t0 / 1000), firebase: { sign_in_provider: 'password' } }, now: t0 });
    // Page refresh (same auth_time) -> should NOT increment signInCount
    recordLoginEvent({ store, profile: prof, claims: { auth_time: Math.floor(t0 / 1000), firebase: { sign_in_provider: 'password' } }, now: t0 + 60_000 });
    assert.equal(prof.signInCount, 1);

    // Failed login attempt -> recorded in history as failed, does NOT increment signInCount
    const idx0 = buildStoreIndexes(store);
    recordFailedLogin({ store, indexes: idx0, email: 'u1@example.com', provider: 'password', reason: 'auth/wrong-password', now: t0 + 90_000 });
    assert.equal(prof.signInCount, 1);

    // 2nd distinct login
    const t1 = t0 + 180_000;
    recordLoginEvent({ store, profile: prof, claims: { auth_time: Math.floor(t1 / 1000), firebase: { sign_in_provider: 'google.com' } }, now: t1 });
    assert.equal(prof.signInCount, 2);

    const indexes = buildStoreIndexes(store);
    const details = getAdminUserDetails({ store, indexes, plans: PLANS, uid: 'u1', now: t1 });
    assert.equal(details.user.signInCount, 2);
    assert.equal(details.logins.filter(l => l.status === 'failed').length, 1);
    assert.equal(details.logins.filter(l => l.status === 'success').length, 2);
  });

  it('6-7: transitions online/offline on configurable heartbeat timeout, session expiry, and logout', () => {
    const store = { profiles: {}, activities: {}, subscriptions: [] };
    ensureStoreSchema(store);
    const t0 = Date.parse('2026-11-11T10:00:00Z');
    const prof = { uid: 'u2', email: 'u2@example.com', fullName: 'Online User', timezone: 'UTC', plan: 'basic', joinedAt: '2026-11-10T00:00:00Z' };
    store.profiles.u2 = prof;

    recordLoginEvent({ store, profile: prof, claims: { auth_time: Math.floor(t0 / 1000), firebase: { sign_in_provider: 'google.com' } }, sessionTtlMs: 3600_000, now: t0 });
    assert.equal(isUserOnline(prof, t0 + 60_000, 300_000), true, 'online within 5m timeout');
    assert.equal(isUserOnline(prof, t0 + 301_000, 300_000), false, 'offline after 5m without heartbeat');

    // Heartbeat refreshes online status
    recordPresenceHeartbeat({ store, profile: prof, claims: { auth_time: Math.floor(t0 / 1000), firebase: { sign_in_provider: 'google.com' } }, now: t0 + 301_000 });
    assert.equal(isUserOnline(prof, t0 + 305_000, 300_000), true, 'back online after heartbeat');

    // Explicit sign-out immediately sets offline
    closeActiveSession({ store, profile: prof, now: t0 + 310_000 });
    assert.equal(isUserOnline(prof, t0 + 311_000, 300_000), false, 'offline immediately after sign-out');

    // Session expiry sets offline
    recordLoginEvent({ store, profile: prof, claims: { auth_time: Math.floor((t0 + 400_000) / 1000), firebase: { sign_in_provider: 'google.com' } }, sessionTtlMs: 60_000, now: t0 + 400_000 });
    assert.equal(isUserOnline(prof, t0 + 465_000, 300_000), false, 'offline when session expires');
  });

  it('8-10: distinguishes verified paid Pro/Premium plans from Free and unverified Demo selections', () => {
    const store = { profiles: {}, activities: {}, subscriptions: [] };
    ensureStoreSchema(store);

    store.profiles.freeU = { uid: 'freeU', email: 'free@example.com', fullName: 'Free User', plan: 'basic', joinedAt: '2026-11-11T00:00:00Z' };
    store.profiles.demoU = {
      uid: 'demoU', email: 'demo@example.com', fullName: 'Demo Pro User', plan: 'pro',
      subscription: { status: 'demo', plan: 'pro', interval: 'monthly', paymentTaken: false, selectedAt: '2026-11-11T01:00:00Z' },
      joinedAt: '2026-11-11T00:00:00Z',
    };
    store.subscriptions.push({ id: 'sub-demo', uid: 'demoU', plan: 'pro', status: 'demo', billingStatus: 'demo', paymentTaken: false, interval: 'monthly', basePrice: 399, selectedAt: '2026-11-11T01:00:00Z' });

    store.profiles.paidPro = { uid: 'paidPro', email: 'pro@example.com', fullName: 'Paid Pro', plan: 'pro', joinedAt: '2026-11-10T00:00:00Z' };
    store.subscriptions.push({ id: 'sub-pro', uid: 'paidPro', plan: 'pro', status: 'active', billingStatus: 'paid', paymentTaken: true, interval: 'monthly', basePrice: 399, purchaseDate: '2026-11-10T01:00:00Z', expiryDate: '2026-12-10T01:00:00Z' });

    store.profiles.paidPrem = { uid: 'paidPrem', email: 'prem@example.com', fullName: 'Paid Premium', plan: 'premium', joinedAt: '2026-11-09T00:00:00Z' };
    store.subscriptions.push({ id: 'sub-prem', uid: 'paidPrem', plan: 'premium', status: 'active', billingStatus: 'paid', paymentTaken: true, interval: 'monthly', basePrice: 1499, purchaseDate: '2026-11-09T01:00:00Z', nextRenewalDate: '2026-12-09T01:00:00Z' });

    const indexes = buildStoreIndexes(store);
    const res = queryAdminUsers({ store, indexes, plans: PLANS });
    assert.equal(res.kpis.activePaidSubscribers, 2);
    assert.equal(res.kpis.freePlanUsers, 2, 'demo selection without verified payment counts as Free');
    const demoRow = res.items.find(u => u.uid === 'demoU');
    assert.equal(demoRow.planName, 'Free');
    assert.equal(demoRow.subscription.isDemoSelection, true);
    assert.equal(res.items.find(u => u.uid === 'paidPro').planName, 'Pro');
    assert.equal(res.items.find(u => u.uid === 'paidPrem').planName, 'Premium');
  });

  it('11-12: computes daily, monthly, lifetime, multi-provider, and actual vs estimated token math accurately', () => {
    const store = { profiles: {}, activities: {}, subscriptions: [] };
    store.profiles.tuser = { uid: 'tuser', email: 'tok@example.com', fullName: 'Token User', timezone: 'UTC', plan: 'basic', joinedAt: '2026-09-01T00:00:00Z' };
    const now = Date.parse('2026-11-11T15:00:00Z');

    // Today (actual NVIDIA)
    recordTokenUsage({ store, uid: 'tuser', provider: 'nvidia', model: 'nemotron', providerTokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, at: '2026-11-11T10:00:00Z' });
    // Today (estimated Groq because provider returned 0)
    recordTokenUsage({ store, uid: 'tuser', provider: 'groq', model: 'allam-2-7b', fallbackInputChars: 40, fallbackOutputChars: 80, at: '2026-11-11T12:00:00Z' });
    // Earlier this month (actual OpenRouter)
    recordTokenUsage({ store, uid: 'tuser', provider: 'openrouter', model: 'free-m', providerTokens: { inputTokens: 200, outputTokens: 100 }, at: '2026-11-02T10:00:00Z' });
    // Prior month (actual NVIDIA)
    recordTokenUsage({ store, uid: 'tuser', provider: 'nvidia', model: 'nemotron', providerTokens: { inputTokens: 500, outputTokens: 200 }, at: '2026-10-15T10:00:00Z' });

    const indexes = buildStoreIndexes(store);
    const details = getAdminUserDetails({ store, indexes, plans: PLANS, uid: 'tuser', now });
    const ts = details.user.tokenStats;

    assert.equal(ts.daily.input, 110);
    assert.equal(ts.daily.output, 70);
    assert.equal(ts.daily.total, 180);
    assert.equal(ts.daily.actualTotal, 150);
    assert.equal(ts.daily.estimatedTotal, 30);

    assert.equal(ts.monthly.total, 480);
    assert.equal(ts.lifetime.total, 1180);
    assert.equal(ts.byProvider.nvidia.total, 850);
    assert.equal(ts.byProvider.groq.estimatedTotal, 30);
    assert.equal(ts.byProvider.openrouter.total, 300);
  });

  it('13-14: supports search, filters, sorting, pagination, and formula-safe CSV/Excel exports', () => {
    const store = { profiles: {}, activities: {}, subscriptions: [], loginHistory: [], tokenUsageLogs: [] };
    const now = Date.parse('2026-11-11T15:00:00Z');
    store.profiles.uA = { uid: 'uA', email: 'zeta@gmail.com', fullName: '=FormulaName', timezone: 'UTC', plan: 'basic', primaryAuthProvider: 'password', lastSignInProvider: 'password', signInCount: 5, joinedAt: '2026-11-01T00:00:00Z', lastSignInAt: '2026-11-11T14:00:00Z', activeSessionId: 'sA', sessionExpiresAt: '2026-11-12T00:00:00Z', lastSeenAt: '2026-11-11T14:58:00Z' };
    store.profiles.uB = { uid: 'uB', email: 'alpha@corp.com', fullName: 'Alpha Beta', timezone: 'UTC', plan: 'pro', primaryAuthProvider: 'google.com', lastSignInProvider: 'google.com', signInCount: 1, joinedAt: '2026-11-11T00:00:00Z', lastSignInAt: '2026-11-05T10:00:00Z' };
    store.subscriptions.push({ id: 's1', uid: 'uB', plan: 'pro', status: 'active', billingStatus: 'paid', paymentTaken: true, interval: 'monthly', basePrice: 399 });

    const indexes = buildStoreIndexes(store);
    const filtered = queryAdminUsers({ store, indexes, plans: PLANS, params: { status: 'online', provider: 'gmail', sort: 'sign_ins', page: 1, pageSize: 1 }, now });
    assert.equal(filtered.items.length, 1);
    assert.equal(filtered.items[0].uid, 'uA');
    assert.equal(filtered.pagination.total, 1);

    const sortedNewest = queryAdminUsers({ store, indexes, plans: PLANS, params: { sort: 'newest', page: 1, pageSize: 10 }, now });
    assert.equal(sortedNewest.items[0].uid, 'uB');

    const csv = generateExportPayload({ scope: 'all', format: 'csv', store, indexes, plans: PLANS, now });
    assert.ok(csv.content.includes("'=FormulaName"), 'sanitizes formula injection in CSV');
    assert.equal(csv.extension, 'csv');

    const xls = generateExportPayload({ scope: 'subscriptions', format: 'excel', store, indexes, plans: PLANS, now });
    assert.ok(xls.content.includes('<Workbook') && xls.content.includes('Alpha Beta'));
    assert.equal(xls.extension, 'xls');
  });
});

describe('admin users HTTP permission & endpoint tests', () => {
  it('15: enforces admin permissions on /api/admin/users, detail, and export routes without leaking secrets', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-admin-users-'));
    for (const f of ['server.js', 'anthropic-provider.js', 'openrouter-provider.js', 'openrouter-keys.js', 'gemini-keys.js', 'gemini-provider.js', 'openai-config.js', 'openai-provider.js', 'ollama-config.js', 'ollama-provider.js', 'codecraft-config.js', 'codecraft-provider.js', 'groq-config.js', 'groq-provider.js', 'nvidia-config.js', 'nvidia-provider.js', 'llmtr-config.js', 'llmtr-provider.js', 'provider-fallback.js', 'provider-access-service.js', 'dashboard-analytics.js', 'photon-limits.js', 'photon-usage.js', 'photon-admin-users.js', 'photon-admin-subscriptions.js', 'pricing-rules-service.js', 'cashfree-service.js', 'index.html', 'admin.html']) {
      fs.copyFileSync(path.join(__dirname, '..', f), path.join(dir, f));
    }
    fs.writeFileSync(path.join(dir, 'photon-profile-data.json'), JSON.stringify({
      profiles: {
        'u-http-1': { uid: 'u-http-1', email: 'test@example.com', fullName: 'HTTP Test', authProvider: 'google.com', signInCount: 3, joinedAt: '2026-11-10T10:00:00Z' },
      },
      activities: {},
      subscriptions: [],
      conversations: {},
      deleted: {},
    }));

    const port = 34579;
    const env = { ...process.env, PORT: String(port), PHOTON_ADMIN_PASSWORD: 'secret-admin-pass', NODE_ENV: 'production' };
    for (const k of Object.keys(env)) if (/^(GEMINI|ANTHROPIC|OPENAI|OLLAMA|OPENROUTER|CODECRAFT|GROQ|NVIDIA|PHOTON_ADMIN_NO_AUTH)/.test(k)) delete env[k];
    const child = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const timer = setInterval(async () => {
          try {
            const r = await fetch(`http://127.0.0.1:${port}/admin`);
            if (r.status === 200) { clearInterval(timer); resolve(); }
          } catch {}
          if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Server timeout')); }
        }, 120);
      });

      const unauth = await fetch(`http://127.0.0.1:${port}/api/admin/users`);
      assert.equal(unauth.status, 401);
      const unauthExport = await fetch(`http://127.0.0.1:${port}/api/admin/users/export`);
      assert.equal(unauthExport.status, 401);

      const authHeaders = { Authorization: 'Basic ' + Buffer.from('admin:secret-admin-pass').toString('base64') };
      const okUsers = await fetch(`http://127.0.0.1:${port}/api/admin/users`, { headers: authHeaders });
      assert.equal(okUsers.status, 200);
      const usersJson = await okUsers.json();
      assert.equal(usersJson.data.kpis.totalRegisteredUsers, 1);
      assert.equal(usersJson.data.items[0].signInMethod, 'Google');

      const detail = await fetch(`http://127.0.0.1:${port}/api/admin/users/u-http-1`, { headers: authHeaders });
      assert.equal(detail.status, 200);
      const detailJson = await detail.json();
      assert.equal(detailJson.data.user.email, 'test@example.com');

      const exp = await fetch(`http://127.0.0.1:${port}/api/admin/users/export?scope=all&format=csv`, { headers: authHeaders });
      assert.equal(exp.status, 200);
      const csvText = await exp.text();
      assert.ok(csvText.includes('test@example.com'));
    } finally {
      child.kill();
      await new Promise(r => child.once('exit', r));
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch {}
    }
  });
});
