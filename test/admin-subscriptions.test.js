'use strict';
// Subscriptions & Purchases Admin tests covering all 13 scenarios from Section 10.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const { ensureStoreSchema, buildStoreIndexes } = require('../photon-admin-users');
const {
  recordPaymentTransaction,
  recordRefundTransaction,
  queryAdminSubscriptions,
  getAdminUserSubscriptionDetail,
} = require('../photon-admin-subscriptions');

const PLANS = [
  { id: 'basic', name: 'Free', price: 0, dailyTokens: 50 },
  { id: 'pro', name: 'Pro', price: 399, dailyTokens: 200 },
  { id: 'premium', name: 'Premium', price: 1499, dailyTokens: 2000 },
];

describe('photon-admin-subscriptions revenue, refunds, & queries', () => {
  it('1-6 & 10-12: handles Pro/Premium recurring & one-time, failed/pending, renewal idempotency, free users, multiple purchases, & MRR accuracy', () => {
    const store = {
      profiles: {
        uFree: { uid: 'uFree', email: 'free@example.com', fullName: 'Free Person', plan: 'basic' },
        uPro: { uid: 'uPro', email: 'pro@example.com', fullName: 'Pro Person', plan: 'basic' },
        uPrem: { uid: 'uPrem', email: 'prem@example.com', fullName: 'Prem Person', plan: 'basic' },
        uOnce: { uid: 'uOnce', email: 'once@example.com', fullName: 'One Time User', plan: 'basic' },
      },
      subscriptions: [],
      payments: [],
    };
    ensureStoreSchema(store);

    // 1. New Pro purchase (recurring monthly â‚¹399)
    const p1 = recordPaymentTransaction({ store, plans: PLANS, uid: 'uPro', planId: 'pro', billingType: 'recurring', interval: 'monthly', transactionId: 'tx_pro_1', status: 'paid', paidAt: '2026-10-10T10:00:00Z' });
    assert.equal(p1.created, true);

    // 6. Pro renewal + idempotency duplicate check (same tx_pro_2 twice should only count once!)
    const r1 = recordPaymentTransaction({ store, plans: PLANS, uid: 'uPro', subscriptionId: p1.payment.subscriptionId, planId: 'pro', billingType: 'recurring', interval: 'monthly', transactionId: 'tx_pro_2', status: 'paid', isRenewal: true, paidAt: '2026-11-10T10:00:00Z' });
    const r1Dup = recordPaymentTransaction({ store, plans: PLANS, uid: 'uPro', subscriptionId: p1.payment.subscriptionId, planId: 'pro', billingType: 'recurring', interval: 'monthly', transactionId: 'tx_pro_2', status: 'paid', isRenewal: true, paidAt: '2026-11-10T10:00:00Z' });
    assert.equal(r1.created, true);
    assert.equal(r1Dup.created, false, 'duplicate transactionId must not create duplicate payment');

    // 2. New Premium yearly purchase (â‚¹17,988/yr -> MRR = 1499/mo)
    recordPaymentTransaction({ store, plans: PLANS, uid: 'uPrem', planId: 'premium', billingType: 'recurring', interval: 'yearly', amountPaid: 17988, transactionId: 'tx_prem_yr', status: 'paid', paidAt: '2026-11-05T10:00:00Z' });

    // 4. Failed payment for Prem user (excluded from revenue & purchases)
    recordPaymentTransaction({ store, plans: PLANS, uid: 'uPrem', planId: 'premium', transactionId: 'tx_prem_fail', status: 'failed', failureReason: 'insufficient_funds' });

    // 5. Pending payment for Free user (shows in pending KPI, excluded from revenue & MRR)
    recordPaymentTransaction({ store, plans: PLANS, uid: 'uFree', planId: 'pro', transactionId: 'tx_free_pend', status: 'pending', amountPaid: 399 });

    // 12. One-time purchase (â‚¹500 collected revenue, MUST NOT contribute to MRR)
    recordPaymentTransaction({ store, plans: PLANS, uid: 'uOnce', planId: 'pro', billingType: 'one_time', interval: 'one_time', amountPaid: 500, transactionId: 'tx_once_1', status: 'paid', paidAt: '2026-11-08T10:00:00Z' });

    const indexes = buildStoreIndexes(store);
    const res = queryAdminSubscriptions({ store, indexes, plans: PLANS });

    // Verified subscribers: uPro, uPrem, uOnce (3 total active paid; uFree only has pending -> NOT subscriber)
    assert.equal(res.kpis.totalSubscribers, 3);
    assert.equal(res.kpis.totalSuccessfulPurchases, 4, '2 Pro + 1 Prem + 1 One-time');
    assert.equal(res.kpis.grossRevenue, 399 + 399 + 17988 + 500);
    assert.equal(res.kpis.totalRevenue, 399 + 399 + 17988 + 500);
    assert.equal(res.kpis.mrr, 399 + 1499, 'MRR excludes one-time, failed, pending, and does not double count renewal');
    assert.equal(res.kpis.pendingPaymentsCount, 1);
    assert.equal(res.kpis.pendingPaymentsAmount, 399);

    const proDetail = getAdminUserSubscriptionDetail({ store, indexes, plans: PLANS, uid: 'uPro' });
    assert.equal(proDetail.paymentSummary.successfulCount, 2);
    assert.equal(proDetail.paymentSummary.netPaid, 798);
  });

  it('7-9: handles coupon discounts, partial refunds, and full refunds cleanly', () => {
    const store = {
      profiles: {
        uDisc: { uid: 'uDisc', email: 'disc@example.com', fullName: 'Discount Buyer', plan: 'basic' },
        uPart: { uid: 'uPart', email: 'part@example.com', fullName: 'Partial Refund Buyer', plan: 'basic' },
        uFull: { uid: 'uFull', email: 'full@example.com', fullName: 'Full Refund Buyer', plan: 'basic' },
      },
      subscriptions: [],
      payments: [],
    };
    ensureStoreSchema(store);

    // 7. Coupon purchase: advertised â‚¹1499, coupon LAUNCH500 (-â‚¹500) -> actual paid â‚¹999
    recordPaymentTransaction({ store, plans: PLANS, uid: 'uDisc', planId: 'premium', advertisedPrice: 1499, discountAmount: 500, couponCode: 'LAUNCH500', transactionId: 'tx_disc_1', status: 'paid' });

    // 8. Full refund on Pro â‚¹399
    recordPaymentTransaction({ store, plans: PLANS, uid: 'uFull', planId: 'pro', transactionId: 'tx_full_1', status: 'paid' });
    const rfFull = recordRefundTransaction({ store, transactionId: 'tx_full_1', amount: 399, reason: 'requested_by_user', refundRef: 'rf_1' });
    assert.equal(rfFull.refunded, true);
    assert.equal(rfFull.payment.status, 'refunded');
    assert.equal(store.profiles.uFull.plan, 'basic', 'downgraded back to Free after full refund');

    // 9. Partial refund of â‚¹100 on Pro â‚¹399
    recordPaymentTransaction({ store, plans: PLANS, uid: 'uPart', planId: 'pro', transactionId: 'tx_part_1', status: 'paid' });
    const rfPart = recordRefundTransaction({ store, transactionId: 'tx_part_1', amount: 100, reason: 'partial_credit', refundRef: 'rf_2' });
    assert.equal(rfPart.refunded, true);
    assert.equal(rfPart.payment.status, 'partially_refunded');

    // Duplicate refundRef check
    const rfDup = recordRefundTransaction({ store, transactionId: 'tx_part_1', amount: 100, refundRef: 'rf_2' });
    assert.equal(rfDup.refunded, false);
    assert.equal(rfDup.duplicate, true);

    const indexes = buildStoreIndexes(store);
    const res = queryAdminSubscriptions({ store, indexes, plans: PLANS });
    assert.equal(res.kpis.grossRevenue, 999 + 399 + 399);
    assert.equal(res.kpis.refundedAmount, 399 + 100);
    assert.equal(res.kpis.totalRevenue, 999 + 299, 'net revenue = gross - refunds');
    assert.equal(res.kpis.totalSubscribers, 2, 'full refund removes active subscriber count');

    const fullDetail = getAdminUserSubscriptionDetail({ store, indexes, plans: PLANS, uid: 'uFull' });
    assert.equal(fullDetail.refundHistory.length, 1);
    assert.equal(fullDetail.paymentSummary.netPaid, 0);
  });

  it('13: supports search, filters, sorting, pagination, and admin auth enforcement over HTTP', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-admin-subs-'));
    for (const f of ['server.js', 'anthropic-provider.js', 'openrouter-provider.js', 'openrouter-keys.js', 'gemini-keys.js', 'gemini-provider.js', 'openai-config.js', 'openai-provider.js', 'ollama-config.js', 'ollama-provider.js', 'codecraft-config.js', 'codecraft-provider.js', 'groq-config.js', 'groq-provider.js', 'nvidia-config.js', 'nvidia-provider.js', 'llmtr-config.js', 'llmtr-provider.js', 'provider-fallback.js', 'provider-access-service.js', 'dashboard-analytics.js', 'photon-limits.js', 'photon-usage.js', 'photon-admin-users.js', 'photon-admin-subscriptions.js', 'pricing-rules-service.js', 'cashfree-service.js', 'razorpay-service.js', 'index.html', 'admin.html']) {
      fs.copyFileSync(path.join(__dirname, '..', f), path.join(dir, f));
    }

    const store = {
      profiles: {
        s1: { uid: 's1', email: 'zara@example.com', fullName: 'Zara Khan', plan: 'basic' },
        s2: { uid: 's2', email: 'arjun@example.com', fullName: 'Arjun Mehta', plan: 'basic' },
      },
      subscriptions: [],
      payments: [],
    };
    ensureStoreSchema(store);
    recordPaymentTransaction({ store, plans: PLANS, uid: 's1', planId: 'pro', interval: 'monthly', transactionId: 'tx_s1', status: 'paid', paidAt: '2026-11-10T10:00:00Z' });
    recordPaymentTransaction({ store, plans: PLANS, uid: 's2', planId: 'premium', interval: 'yearly', amountPaid: 14990, transactionId: 'tx_s2', status: 'paid', paidAt: '2026-11-11T10:00:00Z' });
    fs.writeFileSync(path.join(dir, 'photon-profile-data.json'), JSON.stringify(store));

    const port = 34580;
    const env = { ...process.env, PORT: String(port), PHOTON_ADMIN_PASSWORD: 'sub-admin-pass', NODE_ENV: 'production' };
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

      const unauth = await fetch(`http://127.0.0.1:${port}/api/admin/subscriptions`);
      assert.equal(unauth.status, 401);

      const authHeaders = { Authorization: 'Basic ' + Buffer.from('admin:sub-admin-pass').toString('base64') };
      const allRes = await fetch(`http://127.0.0.1:${port}/api/admin/subscriptions?sort=user_name&page=1&pageSize=1`, { headers: authHeaders });
      assert.equal(allRes.status, 200);
      const body = await allRes.json();
      assert.equal(body.data.pagination.total, 2);
      assert.equal(body.data.pagination.totalPages, 2);
      assert.equal(body.data.items[0].fullName, 'Arjun Mehta');

      const filtered = await fetch(`http://127.0.0.1:${port}/api/admin/subscriptions?q=zara&plan=pro`, { headers: authHeaders });
      const fBody = await filtered.json();
      assert.equal(fBody.data.items.length, 1);
      assert.equal(fBody.data.items[0].actualAmountPaid, 399);

      const detail = await fetch(`http://127.0.0.1:${port}/api/admin/subscriptions/s2`, { headers: authHeaders });
      assert.equal(detail.status, 200);
      const dBody = await detail.json();
      assert.equal(dBody.data.paymentHistory[0].transactionId, 'tx_s2');
    } finally {
      child.kill();
      await new Promise(r => child.once('exit', r));
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch {}
    }
  });
});
