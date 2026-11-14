// One Codex turn that takes messages while it works. `codex exec` reads its prompt to the end
// of its input and takes nothing more; `codex app-server` (JSON-RPC on stdio) takes a message
// into the turn that is running with turn/steer, and the turn reads it at its next step. This
// program is started in place of `codex exec --json` (lib/runner.mjs), speaks to the app-server,
// and writes the turn to its output as exec writes it, so everything that reads a Codex run
// reads this one the same way: thread.started, turn.started, item.started and item.completed,
// turn.completed with the thread's tokens, error and turn.failed.
//
// Read on codex-cli 0.167.0 against a local stand-in model service, never the real backend:
// - turn/steer { threadId, expectedTurnId, input, clientUserMessageId } is answered at once
//   with { turnId }. While a command runs the turn takes the message when the command ends;
//   while the model writes, at once. Either way the server then writes item/started for a
//   userMessage whose clientId is that id, and the next request to the model holds the message.
// - With no turn running it answers the error "no active turn to steer". A method the release
//   does not have is answered "Invalid request: unknown variant".
// - turn/interrupt ends the turn as interrupted and drops a message it had not read yet; the
//   next turn/start goes on in the same thread.
// - A thread exec made resumes here (thread/resume) and one made here resumes in exec; both
//   report the thread's tokens as one total.
// - The app-server has no --ignore-user-config and no --ignore-rules: it reads the owner's
//   config.toml (config/read names that layer) and his .rules files, and `-c mcp_servers={}`
//   does not take his servers away.
//
// So it decides for each launch, by asking the installed program: a release with no app-server
// or no turn/steer runs `codex exec` as before (fallback), and so does a launch outside Full
// access on a computer whose Codex has a config.toml or rules of the owner's, which exec is
// told to ignore and the app-server cannot be. Nothing is printed before that is decided, so a
// fallback's output is exec's own.
//
// Input, after the prompt: the lines Claude Code's stream-json input takes (lib/runner.mjs
// inboxFeed), so one feed serves both. A user message with a uuid goes to the turn and is
// answered with command_lifecycle lines: queued (Codex has it), started (the turn read it),
// completed, or discarded (the turn ended first, or would not take it). While the turn runs a
// command the message is kept here and steered the moment the command ends, which is when
// Codex would read it anyway: Codex has no way to take a message back once it has it, so
// until then cancel_async_message still can. interrupt with send_now interrupts the turn,
// which stops the command it runs (the init line says so: send_now_stops_v1), and starts the
// next turn of this same run with every message the turn had not read.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export const TAKES = 'msg_lifecycle_v1', NOW = 'interrupt_send_now_v1', STOPS = 'send_now_stops_v1';
const VALUE_FLAGS = new Set(['-c', '--config', '--model', '-m', '--sandbox', '--cd', '--output-schema']);
const PLAIN_FLAGS = new Set(['--ignore-user-config', '--ignore-rules', '--json', '--skip-git-repo-check', '-']);
// What an exec launch says, for the app-server: its config keys, its thread, its folder and
// its schema. null for a launch with a flag this program does not know: exec runs that one.
export function describe(args) {
  if (!Array.isArray(args) || args[0] !== 'exec') return null;
  const out = { resume: null, pairs: [], cwd: null, schemaFile: null, model: null };
  let at = 1;
  if (args[1] === 'resume') { if (typeof args[2] !== 'string') return null; out.resume = args[2]; at = 3; }
  for (; at < args.length; at++) {
    const flag = args[at];
    if (PLAIN_FLAGS.has(flag)) continue;
    if (!VALUE_FLAGS.has(flag) || typeof args[at + 1] !== 'string') return null;
    const value = args[++at];
    if (flag === '-c' || flag === '--config') out.pairs.push(value);
    else if (flag === '--model' || flag === '-m') out.model = value;
    else if (flag === '--sandbox') out.pairs.push(`sandbox_mode=${JSON.stringify(value)}`);
    else if (flag === '--cd') out.cwd = value;
    else out.schemaFile = value;
  }
  return out;
}
// The sandbox and the approval policy of a launch, named on the thread too, so a thread that
// is resumed runs under this launch's and not under the ones it was made with.
const KEY = (launch, name) => { const pair = launch.pairs.findLast(value => value.startsWith(`${name}=`)); if (!pair) return null; try { const value = JSON.parse(pair.slice(name.length + 1)); return typeof value === 'string' ? value : null; } catch { return null; } };
export function threadSettings(launch) {
  const sandbox = KEY(launch, 'sandbox_mode'), approval = KEY(launch, 'approval_policy');
  return { ...(['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox) ? { sandbox } : {}), ...(['untrusted', 'on-request', 'never'].includes(approval) ? { approvalPolicy: approval } : {}), ...(launch.model ? { model: launch.model } : {}) };
}
export const serverArgs = launch => ['app-server', '--listen', 'stdio://', ...launch.pairs.flatMap(pair => ['-c', pair]), ...(launch.model ? ['-c', `model=${JSON.stringify(launch.model)}`] : [])];
const STATUS = { inProgress: 'in_progress', completed: 'completed', failed: 'failed', declined: 'declined', interrupted: 'failed' };
const texts = list => (Array.isArray(list) ? list : []).filter(value => typeof value === 'string' && value.trim());
// An item of the app-server as exec --json writes it, or null for a kind exec does not write.
export function execItem(item) {
  const id = item?.id ?? null;
  switch (item?.type) {
    case 'agentMessage': return { id, type: 'agent_message', text: String(item.text ?? '') };
    case 'reasoning': { const text = (texts(item.summary).length ? texts(item.summary) : texts(item.content)).join('\n\n'); return text ? { id, type: 'reasoning', text } : null; }
    case 'commandExecution': return { id, type: 'command_execution', command: String(item.command ?? ''), aggregated_output: String(item.aggregatedOutput ?? ''), exit_code: Number.isInteger(item.exitCode) ? item.exitCode : null, status: STATUS[item.status] ?? 'in_progress' };
    case 'fileChange': return { id, type: 'file_change', changes: (Array.isArray(item.changes) ? item.changes : []).map(change => ({ path: change?.path, kind: typeof change?.kind === 'string' ? change.kind : change?.kind?.type ?? 'update' })), status: STATUS[item.status] ?? 'in_progress' };
    case 'mcpToolCall': return { id, type: 'mcp_tool_call', server: item.server ?? null, tool: item.tool ?? null, arguments: item.arguments ?? null, result: item.result ?? null, error: item.error ?? null, status: STATUS[item.status] ?? 'in_progress' };
    case 'collabAgentToolCall': return { id, type: 'collab_tool_call', tool: item.tool ?? null, sender_thread_id: item.senderThreadId ?? null, receiver_thread_ids: item.receiverThreadIds ?? [], prompt: item.prompt ?? null, agents_states: item.agentsStates ?? {}, status: STATUS[item.status] ?? 'in_progress' };
    case 'webSearch': return { id, type: 'web_search', query: String(item.query ?? ''), action: item.action ?? null };
    default: return null;
  }
}
// The kinds exec writes a line for when they start; a message or a thought has one line, when it ends.
const STARTS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'collab_tool_call', 'web_search']);
const usageOf = total => ({ input_tokens: total?.inputTokens ?? 0, cached_input_tokens: total?.cachedInputTokens ?? 0, cache_write_input_tokens: total?.cacheWriteInputTokens ?? 0, output_tokens: total?.outputTokens ?? 0, reasoning_output_tokens: total?.reasoningOutputTokens ?? 0 });
// Whether an answer says the release has no such method.
export const noMethod = error => error?.code === -32601 || /unknown variant|method not found|unknown method/i.test(String(error?.message ?? ''));
// The owner's rules files, which exec --ignore-rules leaves out: in his Codex folder, and in a
// .codex folder of the workspace or one above it.
function ruleFiles(home, cwd) {
  const dirs = [home ? path.join(home, 'rules') : null];
  for (let dir = path.resolve(cwd), last = null; dir !== last; last = dir, dir = path.dirname(dir)) dirs.push(path.join(dir, '.codex', 'rules'));
  return dirs.some(dir => { try { return dir && fs.readdirSync(dir).some(name => name.endsWith('.rules')); } catch { return false; } });
}

// Whether the Codex at bin takes a message into a running turn: its app-server answers
// turn/steer as a method it has. The installed program is asked, once for each program file
// (its path, size and time), and never judged by its version. No thread or turn is started,
// and nothing reaches a model. A program that could not be asked is asked again a minute later.
const asked = new Map();
export function steers(bin, { env = process.env, cwd = process.cwd(), timeoutMs = 15000 } = {}) {
  let key; try { const stat = fs.statSync(bin); key = `${bin}\0${stat.size}\0${stat.mtimeMs}`; } catch { return Promise.resolve(false); }
  const known = asked.get(key);
  if (known && (known.until === null || Date.now() < known.until)) return known.answer;
  const entry = { until: null, answer: null };
  entry.answer = ask(bin, { env, cwd, timeoutMs }).then(value => { if (value === null) entry.until = Date.now() + 60000; return value === true; });
  asked.set(key, entry); return entry.answer;
}
// true or false as the program answered; null when it could not be asked.
function ask(bin, { env, cwd, timeoutMs }) {
  return new Promise(resolve => {
    let child, pending = '', settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); try { child?.stdin.end(); } catch { /* Gone. */ } try { child?.kill('SIGKILL'); } catch { /* Gone. */ } resolve(value); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try { child = spawn(bin, ['app-server', '--listen', 'stdio://'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { return finish(false); }
    const send = row => { try { child.stdin.write(`${JSON.stringify(row)}\n`); } catch { /* Its close answers. */ } };
    child.stdin.on('error', () => {}); child.once('error', () => finish(false)); child.once('close', () => finish(false));
    child.stdout.on('data', chunk => {
      pending += chunk; let at;
      while ((at = pending.indexOf('\n')) >= 0 && !settled) {
        const line = pending.slice(0, at); pending = pending.slice(at + 1);
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row.id === 1) { if (row.error) return finish(false); send({ method: 'initialized' }); send({ id: 2, method: 'turn/steer', params: { threadId: '00000000-0000-4000-8000-000000000000', expectedTurnId: 'none', input: [] } }); }
        else if (row.id === 2) finish(!(row.error && noMethod(row.error)));
        else if (row.id != null && row.method) send({ id: row.id, error: { code: -32601, message: 'This client does not answer that request.' } });
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'elu_code', title: 'ELU', version: '0' }, capabilities: {} } });
  });
}
// The launch that runs an exec launch of Codex through this program: this node, this file,
// and what exec would have been started with. isolated: exec leaves out the owner's own
// config.toml and rules (every mode but Full access), so the app-server runs the turn only
// where there are none.
export function liveLaunch(bin, exec, { isolated = true } = {}) {
  return { bin: process.execPath, args: [new URL(import.meta.url).pathname, JSON.stringify({ bin, exec, isolated })] };
}

async function main() {
  let config; try { config = JSON.parse(process.argv[2]); } catch { process.stderr.write('codex-live: no launch given.\n'); process.exit(2); }
  const launch = describe(config.exec), debug = process.env.ELU_CODEX_LIVE_DEBUG ? text => process.stderr.write(`codex-live: ${text}\n`) : () => {};
  const say = row => process.stdout.write(`${JSON.stringify(row)}\n`);
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity }), inbox = [];
  let onLine = line => inbox.push(line), closed = false;
  lines.on('line', line => onLine(line)); lines.on('close', () => { closed = true; });
  process.stdin.on('error', () => {});
  // The prompt is the first line: the one stream-json message a run with an open input reads first.
  const first = await new Promise(resolve => { if (inbox.length) return resolve(inbox.shift()); onLine = line => { onLine = value => inbox.push(value); resolve(line); }; lines.once('close', () => resolve(null)); });
  let prompt = ''; try { const content = JSON.parse(first ?? '').message?.content; prompt = typeof content === 'string' ? content : ''; } catch { prompt = first ?? ''; }

  let server = null, began = false, ending = false;
  // exec, as before: its output and its exit are this program's.
  const fallback = why => {
    if (began || ending) return; ending = true; debug(`exec runs this turn: ${why}`);
    if (server) { server.removeAllListeners('close'); try { server.kill('SIGKILL'); } catch { /* Gone. */ } }
    const child = spawn(config.bin, config.exec, { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.on('error', () => {}); child.stdin.end(prompt);
    child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exit(127); });
    child.once('close', code => process.exit(code ?? 1));
  };
  if (!launch) return fallback('a flag the app-server launch does not know');
  const cwd = launch.cwd ?? process.cwd();
  let schema = null; try { schema = launch.schemaFile ? JSON.parse(fs.readFileSync(launch.schemaFile, 'utf8')) : null; } catch { return fallback('the output schema could not be read'); }

  try { server = spawn(config.bin, serverArgs(launch), { cwd, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] }); } catch (error) { return fallback(error.message); }
  server.stdin.on('error', () => {});
  const waits = new Map(); let seq = 0, pending = '', held = [], live = false;
  const write = row => { try { server.stdin.write(`${JSON.stringify(row)}\n`); } catch { /* It has gone; its close says so. */ } };
  const call = (method, params, ms = null) => new Promise((resolve, reject) => {
    const id = ++seq, timer = ms ? setTimeout(() => { waits.delete(id); reject(new Error(`no answer to ${method}`)); }, ms) : null;
    waits.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    write({ id, method, ...(params === undefined ? {} : { params }) });
  });
  let thread = null, turn = null, usage = null, todo = null, todoShown = false, warned = 0, failure = null, restart = null, done = false;
  // The messages the owner sent to this turn, by their uuid. state: held (not at Codex yet),
  // steered (Codex has it), taken (the turn read it), gone.
  // busy: the commands the turn runs now. A message waits here while there is one.
  const messages = new Map(), busy = new Set();
  const lifecycle = (uuid, state) => say({ type: 'command_lifecycle', command_uuid: uuid, state });
  const waiting = () => [...messages.values()].filter(item => ['held', 'steered'].includes(item.state));
  const finish = code => {
    if (done) return; done = true;
    for (const item of messages.values()) { if (item.state === 'taken') lifecycle(item.uuid, 'completed'); else if (['held', 'steered'].includes(item.state)) { item.state = 'gone'; lifecycle(item.uuid, 'discarded'); } }
    const exit = () => process.exit(code);
    server.removeAllListeners('close'); server.once('close', exit);
    // The server writes the last of the thread to its file as the turn ends: its input is
    // closed a moment later, and it ends by itself.
    setTimeout(() => { try { server.stdin.end(); } catch { /* Gone. */ } }, 200);
    setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* Gone. */ } exit(); }, 3000);
  };
  const fail = message => { if (done) return; say({ type: 'error', message }); say({ type: 'turn.failed', error: { message } }); finish(1); };
  const steer = item => {
    if (!turn || restart || busy.size || item.state !== 'held' || item.sending) return;
    item.sending = true;
    call('turn/steer', { threadId: thread, expectedTurnId: turn, input: [{ type: 'text', text: item.text, text_elements: [] }], clientUserMessageId: item.uuid }).then(() => { item.sending = false; if (item.state === 'held') { item.state = 'steered'; lifecycle(item.uuid, 'queued'); } }, () => { item.sending = false; if (item.state === 'held') { item.state = 'gone'; lifecycle(item.uuid, 'discarded'); } });
  };
  // The next turn of this run, after a send now interrupted the one before: every message that turn had not read.
  const again = () => {
    const batch = waiting(); restart = null; turn = null;
    if (!batch.length) return fail('The turn was interrupted.');
    busy.clear(); for (const item of batch) { item.state = 'steered'; item.batch = batch[0].uuid; }
    const read = () => { for (const item of batch) if (item.state === 'steered') { item.state = 'taken'; lifecycle(item.uuid, 'started'); } };
    call('turn/start', { threadId: thread, input: batch.map(item => ({ type: 'text', text: item.text, text_elements: [] })), ...(schema ? { outputSchema: schema } : {}), clientUserMessageId: batch[0].uuid }).then(read, error => fail(String(error?.message ?? 'Codex did not start the next turn.')));
  };
  const answer = (id, result) => write({ id, result });
  // What the server asks of its client. exec has nobody to ask, and neither has this run: an
  // approval is declined, a question gets no answer, and anything else is answered as an
  // error, so the turn never waits on it.
  const asked = row => {
    const method = String(row.method);
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) return answer(row.id, { decision: 'decline' });
    if (['execCommandApproval', 'applyPatchApproval'].includes(method)) return answer(row.id, { decision: 'denied' });
    if (method === 'item/permissions/requestApproval') return answer(row.id, { permissions: {} });
    if (method === 'item/tool/requestUserInput') return answer(row.id, { answers: {} });
    if (method === 'mcpServer/elicitation/request') return answer(row.id, { action: 'decline' });
    if (method === 'item/tool/call') return answer(row.id, { success: false, contentItems: [] });
    write({ id: row.id, error: { code: -32601, message: 'This client does not answer that request.' } });
  };
  const notified = row => {
    const params = row.params ?? {}, method = row.method;
    if (params.threadId && params.threadId !== thread) return;
    if (method === 'turn/started') { const before = turn; turn = params.turn?.id ?? turn; if (!before && !began) { began = true; } if (!notified.started) { notified.started = true; say({ type: 'turn.started' }); } for (const item of messages.values()) steer(item); return; }
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item ?? {}, ended = method === 'item/completed';
      if (item.type === 'userMessage') {
        // The turn read a message of the owner's: the one steered into it, or the ones the next turn started with.
        if (!ended && item.clientId) for (const mine of messages.values()) if ((mine.uuid === item.clientId || mine.batch === item.clientId) && mine.state === 'steered') { mine.state = 'taken'; lifecycle(mine.uuid, 'started'); }
        return;
      }
      if (item.type === 'commandExecution' && item.id) { if (ended) busy.delete(item.id); else busy.add(item.id); }
      const mapped = execItem(item);
      if (ended && !busy.size) for (const mine of messages.values()) steer(mine);
      if (!mapped) return;
      if (!ended && !STARTS.has(mapped.type)) return;
      say({ type: ended ? 'item.completed' : 'item.started', item: mapped }); return;
    }
    if (method === 'turn/plan/updated' && Array.isArray(params.plan)) {
      todo = { id: 'item_plan', type: 'todo_list', items: params.plan.map(step => ({ text: String(step?.step ?? ''), completed: step?.status === 'completed' })) };
      say({ type: todoShown ? 'item.updated' : 'item.started', item: todo }); todoShown = true; return;
    }
    if (method === 'thread/tokenUsage/updated') { usage = params.tokenUsage?.total ?? usage; return; }
    if (method === 'warning' && typeof params.message === 'string') { say({ type: 'item.completed', item: { id: `item_note_${++warned}`, type: 'error', message: params.message } }); return; }
    if (method === 'error') { const message = String(params.error?.message ?? 'Codex reported an error.'); if (params.willRetry !== true) failure = message; say({ type: 'error', message }); return; }
    if (method === 'turn/completed') {
      const status = params.turn?.status, error = params.turn?.error?.message ?? null;
      if (status === 'interrupted' && restart) return again();
      if (todo && todoShown) say({ type: 'item.completed', item: todo });
      if (status === 'completed') { say({ type: 'turn.completed', usage: usageOf(usage) }); return finish(0); }
      const message = error ?? failure ?? (status === 'interrupted' ? 'The turn was interrupted.' : 'Codex did not complete the turn.');
      if (message !== failure) say({ type: 'error', message });
      say({ type: 'turn.failed', error: { message } }); return finish(1);
    }
  };
  const received = row => {
    if (row.id != null && row.method) return asked(row);
    if (row.id != null) { const wait = waits.get(row.id); if (!wait) return; waits.delete(row.id); if (row.error) wait.reject(Object.assign(new Error(String(row.error.message ?? 'refused')), { code: row.error.code })); else wait.resolve(row.result ?? {}); return; }
    if (!row.method) return;
    if (!live) held.push(row); else notified(row);
  };
  server.stdout.on('data', chunk => {
    pending += chunk; let at;
    while ((at = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, at); pending = pending.slice(at + 1); if (!line.trim()) continue; let row; try { row = JSON.parse(line); } catch { continue; } try { received(row); } catch (error) { debug(error.message); } }
  });
  server.once('error', error => fallback(error.message));
  server.once('close', () => { for (const wait of waits.values()) wait.reject(new Error('Codex ended.')); waits.clear(); if (!began) fallback('the app-server ended before the turn began'); else fail('Codex ended before the turn did.'); });

  // What the owner writes while the turn works, and what he asks of a message that waits.
  const reply = (id, response) => say({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
  const take = line => {
    let row; try { row = JSON.parse(line); } catch { return; }
    if (row?.type === 'user' && typeof row.uuid === 'string') {
      const content = row.message?.content, item = { uuid: row.uuid, text: typeof content === 'string' ? content : '', state: 'held' };
      if (done || messages.has(item.uuid)) return; messages.set(item.uuid, item);
      steer(item); return;
    }
    if (row?.type !== 'control_request') return;
    const id = typeof row.request_id === 'string' ? row.request_id : '', request = row.request ?? {};
    if (request.subtype === 'cancel_async_message') {
      const item = messages.get(request.message_uuid), back = item?.state === 'held' && !item.sending;
      if (back) { item.state = 'gone'; lifecycle(item.uuid, 'cancelled'); }
      // fixed: Codex has it, and the turn reads it at its next step.
      return reply(id, { cancelled: back, ...(!back && item && ['steered', 'held'].includes(item.state) ? { fixed: true } : {}) });
    }
    if (request.subtype === 'interrupt' && request.send_now === true) {
      if (!waiting().length || !turn || done) return reply(id, { send_now: 'nothing_waiting' });
      if (restart) return reply(id, { send_now: 'stopped' });
      restart = turn;
      call('turn/interrupt', { threadId: thread, turnId: turn }).then(() => reply(id, { send_now: 'stopped' }), () => { restart = null; say({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'Codex did not interrupt the turn.' } }); });
      return;
    }
    say({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'This run does not take that request.' } });
  };

  let version = '0'; try { version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { /* Named without it. */ }
  // The model the thread runs on, as the program names it: a run on Codex's own default names it
  // nowhere else, and Usage prices a run by its model (lib/agent-spend.mjs).
  let model = null;
  try {
    const hello = await call('initialize', { clientInfo: { name: 'elu_code', title: 'ELU', version }, capabilities: { optOutNotificationMethods: ['item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta', 'item/fileChange/outputDelta', 'item/plan/delta'] } }, 20000);
    write({ method: 'initialized' });
    if (config.isolated !== false) {
      // exec was told to leave out the owner's config.toml and rules. The app-server reads
      // both, so it runs this turn only where there is nothing of either to read.
      const read = await call('config/read', { includeLayers: true, cwd }, 20000);
      const own = (Array.isArray(read.layers) ? read.layers : []).filter(layer => layer?.name?.type === 'user' && layer.config && Object.keys(layer.config).length);
      if (!Array.isArray(read.layers) || own.length) return fallback('the owner has a Codex config.toml, which this mode leaves out');
      if (ruleFiles(typeof hello.codexHome === 'string' ? hello.codexHome : null, cwd)) return fallback('the owner has Codex rules, which this mode leaves out');
    }
    // A release without turn/steer gains nothing here: exec runs it as before.
    const probe = await call('turn/steer', { threadId: '00000000-0000-4000-8000-000000000000', expectedTurnId: 'none', input: [] }, 20000).then(() => null, error => error);
    if (probe && noMethod(probe)) return fallback('this release has no turn/steer');
    const started = launch.resume
      ? await call('thread/resume', { threadId: launch.resume, cwd, excludeTurns: true, ...threadSettings(launch) }, 60000)
      : await call('thread/start', { cwd, ...threadSettings(launch) }, 60000);
    thread = started.thread?.id; if (typeof thread !== 'string' || !thread) return fallback('no thread was named');
    if (typeof started.model === 'string' && started.model && started.model.length <= 100) model = started.model;
    await call('turn/start', { threadId: thread, input: [{ type: 'text', text: prompt, text_elements: [] }], ...(schema ? { outputSchema: schema } : {}), clientUserMessageId: 'elu-prompt' }, 60000);
  } catch (error) { return fallback(String(error?.message ?? error)); }
  if (ending) return;
  // The turn runs. From here the output is this program's, and no second run is started.
  began = true;
  say({ type: 'thread.started', thread_id: thread, ...(model ? { model } : {}) });
  say({ type: 'system', subtype: 'init', capabilities: [TAKES, NOW, STOPS] });
  live = true; for (const row of held.splice(0)) { try { notified(row); } catch (error) { debug(error.message); } }
  onLine = take; for (const line of inbox.splice(0)) take(line);
  void closed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main().catch(error => { process.stderr.write(`${error?.message ?? error}\n`); process.exit(1); });
