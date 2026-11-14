import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import blessed from 'blessed';
import { project, fakeClis, cli, git, temp } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { launchTerminal } from '../lib/terminal.mjs';
import { Conductor } from '../lib/conductor.mjs';
import { saveTask, firstWords, firstLine, taskTitle, teammateText } from '../lib/state.mjs';
import { columns, head } from '../lib/width.mjs';

// Long text on screen: the idle app with a long message open, a dialog through a change of the
// window's size. The app is the real one, on streams, as in terminal.test.mjs.
const cleanups = new WeakMap();
function resources(t) {
  if (!cleanups.has(t)) {
    const value = { views: [], files: [] }; cleanups.set(t, value);
    t.after(async () => {
      let failure = null;
      for (const close of [...value.views.reverse(), ...value.files.reverse()]) { try { await close(); } catch (error) { failure ??= error; } }
      if (failure) throw failure;
    });
  }
  return cleanups.get(t);
}
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  resources(t).files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function setup(t, mode = 'normal') {
  const p = project({ after: close => resources(t).files.push(close) }), fake = fakeClis(p.parent, { mode });
  environment(t, { ...fake.env, XDG_CONFIG_HOME: path.join(p.parent, 'personal'), NO_COLOR: '1' });
  assert.equal(cli(p.root, ['init', '--yes'], fake.env).status, 0);
  git(p.root, ['add', '.']); git(p.root, ['commit', '-m', 'Configure checks']);
  return { ...p, ...fake, repo: repository(p.root) };
}
async function until(check, message = 'condition', timeout = 10000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function fakeUsage(t) {
  const home = temp(t); for (const name of ['claude', 'codex']) fs.mkdirSync(path.join(home, name));
  const vendors = [{ vendor: 'claude', available: true, signedIn: true }, { vendor: 'codex', available: true, signedIn: true }, { vendor: 'agy', available: true, signedIn: false }, { vendor: 'grok', available: false, signedIn: false }];
  return { home, env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex') }, vendors: () => vendors };
}
async function view(t, options = {}) {
  environment(t, { TERM: 'xterm-256color' });
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = options.columns ?? 80; output.rows = options.rows ?? 24;
  let rendered, written = 0, draws = 0;
  output.on('data', value => { written += value.length; });
  const owned = resources(t);
  if (!owned.conductor) { const conductor = new Conductor({ tickMs: 20 }).start(); owned.conductor = conductor; owned.views.push(() => conductor.stop()); }
  const finished = launchTerminal({ usage: fakeUsage(t), ...options, input, output, refreshMs: 30, startConductor: () => false, onRender: value => { rendered = value; draws += 1; } });
  finished.catch(() => {});
  await until(() => rendered, 'first render');
  const state = { input, output, finished, get current() { return rendered; }, get written() { return written; }, get draws() { return draws; } };
  resources(t).views.push(async () => {
    let closed = false, stopped = false, failure = null; finished.then(() => { closed = true; }, () => { closed = true; });
    if (!rendered.screen.destroyed) Promise.resolve().then(() => rendered.controller?.close()).then(() => { stopped = true; }, error => { failure = error; stopped = true; });
    for (const started = Date.now(); !closed && !rendered.screen.destroyed;) {
      const waited = Date.now() - started;
      if (waited > 10000) { input.destroy(); output.destroy(); throw new Error('The view did not close after its test.'); }
      if (stopped || waited > 3000) {
        rendered.panels.ask.cancel();
        for (const child of [...rendered.screen.children]) { child.dismiss?.(); child.children?.find(item => item.type === 'textbox')?.emit('cancel'); }
        if (waited > 3000) process.emit('SIGHUP');
        else { rendered.panels.chat.focus(); rendered.screen.emit('keypress', 'q', { name: 'q' }); }
      }
      await new Promise(resolve => setTimeout(resolve, stopped ? 20 : 2));
    }
    input.destroy(); output.destroy();
    if (failure) throw failure;
  });
  return state;
}
async function send(v, text) {
  v.current.panels.ask.focus(); v.current.panels.ask.readInput();
  await until(() => v.current.panels.ask.__listener, 'message box');
  v.current.panels.ask.setValue(text); v.current.panels.ask.submit();
}
const rows = v => v.current.panels.board.items.map(item => item.getText());
async function openTask(v, pattern) {
  await until(() => v.current.view === 'tasks' && rows(v).some(row => pattern.test(row)), `row ${pattern}`);
  const board = v.current.panels.board; board.focus(); board.select(rows(v).findIndex(row => pattern.test(row)));
  await until(() => v.current.session, 'the session beside the list');
  v.input.write('\r'); await until(() => v.current.screen.focused === v.current.panels.ask && v.current.session, 'the session open');
}
const sized = async (v, width, height) => { v.output.columns = width; v.output.rows = height; v.output.emit('resize'); await until(() => v.current.screen.width === width && v.current.screen.height === height, `${width} by ${height}`); };
const modal = (v, title) => v.current.screen.children.find(child => !child.destroyed && child.options?.label?.trim() === title);
// A dialog as the screen shows it: the characters inside its box, row by row.
function shown(v, title) {
  const box = modal(v, title); v.current.screen.render();
  return v.current.screen.screenshot(box.aleft, box.aleft + box.width, box.atop, box.atop + box.height).replace(/\x1b\[[\d;]*m/g, '').split('\n').map(row => row.trimEnd()).join('\n');
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sentences = count => Array.from({ length: count }, (_, at) => `Sentence ${at + 1} of the long message.`).join(' ');
const answered = { outcome: 'done', intent: 'answer', summary: 'Answered.', question: null, choices: [], comments: [], responses: [] };
function conversation(p, id, goal) {
  const at = new Date(Date.now() - 60000).toISOString();
  saveTask(p.repo, { id: String(id), kind: 'conversation', goal, state: 'answered', worktree: p.root, branch: null, base: null, createdAt: at, runs: [], reviews: [], responses: [], sessions: {}, result: answered, messages: [{ at, text: goal }] });
}
// Counts the times blessed works out the colours of every line of one pane.
function colourPasses(t) {
  const proto = blessed.widget.Element.prototype, original = proto._parseAttr, counter = { pane: null, count: 0 };
  proto._parseAttr = function(lines) { if (this === counter.pane) counter.count += 1; return original.call(this, lines); };
  t.after(() => { proto._parseAttr = original; });
  return counter;
}

test('the name of a session is read from the start of its message, whatever the length of the rest', () => {
  // The same words as reading the whole message gives, for every shape of white space.
  const whole = (value, width) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    // Counted in columns, as a row is: a wide character takes two, and is never cut in half.
    if (columns(text) <= width) return text;
    const cut = head(text, width - 1), space = cut.lastIndexOf(' '), ends = /[\s,;:.!?]/.test(text[cut.length]);
    return `${(ends || space <= 0 ? cut : cut.slice(0, space)).replace(/[\s,;:.!?-]+$/, '')}…`;
  };
  const parts = ['word', 'a', 'longer-word,', ' ', '  ', '\n', '\t', '\n\n', '.', 'x'.repeat(70), ' '.repeat(5000), 'é', '🙂'];
  let seed = 7; const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 3000; round++) {
    const text = Array.from({ length: 1 + Math.floor(random() * 40) }, () => parts[Math.floor(random() * parts.length)]).join(''), width = 1 + Math.floor(random() * 90);
    assert.equal(firstWords(text, width), whole(text, width), JSON.stringify({ text: text.slice(0, 200), width }));
    assert.equal(firstLine(text), text.split('\n').find(line => line.trim()) ?? '', JSON.stringify(text.slice(0, 200)));
  }
  // One megabyte in one line, asked for as often as an hour of idle ticks asks: it reads the start only.
  const long = sentences(32000), task = { goal: long, messages: [] }, started = Date.now();
  assert.ok(long.length > 1000000);
  for (let round = 0; round < 10000; round++) { firstWords(long, 60); taskTitle(task); }
  const took = Date.now() - started;
  assert.equal(taskTitle(task), 'Sentence 1 of the long message. Sentence 2 of the long…');
  assert.ok(took < 2000, `10,000 titles of a 1 MB message took ${took} ms`);
});

test('with a very long message open, a tick of the idle app does not set, wrap or colour the chat again', { timeout: 60000 }, async t => {
  const passes = colourPasses(t), p = setup(t, 'answer');
  conversation(p, 1, sentences(12000));
  const v = await view(t, { repo: p.repo }), chat = v.current.panels.chat;
  await openTask(v, /Sentence 1 of/);
  await until(() => /\b12000\b/.test(chat.getText()), 'the whole message in the chat', 30000);
  await pause(200);
  let sets = 0; const set = chat.setContent; chat.setContent = function(...args) { sets += 1; return set.apply(this, args); };
  passes.pane = chat; passes.count = 0;
  const wrapped = chat._clines, from = v.draws, written = v.written;
  await until(() => v.draws - from >= 20, 'twenty ticks');
  assert.equal(sets, 0, `the chat was set again ${sets} times in ${v.draws - from} ticks`);
  assert.equal(passes.count, 0, `every line was coloured again ${passes.count} times in ${v.draws - from} ticks`);
  assert.equal(chat._clines, wrapped, 'the wrapped lines are the ones it had');
  // Nothing on screen changed, so nothing is written to the terminal either (a new minute changes the clock).
  assert.ok(v.written - written < 200, `${v.written - written} bytes were written while nothing changed`);
  // A key in the message box draws the screen: the chat's lines are still not gone through again.
  v.current.screen.render(); v.current.screen.render();
  assert.equal(passes.count, 0, 'a draw of the screen colours no line of an unchanged chat again');
  // The text still follows what the session holds: a new width wraps it again, and it is all there.
  await sized(v, 120, 40);
  await until(() => chat._clines !== wrapped && /\b12000\b/.test(chat.getText()), 'wrapped for the new width');
});

test('while a turn runs with a very long message open, a tick sets the chat again only when its text changed', { timeout: 60000 }, async t => {
  const passes = colourPasses(t), p = setup(t, 'slow'), v = await view(t, { repo: p.repo }), chat = v.current.panels.chat;
  await send(v, sentences(12000));
  await until(() => /is working/.test(chat.getText()) && /\b12000\b/.test(chat.getText()), 'the turn at work under the long message', 30000);
  await pause(400);
  let sets = 0; const set = chat.setContent; chat.setContent = function(...args) { sets += 1; return set.apply(this, args); };
  passes.pane = chat; passes.count = 0;
  const from = v.draws, started = Date.now(), text = chat.getText();
  await until(() => Date.now() - started >= 1500 && v.draws - from >= 20, 'a second and a half of the turn');
  const ticks = v.draws - from, changed = chat.getText() !== text;
  // The chat's own text changes when the turn reports a step, never by the clock.
  assert.ok(sets <= 2, `the chat was set ${sets} times in ${ticks} ticks`);
  assert.ok(passes.count <= sets, `every line was coloured again ${passes.count} times for ${sets} new texts`);
  assert.ok(changed || sets === 0, 'the chat is set only when its text changed');
  await send(v, '/stop');
  await until(() => !/is working/.test(chat.getText()), 'the turn stopped', 20000);
});

// A dialog as the screen shows it, with where it is: after a change of the window's size it
// must read as one opened at that size.
const placed = (v, title) => { const box = modal(v, title); return `${box.aleft},${box.atop} ${box.width}x${box.height}\n${shown(v, title)}`; };
async function closed(v, title) {
  const box = modal(v, title); if (box.dismiss) box.dismiss(); else box.children.find(child => child.type === 'textbox')?.emit('cancel');
  await until(() => !modal(v, title), `${title} closed`);
}
async function throughSizes(v, title, open) {
  await sized(v, 140, 50); await open(); await pause(60); const wide = placed(v, title);
  await sized(v, 80, 24); await pause(60); const narrowed = placed(v, title);
  await closed(v, title); await open(); await pause(60);
  assert.equal(narrowed, placed(v, title), `${title}: 140x50 made 80x24 reads as one opened at 80x24`);
  await sized(v, 140, 50); await pause(60);
  assert.equal(placed(v, title), wide, `${title}: 80x24 made 140x50 reads as one opened at 140x50`);
  await closed(v, title);
}

test('a dialog open while the window changes size is laid out again as one opened at that size, both ways', { timeout: 120000 }, async t => {
  const p = setup(t, 'answer'), v = await view(t, { repo: p.repo, columns: 140, rows: 50 });
  // A text with keys, a field with the choices listed under it, and a list with a note over it.
  await throughSizes(v, 'Permissions', async () => { await send(v, '/permissions'); await until(() => modal(v, 'Permissions'), 'Permissions'); });
  await throughSizes(v, 'Model', async () => { await send(v, '/model'); await until(() => modal(v, 'Model'), 'Model'); });
  await throughSizes(v, 'When', async () => { await send(v, '/schedule'); await until(() => modal(v, 'When'), 'When'); });
});

test('the review of a project file open while the window changes size is paged for the new size, both ways', { timeout: 120000 }, async t => {
  const p = setup(t, 'answer'), title = 'New · .elu-code/instructions.md';
  fs.writeFileSync(path.join(p.root, '.elu-code/instructions.md'), `${Array.from({ length: 90 }, (_, at) => `Rule ${at + 1}: keep the answer to rule ${at + 1} short, and say which file of the project it is about.`).join('\n')}\n`);
  const v = await view(t, { repo: p.repo, columns: 140, rows: 50 });
  await throughSizes(v, title, async () => {
    // It opens with the app; put off with Esc, it is asked again before the next message goes.
    if (!modal(v, title) && v.current.panels.status.getText().includes('until you decide')) await send(v, 'hello');
    await until(() => modal(v, title), 'the review');
  });
});

test("a message of any length shows whole in the chat: my own over 512,000 characters, a teammate's over 16,000", { timeout: 90000 }, async t => {
  const p = setup(t, 'answer'), mine = sentences(16000), theirs = `A note from Kai. ${sentences(900)} THE LAST WORDS OF KAI.`, at = new Date(Date.now() - 120000).toISOString(), kai = 'c'.repeat(64);
  assert.ok(mine.length > 512000 && theirs.length > 16000);
  conversation(p, 1, mine);
  // A teammate's message as its session keeps it: the sentence ELU wrote for the model, and their own words.
  const row = { at, from: '@kai', peer: kai, text: 'A message from @kai, a teammate, is in the peer data block.', words: theirs };
  saveTask(p.repo, { id: '2', kind: 'conversation', goal: row.text, state: 'answered', worktree: p.root, branch: null, base: null, createdAt: at, runs: [], reviews: [], responses: [], sessions: {}, result: answered, origin: { peer: kai, name: 'kai', kind: 'work' }, messages: [row] });
  assert.equal(teammateText(row), theirs, 'every character of the teammate\'s words');
  const v = await view(t, { repo: p.repo, columns: 140, rows: 50 }), chat = v.current.panels.chat;
  await openTask(v, /Sentence 1 of/);
  await until(() => /\b16000\b/.test(chat.getText()), 'the last sentence of my message', 40000);
  assert.doesNotMatch(chat.getText(), /Display truncated/);
  v.input.write('\x1b'); await until(() => v.current.screen.focused === v.current.panels.board, 'back in the list');
  await openTask(v, /A note from Kai/);
  await until(() => /THE LAST WORDS OF KAI\./.test(chat.getText().replace(/\s+/g, ' ')), 'the last words of the teammate\'s message', 40000);
});
