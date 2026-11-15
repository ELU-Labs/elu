import fs from 'node:fs';
import path from 'node:path';
import { execute, fileFacts, refuse, noSymlinks, onDiskPath, hash, findBin, within } from './util.mjs';
import { usableSandbox } from './sandbox.mjs';
import { turnClock, guardStoppedLine } from './turn-limits.mjs';

// Git's output is read whole, however long: a diff of any size reaches the reviewer. A caller
// that shows output to the owner may pass a smaller maxBuffer of its own (taskPatch).
export function git(root, args, options = {}) {
  return execute('git', ['--no-pager', '-C', root, ...args], { maxBuffer: Infinity, ...options, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...options.env } });
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
  // A hooks folder outside the project is the owner's, named by his Git configuration, and is
  // read as it is on disk. One in the project is taken as named: a link there is refused.
  const named = configured ? path.resolve(root, configured) : path.join(repo.common, 'hooks'), active = within(root, named) ? named : onDiskPath(named);
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
// The second line of the dispatcher snapshotHooks writes. Guards whose dispatcher has another
// mark there, or none (0.1.25 and earlier, which closed the home's secrets under HOME's name
// only), are kept again before the next push (lib/publish.mjs), so they run as this version
// runs them. Raise it when the dispatcher changes what it closes.
const GUARDS_MARK = '// ELU pre-push guards, version 2';
// Whether guards a session kept are from such a dispatcher. Ones that are missing or changed
// are not: publishing refuses them (assertPublishingHooks).
export function guardsOutdated(task) {
  try { return !fs.readFileSync(path.join(task.hooksDirectory, 'pre-push'), 'utf8').split('\n').includes(GUARDS_MARK) && hooksSnapshotDigest(task.hooksDirectory) === task.hooksSnapshotDigest; }
  catch { return false; }
}
// The pre-push guards run in the sandbox this computer has (lib/sandbox.mjs), and a repository
// that has one is refused, plainly, where there is none. full: the session has Full access, so
// they run as Git runs them, with no sandbox.
export function snapshotHooks(repo, task, { full = false } = {}) {
  const inspected=assertGitSafe(repo,{expectedHooks:task.hookDigest});
  assertTaskGitSafe(repo,task);
  const folder=path.join(repo.state,'tasks',task.id,'hooks');noSymlinks(folder);fs.mkdirSync(folder,{recursive:true,mode:0o700});
  // Keep push guards, including the common-directory guard when a hook manager is configured.
  const sources=[inspected.hookSource];
  const defaultGuard=path.join(repo.common,'hooks','pre-push');
  const guards=[...new Set([...sources.map(s=>path.join(s.active,'pre-push')),defaultGuard])].filter(file=>fs.existsSync(file));
  const sandbox=guards.length&&!full?usableSandbox({what:"the project's pre-push hooks",then:'try again'}):null;
  const copied=[];
  for(const [index,guard] of guards.entries()){
    noSymlinks(guard);const source=sources.find(s=>guard.startsWith(s.source+path.sep));const from=source?.source??path.dirname(guard);const to=path.join(folder,`source-${index}`);
    fs.cpSync(from,to,{recursive:true,filter:file=>!file.endsWith('.sample')});
    copied.push(path.join(to,path.relative(from,guard)));
  }
  // A guard has no time limit: it runs for as long as it prints, and one that prints nothing
  // for the quiet limit is stopped and says so (lib/turn-limits.mjs). While the guards run,
  // the file ELU_GUARD_MARK names exists, so the push's own quiet clock waits (lib/publish.mjs).
  // Guards kept with another quiet limit, or by a version that stopped them after two
  // minutes, are kept again before the next push. A guard that fails, with a non-zero exit,
  // leaves its exit and the end of what it printed beside that file (ELU_GUARD_MARK.failed), so
  // the push can say why in the guard's own words.
  const quiet=turnClock.quietSeconds;task.hooksQuietSeconds=quiet;
  const dispatcher=path.join(folder,'pre-push');
  fs.writeFileSync(dispatcher,[`#!${process.execPath}`,GUARDS_MARK,
    `import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import{spawn}from'node:child_process';import{sandboxCommand}from ${JSON.stringify(new URL('./sandbox.mjs',import.meta.url).href)};import{agentEnv,killGroup}from ${JSON.stringify(new URL('./process.mjs',import.meta.url).href)};import{homeNames}from ${JSON.stringify(new URL('./util.mjs',import.meta.url).href)};`,
    `const input=fs.readFileSync(0),sandbox=${JSON.stringify(sandbox)},quiet=${quiet*1000},said=${JSON.stringify(guardStoppedLine({quietSeconds:quiet}))},mark=process.env.ELU_GUARD_MARK;`,
    `for(const out of [process.stdout,process.stderr])out.on('error',()=>{});let pending=0,idle=null;const write=(out,chunk)=>{pending++;out.write(chunk,()=>{if(!--pending&&idle)idle();});},flushed=()=>pending?new Promise(resolve=>{idle=resolve;}):Promise.resolve();`,
    `const run=(bin,args,options)=>new Promise(done=>{const child=spawn(bin,args,{...options,stdio:['pipe','pipe','pipe'],detached:true});let last=Date.now(),status=null,stopped=false,ended=false,tail='';`,
    `for(const [from,to] of [[child.stdout,process.stdout],[child.stderr,process.stderr]])from.on('data',chunk=>{last=Date.now();tail=(tail+chunk).slice(-8000);write(to,chunk);});child.stdin.on('error',()=>{});child.stdin.end(input);`,
    `const end=()=>{if(ended)return;ended=true;clearInterval(timer);killGroup(child.pid,'SIGKILL');if(stopped)write(process.stderr,said+'\\n');flushed().then(()=>done({status:stopped?1:status??1,stopped,tail}));};`,
    `const timer=setInterval(()=>{if(Date.now()-last<quiet)return;if(status===null)stopped=true;end();},Math.min(1000,quiet));`,
    `child.on('exit',code=>{status=code??1;killGroup(child.pid,'SIGKILL');});child.on('close',end);child.on('error',()=>{status=1;end();});});`,
    `const finish=code=>{if(mark)fs.rmSync(mark,{force:true});process.exit(code);};if(mark)fs.writeFileSync(mark,'');`,
    `for(const hook of ${JSON.stringify(copied)}){const scratch=fs.mkdtempSync(path.join(${JSON.stringify(folder)},'tmp-'));let result;try{fs.mkdirSync(path.join(scratch,'codex-home'),{mode:0o700});fs.mkdirSync(path.join(scratch,'tmp'),{mode:0o700});const env={...(sandbox?{...agentEnv(),CODEX_HOME:path.join(scratch,'codex-home'),TMPDIR:path.join(scratch,'tmp')}:agentEnv(process.env,[],{},{full:true})),GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'};const command=sandbox?sandboxCommand({sandbox,env,cwd:process.cwd(),writablePaths:[],scratch,program:hook,args:process.argv.slice(2),readPaths:[${JSON.stringify(repo.common)},path.join(process.cwd(),'.git')],deniedPaths:homeNames().flatMap(home=>['.ssh','.aws','.config','.claude','.codex','.netrc','.npmrc'].map(name=>path.join(home,name)))}):{bin:hook,args:process.argv.slice(2),env};result=await run(command.bin,command.args,{env:command.env});}finally{fs.rmSync(scratch,{recursive:true,force:true});}if(result.status!==0){if(mark&&!result.stopped)fs.writeFileSync(mark+'.failed',JSON.stringify({status:result.status,tail:result.tail}));finish(result.status);}}`,
    'finish(0);',''].join('\n'),{mode:0o700});
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
export function taskChanges(task) { return changed(task.worktree, task.base, { ignored: task.place?.kind !== 'here', exclude: notesSpec(task) }); }
// A project's context (.elu-code/context.md) holds the owner's notes, and ELU itself adds to it
// while sessions work (lib/project-learnings.mjs). A task that works in the real checkout (place
// here) never counts it as its change: it is never checked, reviewed, committed or published,
// and it never makes the task's commit or checks look out of date. Elsewhere a task works in a
// worktree of its own, which ELU never writes it into.
export const PROJECT_NOTES = Object.freeze([':(exclude,glob)**/.elu-code/context.md']);
export const notesSpec = task => task?.place?.kind === 'here' ? PROJECT_NOTES : [];
// What installing and building leave behind: dependency folders, build output and caches.
// Inside a task worktree they are ignored, so they are never published, and a task that
// runs npm install, pip install, its build or its tests to check its edit makes them. Such a
// folder is not a change when Git ignores the folder itself (a pattern matches it or a folder
// above it): it is listed as one folder, and nothing in it is opened, hashed or counted, so it
// never slows a session or stops it on a link inside. A folder of one of these names that is
// not ignored itself, such as a tracked src/build, is an ordinary folder: an ignored file in
// it, such as src/build/.env, is listed and checked like any other.
export const OUTPUT_FOLDERS = Object.freeze(['node_modules', 'vendor', '.venv', 'venv', '__pycache__', '.eggs', '.next', '.nuxt', '.svelte-kit', 'dist', 'build', 'coverage', 'htmlcov', '.nyc_output', '.pytest_cache', '.hypothesis', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.turbo', '.parcel-cache', '.cache', '.gradle', 'target']);
// A folder name of build output: one of those, or a Python package's metadata (pkg.egg-info).
export const outputName = name => OUTPUT_FOLDERS.includes(name) || /^[^/]+\.egg-info$/.test(name);
// Files the same tools leave, which are not changes when ignored: coverage data (.coverage,
// and .coverage.host.1234 from parallel runs) and editor and compiler caches.
const OUTPUT_FILES = /(^|\/)(?:\.DS_Store|\.eslintcache|[^/]+\.tsbuildinfo|\.coverage(?:\.[^/]+)?)$/;
// The folders a path lies in whose names are of build output, outermost first, each with a
// slash. A path that ends in a slash is a folder Git listed, and is among them by its name.
export function outputFolders(file) {
  const parts = file.split('/'), found = [];
  for (let at = 0; at < parts.length - 1; at++) if (outputName(parts[at])) found.push(`${parts.slice(0, at + 1).join('/')}/`);
  return found;
}
// Which of these folders (each with a slash) Git ignores itself, by a pattern that matches it
// or a folder above it. One Git call for all of them.
function ignoredFolders(root, folders) {
  if (!folders.length) return new Set();
  const result = git(root, ['check-ignore', '--stdin', '-z'], { input: `${folders.map(folder => folder.slice(0, -1)).join('\0')}\0`, allowFailure: true });
  // check-ignore exits 1 when it matched none of them.
  if (result.error || ![0, 1].includes(result.status)) refuse('git could not finish.', { exitCode: result.status, reason: result.error?.message ?? result.stderr.trim().slice(0, 1000) });
  return new Set(result.stdout.split('\0').filter(Boolean).map(folder => `${folder}/`));
}
// An ignored file outside those folders is still the task's output: it is listed, read and
// hashed as before, up to this many. One that is a link or not a plain file is never followed:
// it is listed in unfollowed and never stops the session. One larger than HASHED_MAX is known
// to the digest by its size and time, so it is not read again at each look; a reviewer still
// gets it whole.
const IGNORED_FILES_MAX = 2000, HASHED_MAX = 4 * 1024 * 1024;
function ignoredOutput(root, listed) {
  const files = new Set(), unfollowed = [], trees = new Set(), known = new Map(), walked = new Set();
  let more = null;
  const add = file => { if (files.has(file)) return true; if (files.size >= IGNORED_FILES_MAX) { more ??= file; return false; } files.add(file); return true; };
  // A folder Git listed whole (every file in it is ignored) is walked here, without following
  // links or other repositories' .git folders. A folder in it with a build-output name is
  // left for the next round, which asks Git whether that folder is ignored itself.
  const walk = (dir, next) => {
    if (walked.has(dir)) return true;
    walked.add(dir);
    let names;
    try { names = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { unfollowed.push(dir); return true; }
    for (const entry of names.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = `${dir}${entry.name}`;
      if (entry.isDirectory()) {
        if (outputName(entry.name)) next.push(`${file}/`);
        else if (entry.name === '.git') unfollowed.push(`${file}/`);
        else if (!walk(`${file}/`, next)) return false;
      } else if (!OUTPUT_FILES.test(file) && !add(file)) return false;
    }
    return true;
  };
  // Each round asks Git once about the build-output folders its paths lie in; a path in one
  // that is ignored is part of that folder, and any other is walked or listed.
  let pending = listed;
  while (pending.length) {
    const asked = [...new Set(pending.flatMap(outputFolders))].filter(folder => !known.has(folder));
    const yes = ignoredFolders(root, asked);
    for (const folder of asked) known.set(folder, yes.has(folder));
    const next = [];
    for (const file of pending) {
      const tree = outputFolders(file).find(folder => known.get(folder));
      if (tree) trees.add(tree);
      else if (file.endsWith('/')) walk(file, next);
      else if (!OUTPUT_FILES.test(file)) add(file);
    }
    pending = next;
  }
  return { files: [...files], unfollowed, trees: [...trees].sort(), more };
}
// exclude: pathspecs of files that are never a change here (notesSpec).
export function changed(root, base, { ignored: withIgnored = true, exclude = [] } = {}) {
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
  const names = git(root, [...args, '--name-only', '-z', base, '--', ...exclude]).stdout.split('\0').filter(Boolean);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...exclude]).stdout.split('\0').filter(Boolean);
  const listed = withIgnored ? git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', '--', ...exclude]).stdout.split('\0').filter(Boolean) : [];
  const output = ignoredOutput(root, listed), skip = new Set(untracked);
  const ignored = output.files.filter(file => !skip.has(file));
  // More ignored files than are read: the folder of the first one left is listed as one path,
  // so the task still shows ignored output, and the digest says that it does.
  if (output.more) { const folder = path.posix.dirname(output.more), mark = folder === '.' ? output.more : `${folder}/`; ignored.push(mark); output.unfollowed.push(mark); }
  const unread = new Set(output.unfollowed), others = new Set([...untracked, ...ignored]), ignoredSet = new Set(ignored);
  const paths = [...new Set([...names, ...untracked, ...ignored])].sort();
  const counts = git(root, [...args, '--numstat', '-z', base, '--', ...exclude]).stdout.split('\0').filter(Boolean);
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
    if (unread.has(file)) { entries.push([file, 'not-followed', null]); continue; }
    // An ignored path is never a refusal: a link or a file that is not plain is not followed,
    // and a large one is known by its size and time.
    if (ignoredSet.has(file)) {
      let stat = null;
      try { stat = fs.lstatSync(full); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (stat && !stat.isFile()) { unread.add(file); entries.push([file, stat.isSymbolicLink() ? 'link' : 'not-a-file', stat.mode & 0o777]); continue; }
      if (stat && stat.size > HASHED_MAX) { entries.push([file, `size:${stat.size}:${stat.mtimeMs}`, stat.mode & 0o777]); continue; }
    }
    // A changed file of any size is read, in parts: ELU sets no size limit of its own.
    let digest = null;
    let mode = null;
    try {
      noSymlinks(full);
      const stat = fs.statSync(full);
      if (!stat.isFile()) refuse(`Changed path is not a regular file: ${file}`);
      const facts = fileFacts(full); digest = facts.hash; mode = stat.mode & 0o777;
      if (others.has(file)) {
        if (facts.binary) binary = true;
        else lines += facts.lines;
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    entries.push([file, digest, mode]);
  }
  // trees: the output folders there are, which are not changes. unfollowed: ignored paths
  // that were listed but not read. Neither is ever published (publishable).
  return { paths, lines, binary, ignored, trees: output.trees, unfollowed: [...unread].sort(), digest: hash(JSON.stringify(entries)) };
}
// The paths a task's commit takes: its changes, less anything ignored, which Git would refuse
// to add and which is never the task's to publish.
export function publishable(change) { const ignored = new Set(change.ignored); return change.paths.filter(file => !ignored.has(file)); }
export function diff(root, base, { exclude = [] } = {}) {
  const value = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', base, '--', ...exclude]).stdout;
  return value;
}
