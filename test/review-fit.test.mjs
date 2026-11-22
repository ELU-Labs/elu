import test from 'node:test';
import assert from 'node:assert/strict';
import { EluCodeError, TOO_LONG } from '../lib/util.mjs';
import { HEADROOM, PIECE_MIN, PROMPT_REST, fitClock, inputLimit, mergeParts, patchesOf, planParts, reviewBudget, reviewInParts, splitPatch } from '../lib/review-fit.mjs';

// A review always fits the vendor of the bot that makes it (lib/review-fit.mjs): each adapter
// says the longest input its vendor takes, and a change longer than that goes in parts, by its
// files, a file's diff by its hunks, a hunk by its lines. A vendor's own word that a part is too
// long splits that part again, never a failure.
const hunk = (at, lines, label) => `@@ -${at},${lines} +${at},${lines} @@ export function ${label}()\n${Array.from({ length: lines }, (_, n) => `-  old "${label}" line ${n}\n+  new "${label}" line ${n}`).join('\n')}\n`;
const filePatch = (file, hunks) => `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n${hunks.join('')}`;
// A change like one a bot was once given whole: 236 files, about 4M characters,
// one of them a generated file of 1.4M characters in one hunk, with one line of 300,000.
function bigChange() {
  const files = [];
  for (let n = 0; n < 235; n++) files.push([`src/part-${String(n).padStart(3, '0')}.mjs`, filePatch(`src/part-${String(n).padStart(3, '0')}.mjs`, [hunk(10, 120, `a${n}`), hunk(400, 120, `b${n}`)])]);
  const long = `+${'x'.repeat(300000)}`, gen = filePatch('gen/schema.json', [`@@ -1,20000 +1,20001 @@\n${Array.from({ length: 20000 }, (_, n) => `+  "field_${n}": "a generated value of the schema, ${n}",`).join('\n')}\n${long}\n`]);
  files.push(['gen/schema.json', gen]);
  return { text: files.map(([, patch]) => patch).join(''), files: files.map(([file]) => file) };
}
const added = patch => patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'));

test("each vendor's adapter says how much it takes, and a review's change gets at most HEADROOM of it after the rest of the prompt", () => {
  assert.equal(inputLimit('codex'), 1048576, "Codex's app server: turn/start fails over 1,048,576 characters");
  assert.equal(inputLimit('grok'), 768000);
  assert.equal(inputLimit('agy'), 191580);
  assert.equal(inputLimit('claude', 'claude-opus-5-5'), 3000000, 'a 1M-token model');
  assert.equal(inputLimit('claude', 'claude-haiku-4-5'), 600000, 'a 200K-token model');
  assert.equal(inputLimit('claude', 'claude-sonnet-4-5[200k]'), 600000);
  assert.equal(inputLimit('nobody'), Infinity, 'a vendor that says nothing is given the change whole');
  assert.equal(reviewBudget(1048576, 10000), Math.floor(1048576 * HEADROOM) - PROMPT_REST - 10000);
  assert.equal(reviewBudget(Infinity), Infinity);
  assert.equal(reviewBudget(1000, 0), PIECE_MIN, 'never less than one small piece');
  const saved = fitClock.limits; fitClock.limits = { codex: 50000 };
  try { assert.equal(inputLimit('codex'), 50000, 'a test gives a vendor less'); } finally { fitClock.limits = saved; }
});

test("the vendors' own words for a prompt too long are known as too long, Codex's app server's among them", () => {
  for (const text of [
    'turn/start failed: Input exceeds the maximum length of 1048576 characters. {"max_chars":1048576,"actual_chars":3900000}',
    'Prompt is too long',
    "Codex ran out of room in the model's context window.",
    'This model\'s maximum prompt length is 256000 but the request contains 391234 tokens.',
    'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
  ]) assert.match(text, TOO_LONG, text);
  assert.doesNotMatch('stream disconnected before completion', TOO_LONG);
});

