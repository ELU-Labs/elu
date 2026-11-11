import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { findRepository, git, head, assertGitSafe, prepareGit } from './git.mjs';
import { atomic, hash, mkdir, noSymlinks, readJson, refuse, findBin } from './util.mjs';
import { personalDirectory } from './usage.mjs';
import { lock, waitLock } from './state.mjs';

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
// system folders, linked worktrees and ELU Code's own editing workspaces are skipped.
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
      const stat = fs.statSync(full); if (!stat.isFile() || stat.size > 4 * 1024 * 1024) refuse(`Review this file before creating project history: ${file}`);
      return { path: file, hash: hash(fs.readFileSync(full)), mode: stat.mode & 0o777 };
    });
  } finally { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); }
}
export function historyPlan(location) {
  if (!findBin('git')) refuse('Install Git before starting a coding task. You can still open ELU Code.');
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
export function pendingRequests(root) {
  const file = requestFile(root); noSymlinks(file);
  if (!fs.existsSync(file)) return [];
  const rows = readJson(file);
  if (!Array.isArray(rows) || rows.some(row => typeof row?.id !== 'string' || !/^request-[a-f0-9-]+$/.test(row.id) || typeof row.goal !== 'string')) refuse('Saved requests could not be read.');
  return rows.filter(row => row.state !== 'cancelled');
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
    atomic(requestFile(root), [...rows.filter(value => value.id !== row.id), row]); return row;
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
    atomic(requestFile(root), rows.map(value => value.id === id ? row : value)); return row;
  } finally { release(); }
}
export function removeRequest(root, id) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try { atomic(requestFile(root), pendingRequests(root).filter(row => row.id !== id)); } finally { release(); }
}
// Takes back a message that still waits: it is removed only while it is queued, in one
// step, so a message the conductor has begun to start is never reported as taken back.
// Returns the removed request, or null when it is gone or already starting.
export function takeRequest(root, id) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), found = rows.find(row => row.id === id && row.state === 'queued');
    if (found) atomic(requestFile(root), rows.filter(row => row.id !== id));
    return found ?? null;
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
    atomic(requestFile(root), rows.filter(value => !gone.has(value.id)).map(value => value.id === row.id ? row : value)); return row;
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
    atomic(requestFile(root), rows.map(value => value.id === id ? row : value)); return row;
  } finally { release(); }
}
