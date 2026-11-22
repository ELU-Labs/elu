import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { peerHome } from './peer-helpers.mjs';
import { temp } from './helpers.mjs';
import { saveBot } from '../lib/bots.mjs';
import { agentThread, AGENT_KINDS, AGENT_STATES, sessionAgents, SUMMARY_MAX } from '../lib/session-agents.mjs';

// The Agents tab's rows and threads (lib/session-agents.mjs), read from a session's records and
// the logs its runs and jobs wrote, as each vendor writes them. Nothing here starts a model.

const THREAD = '019a0000-0000-7000-8000-0000000000aa';
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
function write(file, rows, { at = null } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof rows === 'string' ? rows : lines(rows));
  if (at) fs.utimesSync(file, new Date(at), new Date(at));
  return file;
}
// A Claude Code row of the turn's own (parent null) or of the sub-agent a call started.
const said = (content, parent = null, extra = {}) => ({ type: 'assistant', message: { id: extra.id ?? `msg_${Math.random().toString(36).slice(2)}`, model: extra.model ?? 'claude-opus-5-5', content, ...(extra.usage ? { usage: extra.usage } : {}) }, parent_tool_use_id: parent });
const answered = (id, text, parent = null, extra = {}) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...(extra.error ? { is_error: true } : {}) }] }, parent_tool_use_id: parent, ...(extra.result ? { tool_use_result: extra.result } : {}) });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });

// A session folder with no project behind it: the records a session keeps, and its jobs.
function session(t) {
  const home = peerHome(t), root = temp(t), state = path.join(root, '.state');
  const codex = path.join(root, 'codex-home'), before = process.env.CODEX_HOME; process.env.CODEX_HOME = codex;
  t.after(() => { if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before; });
  const repo = { root, state }, dir = path.join(state, 'tasks', '7'); fs.mkdirSync(dir, { recursive: true });
  return { home, root, repo, dir, codex };
}
// An ELU job as lib/jobs.mjs keeps one: job.json, its log, and exit.json once it ended.
function job(dir, name, { line, by = null, startedAt, endedAt = null, log }) {
  const folder = path.join(dir, 'jobs', name); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'job.json'), JSON.stringify({ v: 1, name, session: '7', root: '/x', command: [line], line, cwd: '/x', mode: 'full', ...(by ? { by } : {}), startedAt, mark: 'm', runner: null }));
  if (endedAt) fs.writeFileSync(path.join(folder, 'exit.json'), JSON.stringify({ endedAt, code: 0, signal: null, ranMs: Date.parse(endedAt) - Date.parse(startedAt) }));
  write(path.join(folder, 'output.log'), log);
}

