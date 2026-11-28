import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { usedCache } from '../lib/util.mjs';
import { logSpend } from '../lib/agent-spend.mjs';
import { runSteps } from '../lib/run-activity.mjs';
import { temp } from './helpers.mjs';

// 2026-11-28: the peer daemon of a computer with one long session froze for minutes at a time,
// and the owner's other computer saw it go offline. Each list of its sessions read what every
// run of the week spent from its log: 4,417 runs, with 4,000 kept, so a pass in the same order
// each time found none of them kept and read all 4,267 logs (370 MB) again, every 3 s.

test('a cache keeps every entry used lately, however many, and lets go of one idle or past its ceiling', () => {
  let clock = 0;
  const cache = usedCache({ idleMs: 1000, most: 50, now: () => clock });
  // A pass over more keys than any fixed count, again and again: each is still there.
  for (let pass = 0; pass < 3; pass++) for (let key = 0; key < 40; key++) { clock++; if (pass) assert.equal(cache.get(key), `v${key}`); else cache.set(key, `v${key}`); }
  assert.equal(cache.size, 40);
  // One not used for idleMs goes once something is kept again; a read keeps one in use.
  clock += 900; assert.equal(cache.get(5), 'v5');
  clock += 200; cache.set('new', 'n');
  assert.deepEqual([cache.get(5), cache.get('new'), cache.get(6)], ['v5', 'n', undefined]);
  // Past most, the one used longest ago goes first.
  for (let key = 100; key < 160; key++) { clock++; cache.set(key, key); }
  assert.equal(cache.size, 50);
  assert.equal(cache.get(5), undefined);
  assert.equal(cache.get(159), 159);
});

test('the spend of more run logs than were kept is read once while they stay the same', t => {
  const dir = temp(t), files = [];
  for (let i = 0; i < 4500; i++) {
    const file = path.join(dir, `lead-${i}.log`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' })}\n${JSON.stringify({ type: 'result', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
    files.push(file);
  }
  const first = files.map(file => logSpend(file, 'claude'));
  assert.equal(first[0].started, true);
  const opened = [], real = fs.openSync;
  t.mock.method(fs, 'openSync', function (file, ...rest) { opened.push(path.basename(String(file))); return real.call(this, file, ...rest); });
  for (let again = 0; again < 2; again++) files.forEach((file, i) => assert.equal(logSpend(file, 'claude'), first[i]));
  assert.equal(opened.length, 0, 'no log is read again');
  // One that changed is read again.
  fs.appendFileSync(files[7], '\n');
  logSpend(files[7], 'claude');
  assert.deepEqual(opened, ['lead-7.log']);
});

test('the steps of more logs than kept and settled held up to 0.1.61 are read once while they stay the same', t => {
  // 400 logs kept as they are read, then 5,000 settled: one long session alone had 3,164 runs.
  const dir = temp(t), files = [];
  for (let i = 0; i < 5600; i++) {
    const file = path.join(dir, `bot-${i}.log`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'item.completed', item: { id: `i${i}`, type: 'agent_message', text: `Run ${i}.` } })}\n`);
    files.push(file);
  }
  const first = files.map(file => runSteps(file));
  const opened = [], real = fs.openSync;
  t.mock.method(fs, 'openSync', function (file, ...rest) { opened.push(path.basename(String(file))); return real.call(this, file, ...rest); });
  for (let again = 0; again < 2; again++) files.forEach((file, i) => assert.equal(runSteps(file), first[i], 'the same frozen steps'));
  assert.equal(opened.length, 0, 'no log is read again');
});
