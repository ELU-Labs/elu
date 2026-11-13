import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compile as claude, childEnv, parse as readClaude } from '../lib/adapters/claude.mjs';
import { launch as agy, privateHome as agyHome } from '../lib/adapters/agy.mjs';
import * as grok from '../lib/adapters/grok.mjs';
import * as codex from '../lib/adapters/codex.mjs';
import { agentEnv } from '../lib/process.mjs';
import * as checks from '../lib/checks.mjs';
import * as modes from '../lib/modes.mjs';
import { foldersNamed } from '../lib/terminal.mjs';
import { botEditInstructions, botWorkInstructions } from '../lib/bots.mjs';
import { atomic } from '../lib/util.mjs';
import { git } from './helpers.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { APPROVAL_TOOL } from '../lib/mcp.mjs';
import { checkFolders } from '../lib/modes.mjs';
import { personalDirectory } from '../lib/util.mjs';
import { temp } from './helpers.mjs';

// Full access is everything: every tool, every helper, every folder, any path name. The
// lower modes keep each limit.
const SESSION = '12345678-1234-4234-8234-123456789abc';
function world(t, name = 'ws') {
  const dir = temp(t), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  const cwd = path.join(dir, name); fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  fs.mkdirSync(path.resolve(personalDirectory()), { recursive: true });
  const mcp = { file: path.join(dir, 'mcp.json'), names: ['elu-code-approval'] }; fs.writeFileSync(mcp.file, '{"mcpServers":{}}');
  const schemaFile = path.join(dir, 'schema.json'); fs.writeFileSync(schemaFile, '{}');
  const runDir = path.join(dir, 'run'); fs.mkdirSync(runDir);
  const role = defaultConfig().roles.lead;
  const launch = (mode, extra = {}) => claude({ role, mode, cwd, protectedPaths: ['.git'], commonDir: path.join(cwd, '.git'), session: SESSION, mcp, approval: { tool: APPROVAL_TOOL }, ...extra });
  return { dir, cwd, mcp, schemaFile, runDir, role, launch };
}
const valueOf = (args, flag) => args[args.indexOf(flag) + 1];
const settingsOf = args => JSON.parse(valueOf(args, '--settings'));

test('Claude in Full access is refused no tool; Ask and Approve for me keep the list', t => {
  const w = world(t), full = w.launch('full');
  assert.equal(full.includes('--disallowedTools'), false, 'no tool is refused in Full access');
  assert.equal(valueOf(full, '--tools'), 'default', 'every tool Claude Code has');
  for (const mode of ['ask', 'auto']) { const args = w.launch(mode); assert.equal(valueOf(args, '--disallowedTools'), 'Agent,Task,NotebookEdit,PowerShell,Monitor', mode); assert.equal(valueOf(args, '--tools'), 'Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch', mode); }
  // A turn that only reads keeps its three tools in every mode: that is the turn, not the mode.
  const reads = w.launch('full', { readTools: true });
  assert.equal(valueOf(reads, '--tools'), 'Read,Grep,Glob'); assert.ok(valueOf(reads, '--disallowedTools').includes('Bash'));
});

