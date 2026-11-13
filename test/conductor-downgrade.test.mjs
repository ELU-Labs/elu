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
function published(t, { module, version }) {
  const box = { started: [], exits: 0, disk: version };
  const conductor = counting(new module.Conductor({ tickMs: 20, version, onDisk: () => box.disk, onExit: () => { box.exits++; conductor.stop(); } }), box.started);
  conductor.start(); LIVE.get(t).push(conductor);
  return Object.assign(box, { conductor, updated(to) { box.disk = to; conductor.versionAt = 0; } });
}
// This version's conductor. It starts no other in these tests.
function current(t) {
  const box = { started: [], disk: null };
  const conductor = counting(new Conductor({ tickMs: 20, onDisk: () => box.disk ?? conductor.version, next: () => {} }), box.started);
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

  test(`a downgrade to ${name} while this version's conductor beside it holds queued work: the work goes back where ${name} reads it, and runs once there`, async t => {
    const p = setup(t, 'slow'); saveConductorSettings({ maxAgents: 1 });
    const first = enqueue(p.root, 'The old turn'), old = published(t, { module, version: name });
    await until(() => request(p.root, first.id)?.state === 'running', 'the old turn');
    // An update: this version's conductor starts beside it, and the one slot is taken.
    old.updated('0.1.99');
    const fresh = current(t);
    await until(() => fresh.conductor.beside === true, 'the conductor beside');
    const held = enqueue(p.root, 'Waits beside');
    await pause(300);
    assert.deepEqual([request(p.root, held.id).state, besideFiles().length, earlierRequests(p.root).some(row => row.id === held.id)], ['queued', 1, false], `held where ${name} never reads`);
    // Back to the earlier version under both conductors.
    downgrade(t, name); old.updated(name); fresh.updated(name);
    await until(() => fresh.conductor.draining, 'this version to hand over');
    await until(() => earlierRequests(p.root).some(row => row.id === held.id), `the held request where ${name} reads it`);
    assert.deepEqual(besideFiles(), []);
    sendCommand({ type: 'stop', root: p.root, taskId: request(p.root, first.id).taskId });
    await until(() => old.started.includes(held.id), `the held request on ${name}`);
    await pause(300);
    assert.deepEqual([old.started, fresh.started], [[first.id, held.id], []]);
    assert.equal(sessions(p.repo, 'Waits beside'), 1);
  });
}
