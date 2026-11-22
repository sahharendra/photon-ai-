'use strict';
// Gemini multi-key management for PHOTON AI.
//
// Security model
// --------------
// * API keys live only in backend environment variables (GEMINI_API_KEY, GEMINI_API_KEY_2, ...)
//   loaded from API.env / .env by loadEnvFiles(). They are never stored in photon-profile-data.json,
//   never returned to a browser, never written to logs, and never included in error messages.
// * The admin API can add / edit / delete keys, but doing so writes to the server-side secret file
//   (API.env) and updates process.env in memory. That file is created with 0600 permissions.
// * Only masked fingerprints (first 4 + last 4 characters) are ever displayed after submission.
// * Non-secret admin state (label, enabled flag, last validation result) is kept in
//   .photon-gemini-keys.json, keyed by a SHA-256 fingerprint. That file contains no key material.
//
// Quota note
// ----------
// Several keys can belong to the same Google Cloud project and therefore share one quota pool.
// This module never rotates keys to escape a quota or rate limit; rotation is only used for
// authentication failures (invalid / revoked / forbidden keys).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ENV_PATTERN = /^GEMINI_API_KEY(?:_(\d+))?$/;
const STATE_VERSION = 1;
const STATE_FILE = '.photon-gemini-keys.json';
const KEY_FORMAT = /^[A-Za-z0-9_-]{20,200}$/;

function fingerprint(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 16);
}

function maskKey(secret) {
  const value = String(secret || '');
  if (value.length < 8) return '••••••••';
  return value.slice(0, 4) + '••••••' + value.slice(-4);
}

function isPlausibleKey(value) {
  return KEY_FORMAT.test(String(value || '').trim());
}

// Discovers every configured key from the environment. Ordering follows the numeric suffix so
// GEMINI_API_KEY is "Primary" and GEMINI_API_KEY_2, _3, ... follow. Any configured count works.
function discoverKeys(env = process.env) {
  const found = [];
  for (const [name, raw] of Object.entries(env)) {
    const match = ENV_PATTERN.exec(name);
    if (!match) continue;
    const value = String(raw || '').trim();
    if (!value) continue;
    const suffix = match[1] ? Number(match[1]) : 1;
    found.push({ envName: name, suffix, value });
  }
  found.sort((a, b) => a.suffix - b.suffix || a.envName.localeCompare(b.envName));
  return found;
}

