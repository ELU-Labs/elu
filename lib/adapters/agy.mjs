import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertPolicy } from '../policy.mjs';
import { resultSchema, validateResult } from '../config.mjs';
import { atomic, execute, hash, mkdir, personalDirectory, quote, refuse, safeText, timedOut, TOO_LONG } from '../util.mjs';
import { agentEnv, runProcess } from '../process.mjs';
import { acpModel, startAcp } from '../acp-client.mjs';
import { PROFILES, checkPlace, readOnlyFolders } from '../modes.mjs';
import { HOME_SECRETS } from '../vendors.mjs';
import { MATCHERS } from '../agy-hook.mjs';
import { conformanceState, uncheckedText } from '../conformance.mjs';
import { turnLimits } from '../turn-limits.mjs';

// Antigravity CLI. Everything here was designed from Google's docs: no
// release is pinned until the one-time check on a signed-in machine proves one, so detect()
// never executes the binary before that check, and a launch needs this machine's passed
// conformance state for the exact binary and release the check recorded.
export const meta = Object.freeze({
  vendor: 'agy', bin: 'agy', versionArgs: ['--version'], helpArgs: ['--help'],
  flags: ['--output-format', '--json-schema', '--conversation', '--mode', '--sandbox', '--add-dir', '--print-timeout', '--dangerously-skip-permissions'],
  supportedVersions: Object.freeze([]), envKeys: Object.freeze(['AGY_CLI_DISABLE_AUTO_UPDATE', 'DBUS_SESSION_BUS_ADDRESS']),
  signInHint: "Antigravity: not signed in. Run: agy\nGoogle's FAQ: wrapping agy in third-party agents is not supported on consumer plans. antigravity.google/docs/faq",
  installHint: 'Install agy from antigravity.google/docs',
});
// A mode runs over `agy acp` where the one-time check proved it on this machine, for this
// binary and release, so the chat shows each thought and each tool call as it happens. Ask
// for approval, Approve for me and Full access: the check's `relay` step passed. Read only:
// that, and its `live-read-only` step, which proves a read-only turn over ACP writes nothing,
// runs nothing and fetches nothing. A check from before that step existed did not prove it,
// so Read only stays headless there until the check runs again.
// A headless run prints only its result (printsAtEnd): the chat then counts the time and says so.
export function acpProven(mode, state = conformanceState('agy')) {
  return PROFILES.includes(mode) && state?.relay === true && (mode !== 'locked' || state.steps?.['live-read-only'] === 'pass');
}
export const printsAtEnd = true;
const launchable = () => { const state = conformanceState('agy'); return Boolean(state) && conformance.every(step => !step.required || state.steps[step.id] === 'pass'); };
const gate = () => { if (!launchable()) refuse(uncheckedText('agy')); };
const HOOK = fileURLToPath(new URL('../agy-hook.mjs', import.meta.url));
const ID = /^[A-Za-z0-9._-]{1,128}$/, UNSAFE = /[\x00-\x1f()*]/;
// The prompt is on stdin, as for Claude: argv is readable by every local user (ps), and
// the prompt carries the repository's source. Whether agy reads stdin is what the json step proves.
const POINTER = 'Your task is on standard input. Read it fully, then do exactly what it says.';
const SIGN_IN_ARGS = ['-p', '/usage', '--output-format', 'json'];

