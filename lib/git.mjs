import fs from 'node:fs';
import path from 'node:path';
import { execute, refuse, noSymlinks, hash, findBin } from './util.mjs';

export function git(root, args, options = {}) {
  return execute('git', ['--no-pager', '-C', root, ...args], { ...options, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...options.env } });
}
export function prepareGit(repo,root,args){
  if(!['add','worktree'].includes(args[0]))refuse('Only Git preparation can use an empty hook directory.');
  const hooks=path.join(repo.state,'empty-hooks');noSymlinks(hooks);fs.mkdirSync(hooks,{recursive:true,mode:0o700});
  if(fs.readdirSync(hooks).length)refuse('The Git preparation hook directory is not empty.');
  return git(root,['-c',`core.hooksPath=${hooks}`,...args]);
}
export function located(root, common) {
  return { root, common, state: path.join(common, 'elu-code'), worktrees: path.join(path.dirname(root), `${path.basename(root)}.elu-code`) };
}
export function repository(cwd) {
  const root = fs.realpathSync(git(cwd, ['rev-parse', '--show-toplevel']).stdout.trim());
  return located(root, fs.realpathSync(path.resolve(root, git(root, ['rev-parse', '--git-common-dir']).stdout.trim())));
}
// Views show the branch on every redraw. Reading HEAD avoids starting a Git process each time.
export function currentBranch(root) {
  try {
    const dot = path.join(root, '.git'), stat = fs.lstatSync(dot);
    const dir = stat.isDirectory() ? dot : stat.isFile() ? path.resolve(root, /^gitdir: (.+)$/m.exec(fs.readFileSync(dot, 'utf8'))?.[1].trim() ?? '') : null;
    const value = dir && fs.lstatSync(path.join(dir, 'HEAD')).isFile() ? fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim() : '';
    if (value.startsWith('ref: refs/heads/')) return value.slice(16);
    if (/^[0-9a-f]{40,64}$/.test(value)) return '';
  } catch { /* Unusual layouts fall back to Git. */ }
  return git(root, ['branch', '--show-current']).stdout.trim();
}
export function findRepository(cwd) {
  if (!findBin('git')) return null;
  const result = git(cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (result.status === 0) return repository(cwd);
  if (/not a git repository/i.test(result.stderr)) return null;
  refuse('The project history could not be read.', { reason: result.stderr.trim().slice(0, 1000) });
}
export function head(root) { return git(root, ['rev-parse', '--verify', 'HEAD']).stdout.trim(); }
// The commit a named local branch points at (a task placed on a branch bases on it).
export function branchHead(root, branch) {
  const result = git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true });
  if (result.status !== 0) refuse(`Branch not found: ${branch}`);
  return result.stdout.trim();
}
export function baseFile(root, base, file, { optional = false } = {}) {
  const r = git(root, ['show', `${base}:${file}`], { allowFailure: optional });
  return r.status === 0 ? r.stdout : null;
}
export function tracked(root, base) {
  return git(root, ['ls-tree', '-r', '-z', '--name-only', base]).stdout.split('\0').filter(Boolean);
}
function hookSource(repo, root) {
  const configured = git(root, ['config', '--path', '--get', 'core.hooksPath'], { allowFailure: true }).stdout.trim();
  const active = configured ? path.resolve(root, configured) : path.join(repo.common, 'hooks');
  const relative = path.relative(root, active);
  const inside = configured && !path.isAbsolute(configured) && relative && !relative.startsWith('..') && relative.split(path.sep)[0]!=='.git' && !path.isAbsolute(relative);
  const source = inside ? path.join(root, relative.split(path.sep)[0]) : active;
  const files = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    noSymlinks(dir);
    for (const name of fs.readdirSync(dir).sort()) {
      const file=path.join(dir,name); noSymlinks(file);const stat=fs.statSync(file);
      if(stat.isDirectory())walk(file);
      else if(stat.isFile()&&!name.endsWith('.sample'))files.push([path.relative(source,file),hash(fs.readFileSync(file)),stat.mode&0o777]);
    }
  }
  walk(source);
  return { source, active, relative: inside ? relative.split(path.sep)[0] : null, files, digest: hash(JSON.stringify({ configured, files })) };
}
export function assertGitSafe(repo, { worktree = repo.root, expectedHooks } = {}) {
  const fsmonitor = git(repo.root, ['config', '--get', 'core.fsmonitor'], { allowFailure: true }).stdout.trim();
  if (fsmonitor && fsmonitor !== 'false') refuse('Git filesystem monitors can execute programs. Disable the monitor before starting a checked task.');
  const source=hookSource(repo,worktree);
  const defaultGuard=path.join(repo.common,'hooks','pre-push');noSymlinks(defaultGuard);
  const hookDigest=hash(JSON.stringify([source.digest,fs.existsSync(defaultGuard)?hash(fs.readFileSync(defaultGuard)):null]));
  if(expectedHooks && hookDigest!==expectedHooks)refuse('Git hooks changed after the preview. Review the hooks before continuing.');
  const globalAttributes = git(worktree, ['config', '--path', '--get', 'core.attributesFile'], { allowFailure: true }).stdout.trim();
  const attrs = git(worktree, ['ls-files','-z', '--cached', '--others', '--exclude-standard', '--', '.gitattributes', '**/.gitattributes', '.gitmodules']).stdout.split('\0').filter(Boolean);
  if(attrs.includes('.gitmodules')||fs.existsSync(path.join(worktree,'.gitmodules')))refuse('Submodules are not supported for checked tasks.');
  const defaults=['GIT_ATTR_SYSTEM','GIT_ATTR_GLOBAL'].map(name=>git(worktree,['var',name],{allowFailure:true})).filter(row=>row.status===0).map(row=>row.stdout.trim());
  for(const file of new Set([path.join(repo.common,'info/attributes'),path.join(worktree,'.gitattributes'),...attrs.map(name=>path.join(worktree,name)),...defaults,...(globalAttributes?[path.resolve(worktree,globalAttributes)]:[])])){
    if(!fs.existsSync(file))continue;if(file.startsWith(worktree+path.sep))noSymlinks(file);
    for(const line of fs.readFileSync(file,'utf8').split('\n')){
      if(/^\s*(?:#|$)/.test(line))continue;
      const tokens=line.match(/"(?:[^"\\]|\\.)*"|\S+/g)??[];
      for(const token of tokens.slice(1)){
        const match=/^(filter|diff|merge)=(.+)$/.exec(token);if(!match)continue;
        const [,kind,name]=match;if(kind==='merge'&&['text','binary','union'].includes(name))continue;
        const keys=kind==='filter'?['clean','smudge','process']:kind==='diff'?['command','textconv']:['driver'];
        if(keys.some(key=>git(worktree,['config','--get',`${kind}.${name}.${key}`],{allowFailure:true}).stdout.trim()))refuse(`Git attribute ${kind}=${name} enables an executable driver.`);
      }
    }
  }
  return { hooks:source.files.map(([file])=>path.join(source.source,file)),hookDigest,protectedPaths:source.relative?[source.relative]:[],hookSource:source };
}
export function assertTaskGitSafe(repo,task){
  assertGitSafe(repo,{expectedHooks:task.hookDigest});
  return assertGitSafe(repo,{worktree:task.worktree,expectedHooks:task.worktreeHookDigest??task.hookDigest});
}
export function snapshotHooks(repo, task, helper=findBin('codex')) {
  const inspected=assertGitSafe(repo,{expectedHooks:task.hookDigest});
  assertTaskGitSafe(repo,task);
  const folder=path.join(repo.state,'tasks',task.id,'hooks');noSymlinks(folder);fs.mkdirSync(folder,{recursive:true,mode:0o700});
  // Keep push guards, including the common-directory guard when a hook manager is configured.
  const sources=[inspected.hookSource];
  const defaultGuard=path.join(repo.common,'hooks','pre-push');
  const guards=[...new Set([...sources.map(s=>path.join(s.active,'pre-push')),defaultGuard])].filter(file=>fs.existsSync(file));
  if(guards.length&&!helper)refuse('A Codex sandbox helper is required to run pre-push guards safely.');
  const copied=[];
  for(const [index,guard] of guards.entries()){
    noSymlinks(guard);const source=sources.find(s=>guard.startsWith(s.source+path.sep));const from=source?.source??path.dirname(guard);const to=path.join(folder,`source-${index}`);
    fs.cpSync(from,to,{recursive:true,filter:file=>!file.endsWith('.sample')});
    copied.push(path.join(to,path.relative(from,guard)));
  }
  const dispatcher=path.join(folder,'pre-push');
  fs.writeFileSync(dispatcher,`#!${process.execPath}\nimport fs from 'node:fs';import os from 'node:os';import path from 'node:path';import{spawnSync}from'node:child_process';import{sandboxArgs}from ${JSON.stringify(new URL('./sandbox.mjs',import.meta.url).href)};import{agentEnv,killGroup}from ${JSON.stringify(new URL('./process.mjs',import.meta.url).href)};const input=fs.readFileSync(0);for(const hook of ${JSON.stringify(copied)}){const scratch=fs.mkdtempSync(path.join(${JSON.stringify(folder)},'tmp-'));let result;try{fs.mkdirSync(path.join(scratch,'codex-home'),{mode:0o700});fs.mkdirSync(path.join(scratch,'tmp'),{mode:0o700});const args=sandboxArgs({helper:${JSON.stringify(helper)},cwd:process.cwd(),writablePaths:[],scratch,program:hook,args:process.argv.slice(2),readPaths:[${JSON.stringify(repo.common)},path.join(process.cwd(),'.git')],deniedPaths:['.ssh','.aws','.config','.claude','.codex','.netrc','.npmrc'].map(name=>path.join(os.homedir(),name))});result=spawnSync(${JSON.stringify(helper)},args,{input,env:{...agentEnv(),CODEX_HOME:path.join(scratch,'codex-home'),TMPDIR:path.join(scratch,'tmp'),GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'},stdio:['pipe','inherit','inherit'],detached:true,timeout:120000});if(result.pid)killGroup(result.pid,'SIGKILL');}finally{fs.rmSync(scratch,{recursive:true,force:true});}if(result.status!==0)process.exit(result.status??1);}\n`,{mode:0o700});
  return folder;
}
export function hooksSnapshotDigest(folder) {
  noSymlinks(folder);const rows=[];
  function visit(dir){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name);noSymlinks(file);const stat=fs.statSync(file);if(stat.isDirectory())visit(file);else rows.push([path.relative(folder,file),stat.mode&0o777,hash(fs.readFileSync(file))]);}}
  visit(folder);return hash(JSON.stringify(rows));
}
export function assertPublishingHooks(repo,task){
  const expected=path.join(repo.state,'tasks',task.id,'hooks');
  if(task.hooksDirectory!==expected||!task.hooksSnapshotDigest||hooksSnapshotDigest(expected)!==task.hooksSnapshotDigest)refuse('The saved hooks are missing or changed. Start a new task before publishing.');
  assertTaskGitSafe(repo,task);
  return expected;
}
// A task's changes against its base, for every place. In the owner's real
// checkout (place here) the ignored files were there before the task, so they are not
// counted; a task worktree starts clean, so anything ignored there is the task's output.
export function taskChanges(task) { return changed(task.worktree, task.base, { ignored: task.place?.kind !== 'here' }); }
export function changed(root, base, { ignored: withIgnored = true } = {}) {
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
  const names = git(root, [...args, '--name-only', '-z', base, '--']).stdout.split('\0').filter(Boolean);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean);
  const ignored = withIgnored ? git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean) : [];
  const paths = [...new Set([...names, ...untracked, ...ignored])].sort();
  const counts = git(root, [...args, '--numstat', '-z', base, '--']).stdout.split('\0').filter(Boolean);
  let lines = 0;
  let binary = false;
  for (const row of counts) {
    const [added, removed] = row.split('\t');
    if (added === '-' || removed === '-') binary = true;
    else lines += Number(added) + Number(removed);
  }
  const entries = [];
  for (const file of paths) {
    const full = path.join(root, file);
    let bytes = null;
    let mode = null;
    try {
      noSymlinks(full);
      const stat = fs.statSync(full);
      if (!stat.isFile()) refuse(`Changed path is not a regular file: ${file}`);
      if (stat.size > 4 * 1024 * 1024) refuse(`Changed file is too large to inspect: ${file}`);
      bytes = fs.readFileSync(full); mode = stat.mode & 0o777;
      if (untracked.includes(file) || ignored.includes(file)) {
        if (bytes.includes(0)) binary = true;
        else lines += bytes.length ? bytes.toString('utf8').split('\n').length - (bytes.at(-1) === 10 ? 1 : 0) : 0;
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    entries.push([file, bytes ? hash(bytes) : null, mode]);
  }
  return { paths, lines, binary, ignored, digest: hash(JSON.stringify(entries)) };
}
export function diff(root, base) {
  const value = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', base, '--']).stdout;
  return value;
}
