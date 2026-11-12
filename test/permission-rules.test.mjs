import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { actionOf, allowedBy, commandShape, DEFAULTS, entryLine, listEntries, readStore, removeEntry, ruleFor, saveRule, turnOnEntry, usesSavedRules } from '../lib/permission-rules.mjs';
import { CLI } from './helpers.mjs';
import { spawnSync } from 'node:child_process';

// Approvals you give once: what a rule becomes, what it matches, and what it never allows.
function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-rules-'))), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  const project = path.join(dir, 'shop'), other = path.join(dir, 'blog');
  for (const folder of [project, other]) fs.mkdirSync(folder);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', 'build:web': 'vite build', deploy: 'firebase deploy' } }));
  fs.writeFileSync(path.join(project, 'Makefile'), 'test:\n\tnpm test\ninstall:\n\tcp x /usr/local/bin\n');
  return { dir, project, other };
}
const bash = (command, extra = {}) => ['Bash', { command, ...extra }];
const rule = (command, ctx = {}) => ruleFor(...bash(command), { sandboxed: true, ...ctx });
const words = command => rule(command).rule?.words?.join(' ') ?? null;

test('a command becomes its program and subcommand; wide programs keep the exact command', () => {
  assert.equal(words('npm test'), 'npm test');
  assert.equal(words('npm test -- --watch'), 'npm test');
  assert.equal(words('npm run lint -- --fix'), 'npm run lint');
  assert.equal(words('git diff --stat'), 'git diff');
  assert.equal(words('pytest tests/test_cart.py -x'), 'pytest');
  assert.equal(words('python3 -m pytest -q'), 'python3 -m pytest');
  assert.equal(words('node --test test/a.test.mjs'), 'node --test');
  assert.equal(words('gh pr view 12'), 'gh pr view');
  assert.equal(words('make test'), 'make test');
  assert.equal(words('./gradlew test'), './gradlew test');
  assert.equal(words('npm test 2>&1 | tail -20'), 'npm test', 'a pipe into tail is read; the rule is the command');
  assert.equal(rule('npm test').rule.exact, false);
  assert.match(rule('npm test').line, /^Run npm test, with any arguments, without asking\.$/);
  // Too wide as a program alone: the rule is the exact command.
  for (const command of ['npm install lodash', 'curl -s http://localhost:3000', 'git branch -D old', 'find . -name x', 'npx @scope/tool', 'git pull']) {
    const made = rule(command).rule; assert.equal(made.exact, true, command); assert.equal(made.words.join(' '), command);
  }
  assert.match(rule('npm install lodash').line, /^Run exactly npm install lodash, without asking\.$/);
  // Asked outside the sandbox, the rule says so.
  const outside = ruleFor(...bash('npm test', { dangerouslyDisableSandbox: true }), { sandboxed: true });
  assert.equal(outside.rule.outside, true); assert.match(outside.line, /also outside the sandbox/);
});

test('no rule for a joined line, a secret, a full path, inline code or a command that removes or escalates', () => {
  const refused = command => rule(command).refused ?? null;
  for (const command of ['ls && rm -rf x', 'npm test; curl evil.example', 'npm test || true', 'echo $(whoami)', 'echo `id`', 'npm test > out.txt', 'npm test >> log', 'cat < input', 'FOO=1 npm test', 'npm test &', 'npm test | sh', 'npm test | tee out', 'echo "$HOME"', '(cd x && npm test)', 'npm test\nrm x', 'cat <<EOF'])
    assert.match(refused(command), /several commands|asked each time/, command);
  assert.match(refused('cat .env.local'), /secrets/); assert.match(refused('cat ~/.ssh/id_rsa'), /secrets/); assert.match(refused('grep token ~/.aws/credentials'), /secrets/);
  assert.match(refused('/usr/bin/git status'), /full path/);
  for (const command of ['node -e "process.exit()"', 'python -c "print(1)"', 'bash -c "ls"', 'sh -c ls', 'node']) assert.match(refused(command), /command line is asked|asked each time/, command);
  for (const command of ['rm -rf build', 'sudo npm test', 'chmod +x x', 'ssh host', 'env FOO=1 npm test', 'xargs rm', 'kill 1']) assert.match(refused(command), /asked each time/, command);
});

