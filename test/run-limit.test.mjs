import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, cli, git } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { dashboardSnapshot, projectSnapshot, registerProject } from '../lib/projects.mjs';
import { ownerTyped, pendingRequests, removeRequest, updateRequest } from '../lib/workspace.mjs';
import { Conductor, DEFAULT_SETTINGS, conductorSettings, enqueue, retryRequest, saveConductorSettings, sendCommand } from '../lib/conductor.mjs';
import { boardRows, boardSections, rowTitle } from '../lib/board.mjs';
import { SLOTS_RULE, SLOTS_RULE_UNSET, cleanWait, waitOf, waitShort, waitText, waitingText } from '../lib/waiting.mjs';
import { personalDirectory, readJson } from '../lib/util.mjs';
import * as v19 from './fixtures/conductor-0.1.19/conductor.mjs';
import { saveBot } from '../lib/bots.mjs';
import { saveSchedule, pauseSchedule, runDue, runScheduleNow, parseWhen } from '../lib/schedules.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { createTeam } from '../lib/peer/roster.mjs';
import { createInvite, redeemCode } from '../lib/peer/invite.mjs';
import { share } from '../lib/peer/shares.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { message } from '../lib/peer/a2a.mjs';
import { intakeMethods } from '../lib/peer/intake.mjs';
import { acceptIncoming } from '../lib/peer/replies.mjs';
import { getRecord } from '../lib/peer/taskstore.mjs';

// Nothing limits how many sessions run at once until the owner sets a limit with /slots. A
// limit he set is one number, for one project as for several, and a message that waits for
// it says what it waits for. A limit holds back only what starts by itself: what the owner
// types himself starts whatever runs.

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
  const p = project(t), fake = fakeClis(p.parent, typeof mode === 'string' ? { mode } : mode);
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
  // When a slot frees, what waits starts by priority, then age: one queued after the seventh, with a higher priority, goes first.
  const eighth = enqueue(p.root, 'Session 8', { priority: 1 }), typed = enqueue(p.root, 'Session 9', { priority: 0 });
  await until(() => request(p.root, eighth.id)?.waits && request(p.root, typed.id)?.waits, 'both to be told');
  const id = request(p.root, rows[0].id).taskId;
  sendCommand({ type: 'stop', root: p.root, taskId: id });
  await until(() => request(p.root, typed.id)?.state === 'running', 'the one with the higher priority to take the free slot');
  assert.equal(request(p.root, typed.id).waits, undefined, 'one that started waits for nothing');
  assert.deepEqual([request(p.root, seventh.id).state, request(p.root, eighth.id).state], ['queued', 'queued']);
  const next = request(p.root, rows[1].id).taskId;
  sendCommand({ type: 'stop', root: p.root, taskId: next });
  await until(() => request(p.root, seventh.id)?.state === 'running', 'the older of the two to start next');
  assert.equal(request(p.root, eighth.id).state, 'queued');
  assert.equal(waitingText(request(p.root, eighth.id)), SLOT(6, 6));
  // One that was blocked and that the owner sends again with its key is his own now: nothing is kept of its earlier wait, and it starts past the six.
  updateRequest(p.root, eighth.id, { state: 'blocked', reason: 'It could not start.' });
  assert.equal(waitOf(request(p.root, eighth.id)), null, 'one that is not queued waits for nothing');
  const again = retryRequest(p.root, eighth.id);
  assert.deepEqual([again.state, again.reason, again.waits, again.typed], ['queued', 'Waiting to start.', undefined, true]);
  await until(() => request(p.root, eighth.id)?.state === 'running', 'the eighth to start past the six');
  assert.equal(conductor.runs.size, 7);
});

const settingsFile = () => path.join(personalDirectory(), 'conductor', 'settings.json');

