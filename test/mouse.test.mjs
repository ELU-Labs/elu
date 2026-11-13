import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { project } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { launchTerminal } from '../lib/terminal.mjs';
import { layout, position, indexAt, editKey } from '../lib/editor.mjs';
import { spans, spanText, wordSpan, systemClipboard, reportSplitter } from '../lib/selection.mjs';
import { pasteSplitter, pastedText } from '../lib/paste.mjs';
import fs from 'node:fs';
import os from 'node:os';

const width = ch => /[一-鿿]/.test(ch) ? 2 : 1;
const rowsOf = (value, w) => layout(value, w, width).map(row => value.slice(row.start, row.end));

test('the message box wraps at words, hangs a space that does not fit, and keeps every character', () => {
  assert.deepEqual(rowsOf('hello wonderful', 8), ['hello ', 'wonderfu', 'l']);
  assert.deepEqual(rowsOf('hello world foo', 11), ['hello world', 'foo']);
  assert.deepEqual(rowsOf('ab\ncd', 10), ['ab', 'cd']);
  assert.deepEqual(rowsOf('ab\n', 10), ['ab', '']);
  assert.deepEqual(rowsOf('你好世界', 5), ['你好', '世界']);
  assert.deepEqual(rowsOf('', 5), ['']);
});

test('the cursor shows at the start of a wrapped row, and a column maps back to an index', () => {
  const value = 'hello wonderful', rows = layout(value, 8, width);
  assert.deepEqual(position(value, rows, 0, width), { row: 0, col: 0 });
  assert.deepEqual(position(value, rows, 6, width), { row: 1, col: 0 }, 'a soft wrap shows on the next row');
  assert.deepEqual(position(value, rows, value.length, width), { row: 2, col: 1 });
  assert.equal(indexAt(value, rows, 1, 3, width), 9);
  assert.equal(indexAt(value, rows, 0, 99, width), 6, 'past the end is the row end');
  const hang = 'hello world foo', hung = layout(hang, 11, width);
  assert.deepEqual(position(hang, hung, 11, width), { row: 0, col: 11 }, 'before the hanging space: end of the row');
  assert.deepEqual(position(hang, hung, 12, width), { row: 1, col: 0 });
  const wide = '你好世界', laid = layout(wide, 5, width);
  assert.equal(indexAt(wide, laid, 0, 3, width), 1, 'inside a wide character: before it');
  assert.deepEqual(position(wide, laid, 3, width), { row: 1, col: 2 });
});

test('keys move the cursor and edit at it', () => {
  const view = { width: 20, charWidth: width };
  const run = (value, cursor, ...keys) => keys.reduce((state, [ch, key]) => editKey(state, ch, key, view) ?? state, { value, cursor, goal: null });
  const k = (name, extra = {}) => [undefined, { name, ...extra }];
  assert.equal(run('hello', 5, k('left'), k('left')).cursor, 3);
  assert.equal(run('hello', 3, ['X', { name: 'x', sequence: 'X' }]).value, 'helXlo');
  assert.deepEqual(run('hello', 3, k('backspace')), { value: 'helo', cursor: 2, goal: null });
  assert.deepEqual(run('hello', 1, k('delete')), { value: 'hllo', cursor: 1, goal: null });
  assert.equal(run('one\ntwo', 5, k('home')).cursor, 4);
  assert.equal(run('one\ntwo', 0, k('end')).cursor, 3);
  assert.equal(run('one\ntwo', 5, k('a', { ctrl: true })).cursor, 4);
  assert.equal(run('one\ntwo', 4, k('e', { ctrl: true })).cursor, 7, 'Ctrl-E is end of line');
  assert.equal(run('one two three', 13, k('b', { meta: true })).cursor, 8);
  assert.equal(run('one two three', 0, k('f', { meta: true }), k('f', { meta: true })).cursor, 7);
  assert.deepEqual(run('one two three', 7, k('w', { ctrl: true })), { value: 'one  three', cursor: 4, goal: null });
  assert.deepEqual(run('one\ntwo three', 8, k('u', { ctrl: true })), { value: 'one\nthree', cursor: 4, goal: null });
  assert.deepEqual(run('one two\nthree', 3, k('k', { ctrl: true })), { value: 'one\nthree', cursor: 3, goal: null });
  assert.deepEqual(run('one\nthree', 3, k('k', { ctrl: true })), { value: 'onethree', cursor: 3, goal: null }, 'at the line end it joins the next line');
  // Up and down keep the column, clamped to shorter lines.
  const moved = run('abcdef\nab\nabcdef', 5, k('down'));
  assert.equal(moved.cursor, 9); assert.equal(moved.goal, 5);
  assert.equal(run('abcdef\nab\nabcdef', 5, k('down'), k('down')).cursor, 15);
  assert.equal(run('abc', 2, k('up')).cursor, 0); assert.equal(run('abc', 1, k('down')).cursor, 3);
  // A pasted line feed is text; Enter and Escape belong to the box.
  assert.equal(run('ab', 1, ['\n', { name: 'enter', sequence: '\n' }]).value, 'a\nb');
  assert.equal(editKey({ value: 'ab', cursor: 1 }, '\r', { name: 'enter', sequence: '\r' }, view), null);
  assert.equal(editKey({ value: 'ab', cursor: 1 }, '\x1b', { name: 'escape' }, view), null);
  // Surrogate pairs move and delete as one character.
  assert.equal(run('😀a', 3, k('left'), k('left')).cursor, 0);
  assert.deepEqual(run('😀a', 2, k('backspace')), { value: 'a', cursor: 0, goal: null });
});

