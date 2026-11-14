'use strict';
// LIVE tests against the real Google Gemini API using GEMINI_API_KEY / GEMINI_API_KEY_2 / ...
// from the environment, API.env or .env.
//
// Run:  npm run test:live:gemini
// Optional: set PHOTON_TEST_ID_TOKEN (a Firebase ID token) and PHOTON_URL (default
// http://localhost:3001) to also test model selection, chat/streaming, persistence and usage
// through the running PHOTON server.
const path = require('node:path');
const { loadEnvFiles } = require('../anthropic-provider');
const { createGeminiKeyStore } = require('../gemini-keys');
const { createGeminiProvider } = require('../gemini-provider');

const ROOT = path.join(__dirname, '..');
loadEnvFiles(ROOT);

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

const results = [];
async function step(name, fn) {
  try { const note = await fn(); results.push({ name, ok: true, note }); console.log('PASS  ' + name + (note ? ' - ' + note : '')); }
  catch (e) { results.push({ name, ok: false, note: e.message }); console.log('FAIL  ' + name + ' - ' + (e.code ? e.code + ': ' : '') + e.message); }
}
const skip = (name, why) => { results.push({ name, ok: null, note: why }); console.log('SKIP  ' + name + ' - ' + why); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const keys = createGeminiKeyStore({ dir: ROOT, env: process.env, logger: { error() {}, log() {} } });
  const provider = createGeminiProvider({ HttpError, keys, logger: { error() {}, log() {} } });

  if (!provider.configured()) {
    console.log('No GEMINI_API_KEY is configured. Put GEMINI_API_KEY (and optionally GEMINI_API_KEY_2) in the environment, API.env or .env.');
    process.exit(2);
  }

  const configured = keys.list();
  console.log(`Found ${configured.length} configured Gemini key(s): ${configured.map(k => k.label + ' (' + k.masked + ')').join(', ')}`);

  await step('all configured keys are non-empty and well formed', () => {
    if (!configured.length) throw new Error('no keys');
    const bad = configured.filter(k => !k.masked || k.masked.length < 8);
    if (bad.length) throw new Error('malformed key metadata');
    return `${configured.length} key(s)`;
  });

  const validations = [];
  await step('each key validates against GET /v1beta/models', async () => {
    for (const key of configured) {
      const result = await provider.testKey(key.id);
      validations.push(result);
      if (result.status !== 'ok') throw new Error(key.label + ' -> ' + result.status);
    }
    return validations.map(v => v.modelCount + ' models').join(', ');
  });

  let models = [];
  await step('live model discovery', async () => {
    models = await provider.refreshModels(true);
    const status = provider.status();
    if (status.validation !== 'ok') throw new Error('validation: ' + status.validation);
    if (!models.length) throw new Error('no chat models returned');
    return `${models.length} models; first: ${models.slice(0, 6).map(m => m.id).join(', ')}`;
  });
  if (!models.length) { console.log('\nCannot continue without a validated key and chat models.'); process.exit(1); }

  const model = process.env.GEMINI_TEST_MODEL || provider.defaultModelId();
  const contents = text => [{ role: 'user', parts: [{ text }] }];
  const generate = async (text, extra = {}) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await provider.generate({ model, maxOutputTokens: 120, ...extra, contents: contents(text) }); }
      catch (e) { if (e.code !== 'quota_or_rate_limit' || attempt === 3) throw e; await sleep(2000 * attempt); }
    }
  };

  await step('real chat completion (' + model + ')', async () => {
    const r = await generate('Say hello to PHOTON AI in exactly one short sentence.');
    if (!r.text) throw new Error('missing text');
    if (!(r.usage.inputTokens > 0) || !(r.usage.outputTokens > 0)) throw new Error('missing usage: ' + JSON.stringify(r.usage));
    return `"${r.text.slice(0, 60)}" usage in/out/total ${r.usage.inputTokens}/${r.usage.outputTokens}/${r.usage.totalTokens}`;
  });

  await step('system instruction + conversation history are honoured', async () => {
    const history = [
      { role: 'user', parts: [{ text: 'My secret word is PINEAPPLE. Just say OK.' }] },
      { role: 'model', parts: [{ text: 'OK' }] },
      { role: 'user', parts: [{ text: 'What is my secret word? One word only.' }] },
    ];
    const r = await provider.generate({ model, contents: history, systemInstruction: 'Answer with one word.', maxOutputTokens: 30 });
    if (!/pineapple/i.test(r.text)) throw new Error('history not used: ' + r.text);
  });

  await step('real streaming returns deltas, usage and no key leak', async () => {
    let text = '';
    let usage = null;
    let chunks = 0;
    for await (const event of provider.streamGenerate({ model, contents: contents('Count from 1 to 5, separated by spaces.'), maxOutputTokens: 80 })) {
      if (event.type === 'delta') { text += event.text; chunks++; }
      else if (event.type === 'done') usage = event.usage;
    }
    if (!text.trim()) throw new Error('no streamed text');
    if (chunks < 1) throw new Error('no delta events');
    if (!usage || !(usage.totalTokens > 0)) throw new Error('missing stream usage');
    const blob = JSON.stringify({ text, usage });
    for (const key of configured) if (blob.includes(key.masked.replace(/•/g, ''))) throw new Error('key material leaked');
    return `${chunks} deltas, usage ${JSON.stringify(usage)}`;
  });

  await step('unavailable model -> mapped error', async () => {
    try { await provider.generate({ model: 'gemini-this-model-does-not-exist', contents: contents('hi'), maxOutputTokens: 10 }); }
    catch (e) { if (['invalid_model', 'provider_forbidden', 'provider_error'].includes(e.code)) return e.code; throw e; }
    throw new Error('expected an error');
  });

  await step('invalid key -> invalid_api_key (no key leak)', async () => {
    const badKey = 'AIzaSyInvalidKeyForPhotonTests000000000000000';
    const badStore = createGeminiKeyStore({ dir: ROOT, env: { GEMINI_API_KEY: badKey }, logger: { error() {}, log() {} } });
    const bad = createGeminiProvider({ HttpError, keys: badStore, logger: { error() {}, log() {} } });
    try { await bad.generate({ model, contents: contents('hi'), maxOutputTokens: 10 }); }
    catch (e) { if (e.code === 'invalid_api_key' && !e.message.includes('AIza')) return 'invalid_api_key'; throw e; }
    throw new Error('expected an error');
  });

  skip('rate-limit (429) behaviour', 'cannot be triggered safely on demand; Retry-After and no-rotation policy are unit-tested');

  const token = process.env.PHOTON_TEST_ID_TOKEN;
  const base = (process.env.PHOTON_URL || 'http://localhost:3001').replace(/\/$/, '');
  if (!token) skip('server end-to-end (model select, chat, streaming, persistence, usage)', 'set PHOTON_TEST_ID_TOKEN to run');
  else {
    const call = async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    };
    const cid = 'gemini-live-' + Date.now();
    await step('server: Gemini model listed as available', async () => {
      const r = await call('GET', '/api/profile/config');
      const found = (r.json.data?.models || []).find(x => x.id === model && x.available);
      if (!found) throw new Error('model not available via /api/profile/config');
    });
    await step('server: save default model', async () => {
      const r = await call('PUT', '/api/profile/model', { model });
      if (r.status !== 200 || r.json.data.defaultModel !== model) throw new Error(JSON.stringify(r.json));
    });
    await step('server: chat routes to Gemini + actual tokens recorded', async () => {
      const before = (await call('GET', '/api/profile')).json.data.usage;
      const r = await call('POST', '/api/chat', { conversation_id: cid, message: 'My secret word is MANGO. Reply OK.', system_instruction: 'Be brief.' });
      if (r.status !== 200 || r.json.data.provider !== 'gemini' || r.json.data.model !== model) throw new Error(JSON.stringify(r.json));
      const after = (await call('GET', '/api/profile')).json.data.usage;
      if (after.used <= before.used) throw new Error('PHOTON token usage did not increase');
      if (!(after.actual.total > before.actual.total)) throw new Error('actual provider tokens did not increase');
      return `provider=gemini, provider tokens ${JSON.stringify(r.json.data.usage)}, PHOTON usage ${before.used}->${after.used}`;
    });
    await step('server: conversation persisted server-side', async () => {
      const r = await call('POST', '/api/chat', { conversation_id: cid, message: 'What was my secret word? One word.' });
      if (!/mango/i.test(r.json.data?.message || '')) throw new Error('server did not keep history: ' + JSON.stringify(r.json));
    });
    await step('server: streaming endpoint emits delta and done', async () => {
      const r = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ conversation_id: cid, message: 'Reply with the single word STREAM.', system_instruction: 'Be brief.' }) });
      if (!r.ok) throw new Error('status ' + r.status + ': ' + (await r.text()).slice(0, 200));
      const text = await r.text();
      if (!/event: delta/.test(text) || !/event: done/.test(text)) throw new Error('missing SSE events: ' + text.slice(0, 200));
      if (/event: error/.test(text)) throw new Error('stream returned an error event: ' + text.slice(0, 300));
      return 'delta + done events received';
    });
  }

  const failed = results.filter(r => r.ok === false).length;
  console.log(`\n${results.filter(r => r.ok).length} passed, ${failed} failed, ${results.filter(r => r.ok === null).length} skipped`);
  process.exit(failed ? 1 : 0);
})();