test('with nothing set, twelve sessions of one project run at once and none waits', async t => {
  const p = setup(t);
  const rows = Array.from({ length: 12 }, (_, index) => enqueue(p.root, `Session ${index + 1}`));
  const conductor = conduct(t);
  await until(() => states(p.root, rows).every(state => state === 'running') || rows.some(row => request(p.root, row.id)?.waits), 'twelve sessions of one project to run at once, or one to be told to wait', 60000);
  assert.deepEqual(rows.map(row => request(p.root, row.id).waits), Array(12).fill(undefined), 'none is told to wait');
  assert.deepEqual(states(p.root, rows), Array(12).fill('running'));
  assert.equal(conductor.runs.size, 12);
  assert.equal(projectSnapshot(p.repo).tasks.filter(task => task.state === 'running').length, 12);
  // Sessions has no Queued heading, so nothing says "of" a number.
  assert.deepEqual(queued(), { said: null, titles: [] });
  assert.equal(DEFAULT_SETTINGS.maxAgents, null); assert.equal(conductorSettings().maxAgents, null);
  assert.equal(fs.existsSync(settingsFile()), false, 'nothing is saved for it');
});

test('/slots 3 holds the fourth session with the sentence, /slots off starts it, and any whole number from 1 is taken', async t => {
  const p = setup(t);
  assert.equal(saveConductorSettings({ maxAgents: 3 }).maxAgents, 3);
  const rows = Array.from({ length: 4 }, (_, index) => enqueue(p.root, `Session ${index + 1}`));
  const conductor = conduct(t);
  await until(() => states(p.root, rows).filter(state => state === 'running').length === 3 && request(p.root, rows[3].id)?.waits, 'three to run and the fourth to be told');
  assert.deepEqual(states(p.root, rows), ['running', 'running', 'running', 'queued']);
  assert.deepEqual(request(p.root, rows[3].id).waits, { on: 'slot', running: 3, limit: 3 });
  assert.equal(waitingText(request(p.root, rows[3].id)), SLOT(3, 3));
  assert.deepEqual(queued(), { said: ['3 of 3 running', '3 of 3'], titles: ['Session 4'] });
  // /slots off: the limit goes, and what waited for it starts.
  assert.equal(saveConductorSettings({ maxAgents: null }).maxAgents, null);
  await until(() => request(p.root, rows[3].id)?.state === 'running', 'the fourth to start once the limit is removed');
  assert.equal(request(p.root, rows[3].id).waits, undefined);
  assert.equal(conductor.runs.size, 4);
  assert.deepEqual(queued(), { said: null, titles: [] });
  // A limit has no upper bound of ours.
  assert.equal(saveConductorSettings({ maxAgents: 40 }).maxAgents, 40);
  assert.equal(saveConductorSettings({ maxAgents: 100000 }).maxAgents, 100000);
  for (const value of [0, -1, 1.5, '3', NaN, Infinity]) assert.throws(() => saveConductorSettings({ maxAgents: value }), { message: 'Choose a whole number of sessions from 1 up, or no limit.' }, String(value));
  assert.equal(conductorSettings().maxAgents, 100000, 'a refused number changes nothing');
});