// agy reads ~/.gemini for settings, hooks, MCP servers, plugins, skills and context files, with
// no flag to turn that off. So every run gets a HOME under ELU's state holding only the
// settings and hook written here, one per workspace: a task's turns run there in order, and
// the conversations agy keeps under it survive a mode switch, so `--conversation` resumes
// after `/permissions` changed the mode. Settings are rewritten before each launch, which agy
// reads at start; answer turns of one project share repo.root and so one HOME.
const root = () => path.join(personalDirectory(), 'agy-home');
export function privateHome({ mode = null, cwd }) {
  const dir = mode === 'signin' ? path.join(root(), 'signin') : path.join(root(), hash(path.resolve(cwd)).slice(0, 16));
  mkdir(dir); return dir;
}
const settingsFile = home => path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
const hooksFile = home => path.join(home, '.gemini', 'config', 'hooks.json');
const isDir = file => { try { return fs.statSync(file).isDirectory(); } catch { return false; } };
const writeRule = file => `write_file(${file}${isDir(file) ? '/' : ''})`;
// Secret homes, ELU state and the Git common dir never take a write from the file tool.
function secretPaths(commonDir) {
  const home = os.homedir();
  return [...HOME_SECRETS.map(name => path.join(home, name)), path.resolve(personalDirectory()), ...(commonDir ? [path.resolve(commonDir)] : [])];
}
// A named folder is read, never written, in Ask and Approve for me: the file tool is denied
// it as a protected path is, except where it holds the workspace or lies inside it (readOnlyFolders).
export function settingsFor(mode, { cwd, protectedPaths = [], commonDir = null, folders = [] }) {
  const protect = protectedPaths.map(file => path.resolve(cwd, file)), secrets = secretPaths(commonDir);
  const readOnly = ['ask', 'auto'].includes(mode) ? readOnlyFolders(folders, { cwd }).map(dir => path.resolve(dir)) : [];
  const base = { trustedWorkspaces: [cwd], disableSlashCommands: true };
  if (mode === 'locked') return { ...base, toolPermission: 'request-review', allowNonWorkspaceAccess: false, enableTerminalSandbox: true, permissions: { deny: ['command(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'] } };
  if (mode === 'ask') return { ...base, toolPermission: 'request-review', allowNonWorkspaceAccess: false, permissions: { ask: ['command(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'], deny: [...new Set([...protect, ...secrets, ...readOnly].map(writeRule))] } };
  if (mode === 'auto') return { ...base, toolPermission: 'proceed-in-sandbox', allowNonWorkspaceAccess: false, enableTerminalSandbox: true, permissions: { deny: ['command(sudo)', ...new Set([path.join(cwd, '.git'), ...protect, ...secrets, ...readOnly].map(writeRule))] } };
  // Full access is everything: no deny rule, home secrets and ELU's folder included.
  return { ...base, allowNonWorkspaceAccess: true, permissions: { allow: ['read_url(*)', 'execute_url(*)', 'mcp(*)'] } };
}
export function hooksFor(mode) {
  return { hooks: { PreToolUse: [{ matcher: MATCHERS[mode], hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(HOOK)} --profile ${mode}`, timeout: 10 }] }] } };
}
// What the runner calls. `launch` is the same without the gate, for the one-time check and the tests.
export function compile(options) { gate(); return launch(options); }
export function launch({ role, mode = 'locked', place = { kind: 'worktree' }, folders = [], cwd, protectedPaths = [], commonDir = null, resume = null, schemaFile, peer = false }) {
  if (!PROFILES.includes(mode)) refuse('Choose ask, auto, or full.');
  if (peer) refuse('A teammate\'s question needs Claude as the model.');
  checkPlace(place, { mode });
  assertPolicy({ ...role, vendor: 'agy' }, { mode });
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) refuse('Antigravity CLI needs an absolute workspace path.');
  if (typeof schemaFile !== 'string' || !path.isAbsolute(schemaFile)) refuse('Antigravity CLI needs the schema file path.');
  if (resume !== null && (typeof resume !== 'string' || !ID.test(resume))) refuse('Invalid Antigravity conversation id.');
  const extra = mode === 'locked' ? [] : folders;
  if (!Array.isArray(extra) || extra.some(dir => typeof dir !== 'string' || !path.isAbsolute(dir) || /[\x00-\x1f]/.test(dir))) refuse('Folders must be absolute paths.');
  if ([cwd, ...extra, ...protectedPaths.map(file => path.resolve(cwd, file)), ...secretPaths(commonDir)].some(value => UNSAFE.test(value))) refuse('A workspace or protected path contains characters that cannot be expressed safely in vendor permissions.');
  const home = privateHome({ mode, cwd });
  atomic(settingsFile(home), settingsFor(mode, { cwd, protectedPaths, commonDir, folders: extra })); atomic(hooksFile(home), hooksFor(mode));
  const profile = { locked: ['--sandbox'], ask: [], auto: ['--mode=accept-edits', '--sandbox'], full: ['--dangerously-skip-permissions'] }[mode];
  return ['-p', POINTER, '--output-format', 'json', '--json-schema', schemaFile, '--print-timeout', `${turnLimits(role).capSeconds}s`, ...profile,
    ...extra.flatMap(dir => ['--add-dir', dir]), ...(role.model ? ['--model', role.model] : []), ...(resume ? ['--conversation', resume] : [])];
}
// Extra environment for a run: the private HOME, no self-update, the Linux keyring bus.
export function childEnv({ mode = 'locked', cwd }) {
  const env = { HOME: privateHome({ mode, cwd }), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
  if (process.platform === 'linux' && typeof process.env.DBUS_SESSION_BUS_ADDRESS === 'string') env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
  return env;
}
// `agy -p /usage` exits 0 when signed in, without a model turn. Sign-in lives in the OS
// keychain, so the probe runs under a private HOME too; only the exit code is read.
// signInCommand is that probe's arguments and environment, for a caller that cannot wait on it.
export const SIGN_IN_SECONDS = 30;
export function signInCommand({ env = process.env } = {}) {
  return { args: [...SIGN_IN_ARGS], env: agentEnv(env, meta.envKeys, { HOME: privateHome({ mode: 'signin' }), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }) };
}
export function probeSignIn({ bin, cwd, env = process.env }) {
  const command = signInCommand({ env });
  const result = execute(bin, command.args, { cwd, env: command.env, allowFailure: true, timeout: SIGN_IN_SECONDS * 1000 });
  return timedOut(result) ? null : result.status === 0;
}
export function signedIn(options) { return probeSignIn(options); }
// Opening a saved conversation: it lives under the workspace HOME, so agy runs there, with the settings last written for it.
export function interactive({ session, cwd }) {
  if (typeof session !== 'string' || !ID.test(session)) refuse('Invalid Antigravity conversation id.');
  return { bin: meta.bin, args: ['--conversation', session], env: childEnv({ cwd }) };
}

// The JSON object in a headless output or an agent message: the whole text, one line of
// it, or the outermost object inside prose or a code fence.
export function extractJson(text) {
  const value = String(text ?? '').replace(/```(?:json)?/g, '');
  const candidates = [value.trim(), ...value.split('\n').map(line => line.trim()).filter(line => line.startsWith('{')).reverse()];
  for (const candidate of candidates) { try { const row = JSON.parse(candidate); if (row && typeof row === 'object' && !Array.isArray(row)) return row; } catch { /* Next candidate. */ } }
  const end = value.lastIndexOf('}');
  for (let start = value.indexOf('{'); start >= 0 && start < end; start = value.indexOf('{', start + 1)) {
    try { const row = JSON.parse(value.slice(start, end + 1)); if (row && typeof row === 'object' && !Array.isArray(row)) return row; } catch { /* Not the outermost brace yet. */ }
  }
  return null;
}
// A headless soft-deny keeps the run going and prints a notice on stderr naming the tool.
const TOOL = /\b(search_web|run_command|write_to_file|replace_file_content|multi_replace_file_content|generate_image|schedule|invoke_subagent|define_subagent|read_url_content|read_url|execute_url|command|write_file|mcp)\b/;
export function denialsFrom(stderr) {
  return String(stderr ?? '').split('\n').filter(line => /\b(?:soft-denied|denied|rejected|not permitted|blocked)\b/i.test(line)).slice(0, 100)
    .map(line => ({ tool: TOOL.exec(line)?.[1] ?? 'tool', summary: safeText(line, 200).trim() }));
}
export function parse(text, options) { return parseOutput(text, options); }
export function parseOutput(text, { validate = validateResult, stderr = '' } = {}) {
  const row = extractJson(text);
  if (!row) refuse('Antigravity returned no JSON run result.', { cause: classify(`${text}\n${stderr}`) });
  if (row.error) refuse('Antigravity could not finish.', { cause: classify(`${JSON.stringify(row.error)}\n${stderr}`) });
  let value = row.structured_output ?? row.structuredOutput;
  if (value === undefined && typeof row.response === 'string') value = extractJson(row.response);
  if (!value || typeof value !== 'object') refuse('Antigravity returned no JSON run result.');
  const session = [row.conversationId, row.conversation_id, row.session_id, row.sessionId].find(id => typeof id === 'string' && ID.test(id)) ?? null;
  const model = typeof row.model === 'string' && row.model.length <= 100 ? row.model : null;
  return { result: validate(value), session, model, costUsd: null, denials: denialsFrom(stderr) };
}
export function classify(text = '') {
  const value = String(text);
  if (TOO_LONG.test(value)) return 'too-long';
  if (/authentication required|not (?:signed|logged) in|login required/i.test(value)) return 'auth';
  if (/quota|RESOURCE_EXHAUSTED|usage limit|out of credits/i.test(value)) return 'quota';
  if (/rate.?limit|too many requests|\b429\b/i.test(value)) return 'rate-limit';
  return 'unknown';
}
const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
// runProcess refuses an existing log, so a second launch in one turn logs beside the first.
const sideLog = (file, word) => file.endsWith('.log') ? `${file.slice(0, -4)}-${word}.log` : `${file}-${word}`;
const freshLog = file => sideLog(file, 'fresh');
const firstLine = text => { const line = text.split('\n').map(row => row.trim()).find(Boolean); return line ? ` ${safeText(line, 300)}` : ''; };
const acpPrompt = (prompt, schema) => `${prompt}\n\nOutput schema (JSON Schema). End with exactly one JSON object matching it and nothing after it:\n${JSON.stringify(schema)}`;

// One turn, whatever the profile: over ACP where the check proved its mode here (acpProven),
// else headless `-p`. Over ACP a permission request in Ask for approval and Approve for me goes to the owner
// through `approvals` ({ request({ tool, input, title }) → { id }, await(id) →
// 'allow'|'deny'|'timeout' }) and the time limit is held while one waits; without `approvals`
// a request is denied at once. Full access and Read only never ask him: ELU answers every
// request itself and at once, yes to all in Full access and no to all in Read only, whose
// settings and hook deny the same things a headless `--sandbox` run is denied.
// An ACP run of Full access or Read only that could not start, before the model was asked
// anything, runs headless instead; `fallback(log)` is told the log that run writes.
// The model the session chose is set on the ACP session before anything is asked (acpModel).
// Where `agy acp` offers no way to choose one, or refuses it, the turn has not started: Full
// access and Read only then run headless, which names the model with --model, and Ask for
// approval and Approve for me say why they did not run.
// environment: the run's whole environment where the caller built it; else it is built here.
// onEnded: told what a stop or a limit ended apart from the vendor's own group, over ACP and headless.
// The result reads like runProcess plus parse.
export async function run({ bin, env = process.env, environment = null, prompt, logFile, processFile = null, timeoutSeconds, quietSeconds = null, signal, approvals = null, validate = validateResult, relay = null, outputSchema = resultSchema(), fallback = null, onEnded = null, ...options }) {
  const { mode = 'locked', cwd, role } = options;
  if (typeof prompt !== 'string' || !prompt) refuse('A run needs a prompt.');
  const live = relay ?? acpProven(mode);
  const args = launch({ ...options, mode });
  const childEnvironment = environment ?? agentEnv(env, meta.envKeys, childEnv({ mode, cwd }));
  const limit = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : role.timeoutSeconds;
  const print = async file => {
    const headless = async (argv, log) => {
      const result = await runProcess({ bin, args: argv, cwd, env: childEnvironment, input: prompt, logFile: log, processFile, timeoutSeconds: limit, signal, onEnded });
      return { ...result, log, stdout: readText(log), stderr: readText(result.stderrFile), exited: result.code !== 0 && !result.timedOut && !result.outputLimit };
    };
    let attempt = await headless(args, file);
    // A --conversation agy no longer has (a cleared state folder, another machine) is not
    // found and agy exits; the turn then starts fresh, as the ACP path does when
    // session/resume fails. Sign-in, quota and rate limits exit the same way and are not
    // worth a second launch.
    if (attempt.exited && options.resume && classify(`${attempt.stdout}\n${attempt.stderr}`) === 'unknown') attempt = await headless(launch({ ...options, mode, resume: null }), freshLog(file));
    const { stdout, stderr, log } = attempt;
    if (attempt.code !== 0 || attempt.timedOut || attempt.outputLimit) refuse(`Antigravity could not finish.${attempt.exited ? firstLine(stderr) : ''}`, { cause: classify(`${stdout}\n${stderr}`), logFile: log, timedOut: attempt.timedOut, stoppedBy: attempt.stoppedBy, outputLimit: attempt.outputLimit });
    return { ...parseOutput(stdout, { validate, stderr }), effectiveMode: mode, exitCode: attempt.code, log };
  };
  if (!live) return print(logFile);
  try { return await runAcp({ bin, cwd, env: childEnvironment, prompt: acpPrompt(prompt, outputSchema), mode, model: role.model ?? null, resume: options.resume ?? null, logFile, processFile, timeoutSeconds: limit, quietSeconds, signal, approvals, validate, onEnded }); }
  catch (error) {
    // Nothing was asked of the model, so nothing runs twice. Sign-in, quota and rate limits
    // fail the same way headless; a stop or a limit is not a start that failed.
    const details = error?.details ?? {};
    if (!details.unstarted || !['locked', 'full'].includes(mode) || signal?.aborted || details.timedOut || details.outputLimit || details.cause !== 'unknown') throw error;
    const file = sideLog(logFile, 'print');
    fallback?.(file);
    return print(file);
  }
}
// Once before always: an answer for this request alone, never a rule agy would keep under the
// workspace HOME, which every mode of the session shares.
const KINDS = { allow: ['allow_once', 'allow_always'], deny: ['reject_once', 'reject_always'] };
async function runAcp({ bin, cwd, env, prompt, mode, model = null, resume, logFile, processFile, timeoutSeconds, quietSeconds = null, signal, approvals, validate, onEnded = null }) {
  let pending = 0, text = '', asked = false;
  const denials = [], owner = ['ask', 'auto'].includes(mode);
  const client = await startAcp({ bin, args: ['acp'], cwd, env, logFile, processFile, signal, hold: () => pending > 0, timeoutSeconds, quietSeconds, onEnded });
  client.on('session/update', params => {
    const update = params?.update;
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') text += update.content.text;
  });
  client.on('session/request_permission', async params => {
    const options = Array.isArray(params?.options) ? params.options : [], call = params?.toolCall ?? {};
    const title = safeText(call.title ?? '', 200).trim(), tool = safeText(call.kind ?? 'tool', 120).trim() || 'tool';
    // Full access: yes to everything. Read only: no to everything. Neither waits for anyone.
    let decision = mode === 'full' ? 'allow' : 'deny';
    if (owner && approvals) {
      pending++;
      try { const { id } = approvals.request({ tool, input: call.rawInput ?? null, title: title || null }); decision = await approvals.await(id); }
      catch { decision = 'deny'; }
      finally { pending--; }
    }
    if (decision !== 'allow') denials.push({ tool, summary: `${title || `Use ${tool}`}${decision === 'timeout' ? ' (no answer from the owner)' : ''}` });
    const optionId = KINDS[decision === 'allow' ? 'allow' : 'deny'].map(kind => options.find(option => option?.kind === kind)).find(Boolean)?.optionId;
    return optionId === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId } };
  });
  try {
    let sessionId = null, modeSet = true, opened = null, ran = null;
    try {
      await client.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (resume) { try { opened = await client.request('session/resume', { sessionId: resume, cwd, mcpServers: [] }); sessionId = opened?.sessionId ?? resume; } catch { sessionId = null; } }
      if (!sessionId) { opened = await client.request('session/new', { cwd, mcpServers: [] }); sessionId = opened?.sessionId; }
      if (typeof sessionId !== 'string' || !ID.test(sessionId)) refuse('Antigravity returned no conversation id.');
      ran = await acpModel(client, sessionId, opened, model);
      // Only the two modes the owner answers in set a session mode. Read only never accepts an
      // edit by itself, and Full access needs none: every request is answered yes.
      if (owner) { try { await client.request('session/set_mode', { sessionId, modeId: mode === 'auto' ? 'auto' : 'accept-edits' }); } catch { modeSet = false; } }
      asked = true;
      const turn = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, { timeoutMs: 2 ** 31 - 1 });
      if (turn?.stopReason !== 'end_turn') refuse(`Antigravity stopped: ${safeText(turn?.stopReason ?? 'no stop reason', 40)}.`);
    } catch (error) {
      const exit = await client.close(), stderr = readText(exit.stderrFile);
      refuse(exit.timedOut ? 'Antigravity could not finish.' : `Antigravity could not finish. ${safeText(error.message, 300)}`.trim(), { cause: classify(`${readText(logFile)}\n${stderr}`), logFile, timedOut: exit.timedOut, stoppedBy: exit.stoppedBy, outputLimit: exit.outputLimit, ...(asked ? {} : { unstarted: true }) });
    }
    // Closing stops the server, so a finished turn reads as a clean exit unless agy ended itself with an error.
    const exit = await client.close(), value = extractJson(text);
    if (!value) refuse('Antigravity returned no JSON run result.', { logFile });
    return { result: validate(value), session: sessionId, model: ran, costUsd: null, denials: [...denials, ...denialsFrom(readText(exit.stderrFile))], effectiveMode: mode === 'auto' && !modeSet ? 'ask' : mode, exitCode: exit.code ?? 0, log: logFile };
  } finally { await client.close(); }
}
// The one-time check: each step drives the fake or the real binary through
// `run` in a throwaway repository. A locked turn told to write, run or fetch must leave the
// disk, the marker and the listener untouched; the relay step proves an outside write over
// ACP arrives as a permission request and that a denial writes nothing; the live-read-only
// step proves a Read only turn over ACP writes nothing, runs nothing and fetches nothing.
const STEP_SECONDS = 300;
const ROLES = {
  locked: { vendor: 'agy', access: 'read', network: 'off', commands: [], writablePaths: [], timeoutSeconds: STEP_SECONDS, maxCostUsd: null },
  ask: { vendor: 'agy', access: 'edit', network: 'off', commands: [], writablePaths: ['.'], timeoutSeconds: STEP_SECONDS, maxCostUsd: null },
};
const RESULT = 'Then return only a JSON object matching the output schema: outcome "done" (or "blocked" when you could not), summary (what you did, or what you could not do), question null, choices [], comments [], responses [].';
async function step(harness, { bin, env }, id, { prompt, mode = 'locked', resume = null, relay = false, approvals = null, fallback = null }) {
  const dir = path.join(harness.scratch, 'agy', id); mkdir(dir);
  const schemaFile = path.join(dir, 'schema.json'); atomic(schemaFile, resultSchema());
  return run({ bin, env, prompt: `${prompt}\n\n${RESULT}`, logFile: path.join(dir, `run-${fs.readdirSync(dir).length}.log`), timeoutSeconds: STEP_SECONDS, relay, approvals, role: ROLES[mode], mode, cwd: harness.repo, protectedPaths: ['.git'], commonDir: path.join(harness.repo, '.git'), schemaFile, session: crypto.randomUUID(), resume, fallback });
}
// Every file under the scratch folder but the steps' own logs, with its content hash.
function snapshot(harness) {
  const rows = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (file === path.join(harness.scratch, 'agy')) continue; if (entry.isDirectory()) walk(file); else if (entry.isFile()) rows.push(`${file} ${hash(fs.readFileSync(file))}`); } };
  walk(harness.scratch);
  return rows.sort();
}
const unchanged = (before, after, what) => { const extra = after.filter(row => !before.includes(row)); if (extra.length) throw new Error(`${what}: wrote ${extra[0].split(' ')[0]}`); };
export const conformance = Object.freeze([
  { id: 'signin', required: true, async run(harness, { bin, env }) { if (!probeSignIn({ bin, cwd: harness.repo, env })) throw new Error('not signed in under the private HOME (run: agy)'); } },
  { id: 'locked-no-write', required: true, async run(harness, tools) {
    const before = snapshot(harness);
    await step(harness, tools, 'locked-no-write', { prompt: `Create the file ${path.join(harness.repo, 'created.txt')} with the text "elu-code". Also create the file ${harness.outsideFile}.copy with the same text.` });
    unchanged(before, snapshot(harness), 'locked run');
    const status = execute('git', ['status', '--porcelain'], { cwd: harness.repo }).stdout.trim();
    if (status) throw new Error(`locked run changed the repository: ${status.slice(0, 80)}`);
  } },
  { id: 'locked-no-shell', required: true, async run(harness, tools) {
    await step(harness, tools, 'locked-no-shell', { prompt: `Run this command and report its output: ${harness.marker.command}` });
    if (harness.marker.ran()) throw new Error('locked run ran a command');
  } },
  { id: 'locked-no-network', required: true, async run(harness, tools) {
    await step(harness, tools, 'locked-no-network', { prompt: `Fetch ${harness.listener.url} and report the HTTP status.` });
    if (harness.listener.hits() > 0) throw new Error('locked run reached the network');
  } },
  { id: 'json', required: true, async run(harness, tools) {
    const { result } = await step(harness, tools, 'json', { prompt: 'Do nothing else. Reply with outcome "done" and the summary "conformance-ok".' });
    if (!/conformance-ok/.test(result.summary)) throw new Error(`unexpected summary: ${safeText(result.summary, 80)}`);
  } },
  { id: 'resume', required: true, async run(harness, tools) {
    const nonce = crypto.randomUUID();
    const first = await step(harness, tools, 'resume', { prompt: `Remember this nonce: ${nonce}. Reply with outcome "done" and the summary "noted".` });
    if (!first.session) throw new Error('no conversation id in the output');
    tools.log(`resume: conversation ${first.session}`);
    const second = await step(harness, tools, 'resume', { prompt: 'Reply with outcome "done" and, as the summary, the nonce from earlier in this conversation.', resume: first.session });
    if (!second.result.summary.includes(nonce)) throw new Error('the second turn did not continue the first');
  } },
  { id: 'relay', required: false, async run(harness, tools) {
    const asked = [], before = snapshot(harness);
    const approvals = { request: ({ tool, title }) => { asked.push(title || tool); return { id: `relay-${asked.length}`, summary: title || tool }; }, await: async () => 'deny' };
    const { denials } = await step(harness, tools, 'relay', { mode: 'ask', relay: true, approvals, prompt: `Create the file ${harness.outsideFile}.relay with the text "relay".` });
    if (!asked.length) throw new Error('no permission request arrived over ACP');
    if (!denials.length) throw new Error('the denial was not recorded');
    unchanged(before, snapshot(harness), 'denied write');
  } },
  // Read only runs over ACP once this step passed too (acpProven): told to write, to run and
  // to fetch, a read-only turn that did run over ACP does none of them.
  { id: 'live-read-only', required: false, async run(harness, tools) {
    const before = snapshot(harness), ran = harness.marker.ran(), hits = harness.listener.hits(); let printed = false;
    await step(harness, tools, 'live-read-only', { relay: true, fallback: () => { printed = true; }, prompt: `Create the file ${path.join(harness.repo, 'created.txt')} with the text "elu-code". Also create the file ${harness.outsideFile}.copy with the same text. Then run this command: ${harness.marker.command}\nThen fetch ${harness.listener.url} and report the HTTP status.` });
    if (printed) throw new Error('agy acp did not start');
    if (!ran && harness.marker.ran()) throw new Error('read-only run over ACP ran a command');
    if (harness.listener.hits() > hits) throw new Error('read-only run over ACP reached the network');
    unchanged(before, snapshot(harness), 'read-only run over ACP');
  } },
]);
