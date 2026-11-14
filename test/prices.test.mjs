import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICES, PRICES_CHECKED, listCost, priceOf } from '../lib/prices.mjs';

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