test('a paste is split from the keys around it, however the input is chunked', () => {
  const run = (...chunks) => {
    const keys = [], pastes = [], split = pasteSplitter(text => keys.push(text), text => pastes.push(text));
    for (const chunk of chunks) split(chunk);
    return { keys, pastes };
  };
  assert.deepEqual(run('ab\x1b[200~one\ntwo\x1b[201~cd'), { keys: ['ab', 'cd'], pastes: ['one\ntwo'] });
  assert.deepEqual(run('x\x1b[20', '0~pa', 'ste\x1b[2', '01~y'), { keys: ['x', 'y'], pastes: ['paste'] }, 'markers cut across chunks');
  assert.deepEqual(run(Buffer.from('\x1b[200~你好\x1b[201~').subarray(0, 8), Buffer.from('\x1b[200~你好\x1b[201~').subarray(8)), { keys: [], pastes: ['你好'] }, 'a character cut across chunks');
  assert.deepEqual(run('\x1b', '[D'), { keys: ['\x1b', '[D'], pastes: [] }, 'a lone escape is a key at once');
  assert.deepEqual(run('\x1b[200~a\x1b[201~\x1b[200~b\x1b[201~'), { keys: [], pastes: ['a', 'b'] });
  assert.equal(pastedText('a\r\nb\rc\td\x07e\x1b'), 'a\nb\nc\tde');
});

test('a selection runs in reading order inside its pane and copies trimmed text', () => {
  const rect = { x0: 2, y0: 1, x1: 9, y1: 3 };
  assert.deepEqual(spans(rect, { x: 5, y: 2 }, { x: 3, y: 1 }), [[1, 3, 9], [2, 2, 5]]);
  assert.deepEqual(spans(rect, { x: 0, y: 0 }, { x: 20, y: 9 }), [[1, 2, 9], [2, 2, 9], [3, 2, 9]], 'clamped to the pane');
  const row = text => [...text].map(ch => [0, ch]);
  const lines = [row('│ hello   │'), row('│ wor你\x03d  │'), row('│ end     │')];
  assert.equal(spanText(lines, [[0, 2, 9], [1, 2, 9]]), 'hello\nwor你d');
  assert.equal(spanText(lines, [[0, 2, 9], [1, 2, 9]], () => ' '), 'hello wor你d');
  assert.deepEqual(wordSpan(lines[1], 4, 2, 9), [2, 7]);
  assert.equal(wordSpan(lines[0], 8, 2, 9), null);
});

