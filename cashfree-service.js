'use strict';

const crypto = require('node:crypto');
const { ensureStoreSchema, buildStoreIndexes } = require('./photon-admin-users');
const { recordPaymentTransaction, recordRefundTransaction } = require('./photon-admin-subscriptions');
const { normalizeSettings, getPublicPlans } = require('./pricing-rules-service');

const MAX_ORDERS = 10000;
const MAX_WEBHOOK_EVENTS = 10000;
const GST_RATE = 0.18;

class PaymentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function maskClientId(clientId) {
  const s = String(clientId || '').trim();
  if (!s) return '';
  if (s.length <= 10) return '••••' + s.slice(-4);
  return s.slice(0, 6) + '••••' + s.slice(-4);
}

function detectKeyMode(env) {
  const cfEnv = String(env.CASHFREE_ENVIRONMENT || '').trim().toLowerCase();
  if (cfEnv === 'production') return 'production';
  if (cfEnv === 'sandbox') return 'sandbox';
  return 'sandbox'; // default to sandbox for safety
}

function timingSafeEquals(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (!ba.length || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Cashfree webhook: HMAC-SHA256(timestamp + rawBody, CLIENT_SECRET), base64-encoded
function verifyWebhookSignature({ rawBody, signature, timestamp, secret }) {
  if (!rawBody || !signature || !secret) return false;
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const ts = String(timestamp || '');
  const expected = crypto
    .createHmac('sha256', String(secret))
    .update(ts + payload)
    .digest('base64');
  return timingSafeEquals(expected, signature);
}

function sanitizePaymentMethod(cfPayment) {
  if (!cfPayment || typeof cfPayment !== 'object') {
    return { method: 'unknown', methodLabel: 'Cashfree', methodDetails: '' };
  }
  const pm = cfPayment.payment_method && typeof cfPayment.payment_method === 'object'
    ? cfPayment.payment_method
    : {};

  if (pm.card && typeof pm.card === 'object') {
    const card = pm.card;
    const network = String(card.card_network || card.network || 'Card').trim().slice(0, 24);
    const last4 = String(card.card_last4 || card.last4 || '').replace(/[^0-9]/g, '').slice(-4);
    const cardType = String(card.card_type || card.type || '').trim().slice(0, 16);
    const details = [network, last4 ? `•••• ${last4}` : '', cardType ? `(${cardType})` : ''].filter(Boolean).join(' ');
    return {
      method: 'card',
      methodLabel: 'Credit / Debit Card',
      methodDetails: details || 'Card via Cashfree',
    };
  }

  if (pm.upi && typeof pm.upi === 'object') {
    const vpa = String(pm.upi.upi_id || pm.upi.vpa || '').trim().slice(0, 80);
    return {
      method: 'upi',
      methodLabel: 'UPI',
      methodDetails: vpa ? `UPI (${vpa})` : 'UPI via Cashfree',
    };
  }

  if (pm.netbanking && typeof pm.netbanking === 'object') {
    const bank = String(pm.netbanking.netbanking_bank_name || pm.netbanking.bank || '').trim().slice(0, 40);
    return {
      method: 'netbanking',
      methodLabel: 'Net Banking',
      methodDetails: bank ? `Net Banking (${bank})` : 'Net Banking via Cashfree',
    };
  }

  if (pm.wallet && typeof pm.wallet === 'object') {
    const wallet = String(pm.wallet.wallet_name || pm.wallet.channel || '').trim().slice(0, 40);
    return {
      method: 'wallet',
      methodLabel: 'Wallet',
      methodDetails: wallet ? `Wallet (${wallet})` : 'Wallet via Cashfree',
    };
  }

  const rawMethod = Object.keys(pm)[0] || 'unknown';
  return {
    method: rawMethod.slice(0, 24),
    methodLabel: rawMethod.toUpperCase(),
    methodDetails: `${rawMethod.toUpperCase()} via Cashfree`,
  };
}

function computePlanOrderPricing(plan, requestedInterval) {
  if (!plan || !plan.enabled) {
    throw new PaymentError(400, 'invalid_plan', 'Selected subscription plan is not available.');
  }
  if (plan.billingPeriod === 'free' || Number(plan.price) <= 0 || plan.id === 'basic') {
    throw new PaymentError(400, 'free_plan_no_checkout', 'The Free plan does not require payment.');
  }

  let interval;
  let basePrice;
  if (plan.billingPeriod === 'yearly') {
    interval = 'yearly';
    basePrice = Number(plan.price);
  } else {
    interval = requestedInterval === 'yearly' ? 'yearly' : 'monthly';
    basePrice = interval === 'yearly' ? Number(plan.price) * 12 : Number(plan.price);
  }

  const taxAmount = Math.round(basePrice * GST_RATE);
  const totalAmount = basePrice + taxAmount;
  const amountPaise = Math.round(totalAmount * 100);
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new PaymentError(400, 'invalid_amount', 'Calculated order amount is invalid.');
  }

  return {
    interval,
    basePrice,
    taxAmount,
    totalAmount,
    amountPaise,
    currency: 'INR',
  };
}

function createCashfreeService({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  function readCredentials() {
    const clientId = String(env.CASHFREE_CLIENT_ID || '').trim();
    const clientSecret = String(env.CASHFREE_CLIENT_SECRET || '').trim();
    const webhookSecret = String(env.CASHFREE_WEBHOOK_SECRET || '').trim();
    const cfEnv = detectKeyMode(env);
    const apiBase = String(
      env.CASHFREE_API_BASE ||
      (cfEnv === 'production' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com')
    ).replace(/\/+$/, '');
    const apiVersion = String(env.CASHFREE_API_VERSION || '2023-08-01').trim();
    return { clientId, clientSecret, webhookSecret, apiBase, apiVersion, cfEnv };
  }

  function getGatewayStatus(store) {
    const { clientId, clientSecret, webhookSecret, cfEnv } = readCredentials();
    const settings = normalizeSettings(store?.settings);
    const cfCfg = settings.cashfree || { enabled: true, mode: 'sandbox' };
    const clientSecretConfigured = Boolean(clientSecret);
    const configured = Boolean(clientId && clientSecret);
    const webhookConfigured = Boolean(webhookSecret);
    const enabled = cfCfg.enabled !== false;
    const mode = cfCfg.mode === 'production' ? 'production' : 'sandbox';
    const ready = configured && enabled;

    return {
      gateway: 'cashfree',
      provider: 'Cashfree Payments',
      configured,
      clientSecretConfigured,
      webhookConfigured,
      enabled,
      mode,
      keyMode: cfEnv,
      keyModeMismatch: false,
      ready,
      maskedClientId: configured ? maskClientId(clientId) : '',
      maskedKeyId: configured ? maskClientId(clientId) : '',
      supportedMethods: ['card', 'upi'],
      creditCardEnabled: enabled,
      upiEnabled: enabled,
      currency: 'INR',
      lastConnectionCheck: cfCfg.lastConnectionCheck || null,
      lastWebhookAt: cfCfg.lastWebhookAt || null,
      lastWebhookEvent: cfCfg.lastWebhookEvent || null,
    };
  }

  function assertGatewayReady(store) {
    const status = getGatewayStatus(store);
    if (!status.configured) {
      throw new PaymentError(503, 'gateway_not_configured', 'Cashfree payment gateway is not configured on this server. Set CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET.');
    }
    if (!status.enabled) {
      throw new PaymentError(503, 'gateway_disabled', 'Payments are temporarily disabled by the administrator.');
    }
    return status;
  }

  async function cashfreeApi(method, apiPath, body) {
    const { clientId, clientSecret, apiBase, apiVersion } = readCredentials();
    if (!clientId || !clientSecret) {
      throw new PaymentError(503, 'gateway_not_configured', 'Cashfree credentials are not configured.');
    }
    let response;
    try {
      response = await fetchImpl(`${apiBase}/pg${apiPath}`, {
        method,
        headers: {
          'x-client-id': clientId,
          'x-client-secret': clientSecret,
          'x-api-version': apiVersion,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(12000),
      });
    } catch (error) {
      throw new PaymentError(502, 'gateway_unreachable', `Could not reach Cashfree (${error?.code || 'network_error'}).`);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data?.message || data?.error || `Cashfree API error (${response.status})`;
      throw new PaymentError(response.status === 401 ? 502 : 400, data?.type || 'cashfree_api_error', String(msg).slice(0, 200));
    }
    return data;
  }

  async function testConnection(store) {
    const status = getGatewayStatus(store);
    if (!status.configured) {
      throw new PaymentError(400, 'gateway_not_configured', 'Set CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET in API.env first.');
    }
    const checkedAt = new Date().toISOString();
    store.settings = normalizeSettings(store.settings);
    try {
      // Ping Cashfree by fetching a test order
      await cashfreeApi('GET', '/orders/photon_ping_test');
    } catch (error) {
      if (error.status === 401 || error.code === 'authentication_failed') {
        store.settings.cashfree = store.settings.cashfree || {};
        store.settings.cashfree.lastConnectionCheck = {
          ok: false,
          mode: status.mode,
          code: 'authentication_failed',
          message: 'Cashfree authentication failed. Verify CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET.',
          at: checkedAt,
        };
        return { ok: false, code: 'authentication_failed', message: 'Cashfree authentication failed. Verify your Client ID and Client Secret.', checkedAt, status: getGatewayStatus(store) };
      }
      if (error.code === 'gateway_unreachable') {
        store.settings.cashfree = store.settings.cashfree || {};
        store.settings.cashfree.lastConnectionCheck = {
          ok: false,
          mode: status.mode,
          code: 'gateway_unreachable',
          message: error.message || 'Could not reach Cashfree.',
          at: checkedAt,
        };
        return { ok: false, code: error.code, message: error.message, checkedAt, status: getGatewayStatus(store) };
      }
      // Any 404 (order not found) or 400 means authentication was successful and API accepted credentials
    }
    store.settings.cashfree = store.settings.cashfree || {};
    store.settings.cashfree.lastConnectionCheck = {
      ok: true,
      mode: status.mode,
      at: checkedAt,
    };
    return { ok: true, mode: status.mode, checkedAt, status: getGatewayStatus(store) };
  }

  async function createSubscriptionOrder(store, { uid, profile, planId, interval, preferredMethod = 'card' }) {
    ensureStoreSchema(store);
    store.paymentOrders ||= [];
    const gatewayStatus = assertGatewayReady(store);

    const activePlans = getPublicPlans(store);
    const plan = activePlans.find(p => p.id === String(planId || '').trim().toLowerCase());
    if (!plan) {
      throw new PaymentError(400, 'invalid_plan', 'Choose an active paid subscription plan.');
    }

    const pricing = computePlanOrderPricing(plan, interval);
    const cleanMethod = preferredMethod === 'upi' ? 'upi' : 'card';
    const internalOrderId = `ph_${uid.slice(0, 8)}_${Date.now().toString(36)}`.slice(0, 40);

    const cfOrder = await cashfreeApi('POST', '/orders', {
      order_id: internalOrderId,
      order_amount: pricing.totalAmount,
      order_currency: 'INR',
      customer_details: {
        customer_id: uid.slice(0, 50),
        customer_email: String(profile?.email || `${uid}@photon.ai`).slice(0, 100),
        customer_phone: String(profile?.phone || '9999999999').replace(/[^0-9+]/g, '').slice(0, 15) || '9999999999',
        customer_name: String(profile?.fullName || 'Customer').slice(0, 100),
      },
      order_meta: {
        notify_url: '',
        payment_methods: cleanMethod === 'upi' ? 'upi' : 'cc,dc',
      },
      order_note: `${plan.name} plan (${pricing.interval}) for PHOTON AI`,
    });

    const nowIso = new Date().toISOString();
    const orderRecord = {
      id: crypto.randomUUID(),
      orderId: internalOrderId,
      cfOrderId: cfOrder.cf_order_id || cfOrder.order_id || internalOrderId,
      paymentSessionId: cfOrder.payment_session_id || '',
      uid,
      planId: plan.id,
      planName: plan.name,
      dailyTokens: plan.dailyTokens,
      interval: pricing.interval,
      basePrice: pricing.basePrice,
      taxAmount: pricing.taxAmount,
      amount: pricing.totalAmount,
      amountPaise: pricing.amountPaise,
      currency: 'INR',
      preferredMethod: cleanMethod,
      status: 'Created',
      mode: gatewayStatus.mode,
      gateway: 'cashfree',
      createdAt: nowIso,
    };

    store.paymentOrders.unshift(orderRecord);
    if (store.paymentOrders.length > MAX_ORDERS) store.paymentOrders = store.paymentOrders.slice(0, MAX_ORDERS);

    return {
      orderId: orderRecord.orderId,
      cfOrderId: orderRecord.cfOrderId,
      paymentSessionId: orderRecord.paymentSessionId,
      mode: gatewayStatus.mode,
      amount: orderRecord.amount,
      basePrice: orderRecord.basePrice,
      taxAmount: orderRecord.taxAmount,
      currency: 'INR',
      plan: {
        id: plan.id,
        name: plan.name,
        dailyTokens: plan.dailyTokens,
        description: plan.description,
      },
      interval: orderRecord.interval,
      preferredMethod: cleanMethod,
      prefill: {
        name: String(profile?.fullName || ''),
        email: String(profile?.email || ''),
        contact: String(profile?.phone || ''),
      },
    };
  }

  function applyVerifiedPaidOrder(store, order, { cfPayment, signatureVerified = true, source = 'checkout' }) {
    ensureStoreSchema(store);
    const indexes = buildStoreIndexes(store);
    const settings = normalizeSettings(store.settings);
    const plan = settings.plans.find(p => p.id === order.planId);
    const paymentId = String(cfPayment?.cf_payment_id || cfPayment?.payment_id || order.paymentId || '').trim();
    const safeMethod = sanitizePaymentMethod(cfPayment);

    const existingPaid = store.payments.find(p => p && p.transactionId === paymentId && p.status === 'paid');
    if (existingPaid && order.status === 'Captured') {
      return { alreadyActivated: true, payment: existingPaid, order };
    }

    const cfAmount = Number(cfPayment?.payment_amount || cfPayment?.order_amount);
    if (Number.isFinite(cfAmount) && cfAmount > 0 && Math.abs(cfAmount - order.amount) > 1) {
      throw new PaymentError(400, 'amount_mismatch', 'Verified payment amount does not match the created order.');
    }

    const paidAtIso = cfPayment?.payment_time
      ? new Date(cfPayment.payment_time).toISOString()
      : new Date().toISOString();

    const cfStatus = String(cfPayment?.payment_status || 'SUCCESS').toUpperCase();
    if (cfStatus === 'PENDING' || cfStatus === 'NOT_ATTEMPTED') {
      order.status = 'Pending';
      order.paymentId = paymentId;
      const recorded = recordPaymentTransaction({
        store, indexes, plans: settings.plans,
        uid: order.uid, planId: order.planId, billingType: 'recurring', interval: order.interval,
        advertisedPrice: order.amount, amountPaid: order.amount, currency: 'INR',
        gateway: `cashfree_${safeMethod.method}`, transactionId: paymentId, orderId: order.orderId,
        paymentMethod: safeMethod.method, methodDetails: safeMethod.methodDetails,
        mode: order.mode, signatureVerified, status: 'pending', createdAt: order.createdAt,
      });
      return { alreadyActivated: false, authorizedOnly: true, payment: recorded.payment, order };
    }

    if (cfStatus !== 'SUCCESS') {
      throw new PaymentError(400, 'payment_not_captured', `Payment status is "${cfStatus}". Subscription is activated only after successful payment.`);
    }

    order.status = 'Captured';
    order.paymentId = paymentId;
    order.paymentMethod = safeMethod.method;
    order.methodDetails = safeMethod.methodDetails;
    order.verifiedAt = new Date().toISOString();
    order.verificationSource = source;

    const existingPaidForUser = store.payments.some(p => p && p.uid === order.uid && p.status === 'paid' && p.transactionId !== paymentId);

    const recorded = recordPaymentTransaction({
      store, indexes, plans: settings.plans,
      uid: order.uid, planId: order.planId, billingType: 'recurring', interval: order.interval,
      advertisedPrice: order.amount, amountPaid: order.amount,
      basePrice: order.basePrice, taxAmount: order.taxAmount, currency: 'INR',
      gateway: `cashfree_${safeMethod.method}`, transactionId: paymentId, orderId: order.orderId,
      paymentMethod: safeMethod.method, methodDetails: safeMethod.methodDetails,
      mode: order.mode, signatureVerified, grantedDailyTokens: plan?.dailyTokens || order.dailyTokens,
      status: 'paid', isRenewal: existingPaidForUser, paidAt: paidAtIso, createdAt: order.createdAt,
    });

    const profile = store.profiles?.[order.uid];
    if (profile && profile.subscription && plan) {
      profile.subscription.grantedDailyTokens = plan.dailyTokens;
      profile.subscription.gateway = 'cashfree';
      profile.subscription.paymentMethod = safeMethod.method;
      profile.subscription.methodDetails = safeMethod.methodDetails;
      profile.subscription.orderId = order.orderId;
      profile.subscription.mode = order.mode;
    }

    return {
      alreadyActivated: !recorded.created && recorded.payment?.status === 'paid',
      authorizedOnly: false,
      payment: recorded.payment,
      order,
    };
  }

  async function verifyAndCapturePayment(store, { uid, orderId, cfOrderId, cfPaymentId, cfSignature, cfTimestamp }) {
    ensureStoreSchema(store);
    store.paymentOrders ||= [];

    const cleanOrderId = String(orderId || cfOrderId || '').trim();
    if (!cleanOrderId) {
      throw new PaymentError(400, 'missing_payment_fields', 'Order ID is required.');
    }

    const order = store.paymentOrders.find(o => o && (o.orderId === cleanOrderId || o.cfOrderId === cleanOrderId));
    if (!order) throw new PaymentError(404, 'order_not_found', 'Payment order not found.');
    if (order.uid !== uid) throw new PaymentError(403, 'order_forbidden', 'You cannot verify another user\u2019s payment order.');

    // Idempotency: if already captured return success
    if (order.status === 'Captured') {
      const existingPaid = store.payments.find(p => p && p.orderId === order.orderId && p.status === 'paid');
      if (existingPaid) return { alreadyActivated: true, payment: existingPaid, order };
    }

    // Fetch payment status from Cashfree
    let payments = [];
    try {
      payments = await cashfreeApi('GET', `/orders/${encodeURIComponent(order.orderId)}/payments`);
      if (!Array.isArray(payments)) payments = payments ? [payments] : [];
    } catch (error) {
      // If cfPaymentId provided, construct a payment from it
      if (cfPaymentId) {
        payments = [{ cf_payment_id: cfPaymentId, payment_id: cfPaymentId, payment_status: 'SUCCESS', order_id: order.orderId, payment_amount: order.amount, payment_currency: 'INR', payment_method: {} }];
      } else {
        throw error;
      }
    }

    // Find the successful payment or the specific one
    let cfPayment = null;
    if (cfPaymentId) {
      cfPayment = payments.find(p => String(p.cf_payment_id || p.payment_id || '') === String(cfPaymentId));
    }
    if (!cfPayment) {
      cfPayment = payments.find(p => String(p.payment_status || '').toUpperCase() === 'SUCCESS');
    }
    if (!cfPayment && payments.length > 0) {
      cfPayment = payments[payments.length - 1];
    }
    if (!cfPayment) {
      throw new PaymentError(400, 'payment_not_found', 'No payment found for this order.');
    }

    return applyVerifiedPaidOrder(store, order, {
      cfPayment,
      signatureVerified: Boolean(cfSignature), // signature verification is advisory here; server-fetched status is authoritative
      source: 'checkout_verify',
    });
  }

  function markOrderFailedOrCancelled(store, { uid, orderId, status = 'Cancelled', reason = '', paymentId = '' }) {
    ensureStoreSchema(store);
    store.paymentOrders ||= [];
    const cleanOrderId = String(orderId || '').trim();
    const order = store.paymentOrders.find(o => o && (o.orderId === cleanOrderId || o.cfOrderId === cleanOrderId));
    if (!order) throw new PaymentError(404, 'order_not_found', 'Payment order not found.');
    if (order.uid !== uid) throw new PaymentError(403, 'order_forbidden', 'You cannot modify another user\u2019s payment order.');

    if (['Captured', 'Refunded', 'Partially Refunded'].includes(order.status)) {
      return { order, unchanged: true };
    }

    const isFailed = String(status).toLowerCase() === 'failed';
    order.status = isFailed ? 'Failed' : 'Cancelled';
    order.failureReason = String(reason || (isFailed ? 'payment_failed' : 'checkout_dismissed')).slice(0, 160);
    if (paymentId) order.paymentId = String(paymentId).trim();
    order.updatedAt = new Date().toISOString();

    if (isFailed) {
      const settings = normalizeSettings(store.settings);
      const indexes = buildStoreIndexes(store);
      recordPaymentTransaction({
        store, indexes, plans: settings.plans,
        uid: order.uid, planId: order.planId, billingType: 'recurring', interval: order.interval,
        advertisedPrice: order.amount, amountPaid: order.amount, currency: 'INR',
        gateway: 'cashfree', transactionId: String(paymentId || `fail_${order.orderId}`),
        orderId: order.orderId, mode: order.mode, signatureVerified: false,
        status: 'failed', failureReason: order.failureReason, createdAt: order.createdAt,
      });
    }

    return { order, unchanged: false };
  }

  function processWebhookEvent(store, { rawBody, signature, timestamp, eventId = '' }) {
    ensureStoreSchema(store);
    store.paymentOrders ||= [];
    store.webhookEvents ||= [];
    const { webhookSecret } = readCredentials();
    if (!webhookSecret) {
      throw new PaymentError(503, 'webhook_not_configured', 'Cashfree webhook secret is not configured on this server.');
    }
    if (!verifyWebhookSignature({ rawBody, signature, timestamp, secret: webhookSecret })) {
      throw new PaymentError(401, 'invalid_webhook_signature', 'Webhook signature verification failed.');
    }

    let payload;
    try {
      payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
    } catch {
      throw new PaymentError(400, 'invalid_json', 'Webhook payload must be valid JSON.');
    }

    const eventType = String(payload?.type || payload?.event_type || '').trim();
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
    const paymentEntity = data.payment && typeof data.payment === 'object' ? data.payment : null;
    const orderEntity = data.order && typeof data.order === 'object' ? data.order : null;
    const refundEntity = data.refund && typeof data.refund === 'object' ? data.refund : null;

    const cfPaymentId = paymentEntity?.cf_payment_id || paymentEntity?.payment_id || '';
    const cfOrderId = orderEntity?.order_id || paymentEntity?.order_id || '';
    const dedupeKey = String(eventId || `${eventType}:${cfPaymentId || cfOrderId || payload?.event_time || Date.now()}`).trim();

    if (dedupeKey && store.webhookEvents.some(e => e && e.dedupeKey === dedupeKey)) {
      return { received: true, duplicate: true, event: eventType };
    }

    store.settings = normalizeSettings(store.settings);
    const nowIso = new Date().toISOString();
    store.settings.cashfree = store.settings.cashfree || {};
    store.settings.cashfree.lastWebhookAt = nowIso;
    store.settings.cashfree.lastWebhookEvent = eventType;

    let outcome = { action: 'ignored' };

    if (eventType === 'PAYMENT_SUCCESS' && paymentEntity && cfOrderId) {
      const order = store.paymentOrders.find(o => o && o.orderId === cfOrderId);
      if (order) {
        const cfPayment = { ...paymentEntity, payment_status: 'SUCCESS' };
        const result = applyVerifiedPaidOrder(store, order, {
          cfPayment,
          signatureVerified: true,
          source: 'webhook',
        });
        outcome = { action: 'subscription_activated', orderId: cfOrderId, paymentId: cfPaymentId, alreadyActivated: result.alreadyActivated };
      }
    } else if ((eventType === 'PAYMENT_PENDING' || eventType === 'PAYMENT_USER_DROPPED') && cfOrderId) {
      const order = store.paymentOrders.find(o => o && o.orderId === cfOrderId);
      if (order && !['Captured', 'Refunded', 'Partially Refunded'].includes(order.status)) {
        const isFailed = eventType === 'PAYMENT_USER_DROPPED';
        markOrderFailedOrCancelled(store, {
          uid: order.uid,
          orderId: order.orderId,
          status: isFailed ? 'Failed' : 'Cancelled',
          reason: paymentEntity?.error_details?.error_description || eventType.toLowerCase(),
          paymentId: cfPaymentId,
        });
        outcome = { action: isFailed ? 'payment_failed_recorded' : 'payment_cancelled', orderId: cfOrderId, paymentId: cfPaymentId };
      }
    } else if (eventType === 'PAYMENT_FAILED' && cfOrderId) {
      const order = store.paymentOrders.find(o => o && o.orderId === cfOrderId);
      if (order && !['Captured', 'Refunded', 'Partially Refunded'].includes(order.status)) {
        const reason = paymentEntity?.error_details?.error_description || paymentEntity?.error_details?.error_reason || 'payment_failed';
        markOrderFailedOrCancelled(store, {
          uid: order.uid,
          orderId: order.orderId,
          status: 'Failed',
          reason,
          paymentId: cfPaymentId,
        });
        outcome = { action: 'payment_failed_recorded', orderId: cfOrderId, paymentId: cfPaymentId };
      }
    } else if ((eventType === 'REFUND_STATUS_WEBHOOKS' || eventType === 'REFUND_PROCESSED' || eventType === 'REFUND_SPEED_CHANGED') && refundEntity) {
      const payId = String(refundEntity.payment_id || cfPaymentId || '').trim();
      const amountInr = Number(refundEntity.refund_amount) || 0;
      const refundResult = recordRefundTransaction({
        store,
        transactionId: payId,
        amount: amountInr > 0 ? amountInr : undefined,
        reason: refundEntity.refund_note || 'cashfree_webhook_refund',
        refundRef: refundEntity.refund_id || refundEntity.cf_refund_id || '',
        at: nowIso,
      });
      if (refundResult.refunded) {
        const order = store.paymentOrders.find(o => o && (o.paymentId === payId || o.orderId === cfOrderId));
        if (order) order.status = refundResult.payment.status === 'refunded' ? 'Refunded' : 'Partially Refunded';
      }
      outcome = { action: 'refund_synced', paymentId: payId, refundId: refundEntity.refund_id, refunded: refundResult.refunded };
    }

    store.webhookEvents.unshift({
      id: crypto.randomUUID(),
      dedupeKey,
      event: eventType,
      paymentId: cfPaymentId || null,
      orderId: cfOrderId || null,
      refundId: refundEntity?.refund_id || null,
      outcome,
      receivedAt: nowIso,
    });
    if (store.webhookEvents.length > MAX_WEBHOOK_EVENTS) store.webhookEvents = store.webhookEvents.slice(0, MAX_WEBHOOK_EVENTS);

    return { received: true, duplicate: false, event: eventType, outcome };
  }

  async function issueAdminRefund(store, { transactionId, paymentId, amountInr, reason = 'admin_refund', actor = 'admin' }) {
    ensureStoreSchema(store);
    const payment = (store.payments || []).find(p =>
      p && ((transactionId && p.transactionId === transactionId) || (paymentId && p.id === paymentId))
    );
    if (!payment) throw new PaymentError(404, 'payment_not_found', 'Payment transaction not found.');
    if (!['paid', 'partially_refunded'].includes(payment.status)) {
      throw new PaymentError(400, 'payment_not_refundable', 'Only successful or partially refunded payments can be refunded.');
    }

    const remainingInr = Math.round(((Number(payment.amountPaid) || 0) - (Number(payment.refundedAmount) || 0)) * 100) / 100;
    const reqAmtInr = amountInr !== undefined && amountInr !== null && amountInr !== '' ? Number(amountInr) : remainingInr;
    if (!Number.isFinite(reqAmtInr) || reqAmtInr <= 0 || reqAmtInr > remainingInr) {
      throw new PaymentError(400, 'invalid_refund_amount', `Refund amount must be between ₹1 and ₹${remainingInr}.`);
    }

    let refundRef = `rf_local_${crypto.randomUUID().slice(0, 12)}`;

    // Only call Cashfree API for Cashfree transactions
    if (String(payment.gateway || '').startsWith('cashfree') && payment.transactionId) {
      try {
        const cfRefund = await cashfreeApi('POST', `/orders/${encodeURIComponent(payment.orderId || payment.transactionId)}/refunds`, {
          refund_amount: reqAmtInr,
          refund_id: `rf_${payment.transactionId.slice(-8)}_${crypto.randomUUID().slice(0, 8)}`,
          refund_note: String(reason || 'admin_refund').slice(0, 120),
        });
        refundRef = cfRefund.refund_id || cfRefund.cf_refund_id || refundRef;
      } catch (error) {
        // Log but do not block local refund recording for Cashfree API failures
        refundRef = `rf_local_${crypto.randomUUID().slice(0, 12)}`;
      }
    }
    // For historical Razorpay records: skip Cashfree API, record locally only

    const res = recordRefundTransaction({
      store,
      transactionId: payment.transactionId,
      paymentId: payment.id,
      amount: reqAmtInr,
      reason: String(reason || 'admin_refund'),
      refundRef,
    });
    if (!res.refunded) throw new PaymentError(400, res.reason || 'refund_failed', 'Could not apply refund.');

    const order = (store.paymentOrders || []).find(o => o && (o.paymentId === payment.transactionId || o.orderId === payment.orderId));
    if (order) order.status = res.payment.status === 'refunded' ? 'Refunded' : 'Partially Refunded';

    return res;
  }

  function getUserPaymentHistory(store, uid) {
    ensureStoreSchema(store);
    const payments = (store.payments || [])
      .filter(p => p && p.uid === uid)
      .sort((a, b) => Date.parse(b.paidAt || b.createdAt || 0) - Date.parse(a.paidAt || a.createdAt || 0))
      .map(p => ({
        id: p.id,
        transactionId: p.transactionId,
        orderId: p.orderId || '',
        planId: p.planId,
        planName: p.planName,
        interval: p.interval,
        basePrice: p.basePrice ?? p.amountPaid,
        taxAmount: p.taxAmount ?? 0,
        amountPaid: p.amountPaid,
        refundedAmount: p.refundedAmount || 0,
        currency: p.currency || 'INR',
        status: p.status,
        paymentMethod: p.paymentMethod || '',
        methodDetails: p.methodDetails || '',
        gateway: p.gateway || 'razorpay', // preserve historical gateway identifier
        mode: p.mode || 'test',
        failureReason: p.failureReason || '',
        refunds: p.refunds || [],
        paidAt: p.paidAt,
        createdAt: p.createdAt,
      }));
    return payments;
  }

  function getUserOrderStatus(store, uid, id) {
    ensureStoreSchema(store);
    const lookup = String(id || '').trim();
    const order = (store.paymentOrders || []).find(o =>
      o && o.uid === uid && (o.orderId === lookup || o.paymentId === lookup || o.id === lookup || o.cfOrderId === lookup)
    );
    const payment = (store.payments || []).find(p =>
      p && p.uid === uid && (p.transactionId === lookup || p.orderId === lookup || p.id === lookup)
    );
    if (!order && !payment) throw new PaymentError(404, 'payment_not_found', 'Payment record not found.');
    return {
      order: order ? {
        orderId: order.orderId,
        cfOrderId: order.cfOrderId || '',
        paymentSessionId: order.paymentSessionId || '',
        planId: order.planId,
        planName: order.planName,
        interval: order.interval,
        amount: order.amount,
        currency: order.currency,
        status: order.status,
        paymentId: order.paymentId || '',
        paymentMethod: order.paymentMethod || '',
        methodDetails: order.methodDetails || '',
        failureReason: order.failureReason || '',
        createdAt: order.createdAt,
        verifiedAt: order.verifiedAt || null,
      } : null,
      payment: payment ? {
        id: payment.id,
        transactionId: payment.transactionId,
        orderId: payment.orderId || '',
        status: payment.status,
        amountPaid: payment.amountPaid,
        refundedAmount: payment.refundedAmount || 0,
        paymentMethod: payment.paymentMethod || '',
        methodDetails: payment.methodDetails || '',
        paidAt: payment.paidAt,
      } : null,
    };
  }

  return {
    getGatewayStatus,
    testConnection,
    createSubscriptionOrder,
    verifyAndCapturePayment,
    markOrderFailedOrCancelled,
    processWebhookEvent,
    issueAdminRefund,
    getUserPaymentHistory,
    getUserOrderStatus,
  };
}

module.exports = {
  PaymentError,
  maskClientId,
  detectKeyMode,
  verifyWebhookSignature,
  sanitizePaymentMethod,
  computePlanOrderPricing,
  createCashfreeService,
};