function fixture(t) {
  const s = session(t), { dir, codex } = s;
  saveBot({ name: 'advisor', vendor: 'codex', model: 'gpt-6.1-sol', effort: 'high', instructions: 'Review the plan.' });
  saveBot({ name: 'pair', vendor: 'claude', model: 'opus', instructions: 'Pair on the change.' });
  // The coder's first turn, ended: two Claude Code sub-agents, one answered and one cut by the end.
  const first = write(path.join(dir, 'lead-1.jsonl'), [
    { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
    said([{ type: 'text', text: 'Looking for the login code.' }, call('toolu_A', 'Task', { description: 'Find the auth code', prompt: 'Find where login is checked.', subagent_type: 'Explore' })]),
    { type: 'user', message: { content: [{ type: 'text', text: 'Find where login is checked.' }] }, parent_tool_use_id: 'toolu_A' },
    said([{ type: 'text', text: 'Searching.' }, call('toolu_A1', 'Grep', { pattern: 'login' })], 'toolu_A', { model: 'claude-sonnet-5', id: 'msg_a1', usage: { input_tokens: 1000, output_tokens: 500 } }),
    answered('toolu_A1', 'src/auth.mjs:12', 'toolu_A'),
    answered('toolu_A', 'Found it in src/auth.mjs, line 12.'),
    said([call('toolu_B', 'Agent', { description: 'Draft a test', prompt: 'Write a failing test.' })]),
    { type: 'result', subtype: 'success', total_cost_usd: 0.42, structured_output: { summary: 'Fixed the login check.' }, session_id: 's1' },
  ], { at: ago(30) });
  // Its turn at work now: a plan, a sub-agent still at work, then a command.
  const live = write(path.join(dir, 'lead-2.jsonl'), [
    { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
    said([call('toolu_T', 'TodoWrite', { todos: [{ content: 'Read the code', status: 'completed' }, { content: 'Write the fix', status: 'in_progress' }] })]),
    said([call('toolu_C', 'Task', { description: 'Draft the notes', prompt: 'Draft release notes.' })]),
    said([call('toolu_C1', 'Read', { file_path: 'src/notes.md' })], 'toolu_C', { model: 'claude-haiku-4-5' }),
    said([call('toolu_D', 'Bash', { command: 'npm test' })]),
  ], { at: ago(1) });
  // @advisor on Codex, ended: it spawned an agent and waited on it.
  const advisor = write(path.join(dir, 'advisor-1.jsonl'), [
    { type: 'thread.started', thread_id: '019a0000-0000-7000-8000-000000000001' },
    { type: 'item.started', item: { id: 'item_1', type: 'collab_tool_call', tool: 'spawn_agent', receiver_thread_ids: [], prompt: 'Check the tests', agents_states: {}, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'collab_tool_call', tool: 'spawn_agent', receiver_thread_ids: [THREAD], prompt: 'Check the tests', agents_states: { [THREAD]: { status: 'pending_init', message: null } }, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'collab_tool_call', tool: 'wait', receiver_thread_ids: [THREAD], agents_states: { [THREAD]: { status: 'completed', message: 'Tests pass.' } }, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: '{"summary":"Looks good."}' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } },
  ], { at: ago(20) });
  // The Codex agent's own thread, in the Codex home: its model, effort, use and what it did.
  const day = new Date(Date.now() - 20 * 60000), pad = value => String(value).padStart(2, '0');
  write(path.join(codex, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()), `rollout-2026-11-21T10-00-00-${THREAD}.jsonl`), [
    { timestamp: ago(21), type: 'session_meta', payload: { id: THREAD } },
    { timestamp: ago(21), type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'medium' } },
    { timestamp: ago(21), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the tests' }] } },
    { timestamp: ago(21), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }) } },
    { timestamp: ago(20), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tests pass.' }] } },
    { timestamp: ago(20), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2000, cached_input_tokens: 1000, output_tokens: 300 } } } },
  ]);
  // Two jobs that run an agent, and one that does not.
  job(dir, 'review-helper', { line: "codex exec --json -m gpt-6.1-sol -c model_reasoning_effort=xhigh 'Review the diff'", by: 'bot:advisor', startedAt: ago(19), endedAt: ago(18), log: [
    { type: 'thread.started', thread_id: '019a0000-0000-7000-8000-000000000002' },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: "/bin/zsh -lc 'git diff'", exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: '{"summary":"No issues found."}' } },
    { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } },
  ] });
  job(dir, 'claude-helper', { line: "claude -p --output-format stream-json --model opus 'Summarise the log'", by: 'lead', startedAt: new Date().toISOString(), log: [
    { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
    said([{ type: 'text', text: 'Reading the log' }]),
  ] });
  job(dir, 'nightly', { line: 'npm test', by: 'lead', startedAt: ago(40), endedAt: ago(39), log: 'ok 1 - passes\n' });
  const task = { id: '7', kind: 'conversation', goal: 'Fix the login check', state: 'running', activeRole: 'lead', activeLog: live, activeSince: ago(2), createdAt: ago(60), worktree: s.root, leadEffort: 'high', bots: ['advisor', 'pair'], botsPicked: true,
    runs: [
      { role: 'lead', vendor: 'claude', logFile: first, code: 0, startedAt: ago(35), at: ago(30), model: 'claude-opus-5-5', asked: 'opus', effort: 'high' },
      { role: 'bot:advisor', vendor: 'codex', logFile: advisor, code: 0, startedAt: ago(25), at: ago(20), model: 'gpt-6.1-sol', effort: 'high' },
    ],
    messages: [{ at: ago(24), text: '@advisor check my plan', to: '@advisor' }, { at: ago(20), text: 'Looks good.', from: '@advisor', bot: 'advisor' }, { at: ago(3), text: 'Now add a test.' }] };
  return { ...s, task };
}

