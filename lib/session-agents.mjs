import fs from 'node:fs';
import path from 'node:path';
import { isObject } from './util.mjs';
import { taskDir } from './state.mjs';
import { runSteps } from './run-activity.mjs';
import { endedSentence, jobsDir, listJobs } from './jobs.mjs';
import { botOfKey, getBot, sessionBots } from './bots.mjs';
import { leadEffort, sessionBot } from './agent-change.mjs';
import { agentName, cleanTokens, codexTokens, leastCost, logSpend, pricedSpend, runSpends } from './agent-spend.mjs';
import { codexHome, rolloutFile } from './codex-rollout.mjs';
import { pendingApprovals } from './approvals.mjs';
import { parseConfig } from './config.mjs';
import { configModel, nextModel, ownsPolicy } from './models.mjs';
import { listCost } from './prices.mjs';
import { redact } from './publish.mjs';
import { sanitize } from './peer/peerdata.mjs';
import { QUICK_ROLE } from './message-aside.mjs';

// Every agent of a session, for the Agents tab (lib/terminal.mjs), the Orchestrator's
// session_agents tool and elu.remote.agents (lib/peer/remote-methods.mjs): the coder, each bot,
// the sub-agents of their runs (Claude Code Task/Agent subagents by parent_tool_use_id, Codex
// in-session agents by their collab spawn and wait items), and the helpers started as ELU jobs
// that run an agent (codex exec, claude -p), read from the job's own log. Read from the
// session's records and logs only; no model call. A helper started as a detached process is not
// an ELU job and is not listed.
//
// What a row says comes from what the vendor wrote: the model a run reported, else the one it
// was started with; the effort it ran with; the cost the vendor gave, else its tokens at the
// model's list price (lib/prices.mjs), as the Usage tab counts them. A Claude Code sub-agent's
// cost is part of its parent's too: Claude Code reports the turn whole. Text from a log is
// cleaned and its keys masked (lib/publish.mjs redact) before any row or entry holds it, since
// rows go to the Orchestrator's model and to the owner's other computers.
//
// A log is read from where the last read stopped, as lib/run-activity.mjs reads one, so a
// redraw reads only what is new. The logs carry no times: a sub-agent's start is when its first
// row was read, which is its own time while its parent's log is read as it grows.

export const AGENT_KINDS = Object.freeze(['coder', 'bot', 'subagent', 'helper']);
export const AGENT_STATES = Object.freeze(['working', 'waiting', 'done']);
export const SUMMARY_MAX = 160;

/**
 * One row of the Agents tab.
 * @typedef {{
 *   id: string,            // stable within the session: 'lead', 'bot:<name>', 'sub:<role>:<tool_use_id>', 'job:<name>'
 *   kind: 'coder'|'bot'|'subagent'|'helper',
 *   name: string,          // what the row shows: the model's label, '@advisor', a sub-agent's description, the job's name
 *   parent: string|null,   // the id of the agent that started it, for sub-agents and helpers
 *   vendor: string|null, model: string|null, effort: string|null,
 *   state: 'working'|'waiting'|'done',
 *   since: string|null,    // ISO time of the state's start
 *   spend: number|null,    // dollars, when the vendor says
 *   summary: string,       // one line of what it is on now: its latest message, plan step or tool call (at most SUMMARY_MAX)
 *   log: string|null       // the file its thread is read from
 * }} AgentRow
 *
 * One entry of an agent's thread, drawn like Chat.
 * @typedef {{ at: string|null, kind: 'message'|'step'|'result'|'note', text: string, tool?: string }} AgentEntry
 */
// The kinds of an entry: message, what the agent wrote on the way; step, a tool call or its
// plan (tool: the call's verb, Run, Read, Edit, Plan); result, what it answered at the end of a
// turn; note, what it was given: the owner's message, its prompt, a job's command, ELU's line.

const LIVE = ['running', 'preparing'];
// The runs of each agent read for their sub-agents: its last ones, and the one at work.
const RUNS_READ = 20;
// The sub-agents and helpers listed under one agent: the newest.
const CHILDREN_MOST = 40;
const ENTRY_MAX = 4000, THREAD_ROWS = 200;
const DONE_STATES = ['completed', 'errored', 'error', 'failed', 'shutdown', 'not_found', 'interrupted', 'closed', 'cancelled', 'killed', 'stopped'];

