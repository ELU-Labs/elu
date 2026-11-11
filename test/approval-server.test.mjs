import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve, SERVER_NAME, TOOL_NAME } from '../lib/approval-server.mjs';
import { answerApproval, pendingApprovals, readApprovalLog } from '../lib/approvals.mjs';
import { approvalServer, APPROVAL_TOOL } from '../lib/mcp.mjs';

// The relay is a plain JSON-RPC server over two streams, so every test drives it in process
// with PassThrough pipes; one test starts the script as Claude Code would, as a child.
function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-relay-'))), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function start(t, argv) {
  const input = new PassThrough(), output = new PassThrough();
  const rows = [], waiting = [];
  let buffer = '';
  output.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) { const row = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); rows.push(row); waiting.splice(0).forEach(resolve => resolve()); }
  });
  const done = serve({ argv, input, output });
  t.after(() => { input.end(); return done; });
  const send = value => input.write(`${JSON.stringify(value)}\n`);
  const next = async predicate => { for (;;) { const row = rows.find(predicate); if (row) return row; await new Promise(resolve => waiting.push(resolve)); } };
  return { send, next, rows, done, input };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, ms = 5000) => { const started = Date.now(); while (!check()) { if (Date.now() - started > ms) throw new Error('Timed out.'); await sleep(20); } };
const argv = (dir, extra = []) => ['--session', 'sess-1', '--root', '/p', '--task', '7', '--role', 'lead', '--vendor', 'claude', '--log', path.join(dir, 'approvals.jsonl'), '--wait', '600', ...extra];

test('initialize, ping and tools/list answer the MCP handshake; the one tool has no outputSchema', async t => {
  const dir = home(t), server = start(t, argv(dir));
  server.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.319' } } });
  const init = await server.next(row => row.id === 1);
  assert.equal(init.result.protocolVersion, '2025-06-18'); assert.equal(init.result.serverInfo.name, SERVER_NAME); assert.deepEqual(init.result.capabilities, { tools: {} });
  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  server.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual((await server.next(row => row.id === 2)).result, {});
  server.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const list = (await server.next(row => row.id === 3)).result;
  assert.equal(list.tools.length, 1); assert.equal(list.tools[0].name, TOOL_NAME); assert.equal('outputSchema' in list.tools[0], false);
  assert.deepEqual(list.tools[0].inputSchema.required, ['tool_name', 'input']);
  assert.equal(APPROVAL_TOOL, `mcp__${SERVER_NAME}__${TOOL_NAME}`);
});

test('an unknown method is -32601, a malformed line -32700, and neither stops the server', async t => {
  const dir = home(t), server = start(t, argv(dir));
  server.send({ jsonrpc: '2.0', id: 4, method: 'server/discover' });
  const unknown = await server.next(row => row.id === 4);
  assert.equal(unknown.error.code, -32601); assert.equal(unknown.error.message, 'Method not found');
  server.input.write('{not json\n');
  const bad = await server.next(row => row.error?.code === -32700);
  assert.equal(bad.id, null);
  server.input.write('[1,2]\n');
  assert.equal((await server.next(row => row.error?.code === -32600)).id, null);
  server.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'other', arguments: {} } });
  assert.equal((await server.next(row => row.id === 5)).error.code, -32602);
  server.send({ jsonrpc: '2.0', id: 6, method: 'ping' });
  assert.deepEqual((await server.next(row => row.id === 6)).result, {});
  assert.equal(server.rows.filter(row => row.id === 4).length, 1);
});

test('approve writes a request the owner can allow, replies with the allow block and logs the decision', async t => {
  const dir = home(t), server = start(t, argv(dir));
  server.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: TOOL_NAME, arguments: { tool_name: 'Bash', input: { command: 'npm test' }, tool_use_id: 'toolu_01AbC' } } });
  await until(() => pendingApprovals().length === 1);
  const [pending] = pendingApprovals({ root: '/p', taskId: '7' });
  assert.equal(pending.id, 'sess-1-toolu_01AbC'); assert.equal(pending.summary, 'Run: npm test'); assert.equal(pending.role, 'lead'); assert.equal(pending.vendor, 'claude');
  assert.equal(server.rows.some(row => row.id === 7), false, 'no reply before the owner answers');
  // A ping while the approval waits is still answered.
  server.send({ jsonrpc: '2.0', id: 8, method: 'ping' });
  assert.deepEqual((await server.next(row => row.id === 8)).result, {});
  assert.equal(answerApproval(pending.id, 'allow'), true);
  const reply = await server.next(row => row.id === 7);
  assert.deepEqual(reply.result, { content: [{ type: 'text', text: '{"behavior":"allow"}' }] });
  await until(() => pendingApprovals().length === 0);
  const log = readApprovalLog(path.join(dir, 'approvals.jsonl'));
  assert.equal(log.length, 1); assert.equal(log[0].id, pending.id); assert.equal(log[0].tool, 'Bash'); assert.equal(log[0].decision, 'allow'); assert.equal(log[0].summary, 'Run: npm test');
  assert.equal(fs.statSync(path.join(dir, 'approvals.jsonl')).mode & 0o777, 0o600);
});

