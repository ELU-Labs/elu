// How long one turn of a model may run. A turn that is still working is never cut by the
// clock: it is stopped only when its vendor has printed nothing for the quiet limit, or when
// it reaches the cap, a safety net of two hours. Time an approval waits for the owner counts
// toward neither; the approval has its own wait. A command the model runs inside the turn,
// such as a long test run, is working while it runs, printing or not (commandWatch).
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
// The wall time a project check may take. A check is a command, and a command that prints
// nothing, such as a long test run, is working all the while, so a check has no quiet limit
// and no time limit of the lead's: only the cap of a turn.
export const checkSeconds = () => turnClock.capSeconds;
const span = seconds => seconds >= 3600 && seconds % 3600 === 0 ? `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}` : seconds >= 60 ? `${Math.round(seconds / 60)} minute${Math.round(seconds / 60) === 1 ? '' : 's'}` : `${seconds} second${seconds === 1 ? '' : 's'}`;
// The one line the chat shows when a turn was stopped by a limit. limit: 'quiet' or 'cap'.
// edits: the turn could change files, which stay as they are.
export function stoppedLine(limit, { quietSeconds, capSeconds }, { edits = true } = {}) {
  const what = limit === 'quiet' ? `Stopped after ${span(quietSeconds)} with no output.` : `Stopped after ${span(capSeconds)}, the most one turn may run.`;
  return `${what}${edits ? ' Your changes are kept.' : ''} Reply to carry on.`;
}
// What a check that reached the cap says in its result.
export const checkStoppedLine = (seconds = checkSeconds()) => `Stopped after ${span(seconds)}, the most one check may run.`;
// Codex items that are tool calls: each runs between its item.started and item.completed.
// A to-do list or a message is not one, and stays open for most of a turn.
const CODEX_TOOLS = new Set(['command_execution', 'mcp_tool_call', 'web_search', 'file_change']);
// Reads a vendor's stream one row at a time and says whether one of its tool calls has
// started and not yet ended: a command it runs, a search, a subagent. While one is open the
// turn is working, so the quiet limit waits; the cap still holds. A vendor prints a tool
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
