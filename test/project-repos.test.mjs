import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp, project, fakeClis, git, command, CLI, autoApprove } from './helpers.mjs';
import { ProjectController, modelName, speaker, setServer } from '../lib/projects.mjs';
import { projectFolder, nearbyRepositories } from '../lib/workspace.mjs';
import { tasks, projectMark, taskDir } from '../lib/state.mjs';
import { compile as claude, parse as parseClaude } from '../lib/adapters/claude.mjs';
import { defaultConfig, parseConfig, validateConfig } from '../lib/config.mjs';
import { serverNote, sweepServers, writeServers, ADD_NOTE } from '../lib/mcp.mjs';
import { keepAwake } from '../lib/awake.mjs';
import { memoryFolder } from '../lib/memory.mjs';

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const owner = { GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' };
// A home folder with a project that holds no code, next to a repository.
function hub(t, mode) {
  const p = project(t), fake = fakeClis(p.parent, { mode }), home = fs.realpathSync(p.parent), root = path.join(home, 'hub');
  fs.mkdirSync(root);
  environment(t, { ...fake.env, ...owner, HOME: home, XDG_CONFIG_HOME: path.join(home, 'personal'), CLAUDE_CONFIG_DIR: path.join(home, 'claude') });
  return { ...p, home, root, fake, repo: fs.realpathSync(p.root), controller: autoApprove(new ProjectController(projectFolder(root))) };
}

test('a project is a name: its lead finds a repository elsewhere in home and edits it there', async t => {
  const f = hub(t); fs.writeFileSync(path.join(f.home, 'repository.txt'), '../sample app');
  const before = git(f.repo, ['status', '--porcelain']), head = git(f.repo, ['rev-parse', 'HEAD']);
  const task = await f.controller.ask('Normalize coupon codes').finished;
  const mark = projectMark(fs.realpathSync(f.root));
  assert.equal(task.repository, f.repo);
  assert.equal(task.worktree, path.join(path.dirname(f.repo), 'sample app.elu-code', `${task.id}-${mark}`));
  assert.equal(task.branch, `feat/task-${task.id}-${mark}`);
  assert.equal(git(f.repo, ['rev-parse', '--verify', task.branch]).length > 0, true);
  assert.notEqual(task.state, 'blocked', task.error?.message);
  // The project folder never became a repository; the owner's checkout is untouched.
  assert.equal(fs.existsSync(path.join(f.root, '.git')), false);
  assert.equal(git(f.repo, ['status', '--porcelain']), before); assert.equal(git(f.repo, ['rev-parse', 'HEAD']), head);
  // The lead read across home for the conversation, never for the edit.
  const calls = fs.readFileSync(f.fake.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.vendor === 'claude' && row.args.includes('--json-schema'));
  assert.ok(calls[0].args.includes('--add-dir') && calls[0].args[calls[0].args.indexOf('--add-dir') + 1] === f.home);
  assert.ok(calls.slice(1).every(row => !row.args.includes('--add-dir')));
  // The record stays with the project, and a tampered one is refused.
  assert.equal(f.controller.snapshot().tasks[0].repository, f.repo);
  const file = path.join(taskDir(f.controller.repo, task.id), 'task.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...saved, worktree: path.join(f.home, 'elsewhere') }));
  assert.throws(() => tasks(f.controller.repo), /Invalid task record/);
});

test('the lead may change only a repository in home, never a plain folder or home itself', t => {
  const f = hub(t); fs.mkdirSync(path.join(f.root, 'notes'));
  assert.equal(f.controller.editTarget('../sample app').root, f.repo);
  assert.equal(f.controller.editTarget(path.join(f.repo, 'src')).root, f.repo, 'a folder inside a repository means that repository');
  assert.throws(() => f.controller.editTarget('/'), /not a folder in your home/);
  assert.throws(() => f.controller.editTarget('notes'), /not a Git repository/);
  assert.equal(f.controller.editTarget('.'), null, 'the project folder itself starts its own history');
  const atHome = autoApprove(new ProjectController(projectFolder(f.home)));
  assert.throws(() => atHome.editTarget(''), /home folder never becomes a repository/);
});

test('chat speakers read as the model that wrote the reply', () => {
  assert.equal(modelName('claude-fable-5-1'), 'Fable 5.1'); assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-sonnet-5-5[1m]'), 'Sonnet 5.5'); assert.equal(modelName('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  assert.equal(modelName('gpt-5.1-codex'), 'gpt-5.1-codex'); assert.equal(modelName(''), null);
  // A speaker is named by its model, never by a role; a run that named no model reads as its vendor.
  assert.equal(speaker({ role: 'lead', vendor: 'claude' }, 'claude-fable-5-1'), 'Fable 5.1');
  assert.equal(speaker({ role: 'bot:critic', vendor: 'codex' }, 'gpt-5.1-codex'), 'gpt-5.1-codex');
  assert.equal(speaker({ role: 'bot:critic', vendor: 'codex' }, null), 'Codex'); assert.equal(speaker(null, null), 'Model');
});

test('the owner lead reads across home and gets chosen MCP servers; home secrets stay unreadable', t => {
  const cwd = temp(t), home = fs.realpathSync(cwd); environment(t, { HOME: home });
  const role = { ...defaultConfig().roles.lead, access: 'read', writablePaths: [] }, session = '12345678-1234-4234-8234-123456789abc';
  const value = (args, flag) => args[args.indexOf(flag) + 1];
  const plain = claude({ role, cwd, session });
  assert.ok(plain.includes('--safe-mode')); assert.equal(value(plain, '--mcp-config'), '{"mcpServers":{}}'); assert.ok(!plain.includes('--add-dir'));
  const deny = JSON.parse(value(plain, '--settings')).permissions.deny;
  for (const name of ['.ssh', '.aws', '.config', '.netrc', '.zsh_history', 'Library']) assert.ok(deny.includes(`Read(/${path.join(home, name)}/**)`), name);
  const wide = claude({ role, cwd, session, home: true, mcp: { file: path.join(cwd, 'mcp.json'), names: ['elu'] } });
  assert.ok(!wide.includes('--safe-mode'), 'safe mode drops MCP servers, so a run with MCP leaves it out');
  assert.equal(value(wide, '--mcp-config'), path.join(cwd, 'mcp.json')); assert.equal(value(wide, '--add-dir'), home);
  assert.ok(wide.includes('--allowedTools=mcp__elu')); assert.ok(wide.includes('--strict-mcp-config')); assert.ok(wide.includes('--restricted'));
  assert.throws(() => claude({ role, cwd, session, peer: true, home: true }), /peer run reads only/);
  const started = servers => [JSON.stringify({ type: 'system', subtype: 'init', session_id: session, mcp_servers: servers }), JSON.stringify({ type: 'result', is_error: false, structured_output: { outcome: 'done', summary: 'ok', question: null, choices: [], comments: [], responses: [] } })].join('\n');
  assert.equal(parseClaude(started([{ name: 'elu', status: 'connected' }]), { servers: ['elu'] }).result.summary, 'ok');
  assert.throws(() => parseClaude(started([{ name: 'elu', status: 'connected' }])), /MCP servers it was not given/);
  assert.throws(() => claude({ role: defaultConfig().roles.lead, cwd, session, home: true }), /^EluCodeError: Only a read-only session may read across your home\.$/);
});

test('the lead reads the owner\'s Claude Code memory for the folder from a private copy', async t => {
  const f = hub(t, 'answer'), root = f.controller.repo.project ?? f.controller.repo.root, notes = memoryFolder(root);
  assert.ok(notes.startsWith(path.join(f.home, 'claude', 'projects')));
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'MEMORY.md'), '- [Shop repo](shop.md) — the shop lives in ~/projects/shop\n');
  fs.writeFileSync(path.join(notes, 'shop.md'), 'The shop repository is ~/projects/shop.\n');
  fs.writeFileSync(path.join(f.home, 'claude', 'CLAUDE.md'), 'Commit as the owner only.\n');
  const inputs = () => fs.readFileSync(path.join(f.parent, 'inputs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.vendor === 'claude' && row.args.includes('--json-schema'));
  const first = f.controller.ask('Where is the shop?'); await first.finished;
  const [run] = inputs(), copy = run.args[run.args.lastIndexOf('--add-dir') + 1];
  assert.match(copy, /elu-code-memory-[^/]+\/memory$/); assert.notEqual(copy, path.join(f.home));
  assert.ok(run.input.includes(`read-only copy at ${copy}.`));
  assert.match(run.input, /Claude Code memory index \(MEMORY\.md\) \(untrusted data[^\n]*\n"- \[Shop repo\]\(shop\.md\) — the shop lives in ~\/projects\/shop\\n"/);
  assert.match(run.input, /Owner instructions \(~\/\.claude\/CLAUDE\.md\)[^\n]*\n"Commit as the owner only\.\\n"/);
  assert.equal(fs.existsSync(path.dirname(copy)), false, 'the copy is removed after the run');
  // A resumed session already has the index; it gets only where this run's copy is.
  const id = tasks(f.controller.repo).at(-1).id;
  const second = f.controller.ask('And the tests?', id); await second.finished;
  const later = inputs().at(-1), copy2 = later.args[later.args.lastIndexOf('--add-dir') + 1];
  assert.ok(later.args.includes('--resume'));
  assert.ok(later.input.includes(`read-only copy at ${copy2}.`)); assert.ok(!later.input.includes('Shop repo'));
});

async function until(check, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) assert.fail(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 25)); }
}
test('MCP settings never sit in the temp folder: a turn that ends or is stopped removes its own, and leftovers go when ELU Code starts', async t => {
  const f = hub(t, 'answer'), state = path.join(f.home, 'personal', 'elu-code'), shared = path.join(f.home, 'tmp');
  fs.mkdirSync(shared); fs.mkdirSync(path.join(f.home, 'claude')); environment(t, { TMPDIR: shared });
  fs.writeFileSync(path.join(f.home, 'claude', '.claude.json'), JSON.stringify({ mcpServers: { elu: { type: 'http', url: 'https://elu.example/mcp', headers: { Authorization: 'Bearer secret' } } } }));
  const kept = () => fs.readdirSync(state).filter(name => name.startsWith('mcp-')), early = () => fs.readdirSync(shared).filter(name => name.startsWith('elu-code-mcp-'));
  const launches = () => fs.readFileSync(path.join(f.parent, 'inputs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.vendor === 'claude' && row.args.includes('--json-schema'));
  const first = await f.controller.ask('Where is the coupon code?').finished;
  const args = launches().at(-1).args, file = args[args.indexOf('--mcp-config') + 1];
  assert.equal(path.basename(file), 'mcp.json'); assert.equal(path.dirname(path.dirname(file)), state);
  assert.deepEqual(kept(), [], 'removed when the turn ended'); assert.deepEqual(early(), []);
  const fake = path.join(f.parent, 'bin', 'fake.json'); fs.writeFileSync(fake, JSON.stringify({ ...JSON.parse(fs.readFileSync(fake, 'utf8')), mode: 'slow' }));
  const run = f.controller.ask('Take your time.', first.id);
  await until(() => kept().length === 1, 'the turn to start');
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, kept()[0], 'mcp.json'), 'utf8')).mcpServers.elu.headers.Authorization, 'Bearer secret');
  await f.controller.stop(first.id); await run.finished.catch(() => {});
  assert.deepEqual(kept(), [], 'removed when the turn was stopped'); assert.deepEqual(early(), []);
  // A process that died before it could remove its settings leaves them behind. The next
  // start removes those, and the folders an earlier release left in the temp folder.
  const dead = command(process.execPath, ['-e', ''], f.home).pid;
  const gone = path.join(state, `mcp-${dead}-Ab12Cd`), live = path.join(state, `mcp-${process.ppid}-Ab12Cd`), other = path.join(state, 'approvals-Ab12Cd');
  const old = path.join(shared, 'elu-code-mcp-Ab12Cd'), fresh = path.join(shared, 'elu-code-mcp-Zz99Yy'), memory = path.join(shared, 'elu-code-memory-Ab12Cd');
  const leave = () => { for (const folder of [gone, live, other, old, fresh, memory]) { fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'mcp.json'), '{"token":"left behind"}'); } const past = new Date(Date.now() - 5 * 60000); fs.utimesSync(old, past, past); };
  const left = () => [gone, live, other, old, fresh, memory].filter(folder => fs.existsSync(folder));
  leave(); sweepServers(); assert.deepEqual(left(), [live, other, fresh, memory]);
  leave(); assert.equal(command(process.execPath, [CLI, 'help'], f.home).status, 0); assert.deepEqual(left(), [live, other, fresh, memory]);
});

