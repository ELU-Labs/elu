import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, autoApprove, git } from './helpers.mjs';
import { saveBot } from '../lib/bots.mjs';
import { ProjectController, conversationEntries, taskPatch } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';
import { assertReady } from '../lib/publish.mjs';
import { runChecks } from '../lib/checks.mjs';
import { sessionChecklist } from '../lib/checklist.mjs';
import { changed, notesSpec, taskChanges } from '../lib/git.mjs';
import { spawnSync } from 'node:child_process';
import * as gitParts from '../lib/git.mjs';
import * as runner from '../lib/runner.mjs';

// What a session's review, its checks' changed lines, its Changes tab and its publishing hold is
// what its pull request would hold: what its branch has that the branch it targets (origin's
// main here) does not, measured after ELU fetches that branch. Work the session merged in from
// main, and its own work main holds already, is never part of it. A change of its own that its
// model refuses in one piece is reviewed in parts, and only a file the model refuses on its own
// is left out, with one line that says which.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const CRITIC = { name: 'critic', vendor: 'codex', model: 'big-model', effort: 'xhigh', instructions: 'Look for edge cases.' };
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
function setup(t, mode = 'normal', options = {}) {
  const p = project(t);
  fs.writeFileSync(path.join(p.root, '.gitignore'), 'node_modules/\n'); git(p.root, ['add', '.gitignore']); git(p.root, ['commit', '-m', 'Ignore installed packages']);
  const fake = fakeClis(p.parent, { mode, ...options });
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  saveBot(CRITIC);
  const inputs = vendor => rows(path.join(p.parent, 'inputs.jsonl')).filter(row => row.vendor === vendor);
  return { ...p, fake, controller, repo: controller.repo, inputs, mode: (next, more = {}) => fakeClis(p.parent, { mode: next, ...more }) };
}
// The project as a clone has it: origin is a repository on this computer, and origin/HEAD names
// main. team: a teammate's clone, where other sessions' pull requests are merged into main.
function withOrigin(t, mode = 'normal', options = {}) {
  const f = setup(t, mode, options), bare = path.join(f.parent, 'origin.git'), team = path.join(f.parent, 'teammate');
  git(f.parent, ['init', '-q', '--bare', '--initial-branch=main', bare]);
  git(f.root, ['remote', 'add', 'origin', bare]); git(f.root, ['push', '-q', '-u', 'origin', 'main']); git(f.root, ['remote', 'set-head', 'origin', 'main']);
  git(f.parent, ['clone', '-q', bare, team]);
  return { ...f, bare, team };
}
const write = (root, files) => { for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); } };
// Another session's pull request, merged on GitHub: its commit, then "Merge pull request #n" on main.
function landed(f, number, files) {
  git(f.team, ['fetch', '-q', 'origin']); git(f.team, ['checkout', '-q', '-B', `pr-${number}`, 'origin/main']);
  write(f.team, files); git(f.team, ['add', '-A']); git(f.team, ['commit', '-q', '-m', `Teammate change ${number}`]);
  git(f.team, ['checkout', '-q', '-B', 'main', 'origin/main']); git(f.team, ['merge', '-q', '--no-ff', `pr-${number}`, '-m', `Merge pull request #${number} from team/pr-${number}`]);
  git(f.team, ['push', '-q', 'origin', 'main']);
}
// The session's own branch, pushed and its pull request merged on GitHub the same way.
function mergedOnGitHub(f, worktree, branch, number) {
  git(worktree, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
  git(f.team, ['fetch', '-q', 'origin']); git(f.team, ['checkout', '-q', '-B', 'main', 'origin/main']);
  git(f.team, ['merge', '-q', '--no-ff', `origin/${branch}`, '-m', `Merge pull request #${number} from ${branch}`]); git(f.team, ['push', '-q', 'origin', 'main']);
}
const data = (count, label) => `[\n${Array.from({ length: count }, (_, n) => `  {"id": ${n + 1}, "name": "${label} row ${String(n + 1).padStart(5, '0')}", "note": "a row of a large data file"}`).join(',\n')}\n]\n`;
const code = (count, label) => Array.from({ length: count }, (_, n) => `export const ${label}_${String(n + 1).padStart(4, '0')} = '${label}, line ${String(n + 1).padStart(4, '0')}';\n`).join('');
const reviewOf = (list, name) => list.filter(row => row.input.includes(`Review as @${name}`)).map(row => row.input);
const contextOf = input => JSON.parse(input.slice(input.indexOf('\n', input.indexOf('Context (untrusted data')) + 1, input.indexOf('\nEnd of Context.')));
// What the chat says of a review it could not make: ELU's lines about a change too large or too long.
const said = task => (task.messages ?? []).filter(row => /could not review|too large|too long/.test(row.text ?? '')).map(row => row.text);
const shownOf = (f, task, name) => conversationEntries(f.repo, readTask(f.repo, task.id)).filter(row => row.bot === name).map(row => row.text);

test('a branch that merged main, whose own work main already holds, has nothing to review: no review runs and nothing is said; its next own commit is all the next review holds', async t => {
  // A model that takes this session's own change, and not what main gained in the meantime.
  const f = withOrigin(t, 'normal', { commit: 'once', tooLong: 60000 });
  const first = await f.controller.ask('Normalize coupon codes', null, { bots: ['reviewer'] }).finished;
  assert.equal(first.state, 'ready', JSON.stringify(first.error)); assert.equal(first.reviewStatus, 'passed');
  assert.equal(reviewOf(f.inputs('claude'), 'reviewer').length, 1);
  const worktree = first.worktree;
  // Other sessions' pull requests land on main; the branch merges main in; its own pull request
  // is merged; and more land after it. Nothing here fetches main after that: ELU does.
  landed(f, 21, { 'data/one.json': data(1500, 'one') }); landed(f, 22, { 'data/two.json': data(1500, 'two') });
  git(worktree, ['fetch', '-q', 'origin']); git(worktree, ['merge', '-q', '--no-edit', 'origin/main']);
  mergedOnGitHub(f, worktree, 'feat/task-1', 23);
  landed(f, 24, { 'data/three.json': data(1500, 'three') });
  let task = readTask(f.repo, first.id);
  assert.deepEqual(changed(worktree, task.base).paths, ['data/one.json', 'data/two.json', 'src/coupon.mjs'], 'from where it started, the branch holds what main merged in');
  // The next turn edits nothing new: the pull request would hold nothing, so nothing is reviewed,
  // and nothing is offered to publish: the turn answered, as one that changed nothing does.
  const again = await f.controller.ask('Normalize coupon codes', first.id).finished;
  task = readTask(f.repo, again.id);
  assert.equal(task.state, 'answered', JSON.stringify(task.error)); assert.equal(task.error ?? null, null);
  assert.equal(reviewOf(f.inputs('claude'), 'reviewer').length, 1, 'no review ran');
  assert.deepEqual(said(task), [], 'and the chat says nothing of one');
  assert.equal(task.reviews.length, 1); assert.equal(task.reviewStatus, 'skipped');
  assert.equal(git(worktree, ['rev-parse', 'refs/remotes/origin/main']), git(f.bare, ['rev-parse', 'main']), 'ELU fetched main before it measured');
  assert.deepEqual(taskChanges(task).paths, [], 'its pull request would hold nothing');
  assert.equal(task.evidence.changedLines, 0);
  const view = taskPatch(f.repo, task.id);
  assert.equal(view.files.length, 0); assert.equal(view.compared, 'main, where its pull request goes');
  // Its Task says why in one row, and offers nothing to push or publish; /publish says the same.
  assert.deepEqual(sessionChecklist(task).map(row => [row.text, row.met, row.evidence]), [['Nothing to publish', true, 'Its work is in main already.']]);
  await assert.rejects(f.controller.pushPlan(task.id), { message: 'This response has no code changes to publish.' });
  // One more commit of its own: the review holds that commit's files alone, whole, at once.
  const next = await f.controller.ask('Trim spaces too', first.id).finished;
  task = readTask(f.repo, next.id);
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.reviewStatus, 'passed');
  const reviews = reviewOf(f.inputs('claude'), 'reviewer');
  assert.equal(reviews.length, 2, 'one review, of the change whole');
  const { source } = contextOf(reviews[1]);
  assert.deepEqual(source.files, [{ path: 'src/coupon.mjs', content: 'export const normalize = (value) => value.trim().toUpperCase();\n' }]);
  assert.deepEqual(source.patch.match(/^diff --git .*$/gm), ['diff --git a/src/coupon.mjs b/src/coupon.mjs']);
  assert.equal(task.evidence.changedLines, 2);
  assert.deepEqual(said(task), []);
  assert.deepEqual(taskPatch(f.repo, task.id).files.map(row => row.path), ['src/coupon.mjs']);
  assert.doesNotThrow(() => assertReady(task));
  // A bot the owner asks about the edits is given the same change.
  const answered = await f.controller.ask('why is it uppercase?', first.id, { bot: 'reviewer' }).finished;
  assert.notEqual(answered.state, 'blocked', JSON.stringify(answered.error));
  const chat = f.inputs('claude').filter(row => row.input.includes('You are @reviewer, a bot in a chat')).at(-1)?.input ?? '';
  assert.match(chat, /"path":"src\/coupon\.mjs"/); assert.doesNotMatch(chat, /data\/(?:one|two|three)\.json/);
});

