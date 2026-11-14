'use strict';
// LIVE tests against the real OpenAI API using OPENAI_API_KEY from the environment, API.env or .env.
//
// Run:  npm run test:live:openai
// Optional: set OPENAI_TEST_MODEL to pin a model; otherwise the first visible gpt-* model is used.
// Optional: set PHOTON_TEST_ID_TOKEN (a Firebase ID token) and PHOTON_URL (default
// http://localhost:3001) to also check model selection, chat/streaming and usage through the
// running PHOTON server.
//
// Safety: the key is never printed. This script uses an isolated temporary state file so it never
// changes the administrator's saved OpenAI model/activation settings. It does make a few tiny real
// completions, which consume a negligible amount of API credit. No ChatGPT subscription credit is
// used; API billing must be enabled on the OpenAI account.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadEnvFiles } = require('../anthropic-provider');
const { createOpenAIConfig } = require('../openai-config');
const { createOpenAIProvider, validationMessage } = require('../openai-provider');

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

function makeProvider(env, dir) {
  const config = createOpenAIConfig({ dir, env, logger: { error() {}, log() {} } });
  return createOpenAIProvider({ HttpError, env, config, logger: { error() {}, log() {} } });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-openai-live-'));
  const provider = makeProvider(process.env, dir);

  if (!provider.configured()) {
    console.log('No OPENAI_API_KEY is configured. Put OPENAI_API_KEY in the environment, API.env or .env.');
    process.exit(2);
  }

  await step('key is present and never printed', () => {
    const status = provider.status();
    const blob = JSON.stringify(status);
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    if (!status.configured) throw new Error('provider reports not configured');
    if (!status.maskedKey || status.maskedKey.length < 8) throw new Error('masked key missing');
    if (key && blob.includes(key)) throw new Error('the raw key appears in status');
    return 'masked ' + status.maskedKey;
  });

  await step('connection: GET /v1/models succeeds', async () => {
    const result = await provider.testConnection();
    if (!result.ok) throw new Error(result.code + ': ' + result.message);
    if (!(result.modelCount >= 1)) throw new Error('no models visible');
    return result.modelCount + ' visible models';
  });

  let models = [];
  await step('live model discovery returns only chat models', async () => {
    models = await provider.refreshModels(true);
    if (provider.status().validation !== 'ok') throw new Error('validation: ' + provider.status().validation);
    if (!models.length) throw new Error('no chat models returned');
    return models.length + ' chat models; first: ' + models.slice(0, 6).map(m => m.id).join(', ');
  });
  if (!models.length) { console.log('\nCannot continue without a validated key and chat models.'); process.exit(1); }

  // Prefer an explicitly requested model, then a gpt-* model, then the first visible model.
  const model = process.env.OPENAI_TEST_MODEL
    || (models.find(m => /^gpt-/i.test(m.id)) || models[0]).id;
  console.log('Using model: ' + model);

  await step('a tiny real completion verifies the model (' + model + ')', async () => {
    const result = await provider.testModel(model);
    if (!result.ok) throw new Error(result.code + ': ' + result.message);
    if (!result.usage || !(result.usage.totalTokens > 0)) throw new Error('missing usage: ' + JSON.stringify(result.usage));
    if (!Number.isFinite(result.cost)) throw new Error('missing estimated cost');
    return 'usage in/out/total ' + result.usage.inputTokens + '/' + result.usage.outputTokens + '/' + result.usage.totalTokens + ', estimated $' + Number(result.cost).toFixed(8);
  });

  // Verification alone never enables a model in the admin flow. For this isolated live test the
  // temporary state is explicitly enabled so the chat paths can be exercised.
  provider.settings.markModelVerified(model);
  provider.settings.setModelEnabled(model, true);
  if (!provider.catalogEntries().some(entry => entry.id === model && entry.available)) {
    console.log('\nThe model could not be enabled. Enable it in the admin panel after checking the key.');
    process.exit(1);
  }

  await step('real chat completion with system instruction and history', async () => {
    const result = await provider.generate({
      model,
      system: 'Answer with one word.',
      history: [
        { role: 'user', text: 'My secret word is PINEAPPLE. Just say OK.' },
        { role: 'model', text: 'OK' },
      ],
      text: 'What is my secret word? One word only.',
      maxTokens: 32,
    });
    if (!result.text) throw new Error('missing text');
    if (!/pineapple/i.test(result.text)) throw new Error('history not used: ' + result.text);
    if (!(result.usage.inputTokens > 0) || !(result.usage.outputTokens > 0)) throw new Error('missing usage: ' + JSON.stringify(result.usage));
    return '"' + result.text.slice(0, 40) + '" usage ' + JSON.stringify(result.usage) + ', estimated $' + Number(result.cost).toFixed(8);
  });

  await step('real streaming returns deltas, usage and an estimated cost', async () => {
    let text = '';
    let usage = null;
    let cost;
    let chunks = 0;
    for await (const event of provider.streamGenerate({ model, text: 'Count from 1 to 5, separated by spaces.', maxTokens: 80 })) {
      if (event.type === 'delta') { text += event.text; chunks++; }
      else if (event.type === 'done') { usage = event.usage; cost = event.cost; }
    }
    if (!text.trim()) throw new Error('no streamed text');
    if (chunks < 1) throw new Error('no delta events');
    if (!usage || !(usage.totalTokens > 0)) throw new Error('missing stream usage');
    if (!Number.isFinite(cost)) throw new Error('missing stream cost');
    return chunks + ' deltas, usage ' + JSON.stringify(usage) + ', estimated $' + Number(cost).toFixed(8);
  });

  await step('estimated cost uses published/overridden pricing per million tokens', () => {
    const estimate = provider.estimateCost({ model, text: 'x'.repeat(4000), maxTokens: 1000 });
    if (!Number.isFinite(estimate) || estimate < 0) throw new Error('estimate: ' + estimate);
    return '$' + estimate.toFixed(6) + ' for ~1000 input + 1000 output tokens';
  });

  await step('usage counters aggregate tokens, requests and estimated spend', () => {
    const status = provider.status();
    if (!(status.usage.requests >= 3)) throw new Error('expected at least 3 recorded requests, got ' + status.usage.requests);
    if (!(status.usage.totalTokens > 0)) throw new Error('no tokens recorded');
    if (!(status.spend.costUsd >= 0)) throw new Error('spend missing');
    if (!status.usage.byModel[model]) throw new Error('per-model usage missing');
    return status.usage.requests + ' requests, ' + status.usage.totalTokens + ' tokens, $' + Number(status.spend.costUsd).toFixed(6) + ' estimated';
  });

  await step('unavailable model maps to invalid_model without spending', async () => {
    try { await provider.generate({ model: 'gpt-this-model-does-not-exist', text: 'hi', maxTokens: 8 }); }
    catch (e) {
      if (['invalid_model', 'provider_forbidden', 'provider_rejected_request'].includes(e.code)) return e.code;
      throw e;
    }
    throw new Error('expected an error');
  });

  await step('invalid key maps to invalid_api_key and never leaks the key', async () => {
    const badKey = 'sk-invalid-photon-live-test-000000000000000000000000';
    const bad = makeProvider({ ...process.env, OPENAI_API_KEY: badKey }, fs.mkdtempSync(path.join(os.tmpdir(), 'photon-openai-bad-')));
    try { await bad.generate({ model, text: 'hi', maxTokens: 8 }); }
    catch (e) {
      if (e.code !== 'invalid_api_key') throw e;
      if (e.message.includes(badKey)) throw new Error('the key leaked into the error message');
      if (JSON.stringify(bad.status()).includes(badKey)) throw new Error('the key leaked into status');
      return 'invalid_api_key';
    }
    throw new Error('expected an error');
  });

  skip('rate-limit (429) behaviour', 'cannot be triggered safely on demand; Retry-After, backoff and no-credit billing handling are unit-tested');

  const token = process.env.PHOTON_TEST_ID_TOKEN;
  const base = (process.env.PHOTON_URL || 'http://localhost:3001').replace(/\/$/, '');
  if (!token) {
    skip('server: OpenAI models in /api/profile/config', 'set PHOTON_TEST_ID_TOKEN to run authenticated checks');
  } else {
    const call = async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, text: await r.text(), json: null };
    };
    await step('server: configuration exposes OpenAI without the key', async () => {
      const r = await fetch(base + '/api/profile/config', { headers: { Authorization: 'Bearer ' + token } });
      const text = await r.text();
      const key = String(process.env.OPENAI_API_KEY || '').trim();
      if (key && text.includes(key)) throw new Error('the key leaked from /api/profile/config');
      const data = JSON.parse(text);
      const models = (data.data && data.data.models) || [];
      const gpt = models.filter(m => m.provider === 'OpenAI');
      if (!gpt.length) throw new Error('no OpenAI models listed');
      return gpt.length + ' OpenAI entries, ' + gpt.filter(m => m.available).length + ' enabled';
    });
    await step('server: chat routes to OpenAI and records usage', async () => {
      const cid = 'openai-live-' + Date.now();
      const r = await call('POST', '/api/chat', { conversation_id: cid, message: 'Reply with the single word HELLO.', system_instruction: 'Be brief.' });
      if (r.status !== 200) throw new Error('status ' + r.status + ': ' + r.text.slice(0, 200));
      const data = JSON.parse(r.text).data || {};
      if (data.provider !== 'openai') throw new Error('provider was ' + data.provider + '; enable a GPT model first');
      if (!data.usage || !(data.usage.total_tokens > 0)) throw new Error('no provider usage recorded');
      return 'provider=openai, usage ' + JSON.stringify(data.usage);
    });
  }

  const failed = results.filter(r => r.ok === false).length;
  console.log(`\n${results.filter(r => r.ok).length} passed, ${failed} failed, ${results.filter(r => r.ok === null).length} skipped`);
  process.exit(failed ? 1 : 0);
})();
