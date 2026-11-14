import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { project, fakeClis } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { projectSnapshot, registerProject, claimView } from '../lib/projects.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import * as conductors from '../lib/conductor.mjs';
import * as conductorFiles from '../lib/conductor-files.mjs';
import { personalDirectory } from '../lib/util.mjs';
import { processIdentity } from '../lib/process.mjs';
// The conductors and request functions of published versions, on today's other modules:
// 0.1.16 and 0.1.17 have no handover and read only the main request file; 0.1.19 (and
// 0.1.18) hands over when its own files are replaced, and reads both files.
import * as v16 from './fixtures/conductor-0.1.16/conductor.mjs';
import * as v17 from './fixtures/conductor-0.1.17/conductor.mjs';
import * as v19 from './fixtures/conductor-0.1.19/conductor.mjs';
import { pendingRequests as mainFileRequests } from './fixtures/conductor-0.1.16/workspace.mjs';

// What is left between two versions once an update is over: a conductor that still finishes
// its turns after it gave the lock up, an ELU window still open on the version from before,
// which starts the conductor of that version from its own folder (npx keeps each version
// apart, so no update ever replaces its files), and messages a conductor that was killed
// left where 0.1.17 and earlier never read.

const { Conductor, enqueue, sendCommand, saveConductorSettings } = conductors;
const NOW = '0.1.20', HOUR = 3600000, LIVE = new WeakMap(), STOP_MS = 20000;
const PUBLISHED = [['0.1.16', v16], ['0.1.17', v17], ['0.1.19', v19]];
function giveUp(message) { console.error(`conductor-handover.test: ${message} Ending the test process.`); process.exit(1); }
async function stopAll(t) {
  for (const conductor of LIVE.get(t) ?? []) {
    const late = setTimeout(() => giveUp(`A conductor did not stop within ${STOP_MS / 1000} s.`), STOP_MS);
    try { await conductor.stop(); } finally { clearTimeout(late); }
  }
}
after(() => { setTimeout(() => giveUp('Something is still running 10 s after the last test.'), 10000).unref(); });
// This version is 0.1.20 here, whatever package.json says while it is built.
function setup(t, mode = 'slow') {
  LIVE.set(t, []); t.after(() => stopAll(t));
  const p = project(t), fake = fakeClis(p.parent, { mode });
  const previous = { PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  Object.assign(process.env, fake.env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const { installed } = conductorFiles, before = installed.version;
  installed.version = () => NOW; t.after(() => { installed.version = before; });
  const repo = repository(p.root); registerProject(repo);
  return { ...p, repo };
}
async function until(check, message, timeout = 15000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = (root, id) => pendingRequests(root).find(row => row.id === id);
const task = (repo, id) => projectSnapshot(repo).tasks.find(row => row.id === id);
const texts = (repo, id) => task(repo, id).messages.map(row => row.text);
const sessions = (repo, goal) => projectSnapshot(repo).tasks.filter(row => row.goal === goal).length;
// A conductor with what it started, in order, so a request that runs twice or on the wrong
// version shows. Run from its own folder, it never sees another version on disk.
// updated(to) is an update in place, read at once. A published one exits when told to.
function running(t, Kind, { version, ...options }) {
  const box = { started: [], exits: 0, disk: version };
  const conductor = new Kind({ tickMs: 20, version, onDisk: () => box.disk, next: () => {}, onExit: () => { box.exits++; if (Kind !== Conductor) conductor.stop(); }, ...options });
  const launch = conductor.launch.bind(conductor);
  conductor.launch = (repo, row) => { const value = launch(repo, row); if ([...conductor.runs.values()].some(run => run.requestId === row.id)) box.started.push(row.id); return value; };
  conductor.start(); LIVE.get(t).push(conductor);
  return Object.assign(box, { conductor, updated(to) { box.disk = to; conductor.versionAt = 0; } });
}
// A conductor that ticked only when the test said ticks by itself from now on.
function resume({ conductor }) { clearInterval(conductor.timer); conductor.timer = setInterval(() => conductor.tick(), 20); }
// A turn that runs: the request, and its session once the model works.
async function turn(p, sent) {
  await until(() => request(p.root, sent.id)?.state === 'running', `"${sent.goal}" to run`);
  const id = request(p.root, sent.id).taskId;
  await until(() => task(p.repo, id)?.activeRole === 'lead', 'the model working');
  return id;
}
// A conductor that was killed outright: nothing of it was stopped, released or put back.
function kill({ conductor }) {
  conductor.closed = true; clearInterval(conductor.timer); conductor.watchRequests?.(false);
  for (const file of [conductor.beside ? conductorFiles.besideLock() : conductorFiles.conductorLock(), conductor.beside ? conductorFiles.besideStatusPath() : conductorFiles.statusPath()]) fs.rmSync(file, { force: true });
}
// An ELU window that is open: a process that holds the lock of the project it shows. One of
// 0.1.19 or earlier names no version in it.
async function openWindow(t, version) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* Gone already. */ } });
  await until(() => processIdentity(child.pid), 'the window to start');
  const file = path.join(personalDirectory(), `view-${'a'.repeat(64)}.lock`);
  fs.writeFileSync(file, JSON.stringify({ pid: child.pid, identity: processIdentity(child.pid), ...(version ? { version } : {}) }));
  return { child, file, pid: child.pid };
}

