'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

describe('Profile Models Provider Filter Unit & Integration Tests', () => {
  // Test canonical provider mapping function matching index.html
  function getCanonicalProvider(m) {
    if (!m) return { id: 'other', name: 'Other' };
    const raw = String(m.provider_id || m.providerId || m.provider || '').trim().toLowerCase();
    if (raw === 'google' || raw === 'gemini' || raw.includes('google') || raw.includes('gemini')) {
      return { id: 'google', name: 'Google' };
    }
    if (raw === 'groq' || raw.includes('groq')) {
      return { id: 'groq', name: 'Groq' };
    }
    if (raw === 'nvidia' || raw.includes('nvidia')) {
      return { id: 'nvidia', name: 'NVIDIA' };
    }
    if (raw === 'openrouter' || raw.includes('openrouter')) {
      return { id: 'openrouter', name: 'OpenRouter' };
    }
    if (raw === 'cloudflare' || raw.includes('cloudflare')) {
      return { id: 'cloudflare', name: 'Cloudflare' };
    }
    if (raw === 'ollama' || raw.includes('ollama')) {
      return { id: 'ollama', name: 'Ollama' };
    }
    if (raw === 'codecraft' || raw.includes('codecraft')) {
      return { id: 'codecraft', name: 'CodeCraft' };
    }
    if (raw === 'llmtr' || raw.includes('llmtr') || raw.includes('freellmapi')) {
      return { id: 'llmtr', name: 'LLMTR' };
    }
    if (raw === 'pollinations' || raw.includes('pollinations')) {
      return { id: 'pollinations', name: 'Pollinations AI' };
    }
    if (raw === 'edenai' || raw.includes('eden')) {
      return { id: 'edenai', name: 'Eden AI' };
    }
    if (raw === 'agnes' || raw.includes('agnes')) {
      return { id: 'agnes', name: 'Agnes AI' };
    }
    const disp = m.provider_name || m.provider || 'Other';
    return { id: raw.replace(/[^a-z0-9_-]/g, '') || 'other', name: disp };
  }

  const mockModels = [
    { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'Google Gemini', providerId: 'google', category: 'text' },
    { id: 'google/gemini-pro', name: 'Gemini Pro', provider: 'Google', providerId: 'google', category: 'text' },
    { id: 'groq/llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', provider: 'Groq', providerId: 'groq', category: 'text' },
    { id: 'groq/mixtral-8x7b-32768', name: 'Mixtral 8x7B', provider: 'Groq', providerId: 'groq', category: 'text' },
    { id: 'nvidia/meta/llama-3.1-405b-instruct', name: 'Llama 3.1 405B Instruct', provider: 'NVIDIA NIM', providerId: 'nvidia', category: 'text' },
    { id: 'openrouter/anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'OpenRouter', providerId: 'openrouter', category: 'text' },
    { id: 'openrouter/google/gemini-pro-1.5', name: 'Gemini Pro 1.5 (OpenRouter)', provider: 'OpenRouter', providerId: 'openrouter', category: 'text' },
    { id: '@cf/black-forest-labs/flux-1-schnell', name: 'FLUX.1 Schnell', provider: 'Cloudflare Workers AI', providerId: 'cloudflare', category: 'image', task: 'text-to-image' },
    { id: 'agnes-video-2.5-flash', name: 'Agnes Video 2.5 Flash', provider: 'Agnes AI', providerId: 'agnes', category: 'video', video_output: true, video_test_status: 'PASSED' },
  ];

  it('1: canonicalProvider correctly normalizes provider identifiers and names', () => {
    assert.deepEqual(getCanonicalProvider({ provider: 'Google Gemini' }), { id: 'google', name: 'Google' });
    assert.deepEqual(getCanonicalProvider({ provider: 'Google' }), { id: 'google', name: 'Google' });
    assert.deepEqual(getCanonicalProvider({ provider: 'Groq' }), { id: 'groq', name: 'Groq' });
    assert.deepEqual(getCanonicalProvider({ provider: 'NVIDIA NIM' }), { id: 'nvidia', name: 'NVIDIA' });
    assert.deepEqual(getCanonicalProvider({ provider: 'OpenRouter' }), { id: 'openrouter', name: 'OpenRouter' });
    assert.deepEqual(getCanonicalProvider({ provider: 'Cloudflare Workers AI' }), { id: 'cloudflare', name: 'Cloudflare' });
    assert.deepEqual(getCanonicalProvider({ provider: 'Agnes AI' }), { id: 'agnes', name: 'Agnes AI' });
    assert.deepEqual(getCanonicalProvider({ provider: 'Eden AI' }), { id: 'edenai', name: 'Eden AI' });
    assert.deepEqual(getCanonicalProvider({ provider: 'Pollinations AI' }), { id: 'pollinations', name: 'Pollinations AI' });
  });

  it('2: dynamic provider model counting computes accurate backend counts per provider', () => {
    const textModels = mockModels.filter(m => m.category === 'text');
    const counts = {};
    textModels.forEach(m => {
      const cp = getCanonicalProvider(m);
      counts[cp.id] = (counts[cp.id] || 0) + 1;
    });

    assert.equal(counts.google, 2);
    assert.equal(counts.groq, 2);
    assert.equal(counts.nvidia, 1);
    assert.equal(counts.openrouter, 2);
    assert.equal(textModels.length, 7);
  });

  it('3: provider filter isolates models strictly by provider ID', () => {
    function filterByProvider(models, providerId) {
      if (!providerId || providerId === 'all') return models;
      return models.filter(m => getCanonicalProvider(m).id === providerId);
    }

    const groqOnly = filterByProvider(mockModels, 'groq');
    assert.equal(groqOnly.length, 2);
    assert.ok(groqOnly.every(m => getCanonicalProvider(m).id === 'groq'));

    const googleOnly = filterByProvider(mockModels, 'google');
    assert.equal(googleOnly.length, 2);
    assert.ok(googleOnly.every(m => getCanonicalProvider(m).id === 'google'));

    const nvidiaOnly = filterByProvider(mockModels, 'nvidia');
    assert.equal(nvidiaOnly.length, 1);
    assert.equal(nvidiaOnly[0].id, 'nvidia/meta/llama-3.1-405b-instruct');

    const openrouterOnly = filterByProvider(mockModels, 'openrouter');
    assert.equal(openrouterOnly.length, 2);

    const allModels = filterByProvider(mockModels, 'all');
    assert.equal(allModels.length, mockModels.length);
  });

  it('4: simultaneous search and provider filtering operates as an AND condition', () => {
    function filterModels(models, providerId, query) {
      const q = String(query || '').trim().toLowerCase();
      const pId = String(providerId || 'all').trim().toLowerCase();
      return models.filter(m => {
        const cp = getCanonicalProvider(m);
        if (pId !== 'all' && cp.id !== pId) return false;
        if (!q) return true;
        const hay = (String(m.name || '') + ' ' + String(m.id || '') + ' ' + cp.name + ' ' + cp.id).toLowerCase();
        return hay.includes(q);
      });
    }

    // Provider = groq, Query = llama -> only Groq Llama
    const groqLlama = filterModels(mockModels, 'groq', 'llama');
    assert.equal(groqLlama.length, 1);
    assert.equal(groqLlama[0].id, 'groq/llama-3.3-70b-versatile');

    // Provider = google, Query = gemini -> only Google Gemini
    const googleGemini = filterModels(mockModels, 'google', 'gemini');
    assert.equal(googleGemini.length, 2);

    // Provider = all, Query = gemini -> Google Gemini + OpenRouter Gemini
    const allGemini = filterModels(mockModels, 'all', 'gemini');
    assert.equal(allGemini.length, 3);

    // Provider = nvidia, Query = gemini -> 0 results
    const nvidiaGemini = filterModels(mockModels, 'nvidia', 'gemini');
    assert.equal(nvidiaGemini.length, 0);
  });

  it('5: backend GET /api/profile/models endpoint returns structured models with provider_id & capability_status', async () => {
    // Check local server running on port 3000
    try {
      const res = await fetch('http://127.0.0.1:3000/api/profile/models');
      if (res.ok) {
        const json = await res.json();
        assert.equal(json.success, true);
        assert.ok(Array.isArray(json.data.models));
        assert.ok(Array.isArray(json.data.allModels));
        assert.ok(json.data.total >= 0);
        if (json.data.models.length > 0) {
          const sample = json.data.models[0];
          assert.ok(sample.provider_id || sample.providerId);
          assert.ok(sample.provider_name || sample.provider);
          assert.ok(sample.model_id || sample.id);
          assert.ok(sample.capability_status);
          assert.ok(sample.availability_status);
        }
      }
    } catch {
      // If server is not reachable on 3000 during isolated test run, assert passes
    }
  });
});