// Up to 0.1.21 four ran at once from the default in the code. The settings file was written
// only by /slots, so that 4 was never saved: a number in the file is one the owner typed.
test('the four an earlier version ran at once without /slots does not limit after the update, and a number typed there with /slots does', async t => {
  const p = setup(t);
  // 0.1.19 with nothing typed: four at once, and no file.
  assert.equal(v19.conductorSettings().maxAgents, 4);
  assert.equal(fs.existsSync(settingsFile()), false);
  const rows = Array.from({ length: 6 }, (_, index) => enqueue(p.root, `Session ${index + 1}`));
  const conductor = conduct(t);
  await until(() => states(p.root, rows).every(state => state === 'running') || rows.some(row => request(p.root, row.id)?.waits), 'six sessions to run at once, or one to be told to wait');
  assert.deepEqual(states(p.root, rows), Array(6).fill('running'), 'the earlier default holds nothing back');
  assert.equal(conductorSettings().maxAgents, null);
  // What /slots 4 saved on 0.1.19: every setting, in the one file. It is his choice and stays.
  v19.saveConductorSettings({ maxAgents: 4 });
  assert.deepEqual(readJson(settingsFile()), { maxAgents: 4, stallMinutes: 8, retries: 1 });
  assert.equal(conductorSettings().maxAgents, 4);
  const seventh = enqueue(p.root, 'Session 7');
  await until(() => request(p.root, seventh.id)?.waits, 'the seventh to be told what it waits for');
  await pause(200);
  assert.equal(request(p.root, seventh.id).state, 'queued'); assert.equal(conductor.runs.size, 6);
  assert.deepEqual(request(p.root, seventh.id).waits, { on: 'slot', running: 6, limit: 4 });
  assert.equal(waitingText(request(p.root, seventh.id)), 'Waiting for a free slot: 6 sessions are running, and 4 run at once. /slots changes it.');
  // With no limit, saving the settings writes none: the file says so, and an earlier version reads its own default from it.
  assert.equal(saveConductorSettings({ maxAgents: null }).maxAgents, null);
  assert.deepEqual(readJson(settingsFile()), { maxAgents: null, stallMinutes: 8, retries: 1 });
  assert.equal(saveConductorSettings({ retries: 2 }).maxAgents, null, 'saving another setting sets no limit');
  assert.equal(v19.conductorSettings().maxAgents, 4);
  await until(() => request(p.root, seventh.id)?.state === 'running', 'the seventh to start');
  // A number above the 16 an earlier version took is a limit here, and that version reads its default.
  assert.equal(saveConductorSettings({ maxAgents: 40 }).maxAgents, 40);
  assert.equal(v19.conductorSettings().maxAgents, 4);
});

// A run started from the command line holds to the same rule: no limit until one is set.
test('elu run starts beside twelve running sessions when no limit is set, and is refused at a limit the owner set', { timeout: 120000 }, async t => {
  const p = setup(t, 'normal'), env = { ...p.env };
  assert.equal(cli(p.root, ['init', '--yes'], env).status, 0);
  git(p.root, ['add', '.']); git(p.root, ['commit', '-m', 'Configure checks']);
  // Twelve sessions of the project that work now.
  for (let id = 1; id <= 12; id += 1) {
    const dir = path.join(p.repo.state, 'tasks', String(id)); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ id: String(id), kind: 'conversation', state: 'running', worktree: p.root, base: null, branch: null, goal: `Session ${id}`, createdAt: new Date().toISOString(), messages: [], runs: [], sessions: {} }));
  }
  assert.equal(projectSnapshot(p.repo).tasks.filter(task => task.state === 'running').length, 12);
  const run = cli(p.root, ['run', 'Normalize coupon codes', '--yes'], env);
  assert.equal(run.status, 0, run.stdout + run.stderr); assert.equal(run.json.state, 'ready', run.stdout);
  // With a limit of 12, the thirteenth is refused, with the number.
  saveConductorSettings({ maxAgents: 12 });
  const refused = cli(p.root, ['run', 'Normalize coupon codes again', '--yes'], env);
  assert.notEqual(refused.status, 0);
  assert.equal(refused.json.message, 'At most 12 sessions run at once. /slots in ELU changes it.', refused.stdout);
  saveConductorSettings({ maxAgents: 1 });
  assert.equal(cli(p.root, ['run', 'Normalize coupon codes again', '--yes'], env).json.message, 'At most 1 session runs at once. /slots in ELU changes it.');
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
  assert.equal(waitText({ on: 'teammates', running: 3, limit: 2 }), 'Waiting for a free teammate slot: 3 are in use, and 2 run at once.');
  assert.equal(waitText({ on: 'teammates', running: 0, limit: 0 }), "Waiting: no slot is set for teammates' work on this computer.");
  assert.equal(waitText(null), null);
  // No limit: there is no number to say "of", so there is no sentence, no heading and nothing to send.
  for (const value of [{ on: 'slot', running: 3, limit: null }, { on: 'slot', running: 3, limit: 0 }, { on: 'slot', running: 3 }]) { assert.equal(cleanWait(value), null, JSON.stringify(value)); assert.equal(waitText(value), null); assert.equal(waitShort(value), null); }
  // A limit of any size is said.
  assert.equal(waitText({ on: 'slot', running: 40000, limit: 40000 }), 'Waiting for a free slot: 40000 of 40000 sessions are running. /slots changes it.');
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

