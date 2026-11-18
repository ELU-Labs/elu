// What the conductor does for work that outlives a turn, at each of its looks (docs/jobs.md):
// it tells a session that its long jobs ended (lib/jobs.mjs), and starts again a
// session whose Task's objectives are not all met while nothing runs (lib/keep-going.mjs).
// Both read ELU's own records and send a message the way a message of the owner's waits in the
// session's queue (lib/elu-sent.mjs): no model runs until that message starts a turn.
import { lock, readTask } from './state.mjs';
import { personalDirectory } from './util.mjs';
import { readBoard, sessionClosed } from './kanban.mjs';
import { pendingRequests, takeRequest } from './workspace.mjs';
import { sessionWorker } from './bots.mjs';
import { endSessionJobs, jobsWait, markTold, settleJob, waitingJobs } from './jobs.mjs';
import { jobsEndedText, sentByElu } from './elu-sent.mjs';
import { keepGoingWaits, lookKeepGoing } from './keep-going.mjs';

// Jobs that end within this long of each other are told in one message.
export const JOIN_MS = 4000;
// The owner stopped the session himself: it gets no turn until he writes to it.
// (As lib/stop-line.mjs reads his stop.)
const ownerStopped = task => { const message = String(task.error?.message ?? '').trim(); return /^Stopped by the owner\.?$/i.test(message) || task.state === 'stopped' && /\baborted\b/i.test(message); };
// One look at the jobs that run or wait to be told. A session whose jobs ended gets one message
// for all of them, to its working agent: a turn that is running takes it as it takes the
// owner's messages, and one that cannot leaves it in the queue, where it starts the next turn.
// A session the owner moved to Done, archived or stopped gets none. Returns { running, told }:
// running counts every job that still runs or waits its few seconds to be told.
export function lookJobs({ enqueue, projects, now = Date.now(), joinMs = JOIN_MS } = {}) {
  let sessions = []; try { sessions = waitingJobs(); } catch { return { running: 0, told: 0 }; }
  let running = 0, told = 0, repos = null;
  for (const session of sessions) {
    const ended = session.jobs.filter(job => job.state === 'ended');
    running += session.jobs.length - ended.length;
    if (!ended.length) continue;
    if (now - Math.max(...ended.map(job => Date.parse(job.endedAt) || 0)) < joinMs) { running += ended.length; continue; }
    try {
      if (!repos) { try { repos = projects(); } catch { repos = []; } }
      const repo = repos.find(row => row.root === session.root && (!session.state || row.state === session.state)) ?? (session.state ? { root: session.root, state: session.state } : null);
      let task = null; try { task = repo ? readTask(repo, session.taskId) : null; } catch { task = null; }
      let silent = !task;
      if (task && !silent) { try { silent = sessionClosed(readBoard(repo), task); } catch { silent = false; } silent ||= ownerStopped(task); }
      const settled = ended.map(job => settleJob(job.dir, job.name) ?? job);
      if (!silent) {
        let worker = null; try { worker = sessionWorker(task, { waiting: pendingRequests(session.root) }); } catch { worker = null; }
        enqueue(session.root, jobsEndedText(settled), { continuationTaskId: String(session.taskId), priority: 0, ...(worker ? { bot: worker } : {}) });
        told++;
      }
      for (const job of settled) markTold(job.dir, job.name, silent ? 'none' : 'turn');
    } catch { /* Told at the next look. */ }
  }
  return { running, told };
}
// Both looks, for the conductor: jobs every second, the keep-going check every 20 s. Only one
// conductor looks at a time (one that works beside another leaves it to that one's lock).
// Returns whether anything still waits on a later look, so the conductor stays for it.
// state: the conductor's own, kept between looks; a test sets its times (jobsEveryMs,
// keepEveryMs, joinMs, idleMs).
export function lookLongWork(state, { enqueue, projects, now = Date.now() } = {}) {
  overseerLog();
  if (now - (state.jobsAt ?? 0) < (state.jobsEveryMs ?? 1000)) return state.waits === true;
  state.jobsAt = now;
  let release = null; try { release = lock({ state: personalDirectory() }, 'long-work'); } catch { return state.waits === true; }
  try {
    const jobs = lookJobs({ enqueue, projects, now, ...(state.joinMs !== undefined ? { joinMs: state.joinMs } : {}) });
    if (now - (state.keepAt ?? 0) >= (state.keepEveryMs ?? 20000)) { state.keepAt = now; try { state.pending = lookKeepGoing({ enqueue, projects, now, ...(state.idleMs !== undefined ? { idleMs: state.idleMs } : {}) }).pending; } catch { state.pending = 0; } }
    state.waits = jobs.running > 0 || (state.pending ?? 0) > 0;
  } finally { release(); }
  return state.waits;
}
// Whether work of this kind waits while no conductor runs: one starts for it.
export const longWorkWaits = () => { try { return jobsWait() || keepGoingWaits(); } catch { return false; } };
// The log of the bot that oversees the sessions (lib/orchestrator-actions.mjs), loaded when the
// conductor first looks and never on import: undefined until asked for, null while it loads or
// when it could not, then the module.
let actions;
function overseerLog() {
  if (actions === undefined) { actions = null; import('./orchestrator-actions.mjs').then(mod => { actions = mod; }, () => { /* Its notes are still taken back, below. */ }); }
  return actions;
}
// The owner's Stop of a session ends its jobs too, and what ELU had sent it by itself and it
// had not read yet goes: a session he stopped gets no turn from ELU. A message with the same
// words from a teammate or another computer on the project is theirs, and stays. So do the
// notes the bot that oversees the sessions sent it (overseer): its log says they were taken
// back (takeBackNotes) where it is loaded. Where it is not yet, they go all the same, and its
// log says so once it is (noteTakenBack), so they count against none of the bot's caps.
export function stopLongWork(root, taskId) {
  try { overseerLog()?.takeBackNotes(root, taskId); } catch { /* Taken back below. */ }
  const notes = [];
  try { for (const row of pendingRequests(root)) if (String(row.continuationTaskId) === String(taskId) && row.state === 'queued' && (sentByElu(row.goal) && !row.computer && !row.origin || typeof row.overseer === 'string')) { if (takeRequest(root, row.id) && typeof row.overseer === 'string') notes.push(row.id); } } catch { /* It starts as any waiting message does. */ }
  if (notes.length) import('./orchestrator-actions.mjs').then(mod => mod.noteTakenBack(notes)).catch(() => { /* Not said in the log: the notes are gone all the same. */ });
  try { return endSessionJobs(root, taskId, { by: 'stop' }); } catch { return []; }
}
