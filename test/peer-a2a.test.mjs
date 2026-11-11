import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { temp } from './helpers.mjs';
import {
  A2A_VERSION, BINDING, PEER_EXT, TaskState, Role, ErrorCode, CORE_METHODS, a2aError, textPart, dataPart, message, task, artifact,
  withState, peerExt, validateMessage, validateTask, isTerminal, createRpcHandler,
} from '../lib/peer/a2a.mjs';
import { startLocalA2A, buildAgentCard, localToken } from '../lib/peer/a2a-http.mjs';
import { refuse } from '../lib/util.mjs';

const fixture = (name) => {
  const { _source, ...value } = JSON.parse(fs.readFileSync(new URL(`./fixtures/a2a/${name}`, import.meta.url), 'utf8'));
  assert.match(_source, /A2A v1\.0\.1 docs\/specification\.md lines \d+-\d+/);
  return value;
};
const KEY = 'ab'.repeat(32);
const EXT = { kind: 'ask', project: 'shop', hop: 1, from: { key: KEY, name: 'ana' } };
const rpcCall = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
function home(t) {
  const dir = temp(t), before = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  t.after(() => { if (before === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = before; });
  return dir;
}

test('constants match the A2A v1.0.1 spec strings', () => {
  assert.equal(A2A_VERSION, '1.0');
  assert.equal(BINDING, 'urn:elu-code:a2a-binding:hyperswarm-ndjson:v1');
  assert.equal(PEER_EXT, 'urn:elu-code:a2a-ext:peer:v1');
  assert.deepEqual(Object.values(TaskState), ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED',
    'TASK_STATE_CANCELED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED']);
  assert.deepEqual(Object.values(Role), ['ROLE_USER', 'ROLE_AGENT']);
  assert.equal(ErrorCode.TASK_NOT_FOUND, -32001);
  assert.equal(ErrorCode.UNSUPPORTED_OPERATION, -32004);
  assert.equal(ErrorCode.VERSION_NOT_SUPPORTED, -32009);
  assert.equal(CORE_METHODS.length, 11);
  for (const state of ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']) assert.equal(isTerminal(state), true);
  for (const state of ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED']) assert.equal(isTerminal(state), false);
});

test('validators accept the spec examples unchanged', () => {
  for (const name of ['spec-6.1-send-message.json', 'spec-6.8-send-message-structured.json']) {
    const { message: value } = fixture(name);
    assert.deepEqual(validateMessage(value), value, name);
  }
  for (const name of ['spec-6.1-task-completed.json', 'spec-6.7-task-file-artifact.json', 'spec-6.8-task-structured-data.json']) {
    const { task: value } = fixture(name);
    assert.deepEqual(validateTask(value), value, name);
  }
});

test('the SDK codec reads what the builders write', async () => {
  const sdk = await import('@a2a-js/sdk');
  const sent = message({ text: 'Where is the coupon code normalised?', contextId: 'thread-1', ext: EXT });
  const read = sdk.Message.fromJSON(sent);
  assert.equal(read.role, sdk.Role.ROLE_USER);
  assert.equal(read.parts[0].content.value, 'Where is the coupon code normalised?');
  assert.deepEqual(sdk.Message.toJSON(read), sent);
  const done = withState(task({ contextId: 'thread-1' }), TaskState.COMPLETED, { artifacts: [artifact({ name: 'Answer', text: 'In src/coupon.mjs.' })] });
  assert.equal(sdk.Task.fromJSON(done).status.state, sdk.TaskState.TASK_STATE_COMPLETED);
  assert.deepEqual(sdk.Task.toJSON(sdk.Task.fromJSON(done)), done);
});

test('builders produce spec-form messages and tasks with the peer extension', () => {
  const sent = message({ text: 'Why does checkout fail?', contextId: 'thread-1', ext: { kind: 'ask', from: { key: KEY, name: 'ana' } } });
  assert.match(sent.messageId, /^[0-9a-f-]{36}$/);
  assert.equal(sent.role, 'ROLE_USER');
  assert.deepEqual(sent.parts, [{ text: 'Why does checkout fail?' }]);
  assert.deepEqual(sent.extensions, [PEER_EXT]);
  assert.deepEqual(peerExt(sent), { kind: 'ask', project: null, hop: 1, from: { key: KEY, name: 'ana' } });
  assert.deepEqual(validateMessage(sent), sent);
  assert.deepEqual(textPart(3), { text: '3' });
  assert.deepEqual(dataPart({ a: 1 }), { data: { a: 1 }, mediaType: 'application/json' });
  assert.deepEqual(message({ role: Role.AGENT, parts: [dataPart({ files: ['a.js'] })], messageId: 'm-1' }), { messageId: 'm-1', role: 'ROLE_AGENT', parts: [{ data: { files: ['a.js'] }, mediaType: 'application/json' }] });

  const submitted = task({ id: 'task-1', contextId: 'thread-1' });
  assert.equal(submitted.status.state, 'TASK_STATE_SUBMITTED');
  assert.match(submitted.status.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const held = withState(submitted, TaskState.WORKING, { ext: { substate: 'awaiting-owner' } });
  assert.deepEqual(peerExt(held), { substate: 'awaiting-owner' });
  const done = withState(held, TaskState.COMPLETED, { ext: null, artifacts: [artifact({ name: 'Answer', text: 'The coupon is never upper-cased.' })] });
  assert.equal(done.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(peerExt(done), null);
  assert.equal(done.metadata, undefined);
  assert.equal(done.artifacts[0].parts[0].text, 'The coupon is never upper-cased.');
  assert.ok(done.artifacts[0].artifactId);
  const rejected = task({ state: TaskState.REJECTED, statusMessage: 'This project is not shared.', contextId: 'thread-1' });
  assert.equal(rejected.status.message.role, 'ROLE_AGENT');
  assert.equal(rejected.status.message.taskId, rejected.id);
  assert.equal(rejected.status.message.parts[0].text, 'This project is not shared.');
  assert.throws(() => withState(done, TaskState.WORKING), /already finished/);
  assert.throws(() => message({}), /needs text or parts/);
});

test('validators normalise snake_case and integer enums the SDK also reads', () => {
  const value = validateMessage({ message_id: 'm-1', context_id: 'c-1', role: 1, parts: [{ text: 'hi', media_type: 'text/plain' }] });
  assert.deepEqual(value, { messageId: 'm-1', contextId: 'c-1', role: 'ROLE_USER', parts: [{ text: 'hi', mediaType: 'text/plain' }] });
  assert.equal(validateTask({ id: 't-1', context_id: 'c-1', status: { state: 3 } }).status.state, 'TASK_STATE_COMPLETED');
  assert.throws(() => validateMessage({ messageId: 'm-1', message_id: 'm-2', role: 'ROLE_USER', parts: [{ text: 'x' }] }), /repeats/);
});

test('validators refuse hostile or unknown shapes', () => {
  const base = { messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: 'hi' }] };
  const bad = [
    [{ ...base, role: 'user' }, /role must be one of/],
    [{ ...base, role: 'ROLE_UNSPECIFIED' }, /role must be one of/],
    [{ ...base, messageId: 7 }, /short id/],
    [{ ...base, messageId: '../../etc/passwd' }, /short id/],
    [{ ...base, messageId: 'a/b' }, /short id/],
    [{ ...base, contextId: '..' }, /short id/],
    [{ ...base, taskId: { id: 1 } }, /short id/],
    [{ ...base, parts: [] }, /at least one part/],
    [{ ...base, parts: Array.from({ length: 9 }, () => ({ text: 'x' })) }, /at most 8/],
    [{ ...base, parts: [{ text: 'x'.repeat(16001) }] }, /at most 16000|longer than 16000/],
    [{ ...base, parts: [{ text: 'x'.repeat(9000) }, { text: 'y'.repeat(9000) }] }, /longer than 16000/],
    [{ ...base, parts: [{ text: 'x', url: 'https://example.com' }] }, /exactly one/],
    [{ ...base, parts: [{ file: { uri: 'x' } }] }, /exactly one/],
    [{ ...base, metadata: { [PEER_EXT]: EXT } }, /without listing the peer extension/],
    [{ ...base, extensions: [PEER_EXT], metadata: { [PEER_EXT]: { ...EXT, kind: 'shell' } } }, /kind must be one of/],
    [{ ...base, extensions: [PEER_EXT], metadata: { [PEER_EXT]: { ...EXT, project: '../x' } } }, /share handle/],
    [{ ...base, extensions: [PEER_EXT], metadata: { [PEER_EXT]: { ...EXT, from: { key: 'zz', name: 'ana' } } } }, /64 hex/],
    [{ ...base, extensions: [PEER_EXT], metadata: { [PEER_EXT]: { ...EXT, from: { key: KEY, name: 'a\u202ena' } } } }, /plain text/],
    [{ ...base, metadata: { deep: JSON.parse('['.repeat(40) + ']'.repeat(40)) } }, /nested too deeply/],
    [{ ...base, metadata: { big: 'x'.repeat(20000) } }, /too large/],
    [[base], /must be an object/],
  ];
  for (const [value, pattern] of bad) assert.throws(() => validateMessage(value), pattern, JSON.stringify(value).slice(0, 120));
  assert.equal(validateMessage({ ...base, parts: [{ text: 'x'.repeat(20000) }] }, { max: 160000 }).parts[0].text.length, 20000);
  assert.throws(() => validateTask({ id: 't-1', status: { state: 'TASK_STATE_DONE' } }), /Task state/);
  assert.throws(() => validateTask({ id: 't-1', status: { state: 'TASK_STATE_COMPLETED', timestamp: 'yesterday' } }), /ISO 8601/);
  assert.throws(() => validateTask({ id: 't/1', status: { state: 'TASK_STATE_COMPLETED' } }), /short id/);
  assert.throws(() => validateTask({ id: 't-1', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [{ text: 'x' }] }] }), /artifact 1 id/);
  // Fields a newer peer adds are dropped, not refused (§5.7).
  assert.deepEqual(validateMessage({ ...base, kind: 'message' }), base);
  assert.deepEqual(validateTask({ id: 't-1', status: { state: 'TASK_STATE_COMPLETED', progress: 0.5 }, kind: 'task' }), { id: 't-1', status: { state: 'TASK_STATE_COMPLETED' } });
});

