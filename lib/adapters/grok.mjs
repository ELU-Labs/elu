import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertPolicy } from '../policy.mjs';
import { resultSchema, validateResult } from '../config.mjs';
import { EluCodeError, atomic, execute, homeNames, lastObject, linesOf, mkdir, personalDirectory, personalDirectoryNames, refuse, within } from '../util.mjs';
import { checkPlace, PROFILES } from '../modes.mjs';
import { HOME_SECRETS, VENDOR_NAMES, questionRefusal, signInCommand, vendorWithCommand } from '../vendors.mjs';
import { agentEnv, capture, runProcess } from '../process.mjs';
import { mirrorHome } from '../home-mirror.mjs';
import { acpModel, startAcp } from '../acp-client.mjs';
import { approvalSummary } from '../approvals.mjs';
import { conformanceState, loadText, modeBlock, violation } from '../conformance.mjs';
import { takesExtra } from '../vendor-extras.mjs';
import { APPROVAL_SERVER } from '../mcp.mjs';
import { OVERSEE_FULL } from '../orchestrator-seams.mjs';

// Grok Build. Everything here was designed from the vendor's docs: no release is pinned
// until the one-time check proves one, so below Full access detect() never executes the
// binary before that check, and a launch needs this machine's passed conformance state.
// Full access needs no check: it launches the release that is there.
// The longest input Grok Build takes, in characters: xAI's grok-4 and grok-code models take
// 256,000 tokens, counted here at three characters a token, as code runs.
export const INPUT_CHARS = 768000;
export const inputChars = () => INPUT_CHARS;
export const meta = Object.freeze({
  vendor: 'grok', bin: 'grok', versionArgs: ['--version'], helpArgs: ['--help'], oversee: true, mcp: true,
  flags: ['--output-format', '--permission-mode', '--sandbox', '--max-turns', '--cwd', '--no-auto-update', '--tools', '--disallowed-tools', '--allow', '--deny', '--prompt-file'],
  // Taken but no longer listed in --help since 1.0.77; Grok refuses an unknown flag (exit 2), so running it proves it.
  unlistedFlags: Object.freeze(['--no-auto-update']),
  // envKeys stays empty: no key variable (XAI_API_KEY) ever reaches a run; sign-in is grok login.
  supportedVersions: Object.freeze([]), envKeys: Object.freeze([]),
  signInHint: `${vendorWithCommand('grok')}: not signed in. Sign it in with s on its line in the Usage tab.`, installHint: 'npm i -g @xai-official/grok',
});
const NAME = VENDOR_NAMES.grok;
const UNSAFE = /[\x00-\x1f,()*?\[\]{}]/;
const STEP_SECONDS = 180;
// Turn caps per role kind: --max-turns is the only bound on a headless run. Full access has
// no cap of ours: it runs until Grok ends the turn.
const MAX_TURNS = Object.freeze({ read: 40, edit: 120 });
// The never list as deny rules on command text (a tripwire, not a boundary), in every profile
// but Full access, which has no never list. The :* form matches the bare command as well as
// its arguments.
export const NEVER_COMMANDS = Object.freeze(['git push', 'git tag', 'git merge', 'gh pr merge', 'gh release', 'npm publish', 'pnpm publish', 'yarn publish', 'cargo publish', 'firebase deploy', 'vercel deploy', 'gcloud run deploy', 'gcloud app deploy', 'fly deploy', 'kubectl apply', 'terraform apply', 'claude mcp add', 'claude mcp add-json', 'claude mcp add-from-claude-desktop', 'claude mcp remove', 'elu mcp add', 'elu mcp remove']);
const neverRules = () => NEVER_COMMANDS.map(command => `Bash(${command}:*)`);
const SENSITIVE = ['.env*', '.npmrc', '.netrc', '.pypirc', 'auth.json', 'credentials', 'credentials.json', 'id_rsa', 'id_ed25519', '*.pem'];

// Grok reads the owner's ~/.grok and ~/.claude trees by default. Every run gets
// a private HOME under ELU's state and a GROK_HOME holding only what ELU wrote:
// this config, the session store, no folder trust, and a link to the real token file. The
// config is written for the run's profile: it denies the never list, and turns off subagents
// and the tools that run on xAI's side, in every one but Full access, which is everything.
// Each profile has a home of its own (prepareHome), so a run reads the config of its own
// profile whatever starts beside it.
// Every switch Grok Build has for loading another tool's files, each off in the config and in
// the environment. Either alone is honoured and the environment wins (watched with 1.0.77).
// Codex has only its sessions cell today; its other cells are reserved and take a value already.
const COMPAT = Object.freeze({ tools: Object.freeze(['claude', 'cursor', 'codex']), surfaces: Object.freeze(['skills', 'rules', 'agents', 'mcps', 'hooks', 'sessions']) });
const compatToml = () => COMPAT.tools.map(tool => `[compat.${tool}]\n${COMPAT.surfaces.map(surface => `${surface} = false\n`).join('')}`).join('\n');
export const configToml = mode => `# Written by ELU before every run. Edits here are overwritten.
${compatToml()}
[features]
telemetry = false
feedback = false
managed_config = false
campaigns = false
remote_fetch = false${mode === 'full' ? '' : `
backend_tools = false`}

[telemetry]
trace_upload = false
mixpanel_enabled = false

[harness]
disable_workspace_teleport = true
disable_codebase_upload = true

[cli]
auto_update = false

[relay]
enabled = false

[session]
load_envrc = false
${mode === 'full' ? '' : `
[subagents]
enabled = false

