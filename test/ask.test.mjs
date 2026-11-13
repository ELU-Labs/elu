import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp, project, fakeClis, git, autoApprove } from './helpers.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { tasks, taskDir } from '../lib/state.mjs';
import { pinnedConfig } from '../lib/checks.mjs';
import { uninstallPlan, applyUninstall } from '../lib/init.mjs';

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function plain(t, mode) {
  const parent = temp(t), fake = fakeClis(parent, { mode }), root = path.join(parent, 'project'); fs.mkdirSync(root);
  environment(t, { ...fake.env, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  return { parent, root, fake, controller: autoApprove(new ProjectController(projectFolder(root))) };
}

test('a simple question responds immediately without Git, checks, settings, or a commit', async t => {
  const f = plain(t, 'answer');
  const run = f.controller.ask('testing if this works and if I can add multi agent');
  assert.equal(f.controller.snapshot().tasks[0].state, 'running');
  const task = await run.finished;
  assert.equal(task.state, 'answered'); assert.match(task.result.summary, /multiple agents/);
  assert.deepEqual(fs.readdirSync(f.root), []); assert.equal(task.runs.length, 1);
  assert.equal(fs.existsSync(path.join(f.parent, 'project.elu-code')), false);
  const calls = fs.readFileSync(f.fake.calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call => call.args[0] === 'sandbox').length, 0);
  const lead = calls.find(call => call.args.includes('-p')); assert.ok(lead);
  assert.doesNotMatch(lead.args[lead.args.indexOf('--tools') + 1], /Write|Edit|Bash/);
  const again = await f.controller.ask('Can I give one a security role?', task.id).finished;
  assert.equal(again.state, 'answered'); assert.equal(again.sessions.lead.id, task.sessions.lead.id);
});

test('questions work in an existing dirty project with no configured checks', async t => {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer' }); environment(t, fake.env);
  fs.writeFileSync(path.join(p.root, 'owner.txt'), 'keep this work');
  const before = git(p.root, ['status', '--porcelain']), head = git(p.root, ['rev-parse', 'HEAD']);
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); controller.draftConfig.checks = [];
  const task = await controller.ask('Can I add a reviewer?').finished;
  assert.equal(task.state, 'answered'); assert.equal(git(p.root, ['status', '--porcelain']), before);
  assert.equal(git(p.root, ['rev-parse', 'HEAD']), head); assert.equal(fs.existsSync(path.join(p.root, '.elu-code')), false);
});

test('a coding request prepares its workspace automatically and reports missing verification honestly', async t => {
  const f = plain(t, 'scaffold');
  const task = await f.controller.ask('Create a coupon normalizer and its tests').finished;
  assert.equal(task.mode, 'automatic'); assert.equal(task.state, 'unverified'); assert.equal(task.reviewStatus, 'passed');
  assert.ok(task.evidence.results.some(row => row.name === 'project-checks' && row.status === 'not-configured'));
  assert.equal(fs.existsSync(path.join(task.worktree, 'src/coupon.mjs')), true);
  assert.equal(fs.existsSync(path.join(f.root, '.elu-code')), false); assert.equal(fs.existsSync(path.join(f.root, 'src')), false);
  await assert.rejects(f.controller.pushPlan(task.id), /Checks are missing/);
  await f.controller.verify(task.id, ['node', '--test']);
  assert.equal(f.controller.snapshot().tasks[0].state, 'ready');
});

test('automatic editing copies local source edits while keeping the owner checkout unchanged', async t => {
  const p = project(t), fake = fakeClis(p.parent); environment(t, fake.env);
  fs.writeFileSync(path.join(p.root, 'owner.txt'), 'keep this local source');
  const before = git(p.root, ['status', '--porcelain']), head = git(p.root, ['rev-parse', 'HEAD']);
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  const task = await controller.ask('Normalize coupon codes').finished;
  assert.equal(task.state, 'ready'); assert.equal(task.runs.filter(run => run.role === 'lead').length, 2);
  assert.equal(fs.readFileSync(path.join(task.worktree, 'owner.txt'), 'utf8'), 'keep this local source');
  assert.equal(git(p.root, ['status', '--porcelain']), before); assert.equal(git(p.root, ['rev-parse', 'HEAD']), head);
  assert.equal(fs.existsSync(path.join(p.root, '.elu-code')), false);
  await assert.rejects(controller.pushPlan(task.id), /pre-existing local edits/);
});

// Every local edit is copied, however large and however many: ELU sets no limit of its own.
test('automatic editing copies a local file over 4 MiB and more than 5000 local files', async t => {
  const p = project(t), fake = fakeClis(p.parent); environment(t, fake.env);
  const big = 'a line of a local file larger than four mebibytes\n'.repeat(100000);
  fs.writeFileSync(path.join(p.root, 'big.txt'), big); assert.ok(big.length > 4 * 1024 * 1024);
  fs.mkdirSync(path.join(p.root, 'many'));
  for (let n = 0; n < 5001; n++) fs.writeFileSync(path.join(p.root, 'many', `${n}.txt`), `${n}\n`);
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  const task = await controller.ask('Normalize coupon codes').finished;
  assert.equal(task.state, 'ready', JSON.stringify(task.error));
  assert.equal(fs.readFileSync(path.join(task.worktree, 'big.txt'), 'utf8'), big);
  assert.equal(fs.readdirSync(path.join(task.worktree, 'many')).length, 5001);
  assert.equal(task.localChanges.length, 5002);
});

