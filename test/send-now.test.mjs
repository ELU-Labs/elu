import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, autoApprove } from './helpers.mjs';
import { ProjectController, conversationEntries, registerProject } from '../lib/projects.mjs';
import * as workspace from '../lib/workspace.mjs';
import { projectFolder, pendingRequests, saveRequest, takeRequest, updateRequest } from '../lib/workspace.mjs';
import { readTask, saveTask, taskDir } from '../lib/state.mjs';
import { Conductor, enqueue, sendCommand } from '../lib/conductor.mjs';
import * as claude from '../lib/adapters/claude.mjs';
import * as runner from '../lib/runner.mjs';
import { DURING_LEAD } from '../lib/runner.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';

// What the owner sends while a turn works. Claude Code takes it in that turn: its input stays
// open, the message goes on it at once, and the turn reads it at its next step. Until then it
// waits, behind a long command for as long as the command runs, and the owner can send it now
// with Claude Code's own message for that: the command moves to the background and the turn
// goes on with the message. The other vendors read their prompt to the end before they work,
// so there the message waits for the turn to end, and sent now the turn stops and the message
// starts the next one, in the same vendor session where there is one.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const isRun = row => row.vendor === 'claude' ? row.args.includes('-p') : row.args[0] === 'exec';
const isRunOf = (vendor, row) => vendor === 'agy' ? row.args.includes('-p') && !row.args.includes('/usage') : isRun(row);
function setup(t, options = {}) {
  const p = project(t), fake = fakeClis(p.parent, options);
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); registerProject(controller.repo);
  const calls = vendor => rows(fake.calls).filter(row => row.vendor === vendor && isRun(row));
  const absorbed = () => rows(path.join(fake.dir, 'absorbed.jsonl'));
  const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop());
  return { ...p, fake, controller, repo: controller.repo, calls, absorbed, conductor };
}
async function until(check, message, timeout = 20000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const only = (f) => readTask(f.repo, '1');
const sessionOf = f => { try { return only(f); } catch { return null; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// What ELU wrote on the run's input beside messages, as the stand-in recorded it.
const controls = f => rows(path.join(f.fake.dir, 'controls.jsonl'));
const logRows = file => fs.readFileSync(file, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const lifecycle = (file, uuid) => logRows(file).filter(row => row.type === 'command_lifecycle' && row.command_uuid === uuid).map(row => row.state);
const request = (f, id) => pendingRequests(f.root).find(row => row.id === id);

test('a message sent while Claude Code works goes to that turn at its next step, and the chat keeps it once, in order', { timeout: 60000 }, async t => {
  const f = setup(t, { mode: 'listen', steps: 15, stepMs: 200 });
  enqueue(f.root, 'Tidy the coupon module', { priority: 0 });
  await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeInbox === true, 'the turn works and takes messages');
  enqueue(f.root, 'Also keep the old name', { continuationTaskId: '1', priority: 0 });
  enqueue(f.root, 'And say which file changed', { continuationTaskId: '1', priority: 0 });
  // Both go to the running turn, in the order sent: none waits for it to end.
  await until(() => (only(f).messages ?? []).filter(row => row.during).length === 2, 'both went to the turn');
  assert.equal(only(f).state, 'running', 'while it still works');
  assert.deepEqual(pendingRequests(f.root).filter(row => row.state === 'queued'), [], 'nothing waits');
  assert.deepEqual(pendingRequests(f.root).filter(row => row.reason === 'Sent to the running turn.').map(row => row.goal), ['Also keep the old name', 'And say which file changed']);
  await until(() => only(f).state !== 'running', 'the turn ends');
  const task = only(f);
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  // One run: the messages were taken in by it, at its steps, and no second turn started.
  assert.equal(f.calls('claude').length, 1);
  const args = f.calls('claude')[0].args;
  assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json', 'its input is stream-json');
  assert.ok(args.includes('--restricted') && args[args.indexOf('--permission-mode') + 1] === 'dontAsk', 'in Read only, as before');
  assert.deepEqual(f.absorbed().map(row => row.mid), [true, true]);
  // Each went with a uuid, and the turn said it took each one before ELU marked it sent.
  assert.ok(f.absorbed().every(row => UUID.test(row.uuid)));
  for (const row of f.absorbed()) assert.deepEqual(lifecycle(task.runs[0].logFile, row.uuid), ['queued', 'started', 'completed']);
  assert.deepEqual(controls(f), [], 'nothing was interrupted');
  assert.ok(f.absorbed()[0].content.startsWith(DURING_LEAD), 'the turn is told what the message is');
  assert.ok(f.absorbed()[0].content.includes('"text":"Also keep the old name"'));
  // In the chat each shows once, where it was sent, and the one reply answers all of it.
  assert.deepEqual(task.messages.map(row => [row.text, row.during === true]), [['Tidy the coupon module', false], ['Also keep the old name', true], ['And say which file changed', true]]);
  const entries = conversationEntries(f.repo, task);
  assert.deepEqual(entries.map(row => [row.role, row.during === true]), [['You', false], ['You', true], ['You', true], [entries.at(-1).role, false]]);
  assert.equal(entries.at(-1).lead, true);
  assert.match(entries.at(-1).text, /Also took in what you sent while it worked: Also keep the old name \| And say which file changed$/);
  assert.equal(task.activeInbox, undefined, 'no turn takes messages now');
  // The next turn reads them as the owner's messages.
  enqueue(f.root, 'Thanks', { continuationTaskId: '1', priority: 0 });
  await until(() => f.calls('claude').length === 2 && only(f).state === 'answered', 'the next turn');
  const prompt = rows(path.join(f.parent, 'inputs.jsonl')).filter(row => row.vendor === 'claude' && row.args.includes('-p')).at(-1).input;
  assert.ok(prompt.includes('Also keep the old name') && prompt.includes('And say which file changed'));
});

// The owner's report: he typed while the model sat in a three-minute command, the chat said
// the message was sent to the running turn, and nothing read it until the command ended.
test('a message sent while a long command runs waits for the command; sent now, the command moves to the background and the same turn answers it', { timeout: 60000 }, async t => {
  const f = setup(t, { mode: 'command', commandMs: 30000 });
  enqueue(f.root, 'Run the long check', { priority: 0 });
  await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeInbox === true, 'the turn works and takes messages');
  const sent = enqueue(f.root, 'Also keep the old name', { continuationTaskId: '1', priority: 0 });
  // The command prints nothing and has not ended, so the turn has not read the message.
  await sleep(1200);
  assert.equal(request(f, sent.id).state, 'queued', 'it is not marked sent before the turn took it');
  assert.equal(request(f, sent.id).reason, 'Waiting for the current command to finish.');
  const uuid = request(f, sent.id).turn.uuid; assert.match(uuid, UUID);
  assert.deepEqual((only(f).messages ?? []).filter(row => row.during), []);
  assert.equal(only(f).activeSendNow, true, 'this Claude Code can be told to take it now');
  assert.deepEqual(controls(f), [], 'and nothing has interrupted the command');
  // Enter: Claude Code's own send-now, by the message's uuid.
  const pressed = Date.now();
  assert.equal(workspace.sendTypedNow(f.root, '1'), 1);
  await until(() => (only(f).messages ?? []).some(row => row.during), 'the turn took it');
  assert.deepEqual(controls(f), [{ subtype: 'interrupt', send_now: true, message_uuid: uuid }]);
  assert.deepEqual([request(f, sent.id).state, request(f, sent.id).reason, request(f, sent.id).turn], ['done', 'Sent to the running turn.', undefined]);
  await until(() => only(f).state !== 'running', 'the turn ends');
  assert.ok(Date.now() - pressed < 15000, 'long before the command would have ended');
  const task = only(f);
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  // The same run went on: nothing stopped, nothing started again.
  assert.equal(f.calls('claude').length, 1); assert.deepEqual(task.runs.map(run => run.code), [0]);
  const log = task.runs[0].logFile;
  assert.match(fs.readFileSync(log, 'utf8'), /Command was moved to the background \(ID: bash_1\) so that a message that arrived while it was running can reach you; it was not interrupted\./);
  assert.deepEqual(lifecycle(log, uuid), ['queued', 'started', 'completed']);
  assert.deepEqual(logRows(log).filter(row => row.type === 'result').map(row => row.is_error), [false], 'one result, and no error');
  assert.deepEqual(task.messages.map(row => [row.text, row.during === true]), [['Run the long check', false], ['Also keep the old name', true]]);
  assert.match(conversationEntries(f.repo, task).at(-1).text, /Also took in what you sent while it worked: Also keep the old name$/);
  assert.equal(task.activeInbox, undefined); assert.equal(task.activeSendNow, undefined);
});

test('sent now while the turn works on something that cannot move, the turn is cut and the message starts the next turn of the same run', { timeout: 60000 }, async t => {
  // Two steps half a minute apart: the model is busy, and no command stands in the way.
  const f = setup(t, { mode: 'listen', steps: 2, stepMs: 30000 });
  enqueue(f.root, 'Tidy the coupon module', { priority: 0 });
  await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeSendNow === true, 'the turn works');
  const sent = enqueue(f.root, 'Also keep the old name', { continuationTaskId: '1', priority: 0 });
  await until(() => request(f, sent.id)?.turn, 'it is on the turn\'s input');
  const uuid = request(f, sent.id).turn.uuid;
  assert.equal(workspace.sendTypedNow(f.root, '1'), 1);
  await until(() => only(f).state !== 'running', 'the run ends');
  const task = only(f);
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  assert.deepEqual(controls(f), [{ subtype: 'interrupt', send_now: true, message_uuid: uuid }]);
  // One run: the cut turn ends as an error, and the message is answered by the next turn of that run.
  assert.equal(f.calls('claude').length, 1); assert.deepEqual(task.runs.map(run => run.code), [0]);
  const log = task.runs[0].logFile;
  assert.deepEqual(logRows(log).filter(row => row.type === 'result').map(row => [row.subtype ?? null, row.is_error]), [['error_during_execution', true], [null, false]]);
  assert.deepEqual(lifecycle(log, uuid), ['queued', 'started', 'completed']);
  assert.deepEqual(f.absorbed().map(row => [row.mid, row.uuid]), [[false, uuid]]);
  assert.deepEqual(task.messages.map(row => [row.text, row.during === true]), [['Tidy the coupon module', false], ['Also keep the old name', true]]);
  const entries = conversationEntries(f.repo, task);
  assert.deepEqual(entries.map(row => row.lead === true), [false, false, true], 'the cut turn wrote no reply of its own');
  assert.equal(entries.at(-1).text, 'Answered what you sent after the turn: Also keep the old name');
  assert.deepEqual(pendingRequests(f.root).filter(row => row.state === 'queued'), []);
});

test('a waiting message is taken back from the running turn with Claude Code\'s own message, and the turn never reads it', { timeout: 60000 }, async t => {
  const f = setup(t, { mode: 'command', commandMs: 3000 });
  enqueue(f.root, 'Run the long check', { priority: 0 });
  await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeInbox === true, 'the turn works and takes messages');
  const sent = enqueue(f.root, 'Also keep the old name', { continuationTaskId: '1', priority: 0 });
  await until(() => request(f, sent.id)?.turn, 'it is on the turn\'s input');
  const uuid = request(f, sent.id).turn.uuid;
  // ↑ marks it, and the run asks Claude Code to cancel it by its uuid.
  assert.ok(updateRequest(f.root, sent.id, { cancel: new Date().toISOString() }, { from: ['queued'] }));
  await until(() => request(f, sent.id)?.back === true, 'the turn gave it back');
  assert.deepEqual(controls(f), [{ subtype: 'cancel_async_message', message_uuid: uuid }]);
  assert.deepEqual([request(f, sent.id).state, request(f, sent.id).turn, request(f, sent.id).cancel], ['queued', undefined, undefined]);
  // Still his, and not written to the turn again: the terminal takes it into the box.
  await sleep(600);
  assert.equal(controls(f).length, 1); assert.equal(takeRequest(f.root, sent.id).goal, 'Also keep the old name');
  await until(() => only(f).state !== 'running', 'the turn ends');
  const task = only(f);
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  assert.deepEqual(lifecycle(task.runs[0].logFile, uuid), ['queued', 'cancelled']);
  assert.deepEqual(f.absorbed(), [], 'the turn never read it');
  assert.deepEqual(task.messages.map(row => row.text), ['Run the long check']);
  assert.equal(f.calls('claude').length, 1);
});

