'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const { ensureStoreSchema, buildStoreIndexes } = require('../photon-admin-users');
const {
  recordPaymentTransaction,
  queryAdminSubscriptions,
  getAdminUserSubscriptionDetail,
} = require('../photon-admin-subscriptions');

const PLANS = [
  { id: 'basic', name: 'Free', price: 0, dailyTokens: 200, enabled: true },
  { id: 'pro', name: 'Pro', price: 399, dailyTokens: 1000, enabled: true },
  { id: 'premium', name: 'Premium', price: 1499, dailyTokens: 10000, enabled: true },
];

const FILES = [
  'server.js',
  'anthropic-provider.js',
  'openrouter-provider.js',
  'openrouter-keys.js',
  'gemini-keys.js',
  'gemini-provider.js',
  'openai-config.js',
  'openai-provider.js',
  'ollama-provider.js',
  'codecraft-config.js',
  'codecraft-provider.js',
  'groq-config.js',
  'groq-provider.js',
  'nvidia-config.js',
  'nvidia-provider.js',
  'provider-fallback.js',
  'provider-access-service.js',
  'dashboard-analytics.js',
  'photon-limits.js',
  'photon-usage.js',
  'photon-admin-users.js',
  'photon-admin-subscriptions.js',
  'pricing-rules-service.js',
  'cashfree-service.js',
  'razorpay-service.js',
  'index.html',
  'admin.html',
  'upi-qr.jpg',
];

