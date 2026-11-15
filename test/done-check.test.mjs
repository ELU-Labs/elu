import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, fakeClis, CLI, git } from './helpers.mjs';
import { liveTask } from './peer-helpers.mjs';
import { repository } from '../lib/git.mjs';
import { projectSnapshot, registerProject } from '../lib/projects.mjs';
import { readTask, saveTask, taskDir } from '../lib/state.mjs';
import { boardRows } from '../lib/board.mjs';
import { deleteSession } from '../lib/session-delete.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import { Conductor, conductorAlive, enqueue } from '../lib/conductor.mjs';
import { addCard, boardColumns, checksSince, closeSession, fitCheckCard, linkCards, readBoard, reopenSession, sessionPlace, setDone, startCard } from '../lib/kanban.mjs';
import { approveTask, currentTask, finishTask, proposeTask, reportProgress, sessionTasks, sharedTask } from '../lib/plan.mjs';
import { answerCheck, checkDone, checkView, copySession, keepOpen, readGoal } from '../lib/owner-check.mjs';
import { parseWhen, runScheduleNow, saveSchedule } from '../lib/schedules.mjs';
import { runOwnCommand } from '../lib/session-commands.mjs';
import { personalDirectory } from '../lib/util.mjs';
import { peerFile } from '../lib/peer/paths.mjs';