// The terminal app with a real screen, fed SGR mouse reports.
async function until(check, message = 'condition', timeout = 10000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function view(t, { protocol = 'sgr' } = {}) {
  const removals = [], p = project({ after: close => removals.push(close) });
  const previous = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM };
  Object.assign(process.env, { XDG_CONFIG_HOME: path.join(p.parent, 'personal'), NO_COLOR: '1', TERM: 'xterm-256color' });
  const input = new PassThrough(), output = new PassThrough(), copied = [];
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = 100; output.rows = 30;
  let sent = ''; output.on('data', data => { sent += data.toString(); });
  let rendered;
  const finished = launchTerminal({ repo: repository(p.root), input, output, refreshMs: 30, startConductor: () => false, clipboard: text => copied.push(text), onRender: value => { rendered = value; } });
  finished.catch(() => {});
  await until(() => rendered, 'first render');
  // A failed test can leave a dialog open, and the app ignores q while one is: every pass
  // closes what is open (closing one can open the next) and presses q again. A view that
  // still will not close is interrupted the way a hangup would, and if even that fails the
  // test fails here: this never waits forever. The environment and the test's folders are
  // put back either way.
  t.after(async () => {
    let closed = false; finished.then(() => { closed = true; }, () => { closed = true; });
    try {
      for (const started = Date.now(); !closed && !rendered.screen.destroyed;) {
        const waited = Date.now() - started;
        if (waited > 10000) throw new Error('The view did not close after its test.');
        rendered.panels.ask.cancel();
        for (const child of [...rendered.screen.children]) { child.dismiss?.(); child.children?.find(item => item.type === 'textbox')?.emit('cancel'); }
        if (waited > 3000) process.emit('SIGHUP');
        else { rendered.panels.tabs[0].focus(); rendered.screen.emit('keypress', 'q', { name: 'q' }); }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally {
      input.destroy(); output.destroy();
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      for (const close of removals.reverse()) await close();
    }
  });
  // x and y are 0-based screen cells; SGR reports are 1-based.
  // SGR reports, or the X10/UTF-8 ones blessed asks xterm-like terminals for: offset by 32,
  // with no button on release (code 3).
  const report = (b, x, y, up = false) => protocol === 'sgr' ? `\x1b[<${b};${x + 1};${y + 1}${up ? 'm' : 'M'}`
    : `\x1b[M${String.fromCharCode(32 + (up ? 3 : b), 33 + x, 33 + y)}`;
  const mouse = (b, x, y, up = false) => input.write(report(b, x, y, up));
  return {
    // Reports and keys in one write reach the app in one read, as they do when it was busy.
    report, together: (...parts) => input.write(parts.join('')),
    input, copied, get sent() { return sent; }, get current() { return rendered; }, get ask() { return rendered.panels.ask; },
    press: (x, y) => mouse(0, x, y), drag: (x, y) => mouse(32, x, y), release: (x, y) => mouse(0, x, y, true),
    click(x, y) { mouse(0, x, y); mouse(0, x, y, true); },
    // The screen cell of a row and column inside the message box.
    cell(row, col) { const pos = rendered.panels.ask.lpos, ask = rendered.panels.ask; return { x: pos.xi + ask.ileft + col, y: pos.yi + ask.itop + row - (ask.childBase || 0) }; },
  };
}
async function typing(v, value) {
  v.ask.focus(); v.ask.readInput(); await until(() => v.ask.__listener, 'message box');
  v.ask.setValue(value); v.current.screen.render();
}

for (const protocol of ['sgr', 'x10']) {
  test(`a click moves the message box cursor, arrows move it, and typing inserts there (${protocol})`, async t => {
    const v = await view(t, { protocol });
    await typing(v, 'first line\nsecond line here');
    assert.equal(v.ask.cursor, 'first line\nsecond line here'.length);
    const at = v.cell(1, 3); v.click(at.x, at.y);
    await until(() => v.ask.cursor === 14, 'cursor at the click');
    v.input.write('X'); await until(() => v.ask.getValue() === 'first line\nsecXond line here', 'typed at the cursor');
    v.input.write('\x1b[D\x1b[D'); await until(() => v.ask.cursor === 13, 'left arrow');
    v.input.write('\x1b[A'); await until(() => v.ask.cursor === 2, 'up keeps the column');
    v.input.write('\x7f'); await until(() => v.ask.getValue() === 'frst line\nsecXond line here', 'backspace at the cursor');
    // Past the end of a row the cursor goes to that row's end.
    const end = v.cell(0, 40); v.click(end.x, end.y);
    await until(() => v.ask.cursor === 9, 'end of the first row');
    assert.equal(v.copied.length, 0, 'clicks copy nothing');
  });

  test(`dragging selects and copies on release without clicking; a double click copies a word (${protocol})`, async t => {
    const v = await view(t, { protocol });
    await typing(v, 'first line\nsecond line here');
    const before = v.ask.cursor;
    const a = v.cell(0, 0), b = v.cell(0, 4);
    v.press(a.x, a.y); v.drag(a.x + 2, a.y); v.drag(b.x, b.y);
    await until(() => v.current.selection.active, 'selection shown');
    v.release(b.x, b.y);
    await until(() => v.copied.length === 1, 'copied');
    assert.equal(v.copied[0], 'first');
    assert.equal(v.ask.cursor, before, 'the release is not a click');
    await until(() => /Copied 5 characters\./.test(v.current.panels.status.getText()), 'status line');
    const drawn = () => v.current.screen.lines.map(row => row.map(cell => cell[1]).join('')).join('\n');
    await until(() => /› Copied 5 characters\./.test(drawn()), 'status line on screen');
    // Across rows, in the message box, the copy keeps the newline.
    const c = v.cell(0, 6), d = v.cell(1, 5);
    v.press(c.x, c.y); v.drag(d.x, d.y); v.release(d.x, d.y);
    await until(() => v.copied.length === 2, 'second copy');
    assert.equal(v.copied[1], 'line\nsecond');
    // A key clears the highlight.
    v.input.write('\x1b[C'); await until(() => !v.current.selection.active, 'cleared by a key');
    const w = v.cell(1, 8); v.click(w.x, w.y); v.click(w.x, w.y);
    await until(() => v.copied.length === 3, 'double click');
    assert.equal(v.copied[2], 'line');
  });
}

test('a paste lands in the message box whole, as one edit, and its newlines do not send', async t => {
  const v = await view(t);
  assert.ok(v.sent.includes('\x1b[?2004h'), 'bracketed paste asked for');
  await typing(v, 'start ');
  let edits = 0; const listener = v.ask._listener; v.ask._listener = function(...args) { edits++; return listener.apply(this, args); };
  v.input.write('\x1b[200~line one\nline two\x1b[201~');
  await until(() => v.ask.getValue() === 'start line one\nline two', 'pasted');
  assert.equal(v.ask.cursor, 'start line one\nline two'.length);
  assert.equal(edits, 1, 'one edit');
  // The terminal may hand the paste over in pieces.
  v.input.write('\x1b[20'); v.input.write('0~ and\r\nthree\x1b[2'); v.input.write('01~!');
  await until(() => v.ask.getValue() === 'start line one\nline two and\nthree!', 'chunked paste then a key');
  assert.equal(edits, 3, 'one edit for the paste, one for the key');
});

test('Backspace or Delete removes the highlighted text in the message box', async t => {
  const v = await view(t);
  await typing(v, 'first line\nsecond line here');
  const a = v.cell(0, 6), b = v.cell(1, 5);
  v.press(a.x, a.y); v.drag(b.x, b.y); v.release(b.x, b.y);
  await until(() => v.copied.length === 1, 'copied');
  assert.equal(v.copied[0], 'line\nsecond');
  v.input.write('\x7f');
  await until(() => v.ask.getValue() === 'first  line here', 'highlighted text removed');
  assert.equal(v.ask.cursor, 6, 'cursor where the highlight began');
  assert.equal(v.current.selection.active, false);
  const c = v.cell(0, 0), d = v.cell(0, 4);
  v.press(c.x, c.y); v.drag(d.x, d.y); v.release(d.x, d.y);
  await until(() => v.copied.length === 2, 'copied again');
  v.input.write('\x1b[3~');
  await until(() => v.ask.getValue() === '  line here', 'Delete removes it too');
  assert.equal(v.ask.cursor, 0);
  // Without a highlight the keys edit at the cursor as before.
  v.input.write('\x1b[3~'); await until(() => v.ask.getValue() === ' line here', 'Delete at the cursor');
});

test('in Sessions a drag stays in the pane it starts in: the list on the left, or the session on the right', async t => {
  const v = await view(t), { board, boardBox, compose, composeList } = v.current.panels;
  await until(() => board.lpos && composeList.lpos && !compose.hidden, 'the list and the form are drawn');
  assert.ok(boardBox.aleft + boardBox.width <= compose.aleft, 'side by side');
  // From the list's first row, down two rows and far to the right, over the form.
  const start = { x: board.lpos.xi + 1, y: board.lpos.yi }, far = { x: composeList.lpos.xl - 3, y: board.lpos.yi + 2 };
  v.press(start.x, start.y); v.drag(start.x + 4, start.y); v.drag(far.x, far.y);
  await until(() => v.current.selection.active, 'selection shown');
  const range = v.current.selection.range();
  assert.equal(range.el, board, 'the selection belongs to the list'); assert.ok(range.to.x < boardBox.aleft + boardBox.width - 1, 'it ends inside the list');
  v.release(far.x, far.y); await until(() => v.copied.length === 1, 'copied');
  assert.equal(v.copied[0], '+ New session\n\n No sessions yet.'); assert.doesNotMatch(v.copied[0], /Project|sample app|Permissions/);
  // From the form's first row, down and far to the left, over the list.
  const from = { x: composeList.lpos.xi + 4, y: composeList.lpos.yi + 2 }, left = { x: 1, y: composeList.lpos.yi };
  v.press(from.x, from.y); v.drag(from.x - 2, from.y); v.drag(left.x, left.y);
  await until(() => v.current.selection.active, 'second selection shown');
  assert.equal(v.current.selection.range().el, composeList, 'the selection belongs to the form'); assert.ok(v.current.selection.range().from.x >= compose.aleft, 'it starts inside the form');
  v.release(left.x, left.y); await until(() => v.copied.length === 2, 'copied again');
  assert.match(v.copied[1], /^Project +sample app\nWhen +now/); assert.doesNotMatch(v.copied[1], /New session|No sessions yet/);
  // A double click on a word of the list copies that word, and nothing from the right.
  const word = { x: board.lpos.xi + 7, y: board.lpos.yi }; v.click(word.x, word.y); v.click(word.x, word.y);
  await until(() => v.copied.length === 3, 'double click'); assert.equal(v.copied[2], 'session');
});

test('a drag in the help dialog copies wrapped text as one line', async t => {
  const v = await view(t);
  v.ask.focus(); v.ask.readInput(); await until(() => v.ask.__listener, 'message box');
  v.ask.setValue('/help'); v.ask.submit();
  const dialog = () => v.current.screen.children.find(child => !child.destroyed && child.options?.label?.trim() === 'Commands');
  await until(() => dialog(), 'help');
  const body = dialog().children.find(child => child.options?.scrollable);
  await until(() => body.lpos, 'help drawn');
  const pos = body.lpos, x0 = pos.xi + body.ileft, y0 = pos.yi + body.itop, x1 = pos.xl - 1 - body.iright;
  v.press(x0, y0); v.drag(x1, y0 + 1); v.release(x1, y0 + 1);
  await until(() => v.copied.length === 1, 'copied');
  assert.match(v.copied[0], /^Six tabs: Sessions, Projects, Kanban, Chats, Bots, and Usage\. Tab moves between areas;/);
  assert.doesNotMatch(v.copied[0], /\n/, 'a soft wrap is not a newline');
  assert.doesNotMatch(v.copied[0], /│/, 'the border is outside the pane');
});

for (const protocol of ['sgr', 'x10']) {
  test(`a click in a dialog's field keeps the dialog open and puts the cursor there (${protocol})`, async t => {
    const v = await view(t, { protocol });
    v.ask.focus(); v.ask.readInput(); await until(() => v.ask.__listener, 'message box');
    v.ask.setValue('/help'); v.ask.submit();
    const dialog = () => v.current.screen.children.find(child => !child.destroyed && child.options?.label?.trim() === 'Commands');
    await until(() => dialog(), 'help');
    const field = dialog().children.find(child => child.type === 'textbox');
    await until(() => field.lpos && field.__listener, 'field reading');
    v.input.write('abcdef'); await until(() => field.value === 'abcdef', 'typed');
    const x = field.lpos.xi + field.ileft, y = field.lpos.yi + field.itop;
    v.click(x + 2, y);
    await until(() => field.cursor === 2, 'cursor at the click');
    v.click(x + 4, y);
    await until(() => field.cursor === 4, 'a second click moves it again');
    assert.ok(dialog(), 'the dialog stays open');
    assert.equal(v.current.screen.focused, field);
    v.input.write('X'); await until(() => field.value === 'abcdXef', 'typed at the click');
    v.input.write('\r'); await until(() => !dialog(), 'Enter submits');
  });
}

test('a long message wraps the same way blessed draws it, and a click on a wrapped row lands there', async t => {
  const v = await view(t);
  const value = 'Please look at the uploader retry budget and tell me whether it resets after a flush or only after a restart, because we keep seeing duplicate batches in the logs every morning.';
  await typing(v, value);
  const view0 = v.ask.editorView();
  assert.ok(view0.rows.length >= 2, 'the message wraps');
  assert.equal(v.ask._clines.length, view0.rows.length, 'blessed does not wrap the rows again');
  const second = view0.rows[1], at = v.cell(1, 4);
  v.click(at.x, at.y);
  await until(() => v.ask.cursor === second.start + 4, 'cursor on the wrapped row');
  await until(() => v.current.screen.program.x === at.x && v.current.screen.program.y === at.y, 'terminal cursor at the click');
  v.input.write('Z'); await until(() => v.ask.getValue() === value.slice(0, second.start + 4) + 'Z' + value.slice(second.start + 4), 'typed there');
});

test('mouse reports that arrive in one read are split, and of a run of moves the last is kept', () => {
  const show = parts => parts.map(part => part.toString('latin1'));
  let split = reportSplitter();
  assert.deepEqual(show(split('\x1b[<32;10;5M\x1b[<32;11;5M\x1b[<0;11;5m')), ['\x1b[<32;11;5M', '\x1b[<0;11;5m'], 'the release is a part of its own');
  assert.deepEqual(show(split('a\x1b[<0;3;1Mb\x1b[<0;3;1mc')), ['a', '\x1b[<0;3;1M', 'b', '\x1b[<0;3;1m', 'c'], 'keys between reports stay, in order');
  assert.deepEqual(show(split('\x1b[<32;4;1Mé\x1b[<32;5;1M')), ['\x1b[<32;4;1M', Buffer.from('é').toString('latin1'), '\x1b[<32;5;1M'], 'a key between two moves keeps both');
  assert.deepEqual(show(split('\x1b[<64;3;1M\x1b[<64;3;1M\x1b[<0;3;1M\x1b[<0;3;1M')).length, 4, 'wheel steps and presses are never dropped');
  assert.deepEqual(show(split('\x1b[<35;1;1M\x1b[<32;2;1M')).length, 2, 'a hover and a drag are different moves');
  assert.deepEqual(show(split('x\x1b[<32;1')), ['x']);
  assert.deepEqual(show(split('0;5M\x1b[<0;10;5m')), ['\x1b[<32;10;5M', '\x1b[<0;10;5m'], 'a report cut by the end of a read waits for the rest');
  assert.deepEqual(show(split('\x1b')), ['\x1b'], 'a lone Escape is a key');
  assert.deepEqual(show(split('\x1b[A\x1b[1;5C\x1b[200~')), ['\x1b[A\x1b[1;5C\x1b[200~'], 'other sequences pass as they came');
  // X10 with UTF-8 coordinates, and urxvt: column 121 is two bytes in the first.
  const x10 = (b, x, y) => `\x1b[M${String.fromCharCode(32 + b, 33 + x, 33 + y)}`;
  split = reportSplitter();
  const parts = split(Buffer.from(x10(32, 120, 5) + x10(32, 121, 5) + x10(3, 121, 5)));
  assert.deepEqual(parts.map(part => part.toString()), [x10(32, 121, 5), x10(3, 121, 5)]);
  assert.deepEqual(split(Buffer.from(x10(0, 120, 5)).subarray(0, 5)), [], 'a coordinate cut in two waits');
  assert.deepEqual(split(Buffer.from(x10(0, 120, 5)).subarray(5)).map(part => part.toString()), [x10(0, 120, 5)]);
  assert.deepEqual(show(split('\x1b[64;10;5M\x1b[64;11;5M\x1b[35;11;5M')), ['\x1b[64;11;5M', '\x1b[35;11;5M']);
});

for (const protocol of ['sgr', 'x10']) {
  test(`a drag copies when its last move and the release arrive in one read (${protocol})`, async t => {
    const v = await view(t, { protocol });
    v.ask.focus(); v.ask.readInput(); await until(() => v.ask.__listener, 'message box');
    v.ask.setValue('/help'); v.ask.submit();
    const dialog = () => v.current.screen.children.find(child => !child.destroyed && child.options?.label?.trim() === 'Commands');
    await until(() => dialog(), 'help');
    const body = dialog().children.find(child => child.options?.scrollable);
    await until(() => body.lpos, 'help drawn');
    const x0 = body.lpos.xi + body.ileft, y0 = body.lpos.yi + body.itop;
    v.press(x0, y0); v.drag(x0 + 2, y0);
    // The app was drawing the highlight: two more moves and the release wait in one read.
    v.together(v.report(32, x0 + 5, y0), v.report(32, x0 + 7, y0), v.report(0, x0 + 7, y0, true));
    await until(() => v.copied.length === 1, 'copied');
    assert.equal(v.copied[0], 'Six tabs');
    assert.ok(dialog(), 'the release was not a click outside the pane');
  });
}

test('a key that arrives in one read with a mouse report is still typed', async t => {
  const v = await view(t);
  await typing(v, 'ab');
  v.together(v.report(35, 4, 4), 'c', v.report(35, 5, 4), 'd');
  await until(() => v.ask.getValue() === 'abcd', 'both keys typed');
});

test('Ctrl-C copies a highlight and stays, and the highlight stays; with nothing highlighted it quits', async t => {
  const v = await view(t);
  await until(() => v.current.screen.lines[0]?.length, 'drawn');
  v.press(2, 0); v.drag(9, 0); v.release(9, 0);
  await until(() => v.copied.length === 1, 'copied on release');
  v.input.write('\x03');
  await until(() => v.copied.length === 2, 'copied on Ctrl-C');
  assert.equal(v.copied[1], v.copied[0]);
  assert.ok(!v.current.screen.destroyed, 'the app is still open');
  assert.equal(v.current.selection.text(), v.copied[0], 'the highlight stays');
  // Read a drawn frame: between frames an idle refresh leaves the status line's cells blank.
  await until(() => { const screen = v.current.screen; screen.render(); return /Copied \d+ characters?\./.test(screen.lines.map(line => line.map(cell => cell[1]).join('')).join('\n')); }, 'the status line says so');
  // The next key ends the highlight, as it does when nothing was copied; Ctrl-C then quits.
  v.input.write('\x1b[C'); await until(() => !v.current.selection.active, 'a key ends it');
  v.input.write('\x03');
  await until(() => v.current.screen.destroyed, 'Ctrl-C with nothing highlighted quits');
  assert.equal(v.copied.length, 2);
});

test('a highlight in a session copies after the app has redrawn while idle: on release, on Ctrl-C, and on a double click', async t => {
  const v = await view(t);
  await typing(v, 'grok login'); v.ask.submit();
  const screen = () => v.current.screen;
  // The cells as they are held between frames, and the rows after a frame is drawn.
  const held = y => (screen().lines[y] ?? []).map(cell => cell[1]).join('');
  const drawn = () => { screen().render(); return screen().lines.map(line => line.map(cell => cell[1]).join('')); };
  let at = null;
  await until(() => { const rows = drawn(), y = rows.findIndex(row => row.includes('┃ grok login')); at = y < 0 ? null : { x: rows[y].indexOf('grok login'), y }; return at; }, 'the message is in the chat');
  // With nothing new to show, the timer sets the chat again and draws no frame: its cells are blank until one is drawn.
  const idle = () => until(() => !held(at.y).includes('grok'), 'an idle refresh without a frame');
  v.press(at.x, at.y); v.drag(at.x + 5, at.y); v.drag(at.x + 9, at.y);
  await idle();
  v.release(at.x + 9, at.y);
  await until(() => v.copied.length === 1, 'copied on release');
  assert.equal(v.copied[0], 'grok login');
  await idle();
  v.input.write('\x03');
  await until(() => v.copied.length === 2, 'copied on Ctrl-C');
  assert.equal(v.copied[1], 'grok login');
  assert.ok(!screen().destroyed, 'Ctrl-C with a highlight does not quit');
  await idle();
  v.click(at.x + 1, at.y); await idle(); v.click(at.x + 1, at.y);
  await until(() => v.copied.length === 3, 'a double click copies the word');
  assert.equal(v.copied[2], 'grok');
});

test('Ctrl-C in a session copies the highlight and keeps it drawn; the next click ends it', async t => {
  const v = await view(t);
  await typing(v, 'grok login'); v.ask.submit();
  const screen = () => v.current.screen;
  const drawn = () => { screen().render(); return screen().lines.map(line => line.map(cell => cell[1]).join('')); };
  // The text a frame draws highlighted: the cells inverted while it is drawn and put back after.
  const highlighted = () => {
    const s = screen(), draw = s.draw, flags = () => s.lines.map(line => line.map(cell => (cell[0] >> 18) & 8));
    let during = [];
    s.draw = function(...args) { const result = draw.apply(this, args); during = flags(); return result; };
    try { s.render(); } finally { s.draw = draw; }
    const after = flags();
    return s.lines.map((line, y) => line.filter((cell, x) => during[y]?.[x] !== after[y][x]).map(cell => cell[1]).join('')).filter(Boolean).join('\n');
  };
  let at = null;
  await until(() => { const rows = drawn(), y = rows.findIndex(row => row.includes('┃ grok login')); at = y < 0 ? null : { x: rows[y].indexOf('grok login'), y }; return at; }, 'the message is in the chat');
  v.press(at.x, at.y); v.drag(at.x + 5, at.y); v.drag(at.x + 9, at.y); v.release(at.x + 9, at.y);
  await until(() => v.copied.length === 1, 'copied on release');
  assert.equal(highlighted(), 'grok login', 'the highlight is drawn');
  v.input.write('\x03');
  await until(() => v.copied.length === 2, 'copied on Ctrl-C');
  assert.equal(v.copied[1], 'grok login');
  await until(() => v.current.panels.status.getText().includes('Copied 10 characters.'), 'the status line says so');
  assert.equal(v.current.selection.text(), 'grok login', 'the highlight stays');
  assert.equal(highlighted(), 'grok login', 'and is drawn');
  v.click(at.x + 1, at.y);
  await until(() => !v.current.selection.active, 'a click ends it');
  assert.equal(highlighted(), '', 'and it is drawn no more');
  assert.equal(v.copied.length, 2, 'the click copies nothing');
});

test('copies go to pbcopy on macOS and to OSC 52 elsewhere', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-clip-')); t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const out = path.join(folder, 'copied.txt');
  fs.writeFileSync(path.join(folder, 'pbcopy'), `#!/bin/sh\ncat > '${out}'\n`, { mode: 0o755 });
  const previous = process.env.PATH; process.env.PATH = `${folder}:${previous}`; t.after(() => { process.env.PATH = previous; });
  systemClipboard({ platform: 'darwin' })('héllo\nworld');
  await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8') === 'héllo\nworld', 'pbcopy got the text');
  const written = [];
  systemClipboard({ platform: 'linux', write: data => written.push(data) })('hi');
  assert.deepEqual(written, [`\x1b]52;c;${Buffer.from('hi').toString('base64')}\x07`]);
});

test('the app asks the terminal for SGR reports, which have no column limit', async t => {
  const v = await view(t);
  await until(() => v.sent.includes('\x1b[?1006h'), 'SGR mode on');
  assert.ok(v.sent.indexOf('\x1b[?1006h') > v.sent.indexOf('\x1b[?1005h'), 'after the UTF-8 mode blessed picks');
});

// Lines of the same length, so a row of the message box starts every eight characters.
const numbered = count => Array.from({ length: count }, (_, index) => `line ${String(index + 1).padStart(2, '0')}`).join('\n');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a drag held above the message box scrolls it up, the anchor stays on its text, and the copy holds the hidden first lines', async t => {
  const v = await view(t), value = numbered(12);
  await typing(v, value);
  assert.equal(v.ask.childBase, 8, 'the box shows its last four lines');
  const cursor = v.ask.cursor, at = v.cell(10, 2), top = v.ask.lpos.yi;
  v.press(at.x, at.y); v.drag(at.x, at.y - 1); v.drag(at.x, top - 2);
  await until(() => v.ask.childBase === 0, 'scrolled to the top');
  const range = v.current.selection.range();
  assert.deepEqual(range.to, { x: at.x, y: at.y + 8 }, 'the anchor moved down with its text, out of view');
  assert.deepEqual(range.from, { x: v.cell(0, 0).x, y: v.cell(0, 0).y }, 'the highlight takes the lines that came into view');
  v.release(at.x, top - 2);
  await until(() => v.copied.length === 1, 'copied');
  assert.equal(v.copied[0], value.slice(0, 10 * 8 + 3));
  assert.equal(v.ask.cursor, cursor, 'the cursor stays'); assert.equal(v.ask.getValue(), value, 'the text stays');
  await pause(150); assert.equal(v.ask.childBase, 0, 'the box stays where the drag took it');
  // The wheel still ends the highlight.
  v.input.write(v.report(64, at.x, v.cell(0, 0).y));
  await until(() => !v.current.selection.active, 'the wheel ends it');
});

