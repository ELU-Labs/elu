import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { temp } from './helpers.mjs';
import { ELU_CALLS_PER_DAY, OVERSEE_DENIED, SERVER_NAME, TOOL_NAME, overseeing, serve } from '../lib/approval-server.mjs';
import { answerApproval, pendingApprovals, readApprovalLog } from '../lib/approvals.mjs';
import { approvalServer } from '../lib/mcp.mjs';
import { saveRule } from '../lib/permission-rules.mjs';
import { registerProject } from '../lib/projects.mjs';
import { saveTask } from '../lib/state.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { actionsFile } from '../lib/orchestrator-actions.mjs';
import { ORCH_TOOLS, overseeingAnswer, readingTool } from '../lib/orchestrator-tools.mjs';

// The approval relay for the turn of the bot that oversees the sessions (--oversee,
// lib/approval-server.mjs): its own table answers first, in every mode and before any rule of
// the owner's, it is served its ten tools, and its questions to ELU have a cap a day. Driven in
// process with PassThrough pipes, as test/approval-server.test.mjs does; ELU's own folder is a
// new empty one in every test, and no model or vendor program is started.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// A project on this computer with the bot's own chat as session 1.
function world(t) {
  const dir = temp(t); environment(t, { XDG_CONFIG_HOME: path.join(dir, 'personal') });
  const root = path.join(dir, 'web'); fs.mkdirSync(root);
  const repo = projectFolder(root); registerProject(repo);
  saveTask(repo, { id: '1', kind: 'conversation', base: null, branch: null, worktree: repo.root, goal: 'Oversee the sessions', state: 'answered', createdAt: new Date().toISOString(), runs: [], messages: [], reviews: [], responses: [], sessions: {}, permissions: 'auto', botChat: 'orchestrator' });
  return { dir, root, repo, log: path.join(dir, 'approvals.jsonl') };
}
function start(t, argv) {
  const input = new PassThrough(), output = new PassThrough(), rows = [], waiting = [];
  let buffer = '';
  output.on('data', chunk => {
    buffer += chunk;
    for (let index; (index = buffer.indexOf('\n')) >= 0;) { rows.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); waiting.splice(0).forEach(resolve => resolve()); }
  });
  const done = serve({ argv, input, output });
  t.after(() => { input.end(); return done; });
  let id = 0;
  const next = async predicate => { for (;;) { const row = rows.find(predicate); if (row) return row; await new Promise(resolve => waiting.push(resolve)); } };
  const call = (name, args, meta) => { const at = ++id; input.write(`${JSON.stringify({ jsonrpc: '2.0', id: at, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } })}\n`); return { at, reply: () => next(row => row.id === at) }; };
  const ask = (tool, toolInput = {}) => call(TOOL_NAME, { tool_name: tool, input: toolInput });
  const list = async () => { const at = ++id; input.write(`${JSON.stringify({ jsonrpc: '2.0', id: at, method: 'tools/list' })}\n`); return (await next(row => row.id === at)).result.tools.map(tool => tool.name); };
  return { rows, call, ask, list, next };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, ms = 5000) => { const started = Date.now(); while (!check()) { if (Date.now() - started > ms) throw new Error('Timed out.'); await sleep(20); } };
const answer = row => JSON.parse(row.result.content[0].text);
const argv = (w, { mode = 'full', bot = 'orchestrator', servers = ['elu', 'gmail', 'slack'] } = {}) => ['--session', 'sess-1', '--root', w.root, '--task', '1', '--role', `bot:${bot}`, '--vendor', 'claude', '--log', w.log, '--wait', '600', '--rules', 'saved', '--sandboxed', 'no', '--mode', mode, '--folders', '[]', '--oversee', bot, '--servers', JSON.stringify(servers)];

