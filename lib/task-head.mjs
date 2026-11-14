import { git, head, currentBranch, notesSpec } from './git.mjs';
import { lock, readTask, saveTask, event } from './state.mjs';
import { closeTask } from './plan.mjs';

// A session's work is where its folder's HEAD is. ELU keeps the commit it last saw there in
// the session's record (commit; its base until something is committed), and what is
// committed there (committed: the branch, whether anything is left uncommitted, whether a
// remote branch holds it).
// A commit the agent makes in its own turn is the session's work: it is taken in when the
// turn ends, with no word about it, and the checks, the review and /publish go on from it.
// A HEAD that moved while nothing ran, such as a commit the owner made there himself, is
// taken in the same way by whatever needs it next (a message, the checks, /publish), with
// one line in the chat that names what changed. Neither is ever a reason to stop.

const edits = task => Boolean(task) && task.kind !== 'conversation' && typeof task.base === 'string' && typeof task.worktree === 'string';
const short = commit => String(commit ?? '').slice(0, 7);
const known = task => task.commit ?? task.base;
// The commit the session's folder is at; null for a chat with no folder, or one that is gone.
export function headNow(task) {
  if (!edits(task)) return null;
  try { return head(task.worktree); } catch { return null; }
}
const branchNow = task => { try { return currentBranch(task.worktree) || null; } catch { return null; } };
// What is committed there, read from the folder; null while it is at its base.
function committedThere(task, now) {
  if (now === task.base) return null;
  const left = git(task.worktree, ['status', '--porcelain', '--', ...notesSpec(task)], { allowFailure: true });
  const remote = git(task.worktree, ['for-each-ref', '--count=1', '--contains', now, '--format=%(refname)', 'refs/remotes'], { allowFailure: true });
  return { branch: branchNow(task), clean: left.status === 0 && !left.stdout.trim(), pushed: remote.status === 0 && Boolean(remote.stdout.trim()) };
}
// Takes the folder's HEAD as the session's commit and reads what is committed there. true
// when the record changed; the caller saves it.
export function takeHead(task, now = headNow(task)) {
  if (!now) return false;
  const before = JSON.stringify([task.commit ?? null, task.committed ?? null]), same = now === known(task);
  if (!same) task.commit = now;
  const there = committedThere(task, now);
  // A commit seen on a remote stays pushed: GitHub may hold it with no branch here that
  // follows it (lib/publish.mjs alreadyPublished).
  if (there && same && task.committed?.pushed === true) there.pushed = true;
  if (there) task.committed = there; else delete task.committed;
  return JSON.stringify([task.commit ?? null, task.committed ?? null]) !== before;
}
// A HEAD that moved while no turn of the session ran, in one line: the branch, how many
// commits are new, and where it is now. null when it is where ELU last saw it.
export function movedLine(task, now = headNow(task)) {
  const from = task ? known(task) : null;
  if (!now || now === from) return null;
  const count = range => { const run = git(task.worktree, ['rev-list', '--count', range], { allowFailure: true }); return run.status === 0 ? Number(run.stdout.trim()) : null; };
  const ahead = count(`${from}..${now}`), behind = count(`${now}..${from}`);
  const what = ahead && behind === 0 ? `${ahead} new ${ahead === 1 ? 'commit' : 'commits'}, now at ${short(now)}` : `now at ${short(now)}, was at ${short(from)}`;
  return `${branchNow(task) ?? 'The editing workspace'} moved outside this session: ${what}.`;
}
// What an open session at rest in a workspace of its own shows while that is so, with the one
// thing to do. In the owner's own checkout (here) his commits are everyday: the session says
// so only when it goes on from them. Asked on every redraw, so the folder is read at most
// every two seconds.
export const MOVED_ACTION = 'Type continue to go on from there.';
const looked = new Map();
export function restingMove(task, at = Date.now()) {
  if (!edits(task) || task.place?.kind === 'here' || ['running', 'preparing'].includes(task.state) || task.committed?.unread) return null;
  const seen = looked.get(task.worktree), from = known(task);
  if (!seen || seen.from !== from || at - seen.at > 2000) looked.set(task.worktree, { at, from, line: movedLine(task) });
  const line = looked.get(task.worktree).line;
  return line ? `${line} ${MOVED_ACTION}` : null;
}
// Before something goes on from the folder (a turn, the checks, /publish): a HEAD that moved
// outside the session's turns is taken in, and the chat says what changed. A session an
// earlier version left stopped on its own commit (unread, lib/state.mjs) is taken in with no
// line: that commit was its own. Returns the HEAD, or null for a chat with no folder.
export function settleHead(repo, task) {
  const now = headNow(task);
  if (!now) return null;
  const line = task.committed?.unread ? null : movedLine(task, now);
  if (line) (task.messages ??= []).push({ at: new Date().toISOString(), text: `${line} The session goes on from there.`, from: 'ELU' });
  if (takeHead(task, now) || line) { saveTask(repo, task); if (line) event(repo, 'head-moved', { taskId: task.id, note: 'went on from a commit made outside the session' }); }
  return now;
}
// After a turn of the session's own: what it committed is the session's work.
export function ownTurn(repo, task) {
  try { if (takeHead(task)) saveTask(repo, task); } catch { /* The next look takes it in. */ }
}
// The branch the session's work is on: the one its folder is on when the agent switched it.
export const workBranch = task => task?.committed?.branch || task?.branch || null;
// A session whose work is all committed, with no error, no failed check and no review that
// still asks for fixes, has finished: nothing of it waits for the owner. One whose project
// has passing checks is ready, and says so itself.
export const finished = task => task?.state === 'unverified' && !task.error?.message && Boolean(task.committed) && task.committed.clean !== false
  && task.reviewStatus !== 'blocked' && !(task.evidence?.results ?? []).some(row => row?.status === 'failed');
