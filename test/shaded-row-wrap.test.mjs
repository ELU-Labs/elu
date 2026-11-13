import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import blessed from 'blessed';
import { chatBlock, ink, wrapText, keepRows } from '../lib/terminal-visuals.mjs';

// The pane beside the list as the app sets it up (lib/terminal.mjs): a border, two columns of
// padding each side, a scroll bar, and rows the app wrapped to the pane (chatWidth). blessed
// wrapped a coloured row that fills the pane a second time: at width 40 "et" of your own message
// stood on a row of its own, and at 80 columns "run" and "60;" of an ELU line, without the bar.
function screenFor(t) {
  const output = new PassThrough(); output.isTTY = true; output.columns = 220; output.rows = 10; output.resume();
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
  const screen = blessed.screen({ input, output, terminal: 'xterm-256color', fullUnicode: true, warnings: false });
  t.after(() => screen.destroy());
  return room => keepRows(blessed.box({ parent: screen, top: 0, left: 0, width: room + 7, height: 8, border: 'line', tags: true, scrollable: true, alwaysScroll: true, padding: { left: 2, right: 2 }, scrollbar: { ch: '┃' } }));
}
// What blessed shows, and what the app handed it, without colours.
const shown = pane => pane._clines.map(row => row.replace(/\x1b\[[\d;]*m/g, '').replace(/\x03/g, ''));
const handed = content => content.split('\n').map(row => row.replace(/\{open\}/g, '\x00').replace(/\{close\}/g, '\x01').replace(/\{\/?[a-z0-9-]*\}/g, '').replace(/\x00/g, '{').replace(/\x01/g, '}'));
const note = (text, room, tone = 'muted') => wrapText(text, room - 1).map(row => ink(row, tone, true)).join('\n');
const TEXTS = {
  words: 'alpha beta gamma delta epsilon zeta et alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega',
  command: 'Stopping also ended a command the agent started: for i in $(seq 1 110); do gh run list --limit 1 >/dev/null 2>&1; sleep 60; done.',
  braces: 'const a = {b: {c: 1}}; if (x) { y(); } else { z({k: v}); } and more words here to fill a row up with { and } signs',
  emoji: 'Done ✅ shipped 🚀 the fix 🎉 for the row 👍 that wrapped twice 😀 at every width 🙂 we could try',
  wide: '这是一个很长的中文句子 with some English words 混合在一起 to see how the rows wrap 在窗格里面',
  list: 'Three things:\n- the first one is a long item that goes on past the end of the row\n- the second\n\n1. and a numbered one that also goes on past the end of the row it starts on',
};
// Every kind of row the chat draws, built as lib/terminal.mjs builds it.
const KINDS = {
  'your message': (text, room) => chatBlock({ title: 'You', time: '5:12 PM', text, tone: 'blue', shaded: true, width: room }),
  'a line from ELU': (text, room) => chatBlock({ title: 'ELU', time: '6:19 PM', text, tone: 'blue', shaded: true, width: room }),
  'a waiting message': (text, room) => `${chatBlock({ title: 'You (waiting)', text, tone: 'blue', shaded: true, width: room })}\n${note('Sent when this turn ends.', room)}\n${note('↑ in the message box takes it back', room)}`,
  'a saved request': (text, room) => `${chatBlock({ title: 'Saved request', text, tone: 'blue', shaded: true, width: room })}\n${note('Send it to retry. /stop cancels it.', room)}`,
  'the lead\'s reply': (text, room) => chatBlock({ title: 'Opus 5.5 (high)', narrow: 'Opus 5.5', time: '5:13 PM', text, tone: 'orange', width: room }),
  'a question': (text, room) => chatBlock({ title: 'Opus 5.5 is waiting for you', text: `${text}\n\nWhich one?\n\n1. The first\n2. The second`, tone: 'orange', width: room }),
  'a bot\'s reply': (text, room) => chatBlock({ title: '@sec', time: '5:14 PM', text, tone: 'violet', width: room }),
  'a command': (text, room) => chatBlock({ title: 'Shell', text: `$ ${text}`, tone: 'green', width: room }),
  'a note': (text, room) => note(text, room, 'orange'),
  'a coloured row as wide as the pane': (text, room) => wrapText(text, room).map(row => ink(row, 'muted', true, true)).join('\n'),
};

test('every kind of chat row is shown as the app wrapped it, at every width', t => {
  const paneFor = screenFor(t);
  for (const [kind, build] of Object.entries(KINDS)) for (const [name, text] of Object.entries(TEXTS)) {
    for (let room = 20; room <= 200; room++) {
      const pane = paneFor(room), content = build(text, room);
      pane.setContent(content);
      // A title wider than a very narrow pane is the one row blessed still wraps: the message under it is compared.
      const want = handed(content), under = blessed.unicode.strWidth(want[0]) > room ? want.length - 1 : want.length, rows = shown(pane).slice(-under);
      // Wrapped once, by the app: no word on a row of its own, no row without its bar.
      assert.deepEqual(rows, want.slice(-under), `${kind}, ${name}, at ${room}`);
      assert.ok(shown(pane).every(row => blessed.unicode.strWidth(row) <= room), `${kind}, ${name}: every row fits at ${room}`);
      if (!content.includes('{247-fg}') && content.includes('┃')) assert.ok(want.slice(1).every(row => row.startsWith('┃')) && rows.slice(1 - want.length).every(row => row.startsWith('┃')), `${kind}, ${name}: every row of the message is behind its bar at ${room}`);
      pane.destroy();
    }
  }
});

test('the rows the owner saw split are whole: "et" at width 40, "run" and "60;" at 80 columns', t => {
  const paneFor = screenFor(t);
  const yours = paneFor(40);
  yours.setContent(chatBlock({ title: 'You', text: 'alpha beta gamma delta epsilon zeta et', tone: 'blue', shaded: true, width: 40 }));
  assert.deepEqual(shown(yours), ['You', '┃ alpha beta gamma delta epsilon zeta et']);
  // 80 columns: the pane beside the list is 50 wide, its rows 43.
  const line = paneFor(43);
  line.setContent(chatBlock({ title: 'ELU', time: '6:19 PM', text: TEXTS.command, tone: 'blue', shaded: true, width: 43 }));
  assert.deepEqual(shown(line).map(row => row.trimEnd()), ['ELU  6:19 PM', '┃ Stopping also ended a command the agent', '┃ started: for i in $(seq 1 110); do gh run', '┃ list --limit 1 >/dev/null 2>&1; sleep 60;', '┃ done.']);
});

test('a row wider than the pane is still wrapped, so nothing runs past the edge', t => {
  const pane = screenFor(t)(30);
  pane.setContent(`${ink('one two three four five six seven eight nine ten eleven twelve', 'muted', true)}\nshort`);
  const rows = shown(pane);
  assert.ok(rows.length > 2 && rows.every(row => row.length <= 30), JSON.stringify(rows));
  assert.equal(rows.slice(0, -1).join(''), 'one two three four five six seven eight nine ten eleven twelve', 'no word is lost');
  assert.deepEqual(pane._clines.rtof, [...Array(rows.length - 1).fill(0), 1], 'each shown row knows its line');
  assert.deepEqual(pane._clines.ftor, [[...Array(rows.length - 1).keys()], [rows.length - 1]]);
});
