import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { project, fakeClis } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { projectSnapshot, registerProject } from '../lib/projects.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import { Conductor, enqueue, sendCommand, olderConductor } from '../lib/conductor.mjs';
import { conductorLock } from '../lib/conductor-files.mjs';
// The conductor of 0.1.16 as published, which has no handover, on today's modules.
import * as earlier from './fixtures/conductor-0.1.16/conductor.mjs';

// The moment between the exit of a conductor without handover (0.1.16 and earlier) and
// promote(), when the lock is free. An app of that version still open can start a conductor
// then: the one on disk, which is this version after an update in place, or its own (npx
// keeps each version apart). Either one's recover() runs as it starts, and must leave alone
// what the conductor beside it starts or runs.

const LIVE = new WeakMap(), STOP_MS = 20000;
function giveUp(message) { console.error(`conductor-promote.test: ${message} Ending the test process.`); process.exit(1); }
async function stopAll(t) {
  for (const conductor of LIVE.get(t) ?? []) {
    const late = setTimeout(() => giveUp(`A conductor did not stop within ${STOP_MS / 1000} s.`), STOP_MS);
    try { await conductor.stop(); } finally { clearTimeout(late); }
  }
}
after(() => { setTimeout(() => giveUp('Something is still running 10 s after the last test.'), 10000).unref(); });
function setup(t, mode = 'slow') {
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
const sessions = (repo, goal) => projectSnapshot(repo).tasks.filter(row => row.goal === goal).length;
// What a conductor started, in order, so a request that runs twice shows.
function counting(conductor, started) {
  const launch = conductor.launch.bind(conductor);
  conductor.launch = (repo, row) => { const value = launch(repo, row); if ([...conductor.runs.values()].some(run => run.requestId === row.id)) started.push(row.id); return value; };
  return conductor;
}
// A 0.1.16 conductor. updated() is the update: the version on disk changes, read at once.
function old016(t) {
  const box = { started: [], exits: 0, disk: '0.1.16' };
  const conductor = counting(new earlier.Conductor({ tickMs: 20, version: '0.1.16', onDisk: () => box.disk, onExit: () => { box.exits++; conductor.stop(); } }), box.started);
  conductor.start(); LIVE.get(t).push(conductor);
  return Object.assign(box, { conductor, updated() { box.disk = '0.1.99'; conductor.versionAt = 0; } });
}
// This version's conductor beside it. It ticks only when the test says, so the moment before
// promote() lasts as long as the test needs.
function beside(t) {
  const box = { started: [] };
  const conductor = counting(new Conductor({ tickMs: 3600000 }), box.started).start(); LIVE.get(t).push(conductor);
  return Object.assign(box, { conductor });
}
// The 0.1.16 turn ends and its conductor exits: the lock is free, and the one beside has not ticked.
async function oldExits(p, old, first) {
  sendCommand({ type: 'stop', root: p.root, taskId: request(p.root, first.id).taskId });
  await until(() => old.exits > 0 && !fs.existsSync(conductorLock()), 'the 0.1.16 conductor to exit');
}
// After an update from 0.1.16 while its turn runs, this version's conductor runs a turn beside it.
async function besideTurn(t) {
  const p = setup(t), first = enqueue(p.root, 'The old turn'), old = old016(t);
  await until(() => request(p.root, first.id)?.state === 'running', 'the 0.1.16 turn');
  old.updated();
  const fresh = beside(t);
  assert.equal(fresh.conductor.beside, true);
  const turn = enqueue(p.root, 'Runs beside'); fresh.conductor.tick();
  assert.deepEqual(fresh.started, [turn.id]);
  const id = request(p.root, turn.id).taskId;
  await until(() => task(p.repo, id)?.activeRole === 'lead', 'the turn beside');
  return { p, first, old, fresh, turn, id };
}

test('a 0.1.16 conductor started before promote() never marks the turn the conductor beside runs interrupted', async t => {
  const { p, first, old, fresh, turn, id } = await besideTurn(t);
  await oldExits(p, old, first);
  const again = old016(t);
  assert.deepEqual([request(p.root, turn.id).state, request(p.root, turn.id).taskId], ['running', id], 'its recover() left the turn beside alone');
  assert.equal(task(p.repo, id).state, 'running');
  await pause(200);
  assert.deepEqual([again.started, old.started, fresh.started], [[], [first.id], [turn.id]]);
  assert.equal(request(p.root, turn.id).state, 'running');
  // The turn beside ends; it is done once, on this version.
  sendCommand({ type: 'stop', root: p.root, taskId: id }); fresh.conductor.tick();
  await until(() => request(p.root, turn.id)?.state === 'done', 'the turn beside to end');
  assert.equal(sessions(p.repo, 'Runs beside'), 1);
});

test('a 0.1.16 conductor started while the conductor beside starts a request never starts it again', async t => {
  const p = setup(t), first = enqueue(p.root, 'The old turn'), old = old016(t);
  await until(() => request(p.root, first.id)?.state === 'running', 'the 0.1.16 turn');
  old.updated();
  const fresh = beside(t);
  await oldExits(p, old, first);
  const again = old016(t);
  await until(() => olderConductor() !== null, 'the 0.1.16 conductor to write its status');
  // While that one holds the lock, the conductor beside starts a request. In the middle of
  // starting it, that one exits and another of its version starts.
  const next = enqueue(p.root, 'Starts beside');
  const make = fresh.conductor.controller.bind(fresh.conductor); let third = null;
  fresh.conductor.controller = repo => {
    if (!third) { again.conductor.closed = true; clearInterval(again.conductor.timer); again.conductor.write(true); again.conductor.release(); again.conductor.release = null; third = old016(t); }
    return make(repo);
  };
  fresh.conductor.tick();
  assert.ok(third, 'the other conductor started while it was starting');
  assert.deepEqual(fresh.started, [next.id]);
  assert.deepEqual(third.started, [], 'it did not start it again');
  await until(() => task(p.repo, request(p.root, next.id).taskId)?.activeRole === 'lead', 'the turn beside');
  await pause(200);
  assert.deepEqual([third.started, again.started], [[], []]);
  assert.equal(sessions(p.repo, 'Starts beside'), 1, 'it runs once');
  assert.equal(request(p.root, next.id).state, 'running');
});

test('a conductor of this version started before promote() leaves the lock to the one beside, and nothing of its turn is marked interrupted', async t => {
  const { p, first, old, fresh, turn, id } = await besideTurn(t);
  await oldExits(p, old, first);
  // An app of 0.1.16 still open starts the conductor on disk, which is this version now.
  const other = new Conductor({ tickMs: 20 }); let refused = null;
  try { other.start(); LIVE.get(t).push(other); } catch (error) { refused = error; }
  assert.deepEqual([request(p.root, turn.id).state, request(p.root, turn.id).taskId, task(p.repo, id).state], ['running', id, 'running'], 'nothing marked the turn beside interrupted');
  assert.ok(refused, 'it did not start');
  fresh.conductor.tick();
  assert.equal(fresh.conductor.beside, false, 'the conductor beside took the lock');
  assert.deepEqual([request(p.root, turn.id).state, task(p.repo, id).state], ['running', 'running']);
  assert.deepEqual(fresh.started, [turn.id]);
});
