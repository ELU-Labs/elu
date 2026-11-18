import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { temp, project, fakeClis, git, keyThenEnter } from './helpers.mjs';
import { liveTask } from './peer-helpers.mjs';
import { Conductor, enqueue } from '../lib/conductor.mjs';
import { pendingRequests, projectFolder } from '../lib/workspace.mjs';
import { FULL_UNASKED, ProjectController, QUESTION_CHANGED, registerProject } from '../lib/projects.mjs';
import { readTask, saveTask, lock } from '../lib/state.mjs';
import { currentTask, sessionTasks } from '../lib/plan.mjs';
import { getBot, removeBot, saveBot } from '../lib/bots.mjs';
import { closeSession, readBoard, setDone } from '../lib/kanban.mjs';
import { OWN_COMMANDS } from '../lib/session-commands.mjs';
import { KEEP_GOING_TEXT } from '../lib/elu-sent.mjs';
import { STANDUP_QUESTION, newRound } from '../lib/standup.mjs';
import { actionsFile, questionMark } from '../lib/orchestrator-actions.mjs';
import { NOTE_WAITS, sessionsDigest } from '../lib/runner.mjs';
import { answerApproval, approvalsDir, pendingApprovals, requestApproval } from '../lib/approvals.mjs';
import { serve, TOOL_NAME } from '../lib/approval-server.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { processIdentity } from '../lib/process.mjs';
import { askedWhole, fullAllowed, launchTerminal } from '../lib/terminal.mjs';

