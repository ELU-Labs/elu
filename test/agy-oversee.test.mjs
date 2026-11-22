import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as agy from '../lib/adapters/agy.mjs';
import { NO_RELAY, OVERSEE_REFUSED, OWN_REFUSED, PROMPT_REFUSED, decideOversee, relayCall } from '../lib/agy-hook.mjs';
import { APPROVAL_SERVER, writeServers } from '../lib/mcp.mjs';
import { APPROVAL_WAIT_SECONDS } from '../lib/modes.mjs';
import { resultSchema } from '../lib/config.mjs';
import { personalDirectory } from '../lib/util.mjs';
import { OVERSEE_FULL } from '../lib/orchestrator-seams.mjs';
import { FAKES } from './helpers.mjs';

// The turn of the bot that oversees the owner's sessions on Antigravity (lib/adapters/agy.mjs
// overseeLaunch, lib/agy-hook.mjs decideOversee), held to what Claude Code's turn of it gets.
const HOOK = fileURLToPath(new URL('../lib/agy-hook.mjs', import.meta.url));
const lead = { vendor: 'agy', access: 'edit', network: 'off', commands: [], writablePaths: ['.'], timeoutSeconds: 900, maxCostUsd: null };
const reader = { ...lead, access: 'read', writablePaths: [] };
function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-agy-oversee-'))), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function repo(dir) {
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  const git = args => { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
  git(['init', '-q', '--initial-branch=main']); git(['config', 'user.name', 'T']); git(['config', 'user.email', 't@example.invalid']);
  fs.writeFileSync(path.join(root, 'README.md'), '# repo\n'); git(['add', '.']); git(['commit', '-qm', 'init']);
  return root;
}
const schemaAt = dir => { const file = path.join(dir, 'schema.json'); fs.writeFileSync(file, JSON.stringify(resultSchema())); return file; };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const filesOf = at => ({ settings: path.join(at, '.gemini', 'antigravity-cli', 'settings.json'), hooks: path.join(at, '.gemini', 'config', 'hooks.json'), mcp: path.join(at, '.gemini', 'config', 'mcp_config.json'), policy: path.join(at, '.gemini', 'config', 'elu-oversee.json') });
// The servers the runner writes for Claude Code's turn of the Orchestrator: ELU's approval relay, under --oversee.
function relayServers(cwd, { mode, log }) {
  return writeServers([], cwd, { approval: { session: crypto.randomUUID(), root: cwd, taskId: '1', role: 'bot:orchestrator', vendor: 'agy', log, cwd, access: 'read', rules: 'saved', sandboxed: false, mode, folders: [], common: path.join(cwd, '.git'), oversee: 'orchestrator' } });
}
function world(t) {
  const dir = home(t), cwd = repo(dir), schemaFile = schemaAt(dir), log = path.join(dir, 'approvals.jsonl');
  const base = { cwd, protectedPaths: ['.git'], commonDir: path.join(cwd, '.git'), schemaFile };
  return { dir, cwd, schemaFile, log, base };
}

test('a launch that does not oversee is built as before, to the byte, in the workspace\'s own HOME, and an overseeing launch leaves that HOME as it was', t => {
  const w = world(t), own = filesOf(agy.privateHome({ cwd: w.cwd }));
  const common = ['-p', '', '--input-format', 'stream-json', '--output-format', 'stream-json', '--json-schema', w.schemaFile, '--print-timeout', '2000000s'];
  const before = {};
  for (const mode of ['locked', 'ask', 'auto', 'full']) {
    const argv = agy.launch({ ...w.base, role: mode === 'locked' ? reader : lead, mode, place: mode === 'full' ? { kind: 'here' } : { kind: 'worktree' } });
    assert.deepEqual(argv, [...common, ...{ locked: ['--sandbox'], ask: [], auto: ['--mode=accept-edits', '--sandbox'], full: ['--dangerously-skip-permissions'] }[mode]], mode);
    assert.equal(fs.existsSync(own.mcp), false, `${mode}: no MCP server is written where none was given`);
    before[mode] = { settings: fs.readFileSync(own.settings, 'utf8'), hooks: fs.readFileSync(own.hooks, 'utf8') };
  }
  // The overseeing launches write their HOME of their own; the workspace's keeps the last launch's files, byte for byte.
  agy.launch({ ...w.base, role: reader, mode: 'auto', oversee: true, mcp: relayServers(w.cwd, { mode: 'auto', log: w.log }) });
  agy.launch({ ...w.base, role: lead, mode: 'full', place: { kind: 'here' }, oversee: true, [OVERSEE_FULL]: true, mcp: relayServers(w.cwd, { mode: 'full', log: w.log }) });
  assert.equal(fs.readFileSync(own.settings, 'utf8'), before.full.settings); assert.equal(fs.readFileSync(own.hooks, 'utf8'), before.full.hooks); assert.equal(fs.existsSync(own.mcp), false);
  assert.equal(agy.homeKind({}), null); assert.equal(agy.homeKind({ mcp: { names: [] } }), null);
  assert.equal(agy.privateHome({ cwd: w.cwd, kind: agy.homeKind({ oversee: true }) }), `${agy.privateHome({ cwd: w.cwd })}-oversee`);
});

