import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, autoApprove, config, approveProjectFiles } from './helpers.mjs';
import { ProjectController, conversationEntries, projectSnapshot, registerProject } from '../lib/projects.mjs';
import { projectFolder, pendingRequests, takeRequest } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';
import { Conductor, enqueue, sendCommand } from '../lib/conductor.mjs';
import { ASIDE_ANSWERED, ASIDE_RUNNING, ASIDE_WORK, readAsides, waitingWords } from '../lib/message-aside.mjs';

// The owner's report: he wrote to a session in the middle of a long turn on a vendor that
// takes no message while it works, and the chat said only that his message waits for the turn
// to end, which was an hour or more away. Such a message is now answered at once beside the
// turn, by a short read-only run on the session's own model that is given the chat and what
// the turn has done so far. A question is done with that answer; an instruction is answered
// too, says that it asks for work, and still starts the next turn, or starts now when he
// stops the turn for it.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const BESIDE = 'You are not that turn: you run beside it';
// The stand-in Codex: its turn never ends (mode slow: half a minute), a run beside it
// answers at once, and says a message that names the helper asks for work.
const SIDE = [
  { includes: 'Rename the helper', set: { mode: 'normal', summary: 'The turn is running the tests now and has not touched the helper. Your message starts when it ends.' } },
  { includes: BESIDE, set: { mode: 'answer', summary: 'Two of three steps are done. It is running the tests now.' } },
];
function setup(t, { vendor = 'codex', extra = {}, ...options } = {}) {
  const p = project(t), fake = fakeClis(p.parent, options);
  const file = path.join(fake.dir, 'fake.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...extra }));
  environment(t, { ...fake.env, HOME: p.parent, CODEX_HOME: path.join(p.parent, 'codex-home'), GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); registerProject(controller.repo);
  if (vendor !== 'claude') controller.setDefaultModel({ vendor });
  const runs = () => rows(fake.calls).filter(row => row.vendor === vendor && (vendor === 'claude' ? row.args.includes('-p') : row.args[0] === 'exec'));
  const inputs = () => rows(path.join(p.parent, 'inputs.jsonl')).filter(row => row.vendor === vendor);
  const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop());
  return { ...p, fake, controller, repo: controller.repo, runs, inputs, conductor };
}
async function until(check, message, timeout = 20000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const only = f => readTask(f.repo, '1');
const sessionOf = f => { try { return only(f); } catch { return null; } };
const request = (f, id) => pendingRequests(f.root).find(row => row.id === id);
const shown = (f) => conversationEntries(f.repo, only(f)).map(row => [row.role, row.text, row.line === true, row.update === true]);

test('a question sent to a turn that takes no message is answered beside it within seconds: the turn goes on, the message is done, and the next turn reads both', { timeout: 90000 }, async t => {
  const f = setup(t, { mode: 'slow', extra: { byInput: SIDE } });
  enqueue(f.root, 'Tidy the coupon module', { priority: 0, permissions: 'full' });
  await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeDeaf === true, 'the turn works and takes no message');
  assert.equal(only(f).activeInbox, undefined);
  const sent = enqueue(f.root, 'How far are you?', { continuationTaskId: '1', priority: 0 }), asked = Date.now();
  await until(() => request(f, sent.id)?.state === 'done', 'the answer beside the turn');
  assert.ok(Date.now() - asked < 10000, 'within seconds, not when the turn ends');
  const done = request(f, sent.id);
  assert.equal(done.reason, ASIDE_ANSWERED);
  assert.deepEqual([done.aside.state, done.aside.kind, done.aside.text], ['answered', 'question', 'Two of three steps are done. It is running the tests now.']);
  // The turn goes on, untouched: the same run, never stopped, never resumed.
  const task = only(f);
  assert.equal(task.state, 'running'); assert.equal(task.stops?.length ?? 0, 0);
  assert.equal(f.runs().length, 2, 'the turn, and the run beside it');
  const side = f.runs()[1].args;
  assert.ok(side.includes('read-only') && side[1] !== 'resume', 'read-only, in a thread of its own');
  // It was given the chat, what the turn has done so far, and the message.
  const prompt = f.inputs().at(-1).input;
  assert.ok(prompt.includes(BESIDE) && prompt.includes('How far are you?') && prompt.includes('Tidy the coupon module'));
  assert.match(prompt, /Working on the requested change\./, 'the steps of the running turn');
  // The chat shows it now, while the turn still holds the record: his message, the answer, where it came from.
  assert.deepEqual(task.messages.filter(row => row.aside), [], 'nothing was written into the record the turn holds');
  const chat = shown(f), at = chat.findIndex(row => row[1] === 'How far are you?');
  assert.deepEqual(chat.slice(at).map(row => [row[0].replace(/^.* · /, '· '), row[1], row[2], row[3]]), [['You', 'How far are you?', false, false], ['· beside the turn', 'Two of three steps are done. It is running the tests now.', false, true], ['ELU', ASIDE_ANSWERED, true, false]]);
  // The turn ends (stopped here): the record takes the message, the answer and the run, once.
  sendCommand({ type: 'stop', root: f.root, taskId: '1' });
  await until(() => only(f).state !== 'running' && (only(f).messages ?? []).some(row => row.aside), 'the record to take it');
  const ended = only(f);
  assert.deepEqual(ended.messages.filter(row => row.aside).map(row => row.text), ['How far are you?', 'Two of three steps are done. It is running the tests now.', ASIDE_ANSWERED]);
  assert.equal(ended.runs.filter(run => run.aside === sent.id).length, 1);
  assert.equal(readAsides(f.repo, '1')[0].folded, true);
  assert.equal(shown(f).filter(row => row[1] === 'How far are you?').length, 1, 'shown once');
  // The session is told at its next turn what was asked and what was answered.
  enqueue(f.root, 'Thanks', { continuationTaskId: '1', priority: 0 });
  await until(() => f.inputs().some(row => row.input.includes('Thanks')), 'the next turn');
  const next = f.inputs().find(row => row.input.includes('Thanks')).input;
  assert.ok(next.includes('How far are you?') && next.includes('Two of three steps are done. It is running the tests now.') && next.includes(ASIDE_ANSWERED));
});

test('an instruction sent to such a turn is answered beside it and says it asks for work: it keeps its place for the next turn, and stopping the turn starts it at once', { timeout: 90000 }, async t => {
  const f = setup(t, { mode: 'slow', extra: { byInput: SIDE } });
  enqueue(f.root, 'Tidy the coupon module', { priority: 0, permissions: 'full' });
  await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeDeaf === true, 'the turn works and takes no message');
  const sent = enqueue(f.root, 'Rename the helper too', { continuationTaskId: '1', priority: 0 });
  await until(() => request(f, sent.id)?.aside?.state === 'answered', 'the answer beside the turn');
  const waiting = request(f, sent.id);
  assert.deepEqual([waiting.state, waiting.aside.kind], ['queued', 'work'], 'it still waits for the turn');
  assert.equal(only(f).state, 'running');
  // What the chat says under it: the answer, that it asks for work, and the one key with its cost.
  const words = waitingWords(waiting, { working: true, deaf: true });
  assert.equal(words.tag, 'answered · starts when this turn ends');
  assert.deepEqual(words.lines, [ASIDE_ANSWERED, ASIDE_WORK]);
  assert.equal(words.answer.text, 'The turn is running the tests now and has not touched the helper. Your message starts when it ends.');
  assert.equal(words.keys, 'Enter in the empty box sends it now: that stops the turn and the command that is running · ↑ takes it back');
  // Nothing of it is in the chat as a message yet, and no second answer is written for it.
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(f.runs().length, 2);
  assert.ok(!shown(f).some(row => row[1] === 'Rename the helper too'));
  // Enter in the empty box: the turn stops and the message starts the next one, in the same thread.
  sendCommand({ type: 'stop', root: f.root, taskId: '1' });
  await until(() => f.runs().length >= 3 && (only(f).messages ?? []).some(row => row.text === 'Rename the helper too'), 'the next turn started with it', 40000);
  assert.deepEqual(f.runs()[2].args.slice(0, 3), ['exec', 'resume', '12345678-1234-4234-8234-123456789abc']);
  assert.equal(only(f).messages.filter(row => row.text === 'Rename the helper too').length, 1);
  assert.deepEqual(only(f).messages.filter(row => row.aside), [], 'its answer beside the turn was for the wait alone');
});

