import fs from 'node:fs';
import path from 'node:path';
import { hash, homeOrAbove } from './util.mjs';
import { git } from './git.mjs';
import { normalizeRemote } from './peer/shares.mjs';

// Which repository each session works in, so a project whose folder holds several
// repositories (a parent folder, the home folder) has one Kanban board for each. A session's
// repository is the one its editing workspace belongs to (task.repository, else the project),
// told apart by its origin remote: the same repository on every machine has the same id.

// The folder a session's repository is read from: the repository its edit runs in, else the project.
export const sessionFolder = (repo, task) => typeof task?.repository === 'string' && path.isAbsolute(task.repository) ? task.repository : repo.root;
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
export const sessionRemote = (repo, task, now = Date.now()) => folderRemote(sessionFolder(repo, task), now);

// The boards of one project: its sessions' repositories, and those only teammates' cards are
// on (others: [{repoId, name, at}]). A session in no repository is on every board, as a card
// in To do is; with no repository at all the project has one board (id null). The board of
// `first` (a repository id) leads, then the project's own repository, then the others by
// their latest activity. Returns { boards: [{id, name}], of: Map(task id -> repository id or null) }.
const time = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : 0; };
const lastOf = task => Math.max(time(task.createdAt), ...(task.runs ?? []).map(run => time(run.at)), ...(task.messages ?? []).map(row => time(row.at)));
export function projectBoards(repo, snapshot, { others = [], first = null, now = Date.now() } = {}) {
  const of = new Map(), seen = new Map(), own = folderRemote(repo.root, now);
  const add = (id, name, at) => { const row = seen.get(id); if (row) row.at = Math.max(row.at, at); else seen.set(id, { id, name, at }); };
  for (const task of snapshot?.tasks ?? []) {
    // A teammate's question lives in its Chats thread, as on the board.
    if (['ask', 'review'].includes(task.origin?.kind)) continue;
    const found = folderRemote(sessionFolder(repo, task), now), id = found?.repoId ?? null;
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
