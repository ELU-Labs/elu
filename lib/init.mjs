import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig,parseConfig } from './config.mjs';
import { stringifyYaml } from './yaml.mjs';
import { atomic, hash, mkdir, noSymlinks, readJson, refuse } from './util.mjs';
import { NOT_APPROVED, approveRemoved, approveSaved, trustedText } from './project-trust.mjs';
import { detect } from './detect.mjs';
import { event, tasks } from './state.mjs';
import { git, assertGitSafe,baseFile,head } from './git.mjs';
import { sameProcess } from './process.mjs';
import { checkPlace } from './modes.mjs';

const BLOCK = '<!-- elu-code:start -->\nUse the task policy in .elu-code/config.yaml. Leave policy and check definitions unchanged.\nOnly the owner may approve publishing.\n<!-- elu-code:end -->';
const IMPORT = '@.elu-code/config.yaml';
export function inferChecks(root){
  const file=path.join(root,'package.json');noSymlinks(file);
  if(fs.existsSync(file)){
    let pkg;try{pkg=JSON.parse(fs.readFileSync(file,'utf8'));}catch{refuse('package.json is not valid JSON. Fix it before init.');}
    const manager=/^(pnpm|yarn|bun)@/.exec(pkg.packageManager??'')?.[1]??'npm';
    return ['test','build'].filter(name=>typeof pkg.scripts?.[name]==='string'&&pkg.scripts[name].trim()).map(name=>({name:name==='test'?'tests':'build',command:name==='test'?[manager,'test']:[manager,'run',name]}));
  }
  if(fs.existsSync(path.join(root,'go.mod')))return[{name:'tests',command:['go','test','./...']}];
  if(fs.existsSync(path.join(root,'Cargo.toml')))return[{name:'tests',command:['cargo','test']}];
  if(['pytest.ini','conftest.py'].some(file=>fs.existsSync(path.join(root,file))))return[{name:'tests',command:['python3','-m','pytest']}];
  return [];
}
export function initPlan(repo, proposedConfig) {
  noSymlinks(path.join(repo.root, '.elu-code'));
  const manifestFile = path.join(repo.state, 'manifest.json');
  if (fs.existsSync(manifestFile)) {
    if (fs.existsSync(path.join(repo.root, '.elu-code/config.yaml'))) return { initialized: true, writes: [] };
    const previous = readJson(manifestFile);
    if (previous.version !== 1 || !Array.isArray(previous.files) || previous.files.some(file => !['.elu-code/config.yaml', 'AGENTS.md', 'CLAUDE.md'].includes(file.path))) refuse('Project setup history is invalid. Review it before restoring settings.');
    const committed = baseFile(repo.root, head(repo.root), '.elu-code/config.yaml', { optional: true });
    const config = committed ? parseConfig(committed) : proposedConfig ? parseConfig(stringifyYaml(proposedConfig)) : defaultConfig();
    if (!committed && !proposedConfig) config.checks = inferChecks(repo.root);
    const file = { path: '.elu-code/config.yaml', content: stringifyYaml(config), kind: 'file' };
    return { initialized: false, config, fromHistory: Boolean(committed), files: [file], keepFiles: previous.files.filter(row => row.path !== file.path), worktrees: previous.worktrees, writes: [path.join(repo.root, file.path), manifestFile], vendors: detect(repo.root).map(({ bin, ...value }) => value), message: 'Restore the missing project settings. Existing tasks and marked instructions are kept.' };
  }
  const existing=path.join(repo.root,'.elu-code/config.yaml');noSymlinks(existing);
  if(fs.existsSync(existing)){
    const text=fs.readFileSync(existing,'utf8');if(baseFile(repo.root,head(repo.root),'.elu-code/config.yaml',{optional:true})!==text)refuse('Commit the existing .elu-code/config.yaml before adopting it.');
    // A settings file that came with the folder is adopted only as the owner approved it on this machine.
    if(trustedText(repo.root,'config.yaml')!==text)refuse(NOT_APPROVED);
    return{initialized:false,adopted:true,adoptedHash:hash(text),config:parseConfig(text),files:[],writes:[repo.state],vendors:detect(repo.root).map(({bin,...row})=>row),message:'Use the committed configuration and create local run state.'};
  }
  const config = proposedConfig ? parseConfig(stringifyYaml(proposedConfig)) : defaultConfig();
  // The scripts found in the folder become checks, which run inside the check sandbox. The lead
  // gets no shell commands from them: roles.lead.commands holds only what the owner writes.
  if (!proposedConfig) config.checks=inferChecks(repo.root);
  const files = [{ path: '.elu-code/config.yaml', content: stringifyYaml(config), kind: 'file' }];
  for (const [file, addition] of [['AGENTS.md', BLOCK], ['CLAUDE.md', IMPORT]]) {
    const full = path.join(repo.root, file); noSymlinks(full);
    if(file==='CLAUDE.md'&&!fs.existsSync(full))continue;
    const before = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
    if (before.includes('<!-- elu-code:') || before.split(/\r?\n/).includes(IMPORT)) refuse(`${file} already contains an ELU block or import. Resolve it before init.`);
    const suffix = `${before && !before.endsWith('\n') ? '\n' : ''}${before ? '\n' : ''}${addition}\n`;
    files.push({ path: file, content: before + suffix, addition: suffix, created: !fs.existsSync(full), beforeHash: hash(before), kind: 'block' });
  }
  return { initialized: false, config, vendors: detect(repo.root).map(({ bin, ...value }) => value), files, writes: [...files.map((file) => path.join(repo.root, file.path)), `${repo.state}/`], message: config.checks.length?'Review the proposed checks before committing the configuration.':'No checks were found for this repository. Add checks to .elu-code/config.yaml before starting a task.' };
}
export function applyInit(repo, plan) {
  if (plan.initialized) return plan;
  if(plan.adopted&&hash(fs.readFileSync(path.join(repo.root,'.elu-code/config.yaml'),'utf8'))!==plan.adoptedHash)refuse('The committed configuration changed after the preview.');
  for (const file of plan.files) {
    const full = path.join(repo.root, file.path); noSymlinks(full);
    if (file.kind === 'block') {
      const current = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
      if (hash(current) !== file.beforeHash) refuse(`${file.path} changed since the write preview.`);
    } else if (fs.existsSync(full)) refuse(`${file.path} appeared since the write preview.`);
  }
  mkdir(repo.state);
  atomic(path.join(repo.state, 'manifest.json'), { version: 1, files: [...(plan.keepFiles ?? []), ...plan.files.map(({ content, ...file }) => ({ ...file, contentHash: hash(content) }))], worktrees: plan.worktrees ?? [] });
  // Settings ELU proposed and the owner confirmed are approved by this save. Ones
  // restored from the project's history are not: they are asked about like any other.
  for (const file of plan.files) { if (file.path === '.elu-code/config.yaml' && !plan.fromHistory) approveSaved(repo.root, 'config.yaml', file.content); atomic(path.join(repo.root, file.path), file.content); }
  event(repo, 'initialized');
  return { initialized: true,adopted:Boolean(plan.adopted), writes: plan.writes, vendors: plan.vendors, message: plan.adopted?'Local state is ready. The committed files are unchanged.':`${plan.message} Commit the generated files after review.` };
}
export function uninstallPlan(repo) {
  if(!fs.existsSync(path.join(repo.state,'manifest.json')) && !fs.existsSync(path.join(repo.state,'tasks')))return{installed:false,edits:[],worktrees:[],writes:[],message:'There is no local installation state to remove.'};
  const manifest = fs.existsSync(path.join(repo.state, 'manifest.json')) ? readJson(path.join(repo.state, 'manifest.json')) : { version: 1, files: [] };
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.some((f) => !['.elu-code/config.yaml', 'AGENTS.md', 'CLAUDE.md'].includes(f.path))) refuse('Uninstall manifest is invalid.');
  const active = tasks(repo).filter((task) => ['running', 'preparing'].includes(task.state));
  if (active.length) refuse('Stop or recover running tasks before uninstalling.');
  for (const file of fs.readdirSync(repo.state).filter((name) => /^task-[0-9]+\.lock$/.test(name) || name === 'view.lock')) {
    const owner = readJson(path.join(repo.state, file));
    if (sameProcess(owner)) refuse('A project view or task is still running. Close it before uninstalling.');
  }
  for (const task of tasks(repo)) {
    const file = path.join(repo.state, 'tasks', task.id, 'process.json');
    if (!fs.existsSync(file)) continue;
    const record = readJson(file);
    if (sameProcess(record)) refuse('A task process is still running. Use status --recover before uninstalling.');
  }
  // A session placed here edits the real checkout, which stays: it is not a worktree ELU made.
  const worktrees = tasks(repo).filter(task => task.kind !== 'conversation' && checkPlace(task.place ?? null, { mode: 'full' }).kind !== 'here').map((task) => task.worktree).filter((file) => fs.existsSync(file));
  if (worktrees.length) assertGitSafe(repo);
  for (const folder of worktrees) {
    noSymlinks(folder);
    if (git(folder, ['status', '--porcelain']).stdout.trim()) refuse(`Worktree has uncommitted changes: ${folder}. Save them before uninstalling.`);
  }
  const edits = [];
  for (const file of manifest.files) {
    const full = path.join(repo.root, file.path); noSymlinks(full);
    if (!fs.existsSync(full)) continue;
    const current = fs.readFileSync(full, 'utf8');
    if (file.kind === 'file') edits.push({ file: full, remove: true });
    else {
      if (!current.includes(file.addition) || current.indexOf(file.addition) !== current.lastIndexOf(file.addition)) refuse(`${file.path}'s marked addition changed. Remove it manually before uninstalling.`);
      const content = current.replace(file.addition, '');
      edits.push({ file: full, content, remove: file.created && !content });
    }
  }
  const trackedDeletions=edits.filter(edit=>edit.remove&&git(repo.root,['ls-files','--error-unmatch','--',path.relative(repo.root,edit.file)],{allowFailure:true}).status===0).map(edit=>path.relative(repo.root,edit.file));
  return { edits, worktrees,trackedDeletions, writes: [...edits.map((x) => x.file), ...worktrees, repo.state], message: `Removes generated files and local run history. Task branches and user edits outside marked additions are kept.${trackedDeletions.length?' Tracked files will be deleted; review and commit these removals.':''}` };
}
export function applyUninstall(repo, plan) {
  if(plan.installed===false)return{uninstalled:true,trackedDeletions:[],message:plan.message};
  // Removed from inside, so a worktree of another repository a session edited goes too.
  for (const folder of plan.worktrees) git(folder, ['worktree', 'remove', folder]);
  // Settings the owner removes here are gone by his word: none stays in force for the folder.
  for (const edit of plan.edits) { if (!edit.remove) { atomic(edit.file, edit.content); continue; } if (path.relative(repo.root, edit.file) === path.join('.elu-code', 'config.yaml')) approveRemoved(repo.root, 'config.yaml'); fs.unlinkSync(edit.file); }
  const configDir = path.join(repo.root, '.elu-code');
  if (fs.existsSync(configDir) && fs.readdirSync(configDir).length === 0) fs.rmdirSync(configDir);
  noSymlinks(repo.state); fs.rmSync(repo.state, { recursive: true });
  if (fs.existsSync(repo.worktrees) && fs.readdirSync(repo.worktrees).length === 0) fs.rmdirSync(repo.worktrees);
  return { uninstalled: true, keptBranches: true,trackedDeletions:plan.trackedDeletions,message:plan.message };
}