test('a drag held below the message box scrolls it down, and letting go stops it', async t => {
  const v = await view(t), value = numbered(40);
  await typing(v, value);
  v.ask.cursor = 0; v.ask.setValue(); v.current.screen.render();
  assert.equal(v.ask.childBase, 0);
  const at = v.cell(1, 3), below = v.ask.lpos.yl;
  v.press(at.x, at.y); v.drag(at.x + 1, at.y); v.drag(at.x, below);
  await until(() => v.ask.childBase >= 5, 'scrolling down');
  v.release(at.x, below);
  await until(() => v.copied.length === 1, 'copied');
  const stopped = v.ask.childBase;
  await pause(300);
  assert.equal(v.ask.childBase, stopped, 'letting go stops the scrolling');
  assert.ok(stopped < 36, 'it stopped before the end');
  // From the press to the end of the last row in view.
  assert.equal(v.copied[0], value.slice(8 + 3, (stopped + 3) * 8 + 7));
  assert.equal(v.ask.cursor, 0); assert.equal(v.ask.getValue(), value);
});

test('a drag held above a session chat scrolls it up, copies the lines scrolled out of view, and the chat stays there', async t => {
  const v = await view(t), value = numbered(40);
  await typing(v, value); v.ask.submit();
  const chat = () => v.current.panels.chat;
  const drawn = () => { v.current.screen.render(); return v.current.screen.lines.map(line => line.map(cell => cell[1]).join('')); };
  let at = null;
  await until(() => { const rows = drawn(), y = rows.findIndex(row => row.includes('┃ line 38')); at = y < 0 ? null : { x: rows[y].indexOf('line 38'), y }; return at; }, 'the end of the message in the chat');
  assert.ok(chat().childBase > 0, 'the start of the message is out of view');
  const top = chat().lpos.yi, base = chat().childBase;
  v.press(at.x + 1, at.y); v.drag(at.x + 1, at.y - 1); v.drag(at.x + 1, top - 1);
  await until(() => chat().childBase < base, 'scrolling up');
  assert.equal(v.current.selection.range().to.y, at.y + base - chat().childBase, 'the anchor moves with its text');
  await until(() => chat().childBase === 0, 'scrolled to the top');
  v.release(at.x + 1, top - 1);
  await until(() => v.copied.length === 1, 'copied');
  assert.ok(v.copied[0].endsWith(`${numbered(37)}\nli`), v.copied[0]);
  await pause(300); assert.equal(chat().childBase, 0, 'the chat stays where the drag took it');
});