// Nothing goes to Done by itself (README, "Kanban"): a session that ended waits under Needs you
// until the owner checks its goal and objectives, then moves it to Done, keeps it open with a new
// goal, or copies it with one. Only he does: never a turn, a schedule or elu sessions.
after(() => { setTimeout(() => { console.error('done-check.test: something is still running 10 s after the last test.'); process.exit(1); }, 10000).unref(); });
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// The conductors a test starts stop before its folder goes (registered first: hooks run in order).
function setup(t, fake = {}) {
  const live = []; t.after(async () => { for (const conductor of live) await conductor.stop(); });
  const p = project(t), clis = fakeClis(p.parent, { mode: 'normal', ...fake });
  environment(t, { ...clis.env, HOME: p.parent, ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const repo = repository(p.root); registerProject(repo);
  const conduct = () => { const conductor = new Conductor({ tickMs: 20 }).start(); live.push(conductor); return conductor; };
  const inputs = () => fs.existsSync(path.join(p.parent, 'inputs.jsonl')) ? fs.readFileSync(path.join(p.parent, 'inputs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.vendor === 'claude') : [];
  return { ...p, ...clis, repo, root: repo.root, conduct, inputs };
}
async function until(check, message, timeout = 30000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 25)); }
}
const request = (root, id) => pendingRequests(root).find(row => row.id === id);
// Its card on the project's Kanban, as the board shows it now.
const cardOf = (f, id) => boardColumns(readBoard(f.repo), projectSnapshot(f.repo)).flatMap(column => column.items.map(item => ({ ...item, column: column.column }))).find(item => String(item.task?.id) === String(id)) ?? null;
// Every message of the owner's to that session has run, and its turn ended.
const settled = (f, id) => !pendingRequests(f.root).some(row => String(row.continuationTaskId ?? row.taskId) === String(id) && row.state !== 'done') && !['running', 'preparing'].includes(readTask(f.repo, String(id)).state);
const leadTurns = task => task.runs.filter(run => run.role === 'lead').length;
// A chat session saved as the app saves one.
function chat(repo, id, { goal = `Session ${id}`, state = 'answered', days = 0, ...extra } = {}) {
  const at = new Date(Date.now() - days * 86400000).toISOString();
  saveTask(repo, { id: String(id), kind: 'conversation', goal, state, worktree: repo.root, base: null, branch: null, createdAt: at, runs: [], reviews: [], responses: [], messages: [], sessions: {}, result: null, ...extra });
  return readTask(repo, String(id));
}
const elu = (f, args, { session = null } = {}) => {
  const env = { ...process.env }; delete env.ELU_SESSION; delete env.ELU_PROJECT;
  if (session) Object.assign(env, { ELU_SESSION: String(session), ELU_PROJECT: f.root });
  return spawnSync(process.execPath, [CLI, ...args], { cwd: f.root, env, encoding: 'utf8', timeout: 60000 });
};
const EVIDENCE = [{ objective: 1, evidence: 'src/coupon.mjs: normalize returns value.toUpperCase()' }, { objective: 2, evidence: 'npm test: 1 passed' }];

test('a session that ended waits under Needs you; the check shows its goal and objectives, and Done, a new goal and a copy each do what they say', async t => {
  const f = setup(t, { evidence: EVIDENCE }); f.conduct();
  const sent = enqueue(f.root, 'Uppercase coupon codes', { permissions: 'full', typed: true, picked: true });
  await until(() => request(f.root, sent.id)?.state === 'done', 'the first session');
  const id = String(request(f.root, sent.id).taskId);
  await until(() => settled(f, id), 'its turn to end');
  let task = readTask(f.repo, id);
  // Its work is done and every objective reported met: neither it nor its Task is done until he
  // checks it, here or for a teammate it is shared with.
  assert.deepEqual([currentTask(f.repo, id).state, currentTask(f.repo, id).met, currentTask(f.repo, id).doneAt], ['approved', [1, 2], null]);
  assert.equal(sharedTask(currentTask(f.repo, id)).state, 'approved');
  let card = cardOf(f, id);
  assert.equal(card.column, 'needs'); assert.match(card.detail, / · check it/);
  assert.equal(readBoard(f.repo).checked?.[id], undefined);
  // The check: the goal, and each objective with the agent's mark and its line of evidence.
  const seen = checkView(f.repo, task);
  assert.equal(seen.goal, 'Coupon codes compare equal whatever their case.');
  assert.deepEqual(seen.objectives, [{ text: 'normalize returns the code in upper case', met: true, evidence: EVIDENCE[0].evidence }, { text: 'The coupon test passes', met: true, evidence: EVIDENCE[1].evidence }]);
  // Keep open, new goal: the Task keeps what it was, and the session carries on at once in its own mode.
  const turns = leadTurns(task), first = currentTask(f.repo, id);
  answerCheck(f.repo, f.root, task, 'goal', 'Trim spaces from coupon codes too\n- normalize trims the code\n- The coupon test still passes');
  await until(() => leadTurns(readTask(f.repo, id)) > turns && settled(f, id), 'the new goal to carry on');
  task = readTask(f.repo, id);
  const goal = currentTask(f.repo, id);
  assert.equal(goal.id, first.id, 'the same Task');
  assert.deepEqual([goal.goal, goal.objectives], ['Trim spaces from coupon codes too', ['normalize trims the code', 'The coupon test still passes']]);
  assert.deepEqual(goal.goals.map(row => [row.goal, row.objectives, row.met]), [[first.goal, first.objectives, [1, 2]]]);
  assert.equal(task.messages.at(-1).text, 'Trim spaces from coupon codes too\n- normalize trims the code\n- The coupon test still passes', 'sent as his message');
  assert.equal(task.runs.filter(run => run.role === 'lead').at(-1).permissions, 'full', 'in its own mode');
  assert.match(fs.readFileSync(path.join(task.worktree, 'src/coupon.mjs'), 'utf8'), /value\.trim\(\)\.toUpperCase\(\)/);
  assert.ok(f.inputs().some(row => /approved the Task below/.test(row.input) && row.input.includes('Trim spaces from coupon codes too')), 'the model was given the new goal');
  card = cardOf(f, id); assert.equal(card.column, 'needs', 'it waits for his check again'); assert.match(card.detail, / · check it/);
  // Done, and a copy with a new goal: this one goes to Done; the copy starts from where it ended, at once, in its mode.
  // Where it ended holds the work its folder has and ELU commits only when it publishes: the copy's branch starts with it.
  const end = git(task.worktree, ['rev-parse', 'HEAD']), left = git(task.worktree, ['status', '--porcelain']);
  assert.match(left, /src\/coupon\.mjs/, 'the trim is not committed');
  const copied = answerCheck(f.repo, f.root, task, 'copy', 'Show the code as typed\nThe display keeps the case the owner typed');
  assert.equal(copied.branch, `${task.branch}-next`); assert.equal(git(f.root, ['rev-parse', `${copied.branch}^`]), end);
  const start = git(f.root, ['rev-parse', copied.branch]);
  assert.match(git(f.root, ['show', `${copied.branch}:src/coupon.mjs`]), /value\.trim\(\)\.toUpperCase\(\)/);
  assert.deepEqual([git(task.worktree, ['rev-parse', 'HEAD']), git(task.worktree, ['status', '--porcelain'])], [end, left], 'its own folder as it was');
  card = cardOf(f, id); assert.equal(card.column, 'done'); assert.equal(typeof readBoard(f.repo).checked[id], 'string');
  assert.equal(currentTask(f.repo, id).checkedAt, readBoard(f.repo).checked[id]);
  // His check is what makes its Task done.
  assert.deepEqual([currentTask(f.repo, id).state, currentTask(f.repo, id).doneAt], ['done', readBoard(f.repo).checked[id]]);
  assert.equal(sharedTask(currentTask(f.repo, id)).state, 'done');
  const started = pendingRequests(f.root).find(row => row.copied);
  assert.deepEqual([started.permissions, started.place, started.typed, started.copied.from], ['full', { kind: 'branch', branch: copied.branch }, true, { session: id, task: goal.id }]);
  await until(() => started.id && request(f.root, started.id)?.state === 'done', 'the copy to start');
  const copyId = String(request(f.root, started.id).taskId);
  await until(() => settled(f, copyId), 'the copy to work');
  const copy = readTask(f.repo, copyId), [plan] = sessionTasks(f.repo, copyId);
  assert.equal(sessionTasks(f.repo, copyId).length, 1, 'no second Task to approve');
  assert.deepEqual([plan.title, plan.goal, plan.objectives, plan.by, plan.copiedFrom], [goal.title, 'Show the code as typed', ['The display keeps the case the owner typed'], 'owner', { session: id, task: goal.id }]);
  assert.match(plan.description, /Before, in "/); assert.match(plan.description, /Goal: Trim spaces from coupon codes too/);
  assert.equal(plan.state, 'approved', 'not done before his check');
  assert.equal(copy.permissions, 'full'); assert.equal(copy.branch, copied.branch);
  assert.ok(leadTurns(copy) >= 1); assert.match(fs.readFileSync(path.join(copy.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/, 'it worked at once, on top of where the first ended');
  assert.equal(git(copy.worktree, ['merge-base', '--is-ancestor', start, 'HEAD']), '');
  assert.equal(cardOf(f, copyId).column, 'needs');
  // Done on the copy.
  answerCheck(f.repo, f.root, readTask(f.repo, copyId), 'done');
  assert.equal(cardOf(f, copyId).column, 'done'); assert.equal(typeof currentTask(f.repo, copyId).checkedAt, 'string'); assert.equal(currentTask(f.repo, copyId).state, 'done');
});

test('a session with no Task: the check shows its first message; Keep open sends a new message, a copy is refused; one at work or whose Task waits is not checked', t => {
  const f = setup(t, { mode: 'answer' });
  const task = chat(f.repo, 1, { goal: 'Where is the export?' });
  assert.equal(cardOf(f, '1').detail, 'replied · check it');
  assert.deepEqual(checkView(f.repo, task), { title: 'Where is the export?', ended: 'replied', first: 'Where is the export?', checklist: [{ text: 'Replied', met: true, evidence: 'Its reply is in the chat.' }] });
  assert.throws(() => copySession(f.repo, f.root, task, 'Move the export'), { message: 'Only a session with a Task is copied. Keep it open with a new message instead.' });
  assert.throws(() => keepOpen(f.repo, f.root, task, '  '), { message: 'Write the new goal first.' });
  keepOpen(f.repo, f.root, task, 'And the import?');
  const [sent] = pendingRequests(f.root);
  assert.deepEqual([sent.goal, sent.continuationTaskId, sent.typed], ['And the import?', '1', true]);
  assert.equal(readBoard(f.repo).checked?.['1'], undefined, 'not Done');
  // Done: in Done, with when.
  const at = checkDone(f.repo, task);
  assert.equal(sessionPlace(readBoard(f.repo), task), 'done'); assert.equal(readBoard(f.repo).checked['1'], at);
  // One at work, and one whose Task waits for his yes, are not checked.
  const working = chat(f.repo, 2, { state: 'running', goal: 'Run the tests' });
  assert.throws(() => checkDone(f.repo, working), { message: '"Run the tests" is working. Check it when it stops.' });
  assert.equal(sessionPlace(readBoard(f.repo), working), 'progress');
  chat(f.repo, 3, { goal: 'Uppercase coupons' }); proposeTask(f.repo, '3', { title: 'Uppercase coupons', description: 'Upper case.', goal: 'Codes match.', objectives: ['normalize uppercases'], priority: 'medium', severity: 'low' });
  assert.throws(() => checkView(f.repo, readTask(f.repo, '3')), { message: 'Its Task waits for your approval first.' });
  assert.throws(() => keepOpen(f.repo, f.root, readTask(f.repo, '3'), 'Another goal'), { message: 'Its Task waits for your approval first.' });
  // Done too, as my other computer sends it with no view first (elu.remote.check): nothing moves.
  assert.throws(() => answerCheck(f.repo, f.root, readTask(f.repo, '3'), 'done'), { message: 'Its Task waits for your approval first.' });
  assert.equal(readBoard(f.repo).checked['3'], undefined); assert.equal(sessionPlace(readBoard(f.repo), readTask(f.repo, '3')), 'needs');
  // What he types for a goal: its first line, then an objective a line.
  assert.deepEqual(readGoal('Ship it\n1. tests pass\n* docs updated\n\n'), { goal: 'Ship it', objectives: ['tests pass', 'docs updated'] });
  assert.equal(readGoal(' \n '), null);
  // Archiving is not his check: the session leaves the board, and nothing says he checked it.
  const other = chat(f.repo, 4, { goal: 'Old question' }); closeSession(f.repo, '4');
  assert.equal(sessionPlace(readBoard(f.repo), other), null); assert.equal(readBoard(f.repo).checked['4'], undefined);
  assert.equal(cardOf(f, '4'), null);
});

test('only the owner moves a session to Done: elu sessions done is refused from a turn and from his shell; goal and copy leave it where it is, and a copy gets at most that session\'s mode', async t => {
  const f = setup(t); f.conduct(); await until(() => conductorAlive(), 'the conductor');
  const sent = enqueue(f.root, 'Uppercase coupon codes', { permissions: 'full', typed: true, picked: true });
  await until(() => request(f.root, sent.id)?.state === 'done', 'the session');
  const id = String(request(f.root, sent.id).taskId); await until(() => settled(f, id), 'its turn to end');
  const DONE_REFUSED = 'Only the owner moves a session to Done, in ELU: /done, or ⇧→ on its Kanban card.';
  let r = elu(f, ['sessions', 'done', id], { session: id }); assert.equal(r.status, 1); assert.match(r.stderr, new RegExp(DONE_REFUSED.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  r = elu(f, ['sessions', 'done', id]); assert.equal(r.status, 1, 'from his shell too');
  assert.deepEqual(await runOwnCommand(['sessions', 'done', id], { repo: f.repo, taskId: id, mode: 'full' }), { code: 1, err: `${DONE_REFUSED}\n` });
  assert.equal(cardOf(f, id).column, 'needs');
  // A copy asked from a turn of a session in Approve for me gets Approve for me; the session stays under Needs you.
  chat(f.repo, 90, { goal: 'Plan the next step', permissions: 'auto' });
  r = elu(f, ['sessions', 'copy', id, 'Show the code as typed'], { session: '90' }); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Started a copy of session \d+ .*with the new goal\. It shows in Sessions\./);
  const copy = pendingRequests(f.root).find(row => row.copied);
  assert.equal(copy.permissions, 'auto'); assert.equal(copy.copied.goal, 'Show the code as typed');
  assert.equal(cardOf(f, id).column, 'needs', 'a command never moves it to Done'); assert.equal(readBoard(f.repo).checked?.[id], undefined);
  await until(() => request(f.root, copy.id)?.state === 'done', 'the copy to start'); await until(() => settled(f, request(f.root, copy.id).taskId), 'the copy to work');
  // A new goal from a turn: it carries on, and still waits for his check.
  const turns = leadTurns(readTask(f.repo, id));
  r = elu(f, ['sessions', 'goal', id, 'Trim spaces from coupon codes too'], { session: id }); assert.equal(r.status, 0, r.stderr);
  await until(() => leadTurns(readTask(f.repo, id)) > turns && settled(f, id), 'the new goal to carry on');
  assert.equal(currentTask(f.repo, id).goal, 'Trim spaces from coupon codes too');
  assert.equal(cardOf(f, id).column, 'needs'); assert.equal(readBoard(f.repo).checked?.[id], undefined);
  // A copy of its own record is refused at the queue: only a new session of his starts with one.
  assert.throws(() => enqueue(f.root, 'x', { continuationTaskId: id, copied: { ...sessionTasks(f.repo, id)[0], from: { session: id, task: sessionTasks(f.repo, id)[0].id } } }), { message: 'Only a new session of yours starts with a copy of a Task.' });
});

test('a session that went to Done by itself before this version comes back under Needs you when it was active in the 14 days before; an older one stays in Done', t => {
  const f = setup(t);
  const since = Date.now() - 2 * 86400000, file = path.join(personalDirectory(), 'kanban-checks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify({ since: new Date(since).toISOString() })}\n`);
  assert.equal(readBoard(f.repo).since, since); assert.equal(checksSince(), since);
  const board = () => readBoard(f.repo);
  // Answered 20 days before then: stays in Done, saying how it ended.
  const old = chat(f.repo, 1, { goal: 'Last month', days: 22 });
  assert.equal(sessionPlace(board(), old), 'done'); assert.equal(cardOf(f, '1').detail, 'replied');
  // Answered and published within the 14 days before: back under Needs you.
  const recent = chat(f.repo, 2, { goal: 'This week', days: 5 });
  assert.equal(sessionPlace(board(), recent), 'needs'); assert.equal(cardOf(f, '2').detail, 'replied · check it');
  liveTask(f.root, { id: '3', goal: 'Publish the fix', state: 'done' }); saveTask(f.repo, { ...readTask(f.repo, '3'), pr: 'https://github.com/acme/shop/pull/3', createdAt: new Date(Date.now() - 3 * 86400000).toISOString() });
  assert.equal(cardOf(f, '3').column, 'needs'); assert.equal(cardOf(f, '3').detail, 'published · check it');
  // One he moved to Done himself stays there; one archived leaves the board.
  const moved = chat(f.repo, 4, { goal: 'Moved by him', days: 5 }); setDone(f.repo, { task: moved }, true);
  assert.equal(sessionPlace(board(), moved), 'done');
  const archived = chat(f.repo, 5, { goal: 'Archived', days: 5 }); closeSession(f.repo, '5');
  assert.equal(sessionPlace(board(), archived), null);
  // The stamp is this computer's: written once, never with a board.
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.repo.state, 'kanban.json'), 'utf8')).since, undefined);
});

test('the first build that waits stamps when, once', t => {
  const f = setup(t);
  const file = path.join(personalDirectory(), 'kanban-checks.json');
  assert.equal(fs.existsSync(file), false);
  const at = readBoard(f.repo).since;
  assert.equal(Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).since), at);
  assert.equal(checksSince(), at); assert.ok(Math.abs(Date.now() - at) < 60000);
});