// ---- What the owner types starts whatever runs; the number holds back what starts by itself ----

const OVER = (running, limit) => `Waiting for a free slot: ${running} sessions are running, and ${limit} ${limit === 1 ? 'runs' : 'run'} at once. /slots changes it.`;
// A turn in Full access works until the test ends (its command waits for a file that never
// comes); every other turn answers at once.
function fullWorks(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'run-limit-gate-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { mode: 'answer', byMode: { bypassPermissions: { mode: 'live', gate: path.join(dir, 'go'), live: { seconds: 0, think: 40 } } } };
}
// A run a schedule starts (lib/schedules.mjs): nobody typed it.
const nightly = n => ({ priority: 1, scheduleId: `schedule-${String(n).padStart(8, '0')}`, permissions: 'full' });
const KEY = 'a'.repeat(64);
const teammate = (kind = 'ask', more = {}) => ({ origin: { kind, peer: KEY, name: 'sara', a2aTaskId: 'task-1', threadId: 'thread-1', hop: 1, ...more }, context: 'Where are coupon codes normalized?', ...(kind === 'handoff' ? { permissions: 'ask' } : { readOnly: true }) });
// The conductor's dispatch with what runs given, and nothing started: pass() says which
// waiting requests it would start now, by their goals, and tells the rest what they wait for.
function dispatcher(t, running = []) {
  const p = setup(t), conductor = new Conductor(), started = [];
  const run = (more = {}) => conductor.runs.set(`run-${conductor.runs.size}`, { root: p.root, taskId: String(900 + conductor.runs.size), ...more });
  running.forEach(run);
  conductor.launch = (repo, row) => started.push(row.goal);
  return { ...p, conductor, run, pass() { started.length = 0; conductor.dispatch(); return [...started].sort(); } };
}