[permission]
deny = [${neverRules().map(rule => JSON.stringify(rule)).join(', ')}]
`}`;
// The config of every profile but Full access.
export const CONFIG_TOML = configToml('ask');
const TRUST_TOML = '# Written by ELU. No folder is trusted: a workspace never adds hooks, MCP servers or rules.\n';
// Server-side search (GROK_BACKEND_SEARCH) runs inside the model call, where no rule and no
// relay can see it, so it is off in every profile with rules; --disable-web-search covers the
// tool only. LIMITS are the switches that take something from the agent itself: memory,
// subagents and that search. Full access sets none of them.
const LIMITS = Object.freeze({ GROK_MEMORY: '0', GROK_SUBAGENTS: '0', GROK_BACKEND_SEARCH: '0' });
const SWITCHES = Object.freeze({
  GROK_DISABLE_AUTOUPDATER: '1', GROK_TELEMETRY_ENABLED: '0', GROK_TELEMETRY_TRACE_UPLOAD: '0', GROK_TELEMETRY_MIXPANEL_ENABLED: '0', GROK_FEEDBACK_ENABLED: '0', GROK_CAMPAIGNS: '0',
  ...Object.fromEntries(COMPAT.tools.flatMap(tool => COMPAT.surfaces.map(surface => [`GROK_${tool.toUpperCase()}_${surface.toUpperCase()}_ENABLED`, '0']))),
});
export const privateHome = () => path.join(personalDirectory(), 'grok-home');
// The Grok home every profile shares: the sign-in (auth.json) and the session store, where
// grok login runs (signInTerminal). Releases up to 0.1.26 ran every profile here.
export const grokHome = () => path.join(privateHome(), '.grok');
// The home of one profile: HOME for its runs outside Full access, and its .grok is the
// profile's GROK_HOME, whose config.toml only runs of that profile write. Its sessions and
// auth.json are links to the shared ones, so a session goes on in any profile and one sign-in
// serves them all.
export const modeHome = mode => path.join(privateHome(), checkProfile(mode));
export const modeGrokHome = mode => path.join(modeHome(mode), '.grok');
// Full access: ~ is a mirror of the owner's home (lib/home-mirror.mjs) in a folder beside the
// private one, so a command finds his npm, cloud and other sign-ins where it looks for them.
// GROK_HOME stays the private one, and ~/.grok there is a link to it.
export const fullHome = () => path.join(personalDirectory(), 'grok-home-full');
const realHome = home => typeof home === 'string' && path.isAbsolute(home) ? home : os.homedir();
// auth.json is a link to the owner's real token file, so grok login and token refreshes
// write through and ELU keeps no copy. If grok ever replaces the link with a file
// (a refresh written by rename), the newer of the two tokens wins.
function linkAuth(link, target) {
  let current = null; try { current = fs.lstatSync(link); } catch { /* No link yet. */ }
  if (current?.isSymbolicLink()) { if (fs.readlinkSync(link) === target) return; fs.unlinkSync(link); }
  else if (current) {
    let real = null; try { real = fs.statSync(target); } catch { /* Signed out. */ }
    if (!real || real.mtimeMs <= current.mtimeMs) return;
    fs.unlinkSync(link);
  }
  makeLink(target, link);
}
// A link at path to target, made as a run beside this one may make the same.
function makeLink(target, at) {
  try { fs.symlinkSync(target, at); }
  catch (error) { if (error.code !== 'EEXIST' || !fs.lstatSync(at).isSymbolicLink() || fs.readlinkSync(at) !== target) throw error; }
}
// A token Grok wrote over the link in a profile's home (a refresh written by rename) is moved
// to the shared home when it is the newer one, where every profile reads it; an older one gives
// way to the link. Moved, never opened.
function shareToken(at, shared) {
  let held = null; try { held = fs.lstatSync(at); } catch { return; }
  if (held.isSymbolicLink() || !held.isFile()) return;
  let current = null; try { current = fs.statSync(shared); } catch { /* Signed out there. */ }
  try { if (!current || current.mtimeMs < held.mtimeMs) fs.renameSync(at, shared); else fs.unlinkSync(at); } catch { /* A run beside this one moved it. */ }
}
// A profile's entry that is the shared one: a link to it. A folder Grok made there in place of
// the link gives the shared one what it holds and is set aside with what it could not give; a
// token is shared (shareToken), and anything else is set aside.
function share(at, target) {
  let held = null; try { held = fs.lstatSync(at); } catch { /* Not there yet. */ }
  const aside = () => fs.renameSync(at, `${at}-aside-${crypto.randomUUID()}`);
  if (held?.isSymbolicLink()) { if (fs.readlinkSync(at) === target) return; fs.unlinkSync(at); }
  else if (held?.isDirectory()) {
    for (const name of fs.readdirSync(at)) { if (!fs.existsSync(path.join(target, name))) fs.renameSync(path.join(at, name), path.join(target, name)); }
    try { fs.rmdirSync(at); } catch { aside(); }
  }
  else if (held?.isFile() && path.basename(at) === 'auth.json') shareToken(at, target);
  else if (held) aside();
  makeLink(target, at);
}
// The shared home: the session store, the trust file, and the link to the owner's token,
// with the newer token a profile's home was given.
function prepareShared(home) {
  const dir = grokHome();
  mkdir(path.join(dir, 'sessions'));
  atomic(path.join(dir, 'trusted_folders.toml'), TRUST_TOML);
  for (const mode of PROFILES) shareToken(path.join(modeGrokHome(mode), 'auth.json'), path.join(dir, 'auth.json'));
  linkAuth(path.join(dir, 'auth.json'), path.join(realHome(home), '.grok', 'auth.json'));
  return dir;
}
// Grok's sandbox lets a run write its own GROK_HOME, the temp folders and, outside the
// read-only profile, the workspace: each as it is on disk. A profile's sessions are a link to
// the store every profile shares, which lies outside its GROK_HOME, so under the built-in
// profiles Grok could not write there and made no session ("Couldn't create session:
// Operation not permitted", seen with 1.0.77 on macOS: no turn below Full access ran). A
// sandboxed run therefore names a profile of ELU's own: the built-in one and that one folder
// more, defined in the sandbox.toml of the profile's home (Grok's guide, 18-sandbox.md).
// Grok refuses to start under a profile it cannot find or apply, so a run is never left
// with less than this.
export const SANDBOX = Object.freeze({ locked: 'elu-read-only', ask: 'elu-workspace', auto: 'elu-workspace' });
const SANDBOX_BASES = Object.freeze({ 'elu-read-only': 'read-only', 'elu-workspace': 'workspace' });
export const sandboxToml = () => `# Written by ELU before every run. Edits here are overwritten.
${Object.entries(SANDBOX_BASES).map(([name, base]) => `[profiles.${name}]\nextends = ${JSON.stringify(base)}\nread_write = [${JSON.stringify(path.join(grokHome(), 'sessions'))}]\n`).join('\n')}`;
// A run's home: the profile's own, with its config written for it. Runs of another profile
// that start at the same moment write theirs in their own home: a Full access turn never reads
// the never list of an Ask turn beside it, and a check step never reads the config of Full access.
export function prepareHome({ home, mode = 'locked', mirror = mode === 'full' } = {}) {
  checkProfile(mode);
  const shared = prepareShared(home), dir = modeGrokHome(mode);
  mkdir(dir);
  atomic(path.join(dir, 'config.toml'), configToml(mode));
  atomic(path.join(dir, 'trusted_folders.toml'), TRUST_TOML);
  atomic(path.join(dir, 'sandbox.toml'), sandboxToml());
  for (const name of ['sessions', 'auth.json']) share(path.join(dir, name), path.join(shared, name));
  return { home: mirror ? mirrorHome({ home: realHome(home), mirror: fullHome(), own: { '.grok': dir } }) : modeHome(mode), grokHome: dir };
}
function checkProfile(mode) { if (!PROFILES.includes(mode)) refuse('Choose ask, auto, or full.'); return mode; }
// The env a run gets on top of agentEnv's allow-list. home is the owner's real home
// directory (where the token lives), never the private one.
// oversee: the turn of a bot that oversees. Below the Full level (overseeFull, OVERSEE_FULL) it
// keeps every limit in Full access too, as on Claude Code: in a Full access session it runs in
// the home and config of Approve for me (its never list, no subagents, no server-side search).
export function childEnv({ mode = 'locked', home, mirror, oversee = false, [OVERSEE_FULL]: overseeFull = false } = {}) {
  checkProfile(mode);
  const profile = oversee === true && overseeFull !== true && mode === 'full' ? 'auto' : mode;
  const dirs = prepareHome({ home, mode: profile, mirror: mirror ?? profile === 'full' });
  return { HOME: dirs.home, GROK_HOME: dirs.grokHome, ...SWITCHES, ...(profile === 'full' ? {} : LIMITS), ...(profile === 'locked' ? { GROK_WRITE_FILE: '0', GROK_WEB_FETCH: '0' } : {}) };
}
// Presence only: the token file is never read.
const hasToken = dir => { try { return fs.statSync(path.join(dir, 'auth.json')).isFile(); } catch { return false; } };
// Under a run's env the token is the one in the private GROK_HOME. Under detect's env it is
// the one ELU's runs would use (signInFile): reading the owner's own file alone said "signed
// out" for a token grok login wrote into ELU's GROK_HOME in place of the link.
export function signedIn({ env = {} } = {}) {
  if (typeof env.GROK_HOME === 'string') return hasToken(env.GROK_HOME);
  return typeof env.HOME === 'string' ? signInFile({ env }) : false;
}
// The token ELU's runs would use: the owner's ~/.grok/auth.json, or one grok login wrote into
// ELU's GROK_HOME in place of the link, a file of its own there (prepareHome keeps the newer).
// Presence only.
export function signInFile({ env = process.env } = {}) {
  if (hasToken(path.join(realHome(env.HOME), '.grok'))) return true;
  try { return fs.lstatSync(path.join(grokHome(), 'auth.json')).isFile(); } catch { return false; }
}
// The same as the Usage tab and the check read it, which run no program.
export async function readSignIn({ env = process.env } = {}) { return { signedIn: signInFile({ env }), reason: null }; }
// grok login, which the owner runs from the Usage tab (s) in the terminal, under the HOME and
// GROK_HOME every ELU run of grok has, so its token lands where those runs read it: through
// the link, in the owner's own ~/.grok/auth.json. For an owner who never ran grok, ~/.grok is
// made first, as grok login in his terminal would make it: the link leads nowhere until then.
// On a computer with no browser (browser false) it is grok login --device-auth, the sign-in
// grok names for one (`grok login --help`, 1.0.77): a link, and a code to confirm on that page.
export function signInTerminal({ env = process.env, browser = true } = {}) {
  fs.mkdirSync(path.join(realHome(env.HOME), '.grok'), { recursive: true, mode: 0o700 });
  // In the shared home, with the config of Ask for approval, so a token grok login writes over
  // the link is there for every profile.
  const dir = prepareShared(realHome(env.HOME)); atomic(path.join(dir, 'config.toml'), configToml('ask'));
  return { args: signInCommand('grok', browser).split(' ').slice(1), env: agentEnv(env, [], { HOME: privateHome(), GROK_HOME: dir, ...SWITCHES, ...LIMITS }) };
}
// Grok has no schema flag: the schema rides in the prompt, and stdin is never read, so the
// prompt goes to <runDir>/prompt.txt, which compile names with --prompt-file.
export function prepareInput(text, { outputSchema = resultSchema(), runDir = null } = {}) {
  const prompt = `${text}\n\nOutput schema. Reply with exactly one JSON object matching it and nothing else:\n${JSON.stringify(outputSchema)}\n`;
  if (runDir) atomic(path.join(runDir, 'prompt.txt'), prompt);
  return prompt;
}
const secretRules = home => [
  ...homeNames(home).flatMap(dir => HOME_SECRETS.flatMap(name => { const p = path.join(dir, name); return [`Read(${p})`, `Read(${p}/**)`, `Grep(${p}/**)`]; })),
  ...SENSITIVE.map(name => `Read(**/${name})`),
  // The Full access mirror is named whether or not a run has made it yet, under each name of ELU's folder.
  ...[...new Set([...stateEntries(), ...personalDirectoryNames().map(dir => path.join(dir, path.basename(fullHome())))])].flatMap(p => [`Read(${p})`, `Read(${p}/**)`, `Grep(${p}/**)`]),
];
// ELU's own state is unreadable, except grok's private home inside it.
function stateEntries() {
  const dirs = personalDirectoryNames();
  let names = []; try { names = fs.readdirSync(dirs[0]); } catch { return []; }
  return dirs.flatMap(dir => names.filter(name => name !== 'grok-home').map(name => path.join(dir, name)));
}
const pathRules = (cwd, paths, tools) => paths.flatMap(p => { const abs = path.resolve(cwd, p); return tools.flatMap(tool => [`${tool}(${abs})`, `${tool}(${abs}/**)`]); });
const flags = (flag, rules) => rules.flatMap(rule => [flag, rule]);
// Allow and deny rules for ask and auto: workspace edits free, named folders readable,
// protected paths and the never list denied, secrets denied everywhere. Full access is
// everything and denies nothing.
function ruleFlags({ mode, role, cwd, folders, protectedPaths, home }) {
  if (mode === 'locked') return flags('--deny', ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'MCPTool', ...secretRules(home)]);
  if (mode === 'full') return [];
  const edits = role.access === 'edit' ? pathRules(cwd, role.writablePaths, ['Edit', 'Write']) : [];
  return [...flags('--allow', ['Read', 'Grep', ...edits, ...folders.map(dir => `Read(${dir}/**)`)]), ...flags('--deny', [...pathRules(cwd, protectedPaths, ['Edit', 'Write']), ...neverRules(), ...secretRules(home)])];
}
function checkLaunch({ role, mode, place, folders, cwd, protectedPaths, peer, home }) {
  checkProfile(mode); checkPlace(place, { mode });
  if (peer) refuse(questionRefusal('grok'));
  assertPolicy({ ...role, vendor: 'grok' }, { mode });
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) refuse('A Grok Build run needs an absolute workspace path.');
  // Full access passes no rule, so no path has to fit in one.
  if (mode !== 'full' && [cwd, ...homeNames(home), ...protectedPaths, ...folders, ...role.writablePaths].some(p => UNSAFE.test(p))) refuse('A workspace, folder or protected path contains characters that cannot be expressed safely in vendor permissions.');
}
// The headless argv. Permission modes other than bypassPermissions in -p are
// documented for the enterprise build only, so each profile also carries its tool list,
// sandbox and rules; the conformance steps prove the locked profile on this machine. The
// output is streaming-json, one event per line as the run goes (its thoughts, tool calls and
// text), so the chat can show what the run is doing; the json format prints only at the end.
// plain: the json format, for a program that does not take the other (lib/vendor-extras.mjs).
function argv({ role, mode, place, folders, cwd, protectedPaths, session, resume, peer, runDir, home, plain = false }) {
  checkLaunch({ role, mode, place, folders, cwd, protectedPaths, peer, home });
  if (typeof runDir !== 'string' || !path.isAbsolute(runDir) || (mode !== 'full' && UNSAFE.test(runDir))) refuse('A Grok Build run needs its private run folder.');
  if (resume ? typeof resume !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(resume) : typeof session !== 'string' || !/^[0-9a-f-]{36}$/i.test(session)) refuse('A Grok Build run needs a UUID session, or a session to resume.');
  // Full access is everything: Grok's memory, its subagents, and as many turns as it takes.
  const limits = mode === 'full' ? { off: [], turns: [] } : { off: ['--no-memory', '--no-subagents'], turns: ['--max-turns', String(MAX_TURNS[role.access === 'edit' ? 'edit' : 'read'])] };
  const common = ['--no-auto-update', '--no-alt-screen', ...limits.off, '--cwd', cwd, '--output-format', plain ? 'json' : 'streaming-json', ...limits.turns, ...(role.model ? ['--model', role.model] : []), '--prompt-file', path.join(runDir, 'prompt.txt')];
  const rules = ruleFlags({ mode, role, cwd, folders, protectedPaths, home }), identity = resume ? ['-r', resume] : ['-s', session];
  if (mode === 'locked') return fits([...common, '--permission-mode', 'dontAsk', '--sandbox', SANDBOX.locked, '--tools', 'read_file,grep,list_dir', '--disallowed-tools', 'run_terminal_cmd,search_replace,web_search,web_fetch,spawn_subagent,Agent', '--disable-web-search', ...rules, ...identity]);
  if (mode === 'full') return fits([...common, '--permission-mode', 'bypassPermissions', '--sandbox', 'off', ...rules, ...identity]);
  // ask falls back here only when the relay step did not pass: dontAsk denies and reports.
  return fits([...common, '--permission-mode', mode === 'auto' ? 'auto' : 'dontAsk', '--sandbox', SANDBOX[mode], ...rules, ...identity]);
}
// Grok Build takes its rules on its command line only (no file holds one run's rules), so a
// launch whose rules would pass what a command line safely holds (with the environment, about
// 1 MiB on macOS; 128 KiB for one argument on Linux) is refused with that said, never left to
// fail to start. The prompt, the schema, the MCP servers and the relay go in files.
export const ARGV_LIMIT = 256 * 1024;
function fits(args) {
  const size = args.reduce((sum, arg) => sum + Buffer.byteLength(arg) + 1, 0);
  if (size > ARGV_LIMIT || args.some(arg => Buffer.byteLength(arg) > 64 * 1024)) refuse(`This ${NAME} launch would pass ${Math.ceil(size / 1024)} KiB of rules on its command line, more than the ${ARGV_LIMIT / 1024} KiB it safely takes: Grok Build takes its rules there only. Fewer protected paths or folders would fit.`);
  return args;
}
// A launch below Full access needs this machine's check: every Grok behavior here comes from
// the vendor's docs until its required steps pass (docs/vendors/grok.md, "The one-time
// check"). A step that is not proven, or a check that never ran, keeps Read only and the two
// asking modes off; Full access launches all the same.
const gate = mode => { const block = modeBlock('grok', { mode }); if (block) refuse(block); };
// mcp: the run's MCP servers (lib/mcp.mjs writeServers: the private file of this run, which holds
// ELU's own server for a turn that oversees). oversee, overseeFull (OVERSEE_FULL): the turn of a
// bot that oversees, below or at the Full level (overseeArgv). Without them the argv is as it
// was, to the byte.
export function compile({ role, mode = 'locked', place = { kind: 'worktree' }, folders = [], cwd, protectedPaths = [], commonDir = null, session, resume = null, peer = false, runDir = null, plain = false, mcp = null, oversee = false, [OVERSEE_FULL]: overseeFull = false }) {
  gate(mode);
  const home = os.homedir(), launch = { role, mode, place, folders, cwd, protectedPaths, session, resume, peer, runDir, home, plain };
  if (oversee === true || overseeFull === true) return overseeArgv({ ...launch, commonDir, mcp, oversee: oversee === true, overseeFull: overseeFull === true });
  const args = argv(launch);
  if (!mcp?.names?.length || mode === 'locked') return args;
  // A run with the owner's MCP servers, as on Claude Code: each is allowed by name, below Full access too.
  const { servers } = readServers(mcp);
  if (servers[APPROVAL_SERVER]) refuse(`ELU's own MCP server (${APPROVAL_SERVER}) runs only in the turn of a bot that oversees.`);
  const agent = writeAgent(mcp, { servers, home });
  return fits([...args.slice(0, -2), '--agent', agent, ...(mode === 'full' ? [] : flags('--allow', Object.keys(servers).map(name => `MCPTool(${name}__*)`))), ...args.slice(-2)]);
}

