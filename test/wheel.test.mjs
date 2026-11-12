import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import blessed from 'blessed';
import { frameRender, steadyWheel, WHEEL_FRAME_MS } from '../lib/wheel.mjs';

// A clock and timers the test moves by hand.
function fakeTime() {
  let clock = 0; const queue = [];
  const time = { now: () => clock, later: (run, ms) => queue.push({ at: clock + ms, run }) };
  const advance = ms => {
    const end = clock + ms;
    for (;;) {
      queue.sort((a, b) => a.at - b.at);
      if (!queue.length || queue[0].at > end) break;
      const next = queue.shift(); clock = Math.max(clock, next.at); next.run();
    }
    clock = end;
  };
  return { time, advance };
}

// A real blessed screen on streams that counts its draws and what each draw showed.
function wheelScreen(t) {
  const input = new PassThrough(), output = new PassThrough(); input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = 80; output.rows = 24; output.resume();
  const screen = blessed.screen({ input, output, terminal: 'xterm-256color', warnings: false });
  t.after(() => { screen.destroy(); input.destroy(); output.destroy(); });
  const render = screen.render.bind(screen), draws = [];
  screen.watch = read => { draws.length = 0; screen.render = () => { draws.push(read()); render(); }; };
  return { screen, draws, ...fakeTime() };
}

const text = n => Array.from({ length: n }, (_, at) => `line ${at}`).join('\n');
const rows = n => Array.from({ length: n }, (_, at) => `row ${at}`);

test('ten trackpad steps 5 ms apart move the chat ten lines, drawn at most once a frame, and the last draw shows the end', t => {
  const { screen, draws, time, advance } = wheelScreen(t);
  const chat = steadyWheel(blessed.box({ parent: screen, top: 0, left: 0, width: 40, height: 20, scrollable: true, alwaysScroll: true, mouse: true, content: text(200) }), null, time);
  screen.render(); screen.watch(() => chat.childBase);
  chat.emit('wheeldown'); assert.equal(chat.childBase, 1, 'one line, where blessed scrolled half the pane');
  advance(5);
  for (let n = 1; n < 10; n++) { chat.emit('wheeldown'); assert.equal(chat.childBase, n + 1, 'every step moves at once'); advance(5); }
  advance(WHEEL_FRAME_MS);
  assert.equal(chat.childBase, 10, 'ten steps, ten lines');
  assert.ok(draws.length > 1 && draws.length < 10, `fewer draws than steps (${draws.length})`);
  assert.equal(draws.at(-1), 10, 'the last draw shows the exact place');
});

test('ten trackpad steps 5 ms apart move a list ten rows, and its cursor stays in view', t => {
  const { screen, draws, time, advance } = wheelScreen(t);
  const list = steadyWheel(blessed.list({ parent: screen, top: 0, left: 40, width: 30, height: 8, mouse: true, keys: true, items: rows(30) }), null, time);
  list.select(0); screen.render(); screen.watch(() => list.selected);
  list.items[0].emit('wheeldown'); assert.equal(list.selected, 1, 'one row, where blessed moved two'); assert.equal(list.childBase, 0, 'the rows did not jump');
  advance(5);
  // Over a row or over the list itself, as the pointer happens to be.
  for (let n = 1; n < 10; n++) { (n % 2 ? list : list.items[list.selected]).emit('wheeldown'); advance(5); }
  advance(WHEEL_FRAME_MS);
  assert.equal(list.selected, 10, 'ten steps, ten rows');
  assert.ok(list.selected >= list.childBase && list.selected < list.childBase + list.height, 'the cursor is in view');
  assert.ok(draws.length < 10, `fewer draws than steps (${draws.length})`); assert.equal(draws.at(-1), 10);
  for (let n = 0; n < 15; n++) list.emit('wheelup');
  assert.equal(list.selected, 0, 'and stops at the first row');
});

test('a turn the other way moves at once', t => {
  const { screen, time, advance } = wheelScreen(t);
  const chat = steadyWheel(blessed.box({ parent: screen, top: 0, left: 0, width: 40, height: 20, scrollable: true, alwaysScroll: true, mouse: true, content: text(200) }), null, time);
  screen.render();
  for (let n = 0; n < 5; n++) chat.emit('wheeldown');
  assert.equal(chat.childBase, 5, 'five steps in one read, five lines');
  chat.emit('wheelup'); assert.equal(chat.childBase, 4, 'up a line at once, in the same frame');
  chat.emit('wheeldown'); chat.emit('wheelup'); chat.emit('wheelup'); assert.equal(chat.childBase, 3);
  advance(WHEEL_FRAME_MS); assert.equal(chat.childBase, 3);
});

test('a pane that draws its own rows is handed every step and draws once a frame', () => {
  const { time, advance } = fakeTime(), moved = []; let draws = 0;
  const screen = { render() { throw new Error('the pane draws itself'); } };
  const pane = Object.assign(new EventEmitter(), { screen });
  steadyWheel(pane, step => moved.push(step), { render: () => draws++, ...time });
  for (let n = 0; n < 4; n++) pane.emit('wheeldown');
  pane.emit('wheelup');
  assert.deepEqual(moved, [1, 1, 1, 1, -1], 'no step is dropped'); assert.equal(draws, 0, 'the draw waits for the read to end');
  advance(0); assert.equal(draws, 1, 'one draw for the read');
  pane.emit('wheeldown'); advance(0); assert.equal(draws, 1, 'within a frame the draw waits');
  advance(WHEEL_FRAME_MS); assert.equal(draws, 2, 'and comes at the end of the frame');
  advance(100); assert.equal(draws, 2, 'no draw without a step');
});

test('a draw waits for the frame, and a quiet spell draws on the next turn', async () => {
  let draws = 0; const draw = frameRender(() => draws++);
  draw(); draw(); assert.equal(draws, 0);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(draws, 1, 'the first draw comes on the next turn');
  draw(); await new Promise(resolve => setImmediate(resolve)); assert.equal(draws, 1, 'the next waits for the frame');
  await new Promise(resolve => setTimeout(resolve, WHEEL_FRAME_MS + 20)); assert.equal(draws, 2);
});