test('a change of its own its model cannot take in one piece is reviewed in parts, as one review whose findings go to the agent', async t => {
  const f = setup(t, 'normal');
  write(f.root, Object.fromEntries([1, 2, 3, 4].map(n => [`lib/part-${n}.mjs`, code(600, `old${n}`)]))); git(f.root, ['add', '-A']); git(f.root, ['commit', '-q', '-m', 'Add four parts']);
  const first = await f.controller.ask('Normalize coupon codes', null, { bots: ['critic'] }).finished;
  assert.equal(first.state, 'ready', JSON.stringify(first.error));
  // The session rewrites the four files whole: more than its model takes, even as the diff alone.
  write(first.worktree, Object.fromEntries([1, 2, 3, 4].map(n => [`lib/part-${n}.mjs`, code(600, `new${n}`)])));
  f.mode('review-fix', { tooLong: 150000 });
  const task = readTask(f.repo, (await f.controller.ask('Normalize coupon codes', first.id).finished).id);
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.error ?? null, null); assert.equal(task.reviewStatus, 'passed');
  // Round 2 found a must-fix in each part: one review, its findings numbered by part. The agent
  // fixed both, and round 3 passed, again in parts.
  assert.deepEqual(task.reviews.slice(1).map(row => [row.round, row.role, row.parts, row.result.comments.map(comment => [comment.id, comment.severity])]),
    [[2, 'bot:critic', 2, [['part1-1', 'must_fix'], ['part2-1', 'must_fix']]], [3, 'bot:critic', 2, []]]);
  assert.deepEqual(task.responses.map(row => [row.round, row.id, row.action]), [[2, 'part1-1', 'fixed'], [2, 'part2-1', 'fixed']]);
  const inParts = "This change is too long for @critic's model in one piece, so it reviewed it in 2 parts.";
  assert.deepEqual(shownOf(f, task, 'critic').slice(-2), [`2 must-fix:\n- Handle the edge case.\n- Handle the edge case.\n${inParts}`, `Passed.\n${inParts}`]);
  assert.deepEqual(said(task), [], 'no file was left out');
  // Each part had its own files and the paths of the rest.
  const reviews = reviewOf(f.inputs('codex'), 'critic').map(input => contextOf(input).source);
  const parts = reviews.filter(source => source.otherFiles).map(source => [source.files.map(row => row.path), source.otherFiles]);
  assert.ok(parts.some(([files, others]) => files.join() === 'lib/part-1.mjs,lib/part-2.mjs' && others.join() === 'lib/part-3.mjs,lib/part-4.mjs,src/coupon.mjs'), JSON.stringify(parts));
  assert.ok(parts.some(([files, others]) => files.join() === 'lib/part-3.mjs,lib/part-4.mjs,src/coupon.mjs' && others.join() === 'lib/part-1.mjs,lib/part-2.mjs'), JSON.stringify(parts));
  assert.doesNotThrow(() => assertReady(task));
});

