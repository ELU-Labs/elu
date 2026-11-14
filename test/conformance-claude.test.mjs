import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { compile as claude, parse as parseClaude, sandboxRefusal, secretReads, unwritable, NEVER_RULES } from '../lib/adapters/claude.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { temp, readRole, git as gitIn } from './helpers.mjs';
import { commandRule } from '../lib/policy.mjs';
import { APPROVAL_TOOL } from '../lib/mcp.mjs';

test('Claude launch keeps safe modes, exact permissions, empty MCP, and sandboxing that a shell requires', (t) => {
  const cwd = temp(t); const role = defaultConfig().roles.lead;
  const args = claude({ role, cwd, protectedPaths: ['.elu-code', '.git', 'package.json', 'test.config.mjs'], session: '12345678-1234-4234-8234-123456789abc' });
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value('--permission-mode'), 'dontAsk'); assert.equal(value('--permission-prompts'), 'none');
  assert.ok(args.includes('--restricted')); assert.ok(args.includes('--safe-mode')); assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(value('--mcp-config')), { mcpServers: {} }); assert.equal(value('--setting-sources'), '');
  const settings = JSON.parse(value('--settings'));
  // No shell, nothing for the OS sandbox to fence: it runs where it can, and is not required.
  assert.equal(settings.sandbox.enabled, true); assert.equal(settings.sandbox.failIfUnavailable, false);
  const shell = JSON.parse(claude({ role: { ...role, commands: ['npm test'] }, cwd, session: '12345678-1234-4234-8234-123456789abc' }).find((a, i, all) => all[i - 1] === '--settings'));
  assert.equal(shell.sandbox.failIfUnavailable, false, 'the sandbox is never required; the command prefixes still gate the shell');
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false); assert.equal(settings.sandbox.autoAllowBashIfSandboxed, false);
  assert.deepEqual(settings.sandbox.excludedCommands, []); assert.deepEqual(settings.sandbox.network.allowedDomains, []);
  assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.ok(settings.sandbox.filesystem.denyRead.includes('~/.ssh'));
  assert.ok(settings.sandbox.filesystem.denyWrite.includes(path.join(cwd, 'package.json'))); assert.equal(settings.disableAllHooks, true);
  assert.doesNotMatch(value('--tools'), /Bash|Agent|Task|WebFetch|WebSearch|PowerShell/);
  assert.equal(args.some((a) => /dangerously|bypass|--yolo/.test(a)), false);
});
test('forbidden command prefixes are refused before either vendor can launch', () => {
  for (const command of ['git push', 'git push origin main', 'git push --force', 'git tag', 'git merge', 'npm publish', 'npm install', 'npx arbitrary', 'curl', 'env node', 'bash -c', 'node -e', 'xargs', 'docker run']) assert.throws(() => commandRule(command), undefined, command);
});
test('stream fixtures parse; truncated and unexpected server streams cannot report done', () => {
  const fixture = (file) => fs.readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
  assert.equal(parseClaude(fixture('claude.jsonl')).result.outcome, 'done');
  assert.throws(() => parseClaude(fixture('claude.jsonl').split('\n')[0]));
  assert.throws(() => parseClaude(fixture('claude.jsonl').replace('"mcp_servers":[]', '"mcp_servers":[{"name":"external"}]')));
});

