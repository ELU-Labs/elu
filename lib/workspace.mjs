import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { findRepository, git, head, assertGitSafe, prepareGit } from './git.mjs';
import { atomic, fileFacts, hash, mkdir, noSymlinks, readJson, refuse, findBin } from './util.mjs';
import { personalDirectory } from './usage.mjs';
import { lock, waitLock } from './state.mjs';
import { olderConductor } from './conductor-files.mjs';

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
  const root = projectPath(value, cwd); noSymlinks(root);
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
      // A file of any size goes into the history: ELU sets no size limit of its own.
      const stat = fs.statSync(full); if (!stat.isFile()) refuse(`Review this file before creating project history: ${file}`);
      return { path: file, hash: fileFacts(full).hash, mode: stat.mode & 0o777 };
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
// (Conductor.take). Once it has exited, they go back with the rest.
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
// Writes a project's requests, every one of them, under its requests lock. While a conductor
// without handover runs, the queued ones go to besideFile, written first, so none is ever in
// neither file. Only a write with a queued request asks about it, so others start no process.
function writeRequests(root, rows) {
  const side = besideFile(root), queued = rows.filter(row => row.state === 'queued');
  const hold = queued.length > 0 && Boolean(olderConductor());
  if (hold) atomic(side, queued);
  atomic(requestFile(root), hold ? rows.filter(row => row.state !== 'queued') : rows);
  if (!hold) { noSymlinks(side); fs.rmSync(side, { force: true }); }
}
// Moves the queued requests a conductor without handover could start into besideFile, while
// one runs: those queued before the update, and its own retries. True when it moved any.
export function holdRequests(root) {
  // Read first without the lock, as most ticks find nothing to move.
  if (!readRequests(requestFile(root)).some(row => row.state === 'queued')) return false;
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    if (!readRequests(requestFile(root)).some(row => row.state === 'queued') || !olderConductor()) return false;
    writeRequests(root, pendingRequests(root)); return true;
  } finally { release(); }
}
const ownRequest = ({ origin, readOnly, context, ...row }) => row;
export function saveRequest(root, goal, id, update = {}) {
  if (typeof goal !== 'string' || !goal.trim()) refuse('Enter a request.');
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
// a blank line apart, while the request is still queued, however long the two are together.
// One step, so the conductor never starts the request with half of it. Returns the request,
// or null when it is no longer queued.
export function addToRequest(root, id, text) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), found = rows.find(row => row.id === id && row.state === 'queued');
    if (!found) return null;
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
// Joins waiting messages into the first of them, in the order given and a blank line
// apart, while each is still queued, however long they are together. One step, so
// a message taken back a moment ago is not sent. Returns the joined request, or null when
// the first is no longer queued.
export function joinRequests(root, ids) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), found = ids.map(id => rows.find(row => row.id === id && row.state === 'queued')).filter(Boolean);
    if (found[0]?.id !== ids[0]) return null;
    const joined = [found[0]]; let goal = found[0].goal;
    for (const row of found.slice(1)) { goal += `\n\n${row.goal}`; joined.push(row); }
    if (joined.length === 1) return found[0];
    const gone = new Set(joined.slice(1).map(row => row.id)), row = { ...found[0], goal };
    writeRequests(root, rows.filter(value => !gone.has(value.id)).map(value => value.id === row.id ? row : value)); return row;
  } finally { release(); }
}
// Changes a request only while it still exists in an expected state, so a request
// cancelled in one terminal cannot be revived by the conductor, or the reverse.
export function updateRequest(root, id, update, { from } = {}) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), existing = rows.find(row => row.id === id);
    if (!existing || from && !from.includes(existing.state)) return null;
    const row = { ...existing, ...update };
    writeRequests(root, rows.map(value => value.id === id ? row : value)); return row;
  } finally { release(); }
}
