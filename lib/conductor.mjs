import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomic, HOME_QUESTION, homeOrAbove, homeRefusal, isHomeRefusal, mkdir, noSymlinks, readJson, refuse, exactKeys, isObject } from './util.mjs';
import { lock, readTask, saveTask, tasks, taskDir } from './state.mjs';
import { processIdentity, recoverProcess } from './process.mjs';
import { personalDirectory } from './usage.mjs';
import { ProjectController, registeredProjects } from './projects.mjs';
import { pendingRequests, saveRequest, updateRequest, removeRequest, joinRequests, holdRequests } from './workspace.mjs';
import { BESIDE_LOCK, besideLock, besideStatusPath, conductorFolder, conductorLock, lockHolder, mainConductor, olderConductor, statusPath } from './conductor-files.mjs';
import { isPeerRun } from './runner.mjs';
import { sessionTasks, waitingTask } from './plan.mjs';
import { checkFolders, checkMode, checkPlace } from './modes.mjs';
import { peerFile } from './peer/paths.mjs';
import { peerSettings } from './peer/settings.mjs';
import { sanitize } from './peer/peerdata.mjs';
import { refreshAwake } from './awake.mjs';
import { pendingApprovals } from './approvals.mjs';
import { BOT_NAME, chatBots, needBot } from './bots.mjs';
import { checkModel } from './models.mjs';
import { turnClock } from './turn-limits.mjs';
import { checkHelps } from './remote-helper.mjs';
import { QUESTION_MAX, checkStandupFor } from './standup.mjs';

// The conductor is one background process per user. It owns every agent run, so work
// continues after a terminal closes. Terminals talk to it only through files in the
// personal directory: queued requests, stop commands, and the status it publishes.

// The version of the code this process runs. An update replaces the files on disk under it.
const packageVersion = () => { try { return readJson(fileURLToPath(new URL('../package.json', import.meta.url))).version; } catch { return null; } };
export const VERSION = packageVersion();
export const DEFAULT_SETTINGS = Object.freeze({ maxAgents: 4, stallMinutes: 8, retries: 1 });
const PROJECT_LIMIT = 4;
const folder = conductorFolder;
const commandFolder = () => path.join(folder(), 'commands');
const statusFile = statusPath;
const lockFile = conductorLock;
// Beside a conductor without handover (0.1.16 and earlier), this version's conductor takes
// new work under its own lock, status and command folder.
const besideCommands = () => path.join(folder(), 'commands-beside');
export { olderConductor };
const key = (root, id) => `${root}\0${id}`;
// A conductor an update replaced hands the lock to the new version at once and only finishes
// the runs it has. Until it exits it keeps its own status and command folder beside the new one's.
const DRAIN = /^draining-([0-9a-f-]{36})\.json$/;
const drainFile = id => path.join(folder(), `draining-${id}.json`);
const drainCommands = id => path.join(folder(), `commands-${id}`);

