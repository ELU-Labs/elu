import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { project, fakeClis, cli, git, CLI } from './helpers.mjs';
import { findBin } from '../lib/util.mjs';
import { repository, hooksSnapshotDigest } from '../lib/git.mjs';
import { lock, readTask, saveTask } from '../lib/state.mjs';
import { preparePublish, publish } from '../lib/publish.mjs';
import * as published from '../lib/publish.mjs';
import { ProjectController, projectSnapshot } from '../lib/projects.mjs';
import { pushStopNote } from '../lib/task-head.mjs';
import { turnClock } from '../lib/turn-limits.mjs';

// A project whose pre-push guard is script (or what script(parent) gives for the test's
// folder), with one ready session to publish. Git is the real one, pushing to a bare
// repository here in place of GitHub, so it runs the guards ELU kept as it runs any pre-push
// hook; GitHub's command line is a stand-in. receive: what takes the push on the other side in
// place of git receive-pack (receive(parent, git) for the test's folder and the real git), as a
// GitHub that does not answer. git ls-remote asks the same bare repository; with a file named
// no-answer in the test's folder it waits and answers nothing.
function guarded(t, script, { receive = null } = {}) {
  const p = project(t), fake = fakeClis(p.parent);
  assert.equal(cli(p.root, ['init', '--yes'], fake.env).status, 0);
  fs.mkdirSync(path.join(p.root, '.githooks')); fs.writeFileSync(path.join(p.root, '.githooks/pre-push'), typeof script === 'function' ? script(p.parent) : script, { mode: 0o755 });
  git(p.root, ['config', 'core.hooksPath', '.githooks']);
  git(p.root, ['add', '.']); git(p.root, ['commit', '-m', 'Configure checks']);
  const r = cli(p.root, ['run', 'Normalize coupons', '--yes'], fake.env); assert.equal(r.json.state, 'ready', r.stdout);
  git(p.root, ['remote', 'add', 'origin', 'https://github.com/example/sample.git']);
  const bare = path.join(p.parent, 'remote.git'); git(p.parent, ['init', '--bare', '-q', bare]);
  const actualGit = findBin('git'), taker = path.join(p.parent, 'receive-pack'), silent = path.join(p.parent, 'no-answer');
  if (receive) fs.writeFileSync(taker, receive(p.parent, actualGit), { mode: 0o755 });
  fs.writeFileSync(path.join(fake.dir, 'git'), `#!${process.execPath}\nimport fs from 'node:fs';import {spawnSync} from 'node:child_process';const args=process.argv.slice(2);if(args.includes('push')){args[args.indexOf('origin')]=${JSON.stringify(bare)};if(fs.existsSync(${JSON.stringify(taker)}))args.splice(args.indexOf('push')+1,0,'--receive-pack='+${JSON.stringify(taker)});}if(args.includes('ls-remote')){if(fs.existsSync(${JSON.stringify(silent)}))spawnSync('sleep',['60']);args[args.indexOf('ls-remote')+1]=${JSON.stringify(bare)};}const r=spawnSync(${JSON.stringify(actualGit)},args,{stdio:'inherit'});process.exit(r.status??1);\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(fake.dir, 'gh'), `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';const args=process.argv.slice(2);if(args[0]==='repo')console.log(JSON.stringify({nameWithOwner:'example/sample',defaultBranchRef:{name:'main'},url:'https://github.com/example/sample'}));else if(args[1]==='list')console.log('[]');else if(args[1]==='view'){const r=spawnSync(${JSON.stringify(actualGit)},['-C',${JSON.stringify(p.root)},'rev-parse','feat/task-1'],{encoding:'utf8'});console.log(JSON.stringify({url:'https://github.com/example/sample/pull/1',isDraft:true,headRefOid:r.stdout.trim()}));}else console.log('https://github.com/example/sample/pull/1');\n`, { mode: 0o755 });
  const previous = process.env.PATH; process.env.PATH = fake.env.PATH; t.after(() => { process.env.PATH = previous; });
  const repo = repository(p.root);
  const pushed = () => git(bare, ['for-each-ref', '--format=%(refname)']).split('\n').includes('refs/heads/feat/task-1');
  return { ...p, repo, task: readTask(repo, '1'), pushed, fake, silent };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check, message, timeout = 20000) {
  for (const end = Date.now() + timeout; !check();) { if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 25)); }
}
// A guard that writes its process id and then works on, printing nothing more.
const busyGuard = parent => `#!/bin/sh\necho "guard started"\necho $$ > ${JSON.stringify(path.join(parent, 'guard.pid'))}\nsleep 60\nexit 0\n`;
// ELU's own folder for the test's project, as its command line has it.
function ownFolder(t, p) {
  const previous = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = p.fake.env.XDG_CONFIG_HOME;
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
}
const guardPid = p => { try { return Number(fs.readFileSync(path.join(p.parent, 'guard.pid'), 'utf8')) || null; } catch { return null; } };


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