test("a schedule's run that ended waits for his check; the next run archives it as before, which is not his check", t => {
  const f = setup(t);
  const row = saveSchedule({ root: f.root, goal: 'Check the nightly build', when: parseWhen('every 3h') });
  const ran = chat(f.repo, 1, { goal: 'Check the nightly build', scheduleId: row.id });
  assert.equal(cardOf(f, '1').column, 'needs'); assert.equal(cardOf(f, '1').detail, 'replied · check it');
  assert.equal(runScheduleNow(row.id, new Date(), { start: () => true }), true);
  assert.ok(readBoard(f.repo).archived.includes('1'));
  assert.equal(sessionPlace(readBoard(f.repo), ran), null); assert.equal(readBoard(f.repo).checked?.['1'], undefined);
});

test('a card that waits for his check says check it beside its title where it fits, with how it ended where that fits too; a title that fits is never cut for it', () => {
  assert.deepEqual(fitCheckCard('Uppercase coupons', 'published · check it', 40), { title: 'Uppercase coupons', detail: 'published · check it' });
  assert.deepEqual(fitCheckCard('Uppercase coupons', 'ready to publish · check it · done 2/2 · medium · low', 31), { title: 'Uppercase coupons', detail: 'check it' });
  const long = fitCheckCard('Uppercase every coupon code in the shop', 'published · check it', 31);
  assert.equal(long.detail, 'check it'); assert.ok(long.title.length <= 21 && long.title.endsWith('…'), long.title);
  assert.deepEqual(fitCheckCard('Speed up search', 'you · devbox · published · check it', 32, 1), { title: 'Speed up search', detail: 'you · check it' });
  // One of mine on my other computer cuts its title for it, as for the name it carries.
  assert.deepEqual(fitCheckCard('Uppercase coupons', 'you · box-one · ready to publish · check it', 31, 1), { title: 'Uppercase…', detail: 'you · check it' });
  assert.equal(fitCheckCard('Round refunds to cents', 'ready to publish · check it · done 2/2 · high · low', 23), null, 'the whole title, alone');
});