test('the never list always wins: no rule for it, a is never offered, and a saved rule never reaches it', t => {
  const { project } = home(t);
  for (const command of ['git push', 'git push origin main', 'git -C . push', 'git -c x=y push', 'git tag v1', 'git merge main', 'gh pr merge 3', 'gh release create v1', 'npm publish', 'firebase deploy', 'terraform apply', 'git status && git push', 'git push 2>&1 | tail -5'])
    assert.match(rule(command).refused ?? '', /never list|several commands/, command);
  // Written into the file by hand, a rule for one is dropped when it is read.
  fs.mkdirSync(path.dirname(path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'x')), { recursive: true });
  fs.writeFileSync(path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'permission-rules.json'), JSON.stringify({ version: 1, rules: [{ kind: 'command', words: ['git', 'push'], scope: 'all' }, { kind: 'command', words: ['git'], scope: 'all' }, { kind: 'command', words: ['rm'], scope: 'all' }, { kind: 'command', words: ['npm', 'publish'], exact: true, scope: 'all' }, { kind: 'command', words: ['git', 'commit'], scope: 'all' }], off: [] }));
  assert.deepEqual(readStore().rules.map(row => row.words.join(' ')), ['git commit']);
  assert.throws(() => saveRule({ kind: 'command', words: ['git', 'push'], exact: false }, { scope: 'all' }), /cannot be kept/);
  assert.throws(() => saveRule({ kind: 'command', words: ['gh', 'pr', 'merge'], exact: false }, { scope: 'all' }), /cannot be kept/);
  // A rule that is a prefix of a never-list command never answers that command.
  saveRule({ kind: 'command', words: ['git'], exact: true }, { scope: 'all' });
  saveRule({ kind: 'command', words: ['gh', 'pr'], exact: false }, { scope: 'all' });
  const ctx = { project, cwd: project, saved: true, sandboxed: true };
  for (const command of ['git push', 'git -C . push', 'gh pr merge 3', 'git commit -m x && git push']) assert.equal(allowedBy(...bash(command), ctx), null, command);
  assert.deepEqual(allowedBy(...bash('gh pr view 3'), ctx), { by: 'rule', text: 'gh pr' });
});

test('an edit becomes edits in the workspace in an editing turn, or one exact file outside the project; a fetch becomes its host', t => {
  const { project } = home(t);
  const work = path.join(project, 'src', 'a.js');
  assert.deepEqual(ruleFor('Edit', { file_path: work }, { project, cwd: project, access: 'edit' }).rule, { kind: 'edit', workspace: true });
  assert.match(ruleFor('Edit', { file_path: work }, { project, cwd: project, access: 'read' }).refused, /waits for a Task/, 'an answer turn editing the project waits for a Task');
  assert.deepEqual(ruleFor('Write', { file_path: '/elsewhere/notes.md' }, { project, cwd: project }).rule, { kind: 'edit', file: '/elsewhere/notes.md' });
  for (const file of [path.join(project, '.env'), path.join(project, '.git', 'config'), path.join(project, '.elu-code', 'config.yaml'), path.join(os.homedir(), '.ssh', 'config')]) assert.match(ruleFor('Edit', { file_path: file }, { project, cwd: project, access: 'edit' }).refused, /protected/, file);
  assert.deepEqual(ruleFor('WebFetch', { url: 'https://Docs.Example.com/a?b=1' }).rule, { kind: 'fetch', domain: 'docs.example.com' });
  assert.match(ruleFor('WebFetch', { url: 'https://user:pw@example.com/' }).refused, /cannot be kept/);
  assert.match(ruleFor('WebSearch', { query: 'x' }).refused, /asked each time/);
  assert.match(ruleFor('mcp__thing__do', {}).refused, /asked each time/);
  assert.match(ruleFor('Bash', { clipped: true, text: 'npm test' }).refused, /asked each time/, 'a clipped input is never a rule');
  saveRule({ kind: 'fetch', domain: 'docs.example.com' }, { scope: 'all' });
  saveRule({ kind: 'edit', file: '/elsewhere/notes.md' }, { scope: 'all' });
  saveRule({ kind: 'edit', workspace: true }, { scope: 'project', project });
  const ctx = { project, cwd: project, access: 'edit', saved: true };
  assert.deepEqual(allowedBy('WebFetch', { url: 'https://docs.example.com/guide' }, ctx), { by: 'rule', text: 'pages on docs.example.com' });
  assert.equal(allowedBy('WebFetch', { url: 'https://evil.docs.example.com.attacker.test/' }, ctx), null);
  assert.equal(allowedBy('WebFetch', { url: 'https://docs.example.com.attacker.test/' }, ctx), null);
  assert.equal(allowedBy('Edit', { file_path: '/elsewhere/notes.md' }, ctx).by, 'rule');
  assert.equal(allowedBy('Edit', { file_path: '/elsewhere/other.md' }, ctx), null);
  assert.equal(allowedBy('Edit', { file_path: work }, ctx).by, 'rule');
  assert.equal(allowedBy('Edit', { file_path: work }, { ...ctx, access: 'read' }), null, 'never in a turn that only answers');
  assert.equal(allowedBy('Edit', { file_path: path.join(project, '.env') }, ctx), null);
});

