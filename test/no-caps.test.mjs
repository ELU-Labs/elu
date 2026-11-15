import test from 'node:test';
import assert from 'node:assert/strict';
import { displayText } from '../lib/terminal-visuals.mjs';
import { peerDataBlock, sanitize } from '../lib/peer/peerdata.mjs';

// No length of ours cuts what the owner reads: text the app draws is whole however long, and is
// still made safe to draw (no control, no markup of its own).
test('text the app draws is whole however long, and still safe to draw', () => {
  const long = `Start. ${'Every word of this answer matters. '.repeat(20000)}THE END {bold}`;
  assert.ok(long.length > 600000);
  for (const trusted of [false, true]) {
    const shown = displayText(`${long}\x1b[2J`, { trusted });
    assert.equal(shown.length, long.length + 11 + 3, trusted ? 'trusted' : 'masked');
    assert.ok(shown === `${long.replace('{bold}', '{open}bold{close}')}[2J`, 'every character of it');
  }
});

// What a teammate's agent sent, as the app keeps it and as a model is given it: whole, and cleaned.
test("a teammate's text is kept and handed to a model whole however long, and cleaned", () => {
  const long = `Start. ${'Every word of this question matters. '.repeat(1000)}THE END`;
  assert.ok(long.length > 16000);
  assert.equal(sanitize(`${long}‮\x07`), long);
  const block = peerDataBlock({ text: long, from: '@sara', key: 'a'.repeat(64), kind: 'question' });
  assert.ok(block.includes(`\n${long}\n<</peer-data-`), 'the whole text inside its markers');
});
