import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { temp, git, fakeClis } from './helpers.mjs';
import { projectFolder, createFolderPlan, createFolder, historyPlan, createHistory, pendingRequests, saveRequest, addToRequest, updateRequest } from '../lib/workspace.mjs';
import { ProjectController, projectSnapshot, registerProject, dashboardSnapshot } from '../lib/projects.mjs';
import { initPlan, applyInit } from '../lib/init.mjs';
import { personalDirectory } from '../lib/usage.mjs';

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function fixture(t) {
  const parent = temp(t), fake = fakeClis(parent), root = path.join(parent, 'project'); fs.mkdirSync(root);
  environment(t, { ...fake.env, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  return { parent, root, fake };
}

test('project folders do not need Git and creating one does not initialize it', t => {
  const f = fixture(t), target = path.join(f.parent, 'new project');
  const plan = createFolderPlan(target); assert.equal(fs.existsSync(target), false);
  const folder = createFolder(plan); assert.equal(folder.common, null); assert.deepEqual(fs.readdirSync(target), []);
  assert.throws(() => createFolder(plan), /already exists/);
  // A project is a name and settings; even home works. The disk root never does.
  assert.equal(projectFolder(os.homedir()).root, fs.realpathSync(os.homedir()));
  assert.throws(() => projectFolder(path.parse(f.root).root), /entire disk/);
});

test('initial history respects ignores, requires an unchanged preview, and commits only locally', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'source.mjs'), 'export const count = 1;\n');
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.env\n'); fs.writeFileSync(path.join(f.root, '.env'), 'SYNTHETIC_PRIVATE_VALUE');
  const folder = projectFolder(f.root), first = historyPlan(folder);
  assert.deepEqual(first.files.map(file => file.path), ['.gitignore', 'source.mjs']);
  assert.equal(fs.existsSync(path.join(f.root, '.git')), false);
  fs.appendFileSync(path.join(f.root, 'source.mjs'), '// owner edit\n');
  assert.throws(() => createHistory(first), /changed after/); assert.equal(fs.existsSync(path.join(f.root, '.git')), false);
  const repo = createHistory(historyPlan(folder));
  assert.equal(git(f.root, ['branch', '--show-current']), 'main');
  assert.deepEqual(git(f.root, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n'), ['.gitignore', 'source.mjs']);
  assert.equal(git(f.root, ['remote']), ''); assert.equal(historyPlan(repo), null);
  assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8'), 'SYNTHETIC_PRIVATE_VALUE');
});

// The owner's message of any length is queued whole: ELU sets no limit of its own on it.
test('a request of any length is queued whole', t => {
  const f = fixture(t), long = 'Fix the coupon codes. '.repeat(5000);
  assert.ok(long.length > 16000);
  assert.equal(saveRequest(f.root, long, null, { state: 'queued' }).goal, long);
  assert.throws(() => saveRequest(f.root, '  ', null, { state: 'queued' }), /Enter a request\./);
});

test('initial history takes a file over 4 MiB like any other', t => {
  const f = fixture(t), big = Buffer.alloc(5 * 1024 * 1024, 'a');
  fs.writeFileSync(path.join(f.root, 'data.bin'), big); fs.writeFileSync(path.join(f.root, 'source.mjs'), 'export const count = 1;\n');
  const plan = historyPlan(projectFolder(f.root));
  assert.deepEqual(plan.files.map(file => file.path), ['data.bin', 'source.mjs']);
  assert.equal(plan.files[0].hash, crypto.createHash('sha256').update(big).digest('hex'));
  createHistory(plan);
  assert.deepEqual(git(f.root, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n'), ['data.bin', 'source.mjs']);
});

test('initial history refuses an unignored credential-shaped file or an outside symlink', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, '.env'), 'SYNTHETIC_PRIVATE_VALUE');
  assert.throws(() => historyPlan(projectFolder(f.root)), /Keep .env out of history/);
  fs.unlinkSync(path.join(f.root, '.env'));
  const outside = path.join(f.parent, 'outside.txt'); fs.writeFileSync(outside, 'keep');
  fs.symlinkSync(outside, path.join(f.root, 'linked.txt'));
  assert.throws(() => historyPlan(projectFolder(f.root)), /symbolic link/);
  assert.equal(fs.existsSync(path.join(f.root, '.git')), false); assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});

