import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertPolicy } from '../policy.mjs';
import { resultSchema, validateResult } from '../config.mjs';
import { EluCodeError, atomic, execute, lastObject, linesOf, mkdir, personalDirectory, personalDirectoryNames, refuse } from '../util.mjs';
import { checkPlace, PROFILES } from '../modes.mjs';
import { HOME_SECRETS, VENDOR_NAMES, signInCommand } from '../vendors.mjs';
import { agentEnv, capture, runProcess } from '../process.mjs';
import { mirrorHome } from '../home-mirror.mjs';
import { acpModel, startAcp } from '../acp-client.mjs';
import { approvalSummary } from '../approvals.mjs';
import { conformanceState, loadText, modeBlock, violation } from '../conformance.mjs';
import { takesExtra } from '../vendor-extras.mjs';

// Grok Build. Everything here was designed from the vendor's docs: no
// release is pinned until the one-time check proves one, so detect() never executes
// the binary, and a launch needs this machine's passed conformance state.
export const meta = Object.freeze({
  vendor: 'grok', bin: 'grok', versionArgs: ['--version'], helpArgs: ['--help'],
  flags: ['--output-format', '--permission-mode', '--sandbox', '--max-turns', '--cwd', '--no-auto-update', '--tools', '--disallowed-tools', '--allow', '--deny', '--prompt-file'],
  // Taken but no longer listed in --help since 1.0.77; Grok refuses an unknown flag (exit 2), so running it proves it.
  unlistedFlags: Object.freeze(['--no-auto-update']),
  // envKeys stays empty: no key variable (XAI_API_KEY) ever reaches a run; sign-in is grok login.
  supportedVersions: Object.freeze([]), envKeys: Object.freeze([]),
  signInHint: 'Grok Build: not signed in. Sign it in with s on its line in the Usage tab.', installHint: 'npm i -g @xai-official/grok',
});
const NAME = VENDOR_NAMES.grok;
const UNSAFE = /[\x00-\x1f,()*?\[\]{}]/;
const STEP_SECONDS = 180, FOREVER_MS = 2147483647;
// Turn caps per role kind: --max-turns is the only bound besides the role time limit. Full
// access has no cap of ours: it runs until Grok ends the turn, or the time limit does.
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
// Runs share the file; a run that reads one written for another profile still has
// the never list on its command line wherever it holds.
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
export const grokHome = () => path.join(privateHome(), '.grok');
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
  fs.symlinkSync(target, link);
}
export function prepareHome({ home, mode = 'locked', mirror = mode === 'full' } = {}) {
  const base = privateHome(), dir = grokHome();
  mkdir(path.join(dir, 'sessions'));
  atomic(path.join(dir, 'config.toml'), configToml(mode));
  atomic(path.join(dir, 'trusted_folders.toml'), TRUST_TOML);
  linkAuth(path.join(dir, 'auth.json'), path.join(realHome(home), '.grok', 'auth.json'));
  return { home: mirror ? mirrorHome({ home: realHome(home), mirror: fullHome(), own: { '.grok': dir } }) : base, grokHome: dir };
}
const checkProfile = mode => { if (!PROFILES.includes(mode)) refuse('Choose ask, auto, or full.'); return mode; };
// The env a run gets on top of agentEnv's allow-list. home is the owner's real home
// directory (where the token lives), never the private one.
export function childEnv({ mode = 'locked', home, mirror = mode === 'full' } = {}) {
  checkProfile(mode);
  const dirs = prepareHome({ home, mode, mirror });
  return { HOME: dirs.home, GROK_HOME: dirs.grokHome, ...SWITCHES, ...(mode === 'full' ? {} : LIMITS), ...(mode === 'locked' ? { GROK_WRITE_FILE: '0', GROK_WEB_FETCH: '0' } : {}) };
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
  return { args: signInCommand('grok', browser).split(' ').slice(1), env: agentEnv(env, [], childEnv({ mode: 'ask', home: realHome(env.HOME) })) };
}
// Grok has no schema flag: the schema rides in the prompt, and stdin is never read, so the
// prompt goes to <runDir>/prompt.txt, which compile names with --prompt-file.
export function prepareInput(text, { outputSchema = resultSchema(), runDir = null } = {}) {
  const prompt = `${text}\n\nOutput schema. Reply with exactly one JSON object matching it and nothing else:\n${JSON.stringify(outputSchema)}\n`;
  if (runDir) atomic(path.join(runDir, 'prompt.txt'), prompt);
  return prompt;
}
const secretRules = home => [
  ...HOME_SECRETS.flatMap(name => { const p = path.join(home, name); return [`Read(${p})`, `Read(${p}/**)`, `Grep(${p}/**)`]; }),
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
  if (peer) refuse('A teammate\'s question needs Claude as the model.');
  assertPolicy({ ...role, vendor: 'grok' }, { mode });
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) refuse('A Grok Build run needs an absolute workspace path.');
  // Full access passes no rule, so no path has to fit in one.
  if (mode !== 'full' && [cwd, home, ...protectedPaths, ...folders, ...role.writablePaths].some(p => UNSAFE.test(p))) refuse('A workspace, folder or protected path contains characters that cannot be expressed safely in vendor permissions.');
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
  if (mode === 'locked') return [...common, '--permission-mode', 'dontAsk', '--sandbox', 'read-only', '--tools', 'read_file,grep,list_dir', '--disallowed-tools', 'run_terminal_cmd,search_replace,web_search,web_fetch,spawn_subagent,Agent', '--disable-web-search', ...rules, ...identity];
  if (mode === 'full') return [...common, '--permission-mode', 'bypassPermissions', '--sandbox', 'off', ...rules, ...identity];
  // ask falls back here only when the relay step did not pass: dontAsk denies and reports.
  return [...common, '--permission-mode', mode === 'auto' ? 'auto' : 'dontAsk', '--sandbox', 'workspace', ...rules, ...identity];
}
// A launch needs this machine's check: every Grok behavior here comes from the vendor's docs
// until its required steps pass (docs/vendors/grok.md, "The one-time check"). A step that is
// not proven keeps Read only and the two asking modes off; Full access launches all the same.
const gate = mode => { const block = modeBlock('grok', { mode }); if (block) refuse(block); };
export function compile({ role, mode = 'locked', place = { kind: 'worktree' }, folders = [], cwd, protectedPaths = [], session, resume = null, peer = false, runDir = null, plain = false }) {
  gate(mode);
  return argv({ role, mode, place, folders, cwd, protectedPaths, session, resume, peer, runDir, home: os.homedir(), plain });
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
export function parse(text, { validate = validateResult } = {}) {
  const value = streamed(text) ?? lastJson(text ?? '');
  if (!value) refuse(`${NAME} returned no JSON result.`);
  if (value.type === 'error') refuse(`${NAME} could not finish.`, { cause: classify(text) });
  if (typeof value.text !== 'string') refuse(`${NAME} returned no JSON result.`);
  const answer = (typeof value.last === 'string' ? extractJson(value.last) : null) ?? extractJson(value.text);
  if (!answer) refuse(typeof value.stopReason === 'string' && value.stopReason !== 'end_turn' ? `${NAME} stopped early (${value.stopReason.slice(0, 40)}).` : `${NAME} returned no JSON run result.`);
  // Headless output carries no denial record: a blocked action reaches the model only.
  return { result: validate(answer), session: typeof value.sessionId === 'string' ? value.sessionId : null, model: modelOf(value), costUsd: costOf(value), denials: [], effectiveMode: null, usage: value.usage && typeof value.usage === 'object' ? value.usage : null };
}
export function classify(text = '') {
  const value = streamed(text) ?? lastJson(text ?? ''), message = value?.type === 'error' ? String(value.message ?? '') : '';
  if (/not logged in|log in|login|unauthori[sz]ed|authenticat|token|\b401\b/i.test(message)) return 'auth';
  if (/rate.?limit|too many requests|\b429\b/i.test(message)) return 'rate-limit';
  if (/quota|usage limit|limit reached|subscription|insufficient|billing|\b402\b/i.test(message)) return 'quota';
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
export function settleHome({ mode, home } = {}) { if (mode === 'full') mirrorHome({ home: realHome(home), mirror: fullHome(), own: { '.grok': grokHome() } }); }

// Ask and Auto over ACP: grok is an ACP server on stdio, and that is the only
// channel where a permission request can reach the owner. The relay turns each
// session/request_permission into an approval file and answers with the chosen option.
async function acpRun({ bin, role, mode, place = { kind: 'worktree' }, folders = [], cwd, protectedPaths = [], resume = null, outputSchema = resultSchema(), peer = false, prompt, approvals = null, env = process.env, logFile, processFile = null, signal, hold = null, timeoutSeconds = null, quietSeconds = null, validate = validateResult, home, onEnded = null }) {
  if (!['ask', 'auto'].includes(mode)) refuse(`${NAME} runs over ACP in Ask or Auto only.`);
  home = realHome(home);
  checkLaunch({ role, mode, place, folders, cwd, protectedPaths, peer, home });
  if (typeof bin !== 'string' || !path.isAbsolute(bin)) refuse(`A ${NAME} run needs the resolved binary path.`);
  if (typeof prompt !== 'string' || !prompt.trim()) refuse(`A ${NAME} run needs a prompt.`);
  if (approvals && (typeof approvals.request !== 'function' || typeof approvals.await !== 'function')) refuse('approvals needs request and await functions.');
  const child = agentEnv(env, [], childEnv({ mode, home }));
  // Rules go before the subcommand, where the docs put --no-auto-update; the never list is also in this profile's config.toml.
  // The model the session chose is an agent option: after `agent`, before the transport.
  const args = ['--no-auto-update', ...ruleFlags({ mode, role, cwd, folders, protectedPaths, home }), 'agent', ...(role.model ? ['--model', role.model] : []), 'stdio'];
  let pending = 0, requests = 0, answer = '', sessionId = null, stop = null, failure = null, model = null;
  const denials = [], decisions = [];
  const client = await startAcp({ bin, args, cwd, env: child, logFile, processFile, signal, hold: () => pending > 0 || Boolean(hold?.()), timeoutSeconds, quietSeconds, onEnded });
  client.on('session/update', params => { const update = params?.update; if (update?.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') answer += update.content.text; });
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
    const turn = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prepareInput(prompt, { outputSchema }) }] }, { timeoutMs: FOREVER_MS });
    stop = typeof turn?.stopReason === 'string' ? turn.stopReason : null;
  } catch (error) { failure = error; }
  const exit = await client.close();
  const details = { logFile, timedOut: exit.timedOut, stoppedBy: exit.stoppedBy, outputLimit: exit.outputLimit, exitCode: exit.code };
  if (failure) refuse(`${NAME} could not finish.`, { ...details, cause: failure.details?.cause ?? 'unknown', reason: String(failure.message).slice(0, 300) });
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
  if (conformanceState('grok').relay !== true) refuse(`${NAME} can't ask live here. Blocked actions are reported.`);
  return acpRun({ ...options, home: realHome((options.env ?? process.env).HOME) });
}

