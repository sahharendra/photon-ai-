'use strict';
// PHOTON AI Admin — Subscriptions & Purchases analytics, idempotent transaction
// & refund ledger, MRR / Gross / Net revenue calculation, and subscriber queries.

const crypto = require('node:crypto');
const {
  accountIdFor,
  ensureStoreSchema,
  buildStoreIndexes,
  resolveSubscriptionView,
} = require('./photon-admin-users');

const VALID_PAYMENT_STATUSES = Object.freeze([
  'paid',
  'failed',
  'pending',
  'cancelled',
  'refunded',
  'partially_refunded',
]);

const MAX_PAYMENTS = 25000;

function roundCurrency(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function recordPaymentTransaction({
  store,
  indexes,
  plans = [],
  uid,
  subscriptionId = null,
  planId,
  billingType = 'recurring',
  interval = 'monthly',
  advertisedPrice,
  discountAmount = 0,
  couponCode = '',
  amountPaid,
  currency = 'INR',
  gateway = 'photon_billing',
  transactionId,
  orderId = '',
  paymentMethod = '',
  methodDetails = '',
  mode = '',
  signatureVerified = false,
  basePrice,
  taxAmount = 0,
  grantedDailyTokens,
  status = 'paid',
  isRenewal = false,
  failureReason = '',
  paidAt,
  createdAt,
  startDate,
  expiryDate,
  nextRenewalDate,
}) {
  ensureStoreSchema(store);
  const cleanStatus = VALID_PAYMENT_STATUSES.includes(status) ? status : 'pending';
  const txId = String(transactionId || `tx_${crypto.randomUUID()}`).trim();
  const cleanOrderId = String(orderId || '').trim();

  // Strict idempotency check by transactionId (or pending orderId transitioning to final status)
  const existing = (indexes?.paymentsByTxId && indexes.paymentsByTxId.get(txId)) ||
    store.payments.find(p => p && (p.transactionId === txId || (cleanOrderId && p.orderId === cleanOrderId && p.status === 'pending')));
  if (existing) {
    if (existing.status === 'pending' && cleanStatus !== 'pending') {
      const nowIso = createdAt || new Date().toISOString();
      const isSettled = cleanStatus === 'paid' || cleanStatus === 'partially_refunded' || cleanStatus === 'refunded';
      existing.transactionId = txId;
      existing.status = cleanStatus;
      existing.gateway = String(gateway || existing.gateway).slice(0, 60);
      if (paymentMethod) existing.paymentMethod = String(paymentMethod).slice(0, 24);
      if (methodDetails) existing.methodDetails = String(methodDetails).slice(0, 100);
      if (mode) existing.mode = String(mode).slice(0, 16);
      if (signatureVerified) existing.signatureVerified = true;
      if (cleanStatus === 'failed') existing.failureReason = String(failureReason || 'payment_failed').slice(0, 160);
      if (isSettled) existing.paidAt = paidAt || nowIso;
      if (indexes?.paymentsByTxId) indexes.paymentsByTxId.set(txId, existing);
      if (cleanStatus !== 'paid') return { created: false, payment: existing };
    } else {
      return { created: false, payment: existing };
    }
  }

  const planDef = plans.find(p => p.id === planId) || { id: planId || 'pro', name: planId || 'Pro', price: 0 };
  const cleanInterval = billingType === 'one_time' ? 'one_time' : (interval === 'yearly' ? 'yearly' : 'monthly');
  const defaultAdv = cleanInterval === 'yearly' ? Number(planDef.price || 0) * 12 : Number(planDef.price || 0);
  const advPrice = Math.max(0, roundCurrency(advertisedPrice !== undefined ? advertisedPrice : defaultAdv));
  const discAmt = Math.max(0, roundCurrency(discountAmount));
  const computedPaid = amountPaid !== undefined ? Math.max(0, roundCurrency(amountPaid)) : Math.max(0, roundCurrency(advPrice - discAmt));

  const nowIso = createdAt || new Date().toISOString();
  const isSettled = cleanStatus === 'paid' || cleanStatus === 'partially_refunded' || cleanStatus === 'refunded';
  const paidIso = isSettled ? (paidAt || nowIso) : null;

  let payment = existing;
  if (!payment) {
    payment = {
      id: crypto.randomUUID(),
      transactionId: txId,
      orderId: cleanOrderId,
      gateway: String(gateway || 'photon_billing').slice(0, 60),
      paymentMethod: String(paymentMethod || '').slice(0, 24),
      methodDetails: String(methodDetails || '').slice(0, 100),
      mode: String(mode || '').slice(0, 16),
      signatureVerified: Boolean(signatureVerified),
      uid,
      subscriptionId: subscriptionId || null,
      planId: planDef.id,
      planName: planDef.name,
      billingType: billingType === 'one_time' ? 'one_time' : 'recurring',
      interval: cleanInterval,
      advertisedPrice: advPrice,
      basePrice: basePrice !== undefined ? roundCurrency(basePrice) : advPrice,
      taxAmount: roundCurrency(taxAmount),
      discountAmount: discAmt,
      couponCode: String(couponCode || '').trim().toUpperCase().slice(0, 40),
      amountPaid: computedPaid,
      refundedAmount: 0,
      currency: String(currency || 'INR').toUpperCase(),
      status: cleanStatus,
      isRenewal: Boolean(isRenewal),
      failureReason: cleanStatus === 'failed' ? String(failureReason || 'payment_failed').slice(0, 160) : '',
      refunds: [],
      paidAt: paidIso,
      createdAt: nowIso,
    };

    store.payments.unshift(payment);
    if (store.payments.length > MAX_PAYMENTS) store.payments = store.payments.slice(0, MAX_PAYMENTS);
    if (indexes?.paymentsByTxId) indexes.paymentsByTxId.set(txId, payment);
  }

  // If payment succeeded on a paid plan, activate / renew the corresponding subscription safely
  const profile = store.profiles?.[uid];
  if (cleanStatus === 'paid' && profile && planDef.id !== 'basic') {
    const startIso = startDate || paidIso || nowIso;
    const defaultDurationMs = cleanInterval === 'yearly' ? 365 * 86400_000 : 30 * 86400_000;
    const expIso = expiryDate || new Date(Date.parse(startIso) + defaultDurationMs).toISOString();
    const renewIso = billingType === 'one_time' ? null : (nextRenewalDate || expIso);

    let sub = subscriptionId ? store.subscriptions.find(s => s && s.id === subscriptionId) : null;
    if (!sub) {
      sub = {
        id: subscriptionId || crypto.randomUUID(),
        uid,
        plan: planDef.id,
        planPrice: computedPaid,
        basePrice: computedPaid,
        advertisedPrice: advPrice,
        currency: payment.currency,
        billingType: payment.billingType,
        interval: cleanInterval,
        billingStatus: 'paid',
        status: 'active',
        paymentStatus: 'paid',
        purchaseDate: startIso,
        startDate: startIso,
        expiryDate: expIso,
        nextRenewalDate: renewIso,
        selectedAt: startIso,
        lastPaymentAt: paidIso,
        paymentTaken: true,
        latestTransactionId: txId,
      };
      store.subscriptions.unshift(sub);
      payment.subscriptionId = sub.id;
    } else {
      Object.assign(sub, {
        plan: planDef.id,
        planPrice: computedPaid,
        basePrice: computedPaid,
        billingType: payment.billingType,
        interval: cleanInterval,
        billingStatus: 'paid',
        status: 'active',
        paymentStatus: 'paid',
        startDate: sub.startDate || startIso,
        expiryDate: expIso,
        nextRenewalDate: renewIso,
        lastPaymentAt: paidIso,
        paymentTaken: true,
        latestTransactionId: txId,
      });
    }

    profile.plan = planDef.id;
    profile.subscription = {
      status: 'active',
      plan: planDef.id,
      billingType: payment.billingType,
      interval: cleanInterval,
      price: computedPaid,
      basePrice: computedPaid,
      purchaseDate: sub.purchaseDate || startIso,
      startDate: sub.startDate || startIso,
      expiryDate: expIso,
      nextRenewalDate: renewIso,
      selectedAt: startIso,
      lastPaymentAt: paidIso,
      paymentTaken: true,
      latestTransactionId: txId,
    };
  }

  return { created: true, payment };
}

function recordRefundTransaction({ store, transactionId, paymentId, amount, reason = 'customer_refund', refundRef, at }) {
  ensureStoreSchema(store);
  const payment = store.payments.find(p =>
    p && ((transactionId && p.transactionId === transactionId) || (paymentId && p.id === paymentId))
  );
  if (!payment) return { refunded: false, reason: 'payment_not_found' };
  if (!['paid', 'partially_refunded'].includes(payment.status)) {
    return { refunded: false, reason: 'payment_not_refundable', payment };
  }

  const refCode = String(refundRef || `rf_${crypto.randomUUID()}`).trim();
  if ((payment.refunds || []).some(r => r && r.refundRef === refCode)) {
    return { refunded: false, duplicate: true, payment };
  }

  const remaining = Math.max(0, roundCurrency(payment.amountPaid - (payment.refundedAmount || 0)));
  const reqAmt = amount !== undefined ? Math.max(0, roundCurrency(amount)) : remaining;
  const applied = Math.min(remaining, reqAmt);
  if (applied <= 0) return { refunded: false, reason: 'nothing_to_refund', payment };

  const atIso = at || new Date().toISOString();
  payment.refunds ||= [];
  payment.refunds.unshift({
    id: crypto.randomUUID(),
    refundRef: refCode,
    amount: applied,
    reason: String(reason || 'customer_refund').slice(0, 160),
    at: atIso,
  });
  payment.refundedAmount = roundCurrency((payment.refundedAmount || 0) + applied);
  payment.status = payment.refundedAmount >= payment.amountPaid ? 'refunded' : 'partially_refunded';

  // If full refund on active subscription, update subscription status safely
  if (payment.status === 'refunded' && payment.subscriptionId) {
    const sub = store.subscriptions.find(s => s && s.id === payment.subscriptionId);
    if (sub) {
      sub.status = 'refunded';
      sub.paymentStatus = 'refunded';
      sub.paymentTaken = false;
    }
    const profile = store.profiles?.[payment.uid];
    if (profile) {
      const otherActive = store.subscriptions.some(s => s && s.uid === payment.uid && s.id !== payment.subscriptionId && s.paymentTaken === true && s.status === 'active');
      if (!otherActive) {
        profile.plan = 'basic';
        if (profile.subscription) {
          profile.subscription.status = 'refunded';
          profile.subscription.paymentTaken = false;
        }
      }
    }
  }

  return { refunded: true, appliedAmount: applied, payment };
}

function summarizeSubscriberRow(uid, profile, { subs, payments, plans }) {
  const sortedPays = [...(payments || [])].sort((a, b) => Date.parse(b.paidAt || b.createdAt || 0) - Date.parse(a.paidAt || a.createdAt || 0));
  const settledPays = sortedPays.filter(p => ['paid', 'partially_refunded', 'refunded'].includes(p.status));
  const successfulPays = sortedPays.filter(p => p.status === 'paid' || p.status === 'partially_refunded');

  const grossPaid = roundCurrency(settledPays.reduce((s, p) => s + (Number(p.amountPaid) || 0), 0));
  const refundedTotal = roundCurrency(sortedPays.reduce((s, p) => s + (Number(p.refundedAmount) || 0), 0));
  const netPaid = roundCurrency(Math.max(0, grossPaid - refundedTotal));

  const latestSuccessful = successfulPays[0] || null;
  const latestAnyPay = sortedPays[0] || null;
  const subView = resolveSubscriptionView(profile, subs, plans);

  let derivedStatus = 'free';
  if (latestAnyPay && latestAnyPay.status === 'refunded' && !successfulPays.length) derivedStatus = 'refunded';
  else if (latestAnyPay && latestAnyPay.status === 'partially_refunded') derivedStatus = 'partially_refunded';
  else if (latestAnyPay && latestAnyPay.status === 'pending' && !subView.isPaidActive) derivedStatus = 'pending';
  else if (latestAnyPay && latestAnyPay.status === 'failed' && !subView.isPaidActive) derivedStatus = 'failed';
  else if (subView.isPaidActive) derivedStatus = latestAnyPay?.status === 'partially_refunded' ? 'partially_refunded' : 'paid';
  else if (latestAnyPay) derivedStatus = latestAnyPay.status;
  else if (subView.isDemoSelection) derivedStatus = 'demo';

  const latestRefSub = (subs || [])[0] || null;
  const planName = subView.isPaidActive
    ? subView.effectivePlanName
    : latestAnyPay?.planName || (subView.isDemoSelection ? subView.selectedPlanName : 'Free');
  const planId = subView.isPaidActive
    ? subView.effectivePlanId
    : latestAnyPay?.planId || (subView.isDemoSelection ? subView.selectedPlanId : 'basic');

  const billingInterval = latestSuccessful?.interval || latestAnyPay?.interval || latestRefSub?.interval || subView.interval || 'none';
  const billingType = latestSuccessful?.billingType || latestAnyPay?.billingType || latestRefSub?.billingType || 'recurring';

  // Monthly Recurring Revenue contribution strictly from verified active recurring subscriptions
  let mrrContribution = 0;
  if (subView.isPaidActive && billingType === 'recurring' && latestSuccessful) {
    const netLatest = Math.max(0, (Number(latestSuccessful.amountPaid) || 0) - (Number(latestSuccessful.refundedAmount) || 0));
    mrrContribution = billingInterval === 'yearly' ? roundCurrency(netLatest / 12) : roundCurrency(netLatest);
  }

  const lastPaymentAt = latestSuccessful ? (latestSuccessful.paidAt || latestSuccessful.createdAt) : null;

  return {
    uid,
    accountId: accountIdFor(uid),
    fullName: profile?.fullName || 'Photon User',
    email: profile?.email || '',
    planId,
    planName,
    interval: billingInterval,
    billingType,
    isPaidActive: subView.isPaidActive,
    isDemoSelection: subView.isDemoSelection && !subView.isPaidActive && !latestAnyPay,
    actualAmountPaid: latestSuccessful ? netPaid : 0,
    grossAmountPaid: grossPaid,
    refundedAmount: refundedTotal,
    latestChargeAmount: latestSuccessful ? roundCurrency((Number(latestSuccessful.amountPaid) || 0) - (Number(latestSuccessful.refundedAmount) || 0)) : 0,
    discountAmount: latestSuccessful ? Number(latestSuccessful.discountAmount) || 0 : 0,
    couponCode: latestSuccessful?.couponCode || '',
    currency: latestAnyPay?.currency || 'INR',
    lastPaymentAt,
    paymentStatus: derivedStatus,
    latestTransactionId: latestAnyPay?.transactionId || '',
    paymentGateway: latestAnyPay?.gateway || latestSuccessful?.gateway || 'direct_upi',
    paymentMethod: latestAnyPay?.paymentMethod || latestSuccessful?.paymentMethod || 'UPI',
    methodDetails: latestAnyPay?.methodDetails || latestSuccessful?.methodDetails || '',
    successfulPaymentsCount: successfulPays.length,
    totalTransactionsCount: sortedPays.length,
    mrrContribution,
    subscription: subView,
  };
}

function queryAdminSubscriptions({ store, indexes, plans = [], params = {} }) {
  ensureStoreSchema(store);
  const resolvedIndexes = indexes || buildStoreIndexes(store);
  const allPayments = store.payments || [];

  // Aggregate global KPIs across all real payment & subscription records (never treating free/demo as revenue)
  const settledPays = allPayments.filter(p => p && ['paid', 'partially_refunded', 'refunded'].includes(p.status));
  const successfulPays = allPayments.filter(p => p && (p.status === 'paid' || p.status === 'partially_refunded'));
  const pendingPays = allPayments.filter(p => p && p.status === 'pending');

  const grossRevenue = roundCurrency(settledPays.reduce((s, p) => s + (Number(p.amountPaid) || 0), 0));
  const refundedAmount = roundCurrency(allPayments.reduce((s, p) => s + (Number(p.refundedAmount) || 0), 0));
  const netRevenue = roundCurrency(Math.max(0, grossRevenue - refundedAmount));
  const pendingAmount = roundCurrency(pendingPays.reduce((s, p) => s + (Number(p.amountPaid) || 0), 0));

  // Build per-user subscriber rows for all users who have >=1 subscription OR >=1 payment record
  const candidateUids = new Set();
  for (const s of store.subscriptions || []) if (s && s.uid && s.plan !== 'basic') candidateUids.add(s.uid);
  for (const p of allPayments) if (p && p.uid) candidateUids.add(p.uid);

  const subscriberRows = [];
  for (const uid of candidateUids) {
    const profile = resolvedIndexes.byUid.get(uid);
    if (!profile) continue;
    const subs = resolvedIndexes.subsByUid.get(uid) || [];
    const pays = resolvedIndexes.paymentsByUid.get(uid) || [];
    subscriberRows.push(summarizeSubscriberRow(uid, profile, { subs, payments: pays, plans }));
  }

  const kpis = {
    totalSubscribers: subscriberRows.filter(r => r.isPaidActive).length,
    totalSuccessfulPurchases: successfulPays.length,
    grossRevenue,
    totalRevenue: netRevenue,
    mrr: roundCurrency(subscriberRows.reduce((s, r) => s + r.mrrContribution, 0)),
    pendingPaymentsCount: pendingPays.length,
    pendingPaymentsAmount: pendingAmount,
    refundedAmount,
    demoSelectionsCount: subscriberRows.filter(r => r.isDemoSelection).length,
  };

  // Search & filters
  const q = String(params.q || '').trim().toLowerCase();
  const planFilter = String(params.plan || 'all').toLowerCase();
  const statusFilter = String(params.paymentStatus || 'all').toLowerCase();
  const intervalFilter = String(params.interval || 'all').toLowerCase();
  const dateFrom = params.dateFrom ? Date.parse(params.dateFrom) : NaN;
  const dateTo = params.dateTo ? Date.parse(params.dateTo + 'T23:59:59.999Z') : NaN;

  const filtered = subscriberRows.filter(r => {
    if (q) {
      const hay = `${r.fullName} ${r.email} ${r.latestTransactionId} ${r.accountId}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (planFilter !== 'all' && r.planId.toLowerCase() !== planFilter) return false;
    if (statusFilter !== 'all' && r.paymentStatus !== statusFilter) return false;
    if (intervalFilter !== 'all' && r.interval !== intervalFilter) return false;
    if (Number.isFinite(dateFrom) || Number.isFinite(dateTo)) {
      const payMs = Date.parse(r.lastPaymentAt || '');
      if (!Number.isFinite(payMs)) return false;
      if (Number.isFinite(dateFrom) && payMs < dateFrom) return false;
      if (Number.isFinite(dateTo) && payMs > dateTo) return false;
    }
    return true;
  });

  const sort = String(params.sort || 'latest_payment').toLowerCase();
  filtered.sort((a, b) => {
    if (sort === 'highest_amount') return b.actualAmountPaid - a.actualAmountPaid;
    if (sort === 'user_name') return a.fullName.localeCompare(b.fullName);
    return (Date.parse(b.lastPaymentAt || 0) || 0) - (Date.parse(a.lastPaymentAt || 0) || 0);
  });

  const pageSize = Math.max(1, Math.min(100, Number(params.pageSize) || 20));
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(1, Math.min(totalPages, Number(params.page) || 1));
  const start = (page - 1) * pageSize;

  return {
    kpis,
    items: filtered.slice(start, start + pageSize),
    pagination: { total, page, pageSize, totalPages },
  };
}

function getAdminUserSubscriptionDetail({ store, indexes, plans = [], uid }) {
  ensureStoreSchema(store);
  const profile = indexes.byUid.get(uid);
  if (!profile) return null;

  const subs = (indexes.subsByUid.get(uid) || []).map(s => {
    const planDef = plans.find(p => p.id === s.plan);
    return { ...s, planName: planDef?.name || s.plan };
  });
  const payments = [...(indexes.paymentsByUid.get(uid) || [])].sort(
    (a, b) => Date.parse(b.paidAt || b.createdAt || 0) - Date.parse(a.paidAt || a.createdAt || 0)
  );
  const summary = summarizeSubscriberRow(uid, profile, { subs, payments, plans });

  const refundHistory = [];
  for (const p of payments) {
    for (const rf of p.refunds || []) {
      refundHistory.push({ ...rf, transactionId: p.transactionId, planName: p.planName, currency: p.currency });
    }
  }
  refundHistory.sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));

  const latestSub = subs[0] || null;
  return {
    subscriber: summary,
    currentSubscription: {
      ...summary.subscription,
      startDate: latestSub?.startDate || summary.subscription.purchaseDate || null,
      expiryDate: latestSub?.expiryDate || summary.subscription.expiryDate || null,
      nextRenewalDate: latestSub?.nextRenewalDate || summary.subscription.nextRenewalDate || null,
    },
    paymentSummary: {
      successfulCount: payments.filter(p => p.status === 'paid' || p.status === 'partially_refunded').length,
      failedCount: payments.filter(p => p.status === 'failed').length,
      pendingCount: payments.filter(p => p.status === 'pending').length,
      refundedCount: payments.filter(p => p.status === 'refunded' || p.status === 'partially_refunded').length,
      grossPaid: summary.grossAmountPaid,
      refundedAmount: summary.refundedAmount,
      netPaid: summary.actualAmountPaid,
    },
    paymentHistory: payments,
    refundHistory,
    subscriptions: subs,
  };
}

module.exports = {
  VALID_PAYMENT_STATUSES,
  roundCurrency,
  recordPaymentTransaction,
  recordRefundTransaction,
  summarizeSubscriberRow,
  queryAdminSubscriptions,
  getAdminUserSubscriptionDetail,
};
