import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp, project, fakeClis, git, autoApprove } from './helpers.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder, pendingRequests, saveRequest, updateRequest } from '../lib/workspace.mjs';
import { repository } from '../lib/git.mjs';
import { taskDir, readTask, saveTask, lock } from '../lib/state.mjs';
import { pinnedConfig, structuralChecks } from '../lib/checks.mjs';
import { protectedPath } from '../lib/policy.mjs';
import { sandboxArgs } from '../lib/sandbox.mjs';
import { capMode, checkMode, defaultMode, saveDefaultMode } from '../lib/modes.mjs';
import { enqueue, retryRequest } from '../lib/conductor.mjs';
import { saveSchedule, parseWhen } from '../lib/schedules.mjs';
import { SCHEDULE_NOTE, saveBot } from '../lib/bots.mjs';
import { answerApproval, approvalsDir, awaitDecision, pendingApprovals, requestApproval } from '../lib/approvals.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { READ_ONLY_REPLY } from '../lib/runner.mjs';
import { ruleFor, saveRule } from '../lib/permission-rules.mjs';
import { turnClock } from '../lib/turn-limits.mjs';

// Sessions with permissions, end to end against the fake CLIs.
// The personal directory (XDG_CONFIG_HOME) and HOME both point into the test folder, so a
// folder the owner names sits in "home" and the approval files are the test's own.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function setup(t, mode = 'normal') {
  const p = project(t), fake = fakeClis(p.parent, { mode });
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const work = path.join(p.parent, 'notes'); fs.mkdirSync(work);
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  const calls = () => fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const leads = () => calls().filter(call => call.vendor === 'claude' && call.args.includes('-p'));
  const inputs = () => fs.readFileSync(path.join(p.parent, 'inputs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.vendor === 'claude');
  return { ...p, fake, work, controller, calls, leads, inputs };
}
const valueOf = (args, flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
// The Claude Code calls of a task that has run nothing else here, split by who ran: the
// model's own turns, and the reviews of its bots (@reviewer is in a new session and runs on
// Claude Code too). Calls and runs are in the same order.
const callsOf = (f, task) => {
  const calls = f.leads(); assert.equal(calls.length, task.runs.length, JSON.stringify(task.runs.map(run => run.role)));
  return { turns: calls.filter((call, i) => task.runs[i].role === 'lead'), reviews: calls.filter((call, i) => task.runs[i].role !== 'lead') };
};
const settingsOf = args => JSON.parse(valueOf(args, '--settings'));
// A named folder the file tools may not write to, nor a sandboxed command.
const writeRules = dir => ['Edit', 'Write'].flatMap(tool => [`${tool}(//${dir.slice(1)})`, `${tool}(//${dir.slice(1)}/**)`]);
const writeDenied = (settings, dir) => writeRules(dir).every(rule => settings.permissions.deny.includes(rule)) && settings.sandbox.filesystem?.denyWrite.includes(dir) === true;
const writeOpen = (settings, dir) => writeRules(dir).every(rule => !settings.permissions.deny.includes(rule)) && settings.sandbox.filesystem?.denyWrite.includes(dir) !== true;
const SARA = 'b'.repeat(64);
// The entries of a sandbox list that lie in a Git folder, links resolved where the path exists.
const gitEntries = list => list.filter(entry => entry.split(path.sep).includes('.git')).map(entry => { try { return fs.realpathSync(entry); } catch { return entry; } });
const origin = (kind, extra = {}) => ({ kind, peer: SARA, name: 'sara', a2aTaskId: 'task-1', threadId: 'thread-1', hop: 1, ...extra });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a new session gets the personal default; a follow-up inherits mode, place and folders; a switch applies next turn', async t => {
  const f = setup(t, 'answer');
  assert.equal(defaultMode(), 'ask'); saveDefaultMode('auto'); assert.equal(defaultMode(), 'auto');
  // The terminal app passes the default it shows; the runtime stores exactly what it is given.
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: defaultMode(), place: 'worktree', folders: [f.work] }).finished;
  assert.equal(first.state, 'answered'); assert.equal(first.permissions, 'auto'); assert.deepEqual(first.place, { kind: 'worktree' }); assert.deepEqual(first.folders, [fs.realpathSync(f.work)]);
  assert.equal(first.runs[0].permissions, 'auto'); assert.equal(first.runs[0].effectivePermissions, 'auto'); assert.equal(first.runs[0].denials, undefined);
  let [run] = f.leads();
  assert.equal(valueOf(run.args, '--permission-mode'), 'auto'); assert.equal(valueOf(run.args, '--permission-prompt-tool'), 'mcp__elu-code-approval__approve');
  assert.ok(run.args.flatMap((a, i) => a === '--add-dir' ? [run.args[i + 1]] : []).includes(fs.realpathSync(f.work)), 'the folder is a working directory');
  assert.ok(writeDenied(settingsOf(run.args), fs.realpathSync(f.work)), 'which it reads and never writes');
  assert.equal(run.args.includes('--restricted'), false);
  const prompt = f.inputs()[0].input;
  assert.match(prompt, /When an action is declined or blocked, do not retry it another way\. Return outcome needs_input and name the action you need\./);
  assert.match(prompt, /You may also read these folders: /); assert.doesNotMatch(prompt, /install packages/);
  // The never list by name, once, with the read-only way to list tags.
  assert.equal(prompt.split('Never run these in this mode, alone or inside a longer command line: git push, git tag, git merge, gh pr merge, gh release, npm publish, pnpm publish, yarn publish, cargo publish, firebase deploy, vercel deploy, gcloud run deploy, gcloud app deploy, fly deploy, kubectl apply, terraform apply, claude mcp add, claude mcp add-json, claude mcp add-from-claude-desktop, claude mcp remove, elu mcp add, elu mcp remove. To list tags use git for-each-ref --sort=-creatordate refs/tags or git describe --tags, never git tag.').length, 2);
  assert.match(prompt, /This session runs with Approve for me: you have a shell, the internet, and the MCP tools you were given; an action outside the project or the sandbox is reviewed before it runs\./);
  assert.match(prompt, /The repository's own ELU config \(roles, network, commands\) does not limit this session\./);
  const policy = fs.readFileSync(path.join(taskDir(f.controller.repo, first.id), 'policy.yaml'), 'utf8');
  // A follow-up without choices keeps the session's.
  const second = await f.controller.ask('And the tests?', first.id).finished;
  assert.equal(second.permissions, 'auto'); assert.deepEqual(second.folders, first.folders); assert.equal(second.runs[1].permissions, 'auto'); assert.equal(second.permissionChanges, undefined);
  assert.equal(valueOf(f.leads()[1].args, '--permission-mode'), 'auto'); assert.equal(valueOf(f.leads()[1].args, '--resume'), first.sessions.lead.id);
  // A switch is recorded and applies from this turn on; the pinned policy never moves.
  const third = await f.controller.ask('Now do it', first.id, { permissions: 'full' }).finished;
  assert.equal(third.permissions, 'full'); assert.deepEqual(third.permissionChanges.map(row => [row.from, row.to]), [['auto', 'full']]);
  assert.equal(third.runs[2].permissions, 'full'); assert.equal(third.runs[2].effectivePermissions, 'full');
  run = f.leads()[2]; assert.equal(valueOf(run.args, '--permission-mode'), 'bypassPermissions'); assert.deepEqual(settingsOf(run.args).sandbox, { enabled: false });
  assert.equal(settingsOf(run.args).permissions.deny.some(rule => rule.includes(fs.realpathSync(f.work).slice(1))), false, 'Full access leaves the folder as it is');
  // Full access has no never list: no deny rule, no stand-in folder, no line that forbids it, and it is told what it may do.
  assert.match(f.inputs()[2].input, /^Work only on the given task\.\n/);
  assert.match(f.inputs()[2].input, /This session runs with Full access: any file, any command, the internet, and the MCP tools you were given\. You may push, open and merge pull requests, tag, publish and deploy when the task calls for it\./);
  assert.doesNotMatch(f.inputs()[2].input, /Never run these|Do not push|never list|Never add or remove a server yourself/);
  assert.equal(settingsOf(run.args).permissions.deny.some(rule => rule.startsWith('Bash(')), false, 'no never-list deny rule in Full access');
  assert.equal(fs.readFileSync(path.join(taskDir(f.controller.repo, first.id), 'policy.yaml'), 'utf8'), policy);
  assert.equal(pinnedConfig(f.controller.repo, null, { task: third }).configHash, first.configHash);
  // Nothing in the repository or its configuration records the mode.
  assert.equal(git(f.root, ['status', '--porcelain']), '');
});

