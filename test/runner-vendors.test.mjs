import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, fakeClis, cli, git } from './helpers.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { taskDir, readTask, taskTitle, setTitle } from '../lib/state.mjs';
import { answerApproval, pendingApprovals } from '../lib/approvals.mjs';
import { atomic, fileLines, logLines, personalDirectory } from '../lib/util.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import * as agy from '../lib/adapters/agy.mjs';
import * as claude from '../lib/adapters/claude.mjs';
import { saveRule } from '../lib/permission-rules.mjs';
import { shimsBase } from '../lib/never-shims.mjs';

// Every vendor through the runner, against the fakes: Codex leads with its
// own launch and parse, Grok takes the prompt from a file under a private HOME, and an ACP
// vendor asks the owner through the approval files once its one-time check proved the relay here.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function setup(t, vendor, { mode = 'answer', name = undefined, commands = undefined, replay = undefined, note = undefined, badReply = undefined } = {}) {
  const p = project(t), fake = fakeClis(p.parent, { mode, name, commands, replay, note, badReply });
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  // The lead role as /agents would save it for this vendor: a time limit, no dollar budget.
  const controller = new ProjectController(projectFolder(p.root)); Object.assign(controller.draftConfig.roles.lead, { vendor, maxCostUsd: null });
  const calls = () => fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.vendor === vendor) : [];
  const inputs = () => fs.readFileSync(path.join(p.parent, 'inputs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.vendor === vendor);
  const marker = path.join(p.parent, 'marker.sh'), ran = path.join(p.parent, 'ran');
  fs.writeFileSync(marker, `#!/bin/sh\nprintf ran > ${JSON.stringify(ran)}\n`, { mode: 0o700 });
  // What the fake vendors answer from now on when a reply is asked to name its session.
  const say = name => fakeClis(p.parent, { mode, name });
  return { ...p, fake, controller, calls, inputs, marker, ran, say, bin: path.join(fake.dir, vendor), dir: id => taskDir(controller.repo, id) };
}
// The check's record for this binary: the release it proved, and whether the relay step passed.
const proven = (vendor, bin, version, { relay }) => atomic(path.join(personalDirectory(), 'conformance', `${vendor}.json`), { v: 1, bin, version, steps: Object.fromEntries(ADAPTERS[vendor].conformance.map(step => [step.id, relay || step.id !== 'relay' ? 'pass' : 'fail'])), relay, at: new Date().toISOString() });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function answer(decision, { vendor }) {
  for (let i = 0; i < 200; i++) {
    const row = pendingApprovals().find(row => row.vendor === vendor);
    if (row) { assert.equal(answerApproval(row.id, decision), true); return row; }
    await sleep(50);
  }
  throw new Error('no approval was requested');
}

test('a Codex lead answers in Approve for me with its sandboxed command; the same command declined becomes a denial', async t => {
  const f = setup(t, 'codex');
  const task = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'auto' }).finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error)); assert.equal(task.permissions, 'auto');
  const [run] = task.runs;
  assert.equal(run.vendor, 'codex'); assert.equal(run.permissions, 'auto'); assert.equal(run.denials, undefined); assert.equal(run.session, '12345678-1234-4234-8234-123456789abc');
  const call = f.calls().find(call => call.args[0] === 'exec');
  assert.ok(call.args.some(arg => /^default_permissions="elu_ask"$/.test(arg)), 'the lead launch carries its sandboxed profile');
  assert.ok(fs.readFileSync(run.logFile, 'utf8').includes('"command_execution"'), 'the stream showed the command the lead parse accepts');
  const second = await f.controller.ask('And the tests?', task.id).finished;
  assert.equal(second.state, 'answered', JSON.stringify(second.error)); assert.deepEqual(f.calls().filter(call => call.args[0] === 'exec').at(-1).args.slice(0, 3), ['exec', 'resume', run.session]);
});

