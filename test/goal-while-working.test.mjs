import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { project, fakeClis, autoApprove, CLI } from './helpers.mjs';
import { ProjectController, registerProject } from '../lib/projects.mjs';
import { projectFolder, pendingRequests } from '../lib/workspace.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { Conductor, enqueue } from '../lib/conductor.mjs';
import { GOAL_DURING, GOAL_TOLD } from '../lib/runner.mjs';
import { GOAL_NEW, approveTask, currentTask, proposeTask, settleWork, turnPlan } from '../lib/plan.mjs';
import { answerCheck, checkDone, checkView, copySession, taskView } from '../lib/owner-check.mjs';
import { waitingWords } from '../lib/message-aside.mjs';

// A new goal while the session works (README, "Kanban"; lib/owner-check.mjs keepOpen): the
// owner gives it from elu sessions goal or from the app at any time. The Task's goal and
// objectives change at once, and the working turn is not stopped. A turn that takes messages
// (Claude Code) reads the new goal at its next step, told to align its work with it, and its
// report counts the new objectives. One that takes none goes on to its end: what it marks then
// was for the goal before and does not count, and the new goal is the session's next message,
// never answered beside the turn. The chat says in one line that the session was told.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const TASK = { title: 'Uppercase coupons', description: 'Make normalize return the code in upper case.', goal: 'Coupon codes compare equal whatever their case.', objectives: ['normalize returns upper case', 'The coupon test passes'], priority: 'medium', severity: 'low' };
const NEW_GOAL = 'Coupon codes compare equal whatever their case or spaces\nnormalize returns upper case\nnormalize trims spaces\nThe coupon test passes';
// Session 1: a chat that replied, then given an approved Task of two objectives. Its turns from
// here on go as fake (fake.json) says. conduct false: no conductor runs once it is made.
async function setup(t, fake, { conduct = true } = {}) {
  const p = project(t), clis = fakeClis(p.parent, { mode: 'normal', intent: 'answer', objectivesMet: [1, 2] });
  environment(t, { ...clis.env, HOME: p.parent, ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); registerProject(controller.repo);
  const repo = controller.repo, root = repo.root;
  const live = []; t.after(async () => { for (const conductor of live) await conductor.stop(); });
  const start = () => { const conductor = new Conductor({ tickMs: 20 }).start(); live.push(conductor); return conductor; };
  const first = start();
  enqueue(root, 'Uppercase coupon codes', { priority: 0, typed: true });
  await until(() => pendingRequests(root).every(row => row.state === 'done') && (() => { try { return readTask(repo, '1').state === 'answered'; } catch { return false; } })(), 'the chat replies');
  if (!conduct) await first.stop();
  proposeTask(repo, '1', TASK); approveTask(repo, '1');
  const file = path.join(clis.dir, 'fake.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...fake }));
  // What ran from here on: the turns the test is about.
  const ofClaude = row => row.vendor === 'claude' && row.args.includes('-p'), was = { inputs: rows(path.join(p.parent, 'inputs.jsonl')).filter(ofClaude).length, runs: rows(clis.calls).filter(ofClaude).length };
  const inputs = () => rows(path.join(p.parent, 'inputs.jsonl')).filter(ofClaude).slice(was.inputs);
  const runs = () => rows(clis.calls).filter(ofClaude).slice(was.runs);
  return { ...p, fake: clis, repo, root, runs, inputs, start, absorbed: () => rows(path.join(clis.dir, 'absorbed.jsonl')), controls: () => rows(path.join(clis.dir, 'controls.jsonl')) };
}
async function until(check, message, timeout = 30000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const session = f => readTask(f.repo, '1');
// What was sent to session 1 after it began.
const toSession = f => pendingRequests(f.root).filter(row => row.continuationTaskId === '1');
const told = f => (session(f).messages ?? []).filter(row => row.text === GOAL_TOLD);
// elu sessions in the owner's shell, while the app's conductor runs in this process.
const elu = (f, args) => new Promise(resolve => {
  const env = { ...process.env }; delete env.ELU_SESSION; delete env.ELU_PROJECT;
  const child = spawn(process.execPath, [CLI, ...args], { cwd: f.root, env }); let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('close', status => resolve({ status, stdout, stderr }));
});

test('elu sessions goal while Claude Code works: the Task changes at once, that same turn reads the new goal at its next step and is not stopped, the chat says so once, and its report counts the new objectives', { timeout: 90000 }, async t => {
  const f = await setup(t, { mode: 'listen', steps: 60, stepMs: 150 });
  enqueue(f.root, 'Go on with the Task', { continuationTaskId: '1', priority: 0, typed: true });
  await until(() => session(f).state === 'running' && session(f).activeInbox === true, 'the turn works and takes messages');
  const r = await elu(f, ['sessions', 'goal', '1', NEW_GOAL]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Session 1 .*has the new goal\. It is told without stopping its turn\./);
  // At once, while the turn still works: the Task's goal and its three objectives, none met yet.
  assert.equal(session(f).state, 'running', 'the turn still works');
  const now = currentTask(f.repo, '1');
  assert.deepEqual([now.goal, now.objectives, now.met, now.revision, now.realign], ['Coupon codes compare equal whatever their case or spaces', ['normalize returns upper case', 'normalize trims spaces', 'The coupon test passes'], [], 2, true]);
  assert.equal(now.goals.at(-1).goal, TASK.goal, 'it keeps what the goal was');
  // The same turn takes it at its next step, told to align with it, and says so in the chat once.
  await until(() => told(f).length === 1, 'the chat says the session was told');
  assert.equal(session(f).state, 'running', 'told while it works');
  const [taken] = f.absorbed();
  assert.equal(taken.mid, true, 'the running turn took it in');
  assert.ok(taken.content.startsWith(GOAL_DURING), taken.content.slice(0, 200));
  for (const line of ['1. normalize returns upper case', '2. normalize trims spaces', '3. The coupon test passes']) assert.ok(taken.content.includes(line), line);
  await until(() => session(f).state !== 'running', 'the turn ends');
  // One run: it was never stopped or started again, and nothing was interrupted.
  assert.equal(f.runs().length, 1);
  assert.deepEqual(f.controls(), [], 'no interrupt');
  assert.deepEqual(pendingRequests(f.root).filter(row => row.goalChange).map(row => [row.state, row.reason]), [['done', 'Sent to the running turn.']]);
  // His words in the chat once, where the turn took them, and the one line under them.
  const chat = session(f).messages;
  assert.deepEqual(chat.filter(row => row.text === NEW_GOAL).map(row => row.during), [true]);
  assert.equal(told(f).length, 1);
  assert.ok(chat.findIndex(row => row.text === GOAL_TOLD) > chat.findIndex(row => row.text === NEW_GOAL));
  // It reported on the new objectives, which it was told of: those marks count, and nothing is left to tell.
  const after = currentTask(f.repo, '1');
  assert.deepEqual([after.goal, after.met, after.realign], ['Coupon codes compare equal whatever their case or spaces', [1, 2], undefined]);
});

// A turn that takes no message while it works (Codex without turn/steer, Grok Build,
// Antigravity: the runner marks it activeDeaf). His new goal is not answered beside it and does
// not stop it: the turn goes on to its end, and the goal starts the next turn as his message.
test('a new goal while a turn that takes no message works: it waits for the turn to end and is never answered beside it, that turn\'s marks for the goal before do not count, and the next turn is told to align', { timeout: 90000 }, async t => {
  const f = await setup(t, {}, { conduct: false });
  // The turn works on the Task as it was given it, and takes no message.
  const given = turnPlan(f.repo, '1', { work: true });
  saveTask(f.repo, { ...session(f), state: 'running', activeRole: 'lead', activeSince: new Date().toISOString(), activeDeaf: true });
  assert.deepEqual(answerCheck(f.repo, f.root, session(f), 'goal', NEW_GOAL), { answer: 'goal', task: true, working: true });
  assert.equal(currentTask(f.repo, '1').goal, 'Coupon codes compare equal whatever their case or spaces', 'the Task has it at once');
  const [sent] = toSession(f);
  assert.deepEqual([sent.goal, sent.typed, sent.goalChange], [NEW_GOAL, true, { task: given.open.id, revision: 2 }]);
  // The chat says when it reaches the turn: when that turn ends, not in a moment beside it.
  const words = waitingWords(sent, { working: true, deaf: true });
  assert.deepEqual([words.tag, words.lines], ['starts when this turn ends', ['The running turn takes no message while it works: the new goal reaches it when that turn ends.']]);
  new Conductor({ tickMs: 20 }).answerBeside({ root: f.root }, sent);
  const [waiting] = toSession(f);
  assert.deepEqual([waiting.state, waiting.aside], ['queued', undefined], 'never answered beside the turn');
  // The turn ends and reports on the objectives it was given: for the goal before, so they do not count.
  settleWork(f.repo, '1', { outcome: 'done', plan: { subtasks: [{ text: 'Change normalize', state: 'done' }], met: [1, 2], evidence: [[1, 'normalize uppercases'], [2, 'npm test: 1 passed']] } }, given);
  const between = currentTask(f.repo, '1');
  assert.deepEqual([between.met, between.evidence, between.realign, between.subtasks], [[], undefined, true, [{ text: 'Change normalize', state: 'done' }]]);
  saveTask(f.repo, { ...session(f), state: 'answered', activeRole: null, activeSince: null, activeDeaf: undefined });
  // The next turn starts with his new goal, told to align with it.
  f.start();
  await until(() => pendingRequests(f.root).every(row => row.state === 'done') && session(f).state !== 'running' && f.runs().length === 1, 'the next turn ends');
  const next = f.inputs()[0].input;
  assert.ok(next.includes(GOAL_NEW), 'told to align');
  for (const line of ['1. normalize returns upper case', '2. normalize trims spaces', '3. The coupon test passes']) assert.ok(next.includes(line), line);
  // The chat: his words once, as the next message, and the one line that the session was told.
  assert.equal(session(f).messages.filter(row => row.text === NEW_GOAL).length, 1);
  assert.equal(told(f).length, 1);
  // Its report was on the new objectives: those count, and nothing is left to tell.
  const after = currentTask(f.repo, '1');
  assert.deepEqual([after.met, after.realign], [[1, 2], undefined]);
});

// What the owner sees of a session at work, and what is still only his: its check and its Task
// say it works and take a new goal; Done and a copy wait until it stops; one with no Task is
// refused as before; and a turn never gives its own session a new goal while it works.
test('the check of a session at work with a Task shows it with working and takes only a new goal; Done, a copy and a turn\'s own new goal are refused', async t => {
  const f = await setup(t, {}, { conduct: false });
  saveTask(f.repo, { ...session(f), state: 'running', activeRole: 'lead', activeSince: new Date().toISOString() });
  const seen = checkView(f.repo, session(f));
  assert.deepEqual([seen.working, seen.goal, seen.objectives.map(row => row.text)], [true, TASK.goal, TASK.objectives]);
  assert.equal(taskView(f.repo, session(f)).working, true);
  const WORKING = /" is working\. Check it when it stops\.$/;
  assert.throws(() => checkDone(f.repo, session(f)), { message: WORKING });
  assert.throws(() => copySession(f.repo, f.root, session(f), 'Show the code as typed'), { message: WORKING });
  assert.deepEqual(toSession(f), []);
  // From inside the session's own turn: refused, and nothing changes.
  const env = { ...process.env, ELU_SESSION: '1', ELU_PROJECT: f.root };
  const r = spawnSync(process.execPath, [CLI, 'sessions', 'goal', '1', 'Do something else'], { cwd: f.root, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1); assert.match(r.stderr, /Only the owner gives this session a new goal while it works, in ELU\./);
  assert.equal(currentTask(f.repo, '1').goal, TASK.goal); assert.deepEqual(toSession(f), []);
  // A turn that takes messages: the line says when it reads the goal.
  assert.deepEqual(waitingWords({ state: 'queued', goalChange: { task: 't-00000000', revision: 2 } }, { working: true, soon: true }).lines, ['The running turn reads the new goal at its next step, or when that turn ends.']);
  // Once it stops, the check offers all three again, with no working.
  saveTask(f.repo, { ...session(f), state: 'answered', activeRole: null });
  assert.equal(checkView(f.repo, session(f)).working, undefined);
});