test('a turn given MCP servers gets them in mcp_config.json of a HOME of its own, the same command, arguments and environment as Claude Code\'s launch, with the same argv', t => {
  const w = world(t);
  const claudeFile = path.join(w.dir, 'claude-servers.json');
  fs.writeFileSync(claudeFile, JSON.stringify({ mcpServers: { elu: { type: 'stdio', command: '/usr/bin/env', args: ['elu-mcp', '--org', 'x'], env: { ELU_TOKEN: 'from-env' } }, web: { type: 'http', url: 'https://mcp.example.invalid/mcp', headers: { Authorization: 'Bearer t' } }, 'bad name': { command: 'x' } } }), { mode: 0o600 });
  const mcp = { file: claudeFile, names: ['elu', 'web'] };
  const plain = agy.launch({ ...w.base, role: lead, mode: 'auto' });
  const given = agy.launch({ ...w.base, role: lead, mode: 'auto', mcp });
  assert.deepEqual(given, plain, 'the servers are never on argv');
  const kind = agy.homeKind({ mcp }), at = agy.privateHome({ cwd: w.cwd, kind });
  assert.match(kind, /^mcp-[0-9a-f]{8}$/); assert.equal(agy.homeKind({ mcp: { names: ['web', 'elu'] } }), kind, 'the same servers in another order are the same HOME');
  assert.deepEqual(json(filesOf(at).mcp), { mcpServers: {
    elu: { command: '/usr/bin/env', args: ['elu-mcp', '--org', 'x'], env: { HOME: os.homedir(), ELU_TOKEN: 'from-env' }, disabled: false },
    web: { serverUrl: 'https://mcp.example.invalid/mcp', headers: { Authorization: 'Bearer t' }, disabled: false },
  } });
  assert.equal(fs.statSync(filesOf(at).mcp).mode & 0o777, 0o600);
  // Both HOMEs hold this launch's rules: a run started in the workspace's own still keeps them.
  assert.deepEqual(json(filesOf(at).settings), json(filesOf(agy.privateHome({ cwd: w.cwd })).settings));
  assert.equal(agy.childEnv({ mode: 'auto', cwd: w.cwd, mcp }).HOME, at); assert.equal(agy.childEnv({ mode: 'auto', cwd: w.cwd }).HOME, agy.privateHome({ cwd: w.cwd }));
});