test('a question after an edit preserves the implementation and its verification', async t => {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'dialogue' }); environment(t, fake.env);
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  const task = await controller.ask('Normalize coupon codes').finished;
  assert.equal(task.state, 'ready');
  const legacy = { ...task }; delete legacy.messages;
  fs.writeFileSync(path.join(taskDir(controller.repo, task.id), 'task.json'), JSON.stringify(legacy));
  const answer = await controller.ask('Just explain the implementation', task.id).finished;
  assert.equal(answer.state, 'ready'); assert.equal(answer.reply.intent, 'answer');
  assert.deepEqual(answer.evidence, task.evidence); assert.deepEqual(answer.reviews, task.reviews);
  assert.deepEqual(answer.result, task.result); assert.equal(answer.runs.length, task.runs.length + 1);
  const last = fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.args.includes('-p')).at(-1);
  assert.doesNotMatch(last.args[last.args.indexOf('--tools') + 1], /Write|Edit|Bash/);
  fs.writeFileSync(path.join(task.worktree, 'src/coupon.mjs'), 'export const normalize = value => value.trim().toUpperCase();\n');
  await controller.verify(task.id);
  assert.equal(controller.snapshot().tasks[0].state, 'unverified', 'passing checks cannot make an old review current');
});

test('a conversation becomes an editing task without losing earlier messages or logs', async t => {
  const f = plain(t, 'answer');
  const question = await f.controller.ask('Can I add agents?').finished;
  fakeClis(f.parent, { mode: 'scaffold' });
  const edit = await f.controller.ask('Create a normalizer and its tests', question.id).finished;
  assert.equal(edit.id, question.id); assert.equal(edit.kind, undefined);
  assert.equal(edit.goal, 'Create a normalizer and its tests');
  // The owner's yes to the Task is kept in the chat, as the message that started the work.
  assert.deepEqual(edit.messages.map(row => row.text), ['Can I add agents?', 'Create a normalizer and its tests', 'Approved the Task: Uppercase coupons']); assert.equal(edit.runs.length, 4);
  assert.ok(edit.runs.every(run => fs.existsSync(run.logFile) && path.dirname(run.logFile) === taskDir(f.controller.repo, edit.id)));
  assert.equal(new ProjectController(projectFolder(f.root)).snapshot().tasks[0].id, question.id);
});

test('preparing an editing workspace waits for other conversation recordings', async t => {
  const f = plain(t, 'slow-answer');
  const question = f.controller.ask('Can I add agents?');
  while (!fs.existsSync(f.fake.calls) || !fs.readFileSync(f.fake.calls, 'utf8').includes('"-p"')) await new Promise(resolve => setTimeout(resolve, 10));
  fakeClis(f.parent, { mode: 'scaffold' });
  const edit = f.controller.ask('Create a normalizer and its tests');
  const [response, implementation] = await Promise.all([question.finished, edit.finished]);
  assert.equal(response.state, 'answered'); assert.equal(implementation.state, 'unverified');
  const records = tasks(f.controller.repo); assert.equal(records.length, 2);
  assert.equal(records[0].state, 'answered'); assert.equal(records[0].runs.length, 1);
  assert.ok(records.every(task => task.runs.every(run => fs.existsSync(run.logFile))));
});

test('coding in an empty Git repository starts without an initial-commit dialog', async t => {
  const f = plain(t, 'scaffold'); git(f.root, ['init', '--initial-branch=main']);
  const controller = autoApprove(new ProjectController(projectFolder(f.root)));
  const task = await controller.ask('Create a normalizer and its tests').finished;
  assert.equal(task.state, 'unverified'); assert.ok(fs.existsSync(path.join(task.worktree, 'src/coupon.mjs')));
});

test('a changed private task policy is refused before another lead run', async t => {
  const f = plain(t, 'answer'); const task = await f.controller.ask('Can I add agents?').finished;
  fs.appendFileSync(path.join(taskDir(f.controller.repo, task.id), 'policy.yaml'), '\n');
  assert.throws(() => pinnedConfig(f.controller.repo, null, { task }), /policy changed/);
  const before = fs.readFileSync(f.fake.calls, 'utf8');
  await assert.rejects(f.controller.ask('Follow up', task.id).finished, /policy changed/);
  assert.equal(fs.readFileSync(f.fake.calls, 'utf8'), before);
});

test('a mode change between turns is not a policy change', async t => {
  const f = plain(t, 'answer'); const task = await f.controller.ask('Can I add agents?', null, { permissions: 'ask' }).finished;
  assert.equal(task.permissions, 'ask'); assert.doesNotThrow(() => pinnedConfig(f.controller.repo, null, { task }));
  const policy = fs.readFileSync(path.join(taskDir(f.controller.repo, task.id), 'policy.yaml'), 'utf8');
  const again = await f.controller.ask('Follow up', task.id, { permissions: 'auto' }).finished;
  assert.equal(again.state, 'answered'); assert.equal(again.permissions, 'auto'); assert.equal(again.configHash, task.configHash);
  assert.equal(fs.readFileSync(path.join(taskDir(f.controller.repo, task.id), 'policy.yaml'), 'utf8'), policy);
  assert.deepEqual(again.permissionChanges.map(row => [row.from, row.to]), [['ask', 'auto']]);
  assert.doesNotThrow(() => pinnedConfig(f.controller.repo, null, { task: again }));
});

test('removing conversation state does not remove the owner project', async t => {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer' }); environment(t, fake.env);
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); await controller.ask('Can I add agents?').finished;
  const plan = uninstallPlan(controller.repo); assert.deepEqual(plan.worktrees, []); assert.deepEqual(plan.edits, []);
  applyUninstall(controller.repo, plan);
  assert.ok(fs.existsSync(path.join(p.root, 'src/coupon.mjs'))); assert.equal(git(p.root, ['status', '--porcelain']), '');
});
