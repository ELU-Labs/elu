import { readTask } from '../state.mjs';
import { registeredProjects } from '../projects.mjs';
import { stopLine } from '../stop-line.mjs';
import { VENDOR_NAMES } from '../vendors.mjs';
import { bothMine } from './mine.mjs';
import { peerBox, peerPolicy } from './settings.mjs';
import { prepareOutgoing } from './secrets.mjs';
import { sanitize } from './peerdata.mjs';

// Why a session that a message from another computer started could not answer, said for
// the one who sent it. It is the stop line this computer shows its own user
// (lib/stop-line.mjs), with the one thing to do put for a reader who is not here: it names
// this computer, and where sending the message again is all there is to do it says that.
// A teammate gets it with paths cut and no account named; the owner's other computers get
// both as they are. A reason that may hold a secret stays here.
const AGAIN = 'Send it again.';
// A sender on 0.1.19 keeps this much of a reason, so the action has to fit inside it.
const MAX = 300;
// How the reader calls this computer: a teammate by the name its owner goes by on the team,
// the owner's other computers by its machine name, as their lists show it.
export function hereName({ mine = false, name = null, box = null } = {}) {
  const person = String(name ?? '').replace(/[\s@]+/g, '').slice(0, 40), machine = String(box ?? '').replace(/[\s@]+/g, '').toLowerCase().slice(0, 40);
  const said = mine ? machine || person : person || machine;
  return said ? `@${said}` : 'that computer';
}
// The same for the computer that key is: ctx is the daemon's (me, name(key), boxName()).
export function hereFor(ctx, key) {
  const mine = bothMine(ctx.me.key, key);
  let box = null; try { box = ctx.boxName?.() ?? peerBox(); } catch { box = null; }
  return { mine, at: hereName({ mine, name: ctx.name?.(ctx.me.key) ?? ctx.me.name, box }) };
}
// A message with no project to run in waits for the owner here; its sender is told so.
export const noProject = at => `No project is set on ${at} for teammates' messages, so it waits for its owner. On ${at}: open ELU in the project teammates work in, then use /access there.`;
const CHECK = /\s*Your (?:first|next) message to it (?:outside Full access )?runs the check(?: again|; Full access needs none)?\.?$/;
// The stop line's words about the session, for someone who is not its owner.
const retold = (text, at) => text.replace(/\bYou stopped it\./, 'It was stopped.').replace(/\bYour (changes|edits) are kept\b/g, 'Its $1 are kept')
  .replace(/\bon this (?:machine|computer)\b/g, `on ${at}`).replace(/\bon your PATH\b/, 'on its PATH').replace(/^This session has\b/, 'That session has').replace(/\bin this session\b/, 'in that session').trim();