for (const [mode, label] of [['ask', 'Ask for approval'], ['auto', 'Approve for me']]) {
  test(`a Codex session in ${label} refuses push, publish and merge by name, inside a script too, and still runs git status and a push to a folder here`, async t => {
    const f = setup(t, 'codex', { commands: ['git push origin HEAD', 'npm publish', 'gh pr merge 5', 'sh -c "git -C . push"', 'git status --short --branch', 'git push --quiet ../local.git HEAD:refs/heads/from-session'] });
    // The project's origin is on another machine; a bare repository beside the project is not.
    const local = path.join(f.parent, 'local.git'); git(f.root, ['remote', 'add', 'origin', 'ssh://git.invalid/sample.git']); git(f.parent, ['init', '--quiet', '--bare', local]);
    const task = await f.controller.ask('Publish it.', null, { permissions: mode }).finished;
    assert.equal(task.state, 'answered', JSON.stringify(task.error));
    const [run] = task.runs, call = f.calls().find(call => call.args[0] === 'exec');
    assert.ok(call.args.includes('allow_login_shell=false'), 'a login shell would put the system folders ahead of the stand-ins');
    const steps = fs.readFileSync(run.logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'item.completed' && row.item.type === 'command_execution').map(row => row.item);
    assert.deepEqual(steps.map(step => step.exit_code), [126, 126, 126, 126, 0, 0]);
    assert.deepEqual(steps.slice(0, 4).map(step => step.aggregated_output.trim()), ['git push', 'npm publish', 'gh pr merge', 'git push'].map(command => `${command} is not allowed outside Full access.`));
    assert.match(steps[4].aggregated_output, /^## /, 'git status reached the real git');
    assert.equal(git(local, ['for-each-ref', '--format=%(refname)']).trim(), 'refs/heads/from-session', 'pushing to a folder on this machine is not publishing');
    assert.deepEqual(run.denials.map(denial => denial.never), ['git push', 'npm publish', 'gh pr merge', 'git push'], 'each refused step is kept for the chat');
    assert.equal(run.denials[3].summary, 'Run: /bin/zsh -c \'sh -c "git -C . push"\'');
  });
}

// Full access has no never list. A bare repository beside the project stands for the remote,
// under a name of its own, and a stand-in gh first on PATH for GitHub's: nothing leaves this
// machine. --receive-pack is an option the git stand-in cannot read, so outside Full access it
// refuses even a push to a folder here.
function fullWorld(f) {
  const local = path.join(f.parent, 'local.git'), merged = path.join(f.parent, 'gh.calls');
  git(f.parent, ['init', '--quiet', '--bare', local]); git(f.root, ['remote', 'add', 'backup', local]);
  fs.writeFileSync(path.join(f.fake.dir, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(merged)}\necho "merged by the stand-in gh"\n`, { mode: 0o755 });
  const refs = () => git(local, ['for-each-ref', '--format=%(refname)']).trim().split('\n').filter(Boolean).sort();
  return { local, refs, merged: () => fs.existsSync(merged) ? fs.readFileSync(merged, 'utf8') : '' };
}
const FULL_COMMANDS = ['git push -u backup HEAD:refs/heads/from-session', 'git rev-parse --abbrev-ref --symbolic-full-name @{u}', 'git push --receive-pack=git-receive-pack backup HEAD:refs/heads/any-option', 'git tag v1',
  'git push --tags backup', 'sh -c "git -C . push backup HEAD:refs/heads/from-script"', 'printf "%s\\n" "$PATH"'];

test('a Codex session in Full access runs push, tags and a pull request merge: no stand-in refuses, no line of its instructions forbids them', async t => {
  const f = setup(t, 'codex', { commands: [...FULL_COMMANDS, 'gh pr merge 5 --squash'] }), w = fullWorld(f);
  const task = await f.controller.ask('Publish it.', null, { permissions: 'full' }).finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  const [run] = task.runs, steps = fs.readFileSync(run.logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'item.completed' && row.item.type === 'command_execution').map(row => row.item);
  assert.deepEqual(steps.map(step => step.exit_code), FULL_COMMANDS.map(() => 0).concat(0), steps.map(step => step.aggregated_output).join('\n'));
  assert.equal(steps[1].aggregated_output.trim(), 'backup/from-session', 'git push -u set the upstream');
  assert.deepEqual(w.refs(), ['refs/heads/any-option', 'refs/heads/from-script', 'refs/heads/from-session', 'refs/tags/v1']);
  assert.equal(git(f.root, ['tag', '--list']).trim(), 'v1');
  assert.equal(w.merged(), 'pr merge 5 --squash\n', 'gh pr merge reached the gh on PATH'); assert.match(steps.at(-1).aggregated_output, /merged by the stand-in gh/);
  assert.ok(steps[6].aggregated_output.trim().split(path.delimiter).every(dir => dir !== shimsBase() && !dir.startsWith(`${shimsBase()}${path.sep}`)), 'no stand-in folder on the PATH');
  assert.equal(run.denials, undefined, 'nothing was refused');
  const input = f.inputs().at(-1).input;
  assert.doesNotMatch(input, /Never run these|Do not push|not allowed outside Full access/);
  assert.match(input, /You may push, open and merge pull requests, tag, publish and deploy when the task calls for it\./);
});

// Claude Code refuses a never-list command the model types by a rule on its text. A script the
// session runs is not that text: there the stand-in refuses, once the file named in
// CLAUDE_ENV_FILE has put its folder back in front of the system's.
for (const [mode, label] of [['ask', 'Ask for approval'], ['auto', 'Approve for me']]) {
  test(`a Claude Code session in ${label} refuses a push and a publish that a script makes, and still runs git status and a push to a folder here`, async t => {
    const f = setup(t, 'claude', { commands: ['sh -c "git -C . push"', 'sh -c "npm publish"', 'git status --short --branch', 'git push --quiet ../local.git HEAD:refs/heads/from-session'] });
    const local = path.join(f.parent, 'local.git'); git(f.root, ['remote', 'add', 'origin', 'ssh://git.invalid/sample.git']); git(f.parent, ['init', '--quiet', '--bare', local]);
    const task = await f.controller.ask('Publish it.', null, { permissions: mode }).finished;
    assert.equal(task.state, 'answered', JSON.stringify(task.error));
    const [run] = task.runs, printed = fs.readFileSync(run.logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'user').map(row => row.message.content[0].content);
    assert.deepEqual(printed.slice(0, 2), ['git push', 'npm publish'].map(command => `Exit code 126\n${command} is not allowed outside Full access.\n`));
    assert.match(printed[2], /^## /, 'git status reached the real git'); assert.equal(printed[3], '');
    assert.equal(git(local, ['for-each-ref', '--format=%(refname)']).trim(), 'refs/heads/from-session', 'pushing to a folder on this machine is not publishing');
    assert.deepEqual(run.denials.map(denial => [denial.tool, denial.input.command, denial.never]), [['Bash', 'sh -c "git -C . push"', 'git push'], ['Bash', 'sh -c "npm publish"', 'npm publish']], 'each refused step is kept for the chat');
  });
}

// The commands run as Claude Code runs them: from a shell whose PATH starts with the system
// folders again, so gh is not run here (the one found first may be a real one).
test('a Claude Code session in Full access runs push and tags, in a script too: no deny rule, no stand-in, no CLAUDE_ENV_FILE', async t => {
  const f = setup(t, 'claude', { commands: [...FULL_COMMANDS, 'printf "%s" "${CLAUDE_ENV_FILE:-none}"', 'command -v git'] }), w = fullWorld(f);
  const task = await f.controller.ask('Publish it.', null, { permissions: 'full' }).finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  const [run] = task.runs, printed = fs.readFileSync(run.logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'user').map(row => row.message.content[0].content);
  assert.ok(printed.every(out => !out.startsWith('Exit code')), printed.join('\n'));
  assert.equal(printed[1].trim(), 'backup/from-session', 'git push -u set the upstream');
  assert.deepEqual(w.refs(), ['refs/heads/any-option', 'refs/heads/from-script', 'refs/heads/from-session', 'refs/tags/v1']);
  assert.equal(printed[FULL_COMMANDS.length], 'none', 'no file puts a stand-in folder back on PATH');
  assert.ok(!printed[FULL_COMMANDS.length + 1].startsWith(shimsBase()), 'git is the real one');
  assert.ok(printed[6].trim().split(path.delimiter).every(dir => dir !== shimsBase() && !dir.startsWith(`${shimsBase()}${path.sep}`)), 'no stand-in folder on the PATH');
  assert.equal(run.denials, undefined, 'nothing was refused');
  const call = f.calls().findLast(row => row.args.includes('--permission-prompt-tool')), deny = JSON.parse(call.args[call.args.indexOf('--settings') + 1]).permissions.deny;
  assert.equal(deny.some(rule => rule.startsWith('Bash(')), false, 'no never-list deny rule');
  assert.doesNotMatch(f.inputs().at(-1).input, /Never run these|Do not push|not allowed outside Full access/);
});

// Claude Code writes a note of its working folder after every command. Its own place for that
// is under /tmp, where its sandbox as ELU sets it denies writes, so every command ended
// "Exit code 1" whatever it did. ELU names a private folder of the run instead.
const printedBy = run => fs.readFileSync(run.logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'user').map(row => row.message.content[0].content);
for (const [mode, label] of [['ask', 'Ask for approval'], ['auto', 'Approve for me']]) {
  test(`a Claude Code session in ${label} keeps Claude Code's own temporary files in a private folder of the run, so a command that worked is not shown as failed`, async t => {
    const f = setup(t, 'claude', { commands: ['echo worked'], note: true });
    // A short folder, as a home folder's cache is: Claude Code goes back to /tmp past 44 bytes.
    const cache = fs.mkdtempSync('/tmp/e-'); t.after(() => fs.rmSync(cache, { recursive: true, force: true })); environment(t, { XDG_CACHE_HOME: cache });
    const task = await f.controller.ask('Say it worked.', null, { permissions: mode }).finished;
    assert.equal(task.state, 'answered', JSON.stringify(task.error));
    assert.deepEqual(printedBy(task.runs[0]), ['worked\n'], 'the command ended 0 and nothing was refused');
    const named = f.calls().findLast(call => call.args.includes('--permission-prompt-tool')).tmp;
    assert.match(named, /\/elu\/[0-9a-z]{2}$/); assert.equal(path.dirname(path.dirname(named)), cache);
    assert.equal(fs.existsSync(named), false, 'the folder goes when the run ends'); assert.deepEqual(fs.readdirSync(path.join(cache, 'elu')), []);
    assert.equal(fs.statSync(path.join(cache, 'elu')).mode & 0o777, 0o700);
  });
}