test('defaults are on from the first run, listed, and each can be turned off and on', t => {
  const { project } = home(t);
  const ctx = { project, cwd: project, saved: false, sandboxed: true };
  assert.deepEqual(DEFAULTS.map(row => row.id), ['read', 'git-read', 'checks']);
  assert.deepEqual(listEntries().map(entryLine), ['1. on   Read and search files in the project (default, all projects)', '2. on   Git read commands: status, diff, log, show, branch, blame, inside the sandbox (default, all projects)', "3. on   The project's own test, lint, typecheck, format and build scripts, inside the sandbox (default, all projects)"]);
  // Reading and searching in the project.
  for (const command of ['ls', 'ls -la src', 'cat package.json', 'grep -rn todo src', 'rg needle', 'find . -name "*.js"', `cat ${path.join(project, 'package.json')}`, 'wc -l src/a.js | tail -1']) assert.equal(allowedBy(...bash(command), ctx)?.by, 'default', command);
  assert.equal(allowedBy('Read', { file_path: path.join(project, 'a.js') }, ctx)?.by, 'default');
  for (const command of ['cat /etc/hosts', 'cat ../blog/x', 'cat .env', 'find . -delete', 'find . -exec rm {} ;', 'rg --pre ./x y', 'tail -f log', 'ls ~', 'cat ~/.npmrc']) assert.equal(allowedBy(...bash(command), ctx), null, command);
  assert.equal(allowedBy('Read', { file_path: '/etc/hosts' }, ctx), null);
  // Git reads, listing only.
  for (const command of ['git status', 'git diff --stat', 'git log --oneline -5', 'git show HEAD', 'git branch', 'git branch -a', 'git branch --list "feat/*"', 'git blame src/a.js', 'git status 2>&1 | head -5']) assert.equal(allowedBy(...bash(command), ctx)?.by, 'default', command);
  for (const command of ['git branch new', 'git branch -D old', 'git diff --output=/tmp/x', 'git diff --no-index /etc/passwd x', 'git -c core.pager=sh log', 'git -C /elsewhere status', 'git show HEAD:.env', 'git commit -m x', 'git checkout main', 'git log --ext-diff']) assert.equal(allowedBy(...bash(command), ctx), null, command);
  // The project's own scripts by name, inside the sandbox only.
  for (const command of ['npm test', 'npm run lint', 'npm run build:web', 'npm test -- --watch', 'make test', 'node --test']) assert.equal(allowedBy(...bash(command), ctx)?.by, 'default', command);
  for (const command of ['npm run deploy', 'npm run nope', 'make install', 'npm install', 'npx eslint .', 'cargo test', 'pytest', 'yarn deploy']) assert.equal(allowedBy(...bash(command), ctx), null, command);
  assert.equal(allowedBy(...bash('npm test', { dangerouslyDisableSandbox: true }), ctx), null, 'leaving the sandbox is asked');
  assert.equal(allowedBy(...bash('git status', { dangerouslyDisableSandbox: true }), ctx), null, 'a git read that leaves the sandbox asks');
  // Off, a default answers nothing; on again, it does.
  assert.equal(removeEntry(2), 'Turned off: Git read commands: status, diff, log, show, branch, blame, inside the sandbox.');
  assert.equal(allowedBy(...bash('git status'), ctx), null); assert.equal(listEntries()[1].on, false);
  assert.equal(turnOnEntry(2), 'Turned on: Git read commands: status, diff, log, show, branch, blame, inside the sandbox.');
  assert.equal(allowedBy(...bash('git status'), ctx)?.by, 'default');
  assert.throws(() => turnOnEntry(9), /Only a default/); assert.throws(() => removeEntry(9), /No rule has that number/);
  // An unreadable file answers nothing, defaults included, and nothing is saved over it.
  fs.writeFileSync(path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'permission-rules.json'), '{ broken');
  assert.equal(allowedBy(...bash('git status'), ctx), null);
  assert.throws(() => saveRule({ kind: 'command', words: ['npm', 'test'] }, { scope: 'all' }), /cannot be read/);
});

