import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as grok from '../lib/adapters/grok.mjs';
import { agentEnv, runProcess } from '../lib/process.mjs';
import { conformanceState, requireConformance, runConformance } from '../lib/conformance.mjs';
import { answerApproval, awaitDecision, requestApproval } from '../lib/approvals.mjs';
import { policyReport } from '../lib/policy.mjs';
import { PROFILES } from '../lib/modes.mjs';
import { HOME_SECRETS } from '../lib/vendors.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { fakeClis, temp } from './helpers.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SESSION = '12345678-1234-4234-8234-123456789abc';
// A test world: ELU's personal directory under a scratch folder, a stand-in for the
// owner's home with a signed-in ~/.grok/auth.json (contents never read), the fake CLIs on
// PATH, and a small Git repository as the workspace.
function world(t, { mode = 'normal', signedIn = true } = {}) {
  const dir = temp(t), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  const home = path.join(dir, 'home'); fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
  if (signedIn) fs.writeFileSync(path.join(home, '.grok', 'auth.json'), '{"token":"fake"}\n', { mode: 0o600 });
  const f = fakeClis(dir, { mode });
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
  git(['init', '-q', '--initial-branch=main']); git(['config', 'user.name', 'T']); git(['config', 'user.email', 't@example.invalid']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); git(['add', '.']); git(['commit', '-qm', 'init']);
  const outside = path.join(dir, 'outside'); fs.mkdirSync(outside);
  const env = { PATH: f.env.PATH, HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: dir };
  return { dir, home, repo, outside, bin: path.join(f.dir, 'grok'), env, calls: f.calls, inputs: path.join(dir, 'inputs.jsonl'), personal: personalDirectory() };
}
const passed = (bin, { relay = true } = {}) => atomic(path.join(personalDirectory(), 'conformance', 'grok.json'), { v: 1, bin, version: '1.0.77', steps: Object.fromEntries(grok.conformance.map(step => [step.id, relay || step.id !== 'relay' ? 'pass' : 'fail'])), relay, at: new Date().toISOString() });
const lead = (access = 'edit', extra = {}) => ({ vendor: 'grok', access, writablePaths: access === 'edit' ? ['.'] : [], commands: [], network: 'off', maxCostUsd: null, timeoutSeconds: 120, ...extra });
const runDirIn = w => { const dir = path.join(w.dir, `run-${crypto.randomUUID()}`); fs.mkdirSync(dir); return dir; };
const lastInput = w => JSON.parse(fs.readFileSync(w.inputs, 'utf8').trim().split('\n').at(-1)).input;
const childEnv = (w, mode) => agentEnv(w.env, [], grok.childEnv({ mode, home: w.home }));
async function headless(w, { mode, prompt, role = lead(mode === 'locked' ? 'read' : 'edit'), resume = null }) {
  const runDir = runDirIn(w), session = crypto.randomUUID(), logFile = path.join(runDir, 'run.log');
  grok.prepareInput(prompt, { runDir });
  const args = grok.compile({ role, mode, cwd: w.repo, session, resume, runDir });
  const exit = await runProcess({ bin: w.bin, args, cwd: w.repo, env: childEnv(w, mode), input: 'Reply done with the summary "from stdin".', logFile, timeoutSeconds: 30 });
  return { exit, session, log: fs.readFileSync(logFile, 'utf8'), args };
}

