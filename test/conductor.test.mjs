import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { project, fakeClis, config, approveProjectFiles, approvingConductor, CLI } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { ProjectController, projectSnapshot, registerProject } from '../lib/projects.mjs';
import { saveTask } from '../lib/state.mjs';
import { addToRequest, pendingRequests, removeRequest, updateRequest, takeRequest } from '../lib/workspace.mjs';
import { Conductor, enqueue, sendCommand, saveConductorSettings, conductorStatus, conductorNote, conductorRunning, conductorAlive, olderConductor, retryRequest, startQueued, VERSION } from '../lib/conductor.mjs';
// The conductor of 0.1.16 as published, which has no handover, on today's modules.
import * as earlier from './fixtures/conductor-0.1.16/conductor.mjs';
import { pendingRequests as earlierRequests, saveRequest as earlierSave } from './fixtures/conductor-0.1.16/workspace.mjs';
import { boardRows, barCells, rowCard } from '../lib/board.mjs';
import { saveSchedule, runScheduleNow, parseWhen } from '../lib/schedules.mjs';
import { saveBot } from '../lib/bots.mjs';
import { runBotSchedules } from '../lib/bot-schedules.mjs';
import { turnClock } from '../lib/turn-limits.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';

// A test's conductors, stopped before its folder is removed. The hooks of a test run in the
// order they were registered and the first one that throws ends them, so setup registers
// the stop ahead of everything else: removing the folder under a live run fails, and a
// conductor that is never stopped keeps this process running after the last test.
const LIVE = new WeakMap(), STOP_MS = 20000;
// Cleanup never waits forever: a conductor that will not stop ends the process, loudly.
function giveUp(message) { console.error(`conductor.test: ${message} Ending the test process.`); process.exit(1); }
async function stopAll(t) {
  for (const conductor of LIVE.get(t) ?? []) {
    const late = setTimeout(() => giveUp(`A conductor did not stop within ${STOP_MS / 1000} s.`), STOP_MS);
    try { await conductor.stop(); } finally { clearTimeout(late); }
  }
}
// Nothing may keep this file running once its tests are done.
after(() => { setTimeout(() => giveUp('Something is still running 10 s after the last test.'), 10000).unref(); });
// lead: the vendor new sessions start on (Claude Code when not given).
function setup(t, mode = 'answer', { name = undefined, lead = null } = {}) {
  LIVE.set(t, []); t.after(() => stopAll(t));
  const p = project(t), fake = fakeClis(p.parent, { mode, name });
  const previous = { PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  Object.assign(process.env, fake.env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const repo = repository(p.root); registerProject(repo);
  if (lead) new ProjectController(repo).setDefaultModel({ vendor: lead });
  return { ...p, ...fake, repo };
}
function conduct(t, options = {}) {
  const conductor = new Conductor({ tickMs: 20, ...options }).start();
  if (LIVE.has(t)) LIVE.get(t).push(conductor); else t.after(() => conductor.stop());
  return conductor;
}
async function until(check, message, timeout = 15000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const request = (root, id) => pendingRequests(root).find(row => row.id === id);
const task = (repo, id) => projectSnapshot(repo).tasks.find(row => row.id === id);

test('a session that a schedule starts is named by its first reply', async t => {
  const p = setup(t, 'answer', { name: 'Dependency update check' });
  const row = saveSchedule({ root: p.root, goal: 'Check the dependencies of this project for updates and tell me which ones are behind', when: parseWhen('daily 9:00') });
  runScheduleNow(row.id, new Date(), { start: () => true }); conduct(t);
  await until(() => projectSnapshot(p.repo).tasks[0]?.state === 'answered', 'the scheduled run');
  const [named] = projectSnapshot(p.repo).tasks;
  assert.deepEqual([named.title, named.titleBy, named.runs.length], ['Dependency update check', 'model', 1]);
  assert.match(boardRows([projectSnapshot(p.repo)], Date.now()).map(row => barCells(row, 60, Date.now()).map(cell => cell.text).join('')).join('\n'), /Dependency update check/);
});

test('a session that a schedule starts has the bots the schedule kept', async t => {
  const p = setup(t);
  const row = saveSchedule({ root: p.root, goal: 'Check the build', when: parseWhen('daily 9:00'), bots: ['reviewer', 'qa'] });
  runScheduleNow(row.id, new Date(), { start: () => true }); conduct(t);
  await until(() => projectSnapshot(p.repo).tasks[0]?.state === 'answered', 'the scheduled run');
  assert.deepEqual(projectSnapshot(p.repo).tasks[0].bots, ['reviewer', 'qa']);
});

// The owner picked Full access for this schedule, so its run is a session in Full access:
// Full's policy, with no sandbox around the network, and nobody asked.
test('a session that a Full access schedule starts runs in Full access', async t => {
  const p = setup(t);
  const row = saveSchedule({ root: p.root, goal: 'Check the build', when: parseWhen('every 3h'), permissions: 'full', picked: true });
  runScheduleNow(row.id, new Date(), { start: () => true }); conduct(t);
  await until(() => projectSnapshot(p.repo).tasks[0]?.state === 'answered', 'the scheduled run');
  const [run] = projectSnapshot(p.repo).tasks;
  assert.equal(run.permissions, 'full');
  assert.deepEqual(run.runs.filter(value => value.role === 'lead').map(value => [value.permissions, value.effectivePermissions]), [['full', 'full']]);
  const lead = fs.readFileSync(p.calls, 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.vendor === 'claude' && call.args.includes('-p'))[0];
  const flag = name => lead.args[lead.args.indexOf(name) + 1];
  assert.equal(flag('--permission-mode'), 'bypassPermissions');
  const settings = JSON.parse(flag('--settings'));
  assert.deepEqual(settings.sandbox, { enabled: false }, 'no sandbox, so the network is not fenced');
  assert.equal(settings.permissions.ask, undefined, 'and nothing asks');
  assert.match(boardRows([projectSnapshot(p.repo)], Date.now(), { schedules: [row] }).filter(value => value.kind === 'schedule').map(value => rowCard(value).text).join('\n'), /Each run has Full access\./);
});

test('a bot with its own schedule is left out of the sessions a schedule starts, so its schedule never runs there', async t => {
  const p = setup(t);
  saveBot({ name: 'nightly', instructions: 'Check the nightly build.', schedule: 'every 1h' });
  const row = saveSchedule({ root: p.root, goal: 'Check the build', when: parseWhen('every 1h'), bots: ['reviewer', 'nightly'] });
  conduct(t);
  const runs = () => pendingRequests(p.root).filter(value => value.scheduleId === row.id);
  for (const count of [1, 2]) {
    runScheduleNow(row.id, new Date(), { start: () => true });
    await until(() => runs().length === count && runs().every(value => value.state === 'done') && projectSnapshot(p.repo).tasks.length === count, `run ${count}`);
  }
  assert.deepEqual(projectSnapshot(p.repo).tasks.map(task => task.bots), [['reviewer'], ['reviewer']]);
  assert.equal(runBotSchedules(new Date(), { start: () => true }), 0);
  assert.equal(pendingRequests(p.root).filter(value => value.bot === 'nightly').length, 0, 'nothing queued for the bot in those sessions');
});

test("a bot's schedule runs in a session that edits the checkout in place while it has Full access", async t => {
  const p = setup(t);
  saveBot({ name: 'nightly', instructions: 'Check the nightly build.', schedule: 'every 1h' });
  enqueue(p.root, 'Tidy the notes here', { permissions: 'full', place: 'here', bots: ['nightly'] });
  conduct(t);
  await until(() => projectSnapshot(p.repo).tasks.length === 1 && pendingRequests(p.root).every(value => value.state === 'done'), 'the session ran');
  assert.equal(projectSnapshot(p.repo).tasks[0].place.kind, 'here');
  assert.equal(runBotSchedules(new Date(), { start: () => true }), 1, 'its first run is queued');
  const runs = () => pendingRequests(p.root).filter(value => value.bot === 'nightly' && value.scheduled);
  await until(() => runs().length === 1 && runs()[0].state === 'done', 'the run ended');
  const task = projectSnapshot(p.repo).tasks[0];
  assert.doesNotMatch(runs()[0].reason ?? '', /in place/); assert.ok(task.messages.some(row => row.to === '@nightly' && row.scheduled), 'the schedule wrote to it');
  assert.ok(task.runs.filter(row => row.role === 'bot:nightly').every(row => row.permissions === 'full') && task.runs.some(row => row.role === 'bot:nightly'), 'with Full access');
});

test('a queued message runs in the background and its request records the chat', async t => {
  const p = setup(t), conductor = conduct(t);
  const sent = enqueue(p.root, 'Can I add multiple agents?');
  await until(() => request(p.root, sent.id)?.state === 'done', 'finished request');
  const done = request(p.root, sent.id);
  assert.equal(task(p.repo, done.taskId).state, 'answered');
  assert.equal(task(p.repo, done.taskId).owner.pid, process.pid);
  assert.equal(conductor.runs.size, 0);
  assert.equal(projectSnapshot(p.repo).requests.length, 0, 'finished requests stay out of History');
  assert.equal(conductorStatus().running, true);
  const follow = enqueue(p.root, 'Can one review security?', { continuationTaskId: done.taskId });
  await until(() => request(p.root, follow.id)?.state === 'done', 'follow-up');
  assert.equal(task(p.repo, done.taskId).messages.length, 2);
});

// The stand-in model holds its turn for 30 s in this mode, so a turn ends when it is stopped.
async function working(t) {
  const p = setup(t, 'slow'), first = enqueue(p.root, 'Start the work'), conductor = conduct(t);
  await until(() => request(p.root, first.id)?.state === 'running', 'the first turn');
  const id = request(p.root, first.id).taskId;
  await until(() => task(p.repo, id)?.activeRole === 'lead', 'the model working');
  return { p, conductor, id };
}
const sayTo = (p, id, text, more = {}) => enqueue(p.root, text, { continuationTaskId: id, priority: 0, ...more });
const texts = (repo, id) => task(repo, id).messages.map(row => row.text);

test('messages sent while a session works wait, then go by themselves as one turn when it ends', async t => {
  const { p, conductor, id } = await working(t);
  const one = sayTo(p, id, 'Also cover refunds'), two = sayTo(p, id, 'And keep the old name');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual([request(p.root, one.id).state, request(p.root, two.id).state], ['queued', 'queued'], 'nothing is refused and nothing starts while the turn runs');
  assert.deepEqual(texts(p.repo, id), ['Start the work'], 'the running turn is not given them');
  sendCommand({ type: 'stop', root: p.root, taskId: id });
  // Nothing more is sent or pressed: the end of the turn starts the next one.
  await until(() => texts(p.repo, id).length === 2, 'the waiting messages to be sent');
  assert.deepEqual(texts(p.repo, id), ['Start the work', 'Also cover refunds\n\nAnd keep the old name'], 'in the order sent, as one message');
  assert.equal(conductor.runs.size, 1);
  assert.equal(pendingRequests(p.root).filter(row => row.continuationTaskId === id).length, 1, 'one request is left for the one turn');
});

test('a waiting message taken back is never sent, and one already starting cannot be taken back', async t => {
  const { p, id } = await working(t);
  const kept = sayTo(p, id, 'Keep this one'), gone = sayTo(p, id, 'Forget this one');
  assert.equal(takeRequest(p.root, gone.id)?.goal, 'Forget this one');
  assert.equal(takeRequest(p.root, gone.id), null, 'it is gone');
  sendCommand({ type: 'stop', root: p.root, taskId: id });
  await until(() => texts(p.repo, id).length === 2, 'the kept message to be sent');
  assert.deepEqual(texts(p.repo, id), ['Start the work', 'Keep this one']);
  assert.equal(takeRequest(p.root, kept.id), null, 'a message that was sent stays sent');
});

test('waiting messages keep their order across recipients, and only the owner’s own are joined', async t => {
  const { p, id } = await working(t);
  sayTo(p, id, 'For the model, first'); sayTo(p, id, 'Is this safe?', { bot: 'reviewer' }); sayTo(p, id, 'For the model, last');
  sendCommand({ type: 'stop', root: p.root, taskId: id });
  await until(() => texts(p.repo, id).includes('For the model, first'), 'the first waiting message');
  const sent = () => task(p.repo, id).messages.filter(row => !row.bot).map(row => row.to ? `${row.to} ${row.text}` : row.text);
  assert.deepEqual(sent(), ['Start the work', 'For the model, first'], 'a message to a bot in between ends the join');
  assert.equal(pendingRequests(p.root).filter(row => row.continuationTaskId === id && row.state === 'queued').length, 2);
});

test('a waiting message survives a conductor that stops, and the next conductor sends it', async t => {
  const { p, conductor, id } = await working(t);
  sayTo(p, id, 'Sent before the restart');
  await conductor.stop();
  assert.deepEqual(pendingRequests(p.root).filter(row => row.state === 'queued').map(row => row.goal), ['Sent before the restart']);
  assert.deepEqual(texts(p.repo, id), ['Start the work']);
  conduct(t);
  await until(() => texts(p.repo, id).length === 2, 'the message to be sent after the restart');
  assert.deepEqual(texts(p.repo, id), ['Start the work', 'Sent before the restart']);
});

// What ELU asks as it opens, and the login item on its first run after an update. start
// stands in for the conductor they would start.
test('work left queued by a conductor that was ended is started when asked, and not after the owner stopped the conductor himself, until work is queued', async t => {
  const { p, conductor, id } = await working(t);
  let starts = 0; const start = () => { starts++; return true; }, queued = () => pendingRequests(p.root).filter(row => row.state === 'queued').map(row => row.goal);
  sayTo(p, id, 'Sent before it was ended');
  assert.equal(startQueued({ start }), false, 'a conductor runs, and takes the queue itself'); assert.equal(starts, 0);
  // Ended from outside, as a restart of the computer ends it: its run is stopped and the message still waits.
  await conductor.stop();
  assert.deepEqual(queued(), ['Sent before it was ended']);
  assert.equal(startQueued({ start }), true); assert.equal(starts, 1);
  // The conductor that starts sends it. The owner then stops that one himself, with the command, while another message waits.
  const second = conduct(t);
  await until(() => texts(p.repo, id).length === 2 && task(p.repo, id)?.activeRole === 'lead', 'the message to be sent');
  sayTo(p, id, 'Sent before the stop');
  const stop = spawnSync(process.execPath, [CLI, 'conductor', 'stop'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(stop.stdout, 'The conductor stops its runs, keeps their history, and exits. It starts again when work is queued.\n');
  await until(() => second.closed && !conductorRunning(), 'the conductor to stop');
  assert.deepEqual(queued(), ['Sent before the stop']);
  assert.equal(startQueued({ start }), false, 'it stays stopped: nothing that only finds queued work starts it'); assert.equal(starts, 1);
  // With nothing running the command stops nothing, and says so.
  assert.equal(spawnSync(process.execPath, [CLI, 'conductor', 'stop'], { encoding: 'utf8', timeout: 30000 }).stdout, 'The conductor is not running.\n');
  // Work is queued, and whatever queues it starts the conductor: the stop is over.
  const third = conduct(t);
  await until(() => texts(p.repo, id).length === 3 && task(p.repo, id)?.activeRole === 'lead', 'the waiting message to be sent');
  sayTo(p, id, 'Sent before the restart');
  await third.stop();
  assert.equal(startQueued({ start }), true, 'ended from outside again, so what it left is started'); assert.equal(starts, 2);
  // Nothing queued: nothing to start.
  for (const row of pendingRequests(p.root).filter(value => value.state === 'queued')) removeRequest(p.root, row.id);
  assert.equal(startQueued({ start }), false); assert.equal(starts, 2);
});

// An update replaces the files under a conductor. The stand-in reads the version on disk at once
// instead of after 5 s, and next starts the new version's conductor in this process.
function updated(conductor, disk) { conductor.disk = disk; conductor.versionAt = 0; }
function oldConductor(t, { disk = '0.0.1', ...options } = {}) {
  const box = { fresh: null, claims: 0 };
  const conductor = new Conductor({ tickMs: 20, version: '0.0.1', onDisk: () => conductor.disk, next: () => { box.fresh ??= conduct(t); }, ...options });
  conductor.disk = disk;
  const launch = conductor.launch.bind(conductor);
  conductor.launch = (...args) => { box.claims++; return launch(...args); };
  conductor.start(); LIVE.get(t).push(conductor);
  return Object.assign(box, { conductor });
}
const requestsOf = conductor => [...conductor.runs.values()].map(run => run.requestId);

test('after an update the old conductor takes no new work: the new version runs it at once, the old run finishes, and the old conductor exits', async t => {
  // On Codex, whose turn takes no message while it works, so the follow-up waits for it.
  const p = setup(t, 'slow', { lead: 'codex' }), first = enqueue(p.root, 'Start the work');
  let exits = 0; const old = oldConductor(t, { onExit: () => { exits++; } });
  await until(() => request(p.root, first.id)?.state === 'running', 'the first turn');
  const id = request(p.root, first.id).taskId;
  await until(() => task(p.repo, id)?.activeRole === 'lead', 'the model working');
  assert.equal(old.claims, 1);
  // The update lands while the turn runs, and a new session and a follow-up are sent.
  updated(old.conductor, '0.0.2');
  const second = enqueue(p.root, 'New work'), more = sayTo(p, id, 'And the follow-up');
  await until(() => old.fresh && requestsOf(old.fresh).includes(second.id), 'the new version to start the new session');
  assert.equal(old.claims, 1, 'the replaced conductor claimed nothing more');
  assert.deepEqual(requestsOf(old.conductor), [first.id], 'its own run goes on');
  assert.equal(request(p.root, first.id).state, 'running', 'the new conductor left that run alone');
  assert.equal(task(p.repo, id).state, 'running');
  assert.equal(conductorStatus().running, true); assert.equal(conductorStatus().runs.length, 2);
  assert.equal(conductorNote(), `1 session started before the update finishes on 0.0.1. New ones start on ${VERSION}.`);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(request(p.root, more.id).state, 'queued', 'the follow-up waits for the turn the old version runs');
  assert.equal(exits, 0);
  // The stop reaches the conductor that runs the turn. Then the old one exits and the follow-up runs on the new one.
  sendCommand({ type: 'stop', root: p.root, taskId: id });
  await until(() => exits > 0, 'the old conductor to exit');
  assert.equal(old.conductor.runs.size, 0);
  await until(() => requestsOf(old.fresh).includes(more.id), 'the follow-up on the new version');
  await until(() => texts(p.repo, id).length === 2, 'the follow-up to be sent');
  assert.equal(old.claims, 1);
  assert.deepEqual(texts(p.repo, id), ['Start the work', 'And the follow-up'], 'each message sent once');
  const secondId = request(p.root, second.id).taskId;
  assert.deepEqual(texts(p.repo, secondId), ['New work']);
  assert.equal(projectSnapshot(p.repo).tasks.length, 2, 'no request started a session twice');
  assert.equal(conductorNote(), null);
});

test('a replaced conductor with nothing running exits; work already queued goes straight to the new version', async t => {
  const p = setup(t);
  let exits = 0; const idle = oldConductor(t, { onExit: () => { exits++; } });
  updated(idle.conductor, '0.0.2');
  await until(() => exits > 0, 'the idle conductor to exit');
  assert.equal(idle.fresh, null, 'nothing waits, so no conductor is started for it');
  await idle.conductor.stop();
  const sent = enqueue(p.root, 'Can I add multiple agents?');
  const busy = oldConductor(t, { disk: '0.0.2', onExit: () => { exits++; } });
  await until(() => request(p.root, sent.id)?.state === 'done', 'the queued request');
  assert.equal(busy.claims, 0, 'the replaced conductor never claimed it');
  assert.ok(busy.fresh, 'the new version took it');
  assert.equal(task(p.repo, request(p.root, sent.id).taskId).messages.length, 1);
});

test('elu conductor stop ends the new version and the old one still finishing its run', async t => {
  const p = setup(t, 'slow'), first = enqueue(p.root, 'Start the work');
  const old = oldConductor(t);
  await until(() => request(p.root, first.id)?.state === 'running', 'the first turn');
  const id = request(p.root, first.id).taskId;
  await until(() => task(p.repo, id)?.activeRole === 'lead', 'the model working');
  updated(old.conductor, '0.0.2'); enqueue(p.root, 'New work');
  await until(() => old.fresh?.runs.size === 1, 'the new version working');
  assert.equal(conductorRunning(), true);
  sendCommand({ type: 'shutdown' });
  await until(() => old.conductor.closed && old.fresh.closed, 'both conductors to stop');
  await until(() => old.conductor.runs.size === 0 && old.fresh.runs.size === 0, 'their runs to end');
  assert.equal(task(p.repo, id).state, 'stopped');
  assert.equal(conductorRunning(), false);
});

// The first update from a version without handover: the conductor of 0.1.16 keeps the lock and
// starts every queued request it can read until it is idle. claims counts what it started.
// updated() is the update: the version on disk changes, read at once instead of after 5 s.
function conductor016(t) {
  const box = { claims: 0, exits: 0, disk: '0.1.16' };
  const conductor = new earlier.Conductor({ tickMs: 20, version: '0.1.16', onDisk: () => box.disk, onExit: () => { box.exits++; conductor.stop(); } });
  const launch = conductor.launch.bind(conductor);
  conductor.launch = (...args) => { box.claims++; return launch(...args); };
  conductor.start(); LIVE.get(t).push(conductor);
  return Object.assign(box, { conductor, updated() { box.disk = '0.1.17'; conductor.versionAt = 0; } });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('beside a 0.1.16 conductor, queued requests wait where it never reads, and go back once it has exited', async t => {
  const p = setup(t), old = conductor016(t);
  await until(() => olderConductor()?.version === null, 'the 0.1.16 conductor to write its status');
  assert.equal(conductorAlive(), false, 'it takes no work from this version, so one starts beside it');
  assert.equal(conductorRunning(), true);
  const sent = enqueue(p.root, 'New work');
  assert.equal(request(p.root, sent.id).state, 'queued');
  assert.equal(earlierRequests(p.root).length, 0, 'the 0.1.16 conductor cannot read it');
  await pause(200);
  assert.equal(old.claims, 0);
  // A request 0.1.16 queued itself, such as its own retry after a rate limit, is moved there by the next write.
  const own = earlierSave(p.root, 'Queued by 0.1.16', undefined, { state: 'queued', priority: 0, continuationTaskId: null, taskId: null, attempts: 1, notBefore: new Date(Date.now() + 60000).toISOString(), queuedAt: new Date().toISOString(), reason: 'Rate limited. Retrying shortly.' });
  assert.deepEqual(earlierRequests(p.root).map(row => row.id), [own.id]);
  updateRequest(p.root, sent.id, { reason: 'Still waiting.' });
  assert.deepEqual(earlierRequests(p.root).map(row => row.id), [], 'held from it too');
  // elu conductor stop reaches it. Once it has exited, every request is where any version reads.
  sendCommand({ type: 'shutdown' });
  await until(() => old.exits > 0 && olderConductor() === null, 'the 0.1.16 conductor to stop');
  assert.equal(old.claims, 0);
  updateRequest(p.root, sent.id, { reason: 'Waiting to start.' });
  assert.deepEqual(earlierRequests(p.root).map(row => row.id).sort(), [sent.id, own.id].sort());
  assert.equal(fs.readdirSync(path.join(personalDirectory(), 'requests')).filter(name => name.endsWith('.beside.json')).length, 0);
});

// 0.1.16 took a request of at most 16000 characters and refused a longer one. A request of any
// length queued by this version waits where that conductor never reads, so it is never
// refused or started by it, and the new version runs it with every character.
test('beside a 0.1.16 conductor, a request over 16000 characters is never read by it and runs whole on the new version', async t => {
  const p = setup(t), old = conductor016(t);
  await until(() => olderConductor()?.version === null, 'the 0.1.16 conductor to write its status');
  const long = `Where is coupon normalization?\n${'Every line of this request matters. '.repeat(1000)}THE END`;
  assert.ok(long.length > 16000 * 2);
  assert.throws(() => earlierSave(p.root, long, undefined, { state: 'queued' }), { message: 'Enter a request of 1 to 16000 characters.' }, 'what 0.1.16 itself said to one this long');
  const sent = enqueue(p.root, long);
  assert.equal(request(p.root, sent.id).state, 'queued'); assert.ok(request(p.root, sent.id).goal === long);
  // A second message typed before it starts goes with it, however long the two are together.
  assert.ok(addToRequest(p.root, sent.id, 'And the refunds too.').goal === `${long}\n\nAnd the refunds too.`);
  assert.equal(earlierRequests(p.root).length, 0, 'the 0.1.16 conductor cannot read it');
  await pause(200);
  assert.equal(old.claims, 0);
  // The new version starts beside the old one and runs it: the model is sent every character.
  const fresh = conduct(t);
  assert.equal(fresh.beside, true);
  await until(() => request(p.root, sent.id)?.state === 'done', 'the new version to run it', 60000);
  assert.equal(old.claims, 0, 'the old conductor never started it');
  const id = request(p.root, sent.id).taskId, input = fs.readFileSync(path.join(p.parent, 'inputs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(row => row.vendor === 'claude' && row.args.includes('-p')).input;
  assert.ok(task(p.repo, id).goal === `${long}\n\nAnd the refunds too.`);
  assert.ok(input.includes(JSON.stringify(`${long}\n\nAnd the refunds too.`)), 'the whole request is in what the model read');
  assert.equal(task(p.repo, id).state, 'answered');
});

test('after the first update from 0.1.16, new work and a schedule run on the new version at once, the old turn finishes, and its follow-up then runs once', async t => {
  const p = setup(t, 'chatty'), first = enqueue(p.root, 'Start the work'), old = conductor016(t);
  await until(() => request(p.root, first.id)?.state === 'running', 'the first turn');
  const id = request(p.root, first.id).taskId;
  await until(() => task(p.repo, id)?.activeRole === 'lead', 'the model working');
  old.updated();
  const fresh = conduct(t);
  assert.equal(fresh.beside, true, 'the new version starts beside the old one, which keeps the lock');
  const second = enqueue(p.root, 'New work'), more = sayTo(p, id, 'And the follow-up');
  const schedule = saveSchedule({ root: p.root, goal: 'Check the build', when: parseWhen('daily 9:00') });
  runScheduleNow(schedule.id, new Date(), { start: () => true });
  await until(() => requestsOf(fresh).includes(second.id), 'the new version to start the new session');
  await until(() => pendingRequests(p.root).some(row => row.scheduleId === schedule.id && row.state === 'running'), 'the schedule on the new version');
  assert.equal(old.claims, 1, 'the old conductor claimed nothing new');
  assert.deepEqual(requestsOf(old.conductor), [first.id], 'its own turn goes on');
  assert.equal(request(p.root, first.id).state, 'running', 'the new conductor left that turn alone');
  assert.equal(conductorStatus().runs.length, 3);
  assert.equal(conductorNote(), `1 session started before the update finishes. New ones start on ${VERSION}.`);
  assert.equal(request(p.root, more.id).state, 'queued', 'the follow-up waits for the turn the old version runs');
  await until(() => old.exits > 0, 'the old conductor to finish its turn and exit', 60000);
  assert.notEqual(task(p.repo, id).state, 'stopped', 'its turn was never stopped');
  assert.equal(old.claims, 1);
  await until(() => !fresh.beside, 'the new version to take the lock');
  assert.equal(conductorAlive(), true);
  await until(() => request(p.root, more.id)?.state === 'done', 'the follow-up', 60000);
  assert.deepEqual(texts(p.repo, id), ['Start the work', 'And the follow-up'], 'each message sent once');
  assert.deepEqual(texts(p.repo, request(p.root, second.id).taskId), ['New work']);
  const scheduled = pendingRequests(p.root).filter(row => row.scheduleId === schedule.id);
  assert.equal(scheduled.length, 1, 'the schedule fired once');
  await until(() => request(p.root, scheduled[0].id)?.state === 'done', 'the scheduled run', 60000);
  assert.equal(projectSnapshot(p.repo).tasks.length, 3, 'no request started a session twice');
  assert.equal(old.claims, 1);
});

test('work 0.1.16 queued before the update waits for the new version, which counts the old turn against the limit', async t => {
  const p = setup(t, 'chatty'); saveConductorSettings({ maxAgents: 1 });
  const first = enqueue(p.root, 'Start the work'), old = conductor016(t);
  await until(() => request(p.root, first.id)?.state === 'running', 'the first turn');
  // An app of 0.1.16 queued it while the turn ran; the limit kept it waiting.
  const backlog = earlier.enqueue(p.root, 'Queued before the update');
  await pause(200);
  assert.equal(request(p.root, backlog.id).state, 'queued');
  old.updated();
  const fresh = conduct(t);
  await until(() => !earlierRequests(p.root).some(row => row.id === backlog.id), 'the new version to hold it');
  await pause(200);
  assert.equal(request(p.root, backlog.id).state, 'queued', 'one session at a time: the old turn still runs');
  await until(() => old.exits > 0, 'the old conductor to finish its turn and exit', 60000);
  await until(() => request(p.root, backlog.id)?.state === 'done', 'the held request', 60000);
  assert.equal(old.claims, 1, 'the old conductor never started it');
  assert.equal(fresh.beside, false);
  assert.deepEqual(texts(p.repo, request(p.root, backlog.id).taskId), ['Queued before the update']);
});

test('the agent limit and priority decide what starts, and stop frees the slot', async t => {
  const p = setup(t, 'slow'); saveConductorSettings({ maxAgents: 1 });
  const later = enqueue(p.root, 'Queued goal', { priority: 1 }), first = enqueue(p.root, 'Chat message', { priority: 0 });
  const conductor = conduct(t);
  await until(() => request(p.root, first.id)?.state === 'running', 'chat message starts first');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(request(p.root, later.id).state, 'queued'); assert.equal(conductor.runs.size, 1);
  const id = request(p.root, first.id).taskId;
  await until(() => task(p.repo, id)?.activeRole === 'lead', 'lead working');
  sendCommand({ type: 'stop', root: p.root, taskId: id });
  await until(() => task(p.repo, id)?.state === 'stopped', 'stopped task');
  assert.equal(request(p.root, first.id).state, 'done', 'a stopped run is not retried');
  await until(() => request(p.root, later.id)?.state === 'running', 'queued goal takes the free slot');
});

// The turn limits, shrunk for a test.
function quickClock(t, quietSeconds, capSeconds) {
  const before = { ...turnClock }; Object.assign(turnClock, { quietSeconds, capSeconds }); t.after(() => Object.assign(turnClock, before));
}

// A check and a model's turn both have their own limits (lib/turn-limits.mjs): a check that
// prints nothing, such as a slow test suite, is working, and so is a turn running one.
test('a quiet check, like a quiet model turn, is left to its own limits; one quiet past the cap is stopped and retried once', async t => {
  const p = setup(t), conductor = new Conductor({ stallMs: 50 }), stops = [];
  const controller = { repo: p.repo, stop: async (id, message) => { stops.push([id, message]); } };
  const sent = enqueue(p.root, 'Run the checks'); updateRequest(p.root, sent.id, { state: 'running' });
  for (const [id, activeRole] of [['1', 'checks'], ['2', 'lead'], ['3', 'bot:scout']]) {
    const log = path.join(p.parent, `${id}.log`); fs.writeFileSync(log, 'started\n');
    fs.mkdirSync(path.join(p.repo.state, 'tasks', id), { recursive: true });
    saveTask(p.repo, { id, kind: 'conversation', base: null, branch: null, worktree: p.repo.root, goal: 'Run the checks', state: 'running', activeRole, activeLog: log, createdAt: new Date().toISOString(), owner: { pid: process.pid, identity: null }, runs: [], sessions: {}, reviews: [], responses: [], messages: [] });
    conductor.runs.set(id, { root: p.root, requestId: id === '1' ? sent.id : null, taskId: id, goal: 'Run the checks', origin: null, attempts: 0, controller, quietSince: Date.now(), mark: null });
  }
  conductor.watch(); await new Promise(resolve => setTimeout(resolve, 120)); conductor.watch();
  assert.deepEqual(stops, [], 'past the stall time, none is stopped: each is its own limits\' to stop');
  // Quiet for a minute past the cap, which neither the runner nor the checks let happen.
  for (const run of conductor.runs.values()) run.quietSince -= (turnClock.capSeconds + 61) * 1000;
  conductor.watch();
  assert.deepEqual(stops, ['1', '2', '3'].map(id => [id, 'No progress for 121 minutes. Retrying.']));
  const checks = conductor.runs.get('1'); conductor.finish(checks, new Error('Stopped.'));
  const retried = request(p.root, sent.id);
  assert.deepEqual([retried.state, retried.attempts, retried.continuationTaskId, retried.reason], ['queued', 1, '1', 'It stopped making progress. Retrying.']);
});

// The owner's case, through the conductor: the project's test suite runs as a check and prints
// nothing for longer than the stall time.
test('a check that prints nothing for longer than the stall time runs to its end and passes', async t => {
  const p = setup(t, 'normal');
  config(p.root, value => { value.checks = [{ name: 'slow-tests', command: ['sh', '-c', 'sleep 2'] }]; return value; }); approveProjectFiles(p.root);
  const sent = enqueue(p.root, 'Normalize coupon codes', { permissions: 'full' });
  const conductor = approvingConductor(new Conductor({ tickMs: 20, stallMs: 300 })); LIVE.get(t).push(conductor); conductor.start();
  await until(() => request(p.root, sent.id)?.state === 'done', 'the finished request', 30000);
  const done = request(p.root, sent.id), finished = task(p.repo, done.taskId);
  assert.equal(done.attempts ?? 0, 0, 'not stopped and retried');
  assert.equal(finished.state, 'ready', JSON.stringify(finished.error));
  assert.equal(finished.evidence.results.find(row => row.name === 'slow-tests').status, 'passed');
});

test('a Claude turn that prints nothing is stopped by its quiet limit in one line, and not retried', async t => {
  const p = setup(t, 'slow'); quickClock(t, 2, 7200);
  const sent = enqueue(p.root, 'Hang without output'); conduct(t, { stallMs: 300 });
  await until(() => request(p.root, sent.id)?.state === 'done', 'the stopped turn', 20000);
  const done = request(p.root, sent.id), id = done.taskId;
  assert.equal(done.attempts ?? 0, 0, 'not retried');
  assert.equal(task(p.repo, id).error.message, 'Stopped after 2 seconds with no output. Reply to carry on.', 'an answer turn reads only, so it names no changes');
  assert.equal(task(p.repo, id).messages.filter(row => row.text === 'Hang without output').length, 1);
});

test('a headless Antigravity turn, which prints only at the end, is not stopped before the cap', async t => {
  const p = setup(t, 'slow'); quickClock(t, 1, 4);
  config(p.root, value => { value.roles.lead.vendor = 'agy'; return value; }); approveProjectFiles(p.root);
  const bin = path.join(p.dir, 'agy');
  atomic(path.join(personalDirectory(), 'conformance', 'agy.json'), { v: 1, bin, version: '1.5.4', steps: Object.fromEntries(ADAPTERS.agy.conformance.map(step => [step.id, step.id === 'relay' ? 'fail' : 'pass'])), relay: false, at: new Date().toISOString() });
  const started = Date.now(), sent = enqueue(p.root, 'Hang without output'); conduct(t, { stallMs: 300 });
  await until(() => request(p.root, sent.id)?.state === 'done', 'the capped turn', 30000);
  const done = request(p.root, sent.id);
  assert.ok(Date.now() - started >= 4000, 'ran to the cap: neither a quiet limit nor the stall time stopped it');
  assert.equal(done.attempts ?? 0, 0, 'not retried');
  assert.equal(task(p.repo, done.taskId).error.message, 'Stopped after 4 seconds, the most one turn may run. Reply to carry on.');
});

test('a request cancelled before dispatch is never started or revived', async t => {
  const p = setup(t);
  const sent = enqueue(p.root, 'Never mind'); removeRequest(p.root, sent.id);
  assert.equal(updateRequest(p.root, sent.id, { state: 'starting' }, { from: ['queued'] }), null);
  assert.equal(retryRequest(p.root, sent.id), null);
  conduct(t); await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(projectSnapshot(p.repo).tasks.length, 0); assert.equal(pendingRequests(p.root).length, 0);
  assert.equal(fs.existsSync(p.calls), false);
});

test('a request that cannot start is kept with its reason and can be retried', async t => {
  const p = setup(t, 'signed-out');
  const sent = enqueue(p.root, 'Explain the setup'); conduct(t);
  await until(() => ['blocked', 'done'].includes(request(p.root, sent.id)?.state), 'failed start');
  const row = request(p.root, sent.id);
  if (row.state === 'blocked') { assert.match(row.reason, /unavailable|signed out/); assert.equal(retryRequest(p.root, sent.id).state, 'queued'); }
  else assert.match(task(p.repo, row.taskId).error.message, /unavailable|signed out/);
});

test('Claude Code refusing to start shows its own reason', async t => {
  const p = setup(t, 'no-sandbox');
  const sent = enqueue(p.root, 'Explain the setup'); conduct(t);
  await until(() => ['blocked', 'done'].includes(request(p.root, sent.id)?.state), 'failed start');
  const row = request(p.root, sent.id), message = row.state === 'blocked' ? row.reason : task(p.repo, row.taskId).error.message;
  assert.match(message, /could not finish\. Error: sandbox required but unavailable: bubblewrap \(bwrap\) not installed, socat not installed$/);
});

test('a stop sent while no conductor ran does not end the next one', async t => {
  const p = setup(t);
  sendCommand({ type: 'shutdown' });
  let exits = 0; conduct(t, { onExit: () => { exits++; } });
  const sent = enqueue(p.root, 'Can I add multiple agents?');
  await until(() => request(p.root, sent.id)?.state === 'done', 'finished request');
  assert.equal(exits, 0);
  assert.equal(task(p.repo, request(p.root, sent.id).taskId).state, 'answered');
});

test('a shutdown starts no new run in the same tick', async t => {
  const p = setup(t);
  const conductor = conduct(t, { tickMs: 3600000 });
  const sent = enqueue(p.root, 'Can I add multiple agents?');
  sendCommand({ type: 'shutdown' }); conductor.tick();
  assert.equal(conductor.closed, true);
  assert.equal(request(p.root, sent.id).state, 'queued');
  assert.equal(conductor.runs.size, 0);
});

test('runs left by a conductor that died are marked stopped and their process is not adopted', async t => {
  const p = setup(t);
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  const dir = path.join(p.repo.state, 'tasks', '1'); fs.mkdirSync(dir, { recursive: true });
  saveTask(p.repo, { id: '1', kind: 'conversation', base: null, branch: null, worktree: p.repo.root, goal: 'Interrupted', state: 'running', activeRole: 'lead', activeLog: null, createdAt: new Date().toISOString(), owner: { pid: Number(dead), identity: 'not this process' }, runs: [], sessions: {}, reviews: [], responses: [], messages: [] });
  const live = enqueue(p.root, 'Left starting'); updateRequest(p.root, live.id, { state: 'starting' });
  new Conductor().recover();
  assert.equal(task(p.repo, '1').state, 'stopped'); assert.match(task(p.repo, '1').error.message, /Retry to continue/);
  assert.equal(request(p.root, live.id).state, 'queued');
});
// The app in a terminal starts the conductor in its time zone. The peer daemon, a schedule or a
// login item looks at it from another: each look here is a process of its own in that zone.
const conductorLib = new URL('../lib/conductor.mjs', import.meta.url).href;
const elsewhere = (TZ, code) => JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', `import { Conductor, conductorAlive } from ${JSON.stringify(conductorLib)}; ${code}`], { encoding: 'utf8', env: { ...process.env, TZ } }).stdout);
test('a conductor started in another time zone is the conductor: none starts beside it, its turn goes on, and what it leaves when it dies is recovered', async t => {
  const p = setup(t, 'slow'), first = enqueue(p.root, 'Start the work');
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `import { Conductor } from ${JSON.stringify(conductorLib)}; new Conductor({ tickMs: 20 }).start();`], { env: { ...process.env, TZ: 'America/Los_Angeles' }, stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  await until(() => request(p.root, first.id)?.state === 'running', 'the first turn');
  const id = request(p.root, first.id).taskId, file = path.join(p.repo.state, 'tasks', id, 'process.json'), model = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).pid; } catch { return null; } };
  await until(() => task(p.repo, id)?.activeRole === 'lead' && model(), 'the model working');
  const agent = model(), runs = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const look = `const alive = conductorAlive(); let second = 'started'; try { await new Conductor({ tickMs: 20 }).start().stop(); } catch (error) { second = error.message; } console.log(JSON.stringify({ alive, second }));`;
  for (const TZ of ['UTC', 'Asia/Kolkata']) {
    const seen = elsewhere(TZ, look);
    assert.equal(seen.alive, true, `it runs, seen from ${TZ}`); assert.match(seen.second, /holds this lock/, `no second conductor from ${TZ}`);
    assert.equal(task(p.repo, id).state, 'running', `the turn goes on, seen from ${TZ}`); assert.equal(request(p.root, first.id).state, 'running'); assert.equal(runs(agent), true, 'the model still works');
  }
  // It dies with its turn running. A conductor in another time zone marks the turn stopped and stops the model it left.
  holder.kill('SIGKILL'); await new Promise(resolve => holder.once('exit', resolve));
  assert.equal(elsewhere('UTC', `new Conductor().recover(); console.log(JSON.stringify({ alive: conductorAlive() }));`).alive, false);
  assert.equal(task(p.repo, id).state, 'stopped'); assert.match(task(p.repo, id).error.message, /Retry to continue/);
  await until(() => !runs(agent), 'the model it left to be stopped');
});

test("a request carries the owner's session choices; a teammate's question never does", t => {
  const p = setup(t), work = path.join(p.parent, 'work'); fs.mkdirSync(work);
  // Folders must sit in the home, which os.homedir() reads from HOME.
  const previous = process.env.HOME; process.env.HOME = p.parent; t.after(() => { process.env.HOME = previous; });
  const sent = enqueue(p.root, 'Normalize coupons', { permissions: 'auto', place: 'branch:feat/coupons', folders: [work] });
  const row = request(p.root, sent.id);
  assert.equal(row.permissions, 'auto'); assert.deepEqual(row.place, { kind: 'branch', branch: 'feat/coupons' }); assert.deepEqual(row.folders, [fs.realpathSync(work)]);
  const plain = request(p.root, enqueue(p.root, 'Plain').id);
  assert.equal('permissions' in plain, false); assert.equal('place' in plain, false); assert.equal('folders' in plain, false);
  assert.equal(request(p.root, enqueue(p.root, 'Here', { permissions: 'full', place: 'here' }).id).place.kind, 'here');
  assert.throws(() => enqueue(p.root, 'x', { permissions: 'locked' }), /Choose ask, auto, or full/);
  assert.throws(() => enqueue(p.root, 'x', { permissions: 'auto', place: 'here' }), /Here needs Full access/);
  assert.throws(() => enqueue(p.root, 'x', { place: 'branch:..' }), /plain branch name/);
  assert.throws(() => enqueue(p.root, 'x', { folders: [path.join(p.parent, 'missing')] }), /Folder not found/);
  const origin = kind => ({ kind, peer: 'b'.repeat(64), name: 'sara', a2aTaskId: 'task-1', threadId: 'thread-1', hop: 1 });
  for (const kind of ['ask', 'review']) assert.throws(() => enqueue(p.root, 'q', { origin: origin(kind), readOnly: true, context: 'ctx', permissions: 'ask' }), /Teammate questions stay read-only/, kind);
  assert.throws(() => enqueue(p.root, 'q', { origin: origin('ask'), readOnly: true, context: 'ctx', folders: [work] }), /Teammate questions stay read-only/);
  // A handoff waits for the owner, unless the owner already chose a mode for it.
  const waiting = request(p.root, enqueue(p.root, 'Do it', { origin: origin('handoff'), context: 'ctx' }).id);
  assert.equal(waiting.state, 'waiting'); assert.equal(waiting.readOnly, false);
  const queued = request(p.root, enqueue(p.root, 'Do it', { origin: origin('handoff'), context: 'ctx', permissions: 'ask' }).id);
  assert.equal(queued.state, 'queued'); assert.equal(queued.permissions, 'ask'); assert.equal(queued.readOnly, false);
});

test('the board puts questions first, then live work, the queue, and recent results', () => {
  const now = Date.parse('2026-11-08T20:00:00Z'), at = minutes => new Date(now - minutes * 60000).toISOString();
  const base = { kind: 'conversation', runs: [{ role: 'lead', at: at(30), costUsd: 0.25 }], messages: [], createdAt: at(40) };
  const projects = [{ name: 'ELU', root: '/p/ELU', activity: [{ at: at(2), text: 'model: Read src/old.ts', taskId: '1', step: 'Read src/old.ts' }, { at: at(1), text: 'model: Read src/disk.ts', taskId: '2', step: 'Read src/disk.ts' }, { at: at(0), text: 'model: Read src/other.ts', taskId: '3', step: 'Read src/other.ts' }], tasks: [
    { ...base, id: '1', state: 'answered', result: { summary: 'Done.\nMore' } },
    { ...base, id: '2', state: 'running', activeRole: 'lead', activeSince: at(4), goal: 'Fix disk' },
    { ...base, id: '3', state: 'needs_input', result: { question: 'Keep the floor?', choices: ['Yes'] } },
    { ...base, id: '4', state: 'answered', createdAt: at(3000), runs: [] },
  ], queue: [{ id: 'request-a', goal: 'Next goal', state: 'queued', priority: 1, queuedAt: at(2) }, { id: 'request-b', goal: 'Old', state: 'done' }] }];
  const rows = boardRows(projects, now);
  assert.deepEqual(rows.map(row => [row.id || row.request.id, row.label]), [['3', 'WAITING YOU'], ['2', 'answering'], ['request-a', 'queued'], ['1', 'answered']]);
  assert.equal(rows[1].now, 'Read src/disk.ts'); assert.equal(rows[1].time, '4m00'); assert.equal(String(rows[1].cost), '$0.25');
  assert.equal(rows[3].now, 'Done.');
  // A row of the Sessions list is exactly as wide as the list: its mark, its title and its age.
  for (const width of [28, 42]) assert.ok(rows.every(row => barCells(row, width, now).map(cell => cell.text).join('').length === width), `width ${width}`);
  // A session is known by its title: its number is never shown.
  assert.match(barCells(rows[1], 42, now).map(cell => cell.text).join(''), /^. Fix disk +4m00$/);
  assert.ok(rows.every(row => !/#\d/.test(barCells(row, 42, now).map(cell => cell.text).join(''))));
  // A bot at work is named as the owner writes it: it answers a message written to it, and otherwise reviews.
  const bot = extra => boardRows([{ name: 'ELU', root: '/p/ELU', activity: [], tasks: [{ ...base, id: '5', state: 'running', activeRole: 'bot:sec', activeSince: at(1), goal: 'Fix disk', ...extra }], queue: [] }], now)[0];
  assert.deepEqual([bot({ messages: [{ at: at(1), text: 'is it safe?', to: '@sec' }] }).agent, bot({ messages: [{ at: at(1), text: 'is it safe?', to: '@sec' }] }).label], ['@sec', 'answering']);
  assert.deepEqual([bot({ kind: undefined }).agent, bot({ kind: undefined }).label], ['@sec', 'reviewing']);
});