test('a turn that is stopped while a message waits on its input loses nothing: the message starts the next turn, in the same session', { timeout: 60000 }, async t => {
  const f = setup(t, { mode: 'command', commandMs: 30000 });
  enqueue(f.root, 'Run the long check', { priority: 0 });
  await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeInbox === true, 'the turn works and takes messages');
  const sent = enqueue(f.root, 'Also keep the old name', { continuationTaskId: '1', priority: 0 });
  await until(() => request(f, sent.id)?.turn, 'it is on the turn\'s input');
  sendCommand({ type: 'stop', root: f.root, taskId: '1' });
  await until(() => f.calls('claude').length === 2, 'the next turn started');
  const [first, next] = f.calls('claude');
  assert.equal(next.args[next.args.indexOf('--resume') + 1], first.args[first.args.indexOf('--session-id') + 1], 'in the session that was stopped');
  await until(() => only(f).messages.length === 2, 'the message is the next turn\'s');
  assert.deepEqual(only(f).messages.map(row => [row.text, row.during === true]), [['Run the long check', false], ['Also keep the old name', false]]);
  assert.equal(pendingRequests(f.root).some(row => row.turn || row.back || row.now), false, 'no mark of the stopped run is left');
  sendCommand({ type: 'stop', root: f.root, taskId: '1' });
  await until(() => only(f).state === 'stopped', 'stopped');
});