test('below the level Full the overseeing turn has ELU\'s relay and MCP tools, reads files, and has no shell and no write, in every mode, Full access too', t => {
  const w = world(t);
  for (const mode of ['ask', 'auto', 'full']) {
    const mcp = relayServers(w.cwd, { mode, log: w.log }), claude = json(mcp.file).mcpServers[APPROVAL_SERVER];
    const argv = agy.launch({ ...w.base, role: reader, mode, place: mode === 'full' ? { kind: 'here' } : { kind: 'worktree' }, oversee: true, mcp });
    assert.equal(argv.some(arg => /dangerously|skip-permissions|accept-edits/.test(arg)), false, mode);
    const at = agy.privateHome({ cwd: w.cwd, kind: 'oversee' }), files = filesOf(at);
    assert.equal(agy.childEnv({ mode, cwd: w.cwd, oversee: true }).HOME, at, `${mode}: the private HOME, never the mirror of the owner's`);
    // The same server, arguments and environment as Claude Code's launch of it.
    const server = json(files.mcp).mcpServers[APPROVAL_SERVER];
    assert.deepEqual(server, { command: claude.command, args: claude.args, env: { HOME: os.homedir(), ...claude.env }, disabled: false }, mode);
    assert.ok(server.args.includes('--oversee') && server.args.includes('orchestrator'));
    const settings = json(files.settings);
    assert.deepEqual(settings.permissions, { allow: ['mcp(*)', 'read_url(*)'], deny: ['command(*)', 'write_file(*)', 'execute_url(*)', `mcp(${APPROVAL_SERVER}/approve)`] }, mode);
    assert.equal(settings.allowNonWorkspaceAccess, false); assert.equal(settings.enableTerminalSandbox, true); assert.equal(settings.disableSlashCommands, true);
    const [hook] = json(files.hooks).hooks.PreToolUse;
    assert.equal(hook.matcher, '.*'); assert.equal(hook.hooks[0].timeout, APPROVAL_WAIT_SECONDS + 60, 'the hook waits as long as the relay waits for the owner');
    assert.equal(hook.hooks[0].command, `'${process.execPath}' '${HOOK}' --profile oversee --policy '${files.policy}'`);
    const policy = json(files.policy);
    assert.equal(policy.relay.oversee, 'orchestrator'); assert.equal(policy.relay.log, w.log); assert.equal(policy.relay.task, '1'); assert.equal(policy.relay.wait, APPROVAL_WAIT_SECONDS);
    assert.deepEqual(policy.env, claude.env, 'the hook asks the relay with the environment the relay runs with');
    assert.equal(fs.statSync(files.policy).mode & 0o777, 0o600);
  }
  // What Claude Code's launch refuses, this one refuses.
  assert.throws(() => agy.launch({ ...w.base, role: lead, mode: 'auto', oversee: true }), /never edits/);
  assert.throws(() => agy.launch({ ...w.base, role: reader, mode: 'locked', oversee: true }), /with permissions/);
  assert.throws(() => agy.launch({ ...w.base, role: lead, mode: 'auto', oversee: true, [OVERSEE_FULL]: true }), /Full access/);
  assert.throws(() => agy.launch({ ...w.base, role: lead, mode: 'full', place: { kind: 'here' }, [OVERSEE_FULL]: true }), /bot that oversees/);
});

test('at Full the overseeing turn has a shell and every tool in the owner\'s home, ELU\'s own files are denied to it, and the relay is its only prompt', t => {
  const w = world(t), mcp = relayServers(w.cwd, { mode: 'full', log: w.log });
  const argv = agy.launch({ ...w.base, role: lead, mode: 'full', place: { kind: 'here' }, oversee: true, [OVERSEE_FULL]: true, mcp });
  assert.ok(argv.includes('--dangerously-skip-permissions'));
  const at = agy.privateHome({ cwd: w.cwd, kind: 'oversee' }), files = filesOf(at);
  assert.equal(agy.childEnv({ mode: 'full', cwd: w.cwd, oversee: true, [OVERSEE_FULL]: true }).HOME, `${at}-full`, 'the mirror of the owner\'s home');
  const settings = json(files.settings), state = path.resolve(personalDirectory());
  assert.deepEqual(settings.permissions.allow, ['read_url(*)', 'execute_url(*)', 'mcp(*)']);
  assert.ok(settings.permissions.deny.includes(`write_file(${state}/)`), 'ELU\'s own folder');
  assert.ok(settings.permissions.deny.includes(`write_file(${path.join(w.cwd, '.git', 'elu-code')}/)`), 'ELU\'s records of the sessions');
  assert.ok(settings.permissions.deny.includes(`mcp(${APPROVAL_SERVER}/approve)`));
  const [hook] = json(files.hooks).hooks.PreToolUse;
  assert.match(hook.hooks[0].command, / --profile oversee-full --policy /);
  assert.ok(json(files.policy).own.includes(state));
});

