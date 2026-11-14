import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, cli, git } from './helpers.mjs';
import { findBin } from '../lib/util.mjs';
import { repository } from '../lib/git.mjs';
import { readTask } from '../lib/state.mjs';
import { preparePublish, publish, destination } from '../lib/publish.mjs';

function publishingFixture(t, { ignore = null, guard = false } = {}) {
  const p = project(t); const fake = fakeClis(p.parent);
  assert.equal(cli(p.root, ['init', '--yes'], fake.env).status, 0);
  if (ignore) fs.writeFileSync(path.join(p.root, '.gitignore'), ignore);
  if (guard) { fs.mkdirSync(path.join(p.root, '.githooks')); fs.writeFileSync(path.join(p.root, '.githooks/pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); git(p.root, ['config', 'core.hooksPath', '.githooks']); }
  git(p.root, ['add', '.']); git(p.root, ['commit', '-m', 'Configure checks']);
  const r = cli(p.root, ['run', 'Normalize coupons', '--yes'], fake.env); assert.equal(r.json.state, 'ready', r.stdout);
  git(p.root, ['remote', 'add', 'origin', 'https://github.com/example/sample.git']);
  const actualGit = findBin('git'); const calls = path.join(p.parent, 'publication.jsonl');
  const wrapper = `#!${process.execPath}\nimport fs from 'node:fs';import {spawnSync} from 'node:child_process';const args=process.argv.slice(2);if(args.includes('push')){fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({kind:'push',args})+'\\n');process.exit(0);}const r=spawnSync(${JSON.stringify(actualGit)},args,{stdio:'inherit'});process.exit(r.status??1);\n`;
  fs.writeFileSync(path.join(fake.dir, 'git'), wrapper, { mode: 0o755 });
  const gh = `#!${process.execPath}\nimport fs from 'node:fs';import {spawnSync} from 'node:child_process';const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({kind:'gh',args})+'\\n');if(args[0]==='repo')console.log(JSON.stringify({nameWithOwner:'example/sample',defaultBranchRef:{name:'main'},url:'https://github.com/example/sample'}));else if(args[1]==='list')console.log('[]');else if(args[1]==='view'){const r=spawnSync(${JSON.stringify(actualGit)},['-C',${JSON.stringify(p.root)},'rev-parse','feat/task-1'],{encoding:'utf8'});console.log(JSON.stringify({url:'https://github.com/example/sample/pull/1',isDraft:true,headRefOid:r.stdout.trim()}));}else console.log('https://github.com/example/sample/pull/1');\n`;
  fs.writeFileSync(path.join(fake.dir, 'gh'), gh, { mode: 0o755 });
  const previous = process.env.PATH; process.env.PATH = fake.env.PATH; t.after(() => { process.env.PATH = previous; });
  const repo = repository(p.root); return { ...p, repo, task: readTask(repo, '1'), calls };
}
test('publication needs exact approval, sends no logs, and pushes only the task branch', async (t) => {
  const p = publishingFixture(t); const preview = await preparePublish(p.repo, p.task);
  assert.equal(preview.needsConfirmation, true); assert.match(preview.commit, /^[0-9a-f]{40}$/); assert.equal(preview.destination.ref, 'refs/heads/feat/task-1');
  await assert.rejects(() => publish(p.repo, p.task, 'wrong'), /approval/);
  assert.equal(fs.readFileSync(p.calls, 'utf8').includes('"kind":"push"'), false);
  const done = await publish(p.repo, p.task, preview.confirmationId); assert.equal(done.pushed, true); assert.equal(done.merged, false); assert.equal(done.deployed, false);
  const calls = fs.readFileSync(p.calls, 'utf8').trim().split('\n').map(JSON.parse);
  const pushes = calls.filter((c) => c.kind === 'push'); assert.equal(pushes.length, 1);
  assert.ok(pushes[0].args.includes(`${preview.commit}:refs/heads/feat/task-1`));
  assert.ok(pushes[0].args.includes('--no-follow-tags'));
  assert.ok(pushes[0].args.some((arg)=>arg.startsWith('core.hooksPath=')&&path.isAbsolute(arg.slice('core.hooksPath='.length))));
  assert.match(preview.message,/hooks/i);
  assert.ok(calls.some((c) => c.kind === 'gh' && c.args.includes('--draft') && c.args.includes('--body-file')));
  assert.equal(git(p.root, ['branch', '--show-current']), 'main');
  await assert.rejects(() => publish(p.repo, p.task, preview.confirmationId), /approval/);
});
test("the push guards run as the session's mode is when it publishes: with no sandbox in Full access, in one otherwise", async (t) => {
  const p = publishingFixture(t, { guard: true }), dispatcher = () => fs.readFileSync(path.join(p.task.hooksDirectory, 'pre-push'), 'utf8');
  assert.match(dispatcher(), /sandbox=\{"kind":"codex"/, 'kept in a sandbox when the task started');
  p.task.permissions = 'full'; await preparePublish(p.repo, p.task);
  assert.equal(p.task.hooksFull, true); assert.match(dispatcher(), /sandbox=null/); assert.equal(readTask(p.repo, '1').hooksFull, true);
  p.task.permissions = 'ask'; await preparePublish(p.repo, p.task);
  assert.equal(p.task.hooksFull, false); assert.match(dispatcher(), /sandbox=\{"kind":"codex"/);
});
test('a title change or a default-branch destination invalidates publication', async (t) => {
  const p = publishingFixture(t); const preview = await preparePublish(p.repo, p.task);
  p.task.goal = 'Different title'; await assert.rejects(() => publish(p.repo, p.task, preview.confirmationId), /changed/);
  assert.throws(() => destination(p.repo, { ...p.task, branch: 'main' }), /default branch/);
  assert.equal(fs.readFileSync(p.calls, 'utf8').includes('"kind":"push"'), false);
});
test('an installed node_modules in the task worktree keeps the checks current and is never published', async (t) => {
  const p = publishingFixture(t, { ignore: 'node_modules/\n' });
  const modules = path.join(p.task.worktree, 'node_modules');
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true }); fs.mkdirSync(path.join(modules, 'pkg'));
  fs.writeFileSync(path.join(modules, 'pkg/cli.js'), '#!/usr/bin/env node\n'); fs.symlinkSync('../pkg/cli.js', path.join(modules, '.bin/pkg'));
  fs.writeFileSync(path.join(modules, 'pkg/big.bin'), Buffer.alloc(5 * 1024 * 1024));
  const preview = await preparePublish(p.repo, p.task);
  assert.deepEqual(git(p.task.worktree, ['show', '--name-only', '--format=', preview.commit]).split('\n'), ['src/coupon.mjs']);
  assert.equal(git(p.task.worktree, ['status', '--porcelain']), '');
});
