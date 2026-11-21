'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  verifyWebhookSignature,
  sanitizePaymentMethod,
  computePlanOrderPricing,
  createCashfreeService,
} = require('../cashfree-service');
const { normalizeSettings } = require('../pricing-rules-service');
const { queryAdminSubscriptions } = require('../photon-admin-subscriptions');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'server.js', 'anthropic-provider.js', 'openrouter-provider.js', 'openrouter-keys.js',
  'gemini-keys.js', 'gemini-provider.js', 'openai-config.js', 'openai-provider.js',
  'ollama-config.js', 'ollama-provider.js', 'codecraft-config.js', 'codecraft-provider.js', 'groq-config.js',
  'groq-provider.js', 'nvidia-config.js', 'nvidia-provider.js', 'llmtr-config.js', 'llmtr-provider.js', 'provider-fallback.js',
  'provider-access-service.js', 'dashboard-analytics.js',
  'photon-limits.js', 'photon-usage.js', 'photon-admin-users.js', 'photon-admin-subscriptions.js',
  'pricing-rules-service.js', 'cashfree-service.js', 'cloudflare-config.js', 'cloudflare-provider.js', 'pollinations-provider.js', 'quota-monitor-service.js', 'model-capability-service.js', 'razorpay-service.js', 'index.html', 'admin.html',
];

// Cashfree webhook signature: HMAC-SHA256(timestamp + rawBody, secret), base64
function signWebhook(rawBody, timestamp, secret) {
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  return crypto.createHmac('sha256', String(secret)).update(String(timestamp) + payload).digest('base64');
}

function createCashfreeMockFetch({ paymentFixtures = {}, failOrder = false } = {}) {
  let seq = 1;
  return async (url, opts = {}) => {
    const u = String(url);
    // Create order: POST /pg/orders
    if (/\/pg\/orders$/.test(u) && opts.method === 'POST') {
      if (failOrder) {
        return { ok: false, status: 422, json: async () => ({ message: 'Order creation failed', type: 'ORDER_ERROR' }) };
      }
      const body = JSON.parse(opts.body);
      const orderId = body.order_id || `order_cf_${seq++}`;
      return {
        ok: true, status: 200,
        json: async () => ({
          cf_order_id: `cf_${seq++}`,
          order_id: orderId,
          payment_session_id: `session_${seq++}`,
          order_status: 'ACTIVE',
          order_amount: body.order_amount,
          order_currency: 'INR',
        }),
      };
    }
    // Get payments for order: GET /pg/orders/{id}/payments
    const payMatch = /\/pg\/orders\/([^/]+)\/payments$/.exec(u);
    if (payMatch && (!opts.method || opts.method === 'GET')) {
      const orderId = decodeURIComponent(payMatch[1]);
      const pays = Object.values(paymentFixtures).filter(p => p.order_id === orderId);
      return { ok: true, status: 200, json: async () => pays };
    }
    // Refund: POST /pg/orders/{id}/refunds
    const refMatch = /\/pg\/orders\/([^/]+)\/refunds$/.exec(u);
    if (refMatch && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      return {
        ok: true, status: 200,
        json: async () => ({ refund_id: body.refund_id || `rfnd_${seq++}`, refund_status: 'SUCCESS', refund_amount: body.refund_amount }),
      };
    }
    // Get order: GET /pg/orders/{id}
    const orderMatch = /\/pg\/orders\/([^/]+)$/.exec(u);
    if (orderMatch && (!opts.method || opts.method === 'GET')) {
      return { ok: true, status: 200, json: async () => ({ order_id: decodeURIComponent(orderMatch[1]), order_status: 'ACTIVE' }) };
    }
    return { ok: false, status: 404, json: async () => ({ message: 'Not found' }) };
  };
}

function makeStore(extra = {}) {
  return {
    settings: normalizeSettings(null),
    profiles: {},
    subscriptions: [],
    payments: [],
    paymentOrders: [],
    webhookEvents: [],
    ...extra,
  };
}

