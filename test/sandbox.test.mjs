import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { sandboxRun,probeSandbox,findSandboxHelper } from '../lib/sandbox.mjs';
import { findBin } from '../lib/util.mjs';
import { temp, git } from './helpers.mjs';

test('the installed sandbox refuses forbidden actions without model calls', { skip: !findBin('codex') }, async (t) => {
  const root = temp(t); const cwd = path.join(root, 'worktree'); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(cwd, '.elu-code')); fs.writeFileSync(path.join(cwd, '.elu-code/config.yaml'), 'sealed\n');
  fs.mkdirSync(path.join(root, '.ssh')); fs.writeFileSync(path.join(root, '.ssh/sentinel'), 'synthetic sentinel, not a credential\n');
  git(cwd, ['init', '--initial-branch=main']);
  const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'untouched\n');
  const server = net.createServer((socket) => socket.end('forbidden'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const cases = [
    ...['/tmp','/private/tmp','/var/tmp','/private/var/tmp'].filter((dir)=>fs.existsSync(dir)).map((dir)=>[`shared-temp-${dir.replaceAll('/','-')}`,`require('fs').writeFileSync(${JSON.stringify(path.join(dir,`elu-code-probe-${process.pid}`))},'bad')`]),
    ['outside-write', `require('fs').writeFileSync(${JSON.stringify(outside)},'bad')`],
    ['outside-read', `require('fs').readFileSync(${JSON.stringify(outside)})`],
    ['ssh-read', `require('fs').readFileSync(${JSON.stringify(path.join(root, '.ssh/sentinel'))})`],
    ['check-edit', `require('fs').writeFileSync('.elu-code/config.yaml','bad')`],
    ['git-edit', `require('fs').writeFileSync('.git/config','bad')`],
    ['network', `const s=require('net').connect(${server.address().port},'127.0.0.1');s.on('error',()=>process.exit(7));s.on('connect',()=>process.exit(0))`],
    ['planted-curl', `const r=require('child_process').spawnSync('/usr/bin/curl',['--connect-timeout','1','http://127.0.0.1:${server.address().port}']);process.exit(r.status===0?0:8)`],
  ];
  for (const [name, script] of cases) {
    const r = await sandboxRun({ cwd, protectedPaths: ['.elu-code', '.git'], program: process.execPath, args: ['-e', script], logFile: path.join(root, `${name}.log`), timeoutSeconds: 10 });
    if(name!=='outside-write')assert.notEqual(r.code, 0, `${name} escaped the sandbox`);else assert.equal(fs.readFileSync(outside,'utf8'),'untouched\n'); assert.equal(r.timedOut, false, name);
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched\n'); assert.equal(fs.readFileSync(path.join(cwd, '.elu-code/config.yaml'), 'utf8'), 'sealed\n');
  const positive = await sandboxRun({ cwd, protectedPaths: ['.elu-code', '.git'], program: process.execPath, args: ['-e', "require('fs').writeFileSync('allowed.txt','yes')"], logFile: path.join(root, 'positive.log'), timeoutSeconds: 10 });
  assert.equal(positive.code, 0, fs.readFileSync(positive.stderrFile, 'utf8')); assert.equal(fs.readFileSync(path.join(cwd, 'allowed.txt'), 'utf8'), 'yes');
});
test('the helper proves write and network denials with an empty sign-in directory',{skip:!findBin('codex')},async()=>{
  const result=await probeSandbox();assert.equal(result.working,true);assert.equal(result.requiresSignIn,false);
  assert.equal(findSandboxHelper({}, {PATH:'',ELU_CODE_SANDBOX_HELPER:findBin('codex')}),findBin('codex'));
});
test('a worktree inside shared temp cannot write a sibling but has private temp space', {skip:!findBin('codex')}, async(t)=>{
  const parent=fs.realpathSync(fs.mkdtempSync('/tmp/elu-code-sandbox-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const cwd=path.join(parent,'worktree');fs.mkdirSync(cwd);git(cwd,['init','--initial-branch=main']);
  const sibling=path.join(parent,'sibling');
  const denied=await sandboxRun({cwd,program:process.execPath,args:['-e',`require('fs').writeFileSync(${JSON.stringify(sibling)},'bad')`],logFile:path.join(parent,'sibling.log')});
  assert.notEqual(denied.code,0);assert.equal(fs.existsSync(sibling),false);
  const allowed=await sandboxRun({cwd,program:process.execPath,args:['-e',"require('fs').writeFileSync(require('path').join(process.env.TMPDIR,'owned'),'yes');require('fs').writeFileSync('owned.txt','yes')"],logFile:path.join(parent,'private-temp.log')});
  assert.equal(allowed.code,0,fs.readFileSync(allowed.stderrFile,'utf8'));assert.equal(fs.readFileSync(path.join(cwd,'owned.txt'),'utf8'),'yes');
});
test('a read-only task can read its source but only write private temp', {skip:!findBin('codex')}, async(t)=>{
  const parent=temp(t),cwd=path.join(parent,'worktree');fs.mkdirSync(cwd);
  const source=path.join(cwd,'source.txt');fs.writeFileSync(source,'read-only source');
  const outside=path.join(parent,'outside');fs.writeFileSync(outside,'untouched');
  const shared=['/tmp','/private/tmp','/var/tmp','/private/var/tmp'].filter(folder=>fs.existsSync(folder)).map(folder=>path.join(folder,`elu-code-read-only-${process.pid}`));
  t.after(()=>{for(const file of shared)fs.rmSync(file,{force:true});});
  const script=`const fs=require('fs'),path=require('path');if(fs.readFileSync('source.txt','utf8')!=='read-only source')process.exit(4);let denied=false;try{fs.writeFileSync(${JSON.stringify(source)},'bad')}catch{denied=true}if(!denied)process.exit(5);for(const file of ${JSON.stringify([outside,...shared])}){try{fs.writeFileSync(file,'bad')}catch{}}fs.writeFileSync(path.join(process.env.TMPDIR,'owned'),'yes');`;
  const run=await sandboxRun({cwd,writablePaths:[],program:process.execPath,args:['-e',script],logFile:path.join(parent,'read-only.log')});
  assert.equal(run.code,0,fs.readFileSync(run.stderrFile,'utf8'));assert.equal(fs.readFileSync(source,'utf8'),'read-only source');assert.equal(fs.readFileSync(outside,'utf8'),'untouched');for(const file of shared)assert.equal(fs.existsSync(file),false,file);
});
