#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { approvalSummary, awaitDecision, requestApproval } from './approvals.mjs';
import { awaitOrFull } from './full-access.mjs';
import { APPROVAL_WAIT_SECONDS } from './modes.mjs';
import { allowedBy } from './permission-rules.mjs';

// The live approval relay for Claude Code: a stdio MCP server with one tool,
// approve, named by --permission-prompt-tool. Claude calls it for every action its permission
// mode would prompt for; the call becomes a request file the terminal answers, and the reply
// is the one text block Claude expects. Newline-delimited JSON-RPC 2.0, no dependencies.
// Every message is answered without blocking the read loop, so a ping arriving while an
// approval waits is still answered, and an unknown method never hangs the run.
// A call one of the owner's rules or a default covers (lib/permission-rules.mjs) is allowed
// here without asking; --rules says which apply: saved (his own sessions) or defaults (a
// teammate's). Without --rules every call asks. --sandboxed yes: the turn's commands really run
// in Claude Code's sandbox; with no, every command counts as leaving it.
// Full access asks the owner nothing and refuses nothing. With --mode full every call is
// allowed at once, whatever it is, as what Claude Code asks on its own output is
// (lib/runner.mjs controlRelay). With --mode ask or auto the same holds from when the owner
// sets the session to Full access while this turn works (lib/full-access.mjs): the call that
// waits is allowed, and so is each one after it. The log says by: 'full' for each. The turn of
// the bot that oversees the sessions is the one exception: Full access lifts nothing for it
// (--oversee, overseeing below).
export const SERVER_NAME = 'elu-code-approval', TOOL_NAME = 'approve';
// The owner's own sessions on Claude Code also get two tools for his other computers
// (docs/peer-network.md, "Your other computers"): one lists their sessions, one sends files
// from this computer, with a message, to one of them. --mode, --folders and --common say what
// this turn may read (--folders: every folder it adds beside its workspace, the home among them
// when it reads across it), so the send reads only that (lib/session-reads.mjs). --helps: the
// session there that this session helps (lib/remote-helper.mjs), the only one it sends to.
export const LIST_TOOL = 'list_other_sessions', SEND_TOOL = 'send_to_session';
const toolId = name => `mcp__${SERVER_NAME}__${name}`;
const DENIED = 'The owner declined this. Do not retry it another way. Finish without it and say what you could not do.';
const ID_CHARS = /[^A-Za-z0-9_-]/g, PLAIN = /^[A-Za-z0-9_-]{1,80}$/;

// --oversee: the name of the bot that oversees the owner's sessions, when this turn is its own
// (lib/bots.mjs botOversees); --servers: the MCP servers the turn was started with, as JSON.
// --led yes: that bot leads this turn of another session (lib/runner.mjs ledByOverseer); no: it
// does not. Without it that cannot be told, which is taken as yes (lib/permission-rules.mjs allowedBy led).
function options(argv) {
  const out = { session: null, root: null, task: null, role: null, vendor: null, log: null, wait: APPROVAL_WAIT_SECONDS, progress: 60, cwd: null, access: null, rules: null, sandboxed: 'no', mode: null, folders: '[]', common: null, helps: null, oversee: null, servers: '[]', led: null };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, ''), value = argv[i + 1];
    if (!Object.hasOwn(out, name) || value === undefined) throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    out[name] = ['wait', 'progress'].includes(name) ? Number(value) : value;
  }
  if (!PLAIN.test(out.session ?? '')) throw new Error('The approval server needs a plain --session id.');
  if (!(out.wait > 0) || !(out.progress > 0)) throw new Error('--wait and --progress are positive seconds.');
  if (out.log && !path.isAbsolute(out.log)) throw new Error('--log must be an absolute path.');
  if (out.cwd && !path.isAbsolute(out.cwd)) throw new Error('--cwd must be an absolute path.');
  if (out.access !== null && !['edit', 'read'].includes(out.access)) throw new Error('--access is edit or read.');
  if (out.rules !== null && !['saved', 'defaults'].includes(out.rules)) throw new Error('--rules is saved or defaults.');
  if (!['yes', 'no'].includes(out.sandboxed)) throw new Error('--sandboxed is yes or no.');
  if (out.mode !== null && !['ask', 'auto', 'full'].includes(out.mode)) throw new Error('--mode is ask, auto or full.');
  try { out.folders = JSON.parse(out.folders); } catch { out.folders = null; }
  if (!Array.isArray(out.folders) || out.folders.some(dir => typeof dir !== 'string' || !path.isAbsolute(dir))) throw new Error('--folders is a list of absolute paths.');
  if (out.common && !path.isAbsolute(out.common)) throw new Error('--common must be an absolute path.');
  if (out.helps !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(out.helps)) throw new Error('--helps is a session id.');
  if (out.oversee !== null && (!BOT.test(out.oversee) || out.role !== `bot:${out.oversee}`)) throw new Error('--oversee names the bot whose turn this is.');
  try { out.servers = JSON.parse(out.servers); } catch { out.servers = null; }
  if (!Array.isArray(out.servers) || out.servers.some(name => typeof name !== 'string')) throw new Error('--servers is a list of server names.');
  if (out.led !== null && !['yes', 'no'].includes(out.led)) throw new Error('--led is yes or no.');
  out.led = out.led !== 'no';
  return out;
}
const BOT = /^[a-z][a-z0-9-]{0,29}$/;