test('every launch keeps argv small: the servers, rules, ELU\'s folders and the prompt are in files and on stdin', t => {
  const w = world(t), many = Array.from({ length: 2000 }, (_, i) => `protected/${'x'.repeat(40)}-${i}`);
  const big = path.join(w.dir, 'big.json');
  fs.writeFileSync(big, JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`s${i}`, { command: '/usr/bin/env', args: Array.from({ length: 50 }, () => 'a'.repeat(100)) }])) }));
  const bytes = argv => argv.reduce((sum, arg) => sum + Buffer.byteLength(arg) + 1, 0);
  assert.ok(bytes(agy.launch({ ...w.base, protectedPaths: many, role: lead, mode: 'auto', mcp: { file: big, names: ['s0', 's1'] } })) < 2048);
  assert.ok(bytes(agy.launch({ ...w.base, protectedPaths: many, role: reader, mode: 'auto', oversee: true, mcp: relayServers(w.cwd, { mode: 'auto', log: w.log }) })) < 2048);
  assert.ok(bytes(agy.launch({ ...w.base, protectedPaths: many, role: lead, mode: 'full', place: { kind: 'here' }, oversee: true, [OVERSEE_FULL]: true, mcp: relayServers(w.cwd, { mode: 'full', log: w.log }) })) < 2048);
  assert.equal(fs.statSync(path.join(agy.privateHome({ cwd: w.cwd, kind: agy.homeKind({ mcp: { names: ['s0', 's1'] } }) }), '.gemini', 'config', 'mcp_config.json')).size > 100_000, true);
});

const call = (name, args) => ({ hookEventName: 'PreToolUse', toolCall: { id: 'call_1', name, args } });
const mcpCall = (server, tool, args = {}) => call('call_mcp_tool', { ServerName: server, ToolName: tool, Arguments: args });
function asker(answer = { decision: 'allow' }) { const asked = []; return { asked, relay: async c => { asked.push({ tool: c.tool, input: c.input }); return typeof answer === 'function' ? answer(c) : answer; } }; }

test('the hook below Full: reads unasked, ELU\'s and a source\'s tools and the web through the relay by Claude Code\'s names, anything else refused', async () => {
  const policy = { mode: 'auto', cwd: '/w', home: '/h', servers: ['elu'], relay: { session: 's' }, own: [], named: [] };
  const { asked, relay } = asker();
  for (const tool of ['read_file', 'view_file', 'list_dir', 'grep_search', 'find_by_name', 'finish']) assert.equal(await decideOversee('oversee', call(tool, { Path: '/w/a' }), policy, { relay }), null, tool);
  assert.equal(await decideOversee('oversee', mcpCall(APPROVAL_SERVER, 'sessions_list'), policy, { relay }), null);
  assert.equal(await decideOversee('oversee', mcpCall('elu', 'ask_elu', { question: 'q' }), policy, { relay }), null);
  assert.equal(await decideOversee('oversee', call('search_web', { query: 'q' }), policy, { relay }), null);
  assert.equal(await decideOversee('oversee', call('read_url_content', { Url: 'https://example.invalid' }), policy, { relay }), null);
  assert.deepEqual(asked, [{ tool: `mcp__${APPROVAL_SERVER}__sessions_list`, input: {} }, { tool: 'mcp__elu__ask_elu', input: { question: 'q' } }, { tool: 'WebSearch', input: { query: 'q' } }, { tool: 'WebFetch', input: { url: 'https://example.invalid' } }]);
  for (const [tool, args] of [['run_command', { CommandLine: 'ls' }], ['write_file', { Path: '/w/a', Content: 'x' }], ['write_to_file', { TargetFile: '/w/a' }], ['replace_file_content', {}], ['invoke_subagent', {}], ['browser_navigate', {}], ['unheard_of', {}]]) {
    assert.deepEqual(await decideOversee('oversee', call(tool, args), policy, { relay }), { decision: 'deny', reason: OVERSEE_REFUSED }, tool);
  }
  assert.equal(asked.length, 4, 'what is refused never reaches the relay');
  assert.deepEqual(await decideOversee('oversee', mcpCall(APPROVAL_SERVER, 'approve'), policy, { relay }), { decision: 'deny', reason: PROMPT_REFUSED });
  // The relay's no (the owner's, the table's, a cap's) is the hook's, with its words.
  assert.deepEqual(await decideOversee('oversee', mcpCall(APPROVAL_SERVER, 'session_start'), policy, { relay: async () => ({ decision: 'deny', message: 'The owner declined this.' }) }), { decision: 'deny', reason: 'The owner declined this.' });
  assert.deepEqual(await decideOversee('oversee', mcpCall(APPROVAL_SERVER, 'session_start'), policy, { relay: async () => ({ decision: 'timeout', message: '' }) }), { decision: 'deny', reason: NO_RELAY });
  // A policy that could not be read refuses every call.
  assert.equal((await decideOversee('oversee', call('read_file', {}), null)).decision, 'deny');
  assert.deepEqual(relayCall('call_mcp_tool', {}), { tool: 'mcp__unknown__unknown', input: {}, server: null, name: null });
});