test('stopping the turn while the answer beside it is still being written stops that run too, and the message starts the next turn', { timeout: 90000 }, async t => {
  const f = setup(t, { mode: 'slow', extra: { byInput: [{ includes: BESIDE, set: { mode: 'slow' } }] } });
  enqueue(f.root, 'Tidy the coupon module', { priority: 0, permissions: 'full' });
  await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeDeaf === true, 'the turn works and takes no message');
  const sent = enqueue(f.root, 'How far are you?', { continuationTaskId: '1', priority: 0 });
  await until(() => request(f, sent.id)?.aside?.state === 'running' && f.runs().length === 2, 'the run beside the turn');
  assert.equal(request(f, sent.id).reason, ASIDE_RUNNING);
  assert.equal(waitingWords(request(f, sent.id), { working: true, deaf: true }).tag, 'being answered now');
  const stopped = Date.now();
  sendCommand({ type: 'stop', root: f.root, taskId: '1' });
  await until(() => (only(f).messages ?? []).some(row => row.text === 'How far are you?'), 'the next turn started with it', 40000);
  assert.ok(Date.now() - stopped < 20000, 'neither run was waited for');
  assert.ok(!shown(f).some(row => /beside the turn/.test(row[0])), 'no answer from beside the turn shows');
});

test('a message taken back while it waits shows no answer, and one that could not be answered says why and still waits for the turn', { timeout: 90000 }, async t => {
  const f = setup(t, { mode: 'slow', extra: { byInput: [{ includes: 'Never mind', set: { mode: 'slow' } }, { includes: BESIDE, set: { mode: 'answer', tooLong: 'all', tooLongOn: [BESIDE] } }] } });
  enqueue(f.root, 'Tidy the coupon module', { priority: 0, permissions: 'full' });
  await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeDeaf === true, 'the turn works and takes no message');
  const back = enqueue(f.root, 'Never mind this one', { continuationTaskId: '1', priority: 0 });
  await until(() => request(f, back.id)?.aside?.state === 'running', 'its answer to start');
  assert.equal(takeRequest(f.root, back.id).goal, 'Never mind this one');
  const sent = enqueue(f.root, 'How far are you?', { continuationTaskId: '1', priority: 0 });
  await until(() => request(f, sent.id)?.aside?.state === 'failed', 'the answer that could not be written');
  const failed = request(f, sent.id);
  assert.equal(failed.state, 'queued');
  assert.ok(failed.aside.error.length > 0 && !/Stopped/.test(failed.aside.error), 'it says why, in the run\'s own words');
  const words = waitingWords(failed, { working: true, deaf: true });
  assert.match(words.lines[0], /^Could not be answered beside the turn: /); assert.equal(words.lines[1], 'It starts when the running turn ends.');
  assert.equal(only(f).state, 'running');
  assert.ok(!shown(f).some(row => /beside the turn/.test(row[0])));
});

