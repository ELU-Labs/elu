import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { temp } from './helpers.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import { VENDORS } from '../lib/vendors.mjs';
import { APPROVAL_SERVER, APPROVAL_TOOL, writeServers } from '../lib/mcp.mjs';
import { FULL_ASK_LIST, OVERSEE_FULL } from '../lib/orchestrator-seams.mjs';
import { botWorkRole, getBot } from '../lib/bots.mjs';
import { defaultConfig, resultSchema } from '../lib/config.mjs';
import { overseesOn } from '../lib/runner.mjs';

// The turn of the bot that oversees the owner's sessions (the Orchestrator), on each of the four
// vendors. The owner may switch it to any of them, so lib/runner.mjs builds one launch for it on
// every vendor and hands it to that vendor's adapter, as here: compile with oversee, ELU's own
// MCP server (the approval relay started for that bot, lib/mcp.mjs writeServers) among mcp, and
// at the Full level OVERSEE_FULL in Full access; then childEnv, as the runner calls it. Each
// vendor's launch must hold the same four points:
//   1. ELU's own MCP server is in it: those are the Orchestrator's tools.
//   2. At Full it has a shell.
//   3. Below Full it has none, in every mode of a session with permissions (a launch the adapter
//      refuses to build there runs nothing, which holds too).
//   4. The ask list (FULL_ASK_LIST: publishing, a tag, a release, a workflow run, a force-push,
//      deleting a repository, rm -rf of the home folder) still reaches the owner at Full:
//      through ELU (the relay, or a hook of ELU's that answers each tool call as the relay does),
//      or as rules that ask or deny each entry. Never a launch that just runs them.
// What a launch says is read by READ, one reader for each vendor, in that vendor's own terms:
// a reader changes only with how its vendor spells a launch, never the four points.

const LIB = path.resolve(fileURLToPath(new URL('../lib', import.meta.url)));
const commandOf = rule => rule.replace(/^Bash\(/, '').replace(/(?::\*)?\)$/, '').replace(/\*+$/, '').trim();
const ASK_COMMANDS = FULL_ASK_LIST.map(commandOf);
const valueOf = (args, flag) => { const at = args.lastIndexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const listOf = value => String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
const lastConfig = (args, key) => { let value; for (let at = 0; at < args.length; at++) if (['-c', '--config'].includes(args[at]) && String(args[at + 1]).startsWith(`${key}=`)) value = String(args[at + 1]).slice(key.length + 1); return value; };
const jsonOf = text => { try { return JSON.parse(text); } catch { return null; } };
// A hook of ELU's own that sees each tool call before it runs: a PreToolUse hook whose command
// is one of ELU's own files.
const eluHook = text => /PreToolUse/.test(text) && text.includes(LIB);
// Every entry of the ask list named in the launch, as a rule.
const askRules = text => ASK_COMMANDS.every(command => text.includes(command));

// launch: { args, env, files: { path: text } written by compile and childEnv, text: all of it }.
const READ = {
  claude: {
    settings: launch => jsonOf(valueOf(launch.args, '--settings')) ?? jsonOf(fs.readFileSync(valueOf(launch.args, '--settings'), 'utf8')),
    mcp: (launch, servers) => valueOf(launch.args, '--mcp-config') === servers.file && launch.args.includes('--strict-mcp-config'),
    shell(launch) {
      const deny = READ.claude.settings(launch)?.permissions?.deny ?? [], tools = valueOf(launch.args, '--tools');
      const disallowed = launch.args.flatMap((arg, at) => arg === '--disallowedTools' ? listOf(launch.args[at + 1]) : arg.startsWith('--disallowedTools=') ? listOf(arg.slice(18)) : []);
      return !deny.includes('Bash') && !disallowed.includes('Bash') && (tools === 'default' || listOf(tools).includes('Bash'));
    },
    asks: launch => FULL_ASK_LIST.every(rule => (READ.claude.settings(launch)?.permissions?.ask ?? []).includes(rule)) && valueOf(launch.args, '--permission-prompt-tool') === APPROVAL_TOOL,
  },
  codex: {
    mcp: (launch, servers, relay) => String(lastConfig(launch.args, 'mcp_servers') ?? '').includes(relay.args[0]),
    shell: launch => lastConfig(launch.args, 'features.shell_tool') === 'true',
    asks: launch => lastConfig(launch.args, 'features.hooks') === 'true' && eluHook(launch.args.filter(arg => String(arg).startsWith('hooks.')).join('\n')),
  },
  grok: {
    mcp: (launch, servers, relay) => launch.text.includes(servers.file) || launch.text.includes(relay.args[0]),
    // Its shell tool, by the names its releases gave it.
    shell(launch) {
      const tools = valueOf(launch.args, '--tools'), disallowed = listOf(valueOf(launch.args, '--disallowed-tools')), shells = ['run_terminal_cmd', 'run_terminal_command'];
      return !disallowed.some(name => shells.includes(name)) && (tools === undefined || listOf(tools).some(name => shells.includes(name)));
    },
    asks: launch => eluHook(launch.text) || askRules(launch.text),
  },
  agy: {
    settings: launch => Object.entries(launch.files).filter(([file]) => path.basename(file) === 'settings.json').map(([, text]) => jsonOf(text)).find(value => value?.permissions) ?? null,
    mcp: (launch, servers, relay) => launch.text.includes(servers.file) || launch.text.includes(relay.args[0]),
    shell: launch => !(READ.agy.settings(launch)?.permissions?.deny ?? []).some(rule => rule === 'command(*)'),
    asks: launch => eluHook(launch.text) || askRules(JSON.stringify(READ.agy.settings(launch)?.permissions ?? {})),
  },
};

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const walk = dir => { const out = []; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) out.push(...walk(file)); else if (entry.isFile()) out.push(file); } return out; };
const snapshot = dir => new Map(walk(dir).map(file => [file, fs.readFileSync(file, 'utf8')]));