// The session's state in a word, where a view names it.
export const stateWord = task => finished(task) ? 'committed' : task.state;
// /publish pushed the commit the session is at.
export const published = task => typeof task?.commit === 'string' && task.pushedCommit === task.commit;
// What a ready session says of publishing it, in the status line and under its chat: pushed,
// by the agent or by /publish, with the pull request ELU knows for it; else what /publish does.
export function publishWords(task) {
  if (task?.committed?.pushed !== true && !published(task)) return '/publish to review push';
  return typeof task.pr === 'string' && task.pr ? `pushed · ${task.pr}` : 'pushed · /publish opens a draft pull request';
}
// Where the session's work is, in one line; null when nothing is committed.
export function committedLine(task) {
  const work = task?.committed;
  if (!work) return null;
  const what = ['Committed', work.branch ? `on ${work.branch}` : '', typeof task.commit === 'string' ? `at ${short(task.commit)}` : ''].filter(Boolean).join(' ');
  if (work.clean === false) return `${what}. Some edits are not committed: /changes shows them.`;
  // Pushed by the agent (a remote branch holds it) or by /publish (pushedCommit), with the
  // pull request ELU knows for it.
  if (work.pushed === true || published(task)) return `${what} and pushed.${typeof task.pr === 'string' && task.pr ? ` Pull request: ${task.pr}` : ''}`;
  return work.pushed === false ? `${what}, not pushed. /publish pushes it${task.pr ? '' : ' and opens a draft pull request'}.` : `${what}.`;
}
// A session an earlier version left stopped on its own commit reads as finished at once
// (lib/state.mjs). Here its commit is taken in and its Task closed, once, when the app next
// reads it. No turn runs. Tried once in a run of the app, and again only while a turn holds
// the session.
const settled = new Set();
export function settleFinished(repo, id) {
  const key = `${repo.state}\0${id}`;
  if (settled.has(key)) return false;
  let release;
  try { release = lock(repo, `task-${id}`); } catch { return false; }
  settled.add(key);
  try {
    const task = readTask(repo, id);
    if (!task.committed?.unread) return false;
    if (!takeHead(task)) { const { unread: _unread, ...rest } = task.committed; task.committed = rest; }
    saveTask(repo, task); closeTask(repo, id); event(repo, 'own-commit-settled', { taskId: task.id, note: 'finished: its own commit is taken in' });
    return true;
  } catch { return false; } finally { release(); }
}
