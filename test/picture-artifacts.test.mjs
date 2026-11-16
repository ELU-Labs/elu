import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { project, temp } from './helpers.mjs';
import { liveTask } from './peer-helpers.mjs';
import { repository } from '../lib/git.mjs';
import { launchTerminal } from '../lib/terminal.mjs';
import { proposeTask, approveTask } from '../lib/plan.mjs';
import { addUpdate, readData, readSharedArtifacts, saveScript, sharedArtifacts } from '../lib/artifacts.mjs';
import { ASK_KITTY, ASK_WHO, PICTURE_CELL, kittyDrop } from '../lib/terminal-pictures.mjs';
import { chartColumn, chartRow, xtermRgb } from '../lib/chart-picture.mjs';
import { PALETTE } from '../lib/terminal-visuals.mjs';
import { IMAGE, pictureTerminal, readPng } from './picture-terminal.mjs';

// The owner on 2026-11-16: a chart on the Artifacts tab is a real picture where his terminal
// shows pictures, and the text chart everywhere else. This is the app itself, on streams, with a
// stand-in terminal (test/picture-terminal.mjs) on the other end: it answers what ELU asks as a
// terminal of its kind does, and keeps the pictures it is sent.

const ME = 'a'.repeat(64), BOX = 'b'.repeat(64);
const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const RUNS = Array.from({ length: 12 }, (_, index) => `run ${index + 1}`);
const ACCURACY = [78, 75, 74, 83, 85, 86, 80, 84, 93, 86, 61, 84], SUCCESS = [40, 40, 40, 50, 40, 40, 50, 30, null, 50, 20, 30];
// A score, the chart, and notes long enough for the tab to scroll at every size.
const DATA = { blocks: [
  { kind: 'score', label: 'Accuracy', value: 84, unit: '%', target: 85 },
  { kind: 'chart', label: 'Over time', unit: '%', target: 85, x: RUNS, series: [{ label: 'Accuracy', values: ACCURACY }, { label: 'Success rate', values: SUCCESS }] },
  { kind: 'note', text: Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of the notes.`).join('\n\n') },
] };
const BRAILLE = /[⠁-⣿]/;

function fakePeer({ remote = [] } = {}) {
  const facade = {
    running: true, channels: [], onTeam: () => true,
    peerStatus: () => ({ running: true, stale: false, pid: 1, key: ME, name: 'ana', fingerprint: 'aaaaaaaa', error: null, counters: { direct: 1, relayed: 0, failed: 0 },
      teams: [{ id: 'team-1', name: 'Core', role: 'admin', members: [{ key: ME, fingerprint: 'aaaaaaaa', name: 'ana', role: 'admin', online: true, path: null, lastSeen: ago(0) }, { key: BOX, fingerprint: 'bbbbbbbb', name: 'ana', role: 'member', online: true, path: 'direct', lastSeen: ago(0), box: 'my-box', bots: [] }], channels: [] }] }),
    peerItems: () => [], teamAgents: () => [], tickerEvents: () => [],
    sendPeerCommand: () => ({ id: 'command-1' }), awaitCommand: async () => ({}), startPeer: () => true, restartStale: () => false,
    mineRows: () => [{ key: BOX, mine: true, theirs: true }], remoteSessions: () => remote, remoteMachines: () => [], projectRepoId: () => null,
    access: { 'team-1': { handling: 'auto', rules: '', root: null, at: null } }, teamAccess: id => facade.access[id] ?? null,
  };
  return facade;
}
async function until(check, message = 'condition', timeout = 10000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// One after hook for each test: views close first, then the environment goes back and the folders are removed.
function owned(t) {
  const value = { views: [], files: [] };
  t.after(async () => { let failure = null; for (const close of [...value.views.reverse(), ...value.files.reverse()]) { try { await close(); } catch (error) { failure ??= error; } } if (failure) throw failure; });
  return value;
}
// A project with two sessions: one whose Task has the artifact with the chart, one with no Task.
// env: what the terminal's environment says, over a plain window with no tmux around it.
// data and at: what its artifact holds, and since when.
function start(t, env = {}, { data = DATA, at = undefined } = {}) {
  const mine = owned(t), p = project({ after: close => mine.files.push(close) });
  const values = { XDG_CONFIG_HOME: path.join(p.parent, 'personal'), TERM: 'xterm-256color', LANG: 'en_US.UTF-8', ELU_NO_COLOR: '', ELU_NO_PICTURES: '', ELU_PICTURES: '', TMUX: '', STY: '', ...env };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  mine.files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const repo = repository(p.root);
  liveTask(p.root, { id: '3', goal: 'Raise the accuracy', state: 'answered' });
  proposeTask(repo, '3', { title: 'Raise the accuracy', description: 'The eval runs each night.', goal: 'Accuracy reaches its target.', objectives: ['Accuracy is 85% or more'], priority: 'high', severity: 'low', artifacts: [{ title: 'Eval history', shows: 'accuracy by run', every: null }] });
  approveTask(repo, '3');
  addUpdate(repo, '3', 'Eval history', readData(JSON.stringify(data)), at ? { at } : {});
  liveTask(p.root, { id: '4', goal: 'Trim coupon codes', state: 'answered' });
  return { ...p, repo, mine };
}
function fakeUsage(t) {
  const home = temp(t); for (const name of ['claude', 'codex']) fs.mkdirSync(path.join(home, name));
  const vendors = [{ vendor: 'claude', available: true, signedIn: true }, { vendor: 'codex', available: true, signedIn: true }, { vendor: 'agy', available: true, signedIn: false }, { vendor: 'grok', available: false, signedIn: false }];
  return { home, env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex') }, vendors: () => vendors };
}
// The app in a stand-in terminal of a kind. What the app writes the terminal reads, and what the
// terminal answers the app reads with its keys, a moment later, as over a wire.
async function view(t, p, kind, { columns = 80, rows = 24, cell, wait = 300, ...options } = {}) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = columns; output.rows = rows;
  const terminal = pictureTerminal(kind, { columns, rows, cell });
  let rendered, raw = '';
  output.on('data', data => { raw += data; const reply = terminal.read(data.toString()); if (reply) setImmediate(() => { if (!input.destroyed) input.write(reply); }); });
  const finished = launchTerminal({ repo: p.repo, usage: fakeUsage(t), peer: fakePeer(), pictures: { wait, firstId: 500 }, ...options, input, output, refreshMs: 30, startConductor: () => false, onRender: value => { rendered = value; } });
  finished.catch(() => {});
  await until(() => rendered, 'first render');
  p.mine.views.push(async () => {
    let closed = false; finished.then(() => { closed = true; }, () => { closed = true; });
    for (const started = Date.now(); !closed && !rendered.screen.destroyed;) {
      const waited = Date.now() - started;
      if (waited > 10000) { input.destroy(); output.destroy(); throw new Error('The view did not close after its test.'); }
      rendered.panels.ask.cancel();
      for (const child of [...rendered.screen.children]) { child.dismiss?.(); child.children?.find(item => item.type === 'textbox')?.emit('cancel'); }
      if (waited > 3000) process.emit('SIGHUP'); else { rendered.panels.tabs[0].focus(); rendered.screen.emit('keypress', 'q', { name: 'q' }); }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    input.destroy(); output.destroy();
  });
  return { input, output, terminal, finished, get current() { return rendered; }, get panels() { return rendered.panels; }, get raw() { return raw; } };
}
// The cursor on the row that matches: its session shows beside the list.
async function onRow(v, pattern) {
  const { board } = v.panels;
  await until(() => board.items.some(item => pattern.test(item.getText())), `the row ${pattern}`);
  board.focus(); board.select(board.items.findIndex(item => pattern.test(item.getText())));
}
const tabs = v => v.panels.sessionTabs.getText();
// A click on the name of the Artifacts tab: it shows, and the keys go to it.
async function openArtifacts(v) {
  await until(() => !v.panels.sessionTabs.hidden && /Artifacts/.test(tabs(v)), 'its Artifacts tab');
  const x = v.panels.sessionTabs.aleft + tabs(v).indexOf('Artifacts') + 2, y = v.panels.sessionTabs.atop + 1;
  v.input.write(`\x1b[<0;${x};${y}M`); v.input.write(`\x1b[<0;${x};${y}m`);
  await until(() => !v.panels.artifacts.hidden && v.current.screen.focused === v.panels.artifacts, 'the Artifacts tab, with the keys');
}
// The cells of the terminal's screen left blank for a picture, or that hold an inline one:
// { row, col, cols, rows }, or null. Read from the terminal, which holds what the app wrote: the
// app's own copy of a pane is blank between two frames.
function blank(v) {
  let found = null; const under = cell => cell === PICTURE_CELL || cell === IMAGE;
  v.terminal.text.grid.forEach((line, y) => {
    const first = line.findIndex(under); if (first < 0) return;
    let last = first; while (under(line[last + 1])) last++;
    found = found ? { ...found, rows: found.rows + 1 } : { row: y, col: first, cols: last - first + 1, rows: 1 };
  });
  return found;
}
const rect = place => place ? { row: place.row, col: place.col, cols: place.cols, rows: place.rows } : null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// The one picture the terminal shows, once it shows it exactly over the blank cells of the screen.
async function placed(v, what) {
  try { await until(() => v.terminal.placed.size === 1 && same(rect([...v.terminal.placed.values()][0]), blank(v)), what); }
  catch (error) { throw new Error(`${error.message}: the terminal shows ${JSON.stringify([...v.terminal.placed.values()].map(rect))} and the blank cells are ${JSON.stringify(blank(v))}`); }
  return [...v.terminal.placed.values()][0];
}
// A row of the terminal's screen as text, from a column to another.
const text = (v, row, from = 0, to = Infinity) => v.terminal.text.grid[row].slice(from, to).join('');
const dialog = (v, title) => v.current.screen.children.find(child => !child.destroyed && child.options?.label?.trim() === title);

for (const [columns, rows] of [[80, 24], [140, 50]]) test(`at ${columns}x${rows}, a chart on the Artifacts tab is a picture in a terminal that shows pictures: sent once, scrolled and cut with the tab, gone with it and after quitting`, { timeout: 60000 }, async t => {
  const p = start(t), v = await view(t, p, 'kitty', { columns, rows }), { terminal } = v;
  await onRow(v, /Raise the accuracy/);
  await until(() => /Artifacts/.test(tabs(v)) && terminal.asked.includes(ASK_KITTY), 'its tabs, and the terminal asked');
  // ELU asked once, as it opened, and nothing of a picture is sent while the tab does not show.
  assert.equal(terminal.asked.filter(asked => asked === '\x1b[>0q').length, 1); assert.equal(terminal.asked.filter(asked => asked === ASK_KITTY).length, 1);
  assert.ok(v.raw.indexOf(ASK_WHO) >= 0 && v.raw.indexOf(ASK_WHO) < v.raw.indexOf(ASK_KITTY), 'who it is first, then whether it shows pictures');
  await sleep(150); assert.equal(terminal.sent.length, 0); assert.equal(terminal.placed.size, 0);
  await openArtifacts(v);
  const first = await placed(v, 'the chart as a picture over its plot'), box = v.panels.artifacts, high = box.height - 2, tall = box.width - 6 >= 100 ? 13 : 9;
  // The plot alone is the picture: its PNG has the size of the cells of the whole plot, and the
  // part of it in view shows.
  const read = readPng(terminal.images.get(first.id));
  assert.deepEqual([read.width, read.height], [first.cols * 10, tall * 20]);
  assert.deepEqual([first.x, first.y, first.width, first.height, first.cursorStays], [0, 0, first.cols * 10, first.rows * 20, true]);
  // Each series in its colour, where its values say, on a clear background: the tab's own shows through.
  const blue = xtermRgb(PALETTE.blue), green = xtermRgb(PALETTE.green), at = (index, value) => [Math.floor(chartColumn(index, { points: 12, cols: first.cols }) * 10), Math.floor(chartRow(value, { low: 0, high: 100, rows: tall }) * 20)];
  assert.deepEqual(read.at(...at(0, 78)), [...blue, 255]); assert.deepEqual(read.at(...at(8, 93)), [...blue, 255]); assert.deepEqual(read.at(...at(10, 20)), [...green, 255]);
  assert.equal(read.at(...at(8, 40))[3], 0, 'no point where the series has none'); assert.equal(read.at(read.width - 1, 0)[3], 0);
  // The axis and its values are text beside it, on the rows the picture puts those values.
  assert.match(text(v, first.row, first.col - 8, first.col), /100% ┤$/);
  assert.doesNotMatch(box.getText(), BRAILLE, 'no text plot under the picture');
  assert.equal(terminal.sent.length, 1);
  // Scrolled until its first two rows are past the top: the same picture from its third row,
  // moved, not sent again.
  const top = box.atop + 1, down = first.row - top + 2;
  for (let step = 0; step < down; step++) v.input.write('\x1b[B');
  await until(() => [...terminal.placed.values()][0]?.y === 40, 'the picture cut at the top of the tab');
  const cut = await placed(v, 'the picture over what is left of its plot');
  assert.deepEqual([cut.row, cut.y, cut.rows, cut.height], [top, 40, Math.min(tall - 2, high), Math.min(tall - 2, high) * 20]);
  assert.equal(terminal.sent.length, 1, 'scrolling sends nothing again');
  // The legend and the x labels under it are text.
  assert.match(box.getText(), /● Accuracy 84%/); assert.match(box.getText(), /run 1 /); assert.match(box.getText(), /╌ target ≥ 85%/);
  // Scrolled past it: it shows nowhere. Back at the top, it shows again.
  v.input.write('\x1b[F'); await until(() => terminal.placed.size === 0 && !blank(v), 'the end of the notes, the chart out of view');
  v.input.write('\x1b[H'); await placed(v, 'the chart again at the top');
  // The Chat tab: the picture is gone, and nothing is sent while the tab is hidden.
  v.input.write('\x1b'); await until(() => v.panels.artifacts.hidden && terminal.placed.size === 0, 'the Chat tab, with no picture');
  const before = v.raw.length; await sleep(250);
  assert.doesNotMatch(v.raw.slice(before), /\x1b_G|\x1b\]1337/, 'nothing of a picture is written while the tab is hidden');
  await openArtifacts(v); await placed(v, 'the chart again');
  assert.equal(terminal.sent.length, 1, 'the same chart at the same size is not sent again');
  // No answer of the terminal was typed anywhere, and it never saw a command it did not know.
  assert.equal(v.panels.ask.getValue(), ''); assert.deepEqual(terminal.printed, []);
  // Quitting: the picture is removed before the terminal's own screen comes back.
  v.panels.tabs[0].focus(); v.current.screen.emit('keypress', 'q', { name: 'q' });
  await v.finished;
  assert.deepEqual(terminal.left, [{ images: 0, placed: 0 }]);
  assert.ok(v.raw.includes(kittyDrop(first.id)) && v.raw.indexOf(kittyDrop(first.id)) < v.raw.lastIndexOf('\x1b[?1049l'));
});

test('a dialog over the chart, another session and a smaller window each take the picture away, and it is drawn again for a new size', { timeout: 60000 }, async t => {
  const p = start(t), v = await view(t, p, 'kitty'), { terminal } = v;
  await onRow(v, /Raise the accuracy/); await openArtifacts(v);
  const first = await placed(v, 'the chart as a picture');
  // A dialog over it: no picture shows through, and it is back when the dialog closes.
  v.input.write('?'); await until(() => dialog(v, 'Commands'), 'the Commands dialog');
  await until(() => terminal.placed.size === 0, 'no picture under a dialog');
  v.input.write('\x1b');
  await until(() => !dialog(v, 'Commands'), 'the dialog closed'); await placed(v, 'the chart again');
  assert.equal(terminal.sent.length, 1);
  // A session with no Task has no such tab: nothing shows.
  await onRow(v, /Trim coupon codes/);
  await until(() => v.panels.artifacts.hidden && terminal.placed.size === 0, 'another session, with no picture');
  await onRow(v, /Raise the accuracy/); await openArtifacts(v); await placed(v, 'the chart of the first session');
  assert.equal(terminal.sent.length, 1);
  // A larger window with larger cells: the terminal is asked for their size again, and the chart
  // is drawn and sent once for its new size. The old one is not kept.
  v.output.columns = 140; v.output.rows = 50; terminal.resize(140, 50, { width: 12, height: 24 }); v.output.emit('resize');
  await until(() => v.current.screen.width === 140, 'the larger window');
  const again = await placed(v, 'the chart at its new size'), tall = v.panels.artifacts.width - 6 >= 100 ? 13 : 9;
  assert.notEqual(again.id, first.id); assert.ok(again.cols > first.cols);
  const read = readPng(terminal.images.get(again.id)); assert.deepEqual([read.width, read.height], [again.cols * 12, tall * 24]);
  assert.deepEqual([...terminal.images.keys()], [again.id], 'the terminal keeps the one that shows');
  assert.equal(terminal.sent.length, 2);
  // Too small a window for the app: its notice covers everything, and no picture shows.
  v.output.columns = 60; v.output.rows = 20; terminal.resize(60, 20); v.output.emit('resize');
  await until(() => v.current.screen.width === 60, 'the small window'); await sleep(500);
  assert.equal(terminal.placed.size, 0); assert.deepEqual(terminal.printed, []);
});

// The plot's cells are blank whatever the chart holds, so new data can leave every row of text
// as it was: the picture is what changed.
test('new data that moves only a point in the middle of the chart shows as a new picture', { timeout: 60000 }, async t => {
  const chart = DATA.blocks[1], first = new Date(Date.now() - 180000); first.setSeconds(5, 0);
  const p = start(t, {}, { data: { blocks: [chart] }, at: first.toISOString() }), v = await view(t, p, 'kitty'), { terminal } = v;
  await onRow(v, /Raise the accuracy/); await openArtifacts(v);
  const was = await placed(v, 'the chart as a picture'), rows = v.panels.artifacts.getText();
  // Once the app has nothing left to draw: only the new data brings the next frame.
  await sleep(2500);
  // The same minute and the same newest values: its time, its labels and its legend stay.
  const moved = { ...chart, series: [{ label: 'Accuracy', values: ACCURACY.map((value, index) => index === 5 ? 20 : value) }, chart.series[1]] };
  addUpdate(p.repo, '3', 'Eval history', readData(JSON.stringify({ blocks: [moved] })), { at: new Date(first.getTime() + 10000).toISOString() });
  // On the next tick, not with whatever draws the screen next.
  await until(() => terminal.sent.length === 2 && terminal.placed.size === 1 && [...terminal.placed.values()][0].id !== was.id, 'the new picture in place of the old one', 1500);
  assert.equal(v.panels.artifacts.getText(), rows, 'no row of text changed');
  const now = [...terminal.placed.values()][0], read = readPng(terminal.images.get(now.id));
  assert.deepEqual(read.at(Math.floor(chartColumn(5, { points: 12, cols: now.cols }) * 10), Math.floor(chartRow(20, { low: 0, high: 100, rows: 9 }) * 20)), [...xtermRgb(PALETTE.blue), 255], 'the point where it is now');
});

test('two charts that show the same are each a picture over its own plot', { timeout: 60000 }, async t => {
  const chart = DATA.blocks[1];
  const p = start(t, {}, { data: { blocks: [chart, chart] } }), v = await view(t, p, 'kitty', { columns: 100, rows: 50 }), { terminal } = v;
  await onRow(v, /Raise the accuracy/); await openArtifacts(v);
  await until(() => terminal.placed.size === 2, 'a picture for each chart');
  // Frames keep coming: both stay where they are.
  await sleep(400);
  const places = [...terminal.placed.values()].sort((a, b) => a.row - b.row);
  assert.equal(places.length, 2); assert.ok(places[1].row >= places[0].row + places[0].rows, 'one under the other');
  for (const place of places) for (let y = place.row; y < place.row + place.rows; y++) assert.equal(text(v, y, place.col, place.col + place.cols), PICTURE_CELL.repeat(place.cols), `row ${y} is blank under its picture`);
  assert.equal(terminal.text.grid.filter(line => line.includes(PICTURE_CELL)).length, places[0].rows + places[1].rows, 'no plot is left without its picture');
  assert.equal(terminal.sent.length, 2); assert.deepEqual(terminal.printed, []);
});

// Projects, Kanban, Chats, Bots and Usage show in the session's place.
test('another tab of the app takes the picture away, and it is back with its session without being sent again', { timeout: 60000 }, async t => {
  const p = start(t), v = await view(t, p, 'kitty'), { terminal } = v;
  await onRow(v, /Raise the accuracy/); await openArtifacts(v);
  await placed(v, 'the chart as a picture');
  const click = tab => { const x = tab.aleft + 2, y = tab.atop + 1; v.input.write(`\x1b[<0;${x};${y}M`); v.input.write(`\x1b[<0;${x};${y}m`); };
  click(v.panels.tabs[2]);
  await until(() => v.current.view === 'kanban' && terminal.placed.size === 0 && !blank(v), 'Kanban, with no picture');
  const before = v.raw.length; await sleep(250);
  assert.doesNotMatch(v.raw.slice(before), /\x1b_G|\x1b\]1337/, 'nothing of a picture is written while another tab shows');
  click(v.panels.tabs[0]);
  await onRow(v, /Raise the accuracy/); await openArtifacts(v); await placed(v, 'the chart again');
  assert.equal(terminal.sent.length, 1); assert.deepEqual(terminal.printed, []);
});

test('without colour the chart is a grey picture whose marks tell the series apart', { timeout: 60000 }, async t => {
  const p = start(t, { ELU_NO_COLOR: '1' }), v = await view(t, p, 'ghostty'), { terminal } = v;
  await onRow(v, /Raise the accuracy/); await openArtifacts(v);
  const first = await placed(v, 'the chart as a picture'), read = readPng(terminal.images.get(first.id));
  const at = (index, value) => [Math.floor(chartColumn(index, { points: 12, cols: first.cols }) * 10), Math.floor(chartRow(value, { low: 0, high: 100, rows: 9 }) * 20)];
  assert.deepEqual(read.at(...at(0, 78)), [128, 128, 128, 255]); assert.deepEqual(read.at(...at(0, 40)), [128, 128, 128, 255]);
  // The second series has square marks: the corner of one is filled where a round one is not.
  const [x, y] = at(0, 40), [rx, ry] = at(0, 78);
  assert.ok(read.at(x + 2, y + 2)[3] > 240, `a square's corner: ${read.at(x + 2, y + 2)[3]}`); assert.ok(read.at(rx + 2, ry + 2)[3] < 200, `a round mark there: ${read.at(rx + 2, ry + 2)[3]}`);
});

test('in iTerm2 the chart is an inline picture on the tab\'s own background, drawn again where it moves and written over where it goes', { timeout: 60000 }, async t => {
  const p = start(t), v = await view(t, p, 'iterm'), { terminal } = v;
  await onRow(v, /Raise the accuracy/); await openArtifacts(v);
  await until(() => terminal.drawn.length === 1 && blank(v) && terminal.inlineCells() === blank(v).cols * blank(v).rows, 'the chart as an inline picture over its plot');
  const where = blank(v), drawn = terminal.drawn[0];
  assert.deepEqual(rect(drawn), where); assert.equal(drawn.size, drawn.data.length); assert.equal(drawn.inline, '1');
  // iTerm2 counts a cell in points, two pixels each: the stand-in's 10 by 20 is drawn at 20 by 40.
  const read = readPng(drawn.data); assert.deepEqual([read.width, read.height], [where.cols * 20, where.rows * 40]);
  assert.deepEqual(read.at(read.width - 1, 0), [...xtermRgb(PALETTE.panel), 255], 'the pane\'s colour behind it');
  await sleep(200); assert.equal(terminal.drawn.length, 1, 'not drawn again while nothing changed');
  // Scrolled by a row: drawn again one row higher, and no cell of its old place still shows it.
  v.input.write('\x1b[B');
  await until(() => terminal.drawn.length === 2 && same(rect(terminal.drawn[1]), blank(v)), 'drawn again where it moved');
  assert.equal(terminal.drawn[1].row, where.row - 1); assert.equal(terminal.inlineCells(), blank(v).cols * blank(v).rows);
  // The Chat tab: its cells are written over.
  v.input.write('\x1b'); await until(() => v.panels.artifacts.hidden && terminal.inlineCells() === 0, 'the Chat tab, with no picture');
  assert.doesNotMatch(v.raw, /\x1b_G/, 'iTerm2 is sent no Kitty command'); assert.equal(v.panels.ask.getValue(), '');
});

// Where no picture can show, the chart is the text chart, and nothing of a picture is written.
// asks: whether ELU asks the terminal at all. apc: whether it may be sent Kitty's question.
for (const [name, kind, env, asks, apc] of [
  ['inside tmux', 'kitty', { TMUX: '/tmp/tmux-1000/default,31,0' }, false, false],
  ['over SSH from inside tmux, which only TERM says', 'kitty', { TERM: 'screen-256color' }, false, false],
  ['in a terminal that says it is tmux', 'tmux', {}, true, false],
  ['in a terminal that does not say who it is', 'plain', {}, true, false],
  ['in a terminal that answers nothing', 'silent', {}, true, false],
  ['in a terminal that says it shows none', 'refuses', {}, true, true],
  ['in a terminal that names itself and shows none', 'xterm', {}, true, true],
  ['with ELU_NO_PICTURES=1', 'kitty', { ELU_NO_PICTURES: '1' }, false, false],
  // The screen then writes no character beyond ASCII as it is, the blank cell under a picture too.
  ['where the language is not UTF-8', 'kitty', { LANG: 'C', LANGUAGE: '', LC_ALL: '', LC_CTYPE: '' }, true, true],
]) test(`${name}, the chart is the text chart and nothing of a picture is written`, { timeout: 60000 }, async t => {
  const p = start(t, env), v = await view(t, p, kind), { terminal } = v;
  await onRow(v, /Raise the accuracy/); await openArtifacts(v);
  await until(() => BRAILLE.test(v.panels.artifacts.getText()), 'the text chart');
  // Longer than ELU waits for an answer.
  await sleep(500);
  assert.match(v.panels.artifacts.getText(), BRAILLE); assert.equal(blank(v), null, 'no cell is left blank for a picture');
  assert.equal(v.raw.includes('\x1b[>0q'), asks, asks ? 'it asked who the terminal is' : 'it asked nothing');
  assert.equal(v.raw.includes(ASK_KITTY), apc);
  assert.doesNotMatch(v.raw.replace(ASK_KITTY, ''), /\x1b_G|\x1b\]1337/, 'no picture command');
  assert.deepEqual(terminal.printed, [], 'nothing the terminal would print'); assert.equal(terminal.sent.length, 0); assert.equal(terminal.drawn.length, 0);
  assert.equal(v.panels.ask.getValue(), '', 'no answer was typed');
});

test('a session on another computer keeps the text chart in a terminal that shows pictures', { timeout: 60000 }, async t => {
  const p = start(t), at = ago(5);
  const artifacts = readSharedArtifacts(JSON.parse(JSON.stringify(sharedArtifacts([{ title: 'Eval history', shows: 'accuracy by run', every: null, script: null, run: null, updates: [{ at, data: readData(JSON.stringify(DATA)) }] }]))));
  const plan = { id: 't-1', session: '1', revision: 1, title: 'Raise it on the other computer', description: 'The eval runs each night.', goal: 'Accuracy reaches its target.', objectives: ['Accuracy is 85% or more'], priority: 'high', severity: 'low', startedBy: 'owner', by: 'lead', state: 'approved', proposedAt: at, approvedAt: at, rejectedAt: null, doneAt: null, subtasks: [], met: [], criteria: [], estimateMinutes: null, etaMinutes: null, etaAt: null, artifacts };
  const remote = [{ id: '66666666-6666-4666-8666-666666666666', machine: BOX, createdAt: ago(10), lastAt: ago(0), title: 'Raise it on the other computer', project: 'shop', approvals: [], steps: [], state: 'answered', plan, entries: [{ role: 'You', at: ago(10), text: 'Raise it on the other computer' }, { role: 'Claude', lead: true, at: ago(9), text: 'Here is the Task for it.' }] }];
  const v = await view(t, p, 'kitty', { peer: fakePeer({ remote }) }), { terminal } = v;
  await onRow(v, /Raise it on/); await openArtifacts(v);
  await until(() => BRAILLE.test(v.panels.artifacts.getText()), 'its text chart');
  await until(() => terminal.asked.includes(ASK_KITTY), 'the terminal asked'); await sleep(300);
  assert.match(v.panels.artifacts.getText(), BRAILLE); assert.equal(blank(v), null);
  assert.equal(terminal.sent.length, 0); assert.equal(terminal.placed.size, 0);
  // The same chart of a session here is a picture.
  await onRow(v, /Raise the accuracy/); await openArtifacts(v); await placed(v, 'the chart of a session here as a picture');
});

// Found by a check on 2026-11-16: a chart whose min is above all its values, which elu artifacts
// set takes, had no room on its axis. Its rows threw, the session's Artifacts tab was blank, and
// the status line said only "Invalid array length". Its min stays, and its values sit on that edge.
for (const [kind, how] of [['plain', 'as text'], ['kitty', 'as a picture']]) test(`a chart whose min is above all its values shows on the Artifacts tab ${how}, its points on the edge of its axis`, { timeout: 60000 }, async t => {
  const chart = { kind: 'chart', label: 'Latency', unit: 's', min: 2, x: ['Mon', 'Tue'], series: [{ label: 'Median', values: [1.2, 0.9] }] };
  const p = start(t, {}, { data: { blocks: [chart] } }), v = await view(t, p, kind, { columns: 100, rows: 40 }), { terminal } = v;
  await onRow(v, /Raise the accuracy/); await openArtifacts(v);
  await until(() => /Latency/.test(v.panels.artifacts.getText()), 'the chart on the tab');
  assert.match(v.panels.artifacts.getText(), /● Median 0\.9 s/, 'its legend, under its plot');
  if (kind === 'plain') {
    assert.match(v.panels.artifacts.getText(), / 2 s ┤●⣀+●/, 'both points and the line between them on the row of its min');
    await sleep(400); assert.equal(terminal.sent.length, 0);
  } else {
    const place = await placed(v, 'the chart as a picture over its plot'), read = readPng(terminal.images.get(place.id));
    assert.equal(place.rows, 9, 'the whole plot is in view');
    assert.match(text(v, place.row + 8, place.col - 6, place.col), / 2 s ┤$/, 'its min beside the last row of the picture');
    for (const index of [0, 1]) assert.deepEqual(read.at(Math.floor(chartColumn(index, { points: 2, cols: place.cols }) * 10), 170), [...xtermRgb(PALETTE.blue), 255], `point ${index} in the middle of that row`);
  }
  assert.doesNotMatch(terminal.text.grid.map(line => line.join('')).join('\n'), /Invalid array length/, 'the screen says nothing of an error');
  assert.deepEqual(terminal.printed, []);
});

// Where the pictures meet what 0.1.34 gave the Artifacts tab: the tab on every session with a
// Task, which says how to add an artifact while it has none; a note drawn as Markdown and copied
// as written; and an artifact's refresh script shown as written in the Task.
const EMPTY = ['No artifacts yet', 'Say in the chat what to show, or Ctrl+T, New goal, with an Artifact: line.'];
// The tab's headline, then the rest of what it says as one line.
const said = v => { const [head, ...rest] = v.panels.artifacts.getText().split('\n').map(line => line.replace(/[┃\s]+$/, '').trim()).filter(Boolean); return [head, rest.join(' ')]; };
test('in a terminal that shows pictures, a Task with no artifact yet has its Artifacts tab with the one line that says how to add one and no picture, at 80 and at 160 columns', { timeout: 60000 }, async t => {
  const p = start(t);
  liveTask(p.root, { id: '5', goal: 'Uppercase coupons', state: 'answered' });
  proposeTask(p.repo, '5', { title: 'Uppercase coupons', description: 'One file changes.', goal: 'Coupon codes compare equal whatever their case.', objectives: ['It works'], priority: 'high', severity: 'low' }); approveTask(p.repo, '5');
  const v = await view(t, p, 'kitty'), { terminal } = v;
  await onRow(v, /Uppercase coupons/); await openArtifacts(v);
  await until(() => terminal.asked.includes(ASK_KITTY) && /No artifacts yet/.test(v.panels.artifacts.getText()), 'its tab, and the terminal asked'); await sleep(400);
  assert.deepEqual(said(v), EMPTY); assert.equal(terminal.sent.length, 0); assert.equal(terminal.placed.size, 0); assert.equal(blank(v), null);
  // The session with the chart shows its picture. Back on the one with no artifact: its line
  // again, and the picture gone.
  await onRow(v, /Raise the accuracy/); await openArtifacts(v); await placed(v, 'the chart of the other session as a picture');
  await onRow(v, /Uppercase coupons/); await openArtifacts(v);
  await until(() => terminal.placed.size === 0 && blank(v) === null && /No artifacts yet/.test(v.panels.artifacts.getText()), 'the empty tab again, with no picture');
  assert.deepEqual(said(v), EMPTY);
  // At 160 columns its one line is on one row.
  v.output.columns = 160; v.output.rows = 50; terminal.resize(160, 50); v.output.emit('resize');
  await until(() => v.current.screen.width === 160 && v.panels.artifacts.getText().split('\n').filter(line => line.trim()).length === 2, 'its one line on one row at 160 columns');
  assert.deepEqual(said(v), EMPTY); await sleep(300); assert.equal(terminal.placed.size, 0); assert.equal(blank(v), null);
  // A session with no Task has no such tab, here as everywhere.
  await onRow(v, /Trim coupon codes/);
  await until(() => v.panels.artifacts.hidden && !/Artifacts/.test(tabs(v)), 'no tab for a session with no Task');
  assert.equal(terminal.sent.length, 1, 'the one chart, sent once'); assert.deepEqual(terminal.printed, []);
});

const sgr = (b, x, y, up = false) => `\x1b[<${b};${x + 1};${y + 1}${up ? 'm' : 'M'}`;
const drag = (v, from, to) => { v.input.write(sgr(0, from.x, from.y)); v.input.write(sgr(32, to.x, to.y)); v.input.write(sgr(0, to.x, to.y, true)); };
test('a note under a chart that is a picture draws as Markdown and copies as written, and a copy across the chart holds its text alone', { timeout: 60000 }, async t => {
  const NOTE = 'The **last** run kept `SAVE10` working.\n\n| Run | Accuracy |\n|---|---|\n| 12 | 84% |';
  const CHART = { kind: 'chart', label: 'Over time', unit: '%', target: 85, x: ['Run 10', 'Run 11', 'Run 12'], series: [{ label: 'Accuracy', values: [86, 61, 84] }] };
  const copied = [], p = start(t, {}, { data: { blocks: [CHART, { kind: 'note', text: NOTE }] } });
  const v = await view(t, p, 'kitty', { columns: 140, rows: 50, clipboard: text => copied.push(text) }), { terminal } = v;
  await onRow(v, /Raise the accuracy/); await openArtifacts(v);
  const place = await placed(v, 'the chart as a picture over its plot');
  await until(() => /kept SAVE10 working/.test(v.panels.artifacts.getText()), 'the note under it');
  const box = v.panels.artifacts, x0 = box.aleft + box.ileft, x1 = box.aleft + box.width - 1 - box.iright, lines = () => terminal.text.grid.map(line => line.join(''));
  const row = pattern => lines().findIndex(line => pattern.test(line)), label = row(/Over time/), legend = row(/● Accuracy 84%/), top = row(/The last run kept SAVE10 working\./), bottom = lines().findLastIndex(line => /│ 12\s+│ 84%\s+│/.test(line));
  assert.ok(label >= 0 && label < place.row && place.row + place.rows <= legend && legend < top && top < bottom, lines().join('\n'));
  // Drawn: the axis and the legend as text around the picture, the note with no star, backtick or pipe row.
  const pane = lines().slice(label, bottom + 2).map(line => line.slice(x0, x1 + 1)).join('\n');
  assert.match(pane, /100% ┤/); assert.match(pane, /● Accuracy 84% ▼ 2/); assert.match(box.getText(), /╌ target ≥ 85%/); assert.match(pane, /┌─/); assert.ok(!/\*\*|`|\|---/.test(pane), pane); assert.doesNotMatch(pane, BRAILLE);
  drag(v, { x: x0, y: top }, { x: x1 - 2, y: bottom });
  await until(() => copied.length === 1, 'the copy of the note');
  assert.equal(copied[0], NOTE);
  // From the chart's label through the note: the chart's own text as it shows, with nothing of
  // the cells left blank for the picture, then the note as written.
  drag(v, { x: x0, y: label }, { x: x1 - 2, y: bottom });
  await until(() => copied.length === 2, 'the copy across the chart');
  assert.equal(copied[1].split('\n')[0].trim(), 'Over time'); assert.match(copied[1], /100% ┤/); assert.match(copied[1], /● Accuracy 84%/);
  assert.ok(!copied[1].includes(PICTURE_CELL), JSON.stringify(copied[1])); assert.ok(copied[1].endsWith(NOTE), copied[1]);
  // The picture was sent once and nothing of it was printed as text.
  assert.equal(terminal.sent.length, 1); assert.deepEqual(terminal.printed, []);
});

test('the Task of a session whose chart is a picture shows its artifact\'s refresh script as written; the picture is away while the Task is over it, and back after', { timeout: 60000 }, async t => {
  const REFRESH = ['#!/bin/sh', '# Prints the last run: `cat .evals/chat.json`', 'run=$(cat .evals/chat.json)', 'echo "**kept** as _written_ <b>"', 'printf "%s" "$run"'].join('\n');
  const p = start(t);
  liveTask(p.root, { id: '5', goal: 'Answer more eval questions', state: 'answered' });
  proposeTask(p.repo, '5', { title: 'Chat answers at 85%', description: 'Raise the answered share.', goal: 'Answer 85% of the eval questions.', objectives: ['Answered at 85%'], priority: 'medium', severity: 'low', artifacts: [{ title: 'Chat eval', shows: 'Answered against 85%', every: 5 }] }); approveTask(p.repo, '5');
  addUpdate(p.repo, '5', 'Chat eval', readData(JSON.stringify(DATA))); saveScript(p.repo, '5', 'Chat eval', REFRESH);
  const v = await view(t, p, 'kitty', { columns: 140, rows: 50 }), { terminal } = v;
  await onRow(v, /Chat answers at 85%/); await openArtifacts(v);
  const first = await placed(v, 'the chart as a picture');
  v.input.write('\x14'); await until(() => dialog(v, 'Task'), 'its Task');
  await until(() => terminal.placed.size === 0, 'no picture under the Task');
  // A code line longer than the dialog goes on under ↪: read back whole.
  const rows = dialog(v, 'Task').children.filter(child => child.type === 'list').flatMap(list => list.items.map(item => item.getText())).join('\n');
  const shown = rows.replace(/\s*\n\s*↪ /g, '').split('\n').map(line => line.trim());
  assert.deepEqual(REFRESH.split('\n').filter(line => !shown.includes(line)), [], rows);
  v.input.write('\x1b'); await until(() => !dialog(v, 'Task'), 'Esc closes it');
  const again = await placed(v, 'the chart again');
  assert.equal(again.id, first.id); assert.equal(terminal.sent.length, 1, 'the same picture, not sent again'); assert.deepEqual(terminal.printed, []);
});