// The one-time check, run against the resolved binary.
const stepRole = access => ({ vendor: 'grok', access, writablePaths: access === 'edit' ? ['.'] : [], commands: [], network: 'off', maxCostUsd: null, timeoutSeconds: STEP_SECONDS });
const firstLine = file => { try { return fs.readFileSync(file, 'utf8').split('\n').map(line => line.trim()).find(Boolean)?.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 300) ?? ''; } catch { return ''; } };
const stepDir = harness => fs.mkdtempSync(path.join(harness.scratch, 'grok-'));
// One headless run in the harness repository, in the locked profile unless told otherwise.
async function headless(harness, { bin, env }, { prompt, mode = 'locked', resume = null }) {
  const runDir = stepDir(harness), session = crypto.randomUUID(), home = realHome(env.HOME);
  const child = agentEnv(env, [], childEnv({ mode, home }));
  prepareInput(prompt, { runDir });
  const args = argv({ role: stepRole(mode === 'locked' ? 'read' : 'edit'), mode, place: { kind: 'worktree' }, folders: [], cwd: harness.repo, protectedPaths: [], session, resume, peer: false, runDir, home, plain: !takesExtra('grok', bin) });
  const logFile = path.join(runDir, 'run.log');
  const exit = await runProcess({ bin, args, cwd: harness.repo, env: child, input: '', logFile, timeoutSeconds: STEP_SECONDS });
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
  { id: 'relay', required: false, async run(harness, { bin, env }) {
    const outside = path.join(path.dirname(harness.outsideFile), 'relay.txt'), requests = [];
    const approvals = { request: ({ id, tool, title }) => { requests.push({ id, tool, title }); return { id, summary: title ?? tool }; }, await: async () => 'deny' };
    try { await acpRun({ bin, role: stepRole('edit'), mode: 'ask', cwd: harness.repo, prompt: `Create a file at ${outside} containing the word relay. Then reply.`, approvals, env, logFile: path.join(stepDir(harness), 'relay.log'), timeoutSeconds: STEP_SECONDS, home: realHome(env.HOME) }); }
    catch (error) { if (fs.existsSync(outside)) throw new Error('a denied write happened'); throw error; }
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
