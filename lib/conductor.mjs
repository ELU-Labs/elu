import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomic, HOME_QUESTION, homeOrAbove, homeRefusal, isHomeRefusal, mkdir, noSymlinks, readJson, refuse, exactKeys, isObject } from './util.mjs';
import { lock, nameProblem, readTask, saveTask, tasks, taskDir } from './state.mjs';
import { settleFinished } from './task-head.mjs';
import { namesProcess, processRecord, recoverProcess, sameProcess } from './process.mjs';
import { personalDirectory } from './usage.mjs';
import { ProjectController, registeredProjects } from './projects.mjs';
import { pendingRequests, saveRequest, updateRequest, removeRequest, joinRequests, joinNotes, holdRequests, releaseRequests, typedRequest, ownerTyped, startsAt, waitingBeside } from './workspace.mjs';
import { BESIDE_LOCK, DEFAULT_SETTINGS, besideLock, besideStatusPath, conductorFolder, conductorLock, conductorSettings, earlierWindows, installed, lockHolder, mainConductor, olderConductor, readsBeside, statusPath, stayingConductor, stays } from './conductor-files.mjs';
import { atLimit, isLimit } from './conductor-files.mjs';
import { isPeerRun, pullSweepsRunning } from './runner.mjs';
import { checkProposal, sessionTasks, tellResult, tellStopped, waitingTask } from './plan.mjs';
import { checkFolders, checkMode, checkPlace } from './modes.mjs';
import { peerFile } from './peer/paths.mjs';
import { peerSettings } from './peer/settings.mjs';
import { runSpends } from './agent-spend.mjs';
import { sanitize } from './peer/peerdata.mjs';
import { holdAwake, refreshAwake } from './awake.mjs';
import { pendingApprovals } from './approvals.mjs';
import { BOT_NAME, botOfKey, botOversees, botWorks, chatBots, getBot, needBot, requestBots } from './bots.mjs';
import { checkModel } from './models.mjs';
import { checkHelps } from './remote-helper.mjs';
import { QUESTION_MAX, checkStandupFor } from './standup.mjs';
import { sameWait, slotWait, teammateWait, turnWait, waitText } from './waiting.mjs';
import { WAITS_FOR, WAIT_REASON, wokenAt } from './claude-switch.mjs';
import { recheckSignIns, signInsMarked } from './claude-accounts.mjs';
import { ASIDE_ANSWERED, ASIDE_RUNNING } from './message-aside.mjs';
import { archiveAfterTurn } from './session-commands.mjs';
import { longWorkWaits, lookLongWork, stopLongWork } from './long-work.mjs';
import { expectKeepGoing } from './keep-going.mjs';
import { eluNote, leadAsked, leadBackText, sentByElu } from './elu-sent.mjs';
import { pullRepos, pullsAsked } from './pull-reviews.mjs';
// The session's lead asks a bot that only reviews (elu sessions ask NAME ...): a question, or
// that it review pull requests, by address or by name (lib/pull-reviews.mjs pullsAsked; repos:
// the repositories the session knows, for one named by its number alone).
function leadReviewerAsk(row) {
  if (row.byElu !== true || typeof row.bot !== 'string' || !row.continuationTaskId) return null;
  const asked = leadAsked(row.goal);
  if (asked?.bot !== row.bot) return null;
  try { const bot = needBot(row.bot); return !botWorks(bot) && !botOversees(bot) ? asked : null; } catch { return null; }
}
const leadPullAsk = (row, repos = []) => { const asked = leadReviewerAsk(row); return Boolean(asked && pullsAsked(asked.text, { repos })); };
// A note of ELU's own to a session's working agent (lib/elu-sent.mjs eluNote), and a note of the bot
// that oversees that is no answer to a question (asks): what notesTogether gives one turn.
const waitingNote = row => typedRequest(row) && row.typed !== true && row.asOwner === undefined && typeof row.computer !== 'string' && eluNote(row.goal);
const overseerNote = row => typeof row.overseer === 'string' && Boolean(row.continuationTaskId) && row.asks === undefined && !row.attempts;
import { LINES as AUTO_LINES, autoOn, autoSettings, isThink, ownerWords } from './auto-model.mjs';
import { readSettings as orchestratorSettings } from './orchestrator-settings.mjs';
import { LEVEL_FULL } from './orchestrator-seams.mjs';
import { asOwnerMark } from './peer/remote-methods.mjs';
import { isMyComputer } from './peer/my-computers.mjs';
import { modelEfforts } from './bot-models.mjs';

// The conductor is one background process per user. It owns every agent run, so work
// continues after a terminal closes. Terminals talk to it only through files in the
// personal directory: queued requests, stop commands, and the status it publishes.

// The version of the code this process runs. An update replaces the files on disk under it.
const packageVersion = () => { try { return readJson(fileURLToPath(new URL('../package.json', import.meta.url))).version; } catch { return null; } };
export const VERSION = packageVersion();
// How many standup answer runs go at once on this computer. They take no slot (dispatch).
const ANSWERS_AT_ONCE = 8;
const folder = conductorFolder;
const commandFolder = () => path.join(folder(), 'commands');
const statusFile = statusPath;
const lockFile = conductorLock;
// Beside a conductor that stays (one without handover, 0.1.17 and earlier, or one of 0.1.18 or
// 0.1.19 that an update did not replace: stays in lib/conductor-files.mjs), this version's
// conductor takes new work under its own lock, status and command folder.
const besideCommands = () => path.join(folder(), 'commands-beside');
export { olderConductor, stayingConductor, earlierWindows, DEFAULT_SETTINGS, conductorSettings };
const key = (root, id) => `${root}\0${id}`;
// A conductor an update replaced hands the lock to the new version at once and only finishes
// the runs it has. Until it exits it keeps its own status and command folder beside the new one's.
const DRAIN = /^draining-([0-9a-f-]{36})\.json$/;
const drainFile = id => path.join(folder(), `draining-${id}.json`);
const drainCommands = id => path.join(folder(), `commands-${id}`);