test('an automatic edit task inherits the conversation mode; the reviewer and the locked lead keep the locked launch', async t => {
  const f = setup(t);
  const task = await f.controller.ask('Normalize coupon codes', null, { permissions: 'auto', place: 'worktree', folders: [f.work] }).finished;
  assert.equal(task.state, 'ready'); assert.equal(task.kind, undefined); assert.equal(task.mode, 'automatic');
  assert.equal(task.permissions, 'auto'); assert.deepEqual(task.folders, [fs.realpathSync(f.work)]); assert.deepEqual(task.place, { kind: 'worktree' });
  const leads = task.runs.filter(run => run.role === 'lead'); assert.equal(leads.length, 2);
  assert.ok(leads.every(run => run.permissions === 'auto' && run.effectivePermissions === 'auto'));
  assert.ok(task.runs.filter(run => run.role !== 'lead').every(run => run.permissions === undefined), 'a reviewer never carries a mode');
  assert.deepEqual(task.runs.map(run => run.role), ['lead', 'lead', 'bot:reviewer']);
  const { turns: claudeRuns, reviews } = callsOf(f, task);
  assert.ok(claudeRuns.every(run => valueOf(run.args, '--permission-mode') === 'auto' && valueOf(run.args, '--permission-prompts') === 'host'));
  // The review is read-only and asks nothing, whatever the session's mode.
  for (const review of reviews) { assert.equal(valueOf(review.args, '--permission-mode'), 'dontAsk'); assert.equal(valueOf(review.args, '--permission-prompts'), 'none'); assert.equal(valueOf(review.args, '--tools'), 'Read,Grep,Glob'); assert.ok(review.args.includes('--restricted')); assert.equal(review.args.includes('--permission-prompt-tool'), false); }
  assert.ok(claudeRuns.every(run => settingsOf(run.args).permissions.deny.includes('Bash(git push:*)')));
  const edit = claudeRuns.at(-1), settings = settingsOf(edit.args);
  assert.equal(settings.permissions.deny.some(rule => rule.includes('package.json')), false, 'auto lifts the dependency files');
  assert.ok(settings.permissions.deny.some(rule => rule.includes('/.elu-code')), 'other protected paths stay denied');
  assert.ok(edit.args.includes('--add-dir') && edit.args.includes(fs.realpathSync(f.work)));
  assert.ok(claudeRuns.every(run => writeDenied(settingsOf(run.args), fs.realpathSync(f.work))), 'the named folder is read only in every turn of the session');
  // The relay is told what each turn reads beside its workspace, for the tools that send files:
  // the home only in the conversation's turn, which reads across it; the edit reads the named folder.
  const relays = fs.readFileSync(path.join(f.parent, 'relays.jsonl'), 'utf8').trim().split('\n').map(JSON.parse), reads = args => JSON.parse(valueOf(args, '--folders'));
  assert.equal(relays.length, claudeRuns.length);
  assert.ok(claudeRuns[0].args.includes(fs.realpathSync(f.parent)) || claudeRuns[0].args.includes(f.parent), 'the conversation turn adds the home');
  assert.deepEqual(reads(relays[0]), [process.env.HOME, fs.realpathSync(f.work)]);
  assert.equal(edit.args.includes(f.parent) || edit.args.includes(fs.realpathSync(f.parent)), false, 'the edit does not');
  assert.deepEqual(reads(relays.at(-1)), [fs.realpathSync(f.work)]);
  assert.equal(git(f.root, ['status', '--porcelain']), ''); assert.equal(fs.existsSync(path.join(f.root, '.elu-code')), false);
  // A task saved without a mode runs the read-only launch.
  const old = await f.controller.ask('Explain the change', null).finished;
  assert.equal(old.permissions, undefined); assert.equal(old.runs[0].permissions, undefined); assert.equal(old.runs[0].effectivePermissions, undefined);
  const locked = f.leads().at(-1).args;
  assert.equal(valueOf(locked, '--permission-mode'), 'dontAsk'); assert.equal(valueOf(locked, '--permission-prompts'), 'none'); assert.ok(locked.includes('--restricted') && locked.includes('--safe-mode'));
  assert.equal(locked.includes('--permission-prompt-tool'), false); assert.match(f.inputs().at(-1).input, /install packages/);
});

// A reply in a session whose edit has run reads, while the Task the owner approved is open
// too: it is told it cannot change files and that its edit intent goes on with edit access
// (READ_ONLY_REPLY), so it never tries a write that only fails. A session whose Task is done,
// one already published, and a conversation read as well.
test('a reply in a working session reads and is told its edit goes on with edit access; a conversation reply reads', async t => {
  const f = setup(t), fakeFile = path.join(f.fake.dir, 'fake.json'), fake = JSON.parse(fs.readFileSync(fakeFile, 'utf8'));
  // The working turn meets one objective of two, so its Task stays open.
  fs.writeFileSync(fakeFile, JSON.stringify({ ...fake, objectivesMet: [1] }));
  const task = await f.controller.ask('Normalize coupon codes', null, { permissions: 'ask', place: 'worktree' }).finished;
  assert.equal(task.state, 'ready'); const worktree = fs.realpathSync(task.worktree);
  const replyPrompts = from => f.inputs().slice(from).map(row => row.input).filter(input => /Respond to the owner immediately/.test(input));
  // Reads: an edit in the session's folder asks the owner, and nothing tells it to write there.
  const reads = async (id, text, why, folder = worktree) => {
    const from = f.inputs().length, calls = f.leads().length;
    await f.controller.ask(text, id).finished.catch(() => null);
    const [said] = replyPrompts(from), launch = f.leads()[calls];
    assert.ok(said && launch, why); assert.doesNotMatch(said, /You may change files there in this turn/, why);
    assert.ok((settingsOf(launch.args).permissions.ask ?? []).some(rule => rule.startsWith(`Edit(//${folder.slice(1)}`)), why);
    return said;
  };
  const said = await reads(task.id, 'Also rename the helper', 'a reply while the Task is open reads');
  assert.ok(said.includes(READ_ONLY_REPLY), 'it is told its edit goes on with edit access');
  // Published work stays as it was published.
  saveTask(f.controller.repo, { ...readTask(f.controller.repo, task.id), pushedCommit: readTask(f.controller.repo, task.id).commit ?? 'a'.repeat(40) });
  await reads(task.id, 'One more rename', 'a published session reads');
  // A session whose Task is done reads too: more work there starts as an edit of its own.
  fs.writeFileSync(fakeFile, JSON.stringify(fake));
  const done = await f.controller.ask('Uppercase the coupons', null, { permissions: 'ask', place: 'worktree' }).finished;
  assert.equal(done.state, 'ready');
  await reads(done.id, 'What did you change?', 'a done Task reads', fs.realpathSync(done.worktree));
  // A conversation that has not started an edit reads, as before.
  const before = f.inputs().length, calls = f.leads().length;
  await f.controller.ask('Where is coupon normalization?', null, { permissions: 'ask' }).finished;
  const [talk] = replyPrompts(before), first = f.leads()[calls];
  assert.doesNotMatch(talk, /You may change files there in this turn/);
  assert.ok((settingsOf(first.args).permissions.ask ?? []).some(rule => rule.startsWith('Edit(')), 'an edit in a conversation turn asks');
});

