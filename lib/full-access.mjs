import { isPeerRun } from './modes.mjs';
import { answerApproval, awaitDecision } from './approvals.mjs';

// Full access asks the owner nothing and refuses nothing. A turn that starts in it is launched
// so, and what its vendor still asks is allowed at once by the relay it asks through: the
// approval relay (lib/approval-server.mjs, --mode full) or Claude Code's own output
// (lib/runner.mjs controlRelay).
//
// This file is for the other turn: one that started in Ask for approval or Approve for me,
// in a session the owner set to Full access while it worked. What that turn asks is allowed
// from then on, the request that waits and the ones it asks next, a removal, an MCP tool and
// a push among them. The relay does it itself, so it holds with the app closed; the app
// answers the same requests while it is open (lib/terminal.mjs allowForFull).
//
// Whose turn that is, is the app's own test (lib/terminal.mjs fullAllowed and turnMode): the
// owner's own session, for its model or a bot of its chat. Never a teammate's question, a
// session from before modes, or a bot's scheduled turn, which runs with Approve for me at
// most. And only a turn that began below Full access because the session was below it: one
// that began in a session already in Full access and runs below it was lowered on purpose (a
// bot's schedule, a Standup's own round), and stays so.
const isBot = role => typeof role === 'string' && role.startsWith('bot:');
const scheduledTurn = (task, role) => isBot(role) && (task.messages ?? []).findLast(row => row.to === `@${role.slice(4)}`)?.scheduled === true;
// The mode the turn in progress started with: the session's before the first switch made
// since the turn began.
function turnMode(task) {
  const times = [task.activeSince, (task.messages ?? []).findLast(row => !row.from)?.at].map(value => Date.parse(value ?? '')).filter(Number.isFinite);
  const first = times.length ? (task.permissionChanges ?? []).find(row => Date.parse(row.at) > Math.max(...times)) : null;
  return first ? first.from : task.permissions ?? null;
}
// task: the session as it is saved now, with the settings changed while its turn holds it
// (readTask). role: who asks, lead or bot:<name>.
export const switchedToFull = (task, role) => Boolean(task) && task.permissions === 'full' && task.state === 'running' && !isPeerRun(task.origin)
  && (!role || role === 'lead' || isBot(role)) && !scheduledTurn(task, role) && ['ask', 'auto'].includes(turnMode(task));

const LOOK_MS = 500;
// Waits for the owner's answer to a request, as awaitDecision does. full: whether the session
// has been set to Full access since (above), asked again while the request waits; once it
// has, the request is answered for the owner. Returns { decision }, with by: 'full' when that
// is what answered it. Both write the answer once, so the first of the two stands.
export async function awaitOrFull(id, full, options = {}) {
  let mine = false;
  const look = () => {
    if (mine) return;
    let now = false; try { now = full() === true; } catch { now = false; }
    if (now) { try { mine = answerApproval(id, 'allow'); } catch { /* It stays the owner's to answer. */ } }
  };
  const timer = typeof full === 'function' ? setInterval(look, LOOK_MS) : null;
  try { const decision = await awaitDecision(id, options); return { decision, ...(mine && decision === 'allow' ? { by: 'full' } : {}) }; }
  finally { if (timer) clearInterval(timer); }
}