// The owner gave @reviewer another model and an effort for this session (lib/agent-change.mjs).
// Its review of a change too long for that model in one piece goes in parts, and Claude answers
// one part that it is overloaded: that part alone is tried again after the wait, and the review
// is one review, every turn of it on the model and effort he gave the bot here.
test("a review in parts whose vendor answers one part overloaded tries that part again, on the model the owner gave the bot for this session", { timeout: 120000 }, async t => {
  const waits = runner.overloadClock.waits; runner.overloadClock.waits = [300, 300, 300]; t.after(() => { runner.overloadClock.waits = waits; });
  const f = setup(t, 'normal');
  write(f.root, Object.fromEntries([1, 2, 3, 4].map(n => [`lib/part-${n}.mjs`, code(600, `old${n}`)]))); git(f.root, ['add', '-A']); git(f.root, ['commit', '-q', '-m', 'Add four parts']);
  const first = await f.controller.ask('Normalize coupon codes', null, { bots: ['reviewer'] }).finished;
  assert.equal(first.state, 'ready', JSON.stringify(first.error)); assert.equal(first.reviewStatus, 'passed');
  f.controller.changeAgent(first.id, { bot: 'reviewer', to: { vendor: 'claude', model: 'sonnet', effort: 'high' } });
  write(first.worktree, Object.fromEntries([1, 2, 3, 4].map(n => [`lib/part-${n}.mjs`, code(600, `new${n}`)])));
  // Too long in one piece; and the first part it is given is answered 529 Overloaded once.
  const fake = f.mode('normal', { tooLong: 150000 }), file = path.join(fake.dir, 'fake.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), overloaded: 1, overloadedOn: ['"otherFiles":'] }));
  const launches = () => rows(fake.calls).filter(row => row.vendor === 'claude' && row.args.includes('-p')), before = launches().length, asked = reviewOf(f.inputs('claude'), 'reviewer').length;
  const task = readTask(f.repo, (await f.controller.ask('Normalize coupon codes', first.id).finished).id);
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.error ?? null, null); assert.equal(task.reviewStatus, 'passed');
  // One review, in two parts. The part answered overloaded was given again as it was; the model
  // then said that part was too long, so it was given once more with less, as the next part was.
  assert.deepEqual(task.reviews.slice(1).map(row => [row.role, row.parts, row.result.comments.length]), [['bot:reviewer', 2, 0]]);
  const given = reviewOf(f.inputs('claude'), 'reviewer').slice(asked), parts = given.filter(input => input.includes('"otherFiles":'));
  assert.deepEqual(parts.map(input => contextOf(input).source.files.map(row => row.path).join()), ['lib/part-1.mjs,lib/part-2.mjs', 'lib/part-1.mjs,lib/part-2.mjs', 'lib/part-1.mjs,lib/part-2.mjs', 'lib/part-3.mjs,lib/part-4.mjs,src/coupon.mjs']);
  assert.equal(parts[0], parts[1], 'the try after the wait is the same part, whole');
  assert.ok(parts[2].length < parts[1].length, 'then with less');
  // Every turn of the review ran on the model and effort he gave @reviewer in this session: the
  // change whole, twice, then its parts.
  const reviews = launches().slice(before).filter(call => call.args[call.args.indexOf('--model') + 1] === 'sonnet');
  assert.equal(reviews.length, given.length); assert.equal(given.length, 6);
  assert.ok(reviews.every(call => call.args[call.args.indexOf('--effort') + 1] === 'high'));
  // The chat: one line for the wait, and the review with the line that says it went in parts.
  assert.deepEqual((task.messages ?? []).filter(row => row.from === 'ELU' && row.line).map(row => row.text), ['Claude was overloaded. Tried again once.']);
  assert.deepEqual(shownOf(f, task, 'reviewer').slice(-1), ["Passed.\nThis change is too long for @reviewer's model in one piece, so it reviewed it in 2 parts."]);
  assert.deepEqual(said(task), [], 'no file was left out');
  assert.doesNotThrow(() => assertReady(task));
});

