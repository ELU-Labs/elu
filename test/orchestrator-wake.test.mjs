import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { projectFolder, saveRequest, updateRequest } from '../lib/workspace.mjs';
import { registerProject } from '../lib/projects.mjs';
import { closeSession } from '../lib/kanban.mjs';
import { setLevel } from '../lib/orchestrator-settings.mjs';
import { eluLine, sentByElu, writtenByElu } from '../lib/elu-sent.mjs';
import { lookLongWork } from '../lib/long-work.mjs';
import { IDLE_MS, WAKE_EVENTS, WAKE_GAP_MS, localWord, lookWake, readWake, remoteWord, wakeFile, wakeText } from '../lib/orchestrator-wake.mjs';

// The Orchestrator wakes by itself at Full (lib/orchestrator-wake.mjs): when one of the owner's
// sessions here or on a paired computer finishes a turn, asks, waits for an approval, errors,
// stops, or works with no log activity for 15 minutes. Made-up sessions in a plain folder, a
// stand-in for the conductor's queue, and ELU's own folder new in every test: no model runs.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const MINUTE = 60000, T0 = Date.now() - 60 * MINUTE;
const iso = ms => new Date(ms).toISOString();
const PAIRED = 'a'.repeat(64), TEAMMATE = 'b'.repeat(64);
// One computer: a project named web, the Orchestrator's own chat as session 1, Full unless said.
function world(t, { level = 'full' } = {}) {
  environment(t, { XDG_CONFIG_HOME: temp(t) });
  const root = path.join(temp(t), 'web'); fs.mkdirSync(root);
  const repo = projectFolder(root); registerProject(repo);
  setLevel(level, { by: 'owner' });
  const w = { root, repo, queued: [], started: 0, machines: [] };
  w.session = (id, extra = {}) => {
    saveTask(repo, { id: String(id), kind: 'conversation', base: null, branch: null, worktree: repo.root, goal: `Goal of session ${id}`, state: 'answered', createdAt: iso(T0 - 60 * MINUTE), runs: [{ role: 'lead', at: iso(T0 - 30 * MINUTE) }], messages: [], reviews: [], responses: [], sessions: {}, permissions: 'full', ...extra });
    return readTask(repo, String(id));
  };
  // A turn that ended at `at`: one more run on its record.
  w.turn = (id, at, extra = {}) => { const task = readTask(repo, String(id)); w.session(id, { ...task, runs: [...task.runs, { role: 'lead', at: iso(at) }], state: 'answered', error: null, ...extra }); };
  w.enqueue = (at, goal, fields = {}) => { const row = saveRequest(at, goal, undefined, { state: 'queued', priority: 0, taskId: null, reason: 'Waiting to start.', ...fields, continuationTaskId: fields.continuationTaskId == null ? null : String(fields.continuationTaskId) }); w.queued.push({ root: at, goal, fields, row }); return row; };
  w.approvals = [];
  // The conductor took what was queued for the chat (its turn has not started yet).
  w.took = () => { for (const sent of w.queued) updateRequest(root, sent.row.id, { state: 'done' }); };
  w.look = (now, extra = {}) => lookWake({ enqueue: w.enqueue, projects: () => [repo], start: () => { w.started++; }, now, machines: () => w.machines, names: () => [{ key: PAIRED, name: 'devbox' }, { key: TEAMMATE, name: 'alex' }], mine: key => key === PAIRED, approvals: () => w.approvals, ...extra });
  w.session(1, { goal: 'Oversee the sessions', botChat: 'orchestrator', runs: [{ role: 'bot:orchestrator', at: iso(T0 - 50 * MINUTE) }] });
  return w;
}
const lines = text => text.split('\n').filter(line => line.startsWith('- '));