// ELU's MCP servers and the turn of a bot that oversees. Grok Build takes no MCP server on its
// command line: they go in an agent definition of the run's own (--agent, Grok's guide
// 16-subagents.md), in the run's private MCP folder (writeServers made it in ELU's own state,
// which no run reads), beside the file the relay reads. It adds to Grok's own system prompt
// (promptMode extend) the note below: ELU's instructions name tools as Claude Code does.
const AGENT_FILE = 'grok-agent.md', RELAY_FILE = 'grok-relay.json';
const TOOL_NAMES_NOTE = 'ELU started this run. Its instructions name tools as Claude Code names them. Here Read is read_file, Grep is grep, Glob is list_dir, WebFetch is web_fetch, WebSearch is web_search, Bash is run_terminal_command, Edit is search_replace, Write is write, and Agent is spawn_subagent. An MCP tool named mcp__SERVER__TOOL there is SERVER__TOOL here: mcp__elu-code-approval__sessions_list is elu-code-approval__sessions_list. Find one with search_tool and call it with use_tool, by that name.';
const RELAY_NOTE = 'ELU decides each MCP call, web call, command and edit of this turn before it runs, as the owner set: it may ask him first, and a refusal says why. A refusal stands for this turn: say what you would have done, and try no other way.';
const SERVER_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
// The run's MCP file, as writeServers wrote it: { mcpServers: { name: server } }.
function readServers(mcp) {
  if (typeof mcp?.file !== 'string' || !path.isAbsolute(mcp.file)) refuse(`A ${NAME} run with MCP servers needs their private file.`);
  let value; try { value = JSON.parse(fs.readFileSync(mcp.file, 'utf8')); } catch { refuse(`ELU could not read this run's MCP servers.`); }
  const servers = value?.mcpServers && typeof value.mcpServers === 'object' && !Array.isArray(value.mcpServers) ? value.mcpServers : {};
  for (const [name, server] of Object.entries(servers)) if (!SERVER_NAME.test(name) || name.endsWith('_') || name.includes('__') || !server || typeof server !== 'object') refuse(`The MCP server name ${String(name).slice(0, 64)} is not one ${NAME} can name its tools by.`);
  return { servers };
}
// One server in the definition, as Claude Code's settings hold it: a program with its arguments
// and environment, or an address. A program runs with the owner's own home, as under Claude
// Code, unless its settings name another; a run's HOME is ELU's private one.
function agentServer(server, home) {
  if (typeof server.url === 'string') return { type: typeof server.type === 'string' ? server.type : 'http', url: server.url, ...(server.headers && typeof server.headers === 'object' ? { headers: server.headers } : {}) };
  if (typeof server.command !== 'string' || !server.command) refuse(`An MCP server of this run names no program.`);
  return { command: server.command, args: Array.isArray(server.args) ? server.args.map(String) : [], env: { HOME: realHome(home), ...(server.env && typeof server.env === 'object' ? server.env : {}) } };
}
// The frontmatter is YAML, written as JSON values (YAML takes them as they are), so no path,
// argument or value can be read as anything but itself.
function writeAgent(mcp, { servers, home, relay = null }) {
  const folder = path.dirname(mcp.file), file = path.join(folder, AGENT_FILE);
  const lines = ['---', 'name: elu', 'description: "An ELU run"', 'promptMode: extend', 'mcpServers:', ...Object.entries(servers).map(([name, server]) => `  - ${JSON.stringify(name)}: ${JSON.stringify(agentServer(server, home))}`)];
  if (relay) {
    const relayFile = path.join(folder, RELAY_FILE);
    fs.writeFileSync(relayFile, JSON.stringify(relay.run), { mode: 0o600 });
    // Every tool call of the turn, and of each subagent it starts, which runs its hooks too. A hook
    // that fails or outlasts its time denies the call (failClosed), and it outlasts the owner's answer.
    const hook = { type: 'command', command: process.execPath, args: [GROK_SCRIPT, 'relay', relayFile], env: relay.env, timeout: relay.run.wait + 60, failClosed: true };
    lines.push('hooks:', '  PreToolUse:', '    - matcher: "*"', '      hooks:', `        - ${JSON.stringify(hook)}`);
  }
  lines.push('---', TOOL_NAMES_NOTE, ...(relay ? ['', RELAY_NOTE] : []), '');
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  return file;
}
// Who the relay answers for: the run as ELU's own server was started for it (lib/mcp.mjs
// approvalServer), read from that server's arguments, so it is the same run, bot and log.
function relayRun(server) {
  const args = Array.isArray(server?.args) ? server.args : [], out = {};
  for (let i = 1; i + 1 < args.length; i += 2) if (typeof args[i] === 'string' && args[i].startsWith('--')) out[args[i].slice(2)] = String(args[i + 1]);
  const wait = Number(out.wait), servers = (() => { try { return JSON.parse(out.servers ?? '[]'); } catch { return null; } })();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(out.session ?? '') || !path.isAbsolute(out.log ?? '') || !(wait > 0) || !/^[a-z][a-z0-9-]{0,29}$/.test(out.oversee ?? '') || out.role !== `bot:${out.oversee}` || !Array.isArray(servers) || servers.some(name => typeof name !== 'string')) refuse("ELU's own MCP server of this turn names no bot that oversees, so no relay can answer for the owner.");
  return { v: 1, session: out.session, root: out.root ?? '', task: out.task ?? '', role: out.role, vendor: 'grok', log: out.log, wait, cwd: out.cwd ?? null, access: out.access ?? null, rules: out.rules ?? null, sandboxed: out.sandboxed ?? 'no', mode: out.mode ?? null, oversee: out.oversee, servers };
}
// The turn of a bot that oversees, as on Claude Code (lib/adapters/claude.mjs modeArgs), where
// ELU's relay (lib/approval-server.mjs overseeing) answers each call it is asked about. Here
// that relay is a hook of the run's definition: Grok asks it before every tool call, and it
// answers with the same table, asks the owner the same way and logs the same rows.
//   Below the Full level, in every mode: no shell, no edit, no subagent. It reads files and the
//   web, and has ELU's tools and its servers' (MCP tools only), each answered by the relay;
//   secrets and ELU's own state are unreadable; no sandbox, as MCP servers have none on Claude
//   Code, so ELU's server can write ELU's records.
//   At the Full level (Full access only): Full access, and the relay answers every command,
//   edit, web and MCP call: ELU's own files and records are never changed, and FULL_ASK_LIST
//   and the deploys ask the owner.
const RESEARCH_TOOLS = Object.freeze(['read_file', 'grep', 'list_dir', 'web_search', 'web_fetch']);
function overseeArgv({ role, mode, place, folders, cwd, protectedPaths, commonDir, session, resume, peer, runDir, home, plain, mcp, overseeFull }) {
  if (mode === 'locked' || peer) refuse("A turn that oversees runs in a session of the owner's with permissions.");
  if (overseeFull && mode !== 'full') refuse('A turn that oversees at the Full level runs in Full access.');
  if (!overseeFull && role?.access === 'edit') refuse('A turn that oversees never edits, runs no command and merges nothing.');
  const { servers } = readServers(mcp), own = servers[APPROVAL_SERVER];
  if (!own) refuse(`A turn that oversees on ${NAME} needs ELU's own MCP server, which answers for the owner.`);
  const run = { ...relayRun(own), full: overseeFull, ...keptPaths(commonDir) }, agent = writeAgent(mcp, { servers, home, relay: { run, env: own.env && typeof own.env === 'object' ? own.env : {} } });
  if (overseeFull) { const args = argv({ role, mode, place, folders, cwd, protectedPaths, session, resume, peer, runDir, home, plain }); return fits([...args.slice(0, -2), '--agent', agent, ...args.slice(-2)]); }
  checkLaunch({ role, mode, place, folders, cwd, protectedPaths, peer, home });
  // Its rules name paths in a Full access session too.
  if ([cwd, ...homeNames(home), ...folders].some(p => UNSAFE.test(p))) refuse('A workspace, folder or protected path contains characters that cannot be expressed safely in vendor permissions.');
  if (typeof runDir !== 'string' || !path.isAbsolute(runDir) || UNSAFE.test(runDir)) refuse('A Grok Build run needs its private run folder.');
  if (resume ? typeof resume !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(resume) : typeof session !== 'string' || !/^[0-9a-f-]{36}$/i.test(session)) refuse('A Grok Build run needs a UUID session, or a session to resume.');
  return fits(['--no-auto-update', '--no-alt-screen', '--no-memory', '--no-subagents', '--cwd', cwd, '--output-format', plain ? 'json' : 'streaming-json', '--max-turns', String(MAX_TURNS.read), ...(role.model ? ['--model', role.model] : []), '--prompt-file', path.join(runDir, 'prompt.txt'),
    '--permission-mode', 'dontAsk', '--sandbox', 'off', '--tools', RESEARCH_TOOLS.join(','), '--disallowed-tools', 'run_terminal_command,search_replace,write,spawn_subagent', '--agent', agent,
    ...flags('--allow', ['Read', 'Grep', 'WebFetch', 'WebSearch', ...Object.keys(servers).map(name => `MCPTool(${name}__*)`)]),
    ...flags('--deny', ['Bash', 'Edit', 'Write', `MCPTool(${APPROVAL_SERVER}__approve)`, ...secretRules(home)]), ...(resume ? ['-r', resume] : ['-s', session])]);
}
// The relay hook. Grok hands it each tool call as JSON on stdin (Grok's guide, 10-hooks.md); it
// prints the decision. A call ELU's relay would not be asked about on Claude Code (a file read,
// a to-do, a tool search) is left to the run's own rules.
const GROK_SCRIPT = fileURLToPath(import.meta.url);
const CLAUDE_NAMES = Object.freeze({ run_terminal_command: 'Bash', search_replace: 'Edit', write: 'Write', read_file: 'Read', grep: 'Grep', list_dir: 'Glob', web_fetch: 'WebFetch', web_search: 'WebSearch', spawn_subagent: 'Agent' });
const RELAYED = Object.freeze(['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch']);
const MCP_TOOL = /^[A-Za-z_][A-Za-z0-9_-]*__[A-Za-z0-9_-]+$/;
export const toolNameOf = name => Object.hasOwn(CLAUDE_NAMES, name) ? CLAUDE_NAMES[name] : MCP_TOOL.test(name) ? `mcp__${name}` : name;
const RELAY_DENIED = 'ELU could not decide this call, so it did not run. Do not retry it another way: say in your reply what you needed.';
const OWN_TOOL = "That tool is ELU's own, for the owner's answers: never call it.";
const TOO_LONG = 'This call is too long for ELU to read whole, so it did not run. Do not retry it another way: say in your reply what you needed.';
// What a turn that oversees never changes with its own tools, at the Full level too, as on Claude
// Code (lib/adapters/claude.mjs fullOverseeDenies): ELU's own folder, under each of its names,
// and ELU's records of every session in a repository's Git folder. A command is refused when its
// text names them, a tripwire as there; an edit or a write by its path. Reading them is open.
const RECORDS = '.git/elu-code';
const spellings = dir => { const resolved = path.resolve(dir); let real = resolved; try { real = fs.realpathSync(resolved); } catch { /* Missing: matched as given. */ } return [...new Set([resolved, real])]; };
function keptPaths(commonDir) {
  const state = [...new Set(personalDirectoryNames().flatMap(spellings))], records = commonDir ? spellings(commonDir).map(p => path.join(p, 'elu-code')) : [];
  const homes = homeNames(), named = [...new Set(state.flatMap(p => [p, ...homes.filter(home => p !== home && within(home, p)).map(home => `~/${path.relative(home, p)}`)]))];
  return { kept: [...state, ...records], named };
}
const KEPT = "ELU's own folder and its records of each session change only through ELU's own tools and commands, never with a command or an edit of yours. Do not retry it another way: say in your reply what you needed.";
function keeps(tool, input, run) {
  if (tool === 'Bash') { const command = String(input?.command ?? ''); return command.includes(RECORDS) || (run.named ?? []).some(name => command.includes(name)); }
  const given = input?.file_path ?? input?.path;
  if (!['Edit', 'Write'].includes(tool) || typeof given !== 'string' || !given) return false;
  const file = path.resolve(typeof run.cwd === 'string' && run.cwd ? run.cwd : process.cwd(), given);
  let real = file; try { real = fs.realpathSync(file); } catch { try { real = path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); } catch { real = file; } }
  return [file, real].some(p => p.includes(`${path.sep}${RECORDS}${path.sep}`) || p.endsWith(`${path.sep}${RECORDS}`) || (run.kept ?? []).some(dir => within(dir, p)));
}
export async function relayAnswer(event, run, { overseeing = null, signal = null } = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { decision: 'deny', reason: RELAY_DENIED };
  const raw = String(event.toolName ?? event.tool_name ?? ''), input = event.toolInput ?? event.tool_input ?? {}, tool = toolNameOf(raw);
  if (tool === `mcp__${APPROVAL_SERVER}__approve`) return { decision: 'deny', reason: OWN_TOOL };
  if (!tool.startsWith('mcp__') && !RELAYED.includes(tool)) return { decision: 'allow' };
  const server = await import('../approval-server.mjs');
  // A launch below the Full level has no shell and no edit, whatever level the owner sets during it.
  if (run.full !== true && ['Bash', 'Edit', 'Write'].includes(tool)) return { decision: 'deny', reason: server.OVERSEE_DENIED };
  // A cut input hides its end from the relay: only an edit's path, never cut, is read whole.
  if (event?.toolInputTruncated !== false && !['Edit', 'Write'].includes(tool)) return { decision: 'deny', reason: TOO_LONG };
  const use = String(event?.toolUseId ?? event?.tool_use_id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 78) || `call-${crypto.randomUUID()}`, id = `${run.session}-${use}`;
  let out;
  if (keeps(tool, input, run)) out = { decision: 'deny', summary: approvalSummary(tool, input), message: KEPT };
  else try { const decide = overseeing ?? server.overseeing; out = await decide(tool, input && typeof input === 'object' ? input : {}, { id, mode: run.mode, root: run.root, taskId: run.task, role: run.role, vendor: run.vendor, bot: run.oversee, servers: run.servers, run: run.session, cwd: run.cwd, access: run.access, rules: run.rules, sandboxed: run.sandboxed === 'yes', waitSeconds: run.wait, signal }); }
  catch { out = { decision: 'deny', summary: approvalSummary(tool, input), message: RELAY_DENIED }; }
  // The rows Claude Code's relay writes: a command, edit or web call Full access allows is never asked of it there.
  if (!(out.by === 'full' && !tool.startsWith('mcp__'))) { try { fs.appendFileSync(run.log, `${JSON.stringify({ id, tool, summary: out.summary, decision: out.decision, ...(out.by ? { by: out.by } : {}), ...(out.rule ? { rule: out.rule } : {}), ...(out.decision === 'timeout' ? { wait: run.wait } : {}), at: new Date().toISOString() })}\n`, { mode: 0o600 }); } catch { /* The decision still reaches Grok. */ } }
  return out.decision === 'allow' ? { decision: 'allow' } : { decision: 'deny', reason: String(out.message ?? RELAY_DENIED) };
}
async function relayMain(file) {
  let answer;
  try {
    const run = JSON.parse(fs.readFileSync(file, 'utf8'));
    let text = ''; for await (const chunk of process.stdin) text += chunk;
    answer = await relayAnswer(JSON.parse(text), run);
  } catch { answer = { decision: 'deny', reason: RELAY_DENIED }; }
  process.stdout.write(JSON.stringify(answer));
}
// The --output-format json object: one JSON value on stdout; stderr is a separate file.
// A streaming-json run is read into the same shape: its end event, with the text its text
// events carried (streamed below).
// An output larger than one text can be arrives as its lines (lib/util.mjs): the last object in them.
function lastJson(text) {
  if (typeof text !== 'string') return lastObject(text);
  try { const value = JSON.parse(text.trim()); if (value && typeof value === 'object') return value; } catch { /* Not one object. */ }
  for (const line of text.split('\n').reverse()) { try { const value = JSON.parse(line); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* Not an object line. */ } }
  return null;
}
// The model's answer: a JSON object, possibly fenced or wrapped in prose.
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const candidates = [text.trim(), text.replace(/^[\s\S]*?```(?:json)?\s*([\s\S]*?)```[\s\S]*$/, '$1').trim()];
  const first = text.indexOf('{'), last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) { try { const value = JSON.parse(candidate); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* Try the next shape. */ } }
  return null;
}
const modelOf = value => { const name = Object.keys(value.modelUsage ?? {})[0]; return typeof name === 'string' && name.length <= 100 ? name : null; };
// The model a session runs on, as Grok keeps it in the session's record: summary.json's
// current_model_id, under GROK_HOME/sessions/<working folder>/<session id>/ (Grok Build's guide,
// 17-sessions.md). null while there is none. grokHome: the run's GROK_HOME.
export function sessionModel(grokHome, session) {
  if (typeof grokHome !== 'string' || !grokHome || typeof session !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(session)) return null;
  const root = path.join(grokHome, 'sessions');
  let groups = []; try { groups = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()); } catch { return null; }
  for (const group of groups) {
    let summary = null; try { summary = JSON.parse(fs.readFileSync(path.join(root, group.name, session, 'summary.json'), 'utf8')); } catch { continue; }
    const model = summary?.current_model_id;
    if (typeof model === 'string' && model && model.length <= 100) return model;
  }
  return null;
}
// Cost is stamped for API-key traffic; a subscription run usually has none, and a partial cost is no cost.
const costOf = value => typeof value.total_cost_usd === 'number' && value.cost_is_partial !== true ? value.total_cost_usd : null;
// streaming-json: text events carry the answer in chunks; the end event (or error) closes the
// run with what the json object carries but the text. The answer is looked for in the text
// written after the last tool call first, then in all of it. null: not a streaming-json run.
const STREAMED = ['thought', 'text', 'tool_call', 'tool_call_update', 'usage', 'plan', 'end', 'available_commands', 'max_turns_reached'];
function streamed(text) {
  const parts = ['']; let streaming = false, end = null;
  for (const line of linesOf(text ?? '')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (STREAMED.includes(row.type)) streaming = true;
    if (row.type === 'text' && typeof row.data === 'string') parts[parts.length - 1] += row.data; else if (row.type === 'tool_call' && parts.at(-1)) parts.push('');
    if (row.type === 'end' || row.type === 'error') end = row;
  }
  if (!streaming) return null;
  if (!end) return { type: 'error', message: 'The stream ended before its end event.' };
  if (end.type === 'error') return end;
  return { ...end, text: parts.join(''), last: parts.at(-1) };
}
// prose: a reply in words with no JSON object, from a turn that ended as it should, is the
// answer prose(text) makes of it (the bot that oversees, lib/runner.mjs): the words after its
// last tool call, else all of them. Never a failed reply.
export function parse(text, { validate = validateResult, prose = null } = {}) {
  const value = streamed(text) ?? lastJson(text ?? '');
  if (!value) refuse(`${NAME} returned no JSON result.`);
  if (value.type === 'error') refuse(`${NAME} could not finish.`, { cause: classify(text) });
  if (typeof value.text !== 'string') refuse(`${NAME} returned no JSON result.`);
  const ended = typeof value.stopReason !== 'string' || value.stopReason === 'end_turn', words = typeof value.last === 'string' && value.last.trim() ? value.last : value.text;
  const answer = (typeof value.last === 'string' ? extractJson(value.last) : null) ?? extractJson(value.text) ?? (typeof prose === 'function' && ended && words.trim() ? prose(words) : null);
  if (!answer) refuse(typeof value.stopReason === 'string' && value.stopReason !== 'end_turn' ? `${NAME} stopped early (${value.stopReason.slice(0, 40)}).` : `${NAME} returned no JSON run result.`);
  // Headless output carries no denial record: a blocked action reaches the model only.
  return { result: validate(answer), session: typeof value.sessionId === 'string' ? value.sessionId : null, model: modelOf(value), costUsd: costOf(value), denials: [], effectiveMode: null, usage: value.usage && typeof value.usage === 'object' ? value.usage : null };
}
export function classify(text = '') {
  const value = streamed(text) ?? lastJson(text ?? ''), message = value?.type === 'error' ? String(value.message ?? '') : '';
  if (/not logged in|log in|login|unauthori[sz]ed|authenticat|token|\b401\b/i.test(message)) return 'auth';
  if (/rate.?limit|too many requests|\b429\b/i.test(message)) return 'rate-limit';
  if (/quota|usage limit|limit reached|subscription|insufficient|billing|\b402\b/i.test(message)) return 'quota';
  // xAI said it is overloaded: ELU tries the turn again (lib/runner.mjs).
  if (/overloaded|\b529\b/i.test(message)) return 'overloaded';
  return 'unknown';
}
// Transcript rows from a run log: the headless json object, streaming-json events, or ACP
// lines. A streamed run's text comes in chunks and is no row of its own: its tool calls are.
export function logRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (typeof row.text === 'string' && typeof row.stopReason === 'string') return { speaker: 'lead', text: extractJson(row.text)?.summary ?? row.text };
  if (row.type === 'tool_call' && typeof row.title === 'string') return { speaker: 'lead', text: row.title };
  const update = row.method === 'session/update' ? row.params?.update : null;
  if (update?.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') return { speaker: 'lead', text: update.content.text };
  if (update?.sessionUpdate === 'tool_call' && typeof update.title === 'string') return { speaker: 'lead', text: update.title };
  if (row.method === 'session/request_permission' && typeof row.params?.toolCall?.title === 'string') return { speaker: 'lead', text: `Asks: ${row.params.toolCall.title}` };
  return null;
}
// Opening a run's session in the vendor's own terminal needs the same private home.
export function interactive({ session, cwd }) {
  return { bin: meta.bin, args: ['--no-auto-update', '--cwd', cwd, ...(session ? ['-r', session] : [])], env: childEnv({ mode: 'full', mirror: false }) };
}
// When a Full access run ends, what its commands made at the top of ~ goes to the owner's home.
export function settleHome({ mode, home } = {}) { if (mode === 'full') mirrorHome({ home: realHome(home), mirror: fullHome(), own: { '.grok': modeGrokHome('full') } }); }

