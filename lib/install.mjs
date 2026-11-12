// Starts ELU Code. Started through npx, it first makes `elu` a command, so the next start is
// one word, and it runs the installed copy when there is one: the copy npx fetched sits in
// npm's cache, which npm may clear, so nothing lasting may name it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanPath, findBin, quote } from './util.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PACKAGE = '@elu-labs/elu';
const COMMAND = 'elu';
export const BY_HAND = `npm install --global ${PACKAGE}`;

// npx keeps what it runs under _npx in npm's cache. Only such a copy offers to install the command.
export const fromNpx = (folder = ROOT) => path.resolve(folder).split(path.sep).includes('_npx');

// What npm is started with. npx exports the settings of the folder it was started in as
// npm_config_* (that folder's .npmrc among them); none of those is passed on, so only the
// user's own ~/.npmrc decides the registry and the global folder.
const KEPT = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TERM|TMPDIR|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/;
export const npmEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([name]) => KEPT.test(name)));

// npm beside the running node, else the first on PATH. npm's own launcher is a script, and
// it is run with this node, not with whichever node PATH names.
export function npmCommand(env = process.env, node = process.execPath) {
  let file = null;
  try { const beside = path.join(path.dirname(node), 'npm'); fs.accessSync(beside, fs.constants.X_OK); file = fs.realpathSync(beside); }
  catch { file = findBin('npm', env); }
  if (!file) return null;
  return /\.c?js$/.test(file) ? [node, file] : [file];
}
export const runNpm = (npm, args, options) => spawnSync(npm[0], [...npm.slice(1), ...args], { ...options, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

const manifest = folder => JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
// The package behind the first `elu` in these folders. npm links <prefix>/bin/elu to the
// package's own bin folder; any other program of that name has no package of ours behind it.
export function look(folders) {
  const file = findBin(COMMAND, { PATH: folders });
  if (!file) return null;
  try { const root = path.dirname(path.dirname(file)), { name, version } = manifest(root); return { file, root, name, version }; }
  catch { return { file, root: null, name: null, version: null }; }
}
// True when this copy is the installed command: the package behind the first `elu` on PATH,
// or behind ~/.local/bin/elu, where the first start puts it when npm's own folder cannot be
// written. Only such a copy may be named by something lasting, a login item or a service. A
// copy a package runner fetched is neither, wherever that runner keeps it.
export function isInstalled({ root = ROOT, env = process.env, home = os.homedir() } = {}) {
  let mine;
  try { mine = fs.realpathSync(root); } catch { return false; }
  return [cleanPath(env.PATH), path.join(home, '.local', 'bin')].some(folders => look(folders)?.root === mine);
}
// The npm prefix a copy was installed under, when it has npm's layout.
export function prefixOf(root) {
  const prefix = path.resolve(root, '..', '..', '..', '..');
  return path.join(prefix, 'lib', 'node_modules', ...PACKAGE.split('/')) === root ? prefix : null;
}
function writable(prefix) {
  return ['bin', path.join('lib', 'node_modules')].every(part => {
    let folder = path.join(prefix, part);
    while (!fs.existsSync(folder) && path.dirname(folder) !== folder) folder = path.dirname(folder);
    try { fs.accessSync(folder, fs.constants.W_OK | fs.constants.X_OK); return true; } catch { return false; }
  });
}
// The copy npx runs can be older than the installed command: a version asked for by number,
// or one an old npm kept. An older copy never replaces a newer command.
export function newer(installed, mine) {
  const [a, b] = [installed, mine].map(value => String(value).split('-')[0].split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}
const shown = arg => /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : quote(arg);
const reason = result => result.error?.code === 'ETIMEDOUT' ? 'npm took too long'
  : ((result.stderr ?? '').split('\n').map(line => line.replace(/^npm (error|ERR!)\s*/, '').trim()).find(Boolean) ?? result.error?.message ?? 'npm stopped').slice(0, 160);
// The npm line that installs this package at one version under target. --prefix is named
// unless target is npm's global folder (standard), or not known.
export function installLine(version, target = null, standard = null) {
  const args = ['install', '--global', ...(target && target !== standard ? ['--prefix', target] : []), '--ignore-scripts', `${PACKAGE}@${version}`];
  return { args, text: `npm ${args.map(shown).join(' ')}` };
}

// The elu command of this package: the first on PATH, else the one in ~/.local/bin, where the
// first start puts it when npm's own folder cannot be written. first is whatever comes first
// on PATH, ours or not.
export function findCommand({ env = process.env, home = os.homedir() } = {}) {
  const first = look(env.PATH ?? ''), aside = first ? null : look(path.join(home, '.local', 'bin'));
  return { first, aside, have: first ?? aside };
}
// Installs this package at one version, by name, where the command already is (have), else in
// npm's global folder, or under ~/.local when that folder cannot be written. Says the npm line
// it runs after label. Returns { made, target } once the command runs that version, else
// { failed: why, line }, where line is that same npm line, to run by hand.
export function installVersion(version, { have = null, env = process.env, home = os.homedir(), npm, run = runNpm, write = () => {}, label }) {
  // npm runs from the home folder with its own settings; see npmEnv.
  const settings = { cwd: home, env: npmEnv(env) }, local = path.join(home, '.local');
  // Not `npm config get prefix`: npm will not print a value it takes for a secret, and it
  // takes a folder name with an id in it for one.
  const asked = run(npm, ['prefix', '--global'], { ...settings, timeout: 15000 });
  const standard = asked.status === 0 ? asked.stdout.trim() : '';
  // An update goes where the command already is. A first install goes to npm's global
  // folder, or under ~/.local when that folder cannot be written.
  const target = (have?.root && prefixOf(have.root)) ?? (path.isAbsolute(standard) && writable(standard) ? standard : local);
  const { args, text: line } = installLine(version, target, standard);
  write(`${label}: ${line}\n`);
  const result = run(npm, args, { ...settings, timeout: 180000 });
  const made = look(path.join(target, 'bin'));
  if (result.status !== 0 || made?.name !== PACKAGE || made.version !== version) return { failed: reason(result), line };
  return { made, target };
}

// Decides which copy a start through npx runs, installing the command first when that is
// wanted. Returns the installed copy's folder, or null to run the copy npx fetched.
// ELU_NO_INSTALL=1 installs nothing. What is installed is this package at this copy's
// version, by name: nothing in the environment or the current folder can name another.
export function prepare({ argv = [], env = process.env, interactive = false, write = () => {}, root = ROOT, home = os.homedir(), npm = npmCommand(env), run = runNpm } = {}) {
  const version = manifest(root).version, local = path.join(home, '.local');
  const { first, aside, have } = findCommand({ env, home }), wanted = interactive && argv.length === 0 && !env.ELU_NO_INSTALL;
  const startup = /zsh$/.test(env.SHELL ?? '') ? '~/.zshrc' : /bash$/.test(env.SHELL ?? '') ? (process.platform === 'darwin' ? '~/.bash_profile' : '~/.bashrc') : "your shell's startup file";
  const offPath = folder => `${folder} is not on your PATH yet. Add this line to ${startup} and open a new terminal: export PATH="${folder}:$PATH"\n`;
  if (have?.name === PACKAGE && have.version === version) {
    if (aside && wanted) write(offPath(path.join(local, 'bin')));
    return have.root;
  }
  // npx can hand out an older copy it kept from an earlier start, though @latest was asked
  // for. The newer command stays as it is and opens in its place.
  if (have?.name === PACKAGE && have.root && newer(have.version, version)) {
    if (wanted) write(`Opening ELU Code ${have.version}, the version installed here. npx gave an older copy (${version}).\n`);
    return have.root;
  }
  if (!wanted) return null;
  if (first && first.name !== PACKAGE) { write(`Another program named ${COMMAND} is first on your PATH (${first.file}), so the ${COMMAND} command was not installed.\n`); return null; }
  if (!npm) { write(`npm was not found, so the ${COMMAND} command was not installed. To install it yourself: ${BY_HAND}\n`); return null; }
  const done = installVersion(version, { have, env, home, npm, run, write, label: `Installing the ${COMMAND} command` });
  if (done.failed) {
    write(`That did not work (${done.failed}). ELU Code opens anyway. To install the command yourself: ${BY_HAND}\n`);
    return null;
  }
  const { made, target } = done, now = look(env.PATH ?? '');
  if (now && now.root !== made.root) write(`Installed, but another ${COMMAND} comes first on your PATH: ${now.file}\n`);
  else write(`Next time, type: ${COMMAND}\n${now ? '' : offPath(path.join(target, 'bin'))}`);
  return made.root;
}

export async function start({ argv = process.argv.slice(2), env = process.env, input = process.stdin, output = process.stdout } = {}) {
  // npx puts node_modules/.bin of the current folder and of every folder above it first on
  // PATH. Nothing is looked up or started before those entries are gone.
  env.PATH = cleanPath(env.PATH);
  let root = ROOT;
  if (fromNpx()) {
    try { root = prepare({ argv, env, interactive: Boolean(input.isTTY && output.isTTY), write: text => output.write(text) }) ?? ROOT; }
    catch (error) { if (input.isTTY && output.isTTY && !argv.length) output.write(`The ${COMMAND} command was not installed (${error.message}). To install it yourself: ${BY_HAND}\n`); }
  }
  const entry = path.join(root, 'bin', 'elu-code.mjs');
  // The app runs only as the program Node was asked to start, so it is named as that.
  process.argv[1] = entry;
  await import(pathToFileURL(entry).href);
}