// A Claude Code release whose init row names none of this takes no message while it works.
test('without the capability in its init row, a message waits for the turn to end, and sent now the turn stops first', { timeout: 60000 }, async t => {
  const f = setup(t, { mode: 'command', commandMs: 30000, capabilities: false });
  enqueue(f.root, 'Run the long check', { priority: 0 });
  await until(() => sessionOf(f)?.state === 'running' && f.calls('claude').length === 1, 'the turn works');
  const sent = enqueue(f.root, 'Also keep the old name', { continuationTaskId: '1', priority: 0 });
  await sleep(1200);
  // Nothing went on its input: the message waits, as it does on the other vendors.
  assert.deepEqual([request(f, sent.id).state, request(f, sent.id).turn], ['queued', undefined]);
  assert.deepEqual([only(f).activeInbox, only(f).activeSendNow], [undefined, undefined]);
  assert.deepEqual(controls(f), []); assert.deepEqual(f.absorbed(), []);
  assert.equal(workspace.sendTypedNow(f.root, '1'), 1, 'marked, and nothing takes it');
  await sleep(600); assert.deepEqual(controls(f), []);
  // Send now there is the stop /stop sends, and the message starts the next turn.
  sendCommand({ type: 'stop', root: f.root, taskId: '1' });
  await until(() => f.calls('claude').length === 2 && only(f).messages.length === 2, 'the next turn started');
  const [first, next] = f.calls('claude');
  assert.equal(next.args[next.args.indexOf('--resume') + 1], first.args[first.args.indexOf('--session-id') + 1]);
  assert.deepEqual(only(f).messages.map(row => [row.text, row.during === true]), [['Run the long check', false], ['Also keep the old name', false]]);
  sendCommand({ type: 'stop', root: f.root, taskId: '1' });
  await until(() => only(f).state === 'stopped', 'stopped');
});

