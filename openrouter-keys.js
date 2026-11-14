'use strict';
// OpenRouter multi-key management for PHOTON AI (up to 10 keys).
//
// Security model (same as gemini-keys.js, whose helpers are reused)
// -----------------------------------------------------------------
// * Secrets live only in backend environment variables: OPENROUTER_API_KEY (slot 1) and
//   OPENROUTER_API_KEY_2 ... OPENROUTER_API_KEY_10, loaded from API.env / .env at startup.
// * The admin API writes new keys to the server-side secret file (API.env, mode 0600) and to
//   process.env. Secrets are never returned over HTTP, written to logs or put in error messages.
// * Only masked fingerprints are shown. Non-secret admin state (label, enabled flag, validation
//   result, counters, last error) is stored in .photon-openrouter-keys.json keyed by a SHA-256
//   fingerprint; it contains no key material.
//
// Quota note
// ----------
// Several keys may belong to the same OpenRouter account and then share one credit balance and one
// set of rate limits. The key manager therefore NEVER moves to another key because of an HTTP 429
// or a billing error. Failover is limited to key-specific failures (invalid / revoked / forbidden
// keys) and one hop for transient network or 5xx failures.

const fs = require('node:fs');
const path = require('node:path');
const { maskKey, fingerprint, resolveEnvFile, upsertEnvValue, removeEnvValue } = require('./gemini-keys');

const MAX_KEYS = 10;
const BASE_ENV = 'OPENROUTER_API_KEY';
const STATE_FILE = '.photon-openrouter-keys.json';
const STATE_VERSION = 1;
const KEY_FORMAT = /^sk-or-[A-Za-z0-9_-]{16,200}$/;
const ENV_PATTERN = /^OPENROUTER_API_KEY(?:_(\d+))?$/;
const AUTH_CODES = new Set(['invalid_api_key', 'provider_forbidden']);
const TRANSIENT_CODES = new Set(['provider_unavailable', 'network_error', 'provider_timeout']);
const FAILURE_THRESHOLD = 3;           // consecutive transient failures before a key is paused
const COOLDOWN_BASE_MS = 30 * 1000;    // first pause; doubles per extra failure
const COOLDOWN_CAP_MS = 10 * 60 * 1000;
const RECENT_LIMIT = 50;
const SAVE_DELAY_MS = 3000;

function isPlausibleKey(value) { return KEY_FORMAT.test(String(value || '').trim()); }
function envNameForSlot(slot) { return slot === 1 ? BASE_ENV : `${BASE_ENV}_${slot}`; }

// Slot 1 is OPENROUTER_API_KEY; slots 2..10 are OPENROUTER_API_KEY_<n>. Anything else that looks
// like a key variable (_1, _0, _11 ...) is reported in `ignored` instead of being silently used.
function discoverSlots(env = process.env) {
  const keys = [];
  const ignored = [];
  for (const [name, raw] of Object.entries(env)) {
    const match = ENV_PATTERN.exec(name);
    if (!match) continue;
    const value = String(raw || '').trim();
    if (!value) continue;
    const slot = match[1] === undefined ? 1 : Number(match[1]);
    if (slot < 1 || slot > MAX_KEYS || (match[1] !== undefined && slot === 1)) { ignored.push(name); continue; }
    keys.push({ slot, envName: name, value });
  }
  keys.sort((a, b) => a.slot - b.slot);
  return { keys, ignored: ignored.sort() };
}

function emptyState() { return { version: STATE_VERSION, keys: {}, updatedAt: null }; }

