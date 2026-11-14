// The fake Grok Build CLI tests run instead of the real one. It follows the vendor's docs,
// and for `inspect --json` what the real 1.0.77 printed. fakeClis() in helpers.mjs copies it next to
// fake.json, which holds the test's mode and the files it records to. It reads
// --prompt-file and never stdin, prints the --output-format json object with the -s
// session id, writes only where the flags allow (bypassPermissions anywhere; otherwise
// inside --cwd, never under a read-only sandbox or GROK_WRITE_FILE=0), runs a command or
// fetches a URL only under bypassPermissions, keeps sessions under $GROK_HOME/sessions for
// -r, serves `agent stdio` with a permission request for anything the rules do not allow,
// and answers `inspect --json` in the shape the real program prints (see inspect below).
// Modes: signed-out, invalid (bad result), fenced (result in a code fence), max-turns,
// leaky (writes whatever the flags say).
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
// login: grok.login on, the device code sign-in as grok 1.0.77 runs it (watched in a scratch
// home, with --device-auth and without): a link with the code in it, the code to confirm on
// that page, and a wait for the owner to approve there. It reads nothing from its input, and
// Ctrl-C ends it. grok.browser on, the link opened by itself. The approval is the file
// grok-approved beside fake.json (grok.approved names another), which a test writes as the
// owner's click; grok then writes auth.json in GROK_HOME, through ELU's link to the owner's
// ~/.grok/auth.json when there is one. What it prints after the approval was not watched.
// Off, login is refused, as before.
if (args[0] === 'login') {
  if (!cfg.grok?.login) { console.error('fake grok: login is interactive'); process.exit(2); }
  const approved = cfg.grok.approved ?? path.join(path.dirname(process.argv[1]), 'grok-approved');
  process.stderr.write(`\nTo sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=FAKE-CODE\n\n${cfg.grok.browser ? '' : '  (Could not open browser automatically \u2014 open the URL above manually.)\n\n'}Confirm this code in your browser:\n\n  FAKE-CODE\n\n\x1b[90mOnly continue with a code you requested. Don't share it with anyone.\x1b[0m\n\nWaiting for authorization...\n`);
  const until = Date.now() + (cfg.grok.seconds ?? 60) * 1000;
  while (!fs.existsSync(approved)) { if (Date.now() > until) { process.stderr.write('Error: the sign-in was not approved in time.\n'); process.exit(1); } await new Promise(resolve => setTimeout(resolve, 50)); }
  fs.rmSync(approved, { force: true });
  // grok.tokenWrite 'rename': auth.json is a new file moved over what is there, so a link of
  // ELU's there becomes a file. Otherwise it is written in place, through the link. Which of
  // the two grok does was not watched: ELU has to be right for both.
  const auth = path.join(home, 'auth.json'), token = '{"token":"never-read"}\n'; fs.mkdirSync(home, { recursive: true });
  if (cfg.grok.tokenWrite === 'rename') { fs.writeFileSync(`${auth}.${process.pid}.tmp`, token, { mode: 0o600 }); fs.renameSync(`${auth}.${process.pid}.tmp`, auth); }
  else fs.writeFileSync(auth, token, { mode: 0o600 });
  process.stderr.write('Signed in.\n'); process.exit(0);
}

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
  return result;
}
const resultText = result => mode === 'invalid' ? JSON.stringify({ outcome: 'nope' }) : mode === 'fenced' ? `Here it is:\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n` : JSON.stringify(result);

