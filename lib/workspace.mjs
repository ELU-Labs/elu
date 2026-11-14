import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { findRepository, git, head, assertGitSafe, prepareGit } from './git.mjs';
import { atomic, hash, mkdir, noSymlinks, onDiskPath, readJson, refuse, findBin } from './util.mjs';
import { personalDirectory } from './usage.mjs';
import { lock, waitLock } from './state.mjs';
import { besideLock, lockHolder, waitMode } from './conductor-files.mjs';

export function projectPath(value, cwd = process.cwd()) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) refuse('Enter a project folder.');
  return path.resolve(cwd, value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
}
export function projectFolder(value, cwd) {
  const root = fs.realpathSync(projectPath(value, cwd));
  if (!fs.statSync(root).isDirectory()) refuse('Choose a folder, not a file.');
  const repo = findRepository(root); if (repo) return repo;
  // A project is a name and its settings; the lead finds the code, so even your home works.
  if (root === path.parse(root).root) refuse('Choose a folder, rather than your entire disk.');
  return { root, common: null, state: path.join(personalDirectory(), 'projects', hash(root)), worktrees: path.join(path.dirname(root), `${path.basename(root)}.elu-code`) };
}
// Git repositories under your home, most recently used first, so the lead can pick one
// without searching. Bounded by depth, count and time; hidden folders, dependencies,
// system folders, linked worktrees and ELU's own editing workspaces are skipped.
const SKIP = new Set(['node_modules', 'Library', 'Applications', 'Pictures', 'Music', 'Movies', 'Public', 'vendor', 'dist', 'build', 'target']);
const used = dir => Math.max(0, ...['HEAD', 'index', 'FETCH_HEAD'].map(name => { try { return fs.statSync(path.join(dir, '.git', name)).mtimeMs; } catch { return 0; } }));
export function nearbyRepositories({ home = os.homedir(), depth = 4, limit = 60, scan = 2000, budgetMs = 1500, now = Date.now } = {}) {
  const started = now(), found = [];
  let level = [fs.realpathSync(home)];
  for (let d = 0; d <= depth && level.length && found.length < scan && now() - started <= budgetMs; d++) {
    const next = [];
    for (const dir of level) {
      if (found.length >= scan || now() - started > budgetMs) break;
      let names; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      const git = names.find(entry => entry.name === '.git');
      if (d > 0 && git) { if (git.isDirectory()) found.push(dir); continue; }
      for (const entry of names) if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name) && !entry.name.endsWith('.elu-code')) next.push(path.join(dir, entry.name));
    }
    level = next;
  }
  return found.map(dir => [used(dir), dir]).sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, dir]) => dir);
}
export function createFolderPlan(value, cwd) {
  // The folder as it is on disk: the owner may name it through a link (/tmp and /var on macOS).
  const root = onDiskPath(projectPath(value, cwd)); noSymlinks(root);
  if (fs.existsSync(root)) refuse('That folder already exists. Open it instead.');
  let parent = path.dirname(root); while (!fs.existsSync(parent)) parent = path.dirname(parent);
  if (findRepository(parent)) refuse('Choose a folder outside an existing project for a new project.');
  return { root, writes: [root], message: 'Create this project folder? Git and project settings are added only when you start coding.' };
}
export function createFolder(plan) {
  createFolderPlan(plan.root); fs.mkdirSync(plan.root, { recursive: true, mode: 0o700 }); return projectFolder(plan.root);
}
function initialFiles(root, repo) {
  let scratch;
  try {
    let args = [];
    if (!repo.common) {
      mkdir(personalDirectory()); scratch = fs.mkdtempSync(path.join(personalDirectory(), 'history-'));
      git(scratch, ['init', '--bare', '--template=', '--initial-branch=main']);
      args = [`--git-dir=${scratch}`, `--work-tree=${root}`];
    }
    const files = git(root, [...args, '-c', 'core.fsmonitor=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean);
    return [...new Set(files)].sort().map(file => {
      if (/(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|auth\.json|credentials\.json|id_rsa|id_ed25519)$|\.(?:pem|p12|key)$/i.test(file)) refuse(`Keep ${file} out of history using .gitignore before starting.`);
      const full = path.join(root, file); noSymlinks(full);
      const stat = fs.statSync(full); if (!stat.isFile() || stat.size > 4 * 1024 * 1024) refuse(`Review this file before creating project history: ${file}`);
      return { path: file, hash: hash(fs.readFileSync(full)), mode: stat.mode & 0o777 };
    });
  } finally { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); }
}
export function historyPlan(location) {
  if (!findBin('git')) refuse('Install Git before starting a coding task. You can still open ELU.');
  const repo = projectFolder(location.root);
  if (repo.root !== location.root) refuse('This folder is now part of another project. Open the project again.');
  if (repo.common && git(repo.root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true }).status === 0) return null;
  const files = initialFiles(repo.root, repo);
  return { root: repo.root, create: !repo.common, files, digest: hash(JSON.stringify(files)), message: 'Create local project history and an initial checkpoint of these files. Nothing is pushed and no remote repository is created.' };
}
export function createHistory(approved) {
  const current = historyPlan({ root: approved.root });
  if (!current || current.create !== approved.create || current.digest !== approved.digest) refuse('The project changed after the history preview. Review it again.');
  if (current.create) git(current.root, ['init', '--template=', '--initial-branch=main']);
  const repo = projectFolder(current.root); assertGitSafe(repo);
  const release = lock(repo);
  try {
    const hooks = path.join(repo.state, 'empty-hooks'); mkdir(hooks);
    if (fs.readdirSync(hooks).length) refuse('The Git preparation hook directory is not empty.');
    if (current.files.length) prepareGit(repo, repo.root, ['add', '--', ...current.files.map(file => file.path)]);
    if (hash(JSON.stringify(initialFiles(repo.root, repo))) !== current.digest) refuse('The project changed while preparing its checkpoint. Review it again.');
    git(repo.root, ['-c', `core.hooksPath=${hooks}`, 'commit', '--allow-empty', '-m', 'Start project history']);
    head(repo.root); return repo;
  } finally { release(); }
}
const requestFile = root => path.join(personalDirectory(), 'requests', `${hash(root)}.json`);
// A conductor of 0.1.16 or earlier never hands its work over: until it is idle it starts every
// queued request in requestFile. While one runs, the queued requests wait in this file
// instead, which it never reads, and the conductor of this version starts them beside it
// (Conductor.take). Once it has exited, they go back with the rest. After a downgrade to a
// version that never reads this file, they wait here only while a conductor of a later
// version runs beside it (holding).
const besideFile = root => path.join(personalDirectory(), 'requests', `${hash(root)}.beside.json`);
function readRequests(file) {
  noSymlinks(file);
  if (!fs.existsSync(file)) return [];
  const rows = readJson(file);
  if (!Array.isArray(rows) || rows.some(row => typeof row?.id !== 'string' || !/^request-[a-f0-9-]+$/.test(row.id) || typeof row.goal !== 'string')) refuse('Saved requests could not be read.');
  return rows;
}
export function pendingRequests(root) {
  const seen = new Set();
  // A request moves between the files main first, so a copy left in both by a crash is read once.
  return [...readRequests(requestFile(root)), ...readRequests(besideFile(root))].filter(row => !seen.has(row.id) && seen.add(row.id) && row.state !== 'cancelled');
}
// A request the conductor beside one without handover starts or runs stays in besideFile too
// until it ends (shelter). Once that one has exited, another of its version can start before
// the conductor beside takes the lock (Conductor.promote), and its recover() marks every
// request starting or running in requestFile interrupted.
const SHELTERED = ['starting', 'running'];
// A conductor of 0.1.18 or 0.1.19 reads both files, so nothing waits out of its sight. While
// one stays after an update (stays in lib/conductor-files.mjs), each queued request is kept
// from it by its notBefore instead: half a minute ahead (keptUntil), renewed while this
// version's conductor runs beside it, which starts the request by the time it had before
// (keptBefore). If that conductor dies, the half minute passes and the earlier one starts the
// request: nothing ever waits where a version cannot read it. Only that conductor renews:
// any other write keeps a request once, for the conductor it is about to start. What is kept
// is freed by the conductor that kept it (releaseRequests), or by any write once none runs
// beside (loose).
const KEEP_MS = 30000;
const isKept = row => typeof row.keptUntil === 'string' && row.notBefore === row.keptUntil;
// When a request may start, for the conductor the queued requests are kept for.
export const startsAt = row => isKept(row) ? row.keptBefore ?? null : row.notBefore ?? null;
const fresh = (row, now) => isKept(row) && Date.parse(row.keptUntil) - now > KEEP_MS / 2;
const marked = rows => rows.some(row => row.keptUntil !== undefined || row.keptBefore !== undefined);
const loose = () => !lockHolder(besideLock());
function keep(row, now, renew) {
  if (fresh(row, now) || isKept(row) && !renew) return row;
  const until = new Date(now + KEEP_MS).toISOString();
  return { ...row, keptBefore: startsAt(row), keptUntil: until, notBefore: until };
}
function free(row) {
  if (row.keptUntil === undefined && row.keptBefore === undefined) return row;
  const { keptUntil, keptBefore, ...rest } = row;
  return isKept(row) ? { ...rest, notBefore: keptBefore ?? null } : rest;
}
// Writes a project's requests, every one of them, under its requests lock. While a conductor
// without handover runs, the queued ones go to besideFile (waitMode 'beside'); a sheltered one
// stays there while it starts or runs. While a conductor of an earlier version with handover
// stays, the queued ones are kept from it (waitMode 'kept'). A request that moves is written
// where it goes before it is taken from where it was, so none is ever in neither file. Only a
// write with a queued request asks about a conductor, so others start no process.
function writeRequests(root, all, { shelter = [] } = {}) {
  const side = besideFile(root), there = new Set(readRequests(side).map(row => row.id));
  const mode = all.some(row => row.state === 'queued') ? waitMode() : null, hold = mode === 'beside', now = Date.now();
  const alone = (mode === 'kept' || marked(all)) && loose();
  const rows = all.map(row => row.state !== 'queued' ? free(row) : mode === 'kept' ? keep(row, now, !alone) : alone ? free(row) : row);
  const kept = row => hold && row.state === 'queued' || SHELTERED.includes(row.state) && (there.has(row.id) || shelter.includes(row.id));
  const beside = rows.filter(kept), back = rows.filter(row => !kept(row) && there.has(row.id));
  if (beside.length || back.length) atomic(side, [...beside, ...back]);
  atomic(requestFile(root), rows.filter(row => !kept(row)));
  if (!beside.length) { noSymlinks(side); fs.rmSync(side, { force: true }); }
  else if (back.length) atomic(side, beside);
}
// Moves the queued requests a conductor without handover could start into besideFile, while
// one runs: those queued before the update, and its own retries. After a downgrade to a
// version that never reads besideFile, and none runs beside it that does, moves those waiting
// there back. While a conductor of an earlier version with handover stays, keeps the queued
// ones from it, and renews that; once it has gone, frees them. True when it changed any.
export function holdRequests(root) {
  // Read first without the lock, as most ticks find nothing to change.
  const need = () => {
    const main = readRequests(requestFile(root)), side = readRequests(besideFile(root)), all = [...main, ...side];
    const queued = rows => rows.some(row => row.state === 'queued');
    if (!queued(all) && !marked(all)) return false;
    const mode = waitMode(), now = Date.now();
    if (mode === 'beside') return queued(main);
    return queued(side) || (mode === 'kept' ? all.some(row => row.state === 'queued' && !fresh(row, now) && !(isKept(row) && loose())) : marked(all) && loose());
  };
  if (!need()) return false;
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    if (!need()) return false;
    writeRequests(root, pendingRequests(root)); return true;
  } finally { release(); }
}
// The queued requests of a project that wait in besideFile.
export function waitingBeside(root) { return readRequests(besideFile(root)).filter(row => row.state === 'queued'); }
// Puts every request back in requestFile, and frees those kept, as a conductor that started
// those waiting beside it stops: none may wait where a version installed after it never
// reads (a downgrade), or for a conductor that has gone.
export function releaseRequests(root) {
  if (!readRequests(besideFile(root)).length && !marked(readRequests(requestFile(root)))) return false;
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root).map(free), side = besideFile(root);
    atomic(requestFile(root), rows); noSymlinks(side); fs.rmSync(side, { force: true }); return true;
  } finally { release(); }
}
const ownRequest = ({ origin, readOnly, context, ...row }) => row;
export function saveRequest(root, goal, id, update = {}) {
  if (typeof goal !== 'string' || !goal.trim() || goal.length > 16000) refuse('Enter a request of 1 to 16000 characters.');
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), found = id && rows.find(row => row.id === id);
    // An owner who rewrites a teammate's request makes it their own, so its peer fields go.
    const existing = found && found.goal !== goal ? ownRequest(found) : found;
    const row = { ...(existing ?? { id: `request-${crypto.randomUUID()}`, createdAt: new Date().toISOString() }), goal, state: 'waiting', reason: 'Ready to review and start.', ...update };
    writeRequests(root, [...rows.filter(value => value.id !== row.id), row]); return row;
  } finally { release(); }
}
// Adds a message to a request that has not started: its text goes after the request's own,
// a blank line apart, while the request is still queued and the whole stays one message's
// length. One step, so the conductor never starts the request with half of it. Returns the
// request, or null when it is no longer queued or would grow too long.
export function addToRequest(root, id, text) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), found = rows.find(row => row.id === id && row.state === 'queued');
    if (!found || found.goal.length + text.length + 2 > 16000) return null;
    const row = { ...found, goal: `${found.goal}\n\n${text}` };
    writeRequests(root, rows.map(value => value.id === id ? row : value)); return row;
  } finally { release(); }
}
export function removeRequest(root, id) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try { writeRequests(root, pendingRequests(root).filter(row => row.id !== id)); } finally { release(); }
}
// A blocked or saved message of the owner's to a session is spent once the owner moved on in
// that session: a newer message of his to it was queued, started, ran or finished, or the
// session took a message of his after this one stopped. A bot's scheduled turn, a schedule's
// run and a teammate's message are not his, and spend nothing. Returns their IDs. rows: every
// saved request, done ones included; tasks: the project's sessions. A teammate's message is
// theirs, so it is never spent here.
const HELD = ['blocked', 'waiting'];
const timeOf = value => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; };
export function supersededRequests(rows, tasks = []) {
  const list = Array.isArray(rows) ? rows : [];
  return list.filter(row => {
    if (!HELD.includes(row?.state) || row.origin || row.continuationTaskId == null) return false;
    const session = String(row.continuationTaskId), since = timeOf(row.blockedAt ?? row.createdAt);
    if (list.some(other => other !== row && String(other?.continuationTaskId) === session && ['queued', 'starting', 'running', 'done'].includes(other.state) && !other.origin && !other.scheduled && !other.scheduleId && timeOf(other.createdAt) > timeOf(row.createdAt))) return true;
    // A bot's reply, a teammate's message and a bot's scheduled turn are not the owner's.
    const task = (Array.isArray(tasks) ? tasks : []).find(value => String(value?.id) === session);
    return (task?.messages ?? []).some(message => !message?.bot && !message?.shadow && !message?.from && !message?.peer && !message?.scheduled && timeOf(message?.at) > since);
  }).map(row => row.id);
}
// Takes spent messages out of the queue, in one step. One that was retried or changed since is kept.
export function dropRequests(root, ids) {
  const gone = new Set(ids); if (!gone.size) return 0;
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), kept = rows.filter(row => !(gone.has(row.id) && HELD.includes(row.state)));
    if (kept.length !== rows.length) writeRequests(root, kept);
    return rows.length - kept.length;
  } finally { release(); }
}
// Takes back a message that still waits: it is removed only while it is queued, in one
// step, so a message the conductor has begun to start is never reported as taken back.
// Returns the removed request, or null when it is gone or already starting.
export function takeRequest(root, id) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), found = rows.find(row => row.id === id && row.state === 'queued');
    if (found) writeRequests(root, rows.filter(row => row.id !== id));
    return found ?? null;
  } finally { release(); }
}
// A message the owner typed into a session while it worked: a follow-up of his own that
// changes none of the session's choices. Such messages are joined into one turn (the
// conductor's together) and may go to a turn that is running (typedFront).
export const typedRequest = value => Boolean(value?.continuationTaskId) && !value.origin && !value.scheduled && !value.scheduleId && !value.botChat && !value.attempts && !value.readOnly && !value.standupFor && !value.standup
  && ['permissions', 'place', 'folders', 'bots', 'model'].every(name => value[name] === undefined);
