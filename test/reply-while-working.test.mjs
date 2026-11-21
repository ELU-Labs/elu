import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, autoApprove } from './helpers.mjs';
import { makeTeam, withHome, registeredProject, shareProjects } from './peer-helpers.mjs';
import { ProjectController, conversationEntries, registerProject } from '../lib/projects.mjs';
import { projectFolder, pendingRequests } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';
import { Conductor, enqueue } from '../lib/conductor.mjs';
import { ANSWER_FIRST, ANSWER_NOW, CARRIED_ON_CALLS, DURING_BOT, DURING_COMPUTER, DURING_LEAD } from '../lib/runner.mjs';
import { WHILE_WORKING, readWords, waitingWords } from '../lib/message-aside.mjs';
import { runSteps, runsOfEntries, turnMoves } from '../lib/run-activity.mjs';
import { localRecord } from '../lib/standup-record.mjs';
import { messageTime } from '../lib/terminal-visuals.mjs';
import { hostMethods, hostTick, remoteCommand, remoteSessions, viewMethods } from '../lib/peer/remote.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { remoteRow } from '../lib/board.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';

// The owner's report: a bot's turn had worked eleven hours, he asked it a question, the chat
// said "Sent to the running turn." and nothing more. The agent had read it and written its
// answer where he never saw it. What a turn writes in answer to a message it took while it
// worked (lib/runner.mjs inboxFeed) shows in the chat at once, as a reply of the agent's said to
// be written while it works, and the line under his message says what happened to it as it
// changes: read, with the time; answered; or that the turn carried on without answering.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function until(check, message, timeout = 30000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const TIME = /\d{1,2}:\d\d [AP]M/.source;
const ANSWERED = new RegExp(`^Read ${TIME} · answered ${TIME}\\.$`), READ = new RegExp(`^Read ${TIME}\\.$`), CARRIED = new RegExp(`^Read ${TIME} · carried on without answering\\.$`);
// A project with the conductor running. Its turns go as fake (fake.json) says.
function setup(t, fake = {}) {
  const p = project(t), clis = fakeClis(p.parent, fake);
  environment(t, { ...clis.env, HOME: p.parent, ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); registerProject(controller.repo);
  const repo = controller.repo, root = repo.root;
  const runs = () => rows(clis.calls).filter(row => row.vendor === 'claude' && row.args.includes('-p'));
  const start = () => { const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop()); };
  const session = () => { try { return readTask(repo, '1'); } catch { return null; } };
  const chat = () => conversationEntries(repo, session());
  return { ...p, fake: clis, controller, repo, root, runs, start, session, chat, absorbed: () => rows(path.join(clis.dir, 'absorbed.jsonl')), set: more => { const file = path.join(clis.dir, 'fake.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...more })); } };
}
const works = f => f.session()?.state === 'running' && f.session().activeInbox === true;
// His message as the chat shows it, and the line under it.
const asked = (f, text) => f.chat().find(row => row.during && row.text === text);
const line = (f, text) => readWords(asked(f, text), messageTime);
const whileWorking = f => f.chat().filter(row => row.whileWorking);

test('what each vendor\'s stream says a turn did: its text, a call it started, its reply', () => {
  const claude = content => ({ type: 'assistant', message: { content } });
  assert.deepEqual(turnMoves(claude([{ type: 'thinking', thinking: 'Hm.' }, { type: 'text', text: ' They wait for the checks. ' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }])), [{ said: 'They wait for the checks.' }, { call: true }]);
  assert.deepEqual(turnMoves(claude([{ type: 'tool_use', id: 't2', name: 'StructuredOutput', input: {} }])), [{ reply: true }], 'the reply tool is the reply, not a step');
  assert.deepEqual(turnMoves(claude([{ type: 'text', text: '```json\n{"outcome":"done","summary":"Merged."}\n```' }])), [{ reply: true }], 'a JSON object written as text is the reply, not an answer on the way');
  assert.deepEqual(turnMoves({ ...claude([{ type: 'text', text: 'A helper agent says this.' }, { type: 'tool_use', id: 't3', name: 'Read', input: {} }]), parent_tool_use_id: 't1' }), [], 'a helper agent is not the turn');
  assert.deepEqual(turnMoves({ type: 'result', structured_output: { summary: 'Done.' } }), [{ reply: true }]);
  // Codex, as lib/codex-live.mjs writes its turn.
  assert.deepEqual(turnMoves({ type: 'item.completed', item: { type: 'agent_message', text: 'They wait for the checks.' } }), [{ said: 'They wait for the checks.' }]);
  assert.deepEqual(turnMoves({ type: 'item.completed', item: { type: 'agent_message', text: '{"outcome":"done","summary":"Done."}' } }), [{ reply: true }], 'the JSON object is the reply');
  assert.deepEqual(turnMoves({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } }), [{ call: true }]);
  assert.deepEqual(turnMoves({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test' } }), [{ ended: true }], 'a call counts once, as it starts; its end says the next one is another step');
  assert.deepEqual(turnMoves({ type: 'turn.completed' }), [{ reply: true }]);
  // Calls made at once: Claude Code names the model's message each is one of, and a call's result says it ended.
  assert.deepEqual(turnMoves({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 't4', name: 'Read', input: {} }] } }), [{ call: true, of: 'msg_1' }]);
  const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } };
  assert.deepEqual(turnMoves(result), [{ ended: true }]);
  assert.deepEqual(turnMoves({ ...result, parent_tool_use_id: 't1' }), [], 'a helper agent\'s call is not the turn\'s');
  for (const row of [{ type: 'user', message: { content: 'A message of his.' } }, { type: 'command_lifecycle', state: 'started' }, { type: 'item.completed', item: { type: 'reasoning', text: 'Hm.' } }, null]) assert.deepEqual(turnMoves(row), []);
});