test('a message to someone else waits, and so does each message behind it', t => {
  const p = project(t); environment(t, { XDG_CONFIG_HOME: path.join(p.parent, 'personal') });
  const at = n => new Date(Date.UTC(2026, 10, 13, 10, 0, n)).toISOString();
  const base = { state: 'queued', priority: 0, continuationTaskId: '4', taskId: null, attempts: 0, notBefore: null, reason: 'Waiting to start.' };
  saveRequest(p.root, 'First', 'r1', { ...base, queuedAt: at(1) });
  saveRequest(p.root, 'To the bot', 'r2', { ...base, queuedAt: at(2), bot: 'sec' });
  saveRequest(p.root, 'Third', 'r3', { ...base, queuedAt: at(3) });
  saveRequest(p.root, 'With a new mode', 'r4', { ...base, continuationTaskId: '5', queuedAt: at(4), permissions: 'full' });
  const front = (id, bot) => workspace.typedFront(pendingRequests(p.root), id, bot).map(row => row.goal);
  assert.deepEqual(front('4'), ['First'], 'the bot\'s message stops the rest');
  assert.deepEqual(front('5'), [], 'a message that changes the session\'s choices starts a turn of its own');
  assert.deepEqual(front('4', 'sec'), [], 'and the bot\'s waits behind the one before it');
  // Once the first went, the bot's is at the front for the bot's turn, and only it is marked to go now.
  const find = goal => pendingRequests(p.root).find(row => row.goal === goal);
  assert.ok(updateRequest(p.root, find('First').id, { state: 'done' }));
  assert.deepEqual(front('4', 'sec'), ['To the bot']); assert.deepEqual(front('4'), []);
  assert.equal(workspace.sendTypedNow(p.root, '4', 'sec'), 1);
  assert.deepEqual([typeof find('To the bot').now, find('To the bot').reason, find('Third').now], ['string', 'Sending it now.', undefined]);
});