// The owner names the folder of all his code. The session edits a repository in it, in a
// worktree beside that repository: inside the named folder. A deny wins over an allow in the
// vendor, so the edit's launch leaves the folder to the workspace's rules; the conversation,
// which runs in the project folder outside it, reads it and may not write there.
test('a named folder that holds the repository a session edits is read only to the conversation and left to the workspace\'s rules in the edit inside it', async t => {
  const f = setup(t), code = path.join(f.parent, 'code'), hub = path.join(f.parent, 'hub');
  fs.mkdirSync(code); fs.cpSync(f.root, path.join(code, 'sample app'), { recursive: true }); fs.mkdirSync(hub);
  fs.writeFileSync(path.join(f.parent, 'repository.txt'), '../code/sample app');
  const controller = autoApprove(new ProjectController(projectFolder(hub)));
  const task = await controller.ask('Normalize coupon codes', null, { permissions: 'auto', folders: [code] }).finished;
  const named = fs.realpathSync(code);
  assert.equal(task.repository, path.join(named, 'sample app')); assert.ok(task.worktree.startsWith(`${named}${path.sep}`), task.worktree);
  assert.notEqual(task.state, 'blocked', task.error?.message);
  // Where each turn ran, from the npm settings file the launch names in its folder.
  const turns = f.leads().filter(call => valueOf(call.args, '--permission-mode') === 'auto'), ranIn = call => path.dirname(path.dirname(settingsOf(call.args).env.npm_config_globalconfig));
  const conversations = turns.filter(call => ranIn(call) === hub), edits = turns.filter(call => ranIn(call) === task.worktree);
  assert.ok(conversations.length >= 1 && edits.length >= 1, 'the conversation and the edit ran'); assert.equal(conversations.length + edits.length, turns.length);
  for (const conversation of conversations) assert.ok(writeDenied(settingsOf(conversation.args), named), 'the conversation reads the folder and never writes it');
  for (const edit of edits) {
    assert.ok(edit.args.includes('--add-dir') && edit.args.includes(named), 'the edit reads the folder');
    assert.ok(writeOpen(settingsOf(edit.args), named), 'and is not denied the folder that holds its worktree');
    assert.ok(edit.args.includes(`--allowedTools=Edit(//${task.worktree.slice(1)}/**)`), 'edits in the worktree stay allowed');
  }
});

test('a schedule gets Full access only when the owner picked it; an automatic request is capped at Approve for me', async t => {
  const p = project(t), fake = fakeClis(p.parent); environment(t, fake.env);
  assert.equal(checkMode('full'), 'full');
  assert.throws(() => saveSchedule({ root: p.root, goal: 'Nightly tidy', when: parseWhen('daily 9:00', new Date(2026, 10, 9, 8)), permissions: 'full' }, new Date(2026, 10, 9, 8)), /Full access only when you pick it/);
  assert.equal(saveSchedule({ root: p.root, goal: 'Nightly check', when: parseWhen('daily 9:00', new Date(2026, 10, 9, 8)), permissions: 'full', picked: true }, new Date(2026, 10, 9, 8)).permissions, 'full');
  const row = saveSchedule({ root: p.root, goal: 'Nightly tidy', when: parseWhen('daily 9:00', new Date(2026, 10, 9, 8)), permissions: 'auto' }, new Date(2026, 10, 9, 8));
  assert.equal(row.permissions, 'auto');
  // An owner's request from another machine (A2A) is capped at auto whatever the default says.
  saveDefaultMode('full');
  assert.equal(capMode(defaultMode(), 'auto'), 'auto'); assert.equal(capMode('ask', 'auto'), 'ask');
  const request = enqueue(p.root, 'Normalize coupons', { permissions: capMode(defaultMode(), 'auto') });
  assert.equal(request.permissions, 'auto');
  assert.throws(() => enqueue(p.root, 'q', { origin: origin('ask'), readOnly: true, context: 'ctx', permissions: 'auto' }), /Teammate questions stay read-only/);
});

// A bot's scheduled turn runs in its session's mode: the owner who picks Full access for the
// session picks it for the schedules of its bots. The model and the bot are each told how
// the owner repeats work: with /schedule, which they cannot run themselves.
test("a bot's own scheduled turn runs with Full access in a Full access session; the model and the bot are told about /schedule", async t => {
  const f = setup(t, 'answer');
  saveBot({ name: 'nightly', vendor: 'claude', instructions: 'Tidy the notes.', schedule: 'every 1h' });
  const chat = await f.controller.ask('Run the backlog check every 3 hours.', null, { bots: ['nightly'], permissions: 'full' }).finished;
  assert.equal(chat.permissions, 'full');
  assert.match(SCHEDULE_NOTE, /typing \/schedule, a time such as every 3h, and the message/); assert.match(SCHEDULE_NOTE, /you cannot create schedules or cron jobs yourself/);
  assert.ok(f.inputs()[0].input.includes(SCHEDULE_NOTE), "the model's answer turn is told");
  const before = f.leads().length, asked = f.inputs().length;
  const run = await f.controller.ask('Do your scheduled work.', chat.id, { bot: 'nightly', scheduled: true }).finished;
  const turns = run.runs.filter(value => value.role === 'bot:nightly');
  assert.ok(turns.length > 0, 'the bot ran'); assert.ok(turns.every(value => value.permissions === 'full'), JSON.stringify(turns.map(value => value.permissions)));
  const modes = f.leads().slice(before).map(call => valueOf(call.args, '--permission-mode'));
  assert.ok(modes.includes('bypassPermissions') && !modes.includes('auto'), modes.join());
  assert.ok(f.inputs().slice(asked).some(row => row.input.includes(SCHEDULE_NOTE)), "the bot's work turn is told");
  assert.equal(readTask(f.controller.repo, chat.id).permissions, 'full', 'the session keeps its own mode');
  // In a session with Approve for me, its scheduled turn has Approve for me.
  const other = await f.controller.ask('Keep the notes tidy.', null, { bots: ['nightly'], permissions: 'auto' }).finished;
  const ran = await f.controller.ask('Do your scheduled work.', other.id, { bot: 'nightly', scheduled: true }).finished;
  const own = ran.runs.filter(value => value.role === 'bot:nightly');
  assert.ok(own.length > 0 && own.every(value => value.permissions === 'auto'), JSON.stringify(own.map(value => value.permissions)));
});

// A mode the owner picked for a new session is saved on its request, so every window and a
// restart know a lower default leaves it. Only the owner's own new session with a mode has one.
test('a picked mode is kept on the request through a rewrite and a retry', async t => {
  const p = project(t), fake = fakeClis(p.parent); environment(t, fake.env);
  const request = enqueue(p.root, 'Normalize coupons', { permissions: 'full', picked: true });
  assert.equal(request.picked, true);
  assert.equal('picked' in enqueue(p.root, 'Rename billing', { permissions: 'full' }), false);
  updateRequest(p.root, request.id, { state: 'blocked', reason: 'Checks are still needed.' });
  assert.equal(retryRequest(p.root, request.id).picked, true);
  updateRequest(p.root, request.id, { state: 'blocked', reason: 'Checks are still needed.' });
  assert.equal(enqueue(p.root, 'Normalize coupons, and trim them', { id: request.id, permissions: 'full' }).picked, true, 'sent again with new text');
  assert.equal(pendingRequests(p.root).find(row => row.id === request.id).picked, true);
  assert.equal(saveRequest(p.root, 'Normalize coupons', request.id, { state: 'blocked' }).picked, true);
  assert.throws(() => enqueue(p.root, 'x', { picked: true }), /Only a mode the owner picked/);
  assert.throws(() => enqueue(p.root, 'x', { permissions: 'auto', picked: 'yes' }), /Only a mode the owner picked/);
  assert.throws(() => enqueue(p.root, 'q', { origin: origin('handoff'), context: 'ctx', permissions: 'auto', picked: true }), /Only a mode the owner picked/);
});

test('a handoff from a teammate runs the mode the owner picked; a teammate question never gets one', async t => {
  const f = setup(t, 'answer');
  const handoff = await f.controller.ask('Work on the request from @sara in the peer data block.', null, { origin: origin('handoff'), context: 'Please rename normalize to normalise.', permissions: 'auto' }).finished;
  assert.equal(handoff.state, 'answered'); assert.equal(handoff.permissions, 'auto'); assert.equal(handoff.runs[0].permissions, 'auto');
  assert.equal(valueOf(f.leads()[0].args, '--permission-mode'), 'auto');
  // The same mode on an ask is ignored: the run is locked, the teammate's text stays in the peer block.
  const ask = await f.controller.ask('Answer the question from @sara.', null, { origin: origin('ask'), readOnly: true, context: 'Where is normalization?', permissions: 'full', folders: [f.work] }).finished;
  assert.equal(ask.state, 'answered'); assert.equal(ask.runs[0].permissions, undefined);
  const run = f.leads()[1].args;
  assert.equal(valueOf(run, '--permission-mode'), 'dontAsk'); assert.equal(run.includes('--permission-prompt-tool'), false); assert.equal(run.includes('--add-dir'), false);
  assert.ok(run.includes('--restricted') && run.includes('--safe-mode'));
  assert.doesNotMatch(f.inputs()[1].input, /You may also read these folders/); assert.doesNotMatch(f.inputs()[1].input, /This session runs with/);
  assert.throws(() => f.controller.ask('More?', ask.id, { origin: origin('ask'), readOnly: true, context: 'x', permissions: 'auto' }), /Teammate questions stay read-only/);
});

