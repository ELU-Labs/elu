import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp, project, fakeClis, git } from './helpers.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask, setTitle, taskDir } from '../lib/state.mjs';
import { TASK_LIMITS, approveTask, approvesTasks, checkProposal, currentTask, planFile, planSchema, readPlanReply, rejectTask, reportProgress, saysYes, sessionTasks, sharedTask, taskEta, turnPlan } from '../lib/plan.mjs';
import { conversationSchema } from '../lib/config.mjs';
import { boardRows, rowBadge } from '../lib/board.mjs';
import { clockTime, etaText, taskCard as drawCard, taskState } from '../lib/terminal-plan.mjs';
import { visible } from '../lib/terminal-visuals.mjs';
// The card as its text reads on screen, without the style marks.
const taskCard = (plan, options) => visible(drawCard(plan, options));

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// A project with one source file and a passing-after-the-edit test, and the stand-in vendors.
// more: anything else fake.json holds for the stand-ins (test/helpers.mjs fakeClis).
function fixture(t, mode = 'normal', vendor = 'claude', more = {}) {
  const p = project(t), fake = fakeClis(p.parent, { mode, ...more });
  environment(t, { ...fake.env, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = new ProjectController(projectFolder(p.root)); controller.draftConfig.roles.lead.vendor = vendor;
  return { ...p, fake, controller, repo: controller.repo };
}
const inputs = f => fs.readFileSync(path.join(f.parent, 'inputs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const source = f => fs.readFileSync(path.join(f.root, 'src/coupon.mjs'), 'utf8');
// The model's own turns; a bot's review of the edit is a run too.
const turns = task => task.runs.filter(run => run.role === 'lead').length;
const TASK = { title: 'Uppercase coupons', description: 'Make normalize return the code in upper case.', goal: 'Codes compare equal whatever their case.', objectives: ['normalize returns upper case', 'The test passes'], priority: 'medium', severity: 'low' };

for (const vendor of ['claude', 'codex']) {
  test(`${vendor}: a request for a code change comes back as a Task and nothing is edited before the owner approves`, async t => {
    const f = fixture(t, 'normal', vendor), before = git(f.root, ['status', '--porcelain']);
    const asked = await f.controller.ask('Uppercase coupon codes', null, { permissions: 'ask' }).finished;
    // The reply is kept as an answer: no edit, no workspace, the session rests.
    assert.equal(asked.state, 'answered'); assert.equal(asked.kind, 'conversation'); assert.equal(asked.runs.length, 1);
    assert.equal(git(f.root, ['status', '--porcelain']), before); assert.match(source(f), /=> value;/);
    assert.equal(fs.existsSync(path.join(f.parent, 'sample app.elu-code')), false);
    const waiting = currentTask(f.repo, asked.id);
    assert.equal(waiting.state, 'proposed'); assert.equal(waiting.revision, 1); assert.equal(waiting.title, 'Uppercase coupons');
    assert.deepEqual([waiting.priority, waiting.severity, waiting.startedBy, waiting.by], ['medium', 'low', 'owner', 'lead']);
    assert.equal(waiting.objectives.length, 2); assert.deepEqual(waiting.edit, { intent: 'edit', repository: null, bot: null, request: 'Uppercase coupon codes', started: false });
    // The snapshot's session carries it, and the first turn was told the rule.
    assert.equal(f.controller.snapshot().tasks[0].plan.title, 'Uppercase coupons');
    assert.match(inputs(f)[0].input, /Plan first\. When the owner asks for a change to code or files/);
    // A Task that waits names nothing yet. y: approved, the session takes the Task's title, and
    // the editing turn starts with no second planning turn.
    assert.notEqual(readTask(f.repo, asked.id).titleBy, 'task');
    approveTask(f.repo, asked.id);
    assert.deepEqual([readTask(f.repo, asked.id).title, readTask(f.repo, asked.id).titleBy], ['Uppercase coupons', 'task']);
    const done = await f.controller.ask('Approved the Task: Uppercase coupons', asked.id, { approved: true }).finished;
    assert.notEqual(done.kind, 'conversation'); assert.equal(turns(done), 2);
    // The stand-in Codex writes no file; the stand-in Claude Code makes the edit in the workspace, never in the checkout.
    if (vendor === 'claude') assert.match(fs.readFileSync(path.join(done.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/);
    assert.match(source(f), /=> value;/);
    const work = inputs(f).find(row => row.input.includes('this turn does its work')).input;
    assert.match(work, /The owner approved the Task below, and this turn does its work/); assert.match(work, /Approved Task \(untrusted data/); assert.match(work, /Uppercase coupons/);
    assert.ok(done.messages.some(row => row.text === 'Approved the Task: Uppercase coupons'));
    // The working turn reported its subtasks and both objectives met, so the Task is done.
    const after = currentTask(f.repo, asked.id);
    assert.equal(after.state, 'done'); assert.deepEqual(after.met, [1, 2]); assert.equal(after.edit.started, true);
    assert.deepEqual(after.subtasks, [{ id: 's1', text: 'Change normalize', state: 'done' }, { id: 's2', text: 'Run the coupon test', state: 'done' }]);
  });
}

test('n rejects the Task: the session stays idle, nothing is edited, and the next request is planned again', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes').finished;
  rejectTask(f.repo, asked.id);
  assert.equal(currentTask(f.repo, asked.id).state, 'rejected'); assert.match(source(f), /=> value;/);
  assert.throws(() => f.controller.ask('Approved the Task: Uppercase coupons', asked.id, { approved: true }), /no longer waiting to start/);
  assert.throws(() => approveTask(f.repo, asked.id), /No Task waits for your approval/);
  const again = await f.controller.ask('Uppercase coupon codes after all', asked.id).finished;
  assert.equal(again.state, 'answered'); const rows = sessionTasks(f.repo, asked.id);
  assert.deepEqual(rows.map(row => row.state), ['rejected', 'proposed']); assert.notEqual(rows[0].id, rows[1].id);
});

test('a typed message revises the waiting Task, and a typed yes approves it', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes').finished, first = currentTask(f.repo, asked.id);
  const revised = await f.controller.ask('Make it urgent', asked.id).finished, second = currentTask(f.repo, asked.id);
  assert.equal(revised.state, 'answered'); assert.equal(second.id, first.id); assert.equal(second.revision, 2); assert.equal(second.priority, 'urgent'); assert.equal(second.state, 'proposed');
  assert.match(inputs(f).at(-1).input, /Task waiting for approval \(untrusted data/);
  assert.equal(sessionTasks(f.repo, asked.id).length, 1);
  // The owner named this session: a typed yes approves the Task and the owner's name stays.
  setTitle(f.repo, asked.id, 'Coupons, my way');
  const done = await f.controller.ask('yes', asked.id).finished;
  assert.notEqual(done.kind, 'conversation'); assert.equal(turns(done), 3); assert.equal(currentTask(f.repo, asked.id).state, 'done');
  assert.deepEqual([readTask(f.repo, asked.id).title, readTask(f.repo, asked.id).titleBy], ['Coupons, my way', 'owner']);
  // A follow-up inside the goal needs no new Task: it reopens this one and edits at once.
  const more = await f.controller.ask('Trim spaces too', asked.id).finished;
  assert.equal(sessionTasks(f.repo, asked.id).length, 1); assert.equal(turns(more), 5);
  assert.match(fs.readFileSync(path.join(more.worktree, 'src/coupon.mjs'), 'utf8'), /trim\(\)\.toUpperCase/);
});

test('a reply that asks for an edit with no Task is asked once more, then kept as a plain answer', async t => {
  const f = fixture(t, 'no-task');
  const asked = await f.controller.ask('Uppercase coupon codes').finished;
  assert.equal(asked.state, 'answered'); assert.equal(asked.runs.length, 2); assert.match(asked.result.summary, /No Task was read from this reply, so nothing was changed\./);
  assert.match(inputs(f).at(-1).input, /A request that changes files needs a Task first/);
  assert.equal(currentTask(f.repo, asked.id), null); assert.match(source(f), /=> value;/);
});

test('a Task that does not read is asked for again, then left out', async t => {
  const f = fixture(t, 'bad-task');
  const asked = await f.controller.ask('Uppercase coupon codes').finished;
  assert.equal(asked.state, 'answered'); assert.equal(asked.runs.length, 2); assert.match(inputs(f).at(-1).input, /A Task's priority is one of: urgent, high, medium, low\./);
  assert.match(asked.result.summary, /No Task was read/); assert.equal(currentTask(f.repo, asked.id), null);
});

test('a reply that asks the owner something first proposes no Task yet; the Task comes with the answer', async t => {
  const f = fixture(t, 'question');
  const asked = await f.controller.ask('Normalize coupon codes').finished;
  assert.equal(asked.state, 'needs_input'); assert.equal(asked.reply?.question ?? asked.result?.question, 'Which format?'); assert.equal(currentTask(f.repo, asked.id), null);
  const answered = await f.controller.ask('Uppercase', asked.id).finished;
  assert.equal(answered.state, 'answered'); assert.equal(currentTask(f.repo, asked.id).state, 'proposed'); assert.match(source(f), /=> value;/);
});

test('an edit never starts without an approved Task, whatever the session record says', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes').finished;
  // Approval is the owner's alone: not a schedule's, not a teammate's, not a new session's.
  assert.throws(() => f.controller.ask('go', asked.id, { approved: true, timed: true }), /Only the owner approves a Task/);
  assert.throws(() => f.controller.ask('go', null, { approved: true }), /Only the owner approves a Task/);
  assert.throws(() => f.controller.ask('go', asked.id, { approved: true }), /no longer waiting to start/);
  assert.equal(currentTask(f.repo, asked.id).state, 'proposed'); assert.match(source(f), /=> value;/);
});

test('a question gets a plain answer and no Task', async t => {
  const f = fixture(t, 'answer');
  const asked = await f.controller.ask('How do coupons work?').finished;
  assert.equal(asked.state, 'answered'); assert.equal(currentTask(f.repo, asked.id), null); assert.equal(f.controller.snapshot().tasks[0].plan, undefined);
});

test('a run a schedule starts records its Task as started by schedule and goes on without waiting', async t => {
  const f = fixture(t);
  const done = await f.controller.ask('Uppercase coupon codes', null, { timed: true }).finished;
  assert.notEqual(done.kind, 'conversation'); assert.match(fs.readFileSync(path.join(done.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/);
  const task = sessionTasks(f.repo, done.id)[0];
  assert.equal(task.startedBy, 'schedule'); assert.equal(task.edit, null); assert.ok(task.approvedAt); assert.equal(task.state, 'done');
  assert.deepEqual([readTask(f.repo, done.id).title, readTask(f.repo, done.id).titleBy], ['Uppercase coupons', 'task']);
  assert.match(inputs(f)[0].input, /A schedule started this turn and nobody is there to approve/);
});

test('a Task is checked as untrusted text', () => {
  assert.deepEqual(checkProposal({ ...TASK, title: '  Uppercase \n coupons ' }).title, 'Uppercase coupons');
  assert.throws(() => checkProposal({ ...TASK, title: 'x'.repeat(TASK_LIMITS.title + 1) }), /at most 80 characters/);
  assert.throws(() => checkProposal({ ...TASK, title: `Fix ${String.fromCharCode(27)}[31m it` }), /control characters/);
  assert.throws(() => checkProposal({ ...TASK, goal: `Fix ${String.fromCharCode(0x202e)} it` }), /control characters/);
  assert.throws(() => checkProposal({ ...TASK, priority: 'soon' }), /priority is one of/);
  assert.throws(() => checkProposal({ ...TASK, severity: 'bad' }), /severity is one of/);
  assert.throws(() => checkProposal({ ...TASK, objectives: [] }), /1 to 8 objectives/);
  assert.throws(() => checkProposal({ ...TASK, objectives: Array(9).fill('x') }), /1 to 8 objectives/);
  assert.throws(() => checkProposal({ ...TASK, description: '   ' }), /needs a description/);
  assert.equal(checkProposal({ ...TASK, description: 'One\r\n\r\n\r\n\r\nTwo\tend  ' }).description, 'One\n\nTwo end');
  // Extra fields of a reply never reach the record.
  assert.deepEqual(Object.keys(checkProposal({ ...TASK, state: 'approved', edit: { repository: '/' } })), ['title', 'description', 'goal', 'objectives', 'priority', 'severity', 'criteria', 'estimateMinutes']);
  // Success criteria are checked as the objectives are; with none, or no estimate, the Task still reads.
  assert.deepEqual(checkProposal({ ...TASK, criteria: [' The coupon  test passes ', '', 'No other file changes'], estimateMinutes: 45 }), { ...checkProposal(TASK), criteria: ['The coupon test passes', 'No other file changes'], estimateMinutes: 45 });
  assert.deepEqual([checkProposal(TASK).criteria, checkProposal(TASK).estimateMinutes], [[], null]);
  assert.throws(() => checkProposal({ ...TASK, criteria: Array(9).fill('x') }), /at most 8 success criteria/);
  assert.throws(() => checkProposal({ ...TASK, criteria: ['x'.repeat(TASK_LIMITS.criterion + 1)] }), /at most 200 characters/);
  assert.throws(() => checkProposal({ ...TASK, criteria: [`Fix ${String.fromCharCode(27)}[31m it`] }), /control characters/);
  for (const estimate of [0, -5, 1.5, '30', TASK_LIMITS.minutes + 1]) assert.equal(checkProposal({ ...TASK, estimateMinutes: estimate }).estimateMinutes, null, `estimate ${estimate}`);
});

test('the reply fields: one Task at most, subtasks read leniently, and the result keeps its own keys', () => {
  const schema = planSchema(conversationSchema({}), { propose: true, progress: true });
  assert.deepEqual(schema.required.slice(-4), ['task', 'subtasks', 'objectivesMet', 'etaMinutes']); assert.equal(schema.properties.task.maxItems, 1);
  assert.deepEqual(schema.properties.task.items.required.slice(-2), ['criteria', 'estimateMinutes']); assert.deepEqual(schema.properties.etaMinutes, { type: ['integer', 'null'] });
  // The minutes left: a whole number up to a week, 0 too; null or anything else keeps the last estimate.
  assert.equal(readPlanReply({ etaMinutes: 25 }, { progress: true }).reply.eta, 25); assert.equal(readPlanReply({ etaMinutes: 0 }, { progress: true }).reply.eta, 0);
  for (const eta of [null, -1, 2.5, '9', TASK_LIMITS.minutes + 1]) assert.equal(readPlanReply({ etaMinutes: eta }, { progress: true }).reply, null, `eta ${eta}`);
  assert.equal(readPlanReply({ outcome: 'done', etaMinutes: 25 }, { progress: false }).rest.etaMinutes, undefined);
  assert.equal(conversationSchema({}).properties.task, undefined);
  const read = readPlanReply({ outcome: 'done', task: [TASK], subtasks: [{ text: ' a  b ', state: 'doing' }, { text: '', state: 'done' }, { text: 'c', state: 'odd' }, 'no'], objectivesMet: [2, 2, 0, 9, 'x', 1] }, { propose: true, progress: true });
  assert.deepEqual(read.rest, { outcome: 'done' }); assert.equal(read.reply.proposal.title, 'Uppercase coupons');
  assert.deepEqual(read.reply.subtasks, [{ id: 's1', text: 'a b', state: 'doing' }, { id: 's2', text: 'c', state: 'todo' }]); assert.deepEqual(read.reply.met, [1, 2]);
  assert.throws(() => readPlanReply({ task: [TASK, TASK] }, { propose: true }), /one Task at most/);
  assert.deepEqual(readPlanReply({ task: [{ ...TASK, priority: 'soon' }] }, { propose: true, strict: false }).reply, { unread: true });
  // A turn that may not propose never does, and an empty list is no Task.
  assert.equal(readPlanReply({ task: [TASK] }, { propose: false }).reply, null); assert.equal(readPlanReply({ task: [] }, { propose: true }).reply, null);
});

test('subtasks change freely after approval; the goal and the objectives cannot be changed by a report', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes').finished;
  assert.equal(reportProgress(f.repo, asked.id, { subtasks: [{ id: 's1', text: 'early', state: 'done' }] }), null);
  approveTask(f.repo, asked.id);
  const moved = reportProgress(f.repo, asked.id, { subtasks: [{ id: 's1', text: 'one', state: 'doing' }], met: [1, 7], goal: 'Another goal', objectives: ['x'], title: 'Other' });
  assert.deepEqual(moved.subtasks, [{ id: 's1', text: 'one', state: 'doing' }]); assert.deepEqual(moved.met, [1]);
  assert.equal(moved.goal, 'Coupon codes compare equal whatever their case.'); assert.equal(moved.objectives.length, 2); assert.equal(moved.title, 'Uppercase coupons');
  // What a reader for someone else gets has no edit.
  const shared = sharedTask(currentTask(f.repo, asked.id));
  assert.equal(shared.edit, undefined); assert.equal(shared.title, 'Uppercase coupons'); assert.doesNotMatch(JSON.stringify(shared), /request|repository/);
  // The file sits beside the session record, private.
  const file = path.join(taskDir(f.repo, asked.id), 'plan.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
});

test('the card and the list row say what waits, and markup in a Task shows as typed', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes').finished, plan = currentTask(f.repo, asked.id);
  const card = taskCard(plan, { width: 60, colour: false });
  assert.match(card, /^Task · waits for your approval\nUppercase coupons\nmedium priority · low severity\nETA not set\n/);
  assert.match(card, /Goal: Coupon codes compare equal whatever their case\.\nObjectives\n  1\. normalize returns the code in upper case\n  2\. The coupon test passes\nSuccess criteria · not set\nEsc, then y approve · n reject · or type what to change$/);
  assert.match(taskCard(plan, { width: 60, colour: false, approval: true }), /y and n answer the approval below first/);
  assert.match(taskCard({ ...plan, revision: 3 }, { width: 60, colour: false }), /^Task · waits for your approval · revision 3\n/);
  const working = { ...plan, state: 'approved', subtasks: [{ id: 's1', text: 'Change normalize', state: 'done' }, { id: 's2', text: 'Run the test', state: 'doing' }, { id: 's3', text: 'Tidy', state: 'todo' }], met: [1] };
  assert.equal(taskState(working), 'approved · 1 of 3 subtasks done');
  assert.match(taskCard(working, { width: 60, colour: false }), /  ✓ 1\. normalize returns the code in upper case\n  · 2\. The coupon test passes\nSuccess criteria · not set\nSubtasks\n  \[x\] Change normalize\n  \[~\] Run the test\n  \[ \] Tidy$/);
  assert.equal(taskState({ ...working, state: 'done', met: [1, 2] }), 'done · 2 of 2 objectives reported met');
  assert.doesNotMatch(drawCard({ ...plan, title: '{red-fg}Loud{/red-fg}' }, { width: 60, colour: true }), /\{red-fg\}Loud/);
  const project = { ...f.controller.snapshot(), root: f.root, name: 'sample app' };
  const row = boardRows([project], Date.now(), { approvals: [] }).find(value => value.kind === 'task');
  assert.equal(row.group, 0); assert.equal(row.now, 'Task to approve: Uppercase coupons'); assert.equal(rowBadge(row).title, 'Task to approve');
});

test('a Task comes with its success criteria and an estimate; the ETA counts from approval and follows the minutes left the work reports', async t => {
  const f = fixture(t), fake = path.join(f.parent, 'bin', 'fake.json'), set = values => fs.writeFileSync(fake, JSON.stringify({ ...JSON.parse(fs.readFileSync(fake, 'utf8')), ...values }));
  set({ task: { ...TASK, criteria: ['The coupon test passes', 'Only src/coupon.mjs changes'], estimateMinutes: 40 }, etaMinutes: 12 });
  const asked = await f.controller.ask('Uppercase coupon codes').finished, waiting = currentTask(f.repo, asked.id);
  // Stored with the Task, and told to the turns that work on it.
  assert.deepEqual([waiting.criteria, waiting.estimateMinutes], [['The coupon test passes', 'Only src/coupon.mjs changes'], 40]);
  assert.equal(taskEta(waiting), Date.parse(waiting.proposedAt) + 40 * 60000, 'before approval it counts from the proposal');
  assert.match(taskCard(waiting, { width: 80, colour: false }), /ETA .* · in 40 min\n/);
  assert.match(taskCard(waiting, { width: 80, colour: false }), /Objectives\n.*\n.*\nSuccess criteria\n  · The coupon test passes\n  · Only src\/coupon\.mjs changes\n/);
  const approved = approveTask(f.repo, asked.id);
  assert.equal(taskEta(approved), Date.parse(approved.approvedAt) + 40 * 60000, 'from approval on');
  const done = await f.controller.ask('Approved the Task: Uppercase coupons', asked.id, { approved: true }).finished;
  const work = inputs(f).find(row => row.input.includes('this turn does its work')).input;
  assert.match(work, /"criteria":\["The coupon test passes","Only src\/coupon\.mjs changes"\]/); assert.match(work, /"estimateMinutes":40/); assert.match(work, /In etaMinutes give the minutes of work you think are left/);
  // The working turn said 12 minutes are left: the ETA is 12 minutes from when it said so.
  const after = currentTask(f.repo, done.id ?? asked.id);
  assert.equal(after.etaMinutes, 12); assert.ok(Number.isFinite(Date.parse(after.etaAt)));
  assert.equal(taskEta(after), Date.parse(after.etaAt) + 12 * 60000);
  // Done reads as when it was done; the shared Task carries all of it.
  assert.equal(after.state, 'done'); assert.equal(etaText(after), `done ${clockTime(Date.parse(after.doneAt))}`);
  assert.deepEqual((({ criteria, estimateMinutes, etaMinutes, etaAt }) => ({ criteria, estimateMinutes, etaMinutes, etaAt }))(sharedTask(after)), { criteria: after.criteria, estimateMinutes: 40, etaMinutes: 12, etaAt: after.etaAt });
  // A report while the Task is open moves it again.
  const open = { ...after, state: 'approved' }, now = Date.parse(after.etaAt);
  assert.equal(etaText({ ...open, etaAt: new Date(now).toISOString(), etaMinutes: 25 }, now), `${clockTime(now + 25 * 60000, now)} · in 25 min`);
  assert.equal(etaText({ ...open, etaAt: new Date(now - 40 * 60000).toISOString(), etaMinutes: 30 }, now), `${clockTime(now - 10 * 60000, now)} · overdue by 10 min`);
  assert.equal(etaText({ ...open, etaAt: new Date(now).toISOString(), etaMinutes: 150 }, now), `${clockTime(now + 150 * 60000, now)} · in 2 h 30 min`);
});

test('a Task saved before success criteria and estimates loads unchanged and reads as not set', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes').finished, file = planFile(f.repo, asked.id);
  // The file as an older build wrote it: no criteria, no estimate, no revision of the minutes left.
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')), old = saved.tasks[0];
  for (const key of ['criteria', 'estimateMinutes', 'etaMinutes', 'etaAt']) delete old[key];
  fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
  const read = currentTask(f.repo, asked.id);
  assert.deepEqual(read, old, 'loaded as it was written');
  assert.equal(taskEta(read), null); assert.equal(etaText(read), 'not set');
  const card = taskCard(read, { width: 80, colour: false });
  assert.match(card, /\nETA not set\n/); assert.match(card, /\nSuccess criteria · not set\n/);
  assert.deepEqual((({ criteria, estimateMinutes, etaMinutes, etaAt }) => ({ criteria, estimateMinutes, etaMinutes, etaAt }))(sharedTask(read)), { criteria: [], estimateMinutes: null, etaMinutes: null, etaAt: null });
  // Approved, it still has no estimate; a report of the minutes left gives it an ETA.
  approveTask(f.repo, asked.id);
  const moved = reportProgress(f.repo, asked.id, { eta: 20 });
  assert.equal(moved.etaMinutes, 20); assert.equal(taskEta(moved), Date.parse(moved.etaAt) + 20 * 60000);
  assert.equal(reportProgress(f.repo, asked.id, {}), null, 'nothing to report changes nothing');
});

// Full access and Approve for me approve the Task for the owner (approvesTasks): it is written
// and shown, nobody waits, and the agent is never told that somebody must approve.
for (const [mode, name] of [['full', 'Full access'], ['auto', 'Approve for me']]) {
  test(`${name}: a request for a code change writes its Task and does the work, and nobody approves`, async t => {
    const f = fixture(t, 'normal', 'claude', { tells: true });
    const done = await f.controller.ask('Uppercase coupon codes', null, { permissions: mode }).finished;
    // One message of the owner's, one planning turn, one working turn: no key and no typed approval.
    assert.notEqual(done.kind, 'conversation'); assert.equal(turns(done), 2);
    assert.deepEqual(done.messages.filter(row => !row.from && !row.to && !row.quiet).map(row => row.text), ['Uppercase coupon codes']);
    assert.match(fs.readFileSync(path.join(done.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/); assert.match(source(f), /=> value;/);
    // The Task is on record as any other, approved by the mode, and done.
    const task = currentTask(f.repo, done.id);
    assert.deepEqual([task.title, task.state, task.approvedBy, task.startedBy, task.by, task.edit], ['Uppercase coupons', 'done', mode, 'owner', 'lead', null]); assert.ok(task.approvedAt); assert.deepEqual(task.met, [1, 2]);
    assert.deepEqual([readTask(f.repo, done.id).title, readTask(f.repo, done.id).titleBy], ['Uppercase coupons', 'task']);
    assert.equal(sharedTask(task).approvedBy, mode); assert.equal(sharedTask(task).edit, undefined);
    assert.match(taskCard({ ...task, state: 'approved' }, { width: 70, colour: false }), new RegExp(`medium priority · low severity · approved by ${name}\n`));
    // The planning turn was told the mode approves, never that the owner must, and it answered so.
    const [first] = inputs(f), told = first.input;
    assert.match(told, new RegExp(`This session runs with ${name}, which approves the Task: it is recorded as approved by ${name}, nobody has to approve it, and the work goes on at once\\.`));
    assert.match(told, /Never tell the owner that a Task waits for approval and never ask them to approve one\./);
    assert.doesNotMatch(told, /Plan first|change nothing in this turn|only after they approve|waits for the owner's approval/);
    const work = inputs(f).find(row => row.input.includes('this turn does its work')).input;
    assert.match(work, new RegExp(`This session's ${name} approved the Task below, and this turn does its work`)); assert.doesNotMatch(work, /The owner approved the Task below/);
  });
}

test('Ask for approval keeps the approval: the Task waits, and a plainly typed yes in any words starts it', async t => {
  const f = fixture(t, 'normal', 'claude', { tells: true });
  const asked = await f.controller.ask('Uppercase coupon codes', null, { permissions: 'ask' }).finished;
  assert.equal(asked.state, 'answered'); assert.equal(currentTask(f.repo, asked.id).state, 'proposed'); assert.match(source(f), /=> value;/);
  assert.match(asked.result.summary, /One Task is below for your approval\./);
  // The agent is told that the owner's own words approve, as the key does.
  assert.match(inputs(f)[0].input, /The owner approves or rejects the Task, with a key or by saying so in a message, and the work starts only after they approve\./);
  // A few words that all say go need no model turn: the work starts at once.
  const done = await f.controller.ask('yes go ahead', asked.id).finished;
  assert.notEqual(done.kind, 'conversation'); assert.equal(turns(done), 2); assert.equal(currentTask(f.repo, asked.id).state, 'done');
  assert.equal(currentTask(f.repo, asked.id).approvedBy, undefined, 'the owner approved it, not the mode');
  assert.match(fs.readFileSync(path.join(done.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/);
  assert.match(inputs(f).find(row => row.input.includes('this turn does its work')).input, /The owner approved the Task below, and this turn does its work/);
});

test('an approval typed in other words is read by the turn that answers it, and the work starts after that reply', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes', null, { permissions: 'ask' }).finished;
  // A question about the Task approves nothing: the turn is offered approved and leaves it false.
  const still = await f.controller.ask('Is the coupon test part of this, and would you go ahead without it?', asked.id).finished;
  assert.equal(still.state, 'answered'); assert.equal(currentTask(f.repo, asked.id).state, 'proposed'); assert.match(source(f), /=> value;/);
  const offered = inputs(f).at(-1);
  assert.match(offered.input, /A plain approval in their message counts, in any words \(yes go ahead, sounds good, do it\): then set approved to true and leave task empty/);
  assert.equal(JSON.parse(offered.args[offered.args.indexOf('--json-schema') + 1]).properties.approved.type, 'boolean');
  // His words approve it. They are no short yes, so the model reads them and says so; the editing turn follows with no key.
  const text = 'That plan is what I wanted, so go ahead and keep the test as it is';
  assert.equal(saysYes(text), false);
  const done = await f.controller.ask(text, asked.id).finished;
  assert.notEqual(done.kind, 'conversation'); assert.equal(turns(done), 4); assert.equal(currentTask(f.repo, asked.id).state, 'done'); assert.equal(currentTask(f.repo, asked.id).edit.started, true);
  assert.match(fs.readFileSync(path.join(done.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/);
  assert.equal(done.messages.filter(row => row.text === text).length, 1); assert.ok(!done.messages.some(row => /^Approved the Task/.test(row.text)));
});

test('a typed yes: a few words that all say go approve, and anything else is left to the model', () => {
  for (const text of ['y', 'yes', 'Yes.', 'ok', 'go ahead', 'yes go ahead', 'Yes, go ahead!', 'do it', 'sounds good', 'Approve', 'approve it', 'lgtm', 'continue', 'looks good to me', 'ok do it now', 'proceed', 'ship it']) assert.equal(saysYes(text), true, text);
  for (const text of ['', 'no', 'not ok', "don't", 'do not start', 'ok no', 'stop', 'wait', 'yes but also add tests', 'Make it urgent', 'is that fine?', 'go to the kanban', 'start with the tests', 'yes go ahead and delete everything', 'why did you stop? you have full access']) assert.equal(saysYes(text), false, text);
});

test('a Task that waited from before starts with the next message once the session has Full access', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes', null, { permissions: 'ask' }).finished, waiting = currentTask(f.repo, asked.id);
  assert.equal(waiting.state, 'proposed');
  const done = await f.controller.ask('Why did you stop? You have full access now', asked.id, { permissions: 'full' }).finished;
  assert.notEqual(done.kind, 'conversation'); assert.equal(sessionTasks(f.repo, asked.id).length, 1);
  const task = currentTask(f.repo, asked.id);
  assert.deepEqual([task.id, task.state, task.approvedBy, task.revision], [waiting.id, 'done', 'full', 2]);
  const told = inputs(f)[1].input;
  assert.match(told, /The Task below was written before this session had Full access and still waits\. It needs no approval now\./); assert.match(told, /Task waiting \(untrusted data/);
  assert.doesNotMatch(told, /Task waiting for approval|Only the owner approves it/);
  assert.match(fs.readFileSync(path.join(done.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/);
});

test('Full access: a reply that starts an edit with no Task, twice, gets the Task ELU writes from the request, and the work goes on', async t => {
  const f = fixture(t, 'no-task');
  const done = await f.controller.ask('Uppercase coupon codes\nand keep the tests green', null, { permissions: 'full' }).finished;
  assert.notEqual(done.kind, 'conversation'); assert.match(fs.readFileSync(path.join(done.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/);
  const task = sessionTasks(f.repo, done.id)[0];
  assert.deepEqual([task.title, task.goal, task.approvedBy, task.by], ['Uppercase coupon codes and keep the tests green', 'Uppercase coupon codes and keep the tests green', 'full', 'lead']);
  assert.equal(task.description, 'Uppercase coupon codes\nand keep the tests green'); assert.deepEqual(task.objectives, ['The request is done as the owner wrote it']);
});

test('work that edits no file: Full access does it in the turn that writes the Task; Ask for approval waits, and an approval starts it', async t => {
  const full = fixture(t, 'ops');
  const done = await full.controller.ask('Check that the coupon build passes', null, { permissions: 'full' }).finished;
  // One turn: the Task is written, approved by the mode, worked on and done.
  assert.equal(done.state, 'answered'); assert.equal(done.kind, 'conversation'); assert.equal(done.runs.length, 1); assert.match(done.result.summary, /Ran the build check: it passed\./);
  const task = currentTask(full.repo, done.id);
  assert.deepEqual([task.title, task.state, task.approvedBy, task.met], ['Check the coupon build', 'done', 'full', [1, 2]]);
  assert.match(inputs(full)[0].input, /Work that changes no repository file, such as running commands, reading logs or operating a tool, do now, in this turn, and report it in subtasks and objectivesMet\./);
  const ask = fixture(t, 'ops');
  const asked = await ask.controller.ask('Check that the coupon build passes', null, { permissions: 'ask' }).finished;
  assert.equal(asked.state, 'answered'); assert.equal(currentTask(ask.repo, asked.id).state, 'proposed'); assert.match(asked.result.summary, /One Task is below for your approval\./);
  const after = await ask.controller.ask('The plan is right, so go ahead with the check', asked.id).finished;
  assert.equal(after.state, 'answered'); assert.equal(after.runs.length, 3); assert.equal(currentTask(ask.repo, asked.id).state, 'done'); assert.match(after.result.summary, /Ran the build check: it passed\./);
  assert.ok(after.messages.some(row => row.text === 'Approved the Task: Check the coupon build'));
});

test("a session a teammate's message started keeps the owner's approval in every mode, and a schedule keeps its own rule", t => {
  const dir = temp(t);
  assert.equal(approvesTasks('full'), true); assert.equal(approvesTasks('auto'), true); assert.equal(approvesTasks('ask'), false); assert.equal(approvesTasks('locked'), false); assert.equal(approvesTasks(null), false);
  const repo = { root: dir, common: path.join(dir, '.git') };
  // The runner gives a teammate's session no mode here (mode: null), and an unattended turn keeps its own rule.
  assert.equal(turnPlan(repo, '1', { mode: null, owner: false }).approves, null);
  assert.equal(turnPlan(repo, '1', { mode: 'full', unattended: 'schedule' }).approves, null);
  assert.equal(turnPlan(repo, '1', { mode: 'full', owner: true }).approves, 'full'); assert.equal(turnPlan(repo, '1', { mode: 'full', owner: true }).mayApprove, false);
});

test('a step that fails is the agent\'s to fix: it goes another way and the work ends done, after an approval and in Full access', async t => {
  for (const mode of ['ask', 'full']) {
    const f = fixture(t, 'normal', 'claude', { failStep: true });
    let done = await f.controller.ask('Uppercase coupon codes', null, { permissions: mode }).finished;
    if (mode === 'ask') done = await f.controller.ask('yes', done.id).finished;
    // The first copy failed on a missing folder; the turn made the folder and copied again.
    assert.notEqual(done.state, 'needs_input', done.result?.question); assert.notEqual(done.kind, 'conversation');
    assert.equal(fs.existsSync(path.join(done.worktree, 'out/coupon.copy.mjs')), true);
    assert.match(done.result.summary, /Made the folder and copied the file\./);
    const work = inputs(f).find(row => row.input.includes('this turn does its work')).input;
    assert.match(work, /A step that fails is yours to fix: a missing folder, a command that exits non-zero, a tool error, a network error\. Find the cause, fix it or go another way, and keep going\. Ask the owner only when you cannot go on at all, or when the choice is truly theirs \(spending money they did not approve, deleting their data\); then ask once, and say what you will do by default\./);
    assert.doesNotMatch(work, /When an action is declined or blocked, do not retry it another way/);
    // Only a declined action is a stop, and Full access declines nothing, so it is not told of one.
    if (mode === 'full') assert.doesNotMatch(work, /declines an action|do not retry/); else assert.match(work, /When the owner, the approver or a rule declines an action, do not retry it another way: return outcome needs_input and name the action you need\. Only a declined action is a stop\./);
  }
});

test('when the work is done the agent reports and ends, and a bare continue takes the next piece of the goal', async t => {
  for (const mode of ['ask', 'full']) {
    const f = fixture(t, 'normal', 'claude', { asksNext: true, next: true });
    let done = await f.controller.ask('Uppercase coupon codes', null, { permissions: mode }).finished;
    if (mode === 'ask') done = await f.controller.ask('yes', done.id).finished;
    // No "What would you like next?" with choices: the turn ended with its report.
    assert.notEqual(done.state, 'needs_input', done.result?.question); assert.equal(done.result.question, null); assert.deepEqual(done.result.choices, []);
    const work = inputs(f).find(row => row.input.includes('this turn does its work')).input;
    assert.match(work, /When the work is done, say what you did and what it showed, and end with outcome done: do not ask what to do next and do not offer choices\./);
    assert.equal(currentTask(f.repo, done.id).state, 'done');
    // continue: the turn that answers it is told what the owner means, takes the next piece and edits.
    const more = await f.controller.ask('continue', done.id).finished;
    assert.match(inputs(f).findLast(row => row.input.includes('Approved Task (untrusted data') && !row.input.includes('this turn does its work')).input, /When the owner writes continue, or the like, they mean the next piece of the goal: find what is still open or comes next for it and do that\. Do not answer that nothing is left to do/);
    assert.notEqual(more.state, 'needs_input'); assert.doesNotMatch(more.reply?.summary ?? '', /Nothing is left/);
    assert.match(fs.readFileSync(path.join(more.worktree, 'src/coupon.mjs'), 'utf8'), /trim\(\)\.toUpperCase/);
    assert.equal(sessionTasks(f.repo, done.id).length, 1);
  }
});