test('the hook at Full: every tool, a command of the ask list asks the owner through the relay, ELU\'s own files are refused, and without a relay what would ask him is refused', async t => {
  const dir = home(t), state = path.resolve(personalDirectory()), cwd = path.join(dir, 'w'); fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(cwd);
  const policy = { mode: 'full', cwd, home: os.homedir(), servers: [], relay: { session: 's' }, own: [state, path.join(cwd, '.git', 'elu-code')], named: [state] };
  const { asked, relay } = asker(c => /git tag/.test(c.input.command ?? '') ? { decision: 'deny', message: 'The owner declined this.' } : { decision: 'allow' });
  assert.equal(await decideOversee('oversee-full', call('run_command', { CommandLine: 'npm test' }), policy, { relay }), null);
  assert.equal(await decideOversee('oversee-full', call('write_file', { Path: path.join(cwd, 'a.txt'), Content: 'x' }), policy, { relay }), null);
  assert.equal(await decideOversee('oversee-full', call('search_web', { query: 'q' }), policy, { relay }), null);
  assert.deepEqual(asked, [], 'a command no rule looks for runs without asking anyone');
  assert.deepEqual(await decideOversee('oversee-full', call('run_command', { CommandLine: 'git tag v1.2.3' }), policy, { relay }), { decision: 'deny', reason: 'The owner declined this.' });
  assert.equal(await decideOversee('oversee-full', call('run_command', { CommandLine: 'npm publish --dry-run' }), policy, { relay }), null);
  assert.deepEqual(asked, [{ tool: 'Bash', input: { command: 'git tag v1.2.3' } }, { tool: 'Bash', input: { command: 'npm publish --dry-run' } }]);
  for (const args of [{ Path: path.join(state, 'orchestrator.json'), Content: '{}' }, { TargetFile: path.join(cwd, '.git', 'elu-code', 'tasks', '1.json') }, { Path: `${cwd}/../personal/elu-code/x` }, { Path: '../personal/elu-code/x' }]) {
    assert.deepEqual(await decideOversee('oversee-full', call('write_file', args), policy, { relay }), { decision: 'deny', reason: OWN_REFUSED }, JSON.stringify(args));
  }
  assert.deepEqual(await decideOversee('oversee-full', call('run_command', { CommandLine: `echo x > ${state}/mandates.json` }), policy, { relay }), { decision: 'deny', reason: OWN_REFUSED });
  assert.deepEqual(await decideOversee('oversee-full', mcpCall(APPROVAL_SERVER, 'approve'), policy, { relay }), { decision: 'deny', reason: PROMPT_REFUSED });
  // No relay: nothing can reach the owner, so the ask list is refused outright, saying so; the rest runs.
  const alone = { ...policy, relay: null, env: { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } };
  for (const command of ['git tag v1', 'git push --force origin main', 'gh release create v1', 'npm publish']) {
    assert.deepEqual(await decideOversee('oversee-full', call('run_command', { CommandLine: command }), alone), { decision: 'deny', reason: NO_RELAY }, command);
  }
  assert.equal(await decideOversee('oversee-full', call('run_command', { CommandLine: 'rm -f build.log' }), alone), null);
  assert.equal(await decideOversee('oversee-full', call('run_command', { CommandLine: 'npm test' }), alone), null);
});

test('the hook runs as agy runs it: a verdict on stdout, exit 2 on deny, and a missing or unreadable policy refuses', t => {
  const dir = home(t), policy = path.join(dir, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ mode: 'auto', cwd: dir, home: dir, servers: [], relay: null, env: { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }, own: [], named: [] }));
  const hook = (args, event) => spawnSync(process.execPath, [HOOK, ...args], { input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, PATH: process.env.PATH } });
  const ran = hook(['--profile', 'oversee', '--policy', policy], call('run_command', { CommandLine: 'ls' }));
  assert.equal(ran.status, 2); assert.deepEqual(JSON.parse(ran.stdout), { decision: 'deny', reason: OVERSEE_REFUSED });
  const read = hook(['--profile', 'oversee', '--policy', policy], call('read_file', { Path: path.join(dir, 'x') }));
  assert.equal(read.status, 0); assert.equal(read.stdout, '');
  const missing = hook(['--profile', 'oversee', '--policy', path.join(dir, 'none.json')], call('read_file', {}));
  assert.equal(missing.status, 2); assert.equal(JSON.parse(missing.stdout).decision, 'deny');
  const none = hook(['--profile', 'oversee-full'], call('read_file', {}));
  assert.equal(none.status, 2);
});

