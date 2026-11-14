import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICES, PRICES_CHECKED, listCost, longPriceOf, priceOf } from '../lib/prices.mjs';

const near = (actual, expected) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
const tokens = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

test('one table holds every price, per million tokens, each a number', () => {
  assert.match(PRICES_CHECKED, /^\d{4}-\d{2}-\d{2}$/);
  for (const [id, entry] of Object.entries(PRICES)) {
    for (const price of Array.isArray(entry) ? entry : [entry]) {
      for (const key of ['input', 'cached', 'output']) assert.ok(Number.isFinite(price[key]) && price[key] > 0, `${id} ${key}`);
      if (price.write !== undefined) assert.ok(Number.isFinite(price.write) && price.write > 0, `${id} write`);
    }
  }
  // The models Codex lists, the Gemini models Antigravity runs, Grok Build's, and Claude's.
  for (const id of ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gemini-3.1-pro', 'gemini-3.6-flash', 'grok-4.6', 'grok-4.5', 'claude-opus-5-5', 'claude-sonnet-4-6']) assert.ok(priceOf(id), id);
});

test('a model is found by the names its vendor gives it, and a model with no published price is not', () => {
  assert.deepEqual(priceOf('gpt-6.1-sol'), { input: 2, cached: 0.1, write: 2.5, output: 10 });
  // Antigravity names the effort; a provider's prefix and a dated snapshot name the same model; so does a display name.
  for (const id of ['gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'gemini-3.1-pro-preview', 'models/gemini-3.1-pro-preview', 'Gemini 3.1 Pro (High)']) assert.deepEqual(priceOf(id), { input: 2, cached: 0.2, output: 12 }, id);
  assert.deepEqual(priceOf('xai/grok-4.6'), priceOf('grok-4.6'));
  assert.deepEqual(priceOf('claude-opus-4-6-thinking'), priceOf('claude-opus-4-6'));
  assert.deepEqual(priceOf('anthropic.claude-sonnet-4-6'), priceOf('claude-sonnet-4-6'));
  assert.deepEqual(priceOf('gpt-6.1-sol-2026-10-01'), priceOf('gpt-6.1-sol'));
  // Never a near model's price.
  for (const id of ['grok-4.6-fast', 'gemini-3.5-flash-high', 'gpt-6.1', 'gpt-6.1-sol-pro', 'claude-haiku-5-5', 'opus', 'big-model', '', null, undefined, 42]) assert.equal(priceOf(id), null, String(id));
});

// Checked 2026-11-14 on https://docs.x.ai/docs/models and https://aistudio.google.com/docs/pricing.
test('the models their makers list that the table lacked are priced, at their makers\' figures', () => {
  assert.deepEqual(priceOf('grok-4.20-multi-agent-0309'), { input: 1.25, cached: 0.2, output: 2.5 });
  assert.deepEqual(priceOf('gemini-3.1-pro-preview-customtools'), { input: 2, cached: 0.2, output: 12 });
  assert.deepEqual(priceOf('gemini-4-hydrogen'), { input: 1.5, cached: 0.075, output: 7.5 });
  // Gemini 4 Carbon and Argon cost more from December 1.
  for (const id of ['gemini-4-carbon', 'gemini-4-argon']) {
    assert.deepEqual(priceOf(id, Date.UTC(2026, 10, 30, 23)), { input: 2, cached: 0.1, output: 10 }, id);
    assert.deepEqual(priceOf(id, Date.UTC(2026, 11, 1, 1)), { input: 4, cached: 0.2, output: 20 }, id);
  }
});

test('an effort a vendor puts in a model name is read past, however many and wherever it is before -preview', () => {
  for (const [id, model] of [['gemini-3-flash-high', 'gemini-3-flash'], ['gemini-3-flash-low', 'gemini-3-flash'], ['gemini-3.8-flash-high', 'gemini-3.8-flash'], ['gemini-3.6-flash-low', 'gemini-3.6-flash'],
    ['gemini-3.1-flash-lite-high', 'gemini-3.1-flash-lite'], ['Gemini 3 Flash (High)', 'gemini-3-flash'], ['gemini-3-flash-preview-high', 'gemini-3-flash'], ['gemini-3-flash-high-preview', 'gemini-3-flash'],
    ['gemini-3.1-pro-high-thinking', 'gemini-3.1-pro'], ['gemini-4-carbon-high', 'gemini-4-carbon'], ['gpt-6.1-sol-xhigh', 'gpt-6.1-sol'], ['gpt-5.6-luna-low', 'gpt-5.6-luna'], ['grok-4.20-multi-agent-0309-high', 'grok-4.20-multi-agent-0309']]) {
    assert.deepEqual(priceOf(id), priceOf(model), id); assert.ok(priceOf(model), model);
  }
  // A name that is another model, not an effort, is not read past: Gemini 3.5 Flash and Grok 4.6 Fast are on neither maker's page.
  for (const id of ['gemini-3.5-flash-high', 'gemini-3.5-flash', 'grok-4.6-fast', 'grok-4.6-fast-high']) assert.equal(priceOf(id), null, id);
});

test("a price that changes on a date is the one of the run's day", () => {
  assert.deepEqual(priceOf('gemini-3.6-flash', Date.UTC(2026, 11, 31, 12)), { input: 0.75, cached: 0.075, output: 3.75 });
  assert.deepEqual(priceOf('gemini-3.6-flash', Date.UTC(2027, 0, 1, 12)), { input: 1.5, cached: 0.15, output: 7.5 });
});

test('a run costs each kind of token at its own rate; written tokens at the write price, or as input where the maker lists none', () => {
  // gpt-6.1-sol: 0.2M × $2 + 0.9M × $0.10 + 0.1M × $2.50 + 0.05M × $10.
  near(listCost('gpt-6.1-sol', tokens(200000, 50000, 900000, 100000)), 1.24);
  // grok-4.6 lists no write price: written tokens are input.
  near(listCost('grok-4.6', tokens(100000, 20000, 400000, 50000)), 0.2 + 0.12 + 0.2 + 0.1);
  // Several models in one run: each at its own price, and none known when one is not.
  near(listCost(null, null, { models: { 'grok-4.6': tokens(1e6, 0), 'grok-4.5': tokens(0, 1e6) } }), 2 + 6);
  assert.equal(listCost(null, null, { models: { 'grok-4.6': tokens(1e6, 0), 'grok-4.6-fast': tokens(1, 1) } }), null);
  assert.equal(listCost('grok-4.6', null), null, 'no tokens: no cost');
  assert.equal(listCost('grok-4.6-fast', tokens(1, 1)), null);
  assert.equal(listCost('gpt-6.1-sol', tokens(0, 0)), 0, 'no tokens used is nothing spent');
});

// Checked 2026-11-14 on each maker's page: OpenAI bills a prompt over 272K input tokens at its
// long-context rate, Google one over 200k, xAI one of 200k or more, every token of the request.
test("a request whose prompt reaches its model's long-context size costs the long rate, every token of it", () => {
  const long = (id, from, input, cached, output, write) => assert.deepEqual(longPriceOf(id), { from, input, cached, output, ...(write === undefined ? {} : { write }) }, id);
  long('gpt-6-astra', 272_001, 20, 2, 75, 25); long('gpt-6.1-sol', 272_001, 4, 0.2, 15, 5); long('gpt-6.1-terra', 272_001, 2, 0.1, 7.5, 2.5);
  long('gpt-6-sol', 272_001, 4, 0.4, 15, 5); long('gpt-6-luna', 272_001, 0.2, 0.02, 0.75, 0.25); long('gpt-5.6-sol', 272_001, 8, 0.8, 30, 10);
  long('gpt-5.6-terra', 272_001, 4, 0.4, 18, 5); long('gpt-5.6-luna', 272_001, 0.4, 0.04, 1.8, 0.5); long('gpt-5.5', 272_001, 10, 1, 45); long('gpt-5.4', 272_001, 5, 0.5, 22.5);
  long('gemini-3.1-pro-high', 200_001, 4, 0.4, 18); long('gemini-3.1-pro-preview-customtools', 200_001, 4, 0.4, 18);
  long('grok-4.7', 200_000, 4, 1, 12); long('grok-4.6', 200_000, 4, 1, 12); long('grok-4.5', 200_000, 4, 0.6, 12); long('grok-4.3', 200_000, 2.5, 0.4, 5);
  long('grok-4.20-0309-reasoning', 200_000, 2.5, 0.4, 5); long('grok-4.20-0309-non-reasoning', 200_000, 2.5, 0.4, 5); long('grok-4.20-multi-agent-0309', 200_000, 2.5, 0.4, 5); long('grok-build-0.1', 200_000, 2, 0.4, 4);
  // A model its maker prices the same at any size has none; nor does one with no price.
  for (const id of ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.3-codex', 'gpt-5', 'gemini-3-flash', 'gemini-3.6-flash', 'gemini-4-carbon', 'claude-opus-5-5', 'grok-4.6-fast', null]) assert.equal(longPriceOf(id), null, String(id));
  // The short price is the one priceOf gives.
  assert.deepEqual(priceOf('gpt-6.1-terra'), { input: 1, cached: 0.05, output: 5, write: 1.25 });
  // gpt-6.1-terra, which Codex gives 500K: of a run's tokens, those of a request of 400K input
  // (100K of it cached) and its 10K output were over 272K.
  const all = tokens(700_000, 20_000, 300_000, 0), over = tokens(300_000, 10_000, 100_000, 0);
  near(listCost('gpt-6.1-terra', all, { long: over }), (400_000 * 1 + 10_000 * 5 + 200_000 * 0.05) / 1e6 + (300_000 * 2 + 10_000 * 7.5 + 100_000 * 0.1) / 1e6);
  near(listCost('gpt-6.1-terra', all), (700_000 * 1 + 20_000 * 5 + 300_000 * 0.05) / 1e6);
  // A model with no long rate costs its one rate for all of it.
  near(listCost('gpt-5.4-mini', all, { long: over }), listCost('gpt-5.4-mini', all));
});
