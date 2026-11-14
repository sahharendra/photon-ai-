'use strict';
// PHOTON AI — Admin Users & Sign-ins Management core module.
//
// * Extends the existing photon-profile-data.json store with idempotent schema
//   migrations (loginHistory, tokenUsageLogs, adminAuditLogs, and richer profile
//   auth/session/usage metadata) without creating duplicate user tables.
// * Maintains in-memory indexes by uid, email, provider, createdAt, and lastSignInAt
//   for fast indexed aggregation and zero N+1 scans.
// * Strictly tracks verified successful sign-ins separately from failed login attempts,
//   page refreshes, and AI chat requests.
// * Evaluates online/offline status from active session validity + configurable
//   heartbeat timeout (PHOTON_ONLINE_TIMEOUT_MS, default 5 minutes).
// * Separates actual provider token usage from explicitly marked estimated usage,
//   and separates customer token usage from PHOTON daily credits and provider billing.
// * Verifies actual paid subscription records instead of trusting unverified demo plans.

const crypto = require('node:crypto');
const { localDateKey } = require('./photon-usage');

const DEFAULT_ONLINE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LOGIN_HISTORY = 10000;
const MAX_TOKEN_LOGS = 25000;
const MAX_ADMIN_AUDIT_LOGS = 2000;

function readOnlineTimeoutMs(env = process.env) {
  const raw = Number(env?.PHOTON_ONLINE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 5000 && raw <= 3600000) return Math.floor(raw);
  return DEFAULT_ONLINE_TIMEOUT_MS;
}

function readSessionTtlMs(env = process.env) {
  const raw = Number(env?.PHOTON_SESSION_TTL_MS);
  if (Number.isFinite(raw) && raw >= 60000 && raw <= 30 * 24 * 60 * 60 * 1000) return Math.floor(raw);
  return DEFAULT_SESSION_TTL_MS;
}

function accountIdFor(uid) {
  return 'USR-' + crypto.createHash('sha256').update(String(uid || '')).digest('hex').slice(0, 8).toUpperCase();
}

function sanitizePhotoUrl(raw) {
  const val = String(raw || '').trim();
  if (!val || val.length > 1000) return '';
  try {
    const parsed = new URL(val);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.toString();
  } catch {}
  return '';
}

function normalizeProviderId(raw) {
  return String(raw || '').trim().toLowerCase();
}

const OAUTH_PROVIDER_NAMES = Object.freeze({
  'google.com': 'Google',
  'google': 'Google',
  'password': 'Gmail / Password',
  'email': 'Gmail / Password',
  'email/password': 'Gmail / Password',
  'github.com': 'GitHub',
  'github': 'GitHub',
  'microsoft.com': 'Microsoft',
  'microsoft': 'Microsoft',
  'apple.com': 'Apple',
  'apple': 'Apple',
  'facebook.com': 'Facebook',
  'facebook': 'Facebook',
  'twitter.com': 'Twitter',
  'twitter': 'Twitter',
  'yahoo.com': 'Yahoo',
  'yahoo': 'Yahoo',
  'phone': 'Phone',
});

function formatAuthProvider(raw) {
  const id = normalizeProviderId(raw);
  if (!id) return 'Unknown';
  if (OAUTH_PROVIDER_NAMES[id]) return OAUTH_PROVIDER_NAMES[id];
  const cleaned = id.replace(/^(oidc|saml)\./, '').replace(/\.(com|org|net)$/, '');
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : 'Other';
}

function clientIpFromReq(req) {
  if (!req) return '';
  const xff = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const remote = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '').trim();
  const ip = xff || remote;
  return ip.slice(0, 64);
}

function summarizeUserAgent(uaRaw) {
  const ua = String(uaRaw || '').trim();
  if (!ua) return 'Unknown device';
  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';
  else if (/node|fetch|undici|curl/i.test(ua)) browser = 'API Client';

  let os = '';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return os ? `${browser} on ${os}` : browser;
}