test('each kind of change wakes it once, every session in one message', t => {
  const w = world(t);
  for (const id of [2, 3, 4, 5, 6, 7, 8]) w.session(id);
  w.session(7, { state: 'running', activeSince: iso(T0 - 6 * MINUTE) });
  // The first look only counts what is there: an update wakes nothing for old sessions.
  assert.deepEqual(w.look(T0), { changed: 0, woke: false });
  assert.equal(w.queued.length, 0);
  const now = T0 + 10 * MINUTE;
  w.turn(2, now - MINUTE);
  w.turn(3, now - MINUTE, { state: 'needs_input', reply: { outcome: 'needs_input', question: 'Which database?\nMore words.' } });
  w.turn(4, now - MINUTE, { plan: { state: 'proposed', title: 'Move to Postgres' } });
  w.turn(5, now - MINUTE, { state: 'blocked', error: { message: 'The vendor said: rate limited.' } });
  w.turn(6, now - MINUTE, { state: 'stopped', error: { message: 'Stopped by the owner.' } });
  // Session 7 has worked with no log activity for 16 minutes now: idle.
  const log = path.join(temp(t), 'run.log'); fs.writeFileSync(log, '{}\n'); fs.utimesSync(log, new Date(T0 - 6 * MINUTE), new Date(T0 - 6 * MINUTE));
  w.session(7, { ...readTask(w.repo, '7'), activeLog: log });
  // Session 8 works and waits for a permission.
  w.session(8, { state: 'running', activeSince: iso(now - MINUTE) });
  w.approvals = [{ id: 'ap1', taskId: '8', root: w.root, summary: 'Run npm install' }];
  const out = w.look(now);
  assert.equal(out.woke, true); assert.equal(out.changed, 7);
  assert.equal(w.queued.length, 1);
  const [sent] = w.queued;
  assert.equal(sent.root, w.root);
  assert.deepEqual(sent.fields, { continuationTaskId: '1', priority: 1, bot: 'orchestrator' });
  assert.match(sent.goal, /^ELU: 7 sessions of the owner's changed\. \(ELU sent this, not the owner\.\)\n/);
  const said = lines(sent.goal);
  assert.equal(said.length, 7, sent.goal);
  const of = id => said.filter(line => line.startsWith(`- #${id} in web on this computer`));
  for (const id of [2, 3, 4, 5, 6, 7, 8]) assert.equal(of(id).length, 1, `session ${id} once: ${sent.goal}`);
  assert.match(of(2)[0], new RegExp(`: ${WAKE_EVENTS.turn} \\(`));
  assert.match(of(3)[0], /: asks a question: Which database\? \(/);
  assert.match(of(4)[0], /: waits for its Task to be approved: Move to Postgres \(/);
  assert.match(of(5)[0], /: stopped on an error: The vendor said: rate limited\. \(/);
  assert.match(of(6)[0], /: was stopped: Stopped by the owner\. \(/);
  assert.match(of(7)[0], /: has been working with no log activity for 15 minutes \(/);
  assert.match(of(8)[0], /: waits for a permission: Run npm install \(/);
  assert.match(sent.goal, /\nRead each of them now \(session_read/);
  assert.equal(w.started, 1, 'the conductor is asked to start for it');
  // The next look finds nothing new: nothing more goes, and the file is not written again.
  const before = fs.statSync(wakeFile()).mtimeMs;
  assert.deepEqual(w.look(now + 6 * MINUTE), { changed: 0, woke: false });
  assert.equal(w.queued.length, 1);
  assert.equal(fs.statSync(wakeFile()).mtimeMs, before);
});

test('what wakes it is ELU\'s message, never the owner\'s', () => {
  const text = wakeText([{ key: 'k', word: 'asks', label: '#2 in web on this computer "Login"', detail: 'Which database?', at: iso(T0) }], T0);
  assert.match(text, /^ELU: a session of the owner's changed\. \(ELU sent this, not the owner\.\)\n- #2 in web on this computer "Login": asks a question: Which database\? \(/);
  assert.equal(sentByElu(text), true); assert.equal(writtenByElu(text), true);
  assert.equal(eluLine(text), 'ELU woke it: a session of yours changed.');
  // Its reply is about these sessions alone (2026-11-22: a wake for one session's question was
  // answered with a report on every session, read from "only what needs him").
  assert.match(text, /Your reply is about these sessions alone: one short line for each/);
  assert.match(text, /Say nothing of his other sessions, and read none of them for this\.$/);
  assert.doesNotMatch(text, /only what needs him/);
  assert.equal(eluLine(wakeText([1, 2, 3].map(n => ({ key: `k${n}`, word: 'turn', label: `#${n}`, detail: '', at: iso(T0) })), T0)), 'ELU woke it: 3 sessions of yours changed.');
  // An owner's message that only starts the same way is his.
  assert.equal(sentByElu("ELU: a session of the owner's changed."), false);
  // At most WAKE_SESSIONS_MOST lines, and how many more.
  const many = wakeText(Array.from({ length: 15 }, (_, n) => ({ key: `k${n}`, word: 'turn', label: `#${n + 1}`, detail: '', at: iso(T0 + n) })), T0);
  assert.equal(lines(many).length, 13); assert.match(many, /\n- and 3 more\n/);
});

test('changes are coalesced per session while its chat works, and the newest is told', t => {
  const w = world(t);
  w.session(2); w.session(3); w.look(T0);
  // Its own chat is at work: nothing goes, what changed waits.
  w.session(1, { ...readTask(w.repo, '1'), state: 'running', activeSince: iso(T0 + MINUTE) });
  w.turn(2, T0 + 2 * MINUTE);
  assert.equal(w.look(T0 + 3 * MINUTE).woke, false);
  w.turn(2, T0 + 4 * MINUTE, { state: 'needs_input', reply: { outcome: 'needs_input', question: 'Ship it?' } });
  w.turn(3, T0 + 4 * MINUTE);
  assert.equal(w.look(T0 + 5 * MINUTE).woke, false);
  assert.deepEqual(Object.keys(readWake().pending).sort(), [`here:${w.root}:2`, `here:${w.root}:3`]);
  // Its turn ended, and a message waits for it: still nothing goes.
  w.session(1, { ...readTask(w.repo, '1'), state: 'answered' });
  const waiting = w.enqueue(w.root, 'What needs me?', { continuationTaskId: '1', bot: 'orchestrator' });
  w.queued.length = 0;
  assert.equal(w.look(T0 + 6 * MINUTE).woke, false);
  updateRequest(w.root, waiting.id, { state: 'done' });
  assert.equal(w.look(T0 + 7 * MINUTE).woke, true);
  const said = lines(w.queued[0].goal);
  assert.equal(said.length, 2, w.queued[0].goal);
  assert.equal(said.filter(line => line.startsWith('- #2 ')).length, 1);
  assert.match(said.find(line => line.startsWith('- #2 ')), /asks a question: Ship it\?/);
});

test('one wake every few minutes at most', t => {
  const w = world(t);
  w.session(2); w.look(T0);
  w.turn(2, T0 + MINUTE);
  assert.equal(w.look(T0 + 2 * MINUTE).woke, true);
  // Until the conductor takes that message, its chat has one waiting: nothing more goes.
  w.turn(2, T0 + 3 * MINUTE);
  assert.equal(w.look(T0 + 2 * MINUTE + WAKE_GAP_MS).woke, false);
  w.took();
  // Within WAKE_GAP_MS of the last wake: it waits.
  assert.equal(w.look(T0 + 4 * MINUTE).woke, false);
  assert.equal(w.look(T0 + 2 * MINUTE + WAKE_GAP_MS - 1).woke, false);
  assert.equal(w.look(T0 + 2 * MINUTE + WAKE_GAP_MS + 1).woke, true);
  assert.equal(w.queued.length, 2);
  assert.equal(readWake().wakes, 2);
});

test('below Full nothing wakes it, and Full later tells only what changes after', t => {
  const w = world(t, { level: 'run' });
  w.session(2); w.look(T0);
  w.turn(2, T0 + MINUTE);
  assert.equal(w.look(T0 + 2 * MINUTE).woke, false);
  assert.deepEqual(readWake().pending, {});
  setLevel('full', { by: 'owner' });
  assert.equal(w.look(T0 + 3 * MINUTE).woke, false, 'the turn under Run is not told');
  w.turn(2, T0 + 4 * MINUTE);
  assert.equal(w.look(T0 + 5 * MINUTE).woke, true);
});

test('never for its own chat, a bot chat, a Standup, a teammate\'s session or an archived one', t => {
  const w = world(t);
  w.session(2, { botChat: 'advisor' });
  w.session(3, { standup: true });
  w.session(4, { origin: { kind: 'ask', peer: TEAMMATE, name: 'Alex' } });
  w.session(5, { origin: { kind: 'mine', mine: true, machine: TEAMMATE, name: 'Alex' } });
  w.session(6);
  w.look(T0);
  for (const id of [1, 2, 3, 4, 5]) w.turn(id, T0 + MINUTE);
  // Session 6 asks, then the owner archives it before the look.
  w.session(6, { ...readTask(w.repo, '6'), state: 'needs_input', reply: { outcome: 'needs_input', question: 'Archive me?' } });
  closeSession(w.repo, '6');
  assert.deepEqual(w.look(T0 + 2 * MINUTE), { changed: 0, woke: false });
  assert.equal(w.queued.length, 0);
  // A computer where the owner never opened the Orchestrator's chat wakes nothing, and keeps what changed.
  w.session(7); w.look(T0 + 3 * MINUTE);
  fs.rmSync(path.join(w.repo.state, 'tasks', '1'), { recursive: true, force: true });
  w.turn(7, T0 + 4 * MINUTE);
  assert.equal(w.look(T0 + 5 * MINUTE).woke, false);
  assert.deepEqual(Object.keys(readWake().pending), [`here:${w.root}:7`]);
});

test('what its chat\'s last turn could read already is not told again', t => {
  const w = world(t);
  w.session(2); w.look(T0);
  w.turn(2, T0 + MINUTE);
  w.session(1, { ...readTask(w.repo, '1'), state: 'running' });
  assert.equal(w.look(T0 + 2 * MINUTE).woke, false);
  // The owner's own message to it started a turn after the change: that turn read the session.
  w.turn(1, T0 + 3 * MINUTE);
  assert.equal(w.look(T0 + 4 * MINUTE).woke, false);
  assert.deepEqual(readWake().pending, {});
});

test('working 15 minutes with no log activity wakes it once', t => {
  const w = world(t);
  const log = path.join(temp(t), 'run.log'); fs.writeFileSync(log, '{}\n');
  const quiet = ms => fs.utimesSync(log, new Date(ms), new Date(ms));
  quiet(T0);
  w.session(2, { state: 'running', activeSince: iso(T0), activeLog: log, runs: [{ role: 'lead', at: iso(T0) }] });
  w.look(T0 + MINUTE);
  assert.equal(w.look(T0 + IDLE_MS - MINUTE).woke, false, 'its log grew within 15 minutes');
  assert.equal(w.look(T0 + IDLE_MS + MINUTE).woke, true);
  assert.match(w.queued[0].goal, /#2 in web on this computer "Goal of session 2": has been working with no log activity for 15 minutes/);
  // Still quiet: not again.
  assert.equal(w.look(T0 + IDLE_MS + 10 * MINUTE).woke, false);
  // Its log grew, then went quiet again: once more.
  w.took(); quiet(T0 + IDLE_MS + 11 * MINUTE);
  assert.equal(w.look(T0 + IDLE_MS + 12 * MINUTE).woke, false);
  assert.equal(w.look(T0 + 2 * IDLE_MS + 12 * MINUTE).woke, true);
  assert.equal(w.queued.length, 2);
  // The words, by themselves: working with a fresh log is working.
  assert.equal(localWord({ state: 'running', runs: 1, last: T0, activeSince: iso(T0) }, { logAt: T0 + 14 * MINUTE, now: T0 + 15 * MINUTE }).word, 'working');
  assert.equal(localWord({ state: 'running', runs: 1, last: T0, activeSince: iso(T0) }, { logAt: T0, now: T0 + 15 * MINUTE }).word, 'idle');
});

test('a paired computer\'s sessions wake it; a teammate\'s computer\'s never do', t => {
  const w = world(t);
  const row = (n, extra = {}) => ({ ref: `0123456789abcdef:${n}`, project: '0123456789abcdef', title: `Remote ${n}`, state: 'answered', at: iso(T0 - 10 * MINUTE), by: 'you', approvals: [], ...extra });
  w.machines = [
    { key: PAIRED, projects: [{ id: '0123456789abcdef', name: 'api' }], sessions: [row(1), row(2), row(3, { by: 'teammate' }), row(4, { by: 'bot' })] },
    { key: TEAMMATE, projects: [{ id: '0123456789abcdef', name: 'api' }], sessions: [row(1)] },
  ];
  w.look(T0);
  const later = iso(T0 + MINUTE);
  w.machines = [
    { key: PAIRED, projects: [{ id: '0123456789abcdef', name: 'api' }], sessions: [row(1, { at: later }), row(2, { at: later, question: 'Which region?' }), row(3, { by: 'teammate', at: later }), row(4, { by: 'bot', at: later })] },
    { key: TEAMMATE, projects: [{ id: '0123456789abcdef', name: 'api' }], sessions: [row(1, { at: later })] },
  ];
  assert.equal(w.look(T0 + 2 * MINUTE, { local: false }).woke, true);
  const said = lines(w.queued[0].goal);
  assert.deepEqual(said.map(line => line.replace(/ \(\d{2}:\d{2}.*\)$/, '').replace(/ \([^)]*\)$/, '')).sort(), [
    '- #1 in api on @devbox "Remote 1": finished a turn',
    '- #2 in api on @devbox "Remote 2": asks a question: Which region?',
  ]);
  // A new session there since the check first ran is told the first time it is seen.
  w.took(); w.machines[0].sessions.push(row(5, { createdAt: iso(T0 + 3 * MINUTE), at: iso(T0 + 4 * MINUTE), state: 'blocked', error: 'Tests failed.' }));
  assert.equal(w.look(T0 + 2 * MINUTE + WAKE_GAP_MS, { local: false }).woke, true);
  assert.match(w.queued[1].goal, /- #5 in api on @devbox "Remote 5": stopped on an error: Tests failed\./);
  // The words of a listed row, by themselves.
  assert.equal(remoteWord(row(6, { state: 'running', at: iso(T0) }), { now: T0 + IDLE_MS }).word, 'idle');
  assert.equal(remoteWord(row(6, { state: 'running', at: iso(T0), jobs: [{ name: 'build' }] }), { now: T0 + IDLE_MS }).word, 'working');
  assert.equal(remoteWord(row(6, { plan: { state: 'proposed', title: 'Plan' } })).word, 'task');
  assert.equal(remoteWord(row(6, { approvals: [{ id: 'x', summary: 'Run it' }] })).word, 'approval');
  assert.equal(remoteWord(row(6, { kept: true })).word, 'stopped');
});

test('the conductor\'s look runs it, and the daemon\'s looks at the other computers', async t => {
  const w = world(t);
  w.session(2);
  const state = { wakeEveryMs: 0, jobsEveryMs: 0 };
  // The module is loaded on the first look, and used from the next.
  lookLongWork(state, { enqueue: w.enqueue, projects: () => [w.repo], now: Date.now() });
  await import('../lib/orchestrator-wake.mjs'); await new Promise(resolve => setTimeout(resolve, 20));
  lookLongWork(state, { enqueue: w.enqueue, projects: () => [w.repo], now: Date.now() });
  assert.ok(readWake().since, 'the look ran and counted the sessions');
  w.turn(2, Date.now());
  lookLongWork(state, { enqueue: w.enqueue, projects: () => [w.repo], now: Date.now() + 1000 });
  assert.equal(w.queued.length, 1);
  assert.match(w.queued[0].goal, /^ELU: a session of the owner's changed\./);
  // The daemon looks at the lists the paired computers keep here, every WAKE_LOOK_MS.
  const daemon = fs.readFileSync(new URL('../lib/peer/daemon.mjs', import.meta.url), 'utf8');
  assert.match(daemon, /if \(now - \(this\.wakeAt \?\?= 0\) >= WAKE_LOOK_MS\) \{ this\.wakeAt = now; try \{ lookWake\(\{ enqueue, projects: registeredProjects, start: startConductor, local: false, now \}\)/);
});