// The profiles with permissions. The relay settings stand in for a run's private MCP file.
const SESSION = '12345678-1234-4234-8234-123456789abc';
// A file name pattern of the sandbox's lists (* any run of characters) as a test.
const glob = name => new RegExp(`^${name.replace(/[.+^$(){}|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
function modeFixture(t) {
  const cwd = temp(t), mcp = { file: path.join(cwd, 'mcp.json'), names: ['elu-code-approval'] };
  fs.writeFileSync(mcp.file, '{"mcpServers":{}}');
  const role = defaultConfig().roles.lead, protectedPaths = ['.elu-code', '.git', 'package.json'], commonDir = path.join(cwd, '.git');
  return { cwd, mcp, role, protectedPaths, commonDir, base: { role, cwd, protectedPaths, commonDir, session: SESSION, mcp, approval: { tool: APPROVAL_TOOL } } };
}
const valueOf = (args, flag) => args[args.indexOf(flag) + 1];
const settingsOf = args => JSON.parse(valueOf(args, '--settings'));

test('ask, auto and full launch through the approval relay, ask and auto deny the never list and secrets, and none runs agents', t => {
  const f = modeFixture(t);
  const lockedArgs = claude({ role: f.role, cwd: f.cwd, protectedPaths: f.protectedPaths, commonDir: f.commonDir, session: SESSION });
  assert.deepEqual(claude({ mode: 'locked', role: f.role, cwd: f.cwd, protectedPaths: f.protectedPaths, commonDir: f.commonDir, session: SESSION }), lockedArgs, 'locked is the default and byte-identical');
  const expectedModes = { ask: 'default', auto: 'auto', full: 'bypassPermissions' };
  for (const mode of ['ask', 'auto', 'full']) {
    const args = claude({ ...f.base, mode }), settings = settingsOf(args), tools = valueOf(args, '--tools').replace(/^default$/, 'Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch').split(',');
    assert.equal(args[0], '-p'); assert.equal(valueOf(args, '--permission-mode'), expectedModes[mode], mode);
    assert.equal(valueOf(args, '--permission-prompts'), 'host'); assert.equal(valueOf(args, '--permission-prompt-tool'), 'mcp__elu-code-approval__approve');
    assert.equal(args.includes('--restricted'), false); assert.equal(args.includes('--safe-mode'), false);
    assert.ok(args.includes('--strict-mcp-config')); assert.equal(valueOf(args, '--mcp-config'), f.mcp.file); assert.equal(valueOf(args, '--setting-sources'), '');
    assert.ok(args.includes('--no-chrome')); assert.equal(mode === 'full' ? args.includes('--disallowedTools') : valueOf(args, '--disallowedTools') === 'Agent,Task,NotebookEdit,PowerShell,Monitor', mode !== 'full');
    assert.equal(valueOf(args, '--session-id'), SESSION);
    // No spending limit unless the owner set one; a limit goes to the vendor as it is.
    assert.equal(f.role.maxCostUsd, null); assert.equal(args.includes('--max-budget-usd'), false, mode);
    const capped = claude({ ...f.base, mode, role: { ...f.role, maxCostUsd: 3 } }); assert.equal(valueOf(capped, '--max-budget-usd'), '3', mode);
    for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebFetch', 'WebSearch']) assert.ok(tools.includes(tool), `${mode} has ${tool}`);
    assert.ok(tools.includes('Bash'), `${mode} has a shell; without the OS sandbox its commands follow the mode`);
    // Full access has no never list: no deny rule of it on the command line.
    for (const rule of NEVER_RULES) assert.equal(settings.permissions.deny.includes(rule), mode !== 'full', `${mode} ${mode === 'full' ? 'runs' : 'denies'} ${rule}`);
    if (mode === 'full') assert.equal(args.some(arg => NEVER_RULES.some(rule => arg.includes(rule))), false, 'no never-list rule anywhere in the Full access argv');
    assert.ok(NEVER_RULES.includes('Bash(git push:*)') && NEVER_RULES.includes('Bash(terraform apply:*)') && NEVER_RULES.includes('Bash(claude mcp add:*)') && NEVER_RULES.includes('Bash(elu mcp add:*)') && NEVER_RULES.length === 22);
    // Full access is everything: no deny rule at all, home secrets included.
    if (mode === 'full') assert.deepEqual(settings.permissions.deny, [], 'Full access denies nothing');
    else {
      for (const name of ['.env*', '.npmrc', '.netrc', 'auth.json', 'credentials.json', 'id_rsa', '*.pem']) assert.ok(settings.permissions.deny.includes(`Read(**/${name})`), `${mode} denies ${name}`);
      const home = fs.realpathSync(os.homedir());
      assert.ok(settings.permissions.deny.includes(`Read(//${path.join(home, '.ssh').slice(1)}/**)`)); assert.ok(settings.permissions.deny.includes(`Read(//${path.join(home, '.claude.json').slice(1)})`));
    }
    assert.equal('blockReadsOutsideWorkingDirectories' in settings.permissions, false, 'file tools reach outside the workspace and ask');
    assert.equal(settings.disableAllHooks, true); assert.equal(settings.enableAllProjectMcpServers, false);
    assert.equal(args.some(a => /dangerously|--yolo/.test(a)), false);
    assert.equal(args.filter(a => a === '--add-dir').length, 0, 'no folders, no --add-dir');
  }
});
test('ask and auto keep the sandbox and the protected paths; full drops the sandbox, the cap and the allow list', t => {
  const f = modeFixture(t), guarded = path.join(f.cwd, 'package.json');
  for (const mode of ['ask', 'auto']) {
    const args = claude({ ...f.base, mode }), settings = settingsOf(args);
    assert.equal(settings.sandbox.enabled, true); assert.equal(settings.sandbox.autoAllowBashIfSandboxed, true); assert.equal(settings.sandbox.allowUnsandboxedCommands, true);
    assert.equal(settings.sandbox.failIfUnavailable, false, 'the sandbox is never required'); assert.deepEqual(settings.sandbox.excludedCommands, []);
    assert.deepEqual(settings.sandbox.network.allowedDomains, []); assert.equal(settings.sandbox.network.allowLocalBinding, false);
    assert.ok(settings.sandbox.filesystem.denyWrite.includes(guarded)); assert.ok(settings.sandbox.filesystem.denyWrite.includes(f.commonDir));
    assert.ok(settings.sandbox.filesystem.denyRead.includes('~/.ssh')); assert.ok(settings.sandbox.filesystem.denyRead.includes('**/.env*'));
    assert.ok(settings.permissions.deny.includes(`Edit(//${guarded.slice(1)})`)); assert.ok(settings.permissions.deny.includes(`Write(//${guarded.slice(1)}/**)`));
    assert.ok(args.includes('--allowedTools=Read')); assert.ok(args.includes(`--allowedTools=Edit(//${f.cwd.slice(1)}/**)`));
    assert.equal(args.includes('--allowedTools=mcp__elu-code-approval'), false, 'the relay is never an allowed tool');
  }
  assert.deepEqual(settingsOf(claude({ ...f.base, mode: 'ask' })).permissions.ask, ['WebFetch', 'WebSearch'], 'web tools ask in ask');
  assert.equal(settingsOf(claude({ ...f.base, mode: 'auto' })).permissions.ask, undefined, 'the reviewer model decides in auto');
  const full = claude({ ...f.base, mode: 'full' }), settings = settingsOf(full);
  assert.deepEqual(settings.sandbox, { enabled: false }); assert.equal(settings.permissions.ask, undefined);
  assert.equal(full.some(a => a.startsWith('--allowedTools=')), false, 'full has no allow list');
  assert.equal(settings.permissions.deny.some(rule => rule.includes('package.json')), false, 'full lifts the protected paths');
  assert.deepEqual(settings.permissions.deny, [], 'no never list and no secret rule: Full access is everything');
  assert.ok(full.includes('--permission-mode') && valueOf(full, '--permission-mode') === 'bypassPermissions');
  // An answer turn (a read role) keeps its folder write-denied in ask and auto, so an edit there asks like any outside edit.
  const answer = { ...f.role, access: 'read', commands: [], writablePaths: [] };
  for (const mode of ['ask', 'auto']) {
    const args = claude({ ...f.base, mode, role: answer }), value = settingsOf(args);
    assert.ok(value.permissions.ask.includes(`Edit(//${f.cwd.slice(1)}/**)`) && value.permissions.ask.includes(`Write(//${f.cwd.slice(1)}/**)`), mode);
    assert.ok(value.sandbox.filesystem.denyWrite.includes(f.cwd)); assert.equal(args.some(a => a.startsWith('--allowedTools=Edit')), false);
  }
  assert.equal(settingsOf(claude({ ...f.base, mode: 'full', role: answer })).permissions.ask, undefined);
});

