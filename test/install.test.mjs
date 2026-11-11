import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI, command, temp } from './helpers.mjs';
import { cleanPath } from '../lib/util.mjs';
import { prepare, npmEnv, npmCommand, fromNpx, isInstalled, BY_HAND } from '../lib/install.mjs';
import { installScheduler, schedulerFiles } from '../lib/schedules.mjs';
import { installService, servicePath } from '../lib/peer/index.mjs';

const REPO = path.dirname(path.dirname(CLI));
const LAUNCHER = path.join(REPO, 'bin', 'elu.cjs');
const NAME = '@elu-labs/elu';
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

// A package under an npm prefix, linked from its bin folder the way npm links one.
function place(prefix, { name = NAME, version = VERSION, entry = '' } = {}) {
  const root = path.join(prefix, 'lib', 'node_modules', ...name.split('/'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true }); fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version }));
  fs.writeFileSync(path.join(root, 'bin', 'elu.cjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
  if (entry) fs.writeFileSync(path.join(root, 'bin', 'elu-code.mjs'), entry);
  fs.rmSync(path.join(prefix, 'bin', 'elu'), { force: true });
  fs.symlinkSync(path.relative(path.join(prefix, 'bin'), path.join(root, 'bin', 'elu.cjs')), path.join(prefix, 'bin', 'elu'));
  return root;
}
// The folder npx keeps a fetched copy in, a home, and an npm that records what it was asked.
function scene(t, { version = '3.2.1', fail = false } = {}) {
  const dir = temp(t), home = path.join(dir, 'home'), prefix = path.join(dir, 'global');
  const root = path.join(dir, 'cache', '_npx', 'ab12', 'node_modules', '@elu-labs', 'elu');
  for (const folder of [home, prefix, root]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: NAME, version }));
  const calls = [], said = [];
  const run = (npm, args, options) => {
    calls.push({ npm, args, options });
    if (args[0] === 'prefix') return { status: 0, stdout: `${prefix}\n`, stderr: '' };
    if (fail) return { status: 1, stdout: '', stderr: 'npm error code EACCES\nnpm error syscall mkdir\n' };
    place(args.includes('--prefix') ? args[args.indexOf('--prefix') + 1] : prefix, { version });
    return { status: 0, stdout: '', stderr: '' };
  };
  const go = (options = {}) => prepare({ argv: [], interactive: true, root, home, npm: ['npm'], run, write: text => said.push(text), ...options, env: { HOME: home, SHELL: '/bin/zsh', PATH: `${path.join(prefix, 'bin')}:/usr/bin`, ...options.env } });
  return { dir, home, prefix, root, calls, said, go, version };
}

test('PATH loses what npx adds: node_modules/.bin folders, relative entries and empty ones, and keeps the rest in order', () => {
  const value = ['node_modules/.bin', '/work/app/node_modules/.bin', '', '/usr/local/bin', '.', '/work/node_modules/.bin/', '/home/sam/.local/bin', '/work/app/sub/../node_modules/.bin', './bin', '/usr/bin', '/opt/node_modules/tool/bin'].join(':');
  assert.equal(cleanPath(value), '/usr/local/bin:/home/sam/.local/bin:/usr/bin:/opt/node_modules/tool/bin');
  assert.equal(cleanPath(undefined), '');
  assert.equal(cleanPath('/usr/bin:/bin'), '/usr/bin:/bin');
});

