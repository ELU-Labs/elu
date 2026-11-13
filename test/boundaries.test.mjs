import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, git, fakeClis, cli } from './helpers.mjs';
import { protectedPath } from '../lib/policy.mjs';
import { changed, repository, assertGitSafe, snapshotHooks, hooksSnapshotDigest, assertPublishingHooks } from '../lib/git.mjs';
import { spawnSync } from 'node:child_process';
import {findBin}from'../lib/util.mjs';

test('check and package configuration across supported toolchains is protected', () => {
  for (const name of ['.yarnrc.yml','.pnpmfile.cjs','pnpm-workspace.yaml','bunfig.toml','.npmrc','.mocharc.json','vitest.workspace.ts','ava.config.js','karma.conf.js','.nycrc.json','pyproject.toml','setup.cfg','tox.ini','pytest.ini','conftest.py','Makefile','.husky/pre-push','.githooks/pre-commit']) {
    assert.equal(protectedPath(name), true, name);
    assert.equal(protectedPath(`nested/${name}`), true, name);
  }
});
test('ignored task output cannot be absent from the evidence digest', (t) => {
  const {root}=project(t); fs.writeFileSync(path.join(root,'.gitignore'),'generated/\ndist/\n');git(root,['add','.']);git(root,['commit','-m','Ignore generated output']);
  const base=git(root,['rev-parse','HEAD']);const before=changed(root,base);
  fs.mkdirSync(path.join(root,'generated'));fs.writeFileSync(path.join(root,'generated/result.js'),'export default true;\n');
  const after=changed(root,base);assert.notEqual(after.digest,before.digest);assert.deepEqual(after.ignored,['generated/result.js']);
  // Build output in an ignored dist folder is not a change: it is never published, and the digest stays.
  fs.mkdirSync(path.join(root,'dist'));fs.writeFileSync(path.join(root,'dist/result.js'),'export default true;\n');
  const built=changed(root,base);assert.equal(built.digest,after.digest);assert.deepEqual(built.ignored,['generated/result.js']);assert.deepEqual(built.trees,['dist/']);
});
test('relative hooks in each worktree are inspected and changes block publication', (t) => {
  const {root,parent}=project(t);fs.mkdirSync(path.join(root,'.githooks'));fs.writeFileSync(path.join(root,'.githooks/pre-push'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  git(root,['config','core.hooksPath','.githooks']);git(root,['add','.']);git(root,['commit','-m','Add hooks']);
  const repo=repository(root);const before=assertGitSafe(repo);assert.ok(before.hookDigest);assert.ok(before.protectedPaths.includes('.githooks'));
  const worktree=path.join(parent,'task');git(root,['worktree','add','-b','sam/test',worktree]);
  fs.writeFileSync(path.join(worktree,'.githooks/pre-push'),'#!/bin/sh\nexit 91\n');
  assert.throws(()=>assertGitSafe(repo,{worktree,expectedHooks:before.hookDigest}),/hook.*changed/i);
});
test('publishing uses an immutable absolute copy of the existing push guard', {skip:!findBin('codex')}, (t) => {
  const {root}=project(t);const repo=repository(root);const guard=path.join(repo.common,'hooks/pre-push');
  fs.writeFileSync(guard,'#!/bin/sh\nexit 17\n',{mode:0o755});
  const task={id:'1',worktree:root,hookDigest:assertGitSafe(repo).hookDigest};
  task.hooksDirectory=snapshotHooks(repo,task);task.hooksSnapshotDigest=hooksSnapshotDigest(task.hooksDirectory);
  assert.equal(assertPublishingHooks(repo,task),task.hooksDirectory);
  const guardRun=spawnSync(path.join(task.hooksDirectory,'pre-push'),[],{cwd:root,input:'',encoding:'utf8'});assert.equal(guardRun.status,17,guardRun.stderr);
  fs.appendFileSync(path.join(task.hooksDirectory,'pre-push'),'\n// changed\n');
  assert.throws(()=>assertPublishingHooks(repo,task),/saved hooks.*changed/);
});
test('a push hook cannot run edited source with rights outside the sandbox',{skip:!findBin('codex')},(t)=>{
 const {root,parent}=project(t);const repo=repository(root);fs.mkdirSync(path.join(root,'.githooks'));fs.writeFileSync(path.join(root,'.githooks/pre-push'),'#!/bin/sh\nnode src/guard.mjs\n',{mode:0o755});fs.writeFileSync(path.join(root,'src/guard.mjs'),'process.exit(0);\n');git(root,['config','core.hooksPath','.githooks']);git(root,['add','.']);git(root,['commit','-m','Add a source hook']);
 const task={id:'1',worktree:root,hookDigest:assertGitSafe(repo).hookDigest};task.hooksDirectory=snapshotHooks(repo,task);task.hooksSnapshotDigest=hooksSnapshotDigest(task.hooksDirectory);
 const outside=path.join(parent,'outside');fs.writeFileSync(path.join(root,'src/guard.mjs'),`import fs from 'node:fs';fs.writeSync(2,'hook-write-attempted\\n');fs.writeFileSync(${JSON.stringify(outside)},'bad');\n`);
 assertPublishingHooks(repo,task);const run=spawnSync(path.join(task.hooksDirectory,'pre-push'),[],{cwd:root,input:'',encoding:'utf8'});assert.match(run.stderr,/hook-write-attempted/);assert.equal(fs.existsSync(outside),false);
});
test('generated Husky launchers are preserved without treating a fresh worktree as edited',{skip:!findBin('codex')},(t)=>{
 const {root,parent}=project(t);fs.mkdirSync(path.join(root,'.husky/_'),{recursive:true});fs.writeFileSync(path.join(root,'.gitignore'),'.husky/_/\n');fs.writeFileSync(path.join(root,'.husky/pre-push'),'#!/bin/sh\nexit 0\n');fs.writeFileSync(path.join(root,'.husky/_/pre-push'),'#!/bin/sh\nexit 17\n',{mode:0o755});git(root,['config','core.hooksPath','.husky/_']);git(root,['add','.']);git(root,['commit','-m','Configure generated hooks']);
 const repo=repository(root),worktree=path.join(parent,'task'),hookDigest=assertGitSafe(repo).hookDigest;git(root,['worktree','add','-b','sam/test',worktree]);const task={id:'1',worktree,hookDigest,worktreeHookDigest:assertGitSafe(repo,{worktree}).hookDigest};
 task.hooksDirectory=snapshotHooks(repo,task);task.hooksSnapshotDigest=hooksSnapshotDigest(task.hooksDirectory);assertPublishingHooks(repo,task);
 const guardRun=spawnSync(path.join(task.hooksDirectory,'pre-push'),[],{cwd:worktree,input:'',encoding:'utf8'});assert.equal(guardRun.status,17,guardRun.stderr);
 fs.appendFileSync(path.join(worktree,'.husky/pre-push'),'\nexit 9\n');assert.throws(()=>assertPublishingHooks(repo,task),/hooks changed/);
});
test('Git preparation does not execute project checkout or index hooks',(t)=>{
 const p=project(t),f=fakeClis(p.parent),marker=path.join(p.parent,'hook-ran');assert.equal(cli(p.root,['init','--yes'],f.env).status,0);fs.mkdirSync(path.join(p.root,'.githooks'));
 for(const name of['post-checkout','post-index-change'])fs.writeFileSync(path.join(p.root,'.githooks',name),`#!${process.execPath}\nimport fs from'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'bad');\n`,{mode:0o755});
 git(p.root,['config','core.hooksPath','.githooks']);git(p.root,['add','.']);git(p.root,['commit','-m','Configure hooks']);if(fs.existsSync(marker))fs.unlinkSync(marker);
 const run=cli(p.root,['run','Normalize coupons','--yes'],f.env);assert.equal(run.json.state,'ready',run.stdout);assert.equal(fs.existsSync(marker),false);assert.equal(git(p.root,['config','core.hooksPath']),'.githooks');
});