test('the line under a message a running turn took says what happened to it, as it changes', () => {
  const time = value => new Date(value).toISOString().slice(11, 16);
  const row = { at: '2026-11-16T20:45:10.000Z', text: 'Why are they not merged?', during: true };
  // A message from before these were kept reads as it did.
  assert.equal(readWords(row, time), 'Sent to the running turn.');
  assert.equal(readWords(row, time, '@box'), 'Sent to the running turn on @box.');
  const sent = { ...row, sentAt: '2026-11-16T20:44:50.000Z' };
  assert.equal(readWords(sent, time), 'Read 20:45.');
  assert.equal(readWords({ ...sent, answeredAt: '2026-11-16T20:46:02.000Z' }, time), 'Read 20:45 · answered 20:46.');
  assert.equal(readWords({ ...sent, carriedOn: '2026-11-16T20:47:00.000Z' }, time), 'Read 20:45 · carried on without answering.');
  assert.equal(readWords({ ...sent, carriedOn: '2026-11-16T20:47:00.000Z', answeredAt: '2026-11-16T20:52:30.000Z' }, time), 'Read 20:45 · answered 20:52.', 'one that answered after that');
  assert.equal(readWords({ ...sent, answeredAt: '2026-11-16T20:46:02.000Z' }, time, '@box'), 'Read on @box 20:45 · answered 20:46.');
});