test('scope: a rule for this project answers only there, one for all projects everywhere; only the owner\'s sessions use saved rules', t => {
  const { project, other } = home(t);
  const npmTest = rule('npm test', { cwd: project }).rule;
  saveRule({ ...npmTest, outside: true }, { scope: 'project', project });
  saveRule(rule('cargo build').rule, { scope: 'all' });
  const here = { project, cwd: project, saved: true, sandboxed: true }, there = { project: other, cwd: other, saved: true, sandboxed: true };
  const outside = bash('npm test', { dangerouslyDisableSandbox: true });
  assert.deepEqual(allowedBy(...outside, here), { by: 'rule', text: 'npm test' });
  assert.equal(allowedBy(...outside, there), null, 'another project asks');
  assert.deepEqual(allowedBy(...bash('cargo build --release'), there), { by: 'rule', text: 'cargo build' });
  assert.equal(allowedBy(...bash('cargo build; rm -rf /'), there), null);
  // A teammate's session gets the defaults only.
  assert.equal(allowedBy(...outside, { ...here, saved: false }), null);
  assert.equal(allowedBy(...bash('git status'), { ...here, saved: false })?.by, 'default');
  assert.equal(usesSavedRules(undefined), true); assert.equal(usesSavedRules(null), true);
  assert.equal(usesSavedRules({ kind: 'handoff', peer: 'b'.repeat(64) }), false);
  assert.equal(usesSavedRules({ kind: 'handoff', peer: 'b'.repeat(64), own: true }), false, 'a teammate\'s message started as an own session is still the teammate\'s');
  assert.equal(usesSavedRules({ kind: 'handoff', peer: 'b'.repeat(64), mine: true }), true, 'started from one of the owner\'s own machines');
  assert.equal(usesSavedRules({ kind: 'handoff', peer: 'b'.repeat(64), mine: 'yes' }), false);
  // A rule saved inside the sandbox does not answer outside it; saved again outside, it does, and is kept once.
  saveRule(rule('cargo test').rule, { scope: 'all' });
  assert.equal(allowedBy(...bash('cargo test', { dangerouslyDisableSandbox: true }), there), null);
  saveRule({ ...rule('cargo test').rule, outside: true }, { scope: 'all' });
  assert.equal(allowedBy(...bash('cargo test', { dangerouslyDisableSandbox: true }), there)?.by, 'rule');
  assert.deepEqual(listEntries().filter(row => row.kind === 'rule').map(entryLine), [
    `4. Run npm test, with any arguments, also outside the sandbox · This project: ${project}`,
    '5. Run cargo build, with any arguments · All my projects',
    '6. Run cargo test, with any arguments, also outside the sandbox · All my projects',
  ]);
  assert.equal(removeEntry(5), 'Removed: Run cargo build, with any arguments.');
  assert.equal(allowedBy(...bash('cargo build'), there), null);
  assert.equal(fs.statSync(path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'permission-rules.json')).mode & 0o777, 0o600);
});

