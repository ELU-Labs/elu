import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertPolicy, assertNoCodexProjectConfig } from '../policy.mjs';
import { validateResult } from '../config.mjs';
import { refuse, personalDirectoryNames, TOO_LONG } from '../util.mjs';
import { capture } from '../process.mjs';
import { HOME_SECRETS, MODEL_NAME, VENDOR_EFFORTS } from '../vendors.mjs';
import { PROFILES, readOnlyFolders } from '../modes.mjs';
import { refusedIn } from '../never-list.mjs';
import { shimsBase } from '../never-shims.mjs';

// Pinned releases, the flags an untested release must list, and how sign-in is read.
export const meta = Object.freeze({
  vendor: 'codex', bin: 'codex', versionArgs: ['--version'], helpArgs: ['exec', '--help'],
  flags: ['--ignore-user-config', '--ignore-rules', '--json', '--sandbox', '--cd', '--output-schema', '--config', '--skip-git-repo-check'],
  supportedVersions: Object.freeze(['0.166.0-alpha.5.1']), envKeys: Object.freeze([]), signInHint: 'Codex: sign in with ChatGPT. Run: codex login', installHint: 'npm i -g @openai/codex',
});
// Only a ChatGPT sign-in counts: `codex login status` exits 0 and prints "Logged in using
// ChatGPT". An API key also exits 0 (and prints a masked key), so the line is matched and
// the output is never shown.
export async function signedIn({ bin, cwd, env }) {
  const status = await capture(bin, ['login', 'status'], { cwd, env });
  if (status.timedOut) return null;
  return status.code === 0 && /Logged in using ChatGPT/.test(`${status.stdout}\n${status.stderr}`);
}
export const conformance = Object.freeze([]);

// Tools Codex may not offer in any profile; the shell features are added back by mode.
const OFF = ['hooks', 'apps', 'multi_agent', 'browser_use', 'code_mode', 'plugins', 'view_image', 'image_generation', 'computer_use', 'browser_use_external', 'browser_use_full_cdp_access', 'multi_agent_v2', 'code_mode_host', 'sleep_tool', 'goals', 'workspace_dependencies', 'skill_search', 'skill_mcp_dependency_install', 'remote_plugin', 'plugin_discovery_prefetch', 'tool_suggest', 'shell_snapshot', 'in_app_browser'];
// A session leaves the code-mode host at the release's default. On 0.166.0-alpha.5.1 every model
// in the catalog but one takes its tools only through that host: with it off no command and no
// file read ever starts, and the model can only ask. A reviewer has no tools, so it stays off there.
const off = shell => shell ? OFF.filter(feature => feature !== 'code_mode_host') : OFF;
const isolation = (shell) => ['-c', 'mcp_servers={}', '-c', 'tools.experimental_request_user_input.enabled=false', '-c', 'tools.update_plan.enabled=false',
  '-c', `features.shell_tool=${shell}`, '-c', `features.unified_exec=${shell}`, ...off(shell).flatMap(feature => ['-c', `features.${feature}=false`]),
  '-c', `shell_environment_policy.inherit="${shell ? 'core' : 'none'}"`, '-c', 'skills.bundled.enabled=false', '-c', 'skills.include_instructions=false'];
