// The fake Grok Build CLI tests run instead of the real one; no real grok has run here, so
// it follows the vendor's docs. fakeClis() in helpers.mjs copies it next to
// fake.json, which holds the test's mode and the files it records to. It reads
// --prompt-file and never stdin, prints the --output-format json object with the -s
// session id, writes only where the flags allow (bypassPermissions anywhere; otherwise
// inside --cwd, never under a read-only sandbox or GROK_WRITE_FILE=0), runs a command or
// fetches a URL only under bypassPermissions, keeps sessions under $GROK_HOME/sessions for
// -r, serves `agent stdio` with a permission request for anything the rules do not allow,
// and answers `inspect --json`, listing home-level Claude files whenever they exist (issue #34).
// Modes: signed-out, invalid (bad result), fenced (result in a code fence), max-turns,
// leaky (writes whatever the flags say), claude-bleed (inspect reports a Claude instruction).
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { spawnSync } from 'node:child_process';
const vendor = path.basename(process.argv[1]); const args = process.argv.slice(2);
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), 'fake.json'), 'utf8')); } catch {}
const mode = cfg.mode ?? 'normal';
if (cfg.calls) fs.appendFileSync(cfg.calls, JSON.stringify({ vendor, args }) + '\n');
const value = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const values = flag => args.flatMap((a, i) => a === flag ? [args[i + 1]] : []);
const home = process.env.GROK_HOME ?? path.join(process.env.HOME ?? '', '.grok');
const sessions = path.join(home, 'sessions');
const signedIn = mode !== 'signed-out' && fs.existsSync(path.join(home, 'auth.json'));
const fail = message => { console.log(JSON.stringify({ type: 'error', message })); process.exit(1); };
const save = record => { fs.mkdirSync(sessions, { recursive: true }); fs.writeFileSync(path.join(sessions, `${record.id}.json`), JSON.stringify(record)); };
const load = id => { try { return JSON.parse(fs.readFileSync(path.join(sessions, `${id}.json`), 'utf8')); } catch { return null; } };
const list = dir => { try { return fs.readdirSync(dir); } catch { return []; } };

if (args.includes('--version')) { console.log('1.0.77'); process.exit(0); }
if (args.includes('--help')) { console.log('--output-format --permission-mode --sandbox --max-turns --cwd --no-auto-update --tools --disallowed-tools --allow --deny --prompt-file --prompt-json --no-alt-screen --no-memory --no-subagents --disable-web-search --session-id --resume --model'); process.exit(0); }
if (args[0] === 'login') { console.error('fake grok: login is interactive'); process.exit(2); }

