import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, temp } from './helpers.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { answerApproval, awaitDecision, pendingApprovals, requestApproval } from '../lib/approvals.mjs';
import { personalDirectory } from '../lib/util.mjs';
import { capture } from '../lib/process.mjs';
import { detect } from '../lib/detect.mjs';

// /stop ends the programs that read a vendor before a turn (its release, its sign-in), and
// nothing of the turn writes afterwards: a look at the approvals that wait makes no folder.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function gone(pid, ms = 2000) { for (const until = Date.now() + ms; Date.now() < until;) { if (!alive(pid)) return true; await sleep(50); } return !alive(pid); }
// A Claude Code that takes half a minute over one question, as a vendor's program can: its
// release (--version) or its sign-in (auth status). It notes its process in pids first.
function slowClaude(t, slow) {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer' }), real = path.join(fake.dir, 'claude-real'), pids = path.join(p.parent, 'pids');
  fs.renameSync(path.join(fake.dir, 'claude'), real);
  const asked = slow === 'version' ? '[ "$1" = "--version" ]' : '[ "$1" = "auth" ]';
  fs.writeFileSync(path.join(fake.dir, 'claude'), `#!/bin/sh\nif ${asked}; then echo $$ >> '${pids}'; exec sleep 30; fi\nexec '${real}' "$@"\n`, { mode: 0o755 });
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const started = async () => { for (let i = 0; i < 200; i++) { if (fs.existsSync(pids)) { const all = fs.readFileSync(pids, 'utf8').trim().split('\n').filter(Boolean).map(Number); if (all.length) return all; } await sleep(50); } throw new Error('the program was never started'); };
  t.after(() => { try { for (const pid of fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number)) { try { process.kill(pid, 'SIGKILL'); } catch { /* Ended already. */ } } } catch { /* None was started. */ } });
  return { ...p, fake, pids, started };
}

for (const slow of ['sign-in', 'version']) {
  test(`/stop while Claude Code is asked for its ${slow === 'version' ? 'release' : 'sign-in'} ends that program with the turn, and nothing is written afterwards`, { timeout: 60000 }, async t => {
    const f = slowClaude(t, slow), controller = new ProjectController(projectFolder(f.root));
    Object.assign(controller.draftConfig.roles.lead, { vendor: 'claude', maxCostUsd: null });
    const run = controller.ask('Reply done with the summary "hello".', null, { permissions: 'auto' }), ended = run.finished.then(task => task.state, error => error.message);
    const [pid] = await f.started(); assert.ok(alive(pid), 'the program runs');
    const since = Date.now(); await controller.stop(run.id);
    assert.ok(Date.now() - since < 3000, `the stop took ${Date.now() - since} ms`);
    // Before: the turn ended and the program ran on, for up to 15 seconds.
    assert.ok(await gone(pid), 'the program was ended with the turn');
    assert.match(String(await ended), /stopped|Stopped/);
    // No second program of the reading starts after the stop, and the stopped turn leaves no approvals folder behind.
    await sleep(500);
    assert.deepEqual(fs.readFileSync(f.pids, 'utf8').trim().split('\n').map(Number), [pid]);
    assert.deepEqual(pendingApprovals(), []);
    assert.equal(fs.existsSync(path.join(personalDirectory(), 'approvals')), false, 'a look at the approvals made their folder');
  });
}

test('a reading of the vendors that is stopped ends its program at once and throws the stop; one stopped before it began starts none', { timeout: 60000 }, async t => {
  const f = slowClaude(t, 'sign-in'), stop = new AbortController();
  const reading = detect(f.root, process.env, { only: 'claude', signal: stop.signal }).then(() => 'read', error => error.message);
  const [pid] = await f.started();
  const since = Date.now(); stop.abort(new Error('Stopped by the owner.'));
  assert.equal(await reading, 'Stopped by the owner.'); assert.ok(Date.now() - since < 1000);
  assert.ok(await gone(pid), 'its program was ended');
  await assert.rejects(detect(f.root, process.env, { only: 'claude', signal: stop.signal }), /Stopped by the owner/);
  assert.deepEqual(await f.started(), [pid], 'no program was started');
  // One program run to its end the same way.
  const again = new AbortController(), program = capture('/bin/sh', ['-c', 'sleep 30'], { signal: again.signal });
  await sleep(200); again.abort();
  const result = await program; assert.equal(result.stopped, true); assert.equal(result.code, null); assert.equal(result.timedOut, false);
  assert.equal((await capture('/bin/sh', ['-c', 'echo never'], { signal: again.signal })).stdout, '');
});

test('a look at the approvals that wait makes no folder; the first request makes it, for the owner alone', async t => {
  const dir = temp(t); environment(t, { XDG_CONFIG_HOME: path.join(dir, 'personal') });
  const folder = path.join(personalDirectory(), 'approvals');
  // Before: each of these made personal/elu-code/approvals, the app at every draw and the
  // conductor at every tick, also after the folder above it was removed.
  assert.deepEqual(pendingApprovals(), []); assert.deepEqual(pendingApprovals({ root: dir, taskId: '4' }), []);
  assert.equal(answerApproval('none-1', 'allow'), false);
  assert.equal(await awaitDecision('none-1', { waitSeconds: 0.05 }), 'timeout');
  assert.equal(fs.existsSync(folder), false); assert.equal(fs.existsSync(path.join(dir, 'personal')), false);
  requestApproval({ id: 'first-1', root: dir, taskId: 4, role: 'lead', vendor: 'claude', tool: 'Bash', input: { command: 'npm test' } });
  assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  assert.deepEqual(pendingApprovals().map(row => row.id), ['first-1']);
  assert.equal(answerApproval('first-1', 'allow'), true); assert.equal(await awaitDecision('first-1', { waitSeconds: 1 }), 'allow');
  // The folder that held a request is gone with everything above it: a later look makes nothing again.
  fs.rmSync(path.join(dir, 'personal'), { recursive: true, force: true });
  assert.deepEqual(pendingApprovals(), []); assert.equal(fs.existsSync(path.join(dir, 'personal')), false);
});