// Real tool names of common MCP servers, and whether each only reads. Allowed without asking
// only when it reads: a name with no reading word, or with any word that changes, asks.
const NAMES = [
  ['gmail', 'search_emails', true], ['gmail', 'read_email', true], ['gmail', 'list_email_labels', true], ['gmail', 'list_filters', true], ['gmail', 'get_filter', true],
  ['gmail', 'send_email', false], ['gmail', 'draft_email', false], ['gmail', 'modify_email', false], ['gmail', 'delete_email', false], ['gmail', 'batch_modify_emails', false],
  ['gmail', 'batch_delete_emails', false], ['gmail', 'create_label', false], ['gmail', 'update_label', false], ['gmail', 'delete_label', false], ['gmail', 'get_or_create_label', false],
  ['gmail', 'download_attachment', false], ['gmail', 'create_filter', false], ['gmail', 'delete_filter', false],
  ['Gmail', 'search_threads', true], ['Gmail', 'get_thread', true], ['Gmail', 'get_message', true], ['Gmail', 'list_labels', true], ['Gmail', 'list_drafts', true],
  ['Gmail', 'create_draft', false], ['Gmail', 'send_message', false], ['Gmail', 'reply', false], ['Gmail', 'forward', false], ['Gmail', 'label_message', false], ['Gmail', 'trash_thread', false], ['Gmail', 'untrash_message', false],
  ['slack', 'slack_list_channels', true], ['slack', 'slack_get_channel_history', true], ['slack', 'slack_get_thread_replies', true], ['slack', 'slack_get_users', true], ['slack', 'slack_get_user_profile', true],
  ['slack', 'slack_post_message', false], ['slack', 'slack_reply_to_thread', false], ['slack', 'slack_add_reaction', false], ['slack', 'conversations_history', false], ['slack', 'chat_postMessage', false],
  ['github', 'search_repositories', true], ['github', 'search_code', true], ['github', 'search_issues', true], ['github', 'get_file_contents', true], ['github', 'list_commits', true], ['github', 'get_pull_request', true],
  ['github', 'create_issue', false], ['github', 'update_issue', false], ['github', 'add_issue_comment', false], ['github', 'create_pull_request', false], ['github', 'merge_pull_request', false], ['github', 'create_or_update_file', false], ['github', 'push_files', false], ['github', 'fork_repository', false], ['github', 'create_branch', false],
  ['postgres', 'query', false], ['postgres', 'execute_sql', false], ['postgres', 'list_tables', true], ['postgres', 'describe_table', true],
  ['linear', 'list_issues', true], ['linear', 'get_issue', true], ['linear', 'list_projects', true], ['linear', 'create_issue', false], ['linear', 'update_issue', false],
  ['notion', 'notion-search', true], ['notion', 'notion-fetch', true], ['notion', 'notion-create-pages', false], ['notion', 'notion-update-page', false],
  ['filesystem', 'read_file', true], ['filesystem', 'list_directory', true], ['filesystem', 'search_files', true], ['filesystem', 'get_file_info', true], ['filesystem', 'write_file', false], ['filesystem', 'edit_file', false], ['filesystem', 'move_file', false], ['filesystem', 'create_directory', false],
  ['google-drive', 'google_drive_search', true], ['google-drive', 'google_drive_fetch', true],
  ['playwright', 'browser_navigate', false], ['playwright', 'browser_click', false],
  ['elu', 'ask_elu', true], ['elu', 'list_issues', true], ['elu', 'create_issue', false],
];

test('a reading tool is told by the words of its name, after the server\'s own name is dropped', () => {
  assert.ok(NAMES.length >= 40);
  for (const [server, tool, reads] of NAMES) assert.equal(readingTool(server, tool), reads, `${server} ${tool}`);
  // The words that change are looked for only after the server's own name: send_list lists on a
  // server named send, and sends on any other.
  assert.equal(readingTool('send', 'send_list'), true);
  assert.equal(readingTool('mail', 'send_list'), false);
  assert.equal(readingTool('post', 'post_search'), true);
  assert.equal(readingTool('slack', 'post_search'), false);
  // A name in camel case reads the same.
  assert.deepEqual(['searchEmails', 'getUserProfile', 'sendEmail', 'createDraft'].map(tool => readingTool('mail', tool)), [true, true, false, false]);
  // The table: reads allowed, the rest asks, and an edit or command is refused in every mode.
  const servers = ['gmail', 'elu'];
  for (const mode of ['ask', 'auto', 'full']) {
    assert.equal(overseeingAnswer('mcp__gmail__search_emails', { mode, servers }), 'allow', mode);
    assert.equal(overseeingAnswer('mcp__gmail__send_email', { mode, servers }), 'ask', mode);
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']) assert.equal(overseeingAnswer(tool, { mode, servers }), 'deny', `${mode} ${tool}`);
  }
});

