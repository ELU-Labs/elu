import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertPolicy, assertNoManagedCodexConfig } from '../policy.mjs';
import { validateResult } from '../config.mjs';
import { homeNames, refuse, linesOf, personalDirectoryNames, systemTemp, systemTempNames, TOO_LONG, within } from '../util.mjs';
import { capture } from '../process.mjs';
import { EFFORT_WORD, HOME_SECRETS, MODEL_NAME, questionRefusal } from '../vendors.mjs';
import { vendorEfforts } from '../bot-models.mjs';
import { APPROVAL_WAIT_SECONDS, PROFILES, readOnlyFolders } from '../modes.mjs';
import { refusedIn } from '../never-list.mjs';
import { shimsBase } from '../never-shims.mjs';
import { OVERSEE_FULL } from '../orchestrator-seams.mjs';

// Pinned releases, the flags an untested release must list, and how sign-in is read.
export const meta = Object.freeze({
  vendor: 'codex', bin: 'codex', versionArgs: ['--version'], helpArgs: ['exec', '--help'], oversee: true, mcp: true,
  flags: ['--ignore-user-config', '--ignore-rules', '--json', '--sandbox', '--cd', '--output-schema', '--config', '--skip-git-repo-check'],
  supportedVersions: Object.freeze(['0.166.0-alpha.5.1']), envKeys: Object.freeze([]), signInHint: 'Codex: sign in with ChatGPT. Run: codex login', installHint: 'npm i -g @openai/codex',
});
// Only a ChatGPT sign-in counts: `codex login status` exits 0 and prints "Logged in using
// ChatGPT". An API key also exits 0 (and prints a masked key), so the line is matched and
// the output is never shown. signal: a stop ends the program.
export async function signedIn({ bin, cwd, env, signal = null }) {
  const status = await capture(bin, ['login', 'status'], { cwd, env, signal });
  if (status.timedOut || status.stopped) return null;
  return status.code === 0 && /Logged in using ChatGPT/.test(`${status.stdout}\n${status.stderr}`);
}
export const conformance = Object.freeze([]);

// Tools Codex may not offer in any profile; the shell features are added back by mode.
const OFF = ['hooks', 'apps', 'multi_agent', 'browser_use', 'code_mode', 'plugins', 'view_image', 'image_generation', 'computer_use', 'browser_use_external', 'browser_use_full_cdp_access', 'multi_agent_v2', 'code_mode_host', 'sleep_tool', 'goals', 'workspace_dependencies', 'skill_search', 'skill_mcp_dependency_install', 'remote_plugin', 'plugin_discovery_prefetch', 'tool_suggest', 'shell_snapshot', 'in_app_browser'];
// Every launch leaves the code-mode host at the release's default. On 0.166.0-alpha.5.1 every model
// in the catalog but one takes its tools only through that host: with it off no command and no
// file read ever starts, and the model can only ask. A reviewer has no tools, and with the host off
// its every turn opened with an error (codex-cli 0.169.0-alpha.11.1: "Code Mode is unavailable
// because code-mode host is disabled. Code mode will fail closed"). With the host on, the read-only
// sandbox and no shell, what a reviewer's turn can reach is the host's own JavaScript, which reads
// no file and no network (no fs, process, fetch or import), a patch the sandbox rejects with no
// item, and Codex's listing of MCP resources, of no server. Its helpers are the one tool more, and
// features.multi_agent no longer takes them away: agents.enabled=false does (isolation).
const off = () => OFF.filter(feature => feature !== 'code_mode_host');
// todos: the model's own plan tool, for a turn whose Task's subtasks tick from it as it works.
const isolation = (shell, todos = false) => ['-c', 'mcp_servers={}', '-c', 'tools.experimental_request_user_input.enabled=false', '-c', `tools.update_plan.enabled=${todos}`,
  '-c', `features.shell_tool=${shell}`, '-c', `features.unified_exec=${shell}`, ...off().flatMap(feature => ['-c', `features.${feature}=false`]), ...(shell ? [] : ['-c', 'agents.enabled=false']),
  '-c', `shell_environment_policy.inherit="${shell ? 'core' : 'none'}"`, '-c', 'skills.bundled.enabled=false', '-c', 'skills.include_instructions=false'];
// Full access is everything: every feature and tool stays as this release of Codex ships it
// (helpers, the plan, images, skills, plugins), and commands get the whole environment of the
// run. Two switches stay because ELU could not read the run without them: a question to the
// user has nobody to answer it in a run without a terminal, so the turn would wait until its
// quiet limit, and the servers of the owner's own config are not read because
// --ignore-user-config leaves every setting to ELU. The shell tools are named so a release
// that ships them off still runs commands. For the same reason ELU names how many helpers may
// run at once: Codex's own default stopped a lead at its fourth helper.
export const FULL_HELPERS = 32;
const FULL = Object.freeze(['-c', 'mcp_servers={}', '-c', 'tools.experimental_request_user_input.enabled=false', '-c', 'features.shell_tool=true', '-c', 'features.unified_exec=true',
  '-c', `agents.max_concurrent_threads_per_session=${FULL_HELPERS}`]);
