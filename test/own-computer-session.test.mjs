import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis } from './helpers.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { atomic } from '../lib/util.mjs';
import { saveBot, getBot } from '../lib/bots.mjs';
import { fromMyComputer, fromTeammate } from '../lib/modes.mjs';
import { usesSavedRules } from '../lib/permission-rules.mjs';
import { OWN_COMMANDS, ownSession } from '../lib/session-commands.mjs';
import { JOB_RULES } from '../lib/jobs.mjs';
import { KEEP_GOING, NOT_OWNER_WORD, OVERSEE_FULL_RULE, OWNER_WORD, RULES_HEADING, answeringAsOwner, answeringComputer, createConversation, ledByOverseer, overseesFull, promptRules, runConversation, teammateRulesPart } from '../lib/runner.mjs';
import { OWNER_VIA, OWNER_VIA_LINE } from '../lib/peer/remote-methods.mjs';
import { LEVELS, settingsFile } from '../lib/orchestrator-settings.mjs';
import { LEVEL_FULL } from '../lib/orchestrator-seams.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { createTeam } from '../lib/peer/roster.mjs';
import { createInvite, redeemCode } from '../lib/peer/invite.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { markMyComputer, unmarkMyComputer } from '../lib/peer/my-computers.mjs';
import { enqueue } from '../lib/conductor.mjs';
import { leadAsked, leadAskText, sentByElu } from '../lib/elu-sent.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import { ASK_BOTS, runOwnCommand } from '../lib/session-commands.mjs';
import { NOT_ASKED, unaskedBots } from '../lib/projects.mjs';