test('a message sent while Claude Code works is answered in the chat at once, while the turn goes on, and the reply at its end does not repeat it', { timeout: 90000 }, async t => {
  const f = setup(t, { mode: 'listen', steps: 40, stepMs: 150 }); f.start();
  enqueue(f.root, 'Tidy the coupon module', { priority: 0 });
  await until(() => works(f), 'the turn works and takes messages');
  const QUESTION = 'You have a lot of pull requests queued, why not merge them?';
  const sent = enqueue(f.root, QUESTION, { continuationTaskId: '1', priority: 0, typed: true });
  await until(() => whileWorking(f).length === 1, 'its answer is in the chat');
  // While the turn still works: his message, when it was read and answered, and the answer under the model's name.
  assert.equal(f.session().state, 'running', 'the turn goes on');
  const mine = asked(f, QUESTION), [reply] = whileWorking(f);
  assert.deepEqual([mine.role, mine.sentAt, Date.parse(mine.at) >= Date.parse(mine.sentAt), Date.parse(mine.answeredAt) >= Date.parse(mine.at)], ['You', sent.createdAt, true, true]);
  assert.match(line(f, QUESTION), ANSWERED);
  assert.deepEqual([reply.lead, reply.text, Date.parse(reply.at) >= Date.parse(mine.at)], [true, `Answer while working: ${QUESTION}`, true]);
  assert.deepEqual(f.chat().map(row => row.text).filter(text => text.includes(QUESTION)), [QUESTION, `Answer while working: ${QUESTION}`], 'each once, the answer under the message');
  // The turn was told to answer first, and that he sees it at once.
  const [taken] = f.absorbed();
  assert.ok(taken.mid && taken.content.startsWith(DURING_LEAD) && DURING_LEAD.endsWith(ANSWER_FIRST), taken.content.slice(0, 200));
  assert.match(ANSWER_FIRST, /^Answer it first: before your next tool call, write a few lines of plain text that answer it\. The chat shows them at once, while you work\. Then carry on/);
  // Where the Sessions list says what a session last said, it is counted.
  assert.equal(localRecord(f.repo, f.session()).said, `Answer while working: ${QUESTION}`);
  // The record: additive. His row as before, with when he sent it and when it was answered; the
  // answer as an update under the model's name, which an ELU from before these replies shows as one.
  const kept = f.session().messages;
  assert.deepEqual(kept.map(row => [row.text, row.during === true, row.whileWorking === true]), [['Tidy the coupon module', false, false], [QUESTION, true, false], [`Answer while working: ${QUESTION}`, false, true]]);
  const row = kept.at(-1);
  assert.deepEqual([row.update, row.lead, row.from, row.bot], [true, true, `${reply.role}${WHILE_WORKING}`, undefined]);
  await until(() => f.session().state !== 'running', 'the turn ends');
  const task = f.session(), entries = f.chat(), last = entries.at(-1);
  assert.equal(task.state, 'answered', JSON.stringify(task.error)); assert.equal(f.runs().length, 1, 'one turn');
  // The reply at its end comes after it, under the same name, and does not repeat it.
  assert.deepEqual(entries.map(row => [row.role, row.during === true, row.whileWorking === true]), [['You', false, false], ['You', true, false], [last.role, false, true], [last.role, false, false]]);
  assert.deepEqual([last.lead, last.text.includes(QUESTION), last.text.includes('Also took in')], [true, false, false]);
  assert.match(line(f, QUESTION), ANSWERED, 'the line stays');
  // The turn's steps fold above the reply it ended with, never above what it wrote on the way.
  const turn = { role: 'lead', at: task.runs[0].at, key: task.runs[0].logFile }, { owned } = runsOfEntries(entries, [turn]);
  assert.deepEqual([owned.get(last), owned.get(entries.at(-2))], [[turn], undefined]);
  assert.equal(localRecord(f.repo, task).said, last.text, 'once the turn is over, the last thing it said is its reply');
  // The next turn reads the message and what was answered, as the chat has them.
  enqueue(f.root, 'Thanks', { continuationTaskId: '1', priority: 0 });
  await until(() => f.runs().length === 2 && f.session().state === 'answered', 'the next turn');
  const prompt = rows(path.join(f.parent, 'inputs.jsonl')).filter(row => row.vendor === 'claude' && row.args.includes('-p')).at(-1).input;
  assert.ok(prompt.includes(QUESTION) && prompt.includes(`Answer while working: ${QUESTION}`));
});

