import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, chatBlock, messageTime, visible } from '../lib/terminal-visuals.mjs';

test('chat text wraps at words, keeps list indents, and counts wide characters', () => {
  assert.deepEqual(wrapText('alpha beta gamma', 11), ['alpha beta', 'gamma']);
  assert.deepEqual(wrapText('- one two three four', 10), ['- one two', '  three', '  four']);
  assert.deepEqual(wrapText('12. abc def ghi', 9), ['12. abc', '    def', '    ghi']);
  assert.deepEqual(wrapText('abcdefghij', 8), ['abcdefgh', 'ij'], 'a long word breaks');
  assert.deepEqual(wrapText('你好世界你好', 8), ['你好世界', '你好']);
  assert.deepEqual(wrapText('a\n\nb', 20), ['a', '', 'b'], 'blank lines stay');
});

test('a message block has a header, then every row behind the bar; yours sit on a band', () => {
  const plain = chatBlock({ title: 'You', time: '5:12 PM', text: 'one two three four five six', tone: 'orange', width: 14, colour: false });
  assert.equal(visible(plain), 'You  5:12 PM\n┃ one two\n┃ three four\n┃ five six');
  const lead = chatBlock({ title: 'Opus 5.5 (lead)', text: 'Use {bold} as text', tone: 'blue', width: 40 });
  assert.match(lead, /^\{75-fg\}\{bold\}Opus 5\.5 \(lead\)\{\/bold\}\{\/\}\n\{75-fg\}┃\{\/\} Use \{open\}bold\{close\} as text$/);
  const band = chatBlock({ title: 'You', text: 'hello\nworld', tone: 'orange', shaded: true, width: 20 }).split('\n').slice(1);
  for (const row of band) { assert.match(row, /^\{235-bg\}\{209-fg\}┃\{\/\}\{235-bg\} /); assert.equal(visible(row).length, 20, 'the band fills the pane'); }
});

test('message times show the clock today and the date before that', () => {
  const now = new Date(2026, 10, 9, 17, 30);
  assert.equal(messageTime(new Date(2026, 10, 9, 17, 12).toISOString(), now), '5:12 PM');
  assert.equal(messageTime(new Date(2026, 10, 8, 9, 5).toISOString(), now), 'Nov 8 9:05 AM');
  assert.equal(messageTime('not a date', now), '');
});