test('ask and auto keep the file tools out of the repository\'s Git folder, which a worktree sits outside; full does not', t => {
  const f = modeFixture(t), common = path.join(fs.realpathSync(temp(t)), 'main checkout', '.git'), records = path.join(common, 'elu-code');
  const closed = [`Edit(//${common.slice(1)})`, `Edit(//${common.slice(1)}/**)`, `Write(//${common.slice(1)})`, `Write(//${common.slice(1)}/**)`, `Read(//${records.slice(1)})`, `Read(//${records.slice(1)}/**)`];
  for (const mode of ['ask', 'auto']) for (const role of [f.role, { ...f.role, access: 'read', commands: [], writablePaths: [] }]) {
    const settings = settingsOf(claude({ ...f.base, mode, role, commonDir: common }));
    for (const rule of closed) assert.ok(settings.permissions.deny.includes(rule), `${mode} ${role.access} ${rule}`);
    assert.equal(settings.permissions.deny.includes(`Read(//${common.slice(1)}/**)`), false, 'Git history itself stays readable');
    assert.ok(settings.sandbox.filesystem.denyWrite.includes(common), 'a sandboxed command may not change it either');
    assert.equal(settings.sandbox.filesystem.denyRead.includes(common), false, 'a sandboxed git reads the repository');
    assert.ok(settings.sandbox.filesystem.denyRead.includes(records), 'and reads none of the records');
  }
  const full = settingsOf(claude({ ...f.base, mode: 'full', commonDir: common }));
  assert.equal(full.permissions.deny.some(rule => rule.includes(common.slice(1))), false, 'Full access may change the checkout it was given');
  // Read only keeps its file tools out of the records too: with the Git folder inside the folder
  // it runs in, outside it, or reached through a link (both spellings of the path are denied).
  const inside = path.join(fs.realpathSync(f.cwd), '.git'), link = path.join(fs.realpathSync(temp(t)), 'linked'); fs.mkdirSync(inside); fs.symlinkSync(inside, link);
  const readRules = dir => [`Read(//${path.join(dir, 'elu-code').slice(1)})`, `Read(//${path.join(dir, 'elu-code').slice(1)}/**)`];
  for (const [where, dir, spelled] of [['in the project folder', inside, [inside]], ['in a worktree', common, [common]], ['through a link', link, [link, inside]]]) {
    const settings = settingsOf(claude({ role: f.role, cwd: f.cwd, protectedPaths: f.protectedPaths, commonDir: dir, session: SESSION }));
    for (const rule of spelled.flatMap(readRules)) assert.ok(settings.permissions.deny.includes(rule), `Read only ${where}: ${rule}`);
    assert.equal(settings.permissions.deny.includes(`Read(//${dir.slice(1)}/**)`), false, 'Git history itself stays readable');
    const fenced = settings.sandbox.filesystem;
    assert.ok(fenced.denyWrite.includes(dir) && !fenced.denyRead.includes(dir), `Read only ${where}: a command reads the Git folder and writes nothing there`);
    for (const spelling of spelled) assert.ok(fenced.denyRead.includes(path.join(spelling, 'elu-code')), `Read only ${where}: a command reads none of the records`);
  }
  assert.throws(() => claude({ ...f.base, mode: 'ask', commonDir: path.join(common, 'odd*name') }), /cannot be expressed safely/);
});
test('a mode needs the relay and the MCP file; a peer run and a locked run refuse every lift', t => {
  const f = modeFixture(t);
  assert.throws(() => claude({ ...f.base, mode: 'auto', approval: null }), /needs the approval relay/);
  assert.throws(() => claude({ ...f.base, mode: 'auto', approval: { tool: 'Bash' } }), /needs the approval relay/);
  assert.throws(() => claude({ ...f.base, mode: 'auto', mcp: null }), /MCP config that starts the approval relay/);
  assert.throws(() => claude({ ...f.base, mode: 'yolo' }), /Choose ask, auto, or full/);
  const reviewer = readRole('claude');
  for (const mode of ['ask', 'auto', 'full']) assert.throws(() => claude({ ...f.base, mode, role: reviewer, peer: true }), /A peer run stays read-only/, mode);
  assert.throws(() => claude({ ...f.base, mode: 'locked' }), /A read-only run has no folders, place, or approvals/);
  assert.throws(() => claude({ role: f.role, cwd: f.cwd, commonDir: f.commonDir, session: SESSION, folders: [f.cwd] }), /no folders, place, or approvals/);
  assert.throws(() => claude({ role: f.role, cwd: f.cwd, commonDir: f.commonDir, session: SESSION, place: { kind: 'here' } }), /no folders, place, or approvals/);
});
const addDirs = args => args.flatMap((a, i) => a === '--add-dir' ? [args[i + 1]] : []);
const writeRules = dir => ['Edit', 'Write'].flatMap(tool => [`${tool}(//${dir.slice(1)})`, `${tool}(//${dir.slice(1)}/**)`]);
// A named folder is denied to the file tools' writes and to a sandboxed command's; none of it.
const writeDenied = (settings, dir) => writeRules(dir).every(rule => settings.permissions.deny.includes(rule)) && settings.sandbox.filesystem?.denyWrite.includes(dir) === true;
const writeOpen = (settings, dir) => writeRules(dir).every(rule => !settings.permissions.deny.includes(rule)) && settings.sandbox.filesystem?.denyWrite.includes(dir) !== true;
test('folders become --add-dir working directories, read and never written in ask and auto, and a resumed mode run keeps its session', t => {
  const f = modeFixture(t), outside = temp(t), folders = [path.join(outside, 'docs'), path.join(outside, 'shared')];
  for (const dir of folders) fs.mkdirSync(dir);
  const answer = { ...f.role, access: 'read', commands: [], writablePaths: [] };
  for (const mode of ['ask', 'auto', 'full']) for (const role of [f.role, answer]) {
    const args = claude({ ...f.base, mode, role, folders }), settings = settingsOf(args);
    assert.deepEqual(addDirs(args), folders, mode);
    assert.equal(args.some(a => a.startsWith('--allowedTools=Edit(//' + folders[0].slice(1))), false, 'a folder is never an allowed edit');
    for (const dir of folders) {
      assert.ok(mode === 'full' ? writeOpen(settings, dir) : writeDenied(settings, dir), `${mode} ${role.access}: ${dir} is ${mode === 'full' ? 'as Full access leaves it' : 'read only'}`);
      assert.equal(settings.permissions.deny.some(rule => rule.startsWith(`Read(//${dir.slice(1)}`)), false, `${mode}: ${dir} is read`);
    }
  }
  const resumed = claude({ ...f.base, mode: 'auto', resume: SESSION });
  assert.equal(valueOf(resumed, '--resume'), SESSION); assert.equal(resumed.includes('--session-id'), false);
});
// The folder of all your projects holds each project and the worktrees beside it, and a
// repository in a named folder is edited in a worktree inside that folder. A deny wins over
// an allow, so a folder that holds the workspace, or lies inside it, keeps the workspace's
// rules; so does one that holds the folder the run's commands keep their temporary files in.
test('a named folder that holds the workspace, lies inside it, or holds the run\'s temporary folder is not write-denied; the others are', t => {
  const f = modeFixture(t), projects = temp(t), cwd = path.join(projects, 'app.elu-code', '7'), inside = path.join(cwd, 'docs'), notes = path.join(projects, 'notes'), linked = path.join(temp(t), 'projects');
  for (const dir of [inside, notes]) fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(projects, linked);
  for (const mode of ['ask', 'auto']) for (const role of [f.role, { ...f.role, access: 'read', commands: [], writablePaths: [] }]) {
    const args = claude({ ...f.base, mode, role, cwd, folders: [projects, linked, inside, notes] }), settings = settingsOf(args);
    assert.deepEqual(addDirs(args), [projects, linked, inside, notes], `${mode}: each is still read`);
    for (const dir of [projects, linked, inside]) assert.ok(writeOpen(settings, dir), `${mode} ${role.access}: ${dir} is left to the workspace's rules`);
    assert.ok(writeDenied(settings, notes), `${mode} ${role.access}: a folder beside the workspace is read only`);
    if (role.access === 'edit') assert.ok(args.includes(`--allowedTools=Edit(//${cwd.slice(1)}/**)`), 'edits in the workspace stay allowed');
  }
  // Claude Code's temporary files go in <cache folder>/elu/<two letters> (privateTemp); a
  // command that cannot write there ends 1, so a folder that holds it is not write-denied.
  // A short cache folder, so that the path fits in Claude Code's 44 bytes.
  const cache = fs.mkdtempSync('/tmp/e'), before = process.env.XDG_CACHE_HOME;
  t.after(() => { if (before === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = before; fs.rmSync(cache, { recursive: true, force: true }); });
  process.env.XDG_CACHE_HOME = cache;
  const named = fs.realpathSync(cache), settings = settingsOf(claude({ ...f.base, mode: 'ask', folders: [named, notes] }));
  assert.ok(writeOpen(settings, named), 'the folder of the run\'s temporary files stays writable'); assert.ok(writeDenied(settings, notes));
});
test('parse reports the profile Claude ran with and its denials, clipped and nothing else', () => {
  const init = { type: 'system', subtype: 'init', session_id: 's', model: 'claude-fable-5-1', permissionMode: 'default', mcp_servers: [{ name: 'elu-code-approval', status: 'connected' }] };
  const result = { type: 'result', is_error: false, session_id: 's', total_cost_usd: 0.1, structured_output: { outcome: 'done', summary: 'x', question: null, choices: [], comments: [], responses: [] }, permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'curl https://example.test' }, extra: 'ignored' }, { tool_name: 'Write', tool_input: 'y'.repeat(5000) }] };
  const parsed = parseClaude([init, result].map(row => JSON.stringify(row)).join('\n'), { servers: ['elu-code-approval'] });
  assert.equal(parsed.effectiveMode, 'ask'); assert.equal(parsed.denials.length, 2);
  assert.deepEqual(parsed.denials[0], { tool: 'Bash', input: { command: 'curl https://example.test' }, tool_use_id: 'toolu_1' });
  assert.equal(parsed.denials[1].input.length, 4096); assert.equal(parsed.denials[1].tool_use_id, null);
  for (const [reported, expected] of [['auto', 'auto'], ['bypassPermissions', 'full'], ['acceptEdits', 'ask'], ['dontAsk', 'locked'], ['plan', 'locked'], ['other', null]]) {
    assert.equal(parseClaude([{ ...init, permissionMode: reported }, { ...result, permission_denials: [] }].map(row => JSON.stringify(row)).join('\n'), { servers: ['elu-code-approval'] }).effectiveMode, expected, reported);
  }
  const plain = parseClaude([{ ...init, permissionMode: undefined }, { ...result, permission_denials: undefined }].map(row => JSON.stringify(row)).join('\n'), { servers: ['elu-code-approval'] });
  assert.equal(plain.effectiveMode, null); assert.deepEqual(plain.denials, []);
});

