import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, fakeClis, config, approveProjectFiles } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { projectSnapshot, registerProject } from '../lib/projects.mjs';
import { saveTask } from '../lib/state.mjs';
import { pendingRequests, removeRequest, updateRequest, takeRequest } from '../lib/workspace.mjs';
import { Conductor, enqueue, sendCommand, saveConductorSettings, conductorStatus, conductorNote, conductorRunning, retryRequest, VERSION } from '../lib/conductor.mjs';
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
function setup(t, mode = 'answer', { name = undefined } = {}) {
  LIVE.set(t, []); t.after(() => stopAll(t));
  const p = project(t), fake = fakeClis(p.parent, { mode, name });
  const previous = { PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  Object.assign(process.env, fake.env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const repo = repository(p.root); registerProject(repo);
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
  const p = setup(t, 'slow'), first = enqueue(p.root, 'Start the work');
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

test('a check that stops making progress is stopped and retried once; a quiet model turn is left to its own limits', async t => {
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
  assert.deepEqual(stops, [['1', 'No progress for 1 minutes. Retrying.']], 'only the check; the model turns are the runner\'s to stop');
  const checks = conductor.runs.get('1'); conductor.finish(checks, new Error('Stopped.'));
  const retried = request(p.root, sent.id);
  assert.deepEqual([retried.state, retried.attempts, retried.continuationTaskId, retried.reason], ['queued', 1, '1', 'It stopped making progress. Retrying.']);
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
  assert.equal(rows[1].now, 'Read src/disk.ts'); assert.equal(rows[1].time, '4m00'); assert.equal(rows[1].cost, '$0.25');
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
