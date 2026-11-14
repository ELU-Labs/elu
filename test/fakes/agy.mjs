// The fake Antigravity CLI tests run instead of the real one. fakeClis() in helpers.mjs
// copies it to a bin folder (adding the node shebang) next to fake.json, which holds the
// test's mode, the files it records to, and an `agy` object: signedIn (default true),
// ignoreDenies (a broken vendor that writes anyway), noPermissionRequest (an ACP server
// that never asks), asksDenied (an ACP server that asks about what its rules deny, where it
// should refuse by itself), acpEditsFreely (an ACP server that edits the workspace without
// reading its rules), acpFails (`agy acp` ends at once, as a release without it would),
// acpNoModels (an ACP session that names no model and takes none), noUsage (an ACP turn
// that ends without its tokens), pace (milliseconds a headless run waits before it prints,
// and an ACP run before each of its steps). Run from test/fakes/ directly, with no fake.json beside it, it exits 2:
// no path may reach the source file as a program. It honors what the adapter relies on:
// the private HOME's settings.json and hooks.json (the hook command really runs),
// --sandbox, --dangerously-skip-permissions, --conversation under
// <HOME>/.gemini/antigravity-cli/brain, soft-denies in -p (exit 0, a stderr notice naming
// the tool), the /usage sign-in probe, and `acp`: every tool call goes out as a session
// update, when it starts and when it ends, and session/request_permission asks. A session
// with no mode set reviews: it asks before each command and each write that no rule allows.
// An ACP session names its model as the protocol does, a `model` config option changed with
// session/set_config_option, keeps it with the conversation, and ends each turn with the
// protocol's `usage`. Headless, --model names the model and the output repeats it.
// auth: 'prompt' signs it out the way Antigravity CLI 1.5.8 is signed out (observed in a
// scratch HOME): -p prints "Authentication required. Please visit the URL to log in:", the
// link, "Waiting for authentication (timeout 60s)..." and "Or, paste the authorization code
// here and press Enter:" on stderr, runs `open` (or xdg-open) from PATH with the link, and
// waits authSeconds (60) for the code on its input, even after its input ends. The code
// (agy.code) signs it in: a file standing in for the system keyring, outside every HOME
// (agy.keyring, or agy-keyring beside fake.json), so every HOME is signed in after it, and the
// command goes on. Otherwise it ends: "error: authentication failed or timed out", exit 1.
// usageSeconds: `-p /usage` prints nothing for that long before its answer, as a program does
// that waits on a keyring to be unlocked or on a network that does not answer.
// storage: 'file' is agy where it finds no keyring (Linux with no Secret Service): its sign-in
// is a token file under HOME (agy.tokenFile, else .gemini/antigravity-cli/antigravity-oauth-token),
// so every HOME has its own unless they are linked. Signing in makes the file's folder and
// writes the file in place, through a link that is there, or with tokenWrite: 'rename' as a
// new file moved over whatever is there. A write that cannot be made ends the sign-in with
// "failed to write token to file" (agy 1.5.8's own words for it).
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import readline from 'node:readline'; import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
let cfg = null; try { cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), 'fake.json'), 'utf8')); } catch { /* Not installed as a test CLI. */ }
if (!cfg) { console.error('fake agy: not installed as a test CLI (no fake.json beside it)'); process.exit(2); }
const agy = cfg.agy ?? {};
const KEYRING = agy.keyring ?? path.join(path.dirname(process.argv[1]), 'agy-keyring');
const tokenFile = () => path.join(process.env.HOME ?? '', ...(agy.tokenFile ?? '.gemini/antigravity-cli/antigravity-oauth-token').split('/'));
const signedOut = () => agy.storage === 'file' ? !fs.existsSync(tokenFile()) : agy.signedIn === false && !fs.existsSync(KEYRING);
// The sign-in agy runs when it is signed out (auth: 'prompt'): true once the code came.
async function signIn() {
  const url = `https://accounts.google.com/o/oauth2/auth?client_id=fake-client&state=${crypto.randomUUID().slice(0, 8)}`, seconds = agy.authSeconds ?? 60;
  process.stderr.write(`Authentication required. Please visit the URL to log in:\n  ${url}\n\nWaiting for authentication (timeout ${seconds}s)...\nOr, paste the authorization code here and press Enter:\n`);
  for (const opener of ['open', 'xdg-open']) {
    const found = (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, opener)).find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
    if (found) { spawnSync(found, [url], { stdio: 'ignore' }); break; }
  }
  const code = agy.code ?? '4/0AeanS0b-fake-code';
  const signed = await new Promise(resolve => {
    let text = '';
    const timer = setTimeout(() => resolve(false), seconds * 1000);
    process.stdin.on('data', chunk => { text += chunk; if (text.split(/\r?\n/).some(line => line.trim() === code)) { clearTimeout(timer); resolve(true); } });
    process.stdin.on('error', () => {});
  });
  if (!signed) { process.stderr.write('Error: authentication timed out.\nerror: authentication failed or timed out\n'); return false; }
  if (agy.storage === 'file') {
    const file = tokenFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (agy.tokenWrite === 'rename') { const fresh = `${file}.${process.pid}.tmp`; fs.writeFileSync(fresh, 'signed-in\n', { mode: 0o600 }); fs.renameSync(fresh, file); }
      else fs.writeFileSync(file, 'signed-in\n', { mode: 0o600 });
    } catch (error) { process.stderr.write(`Error: failed to write token to file: ${error.message}\n`); return false; }
  } else fs.writeFileSync(KEYRING, 'signed-in\n', { mode: 0o600 });
  process.stderr.write('Signed in.\n');
  return true;
}
if (cfg.calls) fs.appendFileSync(cfg.calls, JSON.stringify({ vendor: 'agy', args, home: process.env.HOME ?? null, autoUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null }) + '\n');
if (args.includes('--version')) { console.log('agy version 1.5.4'); process.exit(0); }
if (args.includes('--help')) { console.log('Usage: agy [flags]\n  --output-format --json-schema --conversation --mode --sandbox --add-dir --print-timeout --dangerously-skip-permissions'); process.exit(0); }
const HOME = process.env.HOME ?? '';
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const settings = readJson(path.join(HOME, '.gemini', 'antigravity-cli', 'settings.json')) ?? {};
const hooks = readJson(path.join(HOME, '.gemini', 'config', 'hooks.json'));
const brain = path.join(HOME, '.gemini', 'antigravity-cli', 'brain');
const flag = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : null; };
const notice = (tool, rule) => process.stderr.write(`agy: soft-denied ${tool} (${rule})\n`);
const ACTION = { write_to_file: 'write_file', run_command: 'command', read_url: 'read_url', search_web: null };
const KIND = { write_to_file: 'edit', run_command: 'execute', read_url: 'fetch', search_web: 'search' };
const pause = () => new Promise(resolve => setTimeout(resolve, Number.isFinite(agy.pace) ? agy.pace : 0));
const MODELS = ['gemini-3-pro', 'gemini-3-flash'];