// ---------------------------------------------------------------------------------------
// The turn of the bot that oversees the owner's sessions (--oversee). Every question it asks is
// answered from that bot's own table first (lib/orchestrator-tools.mjs overseeingAnswer), before
// Full access and before any rule of his: an edit, a write or a command is refused in every
// mode, ELU's ten tools and a source's reading tools are allowed (act decides when one of the
// ten runs), and the rest asks him. What asks him reaches him as it is: no rule of his is
// offered for it or answers it, and a switch to Full access while he is asked does not.
// The relay serves it the ten tools, and no tool for his other computers.
// At the level Full (lib/orchestrator-seams.mjs), read anew at each question, it works with a
// shell in Full access: its edits, writes and commands are allowed by Full ('full'), but never
// one of its own files (its level, caps, mandates, log, the owner's computers), and a command of
// the ask list (FULL_ASK_LIST) asks him as above, at every level. The relay serves it every tool
// of Full then (orchToolDefs).
export const OVERSEE_DENIED = 'A bot that oversees the sessions edits nothing, runs no command, and in a Read only session uses no tool of ELU\'s, the web or a source. Do not retry it another way: say in your reply what you needed.';
export const OVERSEE_OWN_DENIED = "The bot that oversees the sessions never changes its own level, caps, mandates or action log, or which computers are the owner's own: only he does, with /orchestrator and /computers. Do not retry it another way.";
const fullNow = async () => { try { return (await import('./orchestrator-settings.mjs')).readSettings().level === 'full'; } catch { return false; } };
// ELU's own MCP server answers about the owner's product from ELU's cloud, and each question
// costs: the bot may ask it the owner's cap a day (eluCallsPerDay, lib/orchestrator-settings.mjs,
// this when it cannot be read). Each question is a line of the bot's action log
// (lib/orchestrator-actions.mjs logEluQuestion), and the lines of the last 24 hours are the count.
export const ELU_CALLS_PER_DAY = 20;
const OVERSEE_ALLOWED = 'what the bot that oversees your sessions uses without asking';
const eluAsk = name => typeof name === 'string' && name.slice(0, 10).toLowerCase() === 'mcp__elu__' && name.slice(10) === 'ask_elu';
const plainText = (value, most) => { const line = String(value ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim(); return line.length > most ? `${line.slice(0, most - 1)}…` : line; };
const UNCOUNTED = 'ELU could not count your questions to ELU today, so this one was not sent: say in your reply what you would ask.';
// Counts the bot's questions to ELU and logs this one: null when it may go, else the one
// sentence the model reads. A log that cannot be read or written stops the question: the
// count is the owner's limit.
export async function eluCall({ bot, root = null, taskId = null, run = null, input = {}, now = Date.now() } = {}) {
  let actions, settings; try { [actions, settings] = await Promise.all([import('./orchestrator-actions.mjs'), import('./orchestrator-settings.mjs')]); } catch { return UNCOUNTED; }
  let cap = ELU_CALLS_PER_DAY, level = null;
  try { const given = settings.readSettings(); level = given.level ?? null; if (Number.isInteger(given.caps?.eluCallsPerDay) && given.caps.eluCallsPerDay >= 0) cap = given.caps.eluCallsPerDay; } catch { /* The default cap. */ }
  const question = plainText(input?.question ?? input?.query ?? input?.text ?? '', 80);
  try {
    const { over, asked } = actions.logEluQuestion({ bot, from: { root, session: taskId, run }, summary: question ? `Ask ELU: "${question}"` : 'Ask ELU a question', level, cap, now });
    return over ? `The owner's cap is ${cap} questions to ELU a day and you asked ${asked} in the last 24 hours, so this one was not sent: say in your reply what you would ask.` : null;
  } catch { return UNCOUNTED; }
}
// One question of the overseeing turn, answered: { decision, by, rule, summary, message }.
// decision is allow, deny or timeout; message what the model reads when it is not allow. ctx:
// what the relay knows of the turn; onAsk(summary) and onAnswer() go around the wait for the
// owner. lib/runner.mjs controlRelay answers what Claude Code asks on its output the same way.
export async function overseeing(tool, input, { id, mode = null, root = null, taskId = null, role = null, vendor = null, bot, servers = [], run = null, cwd = null, access = null, rules = null, sandboxed = false, waitSeconds = APPROVAL_WAIT_SECONDS, signal, onAsk, onAnswer, now = Date.now() } = {}) {
  const summary = approvalSummary(tool, input), full = await fullNow();
  let answer, works = false; try { const tools = await import('./orchestrator-tools.mjs'); answer = tools.overseeingAnswer(tool, { mode, servers, input, full, cwd }); works = full && mode !== 'locked' && tools.fullWork(tool); } catch { answer = 'deny'; }
  if (answer === 'deny') return { decision: 'deny', by: 'oversee', summary, message: works ? OVERSEE_OWN_DENIED : OVERSEE_DENIED };
  // At Full, in Full access, its own work is allowed as any Full access turn's is.
  if (answer === 'allow' && works) return { decision: 'allow', by: 'full', summary };
  if (answer === 'allow') {
    const over = eluAsk(tool) ? await eluCall({ bot, root, taskId, run, input, now }) : null;
    // Said in the session as allowed by default (task.approvals, lib/approvals.mjs readApprovalLog), never as his yes.
    return over ? { decision: 'deny', by: 'oversee', summary, message: over } : { decision: 'allow', by: 'default', rule: OVERSEE_ALLOWED, summary };
  }
  // What the table leaves to the relay (a file read, a helper) one of his rules may allow, never Full access.
  // The bot's own turn is led by it (led).
  if (answer === null && rules) { let ruled = null; try { ruled = allowedBy(tool, input, { project: root || null, cwd, access, saved: rules === 'saved', sandboxed, mode, led: true }); } catch { ruled = null; } if (ruled) return { decision: 'allow', by: ruled.by, rule: ruled.text, summary }; }
  // Marked as the bot's (oversee), so the app answers it for him in no mode, whatever its role reads as by then.
  let asked = summary;
  try { ({ summary: asked } = requestApproval({ id, root, taskId, role, vendor, tool, input, waitSeconds, oversee: true })); }
  catch (error) { if (!/already requested/.test(error.message)) return { decision: 'deny', summary, message: DENIED }; }
  try { onAsk?.(asked); } catch { /* Nothing to show. */ }
  let decision; try { decision = await awaitDecision(id, { waitSeconds, signal }); } catch { decision = 'deny'; }
  finally { try { onAnswer?.(); } catch { /* Nothing to end. */ } }
  return { decision, summary: asked, ...(decision === 'allow' ? {} : { message: decision === 'timeout' ? timeoutText(waitSeconds) : DENIED }) };
}
// Nobody answered, which is not a no: the turn goes on with the rest instead of stopping there.
const timeoutText = wait => `No answer from the owner within ${Math.max(1, Math.round(wait / 60))} minutes. Do not retry it another way. Nobody declined it. Go on with the work that does not need it, and say at the end what still waits for their answer.`;
const TOOL = { name: TOOL_NAME, description: 'Asks the owner of this session to allow or deny a tool call.', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } };
const PEER_TOOLS = [
  { name: LIST_TOOL, description: "Lists the sessions of the owner's shared projects on the other computers on them, some of which may be another person's: each one's computer, id, title, state, and the question or approval it waits on.", inputSchema: { type: 'object', properties: {} } },
  { name: SEND_TOOL, description: "Sends files or folders from this computer, with a message, to a session of a shared project on another computer, which may be another person's (an id from list_other_sessions). The message reaches that session as one from this computer, under that project's access rules there; each path it names is put where its file landed there. Paths are absolute or start with ~/. With no paths, the message goes alone.", inputSchema: { type: 'object', properties: { session: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, message: { type: 'string' } }, required: ['session'] } },
];
// What the owner is asked about a send in Ask for approval: which session, on which computer,
// and the paths. target: { computer, title } of the session, or null when none of his has that id.
function sendTitle(input, target) {
  const paths = Array.isArray(input?.paths) ? input.paths.filter(item => typeof item === 'string').slice(0, 5) : [];
  const title = String(target?.title ?? '').replace(/[\x00-\x1f\x7f"]+/g, ' ').trim().slice(0, 80);
  const to = target ? `Send to ${title ? `"${title}"` : 'a session'} on ${target.computer}` : 'Send to a session on another computer that is not listed';
  const said = typeof input?.message === 'string' ? input.message.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return `${to}: ${paths.join(', ') || (said ? `the message "${said.slice(0, 80)}${said.length > 80 ? '…' : ''}"` : 'nothing')}${(input?.paths?.length ?? 0) > 5 ? ', …' : ''}`;
}

export async function serve({ argv = process.argv.slice(2), input = process.stdin, output = process.stdout } = {}) {
  const opts = options(argv);
  const send = value => { try { output.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`); } catch { /* Claude closed the pipe; the run is over. */ } };
  const reply = (id, result) => send({ id, result }), fail = (id, code, message) => send({ id, error: { code, message } });
  let calls = 0;
  const record = row => { if (opts.log) { try { fs.appendFileSync(opts.log, `${JSON.stringify(row)}\n`, { mode: 0o600 }); } catch { /* The decision still reaches Claude. */ } } };
  async function approve(id, params) {
    const args = params?.arguments ?? {};
    const tool = typeof args.tool_name === 'string' && args.tool_name.trim() ? args.tool_name.slice(0, 120) : 'unknown';
    const use = String(args.tool_use_id ?? '').replace(ID_CHARS, '').slice(0, 78) || `call-${++calls}`;
    const approvalId = `${opts.session}-${use}`;
    // The bot that oversees the sessions: its own table answers first, in every mode (overseeing).
    if (opts.oversee) {
      const token = params?._meta?.progressToken; let ticks = 0, timer = null;
      const out = await overseeing(tool, args.input ?? {}, { id: approvalId, mode: opts.mode, root: opts.root, taskId: opts.task, role: opts.role, vendor: opts.vendor, bot: opts.oversee, servers: opts.servers, run: opts.session, cwd: opts.cwd, access: opts.access, rules: opts.rules, sandboxed: opts.sandboxed === 'yes', waitSeconds: opts.wait,
        onAsk: summary => { timer = setInterval(() => { if (token !== undefined) send({ method: 'notifications/progress', params: { progressToken: token, progress: ++ticks, message: `Waiting for the owner: ${summary}` } }); }, opts.progress * 1000); }, onAnswer: () => clearInterval(timer) });
      record({ id: approvalId, tool, summary: out.summary, decision: out.decision, ...(out.by ? { by: out.by } : {}), ...(out.rule ? { rule: out.rule } : {}), ...(out.decision === 'timeout' ? { wait: opts.wait } : {}), at: new Date().toISOString() });
      return reply(id, text(out.decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: out.message }));
    }
    // Full access: allowed at once, with nothing written for the owner to answer.
    const switched = await sessionSwitched();
    if (opts.mode === 'full' || switched?.()) { record({ id: approvalId, tool, summary: approvalSummary(tool, args.input), decision: 'allow', by: 'full', at: new Date().toISOString() }); return reply(id, text({ behavior: 'allow' })); }
    // A rule or a default answers at once; nothing is written for the owner to answer.
    let ruled = null;
    if (opts.rules) { try { ruled = allowedBy(tool, args.input, { project: opts.root || null, cwd: opts.cwd, access: opts.access, saved: opts.rules === 'saved', sandboxed: opts.sandboxed === 'yes', mode: opts.mode, led: opts.led }); } catch { ruled = null; } }
    if (ruled) { record({ id: approvalId, tool, summary: approvalSummary(tool, args.input), decision: 'allow', by: ruled.by, rule: ruled.text, at: new Date().toISOString() }); return reply(id, text({ behavior: 'allow' })); }
    // Listing the owner's sessions on his other computers reads nothing of the project: it is answered at once.
    if (peers && tool === toolId(LIST_TOOL)) { record({ id: approvalId, tool, summary: 'List the sessions of your shared projects on other computers', decision: 'allow', by: 'default', at: new Date().toISOString() }); return reply(id, text({ behavior: 'allow' })); }
    let summary;
    let title = null;
    // A Standup's Kanban tools: reading the boards is answered at once, and a change too unless
    // the session asks for approval, where the owner is asked with what it changes.
    const board = (await kanban())?.mod.KANBAN_TOOLS.find(name => tool === toolId(name));
    if (board && (board === 'kanban_list' || opts.mode !== 'ask')) { record({ id: approvalId, tool, summary: board === 'kanban_list' ? 'Read the Kanban boards' : 'Change the Kanban', decision: 'allow', by: 'default', at: new Date().toISOString() }); return reply(id, text({ behavior: 'allow' })); }
    if (board) { const { mod } = await kanban(); title = mod.kanbanTitle(board, args.input, mod.standupSession(opts.root, opts.task)); }
    if (tool === toolId(SEND_TOOL)) { let target = null; try { target = peers ? (await import('./peer/session-tools.mjs')).sendTarget(args.input?.session) : null; } catch { target = null; } title = sendTitle(args.input, target); }
    try { ({ summary } = requestApproval({ id: approvalId, root: opts.root, taskId: opts.task, role: opts.role, vendor: opts.vendor, tool, input: args.input, title, waitSeconds: opts.wait, cwd: opts.cwd, access: opts.access, rules: opts.rules, sandboxed: opts.sandboxed === 'yes', led: opts.led })); }
    catch (error) {
      // The same call asked twice waits on the first request; anything else is answered as a denial.
      if (!/already requested/.test(error.message)) { record({ id: approvalId, tool, summary: approvalSummary(tool, args.input), decision: 'deny', at: new Date().toISOString() }); return reply(id, text({ behavior: 'deny', message: DENIED })); }
      summary = approvalSummary(tool, args.input);
    }
    const token = params?._meta?.progressToken; let ticks = 0;
    const timer = setInterval(() => { if (token !== undefined) send({ method: 'notifications/progress', params: { progressToken: token, progress: ++ticks, message: `Waiting for the owner: ${summary}` } }); }, opts.progress * 1000);
    // The owner answers it, or sets the session to Full access first: then it is allowed for him.
    let decision, by;
    try { ({ decision, by } = await awaitOrFull(approvalId, switched, { waitSeconds: opts.wait })); } catch { decision = 'deny'; }
    finally { clearInterval(timer); }
    record({ id: approvalId, tool, summary, decision, ...(by ? { by } : {}), ...(decision === 'timeout' ? { wait: opts.wait } : {}), at: new Date().toISOString() });
    reply(id, text(decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: decision === 'timeout' ? timeoutText(opts.wait) : DENIED }));
  }
  const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  // Whether this relay's session was set to Full access since its turn began, read anew at
  // each call (lib/full-access.mjs). null where that cannot be: a turn that started in Full
  // access, a relay that was told no mode, or a session of no project on this computer.
  let session = null;
  const sessionSwitched = () => session ??= ['ask', 'auto'].includes(opts.mode) && typeof opts.root === 'string' && /^[1-9][0-9]*$/.test(String(opts.task ?? ''))
    ? Promise.all([import('./projects.mjs'), import('./state.mjs'), import('./full-access.mjs')]).then(([projects, state, full]) => {
      const repo = projects.registeredProjects().find(row => row.root === opts.root);
      return repo ? () => { try { return full.switchedToFull(state.readTask(repo, String(opts.task)), opts.role ?? 'lead'); } catch { return false; } } : null;
    }).catch(() => null)
    : Promise.resolve(null);
  // The tools for the owner's other computers: only in his own sessions with permissions, and
  // never to the bot that oversees them: it reaches the sessions there only through its own
  // tools (lib/orchestrator-actions.mjs), which send no file and mark each note as its own.
  const peers = !opts.oversee && opts.rules === 'saved' && opts.mode !== null && (opts.vendor ?? 'claude') === 'claude';
  // The ten tools of the bot that oversees the sessions (lib/orchestrator-tools.mjs): only to its
  // own turn, in a session of this computer's owner, read anew at each call (orchSession).
  let orch = null;
  const orchestrator = async () => {
    const mod = await (orch ??= opts.oversee ? import('./orchestrator-tools.mjs').catch(() => null) : Promise.resolve(null));
    if (!mod) return null;
    try { const found = mod.orchSession(opts.root, opts.task, opts.role); return found ? { mod, found } : null; } catch { return null; }
  };
  async function orchCall(id, params) {
    const here = await orchestrator();
    if (!here || !here.mod.ORCH_TOOLS.includes(params?.name)) return fail(id, -32602, `Unknown tool: ${String(params?.name ?? '').slice(0, 60)}`);
    const token = params?._meta?.progressToken; let ticks = 0, timer = null;
    const onAsk = summary => { clearInterval(timer); timer = setInterval(() => { if (token !== undefined) send({ method: 'notifications/progress', params: { progressToken: token, progress: ++ticks, message: `Waiting for the owner: ${summary}` } }); }, opts.progress * 1000); };
    try { reply(id, said(await here.mod.orchTool(params.name, params.arguments ?? {}, here.found, { mode: opts.mode, vendor: opts.vendor, run: opts.session, cwd: opts.cwd, waitSeconds: opts.wait, onAsk, onAnswer: () => clearInterval(timer) }))); }
    catch (error) { reply(id, said(error.message, true)); }
    finally { clearInterval(timer); }
  }
  const said = (value, error = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(error ? { isError: true } : {}) });
  // A Standup session's agent also has the Kanban tools (lib/standup-kanban.mjs, docs/standup.md).
  let standup = null;
  const kanban = () => standup ??= peers && opts.role === 'lead' ? import('./standup-kanban.mjs').then(mod => mod.standupSession(opts.root, opts.task) ? { mod } : null, () => null) : Promise.resolve(null);
  async function kanbanCall(id, params) {
    const found = await kanban();
    if (!found) return fail(id, -32602, `Unknown tool: ${String(params?.name ?? '').slice(0, 60)}`);
    try { reply(id, said(found.mod.kanbanTool(params.name, params.arguments ?? {}, found.mod.standupSession(opts.root, opts.task)))); }
    catch (error) { reply(id, said(error.message, true)); }
  }
  async function peerTool(id, params) {
    const token = params?._meta?.progressToken; let ticks = 0;
    const timer = setInterval(() => { if (token !== undefined) send({ method: 'notifications/progress', params: { progressToken: token, progress: ++ticks, message: 'Sending to the other computer' } }); }, opts.progress * 1000);
    try {
      const tools = await import('./peer/session-tools.mjs');
      const reads = (await import('./session-reads.mjs')).sessionReads({ cwd: opts.cwd, folders: opts.folders, mode: opts.mode, common: opts.common });
      reply(id, said(params.name === LIST_TOOL ? tools.otherSessions() : await tools.sendToSession(params.arguments ?? {}, { reads, from: opts.task && opts.root ? { task: opts.task, root: opts.root } : null, only: opts.helps })));
    } catch (error) { reply(id, said(error.message, true)); }
    finally { clearInterval(timer); }
  }
  function handle(row) {
    const { id, method, params } = row;
    if (method === 'initialize') return reply(id, { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: '1' } });
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return Promise.all([kanban(), orchestrator()]).then(([found, here]) => reply(id, { tools: [TOOL, ...(peers ? PEER_TOOLS : []), ...(found ? found.mod.KANBAN_TOOL_DEFS : []), ...(here ? typeof here.mod.orchToolDefs === 'function' ? here.mod.orchToolDefs() : here.mod.ORCH_TOOL_DEFS : [])] }));
    if (method === 'tools/call') return params?.name === TOOL_NAME ? approve(id, params) : opts.oversee ? orchCall(id, params) : peers && [LIST_TOOL, SEND_TOOL].includes(params?.name) ? peerTool(id, params) : String(params?.name ?? '').startsWith('kanban_') ? kanbanCall(id, params) : fail(id, -32602, `Unknown tool: ${String(params?.name ?? '').slice(0, 60)}`);
    return fail(id, -32601, 'Method not found');
  }
  const lines = readline.createInterface({ input });
  lines.on('line', line => {
    if (!line.trim()) return;
    let row; try { row = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return fail(null, -32600, 'Invalid request');
    if (row.method === undefined) return; // A response to a notification of ours: nothing to do.
    if (row.id === undefined || row.id === null) return; // Notifications (initialized, cancelled) need no reply.
    handle(row);
  });
  await new Promise(resolve => { lines.once('close', resolve); input.once('end', resolve); });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.on('error', () => process.exit(0));
  try { await serve(); process.exit(0); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }
}
