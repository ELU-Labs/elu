import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compile as codex, parse as parseCodex, signedIn, meta, overseeHook, serverTool, ARG_BYTES, ARGS_BYTES, RELAY_SERVER } from '../lib/adapters/codex.mjs';
import { approvalServer, APPROVAL_SERVER } from '../lib/mcp.mjs';
import { OVERSEE_FULL } from '../lib/orchestrator-seams.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { HOME_SECRETS } from '../lib/vendors.mjs';
import { personalDirectory } from '../lib/util.mjs';
import { temp, fakeClis, readRole, command } from './helpers.mjs';
import { shimsBase } from '../lib/never-shims.mjs';

const fixture = (file) => fs.readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
const lead = () => ({ ...defaultConfig().roles.lead, vendor: 'codex', maxCostUsd: null });
const reviewer = () => readRole('codex');
const setting = (args, key) => { const row = args.find(a => a.startsWith(`${key}=`)); return row?.slice(key.length + 1); };
const profileOf = args => setting(args, 'permissions.elu_ask');
// The profile's filesystem table, read strictly: every entry a quoted key and one access, and
// no key twice. TOML refuses a table that names a key twice, and Codex then runs no command.
const filesystemOf = profile => {
  let rest = profile.match(/filesystem=\{(.*)\}\}$/)?.[1]; assert.ok(rest != null, profile);
  const entries = new Map();
  while (rest) {
    const entry = rest.match(/^("(?:[^"\\]|\\.)*")="(deny|read|write)"(?:, (?=")|$)/); assert.ok(entry, `not a "path"="access" entry: ${rest}`);
    const key = JSON.parse(entry[1]); assert.equal(entries.has(key), false, `${key} is named twice: ${profile}`);
    entries.set(key, entry[2]); rest = rest.slice(entry[0].length);
  }
  return entries;
};
const assertIsolated = (args) => {
  for (const expected of ['--ignore-user-config', '--ignore-rules', '--json', 'mcp_servers={}', 'features.hooks=false', 'features.apps=false', 'features.multi_agent=false', 'features.browser_use=false', 'features.plugins=false', 'tools.experimental_request_user_input.enabled=false', 'tools.update_plan.enabled=false', 'skills.bundled.enabled=false']) assert.ok(args.includes(expected), expected);
  assert.equal(args.some((a) => /dangerously|bypass|--yolo|--approve-for-me/.test(a)), false, 'no bypass flag');
  assert.equal(args.at(-1), '-', 'the prompt comes on stdin');
};

