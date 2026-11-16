import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import blessed from 'blessed';
import '../lib/terminal-cells.mjs';
import { chartColumn, chartPicture, chartRow, cropRows, png, xtermRgb } from '../lib/chart-picture.mjs';
import { ASK_END, ASK_KITTY, ASK_SIZE, ASK_WHO, DEFAULT_CELL, PICTURE_CELL, attachPictures, inView, itermDraw, kittyDrop, kittyHide, kittyPlace, kittySend, pictureAsker, pictureLayer, pictureSwitch, replySplitter } from '../lib/terminal-pictures.mjs';
import { artifactsView, chartPictures } from '../lib/terminal-artifacts.mjs';
import { readData } from '../lib/artifacts.mjs';
import { visible } from '../lib/terminal-visuals.mjs';
import { columns } from '../lib/width.mjs';
import { pictureTerminal, readPng } from './picture-terminal.mjs';
import { adviceLine, answerLine } from './picture-sample-lines.mjs';

// The owner on 2026-11-15, of the Artifacts tab's text chart: "on the graphic side I think we
// can do better in terminal, is this the best gui we can do?" Where the terminal shows pictures,
// a chart is one. These hold the parts: the picture itself, what ELU asks the terminal, the
// exact bytes it writes to show, move and remove a picture, and that a terminal which shows
// none is sent nothing it could print.