test('an initial checkpoint refuses executable attributes in untracked nested folders', t => {
  const f = fixture(t); git(f.root, ['init', '--initial-branch=main']);
  const marker = path.join(f.parent, 'filter-ran');
  git(f.root, ['config', 'filter.planted.clean', `touch ${marker}`]);
  fs.mkdirSync(path.join(f.root, 'src')); fs.writeFileSync(path.join(f.root, 'src/.gitattributes'), '*.txt filter=planted\n');
  fs.writeFileSync(path.join(f.root, 'src/value.txt'), 'keep\n');
  assert.throws(() => createHistory(historyPlan(projectFolder(f.root))), /executable driver/);
  assert.equal(fs.existsSync(marker), false); assert.equal(fs.readFileSync(path.join(f.root, 'src/value.txt'), 'utf8'), 'keep\n');
});

test('saved requests are personal, survive a new controller, and stay out of project files', t => {
  const f = fixture(t), folder = projectFolder(f.root), controller = new ProjectController(folder);
  const request = controller.queue('Do not lose my request');
  controller.queue(request.goal, request.id, { state: 'blocked', reason: 'Project is not ready yet.' });
  const reopened = new ProjectController(folder).snapshot();
  assert.equal(reopened.requests[0].goal, request.goal); assert.equal(reopened.requests[0].reason, 'Project is not ready yet.');
  assert.deepEqual(fs.readdirSync(f.root), []); assert.equal(pendingRequests(f.root).length, 1);
  const saved = path.join(personalDirectory(), 'requests');
  assert.equal(fs.statSync(path.join(saved, fs.readdirSync(saved)[0])).mode & 0o777, 0o600);
  controller.cancelRequest(request.id); assert.equal(projectSnapshot(folder).requests.length, 0);
});

test('a message is added to a request only while that request still waits to start', t => {
  const f = fixture(t), first = saveRequest(f.root, 'First', null, { state: 'queued' });
  assert.equal(addToRequest(f.root, first.id, 'Second').goal, 'First\n\nSecond'); assert.deepEqual(pendingRequests(f.root).map(row => [row.id, row.goal, row.state]), [[first.id, 'First\n\nSecond', 'queued']]);
  // However long the two are together: ELU sets no length of its own for a message.
  const long = 'x'.repeat(40000);
  assert.equal(addToRequest(f.root, first.id, long).goal, `First\n\nSecond\n\n${long}`);
  // Once the conductor has taken the request it is not added.
  for (const state of ['starting', 'running', 'blocked']) { updateRequest(f.root, first.id, { state }); assert.equal(addToRequest(f.root, first.id, 'Third'), null, state); }
  assert.equal(addToRequest(f.root, 'request-none', 'Third'), null); assert.equal(pendingRequests(f.root)[0].goal, `First\n\nSecond\n\n${long}`);
});

test('the dashboard can read a new project before history or settings exist', t => {
  const f = fixture(t), folder = projectFolder(f.root); registerProject(folder);
  saveRequest(folder.root, 'Start this project', null, { state: 'blocked', reason: 'Waiting on setup.' });
  const registry = path.join(personalDirectory(), 'projects.json'), before = fs.readFileSync(registry, 'utf8');
  const view = dashboardSnapshot(); assert.equal(view.projects[0].initialized, false); assert.equal(view.projects[0].requests.length, 1);
  assert.equal(fs.readFileSync(registry, 'utf8'), before); assert.deepEqual(fs.readdirSync(f.root), []);
  assert.equal(fs.existsSync(f.fake.calls), false);
});

test('missing settings can be restored without losing task history or instruction ownership', async t => {
  const f = fixture(t), repo = createHistory(historyPlan(projectFolder(f.root)));
  applyInit(repo, await initPlan(repo));
  const instructions = fs.readFileSync(path.join(f.root, 'AGENTS.md'), 'utf8');
  fs.unlinkSync(path.join(f.root, '.elu-code/config.yaml'));
  fs.writeFileSync(path.join(repo.state, 'owner-note.txt'), 'keep history');
  const plan = await initPlan(repo); assert.equal(plan.initialized, false); assert.equal(plan.config.checks.length, 0); applyInit(repo, plan);
  assert.equal(fs.readFileSync(path.join(f.root, 'AGENTS.md'), 'utf8'), instructions);
  assert.equal(fs.readFileSync(path.join(repo.state, 'owner-note.txt'), 'utf8'), 'keep history');
  assert.ok(fs.existsSync(path.join(f.root, '.elu-code/config.yaml')));
});