test('a turn that takes a message and writes no answer: the line says it read it and carried on without answering', { timeout: 90000 }, async t => {
  // noAnswer: the stand-in reads the message and writes nothing on the way.
  const f = setup(t, { mode: 'listen', steps: 40, stepMs: 150 }); f.set({ noAnswer: true }); f.start();
  enqueue(f.root, 'Tidy the coupon module', { priority: 0 });
  await until(() => works(f), 'the turn works and takes messages');
  const QUESTION = 'Why not merge them?';
  enqueue(f.root, QUESTION, { continuationTaskId: '1', priority: 0, typed: true });
  await until(() => asked(f, QUESTION), 'the turn took it');
  // Read, and nothing more is claimed until its next steps show that it went on.
  if (!asked(f, QUESTION).carriedOn) assert.match(line(f, QUESTION), READ);
  await until(() => asked(f, QUESTION).carriedOn, 'the line says it carried on');
  assert.equal(f.session().state, 'running', 'said while the turn still works, so he can ask again or stop it');
  assert.match(line(f, QUESTION), CARRIED);
  const row = f.session().messages.find(value => value.text === QUESTION), log = f.session().activeLog;
  // Not before it started that many calls of its own after it read the message.
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(text => JSON.parse(text)), from = lines.findIndex(value => value.type === 'command_lifecycle' && value.state === 'started');
  assert.ok(lines.slice(from).flatMap(turnMoves).filter(move => move.call).length >= CARRIED_ON_CALLS);
  assert.equal(CARRIED_ON_CALLS, 3);
  assert.deepEqual([row.answeredAt, Date.parse(row.carriedOn) >= Date.parse(row.at)], [undefined, true]);
  assert.deepEqual(whileWorking(f), [], 'no answer is made up');
  // It was told once to answer now, with his message again, and taken in while the turn worked.
  const reminders = f.absorbed().filter(row => row.content.startsWith(ANSWER_NOW));
  assert.deepEqual(reminders.map(row => [row.mid, row.content.includes(JSON.stringify(QUESTION))]), [[true, true]]);
  await until(() => f.session().state !== 'running', 'the turn ends');
  assert.match(f.chat().at(-1).text, /Also took in what you sent while it worked: Why not merge them\?$/, 'its reply answers it');
  assert.equal(f.session().messages.filter(value => value.text?.includes(ANSWER_NOW)).length, 0, 'the reminder is no message of his in the chat');
  assert.match(line(f, QUESTION), CARRIED);
});

// The owner's report: he asked "ETA?" while Opus worked; it took the message, went straight to
// its next command and the line said it carried on without answering. A turn that goes on to a
// call with no answer is told once to answer now, and its answer shows as any answer does.
test('a turn that took a message and went on to a call with no answer is told once to answer now, and its answer shows at once', { timeout: 90000 }, async t => {
  const f = setup(t, { mode: 'listen', steps: 40, stepMs: 150 }); f.set({ noAnswer: true, answerWhenReminded: true }); f.start();
  enqueue(f.root, 'Tidy the coupon module', { priority: 0 });
  await until(() => works(f), 'the turn works and takes messages');
  const QUESTION = 'ETA?';
  enqueue(f.root, QUESTION, { continuationTaskId: '1', priority: 0, typed: true });
  await until(() => asked(f, QUESTION)?.answeredAt, 'the turn answers once reminded');
  assert.match(line(f, QUESTION), ANSWERED);
  assert.equal(asked(f, QUESTION).carriedOn, undefined, 'answered before it carried on');
  assert.deepEqual(whileWorking(f).map(row => row.text), [`Answer while working: ${QUESTION}`]);
  assert.equal(f.absorbed().filter(row => row.content.startsWith(ANSWER_NOW)).length, 1);
  await until(() => f.session().state !== 'running', 'the turn ends');
  assert.equal(f.absorbed().filter(row => row.content.startsWith(ANSWER_NOW)).length, 1, 'told once');
  assert.equal(f.session().runs.filter(row => row.role === 'lead').length, 1, 'no turn of its own');
  assert.match(line(f, QUESTION), ANSWERED);
});

// Found by the check of this change: a turn that looked three things up at once and then
// answered was said to have carried on without answering, and its answer never showed. Calls a
// turn makes at once are one step of its work, however its vendor writes them.
// What the turn did after it took the first message, as its log has it.
const movesSince = log => { const lines = fs.readFileSync(log, 'utf8').split('\n').flatMap(text => { try { return [JSON.parse(text)]; } catch { return []; } }), from = lines.findIndex(value => value.type === 'command_lifecycle' && value.state === 'started'); return from < 0 ? [] : lines.slice(from).flatMap(turnMoves); };
for (const lookRows of ['one', 'each']) {
  test(`a turn that looks three things up at once before it answers (${lookRows === 'each' ? 'a row for each call, under one message id' : 'one row for the three calls'}): its answer is in the chat, and it is never said to have carried on`, { timeout: 90000 }, async t => {
    const f = setup(t, { mode: 'listen', steps: 24, stepMs: 150 }); f.set({ looks: 3, lookRows }); f.start();
    enqueue(f.root, 'Tidy the coupon module', { priority: 0 });
    await until(() => works(f), 'the turn works and takes messages');
    const QUESTION = 'You have a lot of pull requests queued, why not merge them?';
    enqueue(f.root, QUESTION, { continuationTaskId: '1', priority: 0, typed: true });
    await until(() => asked(f, QUESTION), 'the turn took it');
    const moves = () => movesSince(f.session().activeLog ?? f.session().runs.at(-1).logFile);
    await until(() => moves().some(move => move.said), 'the turn wrote its answer');
    await until(() => whileWorking(f).length === 1, 'its answer is in the chat', 5000);
    assert.equal(f.session().state, 'running', 'while the turn goes on');
    // It did start three calls of its own between the message and its answer.
    assert.equal(moves().slice(0, moves().findIndex(move => move.said)).filter(move => move.call).length, 3);
    assert.equal(whileWorking(f)[0].text, `Answer while working: ${QUESTION}`);
    assert.match(line(f, QUESTION), ANSWERED);
    await until(() => f.session().state !== 'running', 'the turn ends');
    // A mark the record holds is never taken back: none means it was never said.
    assert.deepEqual([asked(f, QUESTION).carriedOn, whileWorking(f).length], [undefined, 1]);
    assert.match(line(f, QUESTION), ANSWERED);
  });
}