test('a Node that is too old gets one sentence and exit code 1', (t) => {
  const preload = path.join(temp(t), 'old.cjs');
  fs.writeFileSync(preload, "Object.defineProperty(process.versions, 'node', { value: process.env.SHOWN_NODE });\n");
  for (const version of ['18.19.1', '20.11.0', '9.11.2', '21.7.3']) {
    const result = command(process.execPath, ['--require', preload, LAUNCHER, '--help'], REPO, { SHOWN_NODE: version });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `ELU Code needs Node 22 or newer; this is Node ${version}.\n`);
    assert.equal(result.stdout, '');
  }
  const current = command(process.execPath, ['--require', preload, LAUNCHER, '--help'], REPO, { SHOWN_NODE: '22.0.0' });
  assert.equal(current.status, 0, current.stderr);
  // The file is plain enough for a Node from before modules, arrow functions and const, and
  // what such a Node cannot read is in a second file, loaded after the check.
  const source = fs.readFileSync(LAUNCHER, 'utf8');
  assert.doesNotMatch(source, /=>|\bconst\b|\blet\b|`|\bawait\b|\?\?|\?\.|\bimport\b/);
  assert.ok(source.indexOf('process.exit(1)') < source.indexOf("require('./start.cjs')"));
});

test('the elu command runs the same program as the entry file, through the links npm makes', (t) => {
  const prefix = path.join(temp(t), 'user prefix'), scope = path.join(prefix, 'lib/node_modules/@elu-labs'), bin = path.join(prefix, 'bin');
  fs.mkdirSync(scope, { recursive: true }); fs.mkdirSync(bin);
  fs.symlinkSync(REPO, path.join(scope, 'elu'));
  fs.symlinkSync('../lib/node_modules/@elu-labs/elu/bin/elu.cjs', path.join(bin, 'elu'));
  const direct = command(process.execPath, [CLI, '--help'], prefix);
  const installed = command(path.join(bin, 'elu'), ['--help'], prefix);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.stdout, direct.stdout);
  assert.equal(installed.stderr, '');
  const json = command(path.join(bin, 'elu'), ['--help', '--json'], prefix);
  assert.equal(JSON.parse(json.stdout).success, true);
  const refused = command(path.join(bin, 'elu'), ['--no-such-option'], prefix);
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, 'Unknown option --no-such-option.\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).bin, { elu: 'bin/elu.cjs' });
});

test('a program a project ships in node_modules/.bin is never the one that runs', (t) => {
  const dir = temp(t), hostile = path.join(dir, 'cloned'), home = path.join(dir, 'home'), marker = path.join(dir, 'ran');
  fs.mkdirSync(path.join(hostile, 'node_modules', '.bin'), { recursive: true }); fs.mkdirSync(home);
  for (const name of ['git', 'npm', 'ps', 'claude', 'codex']) fs.writeFileSync(path.join(hostile, 'node_modules', '.bin', name), `#!/bin/sh\necho "${name} $*" >> "${marker}"\nexit 1\n`, { mode: 0o755 });
  const added = ['node_modules/.bin', path.join(hostile, 'node_modules', '.bin'), path.join(dir, 'node_modules', '.bin'), ''].join(':');
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: `${added}:${process.env.PATH}` };
  // The stand-in does leave its mark when it is the one that runs.
  command('git', ['status'], hostile, env);
  assert.match(fs.readFileSync(marker, 'utf8'), /^git status/);
  fs.rmSync(marker);
  const result = command(process.execPath, [LAUNCHER, '--json'], hostile, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).success, true);
  assert.equal(fs.existsSync(marker), false);
});

test('a start through npx runs the installed copy of the same version, and its own copy when there is none', (t) => {
  const dir = temp(t), prefix = path.join(dir, 'prefix'), home = path.join(dir, 'home');
  const copy = path.join(dir, 'cache', '_npx', 'ab12', 'node_modules', '@elu-labs', 'elu');
  fs.mkdirSync(copy, { recursive: true }); fs.mkdirSync(home);
  for (const part of ['bin', 'lib']) fs.cpSync(path.join(REPO, part), path.join(copy, part), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(copy, 'package.json'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(copy, 'node_modules'));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: `${path.join(prefix, 'bin')}:${process.env.PATH}` };
  const own = command(process.execPath, [path.join(copy, 'bin', 'elu.cjs'), '--help'], dir, env);
  assert.equal(own.status, 0, own.stderr);
  assert.match(own.stdout, /ELU Code/);
  const entry = "import { fileURLToPath } from 'node:url';\nconsole.log('installed copy', JSON.stringify(process.argv.slice(2)), process.argv[1] === fileURLToPath(import.meta.url));\n";
  place(prefix, { entry });
  const handed = command(process.execPath, [path.join(copy, 'bin', 'elu.cjs'), 'peers', '--json'], dir, env);
  assert.equal(handed.status, 0, handed.stderr);
  assert.equal(handed.stdout, 'installed copy ["peers","--json"] true\n');
  // Another version is not run in its place, and a start with arguments installs nothing.
  place(prefix, { version: '0.0.1', entry });
  const other = command(process.execPath, [path.join(copy, 'bin', 'elu.cjs'), '--help'], dir, env);
  assert.equal(other.stdout, own.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(prefix, 'lib/node_modules/@elu-labs/elu/package.json'), 'utf8')).version, '0.0.1');
  // With no terminal there is nothing to install either: the copy npx fetched answers.
  fs.rmSync(prefix, { recursive: true });
  const piped = command(process.execPath, [path.join(copy, 'bin', 'elu.cjs')], dir, env);
  assert.match(piped.stdout, /^ELU Code/);
  assert.equal(piped.stderr, '');
  assert.equal(fs.existsSync(path.join(home, '.local')), false);
});