for (const [name, module] of PUBLISHED.slice(0, 2)) {
  test(`a turn a replaced conductor still finishes is not taken for interrupted by a ${name} conductor an ELU window of ${name} starts then`, async t => {
    const p = setup(t), mine = running(t, Conductor, { version: NOW });
    const first = enqueue(p.root, 'The turn before the update'), id = await turn(p, first);
    // An update in place: it gives the lock up and only finishes that turn.
    mine.updated('0.1.21');
    await until(() => mine.conductor.draining, 'the conductor to hand over');
    assert.ok(!mainFileRequests(p.root).some(row => row.id === first.id), `its request stays where ${name} never reads`);
    // The lock is free. A window of the earlier version sends nothing yet, and starts its conductor.
    const old = running(t, module.Conductor, { version: name });
    assert.deepEqual([request(p.root, first.id).state, request(p.root, first.id).taskId, task(p.repo, id).state], ['running', id, 'running'], 'its recover() left the turn alone');
    await pause(200);
    assert.deepEqual([old.started, request(p.root, first.id).state], [[], 'running']);
    // The turn ends once, on the conductor that ran it.
    sendCommand({ type: 'stop', root: p.root, taskId: id });
    await until(() => request(p.root, first.id)?.state === 'done', 'the turn to end');
    assert.deepEqual([mine.started, old.started], [[first.id], []]);
    assert.equal(sessions(p.repo, 'The turn before the update'), 1);
  });
}

test('a replaced conductor starts the next version\'s at once while an ELU window of an earlier version is open, so that window never finds the lock free', async t => {
  const p = setup(t); let starts = 0;
  // With no such window and nothing queued, the next one starts only with the next thing sent.
  const alone = running(t, Conductor, { version: NOW, next: () => { starts++; } });
  alone.updated('0.1.21');
  await until(() => alone.conductor.draining, 'the conductor to hand over');
  await pause(100);
  assert.equal(starts, 0);
  await alone.conductor.stop();
  // With a window of an earlier version open, it starts at the handover, with nothing queued.
  await openWindow(t);
  const mine = running(t, Conductor, { version: NOW, next: () => { starts++; } });
  const first = enqueue(p.root, 'The turn before the update'); await turn(p, first);
  mine.updated('0.1.21');
  await until(() => mine.conductor.draining, 'the conductor to hand over');
  assert.equal(starts, 1, 'the next conductor is started as the lock is given up');
});

