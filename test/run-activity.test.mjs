import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSteps, endedSteps, runsOfEntries, runSeconds } from '../lib/run-activity.mjs';
import { stepLines, stepsLine, STEPS_LINE, workedFor } from '../lib/terminal-visuals.mjs';
import { temp } from './helpers.mjs';

// The owner asked why he sees nothing of what the model thinks and does while it works.
// Each vendor writes its work to the run's log in its own shape; these are those shapes, as
// the vendors' docs and streams lay them out, and what the chat makes of them.
const write = (file, rows) => fs.writeFileSync(file, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
const plain = steps => steps.map(step => step.kind === 'plan' ? ['plan', step.entries.map(entry => `${entry.state} ${entry.text}`)] : [step.kind, step.text, ...(step.status ? [step.status] : []), ...(step.note ? [step.note] : [])]);

test('Claude Code: thoughts, each tool call and how it ended, the text on the way and the plan; never the reply', t => {
  const dir = temp(t), cwd = path.join(dir, 'repo'), file = path.join(dir, 'lead.log');
  const say = (content, parent = null) => ({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [content] }, parent_tool_use_id: parent, session_id: 's' });
  const result = (id, error = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'out', ...(error ? { is_error: true } : {}) }] } });
  write(file, [{ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }, { type: 'rate_limit_event' },
    // Thinking that Claude Code sent without its text (display omitted) is no step.
    say({ type: 'thinking', thinking: '', signature: 'x' }), say({ type: 'thinking', thinking: 'The codes should compare in upper case.', signature: 'x' }),
    say({ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: path.join(cwd, 'src', 'coupon.mjs') } }), result('t1'),
    say({ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test\necho done', description: 'Run tests' } }), result('t2', true),
    say({ type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'normalize', path: path.join(cwd, 'src') } }),
    say({ type: 'tool_use', id: 't4', name: 'TodoWrite', input: { todos: [{ content: 'Change normalize', status: 'completed' }, { content: 'Run the tests', status: 'in_progress' }, { content: 'Report', status: 'pending' }] } }), result('t4'),
    say({ type: 'tool_use', id: 't5', name: 'Agent', input: { description: 'Check the callers', prompt: 'Look' } }), say({ type: 'tool_use', id: 't6', name: 'Read', input: { file_path: '/etc/hosts' } }, 't5'), result('t6'), result('t5'),
    say({ type: 'tool_use', id: 't7', name: 'mcp__linear__get_issue', input: { id: 'ELU-1' } }), result('t7'),
    say({ type: 'text', text: 'The test fails on lower case codes. Fixing normalize.' }),
    say({ type: 'tool_use', id: 'reply', name: 'StructuredOutput', input: { outcome: 'done', summary: 'Fixed.' } }), result('reply'),
    { type: 'result', structured_output: { outcome: 'done', summary: 'Fixed.' } }]);
  const steps = runSteps(file, { cwd });
  assert.deepEqual(plain(steps), [
    ['thinking', 'The codes should compare in upper case.'], ['tool', 'Read: src/coupon.mjs', 'ok'], ['tool', 'Run: npm test …', 'failed'], ['tool', 'Search: normalize in src', 'running'],
    ['plan', ['done Change normalize', 'doing Run the tests', 'todo Report']], ['tool', 'Agent: Check the callers', 'ok'], ['tool', 'Read: /etc/hosts', 'ok'], ['tool', 'linear get_issue: ELU-1', 'ok'],
    ['text', 'The test fails on lower case codes. Fixing normalize.']]);
  assert.equal(steps[6].sub, true, "a helper agent's step is marked as its own");
  assert.ok(Object.isFrozen(steps) && steps.every(Object.isFrozen));
});

