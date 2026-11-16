import test from 'node:test';
import assert from 'node:assert/strict';
import { asWritten, markdownRows, unmark } from '../lib/markdown.mjs';
import { columns } from '../lib/width.mjs';

// A model's Markdown drawn for the terminal (lib/markdown.mjs): what each row shows, that every
// row fits the width, that no control character in the text reaches a row, and that the rows
// copy back to the text exactly as it was written.
const REPLY = [
  '## Coupon check',
  '',
  'The **normalize** step in `src/coupon.mjs` keeps the case, so *SAVE10* never matches.',
  '',
  '1. Read the module',
  '   - trims spaces first',
  '2. Run the coupon test',
  '',
  '| File | Change | Why it matters for the checkout flow | Risk |',
  '|------|--------|--------------------------------------|:----:|',
  '| src/coupon.mjs | upper-cases the code before the compare | codes typed in any case now match | low |',
  '',
  '```js',
  "export const normalize = (value) => String(value ?? '').trim().toUpperCase(); // a line that runs past the width of the chat pane at eighty columns and past one hundred and forty too",
  '```',
  '',
  '> The old codes keep working.',
  '',
  '---',
  '',
  'See [the notes](https://example.com/docs) or https://example.com/changelog.',
].join('\n');
const shown = row => unmark(row).replace(/\{\/?[a-z0-9-]*\}/g, '').replace(/\{open\}/g, '{').replace(/\{close\}/g, '}');
const copied = rows => {
  const out = []; let last = null;
  rows.copy.forEach(place => { if (place.skip) return; const text = [place.line].flat().map(line => rows.source[line]).join('\n'); if (!(place.cont && text === last)) out.push(text); last = text; });
  return out.join('\n');
};

test('a reply draws its heading, list, table, code, quote, rule and links inside the width, and copies back as written', () => {
  for (const width of [43, 74, 134]) {
    const rows = markdownRows(REPLY, width), plain = rows.map(shown);
    for (const row of plain) assert.ok(columns(row) <= width, `${JSON.stringify(row)} fits ${width}`);
    assert.equal(plain[0], 'Coupon check');
    assert.ok(plain.some(row => row.startsWith('The normalize step in src/coupon.mjs')));
    assert.ok(plain.includes('1. Read the module') && plain.includes('   ◦ trims spaces first'));
    assert.ok(plain.some(row => row.includes('↪')), 'the long code line carries on under ↪');
    assert.ok(plain.includes('│ The old codes keep working.'));
    assert.ok(plain.some(row => row.includes('the notes (https://example.com/docs)')), 'the address shows beside its link');
    assert.equal(copied(rows), REPLY, `copy at ${width}`);
  }
  assert.ok(markdownRows(REPLY, 74).map(shown).some(row => row.startsWith('┌')), 'the table is boxed where its words fit');
  assert.ok(markdownRows(REPLY, 43).map(shown).includes('Risk: low'), 'too narrow for its words, each row lists its cells');
});

test('a person\'s words inside a thread show as written, and end a code block the model left open', () => {
  const thread = ['you · question', asWritten('Is **this** right?\n- yes\n# no'), '', '↳ answer', '## Found\n\n```\nopen code', asWritten('you · question'), asWritten('> mine')].join('\n');
  const rows = markdownRows(thread, 40), plain = rows.map(shown);
  for (const line of ['Is **this** right?', '- yes', '# no', '> mine', 'you · question']) assert.ok(plain.includes(line), line);
  assert.ok(plain.includes('Found') && plain.some(row => row.includes('open code')));
  assert.equal(copied(rows), thread.replaceAll('', ''));
});

test('no control character in the text reaches a row', () => {
  const rows = markdownRows('# A \x1b[31mred\x1b[0m title\n\n[x](https://a.example/\x1b]8;;evil\x07) `\x1b[2J` \x9b1m\n\n```\n\x1b[41mbg\n```', 60);
  for (const row of rows) assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(row), JSON.stringify(row));
});