// Shift and an arrow, Home or End, as terminals send them.
const SHIFT = { up: '\x1b[1;2A', down: '\x1b[1;2B', right: '\x1b[1;2C', left: '\x1b[1;2D', home: '\x1b[1;2H', end: '\x1b[1;2F' };

test('Shift and Up or Down highlight in the message box by lines, scroll it to the cursor, and Ctrl-C copies the highlight', async t => {
  const v = await view(t), value = numbered(12);
  await typing(v, value);
  v.input.write(SHIFT.up.repeat(3));
  await until(() => v.ask.cursor === 8 * 8 + 7, 'three lines up');
  assert.equal(v.current.selection.text(), '\nline 10\nline 11\nline 12', 'the last three line breaks and what follows them');
  assert.equal(v.current.selection.range().el, v.ask);
  v.input.write(SHIFT.up.repeat(2));
  await until(() => v.ask.cursor === 6 * 8 + 7, 'two more');
  assert.ok(v.ask.childBase <= 6 && v.ask.childBase > 2, 'the box scrolled to the cursor, on a line that was hidden');
  assert.equal(v.current.selection.text(), value.slice(6 * 8 + 7));
  v.input.write(SHIFT.down);
  await until(() => v.ask.cursor === 7 * 8 + 7, 'one back down');
  const expected = value.slice(7 * 8 + 7);
  v.input.write('\x03');
  await until(() => v.copied.length === 1, 'copied on Ctrl-C');
  assert.equal(v.copied[0], expected);
  await until(() => v.current.panels.status.getText().includes(`Copied ${expected.length} characters.`), 'the status line says so');
  assert.equal(v.ask.getValue(), value, 'the text stays');
  assert.ok(!v.current.screen.destroyed, 'Ctrl-C with a highlight does not quit');
});

