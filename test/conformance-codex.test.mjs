import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile as codex, parse as parseCodex, signedIn, meta } from '../lib/adapters/codex.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { HOME_SECRETS } from '../lib/vendors.mjs';
import { personalDirectory } from '../lib/util.mjs';
import { temp, fakeClis, readRole } from './helpers.mjs';
import { shimsBase } from '../lib/never-shims.mjs';

const fixture = (file) => fs.readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
const lead = () => ({ ...defaultConfig().roles.lead, vendor: 'codex', maxCostUsd: null });
const reviewer = () => readRole('codex');
const setting = (args, key) => { const row = args.find(a => a.startsWith(`${key}=`)); return row?.slice(key.length + 1); };
const profileOf = args => setting(args, 'permissions.elu_ask');
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
  fs.mkdirSync(path.join(cwd, '.codex')); fs.writeFileSync(path.join(cwd, '.codex/config.toml'), '[mcp_servers.example]\ncommand="false"\n');
  assert.throws(() => codex({ role: reviewer(), cwd, schemaFile: 'schema.json' }), /MCP/);
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
    assert.throws(() => codex({ mode, role: reviewer(), cwd, schemaFile, peer: true }), /A teammate's question needs Claude as the model/, mode);
  }
  assert.throws(() => codex({ mode: 'locked', role: reviewer(), cwd, schemaFile, folders: [cwd] }), /stays in the task worktree/);
  assert.throws(() => codex({ mode: 'locked', role: reviewer(), cwd, schemaFile, place: { kind: 'branch', branch: 'x' } }), /stays in the task worktree/);
  assert.throws(() => codex({ mode: 'ask', role: lead(), cwd, schemaFile, place: { kind: 'here' } }), /Here needs Full access/);
  assert.throws(() => codex({ mode: 'yolo', role: lead(), cwd, schemaFile }), /Choose ask, auto, or full/);
});

test('argv per mode: ask and auto run the elu_ask profile with a sandboxed shell, full runs without a sandbox', (t) => {
  const cwd = temp(t), schemaFile = path.join(cwd, 'schema.json'), folder = temp(t), common = path.join(cwd, '.git');
  const home = fs.realpathSync(os.homedir());
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
  // An answer turn (read role) keeps the profile read-only, the named folders included.
  const answer = codex({ mode: 'ask', role: { ...lead(), access: 'read', writablePaths: [] }, cwd, schemaFile, folders: [folder], commonDir: common });
  assert.ok(profileOf(answer).startsWith('{extends=":read-only", filesystem={'), profileOf(answer));
  assert.ok(profileOf(answer).includes(`${JSON.stringify(folder)}="read"`)); assert.equal(profileOf(answer).includes('="write"'), false); assert.equal(profileOf(answer).includes(':slash_tmp'), false);
  // Full access in the owner's checkout; locked stays read-only without a profile.
  assert.equal(setting(codex({ mode: 'full', role: lead(), cwd, schemaFile, place: { kind: 'here' } }), 'sandbox_mode'), '"danger-full-access"');
  assert.equal(profileOf(codex({ role: reviewer(), cwd, schemaFile })), undefined); assert.equal(codex({ role: reviewer(), cwd, schemaFile }).includes('allow_login_shell=false'), false, 'a reviewer runs no command');
  for (const args of [ask, auto]) assert.ok(profileOf(args).includes(`${JSON.stringify(shimsBase())}="read"`), 'the stand-in commands stay read-only wherever a named folder reaches');
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

test('only a ChatGPT sign-in counts: an API key or no sign-in is reported as signed out', (t) => {
  const parent = temp(t);
  for (const [mode, expected] of [['normal', true], ['api-key', false], ['signed-out', false]]) {
    const f = fakeClis(parent, { mode });
    assert.equal(signedIn({ bin: path.join(f.dir, 'codex'), cwd: parent, env: { ...process.env, PATH: f.env.PATH } }), expected, mode);
  }
  assert.equal(meta.signInHint, 'Codex: sign in with ChatGPT. Run: codex login');
});
