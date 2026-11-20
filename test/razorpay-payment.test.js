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
  verifyCheckoutSignature,
  verifyWebhookSignature,
  sanitizePaymentMethod,
  computePlanOrderPricing,
  createRazorpayService,
} = require('../razorpay-service');
const { normalizeSettings } = require('../pricing-rules-service');
const { queryAdminSubscriptions } = require('../photon-admin-subscriptions');

const ROOT = path.join(__dirname, '..');
const FILES = ['server.js', 'anthropic-provider.js', 'openrouter-provider.js', 'openrouter-keys.js', 'gemini-keys.js', 'gemini-provider.js', 'openai-config.js', 'openai-provider.js', 'ollama-config.js', 'ollama-provider.js', 'codecraft-config.js', 'codecraft-provider.js', 'groq-config.js', 'groq-provider.js', 'nvidia-config.js', 'nvidia-provider.js', 'llmtr-config.js', 'llmtr-provider.js', 'provider-fallback.js', 'provider-access-service.js', 'dashboard-analytics.js', 'photon-limits.js', 'photon-usage.js', 'photon-admin-users.js', 'photon-admin-subscriptions.js', 'pricing-rules-service.js', 'razorpay-service.js', 'cashfree-service.js', 'cloudflare-config.js', 'cloudflare-provider.js', 'index.html', 'admin.html'];

function signCheckout(orderId, paymentId, secret) {
  return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}

