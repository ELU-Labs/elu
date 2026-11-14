import fs from 'node:fs';
import path from 'node:path';

// What a model did while it worked, read from its run's log as the vendor wrote it: each
// thought, each tool call and how it ended, its plan, and the text it wrote on the way. The
// reply itself is not a step; the chat shows it. One reader takes every shape a log holds,
// since the shapes never overlap: Claude Code's stream-json, Codex's exec --json, Grok
// Build's streaming-json, and the ACP lines Grok Build sends in Ask for approval and Approve
// for me and Antigravity in every mode its check proved. Antigravity's headless json prints
// only its result: the chat counts that run's time instead (silentLine, lib/terminal-visuals.mjs).
//
// A step is { kind, text } with kind thinking, tool, text, plan or background. A tool step has
// status running, ok or failed, and may carry a note (exit 1, declined); while it runs it has
// since, when it started (ms), and once it ended seconds, how long it ran. A thought Claude
// Code sent no text for has tokens, the count it gave, and live while it still counts. A plan
// step has entries { text, state } with state todo, doing or done. sub: a step of a helper
// agent. The last step may be background: the count commands the run has going in the
// background now, text their descriptions, since when the oldest started.
//
// The log carries no times, so a row's time is when it was written as far as that is known:
// the log's last write when the row was read, which is the row's own time when the log is
// read as it grows. Claude Code's tool_progress rows say how long a call has run, and correct
// the start of a call that was read late.
//
// A log is read from where the last read stopped, so a redraw reads only what is new, and
// the steps of a log that did not change are the same frozen list.
const kept = new Map(), FILES_KEPT = 400, CHUNK = 1024 * 1024;