test('the first start through npx installs this version globally and says what it runs', (t) => {
  const s = scene(t);
  const root = s.go({ env: { npm_config_registry: 'http://127.0.0.1:9/', npm_config_prefix: '/elsewhere', NPM_CONFIG_USERCONFIG: '/elsewhere/npmrc', npm_config_cache: '/elsewhere/cache', INIT_CWD: '/work/cloned', npm_execpath: '/work/cloned/npm.js', npm_lifecycle_event: 'npx', PREFIX: '/elsewhere', NODE_OPTIONS: '--require /work/cloned/x.js', HTTPS_PROXY: 'http://proxy.example:8080', LANG: 'en_US.UTF-8' } });
  assert.equal(root, path.join(s.prefix, 'lib', 'node_modules', '@elu-labs', 'elu'));
  assert.deepEqual(s.calls.map(call => call.args), [['prefix', '--global'], ['install', '--global', '--ignore-scripts', '@elu-labs/elu@3.2.1']]);
  assert.deepEqual(s.said, ['Installing the elu command: npm install --global --ignore-scripts @elu-labs/elu@3.2.1\n', 'Next time, type: elu\n']);
  // npm runs from the home folder and is given nothing the starting folder could have set.
  for (const call of s.calls) {
    assert.equal(call.options.cwd, s.home);
    assert.deepEqual(Object.keys(call.options.env).sort(), ['HOME', 'HTTPS_PROXY', 'LANG', 'PATH', 'SHELL']);
  }
});

test('with arguments, without a terminal, or with ELU_NO_INSTALL=1 nothing is installed and nothing is said', (t) => {
  const s = scene(t);
  assert.equal(s.go({ argv: ['--help'] }), null);
  assert.equal(s.go({ argv: ['peers'] }), null);
  assert.equal(s.go({ interactive: false }), null);
  assert.equal(s.go({ env: { ELU_NO_INSTALL: '1' } }), null);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.said, []);
});

test('when elu already runs this version nothing is installed and nothing is said', (t) => {
  const s = scene(t), installed = place(s.prefix, { version: s.version });
  assert.equal(s.go(), installed);
  assert.equal(s.go({ argv: ['peers'] }), installed);
  assert.equal(s.go({ interactive: false }), installed);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.said, []);
});

test('a global folder that cannot be written sends the install to ~/.local, and a folder off PATH is named', { skip: process.getuid() === 0 }, (t) => {
  const s = scene(t), local = path.join(s.home, '.local');
  fs.chmodSync(s.prefix, 0o555); t.after(() => { try { fs.chmodSync(s.prefix, 0o755); } catch { /* Removed with the test's folder. */ } });
  const root = s.go();
  assert.equal(root, path.join(local, 'lib', 'node_modules', '@elu-labs', 'elu'));
  assert.deepEqual(s.calls[1].args, ['install', '--global', '--prefix', local, '--ignore-scripts', '@elu-labs/elu@3.2.1']);
  assert.deepEqual(s.said, [`Installing the elu command: npm install --global --prefix ${local} --ignore-scripts @elu-labs/elu@3.2.1\n`,
    `Next time, type: elu\n${path.join(local, 'bin')} is not on your PATH yet. Add this line to ~/.zshrc and open a new terminal: export PATH="${path.join(local, 'bin')}:$PATH"\n`]);
  // The next start through npx finds that copy: it installs nothing and names the folder again.
  s.calls.length = 0; s.said.length = 0;
  assert.equal(s.go(), root);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.said, [`${path.join(local, 'bin')} is not on your PATH yet. Add this line to ~/.zshrc and open a new terminal: export PATH="${path.join(local, 'bin')}:$PATH"\n`]);
  // The line names the startup file of the shell in use.
  s.said.length = 0; s.go({ env: { SHELL: '/bin/bash' } }); s.go({ env: { SHELL: '/usr/bin/fish' } });
  assert.match(s.said[0], new RegExp(`Add this line to ${process.platform === 'darwin' ? '~/.bash_profile' : '~/.bashrc'} and open a new terminal`));
  assert.match(s.said[1], /Add this line to your shell's startup file and open a new terminal/);
  // With the folder on PATH there is nothing to say.
  s.said.length = 0;
  assert.equal(s.go({ env: { PATH: `${path.join(local, 'bin')}:/usr/bin` } }), root);
  assert.deepEqual(s.said, []);
});

