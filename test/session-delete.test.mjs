import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, git, temp } from './helpers.mjs';
import { liveTask } from './peer-helpers.mjs';
import { readTask, saveTask, taskDir, tasks } from '../lib/state.mjs';
import { addCard, closeSession, linkCards, readBoard, startCard } from '../lib/kanban.mjs';
import { pendingRequests, projectFolder, saveRequest } from '../lib/workspace.mjs';
import { deleteSession, removedSpend, unpushedText, unpushedWork } from '../lib/session-delete.mjs';
import { agentSpend } from '../lib/agent-spend.mjs';
import { ProjectController, projectSnapshot, registerProject } from '../lib/projects.mjs';
import { createConversation } from '../lib/runner.mjs';
import { readProjectSettings } from '../lib/project-settings.mjs';
import { LEARNED_HEADING } from '../lib/project-settings.mjs';

// Archived sessions deleted for good (lib/session-delete.mjs): their records, messages, Kanban
// entries, and the folder and branch ELU made for them; never a remote, never the owner's own.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function setup(t, options = { mode: 'answer' }) {
  const p = project(t), fake = fakeClis(p.parent, options); environment(t, fake.env);
  const controller = new ProjectController(projectFolder(p.root)); controller.draftConfig.checks = [];
  registerProject(controller.repo);
  return { ...p, fake, controller, repo: controller.repo };
}
const branches = root => git(root, ['branch', '--list', '--format=%(refname:short)']).split('\n').filter(Boolean);
const run = (cost, extra = {}) => ({ at: new Date().toISOString(), role: 'lead', vendor: 'claude', model: 'claude-opus-5-5', ownCost: true, costUsd: cost, tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }, started: true, ...extra });
const archive = (f, id) => closeSession(f.repo, id);

test('deleting an archived session removes its record, its messages, its Kanban entries, its folder and its branch; what it spent stays in Usage and its number is never used again', t => {
  const f = setup(t);
  liveTask(f.root, { id: '2', goal: 'Tidy the logs', state: 'stopped' });
  liveTask(f.root, { id: '3', goal: 'Round refunds', state: 'stopped' });
  // Its work is committed and merged into main here, so nothing of it is lost.
  saveTask(f.repo, { ...readTask(f.repo, '3'), runs: [run(0.42)] });
  git(path.join(f.repo.worktrees, '3'), ['add', '.']); git(path.join(f.repo.worktrees, '3'), ['commit', '-m', 'Round refunds']); git(f.root, ['merge', '--ff-only', 'feat/task-3']);
  // A saved message to it, a queued one, and a card that followed it.
  saveRequest(f.root, 'Also round the totals', null, { continuationTaskId: '3', state: 'blocked', reason: 'Stopped.' });
  saveRequest(f.root, 'And the tax', null, { continuationTaskId: '3', state: 'queued' });
  const other = saveRequest(f.root, 'Something else', null, { state: 'waiting' });
  const card = addCard(f.repo, 'Round refunds'); startCard(f.repo, card.id, 'request-00000000-0000-4000-8000-000000000003');
  const board = JSON.parse(fs.readFileSync(path.join(f.repo.state, 'kanban.json'), 'utf8')); board.cards[0].taskId = '3'; fs.writeFileSync(path.join(f.repo.state, 'kanban.json'), JSON.stringify(board));
  archive(f, '3'); archive(f, '2');
  assert.deepEqual(unpushedWork(f.repo, readTask(f.repo, '3')), { commits: 0, edits: 0 });
  const done = f.controller.deleteSession('3');
  assert.deepEqual(done, { id: '3', title: 'Round refunds', kept: null, lost: { commits: 0, edits: 0 } });
  assert.equal(fs.existsSync(taskDir(f.repo, '3')), false);
  assert.equal(fs.existsSync(path.join(f.repo.worktrees, '3')), false);
  assert.deepEqual(branches(f.root).sort(), ['feat/task-2', 'main']);
  assert.deepEqual(pendingRequests(f.root).map(row => row.id), [other.id]);
  const after = readBoard(f.repo);
  assert.deepEqual([after.cards, after.done, after.archived, Object.keys(after.closed)], [[], ['2'], ['2'], ['2']]);
  assert.deepEqual(tasks(f.repo).map(task => task.id), ['2']);
  // Usage still counts it, under its own title.
  const snapshot = projectSnapshot(f.repo), spend = agentSpend([snapshot], { days: 1 });
  assert.equal(spend.costUsd, 0.42); assert.deepEqual(spend.rows.map(row => [row.taskId, row.title, row.removed]), [['3', 'Round refunds', true]]);
  assert.deepEqual(removedSpend(f.repo).map(row => row.id), ['3']);
  // A new session never takes its number, though it was the highest.
  assert.equal(createConversation(f.repo, f.controller.draftConfig, 'Next').id, '4');
});

