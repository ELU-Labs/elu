// How long one turn of a model may run. A turn that is still working is never cut by the
// clock: it is stopped only when its vendor has printed nothing for the quiet limit, or when
// it reaches the cap, a safety net of two hours. Time an approval waits for the owner counts
// toward neither; the approval has its own wait.
// Tests shrink these two; nothing else changes them.
export const turnClock = { quietSeconds: 600, capSeconds: 7200 };
// roles.<name>.timeoutSeconds in a config is the quiet limit. 900 is what every config and
// every task's frozen policy was written with when it was a time limit for the whole turn;
// nobody chose it, so it reads as the default, as 600, the default now, does.
const DEFAULT_SECONDS = new Set([600, 900]);
// streams: whether the vendor prints as it works. One that prints its answer only at the
// end has no quiet limit, since silence says nothing about it; the cap still holds.
export function turnLimits(role, { streams = true } = {}) {
  const set = role?.timeoutSeconds, cap = turnClock.capSeconds;
  const quiet = !Number.isInteger(set) || set < 1 || DEFAULT_SECONDS.has(set) ? turnClock.quietSeconds : set;
  return { quietSeconds: streams ? Math.min(quiet, cap) : null, capSeconds: cap };
}
// The wall time a check command may take: what the lead's timeoutSeconds says, and 15
// minutes, as before, where that is the default.
export const checkSeconds = role => !Number.isInteger(role?.timeoutSeconds) || DEFAULT_SECONDS.has(role.timeoutSeconds) ? 900 : role.timeoutSeconds;
const span = seconds => seconds >= 3600 && seconds % 3600 === 0 ? `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}` : seconds >= 60 ? `${Math.round(seconds / 60)} minute${Math.round(seconds / 60) === 1 ? '' : 's'}` : `${seconds} second${seconds === 1 ? '' : 's'}`;
// The one line the chat shows when a turn was stopped by a limit. limit: 'quiet' or 'cap'.
// edits: the turn could change files, which stay as they are.
export function stoppedLine(limit, { quietSeconds, capSeconds }, { edits = true } = {}) {
  const what = limit === 'quiet' ? `Stopped after ${span(quietSeconds)} with no output.` : `Stopped after ${span(capSeconds)}, the most one turn may run.`;
  return `${what}${edits ? ' Your changes are kept.' : ''} Reply to carry on.`;
}