test('Claude Code keeps its own temporary folder in Full access, which has no sandbox, and where no folder short enough can be named', async t => {
  const f = setup(t, 'claude', { commands: ['echo worked'], note: true });
  const cache = fs.mkdtempSync('/tmp/e-'); t.after(() => fs.rmSync(cache, { recursive: true, force: true })); environment(t, { XDG_CACHE_HOME: cache });
  const full = await f.controller.ask('Say it worked.', null, { permissions: 'full' }).finished;
  assert.equal(full.state, 'answered', JSON.stringify(full.error));
  assert.equal(f.calls().findLast(call => call.args.includes('--permission-prompt-tool')).tmp, null); assert.deepEqual(printedBy(full.runs[0]), ['worked\n']);
  assert.equal(fs.existsSync(path.join(cache, 'elu')), false);
  // 44 bytes is the most Claude Code takes for <folder>/claude-<uid>.
  const at = (home, uid) => claude.tempBase({ env: {}, home, uid });
  assert.equal(at('/Users/sam', 1000), '/Users/sam/.cache'); assert.equal(at('/Users/a-rather-long-user-name', 1000), null);
  assert.equal(claude.tempBase({ env: { XDG_CACHE_HOME: '/c' }, home: '/Users/a-rather-long-user-name', uid: 1000 }), '/c');
  assert.equal(claude.tempBase({ env: { NODE_TEST_CONTEXT: 'child' }, home: '/Users/sam', uid: 1000 }), null, 'a test never makes one in the real home folder');
  const longest = `/Users/${'n'.repeat(11)}`, inside = uid => `/.cache/elu/00/${['claude', uid].join('-')}`;
  assert.equal(Buffer.byteLength(`${longest}${inside(1000)}`), 44); assert.equal(at(longest, 1000), `${longest}/.cache`); assert.equal(at(`${longest}n`, 1000), null);
  // A folder a run left behind a week ago is removed on the way. Nothing else kept beside them is touched.
  const root = path.join(cache, 'elu'), old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); fs.mkdirSync(root, { mode: 0o700 });
  for (const name of ['zz', 'other-tool']) { fs.mkdirSync(path.join(root, name)); fs.utimesSync(path.join(root, name), old, old); }
  fs.writeFileSync(path.join(root, 'ab'), 'a file, not a folder'); fs.utimesSync(path.join(root, 'ab'), old, old);
  const made = path.basename(claude.privateTemp(cache)); assert.match(made, /^[0-9a-z]{2}$/);
  assert.deepEqual(fs.readdirSync(root).sort(), [...new Set([made, 'ab', 'other-tool'])].sort());
});

