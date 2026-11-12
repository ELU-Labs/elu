import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash, homeOrAbove, within } from './util.mjs';
import { git } from './git.mjs';
import { normalizeRemote } from './peer/shares.mjs';

// Which repository each session works in, so a project whose folder holds several
// repositories (a parent folder, the home folder) has one Kanban board for each, told apart
// by the origin remote: the same repository on every machine has the same id.
//
// A session's repository, the first of: the repository its edit runs in (task.repository);
// the one its proposed or approved Task names for the edit; the project, when it is a clone;
// the folder the session works in, when it is inside a clone. A session with none of these
// (a conversation in a parent folder, one that asks first, one whose Task waits) works in
// the project's main repository: the one clone the project folder holds, or with several the
// repository of the project's most recent session that has one, else the clone whose folder
// is named as the project folder. With none, the session is in no repository.

// The top folder of the clone a folder is in, or null: in no clone, or the clone is the home
// folder or above it. Read again at most every minute.
const tops = new Map();
export function cloneTop(folder, now = Date.now()) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return null;
  const kept = tops.get(folder); if (kept && now - kept.at < 60000 && now >= kept.at) return kept.value;
  let value = null;
  try {
    if (!homeOrAbove(folder) && fs.existsSync(folder) && fs.statSync(folder).isDirectory()) {
      const result = git(folder, ['rev-parse', '--show-toplevel'], { allowFailure: true }), top = result.status === 0 ? result.stdout.trim() : '';
      value = top && path.isAbsolute(top) && !homeOrAbove(top) ? top : null;
    }
  } catch { value = null; }
  if (tops.size > 500) tops.clear();
  tops.set(folder, { at: now, value }); return value;
}
// The folder a Task names for its edit, as the model wrote it (absolute, ~/, or relative to
// the project), when it is in the home folder or the project; else null.
function namedFolder(repo, value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\x00-\x1f\x7f]/.test(value)) return null;
  const real = folder => { try { return fs.realpathSync(folder); } catch { return null; } };
  const home = real(os.homedir()) ?? os.homedir(), text = value.trim();
  const folder = real(path.resolve(repo.root, text === '~' ? home : text.startsWith('~/') ? path.join(home, text.slice(2)) : text));
  return folder && (within(home, folder) || within(real(repo.root) ?? repo.root, folder)) ? folder : null;
}
// A session's own repository folder, from the session alone, or null.
export function ownFolder(repo, task, now = Date.now()) {
  if (typeof task?.repository === 'string' && path.isAbsolute(task.repository)) return task.repository;
  const plan = task?.plan && ['proposed', 'approved', 'done'].includes(task.plan.state) ? task.plan : null;
  for (const named of [plan?.edit?.repository, task?.botEdit?.repository]) { const folder = namedFolder(repo, named), top = folder && cloneTop(folder, now); if (top) return top; }
  for (const folder of [repo.root, task?.worktree]) { const top = cloneTop(folder, now); if (top) return top; }
  return null;
}
const time = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : 0; };
const lastOf = task => Math.max(time(task.createdAt), ...(task.runs ?? []).map(run => time(run.at)), ...(task.messages ?? []).map(row => time(row.at)));
// A teammate's question lives in its Chats thread, on no board.
const asked = task => ['ask', 'review'].includes(task?.origin?.kind);
// The folder each session's repository is read from: Map(task id -> folder or null).
// clones: the clones the project folder holds (lib/peer/cards.mjs looks for them).
export function sessionFolders(repo, tasks, { clones = [], now = Date.now() } = {}) {
  const out = new Map(), owned = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const folder = ownFolder(repo, task, now); out.set(task.id, folder);
    if (folder && !asked(task)) owned.push({ folder, at: lastOf(task) });
  }
  const list = [...new Set((Array.isArray(clones) ? clones : []).filter(folder => typeof folder === 'string' && path.isAbsolute(folder)))];
  const named = () => { const name = path.basename(repo.root).toLowerCase(); return list.find(folder => path.basename(folder).toLowerCase() === name) ?? null; };
  const main = list.length === 1 ? list[0] : list.length > 1 ? owned.sort((a, b) => b.at - a.at)[0]?.folder ?? named() : null;
  if (main) for (const [id, folder] of out) if (!folder) out.set(id, main);
  return out;
}
// "owner/name" from host/owner/name, for a board's label.
export function repoName(remote) {
  const parts = String(remote ?? '').split('/').filter(Boolean).slice(1);
  return parts.slice(-2).join('/').replace(/[^A-Za-z0-9._/-]/g, '').slice(-60) || 'repository';
}
// A folder's repository: { repoId, name }, or null for no repository, no origin remote, or
// the home folder and above. Read again at most every minute.
const remotes = new Map();
export function folderRemote(folder, now = Date.now()) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return null;
  const kept = remotes.get(folder); if (kept && now - kept.at < 60000 && now >= kept.at) return kept.value;
  let value = null;
  try {
    if (!homeOrAbove(folder) && fs.existsSync(folder)) {
      const result = git(folder, ['config', '--get', 'remote.origin.url'], { allowFailure: true }), remote = result.status === 0 ? normalizeRemote(result.stdout) : null;
      value = remote ? { repoId: hash(remote), name: repoName(remote) } : null;
    }
  } catch { value = null; }
  if (remotes.size > 500) remotes.clear();
  remotes.set(folder, { at: now, value }); return value;
}

