import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { git, diff, head, baseFile, prepareGit, currentBranch, located, findRepository, publishable, taskChanges, notesSpec } from './git.mjs';
import { tasks, readTask, taskDir, lock, saveTask, nameFile, settingsFile, setTitle, teammateText, taskTitle, waitLock } from './state.mjs';
import { atomic, findBin, HOME_TARGET, homeOrAbove, homeRefusal, homeWork, isObject, noSymlinks, readJson, refuse, hash, within } from './util.mjs';
import { parseConfig, validateConfig, defaultConfig } from './config.mjs';
import { stringifyYaml } from './yaml.mjs';
import { detect } from './detect.mjs';
import { initPlan, applyInit, inferChecks } from './init.mjs';
import { NOT_OWNER_WORD, answeringAsOwner, answeringComputer, answeringOverseer, ownerWord, beginApproved, checkLead, runPlan, runTask, continueReady, continueTask, reviewRequest, reviewPullsAsked, createConversation, runConversation, runBot, runShadows, runStandup, runStandupAside, runMessageAside, runAutoAnswer, runArchiveLearn, isPeerRun, allowHome, setPermissions as savePermissions, addFolder as saveFolder, setBots as saveBots, setBudget as saveBudget } from './runner.mjs';
import { alreadyPublished, preparePublish, publish, pushing, redact, settlePush, stopPush } from './publish.mjs';
import { settleFinished } from './task-head.mjs';
import { shellFile, shellRows, shellText, shellForModel } from './shell.mjs';
import { replyFile, replyRows } from './waiting-replies.mjs';
import { ADAPTERS } from './adapters/index.mjs';
import { personalDirectory, usageSnapshot, refreshCodexUsage } from './usage.mjs';
import { pinnedConfig, runChecks, evidenceCurrent } from './checks.mjs';
import { roleSpend } from './budget.mjs';
import { approveSaved, ensureTrustStore, trustedText } from './project-trust.mjs';
import { claudeServers, checkServerName } from './mcp.mjs';
import { readBoard, sessionArchived, sessionClosed, sessionPlace } from './kanban.mjs';
import { projectFolder, pendingRequests, saveRequest, removeRequest, historyPlan, createHistory, supersededRequests } from './workspace.mjs';
import { BOT_NAME, botKey, botModelProblem, botOfKey, botOversees, botWorks, chatBots, everOversaw, getBot, listBots, needBot, plainQuestion, reviewingBots, sessionBots, sessionWorker, sharedBot } from './bots.mjs';
import { buildChanges, joinChanges, packChanges } from './diff.mjs';
import { NOTES, sessionWork, comparedWith, groundOf, olderThanSession } from './session-work.mjs';
import { pulls } from './pulls.mjs';
import { agreedTask, approveTask, currentTask, openTask, planFile, proposeTask, saysYes, sessionTasks, taskStarted, taskToStart, waitingTask } from './plan.mjs';
import { changeAgent, changeLine, effortProblem, leadEffort, sessionBot } from './agent-change.mjs';
import { NO_QUESTIONS, checkModel, configModel, defaultModel, modelName, nextModel, ownsPolicy, setDefaultModel, setSessionModel, startModel, takeNextModel, vendorShort, withModel } from './models.mjs';
import { questionRefusal } from './vendors.mjs';
import { closeWindow, ownEluWindow, pause, processRecord, processStarted, processTerminal, runProcesses, sameProcess } from './process.mjs';
import { RUNNING } from './conductor-files.mjs';
import { foldStandup } from './standup.mjs';
import { CAP_CARRIED_LINE, CAP_CARRY_TEXT } from './turn-limits.mjs';
import { familyOf, moveText } from './claude-switch.mjs';
import { claudeModelFree } from './claude-accounts.mjs';
import { modelEfforts, readBotModels } from './bot-models.mjs';
import { LINES as AUTO_LINES, autoOn, classNames, homeProblem, insteadKey, insteadLine, isThink, quickText, routeFor, routeName, sayOnce, setSessionAuto, stepOf } from './auto-model.mjs';
import { WHILE_WORKING, asideWaiting, foldAsides, saveAside } from './message-aside.mjs';
import { deleteSession, keepRun, removedSpend, takeRunId, unpushedWork } from './session-delete.mjs';
import { learnedLines, saveLearned } from './project-learnings.mjs';
import { teamProjectName } from './peer/team-name.mjs';
import { LABELS, checkMode } from './modes.mjs';
import { jobsDir, sessionJobsNow, stoppedNotes } from './jobs.mjs';
import { eluLine, leadAsked, leadBackText, sentByElu } from './elu-sent.mjs';
import { foldPulls, pullEntries, pullsAsked } from './pull-reviews.mjs';
import { keepGoingFile, keepGoingStop, readKeepGoing } from './keep-going.mjs';
import { runSteps } from './run-activity.mjs';
import { scanSecrets } from './peer/secrets.mjs';
import { LOG_ROWS_DEFAULT, LOG_ROWS_MAX, SETTINGS_PARTS, asOwnerMark } from './peer/remote-methods.mjs';
import { decisionLines, updateTask as updateOwnerTask } from './owner-decisions.mjs';