// A long home folder, or a ten-digit user number, leaves no room under the cache folder. The
// user's own runtime folder is short: the run's folder goes straight into it.
test('a Claude Code session whose cache folder is too long keeps Claude Code\'s own temporary files in the user\'s runtime folder', async t => {
  const f = setup(t, 'claude', { commands: ['echo worked'], note: true });
  const runtime = fs.mkdtempSync('/tmp/r-'); t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  // What else lives there, all of it a week old: other programs' folders, one a run of ours left, and a file with a name of ours.
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  for (const name of ['bus', 'elu-other', 'eluzz']) fs.mkdirSync(path.join(runtime, name)); fs.writeFileSync(path.join(runtime, 'eluab'), 'a file, not a folder');
  for (const name of ['bus', 'elu-other', 'eluzz', 'eluab']) fs.utimesSync(path.join(runtime, name), old, old);
  environment(t, { XDG_CACHE_HOME: path.join(f.parent, 'a cache folder whose path is too long to use'), XDG_RUNTIME_DIR: runtime });
  const task = await f.controller.ask('Say it worked.', null, { permissions: 'ask' }).finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  assert.deepEqual(printedBy(task.runs[0]), ['worked\n'], 'the command ended 0 and nothing was refused');
  const named = f.calls().findLast(call => call.args.includes('--permission-prompt-tool')).tmp;
  assert.match(path.basename(named), /^elu[0-9a-z]{2}$/); assert.equal(path.dirname(named), runtime);
  assert.deepEqual(fs.readdirSync(runtime).sort(), ['bus', 'elu-other', 'eluab'], 'the run\'s folder and the old one of ours are gone; nothing else was touched');
  assert.equal(fs.existsSync(path.join(f.parent, 'a cache folder whose path is too long to use')), false);
  // A runtime folder others can write is not private: none is named there.
  fs.chmodSync(runtime, 0o777);
  const open = await f.controller.ask('Say it worked.', null, { permissions: 'ask' }).finished;
  assert.equal(open.state, 'answered', JSON.stringify(open.error));
  assert.equal(f.calls().findLast(call => call.args.includes('--permission-prompt-tool')).tmp, null); assert.deepEqual(fs.readdirSync(runtime).sort(), ['bus', 'elu-other', 'eluab']);
  // Linux gives each user /run/user/<uid>: with a ten-digit user number the whole path is exactly the 44 bytes Claude Code takes.
  const uid = 1234567890, own = `/run/user/${uid}`, at = (dir, env = {}) => claude.runtimeBase({ env: { XDG_RUNTIME_DIR: dir, ...env }, uid });
  assert.equal(Buffer.byteLength(`${own}/elu00/${['claude', uid].join('-')}`), 44); assert.equal(at(own), own); assert.equal(at(`${own}0`), null);
  assert.equal(at('run/user'), null); assert.equal(claude.runtimeBase({ env: {}, uid }), null);
  assert.equal(at(own, { NODE_TEST_CONTEXT: 'child' }), null, 'a test never makes one in the real runtime folder');
});

// A script that pushes to the project's origin, on another machine, and keeps what git printed and its exit code.
function pushScript(f) {
  const script = path.join(f.parent, 'push.sh'), out = path.join(f.parent, 'push.out');
  git(f.root, ['remote', 'add', 'origin', 'ssh://git.invalid/sample.git']);
  fs.writeFileSync(script, `#!/bin/sh\ncd ${JSON.stringify(f.root)} && git push origin HEAD > ${JSON.stringify(out)} 2>&1\nprintf %s $? >> ${JSON.stringify(out)}\n`, { mode: 0o700 });
  return { script, said: () => { const text = fs.readFileSync(out, 'utf8'); fs.rmSync(out); return text; } };
}
const REFUSED_PUSH = 'git push is not allowed outside Full access.\n126';
// A script that pushes to a bare repository beside the project, with an option the git
// stand-in cannot read, then makes a tag and pushes it: Full access runs all of it.
function fullScript(f) {
  const w = fullWorld(f), script = path.join(f.parent, 'publish.sh'), out = path.join(f.parent, 'publish.out');
  fs.writeFileSync(script, `#!/bin/sh\ncd ${JSON.stringify(f.root)} && git push --receive-pack=git-receive-pack backup HEAD:refs/heads/from-script > ${JSON.stringify(out)} 2>&1 && git tag v2 && git push --tags backup >> ${JSON.stringify(out)} 2>&1\nprintf %s $? >> ${JSON.stringify(out)}\n`, { mode: 0o700 });
  return { ...w, script, code: () => fs.readFileSync(out, 'utf8').slice(-1) };
}