test('over ACP the overseeing turn below Full never says yes by itself, in a session in Full access too, and never asks the owner a second time; at Full it is answered yes', async t => {
  const dir = home(t), ws = repo(dir), schemaFile = schemaAt(dir), outside = path.join(dir, 'outside'), log = path.join(dir, 'approvals.jsonl');
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  // A vendor that asks about what its rules deny: only ELU's answer stops it.
  fs.writeFileSync(path.join(bin, 'fake.json'), JSON.stringify({ mode: 'normal', calls: path.join(dir, 'calls.jsonl'), inputs: path.join(dir, 'inputs.jsonl'), agy: { asksDenied: true } }));
  fs.writeFileSync(path.join(bin, 'agy'), `#!${process.execPath}\n${fs.readFileSync(path.join(FAKES, 'agy.mjs'), 'utf8')}`, { mode: 0o755 });
  const asked = [], approvals = { request: row => { asked.push(row); return { id: `a-${asked.length}`, summary: row.title }; }, await: async () => 'allow' };
  let n = 0;
  const go = options => agy.run({ bin: path.join(bin, 'agy'), logFile: path.join(dir, `run-${n++}.log`), timeoutSeconds: 60, relay: true, approvals, cwd: ws, protectedPaths: ['.git'], commonDir: path.join(ws, '.git'), schemaFile, session: crypto.randomUUID(), mode: 'full', mcp: relayServers(ws, { mode: 'full', log }), ...options }).then(value => value, error => error);
  const below = await go({ role: reader, oversee: true, prompt: `Create the file ${outside}.below with the text "x". Reply with the summary "below".` });
  assert.equal(fs.existsSync(`${outside}.below`), false, 'a Full access session lifts nothing for it');
  assert.equal(below.details?.cause, 'denied'); assert.deepEqual(asked, [], 'the owner is asked only through the relay, which never allowed this');
  const full = await go({ role: lead, oversee: true, [OVERSEE_FULL]: true, prompt: `Create the file ${outside}.full with the text "x". Reply with the summary "full".` });
  assert.equal(full.result?.summary, 'full'); assert.equal(fs.readFileSync(`${outside}.full`, 'utf8'), 'elu-code\n'); assert.deepEqual(asked, []);
});

test('what agy asks over ACP below Full is answered from the relay\'s log of that call: its allow, its no, and a read', t => {
  const dir = home(t), log = path.join(dir, 'approvals.jsonl'), relayed = { session: 's1', log };
  fs.writeFileSync(log, [{ id: 's1-call_1', decision: 'allow' }, { id: 's1-call_2', decision: 'deny' }, { id: 's2-call_3', decision: 'allow' }, { id: 's1-call_4', decision: 'timeout' }].map(row => JSON.stringify(row)).join('\n') + '\nnot json\n');
  assert.equal(agy.overseeAnswer(relayed, { toolCallId: 'call_1', name: 'call_mcp_tool', kind: 'execute' }), 'allow');
  assert.equal(agy.overseeAnswer(relayed, { toolCallId: 'call_2', name: 'call_mcp_tool', kind: 'execute' }), 'deny');
  assert.equal(agy.overseeAnswer(relayed, { toolCallId: 'call_3', name: 'call_mcp_tool', kind: 'execute' }), 'deny', 'another session\'s answer is not this one\'s');
  assert.equal(agy.overseeAnswer(relayed, { toolCallId: 'call_4', name: 'call_mcp_tool', kind: 'execute' }), 'deny');
  assert.equal(agy.overseeAnswer(relayed, { toolCallId: 'call_5', name: 'run_command', kind: 'execute' }), 'deny');
  assert.equal(agy.overseeAnswer(relayed, { toolCallId: 'call_6', name: 'view_file', kind: 'read' }), 'allow');
  assert.equal(agy.overseeAnswer(null, { toolCallId: 'call_1', name: 'call_mcp_tool', kind: 'execute' }), 'deny');
});

test('the hook and the adapter name ELU\'s approval relay as lib/mcp.mjs does', async () => {
  const { RELAY_SERVER } = await import('../lib/agy-hook.mjs');
  assert.equal(RELAY_SERVER, APPROVAL_SERVER);
});
