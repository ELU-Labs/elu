import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { findBin, refuse, mkdir, noSymlinks, tempFolder, onDiskPath } from './util.mjs';
import { assertNoCodexProjectConfig } from './policy.mjs';
import { agentEnv, runProcess } from './process.mjs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

// Whether Claude Code's shell sandbox can start on this machine. On Linux it is bubblewrap: it
// needs bwrap and socat on PATH, and bwrap must be allowed to make its namespaces, which
// Ubuntu 24.04 stops until an AppArmor profile for it is loaded (docs/permissions.md, Linux).
// 'missing': a tool is not installed. 'blocked': both are, and bwrap cannot start. 'ok'
// otherwise, and on every other system, where nothing is started. bwrap is really started
// around a command that does nothing, with the namespaces Claude Code's sandbox makes: a user
// namespace among them, which a bwrap run as root or installed setuid can do without, so a trial
// without one starts where the sandbox cannot. The answer is kept for each bwrap program (its
// real path, size and time), so the Permissions picker and every turn start it once; another
// one, or a new one in its place, is started again.
const SHELL_TRIAL = ['--unshare-user', '--unshare-net', '--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '/bin/sh', '-c', ':'];
const shellTrials = new Map();
export function shellSandbox({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'linux') return 'ok';
  const bwrap = findBin('bwrap', env);
  if (!bwrap || !findBin('socat', env)) return 'missing';
  let key = bwrap; try { const file = fs.statSync(bwrap); key = `${bwrap}\0${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}`; } catch { /* Gone since: asked as named. */ }
  if (!shellTrials.has(key)) shellTrials.set(key, spawnSync(bwrap, SHELL_TRIAL, { env, stdio: 'ignore', timeout: 5000 }).status === 0 ? 'ok' : 'blocked');
  return shellTrials.get(key);
}
// What the Permissions picker and elu policy show say about it: nothing where the sandbox
// works. The link has a line of its own, so a narrow terminal never breaks it.
export function shellSandboxLine(state = shellSandbox()) {
  if (state === 'missing') return ['No OS sandbox here: commands ask you (Ask) or are reviewed (Approve for me).'];
  if (state === 'blocked') return ['The OS sandbox cannot start here, so commands ask you (Ask) or are reviewed (Approve for me). See:', 'https://github.com/ELU-Labs/elu/blob/main/docs/permissions.md#linux'];
  return [];
}

// The helper is the one program started outside the sandbox, so only the owner's own
// environment names it. A project's settings file comes with the repository and never does.
export function findSandboxHelper(config={},env=process.env){
  const configured=env.ELU_CODE_SANDBOX_HELPER;
  if(configured){
    if(!path.isAbsolute(configured))refuse('The sandbox helper path must be absolute.');
    try{fs.accessSync(configured,fs.constants.X_OK);if(fs.statSync(configured).isFile())return fs.realpathSync(configured);}catch{}
    refuse('The configured sandbox helper is missing or not executable.');
  }
  const bin=findBin('codex',env);if(!bin)refuse('Install the Codex sandbox helper, or set ELU_CODE_SANDBOX_HELPER to its absolute path.');return bin;
}
// The sandbox a project's checks and pre-push hooks run in on this computer, as { kind, bin }:
// Codex's ('codex': the copy ELU_CODE_SANDBOX_HELPER names, or the codex on PATH), or else the
// one the system has: bubblewrap ('bwrap') on Linux, sandbox-exec ('seatbelt') on macOS. Each
// gives a check the same limits (sandboxCommand). null where there is none.
const SYSTEM_SANDBOX = { linux: ['bwrap', 'bwrap'], darwin: ['seatbelt', 'sandbox-exec'] };
export function checkSandbox(env = process.env, platform = process.platform) {
  if (env.ELU_CODE_SANDBOX_HELPER || findBin('codex', env)) return { kind: 'codex', bin: findSandboxHelper({}, env) };
  const [kind, name] = SYSTEM_SANDBOX[platform] ?? [];
  const bin = name ? findBin(name, env) : null;
  return bin ? { kind, bin } : null;
}
// What ELU says where a session needs a sandbox and this computer has none, or its bubblewrap
// cannot start: plainly, with the one step that fixes it. what: what needs it; then: the way on.
const INSTALL = [['apt-get', 'sudo apt install bubblewrap'], ['dnf', 'sudo dnf install bubblewrap'], ['yum', 'sudo yum install bubblewrap'], ['pacman', 'sudo pacman -S bubblewrap'], ['zypper', 'sudo zypper install bubblewrap'], ['apk', 'sudo apk add bubblewrap']];
export function noSandboxLine({ what = "the project's checks", then = 'type continue', platform = process.platform, env = process.env } = {}) {
  if (platform !== 'linux') return `This computer has no sandbox for ${what}. Install Codex: npm install --global @openai/codex, then ${then}.`;
  const on = PATH => INSTALL.find(([tool]) => findBin(tool, { PATH }))?.[1];
  return `This computer has no sandbox for ${what}. Install bubblewrap: ${on(env.PATH) ?? on('/usr/bin:/bin:/usr/sbin:/sbin') ?? INSTALL[0][1]}, then ${then}.`;
}
export const blockedSandboxLine = ({ what = "the project's checks", then = 'type continue' } = {}) => `Bubblewrap cannot start on this computer, so ${what} cannot run in its sandbox. Load the AppArmor profile in ELU's docs/permissions.md (Linux), then ${then}.`;
// Whether bubblewrap starts here with the namespaces a check gets: Ubuntu 24.04 stops it until
// an AppArmor profile lets it (docs/permissions.md, Linux). Kept for each bwrap program only once
// it starts, so a fix counts at the next try.
const bwrapStarted = new Set();
export function bwrapStarts(bin, env = process.env) {
  let key = bin; try { const file = fs.statSync(bin); key = `${bin}\0${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}`; } catch { /* Asked as named. */ }
  if (bwrapStarted.has(key)) return true;
  const started = spawnSync(bin, ['--die-with-parent', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', process.execPath, '-e', ''], { env, stdio: 'ignore', timeout: 10000 }).status === 0;
  if (started) bwrapStarted.add(key);
  return started;
}
// The sandbox here that starts, or a refusal that says why there is none and how to get one.
export function usableSandbox({ what, then } = {}, env = process.env) {
  const sandbox = checkSandbox(env) ?? refuse(noSandboxLine({ what, then, env }));
  if (sandbox.kind === 'bwrap' && !bwrapStarts(sandbox.bin, env)) refuse(blockedSandboxLine({ what, then }));
  return sandbox;
}
// What a session's checks need before its work starts: nothing in Full access, which runs them
// as the owner's terminal would (openRun), or where there is no check; otherwise a sandbox here
// that starts. Refuses plainly, with the step that fixes it, where there is none. probe: the
// sandbox is first proven to deny a write outside and the network (probeSandbox).
export async function checksCanRun(config = {}, { mode = 'locked', probe = false } = {}) {
  if (mode === 'full' || !config.checks?.length) return null;
  const sandbox = usableSandbox();
  if (probe) await probeSandbox(config, sandbox);
  return sandbox;
}
export async function probeSandbox(config={},sandbox=usableSandbox()){
  const root=tempFolder('elu-code-sandbox-proof-');
  const cwd=path.join(root,'worktree');mkdir(cwd);const home=path.join(root,'home');mkdir(home);
  mkdir(path.join(home,'.codex'));mkdir(path.join(home,'.config'));
  const outside=path.join(root,'outside');const server=net.createServer(socket=>socket.end('probe'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const script=`const fs=require('fs'),net=require('net');fs.writeFileSync('allowed','yes');let writeDenied=false;try{fs.writeFileSync(${JSON.stringify(outside)},'bad')}catch{writeDenied=true}const socket=net.connect(${server.address().port},'127.0.0.1');const done=(networkDenied)=>{socket.destroy();console.log(JSON.stringify({writeDenied,networkDenied}));};socket.once('error',()=>done(true));socket.once('connect',()=>done(false));socket.setTimeout(1500,()=>done(false));`;
  try{
    const run=await sandboxRun({cwd,sandbox,program:process.execPath,args:['-e',script,'elu-code-sandbox-probe'],logFile:path.join(root,'probe.log'),timeoutSeconds:10,env:{HOME:home,CODEX_HOME:path.join(home,'.codex'),XDG_CONFIG_HOME:path.join(home,'.config')}});
    let proof;try{proof=JSON.parse(fs.readFileSync(path.join(root,'probe.log'),'utf8').trim());}catch{}
    if(run.code!==0||run.timedOut||typeof proof?.writeDenied!=='boolean'||!proof?.networkDenied||fs.existsSync(outside))refuse('The sandbox helper failed its file-write or network test. Nothing was started.',{exitCode:run.code,proof:proof??null,diagnostic:fs.readFileSync(run.stderrFile,'utf8').slice(-1500)});
    return {available:true,working:true,writeDenied:proof.writeDenied,outsideWriteContained:true,networkDenied:true,requiresSignIn:false};
  }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
}

// What a check may touch, whichever sandbox runs it: each path 'read', 'write' or 'deny'.
// ':minimal' is the system's own programs and libraries; a path with * is a pattern.
function checkLimits({ cwd, protectedPaths = [], writablePaths = ['.'], scratch, program, readPaths = [], deniedPaths = [], helper = null }) {
  const filesystem = { ':minimal': 'read', [cwd]: 'read' };
  for (const folder of ['/tmp','/private/tmp','/var/tmp','/private/var/tmp']) filesystem[folder]='deny';
  for (const file of writablePaths) filesystem[path.resolve(cwd, file)] = 'write';
  for (const file of protectedPaths) filesystem[path.resolve(cwd, file)] = 'read';
  if(fs.existsSync(path.join(cwd,'.git')))filesystem[path.join(cwd, '.git')] = 'deny';
  for (const file of readPaths) filesystem[file] = 'read';
  for (const file of ['.env', '.env.*', '**/.env', '**/.env.*', '**/.npmrc', '**/auth.json', '**/credentials.json', '**/*.pem']) filesystem[path.join(cwd, file)] = 'deny';
  if (scratch) filesystem[scratch] = 'write';
  const runtime = path.dirname(fs.realpathSync(process.execPath));
  filesystem[runtime] = 'read';
  const executable = path.isAbsolute(program) ? program : findBin(program);
  if (!executable) refuse(`Check program is not installed: ${program}`);
  for(const file of [executable,helper].filter(Boolean)){
    let executableRoot = path.dirname(fs.realpathSync(file));
    const modulePart = executableRoot.indexOf(`${path.sep}node_modules${path.sep}`);
    if (modulePart >= 0) {
      const prefix = executableRoot.slice(0, modulePart + '/node_modules/'.length);
      const pieces = executableRoot.slice(prefix.length).split(path.sep);
      executableRoot = path.join(prefix, ...pieces.slice(0, pieces[0].startsWith('@') ? 2 : 1));
    }
    filesystem[executableRoot] = 'read';
  }
  for(const file of deniedPaths)filesystem[file]='deny';
  return { filesystem, executable };
}
// Codex's sandbox (`codex sandbox`) with a check's limits, as a profile of its own.
// network: 'off' (every check outside Full access) or 'on'.
export function sandboxArgs({ helper = findBin('codex'), network = 'off', args = [], ...limits }) {
  if (!['off', 'on'].includes(network)) refuse('Network is off or on.');
  const name = `elu_code_${crypto.randomBytes(8).toString('hex')}`;
  const { filesystem } = checkLimits({ ...limits, helper }), program = limits.program;
  const entries = Object.entries(filesystem).map(([key, access]) => `${JSON.stringify(key)}=${JSON.stringify(access)}`).join(',');
  const profile = `{filesystem={${entries}},network={enabled=${network === 'on'}}}`;
  return ['sandbox', '-P', name, '-c', `permissions.${name}=${profile}`, '-c', 'features.hooks=false', '-c', 'shell_environment_policy.inherit="all"', '-c', 'shell_environment_policy.set.OPENSSL_CONF="/dev/null"', '--', program, ...args];
}
// The paths of a check's limits, each pattern as the files it names now and a folder before
// what lies in it. A pattern is <folder>/<name> or <folder>/**/<name>, * in the name any text;
// each folder is walked once for all of its patterns, never through a link.
function limitPaths(filesystem) {
  const rows = new Map(), walks = new Map(), deep = `${path.sep}**${path.sep}`;
  for (const [key, access] of Object.entries(filesystem)) {
    if (key === ':minimal') continue;
    if (!key.includes('*')) { rows.set(key, access); continue; }
    const below = key.includes(deep), [folder, name] = below ? key.split(deep) : [path.dirname(key), path.basename(key)];
    const test = new RegExp(`^${name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    walks.set(folder, [...walks.get(folder) ?? [], { test, below, access }]);
  }
  for (const [folder, tests] of walks) {
    const visit = (dir, top) => {
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(dir, entry.name);
        for (const { test, below, access } of tests) if ((below || top) && test.test(entry.name)) rows.set(file, access);
        if (entry.isDirectory() && entry.name !== '.git' && tests.some(row => row.below)) visit(file, false);
      }
    };
    visit(folder, true);
  }
  const depth = file => path.resolve(file).split(path.sep).length;
  return [...rows].sort((a, b) => depth(a[0]) - depth(b[0]));
}
// Bubblewrap with a check's limits: a new root that holds only the system's programs and
// libraries and each path as the limits give it, a folder in another mounted after it; a path
// denied is an empty folder or a file nothing can open; nothing else in it can be written. Its
// own processes, and no network unless on.
const SYSTEM = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc'];
function bwrapArgs({ filesystem, executable, args, cwd, network }) {
  const out = ['--die-with-parent', '--new-session', '--unshare-pid', ...(network === 'on' ? [] : ['--unshare-net']), '--dev', '/dev', '--proc', '/proc'], sealed = [];
  for (const dir of SYSTEM) out.push('--ro-bind-try', dir, dir);
  for (const [file, access] of limitPaths(filesystem)) {
    let stat; try { stat = fs.statSync(file); } catch { continue; }
    if (access === 'write') out.push('--bind', file, file);
    else if (access === 'read') out.push('--ro-bind', file, file);
    else if (stat.isDirectory()) { out.push('--tmpfs', file); sealed.push('--remount-ro', file); }
    else out.push('--ro-bind', '/dev/null', file);
  }
  return [...out, ...sealed, '--remount-ro', '/', '--chdir', cwd, executable, ...args];
}
// sandbox-exec with a check's limits. It sees each file by its real path, so the paths are
// given as they are on disk. All else runs as usual, but nothing is written outside the paths
// given to write (and a few devices), nothing read in the folders that hold people's own files
// outside the paths given, nothing of a path denied, and no network unless on.
const PEOPLE = ['/Users', '/Volumes', '/private/var/folders', '/private/tmp', '/private/var/tmp'];
const DEVICES = ['(literal "/dev/null")', '(literal "/dev/zero")', '(literal "/dev/tty")', '(literal "/dev/dtracehelper")', '(literal "/dev/ptmx")', '(regex #"^/dev/fd/")', '(regex #"^/dev/ttys[0-9]+$")'];
export function seatbeltProfile({ filesystem, network }) {
  const rows = limitPaths(filesystem).map(([file, access]) => [onDiskPath(file), access]);
  const sub = file => `(subpath ${JSON.stringify(file)})`, any = list => `(require-any ${list.join(' ')})`;
  const within = (folder, file) => file !== folder && file.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
  // A path, but not what lies in it with another access.
  const only = (file, others) => { const inner = rows.filter(([other, access]) => others.includes(access) && within(file, other)).map(([other]) => sub(other)); return inner.length ? `(require-all ${sub(file)} (require-not ${any(inner)}))` : sub(file); };
  const given = rows.filter(([, access]) => access !== 'deny').map(([file]) => sub(file));
  const lines = ['(version 1)', '(allow default)'];
  if (network !== 'on') lines.push('(deny network*)');
  lines.push(`(deny file-read-data (require-all ${any(PEOPLE.map(sub))}${given.length ? ` (require-not ${any(given)})` : ''}))`);
  lines.push(`(deny file-write* (require-not ${any([...DEVICES, ...rows.filter(([, access]) => access === 'write').map(([file]) => only(file, ['read', 'deny']))])}))`);
  for (const [file] of rows.filter(([, access]) => access === 'deny')) lines.push(`(deny file-read* file-write* ${only(file, ['read', 'write'])})`);
  return lines.join('\n');
}
// The command that runs a program in a sandbox with a check's limits (checkLimits): Codex's own,
// or the system's with the same limits. limits: what checkLimits takes, and the program's args.
// env: the environment it runs with. In the system's sandbox a folder of the owner's that holds
// his programs may not be there, so the folder of the node ELU runs on, which is, comes last on
// its PATH: a script that starts with /usr/bin/env node still finds one.
export function sandboxCommand({ sandbox, network = 'off', args = [], env = {}, ...limits }) {
  if (!['off', 'on'].includes(network)) refuse('Network is off or on.');
  if (sandbox?.kind === 'codex') return { bin: sandbox.bin, args: sandboxArgs({ ...limits, args, helper: sandbox.bin, network }), env };
  const { filesystem, executable } = checkLimits(limits), runtime = path.dirname(fs.realpathSync(process.execPath));
  const folders = (env.PATH ?? '').split(path.delimiter).filter(Boolean), reach = { ...env, PATH: [...folders, ...(folders.includes(runtime) ? [] : [runtime])].join(path.delimiter) };
  if (sandbox?.kind === 'bwrap') return { bin: sandbox.bin, args: bwrapArgs({ filesystem, executable, args, cwd: limits.cwd, network }), env: reach };
  if (sandbox?.kind === 'seatbelt') return { bin: sandbox.bin, args: ['-p', seatbeltProfile({ filesystem, network }), executable, ...args], env: reach };
  refuse('Choose a sandbox: codex, bwrap or seatbelt.');
}
// A check of a Full access session runs as the owner's terminal would run it: no sandbox, and
// his whole environment but the vendors' own names (agentEnv full). Full access is everything.
export async function openRun({ cwd, program, args = [], logFile, processFile, timeoutSeconds = null, signal }) {
  const executable = path.isAbsolute(program) ? program : findBin(program);
  if (!executable) refuse(`Check program is not installed: ${program}`);
  return runProcess({ bin: executable, args, cwd, env: agentEnv(process.env, [], {}, { full: true }), logFile, processFile, timeoutSeconds, signal });
}
// sandbox: { kind, bin } (checkSandbox); helper: a Codex sandbox helper to use instead.
// Without either, the sandbox this computer has, or a refusal that says there is none.
export async function sandboxRun({ cwd, protectedPaths, writablePaths, scratch, program, args, logFile, processFile, timeoutSeconds = 120, env: extraEnv = {}, readPaths, helper, sandbox, config, signal, network = 'off' }) {
  sandbox ??= helper ? { kind: 'codex', bin: helper } : usableSandbox();
  const codex = sandbox.kind === 'codex';
  if (codex) assertNoCodexProjectConfig(cwd);
  const ownedScratch=!scratch;
  scratch ??= path.join(cwd,'.elu-code','tmp',crypto.randomUUID());
  noSymlinks(scratch); mkdir(scratch);
  const helperHome=codex?path.join(scratch,'codex-home'):null;if(helperHome)mkdir(helperHome);
  const temporary=path.join(scratch,'tmp');mkdir(temporary);
  const globalConfig = path.join(scratch ?? cwd, 'global.npmrc');
  const env = { ...agentEnv(), ...extraEnv, ...(helperHome ? { CODEX_HOME: helperHome } : {}), OPENSSL_CONF: '/dev/null', npm_config_userconfig: '/dev/null', npm_config_globalconfig: globalConfig, npm_config_script_shell: '/bin/sh', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', TMPDIR:temporary, npm_config_cache: path.join(scratch, 'npm-cache') };
  try { const command = sandboxCommand({ sandbox, cwd, protectedPaths, writablePaths, scratch, program, args, readPaths, network, env }); return await runProcess({ bin: command.bin, args: command.args, cwd, env: command.env, logFile, processFile, timeoutSeconds, signal }); }
  finally { if(ownedScratch)fs.rmSync(scratch,{recursive:true,force:true}); }
}
