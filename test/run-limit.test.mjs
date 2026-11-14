import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { dashboardSnapshot, projectSnapshot, registerProject } from '../lib/projects.mjs';
import { pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { Conductor, DEFAULT_SETTINGS, conductorSettings, enqueue, retryRequest, saveConductorSettings, sendCommand } from '../lib/conductor.mjs';
import { boardRows, boardSections, rowTitle } from '../lib/board.mjs';
import { cleanWait, waitOf, waitText, waitingText } from '../lib/waiting.mjs';
import { personalDirectory } from '../lib/util.mjs';

// How many sessions run at once is one number, the one /slots sets, for one project as for
// several, and a message that waits says what it waits for.

// A test's conductors are stopped before its folder is removed (as in conductor.test.mjs).
const LIVE = new WeakMap(), STOP_MS = 20000;
function giveUp(message) { console.error(`run-limit.test: ${message} Ending the test process.`); process.exit(1); }
async function stopAll(t) {
  for (const conductor of LIVE.get(t) ?? []) {
    const late = setTimeout(() => giveUp(`A conductor did not stop within ${STOP_MS / 1000} s.`), STOP_MS);
    try { await conductor.stop(); } finally { clearTimeout(late); }
  }
}
after(() => { setTimeout(() => giveUp('Something is still running 10 s after the last test.'), 10000).unref(); });
function setup(t, mode = 'slow') {
  LIVE.set(t, []); t.after(() => stopAll(t));
  const p = project(t), fake = fakeClis(p.parent, { mode });
  const previous = { PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  Object.assign(process.env, fake.env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const repo = repository(p.root); registerProject(repo);
  return { ...p, ...fake, repo };
}
function conduct(t, options = {}) { const conductor = new Conductor({ tickMs: 20, ...options }).start(); LIVE.get(t).push(conductor); return conductor; }
async function until(check, message, timeout = 30000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = (root, id) => pendingRequests(root).find(row => row.id === id);
const states = (root, rows) => rows.map(row => request(root, row.id)?.state);

const SLOT = (running, limit) => `Waiting for a free slot: ${running} of ${limit} sessions are running. /slots changes it.`;
// The Queued heading and its rows, as Sessions lists them.
function queued(now = Date.now()) {
  const rows = boardRows(dashboardSnapshot().projects, now), lines = boardSections(rows);
  return { said: lines.find(line => line.header === 'Queued')?.said ?? null, titles: rows.filter(row => row.group === 2).map(row => rowTitle(row, now)) };
}

test('with /slots 6, six sessions of one project run at once and the seventh waits, saying what for', async t => {
  const p = setup(t); saveConductorSettings({ maxAgents: 6 });
  const rows = Array.from({ length: 6 }, (_, index) => enqueue(p.root, `Session ${index + 1}`));
  const conductor = conduct(t);
  await until(() => states(p.root, rows).every(state => state === 'running'), 'six sessions of one project to run at once');
  assert.equal(conductor.runs.size, 6);
  assert.deepEqual([...new Set([...conductor.runs.values()].map(run => run.root))], [p.root], 'all six in the one project');
  assert.equal(projectSnapshot(p.repo).tasks.filter(task => task.state === 'running').length, 6);
  // The seventh waits, and says what for: in the request (the chat reads it), as its reason, and in Sessions.
  const seventh = enqueue(p.root, 'Session 7', { priority: 1 });
  await until(() => request(p.root, seventh.id)?.waits, 'the seventh to be told what it waits for');
  await pause(200);
  assert.equal(request(p.root, seventh.id).state, 'queued'); assert.equal(conductor.runs.size, 6);
  assert.deepEqual(request(p.root, seventh.id).waits, { on: 'slot', running: 6, limit: 6 });
  assert.equal(waitingText(request(p.root, seventh.id)), SLOT(6, 6));
  assert.equal(request(p.root, seventh.id).reason, SLOT(6, 6), 'a window of an earlier version shows the reason');
  assert.deepEqual(queued(), { said: ['6 of 6 running', '6 of 6'], titles: ['Session 7'] });
  // When a slot frees, what waits starts by priority, then age: a message typed after the seventh, with a higher priority, goes first.
  const eighth = enqueue(p.root, 'Session 8', { priority: 1 }), typed = enqueue(p.root, 'Session 9', { priority: 0 });
  await until(() => request(p.root, eighth.id)?.waits && request(p.root, typed.id)?.waits, 'both to be told');
  const id = request(p.root, rows[0].id).taskId;
  sendCommand({ type: 'stop', root: p.root, taskId: id });
  await until(() => request(p.root, typed.id)?.state === 'running', 'the typed message to take the free slot');
  assert.equal(request(p.root, typed.id).waits, undefined, 'one that started waits for nothing');
  assert.deepEqual([request(p.root, seventh.id).state, request(p.root, eighth.id).state], ['queued', 'queued']);
  const next = request(p.root, rows[1].id).taskId;
  sendCommand({ type: 'stop', root: p.root, taskId: next });
  await until(() => request(p.root, seventh.id)?.state === 'running', 'the older of the two to start next');
  assert.equal(request(p.root, eighth.id).state, 'queued');
  assert.equal(waitingText(request(p.root, eighth.id)), SLOT(6, 6));
  // One that was blocked and is sent again starts with nothing kept of its earlier wait, until the conductor passes it over again.
  updateRequest(p.root, eighth.id, { state: 'blocked', reason: 'It could not start.' });
  assert.equal(waitOf(request(p.root, eighth.id)), null, 'one that is not queued waits for nothing');
  const again = retryRequest(p.root, eighth.id);
  assert.deepEqual([again.state, again.reason, again.waits], ['queued', 'Waiting to start.', undefined]);
  await until(() => request(p.root, eighth.id)?.reason === SLOT(6, 6), 'the eighth to be told again');
});

test('8 sessions run at once until /slots says otherwise, and a number saved before stays as saved', async t => {
  const p = setup(t);
  assert.equal(DEFAULT_SETTINGS.maxAgents, 8);
  assert.equal(conductorSettings().maxAgents, 8, 'nothing saved: 8');
  // What /slots 4 saved on 0.1.19.
  const file = path.join(personalDirectory(), 'conductor', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ maxAgents: 4, stallMinutes: 8, retries: 1 }));
  assert.equal(conductorSettings().maxAgents, 4, 'a saved 4 is kept');
  // With it, four sessions of the project run and the fifth says so.
  const rows = Array.from({ length: 5 }, (_, index) => enqueue(p.root, `Session ${index + 1}`));
  conduct(t);
  await until(() => states(p.root, rows).filter(state => state === 'running').length === 4 && request(p.root, rows[4].id)?.waits, 'four to run and the fifth to be told');
  assert.deepEqual(states(p.root, rows), ['running', 'running', 'running', 'running', 'queued']);
  assert.equal(waitingText(request(p.root, rows[4].id)), SLOT(4, 4));
  // /slots 8 starts it: no other limit holds a project at four.
  assert.equal(saveConductorSettings({ maxAgents: 8 }).maxAgents, 8);
  await until(() => request(p.root, rows[4].id)?.state === 'running', 'the fifth session of the project to run');
  assert.throws(() => saveConductorSettings({ maxAgents: 17 }), { message: 'Choose 1 to 16 sessions at once.' });
});

test('a follow-up says it waits for its session\'s current turn, and one held until later says when it tries again', async t => {
  const p = setup(t), first = enqueue(p.root, 'Session 1');
  conduct(t);
  await until(() => request(p.root, first.id)?.state === 'running', 'the session to work');
  const id = request(p.root, first.id).taskId;
  // A follow-up that changes the session's mode is a turn of its own: it waits for the turn that works.
  const next = enqueue(p.root, 'Go on', { continuationTaskId: id, permissions: 'auto' });
  await until(() => request(p.root, next.id)?.waits, 'the follow-up to be told what it waits for');
  assert.deepEqual(request(p.root, next.id).waits, { on: 'turn' });
  assert.equal(waitingText(request(p.root, next.id)), "Waiting for this session's current turn to end.");
  assert.equal(request(p.root, next.id).reason, 'Waiting to start.', 'its reason stays the running turn\'s to write');
  assert.deepEqual(queued(), { said: null, titles: ['after this turn · Go on'] });
  // A request held until a time (a retry after a stall) says why and when, whatever it waited for before.
  const now = Date.now(), held = updateRequest(p.root, next.id, { notBefore: new Date(now + 30000).toISOString(), reason: 'It stopped making progress. Retrying.' });
  assert.deepEqual(waitOf(held, now), { on: 'time', until: new Date(now + 30000).toISOString(), why: 'It stopped making progress.' });
  assert.equal(waitingText(held, now), 'It stopped making progress. It tries again in 30s.');
  assert.equal(waitingText({ ...held, reason: 'Rate limited. Retrying shortly.' }, now + 29500), 'Rate limited. It tries again in 1s.');
  assert.equal(waitingText({ ...held, notBefore: new Date(now + 600000).toISOString() }, now), 'It stopped making progress. It tries again in 10m.');
  assert.deepEqual(queued(now).titles, ['retry 30s · Go on']);
});

test('each wait has one sentence, and what another computer sends is read field by field', () => {
  assert.equal(waitText({ on: 'slot', running: 4, limit: 4 }), 'Waiting for a free slot: 4 of 4 sessions are running. /slots changes it.');
  assert.equal(waitText({ on: 'slot', running: 1, limit: 1 }), 'Waiting for a free slot: 1 of 1 session is running. /slots changes it.');
  // /slots was lowered while more ran: nothing is interrupted, so more run than may start.
  assert.equal(waitText({ on: 'slot', running: 6, limit: 2 }), 'Waiting for a free slot: 6 sessions are running, and 2 run at once. /slots changes it.');
  assert.equal(waitText({ on: 'turn' }), "Waiting for this session's current turn to end.");
  assert.equal(waitText({ on: 'teammates', running: 1, limit: 1 }), 'Waiting for a free teammate slot: 1 of 1 is in use.');
  assert.equal(waitText({ on: 'teammates', running: 0, limit: 0 }), "Waiting: no slot is set for teammates' work on this computer.");
  assert.equal(waitText(null), null);
  // A request the conductor has not looked at yet, and one that is no longer queued.
  assert.equal(waitingText({ state: 'queued', reason: 'Waiting to start.' }), 'Waiting to start.');
  assert.equal(waitOf({ state: 'running', waits: { on: 'slot', running: 4, limit: 4 } }), null);
  // One the running turn has on its input is read after that turn's current command, as its reason says: it does not wait for the turn to end.
  const taken = { state: 'queued', continuationTaskId: '1', turn: { run: 'run-1', uuid: 'a' }, reason: 'Waiting for the current command to finish.', waits: { on: 'turn' } };
  assert.equal(waitOf(taken), null); assert.equal(waitingText(taken), 'Waiting for the current command to finish.');
  for (const value of [{ on: 'slot', running: '4', limit: 4 }, { on: 'slot', running: 4 }, { on: 'slot', running: -1, limit: 4 }, { on: 'other' }, { on: 'time', until: 'soon' }, 'slot', null]) assert.equal(cleanWait(value), null, JSON.stringify(value));
  assert.deepEqual(cleanWait({ on: 'slot', running: 4, limit: 4, more: 'x' }), { on: 'slot', running: 4, limit: 4 });
  assert.deepEqual(cleanWait({ on: 'time', until: '2026-11-13T10:00:00Z', why: 'Rate\u001b[31m limited.\n' }), { on: 'time', until: '2026-11-13T10:00:00.000Z', why: 'Rate limited.' });
});