// What the bot that oversees the owner's sessions may reach, and when: a turn it leads never
// has ELU's own commands or the owner's yes, only the owner writes to it, its answer goes in
// only to the question it was written for, and nothing of its goes to a session he archived or
// moved to Done. The turns run on the stand-in vendors (test/fakes), in a project of the test's own.
const cleanups = new WeakMap();
// What a test opened closes before its environment goes back: views first, then the rest.
function resources(t) {
  if (!cleanups.has(t)) {
    const value = { views: [], files: [] }; cleanups.set(t, value);
    t.after(async () => { for (const close of [...value.views.reverse(), ...value.files.reverse()]) await close(); });
  }
  return cleanups.get(t);
}
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  resources(t).files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function fixture(t, more = {}) {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'normal', ...more });
  environment(t, { ...fake.env, ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = new ProjectController(projectFolder(p.root));
  const lines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { ...p, controller, repo: controller.repo, calls: () => lines(fake.calls).filter(row => row.vendor === 'claude' && row.args.includes('-p')), inputs: () => lines(path.join(p.parent, 'inputs.jsonl')).filter(row => row.vendor === 'claude'), fake: next => fakeClis(p.parent, { mode: 'normal', ...more, ...next }) };
}
const NOTE = { overseer: 'orchestrator' };
const START = { permissions: 'auto', place: { kind: 'worktree' }, folders: [], bots: [], overseer: 'orchestrator', budgetUsd: 1.5 };
// The coupon module as a session's edit left it, in its own worktree.
const made = task => fs.readFileSync(path.join(task.worktree, 'src/coupon.mjs'), 'utf8');
async function until(check, message, timeout = 15000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test('no turn the bot that oversees leads has ELU\'s own commands: not one its note led to, and not one of a session it started until the owner writes there', async t => {
  const f = fixture(t, { mode: 'answer', envs: true });
  const mine = await f.controller.ask('Where is normalization?', null, { permissions: 'auto' }).finished;
  assert.ok(f.calls().length > 0 && f.calls().every(call => call.own), 'his own turn has them');
  let calls = f.calls().length, told = f.inputs().length;
  await f.controller.ask('Session 1 might also check the tests.', mine.id, NOTE).finished;
  const noted = f.calls().slice(calls);
  assert.ok(noted.length > 0 && noted.every(call => !call.own), JSON.stringify(noted));
  assert.ok(f.inputs().slice(told).every(row => !row.input.includes(OWN_COMMANDS[0])), 'nor is it told about them');
  // His own next message has them again.
  calls = f.calls().length;
  await f.controller.ask('And where is it called?', mine.id).finished;
  assert.ok(f.calls().slice(calls).some(call => call.own && call.session === String(mine.id)));
  // A session the bot started: its first turn, and one ELU sends there, have none.
  calls = f.calls().length; told = f.inputs().length;
  const started = await f.controller.ask('Where is the coupon code?', null, START).finished;
  await f.controller.ask(KEEP_GOING_TEXT, started.id).finished;
  const led = f.calls().slice(calls);
  assert.ok(led.length >= 2 && led.every(call => !call.own), JSON.stringify(led));
  assert.ok(f.inputs().slice(told).every(row => !row.input.includes(OWN_COMMANDS[0])));
  // Once he writes in it, it is his.
  calls = f.calls().length;
  await f.controller.ask('Thanks. Where else is it read?', started.id).finished;
  assert.ok(f.calls().slice(calls).some(call => call.own && call.session === String(started.id)));
});

// Such a turn may still run the owner's own elu, outside ELU: in Approve for me ELU answers elu
// sessions, schedules and jobs for his own turns, but never for one the bot leads, nor a rule of
// his does: there he is asked. Here Claude Code asks on its own output (lib/runner.mjs controlRelay).
test('in a turn the bot that oversees leads, ELU allows no elu command for the owner; in his own turns it does, as before', { timeout: 90000 }, async t => {
  const f = fixture(t, { mode: 'answer', hostAsks: [{ tool_name: 'Bash', input: { command: 'elu sessions new hello' } }] });
  const decided = id => (readTask(f.repo, id).approvals ?? []).map(row => [row.summary, row.decision, row.by ?? null]);
  const mine = await f.controller.ask('Where is normalization?', null, { permissions: 'auto' }).finished;
  assert.deepEqual(decided(mine.id), [['Run: elu sessions new hello', 'allow', 'default']]);
  // A note of the bot's, and a session it started: he is asked, and the question says the bot led the turn.
  const asked = async (finished, id) => {
    await until(() => pendingApprovals({ root: f.root, taskId: String(id) }).length === 1, `the question in session ${id}`);
    const [row] = pendingApprovals({ root: f.root, taskId: String(id) });
    assert.deepEqual([row.summary, row.led], ['Run: elu sessions new hello', true]);
    answerApproval(row.id, 'deny'); return finished;
  };
  await asked(f.controller.ask('Session 1 might also check the tests.', mine.id, NOTE).finished, mine.id);
  assert.deepEqual(decided(mine.id).at(-1), ['Run: elu sessions new hello', 'deny', null]);
  const starting = f.controller.ask('Where is the coupon code?', null, START).finished;
  await until(() => pendingApprovals({ root: f.root }).length === 1, 'the question in the session it started');
  const started = await asked(starting, pendingApprovals({ root: f.root })[0].taskId);
  assert.deepEqual(decided(started.id), [['Run: elu sessions new hello', 'deny', null]]);
  // His own next message there is his: allowed as before.
  await f.controller.ask('And where is it called?', mine.id).finished;
  assert.deepEqual(decided(mine.id).at(-1), ['Run: elu sessions new hello', 'allow', 'default']);
});

// Over ACP (Grok Build) the runner answers what the turn asks (lib/runner.mjs approvalRelay).
test('over ACP too, a turn the bot that oversees leads gets no elu command allowed for the owner', { timeout: 90000 }, async t => {
  const f = fixture(t, { mode: 'answer' });
  environment(t, { HOME: f.parent });
  fs.mkdirSync(path.join(f.parent, '.grok')); fs.writeFileSync(path.join(f.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
  atomic(path.join(personalDirectory(), 'conformance', 'grok.json'), { v: 1, bin: path.join(f.parent, 'bin', 'grok'), version: '1.0.77', steps: Object.fromEntries(ADAPTERS.grok.conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });
  // A stand-in for his own elu, first on PATH: nothing of his runs here, whatever is allowed.
  const ran = path.join(f.parent, 'elu-ran'); fs.writeFileSync(path.join(f.parent, 'bin', 'elu'), `#!/bin/sh\nprintf ran > ${JSON.stringify(ran)}\n`, { mode: 0o755 });
  Object.assign(f.controller.draftConfig.roles.lead, { vendor: 'grok', maxCostUsd: null });
  const mine = await f.controller.ask('Where is normalization?', null, { permissions: 'auto' }).finished;
  f.fake({ mode: 'answer', shell: [{ when: 'Where is normalization?', run: ['elu sessions new hello'] }] });
  const noted = f.controller.ask('Session 1 might also check the tests.', mine.id, NOTE).finished;
  await until(() => pendingApprovals({ root: f.root }).length === 1, 'the question to the owner');
  const [row] = pendingApprovals({ root: f.root });
  assert.deepEqual([row.vendor, row.summary, row.led], ['grok', 'Run elu sessions new hello', true]);
  answerApproval(row.id, 'deny'); await noted;
  assert.equal(fs.existsSync(ran), false);
});

// The approval relay of Claude Code (lib/approval-server.mjs) is told by --led whether the bot
// leads the turn. Told nothing, it cannot tell, and answers as for such a turn.
test('the approval relay answers an elu command for the owner only when told the bot that oversees does not lead the turn', async t => {
  const f = fixture(t);
  const ask = async (n, extra) => {
    const input = new PassThrough(), output = new PassThrough(), replies = []; let buffer = '';
    output.on('data', chunk => { buffer += chunk; for (let at; (at = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(at + 1)) replies.push(JSON.parse(buffer.slice(0, at))); });
    const done = serve({ argv: ['--session', `relay-${n}`, '--root', f.root, '--task', '1', '--role', 'lead', '--vendor', 'claude', '--log', path.join(f.parent, `relay-${n}.jsonl`), '--wait', '600', '--cwd', f.root, '--access', 'read', '--rules', 'saved', '--sandboxed', 'yes', '--mode', 'auto', ...extra], input, output });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL_NAME, arguments: { tool_name: 'Bash', input: { command: 'elu sessions new hello' }, tool_use_id: 'toolu_1' } } })}\n`);
    const id = `relay-${n}-toolu_1`, reply = () => replies.find(row => row.id === 1);
    await until(() => reply() || pendingApprovals().some(row => row.id === id), 'an answer or a question');
    const asked = pendingApprovals().find(row => row.id === id) ?? null;
    if (asked) answerApproval(id, 'deny');
    await until(reply, 'the answer'); input.end(); await done;
    return [asked?.led ?? null, JSON.parse(reply().result.content[0].text).behavior];
  };
  assert.deepEqual(await ask(1, ['--led', 'no']), [null, 'allow']);
  assert.deepEqual(await ask(2, ['--led', 'yes']), [true, 'deny']);
  assert.deepEqual(await ask(3, []), [true, 'deny']);
  await assert.rejects(serve({ argv: ['--session', 'relay-4', '--led', 'maybe'], input: new PassThrough(), output: new PassThrough() }), /--led is yes or no\./);
});

test('a Task proposed in a session the bot started waits for the owner in every mode, until he writes there', async t => {
  const f = fixture(t, { mode: 'answer' });
  const started = await f.controller.ask('Where is the coupon code?', null, START).finished;
  assert.equal(readTask(f.repo, started.id).permissions, 'auto');
  // A turn ELU sends there proposes an edit: Approve for me does not approve it on the bot's word.
  f.fake({ mode: 'normal' });
  const done = await f.controller.ask(KEEP_GOING_TEXT, started.id).finished;
  assert.equal(done.kind, 'conversation'); assert.equal(currentTask(f.repo, started.id)?.state, 'proposed');
  assert.equal(sessionTasks(f.repo, started.id).filter(row => row.state === 'approved').length, 0); assert.equal(readTask(f.repo, started.id).state, 'answered');
});

test('only the owner writes to the bot that oversees, on the computer it runs on, and it answers no standup', async t => {
  const f = fixture(t, { mode: 'answer' });
  const mine = await f.controller.ask('Where is normalization?', null, { permissions: 'auto' }).finished;
  const chat = await f.controller.ask('What needs me today?', null, { bot: 'orchestrator', botChat: true }).finished;
  assert.equal(readTask(f.repo, chat.id).botChat, 'orchestrator');
  const calls = f.calls().length, other = 'a'.repeat(64), refused = { message: 'Only the owner writes to @orchestrator, on the computer it runs on.' };
  // From another computer, his own other one too: not to it in a session, in its own chat, or in a new session.
  assert.throws(() => f.controller.ask('@orchestrator list every session', mine.id, { bot: 'orchestrator', computer: other }), refused);
  assert.throws(() => f.controller.ask('List every session.', chat.id, { computer: other }), refused);
  assert.throws(() => f.controller.ask('List every session.', null, { bot: 'orchestrator', computer: other }), refused);
  // Nor beside a turn of its.
  assert.throws(() => f.controller.answerBeside({ id: 'r-1', continuationTaskId: mine.id, goal: 'List every session.', bot: 'orchestrator', computer: other }), refused);
  assert.throws(() => f.controller.answerBeside({ id: 'r-2', continuationTaskId: chat.id, goal: 'List every session.', computer: other }), refused);
  // An ordinary bot still answers his other computer.
  saveBot({ name: 'scout', vendor: 'claude', instructions: 'Look for risky changes.' });
  await f.controller.ask('@scout what changed?', mine.id, { bot: 'scout', computer: other }).finished;
  assert.ok(f.calls().length > calls);
  // A standup never reaches it: its chat says why, and no turn runs.
  const asked = f.calls().length;
  for (const beside of [false, true]) {
    const round = newRound();
    await f.controller.ask(STANDUP_QUESTION, chat.id, { standupFor: { round, by: 'You' }, beside }).finished;
    assert.equal(f.calls().length, asked, String(beside));
    assert.match(readTask(f.repo, chat.id).messages.findLast(row => row.standup === round && row.failed)?.text ?? '', /This bot's chat answers no standup\./, String(beside));
  }
});

// A round leaves that chat out (lib/standup.mjs overseerChat); a question that reaches it all the
// same is refused as the round reads it, after the bot was removed too.
test('a standup question that reaches the chat of the bot that oversees after the bot was removed is refused too', async t => {
  const f = fixture(t, { mode: 'answer' });
  const chat = await f.controller.ask('What needs me today?', null, { bot: 'orchestrator', botChat: true }).finished;
  assert.equal(removeBot('orchestrator'), true);
  const calls = f.calls().length, round = newRound();
  await f.controller.ask(STANDUP_QUESTION, chat.id, { standupFor: { round, by: 'You' } }).finished;
  assert.equal(f.calls().length, calls);
  assert.match(readTask(f.repo, chat.id).messages.findLast(row => row.standup === round && row.failed)?.text ?? '', /This bot's chat answers no standup\./);
});

test('the bot\'s answer goes in only while the session still asks the question it was written for', async t => {
  const f = fixture(t, { mode: 'answer' });
  const mine = await f.controller.ask('Where is normalization?', null, { permissions: 'ask' }).finished;
  const asking = question => { const saved = readTask(f.repo, mine.id); saveTask(f.repo, { ...saved, state: 'needs_input', reply: { ...(saved.reply ?? {}), outcome: 'needs_input', summary: 'One thing first.', question } }); };
  asking('Use Postgres?'); const mark = questionMark(readTask(f.repo, mine.id)); assert.match(mark, /^[0-9a-f]{16}$/);
  // The session asks something else by the time the answer comes: nothing runs and nothing is saved.
  asking('Use SQLite?');
  const calls = f.calls().length, kept = readTask(f.repo, mine.id).messages.length;
  await assert.rejects(f.controller.ask('Yes.', mine.id, { ...NOTE, asks: mark }).finished, { message: QUESTION_CHANGED });
  assert.equal(f.calls().length, calls); assert.equal(readTask(f.repo, mine.id).messages.length, kept); assert.equal(readTask(f.repo, mine.id).state, 'needs_input');
  // Still asked, it goes in, under the bot's name.
  asking('Use Postgres?');
  await f.controller.ask('Yes.', mine.id, { ...NOTE, asks: mark }).finished;
  assert.ok(f.calls().length > calls);
  assert.deepEqual(readTask(f.repo, mine.id).messages.filter(row => row.text === 'Yes.').map(row => [row.from, row.overseer]), [['@orchestrator', true]]);
  // Only the bot's answer names a question, by its mark.
  assert.throws(() => f.controller.ask('Yes.', mine.id, { asks: mark }), /names the question it answers/);
  assert.throws(() => f.controller.ask('Yes.', mine.id, { ...NOTE, asks: 'not a mark' }), /names the question it answers/);
  assert.throws(() => f.controller.ask('Yes.', null, { ...START, asks: mark }), /names the question it answers/);
});

// A Task session of the owner's whose approved work stopped on a question (options: who works it).
async function askingTask(f, options = {}) {
  const done = await f.controller.ask('Uppercase coupon codes', null, { permissions: 'auto', ...options }).finished;
  assert.notEqual(done.kind, 'conversation', JSON.stringify(done.error));
  const saved = readTask(f.repo, done.id);
  saveTask(f.repo, { ...saved, state: 'needs_input', reply: { ...(saved.reply ?? {}), outcome: 'needs_input', summary: 'One thing first.', question: 'Lowercase ones too?' } });
  assert.equal(currentTask(f.repo, done.id).state, 'approved'); assert.match(questionMark(readTask(f.repo, done.id)) ?? '', /^[0-9a-f]{16}$/);
  return done.id;
}
// The turn that does a Task's work, by what it is told (lib/plan.mjs planPrompt).
const working = row => row.input.includes('and this turn does its work.');

test('a note of the bot\'s to a session whose work asks a question is answered as a note and the work waits; only its answer to that question carries the work on', async t => {
  const f = fixture(t), id = await askingTask(f), mark = questionMark(readTask(f.repo, id));
  // The stand-in's reply goes on with the work, as a model's may: the note still does not.
  let told = f.inputs().length;
  const noted = await f.controller.ask('Yes, go ahead.', id, NOTE).finished;
  assert.equal(f.inputs().slice(told).some(working), false);
  assert.equal(noted.state, 'needs_input'); assert.ok(noted.reply.summary.endsWith(NOTE_WAITS('orchestrator')), noted.reply.summary);
  assert.equal(currentTask(f.repo, id).state, 'approved');
  // The session still asks its question, for him or for the bot's answer to it.
  assert.equal(questionMark(readTask(f.repo, id)), mark);
  // Its answer that names the question goes on with the work, under its name.
  told = f.inputs().length;
  await f.controller.ask('Yes, lowercase ones too.', id, { ...NOTE, asks: mark }).finished;
  assert.ok(f.inputs().slice(told).some(working));
  assert.deepEqual(readTask(f.repo, id).messages.filter(row => row.text === 'Yes, lowercase ones too.').map(row => [row.from, row.overseer]), [['@orchestrator', true]]);
});

test('a note of the bot\'s to the bot a session works with does not carry the work on either', async t => {
  const f = fixture(t);
  saveBot({ name: 'builder', vendor: 'claude', instructions: 'Build what the session asks for.', works: true });
  const id = await askingTask(f, { bot: 'builder' }), told = f.inputs().length, mark = questionMark(readTask(f.repo, id));
  const noted = await f.controller.ask('Yes, go ahead.', id, { ...NOTE, bot: 'builder' }).finished;
  assert.equal(f.inputs().slice(told).some(working), false);
  assert.equal(noted.state, 'needs_input'); assert.equal(noted.botEdit, undefined); assert.equal(questionMark(readTask(f.repo, id)), mark);
  assert.ok(noted.messages.findLast(row => row.bot === 'builder' && !row.to)?.text.endsWith(NOTE_WAITS('orchestrator')));
});

test('a message of the bot\'s to a session the owner set to Full access after it was sent goes in only when he said yes to it himself', async t => {
  const f = fixture(t, { mode: 'answer' });
  const mine = await f.controller.ask('Where is normalization?', null, { permissions: 'auto' }).finished;
  const conductor = new Conductor(), row = id => pendingRequests(f.root).find(value => value.id === id);
  // Its line in the action log: by the level, as at Act, or by his yes.
  fs.mkdirSync(path.dirname(actionsFile()), { recursive: true });
  let lines = 0;
  const logged = (request, by) => fs.appendFileSync(actionsFile(), `${JSON.stringify({ id: `a${++lines}`, at: new Date().toISOString(), bot: 'orchestrator', from: { root: f.root, session: '9', run: null }, action: 'session_message', target: { root: f.root, session: String(mine.id), request }, summary: 'Send a note', level: 'act', decision: 'allow', by, undo: { kind: 'message', root: f.root, request }, undoneAt: null })}\n`);
  const sends = async (text, by) => {
    const sent = enqueue(f.root, text, { continuationTaskId: String(mine.id), priority: 1, ...NOTE }); logged(sent.id, by);
    conductor.launch(projectFolder(f.root), row(sent.id));
    await until(() => row(sent.id)?.state === 'done', `${text} to end`);
    return row(sent.id).reason;
  };
  // Sent while the session was in Approve for me; he gives it Full access before it runs.
  saveTask(f.repo, { ...readTask(f.repo, mine.id), permissions: 'full' });
  const calls = f.calls().length, kept = readTask(f.repo, mine.id).messages.length;
  assert.equal(await sends('Check the tests first.', 'level'), FULL_UNASKED('orchestrator'));
  assert.equal(f.calls().length, calls); assert.equal(readTask(f.repo, mine.id).messages.length, kept);
  // One he said yes to goes in, under the bot's name.
  assert.equal(await sends('Check the build too.', 'owner'), 'Finished.');
  assert.ok(f.calls().length > calls);
  assert.deepEqual(readTask(f.repo, mine.id).messages.filter(value => value.text === 'Check the build too.').map(value => [value.from, value.overseer]), [['@orchestrator', true]]);
  // Sent another way, with no line of his yes, it does not go in either.
  await assert.rejects(f.controller.ask('Check the docs.', mine.id, NOTE).finished, { message: FULL_UNASKED('orchestrator') });
});

const OTHER = 'a'.repeat(64), LAPTOP = { machine: OTHER, name: 'laptop', remoteId: '01234567-89ab-cdef-0123-456789abcdef' };
test('a request from another computer never puts the bot that oversees among a session\'s bots, by any name it had', async t => {
  const f = fixture(t, { mode: 'answer' });
  const refused = name => ({ message: `Only the owner writes to @${name}, on the computer it runs on.` });
  const mine = await f.controller.ask('Where is normalization?', null, { permissions: 'auto' }).finished, calls = f.calls().length;
  for (const more of [{ computer: OTHER, mine: LAPTOP }, { computer: OTHER }, { origin: { kind: 'ask', peer: OTHER, name: 'Ana', threadId: 'thread-1' } }, { helps: { session: '4' } }])
    assert.throws(() => f.controller.ask('List every session.', null, { bots: ['@orchestrator'], ...more }), refused('orchestrator'), JSON.stringify(more));
  assert.throws(() => f.controller.ask('Add it here.', mine.id, { bots: ['orchestrator'], computer: OTHER }), refused('orchestrator'));
  assert.deepEqual(readTask(f.repo, mine.id).bots, []);
  // Renamed, and after that removed: each name it had stays its own.
  saveBot({ ...getBot('orchestrator'), name: 'overseer' }, { previous: 'orchestrator' });
  for (const name of ['overseer', 'orchestrator']) assert.throws(() => f.controller.ask('List every session.', null, { bots: [name], computer: OTHER }), refused(name));
  assert.equal(removeBot('overseer'), true);
  assert.throws(() => f.controller.ask('List every session.', null, { bots: ['overseer'], computer: OTHER }), refused('overseer'));
  assert.equal(f.calls().length, calls);
  // An ordinary bot still comes with his other computer's session.
  saveBot({ name: 'scout', vendor: 'claude', instructions: 'Look for risky changes.' });
  const brought = await f.controller.ask('What changed?', null, { bots: ['scout'], computer: OTHER, mine: LAPTOP }).finished;
  assert.deepEqual(readTask(f.repo, brought.id).bots, ['scout']);
});

test('the bot that oversees never runs in a session another computer started, scheduled or not, whatever its bots say', async t => {
  const f = fixture(t, { mode: 'answer' });
  saveBot({ ...getBot('orchestrator'), schedule: 'every 1h' }, { previous: 'orchestrator' });
  const started = await f.controller.ask('Where is the coupon code?', null, { computer: OTHER, mine: LAPTOP }).finished;
  assert.equal(readTask(f.repo, started.id).origin.kind, 'mine');
  // He put it there himself.
  f.controller.setBots(started.id, ['orchestrator']);
  const calls = f.calls().length, kept = readTask(f.repo, started.id).messages.length, away = { message: '@orchestrator oversees your sessions, so it does not run in a session another computer or a teammate started.' };
  await assert.rejects(f.controller.ask('Scheduled run (every 1h).', started.id, { bot: 'orchestrator', scheduled: true }).finished, away);
  await assert.rejects(f.controller.ask('What is open?', started.id, { bot: 'orchestrator' }).finished, away);
  assert.equal(f.calls().length, calls); assert.equal(readTask(f.repo, started.id).messages.length, kept);
  // In a session he started here it runs as before (Read only, as that one is: it only answers).
  const mine = await f.controller.ask('Where is normalization?', null, { bots: ['orchestrator'] }).finished;
  await f.controller.ask('Scheduled run (every 1h).', mine.id, { bot: 'orchestrator', scheduled: true }).finished;
  assert.ok(readTask(f.repo, mine.id).runs.some(run => run.role === 'bot:orchestrator'));
});

test('a message from another computer never reaches the chat of the bot that oversees, after a rename or a removal too', async t => {
  const f = fixture(t, { mode: 'answer' });
  const chat = await f.controller.ask('What needs me today?', null, { bot: 'orchestrator', botChat: true }).finished;
  saveBot({ ...getBot('orchestrator'), name: 'overseer' }, { previous: 'orchestrator' });
  assert.equal(readTask(f.repo, chat.id).botChat, 'orchestrator');
  const calls = f.calls().length, refused = { message: 'Only the owner writes to @orchestrator, on the computer it runs on.' };
  assert.throws(() => f.controller.ask('List every session.', chat.id, { computer: OTHER }), refused);
  assert.throws(() => f.controller.answerBeside({ id: 'r-1', continuationTaskId: chat.id, goal: 'List every session.', computer: OTHER }), refused);
  assert.equal(removeBot('overseer'), true);
  assert.throws(() => f.controller.ask('List every session.', chat.id, { computer: OTHER }), refused);
  assert.equal(f.calls().length, calls);
});

test('a scheduled working bot\'s Task in a session the bot that oversees started waits for the owner, in every mode', async t => {
  const f = fixture(t, { mode: 'answer' });
  const started = await f.controller.ask('Where is the coupon code?', null, START).finished;
  saveBot({ name: 'builder', vendor: 'claude', instructions: 'Build what the session asks for.', works: true, schedule: 'every 1h' });
  // He adds it with /bots, which writes nothing in the chat.
  f.controller.setBots(started.id, ['builder']);
  f.fake({ mode: 'normal' });
  const done = await f.controller.ask('Scheduled run (every 1h).', started.id, { bot: 'builder', scheduled: true }).finished;
  assert.equal(currentTask(f.repo, started.id)?.state, 'proposed');
  assert.equal(sessionTasks(f.repo, started.id).filter(row => row.state === 'approved').length, 0);
  assert.equal(done.kind, 'conversation'); assert.equal(done.state, 'answered');
});

test('nothing of the bot\'s goes to a session the owner archived or moved to Done, and his own message still does', async t => {
  const f = fixture(t, { mode: 'answer' });
  const one = await f.controller.ask('Where is normalization?', null, { permissions: 'ask' }).finished;
  const two = await f.controller.ask('Where is the coupon code?', null, { permissions: 'ask' }).finished;
  const calls = f.calls().length;
  closeSession(f.repo, String(one.id));
  assert.throws(() => f.controller.ask('Check the tests.', one.id, NOTE), { message: 'That session is archived. Nothing of @orchestrator\'s goes to it.' });
  setDone(f.repo, { task: readTask(f.repo, two.id) }, true);
  assert.throws(() => f.controller.ask('Check the tests.', two.id, NOTE), { message: 'That session is in Done. Nothing of @orchestrator\'s goes to it.' });
  assert.equal(f.calls().length, calls); assert.equal(readBoard(f.repo).archived.includes(String(one.id)), true);
  // A board that cannot be read sends nothing of the bot's.
  const board = path.join(f.repo.state, 'kanban.json'), kept = fs.readFileSync(board, 'utf8');
  fs.writeFileSync(board, '{ not json');
  assert.throws(() => f.controller.ask('Check the tests.', two.id, NOTE), /The board could not be read/);
  fs.writeFileSync(board, kept);
  await f.controller.ask('One more question.', one.id).finished;
  assert.ok(f.calls().length > calls);
});

test('an approved Task whose bot no longer works is still made by that bot, and one whose bot oversees now by the model', async t => {
  const f = fixture(t);
  saveBot({ name: 'builder', vendor: 'claude', instructions: 'Build what the session asks for.', works: true });
  const asked = await f.controller.ask('Uppercase coupon codes', null, { bot: 'builder', permissions: 'ask' }).finished;
  assert.equal(currentTask(f.repo, asked.id).state, 'proposed'); assert.equal(currentTask(f.repo, asked.id).edit.bot, 'builder');
  // He turns its works off before his yes: the edit is made, as before bots could oversee.
  saveBot({ ...getBot('builder'), works: false });
  const done = await f.controller.ask('yes', asked.id).finished;
  assert.notEqual(done.state, 'blocked', JSON.stringify(done.error)); assert.match(made(done), /toUpperCase/);
  assert.ok(done.runs.some(run => run.role === 'bot:builder'), JSON.stringify(done.runs.map(run => run.role)));
  // A bot that oversees now never edits: the model makes it.
  const g = fixture(t);
  saveBot({ name: 'watcher', vendor: 'claude', instructions: 'Build, then watch.', works: true });
  const other = await g.controller.ask('Uppercase coupon codes', null, { bot: 'watcher', permissions: 'ask' }).finished;
  assert.equal(currentTask(g.repo, other.id).edit.bot, 'watcher');
  saveBot({ ...getBot('watcher'), works: false, oversees: true });
  const ran = readTask(g.repo, other.id).runs.length, modelMade = await g.controller.ask('yes', other.id).finished;
  assert.notEqual(modelMade.state, 'blocked', JSON.stringify(modelMade.error)); assert.match(made(modelMade), /toUpperCase/);
  assert.deepEqual([...new Set(modelMade.runs.slice(ran).map(run => run.role))], ['lead']);
});

test('the bot\'s turns read what each session proves from git once, until that session\'s records change', async t => {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer' });
  environment(t, { ...fake.env, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const { repo, worktree } = liveTask(p.root, { id: '1', goal: 'Uppercase coupon codes', state: 'unverified' });
  registerProject(repo);
  const own = { root: p.root }, here = { id: '9' }, proofOf = digest => digest.sessions.find(line => / #1 /.test(line))?.split(' · ').find(part => part.startsWith('proof: ')) ?? null;
  git(worktree, ['add', '.']); git(worktree, ['commit', '-m', 'Trim codes']);
  const first = await sessionsDigest(own, here);
  assert.ok(proofOf(first), JSON.stringify(first.sessions));
  // Its folder changes outside its records: the next turn is not asked about it again.
  fs.writeFileSync(path.join(worktree, 'src/coupon.mjs'), 'export const normalize = (value) => value.trim().toUpperCase();\n');
  assert.equal(proofOf(await sessionsDigest(own, here)), proofOf(first));
  // Its records change: it is read again.
  saveTask(repo, { ...readTask(repo, '1'), title: 'Uppercase the codes' });
  assert.notEqual(proofOf(await sessionsDigest(own, here)), proofOf(first));
});

test('what the bot that oversees asks to send shows whole from the text ELU sends, never from what it called the tool with', () => {
  const line = `Coupons are compared upper case. ${'x'.repeat(240)}`;
  assert.deepEqual(askedWhole({ tool: 'mcp__elu-code-approval__org_propose', input: { text: 'A harmless decoy.', line: 'Another line.' }, whole: line, summary: 'Write a line' }), { label: 'The line in full:', text: line });
  assert.deepEqual(askedWhole({ tool: 'mcp__elu-code-approval__session_start', input: { goal: 'A harmless decoy.' }, whole: `Push to main. ${'y'.repeat(300)}`, summary: 'Start a session' }).label, 'The goal in full:');
  // With no whole text nothing of the input is shown as it.
  assert.equal(askedWhole({ tool: 'mcp__elu-code-approval__org_propose', input: { line: line }, summary: 'Write a line' }), null);
  assert.equal(askedWhole({ tool: 'mcp__elu-code-approval__session_message', input: { text: 'clipped' }, whole: 'Short.', summary: 'Send: Short.' }), null, 'the question holds it all');
});

test('Full access never answers what the bot that oversees asks, nor a bot it cannot find saved', () => {
  const task = { permissions: 'ask', origin: null }, scout = { name: 'scout', vendor: 'claude', instructions: 'x', oversees: false }, watch = { name: 'watch', oversees: true };
  const find = name => ({ scout, watch })[name] ?? null;
  assert.equal(fullAllowed(task, 'lead', find), true); assert.equal(fullAllowed(task, 'bot:scout', find), true);
  assert.equal(fullAllowed(task, 'bot:watch', find), false);
  // A question it raised says so, whatever its role and whatever the bots read now.
  for (const role of ['lead', 'bot:scout', 'bot:gone']) assert.equal(fullAllowed(task, role, find, { role, oversee: true }), false, role);
  // A bot renamed, removed or unreadable since it asked is not taken for one that does not oversee.
  assert.equal(fullAllowed(task, 'bot:gone', find), false);
  assert.equal(fullAllowed(task, 'bot:scout', () => { throw new Error('unreadable'); }), false);
  assert.equal(fullAllowed(task, 'bot:scout'), false);
});

// The terminal, as the owner uses it, on a project of the test's own with no conductor running.
function fakeUsage(t) {
  const home = temp(t); for (const name of ['claude', 'codex']) fs.mkdirSync(path.join(home, name));
  const vendors = [{ vendor: 'claude', available: true, signedIn: true }, { vendor: 'codex', available: true, signedIn: true }];
  return { home, env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex') }, vendors: () => vendors };
}
async function view(t, repo) {
  environment(t, { TERM: 'xterm-256color', ELU_NO_COLOR: '1' });
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = 140; output.rows = 50;
  let rendered;
  const finished = launchTerminal({ repo, usage: fakeUsage(t), input, output, refreshMs: 30, startConductor: () => false, onRender: value => { rendered = value; } });
  finished.catch(() => {});
  await until(() => rendered, 'first render');
  keyThenEnter(input, () => rendered);
  resources(t).views.push(async () => {
    let closed = false; finished.then(() => { closed = true; }, () => { closed = true; });
    try { await rendered.controller?.close(); } catch { /* Closed with the view. */ }
    for (const started = Date.now(); !closed && !rendered.screen.destroyed;) {
      if (Date.now() - started > 10000) { input.destroy(); output.destroy(); throw new Error('The view did not close after its test.'); }
      rendered.panels.ask.cancel();
      for (const child of [...rendered.screen.children]) { child.dismiss?.(); child.children?.find(item => item.type === 'textbox')?.emit('cancel'); }
      rendered.panels.tabs[0].focus(); rendered.screen.emit('keypress', 'q', { name: 'q' });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    input.destroy(); output.destroy();
  });
  return { input, output, get current() { return rendered; } };
}
async function send(v, text) {
  v.current.panels.ask.focus(); v.current.panels.ask.readInput();
  await until(() => v.current.panels.ask.__listener, 'message box');
  v.current.panels.ask.setValue(text); v.current.panels.ask.submit();
}
const modal = (v, title) => v.current.screen.children.find(child => !child.destroyed && child.options?.label?.trim() === title);
async function dialog(v, title, value) {
  await until(() => modal(v, title), title);
  const field = modal(v, title).children.find(child => child.type === 'textbox');
  await until(() => field.__listener, `${title} input`);
  field.setValue(value); field.submit();
}
const rows = v => v.current.panels.board.items.map(item => item.getText());
async function openSession(v, pattern, id) {
  if (v.current.view !== 'tasks') await send(v, '/tasks');
  await until(() => v.current.view === 'tasks' && rows(v).some(row => pattern.test(row)), `row ${pattern}`);
  const board = v.current.panels.board; board.focus(); board.select(rows(v).findIndex(row => pattern.test(row)));
  await until(() => v.current.session === id && v.current.screen.focused === board, `session ${id} shown`);
  v.input.write('\r'); await until(() => v.current.screen.focused === v.current.panels.ask && v.current.session === id, 'its chat');
}
function terminalFixture(t) {
  const p = project({ after: close => resources(t).files.push(close) }), fake = fakeClis(p.parent, { mode: 'normal' });
  environment(t, { ...fake.env, ELU_NO_UPDATE_CHECK: '1' });
  return { ...p, repo: projectFolder(p.root) };
}
const answered = id => { const file = path.join(approvalsDir(), `${id}.answer.json`); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).decision : null; };

test('in the terminal, Full access leaves what the bot that oversees asks waiting, after a rename too, and f is not offered for it', { timeout: 60000 }, async t => {
  const p = terminalFixture(t), began = new Date().toISOString();
  liveTask(p.root, { id: '3', goal: 'What needs me today', state: 'ready' });
  saveTask(p.repo, { ...readTask(p.repo, '3'), permissions: 'ask', state: 'running', activeRole: 'bot:orchestrator', activeSince: began, owner: { pid: process.pid, identity: processIdentity(process.pid) }, messages: [{ at: began, text: 'What needs me today', to: '@orchestrator' }] });
  const release = lock(p.repo, 'task-3'); resources(t).files.push(() => release());
  const v = await view(t, p.repo), chat = () => v.current.panels.chat.getText(), status = () => v.current.panels.status.getText();
  // It is renamed while its questions wait: one marked as its own, one only by its old name.
  saveBot({ ...getBot('orchestrator'), name: 'overseer' }, { previous: 'orchestrator' });
  requestApproval({ id: 'orch-a', root: p.root, taskId: '3', role: 'bot:orchestrator', vendor: 'claude', tool: 'mcp__gmail__send_message', input: { to: 'someone@example.invalid' }, oversee: true });
  await openSession(v, /What needs me today/, '3');
  await until(() => /@orchestrator wants to:/.test(chat()), 'its question shows');
  assert.match(chat(), /y allow · n deny, then Enter · esc later/); assert.doesNotMatch(chat(), /f full access/);
  requestApproval({ id: 'orch-b', root: p.root, taskId: '3', role: 'bot:orchestrator', vendor: 'claude', tool: 'mcp__gmail__send_message', input: { to: 'other@example.invalid' } });
  requestApproval({ id: 'lead-a', root: p.root, taskId: '3', role: 'lead', vendor: 'claude', tool: 'Bash', input: { command: 'ls src' } });
  await send(v, '/permissions full'); await dialog(v, 'Full access', 'y');
  await until(() => /Full access: this session no longer asks you\./.test(status()), 'Full access is on');
  await until(() => answered('lead-a') === 'allow', 'the model\'s question is allowed');
  assert.equal(answered('orch-a'), null); assert.equal(answered('orch-b'), null);
});

test('in the terminal, archiving a session or checking it Done takes back the notes the bot left waiting for it', { timeout: 60000 }, async t => {
  const p = terminalFixture(t);
  liveTask(p.root, { id: '3', goal: 'Uppercase coupon codes', state: 'answered' });
  liveTask(p.root, { id: '4', goal: 'Trim coupon codes', state: 'ready' });
  const note = id => enqueue(p.root, 'Check the tests first.', { continuationTaskId: id, priority: 1, ...NOTE });
  const own = enqueue(p.root, 'My own message.', { continuationTaskId: '3', priority: 0 });
  note('3'); note('4');
  const waiting = id => pendingRequests(p.root).filter(row => row.continuationTaskId === id && typeof row.overseer === 'string').length;
  assert.deepEqual([waiting('3'), waiting('4')], [1, 1]);
  const v = await view(t, p.repo), status = () => v.current.panels.status.getText();
  await openSession(v, /Uppercase coupon codes/, '3');
  await send(v, '/archive'); await until(() => /Archived /.test(status()), 'archived');
  await until(() => waiting('3') === 0, 'its note is taken back');
  assert.ok(pendingRequests(p.root).some(row => row.id === own.id), 'his own message stays');
  await openSession(v, /Trim coupon codes/, '4');
  await send(v, '/done'); await until(() => modal(v, 'Check'), 'the check');
  v.input.write('\r'); await until(() => /to Done\./.test(status()), 'checked Done');
  await until(() => waiting('4') === 0, 'its note is taken back');
});