const TASK = { title: 'Uppercase coupons', description: 'Make normalize return upper case.', goal: 'Codes compare equal whatever their case.', objectives: ['normalize returns upper case'], priority: 'medium', severity: 'low' };
const withTask = (repo, id, extra = {}) => { const task = chat(repo, id, { goal: `Session ${id}`, ...extra }); proposeTask(repo, String(id), TASK); approveTask(repo, String(id)); return readTask(repo, String(task.id)); };

// His new goal has no length or count of ours (README, "No caps"): however long, with as many
// objectives as he wrote, Keep open gives it to the session's Task whole, and a copy starts with
// it whole, with all the session before it did.
test('his new goal is taken whole however long and with any number of objectives: kept open, and copied', t => {
  const f = setup(t);
  withTask(f.repo, 11); withTask(f.repo, 12);
  const goal = `Make the export whole. ${'Every word of this goal matters. '.repeat(190)}THE END`;
  const objectives = Array.from({ length: 12 }, (_, index) => `Objective ${index + 1}: ${'it holds whole. '.repeat(25)}done`);
  assert.ok(goal.length > 6000 && objectives.every(text => text.length > 300));
  const text = [goal, ...objectives.map(row => `- ${row}`)].join('\n');
  assert.deepEqual(readGoal(text), { goal, objectives });
  // Keep open, new goal.
  assert.equal(answerCheck(f.repo, f.root, readTask(f.repo, '11'), 'goal', text).answer, 'goal');
  const kept = currentTask(f.repo, '11');
  assert.ok(kept.goal === goal, 'the whole goal'); assert.deepEqual(kept.objectives, objectives);
  assert.equal(pendingRequests(f.root).find(row => row.continuationTaskId === '11').goal, text, 'sent as his message');
  // A copy with it.
  assert.equal(answerCheck(f.repo, f.root, readTask(f.repo, '12'), 'copy', text).answer, 'copy');
  const { copied } = pendingRequests(f.root).find(row => row.copied);
  assert.ok(copied.goal === goal, 'the whole goal'); assert.deepEqual(copied.objectives, objectives);
  // A copy of the session that took it: what it was, whole.
  const again = copySession(f.repo, f.root, readTask(f.repo, '11'), 'Next goal').request.copied;
  assert.ok(again.description.includes(`Goal: ${goal}\nNot met: ${objectives.join('; ')}`), 'its goal and every objective, whole');
});

