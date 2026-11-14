import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis } from './helpers.mjs';
import { Conductor, enqueue } from '../lib/conductor.mjs';
import { conversationEntries, projectSnapshot, registerProject } from '../lib/projects.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import { repository } from '../lib/git.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { stopLine } from '../lib/stop-line.mjs';
import { boardRows, rowTitle } from '../lib/board.mjs';
import { closeSession } from '../lib/kanban.mjs';
import { CAP_CARRIED_LINE, CAP_CARRY_TEXT } from '../lib/turn-limits.mjs';
import { carryOnCapped } from '../lib/carry-on.mjs';

// 0.1.19 and earlier stopped a turn that had run two hours, working or not, and left the
// session waiting for a reply. After the update that session says what stopped it, and in
// Approve for me and Full access ELU carries it on by itself as the app opens, once.
const LIVE = new WeakMap();
after(() => { setTimeout(() => { console.error('carry-on.test: something is still running 10 s after the last test.'); process.exit(1); }, 10000).unref(); });
function setup(t, mode = 'answer') {
  LIVE.set(t, []); t.after(async () => { for (const conductor of LIVE.get(t)) await conductor.stop(); });
  const p = project(t), fake = fakeClis(p.parent, { mode });
  const previous = { PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, HOME: process.env.HOME };
  Object.assign(process.env, fake.env, { HOME: p.parent });
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const repo = repository(p.root); registerProject(repo);
  const calls = () => fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.vendor === 'claude' && call.args.includes('-p')) : [];
  const inputs = () => fs.readFileSync(path.join(p.parent, 'inputs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.vendor === 'claude');
  return { ...p, ...fake, repo, calls, inputs };
}
function conduct(t) { const conductor = new Conductor({ tickMs: 20 }).start(); LIVE.get(t).push(conductor); return conductor; }
async function until(check, message, timeout = 20000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const request = (root, id) => pendingRequests(root).find(row => row.id === id);
// A session with one answered turn, then a second message whose turn 0.1.19 stopped at its
// cap: the record as that version left it.
async function capStopped(t, p, mode) {
  const sent = enqueue(p.root, 'Review the coupon code', { permissions: mode });
  await until(() => request(p.root, sent.id)?.state === 'done', `the first turn in ${mode}`);
  const id = request(p.root, sent.id).taskId, task = readTask(p.repo, id), log = path.join(path.dirname(task.runs[0].logFile), 'lead-capped.log');
  fs.writeFileSync(log, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Still reviewing.' }] } })}\n`);
  const at = new Date().toISOString();
  task.messages.push({ at, text: 'Go through every file' });
  task.runs.push({ role: 'lead', vendor: 'claude', logFile: log, code: null, session: task.runs[0].session, startedAt: at, at, permissions: mode });
  Object.assign(task, { state: 'blocked', activeRole: null, activeLog: null, error: { message: 'Stopped after 2 hours, the most one turn may run. Reply to carry on.', cause: 'time-limit', logFile: log, timedOut: true, stoppedBy: 'cap' } });
  saveTask(p.repo, task);
  return id;
}
const rowOf = (p, id) => { const snapshot = projectSnapshot(p.repo), row = boardRows([snapshot]).find(row => row.kind === 'task' && row.id === id); return { title: rowTitle(row), now: row.now }; };

test('a session 0.1.19 stopped at its cap says so in its row and its chat, and in Full access or Approve for me ELU carries it on once as the app opens', async t => {
  const p = setup(t); conduct(t);
  for (const mode of ['full', 'auto']) {
    const id = await capStopped(t, p, mode), before = p.calls().length;
    // As the update finds it: the line under its chat, and its row.
    assert.equal(stopLine(readTask(p.repo, id)).text, 'Stopped by a time limit an earlier version had. Reply to carry on.');
    assert.match(rowOf(p, id).title, / · reply to carry on$/); assert.equal(rowOf(p, id).now, 'Stopped by a time limit an earlier version had. Reply to carry on.');
    // The app opens.
    assert.equal(carryOnCapped({ enqueue }), 1, mode);
    await until(() => readTask(p.repo, id).state === 'answered', `the carried on turn in ${mode}`);
    const task = readTask(p.repo, id);
    assert.equal(task.error, null); assert.equal(stopLine(task), null);
    assert.equal(task.messages.filter(row => row.text === CAP_CARRY_TEXT).length, 1, 'sent once');
    assert.equal(p.calls().length - before, 1, 'one turn carried it on');
    assert.match(p.inputs().at(-1).input, /Carry on where you stopped\. \(ELU sent this, not the owner/, 'the model is told who wrote it');
    // The chat says so in one line of ELU's, where the message was sent, and never as the owner's.
    const entries = conversationEntries(p.repo, task), said = entries.filter(entry => entry.role === 'ELU');
    assert.deepEqual(said.map(entry => [entry.text, entry.line]), [[CAP_CARRIED_LINE, true]]); assert.equal(CAP_CARRIED_LINE, 'Stopped by a time limit an earlier version had. ELU told it to carry on.');
    assert.equal(entries.some(entry => entry.role === 'You' && entry.text === CAP_CARRY_TEXT), false);
    assert.ok(entries.indexOf(said[0]) > entries.findIndex(entry => entry.text === 'Go through every file'), 'after the message whose turn was stopped');
    // The app opens again: nothing more is carried on.
    assert.equal(carryOnCapped({ enqueue }), 0, `${mode}: once`);
  }
});

test('carried on once: a second window, or the app opened again before the turn started, sends nothing more', async t => {
  const p = setup(t), first = conduct(t), id = await capStopped(t, p, 'full');
  await first.stop(); LIVE.get(t).length = 0;
  const sent = [], queue = (...args) => { sent.push(args); return enqueue(...args); };
  assert.equal(carryOnCapped({ enqueue: queue }), 1); assert.equal(carryOnCapped({ enqueue: queue }), 0); assert.equal(carryOnCapped({ enqueue: queue }), 0);
  assert.deepEqual(sent, [[p.root, CAP_CARRY_TEXT, { continuationTaskId: id, priority: 0 }]]);
  assert.equal(pendingRequests(p.root).filter(row => row.state === 'queued' && row.continuationTaskId === id).length, 1);
  // It still waits for its turn, and reads as it did until that starts.
  assert.equal(stopLine(readTask(p.repo, id)).text, 'Stopped by a time limit an earlier version had. Reply to carry on.');
  conduct(t);
  await until(() => readTask(p.repo, id).state === 'answered', 'the carried on turn');
});

test('in Ask for approval and Read only a session stopped at the cap waits for a reply; so do one the owner archived, a teammate\'s, and one stopped for any other reason', async t => {
  const p = setup(t), conductor = conduct(t);
  const ask = await capStopped(t, p, 'ask'), quiet = await capStopped(t, p, 'full'), theirs = await capStopped(t, p, 'full'), locked = await capStopped(t, p, 'full'), archived = await capStopped(t, p, 'auto');
  await conductor.stop(); LIVE.get(t).length = 0;
  const change = (id, fields) => { const task = readTask(p.repo, id); Object.assign(task, fields); saveTask(p.repo, task); };
  // Stopped by the quiet limit, which this version still has: the owner's reply carries it on.
  change(quiet, { error: { message: 'Stopped after 10 minutes with no output. Reply to carry on.', cause: 'quiet', timedOut: true, stoppedBy: 'quiet' } });
  change(theirs, { origin: { kind: 'handoff', peer: 'b'.repeat(64), name: 'sara', threadId: 'thread-1', own: true } });
  { const task = readTask(p.repo, locked); delete task.permissions; saveTask(p.repo, task); }
  await new Promise(resolve => setTimeout(resolve, 5)); closeSession(p.repo, archived);
  const sent = [];
  assert.equal(carryOnCapped({ enqueue: (...args) => { sent.push(args); } }), 0); assert.deepEqual(sent, []);
  for (const id of [ask, theirs, locked, archived]) assert.equal(stopLine(readTask(p.repo, id)).text, 'Stopped by a time limit an earlier version had. Reply to carry on.', id);
  assert.equal(stopLine(readTask(p.repo, quiet)).text, 'Stopped after 10 minutes with no output. Reply to carry on.');
  // The owner gives the first one Full access: the app's next open carries it on.
  change(ask, { permissions: 'full' });
  assert.equal(carryOnCapped({ enqueue: (...args) => { sent.push(args); } }), 1); assert.deepEqual(sent.map(args => args[2].continuationTaskId), [ask]);
});