test('place branch runs in a worktree with that branch checked out, as it is', async t => {
  const f = setup(t);
  git(f.root, ['checkout', '-q', '-b', 'feat/coupons']);
  fs.writeFileSync(path.join(f.root, 'src/extra.mjs'), 'export const extra = 1;\n'); git(f.root, ['add', '.']); git(f.root, ['commit', '-qm', 'Branch work']);
  const branchHead = git(f.root, ['rev-parse', 'HEAD']);
  git(f.root, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(f.root, 'owner.txt'), 'uncommitted on main');
  const task = await f.controller.ask('Normalize coupon codes', null, { permissions: 'auto', place: 'branch:feat/coupons' }).finished;
  assert.equal(task.state, 'ready'); assert.deepEqual(task.place, { kind: 'branch', branch: 'feat/coupons' });
  assert.equal(task.branch, 'feat/coupons'); assert.equal(task.base, branchHead);
  assert.equal(git(task.worktree, ['branch', '--show-current']), 'feat/coupons'); assert.equal(git(task.worktree, ['rev-parse', 'HEAD']), branchHead);
  assert.ok(fs.existsSync(path.join(task.worktree, 'src/extra.mjs')), 'the branch content is there');
  assert.equal(fs.existsSync(path.join(task.worktree, 'owner.txt')), false, 'the checkout\'s local edits are not copied onto a named branch');
  assert.deepEqual(task.localChanges, []); assert.notEqual(task.worktree, f.root);
  assert.equal(git(f.root, ['branch', '--show-current']), 'main'); assert.equal(fs.readFileSync(path.join(f.root, 'owner.txt'), 'utf8'), 'uncommitted on main');
  assert.equal(git(f.root, ['rev-parse', 'feat/coupons']), branchHead, 'nothing is committed by the run');
  await assert.rejects(f.controller.ask('Normalize coupon codes', null, { permissions: 'auto', place: 'branch:feat/missing' }).finished, /Branch not found: feat\/missing/);
});

test('place here runs in the checkout itself with a dirty tree; checks keep the network on in full', async t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.root, 'src/owner.mjs'), 'export const owner = true;\n');
  const head = git(f.root, ['rev-parse', 'HEAD']);
  assert.throws(() => enqueue(f.root, 'x', { permissions: 'auto', place: 'here' }), /Here needs Full access/);
  const task = await f.controller.ask('Normalize coupon codes', null, { permissions: 'full', place: 'here' }).finished;
  assert.equal(task.state, 'ready'); assert.deepEqual(task.place, { kind: 'here' });
  assert.equal(task.worktree, f.root); assert.equal(task.branch, 'main'); assert.equal(task.base, head); assert.deepEqual(task.localChanges, []);
  assert.equal(fs.readFileSync(path.join(f.root, 'src/coupon.mjs'), 'utf8'), 'export const normalize = (value) => value.toUpperCase();\n', 'the lead edited the checkout');
  assert.equal(fs.readFileSync(path.join(f.root, 'src/owner.mjs'), 'utf8'), 'export const owner = true;\n'); assert.equal(git(f.root, ['rev-parse', 'HEAD']), head);
  assert.equal(fs.existsSync(path.join(f.controller.repo.worktrees, task.id)), false, 'no worktree');
  assert.ok(task.runs.filter(run => run.role === 'lead').every(run => run.permissions === 'full' && run.effectivePermissions === 'full'));
  const names = task.evidence.results.map(row => row.name);
  assert.ok(names.includes('secret-paths') && names.includes('no-deleted-tests'));
  for (const name of ['changed-lines', 'protected-paths', 'unchanged-scripts', 'no-dependency-changes']) assert.equal(names.includes(name), false, `${name} is skipped in full`);
  const sandboxed = f.calls().filter(call => call.vendor === 'codex' && call.args[0] === 'sandbox' && call.args.includes('--'));
  assert.ok(sandboxed.length >= 1, 'the checks ran in the sandbox');
  assert.ok(sandboxed.every(call => call.args.some(arg => arg.includes('network={enabled=true}'))), 'full keeps the network on for checks');
  // A `here` task on the default branch has no branch of its own to publish; nothing is committed first.
  await assert.rejects(f.controller.pushPlan(task.id), /default branch/);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), head);
});