test("a model's goal or copy gives no session more than its own turn's mode, and never approves a Task where only the owner does", async t => {
  const f = setup(t);
  withTask(f.repo, 7, { permissions: 'full' }); withTask(f.repo, 8, { permissions: 'ask' }); chat(f.repo, 90, { goal: 'Plan the next step', permissions: 'auto' });
  // A turn in Approve for me runs ELU's own commands without asking.
  const run = (...args) => runOwnCommand(['sessions', ...args], { repo: f.repo, taskId: '90', mode: 'auto' });
  assert.deepEqual(await run('goal', '7', 'Push it to production'), { code: 1, err: 'Session 7 has Full access: only you give it a new goal, in ELU: /done.\n' });
  assert.deepEqual(await run('goal', '8', 'Push it to production'), { code: 1, err: 'Session 8 has Ask for approval: only you give it a new goal, in ELU: /done.\n' });
  assert.deepEqual(await run('copy', '8', 'Push it to production'), { code: 1, err: 'Session 8 has Ask for approval: only you copy it, in ELU: /done.\n' });
  assert.deepEqual(pendingRequests(f.root), [], 'nothing runs');
  assert.deepEqual([currentTask(f.repo, '7').goal, currentTask(f.repo, '8').goal], [TASK.goal, TASK.goal]);
});

test('a copy starts from the work its session left in its folder, which ELU commits only to publish; that folder, its index and its branch stay as they were', t => {
  const f = setup(t);
  const { worktree, base } = liveTask(f.root, { id: '3', goal: 'Trim coupon codes', state: 'ready', files: { 'src/coupon.mjs': 'export const normalize = (value) => value.trim();\n', 'src/added.mjs': 'export const added = true;\n' } });
  fs.rmSync(path.join(worktree, 'package.json')); git(worktree, ['add', 'src/added.mjs']);
  proposeTask(f.repo, '3', TASK); approveTask(f.repo, '3');
  const status = git(worktree, ['status', '--porcelain']), staged = git(worktree, ['diff', '--cached', '--name-only']);
  const { branch } = copySession(f.repo, f.root, readTask(f.repo, '3'), 'Show the code as typed');
  assert.equal(branch, 'feat/task-3-next'); assert.equal(git(f.root, ['rev-parse', `${branch}^`]), base);
  assert.equal(git(f.root, ['show', `${branch}:src/coupon.mjs`]), 'export const normalize = (value) => value.trim();');
  assert.equal(git(f.root, ['show', `${branch}:src/added.mjs`]), 'export const added = true;');
  assert.equal(git(f.root, ['ls-tree', '--name-only', branch, 'package.json']), '', 'a file it deleted is gone there too');
  assert.deepEqual([git(worktree, ['rev-parse', 'HEAD']), git(worktree, ['status', '--porcelain']), git(worktree, ['diff', '--cached', '--name-only']), git(worktree, ['branch', '--show-current'])], [base, status, staged, 'feat/task-3'], 'its folder as it was');
  // One with nothing left to commit starts where it ended.
  const { worktree: clean, base: at } = liveTask(f.root, { id: '4', goal: 'Nothing left', state: 'ready', files: {} });
  proposeTask(f.repo, '4', TASK); approveTask(f.repo, '4');
  assert.equal(git(f.root, ['rev-parse', copySession(f.repo, f.root, readTask(f.repo, '4'), 'Next').branch]), at); assert.equal(git(clean, ['status', '--porcelain']), '');
});