function writeJson(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { fs.renameSync(tmp, file); } catch { fs.rmSync(file, { force: true }); fs.renameSync(tmp, file); }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

function keyError(code, message) { const error = new Error(message); error.code = code; return error; }

function createOpenRouterKeyStore({ dir = process.cwd(), env = process.env, logger = console, envFile, stateFile, persist = true } = {}) {
  const secretFile = envFile || resolveEnvFile(dir);
  const statePath = stateFile || path.join(dir, STATE_FILE);
  let state = loadState();
  let saveTimer = null;

  function loadState() {
    if (!persist) return emptyState();
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.keys && typeof parsed.keys === 'object') return { version: STATE_VERSION, keys: parsed.keys, updatedAt: parsed.updatedAt || null };
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.error(JSON.stringify({ category: 'openrouter_key_state', code: error?.code || 'read_failed' }));
    }
    return emptyState();
  }
  function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!persist) return;
    state.updatedAt = new Date().toISOString();
    try { writeJson(statePath, state); } catch (error) { logger.error(JSON.stringify({ category: 'openrouter_key_state', code: error?.code || 'write_failed' })); }
  }
  function saveSoon() {
    if (!persist || saveTimer) return;
    saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
  }
  function entryFor(secret) {
    const id = fingerprint(secret);
    if (!state.keys[id]) state.keys[id] = { label: '', enabled: true, addedAt: new Date().toISOString(), lastValidation: null };
    return { id, record: state.keys[id] };
  }

  function all() {
    return discoverSlots(env).keys.map(item => {
      const { id, record } = entryFor(item.value);
      return {
        id, slot: item.slot, envName: item.envName,
        label: String(record.label || '').trim() || `Key ${item.slot}`,
        masked: maskKey(item.value),
        enabled: record.enabled !== false,
        addedAt: record.addedAt || null,
        lastValidation: record.lastValidation || null,
        lastOkAt: record.lastOkAt || null,
        lastUsedAt: record.lastUsedAt || null,
        stats: { successCount: 0, failureCount: 0, lastSuccessAt: null, lastError: null, ...(record.stats || {}) },
        secret: item.value,
      };
    });
  }
  function list() { return all().map(({ secret, ...safe }) => safe); }
  function ignoredEnvNames() { return discoverSlots(env).ignored; }
  function secretFor(id) { return all().find(item => item.id === id)?.secret || null; }

  function freeSlot() {
    const used = new Set(discoverSlots(env).keys.map(item => item.slot));
    for (let slot = 1; slot <= MAX_KEYS; slot++) if (!used.has(slot)) return slot;
    return null;
  }

  function add({ label, key } = {}) {
    const secret = String(key || '').trim();
    if (!secret) throw keyError('invalid_key', 'API key is required.');
    if (!isPlausibleKey(secret)) throw keyError('invalid_key', 'That does not look like an OpenRouter API key (expected sk-or-...).');
    if (discoverSlots(env).keys.some(item => item.value === secret)) throw keyError('duplicate_key', 'That key is already configured.');
    const slot = freeSlot();
    if (!slot) throw keyError('key_limit', `PHOTON supports at most ${MAX_KEYS} OpenRouter keys. Delete one before adding another.`);
    const envName = envNameForSlot(slot);
    if (persist) upsertEnvValue(secretFile, envName, secret);
    env[envName] = secret;
    const { id, record } = entryFor(secret);
    record.label = String(label || '').trim().slice(0, 40) || `Key ${slot}`;
    record.enabled = true;
    record.addedAt = new Date().toISOString();
    record.lastValidation = null;
    saveNow();
    return list().find(item => item.id === id);
  }

  function update(id, { label, enabled, key } = {}) {
    const current = all().find(item => item.id === id);
    if (!current) throw keyError('not_found', 'That OpenRouter key no longer exists.');
    const record = state.keys[id];
    if (label !== undefined) record.label = String(label || '').trim().slice(0, 40);
    if (enabled !== undefined) record.enabled = Boolean(enabled);
    let nextId = id;
    if (key !== undefined && String(key).trim() && String(key).trim() !== current.secret) {
      const secret = String(key).trim();
      if (!isPlausibleKey(secret)) throw keyError('invalid_key', 'That does not look like an OpenRouter API key (expected sk-or-...).');
      if (discoverSlots(env).keys.some(item => item.value === secret && item.envName !== current.envName)) throw keyError('duplicate_key', 'That key is already configured.');
      if (persist) upsertEnvValue(secretFile, current.envName, secret);
      env[current.envName] = secret;
      const next = entryFor(secret);
      next.record.label = record.label || current.label;
      next.record.enabled = record.enabled !== false;
      next.record.addedAt = current.addedAt;
      next.record.lastValidation = null;
      next.record.stats = undefined;
      delete state.keys[id];
      nextId = next.id;
    }
    saveNow();
    return list().find(item => item.id === nextId) || null;
  }

  function remove(id) {
    const current = all().find(item => item.id === id);
    if (!current) throw keyError('not_found', 'That OpenRouter key no longer exists.');
    if (persist) removeEnvValue(secretFile, current.envName);
    delete env[current.envName];
    delete state.keys[id];
    saveNow();
    return { id, envName: current.envName, slot: current.slot };
  }

  function markUsed(id) { if (state.keys[id]) { state.keys[id].lastUsedAt = new Date().toISOString(); saveSoon(); } }

  function recordValidation(id, status, extra = {}) {
    if (!state.keys[id]) return;
    const at = new Date().toISOString();
    if (status === 'ok') state.keys[id].lastOkAt = at;
    state.keys[id].lastValidation = {
      status: String(status || 'unknown'),
      at,
      message: extra.message ? String(extra.message).slice(0, 200) : null,
      isFreeTier: typeof extra.isFreeTier === 'boolean' ? extra.isFreeTier : null,
    };
    saveNow();
  }

  // Counters and last error for the admin table. Errors are saved promptly, successes are batched.
  function recordResult(id, ok, { code, message } = {}) {
    const record = state.keys[id];
    if (!record) return;
    const stats = record.stats = { successCount: 0, failureCount: 0, lastSuccessAt: null, lastError: null, ...(record.stats || {}) };
    const at = new Date().toISOString();
    if (ok) { stats.successCount += 1; stats.lastSuccessAt = at; saveSoon(); }
    else { stats.failureCount += 1; stats.lastError = { code: String(code || 'unknown'), message: message ? String(message).slice(0, 200) : null, at }; saveNow(); }
  }

  return { all, list, ignoredEnvNames, secretFor, add, update, remove, markUsed, recordValidation, recordResult, flush: saveNow, secretFile, statePath, MAX_KEYS };
}

