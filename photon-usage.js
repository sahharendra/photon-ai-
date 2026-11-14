'use strict';
// PHOTON credit usage and actual provider-token accounting.
//
// PHOTON "tokens" are the plan's daily activity credits (text chat costs 1, code costs more, etc.).
// Actual provider tokens are the input/output/total numbers reported by Gemini, Anthropic or
// OpenRouter. Both are stored so the plan limit stays fair while real model usage is visible.

function localDateKey(time, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
  } catch {
    return new Date(time).toISOString().slice(0, 10);
  }
}

function summarizeUsage(activities, timezone, now = Date.now()) {
  const today = localDateKey(now, timezone);
  const list = (Array.isArray(activities) ? activities : []).filter(item => item && localDateKey(item.at, timezone) === today);
  const by = { chat: 0, voice: 0, code: 0, image: 0, video: 0 };
  const actual = { input: 0, output: 0, total: 0 };
  const used = list.reduce((sum, item) => {
    by[item.type] = (by[item.type] || 0) + (Number(item.tokens) || 0);
    const provider = item.providerTokens && typeof item.providerTokens === 'object' ? item.providerTokens : {};
    const input = Number(provider.inputTokens ?? provider.input_tokens) || 0;
    const output = Number(provider.outputTokens ?? provider.output_tokens) || 0;
    const total = Number(provider.totalTokens ?? provider.total_tokens) || input + output;
    actual.input += input;
    actual.output += output;
    actual.total += total;
    return sum + (Number(item.tokens) || 0);
  }, 0);
  return { used, by, actual, requests: list.length };
}

module.exports = { localDateKey, summarizeUsage };