test("only his check makes a Task done: moved back out of Done it is open again, and a teammate's handoff hears its result at his check", t => {
  const f = setup(t);
  const origin = { kind: 'handoff', peer: 'b'.repeat(64), name: 'sara', a2aTaskId: 'task-1', threadId: 'thread-1', hop: 1, own: true };
  withTask(f.repo, 1); withTask(f.repo, 2, { origin, result: { outcome: 'done', summary: 'Codes are upper case now.' } });
  const results = () => fs.existsSync(peerFile('outbox')) ? fs.readdirSync(peerFile('outbox')).filter(name => name.startsWith('result-')).map(name => JSON.parse(fs.readFileSync(peerFile('outbox', name), 'utf8'))) : [];
  // Every objective reported met: still approved, and the teammate is told nothing yet.
  for (const id of ['1', '2']) reportProgress(f.repo, id, { met: [1] });
  assert.equal(finishTask(f.repo, '2').state, 'approved'); assert.deepEqual([currentTask(f.repo, '2').state, results()], ['approved', []]);
  for (const id of ['1', '2']) checkDone(f.repo, readTask(f.repo, id));
  assert.deepEqual([currentTask(f.repo, '1').state, sharedTask(currentTask(f.repo, '1')).state], ['done', 'done']);
  assert.deepEqual(results().map(row => [row.peer, row.threadId, row.taskId, row.text]), [[origin.peer, 'thread-1', '2', 'Codes are upper case now.']], 'at his check, once');
  // Shift+← on its card, or a Standup's kanban_move with done false: out of Done, its Task open again, here and for a teammate.
  setDone(f.repo, { task: readTask(f.repo, '1') }, false);
  const task = currentTask(f.repo, '1');
  assert.deepEqual([task.state, task.doneAt, task.checkedAt, sharedTask(task).state, readBoard(f.repo).checked?.['1']], ['approved', null, undefined, 'approved', undefined]);
  assert.equal(sessionPlace(readBoard(f.repo), readTask(f.repo, '1')), 'needs');
  // Checked again: done again.
  checkDone(f.repo, readTask(f.repo, '1')); assert.equal(currentTask(f.repo, '1').state, 'done');
});