// What a turn writes after it was said to have carried on is still its answer: it shows in the
// chat then, and the line says when.
test('a turn that answers only after it went on for more than three calls: the line says it carried on, then its answer shows and the line says when', { timeout: 90000 }, async t => {
  // answerAfter: the stand-in writes its answer six of its steps after it took the message.
  const f = setup(t, { mode: 'listen', steps: 40, stepMs: 300 }); f.set({ answerAfter: 6 }); f.start();
  enqueue(f.root, 'Tidy the coupon module', { priority: 0 });
  await until(() => works(f), 'the turn works and takes messages');
  const QUESTION = 'You have a lot of pull requests queued, why not merge them?';
  enqueue(f.root, QUESTION, { continuationTaskId: '1', priority: 0, typed: true });
  await until(() => asked(f, QUESTION)?.carriedOn, 'the line says it carried on');
  const then = asked(f, QUESTION);
  if (!then.answeredAt) { assert.match(readWords(then, messageTime), CARRIED); assert.equal(f.session().messages.some(row => row.whileWorking), false, 'no answer yet'); }
  await until(() => whileWorking(f).length === 1, 'the answer it wrote later is in the chat');
  assert.equal(f.session().state, 'running', 'while the turn goes on');
  const mine = asked(f, QUESTION), [reply] = whileWorking(f);
  assert.deepEqual([reply.text, reply.lead], [`Answer while working: ${QUESTION}`, true]);
  assert.match(line(f, QUESTION), ANSWERED);
  // Both are kept: it was said to have carried on, and it answered after that.
  assert.ok(Date.parse(mine.answeredAt) - Date.parse(mine.carriedOn) >= 300, JSON.stringify(mine));
  const moves = movesSince(f.session().activeLog);
  assert.ok(moves.slice(0, moves.findIndex(move => move.said)).filter(move => move.call).length > CARRIED_ON_CALLS);
  await until(() => f.session().state !== 'running', 'the turn ends');
  assert.equal(whileWorking(f).length, 1); assert.doesNotMatch(f.chat().at(-1).text, /Also took in/);
  assert.match(line(f, QUESTION), ANSWERED);
});

// Text it writes after its answer and before its next call is more of that answer: a reply of
// its own in the chat, so no row the record holds changes after it was written.
test('more text before the turn\'s next call is more of its answer, kept as a reply of its own', { timeout: 90000 }, async t => {
  const f = setup(t, { mode: 'listen', steps: 30, stepMs: 150 }); f.set({ answerMore: 'They wait for the checks. I go on with the board.' }); f.start();
  enqueue(f.root, 'Tidy the coupon module', { priority: 0 });
  await until(() => works(f), 'the turn works and takes messages');
  const QUESTION = 'Why not merge them?';
  enqueue(f.root, QUESTION, { continuationTaskId: '1', priority: 0, typed: true });
  await until(() => whileWorking(f).length === 2, 'both texts are in the chat');
  assert.equal(f.session().state, 'running');
  assert.deepEqual(whileWorking(f).map(entry => entry.text), [`Answer while working: ${QUESTION}`, 'They wait for the checks. I go on with the board.']);
  const first = f.session().messages.find(row => row.whileWorking), answeredAt = asked(f, QUESTION).answeredAt;
  await until(() => f.session().state !== 'running', 'the turn ends');
  // Its later steps add none, the first row is as it was written, and the message keeps when it was first answered.
  assert.equal(whileWorking(f).length, 2);
  assert.deepEqual([f.session().messages.find(row => row.whileWorking), asked(f, QUESTION).answeredAt], [first, answeredAt]);
  assert.equal(f.chat().at(-1).whileWorking, undefined, 'its reply ends the chat');
});

