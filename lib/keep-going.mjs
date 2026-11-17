// Keep going until the goal is met (docs/jobs.md). A session whose approved Task has
// objectives not all met, with nothing running for it and nothing it waits on the owner for,
// is started again after a few idle minutes: ELU sends its working agent one message
// (KEEP_GOING_TEXT, lib/elu-sent.mjs). The check is ELU reading its own records on a timer in
// the conductor (lib/long-work.mjs): no model call, and no schedule.
//
// It is a switch of the session: on where the session has Full access or Approve for me, off
// in Ask for approval, and off in a schedule's run and a bot's own chat until the owner turns
// it on (/keepgoing, elu sessions keep-going). No token loop: when two such turns in a row
// end with no progress (no objective newly met, no job started, no change in its folder), ELU
// stops starting it, and the session waits for the owner, with one line that says why. His
// next message starts the count again.
//
// What is kept is beside the session's record, in keep-going.json: { on, sent, flat, mark,
// lastAt, stopped }. An earlier ELU reads none of it.
import fs from 'node:fs';
import path from 'node:path';
import { atomic, noSymlinks, personalDirectory, readJson } from './util.mjs';
import { readTask, taskDir, waitLock } from './state.mjs';
import { openTask, sessionTasks, waitingTask } from './plan.mjs';
import { lastActivity, readBoard, sessionClosed } from './kanban.mjs';
import { pendingRequests } from './workspace.mjs';
import { pendingApprovals } from './approvals.mjs';
import { stopLine } from './stop-line.mjs';
import { isPeerRun } from './modes.mjs';
import { usesSavedRules } from './permission-rules.mjs';
import { sessionWorker } from './bots.mjs';
import { blockedRows } from './blocked.mjs';
import { headNow } from './task-head.mjs';
import { PROJECT_NOTES, changed, head as folderHead, taskChanges } from './git.mjs';
import { KEEP_GOING_TEXT, STOPPED_LINE, sentByElu } from './elu-sent.mjs';
import { jobsDir, listJobs, stoppedNotes } from './jobs.mjs';