function ensureStoreSchema(store) {
  if (!store || typeof store !== 'object') return store;
  store.profiles ||= {};
  store.activities ||= {};
  store.conversations ||= {};
  store.deleted ||= {};
  store.subscriptions ||= [];
  store.payments ||= [];
  store.paymentOrders ||= [];
  store.webhookEvents ||= [];
  store.tokenTransactions ||= [];
  store.pricingAuditLogs ||= [];
  store.loginHistory ||= [];
  store.tokenUsageLogs ||= [];
  store.adminAuditLogs ||= [];

  const existingTokenLogIds = new Set(store.tokenUsageLogs.map(t => t && t.activityId).filter(Boolean));
  const usersWithLogins = new Set(store.loginHistory.map(e => e && e.uid).filter(Boolean));

  for (const [uid, profile] of Object.entries(store.profiles)) {
    if (!profile || typeof profile !== 'object') continue;
    const rawProv = normalizeProviderId(profile.authProvider || profile.signInMethod || profile.provider || profile.firebase?.sign_in_provider);
    if (!profile.primaryAuthProvider && rawProv) profile.primaryAuthProvider = rawProv;
    if (!profile.lastSignInProvider && rawProv) profile.lastSignInProvider = rawProv;
    if (!Array.isArray(profile.authProviders)) {
      profile.authProviders = rawProv ? [rawProv] : [];
    } else if (rawProv && !profile.authProviders.includes(rawProv)) {
      profile.authProviders.push(rawProv);
    }

    // Backfill missing initial login history record once for pre-migration users
    if (!usersWithLogins.has(uid) && profile.lastSignInAt) {
      const at = profile.lastSignInAt;
      const prov = profile.lastSignInProvider || profile.primaryAuthProvider || rawProv || '';
      store.loginHistory.push({
        id: crypto.randomUUID(),
        uid,
        email: profile.email || '',
        at,
        provider: prov || 'unknown',
        providerLabel: formatAuthProvider(prov),
        status: 'success',
        sessionId: profile.activeSessionId || null,
        sessionStart: at,
        sessionEnd: profile.activeSessionId ? null : at,
        expiresAt: profile.sessionExpiresAt || null,
        ip: '',
        userAgent: '',
        deviceSummary: 'Migrated record',
        migrated: true,
      });
      usersWithLogins.add(uid);
    }

    // Backfill tokenUsageLogs from existing activities without duplicating
    const acts = Array.isArray(store.activities[uid]) ? store.activities[uid] : [];
    for (const act of acts) {
      if (!act || !act.id || existingTokenLogIds.has(act.id)) continue;
      if (!act.provider && !act.providerTokens) continue;
      const pt = act.providerTokens && typeof act.providerTokens === 'object' ? act.providerTokens : {};
      const inputTokens = Math.max(0, Number(pt.inputTokens ?? pt.input_tokens) || 0);
      const outputTokens = Math.max(0, Number(pt.outputTokens ?? pt.output_tokens) || 0);
      const totalTokens = Math.max(0, Number(pt.totalTokens ?? pt.total_tokens) || (inputTokens + outputTokens));
      const estimated = pt.estimated === true || (totalTokens === 0);
      const finalIn = totalTokens > 0 ? inputTokens : Math.max(1, Math.ceil(String(act.description || '').length / 4));
      const finalOut = totalTokens > 0 ? outputTokens : Math.max(1, Math.ceil((Number(act.tokens) || 1) * 16));
      const finalTotal = finalIn + finalOut;
      store.tokenUsageLogs.push({
        id: crypto.randomUUID(),
        activityId: act.id,
        uid,
        at: act.at || new Date().toISOString(),
        provider: String(act.provider || 'unknown').toLowerCase(),
        model: String(act.model || ''),
        type: String(act.type || 'chat'),
        photonCredits: Number(act.tokens) || 0,
        inputTokens: finalIn,
        outputTokens: finalOut,
        totalTokens: finalTotal,
        estimated,
      });
      existingTokenLogIds.add(act.id);
    }
  }

  store.loginHistory.sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));
  if (store.loginHistory.length > MAX_LOGIN_HISTORY) store.loginHistory = store.loginHistory.slice(0, MAX_LOGIN_HISTORY);

  store.tokenUsageLogs.sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));
  if (store.tokenUsageLogs.length > MAX_TOKEN_LOGS) store.tokenUsageLogs = store.tokenUsageLogs.slice(0, MAX_TOKEN_LOGS);

  store.schemaVersion = 2;
  return store;
}

function buildStoreIndexes(store) {
  ensureStoreSchema(store);
  const byUid = new Map();
  const byEmail = new Map();
  const loginsByUid = new Map();
  const usageByUid = new Map();
  const subsByUid = new Map();
  const paymentsByUid = new Map();
  const paymentsByTxId = new Map();

  for (const [uid, profile] of Object.entries(store.profiles || {})) {
    if (!profile) continue;
    byUid.set(uid, profile);
    if (profile.email) byEmail.set(String(profile.email).toLowerCase(), uid);
    loginsByUid.set(uid, []);
    usageByUid.set(uid, []);
    subsByUid.set(uid, []);
    paymentsByUid.set(uid, []);
  }

  for (const ev of store.loginHistory || []) {
    if (!ev || !ev.uid) continue;
    let list = loginsByUid.get(ev.uid);
    if (!list) { list = []; loginsByUid.set(ev.uid, list); }
    list.push(ev);
  }

  for (const rec of store.tokenUsageLogs || []) {
    if (!rec || !rec.uid) continue;
    let list = usageByUid.get(rec.uid);
    if (!list) { list = []; usageByUid.set(rec.uid, list); }
    list.push(rec);
  }

  for (const sub of store.subscriptions || []) {
    if (!sub || !sub.uid) continue;
    let list = subsByUid.get(sub.uid);
    if (!list) { list = []; subsByUid.set(sub.uid, list); }
    list.push(sub);
  }

  for (const pay of store.payments || []) {
    if (!pay) continue;
    if (pay.transactionId) paymentsByTxId.set(String(pay.transactionId), pay);
    if (!pay.uid) continue;
    let list = paymentsByUid.get(pay.uid);
    if (!list) { list = []; paymentsByUid.set(pay.uid, list); }
    list.push(pay);
  }

  return { byUid, byEmail, loginsByUid, usageByUid, subsByUid, paymentsByUid, paymentsByTxId };
}