test('a denied approval tells the model not to retry, and a second call without an id gets its own request', async t => {
  const dir = home(t), server = start(t, argv(dir));
  server.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: TOOL_NAME, arguments: { tool_name: 'Write', input: { file_path: '/outside/x' } } } });
  server.send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: TOOL_NAME, arguments: { tool_name: 'WebFetch', input: { url: 'https://example.test/' } } } });
  await until(() => pendingApprovals().length === 2);
  const ids = pendingApprovals().map(row => row.id).sort();
  assert.deepEqual(ids, ['sess-1-call-1', 'sess-1-call-2']);
  answerApproval('sess-1-call-1', 'deny'); answerApproval('sess-1-call-2', 'allow');
  const denied = await server.next(row => row.id === 9), allowed = await server.next(row => row.id === 10);
  const text = JSON.parse(denied.result.content[0].text);
  assert.equal(text.behavior, 'deny'); assert.match(text.message, /declined this\. Do not retry it another way/);
  assert.equal(JSON.parse(allowed.result.content[0].text).behavior, 'allow');
  const log = readApprovalLog(path.join(dir, 'approvals.jsonl'));
  assert.deepEqual(log.map(row => [row.tool, row.decision]).sort(), [['WebFetch', 'allow'], ['Write', 'deny']]);
});

test('no answer within the wait is a denial that names the wait, and progress is sent only with a token', async t => {
  const dir = home(t), server = start(t, argv(dir, ['--progress', '1']).map(value => value === '600' ? '2' : value));
  server.send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: TOOL_NAME, arguments: { tool_name: 'Bash', input: { command: 'curl https://example.test' }, tool_use_id: 'slow' }, _meta: { progressToken: 'p1' } } });
  const reply = await server.next(row => row.id === 11);
  const text = JSON.parse(reply.result.content[0].text);
  assert.equal(text.behavior, 'deny'); assert.match(text.message, /No answer from the owner within 1 minutes?\. Do not retry it another way/);
  const progress = server.rows.filter(row => row.method === 'notifications/progress');
  assert.ok(progress.length >= 1); assert.equal(progress[0].params.progressToken, 'p1'); assert.match(progress[0].params.message, /Waiting for the owner: Run: curl/);
  assert.equal(readApprovalLog(path.join(dir, 'approvals.jsonl')).at(-1).decision, 'timeout');
  assert.equal(pendingApprovals().length, 0);
  // Without a token: no progress rows at all.
  server.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: TOOL_NAME, arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'quiet' } } });
  await server.next(row => row.id === 12);
  assert.equal(server.rows.filter(row => row.method === 'notifications/progress').length, progress.length);
});

test('the server refuses bad options and runs as a child exactly as approvalServer() describes it', async t => {
  const dir = home(t);
  await assert.rejects(serve({ argv: ['--session', 'bad id'], input: new PassThrough(), output: new PassThrough() }), /plain --session id/);
  await assert.rejects(serve({ argv: ['--session', 'ok', '--wait', '0'], input: new PassThrough(), output: new PassThrough() }), /positive seconds/);
  await assert.rejects(serve({ argv: ['--session', 'ok', '--log', 'relative.jsonl'], input: new PassThrough(), output: new PassThrough() }), /absolute path/);
  await assert.rejects(serve({ argv: ['--session', 'ok', '--nope', 'x'], input: new PassThrough(), output: new PassThrough() }), /Unknown or incomplete option/);
  assert.throws(() => approvalServer({ session: 'has space', log: path.join(dir, 'l') }), /plain session id/);
  assert.throws(() => approvalServer({ session: 'ok', log: 'l' }), /absolute log path/);
  const spec = approvalServer({ session: 'child-1', root: '/p', taskId: 7, role: 'lead', vendor: 'claude', log: path.join(dir, 'child.jsonl'), waitSeconds: 60 });
  assert.equal(spec.command, process.execPath); assert.equal(fs.realpathSync(spec.args[0]), fs.realpathSync(fileURLToPath(new URL('../lib/approval-server.mjs', import.meta.url))));
  assert.equal(spec.env.XDG_CONFIG_HOME, process.env.XDG_CONFIG_HOME); assert.equal(Object.keys(spec.env).sort().join(','), 'HOME,XDG_CONFIG_HOME');
  const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', chunk => { out += chunk; });
  const exit = new Promise(resolve => child.once('close', resolve));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
  await until(() => out.includes('\n'));
  assert.equal(JSON.parse(out.trim()).result.tools[0].name, TOOL_NAME);
  child.stdin.end();
  assert.equal(await exit, 0);
  const bad = spawn(spec.command, [spec.args[0], '--session', 'bad id'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = ''; bad.stderr.on('data', chunk => { err += chunk; });
  assert.equal(await new Promise(resolve => bad.once('close', resolve)), 2); assert.match(err, /plain --session id/);
});