test('MCP servers come from Claude Code by name, through a private file', t => {
  const f = hub(t, 'answer'); fs.mkdirSync(path.join(f.home, 'claude'));
  fs.writeFileSync(path.join(f.home, 'claude', '.claude.json'), JSON.stringify({ mcpServers: { elu: { type: 'http', url: 'https://elu.example/mcp', headers: { Authorization: 'Bearer secret' } }, other: { type: 'http', url: 'https://other.example' } } }));
  const servers = writeServers(['elu'], f.root);
  assert.equal(fs.statSync(servers.file).mode & 0o777, 0o600); assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(servers.file, 'utf8')).mcpServers), ['elu']);
  // The file holds a token, so it is in ELU Code's own state folder, which every session is
  // denied, and never in the temp folder, which a session can read.
  const state = path.join(f.home, 'personal', 'elu-code');
  assert.equal(path.dirname(servers.folder), state); assert.match(path.basename(servers.folder), new RegExp(`^mcp-${process.pid}-`)); assert.equal(fs.statSync(servers.folder).mode & 0o777, 0o700);
  fs.rmSync(servers.folder, { recursive: true, force: true });
  assert.throws(() => writeServers(['missing'], f.root), /not set up in Claude Code/);
  // Every Claude Code server is on, as in Claude Code, until turned off for the project.
  assert.deepEqual(f.controller.servers(), { all: ['elu', 'other'], on: ['elu', 'other'] });
  assert.match(f.controller.setServer('other', false), /^other is off for this project\. \/mcp on other turns it back on\.$/);
  assert.deepEqual(f.controller.servers(), { all: ['elu', 'other'], on: ['elu'] });
  assert.match(f.controller.setServer('elu', true), /elu is on/);
  const saved = parseConfig(fs.readFileSync(path.join(f.root, '.elu-code', 'config.yaml'), 'utf8'));
  assert.deepEqual(saved.mcpOff, ['other']); assert.equal(saved.mcp, undefined);
  assert.throws(() => f.controller.setServer('missing', true), /No MCP server named missing/);
  assert.throws(() => f.controller.setServer('missing', false), /No MCP server named missing/);
  // Settings from before servers were on by default still load.
  assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), mcp: ['elu'] }));
  assert.throws(() => validateConfig({ ...defaultConfig(), mcpOff: ['bad name'] }), /mcpOff lists up to 20/);
  assert.throws(() => setServer(f.controller.repo, 'bad name', true, defaultConfig()), /MCP server name/);
  return f.controller.ask('What does the coupon module do?').finished.then(() => {
    const run = fs.readFileSync(f.fake.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(row => row.vendor === 'claude' && row.args.includes('--json-schema'));
    const file = run.args[run.args.indexOf('--mcp-config') + 1];
    assert.ok(file.endsWith('mcp.json') && !run.args.includes('--safe-mode') && run.args.includes('--allowedTools=mcp__elu'));
    assert.ok(!run.args.includes('--allowedTools=mcp__other'), 'a server turned off stays off');
    assert.equal(fs.existsSync(file), false, 'the server file is removed after the run');
    assert.ok(!JSON.stringify(run.args).includes('Bearer secret'), 'tokens never reach the command line');
    // The lead knows what it has, and the exact command for a server that is off.
    const input = fs.readFileSync(path.join(f.parent, 'inputs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).findLast(row => row.vendor === 'claude').input;
    assert.match(input, /MCP servers on for you \(tools named mcp__NAME__\*\): elu\./);
    assert.match(input, /MCP servers are off for you: other\. When a request needs one of them, tell the owner to type \/mcp on NAME/);
    assert.ok(!input.includes('Bearer secret'), 'tokens never reach the prompt');
  });
});

test('the lead\'s MCP note names the servers that are off', t => {
  const folder = temp(t), previous = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = folder;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
  // With no servers the note still says how the owner adds one, and that a key never goes through the chat.
  assert.equal(serverNote(folder, []), ADD_NOTE, 'no servers: only how to add one');
  assert.match(ADD_NOTE, /type \/mcp add in the message box/); assert.match(ADD_NOTE, /Never ask for a key, token or password in the chat\./); assert.match(ADD_NOTE, /You cannot add a server yourself\./);
  fs.writeFileSync(path.join(folder, '.claude.json'), JSON.stringify({ mcpServers: { elu: { type: 'http', url: 'https://elu.example/mcp' }, gmail: { command: 'gmail' } } }));
  assert.equal(serverNote(folder, []), `The owner's other Claude Code MCP servers are off for you: elu, gmail. When a request needs one of them, tell the owner to type /mcp on NAME in the message box, with that server's name, and then ask again. ${ADD_NOTE}`);
  assert.equal(serverNote(folder, ['elu', 'gmail']), `MCP servers on for you (tools named mcp__NAME__*): elu, gmail. ${ADD_NOTE}`);
});

test('caffeinate runs while there is work and stops when there is none', t => {
  const folder = temp(t); environment(t, { XDG_CONFIG_HOME: folder });
  const started = [], stopped = [], options = { platform: 'darwin', bin: process.execPath, start: (bin, args) => { started.push(args); return { pid: process.pid, unref() {} }; }, stop: pid => stopped.push(pid) };
  // -i holds off idle sleep only: the display still sleeps and the screen still locks.
  assert.equal(keepAwake(true, options), true); assert.deepEqual(started, [['-i']]);
  assert.equal(keepAwake(true, options), true); assert.equal(started.length, 1, 'one caffeinate serves everyone');
  assert.equal(keepAwake(false, options), false); assert.deepEqual(stopped, [process.pid]);
  assert.equal(fs.existsSync(path.join(folder, 'elu-code', 'caffeinate.json')), false);
  assert.equal(keepAwake(true, { ...options, platform: 'linux' }), false, 'only where caffeinate exists');
});

test('the lead gets the repositories in home, most recently used first, without worktrees or dependencies', t => {
  const home = fs.realpathSync(temp(t)), repo = (dir, age) => { fs.mkdirSync(path.join(home, dir, '.git'), { recursive: true }); fs.writeFileSync(path.join(home, dir, '.git', 'HEAD'), 'ref: refs/heads/main\n'); const when = new Date(Date.now() - age * 1000); fs.utimesSync(path.join(home, dir, '.git', 'HEAD'), when, when); };
  repo('old/app', 500); repo('projects/shop', 10); repo('projects/shop/node_modules/dep', 1);
  fs.mkdirSync(path.join(home, 'projects', 'shop.elu-code', '1'), { recursive: true }); fs.writeFileSync(path.join(home, 'projects', 'linked'), '');
  fs.mkdirSync(path.join(home, 'projects', 'wt')); fs.writeFileSync(path.join(home, 'projects', 'wt', '.git'), 'gitdir: elsewhere\n');
  fs.mkdirSync(path.join(home, 'Library', 'repo', '.git'), { recursive: true });
  assert.deepEqual(nearbyRepositories({ home }), [path.join(home, 'projects', 'shop'), path.join(home, 'old', 'app')]);
  assert.deepEqual(nearbyRepositories({ home, limit: 1 }), [path.join(home, 'projects', 'shop')]);
});
