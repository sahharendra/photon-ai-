'use strict';
// LIVE tests against the real OpenRouter API using the keys in API.env / the environment.
// It makes a handful of tiny requests on FREE models (free-tier limits apply, e.g. a small daily
// request cap on accounts without credit). Run from the project folder:
//     npm run test:live:openrouter-keys
// Optional server end-to-end (model selection, streaming chat, persistence, usage): start PHOTON
// (start.bat), sign in as a Pro/Premium test user, and set PHOTON_TEST_ID_TOKEN to that user's
// Firebase ID token. PHOTON_URL defaults to http://localhost:3001.
const path = require('node:path');
const { loadEnvFiles } = require('../anthropic-provider');
loadEnvFiles(path.join(__dirname, '..'));
const { createOpenRouterKeyStore, MAX_KEYS } = require('../openrouter-keys');
const { createOpenRouterProvider } = require('../openrouter-provider');
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

const results = [];
async function step(name, fn) {
  try { const note = await fn(); results.push({ name, ok: true }); console.log('PASS  ' + name + (note ? ' - ' + note : '')); }
  catch (e) { results.push({ name, ok: false }); console.log('FAIL  ' + name + ' - ' + (e.code ? e.code + ': ' : '') + e.message); }
}
const skip = (name, why) => { results.push({ name, ok: null }); console.log('SKIP  ' + name + ' - ' + why); };

// Current free models are often reasoning models: with a small completion budget the reasoning
// tokens consume the whole budget and the visible answer is empty. That is a model quirk, not a
// PHOTON failure, so retry the same request with a larger budget before reporting a failure.
async function generateWithBudget(provider, opts, budgets = [64, 256, 512]) {
  let lastError;
  for (const maxTokens of budgets) {
    try { return await provider.generate({ ...opts, maxTokens }); }
    catch (e) {
      lastError = e;
      if (e.code !== 'empty_response') throw e;
      console.log(`        empty response at maxTokens=${maxTokens}; retrying with a larger budget`);
    }
  }
  throw lastError;
}