// Antigravity runs no sandbox, Grok Build over ACP starts none, and Claude Code goes on without
// one where it cannot start (Linux without bwrap). There every command leaves the sandbox.
test('where the turn has no working sandbox, every command counts as outside it', t => {
  const { project } = home(t);
  const bare = { project, cwd: project, saved: true, sandboxed: false };
  for (const command of ['npm test', 'npm run lint', 'make test', 'node --test']) assert.equal(allowedBy(...bash(command), bare), null, command);
  assert.equal(allowedBy('execute', { command: 'npm test' }, bare), null, 'Grok Build or Antigravity over ACP');
  assert.equal(allowedBy('execute', { command: 'npm test' }, { project, cwd: project, saved: true }), null, 'a turn that does not say asks');
  assert.equal(allowedBy(...bash('npm test'), { ...bare, sandboxed: true })?.by, 'default');
  const made = ruleFor(...bash('npm test'), { cwd: project, sandboxed: false });
  assert.equal(made.rule.outside, true); assert.match(made.line, /also outside the sandbox/);
  saveRule(rule('cargo build').rule, { scope: 'all' });
  assert.equal(allowedBy(...bash('cargo build'), bare), null, 'a rule kept inside the sandbox does not answer where there is none');
  assert.equal(allowedBy(...bash('cargo build'), { ...bare, sandboxed: true })?.by, 'rule');
  saveRule(made.rule, { scope: 'all' });
  assert.deepEqual(allowedBy('execute', { command: 'npm test' }, bare), { by: 'rule', text: 'npm test' }, 'one kept there says so and answers there');
});

// What a rule allows is checked each time it answers, not only when it was kept.
test('a kept rule never reaches a secret, ELU Code\'s state or a git option that runs a program; read programs keep the exact command', t => {
  const { project } = home(t);
  const ctx = { project, cwd: project, saved: true, sandboxed: true }, outside = command => bash(command, { dangerouslyDisableSandbox: true });
  saveRule({ kind: 'command', words: ['npm', 'test'], exact: false, outside: true }, { scope: 'all' });
  saveRule({ kind: 'command', words: ['git', 'log'], exact: false, outside: true }, { scope: 'all' });
  saveRule({ kind: 'command', words: ['git', 'diff'], exact: false, outside: true }, { scope: 'all' });
  assert.equal(allowedBy(...outside('npm test -- src/a.test.js'), ctx)?.by, 'rule');
  assert.equal(allowedBy(...outside('git log --oneline -5'), ctx)?.by, 'rule');
  const state = path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'permission-rules.json');
  for (const command of ['npm test -- ~/.ssh/id_ed25519', 'npm test --config=.env', 'npm test ~/.aws', `npm test ${state}`, `npm test --out=${state}`, 'npm test .env.local',
    'git log --output=/tmp/x', 'git diff --no-index /dev/null notes.txt', 'git log --ext-diff', 'git diff -Oorder.txt', 'git log --exec=x', 'git diff --textconv'])
    assert.equal(allowedBy(...outside(command), ctx), null, command);
  // Programs that read what they are given, and git subcommands that reach another machine, keep the exact command.
  for (const command of ['cat /etc/hosts', 'grep -r x .', 'rg needle', 'ls -la', 'head -5 a.txt', 'tail a.txt', 'tree', 'jq . a.json', 'git fetch origin', 'git clone https://x.test/r', 'git ls-remote origin', 'git archive HEAD', 'git bundle create b HEAD']) {
    const made = rule(command).rule; assert.equal(made.exact, true, command); assert.equal(made.words.join(' '), command);
  }
  saveRule(rule('cat /etc/hosts', { cwd: project }).rule, { scope: 'all' });
  assert.equal(allowedBy(...bash('cat /etc/hosts'), ctx)?.by, 'rule');
  assert.equal(allowedBy(...bash('cat ~/.ssh/id_ed25519'), ctx), null, 'cat kept once reads nothing else');
});