test('Shift+Up, plain Up and Down scroll the message box only as far as the cursor needs, one key at a time', async t => {
  const v = await view(t), value = numbered(12);
  await typing(v, value);
  assert.equal(v.ask.height - v.ask.iheight, 4, 'the box shows four lines');
  assert.equal(v.ask.childBase, 8, 'and its last four');
  // Row r of the numbered lines ends at r * 8 + 7, where the cursor stays as it goes up and down.
  const step = async (keys, row, base, what) => {
    v.input.write(keys);
    await until(() => v.ask.cursor === row * 8 + 7, what); await pause(30);
    assert.equal(v.ask.childBase, base, `${what}: the view moves only to keep the cursor in it`);
    assert.deepEqual(drawnBox(v).rows, rowsInView(v), `${what}: the box draws that view`);
  };
  for (let row = 10; row >= 0; row--) await step(SHIFT.up, row, Math.min(8, row), `Shift+Up to line ${row + 1}`);
  for (let row = 1; row <= 11; row++) await step(SHIFT.down, row, Math.max(0, row - 3), `Shift+Down to line ${row + 1}`);
  assert.equal(v.current.selection.active, false, 'back where it began, nothing is highlighted');
  for (let row = 10; row >= 0; row--) await step('\x1b[A', row, Math.min(8, row), `Up to line ${row + 1}`);
  for (let row = 1; row <= 11; row++) await step('\x1b[B', row, Math.max(0, row - 3), `Down to line ${row + 1}`);
  assert.equal(v.ask.getValue(), value, 'the text stays');
});