// The world a launch is built in: a home and a personal folder of the test's own, a Git
// repository to work in, and the run's folder.
function world(t) {
  const dir = fs.realpathSync(temp(t)), home = path.join(dir, 'home'), personal = path.join(dir, 'personal'), cwd = path.join(dir, 'repo'), runDir = path.join(dir, 'run');
  for (const folder of [home, personal, cwd, runDir]) fs.mkdirSync(folder, { recursive: true });
  environment(t, { HOME: home, XDG_CONFIG_HOME: personal, ELU_NO_GITHUB_PAIRING: '1' });
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd });
  const schemaFile = path.join(runDir, 'result-schema.json'); fs.writeFileSync(schemaFile, JSON.stringify(resultSchema()));
  return { dir, home, cwd, runDir, schemaFile, common: path.join(cwd, '.git') };
}

// The launch lib/runner.mjs builds for the turn of the bot that oversees (turnOnce), on vendor.
// level: 'full' for the Full level (in Full access), or the session's mode below it.
function overseeLaunch(t, vendor, { mode, full }) {
  const w = world(t), adapter = ADAPTERS[vendor], bot = { ...getBot('orchestrator'), vendor, model: null, effort: null };
  const session = crypto.randomUUID(), role = `bot:${bot.name}`;
  const servers = writeServers([], w.cwd, { approval: { session, root: w.cwd, taskId: '1', role, vendor, log: path.join(w.runDir, 'approvals.jsonl'), cwd: w.cwd, access: full ? 'edit' : 'read', rules: 'saved', sandboxed: false, mode, folders: [w.home], common: w.common, oversee: bot.name } });
  t.after(() => fs.rmSync(servers.folder, { recursive: true, force: true }));
  const relay = JSON.parse(fs.readFileSync(servers.file, 'utf8')).mcpServers[APPROVAL_SERVER];
  const before = snapshot(w.dir);
  const launch = { role: { ...botWorkRole(bot, defaultConfig().roles.lead, full ? 'edit' : 'read'), vendor }, mode, place: { kind: 'worktree' }, folders: [], cwd: w.cwd, protectedPaths: ['.git'], commonDir: w.common, schemaFile: w.schemaFile, outputSchema: resultSchema(), session, resume: null, peer: false, runDir: w.runDir,
    approval: { tool: APPROVAL_TOOL }, home: true, mcp: servers, oversee: true, ...(full ? { [OVERSEE_FULL]: true } : {}) };
  // An adapter's own launch without its machine check (agy launch) where it has one: the check
  // proves a mode on the owner's computer, which a test has none of.
  const build = typeof adapter.launch === 'function' ? adapter.launch : adapter.compile;
  let args;
  try { args = build(launch); } catch (error) { return { refused: error, servers, relay }; }
  const env = adapter.childEnv ? adapter.childEnv({ mode, role, runDir: w.runDir, cwd: w.cwd, home: os.homedir(), subagents: null, oversee: true, ...(full ? { [OVERSEE_FULL]: true } : {}) }) ?? {} : {};
  const after = snapshot(w.dir), files = {};
  // Beside the servers' file (a launch may write its own next to it: Grok Build's agent file).
  for (const [file, text] of after) if (before.get(file) !== text && file !== servers.file) files[file] = text;
  const list = Array.isArray(args) ? args.map(String) : Array.isArray(args?.args) ? args.args.map(String) : [];
  return { args: list, env, files, text: [JSON.stringify(args), JSON.stringify(env), ...Object.values(files)].join('\n'), servers, relay };
}