test('compile refuses until this machine\'s check passed, then builds each profile\'s argv', t => {
  const w = world(t), runDir = runDirIn(w), folder = path.join(w.dir, 'evals'); fs.mkdirSync(folder);
  const base = { role: lead('read'), cwd: w.repo, session: SESSION, runDir };
  assert.throws(() => grok.compile({ ...base, mode: 'locked' }), /^EluCodeError: Grok Build has not been checked on this machine yet\. Your first message to it runs the check\.$/);
  passed(w.bin);
  const home = fs.realpathSync(os.homedir()), personal = fs.realpathSync(w.personal);
  const secrets = [
    ...HOME_SECRETS.flatMap(name => { const p = path.join(home, name); return [`Read(${p})`, `Read(${p}/**)`, `Grep(${p}/**)`]; }),
    ...['.env*', '.npmrc', '.netrc', '.pypirc', 'auth.json', 'credentials', 'credentials.json', 'id_rsa', 'id_ed25519', '*.pem'].map(name => `Read(**/${name})`),
    ...fs.readdirSync(personal).filter(name => name !== 'grok-home').flatMap(name => { const p = path.join(personal, name); return [`Read(${p})`, `Read(${p}/**)`, `Grep(${p}/**)`]; }),
  ];
  assert.ok(secrets.some(rule => rule === `Read(${path.join(personal, 'conformance')}/**)`), 'ELU state is denied');
  const never = grok.NEVER_COMMANDS.map(command => `Bash(${command}:*)`);
  const common = turns => ['--no-auto-update', '--no-alt-screen', '--no-memory', '--no-subagents', '--cwd', w.repo, '--output-format', 'json', '--max-turns', turns, '--prompt-file', path.join(runDir, 'prompt.txt')];
  const deny = rules => rules.flatMap(rule => ['--deny', rule]), allow = rules => rules.flatMap(rule => ['--allow', rule]);
  assert.deepEqual(grok.compile({ ...base, mode: 'locked' }), [...common('40'), '--permission-mode', 'dontAsk', '--sandbox', 'read-only', '--tools', 'read_file,grep,list_dir', '--disallowed-tools', 'run_terminal_cmd,search_replace,web_search,web_fetch,spawn_subagent,Agent', '--disable-web-search', ...deny(['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'MCPTool', ...secrets]), '-s', SESSION]);
  assert.deepEqual(grok.compile({ ...base, mode: 'locked' }), grok.compile({ ...base }), 'locked is the default profile');
  const edits = [`Edit(${w.repo})`, `Edit(${w.repo}/**)`, `Write(${w.repo})`, `Write(${w.repo}/**)`];
  const guarded = ['package.json', '.git'].flatMap(p => [`Edit(${w.repo}/${p})`, `Edit(${w.repo}/${p}/**)`, `Write(${w.repo}/${p})`, `Write(${w.repo}/${p}/**)`]);
  const ask = grok.compile({ ...base, role: lead(), mode: 'ask', folders: [folder], protectedPaths: ['package.json', '.git'] });
  assert.deepEqual(ask, [...common('120'), '--permission-mode', 'dontAsk', '--sandbox', 'workspace', ...allow(['Read', 'Grep', ...edits, `Read(${folder}/**)`]), ...deny([...guarded, ...never, ...secrets]), '-s', SESSION]);
  const auto = grok.compile({ ...base, role: lead(), mode: 'auto', folders: [folder], protectedPaths: ['package.json', '.git'] });
  assert.deepEqual(auto, ask.map(a => a === 'dontAsk' ? 'auto' : a));
  // Full access is everything: no never list and no deny rule, home secrets included.
  const full = grok.compile({ ...base, role: lead(), mode: 'full', place: { kind: 'here' }, protectedPaths: ['package.json'] });
  assert.deepEqual(full, [...common('120').filter(arg => arg !== '--no-subagents'), '--permission-mode', 'bypassPermissions', '--sandbox', 'off', '-s', SESSION]);
  assert.equal(full.some(arg => never.includes(arg)), false, 'no never-list rule in the Full access argv');
  assert.deepEqual(grok.compile({ ...base, role: lead(undefined, { model: 'grok-4.6' }), mode: 'ask', resume: SESSION }).filter((a, i, all) => ['--model', '-r'].includes(all[i - 1]) || ['--model', '-r', '-s'].includes(a)), ['--model', 'grok-4.6', '-r', SESSION]);
  for (const mode of ['ask', 'auto', 'full']) assert.ok(!grok.compile({ ...base, role: lead(), mode }).includes('read-only'), mode);
  for (const mode of ['locked', 'ask', 'auto']) assert.ok(!grok.compile({ ...base, role: lead(mode === 'locked' ? 'read' : 'edit'), mode }).some(a => /bypass|yolo|always-approve/.test(a)), mode);
  assert.throws(() => grok.compile({ ...base, mode: 'locked', peer: true }), /A teammate's question needs Claude as the model/);
  assert.throws(() => grok.compile({ ...base, role: lead(), mode: 'locked' }), /Grok Build cannot edit in Read only/);
  assert.throws(() => grok.compile({ ...base, role: lead(), mode: 'ask', place: { kind: 'here' } }), /Here needs Full access/);
  assert.throws(() => grok.compile({ ...base, role: lead('read', { maxCostUsd: 1 }), mode: 'locked' }), /dollar budget/);
  assert.throws(() => grok.compile({ ...base, mode: 'locked', runDir: null }), /private run folder/);
  assert.throws(() => grok.compile({ ...base, mode: 'locked', session: 'not-a-uuid' }), /UUID session/);
  assert.throws(() => grok.compile({ ...base, mode: 'locked', cwd: path.join(w.dir, 'odd (one)') }), /cannot be expressed safely/);
  assert.throws(() => grok.compile({ ...base, mode: 'plan' }), /Choose ask, auto, or full/);
  assert.deepEqual(grok.meta.supportedVersions, []); assert.throws(() => grok.meta.supportedVersions.push('1.0.77'));
  assert.ok(grok.meta.flags.includes('--prompt-file'));
});

test('childEnv carries every switch and no key variable; the private home holds ELU\'s config and a link to the real token', t => {
  const w = world(t);
  const env = grok.childEnv({ mode: 'locked', home: w.home }), personal = w.personal;
  assert.deepEqual(env, {
    HOME: path.join(personal, 'grok-home'), GROK_HOME: path.join(personal, 'grok-home', '.grok'),
    GROK_DISABLE_AUTOUPDATER: '1', GROK_TELEMETRY_ENABLED: '0', GROK_TELEMETRY_TRACE_UPLOAD: '0', GROK_TELEMETRY_MIXPANEL_ENABLED: '0', GROK_FEEDBACK_ENABLED: '0', GROK_MEMORY: '0', GROK_SUBAGENTS: '0', GROK_CAMPAIGNS: '0', GROK_BACKEND_SEARCH: '0',
    GROK_CLAUDE_SKILLS_ENABLED: '0', GROK_CLAUDE_RULES_ENABLED: '0', GROK_CLAUDE_AGENTS_ENABLED: '0', GROK_CLAUDE_MCPS_ENABLED: '0', GROK_CLAUDE_HOOKS_ENABLED: '0',
    GROK_CURSOR_SKILLS_ENABLED: '0', GROK_CURSOR_RULES_ENABLED: '0', GROK_CURSOR_AGENTS_ENABLED: '0', GROK_CURSOR_MCPS_ENABLED: '0', GROK_CURSOR_HOOKS_ENABLED: '0',
    GROK_WRITE_FILE: '0', GROK_WEB_FETCH: '0',
  });
  for (const mode of ['ask', 'auto', 'full']) { const open = grok.childEnv({ mode, home: w.home }); assert.equal(open.GROK_WRITE_FILE, undefined, mode); assert.equal(open.GROK_WEB_FETCH, undefined, mode); assert.equal(open.GROK_TELEMETRY_TRACE_UPLOAD, '0', mode); }
  assert.ok(Object.keys(env).every(key => !/KEY|TOKEN|SECRET/.test(key)));
  assert.deepEqual(grok.meta.envKeys, []);
  const merged = agentEnv({ ...w.env, XAI_API_KEY: 'sk-nope', GROK_API_KEY: 'nope', GROK_TELEMETRY_ENABLED: '1' }, grok.meta.envKeys, env);
  assert.equal(merged.XAI_API_KEY, undefined); assert.equal(merged.GROK_API_KEY, undefined); assert.equal(merged.GROK_TELEMETRY_ENABLED, '0'); assert.equal(merged.HOME, env.HOME); assert.equal(merged.PATH, w.env.PATH);
  // The private GROK_HOME: config and no-trust files written by ELU, a session store, and the token link.
  // The config is written for each run's profile: Full access has no never list there either.
  const dir = env.GROK_HOME, configOf = mode => { grok.childEnv({ mode, home: w.home }); return fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'); };
  const fullConfig = configOf('full');
  assert.equal(fullConfig, grok.configToml('full')); assert.doesNotMatch(fullConfig, /\[permission\]|deny|Bash\(/);
  for (const mode of ['locked', 'ask', 'auto']) assert.equal(configOf(mode), grok.CONFIG_TOML, mode);
  const config = configOf('locked');
  assert.equal(config, grok.CONFIG_TOML); assert.equal(fs.statSync(path.join(dir, 'config.toml')).mode & 0o777, 0o600);
  for (const line of ['[compat.claude]\nskills = false\nrules = false\nagents = false\nmcps = false\nhooks = false', '[compat.cursor]\nskills = false', 'telemetry = false', 'feedback = false', 'managed_config = false', 'campaigns = false', 'remote_fetch = false', 'backend_tools = false', 'trace_upload = false', 'mixpanel_enabled = false', '[harness]\ndisable_workspace_teleport = true\ndisable_codebase_upload = true', 'auto_update = false', '[relay]\nenabled = false', 'load_envrc = false', '[subagents]\nenabled = false', 'deny = ["Bash(git push:*)", "Bash(git tag:*)"']) assert.ok(config.includes(line), line);
  for (const mode of PROFILES) assert.equal(grok.childEnv({ mode, home: w.home }).GROK_BACKEND_SEARCH, '0', `server-side search is off in ${mode}`);
  assert.ok(!/api_key|env_key|token/i.test(config), 'no key or token in the config');
  assert.ok(fs.existsSync(path.join(dir, 'trusted_folders.toml'))); assert.ok(fs.statSync(path.join(dir, 'sessions')).isDirectory());
  assert.equal(fs.statSync(path.join(personal, 'grok-home')).mode & 0o777, 0o700);
  const link = path.join(dir, 'auth.json'), real = path.join(w.home, '.grok', 'auth.json');
  assert.ok(fs.lstatSync(link).isSymbolicLink()); assert.equal(fs.readlinkSync(link), real);
  assert.equal(grok.signedIn({ env }), true); assert.equal(grok.signedIn({ env: { HOME: w.home } }), true, 'detect checks the real ~/.grok');
  assert.equal(grok.signedIn({ env: {} }), false, 'no home, no guess'); assert.equal(grok.signedIn({ env: { HOME: path.join(w.dir, 'nobody') } }), false);
  fs.unlinkSync(real); assert.equal(grok.signedIn({ env }), false, 'a signed-out owner is signed out under the private home too');
  fs.writeFileSync(real, '{"token":"new"}\n', { mode: 0o600 }); assert.equal(grok.signedIn({ env }), true);
  // A stale link is pointed back at the real file; a file left by a rename keeps the newer token.
  fs.unlinkSync(link); fs.symlinkSync(path.join(w.dir, 'nowhere.json'), link); grok.childEnv({ mode: 'ask', home: w.home }); assert.equal(fs.readlinkSync(link), real);
  fs.unlinkSync(link); fs.writeFileSync(link, '{"token":"refreshed"}\n', { mode: 0o600 }); grok.childEnv({ mode: 'ask', home: w.home }); assert.ok(fs.lstatSync(link).isFile(), 'the newer private token stays');
  const old = new Date(Date.now() - 60000); fs.utimesSync(link, old, old); grok.childEnv({ mode: 'ask', home: w.home }); assert.ok(fs.lstatSync(link).isSymbolicLink(), 'an older private token gives way to the real one');
  assert.throws(() => grok.childEnv({ mode: 'plan', home: w.home }), /Choose ask, auto, or full/);
});

test('prepareInput writes the prompt file with the schema; the fake reads it, ignores stdin and reports a session the runner can resume', async t => {
  const w = world(t); passed(w.bin);
  const runDir = runDirIn(w), text = grok.prepareInput('Reply done with the summary "hello".', { runDir });
  assert.equal(fs.readFileSync(path.join(runDir, 'prompt.txt'), 'utf8'), text); assert.equal(fs.statSync(path.join(runDir, 'prompt.txt')).mode & 0o777, 0o600);
  assert.ok(text.startsWith('Reply done with the summary "hello".\n\n') && text.includes('"outcome"') && text.includes('"needs_input"'), 'the schema rides in the prompt');
  const run = await headless(w, { mode: 'locked', prompt: 'Reply done with the summary "hello".' });
  assert.equal(run.exit.code, 0, run.log);
  const parsed = grok.parse(run.log);
  assert.equal(parsed.result.summary, 'hello'); assert.equal(parsed.result.outcome, 'done'); assert.equal(parsed.session, run.session); assert.equal(parsed.costUsd, null); assert.equal(parsed.model, 'grok-4.6'); assert.deepEqual(parsed.denials, []); assert.equal(parsed.effectiveMode, null); assert.equal(parsed.usage.total_tokens, 15);
  assert.ok(lastInput(w).startsWith('Reply done with the summary "hello".'), 'the prompt file, not stdin');
  const first = await headless(w, { mode: 'locked', prompt: `Remember this nonce: ${SESSION}. Reply done with the summary "noted".` });
  const second = await headless(w, { mode: 'locked', prompt: 'What nonce did I give you earlier? Reply done with the nonce as the summary.', resume: first.session });
  assert.equal(grok.parse(second.log).result.summary, SESSION); assert.equal(grok.parse(second.log).session, first.session);
  // Without a prompt file the fake has nothing: stdin is never a prompt.
  const logFile = path.join(runDir, 'none.log');
  const exit = await runProcess({ bin: w.bin, args: ['--output-format', 'json', '-s', SESSION], cwd: w.repo, env: childEnv(w, 'locked'), input: 'Reply done.', logFile, timeoutSeconds: 30 });
  assert.equal(exit.code, 1); assert.throws(() => grok.parse(fs.readFileSync(logFile, 'utf8')), /could not finish/);
});

test('the fake honors --permission-mode bypassPermissions; a locked run writes, runs and fetches nothing', async t => {
  const w = world(t); passed(w.bin);
  const inside = path.join(w.repo, 'inside.txt'), outside = path.join(w.outside, 'full.txt');
  const full = await headless(w, { mode: 'full', prompt: `Create a file at ${inside} and another at ${outside}, each containing the word created.` });
  assert.equal(full.exit.code, 0, full.log); assert.equal(grok.parse(full.log).result.outcome, 'done');
  assert.ok(fs.existsSync(inside) && fs.existsSync(outside), 'full access wrote both');
  fs.unlinkSync(inside); fs.unlinkSync(outside);
  const locked = await headless(w, { mode: 'locked', prompt: `Create a file at ${inside} and another at ${outside}, each containing the word created.` });
  const result = grok.parse(locked.log).result;
  assert.equal(result.outcome, 'needs_input'); assert.match(result.summary, /^Blocked: write/); assert.ok(!fs.existsSync(inside) && !fs.existsSync(outside));
  const ask = await headless(w, { mode: 'ask', prompt: `Create a file at ${inside} and another at ${outside}, each containing the word created.` });
  assert.ok(fs.existsSync(inside) && !fs.existsSync(outside), 'the headless ask fallback edits the workspace and denies outside it');
  assert.equal(grok.parse(ask.log).result.outcome, 'needs_input');
});

test('parse reads the json object, pulls the result out of fences, and names auth, quota and early stops', t => {
  const w = world(t);
  const object = extra => JSON.stringify({ text: JSON.stringify({ outcome: 'done', summary: 'ok', question: null, choices: [], comments: [], responses: [] }), stopReason: 'end_turn', sessionId: SESSION, requestId: 'r', ...extra });
  assert.equal(grok.parse(object({})).result.summary, 'ok');
  assert.equal(grok.parse(object({ total_cost_usd: 0.25 })).costUsd, 0.25);
  assert.equal(grok.parse(object({ total_cost_usd: 0.25, cost_is_partial: true })).costUsd, null, 'a partial cost is no cost');
  assert.equal(grok.parse(`{\n  "text": "Here:\\n\`\`\`json\\n{\\"outcome\\":\\"done\\",\\"summary\\":\\"fenced\\",\\"question\\":null,\\"choices\\":[],\\"comments\\":[],\\"responses\\":[]}\\n\`\`\`",\n  "stopReason": "end_turn",\n  "sessionId": "${SESSION}"\n}`).result.summary, 'fenced', 'pretty-printed output with a fenced answer');
  assert.throws(() => grok.parse(''), /returned no JSON result/);
  assert.throws(() => grok.parse('not json'), /returned no JSON result/);
  assert.throws(() => grok.parse(object({ text: 'I could not do that.' })), /returned no JSON run result/);
  assert.throws(() => grok.parse(object({ text: 'Still going', stopReason: 'max_turn_requests' })), /stopped early \(max_turn_requests\)/);
  assert.throws(() => grok.parse(object({ text: JSON.stringify({ outcome: 'nope' }) })), /unknown field|invalid outcome/);
  const error = message => JSON.stringify({ type: 'error', message });
  const failure = (() => { try { grok.parse(error('Not logged in. Run grok login.')); } catch (e) { return e; } })();
  assert.match(failure.message, /could not finish/); assert.equal(failure.details.cause, 'auth');
  assert.equal(grok.classify(error('Rate limit exceeded, retry later')), 'rate-limit');
  assert.equal(grok.classify(error('Usage limit reached for your subscription')), 'quota');
  assert.equal(grok.classify(error("Couldn't start session: boom")), 'unknown'); assert.equal(grok.classify(''), 'unknown'); assert.equal(grok.classify(object({})), 'unknown');
  assert.deepEqual(grok.logRow(JSON.parse(object({}))), { speaker: 'lead', text: 'ok' });
  assert.deepEqual(grok.logRow({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } }), { speaker: 'lead', text: 'hi' });
  assert.deepEqual(grok.logRow({ method: 'session/request_permission', params: { toolCall: { title: 'Write /x' } } }), { speaker: 'lead', text: 'Asks: Write /x' });
  assert.equal(grok.logRow({ jsonrpc: '2.0', id: 1, result: {} }), null); assert.equal(grok.logRow('x'), null);
  const open = grok.interactive({ session: SESSION, cwd: w.repo });
  assert.deepEqual([open.bin, open.args], ['grok', ['--no-auto-update', '--cwd', w.repo, '-r', SESSION]]); assert.equal(open.env.GROK_HOME, path.join(w.personal, 'grok-home', '.grok'));
  for (const mode of PROFILES) { const report = policyReport(lead(mode === 'locked' ? 'read' : 'edit'), { mode }); assert.equal(report.rules.length, 7, mode); assert.ok(report.rules.every(rule => typeof rule.enforcement === 'string' && rule.enforcement), mode); }
  assert.match(policyReport(lead(), { mode: 'full' }).rules.find(rule => rule.rule.startsWith('never')).enforcement, /^none: Full access runs/);
  assert.match(policyReport(lead('read'), { mode: 'locked' }).rules.find(rule => rule.rule === 'dollar limit').enforcement, /not requested/);
  assert.deepEqual(grok.foreignTraces({ sources: [{ path: path.join(w.personal, 'grok-home', '.grok', 'config.toml') }], externalCompat: { claude: { rules: { enabled: false } } } }), []);
  assert.deepEqual(grok.foreignTraces({ instructions: [{ path: '/Users/x/.claude/CLAUDE.md', vendor: 'claude' }], hooks: [{ origin: 'cursor' }], externalCompat: { claude: { rules: { enabled: true } } } }), ['/Users/x/.claude/CLAUDE.md', 'claude', 'cursor', 'externalCompat.claude.rules.enabled']);
});

test('run() relays an ACP permission request through the approval files: allow writes, deny and timeout do not, and a pending approval holds the time limit', async t => {
  const w = world(t); passed(w.bin);
  const approvals = decide => ({ request: options => requestApproval({ ...options, root: w.repo, taskId: '1', role: 'lead', vendor: 'grok' }), await: (id, extra) => decide(id, extra) });
  const start = (name, extra = {}) => ({ bin: w.bin, role: lead(), mode: 'ask', cwd: w.repo, env: w.env, logFile: path.join(w.dir, `${name}.log`), processFile: path.join(w.dir, `${name}.pid`), timeoutSeconds: 30, ...extra });
  const file = name => path.join(w.outside, `${name}.txt`), create = name => `Create a file at ${file(name)} containing the word acp.`;
  const allowed = await grok.run(start('allow', { prompt: create('allow'), approvals: approvals(async id => { answerApproval(id, 'allow'); return awaitDecision(id, { waitSeconds: 5 }); }) }));
  assert.equal(allowed.result.outcome, 'done'); assert.ok(fs.existsSync(file('allow'))); assert.deepEqual(allowed.denials, []); assert.equal(allowed.effectiveMode, 'ask');
  assert.equal(allowed.approvals.length, 1); assert.equal(allowed.approvals[0].decision, 'allow'); assert.equal(allowed.approvals[0].tool, 'edit'); assert.equal(allowed.approvals[0].summary, `Write ${file('allow')}`);
  assert.match(allowed.session, /^[0-9a-f-]{36}$/); assert.equal(allowed.log, path.join(w.dir, 'allow.log')); assert.ok(allowed.exitCode === null || Number.isInteger(allowed.exitCode));
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, 'allow.pid'), 'utf8')).pid, null);
  assert.ok(fs.readFileSync(path.join(w.dir, 'allow.log'), 'utf8').includes('session/request_permission'), 'the vendor lines are the run log');
  const denied = await grok.run(start('deny', { prompt: create('deny'), approvals: approvals(async id => { answerApproval(id, 'deny'); return awaitDecision(id, { waitSeconds: 5 }); }) }));
  assert.equal(denied.result.outcome, 'needs_input'); assert.ok(!fs.existsSync(file('deny'))); assert.deepEqual(denied.denials, [{ tool: 'edit', summary: `Write ${file('deny')}` }]); assert.equal(denied.approvals[0].decision, 'deny');
  const timed = await grok.run(start('timeout', { prompt: create('timeout'), approvals: approvals(id => awaitDecision(id, { waitSeconds: 1 })) }));
  assert.ok(!fs.existsSync(file('timeout'))); assert.equal(timed.denials.length, 1); assert.equal(timed.approvals[0].decision, 'timeout');
  const silent = await grok.run(start('silent', { prompt: create('silent') }));
  assert.ok(!fs.existsSync(file('silent')), 'no approvals means every request is denied'); assert.equal(silent.denials.length, 1); assert.deepEqual(silent.approvals, []);
  // The time limit waits while the owner decides.
  const held = await grok.run(start('held', { prompt: create('held'), timeoutSeconds: 2, approvals: approvals(async id => { await sleep(2500); answerApproval(id, 'allow'); return awaitDecision(id, { waitSeconds: 5 }); }) }));
  assert.equal(held.result.outcome, 'done'); assert.ok(fs.existsSync(file('held')));
  // A workspace edit never asks; auto mode is requested on the session; a resumed session remembers.
  const inside = path.join(w.repo, 'inside.txt');
  const free = await grok.run(start('inside', { prompt: `Create a file at ${inside} containing the word acp.`, approvals: approvals(() => { throw new Error('asked for a workspace edit'); }) }));
  assert.equal(free.result.outcome, 'done'); assert.ok(fs.existsSync(inside));
  const auto = await grok.run(start('auto', { mode: 'auto', prompt: `Remember this nonce: ${SESSION}. Reply done with the summary "noted".` }));
  const stored = JSON.parse(fs.readFileSync(path.join(w.personal, 'grok-home', '.grok', 'sessions', `${auto.session}.json`), 'utf8'));
  assert.equal(stored.auto, true); assert.equal(stored.yolo, false); assert.equal(auto.effectiveMode, 'auto');
  const resumed = await grok.run(start('resume', { mode: 'auto', resume: auto.session, prompt: 'What nonce did I give you earlier? Reply done with the nonce as the summary.' }));
  assert.equal(resumed.result.summary, SESSION); assert.equal(resumed.session, auto.session);
  assert.ok(lastInput(w).includes('"outcome"'), 'the schema rides in the ACP prompt too');
  await assert.rejects(grok.run(start('locked', { mode: 'locked', role: lead('read'), prompt: 'x' })), /ACP in Ask or Auto only/);
  await assert.rejects(grok.run(start('full', { mode: 'full', prompt: 'x' })), /ACP in Ask or Auto only/);
  await assert.rejects(grok.run(start('peer', { peer: true, prompt: 'x' })), /A teammate's question needs Claude as the model/);
  await assert.rejects(grok.run(start('relative', { bin: 'grok', prompt: 'x' })), /resolved binary path/);
  await assert.rejects(grok.run(start('empty', { prompt: ' ' })), /needs a prompt/);
  const out = world(t, { signedIn: false }); passed(out.bin);
  const failure = await grok.run({ ...start('out', { prompt: 'x' }), bin: out.bin, env: out.env, cwd: out.repo, logFile: path.join(out.dir, 'out.log') }).then(() => null, error => error);
  assert.match(failure.message, /could not finish/); assert.equal(failure.details.cause, 'auth'); assert.match(failure.details.reason, /Run: grok login/);
  // A machine whose relay step failed keeps the headless fallback: ACP would skip the question.
  passed(out.bin, { relay: false });
  await assert.rejects(grok.run({ ...start('norelay', { prompt: 'x' }), bin: out.bin, env: out.env, cwd: out.repo }), /^EluCodeError: Grok Build can't ask live here\. Blocked actions are reported\.$/);
  assert.ok(grok.compile({ role: lead('read'), mode: 'locked', cwd: out.repo, session: SESSION, runDir: runDirIn(out) }).includes('--prompt-file'), 'the headless profiles still launch without the relay');
  assert.ok(!fs.existsSync(path.join(out.dir, 'norelay.log')), 'nothing was spawned');
});

test('the conformance steps pass against the fake, hide the owner\'s Claude files, and enable a launch', async t => {
  const w = world(t), lines = [];
  // The owner's real Claude configuration: nothing of it may reach a run.
  fs.mkdirSync(path.join(w.home, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(w.home, '.claude', 'CLAUDE.md'), '# Owner rules\n'); fs.writeFileSync(path.join(w.home, '.claude', 'rules', 'style.md'), 'Be terse.\n');
  const result = await runConformance('grok', { bin: w.bin, version: '1.0.77', scratch: path.join(w.dir, 'scratch'), env: w.env, log: line => lines.push(line) });
  assert.deepEqual(result, { steps: { signin: 'pass', 'locked-no-write': 'pass', 'locked-no-shell': 'pass', 'locked-no-network': 'pass', json: 'pass', resume: 'pass', relay: 'pass', isolation: 'pass' }, relay: true }, lines.join('\n'));
  assert.deepEqual(grok.conformance.map(step => [step.id, step.required]), [['signin', true], ['locked-no-write', true], ['locked-no-shell', true], ['locked-no-network', true], ['json', true], ['resume', true], ['relay', false], ['isolation', true]]);
  assert.equal(requireConformance('grok', { bin: w.bin, version: '1.0.77' }), true); assert.equal(conformanceState('grok').relay, true);
  assert.throws(() => requireConformance('grok', { bin: w.bin, version: '1.0.78' }), /Grok Build has not been checked on this machine yet/, 'another release proves itself again');
  const runDir = runDirIn(w);
  assert.ok(grok.compile({ role: lead('read'), mode: 'locked', cwd: w.repo, session: SESSION, runDir }).includes('--prompt-file'), 'launchable after the pass');
  // Under a private HOME the fake's inspect sees no ~/.claude; under the owner's HOME it would.
  const bleed = spawnSync(w.bin, ['--no-auto-update', 'inspect', '--json'], { cwd: w.repo, env: agentEnv(w.env), encoding: 'utf8' });
  const traces = grok.foreignTraces(JSON.parse(bleed.stdout));
  for (const file of ['CLAUDE.md', 'rules/style.md']) assert.ok(traces.includes(path.join(w.home, '.claude', file)), `without the private home the owner's ${file} would load`);
  assert.ok(traces.includes('externalCompat.claude.hooks.enabled'), 'and the compatibility cells would be on');
  const calls = fs.readFileSync(w.calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(call => call.vendor === 'grok' && !call.args.includes('--trust')), 'no run trusts the workspace');
  assert.ok(calls.some(call => call.args.includes('agent') && call.args.includes('stdio')), 'the relay step spoke ACP');
  assert.ok(calls.filter(call => call.args.includes('--prompt-file')).every(call => call.args.includes('read-only') && call.args.includes('dontAsk')), 'every headless step ran locked');
});

test('a failed step is recorded and keeps Grok off: a Claude instruction fails isolation, a leaky run fails the locked steps, a signed-out owner fails signin', async t => {
  const bleed = world(t, { mode: 'claude-bleed' }), lines = [];
  const first = await runConformance('grok', { bin: bleed.bin, version: '1.0.77', scratch: path.join(bleed.dir, 'scratch'), env: bleed.env, log: line => lines.push(line) });
  assert.equal(first.steps.isolation, 'fail'); assert.equal(first.steps.json, 'pass'); assert.equal(first.relay, true);
  assert.ok(lines.some(line => /isolation: fail: Claude or Cursor configuration reached the run: .*\.claude\/CLAUDE\.md/.test(line)), lines.join('\n'));
  assert.throws(() => requireConformance('grok', { bin: bleed.bin, version: '1.0.77' }), /^EluCodeError: Grok Build did not pass its check on this machine \(not proven: no other tool's settings reach its turn\)\. Your next message to it runs the check again\.$/);
  assert.throws(() => grok.compile({ role: lead('read'), mode: 'locked', cwd: bleed.repo, session: SESSION, runDir: runDirIn(bleed) }), /Grok Build did not pass its check on this machine/);
  const leaky = world(t, { mode: 'leaky' });
  const second = await runConformance('grok', { bin: leaky.bin, version: '1.0.77', scratch: path.join(leaky.dir, 'scratch'), env: leaky.env });
  assert.deepEqual([second.steps['locked-no-write'], second.steps['locked-no-shell'], second.steps['locked-no-network'], second.steps.relay, second.relay], ['fail', 'fail', 'fail', 'fail', false]);
  assert.equal(second.steps.json, 'pass');
  const out = world(t, { signedIn: false });
  const third = await runConformance('grok', { bin: out.bin, version: '1.0.77', scratch: path.join(out.dir, 'scratch'), env: out.env });
  assert.equal(third.steps.signin, 'fail'); assert.equal(third.steps.relay, 'fail');
  assert.throws(() => requireConformance('grok', { bin: out.bin, version: '1.0.77' }), /Grok Build did not pass its check on this machine \(not proven: it is signed in/);
});