test("a session that waits for his check stays on the board however quiet it is, as in Done before; one quiet before then stays in Done", t => {
  const f = setup(t);
  const file = path.join(personalDirectory(), 'kanban-checks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify({ since: new Date(Date.now() - 40 * 86400000).toISOString() })}\n`);
  // Answered, and published, 20 days ago, after this version came: never checked.
  const asked = chat(f.repo, 1, { goal: 'Where is the export?', days: 20 });
  liveTask(f.root, { id: '2', goal: 'Publish the fix', state: 'done' }); saveTask(f.repo, { ...readTask(f.repo, '2'), pr: 'https://github.com/acme/shop/pull/2', createdAt: new Date(Date.now() - 20 * 86400000).toISOString() });
  const published = readTask(f.repo, '2');
  for (const task of [asked, published]) assert.equal(sessionPlace(readBoard(f.repo), task), 'needs', task.id);
  assert.deepEqual([cardOf(f, '1')?.column, cardOf(f, '2')?.column], ['needs', 'needs']);
  // A session that stopped stays hidden after 14 quiet days, as before.
  const stopped = chat(f.repo, 3, { goal: 'Stopped', days: 20, state: 'stopped' });
  assert.equal(sessionPlace(readBoard(f.repo), stopped), null);
  // One answered 60 days ago went to Done by itself before then, and stays there.
  assert.equal(sessionPlace(readBoard(f.repo), chat(f.repo, 4, { goal: 'Old', days: 60 })), 'done');
});

test('when this computer cannot read when it first waited for his check, it counts from when that stamp was written, not from now: what came after waits for his check', t => {
  const f = setup(t);
  const file = path.join(personalDirectory(), 'kanban-checks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{"since": "not a da');
  const written = Date.now() - 30 * 86400000; fs.utimesSync(file, new Date(written), new Date(written));
  assert.ok(Math.abs(checksSince() - written) < 2000, String(checksSince()));
  // Answered 20 days ago, after the stamp: it waits for his check, however long it stays quiet.
  assert.equal(sessionPlace(readBoard(f.repo), chat(f.repo, 1, { goal: 'Where?', days: 20 })), 'needs');
});

test('a session he checked Done comes out of Done when more work comes, with a card or without, and waits for his check again', t => {
  const f = setup(t, { mode: 'answer' });
  // One that a card started, and one without a card.
  for (const id of ['1', '2']) chat(f.repo, id, { goal: `Question ${id}` });
  const card = addCard(f.repo, 'Find the export'); startCard(f.repo, card.id, 'request-1'); linkCards(f.repo, [{ id: 'request-1', taskId: '1' }]);
  for (const id of ['1', '2']) { checkDone(f.repo, readTask(f.repo, id)); assert.equal(sessionPlace(readBoard(f.repo), readTask(f.repo, id)), 'done'); assert.equal(cardOf(f, id).column, 'done'); }
  // Keep open from /done on a session in Done: out of Done at once, before its turn starts.
  keepOpen(f.repo, f.root, readTask(f.repo, '1'), 'And the import?'); keepOpen(f.repo, f.root, readTask(f.repo, '2'), 'And the import?');
  for (const id of ['1', '2']) { assert.notEqual(sessionPlace(readBoard(f.repo), readTask(f.repo, id)), 'done', id); assert.notEqual(cardOf(f, id).column, 'done', id); assert.equal(readBoard(f.repo).checked?.[id], undefined); }
  // Checked again, then a new turn (a message of his that ran, or a model's elu sessions goal): back under Needs you, where he and his other computer check it.
  for (const id of ['1', '2']) {
    checkDone(f.repo, readTask(f.repo, id));
    const later = new Date(Date.now() + 1000).toISOString(); saveTask(f.repo, { ...readTask(f.repo, id), messages: [{ at: later, text: 'One more thing' }], result: { outcome: 'done', summary: 'Here.' } });
    assert.equal(sessionPlace(readBoard(f.repo), readTask(f.repo, id)), 'needs', id);
    assert.deepEqual([cardOf(f, id).column, cardOf(f, id).check, cardOf(f, id).detail], ['needs', true, 'replied · check it'], id);
  }
});

test("what a Standup's model moved to Done before the check comes back under Needs you; what he moved there himself stays", t => {
  const f = setup(t);
  const since = Date.now() - 2 * 86400000, file = path.join(personalDirectory(), 'kanban-checks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify({ since: new Date(since).toISOString() })}\n`);
  for (const id of ['1', '2', '3']) chat(f.repo, id, { goal: `Session ${id}`, state: 'stopped', days: 4 });
  const card = addCard(f.repo, 'Ship the importer'); startCard(f.repo, card.id, 'request-3'); linkCards(f.repo, [{ id: 'request-3', taskId: '3' }]);
  // As ELU 0.1.25 wrote them: the Standup's summary moved 1 and the card of 3 to Done; he moved 2 there himself.
  const at = new Date(since - 86400000).toISOString(), board = JSON.parse(fs.readFileSync(path.join(f.repo.state, 'kanban.json'), 'utf8'));
  board.done = ['1', '2']; board.closed = { 1: at, 2: at }; Object.assign(board.cards[0], { column: 'done', movedAt: at });
  fs.writeFileSync(path.join(f.repo.state, 'kanban.json'), JSON.stringify(board));
  const standup = chat(f.repo, 9, { goal: 'Standup', standup: { rounds: [], updates: [] } });
  const key = crypto.createHash('sha256').update(`standup-board\0${f.repo.root}`).digest('hex').slice(0, 12);
  fs.writeFileSync(path.join(f.repo.state, 'tasks', standup.id, 'standup-kanban.jsonl'), [{ at, text: "Moved 'Session 1' to Done", board: key, session: '1' }, { at, text: "Moved 'Ship the importer' to Done", board: key, card: card.id }].map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.equal(sessionPlace(readBoard(f.repo), readTask(f.repo, '1')), 'needs');
  assert.equal(sessionPlace(readBoard(f.repo), readTask(f.repo, '3')), 'needs'); assert.deepEqual([cardOf(f, '3').column, cardOf(f, '3').check], ['needs', true]);
  assert.equal(sessionPlace(readBoard(f.repo), readTask(f.repo, '2')), 'done');
  // His check moves them to Done for good.
  checkDone(f.repo, readTask(f.repo, '1')); assert.equal(sessionPlace(readBoard(f.repo), readTask(f.repo, '1')), 'done');
});

test("a copy keeps the Task's text whatever the last answer holds: emoji joins and right-to-left marks are taken out, here and from another computer", t => {
  const f = setup(t);
  withTask(f.repo, 5, { goal: 'Session ‏5‎', result: { outcome: 'done', summary: 'Done 👩‍💻 ‫שלום‬ ⁦x⁩ ​ok﻿' } });
  const { request } = copySession(f.repo, f.root, readTask(f.repo, '5'), 'Next goal');
  assert.match(request.copied.description, /Last answer: Done 👩💻 שלום x ok/);
  assert.doesNotMatch(request.copied.description, /[​-‏‪-‮⁦-⁩﻿]/);
  assert.equal(answerCheck(f.repo, f.root, readTask(f.repo, '5'), 'copy', 'Another goal').answer, 'copy');
});

test('while the conductor here runs a build from before the check, a copy is not queued for it, and nothing moves to Done', t => {
  const f = setup(t);
  withTask(f.repo, 5);
  const status = path.join(personalDirectory(), 'conductor', 'state.json');
  fs.mkdirSync(path.dirname(status), { recursive: true });
  const write = extra => fs.writeFileSync(status, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), stopped: false, error: null, queued: 0, runs: [], heartbeatAt: new Date().toISOString(), standup: 1, standupAside: 1, ...extra }));
  t.after(() => fs.rmSync(status, { force: true }));
  write({});
  assert.throws(() => answerCheck(f.repo, f.root, readTask(f.repo, '5'), 'copy', 'Next goal'), /build from before your update/);
  assert.deepEqual(pendingRequests(f.root), []); assert.equal(sessionPlace(readBoard(f.repo), readTask(f.repo, '5')), 'needs');
  write({ copies: 1 });
  assert.equal(answerCheck(f.repo, f.root, readTask(f.repo, '5'), 'copy', 'Next goal').answer, 'copy');
  assert.equal(pendingRequests(f.root).length, 1); assert.equal(sessionPlace(readBoard(f.repo), readTask(f.repo, '5')), 'done');
});

test("a copy starts on the model and folders of the session it copies", t => {
  const f = setup(t);
  const extra = path.join(f.parent, 'docs'); fs.mkdirSync(extra);
  withTask(f.repo, 6, { permissions: 'auto', folders: [extra], runs: [{ role: 'lead', vendor: 'codex', at: new Date().toISOString() }] });
  const { request } = copySession(f.repo, f.root, readTask(f.repo, '6'), 'Next goal');
  assert.deepEqual([request.model, request.folders, request.permissions], [{ vendor: 'codex', model: null }, [fs.realpathSync(extra)], 'auto']);
});