test('the peer extension takes the name of a bot beside its other fields, and refuses anything that is not a bot name', () => {
  const from = { key: KEY, name: 'ana' }, base = { kind: 'ask', project: null, hop: 1, from };
  const ext = extra => peerExt(message({ text: 'x', ext: { kind: 'ask', from, ...extra } }));
  for (const bot of ['reviewer', 'a', 'docs-2', `a${'1'.repeat(29)}`]) assert.deepEqual(ext({ bot }), { ...base, bot }, bot);
  // A plain ask names none: the field is absent, not empty.
  assert.deepEqual(ext({}), base); assert.deepEqual(ext({ bot: null }), base); assert.equal('bot' in ext({}), false);
  for (const bot of ['', 'Reviewer', '1st', '-x', 'a b', 'a/b', 'a.b', '@reviewer', 'r\u00e9viseur', `a${'1'.repeat(30)}`, 'reviewer\n', 7, true, ['reviewer'], { name: 'reviewer' }])
    assert.throws(() => ext({ bot }), /Peer metadata bot must be a bot name\./, JSON.stringify(bot));
  // As it arrives from another machine: kept beside project and room, with fields this build does not know dropped.
  const room = { team: 'c'.repeat(64), channel: null };
  const wire = { messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: 'x' }], extensions: [PEER_EXT], metadata: { [PEER_EXT]: { ...EXT, room, bot: 'reviewer', effort: 'high' } } };
  assert.deepEqual(peerExt(validateMessage(wire)), { ...EXT, room, bot: 'reviewer' });
  assert.throws(() => validateMessage({ ...wire, metadata: { [PEER_EXT]: { ...EXT, bot: '../x' } } }), /Peer metadata bot must be a bot name\./);
});