describe('Direct UPI Payment & Admin Page Verification', () => {
  it('1. unit: records Direct UPI transaction, updates user subscription, and surfaces cleanly in admin queries', () => {
    const store = {
      profiles: {
        u1: { uid: 'u1', email: 'upicustomer@example.com', fullName: 'UPI Customer', plan: 'basic' },
      },
      subscriptions: [],
      payments: [],
    };
    ensureStoreSchema(store);

    const utr = '412345678901';
    const rec = recordPaymentTransaction({
      store,
      plans: PLANS,
      uid: 'u1',
      planId: 'pro',
      billingType: 'recurring',
      interval: 'monthly',
      advertisedPrice: 399,
      taxAmount: 72,
      amountPaid: 471,
      currency: 'INR',
      gateway: 'direct_upi',
      transactionId: utr,
      orderId: 'upi_' + utr,
      paymentMethod: 'UPI',
      methodDetails: 'Direct UPI · (9773747095@yapl)',
      status: 'paid',
      paidAt: '2026-11-14T18:00:00Z',
      grantedDailyTokens: 1000,
    });

    assert.equal(rec.created, true);
    assert.equal(store.profiles.u1.plan, 'pro');

    const indexes = buildStoreIndexes(store);
    const adminSubs = queryAdminSubscriptions({ store, indexes, plans: PLANS });

    assert.equal(adminSubs.kpis.totalSubscribers, 1);
    assert.equal(adminSubs.kpis.totalSuccessfulPurchases, 1);
    assert.equal(adminSubs.kpis.grossRevenue, 471);
    assert.equal(adminSubs.kpis.totalRevenue, 471);
    assert.equal(adminSubs.kpis.mrr, 471);

    const subItem = adminSubs.items.find(s => s.uid === 'u1');
    assert.ok(subItem);
    assert.equal(subItem.planId, 'pro');
    assert.equal(subItem.planName, 'Pro');
    assert.equal(subItem.paymentGateway, 'direct_upi');
    assert.equal(subItem.paymentStatus, 'paid');
    assert.equal(subItem.latestTransactionId, utr);
    assert.equal(subItem.actualAmountPaid, 471);
    assert.equal(subItem.isPaidActive, true);

    const detail = getAdminUserSubscriptionDetail({ store, indexes, plans: PLANS, uid: 'u1' });
    assert.equal(detail.paymentHistory.length, 1);
    assert.equal(detail.paymentHistory[0].transactionId, utr);
    assert.equal(detail.paymentHistory[0].gateway, 'direct_upi');
    assert.equal(detail.paymentHistory[0].status, 'paid');
  });

  it('2. http integration: surfaces Direct UPI payment and UTR in live Admin endpoint and rejects unauthenticated requests', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-upi-admin-'));
    for (const file of FILES) {
      fs.copyFileSync(path.join(__dirname, '..', file), path.join(dir, file));
    }

    const testUid = 'user_upi_test_123';
    const testEmail = 'upicustomer@example.com';
    const utr = '412345678901';

    const store = {
      users: {
        [testEmail]: {
          uid: testUid,
          email: testEmail,
          name: 'UPI Customer',
          plan: 'pro',
          planInterval: 'monthly',
        },
      },
      profiles: {
        [testUid]: {
          uid: testUid,
          email: testEmail,
          fullName: 'UPI Customer',
          plan: 'pro',
          tokenAllowance: 1000,
        },
      },
      subscriptions: [],
      payments: [],
      pricingAuditLogs: [],
      settings: {
        plans: PLANS,
        directUpi: {
          enabled: true,
          upiId: '9773747095@yapl',
          payeeName: 'Photon AI',
          qrImageUrl: '/upi-qr.jpg',
        },
      },
    };
    ensureStoreSchema(store);

    recordPaymentTransaction({
      store,
      plans: PLANS,
      uid: testUid,
      planId: 'pro',
      billingType: 'recurring',
      interval: 'monthly',
      advertisedPrice: 399,
      taxAmount: 72,
      amountPaid: 471,
      currency: 'INR',
      gateway: 'direct_upi',
      transactionId: utr,
      orderId: 'upi_' + utr,
      paymentMethod: 'UPI',
      methodDetails: 'Direct UPI · (9773747095@yapl)',
      status: 'paid',
      paidAt: new Date().toISOString(),
      grantedDailyTokens: 1000,
    });

    fs.writeFileSync(path.join(dir, 'photon-profile-data.json'), JSON.stringify(store));

    const port = 34599;
    const adminPassword = 'direct-upi-admin-pass';
    const env = {
      ...process.env,
      PORT: String(port),
      PHOTON_ADMIN_PASSWORD: adminPassword,
      NODE_ENV: 'production',
    };
    for (const k of Object.keys(env)) {
      if (/^(GEMINI|ANTHROPIC|OPENAI|OLLAMA|OPENROUTER|CODECRAFT|GROQ|NVIDIA|PHOTON_ADMIN_NO_AUTH)/.test(k)) {
        delete env[k];
      }
    }

    const child = spawn(process.execPath, ['server.js'], {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const timer = setInterval(async () => {
          try {
            const r = await fetch(`http://127.0.0.1:${port}/api/profile/config`);
            if (r.status === 200) {
              clearInterval(timer);
              resolve();
            }
          } catch {}
          if (Date.now() > deadline) {
            clearInterval(timer);
            reject(new Error('Server boot timed out'));
          }
        }, 120);
      });

      // 1. Direct UPI static QR route serves image
      const imgRes = await fetch(`http://127.0.0.1:${port}/upi-qr.jpg`);
      assert.equal(imgRes.status, 200);

      // 2. Unauthenticated submit endpoint requires auth
      const unauthSubmit = await fetch(`http://127.0.0.1:${port}/api/payments/direct-upi/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: 'pro', utrNumber: utr }),
      });
      assert.equal(unauthSubmit.status, 401);

      // 3. Admin Subscriptions endpoint requires admin auth
      const unauthAdmin = await fetch(`http://127.0.0.1:${port}/api/admin/subscriptions`);
      assert.equal(unauthAdmin.status, 401);

      // 4. Authenticated admin request surfaces the Direct UPI subscriber & transaction
      const adminHeaders = {
        Authorization: 'Basic ' + Buffer.from(`admin:${adminPassword}`).toString('base64'),
      };
      const adminSubsRes = await fetch(`http://127.0.0.1:${port}/api/admin/subscriptions`, {
        headers: adminHeaders,
      });
      assert.equal(adminSubsRes.status, 200);
      const adminSubsData = await adminSubsRes.json();
      assert.equal(adminSubsData.success, true);

      // Verify KPIs in Admin
      assert.equal(adminSubsData.data.kpis.totalSubscribers, 1);
      assert.equal(adminSubsData.data.kpis.totalSuccessfulPurchases, 1);
      assert.equal(adminSubsData.data.kpis.grossRevenue, 471);
      assert.equal(adminSubsData.data.kpis.totalRevenue, 471);
      assert.equal(adminSubsData.data.kpis.mrr, 471);

      // Verify the subscriber row in the admin list
      const subRow = adminSubsData.data.items.find(s => s.uid === testUid);
      assert.ok(subRow, 'User must appear in the admin subscriptions list');
      assert.equal(subRow.fullName, 'UPI Customer');
      assert.equal(subRow.email, testEmail);
      assert.equal(subRow.planId, 'pro');
      assert.equal(subRow.planName, 'Pro');
      assert.equal(subRow.actualAmountPaid, 471);
      assert.equal(subRow.paymentGateway, 'direct_upi');
      assert.equal(subRow.paymentStatus, 'paid');
      assert.equal(subRow.latestTransactionId, utr);
      assert.equal(subRow.isPaidActive, true);

      // 5. Query Admin Subscriber Detail endpoint for this user
      const adminDetailRes = await fetch(`http://127.0.0.1:${port}/api/admin/subscriptions/${testUid}`, {
        headers: adminHeaders,
      });
      assert.equal(adminDetailRes.status, 200);
      const detailData = await adminDetailRes.json();
      assert.equal(detailData.success, true);

      const payHistory = detailData.data.paymentHistory;
      assert.equal(payHistory.length, 1);
      assert.equal(payHistory[0].transactionId, utr);
      assert.equal(payHistory[0].gateway, 'direct_upi');
      assert.equal(payHistory[0].status, 'paid');
      assert.equal(payHistory[0].amountPaid, 471);
      assert.equal(payHistory[0].paymentMethod, 'UPI');
    } finally {
      child.kill();
      await new Promise(r => child.once('exit', r));
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch {}
    }
  });
});
