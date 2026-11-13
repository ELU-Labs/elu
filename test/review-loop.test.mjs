import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { project, fakeClis, autoApprove, git } from './helpers.mjs';
import { saveBot, reviewLoopNote, plainQuestion } from '../lib/bots.mjs';
import { ProjectController, conversationEntries, reviewsEdits } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { assertReady } from '../lib/publish.mjs';
import { changed, outputFolders, publishable, taskChanges } from '../lib/git.mjs';
import { structuralChecks } from '../lib/checks.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { loopStopMessage, stopLine } from '../lib/stop-line.mjs';
import { currentTask, planFile } from '../lib/plan.mjs';
import { reviewRequest } from '../lib/runner.mjs';

// After the agent's edit ELU runs the checks and the session's reviewing bots review the
// change; their must-fix findings go back to the agent. What the agent leaves in its worktree
// by installing or building never stops that loop, the agent is told who reviews it, and the
// owner's own message to a reviewing bot about the edits runs the same loop.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const CRITIC = { name: 'critic', vendor: 'codex', model: 'big-model', effort: 'xhigh', instructions: 'Look for edge cases.' };
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
const isRun = row => row.vendor === 'claude' ? row.args.includes('-p') : row.args[0] === 'exec';
const IGNORE = 'node_modules/\n__pycache__/\n*.egg-info/\nhtmlcov/\n.coverage\n.env\n';
function setup(t, mode = 'normal', options = {}) {
  const p = project(t);
  fs.writeFileSync(path.join(p.root, '.gitignore'), IGNORE); git(p.root, ['add', '.gitignore']); git(p.root, ['commit', '-m', 'Ignore installed packages']);
  const fake = fakeClis(p.parent, { mode, ...options });
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  saveBot(CRITIC);
  const calls = vendor => rows(fake.calls).filter(row => row.vendor === vendor && isRun(row));
  const inputs = vendor => rows(path.join(p.parent, 'inputs.jsonl')).filter(row => row.vendor === vendor);
  return { ...p, fake, controller, repo: controller.repo, calls, inputs, mode: (next, more = {}) => fakeClis(p.parent, { mode: next, ...more }) };
}

test('npm install, pip install -e and a coverage run in the worktree are not a change: the checks run, the reviewer reviews, nothing installed is published, and reading it stays fast', async t => {
  const f = setup(t, 'normal', { install: true });
  const task = await f.controller.ask('Normalize coupon codes').finished;
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.error, null);
  assert.equal(task.reviewStatus, 'passed'); assert.deepEqual(task.reviews.map(review => review.role), ['bot:reviewer'], 'the review loop ran');
  assert.ok(task.evidence.results.length > 2 && task.evidence.results.every(row => row.status === 'passed'), JSON.stringify(task.evidence.results));
  assert.ok(fs.lstatSync(path.join(task.worktree, 'node_modules/.bin/pkg')).isSymbolicLink(), 'the install is there');
  const started = performance.now(), change = taskChanges(task), took = performance.now() - started;
  assert.deepEqual(change.paths, ['src/coupon.mjs']); assert.deepEqual(change.ignored, []); assert.deepEqual(change.unfollowed, []);
  assert.deepEqual(change.trees, ['coupon.egg-info/', 'htmlcov/', 'node_modules/', 'src/__pycache__/']);
  assert.deepEqual(publishable(change), ['src/coupon.mjs']);
  assert.ok(took < 1500, `reading the change took ${Math.round(took)} ms`);
  // The evidence stays current while node_modules is there, and when it changes.
  assert.doesNotThrow(() => assertReady(readTask(f.repo, task.id)));
  fs.writeFileSync(path.join(task.worktree, 'node_modules/pkg/added.js'), 'module.exports = 1;\n');
  assert.equal(taskChanges(task).digest, task.evidence.digest);
  // The agent was told who reviews its change, and that it never hands that to the owner.
  const implement = f.inputs('claude').find(row => row.input.includes('Implement the task.'));
  assert.ok(implement.input.includes("After your turn ELU runs the project's checks, then @reviewer reviews your change. Must-fix findings come back to you, to fix or to dispute with a reason."));
  assert.ok(implement.input.includes('Never ask the owner to wait for a bot, to review, or to commit, push or merge.'));
  assert.equal(conversationEntries(f.repo, task).filter(row => row.bot === 'reviewer').at(-1).text, 'Passed.', 'the chat shows the review');
});