test('a message sent while one long step runs says what it waits for, then when it was read and answered', { timeout: 90000 }, async t => {
  const f = setup(t, { mode: 'command', commandMs: 4000 }); f.start();
  enqueue(f.root, 'Run the long check', { priority: 0 });
  await until(() => works(f) && runSteps(f.session().activeLog).some(step => step.status === 'running'), 'the turn runs its command');
  const QUESTION = 'How far is it?';
  const sent = enqueue(f.root, QUESTION, { continuationTaskId: '1', priority: 0, typed: true });
  await until(() => pendingRequests(f.root).find(row => row.id === sent.id)?.turn, 'the turn holds it');
  // It waits for the command, and the chat says so under it.
  const waiting = pendingRequests(f.root).find(row => row.id === sent.id);
  assert.deepEqual([waiting.state, waiting.reason], ['queued', 'Waiting for the current command to finish.']);
  const words = waitingWords(waiting, { working: true, goes: true, command: true });
  assert.deepEqual([words.tag, words.lines], ['read when the running command ends', ['The running turn reads it when the command it is running ends.']]);
  assert.equal(asked(f, QUESTION), undefined, 'not said to be read before the turn read it');
  // The command ends: read then, and answered.
  await until(() => whileWorking(f).length === 1, 'read and answered once the command ended');
  const mine = asked(f, QUESTION);
  assert.ok(Date.parse(mine.at) - Date.parse(mine.sentAt) >= 1000, 'the read time is when the turn read it, not when he sent it');
  assert.match(line(f, QUESTION), ANSWERED);
  assert.equal(whileWorking(f)[0].text, `Answer while working: ${QUESTION}`);
  await until(() => f.session().state !== 'running', 'the turn ends');
  assert.equal(f.session().state, 'answered'); assert.equal(f.chat().at(-1).text.includes(QUESTION), false);
});

test('two messages in a row to a working turn: each has its own answer under it', { timeout: 90000 }, async t => {
  const f = setup(t, { mode: 'listen', steps: 40, stepMs: 150 }); f.start();
  enqueue(f.root, 'Tidy the coupon module', { priority: 0 });
  await until(() => works(f), 'the turn works and takes messages');
  enqueue(f.root, 'Also keep the old name', { continuationTaskId: '1', priority: 0, typed: true });
  await until(() => whileWorking(f).length === 1, 'the first is answered');
  enqueue(f.root, 'And say which file changed', { continuationTaskId: '1', priority: 0, typed: true });
  await until(() => whileWorking(f).length === 2, 'the second is answered');
  assert.equal(f.session().state, 'running');
  assert.deepEqual(f.chat().slice(1).map(row => [row.text, row.during === true, row.whileWorking === true]), [['Also keep the old name', true, false], ['Answer while working: Also keep the old name', false, true], ['And say which file changed', true, false], ['Answer while working: And say which file changed', false, true]]);
  for (const text of ['Also keep the old name', 'And say which file changed']) assert.match(line(f, text), ANSWERED);
  await until(() => f.session().state !== 'running', 'the turn ends');
  assert.equal(f.runs().length, 1); assert.equal(whileWorking(f).length, 2); assert.doesNotMatch(f.chat().at(-1).text, /Also took in/);
});

// The stand-in Claude Code, with the --agents flag the real one has: @lead's helpers need it.
function withAgents(dir) {
  const file = path.join(dir, 'claude'), text = fs.readFileSync(file, 'utf8'), from = "console.log('--print ";
  if (!text.includes("console.log('--agents --print ")) { assert.ok(text.includes(from), 'the stand-in lists its flags'); fs.writeFileSync(file, text.replace(from, "console.log('--agents --print ")); }
}