test('Codex: reasoning, commands as they start and end, prose on the way and edits; the JSON reply is not a step', t => {
  const dir = temp(t), cwd = path.join(dir, 'repo'), file = path.join(dir, 'lead.log');
  const command = (type, status, extra = {}) => ({ type, item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'npm test -- --grep '\\''case'\\'''", aggregated_output: '', exit_code: null, status, ...extra } });
  write(file, [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Reading the module**\n\nThe codes should compare in upper case.' } }, command('item.started', 'in_progress')]);
  assert.deepEqual(plain(runSteps(file, { cwd })), [['thinking', '**Reading the module**\n\nThe codes should compare in upper case.'], ['tool', "Run: npm test -- --grep 'case'", 'running']], 'a command shows while it runs');
  fs.appendFileSync(file, [command('item.completed', 'failed', { exit_code: 1, aggregated_output: 'not ok' }),
    { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'The test fails. Fixing normalize.' } },
    { type: 'item.completed', item: { id: 'item_3', type: 'file_change', changes: [{ path: path.join(cwd, 'src', 'coupon.mjs'), kind: 'update' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_4', type: 'command_execution', command: 'rm -rf build', aggregated_output: '', exit_code: null, status: 'declined' } },
    { type: 'item.updated', item: { id: 'item_5', type: 'todo_list', items: [{ text: 'Fix', completed: true }, { text: 'Test', completed: false }] } },
    { type: 'item.completed', item: { id: 'item_6', type: 'web_search', query: 'coupon casing' } },
    { type: 'item.completed', item: { id: 'item_7', type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: { query: 'coupons' }, status: 'failed', error: { message: 'x' } } },
    { type: 'item.completed', item: { id: 'item_8', type: 'agent_message', text: JSON.stringify({ outcome: 'done', summary: 'Fixed.' }) } },
    { type: 'turn.completed', usage: {} }].map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.deepEqual(plain(runSteps(file, { cwd })), [['thinking', '**Reading the module**\n\nThe codes should compare in upper case.'], ['tool', "Run: npm test -- --grep 'case'", 'failed', 'exit 1'], ['text', 'The test fails. Fixing normalize.'],
    ['tool', 'Edit: src/coupon.mjs', 'ok'], ['tool', 'Run: rm -rf build', 'failed', 'declined'], ['plan', ['done Fix', 'todo Test']], ['tool', 'Search the web: coupon casing', 'ok'], ['tool', 'docs search: coupons', 'failed']]);
});

test('Grok Build streaming-json: thoughts in pieces are one step, tool calls end as reported, and the reply is cut from the text even while it arrives', t => {
  const dir = temp(t), file = path.join(dir, 'lead.log');
  write(file, [{ type: 'thought', data: 'Looking at ' }, { type: 'thought', data: 'the tests.' }, { type: 'text', data: 'Let me read the module. ' },
    { type: 'tool_call', toolCallId: 'call_1', title: 'Read', kind: 'read', status: 'in_progress', toolName: 'read_file', rawInput: { path: 'src/main.rs' }, content: [], locations: [] },
    { type: 'tool_call_update', toolCallId: 'call_1', status: 'completed', content: [], rawOutput: {}, locations: [] },
    { type: 'tool_call', toolCallId: 'call_2', title: 'Run npm test', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm test' } },
    { type: 'plan', entries: [{ content: 'Read', status: 'completed' }, { content: 'Fix', status: 'in_progress' }] },
    { type: 'text', data: 'Done. ' }, { type: 'text', data: '{"outcome":"do' }]);
  assert.deepEqual(plain(runSteps(file)), [['thinking', 'Looking at the tests.'], ['text', 'Let me read the module.'], ['tool', 'Read: src/main.rs', 'ok'], ['tool', 'Run npm test', 'running'], ['plan', ['done Read', 'doing Fix']], ['text', 'Done.']]);
  fs.appendFileSync(file, [{ type: 'tool_call_update', toolCallId: 'call_2', status: 'failed' }, { type: 'text', data: 'ne","summary":"x"}' }, { type: 'end', stopReason: 'end_turn', sessionId: 's' }].map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.deepEqual(plain(runSteps(file)).slice(3), [['tool', 'Run npm test', 'failed'], ['plan', ['done Read', 'doing Fix']], ['text', 'Done.']]);
  // A fenced reply, and a reply alone, leave nothing.
  const fenced = path.join(dir, 'fenced.log'); write(fenced, [{ type: 'text', data: 'Here:\n```json\n{"outcome":"done"}\n```' }]);
  assert.deepEqual(plain(runSteps(fenced)), [['text', 'Here:']]);
  const bare = path.join(dir, 'bare.log'); write(bare, [{ type: 'text', data: '{"outcome":"done"}' }]);
  assert.deepEqual(runSteps(bare), []);
});

test('ACP (Grok Build and Antigravity in Ask and Auto): thought and message chunks, tool calls and the permission asked for one', t => {
  const dir = temp(t), file = path.join(dir, 'lead.log');
  const update = change => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: change } });
  write(file, [{ jsonrpc: '2.0', id: 0, result: { protocolVersion: 1 } }, update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reading the request.' } }),
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working on it.\n' } }),
    update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Write /tmp/x.txt', kind: 'edit', status: 'pending', rawInput: { path: '/tmp/x.txt' } }),
    { jsonrpc: '2.0', id: 100, method: 'session/request_permission', params: { sessionId: 's', toolCall: { toolCallId: 'c1', title: 'Write /tmp/x.txt' }, options: [] } },
    { jsonrpc: '2.0', id: 101, method: 'session/request_permission', params: { sessionId: 's', toolCall: { toolCallId: 'c9', title: 'Run make' }, options: [] } },
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed' }),
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Here is the result:\n{\n  "outcome": "done"\n}\n' } })]);
  assert.deepEqual(plain(runSteps(file)), [['thinking', 'Reading the request.'], ['text', 'Working on it.'], ['tool', 'Write /tmp/x.txt', 'failed'], ['tool', 'Run make', 'running'], ['text', 'Here is the result:']]);
});

test('a log is read from where the last read stopped: half a line waits, an unchanged log gives the same steps, a new file starts over', t => {
  const dir = temp(t), file = path.join(dir, 'lead.log');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'thought', data: 'One.' })}\n${JSON.stringify({ type: 'text', data: 'Two' }).slice(0, 12)}`);
  const first = runSteps(file);
  assert.deepEqual(plain(first), [['thinking', 'One.']]);
  assert.equal(runSteps(file), first, 'nothing new: the same list');
  fs.appendFileSync(file, `${JSON.stringify({ type: 'text', data: 'Two' }).slice(12)}\nnot json\n`);
  assert.deepEqual(plain(runSteps(file)), [['thinking', 'One.'], ['text', 'Two']]);
  fs.rmSync(file); write(file, [{ type: 'thought', data: 'Again.' }]);
  assert.deepEqual(plain(runSteps(file)), [['thinking', 'Again.']]);
  assert.deepEqual(runSteps(path.join(dir, 'missing.log')), []);
  fs.symlinkSync(file, path.join(dir, 'link.log')); assert.deepEqual(runSteps(path.join(dir, 'link.log')), [], 'never through a link');
});

test("each reply owns the runs that wrote it: a retry joins it, an earlier failed turn does not, a bot's runs go to the bot", () => {
  const at = minute => new Date(Date.UTC(2026, 10, 13, 10, minute)).toISOString();
  const run = (role, start, end) => ({ role, startedAt: at(start), at: at(end) });
  const failed = run('lead', 1, 2), first = run('lead', 4, 5), second = run('lead', 5, 7), bot = run('bot:sec', 9, 10), stray = run('lead', 12, 13);
  const asked = { role: 'You', at: at(3), text: 'Fix it' }, reply = { role: 'Opus', lead: true, at: at(7), text: 'Fixed.' };
  const toBot = { role: 'You → @sec', to: 'sec', at: at(8), text: 'Check it' }, said = { role: '@sec', bot: 'sec', at: at(10), text: 'Looks fine.' }, loop = { role: 'Opus', lead: true, loop: true, at: at(11), text: 'Fixed 2' };
  const { owned, left } = runsOfEntries([asked, reply, toBot, said, loop], [failed, first, second, bot, stray]);
  assert.deepEqual(owned.get(reply), [first, second]); assert.deepEqual(owned.get(said), [bot]); assert.equal(owned.has(loop), false); assert.equal(owned.has(asked), false);
  assert.deepEqual(left, [failed, stray]);
  assert.equal(runSeconds([first, second]), 180); assert.equal(runSeconds([{ at: at(5) }]), null, 'a run from before its start was kept');
});

test('steps draw one under another, wrapped under their first word, and fold into one line', () => {
  const steps = [{ kind: 'thinking', text: 'The codes should compare in upper case, so normalize must change.' }, { kind: 'tool', text: 'Run: npm test', status: 'failed', note: 'exit 1' }, { kind: 'tool', text: 'Read: src/coupon.mjs', status: 'ok' },
    { kind: 'tool', text: 'Edit: src/coupon.mjs', status: 'running', sub: true }, { kind: 'plan', text: '', entries: [{ text: 'Fix', state: 'done' }, { text: 'Test', state: 'doing' }] }, { kind: 'text', text: 'Fixing normalize.' }];
  assert.equal(stepLines(steps, { width: 40, colour: false }), ['✻ The codes should compare in upper', '  case, so normalize must change.', '✗ Run: npm test · exit 1', '✓ Read: src/coupon.mjs', '  ● Edit: src/coupon.mjs', '• Plan', '  ✓ Fix', '  ● Test', '• Fixing normalize.'].join('\n'));
  assert.equal(stepLines([{ kind: 'thinking', text: '**Reading the module**\n\nThe codes should compare in upper case.' }], { width: 80, colour: false }), '✻ Reading the module\n  The codes should compare in upper case.', 'a heading without its stars, no empty line');
  assert.equal(stepsLine(12, 72, false, false), '▸ 12 steps in 1m 12s · ctrl+o shows them');
  assert.equal(stepsLine(1, null, true, false), '▾ 1 step · ctrl+o hides it');
  assert.ok(STEPS_LINE.test('▸ 1 step · ctrl+o shows it') && !STEPS_LINE.test('┃ ▸ 1 step in 3s'));
  assert.deepEqual([workedFor(42), workedFor(185), workedFor(3840), workedFor(null)], ['42s', '3m 5s', '1h 4m', null]);
});

// What real Claude Code 2.1.322 writes in a long turn, and the first builder's reader took none
// of: the owner saw "Opus 5.5 is working / model: started" for ten minutes with nothing else.
// The rows are in the shapes of real logs, with made-up content. A log carries no times, so a
// row's time is the log's last write when it was read: each part below is written at its time.
const SESSION = '0e2f1a54-7c3b-4d19-9a6e-5b8c2d7f4a10', ID = () => '4f1c2b7e-9d3a-4e58-8b61-0a7c5d2e9f34';
const TEST = 'toolu_01Qm7RtYpL2nXv8KcWd4HsZb', WATCH = 'toolu_01Bn5VgTjM9rPx3LqWz6KdYc';
const real = {
  tokens: (total, delta) => ({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: total, estimated_tokens_delta: delta, session_id: SESSION, uuid: ID() }),
  say: content => ({ type: 'assistant', message: { id: 'msg_01', role: 'assistant', content: [content] }, parent_tool_use_id: null, session_id: SESSION, uuid: ID() }),
  result: (id, content = 'ok') => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, parent_tool_use_id: null, session_id: SESSION, uuid: ID() }),
  beat: (id, n) => ({ type: 'tool_progress', tool_use_id: `${id}-heartbeat-${n}`, tool_name: 'Bash', parent_tool_use_id: id, elapsed_time_seconds: (n + 1) * 30, heartbeat: true, session_id: SESSION, uuid: ID() }),
  started: (task, id, description, background = false) => ({ type: 'system', subtype: 'task_started', task_id: task, run_id: `0${task}-85fcba98`, tool_use_id: id, description, is_backgrounded: background, task_type: 'local_bash', uuid: ID(), session_id: SESSION }),
  notified: (task, id, summary, status = 'completed') => ({ type: 'system', subtype: 'task_notification', task_id: task, run_id: `0${task}-85fcba98`, tool_use_id: id, status, output_file: '', summary, uuid: ID(), session_id: SESSION }),
  background: tasks => ({ type: 'system', subtype: 'background_tasks_changed', tasks: tasks.map(([task, description]) => ({ task_id: task, run_id: `0${task}-85fcba98`, task_type: 'local_bash', description })), uuid: ID(), session_id: SESSION }),
  updated: (task, status) => ({ type: 'system', subtype: 'task_updated', task_id: task, run_id: `0${task}-85fcba98`, patch: { status, end_time: 1794504985020 }, uuid: ID(), session_id: SESSION }),
};
// Adds rows to a log as written at that time (ms).
const writeAt = (file, at, rows) => { fs.appendFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); fs.utimesSync(file, at / 1000, at / 1000); };
const drawn = (steps, now) => stepLines(steps, { width: 100, colour: false, now }).split('\n');

test('Claude Code sends a thought with no text: its tokens count up live, and its text takes their place when it comes', t => {
  const dir = temp(t), file = path.join(dir, 'lead.log'), T = Date.now() - 3600000;
  writeAt(file, T, [{ type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-opus-5-5', claude_code_version: '2.1.322' }, real.tokens(50, 50), real.tokens(209, 159)]);
  assert.deepEqual(runSteps(file), [{ kind: 'thinking', text: '', tokens: 209, live: true }]);
  assert.deepEqual(drawn(runSteps(file), T), ['✻ thinking · 209 tokens']);
  writeAt(file, T + 2000, [real.tokens(1240, 1031)]);
  assert.deepEqual(drawn(runSteps(file), T), ['✻ thinking · 1.2k tokens'], 'it counts up');
  // The thought's own block, as every one of 40 real logs had it: no text, only a signature.
  writeAt(file, T + 3000, [real.say({ type: 'thinking', thinking: '', signature: 'EuYBCkYIBxgCKkD' }), real.say({ type: 'text', text: 'Running the tests.' })]);
  assert.deepEqual(drawn(runSteps(file), T), ['✻ thought · 1.2k tokens', '• Running the tests.'], 'the thought is over, and its count stays');
  // The next thought counts from its own start.
  writeAt(file, T + 4000, [real.tokens(50, 50), real.tokens(130, 80)]);
  assert.deepEqual(drawn(runSteps(file), T).slice(-1), ['✻ thinking · 130 tokens']);
  // With its text (a release and model that send it), the text is the step.
  writeAt(file, T + 5000, [real.say({ type: 'thinking', thinking: 'The codes should compare in upper case.', signature: 'EuYBCkYIBxgCKkD' })]);
  assert.deepEqual(runSteps(file).at(-1), { kind: 'thinking', text: 'The codes should compare in upper case.' });
  assert.deepEqual(drawn(runSteps(file), T), ['✻ thought · 1.2k tokens', '• Running the tests.', '✻ The codes should compare in upper case.']);
  assert.deepEqual(drawn([{ kind: 'thinking', text: '', tokens: 999, live: true }, { kind: 'thinking', text: '', tokens: 123456 }], T), ['✻ thinking · 999 tokens', '✻ thought · 123k tokens']);
});

test('a command that prints nothing says how long it has run, second by second and between heartbeats, and keeps its total when it ends', t => {
  const dir = temp(t), file = path.join(dir, 'lead.log'), T = Date.now() - 3600000, minute = 60000;
  writeAt(file, T, [real.say({ type: 'tool_use', id: TEST, name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }), real.started('bumf0lxl0', TEST, 'npm test')]);
  assert.deepEqual(runSteps(file), [{ kind: 'tool', text: 'Run: npm test', status: 'running', since: T }], 'timed from the call');
  assert.deepEqual(drawn(runSteps(file), T + 1000), ['● Run: npm test'], 'not in its first second');
  assert.deepEqual(drawn(runSteps(file), T + 7000), ['● Run: npm test · 7s']);
  assert.deepEqual(drawn(runSteps(file), T + 29000), ['● Run: npm test · 29s'], 'before any heartbeat');
  // A heartbeat every half minute, each written when it says.
  for (let n = 0; n < 4; n++) writeAt(file, T + (n + 1) * 30000, [real.beat(TEST, n)]);
  const running = runSteps(file);
  assert.equal(running[0].since, T, 'the heartbeats agree with the start');
  assert.deepEqual(drawn(running, T + 2 * minute + 10000), ['● Run: npm test · 2m 10s'], 'between two heartbeats');
  assert.deepEqual(drawn(running, T + 2 * minute + 11000), ['● Run: npm test · 2m 11s'], 'a second later');
  assert.equal(runSteps(file), running, 'nothing new in the log: the same steps, so only the clock moves the line');
  writeAt(file, T + 3 * minute + 10000, [real.notified('bumf0lxl0', TEST, 'npm test'), real.result(TEST, 'ok 1 - normalizes coupons')]);
  assert.deepEqual(runSteps(file), [{ kind: 'tool', text: 'Run: npm test', status: 'ok', seconds: 190 }]);
  assert.deepEqual(drawn(runSteps(file), T + 60 * minute), ['✓ Run: npm test · 3m 10s'], 'its total stays');
});

test('a log first read while its command runs takes the start from the last heartbeat; a call that failed keeps its note and its time', t => {
  const dir = temp(t), file = path.join(dir, 'lead.log'), T = Date.now() - 3600000;
  // The app was opened ten minutes into the command: every row is read at once.
  writeAt(file, T, [real.say({ type: 'tool_use', id: TEST, name: 'Bash', input: { command: "timeout 590 bash -c 'tail -n 0 -f build.log | grep -m1 done'" } }), real.started('bfejhqp0c', TEST, "timeout 590 bash -c 'tail -n 0 -f build.log | grep -m1 done'"), ...Array.from({ length: 19 }, (_, n) => real.beat(TEST, n))]);
  assert.equal(runSteps(file)[0].since, T - 570000, 'it had run 570 seconds when the last heartbeat was written');
  assert.deepEqual(drawn(runSteps(file), T + 12000), ["● Run: timeout 590 bash -c 'tail -n 0 -f build.log | grep -m1 done' · 9m 42s"]);
  // A heartbeat for a call the log never showed, or one that already ended, changes nothing.
  writeAt(file, T + 20000, [real.beat('toolu_01NeverSeen00000000000000', 0), { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: TEST, content: 'Exit code 124', is_error: true }] }, parent_tool_use_id: null, session_id: SESSION, uuid: ID() }, real.beat(TEST, 19)]);
  assert.deepEqual(runSteps(file), [{ kind: 'tool', text: "Run: timeout 590 bash -c 'tail -n 0 -f build.log | grep -m1 done'", status: 'failed', seconds: 590 }]);
  assert.deepEqual(drawn(runSteps(file), T + 30000), ["✗ Run: timeout 590 bash -c 'tail -n 0 -f build.log | grep -m1 done' · 9m 50s"]);
  // Codex: a command is timed from the item that started it to the item that ended it.
  const codex = path.join(dir, 'codex.log'), item = (type, status, extra = {}) => ({ type, item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'npm test'", aggregated_output: '', exit_code: null, status, ...extra } });
  writeAt(codex, T, [{ type: 'thread.started', thread_id: SESSION }, { type: 'turn.started' }, item('item.started', 'in_progress')]);
  assert.deepEqual(drawn(runSteps(codex), T + 65000), ['● Run: npm test · 1m 5s']);
  writeAt(codex, T + 80000, [item('item.completed', 'failed', { exit_code: 1 })]);
  assert.deepEqual(drawn(runSteps(codex), T + 900000), ['✗ Run: npm test · exit 1 · 1m 20s']);
});

// Seen in the real app, on the owner's other computer: the session was opened there a while
// into its turn, so its log was read all at once, and the background command said 15s beside
// a command of 45s that started after it.
test('a log read late: what started before a command started no later than that command\'s heartbeat says it did', t => {
  const dir = temp(t), file = path.join(dir, 'lead.log'), T = Date.now() - 3600000;
  writeAt(file, T, [real.say({ type: 'tool_use', id: WATCH, name: 'Bash', input: { command: 'npm run watch', run_in_background: true } }), real.started('bd27w0ond', WATCH, 'npm run watch', true), real.result(WATCH, 'Command running in background with ID: bd27w0ond'), real.background([['bd27w0ond', 'npm run watch']]),
    real.say({ type: 'tool_use', id: 'toolu_01Hx3LmPq8RsTv2WyZa5BcDe', name: 'Read', input: { file_path: '/srv/shop/src/coupon.mjs' } }), real.say({ type: 'tool_use', id: TEST, name: 'Bash', input: { command: 'npm test' } }), real.started('bumf0lxl0', TEST, 'npm test'), real.beat(TEST, 0)]);
  assert.deepEqual(runSteps(file).map(({ kind, text, since }) => [kind, text, since]), [['tool', 'Run: npm run watch', undefined], ['tool', 'Read: /srv/shop/src/coupon.mjs', T - 30000], ['tool', 'Run: npm test', T - 30000], ['background', 'npm run watch', T - 30000]]);
  assert.deepEqual(drawn(runSteps(file), T + 15000).slice(-2), ['● Run: npm test · 45s', '● 1 background command: npm run watch · 45s']);
  // What starts after it is timed from its own row.
  writeAt(file, T + 20000, [real.say({ type: 'tool_use', id: 'toolu_01Kp9NvRt4UwXy7ZaBc2DeFg', name: 'Bash', input: { command: 'npm run lint', run_in_background: true } }), real.started('bq4t7m2ks', 'toolu_01Kp9NvRt4UwXy7ZaBc2DeFg', 'npm run lint', true)]);
  assert.equal(runSteps(file).at(-2).since, T + 20000);
  assert.equal(runSteps(file).at(-1).since, T - 30000, 'the line counts from its oldest command');
});

test('the commands a turn has running in the background are one line, with how long, until they end', t => {
  const dir = temp(t), file = path.join(dir, 'lead.log'), T = Date.now() - 3600000, minute = 60000;
  writeAt(file, T, [real.say({ type: 'tool_use', id: WATCH, name: 'Bash', input: { command: 'while true; do gh run list -L 1; sleep 60; done', description: 'Watch the build', run_in_background: true } }),
    real.started('bd27w0ond', WATCH, 'while true; do gh run list -L 1; sleep 60; done', true), real.result(WATCH, 'Command running in background with ID: bd27w0ond'),
    real.background([['bd27w0ond', 'while true; do gh run list -L 1; sleep 60; done']])]);
  assert.deepEqual(runSteps(file), [{ kind: 'tool', text: 'Run: while true; do gh run list -L 1; sleep 60; done', status: 'ok', seconds: 0 }, { kind: 'background', text: 'while true; do gh run list -L 1; sleep 60; done', count: 1, since: T }]);
  assert.deepEqual(drawn(runSteps(file), T + 4 * minute), ['✓ Run: while true; do gh run list -L 1; sleep 60; done', '● 1 background command: while true; do gh run list -L 1; sleep 60; done · 4m 0s'], 'a turn that waits on its own loop says so');
  // The turn goes on: the line stays last. A second command joins it, counted from the oldest.
  writeAt(file, T + minute, [real.tokens(50, 50), real.say({ type: 'thinking', thinking: '', signature: 'EuYBCkYIBxgCKkD' }), real.say({ type: 'tool_use', id: TEST, name: 'Bash', input: { command: 'npm run dev' } }), real.started('bx81kq0zt', TEST, 'npm run dev'),
    real.background([['bd27w0ond', 'while true; do gh run list -L 1; sleep 60; done'], ['bx81kq0zt', 'npm run dev']])]);
  assert.deepEqual(drawn(runSteps(file), T + 5 * minute).slice(-2), ['● Run: npm run dev · 4m 0s', '● 2 background commands: while true; do gh run list -L 1; sleep 60; done, npm run dev · 5m 0s']);
  // One fails, as task_updated says; the other is gone from the next list.
  writeAt(file, T + 6 * minute, [real.updated('bd27w0ond', 'failed')]);
  assert.deepEqual(drawn(runSteps(file), T + 7 * minute).slice(-1), ['● 1 background command: npm run dev · 6m 0s']);
  writeAt(file, T + 8 * minute, [real.background([])]);
  assert.equal(runSteps(file).some(step => step.kind === 'background'), false);
  // A command that ended in the foreground was never one: task_started alone adds no line.
  const plain = path.join(dir, 'plain.log');
  writeAt(plain, T, [real.say({ type: 'tool_use', id: TEST, name: 'Bash', input: { command: 'npm test' } }), real.started('bumf0lxl0', TEST, 'npm test'), real.notified('bumf0lxl0', TEST, 'npm test'), real.result(TEST)]);
  assert.deepEqual(runSteps(plain).map(step => step.kind), ['tool']);
  // A task_notification ends a background command too.
  const noted = path.join(dir, 'noted.log');
  writeAt(noted, T, [real.started('bd27w0ond', WATCH, 'npm run watch', true), real.notified('bd27w0ond', WATCH, 'npm run watch', 'killed')]);
  assert.deepEqual(runSteps(noted), []);
});

test('a run that ended leaves no call running: it was stopped there, a thought it counted is over, and its background commands are gone', () => {
  const since = Date.UTC(2026, 10, 13, 10, 0, 0), steps = Object.freeze([{ kind: 'thinking', text: '', tokens: 1240, live: true }, { kind: 'tool', text: 'Read: src/coupon.mjs', status: 'ok' }, { kind: 'tool', text: 'Run: sleep 600', status: 'running', since }, { kind: 'background', text: 'npm run watch', count: 1, since }].map(Object.freeze));
  const ended = endedSteps(steps, since + 130000);
  assert.deepEqual(ended, [{ kind: 'thinking', text: '', tokens: 1240 }, { kind: 'tool', text: 'Read: src/coupon.mjs', status: 'ok' }, { kind: 'tool', text: 'Run: sleep 600', status: 'stopped', seconds: 130 }]);
  assert.equal(endedSteps(steps, since + 130000), ended, 'the same list each time it is drawn');
  assert.deepEqual(drawn(ended, since + 999999), ['✻ thought · 1.2k tokens', '✓ Read: src/coupon.mjs', '■ Run: sleep 600 · stopped after 2m 10s']);
  assert.deepEqual(drawn(endedSteps(steps, NaN), since), ['✻ thought · 1.2k tokens', '✓ Read: src/coupon.mjs', '■ Run: sleep 600 · stopped'], 'an end with no time');
  const done = Object.freeze([Object.freeze({ kind: 'tool', text: 'Read: a', status: 'ok' })]);
  assert.equal(endedSteps(done, since), done, 'nothing to end');
  assert.equal(stepsLine(5, 130, false, false, { stopped: true }), '▸ 5 steps in 2m 10s · stopped · ctrl+o shows them');
  assert.ok(STEPS_LINE.test(stepsLine(1, null, true, false, { stopped: true })));
});

test('a turn that ended with no reply stays where it happened: before the message that came next, or after the last', () => {
  const at = minute => new Date(Date.UTC(2026, 10, 13, 10, minute)).toISOString(), run = (role, start, end, extra = {}) => ({ role, startedAt: at(start), at: at(end), ...extra });
  const old = run('lead', 0, 1), stopped = run('lead', 4, 6, { stopped: true }), answer = run('lead', 8, 9), last = run('lead', 11, 12, { stopped: true });
  const first = { role: 'You', at: at(3), text: 'Run the tests' }, next = { role: 'You', at: at(7), text: 'Carry on' }, reply = { role: 'Opus', lead: true, at: at(9), text: 'They pass.' }, again = { role: 'You', at: at(10), text: 'Once more' };
  const { owned, before, after, left } = runsOfEntries([first, next, reply, again], [old, stopped, answer, last]);
  assert.deepEqual(owned.get(reply), [answer]);
  assert.deepEqual([...before], [[next, [stopped]]], 'the stopped turn sits before the message that came after it');
  assert.deepEqual(after, [last], 'the newest one, after everything');
  assert.deepEqual(left, [old, stopped, last]);
  assert.deepEqual(runsOfEntries([], [stopped]).after, [stopped]);
  // Ended in the very millisecond of the first message: not older than it.
  assert.deepEqual(runsOfEntries([first], [run('lead', 2, 3, { stopped: true })]).after.length, 1);
  assert.deepEqual(runsOfEntries([first], [run('lead', 1, 2, { stopped: true })]).after, []);
});
