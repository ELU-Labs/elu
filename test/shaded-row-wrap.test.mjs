import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import blessed from 'blessed';
import { chatBlock, ink, wrapText, keepRows } from '../lib/terminal-visuals.mjs';
import { editable } from '../lib/editor.mjs';

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
  'a message that has not run': (text, room) => `${chatBlock({ title: 'You (answered · starts when this turn ends)', narrow: 'You (answered · next turn)', time: '5:12 PM', text, tone: 'blue', shaded: true, width: room })}\n${note('Answered beside the running turn, from what it has done so far. The turn goes on.', room)}\n${note('It asks for work, so it also starts the next turn when this one ends.', room)}\n${note('Enter in the empty box sends it now: that stops the turn and the command that is running · ↑ takes it back', room)}`,
  'an answer beside the turn': (text, room) => chatBlock({ title: 'Codex · beside the turn', time: '5:12 PM', text, tone: 'orange', width: room }),
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

// The other panes, as the app sets them up: a list (its rows are one line high), a one-row
// text (the title over a session, the key bar), the text box of a dialog, the message box as
// the editor lays it out, and a pane that does not wrap (the Changes view). keepRows on the
// screen keeps the rows of each, whenever it is put there.
function paired(t) {
  const make = () => { const output = new PassThrough(); output.isTTY = true; output.columns = 220; output.rows = 12; output.resume(); const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {}; const screen = blessed.screen({ input, output, terminal: 'xterm-256color', fullUnicode: true, warnings: false }); t.after(() => screen.destroy()); return screen; };
  return { kept: keepRows(make()), plain: make() };
}
// A row of words exactly `room` columns wide: "et", its last word, is the one blessed moved down.
const filling = room => { const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda'.split(' '); let row = ''; for (let at = 0; row.length < room - 12; at++) row += `${words[at % words.length]} `; return `${row}${'m'.repeat(room - row.length - 3)} et`; };
const PANES = {
  // lib/terminal.mjs pane(): the list's last column is its scroll bar, so a row has one less.
  'a list row': (screen, room, text) => { const list = blessed.list({ parent: screen, top: 0, left: 0, width: room + 1, height: 4, tags: true, scrollbar: { ch: '┃' } }); list.setItems([ink(text, 'muted', true), 'short']); return list.items[0]; },
  'a one-row text': (screen, room, text) => blessed.text({ parent: screen, top: 0, left: 0, width: room, height: 1, tags: true, content: ink(text, 'text', true, true) }),
  'the text box of a dialog': (screen, room, text) => { const modal = blessed.box({ parent: screen, top: 0, left: 0, width: room + 3, height: 8, border: 'line' }); const box = blessed.box({ parent: modal, top: 1, left: 1, width: '100%-2', height: '100%-2', scrollable: true, tags: true, scrollbar: { ch: '|' } }); box.setContent(`${ink(text, 'orange', true)}\nshort`); return box; },
  'a pane that does not wrap': (screen, room, text) => blessed.box({ parent: screen, top: 0, left: 0, width: room + 2, height: 4, border: 'line', tags: true, wrap: false, content: `${ink(text, 'muted', true)}\nshort` }),
};

test('on a screen that keeps its rows, a row that fills a list, a one-row text, a dialog or a pane that does not wrap is whole at every width', t => {
  const { kept, plain } = paired(t), bare = pane => pane._clines.map(row => row.replace(/\x1b\[[\d;]*m/g, ''));
  for (const [kind, build] of Object.entries(PANES)) {
    let split = 0;
    for (let room = 20; room <= 200; room++) {
      const text = filling(room), pane = build(kept, room, text), alone = build(plain, room, text);
      assert.equal(bare(pane)[0], text, `${kind} at ${room}`);
      assert.equal(pane._clines.ftor[0].length, 1, `${kind}: one row at ${room}`);
      if (bare(alone)[0] !== text) split++;
      for (const el of [pane, alone]) { let top = el; while (top.parent && top.parent.type !== 'screen') top = top.parent; top.destroy(); }
    }
    // What this guards: without it blessed moves "et" to a second row, which a one-row pane never shows.
    if (kind !== 'a pane that does not wrap') assert.equal(split, 181, `${kind}: blessed alone wraps the row again at every width`);
  }
});

test('a row with a character that is two units of the string and one column of the screen is whole too, also where the pane does not wrap', t => {
  const { kept, plain } = paired(t), bare = pane => pane._clines.map(row => row.replace(/\x1b\[[\d;]*m/g, ''));
  for (const [kind, build] of Object.entries(PANES)) {
    let broken = 0;
    for (let room = 20; room <= 200; room++) {
      // Two letters from the mathematical alphabet near the start, and the row still as wide as the pane.
      const text = `𝐀𝐁 ${filling(room - 3)}`, pane = build(kept, room, text), alone = build(plain, room, text);
      assert.equal(blessed.unicode.strWidth(text), room);
      assert.equal(bare(pane)[0], text, `${kind} at ${room}`);
      if (bare(alone)[0] !== text) broken++;
      for (const el of [pane, alone]) { let top = el; while (top.parent && top.parent.type !== 'screen') top = top.parent; top.destroy(); }
    }
    assert.equal(broken, 181, `${kind}: blessed alone wraps or cuts the row at every width`);
  }
});

test('a pane put on the screen later, and one inside another, keep their rows; a row wider than its pane is still wrapped', t => {
  const { kept } = paired(t), text = filling(40);
  const outer = blessed.box({ parent: kept, top: 0, left: 0, width: 60, height: 10, border: 'line' }), inner = blessed.box({ parent: outer, top: 0, left: 0, width: 50, height: 8, border: 'line' });
  const deep = blessed.text({ parent: inner, top: 0, left: 0, width: 40, height: 2, tags: true, content: ink(text, 'muted', true) });
  assert.deepEqual(deep._clines.map(row => row.replace(/\x1b\[[\d;]*m/g, '')), [text]);
  // Built on its own, then put on the screen: its text is laid out when it gets there.
  const loose = blessed.text({ screen: kept, top: 0, left: 0, width: 40, height: 2, tags: true, content: ink(text, 'muted', true) });
  kept.append(loose);
  assert.deepEqual(loose._clines.map(row => row.replace(/\x1b\[[\d;]*m/g, '')), [text]);
  const wide = blessed.text({ parent: kept, top: 0, left: 0, width: 30, height: 4, tags: true, content: ink(text, 'muted', true) });
  assert.ok(wide._clines.length > 1 && wide._clines.every(row => row.replace(/\x1b\[[\d;]*m/g, '').length <= 30), 'a row wider than the pane is wrapped');
});

test('the message box shows the rows its editor laid out: one that fills the box and holds such a character is not wrapped again', t => {
  const { kept, plain } = paired(t);
  const box = screen => editable(blessed.textarea({ parent: screen, top: 0, left: 0, width: 40, height: 6, border: 'line', inputOnFocus: false, padding: { left: 1, right: 1 } }));
  const [field, alone] = [box(kept), box(plain)], room = field.editorView().width, value = `𝐀 ${filling(room - 2)} and the rest of the message`;
  for (const each of [field, alone]) each.setValue(value);
  const rows = field.editorView().rows.map(row => value.slice(row.start, row.end));
  assert.equal(blessed.unicode.strWidth(rows[0]), room, 'the first row fills the box');
  assert.deepEqual(field._clines.map(row => row.trimEnd()), rows, 'the box shows the rows the cursor is placed by');
  assert.equal(alone._clines.length, rows.length + 1, 'blessed alone wraps the first row again, under the cursor');
});