const BLUE = xtermRgb(75), GREEN = xtermRgb(79), GRID = [128, 128, 128, 0.35], TARGET = [158, 158, 158, 1];
const CHART = { cols: 40, rows: 9, low: 0, high: 100, points: 5, ticks: [0, 25, 50, 75, 100], target: 85, series: [{ values: [20, 40, 60, 80, 100], rgb: BLUE, mark: 0 }, { values: [90, null, 30, 30, 10], rgb: GREEN, mark: 1 }] };
const CELL = { width: 10, height: 20 };
const drawn = (chart = CHART, cell = CELL, options = { grid: GRID, target: TARGET }) => chartPicture(chart, cell, options);
const xOf = (index, chart = CHART, cell = CELL) => chartColumn(index, chart) * cell.width, yOf = (value, chart = CHART, cell = CELL) => chartRow(value, chart) * cell.height;
async function until(check, message = 'condition', timeout = 5000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('a terminal colour number is the colour a terminal shows for it', () => {
  assert.deepEqual(xtermRgb(234), [28, 28, 28]);
  assert.deepEqual(xtermRgb(75), [95, 175, 255]);
  assert.deepEqual(xtermRgb(209), [255, 135, 95]);
  assert.deepEqual(xtermRgb(16), [0, 0, 0]);
  assert.deepEqual(xtermRgb(255), [238, 238, 238]);
});

test('the chart is a PNG of the size of its cells, with each series where its values say', () => {
  const picture = drawn(), read = readPng(png(picture));
  assert.deepEqual([read.width, read.height], [400, 180], '40 by 9 cells of 10 by 20 pixels');
  // The top value is the middle of the first row and the bottom one the middle of the last;
  // the first point the middle of the first column and the last the middle of the last.
  assert.deepEqual([yOf(100), yOf(0), xOf(0), xOf(4)], [10, 170, 5, 395]);
  // Every point of a series has its mark, in its colour.
  CHART.series[0].values.forEach((value, at) => assert.deepEqual(read.at(Math.floor(xOf(at)), Math.floor(yOf(value))), [...BLUE, 255], `the first series at point ${at}`));
  for (const at of [0, 2, 3, 4]) assert.deepEqual(read.at(Math.floor(xOf(at)), Math.floor(yOf(CHART.series[1].values[at]))), [...GREEN, 255], `the second series at point ${at}`);
  // Its line runs between two points: half way, the pixel is the series' colour.
  const half = (a, b, values) => read.at(Math.floor((xOf(a) + xOf(b)) / 2), Math.floor((yOf(values[a]) + yOf(values[b])) / 2));
  for (const at of [0, 1, 2, 3]) { const [r, g, b, alpha] = half(at, at + 1, CHART.series[0].values); assert.deepEqual([r, g, b], BLUE, `the first series between ${at} and ${at + 1}`); assert.ok(alpha > 200, `solid there: ${alpha}`); }
  assert.deepEqual(half(2, 3, CHART.series[1].values).slice(0, 3), GREEN);
  // A null is a gap: no line of the second series from its first point to its third, which
  // would pass half way between them over its second.
  assert.deepEqual(read.at(Math.floor(xOf(1)), Math.floor((yOf(90) + yOf(30)) / 2)), [0, 0, 0, 0], 'nothing is drawn in the gap');
  // The grid: one pixel at each value the axis names, light.
  assert.deepEqual(read.at(200, 90), [128, 128, 128, 89], 'the rule at 50');
  assert.deepEqual(read.at(200, 89)[3], 0); assert.deepEqual(read.at(200, 91)[3], 0);
  // The target: a dashed rule of two pixels, six on and four off.
  assert.equal(Math.round(yOf(85)), 34);
  for (const y of [33, 34]) { assert.deepEqual(read.at(2, y), [158, 158, 158, 255], 'a dash'); assert.equal(read.at(8, y)[3], 0, 'between two dashes'); assert.deepEqual(read.at(12, y), [158, 158, 158, 255], 'the next dash'); }
  assert.equal(read.at(2, 32)[3], 0); assert.equal(read.at(2, 35)[3], 0);
  // Nothing else is drawn: the terminal's own colour shows through.
  assert.deepEqual(read.at(399, 179), [0, 0, 0, 0]);
  // A square mark is filled to its corner, where a round one is not.
  const [cx, cy] = [Math.floor(xOf(2)), Math.floor(yOf(30))], corner = read.at(cx + 2, cy + 2), round = read.at(cx + 2, Math.floor(yOf(60)) + 2);
  assert.deepEqual(corner.slice(0, 3), GREEN); assert.ok(corner[3] > 240, `the square's corner is filled: ${corner[3]}`);
  assert.ok(round[3] < 128, `a round mark thins at its corner: ${round[3]}`);
});

test('a line is two to three pixels across and soft at its edge, by the size of a cell', () => {
  const flat = { cols: 20, rows: 5, low: 0, high: 10, points: 2, ticks: [], target: null, series: [{ values: [4.5, 5.5], rgb: BLUE, mark: 0 }] };
  for (const [cell, least, most] of [[{ width: 8, height: 16 }, 1.9, 3], [{ width: 10, height: 20 }, 2, 3.2], [{ width: 18, height: 36 }, 2.9, 4]]) {
    const read = readPng(png(chartPicture(flat, cell))), x = Math.round(read.width / 2);
    const column = Array.from({ length: read.height }, (_, y) => read.at(x, y)[3] / 255), across = column.reduce((sum, value) => sum + value, 0);
    assert.ok(across >= least && across <= most, `${cell.height} pixels a row: the line is ${across.toFixed(2)} pixels across`);
    assert.ok(column.some(value => value > 0 && value < 1), 'its edge is part covered');
  }
});

test('a hollow mark is clear inside, and a background fills what is clear', () => {
  const one = { cols: 10, rows: 5, low: 0, high: 10, points: 3, ticks: [], target: null, series: [{ values: [5, 5, 5], rgb: BLUE, mark: 4 }] };
  const read = readPng(png(chartPicture(one, CELL))), [cx, cy] = [Math.floor(xOf(1, one)), Math.floor(yOf(5, one))];
  assert.equal(read.at(cx, cy)[3], 0, 'its middle is clear, though the line runs through it');
  assert.deepEqual(read.at(cx + 2, cy), [...BLUE, 255], 'its edge is the series');
  const solid = readPng(png(chartPicture(one, CELL, { background: [28, 28, 28] })));
  assert.deepEqual(solid.at(cx, cy), [28, 28, 28, 255]); assert.deepEqual(solid.at(0, 0), [28, 28, 28, 255]); assert.deepEqual(solid.at(cx + 2, cy), [...BLUE, 255]);
});

test('the rows of a picture that show are cut from it whole', () => {
  const picture = drawn(), part = cropRows(picture, 2, 3, 20), whole = readPng(png(picture)), read = readPng(png(part));
  assert.deepEqual([read.width, read.height], [400, 60]);
  for (const [x, y] of [[5, 0], [102, 10], [200, 34], [399, 59]]) assert.deepEqual(read.at(x, y), whole.at(x, y + 40));
});

test('what ELU writes to ask is what the protocols publish', () => {
  // XTVERSION, iTerm2's version report, and the device attributes that end the wait.
  assert.equal(ASK_WHO, '\x1b[>0q\x1b[1337n\x1b[c');
  // Kitty's own example of a query: a picture of one pixel, asked for and not kept.
  assert.equal(ASK_KITTY, '\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\');
  // The size of a cell, then of the window, in pixels.
  assert.equal(ASK_SIZE, '\x1b[16t\x1b[14t');
  assert.equal(ASK_END, '\x1b[c');
});

test('a Kitty picture is sent in pieces of 4096, placed by its number, moved, hidden and removed', () => {
  const data = png(drawn({ ...CHART, cols: 120, rows: 13 }, { width: 18, height: 36 })), sent = kittySend(77, data);
  const pieces = sent.split('\x1b\\'); assert.equal(pieces.pop(), '', 'every piece ends with the string terminator');
  assert.ok(pieces.length > 2, `a chart this size takes more than two pieces: ${pieces.length}`);
  const payloads = pieces.map((piece, at) => {
    const found = /^\x1b_G([^;]*);([A-Za-z0-9+/=]*)$/.exec(piece); assert.ok(found, `piece ${at} is one graphics command`);
    // The first piece says what it is; the others only that more follows, or not.
    assert.equal(found[1], `${at ? '' : 'a=t,f=100,t=d,i=77,'}q=2,m=${at < pieces.length - 1 ? 1 : 0}`);
    assert.ok(found[2].length <= 4096); if (at < pieces.length - 1) assert.equal(found[2].length % 4, 0);
    return found[2];
  });
  assert.ok(Buffer.from(payloads.join(''), 'base64').equals(data), 'the pieces are the PNG');
  assert.equal(kittySend(5, Buffer.from('tiny')), '\x1b_Ga=t,f=100,t=d,i=5,q=2,m=0;dGlueQ==\x1b\\');
  // Shown at row 5, column 10 (counted from 1), over 40 by 9 cells, from the whole picture; the cursor goes back.
  assert.equal(kittyPlace(77, { row: 4, col: 9, cols: 40, rows: 9, crop: { x: 0, y: 0, width: 400, height: 180 } }), '\x1b7\x1b[5;10H\x1b_Ga=p,i=77,p=1,c=40,r=9,x=0,y=0,w=400,h=180,C=1,q=2\x1b\\\x1b8');
  assert.equal(kittyHide(77), '\x1b_Ga=d,d=i,i=77,p=1,q=2\x1b\\');
  assert.equal(kittyDrop(77), '\x1b_Ga=d,d=I,i=77,q=2\x1b\\');
});

test('an iTerm2 picture is one inline file over its cells', () => {
  const data = png(drawn());
  assert.equal(itermDraw(data, { row: 4, col: 9, cols: 40, rows: 9 }), `\x1b7\x1b[5;10H\x1b]1337;File=inline=1;size=${data.length};width=40;height=9;preserveAspectRatio=0:${data.toString('base64')}\x07\x1b8`);
});

// A stand-in terminal of a kind, asked by ELU. The answers go through the same splitter the keys do.
function ask(kind, env = { TERM: 'xterm-256color' }, options = {}) {
  const terminal = pictureTerminal(kind, options), written = [], timers = [], changes = [], typed = [];
  const splitter = replySplitter({ asked: () => asker.asking });
  const hear = reply => { if (!reply) return; const { keys, answers } = splitter.take(reply); typed.push(...keys); for (const found of answers) asker.answer(found); };
  const asker = pictureAsker({ env, write: text => { written.push(text); hear(terminal.read(text)); }, wait: 1500, size: () => ({ columns: options.columns ?? 80, rows: options.rows ?? 24 }), onChange: () => changes.push(asker.protocol), timers: { set: (run, ms) => { timers.push({ run, ms }); return timers.length; }, clear: () => {} }, later: run => run() });
  asker.start();
  return { asker, terminal, written, timers, changes, typed, hear };
}

test('ELU asks the terminal once whether it shows pictures, and TERM alone decides nothing', () => {
  // Kitty, Ghostty and WezTerm name themselves, then answer Kitty's query with OK.
  for (const kind of ['kitty', 'ghostty', 'wezterm']) {
    const { asker, written, typed, changes, terminal } = ask(kind);
    assert.equal(asker.protocol, 'kitty', kind);
    assert.deepEqual(written, [ASK_WHO, `${ASK_KITTY}${ASK_SIZE}${ASK_END}`], `${kind} is asked who it is, then for pictures`);
    assert.deepEqual(asker.cell, { width: 10, height: 20 }, 'a cell is as large as the terminal said');
    assert.deepEqual(typed, [], 'no answer is typed'); assert.deepEqual(changes, ['kitty']); assert.deepEqual(terminal.printed, []);
  }
  // iTerm2 says it is iTerm2, by name or by its own report: its own protocol, and no Kitty query.
  for (const kind of ['iterm', 'iterm-old']) {
    const { asker, written, typed } = ask(kind);
    assert.equal(asker.protocol, 'iterm', kind); assert.deepEqual(written, [ASK_WHO, ASK_SIZE]); assert.deepEqual(typed, []);
    assert.deepEqual(asker.cell, { width: 20, height: 40 }, 'its points are two pixels each');
  }
  // WezTerm with its Kitty graphics off still draws inline pictures.
  assert.equal(ask('wezterm-inline').asker.protocol, 'iterm');
  // A terminal that names itself and has no pictures, and one that says no.
  for (const kind of ['xterm', 'refuses']) { const { asker, written, typed } = ask(kind); assert.equal(asker.protocol, 'off', kind); assert.equal(written.length, 2); assert.deepEqual(typed, []); }
});

test('a terminal that does not name itself, or is tmux, is never sent a picture command', () => {
  // It answers the device attributes alone (as Apple's Terminal): text, and no string it might print.
  const plain = ask('plain');
  assert.equal(plain.asker.protocol, 'off'); assert.deepEqual(plain.written, [ASK_WHO]); assert.deepEqual(plain.terminal.printed, []);
  // tmux answers for itself, whatever TERM says: it would take the query as its pane's title.
  const inside = ask('tmux');
  assert.equal(inside.asker.protocol, 'off'); assert.deepEqual(inside.written, [ASK_WHO]); assert.deepEqual(inside.terminal.printed, []);
  // Where the environment already says tmux or screen, nothing is asked at all.
  for (const env of [{ TERM: 'xterm-256color', TMUX: '/tmp/tmux-1000/default,1,0' }, { TERM: 'screen-256color' }, { TERM: 'tmux-256color' }, { TERM: 'xterm-256color', STY: '1234.pts-0.host' }]) {
    const { asker, written } = ask('kitty', env);
    assert.equal(asker.protocol, 'off', JSON.stringify(env)); assert.deepEqual(written, []);
  }
});

test('no answer within the wait is text for good, and a late answer is not typed', () => {
  const { asker, written, timers, hear, typed, changes } = ask('silent');
  assert.equal(asker.protocol, null, 'not known yet'); assert.equal(asker.asking, true);
  assert.deepEqual(timers.map(timer => timer.ms), [1500]);
  timers[0].run();
  assert.equal(asker.protocol, 'off'); assert.deepEqual(written, [ASK_WHO]); assert.deepEqual(changes, ['off']);
  hear('\x1bP>|kitty(0.36.4)\x1b\\\x1b[?62;c');
  assert.equal(asker.protocol, 'off', 'the wait is over'); assert.deepEqual(written, [ASK_WHO], 'nothing more is asked'); assert.deepEqual(typed, []);
  // An answer that waited with the timer, while the app was busy, is read before the timer decides.
  const queue = [], terminal = pictureTerminal('kitty'), says = [];
  const busy = pictureAsker({ env: { TERM: 'xterm-256color' }, write: text => says.push(terminal.read(text)), timers: { set: run => { queue.push(run); return 1; }, clear: () => {} }, later: run => { for (const reply of says.splice(0)) for (const found of replySplitter().take(reply).answers) busy.answer(found); run(); } });
  busy.start(); queue.shift()();
  assert.equal(busy.asking, true, 'the first answers came with the timer: Kitty is asked'); queue.shift()();
  assert.equal(busy.protocol, 'kitty');
});

test('one switch turns pictures off, and one uses a protocol without asking for it', () => {
  assert.equal(pictureSwitch({ TERM: 'xterm-kitty' }), 'ask', 'TERM is never trusted');
  assert.equal(pictureSwitch({ TERM: 'xterm-256color', ELU_NO_PICTURES: '1' }), 'off');
  assert.equal(pictureSwitch({ TERM: 'xterm-256color', ELU_NO_PICTURES: '0' }), 'ask');
  assert.equal(pictureSwitch({ TERM: 'xterm-256color', ELU_NO_PICTURES: '' }), 'ask');
  assert.equal(pictureSwitch({ TERM: 'xterm-256color', ELU_PICTURES: 'kitty' }), 'kitty');
  assert.equal(pictureSwitch({ TERM: 'xterm-256color', ELU_PICTURES: 'iTerm' }), 'iterm');
  assert.equal(pictureSwitch({ TERM: 'xterm-256color', ELU_PICTURES: 'sixel' }), 'ask', 'only the two it knows');
  assert.equal(pictureSwitch({ TERM: 'xterm-256color', ELU_PICTURES: 'kitty', ELU_NO_PICTURES: '1' }), 'off', 'off wins');
  const off = ask('kitty', { TERM: 'xterm-256color', ELU_NO_PICTURES: '1' });
  assert.equal(off.asker.protocol, 'off'); assert.deepEqual(off.written, [], 'nothing is asked');
  // A terminal that does not say who it is, told to draw Kitty's pictures: it is not asked for
  // them, only who it is and the size of a cell.
  const forced = ask('plain', { TERM: 'xterm-256color', ELU_PICTURES: 'kitty' });
  assert.equal(forced.asker.protocol, 'kitty'); assert.deepEqual(forced.written, [ASK_WHO, ASK_SIZE]); assert.deepEqual(forced.changes, ['kitty']);
  assert.deepEqual(forced.asker.cell, DEFAULT_CELL, 'and with no answer it is 12 by 24');
  assert.deepEqual(forced.typed, []); assert.deepEqual(forced.terminal.printed, [], 'nothing it would print is written before a picture shows');
  // One that names itself and would say no is not asked either.
  for (const kind of ['xterm', 'refuses', 'kitty']) { const told = ask(kind, { TERM: 'xterm-256color', ELU_PICTURES: 'iterm' }); assert.equal(told.asker.protocol, 'iterm', kind); assert.deepEqual(told.written, [ASK_WHO, ASK_SIZE], kind); }
  // One that answers nothing gets the protocol once the wait is over.
  const silent = ask('silent', { TERM: 'xterm-256color', ELU_PICTURES: 'kitty' });
  assert.equal(silent.asker.protocol, null, 'not before'); assert.deepEqual(silent.written, [ASK_WHO]);
  silent.timers[0].run();
  assert.equal(silent.asker.protocol, 'kitty'); assert.deepEqual(silent.written, [ASK_WHO, ASK_SIZE]); assert.deepEqual(silent.changes, ['kitty']);
});

// tmux and screen show no picture, and tmux takes Kitty's commands for the title of its pane.
// Found by a check on 2026-11-16: told to draw pictures there, ELU wrote them all the same.
test('told which protocol to use, ELU still writes nothing of a picture inside tmux or screen', () => {
  // Where the environment says tmux or screen, nothing is asked at all.
  for (const env of [{ TERM: 'xterm-256color', TMUX: '/tmp/tmux-1000/default,1,0' }, { TERM: 'screen-256color' }, { TERM: 'tmux-256color' }, { TERM: 'xterm-256color', STY: '1234.pts-0.host' }]) for (const told of ['kitty', 'iterm']) {
    assert.equal(pictureSwitch({ ...env, ELU_PICTURES: told }), 'off', `${told} ${JSON.stringify(env)}`);
    const { asker, written } = ask('kitty', { ...env, ELU_PICTURES: told });
    assert.equal(asker.protocol, 'off'); assert.deepEqual(written, []);
  }
  // Over SSH from inside tmux the environment says nothing of it: tmux says who it is.
  for (const told of ['kitty', 'iterm']) {
    const inside = ask('tmux', { TERM: 'xterm-256color', ELU_PICTURES: told });
    assert.equal(inside.asker.protocol, 'off', told); assert.deepEqual(inside.changes, ['off']);
    assert.deepEqual(inside.written, [ASK_WHO], 'it was asked who it is, and nothing more'); assert.deepEqual(inside.terminal.printed, []); assert.deepEqual(inside.typed, []);
  }
});

test('on a screen told to draw Kitty pictures, tmux is written no picture command and the text shows', { timeout: 20000 }, async t => {
  const v = screenOn(t, 'tmux', { env: { TERM: 'xterm-256color', ELU_PICTURES: 'kitty' } });
  await until(() => v.pictures.protocol === 'off', 'tmux to say who it is');
  assert.equal(v.pictures.cell, null, 'text'); assert.equal(v.pictures.name, 'tmux 3.4');
  await v.show(6); await v.render();
  assert.doesNotMatch(v.state.raw, /\x1b_G|\x1b\]1337|\x1b\[1[46]t/, 'no picture command, and no question tmux does not answer');
  assert.deepEqual(v.terminal.printed, []); assert.equal(v.draws, 0);
});

// The sample chart (test/picture-sample.mjs) said, after q, how to draw pictures without asking
// wherever the terminal's answer was no: in a terminal that had just said it is tmux too.
test('the sample chart names the switch that draws pictures only where the terminal did not say who it is', () => {
  const HOW = /ELU_PICTURES=kitty node test\/picture-sample\.mjs$/, env = { TERM: 'xterm-256color' };
  const said = kind => { const { asker, timers } = ask(kind, env); if (asker.protocol === null) timers[0].run(); return { protocol: asker.protocol, name: asker.name, cell: asker.cell }; };
  // tmux said who it is: no picture shows there whatever ELU is told.
  assert.equal(answerLine(said('tmux'), 'ask'), 'This terminal (tmux 3.4) said it shows no pictures: the text chart.');
  assert.equal(adviceLine(said('tmux'), 'ask'), '');
  // Nor in one that names itself and shows none.
  for (const kind of ['xterm', 'refuses']) assert.equal(adviceLine(said(kind), 'ask'), '', kind);
  // One that did not say who it is, or answered nothing, may show them all the same.
  for (const kind of ['plain', 'silent']) {
    assert.equal(answerLine(said(kind), 'ask'), 'This terminal did not say who it is: the text chart.', kind);
    assert.match(adviceLine(said(kind), 'ask'), HOW, kind);
  }
  // Pictures show, or are switched off: nothing to try.
  assert.equal(adviceLine(said('kitty'), 'ask'), ''); assert.equal(adviceLine({ protocol: 'off', name: '', cell: null }, 'off'), '');
  assert.equal(answerLine({ protocol: 'off', name: '', cell: null }, 'off', true), 'Pictures are off here (inside tmux): the text chart.');
  assert.equal(answerLine(said('kitty'), 'ask'), 'This terminal (kitty(0.36.4)) shows pictures by the Kitty graphics protocol. A cell is 10x20 pixels.');
});

test('a cell is as large as the terminal says, from the window when it gives no cell, and never huge', () => {
  assert.deepEqual(ask('kitty', undefined, { cell: { width: 18, height: 36 } }).asker.cell, { width: 18, height: 36 });
  assert.deepEqual(ask('kitty', undefined, { cell: { width: 30, height: 60 } }).asker.cell, { width: 24, height: 48 }, 'a row is at most 48 pixels');
  const { asker } = ask('silent', { TERM: 'xterm-256color', ELU_PICTURES: 'kitty' }, { columns: 100, rows: 40 });
  asker.answer({ kind: 'window', height: 880, width: 1100 });
  assert.deepEqual(asker.cell, { width: 11, height: 22 }, 'the window over its columns and rows');
  asker.answer({ kind: 'cell', height: 0, width: 0 });
  assert.deepEqual(asker.cell, { width: 11, height: 22 }, 'a size of nothing is no answer');
  asker.answer({ kind: 'cell', height: 30, width: 14 });
  assert.deepEqual(asker.cell, { width: 14, height: 30 });
});

test('no picture is drawn at a size that is about to change: ELU waits for the size it asked for, as long as it waits for any answer', () => {
  // The size came with the rest: nothing to wait for.
  for (const kind of ['kitty', 'iterm']) assert.equal(ask(kind).asker.sized, true, kind);
  // iTerm2 is asked for it after it said who it is. No answer: the size it is given, once the wait is over.
  const quiet = ask('iterm-no-size');
  assert.equal(quiet.asker.protocol, 'iterm'); assert.equal(quiet.asker.sized, false, 'asked, not said yet'); assert.deepEqual(quiet.changes, ['iterm']);
  assert.deepEqual(quiet.timers.map(timer => timer.ms), [1500, 1500]);
  quiet.timers[1].run();
  assert.equal(quiet.asker.sized, true); assert.deepEqual(quiet.asker.cell, DEFAULT_CELL); assert.deepEqual(quiet.changes, ['iterm', 'iterm'], 'the screen is told to draw');
  // The answer, when it comes: the screen is told once.
  const late = ask('iterm-no-size');
  late.hear('\x1b[6;18;9t\x1b[4;432;720t');
  assert.equal(late.asker.sized, true); assert.deepEqual(late.asker.cell, { width: 18, height: 36 }); assert.deepEqual(late.changes, ['iterm', 'iterm']);
  late.timers[1].run(); assert.deepEqual(late.changes, ['iterm', 'iterm'], 'the wait that ended after it says nothing more');
  // A new window size: the size of a cell is asked again, and waited for again.
  const { asker, written, terminal, changes } = ask('kitty');
  terminal.resize(100, 30, { width: 12, height: 24 }); asker.resized();
  assert.deepEqual(written.at(-1), ASK_SIZE); assert.equal(asker.sized, true, 'it answered'); assert.deepEqual(asker.cell, { width: 12, height: 24 }); assert.deepEqual(changes, ['kitty', 'kitty']);
  // Told which protocol to use, ELU waits for no size the first time.
  const told = ask('plain', { TERM: 'xterm-256color', ELU_PICTURES: 'iterm' });
  assert.equal(told.asker.protocol, 'iterm'); assert.equal(told.asker.sized, true);
});

// The rows of the Artifacts tab (lib/terminal-artifacts.mjs) where the terminal shows pictures.
const HISTORY = { kind: 'chart', label: 'Over time', unit: '%', target: 85, x: ['run 1', 'run 2', 'run 3', 'run 4', 'run 5'], series: [{ label: 'Accuracy', values: [20, 40, 60, 80, 100] }, { label: 'Success rate', values: [90, null, 30, 30, 10] }] };
const ITEMS = [
  { title: 'Eval history', every: null, updates: [{ at: '2026-11-15T10:00:00.000Z', data: readData(JSON.stringify({ blocks: [{ kind: 'score', label: 'Accuracy', value: 84, unit: '%', target: 85 }, HISTORY, { kind: 'note', text: 'Last run Nov 5.' }] })) }] },
  { title: 'Latency', every: null, updates: [{ at: '2026-11-15T10:00:00.000Z', data: readData(JSON.stringify({ blocks: [{ kind: 'chart', unit: 's', x: ['a', 'b', 'c'], series: [{ label: 'Median', values: [1.2, 0.9, 1.1] }] }] })) }] },
];
const shown = rows => rows.map(row => visible(row));

test('where the terminal shows pictures, a chart\'s plot is left blank for one and everything around it stays text', () => {
  for (const width of [70, 128]) {
    const text = artifactsView(ITEMS, { width, colour: false }), rows = artifactsView(ITEMS, { width, colour: false, picture: true }), plain = shown(rows), tall = width >= 100 ? 13 : 9;
    assert.equal(text.pictures, undefined, 'the text chart says nothing of pictures'); assert.ok(shown(text).some(row => /[⠁-⣿]/.test(row)));
    assert.equal(rows.length, text.length, 'as many rows either way'); assert.ok(plain.every(row => columns(row) <= width), `every row fits ${width} columns`);
    assert.ok(!plain.some(row => /[⠁-⣿]/.test(row)), 'no text plot');
    assert.equal(rows.pictures.length, 2, 'a picture for each chart, of each artifact');
    // Each picture's place is the blank cells of its plot, and no other cell is blank for one.
    const blank = plain.map(() => []);
    for (const found of rows.pictures) {
      assert.deepEqual([found.rows, found.cols], [tall, width - found.col]);
      for (let row = found.row; row < found.row + found.rows; row++) { assert.equal(plain[row].slice(found.col), PICTURE_CELL.repeat(found.cols), `row ${row}`); blank[row] = true; }
      assert.match(plain[found.row + found.rows], /^ +└─+$/, 'the axis under it');
    }
    plain.forEach((row, at) => { if (blank[at] !== true) assert.ok(!row.includes(PICTURE_CELL), `row ${at} has none`); });
    // The first chart: under its label, its values beside the rows the picture puts them on.
    const [first, second] = rows.pictures, at = value => first.row + Math.floor(chartRow(value, { low: 0, high: 100, rows: tall }));
    assert.equal(plain[first.row - 1], 'Over time'); assert.ok(second.row > first.row + tall);
    for (const value of [100, 75, 50, 25, 0]) assert.equal(plain[at(value)].slice(0, first.col), `${`${value}%`.padStart(first.col - 2)} ┤`, `${value}%`);
    assert.equal(at(100), first.row); assert.equal(at(0), first.row + tall - 1);
    // Its x labels under their points, and its legend with the marks the picture draws.
    const labels = plain[first.row + tall + 1];
    HISTORY.x.forEach((label, index) => { const middle = first.col + Math.floor(chartColumn(index, { points: 5, cols: first.cols })), from = labels.indexOf(label); assert.ok(from >= first.col && from <= middle && middle < from + label.length + 1 || index === 0 || index === 4, `${label} under its point`); });
    assert.equal(labels.indexOf('run 1'), first.col, 'the first at the left edge'); assert.ok(labels.endsWith('run 5'), 'the last at the right edge');
    assert.match(plain[first.row + tall + 2], /^● Accuracy 100% ▲ 80 {3}■ Success rate 10% ▼ 80 {3}╌ target ≥ 85%$/);
    // What the picture shows: the plot's cells, its axis, and each series with its mark and its colour's name.
    assert.deepEqual(first.chart, { cols: first.cols, rows: tall, low: 0, high: 100, points: 5, ticks: [0, 25, 50, 75, 100], target: 85, series: [{ values: [20, 40, 60, 80, 100], hue: 'blue', mark: 0 }, { values: [90, null, 30, 30, 10], hue: 'green', mark: 1 }] });
    assert.equal(second.chart.target, null);
  }
});

test('a chart\'s picture is named by what it shows, the size of a cell and its colours, and drawn in the colours of its text', () => {
  const rows = artifactsView(ITEMS, { width: 70, picture: true }), cell = { width: 10, height: 20 };
  const [first, second] = chartPictures(rows, { cell, top: 4 });
  assert.deepEqual([first.row, first.col, first.cols, first.rows], [rows.pictures[0].row - 4, rows.pictures[0].col, rows.pictures[0].cols, 9], 'its place, from the first row in view');
  assert.notEqual(first.key, second.key);
  // The same rows again: the same name, so it is not sent again.
  const key = (view, options) => chartPictures(view, { cell, ...options })[0].key;
  assert.equal(key(artifactsView(ITEMS, { width: 70, picture: true })), first.key); assert.equal(key(rows, { top: 9 }), first.key, 'scrolling changes nothing of it');
  // Another size of a cell, another width, other colours, or one other value: another picture.
  assert.notEqual(key(rows, { cell: { width: 12, height: 24 } }), first.key); assert.notEqual(key(artifactsView(ITEMS, { width: 71, picture: true })), first.key);
  assert.notEqual(key(rows, { colour: false }), first.key); assert.notEqual(key(rows, { solid: true }), first.key);
  const other = structuredClone(ITEMS); other[0].updates[0].data.blocks[1].series[0].values[2] = 61;
  assert.notEqual(key(artifactsView(other, { width: 70, picture: true })), first.key);
  // Drawn: the first series in the app's blue where its values are, on nothing; on the pane's own colour for iTerm2.
  const chart = rows.pictures[0].chart, x = Math.floor(chartColumn(2, chart) * 10), y = Math.floor(chartRow(60, chart) * 20);
  const clear = first.draw(); assert.deepEqual([clear.width, clear.height], [first.cols * 10, 180]);
  const read = readPng(png(clear)); assert.deepEqual(read.at(x, y), [...xtermRgb(75), 255]); assert.equal(read.at(read.width - 1, 0)[3], 0);
  const solid = readPng(png(chartPictures(rows, { cell, solid: true })[0].draw())); assert.deepEqual(solid.at(x, y), [...xtermRgb(75), 255]); assert.deepEqual(solid.at(solid.width - 1, 0), [...xtermRgb(234), 255]);
  // Without colour: a grey that reads on a dark and on a light terminal, and no background of ELU's.
  const grey = readPng(png(chartPictures(rows, { cell, colour: false, solid: true })[0].draw())); assert.deepEqual(grey.at(x, y), [128, 128, 128, 255]); assert.equal(grey.at(grey.width - 1, 0)[3], 0);
  assert.deepEqual(chartPictures(artifactsView(ITEMS, { width: 70 }), { cell }), [], 'the text chart has none');
});

// A key names what a picture shows, so two charts of the same numbers would share one, and the
// terminal would show it at one place only. Each chart of the tab has its own.
test('two charts that show the same are two pictures, each over its own plot', () => {
  const twice = [{ title: 'Eval history', every: null, updates: [{ at: '2026-11-15T10:00:00.000Z', data: readData(JSON.stringify({ blocks: [HISTORY, HISTORY] })) }] }];
  const rows = artifactsView(twice, { width: 70, picture: true }), cell = { width: 10, height: 20 }, [first, second] = chartPictures(rows, { cell });
  assert.deepEqual(rows.pictures[0].chart, rows.pictures[1].chart, 'the same chart twice');
  assert.notEqual(first.key, second.key, 'each has its own name');
  assert.equal(chartPictures(rows, { cell, top: 5 })[1].key, second.key, 'which scrolling does not change');
  // The terminal shows both, frame after frame.
  const terminal = pictureTerminal('kitty', { columns: 80, rows: 40 }), layer = pictureLayer({ write: text => terminal.read(text), protocol: 'kitty', firstId: 500 });
  const places = [first, second].map(found => ({ key: found.key, draw: found.draw, row: 2 + found.row, col: 3 + found.col, cols: found.cols, rows: found.rows, skip: 0, of: found.rows }));
  layer.sync(places); layer.sync(places);
  assert.deepEqual([...terminal.placed.values()].map(place => place.row).sort((a, b) => a - b), places.map(place => place.row));
  assert.deepEqual(terminal.printed, []);
});

test('the answers are taken out of the input, and every key stays as typed', () => {
  const all = '\x1bP>|kitty(0.36.4)\x1b\\\x1b[ITERM2 3.5.0-nightlyn\x1b[?62;c\x1b_Gi=31;OK\x1b\\\x1b[6;20;10t\x1b[4;480;800t\x1b[?62;c';
  const expected = [{ kind: 'version', text: 'kitty(0.36.4)' }, { kind: 'iterm', text: '3.5.0-nightly' }, { kind: 'attributes', text: '62;' }, { kind: 'kitty', text: 'i=31;OK' }, { kind: 'cell', height: 20, width: 10 }, { kind: 'window', height: 480, width: 800 }, { kind: 'attributes', text: '62;' }];
  const whole = replySplitter().take(`a${all}é`);
  assert.deepEqual(whole.answers, expected); assert.equal(Buffer.concat(whole.keys).toString(), 'aé');
  // Cut anywhere between two reads, nothing is lost and nothing is typed.
  for (let cut = 1; cut < all.length; cut++) {
    const splitter = replySplitter({ asked: () => true }), first = splitter.take(Buffer.from(all.slice(0, cut), 'latin1')), second = splitter.take(Buffer.from(all.slice(cut), 'latin1')), rest = splitter.rest();
    assert.deepEqual([...first.answers, ...second.answers, ...rest.answers], expected, `cut at ${cut}`);
    assert.equal(Buffer.concat([...first.keys, ...second.keys, ...rest.keys]).length, 0, `cut at ${cut}: no key`);
  }
  // Keys pass at once: Esc alone, an arrow, Ctrl with Page Down, a letter with an accent, a mouse report.
  for (const key of ['\x1b', '\x1b[A', '\x1b[6;5~', 'é', '\x1b[<0;10;5M', '\x1bOP', 'q']) {
    const splitter = replySplitter(), taken = splitter.take(Buffer.from(key));
    assert.equal(Buffer.concat(taken.keys).toString(), key, JSON.stringify(key)); assert.equal(splitter.waiting, false); assert.deepEqual(taken.answers, []);
  }
  // Alt with [ may be the start of an answer only while one is asked for: then it waits, and is typed when none came.
  assert.equal(Buffer.concat(replySplitter().take('\x1b[').keys).toString(), '\x1b[');
  const asked = replySplitter({ asked: () => true });
  assert.deepEqual(asked.take('\x1b[').keys, []); assert.equal(asked.waiting, true);
  assert.equal(Buffer.concat(asked.rest().keys).toString(), '\x1b[');
  // A key cut by the end of a read is put together again.
  const cut = replySplitter(); assert.deepEqual(cut.take('\x1b[6;5').keys, []);
  assert.equal(Buffer.concat(cut.take('~').keys).toString(), '\x1b[6;5~');
  // An answer that never ends is dropped, not typed.
  const open = replySplitter(); assert.deepEqual(open.take('x\x1b_Gi=31;OK').keys.map(String), ['x']);
  assert.deepEqual(open.rest(), { keys: [], answers: [] });
});

test('the part of a picture in view', () => {
  assert.deepEqual(inView(2, 9, 20), { first: 2, rows: 9, skip: 0 });
  assert.deepEqual(inView(-3, 9, 20), { first: 0, rows: 6, skip: 3 }, 'scrolled past the top');
  assert.deepEqual(inView(15, 9, 20), { first: 15, rows: 5, skip: 0 }, 'cut by the bottom');
  assert.equal(inView(-9, 9, 20), null); assert.equal(inView(20, 9, 20), null);
});

test('a Kitty picture is sent once for its content and size: scrolling, hiding and showing it again send only its place', () => {
  const out = [], terminal = pictureTerminal('kitty'), layer = pictureLayer({ write: text => { out.push(text); terminal.read(text); }, protocol: 'kitty', firstId: 500 });
  let draws = 0; const picture = drawn(), data = png(picture);
  const place = (more = {}) => ({ key: 'a', draw: () => { draws++; return picture; }, row: 5, col: 8, cols: 40, rows: 9, skip: 0, of: 9, ...more });
  const whole = { x: 0, y: 0, width: 400, height: 180 };
  layer.sync([place()]);
  assert.deepEqual(out, [kittySend(500, data) + kittyPlace(500, { row: 5, col: 8, cols: 40, rows: 9, crop: whole })]);
  assert.ok(terminal.images.get(500).equals(data)); assert.deepEqual([...terminal.placed.keys()], ['500:1']);
  assert.deepEqual(terminal.placed.get('500:1'), { id: 500, row: 5, col: 8, cols: 40, rows: 9, ...whole, cursorStays: true });
  // The same frame again: nothing.
  layer.sync([place()]); layer.sync([place()]);
  assert.equal(out.length, 1);
  // Scrolled two rows past the top: the same picture, from its third row on.
  layer.sync([place({ row: 3, rows: 7, skip: 2 })]);
  assert.equal(out[1], kittyPlace(500, { row: 3, col: 8, cols: 40, rows: 7, crop: { x: 0, y: 40, width: 400, height: 140 } }));
  assert.equal(terminal.placed.size, 1, 'the second place moved the first'); assert.deepEqual([terminal.placed.get('500:1').row, terminal.placed.get('500:1').y], [3, 40]);
  // Hidden: its place goes, and the terminal keeps it for the next time.
  layer.sync([]);
  assert.equal(out[2], kittyHide(500)); assert.equal(terminal.placed.size, 0); assert.equal(terminal.images.size, 1); assert.equal(layer.count, 0);
  layer.sync([]); assert.equal(out.length, 3, 'nothing is written while nothing shows');
  layer.sync([place()]);
  assert.equal(out[3], kittyPlace(500, { row: 5, col: 8, cols: 40, rows: 9, crop: whole }), 'shown again without being sent again');
  assert.deepEqual([draws, terminal.sent.length], [1, 1]);
  // Other content, or another size, is another picture.
  layer.sync([place({ key: 'b' })]);
  assert.equal(out[4], kittyHide(500) + kittySend(501, data) + kittyPlace(501, { row: 5, col: 8, cols: 40, rows: 9, crop: whole }));
  assert.deepEqual([...terminal.placed.keys()], ['501:1']);
  // The screen is about to be cleared: the terminal is told to keep none, and what still shows
  // is sent again.
  assert.equal(layer.forget(), kittyDrop(500) + kittyDrop(501)); assert.equal(terminal.images.size, 0);
  terminal.read('\x1b[2J'); layer.sync([place({ key: 'b' })]);
  assert.equal(out[6], kittySend(502, data) + kittyPlace(502, { row: 5, col: 8, cols: 40, rows: 9, crop: whole }));
  // ELU leaves: every picture it sent is removed, and the terminal holds none.
  assert.equal(layer.forget(), kittyDrop(502)); assert.equal(terminal.images.size, 0); assert.equal(terminal.placed.size, 0);
  assert.equal(layer.forget(), '', 'nothing more to remove');
  assert.deepEqual(terminal.printed, [], 'the terminal knew every picture it was told to show');
});

test('the terminal keeps the few pictures shown last, and the rest are removed from it', () => {
  const terminal = pictureTerminal('kitty'), out = [], layer = pictureLayer({ write: text => { out.push(text); terminal.read(text); }, protocol: 'kitty', firstId: 10, kept: 2 });
  const place = key => ({ key, draw: () => drawn(), row: 1, col: 1, cols: 40, rows: 9, skip: 0, of: 9 });
  layer.sync([place('a')]); layer.sync([place('b')]); assert.deepEqual([...terminal.images.keys()], [10, 11]);
  layer.sync([place('c')]);
  assert.deepEqual([...terminal.images.keys()], [11, 12], 'the oldest went'); assert.ok(out.at(-1).endsWith(kittyDrop(10)));
  assert.deepEqual(layer.ids, [11, 12]);
});

test('an iTerm2 picture is drawn again when it moves, cut to what shows, and its old cells are written first', () => {
  const out = [], layer = pictureLayer({ write: text => out.push(text), protocol: 'iterm' }), picture = drawn();
  const place = (more = {}) => ({ key: 'a', draw: () => picture, row: 5, col: 8, cols: 40, rows: 9, skip: 0, of: 9, ...more });
  assert.deepEqual(layer.settle([place()]), []);
  layer.sync([place()]);
  assert.deepEqual(out, [itermDraw(png(picture), { row: 5, col: 8, cols: 40, rows: 9 })]);
  // The same frame, and the screen wrote none of its cells: nothing.
  assert.deepEqual(layer.settle([place()], () => false), []); layer.sync([place()]); assert.equal(out.length, 1);
  // The screen is about to write some of its cells: it is drawn again after.
  assert.deepEqual(layer.settle([place()], () => true), [{ row: 5, col: 8, cols: 40, rows: 9 }]); layer.sync([place()]);
  assert.equal(out.length, 2); assert.equal(out[1], out[0]);
  // Scrolled: the cells it was in are written again, then the rows that show are drawn.
  const moved = place({ row: 3, rows: 7, skip: 2 });
  assert.deepEqual(layer.settle([moved]), [{ row: 5, col: 8, cols: 40, rows: 9 }]); layer.sync([moved]);
  assert.equal(out[2], itermDraw(png(cropRows(picture, 2, 7, 20)), { row: 3, col: 8, cols: 40, rows: 7 }));
  // Hidden: its cells are written again, and nothing is sent.
  assert.deepEqual(layer.settle([]), [{ row: 3, col: 8, cols: 40, rows: 7 }]); layer.sync([]);
  assert.equal(out.length, 3); assert.equal(layer.forget(), '');
});

// A blessed screen on a stand-in terminal of a kind, with pictures attached as the app attaches them.
function screenOn(t, kind, { columns = 60, rows = 20, env = { TERM: 'xterm-256color' }, cell } = {}) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = columns; output.rows = rows;
  const terminal = pictureTerminal(kind, { columns, rows, cell }), state = { raw: '', changes: 0, keys: [] };
  output.on('data', data => { state.raw += data; const reply = terminal.read(data.toString()); if (reply) setImmediate(() => { if (!input.destroyed) input.write(reply); }); });
  const screen = blessed.screen({ input, output, terminal: 'xterm-256color', smartCSR: true, fullUnicode: true, forceUnicode: true, warnings: false });
  screen.on('keypress', (ch, key) => state.keys.push(key.full));
  const pictures = attachPictures(screen, { env, firstId: 500, settleMs: 30, wait: 300, onChange: () => { state.changes++; } });
  t.after(() => { if (!screen.destroyed) screen.destroy(); input.destroy(); output.destroy(); });
  // A pane of 12 rows of text; rows 10 to 15 of the text hold a picture of 20 by 6 cells, three columns in.
  const box = blessed.box({ parent: screen, top: 2, left: 4, width: 44, height: 14, border: 'line', tags: false, wrap: false });
  const text = Array.from({ length: 30 }, (_, row) => row >= 10 && row < 16 ? `ab ${PICTURE_CELL.repeat(20)} z` : `row ${row}`);
  let draws = 0;
  const chart = { ...CHART, cols: 20, rows: 6 };
  // The screen draws, and what it wrote has reached the terminal.
  const render = async () => { screen.render(); await new Promise(resolve => setImmediate(resolve)); };
  const show = from => {
    box.setContent(text.slice(from, from + 12).join('\n'));
    pictures.show(pictures.cell ? { box, left: 1, top: 1, high: 12, pictures: [{ key: `chart ${pictures.cell.width}x${pictures.cell.height}`, draw: () => { draws++; return drawn(chart, pictures.cell); }, row: 10 - from, col: 3, cols: 20, rows: 6 }] } : null);
    return render();
  };
  return { screen, input, output, terminal, pictures, state, box, show, render, get draws() { return draws; } };
}

test('on a screen, a picture scrolls and is cut with the text, goes when a dialog covers it, and is gone after quitting', { timeout: 20000 }, async t => {
  const v = screenOn(t, 'kitty'), { terminal, pictures, screen } = v;
  assert.equal(pictures.cell, null, 'text until the terminal has answered');
  await until(() => pictures.cell, 'the terminal to answer');
  assert.deepEqual(pictures.cell, { width: 10, height: 20 }); assert.equal(pictures.protocol, 'kitty'); assert.equal(pictures.name, 'kitty(0.36.4)'); assert.equal(v.state.changes, 1);
  await v.show(6);
  // Its text rows 10 to 15 are the pane's rows 4 to 9: the screen's rows 7 to 12, from column 8.
  assert.deepEqual([...terminal.placed.values()], [{ id: 500, row: 7, col: 8, cols: 20, rows: 6, x: 0, y: 0, width: 200, height: 120, cursorStays: true }]);
  const read = readPng(terminal.images.get(500)); assert.deepEqual([read.width, read.height], [200, 120]);
  assert.equal(terminal.text.line(7).slice(8, 28), PICTURE_CELL.repeat(20), 'blank cells under it');
  // Scrolled by two rows, then until two rows of it are past the top.
  await v.show(8); assert.deepEqual([terminal.placed.get('500:1').row, terminal.placed.get('500:1').rows, terminal.placed.get('500:1').y], [5, 6, 0]);
  await v.show(12); assert.deepEqual([...terminal.placed.values()], [{ id: 500, row: 3, col: 8, cols: 20, rows: 4, x: 0, y: 40, width: 200, height: 80, cursorStays: true }]);
  // Scrolled out of view: it is not placed, and nothing of it is left behind.
  await v.show(20); assert.equal(terminal.placed.size, 0);
  await v.show(0); assert.deepEqual([terminal.placed.get('500:1').row, terminal.placed.get('500:1').rows], [13, 2], 'its first two rows at the bottom');
  await v.show(6);
  // A dialog over a corner of it: it goes, and comes back when the dialog closes.
  const dialog = blessed.box({ parent: screen, top: 10, left: 20, width: 16, height: 5, border: 'line', content: 'Sure?' });
  await v.render(); assert.equal(terminal.placed.size, 0, 'no picture shows through a dialog');
  dialog.destroy(); await v.render(); assert.equal(terminal.placed.get('500:1').row, 7);
  // The tab is hidden: nothing shows, and nothing is sent while it is.
  const before = v.state.raw.length; pictures.show(null); v.box.hide(); await v.render();
  assert.equal(terminal.placed.size, 0); await v.render(); await v.render();
  assert.doesNotMatch(v.state.raw.slice(before).replace(kittyHide(500), ''), /\x1b_G/, 'only its removal was written');
  v.box.show(); await v.show(6);
  assert.deepEqual([v.draws, terminal.sent.length], [1, 1], 'through all of it the picture was drawn and sent once');
  // Keys still arrive, and no answer was typed.
  v.input.write('x'); await until(() => v.state.keys.length, 'the key');
  assert.deepEqual(v.state.keys, ['x']);
  // Quitting: the picture is removed before the terminal's first screen comes back.
  screen.destroy();
  assert.deepEqual(terminal.left, [{ images: 0, placed: 0 }]);
  assert.ok(v.state.raw.indexOf(kittyDrop(500)) > 0 && v.state.raw.indexOf(kittyDrop(500)) < v.state.raw.lastIndexOf('\x1b[?1049l'));
  assert.deepEqual(terminal.printed, []);
});

test('on a screen, a new window size sends the picture again once the size has settled', { timeout: 20000 }, async t => {
  const v = screenOn(t, 'kitty'), { terminal, pictures } = v;
  await until(() => pictures.cell, 'the terminal to answer'); await v.show(6);
  assert.equal(terminal.sent.length, 1);
  // The window grows, and its cells are larger: the terminal clears, and ELU asks the size again.
  v.output.columns = 70; v.output.rows = 22; terminal.resize(70, 22, { width: 12, height: 24 }); v.output.emit('resize');
  assert.equal(pictures.cell, null, 'text while the size settles'); await v.show(6);
  assert.equal(terminal.placed.size, 0); assert.equal(terminal.sent.length, 1, 'nothing is sent meanwhile');
  await until(() => pictures.cell?.width === 12, 'the new size of a cell');
  await v.show(6);
  assert.equal(terminal.sent.length, 2); assert.equal(terminal.placed.size, 1);
  const read = readPng(terminal.images.get(terminal.sent[1])); assert.deepEqual([read.width, read.height], [240, 144], 'drawn for the new cells');
});

test('on a screen in iTerm2, the cells of a picture that moved or was covered are written again', { timeout: 20000 }, async t => {
  const v = screenOn(t, 'iterm'), { terminal, pictures, screen } = v;
  await until(() => pictures.cell, 'the terminal to answer');
  assert.equal(pictures.protocol, 'iterm'); assert.deepEqual(pictures.cell, { width: 20, height: 40 });
  await v.show(6);
  assert.equal(terminal.drawn.length, 1); assert.deepEqual([terminal.drawn[0].row, terminal.drawn[0].col, terminal.drawn[0].cols, terminal.drawn[0].rows], [7, 8, 20, 6]);
  assert.equal(terminal.drawn[0].size, terminal.drawn[0].data.length); assert.equal(terminal.inlineCells(), 120);
  await v.render(); await v.render(); assert.equal(terminal.drawn.length, 1, 'not drawn again while nothing changed');
  // Scrolled: no cell of the old place still shows it, and the four rows in view are drawn.
  await v.show(12);
  assert.equal(terminal.drawn.length, 2); assert.deepEqual([terminal.drawn[1].row, terminal.drawn[1].rows], [3, 4]);
  assert.equal(readPng(terminal.drawn[1].data).height, 160); assert.equal(terminal.inlineCells(), 80, 'only the cells of its new place hold it');
  // A dialog over part of it: the rest of it goes too.
  await v.show(6); assert.equal(terminal.inlineCells(), 120);
  const dialog = blessed.box({ parent: screen, top: 10, left: 20, width: 16, height: 5, border: 'line', content: 'Sure?' });
  await v.render(); assert.equal(terminal.inlineCells(), 0);
  dialog.destroy(); await v.render(); assert.equal(terminal.inlineCells(), 120);
  pictures.show(null); v.box.hide(); await v.render(); assert.equal(terminal.inlineCells(), 0);
  assert.doesNotMatch(v.state.raw, /\x1b_G/, 'iTerm2 is sent no Kitty command');
});

test('on a screen in tmux, in a terminal that shows no pictures, or with the switch off, nothing of a picture is written', { timeout: 20000 }, async t => {
  for (const [kind, env, asks] of [['kitty', { TERM: 'screen-256color', TMUX: '/tmp/tmux-1000/default,1,0' }, false], ['tmux', { TERM: 'xterm-256color' }, true], ['plain', { TERM: 'xterm-256color' }, true], ['silent', { TERM: 'xterm-256color' }, true], ['kitty', { TERM: 'xterm-256color', ELU_NO_PICTURES: '1' }, false]]) {
    const v = screenOn(t, kind, { env });
    await new Promise(resolve => setTimeout(resolve, kind === 'silent' ? 400 : 60));
    assert.equal(v.pictures.cell, null, `${kind}: text`); await v.show(6);
    assert.equal(v.state.raw.includes('\x1b[>0q'), asks, `${kind}: ${asks ? 'asked who it is' : 'asked nothing'}`);
    assert.doesNotMatch(v.state.raw, /\x1b_G|\x1b\]1337/, `${kind}: no picture command`);
    assert.deepEqual(v.terminal.printed, []); assert.equal(v.draws, 0);
    v.screen.destroy();
  }
});

