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

function maskKeyId(keyId) {
  const s = String(keyId || '').trim();
  if (!s) return '';
  if (s.length <= 10) return '••••' + s.slice(-4);
  return s.slice(0, 9) + '••••' + s.slice(-4);
}

function detectKeyMode(keyId) {
  const s = String(keyId || '').trim();
  if (!s) return 'none';
  if (s.startsWith('rzp_test_')) return 'test';
  if (s.startsWith('rzp_live_')) return 'live';
  return 'unknown';
}

function timingSafeHexEquals(expectedHex, providedHex) {
  const a = Buffer.from(String(expectedHex || '').trim().toLowerCase(), 'utf8');
  const b = Buffer.from(String(providedHex || '').trim().toLowerCase(), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyCheckoutSignature({ orderId, paymentId, signature, secret }) {
  if (!orderId || !paymentId || !signature || !secret) return false;
  const expected = crypto
    .createHmac('sha256', String(secret))
    .update(`${String(orderId)}|${String(paymentId)}`)
    .digest('hex');
  return timingSafeHexEquals(expected, signature);
}

function verifyWebhookSignature({ rawBody, signature, secret }) {
  if (!rawBody || !signature || !secret) return false;
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto
    .createHmac('sha256', String(secret))
    .update(payload)
    .digest('hex');
  return timingSafeHexEquals(expected, signature);
}

function sanitizePaymentMethod(rzpPayment) {
  if (!rzpPayment || typeof rzpPayment !== 'object') {
    return { method: 'unknown', methodLabel: 'Razorpay', methodDetails: '' };
  }
  const method = String(rzpPayment.method || 'unknown').toLowerCase();
  if (method === 'card') {
    const card = rzpPayment.card && typeof rzpPayment.card === 'object' ? rzpPayment.card : {};
    const network = String(card.network || 'Card').trim().slice(0, 24);
    const last4 = String(card.last4 || '').replace(/[^0-9]/g, '').slice(-4);
    const cardType = String(card.type || '').trim().slice(0, 16);
    const details = [network, last4 ? `•••• ${last4}` : '', cardType ? `(${cardType})` : ''].filter(Boolean).join(' ');
    return {
      method: 'card',
      methodLabel: 'Credit / Debit Card',
      methodDetails: details || 'Card via Razorpay',
    };
  }
  if (method === 'upi') {
    const vpa = String(rzpPayment.vpa || rzpPayment.upi?.vpa || '').trim().slice(0, 80);
    return {
      method: 'upi',
      methodLabel: 'UPI',
      methodDetails: vpa ? `UPI (${vpa})` : 'UPI via Razorpay',
    };
  }
  return {
    method: method.slice(0, 24),
    methodLabel: method.toUpperCase(),
    methodDetails: `${method.toUpperCase()} via Razorpay`,
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

function createRazorpayService({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  function readCredentials() {
    const keyId = String(env.RAZORPAY_KEY_ID || '').trim();
    const keySecret = String(env.RAZORPAY_KEY_SECRET || '').trim();
    const webhookSecret = String(env.RAZORPAY_WEBHOOK_SECRET || '').trim();
    const apiBase = String(env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1').replace(/\/+$/, '');
    return { keyId, keySecret, webhookSecret, apiBase };
  }

  function getGatewayStatus(store) {
    const { keyId, keySecret, webhookSecret } = readCredentials();
    const settings = normalizeSettings(store?.settings);
    const rzCfg = settings.razorpay || { enabled: true, mode: 'test' };
    const configured = Boolean(keyId && keySecret);
    const webhookConfigured = Boolean(webhookSecret);
    const enabled = rzCfg.enabled !== false;
    const mode = rzCfg.mode === 'live' ? 'live' : 'test';
    const keyMode = detectKeyMode(keyId);
    const keyModeMismatch = Boolean(configured && keyMode !== 'unknown' && keyMode !== mode);
    const ready = configured && enabled && !keyModeMismatch;

    return {
      gateway: 'razorpay',
      configured,
      webhookConfigured,
      enabled,
      mode,
      keyMode,
      keyModeMismatch,
      ready,
      maskedKeyId: configured ? maskKeyId(keyId) : '',
      publicKeyId: ready ? keyId : '',
      supportedMethods: ['card', 'upi'],
      currency: 'INR',
      lastConnectionCheck: rzCfg.lastConnectionCheck || null,
      lastWebhookAt: rzCfg.lastWebhookAt || null,
      lastWebhookEvent: rzCfg.lastWebhookEvent || null,
    };
  }

  function assertGatewayReady(store) {
    const status = getGatewayStatus(store);
    if (!status.configured) {
      throw new PaymentError(503, 'gateway_not_configured', 'Razorpay payment gateway is not configured on this server. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
    }
    if (!status.enabled) {
      throw new PaymentError(503, 'gateway_disabled', 'Payments are temporarily disabled by the administrator.');
    }
    if (status.keyModeMismatch) {
      throw new PaymentError(503, 'gateway_mode_mismatch', `Razorpay gateway is set to ${status.mode.toUpperCase()} mode, which does not match the configured ${status.keyMode.toUpperCase()} API key.`);
    }
    return status;
  }

  async function razorpayApi(method, apiPath, body) {
    const { keyId, keySecret, apiBase } = readCredentials();
    if (!keyId || !keySecret) {
      throw new PaymentError(503, 'gateway_not_configured', 'Razorpay credentials are not configured.');
    }
    const auth = Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64');
    let response;
    try {
      response = await fetchImpl(`${apiBase}${apiPath}`, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(12000),
      });
    } catch (error) {
      throw new PaymentError(502, 'gateway_unreachable', `Could not reach Razorpay (${error?.code || 'network_error'}).`);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data?.error?.description || data?.error?.reason || `Razorpay API error (${response.status})`;
      throw new PaymentError(response.status === 401 ? 502 : 400, data?.error?.code || 'razorpay_api_error', msg);
    }
    return data;
  }

  async function testConnection(store) {
    const status = getGatewayStatus(store);
    if (!status.configured) {
      throw new PaymentError(400, 'gateway_not_configured', 'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in API.env first.');
    }
    const checkedAt = new Date().toISOString();
    store.settings = normalizeSettings(store.settings);
    try {
      await razorpayApi('GET', '/orders?count=1');
      store.settings.razorpay.lastConnectionCheck = {
        ok: true,
        mode: status.keyMode,
        at: checkedAt,
      };
      return { ok: true, mode: status.keyMode, checkedAt, status: getGatewayStatus(store) };
    } catch (error) {
      store.settings.razorpay.lastConnectionCheck = {
        ok: false,
        mode: status.keyMode,
        code: error.code || 'connection_failed',
        message: error.message || 'Connection test failed.',
        at: checkedAt,
      };
      return { ok: false, code: error.code || 'connection_failed', message: error.message, checkedAt, status: getGatewayStatus(store) };
    }
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
    const receipt = `ph_${uid.slice(0, 8)}_${Date.now().toString(36)}`.slice(0, 40);
    const cleanMethod = preferredMethod === 'upi' ? 'upi' : 'card';

    const rzpOrder = await razorpayApi('POST', '/orders', {
      amount: pricing.amountPaise,
      currency: 'INR',
      receipt,
      notes: {
        uid,
        planId: plan.id,
        planName: plan.name,
        interval: pricing.interval,
        preferredMethod: cleanMethod,
      },
    });

    const nowIso = new Date().toISOString();
    const orderRecord = {
      id: crypto.randomUUID(),
      orderId: rzpOrder.id,
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
      receipt,
      createdAt: nowIso,
    };

    store.paymentOrders.unshift(orderRecord);
    if (store.paymentOrders.length > MAX_ORDERS) store.paymentOrders = store.paymentOrders.slice(0, MAX_ORDERS);

    return {
      keyId: gatewayStatus.publicKeyId,
      mode: gatewayStatus.mode,
      orderId: orderRecord.orderId,
      amountPaise: orderRecord.amountPaise,
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

  function applyVerifiedPaidOrder(store, order, { rzpPayment, signatureVerified = true, source = 'checkout' }) {
    ensureStoreSchema(store);
    const indexes = buildStoreIndexes(store);
    const settings = normalizeSettings(store.settings);
    const plan = settings.plans.find(p => p.id === order.planId);
    const paymentId = String(rzpPayment?.id || order.paymentId || '').trim();
    const safeMethod = sanitizePaymentMethod(rzpPayment);

    const existingPaid = store.payments.find(p => p && p.transactionId === paymentId && p.status === 'paid');
    if (existingPaid && order.status === 'Captured') {
      return { alreadyActivated: true, payment: existingPaid, order };
    }

    const rzpAmountPaise = Number(rzpPayment?.amount);
    if (Number.isFinite(rzpAmountPaise) && rzpAmountPaise !== order.amountPaise) {
      throw new PaymentError(400, 'amount_mismatch', 'Verified payment amount does not match the created order.');
    }
    if (rzpPayment?.currency && String(rzpPayment.currency).toUpperCase() !== order.currency) {
      throw new PaymentError(400, 'currency_mismatch', 'Verified payment currency mismatch.');
    }

    const paidAtIso = rzpPayment?.created_at
      ? new Date(Number(rzpPayment.created_at) * 1000).toISOString()
      : new Date().toISOString();

    const rzpStatus = String(rzpPayment?.status || 'captured').toLowerCase();
    if (rzpStatus === 'authorized') {
      order.status = 'Authorized';
      order.paymentId = paymentId;
      order.paymentMethod = safeMethod.method;
      order.methodDetails = safeMethod.methodDetails;
      const recorded = recordPaymentTransaction({
        store,
        indexes,
        plans: settings.plans,
        uid: order.uid,
        planId: order.planId,
        billingType: 'recurring',
        interval: order.interval,
        advertisedPrice: order.amount,
        amountPaid: order.amount,
        currency: 'INR',
        gateway: `razorpay_${safeMethod.method}`,
        transactionId: paymentId,
        orderId: order.orderId,
        paymentMethod: safeMethod.method,
        methodDetails: safeMethod.methodDetails,
        mode: order.mode,
        signatureVerified,
        status: 'pending',
        createdAt: order.createdAt,
      });
      return { alreadyActivated: false, authorizedOnly: true, payment: recorded.payment, order };
    }

    if (rzpStatus !== 'captured') {
      throw new PaymentError(400, 'payment_not_captured', `Payment status is "${rzpStatus}". Subscription is activated only after payment capture.`);
    }

    order.status = 'Captured';
    order.paymentId = paymentId;
    order.paymentMethod = safeMethod.method;
    order.methodDetails = safeMethod.methodDetails;
    order.verifiedAt = new Date().toISOString();
    order.verificationSource = source;

    const existingPaidForUser = store.payments.some(p => p && p.uid === order.uid && p.status === 'paid' && p.transactionId !== paymentId);

    const recorded = recordPaymentTransaction({
      store,
      indexes,
      plans: settings.plans,
      uid: order.uid,
      planId: order.planId,
      billingType: 'recurring',
      interval: order.interval,
      advertisedPrice: order.amount,
      amountPaid: order.amount,
      basePrice: order.basePrice,
      taxAmount: order.taxAmount,
      currency: 'INR',
      gateway: `razorpay_${safeMethod.method}`,
      transactionId: paymentId,
      orderId: order.orderId,
      paymentMethod: safeMethod.method,
      methodDetails: safeMethod.methodDetails,
      mode: order.mode,
      signatureVerified,
      grantedDailyTokens: plan?.dailyTokens || order.dailyTokens,
      status: 'paid',
      isRenewal: existingPaidForUser,
      paidAt: paidAtIso,
      createdAt: order.createdAt,
    });

    const profile = store.profiles?.[order.uid];
    if (profile && profile.subscription && plan) {
      profile.subscription.grantedDailyTokens = plan.dailyTokens;
      profile.subscription.gateway = 'razorpay';
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

  async function verifyAndCaptureCheckout(store, { uid, orderId, paymentId, signature }) {
    ensureStoreSchema(store);
    store.paymentOrders ||= [];
    const { keySecret } = readCredentials();
    if (!keySecret) throw new PaymentError(503, 'gateway_not_configured', 'Razorpay secret key is not configured.');

    const cleanOrderId = String(orderId || '').trim();
    const cleanPaymentId = String(paymentId || '').trim();
    const cleanSignature = String(signature || '').trim();
    if (!cleanOrderId || !cleanPaymentId || !cleanSignature) {
      throw new PaymentError(400, 'missing_payment_fields', 'Order ID, payment ID, and signature are required.');
    }

    const order = store.paymentOrders.find(o => o && o.orderId === cleanOrderId);
    if (!order) throw new PaymentError(404, 'order_not_found', 'Payment order not found.');
    if (order.uid !== uid) throw new PaymentError(403, 'order_forbidden', 'You cannot verify another user’s payment order.');

    if (!verifyCheckoutSignature({ orderId: cleanOrderId, paymentId: cleanPaymentId, signature: cleanSignature, secret: keySecret })) {
      throw new PaymentError(400, 'invalid_signature', 'Payment signature verification failed.');
    }

    const rzpPayment = await razorpayApi('GET', `/payments/${encodeURIComponent(cleanPaymentId)}`);
    if (rzpPayment.order_id && rzpPayment.order_id !== cleanOrderId) {
      throw new PaymentError(400, 'order_mismatch', 'Payment does not belong to this order.');
    }

    return applyVerifiedPaidOrder(store, order, {
      rzpPayment,
      signatureVerified: true,
      source: 'checkout_verify',
    });
  }

  function markOrderFailedOrCancelled(store, { uid, orderId, status = 'Cancelled', reason = '', paymentId = '' }) {
    ensureStoreSchema(store);
    store.paymentOrders ||= [];
    const cleanOrderId = String(orderId || '').trim();
    const order = store.paymentOrders.find(o => o && o.orderId === cleanOrderId);
    if (!order) throw new PaymentError(404, 'order_not_found', 'Payment order not found.');
    if (order.uid !== uid) throw new PaymentError(403, 'order_forbidden', 'You cannot modify another user’s payment order.');

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
        store,
        indexes,
        plans: settings.plans,
        uid: order.uid,
        planId: order.planId,
        billingType: 'recurring',
        interval: order.interval,
        advertisedPrice: order.amount,
        amountPaid: order.amount,
        currency: 'INR',
        gateway: 'razorpay',
        transactionId: String(paymentId || `fail_${order.orderId}`),
        orderId: order.orderId,
        mode: order.mode,
        signatureVerified: false,
        status: 'failed',
        failureReason: order.failureReason,
        createdAt: order.createdAt,
      });
    }

    return { order, unchanged: false };
  }

  function processWebhookEvent(store, { rawBody, signature, eventId = '' }) {
    ensureStoreSchema(store);
    store.paymentOrders ||= [];
    store.webhookEvents ||= [];
    const { webhookSecret } = readCredentials();
    if (!webhookSecret) {
      throw new PaymentError(503, 'webhook_not_configured', 'Razorpay webhook secret is not configured on this server.');
    }
    if (!verifyWebhookSignature({ rawBody, signature, secret: webhookSecret })) {
      throw new PaymentError(401, 'invalid_webhook_signature', 'Webhook signature verification failed.');
    }

    let payload;
    try {
      payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
    } catch {
      throw new PaymentError(400, 'invalid_json', 'Webhook payload must be valid JSON.');
    }

    const eventName = String(payload?.event || '').trim();
    const paymentEntity = payload?.payload?.payment?.entity || null;
    const refundEntity = payload?.payload?.refund?.entity || null;
    const dedupeKey = String(eventId || `${eventName}:${paymentEntity?.id || refundEntity?.id || payload?.created_at || ''}`).trim();

    if (dedupeKey && store.webhookEvents.some(e => e && e.dedupeKey === dedupeKey)) {
      return { received: true, duplicate: true, event: eventName };
    }

    store.settings = normalizeSettings(store.settings);
    const nowIso = new Date().toISOString();
    store.settings.razorpay.lastWebhookAt = nowIso;
    store.settings.razorpay.lastWebhookEvent = eventName;

    let outcome = { action: 'ignored' };

    if ((eventName === 'payment.captured' || eventName === 'payment.authorized') && paymentEntity) {
      const order = store.paymentOrders.find(o => o && o.orderId === paymentEntity.order_id);
      if (order) {
        if (eventName === 'payment.captured') {
          const result = applyVerifiedPaidOrder(store, order, {
            rzpPayment: { ...paymentEntity, status: 'captured' },
            signatureVerified: true,
            source: 'webhook',
          });
          outcome = { action: 'subscription_activated', orderId: order.orderId, paymentId: paymentEntity.id, alreadyActivated: result.alreadyActivated };
        } else if (order.status === 'Created' || order.status === 'Pending') {
          const result = applyVerifiedPaidOrder(store, order, {
            rzpPayment: { ...paymentEntity, status: 'authorized' },
            signatureVerified: true,
            source: 'webhook',
          });
          outcome = { action: 'payment_authorized', orderId: order.orderId, paymentId: paymentEntity.id, authorizedOnly: result.authorizedOnly };
        }
      }
    } else if (eventName === 'payment.failed' && paymentEntity) {
      const order = store.paymentOrders.find(o => o && o.orderId === paymentEntity.order_id);
      if (order && !['Captured', 'Refunded', 'Partially Refunded'].includes(order.status)) {
        const reason = paymentEntity.error_description || paymentEntity.error_reason || paymentEntity.error_code || 'payment_failed';
        markOrderFailedOrCancelled(store, {
          uid: order.uid,
          orderId: order.orderId,
          status: 'Failed',
          reason,
          paymentId: paymentEntity.id,
        });
        outcome = { action: 'payment_failed_recorded', orderId: order.orderId, paymentId: paymentEntity.id };
      }
    } else if ((eventName === 'refund.created' || eventName === 'refund.processed') && refundEntity) {
      const payId = String(refundEntity.payment_id || '').trim();
      const amountInr = Math.round((Number(refundEntity.amount) || 0) / 100 * 100) / 100;
      const refundResult = recordRefundTransaction({
        store,
        transactionId: payId,
        amount: amountInr > 0 ? amountInr : undefined,
        reason: refundEntity.notes?.reason || 'razorpay_webhook_refund',
        refundRef: refundEntity.id,
        at: nowIso,
      });
      if (refundResult.refunded) {
        const order = store.paymentOrders.find(o => o && (o.paymentId === payId || o.orderId === refundResult.payment?.orderId));
        if (order) order.status = refundResult.payment.status === 'refunded' ? 'Refunded' : 'Partially Refunded';
      }
      outcome = { action: 'refund_synced', paymentId: payId, refundId: refundEntity.id, refunded: refundResult.refunded };
    }

    store.webhookEvents.unshift({
      id: crypto.randomUUID(),
      dedupeKey,
      event: eventName,
      paymentId: paymentEntity?.id || null,
      orderId: paymentEntity?.order_id || null,
      refundId: refundEntity?.id || null,
      outcome,
      receivedAt: nowIso,
    });
    if (store.webhookEvents.length > MAX_WEBHOOK_EVENTS) store.webhookEvents = store.webhookEvents.slice(0, MAX_WEBHOOK_EVENTS);

    return { received: true, duplicate: false, event: eventName, outcome };
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
    if (String(payment.gateway || '').startsWith('razorpay') && String(payment.transactionId || '').startsWith('pay_')) {
      const rzpRefund = await razorpayApi('POST', `/payments/${encodeURIComponent(payment.transactionId)}/refund`, {
        amount: Math.round(reqAmtInr * 100),
        notes: {
          reason: String(reason || 'admin_refund').slice(0, 120),
          actor: String(actor || 'admin').slice(0, 60),
        },
      });
      refundRef = rzpRefund.id || refundRef;
    }

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
        gateway: p.gateway || 'razorpay',
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
      o && o.uid === uid && (o.orderId === lookup || o.paymentId === lookup || o.id === lookup)
    );
    const payment = (store.payments || []).find(p =>
      p && p.uid === uid && (p.transactionId === lookup || p.orderId === lookup || p.id === lookup)
    );
    if (!order && !payment) throw new PaymentError(404, 'payment_not_found', 'Payment record not found.');
    return {
      order: order ? {
        orderId: order.orderId,
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
    verifyAndCaptureCheckout,
    markOrderFailedOrCancelled,
    processWebhookEvent,
    issueAdminRefund,
    getUserPaymentHistory,
    getUserOrderStatus,
  };
}

module.exports = {
  PaymentError,
  maskKeyId,
  detectKeyMode,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  sanitizePaymentMethod,
  computePlanOrderPricing,
  createRazorpayService,
};
