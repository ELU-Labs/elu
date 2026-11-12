import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import{pathToFileURL}from'node:url';
import{project,fakeClis,cli,git,command,CLI,approveProjectFiles}from'./helpers.mjs';import{repository,assertGitSafe}from'../lib/git.mjs';import{readTask,saveTask,taskPlace}from'../lib/state.mjs';
import{findBin}from'../lib/util.mjs';
function setup(t){const p=project(t),f=fakeClis(p.parent);assert.equal(cli(p.root,['init','--yes'],f.env).status,0);git(p.root,['add','.']);git(p.root,['commit','-m','Configure checks']);return{...p,...f};}
test('a fresh clone adopts committed configuration without changing tracked files',(t)=>{
 const p=setup(t),clone=path.join(p.parent,'clone');git(p.root,['clone',p.root,clone]);
 // The clone's settings came with it. The command line asks nothing, so init waits until the owner has approved them in the app.
 const refused=cli(clone,['init','--yes'],p.env);assert.equal(refused.status,1,refused.stdout);assert.match(refused.json.message,/^This project's settings \(\.elu-code\/config\.yaml\) are not approved on this machine\./);
 approveProjectFiles(clone,p.env);
 const result=cli(clone,['init','--yes'],p.env);assert.equal(result.status,0,result.stdout);assert.equal(result.json.adopted,true);assert.equal(git(clone,['status','--porcelain']),'');
});
test('init leaves an absent CLAUDE.md absent and infers checks from actual scripts',(t)=>{
 const p=project(t),f=fakeClis(p.parent);assert.equal(cli(p.root,['init','--yes'],f.env).status,0);assert.equal(fs.existsSync(path.join(p.root,'CLAUDE.md')),false);
 const second=project(t),other=fakeClis(second.parent);fs.unlinkSync(path.join(second.root,'package.json'));const result=cli(second.root,['init','--dry-run'],other.env);assert.deepEqual(result.json.config.checks,[]);assert.match(result.json.message,/no checks/i);
});
test('uninstall without local state succeeds and tracked deletions are described',(t)=>{
 const p=project(t),f=fakeClis(p.parent);assert.equal(cli(p.root,['uninstall','--yes'],f.env).status,0);
 const q=setup(t),result=cli(q.root,['uninstall','--yes'],q.env);assert.equal(result.status,0,result.stdout);assert.ok(result.json.trackedDeletions.includes('.elu-code/config.yaml'));assert.match(result.json.message,/tracked|commit/i);
});
test('uninstall leaves the checkout a here session used, and removes a worktree in another repository',(t)=>{
 const p=setup(t),repo=repository(p.root),base=git(p.root,['rev-parse','HEAD']),record=(id,extra)=>saveTask(repo,{id,goal:'Trim coupon codes',state:'ready',base,createdAt:new Date().toISOString(),runs:[],reviews:[],messages:[],sessions:{},activeRole:'lead',...extra});
 // Session 1 ran here, in the real checkout, which holds a file of the owner's that was never committed.
 record('1',{worktree:p.root,branch:null,place:{kind:'here'}});fs.writeFileSync(path.join(p.root,'notes.txt'),'mine\n');
 // Session 2 edited another repository, in a worktree beside it.
 const other=path.join(p.parent,'other');fs.mkdirSync(other);git(other,['init','--initial-branch=main']);git(other,['config','user.name','Test Owner']);git(other,['config','user.email','owner@example.invalid']);git(other,['commit','--allow-empty','-m','Start']);
 const place=taskPlace(repo,'2',other);git(other,['worktree','add','-b',place.branch,place.worktree]);record('2',{repository:other,...place,base:git(other,['rev-parse','HEAD'])});
 const result=cli(p.root,['uninstall','--yes'],p.env);assert.equal(result.status,0,result.stdout);
 assert.equal(fs.readFileSync(path.join(p.root,'notes.txt'),'utf8'),'mine\n');assert.equal(fs.existsSync(place.worktree),false);
 assert.equal(git(other,['worktree','list','--porcelain']).split('\n').filter(line=>line.startsWith('worktree ')).length,1);assert.equal(fs.existsSync(repo.state),false);
});
test('run dry-run validates setup without a task, worktree, or agent execution',(t)=>{
 const p=setup(t);const result=cli(p.root,['run','Normalize coupons','--dry-run','--yes'],p.env);assert.equal(result.status,0,result.stdout);assert.equal(result.json.preview,true);
 assert.equal(fs.existsSync(path.join(repository(p.root).state,'tasks')),false);const calls=fs.readFileSync(p.calls,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.some(x=>x.args.includes('-p')||x.args[0]==='exec'),false);
});
test('task ids skip branches left by uninstall and session ids agree',(t)=>{
 const p=setup(t);git(p.root,['branch','feat/task-1']);const result=cli(p.root,['run','Normalize coupons','--yes'],p.env);assert.equal(result.status,0,result.stdout);assert.equal(result.json.id,'2');
 const task=readTask(repository(p.root),'2');assert.equal(task.runs.findLast(x=>x.role==='bot:reviewer').session,task.sessions['bot:reviewer'].id);
});
test('a failed worktree add cleans only the new clean worktree',(t)=>{
 const p=setup(t),actual=findBin('git');fs.writeFileSync(path.join(p.dir,'git'),`#!${process.execPath}\nimport{spawnSync}from'node:child_process';const args=process.argv.slice(2);const r=spawnSync(${JSON.stringify(actual)},args,{stdio:'inherit'});process.exit(args.includes('worktree')&&args.includes('add')?1:r.status??1);\n`,{mode:0o755});
 const result=cli(p.root,['run','Normalize coupons','--yes'],p.env);assert.equal(result.status,1);assert.equal(fs.existsSync(path.join(repository(p.root).worktrees,'1')),false);
});
test('a failed worktree add preserves an unrelated folder created at the destination',(t)=>{
 const p=setup(t),actual=findBin('git');fs.writeFileSync(path.join(p.dir,'git'),`#!${process.execPath}\nimport fs from'node:fs';import path from'node:path';import{spawnSync}from'node:child_process';const args=process.argv.slice(2);if(args.includes('worktree')&&args.includes('add')){const folder=args[args.indexOf('add')+3];fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'owner.txt'),'keep this work');process.exit(1);}const r=spawnSync(${JSON.stringify(actual)},args,{stdio:'inherit'});process.exit(r.status??1);\n`,{mode:0o755});
 const result=cli(p.root,['run','Normalize coupons','--yes'],p.env);assert.equal(result.status,1);assert.equal(fs.readFileSync(path.join(repository(p.root).worktrees,'1','owner.txt'),'utf8'),'keep this work');
});
test('safe attributes and hook managers are accepted while executable drivers are refused',(t)=>{
 const p=project(t);const file=path.join(p.root,'.gitattributes');fs.writeFileSync(file,'* text=auto eol=lf\n*.png binary\narchive export-ignore linguist-generated\n');git(p.root,['add','.']);git(p.root,['commit','-m','Set line endings']);
 assert.doesNotThrow(()=>assertGitSafe(repository(p.root)));fs.writeFileSync(file,'* filter=unsafe\n');git(p.root,['config','filter.unsafe.clean','touch forbidden']);assert.throws(()=>assertGitSafe(repository(p.root)),/driver|filter/i);
});
test('JSON commands emit exactly one document and human output is plain text',(t)=>{
 const p=setup(t);for(const args of [['init'],['run','Preview','--dry-run'],['status'],['open','999'],['check','999'],['policy','show'],['uninstall','--dry-run']]){const result=cli(p.root,args,p.env);assert.doesNotThrow(()=>JSON.parse(result.stdout),args.join(' '));assert.equal(result.stderr,'',args.join(' '));}
 const status=command(process.execPath,[CLI,'status'],p.root,p.env);assert.match(status.stdout,/^No tasks yet\.$/m);assert.doesNotMatch(status.stdout,/^\s*\{/);
 const error=command(process.execPath,[CLI,'unknown'],p.root,p.env);assert.equal(error.status,1);assert.doesNotMatch(error.stderr,/\{\}/);
 const fresh=project(t),f=fakeClis(fresh.parent);const preview=command(process.execPath,[CLI,'init'],fresh.root,f.env);assert.match(preview.stdout,/--yes/);
});
test('EOF at confirmation declines without crashing',(t)=>{
 const p=project(t),f=fakeClis(p.parent);const script=`process.stdin.isTTY=true;const{main}=await import(${JSON.stringify(pathToFileURL(CLI).href)});const result=await main(['init']);console.log(JSON.stringify(result));`;
 const result=command(process.execPath,['--input-type=module','-e',script],p.root,f.env);assert.equal(result.status,0,result.stderr);assert.equal(fs.existsSync(path.join(p.root,'.elu-code')),false);
});
test('uninstall also stops the peer daemon, which runs while the machine is on a team',(t)=>{
 const q=setup(t),peer=path.join(q.env.XDG_CONFIG_HOME,'elu-code','peer');fs.mkdirSync(peer,{recursive:true});
 const version=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
 // A daemon's heartbeat, with this process standing in for it.
 fs.writeFileSync(path.join(peer,'state.json'),JSON.stringify({running:true,stopped:false,pid:process.pid,version,at:new Date().toISOString(),teams:[]}));
 const result=cli(q.root,['uninstall','--yes'],q.env);assert.equal(result.status,0,result.stdout);assert.equal(result.json.peerStopped,true);assert.match(result.json.message,/ The peer daemon stopped\.$/);
 const folder=path.join(peer,'commands');assert.deepEqual(fs.readdirSync(folder).map(name=>JSON.parse(fs.readFileSync(path.join(folder,name),'utf8')).type),['shutdown']);
 // With none running, uninstall says nothing about it.
 const p=setup(t),again=cli(p.root,['uninstall','--yes'],p.env);assert.equal(again.status,0,again.stdout);assert.equal(again.json.peerStopped,undefined);
});