test('a file its model refuses on its own is left out of the review, the chat names it in one line, and publishing never waits for it', async t => {
  const f = setup(t, 'normal', { models: { opus: 'claude-opus-5-5' } });
  write(f.root, { 'backend/x.json': '[]\n', 'src/a.mjs': 'export const a = 1;\n', 'src/b.mjs': 'export const b = 1;\n' }); git(f.root, ['add', '-A']); git(f.root, ['commit', '-q', '-m', 'Add data']);
  const first = await f.controller.ask('Normalize coupon codes', null, { bots: ['reviewer'] }).finished;
  assert.equal(first.state, 'ready', JSON.stringify(first.error));
  write(first.worktree, { 'backend/x.json': data(2679, 'x'), 'src/a.mjs': 'export const a = 2;\n', 'src/b.mjs': 'export const b = 2;\n' });
  assert.equal(fs.readFileSync(path.join(first.worktree, 'backend/x.json'), 'utf8').split('\n').length - 1, 2681);
  f.mode('normal', { models: { opus: 'claude-opus-5-5' }, tooLong: 100000 });
  let task = readTask(f.repo, (await f.controller.ask('Normalize coupon codes', first.id).finished).id);
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.error ?? null, null); assert.equal(task.reviewStatus, 'passed');
  const line = '@reviewer could not review backend/x.json (2,681 lines): too long for Opus. It reviewed the other 3 files.';
  assert.deepEqual(task.messages.filter(row => /could not review|too large/.test(row.text)).map(row => [row.text, row.from]), [[line, 'ELU']]);
  assert.deepEqual(task.reviews.at(-1).left, [{ path: 'backend/x.json', lines: 2681 }]);
  assert.deepEqual(shownOf(f, task, 'reviewer').at(-1), 'Passed.');
  const last = reviewOf(f.inputs('claude'), 'reviewer').map(input => contextOf(input).source).filter(source => source.otherFiles).at(-1);
  assert.deepEqual(last.files.map(row => row.path), ['src/a.mjs', 'src/b.mjs', 'src/coupon.mjs']); assert.deepEqual(last.otherFiles, ['backend/x.json']);
  assert.doesNotThrow(() => assertReady(task), 'publishing waits for no bot over the file it left');
  // A turn that leaves the change as it is reviews it again, and the chat does not say the line again.
  task = readTask(f.repo, (await f.controller.ask('Normalize coupon codes', first.id).finished).id);
  assert.equal(task.reviewStatus, 'passed');
  assert.equal(task.messages.filter(row => row.text === line).length, 1);
  // The same bot on the same model, once it can review no file at all, names that model the same
  // way, though its last run that reviewed reported Opus 5.5.
  assert.equal(task.runs.findLast(row => row.role === 'bot:reviewer' && row.model)?.model, 'claude-opus-5-5');
  write(first.worktree, { 'src/b.mjs': 'export const b = 3;\n' });
  f.mode('normal', { models: { opus: 'claude-opus-5-5' }, tooLong: 'all' });
  task = readTask(f.repo, (await f.controller.ask('Normalize coupon codes', first.id).finished).id);
  assert.equal(task.reviewStatus, 'skipped', JSON.stringify(task.error));
  assert.equal(task.messages.filter(row => row.from === 'ELU').at(-1).text, '@reviewer could not review backend/x.json (2,681 lines), src/a.mjs (1 line) and 2 other files: too long for Opus.');
});