// plan (fake.json): a request for a change comes back as a Task, and the turn that works on an approved one reports
// every subtask done, as a model told to plan first does (lib/plan.mjs). The reply's schema rides in the prompt.
const TASK = { title: 'Uppercase coupons', description: 'Make normalize return the coupon code in upper case.', goal: 'Coupon codes compare equal whatever their case.', objectives: ['normalize returns the code in upper case', 'The coupon test passes'], priority: 'medium', severity: 'low' };
const STEPS = ['Change normalize', 'Run the coupon test'];
function planned(result, prompt) {
  if (!cfg.plan) return result;
  if (/"task"\s*:\s*\{/.test(prompt) && !prompt.includes('Approved Task (untrusted data')) Object.assign(result, { intent: 'edit', task: [TASK] });
  if (/"subtasks"\s*:\s*\{/.test(prompt)) Object.assign(result, { subtasks: STEPS.map(text => ({ text, state: 'done' })), objectivesMet: [1, 2], etaMinutes: null });
  return result;
}
// live (fake.json): a file; a turn told to keep its to-do list shows it, first step done and the next in hand, and goes
// on once that file exists. Over ACP it sends a plan update, as the standard has it. A headless run prints nothing
// until it ends: told to keep the list in a file, it writes that file where the launch lets it write anywhere.
const liveGate = async () => { const until = Date.now() + 30000; while (!fs.existsSync(cfg.live) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50)); };
const listFile = prompt => { const named = /Keep the Task's subtasks in the file ("[^\n]+?") as you work/.exec(prompt)?.[1]; return named ? JSON.parse(named) : null; };
const writeList = (file, states) => fs.writeFileSync(file, JSON.stringify(STEPS.map((text, index) => ({ text, state: states[index] }))));

// What the prompt asks for, done as far as the launch allows. ask() decides an action the
// rules neither allow nor forbid: the relay over ACP, nothing in headless mode.
async function act(prompt, record, { bypass, canWrite, canShell, canFetch, cwd, ask }) {
  const blocked = [], did = [];
  const allow = async (action, free) => bypass || free || (ask ? ask(action) : false);
  if (/create (a |another )?file|files? at/i.test(prompt)) {
    for (const file of [...prompt.matchAll(/(\/\S+?\.txt)\b/g)].map(match => match[1])) {
      const inside = path.resolve(file).startsWith(cwd + path.sep);
      if (!canWrite && !bypass) { blocked.push(`write ${file}`); continue; }
      if (await allow({ kind: 'edit', title: `Write ${file}`, rawInput: { path: file } }, inside && canWrite)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'created\n'); did.push(`wrote ${file}`); }
      else blocked.push(`write ${file}`);
    }
  }
  // A full path, or a program on PATH named elu-something.
  const command = prompt.match(/run the (?:shell )?command (\/\S+|elu-[\w-]+)/i)?.[1];
  if (command) {
    if ((canShell || bypass) && await allow({ kind: 'execute', title: `Run ${command}`, rawInput: { command } }, false)) { spawnSync(command, { stdio: 'ignore' }); did.push(`ran ${command}`); }
    else blocked.push(`run ${command}`);
  }
  const url = prompt.match(/fetch (https?:\/\/\S+)/i)?.[1];
  if (url) {
    if ((canFetch || bypass) && await allow({ kind: 'fetch', title: `Fetch ${url}`, rawInput: { url } }, false)) { try { await fetch(url); } catch { /* The listener answers 404. */ } did.push(`fetched ${url}`); }
    else blocked.push(`fetch ${url}`);
  }
  // The quotes may be JSON-escaped: the runner carries the goal in a data block.
  let summary = prompt.match(/summary \\?"([^"\\]+)\\?"/)?.[1] ?? null;
  if (/what nonce/i.test(prompt)) summary = record.turns.join('\n').match(/nonce:? ([0-9a-f-]{36})/i)?.[1] ?? 'I was given no nonce.';
  const result = { outcome: 'done', summary: summary ?? (did.length ? did.join('; ') : 'Done as asked.'), question: null, choices: [], comments: [], responses: [] };
  if (blocked.length) { result.outcome = 'needs_input'; result.summary = `Blocked: ${blocked.join('; ')}`; result.question = `Allow ${blocked.join('; ')}?`; }
  // The runner's conversation schema rides in the prompt: an answer turn.
  if (/"intent"\s*:\s*\{/.test(prompt)) { result.intent = 'answer'; if (/"repository"\s*:\s*\{/.test(prompt)) result.repository = ''; }
  if (cfg.name !== undefined && /"name"\s*:\s*\{"type"/.test(prompt)) result.name = cfg.name;
  return planned(result, prompt);
}
const resultText = result => mode === 'invalid' ? JSON.stringify({ outcome: 'nope' }) : mode === 'fenced' ? `Here it is:\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n` : JSON.stringify(result);

if (args.includes('inspect')) {
  const claudeHome = path.join(process.env.HOME ?? '', '.claude'), cell = (vendorName, name) => ({ enabled: process.env[`GROK_${vendorName}_${name.toUpperCase()}_ENABLED`] !== '0' });
  // Issue #34, as the fake models it: home-level Claude files load whenever they exist under $HOME, whatever the switches say.
  const instructions = ['CLAUDE.md', ...list(path.join(claudeHome, 'rules')).map(name => `rules/${name}`)].map(name => path.join(claudeHome, name)).filter(file => fs.existsSync(file)).map(file => ({ path: file, vendor: 'claude', scope: 'global' }));
  if (mode === 'claude-bleed') instructions.push({ path: path.join(claudeHome, 'CLAUDE.md'), vendor: 'claude', scope: 'global' });
  const report = { sources: [path.join(home, 'config.toml')].filter(file => fs.existsSync(file)).map(file => ({ path: file, kind: 'config' })), instructions, skills: [], plugins: [], hooks: [], mcpServers: [], externalCompat: Object.fromEntries(['claude', 'cursor'].map(name => [name, Object.fromEntries(['skills', 'rules', 'agents', 'mcps', 'hooks'].map(key => [key, cell(name.toUpperCase(), key)]))])) };
  if (args.includes('--json')) console.log(JSON.stringify(report)); else console.log(`Sources: ${report.sources.length}\nInstructions: ${report.instructions.length}`);
  process.exit(0);
}

if (args.includes('agent') && args.includes('stdio')) {
  const readline = await import('node:readline');
  const send = row => process.stdout.write(`${JSON.stringify(row)}\n`);
  const waiting = new Map(), live = new Map(); let nextId = 100;
  const canWrite = !values('--deny').includes('Write');
  const request = (method, params) => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
  async function handle(row) {
    const reply = result => send({ jsonrpc: '2.0', id: row.id, result }), error = (code, message) => send({ jsonrpc: '2.0', id: row.id, error: { code, message } });
    switch (row.method) {
      case 'initialize': return reply({ protocolVersion: row.params?.protocolVersion ?? 1, agentCapabilities: { loadSession: true }, authMethods: signedIn ? [{ id: 'cached_token', name: 'Cached token' }] : [] });
      case 'authenticate': return signedIn && row.params?.methodId === 'cached_token' ? reply({}) : error(-32000, 'Not logged in. Run grok login.');
      case 'session/new': {
        if (!signedIn) return error(-32000, 'Not logged in. Run grok login.');
        const record = { id: crypto.randomUUID(), cwd: row.params?.cwd ?? process.cwd(), sandbox: 'off', turns: [], yolo: row.params?._meta?.yoloMode === true, auto: row.params?._meta?.autoMode === true };
        live.set(record.id, record); save(record); return reply({ sessionId: record.id, configOptions: [] });
      }
      case 'session/load': {
        const record = load(row.params?.sessionId); if (!record) return error(-32000, `Session not found: ${row.params?.sessionId}`);
        record.cwd = row.params?.cwd ?? record.cwd; live.set(record.id, record); return reply({ configOptions: [] });
      }
      case 'session/prompt': {
        const record = live.get(row.params?.sessionId); if (!record) return error(-32000, 'Unknown session.');
        const text = (row.params?.prompt ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n');
        if (cfg.inputs) fs.appendFileSync(cfg.inputs, JSON.stringify({ vendor, args, input: text }) + '\n');
        const ask = async action => {
          const answer = await request('session/request_permission', { sessionId: record.id, toolCall: { toolCallId: `call_${nextId}`, title: action.title, kind: action.kind, status: 'pending', rawInput: action.rawInput }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] });
          return answer?.outcome?.outcome === 'selected' && String(answer.outcome.optionId).startsWith('allow');
        };
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: record.id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working. ' } } } });
        if (cfg.live && /Keep the Task's subtasks in your own to-do list/.test(text)) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: record.id, update: { sessionUpdate: 'plan', entries: [{ content: STEPS[0], priority: 'medium', status: 'completed' }, { content: STEPS[1], priority: 'medium', status: 'in_progress' }] } } }); await liveGate(); }
        const result = await act(text, record, { bypass: record.yolo || mode === 'leaky', canWrite, canShell: true, canFetch: true, cwd: record.cwd, ask });
        record.turns.push(text); save(record);
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: record.id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: resultText(result) } } } });
        return reply({ stopReason: mode === 'max-turns' ? 'max_turn_requests' : 'end_turn' });
      }
      default: return error(-32601, 'Method not found');
    }
  }
  // Every message is handled without blocking the read loop, so the answer to this
  // server's own permission request (sent mid-prompt) is still read.
  for await (const line of readline.createInterface({ input: process.stdin })) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.id !== undefined && row.method === undefined) { waiting.get(row.id)?.(row.error ? { error: row.error } : row.result); waiting.delete(row.id); continue; }
    if (row.id === undefined) continue;
    handle(row);
  }
  process.exit(0);
}

