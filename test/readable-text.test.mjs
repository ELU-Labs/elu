import test from 'node:test';
import assert from 'node:assert/strict';
import { readableRows, visible } from '../lib/terminal-visuals.mjs';
import { columns } from '../lib/width.mjs';

// A project's instructions or context drawn to read. Only the drawing: the text is not changed.
const rows = (text, width = 30) => readableRows(text, width, { colour: false, now: new Date(2026, 10, 15) }).map(visible);

test('a project text drawn to read: headings without their marks, bullets that hang, short dates over their day', () => {
  assert.deepEqual(rows('# Title\nSome words here.\n\n- one two three four five six seven eight nine\n- 2026-11-14: alpha beta\n- 2026-11-14: gamma\n\n- 2025-03-02: delta'), [
    'Title', '', 'Some words here.', '',
    '• one two three four five six', '  seven eight nine', '',
    'Nov 14', '• alpha beta', '', '• gamma', '',
    'Mar 2, 2025', '• delta',
  ]);
  // The heading is bold, the date and the bullet muted.
  const tagged = readableRows('## Learned from you\n\n- 2026-11-14: Use pnpm.', 40, { now: new Date(2026, 10, 15) });
  assert.match(tagged[0], /\{bold\}Learned from you\{\/bold\}/);
  assert.equal(tagged[2], '{247-fg}Nov 14{/}'); assert.match(tagged[3], /^\{247-fg\}• \{\/\}\{255-fg\}Use pnpm\.\{\/\}$/);
});

test('numbers, nested items, rows that carry on an item, fenced lines and odd dates are drawn as they are', () => {
  assert.deepEqual(rows('1. first\n2. second\n- a\n  - b\n- item\n  more of it'), ['1. first', '', '2. second', '', '• a', '', '  • b', '', '• item', '  more of it']);
  assert.deepEqual(rows('Run:\n```\n# not a heading\n- not an item\n```\nAfter.'), ['Run:', '', '  # not a heading', '  - not an item', '', 'After.']);
  assert.deepEqual(rows('- 2026-13-40: not a date\r\n- 2026-11-14:no space'), ['• 2026-13-40: not a date', '', '• 2026-11-14:no space']);
  assert.deepEqual(rows('- 2026-11-9: typed short\n- 2026-11-09: and long'), ['Nov 9', '• typed short', '', '• and long'], 'one day however it is typed');
  assert.deepEqual(rows('\n\nOne.\n\n\n\nTwo.\n\n'), ['One.', '', 'Two.'], 'blank lines stay one, none at the ends');
  assert.deepEqual(rows(''), []); assert.deepEqual(rows('   \n'), []);
  // A word longer than the row breaks: nothing is cut, and markup is shown as text.
  assert.deepEqual(rows(`- ${'x'.repeat(40)} end`, 20), ['• xxxxxxxxxxxxxxxxxx', '  xxxxxxxxxxxxxxxxxx', '  xxxx end']);
  assert.equal(readableRows('a {bold} b', 20, { colour: false })[0], 'a {open}bold{close} b');
});

test('a tab is spaces to the next multiple of four from the start of its line, so a row that holds one fits and carries on under its indent', () => {
  const drawn = rows('```\n\tmake build && make test\n```\n- a\tb\n\n\tc\td', 20);
  assert.deepEqual(drawn, ['      make build &&', '      make test', '', '• a b', '', '    c   d']);
  assert.ok(drawn.every(row => !row.includes('\t') && columns(row) <= 20), 'no tab for the terminal to draw wider than counted');
});