// Ask and Auto over ACP: grok is an ACP server on stdio, and that is the only
// channel where a permission request can reach the owner. The relay turns each
// session/request_permission into an approval file and answers with the chosen option.
async function acpRun({ bin, role, mode, place = { kind: 'worktree' }, folders = [], cwd, protectedPaths = [], resume = null, outputSchema = resultSchema(), peer = false, prompt, approvals = null, env = process.env, logFile, processFile = null, signal, hold = null, timeoutSeconds = null, quietSeconds = null, validate = validateResult, home, onEnded = null, onRow = null }) {
  if (!['ask', 'auto'].includes(mode)) refuse(`${NAME} runs over ACP in Ask or Auto only.`);
  home = realHome(home);
  checkLaunch({ role, mode, place, folders, cwd, protectedPaths, peer, home });
  if (typeof bin !== 'string' || !path.isAbsolute(bin)) refuse(`A ${NAME} run needs the resolved binary path.`);
  if (typeof prompt !== 'string' || !prompt.trim()) refuse(`A ${NAME} run needs a prompt.`);
  if (approvals && (typeof approvals.request !== 'function' || typeof approvals.await !== 'function')) refuse('approvals needs request and await functions.');
  const child = agentEnv(env, [], childEnv({ mode, home }));
  // Rules go before the subcommand, where the docs put --no-auto-update; the never list is also in this profile's config.toml.
  // The model the session chose is an agent option: after `agent`, before the transport.
  const args = fits(['--no-auto-update', ...ruleFlags({ mode, role, cwd, folders, protectedPaths, home }), 'agent', ...(role.model ? ['--model', role.model] : []), 'stdio']);
  let pending = 0, requests = 0, answer = '', sessionId = null, stop = null, failure = null, model = null, rejected = false;
  const denials = [], decisions = [];
  const client = await startAcp({ bin, args, cwd, env: child, logFile, processFile, signal, hold: () => pending > 0 || Boolean(hold?.()), timeoutSeconds, quietSeconds, onEnded });
  // onRow: called with each session update as it comes (the plan ticks a Task's subtasks).
  client.on('session/update', params => { const update = params?.update; if (update?.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') answer += update.content.text; try { onRow?.({ method: 'session/update', params }); } catch { /* A row that cannot be used never stops the run. */ } });
  client.on('session/request_permission', async params => {
    const call = params?.toolCall ?? {}, options = Array.isArray(params?.options) ? params.options : [];
    const tool = typeof call.toolName === 'string' && call.toolName ? call.toolName : typeof call.kind === 'string' && call.kind ? call.kind : 'tool';
    const title = typeof call.title === 'string' ? call.title : null, input = call.rawInput ?? null;
    const pick = kinds => options.find(option => kinds.includes(option?.kind))?.optionId;
    const allow = pick(['allow_once', 'allow_always']), reject = pick(['reject_once', 'reject_always']);
    let decision = 'deny';
    if (approvals && typeof allow === 'string') {
      pending++;
      const id = `${sessionId ?? 'grok'}-${++requests}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160);
      try { const { summary } = approvals.request({ id, tool, input, title }); decision = await approvals.await(id, { signal }); decisions.push({ id, tool, summary, decision, at: new Date().toISOString() }); }
      catch { decision = 'deny'; }
      finally { pending--; }
    }
    if (decision === 'allow') return { outcome: { outcome: 'selected', optionId: allow } };
    denials.push({ tool, summary: approvalSummary(tool, input, { title }) });
    return typeof reject === 'string' ? { outcome: { outcome: 'selected', optionId: reject } } : { outcome: { outcome: 'cancelled' } };
  });
  try {
    const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    if (!(init?.authMethods ?? []).some(method => method?.id === 'cached_token')) throw new EluCodeError(meta.signInHint, { cause: 'auth' });
    try { await client.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } }); }
    catch (error) { throw new EluCodeError(meta.signInHint, { cause: 'auth', reason: error.message }); }
    const opened = resume
      ? await client.request('session/load', { sessionId: resume, cwd, mcpServers: [] })
      : await client.request('session/new', { cwd, mcpServers: [], ...(mode === 'auto' ? { _meta: { autoMode: true } } : {}) });
    sessionId = resume ?? opened?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) refuse(`${NAME} opened no session.`);
    // A session it loads keeps the model it had: one chosen since is set before anything is asked.
    model = await acpModel(client, sessionId, opened, role.model ?? null, { nested: true, flagged: true });
    const turn = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prepareInput(prompt, { outputSchema }) }] }, { timeoutMs: null });
    stop = typeof turn?.stopReason === 'string' ? turn.stopReason : null;
    // Grok ends the turn at a permission request that is answered no, and writes no answer:
    // stopReason "cancelled" with cancellationCategory "PermissionRejected" (seen with 1.0.77).
    rejected = stop === 'cancelled' && turn?._meta?.cancellationCategory === 'PermissionRejected';
  } catch (error) { failure = error; }
  const exit = await client.close();
  const details = { logFile, timedOut: exit.timedOut, stoppedBy: exit.stoppedBy, outputLimit: exit.outputLimit, exitCode: exit.code };
  if (failure) refuse(`${NAME} could not finish.`, { ...details, cause: failure.details?.cause ?? 'unknown', reason: String(failure.message).slice(0, 300) });
  // That turn did not fail: the no ended it. It says what was not allowed, with what a run
  // returns, and the runner reads it as a blocked turn whose session goes on at the next message.
  if (rejected && denials.length) refuse(`${NAME} ended its turn: ${denials.at(-1).summary} was not allowed.`, { ...details, cause: 'denied', session: sessionId, model, denials, effectiveMode: mode, approvals: decisions });
  if (stop !== 'end_turn') refuse(`${NAME} stopped early (${(stop ?? 'no stop reason').slice(0, 40)}).`, details);
  const value = extractJson(answer);
  if (!value) refuse(`${NAME} returned no JSON run result.`, details);
  return { result: validate(value), session: sessionId, model, costUsd: null, denials, effectiveMode: mode, exitCode: exit.code, log: logFile, approvals: decisions };
}
// The owner's home is the run env's HOME (process.env in a real run), where the token lives.
// Without a passed relay step ACP would let an outside write through unasked, so the runner
// must take the headless compile instead; this refusal keeps that choice safe.
export async function run(options) {
  gate(options.mode);
  // Over ACP no MCP server of ELU's reaches the session, and no relay of a bot that oversees: those turns run headless (compile).
  if (options.oversee === true || options[OVERSEE_FULL] === true || options.mcp?.names?.length) refuse(`A ${NAME} turn with MCP servers, or of a bot that oversees, runs headless, never over ACP.`);
  if (conformanceState('grok').relay !== true) refuse(`${NAME} can't ask live here. Blocked actions are reported.`);
  return acpRun({ ...options, home: realHome((options.env ?? process.env).HOME) });
}

// The one-time check, run against the resolved binary.
const stepRole = access => ({ vendor: 'grok', access, writablePaths: access === 'edit' ? ['.'] : [], commands: [], network: 'off', maxCostUsd: null, timeoutSeconds: STEP_SECONDS });
const firstLine = file => { try { return fs.readFileSync(file, 'utf8').split('\n').map(line => line.trim()).find(Boolean)?.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 300) ?? ''; } catch { return ''; } };
const stepDir = harness => fs.mkdtempSync(path.join(harness.scratch, 'grok-'));
// One headless run in the harness repository, in the locked profile unless told otherwise.
async function headless(harness, { bin, env, signal = null }, { prompt, mode = 'locked', resume = null }) {
  const runDir = stepDir(harness), session = crypto.randomUUID(), home = realHome(env.HOME);
  const child = agentEnv(env, [], childEnv({ mode, home }));
  prepareInput(prompt, { runDir });
  const args = argv({ role: stepRole(mode === 'locked' ? 'read' : 'edit'), mode, place: { kind: 'worktree' }, folders: [], cwd: harness.repo, protectedPaths: [], session, resume, peer: false, runDir, home, plain: !takesExtra('grok', bin) });
  const logFile = path.join(runDir, 'run.log');
  const exit = await runProcess({ bin, args, cwd: harness.repo, env: child, input: '', logFile, timeoutSeconds: STEP_SECONDS, signal });
  if (exit.code !== 0 || exit.timedOut || exit.outputLimit) throw new Error(`grok exited ${exit.timedOut ? 'by time limit' : exit.outputLimit ? 'by output limit' : String(exit.code)}: ${firstLine(exit.stderrFile) || firstLine(logFile)}`);
  return { ...parse(fs.readFileSync(logFile, 'utf8')), session };
}
// What `grok inspect --json` says of another tool's is really loaded into a turn, as { what,
// from, runs } rows. The shape is the one Grok Build 1.0.77 prints, watched signed out with
// Cursor and Claude files in its home and their switches on, then off:
// - An entry of projectInstructions, skills, mcpServers or hooks that came from another tool
//   carries vendor ("cursor", "claude") and compatibilityStatus: "enabled" when it loads,
//   "disabled" beside disabled: true when its switch is off, "unresolved" while Grok has not
//   decided. It is listed either way, with its path, and only a loaded one counts.
// - An entry with no vendor is Grok's own: a project's top-level CLAUDE.md, which Grok reads
//   as it reads AGENTS.md, and a built-in whatever it is called (the skill resume-cursor).
//   Nothing is matched by a name. An agent is listed with its file and never a vendor, so
//   one from a .claude or .cursor folder counts by that path; a plugin is read the same way.
// - permissions.sources names a Claude settings file when Grok has no config of its own.
// - externalCompat.cells has one row per switch: { vendor, surface, enabled, source }. A row
//   that is on counts when its surface puts something into a turn and none of its entries
//   was listed. sessions puts nothing there. A tool or surface ELU does not know is named
//   and never counts as something that runs.
// runs: a hook, an MCP server or a plugin, which run; the rest is text the model reads.
const TOOLS = Object.freeze({ claude: 'Claude', cursor: 'Cursor', codex: 'Codex' });
const SURFACES = Object.freeze({ skills: false, rules: false, agents: false, mcps: true, hooks: true });
// Per list: what an entry is called, whether it runs, the switch it stands under, and whether its path alone can name the tool.
const SECTIONS = Object.freeze({ projectInstructions: ['instructions', false, entry => entry.fileType === 'rules' ? 'rules' : 'agents', false], skills: ['skill', false, () => 'skills', false], agents: ['agent', false, () => null, true], mcpServers: ['MCP server', true, () => 'mcps', false], hooks: ['hook', true, () => 'hooks', false], plugins: ['plugin', true, () => null, true] });
const toolOf = file => /(^|\/)\.cursor(\/|$)/i.test(file) ? 'cursor' : /(^|\/)\.claude(\/|\.json$|$)/i.test(file) ? 'claude' : /(^|\/)\.codex(\/|$)/i.test(file) ? 'codex' : null;
const word = (value, most = 40) => String(value).replace(/[^\w .@/-]/g, '').slice(0, most);
const toolName = tool => TOOLS[tool] ?? word(tool);
const unloaded = entry => entry.disabled === true || (typeof entry.compatibilityStatus === 'string' && entry.compatibilityStatus !== 'enabled');
export function foreignTraces(value) {
  const out = [], listed = new Set();
  if (!value || typeof value !== 'object') return out;
  for (const [section, [kind, runs, surfaceOf, byPath]] of Object.entries(SECTIONS)) {
    for (const entry of Array.isArray(value[section]) ? value[section] : []) {
      if (!entry || typeof entry !== 'object' || ['builtin', 'bundled'].includes(entry.source?.type)) continue;
      const file = [entry.path, entry.source?.path].find(item => typeof item === 'string' && item) ?? null;
      const tool = typeof entry.vendor === 'string' && entry.vendor ? entry.vendor.toLowerCase() : byPath && file ? toolOf(file) : null;
      if (!tool) continue;
      const surface = surfaceOf(entry); if (surface) listed.add(`${tool}.${surface}`);
      if (unloaded(entry)) continue;
      out.push({ what: `${toolName(tool)} ${entry.fileType === 'rules' ? 'rule' : kind}${typeof entry.name === 'string' && entry.name ? ` ${word(entry.name, 60)}` : ''}`, from: file, runs });
    }
  }
  for (const source of Array.isArray(value.permissions?.sources) ? value.permissions.sources : []) {
    const file = typeof source === 'string' ? source.replace(/ \([^()]*\)$/, '') : '', tool = file ? toolOf(file) : null;
    if (tool) out.push({ what: `${toolName(tool)} permissions`, from: file, runs: false });
  }
  for (const cell of Array.isArray(value.externalCompat?.cells) ? value.externalCompat.cells : []) {
    if (cell?.enabled !== true || typeof cell.vendor !== 'string' || typeof cell.surface !== 'string' || cell.surface === 'sessions') continue;
    const tool = cell.vendor.toLowerCase(), surface = cell.surface.toLowerCase();
    if (listed.has(`${tool}.${surface}`)) continue;
    out.push({ what: `${toolName(tool)} ${word(surface)}`, from: `switched on${typeof cell.source === 'string' ? ` (${word(cell.source)})` : ''}`, runs: Object.hasOwn(TOOLS, tool) && SURFACES[surface] === true });
  }
  return out;
}
export const conformance = Object.freeze([
  { id: 'signin', required: true, async run(harness, { bin, env }) {
    const child = agentEnv(env, [], childEnv({ mode: 'ask', home: realHome(env.HOME) }));
    if (!signedIn({ env: child })) throw new Error('not signed in; sign it in with s on its line in the Usage tab');
    const client = await startAcp({ bin, args: ['--no-auto-update', 'agent', 'stdio'], cwd: harness.repo, env: child, logFile: path.join(stepDir(harness), 'signin.log'), timeoutSeconds: STEP_SECONDS });
    try {
      const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (!(init?.authMethods ?? []).some(method => method?.id === 'cached_token')) throw new Error('the agent offers no cached token; sign it in with s on its line in the Usage tab');
      await client.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } });
    } finally { await client.close(); }
  } },
  { id: 'locked-no-write', required: true, async run(harness, ctx) {
    const inside = path.join(harness.repo, 'created.txt'), outside = path.join(path.dirname(harness.outsideFile), 'created.txt');
    await headless(harness, ctx, { prompt: `Create a file at ${inside} and another at ${outside}, each containing the word created. Then reply.` });
    for (const file of [inside, outside]) if (fs.existsSync(file)) throw violation(`locked run wrote a file: ${path.basename(file)}`);
    if (execute('git', ['status', '--porcelain'], { cwd: harness.repo }).stdout.trim()) throw violation('locked run changed the repository');
  } },
  { id: 'locked-no-shell', required: true, async run(harness, ctx) {
    await headless(harness, ctx, { prompt: `Run the shell command ${harness.marker.command} and reply with its output.` });
    if (harness.marker.ran()) throw violation('locked run ran a shell command');
  } },
  { id: 'locked-no-network', required: true, async run(harness, ctx) {
    await headless(harness, ctx, { prompt: `Fetch ${harness.listener.url} and reply with the HTTP status.` });
    if (harness.listener.hits() > 0) throw violation('locked run reached the network');
  } },
  { id: 'json', required: true, async run(harness, ctx) {
    const token = crypto.randomUUID();
    const { result } = await headless(harness, ctx, { prompt: `Reply done with the summary "Conformance json ${token}".` });
    if (result.outcome !== 'done' || !result.summary.includes(token)) throw new Error('the headless result did not follow the schema and prompt');
  } },
  { id: 'resume', required: true, async run(harness, ctx) {
    const token = crypto.randomUUID();
    const first = await headless(harness, ctx, { prompt: `Remember this nonce: ${token}. Reply done with the summary "noted".` });
    const second = await headless(harness, ctx, { prompt: 'What nonce did I give you earlier? Reply done with the nonce as the summary.', resume: first.session });
    if (!second.result.summary.includes(token)) throw new Error('the resumed session did not remember the first turn');
  } },
  { id: 'relay', required: false, async run(harness, { bin, env, signal = null }) {
    const outside = path.join(path.dirname(harness.outsideFile), 'relay.txt'), requests = [];
    const approvals = { request: ({ id, tool, title }) => { requests.push({ id, tool, title }); return { id, summary: title ?? tool }; }, await: async () => 'deny' };
    // The step answers no. Grok then ends its turn (acpRun: cause "denied"), which is the relay
    // working: the request came, the answer was taken, and the file below must not exist.
    try { await acpRun({ bin, role: stepRole('edit'), mode: 'ask', cwd: harness.repo, prompt: `Create a file at ${outside} containing the word relay. Then reply.`, approvals, env, logFile: path.join(stepDir(harness), 'relay.log'), timeoutSeconds: STEP_SECONDS, home: realHome(env.HOME), signal }); }
    catch (error) { if (fs.existsSync(outside)) throw new Error('a denied write happened'); if (error?.details?.cause !== 'denied') throw error; }
    if (fs.existsSync(outside)) throw new Error('a denied write happened');
    if (!requests.length) throw new Error('no permission request arrived over ACP');
  } },
  // What else Grok loads on this computer. Never required: what it finds is said once, and
  // what runs is asked once outside Full access (lib/vendor-check.mjs).
  { id: 'isolation', required: false, async run(harness, { bin, env }) {
    const child = agentEnv(env, [], childEnv({ mode: 'locked', home: realHome(env.HOME) }));
    const result = await capture(bin, ['--no-auto-update', 'inspect', '--json'], { cwd: harness.repo, env: child, timeoutMs: 60000 });
    if (result.code !== 0) throw new Error(`grok inspect ${result.timedOut ? 'gave no answer within 60 seconds' : `exited ${result.code}`}: ${result.stderr.trim().split('\n')[0]?.slice(0, 200) ?? ''}`);
    let value; try { value = JSON.parse(result.stdout); } catch { throw new Error('grok inspect --json printed no JSON'); }
    const loads = foreignTraces(value);
    if (loads.length) throw Object.assign(new Error(`it also loads ${loads.slice(0, 3).map(loadText).join(', ')}${loads.length > 3 ? `, and ${loads.length - 3} more` : ''}`), { loads });
  } },
]);

// The relay hook of a turn that oversees (overseeArgv): node grok.mjs relay <its run file>. Not
// awaited here: the relay's modules lead back to this one, which must finish loading first.
if (process.argv[2] === 'relay' && process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(GROK_SCRIPT)) {
  process.stdout.on('error', () => process.exit(0));
  relayMain(process.argv[3]).then(() => process.exit(0), () => process.exit(1));
}