// Centralized key manager: eligibility, round-robin selection, failure bookkeeping and cooldowns.
function createKeyManager({ store, now = Date.now } = {}) {
  if (!store) throw new Error('A key store is required');
  const runtime = new Map();   // id -> { consecutiveFailures, cooldownUntil, rateLimitedUntil }
  const recent = [];
  let pointer = 0;             // slot of the key used last; selection continues after it

  function rt(id) {
    if (!runtime.has(id)) runtime.set(id, { consecutiveFailures: 0, cooldownUntil: 0, rateLimitedUntil: 0 });
    return runtime.get(id);
  }

  // disabled | invalid | cooling_down | unchecked | active | unverified
  function healthOf(item) {
    if (!item.enabled) return 'disabled';
    const validation = item.lastValidation;
    if (validation && AUTH_CODES.has(validation.status)) return 'invalid';
    if (rt(item.id).cooldownUntil > now()) return 'cooling_down';
    if (!validation) return 'unchecked';
    if (validation.status === 'ok') return 'active';
    return 'unverified';   // last check failed for a transient reason: says nothing about the key itself
  }
  const eligible = item => { const health = healthOf(item); return health === 'active' || health === 'unverified'; };

  // Round-robin over eligible keys by slot order. `exclude` keeps one request from reusing a key.
  function acquire({ exclude = [] } = {}) {
    const candidates = store.all().filter(item => eligible(item) && !exclude.includes(item.id));
    if (!candidates.length) return null;
    const pick = candidates.find(item => item.slot > pointer) || candidates[0];
    pointer = pick.slot;
    store.markUsed(pick.id);
    return pick;
  }

  function pushRecent(entry) {
    recent.unshift({ at: new Date(now()).toISOString(), ...entry });
    if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
  }

  function reportSuccess(id, info = {}) {
    const state = rt(id);
    state.consecutiveFailures = 0; state.cooldownUntil = 0; state.rateLimitedUntil = 0;
    const item = store.all().find(entry => entry.id === id);
    if (item && (!item.lastValidation || item.lastValidation.status !== 'ok')) store.recordValidation(id, 'ok', { message: null });
    store.recordResult(id, true);
    pushRecent({ status: 'ok', keyId: id, slot: item?.slot ?? null, ...info });
  }

  function reportFailure(id, code, { message, retryAfterMs, ...info } = {}) {
    const state = rt(id);
    const item = store.all().find(entry => entry.id === id);
    if (AUTH_CODES.has(code)) {
      store.recordValidation(id, code, { message });
    } else if (code === 'quota_or_rate_limit') {
      state.rateLimitedUntil = now() + (Number.isFinite(retryAfterMs) ? retryAfterMs : 0);   // informational only
    } else if (TRANSIENT_CODES.has(code)) {
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= FAILURE_THRESHOLD) {
        state.cooldownUntil = now() + Math.min(COOLDOWN_CAP_MS, COOLDOWN_BASE_MS * Math.pow(2, state.consecutiveFailures - FAILURE_THRESHOLD));
      }
    }
    store.recordResult(id, false, { code, message });
    pushRecent({ status: code, keyId: id, slot: item?.slot ?? null, ...info });
  }

  // A manual test that succeeds clears pauses; a failed test only updates the validation record.
  function clear(id) { runtime.delete(id); }

  function describe(item) {
    const state = rt(item.id);
    const health = healthOf(item);
    return {
      state: health,
      cooldownUntil: health === 'cooling_down' ? new Date(state.cooldownUntil).toISOString() : null,
      rateLimitedUntil: state.rateLimitedUntil > now() ? new Date(state.rateLimitedUntil).toISOString() : null,
      consecutiveFailures: state.consecutiveFailures,
    };
  }

  function decorated() { return store.list().map(item => ({ ...item, health: describe(item) })); }

  function summary() {
    const items = store.list();
    const states = items.map(item => healthOf(item));
    const lastSuccessAt = items.map(item => item.stats?.lastSuccessAt).filter(Boolean).sort().pop() || null;
    return {
      totalKeys: items.length,
      enabledKeys: items.filter(item => item.enabled).length,
      validKeys: states.filter(state => state === 'active').length,
      invalidKeys: states.filter(state => state === 'invalid').length,
      temporarilyUnavailableKeys: states.filter(state => state === 'cooling_down' || state === 'unverified').length,
      uncheckedKeys: states.filter(state => state === 'unchecked').length,
      lastSuccessfulRequestAt: lastSuccessAt,
      ignoredEnvNames: store.ignoredEnvNames(),
    };
  }

  return { acquire, reportSuccess, reportFailure, clear, healthOf, eligible, describe, decorated, summary, recentRequests: () => recent.slice() };
}

module.exports = {
  createOpenRouterKeyStore, createKeyManager, discoverSlots, isPlausibleKey, envNameForSlot,
  MAX_KEYS, BASE_ENV, STATE_FILE, KEY_FORMAT, AUTH_CODES, TRANSIENT_CODES, FAILURE_THRESHOLD, COOLDOWN_BASE_MS, COOLDOWN_CAP_MS,
};