// The hooks.json PreToolUse entries whose matcher names the tool run, with the call on stdin.
function hookDecision(tool, input, cwd) {
  for (const entry of hooks?.hooks?.PreToolUse ?? []) {
    if (!new RegExp(`^(?:${entry.matcher})$`).test(tool)) continue;
    for (const hook of entry.hooks ?? []) {
      const r = spawnSync('/bin/sh', ['-c', hook.command], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd }), encoding: 'utf8', env: process.env, timeout: (hook.timeout ?? 10) * 1000 });
      if (r.status === 2) return 'deny';
      try { const out = JSON.parse(r.stdout); if (['deny', 'ask'].includes(out.decision)) return out.decision; } catch { /* No opinion. */ }
    }
  }
  return null;
}
const ruleMatches = (rules, action, target) => (rules ?? []).some(rule => { const m = /^([a-z_]+)\((.*)\)$/.exec(rule); return m && m[1] === action && (m[2] === '*' || target === m[2] || (m[2].endsWith('/') && target.startsWith(m[2]))); });
// Hook deny, settings deny and the sandbox refuse; a hook ask, a settings ask or an outside
// write asks, which headless mode cannot do; otherwise the tool runs. review: an ACP session
// no mode was set for, which asks before each command and each write.
function permit(tool, input, { cwd, skip, sandbox, review = false, free = false }) {
  if (skip) return { verdict: 'allow' };
  const action = ACTION[tool], target = tool === 'write_to_file' ? input.TargetFile : tool === 'run_command' ? input.CommandLine.split(/\s+/)[0] : input.Url ?? '';
  const outside = tool === 'write_to_file' && !target.startsWith(`${cwd}${path.sep}`);
  if (free && tool === 'write_to_file' && !outside) return { verdict: 'allow' };
  const hook = hookDecision(tool, input, cwd);
  if (hook === 'deny') return { verdict: 'deny', rule: 'hook' };
  if (action && ruleMatches(settings.permissions?.deny, action, target)) return { verdict: 'deny', rule: `permissions.deny: ${action}` };
  if (sandbox && (outside || tool === 'read_url')) return { verdict: 'deny', rule: 'sandbox' };
  if (hook === 'ask') return { verdict: 'ask', rule: 'hook' };
  if (action && ruleMatches(settings.permissions?.ask, action, target)) return { verdict: 'ask', rule: `permissions.ask: ${action}` };
  if (outside && settings.allowNonWorkspaceAccess !== true) return { verdict: 'ask', rule: 'outside the workspace' };
  if (review && ['write_to_file', 'run_command'].includes(tool)) return { verdict: 'ask', rule: 'review' };
  return { verdict: 'allow' };
}
// The "model": it attempts exactly what the prompt names, a file once however often the
// prompt names it (the runner's prompt carries the owner's message more than once).
function plan(text, cwd) {
  const attempts = [], clean = value => value.replace(/[.,;]+$/, '');
  for (const m of text.matchAll(/\b[Cc]reate (?:a |the )?file (?:named )?(\S+)/g)) { const file = path.resolve(cwd, clean(m[1])); if (!attempts.some(attempt => attempt.input.TargetFile === file)) attempts.push({ tool: 'write_to_file', input: { TargetFile: file, CodeContent: 'elu-code\n' } }); }
  const run = /\b[Rr]un (?:this |the )?command(?: and report its output)?:?\s+(\S+)/.exec(text); if (run) attempts.push({ tool: 'run_command', input: { CommandLine: clean(run[1]), Cwd: cwd } });
  const url = /\b[Ff]etch (https?:\/\/\S+)/.exec(text); if (url) attempts.push({ tool: 'read_url', input: { Url: clean(url[1]) } });
  const search = /\b[Ss]earch the web for ([^.\n]+)/.exec(text); if (search) attempts.push({ tool: 'search_web', input: { query: search[1] } });
  return attempts;
}
async function perform({ tool, input }) {
  if (tool === 'write_to_file') { fs.mkdirSync(path.dirname(input.TargetFile), { recursive: true }); fs.writeFileSync(input.TargetFile, input.CodeContent); return `Created ${input.TargetFile}.`; }
  if (tool === 'run_command') { const r = spawnSync('/bin/sh', ['-c', input.CommandLine], { cwd: input.Cwd, encoding: 'utf8' }); return `Ran ${input.CommandLine} (exit ${r.status}).`; }
  if (tool === 'read_url') { try { const r = await fetch(input.Url); return `Fetched ${input.Url}: ${r.status}.`; } catch (error) { return `Fetch failed: ${error.message}`; } }
  return `Searched the web for ${input.query}.`;
}
// plan (fake.json): a request for a change comes back as a Task, and the turn that works on an approved one reports
// every subtask done, as a model told to plan first does (lib/plan.mjs). has: whether the reply's schema has that field.
const TASK = { title: 'Uppercase coupons', description: 'Make normalize return the coupon code in upper case.', goal: 'Coupon codes compare equal whatever their case.', objectives: ['normalize returns the code in upper case', 'The coupon test passes'], priority: 'medium', severity: 'low' };
const STEPS = ['Change normalize', 'Run the coupon test'];
function planned(result, text, has) {
  if (!cfg.plan) return result;
  if (has('task') && !text.includes('Approved Task (untrusted data')) Object.assign(result, { intent: 'edit', task: [TASK] });
  if (has('subtasks')) Object.assign(result, { subtasks: STEPS.map(step => ({ text: step, state: 'done' })), objectivesMet: [1, 2], etaMinutes: null });
  return result;
}
// live (fake.json): a file; a turn told to keep its to-do list shows it, first step done and the next in hand, and goes
// on once that file exists. Over ACP it sends a plan update, as the standard has it. A headless run prints nothing
// until it ends: told to keep the list in a file, it writes that file where the launch lets it write anywhere.
const liveGate = async () => { const until = Date.now() + 30000; while (!fs.existsSync(cfg.live) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50)); };
const writeList = (file, states) => fs.writeFileSync(file, JSON.stringify(STEPS.map((text, index) => ({ text, state: states[index] }))));