describe('Cashfree Payment System Unit Tests', () => {
  const TEST_ENV = {
    CASHFREE_CLIENT_ID: 'TEST_CF_CLIENT_123456',
    CASHFREE_CLIENT_SECRET: 'cf_test_secret_never_leak',
    CASHFREE_WEBHOOK_SECRET: 'cf_whsec_test_secret_never_leak',
    CASHFREE_ENVIRONMENT: 'sandbox',
  };

  it('1: verifies HMAC-SHA256 webhook signatures and sanitizes Card / UPI metadata with zero card numbers or CVV', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ type: 'PAYMENT_SUCCESS', data: {} });
    const sig = signWebhook(rawBody, timestamp, TEST_ENV.CASHFREE_WEBHOOK_SECRET);

    assert.equal(verifyWebhookSignature({ rawBody, signature: sig, timestamp, secret: TEST_ENV.CASHFREE_WEBHOOK_SECRET }), true);
    assert.equal(verifyWebhookSignature({ rawBody, signature: 'tampered==', timestamp, secret: TEST_ENV.CASHFREE_WEBHOOK_SECRET }), false);
    assert.equal(verifyWebhookSignature({ rawBody, signature: sig, timestamp: '0', secret: TEST_ENV.CASHFREE_WEBHOOK_SECRET }), false);

    // Card: no raw number or CVV in output
    const cardMeta = sanitizePaymentMethod({
      payment_method: { card: { card_network: 'Visa', card_last4: '4242', card_type: 'credit', card_number: '4111111111114242', cvv: '999' } },
    });
    assert.equal(cardMeta.method, 'card');
    assert.equal(cardMeta.methodDetails, 'Visa •••• 4242 (credit)');
    assert.ok(!JSON.stringify(cardMeta).includes('411111'));
    assert.ok(!JSON.stringify(cardMeta).includes('999'));

    // UPI: captures VPA safely
    const upiMeta = sanitizePaymentMethod({ payment_method: { upi: { upi_id: 'user@okicici' } } });
    assert.equal(upiMeta.method, 'upi');
    assert.equal(upiMeta.methodDetails, 'UPI (user@okicici)');
  });

  it('2: computes authoritative server pricing, creates orders, verifies Credit Card payment, and avoids double-activation', async () => {
    const fixtures = {};
    const svc = createCashfreeService({ env: TEST_ENV, fetchImpl: createCashfreeMockFetch({ paymentFixtures: fixtures }) });
    const store = makeStore({
      profiles: { u1: { uid: 'u1', email: 'u1@example.com', fullName: 'Card User', plan: 'basic' } },
    });

    // Cannot create order for free plan
    await assert.rejects(
      () => svc.createSubscriptionOrder(store, { uid: 'u1', profile: store.profiles.u1, planId: 'basic', interval: 'monthly' }),
      err => err.code === 'invalid_plan' || err.code === 'free_plan_no_checkout',
    );

    const order = await svc.createSubscriptionOrder(store, {
      uid: 'u1', profile: store.profiles.u1, planId: 'pro', interval: 'monthly', preferredMethod: 'card',
    });
    // Server computes Pro ₹399 + 18% GST = ₹471
    assert.equal(order.basePrice, 399);
    assert.equal(order.taxAmount, 72);
    assert.equal(order.amount, 471);
    assert.ok(order.paymentSessionId, 'paymentSessionId must be returned for Cashfree Drop Checkout');
    assert.ok(!JSON.stringify(order).includes(TEST_ENV.CASHFREE_CLIENT_SECRET), 'secret must not leak');

    fixtures['pay_cf_card_1'] = {
      cf_payment_id: 'pay_cf_card_1',
      payment_id: 'pay_cf_card_1',
      order_id: order.orderId,
      payment_amount: 471,
      payment_currency: 'INR',
      payment_status: 'SUCCESS',
      payment_method: { card: { card_network: 'MasterCard', card_last4: '1111', card_type: 'credit' } },
      payment_time: new Date().toISOString(),
    };

    // Wrong user is rejected
    await assert.rejects(
      () => svc.verifyAndCapturePayment(store, { uid: 'other-user', orderId: order.orderId, cfPaymentId: 'pay_cf_card_1' }),
      err => err.status === 403 && err.code === 'order_forbidden',
    );
    assert.equal(store.profiles.u1.plan, 'basic');

    // Valid payment activates Pro subscription
    const verified = await svc.verifyAndCapturePayment(store, {
      uid: 'u1', orderId: order.orderId, cfPaymentId: 'pay_cf_card_1', cfSignature: '', cfTimestamp: '',
    });
    assert.equal(store.profiles.u1.plan, 'pro');
    assert.equal(verified.payment.amountPaid, 471);
    assert.equal(verified.payment.methodDetails, 'MasterCard •••• 1111 (credit)');
    assert.ok(String(verified.payment.gateway || '').startsWith('cashfree'), 'gateway must be cashfree');

    // Re-verifying is strictly idempotent
    const dup = await svc.verifyAndCapturePayment(store, {
      uid: 'u1', orderId: order.orderId, cfPaymentId: 'pay_cf_card_1',
    });
    assert.equal(dup.alreadyActivated, true);
    assert.equal(store.payments.length, 1);

    const adminReport = queryAdminSubscriptions({ store, plans: store.settings.plans });
    assert.equal(adminReport.kpis.totalSubscribers, 1);
    assert.equal(adminReport.kpis.totalRevenue, 471);
  });

  it('3: handles UPI webhooks, PAYMENT_FAILED, deduplication, and full/partial refunds', async () => {
    const fixtures = {};
    const svc = createCashfreeService({ env: TEST_ENV, fetchImpl: createCashfreeMockFetch({ paymentFixtures: fixtures }) });
    const store = makeStore({
      profiles: {
        u2: { uid: 'u2', email: 'u2@example.com', fullName: 'UPI User', plan: 'basic' },
        uFail: { uid: 'uFail', email: 'fail@example.com', fullName: 'Fail User', plan: 'basic' },
      },
    });

    const upiOrder = await svc.createSubscriptionOrder(store, {
      uid: 'u2', profile: store.profiles.u2, planId: 'premium', interval: 'yearly', preferredMethod: 'upi',
    });
    assert.equal(upiOrder.basePrice, 1499 * 12);
    assert.equal(upiOrder.amount, 17988 + Math.round(17988 * 0.18));

    const timestamp = String(Math.floor(Date.now() / 1000));

    // PAYMENT_SUCCESS webhook activates Premium plan
    const capPayload = JSON.stringify({
      type: 'PAYMENT_SUCCESS',
      data: {
        order: { order_id: upiOrder.orderId, order_amount: upiOrder.amount },
        payment: {
          cf_payment_id: 'pay_cf_upi_1', payment_id: 'pay_cf_upi_1',
          payment_amount: upiOrder.amount, payment_currency: 'INR', payment_status: 'SUCCESS',
          payment_method: { upi: { upi_id: 'buyer@okhdfc' } }, payment_time: new Date().toISOString(),
        },
      },
    });
    const capSig = signWebhook(capPayload, timestamp, TEST_ENV.CASHFREE_WEBHOOK_SECRET);
    const capRes = svc.processWebhookEvent(store, { rawBody: Buffer.from(capPayload), signature: capSig, timestamp, eventId: 'evt_cap_1' });
    assert.equal(capRes.outcome.action, 'subscription_activated');
    assert.equal(store.profiles.u2.plan, 'premium');
    assert.equal(store.payments.find(p => p.transactionId === 'pay_cf_upi_1').status, 'paid');

    // Duplicate webhook event is safely ignored
    const dupRes = svc.processWebhookEvent(store, { rawBody: Buffer.from(capPayload), signature: capSig, timestamp, eventId: 'evt_cap_1' });
    assert.equal(dupRes.duplicate, true);
    assert.equal(dupRes.received, true);

    // PAYMENT_FAILED webhook records failed state and never activates subscription
    const failOrder = await svc.createSubscriptionOrder(store, {
      uid: 'uFail', profile: store.profiles.uFail, planId: 'pro', interval: 'monthly', preferredMethod: 'upi',
    });
    const failPayload = JSON.stringify({
      type: 'PAYMENT_FAILED',
      data: {
        order: { order_id: failOrder.orderId, order_amount: failOrder.amount },
        payment: {
          cf_payment_id: 'pay_cf_fail_1', payment_id: 'pay_cf_fail_1',
          payment_amount: failOrder.amount, payment_currency: 'INR', payment_status: 'FAILED',
          error_details: { error_description: 'UPI collect expired', error_reason: 'collect_expired' },
          payment_method: { upi: { upi_id: 'fail@okhdfc' } },
        },
      },
    });
    const failSig = signWebhook(failPayload, timestamp, TEST_ENV.CASHFREE_WEBHOOK_SECRET);
    svc.processWebhookEvent(store, { rawBody: Buffer.from(failPayload), signature: failSig, timestamp, eventId: 'evt_fail_1' });
    assert.equal(store.profiles.uFail.plan, 'basic');
    assert.equal(store.payments.find(p => p.transactionId === 'pay_cf_fail_1').status, 'failed');

    // Partial then full refund
    await svc.issueAdminRefund(store, { transactionId: 'pay_cf_upi_1', amountInr: 1000, reason: 'partial_credit', actor: 'admin' });
    assert.equal(store.payments.find(p => p.transactionId === 'pay_cf_upi_1').status, 'partially_refunded');
    assert.equal(store.profiles.u2.plan, 'premium'); // plan remains active on partial refund

    const rem = upiOrder.amount - 1000;
    await svc.issueAdminRefund(store, { transactionId: 'pay_cf_upi_1', amountInr: rem, reason: 'full_cancel', actor: 'admin' });
    assert.equal(store.payments.find(p => p.transactionId === 'pay_cf_upi_1').status, 'refunded');
    assert.equal(store.profiles.u2.plan, 'basic'); // plan downgraded after full refund
  });

  it('4: blocks gateway when not configured and protects secret fields from leaking', async () => {
    const noCredEnv = { CASHFREE_ENVIRONMENT: 'sandbox' }; // no client ID/secret
    const svc = createCashfreeService({ env: noCredEnv, fetchImpl: createCashfreeMockFetch() });
    const store = makeStore();
    const status = svc.getGatewayStatus(store);
    assert.equal(status.gateway, 'cashfree');
    assert.equal(status.configured, false);
    assert.equal(status.ready, false);

    await assert.rejects(
      () => svc.createSubscriptionOrder(store, { uid: 'u1', profile: {}, planId: 'pro', interval: 'monthly' }),
      err => err.code === 'gateway_not_configured',
    );

    // With credentials, secrets must not appear in status
    const credSvc = createCashfreeService({ env: TEST_ENV, fetchImpl: createCashfreeMockFetch() });
    const credStore = makeStore({ settings: normalizeSettings({ cashfree: { enabled: true, mode: 'sandbox' } }) });
    const credStatus = credSvc.getGatewayStatus(credStore);
    assert.equal(credStatus.configured, true);
    assert.equal(credStatus.ready, true);
    assert.ok(!JSON.stringify(credStatus).includes(TEST_ENV.CASHFREE_CLIENT_SECRET), 'CLIENT_SECRET must not leak');
    assert.ok(!JSON.stringify(credStatus).includes(TEST_ENV.CASHFREE_WEBHOOK_SECRET), 'WEBHOOK_SECRET must not leak');
  });

  it('5: preserves historical Razorpay payment records with their original gateway identifier', () => {
    const svc = createCashfreeService({ env: TEST_ENV, fetchImpl: createCashfreeMockFetch() });
    const store = makeStore({
      profiles: { uHist: { uid: 'uHist', email: 'hist@example.com', plan: 'pro' } },
      subscriptions: [{ uid: 'uHist', plan: 'pro', paymentTaken: true, status: 'active', interval: 'monthly' }],
      payments: [
        {
          id: 'old-pay-1', uid: 'uHist', transactionId: 'pay_rzp_123', orderId: 'order_rzp_1',
          planId: 'pro', planName: 'Pro', amountPaid: 471, refundedAmount: 0, currency: 'INR',
          status: 'paid', gateway: 'razorpay_card', paymentMethod: 'card',
          methodDetails: 'Visa •••• 1234 (credit)',
          createdAt: '2026-10-01T10:00:00Z', paidAt: '2026-10-01T10:01:00Z',
        },
      ],
    });

    const history = svc.getUserPaymentHistory(store, 'uHist');
    assert.equal(history.length, 1);
    assert.equal(history[0].gateway, 'razorpay_card', 'Historical Razorpay records must preserve gateway identifier');
    assert.equal(history[0].transactionId, 'pay_rzp_123');
  });
});