test('an ignored secret file is still caught and an ignored link is never followed, while a tracked or untracked link is still refused', t => {
  const { root } = project(t);
  fs.writeFileSync(path.join(root, '.gitignore'), IGNORE); git(root, ['add', '.gitignore']); git(root, ['commit', '-m', 'Ignore']);
  const base = git(root, ['rev-parse', 'HEAD']), task = { worktree: root, base };
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=1\n');
  const plain = structuralChecks(task, defaultConfig());
  assert.deepEqual(plain.change.ignored, ['.env']);
  const result = name => plain.results.find(row => row.name === name);
  assert.deepEqual([result('secret-paths').status, result('secret-paths').details], ['failed', ['.env']]);
  assert.deepEqual([result('no-ignored-output').status, result('no-ignored-output').details], ['failed', ['.env']]);
  // A link where the secret was: listed and caught, never read or refused.
  fs.rmSync(path.join(root, '.env')); fs.symlinkSync('/etc/hosts', path.join(root, '.env'));
  const linked = structuralChecks(task, defaultConfig());
  assert.deepEqual(linked.change.unfollowed, ['.env']); assert.equal(linked.results.find(row => row.name === 'secret-paths').status, 'failed');
  fs.rmSync(path.join(root, '.env'));
  // Dependency folders are not walked: a link, a large file and a credential-shaped name inside are not changes.
  fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true }); fs.symlinkSync('/etc/hosts', path.join(root, 'node_modules/pkg/.env'));
  fs.writeFileSync(path.join(root, 'node_modules/pkg/big.bin'), Buffer.alloc(5 * 1024 * 1024));
  assert.deepEqual(changed(root, base).paths, []);
  // A link that is not ignored is refused as before: untracked, and tracked.
  fs.symlinkSync('src/coupon.mjs', path.join(root, 'loose-link'));
  assert.throws(() => changed(root, base), /Refusing a symbolic link/);
  fs.rmSync(path.join(root, 'loose-link'));
  fs.symlinkSync('src/coupon.mjs', path.join(root, 'kept-link')); git(root, ['add', 'kept-link']); git(root, ['commit', '-m', 'Add a link']);
  const linkedBase = git(root, ['rev-parse', 'HEAD']);
  fs.rmSync(path.join(root, 'kept-link')); fs.symlinkSync('package.json', path.join(root, 'kept-link'));
  assert.throws(() => changed(root, linkedBase), /Refusing a symbolic link/);
});

