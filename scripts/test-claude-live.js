'use strict';
// LIVE tests against the real Anthropic API using the key in ANTHROPIC_API_KEY / API.env.
// Costs a few tokens on your Anthropic account. Run:  npm install @anthropic-ai/sdk  &&  npm run test:live
// Optional: set PHOTON_TEST_ID_TOKEN (a Firebase ID token of a Pro/Premium test user) and PHOTON_URL
// (default http://localhost:3001) to also test model selection + chat persistence through the running server.
const path = require('node:path');
const { loadEnvFiles, createAnthropicProvider } = require('../anthropic-provider');
loadEnvFiles(path.join(__dirname, '..'));
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

const results = [];
async function step(name, fn) {
  try { const note = await fn(); results.push({ name, ok: true, note }); console.log('PASS  ' + name + (note ? ' - ' + note : '')); }
  catch (e) { results.push({ name, ok: false, note: e.message }); console.log('FAIL  ' + name + ' - ' + (e.code ? e.code + ': ' : '') + e.message); }
}
const skip = (name, why) => { results.push({ name, ok: null, note: why }); console.log('SKIP  ' + name + ' - ' + why); };

(async () => {
  const provider = createAnthropicProvider({ HttpError });
  if (!provider.configured()) { console.log('ANTHROPIC_API_KEY is not set. Put it in the environment or API.env.'); process.exit(2); }
  let models = [];
  await step('key format check', () => provider.status().keyFormatWarning || 'looks like an Anthropic key');
  await step('authentication + model discovery (GET /v1/models)', async () => {
    models = await provider.refreshModels(true);
    if (!models.length) throw new Error('no models returned - status: ' + provider.status().validation);
    return models.length + ' models: ' + models.map(m => m.id).join(', ');
  });
  if (!models.length) { console.log('\nCannot continue without a valid key.'); process.exit(1); }
  const model = process.env.CLAUDE_TEST_MODEL || (models.find(m => /sonnet/i.test(m.id)) || models[0]).id;
  await step('Claude Sonnet 4 availability (informational)', () => models.some(m => /^claude-sonnet-4-\d{8}$|^claude-sonnet-4$/.test(m.id)) ? 'available on this account' : 'NOT available on this account (correctly not listed)');
  await step('real message request (' + model + ')', async () => {
    const r = await provider.generate({ model, system: 'Reply with exactly one short sentence.', history: [], text: 'Say hello to PHOTON AI.', maxTokens: 100 });
    if (!r.text || !(r.usage.inputTokens > 0) || !(r.usage.outputTokens > 0)) throw new Error('missing text or usage');
    return `"${r.text.slice(0, 60)}" usage in/out ${r.usage.inputTokens}/${r.usage.outputTokens}`;
  });
  await step('conversation history is honoured', async () => {
    const r = await provider.generate({ model, history: [{ role: 'user', text: 'My secret word is PINEAPPLE. Just say OK.' }, { role: 'assistant', text: 'OK' }], text: 'What is my secret word? One word only.', maxTokens: 50 });
    if (!/pineapple/i.test(r.text)) throw new Error('history not used: ' + r.text);
  });
  await step('invalid model id -> mapped error', async () => {
    try { await provider.generate({ model: 'claude-this-model-does-not-exist', text: 'hi', maxTokens: 10 }); } catch (e) { if (e.code === 'invalid_model') return 'invalid_model'; throw e; }
    throw new Error('expected an error');
  });
  await step('invalid key -> invalid_api_key (no key leak)', async () => {
    const bad = createAnthropicProvider({ HttpError, env: { ANTHROPIC_API_KEY: 'sk-ant-api03-invalid-key-for-test-0000000000000000000000' }, logger: { error() {}, log() {} } });
    try { await bad.generate({ model, text: 'hi', maxTokens: 10 }); } catch (e) { if (e.code === 'invalid_api_key' && !e.message.includes('sk-ant')) return 'invalid_api_key'; throw e; }
    throw new Error('expected an error');
  });
  skip('streaming', 'the Anthropic provider returns a full response; PHOTON SSE wraps it as a single delta. OpenRouter streaming is covered by scripts/test-openrouter-live.js');
  skip('rate-limit (429) behaviour', 'cannot be triggered safely on demand; mapping is unit-tested');

  const token = process.env.PHOTON_TEST_ID_TOKEN; const base = (process.env.PHOTON_URL || 'http://localhost:3001').replace(/\/$/, '');
  if (!token) skip('server end-to-end (model select, chat, persistence, usage)', 'set PHOTON_TEST_ID_TOKEN to run');
  else {
    const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const cid = 'live-test-' + Date.now();
    await step('server: Claude model listed as available', async () => { const r = await call('GET', '/api/profile/config'); const m = r.json.data.models.find(x => x.id === model && x.available); if (!m) throw new Error('model not available via /api/profile/config'); });
    await step('server: save default model', async () => { const r = await call('PUT', '/api/profile/model', { model }); if (r.status !== 200 || r.json.data.defaultModel !== model) throw new Error(JSON.stringify(r.json)); });
    await step('server: chat routes to Anthropic + usage recorded', async () => {
      const before = (await call('GET', '/api/profile')).json.data.usage.used;
      const r = await call('POST', '/api/chat', { conversation_id: cid, message: 'My secret word is MANGO. Reply OK.', system_instruction: 'Be brief.' });
      if (r.status !== 200 || r.json.data.provider !== 'anthropic' || r.json.data.model !== model) throw new Error(JSON.stringify(r.json));
      const after = (await call('GET', '/api/profile')).json.data.usage.used;
      if (after <= before) throw new Error('PHOTON token usage did not increase');
      return `provider=anthropic, provider tokens ${JSON.stringify(r.json.data.usage)}, PHOTON usage ${before}->${after}`;
    });
    await step('server: conversation persisted server-side', async () => {
      const r = await call('POST', '/api/chat', { conversation_id: cid, message: 'What was my secret word? One word.' });
      if (!/mango/i.test(r.json.data.message)) throw new Error('server did not keep history: ' + JSON.stringify(r.json));
    });
  }
  const failed = results.filter(r => r.ok === false).length;
  console.log(`\n${results.filter(r => r.ok).length} passed, ${failed} failed, ${results.filter(r => r.ok === null).length} skipped`);
  process.exit(failed ? 1 : 0);
})();