// A session he checked Done is in Done, not archived. Sessions leaves it out of its list as
// before, and never lists it under Archived or counts it there; no clean-up deletes it, from
// his shell or from a model's turn in another session, and its card stays in Done. What he
// archived is listed, counted and cleaned up as before, and so is what a board saved before
// the archived list closed.
test('a session he checked Done is in Done, not archived: /archived never lists or counts it, and no clean-up deletes it', t => {
  const f = setup(t, { mode: 'answer' });
  chat(f.repo, 1, { goal: 'Uppercase coupons' }); chat(f.repo, 2, { goal: 'Old question' }); chat(f.repo, 3, { goal: 'Tidy the docs', permissions: 'auto' });
  checkDone(f.repo, readTask(f.repo, '1')); closeSession(f.repo, '2');
  const listed = (options = {}) => boardRows([projectSnapshot(f.repo)], Date.now(), options).filter(row => row.kind === 'task').map(row => [row.id, row.label]);
  assert.deepEqual(listed(), [['3', 'answered']], 'both leave the list');
  assert.deepEqual(listed({ archived: true }), [['3', 'answered'], ['2', 'archived']], 'only the archived one is under Archived');
  let r = elu(f, ['sessions', '--all']); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"Uppercase coupons" {2}· in Done\n/); assert.match(r.stdout, /"Old question" {2}· archived\n/);
  assert.doesNotMatch(elu(f, ['sessions']).stdout, /Uppercase coupons/, 'out of the list as before');
  // Deleted for good: refused for it in plain words, alone and with every archived one, here and from a model's turn.
  assert.throws(() => deleteSession(f.repo, '1'), { message: 'It is in Done, not archived.' });
  r = elu(f, ['sessions', 'delete', '1'], { session: '3' }); assert.equal(r.status, 1); assert.match(r.stderr, /^Session 1 "Uppercase coupons" is in Done, not archived\.\n$/);
  r = elu(f, ['sessions', 'unarchive', '1']); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Session 1 "Uppercase coupons" is in Done, not archived\./);
  r = elu(f, ['sessions', 'delete', 'archived'], { session: '3' }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^Deleted session 2\.\n$/);
  assert.equal(fs.existsSync(taskDir(f.repo, '1')), true); assert.equal(fs.existsSync(taskDir(f.repo, '2')), false);
  assert.equal(cardOf(f, '1').column, 'done', 'its card stays in Done'); assert.equal(typeof readBoard(f.repo).checked['1'], 'string');
  assert.equal(elu(f, ['sessions', 'delete', 'archived']).stdout.trim(), 'No archived sessions.');
  // A board saved before the archived list closed sessions it did not tell apart: each counts as archived, as before.
  chat(f.repo, 4, { goal: 'Older archive' });
  const file = path.join(f.repo.state, 'kanban.json'), board = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete board.archived; delete board.checked; board.done.push('4'); board.closed['4'] = new Date(Date.now() + 1000).toISOString(); fs.writeFileSync(file, JSON.stringify(board));
  assert.deepEqual(listed({ archived: true }).sort(), [['1', 'archived'], ['3', 'answered'], ['4', 'archived']]);
  assert.equal(deleteSession(f.repo, '4').id, '4'); assert.equal(deleteSession(f.repo, '1').id, '1');
});

// Brought back from the archive (u, elu sessions unarchive, or my other computer's u), a session
// he had checked Done comes out of Done as Shift+← brings it: its Task is open again, here and
// for a teammate, and its card waits for his check under Needs you.
test('a session he checked Done and archived comes back with its Task open, as Shift+← brings it', t => {
  const f = setup(t);
  // 2 has a card, which followed it into Done.
  const card = addCard(f.repo, 'Uppercase the coupons'); startCard(f.repo, card.id, 'request-2');
  for (const id of ['1', '2']) withTask(f.repo, id);
  linkCards(f.repo, [{ id: 'request-2', taskId: '2' }]);
  for (const id of ['1', '2']) { reportProgress(f.repo, id, { met: [1] }); checkDone(f.repo, readTask(f.repo, id)); closeSession(f.repo, id); assert.equal(currentTask(f.repo, id).state, 'done'); }
  assert.equal(readBoard(f.repo).cards[0].column, 'done');
  reopenSession(f.repo, '1');
  const r = elu(f, ['sessions', 'unarchive', '2']); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /is back in the list/);
  for (const id of ['1', '2']) {
    const task = currentTask(f.repo, id);
    assert.deepEqual([task.state, task.checkedAt, sharedTask(task).state, readBoard(f.repo).checked?.[id]], ['approved', undefined, 'approved', undefined], id);
    assert.deepEqual([cardOf(f, id).column, cardOf(f, id).check], ['needs', true], id);
  }
  // One he only archived comes back as it was: its Task stays as it is.
  withTask(f.repo, 3); closeSession(f.repo, '3'); reopenSession(f.repo, '3');
  assert.equal(currentTask(f.repo, '3').state, 'approved');
});

// The check of a session at work is refused before it opens, with the words its answer would
// get, so nothing he types there is lost; my other computer asks the same (elu.remote.check).
test('the check of a session at work is refused before anything is asked', t => {
  const f = setup(t);
  const working = chat(f.repo, 1, { goal: 'Run the tests', state: 'running' }), starting = chat(f.repo, 2, { goal: 'Lint the code', state: 'preparing' });
  assert.throws(() => checkView(f.repo, working), { message: '"Run the tests" is working. Check it when it stops.' });
  assert.throws(() => checkView(f.repo, starting), { message: '"Lint the code" is working. Check it when it stops.' });
  // Once it stops, its check opens as any other: how it ended, in plain words, and its checklist.
  assert.deepEqual(checkView(f.repo, chat(f.repo, 1, { goal: 'Run the tests' })), { title: 'Run the tests', ended: 'replied', first: 'Run the tests', checklist: [{ text: 'Replied', met: true, evidence: 'Its reply is in the chat.' }] });
});