// The feature switches of a launch, whole. On 0.166.0-alpha.5.1 a session's commands and file
// reads run through the code-mode host: switched off, a real turn starts none of them.
test('a Codex session leaves the code-mode host at the release default; a reviewer keeps it off', (t) => {
  const cwd = temp(t), schemaFile = path.join(cwd, 'schema.json');
  const features = args => args.filter(arg => arg.startsWith('features.')).sort();
  const off = ['apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'code_mode', 'computer_use', 'goals', 'hooks', 'image_generation', 'in_app_browser', 'multi_agent', 'multi_agent_v2', 'plugin_discovery_prefetch', 'plugins', 'remote_plugin', 'shell_snapshot', 'skill_mcp_dependency_install', 'skill_search', 'sleep_tool', 'tool_suggest', 'view_image', 'workspace_dependencies'];
  const session = [...off.map(name => `features.${name}=false`), 'features.shell_tool=true', 'features.unified_exec=true'].sort();
  for (const mode of ['ask', 'auto']) {
    assert.deepEqual(features(codex({ mode, role: lead(), cwd, schemaFile })), session, mode);
    assert.deepEqual(features(codex({ mode, role: lead(), cwd, schemaFile, resume: '12345678-1234-4234-8234-123456789abc' })), session, `${mode}, resumed`);
  }
  // Full access is everything: no feature is switched off, the code-mode host among them.
  for (const resume of [null, '12345678-1234-4234-8234-123456789abc']) assert.deepEqual(features(codex({ mode: 'full', role: lead(), cwd, schemaFile, resume })), ['features.shell_tool=true', 'features.unified_exec=true'], `full${resume ? ', resumed' : ''}`);
  assert.deepEqual(features(codex({ role: reviewer(), cwd, schemaFile })), [...off, 'code_mode_host'].map(name => `features.${name}=false`).concat('features.shell_tool=false', 'features.unified_exec=false').sort());
});

test('Codex reviewer has no shell, apps, browser, agents, user hooks, or MCP configuration', (t) => {
  const cwd = temp(t); const args = codex({ role: reviewer(), cwd, schemaFile: path.join(cwd, 'schema.json') });
  for (const expected of ['--ignore-user-config', '--ignore-rules', 'read-only', 'approval_policy="never"', 'features.shell_tool=false', 'features.unified_exec=false', 'features.apps=false', 'features.hooks=false', 'features.multi_agent=false', 'web_search="disabled"', 'mcp_servers={}']) assert.ok(args.includes(expected), expected);
  assert.equal(args.some((a) => /dangerously|bypass|--yolo/.test(a)), false);
  // A folder's own .codex/config.toml is never read (--ignore-user-config), and the launch empties MCP servers too.
  fs.mkdirSync(path.join(cwd, '.codex')); fs.writeFileSync(path.join(cwd, '.codex/config.toml'), '[mcp_servers.example]\ncommand="false"\n');
  assert.ok(codex({ role: reviewer(), cwd, schemaFile: 'schema.json' }).includes('mcp_servers={}'));
});
test('a Codex bot reads in a project folder that is not a Git repository: its read-only launch skips the repository check', (t) => {
  // Codex refuses outside a Git repository it trusts ("Not inside a trusted directory and
  // --skip-git-repo-check was not specified"), and a project folder need not be one.
  const cwd = temp(t); assert.equal(fs.existsSync(path.join(cwd, '.git')), false);
  const args = codex({ role: reviewer(), cwd, schemaFile: path.join(cwd, 'schema.json') });
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
});
test('stream fixtures parse; failed and unexpected tool streams cannot report done', () => {
  assert.equal(parseCodex(fixture('codex.jsonl')).result.outcome, 'done');
  assert.throws(() => parseCodex(fixture('codex.jsonl').replace('turn.completed', 'turn.failed')));
  assert.throws(() => parseCodex('{"type":"item.completed","item":{"type":"command_execution"}}\n' + fixture('codex.jsonl')));
});

test('a locked edit role is refused; a budget is refused in every mode; peer runs are refused in every mode', (t) => {
  const cwd = temp(t), schemaFile = path.join(cwd, 'schema.json');
  assert.throws(() => codex({ role: lead(), cwd, schemaFile }), /Codex cannot edit in Read only/);
  for (const mode of ['locked', 'ask', 'auto', 'full']) {
    assert.throws(() => codex({ mode, role: { ...lead(), maxCostUsd: 2 }, cwd, schemaFile }), /dollar budget/, mode);
    assert.throws(() => codex({ mode, role: reviewer(), cwd, schemaFile, peer: true }), { message: "Only Claude Code answers a teammate's question. Codex cannot keep its reads inside the shared project. Choose a Claude model with /model default to answer them." }, mode);
  }
  assert.throws(() => codex({ mode: 'locked', role: reviewer(), cwd, schemaFile, folders: [cwd] }), /stays in the task worktree/);
  assert.throws(() => codex({ mode: 'locked', role: reviewer(), cwd, schemaFile, place: { kind: 'branch', branch: 'x' } }), /stays in the task worktree/);
  assert.throws(() => codex({ mode: 'ask', role: lead(), cwd, schemaFile, place: { kind: 'here' } }), /Here needs Full access/);
  assert.throws(() => codex({ mode: 'yolo', role: lead(), cwd, schemaFile }), /Choose ask, auto, or full/);
});

test('argv per mode: ask and auto run the elu_ask profile with a sandboxed shell, full runs without a sandbox', (t) => {
  const cwd = temp(t), schemaFile = path.join(cwd, 'schema.json'), folder = temp(t), common = path.join(cwd, '.git');
  const home = fs.realpathSync(os.homedir()); fs.mkdirSync(common);
  const ask = codex({ mode: 'ask', role: lead(), cwd, schemaFile, folders: [folder], protectedPaths: ['package.json', '.github'], commonDir: common });
  const auto = codex({ mode: 'auto', role: lead(), cwd, schemaFile, folders: [folder], protectedPaths: ['package.json'], commonDir: common });
  const full = codex({ mode: 'full', role: lead(), cwd, schemaFile, folders: [folder], protectedPaths: ['package.json'], commonDir: common });
  for (const args of [ask, auto]) {
    assertIsolated(args);
    assert.deepEqual(args.slice(0, 2), ['exec', '--ignore-user-config']);
    for (const expected of ['--skip-git-repo-check', '--cd', cwd, '--output-schema', schemaFile, 'features.shell_tool=true', 'features.unified_exec=true', 'shell_environment_policy.inherit="core"', 'features.view_image=false']) assert.ok(args.includes(expected), expected);
    assert.equal(args.includes('--sandbox'), false, 'the sandbox comes from -c keys so resume gets the same');
    assert.ok(args.includes('allow_login_shell=false'), 'a login shell would rebuild PATH ahead of the stand-in commands');
  }
  // Full access is everything: the same launch with nothing of the agent's switched off. Only
  // ELU's own settings and the question nobody could answer stay.
  assert.deepEqual(full.slice(0, 2), ['exec', '--ignore-user-config']); assert.equal(full.at(-1), '-'); assert.equal(full.includes('--sandbox'), false);
  for (const expected of ['--ignore-rules', '--json', '--skip-git-repo-check', '--cd', cwd, '--output-schema', schemaFile, 'mcp_servers={}', 'tools.experimental_request_user_input.enabled=false', 'features.shell_tool=true', 'features.unified_exec=true']) assert.ok(full.includes(expected), expected);
  for (const gone of ['allow_login_shell=false', 'shell_environment_policy.inherit="core"', 'tools.update_plan.enabled=false', 'skills.bundled.enabled=false', 'skills.include_instructions=false']) assert.equal(full.includes(gone), false, gone);
  assert.equal(full.some(arg => /^features\..*=false$/.test(arg)), false, 'no feature is off in Full access');
  // ask: the profile, approvals never, no web search.
  assert.equal(setting(ask, 'default_permissions'), '"elu_ask"'); assert.equal(setting(ask, 'approval_policy'), '"never"'); assert.equal(setting(ask, 'web_search'), '"disabled"');
  assert.equal(setting(ask, 'sandbox_mode'), undefined, 'a profile is never combined with sandbox_mode');
  const profile = profileOf(ask);
  assert.ok(profile.startsWith('{extends=":workspace", filesystem={'), profile);
  for (const expected of [`":slash_tmp"="read"`, `":tmpdir"="read"`, `${JSON.stringify(folder)}="read"`, `${JSON.stringify(path.join(cwd, 'package.json'))}="read"`, `${JSON.stringify(path.join(cwd, '.github'))}="read"`, `${JSON.stringify(path.resolve(personalDirectory()))}="deny"`, `${JSON.stringify(path.join(common, 'elu-code'))}="deny"`, ...HOME_SECRETS.map(name => `${JSON.stringify(path.join(home, name))}="deny"`)]) assert.ok(profile.includes(expected), expected);
  assert.equal(ask.some(a => a.startsWith('sandbox_workspace_write.')), false, 'inert under a profile');
  // auto: the same profile plus the vendor reviewer.
  assert.equal(setting(auto, 'default_permissions'), '"elu_ask"'); assert.equal(setting(auto, 'approval_policy'), '"on-request"'); assert.equal(setting(auto, 'approvals_reviewer'), '"auto_review"'); assert.equal(setting(auto, 'web_search'), '"disabled"');
  // A named folder is read, never written, in both.
  for (const args of [ask, auto]) { assert.ok(profileOf(args).includes(`${JSON.stringify(folder)}="read"`)); assert.equal(profileOf(args).includes(`${JSON.stringify(folder)}="write"`), false); }
  // A named folder that holds the workspace, or lies in it, gets no entry: Codex reads it anyway, and an entry there could hold back edits.
  const holder = path.dirname(cwd), inside = path.join(cwd, 'docs'); fs.mkdirSync(inside);
  for (const mode of ['ask', 'auto']) {
    const kept = profileOf(codex({ mode, role: lead(), cwd, schemaFile, folders: [holder, inside, folder], commonDir: common }));
    assert.equal(kept.includes(`${JSON.stringify(holder)}=`), false, mode); assert.equal(kept.includes(`${JSON.stringify(inside)}=`), false, mode); assert.ok(kept.includes(`${JSON.stringify(folder)}="read"`), mode);
  }
  // full: no sandbox, no profile, web search on.
  assert.equal(setting(full, 'sandbox_mode'), '"danger-full-access"'); assert.equal(setting(full, 'approval_policy'), '"never"'); assert.equal(setting(full, 'web_search'), '"live"');
  assert.equal(setting(full, 'default_permissions'), undefined); assert.equal(profileOf(full), undefined); assert.equal(setting(full, 'approvals_reviewer'), undefined);
  // Full access lets a lead run about 30 helpers at once; the other modes run none.
  assert.equal(setting(full, 'agents.max_concurrent_threads_per_session'), '32');
  for (const mode of ['ask', 'auto']) assert.equal(setting(codex({ mode, role: lead(), cwd, schemaFile }), 'agents.max_concurrent_threads_per_session'), undefined, mode);
  assert.equal(setting(codex({ role: reviewer(), cwd, schemaFile }), 'agents.max_concurrent_threads_per_session'), undefined, 'locked');
  // An answer turn (read role) keeps the profile read-only, the named folders included.
  const answer = codex({ mode: 'ask', role: { ...lead(), access: 'read', writablePaths: [] }, cwd, schemaFile, folders: [folder], commonDir: common });
  assert.ok(profileOf(answer).startsWith('{extends=":read-only", filesystem={'), profileOf(answer));
  assert.ok(profileOf(answer).includes(`${JSON.stringify(folder)}="read"`)); assert.equal(profileOf(answer).includes('="write"'), false); assert.equal(profileOf(answer).includes(':slash_tmp'), false);
  // Full access in the owner's checkout; locked stays read-only without a profile.
  assert.equal(setting(codex({ mode: 'full', role: lead(), cwd, schemaFile, place: { kind: 'here' } }), 'sandbox_mode'), '"danger-full-access"');
  assert.equal(profileOf(codex({ role: reviewer(), cwd, schemaFile })), undefined); assert.equal(codex({ role: reviewer(), cwd, schemaFile }).includes('allow_login_shell=false'), false, 'a reviewer runs no command');
  for (const args of [ask, auto]) assert.ok(profileOf(args).includes(`${JSON.stringify(shimsBase())}="read"`), 'the stand-in commands stay read-only wherever a named folder reaches');
  for (const args of [ask, auto, answer]) filesystemOf(profileOf(args));
});

test('resume keeps the -c set and drops the flags exec resume lacks', (t) => {
  const cwd = temp(t), schemaFile = path.join(cwd, 'schema.json'), id = '12345678-1234-4234-8234-123456789abc';
  for (const mode of ['ask', 'auto', 'full']) {
    const fresh = codex({ mode, role: lead(), cwd, schemaFile, protectedPaths: ['package.json'], commonDir: path.join(cwd, '.git') });
    const resumed = codex({ mode, role: lead(), cwd, schemaFile, protectedPaths: ['package.json'], commonDir: path.join(cwd, '.git'), resume: id });
    assert.deepEqual(resumed.slice(0, 3), ['exec', 'resume', id], mode);
    assert.equal(resumed.includes('--cd'), false, mode); assert.equal(resumed.includes('--sandbox'), false, mode);
    const configs = args => args.filter((a, i) => args[i - 1] === '-c');
    assert.deepEqual(configs(resumed), configs(fresh), `${mode}: the same -c set`);
    assert.deepEqual(resumed.filter(a => a.startsWith('--')), fresh.filter(a => a.startsWith('--')).filter(a => a !== '--cd'), mode);
  }
});

test('a path named twice gets one entry in the Codex profile: deny over read over write, and the hand-off folder stays writable unless it is denied', (t) => {
  const cwd = temp(t), schemaFile = path.join(cwd, 'schema.json'), folder = temp(t), common = path.join(cwd, '.git');
  const own = path.join(temp(t), 'elu-code-own-x', 'requests'); fs.mkdirSync(own, { recursive: true });
  // The hand-off folder under each name the system temp folder has (a link on macOS).
  const ownNames = [...new Set([own, path.join(path.resolve(os.tmpdir()), path.relative(fs.realpathSync(os.tmpdir()), own))])];
  const denied = personalDirectory(), shims = shimsBase();
  const answer = { ...lead(), access: 'read', writablePaths: [] };
  for (const mode of ['ask', 'auto']) for (const role of [lead(), answer]) {
    const at = `${mode} ${role.access}`;
    const entries = filesystemOf(profileOf(codex({ mode, role, cwd, schemaFile, commonDir: common, handoff: own,
      folders: [folder, folder, `${folder}/`, shims, denied, ...ownNames],
      protectedPaths: ['package.json', './package.json', path.join(cwd, 'package.json'), folder, shims, denied, ...ownNames] })));
    assert.equal(entries.get(folder), 'read', at); assert.equal(entries.get(path.join(cwd, 'package.json')), 'read', at); assert.equal(entries.get(shims), 'read', at);
    assert.equal(entries.get(denied), 'deny', `${at}: nothing weakens a deny`);
    for (const name of ownNames) assert.equal(entries.get(name), 'write', `${at}: the hand-off folder stays writable`);
    // A hand-off folder that is denied stays denied.
    const closed = filesystemOf(profileOf(codex({ mode, role, cwd, schemaFile, commonDir: common, handoff: denied, folders: [denied] })));
    assert.equal(closed.get(denied), 'deny', at);
  }
});

// On Linux Codex hides a denied path that does not exist by making it, and in .git, which it
// keeps read-only in the workspace, it cannot: bwrap then refuses every command of the turn
// ("Can't create file at <repo>/.git/elu-code: Read-only file system"; outside a repository,
// "Can't create file at <cwd>/.git: Is a directory").
test('a denied folder missing from the Git folder cannot stop the Codex sandbox: ELU makes its state folder there, and names none without a Git folder', (t) => {
  const schemaFile = path.join(temp(t), 'schema.json'), answer = { ...lead(), access: 'read', writablePaths: [] };
  const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
  const gitFolder = () => { const root = temp(t); assert.equal(command('git', ['init', '-q', '--template=', '--initial-branch=main'], root).status, 0); return path.join(root, '.git'); };
  for (const mode of ['ask', 'auto']) for (const role of [lead(), answer]) {
    const at = `${mode} ${role.access}`;
    // A repository whose .git/elu-code is missing, and a common Git folder outside the workspace.
    const repo = gitFolder(), outside = gitFolder();
    for (const [cwd, common] of [[path.dirname(repo), repo], [temp(t), outside]]) {
      const state = path.join(common, 'elu-code'); assert.equal(exists(state), false);
      const entries = filesystemOf(profileOf(codex({ mode, role, cwd, schemaFile, commonDir: common })));
      assert.equal(entries.get(state), 'deny', `${at}: ELU's state stays denied`);
      assert.ok(fs.statSync(state).isDirectory(), `${at}: ${state} is made, so Codex need not make it`);
      assert.equal(fs.statSync(state).mode & 0o777, 0o700, at);
      for (const [p, access] of entries) if (access === 'deny' && !path.relative(common, p).startsWith('..')) assert.ok(exists(p), `${at}: ${p} is denied but missing`);
    }
    // A state folder already there is denied as it was, and what it holds is untouched.
    const kept = gitFolder(), held = path.join(kept, 'elu-code', 'transcript.jsonl'); fs.mkdirSync(path.dirname(held), { mode: 0o700 }); fs.writeFileSync(held, 'kept\n');
    assert.equal(filesystemOf(profileOf(codex({ mode, role, cwd: path.dirname(kept), schemaFile, commonDir: kept }))).get(path.dirname(held)), 'deny', at);
    assert.equal(fs.readFileSync(held, 'utf8'), 'kept\n', at);
    // Outside a repository: no entry under <cwd>/.git, no .git made, and the rest is denied as before.
    const plain = temp(t), none = path.join(plain, '.git');
    const entries = filesystemOf(profileOf(codex({ mode, role, cwd: plain, schemaFile, commonDir: none })));
    assert.deepEqual([...entries.keys()].filter(p => p === none || p.startsWith(`${none}/`)), [], `${at}: nothing named under a missing Git folder`);
    assert.equal(exists(none), false, `${at}: no Git folder is made`);
    assert.equal(entries.get(path.resolve(personalDirectory())), 'deny', at);
    for (const name of HOME_SECRETS) assert.equal(entries.get(path.join(fs.realpathSync(os.homedir()), name)), 'deny', `${at}: ${name}`);
  }
});

test('profile paths that Codex would read as patterns are refused', (t) => {
  const cwd = temp(t), schemaFile = path.join(cwd, 'schema.json');
  const bad = path.join(temp(t), 'evals*');
  fs.mkdirSync(bad);
  assert.throws(() => codex({ mode: 'ask', role: lead(), cwd, schemaFile, folders: [bad] }), /cannot be expressed safely/);
  assert.throws(() => codex({ mode: 'ask', role: lead(), cwd, schemaFile, protectedPaths: ['a?b'] }), /cannot be expressed safely/);
  // Full access has no profile, so the same path is not a problem there.
  assert.doesNotThrow(() => codex({ mode: 'full', role: lead(), cwd, schemaFile, folders: [bad] }));
});

test('lead parse: declined items become denials; mcp_tool_call and web search are read only in Full access', () => {
  const base = fixture('codex.jsonl');
  const declined = '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \'git push origin main\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}\n{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \'git push\\u0007 origin main\'","aggregated_output":"","exit_code":null,"status":"declined"}}\n';
  const patch = '{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"/etc/hosts","kind":"update"}],"status":"declined"}}\n';
  const ran = '{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"/bin/zsh -lc \'npm test\'","aggregated_output":"ok\\n","exit_code":0,"status":"completed"}}\n';
  const mcp = '{"type":"item.completed","item":{"id":"item_4","type":"mcp_tool_call","server":"x","tool":"y","status":"completed"}}\n';
  const search = '{"type":"item.completed","item":{"id":"item_5","type":"web_search","query":"q"}}\n';
  for (const mode of ['ask', 'auto', 'full']) {
    const parsed = parseCodex(declined + patch + ran + base, { mode });
    assert.equal(parsed.result.outcome, 'done'); assert.equal(parsed.costUsd, null);
    assert.deepEqual(parsed.denials, [{ tool: 'command_execution', summary: "Run: /bin/zsh -lc 'git push origin main'" }, { tool: 'file_change', summary: 'Edit: /etc/hosts' }], mode);
    // Below Full access a tool Codex was not given refuses the run. Full access has every tool, so it is read.
    if (mode === 'full') assert.equal(parseCodex(mcp + base, { mode }).result.outcome, 'done'); else assert.throws(() => parseCodex(mcp + base, { mode }), /must not have/, mode);
  }
  assert.deepEqual(parseCodex(search + base, { mode: 'full' }).denials, []);
  // A step in which a stand-in command refused: kept with the command it named, whatever the step exited with.
  const step = (command, output, code) => `${JSON.stringify({ type: 'item.completed', item: { id: 'item_6', type: 'command_execution', command, aggregated_output: output, exit_code: code, status: code === 0 ? 'completed' : 'failed' } })}\n`;
  const refused = step("/bin/zsh -c 'git push origin HEAD'", 'git push is never allowed, in any mode.\n', 126) + step("/bin/zsh -c 'sh ./sync.sh'", 'Syncing\nnpm publish is never allowed, in any mode.\nsync.sh: exited 126\n', 0) + step("/bin/zsh -c 'cat docs/permissions.md'", 'The chat says: git push is never allowed, in any mode.\n', 0);
  for (const mode of ['ask', 'auto', 'full']) assert.deepEqual(parseCodex(refused + base, { mode }).denials, [{ tool: 'command_execution', summary: "Run: /bin/zsh -c 'git push origin HEAD'", never: 'git push' }, { tool: 'command_execution', summary: "Run: /bin/zsh -c 'sh ./sync.sh'", never: 'npm publish' }], mode);
  for (const mode of ['locked', 'ask', 'auto']) assert.throws(() => parseCodex(search + base, { mode }), /must not have/, mode);
  // Without a mode the reviewer rule applies: any tool item refuses, nothing is a denial.
  assert.throws(() => parseCodex(ran + base), /reviewer must not have/);
  assert.deepEqual(parseCodex(base, { mode: 'ask' }).denials, []);
  const long = `{"type":"item.completed","item":{"id":"i","type":"command_execution","command":${JSON.stringify('x'.repeat(400))},"status":"declined"}}\n`;
  assert.equal(parseCodex(long + base, { mode: 'ask' }).denials[0].summary.length, 200);
});

test('only a ChatGPT sign-in counts: an API key or no sign-in is reported as signed out', async (t) => {
  const parent = temp(t);
  for (const [mode, expected] of [['normal', true], ['api-key', false], ['signed-out', false]]) {
    const f = fakeClis(parent, { mode });
    assert.equal(await signedIn({ bin: path.join(f.dir, 'codex'), cwd: parent, env: { ...process.env, PATH: f.env.PATH } }), expected, mode);
  }
  assert.equal(meta.signInHint, 'Codex: sign in with ChatGPT. Run: codex login');
});

// A project's own .codex/config.toml (MCP servers, a shell policy) once stopped every Codex bot
// and lead in that folder, though a Codex agent never reads it: --ignore-user-config makes the
// folder untrusted, and 0.169 then says "Untrusted project-local configuration is disabled".
test('a Codex bot or lead runs in a folder with its own .codex/config.toml, which its launch never reads', (t) => {
  const cwd = temp(t), schemaFile = path.join(cwd, 'schema.json');
  fs.mkdirSync(path.join(cwd, '.codex')); fs.writeFileSync(path.join(cwd, '.codex', 'config.toml'), '[mcp_servers.notes]\nurl = "https://example.com/mcp"\n');
  for (const [mode, role] of [['locked', reviewer()], ['ask', lead()], ['auto', lead()], ['full', lead()]]) {
    const args = codex({ mode, role, cwd, schemaFile });
    assert.ok(args.includes('--ignore-user-config'), `${mode} reads no project file`);
    assert.equal(args.includes('--trust'), false, `${mode} never trusts the folder`);
  }
});

// ---------------------------------------------------------------------------------------
// The turn of the bot that oversees the owner's sessions (oversee), on Codex as on Claude Code:
// ELU's MCP server, its PreToolUse hook (lib/adapters/codex.mjs overseeHook) and, at the level
// Full, a shell. Read against codex-cli 0.169.0-alpha.11.1; never with the owner's ELU folder.
const KEY = 'a-very-secret-key-1234567890', TOKEN = 'Bearer elu_live_0123456789abcdef';
function overseeFixture(t, { mode = 'auto', servers = {} } = {}) {
  const parent = temp(t), cwd = path.join(parent, 'app'), common = path.join(cwd, '.git'), personal = path.join(parent, 'personal');
  for (const dir of [common, personal]) fs.mkdirSync(dir, { recursive: true });
  const log = path.join(parent, 'approvals.jsonl'), file = path.join(parent, 'mcp.json');
  const relay = approvalServer({ session: 'run-1', root: cwd, taskId: '2', role: 'bot:orchestrator', vendor: 'codex', log, cwd, access: 'read', rules: 'saved', mode, folders: [], common, oversee: 'orchestrator', servers: Object.keys(servers) });
  relay.env = { HOME: os.homedir(), XDG_CONFIG_HOME: personal };
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { ...servers, [APPROVAL_SERVER]: relay } }));
  return { parent, cwd, common, personal, log, relay, schemaFile: path.join(parent, 'schema.json'), mcp: { file, names: [...Object.keys(servers), APPROVAL_SERVER] } };
}
const overseer = () => ({ ...readRole('codex'), maxCostUsd: null, model: 'gpt-6.2-sol', effort: 'xhigh' });
const hookCommand = args => JSON.parse(setting(args, 'hooks.PreToolUse').match(/command=("(?:[^"\\]|\\.)*")/)[1]);
const hookContext = args => JSON.parse(Buffer.from(hookCommand(args).split(' ').at(-1), 'base64url').toString('utf8'));

test('a Codex turn that oversees gets ELU\'s MCP server and the hook that asks the owner; below Full it has no shell', (t) => {
  assert.equal(RELAY_SERVER, APPROVAL_SERVER, 'the adapter names ELU\'s own server as lib/mcp.mjs does');
  for (const mode of ['ask', 'auto', 'full']) {
    const f = overseeFixture(t, { mode });
    const args = codex({ mode, role: overseer(), cwd: f.cwd, schemaFile: f.schemaFile, commonDir: f.common, oversee: true, mcp: f.mcp });
    assert.deepEqual(args.slice(0, 2), ['exec', '--ignore-user-config']); assert.equal(args.at(-1), '-');
    for (const expected of ['--ignore-rules', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', 'features.hooks=true', 'features.shell_tool=false', 'features.unified_exec=false', 'tools.update_plan.enabled=false', 'tools.experimental_request_user_input.enabled=false', 'shell_environment_policy.inherit="none"']) assert.ok(args.includes(expected), `${mode}: ${expected}`);
    // ELU's own server, as the relay was written for this run, and nothing else: never mcp_servers={}.
    assert.equal(args.includes('mcp_servers={}'), false, mode);
    const servers = setting(args, 'mcp_servers');
    assert.ok(servers.startsWith(`{"${APPROVAL_SERVER}"={"command"=${JSON.stringify(f.relay.command)}, "args"=[`), servers);
    for (const part of [`${JSON.stringify('--oversee')}, ${JSON.stringify('orchestrator')}`, `"env"={"HOME"=${JSON.stringify(os.homedir())}, "XDG_CONFIG_HOME"=${JSON.stringify(f.personal)}}`, '"disabled_tools"=["approve"]', '"required"=true', '"tool_timeout_sec"=1320', '"default_tools_approval_mode"="approve"', '"XDG_DATA_HOME"']) assert.ok(servers.includes(part), `${mode}: ${part}`);
    // No shell, no edit, no web: the read-only sandbox, approvals never asked of nobody.
    assert.equal(setting(args, 'sandbox_mode'), '"read-only"', mode); assert.equal(setting(args, 'approval_policy'), '"never"', mode); assert.equal(setting(args, 'web_search'), '"disabled"', mode);
    assert.equal(setting(args, 'default_permissions'), undefined, mode); assert.equal(setting(args, 'agents.max_concurrent_threads_per_session'), undefined, mode);
    // The code-mode host stays at the release default: every model of the catalog calls its tools, MCP ones too, only through it.
    for (const kept of ['features.code_mode=false', 'features.code_mode_host=false', 'features.hooks=false']) assert.equal(args.includes(kept), false, `${mode}: ${kept}`);
    // Every call reaches the hook first: this file, with what the relay knows of the turn.
    assert.match(setting(args, 'hooks.PreToolUse'), /^\[\{matcher="\*", hooks=\[\{type="command", command=".*", timeout=1320\}\]\}\]$/);
    assert.ok(hookCommand(args).startsWith(`'${process.execPath}' '${path.resolve('lib/adapters/codex.mjs')}' 'hook' `), hookCommand(args));
    const context = hookContext(args);
    assert.deepEqual([context.session, context.role, context.bot, context.mode, context.full, context.wait, context.log, context.servers], ['run-1', 'bot:orchestrator', 'orchestrator', mode, false, 1200, f.log, [APPROVAL_SERVER]], mode);
    assert.ok(context.named.includes(personalDirectory()) && context.kept.includes(path.join(f.common, 'elu-code')), mode);
    assert.ok(args.includes('--model') && args.includes('model_reasoning_effort="xhigh"'), mode);
    // A resumed turn keeps the same -c set.
    const resumed = codex({ mode, role: overseer(), cwd: f.cwd, schemaFile: f.schemaFile, commonDir: f.common, oversee: true, mcp: f.mcp, resume: '12345678-1234-4234-8234-123456789abc' });
    const configs = list => list.filter((a, i) => list[i - 1] === '-c');
    assert.deepEqual(configs(resumed), configs(args), mode); assert.deepEqual(resumed.slice(0, 3), ['exec', 'resume', '12345678-1234-4234-8234-123456789abc']); assert.ok(resumed.includes('--dangerously-bypass-hook-trust'));
  }
});

test('a Codex turn that oversees at Full works in Full access with a shell and helpers, its servers and its hook kept', (t) => {
  const f = overseeFixture(t, { mode: 'full' });
  const args = codex({ mode: 'full', role: overseer(), cwd: f.cwd, schemaFile: f.schemaFile, commonDir: f.common, oversee: true, [OVERSEE_FULL]: true, mcp: f.mcp });
  assert.equal(setting(args, 'sandbox_mode'), '"danger-full-access"'); assert.equal(setting(args, 'approval_policy'), '"never"'); assert.equal(setting(args, 'web_search'), '"live"');
  for (const expected of ['features.shell_tool=true', 'features.unified_exec=true', 'features.hooks=true', 'tools.experimental_request_user_input.enabled=false', '--dangerously-bypass-hook-trust']) assert.ok(args.includes(expected), expected);
  assert.equal(setting(args, 'agents.max_concurrent_threads_per_session'), '32', 'helpers as a Full access session has them');
  assert.equal(args.some(arg => /^features\..*=false$/.test(arg)), false, 'no feature is off at Full');
  assert.equal(args.includes('mcp_servers={}'), false); assert.ok(setting(args, 'mcp_servers').includes('"--oversee", "orchestrator"'));
  assert.equal(hookContext(args).full, true);
  // The same launch as a Full access session's, with ELU's servers and its hook in place of mcp_servers={}.
  const session = codex({ mode: 'full', role: overseer(), cwd: f.cwd, schemaFile: f.schemaFile, commonDir: f.common });
  const plain = list => list.filter((a, i) => !(a === '-c' && /^(?:mcp_servers|hooks\.|features\.hooks=)/.test(list[i + 1])) && !(list[i - 1] === '-c' && /^(?:mcp_servers|hooks\.|features\.hooks=)/.test(a)) && a !== '--dangerously-bypass-hook-trust');
  assert.deepEqual(plain(args), plain(session));
});

test('a Codex turn that oversees is refused where Claude Code\'s is, and without ELU\'s server started for that bot', (t) => {
  const f = overseeFixture(t), base = { role: overseer(), cwd: f.cwd, schemaFile: f.schemaFile, commonDir: f.common, mcp: f.mcp };
  assert.throws(() => codex({ ...base, mode: 'locked', oversee: true }), /runs in a session of the owner's with permissions/);
  assert.throws(() => codex({ ...base, mode: 'full', [OVERSEE_FULL]: true }), /Only the turn of a bot that oversees runs at the Full level/);
  assert.throws(() => codex({ ...base, mode: 'auto', oversee: true, [OVERSEE_FULL]: true }), /at the Full level runs in Full access/);
  assert.throws(() => codex({ ...base, role: lead(), mode: 'auto', oversee: true }), /never edits, runs no command/);
  assert.throws(() => codex({ ...base, mode: 'auto', oversee: true, todos: true }), /never edits, runs no command/);
  assert.throws(() => codex({ ...base, mode: 'auto', oversee: true, mcp: null }), /needs the MCP config that starts ELU's own server/);
  const other = path.join(f.parent, 'other.json');
  fs.writeFileSync(other, JSON.stringify({ mcpServers: { notes: { type: 'http', url: 'https://example.invalid/mcp' } } }));
  assert.throws(() => codex({ ...base, mode: 'auto', oversee: true, mcp: { file: other, names: ['notes'] } }), /needs ELU's own MCP server/);
  const lead2 = approvalServer({ session: 'run-2', root: f.cwd, taskId: '2', role: 'lead', vendor: 'codex', log: f.log });
  fs.writeFileSync(other, JSON.stringify({ mcpServers: { [APPROVAL_SERVER]: lead2 } }));
  assert.throws(() => codex({ ...base, mode: 'auto', oversee: true, mcp: { file: other, names: [APPROVAL_SERVER] } }), /not started for the bot that oversees/);
});

test('a Codex launch that does not oversee and has no server of the owner\'s is the same with or without an MCP config', (t) => {
  const f = overseeFixture(t);
  for (const [mode, role] of [['locked', reviewer()], ['ask', lead()], ['auto', lead()], ['full', lead()], ['full', { ...lead(), access: 'read', writablePaths: [] }]]) {
    for (const resume of mode === 'locked' ? [null] : [null, '12345678-1234-4234-8234-123456789abc']) {
      const without = codex({ mode, role, cwd: f.cwd, schemaFile: f.schemaFile, commonDir: f.common, resume });
      assert.deepEqual(codex({ mode, role, cwd: f.cwd, schemaFile: f.schemaFile, commonDir: f.common, resume, mcp: f.mcp }), without, mode);
      assert.ok(without.includes('mcp_servers={}'), mode);
      assert.equal(without.some(arg => /^hooks\.|^features\.hooks=true$|dangerously/.test(arg)), false, mode);
    }
  }
  // The read-only reviewer launch is still the pinned one (test/argv-snapshot.test.mjs) and keeps the code-mode host off.
  assert.ok(codex({ role: reviewer(), cwd: f.cwd, schemaFile: f.schemaFile }).includes('features.code_mode_host=false'));
});

test('the hook of a turn that oversees answers each call as the relay answers Claude Code, under the names the relay knows', async (t) => {
  const f = overseeFixture(t), context = hookContext(codex({ mode: 'auto', role: overseer(), cwd: f.cwd, schemaFile: f.schemaFile, commonDir: f.common, oversee: true, mcp: f.mcp }));
  const asked = [];
  let next = { decision: 'allow', by: 'default', summary: 's' };
  const overseeing = async (tool, input, ctx) => { asked.push([tool, input, ctx.id, ctx.mode, ctx.bot, ctx.waitSeconds, ctx.taskId]); return next; };
  const event = (tool_name, tool_input, tool_use_id = 'exec-1') => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id });
  const deny = reason => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  const say = (text, ctx = context) => overseeHook(ctx, text, { overseeing });
  // Codex writes elu-code-approval as elu_code_approval in a tool's name; the relay is asked about it by its own.
  assert.equal(await say(event('mcp__elu_code_approval__sessions_list', {})), '');
  assert.deepEqual(asked.at(-1), [`mcp__${APPROVAL_SERVER}__sessions_list`, {}, 'run-1-exec-1', 'auto', 'orchestrator', 1200, '2']);
  assert.equal(serverTool('mcp__elu_code_approval__session_read', [APPROVAL_SERVER, 'elu']), `mcp__${APPROVAL_SERVER}__session_read`);
  assert.equal(serverTool('mcp__elu__ask_elu', [APPROVAL_SERVER, 'elu']), 'mcp__elu__ask_elu');
  // A command goes as Bash; what the relay says no to, or nobody answered, Codex refuses with its words.
  next = { decision: 'deny', summary: 'Run: npm publish', message: 'The owner declined this.' };
  assert.equal(await say(event('Bash', { command: 'npm publish' }, 'exec-2')), deny('The owner declined this.'));
  assert.deepEqual(asked.at(-1).slice(0, 2), ['Bash', { command: 'npm publish' }]);
  next = { decision: 'timeout', summary: 'Run: git tag v1', message: 'No answer from the owner.' };
  assert.equal(await say(event('Bash', { command: 'git tag v1' }, 'exec-3')), deny('No answer from the owner.'));
  // What is typed into a running command is a command too; a poll with nothing typed is not asked about.
  next = { decision: 'allow', by: 'full', summary: 's' };
  assert.equal(await say(event('write_stdin', { session_id: 1, chars: 'npm publish\n' }, 'exec-4')), '');
  assert.deepEqual(asked.at(-1).slice(0, 2), ['Bash', { command: 'npm publish\n' }]);
  const count = asked.length; assert.equal(await say(event('write_stdin', { session_id: 1, chars: '' })), ''); assert.equal(asked.length, count);
  // Each file of a patch is an Edit of it.
  assert.equal(await say(event('apply_patch', { command: '*** Begin Patch\n*** Add File: a.txt\n+x\n*** Update File: src/b.mjs\n*** Move to: src/c.mjs\n@@\n-a\n+b\n*** End Patch' }, 'exec-5')), '');
  assert.deepEqual(asked.slice(-3).map(row => [row[0], row[1], row[2]]), [['Edit', { file_path: 'a.txt' }, 'run-1-exec-5-1'], ['Edit', { file_path: 'src/b.mjs' }, 'run-1-exec-5-2'], ['Edit', { file_path: 'src/c.mjs' }, 'run-1-exec-5-3']]);
  // ELU's own folder and its records of the sessions are never changed by the turn's own tools, at Full too: not even asked.
  const own = asked.length, full = { ...context, full: true };
  for (const ctx of [context, full]) {
    assert.match(await say(event('apply_patch', { command: `*** Begin Patch\n*** Add File: ${path.join(personalDirectory(), 'orchestrator.json')}\n+{}\n*** End Patch` }), ctx), /never changes ELU's own folder/);
    assert.match(await say(event('Bash', { command: 'cat ~/.config/elu-code/orchestrator.json > x; echo {} > .git/elu-code/tasks/1/task.json' }), ctx), /never changes ELU's own folder/);
    assert.match(await say(event('apply_patch', { command: '*** Begin Patch\n*** End Patch' }), ctx), /never changes ELU's own folder/, 'a patch that names no file is refused');
  }
  assert.equal(asked.length, own);
  // Below Full no helper starts; at Full a helper is the turn's own, and its commands reach the hook as the turn's do.
  assert.match(await say(event('spawn_agent', { message: 'go' })), /starts no helper/);
  assert.match(await say(event('multi_agent_v1__spawn_agent', { message: 'go' })), /starts no helper/);
  assert.equal(await say(event('spawn_agent', { message: 'go' }), full), '');
  // Any other tool the launch gave the turn needs no answer; an event that does not read is refused.
  assert.equal(await say(event('web_search', { query: 'x' })), ''); assert.equal(asked.length, own);
  assert.equal(await say('not json'), deny('ELU could not check this step, so it did not run. Do not retry it another way: say in your reply what you needed.'));
  // Each answer is a row of the run's approvals, as the relay writes them.
  const rows = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.slice(0, 3).map(row => [row.id, row.tool, row.decision]), [['run-1-exec-1', `mcp__${APPROVAL_SERVER}__sessions_list`, 'allow'], ['run-1-exec-2', 'Bash', 'deny'], ['run-1-exec-3', 'Bash', 'timeout']]);
  assert.ok(rows.some(row => row.decision === 'deny' && row.by === 'oversee' && /orchestrator\.json/.test(row.summary)));
});

test('the hook runs as Codex starts it, with the relay\'s answers: below Full a command is refused and ELU\'s tools are allowed', (t) => {
  const f = overseeFixture(t), args = codex({ mode: 'auto', role: overseer(), cwd: f.cwd, schemaFile: f.schemaFile, commonDir: f.common, oversee: true, mcp: f.mcp });
  const run = input => spawnSync('/bin/sh', ['-c', hookCommand(args)], { input, encoding: 'utf8', cwd: f.cwd, env: { ...process.env, XDG_CONFIG_HOME: f.personal }, timeout: 30000 });
  const refused = run(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'exec-a' }));
  assert.equal(refused.status, 0, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecisionReason, /edits nothing, runs no command/);
  const allowed = run(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'mcp__elu_code_approval__sessions_list', tool_input: {}, tool_use_id: 'exec-b' }));
  assert.equal(allowed.status, 0, allowed.stderr); assert.equal(allowed.stdout, '');
  const rows = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => [row.tool, row.decision, row.by]), [['Bash', 'deny', 'oversee'], [`mcp__${APPROVAL_SERVER}__sessions_list`, 'allow', 'default']]);
});

