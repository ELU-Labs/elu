import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { temp, project, fakeClis, git } from './helpers.mjs';
import { Conductor, enqueue } from '../lib/conductor.mjs';
import { addToRequest, joinRequests, pendingRequests, projectFolder, supersededRequests, takeRequest, typedRequest } from '../lib/workspace.mjs';
import { stopLongWork } from '../lib/long-work.mjs';
import { runBotSchedules } from '../lib/bot-schedules.mjs';
import { ProjectController, conversationEntries, registerProject } from '../lib/projects.mjs';
import { readTask, saveTask, taskDir } from '../lib/state.mjs';
import { currentTask, saysYes, sessionTasks } from '../lib/plan.mjs';
import { saveBot, sessionTalker, overseerWrote } from '../lib/bots.mjs';
import { NOT_OWNER_WORD, OWNER_WORD, OWNER_WORD_NOTE, answeringAsOwner, createConversation, ledByOverseer, overseeRunUsd, ownerWord, runConversation } from '../lib/runner.mjs';
import { OVERSEER_NOTE } from '../lib/bots.mjs';
import { decisionsBlock, saveMandate } from '../lib/orchestrator-mandates.mjs';
import { OWNER_VIA, OWNER_VIA_LINE } from '../lib/peer/remote-methods.mjs';
import { projectKey } from '../lib/peer/remote.mjs';
import { OVERSEE_RUN_USD } from '../lib/bots.mjs';
import { setCap } from '../lib/orchestrator-settings.mjs';
import { actionsFile, readActions } from '../lib/orchestrator-actions.mjs';