test('the RPC handler validates requests and maps errors without leaking internals', async () => {
  const seen = [], internal = [];
  const stored = task({ id: 'task-uuid', contextId: 'thread-1' });
  const handle = createRpcHandler({
    async SendMessage(params, ctx) { seen.push({ params, ctx }); return stored; },
    async GetTask({ id }) { if (id !== 'task-uuid') throw a2aError(ErrorCode.TASK_NOT_FOUND, 'Task not found.', { taskId: id }); return stored; },
    async CancelTask() { refuse(`This task is already finished at ${process.env.HOME}/secret/place.`); },
    async 'elu.status'(params) { seen.push({ status: params }); },
    async 'elu.crash'() { throw new TypeError('secret detail at /Users/x/y.js:1'); },
    async 'elu.bad'() { return 'fine'; },
  }, { onError: (error) => internal.push(error) });

  const sent = await handle(rpcCall('SendMessage', fixture('spec-6.1-send-message.json')), { peer: KEY });
  assert.deepEqual(sent, { jsonrpc: '2.0', id: 1, result: { task: stored } });
  assert.equal(seen[0].ctx.peer, KEY);
  assert.equal(seen[0].params.message.role, 'ROLE_USER');

  const got = await handle(rpcCall('GetTask', { id: 'task-uuid', historyLength: 10 }, 'req-2'));
  assert.deepEqual(got, { jsonrpc: '2.0', id: 'req-2', result: stored });

  const missing = await handle(rpcCall('GetTask', { id: 'nonexistent-task-id' }, 2));
  assert.equal(missing.error.code, -32001);
  assert.equal(missing.error.message, 'Task not found.');
  assert.deepEqual(missing.error.data, [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'TASK_NOT_FOUND', domain: 'a2a-protocol.org', metadata: { taskId: 'nonexistent-task-id' } }]);

  const refused = await handle(rpcCall('CancelTask', { id: 'task-uuid' }));
  assert.equal(refused.error.code, -32602);
  assert.equal(refused.error.message, 'This task is already finished at [path]');

  const crash = await handle(rpcCall('elu.crash', {}));
  assert.deepEqual(crash.error, { code: -32603, message: 'Internal error.' });
  assert.equal(JSON.stringify(crash).includes('secret'), false);
  assert.equal(internal.length, 1);

  assert.equal((await handle(rpcCall('ListTasks', {}))).error.code, -32004);
  assert.equal((await handle(rpcCall('SendStreamingMessage', {}))).error.code, -32004);
  assert.equal((await handle(rpcCall('SubscribeToTask', { id: 'task-uuid' }))).error.code, -32004);
  assert.equal((await handle(rpcCall('CreateTaskPushNotificationConfig', {}))).error.code, -32003);
  for (const method of ['message/send', 'constructor', '__proto__', 'toString', 'nope']) assert.equal((await handle(rpcCall(method, {}))).error.code, -32601, method);
  assert.equal((await handle(rpcCall('elu.bad', {}))).result, 'fine');

  assert.deepEqual(await handle({ jsonrpc: '1.0', id: 3, method: 'GetTask' }), { jsonrpc: '2.0', id: 3, error: { code: -32600, message: 'Invalid request.' } });
  assert.equal((await handle({ jsonrpc: '2.0', id: { x: 1 }, method: 'GetTask' })).id, null);
  assert.equal((await handle({ jsonrpc: '2.0', id: 1.5, method: 'GetTask' })).error.code, -32600);
  assert.equal((await handle({ jsonrpc: '2.0', id: 1, method: 7 })).error.code, -32600);
  assert.equal((await handle([rpcCall('GetTask', { id: 'task-uuid' })])).error.code, -32600);
  assert.equal((await handle('nope')).error.code, -32600);
  assert.equal((await handle(rpcCall('GetTask', ['task-uuid']))).error.code, -32602);
  assert.equal((await handle(rpcCall('GetTask', { id: '../x' }))).error.code, -32602);
  assert.equal((await handle(rpcCall('GetTask', { id: 'task-uuid', extra: true }))).result.id, 'task-uuid', 'unknown params are ignored');
  assert.equal((await handle(rpcCall('SendMessage', {}))).error.code, -32602);
  assert.equal((await handle(rpcCall('SendMessage', { message: { ...fixture('spec-6.1-send-message.json').message, role: 'agentish' } }))).error.code, -32602);
  assert.equal((await handle(rpcCall('SendMessage', { ...fixture('spec-6.1-send-message.json'), configuration: { taskPushNotificationConfig: { url: 'https://x' } } }))).error.code, -32003);

  const long = 'x'.repeat(20000);
  const ask = message({ text: long, ext: EXT });
  assert.match((await handle(rpcCall('SendMessage', { message: ask }))).error.message, /at most 16000/);
  const review = message({ text: long, ext: { ...EXT, kind: 'review' } });
  assert.ok((await handle(rpcCall('SendMessage', { message: review }))).result.task);

  assert.equal(await handle({ jsonrpc: '2.0', method: 'elu.status', params: { rows: [] } }), null);
  assert.deepEqual(seen.at(-1), { status: { rows: [] } });
  assert.equal(await handle({ jsonrpc: '2.0', method: 'elu.crash' }), null);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'nope' }), null);
});