test('Claude Code without the capability to take a message is answered beside its turn the same way', { timeout: 90000 }, async t => {
  const gate = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'aside-gate-')), 'go'); t.after(() => fs.rmSync(path.dirname(gate), { recursive: true, force: true }));
  const f = setup(t, { vendor: 'claude', mode: 'answer', capabilities: false, byMode: { bypassPermissions: { mode: 'live', gate, live: { seconds: 0, think: 40 } } } });
  enqueue(f.root, 'Uppercase the coupon codes', { priority: 0, permissions: 'full' });
  await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeDeaf === true, 'the turn works and takes no message');
  const sent = enqueue(f.root, 'How far are you?', { continuationTaskId: '1', priority: 0 });
  await until(() => request(f, sent.id)?.state === 'done', 'the answer beside the turn');
  assert.equal(request(f, sent.id).aside.kind, 'question');
  assert.equal(only(f).state, 'running');
  assert.ok(shown(f).some(row => /beside the turn$/.test(row[0]) && row[3]));
  fs.writeFileSync(gate, '');
  await until(() => only(f).state !== 'running' && (only(f).messages ?? []).some(row => row.aside), 'the turn to end and the record to take it');
});

// Grok Build and Antigravity read one prompt for a turn and take nothing after it (docs/vendors):
// a message to a session on either is answered beside its turn the same way. The stand-in works
// on its approved Task until the gate opens; a run beside it has no Task to carry out, so it
// answers at once.
for (const [vendor, name] of [['grok', 'Grok Build'], ['agy', 'Antigravity']]) {
  test(`${name}, whose turn takes no message, is answered beside its turn the same way`, { timeout: 150000 }, async t => {
    const gate = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'aside-gate-')), 'go'); t.after(() => fs.rmSync(path.dirname(gate), { recursive: true, force: true }));
    const f = setup(t, { vendor, mode: 'normal', live: gate });
    // The stand-in Grok Build is signed in, in this test's own home.
    if (vendor === 'grok') { fs.mkdirSync(path.join(f.parent, '.grok')); fs.writeFileSync(path.join(f.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 }); }
    const prompts = () => f.inputs().map(row => row.input);
    enqueue(f.root, 'Uppercase the coupon codes', { priority: 0, permissions: 'full' });
    await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeDeaf === true && prompts().some(text => /Keep the Task's subtasks in/.test(text)), 'the turn works on its Task and takes no message', 60000);
    assert.equal(only(f).activeInbox, undefined);
    const sent = enqueue(f.root, 'How far are you?', { continuationTaskId: '1', priority: 0 }), asked = Date.now();
    await until(() => request(f, sent.id)?.aside?.state === 'answered', 'the answer beside the turn');
    assert.ok(Date.now() - asked < 10000, 'within seconds, not when the turn ends');
    assert.equal(only(f).state, 'running', 'the turn goes on');
    // The run beside the turn was told so, and was given the chat and the message.
    const side = prompts().find(text => text.includes(BESIDE));
    assert.ok(side.includes('How far are you?') && side.includes('Uppercase the coupon codes'));
    // Its reply reads as the answer to a question: the message is done with it, and the chat shows both now.
    const answered = request(f, sent.id);
    assert.deepEqual([answered.state, answered.reason, answered.aside.kind], ['done', ASIDE_ANSWERED, 'question']);
    assert.deepEqual(shown(f).slice(-3).map(row => [row[0].replace(/^.* · /, '· '), row[2], row[3]]), [['You', false, false], ['· beside the turn', false, true], ['ELU', true, false]]);
    assert.equal(shown(f).at(-2)[1], answered.aside.text);
    fs.writeFileSync(gate, '');
    await until(() => only(f).state !== 'running' && (only(f).messages ?? []).some(row => row.aside), 'the turn to end and the record to take it', 60000);
  });
}

