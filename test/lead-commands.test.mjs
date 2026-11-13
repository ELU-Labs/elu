import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, config, approveProjectFiles } from './helpers.mjs';
import { compile } from '../lib/adapters/claude.mjs';
import { initPlan } from '../lib/init.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';

const session = '12345678-1234-4234-8234-123456789abc';
const launch = (root, role) => compile({ mode: 'locked', role, cwd: root, protectedPaths: ['.elu-code', '.git'], commonDir: path.join(root, '.git'), session });
const shellRules = args => args.filter(arg => arg.startsWith('--allowedTools=Bash'));

test('a project with a package.json and no settings file gives a Read only lead no shell; its scripts run as checks', async t => {
  const p = project(t), root = fs.realpathSync(p.root), home = path.join(fs.realpathSync(p.parent), 'personal'), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home; t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  assert.equal(fs.existsSync(path.join(root, '.elu-code')), false);
  const checks = [{ name: 'tests', command: ['npm', 'test'] }, { name: 'build', command: ['npm', 'run', 'build'] }];
  for (const [where, settings] of [['the open project', new ProjectController(projectFolder(root)).draftConfig], ['project setup', (await initPlan(projectFolder(root))).config]]) {
    assert.deepEqual(settings.checks, checks, where);
    assert.deepEqual(settings.roles.lead.commands, [], where);
    assert.equal(settings.roles.lead.access, 'edit', where);
    const args = launch(root, settings.roles.lead);
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob,Edit,Write', where);
    assert.deepEqual(shellRules(args), [], where);
  }
});

test('a settings file the owner wrote still names the lead\'s command prefixes', t => {
  const p = project(t), root = fs.realpathSync(p.root), home = path.join(fs.realpathSync(p.parent), 'personal'), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home; t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  config(root, value => { value.roles.lead.commands = ['npm test']; return value; });
  // Written by hand, the file counts once he has approved it on this machine.
  assert.deepEqual(new ProjectController(projectFolder(root)).draftConfig.roles.lead.commands, []);
  approveProjectFiles(root);
  const lead = new ProjectController(projectFolder(root)).draftConfig.roles.lead, args = launch(root, lead);
  assert.deepEqual(lead.commands, ['npm test']);
  assert.match(args[args.indexOf('--tools') + 1], /Bash$/);
  assert.deepEqual(shellRules(args), ['--allowedTools=Bash(npm test:*)']);
});
