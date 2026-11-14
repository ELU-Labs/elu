import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.mjs';
import { codexHome, codexRunRecord, rolloutFile, rolloutRun } from '../lib/codex-rollout.mjs';

// Codex's own record of a thread, as codex-cli 0.167.0 writes it: a rollout file under the day
// the thread began, one token_usage_record line for each request, holding that request's usage
// and the turn's so far. Read with the real program against a stand-in model service.

const THREAD = '019a1b2c-3d4e-7f00-8a00-000000000001';
const BEGAN = parseInt('019a1b2c3d4e', 16);
const pad = value => String(value).padStart(2, '0');
const dayDir = (home, at) => { const day = new Date(at); return path.join(home, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate())); };
const usage = (input, cached, output, write = 0) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const line = (at, type, payload) => JSON.stringify({ timestamp: new Date(at).toISOString(), ordinal: 1, type, payload }) + '\n';
const record = (at, turn, request, soFar) => line(at, 'token_usage_record', { thread_id: THREAD, turn_id: turn, response_id: `resp_${at}`, usage: request, turn_token_usage: soFar });

function rollout(t, rows) {
  const home = path.join(temp(t), 'codex'), dir = dayDir(home, BEGAN); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-11-14T10-00-00-${THREAD}.jsonl`); fs.writeFileSync(file, rows.join(''));
  return { home, file };
}

test("a Codex run's own use is read from its thread's record: each of its turns once, by Codex's figure for the turn", t => {
  const at = BEGAN + 60000, big = 'x'.repeat(1_500_000);
  const { home, file } = rollout(t, [
    line(at, 'session_meta', { id: THREAD }),
    // The first run: one turn of two requests.
    line(at + 1000, 'turn_context', { turn_id: 'turn-1', model: 'gpt-6.1-sol' }),
    record(at + 2000, 'turn-1', usage(1000, 100, 10), usage(1000, 100, 10)),
    // A line larger than what is read at a time.
    line(at + 2500, 'response_item', { type: 'message', content: [{ type: 'output_text', text: big }] }),
    record(at + 3000, 'turn-1', usage(2000, 200, 20, 50), usage(3000, 300, 30, 50)),
    // The second run: two turns (a message sent now started the second).
    line(at + 10000, 'turn_context', { turn_id: 'turn-2', model: 'gpt-6.1-terra' }),
    record(at + 11000, 'turn-2', usage(4000, 400, 40), usage(4000, 400, 40)),
    record(at + 12000, 'turn-3', usage(5000, 500, 50), usage(5000, 500, 50)),
  ]);
  // Input as runUsage counts Codex's: without the cached part, the written part still in it.
  // The model: the one the run's last turn ran on, which plain `codex exec` names nowhere else.
  // requests: each request's prompt (its input, cached and written included) and its tokens, in
  // the order it made them, which a model billed higher over a prompt size needs.
  const used = (input, output, cacheRead, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });
  assert.deepEqual(rolloutRun(file, { thread: THREAD, from: at + 500, to: at + 5000 }), { tokens: used(2700, 30, 300, 50), model: 'gpt-6.1-sol',
    requests: [{ prompt: 1000, tokens: used(900, 10, 100) }, { prompt: 2000, tokens: used(1800, 20, 200, 50) }] });
  assert.deepEqual(rolloutRun(file, { thread: THREAD, from: at + 9000, to: at + 13000 }), { tokens: used(8100, 90, 900), model: 'gpt-6.1-terra',
    requests: [{ prompt: 4000, tokens: used(3600, 40, 400) }, { prompt: 5000, tokens: used(4500, 50, 500) }] });
  // A run that made no request: none recorded, not zero.
  assert.deepEqual(rolloutRun(file, { thread: THREAD, from: at + 20000, to: at + 30000 }), { tokens: null, model: null, requests: [] });
  // Found under the day the thread began, by its id, in the home the run was started with.
  assert.equal(rolloutFile(THREAD, { home }), file);
  assert.deepEqual(codexRunRecord({ thread: THREAD, env: { CODEX_HOME: home }, from: at + 9000, to: at + 13000 }).tokens.output, 90);
  assert.equal(codexHome({ CODEX_HOME: home, HOME: '/home/owner' }), home); assert.equal(codexHome({ HOME: '/home/owner' }), '/home/owner/.codex');
  // The file Codex named (lib/codex-live.mjs) is taken as it is; another thread's id, or none, finds nothing.
  assert.equal(rolloutFile(THREAD, { home: '/nowhere', named: file }), file);
  assert.equal(rolloutFile('019a1b2c-3d4e-7f00-8a00-000000000009', { home }), null);
  assert.equal(rolloutFile('not-a-thread', { home }), null);
});

test("a thread's record that cannot be read whole, is put away compressed, or is a link says nothing", t => {
  const at = BEGAN + 60000;
  const { home, file } = rollout(t, [record(at + 2000, 'turn-1', usage(1000, 100, 10), usage(1000, 100, 10))]);
  // Codex compresses a thread it has not used for a while: rollout-…jsonl.zst is not read.
  fs.renameSync(file, `${file}.zst`);
  assert.equal(rolloutFile(THREAD, { home }), null);
  // A link in its place is not followed.
  fs.symlinkSync(`${file}.zst`, file);
  assert.equal(rolloutFile(THREAD, { home }), null);
  assert.equal(rolloutRun(file, { thread: THREAD, from: at, to: at + 5000 }), null);
  assert.equal(rolloutRun(path.join(home, 'gone.jsonl'), { thread: THREAD, from: at, to: at + 5000 }), null);
});