// The order the conductor starts waiting requests in: priority, then when each was queued.
export const requestOrder = (a, b) => (a.priority ?? 1) - (b.priority ?? 1) || Date.parse(a.queuedAt ?? a.createdAt) - Date.parse(b.queuedAt ?? b.createdAt);
// What the chat says under a message that is on a running turn's input and not yet read.
export const WAITS_FOR_COMMAND = 'Waiting for the current command to finish.';
// The messages that wait for session taskId and are for bot (null: the session's model), as
// the turn running there now reads them (lib/runner.mjs inboxFeed): the typed ones at the
// front of its queue, in the order sent, up to the first that is for someone else or is not
// typed, so nothing overtakes it. rows: the saved requests. While one is on the turn's input
// it stays queued and carries turn ({ run, uuid }); now and cancel are what the owner asked
// of it there (send it now, take it back), and back says it was taken back from the turn.
export function typedFront(rows, taskId, bot = null) {
  const mine = rows.filter(row => row.state === 'queued' && String(row.continuationTaskId) === String(taskId)).sort(requestOrder), front = [];
  for (const row of mine) { if (!typedRequest(row) || (row.bot ?? null) !== (bot ?? null)) break; front.push(row); }
  return front;
}
// The owner sends what waits for session taskId's running turn now: each message that turn
// takes (typedFront, less one taken back) is marked now, in one step, and the run that has
// them on its input tells Claude Code (lib/runner.mjs inboxFeed). Returns how many were marked.
export function sendTypedNow(root, taskId, bot = null) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), ids = new Set(typedFront(rows, taskId, bot).filter(row => !row.back).map(row => row.id)), now = new Date().toISOString();
    if (ids.size) writeRequests(root, rows.map(row => ids.has(row.id) ? { ...row, now, cancel: undefined, reason: 'Sending it now.' } : row));
    return ids.size;
  } finally { release(); }
}
// Joins waiting messages into the first of them, in the order given and a blank line
// apart, while each is still queued and the whole stays one message's length. One step, so
// a message taken back a moment ago is not sent. Returns the joined request, or null when
// the first is no longer queued.
export function joinRequests(root, ids) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), found = ids.map(id => rows.find(row => row.id === id && row.state === 'queued')).filter(Boolean);
    if (found[0]?.id !== ids[0]) return null;
    const joined = [found[0]]; let goal = found[0].goal;
    for (const row of found.slice(1)) { if (goal.length + row.goal.length + 2 > 16000) break; goal += `\n\n${row.goal}`; joined.push(row); }
    if (joined.length === 1) return found[0];
    const gone = new Set(joined.slice(1).map(row => row.id)), row = { ...found[0], goal };
    writeRequests(root, rows.filter(value => !gone.has(value.id)).map(value => value.id === row.id ? row : value)); return row;
  } finally { release(); }
}
// Changes a request only while it still exists in an expected state, so a request
// cancelled in one terminal cannot be revived by the conductor, or the reverse. shelter: the
// conductor beside one without handover starts it (writeRequests).
export function updateRequest(root, id, update, { from, shelter = false } = {}) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), existing = rows.find(row => row.id === id);
    if (!existing || from && !from.includes(existing.state)) return null;
    const row = { ...existing, ...update };
    writeRequests(root, rows.map(value => value.id === id ? row : value), { shelter: shelter ? [id] : [] }); return row;
  } finally { release(); }
}
