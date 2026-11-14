// How long one turn of a model may run. A turn that is still working is never cut by the
// clock, however long it takes: it is stopped only when its vendor has printed nothing for
// the quiet limit. Time an approval waits for the owner does not count; the approval has
// its own wait. A command the model runs inside the turn, such as a long test run, is
// working while it runs, printing or not (commandWatch).
// Tests shrink it; nothing else changes it.
export const turnClock = { quietSeconds: 600 };
// roles.<name>.timeoutSeconds in a config is the quiet limit. 900 is what every config and
// every task's frozen policy was written with when it was a time limit for the whole turn;
// nobody chose it, so it reads as the default, as 600, the default now, does.
const DEFAULT_SECONDS = new Set([600, 900]);
// streams: whether the vendor prints as it works. One that prints its answer only at the
// end has no quiet limit, since silence says nothing about it: it runs until it ends or the
// owner stops it.
export function turnLimits(role, { streams = true } = {}) {
  const set = role?.timeoutSeconds;
  const quiet = !Number.isInteger(set) || set < 1 || DEFAULT_SECONDS.has(set) ? turnClock.quietSeconds : set;
  return { quietSeconds: streams ? quiet : null };
}
const span = seconds => seconds >= 3600 && seconds % 3600 === 0 ? `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}` : seconds >= 60 ? `${Math.round(seconds / 60)} minute${Math.round(seconds / 60) === 1 ? '' : 's'}` : `${seconds} second${seconds === 1 ? '' : 's'}`;
// The one line the chat shows when the quiet limit stopped a turn.
// edits: the turn could change files, which stay as they are.
export function stoppedLine({ quietSeconds }, { edits = true } = {}) {
  return `Stopped after ${span(quietSeconds)} with no output.${edits ? ' Your changes are kept.' : ''} Reply to carry on.`;
}
// A push and the pre-push guards it runs have no time limit either, only the quiet limit
// (lib/publish.mjs, snapshotHooks in lib/git.mjs). What each says when that stops it.
export const guardStoppedLine = ({ quietSeconds }) => `Stopped the pre-push guard after ${span(quietSeconds)} with no output. Nothing was pushed.`;
export const pushStoppedLine = ({ quietSeconds }) => `Stopped the push after ${span(quietSeconds)} with no output.`;
// In Approve for me and Full access a turn the quiet limit stopped is told to carry on by
// ELU, once (lib/runner.mjs). The line the chat shows then, and what the model is told.
export const carriedOnLine = ({ quietSeconds }) => `No output for ${span(quietSeconds)}. ELU told it to carry on.`;
export const carryOnNote = ({ quietSeconds }) => `Your last turn in this session printed nothing for ${span(quietSeconds)}, so ELU stopped it and started this one in its place. Carry on from where it stopped: do not start over, and do not repeat a step that is already done. Files it changed are as it left them.`;
// An earlier version also stopped a turn that had run two hours, working or not. A session
// it stopped that way keeps that error (cause time-limit, stoppedBy cap); this version has
// no such limit, says so (lib/stop-line.mjs), and carries the session on (lib/carry-on.mjs).
export const capStopped = error => Boolean(error) && typeof error === 'object' && (error.stoppedBy === 'cap' || error.cause === 'time-limit');
export const CAP_STOPPED = 'Stopped by a time limit an earlier version had.';
// What ELU sends such a session in the owner's place, and the one line the chat shows for it.
export const CAP_CARRY_TEXT = 'Carry on where you stopped. (ELU sent this, not the owner: an earlier version stopped your last turn at a time limit, and this version has no such limit.)';
export const CAP_CARRIED_LINE = `${CAP_STOPPED} ELU told it to carry on.`;
// Codex items that are tool calls: each runs between its item.started and item.completed.
// A to-do list or a message is not one, and stays open for most of a turn.
const CODEX_TOOLS = new Set(['command_execution', 'mcp_tool_call', 'web_search', 'file_change']);
// Reads a vendor's stream one row at a time and says whether one of its tool calls has
// started and not yet ended: a command it runs, a search, a subagent. While one is open the
// turn is working, so the quiet limit waits, for as long as the call takes. A vendor prints a tool
// call when it starts and its result when it ends, and nothing between, however long the
// command takes. vendor: 'claude' (stream-json), 'codex' (exec --json) or 'acp' (the
// session/update notifications of an ACP agent). Any other vendor never reads as running.
export function commandWatch(vendor) {
  const open = new Set();
  const id = value => typeof value === 'string' && value ? value : null;
  const claude = row => {
    if (row.type === 'result') { open.clear(); return; }
    const blocks = Array.isArray(row.message?.content) ? row.message.content : [];
    for (const block of blocks) {
      if (row.type === 'assistant' && block?.type === 'tool_use' && id(block.id)) open.add(block.id);
      if (row.type === 'user' && block?.type === 'tool_result' && id(block.tool_use_id)) open.delete(block.tool_use_id);
    }
  };
  const codex = row => {
    if (row.type === 'turn.completed' || row.type === 'turn.failed') { open.clear(); return; }
    const item = row.item; if (!id(item?.id)) return;
    if (row.type === 'item.started' && (CODEX_TOOLS.has(item.type) || /_tool_call$/.test(String(item.type)))) open.add(item.id);
    if (row.type === 'item.completed') open.delete(item.id);
  };
  const acp = row => {
    // The reply to session/prompt ends the turn, and every call in it.
    if (row.method === undefined && row.id !== undefined && typeof row.result?.stopReason === 'string') { open.clear(); return; }
    const update = row.method === 'session/update' ? row.params?.update : null;
    if (!['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) || !id(update.toolCallId)) return;
    if (['completed', 'failed'].includes(update.status)) open.delete(update.toolCallId);
    else if (update.sessionUpdate === 'tool_call' || ['pending', 'in_progress'].includes(update.status)) open.add(update.toolCallId);
  };
  const read = { claude, codex, acp }[vendor] ?? null;
  return {
    see(row) { if (read && row && typeof row === 'object' && !Array.isArray(row)) read(row); },
    running: () => open.size > 0,
  };
}