// The one thing to do, from the one the owner here is shown. What only someone at this
// computer can do names it; typing continue here is sending the message again from there.
function there(action, at, vendor) {
  const it = vendor ?? 'it', said = action.replace(/[.!?]+$/, '');
  if (/^Sign in again with |^Run \S.* to sign in\b/i.test(said)) return `Sign ${it} in on ${at}, then send it again.`;
  if (/^Install it\b/i.test(said)) return `Install ${it} on ${at}, then send it again.`;
  const then = said.match(/^(.+?),? then (?:type continue|send again)$/i);
  if (then) return `${then[1]} on ${at}, then send it again.`;
  const or = said.match(/^(.+?),? or type continue to try again$/i);
  if (or) return `${or[1]} on ${at}, or send it again.`;
  if (/^Type continue\b|^Reply to carry on$|^Start a new session with \/new$|^Ask about it here instead$/i.test(said)) return AGAIN;
  return `On ${at}: ${action}`;
}
// Where it happened, once: the action names this computer, or the reason does.
function placed(why, action, at) {
  if (why.includes(at) || action.includes(at)) return why;
  if (/\bcould not (?:finish|run)\b/.test(why)) return why.replace(/\bcould not (finish|run)\b/, `could not $1 on ${at}`);
  return /[.!?]\s/.test(why) ? `On ${at}: ${why}` : `${why.replace(/[.!?]+$/, '')} on ${at}.`;
}
// task: the session as it is kept here, when there is one. error: what its run ended with.
// stopped: someone stopped it. at: hereName(). mine: the reader is the owner's own computer.
// trusted: a teammate the owner trusts, who gets paths as written. root: the project, whose
// paths a teammate may see.
export function failureLine({ task = null, error = null, stopped = false, at = 'that computer', root = null, mine = false, trusted = false } = {}) {
  const message = typeof error === 'string' && error.trim() ? error.trim() : null;
  // The session's own error is read for its cause, its vendor and its log, when it is the
  // one this run ended with.
  const kept = task && (!message || task.error?.message === message) && stopLine(task) ? task : null;
  const subject = kept ?? (message ? { state: 'blocked', kind: 'conversation', error: { message } } : null);
  let why, action = AGAIN;
  if (stopped) why = `It was stopped on ${at} before it finished.`;
  else if (!subject) why = `The session on ${at} ended without an answer.`;
  else {
    const stop = stopLine(subject, mine ? {} : { account: () => null });
    const vendor = Object.values(VENDOR_NAMES).find(name => stop.text.includes(name)) ?? null;
    const said = stop.text.endsWith(stop.action) ? stop.text.slice(0, -stop.action.length).trim() || stop.text : stop.text;
    // The one-time check of a vendor is started only by its owner: c on its line in the Usage
    // tab runs it in any mode (his own message does only below Full access, which needs none).
    if (/\b(?:has not been checked|did not pass its check) on this machine\b/.test(said)) {
      why = retold(said.replace(CHECK, ''), at);
      action = `Run the check of ${vendor ?? 'it'} with c on its line in the Usage tab of ELU on ${at}, then send it again.`;
    } else { why = retold(said, at); action = there(stop.action, at, vendor); }
  }
  why = placed(why, action, at);
  if (why.length + action.length + 1 > MAX) why = `${why.slice(0, Math.max(0, MAX - action.length - 2)).trimEnd()}…`;
  const out = prepareOutgoing(`${why} ${action}`, { root, trusted: mine || trusted });
  return out.ok ? out.text : `The run failed on ${at}. Its reason stays there: it may hold a secret.`;
}
// For the reply to a teammate whose message started a run that failed or was stopped
// (lib/peer/replies.mjs): entry is what the conductor wrote, record the message it answers.
export function failureFor(ctx, record, entry) {
  const { mine, at } = hereFor(ctx, record.peer);
  let task = null;
  if (entry.taskId != null && typeof entry.root === 'string') {
    try { const repo = registeredProjects().find(row => row.root === entry.root); task = repo ? readTask(repo, String(entry.taskId)) : null; } catch { task = null; }
  }
  return failureLine({ task, error: entry.error, stopped: entry.outcome === 'stopped', at, root: record.root, mine, trusted: peerPolicy(record.peer).trusted === true });
}
// For a session one of the owner's other computers lists or watches here
// (lib/peer/remote.mjs): the error it shows there. One that does not wait for its owner
// keeps its error as it is.
export function remoteError(task, message = task?.error?.message) {
  if (typeof message !== 'string' || !message.trim()) return null;
  if (task && !stopLine(task)) return message;
  let box = null; try { box = peerBox(); } catch { box = null; }
  return failureLine({ task, error: message, at: hereName({ mine: true, box }), mine: true });
}
// The sender's side. A teammate on 0.1.19 or earlier says only that the run failed, or
// nothing: the sender is told where, and that an update there brings the reason.
const OLD = /^The run (failed|was stopped)\.?$/;
export const askName = ask => sanitize(ask?.name, 64).replace(/[\s@]+/g, '') || String(ask?.to ?? '').slice(0, 8) || 'teammate';
export function askFailure(reason, name) {
  const said = String(reason ?? '').trim(), old = said.match(OLD);
  return said && !old ? said : `The run ${old?.[1] === 'was stopped' ? 'was stopped' : 'failed'} on @${name}. Update ELU there to see why.`;
}
// Why an ask of mine got no answer, as its row and its thread show it: one that failed
// before this release kept only "The run failed.", and is told the same way.
export const shownReason = ask => ask?.state === 'failed' ? askFailure(ask.reason, askName(ask)) : ask?.reason ?? null;