test('with /slots 8 and eight scheduled runs working, his message to a ninth session at rest starts at once, and a scheduled run that comes due then waits and says why', async t => {
  const p = setup(t, fullWorks(t)), first = enqueue(p.root, 'Explain the coupon codes');
  assert.equal(saveConductorSettings({ maxAgents: 8 }).maxAgents, 8);
  const conductor = conduct(t);
  await until(() => request(p.root, first.id)?.state === 'done', 'the ninth session to answer');
  const ninth = request(p.root, first.id).taskId;
  const runs = Array.from({ length: 8 }, (_, index) => enqueue(p.root, `Nightly check ${index + 1}`, nightly(index + 1)));
  await until(() => states(p.root, runs).every(state => state === 'running'), 'eight scheduled runs to work');
  assert.equal(conductor.runs.size, 8);
  // His message to the session at rest starts at once, past the eight, and is answered.
  const typed = enqueue(p.root, 'And the tests?', { continuationTaskId: ninth, priority: 0, typed: true });
  await until(() => request(p.root, typed.id)?.state === 'done', 'his message to be answered while all eight still work', 15000);
  assert.deepEqual(states(p.root, runs), Array(8).fill('running'), 'nothing of the eight ended for it');
  // So does a new session he starts.
  const fresh = enqueue(p.root, 'Tidy the login form', { priority: 0, permissions: 'full', typed: true });
  await until(() => request(p.root, fresh.id)?.state === 'running', 'his new session to work as the ninth', 15000);
  assert.equal(conductor.runs.size, 9);
  // A scheduled run that comes due now waits, and says why with the number that really runs: in
  // the request (its chat reads it), as its reason, and in Sessions.
  const due = enqueue(p.root, 'Nightly check 9', nightly(9));
  await until(() => request(p.root, due.id)?.waits, 'the scheduled run to be told what it waits for');
  await pause(200);
  assert.equal(request(p.root, due.id).state, 'queued'); assert.equal(conductor.runs.size, 9);
  assert.deepEqual(request(p.root, due.id).waits, { on: 'slot', running: 9, limit: 8 });
  assert.equal(waitingText(request(p.root, due.id)), OVER(9, 8));
  assert.equal(request(p.root, due.id).reason, OVER(9, 8));
  assert.deepEqual(queued(), { said: ['9 running, 8 at once', '8 at once'], titles: ['Nightly check 9'] });
  // The same message with nobody's hand in it waits like the scheduled run: a session's own tool or a program sent it.
  const unasked = enqueue(p.root, 'And the lint?', { continuationTaskId: ninth, priority: 0 });
  await until(() => request(p.root, unasked.id)?.waits, 'the unasked message to be told');
  assert.equal(waitingText(request(p.root, unasked.id)), OVER(9, 8));
  // A follow-up of his to a session whose turn works still waits for that turn, not for a slot.
  const next = enqueue(p.root, 'Use the short form', { continuationTaskId: request(p.root, fresh.id).taskId, priority: 0, permissions: 'auto', typed: true });
  await until(() => request(p.root, next.id)?.waits, 'the follow-up to be told what it waits for');
  assert.deepEqual(request(p.root, next.id).waits, { on: 'turn' });
  assert.equal(waitingText(request(p.root, next.id)), "Waiting for this session's current turn to end.");
});

