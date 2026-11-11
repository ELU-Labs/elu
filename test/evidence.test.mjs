import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, git } from './helpers.mjs';
import { structuralChecks } from '../lib/checks.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { atomic } from '../lib/util.mjs';
import { assertGitSafe, repository } from '../lib/git.mjs';

test('evidence counts new lines, refuses binary files, and enforces declared paths', (t) => {
  const { root } = project(t); const task = { worktree: root, base: git(root, ['rev-parse', 'HEAD']) }; const config = defaultConfig();
  config.paths = ['src']; config.limits.changedLines = 2;
  fs.writeFileSync(path.join(root, 'new.txt'), 'one\ntwo\nthree\n');
  let r = structuralChecks(task, config);
  assert.equal(r.change.lines, 3); assert.equal(r.results.find((row) => row.name === 'changed-lines').status, 'failed');
  assert.equal(r.results.find((row) => row.name === 'declared-paths').status, 'failed');
  fs.writeFileSync(path.join(root, 'new.txt'), Buffer.from([0, 1, 2]));
  r = structuralChecks(task, config); assert.equal(r.change.binary, true);
});
test('deleted tests, new dependencies, scripts, and lockfiles fail independent checks', (t) => {
  const { root } = project(t); const task = { worktree: root, base: git(root, ['rev-parse', 'HEAD']) };
  fs.unlinkSync(path.join(root, 'test/coupon.test.mjs'));
  const file = path.join(root, 'package.json'); const pkg = JSON.parse(fs.readFileSync(file));
  pkg.dependencies = { example: '1.0.0' }; pkg.scripts.test = 'true'; fs.writeFileSync(file, JSON.stringify(pkg));
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  const r = structuralChecks(task, defaultConfig());
  for (const name of ['no-deleted-tests', 'no-dependency-changes', 'unchanged-scripts', 'protected-paths']) assert.equal(r.results.find((row) => row.name === name).status, 'failed', name);
});
test('symlink changes cannot make inspection read an outside file', (t) => {
  const { root, parent } = project(t); const outside = path.join(parent, 'outside'); fs.writeFileSync(outside, 'synthetic');
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => structuralChecks({ worktree: root, base: git(root, ['rev-parse', 'HEAD']) }, defaultConfig()), /symbolic link/);
});
test('existing instruction file permissions survive an atomic write', (t) => {
  const { root } = project(t); const file = path.join(root, 'instructions.txt'); fs.writeFileSync(file, 'owner', { mode: 0o640 });
  atomic(file, 'owner\naddition\n'); assert.equal(fs.statSync(file).mode & 0o777, 0o640);
});
test('untrusted Git hooks and monitors refuse runs while push guards remain intact', (t) => {
  const { root } = project(t); const repo = repository(root); const hook = path.join(repo.common, 'hooks/pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); assert.ok(assertGitSafe(repo).hooks.includes(hook));
  fs.unlinkSync(hook); const guard = path.join(repo.common, 'hooks/pre-push'); fs.writeFileSync(guard, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.doesNotThrow(() => assertGitSafe(repo)); assert.equal(fs.readFileSync(guard, 'utf8'), '#!/bin/sh\nexit 1\n');
  git(root, ['config', 'core.fsmonitor', '/example/untrusted']); assert.throws(() => assertGitSafe(repo), /monitors/);
});