test('the line names the files a bot left out, their lines and its model, and how many files it reviewed', () => {
  assert.equal(runner.leftLine('reviewer', [{ path: 'backend/x.json', lines: 2681 }], { model: 'Opus', reviewed: 63 }), '@reviewer could not review backend/x.json (2,681 lines): too long for Opus. It reviewed the other 63 files.');
  assert.equal(runner.leftLine('reviewer', [{ path: 'a.json', lines: 1 }], { model: 'Opus 5.5', reviewed: 1 }), '@reviewer could not review a.json (1 line): too long for Opus 5.5. It reviewed the other file.');
  assert.equal(runner.leftLine('critic', [{ path: 'a.json', lines: 10 }, { path: 'b.json', lines: null }], { model: 'Big Model' }), '@critic could not review a.json (10 lines) and b.json: too long for Big Model.');
  assert.equal(runner.leftLine('critic', ['a', 'b', 'c', 'd'].map(name => ({ path: `${name}.json`, lines: 1200 })), { model: 'Opus', reviewed: 2 }), '@critic could not review a.json (1,200 lines), b.json (1,200 lines) and 2 other files: too long for Opus. It reviewed the other 2 files.');
  assert.equal(runner.lessLine('critic', { shape: 'parts', parts: 3 }, 'reviewed'), "This change is too long for @critic's model in one piece, so it reviewed it in 3 parts.");
  assert.equal(runner.lessLine('critic', { shape: 'parts', parts: 1, left: [{ path: 'a.json', lines: 1 }] }, 'reviewed'), null, 'one part reviewed: the line about the file left says it all');
});

