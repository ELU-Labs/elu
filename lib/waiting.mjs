import { requestOrder, startsAt } from './workspace.mjs';
import { sanitize } from './peer/peerdata.mjs';

// What a message that has not started waits for. The conductor notes it on the request each
// time it passes it over (waits): a free slot, with how many sessions run and how many may
// (/slots); the current turn of its own session; or a slot for teammates' work. A request
// held until a time (its notBefore: a retry) waits for that time. The chat, the Sessions list
// and the view from the owner's other computer all say it in the words below.
export const turnWait = () => ({ on: 'turn' });
export const slotWait = (running, limit) => ({ on: 'slot', running, limit });
export const teammateWait = (running, limit) => ({ on: 'teammates', running, limit });
const count = value => Number.isInteger(value) && value >= 0 && value <= 9999;
// A wait with only its own fields, each checked, or null. What another computer of the
// owner's sends is read with it too: that is his computer, but a wait's reason is free text.
export function cleanWait(value) {
  if (value?.on === 'turn') return turnWait();
  if ((value?.on === 'slot' || value?.on === 'teammates') && count(value.running) && count(value.limit)) return { on: value.on, running: value.running, limit: value.limit };
  if (value?.on !== 'time' || !Number.isFinite(Date.parse(value.until))) return null;
  const why = typeof value.why === 'string' ? sanitize(value.why, 300).replace(/\s+/g, ' ').trim() : '';
  return { on: 'time', until: new Date(Date.parse(value.until)).toISOString(), ...(why ? { why } : {}) };
}
export const sameWait = (a, b) => JSON.stringify(cleanWait(a)) === JSON.stringify(cleanWait(b));
// What a saved request waits for now, or null when nothing says: one that is not queued
// waits for nothing, and one on the running turn's input (turn, lib/runner.mjs) is that
// turn's to read after its current command, which its reason says. A time comes first: until
// then the conductor does not look at it.
export function waitOf(row, now = Date.now()) {
  if (row?.state !== 'queued' || row.turn) return null;
  const until = Date.parse(startsAt(row) ?? '');
  if (until > now) return cleanWait({ on: 'time', until: new Date(until).toISOString(), why: String(row.reason ?? '').replace(/\s*(Retrying( shortly)?|Waiting to start)\.$/, '') });
  return cleanWait(row.waits);
}
// What the next message to a session waits for before its turn starts, among its project's
// saved requests: the one that starts first, by priority then age. Never its own turn: while
// that works, its messages are counted another way (held, lib/peer/remote.mjs).
export function sessionWait(rows, taskId, now = Date.now()) {
  const [next] = rows.filter(row => row.state === 'queued' && String(row.continuationTaskId) === String(taskId) && !row.standupFor).sort(requestOrder);
  const wait = waitOf(next, now);
  return wait && wait.on !== 'turn' ? wait : null;
}
const span = ms => { const seconds = Math.max(1, Math.ceil(ms / 1000)); return seconds < 90 ? `${seconds}s` : seconds < 5400 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`; };
// The sentence, the same on this computer and on another of the owner's that views it.
export function waitText(wait, now = Date.now()) {
  const value = cleanWait(wait);
  if (!value) return null;
  if (value.on === 'turn') return "Waiting for this session's current turn to end.";
  if (value.on === 'time') return [value.why, Date.parse(value.until) > now ? `It tries again in ${span(Date.parse(value.until) - now)}.` : 'It tries again now.'].filter(Boolean).join(' ');
  if (value.on === 'teammates') return value.limit ? `Waiting for a free teammate slot: ${value.running} of ${value.limit} ${value.limit === 1 ? 'is' : 'are'} in use.` : "Waiting: no slot is set for teammates' work on this computer.";
  const running = value.running > value.limit ? `${value.running} sessions are running, and ${value.limit} ${value.limit === 1 ? 'runs' : 'run'} at once` : `${value.running} of ${value.limit} ${value.limit === 1 ? 'session is' : 'sessions are'} running`;
  return `Waiting for a free slot: ${running}. /slots changes it.`;
}
// What the chat says under a message that waits to start.
export const waitingText = (row, now = Date.now()) => waitText(waitOf(row, now), now) ?? row?.reason ?? 'Waiting to start.';
// A free slot in a few words, for the Queued heading in Sessions, or null: its rows then
// need no word each. The longest that fits is shown. More may run than start at once, after
// /slots was lowered.
export function waitShort(wait) {
  const value = cleanWait(wait);
  if (value?.on !== 'slot') return null;
  return value.running > value.limit ? [`${value.running} running, ${value.limit} at once`, `${value.limit} at once`] : [`${value.running} of ${value.limit} running`, `${value.running} of ${value.limit}`];
}
// Another wait in a few words, for the row of the message itself, or null.
export function waitMark(wait) {
  const value = cleanWait(wait);
  return value?.on === 'turn' ? 'after this turn' : value?.on === 'teammates' ? 'teammate slot' : null;
}