test('a newer elu is never replaced by an older copy: the copy npx fetched runs and says why nothing was installed', (t) => {
  const s = scene(t);
  for (const version of ['3.2.2', '3.10.0', '4.0.0']) {
    place(s.prefix, { version });
    assert.equal(s.go(), null);
    assert.equal(s.said.pop(), `The elu command on this computer is newer (${version}) than this copy (3.2.1), so it was left as it is.\n`);
    assert.equal(s.go({ argv: ['--version'] }), null);
    assert.equal(s.go({ interactive: false }), null);
  }
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.said, []);
});

test('an older elu is updated where it is', (t) => {
  const s = scene(t), local = path.join(s.home, '.local');
  place(local, { version: '3.0.0' });
  const root = s.go({ env: { PATH: `${path.join(local, 'bin')}:${path.join(s.prefix, 'bin')}:/usr/bin` } });
  assert.equal(root, path.join(local, 'lib', 'node_modules', '@elu-labs', 'elu'));
  assert.deepEqual(s.calls[1].args, ['install', '--global', '--prefix', local, '--ignore-scripts', '@elu-labs/elu@3.2.1']);
  assert.deepEqual(s.said.slice(1), ['Next time, type: elu\n']);
});

test('a failed install says how to install by hand and the app still opens from the copy npx fetched', (t) => {
  const s = scene(t, { fail: true });
  assert.equal(s.go(), null);
  assert.deepEqual(s.said, ['Installing the elu command: npm install --global --ignore-scripts @elu-labs/elu@3.2.1\n',
    `That did not work (code EACCES). ELU Code opens anyway. To install the command yourself: ${BY_HAND}\n`]);
  assert.equal(BY_HAND, 'npm install --global @elu-labs/elu');
  // No npm at all is said the same way.
  const none = scene(t);
  assert.equal(none.go({ npm: null }), null);
  assert.deepEqual(none.said, [`npm was not found, so the elu command was not installed. To install it yourself: ${BY_HAND}\n`]);
  // An npm that reports success and leaves no command is a failure too.
  const empty = scene(t);
  assert.equal(empty.go({ run: (npm, args) => ({ status: 0, stdout: args[0] === 'prefix' ? `${empty.prefix}\n` : '', stderr: '' }) }), null);
  assert.match(empty.said.at(-1), /^That did not work \(npm stopped\)\./);
});

test('another program named elu is left alone', (t) => {
  const s = scene(t);
  place(s.prefix, { name: '@elu-labs/cli', version: '1.1.0' });
  assert.equal(s.go(), null);
  assert.deepEqual(s.calls, []);
  assert.equal(s.said.length, 1);
  assert.match(s.said[0], /^Another program named elu is first on your PATH \(.*\), so the elu command was not installed\.\n$/);
});

test('what is installed is this package at this version, whatever the environment names', (t) => {
  const s = scene(t), file = path.join(s.dir, 'another.tgz');
  s.go({ env: { ELU_INSTALL_FROM: file, ELU_PACKAGE: 'left-pad', npm_package_name: 'left-pad', npm_config_registry: 'http://127.0.0.1:9/', npm_config_global: 'false' } });
  assert.deepEqual(s.calls[1].args, ['install', '--global', '--ignore-scripts', '@elu-labs/elu@3.2.1']);
  assert.deepEqual(Object.keys(s.calls[1].options.env).sort(), ['HOME', 'PATH', 'SHELL']);
});

test('the package ships its lock, so an install gets the dependency versions the tests ran with', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'npm-shrinkwrap.json'), 'utf8'));
  assert.ok(manifest.files.includes('npm-shrinkwrap.json'));
  // npm reads only one lock file; a second one would be the one that is not published.
  assert.equal(fs.existsSync(path.join(REPO, 'package-lock.json')), false);
  const top = lock.packages[''];
  assert.deepEqual([lock.name, lock.version, top.name, top.version], [manifest.name, manifest.version, manifest.name, manifest.version]);
  for (const group of ['dependencies', 'optionalDependencies']) assert.deepEqual(top[group], manifest[group]);
  for (const [name, wanted] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) assert.equal(lock.packages[`node_modules/${name}`].version, wanted);
  for (const [where, entry] of Object.entries(lock.packages)) if (where) assert.match(`${entry.version} ${entry.integrity}`, /^\d+\.\d+\.\d+\S* sha512-/, where);
});