function signWebhook(rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function createRazorpayMockFetch({ paymentFixtures = {}, failOrder = false } = {}) {
  let seq = 1;
  return async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/orders') && opts.method === 'POST') {
      if (failOrder) {
        return { ok: false, status: 500, json: async () => ({ error: { code: 'BAD_REQUEST_ERROR', description: 'Order rejected' } }) };
      }
      const body = JSON.parse(opts.body);
      const orderId = `order_test_${seq++}`;
      return { ok: true, status: 200, json: async () => ({ id: orderId, amount: body.amount, currency: body.currency, status: 'created' }) };
    }
    if (u.includes('/orders?count=1')) {
      return { ok: true, status: 200, json: async () => ({ entity: 'collection', count: 0, items: [] }) };
    }
    const payMatch = /\/payments\/([^/]+)$/.exec(u);
    if (payMatch) {
      const p = paymentFixtures[decodeURIComponent(payMatch[1])];
      if (!p) return { ok: false, status: 404, json: async () => ({ error: { description: 'Payment not found' } }) };
      return { ok: true, status: 200, json: async () => p };
    }
    const refMatch = /\/payments\/([^/]+)\/refund$/.exec(u);
    if (refMatch) {
      const body = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ id: `rfnd_test_${seq++}`, payment_id: decodeURIComponent(refMatch[1]), amount: body.amount, status: 'processed' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

describe('Razorpay Payment System Unit Tests', () => {
  const TEST_ENV = {
    RAZORPAY_KEY_ID: 'rzp_test_1234567890abcd',
    RAZORPAY_KEY_SECRET: 'rzp_test_secret_never_leak',
    RAZORPAY_WEBHOOK_SECRET: 'whsec_test_secret_never_leak',
  };

  it('1: verifies HMAC-SHA256 checkout & webhook signatures and sanitizes Card / UPI metadata with zero card numbers or CVV', () => {
    const orderId = 'order_123';
    const paymentId = 'pay_456';
    const sig = signCheckout(orderId, paymentId, TEST_ENV.RAZORPAY_KEY_SECRET);
    assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature: sig, secret: TEST_ENV.RAZORPAY_KEY_SECRET }), true);
    assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature: 'tampered', secret: TEST_ENV.RAZORPAY_KEY_SECRET }), false);

    const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: {} }));
    const whSig = signWebhook(raw, TEST_ENV.RAZORPAY_WEBHOOK_SECRET);
    assert.equal(verifyWebhookSignature({ rawBody: raw, signature: whSig, secret: TEST_ENV.RAZORPAY_WEBHOOK_SECRET }), true);
    assert.equal(verifyWebhookSignature({ rawBody: raw, signature: 'wrong', secret: TEST_ENV.RAZORPAY_WEBHOOK_SECRET }), false);

    const cardMeta = sanitizePaymentMethod({ method: 'card', card: { network: 'Visa', last4: '4242', type: 'credit', number: '4111111111114242', cvv: '999' } });
    assert.equal(cardMeta.method, 'card');
    assert.equal(cardMeta.methodDetails, 'Visa •••• 4242 (credit)');
    assert.ok(!JSON.stringify(cardMeta).includes('411111'));
    assert.ok(!JSON.stringify(cardMeta).includes('999'));

    const upiMeta = sanitizePaymentMethod({ method: 'upi', vpa: 'user@okicici' });
    assert.equal(upiMeta.method, 'upi');
    assert.equal(upiMeta.methodDetails, 'UPI (user@okicici)');
  });

  it('2: computes authoritative server pricing, creates orders, verifies Credit Card payment, and avoids double-activation', async () => {
    const fixtures = {};
    const svc = createRazorpayService({ env: TEST_ENV, fetchImpl: createRazorpayMockFetch({ paymentFixtures: fixtures }) });
    const store = {
      settings: normalizeSettings(null),
      profiles: { u1: { uid: 'u1', email: 'u1@example.com', fullName: 'Card User', plan: 'basic' } },
      subscriptions: [],
      payments: [],
      paymentOrders: [],
    };

    // Cannot create order for free plan
    await assert.rejects(
      () => svc.createSubscriptionOrder(store, { uid: 'u1', profile: store.profiles.u1, planId: 'basic', interval: 'monthly' }),
      err => err.code === 'invalid_plan' || err.code === 'free_plan_no_checkout',
    );

    const order = await svc.createSubscriptionOrder(store, {
      uid: 'u1',
      profile: store.profiles.u1,
      planId: 'pro',
      interval: 'monthly',
      preferredMethod: 'card',
    });
    // Server computes Pro 399 + 18% GST = 471 INR = 47100 paise
    assert.equal(order.basePrice, 399);
    assert.equal(order.taxAmount, 72);
    assert.equal(order.amount, 471);
    assert.equal(order.amountPaise, 47100);
    assert.ok(!JSON.stringify(order).includes(TEST_ENV.RAZORPAY_KEY_SECRET));

    fixtures['pay_card_1'] = {
      id: 'pay_card_1',
      order_id: order.orderId,
      amount: 47100,
      currency: 'INR',
      status: 'captured',
      method: 'card',
      card: { network: 'MasterCard', last4: '1111', type: 'credit' },
    };

    // Wrong user rejected
    await assert.rejects(
      () => svc.verifyAndCaptureCheckout(store, { uid: 'other-user', orderId: order.orderId, paymentId: 'pay_card_1', signature: signCheckout(order.orderId, 'pay_card_1', TEST_ENV.RAZORPAY_KEY_SECRET) }),
      err => err.status === 403 && err.code === 'order_forbidden',
    );

    // Invalid signature rejected without activating subscription
    await assert.rejects(
      () => svc.verifyAndCaptureCheckout(store, { uid: 'u1', orderId: order.orderId, paymentId: 'pay_card_1', signature: 'bad_sig' }),
      err => err.code === 'invalid_signature',
    );
    assert.equal(store.profiles.u1.plan, 'basic');

    // Valid signature activates Pro subscription and updates Admin ledger
    const verified = await svc.verifyAndCaptureCheckout(store, {
      uid: 'u1',
      orderId: order.orderId,
      paymentId: 'pay_card_1',
      signature: signCheckout(order.orderId, 'pay_card_1', TEST_ENV.RAZORPAY_KEY_SECRET),
    });
    assert.equal(store.profiles.u1.plan, 'pro');
    assert.equal(verified.payment.amountPaid, 471);
    assert.equal(verified.payment.methodDetails, 'MasterCard •••• 1111 (credit)');

    // Re-verifying is strictly idempotent
    const dup = await svc.verifyAndCaptureCheckout(store, {
      uid: 'u1',
      orderId: order.orderId,
      paymentId: 'pay_card_1',
      signature: signCheckout(order.orderId, 'pay_card_1', TEST_ENV.RAZORPAY_KEY_SECRET),
    });
    assert.equal(dup.alreadyActivated, true);
    assert.equal(store.payments.length, 1);

    const adminReport = queryAdminSubscriptions({ store, plans: store.settings.plans });
    assert.equal(adminReport.kpis.totalSubscribers, 1);
    assert.equal(adminReport.kpis.totalRevenue, 471);
  });

  it('3: handles UPI async webhooks, payment.authorized, payment.failed, deduplication, and full/partial refunds', async () => {
    const fixtures = {};
    const svc = createRazorpayService({ env: TEST_ENV, fetchImpl: createRazorpayMockFetch({ paymentFixtures: fixtures }) });
    const store = {
      settings: normalizeSettings(null),
      profiles: {
        u2: { uid: 'u2', email: 'u2@example.com', fullName: 'UPI User', plan: 'basic' },
        uFail: { uid: 'uFail', email: 'fail@example.com', fullName: 'Fail User', plan: 'basic' },
      },
      subscriptions: [],
      payments: [],
      paymentOrders: [],
      webhookEvents: [],
    };

    const upiOrder = await svc.createSubscriptionOrder(store, {
      uid: 'u2',
      profile: store.profiles.u2,
      planId: 'premium',
      interval: 'yearly',
      preferredMethod: 'upi',
    });
    assert.equal(upiOrder.basePrice, 1499 * 12);
    assert.equal(upiOrder.amount, 17988 + Math.round(17988 * 0.18));

    // Step A: authorized webhook keeps plan inactive / pending
    const authPayload = Buffer.from(JSON.stringify({
      event: 'payment.authorized',
      payload: { payment: { entity: { id: 'pay_upi_1', order_id: upiOrder.orderId, amount: upiOrder.amountPaise, currency: 'INR', method: 'upi', vpa: 'buyer@okhdfc', status: 'authorized' } } },
    }));
    const authRes = svc.processWebhookEvent(store, { rawBody: authPayload, signature: signWebhook(authPayload, TEST_ENV.RAZORPAY_WEBHOOK_SECRET), eventId: 'evt_auth_1' });
    assert.equal(authRes.outcome.action, 'payment_authorized');
    assert.equal(store.profiles.u2.plan, 'basic');

    // Step B: captured webhook activates Premium plan & transitions pending payment to paid
    const capPayload = Buffer.from(JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_upi_1', order_id: upiOrder.orderId, amount: upiOrder.amountPaise, currency: 'INR', method: 'upi', vpa: 'buyer@okhdfc', status: 'captured' } } },
    }));
    const capRes = svc.processWebhookEvent(store, { rawBody: capPayload, signature: signWebhook(capPayload, TEST_ENV.RAZORPAY_WEBHOOK_SECRET), eventId: 'evt_cap_1' });
    assert.equal(capRes.outcome.action, 'subscription_activated');
    assert.equal(store.profiles.u2.plan, 'premium');
    assert.equal(store.payments.find(p => p.transactionId === 'pay_upi_1').status, 'paid');

    // Duplicate webhook event is safely ignored
    const dupRes = svc.processWebhookEvent(store, { rawBody: capPayload, signature: signWebhook(capPayload, TEST_ENV.RAZORPAY_WEBHOOK_SECRET), eventId: 'evt_cap_1' });
    assert.equal(dupRes.duplicate, true);

    // Step C: failed UPI payment records failed state and never activates subscription
    const failOrder = await svc.createSubscriptionOrder(store, { uid: 'uFail', profile: store.profiles.uFail, planId: 'pro', interval: 'monthly', preferredMethod: 'upi' });
    const failPayload = Buffer.from(JSON.stringify({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_fail_1', order_id: failOrder.orderId, amount: failOrder.amountPaise, currency: 'INR', method: 'upi', error_description: 'UPI collect expired' } } },
    }));
    svc.processWebhookEvent(store, { rawBody: failPayload, signature: signWebhook(failPayload, TEST_ENV.RAZORPAY_WEBHOOK_SECRET), eventId: 'evt_fail_1' });
    assert.equal(store.profiles.uFail.plan, 'basic');
    assert.equal(store.payments.find(p => p.transactionId === 'pay_fail_1').status, 'failed');

    // Step D: partial then full refund
    await svc.issueAdminRefund(store, { transactionId: 'pay_upi_1', amountInr: 1000, reason: 'partial_credit', actor: 'admin' });
    assert.equal(store.payments.find(p => p.transactionId === 'pay_upi_1').status, 'partially_refunded');
    assert.equal(store.profiles.u2.plan, 'premium');

    const rem = upiOrder.amount - 1000;
    await svc.issueAdminRefund(store, { transactionId: 'pay_upi_1', amountInr: rem, reason: 'full_cancel', actor: 'admin' });
    assert.equal(store.payments.find(p => p.transactionId === 'pay_upi_1').status, 'refunded');
    assert.equal(store.profiles.u2.plan, 'basic');
  });

  it('4: blocks live mode when key is rzp_test_ and protects admin secret fields', async () => {
    const svc = createRazorpayService({ env: TEST_ENV, fetchImpl: createRazorpayMockFetch() });
    const store = { settings: normalizeSettings({ razorpay: { enabled: true, mode: 'live' } }) };
    const status = svc.getGatewayStatus(store);
    assert.equal(status.keyMode, 'test');
    assert.equal(status.keyModeMismatch, true);
    assert.equal(status.ready, false);
    assert.ok(!JSON.stringify(status).includes(TEST_ENV.RAZORPAY_KEY_SECRET));
    assert.ok(!JSON.stringify(status).includes(TEST_ENV.RAZORPAY_WEBHOOK_SECRET));
    await assert.rejects(
      () => svc.createSubscriptionOrder(store, { uid: 'u1', profile: {}, planId: 'pro', interval: 'monthly' }),
      err => err.code === 'gateway_mode_mismatch',
    );
  });
});

