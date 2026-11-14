import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, git, autoApprove } from './helpers.mjs';
import { ProjectController, taskPatch } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';
import { stopLine } from '../lib/stop-line.mjs';
import { boardRows, rowActions, rowBadge, rowTitle } from '../lib/board.mjs';

// A session whose agent commits its own work with Git, end to end against the stand-in
// Claude Code (commit in fake.json: once, twice, amend, branch, dirty, push).
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function setup(t, options = {}) {
  const p = project(t), fake = fakeClis(p.parent, options);
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  const turns = () => fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.vendor === 'claude' && call.args.includes('-p')).length : 0;
  return { ...p, fake, controller, repo: controller.repo, turns };
}
const NOW = Date.now() + 60000;
// The session's row in Sessions, as the list draws it.
const rowOf = (f, task) => boardRows([{ name: 'shop', root: f.root, activity: [], tasks: [task], queue: [] }], NOW)[0];
const files = (f, id) => taskPatch(f.repo, id).files.map(file => file.path).sort();
// The subject of the newest commit there: the agent's own, never one ELU made.
const subject = task => git(task.worktree, ['log', '-1', '--format=%s']);

for (const [commit, changed, commits] of [['once', ['src/coupon.mjs'], 1], ['twice', ['notes.md', 'src/coupon.mjs'], 2], ['amend', ['notes.md', 'src/coupon.mjs'], 1], ['branch', ['src/coupon.mjs'], 1], ['dirty', ['notes.md', 'src/coupon.mjs'], 1]]) {
  test(`a Full access turn that commits its own work (${commit}) ends as any turn does: checked, with no error and nothing to type`, async t => {
    const f = setup(t, { commit });
    const task = await f.controller.ask('Normalize coupon codes', undefined, { permissions: 'full' }).finished;
    assert.equal(task.error ?? null, null, task.error?.message);
    // The project's checks ran on the real change and passed.
    assert.equal(task.state, 'ready');
    assert.ok(task.evidence.results.some(row => row.name === 'test' && row.status === 'passed') || task.evidence.results.every(row => row.status !== 'failed'), JSON.stringify(task.evidence.results));
    // The agent's commit is the session's: the record is at the folder's HEAD.
    const head = git(task.worktree, ['rev-parse', 'HEAD']);
    assert.match(subject(task), /^(Normalize coupons|Add notes|Normalize coupons, with notes)$/); assert.notEqual(head, task.base);
    assert.equal(git(task.worktree, ['rev-list', '--count', `${task.base}..HEAD`]), String(commits));
    assert.equal(readTask(f.repo, task.id).commit, head);
    assert.equal(stopLine(task), null);
    const row = rowOf(f, task);
    assert.deepEqual([rowBadge(row, NOW).icon, rowBadge(row, NOW).tone], ['✓', 'green']);
    assert.doesNotMatch(rowTitle(row, NOW), /continue/);
    // Changes shows the whole change against the base, commits included.
    assert.deepEqual(files(f, task.id), changed);
  });
}

test('with no checks in the project, a turn that commits all of its work has finished: no !, no retry, no continue', async t => {
  const f = setup(t, { commit: 'once' }); f.controller.draftConfig.checks = [];
  const task = await f.controller.ask('Normalize coupon codes', undefined, { permissions: 'full' }).finished;
  assert.equal(task.error ?? null, null, task.error?.message); assert.equal(task.state, 'unverified');
  assert.equal(stopLine(task), null);
  const row = rowOf(f, task), badge = rowBadge(row, NOW);
  assert.deepEqual([badge.icon, badge.tone, badge.title], ['✓', 'green', 'committed']);
  assert.equal(rowTitle(row, NOW), row.task.title ?? rowTitle(row, NOW)); assert.doesNotMatch(rowTitle(row, NOW), /continue/);
  assert.ok(!rowActions(row).some(([, name]) => name === 'retry'), JSON.stringify(rowActions(row)));
  assert.doesNotMatch(row.now, /not verified|continue/);
});