export function conductorSettings() {
  let value = {};
  try { const file = path.join(folder(), 'settings.json'); noSymlinks(file); if (fs.existsSync(file)) value = readJson(file); } catch { /* Defaults apply. */ }
  const pick = (name, min, max) => Number.isInteger(value?.[name]) && value[name] >= min && value[name] <= max ? value[name] : DEFAULT_SETTINGS[name];
  return { maxAgents: pick('maxAgents', 1, 16), stallMinutes: pick('stallMinutes', 1, 120), retries: pick('retries', 0, 5) };
}
export function saveConductorSettings(update) {
  const next = { ...conductorSettings(), ...update };
  if (!Number.isInteger(next.maxAgents) || next.maxAgents < 1 || next.maxAgents > 16) refuse('Choose 1 to 16 sessions at once.');
  mkdir(folder()); atomic(path.join(folder(), 'settings.json'), next); return conductorSettings();
}
// Views read this on every redraw, so it never starts a process. A conductor counts
// as running only while its heartbeat is fresh.
// runs counts those an earlier version still finishes too; running is only the conductor
// that takes new work.
// Beside a conductor without handover (0.1.16 and earlier), the one beside it takes new work,
// and the earlier one is listed with those that finish their runs.
export function conductorStatus(now = Date.now()) {
  const read = file => { try { noSymlinks(file); return fs.existsSync(file) ? readJson(file) : null; } catch { return null; } };
  const fresh = value => Boolean(value?.pid && !value.stopped && Date.parse(value.heartbeatAt) > now - 15000 && alive(value.pid));
  const main = read(statusFile()), side = read(besideStatusPath()), beside = fresh(side), value = beside ? side : main, running = beside || fresh(main);
  const earlier = beside && fresh(main) ? [{ version: main.version, runs: Array.isArray(main.runs) ? main.runs : [] }] : [];
  const draining = [...earlier, ...drainingConductors().filter(row => Date.parse(row.heartbeatAt) > now - 15000)];
  return { running, pid: running ? value.pid : null, version: running ? value.version ?? null : null, runs: [...(running ? value.runs ?? [] : []), ...draining.flatMap(row => row.runs)], queued: running && Number.isInteger(value.queued) ? value.queued : 0, draining: draining.map(row => ({ version: typeof row.version === 'string' ? row.version : null, runs: row.runs.length })), settings: conductorSettings(), error: running ? value.error ?? null : null, standup: running && value.standup === 1 };
}
// The conductors an update replaced that still finish their runs. strict also compares each
// one's process identity, so a reused process number never counts as one.
export function drainingConductors({ strict = false } = {}) {
  let names = [];
  try { const dir = folder(); noSymlinks(dir); names = fs.readdirSync(dir).filter(name => DRAIN.test(name)); } catch { return []; }
  const rows = [];
  for (const name of names) {
    let value = null; try { const file = path.join(folder(), name); noSymlinks(file); value = readJson(file); } catch { continue; }
    if (value?.id !== DRAIN.exec(name)[1] || !Number.isInteger(value.pid) || !Array.isArray(value.runs)) continue;
    rows.push({ ...value, live: alive(value.pid) && (!strict || !value.identity || [null, value.identity].includes(processIdentity(value.pid))) });
  }
  return strict ? rows : rows.filter(row => row.live);
}
// Said once as the app opens, while sessions started before an update finish on that version.
export function conductorNote(status = conductorStatus()) {
  const old = (status.draining ?? []).filter(row => row.runs > 0 && row.version !== VERSION), count = old.reduce((total, row) => total + row.runs, 0);
  if (!count) return null;
  const versions = [...new Set(old.map(row => row.version).filter(Boolean))];
  return `${count} session${count === 1 ? '' : 's'} started before the update ${count === 1 ? 'finishes' : 'finish'}${versions.length ? ` on ${versions.join(', ')}` : ''}. New ones start on ${VERSION}.`;
}
// Whether the conductor here runs a standup's question as one (lib/standup.mjs). One of an
// older build, still running after an update until it is idle, would run the question as a
// plain message of the owner's, so nothing of a standup is queued for it. With none running,
// the next one starts on the files on disk.
export function conductorTakesStandup(now = Date.now()) { const status = conductorStatus(now); return !status.running || status.standup; }
export const OLDER_CONDUCTOR = 'ELU still runs its sessions on the build from before your update, which cannot hold a standup. It moves to the new build once they end; try again then.';
// A signal-0 check costs no process start, so a conductor killed outright reads as off at once.
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
// The conductor that takes new work. One an update replaced may still finish runs beside it.
// One without handover (0.1.16 and earlier) takes none from this version: the conductor
// beside it does, and starts when it does not run.
export function conductorAlive() {
  const main = mainConductor();
  return Boolean(main && !main.older) || Boolean(lockHolder(besideLock()));
}
// Starts the background conductor unless one is already running.
export function startConductor() {
  if (conductorAlive()) return false;
  mkdir(folder());
  const log = path.join(folder(), 'conductor.log'); noSymlinks(log);
  if (fs.existsSync(log) && fs.statSync(log).size > 1024 * 1024) fs.truncateSync(log, 0);
  const out = fs.openSync(log, 'a', 0o600);
  try {
    const bin = fileURLToPath(new URL('../bin/elu-code.mjs', import.meta.url));
    spawn(process.execPath, [bin, 'conductor', '--daemon'], { cwd: os.homedir(), env: process.env, detached: true, stdio: ['ignore', out, out] }).unref();
  } finally { fs.closeSync(out); }
  return true;
}
// A stop goes to the conductor that runs the task; a shutdown to every conductor.
export function sendCommand(command) {
  if (!['stop', 'shutdown'].includes(command?.type)) refuse('Unknown conductor command.');
  if (command.type === 'stop' && (typeof command.root !== 'string' || !/^[1-9][0-9]*$/.test(String(command.taskId)))) refuse('Choose a running task to stop.');
  const value = { ...command, taskId: command.taskId == null ? undefined : String(command.taskId), at: new Date().toISOString() };
  const draining = drainingConductors(), owner = value.type === 'stop' ? draining.find(row => owns(row, value)) : null;
  if (owner) return void writeCommand(drainCommands(owner.id), value);
  // Beside a conductor without handover, a stop goes to the one that runs the task.
  const main = mainConductor(), beside = lockHolder(besideLock());
  if (value.type === 'stop' && beside && main?.older && !owns(main, value)) return void writeCommand(besideCommands(), value);
  writeCommand(commandFolder(), value);
  if (value.type === 'shutdown' && beside) writeCommand(besideCommands(), value);
  if (value.type === 'shutdown') for (const row of draining) { try { writeCommand(drainCommands(row.id), value); } catch { /* It ended meanwhile. */ } }
}
// Something that runs: the conductor that takes new work, one without handover, or one that
// finishes the runs it has.
export function conductorRunning() { return Boolean(lockHolder(lockFile()) || lockHolder(besideLock())) || drainingConductors().length > 0; }
const owns = (row, command) => row.runs.some(run => run.root === command.root && String(run.taskId) === String(command.taskId));
function writeCommand(dir, value) { mkdir(dir); atomic(path.join(dir, `${Date.now()}-${crypto.randomUUID()}.json`), value); }
// The peer daemon passes what another machine sent, so every field is checked here.
const ID = /^[A-Za-z0-9_-]{1,128}$/;
export function peerOrigin(value) {
  exactKeys(value, ['kind', 'peer', 'name', 'a2aTaskId', 'threadId', 'hop', 'bot', 'teams', 'own'], 'Request origin');
  if (!['ask', 'review', 'handoff', 'answer'].includes(value.kind)) refuse('Unknown peer request kind.');
  if (typeof value.peer !== 'string' || !/^[0-9a-f]{64}$/.test(value.peer)) refuse('A peer request needs the sender key.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 64 || sanitize(value.name, 64) !== value.name || /[\n\t"<>]/.test(value.name)) refuse('A peer request needs a plain sender name.');
  for (const field of ['a2aTaskId', 'threadId']) if (value[field] != null && (typeof value[field] !== 'string' || !ID.test(value[field]))) refuse('A peer request has an invalid task or thread ID.');
  if (!Number.isInteger(value.hop) || value.hop < 0 || value.hop > 16) refuse('A peer request has an invalid hop count.');
  // bot: the owner's shared bot the teammate wrote to. It answers and never edits, so a handoff names none.
  if (value.bot != null && (typeof value.bot !== 'string' || !BOT_NAME.test(value.bot) || value.kind === 'handoff')) refuse('A peer request names an invalid bot.');
  // teams: the teams of the project the session runs in, whose rules for teammates it is
  // told (lib/peer/access.mjs). own: the session the owner's own prompt would start, whose
  // Task waits for him to approve it.
  if (value.teams != null && (!Array.isArray(value.teams) || !value.teams.length || value.teams.length > 64 || value.teams.some(id => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)))) refuse('A peer request names an invalid team.');
  if (value.own != null && (value.own !== true || value.kind !== 'handoff')) refuse('Only a teammate\'s message started as your own session is own.');
  return { kind: value.kind, peer: value.peer, name: value.name, a2aTaskId: value.a2aTaskId ?? null, threadId: value.threadId ?? null, hop: value.hop, ...(value.bot != null ? { bot: value.bot } : {}), ...(value.teams != null ? { teams: [...new Set(value.teams)] } : {}), ...(value.own ? { own: true } : {}) };
}
// mine: the owner's own other computer started this session (lib/peer/remote.mjs). It is
// the owner's session in every way, so it has no peer origin: machine is that computer's
// key, name its owner's name there, remoteId the session's id on both.
export function mineOrigin(value) {
  exactKeys(value, ['machine', 'name', 'remoteId'], 'Session origin');
  if (typeof value.machine !== 'string' || !/^[0-9a-f]{64}$/.test(value.machine)) refuse('A session from your other computer needs its key.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 64 || sanitize(value.name, 64) !== value.name || /[\n\t"<>]/.test(value.name)) refuse('A session from your other computer needs a plain name.');
  if (typeof value.remoteId !== 'string' || !ID.test(value.remoteId)) refuse('A session from your other computer has an invalid id.');
  return { machine: value.machine, name: value.name, remoteId: value.remoteId };
}
// Lower priority numbers start first: Chat messages use 0, queued goals 1. A waiting
// request starts only after the owner accepts it (retryRequest). permissions, place and
// folders are the owner's session choices; a teammate's question never has them.
// bots: the bots in the session's chat. bot: the bot this message is written to, which
// answers it instead of the lead. Both name saved bots, and neither goes with a teammate's request.
// model: the model a new session runs on, { vendor, model }; without one it starts with the project's default.
// scheduled: the bot's own schedule wrote this message to it, in a session it is already in.
// botChat: the message starts the bot's own chat, the session its later messages in Chats continue.
// approved: the owner approved the session's Task; its work starts with no second planning turn.
// home: the owner let the new teammate's session this starts run in his home folder.
// picked: the owner picked permissions for this new session himself, so a lower default
// later leaves it. Kept on the request, so a retry from any window or after a restart knows.
// helps: the session on another computer of mine this new session of mine helps (lib/remote-helper.mjs).
// standup: a standup round (lib/standup-round.mjs): true, from /standup, in a new Standup
// session; { question }, from @everyone, in that Standup session (continuationTaskId) or a new
// one. standupFor: the round one session of the owner's answers in a read-only turn
// (checkStandupFor); it names nothing else.
export function enqueue(root, goal, { id, continuationTaskId = null, priority = 0, state = 'queued', origin, readOnly, context, scheduleId, permissions, place, folders, bots, bot, model, scheduled, botChat, approved, mine, home, picked, helps, standup, standupFor } = {}) {
  if (!['queued', 'waiting'].includes(state)) refuse('A new request is queued or waiting.');
  const own = mine == null ? null : mineOrigin(mine);
  if (own && (origin != null || continuationTaskId != null)) refuse('Only a new session of yours comes from your other computer.');
  const helping = helps == null ? null : checkHelps(helps);
  if (helping && (origin != null || continuationTaskId != null || own)) refuse('Only a new session of yours helps a session on your other computer.');
  if (readOnly !== undefined && typeof readOnly !== 'boolean') refuse('readOnly must be true or false.');
  const peer = origin == null ? null : peerOrigin(origin);
  if (!peer && context != null) refuse('Peer data needs a request origin.');
  // A teammate's message never starts a session over all of the owner's files unless he
  // allowed it. A later message is decided by where its session works (ProjectController.ask).
  if (home !== undefined && (home !== true || !peer || continuationTaskId != null)) refuse('Only a teammate\'s new session is let run in your home folder.');
  if (peer && homeOrAbove(root) && !home && continuationTaskId == null) refuse(homeRefusal(null));
  if (scheduleId !== undefined && (typeof scheduleId !== 'string' || !/^schedule-[a-f0-9]{8}$/.test(scheduleId))) refuse('Invalid schedule ID.');
  const session = {};
  if (permissions !== undefined) session.permissions = checkMode(permissions);
  if (place !== undefined) session.place = checkPlace(place, { mode: session.permissions });
  if (folders !== undefined) { const dirs = checkFolders(folders); if (dirs.length) session.folders = dirs; }
  if (model != null) session.model = checkModel(model);
  if (scheduled !== undefined && scheduled !== true || botChat !== undefined && botChat !== true) refuse('scheduled and botChat are true or left out.');
  if (scheduled && (bot == null || continuationTaskId == null)) refuse("A bot's scheduled turn names the bot and its session.");
  if (botChat && (bot == null || continuationTaskId != null)) refuse("A bot's own chat starts with a message to that bot.");
  if (picked !== undefined && (picked !== true || peer || permissions === undefined)) refuse('Only a mode the owner picked for his own new session is marked picked.');
  if (approved !== undefined && approved !== true || approved && (continuationTaskId == null || origin != null || scheduled || scheduleId || readOnly)) refuse('Only the owner approves a Task, in its own session.');
  const question = isObject(standup) ? standup.question ?? null : null;
  if (standup !== undefined && (standup !== true && !(isObject(standup) && Object.keys(standup).every(name => name === 'question') && (question === null || typeof question === 'string' && question.trim() && question.length <= QUESTION_MAX)) || standup === true && continuationTaskId != null || origin != null || own || helping || bot != null || scheduled || scheduleId || readOnly || approved)) refuse('A standup is a round of a Standup session.');
  if (standupFor !== undefined && (continuationTaskId == null || origin != null || helping || bot != null || scheduled || scheduleId || readOnly || approved || Object.keys(session).length || bots !== undefined || standup)) refuse('A standup asks one of your sessions, and nothing else.');
  const asked = standupFor !== undefined ? checkStandupFor(standupFor) : null;
  if ((standup !== undefined || asked) && !conductorTakesStandup()) refuse(OLDER_CONDUCTOR);
  const chat = { ...(bots !== undefined ? { bots: chatBots(bots) } : {}), ...(bot != null ? { bot: needBot(bot).name } : {}), ...(scheduled ? { scheduled: true } : {}), ...(botChat ? { botChat: true } : {}), ...(approved ? { approved: true } : {}) };
  if (peer && Object.keys(chat).length) refuse("Bots join your own sessions, not a teammate's question.");
  let fields = { ...(standup ? { standup: standup === true ? true : { question } } : {}), ...(asked ? { standupFor: asked } : {}), ...(readOnly ? { readOnly: true } : {}), ...(scheduleId ? { scheduleId } : {}), ...session, ...(picked ? { picked: true } : {}), ...chat, ...(own ? { mine: own } : {}), ...(helping ? { helps: helping } : {}) };
  if (peer) {
    const limit = peer.kind === 'review' ? 160000 : 16000;
    if (typeof context !== 'string' || !context.trim() || context.length > limit) refuse(`Peer data must be 1 to ${limit} characters.`);
    if (isPeerRun(peer) && readOnly !== true) refuse('Asks and reviews from a teammate must be read-only.');
    if (isPeerRun(peer) && Object.keys(session).length) refuse('Teammate questions stay read-only.');
    // A handoff edits the owner's project, so only the owner can start it: it waits until
    // the owner accepts it, or is queued when the owner already chose a mode.
    if (peer.kind === 'handoff') { readOnly = false; if (!session.permissions) state = 'waiting'; }
    fields = { origin: peer, readOnly: readOnly === true, context, ...session, ...(home ? { home: true } : {}) };
  }
  const reason = state === 'waiting' ? peer ? `${peer.kind} from @${peer.name}` : 'Ready to review and start.' : 'Waiting to start.';
  return saveRequest(root, goal, id, { state, priority, continuationTaskId: continuationTaskId == null ? null : String(continuationTaskId), taskId: null, attempts: 0, notBefore: null, queuedAt: new Date().toISOString(), reason, ...fields });
}
// Said under the plan a teammate's message led to, when its Task waits for the owner.
export const PLAN_WAITS = 'This is a plan. The owner of this machine reviews it as a Task, and nothing is changed until they approve it. This thread gets no further reply about it.';
// The peer daemon reads these and answers the teammate. The request ID becomes a file name.
function writeOutbox(root, row, { taskId = null, outcome, text = null, costUsd = null, error = null, finishedAt = new Date().toISOString() }) {
  if (!/^request-[a-f0-9-]+$/.test(row.id)) refuse('Invalid request ID.');
  atomic(peerFile('outbox', `${row.id}.json`), { requestId: row.id, root, origin: row.origin, taskId, outcome, text, costUsd, finishedAt, error });
}
export function retryRequest(root, id) {
  return updateRequest(root, id, { state: 'queued', attempts: 0, notBefore: null, queuedAt: new Date().toISOString(), blockedAt: null, reason: 'Waiting to start.' }, { from: ['blocked', 'waiting'] });
}

export class Conductor {
  // next starts the conductor of the version on disk; tests pass their own.
  constructor({ tickMs = 500, idleMs = 10 * 60000, stallMs, onExit, version = VERSION, onDisk = packageVersion, next = startConductor } = {}) {
    Object.assign(this, { tickMs, idleMs, stallMs, onExit, version, onDisk, next });
    this.runs = new Map(); this.controllers = new Map(); this.idleSince = Date.now(); this.queued = 0; this.error = null; this.draining = null; this.othersNow = [];
  }
  start() {
    this.release = this.take();
    this.startedAt = new Date().toISOString();
    // Commands written before this conductor held the lock were for an earlier one (a stop
    // sent while none ran); obeyed now, they would end this conductor and its first run. A
    // stop for a run that a replaced conductor still finishes goes on to that one.
    const others = this.others(true);
    for (const dir of [commandFolder(), besideCommands()].slice(this.beside ? 1 : 0)) {
      mkdir(dir);
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        let command = null; try { noSymlinks(file); command = readJson(file); } catch { /* Dropped. */ }
        if (command?.type === 'stop') this.forward(command, others);
        fs.rmSync(file, { force: true });
      }
    }
    // Beside a conductor without handover, what runs is its or this one's: nothing is
    // recovered until it has exited (promote).
    if (!this.beside) { try { this.recover(); } catch (error) { this.error = error.message; } }
    this.timer = setInterval(() => this.tick(), this.tickMs); this.tick();
    return this;
  }
  // Takes the lock. One that a conductor without handover holds (0.1.16 and earlier) stays
  // with it: this one takes new work beside it, under its own lock, while that one finishes
  // its runs and exits, and then takes the lock too (promote). In the moment between that exit
  // and promote(), the lock is free while the conductor beside still runs: an app of that
  // version still open can start the conductor on disk then, which leaves the lock to it, so
  // its recover() never takes what that one starts or runs for interrupted.
  take() {
    for (let attempt = 0; ; attempt++) {
      let release;
      try { release = lock({ state: personalDirectory() }, 'conductor'); }
      catch (error) {
        if (olderConductor()) { const release = lock({ state: personalDirectory() }, BESIDE_LOCK); this.beside = true; return release; }
        if (attempt > 0) throw error;
        continue;
      }
      if (lockHolder(besideLock())) { try { release(); } catch { /* The lock file is already gone. */ } refuse('The conductor already runs.'); }
      return release;
    }
  }
  async stop() {
    if (this.closed) return; this.closed = true; clearInterval(this.timer); this.watchRequests(false);
    const runs = [...this.runs.values()];
    for (const run of runs) run.stopped = true;
    await Promise.all(runs.map(run => run.controller.stop(run.taskId, 'ELU stopped its conductor. Retry to continue.').catch(() => {})));
    await Promise.all(runs.map(run => run.done));
    try { this.write(true); } catch { /* Status is best effort. */ }
    if (this.draining) { try { fs.rmSync(drainCommands(this.draining), { recursive: true, force: true }); } catch { /* Removed already. */ } }
    // Another conductor may still have runs, so what keeps the computer awake is read again.
    refreshAwake(this.draining || this.beside || drainingConductors().length ? {} : { busy: false });
    try { this.release?.(); } catch { /* The lock file is already gone. */ }
  }
  tick() {
    if (this.busy || this.closed) return; this.busy = true;
    try {
      this.commands(); if (this.closed) return;
      if (this.beside) this.promote();
      if (!this.draining && this.replaced()) this.drain();
      this.watchRequests();
      this.watch();
      if (this.draining) this.handOn(); else this.dispatch();
      this.error = null;
    }
    catch (error) { this.error = error.message; }
    finally { this.busy = false; }
    try { this.write(); } catch { /* Status is best effort. */ }
    // Keeps the computer awake while agents run: at once when work starts or ends, else every 30 s.
    const busy = this.runs.size > 0 || this.queued > 0 || (!this.draining && this.othersNow.some(row => row.runs.length > 0));
    if (!this.closed && (busy !== this.awake || Date.now() - (this.awakeAt ?? 0) > 30000)) { this.awake = busy; this.awakeAt = Date.now(); refreshAwake({ busy }); }
    if (this.closed) return;
    // Replaced: it exits once the runs it had are over. Otherwise it exits after the idle time,
    // and never beside a conductor without handover: alone, that one would start what an ELU
    // window still open on its version sends.
    if (this.draining ? !this.runs.size : !this.runs.size && !this.queued && !this.beside && Date.now() - this.idleSince > this.idleMs) this.onExit?.();
  }
  // After an update this conductor runs the old code. From then on it takes no new work: it
  // gives up the lock, so the new version's conductor starts beside it and takes the queue at
  // once, finishes the runs it has, and exits. Only the conductor that holds the lock claims
  // requests, so nothing runs twice. Read at most every 5 s.
  drain() {
    this.write(true);
    this.draining = crypto.randomUUID(); this.beside = false; this.written = null; this.queued = 0;
    mkdir(drainCommands(this.draining)); this.write();
    const release = this.release; this.release = null;
    try { release?.(); } catch { /* The lock file is already gone. */ }
    this.handOn(true);
  }
  // While work waits and no conductor takes it, this one starts the new version's.
  handOn(now = false) {
    if (!now && Date.now() - (this.handedAt ?? 0) < 5000) return;
    this.handedAt = Date.now();
    if (conductorAlive()) return;
    const waiting = registeredProjects().some(repo => { try { return pendingRequests(repo.root).some(row => row.state === 'queued'); } catch { return false; } });
    if (waiting) this.next();
  }
  // Beside a conductor without handover: once it has exited, this one takes the lock, and with
  // it every request, and recovers what it left. A conductor with handover that took the lock
  // instead leaves this one only its runs to finish. Read every second, and at once when the
  // lock file is gone, so no conductor of that version starts in between.
  promote() {
    if (fs.existsSync(lockFile()) && Date.now() - (this.promotedAt ?? 0) < 1000) return;
    this.promotedAt = Date.now();
    const main = mainConductor();
    if (main?.older || main && !main.known) return;
    if (main) return void this.drain();
    let release; try { release = lock({ state: personalDirectory() }, 'conductor'); } catch { return; }
    const beside = this.release; this.release = release;
    try { this.write(true); } catch { /* Status is best effort. */ }
    this.beside = false; this.wasBeside = true; this.written = null; this.othersAt = 0; this.awakeAt = 0;
    try { beside?.(); } catch { /* The lock file is already gone. */ }
    try { this.others(true); this.recover(); } catch (error) { this.error = error.message; }
  }
  // Beside a conductor without handover, which starts every queued request in the main file
  // on its next tick, what an ELU window still open on that version sends there is moved as
  // soon as the file changes (holdRequests), not on this one's next tick. Watched only while
  // beside; if the watch fails, each tick still moves it.
  watchRequests(on = this.beside && !this.closed) {
    if (!on) { try { this.requestWatch?.close(); } catch { /* Closed already. */ } this.requestWatch = null; return; }
    if (this.requestWatch) return;
    const dir = path.join(personalDirectory(), 'requests');
    const hold = (event, name) => {
      if (!this.beside || this.closed || name && (!name.endsWith('.json') || name.endsWith('.beside.json'))) return;
      try { for (const repo of registeredProjects()) { try { holdRequests(repo.root); } catch { /* The next tick moves it. */ } } } catch { /* The next tick moves it. */ }
    };
    try { mkdir(dir); this.requestWatch = fs.watch(dir, hold); this.requestWatch.on('error', () => this.watchRequests(false)); this.requestWatch.unref?.(); } catch { this.requestWatch = null; }
  }
  // The runs replaced conductors still finish, read at most every 2 s: their set only shrinks,
  // so a moment-old copy never misses one. One that died is cleared up and its requests recovered.
  // Beside a conductor without handover, its runs are counted too (id null).
  others(now = false) {
    if (!now && Date.now() - (this.othersAt ?? 0) < 2000) return this.othersNow;
    this.othersAt = Date.now();
    const rows = drainingConductors({ strict: true }).filter(row => row.id !== this.draining), dead = rows.filter(row => !row.live);
    for (const row of dead) { fs.rmSync(drainFile(row.id), { force: true }); fs.rmSync(drainCommands(row.id), { recursive: true, force: true }); }
    this.othersNow = rows.filter(row => row.live);
    if (this.beside) { const older = olderConductor(); if (older) this.othersNow.push({ ...older, id: null }); }
    if (dead.length && this.timer && !this.beside) { try { this.recover(); } catch (error) { this.error = error.message; } }
    return this.othersNow;
  }
  forward(command, others = this.others()) {
    const owner = others.find(row => owns(row, command));
    if (owner) { try { writeCommand(owner.id ? drainCommands(owner.id) : commandFolder(), command); } catch { /* It ended meanwhile. */ } }
  }
  replaced() {
    if (Date.now() - (this.versionAt ?? 0) < 5000) return this.wasReplaced === true;
    this.versionAt = Date.now(); const disk = this.onDisk();
    this.wasReplaced = Boolean(this.version && disk && disk !== this.version);
    return this.wasReplaced;
  }
  // One that took the lock after a conductor without handover exited also reads what was sent
  // to it while it ran beside that one.
  commands() {
    const dirs = this.draining ? [drainCommands(this.draining)] : this.beside ? [besideCommands()] : this.wasBeside ? [commandFolder(), besideCommands()] : [commandFolder()];
    const names = dirs.flatMap(dir => { try { return fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => [dir, name]); } catch { return []; } }).sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    for (const [dir, name] of names) {
      const file = path.join(dir, name); let command = null;
      try { noSymlinks(file); command = readJson(file); } catch { /* A malformed command is dropped. */ }
      fs.rmSync(file, { force: true });
      if (command?.type === 'shutdown') { if (this.onExit) this.onExit(); else this.stop(); return; }
      if (command?.type === 'stop') {
        const run = this.runs.get(key(command.root, String(command.taskId)));
        if (run) { run.stopped = true; run.controller.stop(run.taskId).catch(() => {}); }
        else if (!this.draining) this.forward(command);
      }
    }
  }
  // A run whose agent log has not grown for the stall time is stopped and retried. A run
  // waiting for the owner's approval is quiet on purpose, so it is not stalled. A model's turn
  // has its own limits in the runner (lib/turn-limits.mjs): it stops when its vendor has
  // printed nothing for the quiet limit, or at the cap, and says so in one line. So the stall
  // time is for the other steps, such as checks; a model's turn is stopped here only if it is
  // still quiet a minute past the cap, which the runner does not let happen.
  watch() {
    const now = Date.now(), stall = this.stallMs ?? conductorSettings().stallMinutes * 60000;
    for (const run of this.runs.values()) {
      if (run.stalled || run.stopped) continue;
      let task; try { task = readTask(run.controller.repo, run.taskId); } catch { continue; }
      const model = Boolean(task.activeRole) && task.activeRole !== 'checks', limit = model ? Math.max(stall, (turnClock.capSeconds + 60) * 1000) : stall;
      let size = null; try { if (task.activeLog) size = fs.statSync(task.activeLog).size; } catch { /* Not started yet. */ }
      const mark = `${task.activeLog}:${size}`;
      let waiting = false; try { waiting = pendingApprovals({ root: run.controller.repo.project ?? run.root, taskId: run.taskId }).length > 0; } catch { /* Unreadable: counted as quiet. */ }
      if (!task.activeLog || mark !== run.mark || waiting) { run.mark = mark; run.quietSince = now; continue; }
      if (now - run.quietSince > limit) {
        run.stalled = true;
        run.controller.stop(run.taskId, `No progress for ${Math.round(limit / 60000) || 1} minutes. Retrying.`).catch(() => {});
      }
    }
  }
  // Only the conductor that holds the lock dispatches. The runs a replaced one still finishes
  // count against every limit, and a follow-up waits for its session's turn there too.
  // Beside a conductor without handover, which starts every queued request it can read, the
  // queued ones are first moved where it does not read (holdRequests), and a session it is
  // starting or running, read from the requests themselves, is busy too.
  dispatch() {
    const now = Date.now(), { maxAgents } = conductorSettings(), waiting = [], others = this.others().flatMap(row => row.runs), busy = new Set();
    const all = () => [...this.runs.values(), ...others];
    for (const repo of registeredProjects()) {
      if (this.beside) { try { holdRequests(repo.root); } catch { /* Next tick. */ } }
      let rows; try { rows = pendingRequests(repo.root); } catch { continue; }
      for (const row of rows) {
        if (row.state === 'queued') waiting.push({ repo, row });
        if (this.beside && ['starting', 'running'].includes(row.state)) for (const id of [row.taskId, row.continuationTaskId]) if (id != null) busy.add(key(repo.root, String(id)));
        if (row.state === 'done' && !(Date.parse(row.finishedAt) > now - 120000)) { try { removeRequest(repo.root, row.id); } catch { /* Next tick. */ } }
      }
    }
    this.queued = waiting.length;
    if (this.runs.size || others.length || waiting.length) this.idleSince = now;
    const ready = waiting.filter(({ row }) => !(Date.parse(row.notBefore) > now))
      .sort((a, b) => (a.row.priority ?? 1) - (b.row.priority ?? 1) || Date.parse(a.row.queuedAt ?? a.row.createdAt) - Date.parse(b.row.queuedAt ?? b.row.createdAt));
    // A teammate's question and a session a teammate's message started (origin.own) share
    // the peer slots, so teammates never fill every slot of the owner's.
    const teammates = origin => isPeerRun(origin) || origin?.own === true;
    const slots = peerSettings().peerSlots, peerRuns = () => all().filter(run => teammates(run.origin)).length;
    for (const { repo, row } of ready) {
      // A standup round only waits for the answers it asked for, so it takes no slot of theirs
      // until its summary turn starts, which is a model's turn like any other.
      const counted = run => !run.round || run.summing?.() === true;
      if (all().filter(counted).length >= maxAgents) break;
      if (teammates(row.origin) && peerRuns() >= (Number.isInteger(slots) ? slots : 1)) continue;
      const mine = all().filter(run => run.root === repo.root);
      if (mine.filter(counted).length >= PROJECT_LIMIT) continue;
      // A follow-up waits until the current turn of the same chat ends.
      if (row.continuationTaskId && (mine.some(run => String(run.taskId) === String(row.continuationTaskId)) || busy.has(key(repo.root, String(row.continuationTaskId))))) continue;
      const turn = this.together(repo, row, ready);
      if (turn) this.launch(repo, turn);
    }
  }
  // What the owner sent to a session while it worked goes as one turn: the waiting messages
  // that follow this one, to the same recipient and in the order sent, are joined to it. A
  // message to someone else ends the join, so nothing overtakes it. A bot's scheduled turn,
  // a teammate's message, a retry and a message that changes the session's choices each
  // stay a turn of their own. Returns the request to start, or null when it was taken back.
  together(repo, row, ready) {
    const typed = value => Boolean(value.continuationTaskId) && !value.origin && !value.scheduled && !value.scheduleId && !value.botChat && !value.attempts && !value.readOnly && !value.standupFor && !value.standup
      && ['permissions', 'place', 'folders', 'bots', 'model'].every(name => value[name] === undefined);
    if (!typed(row)) return row;
    const after = ready.filter(value => value.repo.root === repo.root && value.row.continuationTaskId === row.continuationTaskId).map(value => value.row);
    const ids = [row.id];
    for (const next of after.slice(after.indexOf(row) + 1)) { if (!typed(next) || (next.bot ?? null) !== (row.bot ?? null) || (next.priority ?? 1) !== (row.priority ?? 1)) break; ids.push(next.id); }
    return ids.length > 1 ? joinRequests(repo.root, ids) : row;
  }
  controller(repo) {
    let controller = this.controllers.get(repo.root);
    if (!controller) { controller = new ProjectController(repo); this.controllers.set(repo.root, controller); }
    else controller.reloadConfig();
    return controller;
  }
  launch(repo, row) {
    if (!updateRequest(repo.root, row.id, { state: 'starting', reason: 'Starting.' }, { from: ['queued'], shelter: this.beside === true })) return;
    let controller, run;
    try { controller = this.controller(repo); run = controller.ask(row.goal, row.continuationTaskId ?? null, { readOnly: row.readOnly === true, origin: row.origin ?? null, context: row.context ?? null, permissions: row.permissions, place: row.place, folders: row.folders, bots: row.bots, bot: row.bot ?? null, scheduled: row.scheduled === true, botChat: row.botChat === true, timed: Boolean(row.scheduleId), approved: row.approved === true, ...(row.model ? { model: row.model } : {}), ...(row.mine ? { mine: row.mine } : {}), ...(row.home ? { home: true } : {}), ...(row.helps ? { helps: row.helps } : {}), ...(row.standup ? { standup: row.standup } : {}), ...(row.standupFor ? { standupFor: row.standupFor } : {}) }); }
    catch (error) {
      const busy = /At most four tasks|already running|holds this lock/.test(error.message);
      if (busy) updateRequest(repo.root, row.id, { state: 'queued', notBefore: new Date(Date.now() + 5000).toISOString(), reason: 'Waiting for a free slot in this project.' });
      // A teammate's message for a session in the home folder waits for the owner's y to
      // HOME_QUESTION, under Needs you. It never runs there unasked, and is never refused.
      else if (row.origin && isHomeRefusal(error.message)) updateRequest(repo.root, row.id, { state: 'waiting', reason: HOME_QUESTION });
      // A teammate cannot retry a blocked request here, so they are told it failed.
      else if (row.origin) { try { writeOutbox(repo.root, row, { outcome: 'failed', costUsd: 0, error: error.message }); } catch (failure) { this.error = failure.message; } updateRequest(repo.root, row.id, { state: 'done', finishedAt: new Date().toISOString(), reason: error.message }); }
      // Nobody is there to retry a turn a bot's schedule queued: it ends, and the next run comes at its time.
      // A standup's question is not retried either: its round says the session did not answer.
      else if (row.scheduled || row.standupFor) updateRequest(repo.root, row.id, { state: 'done', finishedAt: new Date().toISOString(), reason: error.message });
      else updateRequest(repo.root, row.id, { state: 'blocked', blockedAt: new Date().toISOString(), reason: error.message });
      return;
    }
    let runsBefore = 0; try { runsBefore = readTask(controller.repo, run.id).runs.length; } catch { /* Counted from the start. */ }
    const record = { root: repo.root, project: path.basename(repo.root), requestId: row.id, taskId: run.id, goal: row.goal, origin: row.origin ?? null, scheduled: row.scheduled === true, round: Boolean(row.standup), answers: Boolean(row.standupFor), summing: typeof run.summing === 'function' ? run.summing : null, runsBefore, attempts: row.attempts ?? 0, controller, startedAt: new Date().toISOString(), quietSince: Date.now(), mark: null };
    this.runs.set(key(repo.root, run.id), record);
    updateRequest(repo.root, row.id, { state: 'running', taskId: run.id, startedAt: record.startedAt, reason: 'Working.' });
    record.done = run.finished.then(task => this.finish(record, null, task), error => this.finish(record, error));
  }
  finish(record, error) {
    this.runs.delete(key(record.root, record.taskId));
    const finishedAt = new Date().toISOString();
    const done = () => {
      if (record.origin) { try { this.outbox(record, error, finishedAt); } catch (failure) { this.error = failure.message; } }
      return updateRequest(record.root, record.requestId, { state: 'done', taskId: record.taskId, finishedAt, reason: error ? error.message : 'Finished.' });
    };
    try {
      // A standup's round and its questions are never run again on their own: a retry would ask
      // every session again, unasked, and the round lists a question that got no answer.
      if (!error || record.stopped || record.round || record.answers) return void done();
      const retries = conductorSettings().retries, cause = error.details?.cause;
      if ((record.stalled || cause === 'rate-limit') && record.attempts < retries) {
        const wait = record.stalled ? 2000 : 60000 * 2 ** record.attempts;
        updateRequest(record.root, record.requestId, { state: 'queued', attempts: record.attempts + 1, continuationTaskId: record.taskId, taskId: null, notBefore: new Date(Date.now() + wait).toISOString(), reason: record.stalled ? 'It stopped making progress. Retrying.' : 'Rate limited. Retrying shortly.' });
        return;
      }
      // A failure after the message was recorded is shown in the task itself.
      let recorded = null; try { recorded = readTask(record.controller.repo, record.taskId); } catch { /* Never created. */ }
      if (recorded && (recorded.goal === record.goal || recorded.messages?.some(row => row.text === record.goal)) || record.origin || record.scheduled) return void done();
      updateRequest(record.root, record.requestId, { state: 'blocked', blockedAt: new Date().toISOString(), taskId: null, reason: error.message });
    } catch (failure) { this.error = failure.message; }
  }
  // The reply for a teammate is written before its request is marked done.
  outbox(record, error, finishedAt) {
    let task = null; try { task = readTask(record.controller.repo, record.taskId); } catch { /* Never created. */ }
    const reply = error ? null : task?.kind === 'conversation' ? task.result : task?.reply ?? task?.result;
    const runs = task?.runs.slice(record.runsBefore) ?? [];
    // No run: nothing was spent. A run with no cost reported: unknown (null), which the daemon
    // counts as all the request reserved.
    const costUsd = !runs.length ? 0 : runs.every(run => Number.isFinite(run.costUsd)) ? runs.reduce((total, run) => total + run.costUsd, 0) : null;
    let text = reply?.summary ? reply.outcome === 'needs_input' && reply.question ? `${reply.summary}\n\n${reply.question}` : reply.summary : null;
    // A teammate's message started the owner's own kind of session, and its Task now waits for
    // him. The work it plans runs only once he approves it, and its result is not sent back,
    // so the teammate is told both.
    if (text && record.origin?.own && task && waitingTask(sessionTasks(record.controller.repo, task.id))) text = `${text}\n\n${PLAN_WAITS}`;
    writeOutbox(record.root, { id: record.requestId, origin: record.origin }, { taskId: record.taskId, outcome: error ? record.stopped ? 'stopped' : 'failed' : reply?.outcome ?? 'failed', text, costUsd, error: error?.message ?? null, finishedAt });
  }
  // Runs left by a conductor that ended without stopping them are marked stopped.
  // Runs owned by a live terminal, this conductor or a replaced one still finishing are left alone.
  recover() {
    const kept = new Set([...this.runs.values(), ...(this.othersNow ?? []).flatMap(row => row.runs)].map(run => run.requestId).filter(Boolean));
    for (const repo of registeredProjects()) {
      let values = []; try { values = tasks(repo); } catch { continue; }
      for (const task of values.filter(task => ['running', 'preparing'].includes(task.state))) {
        if (task.owner?.identity && processIdentity(task.owner.pid) === task.owner.identity) continue;
        let release; try { release = lock(repo, `task-${task.id}`); } catch { continue; }
        try {
          const file = path.join(taskDir(repo, task.id), 'process.json'); noSymlinks(file);
          if (fs.existsSync(file)) recoverProcess(readJson(file));
          const current = readTask(repo, task.id);
          // A shadow bot's turn that was cut off leaves the session where the agent left it.
          // So does a standup's answer turn (lib/standup.mjs).
          const shadowed = current.shadowing?.state ?? current.standupTurn?.state ?? null; delete current.shadowing; delete current.standupTurn;
          Object.assign(current, shadowed ? { state: shadowed, activeRole: null, activeLog: null } : { state: 'stopped', activeRole: null, activeLog: null, error: { message: 'ELU stopped before this response finished. Retry to continue.' } });
          saveTask(repo, current);
        } finally { release(); }
      }
      let rows = []; try { rows = pendingRequests(repo.root); } catch { continue; }
      for (const row of rows.filter(row => ['starting', 'running'].includes(row.state) && !kept.has(row.id))) {
        if (row.origin && row.taskId) { try { writeOutbox(repo.root, row, { taskId: row.taskId, outcome: 'failed', error: 'The run was interrupted.' }); } catch (error) { this.error = error.message; } }
        updateRequest(repo.root, row.id, row.taskId ? { state: 'done', finishedAt: new Date().toISOString() } : { state: 'queued', reason: 'Waiting to start.' });
      }
    }
  }
  // A replaced conductor writes its own file beside the status of the one that takes new work,
  // and removes it as it exits.
  write(stopped = false) {
    const runs = [...this.runs.values()].map(({ root, project, taskId, requestId, startedAt, attempts, stalled, origin }) => ({ root, project, taskId, requestId, startedAt, attempts, stalled: Boolean(stalled), origin }));
    if (this.draining && stopped) return void fs.rmSync(drainFile(this.draining), { force: true });
    if (this.beside && stopped) return void fs.rmSync(besideStatusPath(), { force: true });
    const value = this.draining ? { id: this.draining, pid: process.pid, identity: processIdentity(process.pid), version: this.version, startedAt: this.startedAt, error: this.error, runs }
      : { pid: process.pid, version: this.version, startedAt: this.startedAt, stopped, error: this.error, queued: this.queued, runs, standup: 1 };
    const text = JSON.stringify(value);
    if (!stopped && text === this.written && Date.now() - this.writtenAt < 2000) return;
    mkdir(folder()); atomic(this.draining ? drainFile(this.draining) : this.beside ? besideStatusPath() : statusFile(), { ...value, heartbeatAt: new Date().toISOString() });
    this.written = text; this.writtenAt = Date.now();
  }
}