const text = value => typeof value === 'string' ? value : '';
const time = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : null; };
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
const isoOf = value => iso(time(value));
const clean = (value, max = ENTRY_MAX) => redact(sanitize(String(value ?? '')), max).trim();
const firstLine = value => text(value).split('\n').find(line => line.trim())?.trim() ?? '';
// One line of what an agent is on, cleaned, at most SUMMARY_MAX.
function line(value) {
  const one = clean(firstLine(value), SUMMARY_MAX * 4).replace(/\s+/g, ' ').trim();
  return one.length > SUMMARY_MAX ? `${one.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : one;
}
const roleOf = run => typeof run?.role === 'string' && run.role ? run.role : 'lead';

// ---- reading files ----
const sigOf = file => { try { const stat = fs.lstatSync(file); return stat.isFile() ? `${stat.ino}:${stat.size}:${stat.mtimeMs}` : null; } catch { return null; } };
// A value worked out from a file, kept until the file changes.
function keptFor(map, key, sig, make, most = 300) {
  const hit = map.get(key); if (hit && hit.sig === sig) return hit.value;
  let value = null; try { value = make(); } catch { value = null; }
  map.delete(key); map.set(key, { sig, value });
  if (map.size > most) map.delete(map.keys().next().value);
  return value;
}
// A file's text, its last most bytes; null when it cannot be read. A symbolic link is never followed.
function readText(file, { most = 16 << 20, head = false } = {}) {
  let fd; try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size, from = head ? 0 : Math.max(0, size - most), bytes = Buffer.alloc(Math.min(most, size - from)), got = fs.readSync(fd, bytes, 0, bytes.length, from);
    const value = bytes.subarray(0, got).toString('utf8');
    return from > 0 ? value.slice(value.indexOf('\n') + 1) : value;
  } catch { return null; } finally { fs.closeSync(fd); }
}
function jsonRows(value) {
  const out = [];
  for (const row of text(value).split('\n')) { if (!row.trim().startsWith('{')) continue; try { const parsed = JSON.parse(row); if (isObject(parsed)) out.push(parsed); } catch { /* A line that is not one row. */ } }
  return out;
}

// ---- a run's reply ----
const summaryOf = value => isObject(value) ? [value.summary, value.question, value.message].find(item => typeof item === 'string' && item.trim()) ?? null : null;
// What a reply says: the summary of the JSON object ELU asked for, bare or fenced, else the text.
function replyText(value) {
  const said = text(value).trim(); if (!said) return null;
  const body = said.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1').trim();
  if (body.startsWith('{')) { try { return summaryOf(JSON.parse(body)) ?? said; } catch { /* Text that opens with a brace. */ } }
  return said;
}
// The reply a run's log ends with: Claude Code's result, or Codex's last message. null when none.
const replies = new Map();
function runReply(file) {
  const sig = typeof file === 'string' ? sigOf(file) : null; if (!sig) return null;
  return keptFor(replies, file, sig, () => {
    let reply = null;
    for (const row of jsonRows(readText(file, { most: 1 << 20 }))) {
      if (row.type === 'result') reply = summaryOf(row.structured_output) ?? replyText(row.result) ?? reply;
      else if (row.event === 'result' && isObject(row.result)) reply = summaryOf(row.result.structured_output) ?? reply;
      else if (row.type === 'item.completed' && row.item?.type === 'agent_message') reply = replyText(row.item.text) ?? reply;
    }
    return reply;
  });
}

// ---- the steps of a log, as entries and as one line ----
const VERB = /^([A-Z][A-Za-z ]{0,24}): /;
function stepLine(step) {
  if (step.kind === 'plan') {
    const entries = step.entries ?? [], doing = entries.find(entry => entry.state === 'doing') ?? entries.find(entry => entry.state !== 'done');
    return doing ? `Step ${entries.indexOf(doing) + 1} of ${entries.length}: ${doing.text}` : entries.length ? `Plan: all ${entries.length} steps done` : '';
  }
  if (step.kind === 'tool') return [step.text, step.note, step.status === 'failed' && !step.note ? 'failed' : null].filter(Boolean).join(' · ');
  if (step.kind === 'text') return firstLine(step.text);
  return '';
}
// The latest of an agent's own steps that says something: a call, a plan step or its text.
function latestStep(steps) {
  const own = (steps ?? []).filter(step => !step.sub);
  for (let at = own.length - 1; at >= 0; at--) { const said = stepLine(own[at]); if (said) return said; }
  return own.some(step => step.kind === 'thinking') ? 'Thinking' : '';
}
const PLAN_MARK = { done: '✓', doing: '●', todo: '○' };
function stepEntry(step, at) {
  if (step.kind === 'text') return { at, kind: 'message', text: clean(step.text) };
  if (step.kind === 'plan') return { at, kind: 'step', text: clean((step.entries ?? []).map(entry => `${PLAN_MARK[entry.state] ?? '○'} ${entry.text}`).join('\n')), tool: 'Plan' };
  if (step.kind === 'tool') { const said = stepLine(step); return { at, kind: 'step', text: clean(said), tool: VERB.exec(step.text)?.[1] ?? firstLine(step.text).split(/[\s:]/)[0] ?? 'Tool' }; }
  return null;
}
const ownSteps = (file, cwd) => { try { return runSteps(file, { cwd }).filter(step => !step.sub); } catch { return []; } };

// ---- sub-agents in a run's log ----
// Claude Code: a Task or Agent call of the turn starts one (its id is the call's); its rows carry
// parent_tool_use_id; the call's result ends it, or, for one started in the background, the
// task_notification that says it ended. Codex: a collab spawn call names the threads it started
// (receiver_thread_ids), and every collab call says how each stands (agents_states).
const AGENT_TOOLS = ['Task', 'Agent'];
const logs = new Map(), LOGS_KEPT = 200, CHUNK = 1 << 20;
function subsOf(file) {
  if (typeof file !== 'string' || !file) return null;
  let stat; try { stat = fs.lstatSync(file); } catch { logs.delete(file); return null; }
  if (!stat.isFile()) return null;
  let entry = logs.get(file);
  if (entry && (entry.ino !== stat.ino || stat.size < entry.offset)) entry = null;
  entry ??= { ino: stat.ino, offset: 0, carry: Buffer.alloc(0), state: { clock: 0, claude: new Map(), codex: new Map(), tasks: new Map(), thread: null, rollout: null } };
  if (stat.size > entry.offset) readMore(file, entry, stat.size, Math.round(Math.min(Date.now(), stat.mtimeMs)));
  logs.delete(file); logs.set(file, entry);
  if (logs.size > LOGS_KEPT) logs.delete(logs.keys().next().value);
  return entry.state;
}
function readMore(file, entry, size, clock) {
  entry.state.clock = clock;
  let fd; try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); } catch { return; }
  try {
    while (entry.offset < size) {
      const bytes = Buffer.alloc(Math.min(CHUNK, size - entry.offset)), got = fs.readSync(fd, bytes, 0, bytes.length, entry.offset);
      if (!got) break;
      entry.offset += got;
      const data = entry.carry.length ? Buffer.concat([entry.carry, bytes.subarray(0, got)]) : bytes.subarray(0, got), end = data.lastIndexOf(0x0a);
      if (end < 0) { entry.carry = Buffer.from(data); continue; }
      entry.carry = Buffer.from(data.subarray(end + 1));
      for (const raw of data.subarray(0, end).toString('utf8').split('\n')) {
        if (!['parent_tool_use_id', '"tool_use"', 'tool_result', 'collab', 'thread.started', '"task_'].some(mark => raw.includes(mark))) continue;
        let row; try { row = JSON.parse(raw); } catch { continue; }
        if (isObject(row)) takeRow(entry.state, row);
      }
    }
  } finally { fs.closeSync(fd); }
}
const blocksOf = row => Array.isArray(row.message?.content) ? row.message.content.filter(isObject) : [];
const resultText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => text(part?.text)).filter(Boolean).join('\n') : '';
// The title of a Claude Code call, as the chat's steps name it (lib/run-activity.mjs).
function callTitle(name, input) {
  const named = String(name ?? 'tool'), at = value => firstLine(value);
  if (named === 'Bash') return `Run: ${at(input.command)}`;
  if (named === 'Read') return `Read: ${at(input.file_path)}`;
  if (named === 'Edit' || named === 'MultiEdit') return `Edit: ${at(input.file_path)}`;
  if (named === 'Write') return `Write: ${at(input.file_path)}`;
  if (named === 'Grep') return `Search: ${at(input.pattern)}`;
  if (named === 'Glob') return `Find: ${at(input.pattern)}`;
  if (named === 'WebFetch') return `Fetch: ${at(input.url)}`;
  if (named === 'WebSearch') return `Search the web: ${at(input.query)}`;
  if (AGENT_TOOLS.includes(named)) return `Agent: ${at(input.description ?? input.prompt)}`;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(named), first = Object.values(isObject(input) ? input : {}).find(value => typeof value === 'string' && value.trim());
  return `${mcp ? `${mcp[1]} ${mcp[2]}` : named}${first ? `: ${at(first)}` : ''}`;
}
function addEntry(sub, entry) { if (!entry.text) return; sub.entries.push(entry); if (sub.entries.length > THREAD_ROWS * 2) sub.entries.splice(0, sub.entries.length - THREAD_ROWS * 2); }
function startClaude(state, block, parent) {
  const input = isObject(block.input) ? block.input : {}, id = String(block.id);
  if (state.claude.has(id)) return;
  const at = iso(state.clock), prompt = text(input.prompt);
  const sub = { id, parent, name: line(input.description) || line(input.subagent_type) || 'Agent', asked: text(input.model) || null, since: state.clock, endedAt: null, done: false, failed: false, background: input.run_in_background === true, model: null, usage: new Map(), entries: [], tools: new Map(), result: null, last: '' };
  if (prompt) addEntry(sub, { at, kind: 'note', text: clean(prompt) });
  state.claude.set(id, sub);
}
function endClaude(state, sub, { failed = false, said = '' } = {}) {
  if (sub.done) return;
  Object.assign(sub, { done: true, failed, endedAt: state.clock });
  const reply = clean(said);
  if (reply) { sub.result = reply; addEntry(sub, { at: iso(state.clock), kind: 'result', text: reply }); }
}
function takeRow(state, row) {
  if (row.type === 'thread.started') { if (typeof row.thread_id === 'string') state.thread = row.thread_id; if (typeof row.path === 'string' && path.isAbsolute(row.path)) state.rollout = row.path; return; }
  const parent = typeof row.parent_tool_use_id === 'string' && row.parent_tool_use_id ? row.parent_tool_use_id : null, sub = parent ? state.claude.get(parent) : null;
  if (row.type === 'assistant') {
    for (const block of blocksOf(row)) if (block.type === 'tool_use' && AGENT_TOOLS.includes(block.name) && block.id != null && (!parent || sub)) startClaude(state, block, parent);
    if (!sub) return;
    if (typeof row.message?.model === 'string' && row.message.model && row.message.model.length <= 100) sub.model = row.message.model;
    const usage = row.message?.usage;
    if (isObject(usage)) sub.usage.set(typeof row.message.id === 'string' ? row.message.id : `#${sub.usage.size}`, cleanTokens({ input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens }));
    const at = iso(state.clock);
    for (const block of blocksOf(row)) {
      if (block.type === 'text' && text(block.text).trim()) { addEntry(sub, { at, kind: 'message', text: clean(block.text) }); sub.last = firstLine(block.text); }
      else if (block.type === 'tool_use' && block.name !== 'StructuredOutput') {
        const title = callTitle(block.name, isObject(block.input) ? block.input : {}), entry = { at, kind: 'step', text: clean(title), tool: AGENT_TOOLS.includes(block.name) ? 'Agent' : VERB.exec(title)?.[1] ?? String(block.name).slice(0, 40) };
        addEntry(sub, entry); if (block.id != null) sub.tools.set(String(block.id), entry); sub.last = title;
      }
    }
    return;
  }
  if (row.type === 'user') {
    for (const block of blocksOf(row)) {
      if (block.type !== 'tool_result' || block.tool_use_id == null) continue;
      const id = String(block.tool_use_id), started = state.claude.get(id);
      // A call of a sub-agent's own that failed says so in its thread.
      if (sub && sub.tools.has(id) && block.is_error === true) { const entry = sub.tools.get(id); if (!entry.text.endsWith(' · failed')) entry.text += ' · failed'; }
      if (!started || started.parent !== parent) continue;
      // One started in the background answers at once that it started: it ends later.
      const status = text(row.tool_use_result?.status);
      if (started.background && status !== 'completed') continue;
      endClaude(state, started, { failed: block.is_error === true, said: resultText(block.content) });
    }
    return;
  }
  if (row.type === 'system' && typeof row.subtype === 'string' && row.subtype.startsWith('task_')) {
    const id = text(row.task_id), call = text(row.tool_use_id);
    if (row.subtype === 'task_started' && id && state.claude.has(call)) { state.tasks.set(id, call); return; }
    const known = state.claude.get(state.tasks.get(id) ?? call), status = text(row.subtype === 'task_updated' ? row.patch?.status : row.status);
    if (known && status && !['pending', 'running', 'in_progress'].includes(status)) endClaude(state, known, { failed: /fail|error/.test(status), said: text(row.summary ?? row.result) });
    return;
  }
  // Codex: a collab call, as it starts, changes and ends.
  const item = row.item;
  if (!/^item\.(started|updated|completed)$/.test(text(row.type)) || item?.type !== 'collab_tool_call') return;
  const tool = text(item.tool).toLowerCase(), ids = (Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []).filter(value => typeof value === 'string' && value);
  const states = isObject(item.agents_states) ? item.agents_states : isObject(item.agentsStates) ? item.agentsStates : {}, at = iso(state.clock);
  const meet = (thread, prompt = null) => {
    let found = state.codex.get(thread);
    if (!found) { found = { id: thread, name: line(prompt) || 'Agent', since: state.clock, endedAt: null, done: false, status: 'pending_init', message: null, entries: [] }; if (prompt) addEntry(found, { at, kind: 'note', text: clean(prompt) }); state.codex.set(thread, found); }
    return found;
  };
  if (/spawn/.test(tool)) for (const thread of ids) meet(thread, text(item.prompt));
  else if (/send|input|message/.test(tool) && text(item.prompt).trim()) for (const thread of ids) addEntry(meet(thread), { at, kind: 'note', text: clean(item.prompt) });
  for (const [thread, value] of Object.entries(states)) {
    if (!isObject(value)) continue;
    const found = meet(thread), status = text(value.status).toLowerCase() || found.status;
    found.status = status;
    if (typeof value.message === 'string' && value.message.trim()) found.message = value.message;
    if (DONE_STATES.includes(status) && !found.done) { found.done = true; found.endedAt = state.clock; if (found.message) addEntry(found, { at, kind: 'result', text: clean(found.message) }); }
  }
  if (/close|kill|shutdown/.test(tool) && row.type === 'item.completed') for (const thread of ids) { const found = meet(thread); if (!found.done) { found.done = true; found.endedAt = state.clock; } }
}