test('the file tools read a tracked .npmrc in every mode, and below Full access are kept from an untracked one by path', t => {
  const f = modeFixture(t), root = f.cwd, run = (...args) => gitIn(root, args);
  run('init', '--initial-branch=main'); run('config', 'user.name', 'Test Owner'); run('config', 'user.email', 'owner@example.invalid');
  fs.mkdirSync(path.join(root, 'backend/agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'backend/agents/.npmrc'), 'registry=https://registry.npmjs.org/\n'); run('add', 'backend/agents/.npmrc'); run('commit', '-m', 'Add npmrc');
  fs.writeFileSync(path.join(root, '.npmrc'), '//registry.npmjs.org/:_authToken=x\n'); fs.writeFileSync(path.join(root, 'id_rsa'), 'key\n');
  const tracked = path.join(root, 'backend/agents/.npmrc'), loose = path.join(root, '.npmrc'), key = path.join(root, 'id_rsa');
  const rule = file => `Read(//${file.slice(1)})`;
  assert.deepEqual(settingsOf(claude({ ...f.base, mode: 'full' })).permissions.deny, [], 'Full access closes nothing');
  for (const mode of ['locked', 'ask', 'auto']) {
    const args = mode === 'locked' ? claude({ role: f.role, cwd: root, protectedPaths: f.protectedPaths, commonDir: f.commonDir, session: SESSION }) : claude({ ...f.base, mode });
    const { deny } = settingsOf(args).permissions;
    assert.ok(deny.includes(rule(loose)), `${mode}: the untracked .npmrc stays closed`);
    if (mode !== 'locked') assert.ok(deny.includes(rule(key)), `${mode}: an untracked key stays closed`);
    assert.equal(deny.some(entry => entry.includes('backend/agents') || /^Read\(\*\*\//.test(entry)), false, `${mode}: no rule closes the tracked ${path.relative(root, tracked)}, by path or by name`);
  }
  // Outside a Git work tree every file of those names stays closed below Full access.
  const plain = modeFixture(t);
  assert.ok(settingsOf(claude({ ...plain.base, mode: 'ask' })).permissions.deny.includes('Read(**/.npmrc)'));
  assert.deepEqual(settingsOf(claude({ ...plain.base, mode: 'full' })).permissions.deny, []);
});

test('a sandboxed command is kept from untracked secret files by path, never from tracked ones, which Git must read', t => {
  const f = modeFixture(t), root = f.cwd, run = (dir, ...args) => gitIn(dir, args);
  run(root, 'init', '--initial-branch=main'); run(root, 'config', 'user.name', 'Test Owner'); run(root, 'config', 'user.email', 'owner@example.invalid');
  const write = (name, text) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };
  // Tracked: an .npmrc and an .env.example the repository keeps, which every clone has.
  write('backend/agents/.npmrc', 'registry=https://registry.npmjs.org/\n'); write('.env.example', 'API_KEY=\n'); write('.gitignore', '.env\n.repos/\n');
  run(root, 'add', '.'); run(root, 'commit', '-m', 'Add sample');
  // Untracked: an ignored .env, a key nobody added, another repository inside this one, and an
  // ignored checkout of another repository, whose files Git never lists from here.
  write('.env', 'API_KEY=secret\n'); write('keys/dev.pem', 'key\n'); fs.mkdirSync(path.join(root, 'vendor/lib'), { recursive: true }); run(path.join(root, 'vendor/lib'), 'init'); write('vendor/lib/.env', 'X=1\n');
  fs.mkdirSync(path.join(root, '.repos/other'), { recursive: true }); run(path.join(root, '.repos/other'), 'init'); write('.repos/other/.env', 'TOKEN=secret\n'); write('.repos/other/.npmrc', '//registry.npmjs.org/:_authToken=x\n');
  const reads = secretReads(root), globs = reads.filter(entry => entry.includes('/**/')), covers = file => reads.includes(file) || globs.some(entry => file.startsWith(`${entry.slice(0, entry.indexOf('/**/'))}/`) && glob(entry.slice(entry.indexOf('/**/') + 4)).test(path.basename(file)));
  assert.ok(reads.includes(path.join(root, '.env')), 'an untracked secret in a folder Git tracks is hidden by path');
  assert.ok(covers(path.join(root, 'keys/dev.pem')) && reads.includes(`${path.join(root, 'keys')}/**/*.pem`), 'one in a folder Git tracks nothing in, by the names in that folder');
  assert.ok(covers(path.join(root, 'vendor/lib/.env')), 'a repository inside keeps the names');
  assert.ok(covers(path.join(root, '.repos/other/.env')) && covers(path.join(root, '.repos/other/.npmrc')), 'an ignored repository inside keeps them too');
  assert.equal(reads.some(entry => entry.startsWith('**/')) || [path.join(root, 'backend/agents/.npmrc'), path.join(root, '.env.example')].some(covers), false, 'tracked files stay readable, so git status, diff and add read them');
  assert.deepEqual(secretReads(path.join(root, 'backend')), [], 'from a folder inside, only what lies under it');
  for (const mode of ['ask', 'auto']) {
    const args = claude({ ...f.base, mode }), { denyRead, denyWrite } = settingsOf(args).sandbox.filesystem;
    assert.ok(denyRead.includes(path.join(root, '.env')) && !denyRead.includes('**/.npmrc'), `${mode}: the launch hides the untracked ones only`);
    assert.deepEqual(unwritable(args), denyWrite, `${mode}: what the launch closed to writes reads back from it`);
  }
  // Outside a Git work tree every match is hidden by name, as before.
  assert.deepEqual(secretReads(temp(t)), ['**/.env*', '**/.npmrc', '**/auth.json', '**/credentials.json', '**/*.pem']);
});
test('what the sandbox refused inside a command is a denial: the host it kept off the internet, the file it would not write', () => {
  const closed = { cwd: '/srv/app', unwritable: ['/srv/app', '/srv/app/.git', '/etc'] };
  assert.deepEqual(sandboxRefusal('curl: (56) CONNECT tunnel failed, response 403\n<sandbox_violations>\ndeny network-outbound elu.dev:443 (user denied)\n</sandbox_violations>'), { network: 'elu.dev' });
  assert.deepEqual(sandboxRefusal("OSError: [Errno 30] Read-only file system: 'src/session-intelligence/tools.ts'", closed), { readonly: 'src/session-intelligence/tools.ts' });
  assert.deepEqual(sandboxRefusal("touch: cannot touch '/etc/x': Read-only file system", closed), { readonly: '/etc/x' });
  assert.deepEqual(sandboxRefusal("fatal: Unable to create '/srv/app/.git/index.lock': Read-only file system.", closed), { readonly: '/srv/app/.git/index.lock' });
  assert.equal(sandboxRefusal('ok\n'), null);
  // What a program printed is its own: the host only from the block Claude Code appends after
  // it, and a file only where this launch closed it to writes.
  assert.equal(sandboxRefusal('lib/adapters/claude.mjs:  // deny network-outbound evil.example:443\nnot ok 3'), null, 'a log line that names a host');
  assert.equal(sandboxRefusal('<sandbox_violations>\ndeny network-outbound evil.example:443\n</sandbox_violations>\nnot ok 3 - the parser test'), null, 'a block the program printed, with its own output after');
  assert.equal(sandboxRefusal("OSError: [Errno 30] Read-only file system: 'src/a.ts'", { cwd: '/srv/app', unwritable: ['/srv/app/.git'] }), null, 'a file the launch let it write');
  assert.equal(sandboxRefusal("OSError: [Errno 30] Read-only file system: 'src/a.ts'"), null, 'nothing closed, nothing refused');
  assert.equal(sandboxRefusal('error: Read-only file system', closed), null, 'no file named');
  const line = row => JSON.stringify(row);
  const stream = results => [
    line({ type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-x', permissionMode: 'default', mcp_servers: [] }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'curl -sS https://elu.dev/' } }, { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: "python3 -c \"open('src/a.ts','w')\"" } }] } }),
    line({ type: 'user', message: { content: results } }),
    line({ type: 'result', is_error: false, session_id: SESSION, total_cost_usd: 0, structured_output: { outcome: 'needs_input', summary: 'Blocked.', question: 'May I?', choices: [], comments: [], responses: [] } }),
  ].join('\n');
  const failed = [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'Exit code 56\ncurl: (56) CONNECT tunnel failed, response 403\n<sandbox_violations>\ndeny network-outbound elu.dev:443 (user denied)\n</sandbox_violations>', is_error: true }, { type: 'tool_result', tool_use_id: 'toolu_b', content: "OSError: [Errno 30] Read-only file system: 'src/a.ts'", is_error: true }];
  const shown = ({ denials }) => denials.map(({ tool, tool_use_id, network, readonly }) => ({ tool, tool_use_id, network, readonly }));
  assert.deepEqual(shown(parseClaude(stream(failed), { cwd: '/srv/app', unwritable: ['/srv/app'] })), [{ tool: 'Bash', tool_use_id: 'toolu_a', network: 'elu.dev', readonly: undefined }, { tool: 'Bash', tool_use_id: 'toolu_b', network: undefined, readonly: 'src/a.ts' }]);
  // A command that succeeded was refused nothing, whatever it printed: a grep of this very file.
  assert.deepEqual(shown(parseClaude(stream(failed.map(row => ({ ...row, is_error: undefined }))), { cwd: '/srv/app', unwritable: ['/srv/app'] })), []);
  // A launch that left the folder writable: the file is the program's own trouble.
  assert.deepEqual(shown(parseClaude(stream(failed), { cwd: '/srv/app', unwritable: ['/srv/app/.git'] })).map(row => row.tool_use_id), ['toolu_a']);
});

test('a repository added inside another by hand, with no .gitmodules entry, keeps the secret names for the shell and the file tools', t => {
  const f = modeFixture(t), root = f.cwd, run = (dir, ...args) => gitIn(dir, args);
  for (const dir of [root, path.join(root, 'inner')]) { fs.mkdirSync(dir, { recursive: true }); run(dir, 'init', '--initial-branch=main'); run(dir, 'config', 'user.name', 'Test Owner'); run(dir, 'config', 'user.email', 'owner@example.invalid'); }
  fs.writeFileSync(path.join(root, 'inner/README.md'), 'inner\n'); run(path.join(root, 'inner'), 'add', '.'); run(path.join(root, 'inner'), 'commit', '-m', 'Inner');
  fs.writeFileSync(path.join(root, 'README.md'), 'outer\n'); run(root, 'add', 'README.md', 'inner'); run(root, 'commit', '-m', 'Add a clone by hand');
  assert.match(run(root, 'ls-files', '-s', 'inner'), /^160000 /, 'held as a commit in the index');
  assert.equal(fs.existsSync(path.join(root, '.gitmodules')), false);
  fs.writeFileSync(path.join(root, 'inner/.env'), 'TOKEN=secret\n');
  const reads = secretReads(root), dir = path.join(root, 'inner');
  assert.ok(reads.includes(`${dir}/**/.env*`) && reads.includes(`${dir}/**/.npmrc`), 'the sandbox hides the names inside it');
  for (const mode of ['locked', 'ask', 'auto', 'full']) {
    const args = mode === 'locked' ? claude({ role: f.role, cwd: root, protectedPaths: f.protectedPaths, commonDir: f.commonDir, session: SESSION }) : claude({ ...f.base, mode });
    assert.equal(settingsOf(args).permissions.deny.includes(`Read(//${dir.slice(1)}/**/.env*)`), mode !== 'full', `${mode}: the file tools are denied them too, except in Full access`);
  }
});