test('full skips the cap and the protected paths but a secret path still blocks; auto allows a lockfile change', t => {
  const dir = temp(t), root = path.join(dir, 'repo'); fs.mkdirSync(root);
  git(root, ['init', '--initial-branch=main']); git(root, ['config', 'user.name', 'T']); git(root, ['config', 'user.email', 't@example.invalid']);
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/a.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', dependencies: { left: '1.0.0' } })); fs.writeFileSync(path.join(root, 'package-lock.json'), '{"name":"x","lockfileVersion":3}\n');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'init']);
  const base = git(root, ['rev-parse', 'HEAD']), config = defaultConfig();
  fs.writeFileSync(path.join(root, 'src/a.mjs'), Array.from({ length: 500 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', dependencies: { left: '1.0.0', right: '2.0.0' } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"name":"x","lockfileVersion":3,"packages":{}}\n');
  fs.writeFileSync(path.join(root, 'src/.env'), 'SECRET=x\n');
  const task = { worktree: root, base, place: { kind: 'worktree' } };
  const status = (mode) => Object.fromEntries(structuralChecks(task, config, { mode }).results.map(row => [row.name, row.status]));
  const locked = status('locked');
  assert.equal(locked['changed-lines'], 'failed'); assert.equal(locked['protected-paths'], 'failed'); assert.equal(locked['no-dependency-changes'], 'failed'); assert.equal(locked['secret-paths'], 'failed');
  const auto = status('auto');
  assert.equal(auto['changed-lines'], 'failed'); assert.equal(auto['protected-paths'], 'passed', 'dependency files are not protected in auto'); assert.equal(auto['no-dependency-changes'], undefined); assert.equal(auto['unchanged-scripts'], 'passed');
  const full = status('full');
  assert.equal(full['changed-lines'], undefined); assert.equal(full['protected-paths'], undefined); assert.equal(full['unchanged-scripts'], undefined); assert.equal(full['no-dependency-changes'], undefined);
  assert.equal(full['secret-paths'], 'failed'); assert.equal(full['no-deleted-tests'], 'passed'); assert.equal(full['declared-paths'], 'passed');
  for (const file of ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock']) { assert.equal(protectedPath(file), true, file); assert.equal(protectedPath(file, { mode: 'ask' }), true); assert.equal(protectedPath(file, { mode: 'auto' }), false); assert.equal(protectedPath(file, { mode: 'full' }), false); }
  for (const file of ['.github/workflows/ci.yml', '.git/config', 'Makefile', 'tsconfig.json']) for (const mode of ['locked', 'ask', 'auto', 'full']) assert.equal(protectedPath(file, { mode }), true, `${file} in ${mode}`);
  const args = sandboxArgs({ cwd: root, scratch: path.join(dir, 'scratch'), program: 'node', helper: process.execPath, network: 'on' });
  assert.ok(args.some(arg => arg.includes('network={enabled=true}')));
  assert.ok(sandboxArgs({ cwd: root, scratch: path.join(dir, 'scratch'), program: 'node', helper: process.execPath }).some(arg => arg.includes('network={enabled=false}')));
});

// The fake Claude starts the relay from --mcp-config exactly as the real one would and asks
// to touch a file outside the workspace. The test is the owner at the terminal.
async function answering(f, decision, { delay = 0 } = {}) {
  const answered = [];
  for (;;) {
    const rows = pendingApprovals({ root: f.controller.repo.project ?? f.controller.repo.root });
    for (const row of rows) { if (delay) await sleep(delay); answerApproval(row.id, decision); answered.push(row); }
    if (f.done) return answered;
    await sleep(25);
  }
}
async function relay(f, decision, options) {
  const run = f.controller.ask('Normalize coupon codes', null, { permissions: 'auto' });
  const finished = run.finished.finally(() => { f.done = true; });
  const [task, answered] = await Promise.all([finished, answering(f, decision, options)]);
  return { task, answered };
}

test('an allowed approval reaches Claude through the relay and is kept with the task', async t => {
  const f = setup(t, 'relay');
  const { task, answered } = await relay(f, 'allow');
  assert.equal(task.state, 'ready');
  assert.ok(answered.length >= 1); assert.ok(answered.every(row => row.summary.startsWith('Run: touch ') && row.tool === 'Bash' && row.role === 'lead' && row.vendor === 'claude' && row.taskId === task.id));
  assert.ok(fs.existsSync(path.join(f.fake.dir, 'touched')), 'the allowed touch happened');
  assert.equal(task.approvals.length, answered.length);
  // row.session is the id the run was started with; the fake reports its own fixed session id, so the tie is the relay log named after it.
  for (const row of task.approvals) { assert.equal(row.decision, 'allow'); assert.equal(row.tool, 'Bash'); assert.equal(row.role, 'lead'); assert.match(row.summary, /^Run: touch /); assert.ok(fs.existsSync(path.join(taskDir(f.controller.repo, task.id), `lead-${row.session}.approvals.jsonl`))); }
  assert.ok(task.runs.filter(run => run.role === 'lead').every(run => run.denials === undefined));
  const dances = f.calls().filter(call => call.approval);
  // The owner's own session also gets the tools for his other computers (lib/approval-server.mjs).
  assert.ok(dances.length >= 1); assert.deepEqual(dances[0].approval.tools, ['approve', 'list_other_sessions', 'send_to_session']); assert.equal(dances[0].approval.decision.behavior, 'allow');
  assert.equal(pendingApprovals().length, 0);
  const log = fs.readdirSync(taskDir(f.controller.repo, task.id)).filter(name => name.endsWith('.approvals.jsonl'));
  assert.ok(log.length >= 1); assert.equal(fs.statSync(path.join(taskDir(f.controller.repo, task.id), log[0])).mode & 0o777, 0o600);
});

// The relay removes an approval's two files once it is decided. Looked at between the two
// removals, the request must not read as still waiting: the owner would be shown it again
// (the test above would count it twice), and a second answer would be left with no request.
test('a decided approval is not listed as waiting while its files are removed', async t => {
  const f = setup(t);
  requestApproval({ id: 'decided', root: f.root, taskId: '1', role: 'lead', vendor: 'claude', tool: 'Bash', input: { command: 'npm test' } });
  assert.deepEqual(pendingApprovals().map(row => row.id), ['decided']); assert.equal(answerApproval('decided', 'allow'), true);
  // A failed assertion inside a removal would be swallowed there, so each look is kept and checked after.
  const looks = [], remove = fs.rmSync; let looking = false;
  t.mock.method(fs, 'rmSync', (file, options) => {
    remove(file, options); if (looking) return;
    looking = true; try { looks.push({ removed: path.basename(String(file)), waiting: pendingApprovals().map(row => row.id), answeredAgain: answerApproval('decided', 'deny') }); } finally { looking = false; }
  });
  assert.equal(await awaitDecision('decided', { waitSeconds: 5 }), 'allow');
  assert.deepEqual(looks.map(look => look.removed).sort(), ['decided.answer.json', 'decided.json']);
  for (const look of looks) { assert.deepEqual(look.waiting, [], `listed again once ${look.removed} was removed`); assert.equal(look.answeredAgain, false, `answered again once ${look.removed} was removed`); }
  assert.deepEqual(fs.readdirSync(approvalsDir()), []);
});

test('a denied approval is reported as a denial on the run, and nothing was touched', async t => {
  const f = setup(t, 'relay');
  const { task, answered } = await relay(f, 'deny');
  assert.ok(answered.length >= 1); assert.equal(fs.existsSync(path.join(f.fake.dir, 'touched')), false);
  assert.ok(task.approvals.every(row => row.decision === 'deny'));
  const leads = task.runs.filter(run => run.role === 'lead' && run.vendor === 'claude');
  assert.ok(leads.length >= 1);
  for (const run of leads) { assert.equal(run.denials.length, 1); assert.equal(run.denials[0].tool, 'Bash'); assert.match(run.denials[0].input.command, /^touch /); assert.equal(run.denials[0].tool_use_id, 'toolu_fake_touch'); }
  assert.equal(f.calls().filter(call => call.approval).at(-1).approval.decision.behavior, 'deny');
});

test('the role time limit waits while an approval is pending', async t => {
  const f = setup(t, 'relay');
  // Without the hold a 5 s limit would kill a run that waits 6 s for its answer.
  f.controller.draftConfig.roles.lead.timeoutSeconds = 5; f.controller.draftConfig.checks = [];
  const { task, answered } = await relay(f, 'allow', { delay: 6000 });
  assert.ok(answered.length >= 1);
  assert.ok(task.runs.filter(run => run.role === 'lead').every(run => run.code === 0), 'the run was not killed while it waited');
  assert.ok(['ready', 'unverified'].includes(task.state), task.error?.message);
  assert.equal(pendingApprovals().length, 0);
});

test('a session reads the .npmrc its repository tracks in Full and in Ask; an untracked one stays closed', async t => {
  const f = setup(t, 'answer');
  fs.mkdirSync(path.join(f.root, 'backend/agents'), { recursive: true }); fs.writeFileSync(path.join(f.root, 'backend/agents/.npmrc'), 'registry=https://registry.npmjs.org/\n');
  git(f.root, ['add', 'backend/agents/.npmrc']); git(f.root, ['commit', '-m', 'Track npmrc']);
  fs.writeFileSync(path.join(f.root, '.env'), 'API_KEY=secret\n');
  for (const mode of ['full', 'ask']) {
    const task = await f.controller.ask('What registry does the backend use?', null, { permissions: mode }).finished;
    assert.equal(task.state, 'answered', task.error?.message);
    const args = f.leads().at(-1).args, { deny } = settingsOf(args).permissions;
    assert.equal(valueOf(args, '--permission-mode'), mode === 'full' ? 'bypassPermissions' : 'default');
    assert.equal(deny.some(rule => rule.includes('backend') || rule.startsWith('Read(**/')), false, `${mode}: no rule closes the tracked .npmrc, by path or by name`);
    assert.ok(deny.some(rule => rule === `Read(//${path.join(f.root, '.env').slice(1)})` || rule === `Read(//${path.join(fs.realpathSync(f.root), '.env').slice(1)})`), `${mode}: the untracked .env is not`);
    if (mode === 'ask') assert.equal(settingsOf(args).sandbox.filesystem.denyRead.some(entry => entry.includes('backend') || entry.startsWith('**/')), false, 'nor does the sandbox hide it');
  }
});

// The turn limits, shrunk for a test: a turn that prints nothing for quietSeconds stops.
function quickClock(t, quietSeconds = 2, capSeconds = 7200) {
  const before = { ...turnClock }; Object.assign(turnClock, { quietSeconds, capSeconds }); t.after(() => Object.assign(turnClock, before));
}

test('a turn that keeps printing is never cut by the clock, even past a timeoutSeconds the policy names', async t => {
  const f = setup(t, 'chatty'); quickClock(t);
  // One second, which as the old time limit would have stopped every turn here.
  f.controller.draftConfig.roles.lead.timeoutSeconds = 1; f.controller.draftConfig.checks = [];
  const started = Date.now(), task = await f.controller.ask('Normalize coupon codes', null, { permissions: 'full' }).finished;
  assert.ok(['ready', 'unverified'].includes(task.state), task.error?.message);
  assert.ok(Date.now() - started > 6000, 'each turn printed for three seconds');
  assert.ok(task.runs.filter(run => run.role === 'lead').every(run => run.code === 0));
});

test('a turn that prints nothing for the quiet limit stops with one line, keeps its edits, and a frozen 900 reads as the default', async t => {
  const f = setup(t, 'stall'); quickClock(t);
  // A session from before: its policy was frozen with the old default, which nobody chose.
  f.controller.draftConfig.roles.lead.timeoutSeconds = 900; f.controller.draftConfig.checks = [];
  const started = Date.now(), run = f.controller.ask('Normalize coupon codes', null, { permissions: 'full' });
  await assert.rejects(run.finished, /Stopped after 2 seconds with no output\. Your changes are kept\. Reply to carry on\.$/);
  assert.ok(Date.now() - started < 30000, 'stopped by the quiet limit, not by the fake ending');
  const task = readTask(f.controller.repo, run.id);
  assert.match(fs.readFileSync(path.join(taskDir(f.controller.repo, task.id), 'policy.yaml'), 'utf8'), /timeoutSeconds: 900/, 'the frozen policy still says 900 and still loads');
  assert.equal(task.state, 'blocked'); assert.equal(task.error.message, 'Stopped after 2 seconds with no output. Your changes are kept. Reply to carry on.');
  assert.doesNotMatch(task.error.message, /could not finish/);
  assert.equal(fs.readFileSync(path.join(task.worktree, 'src/coupon.mjs'), 'utf8'), 'export const normalize = (value) => value.toUpperCase();\n', 'the edit stays on disk');
});

test('an approval waiting for the owner is not quiet: the turn waits past the quiet limit', async t => {
  const f = setup(t, 'relay'); quickClock(t); f.controller.draftConfig.checks = [];
  const { task, answered } = await relay(f, 'allow', { delay: 4000 });
  assert.ok(answered.length >= 1);
  assert.ok(task.runs.filter(run => run.role === 'lead').every(run => run.code === 0), 'the run was not stopped while it waited');
  assert.ok(['ready', 'unverified'].includes(task.state), task.error?.message);
});

test('bypassPermissions never asks: a full session touches without an approval', async t => {
  const f = setup(t, 'relay');
  const run = f.controller.ask('Normalize coupon codes', null, { permissions: 'full' });
  const task = await run.finished;
  assert.equal(task.state, 'ready'); assert.equal(task.approvals, undefined);
  assert.equal(fs.existsSync(path.join(f.fake.dir, 'touched')), false, 'the fake only touches through the relay');
  assert.equal(f.calls().filter(call => call.approval).length, 0);
  const { turns, reviews } = callsOf(f, task); assert.equal(turns.length, 2); assert.equal(reviews.length, 1);
  assert.ok(turns.every(call => valueOf(call.args, '--permission-mode') === 'bypassPermissions'));
  assert.ok(reviews.every(call => valueOf(call.args, '--permission-mode') === 'dontAsk'), 'a review never runs with Full access');
});

test('a saved task without a place is a worktree task; a mode switch on a running task waits for its turn', async t => {
  const f = setup(t, 'answer');
  const first = await f.controller.ask('Explain', null, { permissions: 'ask' }).finished;
  const saved = readTask(f.controller.repo, first.id); delete saved.place; delete saved.folders; saveTask(f.controller.repo, saved);
  const second = await f.controller.ask('Again', first.id).finished;
  assert.equal(second.permissions, 'ask'); assert.equal(second.place, undefined); assert.equal(valueOf(f.leads()[1].args, '--permission-mode'), 'default');
  assert.deepEqual(settingsOf(f.leads()[1].args).permissions.ask.slice(0, 2), ['WebFetch', 'WebSearch']);
  const repo = repository(f.root); assert.equal(repo.root, f.root);
});

// The owner's own case: his session asks, its turn waits on an approval, and he sets the
// mode. The turn holds the session for its whole length and writes its own copy of the
// record back when it ends.
test('a mode set while a turn waits on an approval is never refused, reads back at once and is kept when the turn ends', async t => {
  const f = setup(t, 'relay'), root = f.controller.repo.project ?? f.controller.repo.root;
  const run = f.controller.ask('Normalize coupon codes', null, { permissions: 'ask' });
  const finished = run.finished.finally(() => { f.done = true; });
  // A failure below must not leave the turn waiting on its approval.
  t.after(async () => { for (const row of pendingApprovals({ root })) answerApproval(row.id, 'deny'); await finished.catch(() => {}); });
  let waiting = [];
  while (!waiting.length && !f.done) { waiting = pendingApprovals({ root }); await sleep(25); }
  assert.equal(waiting.length, 1, 'the turn waits on an approval'); assert.equal(readTask(f.controller.repo, run.id).state, 'running');
  for (const mode of ['auto', 'ask', 'full']) {
    assert.equal(f.controller.setPermissions(run.id, mode).permissions, mode);
    assert.equal(readTask(f.controller.repo, run.id).permissions, mode, `${mode} reads back while the turn runs`);
  }
  assert.equal(f.controller.setBudget(run.id, 7).budgetUsd, 7); assert.deepEqual(f.controller.addFolder(run.id, f.work).folders, [fs.realpathSync(f.work)]);
  assert.equal(readTask(f.controller.repo, run.id).budgetUsd, 7); assert.equal(f.controller.budget(run.id).limit, 7);
  assert.equal(pendingApprovals({ root }).length, 1, 'the approval still waits: saving the mode answers nothing');
  const [task] = await Promise.all([finished, answering(f, 'allow')]);
  assert.ok(['ready', 'unverified'].includes(task.state), task.error?.message);
  const saved = JSON.parse(fs.readFileSync(path.join(taskDir(f.controller.repo, run.id), 'task.json'), 'utf8'));
  assert.equal(saved.permissions, 'full'); assert.deepEqual(saved.permissionChanges.map(row => [row.from, row.to]), [['ask', 'auto'], ['auto', 'ask'], ['ask', 'full']]);
  assert.deepEqual(saved.folders, [fs.realpathSync(f.work)]);
  assert.equal(fs.existsSync(path.join(taskDir(f.controller.repo, run.id), 'settings.json')), false, 'nothing is left beside the record');
  // The turn that was waiting started with Ask for approval; the next one runs with what he chose.
  const { turns } = callsOf(f, task);
  assert.equal(valueOf(turns[0].args, '--permission-mode'), 'default'); assert.equal(valueOf(turns.at(-1).args, '--permission-mode'), 'bypassPermissions');
});

test('settings changed while a turn holds the session wait beside the record, read back at once, and the turn takes them in when it saves', async t => {
  const f = setup(t, 'answer');
  const first = await f.controller.ask('Explain', null, { permissions: 'ask' }).finished, repo = f.controller.repo, id = first.id;
  const record = () => JSON.parse(fs.readFileSync(path.join(taskDir(repo, id), 'task.json'), 'utf8')), beside = path.join(taskDir(repo, id), 'settings.json');
  // With nothing running the record itself is written, as before.
  f.controller.setPermissions(id, 'auto'); assert.equal(record().permissions, 'auto'); assert.equal(fs.existsSync(beside), false);
  // A turn: it holds the session and keeps its own copy of the record.
  let release = lock(repo, `task-${id}`), held = readTask(repo, id);
  f.controller.setPermissions(id, 'full'); f.controller.setBudget(id, 12); f.controller.addFolder(id, f.work); f.controller.setBots(id, []);
  assert.equal(record().permissions, 'auto', 'the record is the turn’s to write'); assert.ok(fs.existsSync(beside));
  const now = readTask(repo, id);
  assert.equal(now.permissions, 'full'); assert.equal(now.budgetUsd, 12); assert.deepEqual(now.folders, [fs.realpathSync(f.work)]); assert.deepEqual(now.bots, []);
  assert.deepEqual(now.permissionChanges.map(row => [row.from, row.to]), [['ask', 'auto'], ['auto', 'full']]);
  f.controller.setBudget(id, null); assert.equal(readTask(repo, id).budgetUsd, undefined, 'a limit taken away mid-turn is away');
  // The turn saves its own copy: the changes are in the record and in its copy, and no longer beside it.
  held.messages.push({ at: new Date().toISOString(), text: 'More.' }); saveTask(repo, held); release();
  assert.equal(held.permissions, 'full'); assert.equal(record().permissions, 'full'); assert.equal(record().messages.at(-1).text, 'More.');
  assert.equal(record().budgetUsd, undefined); assert.deepEqual(record().bots, []); assert.deepEqual(record().folders, [fs.realpathSync(f.work)]);
  assert.equal(fs.existsSync(beside), false);
  // What the turn itself changed is kept when the owner changed something else meanwhile.
  release = lock(repo, `task-${id}`); held = readTask(repo, id);
  held.bots = ['reviewer']; f.controller.setPermissions(id, 'ask'); saveTask(repo, held); release();
  assert.deepEqual(record().bots, ['reviewer']); assert.equal(record().permissions, 'ask'); assert.equal(fs.existsSync(beside), false);
  // A change that came as the turn ended, after its last save, still reads back and is taken in by the next save.
  release = lock(repo, `task-${id}`); held = readTask(repo, id); saveTask(repo, held); f.controller.setPermissions(id, 'auto'); release();
  assert.equal(record().permissions, 'ask'); assert.equal(readTask(repo, id).permissions, 'auto');
  f.controller.setBudget(id, 3); assert.equal(record().permissions, 'auto'); assert.equal(record().budgetUsd, 3); assert.equal(fs.existsSync(beside), false);
});

test('a session with a spending limit keeps it when its conversation becomes an editing run, and that run is launched with it', async t => {
  const f = setup(t, 'relay'), root = f.controller.repo.project ?? f.controller.repo.root;
  const run = f.controller.ask('Normalize coupon codes', null, { permissions: 'ask' });
  const finished = run.finished.finally(() => { f.done = true; });
  t.after(async () => { for (const row of pendingApprovals({ root })) answerApproval(row.id, 'deny'); await finished.catch(() => {}); });
  // The limit is set while the conversation's own turn waits on an approval; the edit follows in the same message.
  let waiting = [];
  while (!waiting.length && !f.done) { waiting = pendingApprovals({ root }); await sleep(25); }
  assert.equal(waiting.length, 1, 'the conversation waits on an approval'); f.controller.setBudget(run.id, 7);
  const [task] = await Promise.all([finished, answering(f, 'allow')]);
  assert.notEqual(task.kind, 'conversation', 'the session went on to edit');
  assert.equal(readTask(f.controller.repo, run.id).budgetUsd, 7); assert.equal(f.controller.budget(run.id).limit, 7);
  const { turns } = callsOf(f, task);
  assert.equal(valueOf(turns[0].args, '--max-budget-usd'), undefined, 'the turn that had begun had no limit');
  assert.equal(valueOf(turns.at(-1).args, '--max-budget-usd'), '7', 'the editing run is launched with the limit');
});

// ELU keeps its records of every session in the repository's Git folder. A Read only
// session runs in the project folder, where that folder is inside the working directory.
test('a Read only session may not read ELU\'s records in the Git folder, with the file tools or from a command', async t => {
  const f = setup(t, 'answer'), common = fs.realpathSync(path.join(f.root, '.git')), records = path.join(common, 'elu-code');
  const task = await f.controller.ask('Explain the change', null).finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  const args = f.leads().at(-1).args, settings = settingsOf(args);
  assert.ok(args.includes('--restricted'), 'a Read only launch');
  for (const rule of [`Read(//${records.slice(1)})`, `Read(//${records.slice(1)}/**)`]) assert.ok(settings.permissions.deny.includes(rule), rule);
  const real = entry => { try { return fs.realpathSync(entry); } catch { return entry; } };
  assert.ok(settings.sandbox.filesystem.denyRead.some(entry => [common, records].includes(real(entry))), 'a command cannot read them either');
});

// git needs to read the repository to answer status, diff and log. A sandboxed command reads
// the Git folder for that and may not write there; ELU's records in it stay closed.
test('in Read only, Ask for approval and Approve for me a sandboxed command reads the repository\'s Git folder, and none of ELU\'s records in it', async t => {
  const f = setup(t, 'answer'), common = fs.realpathSync(path.join(f.root, '.git')), records = path.join(common, 'elu-code');
  for (const [permissions, label] of [['ask', 'Ask for approval'], ['auto', 'Approve for me'], [undefined, 'Read only']]) {
    const task = await f.controller.ask('Where is coupon normalization?', null, permissions ? { permissions } : undefined).finished;
    assert.equal(task.state, 'answered', `${label} ${JSON.stringify(task.error)}`);
    const args = f.leads().at(-1).args, { denyRead, denyWrite } = settingsOf(args).sandbox.filesystem;
    assert.equal(args.includes('--restricted'), label === 'Read only', label);
    assert.deepEqual([...new Set(gitEntries(denyRead))], [records], `${label}: a command reads the Git folder but for the records`);
    assert.ok(gitEntries(denyWrite).includes(common), `${label}: a command writes nothing in the Git folder`);
  }
  // A teammate's question is given tracked files only: its commands read none of the folder.
  const peer = await f.controller.ask('Answer the question from @sara.', null, { origin: origin('ask'), readOnly: true, context: 'Where is normalization?' }).finished;
  assert.equal(peer.state, 'answered', JSON.stringify(peer.error));
  const closed = settingsOf(f.leads().at(-1).args).sandbox.filesystem;
  assert.ok(gitEntries(closed.denyRead).includes(common), 'the whole folder stays closed to a teammate\'s question');
});

// Approvals you give once, end to end with the fake Claude and the real relay: the owner keeps
// one approval as a rule (what a in the terminal does), and the next session that runs the
// same command is not asked. A default never asks; the never list always does; a teammate's
// session uses the defaults only, and one from the owner's own machine uses his rules.
test('a rule kept once answers the next session; defaults never ask; the never list does; a teammate\'s session gets the defaults only', { timeout: 60000 }, async t => {
  const f = setup(t, 'relay'), root = f.controller.repo.project ?? f.controller.repo.root;
  const asking = asks => fakeClis(f.parent, { mode: 'relay', intent: 'answer', asks: asks.map(([command, outside = true]) => ({ tool_name: 'Bash', input: { command, ...(outside ? { dangerouslyDisableSandbox: true } : {}) } })) });
  // Every request that waits is denied and kept, so a run never hangs on one.
  const settle = async (run, keep = null) => {
    const asked = []; let done = false; const finished = run.finished.finally(() => { done = true; });
    while (!done) { for (const row of pendingApprovals({ root })) { asked.push(row); if (keep?.(row)) continue; answerApproval(row.id, 'deny'); } await sleep(25); }
    return { task: await finished, asked };
  };
  asking([['npm test']]);
  // The first session asks; the owner keeps it for this project, and it is allowed.
  let offered = null;
  const first = await settle(f.controller.ask('Run the tests', null, { permissions: 'ask' }), row => {
    if (offered) return false;
    assert.equal(row.rules, 'saved'); assert.equal(row.access, 'read'); assert.deepEqual(row.input, { command: 'npm test', dangerouslyDisableSandbox: true });
    assert.equal(row.sandboxed, true, 'the fake runs where the sandbox starts');
    offered = ruleFor(row.tool, row.input, { project: row.root, cwd: row.cwd, access: row.access, sandboxed: row.sandboxed });
    assert.equal(offered.summary, 'Run npm test, with any arguments, also outside the sandbox');
    saveRule(offered.rule, { scope: 'project', project: row.root }); answerApproval(row.id, 'allow'); return true;
  });
  assert.equal(first.task.state, 'answered', JSON.stringify(first.task.error)); assert.equal(first.asked.length, 1);
  assert.deepEqual(first.task.approvals.map(row => [row.decision, row.by ?? null]), [['allow', null]]);
  // A new session runs the same command: nothing waits, and the decision names the rule.
  const second = await settle(f.controller.ask('Run the tests again', null, { permissions: 'ask' }));
  assert.deepEqual(second.asked, []); assert.equal(second.task.state, 'answered');
  assert.deepEqual(second.task.approvals.map(row => [row.summary, row.decision, row.by, row.rule]), [['Run: npm test outside the sandbox', 'allow', 'rule', 'npm test']]);
  assert.ok(fs.readFileSync(path.join(f.fake.dir, 'ran.jsonl'), 'utf8').includes('"npm test"'), 'the command ran');
  // A default never asks; the never list asks every time, whatever is saved.
  asking([['git status', false], ['git push origin main']]);
  const third = await settle(f.controller.ask('Check and push', null, { permissions: 'ask' }));
  assert.deepEqual(third.asked.map(row => row.summary), ['Run: git push origin main outside the sandbox']);
  assert.equal(ruleFor(third.asked[0].tool, third.asked[0].input).refused, 'That is on the never list, so it runs only in Full access.');
  assert.deepEqual(third.task.approvals.map(row => [row.summary, row.decision, row.by ?? null]), [['Run: git status', 'allow', 'default'], ['Run: git push origin main outside the sandbox', 'deny', null]]);
  // A session a teammate started: the defaults answer, the owner's rule does not.
  asking([['git status', false], ['npm test']]);
  const theirs = await settle(f.controller.ask('Work on the request from @sara in the peer data block.', null, { origin: origin('handoff'), context: 'Run the tests.', permissions: 'ask' }));
  assert.deepEqual(theirs.asked.map(row => [row.summary, row.rules]), [['Run: npm test outside the sandbox', 'defaults']]);
  assert.deepEqual(theirs.task.approvals.map(row => [row.decision, row.by ?? null]), [['allow', 'default'], ['deny', null]]);
  // One the owner's own other computer started (origin.mine, lib/peer/remote.mjs) uses his rules.
  const mine = await settle(f.controller.ask('Run the tests.', null, { mine: { machine: 'c'.repeat(64), name: 'ali', remoteId: '0f0e0d0c-0b0a-4908-8706-050403020100' }, permissions: 'ask' }));
  assert.deepEqual(mine.asked, []); assert.equal(mine.task.origin.mine, true); assert.equal(mine.task.origin.peer, undefined);
  assert.deepEqual(mine.task.approvals.map(row => [row.decision, row.by, row.rule]), [['allow', 'default', 'git status'], ['allow', 'rule', 'npm test']]);
});

// Where user namespaces are turned off, bwrap can still make a network namespace when it runs as
// root or is installed setuid, but Claude Code's sandbox always makes a user namespace, so it does
// not start and Claude Code runs every command outside it. A default that holds only inside the
// sandbox (git reads, the project's checks) must then wait for the owner, as with no sandbox at all.
test('where bwrap cannot make a user namespace, a command counts as outside the sandbox: a default that needs the sandbox waits for the owner', { skip: process.platform !== 'linux', timeout: 60000 }, async t => {
  const f = setup(t, 'relay'), root = f.controller.repo.project ?? f.controller.repo.root;
  const tools = path.join(f.parent, 'no-user-namespaces'); fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, 'bwrap'), '#!/bin/sh\nfor arg in "$@"; do [ "$arg" = --unshare-user ] && { echo "bwrap: No permission to create new namespace" >&2; exit 1; }; done\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tools, 'socat'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  environment(t, { PATH: `${tools}${path.delimiter}${process.env.PATH}` });
  fakeClis(f.parent, { mode: 'relay', intent: 'answer', asks: [{ tool_name: 'Bash', input: { command: 'git status' } }] });
  const asked = [], run = f.controller.ask('Check the tree', null, { permissions: 'ask' }); let done = false; const finished = run.finished.finally(() => { done = true; });
  while (!done) { for (const row of pendingApprovals({ root })) { asked.push(row); answerApproval(row.id, 'deny'); } await sleep(25); }
  const task = await finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  assert.deepEqual(asked.map(row => [row.summary, row.sandboxed === true]), [['Run: git status', false]], 'the owner was asked, and the turn was not taken as sandboxed');
  assert.deepEqual(task.approvals.map(row => [row.summary, row.decision, row.by ?? null]), [['Run: git status', 'deny', null]]);
  assert.equal(fs.existsSync(path.join(f.fake.dir, 'ran.jsonl')), false, 'nothing ran outside the sandbox without the owner');
});

// The owner's bug: a sandboxed command in Ask for approval connected to a host, Claude Code
// asked on its own output, its input was already closed, and the host was denied as "user
// denied" though nobody was asked. Now the question reaches the owner and his answer reaches Claude.
test('in Ask for approval a host a sandboxed command connects to is asked once, the answer reaches Claude, and the session keeps it', { timeout: 60000 }, async t => {
  const f = setup(t, 'answer'), root = f.controller.repo.project ?? f.controller.repo.root;
  const connecting = hosts => fakeClis(f.parent, { mode: 'answer', network: hosts });
  const connections = () => { const file = path.join(f.fake.dir, 'network.jsonl'); const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : []; fs.rmSync(file, { force: true }); return rows; };
  const settle = async (run, answer) => {
    const asked = []; let done = false; const finished = run.finished.finally(() => { done = true; });
    while (!done) { for (const row of pendingApprovals({ root })) { asked.push(row); answerApproval(row.id, answer(row)); } await sleep(25); }
    return { task: await finished, asked };
  };
  connecting(['elu.dev', 'elu.dev']);
  const first = await settle(f.controller.ask('Check the MCP endpoint', null, { permissions: 'ask' }), () => 'allow');
  assert.equal(first.task.state, 'answered', JSON.stringify(first.task.error));
  assert.deepEqual(first.asked.map(row => [row.tool, row.summary, row.input]), [['SandboxNetworkAccess', 'Network access to elu.dev', { host: 'elu.dev' }]]);
  assert.deepEqual(connections(), [{ host: 'elu.dev', allowed: true, asked: true, streaming: true }, { host: 'elu.dev', allowed: true, asked: false, streaming: true }]);
  assert.deepEqual(first.task.approvals.map(row => [row.tool, row.summary, row.decision, row.host]), [['SandboxNetworkAccess', 'Network access to elu.dev', 'allow', 'elu.dev']]);
  let run = f.leads().at(-1);
  assert.equal(valueOf(run.args, '--input-format'), 'stream-json'); assert.deepEqual(settingsOf(run.args).sandbox.network.allowedDomains, []);
  assert.match(f.inputs().at(-1).input, /Check the MCP endpoint/);
  // The next turn of the same session starts with the host allowed: nothing is asked.
  const second = await settle(f.controller.ask('Again', first.task.id), () => 'deny');
  assert.equal(second.task.state, 'answered'); assert.deepEqual(second.asked, []);
  assert.deepEqual(settingsOf(f.leads().at(-1).args).sandbox.network.allowedDomains, ['elu.dev']);
  assert.deepEqual(connections(), [{ host: 'elu.dev', allowed: true, asked: false, streaming: true }, { host: 'elu.dev', allowed: true, asked: false, streaming: true }]);
  // A denied host fails the command, and only the answer the owner gave is kept.
  connecting(['example.com']);
  const third = await settle(f.controller.ask('Fetch the example', null, { permissions: 'ask' }), () => 'deny');
  assert.deepEqual(third.asked.map(row => row.summary), ['Network access to example.com']);
  assert.deepEqual(connections(), [{ host: 'example.com', allowed: false, asked: true, streaming: true }]);
  assert.deepEqual(third.task.approvals.map(row => [row.decision, row.host]), [['deny', 'example.com']]);
  // The owner keeps the host for this project: the next session is answered by the rule.
  const fourth = await settle(f.controller.ask('Fetch the example again', null, { permissions: 'ask' }), row => {
    const offered = ruleFor(row.tool, row.input, { project: row.root, cwd: row.cwd, access: row.access, sandboxed: row.sandboxed });
    assert.equal(offered.summary, 'Allow network access to example.com'); assert.equal(offered.line, 'Allow network access to example.com without asking.');
    saveRule(offered.rule, { scope: 'project', project: row.root }); return 'allow';
  });
  assert.equal(fourth.asked.length, 1); connections();
  const fifth = await settle(f.controller.ask('And once more', null, { permissions: 'ask' }), () => 'deny');
  assert.deepEqual(fifth.asked, []); assert.deepEqual(connections(), [{ host: 'example.com', allowed: true, asked: true, streaming: true }]);
  assert.deepEqual(fifth.task.approvals.map(row => [row.decision, row.by, row.rule, row.host]), [['allow', 'rule', 'network access to example.com', 'example.com']]);
  // A host that takes pushes never becomes a rule, and is asked again in the next turn.
  assert.equal(ruleFor('SandboxNetworkAccess', { host: 'github.com' }).refused, 'This host publishes, pushes or deploys, so it is asked each time.');
  connecting(['github.com']);
  const push = await settle(f.controller.ask('Push it', null, { permissions: 'ask' }), () => 'allow');
  const pushAgain = await settle(f.controller.ask('Push it again', push.task.id), () => 'deny');
  assert.deepEqual([push.asked.length, pushAgain.asked.length], [1, 1]); assert.deepEqual(settingsOf(f.leads().at(-1).args).sandbox.network.allowedDomains, []);
  assert.deepEqual(connections(), [{ host: 'github.com', allowed: true, asked: true, streaming: true }, { host: 'github.com', allowed: false, asked: true, streaming: true }]);
  // Approve for me decides without the owner, and Full access has no sandbox: neither streams its input.
  connecting([]);
  await f.controller.ask('Look', null, { permissions: 'auto' }).finished;
  assert.equal(valueOf(f.leads().at(-1).args, '--input-format'), undefined);
  await f.controller.ask('Look', null, { permissions: 'full' }).finished;
  assert.equal(valueOf(f.leads().at(-1).args, '--input-format'), undefined);
});

// Before: the prompt went in as text, so the input was closed and the host was denied unasked.
test('a run whose prompt goes in as text gets every host it asks about denied without anyone being asked', async t => {
  const f = setup(t, 'answer'); fakeClis(f.parent, { mode: 'answer', network: ['elu.dev'] });
  await f.controller.ask('Look', null, { permissions: 'auto' }).finished;
  const rows = fs.readFileSync(path.join(f.fake.dir, 'network.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows, [{ host: 'elu.dev', allowed: false, asked: false, streaming: false }]);
});
