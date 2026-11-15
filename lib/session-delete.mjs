import fs from 'node:fs';
import { atomic, isObject, mkdir, refuse } from './util.mjs';
import { event, firstLine, lock, readRemoved, readTask, removedFile, taskDir, taskPlace, taskTitle, tasks, waitLock } from './state.mjs';
import { git } from './git.mjs';
import { forgetSession, readBoard, sessionClosed } from './kanban.mjs';
import { removeSessionRequests } from './workspace.mjs';
import { runSpends } from './agent-spend.mjs';

// An archived session deleted for good: its record, its saved, queued and finished messages,
// its Kanban marks and cards, the folder ELU made for it and the branch ELU made for it. Only
// those: a branch the owner named and his own checkout stay, and nothing is ever deleted on a
// remote (a pushed branch, a pull request). What it spent stays in Usage, and its number is
// never given to a new session (lib/state.mjs readRemoved).

// Git with no hook of the repository's run: deleting a folder or a branch starts nothing of its.
const QUIET = ['-c', 'core.hooksPath=/dev/null'];
const placeKind = task => task.kind === 'conversation' ? 'none' : task.place?.kind ?? 'worktree';
const lines = text => String(text ?? '').split('\n').filter(line => line.trim()).length;

// What deleting a session would lose for good: { commits, edits }. commits: commits of the
// branch ELU made for it (and of its folder's HEAD) that are on no remote and on no other
// branch; edits: changed and new files in its folder not committed. A branch the owner named
// keeps its commits, and a session in his own checkout loses nothing.
export function unpushedWork(repo, task) {
  const kind = placeKind(task), none = { commits: 0, edits: 0 };
  if (kind === 'none' || kind === 'here') return none;
  const folder = typeof task.worktree === 'string' && fs.existsSync(task.worktree) ? task.worktree : null, root = folder ?? task.repository ?? repo.root;
  let edits = 0, commits = 0;
  if (folder) { const status = git(folder, ['status', '--porcelain', '--untracked-files=all'], { allowFailure: true }); if (status.status === 0) edits = lines(status.stdout); }
  if (kind === 'worktree' && task.branch) {
    const has = git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${task.branch}`], { allowFailure: true }).status === 0;
    const tips = [...(has ? [`refs/heads/${task.branch}`] : []), ...(folder ? ['HEAD'] : [])];
    if (tips.length) { const count = git(root, ['rev-list', '--count', ...tips, '--not', `--exclude=${task.branch}`, '--branches', '--remotes'], { allowFailure: true }); if (count.status === 0) commits = Number(count.stdout.trim()) || 0; }
  }
  return { commits, edits };
}
// One line of what that is, for the question: 2 commits not pushed and 3 files not committed.
export function unpushedText(lost) {
  const parts = [lost.commits ? `${lost.commits} commit${lost.commits === 1 ? '' : 's'} not pushed` : '', lost.edits ? `${lost.edits} file${lost.edits === 1 ? '' : 's'} not committed` : ''].filter(Boolean);
  return parts.join(' and ');
}

// What a session's runs spent, kept as runs that carry their own spend, as agentSpend reads
// them (lib/agent-spend.mjs). Read before the logs go.
function spentRuns(task) {
  const spends = runSpends(task), runs = [];
  (Array.isArray(task.runs) ? task.runs : []).forEach((run, index) => {
    const spend = spends[index]; if (!isObject(run) || !spend) return;
    runs.push({ at: run.at ?? task.createdAt ?? null, role: typeof run.role === 'string' && run.role ? run.role : 'lead', vendor: spend.vendor, model: spend.model, ownCost: true, costUsd: spend.costUsd, tokens: spend.tokens, started: spend.started, ...(run.standup ? { standup: true } : {}) });
  });
  const stops = (Array.isArray(task.stops) ? task.stops : []).filter(stop => isObject(stop) && stop.counted !== true && stop.started !== false)
    .map(stop => ({ at: stop.at ?? null, role: typeof stop.role === 'string' && stop.role ? stop.role : 'lead', vendor: stop.vendor ?? null, model: stop.model ?? null, asked: stop.asked ?? null, tokens: stop.tokens ?? null }));
  return { runs, stops };
}
// Adds what these spent to the list of deleted sessions (one already there is replaced), and
// raises the number new sessions start above. Refuses when that list cannot be read.
function keepSpent(repo, rows) {
  const release = waitLock(repo, 'removed-sessions');
  try {
    const kept = readRemoved(repo, { strict: true }), ids = new Set(rows.map(row => row.id));
    atomic(removedFile(repo), { version: 1, upTo: Math.max(kept.upTo, ...rows.map(row => Number(row.id))), sessions: [...kept.sessions.filter(row => !ids.has(String(row.id))), ...rows] });
  } finally { release(); }
}
// What deleted sessions spent, as records Usage reads beside the sessions (removed: true).
export function removedSpend(repo) {
  return readRemoved(repo).sessions.map(row => ({ id: String(row.id), title: typeof row.title === 'string' ? row.title : '', removed: true, createdAt: row.createdAt ?? null, ...(typeof row.botChat === 'string' ? { botChat: row.botChat } : {}), runs: Array.isArray(row.runs) ? row.runs : [], stops: Array.isArray(row.stops) ? row.stops : [] }));
}
// A number for a run that belongs to no session (the lessons run before a clean-up): above
// every session's, and kept, so no session ever takes it. Its spend is kept with keepRun.
export function takeRunId(repo) {
  const release = waitLock(repo, 'allocate');
  try {
    const kept = readRemoved(repo, { strict: true }), id = String(Math.max(kept.upTo, ...tasks(repo).map(task => Number(task.id))) + 1);
    mkdir(repo.state); atomic(removedFile(repo), { version: 1, upTo: Number(id), sessions: kept.sessions });
    return id;
  } finally { release(); }
}
// The spend of such a run, under its number and a title of its own, for Usage.
export function keepRun(repo, id, title, runs) {
  const task = { id, runs, createdAt: new Date().toISOString() };
  keepSpent(repo, [{ id, title, createdAt: task.createdAt, removedAt: task.createdAt, ...spentRuns(task) }]);
}

// The folder ELU made for the session, and the branch ELU made for it: never the owner's own
// checkout, never a branch he named. Folders where ELU does not make them are left alone.
function removePlace(repo, task) {
  const kind = placeKind(task);
  if (kind === 'none' || kind === 'here') return;
  if (task.worktree !== taskPlace(repo, task.id, task.repository ?? null, task.place ?? null).worktree) return;
  const root = task.repository ?? repo.root;
  if (fs.existsSync(task.worktree)) {
    const removed = git(task.worktree, [...QUIET, 'worktree', 'remove', '--force', task.worktree], { allowFailure: true });
    if (removed.status !== 0 && fs.existsSync(task.worktree)) refuse(`Its folder could not be removed: ${firstLine(removed.stderr) || 'Git refused.'}`);
  }
  git(root, ['worktree', 'prune'], { allowFailure: true });
  if (kind === 'worktree' && task.branch && git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${task.branch}`], { allowFailure: true }).status === 0) {
    const gone = git(root, [...QUIET, 'branch', '-D', task.branch], { allowFailure: true });
    if (gone.status !== 0) refuse(`Its branch ${task.branch} could not be deleted: ${firstLine(gone.stderr) || 'Git refused.'}`);
  }
}