test('with a highlight made by the keys, typing or a paste replaces it, Backspace removes it, and a plain arrow ends it', async t => {
  const v = await view(t);
  await typing(v, 'hello world');
  const text = () => v.current.selection.text();
  v.input.write(SHIFT.left.repeat(5)); await until(() => text() === 'world', 'five characters');
  v.input.write(SHIFT.right.repeat(2)); await until(() => text() === 'rld', 'two back');
  assert.equal(v.ask.cursor, 8);
  v.input.write('X'); await until(() => v.ask.getValue() === 'hello woX', 'typing replaces it');
  assert.equal(v.ask.cursor, 9); assert.equal(v.current.selection.active, false);
  v.input.write(SHIFT.left.repeat(2)); await until(() => text() === 'oX', 'two');
  v.input.write('\x7f'); await until(() => v.ask.getValue() === 'hello w', 'Backspace removes it');
  assert.equal(v.ask.cursor, 7); assert.equal(v.current.selection.active, false);
  v.input.write(SHIFT.left.repeat(3)); await until(() => text() === 'o w', 'three');
  v.input.write('\x1b[200~AB\x1b[201~'); await until(() => v.ask.getValue() === 'hellAB', 'a paste replaces it');
  assert.equal(v.ask.cursor, 6); assert.equal(v.current.selection.active, false);
  v.input.write(SHIFT.left.repeat(2)); await until(() => text() === 'AB', 'two again');
  v.input.write('\x1b[D'); await until(() => !v.current.selection.active, 'Left ends it');
  assert.equal(v.ask.cursor, 4, 'at its start');
  v.input.write(SHIFT.right.repeat(2)); await until(() => text() === 'AB', 'forward');
  v.input.write('\x1b[C'); await until(() => !v.current.selection.active, 'Right ends it');
  assert.equal(v.ask.cursor, 6, 'at its end');
  v.input.write(SHIFT.home); await until(() => text() === 'hellAB', 'Shift+Home');
  assert.equal(v.ask.cursor, 0);
  v.input.write('\x1b[H'); await until(() => !v.current.selection.active, 'Home ends it');
  v.input.write(SHIFT.end); await until(() => text() === 'hellAB', 'Shift+End');
  // A drag starts a new highlight, which Backspace then removes.
  const a = v.cell(0, 1), b = v.cell(0, 3);
  v.press(a.x, a.y); v.drag(b.x, b.y); v.release(b.x, b.y);
  await until(() => v.copied.length === 1, 'copied');
  assert.equal(v.copied[0], 'ell');
  v.input.write('\x7f'); await until(() => v.ask.getValue() === 'hAB', 'the drag highlight removed');
  assert.equal(v.copied.length, 1, 'the keys copy nothing by themselves');
});