// A profile path is a TOML key; Codex reads glob characters in it as a pattern.
const UNSAFE = /[\x00-\x1f*?\[\]{}]/;
const toml = value => JSON.stringify(value);
const real = dir => { const resolved = path.resolve(dir); try { return fs.realpathSync(resolved); } catch { return resolved; } };
const spellings = dir => [...new Set([path.resolve(dir), real(dir)])];
// A folder ELU made in the system's temp folder, under each name that folder has (on macOS
// TMPDIR is under /var, a link to /private/var), as Codex may name it either way.
const tempSpellings = dir => { const rest = path.relative(systemTemp(), dir); return rest && !rest.startsWith('..') && !path.isAbsolute(rest) ? [...new Set([...systemTempNames().map(name => path.join(name, rest)), ...spellings(dir)])] : spellings(dir); };
// ELU's state under the repository's common Git directory (repo.state in lib/git.mjs). On Linux
// Codex hides a denied path that does not exist by making it, and in .git, which Codex keeps
// read-only in the workspace, it cannot: bwrap then refuses every command of the turn. So ELU
// makes its own folder when the Git directory is there. When it still does not exist (no Git
// directory, as outside a repository) it gets no entry: there is nothing in it to read, ELU
// keeps such a project's state in its personal folder, which stays denied, and a command
// cannot make it: Codex keeps <cwd>/.git read-only even when it is missing, a command writes
// nothing else outside the workspace but the hand-off folder, and it has no more rights than ELU.
function ownState(commonDir) {
  if (!commonDir) return [];
  const dir = path.join(path.resolve(commonDir), 'elu-code');
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch { /* already there, or no Git directory to make it in */ }
  try { fs.lstatSync(dir); } catch { return []; }
  return spellings(dir);
}
// What a lead may never read, whatever the mode: home secrets, ELU's own state and
// the transcripts under the repository's common Git directory.
function deniedPaths(commonDir) {
  const home = real(os.homedir());
  return [...new Set([...HOME_SECRETS.map(name => path.join(home, name)), ...personalDirectoryNames().flatMap(spellings), ...ownState(commonDir)])];
}
// One entry per path. A path can come more than once (a protected path that is also a named
// folder, the stand-ins' folder named as a folder, two names of one temp folder), and a TOML
// table that names a key twice does not parse: Codex then runs no command of the turn. A path
// keeps its strictest access, deny over read over write, except that the hand-off folder stays
// writable unless it is denied. The specials (:tmpdir) are names, not paths.
const FIRST = ['deny', 'handoff', 'read', 'write'];
function once(entries) {
  const kept = new Map();
  for (const [p, access] of entries) {
    const key = p.startsWith(':') ? p : path.resolve(p), had = kept.get(key);
    if (had === undefined || FIRST.indexOf(access) < FIRST.indexOf(had)) kept.set(key, access);
  }
  return [...kept].map(([p, access]) => [p, access === 'handoff' ? 'write' : access]);
}
// The elu_ask profile: the workspace sandbox for edit turns, read-only for
// answer turns, named folders read-only (except one that holds the workspace or lies in it,
// which Codex reads anyway), secrets and state denied. Protected files stay
// readable but not writable, the same rule the structural checks enforce afterwards, and so
// do the never list's stand-in commands, wherever a named folder reaches. The
// shared temp folders the workspace sandbox adds are taken back here: under a profile the
// sandbox_workspace_write.exclude_* keys do nothing, the two specials do.
// handoff: the one folder a command of the owner's own session writes to hand ELU's own
// commands to ELU (lib/session-commands.mjs openPlace), in an answer turn too. It is the run's
// own, outside ELU's state, which stays denied.
function profile({ role, cwd, folders, protectedPaths, commonDir, handoff = null }) {
  const edit = role.access === 'edit';
  const entries = once([...(edit ? [[':slash_tmp', 'read'], [':tmpdir', 'read']] : []), ...readOnlyFolders(folders, { cwd }).map(dir => [dir, 'read']), ...protectedPaths.map(p => [path.resolve(cwd, p), 'read']), ...spellings(shimsBase()).map(p => [p, 'read']), ...(handoff ? tempSpellings(handoff).map(p => [p, 'handoff']) : []), ...deniedPaths(commonDir).map(p => [p, 'deny'])]);
  if ([cwd, ...entries.map(([p]) => p)].some(p => UNSAFE.test(p))) refuse('A workspace, folder or protected path contains characters that cannot be expressed safely in vendor permissions.');
  return `permissions.elu_ask={extends=${toml(edit ? ':workspace' : ':read-only')}, filesystem={${entries.map(([p, access]) => `${toml(p)}=${toml(access)}`).join(', ')}}}`;
}
// What the model thinks, in words, for the steps a turn shows while it works (lib/run-activity.mjs):
// a reasoning item in the stream. Every model in the bundled catalog (`codex debug models
// --bundled`, 0.167.0-alpha.4.1) defaults to no summary (default_reasoning_summary none), and
// then the stream carries no reasoning item. plain: a launch without it, for a program that
// does not take it (lib/vendor-extras.mjs).
const REASONING = Object.freeze(['-c', 'model_reasoning_summary="auto"']);
// A role may name a model and an effort; a bot does. `codex exec --help` and `codex exec
// resume --help` (0.166.0-alpha.5.1) both list -m, --model; the effort is the config key
// model_reasoning_effort. Each model takes the levels its catalog lists (supported_reasoning_levels,
// up to ultra on most models of 0.167.0-alpha.4.1); the owner's choice was held to them.
// Here any level Codex knows goes through, as one plain word.
function modelArgs(role) {
  if (role.model != null && (typeof role.model !== 'string' || !MODEL_NAME.test(role.model))) refuse('A model name starts with a letter or digit, without spaces.');
  if (role.effort != null && !(EFFORT_WORD.test(role.effort) && vendorEfforts('codex').includes(role.effort))) refuse(`Effort on Codex is one of: ${vendorEfforts('codex').join(', ')}.`);
  return [...(role.model ? ['--model', role.model] : []), ...(role.effort ? ['-c', `model_reasoning_effort=${toml(role.effort)}`] : [])];
}
// ---------------------------------------------------------------------------------------
// The turn of the bot that oversees the owner's sessions (oversee, lib/bots.mjs botOversees), as
// Claude Code runs it (lib/adapters/claude.mjs modeArgs). Read on codex-cli 0.169.0-alpha.11.1:
// - Its tools are ELU's MCP server: the approval relay started for that bot (lib/mcp.mjs
//   approvalServer with oversee), which serves sessions_list, session_read, session_message,
//   session_start and the rest, with the owner's own servers named on the bot's row. mcp is
//   { file, names } of writeServers, the same private file Claude Code is given; Codex is given
//   each server in -c mcp_servers, in place of mcp_servers={}. Another run given the owner's
//   servers (a working bot's mcp) gets them the same way (ownerServers), without ELU's relay.
// - Every model of the catalog takes its tools only through the code-mode host (tool_mode
//   code_mode_only): with it off a turn calls no tool, not even an MCP one, and Codex says
//   "Code Mode is unavailable because code-mode host is disabled". So both stay at the release default.
// - Codex has no permission prompt tool. Its PreToolUse hook does that work: every shell command,
//   patch and MCP call of the turn and of its helpers reaches it before it runs, with the input
//   Claude Code's hooks get (tool_name Bash and tool_input.command for a command, apply_patch for a
//   patch, mcp__SERVER__TOOL for an MCP call). The hook is this file (overseeHook): it answers
//   each one as the relay answers Claude Code (lib/approval-server.mjs overseeing), asking the
//   owner where the relay would and waiting for him, and refuses what it cannot ask. A hook given
//   with -c runs only with --dangerously-bypass-hook-trust; with --ignore-user-config no hook of a
//   project's or the owner's is read, so this one is the only one that runs.
// - A tool of an MCP server asks first unless default_tools_approval_mode is approve, and an exec
//   run has nobody to ask ("MCP tool call requires approval, but approval policy is never"). The
//   hook answers for every MCP call instead, so each server is set to approve.
// - A tool of ELU's waits for the owner when it asks him (lib/orchestrator-actions.mjs askOwner):
//   its timeout is the relay's wait and two minutes more. Codex's default is one minute.
export const OVERSEE_HOOK = 'hook', SERVE_WRAP = 'mcp-serve', HEADERS_HELP = 'mcp-headers';
// ELU's own server (lib/mcp.mjs APPROVAL_SERVER), named here: that module's imports reach the
// adapters, and this one is loaded by them before it is.
export const RELAY_SERVER = 'elu-code-approval';
const APPROVAL_SERVER = RELAY_SERVER;
const SCRIPT = fileURLToPath(import.meta.url);
const MORE_SECONDS = 120;
// What ELU's own code reads of the environment for its state, its peers and Claude Code's
// servers, handed on to ELU's server as Claude Code hands it its whole environment. Codex starts
// a server with a few variables of its own (HOME, PATH, LANG, USER, TMPDIR and the like).
const ELU_ENV = Object.freeze(['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'ELU_NO_UPDATE_CHECK']);
// The tools of a turn that oversees below Full: the code-mode host and ELU's hook stay on, with
// no shell, no helper, no plan, no skill and no question to the user (isolation, as a reviewer).
const OVERSEE_OFF = OFF.filter(feature => !['hooks', 'code_mode', 'code_mode_host'].includes(feature));
const word = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const packed = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const unpacked = text => JSON.parse(Buffer.from(String(text ?? ''), 'base64url').toString('utf8'));
// The command line Codex runs for one of this file's jobs (sh -c): this node, this file, the job, its data.
const ownCommand = (job, data) => [process.execPath, SCRIPT, job].map(word).concat(packed(data)).join(' ');
const plainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const stringMap = value => plainObject(value) && Object.values(value).every(item => typeof item === 'string');
// The relay's own options, as lib/mcp.mjs approvalServer writes them: --name value after the script.
function relayOptions(args) {
  const out = {};
  for (let i = 1; i + 1 < args.length; i += 2) if (/^--[a-z]+$/.test(args[i])) out[args[i].slice(2)] = args[i + 1];
  return out;
}
// The run's private file of servers (lib/mcp.mjs writeServers): { mcpServers }, or null.
function runServers(mcp) {
  if (!mcp || typeof mcp.file !== 'string' || !path.isAbsolute(mcp.file) || !strings(mcp.names)) return null;
  try { const all = JSON.parse(fs.readFileSync(mcp.file, 'utf8'))?.mcpServers; return plainObject(all) ? all : null; } catch { return null; }
}
// One server of the owner's as Codex takes it. A server can hold a key in its settings, which never
// goes on a command line: a command one is started through this file (SERVE_WRAP), which reads
// them from the private file, and a URL one gets its headers from this file too (HEADERS_HELP),
// when Codex connects. Every tool of it runs without a question of Codex's (approve), as Claude
// Code allows mcp__NAME: an exec run has nobody to ask ("MCP tool call requires approval, but
// approval policy is never"). A turn that oversees has each call answered in its hook (overseeHook).
function ownerEntry(all, file, name, tools) {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) refuse('An MCP server name contains characters that cannot be expressed safely in vendor permissions.');
  const entry = all[name], common = { required: false, startup_timeout_sec: 30, tool_timeout_sec: tools, default_tools_approval_mode: 'approve' };
  if (!plainObject(entry)) refuse(`The MCP server ${name} is missing from this run's config.`);
  if (typeof entry.url === 'string') return { url: entry.url, ...(plainObject(entry.headers) && Object.keys(entry.headers).length ? { http_headers_helper: ownCommand(HEADERS_HELP, { file, name }) } : {}), ...common };
  if (typeof entry.command === 'string') return { command: process.execPath, args: [SCRIPT, SERVE_WRAP, packed({ file, name })], ...common };
  refuse(`The MCP server ${name} has settings Codex cannot start.`);
}
// The servers of a turn that oversees, and what the hook knows of the turn: ELU's own server, which
// holds no key, goes on the command line as the relay was written for this run.
function overseeServers(mcp) {
  const all = runServers(mcp);
  if (!all) refuse("A turn that oversees needs the MCP config that starts ELU's own server.");
  const relay = all[APPROVAL_SERVER];
  if (!mcp.names.includes(APPROVAL_SERVER) || !plainObject(relay) || typeof relay.command !== 'string' || !strings(relay.args) || (relay.env !== undefined && !stringMap(relay.env))) refuse("A turn that oversees needs ELU's own MCP server.");
  const options = relayOptions(relay.args);
  if (!options.oversee || options.role !== `bot:${options.oversee}`) refuse("ELU's own MCP server of this turn was not started for the bot that oversees.");
  const wait = Number(options.wait) > 0 ? Number(options.wait) : APPROVAL_WAIT_SECONDS, tools = wait + MORE_SECONDS;
  const servers = {};
  for (const name of mcp.names) servers[name] = name === APPROVAL_SERVER
    ? { command: relay.command, args: relay.args, env: relay.env ?? {}, env_vars: ELU_ENV, disabled_tools: ['approve'], required: true, startup_timeout_sec: 30, tool_timeout_sec: tools, default_tools_approval_mode: 'approve' }
    : ownerEntry(all, mcp.file, name, tools);
  return { servers, wait, options, env: relay.env ?? {} };
}
// The servers of any other run the owner gave some (a working bot's mcp, lib/runner.mjs
// workServers): his own, never ELU's relay, whose one tool Codex has no use for. null without
// any: the launch is then built as before, to the byte.
function ownerServers(mcp) {
  const names = strings(mcp?.names) ? mcp.names.filter(name => name !== APPROVAL_SERVER) : [];
  if (!names.length) return null;
  const all = runServers(mcp);
  if (!all) refuse("This run's MCP config cannot be read.");
  return { names, table: Object.fromEntries(names.map(name => [name, ownerEntry(all, mcp.file, name, APPROVAL_WAIT_SECONDS + MORE_SECONDS)])) };
}
// A TOML value, as -c reads it: strings as JSON writes them, which TOML reads the same.
const tomlValue = value => Array.isArray(value) ? `[${value.map(tomlValue).join(', ')}]` : plainObject(value) ? `{${Object.entries(value).map(([key, item]) => `${toml(key)}=${tomlValue(item)}`).join(', ')}}` : typeof value === 'string' ? toml(value) : String(value);
// What a turn that oversees never changes with its own tools, at Full too, as Claude Code's deny
// rules hold it (lib/adapters/claude.mjs fullOverseeDenies): ELU's own folder under each of its
// names and the records of every session in a repository's Git folder. A patch is refused by its
// paths, a command when its text names one of them, a tripwire as there.
const RECORDS = '.git/elu-code';
function keptPaths(commonDir) {
  const state = [...new Set(personalDirectoryNames().flatMap(spellings))], records = commonDir ? spellings(commonDir).map(p => path.join(p, 'elu-code')) : [];
  const homes = homeNames(), named = [...new Set(state.flatMap(p => [p, ...homes.filter(home => p !== home && within(home, p)).map(home => `~/${path.relative(home, p)}`)]))];
  return { kept: [...state, ...records], named };
}
// The turn's Codex arguments for that bot: its servers, its hook and its tools, by level.
// atFull: the level Full (OVERSEE_FULL), in Full access: a shell, edits, the web and helpers,
// as a Full access session has. Below it: no shell, no edit, no helper, no web: ELU's tools only.
function overseeArgs({ mcp, mode, cwd, commonDir, atFull }) {
  const { servers, wait, options, env } = overseeServers(mcp);
  const hook = { session: options.session, root: options.root || null, task: options.task || null, role: options.role, vendor: options.vendor || 'codex', log: options.log || null, wait, cwd: options.cwd || cwd, access: options.access || null, rules: options.rules || null, sandboxed: options.sandboxed === 'yes', mode: options.mode || mode, bot: options.oversee, servers: mcp.names, env, full: atFull, ...keptPaths(commonDir) };
  const hooks = `hooks.PreToolUse=[{matcher="*", hooks=[{type="command", command=${toml(ownCommand(OVERSEE_HOOK, hook))}, timeout=${wait + MORE_SECONDS}}]}]`;
  const tools = atFull
    ? FULL.filter(arg => arg !== 'mcp_servers={}' && arg !== '-c').flatMap(arg => ['-c', arg])
    : ['-c', 'tools.experimental_request_user_input.enabled=false', '-c', 'tools.update_plan.enabled=false', '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', ...OVERSEE_OFF.flatMap(feature => ['-c', `features.${feature}=false`]), '-c', 'agents.enabled=false',
      '-c', 'shell_environment_policy.inherit="none"', '-c', 'skills.bundled.enabled=false', '-c', 'skills.include_instructions=false'];
  const sandbox = atFull ? ['-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"', '-c', 'web_search="live"'] : ['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"'];
  return [...sandbox, '-c', `mcp_servers=${tomlValue(servers)}`, ...tools, '-c', 'features.hooks=true', '-c', hooks];
}

// A Read only run given the owner's servers (ownerServers): the read-only launch (its code-mode
// host on, as every model of the catalog calls an MCP tool only through it), with a hook
// that lets the turn use those servers' tools and nothing else the host would offer it (a shell,
// a patch, a helper). Codex runs a hook given with -c only with --dangerously-bypass-hook-trust.
function readOnlyWithServers(args, owned) {
  const out = [];
  for (const arg of args) out.push(arg === 'mcp_servers={}' ? `mcp_servers=${tomlValue(owned.table)}` : arg === 'features.hooks=false' ? 'features.hooks=true' : arg);
  const hook = `hooks.PreToolUse=[{matcher="*", hooks=[{type="command", command=${toml(ownCommand(OVERSEE_HOOK, { kind: 'servers', servers: owned.names }))}, timeout=60}]}]`;
  return [...out.slice(0, -1), '--dangerously-bypass-hook-trust', '-c', hook, out.at(-1)];
}
// What a Codex launch puts on its command line, checked against what every system takes. A prompt
// and its instructions go on stdin ('-'); only settings go on the command line, a few kilobytes.
// Linux takes no one argument over 128 KiB (MAX_ARG_STRLEN) and macOS 1 MiB of arguments and
// environment together; lib/codex-live.mjs liveLaunch carries the whole launch as one argument,
// JSON with its quotes escaped. A launch past these limits is refused here, by name, instead of
// failing to start (E2BIG).
export const ARG_BYTES = 32 * 1024, ARGS_BYTES = 48 * 1024;
function fits(args) {
  const sizes = args.map(arg => Buffer.byteLength(String(arg)) + 1);
  if (sizes.some(size => size > ARG_BYTES) || sizes.reduce((sum, size) => sum + size, 0) > ARGS_BYTES) refuse('This Codex launch has more settings than a command line holds. Use fewer folders, protected paths or MCP servers.');
  return args;
}
// mode, place and folders are the session's permissions. Locked is the
// read-only reviewer launch, pinned by test/fixtures/argv-locked.json. The other modes set everything through -c keys so
// the same set applies to `exec resume`, which has no --sandbox or --cd; its cwd is the workspace.
// oversee: the turn of the bot that oversees the owner's sessions, with mcp ({ file, names } of
// lib/mcp.mjs writeServers, ELU's own server among them) and, at the level Full in Full access,
// overseeFull (OVERSEE_FULL): overseeArgs above. Any other run given mcp gets the owner's servers
// it names (ownerServers) in place of mcp_servers={}; without any, every launch is built as before, to the byte.
export function compile({ role, mode = 'locked', place = { kind: 'worktree' }, folders = [], cwd, protectedPaths = [], commonDir, resume = null, schemaFile, peer = false, plain = false, todos = false, handoff = null, mcp = null, oversee = false, [OVERSEE_FULL]: overseeFull = false }) {
  if (!PROFILES.includes(mode)) refuse('Choose ask, auto, or full.');
  const atFull = overseeFull === true;
  if (oversee && (peer || mode === 'locked')) refuse("A turn that oversees runs in a session of the owner's with permissions.");
  if (atFull && !oversee) refuse('Only the turn of a bot that oversees runs at the Full level.');
  if (atFull && mode !== 'full') refuse('A turn that oversees at the Full level runs in Full access.');
  if (oversee && !atFull && (role?.access === 'edit' || todos || handoff != null)) refuse('A turn that oversees never edits, runs no command and merges nothing.');
  if (handoff != null && (mode === 'locked' || peer || typeof handoff !== 'string' || !path.isAbsolute(handoff))) refuse("ELU's own commands are for a session of the owner's with a shell.");
  if (mode === 'locked' && (place?.kind !== 'worktree' || folders.length)) refuse('A read-only run stays in the task worktree.');
  if (place?.kind === 'here' && mode !== 'full') refuse('Here needs Full access.');
  // A peer run needs the untracked-path denies only Claude expresses (CAPS.peer).
  if (peer) refuse(questionRefusal('codex'));
  assertPolicy({ ...role, vendor: 'codex' }, { mode }); assertNoManagedCodexConfig();
  if (oversee) return fits(['exec', ...(resume ? ['resume', resume] : []), '--ignore-user-config', '--ignore-rules', '--json', '--skip-git-repo-check', ...(resume ? [] : ['--cd', cwd]), '--output-schema', schemaFile,
    '--dangerously-bypass-hook-trust', ...overseeArgs({ mcp, mode, cwd, commonDir, atFull }), ...(plain ? [] : REASONING), ...modelArgs(role), '-']);
  const owned = ownerServers(mcp);
  if (mode === 'locked') {
    if (role.access !== 'read') refuse('Codex cannot edit in Read only. Choose Ask for approval, Approve for me, or Full access.');
    // A project folder need not be a Git repository (a bot reads where the session works), so
    // the repository check is skipped here too; the read-only sandbox is what holds the run.
    const args = ['exec', '--ignore-user-config', '--ignore-rules', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', cwd, '--output-schema', schemaFile,
      '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', ...isolation(false), ...(plain ? [] : REASONING), ...modelArgs(role), '-'];
    return fits(owned ? readOnlyWithServers(args, owned) : args);
  }
  const sandbox = mode === 'full'
    ? ['-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"', '-c', 'web_search="live"']
    : ['-c', 'default_permissions="elu_ask"', '-c', profile({ role, cwd, folders, protectedPaths, commonDir, handoff }),
      ...(mode === 'auto' ? ['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"'] : ['-c', 'approval_policy="never"']),
      '-c', 'web_search="disabled"'];
  // A project folder need not be a Git repository, so the repository check is skipped; the
  // workspace itself is chosen by ELU. Commands run in a plain shell: a login shell
  // builds PATH again with the system folders first, ahead of the never list's stand-in
  // commands in Ask for approval and Approve for me, which would then refuse nothing. Full
  // access has no stand-ins, so it keeps the shell Codex would start, and none of the switches
  // that take a tool away (FULL).
  const limits = mode === 'full' ? FULL : ['-c', 'allow_login_shell=false', ...isolation(true, todos === true)];
  const args = ['exec', ...(resume ? ['resume', resume] : []), '--ignore-user-config', '--ignore-rules', '--json', '--skip-git-repo-check', ...(resume ? [] : ['--cd', cwd]), '--output-schema', schemaFile, ...sandbox, ...limits, ...(plain ? [] : REASONING), ...modelArgs(role), '-'];
  return fits(owned ? args.map(arg => arg === 'mcp_servers={}' ? `mcp_servers=${tomlValue(owned.table)}` : arg) : args);
}
// Tool items a lead may produce by profile; a reviewer (locked) has no tools of its own. An
// mcp_tool_call or any other kind means Codex started with something it was not given.
// Full access has no list: every tool is its own, so every kind of item is read.
const LEAD_ITEMS = { locked: [], ask: ['command_execution', 'file_change'], auto: ['command_execution', 'file_change'] };
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
// What the owner reads about a declined item: the command, or the files a patch touched.
function denial(item) {
  if (item.type === 'command_execution') return { tool: 'command_execution', summary: `Run: ${clean(item.command)}`.slice(0, 200) };
  if (item.type === 'file_change') return { tool: 'file_change', summary: `Edit: ${clean((item.changes ?? []).map(change => change?.path).filter(Boolean).join(', '))}`.slice(0, 200) };
  return { tool: clean(item.type) || 'tool', summary: `Use ${clean(item.type) || 'a tool'}` };
}
// The row that ends a turn.
export const finalEvent = row => row?.type === 'turn.completed' || row?.type === 'turn.failed';
// mode: the profile the run was launched with; the default is the read-only reviewer's rule, so a
// stream showing any tool item cannot report done. A lead's declined items become denials,
// and so does a step in which a stand-in command refused a never-list command (never: its name).
// servers: the MCP servers the run was given (the turn that oversees, a working bot's): a call of a
// tool of one of them is read in every mode, and so is Codex's own listing and reading of the
// resources of the run's servers (server codex, RESOURCE_TOOLS), which the code-mode host offers
// in every launch, with no server too.
const RESOURCE_TOOLS = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'];
const givenCall = (item, given) => item.type === 'mcp_tool_call' && (given.includes(item.server) || (item.server === 'codex' && RESOURCE_TOOLS.includes(item.tool)));
export function parse(text, { validate = validateResult, mode = 'locked', servers = [] } = {}) {
  const allowed = mode === 'full' ? null : LEAD_ITEMS[mode] ?? LEAD_ITEMS.locked, given = strings(servers) ? servers : [];
  let session = null; let answer = null; let completed = false; let failed = false; const denials = [];
  // text: the run's output, or its lines (linesOf in lib/util.mjs), gone through one at a time.
  for (const line of linesOf(text)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { refuse('Codex returned a malformed JSON stream.'); }
    if (row.type === 'thread.started') session = row.thread_id;
    if (row.type === 'turn.completed') {completed = true;failed=false;}
    if (row.type === 'turn.failed' || row.type === 'error') failed = true;
    if (row.type === 'item.completed' && row.item?.type === 'agent_message') answer = row.item.text;
    if (row.type.startsWith('item.') && row.item && !['agent_message', 'reasoning','error','todo_list'].includes(row.item.type)) {
      if (allowed && !allowed.includes(row.item.type) && !givenCall(row.item, given)) refuse(mode === 'locked' ? 'Codex exposed a tool that this reviewer must not have.' : 'Codex exposed a tool that this session must not have.');
      if (row.type === 'item.completed' && row.item.status === 'declined') denials.push(denial(row.item));
      // A stand-in command refused a never-list command somewhere in this step.
      else if (row.type === 'item.completed' && row.item.type === 'command_execution') { const never = refusedIn(row.item.aggregated_output); if (never) denials.push({ ...denial(row.item), never }); }
    }
  }
  if (!completed || failed || answer === null) refuse('Codex did not return a completed result.', { cause: classify(text) });
  let value;
  try { value = JSON.parse(answer); } catch { refuse('Codex returned no JSON run result.'); }
  return { result: validate(value), session, costUsd: null, denials };
}
export function classify(text='') {
 let failure=null;
 for(const line of linesOf(text)){let row;try{row=JSON.parse(line);}catch{continue;}if(row.type==='turn.completed')failure=null;if(row.type==='turn.failed'||row.type==='error')failure=row.error??row;}
 const value=JSON.stringify(failure??'');
 if(TOO_LONG.test(value))return'too-long';
 // OpenAI said it is overloaded (server_is_overloaded, 529): ELU tries the turn again (lib/runner.mjs).
 if(/overloaded|\b529\b/i.test(value))return'overloaded';
 if(/usage_limit_reached|insufficient_quota|billing_hard_limit|hit your usage limit|credit balance.*(?:low|exhausted)|monthly spend limit/i.test(value))return'quota';
 if(/rate_limit|rate limit/i.test(value))return'rate-limit';
 return'unknown';
}

// ---------------------------------------------------------------------------------------
// The jobs Codex starts this file for in a turn given servers (overseeArgs, readOnlyWithServers,
// ownerServers): its PreToolUse hook, a command server of the owner's started with its own
// settings, and a URL server's headers.
const OWN_DENIED = "The bot that oversees the sessions never changes ELU's own folder or ELU's records of the sessions with its own tools: only ELU's own tools and commands do. Do not retry it another way.";
const UNCHECKED = 'ELU could not check this step, so it did not run. Do not retry it another way: say in your reply what you needed.';
// The files a patch adds, changes, deletes or moves to.
const patchFiles = patch => [...String(patch ?? '').matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map(match => match[1].trim()).filter(Boolean);
const commandOf = input => Array.isArray(input?.command) ? input.command.map(String).join(' ') : String(input?.command ?? input?.cmd ?? '');
// One tool call of the turn, or of a helper of its, in the names the relay answers (overseeing):
// a command as Bash, what is typed into a running one as a command too, each file of a patch as
// an Edit of it (a patch with no file it names as an Edit of none, which is refused), and an MCP
// call as it is. [] for any other tool the launch gave the turn (a helper, its plan, the web).
export function hookCalls(tool, input) {
  if (['Bash', 'shell', 'exec_command', 'local_shell'].includes(tool)) return [['Bash', { command: commandOf(input) }]];
  if (tool === 'write_stdin') { const chars = String(input?.chars ?? ''); return chars.trim() ? [['Bash', { command: chars }]] : []; }
  if (['apply_patch', 'Edit', 'Write', 'MultiEdit'].includes(tool)) { const files = typeof input?.file_path === 'string' ? [input.file_path] : patchFiles(input?.command ?? input?.patch ?? input?.input); return files.length ? files.map(file => ['Edit', { file_path: file }]) : [['Edit', {}]]; }
  if (typeof tool === 'string' && tool.startsWith('mcp__')) return [[tool, plainObject(input) ? input : {}]];
  return [];
}
// Codex names an MCP tool for the model and for its hooks with each character of the server's
// name that is not a letter, a digit or _ as _ (mcp__elu_code_approval__sessions_list for
// elu-code-approval). The relay tells a server by the name it was started with, so the name is
// given back: the longest server whose name, so written, starts the tool's.
export function serverTool(tool, servers = []) {
  if (typeof tool !== 'string' || !tool.startsWith('mcp__')) return tool;
  const rest = tool.slice(5), named = (Array.isArray(servers) ? servers : []).filter(name => typeof name === 'string' && name).sort((a, b) => b.length - a.length);
  for (const name of named) for (const written of [name, name.replace(/[^A-Za-z0-9_]/g, '_')]) if (rest.startsWith(`${written}__`)) return `mcp__${name}__${rest.slice(written.length + 2)}`;
  return tool;
}
// Whether a call changes what the turn never changes with its own tools (keptPaths).
function touchesKept(tool, input, { cwd, kept = [], named = [] }) {
  if (tool === 'Bash') { const text = String(input.command ?? ''); return text.includes(RECORDS) || named.some(p => text.includes(p)); }
  if (tool !== 'Edit') return false;
  if (typeof input.file_path !== 'string' || !input.file_path) return true;
  const file = path.resolve(typeof cwd === 'string' && cwd ? cwd : process.cwd(), input.file_path);
  let resolved = file; try { resolved = fs.realpathSync(file); } catch { try { resolved = path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); } catch { resolved = file; } }
  return [file, resolved].some(p => p.split(path.sep).join('/').includes(`/${RECORDS}/`) || p.split(path.sep).join('/').endsWith(`/${RECORDS}`) || kept.some(own => within(own, p)));
}
// Below Full the turn starts no helper. Codex 0.169 offers its helper tools whatever
// features.multi_agent says (the switch is deprecated there), so the hook refuses them.
const HELPER_TOOL = /(?:spawn_agent|send_input|resume_agent)$/, helperTool = tool => typeof tool === 'string' && !tool.startsWith('mcp__') && HELPER_TOOL.test(tool);
const NO_HELPERS = 'Below the level Full the bot that oversees the sessions starts no helper. Do not retry it another way: do the step with your own tools, or say in your reply what you needed.';
const SERVERS_ONLY = 'In a Read only session this turn uses its MCP servers and no other tool: it runs no command, edits nothing and starts no helper. Do not retry it another way: say in your reply what you needed.';
const hookDeny = reason => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
// The hook's answer to one PreToolUse event: '' (no opinion: the call runs) or the deny line Codex
// reads. context: what overseeArgs packed of the turn, or for a Read only run with the owner's
// servers (readOnlyWithServers, kind servers) their names alone: a tool of one of them runs, a
// command, a patch, a helper or another server's tool does not. Anything that cannot be read is refused.
export async function overseeHook(context, eventText, { overseeing = null } = {}) {
  let event; try { event = JSON.parse(eventText); } catch { return hookDeny(UNCHECKED); }
  if (context?.kind === 'servers') {
    const tool = serverTool(event?.tool_name, context.servers);
    if (typeof tool !== 'string' || !strings(context.servers)) return hookDeny(UNCHECKED);
    if (tool.startsWith('mcp__')) return context.servers.some(name => tool.startsWith(`mcp__${name}__`)) ? '' : hookDeny(SERVERS_ONLY);
    return helperTool(tool) || hookCalls(tool, event?.tool_input ?? {}).length ? hookDeny(SERVERS_ONLY) : '';
  }
  if (context.full !== true && helperTool(event?.tool_name)) return hookDeny(NO_HELPERS);
  const calls = hookCalls(serverTool(event?.tool_name, context.servers), event?.tool_input ?? {});
  if (!calls.length) return '';
  const answer = overseeing ?? (await import('../approval-server.mjs')).overseeing;
  const use = String(event.tool_use_id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 70) || `call-${process.pid}-${Date.now()}`;
  const record = row => { if (context.log && path.isAbsolute(context.log)) { try { fs.appendFileSync(context.log, `${JSON.stringify(row)}\n`, { mode: 0o600 }); } catch { /* The answer still reaches Codex. */ } } };
  for (const [index, [tool, input]] of calls.entries()) {
    const id = `${context.session}-${use}${calls.length > 1 ? `-${index + 1}` : ''}`;
    if (touchesKept(tool, input, context)) { record({ id, tool, summary: tool === 'Bash' ? `Run: ${clean(input.command)}` : `Edit: ${clean(input.file_path ?? '')}`, decision: 'deny', by: 'oversee', at: new Date().toISOString() }); return hookDeny(OWN_DENIED); }
    const out = await answer(tool, input, { id, mode: context.mode, root: context.root, taskId: context.task, role: context.role, vendor: context.vendor, bot: context.bot, servers: context.servers, run: context.session, cwd: context.cwd, access: context.access, rules: context.rules, sandboxed: context.sandboxed === true, waitSeconds: context.wait });
    record({ id, tool, summary: out.summary, decision: out.decision, ...(out.by ? { by: out.by } : {}), ...(out.rule ? { rule: out.rule } : {}), ...(out.decision === 'timeout' ? { wait: context.wait } : {}), at: new Date().toISOString() });
    if (out.decision !== 'allow') return hookDeny(String(out.message || UNCHECKED));
  }
  return '';
}
const readInput = () => new Promise(resolve => { let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { text += chunk; }); process.stdin.on('end', () => resolve(text)); process.stdin.on('error', () => resolve(text)); });
// A server of the run's private file, read when Codex starts it or connects to it.
function ownerServer({ file, name }) {
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'))?.mcpServers?.[name];
  if (!plainObject(entry) || name === APPROVAL_SERVER) throw new Error(`No MCP server ${name} in this run's config.`);
  return entry;
}
async function job(name, data) {
  if (name === OVERSEE_HOOK) {
    let context = null; try { context = unpacked(data); } catch { context = null; }
    // ELU's state is where the relay finds it (lib/mcp.mjs approvalServer env).
    if (plainObject(context?.env)) for (const [key, value] of Object.entries(context.env)) if (['HOME', 'XDG_CONFIG_HOME'].includes(key) && typeof value === 'string') process.env[key] = value;
    const text = await readInput();
    let said; try { said = context ? await overseeHook(context, text) : hookDeny(UNCHECKED); } catch { said = hookDeny(UNCHECKED); }
    if (said) process.stdout.write(said);
    return 0;
  }
  if (name === HEADERS_HELP) { const entry = ownerServer(unpacked(data)); process.stdout.write(JSON.stringify(stringMap(entry.headers) ? entry.headers : {})); return 0; }
  const entry = ownerServer(unpacked(data));
  if (typeof entry.command !== 'string' || (entry.args !== undefined && !strings(entry.args)) || (entry.env !== undefined && !stringMap(entry.env))) throw new Error('This MCP server has no command to start.');
  const child = spawn(entry.command, entry.args ?? [], { stdio: 'inherit', env: { ...process.env, ...(entry.env ?? {}) } });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { try { child.kill(signal); } catch { /* Gone. */ } });
  return new Promise(resolve => { child.once('error', error => { process.stderr.write(`${error.message}\n`); resolve(1); }); child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))); });
}
// Not awaited at the top: the hook imports the relay, whose own imports reach this file again,
// which must have finished loading by then.
if (process.argv[1] && [OVERSEE_HOOK, SERVE_WRAP, HEADERS_HELP].includes(process.argv[2]) && real(process.argv[1]) === real(SCRIPT)) {
  job(process.argv[2], process.argv[3]).then(code => { process.exitCode = code; }, error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