function recordLoginEvent({ store, profile, claims, req, photoURL, explicit = false, sessionTtlMs = DEFAULT_SESSION_TTL_MS, now = Date.now() }) {
  ensureStoreSchema(store);
  let changed = false;
  const authAt = Number.isInteger(claims?.auth_time) ? claims.auth_time * 1000 : now;
  const previous = Date.parse(profile.lastSignInAt || '') || 0;
  const tz = profile.timezone || 'Asia/Kolkata';
  const signInDate = localDateKey(authAt, tz);

  if (profile.signInCountDate !== signInDate) {
    profile.signInCountDate = signInDate;
    profile.signInCountToday = 0;
    changed = true;
  }

  const cleanPhoto = sanitizePhotoUrl(photoURL || claims?.picture);
  if (cleanPhoto && profile.photoURL !== cleanPhoto) {
    profile.photoURL = cleanPhoto;
    changed = true;
  }

  const provider = normalizeProviderId(claims?.firebase?.sign_in_provider || profile.authProvider);
  if (provider) {
    if (!profile.primaryAuthProvider) { profile.primaryAuthProvider = provider; changed = true; }
    if (profile.authProvider !== provider) { profile.authProvider = provider; changed = true; }
    if (profile.lastSignInProvider !== provider) { profile.lastSignInProvider = provider; changed = true; }
    if (!Array.isArray(profile.authProviders)) profile.authProviders = [];
    if (!profile.authProviders.includes(provider)) { profile.authProviders.push(provider); changed = true; }
  }

  const isNewAuthEvent = authAt > previous;
  const needsSessionInit = !profile.activeSessionId || (profile.sessionExpiresAt && Date.parse(profile.sessionExpiresAt) <= now);

  if (isNewAuthEvent) {
    profile.signInCount = (Number(profile.signInCount) || 0) + 1;
    profile.signInCountToday = (Number(profile.signInCountToday) || 0) + 1;
    profile.lastSignInAt = new Date(authAt).toISOString();

    const sessionId = crypto.randomUUID();
    const sessionStart = new Date(now).toISOString();
    const expiresAt = new Date(now + sessionTtlMs).toISOString();

    // Close any prior unclosed active session for this user cleanly
    if (profile.activeSessionId) {
      const prior = store.loginHistory.find(item => item && item.sessionId === profile.activeSessionId && !item.sessionEnd);
      if (prior) prior.sessionEnd = sessionStart;
    }

    profile.activeSessionId = sessionId;
    profile.sessionStartedAt = sessionStart;
    profile.sessionExpiresAt = expiresAt;
    profile.lastSeenAt = sessionStart;

    store.loginHistory.unshift({
      id: crypto.randomUUID(),
      uid: profile.uid,
      email: profile.email || claims?.email || '',
      at: new Date(authAt).toISOString(),
      provider: provider || 'unknown',
      providerLabel: formatAuthProvider(provider),
      status: 'success',
      sessionId,
      sessionStart,
      sessionEnd: null,
      expiresAt,
      ip: clientIpFromReq(req),
      userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 240),
      deviceSummary: summarizeUserAgent(req?.headers?.['user-agent']),
    });
    if (store.loginHistory.length > MAX_LOGIN_HISTORY) store.loginHistory = store.loginHistory.slice(0, MAX_LOGIN_HISTORY);
    changed = true;
  } else if (needsSessionInit && explicit) {
    // Re-open session without incrementing login counter when existing token is reused across logout/login
    const sessionId = crypto.randomUUID();
    const sessionStart = new Date(now).toISOString();
    const expiresAt = new Date(now + sessionTtlMs).toISOString();
    profile.activeSessionId = sessionId;
    profile.sessionStartedAt = sessionStart;
    profile.sessionExpiresAt = expiresAt;
    profile.lastSeenAt = sessionStart;
    changed = true;
  } else if (now - (Date.parse(profile.lastSeenAt || '') || 0) >= 30_000) {
    profile.lastSeenAt = new Date(now).toISOString();
    if (!profile.activeSessionId) {
      profile.activeSessionId = crypto.randomUUID();
      profile.sessionStartedAt = profile.lastSeenAt;
      profile.sessionExpiresAt = new Date(now + sessionTtlMs).toISOString();
    }
    changed = true;
  }

  return changed;
}

function recordPresenceHeartbeat({ store, profile, claims, req, sessionTtlMs = DEFAULT_SESSION_TTL_MS, now = Date.now() }) {
  ensureStoreSchema(store);
  let changed = false;
  const authChanged = recordLoginEvent({ store, profile, claims, req, sessionTtlMs, now });
  if (authChanged) changed = true;

  if (!profile.activeSessionId) {
    const sid = crypto.randomUUID();
    profile.activeSessionId = sid;
    profile.sessionStartedAt = new Date(now).toISOString();
    profile.sessionExpiresAt = new Date(now + sessionTtlMs).toISOString();
    changed = true;
  }
  const iso = new Date(now).toISOString();
  profile.lastSeenAt = iso;
  changed = true;
  return changed;
}

function closeActiveSession({ store, profile, now = Date.now() }) {
  ensureStoreSchema(store);
  if (!profile) return false;
  const iso = new Date(now).toISOString();
  if (profile.activeSessionId) {
    const entry = store.loginHistory.find(item => item && item.sessionId === profile.activeSessionId && !item.sessionEnd);
    if (entry) entry.sessionEnd = iso;
  }
  profile.activeSessionId = null;
  profile.sessionExpiresAt = iso;
  return true;
}