test('a build-output folder is not a change only when Git ignores that folder itself: a secret in a tracked src/build or an unignored target is still caught', t => {
  const { root } = project(t);
  fs.writeFileSync(path.join(root, '.gitignore'), '.env\n*.log\nnode_modules/\n*.egg-info/\n.eggs/\nhtmlcov/\n.hypothesis/\nvendor/\n.coverage\n.coverage.*\nout/\n');
  fs.mkdirSync(path.join(root, 'src/build'), { recursive: true }); fs.writeFileSync(path.join(root, 'src/build/index.js'), 'export default 1;\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'Track a build folder']);
  const base = git(root, ['rev-parse', 'HEAD']), task = { worktree: root, base };
  const write = (file, text = 'x\n') => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
  assert.deepEqual(outputFolders('src/build/.env'), ['src/build/']); assert.deepEqual(outputFolders('pkg.egg-info/'), ['pkg.egg-info/']); assert.deepEqual(outputFolders('src/x.js'), []);
  // What pip install -e, pytest-cov, Hypothesis, Composer and npm leave, in folders Git ignores: not a change.
  for (const file of ['coupon.egg-info/PKG-INFO', '.eggs/README.txt', 'htmlcov/index.html', '.hypothesis/examples/a', 'vendor/autoload.php', '.coverage', '.coverage.host.1.2', 'out/build/app.js', 'node_modules/pkg/index.js']) write(file);
  const clean = changed(root, base), trees = ['.eggs/', '.hypothesis/', 'coupon.egg-info/', 'htmlcov/', 'node_modules/', 'out/build/', 'vendor/'];
  assert.deepEqual(clean.paths, []); assert.deepEqual(clean.ignored, []); assert.deepEqual(clean.trees, trees);
  assert.equal(structuralChecks(task, defaultConfig()).results.find(row => row.name === 'no-ignored-output').status, 'passed');
  // Ignored files in folders of those names that Git does not ignore: a tracked src/build, an
  // untracked src/target and a tmp/build whose files are all ignored. Each is listed and checked.
  write('src/build/.env', 'TOKEN=1\n'); write('src/target/.env', 'TOKEN=2\n'); write('src/target/run.log'); write('tmp/build/.env', 'TOKEN=3\n');
  const checked = structuralChecks(task, defaultConfig()), result = name => checked.results.find(row => row.name === name);
  assert.deepEqual([...checked.change.ignored].sort(), ['src/build/.env', 'src/target/.env', 'src/target/run.log', 'tmp/build/.env']);
  assert.deepEqual(checked.change.trees, trees, 'none of those folders is taken for build output');
  assert.deepEqual([result('secret-paths').status, result('secret-paths').details], ['failed', ['src/build/.env', 'src/target/.env', 'tmp/build/.env']]);
  assert.equal(result('no-ignored-output').status, 'failed');
  assert.notEqual(checked.change.digest, clean.digest);
});

test('the owner\'s message to a reviewing bot reviews only edits the session made itself under its Task; otherwise the bot answers in the chat', async t => {
  const f = setup(t, 'normal');
  const ready = await f.controller.ask('Normalize coupon codes', null, { bots: ['critic'] }).finished;
  assert.equal(ready.state, 'ready', JSON.stringify(ready.error)); assert.ok(ready.implementedAt, 'the editing turn finished');
  const saved = readTask(f.repo, ready.id), owner = 'make sure the fixes are real, not nitpicks';
  assert.equal(reviewsEdits(f.repo, saved, 'critic', owner), true);
  // An editing turn of its own that never finished (it failed first, or asked before it ended).
  assert.equal(reviewsEdits(f.repo, { ...saved, implementedAt: undefined }, 'critic', owner), false);
  // An automatic session whose worktree holds only the owner's edits it copied when it started.
  assert.equal(reviewsEdits(f.repo, { ...saved, initialDigest: taskChanges(saved).digest }, 'critic', owner), false);
  assert.equal(reviewsEdits(f.repo, { ...saved, initialDigest: 'before-its-edit' }, 'critic', owner), true);
  // Such a session is not reviewed, and nothing edits: the bot answers in the chat.
  saveTask(f.repo, { ...saved, implementedAt: undefined });
  await assert.rejects(reviewRequest(f.repo, saved.id, owner, { bot: 'critic' }), /no approved Task with edits of its own/);
  const leadRuns = f.calls('claude').length;
  const answered = await f.controller.ask(owner, saved.id, { bot: 'critic' }).finished;
  assert.equal(answered.reviews.length, saved.reviews.length, 'no review ran'); assert.equal(f.calls('claude').length, leadRuns, 'the agent did not run');
  assert.equal(answered.messages.at(-1).bot, 'critic');
  // With no Task the session's work was agreed under, it is not reviewed either.
  fs.rmSync(planFile(f.repo, saved.id));
  assert.equal(reviewsEdits(f.repo, { ...saved }, 'critic', owner), false);
});

test('the agent is told who reviews its change; with none, that no bot does', () => {
  assert.equal(reviewLoopNote(['reviewer', 'pair']), "After your turn ELU runs the project's checks, then @reviewer and @pair review your change. Must-fix findings come back to you, to fix or to dispute with a reason. ELU publishes the change when the owner approves it. Never ask the owner to wait for a bot, to review, or to commit, push or merge.");
  assert.match(reviewLoopNote(['critic'], { again: true }), /^After this turn ELU runs the checks again and @critic reviews your change again\./);
  assert.match(reviewLoopNote([]), /^After your turn ELU runs the project's checks\. No bot reviews this session\. ELU publishes/);
});

test('a plain question to a bot is told apart from a message about the work', () => {
  for (const text of ['why is it uppercase?', '? what changed', 'Is this change risky?']) assert.equal(plainQuestion(text), true, text);
  for (const text of ['work with the agent on the fixes, make sure it does not break anything', 'can you check the fixes?', 'Review it again', 'fix the edge cases']) assert.equal(plainQuestion(text), false, text);
});

test('the owner\'s message to a reviewing bot about the edits runs a review: its must-fix goes to the agent, the checks run again, and it passes', async t => {
  const f = setup(t, 'normal');
  const ready = await f.controller.ask('Normalize coupon codes', null, { bots: ['critic'] }).finished;
  assert.equal(ready.state, 'ready', JSON.stringify(ready.error)); assert.equal(ready.reviews.length, 1);
  const leadRuns = f.calls('claude').length, reviews = f.calls('codex').length, checks = ready.evidence.checkedAt;
  f.mode('review-fix');
  const owner = 'work with the agent on the fixes, make sure it does not break anything and fixes real problems, not nitpicks';
  assert.equal(reviewsEdits(f.repo, readTask(f.repo, ready.id), 'critic', owner), true);
  assert.equal(currentTask(f.repo, ready.id).state, 'done', 'the Task was done before the owner wrote');
  const done = await f.controller.ask(owner, ready.id, { bot: 'critic' }).finished;
  assert.equal(done.state, 'ready', JSON.stringify(done.error)); assert.equal(done.reviewStatus, 'passed');
  assert.deepEqual(done.reviews.slice(1).map(row => [row.round, row.role, row.result.comments.length]), [[2, 'bot:critic', 1], [3, 'bot:critic', 0]]);
  assert.equal(f.calls('codex').length, reviews + 2, 'two reviews and no chat answer');
  assert.equal(f.calls('claude').length, leadRuns + 1, 'the agent ran once, to fix');
  assert.notEqual(done.evidence.checkedAt, checks, 'the checks ran again after the fix');
  // The bot reviewed with the owner's words; the agent got its finding and was told the loop.
  const review = f.inputs('codex').at(-2).input;
  assert.match(review, /Review as @critic/); assert.ok(review.includes(`The owner wrote this to you about the change. Let it guide this review; the agent fixes or disputes each must_fix finding of yours. Use must_fix only for a defect in this change within the session's approved Task; new work beyond that Task is at most a suggestion, never must_fix:\n${owner}`));
  const fix = f.inputs('claude').at(-1).input;
  assert.ok(fix.includes('Address the review') && fix.includes('"body":"Handle the edge case."'));
  // The fix turn worked under the session's Task, opened again for it, and done again when the review passed.
  assert.ok(fix.includes('The owner approved the Task below, and this turn does its work.') && fix.includes('Uppercase coupons'), 'the fix turn carries the approved Task');
  assert.equal(currentTask(f.repo, done.id).state, 'done');
  assert.ok(fix.includes('After this turn ELU runs the checks again and @critic reviews your change again.'));
  // The chat shows each step.
  assert.deepEqual({ ...done.messages.at(-1), at: null }, { at: null, text: owner, to: '@critic', review: true });
  const steps = done.loop.slice(-3).map(({ text, bot, loop }) => ({ text, ...(bot ? { bot } : {}), ...(loop ? { loop } : {}) }));
  assert.deepEqual(steps, [{ text: '1 must-fix:\n- Handle the edge case.', bot: 'critic' }, { text: 'Fixed 1.', loop: true }, { text: 'Passed.', bot: 'critic' }]);
  const shown = conversationEntries(f.repo, done).filter(row => !row.lead || row.loop).slice(-4).map(row => [row.role, row.text]);
  assert.equal(shown[0][0], 'You → @critic'); assert.deepEqual(shown.slice(1).map(row => row[1]), ['1 must-fix:\n- Handle the edge case.', 'Fixed 1.', 'Passed.']);
  assert.doesNotThrow(() => assertReady(readTask(f.repo, done.id)));
  // A plain question gets the bot's answer in the chat, and no review.
  f.mode('normal');
  const answered = await f.controller.ask('why is it uppercase?', done.id, { bot: 'critic' }).finished;
  assert.equal(answered.state, 'ready'); assert.equal(answered.reviews.length, done.reviews.length);
  assert.match(f.inputs('codex').at(-1).input, /You are @critic, a bot in a chat between the owner and the agent/);
  assert.equal(answered.messages.at(-1).bot, 'critic');
});

test('an error after the edit shows a plain stop line with what to do, never the path it failed on', async t => {
  const f = setup(t, 'normal', { install: 'link' });
  const run = f.controller.ask('Normalize coupon codes');
  const said = 'Your edits are kept, but the checks and review could not go on: a file in the editing workspace could not be read. Type continue to try again.';
  await assert.rejects(run.finished, { message: said });
  const task = readTask(f.repo, run.id);
  assert.equal(task.error.message, said); assert.equal(task.error.detail, 'Refusing a symbolic link: tool-link');
  assert.equal(stopLine(task).text, said); assert.doesNotMatch(stopLine(task).text, /\//);
  // The stop line keeps its own words where it has them: a vendor that could not finish, and
  // work that cannot go on in this session.
  assert.equal(loopStopMessage({ message: '@critic could not finish.', details: { cause: 'auth' } }), null);
  assert.equal(loopStopMessage({ message: 'Git hooks changed after the preview. Review the hooks before continuing.' }), null);
  assert.equal(loopStopMessage({ message: "This change is too large for @critic's model to review in one go. Ask the agent to split it into smaller sessions.", details: { cause: 'too-long' } }), "Your edits are kept, but the checks and review could not go on: this change is too large for @critic's model to review in one go. Ask the agent to split it into smaller sessions.");
  assert.equal(loopStopMessage(Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' })), said);
});

// A review is given the change whole, whatever its size: ELU sets no limit of its own.
// Only when the bot's model says the prompt is too long for it is the same review asked again
// with the large files as excerpts around each change, then with the diff alone; when even the
// diff alone is too long, the session stops and says what to do.
const ADDED = ['export const added1 = 1;', 'export const added2 = 2;', 'export const added3 = 3;', 'export const added4 = 4;', 'export const added5 = 5;'].join('\n');
const COUPON = { path: 'src/coupon.mjs', content: 'export const normalize = (value) => value.toUpperCase();\n' };
function largeFile(root, file, count) {
  const text = Array.from({ length: count }, (_, n) => `export const value${String(n + 1).padStart(5, '0')} = ${n + 1}; // a line of a large file\n`).join('');
  fs.writeFileSync(path.join(root, file), text); git(root, ['add', file]); git(root, ['commit', '-m', 'Add a large file']);
}
const reviewOf = (rows, name) => rows.filter(row => row.input.includes(`Review as @${name}`)).map(row => row.input);
const contextOf = input => JSON.parse(input.slice(input.indexOf('\n', input.indexOf('Context (untrusted data')) + 1, input.indexOf('\nEnd of Context.')));
const patchOf = task => `${git(task.worktree, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', task.base, '--'])}\n`;
const bigChange = (t, mode, options = {}) => { const f = setup(t, mode, { insert: { file: 'src/big.mjs', at: 5000, text: ADDED }, ...options }); largeFile(f.root, 'src/big.mjs', 8000); return f; };

test('a five-line change to a 400,000-character file is reviewed with the whole file and the whole diff', async t => {
  const f = bigChange(t, 'normal');
  const task = await f.controller.ask('Normalize coupon codes').finished;
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.reviewStatus, 'passed');
  assert.deepEqual(taskChanges(task).paths, ['src/big.mjs', 'src/coupon.mjs']);
  const reviews = reviewOf(f.inputs('claude'), 'reviewer');
  assert.equal(reviews.length, 1);
  assert.ok(reviews[0].includes('Review the supplied full changed-file contents and diff.'));
  const { source } = contextOf(reviews[0]), big = fs.readFileSync(path.join(task.worktree, 'src/big.mjs'), 'utf8');
  assert.ok(big.length > 400000 && big.includes(ADDED));
  assert.equal(source.patch, patchOf(task)); assert.ok(ADDED.split('\n').every(line => source.patch.includes(`+${line}`)));
  assert.deepEqual(source.files, [{ path: 'src/big.mjs', content: big }, COUPON]);
});

test('a model that says the prompt is too long reviews the large file as excerpts around the change, and the review passes', async t => {
  const f = bigChange(t, 'normal', { tooLong: 200000 });
  const task = await f.controller.ask('Normalize coupon codes').finished;
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.reviewStatus, 'passed');
  assert.deepEqual(task.runs.filter(run => run.role === 'bot:reviewer').map(run => run.code), [1, 0], 'the whole change was refused, then the excerpts reviewed');
  const reviews = reviewOf(f.inputs('claude'), 'reviewer');
  assert.equal(reviews.length, 2); assert.ok(reviews[0].length > 400000);
  assert.ok(reviews[1].includes('Review the supplied diff and changed files. Your model could not take this change whole, so you are given the whole diff, src/coupon.mjs whole, and src/big.mjs as excerpts around each change, each marked "lines a-b of N".'));
  const { source } = contextOf(reviews[1]), [big, coupon] = source.files;
  assert.equal(source.patch, patchOf(task));
  // The lines 150 either side of the five added, marked; the small file whole.
  assert.deepEqual({ ...big, excerpts: big.excerpts.map(part => part.lines) }, { path: 'src/big.mjs', excerpts: ['4851-5155 of 8005'] });
  const lines = big.excerpts[0].text.split('\n');
  assert.equal(lines.length, 305); assert.equal(lines[0], 'export const value04851 = 4851; // a line of a large file'); assert.equal(lines.at(-1), 'export const value05150 = 5150; // a line of a large file');
  assert.ok(big.excerpts[0].text.includes(ADDED));
  assert.deepEqual(coupon, COUPON);
});

// Claude Code refuses input over 10MB before it starts. That is a review too long for it, as a
// model's refusal is: the same review is given the change in a smaller shape. The refused run
// started nothing and spent nothing, and names the model it was asked for.
test('a review Claude Code refuses for its input size is reviewed as excerpts, and the refused run spent nothing', async t => {
  const f = bigChange(t, 'normal', { stdinLimit: 200000 });
  const task = await f.controller.ask('Normalize coupon codes').finished;
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.reviewStatus, 'passed');
  const runs = task.runs.filter(run => run.role === 'bot:reviewer');
  assert.deepEqual(runs.map(run => [run.code, run.started ?? true, run.costUsd, run.ownCost]), [[1, false, 0, true], [0, true, 0, true]], 'the whole change was refused before it started, then the excerpts reviewed');
  assert.ok(runs.every(run => run.asked === runs[0].asked && runs[0].asked), 'each names the model it was asked for');
  const reviews = reviewOf(f.inputs('claude'), 'reviewer');
  assert.equal(reviews.length, 1, 'the refused input never reached the model');
  assert.ok(reviews[0].includes('as excerpts around each change'));
});

test('a model that takes no file of the change reviews its diff alone', async t => {
  const f = bigChange(t, 'normal', { tooLong: 'files' });
  const task = await f.controller.ask('Normalize coupon codes').finished;
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.reviewStatus, 'passed');
  const reviews = reviewOf(f.inputs('claude'), 'reviewer');
  assert.equal(reviews.length, 3); assert.ok(reviews[1].includes('"lines":"4851-5155 of 8005"'));
  assert.ok(reviews[2].includes('Review the supplied diff and changed files. Your model could not take this change with its files, so you are given its diff alone and the changed files by path only.'));
  const { source } = contextOf(reviews[2]);
  assert.equal(source.patch, patchOf(task));
  assert.deepEqual(source.files, [{ path: 'src/big.mjs', content: null }, { path: 'src/coupon.mjs', content: null }]);
});

test('a model that takes not even the diff stops the session with what to do, and the edits are kept', async t => {
  const f = bigChange(t, 'normal', { tooLong: 'all' });
  const run = f.controller.ask('Normalize coupon codes');
  const said = "Your edits are kept, but the checks and review could not go on: this change is too large for @reviewer's model to review in one go. Ask the agent to split it into smaller sessions.";
  await assert.rejects(run.finished, { message: said });
  const task = readTask(f.repo, run.id);
  assert.notEqual(task.state, 'ready'); assert.equal(task.error.message, said); assert.equal(stopLine(task).text, said);
  assert.equal(reviewOf(f.inputs('claude'), 'reviewer').length, 3, 'whole, excerpts, then the diff alone');
  assert.ok(fs.readFileSync(path.join(task.worktree, 'src/big.mjs'), 'utf8').includes(ADDED), 'the edits are kept');
});

test('a must-fix found in the excerpts of a change too long for the model goes to the agent, and the review runs again', async t => {
  const f = bigChange(t, 'review-fix', { tooLong: 200000 });
  const task = await f.controller.ask('Normalize coupon codes', null, { bots: ['critic'] }).finished;
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.reviewStatus, 'passed');
  assert.deepEqual(task.reviews.map(row => [row.round, row.role, row.result.comments.length]), [[1, 'bot:critic', 1], [2, 'bot:critic', 0]]);
  assert.deepEqual(task.responses.map(row => [row.id, row.action]), [['R1', 'fixed']]);
  const reviews = reviewOf(f.inputs('codex'), 'critic');
  assert.equal(reviews.length, 4, 'each round: the whole change refused, then the excerpts');
  for (const [at, input] of reviews.entries()) assert.equal(input.includes('"lines":"4851-5155 of 8005"'), at % 2 === 1);
});
