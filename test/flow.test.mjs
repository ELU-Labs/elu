import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, cli, git } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { readTask } from '../lib/state.mjs';
import { assertReady, prBody } from '../lib/publish.mjs';
import { findBin } from '../lib/util.mjs';
import { saveBot } from '../lib/bots.mjs';

function setup(t, mode = 'normal', realSandbox = false) {
  const p = project(t); const f = fakeClis(p.parent, { mode, sandboxBin: realSandbox ? findBin('codex') : null });
  const preview = cli(p.root, ['init'], f.env); assert.equal(preview.json.needsConfirmation, true);
  assert.equal(fs.existsSync(path.join(p.root, '.elu-code')), false);
  const init = cli(p.root, ['init', '--yes'], f.env); assert.equal(init.status, 0, init.stdout);
  assert.ok(init.json.writes.length);
  git(p.root, ['add', '.']); git(p.root, ['commit', '-m', 'Configure checks']);
  return { ...p, ...f };
}
// The session's bots do the review, and a new home comes with @reviewer on Claude. The
// tests of the review loop put it on Codex: the fake Codex is the one that finds fault.
function reviewerOnCodex(p) {
  const previous = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = p.env.XDG_CONFIG_HOME;
  try { saveBot({ name: 'reviewer', vendor: 'codex', instructions: 'Review the change for correctness.' }); }
  finally { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; }
}
const runs = p => fs.readFileSync(p.calls, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const byCodex = row => row.vendor === 'codex' && row.args[0] === 'exec';
test('init, run, checks, the review by the session\'s reviewer bot, and draft body work without publication', (t) => {
  const p = setup(t); const original = git(p.root, ['rev-parse', 'HEAD']);
  const r = cli(p.root, ['run', 'Normalize coupon codes', '--yes'], p.env);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.json.state, 'ready');
  assert.deepEqual(r.json.reviews.map(review => [review.round, review.role]), [[1, 'bot:reviewer']]); assert.equal(r.json.reviewStatus, 'passed');
  assert.match(r.json.draftPrBody, /tests: passed/); assert.match(r.json.draftPrBody, /build: passed/);
  assert.equal(r.json.published, false); assert.equal(r.json.commit, undefined);
  assert.equal(git(p.root, ['branch', '--show-current']), 'main'); assert.equal(git(p.root, ['rev-parse', 'HEAD']), original);
  // @reviewer reviews as itself: on Claude with its own model. No other vendor is started.
  const calls = runs(p), model = row => row.args[row.args.indexOf('--model') + 1];
  assert.deepEqual(calls.filter(row => row.vendor === 'claude' && row.args.includes('-p') && row.args.includes('--model')).map(model), ['opus']);
  assert.equal(calls.some(byCodex), false);
  assert.ok(calls.every((x) => !x.args.includes('push')));
  assert.equal(cli(p.root, ['check', '1'], p.env).status, 0);
  assert.equal(cli(p.root, ['status'], p.env).json.tasks.length, 1);
  assert.match(cli(p.root, ['open', '1'], p.env).json.message, /interactive/);
  assert.equal(cli(p.root, ['policy', 'show'], p.env).status, 0);
  const repo = repository(p.root); const task = readTask(repo, '1');
  fs.appendFileSync(path.join(task.worktree, 'src/coupon.mjs'), '// changed after review\n');
  assert.throws(() => assertReady(task), /out of date/);
});
test('review is bounded to two rounds and unresolved comments prevent done', (t) => {
  const p = setup(t, 'review-block'); reviewerOnCodex(p);
  const r = cli(p.root, ['run', 'Normalize coupons', '--yes'], p.env);
  assert.equal(r.json.state, 'blocked', r.stdout); assert.deepEqual(r.json.reviews.map(review => [review.round, review.role]), [[1, 'bot:reviewer'], [2, 'bot:reviewer']]);
  assert.equal(runs(p).filter(byCodex).length, 2, 'a reviewer bot on another vendor reviews with that vendor');
  const task = readTask(repository(p.root), '1'); assert.throws(() => assertReady(task));
});
test('review fixes get responses, checks rerun, and the final reviewer verifies the change', (t) => {
  const p = setup(t, 'review-fix'); reviewerOnCodex(p); const r = cli(p.root, ['run', 'Normalize coupons', '--yes'], p.env);
  assert.equal(r.json.state, 'ready', r.stdout); assert.equal(r.json.reviews.length, 2);
  assert.match(r.json.draftPrBody, /R1: fixed/);
});
test('questions stop the flow and preserve choices', (t) => {
  const p = setup(t, 'question'); const r = cli(p.root, ['run', 'Choose format', '--yes'], p.env);
  assert.equal(r.json.state, 'needs_input'); assert.equal(r.json.result.question, 'Which format?'); assert.equal(r.json.reviews.length, 0);
});
test('malformed output retries once and leaves a blocked task', (t) => {
  const p = setup(t, 'invalid'); const r = cli(p.root, ['run', 'Normalize coupons', '--yes'], p.env);
  assert.equal(r.status, 1); const task = readTask(repository(p.root), '1');
  assert.equal(task.state, 'blocked'); assert.equal(task.runs.length, 2);
});
test('protected changes fail evidence checks', (t) => {
  const p = setup(t, 'protected'); const r = cli(p.root, ['run', 'Normalize coupons', '--yes'], p.env);
  assert.equal(r.json.state, 'blocked', r.stdout);
});
test('uninstall preserves surrounding owner edits and refuses to lose worktrees', (t) => {
  const p = setup(t); fs.appendFileSync(path.join(p.root, 'AGENTS.md'), '\nOwner text.\n');
  const r = cli(p.root, ['uninstall', '--yes'], p.env); assert.equal(r.status, 0, r.stdout);
  assert.equal(fs.readFileSync(path.join(p.root, 'AGENTS.md'), 'utf8'), '\nOwner text.\n');
  assert.equal(fs.existsSync(path.join(p.root, '.elu-code')), false); assert.equal(fs.existsSync(path.join(p.root, 'CLAUDE.md')), false);
  assert.equal(fs.existsSync(path.join(p.root, '.git/elu-code')), false);
});
test('PR evidence excludes logs, dollar costs, accounts, and known secret strings', () => {
  const body = prBody({ evidence: { changedLines: 2, results: [{ name: 'tests', status: 'passed', logFile: '/private/secret', details: ['TOKEN=secret'] }] }, responses: [{ id: 'R1', action: 'fixed', reason: 'api_key=secret-value' }], reviewStatus: 'passed' });
  assert.doesNotMatch(body, /secret-value|TOKEN=|private\/|cost|account/); assert.match(body, /redacted/);
});
test('the local flow runs npm tests and build inside the installed OS sandbox', { skip: !findBin('codex') }, (t) => {
  const p = setup(t, 'normal', true);
  const r = cli(p.root, ['run', 'Normalize coupons', '--yes'], p.env);
  assert.equal(r.json.state, 'ready', r.stdout);
  assert.ok(r.json.evidence.results.every((row) => row.status === 'passed'));
});
