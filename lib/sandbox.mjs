import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { findBin, refuse, mkdir, noSymlinks, tempFolder } from './util.mjs';
import { assertNoCodexProjectConfig } from './policy.mjs';
import { agentEnv, runProcess } from './process.mjs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

// Whether Claude Code's shell sandbox can start on this machine. On Linux it is bubblewrap: it
// needs bwrap and socat on PATH, and bwrap must be allowed to make its namespaces, which
// Ubuntu 24.04 stops until an AppArmor profile for it is loaded (docs/permissions.md, Linux).
// 'missing': a tool is not installed. 'blocked': both are, and bwrap cannot start. 'ok'
// otherwise, and on every other system, where nothing is started. bwrap is really started,
// once, around a command that does nothing, so ask once per app start and keep the answer.
export function shellSandbox({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'linux') return 'ok';
  const bwrap = findBin('bwrap', env);
  if (!bwrap || !findBin('socat', env)) return 'missing';
  const started = spawnSync(bwrap, ['--unshare-net', '--ro-bind', '/', '/', '/bin/sh', '-c', ':'], { env, stdio: 'ignore', timeout: 5000 });
  return started.status === 0 ? 'ok' : 'blocked';
}
// What the Permissions picker says about it: nothing where the sandbox works.
export function shellSandboxLine(state = shellSandbox()) {
  if (state === 'missing') return ['No OS sandbox here: commands ask you (Ask) or are reviewed (Approve for me).'];
  if (state === 'blocked') return ['The OS sandbox cannot start here, so commands ask you (Ask) or are reviewed (Approve for me). See https://github.com/ELU-Labs/elu/blob/main/docs/permissions.md#linux'];
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
export async function probeSandbox(config={}){
  const helper=findSandboxHelper(config);
  const root=tempFolder('elu-code-sandbox-proof-');
  const cwd=path.join(root,'worktree');mkdir(cwd);const home=path.join(root,'home');mkdir(home);
  mkdir(path.join(home,'.codex'));mkdir(path.join(home,'.config'));
  const outside=path.join(root,'outside');const server=net.createServer(socket=>socket.end('probe'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const script=`const fs=require('fs'),net=require('net');fs.writeFileSync('allowed','yes');let writeDenied=false;try{fs.writeFileSync(${JSON.stringify(outside)},'bad')}catch{writeDenied=true}const socket=net.connect(${server.address().port},'127.0.0.1');const done=(networkDenied)=>{socket.destroy();console.log(JSON.stringify({writeDenied,networkDenied}));};socket.once('error',()=>done(true));socket.once('connect',()=>done(false));socket.setTimeout(1500,()=>done(false));`;
  try{
    const run=await sandboxRun({cwd,helper,program:process.execPath,args:['-e',script,'elu-code-sandbox-probe'],logFile:path.join(root,'probe.log'),timeoutSeconds:10,env:{HOME:home,CODEX_HOME:path.join(home,'.codex'),XDG_CONFIG_HOME:path.join(home,'.config')}});
    let proof;try{proof=JSON.parse(fs.readFileSync(path.join(root,'probe.log'),'utf8').trim());}catch{}
    if(run.code!==0||run.timedOut||typeof proof?.writeDenied!=='boolean'||!proof?.networkDenied||fs.existsSync(outside))refuse('The sandbox helper failed its file-write or network test. Nothing was started.',{exitCode:run.code,proof:proof??null,diagnostic:fs.readFileSync(run.stderrFile,'utf8').slice(-1500)});
    return {available:true,working:true,writeDenied:proof.writeDenied,outsideWriteContained:true,networkDenied:true,requiresSignIn:false};
  }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
}

// This uses the vendor's sandbox helper. It never supplies a sandbox implementation.
// network: 'off' (every other check) or 'on' (checks of a Full access session).
export function sandboxArgs({ cwd, protectedPaths = [], writablePaths = ['.'], scratch, program, args = [], readPaths = [], deniedPaths=[], helper=findBin('codex'), network = 'off' }) {
  if (!['off', 'on'].includes(network)) refuse('Network is off or on.');
  const name = `elu_code_${crypto.randomBytes(8).toString('hex')}`;
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
  const entries = Object.entries(filesystem).map(([key, access]) => `${JSON.stringify(key)}=${JSON.stringify(access)}`).join(',');
  const profile = `{filesystem={${entries}},network={enabled=${network === 'on'}}}`;
  return ['sandbox', '-P', name, '-c', `permissions.${name}=${profile}`, '-c', 'features.hooks=false', '-c', 'shell_environment_policy.inherit="all"', '-c', 'shell_environment_policy.set.OPENSSL_CONF="/dev/null"', '--', program, ...args];
}
export async function sandboxRun({ cwd, protectedPaths, writablePaths, scratch, program, args, logFile, processFile, timeoutSeconds = 120, env: extraEnv = {}, readPaths, helper, config, signal, network = 'off' }) {
  const bin = helper??findSandboxHelper(config);
  assertNoCodexProjectConfig(cwd);
  const ownedScratch=!scratch;
  scratch ??= path.join(cwd,'.elu-code','tmp',crypto.randomUUID());
  noSymlinks(scratch); mkdir(scratch);
  const helperHome=path.join(scratch,'codex-home');mkdir(helperHome);
  const temporary=path.join(scratch,'tmp');mkdir(temporary);
  const globalConfig = path.join(scratch ?? cwd, 'global.npmrc');
  const env = { ...agentEnv(), ...extraEnv, CODEX_HOME:helperHome, OPENSSL_CONF: '/dev/null', npm_config_userconfig: '/dev/null', npm_config_globalconfig: globalConfig, npm_config_script_shell: '/bin/sh', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', TMPDIR:temporary, npm_config_cache: path.join(scratch, 'npm-cache') };
  try { return await runProcess({ bin, args: sandboxArgs({ cwd, protectedPaths, writablePaths, scratch, program, args, readPaths, helper:bin, network }), cwd, env, logFile, processFile, timeoutSeconds, signal }); }
  finally { if(ownedScratch)fs.rmSync(scratch,{recursive:true,force:true}); }
}