test('the relay of the overseeing turn serves its ten tools, and none for the other computers', async t => {
  const w = world(t), server = start(t, argv(w));
  assert.deepEqual(await server.list(), [TOOL_NAME, ...ORCH_TOOLS]);
  // One of the ten runs through act for the session the turn is in.
  const read = await server.call('sessions_list', {}).reply();
  assert.equal(read.result.isError, undefined, read.result.content[0].text);
  // A tool it does not have is unknown, as before.
  assert.equal((await server.call('list_other_sessions', {}).reply()).error.code, -32602);
  // Another role's relay, or one in a session of no project here, serves none of them.
  const plain = start(t, argv(w).slice(0, -4));
  assert.deepEqual(await plain.list(), [TOOL_NAME, 'list_other_sessions', 'send_to_session']);
  assert.equal((await plain.call('sessions_list', {}).reply()).error.code, -32602);
  const elsewhere = start(t, argv(w).map(value => value === w.root ? path.join(w.dir, 'none') : value));
  assert.deepEqual(await elsewhere.list(), [TOOL_NAME]);
  // --oversee names the bot whose turn it is, and only it.
  await assert.rejects(serve({ argv: argv(w).map(value => value === 'bot:orchestrator' ? 'lead' : value), input: new PassThrough(), output: new PassThrough() }), /--oversee names the bot whose turn this is/);
  await assert.rejects(serve({ argv: argv(w).map(value => value === '["elu","gmail","slack"]' ? '"elu"' : value), input: new PassThrough(), output: new PassThrough() }), /--servers is a list of server names/);
  // The launch passes both, with the servers the turn has.
  const spec = approvalServer({ session: 's1', root: w.root, taskId: '1', role: 'bot:orchestrator', log: w.log, mode: 'auto', oversee: 'orchestrator', servers: ['elu', 'gmail'] });
  assert.deepEqual(spec.args.slice(-4), ['--oversee', 'orchestrator', '--servers', '["elu","gmail"]']);
  assert.equal(approvalServer({ session: 's1', log: w.log }).args.includes('--oversee'), false);
  assert.throws(() => approvalServer({ session: 's1', log: w.log, oversee: 'Bad Name' }), /names the bot that oversees/);
  assert.equal(SERVER_NAME, 'elu-code-approval');
});

test('in Full access an edit or a command is refused, a read is allowed, and a change asks the owner with no rule or Full answering it', async t => {
  const w = world(t), server = start(t, argv(w));
  for (const [tool, input] of [['Edit', { file_path: path.join(w.root, 'a.txt') }], ['Write', { file_path: path.join(w.root, 'b.txt') }], ['Bash', { command: 'ls' }]]) {
    const out = answer(await server.ask(tool, input).reply());
    assert.deepEqual(out, { behavior: 'deny', message: OVERSEE_DENIED }, tool);
  }
  assert.equal(answer(await server.ask('mcp__gmail__search_emails', { query: 'invoice' }).reply()).behavior, 'allow');
  assert.deepEqual(pendingApprovals(), [], 'nothing was asked');
  // A source's change, and the web in a session that asks first, reach the owner as they are.
  saveRule({ kind: 'fetch', domain: 'example.test' }, { scope: 'all' });
  const send = server.ask('mcp__gmail__send_email', { to: 'a@example.test', subject: 'Hi' });
  await until(() => pendingApprovals().length === 1);
  const [asked] = pendingApprovals();
  assert.equal(asked.role, 'bot:orchestrator'); assert.equal(asked.rules, undefined, 'no rule is offered for it');
  assert.equal(server.rows.some(row => row.id === send.at), false, 'Full access does not answer it');
  answerApproval(asked.id, 'deny');
  assert.match(answer(await send.reply()).message, /The owner declined this/);
  const web = start(t, argv(w, { mode: 'ask' })), fetch = web.ask('WebFetch', { url: 'https://example.test/page' });
  await until(() => pendingApprovals().length === 1);
  answerApproval(pendingApprovals()[0].id, 'allow');
  assert.equal(answer(await fetch.reply()).behavior, 'allow');
  // The session says what its table allowed as allowed by default, never as the owner's yes.
  const log = readApprovalLog(w.log), raw = fs.readFileSync(w.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.map(row => [row.tool, row.decision, row.by ?? null]), [['Edit', 'deny', null], ['Write', 'deny', null], ['Bash', 'deny', null], ['mcp__gmail__search_emails', 'allow', 'default'], ['mcp__gmail__send_email', 'deny', null], ['WebFetch', 'allow', null]]);
  assert.equal(log[3].rule, 'what the bot that oversees your sessions uses without asking');
  assert.deepEqual(raw.map(row => row.by ?? null), ['oversee', 'oversee', 'oversee', 'default', null, null]);
});

