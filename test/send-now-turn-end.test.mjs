import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, autoApprove } from './helpers.mjs';
import { ProjectController, conversationEntries, registerProject } from '../lib/projects.mjs';
import * as workspace from '../lib/workspace.mjs';
import { projectFolder, pendingRequests } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';
import { Conductor, enqueue, sendCommand } from '../lib/conductor.mjs';
import { afterResult } from '../lib/process.mjs';

// Two rules meet in one run. A turn ends at its result: a vendor still there three seconds
// after it is ended with what it left running (lib/process.mjs afterResult). And a message the
// owner sends now cuts the turn, whose result is then not the end of the run: Claude Code
// goes on with the message as the next turn of the same run, and that turn's result is the
// one the three seconds count from. These are the cases where both apply.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
// background: the turn also starts a command in the background and stays open for it after
// its result, as the real CLI does (fake.json, see the fake).
function setup(t, { background = false, ...options } = {}) {
  const p = project(t), fake = fakeClis(p.parent, options);
  if (background) { const file = path.join(fake.dir, 'fake.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), background: true })); }
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); registerProject(controller.repo);
  const calls = () => rows(fake.calls).filter(row => row.vendor === 'claude' && row.args.includes('-p'));
  const absorbed = () => rows(path.join(fake.dir, 'absorbed.jsonl')), controls = () => rows(path.join(fake.dir, 'controls.jsonl'));
  const inputs = () => rows(path.join(p.parent, 'inputs.jsonl')).filter(row => row.vendor === 'claude' && row.args.includes('-p'));
  const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop());
  return { ...p, fake, controller, repo: controller.repo, calls, absorbed, controls, inputs, conductor };
}
async function until(check, message, timeout = 20000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const only = f => readTask(f.repo, '1');
const sessionOf = f => { try { return only(f); } catch { return null; } };
const request = (f, id) => pendingRequests(f.root).find(row => row.id === id);
const logRows = file => fs.readFileSync(file, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const results = file => logRows(file).filter(row => row.type === 'result').map(row => [row.subtype ?? null, row.is_error]);
const lifecycle = (file, uuid) => logRows(file).filter(row => row.type === 'command_lifecycle' && row.command_uuid === uuid).map(row => row.state);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const valueOf = (args, flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const LOOP = 'for i in $(seq 1 110); do sleep 60; done';
// Sends a message to the working turn and waits until it is on the turn's input.
async function typed(f, text) {
  const sent = enqueue(f.root, text, { continuationTaskId: '1', priority: 0 });
  await until(() => request(f, sent.id)?.turn, `"${text}" on the turn's input`);
  return { id: sent.id, uuid: request(f, sent.id).turn.uuid };
}

test('after a send now cuts the turn, its result is not the end of the run: the run answers the message however long that takes, and one sent meanwhile is answered too', { timeout: 90000 }, async t => {
  // afterMs: each turn the run goes on with takes longer than the wait after a result.
  const afterMs = 5000; assert.ok(afterMs > afterResult.graceSeconds * 1000 + 1000);
  const f = setup(t, { mode: 'listen', steps: 2, stepMs: 30000, afterMs });
  enqueue(f.root, 'Tidy the coupon module', { priority: 0 });
  await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeSendNow === true, 'the turn works');
  const first = await typed(f, 'Also keep the old name');
  // cutAt: when the turn was told to stop for the message. Both turns the run goes on with come after it.
  const cutAt = Date.now(); assert.equal(workspace.sendTypedNow(f.root, '1'), 1);
  // The turn is cut, and the run takes the message as its next turn.
  await until(() => (only(f).messages ?? []).some(row => row.during), 'the run took the message');
  const log = only(f).activeLog;
  assert.deepEqual(results(log), [['error_during_execution', true]], 'the cut turn ended as an error, and nothing has answered yet');
  // A second message while that turn works: it waits on the same input.
  const second = await typed(f, 'And say which file changed');
  // Longer than the wait after a result, and the run is still there, working.
  await new Promise(resolve => setTimeout(resolve, afterResult.graceSeconds * 1000 + 800));
  assert.equal(only(f).state, 'running', 'the run was not ended three seconds after the cut turn\'s result');
  assert.equal(f.calls().length, 1);
  await until(() => only(f).state !== 'running', 'the run ends', 40000);
  const task = only(f), took = Date.now() - cutAt;
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  assert.ok(took >= 2 * afterMs, `both turns ran to their end (${took} ms)`);
  // One run, which ended by itself: nothing was stopped, nothing was left running, nothing started again.
  assert.equal(f.calls().length, 1); assert.deepEqual(task.runs.map(run => [run.code, run.endedAfterResult ?? false, run.leftRunning ?? null]), [[0, false, null]]);
  assert.equal(task.stops, undefined); assert.equal(task.interrupted, undefined);
  assert.deepEqual(results(task.runs[0].logFile), [['error_during_execution', true], [null, false], [null, false]]);
  for (const uuid of [first.uuid, second.uuid]) assert.deepEqual(lifecycle(task.runs[0].logFile, uuid), ['queued', 'started', 'completed']);
  assert.deepEqual(f.absorbed().map(row => [row.mid, row.uuid]), [[false, first.uuid], [false, second.uuid]]);
  assert.deepEqual(f.controls(), [{ subtype: 'interrupt', send_now: true, message_uuid: first.uuid }]);
  // Nothing he sent was dropped: both are in the chat once, both were answered, and nothing waits.
  assert.deepEqual(task.messages.map(row => [row.text, row.during === true]), [['Tidy the coupon module', false], ['Also keep the old name', true], ['And say which file changed', true]]);
  const replies = conversationEntries(f.repo, task).filter(row => row.lead).map(row => row.text);
  assert.deepEqual(replies, ['Answered what you sent after the turn: Also keep the old name', 'Answered what you sent after the turn: And say which file changed']);
  assert.deepEqual(pendingRequests(f.root).filter(row => row.state === 'queued'), []);
  assert.deepEqual([request(f, first.id).state, request(f, second.id).state], ['done', 'done']);
  assert.equal(task.activeInbox, undefined); assert.equal(task.activeSendNow, undefined);
});

test('send now on a turn that then leaves a command in the background: the same turn answers the message, and the run ends at that result with the command it left', { timeout: 90000 }, async t => {
  const f = setup(t, { mode: 'command', commandMs: 30000, background: true });
  enqueue(f.root, 'Run the long check', { priority: 0 });
  await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeSendNow === true, 'the turn works and takes messages');
  const sent = await typed(f, 'Also keep the old name');
  const pressed = Date.now();
  assert.equal(workspace.sendTypedNow(f.root, '1'), 1);
  await until(() => only(f).state !== 'running', 'the turn ends', 40000);
  const task = only(f), took = Date.now() - pressed;
  assert.ok(['answered', 'needs_input'].includes(task.state), JSON.stringify(task.error));
  assert.ok(took < 20000, `long before its command, or the one it left, would have ended (${took} ms)`);
  // The message went to the turn that was working: its command moved to the background, and nothing was cut.
  assert.deepEqual(f.controls(), [{ subtype: 'interrupt', send_now: true, message_uuid: sent.uuid }]);
  assert.equal(f.calls().length, 1);
  const [run] = task.runs, log = run.logFile;
  assert.deepEqual(results(log), [[null, false]], 'one result, and no error');
  assert.deepEqual(lifecycle(log, sent.uuid), ['queued', 'started', 'completed']);
  assert.deepEqual(f.absorbed().map(row => [row.mid, row.uuid]), [[true, sent.uuid]]);
  assert.deepEqual(task.messages.map(row => [row.text, row.during === true]), [['Run the long check', false], ['Also keep the old name', true]]);
  assert.match(conversationEntries(f.repo, task).findLast(row => row.lead).text, /Also took in what you sent while it worked: Also keep the old name/);
  assert.deepEqual([request(f, sent.id).state, request(f, sent.id).reason], ['done', 'Sent to the running turn.']);
  // It had answered and stayed for the command it left: ended at its result, and the command with it.
  assert.deepEqual([run.code, run.endedAfterResult, run.leftRunning], [0, true, LOOP]);
  const pid = Number(fs.readFileSync(path.join(f.fake.dir, 'background.pid'), 'utf8'));
  for (const end = Date.now() + 5000; alive(pid) && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(alive(pid), false, 'the command it left ended with the turn');
  assert.equal(task.stops, undefined); assert.equal(task.activeInbox, undefined); assert.equal(task.activeSendNow, undefined);
});

test('/stop after a send now: the run that went on with the message is stopped whole, the message stays in the chat, and one that still waited starts the next turn in the same session', { timeout: 90000 }, async t => {
  // The turn the run goes on with would take half a minute: the stop comes while it works.
  const f = setup(t, { mode: 'listen', steps: 2, stepMs: 30000, afterMs: 30000 });
  enqueue(f.root, 'Tidy the coupon module', { priority: 0 });
  await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeSendNow === true, 'the turn works');
  const first = await typed(f, 'Also keep the old name');
  assert.equal(workspace.sendTypedNow(f.root, '1'), 1);
  await until(() => (only(f).messages ?? []).some(row => row.during), 'the run took the message');
  const stoppedLog = only(f).activeLog;
  // One more, which the run has not taken: it waits on its input.
  const second = await typed(f, 'And say which file changed');
  // The next turn answers at once.
  fakeClis(f.parent, { mode: 'answer' });
  const before = Date.now();
  sendCommand({ type: 'stop', root: f.root, taskId: '1' });
  await until(() => f.calls().length === 2 && only(f).state === 'answered', 'the waiting message started the next turn, and it answered', 40000);
  assert.ok(Date.now() - before < 20000, 'the stop did not wait for the turn the run was on');
  const task = only(f), [stopped, next] = f.calls();
  // The stopped run had answered nothing: it is no run of the session, and its log is kept as a stop.
  assert.deepEqual(results(stoppedLog), [['error_during_execution', true]]);
  assert.deepEqual((task.stops ?? []).map(row => [row.role, row.logFile]), [['lead', stoppedLog]]);
  assert.deepEqual(task.runs.map(run => [run.code, run.logFile === stoppedLog]), [[0, false]]);
  // The next turn goes on in the session that was stopped, and nothing of that stop is left to pick up twice.
  assert.equal(valueOf(next.args, '--resume'), valueOf(stopped.args, '--session-id')); assert.equal(next.args.includes('--session-id'), false);
  assert.equal(task.interrupted, undefined);
  // Nothing he sent was dropped. The message the run had taken stays where he sent it; the one
  // that still waited is the next turn's own message, and that turn read both.
  assert.deepEqual(task.messages.map(row => [row.text, row.during === true]), [['Tidy the coupon module', false], ['Also keep the old name', true], ['And say which file changed', false]]);
  const prompt = f.inputs().at(-1).input;
  assert.ok(prompt.includes('Also keep the old name') && prompt.includes('And say which file changed'), 'the next turn was given both');
  assert.deepEqual(f.absorbed().map(row => [row.mid, row.uuid]), [[false, first.uuid]], 'the stopped run never read the second');
  assert.deepEqual(lifecycle(stoppedLog, second.uuid), ['queued']);
  assert.deepEqual([request(f, first.id).state, request(f, second.id).state], ['done', 'done']);
  assert.equal(pendingRequests(f.root).some(row => row.turn || row.back || row.now || row.cancel), false, 'no mark of the stopped run is left');
  assert.deepEqual(pendingRequests(f.root).filter(row => row.state === 'queued'), []);
  assert.equal(task.activeInbox, undefined); assert.equal(task.activeSendNow, undefined);
});

test('a launch that is run again without the option that shows its work still takes messages, and still ends at its result with the command it left', { timeout: 90000 }, async t => {
  // refuses: this release ends at once on the option, with nothing printed; the turn runs again without it.
  const f = setup(t, { mode: 'listen', steps: 12, stepMs: 250, refuses: ['--thinking-display'], background: true });
  enqueue(f.root, 'Tidy the coupon module', { priority: 0 });
  // Only the second launch gets as far as its first line, which says it takes messages.
  await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeInbox === true, 'the second launch works and takes messages');
  assert.deepEqual(f.calls().map(call => [call.args.includes('--thinking-display'), valueOf(call.args, '--input-format')]), [[true, 'stream-json'], [false, 'stream-json']]);
  enqueue(f.root, 'Also keep the old name', { continuationTaskId: '1', priority: 0 });
  await until(() => (only(f).messages ?? []).some(row => row.during), 'the second launch took the message');
  const sentAt = Date.now();
  await until(() => only(f).state !== 'running', 'the turn ends', 40000);
  const task = only(f);
  assert.ok(['answered', 'needs_input'].includes(task.state), JSON.stringify(task.error));
  assert.ok(Date.now() - sentAt < 25000, 'it ended at its result, not when the command it left would');
  // One run of the session, the second launch: the first printed nothing and is no run and no stop.
  assert.equal(f.calls().length, 2); assert.equal(task.runs.length, 1); assert.equal(task.stops, undefined);
  const [run] = task.runs;
  assert.deepEqual([run.code, run.endedAfterResult, run.leftRunning], [0, true, LOOP]);
  assert.deepEqual(f.absorbed().map(row => row.mid), [true]);
  assert.deepEqual(task.messages.map(row => [row.text, row.during === true]), [['Tidy the coupon module', false], ['Also keep the old name', true]]);
  assert.match(conversationEntries(f.repo, task).findLast(row => row.lead).text, /Also took in what you sent while it worked: Also keep the old name/);
  const pid = Number(fs.readFileSync(path.join(f.fake.dir, 'background.pid'), 'utf8'));
  for (const end = Date.now() + 5000; alive(pid) && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(alive(pid), false, 'the command it left ended with the turn');
  // The option is not given to this program again.
  enqueue(f.root, 'Thanks', { continuationTaskId: '1', priority: 0 });
  await until(() => f.calls().length === 3, 'the next turn started');
  assert.equal(f.calls()[2].args.includes('--thinking-display'), false);
  await until(() => only(f).state !== 'running' && only(f).runs.length === 2, 'the next turn ends', 40000);
});