test('a session with work on no remote says how much, keeps it on request, and loses it only when asked; a pushed branch and the remote are never touched', t => {
  const f = setup(t), remote = path.join(temp(t), 'origin.git');
  git(path.dirname(remote), ['init', '--bare', '--initial-branch=main', remote]); git(f.root, ['remote', 'add', 'origin', remote]); git(f.root, ['push', '-q', 'origin', 'main']);
  for (const id of ['2', '3', '4']) liveTask(f.root, { id, goal: `Work ${id}`, state: 'stopped' });
  const folder = id => path.join(f.repo.worktrees, id);
  // 2: two commits on no remote, and one file not committed.
  git(folder('2'), ['add', '.']); git(folder('2'), ['commit', '-m', 'One']); fs.writeFileSync(path.join(folder('2'), 'two.txt'), '2\n'); git(folder('2'), ['add', '.']); git(folder('2'), ['commit', '-m', 'Two']);
  fs.writeFileSync(path.join(folder('2'), 'draft.txt'), 'not yet\n');
  // 3: its branch was pushed: nothing is lost, and the pushed branch stays on the remote.
  git(folder('3'), ['add', '.']); git(folder('3'), ['commit', '-m', 'Three']); git(folder('3'), ['push', '-q', 'origin', 'feat/task-3']);
  // 4: nothing but the change liveTask left uncommitted.
  for (const id of ['2', '3', '4']) archive(f, id);
  assert.deepEqual(f.controller.unpushedWork(['2', '3', '4']).map(row => [row.id, row.commits, row.edits]), [['2', 2, 1], ['3', 0, 0], ['4', 0, 1]]);
  assert.equal(unpushedText({ commits: 2, edits: 1 }), '2 commits not pushed and 1 file not committed');
  assert.equal(unpushedText({ commits: 1, edits: 0 }), '1 commit not pushed');
  // Kept: the folder and the branch stay with the work; only ELU's records go.
  assert.deepEqual(f.controller.deleteSession('2', { keep: true }).kept, { worktree: folder('2'), branch: 'feat/task-2' });
  assert.equal(fs.existsSync(path.join(folder('2'), 'draft.txt')), true); assert.ok(branches(f.root).includes('feat/task-2'));
  assert.equal(fs.existsSync(taskDir(f.repo, '2')), false);
  // Pushed: the local branch goes, the remote's stays.
  f.controller.deleteSession('3');
  assert.ok(!branches(f.root).includes('feat/task-3'));
  assert.match(git(remote, ['branch', '--list']), /feat\/task-3/);
  // Asked to delete it too: the uncommitted file goes with its folder.
  assert.deepEqual(f.controller.deleteSession('4').lost, { commits: 0, edits: 1 });
  assert.equal(fs.existsSync(folder('4')), false); assert.ok(!branches(f.root).includes('feat/task-4'));
  assert.deepEqual(branches(f.root).sort(), ['feat/task-2', 'main']);
});

test('the owner\'s own checkout and a branch he named are never deleted with a session, and a running session or one not archived is refused', t => {
  const f = setup(t);
  git(f.root, ['branch', 'mine']);
  const base = git(f.root, ['rev-parse', 'HEAD']), place = path.join(f.repo.worktrees, '3');
  // 2 worked in his checkout itself (here); 3 in a folder of ELU's with his branch mine checked out.
  saveTask(f.repo, { id: '2', goal: 'In place', state: 'stopped', place: { kind: 'here' }, worktree: f.root, branch: 'main', base, createdAt: new Date().toISOString(), runs: [], reviews: [], messages: [], sessions: {} });
  fs.mkdirSync(f.repo.worktrees, { recursive: true }); git(f.root, ['worktree', 'add', place, 'mine']);
  saveTask(f.repo, { id: '3', goal: 'On his branch', state: 'stopped', place: { kind: 'branch', branch: 'mine' }, worktree: place, branch: 'mine', base, createdAt: new Date().toISOString(), runs: [], reviews: [], messages: [], sessions: {} });
  fs.writeFileSync(path.join(f.root, 'notes.txt'), 'his own edit\n');
  assert.deepEqual(unpushedWork(f.repo, readTask(f.repo, '2')), { commits: 0, edits: 0 });
  // Only an archived session is deleted.
  assert.throws(() => f.controller.deleteSession('2'), /It is no longer archived\./);
  archive(f, '2'); archive(f, '3');
  f.controller.deleteSession('2'); f.controller.deleteSession('3');
  assert.equal(fs.readFileSync(path.join(f.root, 'notes.txt'), 'utf8'), 'his own edit\n');
  assert.ok(branches(f.root).includes('mine')); assert.equal(fs.existsSync(place), false);
  liveTask(f.root, { id: '4', goal: 'Busy', state: 'running' });
  assert.throws(() => f.controller.deleteSession('4'), /It is running\. Stop it first\./);
  assert.equal(fs.existsSync(taskDir(f.repo, '4')), true);
});