// A few idle minutes, and how many turns in a row with no progress end it.
export const IDLE_MS = 3 * 60000, FLAT_TURNS = 2;
export { STOPPED_LINE };
// What the switch says of itself, where the owner reads or changes it (/keepgoing, elu sessions keep-going).
export const KEEP_ON = "Keep going is on: ELU starts this session again while its Task's objectives are not all met and nothing is running.";
export const KEEP_OFF = 'Keep going is off: ELU does not start this session again by itself while its Task is not met.';
export const keepGoingFile = (repo, id) => path.join(taskDir(repo, id), 'keep-going.json');
const iso = ms => new Date(ms).toISOString();
const time = value => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : 0; };
export function readKeepGoing(repo, id) {
  try { const file = keepGoingFile(repo, id); noSymlinks(file); if (!fs.existsSync(file)) return {}; const value = readJson(file); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
function change(repo, id, alter) {
  const release = waitLock(repo, `keep-going-${id}`, 200);
  try { const value = readKeepGoing(repo, id); alter(value); atomic(keepGoingFile(repo, id), value); return value; } finally { release(); }
}
// The switch as it stands: what the owner chose, else on in Full access and Approve for me,
// but not in a schedule's run or a bot's own chat.
export function keepsGoing(task, kept = {}) {
  if (typeof kept.on === 'boolean') return kept.on;
  return ['auto', 'full'].includes(task?.permissions) && !task.scheduleId && !task.botChat;
}
// The owner turns it on or off. Turning it on starts the count again.
export function setKeepGoing(repo, id, on) {
  return change(repo, id, value => { value.on = on === true; value.chosenAt = iso(Date.now()); if (on) { delete value.stopped; value.flat = 0; } });
}
// When the owner last wrote to the session himself: his messages there, not ELU's lines.
const ownerAt = task => Math.max(0, ...(task.messages ?? []).filter(row => !row.from && !row.bot && !row.loop && !row.line && !row.standup && !row.update && !sentByElu(row.text)).map(row => time(row.at)));
// Why ELU stopped starting it, while that still holds: { at, text }, or null. A message of
// his since then ends it.
export function keepGoingStop(task, kept = {}) {
  const stopped = kept?.stopped;
  if (!stopped || typeof stopped.at !== 'string' || ['running', 'preparing'].includes(task?.state)) return null;
  return ownerAt(task) > time(stopped.at) ? null : { at: stopped.at, text: STOPPED_LINE };
}
// The owner's own computer keeps when this check first ran here, and how many sessions it
// waits on: a session whose last activity is older than that first look is left as it was (an
// update never starts old sessions by itself), until it works again or he turns its switch on.
const ownFile = () => path.join(personalDirectory(), 'keep-going.json');
function own() { try { const file = ownFile(); noSymlinks(file); return fs.existsSync(file) ? readJson(file) ?? {} : {}; } catch { return {}; } }
function since(now) {
  const kept = own();
  if (typeof kept.since === 'string' && time(kept.since)) return time(kept.since);
  try { atomic(ownFile(), { ...kept, since: iso(now) }); } catch { /* Asked again at the next look. */ }
  return now;
}
// Whether any session waits for its idle minutes to pass: a conductor stays, or starts, for it.
export function keepGoingWaits() { const kept = own(); return Number.isInteger(kept.pending) && kept.pending > 0; }
function notePending(pending) { try { const kept = own(); if ((kept.pending ?? 0) !== pending) atomic(ownFile(), { ...kept, pending }); } catch { /* Counted again at the next look. */ } }

// What shows progress between two looks: the objectives met, the jobs started, and where the
// session's folder stands (its commit and what is changed in it). A chat has no folder of its
// own: it works in the project folder itself, and what is committed and changed there counts
// for it the same way.
function progressMark(repo, task, plan) {
  let jobs = []; try { jobs = listJobs(jobsDir(repo, task.id)).map(job => `${job.name}@${job.startedAt}`); } catch { jobs = []; }
  let head = null, digest = null;
  if (task.kind !== 'conversation' && typeof task.worktree === 'string') { try { head = headNow(task); } catch { head = null; } try { digest = taskChanges(task).digest ?? null; } catch { digest = null; } }
  else if (typeof task.worktree === 'string' && task.worktree) { try { head = folderHead(task.worktree); digest = changed(task.worktree, head, { ignored: false, exclude: PROJECT_NOTES }).digest ?? null; } catch { digest = null; } }
  return JSON.stringify({ task: plan.id, revision: plan.revision ?? 1, met: [...plan.met].sort((a, b) => a - b), jobs, head, digest });
}
// Where a session stands for this check: { go: false, why } when it is not started (why: one
// word, for the tests), or { go: true, plan, kept, idleFrom }. requests: the project's waiting
// messages; board: its board; first: when the check first ran on this computer.
export function standing(repo, task, { requests = [], board = null, first = 0, approvals = null } = {}) {
  const no = why => ({ go: false, why });
  if (!task || isPeerRun(task.origin) || !usesSavedRules(task.origin) || task.standup) return no('not-own');
  const kept = readKeepGoing(repo, task.id);
  if (!keepsGoing(task, kept)) return no('off');
  if (['running', 'preparing'].includes(task.state)) return no('working');
  const rows = sessionTasks(repo, task.id), plan = openTask(rows);
  if (waitingTask(rows)) return no('task-proposed');
  if (!plan) return no('no-task');
  if (!plan.objectives.length || plan.met.length >= plan.objectives.length) return no('met');
  // It waits for the owner: a question, a result that says it needs him (the session's state
  // is its last result's), a stop, a limit of its vendor or credits it waits out, a spending limit.
  if (task.state === 'needs_input') return no('asks');
  if (['blocked', 'stopped'].includes(task.state) || stopLine(task)) return no('stopped');
  // Its last working turn left a Blocked line (lib/blocked.mjs): a command no mode but Full
  // access allows, or an approval nobody answered. That is his to do or to answer, and the
  // line stays until he writes to it.
  let refused = []; try { refused = blockedRows(task); } catch { refused = []; }
  if (refused.length) return no('blocked');
  if (keepGoingStop(task, kept)) return no('no-progress');
  if (board && sessionClosed(board, task)) return no('closed');
  const id = String(task.id);
  if (requests.some(row => [row.continuationTaskId, row.taskId].some(value => value != null && String(value) === id) && ['queued', 'starting', 'running', 'blocked', 'waiting'].includes(row.state))) return no('queued');
  let asked = approvals; if (asked === null) { try { asked = pendingApprovals({ taskId: id }); } catch { asked = []; } }
  if (asked.some(row => String(row.taskId) === id)) return no('approval');
  let jobs = []; try { jobs = listJobs(jobsDir(repo, task.id)); } catch { jobs = []; }
  if (jobs.some(job => job.state === 'running' || !job.told)) return no('job');
  // His own Stop ended its jobs while no turn ran (lib/long-work.mjs): it waits for him as one
  // whose turn he stopped, until he writes to it.
  let stops = []; try { stops = stoppedNotes(jobsDir(repo, task.id)); } catch { stops = []; }
  if (stops.some(row => row.by === 'stop' && time(row.at) > ownerAt(task))) return no('stopped');
  const idleFrom = Math.max(lastActivity(task), ...jobs.map(job => time(job.endedAt)));
  // Old sessions stay as an update found them, unless he turned the switch on himself.
  if (idleFrom < first && kept.on !== true) return no('before');
  return { go: true, plan, kept, idleFrom };
}
// A turn of this session ended in a conductor that exits with it (an update replaced that one,
// lib/conductor.mjs): while the check would start the session again it is counted as waiting, so
// a conductor starts for it (keepGoingWaits). True when it is.
export function expectKeepGoing(repo, id, now = Date.now()) {
  try {
    if (!standing(repo, readTask(repo, String(id)), { requests: pendingRequests(repo.root), board: readBoard(repo), first: since(now) }).go) return false;
    const kept = own(); atomic(ownFile(), { ...kept, pending: Math.max(1, kept.pending ?? 0) });
    return true;
  } catch { return false; }
}
// Where its work stands since ELU last started it: { mark, flat }. flat: how many turns ELU
// started in a row that ended with no progress, this last one counted; a message of the owner's
// since then starts the count again.
function progress(repo, task, { plan, kept }) {
  const mark = progressMark(repo, task, plan), wrote = ownerAt(task) > time(kept.lastAt);
  return { mark, flat: kept.sent && !wrote && kept.mark === mark ? (kept.flat ?? 0) + 1 : 0 };
}
// Two such turns in a row made no progress: ELU stops starting it, and the session says why.
function giveUp(repo, task, flat, now) { change(repo, task.id, value => { value.stopped = { at: iso(now), flat }; value.flat = flat; }); }
// Its idle minutes have passed: ELU starts it again, with one message to its working agent.
function start(repo, root, task, { mark, flat }, { enqueue, now }) {
  let worker = null; try { worker = sessionWorker(task, { waiting: pendingRequests(root) }); } catch { worker = null; }
  change(repo, task.id, value => { value.sent = (value.sent ?? 0) + 1; value.flat = flat; value.mark = mark; value.lastAt = iso(now); delete value.stopped; });
  enqueue(root, KEEP_GOING_TEXT, { continuationTaskId: String(task.id), priority: 0, ...(worker ? { bot: worker } : {}) });
}
// A session that cannot be started until one of its files changes is not read again before then.
const settled = new Map();
const stamp = files => files.map(file => { try { const stat = fs.statSync(file); return `${stat.mtimeMs}:${stat.size}`; } catch { return '-'; } }).join('|');
const LASTING = new Set(['not-own', 'off', 'no-task', 'met', 'task-proposed', 'asks', 'stopped', 'no-progress', 'before']);
// The check, over every project: { pending, sent, stopped }. pending: sessions whose idle
// minutes have not passed yet. projects: () => the projects' repos.
export function lookKeepGoing({ enqueue, projects, now = Date.now(), idleMs = IDLE_MS } = {}) {
  const first = since(now);
  let pending = 0, sent = 0, stopped = 0, repos = []; try { repos = projects(); } catch { repos = []; }
  for (const repo of repos) {
    let ids = []; try { const folder = path.join(repo.state, 'tasks'); noSymlinks(folder); ids = fs.readdirSync(folder).filter(id => /^[1-9][0-9]*$/.test(id)); } catch { continue; }
    let requests = null, board = null, approvals = null;
    for (const id of ids) {
      try {
        const dir = taskDir(repo, id);
        // No Task, no check: most sessions end here, with one look at one file.
        if (!fs.existsSync(path.join(dir, 'plan.json'))) continue;
        const key = `${dir}`, mark = stamp(['task.json', 'plan.json', 'keep-going.json', 'settings.json'].map(name => path.join(dir, name)));
        if (settled.get(key) === mark) continue;
        const task = readTask(repo, id);
        requests ??= (() => { try { return pendingRequests(repo.root); } catch { return []; } })();
        board ??= (() => { try { return readBoard(repo); } catch { return { cards: [], done: [], closed: {}, archived: [], checked: {} }; } })();
        approvals ??= (() => { try { return pendingApprovals(); } catch { return []; } })();
        const at = standing(repo, task, { requests, board, first, approvals });
        if (!at.go) { if (LASTING.has(at.why)) { if (settled.size > 5000) settled.clear(); settled.set(key, mark); } continue; }
        const due = now - at.idleFrom >= idleMs;
        // One ELU started before is looked at as soon as its turn has ended: no progress twice, and it stops there.
        const seen = due || at.kept.sent ? progress(repo, task, at) : null;
        if (seen && seen.flat >= FLAT_TURNS) { giveUp(repo, task, seen.flat, now); stopped++; continue; }
        if (!due) { pending++; continue; }
        start(repo, repo.root, task, seen, { enqueue, now }); sent++; requests = null;
      } catch { /* Read again at the next look. */ }
    }
  }
  notePending(pending);
  return { pending, sent, stopped };
}