function resolveEnvFile(dir) {
  for (const name of ['API.env', '.env']) {
    const candidate = path.join(dir, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return path.join(dir, 'API.env');
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function writeSecret(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* Windows: best effort */ }
    try {
      fs.renameSync(tmp, file);
    } catch (error) {
      // Windows cannot atomically replace an existing file with rename(); fall back to a copy.
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

function envLineRegex(name) {
  return new RegExp('^\\s*(?:#\\s*)?(?:export\\s+)?' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=');
}

function upsertEnvValue(file, name, value) {
  const text = readText(file);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  const re = envLineRegex(name);
  const line = name + '=' + value;
  let replaced = false;
  const out = lines.map(existing => {
    if (re.test(existing)) { replaced = true; return line; }
    return existing;
  });
  if (!replaced) {
    while (out.length && out[out.length - 1] === '') out.pop();
    out.push(line, '');
  }
  writeSecret(file, out.join(newline) + (out[out.length - 1] === '' ? '' : newline));
}

function removeEnvValue(file, name) {
  const text = readText(file);
  if (!text) return;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const re = envLineRegex(name);
  const out = text.split(/\r?\n/).filter(line => !re.test(line));
  writeSecret(file, out.join(newline));
}

function emptyState() {
  return { version: STATE_VERSION, keys: {}, updatedAt: null };
}

function createGeminiKeyStore({ dir = process.cwd(), env = process.env, logger = console, envFile, stateFile } = {}) {
  const secretFile = envFile || resolveEnvFile(dir);
  const statePath = stateFile || path.join(dir, STATE_FILE);
  let state = loadState();

  function loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.keys && typeof parsed.keys === 'object') {
        return { version: STATE_VERSION, keys: parsed.keys, updatedAt: parsed.updatedAt || null };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.error(JSON.stringify({ category: 'gemini_key_state', code: error?.code || 'read_failed' }));
    }
    return emptyState();
  }

  function saveState() {
    state.updatedAt = new Date().toISOString();
    try { writeSecret(statePath, JSON.stringify(state, null, 2)); }
    catch (error) { logger.error(JSON.stringify({ category: 'gemini_key_state', code: error?.code || 'write_failed' })); }
  }

  function entryFor(secret) {
    const id = fingerprint(secret);
    if (!state.keys[id]) state.keys[id] = { label: '', enabled: true, addedAt: new Date().toISOString(), lastValidation: null };
    return { id, record: state.keys[id] };
  }

  // Internal view: includes the secret. Never returned over HTTP.
  function all() {
    return discoverKeys(env).map((item, index) => {
      const { id, record } = entryFor(item.value);
      const fallbackLabel = item.suffix <= 1 ? 'Primary' : 'Key ' + item.suffix;
      return {
        id,
        envName: item.envName,
        index,
        label: String(record.label || '').trim() || fallbackLabel,
        masked: maskKey(item.value),
        enabled: record.enabled !== false,
        addedAt: record.addedAt || null,
        lastValidation: record.lastValidation || null,
        lastUsedAt: record.lastUsedAt || null,
        secret: item.value,
      };
    });
  }

  // Public view: safe to return over HTTP.
  function list() {
    return all().map(({ secret, ...safe }) => safe);
  }

  function enabled(secretList) {
    return all().filter(item => item.enabled);
  }

  function secretFor(id) {
    const found = all().find(item => item.id === id);
    return found ? found.secret : null;
  }

  function nextEnvName() {
    const used = new Set(discoverKeys(env).map(item => item.envName));
    if (!used.has('GEMINI_API_KEY')) return 'GEMINI_API_KEY';
    let n = 2;
    while (used.has('GEMINI_API_KEY_' + n)) n++;
    return 'GEMINI_API_KEY_' + n;
  }

  function add({ label, key } = {}) {
    const secret = String(key || '').trim();
    if (!secret) { const error = new Error('API key is required.'); error.code = 'invalid_key'; throw error; }
    if (!isPlausibleKey(secret)) { const error = new Error('That does not look like a Gemini API key.'); error.code = 'invalid_key'; throw error; }
    if (discoverKeys(env).some(item => item.value === secret)) { const error = new Error('That key is already configured.'); error.code = 'duplicate_key'; throw error; }
    const envName = nextEnvName();
    upsertEnvValue(secretFile, envName, secret);
    env[envName] = secret;
    const { id, record } = entryFor(secret);
    record.label = String(label || '').trim().slice(0, 40) || (envName === 'GEMINI_API_KEY' ? 'Primary' : 'Key ' + envName.replace('GEMINI_API_KEY_', ''));
    record.enabled = true;
    record.addedAt = new Date().toISOString();
    saveState();
    return list().find(item => item.id === id);
  }

  function update(id, { label, enabled: isEnabled, key } = {}) {
    const current = all().find(item => item.id === id);
    if (!current) { const error = new Error('That Gemini key no longer exists.'); error.code = 'not_found'; throw error; }
    const record = state.keys[id];
    if (label !== undefined) record.label = String(label || '').trim().slice(0, 40);
    if (isEnabled !== undefined) record.enabled = Boolean(isEnabled);
    let nextId = id;
    if (key !== undefined && String(key).trim() && String(key).trim() !== current.secret) {
      const secret = String(key).trim();
      if (!isPlausibleKey(secret)) { const error = new Error('That does not look like a Gemini API key.'); error.code = 'invalid_key'; throw error; }
      if (discoverKeys(env).some(item => item.value === secret && item.envName !== current.envName)) { const error = new Error('That key is already configured.'); error.code = 'duplicate_key'; throw error; }
      // Rotate in place: keep the same environment variable so ordering is stable.
      upsertEnvValue(secretFile, current.envName, secret);
      env[current.envName] = secret;
      const next = entryFor(secret);
      next.record.label = record.label || current.label;
      next.record.enabled = record.enabled !== false;
      next.record.addedAt = current.addedAt;
      next.record.lastValidation = null;
      delete state.keys[id];
      nextId = next.id;
    }
    saveState();
    return list().find(item => item.id === nextId) || null;
  }

  function remove(id) {
    const current = all().find(item => item.id === id);
    if (!current) { const error = new Error('That Gemini key no longer exists.'); error.code = 'not_found'; throw error; }
    removeEnvValue(secretFile, current.envName);
    delete env[current.envName];
    delete state.keys[id];
    saveState();
    return { id, envName: current.envName };
  }

  function markUsed(id) {
    if (!state.keys[id]) return;
    state.keys[id].lastUsedAt = new Date().toISOString();
  }

  function recordValidation(id, status, extra = {}) {
    if (!state.keys[id]) return;
    const value = String(status || 'unknown');
    const previous = state.keys[id].lastValidation;
    // Successful requests are frequent; avoid rewriting the state file on every chat turn.
    if (previous && previous.status === value && value === 'ok' && previous.at) {
      const age = Date.now() - Date.parse(previous.at);
      if (Number.isFinite(age) && age < 60 * 1000) return;
    }
    state.keys[id].lastValidation = {
      status: value,
      at: new Date().toISOString(),
      modelCount: Number.isFinite(extra.modelCount) ? Number(extra.modelCount) : null,
      message: extra.message ? String(extra.message).slice(0, 200) : null,
    };
    saveState();
  }

  // Least-recently-used ordering, excluding keys already tried in this request. Stops the same
  // project's keys from being hammered in a tight loop.
  function select({ exclude = [] } = {}) {
    return all()
      .filter(item => item.enabled && !exclude.includes(item.id))
      .sort((a, b) => {
        const at = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
        const bt = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
        return at - bt;
      });
  }

  function statePathForTests() { return statePath; }
  function envFileForTests() { return secretFile; }

  return {
    all, list, enabled, secretFor, add, update, remove,
    markUsed, recordValidation, select,
    secretFile, statePath,
    statePathForTests, envFileForTests,
  };
}

module.exports = {
  createGeminiKeyStore,
  discoverKeys,
  maskKey,
  fingerprint,
  isPlausibleKey,
  resolveEnvFile,
  upsertEnvValue,
  removeEnvValue,
  ENV_PATTERN,
  STATE_FILE,
  KEY_FORMAT,
};