function recordFailedLogin({ store, indexes, email, provider, reason, req, now = Date.now() }) {
  ensureStoreSchema(store);
  const cleanEmail = String(email || '').trim().toLowerCase().slice(0, 120);
  const uid = (indexes?.byEmail && cleanEmail ? indexes.byEmail.get(cleanEmail) : null) ||
    Object.values(store.profiles || {}).find(p => String(p.email || '').toLowerCase() === cleanEmail)?.uid ||
    null;
  const normProv = normalizeProviderId(provider);
  const entry = {
    id: crypto.randomUUID(),
    uid,
    email: cleanEmail,
    at: new Date(now).toISOString(),
    provider: normProv || 'unknown',
    providerLabel: formatAuthProvider(normProv),
    status: 'failed',
    sessionId: null,
    sessionStart: null,
    sessionEnd: null,
    expiresAt: null,
    ip: clientIpFromReq(req),
    userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 240),
    deviceSummary: summarizeUserAgent(req?.headers?.['user-agent']),
    failureReason: String(reason || 'auth_failed').slice(0, 120),
  };
  store.loginHistory.unshift(entry);
  if (store.loginHistory.length > MAX_LOGIN_HISTORY) store.loginHistory = store.loginHistory.slice(0, MAX_LOGIN_HISTORY);
  return entry;
}

function isUserOnline(profile, now = Date.now(), onlineTimeoutMs = DEFAULT_ONLINE_TIMEOUT_MS) {
  if (!profile) return false;
  if (!profile.activeSessionId) return false;
  const expMs = Date.parse(profile.sessionExpiresAt || '');
  if (!Number.isFinite(expMs) || expMs <= now) return false;
  const seenMs = Date.parse(profile.lastSeenAt || '');
  if (!Number.isFinite(seenMs)) return false;
  return (now - seenMs) <= onlineTimeoutMs;
}

function recordTokenUsage({ store, uid, activityId, provider, model, type, photonCredits = 0, providerTokens, fallbackInputChars = 0, fallbackOutputChars = 0, at = new Date().toISOString() }) {
  ensureStoreSchema(store);
  const pt = providerTokens && typeof providerTokens === 'object' ? providerTokens : {};
  const rawIn = Number(pt.inputTokens ?? pt.input_tokens) || 0;
  const rawOut = Number(pt.outputTokens ?? pt.output_tokens) || 0;
  const rawTotal = Number(pt.totalTokens ?? pt.total_tokens) || (rawIn + rawOut);

  let inputTokens = rawIn;
  let outputTokens = rawOut;
  let totalTokens = rawTotal;
  let estimated = Boolean(pt.estimated);

  if (totalTokens <= 0) {
    // Documented character-based estimation (approx 4 chars/token) marked explicitly as estimated
    inputTokens = Math.max(1, Math.ceil(Number(fallbackInputChars || 0) / 4));
    outputTokens = Math.max(1, Math.ceil(Number(fallbackOutputChars || 0) / 4));
    totalTokens = inputTokens + outputTokens;
    estimated = true;
  } else if (inputTokens + outputTokens !== totalTokens) {
    if (inputTokens === 0 && outputTokens === 0) {
      inputTokens = totalTokens;
    } else {
      totalTokens = inputTokens + outputTokens;
    }
  }

  const record = {
    id: crypto.randomUUID(),
    activityId: activityId || null,
    uid,
    at,
    provider: String(provider || 'unknown').toLowerCase(),
    model: String(model || ''),
    type: String(type || 'chat'),
    photonCredits: Number(photonCredits) || 0,
    inputTokens,
    outputTokens,
    totalTokens,
    estimated,
  };

  store.tokenUsageLogs.unshift(record);
  if (store.tokenUsageLogs.length > MAX_TOKEN_LOGS) store.tokenUsageLogs = store.tokenUsageLogs.slice(0, MAX_TOKEN_LOGS);
  return record;
}

function computeUserTokenStats(usageRecords, timezone = 'Asia/Kolkata', now = Date.now()) {
  const todayKey = localDateKey(now, timezone);
  const monthKey = todayKey.slice(0, 7);

  const emptyBucket = () => ({ input: 0, output: 0, total: 0, actualTotal: 0, estimatedTotal: 0, requests: 0, photonCredits: 0 });
  const daily = emptyBucket();
  const monthly = emptyBucket();
  const lifetime = emptyBucket();
  const byProvider = {};

  for (const r of usageRecords || []) {
    if (!r) continue;
    const input = Math.max(0, Number(r.inputTokens) || 0);
    const output = Math.max(0, Number(r.outputTokens) || 0);
    const total = Math.max(0, Number(r.totalTokens) || (input + output));
    const credits = Number(r.photonCredits) || 0;
    const est = r.estimated === true;
    const day = localDateKey(r.at || now, timezone);
    const mon = day.slice(0, 7);

    const addTo = bucket => {
      bucket.input += input;
      bucket.output += output;
      bucket.total += total;
      if (est) bucket.estimatedTotal += total;
      else bucket.actualTotal += total;
      bucket.requests += 1;
      bucket.photonCredits += credits;
    };

    addTo(lifetime);
    if (mon === monthKey) addTo(monthly);
    if (day === todayKey) addTo(daily);

    const provKey = String(r.provider || 'unknown').toLowerCase();
    if (!byProvider[provKey]) byProvider[provKey] = emptyBucket();
    addTo(byProvider[provKey]);
  }

  return { daily, monthly, lifetime, byProvider };
}

