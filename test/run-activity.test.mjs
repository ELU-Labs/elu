import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSteps, runsOfEntries, runSeconds } from '../lib/run-activity.mjs';
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