test('a screen that closed gives the input back as it was: the next screen on it reads each key once', { timeout: 20000 }, async t => {
  const first = screenOn(t, 'kitty'), { input, output } = first;
  await until(() => first.pictures.protocol === 'kitty', 'the terminal asked');
  input.write('a'); await until(() => first.state.keys.length > 0, 'a key on the first screen');
  first.screen.destroy();
  const next = blessed.screen({ input, output, terminal: 'xterm-256color', smartCSR: true, fullUnicode: true, forceUnicode: true, warnings: false }), keys = [];
  try {
    next.on('keypress', (ch, key) => keys.push(key.full));
    input.write('b'); await until(() => keys.length > 0, 'a key on the next screen');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(keys, ['b']); assert.deepEqual(first.state.keys, ['a'], 'and the closed screen reads none');
  } finally { next.destroy(); }
});

// 0.1.34 gave every session with a Task the Artifacts tab and holds it at 44 columns as text
// (test/artifacts.test.mjs). The same width where the terminal shows pictures.
test('the tab fits a narrow width where the terminal shows pictures: what has no chart reads as it does in text, and a chart leaves its plot to the picture', () => {
  const width = 44, now = Date.parse('2026-11-15T10:05:00.000Z'), both = items => [artifactsView(items, { width, colour: false, now }), artifactsView(items, { width, colour: false, now, picture: true })];
  // A Task with no artifact yet, and an artifact with no data yet: the same rows, and no picture.
  const unfilled = { title: 'Chat eval', shows: 'Answered against 85%', every: 1, updates: [], script: null, run: null };
  for (const items of [[], [unfilled]]) { const [text, rows] = both(items); assert.deepEqual(shown(rows), shown(text)); assert.deepEqual(rows.pictures ?? [], []); }
  assert.equal(shown(both([])[1])[0], 'No artifacts yet');
  const chart = { kind: 'chart', label: 'Over time', unit: '%', target: 85, x: ['run 1', 'run 2', 'run 3'], series: [{ label: 'Accuracy', values: [78, 61, 84] }] };
  const charted = { title: 'Eval history', shows: 'accuracy by run', every: 5, updates: [{ at: '2026-11-15T10:00:00.000Z', data: readData(JSON.stringify({ blocks: [chart, { kind: 'note', text: 'Last run Nov 5.' }] })) }], script: 'echo', run: null };
  const [text, rows] = both([unfilled, charted]), plain = shown(rows), [found] = rows.pictures;
  assert.equal(rows.pictures.length, 1); assert.equal(plain.length, text.length, 'as many rows as the text chart');
  for (const row of plain) assert.ok(columns(row) <= width, `${columns(row)} columns: ${row}`);
  // Its plot: nine rows from its axis to the edge of the tab, blank for the picture.
  assert.deepEqual([found.rows, found.cols], [9, width - found.col]); assert.ok(found.cols >= 30, `${found.cols} columns for the plot`);
  for (let at = found.row; at < found.row + found.rows; at++) assert.equal(plain[at].slice(found.col), PICTURE_CELL.repeat(found.cols), `row ${at}`);
  assert.ok(!plain.some(row => /[⠁-⣿]/.test(row)), 'no text plot');
  // Everything over the plot reads as in text, and its axis, legend and note are text around it.
  assert.deepEqual(plain.slice(0, found.row), shown(text).slice(0, found.row));
  assert.ok(plain.join(' ').replace(/\s+/g, ' ').includes('The session fills it, then refreshes it with a script of its own.'));
  assert.equal(plain[found.row - 1], 'Over time'); assert.match(plain[found.row].slice(0, found.col), /^ *100% ┤$/); assert.match(plain[found.row + found.rows], /^ +└─+$/);
  const under = plain.slice(found.row + found.rows).join('\n');
  assert.match(under, /● Accuracy 84% ▲ 6/); assert.match(under, /╌ target ≥ 85%/); assert.match(under, /Last run Nov 5\./);
});