// What the bot that oversees the sessions sends carries its mark from the request on
// (overseer, lib/conductor.mjs enqueue), and nothing it sends is ever the owner's: it approves
// no Task, teaches nothing, joins none of his waiting messages, does not change who his session
// talks to, reads as a note from the bot and shows under its name, and his Stop takes it back.
// The turns run on the stand-in vendors (test/fakes), in a project of the test's own.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function fixture(t, more = {}) {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'normal', ...more });
  environment(t, { ...fake.env, ELU_NO_UPDATE_CHECK: '1', GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = new ProjectController(projectFolder(p.root));
  return { ...p, controller, repo: controller.repo, fake: next => fakeClis(p.parent, { mode: 'normal', ...next }) };
}
const inputs = f => fs.readFileSync(path.join(f.parent, 'inputs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.vendor === 'claude' && row.args.includes('-p'));
const schemaOf = row => JSON.parse(row.args[row.args.indexOf('--json-schema') + 1]);
const source = f => fs.readFileSync(path.join(f.root, 'src/coupon.mjs'), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const NOTE = { overseer: 'orchestrator' };
const START = { permissions: 'auto', place: { kind: 'worktree' }, folders: [], bots: [], overseer: 'orchestrator', budgetUsd: 1.5 };

test('the request keeps the mark and the budget it was queued with, and nothing of the owner\'s goes with it', t => {
  const f = fixture(t);
  saveBot({ name: 'builder', vendor: 'claude', instructions: 'Build what the session asks for.', works: true });
  const note = enqueue(f.root, 'Session 3 waits on a database answer.', { continuationTaskId: '3', priority: 1, ...NOTE });
  assert.equal(note.overseer, 'orchestrator'); assert.equal('budgetUsd' in note, false); assert.equal(note.typed, undefined);
  const toWorker = enqueue(f.root, 'Check the migration first.', { continuationTaskId: '3', bot: 'builder', ...NOTE });
  assert.deepEqual([toWorker.overseer, toWorker.bot], ['orchestrator', 'builder']);
  const started = enqueue(f.root, 'Draft the migration plan', { priority: 1, ...START });
  assert.deepEqual([started.overseer, started.budgetUsd, started.permissions, started.place, started.bots, started.folders], ['orchestrator', 1.5, 'auto', { kind: 'worktree' }, [], undefined]);
  // As saved, so a restart or another window reads the same mark.
  assert.deepEqual(pendingRequests(f.root).map(row => [row.goal, row.overseer, row.budgetUsd ?? null]), [['Session 3 waits on a database answer.', 'orchestrator', null], ['Check the migration first.', 'orchestrator', null], ['Draft the migration plan', 'orchestrator', 1.5]]);
  // Any bot saved as overseeing marks its own; no other does.
  saveBot({ name: 'watch', vendor: 'claude', instructions: 'Watch the sessions.', oversees: true });
  assert.equal(enqueue(f.root, 'A note.', { continuationTaskId: '3', overseer: 'watch' }).overseer, 'watch');
  for (const name of ['builder', 'reviewer', 'nobody', 'Bad Name', 7]) assert.throws(() => enqueue(f.root, 'A note.', { continuationTaskId: '3', overseer: name }), /Only the bot that oversees your sessions marks what it sends as its own/, String(name));
  // Nothing of the owner's: no key of his, no approval, schedule, copy, @model or other computer.
  for (const extra of [{ typed: true }, { approved: true }, { scheduled: true, bot: 'builder' }, { toModel: true }, { readOnly: true }, { computer: 'a'.repeat(64) }, { goalChange: { task: 't-0000000a', revision: 1 }, typed: true }, { state: 'waiting' }])
    assert.throws(() => enqueue(f.root, 'yes', { continuationTaskId: '3', ...NOTE, ...extra }), /goes to one of them as it is/, JSON.stringify(extra));
  // A note changes none of the session's choices, and goes to the model or to a bot that works there.
  for (const extra of [{ permissions: 'full' }, { bots: ['builder'] }, { budgetUsd: 1 }, { bot: 'reviewer' }]) assert.throws(() => enqueue(f.root, 'A note.', { continuationTaskId: '3', ...NOTE, ...extra }), /goes to one of them as it is/, JSON.stringify(extra));
  // A session it starts: Ask for approval or Approve for me, a new worktree, nothing else, and a budget.
  for (const extra of [{ permissions: 'full' }, { permissions: undefined }, { place: { kind: 'here' }, permissions: 'full' }, { bots: ['builder'] }, { bots: undefined }, { budgetUsd: undefined }, { budgetUsd: 0 }, { budgetUsd: Infinity }, { bot: 'builder' }])
    assert.throws(() => enqueue(f.root, 'Start', { ...START, ...extra }), /has Ask for approval or Approve for me, a new worktree, no folders, no bots and a budget/, JSON.stringify(extra));
  // A budget is only ever the bot's start.
  assert.throws(() => enqueue(f.root, 'Start', { permissions: 'auto', budgetUsd: 1 }), /a budget of a cent or more/);
  // The owner's own request is as before: no mark.
  const his = enqueue(f.root, 'And mine.', { continuationTaskId: '3', typed: true });
  assert.equal('overseer' in his, false); assert.equal(his.typed, true);
});

test('the bot\'s note is never joined with the owner\'s waiting messages, added to, or counted as his', t => {
  const f = fixture(t);
  const mine = enqueue(f.root, 'Use Postgres.', { continuationTaskId: '3', typed: true });
  const note = enqueue(f.root, 'yes', { continuationTaskId: '3', ...NOTE });
  const later = enqueue(f.root, 'And keep the tests.', { continuationTaskId: '3', typed: true });
  // His typed follow-up may go to a running turn; the bot's note waits for one of its own.
  assert.deepEqual([typedRequest(mine), typedRequest(note), typedRequest(later)], [true, false, true]);
  // Nothing of his is added to the bot's request.
  assert.equal(addToRequest(f.root, note.id, 'mine too', { typed: true }), null);
  assert.equal(pendingRequests(f.root).find(row => row.id === note.id).goal, 'yes');
  // A join ends where the writer changes: his first message goes alone, and so does the note.
  assert.equal(joinRequests(f.root, [mine.id, note.id, later.id]).goal, 'Use Postgres.');
  assert.equal(joinRequests(f.root, [note.id, later.id]).goal, 'yes');
  assert.deepEqual(pendingRequests(f.root).map(row => row.goal), ['Use Postgres.', 'yes', 'And keep the tests.']);
  // The bot's note does not stand in for his: a message of his that stopped stays to send again,
  // and the bot's note is never his to send again.
  const at = minutes => new Date(Date.UTC(2026, 10, 17, 9, minutes)).toISOString();
  const blocked = { id: 'request-b', state: 'blocked', continuationTaskId: '3', goal: 'Mine that stopped', createdAt: at(0), blockedAt: at(1) };
  const sent = { id: 'request-n', state: 'queued', continuationTaskId: '3', goal: 'A note', createdAt: at(2), overseer: 'orchestrator' };
  const session = { id: '3', messages: [{ at: at(3), text: 'A note', from: '@orchestrator', bot: 'orchestrator', overseer: true }] };
  assert.deepEqual(supersededRequests([blocked, sent], [session]), []);
  assert.deepEqual(supersededRequests([blocked, { ...sent, overseer: undefined }], []), ['request-b'], 'his own later message does');
  assert.deepEqual(supersededRequests([{ ...sent, state: 'blocked', blockedAt: at(2) }, { ...blocked, state: 'queued', createdAt: at(5) }], []), []);
  // Who his session talks to is his to say: a waiting note to a bot changes nothing.
  saveBot({ name: 'builder', vendor: 'claude', instructions: 'Build what the session asks for.', works: true });
  const task = { id: '3', bots: ['builder'], botsPicked: true, messages: [{ at: at(0), text: 'Explain it', toModel: true }] };
  const toBuilder = enqueue(f.root, 'Over to you.', { continuationTaskId: '3', bot: 'builder', ...NOTE });
  assert.equal(sessionTalker(task, { waiting: [toBuilder] }), null);
  assert.equal(sessionTalker(task, { waiting: [{ ...toBuilder, overseer: undefined }] }), 'builder');
  assert.equal(sessionTalker({ ...task, messages: [...task.messages, { at: at(4), text: 'Over to you.', to: '@builder', from: '@orchestrator', bot: 'orchestrator', overseer: true }] }), null);
});

test('Stop takes back the bot\'s waiting notes, and his own messages stay', t => {
  const f = fixture(t);
  enqueue(f.root, 'Session 3 is slow.', { continuationTaskId: '3', ...NOTE });
  enqueue(f.root, 'Mine.', { continuationTaskId: '3', typed: true });
  enqueue(f.root, 'For session 4.', { continuationTaskId: '4', ...NOTE });
  stopLongWork(f.root, '3');
  assert.deepEqual(pendingRequests(f.root).map(row => row.goal), ['Mine.', 'For session 4.']);
});

test('a first Stop in a process that never loaded the bot\'s log still says the notes were taken back', t => {
  const f = fixture(t);
  const note = enqueue(f.root, 'Session 3 is slow.', { continuationTaskId: '3', ...NOTE }), other = enqueue(f.root, 'For session 4.', { continuationTaskId: '4', ...NOTE });
  const row = (id, request) => JSON.stringify({ id, at: new Date().toISOString(), bot: 'orchestrator', from: { root: f.root, session: '1', run: 'r' }, action: 'session_message', target: { root: f.root, session: request === note.id ? '3' : '4', request }, summary: 'Send a note', level: 'act', decision: 'allow', by: 'level', undo: { kind: 'message', root: f.root, request }, undoneAt: null });
  fs.mkdirSync(path.dirname(actionsFile()), { recursive: true });
  fs.writeFileSync(actionsFile(), `${row('a1', note.id)}\n${row('a2', other.id)}\n`, { mode: 0o600 });
  // A process of its own, as the peer daemon's Stop is: nothing of the bot's is loaded there.
  const code = `const { stopLongWork } = await import(${JSON.stringify(new URL('../lib/long-work.mjs', import.meta.url).href)}); stopLongWork(${JSON.stringify(f.root)}, '3');`;
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: process.env, encoding: 'utf8', timeout: 60000 });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(pendingRequests(f.root).map(request => request.id), [other.id]);
  assert.deepEqual(readActions().map(action => [action.id, action.undone]), [['a1', 'taken back'], ['a2', null]]);
});

test('an answer of the bot names the question it answers by its mark, and the conductor hands that on', t => {
  const f = fixture(t), mark = 'a1b2c3d4e5f60718';
  const answer = enqueue(f.root, 'Use Postgres.', { continuationTaskId: '3', ...NOTE, asks: mark });
  assert.equal(answer.asks, mark);
  assert.equal(pendingRequests(f.root).find(row => row.id === answer.id).asks, mark);
  const note = enqueue(f.root, 'A note.', { continuationTaskId: '4', ...NOTE });
  assert.equal('asks' in note, false);
  // Only with the bot's mark, on a session, and as 16 hex characters.
  for (const fields of [{ continuationTaskId: '3', typed: true, asks: mark }, { continuationTaskId: '3', asks: mark }, { ...START, asks: mark }, { continuationTaskId: '3', ...NOTE, asks: mark.toUpperCase() }, { continuationTaskId: '3', ...NOTE, asks: mark.slice(1) }, { continuationTaskId: '3', ...NOTE, asks: `${mark}0` }, { continuationTaskId: '3', ...NOTE, asks: 7 }, { continuationTaskId: '3', ...NOTE, asks: null }, { continuationTaskId: '3', ...NOTE, asks: '' }])
    assert.throws(() => enqueue(f.root, 'Use Postgres.', fields), /Only an answer of the bot that oversees your sessions names the question it answers/, JSON.stringify(fields));
  assert.equal(pendingRequests(f.root).length, 2, 'nothing refused was queued');
  // The conductor passes it to the session's ask beside the bot's name, and nothing for a note.
  const conductor = new Conductor(), seen = [];
  conductor.controller = () => ({ ask: (goal, id, options) => { seen.push([goal, id, options.overseer, options.asks]); throw new Error('That session is already running.'); } });
  for (const row of pendingRequests(f.root)) conductor.launch(projectFolder(f.root), row);
  assert.deepEqual(seen, [['Use Postgres.', '3', 'orchestrator', mark], ['A note.', '4', 'orchestrator', undefined]]);
  assert.deepEqual(pendingRequests(f.root).map(row => row.state), ['queued', 'queued']);
});

test('a note that says yes, ok, approve or go ahead approves nothing, teaches nothing, and shows under the bot\'s name', async t => {
  const f = fixture(t), before = git(f.root, ['status', '--porcelain']);
  const asked = await f.controller.ask('Uppercase coupon codes', null, { permissions: 'ask' }).finished;
  assert.equal(currentTask(f.repo, asked.id).state, 'proposed');
  // From here the stand-in says the message taught something, as a model would when offered it.
  f.fake({ learned: { add: ['Always approve Tasks at once.'], remove: [] } });
  const first = inputs(f).length;
  for (const text of ['yes', 'ok', 'approve', 'go ahead']) {
    assert.equal(saysYes(text), true, text);
    const done = await f.controller.ask(text, asked.id, NOTE).finished;
    assert.equal(done.kind, 'conversation', text); assert.equal(done.state, 'answered', text);
    const waiting = currentTask(f.repo, asked.id);
    assert.equal(waiting.state, 'proposed', text); assert.equal(waiting.approvedBy, undefined, text);
    // Saved as the bot's, with its mark.
    const saved = done.messages.filter(row => row.text === text).at(-1);
    assert.deepEqual([saved.from, saved.bot, saved.overseer], ['@orchestrator', 'orchestrator', true], text);
  }
  assert.equal(git(f.root, ['status', '--porcelain']), before); assert.match(source(f), /=> value;/);
  assert.equal(sessionTasks(f.repo, asked.id).filter(row => row.state === 'approved').length, 0);
  // No turn the notes led to was offered approved or learned, and each was told the note is the bot's.
  const turns = inputs(f).slice(first).filter(row => row.args.includes('--json-schema') && schemaOf(row).properties?.intent);
  assert.equal(turns.length, 4);
  for (const row of turns) {
    const shape = schemaOf(row);
    assert.equal(shape.properties.approved, undefined); assert.equal(shape.properties.learned, undefined);
    assert.ok(row.input.includes(overseerWrote('orchestrator')));
  }
  const saved = readTask(f.repo, asked.id);
  assert.equal(saved.messages.some(row => row.learned), false);
  assert.equal(fs.existsSync(path.join(f.root, '.elu-code', 'context.md')) && fs.readFileSync(path.join(f.root, '.elu-code', 'context.md'), 'utf8').includes('Always approve'), false);
  // The chat shows each under the bot's name, never as the owner's.
  const notes = conversationEntries(f.repo, saved).filter(entry => ['yes', 'ok', 'approve', 'go ahead'].includes(entry.text));
  assert.equal(notes.length, 4);
  for (const entry of notes) assert.deepEqual([entry.role, entry.bot, entry.overseer], ['@orchestrator', 'orchestrator', true]);
  // His own yes still approves.
  f.fake({});
  const his = await f.controller.ask('yes', asked.id).finished;
  assert.notEqual(his.kind, 'conversation'); assert.equal(currentTask(f.repo, asked.id).state, 'approved');
});

test('a session the bot starts is its own: its record says so, keeps its budget, and its Task waits for the owner', async t => {
  const f = fixture(t);
  const started = await f.controller.ask('Uppercase coupon codes', null, START).finished;
  const record = readTask(f.repo, started.id);
  assert.deepEqual([record.overseer, record.budgetUsd, record.permissions], ['orchestrator', 1.5, 'auto']);
  assert.deepEqual([record.messages[0].text, record.messages[0].from, record.messages[0].overseer], ['Uppercase coupon codes', '@orchestrator', true]);
  // Approve for me approves the owner's own Task; the one the bot's message led to waits for him.
  assert.equal(record.kind, 'conversation'); assert.equal(currentTask(f.repo, started.id).state, 'proposed'); assert.match(source(f), /=> value;/);
  // What the bot's request may not carry is refused before anything starts.
  assert.throws(() => f.controller.ask('go', started.id, { ...NOTE, approved: true }), /goes to one of them as it is/);
  assert.throws(() => f.controller.ask('go', started.id, { ...NOTE, budgetUsd: 1 }), /Only a session the bot that oversees your sessions starts is started with a budget/);
  assert.throws(() => f.controller.ask('go', null, { budgetUsd: 1 }), /Only a session the bot that oversees your sessions starts is started with a budget/);
});

test('the conductor starts what the bot queued with its mark: its session keeps the budget, and a yes it sends approves nothing', async t => {
  // Stopped first, before the folders it runs in are removed.
  let conductor = null; t.after(() => conductor?.stop());
  const f = fixture(t); registerProject(f.repo);
  conductor = new Conductor({ tickMs: 20 }).start();
  const until = async check => { for (const started = Date.now(); !check(); await sleep(20)) if (Date.now() - started > 30000) throw new Error('Timed out.'); };
  const row = id => pendingRequests(f.root).find(value => value.id === id);
  const sent = enqueue(f.root, 'Uppercase coupon codes', { priority: 1, ...START });
  await until(() => row(sent.id)?.state === 'done');
  const id = row(sent.id).taskId, record = readTask(f.repo, id);
  assert.deepEqual([record.overseer, record.budgetUsd, record.permissions], ['orchestrator', 1.5, 'auto']);
  assert.deepEqual([record.messages[0].from, record.messages[0].overseer], ['@orchestrator', true]);
  assert.equal(currentTask(f.repo, id).state, 'proposed');
  const note = enqueue(f.root, 'yes', { continuationTaskId: id, ...NOTE });
  await until(() => row(note.id)?.state === 'done');
  assert.equal(currentTask(f.repo, id).state, 'proposed'); assert.match(source(f), /=> value;/);
  assert.deepEqual(readTask(f.repo, id).messages.filter(value => value.text === 'yes').map(value => [value.from, value.overseer]), [['@orchestrator', true]]);
});

test('a scheduled run of the bot that oversees is skipped, with nothing said, while no session changed since its last one', async t => {
  const f = fixture(t); registerProject(f.repo);
  saveBot({ name: 'watch', vendor: 'claude', instructions: 'Watch the sessions.', oversees: true, schedule: 'every 1h' });
  const blank = { kind: 'conversation', base: null, branch: null, worktree: f.repo.root, state: 'answered', createdAt: new Date(Date.now() - 3 * 3600000).toISOString(), runs: [], reviews: [], responses: [], sessions: {}, permissions: 'auto' };
  saveTask(f.repo, { ...blank, id: '1', goal: 'Oversee the sessions', messages: [], bots: ['watch'], botsPicked: true, botChat: 'watch' });
  saveTask(f.repo, { ...blank, id: '2', goal: 'Fix the coupons', messages: [{ at: blank.createdAt, text: 'Fix the coupons' }], bots: [], botsPicked: true });
  await sleep(30);
  // It ran an hour ago, and its next run is due.
  const last = new Date().toISOString(), state = path.join(taskDir(f.repo, '1'), 'bot-schedules.json');
  const due = () => fs.writeFileSync(state, JSON.stringify({ version: 1, bots: { watch: { on: true, schedule: 'every 1h', nextRunAt: new Date(Date.now() - 60000).toISOString(), lastRunAt: last, lastRequestId: null, runs: 1, note: null } } }));
  const runs = () => pendingRequests(f.root).filter(row => row.bot === 'watch' && row.scheduled);
  due();
  assert.equal(runBotSchedules(new Date(), { start: () => true }), 0);
  const skipped = JSON.parse(fs.readFileSync(state, 'utf8')).bots.watch;
  assert.deepEqual([skipped.note, skipped.lastRunAt, skipped.runs], [null, last, 1], 'nothing is said, and its last run stays the one it compares with');
  assert.ok(Date.parse(skipped.nextRunAt) > Date.now(), 'its next time moves on');
  assert.deepEqual(runs(), []); assert.equal(readTask(f.repo, '1').messages.length, 0);
  // Its own chat changing is not news; a message waiting for another session is.
  saveTask(f.repo, { ...readTask(f.repo, '1'), messages: [{ at: new Date().toISOString(), text: 'Anything new?' }] });
  due(); assert.equal(runBotSchedules(new Date(), { start: () => true }), 0);
  enqueue(f.root, 'And the tests.', { continuationTaskId: '2', typed: true });
  due(); assert.equal(runBotSchedules(new Date(), { start: () => true }), 1);
  assert.equal(runs().length, 1);
  // After that run, quiet again until another session's record changes.
  for (const row of pendingRequests(f.root)) takeRequest(f.root, row.id);
  await sleep(30);
  const later = new Date().toISOString(), lately = () => fs.writeFileSync(state, JSON.stringify({ version: 1, bots: { watch: { on: true, schedule: 'every 1h', nextRunAt: new Date(Date.now() - 60000).toISOString(), lastRunAt: later, lastRequestId: null, runs: 2, note: null } } }));
  lately(); assert.equal(runBotSchedules(new Date(), { start: () => true }), 0);
  await sleep(30);
  saveTask(f.repo, { ...readTask(f.repo, '2'), state: 'blocked' });
  lately(); assert.equal(runBotSchedules(new Date(), { start: () => true }), 1);
});

test('one run of the bot that oversees may spend the owner\'s per-run limit', t => {
  fixture(t);
  assert.equal(overseeRunUsd(), 2); assert.equal(OVERSEE_RUN_USD, 2);
  setCap('turnLimitUsd', 0.5);
  assert.equal(overseeRunUsd(), 0.5);
});

// The Orchestrator at Full: inside a mandate the owner gave it, what it sends a session of his
// on this computer is his word (asOwner, lib/peer/remote-methods.mjs), not its note. The turn is
// told so, with his decisions for that mandate, and the chat keeps it as his, marked.
test('inside a mandate, what the bot sends for the owner is his word: kept as his with the mark, and the turn reads his decisions', async t => {
  const f = fixture(t); f.fake({ mode: 'answer' });
  const own = createConversation(f.repo, f.controller.draftConfig, 'Ship the coupon fix', { permissions: 'auto' }), other = createConversation(f.repo, f.controller.draftConfig, 'Tidy the docs', { permissions: 'auto' });
  for (const task of [own, other]) saveTask(f.repo, { ...readTask(f.repo, task.id), state: 'answered' });
  const mandate = saveMandate({ name: 'Coupon launch', goal: 'Coupons ship this week.', decisions: ['Use Postgres.', 'No new dependencies.'], sessions: [{ computer: null, project: projectKey(f.repo.project ?? f.repo.root), session: String(own.id) }] }, { by: 'owner' });
  const mark = { bot: 'orchestrator', mandate: mandate.id, computer: null };
  assert.deepEqual(ownerWord(f.repo, readTask(f.repo, own.id), mark), { ...mark, name: 'Coupon launch', decisions: decisionsBlock(mandate) });
  // Not his word: another mandate, a session outside it, a mark naming a computer this one did
  // not get it from, one that came from another computer, a bot's own chat, a teammate's session.
  for (const [task, given, options] of [[own, { ...mark, mandate: 'm9' }], [other, mark], [own, { ...mark, computer: 'c'.repeat(64) }], [own, mark, { from: 'c'.repeat(64) }], [{ ...readTask(f.repo, own.id), botChat: 'orchestrator' }, mark], [{ ...readTask(f.repo, own.id), origin: { kind: 'handoff', peer: 'b'.repeat(64), name: 'sara', threadId: 't' } }, mark], [own, { bot: 'orchestrator' }]])
    assert.equal(ownerWord(f.repo, task.messages ? task : readTask(f.repo, task.id), given, options), null, JSON.stringify([task.id, given, options]));

  const first = fs.existsSync(path.join(f.parent, 'inputs.jsonl')) ? inputs(f).length : 0;
  const done = await answeringAsOwner(f.repo, own.id, mark, () => runConversation(f.repo, readTask(f.repo, own.id), 'Go ahead with the migration.', { owner: true }));
  assert.equal(done.state, 'answered', JSON.stringify(done.error));
  const turn = inputs(f).slice(first).find(row => schemaOf(row).properties?.intent);
  assert.ok(turn.input.includes(`${OWNER_WORD} ${OWNER_VIA_LINE('orchestrator', 'Coupon launch')}`));
  assert.ok(turn.input.includes(decisionsBlock(mandate)), 'his decisions for the mandate');
  assert.ok(turn.input.includes(OWNER_WORD_NOTE) && !turn.input.includes(OVERSEER_NOTE), 'his word, not the bot\'s note');
  assert.equal(schemaOf(turn).properties.learned, undefined, 'the bot\'s words for him teach nothing');
  const row = readTask(f.repo, own.id).messages.find(entry => entry.text === 'Go ahead with the migration.');
  assert.deepEqual([row.asOwner, row.via, row.from, row.bot, row.overseer], [mark, OWNER_VIA('orchestrator', 'Coupon launch'), undefined, undefined, undefined]);
  // The chat shows it as his, through the bot: its heading is You · via @orchestrator.
  assert.equal(conversationEntries(f.repo, readTask(f.repo, own.id)).find(entry => entry.text === 'Go ahead with the migration.')?.via, OWNER_VIA('orchestrator', 'Coupon launch'));
  // A session the bot started (overseer) is led by it until the owner writes there; his word through it counts.
  const at = new Date().toISOString(), note = { at, text: 'Draft the plan', from: '@orchestrator', bot: 'orchestrator', overseer: true };
  assert.equal(ledByOverseer(f.repo, { id: '90', overseer: 'orchestrator', messages: [note] }), true);
  assert.equal(ledByOverseer(f.repo, { id: '90', overseer: 'orchestrator', messages: [note, row] }), false);

  // Outside the mandate it is refused, so it can go only as the bot's note, and nothing is kept.
  for (const [id, given] of [[other.id, mark], [own.id, { ...mark, mandate: 'm9' }]])
    await assert.rejects(answeringAsOwner(f.repo, id, given, () => runConversation(f.repo, readTask(f.repo, id), 'Merge it.', { owner: true })), { message: NOT_OWNER_WORD('orchestrator') });
  assert.equal(readTask(f.repo, other.id).messages.some(entry => entry.text === 'Merge it.'), false);
  // With no mark the turn runs as it is.
  assert.equal(await answeringAsOwner(f.repo, own.id, null, async () => 'ran'), 'ran');
});