// Guards kept by 0.1.25 or earlier ran in a sandbox that closed the owner's home secrets under
// HOME's name only. With no step of the owner's they are kept again before the push, which runs
// them in this version's sandbox, closed under both of the home's names: when the session was
// started by that version, and when that version also previewed the push this one approves.
test('guards kept by 0.1.25 or earlier are kept again before the push, which runs them in the new sandbox', { timeout: 60000 }, async t => {
  const fixture = () => {
    const p = guarded(t, '#!/bin/sh\nexit 0\n'), record = path.join(p.parent, 'sandbox.jsonl'), helper = path.join(p.parent, 'sandbox-helper');
    // The sandbox keeps what it was given, then runs the guard.
    fs.writeFileSync(helper, `#!${process.execPath}\nimport fs from 'node:fs';import {spawnSync} from 'node:child_process';const args=process.argv.slice(2);if(args.includes('elu-code-sandbox-probe')){console.log(JSON.stringify({writeDenied:true,networkDenied:true}));process.exit(0);}fs.appendFileSync(${JSON.stringify(record)},JSON.stringify(args)+'\\n');const run=args.slice(args.indexOf('--')+1);process.exit(spawnSync(run[0],run.slice(1),{stdio:'inherit'}).status??1);\n`, { mode: 0o755 });
    const settings = path.join(p.fake.dir, 'fake.json'); fs.writeFileSync(settings, JSON.stringify({ ...JSON.parse(fs.readFileSync(settings, 'utf8')), sandboxBin: helper }));
    return { ...p, record };
  };
  // What 0.1.25 kept: HOME's name alone, and no version mark.
  const olden = (repo) => {
    const task = readTask(repo, '1'), file = path.join(task.hooksDirectory, 'pre-push');
    const old = fs.readFileSync(file, 'utf8').split('\n').filter(line => !line.startsWith('// ')).join('\n').replace(/import\{homeNames\}from "[^"]+";/, '').replace(/homeNames\(\)\.flatMap\(home=>(\[[^\]]+\])\.map\(name=>path\.join\(home,name\)\)\)/, '$1.map(name=>path.join(os.homedir(),name))');
    assert.match(old, /\]\.map\(name=>path\.join\(os\.homedir\(\),name\)\)/); assert.doesNotMatch(old, /homeNames/);
    fs.writeFileSync(file, old, { mode: 0o700 }); task.hooksSnapshotDigest = hooksSnapshotDigest(task.hooksDirectory); saveTask(repo, task);
    return task;
  };
  // The push runs with a home reached through a link, which has two names.
  const pushing = async (p, steps) => {
    const home = path.join(p.parent, 'home'), link = path.join(p.parent, 'home-link'), before = process.env.HOME;
    fs.mkdirSync(home); fs.symlinkSync(home, link); process.env.HOME = link;
    try { await steps(); } finally { process.env.HOME = before; }
    assert.equal(p.pushed(), true);
    const given = fs.readFileSync(p.record, 'utf8');
    for (const name of ['.ssh', '.aws', '.config', '.claude', '.codex', '.netrc', '.npmrc']) for (const at of [home, link]) assert.ok(given.includes(JSON.stringify(`${JSON.stringify(path.join(at, name))}="deny"`).slice(1, -1)), `${at}/${name}`);
  };
  // Started by 0.1.25: previewed and pushed now.
  const started = fixture();
  await pushing(started, async () => {
    const preview = await preparePublish(started.repo, olden(started.repo));
    assert.equal((await publish(started.repo, readTask(started.repo, '1'), preview.confirmationId)).pushed, true);
  });
  // Previewed by 0.1.25, approved now.
  const approved = fixture();
  await pushing(approved, async () => {
    const plan = await preparePublish(approved.repo, approved.task);
    assert.equal((await publish(approved.repo, olden(approved.repo), plan.confirmationId)).pushed, true);
  });
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

// The push itself has the quiet limit too: one that prints nothing for it, as when GitHub
// does not answer, is stopped, and says so with what reached GitHub.
test('a push that prints nothing for the quiet limit is stopped, says so and that nothing reached GitHub', { timeout: 120000 }, async t => {
  const p = guarded(t, '#!/bin/sh\nexit 0\n', { receive: parent => `#!/bin/sh\necho $$ > ${JSON.stringify(path.join(parent, 'taker.pid'))}\nsleep 60\n` });
  const before = turnClock.quietSeconds; turnClock.quietSeconds = 2; t.after(() => { turnClock.quietSeconds = before; });
  const preview = await preparePublish(p.repo, p.task), started = Date.now();
  await assert.rejects(() => publish(p.repo, p.task, preview.confirmationId), { message: 'Stopped the push after 2 seconds with no output. Nothing reached GitHub.' });
  assert.ok(Date.now() - started < 30000, `stopped after ${Date.now() - started} ms`);
  assert.equal(p.pushed(), false);
  const taker = Number(fs.readFileSync(path.join(p.parent, 'taker.pid'), 'utf8'));
  await until(() => !alive(taker), 'what took the push to end');
  const task = readTask(p.repo, '1');
  assert.equal(task.pushRun, undefined); assert.equal(pushStopNote(task), 'Stopped the push after 2 seconds with no output. Nothing reached GitHub.');
});

// /stop in the session stops a push that runs, with the pre-push guard and the whole group it
// runs in, and says in one line what reached GitHub. The session keeps that line under its
// chat, and its lock is free again. Closing ELU stops a push the same way, and says so.
test('/stop stops a running push and its pre-push guard, says nothing was pushed, and frees the session; closing ELU does the same', { timeout: 120000 }, async t => {
  const p = guarded(t, busyGuard); ownFolder(t, p);
  const controller = new ProjectController(p.repo);
  assert.equal(controller.pushing('1'), false); assert.equal(controller.stopPush('1'), false, 'nothing to stop before the push');
  let plan = await controller.pushPlan('1');
  let going = controller.push('1', plan.confirmationId); going.catch(() => {});
  await until(() => guardPid(p), 'the guard to start');
  const guard = guardPid(p);
  assert.equal(controller.pushing('1'), true); assert.ok(readTask(p.repo, '1').pushRun?.pid, 'the push is on the session\'s record');
  assert.equal(controller.stopPush('1'), true);
  const error = await going.then(() => null, value => value);
  assert.equal(error?.message, 'Stopped the push and its pre-push guard. Nothing was pushed.'); assert.equal(error.pushStopped, true);
  await until(() => !alive(guard), 'the guard to end', 5000);
  assert.equal(p.pushed(), false); assert.equal(controller.pushing('1'), false); assert.equal(controller.stopPush('1'), false);
  let task = readTask(p.repo, '1');
  assert.equal(task.pushRun, undefined); assert.equal(task.pushedCommit, undefined);
  assert.equal(pushStopNote(task), 'Stopped the push and its pre-push guard. Nothing was pushed.');
  lock(p.repo, 'task-1')();
  // Closing ELU: the same, and the line says ELU closed.
  fs.rmSync(path.join(p.parent, 'guard.pid'));
  plan = await controller.pushPlan('1'); going = controller.push('1', plan.confirmationId); going.catch(() => {});
  await until(() => guardPid(p), 'the guard to start again');
  assert.equal(readTask(p.repo, '1').pushStop, undefined, 'a new push clears the last one\'s line');
  const again = guardPid(p);
  assert.equal(published.pushesRunning(), 1);
  assert.equal(await published.stopPushes('closed'), 1);
  task = readTask(p.repo, '1');
  assert.equal(pushStopNote(task), 'ELU closed during the push and stopped it. Nothing was pushed.'); assert.equal(task.pushRun, undefined);
  await assert.rejects(going, { message: 'ELU closed during the push and stopped it. Nothing was pushed.' });
  await until(() => !alive(again), 'the guard to end', 5000);
  assert.equal(p.pushed(), false); lock(p.repo, 'task-1')();
});

// Stopped once the guards have passed, the push asks GitHub whether the commit got there, and
// says it: there, not there, or that GitHub did not answer.
test('a push stopped after the guards says truthfully whether the commit reached GitHub', { timeout: 120000 }, async t => {
  // It takes the push and then stays, as a connection that hangs after GitHub updated the branch.
  const p = guarded(t, '#!/bin/sh\nexit 0\n', { receive: (parent, gitBin) => `#!/bin/sh\n${JSON.stringify(gitBin)} receive-pack "$@"\nsleep 60\n` });
  const preview = await preparePublish(p.repo, p.task), going = publish(p.repo, p.task, preview.confirmationId); going.catch(() => {});
  await until(() => p.pushed(), 'GitHub to have the branch');
  assert.equal(published.stopPush(p.repo, '1'), true);
  await assert.rejects(going, { message: 'Stopped the push, but it had already reached GitHub: /publish finishes it.' });
  const task = readTask(p.repo, '1');
  assert.equal(task.pushedCommit, task.commit, 'the session knows the commit is pushed');
  assert.equal(pushStopNote(task), 'Stopped the push, but it had already reached GitHub: /publish finishes it.');
  // Nothing taken, and GitHub does not answer the question: ELU says it could not tell.
  const q = guarded(t, '#!/bin/sh\nexit 0\n', { receive: () => '#!/bin/sh\nsleep 60\n' });
  const limit = published.REMOTE_CHECK.seconds; published.REMOTE_CHECK.seconds = 1; t.after(() => { published.REMOTE_CHECK.seconds = limit; });
  fs.writeFileSync(q.silent, '');
  const plan = await preparePublish(q.repo, q.task), waiting = publish(q.repo, q.task, plan.confirmationId); waiting.catch(() => {});
  await until(() => readTask(q.repo, '1').pushRun, 'the push to start');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(published.stopPush(q.repo, '1'), true);
  await assert.rejects(waiting, { message: 'Stopped the push. ELU could not tell whether it reached GitHub: /publish pushes it again.' });
  fs.rmSync(q.silent);
  assert.equal(q.pushed(), false); assert.equal(readTask(q.repo, '1').pushedCommit, undefined);
});

// The command line's push stops on Ctrl-C with its guard, and says so. One whose ELU was
// killed outright leaves git and its guard running on their own: the next look at the project
// stops them, and the session says what happened.
test('Ctrl-C stops the command line\'s push and its guard; a push left by an ELU that was killed is stopped on the next look and said', { timeout: 120000 }, async t => {
  const p = guarded(t, busyGuard), env = { ...process.env, ...p.fake.env, PATH: process.env.PATH }; ownFolder(t, p);
  const launch = id => { const child = spawn(process.execPath, [CLI, 'run', '1', '--publish', '--approve-push', id, '--json'], { cwd: p.root, env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; child.stdout.on('data', chunk => { out += chunk; }); const ended = new Promise(resolve => child.on('close', code => resolve({ code, out }))); t.after(() => { try { child.kill('SIGKILL'); } catch { /* Ended. */ } }); return { child, ended }; };
  let plan = await preparePublish(p.repo, p.task), run = launch(plan.confirmationId);
  await until(() => guardPid(p), 'the guard to start');
  const guard = guardPid(p);
  run.child.kill('SIGINT');
  const { code, out } = await run.ended;
  assert.equal(code, 1); assert.equal(JSON.parse(out).message, 'Stopped the push and its pre-push guard. Nothing was pushed.');
  await until(() => !alive(guard), 'the guard to end', 5000);
  assert.equal(p.pushed(), false);
  // Killed outright: git and the guard go on, the lock names a process that is gone.
  fs.rmSync(path.join(p.parent, 'guard.pid'));
  plan = await preparePublish(p.repo, readTask(p.repo, '1')); run = launch(plan.confirmationId);
  await until(() => guardPid(p), 'the guard to start again');
  const left = guardPid(p), record = readTask(p.repo, '1').pushRun;
  assert.ok(record?.pid);
  run.child.kill('SIGKILL'); await run.ended;
  assert.equal(alive(left), true, 'the guard goes on by itself'); assert.equal(alive(record.pid), true, 'and so does git');
  // Its guard had not finished, which is before Git sends anything: nothing was pushed.
  const task = projectSnapshot(p.repo).tasks.find(row => row.id === '1');
  assert.equal(task.pushRun, undefined); assert.equal(pushStopNote(task), 'ELU closed during the push, before its pre-push guard finished. Nothing was pushed.');
  await until(() => !alive(left) && !alive(record.pid), 'git and the guard to end', 5000);
  assert.equal(p.pushed(), false); lock(p.repo, 'task-1')();
  // One whose guards had finished, and that ended by itself: ELU cannot tell how far it got.
  const gone = readTask(p.repo, '1'); gone.pushRun = { ...record, at: new Date().toISOString() }; saveTask(p.repo, gone);
  assert.equal(pushStopNote(projectSnapshot(p.repo).tasks.find(row => row.id === '1')), 'ELU closed during the push, so it may not have finished: /publish pushes it again.');
});

// A look that finds the session's lock held, as while another ELU works in it, cannot settle a
// push a killed ELU left. It leaves the push to a later look, so an ELU that stays open (the
// login item's schedule tick) settles it once the lock frees, not only an ELU opened after.
test("a push left by a killed ELU is settled by the same open ELU once the session's lock frees", { timeout: 120000 }, async t => {
  const p = guarded(t, busyGuard), env = { ...process.env, ...p.fake.env, PATH: process.env.PATH }; ownFolder(t, p);
  const plan = await preparePublish(p.repo, p.task);
  const run = spawn(process.execPath, [CLI, 'run', '1', '--publish', '--approve-push', plan.confirmationId, '--json'], { cwd: p.root, env, stdio: 'ignore' });
  t.after(() => { try { run.kill('SIGKILL'); } catch { /* Ended. */ } });
  await until(() => guardPid(p), 'the guard to start');
  const guard = guardPid(p), record = readTask(p.repo, '1').pushRun;
  assert.ok(record?.pid);
  await new Promise(resolve => { run.on('close', resolve); run.kill('SIGKILL'); });
  // Another ELU holds the session's lock.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `import { lock } from ${JSON.stringify(new URL('../lib/state.mjs', import.meta.url).href)}; lock({ state: ${JSON.stringify(p.repo.state)} }, 'task-1'); console.log('held'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { holder.kill('SIGKILL'); } catch { /* Ended. */ } });
  await new Promise(resolve => holder.stdout.once('data', resolve));
  const left = () => projectSnapshot(p.repo).tasks.find(row => row.id === '1');
  assert.ok(left().pushRun, 'left while another ELU holds the session');
  assert.equal(pushStopNote(left()), null); assert.equal(alive(guard), true);
  // The lock frees: the same process settles the push on a later look.
  await new Promise(resolve => { holder.on('close', resolve); holder.kill('SIGKILL'); });
  await until(() => !left().pushRun, 'the push to be settled', 15000);
  assert.equal(pushStopNote(left()), 'ELU closed during the push, before its pre-push guard finished. Nothing was pushed.');
  await until(() => !alive(guard) && !alive(record.pid), 'git and the guard to end', 5000);
  assert.equal(p.pushed(), false); lock(p.repo, 'task-1')();
});