describe('Cashfree HTTP Integration Tests', () => {
  it('6: exposes gateway config safely, verifies webhooks over raw HTTP bytes, and enforces auth', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-cf-'));
    for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
    const testDir = path.join(dir, 'test');
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

    // Minimal Cashfree API stub
    const cfStub = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        if (req.method === 'POST' && /\/pg\/orders$/.test(req.url)) {
          const b = JSON.parse(body || '{}');
          return res.end(JSON.stringify({
            order_id: b.order_id || 'order_cf_test',
            cf_order_id: 'cf_test_1',
            payment_session_id: 'session_test_1',
            order_status: 'ACTIVE',
            order_amount: b.order_amount,
            order_currency: 'INR',
          }));
        }
        if (/\/payments$/.test(req.url)) return res.end(JSON.stringify([]));
        res.end('{}');
      });
    });
    await new Promise(resolve => cfStub.listen(0, '127.0.0.1', resolve));
    const cfBase = `http://127.0.0.1:${cfStub.address().port}`;

    const whSecret = 'cf_whsec_http_integration_secret';
    const uid = 'u-cf-http';
    const timestamp = String(Math.floor(Date.now() / 1000));

    fs.writeFileSync(path.join(dir, 'photon-profile-data.json'), JSON.stringify({
      profiles: { [uid]: { uid, email: 'buyer@example.com', fullName: 'CF Buyer', plan: 'basic' } },
      activities: {}, subscriptions: [], payments: [],
      paymentOrders: [{
        id: 'ord-cf-row-1', orderId: 'order_cf_http_1', uid,
        planId: 'pro', planName: 'Pro', dailyTokens: 200, interval: 'monthly',
        basePrice: 399, taxAmount: 72, amount: 471, currency: 'INR',
        preferredMethod: 'upi', status: 'Created', mode: 'sandbox',
        gateway: 'cashfree', createdAt: '2026-11-11T10:00:00Z',
      }],
      webhookEvents: [], conversations: {}, deleted: {},
    }));

    const port = 34583;
    const child = spawn(process.execPath, ['server.js'], {
      cwd: dir,
      env: {
        ...process.env,
        PORT: String(port),
        PHOTON_ADMIN_PASSWORD: 'cf-admin-pass',
        NODE_ENV: 'production',
        CASHFREE_CLIENT_ID: 'TEST_CF_CLIENT_HTTP',
        CASHFREE_CLIENT_SECRET: 'cf_test_http_secret',
        CASHFREE_WEBHOOK_SECRET: whSecret,
        CASHFREE_ENVIRONMENT: 'sandbox',
        CASHFREE_API_BASE: cfBase,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server timeout: ' + out.slice(-500))), 10000);
      const iv = setInterval(() => { if (out.includes('PHOTON AI running')) { clearInterval(iv); clearTimeout(t); resolve(); } }, 50);
    });

    const adminHeaders = { Authorization: 'Basic ' + Buffer.from('admin:cf-admin-pass').toString('base64') };

    try {
      // 1. Public config shows ready Cashfree gateway without exposing secrets
      const cfgRes = await fetch(`http://127.0.0.1:${port}/api/profile/config`);
      assert.equal(cfgRes.status, 200);
      const cfgText = await cfgRes.text();
      assert.ok(!cfgText.includes('cf_test_http_secret'), 'CLIENT_SECRET must not appear in public config');
      assert.ok(!cfgText.includes(whSecret), 'WEBHOOK_SECRET must not appear in public config');
      const cfgData = JSON.parse(cfgText).data;
      assert.equal(cfgData.billingAvailable, true);
      assert.equal(cfgData.paymentGateway.gateway, 'cashfree');

      // 2. Unauthenticated payment history returns 401
      const unauthHist = await fetch(`http://127.0.0.1:${port}/api/payments/history`);
      assert.equal(unauthHist.status, 401);

      // 3. Invalid webhook signature is rejected with 401
      const badWh = await fetch(`http://127.0.0.1:${port}/api/payments/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cashfree-signature': 'bad-signature==', 'x-webhook-timestamp': timestamp },
        body: JSON.stringify({ type: 'PAYMENT_SUCCESS' }),
      });
      assert.equal(badWh.status, 401);

      // 4. Valid Cashfree webhook activates user subscription
      const rawBody = JSON.stringify({
        type: 'PAYMENT_SUCCESS',
        data: {
          order: { order_id: 'order_cf_http_1', order_amount: 471 },
          payment: {
            cf_payment_id: 'pay_cf_http_upi_1', payment_id: 'pay_cf_http_upi_1',
            payment_amount: 471, payment_currency: 'INR', payment_status: 'SUCCESS',
            payment_method: { upi: { upi_id: 'ok@sbi' } }, payment_time: new Date().toISOString(),
          },
        },
      });
      const validSig = signWebhook(rawBody, timestamp, whSecret);
      const validWh = await fetch(`http://127.0.0.1:${port}/api/payments/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cashfree-signature': validSig,
          'x-webhook-timestamp': timestamp,
          'x-cashfree-event-id': 'evt_cf_http_1',
        },
        body: rawBody,
      });
      assert.equal(validWh.status, 200);
      const validWhJson = await validWh.json();
      assert.equal(validWhJson.data.outcome.action, 'subscription_activated');

      // 5. Admin subscriptions shows ₹471 revenue from Cashfree
      const subsRes = await fetch(`http://127.0.0.1:${port}/api/admin/subscriptions`, { headers: adminHeaders });
      const subsJson = await subsRes.json();
      assert.equal(subsJson.data.kpis.totalRevenue, 471);
      assert.equal(subsJson.data.kpis.totalSubscribers, 1);

      // 6. Admin gateway config shows cashfree
      const gwRes = await fetch(`http://127.0.0.1:${port}/api/admin/payments/config`, { headers: adminHeaders });
      assert.equal(gwRes.status, 200);
      const gwJson = await gwRes.json();
      assert.equal(gwJson.data.gateway, 'cashfree');
    } finally {
      child.kill();
      cfStub.close();
    }
  });
});