test('the rows: the coder, its sub-agents and helpers under it, then each bot with its own', t => {
  const { repo, task } = fixture(t), rows = sessionAgents(repo, task), by = id => rows.find(row => row.id === id);
  assert.deepEqual(rows.map(row => row.id), ['lead', 'sub:lead:toolu_A', 'sub:lead:toolu_B', 'sub:lead:toolu_C', 'job:claude-helper', 'bot:advisor', `sub:bot:advisor:${THREAD}`, 'job:review-helper', 'bot:pair']);
  for (const row of rows) { assert.ok(AGENT_KINDS.includes(row.kind), row.id); assert.ok(AGENT_STATES.includes(row.state), row.id); assert.ok(row.summary.length <= SUMMARY_MAX, row.id); }
  // The coder works now, on the model and effort it runs with, and is on its newest call.
  assert.deepEqual(pick(by('lead'), ['kind', 'name', 'parent', 'vendor', 'model', 'effort', 'state', 'summary']), { kind: 'coder', name: 'Opus 5.5', parent: null, vendor: 'claude', model: 'claude-opus-5-5', effort: 'high', state: 'working', summary: 'Run: npm test' });
  assert.equal(by('lead').since, task.activeSince); assert.ok(Math.abs(by('lead').spend - 0.42) < 1e-9, 'what its ended turn cost');
  // A sub-agent that answered is done with its answer; one its turn's end cut is done; one at work works.
  assert.deepEqual(pick(by('sub:lead:toolu_A'), ['kind', 'name', 'parent', 'vendor', 'model', 'state', 'summary']), { kind: 'subagent', name: 'Find the auth code', parent: 'lead', vendor: 'claude', model: 'claude-sonnet-5', state: 'done', summary: 'Found it in src/auth.mjs, line 12.' });
  assert.ok(Math.abs(by('sub:lead:toolu_A').spend - 0.007) < 1e-9, 'its own tokens at its model\'s list price');
  assert.deepEqual(pick(by('sub:lead:toolu_B'), ['name', 'state', 'model']), { name: 'Draft a test', state: 'done', model: null });
  assert.deepEqual(pick(by('sub:lead:toolu_C'), ['name', 'state', 'model', 'summary']), { name: 'Draft the notes', state: 'working', model: 'claude-haiku-4-5', summary: 'Read: src/notes.md' });
  // A job that runs claude -p is a helper of the agent that started it, read from its own log.
  assert.deepEqual(pick(by('job:claude-helper'), ['kind', 'name', 'parent', 'vendor', 'model', 'state', 'summary']), { kind: 'helper', name: 'claude-helper', parent: 'lead', vendor: 'claude', model: 'claude-opus-5-5', state: 'working', summary: 'Reading the log' });
  // The bot that ended says its last reply; the Codex agent it spawned has its thread's model and use.
  assert.deepEqual(pick(by('bot:advisor'), ['kind', 'name', 'vendor', 'model', 'effort', 'state', 'summary']), { kind: 'bot', name: '@advisor', vendor: 'codex', model: 'gpt-6.1-sol', effort: 'high', state: 'done', summary: 'Looks good.' });
  assert.deepEqual(pick(by(`sub:bot:advisor:${THREAD}`), ['name', 'parent', 'vendor', 'model', 'effort', 'state', 'summary']), { name: 'Check the tests', parent: 'bot:advisor', vendor: 'codex', model: 'gpt-6.1-sol', effort: 'medium', state: 'done', summary: 'Tests pass.' });
  assert.ok(Math.abs(by(`sub:bot:advisor:${THREAD}`).spend - 0.0051) < 1e-9);
  assert.deepEqual(pick(by('job:review-helper'), ['parent', 'vendor', 'model', 'effort', 'state', 'summary']), { parent: 'bot:advisor', vendor: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', state: 'done', summary: 'No issues found.' });
  // A bot that never ran waits, on the model it is saved with.
  assert.deepEqual(pick(by('bot:pair'), ['vendor', 'model', 'state', 'summary', 'since', 'spend']), { vendor: 'claude', model: 'opus', state: 'waiting', summary: '', since: null, spend: null });
  // A job that runs no agent is not listed.
  assert.equal(by('job:nightly'), undefined);
});

test('the coder waits on the owner, on another agent at work, and on a helper of its own', t => {
  const { repo, task, dir } = fixture(t), idle = { ...task, state: 'ready', activeRole: null, activeLog: null };
  const lead = value => sessionAgents(repo, value).find(row => row.id === 'lead');
  assert.deepEqual(pick(lead({ ...idle, state: 'needs_input', result: { question: 'Trim inner spaces too?' } }), ['state', 'summary', 'model', 'effort']), { state: 'waiting', summary: 'Trim inner spaces too?', model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(pick(lead({ ...task, activeRole: 'bot:advisor' }), ['state', 'since']), { state: 'waiting', since: task.activeSince });
  assert.equal(sessionAgents(repo, { ...task, activeRole: 'bot:advisor' }).find(row => row.id === 'bot:advisor').state, 'working');
  // Its own helper still runs: it waits on it. Once that is gone, its last turn is done.
  assert.equal(lead(idle).state, 'waiting');
  fs.rmSync(path.join(dir, 'jobs', 'claude-helper'), { recursive: true });
  assert.deepEqual(pick(lead(idle), ['state', 'summary', 'since']), { state: 'done', summary: 'Fixed the login check.', since: task.runs[0].at });
  // No session, no rows.
  assert.deepEqual(sessionAgents(repo, {}), []); assert.deepEqual(sessionAgents({}, { id: 'x' }), []);
});

test('a log read as it grows: what is new is read, and a sub-agent ends when its answer comes', t => {
  const { repo, task } = fixture(t), row = () => sessionAgents(repo, task).find(value => value.id === 'sub:lead:toolu_C');
  assert.equal(row().state, 'working'); const since = row().since;
  fs.appendFileSync(task.activeLog, lines([answered('toolu_C1', '# Notes', 'toolu_C'), said([{ type: 'text', text: 'Notes drafted.' }], 'toolu_C', { model: 'claude-haiku-4-5' })]));
  assert.deepEqual(pick(row(), ['state', 'summary']), { state: 'working', summary: 'Notes drafted.' });
  fs.appendFileSync(task.activeLog, lines([answered('toolu_C', 'Here are the notes.')]));
  assert.deepEqual(pick(row(), ['state', 'summary']), { state: 'done', summary: 'Here are the notes.' }); assert.ok(Date.parse(row().since) >= Date.parse(since));
  // One started in the background answers that it started, and ends when its notification says so.
  fs.appendFileSync(task.activeLog, lines([said([call('toolu_E', 'Task', { description: 'Watch the build', prompt: 'Watch it.', run_in_background: true })]), { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_E', description: 'Watch the build' }, answered('toolu_E', 'Async agent launched.', null, { result: { status: 'async_launched' } })]));
  assert.equal(sessionAgents(repo, task).find(value => value.id === 'sub:lead:toolu_E').state, 'working');
  fs.appendFileSync(task.activeLog, lines([{ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary: 'The build passed.' }]));
  assert.deepEqual(pick(sessionAgents(repo, task).find(value => value.id === 'sub:lead:toolu_E'), ['state', 'summary']), { state: 'done', summary: 'The build passed.' });
});

test('a thread: what one agent was given, what it did and what it answered, oldest first', t => {
  const { repo, task } = fixture(t);
  const kinds = entries => entries.map(entry => `${entry.kind}:${entry.text.split('\n')[0]}`);
  // The coder: the owner's messages to it, its steps and its reply, then the turn at work.
  const lead = agentThread(repo, task, 'lead');
  assert.deepEqual(kinds(lead), ['note:Fix the login check', 'message:Looking for the login code.', 'step:Agent: Find the auth code', 'step:Agent: Draft a test', 'result:Fixed the login check.', 'note:Now add a test.', 'step:✓ Read the code', 'step:Agent: Draft the notes', 'step:Run: npm test']);
  assert.equal(lead.find(entry => entry.text.startsWith('Run:')).tool, 'Run'); assert.equal(lead.find(entry => entry.tool === 'Plan').text, '✓ Read the code\n● Write the fix');
  assert.deepEqual(kinds(agentThread(repo, task, 'lead', { rows: 2 })), ['step:Agent: Draft the notes', 'step:Run: npm test'], 'the newest rows');
  // A sub-agent: its prompt, its own steps, and the answer its parent got.
  assert.deepEqual(kinds(agentThread(repo, task, 'sub:lead:toolu_A')), ['note:Find where login is checked.', 'message:Searching.', 'step:Search: login', 'result:Found it in src/auth.mjs, line 12.']);
  // A bot: the owner's message to it, its steps and its reply in the chat.
  assert.deepEqual(kinds(agentThread(repo, task, 'bot:advisor')), ['note:@advisor check my plan', 'result:Looks good.']);
  // A Codex agent, from its thread's own record.
  assert.deepEqual(kinds(agentThread(repo, task, `sub:bot:advisor:${THREAD}`)), ['note:Check the tests', 'step:Run: npm test', 'message:Tests pass.']);
  // A helper: its command, its steps, its reply and how it ended.
  assert.deepEqual(kinds(agentThread(repo, task, 'job:review-helper')), [`note:codex exec --json -m gpt-6.1-sol -c model_reasoning_effort=xhigh 'Review the diff'`, 'step:Run: git diff', 'result:No issues found.', 'note:Job review-helper ended with exit code 0 after 1m.']);
  assert.deepEqual(agentThread(repo, task, 'job:nightly'), []); assert.deepEqual(agentThread(repo, task, 'nobody'), []);
});

test('text from a log is one cleaned line in a row, and its keys are masked in rows and threads', t => {
  const { repo, task } = fixture(t), key = `sk-${'a'.repeat(30)}`;
  fs.appendFileSync(task.activeLog, lines([said([{ type: 'text', text: `Using ${key} now\nand more on a second line ${'word '.repeat(80)}` }])]));
  const lead = sessionAgents(repo, task).find(row => row.id === 'lead');
  assert.equal(lead.summary, 'Using [redacted] now'); assert.doesNotMatch(JSON.stringify(agentThread(repo, task, 'lead')), new RegExp(key));
  fs.appendFileSync(task.activeLog, lines([said([{ type: 'text', text: 'x'.repeat(400) }])]));
  const long = sessionAgents(repo, task).find(row => row.id === 'lead').summary;
  assert.equal(long.length, SUMMARY_MAX); assert.ok(long.endsWith('…'));
});

function pick(row, keys) { return Object.fromEntries(keys.map(key => [key, row?.[key]])); }