test('a change of about 4M characters goes in parts under each vendor\'s limit, with every line it adds in one of them', () => {
  const { text, files } = bigChange(), patches = patchesOf(text);
  assert.equal(patches.size, 236); assert.ok(text.length > 3500000, `${text.length}`);
  const patchOf = file => patches.get(file), cost = file => patches.get(file).length;
  for (const [vendor, model] of [['codex', null], ['claude', 'claude-opus-5-5'], ['claude', 'claude-haiku-4-5'], ['grok', null], ['agy', null]]) {
    const limit = inputLimit(vendor, model), budget = reviewBudget(limit, 5000), parts = planParts(files, { patchOf, cost, budget });
    assert.ok(parts.length > 1, `${vendor} ${model}: in parts`);
    // Each part, written as JSON in the prompt, with the rest of the prompt, fits.
    for (const part of parts) assert.ok(JSON.stringify(part.patch).length + PROMPT_REST + 5000 < limit, `${vendor} ${model}: a part of ${part.patch.length}`);
    // Every file is in a part, and the generated one in pieces of its one hunk.
    assert.deepEqual([...new Set(parts.flatMap(part => part.files))].sort(), [...files].sort());
    const pieces = parts.filter(part => part.piece), whole = patchOf('gen/schema.json').length < budget * 0.85;
    if (whole) assert.ok(!pieces.length && parts.some(part => part.patch.includes(patchOf('gen/schema.json'))), `${vendor} ${model}: whole`);
    else assert.ok(pieces.length >= 2 && pieces.every(part => part.files.join() === 'gen/schema.json'), `${vendor} ${model}: ${pieces.length} pieces`);
    // Nothing it adds is lost: the long line is there whole where a part takes it, else cut, with how long it was.
    const lines = new Set(parts.flatMap(part => added(part.patch))), long = added(text).find(line => line.length > 1000);
    for (const line of added(text).filter(line => line.length < 1000)) assert.ok(lines.has(line), `${vendor}: ${line.slice(0, 60)}`);
    assert.ok(budget > long.length ? lines.has(long) : [...lines].some(line => line.startsWith('+xxxx') && line.endsWith('(this line is cut here: it has 300,001 characters)')), vendor);
  }
});

test("a hunk split in pieces gives each piece its own @@ line, counted as Git counts it", () => {
  const patch = filePatch('a.mjs', [hunk(100, 400, 'x')]), pieces = splitPatch(patch, 6000);
  assert.ok(pieces.length > 2, `${pieces.length}`);
  let old = 100, now = 100;
  for (const piece of pieces) {
    assert.ok(piece.startsWith('diff --git a/a.mjs b/a.mjs\n') && piece.includes('\n+++ b/a.mjs\n'), 'each starts with the file\'s header');
    const [head, ...body] = piece.slice(piece.indexOf('@@')).trimEnd().split('\n'), found = /^@@ -([0-9]+),([0-9]+) \+([0-9]+),([0-9]+) @@/.exec(head);
    assert.ok(found, head); assert.ok(piece.length <= 6000, `${piece.length}`);
    assert.deepEqual([Number(found[1]), Number(found[3])], [old, now]);
    assert.equal(Number(found[2]), body.filter(line => line.startsWith('-')).length); assert.equal(Number(found[4]), body.filter(line => line.startsWith('+')).length);
    old += Number(found[2]); now += Number(found[4]);
  }
  assert.equal(pieces.flatMap(added).length, 400);
});

test("a part its vendor says is too long is split again until it is taken, and the findings are one review with an ID per part", async () => {
  const { text, files } = bigChange(), patches = patchesOf(text), patchOf = file => patches.get(file), cost = file => patches.get(file).length;
  // Planned for Codex, sent to a vendor that takes only 200,000 characters, with Codex's own words.
  const parts = planParts(files, { patchOf, cost, budget: reviewBudget(inputLimit('codex')) }), sent = [];
  const review = async part => {
    sent.push(part.patch.length);
    if (part.patch.length > 200000) throw new EluCodeError('turn/start failed: Input exceeds the maximum length of 1048576 characters.', { cause: 'too-long' });
    return { outcome: 'done', summary: `Read ${part.files.length}.`, comments: part.files.includes('gen/schema.json') ? [{ id: 'R1', severity: 'must_fix', body: 'The schema is generated.' }] : [], responses: [] };
  };
  const { done, left } = await reviewInParts(parts, { review, patchOf, cost });
  assert.deepEqual(left, [], 'no file is left for its length');
  assert.ok(sent.some(size => size > 200000), 'some parts were refused'); assert.ok(done.length > parts.length, 'and split again');
  const merged = mergeParts(done);
  assert.equal(merged.outcome, 'done');
  assert.ok(merged.comments.length >= 2 && merged.comments.every(row => /^part[0-9]+-1$/.test(row.id)), JSON.stringify(merged.comments.map(row => row.id)));
  assert.equal(new Set(merged.comments.map(row => row.id)).size, merged.comments.length, 'no two findings share an ID');
  // One that refuses everything is asked a bounded number of times, and every file is left.
  let asked = 0;
  const none = await reviewInParts(parts, { review: async () => { asked++; throw new EluCodeError('Prompt is too long', { cause: 'too-long' }); }, patchOf, cost });
  assert.equal(none.done.length, 0); assert.deepEqual(none.left.sort(), [...files].sort()); assert.ok(asked <= 24, `${asked}`);
  // Another failure is not a length: it is thrown as it is.
  await assert.rejects(reviewInParts(parts, { review: async () => { throw new EluCodeError('stream disconnected', { cause: 'unknown' }); }, patchOf, cost }), /stream disconnected/);
});