// The boards of one project: its sessions' repositories, and those only teammates' cards are
// on (others: [{repoId, name, at}]). A session in no repository is on every board, as a card
// in To do is; with no repository at all the project has one board (id null). The board of
// `first` (a repository id) leads, then the project's own repository, then the others by
// their latest activity. Returns { boards: [{id, name}], of: Map(task id -> repository id or null) }.
// folders: sessionFolders for the snapshot's sessions.
export function projectBoards(repo, snapshot, { others = [], first = null, folders = null, clones = [], now = Date.now() } = {}) {
  const of = new Map(), seen = new Map(), own = folderRemote(repo.root, now), where = folders ?? sessionFolders(repo, snapshot?.tasks, { clones, now });
  const add = (id, name, at) => { const row = seen.get(id); if (row) row.at = Math.max(row.at, at); else seen.set(id, { id, name, at }); };
  for (const task of snapshot?.tasks ?? []) {
    // A teammate's question lives in its Chats thread, as on the board.
    if (asked(task)) continue;
    const found = folderRemote(where.get(task.id) ?? null, now), id = found?.repoId ?? null;
    of.set(task.id, id); if (id) add(id, found.name, lastOf(task));
  }
  for (const row of others) if (row?.repoId) add(row.repoId, row.name, time(row.at));
  if (own) add(own.repoId, own.name, 0);
  if (!seen.size) add(null, null, 0);
  const rank = row => first && row.id === first ? 0 : own && row.id === own.repoId ? 1 : 2;
  const boards = [...seen.values()].sort((a, b) => rank(a) - rank(b) || b.at - a.at).map(row => ({ id: row.id, name: row.id ? row.name ?? 'repository' : 'No repository' }));
  return { boards, of };
}
// What one board holds of the project's own: its sessions, the cards started from them, and
// what is in no repository (sessions that work in none, cards in To do, requests not started,
// a started card whose session has not begun). With one board, everything.
export function boardSlice(kanban, snapshot, boardId, { boards, of }) {
  if (boards.length <= 1) return { kanban, snapshot };
  const on = id => { const board = of.get(id) ?? null; return board === null || board === boardId; };
  const tasks = (snapshot.tasks ?? []).filter(task => on(task.id));
  const cards = kanban.cards.filter(card => !card.taskId || on(card.taskId));
  return { kanban: { ...kanban, cards }, snapshot: { ...snapshot, tasks } };
}