test('Ctrl-C copies a highlight in the message box and keeps it: typing then replaces it, Backspace removes it, a plain arrow ends it', async t => {
  const v = await view(t);
  await typing(v, 'line 19\nline 20');
  const text = () => v.current.selection.text();
  v.input.write(SHIFT.left.repeat(2)); await until(() => text() === '20', 'two characters');
  v.input.write('\x03'); await until(() => v.copied.length === 1, 'copied on Ctrl-C');
  assert.equal(v.copied[0], '20');
  await until(() => v.current.panels.status.getText().includes('Copied 2 characters.'), 'the status line says so');
  assert.equal(text(), '20', 'the highlight stays'); assert.equal(v.ask.cursor, 13);
  v.input.write('X'); await until(() => v.ask.getValue() === 'line 19\nline X', 'typing replaces it');
  assert.equal(v.ask.cursor, 14); assert.equal(v.current.selection.active, false);
  // After a copy Shift and an arrow go on from the same end, and Backspace removes the highlight.
  v.input.write(SHIFT.left.repeat(2)); await until(() => text() === ' X', 'two');
  v.input.write('\x03'); await until(() => v.copied.length === 2, 'copied again');
  assert.equal(v.copied[1], ' X'); assert.equal(text(), ' X', 'it stays');
  v.input.write(SHIFT.left.repeat(4)); await until(() => text() === 'line X', 'four more');
  v.input.write('\x03'); await until(() => v.copied.length === 3, 'copied the longer one');
  assert.equal(v.copied[2], 'line X');
  v.input.write('\x7f'); await until(() => v.ask.getValue() === 'line 19\n', 'Backspace removes it');
  assert.equal(v.ask.cursor, 8); assert.equal(v.current.selection.active, false);
  // A highlight made by a drag stays after Ctrl-C too, and typing replaces it.
  const a = v.cell(0, 0), b = v.cell(0, 3);
  v.press(a.x, a.y); v.drag(b.x, b.y); v.release(b.x, b.y);
  await until(() => v.copied.length === 4, 'copied on release');
  v.input.write('\x03'); await until(() => v.copied.length === 5, 'copied on Ctrl-C');
  assert.deepEqual(v.copied.slice(3), ['line', 'line']); assert.equal(text(), 'line', 'it stays');
  v.input.write('Z'); await until(() => v.ask.getValue() === 'Z 19\n', 'typing replaces the drag highlight');
  assert.equal(v.ask.cursor, 1); assert.equal(v.current.selection.active, false);
  // A plain arrow after a copy ends the highlight at its end, and the text stays.
  v.input.write(SHIFT.right.repeat(3)); await until(() => text() === ' 19', 'three');
  v.input.write('\x03'); await until(() => v.copied.length === 6, 'copied');
  v.input.write('\x1b[C'); await until(() => !v.current.selection.active, 'Right ends it');
  assert.equal(v.ask.cursor, 4); assert.equal(v.ask.getValue(), 'Z 19\n');
  assert.ok(!v.current.screen.destroyed, 'Ctrl-C with a highlight never quits');
});

// The message box as it is on the screen: its top border, and the text of each of its rows.
function drawnBox(v) {
  v.current.screen.render();
  const ask = v.ask, pos = ask.lpos, cells = row => v.current.screen.lines[row].map(cell => cell[1]).join('');
  const rows = [];
  for (let y = pos.yi + ask.itop; y < pos.yl - ask.ibottom; y++) rows.push(cells(y).slice(pos.xi + ask.ileft, pos.xl - ask.iright).trimEnd());
  return { border: cells(pos.yi).slice(pos.xi, pos.xl), rows };
}
// The rows of the message the box shows, from the first one in view.
function rowsInView(v) {
  const ask = v.ask, value = ask.getValue(), height = ask.height - ask.iheight;
  return ask.editorView().rows.slice(ask.childBase || 0, (ask.childBase || 0) + height).map(row => value.slice(row.start, row.end));
}

test('after typing over a highlight in a scrolled message box, or Backspace, Delete or a paste on one, its title stays on its top border', async t => {
  const v = await view(t), value = numbered(12), title = () => v.ask._label.getText().trim();
  const holds = (step, expected) => {
    assert.equal(v.ask.getValue(), expected, step);
    const { border, rows } = drawnBox(v);
    assert.match(title(), /^New session → /, step);
    assert.ok(border.includes(title()), `${step}: the title on the border: ${border}`);
    assert.deepEqual(rows, rowsInView(v), `${step}: every row holds the message`);
    assert.ok(rows.every(row => /^line \d\d/.test(row)), `${step}: ${rows.join(' | ')}`);
  };
  for (const [step, key, after] of [['typing', 'X', 'X'], ['Backspace', '\x7f', ''], ['Delete', '\x1b[3~', ''], ['a paste', '\x1b[200~ and more\x1b[201~', ' and more']]) {
    await typing(v, value);
    holds(`${step}: scrolled to its end`, value);
    // Five lines up: the box scrolls up with the cursor, and the highlight runs to the end.
    v.input.write(SHIFT.up.repeat(5));
    await until(() => v.ask.cursor === 6 * 8 + 7 && v.current.selection.text() === value.slice(6 * 8 + 7), `${step}: five lines highlighted`);
    holds(`${step}: highlighted`, value);
    // The text is five lines shorter, so the box shows its first lines again.
    v.input.write(key);
    const expected = value.slice(0, 6 * 8 + 7) + after;
    await until(() => v.ask.getValue() === expected, `${step}: the highlight replaced`);
    assert.equal(v.current.selection.active, false);
    holds(`${step}: replaced`, expected);
  }
});