function resolveSubscriptionView(profile, subsForUser, plans) {
  const freePlan = plans.find(p => p.id === 'basic') || { id: 'basic', name: 'Free', price: 0 };
  const list = Array.isArray(subsForUser) ? subsForUser : [];
  const profileSub = profile?.subscription && typeof profile.subscription === 'object' ? profile.subscription : null;

  // Find latest verified paid subscription (paymentTaken must be true & status active/paid)
  const verifiedSub = list.find(s =>
    s && s.paymentTaken === true && ['active', 'paid', 'trialing'].includes(String(s.status || '').toLowerCase()) && s.billingStatus !== 'demo'
  ) || (profileSub && profileSub.paymentTaken === true && ['active', 'paid', 'trialing'].includes(String(profileSub.status || '').toLowerCase()) && profileSub.status !== 'demo' ? profileSub : null);

  if (verifiedSub) {
    const planDef = plans.find(p => p.id === verifiedSub.plan) || { id: verifiedSub.plan, name: verifiedSub.plan, price: verifiedSub.basePrice || 0, dailyTokens: verifiedSub.plan === 'premium' ? 2000 : 200 };
    const interval = verifiedSub.interval === 'yearly' ? 'yearly' : 'monthly';
    const price = Number(verifiedSub.basePrice ?? planDef.price * (interval === 'yearly' ? 12 : 1));
    const dailyTokens = Number(verifiedSub.grantedDailyTokens || planDef.dailyTokens || (planDef.id === 'premium' ? 2000 : planDef.id === 'pro' ? 200 : 50));
    return {
      effectivePlanId: planDef.id,
      effectivePlanName: planDef.name,
      isPaidActive: planDef.id !== 'basic',
      isDemoSelection: false,
      selectedPlanId: planDef.id,
      selectedPlanName: planDef.name,
      planPrice: price,
      interval,
      dailyTokens,
      status: verifiedSub.status || 'active',
      paymentStatus: verifiedSub.paymentStatus || 'paid',
      purchaseDate: verifiedSub.purchaseDate || verifiedSub.selectedAt || verifiedSub.lastPaymentAt || null,
      expiryDate: verifiedSub.expiryDate || null,
      nextRenewalDate: verifiedSub.nextRenewalDate || null,
    };
  }

  // Otherwise user is on Free plan — check if they made a demo selection
  const latestDemo = list[0] || profileSub;
  const demoPlanId = latestDemo?.plan && latestDemo.plan !== 'basic' ? latestDemo.plan : null;
  const demoPlanDef = demoPlanId ? plans.find(p => p.id === demoPlanId) : null;
  const freeDailyTokens = Number(freePlan.dailyTokens || 50);

  return {
    effectivePlanId: freePlan.id || 'basic',
    effectivePlanName: freePlan.name || 'Free',
    isPaidActive: false,
    isDemoSelection: Boolean(demoPlanDef),
    selectedPlanId: demoPlanDef ? demoPlanDef.id : (freePlan.id || 'basic'),
    selectedPlanName: demoPlanDef ? demoPlanDef.name : (freePlan.name || 'Free'),
    planPrice: 0,
    interval: 'none',
    dailyTokens: freeDailyTokens,
    status: demoPlanDef ? 'demo' : 'free',
    paymentStatus: demoPlanDef ? 'not_paid' : 'free',
    purchaseDate: latestDemo?.selectedAt || null,
    expiryDate: null,
    nextRenewalDate: null,
  };
}

function buildAdminUserSummary(profile, { indexes, plans, now = Date.now(), onlineTimeoutMs = DEFAULT_ONLINE_TIMEOUT_MS }) {
  const uid = profile.uid;
  const tz = profile.timezone || 'Asia/Kolkata';
  const todayKey = localDateKey(now, tz);
  const logins = indexes.loginsByUid.get(uid) || [];
  const successLogins = logins.filter(l => l.status === 'success');
  const usageList = indexes.usageByUid.get(uid) || [];
  const subs = indexes.subsByUid.get(uid) || [];

  const tokenStats = computeUserTokenStats(usageList, tz, now);
  const subView = resolveSubscriptionView(profile, subs, plans);
  const online = isUserOnline(profile, now, onlineTimeoutMs);

  const primaryProviderRaw = profile.primaryAuthProvider || profile.authProvider || '';
  const lastProviderRaw = profile.lastSignInProvider || profile.authProvider || '';
  const signInMethod = formatAuthProvider(lastProviderRaw);
  const primarySignInMethod = formatAuthProvider(primaryProviderRaw);
  const authMethods = Array.from(new Set((profile.authProviders || []).map(formatAuthProvider).filter(x => x && x !== 'Unknown')));
  if (!authMethods.length && signInMethod !== 'Unknown') authMethods.push(signInMethod);

  const totalSignIns = Math.max(Number(profile.signInCount) || 0, successLogins.filter(l => !l.migrated).length);
  const signInsToday = Math.max(
    profile.signInCountDate === todayKey ? Number(profile.signInCountToday) || 0 : 0,
    successLogins.filter(l => localDateKey(l.at, tz) === todayKey).length
  );

  const dailyTokens = Number(subView.dailyTokens || 50);
  const planCreditsToday = Number(tokenStats.daily.photonCredits || 0);
  const providerTokensToday = Number(tokenStats.daily.total || 0);
  const providerInputToday = Number(tokenStats.daily.input || 0);
  const providerOutputToday = Number(tokenStats.daily.output || 0);
  const tokensUsedToday = planCreditsToday > 0 ? planCreditsToday : (tokenStats.daily.photonCredits !== undefined ? 0 : providerTokensToday);
  const remainingTokensToday = Math.max(0, dailyTokens - tokensUsedToday);
  const usagePercentage = dailyTokens > 0 ? Math.min(100, Math.round((tokensUsedToday / dailyTokens) * 100)) : 0;

  return {
    uid,
    accountId: accountIdFor(uid),
    fullName: profile.fullName || '',
    username: profile.username || '',
    email: profile.email || '',
    photoURL: profile.photoURL || '',
    plan: subView.effectivePlanId,
    planName: subView.effectivePlanName,
    planPrice: subView.planPrice,
    planInterval: subView.interval,
    dailyTokens,
    tokensUsedToday,
    remainingTokensToday,
    usagePercentage,
    subscription: subView,
    signInMethod,
    primarySignInMethod,
    authMethods,
    signInCount: totalSignIns,
    signInCountToday: signInsToday,
    loggedInToday: signInsToday > 0,
    lastSignInAt: profile.lastSignInAt || (successLogins[0]?.at || null),
    lastSeenAt: profile.lastSeenAt || null,
    sessionExpiresAt: profile.sessionExpiresAt || null,
    online,
    joinedAt: profile.joinedAt || null,
    timezone: tz,
    todayTokens: tokensUsedToday,
    planCreditsToday,
    providerTokensToday,
    providerInputToday,
    providerOutputToday,
    monthlyTokens: tokenStats.monthly.total,
    lifetimeTokens: tokenStats.lifetime.total,
    tokenStats,
    activityCount: usageList.length,
  };
}