test('an invalid handler result becomes an internal error', async () => {
  const internal = [];
  const handle = createRpcHandler({ async GetTask() { return { id: 'x', status: { state: 'done' } }; } }, { onError: (error) => internal.push(error) });
  assert.deepEqual((await handle(rpcCall('GetTask', { id: 'x' }))).error, { code: -32603, message: 'Internal error.' });
  assert.match(internal[0].message, /Task state/);
});

test('buildAgentCard writes a v1.0 card with one JSONRPC interface and a skill per share and teammate', () => {
  const url = 'http://127.0.0.1:4100/a2a';
  const card = buildAgentCard({ name: 'ana', url, shares: [{ handle: 'shop' }, { handle: '../bad' }], teammates: [{ name: 'sara', key: KEY }, { name: 'x/y' }] });
  const sample = fixture('spec-8.5-agent-card.json');
  for (const key of Object.keys(card)) assert.ok(key in sample || key === 'securityRequirements', `unexpected card field ${key}`);
  assert.deepEqual(card.supportedInterfaces, [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
  assert.equal(card.supportedInterfaces[0].protocolBinding, sample.supportedInterfaces[0].protocolBinding);
  assert.deepEqual(card.skills.map((skill) => skill.id), ['project:shop', 'teammate:sara']);
  for (const skill of card.skills) for (const key of ['id', 'name', 'description', 'tags']) assert.ok(skill[key]?.length, `${skill.id} ${key}`);
  assert.deepEqual(card.capabilities.extensions.map((ext) => ext.uri), [PEER_EXT]);
  assert.equal(card.capabilities.streaming, false);
  assert.deepEqual(card.securitySchemes, { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer', description: 'Token from local-a2a.json.' } } });
  assert.deepEqual(card.securityRequirements, [{ schemes: { bearer: { list: [] } } }]);
  assert.match(card.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(buildAgentCard({ url }).skills.map((skill) => skill.id), ['agent']);
  assert.throws(() => buildAgentCard({ url: 'https://example.com/a2a' }), /local endpoint URL/);
});

function stub() {
  const tasks = new Map(), calls = [];
  async function dispatch(method, params, ctx) {
    calls.push({ method, params, ctx });
    if (method === 'SendMessage') {
      const created = task({ contextId: params.message.contextId ?? 'thread-1', ...(ctx.peerName ? { ext: { substate: 'asking', peer: ctx.peerName } } : {}) });
      tasks.set(created.id, created); return created;
    }
    if (!tasks.has(params.id)) throw a2aError(ErrorCode.TASK_NOT_FOUND, 'Task not found.');
    if (method === 'CancelTask') tasks.set(params.id, withState(tasks.get(params.id), TaskState.CANCELED));
    return tasks.get(params.id);
  }
  return { tasks, calls, dispatch };
}
function raw(port, { method = 'POST', target = '/a2a', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)), agent: false }, (res) => {
      answered = true;
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', (error) => { if (!answered) reject(error); });
    if (body !== undefined) req.write(body);
    req.end();
  });
}
async function serverFor(t, options = {}) {
  const dir = home(t), backend = stub();
  const server = await startLocalA2A({ dispatch: backend.dispatch, tokenFile: path.join(dir, 'elu-code/peer/local-a2a.token'), ...options });
  t.after(() => server.close());
  const ok = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' };
  return { dir, server, backend, ok };
}

test('the official @a2a-js/sdk client fetches the card, sends a message and gets the task', async (t) => {
  const { server, backend } = await serverFor(t, { card: ({ url }) => buildAgentCard({ name: 'ana', url, shares: [{ handle: 'shop' }], teammates: [{ name: 'sara' }] }) });
  const { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory, DefaultAgentCardResolver } = await import('@a2a-js/sdk/client');
  const sdk = await import('@a2a-js/sdk');
  const authed = (url, init = {}) => { const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${server.token}`); return fetch(url, { ...init, headers }); };
  const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    transports: [new JsonRpcTransportFactory({ fetchImpl: authed })], cardResolver: new DefaultAgentCardResolver({ fetchImpl: authed }),
  }));
  const client = await factory.createFromUrl(server.url);
  const card = await client.getAgentCard();
  assert.equal(card.name, 'ana');
  assert.equal(card.supportedInterfaces[0].url, `${server.url}/a2a`);
  assert.deepEqual(card.skills.map((skill) => skill.id), ['project:shop', 'teammate:sara']);
  assert.equal(card.capabilities.extensions[0].uri, PEER_EXT);
  assert.equal(card.securitySchemes.bearer.scheme.$case, 'httpAuthSecurityScheme');

  const sent = await client.sendMessage({
    message: { messageId: 'msg-1', contextId: 'thread-1', taskId: '', role: sdk.Role.ROLE_USER, parts: [{ content: { $case: 'text', value: 'Where is checkout?' }, filename: '', mediaType: '' }], extensions: [], referenceTaskIds: [], metadata: { project: 'shop' } },
  });
  assert.equal(sent.status.state, sdk.TaskState.TASK_STATE_SUBMITTED);
  assert.equal(sent.contextId, 'thread-1');
  assert.equal(backend.calls[0].method, 'SendMessage');
  assert.deepEqual(backend.calls[0].ctx, { path: '/a2a', peerName: null, extensions: [] });
  assert.deepEqual(backend.calls[0].params.message, { messageId: 'msg-1', contextId: 'thread-1', role: 'ROLE_USER', parts: [{ text: 'Where is checkout?' }], metadata: { project: 'shop' } });
  assert.equal(backend.calls[0].params.configuration?.returnImmediately ?? false, false);

  const got = await client.getTask({ id: sent.id, tenant: '' });
  assert.equal(got.id, sent.id);
  assert.equal(got.status.state, sdk.TaskState.TASK_STATE_SUBMITTED);
  const canceled = await client.cancelTask({ id: sent.id, tenant: '' });
  assert.equal(canceled.status.state, sdk.TaskState.TASK_STATE_CANCELED);
  await assert.rejects(client.getTask({ id: 'missing', tenant: '' }), (error) => error.name === 'TaskNotFoundError');
  await assert.rejects(client.listTasks({ tenant: '', contextId: '', pageToken: '' }), (error) => error.name === 'UnsupportedOperationError');

  const peerClient = await factory.createFromAgentCard({ ...card, supportedInterfaces: [{ ...card.supportedInterfaces[0], url: `${server.url}/a2a/peer/sara` }] });
  const asked = await peerClient.sendMessage({ message: { messageId: 'msg-2', contextId: '', taskId: '', role: sdk.Role.ROLE_USER, parts: [{ content: { $case: 'text', value: 'Hi Sara' }, filename: '', mediaType: '' }], extensions: [], referenceTaskIds: [] } });
  assert.deepEqual(backend.calls.at(-1).ctx, { path: '/a2a/peer/sara', peerName: 'sara', extensions: [] });
  assert.deepEqual(asked.metadata, { [PEER_EXT]: { substate: 'asking', peer: 'sara' } });
});

test('the local endpoint refuses bad tokens, hosts, origins, sizes and versions', async (t) => {
  const { server, ok, backend } = await serverFor(t);
  const body = JSON.stringify(rpcCall('SendMessage', fixture('spec-6.1-send-message.json')));
  const good = await raw(server.port, { headers: ok, body });
  assert.equal(good.status, 200);
  assert.equal(JSON.parse(good.body).result.task.status.state, 'TASK_STATE_SUBMITTED');
  assert.equal(good.headers['content-type'], 'application/json');
  assert.equal((await raw(server.port, { headers: { ...ok, 'Content-Type': 'application/a2a+json; charset=utf-8' }, body })).status, 200);

  const noToken = await raw(server.port, { headers: { ...ok, Authorization: undefined }, body });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.headers['www-authenticate'], 'Bearer');
  assert.equal((await raw(server.port, { headers: { ...ok, Authorization: `Bearer ${'0'.repeat(64)}` }, body })).status, 401);
  assert.equal((await raw(server.port, { headers: { ...ok, Authorization: server.token }, body })).status, 401);
  assert.equal((await raw(server.port, { method: 'GET', target: '/.well-known/agent-card.json' })).status, 401);

  assert.equal((await raw(server.port, { headers: { ...ok, Host: `evil.example:${server.port}` }, body })).status, 421);
  assert.equal((await raw(server.port, { headers: { ...ok, Host: '127.0.0.1:1' }, body })).status, 421);
  assert.equal((await raw(server.port, { headers: { ...ok, Host: `localhost:${server.port}` }, body })).status, 200);

  assert.equal((await raw(server.port, { headers: { ...ok, Origin: 'https://evil.example' }, body })).status, 403);
  assert.equal((await raw(server.port, { headers: { ...ok, Origin: 'null' }, body })).status, 403);
  assert.equal((await raw(server.port, { method: 'GET', target: '/.well-known/agent-card.json', headers: { Authorization: ok.Authorization, Origin: `http://127.0.0.1:${server.port}` } })).status, 403);

  const before = backend.calls.length;
  const huge = JSON.stringify(rpcCall('SendMessage', { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'x'.repeat(1024 * 1024) }] } }));
  assert.equal((await raw(server.port, { headers: ok, body: huge })).status, 413);
  assert.equal((await raw(server.port, { headers: { ...ok, 'Transfer-Encoding': 'chunked' }, body: huge })).status, 413);
  assert.equal(backend.calls.length, before);

  assert.equal((await raw(server.port, { headers: { ...ok, 'Content-Type': 'text/plain' }, body })).status, 415);
  assert.equal((await raw(server.port, { method: 'GET', headers: ok })).status, 405);
  assert.equal((await raw(server.port, { target: '/a2a/peer/../../x', headers: ok, body })).status, 404);
  assert.equal((await raw(server.port, { target: '/other', headers: ok, body })).status, 404);

  const parse = JSON.parse((await raw(server.port, { headers: ok, body: '{"jsonrpc":' })).body);
  assert.deepEqual(parse, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON payload.' } });
  const noVersion = JSON.parse((await raw(server.port, { headers: { ...ok, 'A2A-Version': undefined }, body })).body);
  assert.equal(noVersion.error.code, -32009);
  assert.equal(noVersion.id, 1);
  assert.equal(JSON.parse((await raw(server.port, { headers: { ...ok, 'A2A-Version': '0.3' }, body })).body).error.code, -32009);
  assert.equal(JSON.parse((await raw(server.port, { headers: { ...ok, 'A2A-Version': '1.0.1' }, body })).body).result.task.id.length > 0, true);
  const notification = await raw(server.port, { headers: ok, body: JSON.stringify({ jsonrpc: '2.0', method: 'GetTask', params: { id: 'x' } }) });
  assert.equal(notification.status, 204);

  const card = await raw(server.port, { method: 'GET', target: '/.well-known/agent-card.json', headers: { Authorization: ok.Authorization } });
  assert.equal(card.status, 200);
  assert.equal(JSON.parse(card.body).supportedInterfaces[0].url, `${server.url}/a2a`);
});

test('the token file and local-a2a.json are private and the state file goes away on close', async (t) => {
  const dir = home(t);
  const tokenFile = path.join(dir, 'elu-code/peer/local-a2a.token');
  const server = await startLocalA2A({ dispatch: stub().dispatch, tokenFile, writeState: true });
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.match(server.token, /^[0-9a-f]{64}$/);
  assert.equal(localToken(tokenFile), server.token);
  const state = path.join(dir, 'elu-code/peer/local-a2a.json');
  assert.equal(fs.statSync(state).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(state, 'utf8')), { port: server.port, token: server.token });
  assert.equal(server.url, `http://127.0.0.1:${server.port}`);
  await server.close();
  assert.equal(fs.existsSync(state), false);

  const again = await startLocalA2A({ dispatch: stub().dispatch, tokenFile });
  assert.equal(again.token, server.token);
  await again.close();

  fs.chmodSync(tokenFile, 0o644);
  await assert.rejects(startLocalA2A({ dispatch: stub().dispatch, tokenFile }), /must be private/);
  fs.chmodSync(tokenFile, 0o600);
  fs.writeFileSync(tokenFile, 'short\n');
  await assert.rejects(startLocalA2A({ dispatch: stub().dispatch, tokenFile }), /not valid/);
  const link = path.join(dir, 'link.token');
  fs.symlinkSync(tokenFile, link);
  await assert.rejects(startLocalA2A({ dispatch: stub().dispatch, tokenFile: link }), /symbolic link/);
  await assert.rejects(startLocalA2A({ dispatch: stub().dispatch, tokenFile, host: '0.0.0.0' }), /only on 127\.0\.0\.1/);
  await assert.rejects(startLocalA2A({ tokenFile }), /dispatch function/);
});