// A profile path is a TOML key; Codex reads glob characters in it as a pattern.
const UNSAFE = /[\x00-\x1f*?\[\]{}]/;
const toml = value => JSON.stringify(value);
const real = dir => { const resolved = path.resolve(dir); try { return fs.realpathSync(resolved); } catch { return resolved; } };
const spellings = dir => [...new Set([path.resolve(dir), real(dir)])];
// What a lead may never read, whatever the mode: home secrets, ELU's own state and
// the transcripts under the repository's common Git directory.
function deniedPaths(commonDir) {
  const home = real(os.homedir());
  return [...new Set([...HOME_SECRETS.map(name => path.join(home, name)), ...personalDirectoryNames().flatMap(spellings), ...(commonDir ? spellings(path.join(commonDir, 'elu-code')) : [])])];
}
// The elu_ask profile: the workspace sandbox for edit turns, read-only for
// answer turns, named folders read-only (except one that holds the workspace or lies in it,
// which Codex reads anyway), secrets and state denied. Protected files stay
// readable but not writable, the same rule the structural checks enforce afterwards, and so
// do the never list's stand-in commands, wherever a named folder reaches. The
// shared temp folders the workspace sandbox adds are taken back here: under a profile the
// sandbox_workspace_write.exclude_* keys do nothing, the two specials do.
function profile({ role, cwd, folders, protectedPaths, commonDir }) {
  const edit = role.access === 'edit';
  const entries = [...(edit ? [[':slash_tmp', 'read'], [':tmpdir', 'read']] : []), ...readOnlyFolders(folders, { cwd }).map(dir => [dir, 'read']), ...protectedPaths.map(p => [path.resolve(cwd, p), 'read']), ...spellings(shimsBase()).map(p => [p, 'read']), ...deniedPaths(commonDir).map(p => [p, 'deny'])];
  if ([cwd, ...entries.map(([p]) => p)].some(p => UNSAFE.test(p))) refuse('A workspace, folder or protected path contains characters that cannot be expressed safely in vendor permissions.');
  return `permissions.elu_ask={extends=${toml(edit ? ':workspace' : ':read-only')}, filesystem={${entries.map(([p, access]) => `${toml(p)}=${toml(access)}`).join(', ')}}}`;
}
// A role may name a model and an effort; a bot does. `codex exec --help` and `codex exec
// resume --help` (0.166.0-alpha.5.1) both list -m, --model; the effort is the config key
// model_reasoning_effort, and every model in that release's catalog takes these levels.
function modelArgs(role) {
  if (role.model != null && (typeof role.model !== 'string' || !MODEL_NAME.test(role.model))) refuse('A model name starts with a letter or digit, without spaces.');
  if (role.effort != null && !VENDOR_EFFORTS.codex.includes(role.effort)) refuse(`Effort on Codex is one of: ${VENDOR_EFFORTS.codex.join(', ')}.`);
  return [...(role.model ? ['--model', role.model] : []), ...(role.effort ? ['-c', `model_reasoning_effort=${toml(role.effort)}`] : [])];
}
// mode, place and folders are the session's permissions. Locked is the
// read-only reviewer launch, pinned by test/fixtures/argv-locked.json. The other modes set everything through -c keys so
// the same set applies to `exec resume`, which has no --sandbox or --cd; its cwd is the workspace.
export function compile({ role, mode = 'locked', place = { kind: 'worktree' }, folders = [], cwd, protectedPaths = [], commonDir, resume = null, schemaFile, peer = false }) {
  if (!PROFILES.includes(mode)) refuse('Choose ask, auto, or full.');
  if (mode === 'locked' && (place?.kind !== 'worktree' || folders.length)) refuse('A read-only run stays in the task worktree.');
  if (place?.kind === 'here' && mode !== 'full') refuse('Here needs Full access.');
  // A peer run needs the untracked-path denies only Claude expresses (CAPS.peer).
  if (peer) refuse('A teammate\'s question needs Claude as the model.');
  assertPolicy({ ...role, vendor: 'codex' }, { mode }); assertNoCodexProjectConfig(cwd);
  if (mode === 'locked') {
    if (role.access !== 'read') refuse('Codex cannot edit in Read only. Choose Ask for approval, Approve for me, or Full access.');
    return ['exec', '--ignore-user-config', '--ignore-rules', '--json', '--sandbox', 'read-only', '--cd', cwd, '--output-schema', schemaFile,
      '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', ...isolation(false), ...modelArgs(role), '-'];
  }
  const sandbox = mode === 'full'
    ? ['-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"', '-c', 'web_search="live"']
    : ['-c', 'default_permissions="elu_ask"', '-c', profile({ role, cwd, folders, protectedPaths, commonDir }),
      ...(mode === 'auto' ? ['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"'] : ['-c', 'approval_policy="never"']),
      '-c', 'web_search="disabled"'];
  // A project folder need not be a Git repository, so the repository check is skipped; the
  // workspace itself is chosen by ELU. Commands run in a plain shell: a login shell
  // builds PATH again with the system folders first, ahead of the never list's stand-in
  // commands in Ask for approval and Approve for me, which would then refuse nothing. Full
  // access has no stand-ins.
  return ['exec', ...(resume ? ['resume', resume] : []), '--ignore-user-config', '--ignore-rules', '--json', '--skip-git-repo-check', ...(resume ? [] : ['--cd', cwd]), '--output-schema', schemaFile, ...sandbox, '-c', 'allow_login_shell=false', ...isolation(true), ...modelArgs(role), '-'];
}
// Tool items a lead may produce by profile; a reviewer (locked) has no tools at all. An
// mcp_tool_call or any other kind means Codex started with something it was not given.
const LEAD_ITEMS = { locked: [], ask: ['command_execution', 'file_change'], auto: ['command_execution', 'file_change'], full: ['command_execution', 'file_change', 'web_search'] };
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
// What the owner reads about a declined item: the command, or the files a patch touched.
function denial(item) {
  if (item.type === 'command_execution') return { tool: 'command_execution', summary: `Run: ${clean(item.command)}`.slice(0, 200) };
  if (item.type === 'file_change') return { tool: 'file_change', summary: `Edit: ${clean((item.changes ?? []).map(change => change?.path).filter(Boolean).join(', '))}`.slice(0, 200) };
  return { tool: clean(item.type) || 'tool', summary: `Use ${clean(item.type) || 'a tool'}` };
}
// mode: the profile the run was launched with; the default is the read-only reviewer's rule, so a
// stream showing any tool item cannot report done. A lead's declined items become denials,
// and so does a step in which a stand-in command refused a never-list command (never: its name).
export function parse(text, { validate = validateResult, mode = 'locked' } = {}) {
  const allowed = LEAD_ITEMS[mode] ?? LEAD_ITEMS.locked;
  let session = null; let answer = null; let completed = false; let failed = false; const denials = [];
  for (const line of text.split('\n').filter((x) => x.trim())) {
    let row;
    try { row = JSON.parse(line); } catch { refuse('Codex returned a malformed JSON stream.'); }
    if (row.type === 'thread.started') session = row.thread_id;
    if (row.type === 'turn.completed') {completed = true;failed=false;}
    if (row.type === 'turn.failed' || row.type === 'error') failed = true;
    if (row.type === 'item.completed' && row.item?.type === 'agent_message') answer = row.item.text;
    if (row.type.startsWith('item.') && row.item && !['agent_message', 'reasoning','error','todo_list'].includes(row.item.type)) {
      if (!allowed.includes(row.item.type)) refuse(mode === 'locked' ? 'Codex exposed a tool that this reviewer must not have.' : 'Codex exposed a tool that this session must not have.');
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
 for(const line of text.split('\n')){let row;try{row=JSON.parse(line);}catch{continue;}if(row.type==='turn.completed')failure=null;if(row.type==='turn.failed'||row.type==='error')failure=row.error??row;}
 const value=JSON.stringify(failure??'');
 if(TOO_LONG.test(value))return'too-long';
 if(/usage_limit_reached|insufficient_quota|billing_hard_limit|hit your usage limit|credit balance.*(?:low|exhausted)|monthly spend limit/i.test(value))return'quota';
 if(/rate_limit|rate limit/i.test(value))return'rate-limit';
 return'unknown';
}