test('the owner\'s own servers reach a Codex turn that oversees with their keys kept off every command line', (t) => {
  const stdio = { type: 'stdio', command: process.execPath, args: ['-e', 'process.stdout.write(String(process.env.NOTES_KEY))'], env: { NOTES_KEY: KEY } };
  const web = { type: 'http', url: 'https://mcp.example.invalid/mcp', headers: { Authorization: TOKEN } };
  const f = overseeFixture(t, { servers: { gmail: stdio, elu: web } });
  const args = codex({ mode: 'auto', role: overseer(), cwd: f.cwd, schemaFile: f.schemaFile, commonDir: f.common, oversee: true, mcp: f.mcp });
  for (const secret of [KEY, TOKEN, 'elu_live_0123456789abcdef']) assert.equal(args.some(arg => arg.includes(secret)), false, secret);
  const servers = setting(args, 'mcp_servers');
  assert.ok(servers.startsWith('{"gmail"={"command"='), servers);
  assert.ok(servers.includes('"elu"={"url"="https://mcp.example.invalid/mcp", "http_headers_helper"='), servers);
  assert.deepEqual(hookContext(args).servers, ['gmail', 'elu', APPROVAL_SERVER]);
  // The URL server's headers come from the run's private file when Codex connects.
  const helper = JSON.parse(servers.match(/"http_headers_helper"=("(?:[^"\\]|\\.)*")/)[1]);
  const headers = spawnSync('/bin/sh', ['-c', helper], { encoding: 'utf8', timeout: 30000 });
  assert.equal(headers.status, 0, headers.stderr); assert.deepEqual(JSON.parse(headers.stdout), { Authorization: TOKEN });
  // The command server starts through this file, with the environment its settings give it.
  const [command, ...rest] = JSON.parse(`[${servers.match(/"gmail"=\{"command"=("(?:[^"\\]|\\.)*"), "args"=\[([^\]]*)\]/).slice(1).join(', ')}]`);
  const started = spawnSync(command, rest, { encoding: 'utf8', timeout: 30000 });
  assert.equal(started.status, 0, started.stderr); assert.equal(started.stdout, KEY);
  // A call of a server of the owner's gets an answer from the relay's table, as on Claude Code.
  assert.equal(serverTool('mcp__gmail__send_email', hookContext(args).servers), 'mcp__gmail__send_email');
});

test('parse reads the calls of the MCP servers a turn that oversees was given, and no others', () => {
  const base = fixture('codex.jsonl');
  const call = server => `{"type":"item.completed","item":{"id":"item_9","type":"mcp_tool_call","server":"${server}","tool":"sessions_list","status":"completed"}}\n`;
  for (const mode of ['ask', 'auto']) {
    assert.equal(parseCodex(call(APPROVAL_SERVER) + base, { mode, servers: [APPROVAL_SERVER] }).result.outcome, 'done', mode);
    assert.throws(() => parseCodex(call('other') + base, { mode, servers: [APPROVAL_SERVER] }), /must not have/, mode);
    assert.throws(() => parseCodex(call(APPROVAL_SERVER) + base, { mode }), /must not have/, `${mode}: a launch with no servers reads none`);
  }
  // A Read only run given servers reads their calls too, and Codex's own listing of their resources.
  const resources = '{"type":"item.completed","item":{"id":"item_8","type":"mcp_tool_call","server":"codex","tool":"list_mcp_resources","status":"completed"}}\n';
  assert.equal(parseCodex(call('elu') + resources + base, { mode: 'locked', servers: ['elu'] }).result.outcome, 'done');
  assert.throws(() => parseCodex(call('other') + base, { mode: 'locked', servers: ['elu'] }), /reviewer must not have/);
  assert.throws(() => parseCodex(resources + base, { mode: 'locked' }), /reviewer must not have/, 'a run with no servers lists no resources');
  assert.throws(() => parseCodex(call(APPROVAL_SERVER) + base, { mode: 'locked' }), /reviewer must not have/);
});

// Any bot that names MCP servers (mcp: ['elu']) gets them on Codex as on Claude Code, where each
// is allowed whole (mcp__NAME): the owner's servers in place of mcp_servers={}, never ELU's relay.
test('a Codex run given the owner\'s servers has them, keys off the command line, and nothing else of its launch changes', (t) => {
  const stdio = { type: 'stdio', command: process.execPath, args: ['-e', 'process.stdout.write(String(process.env.NOTES_KEY))'], env: { NOTES_KEY: KEY } };
  const web = { type: 'http', url: 'https://mcp.example.invalid/mcp', headers: { Authorization: TOKEN } };
  const f = overseeFixture(t, { servers: { elu: web, notes: stdio } });
  for (const [mode, role] of [['ask', lead()], ['auto', lead()], ['full', lead()], ['auto', { ...lead(), access: 'read', writablePaths: [] }]]) {
    for (const resume of [null, '12345678-1234-4234-8234-123456789abc']) {
      const base = { mode, role, cwd: f.cwd, schemaFile: f.schemaFile, commonDir: f.common, resume };
      const without = codex(base), args = codex({ ...base, mcp: f.mcp });
      for (const secret of [KEY, TOKEN]) assert.equal(args.some(arg => arg.includes(secret)), false, `${mode}: ${secret}`);
      const servers = setting(args, 'mcp_servers');
      assert.ok(servers.startsWith('{"elu"={"url"="https://mcp.example.invalid/mcp", "http_headers_helper"='), servers);
      assert.ok(servers.includes('"notes"={"command"=') && servers.includes('"default_tools_approval_mode"="approve"'), servers);
      assert.equal(servers.includes(APPROVAL_SERVER), false, `${mode}: ELU's relay is not given to a run that does not oversee`);
      assert.deepEqual(args.map(arg => arg.startsWith('mcp_servers=') ? 'mcp_servers={}' : arg), without, `${mode}: only mcp_servers differs`);
    }
  }
  // Read only: the reviewer's launch, with the code-mode host on (every model calls an MCP tool only
  // through it) and the hook that lets the turn use those servers and nothing else.
  const role = { ...reviewer(), maxCostUsd: null }, without = codex({ role, cwd: f.cwd, schemaFile: f.schemaFile }), args = codex({ role, cwd: f.cwd, schemaFile: f.schemaFile, mcp: f.mcp });
  for (const secret of [KEY, TOKEN]) assert.equal(args.some(arg => arg.includes(secret)), false, secret);
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  for (const expected of ['approval_policy="never"', 'web_search="disabled"', 'features.shell_tool=false', 'features.unified_exec=false', 'features.multi_agent=false', 'features.hooks=true', '--dangerously-bypass-hook-trust']) assert.ok(args.includes(expected), expected);
  for (const gone of ['features.code_mode_host=false', 'features.code_mode=false', 'features.hooks=false', 'mcp_servers={}']) assert.equal(args.includes(gone), false, gone);
  assert.equal(setting(args, 'mcp_servers'), setting(codex({ mode: 'ask', role: lead(), cwd: f.cwd, schemaFile: f.schemaFile, mcp: f.mcp }), 'mcp_servers'));
  assert.deepEqual(hookContext(args), { kind: 'servers', servers: ['elu', 'notes'] });
  const kept = list => list.filter((arg, i) => !['features.code_mode_host=false', 'features.code_mode=false'].includes(arg) && !['features.code_mode_host=false', 'features.code_mode=false'].includes(list[i + 1]) && !arg.startsWith('mcp_servers=') && !/^hooks\.|^features\.hooks=|^--dangerously/.test(arg) && !(arg === '-c' && /^hooks\./.test(list[i + 1])));
  assert.deepEqual(kept(args), kept(without));
  assert.equal(args.at(-1), '-');
});

test('the hook of a Read only run with servers lets their tools run and refuses every other tool', async () => {
  const context = { kind: 'servers', servers: ['elu', 'notes'] }, say = (tool_name, tool_input = {}) => overseeHook(context, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'x' }), { overseeing: () => { throw new Error('the relay is not asked'); } });
  for (const tool of ['mcp__elu__ask_elu', 'mcp__notes__find']) assert.equal(await say(tool), '', tool);
  for (const [tool, input] of [['mcp__gmail__send_email', {}], ['mcp__elu_code_approval__sessions_list', {}], ['Bash', { command: 'cat ~/.ssh/id_rsa' }], ['apply_patch', { command: '*** Begin Patch\n*** Add File: a\n+x\n*** End Patch' }], ['write_stdin', { chars: 'ls\n' }], ['spawn_agent', {}], ['multi_agent_v1spawn_agent', {}], ['collaboration__spawn_agent', {}]]) assert.match(await say(tool, input), /uses its MCP servers and no other tool/, tool);
  assert.equal(await say('web_search'), '', 'what the launch never offers needs no answer');
  assert.match(await overseeHook(context, 'not json'), /could not check this step/);
  assert.match(await overseeHook({ kind: 'servers' }, JSON.stringify({ tool_name: 'mcp__elu__ask_elu' })), /could not check this step/);
});

test('a Codex launch never puts more on the command line than every system takes', (t) => {
  const f = overseeFixture(t), base = { role: lead(), cwd: f.cwd, schemaFile: f.schemaFile, commonDir: f.common };
  for (const args of [codex({ ...base, mode: 'ask' }), codex({ ...base, mode: 'full' }), codex({ role: reviewer(), cwd: f.cwd, schemaFile: f.schemaFile }), codex({ ...base, role: overseer(), mode: 'auto', oversee: true, mcp: f.mcp })]) {
    assert.ok(args.every(arg => Buffer.byteLength(arg) < ARG_BYTES), 'each argument');
    assert.ok(args.reduce((sum, arg) => sum + Buffer.byteLength(arg) + 1, 0) < ARGS_BYTES, 'all of them');
  }
  const many = Array.from({ length: 400 }, (_, i) => `${'deep/'.repeat(30)}file-${i}.txt`);
  assert.throws(() => codex({ ...base, mode: 'ask', protectedPaths: many }), /more settings than a command line holds/);
});