(async () => {
  const store = createOpenRouterKeyStore({ persist: false });
  const provider = createOpenRouterProvider({ HttpError, keys: store });
  const keys = store.list();
  console.log(`Key slots: ${keys.length} of ${MAX_KEYS} configured (${keys.map(k => '#' + k.slot).join(', ') || 'none'}); ignored variables: ${store.ignoredEnvNames().join(', ') || 'none'}`);
  if (!keys.length) { console.log('No OpenRouter key found. Put OPENROUTER_API_KEY (and _2 … _10) in API.env.'); process.exit(2); }

  let checked = [];
  await step('validate every configured key with a real request (GET /key)', async () => {
    checked = await provider.testAll();
    for (const r of checked) console.log(`        slot #${r.slot}: ${r.status}${r.message ? ' - ' + r.message : ''}`);
    if (!checked.some(r => r.status === 'ok')) throw new Error('no key validated');
    return `${checked.filter(r => r.status === 'ok').length}/${checked.length} valid`;
  });
  await step('free model catalog from the live API (pricing metadata is zero)', async () => {
    await provider.refreshModels(true);
    const free = provider.status().freeModels;
    if (!free.length) throw new Error('no free models returned');
    if (free.some(m => Number(m.pricing.prompt) !== 0 || Number(m.pricing.completion) !== 0)) throw new Error('a listed model has non-zero pricing');
    return `${free.length} free models; openrouter/free ${free.some(m => m.id === 'openrouter/free') ? 'available' : 'not offered'}`;
  });
  const free = provider.status().freeModels;
  const model = process.env.OPENROUTER_TEST_MODEL || (free.find(m => m.id.endsWith(':free')) || free[0] || {}).id;
  if (!model) { console.log('\nNo model to test with.'); process.exit(1); }
  console.log('Using model: ' + model);
  await step('verify model availability before enabling', async () => { const v = await provider.verifyModel(model); if (!v.ok) throw new Error(v.message); });
  await step('real free-model chat response', async () => {
    const r = await generateWithBudget(provider, { model, system: 'Reply with one short sentence.', history: [], text: 'Say hello to PHOTON AI.', maxTokens: 64 });
    if (!r.text) throw new Error('empty text');
    return `"${r.text.slice(0, 60).replace(/\s+/g, ' ')}" key #${r.key.slot} tokens in/out/total ${r.usage.inputTokens}/${r.usage.outputTokens}/${r.usage.totalTokens}${r.usage.cost !== undefined ? ' cost ' + r.usage.cost : ''}`;
  });
  await step('conversation history is honoured', async () => {
    const r = await generateWithBudget(provider, { model, history: [{ role: 'user', text: 'My secret word is PINEAPPLE. Just say OK.' }, { role: 'assistant', text: 'OK' }], text: 'What is my secret word? One word only.', maxTokens: 32 });
    if (!/pineapple/i.test(r.text)) throw new Error('history not used: ' + r.text.slice(0, 80));
    return `"${r.text.slice(0, 40).replace(/\s+/g, ' ')}", tokens ${r.usage.totalTokens}`;
  });
  await step('round-robin across valid keys', async () => {
    const valid = provider.status().validKeys;
    if (valid < 2) return 'only one valid key, nothing to rotate';
    const used = [];
    for (let i = 0; i < Math.min(valid, 4); i++) used.push((await generateWithBudget(provider, { model, history: [], text: 'Say ok.', maxTokens: 8 }, [64, 256])).key.slot);
    if (new Set(used).size < 2) throw new Error('same key every time: ' + used.join(','));
    return 'slots used in order: ' + used.join(', ');
  });
  await step('streaming response', async () => {
    let deltas = 0; let done;
    for await (const e of provider.streamGenerate({ model, history: [], text: 'Count from 1 to 5.', maxTokens: 256 })) { if (e.type === 'delta') deltas++; else done = e; }
    if (!done || !done.text) throw new Error('no final text');
    return `${deltas} chunks, key #${done.key.slot}, tokens ${done.usage ? done.usage.totalTokens : 'n/a'}`;
  });
  await step('invalid key is rejected cleanly (no key in the message)', async () => {
    const bogus = 'sk-or-v1-' + '0'.repeat(64);
    const p = createOpenRouterProvider({ HttpError, env: { OPENROUTER_API_KEY: bogus }, logger: { error() {} } });
    const r = await p.testAll();
    if (r[0].status !== 'invalid_api_key') throw new Error('expected invalid_api_key, got ' + r[0].status);
    if (JSON.stringify(r).includes(bogus)) throw new Error('key leaked');
  });
  skip('rate limit (HTTP 429) / Retry-After against the real service', 'cannot be triggered safely on demand; the policy is unit-tested');
  skip('provider timeout against the real service', 'cannot be triggered on demand; the policy is unit-tested');

  const token = process.env.PHOTON_TEST_ID_TOKEN; const base = (process.env.PHOTON_URL || 'http://localhost:3001').replace(/\/$/, '');
  if (!token) skip('server end-to-end (model select, streaming chat, persistence, usage)', 'set PHOTON_TEST_ID_TOKEN to run');
  else {
    const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const cid = 'live-or-' + Date.now();
    await step('server: OpenRouter model offered and selectable as default', async () => {
      const cfg = await call('GET', '/api/profile/config');
      if (!cfg.json.data.models.some(m => m.id === model && m.available)) throw new Error('model not offered by the server');
      const r = await call('PUT', '/api/profile/model', { model });
      if (r.status !== 200 || r.json.data.defaultModel !== model) throw new Error(JSON.stringify(r.json).slice(0, 200));
    });
    await step('server: streaming chat, usage recorded, key used recorded', async () => {
      const before = (await call('GET', '/api/profile')).json.data.usage.used;
      const r = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ conversation_id: cid, message: 'My secret word is MANGO. Reply OK.', system_instruction: 'Be brief.' }) });
      const text = await r.text();
      if (!/event: done/.test(text)) throw new Error('no done event: ' + text.slice(0, 200));
      const done = JSON.parse(text.split('event: done\ndata: ')[1].split('\n')[0]);
      if (done.provider !== 'openrouter') throw new Error('wrong provider ' + done.provider);
      const after = (await call('GET', '/api/profile')).json.data.usage.used;
      if (after <= before) throw new Error('PHOTON plan usage did not increase');
      return `provider tokens ${JSON.stringify(done.usage)}; PHOTON plan usage ${before}->${after}`;
    });
    await step('server: conversation persisted (history reused)', async () => {
      const r = await call('POST', '/api/chat', { conversation_id: cid, message: 'What was my secret word? One word.' });
      if (!/mango/i.test(r.json.data.message)) throw new Error('history not kept: ' + JSON.stringify(r.json).slice(0, 200));
    });
  }
  const failed = results.filter(r => r.ok === false).length;
  console.log(`\n${results.filter(r => r.ok).length} passed, ${failed} failed, ${results.filter(r => r.ok === null).length} skipped`);
  process.exit(failed ? 1 : 0);
})();