for (const [name, module] of PUBLISHED) {
  test(`a ${name} conductor run from its own folder, idle, is told to leave: this version takes the lock, and what an ELU window of ${name} sends then runs here`, async t => {
    const p = setup(t), old = running(t, module.Conductor, { version: name });
    await until(() => conductorFiles.mainConductor()?.known, `the ${name} conductor to write its status`);
    const fresh = running(t, Conductor, { version: NOW, idleMs: HOUR });
    assert.equal(fresh.conductor.beside, true, `the ${name} conductor has the lock`);
    await until(() => old.exits > 0, `the ${name} conductor to leave`);
    await until(() => fresh.conductor.beside === false, 'this version to take the lock');
    const sent = module.enqueue(p.root, 'From the old window');
    await until(() => fresh.started.includes(sent.id), 'this version to start it');
    await turn(p, sent);
    assert.deepEqual([old.started, fresh.started], [[], [sent.id]]);
    assert.equal(sessions(p.repo, 'From the old window'), 1, 'once');
  });

  test(`beside a ${name} conductor run from its own folder that still runs a turn, everything sent runs on this version, and it is told to leave only once its turn is over`, async t => {
    const p = setup(t), first = module.enqueue(p.root, 'The old turn');
    // Both conductors tick only when the test says, so only the change of the request file can keep from the old one what a window sends.
    const old = running(t, module.Conductor, { version: name, tickMs: HOUR });
    const oldTask = await turn(p, first);
    const fresh = running(t, Conductor, { version: NOW, tickMs: HOUR, idleMs: HOUR });
    assert.equal(fresh.conductor.beside, true, `the ${name} conductor keeps the lock`);
    // A window of this version sends a session. A window still open on the old one sends one too, and a follow-up to the old turn.
    const mine = enqueue(p.root, 'From the new window');
    const sent = module.enqueue(p.root, 'From the old window'), more = module.enqueue(p.root, 'And more from the old window', { continuationTaskId: oldTask });
    await until(() => mainFileRequests(p.root).filter(row => row.state === 'queued').every(row => Date.parse(row.notBefore) > Date.now()), 'this version to keep them from the old conductor, before either ticks', 3000);
    old.conductor.tick();
    assert.deepEqual(old.started, [first.id], `the ${name} conductor found nothing to start`);
    fresh.conductor.tick();
    assert.deepEqual(fresh.started, [mine.id, sent.id], 'this version starts both sessions; the follow-up waits for the old turn');
    await turn(p, mine); await turn(p, sent);
    assert.equal(old.exits, 0, 'it is not told to leave while its turn runs');
    // The old turn ends. Its conductor, run from its own folder, would stay: it is told to leave, and the follow-up runs here.
    resume(old); resume(fresh);
    sendCommand({ type: 'stop', root: p.root, taskId: oldTask });
    await until(() => old.exits > 0, `the ${name} conductor to leave`);
    await until(() => fresh.started.includes(more.id), 'the follow-up on this version');
    await until(() => texts(p.repo, oldTask).length === 2, 'the follow-up to be sent');
    assert.deepEqual([old.started, fresh.started], [[first.id], [mine.id, sent.id, more.id]]);
    assert.deepEqual(texts(p.repo, oldTask), ['The old turn', 'And more from the old window']);
    assert.deepEqual([sessions(p.repo, 'From the new window'), sessions(p.repo, 'From the old window')], [1, 1], 'once each');
    await until(() => fresh.conductor.beside === false, 'this version to take the lock');
  });
}