test('a message sent while the session runs its checks, when no turn could take it, is answered beside them the same way', { timeout: 120000 }, async t => {
  // The side run (read-only, so started with --permission-mode dontAsk) answers; the session's own turns edit.
  const f = setup(t, { vendor: 'claude', mode: 'normal', byMode: { dontAsk: { mode: 'answer' } } });
  config(f.root, value => { value.checks = [{ name: 'slow-tests', command: ['sh', '-c', 'sleep 25'] }]; return value; }); approveProjectFiles(f.root);
  enqueue(f.root, 'Normalize coupon codes', { priority: 0, permissions: 'full' });
  const checking = () => projectSnapshot(f.repo).tasks.find(task => task.activeRole === 'checks' && task.activeDeaf === true);
  await until(() => checking(), 'the checks run', 60000);
  const id = checking().id, sent = enqueue(f.root, 'How far are you?', { continuationTaskId: id, priority: 0 }), asked = Date.now();
  await until(() => request(f, sent.id)?.state === 'done', 'the answer beside the checks');
  assert.ok(Date.now() - asked < 10000, 'within seconds');
  assert.deepEqual([request(f, sent.id).aside.state, request(f, sent.id).aside.kind], ['answered', 'question']);
  assert.equal(projectSnapshot(f.repo).tasks.find(task => task.id === id).activeRole, 'checks', 'the checks go on');
  // It was told that checks run in place of a turn.
  assert.match(f.inputs().findLast(row => row.input.includes(BESIDE)).input, /ELU is running the project's checks on what this session changed\./);
  sendCommand({ type: 'stop', root: f.root, taskId: id });
  await until(() => !['running', 'preparing'].includes(projectSnapshot(f.repo).tasks.find(task => task.id === id).state), 'stopped', 30000);
});

test('what the chat says under a waiting message never is a bare "waiting": each state says what happens and when', () => {
  const said = (row, options) => { const words = waitingWords(row, options); return [words.tag, ...words.lines, words.keys].filter(Boolean).join(' | '); };
  const all = [
    said({ state: 'queued' }, { working: true }), said({ state: 'queued' }, { working: true, deaf: true }), said({ state: 'queued', aside: { state: 'running' } }, { working: true, deaf: true }),
    said({ state: 'queued', turn: { run: 'r', uuid: 'u' } }, { working: true, goes: true }), said({ state: 'queued', turn: { run: 'r', uuid: 'u' } }, { working: true, goes: true, stops: true }),
    said({ state: 'queued', turn: { run: 'r', uuid: 'u' }, fixed: true }, { working: true, goes: true }), said({ state: 'queued' }, { working: true, goes: true }), said({ state: 'queued' }, {}), said({ state: 'starting' }, { working: true }), said({ state: 'queued' }, { working: true, soon: true }),
  ];
  for (const text of all) { assert.doesNotMatch(text, /\bwaiting\b|\bwaits\b|current turn ends/i, text); assert.match(text, /when|now|next|moment|Starting/, text); }
  assert.equal(all[0], 'starts when this turn ends | It starts when the running turn ends. | Enter in the empty box sends it now: that stops the turn and the command that is running · ↑ takes it back');
  assert.equal(all[3], 'read when the running command ends | The running turn reads it when the command it is running ends. | Enter sends it now · ↑ takes it back');
  assert.equal(all[4], 'read when the running command ends | The running turn reads it when the command it is running ends. | Enter sends it now: that stops the command that is running · ↑ takes it back');
  assert.equal(said({ state: 'queued' }, { working: true, readOnly: true }), 'starts when this turn ends | It starts when the running turn ends. | Enter in the empty box sends it now: that stops the turn and the command that is running');
  // The turn it was answered beside is over (he sent it now): it starts next, and no longer says that it starts when the running turn ends.
  assert.equal(said({ state: 'queued', reason: 'It starts when the running turn ends.', aside: { state: 'answered', kind: 'work', text: 'a' } }, {}), 'starts next | Starts next. | ↑ in the message box takes it back');
  assert.equal(said({ state: 'queued', reason: 'The model was not available.' }, {}), 'starts next | The model was not available. | ↑ in the message box takes it back');
  // Where the pane is too narrow for the title and its time on one row, the title says the same in fewer words, never only that it waits.
  const short = [waitingWords({ state: 'queued' }, { working: true }), waitingWords({ state: 'queued', aside: { state: 'answered', text: 'a' } }, { working: true, deaf: true }), waitingWords({ state: 'queued', turn: {} }, { working: true, goes: true }), waitingWords({ state: 'queued' }, { working: true, soon: true })].map(words => words.short);
  assert.deepEqual(short, ['starts next turn', 'answered · next turn', 'read after the command', 'read or answered soon']);
});
