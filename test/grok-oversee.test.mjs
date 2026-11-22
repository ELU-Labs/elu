import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as grok from '../lib/adapters/grok.mjs';
import { APPROVAL_SERVER, approvalServer } from '../lib/mcp.mjs';
import { OVERSEE_FULL } from '../lib/orchestrator-seams.mjs';
import { OVERSEE_DENIED } from '../lib/approval-server.mjs';
import { answerApproval, pendingApprovals, readApprovalLog } from '../lib/approvals.mjs';
import { setLevel } from '../lib/orchestrator-settings.mjs';
import { APPROVAL_WAIT_SECONDS } from '../lib/modes.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { fakeClis, temp } from './helpers.mjs';

// The turn of a bot that oversees, and a bot's MCP servers, on Grok Build: ELU's own MCP server
// with the same server, arguments and environment Claude Code is given, and ELU's relay as the
// run's hook, which answers each call with the same table (lib/approval-server.mjs overseeing).
// A launch with neither is the one it was, to the byte (test/conformance-grok.test.mjs).

const SESSION = '12345678-1234-4234-8234-123456789abc', GROK = fileURLToPath(new URL('../lib/adapters/grok.mjs', import.meta.url));
function world(t) {
  const dir = temp(t), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  const f = fakeClis(dir), repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  const runDir = path.join(dir, 'run'); fs.mkdirSync(runDir);
  atomic(path.join(personalDirectory(), 'conformance', 'grok.json'), { v: 1, bin: path.join(f.dir, 'grok'), version: '1.0.77', steps: Object.fromEntries(grok.conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });
  return { dir, repo, runDir, log: path.join(runDir, 'approvals.jsonl') };
}
// The run's MCP file as lib/mcp.mjs writeServers writes it: the owner's servers, and for a turn
// that oversees ELU's own, started for that turn (approvalServer).
function servers(w, { oversee = true, mode = 'auto', owner = { docs: { command: '/usr/bin/docs-mcp', args: ['--stdio'], env: { DOCS_TOKEN: 'kept-in-the-file' } } } } = {}) {
  const picked = { ...owner, ...(oversee ? { [APPROVAL_SERVER]: approvalServer({ session: SESSION, root: w.repo, taskId: '1', role: 'bot:orchestrator', vendor: 'grok', log: w.log, cwd: w.repo, access: 'read', rules: 'defaults', mode, oversee: 'orchestrator', servers: Object.keys(owner) }) } : {}) };
  const folder = fs.mkdtempSync(path.join(personalDirectory(), `mcp-${process.pid}-`)), file = path.join(folder, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: picked }), { mode: 0o600 });
  return { file, folder, names: Object.keys(picked) };
}
const role = (access = 'read') => ({ vendor: 'grok', access, writablePaths: access === 'edit' ? ['.'] : [], commands: [], network: 'off', maxCostUsd: null, timeoutSeconds: 120 });
const after = (args, flag) => args[args.indexOf(flag) + 1];
const valuesOf = (args, flag) => args.flatMap((arg, i) => arg === flag ? [args[i + 1]] : []);
// The agent definition's frontmatter: its YAML is written as JSON values, one per line.
function definition(file) {
  const text = fs.readFileSync(file, 'utf8'), [, front, body] = text.split(/^---$/m);
  const servers = Object.fromEntries(front.split('\n').filter(line => /^ {2}- "/.test(line)).map(line => Object.entries(JSON.parse(`{${line.slice(4)}}`))[0]));
  const hookLine = front.split('\n').find(line => /^ {8}- \{/.test(line));
  return { text, front, body: body.trim(), servers, hook: hookLine ? JSON.parse(hookLine.slice(10)) : null };
}

test('a launch without MCP servers or a bot that oversees is the one it was', t => {
  const w = world(t);
  for (const mode of ['locked', 'ask', 'auto', 'full']) {
    const base = { role: role(mode === 'locked' ? 'read' : 'edit'), mode, cwd: w.repo, session: SESSION, runDir: w.runDir };
    const plain = grok.compile(base);
    assert.deepEqual(grok.compile({ ...base, mcp: null, oversee: false, [OVERSEE_FULL]: false }), plain, mode);
    assert.deepEqual(grok.compile({ ...base, mcp: { file: '/nowhere/mcp.json', folder: '/nowhere', names: [] } }), plain, `${mode}: no server named, nothing read`);
    assert.ok(!plain.includes('--agent'), mode);
  }
  // Read only keeps every MCP tool denied, servers or not.
  const locked = { role: role('read'), mode: 'locked', cwd: w.repo, session: SESSION, runDir: w.runDir };
  assert.deepEqual(grok.compile({ ...locked, mcp: servers(w, { oversee: false }) }), grok.compile(locked));
});

test("a bot's MCP servers reach its run in a definition of the run's own, each allowed by name", t => {
  const w = world(t), mcp = servers(w, { oversee: false });
  for (const mode of ['ask', 'auto', 'full']) {
    const base = { role: role('edit'), mode, cwd: w.repo, session: SESSION, runDir: w.runDir }, plain = grok.compile(base), args = grok.compile({ ...base, mcp });
    const agent = path.join(mcp.folder, 'grok-agent.md');
    assert.deepEqual(args, [...plain.slice(0, -2), '--agent', agent, ...(mode === 'full' ? [] : ['--allow', 'MCPTool(docs__*)']), '-s', SESSION], mode);
    const { servers: listed, hook, body } = definition(agent);
    assert.deepEqual(listed, { docs: { command: '/usr/bin/docs-mcp', args: ['--stdio'], env: { HOME: os.homedir(), DOCS_TOKEN: 'kept-in-the-file' } } }, 'the server as Claude Code has it, with the owner\'s home');
    assert.equal(hook, null, 'no relay: a bot that does not oversee keeps its run\'s own rules');
    assert.match(body, /mcp__SERVER__TOOL there is SERVER__TOOL here/);
    assert.ok(!args.join(' ').includes('kept-in-the-file'), 'a server\'s settings never reach the command line');
    assert.equal(fs.statSync(agent).mode & 0o777, 0o600);
  }
  assert.throws(() => grok.compile({ role: role('edit'), mode: 'ask', cwd: w.repo, session: SESSION, runDir: w.runDir, mcp: servers(w) }), /runs only in the turn of a bot that oversees/);
});

test('the turn that oversees below the Full level has ELU\'s server and its relay, and no shell, edit or subagent', t => {
  const w = world(t);
  for (const mode of ['ask', 'auto', 'full']) {
    const mcp = servers(w, { mode }), args = grok.compile({ role: role('read'), mode, cwd: w.repo, session: SESSION, runDir: w.runDir, mcp, oversee: true });
    assert.equal(after(args, '--permission-mode'), 'dontAsk', mode);
    assert.equal(after(args, '--sandbox'), 'off', `${mode}: ELU's server writes ELU's records, as no MCP server is sandboxed on Claude Code`);
    assert.equal(after(args, '--tools'), 'read_file,grep,list_dir,web_search,web_fetch', mode);
    assert.equal(after(args, '--disallowed-tools'), 'run_terminal_command,search_replace,write,spawn_subagent', mode);
    for (const flag of ['--no-memory', '--no-subagents']) assert.ok(args.includes(flag), `${mode}: ${flag}, in Full access too`);
    assert.equal(after(args, '--max-turns'), '40', mode);
    assert.deepEqual(valuesOf(args, '--allow'), ['Read', 'Grep', 'WebFetch', 'WebSearch', 'MCPTool(docs__*)', `MCPTool(${APPROVAL_SERVER}__*)`], mode);
    const denied = valuesOf(args, '--deny');
    assert.deepEqual(denied.slice(0, 4), ['Bash', 'Edit', 'Write', `MCPTool(${APPROVAL_SERVER}__approve)`], mode);
    assert.ok(denied.some(rule => rule.startsWith('Read(') && rule.includes(path.join(os.homedir(), '.ssh'))), `${mode}: secrets stay unreadable`);
    assert.deepEqual(args.slice(-2), ['-s', SESSION]);
    // ELU's own server: the same program, arguments and environment as Claude Code's launch.
    const own = JSON.parse(fs.readFileSync(mcp.file, 'utf8')).mcpServers[APPROVAL_SERVER], { servers: listed, hook, body } = definition(after(args, '--agent'));
    assert.deepEqual(listed[APPROVAL_SERVER], { command: own.command, args: own.args, env: { HOME: os.homedir(), ...own.env } }, mode);
    assert.ok(own.args.includes('--oversee') && own.args.includes('orchestrator'));
    // The relay: every tool call, the turn's subagents' too, decided before it runs; a failed hook denies.
    assert.deepEqual({ command: hook.command, args: hook.args.slice(0, 2), env: hook.env, failClosed: hook.failClosed }, { command: process.execPath, args: [GROK, 'relay'], env: own.env, failClosed: true }, mode);
    assert.ok(hook.timeout > APPROVAL_WAIT_SECONDS, 'it outlasts the owner\'s answer');
    const run = JSON.parse(fs.readFileSync(hook.args[2], 'utf8'));
    assert.deepEqual([run.session, run.root, run.task, run.role, run.oversee, run.mode, run.log, run.wait, run.servers], [SESSION, w.repo, '1', 'bot:orchestrator', 'orchestrator', mode, w.log, APPROVAL_WAIT_SECONDS, ['docs']], mode);
    assert.ok(run.kept.includes(personalDirectory()), "ELU's own folder stays protected");
    assert.match(body, /ELU decides each MCP call/);
  }
  const ask = { role: role('read'), mode: 'ask', cwd: w.repo, session: SESSION, runDir: w.runDir };
  assert.throws(() => grok.compile({ ...ask, oversee: true }), /needs their private file/);
  assert.throws(() => grok.compile({ ...ask, mcp: servers(w, { oversee: false }), oversee: true }), /needs ELU's own MCP server/);
  assert.throws(() => grok.compile({ ...ask, role: role('edit'), mcp: servers(w), oversee: true }), /never edits/);
  assert.throws(() => grok.compile({ ...ask, mode: 'locked', mcp: servers(w), oversee: true }), /with permissions/);
  assert.throws(() => grok.compile({ ...ask, mcp: servers(w), oversee: true, [OVERSEE_FULL]: true }), /runs in Full access/);
});

test('at the Full level the turn that oversees has Full access, with the relay on every call', t => {
  const w = world(t), mcp = servers(w, { mode: 'full' }), base = { role: role('edit'), mode: 'full', cwd: w.repo, session: SESSION, runDir: w.runDir };
  const args = grok.compile({ ...base, mcp, oversee: true, [OVERSEE_FULL]: true, commonDir: path.join(w.repo, '.git') });
  assert.deepEqual(args, [...grok.compile(base).slice(0, -2), '--agent', path.join(mcp.folder, 'grok-agent.md'), '-s', SESSION]);
  const { hook } = definition(after(args, '--agent')), run = JSON.parse(fs.readFileSync(hook.args[2], 'utf8'));
  assert.ok(run.kept.includes(path.join(fs.realpathSync(path.join(w.repo, '.git')), 'elu-code')), "ELU's records of every session in the Git folder too");
});

test('a turn that oversees in a Full access session below the Full level keeps every limit', t => {
  world(t);
  const below = grok.childEnv({ mode: 'full', home: os.homedir(), oversee: true }), at = grok.childEnv({ mode: 'full', home: os.homedir(), oversee: true, [OVERSEE_FULL]: true });
  assert.deepEqual(below, grok.childEnv({ mode: 'auto', home: os.homedir() }), 'the home and config of Approve for me');
  assert.equal(below.GROK_BACKEND_SEARCH, '0'); assert.equal(below.GROK_SUBAGENTS, '0');
  assert.deepEqual(at, grok.childEnv({ mode: 'full', home: os.homedir() }));
  for (const mode of ['ask', 'auto']) assert.deepEqual(grok.childEnv({ mode, home: os.homedir(), oversee: true }), grok.childEnv({ mode, home: os.homedir() }), mode);
});

// The relay with the table stubbed: what it decides itself, and what it hands the table.
const event = (toolName, toolInput, extra = {}) => ({ hookEventName: 'pre_tool_use', toolName, toolInput, toolUseId: `call-${crypto.randomUUID()}`, toolInputTruncated: false, ...extra });
function relayRun(w, extra = {}) {
  const mcp = servers(w, { mode: extra.mode ?? 'full' }), args = grok.compile({ role: role(extra.full === false ? 'read' : 'edit'), mode: extra.mode ?? 'full', cwd: w.repo, session: SESSION, runDir: w.runDir, mcp, oversee: true, ...(extra.full === false ? {} : { [OVERSEE_FULL]: true }), commonDir: path.join(w.repo, '.git') });
  const { hook } = definition(after(args, '--agent'));
  return { file: hook.args[2], run: JSON.parse(fs.readFileSync(hook.args[2], 'utf8')) };
}
test('the relay names each Grok tool as the table knows it, and decides only what Claude Code asks it', async t => {
  const w = world(t), { run } = relayRun(w), asked = [];
  const overseeing = async (tool, input, opts) => { asked.push({ tool, input, opts }); return { decision: 'allow', by: 'default', rule: 'r', summary: `Use ${tool}` }; };
  assert.deepEqual(await grok.relayAnswer(event('read_file', { file_path: '/etc/hosts' }), run, { overseeing }), { decision: 'allow' });
  assert.deepEqual(await grok.relayAnswer(event('todo_write', {}), run, { overseeing }), { decision: 'allow' });
  assert.equal(asked.length, 0, 'a read is left to the run\'s own rules');
  for (const [name, tool] of [['elu-code-approval__sessions_list', 'mcp__elu-code-approval__sessions_list'], ['docs__search', 'mcp__docs__search'], ['run_terminal_command', 'Bash'], ['search_replace', 'Edit'], ['write', 'Write'], ['web_fetch', 'WebFetch'], ['web_search', 'WebSearch']]) {
    const input = name === 'run_terminal_command' ? { command: 'npm test' } : ['search_replace', 'write'].includes(name) ? { file_path: path.join(w.repo, 'a.txt') } : { q: 'x' };
    assert.deepEqual(await grok.relayAnswer(event(name, input), run, { overseeing }), { decision: 'allow' }, name);
    assert.equal(asked.at(-1).tool, tool, name);
  }
  const { opts } = asked[0];
  assert.deepEqual([opts.bot, opts.mode, opts.taskId, opts.role, opts.vendor, opts.run, opts.waitSeconds, opts.servers], ['orchestrator', 'full', '1', 'bot:orchestrator', 'grok', SESSION, APPROVAL_WAIT_SECONDS, ['docs']]);
  assert.match(opts.id, new RegExp(`^${SESSION}-call-`));
  assert.equal(readApprovalLog(w.log).length, 7, 'each row as Claude Code\'s relay writes it');
  // What it refuses itself: the owner's own tool, a cut input, and ELU's own folder and records.
  assert.equal((await grok.relayAnswer(event(`${APPROVAL_SERVER}__approve`, {}), run, { overseeing })).decision, 'deny');
  assert.equal((await grok.relayAnswer(event('run_terminal_command', { command: 'echo x [truncated]' }, { toolInputTruncated: true }), run, { overseeing })).decision, 'deny');
  for (const [name, input] of [['run_terminal_command', { command: `ls ${personalDirectory()}` }], ['run_terminal_command', { command: 'cat .git/elu-code/tasks/1.json' }], ['write', { file_path: path.join(personalDirectory(), 'orchestrator.json') }], ['search_replace', { file_path: '.git/elu-code/tasks/1.json' }]]) {
    const out = await grok.relayAnswer(event(name, input), run, { overseeing });
    assert.equal(out.decision, 'deny', input.command ?? input.file_path); assert.match(out.reason, /ELU's own folder/);
  }
  assert.equal(asked.length, 7);
  // An answer that is not a yes reaches the model as the table words it.
  const no = async () => ({ decision: 'deny', summary: 'Run: git tag v1', message: 'The owner declined this.' });
  assert.deepEqual(await grok.relayAnswer(event('run_terminal_command', { command: 'git tag v1' }), run, { overseeing: no }), { decision: 'deny', reason: 'The owner declined this.' });
  const broken = async () => { throw new Error('gone'); };
  assert.equal((await grok.relayAnswer(event('docs__search', {}), run, { overseeing: broken })).decision, 'deny');
});

test('the relay asks the owner for a command of the ask list at the Full level, and refuses a shell below it', async t => {
  const w = world(t); setLevel('full', { by: 'owner' });
  const { run } = relayRun(w), turn = grok.relayAnswer(event('run_terminal_command', { command: 'git tag v1.0.0' }), { ...run, wait: 30 });
  let waiting = [];
  for (let i = 0; i < 100 && !waiting.length; i++) { await new Promise(resolve => setTimeout(resolve, 50)); waiting = pendingApprovals(); }
  assert.equal(waiting.length, 1, 'the owner is asked through ELU, as on Claude Code');
  assert.equal(waiting[0].oversee, true); assert.match(waiting[0].summary, /git tag v1\.0\.0/);
  answerApproval(waiting[0].id, 'deny');
  const out = await turn;
  assert.equal(out.decision, 'deny'); assert.match(out.reason, /declined/);
  assert.equal((await grok.relayAnswer(event('run_terminal_command', { command: 'npm test' }), run)).decision, 'allow', 'any other command runs, as in Full access');
  const below = relayRun(w, { mode: 'auto', full: false }).run, shell = await grok.relayAnswer(event('run_terminal_command', { command: 'npm test' }), { ...below, mode: 'auto' });
  setLevel('act', { by: 'owner' });
  const lowered = await grok.relayAnswer(event('run_terminal_command', { command: 'npm test' }), run);
  assert.deepEqual([shell, lowered], [{ decision: 'deny', reason: OVERSEE_DENIED }, { decision: 'deny', reason: OVERSEE_DENIED }], 'and once he lowers the level, its next command is refused');
});

test('the relay hook runs as Grok runs it: the call on stdin, the decision on stdout', t => {
  const w = world(t), { file } = relayRun(w, { mode: 'auto', full: false });
  const hook = value => { const r = spawnSync(process.execPath, [GROK, 'relay', file], { input: JSON.stringify(value), encoding: 'utf8', env: { ...process.env }, timeout: 30000 }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  assert.deepEqual(hook(event('read_file', { file_path: '/etc/hosts' })), { decision: 'allow' });
  assert.deepEqual(hook(event(`${APPROVAL_SERVER}__sessions_list`, {})), { decision: 'allow' }, "ELU's own tools, as the level decides when they run");
  assert.equal(hook(event('run_terminal_command', { command: 'npm test' })).decision, 'deny');
  assert.equal(hook('not json').decision, 'deny', 'what it cannot read it refuses');
  const rows = readApprovalLog(w.log);
  // A command below the Full level is no tool of that launch, as on Claude Code: refused with no row.
  assert.deepEqual(rows.map(row => [row.tool, row.decision, row.by ?? null]), [[`mcp__${APPROVAL_SERVER}__sessions_list`, 'allow', 'default']]);
});

test('the instructions reach the run whole in its prompt file, and rules too long for a command line are refused', t => {
  const w = world(t), instructions = `You are @orchestrator. ${'Oversee the sessions. '.repeat(20000)}`;
  grok.prepareInput(instructions, { runDir: w.runDir });
  const args = grok.compile({ role: role('read'), mode: 'auto', cwd: w.repo, session: SESSION, runDir: w.runDir, mcp: servers(w), oversee: true });
  assert.ok(fs.readFileSync(after(args, '--prompt-file'), 'utf8').startsWith(instructions));
  assert.ok(Buffer.byteLength(args.join(' ')) < grok.ARGV_LIMIT, 'nothing of it on the command line');
  const many = Array.from({ length: 1500 }, (_, i) => `packages/p${i}/package.json`);
  assert.throws(() => grok.compile({ role: role('edit'), mode: 'ask', cwd: w.repo, session: SESSION, runDir: w.runDir, protectedPaths: many }), /KiB of rules on its command line/);
  assert.ok(grok.compile({ role: role('edit'), mode: 'ask', cwd: w.repo, session: SESSION, runDir: w.runDir, protectedPaths: many.slice(0, 50) }).length > 0);
});

test('over ACP no turn with MCP servers or of a bot that oversees runs', async t => {
  world(t);
  await assert.rejects(grok.run({ mode: 'ask', oversee: true }), /runs headless, never over ACP/);
  await assert.rejects(grok.run({ mode: 'auto', mcp: { names: ['docs'] } }), /runs headless, never over ACP/);
});
