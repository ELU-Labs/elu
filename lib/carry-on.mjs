import { registeredProjects } from './projects.mjs';
import { readBoard, sessionClosed } from './kanban.mjs';
import { fromTeammate } from './modes.mjs';
import { lock, readTask, saveTask, tasks } from './state.mjs';
import { stopLine } from './stop-line.mjs';
import { CAP_CARRY_TEXT, capStopped } from './turn-limits.mjs';

// 0.1.19 and earlier stopped a turn that had run two hours, working or not, and the session
// then waited for a reply. This version has no such limit. As the app opens, each of the
// owner's own sessions that still waits where that limit stopped it, and has Approve for me
// or Full access, is carried on: ELU sends it CAP_CARRY_TEXT in the owner's place, which its
// chat shows as one line of ELU's (conversationEntries in lib/projects.mjs). Once for a
// session: it is marked before the message is sent, so a second window, or the app opened
// again before the turn starts, sends nothing more. In Ask for approval and Read only the
// session waits for the owner's reply, as does one he archived and one a teammate's message
// started; each says what stopped it (lib/stop-line.mjs).
const wanted = task => capStopped(task?.error) && task.error.carried !== true && ['auto', 'full'].includes(task.permissions) && !fromTeammate(task.origin) && Boolean(stopLine(task));
// enqueue: lib/conductor.mjs enqueue. Returns how many sessions were carried on.
export function carryOnCapped({ enqueue, projects = registeredProjects } = {}) {
  let started = 0, repos = []; try { repos = projects(); } catch { return 0; }
  for (const repo of repos) {
    let values = []; try { values = tasks(repo).filter(wanted); } catch { continue; }
    if (!values.length) continue;
    let board = null; try { board = readBoard(repo); } catch { /* An unreadable board closes nothing. */ }
    for (const task of values) {
      try {
        if (board && sessionClosed(board, task)) continue;
        // A turn that holds the session works in it already.
        let release; try { release = lock(repo, `task-${task.id}`); } catch { continue; }
        try {
          const current = readTask(repo, task.id);
          if (!wanted(current)) continue;
          current.error = { ...current.error, carried: true }; saveTask(repo, current);
        } finally { release(); }
        enqueue(repo.root, CAP_CARRY_TEXT, { continuationTaskId: String(task.id), priority: 0 }); started++;
      } catch { /* The session keeps its line, and the owner's reply carries it on. */ }
    }
  }
  return started;
}