test('a 0.1.19 conductor an ELU window of 0.1.19 starts before promote() leaves alone the turn the conductor beside runs', async t => {
  const p = setup(t), first = v19.enqueue(p.root, 'The old turn'), old = running(t, v19.Conductor, { version: '0.1.19' });
  const oldTask = await turn(p, first);
  // This version's conductor ticks only when the test says, so the moment before promote() lasts.
  const fresh = running(t, Conductor, { version: NOW, tickMs: HOUR, idleMs: HOUR });
  assert.equal(fresh.conductor.beside, true);
  const beside = enqueue(p.root, 'Runs beside'); fresh.conductor.tick();
  assert.deepEqual(fresh.started, [beside.id]);
  const id = await turn(p, beside);
  // The 0.1.19 turn ends and its conductor exits: the lock is free, and another of its version starts.
  sendCommand({ type: 'stop', root: p.root, taskId: oldTask });
  await until(() => request(p.root, first.id)?.state === 'done', 'the 0.1.19 turn to end');
  await old.conductor.stop();
  const again = running(t, v19.Conductor, { version: '0.1.19' });
  assert.deepEqual([request(p.root, beside.id).state, request(p.root, beside.id).taskId, task(p.repo, id).state], ['running', id, 'running'], 'its recover() left the turn beside alone');
  await pause(200);
  assert.deepEqual([again.started, old.started, fresh.started], [[], [first.id], [beside.id]]);
  assert.equal(request(p.root, beside.id).state, 'running');
  // That one runs nothing, so it is told to leave, and this version takes the lock with its turn still running.
  fresh.conductor.asideAt = 0; fresh.conductor.tick();
  await until(() => again.exits > 0, 'the 0.1.19 conductor to leave');
  fresh.conductor.promotedAt = 0; fresh.conductor.tick();
  assert.equal(fresh.conductor.beside, false, 'this version took the lock');
  assert.deepEqual([request(p.root, beside.id).state, task(p.repo, id).state, sessions(p.repo, 'Runs beside')], ['running', 'running', 1]);
});

// The half minute a request is kept for, as if most of it, or all of it, had passed.
function age(id, left) {
  const dir = path.join(personalDirectory(), 'requests'), file = path.join(dir, fs.readdirSync(dir).find(name => name.endsWith('.json') && !name.endsWith('.beside.json')));
  const until = new Date(Date.now() + left).toISOString();
  fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).map(row => row.id === id ? { ...row, keptUntil: until, notBefore: until } : row)));
  return until;
}
test('what waits while a 0.1.19 conductor stays is kept from it half a minute at a time: the conductor beside renews that, nothing else does, and the 0.1.19 conductor starts it once that time has passed', async t => {
  const p = setup(t), first = v19.enqueue(p.root, 'The old turn'), old = running(t, v19.Conductor, { version: '0.1.19', tickMs: HOUR });
  const oldTask = await turn(p, first);
  saveConductorSettings({ maxAgents: 1 });
  const fresh = running(t, Conductor, { version: NOW, idleMs: HOUR });
  assert.equal(fresh.conductor.beside, true);
  const sent = enqueue(p.root, 'Waits for the one slot');
  const left = id => Date.parse(request(p.root, id).notBefore) - Date.now();
  assert.ok(left(sent.id) > 15000 && left(sent.id) <= 30000, 'kept for half a minute at most');
  old.conductor.tick(); await pause(200);
  assert.deepEqual([old.started, fresh.started, request(p.root, sent.id).state], [[first.id], [], 'queued'], 'it waits for the slot, on neither');
  // Most of that time has passed: the conductor beside renews it.
  age(sent.id, 5000);
  await until(() => left(sent.id) > 15000, 'the conductor beside to renew it');
  // That conductor is killed outright. Nothing renews what it kept, another message included.
  kill(fresh);
  const aged = age(sent.id, 5000), later = enqueue(p.root, 'Sent after it died');
  assert.equal(request(p.root, sent.id).notBefore, aged, 'not renewed');
  assert.ok(left(later.id) <= 30000, 'kept once, for the conductor its window starts');
  assert.ok([sent, later].every(row => mainFileRequests(p.root).some(main => main.id === row.id)), 'both wait where every version reads');
  // The time passes with no conductor of this version: the 0.1.19 one starts them.
  age(sent.id, -1000); age(later.id, -1000);
  resume(old); sendCommand({ type: 'stop', root: p.root, taskId: oldTask });
  await until(() => old.started.includes(sent.id), 'the 0.1.19 conductor to start the first');
  sendCommand({ type: 'stop', root: p.root, taskId: await turn(p, sent) });
  await until(() => old.started.includes(later.id), 'the 0.1.19 conductor to start the second');
  assert.deepEqual([sessions(p.repo, 'Waits for the one slot'), sessions(p.repo, 'Sent after it died')], [1, 1], 'once each');
});