// One turn: ask is the ACP permission request (null in headless mode), dir the conversation's
// folder. show: what an ACP session sends about each tool call, start(attempt) → its id and end(id, ok).
async function turn(text, { cwd, skip, sandbox, ask, dir, review = false, show = null }) {
  const done = [], denied = [];
  for (const attempt of plan(text, cwd)) {
    const call = show ? await show.start(attempt) : null;
    let { verdict, rule } = permit(attempt.tool, attempt.input, { cwd, skip, sandbox, review, free: Boolean(ask) && agy.acpEditsFreely === true });
    if (verdict === 'deny' && ask && agy.asksDenied) verdict = 'ask';
    if (verdict === 'ask') {
      if (ask && agy.noPermissionRequest) verdict = 'allow';
      else if (ask) { verdict = (await ask(attempt, call)) === 'allow' ? 'allow' : 'deny'; rule = 'permission request rejected'; }
      else { verdict = 'deny'; rule = `${rule}; headless`; }
    }
    if (verdict === 'deny' && !agy.ignoreDenies) { notice(attempt.tool, rule); denied.push(`${attempt.tool} denied (${rule})`); show?.end(call, false); continue; }
    done.push(await perform(attempt)); show?.end(call, true);
  }
  const nonce = /\b[Rr]emember (?:this )?nonce:? ([0-9a-f-]{36})/.exec(text); if (nonce) fs.writeFileSync(path.join(dir, 'nonce'), nonce[1]);
  // The quotes may be JSON-escaped: the runner carries the goal in a data block.
  let summary = /summary \\?"([^"\\]+)\\?"/.exec(text)?.[1] ?? ([...done, ...denied].join(' ') || 'Nothing to do.');
  if (/nonce from earlier/.test(text)) { try { summary = fs.readFileSync(path.join(dir, 'nonce'), 'utf8'); } catch { summary = 'No nonce in this conversation.'; } }
  return { outcome: denied.length && !done.length ? 'blocked' : 'done', summary, question: null, choices: [], comments: [], responses: [] };
}
async function headless() {
  const prompt = flag('-p') ?? '';
  if (signedOut() && agy.auth === 'prompt' && !await signIn()) {
    if (flag('--output-format') === 'json') console.log(JSON.stringify({ conversation_id: '', status: 'ERROR', response: '', error: 'authentication failed or timed out', finished_reason: 'error' }));
    process.exit(1);
  }
  if (signedOut()) { console.error('authentication required: run agy to sign in'); process.exit(1); }
  if (prompt === '/usage') { if (agy.usageSeconds) await new Promise(resolve => setTimeout(resolve, agy.usageSeconds * 1000)); console.log(flag('--output-format') === 'json' ? JSON.stringify({ usage: { plan: 'fake' } }) : 'Plan: fake\nUsage: 0%'); process.exit(0); }
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  if (cfg.inputs) fs.appendFileSync(cfg.inputs, JSON.stringify({ vendor: 'agy', args, input }) + '\n');
  const text = `${prompt}\n${input}`, cwd = process.cwd(), conversation = flag('--conversation'), id = conversation ?? crypto.randomUUID(), dir = path.join(brain, id);
  if (conversation && !fs.existsSync(dir)) { console.error(`conversation not found: ${conversation}`); process.exit(1); }
  fs.mkdirSync(dir, { recursive: true });
  const schema = flag('--json-schema') ? readJson(flag('--json-schema')) : null;
  // slow: prints nothing for half a minute first, as a headless run does while it works.
  if (cfg.mode === 'slow') await new Promise(resolve => setTimeout(resolve, 30000));
  await pause();
  const named = cfg.live && args.includes('--dangerously-skip-permissions') ? /Keep the Task's subtasks in the file ("[^\n]+?") as you work/.exec(text)?.[1] : null, list = named ? JSON.parse(named) : null;
  if (list) { writeList(list, ['done', 'doing']); await liveGate(); }
  const result = await turn(text, { cwd, skip: args.includes('--dangerously-skip-permissions'), sandbox: args.includes('--sandbox'), ask: null, dir });
  if (list) writeList(list, ['done', 'done']);
  if (schema?.properties?.intent) { result.intent = 'answer'; if (schema.properties.repository) result.repository = ''; }
  if (cfg.name !== undefined && schema?.properties?.name) result.name = cfg.name;
  planned(result, text, name => Boolean(schema?.properties?.[name]));
  console.log(JSON.stringify({ conversationId: id, model: flag('--model') ?? MODELS[0], structured_output: result, stats: { turns: 1 } }, null, 2));
}
async function acp() {
  if (agy.acpFails) { console.error('agy: unknown command "acp"'); process.exit(1); }
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  const waiting = new Map(), sessions = new Map(); let nextId = 100;
  const request = (method, params) => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
  // The conversation's model: the first one listed until it is changed, kept beside its turns.
  const modelOf = id => { try { return fs.readFileSync(path.join(brain, id, 'model'), 'utf8'); } catch { return MODELS[0]; } };
  const opened = id => ({ sessionId: id, ...(agy.acpNoModels ? {} : { configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: modelOf(id), options: MODELS.map(value => ({ value, name: value })) }] }) });
  async function handle(row) {
    const reply = result => send({ jsonrpc: '2.0', id: row.id, result }), fail = (code, message) => send({ jsonrpc: '2.0', id: row.id, error: { code, message } }), p = row.params ?? {};
    switch (row.method) {
      case 'initialize': reply({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }); break;
      case 'session/new': { if (signedOut()) return fail(-32000, 'authentication required'); const id = crypto.randomUUID(); fs.mkdirSync(path.join(brain, id), { recursive: true }); sessions.set(id, { cwd: p.cwd }); reply(opened(id)); break; }
      case 'session/resume': { if (typeof p.sessionId !== 'string' || !fs.existsSync(path.join(brain, p.sessionId))) return fail(-32602, 'conversation not found'); sessions.set(p.sessionId, { cwd: p.cwd }); reply(opened(p.sessionId)); break; }
      case 'session/set_config_option': {
        if (agy.acpNoModels) return fail(-32601, 'Method not found'); if (!sessions.has(p.sessionId)) return fail(-32602, 'unknown session');
        if (p.configId !== 'model' || !MODELS.includes(p.value)) return fail(-32602, `unknown model: ${JSON.stringify(p.value)}`);
        fs.writeFileSync(path.join(brain, p.sessionId, 'model'), p.value);
        const { configOptions } = opened(p.sessionId); send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'config_option_update', configOptions } } }); reply({ configOptions }); break;
      }
      case 'session/set_mode': { if (!sessions.has(p.sessionId)) return fail(-32602, 'unknown session'); if (!['accept-edits', 'auto'].includes(p.modeId)) return fail(-32602, 'unknown mode'); sessions.get(p.sessionId).mode = p.modeId; reply({}); break; }
      case 'session/prompt': {
        const session = sessions.get(p.sessionId); if (!session) return fail(-32602, 'unknown session');
        const text = (p.prompt ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n');
        const change = value => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: p.sessionId, update: value } });
        const update = chunk => change({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
        // Its thought and each tool call go out as session updates, as ACP sends them: a call
        // when it starts, and again when it ended or was refused.
        await pause();
        change({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reading the request.' } });
        update('Working on it.\n');
        if (cfg.live && /Keep the Task's subtasks in your own to-do list/.test(text)) { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'plan', entries: [{ content: STEPS[0], priority: 'medium', status: 'completed' }, { content: STEPS[1], priority: 'medium', status: 'in_progress' }] } } }); await liveGate(); }
        const titleOf = attempt => attempt.tool === 'write_to_file' ? `Write ${attempt.input.TargetFile}` : attempt.tool === 'run_command' ? `Run ${attempt.input.CommandLine}` : `${attempt.tool} ${attempt.input.Url ?? attempt.input.query ?? ''}`.trim();
        const show = {
          async start(attempt) { await pause(); const toolCallId = `call-${nextId++}`; change({ sessionUpdate: 'tool_call', toolCallId, title: titleOf(attempt), kind: KIND[attempt.tool], status: 'pending', rawInput: attempt.input }); await pause(); return toolCallId; },
          end(toolCallId, ok) { change({ sessionUpdate: 'tool_call_update', toolCallId, status: ok ? 'completed' : 'failed' }); },
        };
        // "Always allow" is offered first, as a vendor may: the client picks the answer by its kind.
        const ask = async (attempt, toolCallId) => {
          const answer = await request('session/request_permission', { sessionId: p.sessionId, toolCall: { toolCallId, title: titleOf(attempt), kind: KIND[attempt.tool], rawInput: attempt.input }, options: [{ optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] });
          const chosen = answer?.outcome?.outcome === 'selected' ? answer.outcome.optionId : null;
          if (chosen === 'allow-always') session.always = true;
          return ['allow-once', 'allow-always'].includes(chosen) ? 'allow' : 'deny';
        };
        const result = await turn(text, { cwd: session.cwd, skip: false, sandbox: false, ask, dir: path.join(brain, p.sessionId), review: session.mode === undefined, show });
        if (session.always) fs.writeFileSync(path.join(brain, p.sessionId, 'always'), '');
        await pause();
        // The runner's conversation schema rides in the prompt: an answer turn.
        if (/"intent"\s*:\s*\{/.test(text)) { result.intent = 'answer'; if (/"repository"\s*:\s*\{/.test(text)) result.repository = ''; }
        if (cfg.name !== undefined && /"name"\s*:\s*\{"type"/.test(text)) result.name = cfg.name;
        planned(result, text, name => new RegExp(`"${name}"\\s*:\\s*\\{`).test(text));
        update(`Here is the result:\n${JSON.stringify(result, null, 2)}\n`);
        // The turn's tokens, as the protocol names them: input apart from the cache, thought apart from output.
        reply({ stopReason: 'end_turn', ...(agy.noUsage ? {} : { usage: { totalTokens: 1530, inputTokens: 1200, outputTokens: 80, thoughtTokens: 40, cachedReadTokens: 200, cachedWriteTokens: 10 } }) }); break;
      }
      case 'session/cancel': break;
      default: fail(-32601, 'Method not found');
    }
  }
  // Replies to this server's own requests arrive while a prompt is in flight, so nothing blocks the read loop.
  for await (const line of readline.createInterface({ input: process.stdin })) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.id !== undefined && row.method === undefined) { waiting.get(row.id)?.(row.error ? null : row.result); waiting.delete(row.id); continue; }
    if (row.id === undefined) continue;
    handle(row);
  }
  process.exit(0);
}
if (args[0] === 'acp') await acp(); else await headless();
