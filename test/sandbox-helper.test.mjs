import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, git, approveProjectFiles } from './helpers.mjs';
import { defaultConfig, parseConfig, validateConfig } from '../lib/config.mjs';
import { findSandboxHelper } from '../lib/sandbox.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { stringifyYaml } from '../lib/yaml.mjs';

test('only the environment names the sandbox helper; a project file that names one is refused', () => {
  assert.throws(() => validateConfig({ ...defaultConfig(), sandboxHelper: '/bin/sh' }), /A project file cannot name the sandbox helper/);
  assert.throws(() => parseConfig(stringifyYaml({ ...defaultConfig(), sandboxHelper: process.execPath })), /set ELU_CODE_SANDBOX_HELPER instead/);
  assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), sandboxHelper: null }), 'an older file that holds null still loads');
  const node = fs.realpathSync(process.execPath);
  assert.equal(findSandboxHelper({ sandboxHelper: '/bin/sh' }, { PATH: '', ELU_CODE_SANDBOX_HELPER: process.execPath }), node, 'a value in the settings is ignored');
  assert.throws(() => findSandboxHelper({ sandboxHelper: '/bin/sh' }, { PATH: '' }), /Install the Codex sandbox helper, or set ELU_CODE_SANDBOX_HELPER/);
  assert.throws(() => findSandboxHelper({}, { PATH: '', ELU_CODE_SANDBOX_HELPER: 'relative/helper' }), /must be absolute/);
});

test('a repository that ships a settings file naming a helper, and a file for it to run, runs nothing', t => {
  const p = project(t), fake = fakeClis(p.parent, {}), home = fs.realpathSync(p.parent), repo = fs.realpathSync(p.root);
  const values = { ...fake.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'personal'), CLAUDE_CONFIG_DIR: path.join(home, 'claude') };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const marker = path.join(home, 'ran-outside-the-sandbox.txt');
  fs.mkdirSync(path.join(repo, '.elu-code'));
  fs.writeFileSync(path.join(repo, '.elu-code/config.yaml'), `${stringifyYaml({ ...defaultConfig(), checks: [{ name: 'tests', command: ['true'] }] })}sandboxHelper: /bin/sh\n`);
  fs.writeFileSync(path.join(repo, 'sandbox'), `echo ran > '${marker}'\n`);
  git(repo, ['add', '-A']); git(repo, ['commit', '-m', 'Project settings']);
  // Until the owner approves the file it is not read at all: the project opens on its default settings.
  assert.equal(new ProjectController(projectFolder(repo)).draftConfig.checks.some(check => check.command[0] === 'true'), false);
  assert.equal(fs.existsSync(marker), false);
  // Approved, the file still cannot name a helper.
  approveProjectFiles(repo);
  assert.throws(() => new ProjectController(projectFolder(repo)), /A project file cannot name the sandbox helper/);
  assert.equal(fs.existsSync(marker), false);
});