describe('Razorpay HTTP Integration Tests', () => {
  it('5: exposes gateway config safely, verifies webhooks over raw HTTP bytes, and enforces auth', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-rzp-'));
    for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));

    // Local stub for Razorpay REST API
    const rzpStub = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.includes('/orders?count=1')) return res.end(JSON.stringify({ entity: 'collection', count: 0, items: [] }));
      res.end('{}');
    });
    await new Promise(resolve => rzpStub.listen(0, '127.0.0.1', resolve));
    const rzpBase = `http://127.0.0.1:${rzpStub.address().port}/v1`;

    const whSecret = 'whsec_http_integration_secret';
    const keySecret = 'rzp_test_http_secret';
    const uid = 'u-rzp-http';
    fs.writeFileSync(path.join(dir, 'photon-profile-data.json'), JSON.stringify({
      profiles: { [uid]: { uid, email: 'buyer@example.com', fullName: 'Rzp Buyer', plan: 'basic' } },
      activities: {},
      subscriptions: [],
      payments: [],
      paymentOrders: [{
        id: 'ord-row-1',
        orderId: 'order_http_1',
        uid,
        planId: 'pro',
        planName: 'Pro',
        dailyTokens: 200,
        interval: 'monthly',
        basePrice: 399,
        taxAmount: 72,
        amount: 471,
        amountPaise: 47100,
        currency: 'INR',
        preferredMethod: 'upi',
        status: 'Created',
        mode: 'test',
        createdAt: '2026-11-11T10:00:00Z',
      }],
      webhookEvents: [],
      conversations: {},
      deleted: {},
    }));

    const port = 34582;
    const child = spawn(process.execPath, ['server.js'], {
      cwd: dir,
      env: {
        ...process.env,
        PORT: String(port),
        PHOTON_ADMIN_PASSWORD: 'rzp-admin-pass',
        NODE_ENV: 'production',
        RAZORPAY_KEY_ID: 'rzp_test_http123456789',
        RAZORPAY_KEY_SECRET: keySecret,
        RAZORPAY_WEBHOOK_SECRET: whSecret,
        RAZORPAY_API_BASE: rzpBase,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server timeout: ' + out)), 8000);
      const iv = setInterval(() => { if (out.includes('PHOTON AI running')) { clearInterval(iv); clearTimeout(t); resolve(); } }, 50);
    });

    const adminHeaders = { Authorization: 'Basic ' + Buffer.from('admin:rzp-admin-pass').toString('base64') };

    try {
      // 1. Public config shows ready gateway without exposing keySecret
      const cfgRes = await fetch(`http://127.0.0.1:${port}/api/profile/config`);
      assert.equal(cfgRes.status, 200);
      const cfgText = await cfgRes.text();
      assert.ok(!cfgText.includes(keySecret));
      assert.ok(!cfgText.includes(whSecret));
      const cfgData = JSON.parse(cfgText).data;
      assert.equal(cfgData.billingAvailable, true);
      assert.equal(cfgData.paymentGateway.mode, 'test');

      // 2. Unauthenticated payment history returns 401
      const unauthHist = await fetch(`http://127.0.0.1:${port}/api/payments/history`);
      assert.equal(unauthHist.status, 401);

      // 3. Invalid webhook signature rejected 401
      const badWh = await fetch(`http://127.0.0.1:${port}/api/payments/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': 'bad-signature' },
        body: JSON.stringify({ event: 'payment.captured' }),
      });
      assert.equal(badWh.status, 401);

      // 4. Valid Razorpay webhook captured activates user subscription & shows in Admin Subscriptions
      const rawBody = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_http_upi_1', order_id: 'order_http_1', amount: 47100, currency: 'INR', method: 'upi', vpa: 'ok@sbi', status: 'captured' } } },
      });
      const validWh = await fetch(`http://127.0.0.1:${port}/api/payments/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Razorpay-Signature': signWebhook(Buffer.from(rawBody), whSecret),
          'X-Razorpay-Event-Id': 'evt_http_1',
        },
        body: rawBody,
      });
      assert.equal(validWh.status, 200);
      const validWhJson = await validWh.json();
      assert.equal(validWhJson.data.outcome.action, 'subscription_activated');

      // 5. Admin test connection works & Admin Subscriptions lists captured INR 471
      const connRes = await fetch(`http://127.0.0.1:${port}/api/admin/payments/test-connection`, { method: 'POST', headers: adminHeaders });
      assert.equal(connRes.status, 200);
      const connJson = await connRes.json();
      assert.equal(connJson.data.ok, true);

      const subsRes = await fetch(`http://127.0.0.1:${port}/api/admin/subscriptions`, { headers: adminHeaders });
      const subsJson = await subsRes.json();
      assert.equal(subsJson.data.kpis.totalRevenue, 471);
      assert.equal(subsJson.data.kpis.totalSubscribers, 1);
    } finally {
      child.kill();
      rzpStub.close();
    }
  });
});