test('the number holds back only what starts by itself: each kind the owner makes himself starts past it, and each kind nobody typed waits for a slot', t => {
  const p = dispatcher(t, [{}, {}]); saveConductorSettings({ maxAgents: 2 });
  saveBot({ name: 'sec', vendor: 'claude', instructions: 'Review the change for leaked secrets.' });
  // What he does himself, here or on his other computer.
  const mine = [
    enqueue(p.root, 'A new session he starts', { priority: 0, permissions: 'ask', typed: true }),
    enqueue(p.root, 'A message to a session at rest', { continuationTaskId: '11', priority: 0, typed: true }),
    enqueue(p.root, 'His answer to its question', { continuationTaskId: '12', priority: 0, typed: true }),
    enqueue(p.root, 'Approved the Task: Uppercase coupons', { continuationTaskId: '13', priority: 0, approved: true }),
    enqueue(p.root, 'A session from his other computer', { priority: 0, permissions: 'ask', mine: { machine: KEY, name: 'laptop', remoteId: 'session-1' } }),
    enqueue(p.root, 'A standup he asks for', { priority: 0, permissions: 'ask', standup: true }),
    enqueue(p.root, 'A schedule he runs now with its key', { ...nightly(3), typed: true }),
    enqueue(p.root, 'A bot he runs now with /bots run', { continuationTaskId: '15', bot: 'sec', scheduled: true, priority: 1, typed: true }),
    enqueue(p.root, 'Continue with the answer he pressed c on', { continuationTaskId: '14', priority: 0, readOnly: true, origin: { kind: 'answer', peer: KEY, name: 'sara', a2aTaskId: 'task-2', threadId: 'thread-2', hop: 0 }, context: 'In src/coupon.mjs.', typed: true }),
  ];
  // What nobody typed just now.
  const unasked = [
    enqueue(p.root, 'A scheduled run', nightly(1)),
    enqueue(p.root, "A bot's scheduled turn", { continuationTaskId: '21', bot: 'sec', scheduled: true, priority: 1 }),
    enqueue(p.root, "A helper's turn by itself", { continuationTaskId: '22', priority: 0 }),
    enqueue(p.root, 'A program on this computer', { permissions: 'ask' }),
    enqueue(p.root, "A teammate's question", teammate('ask')),
    enqueue(p.root, "A teammate's handoff he chose a mode for", teammate('handoff')),
    enqueue(p.root, 'An answer that continues by itself', { continuationTaskId: '23', priority: 0, readOnly: true, origin: { kind: 'answer', peer: KEY, name: 'sara', a2aTaskId: 'task-3', threadId: 'thread-3', hop: 0 }, context: 'In src/coupon.mjs.' }),
  ];
  // A retry after a failure of something he typed starts by itself too.
  const retried = enqueue(p.root, 'His message, tried again after a rate limit', { continuationTaskId: '24', priority: 0, typed: true });
  updateRequest(p.root, retried.id, { attempts: 1 });
  assert.deepEqual(p.pass(), mine.map(row => row.goal).sort());
  for (const row of [...unasked, retried]) {
    assert.equal(request(p.root, row.id).state, 'queued', row.goal);
    assert.deepEqual(request(p.root, row.id).waits, { on: 'slot', running: 2, limit: 2 }, row.goal);
    assert.equal(request(p.root, row.id).reason, SLOT(2, 2), row.goal);
  }
  for (const row of mine) assert.equal(request(p.root, row.id).waits, undefined, row.goal);
  assert.deepEqual(mine.map(row => ownerTyped(request(p.root, row.id))), mine.map(() => true));
  assert.deepEqual([...unasked, retried].map(row => ownerTyped(request(p.root, row.id))), [...unasked, retried].map(() => false));
  // His sessions run past the number, and what waits says the number that really runs.
  p.run(); p.run(); p.run();
  p.pass();
  assert.deepEqual(request(p.root, unasked[0].id).waits, { on: 'slot', running: 5, limit: 2 });
  assert.equal(request(p.root, unasked[0].id).reason, OVER(5, 2));
  assert.equal(waitText({ on: 'slot', running: 9, limit: 8 }), OVER(9, 8));
  assert.equal(waitText({ on: 'slot', running: 2, limit: 1 }), OVER(2, 1));
  assert.equal(queued().said[0], '5 running, 2 at once');
  // A blocked message he sends again with its key is his, whatever it was before; a slot frees for the rest.
  updateRequest(p.root, retried.id, { state: 'blocked', reason: 'Rate limited.' });
  assert.equal(retryRequest(p.root, retried.id).typed, true);
  assert.ok(p.pass().includes(retried.goal));
  // A schedule's run is his when he runs it now with its key (r), and starts by itself when it comes due.
  const due = saveSchedule({ root: p.root, goal: 'Check the build when due', when: parseWhen('every 1h') }), now = saveSchedule({ root: p.root, goal: 'Check the build now', when: parseWhen('every 1h') });
  pauseSchedule(now.id, true);
  assert.equal(runDue(new Date(Date.now() + 2 * 3600000), { start: () => true }), 1); runScheduleNow(now.id, new Date(), { start: () => true });
  const byGoal = goal => pendingRequests(p.root).find(row => row.goal === goal);
  assert.deepEqual([byGoal('Check the build when due').scheduleId, byGoal('Check the build when due').typed], [due.id, undefined]);
  assert.deepEqual([byGoal('Check the build now').scheduleId, byGoal('Check the build now').typed], [now.id, true]);
  assert.deepEqual([ownerTyped(byGoal('Check the build when due')), ownerTyped(byGoal('Check the build now'))], [false, true]);
  // typed is only ever true: it is written where his own hand makes the request.
  assert.throws(() => enqueue(p.root, 'A message', { typed: false }), { message: 'Only what the owner typed himself is marked typed.' });
  assert.equal(SLOTS_RULE, 'What you type always starts; this number limits what starts by itself.');
  assert.equal(SLOTS_RULE_UNSET, 'What you type always starts; a limit holds back what starts by itself.');
});