test('a question to @lead while its turn works is answered in the chat at once, under @lead, and its reply does not repeat it', { timeout: 120000 }, async t => {
  const f = setup(t, { mode: 'answer' }); withAgents(f.fake.dir);
  const first = await f.controller.ask('Look at the coupon code and plan the work.', null, { bot: 'lead', permissions: 'ask' }).finished;
  assert.equal(first.messages[0].to, '@lead');
  f.set({ mode: 'listen', steps: 40, stepMs: 150 }); f.start();
  enqueue(f.root, 'Go on with it', { continuationTaskId: '1', priority: 0, typed: true, bot: 'lead' });
  await until(() => works(f) && f.session().activeRole === 'bot:lead', '@lead works and takes messages');
  const QUESTION = 'You have a lot of pull requests queued, why not merge them?';
  enqueue(f.root, QUESTION, { continuationTaskId: '1', priority: 0, typed: true, bot: 'lead' });
  await until(() => whileWorking(f).length === 1, 'its answer is in the chat');
  assert.equal(f.session().state, 'running', 'the turn goes on');
  const mine = asked(f, QUESTION), [reply] = whileWorking(f);
  assert.deepEqual([mine.role, mine.to], ['You → @lead', 'lead']); assert.match(line(f, QUESTION), ANSWERED);
  assert.deepEqual([reply.role, reply.bot, reply.lead, reply.text], ['@lead', 'lead', undefined, `Answer while working: ${QUESTION}`]);
  assert.ok(f.absorbed().at(-1).content.startsWith(DURING_BOT('lead')) && DURING_BOT('lead').endsWith(ANSWER_FIRST));
  // The record: a reply of the bot's, as an ELU from before these replies reads any reply of a bot.
  const row = f.session().messages.at(-1);
  assert.deepEqual([row.from, row.bot, row.whileWorking, row.update, row.text], ['@lead', 'lead', true, undefined, `Answer while working: ${QUESTION}`]);
  const before = f.session().messages.filter(value => value.bot === 'lead' && !value.whileWorking).length;
  await until(() => f.session().state !== 'running', 'the turn ends');
  const said = f.session().messages.filter(value => value.bot === 'lead' && !value.whileWorking);
  assert.equal(said.length, before + 1, '@lead replied at the end of its turn'); assert.equal(said.at(-1).text.includes(QUESTION), false);
  assert.deepEqual(f.chat().filter(entry => entry.text.includes(QUESTION)).map(entry => [entry.role, entry.whileWorking === true]), [['You → @lead', false], ['@lead', true]], 'once each');
  assert.equal(f.chat().at(-1).role, '@lead'); assert.equal(f.chat().at(-1).whileWorking, undefined);
});

// Two computers of one owner on one project: here (he types on it) and there (the session runs on it).
function connection(key) {
  const sent = [];
  return { key, admitted: true, remoteHello: { remote: 1, shared: 1 }, sent, notify: (method, params) => sent.push([method, params]), request: async () => { throw new Error('No answer'); } };
}
const context = (me, sessions = {}) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
function pair(t) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), here = team.founder, there = team.member;
  const project = withHome(there.home, () => { const project = registeredProject(t, { origin: 'https://github.com/acme/shop.git' }); saveTeamAccess(team.teamId, { root: project.root }); shareProjects(there.identity.key, here.identity.key); return project; });
  withHome(here.home, () => { shareProjects(here.identity.key, there.identity.key); });
  const toHost = connection(here.identity.key), toViewer = connection(there.identity.key);
  const hostCtx = context(there.identity, { [here.identity.key]: toHost }), viewCtx = context(here.identity, { [there.identity.key]: toViewer });
  const host = hostMethods(hostCtx), viewer = viewMethods(viewCtx);
  toViewer.request = async (method, params) => withHome(there.home, () => host[method](params, toHost));
  return { here, there, project, toHost, hostCtx, viewCtx, host, viewer };
}