function queryAdminUsers({ store, indexes, plans, params = {}, now = Date.now(), onlineTimeoutMs = DEFAULT_ONLINE_TIMEOUT_MS }) {
  ensureStoreSchema(store);
  const allUsers = [];
  for (const profile of indexes.byUid.values()) {
    allUsers.push(buildAdminUserSummary(profile, { indexes, plans, now, onlineTimeoutMs }));
  }

  const totalDailyAllowance = allUsers.reduce((s, u) => s + (u.dailyTokens || 0), 0);
  const totalTokensToday = allUsers.reduce((s, u) => s + (u.planCreditsToday !== undefined ? u.planCreditsToday : u.todayTokens), 0);
  const totalProviderTokensToday = allUsers.reduce((s, u) => s + (u.providerTokensToday || 0), 0);
  const totalProviderInputToday = allUsers.reduce((s, u) => s + (u.providerInputToday || 0), 0);
  const totalProviderOutputToday = allUsers.reduce((s, u) => s + (u.providerOutputToday || 0), 0);
  const remainingTokens = Math.max(0, totalDailyAllowance - totalTokensToday);
  const percentUtilized = totalDailyAllowance > 0 ? Math.round((totalTokensToday / totalDailyAllowance) * 100) : 0;

  // Global aggregate metrics across all database records (independent of pagination)
  const kpis = {
    totalRegisteredUsers: allUsers.length,
    loggedInToday: allUsers.filter(u => u.loggedInToday).length,
    currentlyOnlineUsers: allUsers.filter(u => u.online).length,
    totalSignIns: allUsers.reduce((s, u) => s + u.signInCount, 0),
    totalTokensUsed: allUsers.reduce((s, u) => s + u.lifetimeTokens, 0),
    totalTokensToday,
    totalDailyAllowance,
    remainingTokens,
    percentUtilized,
    providerTokensToday: totalProviderTokensToday,
    providerInputToday: totalProviderInputToday,
    providerOutputToday: totalProviderOutputToday,
    activePaidSubscribers: allUsers.filter(u => u.subscription.isPaidActive).length,
    freePlanUsers: allUsers.filter(u => !u.subscription.isPaidActive).length,
  };

  // Apply filters
  const q = String(params.q || '').trim().toLowerCase();
  const planFilter = String(params.plan || 'all').toLowerCase();
  const statusFilter = String(params.status || 'all').toLowerCase();
  const providerFilter = String(params.provider || 'all').toLowerCase();
  const subStatusFilter = String(params.subStatus || 'all').toLowerCase();
  const regFrom = params.regFrom ? Date.parse(params.regFrom) : NaN;
  const regTo = params.regTo ? Date.parse(params.regTo + 'T23:59:59.999Z') : NaN;
  const lastFrom = params.lastSignInFrom ? Date.parse(params.lastSignInFrom) : NaN;
  const lastTo = params.lastSignInTo ? Date.parse(params.lastSignInTo + 'T23:59:59.999Z') : NaN;

  const filtered = allUsers.filter(u => {
    if (q) {
      const hay = `${u.fullName} ${u.email} ${u.accountId} ${u.uid} ${u.username}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (planFilter !== 'all') {
      if (planFilter === 'free' || planFilter === 'basic') {
        if (u.plan !== 'basic') return false;
      } else if (u.plan !== planFilter && u.subscription.selectedPlanId !== planFilter) {
        return false;
      }
    }
    if (statusFilter === 'online' && !u.online) return false;
    if (statusFilter === 'offline' && u.online) return false;
    if (providerFilter !== 'all') {
      const m = u.signInMethod.toLowerCase();
      const p = u.primarySignInMethod.toLowerCase();
      if (providerFilter === 'google') {
        if (!m.includes('google') && !p.includes('google')) return false;
      } else if (providerFilter === 'password' || providerFilter === 'gmail' || providerFilter === 'email') {
        if (!m.includes('password') && !m.includes('gmail') && !p.includes('password') && !p.includes('gmail')) return false;
      } else if (providerFilter === 'other') {
        if (m.includes('google') || m.includes('password') || m.includes('gmail')) return false;
      } else if (m !== providerFilter && p !== providerFilter) {
        return false;
      }
    }
    if (subStatusFilter === 'active' && !u.subscription.isPaidActive) return false;
    if (subStatusFilter === 'inactive' && u.subscription.isPaidActive) return false;
    if (subStatusFilter === 'demo' && !u.subscription.isDemoSelection) return false;

    const joinedMs = Date.parse(u.joinedAt || '');
    if (Number.isFinite(regFrom) && (!Number.isFinite(joinedMs) || joinedMs < regFrom)) return false;
    if (Number.isFinite(regTo) && (!Number.isFinite(joinedMs) || joinedMs > regTo)) return false;

    const lastMs = Date.parse(u.lastSignInAt || '');
    if (Number.isFinite(lastFrom) && (!Number.isFinite(lastMs) || lastMs < lastFrom)) return false;
    if (Number.isFinite(lastTo) && (!Number.isFinite(lastMs) || lastMs > lastTo)) return false;

    return true;
  });

  // Sort
  const sort = String(params.sort || 'last_sign_in').toLowerCase();
  filtered.sort((a, b) => {
    if (sort === 'newest') return (Date.parse(b.joinedAt || 0) || 0) - (Date.parse(a.joinedAt || 0) || 0);
    if (sort === 'sign_ins' || sort === 'most_sign_ins') return b.signInCount - a.signInCount;
    if (sort === 'tokens' || sort === 'highest_tokens' || sort === 'tokens_today') return (b.todayTokens - a.todayTokens) || (b.lifetimeTokens - a.lifetimeTokens);
    if (sort === 'lifetime_tokens') return b.lifetimeTokens - a.lifetimeTokens;
    return (Date.parse(b.lastSignInAt || b.joinedAt || 0) || 0) - (Date.parse(a.lastSignInAt || a.joinedAt || 0) || 0);
  });

  // Server-side pagination
  const pageSize = Math.max(1, Math.min(100, Number(params.pageSize) || 20));
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(1, Math.min(totalPages, Number(params.page) || 1));
  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);

  return {
    kpis,
    items,
    filteredAll: filtered,
    pagination: { total, page, pageSize, totalPages },
    onlineTimeoutMs,
  };
}

function getAdminUserDetails({ store, indexes, plans, uid, now = Date.now(), onlineTimeoutMs = DEFAULT_ONLINE_TIMEOUT_MS }) {
  ensureStoreSchema(store);
  const profile = indexes.byUid.get(uid);
  if (!profile) return null;

  const summary = buildAdminUserSummary(profile, { indexes, plans, now, onlineTimeoutMs });
  const logins = (indexes.loginsByUid.get(uid) || []).slice(0, 200);
  const usageLogs = (indexes.usageByUid.get(uid) || []).slice(0, 200);
  const subscriptions = (indexes.subsByUid.get(uid) || []).map(sub => {
    const planDef = plans.find(p => p.id === sub.plan) || { name: sub.plan };
    return { ...sub, planName: planDef.name };
  });

  return {
    user: summary,
    logins,
    usageLogs,
    subscriptions,
  };
}

function appendAdminAuditLog(store, { actor = 'admin', action, details = {} }) {
  ensureStoreSchema(store);
  store.adminAuditLogs.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    actor: String(actor).slice(0, 80),
    action: String(action || '').slice(0, 80),
    details,
  });
  if (store.adminAuditLogs.length > MAX_ADMIN_AUDIT_LOGS) {
    store.adminAuditLogs = store.adminAuditLogs.slice(0, MAX_ADMIN_AUDIT_LOGS);
  }
}

function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function xmlEscape(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatTabularExport(headers, rows, format = 'csv', sheetName = 'PHOTON_Export') {
  if (format === 'excel' || format === 'xls') {
    const xmlRows = [
      '<Row>' + headers.map(h => `<Cell><Data ss:Type="String">${xmlEscape(h)}</Data></Cell>`).join('') + '</Row>',
      ...rows.map(row => '<Row>' + row.map(val => {
        const isNum = typeof val === 'number' && Number.isFinite(val);
        const type = isNum ? 'Number' : 'String';
        return `<Cell><Data ss:Type="${type}">${xmlEscape(val)}</Data></Cell>`;
      }).join('') + '</Row>'),
    ].join('\n');

    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n<Worksheet ss:Name="${xmlEscape(sheetName.slice(0, 31))}">\n<Table>\n${xmlRows}\n</Table>\n</Worksheet>\n</Workbook>`;
    return {
      content,
      contentType: 'application/vnd.ms-excel; charset=utf-8',
      extension: 'xls',
    };
  }

  const lines = [
    headers.map(csvCell).join(','),
    ...rows.map(r => r.map(csvCell).join(',')),
  ];
  return {
    content: '\uFEFF' + lines.join('\r\n'),
    contentType: 'text/csv; charset=utf-8',
    extension: 'csv',
  };
}

function generateExportPayload({ scope = 'all', format = 'csv', store, indexes, plans, params = {}, now = Date.now(), onlineTimeoutMs = DEFAULT_ONLINE_TIMEOUT_MS }) {
  ensureStoreSchema(store);
  const cleanScope = ['all', 'filtered', 'logins', 'usage', 'subscriptions'].includes(scope) ? scope : 'all';

  if (cleanScope === 'logins') {
    const headers = ['Event ID', 'User ID', 'Email', 'Status', 'Auth Method', 'Date/Time', 'Session Start', 'Session End', 'Expires At', 'IP Address', 'Device'];
    const rows = (store.loginHistory || []).map(l => {
      const profile = indexes.byUid.get(l.uid);
      return [
        l.id || '',
        l.uid ? accountIdFor(l.uid) : 'Unknown',
        l.email || profile?.email || '',
        l.status || '',
        l.providerLabel || formatAuthProvider(l.provider),
        l.at || '',
        l.sessionStart || '',
        l.sessionEnd || '',
        l.expiresAt || '',
        l.ip || '',
        l.deviceSummary || '',
      ];
    });
    return { ...formatTabularExport(headers, rows, format, 'Sign-in History'), filename: `photon-signin-history.${format === 'csv' ? 'csv' : 'xls'}` };
  }

  if (cleanScope === 'usage') {
    const headers = ['Record ID', 'User ID', 'User Name', 'Email', 'Date/Time', 'Provider', 'Model', 'Type', 'Input Tokens', 'Output Tokens', 'Total Tokens', 'Usage Source', 'PHOTON Credits'];
    const rows = (store.tokenUsageLogs || []).map(r => {
      const profile = indexes.byUid.get(r.uid);
      return [
        accountIdFor(r.uid),
        profile?.uid || r.uid || '',
        profile?.fullName || '',
        profile?.email || '',
        r.at || '',
        r.provider || '',
        r.model || '',
        r.type || 'chat',
        Number(r.inputTokens) || 0,
        Number(r.outputTokens) || 0,
        Number(r.totalTokens) || 0,
        r.estimated ? 'Estimated' : 'Actual (Provider)',
        Number(r.photonCredits) || 0,
      ];
    });
    return { ...formatTabularExport(headers, rows, format, 'Token Usage'), filename: `photon-token-usage.${format === 'csv' ? 'csv' : 'xls'}` };
  }

  if (cleanScope === 'subscriptions') {
    const headers = ['Subscription ID', 'User ID', 'User Name', 'Email', 'Selected Plan', 'Billing Status', 'Payment Taken', 'Interval', 'Price (INR)', 'Selected / Purchase Date'];
    const rows = (store.subscriptions || []).map(s => {
      const profile = indexes.byUid.get(s.uid);
      const planDef = plans.find(p => p.id === s.plan);
      return [
        s.id || '',
        accountIdFor(s.uid),
        profile?.fullName || '',
        profile?.email || '',
        planDef?.name || s.plan || '',
        s.status || s.billingStatus || '',
        s.paymentTaken === true ? 'Verified Paid' : 'Unverified / Demo',
        s.interval || 'none',
        Number(s.basePrice ?? s.planPrice ?? 0),
        s.purchaseDate || s.selectedAt || '',
      ];
    });
    return { ...formatTabularExport(headers, rows, format, 'Subscriptions'), filename: `photon-subscriptions.${format === 'csv' ? 'csv' : 'xls'}` };
  }

  // 'all' or 'filtered' users
  const queryParams = cleanScope === 'filtered' ? { ...params, page: 1, pageSize: 10000 } : { page: 1, pageSize: 10000 };
  const res = queryAdminUsers({ store, indexes, plans, params: queryParams, now, onlineTimeoutMs });
  const headers = ['User ID', 'Full Name', 'Email', 'Verified Plan', 'Subscription Status', 'Primary Auth Method', 'Latest Sign-in Method', 'Total Sign-ins', 'Sign-ins Today', 'Daily Tokens', 'Monthly Tokens', 'Lifetime Tokens', 'Input Tokens', 'Output Tokens', 'Account Status', 'Last Sign-in', 'Last Activity', 'Created Date'];
  const rows = res.filteredAll.map(u => [
    u.accountId,
    u.fullName,
    u.email,
    u.planName,
    u.subscription.isPaidActive ? 'Active Paid' : u.subscription.isDemoSelection ? `Demo (${u.subscription.selectedPlanName})` : 'Free',
    u.primarySignInMethod,
    u.signInMethod,
    u.signInCount,
    u.signInCountToday,
    u.todayTokens,
    u.monthlyTokens,
    u.lifetimeTokens,
    u.tokenStats.lifetime.input,
    u.tokenStats.lifetime.output,
    u.online ? 'Online' : 'Offline',
    u.lastSignInAt || '',
    u.lastSeenAt || '',
    u.joinedAt || '',
  ]);
  const tag = cleanScope === 'filtered' ? 'filtered-users' : 'all-users';
  return { ...formatTabularExport(headers, rows, format, 'Users Report'), filename: `photon-${tag}.${format === 'csv' ? 'csv' : 'xls'}` };
}

module.exports = {
  DEFAULT_ONLINE_TIMEOUT_MS,
  DEFAULT_SESSION_TTL_MS,
  readOnlineTimeoutMs,
  readSessionTtlMs,
  accountIdFor,
  sanitizePhotoUrl,
  normalizeProviderId,
  formatAuthProvider,
  clientIpFromReq,
  summarizeUserAgent,
  ensureStoreSchema,
  buildStoreIndexes,
  recordLoginEvent,
  recordPresenceHeartbeat,
  closeActiveSession,
  recordFailedLogin,
  isUserOnline,
  recordTokenUsage,
  computeUserTokenStats,
  resolveSubscriptionView,
  buildAdminUserSummary,
  queryAdminUsers,
  getAdminUserDetails,
  appendAdminAuditLog,
  formatTabularExport,
  generateExportPayload,
};