// Headless: the prompt comes from --prompt-file or -p; stdin is never read.
const cwd = value('--cwd') ?? process.cwd(), promptFile = value('--prompt-file');
let prompt = value('-p') ?? value('--single');
if (promptFile) { try { prompt = fs.readFileSync(promptFile, 'utf8'); } catch { fail(`Cannot read prompt file: ${promptFile}`); } }
if (prompt == null) fail('No prompt. Headless mode takes --prompt-file or -p, never stdin.');
if (!signedIn) fail('Not logged in. Run grok login.');
if (cfg.inputs) fs.appendFileSync(cfg.inputs, JSON.stringify({ vendor, args, input: prompt }) + '\n');
const permission = value('--permission-mode') ?? 'default', sandbox = value('--sandbox') ?? 'off';
const bypass = mode === 'leaky' || permission === 'bypassPermissions' || args.includes('--always-approve') || args.includes('--yolo');
const disallowed = (value('--disallowed-tools') ?? '').split(','), tools = value('--tools')?.split(',') ?? null, denied = values('--deny');
const has = tool => (!tools || tools.includes(tool)) && !disallowed.includes(tool);
const canWrite = has('search_replace') && !denied.includes('Write') && !denied.includes('Edit') && sandbox !== 'read-only' && process.env.GROK_WRITE_FILE !== '0';
const canShell = has('run_terminal_cmd') && !denied.includes('Bash') && sandbox !== 'read-only';
const canFetch = has('web_fetch') && !denied.includes('WebFetch') && sandbox !== 'read-only' && process.env.GROK_WEB_FETCH !== '0';
let session = value('-s') ?? value('--session-id'); const resume = value('-r') ?? value('--resume');
let record;
if (resume) { record = load(resume); if (!record) fail(`Session not found: ${resume}`); session = resume; if (record.sandbox !== sandbox) fail('A resumed session keeps its sandbox profile.'); }
else {
  if (!session) session = crypto.randomUUID(); else if (!/^[0-9a-f-]{36}$/i.test(session)) fail('--session-id must be a UUID.');
  if (load(session)) fail('That session id is already in use.');
  record = { id: session, cwd, sandbox, turns: [] };
}
const todoFile = cfg.live && bypass ? listFile(prompt) : null;
if (todoFile) { writeList(todoFile, ['done', 'doing']); await liveGate(); }
const result = await act(prompt, record, { bypass, canWrite, canShell, canFetch, cwd, ask: null });
if (todoFile) writeList(todoFile, ['done', 'done']);
record.turns.push(prompt); save(record);
if (mode === 'max-turns') { console.log(JSON.stringify({ text: 'Still working on it.', stopReason: 'max_turn_requests', sessionId: session, requestId: 'req-1', num_turns: 3 })); process.exit(0); }
console.log(JSON.stringify({ text: resultText(result), stopReason: 'end_turn', sessionId: session, requestId: 'req-1', num_turns: 1, usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5, reasoning_tokens: 0, total_tokens: 15 }, modelUsage: { 'grok-4.6': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, modelCalls: 1 } } }));
