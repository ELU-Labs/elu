import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, cli, git } from './helpers.mjs';
import { findBin } from '../lib/util.mjs';
import { repository, hooksSnapshotDigest } from '../lib/git.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { preparePublish, publish } from '../lib/publish.mjs';
import { turnClock } from '../lib/turn-limits.mjs';

// A project whose pre-push guard is script (or what script(parent) gives for the test's
// folder), with one ready session to publish. Git is the real one, pushing to a bare
// repository here in place of GitHub, so it runs the guards ELU kept as it runs any pre-push
// hook; GitHub's command line is a stand-in.
function guarded(t, script) {
  const p = project(t), fake = fakeClis(p.parent);
  assert.equal(cli(p.root, ['init', '--yes'], fake.env).status, 0);
  fs.mkdirSync(path.join(p.root, '.githooks')); fs.writeFileSync(path.join(p.root, '.githooks/pre-push'), typeof script === 'function' ? script(p.parent) : script, { mode: 0o755 });
  git(p.root, ['config', 'core.hooksPath', '.githooks']);
  git(p.root, ['add', '.']); git(p.root, ['commit', '-m', 'Configure checks']);
  const r = cli(p.root, ['run', 'Normalize coupons', '--yes'], fake.env); assert.equal(r.json.state, 'ready', r.stdout);
  git(p.root, ['remote', 'add', 'origin', 'https://github.com/example/sample.git']);
  const bare = path.join(p.parent, 'remote.git'); git(p.parent, ['init', '--bare', '-q', bare]);
  const actualGit = findBin('git');
  fs.writeFileSync(path.join(fake.dir, 'git'), `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';const args=process.argv.slice(2);if(args.includes('push'))args[args.indexOf('origin')]=${JSON.stringify(bare)};const r=spawnSync(${JSON.stringify(actualGit)},args,{stdio:'inherit'});process.exit(r.status??1);\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(fake.dir, 'gh'), `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';const args=process.argv.slice(2);if(args[0]==='repo')console.log(JSON.stringify({nameWithOwner:'example/sample',defaultBranchRef:{name:'main'},url:'https://github.com/example/sample'}));else if(args[1]==='list')console.log('[]');else if(args[1]==='view'){const r=spawnSync(${JSON.stringify(actualGit)},['-C',${JSON.stringify(p.root)},'rev-parse','feat/task-1'],{encoding:'utf8'});console.log(JSON.stringify({url:'https://github.com/example/sample/pull/1',isDraft:true,headRefOid:r.stdout.trim()}));}else console.log('https://github.com/example/sample/pull/1');\n`, { mode: 0o755 });
  const previous = process.env.PATH; process.env.PATH = fake.env.PATH; t.after(() => { process.env.PATH = previous; });
  const repo = repository(p.root);
  const pushed = () => git(bare, ['for-each-ref', '--format=%(refname)']).split('\n').includes('refs/heads/feat/task-1');
  return { ...p, repo, task: readTask(repo, '1'), pushed };
}

test('a pre-push guard that works for longer than two minutes is not stopped: the push goes out when it passes', { timeout: 300000 }, async t => {
  // It prints a line every five seconds for two minutes and five seconds, then passes.
  const p = guarded(t, '#!/bin/sh\ni=0\nwhile [ $i -lt 25 ]; do echo "guard still working $i"; sleep 5; i=$((i+1)); done\nexit 0\n');
  const preview = await preparePublish(p.repo, p.task), started = Date.now();
  const done = await publish(p.repo, p.task, preview.confirmationId);
  assert.ok(Date.now() - started > 120000, `the guard ran ${Date.now() - started} ms`);
  assert.equal(done.pushed, true); assert.equal(p.pushed(), true);
});

test('a pre-push guard that prints nothing for the quiet limit is stopped, says so, and nothing is pushed', { timeout: 120000 }, async t => {
  const p = guarded(t, parent => `#!/bin/sh\necho "guard started"\necho $$ > ${JSON.stringify(path.join(parent, 'guard.pid'))}\nsleep 60\nexit 0\n`);
  const before = turnClock.quietSeconds; turnClock.quietSeconds = 2; t.after(() => { turnClock.quietSeconds = before; });
  const preview = await preparePublish(p.repo, p.task), started = Date.now();
  await assert.rejects(() => publish(p.repo, p.task, preview.confirmationId), { message: 'Stopped the pre-push guard after 2 seconds with no output. Nothing was pushed.' });
  assert.ok(Date.now() - started < 30000, `stopped after ${Date.now() - started} ms`);
  assert.equal(p.pushed(), false);
  const pid = Number(fs.readFileSync(path.join(p.parent, 'guard.pid'), 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const until = Date.now() + 5000; alive() && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(alive(), false, 'the guard was stopped');
});

test('guards kept by an earlier version, which stopped them after two minutes, are kept again before the push', { timeout: 60000 }, async t => {
  const p = guarded(t, '#!/bin/sh\nexit 0\n');
  // What an earlier version kept: a dispatcher of its own, and no quiet limit on the task.
  const dispatcher = path.join(p.task.hooksDirectory, 'pre-push');
  fs.writeFileSync(dispatcher, '#!/bin/sh\necho "an earlier version stops this guard after two minutes" >&2\nexit 1\n', { mode: 0o700 });
  const task = readTask(p.repo, '1'); delete task.hooksQuietSeconds; task.hooksSnapshotDigest = hooksSnapshotDigest(task.hooksDirectory); saveTask(p.repo, task);
  const preview = await preparePublish(p.repo, task);
  assert.doesNotMatch(fs.readFileSync(dispatcher, 'utf8'), /earlier version|timeout:120000/);
  assert.equal(readTask(p.repo, '1').hooksQuietSeconds, turnClock.quietSeconds);
  const done = await publish(p.repo, task, preview.confirmationId);
  assert.equal(done.pushed, true); assert.equal(p.pushed(), true);
});

// A guard that fails as guards do, with a non-zero exit, says why in its own words: the app
// shows its last lines, short, and that nothing was pushed, not only that git could not finish.
test('a pre-push guard that fails says its own last lines, short, and that nothing was pushed', { timeout: 60000 }, async t => {
  const long = 'x'.repeat(300);
  const p = guarded(t, `#!/bin/sh\nfor i in 1 2 3 4 5 6; do echo "step $i"; done\necho "${long}"\nsleep 0.3\nprintf '\\033[31mlint: 2 problems in src/coupon.mjs\\033[0m\\n' >&2\nexit 3\n`);
  const preview = await preparePublish(p.repo, p.task);
  const error = await publish(p.repo, p.task, preview.confirmationId).then(() => null, value => value);
  assert.ok(error, 'the push failed');
  assert.equal(error.message, `The pre-push guard failed, so nothing was pushed. It said: step 6 · ${'x'.repeat(159)}… · lint: 2 problems in src/coupon.mjs`);
  assert.equal(p.pushed(), false);
  // One that prints nothing says that.
  const quiet = guarded(t, '#!/bin/sh\nexit 1\n');
  const plan = await preparePublish(quiet.repo, quiet.task);
  await assert.rejects(() => publish(quiet.repo, quiet.task, plan.confirmationId), { message: 'The pre-push guard failed, so nothing was pushed. It printed nothing.' });
  assert.equal(quiet.pushed(), false);
});