test('his message still waits where waiting is right: for the turn of a session that works, and until the time a held one says', t => {
  const p = dispatcher(t, [{ taskId: '5' }, {}]); saveConductorSettings({ maxAgents: 2 });
  // A follow-up to the session whose turn works: for that turn, never for a slot.
  const follow = enqueue(p.root, 'Use the short form', { continuationTaskId: '5', priority: 0, permissions: 'auto', typed: true });
  // One held until a time: the conductor does not look at it before.
  const now = Date.now(), held = enqueue(p.root, 'Go on', { continuationTaskId: '6', priority: 0, typed: true });
  updateRequest(p.root, held.id, { notBefore: new Date(now + 30000).toISOString(), reason: 'This session is busy.' });
  assert.deepEqual(p.pass(), []);
  assert.deepEqual(request(p.root, follow.id).waits, { on: 'turn' });
  assert.equal(waitingText(request(p.root, follow.id)), "Waiting for this session's current turn to end.");
  assert.equal(request(p.root, held.id).waits, undefined);
  assert.equal(waitingText(request(p.root, held.id), now), 'This session is busy. It tries again in 30s.');
  // Its time comes: it starts, though every slot is taken.
  updateRequest(p.root, held.id, { notBefore: new Date(now - 1000).toISOString() });
  assert.deepEqual(p.pass(), ['Go on']);
  // The turn ends: the follow-up starts.
  p.conductor.runs.delete('run-0');
  assert.deepEqual(p.pass(), ['Go on', 'Use the short form']);
});

// Kai's daemon as far as a teammate's message goes (as in ask-failure.test.mjs): ana is on
// his team, the project is the one teammates' messages run in, and send() delivers one of
// hers as the wire would. A team with no setting saved is Manual.
const ANA = 'b'.repeat(64);
function answering(root) {
  const me = createIdentity({ name: 'kai' }), team = createTeam(me, 'core');
  redeemCode(createInvite(me, team.id, { hours: 1 }), ANA, 'ana');
  share(root, { teams: [team.id], handle: 'shop' });
  const ctx = { me, kick: () => {}, event: () => {}, push: () => {} }, methods = intakeMethods(ctx);
  const send = text => getRecord(methods.SendMessage({ message: message({ text, contextId: crypto.randomUUID(), messageId: crypto.randomUUID(), ext: { kind: 'ask', project: 'shop', hop: 1, from: { key: ANA, name: 'ana' } } }) }, { key: ANA }).id);
  return { team, ctx, send };
}
const fromAna = (root, record) => pendingRequests(root).find(row => row.origin?.a2aTaskId === record.task.id);