export { personalDirectory } from './usage.mjs';
export function registerProject(repo) {
  // What the owner approved is recorded before the list grows, so a project added now is
  // never taken for one he already had.
  ensureTrustStore();
  const dir = personalDirectory();
  const release = lock({ state: dir }, 'projects');
  try {
    const file = path.join(dir, 'projects.json'); noSymlinks(file);
    const rows = fs.existsSync(file) ? readJson(file) : [];
    if (!Array.isArray(rows) || rows.some(row => typeof row?.root !== 'string')) refuse('The project registry is invalid.');
    atomic(file, [...rows.filter(row => row.root !== repo.root && !(repo.common && row.common === repo.common)), { root: repo.root, common: repo.common }]);
  } finally { release(); }
}
// Archives a project: it leaves the registry (and the Projects tab). Its folder and the
// sessions saved in it stay as they are, and opening the folder again brings both back.
export function archiveProject(root) {
  const dir = personalDirectory();
  const release = lock({ state: dir }, 'projects');
  try {
    const file = path.join(dir, 'projects.json'); noSymlinks(file);
    const rows = fs.existsSync(file) ? readJson(file) : [];
    if (!Array.isArray(rows) || rows.some(row => typeof row?.root !== 'string')) refuse('The project registry is invalid.');
    if (!rows.some(row => row.root === root)) return false;
    atomic(file, rows.filter(row => row.root !== root)); folders.delete(root); return true;
  } finally { release(); }
}
// A window that shows a project holds it, so two windows never both change it: a lock in your
// folder for the project, and one in its repository's Git folder (attach), shared by every
// project of that repository. window: the window that asks (any object of its own). What a
// window holds is its own and never another's: asked again, it is shared, and goes with its
// last release. A window that finds the project held by another is view-only; holder says
// which window that is (lib/terminal.mjs names it), and retry() takes the project over once
// that window is gone or has let go. true when this claim may change the project now.
// held: every lock this process holds now.
// Each lock names the version its window runs, so a later version's conductor knows a window
// of an earlier one is open (earlierWindows in lib/conductor-files.mjs).
const viewLocks = new Map(), held = new Set();
function holdView(target, name, window) {
  const file = path.join(target.state, `${name}.lock`), mine = window ? viewLocks.get(file) : null;
  let close;
  if (mine?.window === window) { mine.count++; close = mine.close; }
  else { close = lock(target, name, { version: RUNNING }); held.add(file); if (window) viewLocks.set(file, { window, count: 1, close }); }
  let done = false;
  const release = () => {
    if (done) return; done = true;
    const row = window ? viewLocks.get(file) : null;
    if (row && --row.count > 0) return;
    if (row) viewLocks.delete(file);
    held.delete(file); close();
  };
  // shared: the window had this lock already, so nothing was taken from another window.
  release.shared = mine?.window === window;
  return release;
}
// Who holds a lock: its process, when that started (its identity begins with the start time
// ps prints) and its terminal. null when the lock cannot be read. The same holder as known is
// known already, so a window that asks every second asks ps only when the holder changed.
// The holder wrote its start in its own time zone and language: it is read as written when
// that is the start ps gives here too, and taken from ps when it is not.
function viewHolder(file, known = null) {
  let row; try { row = readJson(file); } catch { return null; }
  const pid = Number.isInteger(row?.pid) ? row.pid : null, identity = String(row?.identity ?? ''), born = typeof row?.born === 'string' ? row.born : '';
  if (known && known.pid === pid && known.identity === identity && (known.born ?? '') === born) return known;
  const wrote = Date.parse(identity.slice(0, 24)), real = pid && (identity || born) ? processStarted(pid) : null;
  const started = real !== null && !(Math.abs(wrote - real) <= 2000) ? real : wrote;
  // window: another process of this user that is an ELU window, which a change here takes the
  // project from (claim.takeNow).
  return { pid, identity, ...(born ? { born } : {}), startedAt: Number.isFinite(started) ? new Date(started).toISOString() : null, terminal: pid ? processTerminal(pid) : null, window: Boolean(pid) && pid !== process.pid && ownEluWindow(pid) };
}
const lockText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
// A lock that names this process and that this process does not hold is nobody's: a window
// that ended left it, and this process got its number. One window alone is never view-only.
const leftover = file => { try { return readJson(file)?.pid === process.pid && !held.has(file); } catch { return false; } };
// What a view-only window says: why, and what to do. It claims again on every write and on a
// timer, so it can make changes by itself once the other window is gone. ask() asks the
// window that has the project to let go, in a file beside the lock that window holds:
// wanted() tells that window once, giveUp() is how it lets go, and a window that takes a
// lock clears what was asked beside it (one that only claims again what it holds leaves it
// for wanted()). takeOver(repo) asks the window that holds the project's own lock.
export const VIEW_ONLY = 'View only: another ELU window has this project. Close it, or /takeover here.';
const projectLock = repo => path.join(personalDirectory(), `view-${hash(repo.root)}.lock`), askedFile = file => file.replace(/\.lock$/, '.takeover');
const askFor = file => atomic(askedFile(file), { ...processRecord(), id: randomUUID() });
export function takeOver(repo) { askFor(projectLock(repo)); }
// How long a view-only window goes by what it last found before it asks ps again.
const SURE_MS = 30000;
export function claimView(repo, { window = null } = {}) {
  const releases = [], files = []; let common = null, latest = repo, trying = null, found = null;
  const claim = { readOnly: false, holder: null, holderOpen: false };
  const take = (target, name) => {
    trying = path.join(target.state, `${name}.lock`); const close = holdView(target, name, window); releases.push(close); files.push(trying);
    if (!close.shared) fs.rmSync(askedFile(trying), { force: true });
  };
  // A lock that is gone already is let go all the same; the others still are.
  claim.release = () => { for (const close of releases.splice(0).reverse()) { try { close(); } catch { /* Removed already. */ } } files.length = 0; common = null; };
  // A repository the project folder became, or that it was found to be: view-only, it is
  // remembered, and taken with the project when the claim is.
  claim.attach = value => { latest = value; if (!claim.readOnly && value.common && value.common !== common) { take(value, 'view'); common = value.common; } };
  // The window that has the project: true, once, when another window that is still open asked for it.
  claim.wanted = () => {
    if (claim.readOnly) return false;
    let wanted = false;
    for (const file of files.map(askedFile)) {
      let asked; try { asked = readJson(file); } catch { continue; }
      fs.rmSync(file, { force: true }); if (sameProcess(asked) === true) wanted = true;
    }
    return wanted;
  };
  // A view-only window asks the one whose lock stopped it.
  claim.ask = () => { if (claim.readOnly) askFor(trying ?? projectLock(repo)); };
  // It lets go, and is view-only until it claims the project again.
  claim.giveUp = () => { claim.release(); claim.readOnly = true; claim.holder = null; found = null; };
  const claimAll = (now, cleared = new Set()) => {
    try { take({ state: personalDirectory() }, `view-${hash(repo.root)}`); claim.readOnly = false; claim.attach(latest); claim.holder = null; found = null; return true; }
    catch (error) {
      claim.release();
      if (!error.message.includes('holds this lock')) throw error;
      if (!cleared.has(trying) && leftover(trying)) { cleared.add(trying); fs.rmSync(trying, { force: true }); return claimAll(now, cleared); }
      claim.readOnly = true; claim.holder = viewHolder(trying, claim.holder); found = { file: trying, text: lockText(trying), pid: claim.holder?.pid ?? null, at: now }; return false;
    }
  };
  // A view-only window looks every second. The answer is the same while the lock it found is
  // unchanged and that lock's process is still there, which signal 0 tells without starting
  // anything. ps is asked again once either changed, and every SURE_MS, because a process
  // that ended without letting go may have left its number to another.
  const unchanged = now => {
    if (!found?.pid || found.text === null || now - found.at >= SURE_MS || now < found.at || lockText(found.file) !== found.text) return false;
    try { process.kill(found.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  };
  // sure: false on the timer, where an unchanged answer is not asked for again.
  // holderOpen: the window this claim took the project from is still open, so it let go when
  // asked; otherwise it has closed.
  claim.retry = ({ sure = true, now = Date.now() } = {}) => {
    if (!claim.readOnly) return true;
    if (!sure && unchanged(now)) return false;
    const had = claim.holder;
    if (!claimAll(now)) return false;
    claim.holderOpen = sameProcess(had) === true;
    return true;
  };
  // A change in a view-only window takes the project at once (takeNow). The window that has
  // it is asked to let go and given waitMs to, as /takeover asks; one that does not (hung, or
  // of 0.1.19 or earlier, whose lock names no version and which never reads the request) is
  // closed (closeWindow) when nothing runs in it. One that runs something is left open, and
  // claim.busy names what runs (runningIn). Never this process. waiting() is called once
  // before it waits. 'let go', 'gone' or 'closed' once this claim has the project; false when
  // it does not.
  const holderRecord = () => { try { return found?.file ? readJson(found.file) : null; } catch { return null; } };
  const took = () => claim.holderOpen ? 'let go' : 'gone';
  claim.takeNow = ({ waitMs = 4000, waiting = null } = {}) => {
    claim.busy = null;
    if (claim.retry()) return took();
    const record = holderRecord();
    if (!Number.isInteger(record?.pid) || record.pid === process.pid) return false;
    waiting?.();
    if (typeof record.version === 'string') {
      claim.ask();
      for (const end = Date.now() + waitMs; Date.now() < end;) { pause(100); if (claim.retry()) return took(); }
    }
    const running = runningIn(record);
    if (running.length) { claim.busy = running; return false; }
    return claim.closeHolder() ? 'closed' : false;
  };
  // What closing that window would stop. The sessions that run in it: each names the process
  // that runs it (task.owner), so one the conductor runs is not one of them. A window of 0.1.19
  // names none: there it is what the window itself started and still runs, apart from the
  // conductor and the peer daemon (they stay when it closes), caffeinate (lib/awake.mjs) and
  // what ends in a moment (a ps, git or gh it asks); then named by the sessions without an
  // owner that run, or else by its command ({ command }).
  const runningIn = record => {
    let live = []; try { live = tasks(latest).filter(task => ['running', 'preparing'].includes(task.state)); } catch { /* None read. */ }
    const owned = live.filter(task => task.owner?.pid === record.pid && sameProcess(task.owner) === true);
    if (owned.length) return owned;
    const started = () => runProcesses(record.pid).filter(row => row.ppid === record.pid && !/\s--daemon(?:\s|$)/.test(row.command) && !/^(?:\S*\/)?(?:ps|caffeinate)(?:\s|$)/.test(row.command));
    const first = started(); if (!first.length) return [];
    pause(700); const again = started(), stays = first.filter(row => again.some(next => next.pid === row.pid && next.command === row.command));
    if (!stays.length) return [];
    const unowned = live.filter(task => !task.owner);
    return unowned.length ? unowned : stays.map(row => ({ command: row.command }));
  };
  // Closes the window that has the project, whatever runs in it (the owner said yes), and takes it.
  claim.closeHolder = () => {
    if (!claim.readOnly) return true;
    const record = holderRecord();
    if (Number.isInteger(record?.pid) && record.pid !== process.pid) closeWindow(record);
    return claim.retry();
  };
  claimAll(Date.now());
  return claim;
}
function readTail(file, limit = 64000) {
  noSymlinks(file); if (!fs.existsSync(file)) return '';
  const fd = fs.openSync(file, 'r');
  try { const size = fs.fstatSync(fd).size; const bytes = Buffer.alloc(Math.min(size, limit)); fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - limit)); return bytes.toString('utf8'); }
  finally { fs.closeSync(fd); }
}
// Views redraw several times a second. Each file is parsed again only after it changes;
// values are frozen because every redraw shares them.
const parsed = new Map();
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) freeze(item); } return value; }
// Callers check the folders above the file; the file itself is checked here.
function signature(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink()) refuse(`Refusing a symbolic link: ${file}`);
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}
// A redraw checks the state folder once, then only the parts below it.
function stateDir(repo, id) {
  if (!/^[1-9][0-9]*$/.test(String(id))) refuse('Task ID must be a positive integer.');
  let current = repo.state;
  for (const part of ['tasks', String(id)]) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) refuse(`Refusing a symbolic link: ${current}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
// beside is one more file, or several, the value is read from too: a change to any reads it again.
function memo(file, key, read, beside = null) {
  const also = other => { try { return signature(other); } catch { return 'refused'; } };
  const first = signature(file), sig = first === null || !beside ? first : [first, ...[beside].flat().map(also)].join('|'), id = `${key}\0${file}`;
  if (sig === null) { parsed.delete(id); return undefined; }
  const hit = parsed.get(id);
  if (hit?.sig === sig) return hit.value;
  const value = freeze(read()); parsed.delete(id); parsed.set(id, { sig, value });
  if (parsed.size > 4000) parsed.delete(parsed.keys().next().value);
  return value;
}
// A bot runs as bot:<name>; the activity names it the way the owner writes to it, and the
// session's own run as the model.
const shown = role => botOfKey(role) ? `@${botOfKey(role)}` : role === 'lead' ? 'model' : role;
function eventRows(file) {
  return memo(file, 'events', () => readTail(file).split('\n').flatMap(line => {
    try {
      const row = JSON.parse(line);
      // A row says who did what, never which session by number: taskId carries that, and step
      // is what the session's row in the list shows while it runs.
      const check = row.type === 'check-started' ? `running ${row.name}` : row.type === 'check-finished' ? `${row.name} ${row.status}` : null;
      const what = `${typeof row.note === 'string' ? row.note : row.type.replace(/^role-/, '').replace(/^task-/, 'session ').replaceAll('-', ' ')}${row.state ? ` (${row.state})` : ''}`;
      const text = check !== null ? `checks: ${check}` : row.role ? `${shown(row.role)}: ${what}` : what;
      return [{ at: row.at, text: redact(text), taskId: row.taskId ?? null, ...(check !== null ? { step: redact(check) } : {}) }];
    } catch { return []; /* Partial append. */ }
  })) ?? [];
}
// vendor: the run's vendor; its adapter reads a log line when it exports logRow,
// else the Claude and Codex shapes below are tried.
function logRows(file, role, at, id, vendor = null) {
  return memo(file, `log\0${role}\0${at ?? ''}\0${id}\0${vendor ?? ''}`, () => {
    const rows = []; const time = at ?? fs.statSync(file).mtime.toISOString(), prefix = `${shown(role)}: `;
    const add = text => rows.push({ at: time, text: redact(prefix + text), taskId: id, step: redact(text) });
    const logRow = ADAPTERS[vendor]?.logRow;
    for (const line of readTail(file).split('\n')) {
      try {
        const row = JSON.parse(line);
        if (typeof logRow === 'function') { const read = logRow(row); if (read?.text) add(String(read.text)); continue; }
        for (const item of row.message?.content ?? []) {
          if (item.type === 'text') add(item.text);
          if (item.type === 'tool_use') add(`${item.name} ${item.input?.file_path ?? item.input?.command ?? ''}`);
        }
        if (row.type === 'result') add(row.structured_output?.summary ?? row.result ?? '');
        // Codex's own notices (error items: a warning to whoever runs it) are not the session's activity.
        if (row.type === 'item.completed' && row.item?.text && row.item.type !== 'error') { let text = row.item.text; try { text = JSON.parse(text).summary ?? text; } catch {} add(text); }
      } catch { /* An unfinished line is not an event. */ }
    }
    return rows;
  }) ?? [];
}
export function activity(repo, values = tasks(repo), limit = 100) {
  // The newest rows in time order. Every row of one log shares its run time, so whole logs
  // are ordered as blocks instead of sorting each row on every redraw.
  const blocks = [], time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
  noSymlinks(repo.state);
  for (const row of eventRows(path.join(repo.state, 'events.jsonl')).slice(-limit)) blocks.push([time(row.at), blocks.length, [row]]);
  for (const task of values) {
    // A try the vendor turned away as overloaded (lib/runner.mjs) did nothing of the session's.
    const files = [...task.runs.filter(run => !run.overloaded).map(run => run.logFile), task.activeLog].filter(Boolean), dir = stateDir(repo, task.id);
    for (const file of new Set(files)) {
      if (path.dirname(file) !== dir) continue;
      // A finished run's rows carry its end; the run in progress's, the last time its log was
      // written, so they come after the session's own row that says the run started.
      const run = task.runs.find(run => run.logFile === file);
      const rows = logRows(file, run?.role ?? task.activeRole ?? 'lead', run?.at ?? null, task.id, run?.vendor ?? null);
      if (rows.length) blocks.push([time(rows[0].at), blocks.length, rows]);
    }
  }
  blocks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const newest = []; let count = 0;
  for (let index = blocks.length - 1; index >= 0 && count < limit; index--) { const rows = blocks[index][2].slice(-(limit - count)); newest.push(rows); count += rows.length; }
  return newest.reverse().flat();
}
function viewTasks(repo) {
  const folder = path.join(repo.state, 'tasks'); noSymlinks(folder);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(id => /^[1-9][0-9]*$/.test(id)).map(id => memo(path.join(stateDir(repo, id), 'task.json'), 'task', () => withPlan(repo, readTask(repo, id)), [nameFile(repo, id), settingsFile(repo, id), planFile(repo, id), keepGoingFile(repo, id)]))
    .filter(Boolean).sort((a, b) => Number(a.id) - Number(b.id));
}
// A session in a snapshot carries its current Task (lib/plan.mjs) as plan, when it has one.
// keepStopped: ELU stopped starting it by itself, and why (lib/keep-going.mjs).
function withPlan(repo, task) {
  const plan = currentTask(repo, task.id);
  if (!plan) return task;
  let stop = null; try { stop = keepGoingStop(task, readKeepGoing(repo, task.id)); } catch { stop = null; }
  return { ...task, plan, ...(stop ? { keepStopped: stop } : {}) };
}
// The project's own settings, when the owner approved them on this machine; null when it
// has none or they are not approved. Parsed once for each text.
const approvedConfigs = new Map();
function approvedConfig(root) {
  const text = trustedText(root, 'config.yaml');
  if (text == null) { approvedConfigs.delete(root); return null; }
  const hit = approvedConfigs.get(root); if (hit?.text === text) return hit.config;
  const config = freeze(parseConfig(text)); approvedConfigs.set(root, { text, config }); return config;
}
// The settings a new session starts from: the project's own as the owner approved them
// (the file as it stands, or the version he approved last while it differs), else the ones
// a project with no settings file gets. The checks found in the folder run after an edit,
// inside the check sandbox. They are never handed to the lead as shell commands: only a
// settings file the owner wrote, or approved, names those.
export function startConfig(root) {
  const text = trustedText(root, 'config.yaml'); if (text != null) return parseConfig(text);
  const config = defaultConfig(); config.checks = inferChecks(root);
  return config;
}
export function projectSnapshot(repo) {
  const config = approvedConfig(repo.root);
  let values = viewTasks(repo);
  // A session an earlier version left stopped on its own commit has finished: its commit is
  // taken in here, once, with no turn (lib/task-head.mjs).
  if (values.filter(task => task.committed?.unread).map(task => settleFinished(repo, task.id)).some(Boolean)) values = viewTasks(repo);
  // A push an ELU that ended without a word left is stopped, and its session says so (lib/publish.mjs).
  if (values.filter(task => task.pushRun).map(task => settlePush(repo, task)).some(Boolean)) values = viewTasks(repo);
  // jobs: a session's long jobs that run, or ended and wait to be told (lib/jobs.mjs), read now.
  values = values.map(task => { const jobs = sessionJobsNow(repo.root, task.id); return jobs.length ? { ...task, jobs } : task; });
  const initialized = Boolean(config && repo.state && fs.existsSync(path.join(repo.state, 'manifest.json')));
  // A message a newer one to the same session made pointless is not shown; superseded names
  // them, so the app takes them out of the queue.
  const all = pendingRequests(repo.root), superseded = supersededRequests(all, values), saved = all.filter(row => !superseded.includes(row.id));
  // Closed sessions leave Sessions. The board keeps the ones moved to Done there, and shows no archived one.
  // archived: those of them the owner archived, which /archived lists; one he checked Done is not.
  let closed = [], archived = []; try { const board = readBoard(repo); closed = values.filter(task => sessionClosed(board, task)).map(task => task.id); archived = values.filter(task => sessionArchived(board, task)).map(task => task.id); } catch { /* An unreadable board closes nothing. */ }
  // What sessions deleted for good spent stays in Usage (lib/session-delete.mjs).
  let removed = []; try { removed = removedSpend(repo); } catch { removed = []; }
  return { name: projectName(repo.root), branch: repo.common ? currentBranch(repo.root) : 'new project', root: repo.root, initialized, roles: config?.roles ?? defaultConfig().roles, tasks: values, closed, archived, superseded, removed,
    requests: saved.filter(row => !QUEUE_ONLY.includes(row.state) && !values.some(task => task.id === row.taskId && task.goal === row.goal || task.id === row.continuationTaskId && task.state === 'running')),
    queue: saved.filter(row => row.state !== 'done'), activity: activity(repo, values), usage: usageSnapshot() };
}
// Requests the conductor is handling or has finished; History lists only saved ones.
const QUEUE_ONLY = ['queued', 'starting', 'running', 'done'];
// The registry already records each Git root and common directory. While both still exist,
// reuse them instead of asking Git on every redraw. Anything else is resolved again.
const folders = new Map();
function registeredProject(entry) {
  if (entry.common && typeof entry.common === 'string' && fs.existsSync(path.join(entry.root, '.git')) && fs.existsSync(entry.common)) return located(entry.root, entry.common);
  const cached = folders.get(entry.root);
  if (cached && fs.existsSync(cached.root) && !fs.existsSync(path.join(cached.root, '.git'))) return cached;
  const repo = projectFolder(entry.root); if (entry.common && repo.common !== entry.common) refuse('Repository location changed.');
  if (!repo.common) folders.set(entry.root, repo); else folders.delete(entry.root);
  return repo;
}
// A project's name and marker live in its folder, next to its settings.
const projectFile = root => path.join(root, '.elu-code', 'project.json');
// One rule for a name the owner types and a name a copied folder ships: 1 to 60 characters,
// none of them a control character. Braces are allowed; the screen draws a name as plain text.
function projectNameOf(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= 60 && !/[\u0000-\u001f\u007f-\u009f]/.test(name) ? name : null;
}
export function savedProjectName(root) {
  try {
    const file = projectFile(root); noSymlinks(file); if (!fs.existsSync(file)) return null;
    return projectNameOf(readJson(file)?.name);
  } catch { return null; }
}
// The name a project goes by: one given to it here, else the name its team gives it when it is
// a team's project (lib/peer/team-name.mjs), else its folder's. The name a new project gets is
// its folder's, so that one gives way to the team's.
export function projectName(root) {
  const saved = savedProjectName(root), own = saved && saved !== path.basename(root) ? saved : null;
  return own ?? teamProjectName(root) ?? saved ?? path.basename(root);
}
// A folder is a project once it has ELU settings or is in the registry.
export function knownProject(location) {
  if (['project.json', 'config.yaml'].some(name => fs.existsSync(path.join(location.root, '.elu-code', name)))) return true;
  try {
    const file = path.join(personalDirectory(), 'projects.json'); noSymlinks(file);
    const rows = fs.existsSync(file) ? readJson(file) : [];
    return Array.isArray(rows) && rows.some(row => row?.root === location.root || Boolean(location.common) && row?.common === location.common);
  } catch { return false; }
}
export function nameProject(location, name) {
  const value = projectNameOf(String(name ?? ''));
  if (!value) refuse('Use a project name of 1 to 60 characters.');
  const folder = path.join(location.root, '.elu-code'); noSymlinks(folder); fs.mkdirSync(folder, { recursive: true });
  atomic(projectFile(location.root), { name: value, createdAt: new Date().toISOString() });
  registerProject(location); return value;
}
export function registeredProjects() {
  const file = path.join(personalDirectory(), 'projects.json'); noSymlinks(file);
  if (!fs.existsSync(file)) return [];
  const entries = readJson(file); if (!Array.isArray(entries)) refuse('The project registry is invalid.');
  return entries.flatMap(entry => { try { return [registeredProject(entry)]; } catch { return []; } });
}
export function dashboardSnapshot() {
  const file = path.join(personalDirectory(), 'projects.json'); noSymlinks(file);
  if (!fs.existsSync(file)) return { projects: [], usage: usageSnapshot() };
  const entries = readJson(file); if (!Array.isArray(entries)) refuse('The project registry is invalid.');
  return { usage: usageSnapshot(), projects: entries.map(entry => {
    try { return projectSnapshot(registeredProject(entry)); }
    catch (error) { return { root: entry.root, name: projectName(entry.root), unavailable: error.message, tasks: [], requests: [], queue: [], roles: {}, activity: [] }; }
  }) };
}
// Turns one of your Claude Code MCP servers on or off for this project's lead. All are on
// until turned off, as in Claude Code.
export function setServer(repo, name, on, proposedConfig) {
  checkServerName(name);
  if (!claudeServers(repo.root)[name]) refuse(`No MCP server named ${name}. Run claude mcp list to see yours.`);
  // The change starts from settings the owner approved, never from a file he has not.
  const file = path.join(repo.root, '.elu-code/config.yaml'), approved = trustedText(repo.root, 'config.yaml');
  const config = approved != null ? parseConfig(approved) : structuredClone(proposedConfig);
  const off = new Set(config.mcpOff ?? []); if (on) off.delete(name); else off.add(name);
  delete config.mcp; if (off.size) config.mcpOff = [...off]; else delete config.mcpOff;
  validateConfig(config); const text = stringifyYaml(config);
  fs.mkdirSync(path.dirname(file), { recursive: true }); approveSaved(repo.root, 'config.yaml', text); atomic(file, text); return config;
}
// The branches a session changed (lib/session-work.mjs), each with what Git compares it with
// (ref), what that is in words (compared) and its pull request where one is known (pull):
// the one ELU opened, or the one GitHub lists for a branch the session pushed itself.
// changed: called when a pull request becomes known after this answer was given. skip: what
// leaves out of the checked-out branch's diff the files that are never the session's change
// (the project's notes, and in the owner's own folder what is older than the session: older).
function sessionParts(repo, task, { changed = null } = {}) {
  const work = sessionWork(task), { names: older, skip: past, more } = olderThanSession(task), skip = [...notesSpec(task), ...past];
  let project = null; try { project = currentBranch(task.repository ?? repo.root) || null; } catch { /* The project's folder is on no branch that can be read. */ }
  const known = pulls(task.worktree, work.parts.filter(part => part.pushed && !(task.pr && part.branch === task.branch)).map(part => part.branch), { changed });
  return { note: more ? NOTES.crowded : work.note, older, skip, parts: work.parts.map(part => {
    const number = task.pr && part.branch === task.branch ? Number(/\/pull\/(\d+)/.exec(task.pr)?.[1]) : 0;
    return { ...part, ref: groundOf(task.worktree, part), compared: comparedWith(task, work, part, { project }), pull: number > 0 ? { number, url: /^https:\/\/\S+$/.test(task.pr) ? task.pr : null } : known.get(part.branch) ?? null };
  }) };
}
// The files Git does not track yet in a session's folder, each as text under its name.
// A new file is shown by its last 64000 bytes, or whole (whole). older: the ones that are not the session's.
function newFiles(task, whole, older = new Set()) {
  const untracked = git(task.worktree, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...notesSpec(task)]).stdout.split('\0').filter(name => name && !older.has(name));
  return untracked.map(file => {
    const full = path.join(task.worktree, file); noSymlinks(full);
    if (!fs.statSync(full).isFile()) return `New path: ${file} (not a regular file)`;
    // Read whole, a file that starts as binary is not read past its start.
    const text = whole && readStart(full, 0, 8000)?.bytes?.includes(0) ? '\0' : readTail(full, whole ? Infinity : 64000);
    return `New file: ${file}\n${text.includes('\0') ? '(binary content)' : text}${!whole && fs.statSync(full).size > 64000 ? '\n[File preview truncated.]' : ''}`;
  });
}
// The diff is what the session itself changed on the branch it is on (lib/session-work.mjs).
// A new file is shown by its last 64000 bytes, or whole for a review sent to a teammate (whole).
export function taskDetails(repo, id, { whole = false } = {}) {
  const task = readTask(repo, id);
  if (task.kind === 'conversation') return { task, diff: '', checks: [], reviews: [], logs: task.runs.filter(run => path.dirname(run.logFile) === taskDir(repo, id)).map(run => ({ role: run.role, text: readTail(run.logFile) })) };
  const ground = groundOf(task.worktree, sessionWork(task).parts[0]), older = olderThanSession(task);
  return { task, diff: [diff(task.worktree, ground, { exclude: [...notesSpec(task), ...older.skip] }), ...newFiles(task, whole, older.names)].join('\n'), checks: task.evidence?.results ?? [], reviews: task.reviews, logs: task.runs.filter(run => path.dirname(run.logFile) === taskDir(repo, id)).map(run => ({ role: run.role, text: readTail(run.logFile) })) };
}
// How Git writes a diff for the Changes view: no program of the project's runs, renames are paired.
const VIEW = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/'];
// What a session's computer sends of its changes to another computer of the owner's, for the
// Changes tab there (packChanges in diff.mjs): each branch the session changed, with what it
// is compared with and its pull request, then its diff; the branch that is checked out also
// with its new files, whole. A branch with nothing changed is left out.
export function sessionWire(repo, id, { whole = true, changed = null } = {}) {
  const task = readTask(repo, id);
  if (task.kind === 'conversation') return '';
  const { note, parts, older, skip } = sessionParts(repo, task, { changed });
  const sent = parts.map(part => ({ ...part, text: part.current ? [git(task.worktree, [...VIEW, part.ref, '--', ...skip]).stdout, ...newFiles(task, whole, older)].join('\n') : git(task.worktree, [...VIEW, part.ref, part.tip, '--']).stdout })).filter(part => part.text.trim());
  return packChanges({ note, parts: sent });
}
// The start of a new file for the Changes view: a regular file only, never through a link,
// never a wait on a pipe. All of it when it is at most `most` bytes, else `preview` bytes.
function readStart(file, most, preview) {
  try { noSymlinks(file); } catch (error) { return { note: /symbolic link/.test(error.message) ? 'symbolic link, not opened' : 'could not be read' }; }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { note: 'not a regular file' };
    const bytes = Buffer.alloc(stat.size <= most ? stat.size : Math.min(stat.size, preview));
    return { bytes: bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0)), size: stat.size };
  } catch (error) { return error.code === 'ENOENT' ? null : { note: error.code === 'ELOOP' ? 'symbolic link, not opened' : 'could not be read' }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
// How many lines a file holds, read in steps so a file of any size is counted without being
// held. A file that did not change since is not read again. null when it cannot be read.
const counted = new Map();
function lineTotal(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd), key = `${file}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}`;
    if (!stat.isFile()) return null;
    if (counted.has(key)) return counted.get(key);
    const step = Buffer.alloc(1024 * 1024);
    let total = 0, last = 10;
    for (let read; (read = fs.readSync(fd, step, 0, step.length, null)) > 0;) {
      for (let at = step.indexOf(10); at >= 0 && at < read; at = step.indexOf(10, at + 1)) total++;
      last = step[read - 1];
    }
    if (last !== 10) total++;
    counted.set(key, total); if (counted.size > 200) counted.delete(counted.keys().next().value);
    return total;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
// The local Changes view reads a page at a time: CHANGES_PAGE bytes of the patch and of each
// new file. pages: how many it holds now; Enter on a file's "more" row asks for one more.
// Nothing is left out: what is not read yet is counted, and said under its file.
export const CHANGES_PAGE = 4 * 1024 * 1024;
// What a session itself changed, as files, hunks and lines (the shape is in diff.mjs), one
// part for each branch it changed (lib/session-work.mjs). The safe Git flags of taskDetails,
// with renames paired. Each call runs Git, so a view keeps the answer and asks again only to
// refresh; a branch that is not checked out does not change, so its answer is kept here.
const committed = new Map();
export function taskPatch(repo, id, { changed = null, pages = 1 } = {}) {
  const task = readTask(repo, id);
  if (task.kind === 'conversation') return buildChanges();
  const { note, parts, older, skip } = sessionParts(repo, task, { changed }), built = [], budget = Math.max(1, Math.floor(pages) || 1) * CHANGES_PAGE;
  for (const part of parts) {
    const key = part.current ? null : `${task.worktree}\0${part.ref}\0${part.tip}\0${budget}`, range = part.current ? [part.ref, '--', ...skip] : [part.ref, part.tip, '--'];
    let changes = key ? committed.get(key) : null;
    if (!changes) {
      // The patch, as many pages of it as the view holds; a model is never given this one.
      const run = git(task.worktree, [...VIEW, ...range], { allowFailure: true, maxBuffer: budget });
      if (run.status !== 0 && run.error?.code !== 'ENOBUFS') refuse('git could not finish.', { exitCode: run.status, reason: (run.error?.message ?? run.stderr).trim().slice(0, 1000) });
      // A patch longer than that arrives cut short: the totals come from Git's own count, and the rest is the next page.
      const counts = run.status === 0 ? null : git(task.worktree, [...VIEW, '--raw', '--numstat', '-z', ...range]).stdout;
      const untracked = part.current ? git(task.worktree, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...notesSpec(task)]).stdout.split('\0').filter(name => name && !older.has(name)) : [];
      // New files are read as far as the view's pages reach, whole when they are shorter, and every
      // line of a longer one is counted. One that starts as binary is not read past its start.
      const read = file => {
        const full = path.join(task.worktree, file), start = readStart(full, 0, 8000);
        if (!start?.bytes || start.bytes.includes(0) || start.bytes.length >= start.size) return start;
        const got = readStart(full, budget, budget);
        return got?.bytes && got.bytes.length < got.size ? { ...got, total: lineTotal(full) } : got;
      };
      changes = buildChanges({ base: part.ground, branch: part.branch, patch: run.stdout, counts, untracked, read, paged: true });
      if (key) { committed.set(key, changes); if (committed.size > 60) committed.delete(committed.keys().next().value); }
    }
    // The folder's own branch is always told; another is told when it holds a change.
    if (part.current || changes.files.length || changes.hiddenFiles) built.push({ changes, branch: part.branch, current: part.current, pull: part.pull, compared: part.compared, commits: part.commits });
  }
  // Where other branches hold the changes and the folder's own holds none, it is not listed.
  const listed = built.length > 1 && !built[0].changes.files.length && !built[0].changes.hiddenFiles ? built.slice(1) : built;
  return joinChanges(listed, { note });
}
// Whether the owner's message to @name in this session asks for a review of its edits: the
// session's own editing turn for its approved Task finished (implementedAt), the session
// changed files since it started and has not published them, and it stopped after that;
// @name is one of its reviewing bots, and the message is about the work, not a plain
// question (plainQuestion). Edits the owner had in his checkout before an automatic session
// started, which it copies into its worktree (initialDigest), are not the session's own. The
// fix turns run under that Task, opened again when it was done (reviewRequest).
export const REVIEW_STATES = Object.freeze(['blocked', 'ready', 'unverified', 'needs_input']);
export function reviewsEdits(repo, task, name, text) {
  if (!task || task.kind === 'conversation' || task.pushedCommit || !task.implementedAt || !REVIEW_STATES.includes(task.state) || plainQuestion(text)) return false;
  if (!reviewingBots(task).includes(name) || !agreedTask(sessionTasks(repo, task.id))) return false;
  // The change is what its pull request would hold (lib/git.mjs changeBase); the copied edits are
  // compared from where it started, as they were when it did.
  try { const change = taskChanges(task); return (!task.initialDigest || taskChanges(task, task.base).digest !== task.initialDigest) && publishable(change).length > 0; } catch { return false; }
}
// ELU's line for each change the owner made to an agent of the session (lib/agent-change.mjs), such as
// "Effort of GPT-5.5: low → high".
const agentLines = task => (Array.isArray(task.agentChanges) ? task.agentChanges : []).filter(row => typeof row?.text === 'string' && typeof row.at === 'string').map(row => ({ role: 'ELU', at: row.at, text: row.text, line: true }));
// A note the bot that oversees the owner's sessions sent here (overseer, ProjectController.ask):
// an entry under the bot's name, never his, with its mark and the bot it went to (to), when
// it went to one.
const overseerMark = row => ({ overseer: true, ...(typeof row.to === 'string' && row.to ? { to: row.to.replace(/^@/, '') } : {}) });
// The mark of the question an answer of that bot was written for (questionMark in lib/orchestrator-actions.mjs).
const QUESTION_MARK = /^[0-9a-f]{16}$/;
export const QUESTION_CHANGED = 'The question changed before the answer arrived, so it was not given.';
// Whether a bot oversees now, by its name. unreadable: the answer when the bots file cannot be
// read. Who may write to it takes that for yes; who makes an edit for no, since the bot is read
// again where it is used (needBot), and that refuses, as it always did.
const overseesNow = (name, unreadable = false) => { try { return botOversees(getBot(name)); } catch { return unreadable; } };
// Why a message of that bot's to a session the owner set to Full access after it was written
// is not given: its turn would run with every tool on the bot's words.
export const FULL_UNASKED = name => `This session is in Full access now and you were not asked about this message from @${name}, so it was not given.`;
// The requests the conductor is starting now for that message of the bot's to that session
// (state starting: it calls ask just then, lib/conductor.mjs launch). One sent another way has none.
function startingNow(root, id, bot, text) {
  try { return pendingRequests(root).filter(row => row.state === 'starting' && String(row.continuationTaskId) === String(id) && row.overseer === bot && row.goal === text).map(row => row.id); }
  catch { return []; }
}
// Whether the owner himself said yes to each of them: the action log's line for that request
// (target.request) was allowed by him, not by the level (lib/orchestrator-actions.mjs act). The
// log is read under its own lock, so a line being written as the request starts is waited for.
// That module reads this one, so it is loaded here. A log that cannot be read says no.
async function ownerSaidYes(ids, bot) {
  if (!ids.length) return false;
  try {
    const { actionsFile, readActions } = await import('./orchestrator-actions.mjs'), release = waitLock({ state: path.dirname(actionsFile()) }, 'actions', 300);
    let rows; try { rows = readActions({ reads: false }); } finally { release(); }
    return ids.every(id => rows.some(row => ['session_message', 'session_answer'].includes(row.action) && row.decision === 'allow' && row.by === 'owner' && row.bot === bot && row.target?.request === id));
  } catch { return false; }
}
// The newest 80 entries, as the chat shows them; all, for a bot that reads the whole chat.
export function conversationEntries(repo, task, { all = false } = {}) {
  const messages = task.messages ?? [];
  // A message the owner wrote to a bot reads You → @name; the bot's reply is an entry of its own.
  // A turn the bot's schedule started reads Schedule → @name, so it is never taken for the owner's.
  // shadow: a shadow bot said it after the agent's turn, unasked; quiet: a note about its turn and not its answer, such as why it did not speak.
  // A teammate's message reads as their own words under their name; the sentence ELU
  // wrote for the model is kept as goal, for a bot that reads the chat as the model did.
  const theirs = row => { const words = row.from && !row.bot ? teammateText(row) : null; return words ? { text: words, goal: row.text } : { text: row.text }; };
  // loop: a line of the review loop about the agent's own answer to a review (Fixed 2), shown as the agent's.
  const agentRun = task.runs.findLast(run => run.role === 'lead');
  // model, effort: what wrote an entry, for its header (fable 5.2 med). A row from before they
  // were kept has neither, and its header reads as it did.
  const written = row => row.loop ? { role: speaker(agentRun ?? { role: 'lead' }, row.model ?? agentRun?.model), lead: true, loop: true, at: row.at, text: row.text, ...wroteIt(row.model ? row : ranOn(agentRun)) } : row.bot ? { role: `@${row.bot}`, bot: row.bot, at: row.at, text: row.text, ...(row.failed ? { failed: true } : {}), ...(row.shadow ? { shadow: true } : {}), ...(row.quiet ? { quiet: true } : {}), ...(row.whileWorking ? { whileWorking: true } : {}), ...(row.overseer ? overseerMark(row) : {}), ...wroteIt(row) }
    // What the model wrote in answer to a message its running turn took (lib/runner.mjs inboxFeed): a reply of its own, written while it worked.
    : row.whileWorking && row.lead ? { role: String(row.from ?? 'Model').split(WHILE_WORKING)[0] || 'Model', lead: true, whileWorking: true, at: row.at, text: row.text, ...wroteIt(row) }
    // What ELU sent the session by itself (lib/elu-sent.mjs): one line of ELU's, which a turn answers.
    // The same words from a teammate or another computer on the project are theirs, and read so.
    : sentByElu(row.text) && !row.from && !row.computer ? { role: 'ELU', at: row.at, text: eluLine(row.text), line: true, sent: true }
    // during: the owner sent it while a turn worked, and it went to that turn (lib/runner.mjs inboxFeed);
    // sentAt, answeredAt, carriedOn: when he sent it, and when that turn answered it or went on with no answer (readMarks).
    : row.to && !row.from ? { role: `${row.scheduled ? 'Schedule' : 'You'} → ${row.to}`, to: row.to.replace(/^@/, ''), at: row.at, text: row.text, ...(row.scheduled ? { scheduled: true } : {}), ...(row.during ? { during: true, ...readMarks(row) } : {}) }
    // A standup's rows (lib/standup.mjs): line is one line of its own, such as "@ana asks: standup";
    // update is an update, the asked session's own or one that came to a Standup. quick: a quick
    // answer of Auto model's (lib/runner.mjs runAutoAnswer), or ELU's line about one.
    : row.line || row.standup || row.update ? { role: row.from ?? 'Standup', at: row.at, text: row.move ? moveText(row.move) : row.text, ...(row.line ? { line: true } : { update: true }), ...(row.line && row.sent ? { sent: true } : {}), ...(row.failed || row.failedAnswer ? { failed: true } : {}), ...(row.aside ? { aside: true } : {}), ...(typeof row.quick === 'string' ? { quick: true } : {}), ...(row.goalTold !== undefined ? { told: true } : {}) }
    // What ELU sent in the owner's place to a session an earlier version's time limit had stopped (lib/carry-on.mjs): one line
    // of ELU's. sent: a turn answers it, as it answers a message, so the stopped turn's steps stay above it.
    : row.text === CAP_CARRY_TEXT && !row.from ? { role: 'ELU', at: row.at, text: CAP_CARRIED_LINE, line: true, sent: true }
    // computer: the one another computer sent, by its key; who typed it is said there by that computer's name.
    : { role: row.from ?? 'You', at: row.at, ...theirs(row), ...(row.asOwner && typeof row.via === 'string' ? { via: row.via } : {}), ...(row.during && !row.from ? { during: true, ...readMarks(row) } : {}), ...(!row.from && typeof row.computer === 'string' && /^[0-9a-f]{64}$/.test(row.computer) ? { computer: row.computer } : {}) };
  // The review loop's lines (task.loop): each bot's review, and the agent's answer to it.
  // A message answered beside a turn that still holds the record (lib/message-aside.mjs) shows from where it is kept.
  // beside: its turn still works, so the chat shows it under the working line, where it was typed.
  let beside = []; try { beside = asideWaiting(repo, task.id).filter(row => !messages.some(value => value.aside === row.aside)); } catch { beside = []; }
  // What the session's bots said of the pull requests it opened and of its change while a long
  // turn worked, kept beside its record (lib/pull-reviews.mjs), each tagged with what it reviewed.
  let pulls = []; try { pulls = pullEntries(repo, task.id); } catch { pulls = []; }
  const entries = [...(!messages.some(row => row.text === task.goal) ? [{ role: 'You', at: task.createdAt, text: task.goal }] : []), ...messages.map(written), ...beside.map(row => ({ ...written(row), beside: true })), ...(Array.isArray(task.loop) ? task.loop : []).map(written), ...pulls, ...agentLines(task), ...decisionLines(task)];
  // The jobs his stop or his archive ended (lib/jobs.mjs), and why ELU stopped starting the session by itself (lib/keep-going.mjs).
  try { for (const note of stoppedNotes(jobsDir(repo, task.id))) entries.push({ role: 'ELU', at: note.at, text: note.text }); } catch { /* Shown at the next look. */ }
  try { const stop = keepGoingStop(task, readKeepGoing(repo, task.id)); if (stop) entries.push({ role: 'ELU', at: stop.at, text: stop.text, line: true }); } catch { /* Shown at the next look. */ }
  // A shared bot that answers a teammate speaks where the lead would, under its own name.
  const peerBot = task.origin?.bot ? botKey(task.origin.bot) : null, asBot = (at, text, run) => ({ role: `@${task.origin.bot}`, bot: task.origin.bot, at, text, ...wroteIt(ranOn(run)) });
  // Commands the owner ran with ! sit in the conversation where they happened.
  for (const row of memo(shellFile(repo, task.id), 'shell', () => shellRows(repo, task.id, Infinity)) ?? []) entries.push({ role: row.cwd && row.cwd !== repo.root ? 'Shell · editing workspace' : 'Shell', shell: true, at: row.at, text: shellText(row), forModel: shellForModel(row) });
  // What the owner answered a message another computer sent, in place of letting it run (lib/waiting-replies.mjs).
  for (const row of memo(replyFile(repo, task.id), 'replies', () => replyRows(repo, task.id)) ?? []) entries.push({ role: `You → ${row.who}`, reply: true, at: row.at, text: row.text });
  // Each lead run's log is read for what it said: Claude Code's and Codex's result, and the
  // JSON a Grok Build or Antigravity run's text ends with, headless or over ACP. When the
  // newest lead run's log gave no reply, its reply is the task's own, added below unless already shown.
  // A standup's answer turn (lib/standup.mjs) shows as the standup's question and answer rows.
  const last = task.runs.findLast(run => (run.role === 'lead' || run.role === peerBot) && !run.standup);
  let lastSaid = false;
  // What a run wrote while it worked is in the chat already (whileWorking). A Codex turn that
  // ended with no reply after it, as one that failed, is not given that text as its reply too.
  const onTheWay = (run, text) => messages.some(row => row.whileWorking && row.text === text && !(Date.parse(row.at) < Date.parse(run.startedAt)) && !(Date.parse(row.at) > Date.parse(run.at)));
  // A try the vendor turned away as overloaded, tried again after it (lib/runner.mjs), said nothing of the turn's.
  for (const run of task.runs.filter(run => (run.role === 'lead' || run.role === peerBot) && !run.standup && !run.overloaded)) {
    if (path.dirname(run.logFile) !== taskDir(repo, task.id)) continue;
    // A run that took a message after its turn's last step replied twice (lib/adapters/claude.mjs
    // replies): each reply shows, in the order written.
    const reply = memo(run.logFile, 'reply', () => {
      // plain: the last message of a Codex turn that is not its JSON reply, read as what it said.
      let summary, model, said = '', plain = false; const earlier = [];
      const tail = readTail(run.logFile);
      for (const line of tail.split('\n')) {
        try {
          const row = JSON.parse(line);
          if (row.type === 'system' && row.subtype === 'init' && typeof row.model === 'string') model = row.model;
          if (row.type === 'result') {
            if (summary) earlier.push(summary);
            summary = row.structured_output?.summary;
            if (!summary && typeof row.result === 'string') { try { summary = JSON.parse(row.result).summary; } catch { summary = row.result; } }
          }
          // A headless Antigravity run's last line holds its result (agy 1.5.13, stream-json).
          if (row.event === 'result' && typeof row.result?.structured_output?.summary === 'string' && row.result.structured_output.summary) { if (summary) earlier.push(summary); summary = row.result.structured_output.summary; }
          if (row.type === 'item.completed' && row.item?.type === 'agent_message') { try { summary = JSON.parse(row.item.text).summary; plain = false; } catch { summary = row.item.text; plain = true; } }
          // Grok Build's one result, the text a streamed run printed in chunks, or an ACP run's message chunks.
          const chunk = row.method === 'session/update' && row.params?.update?.sessionUpdate === 'agent_message_chunk' ? row.params.update.content?.text : row.type === 'text' ? row.data : null;
          if (typeof row.text === 'string' && typeof row.stopReason === 'string') said = row.text; else if (typeof chunk === 'string') said += chunk;
        } catch { /* A partial stream remains visible through the running status. */ }
      }
      // A headless Antigravity run prints one object over several lines, which no single line reads.
      if (!summary && ['grok', 'agy'].includes(run.vendor)) { const row = ADAPTERS.agy.extractJson(said || tail), value = row?.structured_output ?? row?.structuredOutput ?? row; if (typeof value?.summary === 'string' && value.summary) summary = value.summary; }
      return { summary: summary ?? null, model: model ?? null, earlier, plain };
    });
    if (reply?.summary && !(reply.plain && onTheWay(run, reply.summary))) { lastSaid ||= run === last; const ran = { ...ranOn(run), ...(!run.model && reply.model ? { model: reply.model } : {}) }; for (const text of [...(reply.earlier ?? []), reply.summary]) entries.push(run.role === 'lead' ? { role: speaker(run, run.model ?? reply.model), lead: true, at: run.at, text, ...wroteIt(ran) } : asBot(run.at, text, ran)); }
  }
  // A quick answer's run (lib/runner.mjs runAutoAnswer) is no turn whose reply this is.
  const text = (task.reply ?? task.result)?.summary, at = task.runs.findLast(run => run.role !== 'quick')?.at ?? task.createdAt, said = entries.filter(row => row.lead && !row.loop && !row.whileWorking || peerBot && row.bot);
  if ((!said.length || last && !lastSaid && !said.some(row => row.text === text)) && text && !(task.reply ?? task.result).bot) entries.push(peerBot && last?.role === peerBot ? asBot(at, text, last) : { role: speaker(last ?? { role: 'lead' }, last?.model), lead: true, at, text, ...wroteIt(ranOn(last)) });
  const sorted = entries.sort((a, b) => Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0));
  return all ? sorted : sorted.slice(-80);
}
// An archived session as the lessons run before a clean-up reads it (lib/runner.mjs
// runArchiveLearn): the owner's messages, and the replies and results of its agent and bots,
// oldest first, each whole. A teammate's message, a command's output and ELU's own lines are
// left out, and so is the first message of a session a teammate or another program started.
// Such a session works on those words, so only the owner's own messages in it are read: none
// of what its agent or bots said there. One another computer on the project started here
// (origin.mine) is a member's too, whoever owns that computer.
// A session a teammate's message started also goes under a plain name (THEIRS), since its title
// is their first words or the name its model or its Task gave it from them, and the lines ELU
// sent there in the owner's place without what they quote (unquoted). One the owner started
// here keeps its title. r in ELU up to 0.1.25 sent one of ELU's
// own lines again as his message (lib/terminal.mjs retry), and such a line can quote commands
// and a branch made from their words: there, a copy of one is ELU's line, left out like it.
export function archivedRecord(repo, task) {
  // The chat of the bot that oversees his sessions holds what it read of every session here, and
  // lessons go to his other computers and his teammates: that chat teaches none, and neither
  // does a reply of that bot's in another session.
  if (typeof task.botChat === 'string' && everOversaw(task.botChat)) return { session: taskTitle(task), messages: [] };
  const origin = task.origin, ownComputer = () => false;
  const owned = !origin;
  const theirs = Boolean(origin);
  const said = row => typeof row.text === 'string' ? row.text.trim() : '';
  const eluLines = new Set(theirs ? (task.messages ?? []).filter(row => row.from && !row.peer && !row.origin?.peer && !row.bot).map(said).filter(Boolean) : []);
  // A handed-off session's goal is ELU's sentence for the model: his words are in its messages.
  const rows = (task.messages ?? []).filter(row => !row.unapproved && !(theirs && !row.from && eluLines.has(said(row)))).map(row => owned && row.peer && ownComputer(row.peer) ? { at: row.at, text: teammateText(row) ?? row.text } : theirs && !row.from ? { ...row, text: unquoted(row.text) } : row);
  const entries = conversationEntries(repo, { ...task, goal: !origin ? task.goal : '', messages: rows }, { all: true });
  const messages = entries.flatMap(entry => {
    // One another computer sent is not this computer's owner's words.
    const owner = !entry.shell && !entry.lead && !entry.bot && entry.goal === undefined && !entry.computer && (entry.role === 'You' || /^You → /.test(entry.role ?? ''));
    const from = owner ? 'owner' : !owned ? null : entry.lead ? 'agent' : entry.bot && !everOversaw(entry.bot) ? `@${entry.bot} (bot)` : null, text = String(entry.text ?? '');
    return from && text.trim() ? [{ at: entry.at ?? null, from, text }] : [];
  });
  return { session: theirs ? THEIRS : taskTitle(task), messages };
}
const THEIRS = "A session a teammate's message started";
// The lines ELU sends in the owner's place that quote the session's own work: an approval
// names its Task (decideTask and the mode change in lib/terminal.mjs, lib/peer/remote.mjs,
// ProjectController.ask), and a mode that lifts what the turn stopped on names those steps
// (CONTINUE in lib/terminal.mjs). Read without the Task and the steps; anything else as it is.
const MODE_LABELS = Object.values(LABELS).map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const QUOTES = [
  [new RegExp(`^(Approved|(?:${MODE_LABELS}) approved) the Task: [\\s\\S]*$`), '$1 the Task.'],
  [new RegExp(`^(Continue where you stopped: this session now has (?:${MODE_LABELS}))\\. Try again only this: [\\s\\S]*$`), '$1.'],
];
const unquoted = text => typeof text === 'string' ? QUOTES.reduce((value, [line, plain]) => value.replace(line, plain), text) : text;
// What the owner taught in these archived sessions, saved to the project's context before they
// go, as a turn saves it: one read-only run on the project's model, whose cost shows in Usage
// under its own name. Returns the lines saying what was saved. Throws when the run, or the
// save, did not work: then nothing may be deleted.
export async function learnArchived(repo, ids, { signal, config = startConfig(repo.root) } = {}) {
  const records = ids.map(id => archivedRecord(repo, readTask(repo, String(id)))), title = `Lessons from ${ids.length} archived session${ids.length === 1 ? '' : 's'}`;
  const learned = await runArchiveLearn(repo, withModel(config, defaultModel(config)), records, { signal, kept: runs => { if (runs.length) keepRun(repo, takeRunId(repo), title, runs); } });
  // Stopped after its model had answered (a turn keeps such an answer): Esc still means nothing
  // is saved and nothing is deleted, as the line Esc shows says.
  if (signal?.aborted) refuse('Stopped before the lessons were saved.');
  const saved = saveLearned(repo.project ?? repo.root, learned);
  if (saved?.waiting) refuse("The lessons were not saved: the project's memory file changed and waits for your review. Open Projects and choose this project.");
  if (saved?.failed) refuse(`The lessons were not saved: ${saved.failed}`);
  return learnedLines(saved);
}
// The chat as a bot reads it when the owner writes to it: who wrote each entry, oldest
// first, every entry whole. ELU sets no limit of its own: the model says when it is too long.
// A note of the bot that oversees the sessions says so, so no bot reads it as the owner's.
function botChat(repo, task) {
  // The line about files the owner has not approved is for him, not for a bot.
  return conversationEntries(repo, { ...task, messages: (task.messages ?? []).filter(row => !row.unapproved) }, { all: true }).map(entry => ({ at: entry.at, from: entry.lead ? 'agent' : entry.shell ? 'owner (shell command)' : entry.scheduled ? `schedule of @${entry.to}` : entry.shadow ? `${entry.role} (shadow: its comment on the turn before, not a request)` : entry.overseer ? `${entry.role} (overseer: a note from the bot that oversees the owner's sessions${entry.to ? ` to @${entry.to}` : ''}, not the owner's words)` : entry.reply ? `${entry.role.replace(/^You/, 'owner')} (his answer to a message sent from there, in place of running it; not a request)` : entry.role.replace(/^You/, 'owner'), ...(entry.shell ? entry.forModel : { text: String(entry.goal ?? entry.text ?? '') }) }));
}
export { modelName };
// The model and effort a run wrote with: the model its vendor reported, else the one it was
// started with (asked), and its effort; only the ones that are known.
const ranOn = run => ({ model: run?.model ?? run?.asked ?? null, effort: run?.effort ?? null });
// When a message a running turn took was sent, and when that turn answered it or carried on
// with no answer (lib/runner.mjs inboxFeed), from a row or an entry: the ones that read as a time.
export function readMarks(row) {
  return Object.fromEntries(['sentAt', 'answeredAt', 'carriedOn'].filter(key => typeof row?.[key] === 'string' && Number.isFinite(Date.parse(row[key]))).map(key => [key, row[key]]));
}
// The model and effort fields of a chat entry, from a row or a run, when they read as text.
export function wroteIt(row) {
  const model = typeof row?.model === 'string' && row.model.trim() ? row.model.trim().slice(0, 80) : null, effort = typeof row?.effort === 'string' && /^[a-z]{1,12}$/.test(row.effort) ? row.effort : null;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
// A chat speaker: the model that wrote the reply, such as Fable 5.1. A run that named no
// model reads as its vendor.
export function speaker(run, model) {
  return modelName(model) ?? (run?.vendor ? vendorShort(run.vendor) : 'Model');
}
// The name a model is shown by before it answers, as its chat titles will name it: the full
// name a run reported for it when one is known (opus reads Opus 5.5), else the name it was
// chosen by, else its vendor. known: [{ vendor, model }] from earlier runs, oldest first. A
// name with a version of its own (claude-sonnet-5) is never named by another version's run.
export function modelLabel(choice, known = []) {
  const family = id => (modelName(id) ?? '').split(' ')[0].toLowerCase(), alias = !/\d/.test(modelName(choice.model) ?? '');
  const seen = known.findLast(row => row.vendor === choice.vendor && row.model && (!choice.model || row.model === choice.model || alias && family(row.model) === family(choice.model)));
  return modelName(seen?.model) ?? modelName(choice.model) ?? vendorShort(choice.vendor);
}
// The model a session's next turn starts on, { vendor, model }: the one in its own saved
// policy. A session pinned to a commit has none of its own and reads as its last run.
// turn: the model of the turn that works now instead, which one chosen meanwhile leaves as it is.
export function sessionModel(repo, task, { turn = false } = {}) {
  // A quick answer (Auto model, lib/runner.mjs runAutoAnswer) works on its fast model.
  if (turn && typeof task?.quickTurn?.vendor === 'string' && task.state === 'running') return { vendor: task.quickTurn.vendor, model: task.quickTurn.model ?? null };
  // One chosen while a turn ran starts with its next turn (lib/models.mjs nextModel).
  const waiting = turn ? null : nextModel(task); if (waiting && ownsPolicy(task)) return waiting;
  if (ownsPolicy(task)) {
    try {
      const file = path.join(stateDir(repo, task.id), 'policy.yaml'), saved = memo(file, 'model', () => configModel(parseConfig(fs.readFileSync(file, 'utf8'))));
      // Auto model (lib/auto-model.mjs) writes the model of each step into the policy before its
      // turn, so the policy names the model that works. A Standup's answer turn is the one that
      // runs on another: the work model (lib/runner.mjs workRole).
      if (saved && turn && autoOn(task) && task.standupTurn) { let work = null; try { work = classNames(saved.vendor).work; } catch { work = null; } if (work) return { vendor: saved.vendor, model: work }; }
      if (saved) return saved;
    }
    catch { /* An unreadable policy shows the last run instead. */ }
  }
  const last = (task.runs ?? []).findLast(run => run.role === 'lead');
  return last ? { vendor: last.vendor, model: null } : null;
}
// ---- Auto model (lib/auto-model.mjs): ELU picks the model of each step ----
// The step of a message the owner typed, from the session as it is when the message arrives:
// 'plan', 'edit', 'quick', or 'stay' for none. saved: the session, or null for a message that
// starts one. approved: the message is his approval of a Task. working: it goes on with work
// that stopped. toBot, toModel: it is written to a bot, or to @model.
function messageStep(repo, saved, text, { approved = false, working = false, toBot = false, toModel = false } = {}) {
  const rows = saved ? sessionTasks(repo, saved.id) : [], open = openTask(rows);
  // A quick question is asked for only where the text reads as one: looking for where it would go reads files.
  let quick = false;
  try { quick = Boolean(saved) && quickText(text) && routeFor('quick', { home: sessionModel(repo, saved, { turn: true })?.vendor ?? null, task: saved }) !== null; } catch { quick = false; }
  return stepOf(text, {
    first: !saved, approved, waiting: Boolean(waitingTask(rows)),
    // An edit that was approved and never began is starting; any other open Task's work goes on until its objectives are met.
    work: working ? 'stopped' : open?.edit?.intent === 'edit' && open.edit.started !== true ? 'starting' : open ? 'going' : null,
    met: open ? open.met.length : null, objectives: open ? open.objectives.length : null,
    asked: saved?.state === 'needs_input', toBot, toModel, idle: true,
    replied: Boolean(saved) && Boolean(saved.result || saved.reply || (saved.runs ?? []).some(run => run.role === 'lead')), quick,
  });
}
// The question a quick answer answered, when that answer is the newest row of the session's
// chat (an ELU line after it aside): what think asks the top model again. null otherwise.
// retry: the conductor starts that same think again (a stall, a failure), after the question
// it sent once: it is the question still.
function thinkAgain(task, { retry = false } = {}) {
  const rows = Array.isArray(task?.messages) ? task.messages : [], at = rows.findLastIndex(row => row.update && typeof row.quick === 'string');
  if (at < 0) return null;
  const asked = rows.findLast(row => row.quick === rows[at].quick && !row.from && !row.line), question = typeof asked?.text === 'string' && asked.text.trim() ? asked.text : null;
  const after = rows.slice(at + 1).filter(row => !row.line);
  return question && (!after.length || retry && after.length === 1 && !after[0].from && after[0].text === question) ? question : null;
}
// Puts a session with Auto model on the model of a step, before the turn that reads its saved
// policy, and returns the session as it reads after; null when Auto model is off there.
// step: 'plan' or 'edit'. limited: one model's own weekly limit stopped the turn this message
// starts again from ({ model, until, step }, lib/conductor.mjs): the step is that turn's, or
// the one the model it ran on stands for, and that model counts as at its limit until then
// whatever is read of it. An edit a bot makes on its own model is no step, and never comes here.
// The policy is written with the session's lock held, the way a model chosen during a turn is
// taken (nextModel, takeNextModel), and what waits there is taken first: a model of the owner's
// own, with which Auto model is off. The effort Auto model runs with is written with the route
// (autoEffort), and the one line for a route that took the other model is written once a limit.
async function routeSession(repo, id, step, { limited = null } = {}) {
  const first = readTask(repo, id); if (!autoOn(first)) return null;
  // Codex's models are read from its own program, once, where nothing kept names them yet.
  if (sessionModel(repo, first, { turn: true })?.vendor === 'codex' && homeProblem('codex')) { try { await readBotModels('codex'); } catch { /* Said below. */ } }
  let release = null;
  // A setting the owner changes holds the session for a moment.
  for (let tries = 0; !release; tries++) {
    try { release = lock(repo, `task-${id}`); }
    catch (error) { if (tries >= 30 || !error.message.includes('holds this lock')) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  try {
    const task = readTask(repo, id);
    takeNextModel(repo, task);
    if (!autoOn(task) || !ownsPolicy(task) || isPeerRun(task.origin)) return task;
    const lead = pinnedConfig(repo, task.base, { current: false, task }).config.roles.lead, home = lead.vendor, at = () => new Date().toISOString();
    // A vendor with no top and work model here cannot have it on: it goes off, and the chat says why.
    const problem = homeProblem(home);
    if (problem) { delete task.auto; delete task.autoEffort; (task.messages ??= []).push({ at: at(), text: AUTO_LINES.offAfter(problem), from: 'ELU', line: true }); saveTask(repo, task); return task; }
    const stopped = limited && typeof limited.model === 'string' ? limited : null, now = Date.now();
    const pick = ['plan', 'edit'].includes(step) ? step : stopped ? lead.model && lead.model === classNames(home).work ? 'edit' : 'plan' : null;
    if (!pick) return task;
    const free = stopped ? model => familyOf(model) === stopped.model && !(Number.isFinite(stopped.until) && stopped.until <= now) ? { free: false, until: stopped.until ?? null } : home === 'claude' ? claudeModelFree(model, { now }) : { free: true } : null;
    const route = routeFor(pick, { home, task, now, ...(free ? { free } : {}) });
    if (!route) return task;
    const was = JSON.stringify([task.autoEffort ?? null, task.autoSaid ?? null]);
    if ((lead.model ?? null) !== (route.model ?? null)) { task.nextModel = { vendor: route.vendor, ...(route.model ? { model: route.model } : {}) }; takeNextModel(repo, task); }
    if (route.effort) task.autoEffort = route.effort; else delete task.autoEffort;
    const key = insteadKey(route), line = key && sayOnce(task, key, { until: route.instead.until, now }) ? insteadLine(route, { now }) : null;
    if (line) (task.messages ??= []).push({ at: at(), text: line, from: 'ELU', line: true });
    if (line || JSON.stringify([task.autoEffort ?? null, task.autoSaid ?? null]) !== was) saveTask(repo, task);
    return task;
  } finally { release(); }
}
// The model chosen while a session's turn works, where it is another than that turn's: it
// starts with the next turn, and so does a message sent with it. null otherwise.
export function modelWaiting(repo, task) {
  const next = ownsPolicy(task) ? nextModel(task) : null, turn = next ? sessionModel(repo, task, { turn: true }) : null;
  return next && !(turn && turn.vendor === next.vendor && (turn.model ?? null) === (next.model ?? null)) ? next : null;
}
// The models the runs of these sessions reported, oldest first, for modelLabel.
export function reportedModels(tasks) {
  return tasks.flatMap(task => (task.runs ?? []).filter(run => run.role === 'lead' && run.model)).sort((a, b) => String(a.at).localeCompare(String(b.at))).map(run => ({ vendor: run.vendor, model: run.model }));
}

export function setupCommitPlan(repo) {
  const manifest = readJson(path.join(repo.state, 'manifest.json'));
  const allowed = ['.elu-code/config.yaml', ...(manifest.files ?? []).map(file => file.path).filter(file => ['AGENTS.md', 'CLAUDE.md'].includes(file))];
  const staged = git(repo.root, ['diff', '--cached', '--name-only', '-z']).stdout.split('\0').filter(Boolean);
  if (staged.some(file => !allowed.includes(file))) refuse('Other files are staged. Save that work before committing the project setup.');
  const base = head(repo.root);
  const files = allowed.flatMap(file => {
    const full = path.join(repo.root, file); noSymlinks(full);
    const before = baseFile(repo.root, base, file, { optional: true });
    const content = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    return before === content ? [] : [{ file, content }];
  });
  parseConfig(fs.readFileSync(path.join(repo.root, '.elu-code/config.yaml'), 'utf8'));
  return { base, files, digest: hash(JSON.stringify(files)), branch: git(repo.root, ['branch', '--show-current']).stdout.trim(), diff: files.map(({ file, content }) => `${file}\n${content ?? '(deleted)'}`).join('\n\n') };
}
export function commitSetup(repo, approved) {
  const current = setupCommitPlan(repo);
  if (current.base !== approved.base || current.digest !== approved.digest) refuse('The setup changed after the preview. Review it again.');
  if (!current.files.length) return 'The project setup is already committed.';
  const release = lock(repo);
  try {
    prepareGit(repo, repo.root, ['add', '--', ...current.files.map(file => file.file)]);
    git(repo.root, ['-c', `core.hooksPath=${path.join(repo.state, 'empty-hooks')}`, 'commit', '-m', 'Configure ELU']);
    return 'Project setup committed. Start a session to begin a task.';
  } finally { release(); }
}

// ---- A session's controls, for the Orchestrator at Full (lib/orchestrator-seams.mjs) ----
// What its session tools change in a session of this computer (lib/orchestrator-actions.mjs
// session_settings, session_rename, session_archive, session_log), and what the host changes for
// a request from one of the owner's own computers (lib/peer/remote.mjs elu.remote.settings and
// elu.remote.log). Each goes through the code the owner's own commands use, and says what it did
// in one line for the chat. Who may ask is the caller's to decide: here only a teammate's
// question (isPeerRun) keeps what it started with, as it does for the owner.
const SESSION_ID = /^[1-9][0-9]{0,9}$/;
function sessionOf(repo, id) {
  const key = String(id ?? '');
  if (!SESSION_ID.test(key)) refuse('Name the session by its number.');
  try { return readTask(repo, key); } catch { return refuse(`No session ${key} in ${projectName(repo.root)}.`); }
}
const BOT_WORD = /^@?[a-z][a-z0-9-]{0,31}$/;
const botWords = (value, what) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || !BOT_WORD.test(name.trim().toLowerCase()))) refuse(`Bots to ${what} are a list of bot names.`);
  return value.map(name => name.trim().toLowerCase().replace(/^@/, ''));
};
const choiceName = choice => modelName(choice?.model) ?? vendorShort(choice?.vendor);
const sentence = text => text ? (/[.!?]$/.test(text) ? text : `${text}.`) : null;
// A model and effort as asked ({ vendor, model, effort }), checked before anything is saved.
// An effort left out keeps the one the agent has where the new model takes it; null is the
// vendor's own.
function askedModel(given, before, what) {
  if (!isObject(given)) refuse(`${what} is { vendor, model, effort }.`);
  const { vendor, model } = checkModel(given), takes = modelEfforts(vendor, model);
  const effort = given.effort === undefined ? (takes.includes(before?.effort) ? before.effort : null) : given.effort;
  if (effort !== null && !takes.includes(effort)) refuse(effortProblem(vendor, model));
  return { vendor, model, effort };
}
// The chat's line for one agent's change, or null when nothing changes.
function changedLine(who, from, to, later) {
  const model = (from.vendor !== to.vendor || (from.model ?? null) !== (to.model ?? null)) ? [choiceName(from), choiceName(to)] : null;
  const effort = (from.effort ?? null) !== (to.effort ?? null) ? [from.effort ?? 'its own', to.effort ?? 'its own'] : null;
  return model || effort ? changeLine({ who, model, effort, later }) : null;
}
// access: ask, auto or full. model: the session's model and effort. bots: { add, remove }, by
// name. botModels: { <bot>: { vendor, model, effort } }, for bots in the session once bots is
// applied. Every part is checked before any is saved. Returns { task, lines, line }.
export function applySessionSettings(repo, id, parts = {}) {
  if (!isObject(parts)) refuse(`A session's settings are ${SETTINGS_PARTS.join(', ')}.`);
  const unknown = Object.keys(parts).find(name => parts[name] !== undefined && !SETTINGS_PARTS.includes(name));
  if (unknown) refuse(`There is no setting ${unknown.slice(0, 40)}. A session's settings are ${SETTINGS_PARTS.join(', ')}.`);
  const task = sessionOf(repo, id), key = task.id;
  if (isPeerRun(task.origin)) refuse("A teammate's question keeps the settings it started with.");
  const access = parts.access === undefined ? null : checkMode(parts.access);
  let bots = null;
  if (parts.bots !== undefined) {
    if (!isObject(parts.bots)) refuse('Bots are { add, remove }, each a list of bot names.');
    const add = botWords(parts.bots.add, 'add'), remove = botWords(parts.bots.remove, 'remove'), now = sessionBots(task);
    bots = chatBots([...now.filter(name => !remove.includes(name)), ...add.filter(name => !now.includes(name))]);
  }
  const lead = sessionModel(repo, task), before = lead ? { ...lead, effort: leadEffort(task, lead.vendor) } : null;
  const model = parts.model === undefined ? null : askedModel(parts.model, before, 'A model');
  const inChat = bots ?? sessionBots(task), botModels = [];
  if (parts.botModels !== undefined) {
    if (!isObject(parts.botModels)) refuse('Bot models are { <bot>: { vendor, model, effort } }.');
    for (const [name, given] of Object.entries(parts.botModels)) {
      if (!inChat.includes(name)) refuse(`@${String(name).slice(0, 32)} is not in this session.`);
      const now = sessionBot(task, needBot(name)), to = askedModel(given, now, `The model of @${name}`), problem = botModelProblem(to.vendor, to.model);
      if (problem) refuse(problem);
      botModels.push({ name, from: { vendor: now.vendor, model: now.model ?? null, effort: now.effort ?? null }, to });
    }
  }
  const lines = [];
  if (access) {
    const was = task.permissions;
    savePermissions(repo, key, access);
    lines.push(was === access ? `${LABELS[access]} already.` : `${LABELS[access]} from its next turn.`);
  }
  if (bots) { saveBots(repo, key, bots); lines.push(bots.length ? `Bots: ${bots.map(name => `@${name}`).join(', ')}.` : 'No bots.'); }
  if (model) {
    const from = before ?? { vendor: model.vendor, model: null, effort: null };
    const { line } = changeAgent(repo, key, { bot: null, to: model, line: later => changedLine('this session', from, model, later) });
    lines.push(sentence(line) ?? `Already on ${choiceName(model)}${model.effort ? ` at ${model.effort}` : ''}.`);
  }
  for (const { name, from, to } of botModels) {
    const { line } = changeAgent(repo, key, { bot: name, to, line: later => changedLine(`@${name}`, from, to, later) });
    lines.push(sentence(line) ?? `@${name} is on ${choiceName(to)}${to.effort ? ` at ${to.effort}` : ''} already.`);
  }
  return { task: readTask(repo, key), lines, line: lines.join(' ') || 'Nothing to change.' };
}
// The owner's name for a session; an empty one gives back ELU's own. Returns { task, line }.
export function renameSession(repo, id, title) {
  const task = sessionOf(repo, id);
  if (title != null && typeof title !== 'string') refuse('A session name is text.');
  const saved = setTitle(repo, task.id, title ?? '');
  return { task: saved, line: saved.titleBy === 'owner' ? `Renamed session ${task.id} to "${saved.title}".` : `Session ${task.id} is named "${taskTitle(saved)}" again.` };
}
// Archives a session, or brings one back, as elu sessions archive and unarchive do: a session at
// work is archived when its turn ends. Nothing is deleted. Returns { id, line, archived?, archiving? }.
export async function archiveSession(repo, id, { unarchive = false } = {}) {
  const task = sessionOf(repo, id), { sessionsCli } = await import('./session-commands.mjs');
  const out = await sessionsCli([unarchive ? 'unarchive' : 'archive', task.id], { repo, session: null });
  return { ...out, line: out.message };
}
// The last rows of a session's log: the turn at work for that role, else its last one. Each row
// is a step of lib/run-activity.mjs (a thought, a tool call and how it ended, its plan, the text
// it wrote on the way), its text one line at most LOG_TEXT_MAX long with secrets masked.
// role: lead, or bot:<name>. Returns { session, role, live, at, vendor, total, rows, line }.
const LOG_TEXT_MAX = 500;
function masked(value) {
  let text = redact(String(value ?? '').replace(/\s+/g, ' ').trim(), LOG_TEXT_MAX * 4);
  for (const found of scanSecrets(text).reverse()) text = `${text.slice(0, found.index)}${text.slice(found.index).replace(/^\S+/, '[redacted]')}`;
  return text.length > LOG_TEXT_MAX ? `${text.slice(0, LOG_TEXT_MAX - 1)}…` : text;
}
const PLAN_MARK = { done: '[x]', doing: '[>]', todo: '[ ]' };
function tailRow(step) {
  const text = step.kind === 'plan' ? (step.entries ?? []).map(entry => `${PLAN_MARK[entry.state] ?? '[ ]'} ${entry.text}`).join('; ') : step.text || (step.tokens ? `${step.tokens} tokens` : '');
  return { kind: step.kind, text: masked(text), ...(step.status ? { status: step.status } : {}), ...(step.note ? { note: masked(step.note) } : {}), ...(Number.isFinite(step.seconds) ? { seconds: step.seconds } : {}), ...(step.sub ? { sub: true } : {}) };
}
export function sessionLogTail(repo, id, { rows = LOG_ROWS_DEFAULT, role = 'lead' } = {}) {
  const task = sessionOf(repo, id), dir = taskDir(repo, task.id), bot = botOfKey(role);
  if (rows !== undefined && rows !== null && !(Number.isInteger(rows) && rows >= 1 && rows <= LOG_ROWS_MAX)) refuse(`Rows are a whole number from 1 to ${LOG_ROWS_MAX}.`);
  if (role !== 'lead' && !(bot && BOT_WORD.test(bot))) refuse('A role is lead or bot:<name>.');
  const count = rows ?? LOG_ROWS_DEFAULT, own = file => typeof file === 'string' && path.dirname(file) === dir, who = bot ? `@${bot}` : 'The model';
  const live = ['running', 'preparing'].includes(task.state) && own(task.activeLog) && (task.activeRole ?? 'lead') === role;
  const run = live ? null : (task.runs ?? []).findLast(row => row.role === role && own(row.logFile) && !row.standup) ?? null;
  const file = live ? task.activeLog : run?.logFile ?? null;
  if (!file) return { session: task.id, role, live: false, at: null, vendor: null, total: 0, rows: [], line: `${who} has no turn in session ${task.id} yet.` };
  const steps = runSteps(file, { cwd: task.worktree }), out = steps.slice(-count).map(tailRow);
  const turn = live ? 'the turn at work' : 'its last turn';
  return { session: task.id, role, live, at: live ? task.activeSince ?? null : run.at ?? null, vendor: live ? null : run.vendor ?? null, total: steps.length, rows: out,
    line: steps.length ? `The last ${out.length} of ${steps.length} steps of ${turn}${bot ? ` of @${bot}` : ''} in session ${task.id}.` : `${who} took no steps in ${turn} of session ${task.id}.` };
}