test('a run that took a message after its last step replied twice, and the chat shows both replies', t => {
  const f = { ...project(t) }; environment(t, { XDG_CONFIG_HOME: path.join(f.parent, 'personal') });
  const controller = new ProjectController(projectFolder(f.root)), repo = controller.repo;
  const result = summary => JSON.stringify({ type: 'result', is_error: false, session_id: 's', total_cost_usd: 0.1, structured_output: { outcome: 'done', intent: 'answer', summary, question: null, choices: [], comments: [], responses: [] } });
  const log = [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5' }), result('Tidied it.'), result('Kept the old name too.')].join('\n');
  assert.deepEqual(claude.replies(log), ['Tidied it.', 'Kept the old name too.']);
  assert.equal(claude.parse(log, { validate: value => value }).result.summary, 'Kept the old name too.', 'the run\'s result is its last');
  const now = Date.now(), at = n => new Date(now + n).toISOString();
  const task = { id: '3', kind: 'conversation', worktree: repo.root, base: null, branch: null, goal: 'Tidy it', state: 'answered', createdAt: at(0), runs: [], sessions: {}, messages: [{ at: at(0), text: 'Tidy it' }, { at: at(10), text: 'Keep the old name', during: true }] };
  fs.mkdirSync(taskDir(repo, '3'), { recursive: true });
  const file = path.join(taskDir(repo, '3'), 'lead-s.log'); fs.writeFileSync(file, `${log}\n`);
  task.runs.push({ role: 'lead', vendor: 'claude', logFile: file, code: 0, session: 's', at: at(20) });
  saveTask(repo, task);
  const entries = conversationEntries(repo, readTask(repo, '3'));
  assert.deepEqual(entries.map(row => [row.lead === true, row.text, row.during === true]), [[false, 'Tidy it', false], [false, 'Keep the old name', true], [true, 'Tidied it.', false], [true, 'Kept the old name too.', false]]);
});

test('a waiting message for Codex is sent now: the turn stops and the message starts the next one in the same thread', { timeout: 60000 }, async t => {
  const f = setup(t, { mode: 'slow' });
  f.controller.setDefaultModel({ vendor: 'codex' });
  // In Full access, where a Codex turn goes on in its thread (Read only starts a new one each turn).
  enqueue(f.root, 'Tidy the coupon module', { priority: 0, permissions: 'full' });
  await until(() => sessionOf(f)?.state === 'running' && f.calls('codex').length === 1, 'Codex works');
  enqueue(f.root, 'Also keep the old name', { continuationTaskId: '1', priority: 0 });
  enqueue(f.root, 'And say which file changed', { continuationTaskId: '1', priority: 0 });
  // Codex reads its prompt to the end before it works, so they wait for the turn.
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.deepEqual(pendingRequests(f.root).filter(row => row.state === 'queued').map(row => row.goal), ['Also keep the old name', 'And say which file changed']);
  assert.equal(only(f).activeInbox, undefined);
  assert.equal(only(f).state, 'running');
  // Send now: the stop /stop sends. The waiting messages start the next turn at once, joined.
  sendCommand({ type: 'stop', root: f.root, taskId: '1' });
  await until(() => f.calls('codex').length === 2 && only(f).state === 'answered', 'the next turn ran');
  const [first, next] = f.calls('codex');
  assert.notEqual(first.args[1], 'resume');
  assert.deepEqual(next.args.slice(0, 3), ['exec', 'resume', '12345678-1234-4234-8234-123456789abc'], 'it went on in the thread that was stopped');
  const task = only(f);
  assert.deepEqual(task.messages.map(row => row.text), ['Tidy the coupon module', 'Also keep the old name\n\nAnd say which file changed']);
  assert.equal(task.interrupted, undefined, 'the stopped turn was picked up');
  assert.deepEqual(pendingRequests(f.root).filter(row => row.state === 'queued'), []);
});

// Codex in Read only starts a new thread each turn, and an Antigravity run without ACP names
// its conversation only in the line it ends with: neither has a session to go on in after a
// stop. The next turn is given what the stopped one said and did, read from its log.
test('a stopped turn that cannot be resumed hands what it said and did to the next turn', { timeout: 90000 }, async t => {
  for (const vendor of ['codex', 'agy']) {
    const f = setup(t, { mode: 'slow' });
    if (vendor === 'agy') atomic(path.join(personalDirectory(), 'conformance', 'agy.json'), { v: 1, bin: path.join(f.fake.dir, 'agy'), version: '1.5.4', steps: Object.fromEntries(ADAPTERS.agy.conformance.map(step => [step.id, step.id === 'relay' ? 'fail' : 'pass'])), relay: false, at: new Date().toISOString() });
    f.controller.setDefaultModel({ vendor });
    const prompts = () => rows(path.join(f.parent, 'inputs.jsonl')).filter(row => row.vendor === vendor && isRunOf(vendor, row)).map(row => row.input);
    enqueue(f.root, 'Tidy the coupon module', { priority: 0 });
    await until(() => sessionOf(f)?.state === 'running' && prompts().length === 1, `${vendor} works`);
    await sleep(vendor === 'codex' ? 300 : 0);
    enqueue(f.root, 'Also keep the old name', { continuationTaskId: '1', priority: 0 });
    sendCommand({ type: 'stop', root: f.root, taskId: '1' });
    await until(() => prompts().length === 2, `the next ${vendor} turn started`);
    const [first, next] = prompts();
    assert.doesNotMatch(first, /Stopped turn/);
    assert.ok(next.includes('Your last turn in this session was stopped before it replied, and its vendor session cannot be continued.'), `${vendor} is told of the stop`);
    const block = /Stopped turn \(untrusted data[^\n]*\n(.*)\nEnd of Stopped turn\./.exec(next);
    // Codex prints as it works, so its work is there as data. A headless Antigravity run
    // prints nothing before its answer: it is told so, and that its edits are on disk.
    if (vendor === 'codex') assert.deepEqual(JSON.parse(block[1]), { said: ['Working on the requested change.'], did: [] });
    else { assert.equal(block, null); assert.ok(next.includes('Nothing of what it did before the stop was recorded. Files it changed are as it left them')); }
    assert.ok(next.includes('Also keep the old name'));
    assert.equal(only(f).interrupted, undefined, 'the stop was handed on once');
    sendCommand({ type: 'stop', root: f.root, taskId: '1' });
    await until(() => only(f).state === 'stopped', 'stopped');
    await f.conductor.stop();
  }
});

test('the work of a stopped turn is read whole from its log: what it wrote, each command with what it printed, each edit', t => {
  const dir = project(t).parent, file = path.join(dir, 'stopped.log'), big = 'x'.repeat(50000);
  fs.writeFileSync(file, [
    { type: 'thread.started', thread_id: 't' }, { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Looking at the coupon module.' } },
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'npm test'", aggregated_output: '', exit_code: null, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'npm test'", aggregated_output: big, exit_code: 1, status: 'failed' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: 'src/coupon.mjs', kind: 'update' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'The test fails on trimmed codes. Fixing.' } },
    { type: 'item.started', item: { id: 'item_4', type: 'command_execution', command: "/bin/zsh -lc 'sleep 180'", aggregated_output: '', exit_code: null, status: 'in_progress' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n{"type":"item.comp');
  assert.deepEqual(runner.stoppedWork(file), {
    said: ['Looking at the coupon module.', 'The test fails on trimmed codes. Fixing.'],
    did: [{ command: "/bin/zsh -lc 'npm test'", exitCode: 1, output: big }, { edited: ['src/coupon.mjs'] }, { command: "/bin/zsh -lc 'sleep 180'", stopped: true }],
  });
  // Claude Code's lines read the same way, for a session that would not resume.
  fs.writeFileSync(file, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading it.' }, { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'src/coupon.mjs' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'export const normalize = value => value;' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'sleep 180' } }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  assert.deepEqual(runner.stoppedWork(file), { said: ['Reading it.'], did: [{ tool: 'Read', input: { file_path: 'src/coupon.mjs' }, output: 'export const normalize = value => value;' }, { tool: 'Bash', input: { command: 'sleep 180' }, stopped: true }] });
  // An ACP agent's lines: its text comes in pieces, and each tool call has a title.
  const piece = text => ({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  fs.writeFileSync(file, [piece('Reading '), piece('the module.'), { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', title: 'Edit src/coupon.mjs' } } }, piece('Done with it.')].map(row => JSON.stringify(row)).join('\n'));
  assert.deepEqual(runner.stoppedWork(file), { said: ['Reading the module.', 'Done with it.'], did: [{ step: 'Edit src/coupon.mjs' }] });
  assert.deepEqual(runner.stoppedWork(path.join(dir, 'missing.log')), { said: [], did: [] });
});