test('once its pull request goes to another branch, the change is measured from that branch', async t => {
  const f = withOrigin(t, 'normal');
  const first = await f.controller.ask('Normalize coupon codes', null, { bots: ['reviewer'] }).finished;
  assert.equal(first.state, 'ready', JSON.stringify(first.error));
  // A release branch on origin gains a fix the session then merges in; main never has it.
  git(f.team, ['fetch', '-q', 'origin']); git(f.team, ['checkout', '-q', '-B', 'release', 'origin/main']);
  write(f.team, { 'src/release.mjs': 'export const release = 1;\n' }); git(f.team, ['add', '-A']); git(f.team, ['commit', '-q', '-m', 'Release fix']); git(f.team, ['push', '-q', 'origin', 'release']);
  git(first.worktree, ['fetch', '-q', 'origin']); git(first.worktree, ['merge', '-q', '--no-edit', 'origin/release']);
  const task = readTask(f.repo, first.id);
  assert.deepEqual(taskChanges(task).paths, ['src/coupon.mjs', 'src/release.mjs'], 'to main, the release fix is part of it');
  assert.deepEqual(taskChanges({ ...task, prBase: 'release' }).paths, ['src/coupon.mjs'], 'to release, it is not');
  assert.equal(gitParts.targetBranch({ ...task, prBase: 'release' }), 'release');
  assert.equal(gitParts.targetBranch({ ...task, prBase: '--upload-pack=x' }), 'main', 'a name Git would read as an option is never used');
});

test('offline, the change is measured from main as origin last gave it, and nothing is said of it', async t => {
  // Main was fetched, the branch merged it, and origin is out of reach since.
  const f = withOrigin(t, 'normal');
  const first = await f.controller.ask('Normalize coupon codes', null, { bots: ['reviewer'] }).finished;
  assert.equal(first.state, 'ready', JSON.stringify(first.error));
  landed(f, 31, { 'data/one.json': data(50, 'one') });
  git(first.worktree, ['fetch', '-q', 'origin']); git(first.worktree, ['merge', '-q', '--no-edit', 'origin/main']);
  fs.renameSync(f.bare, `${f.bare}.away`);
  const again = readTask(f.repo, (await f.controller.ask('Trim spaces too', first.id).finished).id);
  assert.equal(again.state, 'ready', JSON.stringify(again.error)); assert.equal(again.reviewStatus, 'passed');
  const reviews = reviewOf(f.inputs('claude'), 'reviewer');
  assert.equal(reviews.length, 2);
  assert.deepEqual(contextOf(reviews[1]).source.files.map(row => row.path), ['src/coupon.mjs'], 'what main gave is not part of it');
  assert.deepEqual(said(again), []);
  assert.equal(await gitParts.fetchTarget(again), false, 'the fetch failed, and that stopped nothing');
});

test('with an origin that was never fetched and cannot be reached, the change is measured from where the session started, and nothing is said', async t => {
  const f = setup(t, 'normal');
  git(f.root, ['remote', 'add', 'origin', path.join(f.parent, 'unreachable.git')]);
  const before = Date.now(), task = await f.controller.ask('Normalize coupon codes', null, { bots: ['reviewer'] }).finished;
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.reviewStatus, 'passed');
  assert.ok(Date.now() - before < 60000);
  assert.deepEqual(contextOf(reviewOf(f.inputs('claude'), 'reviewer')[0]).source.files.map(row => row.path), ['src/coupon.mjs']);
  assert.equal((task.messages ?? []).filter(row => row.from === 'ELU').length, 0, 'nothing is said');
  assert.equal(task.evidence.from, undefined, 'the record is as before');
  assert.equal(gitParts.changeBase(readTask(f.repo, task.id)), task.base);
  assert.equal(await gitParts.fetchTarget(readTask(f.repo, task.id)), false);
});