test('this version\'s conductor does not leave while an ELU window of an earlier version is open, and a window of this version names its version', async t => {
  const p = setup(t), window = await openWindow(t);
  assert.deepEqual(conductorFiles.earlierWindows(NOW), [window.pid]);
  let exits = 0;
  const fresh = running(t, Conductor, { version: NOW, idleMs: 50, onExit: () => { exits++; } });
  await pause(500);
  assert.equal(exits, 0, 'it stays, so what that window sends finds this version and never starts its own');
  const sent = v16.enqueue(p.root, 'From the old window');
  await until(() => fresh.started.includes(sent.id), 'this version to start it');
  sendCommand({ type: 'stop', root: p.root, taskId: await turn(p, sent) });
  await until(() => request(p.root, sent.id)?.state === 'done', 'the turn to end');
  await pause(300);
  assert.equal(exits, 0);
  // The window closes: a window of this version in its place keeps no conductor.
  fs.writeFileSync(window.file, JSON.stringify({ pid: window.pid, identity: processIdentity(window.pid), version: NOW }));
  assert.deepEqual(conductorFiles.earlierWindows(NOW), []);
  fresh.conductor.windowsAt = 0;
  await until(() => exits > 0, 'it to leave when idle');
  // The lock an open window of this version holds says which version it runs.
  fs.rmSync(window.file);
  const claim = claimView(p.repo); t.after(() => claim.release());
  const record = JSON.parse(fs.readFileSync(fs.readdirSync(personalDirectory()).filter(name => /^view-[0-9a-f]{64}\.lock$/.test(name)).map(name => path.join(personalDirectory(), name))[0], 'utf8'));
  assert.equal(record.version, conductorFiles.RUNNING);
  assert.deepEqual(conductorFiles.earlierWindows(conductorFiles.RUNNING), []);
});