test('a bot turn with helpers in Full access sends no Agent rule and limits no helper', t => {
  const w = world(t), full = w.launch('full', { subagents: 'haiku' }), settings = settingsOf(full);
  assert.deepEqual(settings.permissions.deny, [], 'no Agent(...) rule');
  assert.equal(full.some(arg => arg.includes('Agent(')), false);
  assert.equal(full.includes('--disallowedTools'), false);
  assert.deepEqual(Object.keys(settings.env).filter(name => name.startsWith('CLAUDE_')).sort(), ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'], 'only the model the owner chose for helpers');
  assert.deepEqual(childEnv({ subagents: 'haiku', mode: 'full' }), { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
  assert.equal(Object.values(JSON.parse(valueOf(full, '--agents')))[0].tools, undefined, 'the helper has every tool');
  const auto = w.launch('auto', { subagents: 'haiku' }), lower = settingsOf(auto);
  assert.ok(lower.permissions.deny.includes('Agent(general-purpose)')); assert.ok(lower.permissions.deny.includes('Agent(model:*)'));
  assert.equal(lower.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '1'); assert.equal(childEnv({ subagents: 'haiku', mode: 'auto' }).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
});

test('a path with glob characters starts in Full access on Claude and Antigravity CLI; lower modes refuse it', t => {
  const w = world(t, 'my [work] (v2) *'), lead = { ...w.role, writablePaths: ['.'] }, odd = path.join(w.dir, 'notes {a,b}?'); fs.mkdirSync(odd);
  assert.ok(w.launch('full', { folders: [odd] }).includes(odd));
  assert.throws(() => w.launch('ask'), /cannot be expressed safely/);
  assert.ok(agy({ role: lead, mode: 'full', cwd: w.cwd, folders: [odd], schemaFile: w.schemaFile }).includes('--dangerously-skip-permissions'));
  assert.throws(() => agy({ role: lead, mode: 'ask', cwd: w.cwd, schemaFile: w.schemaFile }), /cannot be expressed safely/);
});

test('/permissions folders takes a secret folder, ELU\'s own folder and one outside home in Full access only', t => {
  const dir = fs.realpathSync(temp(t)), home = path.join(dir, 'home'), outside = path.join(dir, 'elsewhere'), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(home, '.config'); t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  const own = path.resolve(personalDirectory());
  for (const folder of [path.join(home, '.ssh'), path.join(home, 'work'), own, outside]) fs.mkdirSync(folder, { recursive: true });
  for (const mode of [undefined, 'ask', 'auto']) {
    for (const folder of [path.join(home, '.ssh'), own]) assert.throws(() => checkFolders([folder], { home, mode }), /holds secrets or ELU state/, `${mode} ${folder}`);
    assert.throws(() => checkFolders([outside], { home, mode }), /inside your home/);
    assert.deepEqual(checkFolders([path.join(home, 'work')], { home, mode }), [path.join(home, 'work')]);
  }
  assert.deepEqual(checkFolders([path.join(home, '.ssh'), own, outside, home], { home, mode: 'full' }), [path.join(home, '.ssh'), own, outside, home]);
  assert.throws(() => checkFolders([path.join(home, 'missing')], { home, mode: 'full' }), /Folder not found/);
});

// The record of a passed one-time check, as lib/conformance.mjs keeps it for this machine.
// A lead on a vendor that takes no dollar budget and no command list.
const plainLead = vendor => ({ vendor, access: 'edit', writablePaths: ['.'], commands: [], network: 'off', maxCostUsd: null, timeoutSeconds: 120 });
const grokChecked = bin => atomic(path.join(personalDirectory(), 'conformance', 'grok.json'), { v: 1, bin, version: '1.0.77', steps: Object.fromEntries(grok.conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });

test('Grok Build in Full access starts in a path with glob characters, with its memory, its helpers and no turn cap; lower modes keep each', t => {
  const w = world(t, 'my [work] (v2) *'), lead = plainLead('grok');
  const odd = path.join(w.dir, 'notes {a,b}?'), runDir = path.join(w.dir, 'run [1] *'), home = path.join(w.dir, 'home'); for (const dir of [odd, runDir, path.join(home, '.grok')]) fs.mkdirSync(dir, { recursive: true });
  const base = { role: lead, cwd: w.cwd, session: SESSION, runDir };
  assert.throws(() => grok.compile({ ...base, mode: 'full' }), /has not been checked on this machine yet/, 'the one-time check still comes first');
  grokChecked(path.join(w.dir, 'grok'));
  const full = grok.compile({ ...base, mode: 'full', folders: [odd] });
  assert.deepEqual(full, ['--no-auto-update', '--no-alt-screen', '--cwd', w.cwd, '--output-format', 'json', '--prompt-file', path.join(runDir, 'prompt.txt'), '--permission-mode', 'bypassPermissions', '--sandbox', 'off', '-s', SESSION]);
  for (const flag of ['--no-memory', '--no-subagents', '--max-turns', '--deny', '--disallowed-tools']) assert.equal(full.includes(flag), false, `${flag} is not in a Full access launch`);
  for (const mode of ['ask', 'auto']) assert.throws(() => grok.compile({ ...base, mode }), /cannot be expressed safely/, mode);
  const plain = { ...base, cwd: path.join(w.dir, 'plain'), runDir: path.join(w.dir, 'run') }; fs.mkdirSync(path.join(plain.cwd, '.git'), { recursive: true });
  for (const mode of ['ask', 'auto']) { const args = grok.compile({ ...plain, mode }); for (const flag of ['--no-memory', '--no-subagents']) assert.ok(args.includes(flag), `${mode} ${flag}`); assert.equal(valueOf(args, '--max-turns'), '120', mode); }
  // The environment and the config of the run: no switch that takes something from the agent.
  const env = grok.childEnv({ mode: 'full', home });
  for (const name of ['GROK_MEMORY', 'GROK_SUBAGENTS', 'GROK_BACKEND_SEARCH']) { assert.equal(env[name], undefined, `${name} in Full access`); for (const mode of ['locked', 'ask', 'auto']) assert.equal(grok.childEnv({ mode, home })[name], '0', `${name} in ${mode}`); }
  assert.doesNotMatch(grok.configToml('full'), /\[subagents\]|backend_tools|\[permission\]/);
  for (const mode of ['locked', 'ask', 'auto']) assert.match(grok.configToml(mode), /backend_tools = false[\s\S]*\[subagents\]\nenabled = false\n\n\[permission\]/, mode);
});

test('Antigravity CLI in Full access keeps its slash commands and has no hook of ELU; a turn in another mode puts both back', t => {
  const w = world(t), lead = { ...w.role, writablePaths: ['.'] }, base = { role: lead, cwd: w.cwd, schemaFile: w.schemaFile };
  const read = name => JSON.parse(fs.readFileSync(path.join(agyHome({ cwd: w.cwd }), '.gemini', name), 'utf8'));
  agy({ ...base, mode: 'ask' });
  assert.equal(read('antigravity-cli/settings.json').disableSlashCommands, true); assert.equal(read('config/hooks.json').hooks.PreToolUse.length, 1);
  agy({ ...base, mode: 'full' });
  const settings = read('antigravity-cli/settings.json');
  assert.equal('disableSlashCommands' in settings, false, 'slash commands stay on'); assert.deepEqual(settings.trustedWorkspaces, [w.cwd]); assert.deepEqual(Object.keys(settings.permissions), ['allow']);
  assert.deepEqual(read('config/hooks.json'), { hooks: { PreToolUse: [] } }, 'the hook of the turn before is gone');
  agy({ ...base, mode: 'auto' });
  assert.equal(read('antigravity-cli/settings.json').disableSlashCommands, true); assert.match(read('config/hooks.json').hooks.PreToolUse[0].hooks[0].command, /--profile auto$/);
});

test('Codex in Full access keeps every feature of its release and every kind of item is read; lower modes keep the list', t => {
  const w = world(t), lead = plainLead('codex'), base = { role: lead, cwd: w.cwd, commonDir: path.join(w.cwd, '.git'), schemaFile: w.schemaFile };
  const full = codex.compile({ ...base, mode: 'full' }), sets = args => args.filter((arg, at) => args[at - 1] === '-c');
  assert.deepEqual(sets(full), ['sandbox_mode="danger-full-access"', 'approval_policy="never"', 'web_search="live"', 'mcp_servers={}', 'tools.experimental_request_user_input.enabled=false', 'features.shell_tool=true', 'features.unified_exec=true']);
  assert.equal(sets(full).some(set => /=false$/.test(set) && !set.startsWith('tools.experimental_request_user_input')), false, 'nothing else is switched off');
  for (const mode of ['ask', 'auto']) { const lower = sets(codex.compile({ ...base, mode })); for (const set of ['features.multi_agent=false', 'features.plugins=false', 'tools.update_plan.enabled=false', 'allow_login_shell=false', 'shell_environment_policy.inherit="core"', 'skills.bundled.enabled=false']) assert.ok(lower.includes(set), `${mode} ${set}`); }
  // A helper, an MCP tool and a kind this release does not have yet: Full access reads them all.
  const answer = { outcome: 'done', summary: 'ok' }, rows = kinds => [{ type: 'thread.started', thread_id: SESSION }, ...kinds.map(type => ({ type: 'item.completed', item: { type, status: 'completed' } })), { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(answer) } }, { type: 'turn.completed' }].map(row => JSON.stringify(row)).join('\n');
  const read = (kinds, mode) => codex.parse(rows(kinds), { mode, validate: value => value });
  assert.deepEqual(read(['command_execution', 'file_change', 'web_search', 'collab_tool_call', 'mcp_tool_call', 'todo_list', 'something_new'], 'full').result, answer);
  for (const mode of ['ask', 'auto']) { assert.deepEqual(read(['command_execution', 'file_change'], mode).result, answer); for (const kind of ['collab_tool_call', 'mcp_tool_call', 'web_search']) assert.throws(() => read([kind], mode), /exposed a tool that this session must not have/, `${mode} ${kind}`); }
  assert.throws(() => read(['command_execution'], 'locked'), /exposed a tool that this reviewer must not have/);
});

test('a Claude helper in Full access is told nothing it may not do, and a bot is not told its helpers are limited', t => {
  const w = world(t), promptOf = args => Object.values(JSON.parse(valueOf(args, '--agents')))[0].prompt;
  const full = promptOf(w.launch('full', { subagents: 'haiku' })), lower = promptOf(w.launch('auto', { subagents: 'haiku' }));
  assert.doesNotMatch(full, /Do not start agents|Do not push|Do not change policy/); assert.match(full, /^You are a helper in an ELU session\./); assert.match(full, /report in plain text/);
  assert.match(lower, /Do not push, merge, tag, publish or deploy, and do not start agents\. Do not change policy, checks, credentials or repository configuration\./);
  const bot = { name: 'lead', instructions: 'Plan the work.' };
  for (const text of [botWorkInstructions(bot, { helpers: 'opus', full: true }), botEditInstructions(bot, { helpers: 'opus', full: true })]) { assert.doesNotMatch(text, /cannot start helpers of their own|the only kind there is here/); assert.match(text, /Executors work with this session's Full access, as you do\./); }
  for (const text of [botWorkInstructions(bot, { helpers: 'opus' }), botEditInstructions(bot, { helpers: 'opus' })]) assert.match(text, /always with subagent_type executor, the only kind there is here[\s\S]*they cannot start helpers of their own\./);
});

test('a Claude run in Full access gets the owner\'s npm and OpenSSL settings; lower modes keep them out', t => {
  const w = world(t);
  assert.deepEqual(settingsOf(w.launch('full')).env, {}, 'Full access sets nothing for the commands of the run');
  for (const mode of ['ask', 'auto']) { const env = settingsOf(w.launch(mode)).env; assert.equal(env.npm_config_userconfig, '/dev/null', mode); assert.equal(env.OPENSSL_CONF, '/dev/null', mode); }
});

test('a Full access run gets the owner\'s whole environment, less the names that choose a vendor\'s account; lower modes get the allow-list', () => {
  const owner = { PATH: '/bin', HOME: '/home/o', SSH_AUTH_SOCK: '/run/agent.sock', GH_TOKEN: 'gh', GITHUB_TOKEN: 'ghp', AWS_PROFILE: 'work', GOOGLE_APPLICATION_CREDENTIALS: '/k.json', KUBECONFIG: '/kube', NPM_TOKEN: 'n', HTTPS_PROXY: 'http://proxy', lower_case: 'kept', MULTI: 'a\nb',
    ANTHROPIC_API_KEY: 'sk', ANTHROPIC_BASE_URL: 'https://x', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDECODE: '1', OPENAI_API_KEY: 'sk', CODEX_SANDBOX: 'x', XAI_API_KEY: 'x', GROK_MEMORY: '1', GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'g', GOOGLE_GENAI_USE_VERTEXAI: '1', AGY_X: '1', ANTIGRAVITY_X: '1' };
  const full = agentEnv(owner, [], {}, { full: true });
  assert.deepEqual(Object.keys(full).sort(), ['AWS_PROFILE', 'GH_TOKEN', 'GITHUB_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'HOME', 'HTTPS_PROXY', 'KUBECONFIG', 'MULTI', 'NPM_TOKEN', 'PATH', 'SSH_AUTH_SOCK', 'lower_case']);
  assert.equal(full.SSH_AUTH_SOCK, '/run/agent.sock'); assert.equal(full.MULTI, 'a\nb');
  for (const lower of [agentEnv(owner), agentEnv(owner, [], {}, { full: false })]) assert.deepEqual(Object.keys(lower).sort(), ['HOME', 'PATH']);
  // What ELU sets for the run still wins, and an account folder a vendor name carries is kept as before.
  assert.equal(agentEnv({ ...owner, GROK_MEMORY: '1', CODEX_HOME: '/home/o/.codex' }, [], { GROK_TELEMETRY_ENABLED: '0' }, { full: true }).GROK_TELEMETRY_ENABLED, '0');
  assert.equal(agentEnv({ ...owner, CODEX_HOME: '/home/o/.codex', CLAUDE_CONFIG_DIR: '/home/o/.claude' }, [], {}, { full: true }).CODEX_HOME, '/home/o/.codex');
});

test('a vendor that runs under a home of ELU\'s gets no Git or gh pointer of ELU\'s in Full access: the home itself leads to the owner\'s settings', t => {
  const w = world(t), home = path.join(w.dir, 'owner'), own = path.join(path.resolve(personalDirectory()), 'grok-home-full'), owner = { PATH: '/bin', HOME: home };
  fs.mkdirSync(path.join(home, '.config', 'gh'), { recursive: true }); fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Owner\n'); fs.mkdirSync(own, { recursive: true });
  const full = agentEnv(owner, [], { HOME: own }, { full: true });
  assert.equal(full.HOME, own); assert.equal(full.GIT_CONFIG_GLOBAL, undefined); assert.equal(full.GH_CONFIG_DIR, undefined);
  // What the owner set himself is his environment, and comes along.
  const set = agentEnv({ ...owner, GIT_CONFIG_GLOBAL: '/etc/mine', GH_CONFIG_DIR: '/etc/gh' }, [], { HOME: own }, { full: true }); assert.equal(set.GIT_CONFIG_GLOBAL, '/etc/mine'); assert.equal(set.GH_CONFIG_DIR, '/etc/gh');
});

test('one Claude run that ends several turns is read by its last answer; what follows that answer does not undo it', () => {
  const init = { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-fable-5-2', permissionMode: 'bypassPermissions', mcp_servers: [] };
  const result = (summary, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, session_id: SESSION, total_cost_usd: 0.1, structured_output: { outcome: 'done', summary }, ...extra });
  const stream = rows => rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n');
  const read = rows => readClaude(stream(rows), { validate: value => value });
  // The rows a helper and a watcher left running in the background write, between two turns.
  const background = [{ type: 'system', subtype: 'task_started', task_id: 't1', task_type: 'local_agent', description: 'audit' }, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', task_type: 'local_agent', description: 'audit' }] },
    { type: 'tool_progress', tool_use_id: 'toolu_1', parent_tool_use_id: 'toolu_0', elapsed_time_seconds: 30 }, { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'audit done' }, { type: 'system', subtype: 'task_updated', task_id: 't1' }];
  const two = read([init, result('started the audit'), ...background, { type: 'assistant', message: { content: [{ type: 'text', text: 'The audit finished.' }] } }, result('the audit finished', { total_cost_usd: 0.4 })]);
  assert.equal(two.result.summary, 'the audit finished', 'the last answer is the reply'); assert.equal(two.costUsd, 0.4, 'the run cost what its last result line says'); assert.equal(two.session, SESSION);
  // A later turn that failed, or that answered nothing, leaves the answer before it standing.
  assert.equal(read([init, result('answered'), ...background, { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: SESSION, total_cost_usd: 0.2 }]).result.summary, 'answered');
  assert.equal(read([init, result('answered'), { type: 'result', subtype: 'success', is_error: false, session_id: SESSION, result: 'Background work finished.' }]).result.summary, 'answered');
  // Stopped while it waited: the line it was writing is cut off after the answer.
  assert.equal(read([init, result('answered'), ...background, '{"type":"system","subtype":"task_not']).result.summary, 'answered');
  // Each turn's refusals are read once.
  const denial = id => ({ tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: id });
  assert.deepEqual(read([init, result('one', { permission_denials: [denial('a')] }), result('two', { permission_denials: [denial('a'), denial('b')] })]).denials.map(row => row.tool_use_id), ['a', 'b']);
  // One turn, as before: a broken line ahead of the answer, no result, or a failed one is refused.
  assert.throws(() => read([init, '{"type":"assist', result('answered')]), /incomplete or malformed JSON stream/);
  assert.throws(() => read([init, ...background]), /incomplete or malformed JSON stream/);
  assert.throws(() => read([init, { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: SESSION }]), /Claude could not finish/);
  assert.throws(() => read([init, { type: 'result', subtype: 'success', is_error: false, session_id: SESSION, result: 'not JSON' }]), /Claude returned no JSON run result/);
});

test('a Full access run fails none of the three structural checks: what they find is kept as a note', t => {
  const dir = temp(t), root = path.join(dir, 'repo'); fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  git(root, ['init', '--initial-branch=main']); git(root, ['config', 'user.name', 'T']); git(root, ['config', 'user.email', 't@example.invalid']);
  fs.writeFileSync(path.join(root, '.gitignore'), '*.local\n'); fs.writeFileSync(path.join(root, 'test/a.test.mjs'), 'export {};\n'); fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/a.mjs'), 'export const a = 1;\n');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'init']);
  const base = git(root, ['rev-parse', 'HEAD']), config = { ...defaultConfig(), paths: ['src/**'] }, task = { worktree: root, base, place: { kind: 'worktree' } };
  fs.rmSync(path.join(root, 'test/a.test.mjs')); fs.writeFileSync(path.join(root, 'src/keys.local'), 'x\n'); fs.writeFileSync(path.join(root, 'notes.md'), 'outside the declared paths\n');
  const rows = mode => Object.fromEntries(checks.structuralChecks(task, config, { mode }).results.map(row => [row.name, row]));
  const full = rows('full');
  for (const name of ['no-ignored-output', 'declared-paths', 'no-deleted-tests']) { assert.equal(full[name].status, 'noted', name); assert.ok(full[name].details.length, `${name} says what it found`); assert.equal(checks.checkPassed(full[name]), true); }
  assert.deepEqual(full['no-deleted-tests'].details, ['test/a.test.mjs']); assert.ok(full['declared-paths'].details.includes('notes.md'));
  assert.equal(Object.values(full).every(checks.checkPassed), true, 'nothing of ELU\'s stops a Full access run');
  for (const mode of ['ask', 'auto']) { const lower = rows(mode); for (const name of ['no-ignored-output', 'declared-paths', 'no-deleted-tests']) { assert.equal(lower[name].status, 'failed', `${mode} ${name}`); assert.equal(checks.checkPassed(lower[name]), false); } }
  // With nothing to find they pass, as in every mode.
  git(root, ['checkout', '-q', '--', '.']); fs.rmSync(path.join(root, 'src/keys.local')); fs.rmSync(path.join(root, 'notes.md'));
  for (const name of ['no-ignored-output', 'declared-paths', 'no-deleted-tests']) assert.equal(rows('full')[name].status, 'passed', name);
});

test('the folders a teammate\'s message names are offered as the mode takes them, and leaving Full access keeps only what the other modes take', t => {
  const dir = fs.realpathSync(temp(t)), home = path.join(dir, 'home'), previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') }); t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const ssh = path.join(home, '.ssh'), evals = path.join(home, 'evals'), outside = path.join(dir, 'srv'), many = Array.from({ length: 10 }, (_, i) => path.join(home, `work${i}`));
  for (const folder of [ssh, evals, outside, ...many]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(ssh, 'config'), ''); fs.writeFileSync(path.join(evals, 'run.log'), '');
  const text = `see ${evals}/run.log, ${ssh}/config and ${outside} and /nowhere/x`;
  assert.deepEqual(foldersNamed(text), [evals], 'no mode: the strict check'); for (const mode of ['ask', 'auto']) assert.deepEqual(foldersNamed(text, { mode }), [evals], mode);
  assert.deepEqual(foldersNamed(text, { mode: 'full' }), [evals, ssh, outside], 'Full access offers every folder there is');
  const long = many.join(' ');
  assert.equal(foldersNamed(long, { mode: 'ask' }).length, 8); assert.equal(foldersNamed(long, { mode: 'full' }).length, 10, 'and as many as the message names');
  assert.deepEqual(modes.foldersBelowFull([evals, ssh, outside, home]), [evals]); assert.equal(modes.foldersBelowFull(many).length, 8); assert.deepEqual(modes.foldersBelowFull(undefined), []);
});