test('a stop while ELU fetches main before the checks ends the fetch at once, and leaves no process behind', async t => {
  const f = withOrigin(t, 'normal');
  const first = await f.controller.ask('Normalize coupon codes', null, {}).finished;
  assert.equal(first.state, 'ready', JSON.stringify(first.error));
  // Origin does not answer: the fetch would wait out FETCH.seconds (20).
  const hang = path.join(f.parent, 'quiet-ssh'); fs.writeFileSync(hang, '#!/bin/sh\nexec sleep 45\n', { mode: 0o755 });
  git(first.worktree, ['remote', 'set-url', 'origin', 'ssh://example.invalid/sample.git']);
  environment(t, { GIT_SSH_COMMAND: hang });
  const stop = new AbortController(), started = Date.now();
  setTimeout(() => stop.abort(new Error('Stopped by the owner.')), 800);
  await assert.rejects(runChecks(f.repo, readTask(f.repo, first.id), { signal: stop.signal }), { message: 'Stopped by the owner.' });
  const took = Date.now() - started;
  assert.ok(took < 5000, `the stop took ${took} ms`);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(spawnSync('pgrep', ['-f', hang], { encoding: 'utf8' }).stdout.trim(), '', 'no fetch is left');
});

test('the digests a record keeps are of the folder from where the session started, as an older ELU reads them', async t => {
  const f = withOrigin(t, 'normal');
  const first = await f.controller.ask('Normalize coupon codes', null, { bots: ['reviewer'] }).finished;
  assert.equal(first.state, 'ready', JSON.stringify(first.error));
  landed(f, 51, { 'data/one.json': data(40, 'one') });
  git(first.worktree, ['fetch', '-q', 'origin']); git(first.worktree, ['merge', '-q', '--no-edit', 'origin/main']);
  // How ELU 0.1.33 measures a session's change: its folder from where it started.
  const older = task => changed(task.worktree, task.base, { ignored: task.place?.kind !== 'here', exclude: notesSpec(task) }).digest;
  let task = readTask(f.repo, (await f.controller.ask('Trim spaces too', first.id).finished).id);
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.reviewStatus, 'passed');
  assert.ok(task.evidence.from, 'measured from main');
  assert.equal(task.evidence.digest, older(task), 'the checks');
  assert.equal(task.reviews.at(-1).digest, older(task), 'the review');
  // What 0.1.33 asks of a record before it publishes: current checks, and a review of them.
  assert.ok(task.reviews.at(-1).digest === task.evidence.digest && older(task) === task.evidence.digest);
  // A bot that could not take the change keeps it the same way, and publishing waits for none.
  write(first.worktree, { 'src/extra.mjs': 'export const extra = 1;\n' });
  f.mode('normal', { tooLong: 'all' });
  task = readTask(f.repo, (await f.controller.ask('Normalize coupon codes', first.id).finished).id);
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.reviewStatus, 'skipped');
  assert.equal(task.evidence.digest, older(task));
  assert.equal(task.unreviewable['bot:reviewer'], older(task));
  assert.doesNotThrow(() => assertReady(task));
});

test("a session that started from the owner's own commits and merged main in has its own work alone in its review, its checks and its Changes tab", async t => {
  const f = withOrigin(t, 'normal');
  // The owner's own commit, which origin does not hold: the session starts from it.
  write(f.root, { 'src/owner.mjs': 'export const owner = 1;\n' }); git(f.root, ['add', '-A']); git(f.root, ['commit', '-q', '-m', 'Owner work']);
  const first = await f.controller.ask('Normalize coupon codes', null, { bots: ['reviewer'] }).finished;
  assert.equal(first.state, 'ready', JSON.stringify(first.error));
  assert.deepEqual(contextOf(reviewOf(f.inputs('claude'), 'reviewer')[0]).source.files.map(row => row.path), ['src/coupon.mjs']);
  // Main gains work, and the session merges it in.
  landed(f, 41, { 'data/one.json': data(40, 'one') });
  git(first.worktree, ['fetch', '-q', 'origin']); git(first.worktree, ['merge', '-q', '--no-edit', 'origin/main']);
  const task = readTask(f.repo, (await f.controller.ask('Trim spaces too', first.id).finished).id);
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.reviewStatus, 'passed');
  const reviews = reviewOf(f.inputs('claude'), 'reviewer');
  assert.equal(reviews.length, 2);
  assert.deepEqual(contextOf(reviews[1]).source.files.map(row => row.path), ['src/coupon.mjs'], "neither main's work nor the owner's");
  assert.deepEqual(taskChanges(task).paths, ['src/coupon.mjs']);
  assert.equal(task.evidence.changedLines, 2);
  assert.deepEqual(taskPatch(f.repo, task.id).files.map(row => row.path), ['src/coupon.mjs'], 'the Changes tab holds the same');
  assert.deepEqual(said(task), []);
});