for (const vendor of VENDORS) {
  test(`${vendor}: the Orchestrator's launch has ELU's own MCP server and a shell at Full, and the ask list still reaches the owner`, t => {
    assert.equal(ADAPTERS[vendor].meta.oversee, true, `${vendor}'s adapter says its compile builds the launch of a turn that oversees (meta.oversee)`);
    assert.equal(overseesOn(vendor), true, 'and the runner gives the bot its tools there');
    const launch = overseeLaunch(t, vendor, { mode: 'full', full: true });
    assert.equal(launch.refused, undefined, `${vendor} builds the Full launch: ${launch.refused?.message}`);
    assert.equal(READ[vendor].mcp(launch, launch.servers, launch.relay), true, "ELU's own MCP server is in the launch");
    assert.equal(READ[vendor].shell(launch), true, 'a shell at Full');
    assert.equal(READ[vendor].asks(launch), true, 'the ask list reaches the owner, through ELU or as rules');
  });
  for (const mode of ['ask', 'auto', 'full']) test(`${vendor}: below Full, in ${mode === 'full' ? 'Full access' : mode}, the Orchestrator's launch has ELU's own MCP server and no shell`, t => {
    const launch = overseeLaunch(t, vendor, { mode, full: false });
    if (launch.refused) { assert.equal(launch.refused.name === 'EluCodeError' || /refuse|cannot|needs|check/i.test(launch.refused.message), true, `refused, not broken: ${launch.refused.stack}`); return; }
    assert.equal(READ[vendor].mcp(launch, launch.servers, launch.relay), true, "ELU's own MCP server is in the launch");
    assert.equal(READ[vendor].shell(launch), false, 'no shell below Full');
  });
}

// The readers read what they say: Claude Code's launch, the one every vendor's is held to.
test('the readers see a shell and the ask list where they are, and not where they are not', t => {
  const full = overseeLaunch(t, 'claude', { mode: 'full', full: true }), below = overseeLaunch(t, 'claude', { mode: 'auto', full: false });
  assert.equal(READ.claude.shell(full), true); assert.equal(READ.claude.shell(below), false);
  assert.equal(READ.claude.asks(full), true); assert.equal(READ.claude.asks({ ...full, args: full.args.filter(arg => arg !== '--permission-prompt-tool') }), false);
  assert.equal(READ.codex.shell({ args: ['-c', 'features.shell_tool=true', '-c', 'features.shell_tool=false'] }), false, 'the last word holds');
  assert.equal(READ.grok.shell({ args: ['--disallowed-tools', 'web_fetch,run_terminal_cmd'] }), false);
  assert.equal(askRules(FULL_ASK_LIST.join(' ')), true); assert.equal(askRules('npm publish'), false);
  assert.equal(eluHook(`hooks.PreToolUse=[{command="${process.execPath} ${path.join(LIB, 'adapters', 'codex.mjs')} hook"}]`), true); assert.equal(eluHook('hooks.PreToolUse=[]'), false);
});
