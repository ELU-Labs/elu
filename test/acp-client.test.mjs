import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAcp } from '../lib/acp-client.mjs';

const SERVER = fileURLToPath(new URL('./fakes/acp-server.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start(t, extra = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-acp-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = await startAcp({ bin: process.execPath, args: [SERVER], cwd: dir, env: process.env, logFile: path.join(dir, 'run.log'), processFile: path.join(dir, 'process.json'), ...extra });
  t.after(() => client.close());
  return { dir, client };
}

test('requests get their replies, notifications arrive, and the server\'s own requests are answered by handlers', async t => {
  const { dir, client } = await start(t);
  assert.ok(client.pid > 0); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'process.json'), 'utf8')).pid, client.pid);
  assert.equal((await client.request('initialize', { protocolVersion: 1 })).protocolVersion, 1);
  assert.equal((await client.request('session/new', { cwd: dir })).sessionId, 'sess-1');
  // Without a handler, a server request is refused as method-not-found; the turn still completes.
  const unhandled = await client.request('session/prompt', { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] });
  assert.equal(unhandled.stopReason, 'end_turn'); assert.equal(unhandled.answered.error.code, -32601);
  const updates = [];
  client.on('session/update', params => { updates.push(params.update.content.text); });
  client.on('session/request_permission', params => ({ outcome: { outcome: 'selected', optionId: params.options.find(option => option.kind === 'reject_once').optionId } }));
  const prompt = await client.request('session/prompt', { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'again' }] });
  assert.deepEqual(prompt.answered, { outcome: { outcome: 'selected', optionId: 'reject' } });
  assert.deepEqual(updates, ['Looking.', 'Writing outside.'], 'notifications before the handler existed were dropped, later ones delivered');
  assert.equal(client.notify('session/cancel', { sessionId: 'sess-1' }), true);
  const echo = await client.request('echo', { a: 1 }); assert.deepEqual(echo.params, { a: 1 }); assert.equal(echo.notifications, 1);
  await assert.rejects(client.request('nope'), error => error.code === -32601);
  await assert.rejects(client.request('slow', {}, { timeoutMs: 100 }), error => error.code === -32002 && /No answer to slow/.test(error.message));
  assert.throws(() => client.request(''), /names its method/); assert.throws(() => client.on('x', null), /needs a method name and a function/);
  const log = fs.readFileSync(path.join(dir, 'run.log'), 'utf8').trim().split('\n');
  assert.ok(log.length >= 8 && log.every(line => JSON.parse(line)), 'every server line is logged');
  const exit = await client.close();
  assert.equal(exit.log, path.join(dir, 'run.log')); assert.equal(exit.stderrFile, path.join(dir, 'run.log.stderr'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'process.json'), 'utf8')).pid, null);
});

test('a server that exits fails the requests in flight and every later one; exit reads like runProcess', async t => {
  const { client } = await start(t);
  const slow = client.request('slow', {}, { timeoutMs: 5000 }), exiting = client.request('exit');
  const exit = await client.exit;
  assert.equal(exit.code, 3); assert.equal(exit.timedOut, false); assert.equal(exit.outputLimit, false);
  await assert.rejects(slow, error => error.code === -32001); await assert.rejects(exiting, error => error.code === -32001);
  await assert.rejects(client.request('echo'), /exited/);
  assert.equal(client.notify('x'), false);
  assert.deepEqual(await client.close(), exit, 'close after exit returns the same result');
});

test('a server that writes nothing for the quiet limit is stopped unless the run is held; one that answers is not', async t => {
  const [silent, held, talking] = await Promise.all([start(t, { quietSeconds: 1, timeoutSeconds: 60 }), start(t, { quietSeconds: 1, hold: () => true }), start(t, { quietSeconds: 2 })]);
  for (let n = 0; n < 6; n++) { await talking.client.request('echo'); await sleep(500); }
  assert.equal((await held.client.request('echo')).notifications, 0, 'a held run keeps running past the quiet limit');
  const exit = await silent.client.exit; assert.equal(exit.timedOut, true); assert.equal(exit.stoppedBy, 'quiet');
  assert.equal((await talking.client.request('echo')).notifications, 0, 'three seconds of replies, each within the quiet limit');
});

test('the time limit kills the server unless the run is held; an abort kills it at once', async t => {
  const [limited, held, aborted] = await Promise.all([
    start(t, { timeoutSeconds: 1 }),
    start(t, { timeoutSeconds: 1, hold: () => true }),
    (async () => { const controller = new AbortController(); const started = await start(t, { signal: controller.signal }); controller.abort(); return started; })(),
  ]);
  const exit = await limited.client.exit; assert.equal(exit.timedOut, true); assert.equal(exit.stoppedBy, 'cap'); assert.equal(exit.signal, 'SIGKILL');
  await sleep(1300);
  assert.equal((await held.client.request('echo')).notifications, 0, 'a held run keeps running past its limit');
  assert.equal((await aborted.client.exit).signal, 'SIGKILL');
  await assert.rejects(startAcp({ bin: process.execPath, args: [SERVER], cwd: limited.dir, env: process.env, logFile: path.join(limited.dir, 'run.log') }), /EEXIST/, 'a log is written once');
  await assert.rejects(startAcp({ bin: '', logFile: path.join(limited.dir, 'other.log') }), /needs a program/);
});