test('a message from another computer of the project to a working turn: answered there at once, and this computer shows when it was read and the answer', { timeout: 120000 }, async t => {
  const { here, there, project, toHost, hostCtx, viewCtx, host, viewer } = pair(t);
  const fake = fakeClis(project.parent, { mode: 'listen', steps: 60, stepMs: 150 });
  const names = [...Object.keys(fake.env), 'HOME', 'XDG_CONFIG_HOME'], previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  // He starts the session from here; there, only the conductor runs it.
  const started = await withHome(here.home, () => remoteCommand(viewCtx, { type: 'remoteStart', to: there.identity.key, text: 'Tidy the coupon module', permissions: 'full', place: null, model: null, bots: [] }));
  Object.assign(process.env, fake.env, { HOME: project.parent, XDG_CONFIG_HOME: there.home });
  const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop());
  const repo = projectFolder(project.root), task = () => { try { return readTask(repo, '1'); } catch { return null; } };
  await until(() => task()?.state === 'running' && task().activeInbox === true, 'the turn works there and takes messages');
  let delivered = 0;
  const look = () => {
    hostTick(hostCtx, Date.now());
    const events = toHost.sent.filter(([method]) => method === 'elu.remote.events');
    for (const [, params] of events.slice(delivered)) withHome(here.home, () => viewer['elu.remote.events'](params, connection(there.identity.key)));
    delivered = events.length;
  };
  const seen = () => withHome(here.home, () => remoteSessions().find(row => row.id === started.id));
  const app = remoteGlue({ facade: { remoteSessions: () => [] }, peerRead: () => ({ key: here.identity.key, teams: [] }), peerCommand: async () => ({}), chatMessage: ({ title, text }) => `${title}: ${text}`, ink: text => text, colour: false });
  const pane = () => app.view(remoteRow(seen(), 'box'), 140);
  look(); assert.equal(seen().state, 'running');
  const QUESTION = 'How far are you?';
  assert.deepEqual(host['elu.remote.send']({ id: started.id, text: QUESTION }, toHost), { id: started.id, working: true, takes: 'turn' });
  await until(() => (task().messages ?? []).some(row => row.whileWorking), 'the turn there answered it');
  assert.equal(task().state, 'running', 'the turn there goes on');
  // There: the turn was told who wrote it and to answer first; the record says from which computer, and when.
  const taken = rows(path.join(fake.dir, 'absorbed.jsonl')).at(-1).content;
  assert.ok(taken.includes('from another computer on this project while you were working on this turn') && taken.includes(ANSWER_FIRST) && DURING_COMPUTER('@ana', null).endsWith(ANSWER_FIRST), taken.slice(0, 200));
  const mine = task().messages.find(row => row.text === QUESTION);
  assert.deepEqual([mine.during, mine.computer, typeof mine.sentAt, typeof mine.answeredAt], [true, here.identity.key, 'string', 'string']);
  // Here: one look brings his message with the line under it, and the answer, said to be written while it works there.
  look();
  const shown = seen().entries.filter(entry => entry.text.includes(QUESTION));
  assert.deepEqual(shown.map(entry => [entry.text, entry.during === true, entry.whileWorking === true, entry.lead === true]), [[QUESTION, true, false, false], [`Answer while working: ${QUESTION}`, false, true, true]]);
  assert.deepEqual([shown[0].sentAt, shown[0].answeredAt], [mine.sentAt, mine.answeredAt]);
  assert.match(pane(), new RegExp(`You → @box: How far are you\\?\\nRead on @box ${TIME} · answered ${TIME}\\.\\n[\\s\\S]*\\n[^\\n]+ on @box · while working: Answer while working: How far are you\\?\\n`));
  assert.doesNotMatch(pane(), /Sent to the running turn/);
  // The entry held here takes what the turn did with it since, when that computer sends it again.
  const held = seen().entries.find(entry => entry.text === QUESTION);
  const again = more => withHome(here.home, () => viewer['elu.remote.events']({ items: [{ id: started.id, events: [{ seq: seen().seq + 1, type: 'entry', n: held.n + 50, role: 'You', at: held.at, text: 'A later question', during: true, sentAt: held.sentAt, ...more }] }] }, connection(there.identity.key)));
  again({}); again({ carriedOn: held.answeredAt });
  const later = seen().entries.filter(entry => entry.text === 'A later question');
  assert.deepEqual(later.map(entry => entry.carriedOn), [held.answeredAt], 'kept once, with what the turn did since');
});