// A Claude Code sub-agent's spend: its own requests' tokens at its model's list price.
function claudeSubSpend(sub) {
  const tokens = [...sub.usage.values()].reduce((sum, used) => !used ? sum : !sum ? used : { input: sum.input + used.input, output: sum.output + used.output, cacheRead: sum.cacheRead + used.cacheRead, cacheWrite: sum.cacheWrite + used.cacheWrite }, null);
  try { return tokens && sub.model ? listCost(sub.model, tokens) : null; } catch { return null; }
}

// ---- a Codex thread's own record (its rollout file) ----
// What a Codex sub-agent ran on, what it used and what it did, from its thread's rollout file
// (lib/codex-rollout.mjs): { model, effort, tokens, entries, last }.
const rollouts = new Map();
function rolloutOf(file) {
  const sig = typeof file === 'string' ? sigOf(file) : null; if (!sig) return null;
  return keptFor(rollouts, file, sig, () => {
    const out = { model: null, effort: null, tokens: null, entries: [], last: '' }, turns = new Map();
    let total = null;
    for (const row of jsonRows(readText(file))) {
      const payload = isObject(row.payload) ? row.payload : {}, at = isoOf(row.timestamp);
      if (row.type === 'turn_context') {
        if (typeof payload.model === 'string' && payload.model.length <= 100) out.model = payload.model;
        const effort = [payload.effort, payload.reasoning_effort, payload.model_reasoning_effort].find(value => typeof value === 'string' && /^[a-z]{1,12}$/.test(value));
        if (effort) out.effort = effort;
      } else if (row.type === 'event_msg' && payload.type === 'token_count' && isObject(payload.info?.total_token_usage)) total = codexTokens(payload.info.total_token_usage) ?? total;
      else if (row.type === 'token_usage_record' && isObject(payload.turn_token_usage)) turns.set(typeof payload.turn_id === 'string' ? payload.turn_id : `#${turns.size}`, codexTokens(payload.turn_token_usage));
      else if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
        // What it was asked, and not the context Codex puts before it (<environment_context>, <user_instructions>).
        const asked = (Array.isArray(payload.content) ? payload.content : []).map(part => text(part?.text)).filter(value => value.trim() && !value.trim().startsWith('<')).join('\n');
        if (asked.trim()) out.entries.push({ at, kind: 'note', text: clean(asked) });
      } else if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
        const said = (Array.isArray(payload.content) ? payload.content : []).map(part => text(part?.text)).filter(Boolean).join('\n');
        if (said.trim()) { out.entries.push({ at, kind: 'message', text: clean(replyText(said) ?? said) }); out.last = firstLine(replyText(said) ?? said); }
      } else if (row.type === 'response_item' && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(payload.type)) {
        let input = payload.arguments ?? payload.input ?? payload.action ?? {}; if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { input }; } }
        const command = Array.isArray(input?.command) ? input.command.join(' ') : text(input?.command ?? input?.cmd);
        const title = command ? `Run: ${firstLine(command.replace(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+/, ''))}` : `${text(payload.name) || 'tool'}${isObject(input) && Object.values(input).find(value => typeof value === 'string' && value.trim()) ? `: ${firstLine(Object.values(input).find(value => typeof value === 'string' && value.trim()))}` : ''}`;
        out.entries.push({ at, kind: 'step', text: clean(title), tool: command ? 'Run' : (text(payload.name) || 'Tool').slice(0, 40) }); out.last = title;
      }
      if (out.entries.length > THREAD_ROWS * 2) out.entries.splice(0, out.entries.length - THREAD_ROWS * 2);
    }
    const summed = [...turns.values()].reduce((sum, used) => !used ? sum : !sum ? used : { input: sum.input + used.input, output: sum.output + used.output, cacheRead: sum.cacheRead + used.cacheRead, cacheWrite: sum.cacheWrite + used.cacheWrite }, null);
    out.tokens = total ?? summed;
    return out;
  });
}
const codexCost = (model, tokens) => { try { return tokens ? pricedSpend({ vendor: 'codex', model, tokens, costUsd: null, started: true })?.costUsd ?? null : null; } catch { return null; } };
// The Codex home a run's threads are kept under: the one its own rollout file is in, else this computer's.
function homeOf(state) {
  const file = state?.rollout; if (!file) return codexHome(process.env);
  const parts = file.split(path.sep), at = parts.lastIndexOf('sessions');
  return at > 0 ? parts.slice(0, at).join(path.sep) || path.sep : codexHome(process.env);
}