export function runSteps(file, { cwd = null } = {}) {
  if (typeof file !== 'string' || !file) return [];
  let stat;
  try { stat = fs.lstatSync(file); } catch { kept.delete(file); return []; }
  if (!stat.isFile()) return [];
  let entry = kept.get(file);
  if (entry && (entry.ino !== stat.ino || stat.size < entry.offset)) entry = null;
  entry ??= { ino: stat.ino, offset: 0, carry: Buffer.alloc(0), state: fresh(cwd), steps: Object.freeze([]) };
  if (stat.size > entry.offset) read(file, entry, stat.size, Math.round(Math.min(Date.now(), stat.mtimeMs)));
  kept.delete(file); kept.set(file, entry);
  if (kept.size > FILES_KEPT) kept.delete(kept.keys().next().value);
  return entry.steps;
}
function read(file, entry, size, clock) {
  entry.state.clock = clock;
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
  catch { return; }
  let changed = false;
  try {
    while (entry.offset < size) {
      const bytes = Buffer.alloc(Math.min(CHUNK, size - entry.offset)), got = fs.readSync(fd, bytes, 0, bytes.length, entry.offset);
      if (!got) break;
      entry.offset += got;
      const data = entry.carry.length ? Buffer.concat([entry.carry, bytes.subarray(0, got)]) : bytes.subarray(0, got);
      const end = data.lastIndexOf(0x0a);
      // An unfinished line waits for the rest of it.
      if (end < 0) { entry.carry = Buffer.from(data); continue; }
      entry.carry = Buffer.from(data.subarray(end + 1));
      for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (take(entry.state, row)) changed = true;
      }
    }
  } finally { fs.closeSync(fd); }
  if (changed) entry.steps = view(entry.state);
}
const fresh = cwd => ({ cwd, items: [], byId: new Map(), open: null, clock: 0, counting: null, tasks: new Map(), behind: [] });
const text = value => typeof value === 'string' ? value : '';
const firstLine = value => { const lines = text(value).trim().split('\n'); return lines.length > 1 ? `${lines[0].trimEnd()} …` : lines[0] ?? ''; };
// A path in the workspace reads from it; any other stays whole.
function place(state, value) {
  const file = text(value).trim(); if (!file || !state.cwd || !path.isAbsolute(file)) return file;
  const inside = path.relative(state.cwd, file);
  return inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? inside : inside === '' ? '.' : file;
}
function add(state, item, id = null) {
  counted(state); clocked(state, item);
  state.items.push(item); state.open = item.kind === 'thinking' || item.kind === 'text' ? item : null;
  if (id != null) state.byId.set(String(id), item);
  return true;
}
// A tool call is timed from the row that started it to the row that ended it.
function clocked(state, item) {
  if (item.kind !== 'tool') return;
  if (item.status === 'running') { item.since ??= state.clock; delete item.seconds; }
  else if (item.since != null) { item.seconds = Math.max(0, Math.round((state.clock - item.since) / 1000)); delete item.since; }
}
// The thought being counted is over once anything else comes.
function counted(state) { if (state.counting) { delete state.counting.live; state.counting = null; } }
// A thought or text that arrives in pieces is one step until something else comes between.
function chunk(state, kind, value, sub = false) {
  const piece = text(value); if (!piece) return false;
  if (state.open?.kind === kind && Boolean(state.open.sub) === sub) { state.open.text += piece; return true; }
  return add(state, { kind, text: piece, ...(sub ? { sub: true } : {}) });
}
// A step that comes again under the same id replaces what it said.
function keyed(state, id, item) {
  const known = id != null ? state.byId.get(String(id)) : null;
  if (known) { Object.assign(known, item); for (const key of Object.keys(known)) if (!(key in item) && !['kind', 'since', 'seconds'].includes(key)) delete known[key]; clocked(state, known); return true; }
  return add(state, item, id);
}
function finish(state, id, status, note = null) {
  const known = id != null ? state.byId.get(String(id)) : null; if (!known) return false;
  known.status = status; if (note) known.note = note; else delete known.note;
  clocked(state, known);
  return true;
}
// One plan per run: a new one replaces the last and moves to where it came.
function plan(state, entries, sub = false) {
  if (!Array.isArray(entries)) return false;
  const rows = entries.map(entry => ({ text: firstLine(entry?.text ?? entry?.content ?? entry?.step), state: entry?.completed === true || entry?.status === 'completed' ? 'done' : entry?.status === 'in_progress' ? 'doing' : 'todo' })).filter(row => row.text);
  const before = state.items.findIndex(item => item.kind === 'plan');
  if (before >= 0) state.items.splice(before, 1);
  if (!rows.length) return before >= 0;
  return add(state, { kind: 'plan', text: '', entries: rows, ...(sub ? { sub: true } : {}) });
}
function take(state, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  if (row.jsonrpc === '2.0' || typeof row.method === 'string') return acp(state, row);
  const type = row.type; if (typeof type !== 'string') return false;
  // Claude Code: a message's blocks, and each tool result.
  if (type === 'assistant' && Array.isArray(row.message?.content)) { let changed = false; for (const block of row.message.content) changed = claudeBlock(state, block, row.parent_tool_use_id != null) || changed; return changed; }
  if (type === 'user' && Array.isArray(row.message?.content)) {
    let changed = false;
    for (const block of row.message.content) if (block?.type === 'tool_result') changed = finish(state, block.tool_use_id, block.is_error === true ? 'failed' : 'ok') || changed;
    return changed;
  }
  // Claude Code: how long a call has run, a thought's tokens as it thinks, and its commands.
  if (type === 'tool_progress') return progress(state, row);
  if (type === 'system' && row.subtype === 'thinking_tokens') return thinkingTokens(state, row);
  if (type === 'system' && TASK_ROWS.includes(row.subtype)) return tasks(state, row);
  // Codex: items start, change and end under one id.
  if (/^item\.(started|updated|completed)$/.test(type) && row.item && typeof row.item === 'object') return codexItem(state, type, row.item);
  // Grok Build's streaming-json.
  if (type === 'thought') return chunk(state, 'thinking', row.data);
  if (type === 'text') return chunk(state, 'text', row.data);
  if (type === 'tool_call') return keyed(state, row.toolCallId, { kind: 'tool', text: toolTitle(state, row), status: toolStatus(row.status) });
  if (type === 'tool_call_update') return update(state, row);
  if (type === 'plan') return plan(state, row.entries);
  return false;
}
// ---- Claude Code ----
// The reply comes as the StructuredOutput tool: it is not a step.
const REPLY_TOOL = 'StructuredOutput';
function claudeBlock(state, block, sub) {
  if (!block || typeof block !== 'object') return false;
  const extra = sub ? { sub: true } : {};
  if (block.type === 'thinking') {
    // The thought whose tokens were counted: its text takes the count's place, and with no
    // text (Claude Code sends none unless asked, and not for every model) the count stays.
    const thought = text(block.thinking).trim(), count = sub ? null : state.counting;
    if (!count) return thought ? add(state, { kind: 'thinking', text: thought, ...extra }) : false;
    counted(state);
    if (thought) { count.text = thought; delete count.tokens; }
    return true;
  }
  if (block.type === 'text') { const said = text(block.text).trim(); return said ? add(state, { kind: 'text', text: said, ...extra }) : false; }
  if (block.type !== 'tool_use') return false;
  if (block.name === REPLY_TOOL) return false;
  if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) return plan(state, block.input.todos, sub);
  return add(state, { kind: 'tool', text: claudeTitle(state, block.name, block.input ?? {}), status: 'running', ...extra }, block.id);
}
function claudeTitle(state, name, input) {
  const named = String(name ?? 'tool'), at = value => place(state, value);
  if (named === 'Bash') return `Run: ${firstLine(input.command)}`;
  if (named === 'Read') return `Read: ${at(input.file_path)}`;
  if (named === 'Edit' || named === 'MultiEdit') return `Edit: ${at(input.file_path)}`;
  if (named === 'Write') return `Write: ${at(input.file_path)}`;
  if (named === 'NotebookEdit') return `Edit: ${at(input.notebook_path)}`;
  if (named === 'Grep') return `Search: ${firstLine(input.pattern)}${input.path ? ` in ${at(input.path)}` : ''}`;
  if (named === 'Glob') return `Find: ${firstLine(input.pattern)}${input.path ? ` in ${at(input.path)}` : ''}`;
  if (named === 'WebFetch') return `Fetch: ${firstLine(input.url)}`;
  if (named === 'WebSearch') return `Search the web: ${firstLine(input.query)}`;
  if (named === 'Agent' || named === 'Task') return `Agent: ${firstLine(input.description ?? input.prompt)}`;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(named);
  if (mcp) return `${mcp[1]} ${mcp[2]}${argument(state, input) ? `: ${argument(state, input)}` : ''}`;
  return `${named}${argument(state, input) ? `: ${argument(state, input)}` : ''}`;
}
// system/thinking_tokens: estimated_tokens is the thought's count so far, estimated_tokens_delta
// what this row adds. The rows come before the thought's own block.
function thinkingTokens(state, row) {
  const more = Number(row.estimated_tokens_delta), total = Number(row.estimated_tokens), fresh = !state.counting;
  if (fresh) { const item = { kind: 'thinking', text: '', tokens: 0, live: true }; add(state, item); state.counting = item; }
  const item = state.counting, next = Number.isFinite(more) && more > 0 ? item.tokens + more : Number.isFinite(total) && total > item.tokens ? total : item.tokens;
  if (next === item.tokens) return fresh;
  item.tokens = next; return true;
}
// tool_progress: every half minute, how long a call has run. The call is the row's parent, and
// the row's own id is the call's with -heartbeat-N. The call started no later than the row's
// time less what it says, so a start that was read late moves back to there, and with it
// whatever the log started before that call: a call still running, a command in the background.
function progress(state, row) {
  const known = state.byId.get(text(row.tool_use_id).replace(/-heartbeat-\d+$/, '')) ?? state.byId.get(String(row.parent_tool_use_id)), ran = Number(row.elapsed_time_seconds);
  if (known?.kind !== 'tool' || known.status !== 'running' || !Number.isFinite(ran) || ran < 0) return false;
  const since = state.clock - ran * 1000;
  if (known.since != null && since > known.since - 1000) return false;
  known.since = since;
  const at = state.items.indexOf(known);
  for (const item of state.items.slice(0, at)) if (item.since > since) item.since = since;
  for (const task of state.tasks.values()) if (task.order <= at && task.since > since) task.since = since;
  return true;
}
// The commands a run has going (system rows): task_started names one as it starts,
// background_tasks_changed lists the ones in the background now, and task_notification and
// task_updated say that one ended. A command in the foreground is its tool call's own step.
const TASK_ROWS = ['task_started', 'task_notification', 'task_updated', 'background_tasks_changed'], TASK_GOING = ['pending', 'running', 'in_progress'];
function tasks(state, row) {
  const known = state.tasks, id = text(row.task_id), before = state.behind.join('\n');
  // order: how many steps the log held when the command started, which places it among them.
  const meet = task => { const key = text(task?.task_id); if (key && !known.has(key)) known.set(key, { text: firstLine(task.description), since: state.clock, order: state.items.length, command: task.task_type === 'local_bash' }); return key; };
  if (row.subtype === 'task_started') { meet(row); if (row.is_backgrounded === true && id && !state.behind.includes(id)) state.behind = [...state.behind, id]; }
  else if (row.subtype === 'background_tasks_changed') { if (!Array.isArray(row.tasks)) return false; state.behind = [...new Set(row.tasks.map(meet).filter(Boolean))]; }
  else {
    const status = row.subtype === 'task_updated' ? row.patch?.status : row.status;
    if (typeof status !== 'string' || TASK_GOING.includes(status)) return false;
    known.delete(id); state.behind = state.behind.filter(key => key !== id);
  }
  return state.behind.join('\n') !== before;
}
// The one argument that says what a call is about, when it has one.
function argument(state, input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'cmd', 'file_path', 'path', 'filePath', 'pattern', 'query', 'url', 'description', 'prompt']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return /path/i.test(key) ? place(state, value) : firstLine(value);
    if (Array.isArray(value) && value.length && value.every(part => typeof part === 'string')) return firstLine(value.join(' '));
  }
  // Else its first text, as a tool of an MCP server names what it acts on in its own words.
  const first = Object.values(input).find(value => typeof value === 'string' && value.trim());
  return first ? firstLine(first) : '';
}
// ---- Codex ----
// A shell command arrives wrapped in the shell that ran it: /bin/zsh -lc 'npm test'.
function unwrap(command) {
  const value = Array.isArray(command) ? command.join(' ') : text(command).trim();
  const wrapped = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(value);
  if (!wrapped) return value;
  return wrapped[1] === "'" ? wrapped[2].replaceAll("'\\''", "'") : wrapped[2].replace(/\\(["\\$`])/g, '$1');
}
const CODEX_ENDED = { completed: 'ok', failed: 'failed', declined: 'failed', in_progress: 'running' };
function codexItem(state, type, item) {
  const id = item.id ?? null, ended = type === 'item.completed';
  if (item.type === 'reasoning') { const thought = text(item.text).trim(); return thought ? keyed(state, id, { kind: 'thinking', text: thought }) : false; }
  if (item.type === 'agent_message') {
    // The reply is the JSON object the schema asked for: not a step.
    const said = text(item.text).trim(); if (!said || reply(said)) return false;
    return keyed(state, id, { kind: 'text', text: said });
  }
  if (item.type === 'todo_list') return plan(state, item.items);
  const status = CODEX_ENDED[item.status] ?? (ended ? 'ok' : 'running');
  if (item.type === 'command_execution') {
    const failed = status === 'failed' || (ended && Number.isInteger(item.exit_code) && item.exit_code !== 0);
    const note = item.status === 'declined' ? 'declined' : failed && Number.isInteger(item.exit_code) ? `exit ${item.exit_code}` : null;
    return keyed(state, id, { kind: 'tool', text: `Run: ${firstLine(unwrap(item.command))}`, status: failed ? 'failed' : status, ...(note ? { note } : {}) });
  }
  if (item.type === 'file_change') {
    const files = (Array.isArray(item.changes) ? item.changes : []).map(change => place(state, change?.path)).filter(Boolean);
    return keyed(state, id, { kind: 'tool', text: `Edit: ${files.join(', ') || 'files'}`, status, ...(item.status === 'declined' ? { note: 'declined' } : {}) });
  }
  if (item.type === 'mcp_tool_call') return keyed(state, id, { kind: 'tool', text: `${text(item.server) || 'mcp'} ${text(item.tool) || 'tool'}${argument(state, item.arguments) ? `: ${argument(state, item.arguments)}` : ''}`, status: item.error ? 'failed' : status });
  if (item.type === 'web_search') return keyed(state, id, { kind: 'tool', text: `Search the web: ${firstLine(item.query ?? item.action?.query) || '…'}`, status });
  return false;
}
// A reply: a JSON object, bare or fenced.
function reply(value) {
  const body = value.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1').trim();
  if (!body.startsWith('{')) return false;
  try { const parsed = JSON.parse(body); return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed); } catch { return false; }
}
// ---- Grok Build streaming-json and ACP ----
const ACP_STATUS = { pending: 'running', in_progress: 'running', completed: 'ok', failed: 'failed' };
const toolStatus = value => ACP_STATUS[value] ?? 'running';
function toolTitle(state, call) {
  const title = text(call.title).trim(), about = argument(state, call.rawInput) || (Array.isArray(call.locations) ? place(state, call.locations.find(spot => spot?.path)?.path) : '');
  const name = title || text(call.toolName) || text(call.kind) || 'tool';
  return about && !name.includes(about) ? `${name}: ${about}` : name;
}
function update(state, call) {
  const known = call.toolCallId != null ? state.byId.get(String(call.toolCallId)) : null;
  if (!known) return call.title ? keyed(state, call.toolCallId, { kind: 'tool', text: toolTitle(state, call), status: toolStatus(call.status) }) : false;
  let changed = false;
  if (call.status && toolStatus(call.status) !== known.status) { known.status = toolStatus(call.status); clocked(state, known); changed = true; }
  if (typeof call.title === 'string' && call.title.trim()) { const title = toolTitle(state, { ...call, rawInput: call.rawInput ?? {} }); if (title !== known.text) { known.text = title; changed = true; } }
  return changed;
}
function acp(state, row) {
  if (row.method === 'session/request_permission') {
    const call = row.params?.toolCall; if (!call || typeof call !== 'object') return false;
    return state.byId.has(String(call.toolCallId)) ? false : keyed(state, call.toolCallId, { kind: 'tool', text: toolTitle(state, call), status: 'running' });
  }
  if (row.method !== 'session/update') return false;
  const change = row.params?.update; if (!change || typeof change !== 'object') return false;
  if (change.sessionUpdate === 'agent_thought_chunk') return chunk(state, 'thinking', change.content?.text);
  if (change.sessionUpdate === 'agent_message_chunk') return chunk(state, 'text', change.content?.text);
  if (change.sessionUpdate === 'tool_call') return keyed(state, change.toolCallId, { kind: 'tool', text: toolTitle(state, change), status: toolStatus(change.status) });
  if (change.sessionUpdate === 'tool_call_update') return update(state, change);
  if (change.sessionUpdate === 'plan') return plan(state, change.entries);
  return false;
}
// The steps as they stand. Text the model wrote last ends in its reply when the vendor sends
// the reply as text (Grok Build, Antigravity): from its JSON object on, bare or fenced, that
// is the reply and not a step, also while it is still arriving. The object opens a word, and
// its first key follows it.
const REPLY_START = /(?<=^|[\s:])(?:```(?:json)?[ \t]*\n[ \t]*)?\{(?=\s*(?:"|$))/;
function view(state) {
  const steps = state.items.map(item => ({ ...item, ...(item.entries ? { entries: item.entries.map(entry => ({ ...entry })) } : {}) }));
  const last = steps.at(-1);
  if (last?.kind === 'text') {
    const at = last.text.search(REPLY_START);
    if (at >= 0) last.text = last.text.slice(0, at);
  }
  for (const step of steps) if (step.kind !== 'plan') step.text = step.text.trim();
  const shown = steps.filter(step => step.kind === 'plan' || step.text || step.tokens);
  const behind = state.behind.map(id => state.tasks.get(id)).filter(Boolean);
  if (behind.length) shown.push({ kind: 'background', text: behind.map(task => task.text).filter(Boolean).join(', '), count: behind.length, since: Math.min(...behind.map(task => task.since)), ...(behind.every(task => task.command) ? {} : { tasks: true }) });
  return Object.freeze(shown.map(step => Object.freeze(step)));
}
// The steps of a run that ended, at (ms) when that is known: a call it left running was cut
// there, a thought it was counting is over, and its background commands ended with it.
const ended = new WeakMap();
export function endedSteps(steps, at = null) {
  if (!steps?.some(step => step.kind === 'background' || step.live || step.kind === 'tool' && step.status === 'running')) return steps ?? [];
  const kept = ended.get(steps); if (kept?.at === at) return kept.steps;
  const out = Object.freeze(steps.filter(step => step.kind !== 'background').map(step => {
    if (step.kind === 'tool' && step.status === 'running') { const { since, ...rest } = step; return Object.freeze({ ...rest, status: 'stopped', ...(since != null && Number.isFinite(at) && at >= since ? { seconds: Math.round((at - since) / 1000) } : {}) }); }
    if (step.live) { const { live: _live, ...rest } = step; return Object.freeze(rest); }
    return step;
  }));
  ended.set(steps, { at, steps: out });
  return out;
}

// A chat's entries in time order. One that says no time (an ELU before 0.1.20 sent a bot's
// review with none) stays right after the entry it came after, and never goes above the first.
export function inTimeOrder(entries) {
  const time = entry => { const at = Date.parse(entry?.at ?? ''); return Number.isFinite(at) ? at : null; };
  let last = entries.map(time).find(at => at !== null) ?? 0;
  return entries.map((entry, index) => { const at = time(entry); if (at !== null) last = at; return { entry, at: at ?? last, untimed: at === null, index }; })
    .sort((a, b) => a.at - b.at || a.untimed - b.untimed || a.index - b.index).map(row => row.entry);
}

// Which runs' steps go with which reply in a chat. Each reply of the model or of a bot owns
// the runs of the same speaker that ended after the message before it (the owner's, or that
// speaker's last reply) and no later than it: the runs that wrote it, a retry included. A
// shared bot that answers a teammate in the lead's place (lib/projects.mjs) speaks as the
// bot, and its runs carry the bot's role.
// entries: the chat in time order ({ at, lead, bot, loop, shell, role }); runs: { role, at,
// key }. Returns a Map from an entry to its runs, and the runs no reply owns (left): a turn
// that ended with no reply, because the owner stopped it or a limit or a failure did. Those
// stay where they happened: before maps the entry that came next to them, and after are the
// ones later than every entry. One older than the chat's first entry is not placed.
const SPOKE_MS = 5000;
export function runsOfEntries(entries, runs) {
  const owned = new Map(), taken = new Set(), ms = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : null; };
  const speaker = entry => entry.lead && !entry.loop ? 'lead' : entry.bot ? `bot:${entry.bot}` : null;
  let asked = -Infinity; const spoke = new Map();
  for (const entry of entries) {
    const at = ms(entry.at), role = speaker(entry);
    // The agent's answer to a review (loop) is a line about a reply it already gave.
    if (at === null || entry.loop) continue;
    if (!role) { if (!entry.shell && !entry.line && !entry.update) asked = Math.max(asked, at); continue; }
    const after = Math.max(asked, spoke.get(role) ?? -Infinity);
    const mine = runs.filter(run => !taken.has(run) && run.role === role && ms(run.at) !== null && ms(run.at) > after && ms(run.at) <= at + SPOKE_MS);
    if (mine.length) { owned.set(entry, mine); for (const run of mine) taken.add(run); }
    spoke.set(role, at);
  }
  const left = runs.filter(run => !taken.has(run)), before = new Map(), dated = entries.filter(entry => ms(entry.at) !== null);
  let rest = left.filter(run => ms(run.at) !== null && dated.length && ms(run.at) >= ms(dated[0].at));
  for (const entry of dated.slice(1)) {
    const mine = rest.filter(run => ms(run.at) <= ms(entry.at)); if (!mine.length) continue;
    before.set(entry, mine); rest = rest.filter(run => !mine.includes(run));
  }
  return { owned, left, before, after: dated.length ? rest : left };
}

// How long a run took, from its start to its end, when both are known.
export function runSeconds(runs) {
  const starts = runs.map(run => Date.parse(run.startedAt ?? '')).filter(Number.isFinite), ends = runs.map(run => Date.parse(run.at ?? '')).filter(Number.isFinite);
  if (!starts.length || !ends.length || starts.length !== runs.length) return null;
  const seconds = Math.round((Math.max(...ends) - Math.min(...starts)) / 1000);
  return seconds >= 0 ? seconds : null;
}