test('npm is the one beside the running node, run with that node, and never one from a project folder', (t) => {
  const dir = temp(t), nodes = path.join(dir, 'node', 'bin'), cli = path.join(dir, 'node', 'lib', 'npm-cli.js'), other = path.join(dir, 'other');
  fs.mkdirSync(nodes, { recursive: true }); fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.mkdirSync(other);
  fs.writeFileSync(cli, '', { mode: 0o755 }); fs.symlinkSync('../lib/npm-cli.js', path.join(nodes, 'npm'));
  fs.writeFileSync(path.join(other, 'npm'), '#!/bin/sh\n', { mode: 0o755 });
  const node = path.join(nodes, 'node');
  assert.deepEqual(npmCommand({ PATH: other }, node), [node, cli]);
  fs.rmSync(path.join(nodes, 'npm'));
  assert.deepEqual(npmCommand({ PATH: other }, node), [path.join(other, 'npm')]);
  const hostile = path.join(dir, 'cloned', 'node_modules', '.bin');
  fs.mkdirSync(hostile, { recursive: true }); fs.writeFileSync(path.join(hostile, 'npm'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(npmCommand({ PATH: cleanPath(`${hostile}:node_modules/.bin`) }, node), null);
  assert.deepEqual(npmEnv({ PATH: '/usr/bin', npm_config_registry: 'x', NPM_CONFIG_PREFIX: 'x', LC_ALL: 'C', https_proxy: 'p', NODE_OPTIONS: '--require /work/x.js' }), { PATH: '/usr/bin', LC_ALL: 'C', https_proxy: 'p' });
});

// A copy of this package where a package runner keeps one, with the bin link the runner makes.
function fetched(dir, ...parts) {
  const modules = path.join(dir, ...parts, 'node_modules'), root = path.join(modules, '@elu-labs', 'elu');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true }); fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: NAME, version: VERSION }));
  fs.writeFileSync(path.join(root, 'bin', 'elu.cjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
  fs.symlinkSync('../@elu-labs/elu/bin/elu.cjs', path.join(modules, '.bin', 'elu'));
  return { root, bin: path.join(modules, '.bin') };
}

test('only the copy the elu command runs counts as installed, wherever a package runner keeps its own', (t) => {
  const dir = fs.realpathSync(temp(t)), home = path.join(dir, 'home'), prefix = path.join(dir, 'global');
  fs.mkdirSync(home);
  const runners = [fetched(dir, 'npm-cache', '_npx', 'ab12'), fetched(dir, 'pnpm-cache', 'dlx', 'ab12', '19a8f'), fetched(dir, 'tmp', 'xfs-ab12', 'dlx-501'), fetched(dir, 'tmp', 'bunx-501-@elu-labs', 'elu@latest')];
  // Nothing installed: no fetched copy counts, though each runner puts its own elu first on PATH.
  for (const { root, bin } of runners) assert.equal(isInstalled({ root, home, env: { PATH: `${bin}:${path.join(prefix, 'bin')}:/usr/bin` } }), false, root);
  // Installed under npm's global folder: that copy counts, a fetched copy still does not.
  const global = place(prefix);
  assert.equal(isInstalled({ root: global, home, env: { PATH: `${path.join(prefix, 'bin')}:/usr/bin` } }), true);
  for (const { root, bin } of runners) assert.equal(isInstalled({ root, home, env: { PATH: `${bin}:${path.join(prefix, 'bin')}:/usr/bin` } }), false, root);
  assert.equal(isInstalled({ root: global, home, env: { PATH: '/usr/bin' } }), false);
  // Installed under ~/.local, on PATH or not: the place the first start falls back to.
  const local = place(path.join(home, '.local'));
  assert.equal(isInstalled({ root: local, home, env: { PATH: '/usr/bin' } }), true);
  assert.equal(isInstalled({ root: local, home, env: { PATH: `${path.join(home, '.local', 'bin')}:/usr/bin` } }), true);
  assert.equal(isInstalled({ root: global, home, env: { PATH: `${path.join(home, '.local', 'bin')}:${path.join(prefix, 'bin')}` } }), false, 'not the first elu on PATH');
  // A checkout linked as the command, the way `npm install --global .` links one.
  const checkout = path.join(dir, 'checkout'), linked = path.join(dir, 'linked');
  fs.mkdirSync(path.join(checkout, 'bin'), { recursive: true }); fs.mkdirSync(path.join(linked, 'lib', 'node_modules', '@elu-labs'), { recursive: true }); fs.mkdirSync(path.join(linked, 'bin'));
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: NAME, version: VERSION })); fs.writeFileSync(path.join(checkout, 'bin', 'elu.cjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
  fs.symlinkSync(checkout, path.join(linked, 'lib', 'node_modules', '@elu-labs', 'elu')); fs.symlinkSync('../lib/node_modules/@elu-labs/elu/bin/elu.cjs', path.join(linked, 'bin', 'elu'));
  assert.equal(isInstalled({ root: checkout, home, env: { PATH: `${path.join(linked, 'bin')}:/usr/bin` } }), true);
  assert.equal(isInstalled({ root: path.join(linked, 'lib', 'node_modules', '@elu-labs', 'elu'), home, env: { PATH: `${path.join(linked, 'bin')}:/usr/bin` } }), true);
  // Another program named elu, a folder that is gone, an empty PATH.
  place(path.join(dir, 'other'), { name: '@elu-labs/cli' });
  assert.equal(isInstalled({ root: global, home, env: { PATH: `${path.join(dir, 'other', 'bin')}:${path.join(prefix, 'bin')}` } }), false);
  assert.equal(isInstalled({ root: path.join(dir, 'gone'), home, env: { PATH: `${path.join(prefix, 'bin')}` } }), false);
  assert.equal(isInstalled({ root: runners[0].root, home, env: {} }), false);
  // The path test for npx only decides who offers to install the command.
  assert.equal(fromNpx(runners[0].root), true);
  assert.equal(fromNpx(global), false);
  assert.equal(fromNpx(), false);
});

