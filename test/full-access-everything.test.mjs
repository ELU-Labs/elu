import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compile as claude, childEnv } from '../lib/adapters/claude.mjs';
import { launch as agy } from '../lib/adapters/agy.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { APPROVAL_TOOL } from '../lib/mcp.mjs';
import { checkFolders } from '../lib/modes.mjs';
import { personalDirectory } from '../lib/util.mjs';
import { temp } from './helpers.mjs';

// Full access is everything: every tool, every helper, every folder, any path name. The
// lower modes keep each limit.
const SESSION = '12345678-1234-4234-8234-123456789abc';
function world(t, name = 'ws') {
  const dir = temp(t), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  const cwd = path.join(dir, name); fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  fs.mkdirSync(path.resolve(personalDirectory()), { recursive: true });
  const mcp = { file: path.join(dir, 'mcp.json'), names: ['elu-code-approval'] }; fs.writeFileSync(mcp.file, '{"mcpServers":{}}');
  const schemaFile = path.join(dir, 'schema.json'); fs.writeFileSync(schemaFile, '{}');
  const runDir = path.join(dir, 'run'); fs.mkdirSync(runDir);
  const role = defaultConfig().roles.lead;
  const launch = (mode, extra = {}) => claude({ role, mode, cwd, protectedPaths: ['.git'], commonDir: path.join(cwd, '.git'), session: SESSION, mcp, approval: { tool: APPROVAL_TOOL }, ...extra });
  return { dir, cwd, mcp, schemaFile, runDir, role, launch };
}
const valueOf = (args, flag) => args[args.indexOf(flag) + 1];
const settingsOf = args => JSON.parse(valueOf(args, '--settings'));

test('Claude in Full access is refused no tool; Ask and Approve for me keep the list', t => {
  const w = world(t), full = w.launch('full');
  assert.equal(full.includes('--disallowedTools'), false, 'no tool is refused in Full access');
  assert.equal(valueOf(full, '--tools'), 'default', 'every tool Claude Code has');
  for (const mode of ['ask', 'auto']) { const args = w.launch(mode); assert.equal(valueOf(args, '--disallowedTools'), 'Agent,Task,NotebookEdit,PowerShell,Monitor', mode); assert.equal(valueOf(args, '--tools'), 'Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch', mode); }
  // A turn that only reads keeps its three tools in every mode: that is the turn, not the mode.
  const reads = w.launch('full', { readTools: true });
  assert.equal(valueOf(reads, '--tools'), 'Read,Grep,Glob'); assert.ok(valueOf(reads, '--disallowedTools').includes('Bash'));
});

test('a bot turn with helpers in Full access sends no Agent rule and limits no helper', t => {
  const w = world(t), full = w.launch('full', { subagents: 'haiku' }), settings = settingsOf(full);
  assert.deepEqual(settings.permissions.deny, [], 'no Agent(...) rule');
  assert.equal(full.some(arg => arg.includes('Agent(')), false);
  assert.equal(full.includes('--disallowedTools'), false);
  assert.deepEqual(Object.keys(settings.env).filter(name => name.startsWith('CLAUDE_')).sort(), ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'], 'only the model the owner chose for helpers');
  assert.deepEqual(childEnv({ subagents: 'haiku', mode: 'full' }), { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
  assert.equal(Object.values(JSON.parse(valueOf(full, '--agents')))[0].tools, undefined, 'the helper has every tool');
  const auto = w.launch('auto', { subagents: 'haiku' }), lower = settingsOf(auto);
  assert.ok(lower.permissions.deny.includes('Agent(general-purpose)')); assert.ok(lower.permissions.deny.includes('Agent(model:*)'));
  assert.equal(lower.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '1'); assert.equal(childEnv({ subagents: 'haiku', mode: 'auto' }).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
});

test('a path with glob characters starts in Full access on Claude and Antigravity CLI; lower modes refuse it', t => {
  const w = world(t, 'my [work] (v2) *'), lead = { ...w.role, writablePaths: ['.'] }, odd = path.join(w.dir, 'notes {a,b}?'); fs.mkdirSync(odd);
  assert.ok(w.launch('full', { folders: [odd] }).includes(odd));
  assert.throws(() => w.launch('ask'), /cannot be expressed safely/);
  assert.ok(agy({ role: lead, mode: 'full', cwd: w.cwd, folders: [odd], schemaFile: w.schemaFile }).includes('--dangerously-skip-permissions'));
  assert.throws(() => agy({ role: lead, mode: 'ask', cwd: w.cwd, schemaFile: w.schemaFile }), /cannot be expressed safely/);
});

test('/permissions folders takes a secret folder, ELU\'s own folder and one outside home in Full access only', t => {
  const dir = fs.realpathSync(temp(t)), home = path.join(dir, 'home'), outside = path.join(dir, 'elsewhere'), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(home, '.config'); t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  const own = path.resolve(personalDirectory());
  for (const folder of [path.join(home, '.ssh'), path.join(home, 'work'), own, outside]) fs.mkdirSync(folder, { recursive: true });
  for (const mode of [undefined, 'ask', 'auto']) {
    for (const folder of [path.join(home, '.ssh'), own]) assert.throws(() => checkFolders([folder], { home, mode }), /holds secrets or ELU state/, `${mode} ${folder}`);
    assert.throws(() => checkFolders([outside], { home, mode }), /inside your home/);
    assert.deepEqual(checkFolders([path.join(home, 'work')], { home, mode }), [path.join(home, 'work')]);
  }
  assert.deepEqual(checkFolders([path.join(home, '.ssh'), own, outside, home], { home, mode: 'full' }), [path.join(home, '.ssh'), own, outside, home]);
  assert.throws(() => checkFolders([path.join(home, 'missing')], { home, mode: 'full' }), /Folder not found/);
});
