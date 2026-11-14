'use strict';

/**
 * PHOTON AI — Dashboard Analytics Module
 * Computes business, user, usage, and revenue metrics across real database records with date range filtering.
 */

function parseDateRange({ range = '30d', from, to, now = Date.now() }) {
  const nowDate = new Date(now);
  let startDate, endDate;

  const r = String(range || '30d').toLowerCase();
  if (r === 'today') {
    startDate = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), 0, 0, 0, 0);
    endDate = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), 23, 59, 59, 999);
  } else if (r === '7d') {
    startDate = new Date(now - 7 * 86400000);
    endDate = new Date(now);
  } else if (r === '30d') {
    startDate = new Date(now - 30 * 86400000);
    endDate = new Date(now);
  } else if (r === 'this_month') {
    startDate = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1, 0, 0, 0, 0);
    endDate = new Date(now);
  } else if (r === 'custom' && from) {
    startDate = new Date(from);
    endDate = to ? new Date(to + 'T23:59:59.999Z') : new Date(now);
  } else {
    startDate = new Date(now - 30 * 86400000);
    endDate = new Date(now);
  }

  return {
    range: r,
    startMs: startDate.getTime(),
    endMs: endDate.getTime(),
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
  };
}

function formatDateKey(isoOrMs) {
  const d = new Date(isoOrMs);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function computeDashboardAnalytics({ store, indexes, plans = [], params = {}, now = Date.now() }) {
  const dateRange = parseDateRange({
    range: params.range,
    from: params.from,
    to: params.to,
    now,
  });

  const { startMs, endMs } = dateRange;

  // 1. Registrations over time
  const regMap = {};
  let totalRegistrationsInRange = 0;
  for (const [uid, p] of Object.entries(store.profiles || {})) {
    const t = Date.parse(p.joinedAt || p.createdAt || '');
    if (Number.isFinite(t) && t >= startMs && t <= endMs) {
      totalRegistrationsInRange++;
      const k = formatDateKey(t);
      if (k) regMap[k] = (regMap[k] || 0) + 1;
    }
  }

  // 2. Sign-ins over time
  const signInsMap = {};
  let totalSignInsInRange = 0;
  for (const l of store.loginHistory || []) {
    if (l.status !== 'success') continue;
    const t = Date.parse(l.at);
    if (Number.isFinite(t) && t >= startMs && t <= endMs) {
      totalSignInsInRange++;
      const k = formatDateKey(t);
      if (k) signInsMap[k] = (signInsMap[k] || 0) + 1;
    }
  }

  // 3. Token consumption over time
  const tokensMap = {};
  let totalTokensInRange = 0;
  for (const log of store.tokenUsageLogs || []) {
    const t = Date.parse(log.at);
    if (Number.isFinite(t) && t >= startMs && t <= endMs) {
      const tokens = Number(log.customerTokens || log.tokens || 1);
      totalTokensInRange += tokens;
      const k = formatDateKey(t);
      if (k) tokensMap[k] = (tokensMap[k] || 0) + tokens;
    }
  }

  // 4. Subscription Purchases & Revenue over time
  const revenueMap = {};
  let totalRevenueInRange = 0;
  let totalPurchasesInRange = 0;
  for (const pay of store.payments || []) {
    if (!['paid', 'partially_refunded'].includes(pay.status)) continue;
    const t = Date.parse(pay.paidAt || pay.createdAt);
    if (Number.isFinite(t) && t >= startMs && t <= endMs) {
      totalPurchasesInRange++;
      const net = (Number(pay.amountPaid) || 0) - (Number(pay.refundedAmount) || 0);
      totalRevenueInRange += net;
      const k = formatDateKey(t);
      if (k) revenueMap[k] = (revenueMap[k] || 0) + net;
    }
  }

  // Convert maps to sorted array series
  const toSeries = (map, valueKey) =>
    Object.keys(map)
      .sort()
      .map(date => ({ date, [valueKey]: map[date] }));

  return {
    dateRange,
    inRange: {
      registrations: totalRegistrationsInRange,
      signIns: totalSignInsInRange,
      tokensUsed: totalTokensInRange,
      revenue: Math.round(totalRevenueInRange * 100) / 100,
      purchases: totalPurchasesInRange,
    },
    trends: {
      registrations: toSeries(regMap, 'count'),
      signIns: toSeries(signInsMap, 'count'),
      tokenUsage: toSeries(tokensMap, 'tokens'),
      revenue: toSeries(revenueMap, 'amount'),
    },
  };
}

module.exports = {
  parseDateRange,
  computeDashboardAnalytics,
};