// This controller owns only the tasks started by this view. Dashboard has no controller.
// Checking and publishing need the session to themselves. A turn holds it while it runs, and
// then the answer is to wait for the reply, in place of the lock's own line.
function publishLock(repo, id) {
  try { return lock(repo, `task-${id}`); }
  catch (error) {
    if (!error.message.includes('holds this lock')) throw error;
    let state = null; try { state = readTask(repo, id).state; } catch { /* The lock's own line stands. */ }
    if (['running', 'preparing'].includes(state)) refuse('Wait for the reply, or /stop, then publish.');
    throw error;
  }
}
// The lead's reply says it sent or asked one of the session's bots, and nothing asked it (no
// elu sessions ask waits for it): the chat says so at once, in a line of ELU's, so neither the
// owner nor the lead's next turn takes it as asked. Returns the session as saved, or null.
const CLAIM = name => new RegExp(`\\b(?:sent|send|sending|asked|asking|forwarded|passed|handed|pinged|notified|messaged|routed|shared)\\b[^.\\n]{0,80}@${name}\\b|@${name}\\b[^.\\n]{0,40}\\b(?:was|has been|have been|got|is)\\s+(?:asked|sent|notified|pinged|told|reviewing)`, 'i');
export const NOT_ASKED = name => `@${name} was not asked: nothing reached it. The lead asks it with elu sessions ask ${name}, or you write @${name} here.`;
export function unaskedBots(repo, task) {
  const names = sessionBots(task), said = task?.reply ?? task?.result, text = [said?.summary, said?.question].filter(value => typeof value === 'string').join('\n');
  if (!names.length || !text) return null;
  const waiting = pendingRequests(repo.project ?? repo.root).filter(row => String(row.continuationTaskId) === String(task.id) && leadAsked(row.goal));
  const unasked = names.filter(name => CLAIM(name).test(text) && !waiting.some(row => row.bot === name));
  if (!unasked.length) return null;
  const now = readTask(repo, task.id);
  (now.messages ??= []).push(...unasked.map(name => ({ at: new Date().toISOString(), from: 'ELU', text: NOT_ASKED(name), line: true })));
  saveTask(repo, now);
  return readTask(repo, task.id);
}
// A bot the session's lead asked (elu sessions ask) answered: its answer goes to the lead's next
// turn, as a message of ELU's (lib/elu-sent.mjs leadBackText). One that failed says so instead,
// so the lead never waits on an answer that will not come.
async function leadBack(repo, id, name, value) {
  const rows = Array.isArray(value?.messages) ? value.messages : [], said = rows.findLast(row => row?.bot === name && typeof row.text === 'string' && !row.quiet);
  const answer = said && !said.failed ? said.text : `@${name} did not answer: ${value?.error?.message ?? 'its turn failed'}.`;
  try { const { enqueue } = await import('./conductor.mjs'); enqueue(repo.project ?? repo.root, leadBackText(name, answer), { continuationTaskId: String(id), priority: 0, byElu: true }); } catch { /* The owner sees the bot's answer in the chat. */ }
}
export class ProjectController {
  // A view-only window (another window has the project) first tries to take the project over
  // (takeOver, also read as reclaim: true when it did), and otherwise says which window makes
  // the changes (readOnlyText).
  constructor(repo, { readOnly = false, onRepository, reclaim = null, takeOver = reclaim, readOnlyText = null } = {}) {
    this.repo = repo; this.readOnly = readOnly; this.onRepository = onRepository; this.takeOver = takeOver; this.reclaim = takeOver; this.readOnlyText = readOnlyText; this.running = new Map(); this.asides = new Map(); this.conversations = new Map(); this.usageAbort = new AbortController();
    this.draftConfig = startConfig(repo.root); this.fromApproved = trustedText(repo.root, 'config.yaml') != null;
  }
  snapshot() { const value = projectSnapshot(this.repo); return value.initialized ? value : { ...value, roles: this.draftConfig.roles }; }
  // A long-lived owner picks up agent changes saved by any terminal. A settings file that
  // changed is not used until the owner approves it: the settings he approved stay. Once he
  // goes without them, the draft starts over from the defaults. With no file and none
  // approved the draft stays.
  reloadConfig() {
    const approved = trustedText(this.repo.root, 'config.yaml') != null;
    if (approved || this.fromApproved || fs.existsSync(path.join(this.repo.root, '.elu-code/config.yaml'))) this.draftConfig = startConfig(this.repo.root);
    this.fromApproved = approved;
  }
  writable() { if (this.readOnly && !this.takeOver?.()) refuse(this.readOnlyText?.() ?? VIEW_ONLY); }
  // A session's edit runs in the repository the lead chose; its records stay here.
  taskRepo(task) {
    if (!task?.repository || task.repository === this.repo.root) return this.repo;
    const found = findRepository(task.repository);
    if (!found || found.root !== task.repository) refuse('The repository this session edits has moved or is gone.');
    return { ...found, state: this.repo.state, project: this.repo.root };
  }
  // The repository the lead named, from the project folder or your home. null means the
  // project folder itself, which starts its own history.
  // folders: the session's extra folders; a repository in one may be edited too.
  editTarget(named, folders = []) {
    const root = this.repo.root, home = fs.realpathSync(os.homedir()), value = typeof named === 'string' && named.trim() ? named.trim() : '.';
    const folder = path.resolve(root, value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value);
    const real = fs.existsSync(folder) && fs.statSync(folder).isDirectory() ? fs.realpathSync(folder) : null;
    if (!real || !within(home, real) && !within(root, real) && !folders.some(dir => within(dir, real))) refuse(`The model chose ${value}, which is not a folder in your home. Tell it which repository to change.`);
    const found = findRepository(real);
    if (found) return found.root === root ? this.repo : { ...found, state: this.repo.state, project: root };
    if (real !== root) refuse(`${value} is not a Git repository. Tell the model which repository to change.`);
    if (root === home) refuse('Tell the model which repository to change. Your home folder never becomes a repository.');
    return null;
  }
  historyPlan() { this.writable(); return historyPlan(this.repo); }
  createHistory(plan) { this.writable(); const next = createHistory(plan); this.adoptRepository(next); return next; }
  setChecks(command) { this.writable(); const next = structuredClone(this.draftConfig); next.checks = [{ name: 'tests', command }]; validateConfig(next); this.draftConfig = next; }
  async setupPlan() { this.writable(); return initPlan(this.repo, this.draftConfig); }
  setup(plan) { this.writable(); const result = applyInit(this.repo, plan); registerProject(this.repo); return result; }
  async vendors() { this.writable(); return detect(this.repo.root); }
  servers() { const all = Object.keys(claudeServers(this.repo.root)), off = this.draftConfig.mcpOff ?? []; return { all, on: all.filter(name => !off.includes(name)) }; }
  setServer(name, on) {
    this.writable(); this.draftConfig = setServer(this.repo, name, on, this.draftConfig);
    return on ? `${name} is on. The model can use its tools from your next message.` : `${name} is off for this project. /mcp on ${name} turns it back on.`;
  }
  queue(goal, id, update) { this.writable(); return saveRequest(this.repo.root, goal, id, update); }
  cancelRequest(id) { this.writable(); removeRequest(this.repo.root, id); }
  // A teammate's ask or review never escalates to editing and may continue only its own
  // conversation; an accepted handoff becomes the owner's normal task. permissions, place
  // and folders are the owner's session choices; a follow-up without them
  // inherits the task's, and one with a mode switches the task from this turn.
  // bots: the bots in the chat, set like the other session choices. bot: the bot this message
  // is written to; it answers in one read-only turn and the lead does not run. A teammate's
  // request names a shared bot in origin.bot instead, and that bot answers it.
  // model: the model the session runs on, { vendor, model }. A new session without one
  // starts with the project's default; a follow-up with one switches from this turn.
  // A bot that has a schedule works instead: its turn may end in an edit, which then takes
  // the path the model's edit takes, with the bot doing the work. scheduled: the bot's own
  // schedule wrote the message. botChat: a new session becomes that bot's own chat.
  // timed: a /schedule job wrote the message, so the owner is not at this turn. schedule: that
  // schedule's id, which the new session keeps (createConversation), and title: the name the
  // owner gave its latest run, which this run takes.
  // A turn that changes no files is followed by the session's shadow bots (runShadows), once
  // each, when the owner wrote the message to the model or to a bot that works. Their
  // turns are part of this message: the next one waits for them as it waits for a review.
  // approved: the owner approved the session's Task (lib/plan.mjs), with the key or by typing
  // a plain yes (saysYes). Its editing turn starts at once, by the model or the bot that
  // proposed it, with no second planning turn. An approval typed in other words is read by the
  // turn that answers it (settleReply returns approved), and the work starts the same way after
  // that reply. An editing turn starts in no other way than for an approved Task; in his own
  // session with Approve for me or Full access the mode approves it, so nothing waits.
  // mine: the owner's other computer started this new session (lib/peer/remote.mjs); it is marked so on its record.
  // home: the owner let this new teammate's session run in his home folder (HOME_QUESTION).
  // helps: this new session of the owner's helps one on his other computer (lib/remote-helper.mjs).
  // A message of the owner's to a session whose approved Task stopped on a question, a block
  // or his stop continues that work (continueTask): the Task's edit access, in the session's
  // mode now. When that work cannot start again (continueReady refuses), the message gets a
  // read-only answer that says why. A session whose Task is done answers in a read-only turn.
  // again: the conductor starts this same message again after its run stalled or was rate
  // limited. The chat has it already, so work it carries on keeps it once.
  // copied: the Task this new session of the owner's starts with, from his check of another
  // (lib/owner-check.mjs): it is recorded as his and approved before the first turn, so that
  // turn goes on with its work.
  // Auto model (lib/auto-model.mjs). ownerWords: the request is the owner's own words, typed here
  // just now (ownerWords there, given by the conductor): only such a message picks a step, and
  // the session is put on that step's model before its turn. Any other turn runs on the model
  // the session ran last. auto: a new session begins with Auto model. limited: this message
  // starts again after one model's own weekly limit stopped its turn ({ model, until, step }):
  // it goes on with the session's other model, the one change of model nobody typed.
  // overseer: the bot that oversees the owner's sessions wrote this message (lib/conductor.mjs
  // enqueue), never he. It shows under that bot's name with its mark, approves no Task (not with
  // yes, not in his mode: a Task proposed in answer waits for him), teaches nothing, starts no
  // shadow bot, and every turn it leads to is told the note is the bot's. A note to a session
  // whose Task stopped on a question carries on that work as his answer would, under the bot's
  // name. With no id it starts the bot's own new session: its record says the bot started it
  // and keeps budgetUsd, the dollar limit it was started with. asks: the bot's answer to the
  // question the session asked when it wrote it (questionMark in lib/orchestrator-actions.mjs):
  // it goes in only while the session still asks that question, and only it carries the Task's
  // work on; a plain note is answered, and the work waits for him. Nothing of the bot's goes to a
  // session the owner archived or moved to Done since it was queued, nor to one he set to Full
  // access since, unless he said yes to it himself.
  // asOwner: { bot, computer }, the owner's word that bot sent for him into this session
  // (lib/conductor.mjs enqueue). While it holds (lib/runner.mjs ownerWord: a session of his, sent
  // by that bot at Full here, or from one of his own computers) it is his own message, with its
  // mark, and every turn it leads to runs inside answeringAsOwner: "yes" in it approves a
  // waiting Task, and an approval with it is his. One that does not hold goes as that bot's
  // note, under the rules above; with no bot that oversees here, nothing goes.
  // title, botModels and the effort inside model: what a Full start of that bot, or a start
  // from one of his own computers, picked for the new session (createConversation).
  ask(text, id, { readOnly = false, origin = null, context = null, permissions, place, folders, bots, bot = null, model, scheduled = false, botChat: ownChat = false, timed = false, schedule = null, title = null, approved = false, again = false, mine = null, computer = null, home = false, helps = null, standup = null, standupFor = null, beside = false, copied = null, toModel = false, ownerWords = false, auto = false, limited = null, overseer = null, budgetUsd = null, asks = null, parent = null, asOwner = null, botModels = null } = {}) {
    this.writable();
    if (standup || standupFor) return this.standup(text, id, { permissions, standup, standupFor, beside });
    // The owner's word holds or goes as the bot's note, decided before anything else reads who wrote it.
    let word = null;
    if (asOwner !== null) {
      const mark = asOwnerMark(asOwner);
      if (!mark || overseer !== null || !id || origin || readOnly || scheduled || timed || ownChat || copied || mine || helps || budgetUsd !== null) refuse("The owner's word the bot that oversees his sessions sends for him goes to one of his sessions as it is: nothing else of his goes with it.");
      let current = null; try { current = readTask(this.repo, id); } catch { current = null; }
      if (ownerWord(this.repo, current, mark, { from: typeof computer === 'string' ? computer : null })) word = mark;
      else {
        let here = []; try { here = listBots().filter(botOversees); } catch { here = []; }
        const note = here.find(row => row.name === mark.bot) ?? here[0];
        if (!note || approved) refuse(NOT_OWNER_WORD(mark.bot));
        overseer = note.name; computer = null;
      }
    }
    // The bot's own note carries nothing of his: no teammate, schedule, approval, copy or other computer.
    const marked = typeof overseer === 'string' && overseer ? overseer : null;
    if (overseer !== null && (!marked || origin || readOnly || scheduled || timed || ownChat || approved || copied || mine || computer || helps || toModel)) refuse('A note of the bot that oversees your sessions goes to one of them as it is: nothing of yours goes with it.');
    if (budgetUsd !== null && (!marked || id)) refuse('Only a session the bot that oversees your sessions starts is started with a budget.');
    if (asks !== null && (!marked && !word || !id || typeof asks !== 'string' || !QUESTION_MARK.test(asks))) refuse('Only an answer of the bot that oversees your sessions names the question it answers.');
    let saved = id ? readTask(this.repo, id) : null;
    if (marked && saved) {
      let board = null; try { board = readBoard(this.repo); } catch { board = null; }
      if (!board) refuse(`The board could not be read, so ELU cannot tell whether that session is archived or in Done. Nothing of @${marked}'s was sent.`);
      if (sessionArchived(board, saved)) refuse(`That session is archived. Nothing of @${marked}'s goes to it.`);
      let place = null; try { place = sessionPlace(board, saved); } catch { place = null; }
      if (sessionClosed(board, saved) || place === 'done') refuse(`That session is in Done. Nothing of @${marked}'s goes to it.`);
    }
    // The request this message is, read now while the conductor starts it, for whether he said yes to it (FULL_UNASKED, below).
    const started = marked && saved ? startingNow(this.repo.root, saved.id, marked, text) : [];
    // Nor does a request from another computer, a teammate's included, put a bot that oversees
    // (or ever did, under that name) among a session's bots: its schedule would run on their words.
    const elsewhere = Boolean(computer || origin || mine || helps), brought = elsewhere && Array.isArray(bots) ? bots.map(name => typeof name === 'string' ? name.replace(/^@/, '') : '').find(name => BOT_NAME.test(name) && everOversaw(name)) : undefined;
    if (brought !== undefined) refuse(`Only the owner writes to @${brought}, on the computer it runs on.`);
    // his: a later message in his own session that no teammate, schedule or read-only turn sent;
    // own: one he wrote himself, which the bot's note never is.
    const his = Boolean(saved) && !origin && !readOnly && !scheduled && !timed, own = his && !marked;
    if (approved && !own) refuse('Only the owner approves a Task, in its own session.');
    if (own && !approved && saysYes(text) && waitingTask(sessionTasks(this.repo, saved.id))) { approveTask(this.repo, saved.id); approved = true; }
    // An approved request that starts again finds its Task's work started: the conductor
    // queued it again after a stall or a rate limit, or the owner pressed r on it. That work
    // goes on from where it stopped, approved once (beginApproved).
    const begun = approved ? taskStarted(this.repo, saved.id) : null;
    const agreed = approved ? begun ?? taskToStart(this.repo, saved.id) ?? refuse('That Task is no longer waiting to start.') : null;
    // A Task that needs no edit is worked on in an ordinary turn, which is told it is approved.
    const direct = agreed?.edit.intent === 'edit' ? agreed : null;
    // His approval goes to the bot his session works with (sessionWorker) when the Task names
    // none: approving it with y, in words or by a mode never hands the session to the model.
    // One he wrote to another working bot goes to that bot, one he wrote to @model (toModel) to the model.
    let named = null; if (bot !== null) { try { named = needBot(bot); } catch { named = null; } }
    const stays = approved && own && !toModel ? named && botWorks(named) ? named.name : sessionWorker(saved) : null;
    // The bot that proposed the Task makes its edit, whether or not it still works, as before
    // bots could oversee; one that oversees now never edits, so the Task goes where an unnamed one would.
    if (direct) bot = direct.edit.bot && !overseesNow(direct.edit.bot) ? direct.edit.bot : stays;
    else if (approved && bot === null) bot = stays;
    // A session a teammate's message started never works in the home folder, or above it,
    // unless the owner allowed it: not its first turn, and not a later one, whoever writes it.
    // Where it works decides: a session that edits in a repository's own folder is not there.
    const theirs = Boolean(origin?.peer || saved?.origin?.peer), allowed = saved ? saved.homeAllowed === true : home === true;
    if (theirs && !allowed && homeWork(saved, this.repo.root)) refuse(homeRefusal(saved?.id ?? null));
    if (saved && ['ask', 'review', 'handoff'].includes(origin?.kind) && (saved.kind !== 'conversation' || saved.origin?.peer !== origin.peer)) refuse('A teammate can continue only their own conversation.');
    if (origin && (bot !== null || bots !== undefined)) refuse("Bots join your own sessions, not a teammate's question.");
    if (scheduled && (bot === null || !saved)) refuse("A bot's scheduled turn names the bot and its session.");
    if (origin?.bot && !isPeerRun(origin)) refuse('A peer request names an invalid bot.');
    if (saved && isPeerRun(origin) && origin.bot && origin.bot !== saved.origin?.bot) refuse('A teammate can continue only their own conversation.');
    if (isPeerRun(origin) && (origin.bot ?? saved?.origin?.bot)) sharedBot(origin.bot ?? saved.origin.bot);
    // A teammate's question runs on Claude Code only. A computer without it says what its
    // owner can do instead (lib/models.mjs, NO_QUESTIONS).
    else if (isPeerRun(origin)) { const vendor = (saved ? pinnedConfig(this.repo, null, { task: saved }).config.roles.lead : defaultModel(this.draftConfig)).vendor; if (vendor !== 'claude') refuse(findBin('claude') ? questionRefusal(vendor) : NO_QUESTIONS); }
    if (saved && isPeerRun(origin) && (permissions !== undefined || place !== undefined || folders !== undefined)) refuse('Teammate questions stay read-only.');
    if (origin && model !== undefined) refuse("A teammate's question runs on your default model.");
    const addressed = bot === null ? null : needBot(bot);
    if (addressed && isPeerRun(saved?.origin)) refuse("Bots join your own sessions, not a teammate's question.");
    // The bot that oversees reads every session of his: only he writes to it, or in its own
    // chat, which holds what it read, here. A message from another computer, his own other one
    // too, never reaches it; his own schedules do. A teammate's request is refused above (no
    // bot of his own, and this one is never shared). A chat is that bot's while its name is one
    // a bot ever oversaw under, after a rename or a removal too (everOversaw).
    const overseen = addressed && botOversees(addressed) ? addressed.name : typeof saved?.botChat === 'string' && everOversaw(saved.botChat) ? saved.botChat : null;
    if (overseen && elsewhere) refuse(`Only the owner writes to @${overseen}, on the computer it runs on.`);
    // A teammate's later message in a session their message started keeps the session as it
    // is: the mode it carries is only what a new one would start with, and the owner may
    // have changed this one since.
    const keep = Boolean(saved) && origin?.own === true;
    if (saved && permissions !== undefined && !keep) saved = savePermissions(this.repo, saved.id, permissions);
    for (const dir of saved && !keep ? folders ?? [] : []) saved = saveFolder(this.repo, saved.id, dir);
    if (saved && bots !== undefined) saved = saveBots(this.repo, saved.id, bots);
    if (saved && model !== undefined) saved = setSessionModel(this.repo, saved.id, model);
    // A model the owner names with his message wins: Auto model is off for the session from here.
    if (saved && model !== undefined && autoOn(saved)) saved = setSessionAuto(this.repo, saved.id, false);
    // The owner's message continues the work of the session's approved Task when it stopped
    // before the end; it never goes to a read-only turn that resumes the working one. Edits
    // kept as not verified because a later turn of the work failed are such a stop too.
    // The bot's answer to the question that work stopped on carries it on too, as his answer would,
    // when it names that question (asks). Its plain note is answered, even while the session asks
    // one, and the work waits for him (lib/runner.mjs: nor does the note's reply carry it on).
    const working = (own || his && marked && asks !== null && saved.state === 'needs_input') && !direct && !addressed && saved.kind !== 'conversation' && (['needs_input', 'blocked', 'stopped'].includes(saved.state) || saved.state === 'unverified' && Boolean(saved.error?.message)) && !saved.pushedCommit && Boolean(openTask(sessionTasks(this.repo, saved.id)));
    // The owner's message to one of the session's reviewing bots about edits this session made
    // and has not published runs a review of them (reviewRequest): that bot's must-fix findings
    // go to the agent, which fixes or disputes them, and the loop goes on as after its turn. A
    // plain question (plainQuestion) gets the bot's answer in the chat as before.
    // The lead's ask that a bot review pull requests reviews those (pullAsk, below), not the session's own change.
    const reviewing = own && !direct && Boolean(addressed) && !(leadAsked(text)?.bot === addressed.name && pullsAsked(leadAsked(text).text)) && reviewsEdits(this.repo, saved, addressed.name, text);
    // The turns after that review fix what it found: the bot the session works with does them
    // (sessionWorker), as it does the session's work, and the model when it works with none.
    const fixer = reviewing ? sessionWorker(saved) : null;
    // A new session of the owner's own begins with Auto model when he asked for it there, or new
    // sessions he starts on this computer do (auto, lib/conductor.mjs), on a vendor that has a top
    // and a work model here (homeProblem, as the app reads it to show the session's model): one
    // that has none starts on its model with Auto model off. Never one a schedule, a teammate,
    // another computer or a bot's chat starts.
    const begins = model => auto === true && !marked && !origin && !readOnly && !scheduled && !timed && !ownChat && !mine && !helps && typeof computer !== 'string' && !homeProblem(model.vendor);
    const create = model => createConversation(this.repo, withModel(this.draftConfig, model), text, { origin, permissions, place, folders, bots, ...(ownChat && addressed ? { botChat: addressed.name } : {}), ...(mine && !origin ? { mine } : {}), ...(theirs && home === true ? { homeAllowed: true } : {}), ...(helps && !origin ? { helps } : {}), ...(timed && schedule && !origin ? { schedule, title } : {}), ...(!timed && typeof title === 'string' && title && !origin ? { title } : {}), ...(!origin && typeof model?.effort === 'string' ? { effort: model.effort } : {}), ...(!origin && botModels ? { botModels } : {}), ...(begins(model) ? { auto: true } : {}), ...(marked ? { overseer: marked, ...(budgetUsd !== null ? { budgetUsd } : {}) } : {}), ...(parent !== null && !origin && !mine ? { parent } : {}) });
    const task = saved ?? create(model ?? defaultModel(this.draftConfig));
    if (!saved && copied && !origin && !timed && !scheduled && !sessionTasks(this.repo, task.id).length) { const { from, ...fields } = copied; proposeTask(this.repo, task.id, { ...fields, copiedFrom: { session: String(from?.session ?? ''), task: String(from?.task ?? '') } }, { by: 'owner' }); approveTask(this.repo, task.id); }
    const location = saved && saved.kind !== 'conversation' ? this.taskRepo(saved) : this.repo;
    // Nor in a repository there: the one the model chose for the edit, or one a session edits
    // already. The owner's y for the session lets it there too.
    const notHome = target => { if (theirs && !allowed && target && homeOrAbove(target.root)) refuse(HOME_TARGET); return target; };
    notHome(location);
    const shadowed = !origin && !readOnly && !scheduled && !timed && !marked && (!addressed || botWorks(addressed));
    // worked: this turn does the work of the session's approved Task: it starts it, however
    // the owner approved it, carries it on, or has its edits reviewed. The conductor tells a
    // teammate whose message led to the Task when such a turn fails (Conductor.result).
    let worked = Boolean(agreed);
    // Every turn a message from another computer on the project leads to runs under the
    // project's rules for it (answeringComputer in lib/runner.mjs), in whoever's session.
    const sender = !origin && typeof computer === 'string' && /^[0-9a-f]{64}$/.test(computer) ? computer : null;
    // Auto model. stepped: this message picks a step. restart: it starts again after one model's
    // own weekly limit and goes on with the other model. step: 'plan', 'edit' or 'quick'; null for
    // none, where the turn runs on the model the session ran last.
    const autoHere = autoOn(task) && !origin && !readOnly && !scheduled && !timed && !sender, stepped = autoHere && !marked && ownerWords === true && !again, restart = autoHere && !marked && !stepped && limited !== null && typeof limited === 'object';
    let step = null;
    if (stepped) { try { step = messageStep(this.repo, saved, text, { approved, working, toBot: Boolean(addressed), toModel }); } catch { step = null; } }
    else if (restart && ['plan', 'edit'].includes(limited.step)) step = limited.step;
    // think, typed alone right after a quick answer: the same question goes to the top model.
    // A retry of that think (again) asks the same question, on the model the session ran last.
    if (autoHere && !marked && (ownerWords === true || again) && isThink(text)) { const asked = thinkAgain(saved, { retry: again }); if (asked !== null) { text = asked; if (stepped) step = 'plan'; } }
    if (step === 'stay') step = null;
    // Every turn the bot's note leads to records it under the bot's name (answeringOverseer), and
    // every turn the owner's word through it leads to records that as his, with its mark (answeringAsOwner).
    const finished = this.own(task.id, signal => answeringComputer(this.repo, task.id, sender, () => answeringOverseer(location, task.id, marked, () => answeringAsOwner(location, task.id, word, async () => {
      let value, stuck = null, handed = false;
      // In a session he set to Full access since, the bot's words would lead a turn with every
      // tool: they go in only when he said yes to them himself, and else not at all.
      if (marked && saved) {
        let full = true; try { full = readTask(this.repo, task.id).permissions === 'full'; } catch { full = true; }
        if (full && !await ownerSaidYes(started, marked)) refuse(FULL_UNASKED(marked));
      }
      // The bot's answer goes in only to the question it was written for, as the session's record
      // reads now. That module reads this one, so it is loaded here; one that cannot say gives none.
      if (asks !== null) {
        let now = null; try { now = (await import('./orchestrator-actions.mjs')).questionMark(readTask(this.repo, task.id)); } catch { now = null; }
        if (now !== asks) refuse(QUESTION_CHANGED);
      }
      // A quick question (Auto model): the fast model answers it first, read-only, beside the
      // session (lib/runner.mjs runAutoAnswer). One it hands up, and one it could not start for
      // (the session's budget is spent, its route is gone), goes to the top model as a plan: the
      // message is in the chat already then, so the turn writes it once (again).
      if (step === 'quick') {
        step = 'plan';
        let home = null; try { home = sessionModel(this.repo, saved, { turn: true })?.vendor ?? null; } catch { home = null; }
        let quick = null, top = null; try { quick = routeFor('quick', { home, task: saved }); const plan = routeFor('plan', { home, task: saved }); top = plan ? routeName(plan.vendor, plan.model) : null; } catch { quick = null; }
        let out = null; try { out = quick ? await runAutoAnswer(location, saved, { text, route: quick, top, toModel }, { signal }) : null; } catch { out = null; }
        if (out?.answered || out?.stopped) return out.task;
        handed = out?.started === true;
      }
      // session: the session as it reads once it is on the model of the step. A route that
      // cannot be set stops no message: the turn then runs on the model the session has.
      const route = async (to, options) => { try { await routeSession(this.repo, task.id, to, options); } catch { /* The model it has. */ } return readTask(this.repo, task.id); };
      let session = task;
      if (step || restart) {
        // A bot that does the session's work edits on its own model: that edit is no step of the
        // session's model. The turn a limit stopped was the model's own, whoever does the work.
        let bot = null; try { bot = toModel || !saved || restart ? null : sessionWorker(saved); } catch { bot = null; }
        if (bot && step === 'edit') step = null;
        if (step || restart) session = await route(step, { limited: restart ? limited : null });
      }
      if (working) {
        const ready = await continueReady(location, task.id, { signal }).catch(error => { stuck = error.message; return null; });
        if (ready) { worked = true; return continueTask(location, task.id, text, { signal, ready, owner: !marked, recordAnswer: !again, toModel, step }); }
      }
      // Work that cannot go on here (published, its policy changed) is answered by the bot instead.
      if (reviewing) {
        const ready = await continueReady(location, task.id, { signal }).catch(() => null);
        if (ready) { worked = true; return reviewRequest(location, task.id, text, { signal, bot: addressed.name, ready, worker: fixer ? { bot: fixer, scheduled: false, chat: current => botChat(this.repo, current) } : null }); }
      }
      const chat = current => botChat(this.repo, current);
      // owner: the owner wrote this message, just now. Only such a turn asks him about what a vendor would also run; any turn starts a vendor's one-time check.
      const owner = !origin && !scheduled && !timed && !marked;
      // The session's lead asked this bot (elu sessions ask, lib/elu-sent.mjs leadAsked): not the
      // owner's words, so its reply teaches nothing; its answer goes back to the lead (leadBack).
      const fromLead = Boolean(addressed) && !marked && !word && leadAsked(text)?.bot === addressed.name;
      // The lead asked a reviewing bot to review pull requests (elu sessions ask NAME review URL):
      // the bot reviews each at its head now, and its findings go to the lead tagged with each
      // one's number (lib/runner.mjs reviewPullsAsked), not as an answer in the chat.
      const pullAsk = fromLead && !botWorks(addressed) && !botOversees(addressed) ? pullsAsked(leadAsked(text).text) : null;
      // The bot's note goes to the bot that works in the session, or to its model, under the bot's name.
      // answers: it is the bot's answer to the question the session asks (asks), which alone may carry the work on.
      let conversation = direct ? Promise.resolve().then(() => beginApproved(this.repo, task.id, text, direct, { again: Boolean(begun), toModel })) : pullAsk ? reviewPullsAsked(location, task.id, { pulls: pullAsk, bots: [addressed.name], text, signal }) : addressed ? runBot(location, session, text, { signal, name: addressed.name, chat, scheduled, owner: owner && !fromLead, unattended: timed ? 'schedule' : false, again, ...(marked ? { overseer: marked, answers: asks !== null } : {}) }) : runConversation(location, session, text, { signal, origin, context, readOnly, owner, unattended: scheduled || timed ? 'schedule' : origin?.kind === 'handoff' && !origin.own ? 'handoff' : false, stuck, again: again || handed, toModel, as: marked ? { from: `@${marked}`, bot: marked, overseer: true } : sender ? { computer: sender } : null, answers: asks !== null, step }); this.conversations.set(task.id, conversation);
      try { value = await conversation; } finally { this.conversations.delete(task.id); }
      if (fromLead && !pullAsk) await leadBack(this.repo, task.id, addressed.name, value);
      else if (!addressed && !direct && !['blocked', 'stopped'].includes(value?.state)) { try { value = unaskedBots(this.repo, value) ?? value; } catch { /* The reply stands as it is. */ } }
      // The owner approved the waiting Task in words of his own and the reply said so. Its work
      // starts as after y: the editing turn at once, or, for a Task that edits nothing, the turn
      // that is told it is approved. Never on the bot's note: it approves nothing.
      let starts = direct;
      if (!starts && value.approvedTask && !marked) {
        const typed = taskToStart(this.repo, value.id);
        // It does the Task's work, however he approved it.
        if (typed) worked = true;
        if (typed?.edit.intent === 'edit') { starts = typed; value = beginApproved(this.repo, value.id, null, typed); }
        else if (typed) {
          // Auto model: the approved Task's work starts, on the work model.
          if (stepped && !addressed) { value = await route('edit'); step = 'edit'; }
          conversation = addressed ? runBot(location, value, `Approved the Task: ${typed.title}`, { signal, name: addressed.name, chat, owner }) : runConversation(location, value, `Approved the Task: ${typed.title}`, { signal, owner, step: step === 'edit' ? step : null }); this.conversations.set(task.id, conversation);
          try { value = await conversation; } finally { this.conversations.delete(task.id); }
        }
      }
      // A shadow turn never fails the message it follows.
      if (value.state !== 'preparing') return shadowed ? runShadows(location, value, { signal, chat, by: addressed ? `@${addressed.name}` : 'lead' }).catch(() => value) : value;
      // The bot this message was written to makes the edit it asked for, where the model would.
      // A bot that oversees now never makes it (overseesNow): the model does, as for an unnamed Task.
      const by = addressed?.name ?? (starts?.edit.bot && !overseesNow(starts.edit.bot) ? starts.edit.bot : null), worker = by ? { bot: by, scheduled, chat } : null;
      worked = true;
      try {
        // The gate: whatever a reply said, the app starts an edit only for a Task the owner
        // approved, or one a schedule recorded for a run nobody watches.
        if (!openTask(sessionTasks(this.repo, value.id))) refuse('This session has no approved Task, so no edit was started.');
        // Auto model: the edit runs on the work model, also where the plan that led to it ran on the
        // top model in this same message. A bot that makes the edit runs on its own model.
        if (stepped && !worker && step !== 'edit') { await route('edit'); step = 'edit'; }
        const editing = !worker && step === 'edit' ? step : null;
        if (value.kind !== 'conversation') return await continueTask(this.taskRepo(value), value.id, text, { signal, recordAnswer: false, worker, ready: await continueReady(this.taskRepo(value), value.id, { signal }), step: editing });
        let target = notHome(this.editTarget(worker ? value.botEdit?.repository ?? starts?.edit.repository : starts?.edit.repository ?? value.result?.repository));
        if (!target || target === this.repo) { await this.editingRepository(signal); signal.throwIfAborted(); target = this.repo; }
        value = readTask(this.repo, task.id);
        const { config } = pinnedConfig(this.repo, null, { task: value });
        // The owner's y started this work with no turn before it: a lead's vendor that was never checked gets its one-time check first.
        await checkLead(this.repo, value, config, { signal });
        const plan = await runPlan(target, value.goal, { automatic: true, config, id: value.id });
        return await runTask(target, plan, { signal, conversation: value, worker, step: editing });
      } catch (error) {
        const current = readTask(this.repo, task.id);
        if (current.kind === 'conversation' || current.state === 'preparing') { current.state = signal.aborted ? 'stopped' : 'blocked'; current.error = { message: error.message }; saveTask(this.repo, current); }
        throw error;
      }
    }, { computer: sender }))));
    return { id: task.id, finished, worked: () => worked };
  }
  // /standup (lib/standup-round.mjs). standup: a round, in a new Standup session on the
  // project's default model and the mode given, or, with id, another round of that Standup
  // session (@everyone); { question } asks that in place of the standup. The round asks every
  // open session of the owner's and of his teammates' shared ones, then the Standup's model
  // sums it up in one turn of its own. /stop stops the waiting and the summary still comes; a
  // second /stop stops the summary. standupFor: one of this computer's sessions answers a
  // round in a read-only turn of its own (runStandup). One in the middle of a turn (beside:
  // the conductor says so; or its record does) answers in a run beside that turn
  // (runStandupAside), at once: that run is no turn of the session, so it is kept apart from
  // the session's own (asides) under a stop of its own, and the turn goes on.
  standup(text, id, { permissions, standup = null, standupFor = null, beside = false } = {}) {
    if (standupFor) {
      const saved = readTask(this.repo, id), location = saved.kind !== 'conversation' ? this.taskRepo(saved) : this.repo;
      // A teammate's question is not his to answer for; one a teammate's message started that he
      // works on as his own (team access Auto, his y or w) is, as one he typed.
      if (isPeerRun(saved.origin) || saved.standup) refuse('Only your own sessions answer a standup.');
      if (beside || this.running.has(saved.id) || ['running', 'preparing'].includes(saved.state) && !saved.standupTurn) {
        const name = `${saved.id}\0${standupFor.round}`, controller = new AbortController();
        if (this.asides.has(name)) refuse('This session already answers that standup.');
        const finished = Promise.resolve().then(() => runStandupAside(location, saved, standupFor, { signal: controller.signal })).finally(() => this.asides.delete(name));
        this.asides.set(name, { controller, promise: finished });
        return { id: saved.id, finished, aside: true, stop: () => controller.abort(new Error('Stopped by the owner.')) };
      }
      return { id: saved.id, finished: this.own(saved.id, signal => runStandup(location, saved, standupFor, { signal })) };
    }
    const saved = id ? readTask(this.repo, id) : null;
    if (saved && !saved.standup) refuse('@everyone asks again from a Standup session. /standup starts one.');
    const task = saved ?? createConversation(this.repo, withModel(this.draftConfig, defaultModel(this.draftConfig)), text, { permissions });
    const question = standup && typeof standup === 'object' ? standup.question ?? null : null;
    // After the owner's /stop the summary still comes, under a stop of its own; a conductor
    // that stops ends it all.
    const renew = () => { const run = this.running.get(task.id); if (!run || run.controller.signal.reason?.message !== 'Stopped by the owner.') return null; run.controller = new AbortController(); return run.controller.signal; };
    // summing: whether its summary turn runs, which the conductor counts as any model's turn.
    let summing = false;
    return { id: task.id, finished: this.own(task.id, async signal => (await import('./standup-round.mjs')).runStandupSession(this.repo, task.id, { signal, renew, question, message: saved ? text : null, onSummary: () => { summing = true; } })), summing: () => summing };
  }
  // Where a session's record is kept: this project, or the repository it edits.
  sessionRepo(id) { try { const saved = readTask(this.repo, id); return saved.kind !== 'conversation' ? this.taskRepo(saved) : this.repo; } catch { return this.repo; } }
  // A message of the owner's for a session whose turn takes none while it works (row: the
  // waiting request) is answered beside that turn (runMessageAside), under a stop of its own:
  // the turn goes on. finished gives { text, kind, who } or { failed }.
  answerBeside(row) {
    const saved = readTask(this.repo, row.continuationTaskId), location = saved.kind !== 'conversation' ? this.taskRepo(saved) : this.repo;
    if (isPeerRun(saved.origin) || saved.standup) refuse('Only your own sessions answer beside a turn.');
    // Only the owner writes to the bot that oversees his sessions, or in its own chat (a name a bot ever oversaw under), on this computer (ask).
    const to = typeof row.bot === 'string' && row.bot && overseesNow(row.bot, true) ? row.bot : typeof saved.botChat === 'string' && everOversaw(saved.botChat) ? saved.botChat : null;
    if (to && (row.computer || row.origin || row.mine || row.helps)) refuse(`Only the owner writes to @${to}, on the computer it runs on.`);
    const name = `${saved.id}\0message\0${row.id}`, controller = new AbortController();
    if (this.asides.has(name)) refuse('That message is being answered already.');
    const finished = Promise.resolve().then(() => runMessageAside(location, saved, row, { signal: controller.signal })).finally(() => this.asides.delete(name));
    this.asides.set(name, { controller, promise: finished });
    return { id: saved.id, finished, aside: true, stop: () => controller.abort(new Error('Stopped by the owner.')) };
  }
  // The answer is in: kept beside the session's record, and taken into it now when no turn holds it.
  keepAside(id, row) { const location = this.sessionRepo(id); saveAside(location, id, row); try { foldAsides(location, id); } catch { /* When its turn ends. */ } }
  async editingRepository(signal) {
    if (this.repo.common && git(this.repo.root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true }).status === 0) return;
    if (this.preparation) return this.preparation;
    this.preparation = (async () => {
      while (this.conversations.size) await Promise.allSettled([...this.conversations.values()]);
      signal?.throwIfAborted();
      const plan = historyPlan(this.repo);
      this.adoptRepository(plan ? createHistory(plan) : projectFolder(this.repo.root));
    })().finally(() => { this.preparation = null; });
    return this.preparation;
  }
  adoptRepository(next) {
    const previous = this.repo;
    if (previous.state !== next.state) {
      for (const task of tasks(previous)) {
        const from = taskDir(previous, task.id), to = taskDir(next, task.id);
        if (fs.existsSync(to)) refuse('Task history already exists in the new repository. Reopen the project before continuing.');
        const copy = (source, destination) => {
          noSymlinks(source); noSymlinks(destination); const stat = fs.statSync(source);
          if (stat.isDirectory()) { fs.mkdirSync(destination, { recursive: true, mode: 0o700 }); for (const name of fs.readdirSync(source)) copy(path.join(source, name), path.join(destination, name)); }
          else { noSymlinks(destination); if (!fs.existsSync(destination)) fs.copyFileSync(source, destination); }
        };
        copy(from, to);
        task.runs = task.runs.map(run => ({ ...run, logFile: path.join(to, path.basename(run.logFile)) }));
        if (Array.isArray(task.stops)) task.stops = task.stops.map(run => ({ ...run, logFile: path.join(to, path.basename(run.logFile)) }));
        task.activeLog = null; saveTask(next, task);
      }
      const events = path.join(previous.state, 'events.jsonl'); noSymlinks(events);
      if (fs.existsSync(events) && !fs.existsSync(path.join(next.state, 'events.jsonl'))) fs.copyFileSync(events, path.join(next.state, 'events.jsonl'));
    }
    this.repo = next; this.onRepository?.(next); registerProject(next);
  }
  async verify(id, command) {
    this.writable(); const release = publishLock(this.repo, id);
    try {
      const task = readTask(this.repo, id);
      if (task.kind === 'conversation' || task.state === 'running') refuse('Select a finished editing task to verify.');
      const repo = this.taskRepo(task), { config } = pinnedConfig(repo, task.base, { current: false, task });
      if (command) {
        if (task.mode !== 'automatic') refuse('Update and commit checks through project settings for this task.');
        config.checks = [{ name: 'tests', command }]; validateConfig(config);
        const text = stringifyYaml(config); atomic(path.join(taskDir(this.repo, id), 'policy.yaml'), text); task.configHash = hash(text); saveTask(this.repo, task);
      }
      const result = await runChecks(repo, task);
      const reviewed = task.reviewStatus === 'skipped' || task.reviewStatus === 'passed' && task.reviews.at(-1)?.digest === result.digest;
      task.state = reviewed && evidenceCurrent(task) ? 'ready' : 'unverified';
      saveTask(this.repo, task); return result;
    } finally { release(); }
  }
  setupCommitPlan() { this.writable(); return setupCommitPlan(this.repo); }
  commitSetup(plan) { this.writable(); return commitSetup(this.repo, plan); }
  plan(goal) { this.writable(); return runPlan(this.repo, goal); }
  start(plan, request) {
    this.writable(); if (request) this.queue(request.goal, request.id, { taskId: plan.id, state: 'starting', reason: 'Starting task.' });
    return this.own(plan.id, signal => runTask(this.repo, plan, { signal })).then(task => { if (request) removeRequest(this.repo.root, request.id); return task; }, error => {
      if (request) { if (tasks(this.repo).some(task => task.id === plan.id && task.goal === request.goal)) removeRequest(this.repo.root, request.id); else this.queue(request.goal, request.id, { state: 'blocked', taskId: null, reason: error.message }); } throw error;
    });
  }
  answer(id, text) { this.writable(); const repo = this.taskRepo(readTask(this.repo, id)); return this.own(String(id), async signal => continueTask(repo, id, text, { signal, owner: true, ready: await continueReady(repo, id, { signal }) })); }
  // The owner's y to HOME_QUESTION for this session. Returns the task.
  allowHome(id) { this.writable(); return allowHome(this.repo, String(id)); }
  // The session's mode and folders: a switch applies from the next turn.
  setPermissions(id, mode) { this.writable(); return savePermissions(this.repo, String(id), mode); }
  // The bots in the session's chat: saved bots only. Returns the task.
  setBots(id, names) { this.writable(); return saveBots(this.repo, String(id), names); }
  setBudget(id, dollars) { this.writable(); return saveBudget(this.repo, String(id), dollars); }
  // What the model has spent in a session and the most it may: the limit the owner set for
  // the session, or null when he set none. spent: the dollars known (lib/budget.mjs roleSpend);
  // partial: some run's cost is not known, or may be more (atLeast), so it has spent at least
  // that; unknown: how many runs have none, runs: how many there are.
  budget(id) {
    const task = readTask(this.repo, String(id));
    const { known, unknown, partial, runs } = roleSpend(task, 'lead'), own = Number.isFinite(task.budgetUsd);
    return { spent: known, limit: own ? task.budgetUsd : null, own, partial, unknown, runs };
  }
  // The session's model, from its next message. Returns the task.
  setModel(id, choice) { this.writable(); return setSessionModel(this.repo, String(id), choice); }
  // An agent of the session, its model or a bot, on another model or effort (lib/agent-change.mjs). Returns { later, line }.
  changeAgent(id, change) { this.writable(); return changeAgent(this.repo, String(id), change); }
  // The Orchestrator's controls of a session (applySessionSettings and the rest, above): its
  // access, models, efforts and bots at once; its name; archived or back; its log's last rows.
  applySettings(id, parts) { this.writable(); return applySessionSettings(this.repo, id, parts); }
  // The owner's standing decisions for a session and its Task's goal, as the bot that oversees his
  // sessions updates them for him at Full (lib/owner-decisions.mjs updateTask).
  updateTask(id, change, { by }) { this.writable(); return updateOwnerTask(this.repo, String(id), change, { by }); }
  rename(id, title) { this.writable(); return renameSession(this.repo, id, title); }
  async archive(id) { this.writable(); return archiveSession(this.repo, id); }
  async unarchive(id) { this.writable(); return archiveSession(this.repo, id, { unarchive: true }); }
  logTail(id, options) { return sessionLogTail(this.repo, id, options); }
  // The model new sessions of this project start with, saved in its config file.
  setDefaultModel(choice) { this.writable(); this.draftConfig = setDefaultModel(this.repo, choice, this.draftConfig); return defaultModel(this.draftConfig); }
  defaultModel() { return defaultModel(this.draftConfig); }
  // The same, with where it comes from and each saved default that is passed over (lib/models.mjs, startModel).
  startModel() { return startModel(this.draftConfig); }
  addFolder(id, dir) { this.writable(); return saveFolder(this.repo, String(id), dir); }
  // Archived sessions deleted for good (lib/session-delete.mjs). What each would lose that is
  // on no remote: [{ id, title, commits, edits }].
  unpushedWork(ids) { return ids.map(id => { const task = readTask(this.repo, String(id)); return { id: String(id), title: taskTitle(task), ...unpushedWork(this.repo, task) }; }); }
  deleteSession(id, { keep = false } = {}) {
    this.writable(); if (this.running.has(String(id))) refuse('It is running. Stop it first.');
    return deleteSession(this.repo, String(id), { keep });
  }
  async learnFromArchived(ids, { signal } = {}) { this.writable(); return learnArchived(this.repo, ids, { signal, config: this.draftConfig }); }
  own(id, run) {
    if (this.running.has(id)) refuse('This task is already running.');
    const controller = new AbortController();
    // A standup answered beside this turn is taken into the session's chat once the turn is over, and so is a message answered beside it.
    const promise = Promise.resolve().then(() => run(controller.signal)).finally(() => { this.running.delete(id); try { foldStandup(this.repo, id); } catch { /* It is read from where it is. */ } try { foldAsides(this.sessionRepo(id), id); } catch { /* It is read from where it is. */ } try { foldPulls(this.sessionRepo(id), id); } catch { /* It is read from where it is. */ } });
    this.running.set(id, { controller, promise }); return promise;
  }
  async stop(id, reason = 'Stopped by the owner.') {
    this.writable(); const run = this.running.get(String(id));
    if (!run) refuse('This task is not owned by this view.');
    run.controller.abort(new Error(reason));
    await run.promise.catch(() => {});
  }
  refreshUsage() {
    this.writable();
    return this.usageRefresh ??= refreshCodexUsage({ signal: this.usageAbort.signal }).finally(() => { this.usageRefresh = null; });
  }
  async close() { this.usageAbort.abort(); for (const run of this.asides.values()) run.controller.abort(new Error('Stopped by the owner.')); await Promise.all([this.usageRefresh, ...[...this.running.keys()].map(id => this.stop(id)), ...[...this.asides.values()].map(run => run.promise.catch(() => {}))]); }
  // The session's work is on GitHub already, with a pull request: which one. null when something is still to publish.
  published(id) {
    this.writable(); const release = publishLock(this.repo, id);
    try { const task = readTask(this.repo, id); return task.kind === 'conversation' ? null : alreadyPublished(this.taskRepo(task), task); } finally { release(); }
  }
  async pushPlan(id) {
    this.writable(); const release = publishLock(this.repo, id);
    try { const task = readTask(this.repo, id); if (task.kind === 'conversation' || task.state === 'answered') refuse('This response has no code changes to publish.'); return await preparePublish(this.taskRepo(task), task); } finally { release(); }
  }
  async push(id, confirmationId) {
    this.writable(); const release = publishLock(this.repo, id);
    try { const task = readTask(this.repo, id); return await publish(this.taskRepo(task), task, confirmationId); } finally { release(); }
  }
  // Whether this window pushes the session now, and /stop for that push: false when it pushes none.
  pushing(id) { return pushing(this.repo, id); }
  stopPush(id) { return stopPush(this.repo, id); }
}