// A conductor of this version beside a 0.1.16 or 0.1.17 one is killed outright while it holds
// messages where those never read. Then that version is installed again.
async function leftBeside(t, name, module) {
  const p = setup(t); saveConductorSettings({ maxAgents: 1 });
  const first = module.enqueue(p.root, 'The old turn'), old = running(t, module.Conductor, { version: name });
  const oldTask = await turn(p, first);
  const fresh = running(t, Conductor, { version: NOW, idleMs: HOUR });
  assert.equal(fresh.conductor.beside, true);
  const one = enqueue(p.root, 'Waits one'), two = enqueue(p.root, 'Waits two');
  await pause(200);
  assert.deepEqual([fresh.started, old.started], [[], [first.id]], 'the one slot is taken, so both wait');
  kill(fresh);
  conductorFiles.installed.version = () => name;
  // The old turn ends, and the conductor of that version finds nothing more: it never reads them.
  sendCommand({ type: 'stop', root: p.root, taskId: oldTask });
  await until(() => request(p.root, first.id)?.state === 'done', 'the old turn to end');
  await pause(300);
  assert.deepEqual(old.started, [first.id], `${name} never reads them`);
  assert.deepEqual([one, two].map(row => request(p.root, row.id).state), ['queued', 'queued']);
  return { p, old, one, two };
}
for (const [name, module] of PUBLISHED.slice(0, 2)) {
  test(`messages a killed conductor left where ${name} never reads: the next start of 0.1.19 starts them`, async t => {
    const { p, old, one, two } = await leftBeside(t, name, module);
    await old.conductor.stop();
    // 0.1.19 is installed, and its conductor starts with the next thing sent.
    conductorFiles.installed.version = () => '0.1.19';
    const next = running(t, v19.Conductor, { version: '0.1.19' });
    await until(() => next.started.includes(one.id), 'the 0.1.19 conductor to start the first');
    sendCommand({ type: 'stop', root: p.root, taskId: await turn(p, one) });
    await until(() => next.started.includes(two.id), 'the 0.1.19 conductor to start the second');
    assert.deepEqual([old.started.length, next.started], [1, [one.id, two.id]]);
    assert.deepEqual([sessions(p.repo, 'Waits one'), sessions(p.repo, 'Waits two')], [1, 1], 'once each');
  });

  test(`messages a killed conductor left where ${name} never reads: this version starts them as its app opens, and says how many waited when a window of ${name} is open`, async t => {
    const { p, old, one, two } = await leftBeside(t, name, module);
    await old.conductor.stop();
    // This version is opened again. With no window of the earlier version open, it says nothing of them, and its conductor starts.
    conductorFiles.installed.version = () => NOW;
    let starts = 0;
    assert.equal(conductors.openingConductor({ start: () => { starts++; }, version: NOW }), null);
    assert.equal(starts, 1, 'the conductor starts as the app opens, with nothing sent');
    // With a window of the earlier version open, one line says how many waited.
    await openWindow(t);
    let fresh = null;
    assert.equal(conductors.openingConductor({ start: () => { fresh ??= running(t, Conductor, { version: NOW, idleMs: HOUR }); }, version: NOW }), '2 messages from before the downgrade were waiting. They start now.');
    await until(() => fresh.started.includes(one.id), 'this version to start the first');
    sendCommand({ type: 'stop', root: p.root, taskId: await turn(p, one) });
    await until(() => fresh.started.includes(two.id), 'this version to start the second');
    assert.deepEqual([old.started.length, fresh.started], [1, [one.id, two.id]]);
    assert.deepEqual([sessions(p.repo, 'Waits one'), sessions(p.repo, 'Waits two')], [1, 1], 'once each');
    // Nothing waits any more, so nothing more is said.
    assert.equal(conductors.openingConductor({ start: () => {}, version: NOW }), null);
  });

  test(`messages a killed conductor left where ${name} never reads, with the ${name} conductor still running: this version starts beside it as its app opens and starts them`, async t => {
    const { p, old, one, two } = await leftBeside(t, name, module);
    conductorFiles.installed.version = () => NOW;
    await openWindow(t);
    let fresh = null;
    assert.equal(conductors.openingConductor({ start: () => { fresh ??= running(t, Conductor, { version: NOW, idleMs: HOUR }); }, version: NOW }), '2 messages from before the downgrade were waiting. They start now.');
    await until(() => fresh.started.includes(one.id), 'this version to start the first');
    assert.deepEqual(old.started.length, 1, `${name} started neither`);
    assert.equal(sessions(p.repo, 'Waits one'), 1);
    assert.ok(two.id);
  });
}

test('one message that waited is said as one', async t => {
  const p = setup(t), first = v16.enqueue(p.root, 'The old turn'), old = running(t, v16.Conductor, { version: '0.1.16' });
  await turn(p, first); saveConductorSettings({ maxAgents: 1 });
  const fresh = running(t, Conductor, { version: NOW, idleMs: HOUR });
  enqueue(p.root, 'Waits alone'); await pause(100);
  kill(fresh); await old.conductor.stop();
  await openWindow(t);
  assert.equal(conductors.openingConductor({ start: () => {}, version: NOW }), '1 message from before the downgrade was waiting. It starts now.');
});
