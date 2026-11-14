import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { project, fakeClis, autoApprove } from './helpers.mjs';
import { ProjectController, conversationEntries, registerProject } from '../lib/projects.mjs';
import * as workspace from '../lib/workspace.mjs';
import { projectFolder, pendingRequests, takeRequest, updateRequest } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';
import { Conductor, enqueue } from '../lib/conductor.mjs';
import { DURING_LEAD } from '../lib/runner.mjs';
import { describe, execItem, liveLaunch, noMethod, serverArgs, steers, threadSettings } from '../lib/codex-live.mjs';

// What the owner sends while a Codex turn works. `codex exec` reads its prompt to the end and
// takes nothing more, so there a message waited for the turn to end: an hour or more. Codex's
// app-server takes a message into the running turn (turn/steer), so a Codex that has it runs
// the owner's turn through it: the message goes to the turn, which reads it at its next step,
// as on Claude Code. Whether the installed Codex has it is asked of the program itself; one
// that has not runs exec as before.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
// appServer: what the stand-in Codex's app-server speaks ('steer': the interface read on the
// real program; 'threads': turns but no turn/steer; absent: the usage read alone).
function setup(t, { appServer, ...options } = {}) {
  const p = project(t), fake = fakeClis(p.parent, options);
  const file = path.join(fake.dir, 'fake.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), appServer }));
  environment(t, { ...fake.env, HOME: p.parent, CODEX_HOME: path.join(p.parent, 'codex-home'), GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  fs.mkdirSync(path.join(p.parent, 'codex-home'), { recursive: true });
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); registerProject(controller.repo);
  controller.setDefaultModel({ vendor: 'codex' });
  const launches = kind => rows(fake.calls).filter(row => row.vendor === 'codex' && row.args[0] === kind);
  const asked = method => rows(path.join(fake.dir, 'appserver.jsonl')).filter(row => !method || row.method === method);
  const absorbed = () => rows(path.join(fake.dir, 'absorbed.jsonl'));
  const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop());
  return { ...p, fake, controller, repo: controller.repo, launches, asked, absorbed, conductor, home: path.join(p.parent, 'codex-home') };
}
async function until(check, message, timeout = 20000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const only = f => readTask(f.repo, '1');
const sessionOf = f => { try { return only(f); } catch { return null; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const THREAD = '12345678-1234-4234-8234-123456789abc';
const logRows = file => fs.readFileSync(file, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const lifecycle = (file, uuid) => logRows(file).filter(row => row.type === 'command_lifecycle' && row.command_uuid === uuid).map(row => row.state);
const request = (f, id) => pendingRequests(f.root).find(row => row.id === id);

test('a message sent while Codex works goes to that turn at its next step, and the chat keeps it once, in order', { timeout: 60000 }, async t => {
  const f = setup(t, { appServer: 'steer', mode: 'answer', steps: 15, stepMs: 200 });
  enqueue(f.root, 'Tidy the coupon module', { priority: 0, permissions: 'full' });
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
  // One run, on the app-server: one thread, one turn, and each message steered into that turn.
  assert.equal(f.launches('exec').length, 0, 'exec ran nothing');
  assert.deepEqual(f.asked().map(row => row.method).filter(name => !['config/read'].includes(name)), ['turn/steer', 'turn/steer', 'thread/start', 'turn/start', 'turn/steer', 'turn/steer']);
  const [start] = f.asked('thread/start'), [turn] = f.asked('turn/start');
  // Full access, as exec was started with it: its keys on the launch, and named on the thread.
  assert.ok(start.flags.includes('sandbox_mode="danger-full-access"') && start.flags.includes('approval_policy="never"') && start.flags.includes('web_search="live"'));
  assert.deepEqual([start.params.sandbox, start.params.approvalPolicy, start.params.cwd], ['danger-full-access', 'never', task.worktree]);
  assert.equal(turn.params.outputSchema.type, 'object', 'the reply is held to the same schema');
  assert.ok(turn.params.input[0].text.includes('Tidy the coupon module'));
  assert.deepEqual(f.absorbed().map(row => row.mid), [true, true]);
  assert.ok(f.absorbed().every(row => UUID.test(row.uuid)));
  const log = task.runs[0].logFile;
  for (const row of f.absorbed()) assert.deepEqual(lifecycle(log, row.uuid), ['queued', 'started', 'completed']);
  assert.ok(f.absorbed()[0].content.startsWith(DURING_LEAD), 'the turn is told what the message is');
  assert.ok(f.absorbed()[0].content.includes('"text":"Also keep the old name"'));
  // Its log reads as an exec --json log: the thread, the steps, the answer, the tokens.
  const written = logRows(log), kinds = written.map(row => row.type);
  assert.deepEqual(written[0], { type: 'thread.started', thread_id: THREAD });
  assert.ok(kinds.includes('turn.started') && kinds.at(-1) !== 'turn.failed');
  assert.deepEqual(written.find(row => row.type === 'item.started').item, { id: written.find(row => row.type === 'item.started').item.id, type: 'command_execution', command: "/bin/zsh -lc 'npm test'", aggregated_output: '', exit_code: null, status: 'in_progress' });
  assert.deepEqual(written.filter(row => row.type === 'item.completed' && row.item.type === 'command_execution').map(row => [row.item.aggregated_output, row.item.exit_code, row.item.status]).at(0), ['ok\n', 0, 'completed']);
  assert.deepEqual(written.find(row => row.item?.type === 'reasoning').item.text, 'Working on the requested change.');
  assert.deepEqual(written.find(row => row.type === 'turn.completed').usage, { input_tokens: 20, cached_input_tokens: 5, cache_write_input_tokens: 0, output_tokens: 12, reasoning_output_tokens: 2 });
  assert.equal(task.sessions.lead.id, THREAD);
  // In the chat each shows once, where it was sent, and the one reply answers all of it.
  assert.deepEqual(task.messages.map(row => [row.text, row.during === true]), [['Tidy the coupon module', false], ['Also keep the old name', true], ['And say which file changed', true]]);
  const entries = conversationEntries(f.repo, task);
  assert.deepEqual(entries.map(row => [row.role, row.during === true]), [['You', false], ['You', true], ['You', true], [entries.at(-1).role, false]]);
  assert.match(entries.at(-1).text, /Also took in what you sent while it worked: Also keep the old name \| And say which file changed$/);
  assert.equal(task.activeInbox, undefined, 'no turn takes messages now'); assert.equal(task.activeNowStops, undefined);
  // The next turn goes on in that thread, through the app-server again.
  enqueue(f.root, 'Thanks', { continuationTaskId: '1', priority: 0 });
  await until(() => f.asked('thread/resume').length === 1 && only(f).state === 'answered' && only(f).runs.length === 2, 'the next turn');
  assert.deepEqual([f.asked('thread/resume')[0].params.threadId, f.asked('thread/resume')[0].params.sandbox], [THREAD, 'danger-full-access']);
  assert.equal(f.launches('exec').length, 0);
});

test('a message sent while Codex runs a long command waits for the command and can be taken back; sent now, the command stops and the same run goes on with the message', { timeout: 60000 }, async t => {
  const f = setup(t, { appServer: 'steer', mode: 'answer', steps: 2, stepMs: 100, commandMs: 30000 });
  enqueue(f.root, 'Run the long check', { priority: 0, permissions: 'full' });
  await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeInbox === true, 'the turn works and takes messages');
  assert.equal(only(f).activeSendNow, true); assert.equal(only(f).activeNowStops, true, 'and sending one now stops its command');
  const first = enqueue(f.root, 'Never mind this one', { continuationTaskId: '1', priority: 0 });
  await until(() => request(f, first.id)?.turn, 'it is with the turn');
  await sleep(600);
  // The command has not ended: the message waits for it, and Codex has not been given it yet.
  assert.deepEqual([request(f, first.id).state, request(f, first.id).reason], ['queued', 'Waiting for the current command to finish.']);
  assert.equal(f.asked('turn/steer').filter(row => row.params.clientUserMessageId).length, 0);
  // ↑ takes it back: the turn never reads it.
  assert.ok(updateRequest(f.root, first.id, { cancel: new Date().toISOString() }, { from: ['queued'] }));
  await until(() => request(f, first.id)?.back === true, 'the turn gave it back');
  assert.equal(takeRequest(f.root, first.id).goal, 'Never mind this one');
  // Enter on the next one: the turn is interrupted, which stops its command, and the next turn of the same run starts with the message.
  const sent = enqueue(f.root, 'Also keep the old name', { continuationTaskId: '1', priority: 0 });
  await until(() => request(f, sent.id)?.turn, 'it is with the turn');
  const uuid = request(f, sent.id).turn.uuid, pressed = Date.now();
  assert.equal(workspace.sendTypedNow(f.root, '1'), 1);
  await until(() => (only(f).messages ?? []).some(row => row.during), 'the run took it');
  assert.deepEqual([request(f, sent.id).state, request(f, sent.id).reason], ['done', 'Sent to the running turn.']);
  await until(() => only(f).state !== 'running', 'the turn ends');
  assert.ok(Date.now() - pressed < 15000, 'long before the command would have ended');
  const task = only(f);
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  assert.deepEqual(f.asked().map(row => row.method).filter(name => ['thread/start', 'turn/start', 'turn/interrupt', 'thread/resume'].includes(name)), ['thread/start', 'turn/start', 'turn/interrupt', 'turn/start'], 'one thread, in one run');
  assert.equal(f.launches('exec').length, 0); assert.deepEqual(task.runs.map(run => run.code), [0]);
  assert.deepEqual(f.absorbed().map(row => [row.mid, row.content.includes('Also keep the old name')]), [[false, true]], 'the one taken back was never read');
  const log = task.runs[0].logFile;
  assert.deepEqual(lifecycle(log, uuid), ['started', 'completed']);
  assert.deepEqual(logRows(log).filter(row => ['turn.completed', 'turn.failed'].includes(row.type)).map(row => row.type), ['turn.completed'], 'the interrupted turn is not the end of the run');
  assert.deepEqual(task.messages.map(row => [row.text, row.during === true]), [['Run the long check', false], ['Also keep the old name', true]]);
  assert.match(conversationEntries(f.repo, task).at(-1).text, /Also took in what you sent while it worked: Also keep the old name$/);
});

test('a Codex whose app-server has no turn/steer runs exec as before, and a message waits for the turn to end', { timeout: 60000 }, async t => {
  for (const appServer of [undefined, 'threads']) {
    const f = setup(t, { appServer, mode: 'slow' });
    enqueue(f.root, 'Tidy the coupon module', { priority: 0, permissions: 'full' });
    await until(() => sessionOf(f)?.state === 'running' && f.launches('exec').length === 1, 'Codex works');
    const sent = enqueue(f.root, 'Also keep the old name', { continuationTaskId: '1', priority: 0 });
    await sleep(700);
    assert.equal(only(f).activeInbox, undefined, 'this turn takes no message');
    assert.deepEqual([request(f, sent.id).state, request(f, sent.id).turn], ['queued', undefined]);
    // The program was asked, and said it has no such method: nothing else went to its app-server.
    assert.deepEqual(f.asked().map(row => row.method), ['turn/steer']);
    assert.equal(f.launches('exec')[0].args.at(-1), '-', 'exec was started as it always was');
    f.conductor.stop();
  }
});

test('outside Full access a Codex with the owner\'s own config.toml or rules runs exec, which leaves them out; with neither, its turn takes messages', { timeout: 90000 }, async t => {
  for (const own of ['config', 'rules', null]) {
    const f = setup(t, { appServer: 'steer', mode: 'answer', steps: 6, stepMs: 150 });
    if (own === 'config') fs.writeFileSync(path.join(f.home, 'config.toml'), 'model = "owner-model"\n');
    if (own === 'rules') { fs.mkdirSync(path.join(f.home, 'rules')); fs.writeFileSync(path.join(f.home, 'rules', 'default.rules'), 'prefix_rule(pattern=["ls"], decision="allow")\n'); }
    enqueue(f.root, 'What does normalize do?', { priority: 0 });
    await until(() => sessionOf(f) && !['queued', 'preparing', 'running'].includes(sessionOf(f).state) || sessionOf(f)?.activeInbox === true, 'the turn');
    if (own) {
      await until(() => only(f).state === 'answered', 'the answer');
      assert.equal(f.launches('exec').length, 1, `${own}: exec ran the turn`);
      assert.ok(f.launches('exec')[0].args.includes('--ignore-user-config') && f.launches('exec')[0].args.includes('--ignore-rules'));
      assert.equal(f.asked('thread/start').length, 0, 'and no thread was started on the app-server');
    } else {
      const sent = enqueue(f.root, 'And where is it used?', { continuationTaskId: '1', priority: 0 });
      await until(() => only(f).state === 'answered', 'the answer');
      assert.equal(f.launches('exec').length, 0);
      assert.equal(request(f, sent.id).reason, 'Sent to the running turn.');
      const [start] = f.asked('thread/start');
      assert.deepEqual([start.params.sandbox, start.params.approvalPolicy], ['read-only', 'never'], 'Read only, as exec was started');
      assert.ok(start.flags.includes('mcp_servers={}') && start.flags.includes('features.shell_tool=false'));
    }
    f.conductor.stop();
  }
});

test('an exec launch is read for the app-server whole, and one with a flag it does not know stays with exec', () => {
  const launch = describe(['exec', 'resume', THREAD, '--ignore-user-config', '--ignore-rules', '--json', '--skip-git-repo-check', '--output-schema', '/x/schema.json', '-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"', '-c', 'mcp_servers={}', '--model', 'big-model', '-c', 'model_reasoning_effort="high"', '-']);
  assert.deepEqual(launch, { resume: THREAD, pairs: ['sandbox_mode="danger-full-access"', 'approval_policy="never"', 'mcp_servers={}', 'model_reasoning_effort="high"'], cwd: null, schemaFile: '/x/schema.json', model: 'big-model' });
  assert.deepEqual(serverArgs(launch), ['app-server', '--listen', 'stdio://', '-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"', '-c', 'mcp_servers={}', '-c', 'model_reasoning_effort="high"', '-c', 'model="big-model"']);
  assert.deepEqual(threadSettings(launch), { sandbox: 'danger-full-access', approvalPolicy: 'never', model: 'big-model' });
  const locked = describe(['exec', '--ignore-user-config', '--ignore-rules', '--json', '--sandbox', 'read-only', '--cd', '/work', '--output-schema', '/x/s.json', '-c', 'approval_policy="never"', '-']);
  assert.deepEqual([locked.cwd, threadSettings(locked)], ['/work', { sandbox: 'read-only', approvalPolicy: 'never' }]);
  assert.equal(describe(['exec', '--full-auto', '-']), null); assert.equal(describe(['review']), null);
  // The answers of the real program (0.167.0) to a method it lacks, and to one it has but refuses.
  assert.equal(noMethod({ code: -32600, message: 'Invalid request: unknown variant `turn/steer`, expected one of `initialize`' }), true);
  assert.equal(noMethod({ code: -32600, message: 'no active turn to steer' }), false);
  assert.equal(noMethod({ code: -32601, message: 'Method not found' }), true);
});

test('each kind of step the app-server reports is written as exec --json writes it', () => {
  assert.deepEqual(execItem({ type: 'commandExecution', id: 'c1', command: 'ls', cwd: '/w', aggregatedOutput: 'a\n', exitCode: 0, status: 'completed' }), { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'a\n', exit_code: 0, status: 'completed' });
  assert.equal(execItem({ type: 'commandExecution', id: 'c2', command: 'rm x', status: 'declined' }).status, 'declined');
  assert.deepEqual(execItem({ type: 'fileChange', id: 'f1', changes: [{ path: '/w/a.txt', kind: { type: 'update', move_path: null }, diff: '@@' }], status: 'completed' }), { id: 'f1', type: 'file_change', changes: [{ path: '/w/a.txt', kind: 'update' }], status: 'completed' });
  assert.deepEqual(execItem({ type: 'reasoning', id: 'r1', summary: ['**Reading**', 'Then this.'], content: [] }), { id: 'r1', type: 'reasoning', text: '**Reading**\n\nThen this.' });
  assert.equal(execItem({ type: 'reasoning', id: 'r2', summary: [], content: [] }), null, 'a thought with no words has no line');
  assert.deepEqual(execItem({ type: 'agentMessage', id: 'a1', text: '{"outcome":"done"}' }), { id: 'a1', type: 'agent_message', text: '{"outcome":"done"}' });
  assert.equal(execItem({ type: 'mcpToolCall', id: 'm1', server: 's', tool: 't', status: 'inProgress' }).type, 'mcp_tool_call');
  assert.equal(execItem({ type: 'userMessage', id: 'u1' }), null);
});

test('the bridge started with a Codex that cannot take a message prints exactly what exec prints', { timeout: 30000 }, async t => {
  const f = setup(t, { mode: 'answer' });
  f.conductor.stop();
  const bin = path.join(f.fake.dir, 'codex'), schema = path.join(f.parent, 'schema.json'); fs.writeFileSync(schema, JSON.stringify({ type: 'object', properties: {} }));
  const exec = ['exec', '--ignore-user-config', '--ignore-rules', '--json', '--skip-git-repo-check', '--cd', f.root, '--output-schema', schema, '-c', 'sandbox_mode="danger-full-access"', '-'];
  assert.equal(await steers(bin, { cwd: f.root }), false, 'the program says it has no turn/steer');
  const run = (command, args, input) => new Promise(resolve => { const child = spawn(command, args, { cwd: f.root, stdio: ['pipe', 'pipe', 'inherit'] }); let out = ''; child.stdout.on('data', chunk => { out += chunk; }); child.once('close', code => resolve({ code, out })); child.stdin.end(input); });
  const plain = await run(bin, exec, 'Say hello');
  const live = liveLaunch(bin, exec, { isolated: false });
  const through = await run(live.bin, live.args, `${JSON.stringify({ type: 'user', session_id: '', message: { role: 'user', content: 'Say hello' }, parent_tool_use_id: null })}\n`);
  assert.equal(through.code, 0); assert.equal(through.out, plain.out);
  assert.equal(rows(path.join(f.parent, 'inputs.jsonl')).at(-1).input, 'Say hello', 'and exec read the prompt as it was');
});
