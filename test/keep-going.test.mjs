import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, fakeClis, autoApprove, approvingConductor, CLI } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { ProjectController, conversationEntries, projectSnapshot, registerProject } from '../lib/projects.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import { Conductor, conductorAlive, enqueue } from '../lib/conductor.mjs';
import { closeSession, readBoard, setDone } from '../lib/kanban.mjs';
import { approveTask, proposeTask, reportProgress } from '../lib/plan.mjs';
import { boardRows, rowBadge } from '../lib/board.mjs';
import { taskView } from '../lib/owner-check.mjs';
import { endJobs, jobsDir, listJobs, markTold, startJob, waitingJobs } from '../lib/jobs.mjs';
import { liveTask } from './peer-helpers.mjs';
import { KEEP_GOING_LINE, KEEP_GOING_TEXT, eluLine, sentByElu } from '../lib/elu-sent.mjs';
import { stopLongWork } from '../lib/long-work.mjs';
import { IDLE_MS, KEEP_OFF, KEEP_ON, STOPPED_LINE, expectKeepGoing, keepGoingStop, keepGoingWaits, keepsGoing, lookKeepGoing, readKeepGoing, setKeepGoing, standing } from '../lib/keep-going.mjs';

// Keep going until the goal is met (docs/jobs.md): a session whose approved Task has
// objectives not all met, with nothing running and nothing it waits on the owner for, is
// started again by ELU after a few idle minutes, from ELU's own records and with no model call.
after(() => { setTimeout(() => { console.error('keep-going.test: something is still running 10 s after the last test.'); process.exit(1); }, 10000).unref(); });
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const rowsOf = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const TASK = { title: 'Pass the gates', description: 'Ten gates.', goal: 'Every gate passes.', objectives: ['Gate one passes', 'Gate two passes'], priority: 'medium', severity: 'low' };
const MINUTE = 60000;
function setup(t, fake = {}) {
  const live = []; t.after(async () => { for (const conductor of live) await conductor.stop(); for (const row of waitingJobs()) { try { endJobs(row.dir, { by: 'delete' }); } catch { /* Gone. */ } } });
  const p = project(t), clis = fakeClis(p.parent, { mode: 'answer', ...fake });
  environment(t, { ...clis.env, HOME: p.parent, ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, ELU_TURN: undefined, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const repo = repository(p.root); registerProject(repo);
  const controller = autoApprove(new ProjectController(repo));
  const conduct = (longWork = {}) => { const conductor = approvingConductor(new Conductor({ tickMs: 20 })); conductor.longWork = longWork; conductor.start(); live.push(conductor); return conductor; };
  const leads = () => rowsOf(clis.calls).filter(call => call.vendor === 'claude' && call.args.includes('-p'));
  const inputs = () => rowsOf(path.join(p.parent, 'inputs.jsonl')).filter(row => row.vendor === 'claude');
  const session = id => { try { return readTask(repo, String(id)); } catch { return null; } };
  // A session as its last turn left it some time ago, with an approved Task whose first objective is met.
  const chat = (id, { ago = 10 * MINUTE, task = true, met = [1], ...extra } = {}) => {
    const at = new Date(Date.now() - ago).toISOString();
    saveTask(repo, { id: String(id), kind: 'conversation', goal: `Session ${id}`, state: 'answered', permissions: 'full', worktree: repo.root, base: null, branch: null, createdAt: at, runs: [{ role: 'lead', vendor: 'claude', code: 0, logFile: path.join(p.parent, 'no-log.log'), startedAt: at, at }], reviews: [], responses: [], messages: [{ at, text: `Session ${id}` }], sessions: {}, result: { outcome: 'done', summary: 'Looked.' }, ...extra });
    if (task) { proposeTask(repo, String(id), TASK); approveTask(repo, String(id)); if (met.length) reportProgress(repo, String(id), { met }); }
    return readTask(repo, String(id));
  };
  // The check first ran on this computer an hour ago: sessions that worked since are its.
  const first = Date.now() - 60 * MINUTE;
  const stands = (id, extra = {}) => { const at = standing(repo, session(id), { requests: pendingRequests(repo.root), board: readBoard(repo), first, ...extra }); return at.go ? 'go' : at.why; };
  const sent = [], send = (root, text, options) => { sent.push({ root, text, options }); };
  const look = (options = {}) => lookKeepGoing({ enqueue: send, projects: () => [repo], ...options });
  return { ...p, ...clis, repo, root: repo.root, controller, conduct, leads, inputs, session, chat, stands, sent, look, first, live };
}
const elu = (f, args, { session = null } = {}) => {
  const env = { ...process.env }; delete env.ELU_SESSION; delete env.ELU_PROJECT;
  if (session) Object.assign(env, { ELU_SESSION: String(session), ELU_PROJECT: f.root });
  return spawnSync(process.execPath, [CLI, ...args], { cwd: f.root, env, encoding: 'utf8', timeout: 60000 });
};
async function until(check, message, timeout = 30000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${typeof message === 'function' ? message() : message}`); await new Promise(resolve => setTimeout(resolve, 25)); }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// A turn of the session, as its record shows one: a run that ended, and what it changed.
function turn(f, id, change = () => {}) {
  const task = f.session(id), at = new Date().toISOString();
  task.runs.push({ role: 'lead', vendor: 'claude', code: 0, logFile: path.join(f.parent, 'no-log.log'), startedAt: at, at }); task.state = 'answered'; change(task); saveTask(f.repo, task);
}

test('the check starts a session only when its approved Task is not met, nothing runs and it waits for nobody', { timeout: 90000 }, async t => {
  const f = setup(t);
  // The one it is for: Full access or Approve for me, an approved Task with an objective left, idle.
  f.chat(1); assert.equal(f.stands(1), 'go');
  f.chat(2, { permissions: 'auto' }); assert.equal(f.stands(2), 'go');
  // Its Task: none, one that waits for his approval, one whose objectives are all met.
  f.chat(3, { task: false }); assert.equal(f.stands(3), 'no-task');
  f.chat(4, { task: false }); proposeTask(f.repo, '4', TASK); assert.equal(f.stands(4), 'task-proposed');
  f.chat(5, { met: [1, 2] }); assert.equal(f.stands(5), 'met');
  // A turn runs, or one is queued, starting, saved or blocked for it.
  f.chat(6, { state: 'running' }); assert.equal(f.stands(6), 'working');
  f.chat(7, { state: 'preparing' }); assert.equal(f.stands(7), 'working');
  f.chat(8);
  for (const state of ['queued', 'starting', 'running', 'blocked', 'waiting']) assert.equal(f.stands(8, { requests: [{ id: 'r1', continuationTaskId: '8', state, goal: 'more' }] }), 'queued', state);
  assert.equal(f.stands(8, { requests: [{ id: 'r1', continuationTaskId: '9', state: 'queued', goal: 'more' }, { id: 'r2', continuationTaskId: '8', state: 'done', goal: 'old' }] }), 'go');
  // It waits for the owner: a question, an approval, his stop, a stop it cannot get past by itself.
  f.chat(9, { state: 'needs_input', result: { outcome: 'needs_input', summary: 'Which one?', question: 'Which one?' } }); assert.equal(f.stands(9), 'asks');
  f.chat(10); assert.equal(f.stands(10, { approvals: [{ id: 'a1', taskId: '10', summary: 'run npm test' }] }), 'approval');
  f.chat(11, { state: 'stopped', error: { message: 'Stopped by the owner.' } }); assert.equal(f.stands(11), 'stopped');
  f.chat(12, { state: 'blocked', error: { message: 'Claude Code is out of credits.' } }); assert.equal(f.stands(12), 'stopped');
  f.chat(13, { state: 'blocked', error: { message: 'Every Claude account is at its limit.', waitsFor: 'claude-limit' } }); assert.equal(f.stands(13), 'stopped');
  // A long job of it runs, or ended and was not told yet.
  f.chat(14); await startJob({ repo: f.repo, task: f.session(14), root: f.root, name: 'gate', command: ['sleep 300'], mode: 'full' }); assert.equal(f.stands(14), 'job');
  endJobs(jobsDir(f.repo, '14'), { by: 'command' }); assert.equal(f.stands(14), 'go', 'a job that was stopped waits for nothing');
  // His own Stop of a session whose jobs run and no turn: it waits for him as one whose turn he stopped, until he writes to it.
  f.chat(20); await startJob({ repo: f.repo, task: f.session(20), root: f.root, name: 'gate', command: ['sleep 300'], mode: 'full' });
  assert.deepEqual(stopLongWork(f.root, '20').map(job => job.name), ['gate']); assert.equal(f.stands(20), 'stopped', 'his Stop ended its jobs');
  { const task = f.session(20); task.messages.push({ at: new Date(Date.now() + 1000).toISOString(), text: 'Run it once more' }); saveTask(f.repo, task); }
  assert.equal(f.stands(20), 'go', 'his next message starts the check again');
  // Moved to Done, or archived.
  f.chat(15); setDone(f.repo, { task: f.session(15) }, true); assert.equal(f.stands(15), 'closed');
  f.chat(16); closeSession(f.repo, '16'); assert.equal(f.stands(16), 'closed');
  // Not the owner's own session: a teammate's question, a standup.
  f.chat(17, { origin: { kind: 'ask', peer: 'b'.repeat(64), name: 'sara', a2aTaskId: 'task-1', threadId: 'thread-1', hop: 1 } }); assert.equal(f.stands(17), 'not-own');
  f.chat(18, { standup: true }); assert.equal(f.stands(18), 'not-own');
  // Idle since before this check first ran here: an update starts no old session by itself.
  f.chat(19, { ago: 3 * 60 * MINUTE }); assert.equal(f.stands(19), 'before');
  setKeepGoing(f.repo, '19', true); assert.equal(f.stands(19), 'go', 'the owner turned it on for that one');
});

test('the switch is on in Full access and Approve for me and off in Ask for approval; a schedule\'s run and a bot\'s own chat are left alone until the owner turns it on', { timeout: 90000 }, async t => {
  const f = setup(t);
  assert.deepEqual(['full', 'auto', 'ask', undefined].map(permissions => keepsGoing({ permissions })), [true, true, false, false]);
  assert.deepEqual([keepsGoing({ permissions: 'full', scheduleId: 'schedule-0a1b2c3d' }), keepsGoing({ permissions: 'full', botChat: 'ops' })], [false, false]);
  f.chat(1, { permissions: 'ask' }); assert.equal(f.stands(1), 'off');
  f.chat(2, { scheduleId: 'schedule-0a1b2c3d' }); assert.equal(f.stands(2), 'off');
  f.chat(3, { botChat: 'ops' }); assert.equal(f.stands(3), 'off');
  f.chat(4); assert.equal(f.stands(4), 'go');
  // The command says which it is, and changes it; what he chose stays whatever the mode becomes.
  let r = elu(f, ['sessions', 'keep-going', '1']); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, `Session 1 "Pass the gates": ${KEEP_OFF}\n`);
  r = elu(f, ['sessions', 'keep-going', '1', 'on']); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, `Session 1 "Pass the gates": ${KEEP_ON}\n`);
  assert.equal(readKeepGoing(f.repo, '1').on, true); assert.equal(f.stands(1), 'go');
  for (const id of ['2', '3']) { setKeepGoing(f.repo, id, true); assert.equal(f.stands(id), 'go'); }
  r = elu(f, ['sessions', 'keep-going', '4', 'off']); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, `Session 4 "Pass the gates": ${KEEP_OFF}\n`);
  assert.equal(f.stands(4), 'off'); assert.equal(JSON.parse(elu(f, ['sessions', 'keep-going', '4', '--json']).stdout).keepGoing, false);
  // From inside the session, this names it.
  assert.equal(JSON.parse(elu(f, ['sessions', 'keep-going', 'this', 'on', '--json'], { session: 4 }).stdout).keepGoing, true); assert.equal(f.stands(4), 'go');
  r = elu(f, ['sessions', 'keep-going', '4', 'maybe']); assert.equal(r.status, 1); assert.match(r.stderr, /Use elu sessions keep-going N\|this \[on\|off\]\./);
  assert.equal(KEEP_ON, "Keep going is on: ELU starts this session again while its Task's objectives are not all met and nothing is running.");
  // Turned off, the check sends it nothing.
  setKeepGoing(f.repo, '4', false); f.look({ now: f.first }); f.look({ idleMs: 0 });
  assert.deepEqual(f.sent.map(row => row.options.continuationTaskId).sort(), ['1', '2', '3']);
});

test('after a few idle minutes ELU sends its working agent one message, with no model call; not before, and not twice for one idle spell', { timeout: 90000 }, async t => {
  const f = setup(t);
  // The check's first look on this computer, an hour ago.
  assert.deepEqual(f.look({ now: f.first }), { pending: 0, sent: 0, stopped: 0 });
  f.chat(1, { ago: MINUTE }); f.chat(2, { ago: 10 * MINUTE }); f.chat(3, { ago: 10 * MINUTE, met: [1, 2] });
  assert.equal(IDLE_MS, 3 * MINUTE);
  // One minute idle: it waits, and a conductor stays for it. Ten minutes idle: it is started.
  assert.deepEqual(f.look(), { pending: 1, sent: 1, stopped: 0 }); assert.equal(keepGoingWaits(), true);
  assert.deepEqual(f.sent, [{ root: f.root, text: KEEP_GOING_TEXT, options: { continuationTaskId: '2', priority: 0 } }]);
  assert.equal(KEEP_GOING_TEXT, "The Task's objectives are not all met and nothing is running. Carry on, or say exactly what you need from the owner.");
  assert.ok(sentByElu(KEEP_GOING_TEXT)); assert.equal(eluLine(KEEP_GOING_TEXT), KEEP_GOING_LINE);
  assert.equal(f.leads().length, 0, 'the check called no model');
  // Its message waits in the queue: nothing more is sent while it does.
  enqueue(f.root, KEEP_GOING_TEXT, f.sent[0].options);
  assert.deepEqual(f.look(), { pending: 1, sent: 0, stopped: 0 }); assert.equal(f.sent.length, 1);
  // Session 1 reaches its idle minutes.
  assert.deepEqual(f.look({ now: Date.now() + 3 * MINUTE }), { pending: 0, sent: 1, stopped: 0 });
  assert.equal(f.sent[1].options.continuationTaskId, '1');
});

test('no token loop: after two turns ELU started in a row with no progress it stops starting the session, which then waits for the owner and says why; his next message starts it again', { timeout: 90000 }, async t => {
  const f = setup(t); f.look({ now: f.first });
  f.chat(1); const later = minutes => Date.now() + minutes * MINUTE;
  // (idleMs 0: a look for which the idle minutes have passed.)
  assert.equal(f.look().sent, 1);
  // The turn ELU started ends with nothing new: after the idle minutes it is started once more.
  turn(f, 1);
  assert.deepEqual(f.look(), { pending: 1, sent: 0, stopped: 0 });
  assert.deepEqual(f.look({ idleMs: 0 }), { pending: 0, sent: 1, stopped: 0 }); assert.equal(f.sent.length, 2);
  // The second ends with nothing new as well: ELU stops there, at once.
  turn(f, 1);
  assert.deepEqual(f.look(), { pending: 0, sent: 0, stopped: 1 });
  assert.deepEqual(f.look({ now: later(60) }), { pending: 0, sent: 0, stopped: 0 }); assert.equal(f.sent.length, 2);
  assert.equal(STOPPED_LINE, 'ELU stopped starting this session: its last two turns made no progress. Your next message starts it again.');
  assert.equal(keepGoingStop(f.session(1), readKeepGoing(f.repo, '1')).text, STOPPED_LINE); assert.equal(f.stands(1), 'no-progress');
  // It shows as waiting for him, with the one line: in Sessions, in its chat and in its Task.
  const snapshot = projectSnapshot(f.repo), [row] = boardRows([snapshot]);
  assert.deepEqual([row.group, row.label, row.now, rowBadge(row).title], [0, 'WAITING YOU', STOPPED_LINE, 'waits for you']);
  assert.deepEqual(conversationEntries(f.repo, f.session(1)).filter(entry => entry.role === 'ELU').map(entry => [entry.text, entry.line]), [[STOPPED_LINE, true]]);
  assert.deepEqual(taskView(f.repo, f.session(1)).checklist.find(item => item.text === 'Waits for you'), { text: 'Waits for you', met: false, evidence: STOPPED_LINE });
  // His next message resets it: the line goes, and after its turn ELU starts it again when it idles.
  await sleep(5);
  turn(f, 1, task => { task.messages.push({ at: new Date().toISOString(), text: 'Try the second gate another way' }); });
  assert.equal(keepGoingStop(f.session(1), readKeepGoing(f.repo, '1')), null); assert.equal(projectSnapshot(f.repo).tasks[0].keepStopped, undefined);
  assert.deepEqual(f.look(), { pending: 1, sent: 0, stopped: 0 });
  assert.deepEqual(f.look({ idleMs: 0 }), { pending: 0, sent: 1, stopped: 0 }); assert.equal(f.sent.length, 3);
});

test('progress starts the count again: an objective newly met, a job started, a change in its folder', { timeout: 90000 }, async t => {
  const f = setup(t); f.look({ now: f.first });
  f.chat(1, { met: [] }); assert.equal(f.look().sent, 1);
  // Each turn ELU started made progress of one kind: it is never stopped.
  turn(f, 1); reportProgress(f.repo, '1', { met: [1] });
  assert.deepEqual(f.look({ idleMs: 0 }), { pending: 0, sent: 1, stopped: 0 });
  turn(f, 1); await startJob({ repo: f.repo, task: f.session(1), root: f.root, name: 'gate', command: ['true'], mode: 'full' });
  await until(() => listJobs(jobsDir(f.repo, '1'))[0].state === 'ended', 'the job to end'); markTold(jobsDir(f.repo, '1'), 'gate', 'turn');
  assert.deepEqual(f.look({ idleMs: 0 }), { pending: 0, sent: 1, stopped: 0 });
  assert.equal(readKeepGoing(f.repo, '1').flat, 0); assert.equal(f.sent.length, 3);
  // Then two with none.
  turn(f, 1); assert.deepEqual(f.look({ idleMs: 0 }), { pending: 0, sent: 1, stopped: 0 }); assert.equal(readKeepGoing(f.repo, '1').flat, 1);
  turn(f, 1); assert.deepEqual(f.look(), { pending: 0, sent: 0, stopped: 1 });
  // A session that edits: a file it changed in its folder is progress too.
  const { worktree } = liveTask(f.root, { id: '2' });
  saveTask(f.repo, { ...f.session(2), permissions: 'full' }); proposeTask(f.repo, '2', TASK); approveTask(f.repo, '2');
  f.sent.length = 0; assert.equal(f.look({ idleMs: 0 }).sent, 1);
  turn(f, 2, task => { task.state = 'ready'; }); fs.writeFileSync(path.join(worktree, 'src/coupon.mjs'), 'export const normalize = (value) => value.trim().toUpperCase();\n');
  assert.equal(f.look({ idleMs: 0 }).sent, 1); assert.equal(readKeepGoing(f.repo, '2').flat, 0, 'the edit counted');
  turn(f, 2, task => { task.state = 'ready'; }); assert.equal(f.look({ idleMs: 0 }).sent, 1); assert.equal(readKeepGoing(f.repo, '2').flat, 1);
  turn(f, 2, task => { task.state = 'ready'; }); assert.equal(f.look().stopped, 1);
});

// A chat has no folder of its own: in Full access it works in the project folder itself, and what
// it changes there is its progress, as an edit is an editing session's.
test('a chat that changes or commits files in the project folder in each turn ELU starts has made progress, and is not stopped; two turns that change nothing end it', { timeout: 90000 }, async t => {
  const f = setup(t); f.look({ now: f.first });
  f.chat(1); assert.equal(f.look().sent, 1);
  const edit = text => { turn(f, 1); fs.writeFileSync(path.join(f.root, 'src/coupon.mjs'), text); };
  edit('export const normalize = (value) => value.trim();\n');
  assert.deepEqual(f.look({ idleMs: 0 }), { pending: 0, sent: 1, stopped: 0 }); assert.equal(readKeepGoing(f.repo, '1').flat, 0, 'the change in the project folder counted');
  edit('export const normalize = (value) => value.trim().toUpperCase();\n');
  assert.deepEqual(f.look({ idleMs: 0 }), { pending: 0, sent: 1, stopped: 0 }); assert.equal(readKeepGoing(f.repo, '1').flat, 0, 'a second change of the same file counted');
  turn(f, 1); assert.equal(spawnSync('git', ['commit', '-q', '-am', 'Normalize coupons'], { cwd: f.root }).status, 0);
  assert.deepEqual(f.look({ idleMs: 0 }), { pending: 0, sent: 1, stopped: 0 }); assert.equal(readKeepGoing(f.repo, '1').flat, 0, 'its commit counted');
  assert.equal(keepGoingStop(f.session(1), readKeepGoing(f.repo, '1')), null);
  // Then two that change nothing.
  turn(f, 1); assert.deepEqual(f.look({ idleMs: 0 }), { pending: 0, sent: 1, stopped: 0 }); assert.equal(readKeepGoing(f.repo, '1').flat, 1);
  turn(f, 1); assert.deepEqual(f.look(), { pending: 0, sent: 0, stopped: 1 });
});

test('with the conductor and a stand-in vendor: an idle session with an unmet Task is started twice, makes no progress, and then waits for the owner', { timeout: 120000 }, async t => {
  const f = setup(t); f.look({ now: f.first });
  // The stand-in model answers and marks no objective met.
  const fake = path.join(f.dir, 'fake.json'); fs.writeFileSync(fake, JSON.stringify({ ...JSON.parse(fs.readFileSync(fake, 'utf8')), objectivesMet: [], subtasks: [] }));
  const task = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  proposeTask(f.repo, task.id, TASK); approveTask(f.repo, task.id);
  const before = f.leads().length;
  // The same check, with its minutes made short.
  f.conduct({ jobsEveryMs: 50, keepEveryMs: 100, idleMs: 600 }); await until(() => conductorAlive(), 'the conductor');
  await until(() => readKeepGoing(f.repo, task.id).stopped, () => `ELU to stop starting it: ${JSON.stringify({ kept: readKeepGoing(f.repo, task.id), state: f.session(task.id).state, messages: f.session(task.id).messages.map(row => row.text.slice(0, 40)), stands: f.stands(task.id), queue: pendingRequests(f.root).map(row => [row.state, row.goal.slice(0, 30), row.reason]), plan: projectSnapshot(f.repo).tasks[0].plan })}`, 30000);
  assert.equal(f.leads().length, before + 2, 'two turns, then none');
  const session = f.session(task.id), told = session.messages.filter(row => row.text === KEEP_GOING_TEXT);
  assert.equal(told.length, 2); assert.ok(f.inputs().slice(-2).every(row => row.input.includes(KEEP_GOING_TEXT)), 'each turn read it');
  // The chat: one line of ELU's for each, never a message of the owner's, then why it stopped.
  const entries = conversationEntries(f.repo, session);
  assert.deepEqual(entries.filter(entry => entry.role === 'ELU').map(entry => entry.text), [KEEP_GOING_LINE, KEEP_GOING_LINE, STOPPED_LINE]);
  assert.equal(entries.some(entry => entry.role === 'You' && entry.text === KEEP_GOING_TEXT), false);
  const [row] = boardRows([projectSnapshot(f.repo)]); assert.deepEqual([row.group, row.label, row.now], [0, 'WAITING YOU', STOPPED_LINE]);
  await sleep(1500); assert.equal(f.leads().length, before + 2, 'nothing more starts by itself');
  // His message: its turn runs, and ELU starts it again when it idles.
  enqueue(f.root, 'Try the second gate another way', { continuationTaskId: task.id, priority: 0, typed: true });
  await until(() => f.session(task.id).messages.filter(row => row.text === KEEP_GOING_TEXT).length === 3, 'the count to start again', 90000);
  assert.equal(keepGoingStop(f.session(task.id), readKeepGoing(f.repo, task.id)), null);
});

// An update replaces the files under a conductor: it takes no new work, finishes the turn it
// has, and exits (lib/conductor.mjs, drain). The check must not end with it.
test('a conductor an update replaced exits when its turn ends: with the Task still not met, the new version\'s conductor is started for the check', { timeout: 120000 }, async t => {
  const f = setup(t); f.look({ now: f.first });
  // The stand-in model marks no objective met, and its turn lasts while a file is there.
  const fake = path.join(f.dir, 'fake.json'), hold = path.join(f.parent, 'hold');
  fs.writeFileSync(fake, JSON.stringify({ ...JSON.parse(fs.readFileSync(fake, 'utf8')), objectivesMet: [], subtasks: [], hold }));
  const task = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  proposeTask(f.repo, task.id, TASK); approveTask(f.repo, task.id);
  let disk = '0.0.1', started = 0, exits = 0;
  const old = approvingConductor(new Conductor({ tickMs: 20, version: '0.0.1', onDisk: () => disk, next: () => { started++; }, onExit: () => { exits++; } }));
  // The message waits before this conductor starts: one queued while a conductor of an earlier
  // version runs is kept from it for half a minute (KEEP_MS, lib/workspace.mjs), as long as
  // this test waits for the turn.
  fs.writeFileSync(hold, '');
  enqueue(f.root, 'Go on with the gates', { continuationTaskId: task.id, priority: 0, typed: true });
  old.longWork = { jobsEveryMs: 50, keepEveryMs: 100 }; old.start(); f.live.push(old);
  await until(() => f.session(task.id).state === 'running' && old.runs.size === 1, 'the turn');
  // While it works the check waits on nothing.
  await until(() => !keepGoingWaits(), 'the check to count it as working');
  disk = '0.0.2'; old.versionAt = 0;
  await until(() => old.draining, 'the update to replace the conductor');
  assert.equal(started, 0, 'nothing waits while the turn works: no conductor is started yet');
  fs.rmSync(hold);
  await until(() => exits > 0, 'the replaced conductor to exit with its turn');
  assert.equal(f.session(task.id).state, 'answered'); assert.equal(f.stands(task.id), 'go', 'its Task is still not met');
  assert.equal(keepGoingWaits(), true, 'the check waits on it');
  assert.equal(started, 1, 'the new version\'s conductor is started for it');
  // One whose Task is met, or that has none, starts nothing.
  f.chat(8, { met: [1, 2] }); f.chat(9, { task: false });
  assert.deepEqual([expectKeepGoing(f.repo, '8'), expectKeepGoing(f.repo, '9'), expectKeepGoing(f.repo, task.id)], [false, false, true]);
});