// A session one of the owner's own computers started here is his own session (the Orchestrator
// at Full, docs: orchestrator full control, section 4): marked on this computer with /computers
// mine, its origin and its messages are his, it has ELU's commands and his saved rules, and no
// teammate rules. Every other computer on a shared project stays a teammate's, exactly as before.
// The turns run on the stand-in vendors (test/fakes), in a project and a personal folder of the
// test's own.
const LAPTOP = 'c'.repeat(64), SARA = 'b'.repeat(64);
const RULES = 'Never run the payments migration.';
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// The project, and this computer on a team with the owner's laptop and a teammate's computer.
function fixture(t) {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer' });
  environment(t, { ...fake.env, ELU_NO_UPDATE_CHECK: '1', GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = new ProjectController(projectFolder(p.root));
  const me = createIdentity({ name: 'ana' }), team = createTeam(me, 'core');
  for (const [key, name] of [[LAPTOP, 'laptop'], [SARA, 'sara']]) redeemCode(createInvite(me, team.id, { hours: 1 }), key, name);
  saveTeamAccess(team.id, { rules: RULES });
  const inputs = () => { const file = path.join(p.parent, 'inputs.jsonl'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.vendor === 'claude' && row.args.includes('-p')) : []; };
  // A session another computer started here, as elu.remote.start saves it (lib/peer/remote.mjs mineOf).
  const startedFrom = (machine, name, picks = {}) => {
    const task = createConversation(controller.repo, controller.draftConfig, 'Check the build', { mine: { machine, name, remoteId: crypto.randomUUID() }, permissions: 'auto', ...picks });
    saveTask(controller.repo, { ...readTask(controller.repo, task.id), state: 'answered' });
    return readTask(controller.repo, task.id);
  };
  return { ...p, controller, repo: controller.repo, team, inputs, startedFrom, fakeDir: fake.dir };
}
const schemaOf = row => JSON.parse(row.args[row.args.indexOf('--json-schema') + 1]);
// The turn a message in that session leads to, sent from a computer (answeringComputer), as
// lib/projects.mjs ask runs it: its prompt and its output schema.
// asOwner: the request's mark (answeringAsOwner, as lib/projects.mjs ask runs a turn with one).
async function sentFrom(f, task, computer, text, { asOwner = null } = {}) {
  const first = f.inputs().length;
  const done = await answeringComputer(f.repo, task.id, computer, () => answeringAsOwner(f.repo, task.id, asOwner, () => runConversation(f.repo, readTask(f.repo, task.id), text, { owner: true, as: { computer } })));
  assert.equal(done.state, 'answered', JSON.stringify(done.error));
  const turns = f.inputs().slice(first).filter(row => schemaOf(row).properties?.intent);
  assert.equal(turns.length, 1);
  return { input: turns[0].input, schema: schemaOf(turns[0]), task: readTask(f.repo, task.id) };
}

test('a session the owner\'s own computer started here is his own: his rules, ELU\'s commands, no teammate rules; a teammate\'s computer\'s stays as before', async t => {
  const f = fixture(t);
  const laptop = f.startedFrom(LAPTOP, 'laptop'), sara = f.startedFrom(SARA, 'sara');
  assert.deepEqual([laptop.origin.kind, laptop.origin.mine, laptop.origin.machine], ['mine', true, LAPTOP]);
  // Nothing marked: every computer on the project is a teammate's, as before.
  for (const task of [laptop, sara]) {
    assert.deepEqual([fromTeammate(task.origin), fromMyComputer(task.origin), usesSavedRules(task.origin), ownSession(task.origin)], [true, false, false, false], task.origin.name);
    assert.match(teammateRulesPart(task, null, f.repo).join('\n'), new RegExp(RULES));
  }
  markMyComputer(LAPTOP, 'laptop');
  assert.deepEqual([fromTeammate(laptop.origin), fromMyComputer(laptop.origin), usesSavedRules(laptop.origin), ownSession(laptop.origin)], [false, true, true, true]);
  assert.deepEqual(teammateRulesPart(laptop, null, f.repo), []);
  assert.deepEqual([fromTeammate(sara.origin), usesSavedRules(sara.origin), ownSession(sara.origin)], [true, false, false], 'a teammate\'s computer is still a teammate\'s');
  assert.match(teammateRulesPart(sara, null, f.repo).join('\n'), new RegExp(RULES));
  // Only a session it started with elu.remote.start: a teammate's request from that computer, or
  // an origin that also names a peer, is a teammate's, whoever owns it.
  for (const origin of [{ kind: 'handoff', peer: LAPTOP, name: 'laptop', threadId: 't' }, { kind: 'ask', peer: LAPTOP, name: 'laptop' }, { ...laptop.origin, peer: SARA }, { ...laptop.origin, mine: 'yes' }, { ...laptop.origin, kind: 'handoff' }])
    assert.deepEqual([fromTeammate(origin), usesSavedRules(origin), ownSession(origin)], [true, false, false], JSON.stringify(origin));

  // A turn there: his own session's turn, with ELU's commands in its shell, and taught by his message.
  const his = await sentFrom(f, laptop, LAPTOP, 'And keep the tests green.');
  assert.ok(his.input.includes(OWN_COMMANDS[0]), 'elu sessions and the rest');
  assert.ok(his.input.includes(JOB_RULES[1]), 'elu jobs');
  assert.ok(!his.input.includes(RULES_HEADING) && !his.input.includes(RULES), 'no teammate rules');
  assert.ok(his.schema.properties.learned, 'his message teaches, as one he typed here');
  assert.deepEqual(his.task.messages.at(-1).computer, LAPTOP, 'the chat still says which computer it came from');
  // The same from the teammate's computer, in the teammate's session: as before.
  const theirs = await sentFrom(f, sara, SARA, 'And keep the tests green.');
  assert.ok(!theirs.input.includes(OWN_COMMANDS[0]) && !theirs.input.includes(JOB_RULES[1]));
  assert.ok(theirs.input.includes(RULES_HEADING) && theirs.input.includes(RULES));
  assert.equal(theirs.schema.properties.learned, undefined);
  // The teammate's computer writing into his laptop's session gets the rules for its message.
  const into = await sentFrom(f, laptop, SARA, 'Run the payments migration.');
  assert.ok(into.input.includes(RULES_HEADING) && into.input.includes(RULES)); assert.equal(into.schema.properties.learned, undefined);

  // Unmarked, the laptop is a teammate's again from its next turn.
  assert.equal(unmarkMyComputer(LAPTOP), true);
  const after = await sentFrom(f, laptop, LAPTOP, 'And the lint.');
  assert.ok(!after.input.includes(OWN_COMMANDS[0])); assert.ok(after.input.includes(RULES_HEADING));
  assert.equal(after.schema.properties.learned, undefined);
});

test('what his own computer sends counts as his: a session the bot started is his once he writes there from it', t => {
  const f = fixture(t), at = new Date().toISOString();
  const led = computer => ledByOverseer(f.repo, { id: '41', overseer: 'orchestrator', messages: [{ at, text: 'Draft the plan', from: '@orchestrator', bot: 'orchestrator', overseer: true }, { at, text: 'Use Postgres.', computer }] });
  assert.equal(led(LAPTOP), true, 'unmarked: another computer\'s message');
  markMyComputer(LAPTOP, 'laptop');
  assert.equal(led(LAPTOP), false);
  assert.equal(led(SARA), true, 'a teammate\'s computer\'s message is not his');
  // His word in a running turn is framed as his, with no teammate rules (teammateRulesPart with that computer).
  const local = { id: '42', origin: null, messages: [] };
  assert.deepEqual(teammateRulesPart(local, null, null, LAPTOP), []);
  assert.match(teammateRulesPart(local, null, null, SARA).join('\n'), new RegExp(RULES));
});

test('the bot that oversees works at Full only at that level, in its own chat, with Full access', t => {
  fixture(t);
  saveBot({ name: 'watch', vendor: 'claude', instructions: 'Watch the sessions.', oversees: true });
  saveBot({ name: 'builder', vendor: 'claude', instructions: 'Build what the session asks for.', works: true });
  const watch = getBot('watch'), chat = { id: '7', botChat: 'watch', permissions: 'full' };
  assert.equal(overseesFull(chat, watch, { level: LEVEL_FULL }), true);
  for (const [task, bot, level] of [[chat, watch, 'run'], [{ ...chat, permissions: 'auto' }, watch, LEVEL_FULL], [{ ...chat, botChat: 'other' }, watch, LEVEL_FULL], [{ ...chat, botChat: undefined }, watch, LEVEL_FULL], [{ ...chat, botChat: 'builder' }, getBot('builder'), LEVEL_FULL], [chat, null, LEVEL_FULL]])
    assert.equal(overseesFull(task, bot, { level }), false, JSON.stringify([task, bot?.name, level]));
  // Read from the owner's settings when not given: none saved is Full, the default.
  assert.equal(overseesFull(chat, watch), true);
  // What its turn is told there: Full access, what still asks him, and its level, last.
  const full = promptRules('full', ['/srv/data'], { oversee: true, overseeFull: true, helpers: true, level: 'LEVEL LINE' });
  assert.ok(full.includes(OVERSEE_FULL_RULE) && full.includes(KEEP_GOING)); assert.equal(full.at(-1), 'LEVEL LINE');
  assert.match(full.join('\n'), /Publishing a package, a tag, a release, a workflow run, a force-push, deleting a repository/);
  assert.match(full.join('\n'), /elu jobs start/); assert.match(full.join('\n'), /\/srv\/data/);
  assert.doesNotMatch(full.join('\n'), /You have no shell/);
  // Below Full, or outside Full access, it is told what it was before, and its level too.
  for (const [mode, options] of [['full', { oversee: true, level: 'LEVEL LINE' }], ['auto', { oversee: true, overseeFull: true, level: 'LEVEL LINE' }]]) {
    const rules = promptRules(mode, [], options);
    assert.match(rules.join('\n'), /You have no shell, and you cannot edit or write a file\./, mode); assert.equal(rules.at(-1), 'LEVEL LINE');
    assert.ok(!rules.includes(OVERSEE_FULL_RULE));
  }
  assert.deepEqual(promptRules('full', [], { oversee: true }), promptRules('full', [], { oversee: true, level: null }), 'no level line when it cannot be read');
});

// The level (lib/orchestrator-settings.mjs) and the Claude adapter's Full turn (lib/adapters/claude.mjs,
// OVERSEE_FULL) are both in: the runner's half of it is checked here.
test('at Full, its turn in its own chat runs in Full access with its shell, elu jobs and no dollar limit of its own', async t => {
  assert.ok(LEVELS.includes(LEVEL_FULL));
  const f = fixture(t);
  // At Full it has helpers (lib/adapters/claude.mjs), so the stand-in Claude Code lists the --agents flag the real one has.
  const claudeBin = path.join(f.fakeDir, 'claude'), stand = fs.readFileSync(claudeBin, 'utf8'), flags = "console.log('--print ";
  assert.ok(stand.includes(flags), 'the stand-in lists its flags'); fs.writeFileSync(claudeBin, stand.replace(flags, "console.log('--agents --print "));
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); atomic(settingsFile(), { version: 1, level: LEVEL_FULL, caps: {} });
  const first = f.inputs().length;
  const task = await f.controller.ask('What needs me today?', null, { bot: 'orchestrator', botChat: true, permissions: 'full' }).finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  const [call] = f.inputs().slice(first);
  assert.ok(call.input.includes(OVERSEE_FULL_RULE)); assert.ok(call.input.includes(JOB_RULES[1]));
  assert.match(call.input, /Your level on this computer, as the owner set it/);
  assert.equal(call.args.includes('--max-budget-usd'), false, 'no per-run limit at Full');
});

test('what he picked on his other computer as he started a session is the session\'s from its first turn: effort, bot models and his name for it', async t => {
  const f = fixture(t);
  const task = f.startedFrom(LAPTOP, 'laptop', { bots: ['reviewer'], effort: 'high', botModels: { reviewer: { vendor: 'codex', model: 'gpt-5.5', effort: 'high' } }, title: 'Payments cleanup' });
  assert.equal(task.leadEffort, 'high');
  assert.deepEqual(task.botModels, { reviewer: { vendor: 'codex', model: 'gpt-5.5', effort: 'high' } });
  assert.deepEqual([task.title, task.titleBy], ['Payments cleanup', 'owner'], 'his name, which the model\'s never replaces');
  const first = f.inputs().length;
  const done = await answeringComputer(f.repo, task.id, LAPTOP, () => runConversation(f.repo, readTask(f.repo, task.id), 'Go on.', { owner: true, as: { computer: LAPTOP } }));
  assert.equal(done.state, 'answered', JSON.stringify(done.error));
  const turn = f.inputs().slice(first).find(row => row.args.includes('--effort'));
  assert.equal(turn?.args[turn.args.indexOf('--effort') + 1], 'high', 'its first turn runs at that effort');
  // An effort its model does not take runs at the nearest below it; none at all is the model's own.
  assert.equal(f.startedFrom(LAPTOP, 'laptop', { effort: 'ultra' }).leadEffort, 'max');
  assert.equal(f.startedFrom(LAPTOP, 'laptop', { effort: 'none' }).leadEffort, undefined);
  const plain = f.startedFrom(LAPTOP, 'laptop');
  assert.deepEqual([plain.leadEffort, plain.botModels, plain.titleBy], [undefined, undefined, undefined]);
  // A bot that is not in it, or a model no vendor runs, is refused; a teammate's request picks none of it.
  assert.throws(() => f.startedFrom(LAPTOP, 'laptop', { bots: [], botModels: { reviewer: { vendor: 'codex' } } }), /@reviewer is not in this session\./);
  assert.throws(() => f.startedFrom(LAPTOP, 'laptop', { bots: ['reviewer'], botModels: { reviewer: { vendor: 'nobody' } } }), /Choose a supported vendor for @reviewer\./);
  for (const picks of [{ effort: 'high' }, { botModels: {} }, { title: 'Mine now' }])
    assert.throws(() => createConversation(f.repo, f.controller.draftConfig, 'Look at this', { origin: { kind: 'handoff', peer: SARA, name: 'sara', threadId: 't' }, ...picks }), /A teammate's request keeps the agents and the name it starts with\./);
});

test('the owner\'s word through the bot that started a session from his other computer is his from its first message', async t => {
  const f = fixture(t);
  markMyComputer(LAPTOP, 'laptop');
  const mark = { bot: 'orchestrator', computer: LAPTOP };
  const task = f.startedFrom(LAPTOP, 'laptop');
  const first = await sentFrom(f, task, LAPTOP, 'Check the build, and fix what fails.', { asOwner: mark });
  assert.ok(first.input.includes(`${OWNER_WORD} ${OWNER_VIA_LINE('orchestrator')}`), 'no mandate: his word as it is');
  assert.doesNotMatch(first.input, /mandate/i);
  assert.ok(first.input.includes(OWN_COMMANDS[0]) && !first.input.includes(RULES_HEADING));
  assert.equal(first.schema.properties.learned, undefined, 'the bot\'s words for him teach nothing');
  const row = first.task.messages.at(-1);
  assert.deepEqual([row.text, row.asOwner, row.via, row.from, row.bot, row.overseer, row.computer], ['Check the build, and fix what fails.', mark, OWNER_VIA('orchestrator'), undefined, undefined, undefined, undefined]);
  // The mark names the computer that sent it: one another computer sends is not his word, nor
  // one from a computer he unmarked. Each is refused, so it can go only as the bot's note.
  await assert.rejects(sentFrom(f, task, SARA, 'Merge it.', { asOwner: mark }), { message: NOT_OWNER_WORD('orchestrator') });
  await assert.rejects(sentFrom(f, task, SARA, 'Merge it.', { asOwner: { ...mark, computer: SARA } }), { message: NOT_OWNER_WORD('orchestrator') });
  await assert.rejects(sentFrom(f, task, LAPTOP, 'Merge it.', { asOwner: { ...mark, computer: null } }), { message: NOT_OWNER_WORD('orchestrator') }, 'a mark of this computer\'s, sent from another');
  unmarkMyComputer(LAPTOP);
  await assert.rejects(sentFrom(f, task, LAPTOP, 'Merge it.', { asOwner: mark }), { message: NOT_OWNER_WORD('orchestrator') });
  assert.equal(readTask(f.repo, task.id).messages.filter(row => row.text === 'Merge it.').length, 0, 'nothing of a refused one is kept');
});

// The owner's word on this computer, end to end: the conductor keeps its mark on the request
// (lib/conductor.mjs enqueue), and his controller runs it as his at Full, with no mandate, else
// as the bot's note (lib/projects.mjs ask). A start of the bot at Full keeps all it carries;
// below Full it is what it was.
test('the owner\'s word through the bot is kept on its request and is his at Full, a note below it; a Full start keeps all it carries', async t => {
  const f = fixture(t), mark = { bot: 'orchestrator', computer: null };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); atomic(settingsFile(), { version: 1, level: 'run', levelBy: 'owner', caps: {} });
  const own = createConversation(f.repo, f.controller.draftConfig, 'Fix the coupons', { permissions: 'auto' });
  saveTask(f.repo, { ...readTask(f.repo, own.id), state: 'answered' });
  // The request keeps the mark, and nothing else of his goes with it.
  const row = enqueue(f.root, 'Ship it once the tests pass.', { continuationTaskId: own.id, asOwner: mark });
  assert.deepEqual(row.asOwner, mark); assert.equal(row.overseer, undefined); assert.equal(row.typed, undefined);
  assert.throws(() => enqueue(f.root, 'Merge it.', { continuationTaskId: own.id, asOwner: mark, overseer: 'orchestrator' }), /A note of the bot that oversees your sessions goes to one of them as it is/, 'not with the bot\'s own mark');
  for (const [options, what] of [[{ asOwner: mark }, 'a new session'], [{ continuationTaskId: own.id, asOwner: { ...mark, computer: LAPTOP } }, 'naming a computer it did not come from'], [{ continuationTaskId: own.id, asOwner: mark, typed: true }, 'typed']])
    assert.throws(() => enqueue(f.root, 'Merge it.', options), /owner's word|marks what it sends/, what);
  // A start of the bot's: below Full only as before; at Full, all it carries, with no budget of its own.
  const start = { overseer: 'orchestrator', permissions: 'full', place: { kind: 'worktree' }, bots: ['reviewer'], title: 'Coupons', model: { vendor: 'claude', model: 'opus', effort: 'high' }, botModels: { reviewer: { vendor: 'codex', model: 'gpt-5.5', effort: 'high' } } };
  assert.throws(() => enqueue(f.root, 'Start the coupons work', start), /schedule's run is named|Ask for approval or Approve for me/);
  assert.throws(() => enqueue(f.root, 'Start the coupons work', { permissions: 'auto', title: 'Coupons' }), /schedule's run is named/, 'his own start names itself as before');
  atomic(settingsFile(), { version: 1, level: LEVEL_FULL, levelBy: 'owner', caps: {} });
  const started = enqueue(f.root, 'Start the coupons work', start);
  assert.deepEqual([started.permissions, started.bots, started.title, started.model, started.botModels, started.mandate, started.budgetUsd], ['full', ['reviewer'], 'Coupons', { vendor: 'claude', model: 'opus', effort: 'high' }, { reviewer: { vendor: 'codex', model: 'gpt-5.5', effort: 'high' } }, undefined, undefined]);
  assert.throws(() => enqueue(f.root, 'Start', { ...start, model: { vendor: 'claude', model: 'opus', effort: 'loud' } }), /takes no effort loud/);
  assert.throws(() => enqueue(f.root, 'Start', { ...start, botModels: { pair: { vendor: 'codex' } } }), /@pair is not one of this session's bots/);
  // His controller: below Full the word goes as the bot's note.
  atomic(settingsFile(), { version: 1, level: 'run', levelBy: 'owner', caps: {} });
  const first = f.inputs().length;
  const noted = await f.controller.ask('Ship it once the tests pass.', own.id, { asOwner: mark }).finished;
  assert.equal(noted.state, 'answered', JSON.stringify(noted.error));
  const note = readTask(f.repo, own.id).messages.at(-1);
  assert.deepEqual([note.text, note.bot, note.overseer, note.asOwner], ['Ship it once the tests pass.', 'orchestrator', true, undefined]);
  assert.ok(f.inputs().slice(first).every(call => !call.input.includes(OWNER_WORD)), 'not told it is his');
  // At Full, as his own, with the mark, and told who sent it for him.
  atomic(settingsFile(), { version: 1, level: LEVEL_FULL, levelBy: 'owner', caps: {} });
  const next = f.inputs().length;
  const his = await f.controller.ask('Merge it when green.', own.id, { asOwner: mark }).finished;
  assert.equal(his.state, 'answered', JSON.stringify(his.error));
  const word = readTask(f.repo, own.id).messages.at(-1);
  assert.deepEqual([word.text, word.asOwner, word.via, word.bot, word.overseer], ['Merge it when green.', mark, OWNER_VIA('orchestrator'), undefined, undefined]);
  assert.ok(f.inputs().slice(next).some(call => call.input.includes(`${OWNER_WORD} ${OWNER_VIA_LINE('orchestrator')}`)), 'told it is his');
  // A note never approves: an approval with a mark that does not hold here sends nothing.
  assert.throws(() => f.controller.ask('Approved', own.id, { asOwner: { ...mark, computer: LAPTOP }, approved: true }), { message: NOT_OWNER_WORD('orchestrator') });
});

// The owner's word may write to a bot of the session (@advisor ...), here through the bot that
// runs his sessions and from his paired computer, exactly as he could on this computer.
test('at Full the owner\'s word reaches a bot of the session, here and from his paired computer', async t => {
  const f = fixture(t);
  saveBot({ name: 'advisor', vendor: 'claude', instructions: 'Review designs.' });
  atomic(settingsFile(), { version: 1, level: LEVEL_FULL, levelBy: 'owner', caps: {} });
  const own = createConversation(f.repo, f.controller.draftConfig, 'Build the settings page', { permissions: 'auto', bots: ['advisor'] });
  saveTask(f.repo, { ...readTask(f.repo, own.id), state: 'answered' });
  const here = await f.controller.ask('Review the Wave 3 seams note.', own.id, { asOwner: { bot: 'orchestrator', computer: null }, bot: 'advisor' }).finished;
  assert.equal(here.state, 'answered', JSON.stringify(here.error));
  const rows = readTask(f.repo, own.id).messages;
  const asked = rows.findLast(row => row.text === 'Review the Wave 3 seams note.');
  assert.deepEqual([asked.to, asked.asOwner, asked.via], ['@advisor', { bot: 'orchestrator', computer: null }, OWNER_VIA('orchestrator')]);
  assert.ok(rows.at(-1).bot === 'advisor' && !rows.at(-1).overseer, '@advisor answered him');
  // From his own computer.
  markMyComputer(LAPTOP, 'laptop');
  const laptop = f.startedFrom(LAPTOP, 'laptop', { bots: ['advisor'] });
  const there = await f.controller.ask('Review the seams again.', laptop.id, { computer: LAPTOP, asOwner: { bot: 'orchestrator', computer: LAPTOP }, bot: 'advisor' }).finished;
  assert.equal(there.state, 'answered', JSON.stringify(there.error));
  assert.equal(readTask(f.repo, laptop.id).messages.at(-1).bot, 'advisor');
});

// The session's lead asks one of its bots (elu sessions ask): the bot answers once the lead's
// turn ends, and its answer comes back to the lead's next turn. Saying a bot was asked when
// nothing asked it is said in the chat at once.
test('the lead asks its bot with elu sessions ask, and the answer comes back to it; a claim that nothing backs is said', async t => {
  const f = fixture(t);
  saveBot({ name: 'advisor', vendor: 'claude', instructions: 'Review designs.' });
  const own = createConversation(f.repo, f.controller.draftConfig, 'Build the settings page', { permissions: 'auto', bots: ['advisor'] });
  saveTask(f.repo, { ...readTask(f.repo, own.id), state: 'answered' });
  // A bot the session does not have, an empty message, and a new session that names a bot ask nothing.
  for (const [argv, why] of [[['sessions', 'ask', 'pair', 'Look.'], /@pair is not one of this session's bots, so nothing was asked/], [['sessions', 'ask', 'advisor'], /Use elu sessions ask NAME/], [['sessions', 'new', '@advisor review this'], /it asks no bot/]]) {
    const out = await runOwnCommand(argv, { repo: f.repo, taskId: own.id, mode: 'auto' });
    assert.equal(out.code, 1, argv.join(' ')); assert.match(out.err, why);
  }
  const out = await runOwnCommand(['sessions', 'ask', '@advisor', 'Review the Wave 3 seams note.'], { repo: f.repo, taskId: own.id, mode: 'auto' });
  assert.equal(out.code, 0, out.err); assert.match(out.out, /Asked @advisor\. It answers once this turn ends/);
  const [request] = pendingRequests(f.root).filter(row => String(row.continuationTaskId) === String(own.id));
  assert.deepEqual([request.bot, request.goal, leadAsked(request.goal)?.text, request.asOwner, request.overseer], ['advisor', leadAskText('advisor', 'Review the Wave 3 seams note.'), 'Review the Wave 3 seams note.', undefined, undefined]);
  assert.equal(sentByElu(request.goal), true, "ELU's, never the owner's");
  // Nothing claimed: the request backs it.
  saveTask(f.repo, { ...readTask(f.repo, own.id), reply: { outcome: 'done', intent: 'answer', summary: 'I asked @advisor for the seams review.' } });
  assert.equal(unaskedBots(f.repo, readTask(f.repo, own.id)), null);
  // The conductor runs it as the bot's turn: the advisor answers, and the lead gets its answer next.
  const ran = await f.controller.ask(request.goal, own.id, { bot: 'advisor' }).finished;
  assert.equal(ran.state, 'answered', JSON.stringify(ran.error));
  const back = pendingRequests(f.root).filter(row => String(row.continuationTaskId) === String(own.id) && row.state === 'queued').at(-1);
  assert.match(back.goal, /^ELU: @advisor answered what you asked it\. \(ELU sent this, not the owner\.\)/);
  assert.equal(back.bot, undefined, 'to the lead, the model');
  assert.equal(sentByElu(back.goal), true);
  // A claim with nothing behind it: said in the chat.
  saveTask(f.repo, { ...readTask(f.repo, own.id), reply: { outcome: 'done', intent: 'answer', summary: 'The seams note has been sent to the configured @advisor.' } });
  for (const row of pendingRequests(f.root)) { try { (await import('../lib/workspace.mjs')).removeRequest(f.root, row.id); } catch { /* gone */ } }
  const said = unaskedBots(f.repo, readTask(f.repo, own.id));
  assert.equal(said.messages.at(-1).text, NOT_ASKED('advisor'));
  // The lead of a session with bots is told how to ask them; one with none is not.
  const told = f.inputs().length;
  const lead = await f.controller.ask('Go on.', own.id).finished;
  assert.equal(lead.state, 'answered', JSON.stringify(lead.error));
  assert.ok(f.inputs().slice(told).some(call => call.input.includes(ASK_BOTS)));
  const plain = createConversation(f.repo, f.controller.draftConfig, 'Look around', { permissions: 'auto' });
  const none = f.inputs().length;
  await f.controller.ask('Go on.', plain.id).finished;
  assert.ok(f.inputs().slice(none).every(call => !call.input.includes(ASK_BOTS)));
});
