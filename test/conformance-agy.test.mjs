import test from 'node:test';
import { liveTodos } from '../lib/plan.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as agy from '../lib/adapters/agy.mjs';
import { MATCHERS, TOOLS, decide, neverListed } from '../lib/agy-hook.mjs';
import { requireConformance, runConformance } from '../lib/conformance.mjs';
import { detect } from '../lib/detect.mjs';
import { resultSchema } from '../lib/config.mjs';
import { policyReport } from '../lib/policy.mjs';
import { agentEnv } from '../lib/process.mjs';
import { personalDirectory } from '../lib/util.mjs';
import { runSteps } from '../lib/run-activity.mjs';
import { FAKES } from './helpers.mjs';

const HOOK = fileURLToPath(new URL('../lib/agy-hook.mjs', import.meta.url));
const UUID = /^[0-9a-f-]{36}$/;
const lead = { vendor: 'agy', access: 'edit', network: 'off', commands: [], writablePaths: ['.'], timeoutSeconds: 900, maxCostUsd: null };
const reader = { ...lead, access: 'read', writablePaths: [] };
const result = { outcome: 'done', summary: 'ok', question: null, choices: [], comments: [], responses: [] };
function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-agy-'))), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
// The fake agy in a bin folder with fake.json beside it; `set` rewrites the fake's switches.
function install(dir, config = {}) {
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'fake.json'), calls = path.join(dir, 'calls.jsonl');
  const set = value => fs.writeFileSync(file, JSON.stringify({ mode: 'normal', calls, inputs: path.join(dir, 'inputs.jsonl'), agy: value }));
  set(config);
  fs.writeFileSync(path.join(bin, 'agy'), `#!${process.execPath}\n${fs.readFileSync(path.join(FAKES, 'agy.mjs'), 'utf8')}`, { mode: 0o755 });
  const last = () => fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)).at(-1);
  return { bin: path.join(bin, 'agy'), set, last };
}
function repo(dir) {
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  const git = args => { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
  git(['init', '-q', '--initial-branch=main']); git(['config', 'user.name', 'T']); git(['config', 'user.email', 't@example.invalid']);
  fs.writeFileSync(path.join(root, 'README.md'), '# repo\n'); git(['add', '.']); git(['commit', '-qm', 'init']);
  return root;
}
const schemaAt = dir => { const file = path.join(dir, 'schema.json'); fs.writeFileSync(file, JSON.stringify(resultSchema())); return file; };
const settingsOf = (mode, cwd) => JSON.parse(fs.readFileSync(path.join(agy.privateHome({ mode, cwd }), '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
const hooksOf = (mode, cwd) => JSON.parse(fs.readFileSync(path.join(agy.privateHome({ mode, cwd }), '.gemini', 'config', 'hooks.json'), 'utf8'));

test('argv per profile is a fixed snapshot; settings and the hook are written per profile under the private HOME', t => {
  const dir = home(t), cwd = path.join(dir, 'ws'), folder = path.join(dir, 'folder'); fs.mkdirSync(cwd); fs.mkdirSync(folder); fs.mkdirSync(path.join(cwd, '.git'));
  const schemaFile = schemaAt(dir), personal = path.resolve(personalDirectory()), owner = os.homedir();
  const base = { cwd, protectedPaths: ['.git', 'package.json'], commonDir: path.join(cwd, '.git'), schemaFile, folders: [folder] };
  const tokens = [[schemaFile, '<schema>'], [folder, '<folder>'], [cwd, '<cwd>']];
  const tokenise = value => tokens.reduce((text, [from, to]) => text.split(from).join(to), value);
  const common = ['-p', 'Your task is on standard input. Read it fully, then do exactly what it says.', '--output-format', 'json', '--json-schema', '<schema>', '--print-timeout', '2000000s'];
  const expected = {
    locked: [...common, '--sandbox'],
    ask: [...common, '--add-dir', '<folder>'],
    auto: [...common, '--mode=accept-edits', '--sandbox', '--add-dir', '<folder>'],
    full: [...common, '--dangerously-skip-permissions', '--add-dir', '<folder>'],
  };
  // Settings and the hook are rewritten for each launch in the workspace's HOME, so each profile's are read right after its launch.
  const written = {};
  for (const [mode, argv] of Object.entries(expected)) {
    assert.deepEqual(agy.launch({ ...base, role: mode === 'locked' ? reader : lead, mode, place: mode === 'full' ? { kind: 'here' } : { kind: 'worktree' } }).map(tokenise), argv, mode);
    assert.equal(agy.launch({ ...base, role: mode === 'locked' ? reader : lead, mode }).some(a => /dangerously|skip-permissions/.test(a)), mode === 'full', mode);
    const privateHome = agy.privateHome({ mode, cwd });
    assert.ok(privateHome.startsWith(`${path.join(personal, 'agy-home')}${path.sep}`), privateHome);
    assert.equal(fs.statSync(privateHome).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(privateHome, '.gemini', 'antigravity-cli', 'settings.json')).mode & 0o777, 0o600);
    const settings = settingsOf(mode, cwd), hooks = hooksOf(mode, cwd).hooks.PreToolUse; written[mode] = settings;
    assert.deepEqual(settings.trustedWorkspaces, [cwd]);
    // Full access is everything: slash commands stay on and no hook of ELU's is installed.
    if (mode === 'full') { assert.equal('disableSlashCommands' in settings, false); assert.deepEqual(hooks, []); assert.equal(MATCHERS.full, undefined); }
    else {
      assert.equal(settings.disableSlashCommands, true);
      assert.equal(hooks.length, 1); assert.equal(hooks[0].matcher, MATCHERS[mode]);
      assert.equal(hooks[0].hooks[0].type, 'command'); assert.ok(hooks[0].hooks[0].command.includes(HOOK) && hooks[0].hooks[0].command.endsWith(`--profile ${mode}`), hooks[0].hooks[0].command);
    }
    // Full access runs in the mirror of the owner's home beside the workspace's HOME; its .gemini is this one's.
    const env = agy.childEnv({ mode, cwd, home: dir }), runHome = mode === 'full' ? `${privateHome}-full` : privateHome;
    assert.equal(env.HOME, runHome); assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
    assert.equal(agentEnv({ PATH: '/bin' }, agy.meta.envKeys, env).HOME, runHome, 'the override passes the personal-directory rule');
    assert.equal(policyReport({ ...lead, vendor: 'agy' }, { mode }).rules.length, 7);
  }
  // One HOME per workspace, whatever the mode, so a conversation survives a mode switch; another workspace has its own.
  // Full access reads the same .gemini through its mirror.
  assert.notEqual(agy.privateHome({ mode: 'ask', cwd }), agy.privateHome({ mode: 'ask', cwd: folder })); assert.equal(agy.privateHome({ mode: 'ask', cwd }), agy.privateHome({ mode: 'auto', cwd }));
  assert.equal(agy.privateHome({ cwd }), agy.privateHome({ mode: 'full', cwd })); assert.equal(fs.readlinkSync(path.join(`${agy.privateHome({ cwd })}-full`, '.gemini')), path.join(agy.privateHome({ cwd }), '.gemini'));
  const { locked, ask, auto, full } = written;
  assert.deepEqual(locked.permissions.deny, ['command(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)']);
  assert.equal(locked.toolPermission, 'request-review'); assert.equal(locked.allowNonWorkspaceAccess, false); assert.equal(locked.enableTerminalSandbox, true);
  assert.deepEqual(ask.permissions.ask, ['command(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)']); assert.equal(ask.allowNonWorkspaceAccess, false);
  for (const rules of [ask.permissions.deny, auto.permissions.deny]) {
    assert.ok(rules.includes(`write_file(${path.join(cwd, 'package.json')})`), 'protected files are denied to the file tool');
    assert.ok(rules.includes(`write_file(${path.join(cwd, '.git')}/)`)); assert.ok(rules.includes(`write_file(${personal}/)`));
    assert.ok(rules.some(rule => rule.startsWith(`write_file(${path.join(owner, '.ssh')}`)), 'secret homes are denied');
    assert.ok(rules.every(rule => /^write_file\(|^command\(sudo\)$/.test(rule)));
    assert.ok(rules.includes(`write_file(${folder}/)`), 'a named folder is read, never written');
  }
  assert.equal(full.permissions.deny, undefined, 'Full access leaves a named folder as it is');
  assert.equal(auto.toolPermission, 'proceed-in-sandbox'); assert.ok(auto.permissions.deny.includes('command(sudo)')); assert.equal(auto.enableTerminalSandbox, true);
  assert.equal(full.allowNonWorkspaceAccess, true); assert.deepEqual(full.permissions.allow, ['read_url(*)', 'execute_url(*)', 'mcp(*)']);
  assert.deepEqual(Object.keys(full.permissions), ['allow'], 'Full access is everything: no deny rule, home secrets included');
  // Opening a saved conversation runs agy under the workspace HOME, where the conversation lives.
  const saved = crypto.randomUUID(), open = agy.interactive({ session: saved, cwd });
  assert.deepEqual([open.bin, open.args], ['agy', ['--conversation', saved]]); assert.equal(open.env.HOME, agy.privateHome({ cwd })); assert.equal(open.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
  assert.throws(() => agy.interactive({ session: '../x', cwd }), /Invalid Antigravity conversation id/);
  // Resume, model, and what is refused.
  const id = crypto.randomUUID();
  assert.deepEqual(agy.launch({ ...base, role: { ...lead, model: 'gemini-3-pro' }, mode: 'ask', resume: id }).slice(-4), ['--model', 'gemini-3-pro', '--conversation', id]);
  assert.ok(!agy.launch({ ...base, role: reader, mode: 'locked' }).includes('--add-dir'), 'locked reads the workspace only');
  assert.throws(() => agy.launch({ ...base, role: reader, mode: 'locked', peer: true }), /A teammate's question needs Claude as the model/);
  assert.throws(() => agy.launch({ ...base, role: lead, mode: 'locked' }), /Antigravity CLI cannot edit in Read only/);
  assert.throws(() => agy.launch({ ...base, role: lead, mode: 'ask', place: { kind: 'here' } }), /Here needs Full access/);
  assert.throws(() => agy.launch({ ...base, role: { ...lead, maxCostUsd: 3 }, mode: 'ask' }), /dollar budget/);
  assert.throws(() => agy.launch({ ...base, role: lead, mode: 'ask', resume: '../x' }), /conversation id/);
  assert.throws(() => agy.launch({ ...base, role: lead, mode: 'ask', folders: ['relative'] }), /absolute/);
  assert.throws(() => agy.launch({ ...base, role: lead, mode: 'ask', cwd: path.join(dir, 'a(b)') }), /cannot be expressed/);
  assert.throws(() => agy.launch({ ...base, role: lead, mode: 'yolo' }), /Choose ask, auto, or full/);
});

// The folder of all your projects holds each project and the worktrees beside it, and a
// repository in a named folder is edited in a worktree inside that folder. A deny wins over
// the workspace's edits, so a folder that holds the workspace, or lies inside it, keeps the
// workspace's rules.
test('a named folder that holds the workspace or lies inside it is not denied to the file tool; one beside it is', t => {
  const dir = home(t), projects = path.join(dir, 'projects'), cwd = path.join(projects, 'app.elu-code', '7'), inside = path.join(cwd, 'docs'), notes = path.join(projects, 'notes'), linked = path.join(dir, 'linked');
  for (const folder of [inside, notes, path.join(cwd, '.git')]) fs.mkdirSync(folder, { recursive: true });
  fs.symlinkSync(projects, linked);
  const schemaFile = schemaAt(dir), folders = [projects, linked, inside, notes];
  for (const mode of ['ask', 'auto']) {
    const args = agy.launch({ cwd, protectedPaths: ['.git'], commonDir: path.join(cwd, '.git'), schemaFile, folders, role: lead, mode });
    assert.deepEqual(args.flatMap((a, i) => a === '--add-dir' ? [args[i + 1]] : []), folders, `${mode}: each is still read`);
    const rules = settingsOf(mode, cwd).permissions.deny;
    for (const folder of [projects, linked, inside]) assert.equal(rules.includes(`write_file(${folder}/)`), false, `${mode}: ${folder} is left to the workspace's rules`);
    assert.ok(rules.includes(`write_file(${notes}/)`), `${mode}: a folder beside the workspace is read only`);
    assert.ok(rules.includes(`write_file(${path.join(cwd, '.git')}/)`), `${mode}: protected paths stay denied`);
  }
});

test('until its one-time check passed here compile refuses and says what starts the check, parse needs no pin, and detect never runs the binary', async t => {
  const dir = home(t), marker = path.join(dir, 'ran'), bins = path.join(dir, 'bin'), bin = path.join(bins, 'agy'); fs.mkdirSync(bins);
  fs.writeFileSync(bin, `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');process.exit(0);\n`, { mode: 0o755 });
  assert.deepEqual(agy.meta.supportedVersions, [], 'no release is pinned in the adapter');
  assert.throws(() => agy.compile({ role: reader, cwd: dir, schemaFile: schemaAt(dir) }), /^EluCodeError: Antigravity CLI has not been checked on this machine yet\. Your first message to it runs the check\.$/);
  assert.deepEqual(agy.parse(JSON.stringify({ structured_output: result })).result, result);
  const row = (await detect(dir, { PATH: bins })).find(value => value.vendor === 'agy');
  assert.equal(row.available, true); assert.equal(row.supported, false); assert.equal(row.signedIn, null); assert.equal(row.conformant, false);
  // The row says what Antigravity does here and what will start its check, not that it is unsupported.
  assert.equal(row.support, 'sessions and reviews'); assert.equal(row.reason, 'Antigravity CLI has not been checked on this machine yet. Your first message to it runs the check.');
  assert.equal(fs.existsSync(marker), false, 'never run, not even for --version');
  assert.throws(() => requireConformance('agy', { bin, version: '1.5.4' }), /Antigravity CLI has not been checked on this machine yet/);
  assert.deepEqual(agy.meta.signInHint.split('\n'), ['Antigravity: not signed in for ELU. Sign it in with s on its line in the Usage tab.', "Google's FAQ: wrapping agy in third-party agents is not supported on consumer plans. antigravity.google/docs/faq"]);
  assert.equal(agy.meta.installHint, 'Install agy from antigravity.google/docs');
});

test('the hook denies every matched tool in locked, the never list in every profile but Full access, asks or denies web search, and fails closed', () => {
  for (const tool of TOOLS) assert.equal(decide('locked', { tool_name: tool, tool_input: {} }).decision, 'deny', tool);
  assert.equal(decide('locked', { tool_name: 'view_file', tool_input: {} }), null);
  const never = ['git push origin main', 'git -C . push', 'git -c a=b tag v1', 'git merge feature', 'gh pr merge 5', 'gh release create v1', 'npm publish', 'cargo publish', 'echo ok && git push', 'sudo terraform apply', 'kubectl apply -f x', 'gcloud run deploy api', 'fly deploy',
    'claude mcp add elu https://x', 'claude mcp add-json elu {}', 'claude --debug mcp remove elu', 'echo ok && elu mcp add x https://x'];
  for (const profile of ['ask', 'auto']) for (const command of never) assert.equal(decide(profile, { tool_name: 'run_command', tool_input: { CommandLine: command } })?.decision, 'deny', `${profile}: ${command}`);
  // Full access runs the never list: the hook has no opinion on it.
  for (const command of never) assert.equal(decide('full', { tool_name: 'run_command', tool_input: { CommandLine: command } }), null, `full: ${command}`);
  for (const command of ['npm test', 'git status', 'git log --oneline', 'echo git push', 'terraform plan', 'claude mcp list', 'elu mcp']) { assert.equal(neverListed(command), false, command); assert.equal(decide('ask', { tool_name: 'run_command', tool_input: { CommandLine: command } }), null, command); }
  assert.equal(decide('full', { tool_name: 'run_command', tool_input: { command: 'ls' } }), null);
  // A command word ends where the word does: a longer word is another command.
  for (const command of ['git merge-base HEAD origin/main', 'git tag-list', 'git -C . merge-base HEAD main', 'echo ok && git merge-base HEAD main', 'yarn publish-docs']) { assert.equal(neverListed(command), false, command); for (const profile of ['ask', 'auto', 'full']) assert.deepEqual(decide(profile, { tool_name: 'run_command', tool_input: { CommandLine: command } }), decide(profile, { tool_name: 'run_command', tool_input: { CommandLine: 'ls' } }), `${profile}: ${command} is decided as any other command`); }
  for (const command of ['git merge main', 'git merge', 'git tag v1', 'git tag', 'git push', 'git push>log', 'git push&', 'npm publish', 'echo ok; git tag']) assert.equal(neverListed(command), true, command);
  assert.equal(decide('ask', { tool_name: 'search_web', tool_input: { query: 'x' } }).decision, 'ask');
  assert.equal(decide('auto', { tool_name: 'search_web', tool_input: { query: 'x' } }).decision, 'deny');
  assert.equal(decide('full', { tool_name: 'search_web', tool_input: { query: 'x' } }), null);
  assert.equal(decide('auto', { tool_name: 'write_to_file', tool_input: {} }).decision, 'ask', 'auto sends the rest to the reviewer');
  assert.equal(decide('ask', { tool_name: 'write_to_file', tool_input: {} }), null, 'ask leaves edits to the vendor');
  assert.equal(decide('nope', { tool_name: 'view_file' }).decision, 'deny'); assert.equal(decide('ask', null).decision, 'deny'); assert.equal(decide('ask', { tool_name: 7 }).decision, 'deny');
  // The script itself: deny prints the decision and exits 2, ask exits 0, no opinion prints nothing, unreadable input denies.
  const run = (profile, input) => spawnSync(process.execPath, [HOOK, ...(profile ? ['--profile', profile] : [])], { input, encoding: 'utf8' });
  const denied = run('locked', JSON.stringify({ tool_name: 'write_to_file', tool_input: { TargetFile: 'x' } }));
  assert.equal(denied.status, 2); assert.equal(JSON.parse(denied.stdout).decision, 'deny'); assert.match(denied.stderr, /read-only run/);
  const asked = run('ask', JSON.stringify({ tool_name: 'search_web', tool_input: { query: 'x' } }));
  assert.equal(asked.status, 0); assert.equal(JSON.parse(asked.stdout).decision, 'ask');
  const silent = run('ask', JSON.stringify({ tool_name: 'run_command', tool_input: { CommandLine: 'ls' } }));
  assert.equal(silent.status, 0); assert.equal(silent.stdout, '');
  assert.equal(run('ask', 'not json').status, 2); assert.equal(run('ask', '').status, 2); assert.equal(run(null, '{"tool_name":"view_file"}').status, 2);
});

test('parseOutput reads the result, the conversation id and stderr soft-denies; classify names auth, quota and rate limits', () => {
  const id = crypto.randomUUID();
  const parsed = agy.parseOutput(JSON.stringify({ conversationId: id, model: 'gemini-3-pro', structured_output: result, stats: {} }, null, 2), { stderr: 'agy: soft-denied run_command (permissions.deny: command)\na plain log line\nagy: soft-denied write_to_file (sandbox)\n' });
  assert.deepEqual(parsed, { result, session: id, model: 'gemini-3-pro', costUsd: null, denials: [{ tool: 'run_command', summary: 'agy: soft-denied run_command (permissions.deny: command)' }, { tool: 'write_to_file', summary: 'agy: soft-denied write_to_file (sandbox)' }] });
  assert.deepEqual(agy.parseOutput(JSON.stringify({ session_id: id, response: `Here you go:\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\`` })).result, result, 'a response string carries the JSON');
  assert.equal(agy.parseOutput(`{"type":"progress"}\n${JSON.stringify({ conversation_id: id, structured_output: result })}\n`).session, id, 'a stream ends with the result');
  assert.equal(agy.parseOutput(JSON.stringify({ conversationId: 'not a plain id', structured_output: result })).session, null);
  assert.deepEqual(agy.extractJson(`Working.\nHere is the result:\n${JSON.stringify({ a: { b: 1 } }, null, 2)}\n`), { a: { b: 1 } });
  assert.equal(agy.extractJson('[1,2]'), null); assert.equal(agy.extractJson('no json'), null);
  assert.throws(() => agy.parseOutput(''), /no JSON run result/);
  assert.throws(() => agy.parseOutput(JSON.stringify({ error: { message: 'authentication required' } })), error => error.details.cause === 'auth');
  assert.throws(() => agy.parseOutput(JSON.stringify({ structured_output: { outcome: 'nope' } })), /unknown field|invalid/);
  assert.deepEqual(agy.denialsFrom(`${'x'.repeat(400)} denied\n`)[0].summary.length, 200);
  assert.equal(agy.classify('authentication required'), 'auth'); assert.equal(agy.classify('RESOURCE_EXHAUSTED: quota'), 'quota');
  assert.equal(agy.classify('HTTP 429 too many requests'), 'rate-limit'); assert.equal(agy.classify('something else'), 'unknown');
});

test('headless runs against the fake: locked soft-denies with exit 0, ask denies outside edits, full writes anywhere, a conversation resumes in its HOME and starts fresh in another, a signed-out probe fails', async t => {
  const dir = home(t), ws = repo(dir), fake = install(dir), schemaFile = schemaAt(dir), outside = path.join(dir, 'outside.txt'), marker = path.join(dir, 'marker.sh'), ran = path.join(dir, 'ran');
  fs.writeFileSync(outside, 'planted\n'); fs.writeFileSync(marker, `#!/bin/sh\nprintf ran > ${JSON.stringify(ran)}\n`, { mode: 0o700 });
  let n = 0;
  const go = options => agy.run({ bin: fake.bin, logFile: path.join(dir, `run-${n++}.log`), timeoutSeconds: 60, relay: false, cwd: ws, protectedPaths: ['.git'], commonDir: path.join(ws, '.git'), schemaFile, session: crypto.randomUUID(), ...options });
  const locked = await go({ mode: 'locked', role: reader, prompt: `Create the file ${outside}.locked with text. Run this command: ${marker}. Fetch http://127.0.0.1:9/nowhere and report.` });
  assert.equal(locked.exitCode, 0); assert.equal(locked.effectiveMode, 'locked'); assert.equal(locked.result.outcome, 'blocked'); assert.match(locked.session, UUID);
  assert.deepEqual(locked.denials.map(row => row.tool), ['write_to_file', 'run_command', 'read_url']); assert.match(locked.denials[0].summary, /^agy: soft-denied write_to_file/);
  assert.equal(fs.existsSync(`${outside}.locked`), false); assert.equal(fs.existsSync(ran), false);
  const call = fake.last();
  assert.equal(call.home, agy.privateHome({ mode: 'locked', cwd: ws })); assert.equal(call.autoUpdate, 'true'); assert.ok(call.args.includes('--sandbox'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'inputs.jsonl'), 'utf8').trim().split('\n').at(-1)).input.includes('Create the file'), true, 'the prompt went on stdin');
  const full = await go({ mode: 'full', role: lead, prompt: `Create the file ${outside}.full with text.` });
  assert.equal(fs.readFileSync(`${outside}.full`, 'utf8'), 'elu-code\n'); assert.deepEqual(full.denials, []); assert.equal(full.result.outcome, 'done');
  const ask = await go({ mode: 'ask', role: lead, prompt: `Create the file ${path.join(ws, 'inside.txt')} with text. Create the file ${outside}.ask with text.` });
  assert.equal(fs.existsSync(path.join(ws, 'inside.txt')), true); assert.equal(fs.existsSync(`${outside}.ask`), false);
  assert.equal(ask.denials.length, 1); assert.match(ask.denials[0].summary, /outside the workspace; headless/);
  const nonce = crypto.randomUUID();
  const first = await go({ mode: 'locked', role: reader, prompt: `Remember this nonce: ${nonce}. Reply with the summary "noted".` });
  const second = await go({ mode: 'locked', role: reader, prompt: 'Reply with the nonce from earlier in this conversation.', resume: first.session });
  assert.equal(first.result.summary, 'noted'); assert.equal(second.result.summary, nonce); assert.equal(second.session, first.session);
  assert.ok(fake.last().args.includes('--conversation'));
  // The HOME is the workspace's, so the conversation survives a mode switch (a switch applies from the next turn).
  const switched = await go({ mode: 'full', role: lead, prompt: 'Reply with the nonce from earlier in this conversation.', resume: first.session });
  assert.equal(switched.result.summary, nonce); assert.equal(switched.session, first.session); assert.ok(fake.last().args.includes('--conversation'));
  // In Full access the HOME is the mirror beside the workspace's, whose .gemini is the workspace's own.
  assert.equal(fake.last().home, `${agy.privateHome({ cwd: ws })}-full`); assert.equal(fs.realpathSync(path.join(fake.last().home, '.gemini')), path.join(agy.privateHome({ cwd: ws }), '.gemini'));
  // A conversation agy no longer has starts fresh in one turn, with its own log; a sign-in failure is not launched twice.
  const calls = () => fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').length;
  fs.rmSync(path.join(agy.privateHome({ cwd: ws }), '.gemini', 'antigravity-cli', 'brain', first.session), { recursive: true, force: true });
  const gone = await go({ mode: 'full', role: lead, prompt: 'Reply with the nonce from earlier in this conversation.', resume: first.session });
  assert.equal(gone.result.summary, 'No nonce in this conversation.'); assert.match(gone.session, UUID); assert.notEqual(gone.session, first.session);
  assert.ok(!fake.last().args.includes('--conversation')); assert.match(gone.log, /run-\d+-fresh\.log$/); assert.ok(fs.existsSync(gone.log));
  fake.set({ signedIn: false });
  assert.equal(await agy.signedIn({ bin: fake.bin, cwd: ws }), false);
  const launches = calls();
  await assert.rejects(go({ mode: 'locked', role: reader, prompt: 'Reply with the summary "x".', resume: first.session }), error => error.details.cause === 'auth' && /authentication required/.test(error.message));
  assert.equal(calls(), launches + 1);
  fake.set({});
  assert.equal(await agy.signedIn({ bin: fake.bin, cwd: ws }), true);
  const probe = fake.last();
  assert.deepEqual(probe.args, ['-p', '/usage', '--output-format', 'json']); assert.equal(probe.home, path.join(path.resolve(personalDirectory()), 'agy-home', 'signin')); assert.equal(probe.autoUpdate, 'true');
});

// agy reads ~/.gemini from HOME and has no flag for another place, so Full access cannot run in
// the owner's home: its ~ is a mirror of it (lib/home-mirror.mjs) whose .gemini is ELU's.
test('in Full access ~ is a mirror of the owner\'s home with the workspace\'s own .gemini in it; the other modes keep the private HOME with nothing of his in it', async t => {
  const dir = home(t), ws = repo(dir), fake = install(dir), schemaFile = schemaAt(dir), owner = path.join(dir, 'owner'), script = path.join(dir, 'who.sh'), out = path.join(dir, 'who.out');
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode: 0o600 }); };
  put(path.join(owner, '.npmrc'), 'owner-npm-token\n'); put(path.join(owner, '.config', 'gcloud', 'token'), 'owner-cloud-token\n');
  put(path.join(owner, '.gemini', 'antigravity-cli', 'settings.json'), '{"his":"settings"}\n'); put(path.join(owner, '.gemini', 'GEMINI.md'), 'his instructions\n'); put(path.join(owner, '.claude', 'CLAUDE.md'), 'his instructions\n');
  const his = () => ['.gemini/antigravity-cli/settings.json', '.gemini/GEMINI.md', '.claude/CLAUDE.md'].map(name => `${name} ${fs.readFileSync(path.join(owner, name), 'utf8')} ${fs.statSync(path.join(owner, name)).mtimeMs}`).concat(fs.readdirSync(path.join(owner, '.gemini'), { recursive: true }).sort()), before = his();
  fs.writeFileSync(script, `#!/bin/sh\ncd ~ || exit 1\n{ cat .npmrc .config/gcloud/token; echo from-run > .config/gcloud/from-run; echo made > .made-in-run; grep -c trustedWorkspaces .gemini/antigravity-cli/settings.json; [ -e .gemini/GEMINI.md ] && echo "his .gemini"; [ -e .claude ] && echo "sees .claude"; ls -A | grep -c .; } > ${JSON.stringify(out)} 2>&1\n`, { mode: 0o700 });
  let n = 0;
  const go = mode => agy.run({ bin: fake.bin, env: { ...process.env, HOME: owner }, logFile: path.join(dir, `run-${n++}.log`), timeoutSeconds: 60, relay: false, cwd: ws, protectedPaths: ['.git'], commonDir: path.join(ws, '.git'), schemaFile, session: crypto.randomUUID(), mode, role: mode === 'locked' ? reader : lead, prompt: `Run this command: ${script}. Reply with the summary "ran".` });
  const base = agy.privateHome({ cwd: ws }), mirror = `${base}-full`;
  await go('full');
  assert.equal(fake.last().home, mirror); assert.equal(fs.statSync(mirror).mode & 0o777, 0o700);
  // .npmrc, .config, .gemini (ELU's) and .made-in-run: four entries, and none of them his .gemini or .claude.
  assert.equal(fs.readFileSync(out, 'utf8'), 'owner-npm-token\nowner-cloud-token\n1\n4\n');
  assert.equal(fs.readFileSync(path.join(owner, '.config', 'gcloud', 'from-run'), 'utf8'), 'from-run\n');
  assert.equal(fs.readlinkSync(path.join(mirror, '.gemini')), path.join(base, '.gemini')); assert.equal(settingsOf('full', ws).allowNonWorkspaceAccess, true);
  // The runner settles the home when the run ends: what the command made at the top of ~ is his.
  assert.equal(fs.existsSync(path.join(owner, '.made-in-run')), false);
  agy.settleHome({ mode: 'ask', cwd: ws, home: owner }); assert.equal(fs.existsSync(path.join(owner, '.made-in-run')), false, 'only a Full access run has a mirror to settle');
  agy.settleHome({ mode: 'full', cwd: ws, home: owner }); assert.equal(fs.readFileSync(path.join(owner, '.made-in-run'), 'utf8'), 'made\n'); assert.ok(fs.lstatSync(path.join(mirror, '.made-in-run')).isSymbolicLink());
  assert.equal(agy.fullHome({ cwd: ws, home: owner }), mirror);
  // Read only and Ask for approval: the private HOME, holding ELU's .gemini and nothing else
  // (on a Mac whose owner has a keychain, also the one link to it: shareKeychain).
  const held = () => fs.readdirSync(base).filter(name => !(name === 'Library' && fs.readdirSync(path.join(base, 'Library')).join() === 'Keychains'));
  for (const mode of ['locked', 'ask']) { await go(mode); assert.equal(fake.last().home, base, mode); assert.deepEqual(held(), ['.gemini'], mode); assert.equal(agy.childEnv({ mode, cwd: ws, home: owner }).HOME, base, mode); }
  assert.equal(agy.childEnv({ mode: 'auto', cwd: ws, home: owner }).HOME, base); assert.equal(agy.interactive({ session: crypto.randomUUID(), cwd: ws }).env.HOME, base);
  assert.deepEqual(his(), before, 'his own ~/.gemini and ~/.claude were never written');
});

test('over ACP each plan update is handed on as it comes, and reads as subtasks while the turn still runs', async t => {
  const dir = home(t), ws = repo(dir), fake = install(dir), schemaFile = schemaAt(dir), gate = path.join(dir, 'go-on'), settings = path.join(dir, 'bin', 'fake.json');
  fs.writeFileSync(settings, JSON.stringify({ ...JSON.parse(fs.readFileSync(settings, 'utf8')), live: gate }));
  const read = liveTodos(), seen = [];
  // The stand-in waits for the gate after its plan: the list is read before the turn ends.
  const onRow = row => { const steps = read(row); if (steps) { seen.push({ steps, running: !fs.existsSync(gate) }); fs.writeFileSync(gate, ''); } };
  const done = await agy.run({ bin: fake.bin, logFile: path.join(dir, 'plan.log'), timeoutSeconds: 60, relay: true, approvals: null, cwd: ws, protectedPaths: ['.git'], commonDir: path.join(ws, '.git'), schemaFile, session: crypto.randomUUID(), role: lead, mode: 'ask', prompt: 'Keep the Task\'s subtasks in your own to-do list as you work. Reply with the summary "planned".', onRow });
  assert.equal(done.result.outcome, 'done');
  assert.deepEqual(seen, [{ steps: [{ id: 's1', text: 'Change normalize', state: 'done' }, { id: 's2', text: 'Run the coupon test', state: 'doing' }], running: true }]);
});

test('over ACP a permission request reaches the approvals and the answer decides: allow writes, deny and timeout do not and are recorded', async t => {
  const dir = home(t), ws = repo(dir), fake = install(dir), schemaFile = schemaAt(dir), outside = path.join(dir, 'relay');
  let n = 0;
  const approvals = decision => { const asked = []; return { asked, request: ({ tool, input, title }) => { asked.push({ tool, input, title }); return { id: `a-${asked.length}`, summary: title }; }, await: async () => decision }; };
  const go = (options, decision) => {
    const relay = decision === undefined ? null : approvals(decision);
    return agy.run({ bin: fake.bin, logFile: path.join(dir, `run-${n++}.log`), timeoutSeconds: 60, relay: true, approvals: relay, cwd: ws, protectedPaths: ['.git'], commonDir: path.join(ws, '.git'), schemaFile, session: crypto.randomUUID(), role: lead, mode: 'ask', ...options }).then(value => ({ ...value, asked: relay?.asked ?? [] }));
  };
  const allow = await go({ prompt: `Create the file ${outside}.allow with the text "relay".` }, 'allow');
  assert.equal(allow.asked.length, 1); assert.equal(allow.asked[0].tool, 'edit'); assert.equal(allow.asked[0].title, `Write ${outside}.allow`); assert.equal(allow.asked[0].input.TargetFile, `${outside}.allow`);
  assert.equal(fs.readFileSync(`${outside}.allow`, 'utf8'), 'elu-code\n'); assert.deepEqual(allow.denials, []); assert.equal(allow.result.outcome, 'done');
  assert.equal(allow.effectiveMode, 'ask'); assert.match(allow.session, UUID); assert.equal(allow.exitCode, 0); assert.ok(fake.last().args[0] === 'acp');
  assert.ok(fs.readFileSync(allow.log, 'utf8').trim().split('\n').every(line => JSON.parse(line).jsonrpc === '2.0'), 'the log holds the ACP lines');
  const deny = await go({ prompt: `Create the file ${outside}.deny with the text "relay".` }, 'deny');
  assert.equal(deny.asked.length, 1); assert.equal(fs.existsSync(`${outside}.deny`), false); assert.equal(deny.result.outcome, 'blocked');
  assert.deepEqual(deny.denials[0], { tool: 'edit', summary: `Write ${outside}.deny` }); assert.ok(deny.denials.some(row => row.tool === 'write_to_file'), 'the vendor notice is read too');
  const timeout = await go({ prompt: `Create the file ${outside}.timeout with the text "relay".` }, 'timeout');
  assert.equal(fs.existsSync(`${outside}.timeout`), false); assert.equal(timeout.denials[0].summary, `Write ${outside}.timeout (no answer from the owner)`);
  const nobody = await go({ prompt: `Create the file ${outside}.nobody with the text "relay".` });
  assert.equal(fs.existsSync(`${outside}.nobody`), false); assert.equal(nobody.denials[0].tool, 'edit');
  const inside = await go({ prompt: `Create the file ${path.join(ws, 'inside.txt')} with the text "relay".` }, 'deny');
  assert.equal(inside.asked.length, 0); assert.equal(fs.existsSync(path.join(ws, 'inside.txt')), true, 'a workspace edit asks nobody');
  const auto = await go({ mode: 'auto', prompt: 'Reply with the summary "auto".' }, 'allow');
  assert.equal(auto.effectiveMode, 'auto'); assert.equal(auto.result.summary, 'auto');
  const nonce = crypto.randomUUID();
  const first = await go({ prompt: `Remember this nonce: ${nonce}. Reply with the summary "noted".` }, 'allow');
  const second = await go({ prompt: 'Reply with the nonce from earlier in this conversation.', resume: first.session }, 'allow');
  assert.equal(second.session, first.session); assert.equal(second.result.summary, nonce);
  const fresh = await go({ prompt: 'Reply with the summary "fresh".', resume: crypto.randomUUID() }, 'allow');
  assert.equal(fresh.result.summary, 'fresh'); assert.notEqual(fresh.session, first.session, 'an unknown conversation starts a new one');
  const locked = await go({ mode: 'locked', role: reader, prompt: 'Reply with the summary "read".' }, 'allow');
  assert.equal(locked.result.summary, 'read'); assert.equal(fake.last().args[0], 'acp', 'Read only runs over ACP too where the relay is proven');
});

// Full access and Read only run over ACP too where the relay is proven here, so the log holds
// each thought and each tool call as it happens. ELU answers every permission request of
// those two itself, at once: yes to all in Full access, no to all in Read only.
const shown = steps => steps.map(step => [step.kind, step.text, ...(step.status ? [step.status] : [])]);
function world(t, config) {
  const dir = home(t), ws = repo(dir), fake = install(dir, config), schemaFile = schemaAt(dir), outside = path.join(dir, 'outside'), marker = path.join(dir, 'marker.sh'), ran = path.join(dir, 'ran');
  fs.writeFileSync(marker, `#!/bin/sh\nprintf ran > ${JSON.stringify(ran)}\n`, { mode: 0o700 });
  let n = 0; const asked = [];
  // The owner's approvals, as the runner hands them over: nothing may reach them in these two modes.
  const approvals = { request: row => { asked.push(row); return { id: `a-${asked.length}`, summary: row.title }; }, await: async () => 'allow' };
  const go = options => agy.run({ bin: fake.bin, logFile: path.join(dir, `run-${n++}.log`), timeoutSeconds: 60, relay: true, approvals, cwd: ws, protectedPaths: ['.git'], commonDir: path.join(ws, '.git'), schemaFile, session: crypto.randomUUID(), role: lead, mode: 'full', ...options });
  const calls = () => fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).args);
  const status = () => spawnSync('git', ['-C', ws, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
  return { dir, ws, fake, outside, marker, ran, asked, go, calls, status };
}
test('over ACP a Full access turn shows its thought and both tool calls, and every request is answered yes at once, for that request alone: the owner is asked nothing', async t => {
  const w = world(t);
  const full = await w.go({ prompt: `Create the file ${w.outside}.full with the text "x". Run this command: ${w.marker}. Reply with the summary "live".` });
  assert.deepEqual(w.fake.last().args, ['acp']); assert.equal(full.effectiveMode, 'full'); assert.equal(full.result.summary, 'live'); assert.equal(full.result.outcome, 'done'); assert.deepEqual(full.denials, []);
  assert.equal(fs.readFileSync(`${w.outside}.full`, 'utf8'), 'elu-code\n', 'written outside the project'); assert.equal(fs.readFileSync(w.ran, 'utf8'), 'ran');
  assert.deepEqual(w.asked, [], 'no request reached the owner');
  const rows = fs.readFileSync(full.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.filter(row => row.method === 'session/request_permission').length, 2, 'the vendor asked about the write and about the command');
  assert.deepEqual(shown(runSteps(full.log)), [['thinking', 'Reading the request.'], ['text', 'Working on it.'], ['tool', `Write ${w.outside}.full`, 'ok'], ['tool', `Run ${w.marker}`, 'ok'], ['text', 'Here is the result:']]);
  assert.equal(fs.existsSync(path.join(agy.privateHome({ cwd: w.ws }), '.gemini', 'antigravity-cli', 'brain', full.session, 'always')), false, 'never "always allow": the workspace HOME is shared with the other modes');
  // Full access is everything: no rule of ELU's refuses a write, in ELU's own folder either.
  const kept = path.join(personalDirectory(), 'full-wrote.txt');
  const everything = await w.go({ prompt: `Create the file ${kept} with the text "x". Reply with the summary "everything".` });
  assert.deepEqual(w.fake.last().args, ['acp']); assert.deepEqual(everything.denials, []); assert.equal(fs.readFileSync(kept, 'utf8'), 'elu-code\n'); assert.deepEqual(w.asked, []);
  // The conversation is the one a headless turn would resume, and the other way round.
  const nonce = crypto.randomUUID();
  const first = await w.go({ relay: false, mode: 'locked', role: reader, prompt: `Remember this nonce: ${nonce}. Reply with the summary "noted".` });
  const second = await w.go({ prompt: 'Reply with the nonce from earlier in this conversation.', resume: first.session });
  assert.equal(second.result.summary, nonce); assert.equal(second.session, first.session); assert.deepEqual(w.calls().slice(-2).map(args => args[0]), ['-p', 'acp']);
  const third = await w.go({ relay: false, prompt: 'Reply with the nonce from earlier in this conversation.', resume: second.session });
  assert.equal(third.result.summary, nonce);
});

test('over ACP a Read only turn writes nothing inside or outside the project, runs nothing and fetches nothing, also where the vendor asks instead of refusing: every request is answered no at once', async t => {
  const w = world(t), inside = path.join(w.ws, 'inside.txt');
  const text = `Create the file ${inside} with the text "x". Create the file ${w.outside}.locked with the text "x". Run this command: ${w.marker}. Fetch http://127.0.0.1:9/nowhere and report.`;
  const untouched = what => { assert.equal(fs.existsSync(inside), false, `${what}: inside`); assert.equal(fs.existsSync(`${w.outside}.locked`), false, `${what}: outside`); assert.equal(fs.existsSync(w.ran), false, `${what}: the command`); assert.equal(w.status(), '', `${what}: git status`); };
  const locked = await w.go({ mode: 'locked', role: reader, prompt: text });
  assert.deepEqual(w.fake.last().args, ['acp']); assert.equal(locked.effectiveMode, 'locked'); assert.equal(locked.result.outcome, 'blocked'); untouched('its own rules');
  assert.deepEqual(locked.denials.map(row => row.tool), ['write_to_file', 'write_to_file', 'run_command', 'read_url'], 'what its hook and rules refused is reported');
  assert.deepEqual(shown(runSteps(locked.log)).filter(step => step[0] === 'tool'), [['tool', `Write ${inside}`, 'failed'], ['tool', `Write ${w.outside}.locked`, 'failed'], ['tool', `Run ${w.marker}`, 'failed'], ['tool', 'read_url http://127.0.0.1:9/nowhere', 'failed']]);
  assert.equal(settingsOf('locked', w.ws).toolPermission, 'request-review'); assert.equal(hooksOf('locked', w.ws).hooks.PreToolUse[0].matcher, MATCHERS.locked);
  // A vendor whose own rules did not hold asks about each one: ELU's no is what stops it.
  w.fake.set({ asksDenied: true });
  const asking = await w.go({ mode: 'locked', role: reader, prompt: text });
  untouched('ELU\'s answers'); assert.equal(asking.result.outcome, 'blocked');
  assert.deepEqual(asking.denials.slice(0, 4), [{ tool: 'edit', summary: `Write ${inside}` }, { tool: 'edit', summary: `Write ${w.outside}.locked` }, { tool: 'execute', summary: `Run ${w.marker}` }, { tool: 'fetch', summary: 'read_url http://127.0.0.1:9/nowhere' }]);
  // One that edits the workspace over ACP without reading its rules is what the check's relay step catches.
  assert.deepEqual(w.asked, [], 'no request reached the owner');
});

test('an ACP run that cannot start runs headless instead in Full access and Read only, and names the log it then writes; Ask for approval and a signed-out agy do not', async t => {
  const w = world(t, { acpFails: true }), told = [];
  const full = await w.go({ fallback: log => told.push(log), prompt: `Create the file ${w.outside}.full with the text "x". Reply with the summary "printed".` });
  assert.deepEqual(w.calls().map(args => args[0]), ['acp', '-p']); assert.ok(w.calls().at(-1).includes('--dangerously-skip-permissions'));
  assert.equal(full.result.summary, 'printed'); assert.equal(full.effectiveMode, 'full'); assert.equal(fs.existsSync(`${w.outside}.full`), true);
  assert.deepEqual(told, [full.log]); assert.match(full.log, /run-0-print\.log$/); assert.match(fs.readFileSync(full.log, 'utf8'), /"structured_output"/);
  const locked = await w.go({ mode: 'locked', role: reader, fallback: log => told.push(log), prompt: `Create the file ${w.outside}.locked with the text "x". Reply with the summary "printed".` });
  assert.deepEqual(w.calls().slice(-2).map(args => args[0]), ['acp', '-p']); assert.ok(w.calls().at(-1).includes('--sandbox'));
  assert.equal(fs.existsSync(`${w.outside}.locked`), false); assert.equal(told.length, 2); assert.equal(locked.denials.length, 1);
  // The conversation a turn resumes is resumed by the headless run too.
  const again = await w.go({ fallback: log => told.push(log), prompt: 'Reply with the summary "again".', resume: full.session });
  assert.equal(again.session, full.session); assert.ok(w.calls().at(-1).includes('--conversation'));
  // In Ask for approval a headless run would refuse what the owner is asked about: it fails as before.
  const launches = w.calls().length;
  await assert.rejects(w.go({ mode: 'ask', fallback: log => told.push(log), prompt: 'Reply with the summary "x".' }), error => /^Antigravity could not finish\./.test(error.message) && error.details.unstarted === true);
  assert.equal(w.calls().length, launches + 1); assert.equal(told.length, 3);
  // Signed out is no start that failed: one launch, and the sign-in error.
  w.fake.set({ signedIn: false });
  await assert.rejects(w.go({ fallback: log => told.push(log), prompt: 'Reply with the summary "x".' }), error => error.details.cause === 'auth');
  assert.equal(w.calls().length, launches + 2); assert.equal(told.length, 3);
});

test('the conformance steps pass against the fake and record relay; a vendor that writes anyway, never asks, or is signed out fails', async t => {
  const dir = home(t), fake = install(dir), log = [], scratch = name => path.join(dir, name);
  const passed = await runConformance('agy', { bin: fake.bin, version: '1.5.4', scratch: scratch('s1'), env: process.env, log: line => log.push(line) });
  assert.deepEqual(passed, { steps: { signin: 'pass', 'locked-no-write': 'pass', 'locked-no-shell': 'pass', 'locked-no-network': 'pass', json: 'pass', resume: 'pass', relay: 'pass', 'live-read-only': 'pass' }, relay: true });
  assert.equal(requireConformance('agy', { bin: fake.bin, version: '1.5.4' }), true);
  // What decides ACP, per mode: relay for the three that may write, and the read-only step as well for Read only.
  assert.deepEqual(['locked', 'ask', 'auto', 'full'].map(mode => agy.acpProven(mode)), [true, true, true, true]);
  const state = (relay, readOnly) => ({ relay, steps: { relay: relay ? 'pass' : 'fail', ...(readOnly ? { 'live-read-only': readOnly } : {}) } });
  assert.deepEqual(['locked', 'ask', 'auto', 'full'].map(mode => agy.acpProven(mode, state(true, null))), [false, true, true, true], 'a check from before the read-only step existed');
  assert.deepEqual(['locked', 'ask', 'auto', 'full'].map(mode => agy.acpProven(mode, state(true, 'fail'))), [false, true, true, true]);
  assert.deepEqual(['locked', 'ask', 'auto', 'full'].map(mode => agy.acpProven(mode, state(false, 'pass'))), [false, false, false, false]);
  assert.deepEqual(['locked', 'full', 'nope'].map(mode => agy.acpProven(mode, null)), [false, false, false]);
  assert.ok(log.some(line => /^resume: conversation [0-9a-f-]{36}$/.test(line)), log.join('\n'));
  assert.deepEqual(agy.conformance.map(step => [step.id, step.required]), [['signin', true], ['locked-no-write', true], ['locked-no-shell', true], ['locked-no-network', true], ['json', true], ['resume', true], ['relay', false], ['live-read-only', false]]);
  fake.set({ ignoreDenies: true });
  const broken = await runConformance('agy', { bin: fake.bin, version: '1.5.4', scratch: scratch('s2'), env: process.env, log: line => log.push(line) });
  assert.deepEqual(broken.steps, { signin: 'pass', 'locked-no-write': 'fail', 'locked-no-shell': 'fail', 'locked-no-network': 'fail', json: 'pass', resume: 'pass', relay: 'fail', 'live-read-only': 'fail' }); assert.equal(broken.relay, false);
  assert.ok(log.some(line => /^locked-no-write: fail: locked run: wrote /.test(line))); assert.ok(log.some(line => line === 'locked-no-shell: fail: locked run ran a command')); assert.ok(log.some(line => line === 'locked-no-network: fail: locked run reached the network'));
  // It wrote in a read-only turn: Read only and the two asking modes stay off, with no promise that checking again changes it; Full access runs it.
  assert.throws(() => requireConformance('agy', { bin: fake.bin, version: '1.5.4' }), /^EluCodeError: Antigravity CLI did not pass its check on this machine, so it runs in Full access only here\. Not proven: a read-only turn writes no file \(locked run: wrote [^)]+\), and 2 more\. Switch this session to Full access to use it; c on its line in the Usage tab runs the check again\.$/);
  for (const mode of ['ask', 'auto']) assert.throws(() => requireConformance('agy', { bin: fake.bin, version: '1.5.4', mode }), /so it runs in Full access only here/, mode);
  assert.equal(requireConformance('agy', { bin: fake.bin, version: '1.5.4', mode: 'full' }), true);
  fake.set({ noPermissionRequest: true });
  const silent = await runConformance('agy', { bin: fake.bin, version: '1.5.4', scratch: scratch('s3'), env: process.env, log: line => log.push(line) });
  assert.deepEqual(silent, { steps: { signin: 'pass', 'locked-no-write': 'pass', 'locked-no-shell': 'pass', 'locked-no-network': 'pass', json: 'pass', resume: 'pass', relay: 'fail', 'live-read-only': 'pass' }, relay: false });
  assert.ok(log.some(line => line === 'relay: fail: no permission request arrived over ACP'));
  assert.equal(requireConformance('agy', { bin: fake.bin, version: '1.5.4' }), true, 'the relay step is optional: ask and auto fall back to deny and report');
  // The read-only step runs a Read only turn over ACP. One that asks where it should refuse
  // passes, since ELU says no; one that edits the workspace without reading its rules fails,
  // and so does one whose ACP never starts: a headless run proves nothing about ACP.
  fake.set({ asksDenied: true });
  const asking = await runConformance('agy', { bin: fake.bin, version: '1.5.4', scratch: scratch('s5'), env: process.env, log: line => log.push(line) });
  assert.equal(asking.steps['live-read-only'], 'pass', log.join('\n')); assert.equal(asking.relay, true); assert.equal(agy.acpProven('locked'), true);
  fake.set({ acpEditsFreely: true });
  const free = await runConformance('agy', { bin: fake.bin, version: '1.5.4', scratch: scratch('s6'), env: process.env, log: line => log.push(line) });
  assert.deepEqual(free, { steps: { signin: 'pass', 'locked-no-write': 'pass', 'locked-no-shell': 'pass', 'locked-no-network': 'pass', json: 'pass', resume: 'pass', relay: 'pass', 'live-read-only': 'fail' }, relay: true });
  assert.ok(log.some(line => /^live-read-only: fail: read-only run over ACP: wrote .*created\.txt$/.test(line)), log.join('\n'));
  assert.deepEqual(['locked', 'ask', 'full'].map(mode => agy.acpProven(mode)), [false, true, true], 'Read only stays headless here; the others still run over ACP');
  fake.set({ acpFails: true });
  const dead = await runConformance('agy', { bin: fake.bin, version: '1.5.4', scratch: scratch('s7'), env: process.env, log: line => log.push(line) });
  assert.equal(dead.steps.relay, 'fail'); assert.equal(dead.steps['live-read-only'], 'fail'); assert.ok(log.some(line => line === 'live-read-only: fail: agy acp did not start'), log.join('\n'));
  fake.set({ signedIn: false });
  const out = await runConformance('agy', { bin: fake.bin, version: '1.5.4', scratch: scratch('s4'), env: process.env, log: line => log.push(line) });
  assert.equal(out.steps.signin, 'fail'); assert.ok(log.some(line => line === 'signin: fail: not signed in for ELU; sign it in with s on its line in the Usage tab'));
  assert.throws(() => requireConformance('agy', { bin: fake.bin, version: '1.5.4' }), /^EluCodeError: Antigravity CLI did not pass its check on this machine, so it runs in Full access only here\. Not proven: it is signed in \(not signed in for ELU; sign it in with s on its line in the Usage tab\), and \d more\. Your next message to it runs the check again\.$/);
});