test("a teammate's message he accepts with his own key starts at once, past /slots and the teammate slot; one that starts by itself keeps the teammate rule and waits for a slot", t => {
  // /slots 1 with one session of his working, and the one teammate slot (the default) taken.
  const p = dispatcher(t, [{}, { origin: teammate('ask').origin }]); saveConductorSettings({ maxAgents: 1 });
  const kai = answering(p.root);
  // Manual: each message waits for his key, and nothing is queued until then.
  const sent = ['Add a note to the readme', 'Fix the cart total', 'Where are coupon codes normalized?'].map(kai.send);
  for (const record of sent) { assert.equal(record.waiting, true); assert.equal(fromAna(p.root, record), undefined); }
  // y (the session his own prompt would start), w (in a mode he picks now) and the read-only
  // answer, in Chats or on its card: his decision at that moment, so each is typed.
  acceptIncoming(kai.ctx, sent[0].task.id, { how: 'own' });
  acceptIncoming(kai.ctx, sent[1].task.id, { how: 'work', permissions: 'ask', place: { kind: 'worktree' }, folders: [] });
  acceptIncoming(kai.ctx, sent[2].task.id, { how: 'answer' });
  const accepted = sent.map(record => fromAna(p.root, record));
  for (const row of accepted) { assert.equal(row.typed, true, row.goal); assert.equal(ownerTyped(row), true, row.goal); }
  // All three start at once: neither the number /slots sets nor the teammate slot holds them back.
  assert.deepEqual(p.pass(), accepted.map(row => row.goal).sort());
  for (const row of accepted) assert.equal(request(p.root, row.id).waits, undefined, row.goal);
  for (const row of accepted) removeRequest(p.root, row.id);
  // The two that are a teammate's work (y on a message, and the answer) count among the teammate
  // runs as they work, so more run than the teammate slots.
  p.run({ origin: accepted[0].origin }); p.run({ origin: accepted[2].origin });
  // One the conductor held for the home folder, which his y on its card lets start (retryRequest), starts at once too.
  const home = enqueue(p.root, "A teammate's handoff", { ...teammate('handoff', { own: true }), permissions: undefined });
  assert.equal(home.state, 'waiting');
  assert.equal(retryRequest(p.root, home.id).typed, true); assert.equal(ownerTyped(request(p.root, home.id)), true);
  assert.deepEqual(p.pass(), ["A teammate's handoff"]);
  removeRequest(p.root, home.id);
  // Auto: the message starts a session by itself, with no key from him. It is not his, keeps
  // the teammate rule, and waits for the teammate slot.
  saveTeamAccess(kai.team.id, { handling: 'auto', root: p.root });
  const auto = fromAna(p.root, kai.send('Check the coupon module'));
  assert.equal(auto.state, 'queued'); assert.equal(auto.typed, undefined); assert.equal(ownerTyped(auto), false);
  assert.deepEqual(p.pass(), []);
  assert.deepEqual(request(p.root, auto.id).waits, { on: 'teammates', running: 3, limit: 1 });
  assert.equal(waitingText(request(p.root, auto.id)), 'Waiting for a free teammate slot: 3 are in use, and 1 runs at once.');
  // The teammate slots free while every slot of his is taken: it waits for a slot, as a scheduled run does.
  for (const id of ['run-1', 'run-2', 'run-3']) p.conductor.runs.delete(id);
  assert.deepEqual(p.pass(), []);
  assert.deepEqual(request(p.root, auto.id).waits, { on: 'slot', running: 1, limit: 1 });
  assert.equal(waitingText(request(p.root, auto.id)), 'Waiting for a free slot: 1 of 1 session is running. /slots changes it.');
  // The owner's own message starts beside it.
  enqueue(p.root, 'His own message', { continuationTaskId: '31', priority: 0, typed: true });
  assert.deepEqual(p.pass(), ['His own message']);
});

test('a request saved before requests said who typed them is his only where nothing else makes one of its kind', t => {
  const p = dispatcher(t, [{}, {}]); saveConductorSettings({ maxAgents: 2 });
  // As 0.1.21 and earlier saved them, or an ELU window of such a version still open does.
  const approved = enqueue(p.root, 'Approved the Task: Uppercase coupons', { continuationTaskId: '41', priority: 0, approved: true });
  const session = enqueue(p.root, 'A session from his other computer', { priority: 0, permissions: 'ask', mine: { machine: KEY, name: 'laptop', remoteId: 'session-2' } });
  const standup = enqueue(p.root, '/standup', { priority: 0, permissions: 'ask', standup: true });
  const plain = enqueue(p.root, 'A message of then', { continuationTaskId: '42', priority: 0 });
  const fresh = enqueue(p.root, 'A new session of then', { priority: 0, permissions: 'ask' });
  for (const row of [approved, session, standup, plain, fresh]) assert.equal(row.typed, undefined, row.goal);
  // His approval, his standup and his session from the other computer start: only his own hand ever made those.
  assert.deepEqual(p.pass(), [approved, session, standup].map(row => row.goal).sort());
  // A plain message of then may be one ELU sent in his place (a helper's turn, a carried-on session): it waits for a slot as it did, and says so.
  for (const row of [plain, fresh]) assert.equal(waitingText(request(p.root, row.id)), SLOT(2, 2), row.goal);
});