// ---- helpers started as ELU jobs ----
// A job runs an agent when its command starts codex exec or claude -p, or its log is one an
// agent writes (Claude Code's stream-json, Codex's --json). The model and effort its command
// names, where its log names none.
function agentCommand(commandLine) {
  for (const part of String(commandLine ?? '').split(/[;&|]+|\$\(|`/)) {
    const words = part.trim().split(/\s+/).map(word => word.replace(/^['"]|['"]$/g, ''));
    const codex = words.findIndex(word => /(?:^|\/)codex$/.test(word));
    if (codex >= 0 && words.slice(codex + 1).includes('exec')) return { vendor: 'codex', ...commandModel(words.slice(codex + 1)) };
    const claude = words.findIndex(word => /(?:^|\/)claude$/.test(word));
    if (claude >= 0 && words.slice(claude + 1).some(word => word === '-p' || word === '--print')) return { vendor: 'claude', ...commandModel(words.slice(claude + 1)) };
  }
  return null;
}
function commandModel(words) {
  let model = null, effort = null;
  const bare = value => String(value ?? '').replace(/^['"]|['"]$/g, '');
  words.forEach((word, at) => {
    const next = bare(words[at + 1]);
    if (['--model', '-m'].includes(word) && next) model = next;
    else if (word.startsWith('--model=')) model = bare(word.slice(8));
    else if (word === '--effort' && next) effort = next;
    else if (['-c', '--config'].includes(word) && next) {
      const pair = /^([a-z_]+)=(.*)$/.exec(next);
      if (pair?.[1] === 'model') model = bare(pair[2]);
      if (pair?.[1] === 'model_reasoning_effort') effort = bare(pair[2]);
    }
  });
  return { model: model && model.length <= 100 ? model : null, effort: effort && /^[a-z]{1,12}$/.test(effort) ? effort : null };
}
const logHeads = new Map();
function logVendor(file) {
  const sig = sigOf(file); if (!sig) return null;
  return keptFor(logHeads, file, sig, () => {
    for (const row of jsonRows(readText(file, { most: 64 << 10, head: true }))) {
      if (row.type === 'system' && row.subtype === 'init') return { vendor: 'claude', model: typeof row.model === 'string' ? row.model : null };
      if (row.type === 'thread.started' || row.type === 'turn.started' || /^item\./.test(text(row.type))) return { vendor: 'codex', model: typeof row.model === 'string' ? row.model : null, thread: typeof row.thread_id === 'string' ? row.thread_id : null };
    }
    return null;
  });
}
function lastLines(file, count = 40) {
  const value = readText(file, { most: 64 << 10 });
  return value === null ? [] : value.split('\n').map(row => row.trimEnd()).filter(row => row.trim()).slice(-count);
}
function helperOf(job) {
  const said = agentCommand(job.line), head = logVendor(job.log);
  if (!said && !head) return null;
  const vendor = head?.vendor ?? said.vendor, done = job.state !== 'running';
  let model = head?.model ?? null, effort = said?.effort ?? null, spend = null, steps = [];
  try { steps = ownSteps(job.log, null); } catch { steps = []; }
  const used = logSpend(job.log, vendor);
  if (vendor === 'claude') { model ??= used?.model ?? null; spend = used?.result?.total ?? (used?.tokens && model ? listCost(model, used.tokens) : null); }
  else {
    model ??= used?.model ?? null;
    const thread = used?.thread ?? head?.thread ?? null, sandboxed = path.join(job.dir, job.name, 'tmp', 'codex-home');
    if (thread && (!model || !effort)) {
      const home = fs.existsSync(sandboxed) ? sandboxed : codexHome(process.env), record = rolloutOf(rolloutFile(thread, { home, named: used?.file ?? null, near: time(job.startedAt) ?? Date.now() }));
      model ??= record?.model ?? null; effort ??= record?.effort ?? null;
    }
    spend = codexCost(model ?? said?.model ?? null, used?.tokens ?? null);
  }
  model ??= said?.model ?? null;
  const reply = done ? runReply(job.log) : null, plain = !steps.length && !head ? lastLines(job.log, 1)[0] ?? '' : '';
  const summary = line(reply ?? latestStep(steps) ?? '') || line(plain) || (done ? line(endedSentence(job)) : '');
  return { vendor, model, effort, spend, summary, steps, reply, head };
}

// ---- the coder's and the bots' models ----
const policies = new Map();
// The model the session's model runs on now: the one chosen for its next turn, else its saved policy.
function leadChoice(repo, task) {
  const waiting = nextModel(task); if (waiting && ownsPolicy(task)) return waiting;
  if (!ownsPolicy(task) || !repo?.state) return null;
  let file; try { file = path.join(taskDir(repo, task.id), 'policy.yaml'); } catch { return null; }
  const sig = sigOf(file); if (!sig) return null;
  return keptFor(policies, file, sig, () => configModel(parseConfig(fs.readFileSync(file, 'utf8'))), 100);
}
const ranOn = run => run ? { vendor: typeof run.vendor === 'string' ? run.vendor : null, model: run.model ?? run.asked ?? null, effort: run.effort ?? null } : null;

// ---- the rows ----
function build(repo, task) {
  const rows = [], sources = new Map();
  if (!isObject(task) || !/^[1-9]\d*$/.test(String(task.id ?? ''))) return { rows, sources };
  const all = Array.isArray(task.runs) ? task.runs : [], runs = all.filter(isObject);
  const live = LIVE.includes(task.state) && !task.standupTurn && typeof task.activeRole === 'string' && task.activeRole ? task.activeRole : null;
  const activeLog = live && typeof task.activeLog === 'string' && task.activeLog ? task.activeLog : null, cwd = typeof task.worktree === 'string' ? task.worktree : null;
  let spends = []; try { spends = runSpends(task); } catch { spends = []; }
  const spendOf = role => { let sum = null; all.forEach((run, at) => { if (!isObject(run) || !(roleOf(run) === role || role === 'lead' && run.role === QUICK_ROLE)) return; const cost = leastCost(spends[at], run); if (cost !== null) sum = (sum ?? 0) + cost; }); return sum; };
  let asks = []; if (live && repo?.root) { try { asks = pendingApprovals({ root: repo.root, taskId: task.id }); } catch { asks = []; } }
  // start: when each child began, which orders it among its parent's.
  const children = new Map(), starts = new Map(), child = (parent, row, source, start) => { if (!children.has(parent)) children.set(parent, []); children.get(parent).push(row); sources.set(row.id, source); starts.set(row.id, start ?? 0); };

  // Helpers first: an agent that has one running waits on it.
  let jobs = []; try { jobs = repo?.state ? listJobs(jobsDir(repo, task.id)) : []; } catch { jobs = []; }
  const orphans = [];
  for (const job of jobs) {
    let helper = null; try { helper = helperOf(job); } catch { helper = null; }
    if (!helper) continue;
    const by = typeof job.by === 'string' ? job.by : null, parent = by === 'lead' || botOfKey(by) ? by : null;
    const row = { id: `job:${job.name}`, kind: 'helper', name: job.name, parent, vendor: helper.vendor, model: helper.model, effort: helper.effort, state: job.state === 'running' ? 'working' : 'done', since: job.state === 'running' ? job.startedAt ?? null : job.endedAt ?? null, spend: helper.spend, summary: helper.summary, log: job.log };
    if (parent) child(parent, row, { kind: 'helper', job, helper }, time(job.startedAt)); else { orphans.push(row); sources.set(row.id, { kind: 'helper', job, helper }); }
  }
  // The sub-agents of an agent's runs: its last RUNS_READ, and the one at work.
  const subsFor = role => {
    const files = runs.filter(run => roleOf(run) === role && !run.overloaded).slice(-RUNS_READ).map(run => ({ file: run.logFile, end: time(run.at), started: time(run.startedAt) }));
    if (live === role && activeLog && !files.some(row => row.file === activeLog)) files.push({ file: activeLog, end: null, started: time(task.activeSince), live: true });
    const codex = new Map();
    for (const { file, end, live: going = false } of files) {
      const state = subsOf(file); if (!state) continue;
      const prefix = `sub:${role}:`;
      for (const sub of state.claude.values()) {
        const done = sub.done || !going, row = { id: prefix + sub.id, kind: 'subagent', name: sub.name, parent: sub.parent ? prefix + sub.parent : role, vendor: 'claude', model: sub.model ?? sub.asked, effort: null, state: done ? 'done' : 'working', since: iso(done ? endedBy(sub.endedAt ?? end ?? sub.since, end, going) : sub.since), spend: claudeSubSpend(sub), summary: line(done ? sub.result ?? sub.last : sub.last), log: file };
        child(row.parent, row, { kind: 'claude', sub }, sub.since);
      }
      // A Codex agent lives on with its thread: a later run that waits on it says how it stands now.
      for (const sub of state.codex.values()) {
        const had = codex.get(sub.id);
        codex.set(sub.id, had ? { ...sub, name: had.name !== 'Agent' ? had.name : sub.name, since: Math.min(had.since, sub.since), entries: [...had.entries, ...sub.entries], message: sub.message ?? had.message, going, end, home: homeOf(state), file } : { ...sub, going, end, home: homeOf(state), file });
      }
    }
    for (const sub of codex.values()) {
      const own = rolloutFile(sub.id, { home: sub.home, near: sub.end ?? Date.now() }), record = rolloutOf(own), done = sub.done || !sub.going;
      const row = { id: `sub:${role}:${sub.id}`, kind: 'subagent', name: sub.name, parent: role, vendor: 'codex', model: record?.model ?? null, effort: record?.effort ?? null, state: done ? 'done' : 'working', since: iso(done ? endedBy(sub.endedAt ?? sub.end ?? sub.since, sub.end, sub.going) : sub.since), spend: codexCost(record?.model ?? null, record?.tokens ?? null), summary: line(done ? sub.message ?? record?.last : record?.last || sub.message), log: own ?? sub.file };
      child(role, row, { kind: 'codex', sub, record }, sub.since);
    }
  };
  const waitsOn = id => (children.get(id) ?? []).some(row => row.state === 'working');
  // A log read whole after its run is stamped with when it was last written; what ended in a
  // run that ended did so by the run's end at the latest.
  function endedBy(at, end, going) { return Number.isFinite(at) && Number.isFinite(end) && !going ? Math.min(at, end) : at; }

  // The coder.
  const leadRuns = runs.filter(run => roleOf(run) === 'lead' && !run.overloaded && !run.standup), last = leadRuns.at(-1);
  const working = live === 'lead', ask = asks.find(row => (row.role ?? 'lead') === 'lead');
  subsFor('lead');
  const chosen = working || !last ? leadChoice(repo, task) ?? ranOn(last) : ranOn(last);
  const vendor = chosen?.vendor ?? null, effort = working || !last ? leadEffort(task, vendor) ?? (typeof task.autoEffort === 'string' ? task.autoEffort : null) ?? (last?.vendor === vendor ? last?.effort ?? null : null) : last?.effort ?? null;
  const asksOwner = ['needs_input', 'blocked'].includes(task.state) || task.plan?.state === 'proposed';
  const state = working && !ask ? 'working' : ask || asksOwner || live || waitsOn('lead') || !last ? 'waiting' : 'done';
  const question = task.state === 'needs_input' ? task.result?.question ?? null : null;
  const summary = ask ? `Asks: ${ask.summary}` : question ? question : working ? latestStep(ownSteps(activeLog, cwd)) : runReply(last?.logFile) ?? latestStep(ownSteps(last?.logFile, cwd));
  rows.push({ id: 'lead', kind: 'coder', name: agentName('lead', task, chosen ? [{ vendor, model: chosen.model ?? null }] : []), parent: null, vendor, model: chosen?.model ?? null, effort, state, since: isoOf(state === 'working' ? task.activeSince : ask ? ask.at : live ? task.activeSince : last?.at ?? task.createdAt), spend: spendOf('lead'), summary: line(summary), log: working ? activeLog : last?.logFile ?? null });
  sources.set('lead', { kind: 'coder' });

  // The bots: the session's, and any other that ran in it.
  const names = [...new Set([...sessionBots(task), ...runs.map(run => botOfKey(run.role)).filter(Boolean)])].filter(name => typeof name === 'string' && name);
  for (const name of names) {
    const role = `bot:${name}`, botRuns = runs.filter(run => roleOf(run) === role && !run.overloaded), ran = botRuns.at(-1), at = live === role, asked = asks.find(row => row.role === role);
    subsFor(role);
    let saved = null; try { const bot = getBot(name); saved = bot ? sessionBot(task, bot) : null; } catch { saved = null; }
    const model = at || !ran ? saved ? { vendor: saved.vendor, model: saved.model ?? null, effort: saved.effort ?? null } : ranOn(ran) : ranOn(ran);
    const said = (task.messages ?? []).findLast(row => isObject(row) && row.bot === name && !row.whileWorking && typeof row.text === 'string');
    const botState = at && !asked ? 'working' : asked || waitsOn(role) || !ran ? 'waiting' : 'done';
    const botSummary = asked ? `Asks: ${asked.summary}` : at ? latestStep(ownSteps(activeLog, cwd)) : said?.text ?? latestStep(ownSteps(ran?.logFile, cwd));
    rows.push({ id: role, kind: 'bot', name: `@${name}`, parent: null, vendor: model?.vendor ?? null, model: model?.model ?? null, effort: model?.effort ?? null, state: botState, since: isoOf(at ? task.activeSince : asked ? asked.at : ran?.at ?? null), spend: spendOf(role), summary: line(botSummary), log: at ? activeLog : ran?.logFile ?? null });
    sources.set(role, { kind: 'bot', name });
  }

  // Each top agent, then what it started under it, the newest CHILDREN_MOST of each.
  const out = [], put = row => {
    out.push(row);
    const under = (children.get(row.id) ?? []).map((value, index) => ({ value, index })).sort((a, b) => starts.get(a.value.id) - starts.get(b.value.id) || a.index - b.index).map(({ value }) => value).slice(-CHILDREN_MOST);
    for (const next of under) put(next);
  };
  for (const row of rows) put(row);
  for (const row of orphans) put(row);
  return { rows: out, sources };
}

// The session's agents, coder first, then bots, then each one's sub-agents and helpers under it.
/** @param {object} repo @param {object} task @returns {AgentRow[]} */
export function sessionAgents(repo, task) { return build(repo, task).rows; }

// ---- one agent's thread ----
const byTime = entries => entries.map((entry, index) => ({ entry, index, at: time(entry.at) })).sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.index - b.index).map(row => row.entry);
// The owner's own messages in the chat, to the session's model (to: null) or to a bot (to: its name).
function ownerNotes(task, to) {
  const out = [], messages = Array.isArray(task.messages) ? task.messages.filter(isObject) : [];
  if (!to && typeof task.goal === 'string' && task.goal.trim() && !messages.some(row => row.text === task.goal)) out.push({ at: isoOf(task.createdAt), kind: 'note', text: clean(task.goal) });
  for (const row of messages) {
    if (row.from || row.bot || row.line || row.update || row.standup || row.whileWorking || row.loop || typeof row.text !== 'string') continue;
    const target = typeof row.to === 'string' ? row.to.replace(/^@/, '') : null;
    if (to ? target === to : !target || target === 'model') out.push({ at: isoOf(row.at), kind: 'note', text: clean(row.text) });
  }
  return out;
}
// The steps and the reply of each of an agent's runs, newest first, until there are rows of them.
function runEntries(task, role, { rows, reply = true, activeLog = null, cwd = null }) {
  const out = [], runs = (Array.isArray(task.runs) ? task.runs : []).filter(run => isObject(run) && roleOf(run) === role && !run.overloaded);
  const files = runs.map(run => ({ file: run.logFile, at: isoOf(run.startedAt) ?? isoOf(run.at), end: isoOf(run.at) }));
  if (activeLog && !files.some(row => row.file === activeLog)) files.push({ file: activeLog, at: isoOf(task.activeSince), end: null });
  for (let index = files.length - 1; index >= 0 && out.length < rows; index--) {
    const { file, at, end } = files[index], steps = ownSteps(file, cwd).map(step => stepEntry(step, at)).filter(entry => entry?.text);
    const said = reply && end ? runReply(file) : null;
    // The reply is not also the text it wrote last.
    if (said && steps.at(-1)?.kind === 'message' && steps.at(-1).text === clean(said)) steps.pop();
    out.unshift(...steps, ...(said ? [{ at: end, kind: 'result', text: clean(said) }] : []));
  }
  return out;
}

// One agent's thread, oldest first. An id that is not one of sessionAgents' is [].
/** @param {object} repo @param {object} task @param {string} id @param {{ rows?: number }} [options] @returns {AgentEntry[]} */
export function agentThread(repo, task, id, options = {}) {
  const { rows: list, sources } = build(repo, task), row = list.find(value => value.id === id), source = row ? sources.get(id) : null;
  if (!row || !source) return [];
  const rows = Number.isSafeInteger(options?.rows) && options.rows > 0 ? options.rows : THREAD_ROWS;
  const live = LIVE.includes(task.state) && typeof task.activeRole === 'string' ? task.activeRole : null, cwd = typeof task.worktree === 'string' ? task.worktree : null;
  const activeLog = typeof task.activeLog === 'string' && task.activeLog ? task.activeLog : null;
  let entries = [];
  if (source.kind === 'coder') entries = [...ownerNotes(task, null), ...runEntries(task, 'lead', { rows, activeLog: live === 'lead' ? activeLog : null, cwd })];
  else if (source.kind === 'bot') {
    const said = (task.messages ?? []).filter(value => isObject(value) && value.bot === source.name && !value.whileWorking && typeof value.text === 'string').map(value => ({ at: isoOf(value.at), kind: 'result', text: clean(value.text) }));
    const loop = (Array.isArray(task.loop) ? task.loop : []).filter(value => isObject(value) && value.bot === source.name && typeof value.text === 'string').map(value => ({ at: isoOf(value.at), kind: 'result', text: clean(value.text) }));
    entries = [...ownerNotes(task, source.name), ...runEntries(task, `bot:${source.name}`, { rows, reply: false, activeLog: live === `bot:${source.name}` ? activeLog : null, cwd }), ...said, ...loop];
  } else if (source.kind === 'claude') entries = [...source.sub.entries];
  else if (source.kind === 'codex') {
    // Its own record says when it was asked what: the parent's log says it only where that record is not found.
    const record = source.record?.entries ?? [], has = (kind, value) => record.some(entry => entry.kind === kind && entry.text === value);
    entries = [...source.sub.entries.filter(entry => entry.kind === 'note' && !has('note', entry.text)), ...record, ...source.sub.entries.filter(entry => entry.kind === 'result' && !has('message', entry.text))];
  } else if (source.kind === 'helper') {
    const { job, helper } = source, at = isoOf(job.startedAt);
    entries = [{ at, kind: 'note', text: clean(job.line) }, ...helper.steps.map(step => stepEntry(step, at)).filter(entry => entry?.text)];
    if (!helper.steps.length && !helper.head) { const said = lastLines(job.log, 40).join('\n'); if (said.trim()) entries.push({ at, kind: 'message', text: clean(said) }); }
    if (helper.reply) entries.push({ at: isoOf(job.endedAt), kind: 'result', text: clean(helper.reply) });
    if (job.state !== 'running') entries.push({ at: isoOf(job.endedAt), kind: 'note', text: clean(endedSentence(job)) });
  }
  return byTime(entries.filter(entry => entry?.text)).slice(-rows);
}