test('each question to ELU that goes is a line of the action log, and past the cap a day one is refused in one sentence', async t => {
  const w = world(t), file = actionsFile(), now = Date.now();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 19 questions in the last day, one older than a day, and an ELU tool that is not a question.
  const row = (n, ago, extra = {}) => JSON.stringify({ id: `a${n}`, at: new Date(now - ago).toISOString(), bot: 'orchestrator', from: { root: w.root, session: '1', run: 'r' }, action: 'ask_elu', target: null, summary: 'Ask ELU', level: null, decision: 'allow', by: 'level', undo: null, undoneAt: null, ...extra });
  fs.writeFileSync(file, [...Array.from({ length: 19 }, (_, at) => row(at + 1, 3600000)), row(20, 25 * 3600000), row(21, 60000, { action: 'card_add' })].join('\n') + '\n');
  const server = start(t, argv(w));
  assert.equal(answer(await server.ask('mcp__elu__ask_elu', { question: 'Which pages lose the most users?' }).reply()).behavior, 'allow');
  const logged = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.deepEqual([logged.id, logged.action, logged.decision, logged.bot, logged.summary, logged.from.session], ['a22', 'ask_elu', 'allow', 'orchestrator', 'Ask ELU: "Which pages lose the most users?"', '1']);
  // That was the 20th: the next is refused, and says so.
  assert.equal(ELU_CALLS_PER_DAY, 20);
  const refused = answer(await server.ask('mcp__elu__ask_elu', { question: 'And on mobile?' }).reply());
  assert.equal(refused.behavior, 'deny');
  assert.equal(refused.message, 'The owner\'s cap is 20 questions to ELU a day and you asked 20 in the last 24 hours, so this one was not sent: say in your reply what you would ask.');
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).at(-1).decision, 'capped');
  // ELU's other reading tool is not a question, and is not counted.
  assert.equal(answer(await server.ask('mcp__elu__list_issues', {}).reply()).behavior, 'allow');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 23);
});

test('the same answers come for a question Claude Code asks on its own output', async t => {
  const w = world(t), ctx = { mode: 'full', root: w.root, taskId: '1', role: 'bot:orchestrator', vendor: 'claude', bot: 'orchestrator', servers: ['elu', 'gmail'], run: 'sess-1', rules: 'saved' };
  assert.deepEqual(await overseeing('Bash', { command: 'rm -rf build' }, { id: 'c1', ...ctx }), { decision: 'deny', by: 'oversee', summary: 'Run: rm -rf build', message: OVERSEE_DENIED });
  assert.equal((await overseeing('mcp__gmail__read_email', { id: 'm1' }, { id: 'c2', ...ctx })).decision, 'allow');
  // What asks waits for the owner, and a timeout says so.
  const asked = [];
  const out = await overseeing('mcp__gmail__send_email', {}, { id: 'c3', ...ctx, waitSeconds: 1, onAsk: summary => asked.push(summary) });
  assert.equal(out.decision, 'timeout'); assert.match(out.message, /No answer from the owner within 1 minutes?/); assert.equal(asked.length, 1);
});
