import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, chatBlock, messageTime, visible } from '../lib/terminal-visuals.mjs';
import { columns } from '../lib/width.mjs';

test('chat text wraps at words, keeps list indents, and counts wide characters', () => {
  assert.deepEqual(wrapText('alpha beta gamma', 11), ['alpha beta', 'gamma']);
  assert.deepEqual(wrapText('- one two three four', 10), ['- one two', '  three', '  four']);
  assert.deepEqual(wrapText('12. abc def ghi', 9), ['12. abc', '    def', '    ghi']);
  assert.deepEqual(wrapText('abcdefghij', 8), ['abcdefgh', 'ij'], 'a long word breaks');
  assert.deepEqual(wrapText('你好世界你好', 8), ['你好世界', '你好']);
  assert.deepEqual(wrapText('a\n\nb', 20), ['a', '', 'b'], 'blank lines stay');
});

// A message of any length shows in the chat. One long line (a pasted log, minified JSON) is
// wrapped in one pass: every row measures only what it holds, never the rest of the line again.
test('one line of 300,000 characters is wrapped in a moment, every word in its place', () => {
  const line = Array.from({ length: 10000 }, (_, n) => `Sentence ${n + 1} of the long line.`).join(' ');
  assert.ok(line.length > 300000);
  const started = Date.now(), rows = wrapText(line, 100), took = Date.now() - started;
  assert.equal(rows.join(' '), line, 'every character, in order');
  assert.ok(rows.every(row => row.length <= 100) && rows.length > 3000);
  assert.ok(took < 3000, `wrapping took ${took} ms`);
  // A long word is still broken, a wide character still counts two columns, and a list item keeps its indent.
  assert.deepEqual(wrapText(`${'你好'.repeat(5)} ab`, 8), ['你好你好', '你好你好', '你好 ab']);
  assert.deepEqual(wrapText(`- one ${'x'.repeat(20)} two`, 10), ['- one', '  xxxxxxxx', '  xxxxxxxx', '  xxxx two']);
});

test('a message block has a header, then every row behind the bar; yours sit on a band', () => {
  const plain = chatBlock({ title: 'You', time: '5:12 PM', text: 'one two three four five six', tone: 'orange', width: 14, colour: false });
  assert.equal(visible(plain), 'You  5:12 PM\n┃ one two\n┃ three four\n┃ five six');
  const lead = chatBlock({ title: 'Opus 5.5 (lead)', text: 'Use {bold} as text', tone: 'blue', width: 40 });
  assert.match(lead, /^\{75-fg\}\{bold\}Opus 5\.5 \(lead\)\{\/bold\}\{\/\}\n\{75-fg\}┃\{\/\} Use \{open\}bold\{close\} as text$/);
  const band = chatBlock({ title: 'You', text: 'hello\nworld', tone: 'orange', shaded: true, width: 20 }).split('\n').slice(1);
  for (const row of band) { assert.match(row, /^\{235-bg\}\{209-fg\}┃\{\/\}\{235-bg\} /); assert.equal(visible(row).length, 20, 'the band fills the pane'); }
});

// A test of the chat passed or failed by the time of day. From 10:00 to 12:59, and from the 10th
// of a month, a message's time takes a column more: a header that just fit gave its tag up for
// the short one, or was one column too wide and the pane cut its time in two ("12:00" / "PM").
// A header is laid out for the widest time of its kind, so it reads the same at any time.
test('a message header reads the same at any time of day, and no row is wider than the pane', () => {
  const now = new Date(2026, 10, 20, 23, 30), at = (day, hour, minute) => messageTime(new Date(2026, 10, day, hour, minute).toISOString(), now);
  const today = Array.from({ length: 24 }, (_, hour) => [at(20, hour, 0), at(20, hour, 59)]).flat(), earlier = [1, 9, 10, 14].flatMap(day => [at(day, 1, 5), at(day, 12, 0)]);
  assert.deepEqual([today[2], today[24], earlier[0], earlier.at(-1)], ['1:00 AM', '12:00 PM', 'Nov 1 1:05 AM', 'Nov 14 12:00 PM']);
  const waiting = { title: "You (read at the turn's next step)", narrow: 'You (read at next step)' }, schedule = { title: 'Schedule → @sec (starts next turn)' };
  const block = (header, time, width) => visible(chatBlock({ ...header, time, text: 'Also cover refunds', tone: 'blue', shaded: true, width, colour: false }));
  for (const header of [waiting, schedule]) for (let width = columns(header.narrow ?? header.title); width <= 60; width++) for (const times of [today, earlier]) {
    const shapes = new Set(times.map(time => block(header, time, width).replace(time, '<time>')));
    assert.equal(shapes.size, 1, `${header.title} at ${width} columns:\n${[...shapes].join('\n\n')}`);
    for (const time of times) for (const row of block(header, time, width).split('\n')) assert.ok(columns(row) <= Math.max(10, width), `"${row}" at ${width} columns`);
  }
  // At 80 columns the chat beside the list is 43 wide: the short tag, with the time on its row.
  assert.deepEqual(['1:05 AM', '12:00 PM'].map(time => block(waiting, time, 43).split('\n')[0]), ['You (read at next step)  1:05 AM', 'You (read at next step)  12:00 PM']);
  assert.equal(block(waiting, '1:05 AM', 44).split('\n')[0], "You (read at the turn's next step)  1:05 AM", 'one column more fits the tag with any time');
  // A title that leaves no room for the time keeps its words, and the time has a row of its own, whole.
  assert.deepEqual(['1:05 AM', '12:00 PM'].map(time => block(schedule, time, 43).split('\n').slice(0, 2)), [[schedule.title, '1:05 AM'], [schedule.title, '12:00 PM']]);
  assert.equal(block(schedule, '12:00 PM', 44).split('\n')[0], `${schedule.title}  12:00 PM`);
});

test('message times show the clock today and the date before that', () => {
  const now = new Date(2026, 10, 9, 17, 30);
  assert.equal(messageTime(new Date(2026, 10, 9, 17, 12).toISOString(), now), '5:12 PM');
  assert.equal(messageTime(new Date(2026, 10, 8, 9, 5).toISOString(), now), 'Nov 8 9:05 AM');
  assert.equal(messageTime('not a date', now), '');
});