test('the read and git defaults answer a command only inside the sandbox, and never one that runs a program or writes a file', t => {
  const { project } = home(t);
  const inside = { project, cwd: project, saved: false, sandboxed: true };
  for (const command of ['cat package.json', 'git status', 'rg needle', 'git log -3']) {
    assert.equal(allowedBy(...bash(command), inside)?.by, 'default', command);
    assert.equal(allowedBy(...bash(command, { dangerouslyDisableSandbox: true }), inside), null, `${command} outside the sandbox`);
    assert.equal(allowedBy(...bash(command), { ...inside, sandboxed: false }), null, `${command} with no sandbox`);
    assert.equal(allowedBy('execute', { command }, { project, cwd: project, saved: false }), null, `${command} over ACP`);
  }
  for (const command of ['rg --hostname-bin=./x --hyperlink-format=default --color=always foo', 'rg --hostname-bin ./x foo', 'rg --pre=./x foo', 'rg --pre-glob "*" foo', 'tree -o src/index.js .', 'tree --output src/x', 'tree -aR', 'tree -H . -o x', 'file -C -m x', 'file --compile x', 'find . -fprint out'])
    assert.equal(allowedBy(...bash(command), inside), null, command);
  // A read with the file tools in the project stays a default on every vendor.
  assert.equal(allowedBy('read_file', { path: path.join(project, 'package.json') }, { project, cwd: project, saved: false })?.by, 'default');
});

test('every vendor\'s way of asking is read the same', () => {
  assert.deepEqual(actionOf('Bash', { command: 'npm test', dangerouslyDisableSandbox: true }), { kind: 'command', line: 'npm test', outside: true });
  assert.deepEqual(actionOf('execute', { CommandLine: 'npm test', Cwd: '/p' }), { kind: 'command', line: 'npm test', outside: false }, 'Antigravity');
  assert.deepEqual(actionOf('execute', { command: 'npm test' }), { kind: 'command', line: 'npm test', outside: false }, 'Grok Build');
  assert.deepEqual(actionOf('edit', { TargetFile: '/p/a' }), { kind: 'edit', file: '/p/a' });
  assert.deepEqual(actionOf('edit', { path: '/p/a' }), { kind: 'edit', file: '/p/a' });
  assert.deepEqual(actionOf('fetch', { Url: 'https://x.test/' }), { kind: 'fetch', url: 'https://x.test/' });
  assert.deepEqual(actionOf('fetch', { url: 'https://x.test/' }), { kind: 'fetch', url: 'https://x.test/' });
  assert.deepEqual(actionOf('Bash', null), { kind: 'other', tool: 'Bash' });
  assert.deepEqual(commandShape('npm test 2>&1 | grep -c ok'), { main: ['npm', 'test'], filters: [['grep', '-c', 'ok']] });
  assert.deepEqual(commandShape('npm test 2>/dev/null | head -n 5'), { main: ['npm', 'test'], filters: [['head', '-n', '5']] });
  assert.equal(commandShape('npm test | grep -r x /'), null);
});

test('elu permissions lists, removes and turns on, numbered as /permissions numbers them', t => {
  const { dir, project } = home(t);
  saveRule(rule('npm test').rule, { scope: 'project', project });
  const run = args => spawnSync(process.execPath, [CLI, 'permissions', ...args], { cwd: dir, env: { ...process.env, HOME: dir }, encoding: 'utf8' });
  const listed = run([]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^Allowed without asking:\n1\. on {3}Read and search files in the project \(default, all projects\)\n2\. on {3}Git read commands/);
  assert.match(listed.stdout, /\n4\. Run npm test, with any arguments · This project: ~\/shop\n/, 'the project is named from home, as the CLI is run with HOME there');
  assert.equal(run(['list', '--json']).status, 0); assert.equal(JSON.parse(run(['list', '--json']).stdout).permissions.length, 4);
  assert.match(run(['remove', '4']).stdout, /Removed: Run npm test, with any arguments\./);
  assert.match(run(['remove', '1']).stdout, /Turned off: Read and search files in the project\./);
  assert.match(run([]).stdout, /1\. off  Read and search/); assert.match(run([]).stdout, /No rules of yours yet: press a when a session asks\./);
  assert.match(run(['on', '1']).stdout, /Turned on: Read and search/);
  const bad = run(['remove']); assert.notEqual(bad.status, 0); assert.match(bad.stdout + bad.stderr, /Use elu permissions \[list\|remove N\|on N\]/);
});