test('a Grok Build session refuses a push that a script makes over ACP in Ask for approval, and runs one headless in Full access', async t => {
  const f = setup(t, 'grok'), push = pushScript(f);
  fs.mkdirSync(path.join(f.parent, '.grok')); fs.writeFileSync(path.join(f.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
  proven('grok', f.bin, '1.0.77', { relay: true });
  const pending = f.controller.ask(`Run the command ${push.script} then reply done with the summary "ran it".`, null, { permissions: 'ask' }).finished;
  await answer('allow', { vendor: 'grok' });
  const task = await pending;
  assert.equal(task.state, 'answered', JSON.stringify(task.error)); assert.deepEqual(f.calls().at(-1).args.slice(-2), ['agent', 'stdio']);
  assert.equal(push.said(), REFUSED_PUSH, 'the owner allowed the script; the push inside it was still refused');
  // Full access has no never list: the same kind of script pushes and tags.
  const publish = fullScript(f);
  const full = await f.controller.ask(`Run the command ${publish.script} then reply done with the summary "ran it".`, null, { permissions: 'full' }).finished;
  assert.equal(full.state, 'answered', JSON.stringify(full.error)); const args = f.calls().at(-1).args; assert.ok(args.includes('--prompt-file'));
  assert.equal(publish.code(), '0'); assert.deepEqual(publish.refs(), ['refs/heads/from-script', 'refs/tags/v2']);
  assert.equal(args.some(arg => /^Bash\(/.test(arg)), false, 'no never-list rule on the command line');
  assert.doesNotMatch(fs.readFileSync(path.join(personalDirectory(), 'grok-home', '.grok', 'config.toml'), 'utf8'), /Bash\(/, 'nor in the config');
});

test('an Antigravity session refuses a push that a script makes over ACP in Ask for approval, and runs one headless in Full access', async t => {
  const f = setup(t, 'agy'), push = pushScript(f);
  proven('agy', f.bin, '1.5.4', { relay: true });
  const pending = f.controller.ask(`Run this command: ${push.script}. Reply with the summary "live".`, null, { permissions: 'ask' }).finished;
  await answer('allow', { vendor: 'agy' });
  const task = await pending;
  assert.equal(task.state, 'answered', JSON.stringify(task.error)); assert.deepEqual(f.calls().at(-1).args, ['acp']);
  assert.equal(push.said(), REFUSED_PUSH, 'the owner allowed the script; the push inside it was still refused');
  // Full access has no never list: the same kind of script pushes and tags.
  const publish = fullScript(f);
  const full = await f.controller.ask(`Run this command: ${publish.script}. Reply with the summary "headless".`, null, { permissions: 'full' }).finished;
  assert.equal(full.state, 'answered', JSON.stringify(full.error)); assert.ok(f.calls().at(-1).args.includes('-p'));
  assert.equal(publish.code(), '0'); assert.deepEqual(publish.refs(), ['refs/heads/from-script', 'refs/tags/v2']);
});

test('a Codex lead whose command was declined reports the denial and asks', async t => {
  const f = setup(t, 'codex', { mode: 'declined' });
  const task = await f.controller.ask('Trim spaces in coupon codes.', null, { permissions: 'ask' }).finished;
  assert.equal(task.state, 'needs_input'); assert.match(task.result.question, /declined/);
  assert.deepEqual(task.runs[0].denials, [{ tool: 'command_execution', summary: "Run: /bin/zsh -lc 'npm test'" }]);
});

test('a Grok lead runs headless from the prompt file under its private HOME, resumes its session, and reports what it could not do', async t => {
  const f = setup(t, 'grok');
  fs.mkdirSync(path.join(f.parent, '.grok')); fs.writeFileSync(path.join(f.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
  proven('grok', f.bin, '1.0.77', { relay: false });
  const task = await f.controller.ask('Reply done with the summary "from the file".', null, { permissions: 'ask' }).finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error)); assert.equal(task.result.summary, 'from the file');
  const [run] = task.runs, call = f.calls().find(call => call.args.includes('--prompt-file'));
  assert.equal(run.vendor, 'grok'); assert.equal(run.permissions, 'ask'); assert.equal(run.model, 'grok-4.6');
  assert.equal(call.args[call.args.indexOf('--prompt-file') + 1], path.join(f.dir(task.id), 'prompt.txt'));
  const prompt = fs.readFileSync(path.join(f.dir(task.id), 'prompt.txt'), 'utf8');
  assert.ok(prompt.includes('Reply done with the summary') && prompt.includes('Output schema'), 'the prompt and the schema went to the file');
  assert.equal(f.inputs().at(-1).input, prompt, 'the vendor read the file, not stdin');
  assert.ok(fs.existsSync(path.join(personalDirectory(), 'grok-home', '.grok', 'sessions', `${run.session}.json`)), 'the session lives under the private GROK_HOME');
  const second = await f.controller.ask(`Run the command ${f.marker} then reply done with the summary "again".`, task.id).finished;
  assert.equal(second.state, 'needs_input'); assert.match(second.result.summary, /^Blocked: run /); assert.equal(fs.existsSync(f.ran), false);
  assert.deepEqual(f.calls().at(-1).args.slice(-2), ['-r', run.session]); assert.equal(second.runs[1].denials, undefined, 'headless output carries no denial record');
  // Opening the session interactively runs grok under the private home, where the session lives.
  const open = cli(f.root, ['open', task.id], { ...f.fake.env, HOME: f.parent });
  assert.equal(open.status, 0, open.stdout); assert.match(open.json.command, /^cd '[^']+' && HOME='[^']+grok-home' GROK_HOME='[^']+grok-home\/\.grok' .* grok '--no-auto-update' '--cwd' '[^']+' '-r' '[0-9a-f-]{36}'$/);
});

test('a Grok lead asks over ACP once the relay is proven here: allow runs the command, deny is a recorded denial', async t => {
  const f = setup(t, 'grok');
  fs.mkdirSync(path.join(f.parent, '.grok')); fs.writeFileSync(path.join(f.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
  proven('grok', f.bin, '1.0.77', { relay: true });
  const pending = f.controller.ask(`Run the command ${f.marker} then reply done with the summary "ran it".`, null, { permissions: 'ask' }).finished;
  const asked = await answer('allow', { vendor: 'grok' });
  assert.equal(asked.summary, `Run ${f.marker}`); assert.equal(asked.role, 'lead');
  const task = await pending;
  assert.equal(task.state, 'answered', JSON.stringify(task.error)); assert.equal(task.result.summary, 'ran it'); assert.equal(fs.readFileSync(f.ran, 'utf8'), 'ran');
  const [run] = task.runs;
  assert.equal(run.effectivePermissions, 'ask'); assert.equal(run.denials, undefined); assert.ok(run.code === null || run.code === 0, 'the client closes the agent');
  assert.deepEqual(f.calls().at(-1).args.slice(-2), ['agent', 'stdio']);
  assert.equal(task.approvals.length, 1); assert.equal(task.approvals[0].decision, 'allow'); assert.equal(task.approvals[0].summary, `Run ${f.marker}`); assert.equal(task.approvals[0].role, 'lead');
  fs.rmSync(f.ran);
  const next = f.controller.ask(`Run the command ${f.marker} then reply done with the summary "again".`, task.id).finished;
  await answer('deny', { vendor: 'grok' });
  const second = await next;
  assert.equal(fs.existsSync(f.ran), false); assert.equal(second.runs[1].session, run.session, 'the ACP session resumed');
  assert.deepEqual(second.runs[1].denials, [{ tool: 'execute', summary: `Run ${f.marker}` }]);
  assert.equal(second.approvals.length, 2); assert.equal(second.approvals[1].decision, 'deny');
  assert.equal(pendingApprovals().length, 0, 'nothing is left to answer');
});

// Approvals you give once, over ACP: the relay answers a kept rule without asking, and the
// never list is asked whatever is kept.
test('a Grok lead over ACP: a kept rule allows its command without asking, and the decision names the rule', async t => {
  const f = setup(t, 'grok');
  fs.mkdirSync(path.join(f.parent, '.grok')); fs.writeFileSync(path.join(f.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
  proven('grok', f.bin, '1.0.77', { relay: true });
  fs.writeFileSync(path.join(f.fake.dir, 'elu-marker'), `#!/bin/sh\nprintf ran > ${JSON.stringify(f.ran)}\n`, { mode: 0o755 });
  // Grok Build over ACP runs no sandbox: a rule kept inside one does not answer, and the command waits for the owner.
  saveRule({ kind: 'command', words: ['elu-marker'], exact: false }, { scope: 'project', project: f.controller.repo.project ?? f.controller.repo.root });
  const waits = f.controller.ask('Run the command elu-marker then reply done with the summary "asked".', null, { permissions: 'ask' }).finished;
  const first = await answer('deny', { vendor: 'grok' });
  assert.equal(first.summary, 'Run elu-marker'); assert.equal(first.sandboxed, undefined);
  await waits; assert.equal(fs.existsSync(f.ran), false, 'nothing ran');
  saveRule({ kind: 'command', words: ['elu-marker'], exact: false, outside: true }, { scope: 'project', project: f.controller.repo.project ?? f.controller.repo.root });
  const task = await f.controller.ask('Run the command elu-marker then reply done with the summary "ran it".', null, { permissions: 'ask' }).finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error)); assert.equal(fs.readFileSync(f.ran, 'utf8'), 'ran', 'the command ran');
  assert.deepEqual(pendingApprovals(), [], 'nothing waited for the owner');
  assert.deepEqual(task.approvals.map(row => [row.summary, row.decision, row.by, row.rule]), [['Run elu-marker', 'allow', 'rule', 'elu-marker']]);
  // Elsewhere the rule does not apply: the same command asks.
  const other = project(t), controller = new ProjectController(projectFolder(other.root)); Object.assign(controller.draftConfig.roles.lead, { vendor: 'grok', maxCostUsd: null });
  fs.rmSync(f.ran);
  const pending = controller.ask('Run the command elu-marker then reply done with the summary "asked".', null, { permissions: 'ask' }).finished;
  const asked = await answer('deny', { vendor: 'grok' });
  assert.equal(asked.rules, 'saved'); assert.equal(asked.summary, 'Run elu-marker');
  await pending; assert.equal(fs.existsSync(f.ran), false);
});

test('an Antigravity lead runs headless under the workspace HOME and asks over ACP once the relay is proven here', async t => {
  const f = setup(t, 'agy');
  proven('agy', f.bin, '1.5.4', { relay: false });
  const task = await f.controller.ask(`Run this command: ${f.marker}. Reply with the summary "headless".`, null, { permissions: 'ask' }).finished;
  // Headless, a command that would ask is soft-denied: the vendor reports blocked, and nothing ran.
  assert.equal(task.state, 'blocked', JSON.stringify(task.error)); assert.equal(task.error, null); assert.equal(task.result.outcome, 'blocked'); assert.equal(task.result.summary, 'headless'); assert.equal(fs.existsSync(f.ran), false);
  const [run] = task.runs, call = f.calls().find(call => call.args.includes('-p') && !call.args.includes('/usage'));
  assert.equal(run.vendor, 'agy'); assert.equal(run.permissions, 'ask'); assert.equal(run.model, 'gemini-3-pro');
  assert.equal(call.home, agy.privateHome({ cwd: f.controller.repo.root })); assert.equal(call.autoUpdate, 'true');
  assert.deepEqual(run.denials, [{ tool: 'run_command', summary: 'agy: soft-denied run_command (permissions.ask: command; headless)' }], 'the stderr notice is read');
  assert.equal(f.inputs().at(-1).input.includes('Run this command'), true, 'the prompt went on stdin');
  proven('agy', f.bin, '1.5.4', { relay: true });
  const next = f.controller.ask(`Run this command: ${f.marker}. Reply with the summary "live".`, task.id).finished;
  const asked = await answer('allow', { vendor: 'agy' });
  assert.equal(asked.summary, `Run ${f.marker}`);
  const second = await next;
  assert.equal(second.state, 'answered', JSON.stringify(second.error)); assert.equal(second.result.outcome, 'done'); assert.equal(fs.readFileSync(f.ran, 'utf8'), 'ran', 'the allowed command ran');
  assert.equal(second.runs[1].effectivePermissions, 'ask'); assert.equal(second.runs[1].session, run.session, 'the conversation resumed over ACP');
  assert.equal(second.approvals.length, 1); assert.equal(second.approvals[0].decision, 'allow');
  assert.deepEqual(f.calls().at(-1).args, ['acp']); assert.equal(pendingApprovals().length, 0);
  assert.match(cli(f.root, ['open', task.id], { ...f.fake.env, HOME: f.parent }).json.command, /^cd '[^']+' && HOME='[^']+agy-home\/[0-9a-f]{16}' AGY_CLI_DISABLE_AUTO_UPDATE='true'(?: DBUS_SESSION_BUS_ADDRESS='[^']+')? agy '--conversation' '[0-9a-f-]{36}'$/);
});

// The first reply names its session on every vendor: the name is one more field of the
// reply every vendor already gives, so no vendor is called a second time for it.
const NAMING = /Also set name: a short name for this session, taken from what was asked\. Two to six plain words, at most 40 characters/;
const REQUEST = 'Where is coupon normalization, and which file would change if it had to trim the spaces around a code before it compares them?';
for (const [vendor, label, prepare] of [['claude', 'Claude Code', null], ['codex', 'Codex', null],
  ['agy', 'Antigravity', f => proven('agy', f.bin, '1.5.4', { relay: false })],
  ['grok', 'Grok Build', f => { fs.mkdirSync(path.join(f.parent, '.grok')); fs.writeFileSync(path.join(f.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 }); proven('grok', f.bin, '1.0.77', { relay: false }); }]]) {
  test(`a ${label} lead names its session in its first reply, and no later reply renames it`, async t => {
    const f = setup(t, vendor, { name: 'Coupon normalization question' }); prepare?.(f);
    const repo = f.controller.repo, runs = () => f.inputs().filter(row => row.input.includes('Return only the JSON object')).length;
    const task = await f.controller.ask(REQUEST, null, { permissions: 'ask' }).finished;
    assert.equal(task.state, 'answered', JSON.stringify(task.error)); assert.equal(task.runs.length, 1); assert.equal(runs(), 1, 'one call of the vendor');
    assert.match(f.inputs()[0].input, NAMING);
    const saved = readTask(repo, task.id);
    assert.equal(saved.title, 'Coupon normalization question'); assert.equal(saved.titleBy, 'model'); assert.equal(taskTitle(saved), 'Coupon normalization question');
    assert.equal(task.result.name, undefined, 'the name is not part of the answer');
    f.say('Another name entirely');
    const second = await f.controller.ask('And the tests?', task.id).finished;
    assert.equal(second.state, 'answered', JSON.stringify(second.error)); assert.equal(runs(), 2); assert.doesNotMatch(f.inputs()[1].input, NAMING, 'a named session is not asked for a name');
    assert.equal(readTask(repo, task.id).title, 'Coupon normalization question');
  });
}

test('a reply whose name is not a name leaves the first words of the request; the next reply can still name the session', async t => {
  const f = setup(t, 'claude', { name: '/srv/app/src/coupon.mjs' }), repo = f.controller.repo;
  const task = await f.controller.ask(REQUEST, null, { permissions: 'ask' }).finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error)); assert.equal(readTask(repo, task.id).title, undefined);
  assert.equal(taskTitle(readTask(repo, task.id)), 'Where is coupon normalization, and which file would change…');
  for (const bad of ['<b>Coupons</b> everywhere', 'Coupons', 'A name that goes on for far longer than forty characters']) {
    f.say(bad); await f.controller.ask('And the tests?', task.id).finished; assert.equal(readTask(repo, task.id).title, undefined, bad); assert.match(f.inputs().at(-1).input, NAMING);
  }
  f.say('Coupon normalization question'); await f.controller.ask('And the build?', task.id).finished;
  assert.deepEqual([readTask(repo, task.id).title, readTask(repo, task.id).titleBy], ['Coupon normalization question', 'model']);
});

test('a name the owner set before the first reply is never replaced by the reply\'s name', async t => {
  const f = setup(t, 'claude', { mode: 'slow-answer', name: 'Coupon normalization question' }), repo = f.controller.repo;
  const run = f.controller.ask(REQUEST, null, { permissions: 'ask' });
  const started = () => fs.existsSync(path.join(f.parent, 'inputs.jsonl')) && f.inputs().length > 0;
  for (let i = 0; i < 400 && !started(); i++) await sleep(10);
  assert.equal(started(), true, 'the model is working'); assert.equal(setTitle(repo, run.id, 'My coupons').title, 'My coupons');
  const task = await run.finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error)); assert.deepEqual([readTask(repo, task.id).title, readTask(repo, task.id).titleBy], ['My coupons', 'owner']);
  assert.deepEqual([setTitle(repo, task.id, '').title, readTask(repo, task.id).titleBy], ['Coupon normalization question', 'model'], 'the reply\'s name was kept under it');
});

// What Codex 0.166.0-alpha.5.1 printed for a turn in which a step was refused, as the service
// sent it (the home folder shortened). Its reply says needs_input and leaves question empty.
const BLOCKED = fileURLToPath(new URL('./fixtures/codex-blocked.jsonl', import.meta.url));

// A run's log may be larger than any text this computer can hold (the JavaScript engine stops
// near 512 MB). The runner never reads it as one text: it goes through it a line at a time.
// Here every read of a run's log as one text fails the way it does for such a log.
function logsTooLargeForOneText(t) {
  const real = fs.readFileSync, refused = [];
  fs.readFileSync = function (file, ...rest) {
    if (typeof file === 'string' && file.endsWith('.log')) { refused.push(file); throw Object.assign(new Error('Cannot create a string longer than 0x1fffffe8 characters'), { code: 'ERR_STRING_TOO_LONG' }); }
    return real.call(this, file, ...rest);
  };
  t.after(() => { fs.readFileSync = real; });
  return refused;
}
test('a run whose log is too large for one text is read a line at a time: its reply, what it cost and why it failed', async t => {
  const refused = logsTooLargeForOneText(t), asOneText = {};
  for (const vendor of ['claude', 'codex', 'grok', 'agy']) {
    const f = setup(t, vendor), before = refused.length;
    if (vendor === 'grok') { fs.mkdirSync(path.join(f.parent, '.grok')); fs.writeFileSync(path.join(f.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 }); proven('grok', f.bin, '1.0.77', { relay: false }); }
    if (vendor === 'agy') proven('agy', f.bin, '1.5.4', { relay: false });
    const task = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'ask' }).finished;
    assert.equal(task.state, 'answered', `${vendor}: ${JSON.stringify(task.error)}`);
    assert.equal(task.runs.length, 1, vendor); assert.equal(task.runs[0].code, 0, vendor);
    assert.ok(task.result.summary, vendor);
    if (vendor === 'claude') assert.equal(task.runs[0].costUsd, 0);
    asOneText[vendor] = refused.length > before;
  }
  // Claude Code and Codex print a stream of JSON lines, which is never read as one text. The
  // other two print one JSON value: read as one text first, then a line at a time.
  assert.deepEqual(asOneText, { claude: false, codex: false, grok: true, agy: true });
  // Why a run failed is read from the same lines, gone through more than once.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'elu-code-lines-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = rows => { const file = path.join(dir, `${Math.random().toString(16).slice(2)}.out`); fs.writeFileSync(file, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n'); return logLines(file); };
  const noCredits = log([{ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5', mcp_servers: [] }, { type: 'result', subtype: 'success', is_error: true, api_error: 'model_requires_usage_credits', api_error_status: 400, result: 'This model requires usage credits.' }]);
  assert.equal(claude.classify(noCredits), 'model-unavailable');
  assert.deepEqual(claude.vendorError(noCredits, { name: () => 'Opus 5.5' }), { status: 400, code: 'model_requires_usage_credits', model: 'claude-opus-5-5', cause: 'model-unavailable', text: 'Claude says this account is out of usage credits for Opus 5.5.' });
  assert.throws(() => claude.parse(noCredits), { message: 'Claude could not finish.' });
  assert.equal(ADAPTERS.codex.classify(log([{ type: 'turn.started' }, { type: 'turn.failed', error: { message: "You've hit your usage limit." } }])), 'quota');
  assert.equal(ADAPTERS.grok.classify(log([{ type: 'error', message: 'Too many requests (429)' }])), 'rate-limit');
  assert.equal(agy.classify(log(['Working…', 'Error: RESOURCE_EXHAUSTED', 'the input token count 2000000 exceeds the maximum number of tokens allowed'])), 'too-long');
  // One JSON value printed over several lines, after other lines, is still found.
  assert.deepEqual(agy.extractJson(log(['Starting…', '{"note":"not the result"}', '{', '  "structured_output": { "outcome": "done" }', '}'])), { structured_output: { outcome: 'done' } });
});
test('the lines of a file are read in parts, in order: a line across two parts, an empty line, and a last line with no newline', t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'elu-code-lines-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'run.log'), lines = ['{"a":1}', '', 'x'.repeat(100), 'caf\u00e9 \u{1F600} '.repeat(20), 'last'];
  fs.writeFileSync(file, lines.join('\n'));
  for (const part of [1, 3, 7, 64, 1024 * 1024]) assert.deepEqual([...fileLines(file, { part })], lines, `in parts of ${part}`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  assert.deepEqual([...fileLines(file, { part: 5 })], lines, 'a newline at the end starts no line');
  assert.deepEqual([...fileLines(path.join(dir, 'missing.log'))], []);
});

test('a Codex reply that says needs_input with no question is read, and the model is started once', async t => {
  const f = setup(t, 'codex', { replay: BLOCKED });
  const task = await f.controller.ask('Run npm test.', null, { permissions: 'ask' }).finished;
  assert.equal(f.calls().filter(call => call.args[0] === 'exec').length, 1, 'what the turn ran, it ran once');
  assert.equal(task.error, null); assert.equal(task.state, 'needs_input'); assert.equal(task.runs.length, 1); assert.equal(task.runs[0].again, undefined);
  assert.deepEqual(task.runs[0].denials.map(denial => denial.never), ['git push'], 'the refused step is kept for the chat');
  assert.equal(task.result.question, null); assert.match(task.result.summary, /^`npm test` exited 0, but its script attempted blocked Git pushes\./, 'the summary is what it asks');
});

test('Claude Code is asked for a reply that cannot be read in the session it came from, and starts nothing over', async t => {
  const f = setup(t, 'claude', { badReply: 'once' }), SESSION = '12345678-1234-4234-8234-123456789abc';
  const task = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'ask' }).finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  const turns = f.inputs().filter(row => row.args.includes('-p'));
  assert.equal(turns.length, 2);
  assert.equal(turns[0].args.includes('--resume'), false); assert.match(turns[0].input, /Task goal/);
  assert.equal(turns[1].args[turns[1].args.indexOf('--resume') + 1], SESSION, 'the second launch picks up the first one\'s session');
  assert.equal(turns[1].args.includes('--session-id'), false);
  assert.match(turns[1].input, /^Your last reply was not accepted\. Do not do the work again and run nothing again: send only the reply/);
  assert.match(turns[1].input, /Invalid output to correct/); assert.doesNotMatch(turns[1].input, /Task goal|Where is coupon normalization/, 'the message is not sent again');
  assert.deepEqual(task.runs.map(run => [run.again, run.resumed]), [[undefined, undefined], ['The model returned an invalid conversation intent.', true]]);
});

test('a Claude Code session that cannot be picked up starts the message again from the top, and the run says so', async t => {
  const f = setup(t, 'claude', { badReply: 'lost' });
  const task = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'ask' }).finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  const turns = f.inputs().filter(row => row.args.includes('-p'));
  assert.deepEqual(turns.map(row => row.args.includes('--resume')), [false, true, false]);
  assert.match(turns[2].input, /Task goal/); assert.match(turns[2].input, /Invalid output to correct/);
  assert.deepEqual(task.runs.map(run => [run.code, Boolean(run.again), run.resumed]), [[0, false, undefined], [1, true, true], [0, true, undefined]]);
});

test('a reply that cannot be read starts the model again, and the second run says why', async t => {
  const f = setup(t, 'codex'), broken = path.join(f.parent, 'broken.jsonl');
  fs.writeFileSync(broken, fs.readFileSync(BLOCKED, 'utf8').replace('\\"outcome\\":\\"needs_input\\"', '\\"outcome\\":\\"later\\"'));
  fakeClis(f.parent, { mode: 'answer', replay: broken });
  const task = await f.controller.ask('Run npm test.', null, { permissions: 'ask' }).finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  assert.equal(f.calls().filter(call => call.args[0] === 'exec').length, 2);
  assert.deepEqual(task.runs.map(run => run.again), [undefined, 'The run returned an invalid outcome or summary.']);
  assert.match(f.inputs().at(-1).input, /Invalid output to correct/);
  // Codex is not asked in the same session: the message goes again whole, to a new one.
  assert.equal(task.runs[1].resumed, undefined); assert.equal(f.calls().filter(call => call.args[0] === 'exec').at(-1).args.includes('resume'), false); assert.match(f.inputs().at(-1).input, /Task goal/);
});