// inspect --json, as Grok Build 1.0.77 prints it. Watched with the real program, signed out, in
// a scratch home: on an empty home, with Cursor and Claude files in the home and their
// switches on and off, and with the folder trusted. What it prints:
// - externalCompat.cells: one row per switch, { vendor, surface, enabled, source }: six for
//   cursor, six for claude, and sessions alone for codex. A switch set in the environment
//   (GROK_CURSOR_RULES_ENABLED=0) says source "env", one set in config.toml ([compat.cursor]
//   rules = false) says "config", and one set nowhere is on and says "default".
// - Another tool's files under $HOME are listed whether their switch is on or off: with
//   vendor and compatibilityStatus "enabled", or disabled: true and "disabled". Instruction
//   files and rules go in projectInstructions, skills in skills, MCP servers in mcpServers,
//   hooks in hooks (the real program lists hooks only in a trusted folder; here always).
// - An agent file is listed in agents with its path and no vendor, beside the three built-in.
// - A Claude settings file under $HOME that holds permission rules is named in
//   permissions.sources as "<file> (settings)", beside the config, with every switch off:
//   settings.local.json when there is one, else settings.json.
// - permissions.managedSettingsPath is /etc/claude-code/managed-settings.json on every computer.
// Not watched, taken from its docs: a switch still waiting to be decided ("unresolved" on the
// entries; the cell's own form is a guess, enabled: null), and a signed-in home, where a
// built-in skill named resume-cursor loads (grok.inspect.builtin lists one).
// grok.inspect in fake.json: on, the switches this grok reports on whatever ELU set, as a
// release that stopped reading one would; unresolved, the switches it has not decided;
// exit, the code it ends with instead of printing.
if (args.includes('inspect')) {
  const opts = cfg.grok?.inspect ?? {}, userHome = process.env.HOME ?? '';
  if (opts.exit) { console.error('error: inspect is not available'); process.exit(opts.exit); }
  let toml = ''; try { toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch {}
  const inConfig = (tool, surface) => { const table = toml.split(/^\[/m).find(part => part.startsWith(`compat.${tool}]`)) ?? ''; const set = table.match(new RegExp(`^${surface}\\s*=\\s*(true|false)`, 'm'))?.[1]; return set ? set === 'true' : null; };
  const cell = (tool, surface) => {
    const key = `${tool}.${surface}`, env = process.env[`GROK_${tool.toUpperCase()}_${surface.toUpperCase()}_ENABLED`], set = inConfig(tool, surface);
    if (opts.unresolved?.includes(key)) return { vendor: tool, surface, enabled: null, source: 'unresolved' };
    if (opts.on?.includes(key)) return { vendor: tool, surface, enabled: true, source: 'default' };
    if (env !== undefined) return { vendor: tool, surface, enabled: !['0', 'false'].includes(env.toLowerCase()), source: 'env' };
    return set === null ? { vendor: tool, surface, enabled: true, source: 'default' } : { vendor: tool, surface, enabled: set, source: 'config' };
  };
  const cells = [...['cursor', 'claude'].flatMap(tool => ['skills', 'rules', 'agents', 'mcps', 'hooks', 'sessions'].map(surface => cell(tool, surface))), cell('codex', 'sessions')];
  const status = (tool, surface) => { const row = cells.find(item => item.vendor === tool && item.surface === surface); return { vendor: tool, ...(row.enabled === true ? { compatibilityStatus: 'enabled' } : row.enabled === null ? { compatibilityStatus: 'unresolved' } : { disabled: true, compatibilityStatus: 'disabled' }) }; };
  const json = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const size = file => { const bytes = fs.statSync(file).size; return { sizeBytes: bytes, approxTokens: Math.ceil(bytes / 4) }; };
  const instructions = (file, tool, surface) => fs.existsSync(file) ? [{ path: file, scope: 'global', fileType: surface === 'rules' ? 'rules' : 'agents_md', ...size(file), ...status(tool, surface) }] : [];
  const projectInstructions = ['claude', 'cursor'].flatMap(tool => { const dir = path.join(userHome, `.${tool}`); return [...instructions(path.join(dir, tool === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'), tool, 'agents'), ...list(path.join(dir, 'rules')).filter(name => name.endsWith('.md')).flatMap(name => instructions(path.join(dir, 'rules', name), tool, 'rules'))]; });
  const skills = [...(opts.builtin ? [{ name: 'resume-cursor', description: 'Continue a recent Cursor session here.', source: { type: 'builtin' }, userInvocable: true }] : []),
    ...['claude', 'cursor'].flatMap(tool => list(path.join(userHome, `.${tool}`, 'skills')).filter(name => fs.existsSync(path.join(userHome, `.${tool}`, 'skills', name, 'SKILL.md'))).map(name => ({ name, description: `a ${tool} skill`, source: { type: 'user', path: path.join(userHome, `.${tool}`, 'skills', name, 'SKILL.md') }, userInvocable: true, ...status(tool, 'skills') })))];
  const agents = [...[['general-purpose', 'General purpose agent for multi-step tasks.'], ['explore', 'Fast, read-only agent specialized for codebase exploration.'], ['plan', 'Software architect for planning implementation strategies.']].map(([name, description]) => ({ name, description, source: { type: 'builtin' } })),
    ...['claude', 'cursor'].flatMap(tool => list(path.join(userHome, `.${tool}`, 'agents')).filter(name => name.endsWith('.md')).map(name => ({ name: name.slice(0, -3), description: `a ${tool} agent`, source: { type: 'user', path: path.join(userHome, `.${tool}`, 'agents', name) } })))];
  const servers = (file, type, tool) => Object.entries(json(file)?.mcpServers ?? {}).map(([name, server]) => ({ name, transport: 'stdio', target: server?.command ?? '', source: { type, path: file }, ...(({ vendor, ...rest }) => ({ ...rest, vendor }))(status(tool, 'mcps')) }));
  const mcpServers = [...servers(path.join(userHome, '.claude.json'), 'claudeJson', 'claude'), ...servers(path.join(userHome, '.cursor', 'mcp.json'), 'mcpJson', 'cursor')];
  // Matcher groups only, the shape a Claude settings file holds: Cursor's own entries do not run yet.
  const groups = (file, tool) => Object.entries(json(file)?.hooks ?? {}).flatMap(([event, rows]) => (Array.isArray(rows) ? rows : []).filter(row => Array.isArray(row?.hooks)).flatMap(row => row.hooks.map(hook => ({ event: event.replace(/[A-Z]/g, (letter, at) => `${at ? '_' : ''}${letter.toLowerCase()}`), hookType: hook.type ?? 'command', target: hook.command ?? '', source: { type: 'user', path: path.dirname(file) }, matcher: row.matcher ?? '', ...status(tool, 'hooks') }))));
  const hooks = [...groups(path.join(userHome, '.claude', 'settings.json'), 'claude'), ...groups(path.join(userHome, '.cursor', 'hooks.json'), 'cursor')];
  const config = path.join(home, 'config.toml'), hasConfig = fs.existsSync(config), cwd = process.cwd();
  const claudeRules = ['settings.local.json', 'settings.json'].map(name => path.join(userHome, '.claude', name)).find(file => json(file)?.permissions);
  const report = {
    grokVersion: '1.0.77', channel: 'unknown', updateChannel: null, cwd, projectRoot: `${cwd}/`, projectTrusted: true, projectInstructions,
    permissions: { sources: [...(claudeRules ? [`${claudeRules} (settings)`] : []), ...(hasConfig ? [`${config} (config)`] : [])], loaded: hasConfig ? 22 : 0, skipped: [], mcpServerAllowlist: [], mcpLockdownSources: [], mcpManagedServersOnly: 'off', marketplaceAllowlist: [], marketplaceLockdownSources: [], managedMarketplaces: [], managedSettingsPath: '/etc/claude-code/managed-settings.json', managedSettingsExists: false, managedSettingsActive: false, claudeBypassLockAdvisory: false },
    loginPolicy: { disableApiKeyAuth: null, forceLoginTeamUuid: null, apiKeyAuthDisabled: false },
    hooks, skills, agents, plugins: [], marketplaces: [], mcpServers, lspServers: [], configSources: { layers: hasConfig ? [{ role: 'user', path: config }] : [] }, experiments: [],
    externalCompat: { remoteSettingsLoaded: false, cells },
  };
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2)); else console.log(`  Environment\n  \u2514 Version: 1.0.77 [unknown]\n  Project Instructions (${projectInstructions.length})`);
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
const result = await act(prompt, record, { bypass, canWrite, canShell, canFetch, cwd, ask: null });
record.turns.push(prompt); save(record);
if (mode === 'max-turns') { console.log(JSON.stringify({ text: 'Still working on it.', stopReason: 'max_turn_requests', sessionId: session, requestId: 'req-1', num_turns: 3 })); process.exit(0); }
console.log(JSON.stringify({ text: resultText(result), stopReason: 'end_turn', sessionId: session, requestId: 'req-1', num_turns: 1, usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5, reasoning_tokens: 0, total_tokens: 15 }, modelUsage: { 'grok-4.6': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, modelCalls: 1 } } }));