test('a login item and a login service are written only by the installed command', (t) => {
  const dir = fs.realpathSync(temp(t)), prefix = path.join(dir, 'prefix'), scope = path.join(prefix, 'lib', 'node_modules', '@elu-labs'), ran = [], run = (...args) => ran.push(args);
  const previous = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  const entry = path.join(REPO, 'bin', 'elu-code.mjs').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const platform of ['darwin', 'linux']) {
    // This copy is not what elu runs here: nothing is written and nothing is loaded.
    const home = path.join(dir, platform), options = { platform, home, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: `${path.join(prefix, 'bin')}:/usr/bin` }, run };
    fs.mkdirSync(home);
    assert.deepEqual(installScheduler(options), { installed: false, reason: `Schedules run only while ELU Code is open until it is installed: ${BY_HAND}` });
    assert.throws(() => installService(options), /Install ELU Code first, then start it at login: npm install --global @elu-labs\/elu/);
    for (const file of [...schedulerFiles(options), servicePath(options)]) assert.equal(fs.existsSync(file), false);
    assert.deepEqual(ran, []);
  }
  // The same calls once elu on PATH is this copy: both are written and name this copy's files.
  fs.mkdirSync(scope, { recursive: true }); fs.mkdirSync(path.join(prefix, 'bin'));
  fs.symlinkSync(REPO, path.join(scope, 'elu')); fs.symlinkSync('../lib/node_modules/@elu-labs/elu/bin/elu.cjs', path.join(prefix, 'bin', 'elu'));
  for (const platform of ['darwin', 'linux']) {
    const home = path.join(dir, platform), options = { platform, home, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: `${path.join(prefix, 'bin')}:/usr/bin` }, run };
    const made = installScheduler(options);
    assert.equal(made.installed, true);
    assert.match(fs.readFileSync(made.files[0], 'utf8'), new RegExp(`${entry}(</string><string>| )schedule`));
    assert.match(fs.readFileSync(installService(options).file, 'utf8'), new RegExp(`${entry}(</string>\\s*<string>| )peer`));
  }
  assert.deepEqual([...new Set(ran.map(call => call[0]))], ['launchctl', 'systemctl']);
});

test('a login item saves a PATH without node_modules/.bin folders', (t) => {
  const home = temp(t), ran = [], run = (...args) => ran.push(args);
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: `/work/cloned/node_modules/.bin:/usr/local/bin:node_modules/.bin:/usr/bin` };
  const result = installScheduler({ platform: 'linux', home, env, run, lasting: true });
  assert.equal(result.installed, true);
  const unit = fs.readFileSync(result.files[0], 'utf8');
  assert.match(unit, /Environment=PATH=\/usr\/local\/bin:\/usr\/bin\n/);
  assert.match(unit, new RegExp(`ExecStart=\\S+ ${fileURLToPath(new URL('../bin/elu-code.mjs', import.meta.url)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} schedule tick`));
});