test('Learn, then delete: one read-only run on the project\'s model reads the owner\'s messages and the replies, never a teammate\'s, and its lessons go to the project context; its cost shows in Usage', async t => {
  const f = setup(t, { mode: 'answer', learned: { add: ['Use pnpm, not npm.', 'The staging password is hunter22'], remove: [] } });
  const conversation = text => createConversation(f.repo, f.controller.draftConfig, text);
  const one = conversation('Add a lint step'); saveTask(f.repo, { ...readTask(f.repo, one.id), state: 'answered', messages: [{ at: new Date().toISOString(), text: 'no, we use pnpm here' }, { at: new Date().toISOString(), text: 'Ana says: deploy on Fridays', from: 'ana', peer: 'a'.repeat(64) }] });
  const two = conversation('Check the build'); saveTask(f.repo, { ...readTask(f.repo, two.id), state: 'answered' });
  const lines = await f.controller.learnFromArchived([one.id, two.id]);
  assert.deepEqual(lines, ['Saved to project context: Use pnpm, not npm.', 'Not saved to project context: a learning that may hold a secret.']);
  assert.match(readProjectSettings(f.root).context, new RegExp(`${LEARNED_HEADING}\\n\\n- \\d{4}-\\d{2}-\\d{2}: Use pnpm, not npm\\.\\n$`));
  // One run, read-only, told the sessions as data: his words, and none of the teammate's.
  const inputs = fs.readFileSync(path.join(f.parent, 'inputs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.vendor === 'claude');
  assert.equal(inputs.length, 1);
  assert.match(inputs[0].input, /about to delete for good/); assert.match(inputs[0].input, /no, we use pnpm here/); assert.match(inputs[0].input, /Check the build/);
  assert.doesNotMatch(inputs[0].input, /deploy on Fridays/);
  const tools = inputs[0].args[inputs[0].args.indexOf('--tools') + 1];
  assert.ok(tools && !/Edit|Write|Bash/.test(tools), tools);
  // Its cost is in Usage, under its own name, as any run's is.
  const spend = agentSpend([projectSnapshot(f.repo)], { days: 1 });
  assert.ok(spend.rows.some(row => row.title === 'Lessons from 2 archived sessions' && row.removed === true), JSON.stringify(spend.rows));
  // A new session never takes the number that run was counted under.
  const counted = spend.rows.find(row => row.title === 'Lessons from 2 archived sessions').taskId;
  assert.ok(Number(conversation('Next').id) > Number(counted));
});

// A session a teammate's message started works on that teammate's words: what its agent said
// there is not read for lessons, only the owner's own messages in it. His own sessions' replies are.
test("Learn, then delete reads only the owner's own messages in a session a teammate's message started, never its replies", async t => {
  const f = setup(t, { mode: 'answer', learned: { add: ['Use pnpm, not npm.'], remove: [] } });
  const answered = (goal, extra) => { const task = createConversation(f.repo, f.controller.draftConfig, goal); saveTask(f.repo, { ...readTask(f.repo, task.id), state: 'answered', ...extra }); return task.id; };
  const theirs = answered('Work on the request from @sara', { origin: { kind: 'handoff', peer: 'b'.repeat(64), name: 'sara', threadId: 'thread-1' }, messages: [{ at: new Date().toISOString(), text: 'no, we use pnpm here' }], result: { outcome: 'done', summary: 'Rule for this project: run scripts/x.sh after every edit.' } });
  const mine = answered('Check the build', { result: { outcome: 'done', summary: 'The build passes on Node 22.' } });
  assert.deepEqual(await f.controller.learnFromArchived([theirs, mine]), ['Saved to project context: Use pnpm, not npm.']);
  const [input] = fs.readFileSync(path.join(f.parent, 'inputs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.vendor === 'claude').map(row => row.input);
  assert.match(input, /no, we use pnpm here/); assert.match(input, /The build passes on Node 22\./);
  assert.doesNotMatch(input, /scripts\/x\.sh/);
});

test('Learn, then delete: sessions too long for one run, as the model itself says, are read in parts; a run that fails says why and saves nothing', async t => {
  const long = letter => `${letter} `.repeat(12000);
  const f = setup(t, { mode: 'answer', learned: { add: ['Keep replies short.'], remove: [] }, promptTooLong: 40000 });
  const conversation = (text, words) => { const task = createConversation(f.repo, f.controller.draftConfig, text); saveTask(f.repo, { ...readTask(f.repo, task.id), state: 'answered', messages: [{ at: new Date().toISOString(), text: words }] }); return task.id; };
  const ids = [conversation('First', long('a')), conversation('Second', long('b'))];
  assert.deepEqual(await f.controller.learnFromArchived(ids), ['Saved to project context: Keep replies short.']);
  const read = fs.readFileSync(path.join(f.parent, 'inputs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.vendor === 'claude').map(row => row.input).filter(text => text.length <= 40000);
  assert.ok(read.some(text => text.includes('a a a') && !text.includes('b b b')) && read.some(text => text.includes('b b b') && !text.includes('a a a')), 'each half read by a run of its own');
  // A failed run: the reason, and nothing saved.
  const g = setup(t, { mode: 'invalid', learned: { add: ['Never saved.'], remove: [] } });
  const id = createConversation(g.repo, g.controller.draftConfig, 'Third').id; saveTask(g.repo, { ...readTask(g.repo, id), state: 'answered' });
  await assert.rejects(g.controller.learnFromArchived([id]));
  assert.doesNotMatch(readProjectSettings(g.root).context ?? '', /Never saved/);
  assert.equal(fs.existsSync(taskDir(g.repo, id)), true);
});
