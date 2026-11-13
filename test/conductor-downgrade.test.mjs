import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { projectSnapshot, registerProject } from '../lib/projects.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import { Conductor, enqueue, sendCommand, saveConductorSettings, olderConductor } from '../lib/conductor.mjs';
import * as conductorFiles from '../lib/conductor-files.mjs';
import { personalDirectory } from '../lib/util.mjs';
// The conductors of 0.1.16 and 0.1.17 as published, which have no handover, on today's
// modules. Neither reads the requests that wait beside the main file.
import * as earlier16 from './fixtures/conductor-0.1.16/conductor.mjs';
import * as earlier17 from './fixtures/conductor-0.1.17/conductor.mjs';
// The conductor of 0.1.19 as published, which hands over and reads them.
import * as published19 from './fixtures/conductor-0.1.19/conductor.mjs';
import { pendingRequests as earlierRequests } from './fixtures/conductor-0.1.16/workspace.mjs';

// A downgrade: an earlier version is installed again after this one, under every process of
// this version still running. Nothing queued may be lost or run twice.

const LIVE = new WeakMap(), STOP_MS = 20000;
function giveUp(message) { console.error(`conductor-downgrade.test: ${message} Ending the test process.`); process.exit(1); }
async function stopAll(t) {
  for (const conductor of LIVE.get(t) ?? []) {
    const late = setTimeout(() => giveUp(`A conductor did not stop within ${STOP_MS / 1000} s.`), STOP_MS);
    try { await conductor.stop(); } finally { clearTimeout(late); }
  }
}
after(() => { setTimeout(() => giveUp('Something is still running 10 s after the last test.'), 10000).unref(); });
function setup(t, mode = 'answer') {
  LIVE.set(t, []); t.after(() => stopAll(t));
  const p = project(t), fake = fakeClis(p.parent, { mode });
  const previous = { PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  Object.assign(process.env, fake.env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const repo = repository(p.root); registerProject(repo);
  return { ...p, ...fake, repo };
}
async function until(check, message, timeout = 15000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = (root, id) => pendingRequests(root).find(row => row.id === id);
const task = (repo, id) => projectSnapshot(repo).tasks.find(row => row.id === id);
const sayTo = (p, id, text) => enqueue(p.root, text, { continuationTaskId: id, priority: 0 });
const texts = (repo, id) => task(repo, id).messages.map(row => row.text);
const sessions = (repo, goal) => projectSnapshot(repo).tasks.filter(row => row.goal === goal).length;
const besideFiles = () => fs.readdirSync(path.join(personalDirectory(), 'requests')).filter(name => name.endsWith('.beside.json'));
// What a conductor started, in order, so a request that runs twice, or nowhere, shows.
function counting(conductor, started) {
  const launch = conductor.launch.bind(conductor);
  conductor.launch = (repo, row) => { const value = launch(repo, row); if ([...conductor.runs.values()].some(run => run.requestId === row.id)) started.push(row.id); return value; };
  return conductor;
}
// A conductor of a published version. updated(to) puts another version on disk under it,
// read at once instead of after 5 s.
function published(t, { module, version, next }) {
  const box = { started: [], exits: 0, disk: version };
  const conductor = counting(new module.Conductor({ tickMs: 20, version, onDisk: () => box.disk, onExit: () => { box.exits++; conductor.stop(); }, ...(next ? { next } : {}) }), box.started);
  conductor.start(); LIVE.get(t).push(conductor);
  return Object.assign(box, { conductor, updated(to) { box.disk = to; conductor.versionAt = 0; } });
}
// This version's conductor. next: what it does to start the conductor of the version on disk.
// version: the version it runs, 0.1.20 in the tests of a downgrade to 0.1.19.
function current(t, { next = () => {}, version } = {}) {
  const box = { started: [], exits: 0, disk: null };
  const conductor = counting(new Conductor({ tickMs: 20, ...(version ? { version } : {}), onDisk: () => box.disk ?? conductor.version, next, onExit: () => { box.exits++; conductor.stop(); } }), box.started);
  conductor.start(); LIVE.get(t).push(conductor);
  return Object.assign(box, { conductor, updated(to) { box.disk = to; conductor.versionAt = 0; } });
}
// The copy installed where this version's code runs is the earlier version now.
function downgrade(t, version) {
  const { installed } = conductorFiles, before = installed.version;
  installed.version = () => version; t.after(() => { installed.version = before; });
}

for (const [name, module] of [['0.1.16', earlier16], ['0.1.17', earlier17]]) {
  test(`after a downgrade to ${name}, what an app of this version still open sends goes where ${name} reads it, and runs once there`, async t => {
    const p = setup(t), old = published(t, { module, version: name });
    await until(() => olderConductor() !== null, 'the conductor to write its status');
    downgrade(t, name);
    const sent = enqueue(p.root, 'Sent after the downgrade');
    assert.ok(earlierRequests(p.root).some(row => row.id === sent.id), `${name} reads it`);
    await until(() => request(p.root, sent.id)?.state === 'done', 'the request');
    assert.deepEqual(old.started, [sent.id]);
    assert.equal(sessions(p.repo, 'Sent after the downgrade'), 1);
    assert.deepEqual(besideFiles(), []);
  });

  test(`a downgrade to ${name} while this version's conductor beside it holds queued work: it keeps that work where ${name} never reads, runs it once, and exits once it has nothing to do`, async t => {
    const p = setup(t, 'slow'); saveConductorSettings({ maxAgents: 1 });
    const first = enqueue(p.root, 'The old turn'), old = published(t, { module, version: name });
    await until(() => request(p.root, first.id)?.state === 'running', 'the old turn');
    // An update: this version's conductor starts beside it, and the one slot is taken.
    old.updated('0.1.99');
    const fresh = current(t);
    await until(() => fresh.conductor.beside === true, 'the conductor beside');
    const held = enqueue(p.root, 'Waits beside');
    await pause(300);
    assert.deepEqual([request(p.root, held.id).state, besideFiles().length], ['queued', 1]);
    // Back to the earlier version under both conductors, and an app of this version still open sends more.
    downgrade(t, name); old.updated(name); fresh.updated(name);
    await pause(300);
    const sent = enqueue(p.root, 'Sent after the downgrade');
    await pause(300);
    assert.deepEqual([fresh.conductor.draining, fresh.conductor.beside, request(p.root, held.id).state, request(p.root, sent.id).state], [null, true, 'queued', 'queued']);
    assert.ok([held.id, sent.id].every(id => !earlierRequests(p.root).some(row => row.id === id)), `${name} never sees them`);
    sendCommand({ type: 'stop', root: p.root, taskId: request(p.root, first.id).taskId }); saveConductorSettings({ maxAgents: 4 });
    await until(() => [held.id, sent.id].every(id => fresh.started.includes(id)), 'this version to start them');
    await pause(300);
    assert.deepEqual([old.started, fresh.started.length, sessions(p.repo, 'Waits beside'), sessions(p.repo, 'Sent after the downgrade')], [[first.id], 2, 1, 1]);
    for (const id of [held.id, sent.id]) sendCommand({ type: 'stop', root: p.root, taskId: request(p.root, id).taskId });
    await until(() => fresh.exits === 1, 'this version to exit once it has nothing to do');
    assert.deepEqual(besideFiles(), []);
  });

  // This version's conductor runs a turn and holds the lock. It keeps the work: a conductor of
  // that version beside it would start the turn's follow-up at once, and block it.
  test(`a downgrade to ${name} while this version runs a turn: it keeps the work, runs the follow-up once after the turn, exits once it has nothing to do, and ${name} takes what comes after`, async t => {
    const p = setup(t, 'slow'), first = enqueue(p.root, 'Runs on this version'), now = current(t);
    await until(() => request(p.root, first.id)?.state === 'running', 'the turn');
    const id = request(p.root, first.id).taskId;
    await until(() => task(p.repo, id)?.activeRole === 'lead', 'the model working');
    downgrade(t, name); now.updated(name);
    const more = sayTo(p, id, 'And the follow-up'), other = enqueue(p.root, 'New work');
    await until(() => now.started.includes(other.id), 'this version to take the new work');
    await pause(300);
    assert.deepEqual([now.conductor.draining, request(p.root, more.id).state], [null, 'queued'], 'the follow-up waits for the turn');
    sendCommand({ type: 'stop', root: p.root, taskId: id });
    await until(() => now.started.includes(more.id), 'the follow-up');
    await until(() => texts(p.repo, id).length === 2, 'the follow-up to be sent');
    for (const value of [id, request(p.root, other.id).taskId]) sendCommand({ type: 'stop', root: p.root, taskId: value });
    await until(() => now.exits === 1, 'this version to exit once it has nothing to do');
    const after = published(t, { module, version: name }), sent = enqueue(p.root, 'Sent after it exited');
    await until(() => after.started.includes(sent.id), `${name} to take it`);
    await pause(300);
    assert.deepEqual(texts(p.repo, id), ['Runs on this version', 'And the follow-up']);
    assert.deepEqual([now.started, after.started], [[first.id, other.id, more.id], [sent.id]]);
    assert.deepEqual([sessions(p.repo, 'New work'), sessions(p.repo, 'Sent after it exited'), /ELU stopped before/.test(task(p.repo, id).error?.message ?? '')], [1, 1, false], 'nothing took the turn for interrupted');
    assert.deepEqual(besideFiles(), []);
  });
}

// 0.1.18 and 0.1.19 hand over too, and read the requests beside the main file: this version's
// conductor hands over to the one of the version on disk, as after an update.
test('a downgrade to 0.1.19 while this version runs a turn: 0.1.19 takes new work, and the follow-up runs once, after the turn', async t => {
  const p = setup(t, 'slow'), first = enqueue(p.root, 'Runs on this version'); let after = null;
  const now = current(t, { version: '0.1.20', next: () => { after ??= published(t, { module: published19, version: '0.1.19', next: () => {} }); } });
  await until(() => request(p.root, first.id)?.state === 'running', 'the turn');
  const id = request(p.root, first.id).taskId;
  await until(() => task(p.repo, id)?.activeRole === 'lead', 'the model working');
  downgrade(t, '0.1.19'); now.updated('0.1.19');
  await until(() => now.conductor.draining, 'this version to hand over');
  const more = sayTo(p, id, 'And the follow-up'), other = enqueue(p.root, 'New work');
  await until(() => after?.started.includes(other.id), '0.1.19 to take the new work');
  await pause(300);
  assert.deepEqual([request(p.root, first.id).state, task(p.repo, id).state, request(p.root, more.id).state], ['running', 'running', 'queued'], 'the turn left alone, its follow-up waits');
  sendCommand({ type: 'stop', root: p.root, taskId: id });
  await until(() => after.started.includes(more.id), 'the follow-up on 0.1.19');
  await until(() => texts(p.repo, id).length === 2, 'the follow-up to be sent');
  assert.deepEqual([now.started, after.started], [[first.id], [other.id, more.id]]);
  assert.deepEqual(besideFiles(), []);
});

test('elu conductor stop beside 0.1.16 leaves nothing queued where 0.1.16 never reads, so a downgrade after it starts that work once', async t => {
  const p = setup(t, 'slow'); saveConductorSettings({ maxAgents: 1 });
  const first = enqueue(p.root, 'The old turn'), old = published(t, { module: earlier16, version: '0.1.16' });
  await until(() => request(p.root, first.id)?.state === 'running', 'the old turn');
  old.updated('0.1.99');
  const fresh = current(t);
  await until(() => fresh.conductor.beside === true, 'the conductor beside');
  const held = enqueue(p.root, 'Queued beside');
  await pause(300);
  assert.deepEqual([request(p.root, held.id).state, besideFiles().length], ['queued', 1]);
  // Every conductor stops, and 0.1.16 is installed again before any other starts.
  sendCommand({ type: 'shutdown' });
  await until(() => old.conductor.closed && fresh.conductor.closed, 'both to stop');
  downgrade(t, '0.1.16'); saveConductorSettings({ maxAgents: 4 });
  assert.deepEqual(besideFiles(), []);
  const again = published(t, { module: earlier16, version: '0.1.16' });
  await until(() => again.started.includes(held.id), '0.1.16 to start what waited');
  assert.deepEqual([fresh.started, sessions(p.repo, 'Queued beside')], [[], 1]);
});