// Deletes one archived session for good. keep: its work that is on no remote (unpushedWork)
// stays, in its folder and on its branch, and only ELU's records of it go. seen: that work as
// the owner was told it ({ commits, edits }): more of it now, which he was never asked about,
// is kept too. A session that runs or is starting is refused, and so is one that is no longer
// archived: what was checked before a lessons run is checked again here, after it. Returns
// { id, title, kept, lost }: kept the folder and branch left, or null.
export function deleteSession(repo, id, { keep = false, seen = null } = {}) {
  let release;
  try { release = lock(repo, `task-${id}`); } catch (error) { if (/holds this lock/.test(error.message)) refuse('It is running. Stop it first.'); throw error; }
  try {
    const task = readTask(repo, id);
    if (['running', 'preparing'].includes(task.state)) refuse('It is running. Stop it first.');
    let board = null; try { board = readBoard(repo); } catch { board = null; }
    if (!board || !sessionClosed(board, task)) refuse('It is no longer archived.');
    const lost = unpushedWork(repo, task), more = Boolean(seen) && (lost.commits > (seen.commits ?? 0) || lost.edits > (seen.edits ?? 0));
    const keepWork = (keep || more) && lost.commits + lost.edits > 0, title = taskTitle(task);
    // What it spent is kept first, so a step that fails after never takes it out of Usage.
    keepSpent(repo, [{ id: String(task.id), title, createdAt: task.createdAt ?? null, removedAt: new Date().toISOString(), ...(typeof task.botChat === 'string' ? { botChat: task.botChat } : {}), ...spentRuns(task) }]);
    if (!keepWork) removePlace(repo, task);
    const requests = removeSessionRequests(repo.root, task.id);
    forgetSession(repo, String(task.id), requests);
    fs.rmSync(taskDir(repo, task.id), { recursive: true, force: true });
    event(repo, 'task-deleted', { taskId: String(task.id), ...(keepWork ? { kept: true } : {}) });
    return { id: String(task.id), title, kept: keepWork ? { worktree: task.worktree, branch: task.branch ?? null } : null, lost };
  } finally { release(); }
}