export function saveConductorSettings(update) {
  const next = { ...conductorSettings(), ...update };
  if (next.maxAgents !== null && !isLimit(next.maxAgents)) refuse('Choose a whole number of sessions from 1 up, or no limit.');
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
  return { running, pid: running ? value.pid : null, version: running ? value.version ?? null : null, runs: [...(running ? value.runs ?? [] : []), ...draining.flatMap(row => row.runs)], queued: running && Number.isInteger(value.queued) ? value.queued : 0, draining: draining.map(row => ({ version: typeof row.version === 'string' ? row.version : null, runs: row.runs.length })), settings: conductorSettings(), error: running ? value.error ?? null : null, standup: running && value.standup === 1, standupAside: running && value.standupAside === 1, copies: running && value.copies === 1, goals: running && value.goals === 1, auto: running && value.auto === 1, overseer: running && value.overseer === 1, full: running && value.full === 1 };
}
// The conductors an update replaced that still finish their runs. strict also compares each
// one's process identity, so a reused process number never counts as one. The conductor
// beside one that stays lists its runs the same way (beside: true), for that one to read: a
// conductor of 0.1.18 or 0.1.19 then leaves them alone and sends their stops on. Here it is
// read from its own status, so only strict returns it.
export function drainingConductors({ strict = false } = {}) {
  let names = [];
  try { const dir = folder(); noSymlinks(dir); names = fs.readdirSync(dir).filter(name => DRAIN.test(name)); } catch { return []; }
  const rows = [];
  for (const name of names) {
    let value = null; try { const file = path.join(folder(), name); noSymlinks(file); value = readJson(file); } catch { continue; }
    if (value?.id !== DRAIN.exec(name)[1] || !Number.isInteger(value.pid) || !Array.isArray(value.runs) || value.beside === true && !strict) continue;
    rows.push({ ...value, live: alive(value.pid) && (!strict || !namesProcess(value) || sameProcess(value) !== false) });
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
// Whether the conductor here answers a standup beside a session's turn (dispatch). One from
// before that still runs after an update answers once the session's turn ends.
export function conductorAnswersBeside(now = Date.now()) { const status = conductorStatus(now); return !status.running || status.standupAside; }
export const OLDER_CONDUCTOR = 'ELU still runs its sessions on the build from before your update, which cannot hold a standup. It moves to the new build once they end; try again then.';
// Whether the conductor here starts a copy of a session (lib/owner-check.mjs) with its Task. One
// of an older build would start it as a plain message of the owner's, so none is queued for it.
export function conductorTakesCopies(now = Date.now()) { const status = conductorStatus(now); return !status.running || status.copies; }
export const OLDER_COPY = 'ELU still runs its sessions on the build from before your update, which cannot start a copy. It moves to the new build once they end; try again then.';
// Whether the conductor here runs a session with Auto model (lib/auto-model.mjs): it picks the
// model of each step, and starts a new session with the setting on. One of an older build
// would run the session on one model and say nothing, so the setting is not turned on for it.
// taskId: the session it is turned on for, whose turn may still run on a conductor an update
// replaced (as conductorTakesGoals): one of an older build drops the setting when that turn
// saves its record. roots: the session's project folder as runs name it.
export function conductorTakesAuto(taskId = null, roots = [], now = Date.now()) {
  const status = conductorStatus(now);
  if (status.running && !status.auto) return false;
  if (taskId == null) return true;
  const its = run => String(run?.taskId ?? '') === String(taskId) && roots.includes(run?.root);
  return !drainingConductors().some(row => row.auto !== 1 && Date.parse(row.heartbeatAt) > now - 15000 && row.runs.some(its));
}
// Whether the turn a session works in takes a new goal of the owner's while it works
// (lib/owner-check.mjs keepOpen): it runs on a conductor of this build or later (goals). One of
// an older build, still finishing that turn after an update, would read the goal as a plain
// message and count what it marked for the goal before against the new objectives, so the
// goal is not given to it. roots: the session's project folder as runs name it.
export function conductorTakesGoals(taskId, roots, now = Date.now()) {
  const status = conductorStatus(now);
  if (status.running && !status.goals) return false;
  const its = run => String(run?.taskId ?? '') === String(taskId) && roots.includes(run?.root);
  return !drainingConductors().some(row => row.goals !== 1 && Date.parse(row.heartbeatAt) > now - 15000 && row.runs.some(its));
}
export const OLDER_GOAL = 'This session works on the build from before your update, which cannot take a new goal while it works. Give it once this turn ends.';
// Whether the conductor here keeps the mark of the bot that oversees the sessions (overseer) on
// what it starts. One of an older build would start the bot's note, or the session it starts, as
// a plain message of the owner's, so none is queued for it.
export function conductorTakesOverseer(now = Date.now()) { const status = conductorStatus(now); return !status.running || status.overseer; }
export const OLDER_OVERSEER = 'ELU still runs its sessions on the build from before your update, which would read this as your own message. Nothing was sent. It moves to the new build once they end; try again then.';
// Whether the conductor here keeps the owner's word the bot that oversees his sessions sends for
// him (asOwner), and all a Full start carries (title, the model's effort, bot models). One of an older build would drop the mark or start the session with less,
// so none is queued for it.
export function conductorTakesFull(now = Date.now()) { const status = conductorStatus(now); return !status.running || status.full; }
export const OLDER_FULL = 'ELU still runs its sessions on the build from before your update, which does not keep the owner\'s word or all a Full start carries. Nothing was sent. It moves to the new build once they end; try again then.';
// A signal-0 check costs no process start, so a conductor killed outright reads as off at once.
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
// The conductor that takes new work. One an update replaced may still finish runs beside it.
// One that stays (stays in lib/conductor-files.mjs) takes none from this version: the
// conductor beside it does, and starts when it does not run.
export function conductorAlive() {
  const main = mainConductor();
  return Boolean(main && !stays(main)) || Boolean(lockHolder(besideLock()));
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
// The owner's own elu conductor stop is kept in a file. After it the conductor stays stopped
// until work is queued, so what only starts work that was already there (startQueued,
// openingConductor) asks here first. The file goes when a conductor starts.
const ownerStopFile = () => path.join(folder(), 'owner-stop.json');
export function ownerStop() { mkdir(folder()); atomic(ownerStopFile(), { at: new Date().toISOString() }); }
const ownerStopped = () => { try { const file = ownerStopFile(); noSymlinks(file); return fs.existsSync(file); } catch { return true; } };
// A long job that runs or waits to be told, and a session the keep-going check waits on, are work too (lib/long-work.mjs).
const queuedWork = () => registeredProjects().some(repo => { try { return pendingRequests(repo.root).some(row => row.state === 'queued'); } catch { return false; } }) || longWorkWaits();
// Starts the conductor for work that is queued while none runs. Whatever queues work starts
// the conductor itself, so work waits like that only after its conductor was ended from
// outside: the computer was restarted, or it ran 0.1.19 on Linux, whose login item ended the
// conductor with each of its runs (lib/schedules.mjs). ELU asks as it opens (openingConductor),
// and the login item on its first run after an update (lib/bot-schedules.mjs). After the
// owner's own elu conductor stop nothing is started here: that holds until work is queued.
// True when it asked for the conductor.
export function startQueued({ start = startConductor } = {}) {
  if (conductorAlive() || ownerStopped() || !queuedWork()) return false;
  start(); return true;
}
// What the app does about the conductor as it opens, and the line it says, or null.
// Sessions an earlier version still finishes are named (conductorNote). Work that waits while
// no conductor takes it starts now: also what a conductor that was killed left queued beside
// the main file, which 0.1.17 and earlier never read, so after a downgrade to one of those it
// waited for a version that reads it. With an ELU window of an earlier version open, the
// line says how many waited. Beside a conductor that stays, or with such a window open, this
// version's conductor starts now, so what is queued, and what that window sends later,
// starts on this version. Work that only waits with no conductor running is not started after
// the owner's own elu conductor stop (ownerStop).
// A turn that was running when ELU ended without stopping it (a crash, kill -9, the computer
// losing power) shows as running, and what it started may run on, until a conductor starts and
// recovers it (Conductor.recover): with no conductor running, one starts now for it too.
export function openingConductor({ start = startConductor, version = installed.version() } = {}) {
  const lines = [], note = conductorNote(); if (note) lines.push(note);
  const staying = stayingConductor(version), windows = earlierWindows(version), beside = Boolean(lockHolder(besideLock()));
  let queued = longWorkWaits(), left = 0, stranded = false;
  for (const repo of registeredProjects()) {
    try { const rows = pendingRequests(repo.root); queued ||= rows.some(row => row.state === 'queued'); stranded ||= rows.some(row => ['starting', 'running'].includes(row.state)); if (!beside) left += waitingBeside(repo.root).length; } catch { /* Read again by the conductor. */ }
  }
  if (left && windows.length) lines.push(left === 1 ? '1 message from before the downgrade was waiting. It starts now.' : `${left} messages from before the downgrade were waiting. They start now.`);
  if (staying || windows.length || queued && !conductorAlive() && !ownerStopped() || stranded && !conductorRunning() && !ownerStopped()) start();
  return lines.join(' ') || null;
}
// A stop goes to the conductor that runs the task; a shutdown to every conductor.
export function sendCommand(command) {
  if (!['stop', 'shutdown'].includes(command?.type)) refuse('Unknown conductor command.');
  if (command.type === 'stop' && (typeof command.root !== 'string' || !/^[1-9][0-9]*$/.test(String(command.taskId)))) refuse('Choose a running task to stop.');
  const value = { ...command, taskId: command.taskId == null ? undefined : String(command.taskId), at: new Date().toISOString() };
  const draining = drainingConductors(), owner = value.type === 'stop' ? draining.find(row => owns(row, value)) : null;
  if (owner) return void writeCommand(drainCommands(owner.id), value);
  // Beside a conductor that stays, a stop goes to the one that runs the task.
  const main = mainConductor(), beside = lockHolder(besideLock());
  if (value.type === 'stop' && beside && stays(main) && !owns(main, value)) return void writeCommand(besideCommands(), value);
  writeCommand(commandFolder(), value);
  if (value.type === 'shutdown' && beside) writeCommand(besideCommands(), value);
  if (value.type === 'shutdown') for (const row of draining) { try { writeCommand(drainCommands(row.id), value); } catch { /* It ended meanwhile. */ } }
}
// Stops one standup answer run by its request, whichever conductor runs it; one that does not,
// or one of an earlier build, reads nothing in it. The session's own turn is never touched.
export function stopStandupAnswer(root, requestId) {
  if (typeof root !== 'string' || typeof requestId !== 'string' || !requestId) refuse('Choose a standup answer to stop.');
  const value = { type: 'stopStandup', root, requestId, at: new Date().toISOString() };
  writeCommand(commandFolder(), value);
  if (lockHolder(besideLock())) writeCommand(besideCommands(), value);
  for (const row of drainingConductors()) { try { writeCommand(drainCommands(row.id), value); } catch { /* It ended meanwhile. */ } }
}
// Something that runs: the conductor that takes new work, one without handover, or one that
// finishes the runs it has.
export function conductorRunning() { return Boolean(lockHolder(lockFile()) || lockHolder(besideLock())) || drainingConductors().length > 0; }
// A run beside a turn (a standup's answer, aside) is not the session's turn: a stop is never for it.
const owns = (row, command) => row.runs.some(run => !run.aside && run.root === command.root && String(run.taskId) === String(command.taskId));
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
  if (typeof value.machine !== 'string' || !/^[0-9a-f]{64}$/.test(value.machine)) refuse('A session from another computer needs its key.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 64 || sanitize(value.name, 64) !== value.name || /[\n\t"<>]/.test(value.name)) refuse('A session from another computer needs a plain name.');
  if (typeof value.remoteId !== 'string' || !ID.test(value.remoteId)) refuse('A session from another computer has an invalid id.');
  return { machine: value.machine, name: value.name, remoteId: value.remoteId };
}
// Why enqueue refuses a request of the bot that oversees the sessions (overseer, below).
const NOT_OVERSEER = 'Only the bot that oversees your sessions marks what it sends as its own.';
const OVERSEER_ONLY = 'A note of the bot that oversees your sessions goes to one of them as it is: nothing of yours goes with it.';
const OVERSEER_START = 'A session the bot that oversees your sessions starts has Ask for approval or Approve for me, a new worktree, no folders, no bots and a budget of a cent or more.';
const OVERSEER_ASKS = 'Only an answer of the bot that oversees your sessions names the question it answers, by its mark.';
const OWNER_WORD_ONLY = "The owner's word the bot that oversees his sessions sends for him goes to one of his sessions as it is: nothing else of his goes with it.";
const FULL_ONLY = 'A session starts with a name, an effort or bot models only when the bot that oversees your sessions at Full, or one of your own computers, starts it.';
const budgetOk = value => typeof value === 'number' && Number.isFinite(value) && value >= 0.01;
// Lower priority numbers start first: Chat messages use 0, queued goals 1. A waiting
// request starts only after the owner accepts it (retryRequest). permissions, place and
// folders are the owner's session choices; a teammate's question never has them.
// bots: the bots in the session's chat, the owner's own choice (botsPicked: an earlier build
// queued @reviewer by itself, requestBots). bot: the bot this message is written to, which
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
// typed: the owner typed this or pressed its key himself, just now, in the app here or on
// another computer of his (also the key or command that runs a schedule or a bot now). It starts whatever the number of sessions running (ownerTyped in
// lib/workspace.mjs). Whatever queues work by itself leaves it out, and that waits for a slot:
// a schedule that comes due, a bot, a helper, a session's own tool, a program, a teammate.
// A teammate's message he accepts with his own key is typed too (queueRun in lib/peer/intake.mjs).
// computer: the key of the computer on a shared project that asked for this here
// (lib/peer/remote.mjs): it is a member's request, whoever owns that computer, so it starts by
// itself and waits for a slot once /slots is full, and is typed only once the owner here says yes (r).
// title: the name a schedule's run takes (scheduleId): the one the owner gave its latest run.
// copied: the Task a new session of the owner's starts with, approved, from his check of
// another (lib/owner-check.mjs): the Task's fields and from { session, task }. An ELU before it
// reads the request as a plain new session with his message.
// goalChange: { task, revision }, his message gives that Task of its session this new goal
// (lib/owner-check.mjs keepOpen), at that revision: a turn at work takes it as a new goal to
// align with (lib/runner.mjs inboxFeed), and it is never answered beside a turn (answerBeside).
// An ELU before it reads the request as a plain message of his. It may name the working bot
// the session works with (lib/bots.mjs sessionWorker), which then takes it as a turn of its own.
// toModel: he wrote this message in his session to @model, so it is kept as his message to the
// model (lib/bots.mjs sessionTalker) and the session stays the model's. An ELU before it reads
// the request as a plain message of his, which goes to the model too.
// auto: his new session begins with Auto model (lib/auto-model.mjs): ELU picks the model of each
// step. Only a new session he started himself carries it; a copy carries its session's
// (lib/owner-check.mjs copySession). An ELU before it starts the session on one model.
// byElu: ELU wrote this text and sent it down a path his own words take (typed): a session's own
// elu sessions command, the continue after he raised the mode. So is his answer to a session's
// check that came from his other computer (lib/peer/remote.mjs): it was not typed here. It picks
// no step of Auto model.
// retried: his retry key sent the session's last message again (r). It picks no step of Auto
// model either: the turn goes on with the model the failed one ran on. An ELU before it reads
// the request as the message alone, as it always did.
// overseer: the name of the bot that oversees the owner's sessions, which queued this itself
// (lib/orchestrator-actions.mjs): a note or an answer to one of his sessions (continuationTaskId,
// to the bot that works there when it names one), or a new session of its own (permissions Ask
// for approval or Approve for me, a new worktree, no folders, no bots, and budgetUsd, its dollar
// limit). The mark is saved with the request, never after it, so no turn ever starts it unmarked:
// it approves no Task, teaches nothing, joins none of his waiting messages and shows under the
// bot's name (lib/projects.mjs ask). Nothing else of the owner's goes with it. An ELU before it
// would read it as a plain message of his, so none is queued for one (conductorTakesOverseer).
// asks: with overseer only, on an answer to one of his sessions, the mark of the question it
// answers (lib/orchestrator-actions.mjs questionMark): it goes in as the answer only while the
// session still asks that question.
// At Full (lib/orchestrator-seams.mjs) that bot starts a session as the owner would: any access,
// place, folders and bots, its model with an effort ({ vendor, model, effort }), title (his name
// for it), botModels ({ <bot>: { vendor, model, effort } }) and no budget of its own. A new
// session one of his own computers starts here (mine, from a computer paired with this one as his,
// or marked here) carries the same. Any other start carries none of them.
// asOwner: { bot, computer }, the owner's word that bot sent for him into one of his
// sessions (lib/peer/remote-methods.mjs asOwnerMark), on this computer or from one of his own
// (computer, as the mark names it). It is checked again as its turn starts (lib/projects.mjs ask).
export function enqueue(root, goal, { id, continuationTaskId = null, priority = 0, state = 'queued', origin, readOnly, context, scheduleId, title, permissions, place, folders, bots, bot, model, scheduled, botChat, approved, mine, home, picked, helps, standup, standupFor, typed, copied, goalChange, toModel, computer, auto, byElu, retried, overseer, budgetUsd, asks, parent, botModels, asOwner } = {}) {
  if (!['queued', 'waiting'].includes(state)) refuse('A new request is queued or waiting.');
  // parent: the session of the owner's that started this new one (elu sessions new, or a schedule
  // one made): it is a sub session, listed under that session and not on its own (lib/board.mjs).
  if (parent !== undefined && (typeof parent !== 'string' || !/^[1-9][0-9]{0,9}$/.test(parent) || continuationTaskId != null || origin != null || mine != null || helps != null)) refuse('A sub session names the session of yours that started it.');
  const own = mine == null ? null : mineOrigin(mine);
  if (own && (origin != null || continuationTaskId != null)) refuse('Only a new session comes from another computer.');
  const helping = helps == null ? null : checkHelps(helps);
  if (helping && (origin != null || continuationTaskId != null || own)) refuse('Only a new session of yours helps a session on another computer.');
  if (readOnly !== undefined && typeof readOnly !== 'boolean') refuse('readOnly must be true or false.');
  const peer = origin == null ? null : peerOrigin(origin);
  if (!peer && context != null) refuse('Peer data needs a request origin.');
  if (typed !== undefined && typed !== true || typed && standupFor !== undefined) refuse('Only what the owner typed himself is marked typed.');
  // A teammate's message never starts a session over all of the owner's files unless he
  // allowed it. A later message is decided by where its session works (ProjectController.ask).
  if (home !== undefined && (home !== true || !peer || continuationTaskId != null)) refuse('Only a teammate\'s new session is let run in your home folder.');
  if (peer && homeOrAbove(root) && !home && continuationTaskId == null) refuse(homeRefusal(null));
  if (scheduleId !== undefined && (typeof scheduleId !== 'string' || !/^schedule-[a-f0-9]{8}$/.test(scheduleId))) refuse('Invalid schedule ID.');
  // A Full start: the bot that oversees the owner's sessions at Full (overseer, below) or one of his
  // own computers (mine, from a computer he marked here) starts a session with all he picked:
  // its name (title), the effort of its model and its bots' models.
  const fullStart = continuationTaskId == null && (overseer !== undefined && orchestratorAtFull() || own != null && isMyComputer(own.machine));
  if (title !== undefined && !(fullStart && !scheduleId) && (!scheduleId || continuationTaskId != null || typeof title !== 'string' || !title.trim() || nameProblem(title))) refuse("A schedule's run is named with one line of up to 60 characters.");
  if (title !== undefined && fullStart && !scheduleId && (typeof title !== 'string' || !title.trim() || nameProblem(title))) refuse(nameProblem(typeof title === 'string' ? title : '') ?? 'A session name is one line of text.');
  if (botModels !== undefined && !fullStart) refuse(FULL_ONLY);
  const session = {};
  if (permissions !== undefined) session.permissions = checkMode(permissions);
  if (place !== undefined) session.place = checkPlace(place, { mode: session.permissions });
  if (folders !== undefined) { const dirs = checkFolders(folders, { mode: session.permissions }); if (dirs.length) session.folders = dirs; }
  // The effort rides inside the model ({ vendor, model, effort }), kept only on a Full start: on
  // any other it is left out, as before.
  if (model != null) session.model = fullStart ? fullModel(model) : checkModel(model);
  const kept = fullStart ? fullBotModels(botModels, bots) : null;
  if (scheduled !== undefined && scheduled !== true || botChat !== undefined && botChat !== true) refuse('scheduled and botChat are true or left out.');
  if (scheduled && (bot == null || continuationTaskId == null)) refuse("A bot's scheduled turn names the bot and its session.");
  if (botChat && (bot == null || continuationTaskId != null)) refuse("A bot's own chat starts with a message to that bot.");
  if (picked !== undefined && (picked !== true || peer || permissions === undefined)) refuse('Only a mode the owner picked for his own new session is marked picked.');
  if (approved !== undefined && approved !== true || approved && (continuationTaskId == null || origin != null || scheduled || scheduleId || readOnly)) refuse('Only the owner approves a Task, in its own session.');
  if (computer !== undefined && (typeof computer !== 'string' || !/^[0-9a-f]{64}$/.test(computer) || origin != null || typed)) refuse('Only a request from a computer on a shared project names that computer.');
  const question = isObject(standup) ? standup.question ?? null : null;
  if (standup !== undefined && (standup !== true && !(isObject(standup) && Object.keys(standup).every(name => name === 'question') && (question === null || typeof question === 'string' && question.trim() && question.length <= QUESTION_MAX)) || standup === true && continuationTaskId != null || origin != null || own || helping || bot != null || scheduled || scheduleId || readOnly || approved)) refuse('A standup is a round of a Standup session.');
  if (standupFor !== undefined && (continuationTaskId == null || origin != null || helping || bot != null || scheduled || scheduleId || readOnly || approved || Object.keys(session).length || bots !== undefined || standup)) refuse('A standup asks one of your sessions, and nothing else.');
  const asked = standupFor !== undefined ? checkStandupFor(standupFor) : null;
  if (goalChange !== undefined && (!isObject(goalChange) || continuationTaskId == null || typed !== true || origin != null || bot != null && !botWorks(getBot(bot)) || scheduled || readOnly || !/^t-[0-9a-f]{8}$/.test(goalChange.task ?? '') || !Number.isSafeInteger(goalChange.revision) || goalChange.revision < 1)) refuse('Only your own new goal for a session goes as one.');
  if (toModel !== undefined && (toModel !== true || continuationTaskId == null || bot != null || origin != null || scheduled || standup !== undefined || standupFor !== undefined)) refuse('Only your own message to @model in a session is marked so.');
  if (copied !== undefined && (!isObject(copied) || continuationTaskId != null || origin != null || own || helping || scheduleId || standup || bot != null || readOnly || !/^[1-9][0-9]{0,9}$/.test(copied.from?.session ?? '') || !/^t-[0-9a-f]{8}$/.test(copied.from?.task ?? ''))) refuse('Only a new session of yours starts with a copy of a Task.');
  // The copy's goal and objectives are the owner's own words, whole (lib/owner-check.mjs copySession).
  const copy = copied === undefined ? null : { ...checkProposal(copied, { owner: true }), from: { session: copied.from.session, task: copied.from.task } };
  if ((standup !== undefined || asked) && !conductorTakesStandup()) refuse(OLDER_CONDUCTOR);
  if (copy && !conductorTakesCopies()) refuse(OLDER_COPY);
  if (auto !== undefined && (auto !== true || typed !== true || continuationTaskId != null || origin != null || own || helping || scheduleId || scheduled || botChat || standup !== undefined || standupFor !== undefined || readOnly || computer !== undefined)) refuse('Only a new session of yours starts with Auto model.');
  if (auto && !conductorTakesAuto()) refuse(AUTO_LINES.older);
  if (byElu !== undefined && byElu !== true) refuse('byElu is true or left out.');
  if (retried !== undefined && (retried !== true || continuationTaskId == null)) refuse('Only a message sent again in its session is marked retried.');
  // The bot's own request carries its mark and nothing of the owner's: no key or Task of his, no
  // schedule, no teammate or other computer, and no session choice beyond what a session it
  // starts is given.
  const marked = overseer !== undefined;
  if (marked && (typeof overseer !== 'string' || !BOT_NAME.test(overseer) || !botOversees(getBot(overseer)))) refuse(NOT_OVERSEER);
  if (marked && (state !== 'queued' || origin != null || own || helping || readOnly !== undefined || context != null || scheduleId !== undefined || title !== undefined && !fullStart || scheduled !== undefined || botChat !== undefined || approved !== undefined || picked !== undefined || home !== undefined || typed !== undefined || standup !== undefined || standupFor !== undefined || goalChange !== undefined || toModel !== undefined || copied !== undefined || computer !== undefined || model != null && !fullStart || auto !== undefined || byElu !== undefined || retried !== undefined || asOwner !== undefined)) refuse(OVERSEER_ONLY);
  if (marked && continuationTaskId != null && (permissions !== undefined || place !== undefined || folders !== undefined || bots !== undefined || budgetUsd !== undefined || bot != null && !botWorks(getBot(bot)))) refuse(OVERSEER_ONLY);
  // At Full it starts a session as the owner would (any access, place, folders and bots, its own
  // budget or none); below Full, only as before.
  if (marked && continuationTaskId == null && fullStart && (bot != null || !Array.isArray(bots) || budgetUsd !== undefined && !budgetOk(budgetUsd))) refuse(OVERSEER_START);
  if (marked && continuationTaskId == null && !fullStart && (!['ask', 'auto'].includes(session.permissions) || session.place?.kind !== 'worktree' || session.folders || !Array.isArray(bots) || bots.length || bot != null || !budgetOk(budgetUsd))) refuse(OVERSEER_START);
  if (!marked && budgetUsd !== undefined) refuse(OVERSEER_START);
  // asOwner: the owner's word, sent for him by the bot that oversees his sessions at Full
  // (lib/peer/remote-methods.mjs asOwnerMark): on this computer (computer null in the
  // mark) or from one of his own computers (the mark names the computer it came from, as computer
  // does). Kept on the request as it is; whether it holds is read when its turn starts (lib/runner.mjs
  // ownerWord), and one that does not goes as that bot's note. Like his own message, it may be
  // written to one of the session's bots (bot) or to @model (toModel).
  const word = asOwner === undefined ? null : asOwnerMark(asOwner);
  if (asOwner !== undefined && (!word || marked || continuationTaskId == null || origin != null || own || helping || readOnly !== undefined || context != null || scheduleId !== undefined || title !== undefined || scheduled !== undefined || botChat !== undefined || picked !== undefined || home !== undefined || typed !== undefined || standup !== undefined || standupFor !== undefined || goalChange !== undefined || copied !== undefined || auto !== undefined || byElu !== undefined || retried !== undefined || permissions !== undefined || place !== undefined || folders !== undefined || bots !== undefined || model != null)) refuse(OWNER_WORD_ONLY);
  if (word && (word.computer ?? null) !== (computer ?? null)) refuse(OWNER_WORD_ONLY);
  if (word && word.computer === null && !botOversees(getBot(word.bot))) refuse(NOT_OVERSEER);
  if (asks !== undefined && (!marked && !word || continuationTaskId == null || typeof asks !== 'string' || !/^[0-9a-f]{16}$/.test(asks))) refuse(OVERSEER_ASKS);
  if (marked && !conductorTakesOverseer()) refuse(OLDER_OVERSEER);
  if ((word || fullStart && (title !== undefined && !scheduleId || kept || session.model?.effort)) && !conductorTakesFull()) refuse(OLDER_FULL);
  const chat = { ...(bots !== undefined ? { bots: chatBots(bots), botsPicked: true } : {}), ...(bot != null ? { bot: needBot(bot).name } : {}), ...(scheduled ? { scheduled: true } : {}), ...(botChat ? { botChat: true } : {}), ...(approved ? { approved: true } : {}), ...(toModel ? { toModel: true } : {}) };
  if (peer && Object.keys(chat).length) refuse("Bots join your own sessions, not a teammate's question.");
  let fields = { ...(standup ? { standup: standup === true ? true : { question } } : {}), ...(asked ? { standupFor: asked } : {}), ...(readOnly ? { readOnly: true } : {}), ...(scheduleId ? { scheduleId, ...(title !== undefined ? { title: title.replace(/\s+/g, ' ').trim() } : {}) } : {}), ...session, ...(picked ? { picked: true } : {}), ...chat, ...(own ? { mine: own } : {}), ...(helping ? { helps: helping } : {}), ...(typed ? { typed: true } : {}), ...(copy ? { copied: copy } : {}), ...(goalChange !== undefined ? { goalChange: { task: goalChange.task, revision: goalChange.revision } } : {}), ...(computer ? { computer } : {}), ...(auto ? { auto: true } : {}), ...(byElu ? { byElu: true } : {}), ...(parent !== undefined ? { parent } : {}), ...(retried ? { retried: true } : {}), ...(marked ? { overseer, ...(budgetUsd !== undefined ? { budgetUsd } : {}), ...(asks !== undefined ? { asks } : {}) } : {}),
    ...(fullStart && title !== undefined && !scheduleId ? { title: title.replace(/\s+/g, ' ').trim() } : {}), ...(kept ? { botModels: kept } : {}), ...(word ? { asOwner: word, ...(asks !== undefined ? { asks } : {}) } : {}) };
  if (peer) {
    // A teammate's text of any length: the model says when it is too long for it.
    if (typeof context !== 'string' || !context.trim()) refuse('Peer data needs text.');
    if (isPeerRun(peer) && readOnly !== true) refuse('Asks and reviews from a teammate must be read-only.');
    if (isPeerRun(peer) && Object.keys(session).length) refuse('Teammate questions stay read-only.');
    // A handoff edits the owner's project, so only the owner can start it: it waits until
    // the owner accepts it, or is queued when the owner already chose a mode.
    if (peer.kind === 'handoff') { readOnly = false; if (!session.permissions) state = 'waiting'; }
    fields = { origin: peer, readOnly: readOnly === true, context, ...session, ...(home ? { home: true } : {}), ...(typed ? { typed: true } : {}) };
  }
  const reason = state === 'waiting' ? peer ? `${peer.kind} from @${peer.name}` : 'Ready to review and start.' : 'Waiting to start.';
  return saveRequest(root, goal, id, { state, priority, continuationTaskId: continuationTaskId == null ? null : String(continuationTaskId), taskId: null, attempts: 0, notBefore: null, queuedAt: new Date().toISOString(), reason, waits: undefined, ...fields });
}
// Whether the bot that oversees the owner's sessions works at Full now (lib/orchestrator-settings.mjs).
function orchestratorAtFull() { try { return orchestratorSettings().level === LEVEL_FULL; } catch { return false; } }
// A model of a Full start, { vendor, model, effort }: the effort only when that model takes it here.
function fullModel(value) {
  const chosen = checkModel(value), effort = value?.effort == null || value.effort === '' ? null : value.effort;
  if (effort !== null && (typeof effort !== 'string' || !modelEfforts(chosen.vendor, chosen.model).includes(effort))) refuse(`${[chosen.vendor, chosen.model].filter(Boolean).join(' · ')} takes no effort ${String(effort).slice(0, 20)}.`);
  return { ...chosen, ...(effort !== null ? { effort } : {}) };
}
// The models a Full start gives some of its bots, { <bot>: { vendor, model, effort } }, each one of
// the session's bots; null when it gives none. The session checks each model as it starts (startPicks).
function fullBotModels(value, bots) {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || Object.keys(value).length > 12) refuse('Give each bot of the session one model.');
  const names = Array.isArray(bots) ? bots : [], out = {};
  for (const [name, choice] of Object.entries(value)) {
    if (!names.includes(name)) refuse(`@${String(name).slice(0, 32)} is not one of this session's bots.`);
    if (!isObject(choice) || typeof choice.vendor !== 'string' || choice.model != null && typeof choice.model !== 'string' || choice.effort != null && typeof choice.effort !== 'string') refuse(`Give @${name} a model as { vendor, model, effort }.`);
    out[name] = { vendor: choice.vendor, model: choice.model ?? null, ...(choice.effort ? { effort: choice.effort } : {}) };
  }
  return Object.keys(out).length ? out : null;
}
// Said under the plan a teammate's message led to, when its Task waits for the owner.
// The computer on a shared project whose words a request carries: the one that asked for it
// here (computer), else the one whose words went into a run that waited here (adds,
// addToRequest in lib/workspace.mjs). Its turn runs under the project's rules for that computer.
// Whether a new session begins with Auto model: the owner asked for it there (auto), or, when
// he named no model, new sessions he starts on this computer begin with it (lib/auto-model.mjs
// autoSettings). Only a session he started with his own words: one a schedule, a bot's chat, a
// standup, another computer, a helper, a copy, the bot that oversees his sessions or ELU itself
// starts never takes the computer's default.
function startsAuto(row) {
  if (row.continuationTaskId != null || row.overseer != null) return false;
  if (row.auto === true) return true;
  if (row.model || row.typed !== true || row.byElu === true || row.origin || row.scheduleId || row.scheduled || row.botChat || row.standup || row.standupFor || row.readOnly || typeof row.computer === 'string' || row.adds || row.mine || row.helps || row.copied) return false;
  try { return autoSettings().default === true; } catch { return false; }
}
// Whether think, sent after a quick answer of Auto model's, is in the chat: the question that
// answer answered is written again after it (lib/projects.mjs thinkAgain). Another quick
// answer earlier in the session says nothing of this one, and with Auto model off think is
// only a word, as before.
function thinkRecorded(task) {
  if (!autoOn(task)) return false;
  const rows = Array.isArray(task?.messages) ? task.messages : [], at = rows.findLastIndex(row => row.update && typeof row.quick === 'string');
  if (at < 0) return false;
  const question = rows.findLast(row => row.quick === rows[at].quick && !row.from && !row.line)?.text;
  return typeof question === 'string' && rows.slice(at + 1).some(row => !row.from && !row.line && row.text === question);
}
const sentFrom = row => [row?.computer, row?.adds].find(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) ?? null;
export const PLAN_WAITS = 'This is a plan. The owner of this machine reviews it as a Task, and nothing is changed until they approve it. Once they do and the work is done, its result comes to this thread.';
// The peer daemon reads these and answers the teammate. The request ID becomes a file name.
// costAtLeast is written only when true: a reply without it is exact, as an older build reads it.
function writeOutbox(root, row, { taskId = null, outcome, text = null, costUsd = null, costAtLeast = false, error = null, finishedAt = new Date().toISOString() }) {
  if (!/^request-[a-f0-9-]+$/.test(row.id)) refuse('Invalid request ID.');
  atomic(peerFile('outbox', `${row.id}.json`), { requestId: row.id, root, origin: row.origin, taskId, outcome, text, costUsd, ...(costAtLeast ? { costAtLeast: true } : {}), finishedAt, error });
}
// The result of the work the owner approved in a session a teammate's message started. The
// peer daemon sends it into that teammate's thread (lib/peer/replies.mjs).
function writeResult(root, requestId, { origin, taskId, outcome, text, finishedAt }) {
  if (!/^request-[a-f0-9-]+$/.test(requestId)) refuse('Invalid request ID.');
  atomic(peerFile('outbox', `result-${requestId}.json`), { requestId, root, peer: origin.peer, name: origin.name, threadId: origin.threadId, taskId, outcome, text, finishedAt });
}
// The owner checked a session a teammate's message started and moved it to Done (lib/owner-check.mjs):
// his check is what finished its Task, so what it did goes back to that teammate's thread now, once.
export function tellChecked(repo, root, taskId) {
  let task = null; try { task = readTask(repo, String(taskId)); } catch { return null; }
  const origin = task.origin;
  if (origin?.own !== true || typeof origin.peer !== 'string' || typeof origin.threadId !== 'string') return null;
  const finished = tellResult(repo, task.id); if (!finished) return null;
  const reply = task.kind === 'conversation' ? task.result : task.reply ?? task.result;
  writeResult(root, `request-${crypto.randomUUID()}`, { origin, taskId: String(task.id), outcome: reply?.outcome ?? 'completed', text: reply?.summary || `Done: ${finished.title}`, finishedAt: new Date().toISOString() });
  return finished;
}
// The owner's own key sends it again or lets it start, so it is typed (enqueue).
export function retryRequest(root, id) {
  return updateRequest(root, id, { state: 'queued', attempts: 0, notBefore: null, queuedAt: new Date().toISOString(), blockedAt: null, reason: 'Waiting to start.', waits: undefined, typed: true }, { from: ['blocked', 'waiting'] });
}

export class Conductor {
  // next starts the conductor of the version on disk; tests pass their own.
  // signInsEveryMs: how often an account marked to sign in again is read again (recheckSignIns).
  constructor({ tickMs = 500, idleMs = 10 * 60000, stallMs, onExit, version = VERSION, onDisk = packageVersion, next = startConductor, signInsEveryMs = 60000 } = {}) {
    Object.assign(this, { tickMs, idleMs, stallMs, onExit, version, onDisk, next, signInsEveryMs });
    this.runs = new Map(); this.controllers = new Map(); this.idleSince = Date.now(); this.queued = 0; this.error = null; this.draining = null; this.othersNow = [];
  }
  start() {
    this.release = this.take();
    this.startedAt = new Date().toISOString();
    // A conductor runs again, so the owner's stop of the last one is over (ownerStop).
    try { fs.rmSync(ownerStopFile(), { force: true }); } catch { /* Looked at again by the next one. */ }
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
    // Beside a conductor that stays, what runs is its or this one's: nothing is
    // recovered until it has exited (promote).
    if (!this.beside) { try { this.recover(); } catch (error) { this.error = error.message; } }
    this.timer = setInterval(() => this.tick(), this.tickMs); this.tick();
    return this;
  }
  // Takes the lock. One that a conductor that stays holds (stays in lib/conductor-files.mjs)
  // is left with it: this one takes new work beside it, under its own lock, while that one finishes
  // its runs and exits, and then takes the lock too (promote). In the moment between that exit
  // and promote(), the lock is free while the conductor beside still runs: an app of that
  // version still open can start the conductor on disk then, which leaves the lock to it, so
  // its recover() never takes what that one starts or runs for interrupted.
  take() {
    for (let attempt = 0; ; attempt++) {
      let release;
      try { release = lock({ state: personalDirectory() }, 'conductor'); }
      catch (error) {
        if (stayingConductor(this.version)) { const release = lock({ state: personalDirectory() }, BESIDE_LOCK); this.beside = true; this.aside = crypto.randomUUID(); return release; }
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
    // A run beside a turn ends by its own stop: nothing else would end it.
    for (const run of runs) { run.stopped = true; if (run.message) run.halt?.(); }
    await Promise.all(runs.map(run => run.controller.stop(run.taskId, 'ELU stopped its conductor. Retry to continue.').catch(() => {})));
    await Promise.all(runs.map(run => run.done));
    try { this.write(true); } catch { /* Status is best effort. */ }
    if (this.draining) { try { fs.rmSync(drainCommands(this.draining), { recursive: true, force: true }); } catch { /* Removed already. */ } }
    try { this.unlist(); } catch { /* Removed already. */ }
    // Another conductor may still have runs, so what keeps the computer awake is read again.
    try { holdAwake(false); } catch { /* It ends with the conductor all the same. */ }
    refreshAwake(this.draining || this.beside || drainingConductors().length ? {} : { busy: false });
    try { this.release?.(); } catch { /* The lock file is already gone. */ }
    // What waited beside the main file goes back to it, for a downgrade before the next start,
    // and what was kept from the conductor that stays is freed.
    if (this.beside) for (const repo of registeredProjects()) { try { releaseRequests(repo.root); } catch { /* Next start. */ } }
  }
  tick() {
    if (this.busy || this.closed) return; this.busy = true;
    try {
      this.commands(); if (this.closed) return;
      if (this.beside) this.promote();
      if (!this.draining && this.replaced() && !this.downgraded()) this.drain();
      this.watchRequests();
      this.watch();
      // Long jobs that ended are told, and a session whose goal is not met is started again
      // (lib/long-work.mjs). While either waits, this conductor stays.
      if (!this.draining && lookLongWork(this.longWork ??= {}, { enqueue, projects: registeredProjects })) this.idleSince = Date.now();
      if (this.draining) this.handOn(); else this.dispatch();
      if (this.beside) this.stepAside();
      this.error = null;
    }
    catch (error) { this.error = error.message; }
    finally { this.busy = false; }
    try { this.write(); } catch { /* Status is best effort. */ }
    // Keeps the computer awake while agents run: at once when work starts or ends, else every 30 s.
    const busy = this.runs.size > 0 || this.queued > 0 || pullSweepsRunning() > 0 || (!this.draining && this.othersNow.some(row => row.runs.length > 0));
    if (!this.closed && (busy !== this.awake || Date.now() - (this.awakeAt ?? 0) > 30000)) { this.awake = busy; this.awakeAt = Date.now(); try { holdAwake(busy); } catch { /* The shared one still holds. */ } refreshAwake({ busy }); }
    if (this.closed) return;
    // Replaced: it exits once the runs it had are over. Otherwise it exits after the idle time,
    // and never beside a conductor that stays: alone, that one would start what an ELU
    // window still open on its version sends. Nor while such a window is open (windowOpen).
    // After a downgrade to a version without handover it exits once it has nothing to do,
    // beside one or not. Never while bots review beside a session (pullSweepsRunning, lib/runner.mjs).
    const sweeping = pullSweepsRunning() > 0;
    if (this.draining ? !this.runs.size && !sweeping : !this.runs.size && !this.queued && !sweeping && (this.wasReplaced === true || !this.beside && Date.now() - this.idleSince > this.idleMs && !this.windowOpen())) this.onExit?.();
  }
  // Whether an ELU window of an earlier version is open, read at most every 5 s. With no
  // conductor running, the next thing that window sends starts the conductor of its own
  // version, from its own folder when it was run with npx, and that one runs it. While this
  // one holds the lock, it runs what that window sends.
  windowOpen() {
    if (Date.now() - (this.windowsAt ?? 0) >= 5000) { this.windowsAt = Date.now(); try { this.windows = earlierWindows(this.version).length > 0; } catch { this.windows = false; } }
    return this.windows;
  }
  // Beside a conductor that stays: once it runs nothing, and nothing waits that it could
  // start or is starting, it is told to leave, once. A shutdown stops what a conductor runs,
  // and it runs nothing, so nothing is stopped. This one then takes the lock (promote), and
  // no work is started on the earlier version again, what an ELU window still open on it
  // sends included. Not after a downgrade or an update of this one. Read at most every 2 s,
  // and asked again after half a minute if it is still there.
  stepAside() {
    if (this.wasReplaced || Date.now() - (this.asideAt ?? 0) < 2000) return;
    this.asideAt = Date.now();
    const main = stayingConductor(this.version);
    if (!main || main.runs.length || this.asked?.pid === main.pid && Date.now() - this.asked.at < 30000) return;
    const known = new Set([...this.runs.values(), ...this.others().filter(row => row.id).flatMap(row => row.runs)].map(run => run.requestId));
    for (const repo of registeredProjects()) {
      let rows; try { holdRequests(repo.root); rows = pendingRequests(repo.root); } catch { return; }
      if (rows.some(row => ['starting', 'running'].includes(row.state) && !known.has(row.id))) return;
    }
    if (this.asked) fs.rmSync(this.asked.file, { force: true });
    const file = path.join(commandFolder(), `${Date.now()}-${crypto.randomUUID()}.json`);
    mkdir(commandFolder()); atomic(file, { type: 'shutdown', at: new Date().toISOString() }); this.asked = { pid: main.pid, file, at: Date.now() };
  }
  // The conductor beside takes its runs off the list the one that stays reads.
  unlist() {
    if (!this.aside) return;
    fs.rmSync(drainFile(this.aside), { force: true }); fs.rmSync(drainCommands(this.aside), { recursive: true, force: true });
  }
  // After an update this conductor runs the old code. From then on it takes no new work: it
  // gives up the lock, so the new version's conductor starts beside it and takes the queue at
  // once, finishes the runs it has, and exits. Only the conductor that holds the lock claims
  // requests, so nothing runs twice. Read at most every 5 s.
  // The requests of its runs stay, until each ends, where a conductor without handover never
  // reads (shelter in lib/workspace.mjs): from here on the lock is free, and one of those,
  // started by an ELU window still open on its version, takes every request it finds
  // starting or running for interrupted.
  drain() {
    for (const run of this.runs.values()) { try { updateRequest(run.root, run.requestId, {}, { shelter: true }); } catch { /* It stays where it is. */ } }
    this.write(true);
    this.draining = crypto.randomUUID(); this.beside = false; this.aside = null; this.written = null; this.queued = 0;
    mkdir(drainCommands(this.draining)); this.write();
    const release = this.release; this.release = null;
    try { release?.(); } catch { /* The lock file is already gone. */ }
    this.handOn(true);
  }
  // While work waits and no conductor takes it, this one starts the new version's. Also while
  // an ELU window of a version earlier than the one on disk is open: with the lock free, the
  // next thing that window sends would start the conductor of its own version.
  handOn(now = false) {
    if (!now && Date.now() - (this.handedAt ?? 0) < 5000) return;
    this.handedAt = Date.now();
    if (conductorAlive()) return;
    if (queuedWork() || earlierWindows(this.onDisk() ?? undefined).length) this.next();
  }
  // Beside a conductor that stays: once it has exited, this one takes the lock, and with
  // it every request, and recovers what it left. A conductor of this version or a later one
  // that took the lock instead leaves this one only its runs to finish. Read every second, and
  // at once when the lock file is gone, so no conductor of that version starts in between.
  promote() {
    if (fs.existsSync(lockFile()) && Date.now() - (this.promotedAt ?? 0) < 1000) return;
    this.promotedAt = Date.now();
    const main = mainConductor();
    if (main && (!main.known || stays(main, this.version))) return;
    if (main) return void this.drain();
    let release; try { release = lock({ state: personalDirectory() }, 'conductor'); } catch { return; }
    const beside = this.release; this.release = release;
    // The shutdown it asked of the one that has gone is not for this one to read.
    if (this.asked) { fs.rmSync(this.asked.file, { force: true }); this.asked = null; }
    try { this.write(true); } catch { /* Status is best effort. */ }
    this.beside = false; this.wasBeside = true; this.written = null; this.othersAt = 0; this.awakeAt = 0;
    try { beside?.(); } catch { /* The lock file is already gone. */ }
    try { this.others(true); this.recover(); } catch (error) { this.error = error.message; }
  }
  // Beside a conductor that stays, which starts every queued request it can on its next
  // tick, what an ELU window still open on that version sends is moved, or kept from it, as
  // soon as the file changes (holdRequests), not on this one's next tick. Watched only while
  // beside; if the watch fails, each tick still does it.
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
  // Beside a conductor that stays, its runs are counted too (id null).
  others(now = false) {
    if (!now && Date.now() - (this.othersAt ?? 0) < 2000) return this.othersNow;
    this.othersAt = Date.now();
    const rows = drainingConductors({ strict: true }).filter(row => row.id !== this.draining && row.id !== this.aside), dead = rows.filter(row => !row.live);
    for (const row of dead) { fs.rmSync(drainFile(row.id), { force: true }); fs.rmSync(drainCommands(row.id), { recursive: true, force: true }); }
    this.othersNow = rows.filter(row => row.live);
    if (this.beside) { const staying = stayingConductor(this.version); if (staying) this.othersNow.push({ ...staying, id: null }); }
    if (dead.length && this.timer && !this.beside) { try { this.recover(); } catch (error) { this.error = error.message; } }
    return this.othersNow;
  }
  forward(command, others = this.others()) {
    const owner = others.find(row => owns(row, command));
    if (owner) { try { writeCommand(owner.id ? drainCommands(owner.id) : commandFolder(), command); } catch { /* It ended meanwhile. */ } }
  }
  // A downgrade to a version without handover (0.1.17 and earlier) is not handed over: a
  // conductor of that version beside this one would start the follow-ups of the turns this one
  // runs, and take them for interrupted. This one keeps all the work until it has nothing to
  // do, and exits; the next one starts on the version on disk (tick).
  downgraded() { return readsBeside(this.version) && !readsBeside(this.disk); }
  replaced() {
    if (Date.now() - (this.versionAt ?? 0) < 5000) return this.wasReplaced === true;
    this.versionAt = Date.now(); const disk = this.disk = this.onDisk();
    this.wasReplaced = Boolean(this.version && disk && disk !== this.version);
    return this.wasReplaced;
  }
  // One that took the lock after the conductor that stayed exited also reads what was sent
  // to it while it ran beside that one, by this version or under its listing (unlist).
  commands() {
    const listed = this.aside ? [drainCommands(this.aside)] : [];
    const dirs = this.draining ? [drainCommands(this.draining)] : this.beside ? [besideCommands(), ...listed] : this.wasBeside ? [commandFolder(), besideCommands(), ...listed] : [commandFolder()];
    const names = dirs.flatMap(dir => { try { return fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => [dir, name]); } catch { return []; } }).sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    for (const [dir, name] of names) {
      const file = path.join(dir, name); let command = null;
      try { noSymlinks(file); command = readJson(file); } catch { /* A malformed command is dropped. */ }
      fs.rmSync(file, { force: true });
      if (command?.type === 'shutdown') { if (this.onExit) this.onExit(); else this.stop(); return; }
      if (command?.type === 'stop') {
        const run = this.runs.get(key(command.root, String(command.taskId)));
        // The owner stops the turn: an answer being written beside it for a message of his stops too, and the message starts the next turn.
        for (const value of this.runs.values()) if (value.message && value.root === command.root && String(value.taskId) === String(command.taskId)) { value.stopped = true; value.halt?.(); }
        if (run) { run.stopped = true; run.ownerStop = true; run.controller.stop(run.taskId).catch(() => {}); }
        else if (!this.draining) this.forward(command);
        // His stop ends the session's long jobs too, as it ends a turn's commands.
        stopLongWork(command.root, command.taskId);
      }
      // A standup answer run is stopped by its request (stopStandupAnswer): the run beside a
      // turn by its own stop, which leaves that turn alone.
      if (command?.type === 'stopStandup') {
        const run = [...this.runs.values()].find(value => value.answers && value.root === command.root && value.requestId === command.requestId);
        if (run) { run.stopped = true; if (run.halt) run.halt(); else run.controller.stop(run.taskId).catch(() => {}); }
      }
    }
  }
  // A run whose agent log has not grown for the stall time is stopped and retried. A run
  // waiting for the owner's approval is quiet on purpose, so it is not stalled. A model's turn
  // has its own limit (lib/turn-limits.mjs): it stops when its vendor has printed nothing for
  // the quiet limit, while no command it runs is running, and says so in one line. A check is
  // a command, and has no limit at all. Silence says nothing about either: a slow test suite
  // prints nothing until it ends, however long that takes. So a step with an active role is
  // never stopped here; the stall time is for a log that no step owns.
  watch() {
    const now = Date.now(), stall = this.stallMs ?? conductorSettings().stallMinutes * 60000;
    for (const run of this.runs.values()) {
      // A run beside a turn (a standup's answer) has its own limits; the session's log is its turn's.
      if (run.stalled || run.stopped || run.aside) continue;
      let task; try { task = readTask(run.controller.repo, run.taskId); } catch { continue; }
      let size = null; try { if (task.activeLog) size = fs.statSync(task.activeLog).size; } catch { /* Not started yet. */ }
      const mark = `${task.activeLog}:${size}`;
      let waiting = false; try { waiting = pendingApprovals({ root: run.controller.repo.project ?? run.root, taskId: run.taskId }).length > 0; } catch { /* Unreadable: counted as quiet. */ }
      if (!task.activeLog || task.activeRole || mark !== run.mark || waiting) { run.mark = mark; run.quietSince = now; continue; }
      if (now - run.quietSince > stall) {
        run.stalled = true;
        run.controller.stop(run.taskId, `No progress for ${Math.round(stall / 60000) || 1} minutes. Retrying.`).catch(() => {});
      }
    }
  }
  // Only the conductor that holds the lock dispatches. The runs a replaced one still finishes
  // count against every limit, and a follow-up waits for its session's turn there too.
  // Beside a conductor that stays, which starts every queued request it can, the queued ones
  // are first moved where it does not read, or kept from it (holdRequests), and a session it
  // is starting or running, read from the requests themselves, is busy too. The conductor
  // they are kept for starts them by the time each had before (startsAt).
  // A request passed over is told what it waits for (lib/waiting.mjs), written only when
  // that changes: the chat and Sessions say it under the message.
  // What the owner typed himself never waits for a slot (ownerTyped in lib/workspace.mjs):
  // the number /slots sets holds back only what starts by itself, and the sessions his own
  // A Claude account marked to sign in again is read again at most every signInsEveryMs, only
  // read: one signed in again since (in a terminal, say) is back, and a session that waits for
  // a reset tries it at once (lib/claude-accounts.mjs). Claude Code renews a sign-in when it runs.
  signInsAgain(now) {
    if (this.signInsReading || now - (this.signInsReadAt ?? 0) < this.signInsEveryMs) return;
    let marked = false; try { marked = signInsMarked(); } catch { marked = false; }
    if (!marked) return;
    this.signInsReadAt = now;
    this.signInsReading = recheckSignIns({ renewing: false }).catch(() => false).finally(() => { this.signInsReading = null; });
  }
  // messages started count among those running, so more may run than start at once.
  dispatch() {
    const now = Date.now(), { maxAgents } = conductorSettings(), waiting = [], others = this.others().flatMap(row => row.runs), busy = new Set();
    const all = () => [...this.runs.values(), ...others], read = new Set();
    for (const repo of registeredProjects()) {
      if (this.beside) { try { holdRequests(repo.root); } catch { /* Next tick. */ } }
      let rows; try { rows = pendingRequests(repo.root); } catch { continue; }
      read.add(repo.root);
      // What a conductor that has gone kept from an earlier one is freed.
      if (!this.beside && rows.some(row => row.keptUntil !== undefined)) { try { if (holdRequests(repo.root)) rows = pendingRequests(repo.root); } catch { /* Next tick. */ } }
      for (const row of rows) {
        if (row.state === 'queued') waiting.push({ repo, row });
        if (this.beside && ['starting', 'running'].includes(row.state)) for (const id of [row.taskId, row.continuationTaskId]) if (id != null) busy.add(key(repo.root, String(id)));
        if (row.state === 'done' && !(Date.parse(row.finishedAt) > now - 120000)) { try { removeRequest(repo.root, row.id); } catch { /* Next tick. */ } }
      }
    }
    this.queued = waiting.length;
    this.signInsAgain(now);
    // An answer being written beside a turn for a message that no longer waits (taken back) stops.
    for (const run of this.runs.values()) if (run.message && !run.stopped && read.has(run.root) && !waiting.some(({ row }) => row.id === run.requestId)) { run.stopped = true; run.halt?.(); }
    if (this.runs.size || others.length || waiting.length) this.idleSince = now;
    const from = this.beside || this.wasBeside ? startsAt : row => row.notBefore;
    // A message that waits for a Claude account to reset starts at once when the owner picked or
    // added one since (lib/claude-switch.mjs wokenAt).
    let woken = 0; try { woken = waiting.some(({ row }) => row.waitsFor === WAITS_FOR) ? wokenAt() : 0; } catch { woken = 0; }
    const early = row => row.waitsFor === WAITS_FOR && woken > (Date.parse(row.waitingSince ?? '') || Infinity);
    const ready = waiting.filter(({ row }) => early(row) || !(Date.parse(from(row)) > now))
      .sort((a, b) => (a.row.priority ?? 1) - (b.row.priority ?? 1) || Date.parse(a.row.queuedAt ?? a.row.createdAt) - Date.parse(b.row.queuedAt ?? b.row.createdAt));
    // A teammate's question and a session a teammate's message started (origin.own) share the
    // peer slots, so the messages of Chats never fill every slot of this computer's. What
    // another computer on a shared project asked for here (computer; mine from ELU up to
    // 0.1.33) is work of that project, as the owner's own there is: it takes no peer slot, and
    // starts by itself, so the number /slots sets holds it back as it does a schedule's run.
    const teammates = origin => isPeerRun(origin) || origin?.own === true;
    const fromPeer = row => teammates(row.origin);
    const slots = peerSettings().peerSlots, peerSlots = Number.isInteger(slots) ? slots : 1, peerRuns = () => all().filter(run => teammates(run.origin)).length;
    // The sentence is the request's reason too, so a window of an earlier version says it.
    // While a follow-up's own session works its reason is the running turn's to write
    // (lib/runner.mjs): only a sentence left from an earlier wait is taken back there.
    const waits = (repo, row, value) => {
      if (sameWait(row.waits, value)) return;
      const reason = value.on !== 'turn' ? waitText(value) : row.waits ? 'Waiting to start.' : null;
      try { updateRequest(repo.root, row.id, { waits: value, ...(reason ? { reason } : {}) }, { from: ['queued'] }); } catch { /* Said at the next tick. */ }
    };
    // Once every slot is taken, only what the owner typed still starts in this tick.
    let full = false;
    for (const { repo, row } of ready) {
      // A standup round only waits for the answers it asked for, so it takes no slot of theirs
      // until its summary turn starts, which is a model's turn like any other. A standup's
      // answer run (standupFor) is short and read-only: it takes no slot and waits for none,
      // so a computer whose slots are all taken still answers at once. At most
      // ANSWERS_AT_ONCE of them go at a time.
      const counted = run => !run.answers && (!run.round || run.summing?.() === true), running = all().filter(counted).length;
      const answer = Boolean(row.standupFor);
      full ||= atLimit(running, maxAgents);
      if (answer && all().filter(run => run.answers).length >= ANSWERS_AT_ONCE) continue;
      // A follow-up waits until the current turn of the same chat ends; a run beside a turn
      // (aside) is no turn of the chat. A standup's question never waits for that turn: the
      // session answers beside it (launch, beside), and the turn goes on. A message of the
      // owner's to a turn that takes none is answered beside it too (answerBeside), which
      // takes no slot and waits for none. A new goal of his is not (goalChange): it is the
      // session's next message when that turn ends.
      // A message typed to a session that waits for a Claude account to reset waits with it: it
      // would only stop at the same limit. It goes after the waiting one, as a message typed
      // during a turn goes after that turn, so the chat shows each message once.
      // A note of the bot that oversees the sessions (overseer) waits with it too, as his would.
      const resets = (typedRequest(row) || typeof row.overseer === 'string' && Boolean(row.continuationTaskId)) && row.waitsFor !== WAITS_FOR ? waiting.find(({ repo: other, row: value }) => other.root === repo.root && value.id !== row.id && value.waitsFor === WAITS_FOR && String(value.continuationTaskId) === String(row.continuationTaskId)) : null;
      if (resets) { waits(repo, row, { on: 'time', until: resets.row.notBefore, why: WAIT_REASON }); continue; }
      const inTurn = Boolean(row.continuationTaskId) && (all().some(run => run.root === repo.root && !run.aside && String(run.taskId) === String(row.continuationTaskId)) || busy.has(key(repo.root, String(row.continuationTaskId))));
      // The lead's ask that a reviewing bot review pull requests holds no turn (lib/projects.mjs):
      // it starts beside the turn at once, as a standup's answer does, and waits for no slot.
      if (inTurn && !answer && leadPullAsk(row, () => { try { return pullRepos(this.controller(repo).sessionRepo(String(row.continuationTaskId)), String(row.continuationTaskId)); } catch { return []; } })) { this.launch(repo, row, { beside: true }); continue; }
      if (inTurn && !answer) { waits(repo, row, turnWait()); this.answerBeside(repo, row); continue; }
      // A teammate's message he accepted with his own key waits for neither (ownerTyped).
      const peers = fromPeer(row) && !ownerTyped(row) && peerRuns() >= peerSlots;
      if (peers || !answer && full && !ownerTyped(row)) { waits(repo, row, peers ? teammateWait(peerRuns(), peerSlots) : slotWait(running, maxAgents)); continue; }
      // The turn is over while its answer beside it is still being written: that stops, and the message starts the next turn now.
      const beside = !answer && this.runs.get(key(repo.root, `${row.continuationTaskId}\0${row.id}`));
      if (beside) { beside.stopped = true; beside.halt?.(); }
      const next = this.together(repo, row, ready);
      if (next) this.launch(repo, next, { beside: inTurn });
    }
  }
  // A message the owner typed to a session whose turn takes none while it works (activeDeaf,
  // lib/runner.mjs) is answered at once beside that turn (lib/message-aside.mjs): a short
  // read-only run on the session's own model, which takes no slot and waits for none, as a
  // standup's answer. It still waits for the turn when it asks for work. One answer for each
  // message, and only for the one the turn's own speaker would read.
  // A note of the bot that oversees the sessions is not his (typedRequest): it waits for the turn.
  // The lead's question to a bot that only reviews (elu sessions ask NAME, no pull request in it)
  // is answered beside any turn of the session the same way, by that bot, and the answer goes to
  // the lead as a note of ELU's (leadBackText). Up to 0.1.51 it waited for the turn, then held the
  // session for a turn of its own. While the session's bots review its change (activeReview,
  // lib/runner.mjs executeTask), a message for the lead or another bot is answered beside the
  // reviewing bot's turn too: up to 0.1.51 it waited for every round of the review loop.
  answerBeside(repo, row) {
    const lead = Boolean(leadReviewerAsk(row));
    if (row.aside || row.back || row.turn || row.now || row.goalChange) return;
    if (!lead && (!typedRequest(row) || row.overseer !== undefined || sentByElu(row.goal))) return;
    const name = key(repo.root, `${row.continuationTaskId}\0${row.id}`);
    if (this.runs.has(name) || [...this.runs.values()].filter(run => run.answers).length >= ANSWERS_AT_ONCE) return;
    // A turn that is being stopped is not answered beside: the message starts the next one.
    if (this.runs.get(key(repo.root, String(row.continuationTaskId)))?.stopped) return;
    let controller, task; try { controller = this.controller(repo); task = readTask(controller.repo, row.continuationTaskId); } catch { return; }
    if (task.state !== 'running' || !lead && (task.activeDeaf !== true || (row.bot ?? null) !== (botOfKey(task.activeRole ?? '') ?? null) && task.activeReview !== true)) return;
    const startedAt = new Date().toISOString();
    if (!updateRequest(repo.root, row.id, { aside: { state: 'running', startedAt }, reason: ASIDE_RUNNING }, { from: ['queued'] })) return;
    let run; try { run = controller.answerBeside(row); } catch (error) { updateRequest(repo.root, row.id, { aside: { state: 'failed', at: startedAt, error: error.message }, reason: 'It starts when the running turn ends.' }, { from: ['queued'] }); return; }
    const record = { key: name, root: repo.root, project: path.basename(repo.root), requestId: row.id, taskId: run.id, goal: row.goal, bot: row.bot ?? null, ...(row.toModel === true ? { toModel: true } : {}), ...(typeof row.computer === 'string' && /^[0-9a-f]{64}$/.test(row.computer) ? { computer: row.computer } : {}), askedAt: row.queuedAt ?? row.createdAt ?? startedAt, origin: null, answers: true, aside: true, message: true, ...(lead ? { lead: true } : {}), halt: run.stop, runsBefore: 0, attempts: 0, controller, startedAt, quietSince: Date.now(), mark: null };
    this.runs.set(name, record);
    record.done = run.finished.then(out => this.answered(record, out), error => this.answered(record, { failed: error.message }));
  }
  // The answer beside the turn is in. A message that only asked for information is done: the
  // chat keeps it with its answer, and the session's next turn reads both. One that asks for
  // work keeps its place for the next turn, with the answer under it, and so does one that
  // could not be answered. One taken back or sent now meanwhile shows nothing of it.
  answered(record, out) {
    this.runs.delete(record.key);
    const at = new Date().toISOString(), root = record.root, id = record.requestId, queued = { from: ['queued'] };
    const kept = { request: id, message: record.goal, bot: record.bot, ...(record.toModel ? { toModel: true } : {}), ...(record.computer ? { computer: record.computer } : {}), askedAt: record.askedAt, at, runs: out?.runs ?? [] };
    try {
      if (record.stopped || out?.stopped) { updateRequest(root, id, { aside: undefined, reason: 'Waiting to start.' }, queued); record.controller.keepAside(record.taskId, { ...kept, text: '', kind: 'stopped', shown: false }); return; }
      if (out?.failed) { updateRequest(root, id, { aside: { state: 'failed', at, error: out.failed }, reason: 'It starts when the running turn ends.' }, queued); record.controller.keepAside(record.taskId, { ...kept, text: '', kind: 'failed', shown: false }); return; }
      const aside = { state: 'answered', at, kind: out.kind, text: out.text, who: out.who };
      // The lead's question is done with the bot's answer, which goes to the lead's next turn.
      if (record.lead) {
        const done = updateRequest(root, id, { state: 'done', taskId: record.taskId, finishedAt: at, reason: ASIDE_ANSWERED, aside: { ...aside, kind: 'question' } }, queued);
        if (done) enqueue(root, leadBackText(record.bot, out.text), { continuationTaskId: String(record.taskId), priority: 0, byElu: true });
        record.controller.keepAside(record.taskId, { ...kept, text: out.text, who: out.who, kind: 'question', shown: Boolean(done) });
        return;
      }
      const done = out.kind === 'question'
        ? updateRequest(root, id, { state: 'done', taskId: record.taskId, finishedAt: at, reason: ASIDE_ANSWERED, aside }, queued)
        : updateRequest(root, id, { aside, reason: 'It starts when the running turn ends.' }, queued);
      record.controller.keepAside(record.taskId, { ...kept, text: out.text, who: out.who, kind: out.kind, shown: Boolean(done) });
    } catch (failure) { this.error = failure.message; }
  }
  // What the owner sent to a session while it worked goes as one turn: the waiting messages
  // that follow this one, to the same recipient and in the order sent, are joined to it. A
  // message to someone else ends the join, so nothing overtakes it. A bot's scheduled turn,
  // a teammate's message, a retry and a message that changes the session's choices each
  // stay a turn of their own. Returns the request to start, or null when it was taken back.
  // A message that waited for a Claude account to reset goes on alone: it is in the chat already.
  // So does one that starts again on the session's other model after one model's limit (modelLimit).
  // What ELU sent is joined with none of his: one text has one speaker. Its notes have a turn together (notesTogether).
  together(repo, row, ready) {
    const alone = value => value.waitsFor === WAITS_FOR || isObject(value.modelLimit);
    if (!alone(row) && (waitingNote(row) || overseerNote(row))) return this.notesTogether(repo, row, ready, alone);
    const typed = value => typedRequest(value) && !alone(value);
    if (!typed(row)) return row;
    const after = ready.filter(value => value.repo.root === repo.root && value.row.continuationTaskId === row.continuationTaskId).map(value => value.row);
    const ids = [row.id];
    // In a session with Auto model, words he typed here pick a step and the rest do not (ownerWords:
    // r sent it again, his other computer or ELU wrote it): the joined turn keeps the first one's
    // marks, so the two are not joined. With it off they join, as before.
    let auto = false; try { auto = autoOn(readTask(repo, String(row.continuationTaskId))); } catch { auto = false; }
    // One another computer on the project sent (computer) joins only that computer's own: its turn
    // runs under the project's rules for it (lib/runner.mjs teammateRulesPart), and the owner's never does.
    // A note of the bot that oversees the sessions (overseer) is never joined with his: that would make it his.
    for (const next of after.slice(after.indexOf(row) + 1)) { if (!typed(next) || sentByElu(next.goal) !== sentByElu(row.goal) || (next.bot ?? null) !== (row.bot ?? null) || (next.priority ?? 1) !== (row.priority ?? 1) || (next.computer ?? null) !== (row.computer ?? null) || auto && ownerWords(next) !== ownerWords(row) || (next.overseer ?? null) !== (row.overseer ?? null)) break; ids.push(next.id); }
    return ids.length > 1 ? joinRequests(repo.root, ids) : row;
  }
  // ELU's notes that wait for one agent of a session start one turn, oldest first, and so do the
  // notes of the bot that oversees that wait there (up to 0.1.50 each had a turn of its own). The
  // lead's asks of its bots and notes for the session's other agent keep their places and end no
  // join. Anything else does, the owner's message first of all: none of them overtakes his, and
  // his is in neither's text. With one of ELU's, that turn is ELU's and the bot's notes are that
  // bot's beside it (ask, notes). Without, they are that bot's one note, joined as his messages
  // are, except in Full access, where he is asked about each. Nor does one join ELU's while the
  // session asks him a question: ELU's goes on with the work, and only an answer may answer it.
  notesTogether(repo, row, ready, alone) {
    const after = ready.filter(value => value.repo.root === repo.root && String(value.row.continuationTaskId) === String(row.continuationTaskId)).map(value => value.row), found = [];
    for (const next of after.slice(after.indexOf(row))) {
      if (alone(next)) break;
      if (waitingNote(next) || overseerNote(next)) { if ((next.bot ?? null) === (row.bot ?? null)) found.push(next); }
      else if (!(next.byElu === true && next.bot && leadAsked(next.goal)?.bot === next.bot)) break;
    }
    if (found.length < 2) return row;
    const own = found.filter(waitingNote);
    let task = null; try { task = readTask(this.controller(repo).repo, String(row.continuationTaskId)); } catch { return row; }
    if (!own.length) {
      if (task.permissions === 'full') return row;
      return joinRequests(repo.root, found.filter(value => value.overseer === row.overseer).map(value => value.id));
    }
    if (task.state === 'needs_input') {
      if (!waitingNote(row)) return row;
      return joinNotes(repo.root, row.id, own.map(value => value.id));
    }
    return joinNotes(repo.root, own[0].id, found.map(value => value.id));
  }
  controller(repo) {
    let controller = this.controllers.get(repo.root);
    if (!controller) { controller = new ProjectController(repo); this.controllers.set(repo.root, controller); }
    else controller.reloadConfig();
    return controller;
  }
  launch(repo, row, { beside = false } = {}) {
    // Beside a conductor that stays, the request is listed before it is claimed: another of
    // that version, started in this moment, then leaves it alone (list).
    if (this.beside && this.aside) { try { this.list([{ root: repo.root, project: path.basename(repo.root), taskId: null, requestId: row.id }]); } catch { /* Listed with the next status. */ } }
    if (!updateRequest(repo.root, row.id, { state: 'starting', reason: 'Starting.', waits: undefined, waitsFor: undefined, waitingSince: undefined, modelLimit: undefined }, { from: ['queued'], shelter: this.beside === true })) return;
    // limited: the message starts again after one model's own weekly limit stopped its turn, in a
    // session with Auto model (finish, below): it goes on with the session's other model.
    const limited = isObject(row.modelLimit) ? row.modelLimit : null;
    let controller, run;
    try { controller = this.controller(repo); run = controller.ask(row.goal, row.continuationTaskId ?? null, { readOnly: row.readOnly === true, origin: row.origin ?? null, context: row.context ?? null, permissions: row.permissions, place: row.place, folders: row.folders, bots: requestBots(row), bot: row.bot ?? null, scheduled: row.scheduled === true, botChat: row.botChat === true, timed: Boolean(row.scheduleId), ...(row.scheduleId ? { schedule: row.scheduleId, title: row.title ?? null } : {}), ...(typeof row.parent === 'string' && row.continuationTaskId == null ? { parent: row.parent } : {}), approved: row.approved === true, again: (row.attempts ?? 0) > 0 || row.waitsFor === WAITS_FOR || Boolean(limited), ownerWords: ownerWords(row), ...(startsAuto(row) ? { auto: true } : {}), ...(limited ? { limited } : {}), ...(row.model ? { model: row.model } : {}), ...(row.mine ? { mine: row.mine } : {}), ...(row.home ? { home: true } : {}), ...(row.helps ? { helps: row.helps } : {}), ...(row.standup ? { standup: row.standup } : {}), ...(row.standupFor ? { standupFor: row.standupFor, ...(beside ? { beside: true } : {}) } : {}), ...(isObject(row.copied) ? { copied: row.copied } : {}), ...(row.toModel === true ? { toModel: true } : {}), ...(sentFrom(row) ? { computer: sentFrom(row) } : {}), ...(typeof row.overseer === 'string' ? { overseer: row.overseer, ...(row.budgetUsd !== undefined ? { budgetUsd: row.budgetUsd } : {}), ...(row.asks !== undefined ? { asks: row.asks } : {}) } : {}), ...(Array.isArray(row.notes) ? { notes: row.notes } : {}), ...(isObject(row.asOwner) ? { asOwner: row.asOwner, ...(row.asks !== undefined ? { asks: row.asks } : {}) } : {}), ...(!row.scheduleId && row.continuationTaskId == null && typeof row.title === 'string' ? { title: row.title } : {}), ...(isObject(row.botModels) && row.continuationTaskId == null ? { botModels: row.botModels } : {}) }); }
    catch (error) {
      const busy = /already running|holds this lock/.test(error.message);
      if (busy) updateRequest(repo.root, row.id, { state: 'queued', notBefore: new Date(Date.now() + 5000).toISOString(), reason: 'This session is busy.', ...(limited ? { modelLimit: limited } : {}) });
      // A teammate's message for a session in the home folder waits for the owner's y to
      // HOME_QUESTION, under Needs you. It never runs there unasked, and is never refused.
      else if (row.origin && isHomeRefusal(error.message)) updateRequest(repo.root, row.id, { state: 'waiting', reason: HOME_QUESTION });
      // A teammate cannot retry a blocked request here, so they are told it failed.
      else if (row.origin) { try { writeOutbox(repo.root, row, { outcome: 'failed', costUsd: 0, error: error.message }); } catch (failure) { this.error = failure.message; } updateRequest(repo.root, row.id, { state: 'done', finishedAt: new Date().toISOString(), reason: error.message }); }
      // Nobody is there to retry a turn a bot's schedule queued: it ends, and the next run comes at its time.
      // A standup's question is not retried either: its round says the session did not answer.
      // Nor a note of the bot that oversees the sessions: it is not his to retry, and the bot writes again if it must.
      // Nor the owner's word that bot sent for him: it is the bot's to send again, not his.
      else if (row.scheduled || row.standupFor || typeof row.overseer === 'string' || isObject(row.asOwner)) updateRequest(repo.root, row.id, { state: 'done', finishedAt: new Date().toISOString(), reason: error.message });
      else updateRequest(repo.root, row.id, { state: 'blocked', blockedAt: new Date().toISOString(), reason: error.message });
      return;
    }
    let runsBefore = 0; try { runsBefore = readTask(controller.repo, run.id).runs.length; } catch { /* Counted from the start. */ }
    // aside: a standup's answer beside the session's turn. It is a run of its own, kept under
    // its request, so the turn's record stays where it is; halt stops it and nothing else.
    const aside = run.aside === true;
    const record = { key: aside ? key(repo.root, `${run.id}\0${row.id}`) : key(repo.root, run.id), root: repo.root, project: path.basename(repo.root), requestId: row.id, taskId: run.id, goal: row.goal, origin: row.origin ?? null, approved: row.approved === true, worked: typeof run.worked === 'function' ? run.worked : null, scheduled: row.scheduled === true, overseer: typeof row.overseer === 'string' ? row.overseer : null, round: Boolean(row.standup), answers: Boolean(row.standupFor), aside, halt: aside && typeof run.stop === 'function' ? run.stop : null, summing: typeof run.summing === 'function' ? run.summing : null, runsBefore, attempts: row.attempts ?? 0, limited: Boolean(limited), controller, startedAt: new Date().toISOString(), quietSince: Date.now(), mark: null };
    this.runs.set(record.key, record);
    updateRequest(repo.root, row.id, { state: 'running', taskId: run.id, startedAt: record.startedAt, reason: 'Working.' });
    record.done = run.finished.then(task => this.finish(record, null, task), error => this.finish(record, error));
  }
  finish(record, error) {
    this.runs.delete(record.key ?? key(record.root, record.taskId));
    // His stop ended the session's long jobs as it came (commands): one its turn started while
    // the stop was ending it goes too, so a job is no way past his Stop.
    if (record.ownerStop) stopLongWork(record.root, record.taskId);
    const finishedAt = new Date().toISOString();
    const done = () => {
      if (record.origin) { try { this.outbox(record, error, finishedAt); } catch (failure) { this.error = failure.message; } }
      else { try { this.result(record, error, finishedAt); } catch (failure) { this.error = failure.message; } }
      // elu sessions archive this (lib/session-commands.mjs): the session leaves the list now its
      // turn has ended, its reply kept. A run beside the turn leaves it to the turn.
      if (!record.aside && !record.answers) { try { archiveAfterTurn(record.controller.repo, record.root, record.taskId); } catch (failure) { this.error = failure.message; } }
      const row = updateRequest(record.root, record.requestId, { state: 'done', taskId: record.taskId, finishedAt, reason: error ? error.message : 'Finished.' });
      // An update replaced this conductor, and it exits with its last turn: a session whose Task
      // is still not met is counted for the keep-going check, and the new version's conductor starts for it.
      if (this.draining && !record.aside && !record.answers) { try { if (expectKeepGoing(record.controller.repo, record.taskId)) this.handOn(true); } catch { /* The next conductor that starts looks. */ } }
      return row;
    };
    try {
      // A standup's round and its questions are never run again on their own: a retry would ask
      // every session again, unasked, and the round lists a question that got no answer.
      if (!error || record.stopped || record.round || record.answers) return void done();
      const retries = conductorSettings().retries, cause = error.details?.cause;
      // Every Claude account is at its limit (lib/runner.mjs): the message starts again when the
      // first one resets, its stopped turn going on, and sooner when the owner picks or adds an
      // account in Usage (wokenAt, dispatch above). It is no retry: it is not counted against them.
      // An ELU before this one reads only notBefore, and starts it then.
      const resetsAt = Number(error.details?.resetsAt);
      // A session with Auto model met one model's own weekly limit while its other model has room
      // (lib/runner.mjs, modelLimit): the message starts again at once and goes on with that one,
      // waiting for no reset. It is no retry, and it happens once a message: a stop of that turn
      // waits or ends as any other does.
      const limit = error.details?.modelLimit;
      if (isObject(limit) && typeof limit.model === 'string' && !record.limited && !record.origin && !record.scheduled && !record.overseer) {
        updateRequest(record.root, record.requestId, { state: 'queued', continuationTaskId: record.taskId, taskId: null, notBefore: null, modelLimit: { model: limit.model, until: Number.isFinite(limit.until) ? limit.until : null, ...(['plan', 'edit'].includes(limit.step) ? { step: limit.step } : {}) }, reason: 'Starting again on the other model.' });
        return;
      }
      if (cause === 'quota' && error.details?.waitsFor === WAITS_FOR && Number.isFinite(resetsAt) && !record.origin && !record.scheduled) {
        const now = Date.now();
        updateRequest(record.root, record.requestId, { state: 'queued', continuationTaskId: record.taskId, taskId: null, notBefore: new Date(Math.max(resetsAt, now) + 30000).toISOString(), waitingSince: new Date(now).toISOString(), waitsFor: WAITS_FOR, reason: WAIT_REASON });
        return;
      }
      if ((record.stalled || cause === 'rate-limit') && record.attempts < retries) {
        const wait = record.stalled ? 2000 : 60000 * 2 ** record.attempts;
        updateRequest(record.root, record.requestId, { state: 'queued', attempts: record.attempts + 1, continuationTaskId: record.taskId, taskId: null, notBefore: new Date(Date.now() + wait).toISOString(), reason: record.stalled ? 'It stopped making progress. Retrying.' : 'Rate limited. Retrying shortly.' });
        return;
      }
      // A failure after the message was recorded is shown in the task itself.
      let recorded = null; try { recorded = readTask(record.controller.repo, record.taskId); } catch { /* Never created. */ }
      // think after a quick answer of Auto model's is recorded as the question it asks again (lib/projects.mjs).
      if (recorded && (recorded.goal === record.goal || recorded.messages?.some(row => row.text === record.goal) || isThink(record.goal) && thinkRecorded(recorded)) || record.origin || record.scheduled || record.overseer) return void done();
      updateRequest(record.root, record.requestId, { state: 'blocked', blockedAt: new Date().toISOString(), taskId: null, reason: error.message });
    } catch (failure) { this.error = failure.message; }
  }
  // The reply for a teammate is written before its request is marked done.
  outbox(record, error, finishedAt) {
    let task = null; try { task = readTask(record.controller.repo, record.taskId); } catch { /* Never created. */ }
    const reply = error ? null : task?.kind === 'conversation' ? task.result : task?.reply ?? task?.result;
    const runs = task?.runs.slice(record.runsBefore) ?? [];
    // No run: nothing was spent. A run with no cost reported: unknown (null), which the daemon
    // counts as all the request reserved. A run whose cost may be more (atLeast): costAtLeast,
    // which the daemon counts as at least that.
    const spends = runSpends(task).slice(record.runsBefore), known = spends.every(spend => Number.isFinite(spend?.costUsd));
    const costUsd = !runs.length ? 0 : known ? spends.reduce((total, spend) => total + spend.costUsd, 0) : null, costAtLeast = runs.length > 0 && known && spends.some(spend => spend.atLeast);
    let text = reply?.summary ? reply.outcome === 'needs_input' && reply.question ? `${reply.summary}\n\n${reply.question}` : reply.summary : null;
    // A teammate's message started the owner's own kind of session, and its Task now waits for
    // him. The work it plans runs only once he approves it, and its result then comes to the
    // thread (result), so the teammate is told both.
    if (text && record.origin?.own && task && waitingTask(sessionTasks(record.controller.repo, task.id))) text = `${text}\n\n${PLAN_WAITS}`;
    // Their own message ended the Task's work, or a later one of theirs came after his check:
    // this reply is its result, so none follows.
    if (!error && record.origin?.own && task) { try { tellResult(record.controller.repo, task.id, { ended: true }); } catch { /* The reply still goes. */ } }
    writeOutbox(record.root, { id: record.requestId, origin: record.origin }, { taskId: record.taskId, outcome: error ? record.stopped ? 'stopped' : 'failed' : reply?.outcome ?? 'failed', text, costUsd, costAtLeast, error: error?.message ?? null, finishedAt });
  }
  // A turn of the owner's ended in a session a teammate's message started. When the Task he
  // approved there is finished (his check finishes it, tellChecked), what it did goes back to
  // that teammate's thread, once (tellResult). A turn that did the Task's work and failed or was
  // stopped is told too, once for a Task however often its work stops (tellStopped): the run
  // that started the work, whether he approved with the key or by typing yes, and any later
  // turn that carried it on (worked). A run that stops on a question sends nothing until the
  // Task is finished, and neither does one that is queued again (finish).
  result(record, error, finishedAt) {
    let task = null; try { task = readTask(record.controller.repo, record.taskId); } catch { return; }
    const origin = task.origin;
    if (origin?.own !== true || typeof origin.peer !== 'string' || typeof origin.threadId !== 'string') return;
    if (error) { if ((record.approved || record.worked?.() === true) && tellStopped(record.controller.repo, record.taskId)) writeResult(record.root, record.requestId, { origin, taskId: record.taskId, outcome: record.stopped ? 'stopped' : 'failed', text: 'The approved work stopped before it was done.', finishedAt }); return; }
    const finished = tellResult(record.controller.repo, record.taskId); if (!finished) return;
    const reply = task.kind === 'conversation' ? task.result : task.reply ?? task.result;
    writeResult(record.root, record.requestId, { origin, taskId: record.taskId, outcome: reply?.outcome ?? 'completed', text: reply?.summary || `Done: ${finished.title}`, finishedAt });
  }
  // Runs left by a conductor that ended without stopping them are marked stopped.
  // Runs owned by a live terminal, this conductor or a replaced one still finishing are left alone.
  recover() {
    const kept = new Set([...this.runs.values(), ...(this.othersNow ?? []).flatMap(row => row.runs)].map(run => run.requestId).filter(Boolean));
    for (const repo of registeredProjects()) {
      let values = []; try { values = tasks(repo); } catch { continue; }
      for (const task of values.filter(task => ['running', 'preparing'].includes(task.state))) {
        if (sameProcess(task.owner)) continue;
        let release; try { release = lock(repo, `task-${task.id}`); } catch { continue; }
        try {
          const file = path.join(taskDir(repo, task.id), 'process.json'); noSymlinks(file);
          if (fs.existsSync(file)) recoverProcess(readJson(file));
          const current = readTask(repo, task.id);
          // A shadow bot's turn that was cut off leaves the session where the agent left it.
          // So does a standup's answer turn (lib/standup.mjs), and a quick answer of Auto model's
          // (lib/runner.mjs runAutoAnswer): the owner's question stays in the chat, and a line
          // under it says it got no answer, so he sends it again.
          const asked = current.quickTurn ? (current.messages ?? []).findLast(row => typeof row.quick === 'string' && !row.from && !row.line) : null;
          const shadowed = current.shadowing?.state ?? current.standupTurn?.state ?? current.quickTurn?.state ?? null; delete current.shadowing; delete current.standupTurn; delete current.quickTurn;
          Object.assign(current, shadowed ? { state: shadowed, activeRole: null, activeLog: null } : { state: 'stopped', activeRole: null, activeLog: null, error: { message: 'ELU stopped before this response finished. Retry to continue.' } });
          if (asked && !current.messages.some(row => row !== asked && row.quick === asked.quick)) current.messages.push({ at: new Date(Math.max(Date.now(), Date.parse(asked.at) + 1 || 0)).toISOString(), text: AUTO_LINES.quickCut, from: 'ELU', line: true, quick: asked.quick });
          saveTask(repo, current);
        } finally { release(); }
      }
      // A session an earlier version left stopped on its own commit has finished (lib/task-head.mjs).
      for (const task of values.filter(task => task.committed?.unread)) settleFinished(repo, task.id);
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
    const runs = [...this.runs.values()].map(({ root, project, taskId, requestId, startedAt, attempts, stalled, origin, answers, aside }) => ({ root, project, taskId, requestId, startedAt, attempts, stalled: Boolean(stalled), origin, ...(answers ? { answers: true } : {}), ...(aside ? { aside: true } : {}) }));
    if (this.draining && stopped) return void fs.rmSync(drainFile(this.draining), { force: true });
    if (this.beside && stopped) { fs.rmSync(besideStatusPath(), { force: true }); this.unlist(); return; }
    // goals: its turns take a new goal of the owner's while they work (conductorTakesGoals).
    // auto: it runs a session with Auto model (conductorTakesAuto).
    // full: it keeps the owner's word (asOwner) and what a Full start carries (conductorTakesFull).
    const value = this.draining ? { id: this.draining, ...processRecord(), version: this.version, startedAt: this.startedAt, error: this.error, runs, goals: 1, auto: 1 }
      : { pid: process.pid, version: this.version, startedAt: this.startedAt, stopped, error: this.error, queued: this.queued, runs, standup: 1, standupAside: 1, copies: 1, goals: 1, auto: 1, overseer: 1, full: 1 };
    const text = JSON.stringify(value);
    if (!stopped && text === this.written && Date.now() - this.writtenAt < 2000) return;
    mkdir(folder()); atomic(this.draining ? drainFile(this.draining) : this.beside ? besideStatusPath() : statusFile(), { ...value, heartbeatAt: new Date().toISOString() });
    if (this.beside && this.aside) this.list();
    this.written = text; this.writtenAt = Date.now();
  }
  // Beside a conductor that stays, its runs are listed for that one too, as a replaced
  // conductor lists the runs it finishes (drainingConductors). more: a request it is about to claim.
  list(more = []) {
    const runs = [...this.runs.values()].map(({ root, project, taskId, requestId, startedAt, attempts, stalled, origin, answers, aside }) => ({ root, project, taskId, requestId, startedAt, attempts, stalled: Boolean(stalled), origin, ...(answers ? { answers: true } : {}), ...(aside ? { aside: true } : {}) }));
    mkdir(folder()); atomic(drainFile(this.aside), { id: this.aside, beside: true, ...processRecord(), version: this.version, startedAt: this.startedAt, error: this.error, runs: [...runs, ...more], heartbeatAt: new Date().toISOString() });
  }
}
