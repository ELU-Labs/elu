import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { project, fakeClis } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { projectSnapshot, registerProject } from '../lib/projects.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import { Conductor, enqueue, sendCommand, VERSION } from '../lib/conductor.mjs';
// The conductors and request functions of published versions, on today's other modules:
// 0.1.16 and 0.1.17 have no handover, 0.1.19 (and 0.1.18) has.
import * as v16 from './fixtures/conductor-0.1.16/conductor.mjs';
import * as v17 from './fixtures/conductor-0.1.17/conductor.mjs';
import * as v19 from './fixtures/conductor-0.1.19/conductor.mjs';
import { pendingRequests as mainFileRequests } from './fixtures/conductor-0.1.16/workspace.mjs';

// An ELU window still open on the version from before an update keeps its old code, so it
// keeps writing what it sends into the main request file. That work must run once, on the
// new version, with no window restart.

const LIVE = new WeakMap(), HOUR = 3600000;
after(() => { setTimeout(() => { console.error('conductor-window.test: something still runs 10 s after the last test.'); process.exit(1); }, 10000).unref(); });
function setup(t) {
  LIVE.set(t, []); t.after(async () => { for (const conductor of LIVE.get(t)) await conductor.stop(); });
  const p = project(t), fake = fakeClis(p.parent, { mode: 'slow' });
  const previous = { PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  Object.assign(process.env, fake.env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const repo = repository(p.root); registerProject(repo);
  return { ...p, repo };
}
async function until(check, message, timeout = 15000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const request = (root, id) => pendingRequests(root).find(row => row.id === id);
const task = (repo, id) => projectSnapshot(repo).tasks.find(row => row.id === id);
const texts = (repo, id) => task(repo, id).messages.map(row => row.text);
const sessions = (repo, goal) => projectSnapshot(repo).tasks.filter(row => row.goal === goal).length;
// A conductor with what it started, in order, so a request that runs twice or on the wrong
// version shows. disk is the version on disk it reads; updated(to) is the update, read at once.
function running(t, Kind, { version, disk = version, ...options }) {
  const box = { started: [], disk, exits: 0 };
  const conductor = new Kind({ tickMs: 20, version, onDisk: () => box.disk, ...options });
  const launch = conductor.launch.bind(conductor);
  conductor.launch = (repo, row) => { const value = launch(repo, row); if ([...conductor.runs.values()].some(run => run.requestId === row.id)) box.started.push(row.id); return value; };
  conductor.start(); LIVE.get(t).push(conductor);
  return Object.assign(box, { conductor, updated(to) { box.disk = to; conductor.versionAt = 0; } });
}
// A conductor that ticked only when the test said ticks by itself from now on.
function resume({ conductor }) { clearInterval(conductor.timer); conductor.timer = setInterval(() => conductor.tick(), 20); }

for (const [name, module] of [['0.1.16', v16], ['0.1.17', v17]]) {
  test(`what an ELU window of ${name} still open sends after the update is moved at once where that conductor never reads, and runs once on the new version`, async t => {
    const p = setup(t), first = enqueue(p.root, 'The old turn');
    // Both conductors tick only when the test says, so only the change of the request file can move what the window sends.
    const old = running(t, module.Conductor, { version: name, tickMs: HOUR });
    old.conductor.onExit = () => { old.exits++; old.conductor.stop(); };
    await until(() => request(p.root, first.id)?.state === 'running', 'the old turn');
    const oldTask = request(p.root, first.id).taskId;
    old.updated(VERSION);
    const fresh = running(t, Conductor, { version: VERSION, tickMs: HOUR });
    assert.equal(fresh.conductor.beside, true, 'the old conductor keeps the lock');
    // The window still open on the old version sends a new session and a follow-up to the old turn's.
    const sent = module.enqueue(p.root, 'From the old window'), more = module.enqueue(p.root, 'And more from the old window', { continuationTaskId: oldTask });
    await until(() => !mainFileRequests(p.root).some(row => row.state === 'queued'), 'the new version to move them, before either conductor ticks', 3000);
    old.conductor.tick();
    assert.deepEqual(old.started, [first.id], `the ${name} conductor found nothing to start`);
    fresh.conductor.tick();
    assert.deepEqual(fresh.started, [sent.id], 'the new version starts the new session; the follow-up waits for the old turn');
    await until(() => task(p.repo, request(p.root, sent.id).taskId)?.activeRole === 'lead', 'the new session');
    // The old turn ends and its conductor exits: the follow-up then runs on the new version.
    resume(old); resume(fresh);
    sendCommand({ type: 'stop', root: p.root, taskId: oldTask });
    await until(() => fresh.started.includes(more.id), 'the follow-up on the new version');
    await until(() => texts(p.repo, oldTask).length === 2, 'the follow-up to be sent');
    assert.deepEqual(old.started, [first.id], `the ${name} conductor started nothing the window sent`);
    assert.deepEqual(fresh.started, [sent.id, more.id]);
    assert.deepEqual(texts(p.repo, oldTask), ['The old turn', 'And more from the old window']);
    assert.equal(sessions(p.repo, 'From the old window'), 1, 'once');
  });
}

// 0.1.18 and 0.1.19 hand over: the replaced conductor gives up the lock, so what a window of
// that version writes into the main file is read by the new version's conductor, which holds it.
test('what an ELU window of 0.1.19 still open sends after the update runs once on the new version, and its follow-up after the old turn', async t => {
  const p = setup(t), first = enqueue(p.root, 'The old turn'); let fresh = null;
  // The window starts the conductor on disk after it sends, as does the replaced one when work waits.
  const window = () => { fresh ??= running(t, Conductor, { version: VERSION }); };
  const old = running(t, v19.Conductor, { version: '0.1.19', next: window });
  old.conductor.onExit = () => { old.exits++; old.conductor.stop(); };
  await until(() => request(p.root, first.id)?.state === 'running', 'the old turn');
  const oldTask = request(p.root, first.id).taskId;
  await until(() => task(p.repo, oldTask)?.activeRole === 'lead', 'the model working');
  old.updated('0.1.20');
  await until(() => old.conductor.draining, 'the 0.1.19 conductor to hand over');
  const sent = v19.enqueue(p.root, 'From the old window'), more = v19.enqueue(p.root, 'And more from the old window', { continuationTaskId: oldTask });
  window();
  await until(() => fresh.started.includes(sent.id), 'the new session on the new version');
  assert.deepEqual(old.started, [first.id], 'the replaced conductor took nothing new');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(request(p.root, more.id).state, 'queued', 'the follow-up waits for the old turn');
  sendCommand({ type: 'stop', root: p.root, taskId: oldTask });
  await until(() => fresh.started.includes(more.id), 'the follow-up on the new version');
  await until(() => texts(p.repo, oldTask).length === 2, 'the follow-up to be sent');
  assert.deepEqual([old.started, fresh.started], [[first.id], [sent.id, more.id]]);
  assert.deepEqual(texts(p.repo, oldTask), ['The old turn', 'And more from the old window']);
  assert.equal(sessions(p.repo, 'From the old window'), 1, 'once');
});
