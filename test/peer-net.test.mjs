import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { newHome, peerHome, withHome, makeTeam, registeredProject, answeringClis, liveTask } from './peer-helpers.mjs';
import { CLI, keyLike } from './helpers.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { defaultBox, savePeerSettings, savePeerPolicy } from '../lib/peer/settings.mjs';
import { createIdentity, identity as loadIdentity } from '../lib/peer/identity.mjs';
import { appendOp, createTeam, head, makeOp, merge, readLog, setChannel, team, teamPath, teams as everyTeam } from '../lib/peer/roster.mjs';
import { createInvite } from '../lib/peer/invite.mjs';
import { share as shareWith, setTeamProject } from '../lib/peer/shares.mjs';
// A share is for the teams it was shared with. These tests share with every team on the
// machine, as /share does, without choosing any team's project.
const share = (root, options = {}) => shareWith(root, { teams: everyTeam().map(state => state.id), ...options });
import { pendingRequests, removeRequest, updateRequest } from '../lib/workspace.mjs';
import { repository } from '../lib/git.mjs';
import { saveTask } from '../lib/state.mjs';
import { saveDefaultMode } from '../lib/modes.mjs';
import { BINDING, ErrorCode, message, peerExt } from '../lib/peer/a2a.mjs';
import { MESSAGES_PER_DAY, count, intakeMethods } from '../lib/peer/intake.mjs';
import { PeerDaemon } from '../lib/peer/daemon.mjs';
import { frames, writeFrame, FRAME_MAX } from '../lib/peer/transport.mjs';
import { Session } from '../lib/peer/rpc.mjs';
import { THREAD_MAX, RETAIN_MS, audit, getRecord, lookup, prune, remember, saveRecord, thread, verifyThread } from '../lib/peer/taskstore.mjs';
import { acceptIncoming, processOutbox, sendReply, syncRecords } from '../lib/peer/replies.mjs';
import { task as a2aTask, TaskState } from '../lib/peer/a2a.mjs';
import { peerDataBlock } from '../lib/peer/peerdata.mjs';
import { peerCli } from '../lib/peer/cli.mjs';
import { RULES_MAX, saveTeamAccess, teamAccess, teammateRules } from '../lib/peer/access.mjs';
import { refuse } from '../lib/util.mjs';
import { BOTS_TOLD, cleanBots, cleanBox, cleanRows, overlaps, statusRows, thisMachine } from '../lib/peer/status.mjs';
import { createAsk, dismissAsk, reconnect, reviewText, teammate, tickAsks, teamAsk, dismissTeam, applyTask, getAsk, asks as allAsks } from '../lib/peer/asks.mjs';
import { RETRY_MS, checkInviterProof, inviteKeys, joinerProof, openInvites, parseInvite, redeemCode } from '../lib/peer/invite.mjs';
import { base32, canonical } from '../lib/peer/canonical.mjs';
import * as peer from '../lib/peer/index.mjs';
import { boardRows } from '../lib/board.mjs';
import { botKey, botVendors, botsFile, canShare, removeBot, saveBot } from '../lib/bots.mjs';
import { dashboardSnapshot } from '../lib/projects.mjs';

// Shaped like an access key, so a reply that holds it is stopped. Joined here, never written whole.
const ACCESS_KEY = keyLike('AKIA', 'ABCDEFGHIJKLMNOP');

const require = createRequire(import.meta.url);
const RUNNER = fileURLToPath(new URL('./peer-runner.mjs', import.meta.url));
const ORIGIN = 'https://github.com/elu-labs/sample.git';

// --- Harness: a local DHT testnet and one daemon process per home. ---
// node:test runs after hooks in the order they were added, so this one stops every
// daemon of the test before the testnet goes away.
const running = new WeakMap();
async function testnet(t, host = '127.0.0.1') {
  const createTestnet = require('hyperdht/testnet.js');
  const net = await createTestnet(3, { host });
  running.set(t, []);
  t.after(async () => {
    await Promise.all(running.get(t).map(stop => stop()));
    await Promise.race([net.destroy(), new Promise(resolve => setTimeout(resolve, 10000))]);
  });
  return net.bootstrap.map(node => `${node.host}:${node.port}`);
}
function enable(home, bootstrap, extra = {}) { withHome(home, () => savePeerSettings({ bootstrap, ...extra })); }
async function daemon(t, home, { env = {}, ...options } = {}) {
  const child = spawn(process.execPath, [RUNNER, JSON.stringify(options)], { env: { ...process.env, ...env, XDG_CONFIG_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stderr.on('data', data => { err += data; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const ready = await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { out += data; const line = out.split('\n').find(row => row.startsWith('{')); if (line) resolve(JSON.parse(line)); });
    child.once('exit', code => reject(new Error(`daemon exited ${code}: ${err}`)));
  });
  if (!ready.ready) throw new Error(ready.error);
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode) return;
    child.stdin.end(); const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    await exited; clearTimeout(timer);
  };
  if (running.has(t)) running.get(t).push(stop); else t.after(stop);
  return { ...ready, child, stop, log: () => err };
}
async function until(check, label, timeout = 90000) {
  const started = Date.now();
  for (;;) {
    let value; try { value = check(); } catch { value = null; }
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}
const read = (home, ...parts) => withHome(home, () => { const file = peerFile(...parts); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; });
const state = home => read(home, 'state.json');
const online = (home, key) => state(home)?.teams?.some(t => t.members.some(m => m.key === key && m.online));
const items = home => withHome(home, () => peer.peerItems());
const item = (home, kind, extra = () => true) => items(home).find(row => row.kind === kind && extra(row));
async function run(home, command, timeout = 90000) {
  const { id } = withHome(home, () => peer.sendPeerCommand(command));
  const result = await until(() => read(home, 'commands', `${id}.result.json`), `${command.type} result`, timeout);
  if (!result.ok) throw new Error(result.error);
  return result.result;
}
const askRecord = (home, id) => read(home, 'asks', `${id}.json`);
const records = home => withHome(home, () => { const dir = peerFile('tasks'); return fs.existsSync(dir) ? fs.readdirSync(dir).map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) : []; });
// Sara answers from a shared project with the fake CLIs; returns what the tests need.
function answering(t, home, { handle = 'app', origin } = {}) {
  const { parent, root } = withHome(home, () => registeredProject(t, { origin }));
  const fake = answeringClis(parent);
  withHome(home, () => share(root, { handle }));
  return { root, fake, env: { PATH: fake.env.PATH } };
}
async function pair(t, options = {}) {
  const bootstrap = await testnet(t), crew = makeTeam(t), ana = crew.founder, sara = crew.member;
  enable(ana.home, bootstrap); enable(sara.home, bootstrap);
  const side = answering(t, sara.home, options);
  return { bootstrap, crew, ana, sara, side };
}
async function connected(a, b) {
  await until(() => online(a.home, b.identity.key) && online(b.home, a.identity.key), 'both daemons online');
}

// --- Unit tests: framing, sessions, audit chain, status rows, service files. ---
test('frames are newline JSON of at most 1 MiB, and a violation closes', () => {
  const stream = new PassThrough(), got = [], bad = [];
  frames(stream, value => got.push(value), reason => bad.push(reason));
  stream.write('{"a":1}\n{"b"'); stream.write(':2}\n\n');
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
  stream.write('x'.repeat(FRAME_MAX + 1));
  assert.deepEqual(bad, ['frame too large']);
  const other = new PassThrough(), reasons = [];
  frames(other, () => {}, reason => reasons.push(reason)); other.write('not json\n');
  assert.deepEqual(reasons, ['invalid JSON']);
  assert.throws(() => writeFrame(new PassThrough(), { text: 'y'.repeat(FRAME_MAX) }), /larger than 1 MiB/);
});

// Two connected fake sockets; writes arrive on the other side on the next turn.
function duplex() {
  const make = () => {
    const side = new EventEmitter(); side.destroyed = false;
    side.write = data => { setImmediate(() => { if (!side.destroyed) side.peer.emit('data', Buffer.from(data)); }); return true; };
    side.destroy = () => { if (side.destroyed) return; side.destroyed = true; side.emit('close'); side.peer.destroy(); };
    return side;
  };
  const left = make(), right = make(); left.peer = right; right.peer = left;
  return [left, right];
}
test('a session needs a hello first, matches responses by id, and times out requests', async () => {
  const [left, right] = duplex(), hello = () => ({ name: 'x', teams: [] });
  const methods = { 'elu.ping': params => ({ pong: params.n }), slow: () => new Promise(() => {}), GetTask: () => null };
  const a = new Session(left, { key: 'b'.repeat(64), hello, admit: () => 'member', methods });
  const b = new Session(right, { key: 'a'.repeat(64), hello, admit: () => 'member', methods });
  await until(() => a.admitted && b.admitted, 'hello exchange', 2000);
  assert.deepEqual(await a.request('elu.ping', { n: 3 }), { pong: 3 });
  await assert.rejects(a.request('slow', {}, { timeoutMs: 50 }), /did not answer in time/);
  await assert.rejects(a.request('SubscribeToTask', { id: 't' }), error => error.details.rpc.code === ErrorCode.UNSUPPORTED_OPERATION);
  await assert.rejects(a.request('GetTask', { id: '../x' }), error => error.details.rpc.code === ErrorCode.INVALID_PARAMS);
  // More than 20 requests in 10 s are refused, and twice that closes the connection.
  const results = await Promise.allSettled(Array.from({ length: 25 }, (_, n) => a.request('elu.ping', { n }, { timeoutMs: 500 })));
  assert.ok(results.some(r => r.status === 'rejected' && /Too many requests/.test(r.reason.message)));
  a.close(); assert.equal(b.state, 'closed');

  const [, early] = duplex();
  const quiet = new Session(early, { key: 'c'.repeat(64), hello, admit: () => 'member' });
  early.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"GetTask","params":{"id":"x"}}\n'));
  assert.equal(quiet.state, 'closed', 'a request before the hello closes');
  const [, silent] = duplex();
  const late = new Session(silent, { key: 'c'.repeat(64), hello, admit: () => 'member', helloMs: 50 });
  await until(() => late.state === 'closed', 'hello deadline', 2000);
  const [, stranger] = duplex();
  const refused = new Session(stranger, { key: 'd'.repeat(64), hello, admit: () => null });
  stranger.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'elu.hello', params: { binding: BINDING, a2aVersion: '1.0', name: 'z', teams: [] } })}\n`));
  assert.equal(refused.state, 'closed', 'a stranger is closed after the hello');
  // A newer 1.x peer gets to admission; another major version is closed with a reason.
  const helloFrame = version => Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'elu.hello', params: { binding: BINDING, a2aVersion: version, name: 'z', teams: [], future: true } })}\n`);
  const [, newer] = duplex(); let asked = false;
  new Session(newer, { key: 'e'.repeat(64), hello, admit: () => { asked = true; return null; } }); newer.emit('data', helloFrame('1.1'));
  assert.ok(asked, 'a 1.1 hello reaches admission');
  const [, major] = duplex(), logs = [];
  const v2 = new Session(major, { key: 'e'.repeat(64), hello, admit: () => 'member', log: text => logs.push(text) }); major.emit('data', helloFrame('2.0'));
  assert.equal(v2.state, 'closed'); assert.match(logs.join('\n'), /unsupported A2A version "2.0"/);
});

test('thread audit lines are hash chained', t => {
  const home = newHome(t);
  withHome(home, () => {
    const id = 'thread-1', key = 'a'.repeat(64);
    audit(id, { dir: 'in', peer: key, kind: 'ask', text: 'Where?' });
    audit(id, { dir: 'out', peer: key, kind: 'answer', text: 'Here.', cost: 0.01 });
    const lines = thread(id);
    assert.equal(lines.length, 2); assert.equal(lines[0].prev, null); assert.equal(lines[1].prev, lines[0].hash);
    assert.ok(verifyThread(lines));
    assert.equal(verifyThread([lines[0], { ...lines[1], text: 'Edited.' }]), false);
    assert.equal(audit('../x', { dir: 'in', peer: key, kind: 'ask', text: 'x' }), null);
    // Lines are appended, the chain holds across a long line, and a full thread stops growing.
    audit(id, { dir: 'in', peer: key, kind: 'ask', text: 'q'.repeat(150000) }); audit(id, { dir: 'out', peer: key, kind: 'answer', text: 'ok' });
    assert.ok(verifyThread(thread(id))); assert.equal(thread(id).length, 4);
    fs.appendFileSync(peerFile('threads', `${id}.jsonl`), 'x'.repeat(THREAD_MAX));
    assert.equal(audit(id, { dir: 'in', peer: key, kind: 'ask', text: 'more' }), null);
    // Old finished records and quiet threads are pruned; open records stay.
    const old = new Date(Date.now() - RETAIN_MS - 60000).toISOString();
    const done = saveRecord({ task: a2aTask({ id: 'done-1', contextId: 'thread-1', state: TaskState.REJECTED, statusMessage: 'no' }), peer: key, threadId: 'thread-1', createdAt: old });
    saveRecord({ task: a2aTask({ id: 'open-1', contextId: 'thread-1' }), peer: key, threadId: 'thread-1', createdAt: old });
    fs.utimesSync(peerFile('threads', `${id}.jsonl`), new Date(old), new Date(old));
    prune();
    assert.deepEqual(fs.readdirSync(peerFile('tasks')), ['open-1.json']); assert.equal(thread(id).length, 0);
    void done;
    // An index entry left by a crash (no record) is repointed by the next save.
    remember(key, 'm-9', 'lost-1'); assert.equal(remember(key, 'm-9', 'open-1', { replace: true }), 'open-1'); assert.equal(lookup(key, 'm-9'), 'open-1');
  });
});

test('a request waiting on a dead conductor starts one', t => {
  const crew = makeTeam(t), sara = crew.member;
  withHome(sara.home, () => {
    const { root } = registeredProject(t); share(root, { handle: 'app' });
    const kicks = [], ctx = { me: loadIdentity(), kick: () => kicks.push(1), event: () => {}, push: () => {} };
    const methods = intakeMethods({ ...ctx, kick: () => {} });
    savePeerPolicy(crew.founder.identity.key, { autoAccept: true });
    methods.SendMessage({ message: message({ text: 'Where?', contextId: 'thread-k', messageId: 'k-1', ext: { kind: 'ask', project: null, hop: 1, from: { key: crew.founder.identity.key, name: 'ana' } } }) }, { key: crew.founder.identity.key });
    syncRecords(ctx); syncRecords(ctx);
    assert.equal(kicks.length, 1, 'once, then throttled');
  });
});

test('status rows from teammates are cleaned and overlap is local', () => {
  const repoId = 'f'.repeat(64);
  const rows = cleanRows([{ repoId, handle: 'app', taskId: '2', label: 'Fix\x1b[31m it\nmore', now: 'running', files: ['src/a.js', '../etc/passwd', '/abs', 'ok/b.js', 'a//b'] }, { repoId: 'bad', handle: 'app', taskId: '1', files: [] }, 'junk']);
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].files, ['src/a.js', 'ok/b.js']); assert.equal(rows[0].label, 'Fix it');
  assert.deepEqual(overlaps([{ repoId, files: ['ok/b.js', 'c.js'] }, { repoId: 'e'.repeat(64), files: ['src/a.js'] }], rows)[0].overlap, ['ok/b.js']);
});

test('a teammate\'s box name and bots are cleaned one field at a time, and the list is cut at 20', () => {
  for (const box of ['ana-mbp', 'Studio.2', '_', 'x'.repeat(32)]) assert.equal(cleanBox(box), box);
  for (const box of ['', 'x'.repeat(33), 'my box', 'a/b', 'a\nb', '\x1b[31mred', 'bøx', 7, true, null, undefined, ['ana'], { name: 'ana' }]) assert.equal(cleanBox(box), null, JSON.stringify(box));
  // A bot is kept with its name and what it is for, and nothing else it was sent with.
  const bots = cleanBots([{ name: 'reviewer', about: 'Reviews a diff.', model: 'large', instructions: 'Never shown.', shared: true }, { name: 'Not A Bot', about: 'x' }, { name: 'ctl', about: ' Reads\x1b[31m the\n  docs\t‮aloud ' },
    { name: 'long', about: `${'x'.repeat(119)} ${'y'.repeat(400)}` }, { name: 'reviewer', about: 'The same name again.' }, { name: 'no-about' }, { name: 'num', about: 7 }, { about: 'No name.' }, { name: ['list'], about: 'x' }, 'junk', null, ['reviewer'], { name: 'empty', about: '' }]);
  assert.deepEqual(bots, [{ name: 'reviewer', about: 'Reviews a diff.' }, { name: 'ctl', about: 'Reads the docs aloud' }, { name: 'long', about: 'x'.repeat(119) }, { name: 'empty', about: '' }]);
  for (const value of [undefined, null, 'reviewer', 7, { name: 'reviewer', about: 'x' }, { 0: { name: 'reviewer', about: 'x' }, length: 1 }]) assert.deepEqual(cleanBots(value), [], JSON.stringify(value));
  const many = Array.from({ length: 30 }, (_, n) => ({ name: `bot-${n}`, about: '' }));
  assert.equal(BOTS_TOLD, 20); assert.deepEqual(cleanBots(many).map(bot => bot.name), many.slice(0, 20).map(bot => bot.name));
  assert.equal(cleanBots([...Array.from({ length: 20 }, () => 'junk'), { name: 'late', about: '' }]).length, 0, 'only the first 20 entries are read');
});

test('the facade loads without the networking packages and writes login services without loading them', t => {
  const script = `await import(${JSON.stringify(new URL('../lib/peer/index.mjs', import.meta.url).href)}); const m = (await import('node:module')).default; console.log(Object.keys(m._cache).filter(k => /hyperswarm|hyperdht|blind-relay/.test(k)).length);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: newHome(t) } });
  assert.equal(r.stdout.trim(), '0', r.stderr);
  const home = newHome(t), calls = [], runner = (bin, args) => calls.push([bin, ...args]);
  withHome(home, () => {
    const mac = peer.installService({ platform: 'darwin', home, run: runner, lasting: true });
    assert.ok(mac.file.endsWith('Library/LaunchAgents/dev.elu-code.peer.plist'));
    const plist = fs.readFileSync(mac.file, 'utf8');
    assert.match(plist, /<string>peer<\/string>\s*<string>--daemon<\/string>/); assert.match(plist, /XDG_CONFIG_HOME/);
    const linux = peer.installService({ platform: 'linux', home, env: { XDG_CONFIG_HOME: home, PATH: '/usr/bin' }, run: runner, lasting: true });
    assert.match(fs.readFileSync(linux.file, 'utf8'), /ExecStart=.*elu-code\.mjs peer --daemon/);
    assert.deepEqual(calls.map(c => c[0]), ['launchctl', 'systemctl', 'systemctl']);
    assert.equal(peer.uninstallService({ platform: 'darwin', home, run: runner }).removed, true);
    assert.equal(fs.existsSync(mac.file), false);
    assert.throws(() => peer.installService({ platform: 'win32', home, run: runner }), /macOS and Linux/);
  });
});

test('intake checks membership, caps and shares, is idempotent, and cancels a waiting request', t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member;
  withHome(sara.home, () => {
    const { root } = registeredProject(t); share(root, { handle: 'app' });
    const events = [], ctx = { me: loadIdentity(), kick: () => events.push('kick'), event: text => events.push(text) };
    const methods = intakeMethods(ctx), session = { key: ana.key };
    const send = (text, extra = {}) => methods.SendMessage({ message: message({ text, contextId: extra.thread ?? 'thread-a', messageId: extra.id, ext: { kind: extra.kind ?? 'ask', project: extra.project ?? null, hop: extra.hop ?? 1, from: { key: ana.key, name: 'ana' } } }) }, session);
    const first = send('Where is it?', { id: 'm-1' });
    assert.equal(first.status.state, 'TASK_STATE_SUBMITTED');
    assert.equal(send('Where is it?', { id: 'm-1' }).id, first.id, 'a resend returns the original task');
    // The message waits with the daemon; the request is queued when the owner decides.
    assert.deepEqual(pendingRequests(root), []); assert.equal(getRecord(first.id).waiting, true);
    acceptIncoming(ctx, first.id, { how: 'answer' });
    const row = pendingRequests(root).find(r => r.origin?.a2aTaskId === first.id);
    assert.equal(row.state, 'queued'); assert.equal(row.origin.threadId, 'thread-a'); assert.equal(row.readOnly, true);
    assert.equal(getRecord(first.id).requestId, row.id); assert.deepEqual(events.at(-1), 'kick');
    const reason = task => task.status.message.parts[0].text;
    assert.match(reason(send('x', { id: 'm-2', project: 'nope' })), /No project named nope/);
    assert.match(reason(send('x', { id: 'm-3', hop: 3 })), /too many agents/);
    assert.match(reason(methods.SendMessage({ message: message({ text: 'x', messageId: 'm-4', ext: { kind: 'ask', from: { key: 'c'.repeat(64), name: 'eve' } } }) }, { key: 'c'.repeat(64) })), /not on a team/);
    assert.throws(() => methods.SendMessage({ message: message({ text: 'x', messageId: 'm-6', ext: { kind: 'ask', from: { key: 'c'.repeat(64), name: 'eve' } } }) }, session), /does not match/);
    savePeerSettings({ caps: { peerRunsPerDay: 1 } }); // m-1 already used today's only run.
    assert.match(reason(send('x', { id: 'm-7', thread: 'thread-b' })), /daily request limit/);
    assert.throws(() => methods.GetTask({ id: first.id }, { key: 'c'.repeat(64) }), error => error.details.rpc.code === ErrorCode.TASK_NOT_FOUND);
    const canceled = methods.CancelTask({ id: first.id }, session);
    assert.equal(canceled.status.state, 'TASK_STATE_CANCELED');
    assert.equal(pendingRequests(root).some(r => r.id === row.id), false, 'the queued request is removed');
    assert.throws(() => methods.CancelTask({ id: first.id }, session), error => error.details.rpc.code === ErrorCode.TASK_NOT_CANCELABLE);
  });
});

test('a question that names no project goes to the project chosen for the team', t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member;
  withHome(sara.home, () => {
    const app = registeredProject(t), docs = registeredProject(t);
    share(app.root, { handle: 'app' }); share(docs.root, { handle: 'docs' });
    const methods = intakeMethods({ me: loadIdentity(), kick: () => {}, event: () => {} }), session = { key: ana.key };
    const send = (id, project = null) => methods.SendMessage({ message: message({ text: 'Where is it?', contextId: `thread-${id}`, messageId: id, ext: { kind: 'ask', project, hop: 1, from: { key: ana.key, name: 'ana' } } }) }, session);
    // Two shares and no choice: the message still arrives, with no project, and waits for the owner.
    const where = task => { const record = getRecord(task.id); return [record.root, record.project]; };
    const unplaced = send('m-1'); assert.equal(unplaced.status.state, 'TASK_STATE_SUBMITTED'); assert.deepEqual(where(unplaced), [null, null]);
    // Joining from the docs folder picks docs for the team (index.share with the team). The
    // project is chosen at intake and kept on the record; the run is queued when the owner decides.
    peer.share(docs.root, { teams: [crew.teamId] });
    const second = send('m-2'); assert.equal(second.status.state, 'TASK_STATE_SUBMITTED');
    assert.deepEqual(where(second), [docs.root, 'docs']);
    const third = send('m-3', 'app'); assert.equal(third.status.state, 'TASK_STATE_SUBMITTED', 'naming a project still reaches it');
    assert.deepEqual(where(third), [app.root, 'app']);
    // /share with no team named moves every team of mine to that project.
    peer.share(app.root);
    assert.deepEqual(where(send('m-4')), [app.root, 'app']);
    acceptIncoming({ me: loadIdentity(), kick: () => {}, event: () => {} }, second.id, { how: 'answer' });
    assert.ok(pendingRequests(docs.root).some(row => row.origin?.threadId === 'thread-m-2'), 'the run is queued in the chosen project');
  });
});

test('a project is asked about only by the teams it is shared with, by name or without one', t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member, bob = withHome(newHome(t), () => createIdentity({ name: 'bob' })), cy = withHome(newHome(t), () => createIdentity({ name: 'cy' }));
  withHome(sara.home, () => {
    // Sara is in two teams: core with Ana, and her own, where Bob is. Each team gets one project.
    const me = loadIdentity(), second = createTeam(me, 'side');
    redeemCode(createInvite(me, second.id, { hours: 1 }), bob.key, 'bob');
    const app = registeredProject(t), docs = registeredProject(t), web = registeredProject(t), old = registeredProject(t), lost = registeredProject(t);
    shareWith(app.root, { handle: 'app', teams: [crew.teamId] }); shareWith(docs.root, { handle: 'docs', teams: [second.id] });
    const methods = intakeMethods({ me, kick: () => {}, event: () => {} });
    let count = 0;
    const send = (from, project = null) => { const id = `two-${++count}`; return methods.SendMessage({ message: message({ text: 'Where is it?', contextId: `thread-${id}`, messageId: id, ext: { kind: 'ask', project, hop: 1, from: { key: from.key, name: from.name } } }) }, { key: from.key }); };
    const reason = task => task.status.message.parts[0].text, where = task => getRecord(task.id).project;
    // By name: each reaches its own team's project, and the other team's reads as not shared.
    assert.equal(where(send(ana, 'app')), 'app'); assert.equal(where(send(bob, 'docs')), 'docs');
    for (const [from, project] of [[ana, 'docs'], [bob, 'app']]) { const refused = send(from, project); assert.equal(refused.status.state, 'TASK_STATE_REJECTED', `${from.name} ${project}`); assert.equal(reason(refused), `No project named ${project} is shared.`); }
    // Without a name: the one project open to the sender, never the other team's.
    assert.equal(where(send(ana)), 'app'); assert.equal(where(send(bob)), 'docs');
    // A second project for core: the list Ana is offered holds her team's projects only.
    shareWith(web.root, { handle: 'web', teams: [crew.teamId] });
    const unplaced = send(ana); assert.equal(unplaced.status.state, 'TASK_STATE_SUBMITTED'); assert.equal(where(unplaced), null, 'two projects and no choice: it arrives with none'); assert.equal(where(send(bob)), 'docs');
    // Sharing a project again with another team adds that team and keeps the first.
    shareWith(web.root, { teams: [second.id] });
    assert.equal(where(send(ana, 'web')), 'web'); assert.equal(where(send(bob, 'web')), 'web');
    // A share saved before teams were kept with it stays open to every team of mine, as it was.
    const file = peerFile('shares.json'), rows = JSON.parse(fs.readFileSync(file, 'utf8')), at = new Date(0).toISOString();
    fs.writeFileSync(file, JSON.stringify([...rows, { handle: 'old', root: old.root, repoId: null, status: true, createdAt: at }, { handle: 'lost', root: lost.root, repoId: null, status: true, createdAt: at }]));
    setTeamProject(crew.teamId, 'old');
    for (const from of [ana, bob]) for (const project of ['old', 'lost']) assert.equal(where(send(from, project)), project, `${from.name} ${project}`);
    assert.equal(where(send(ana)), 'old', 'it is still the project a question without a name goes to');
    // Shared again, it is tied to the teams I am on then and the team named. A team I join
    // later is not one of them; the share that was not shared again is still open to it.
    peer.share(old.root, { teams: [second.id] });
    assert.deepEqual([...peer.shares().find(row => row.handle === 'old').teams].sort(), [crew.teamId, second.id].sort());
    const late = createTeam(me, 'late');
    redeemCode(createInvite(me, late.id, { hours: 1 }), cy.key, 'cy');
    assert.equal(reason(send(cy, 'old')), 'No project named old is shared.'); assert.equal(where(send(cy, 'lost')), 'lost');
    assert.equal(where(send(ana, 'old')), 'old'); assert.equal(where(send(bob, 'old')), 'old');
  });
});

test('a message reaches a teammate who shares no project and waits; y with the open project starts it there; Auto starts it at once; real refusals still refuse', t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member;
  withHome(sara.home, () => {
    const events = [], ctx = { me: loadIdentity(), kick: () => events.push('kick'), event: text => events.push(text), push: () => {} };
    const methods = intakeMethods(ctx), session = { key: ana.key };
    const send = (text, id, extra = {}) => methods.SendMessage({ message: message({ text, contextId: `thread-${id}`, messageId: id, ext: { kind: 'ask', project: extra.project ?? null, hop: 1, from: { key: ana.key, name: 'ana' } } }) }, extra.session ?? session);
    const reason = task => task.status.message.parts[0].text;
    // Sara shares nothing and never set what teammates can do: the message arrives as chat and waits.
    const first = send('testing if you see this message?', 'm-1');
    assert.equal(first.status.state, 'TASK_STATE_SUBMITTED');
    const record = getRecord(first.id);
    assert.equal(record.waiting, true); assert.equal(record.root, null); assert.equal(record.project, null); assert.equal(record.text, 'testing if you see this message?');
    assert.deepEqual(thread('thread-m-1').map(line => [line.dir, line.kind, line.text]), [['in', 'ask', 'testing if you see this message?']]);
    const item = peer.peerItems().find(row => row.taskId === first.id);
    assert.equal(item.kind, 'incoming'); assert.equal(item.text, 'testing if you see this message?'); assert.equal(item.name, 'ana');
    assert.deepEqual(peer.threadMessages('thread-m-1').map(row => [row.from, row.name, row.text]), [['peer', 'ana', 'testing if you see this message?']]);
    // y needs a project: with none it stays waiting; with the one the owner has open it starts there, as his own session.
    assert.throws(() => acceptIncoming(ctx, first.id, { how: 'own' }), /Open ELU Code in the project teammates work in/);
    assert.equal(getRecord(first.id).waiting, true);
    assert.throws(() => acceptIncoming(ctx, first.id, { how: 'own', root: '/nowhere' }), /Open a project of yours/);
    const { root } = registeredProject(t);
    acceptIncoming(ctx, first.id, { how: 'own', root });
    const row = pendingRequests(root).find(r => r.origin?.a2aTaskId === first.id);
    assert.equal(row.state, 'queued'); assert.equal(row.permissions, 'ask'); assert.deepEqual(row.place, { kind: 'worktree' }); assert.equal(row.readOnly, false);
    assert.deepEqual(row.origin, { kind: 'handoff', peer: ana.key, name: 'ana', a2aTaskId: first.id, threadId: 'thread-m-1', hop: 1, own: true });
    assert.equal(getRecord(first.id).root, root);
    // Auto with the project chosen at join, which is not shared: the next message starts at once there.
    saveTeamAccess(crew.teamId, { handling: 'auto', rules: 'Be brief.', root });
    const second = send('and this one?', 'm-2'), auto = getRecord(second.id);
    assert.equal(second.status.state, 'TASK_STATE_SUBMITTED'); assert.equal(auto.waiting, false); assert.equal(auto.root, root); assert.deepEqual(auto.accessTeams, [crew.teamId]);
    const started = pendingRequests(root).find(r => r.id === auto.requestId);
    assert.equal(started.state, 'queued'); assert.deepEqual(started.origin.teams, [crew.teamId]); assert.equal(started.origin.own, true); assert.equal(events.at(-1), 'kick');
    // Manual: it waits, in the same project.
    saveTeamAccess(crew.teamId, { handling: 'manual' });
    const third = getRecord(send('a third', 'm-3').id);
    assert.equal(third.waiting, true); assert.equal(third.requestId, null); assert.equal(third.root, root);
    // The real refusals still refuse.
    assert.match(reason(send('x', 'm-4', { project: 'nope' })), /No project named nope is shared\./);
    assert.match(reason(send('   ', 'm-5')), /The message has no text\./);
    savePeerPolicy(ana.key, { muted: true }); assert.match(reason(send('x', 'm-6')), /not taking requests/); savePeerPolicy(ana.key, { muted: false });
    assert.match(reason(methods.SendMessage({ message: message({ text: 'x', messageId: 'm-7', ext: { kind: 'ask', from: { key: 'c'.repeat(64), name: 'eve' } } }) }, { key: 'c'.repeat(64) })), /not on a team/);
    // A question for a shared bot still needs a project to read.
    saveBot({ name: 'docs', instructions: 'Answer from the docs.', shared: true });
    saveTeamAccess(crew.teamId, { root: null });
    const forBot = methods.SendMessage({ message: message({ text: 'Where are the docs?', contextId: 'thread-b', messageId: 'm-8', ext: { kind: 'ask', bot: 'docs', project: null, hop: 1, from: { key: ana.key, name: 'ana' } } }) }, session);
    assert.equal(reason(forBot), 'There is no project here for that bot to read yet.');
  });
});

test('what teammates can do here is saved per team, checked, and its rules reach the sessions of that team', t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member;
  withHome(sara.home, () => {
    assert.equal(teamAccess(crew.teamId), null, 'never set');
    assert.throws(() => saveTeamAccess(crew.teamId, { handling: 'full' }), /Choose auto or manual\./);
    assert.throws(() => saveTeamAccess(crew.teamId, { rules: 'x'.repeat(RULES_MAX + 1) }), /Keep the rules to 1000 characters\./);
    assert.throws(() => saveTeamAccess(crew.teamId, { folder: '/' }), /Unknown access setting: folder\./);
    assert.throws(() => saveTeamAccess(crew.teamId, { root: path.dirname(os.homedir()) }), /home folder cannot be/);
    assert.throws(() => saveTeamAccess('team', {}), /Choose a team\./);
    assert.equal(teamAccess(crew.teamId), null, 'a refused save writes nothing');
    const saved = saveTeamAccess(crew.teamId, { rules: '  Only work on the elu repo.\r\nDon\'t write anything until I accept it.  ' });
    assert.deepEqual({ ...saved, at: undefined }, { handling: 'auto', rules: 'Only work on the elu repo.\nDon\'t write anything until I accept it.', root: null, at: undefined }, 'Auto is the default');
    assert.equal(saveTeamAccess(crew.teamId, { handling: 'manual' }).rules, saved.rules, 'what is not given is kept');
    assert.equal(teammateRules({ peer: ana.key, team: crew.teamId }), saved.rules);
    assert.equal(teammateRules({ peer: ana.key }), saved.rules, 'a session from before teams were named gets the rules of the teams the teammate is on');
    assert.equal(teammateRules({ peer: 'c'.repeat(64) }), '', 'someone on none of my teams gets none');
    assert.equal(teammateRules({ peer: ana.key, team: 'd'.repeat(64) }), '');
    assert.equal(teammateRules({ peer: ana.key, teams: ['d'.repeat(64)] }), '');
    // A session names every team of its project, and gets the rules of all of them.
    const me = loadIdentity(), side = createTeam(me, 'side');
    saveTeamAccess(side.id, { rules: 'Never touch billing.' });
    assert.equal(teammateRules({ peer: ana.key, teams: [crew.teamId, side.id] }), `${saved.rules}\n\nNever touch billing.`);
  });
});

test('the setting comes from the project a message runs in, never from the room the sender picks; a team ask never starts a session by itself', t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member, bob = withHome(newHome(t), () => createIdentity({ name: 'bob' }));
  withHome(sara.home, () => {
    // Sara and Ana are on core (Auto, project x, no rules) and side (Manual, project y, rules); Bob is on side too.
    const me = loadIdentity(), side = createTeam(me, 'side');
    redeemCode(createInvite(me, side.id, { hours: 1 }), ana.key, 'ana'); redeemCode(createInvite(me, side.id, { hours: 1 }), bob.key, 'bob');
    const x = registeredProject(t), y = registeredProject(t), other = registeredProject(t);
    shareWith(y.root, { handle: 'why', teams: [side.id] }); shareWith(other.root, { handle: 'other', teams: [crew.teamId] });
    saveTeamAccess(crew.teamId, { handling: 'auto', root: x.root });
    saveTeamAccess(side.id, { handling: 'manual', rules: 'Side rules.', root: y.root });
    const ctx = { me, kick: () => {}, event: () => {}, push: () => {} }, methods = intakeMethods(ctx);
    let n = 0;
    const send = (ext, from = ana) => { const id = `room-${++n}`; return getRecord(methods.SendMessage({ message: message({ text: 'Please change it.', contextId: `thread-${id}`, messageId: id, ext: { kind: 'ask', project: null, hop: 1, from: { key: from.key, name: from.name }, ...ext } }) }, { key: from.key }).id); };
    // The room says core, the project is side's: side's Manual and side's rules decide.
    const picked = send({ project: 'why', room: { team: crew.teamId, channel: null } });
    assert.equal(picked.root, y.root); assert.equal(picked.waiting, true); assert.equal(picked.requestId, null); assert.deepEqual(picked.accessTeams, [side.id]);
    acceptIncoming(ctx, picked.task.id, { how: 'own' });
    const row = pendingRequests(y.root).find(r => r.origin?.a2aTaskId === picked.task.id);
    assert.deepEqual(row.origin.teams, [side.id]); assert.equal(teammateRules(row.origin), 'Side rules.');
    // With one team too: a shared project that is not the one core's setting names waits.
    const elsewhere = send({ project: 'other' });
    assert.equal(elsewhere.root, other.root); assert.equal(elsewhere.waiting, true); assert.deepEqual(elsewhere.accessTeams, [crew.teamId]);
    // No project named: core's own project, in Auto.
    const plain = send({ room: { team: crew.teamId, channel: null } });
    assert.equal(plain.root, x.root); assert.equal(plain.waiting, false); assert.ok(plain.requestId);
    // A team ask to #general of a three-member team set to Auto waits on every machine.
    saveTeamAccess(side.id, { handling: 'auto', root: y.root });
    const group = send({ team: true, room: { team: side.id, channel: null } });
    assert.equal(group.root, y.root); assert.equal(group.team, true); assert.equal(group.waiting, true); assert.equal(group.requestId, null);
    // The same message to Sara alone starts at once.
    assert.equal(send({ room: { team: side.id, channel: null }, project: 'why' }).waiting, false);
  });
});

test('elu invite never turns Auto on for a team that already has members; a new team gets Auto unless --manual', async t => {
  const crew = makeTeam(t), ana = crew.founder;
  await withHome(ana.home, async () => {
    const { root } = registeredProject(t);
    const existing = await peerCli(['invite'], { project: root });
    assert.equal(teamAccess(crew.teamId).handling, 'manual', 'Sara is already on it');
    assert.ok(existing.lines.includes('Manual: each message waits for you to approve it.'), existing.lines.join('\n'));
    // A later invite keeps the setting; --auto through elu access is how it changes.
    await peerCli(['invite'], { project: root, auto: true });
    assert.equal(teamAccess(crew.teamId).handling, 'manual', 'only the first invite sets it');
    const me = loadIdentity(), fresh = createTeam(me, 'fresh');
    await peerCli(['invite'], { team: fresh.id, project: root });
    assert.equal(teamAccess(fresh.id).handling, 'auto');
  });
});

test('elu access shows and changes what teammates can do here; --auto with --manual is refused', async t => {
  const crew = makeTeam(t), sara = crew.member;
  await withHome(sara.home, async () => {
    const { root } = registeredProject(t);
    const unset = await peerCli(['access'], {});
    assert.equal(unset.access, null); assert.match(unset.lines[0], /core: not set\. Messages wait for you to approve them\./);
    await assert.rejects(peerCli(['access'], { auto: true, manual: true }), /Choose --auto or --manual\./);
    const saved = await peerCli(['access'], { manual: true, rules: 'Only answer questions, do not edit files.', project: root });
    assert.equal(saved.message, 'Saved what teammates can do here.');
    assert.deepEqual(saved.lines, ['core', '  Manual: each message waits for you to approve it.', '  Rules: Only answer questions, do not edit files.', `  Project: ${root}`]);
    const auto = await peerCli(['access'], { auto: true });
    assert.equal(auto.access.handling, 'auto'); assert.equal(auto.access.rules, 'Only answer questions, do not edit files.'); assert.equal(auto.access.root, root);
  });
});

test('a sender whose teammate runs an ELU Code that refuses messages without a shared project is told to have them update', t => {
  const crew = makeTeam(t), ana = crew.founder;
  withHome(ana.home, () => {
    const ctx = { me: loadIdentity(), event: () => {}, kick: () => {}, dial: () => {}, session: () => null };
    const ask = createAsk(ctx, { to: 'sara', text: 'testing if you see this message?', byOwner: true });
    applyTask(ctx, crew.member.identity.key, a2aTask({ id: 'old-1', contextId: ask.threadId, state: TaskState.REJECTED, statusMessage: 'They have not shared a project, so there is nothing of theirs to ask about yet.' }), ask.id);
    assert.equal(getAsk(ask.id).state, 'rejected');
    assert.equal(getAsk(ask.id).reason, '@sara needs to update ELU Code to get messages: their version takes them only when they share a project.');
    const other = createAsk(ctx, { to: 'sara', text: 'and this?', byOwner: true });
    applyTask(ctx, crew.member.identity.key, a2aTask({ id: 'old-2', contextId: other.threadId, state: TaskState.REJECTED, statusMessage: 'This teammate is not taking requests from you.' }), other.id);
    assert.equal(getAsk(other.id).reason, 'This teammate is not taking requests from you.', 'other refusals are shown as they are');
  });
});

test('a project\'s name and its live status go only to teammates on a team it is shared with', async t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member, bob = withHome(newHome(t), () => createIdentity({ name: 'bob' }));
  await withHome(sara.home, async () => {
    const me = loadIdentity(), second = createTeam(me, 'side');
    redeemCode(createInvite(me, second.id, { hours: 1 }), bob.key, 'bob');
    const app = registeredProject(t), docs = registeredProject(t), old = registeredProject(t);
    shareWith(app.root, { handle: 'app', teams: [crew.teamId] }); shareWith(docs.root, { handle: 'docs', teams: [second.id] });
    const daemon = Object.assign(new PeerDaemon({ conductor: () => {} }), { me, methods: {} });
    const row = handle => ({ repoId: null, handle, taskId: '1', label: `Work in ${handle}`, now: 'ready', files: [`${handle}.txt`] });
    daemon.rows = ['app', 'docs'].map(row);
    // A fake socket for each teammate: what the daemon writes to one collects apart from the other.
    const connect = (who, teamId) => {
      const wire = { out: '' }, socket = Object.assign(new EventEmitter(), { destroyed: false, write: chunk => { wire.out += chunk; return true; }, destroy() { this.destroyed = true; this.emit('close'); } });
      daemon.attach(socket, who.key);
      socket.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'elu.hello', params: { binding: BINDING, a2aVersion: '1.0', name: who.name, teams: [{ id: teamId, ...head(teamId), ops: [] }], handles: [] } })}\n`));
      assert.equal(daemon.sessions.get(who.key)?.admitted, true, who.name);
      const frames = method => wire.out.split('\n').flatMap(line => { try { const frame = JSON.parse(line); return frame.method === method ? [frame.params] : []; } catch { return []; } });
      return { handles: () => frames('elu.hello')[0].handles, rows: () => frames('elu.status').at(-1).rows.map(told => told.handle) };
    };
    const toAna = connect(ana, crew.teamId), toBob = connect(bob, second.id);
    assert.deepEqual([toAna.handles(), toAna.rows()], [['app'], ['app']]);
    assert.deepEqual([toBob.handles(), toBob.rows()], [['docs'], ['docs']]);
    // Shared with the second team as well, the project's rows go to both.
    shareWith(app.root, { teams: [second.id] }); daemon.announce();
    assert.deepEqual([toAna.rows(), toBob.rows()], [['app'], ['app', 'docs']]);
    // A share saved before teams were kept with it is open to every team of mine.
    const file = peerFile('shares.json');
    fs.writeFileSync(file, JSON.stringify([...JSON.parse(fs.readFileSync(file, 'utf8')), { handle: 'old', root: old.root, repoId: null, status: true, createdAt: new Date(0).toISOString() }]));
    daemon.rows = ['app', 'docs', 'old'].map(row); daemon.announce();
    assert.deepEqual([toAna.rows(), toBob.rows()], [['app', 'old'], ['app', 'docs', 'old']]);
    assert.deepEqual([daemon.hello(ana.key).handles, daemon.hello(bob.key).handles], [['app', 'old'], ['docs', 'app', 'old']]);
    // Someone who is not on my roster gets no names, and a shares file that cannot be read shares none.
    assert.deepEqual(daemon.hello('f'.repeat(64)).handles, []);
    fs.writeFileSync(file, '{'); daemon.announce();
    assert.deepEqual([daemon.hello(ana.key).handles, toAna.rows(), toBob.rows()], [[], [], []]);
  });
});

// A fake socket that collects what the daemon writes, and says frames back to it.
function fakeSocket() {
  const wire = { out: '' }, socket = Object.assign(new EventEmitter(), { destroyed: false, write: chunk => { wire.out += chunk; return true; }, destroy() { this.destroyed = true; this.emit('close'); } });
  return { socket, wire, frames: () => wire.out.split('\n').filter(Boolean).map(line => JSON.parse(line)), say: value => socket.emit('data', Buffer.from(`${JSON.stringify(value)}\n`)) };
}
const NOBODY = { name: '', teams: [], handles: [], plans: true };

test('a hello names only the teams its receiver is on, and a stranger or a removed teammate gets no team and no name', async t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member, bob = withHome(newHome(t), () => createIdentity({ name: 'bob' }));
  await withHome(sara.home, async () => {
    const me = loadIdentity(), second = createTeam(me, 'side');
    redeemCode(createInvite(me, second.id, { hours: 1 }), bob.key, 'bob');
    const daemon = Object.assign(new PeerDaemon({ conductor: () => {} }), { me, methods: {} });
    // Each teammate hears my name and only the team we share, with the ops that admit me there.
    const toAna = daemon.hello(ana.key), toBob = daemon.hello(bob.key);
    assert.deepEqual([toAna.name, toAna.teams.map(row => row.id), toBob.name, toBob.teams.map(row => row.id)], ['sara', [crew.teamId], 'sara', [second.id]]);
    assert.ok(toAna.teams[0].ops.length && toAna.teams[0].ops.every(op => op.teamId === crew.teamId));
    for (const word of [second.id, '"side"', bob.key, '"bob"']) assert.equal(JSON.stringify(toAna).includes(word), false, `ana is told ${word}`);
    for (const word of [crew.teamId, '"core"', ana.key, '"ana"']) assert.equal(JSON.stringify(toBob).includes(word), false, `bob is told ${word}`);
    // A key on none of my teams is told nothing about them, and on the wire gets that hello alone before it is closed.
    assert.deepEqual(daemon.hello('f'.repeat(64)), NOBODY);
    const stranger = fakeSocket();
    daemon.attach(stranger.socket, 'f'.repeat(64));
    stranger.say({ jsonrpc: '2.0', method: 'elu.hello', params: { binding: BINDING, a2aVersion: '1.0', name: 'zed', teams: [], handles: [] } });
    assert.equal(stranger.socket.destroyed, true, 'the stranger is closed');
    assert.deepEqual(stranger.frames(), [{ jsonrpc: '2.0', method: 'elu.hello', params: { binding: BINDING, a2aVersion: '1.0', ...NOBODY } }]);
    // Removed from the one team we shared, bob is told nothing either.
    appendOp(second.id, makeOp(me, second.id, 'remove', { key: bob.key }));
    assert.deepEqual(daemon.hello(bob.key), NOBODY);
  });
});

// A long code as 0.1.3 made it, with its row in the inviter's invites.json (the active home's).
function longInvite(me, teamId) {
  const secret = crypto.randomBytes(32).toString('hex'), expiresAt = Date.now() + 3600 * 1000, file = teamPath(teamId, 'invites.json');
  const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  fs.writeFileSync(file, JSON.stringify([...rows, { hash: crypto.createHash('sha256').update(secret).digest('hex'), expiresAt, usedBy: null }]));
  return { secret, code: `elu-team:v1:${base32(Buffer.from(canonical({ teamId, inviter: me.key, secret, expiresAt })))}` };
}
// An inviter's daemon with fake sockets: no network, and every connection is one the test speaks for.
function inviterDaemon(me) {
  const topics = [];
  const daemon = Object.assign(new PeerDaemon({ conductor: () => {} }), { me, node: { dial() {}, leave() {}, joinTopic: topic => topics.push(`+${topic}`), leaveTopic: topic => topics.push(`-${topic}`) } });
  daemon.methods = daemon.extensions();
  return { daemon, topics };
}
const hi = { jsonrpc: '2.0', method: 'elu.hello', params: { binding: BINDING, a2aVersion: '1.0', ...NOBODY } };
// One side of an invite exchange: the joiner's half, spoken through a fake socket.
async function startInvite(daemon, key, topic) {
  const joiner = fakeSocket(), joinerNonce = crypto.randomBytes(32).toString('hex');
  daemon.attach(joiner.socket, key); joiner.say(hi);
  joiner.say({ jsonrpc: '2.0', id: 1, method: 'elu.invite.start', params: { topic, nonce: joinerNonce } });
  // A reply, not a request of the inviter's with the same id (it has its own once I am a member there).
  const reply = await until(() => joiner.frames().find(frame => frame.id === 1 && !Object.hasOwn(frame, 'method')), 'the start reply', 5000);
  return { joiner, reply, fields: { topic, joinerNonce, inviterNonce: reply.result?.nonce, inviter: daemon.me.key, joiner: key } };
}

test('a long code from 0.1.3 joins over the wire: the joiner is told no team before elu.join, and gets the whole roster in its reply', async t => {
  const anaHome = newHome(t), liHome = newHome(t), li = withHome(liHome, () => createIdentity({ name: 'li' }));
  const { teamId, ops } = await withHome(anaHome, async () => {
    const me = createIdentity({ name: 'ana' }), made = createTeam(me, 'core'); createTeam(me, 'side');
    const { secret } = longInvite(me, made.id);
    const { daemon } = inviterDaemon(me);
    const joiner = fakeSocket();
    daemon.attach(joiner.socket, li.key);
    assert.deepEqual(joiner.frames()[0].params, { binding: BINDING, a2aVersion: '1.0', ...NOBODY });
    joiner.say(hi);
    joiner.say({ jsonrpc: '2.0', id: 1, method: 'elu.join', params: { teamId: made.id, secret, name: 'li' } });
    const reply = await until(() => joiner.frames().find(frame => frame.id === 1), 'the join reply', 5000);
    await until(() => daemon.sessions.get(li.key)?.admitted, 'the joiner admitted', 5000);
    await new Promise(resolve => setImmediate(resolve));
    joiner.socket.destroy();
    // The other team never went out, before the join or after it.
    assert.equal(joiner.wire.out.includes('"side"'), false);
    return { teamId: made.id, ops: reply.result.ops };
  });
  withHome(liHome, () => {
    assert.deepEqual(merge(teamId, ops).rejected, []);
    assert.deepEqual(team(teamId).members.map(m => m.name), ['ana', 'li']);
  });
});

test('a short code over the wire: the inviter announces its topic, proves itself first, names the team only after the joiner\'s proof, and leaves the topic once its joiner can no longer come back', async t => {
  const anaHome = newHome(t), liHome = newHome(t), li = withHome(liHome, () => createIdentity({ name: 'li' }));
  const { teamId, ops } = await withHome(anaHome, async () => {
    const me = createIdentity({ name: 'ana' }), made = createTeam(me, 'core'); createTeam(me, 'side');
    const code = createInvite(me, made.id, { hours: 1 }), keys = inviteKeys(code);
    const { daemon, topics } = inviterDaemon(me);
    daemon.inviteTopics(); daemon.inviteTopics();
    assert.deepEqual(topics, [`+${keys.topic}`], 'announced once');
    const { joiner, reply, fields } = await startInvite(daemon, li.key, keys.topic);
    assert.ok(checkInviterProof(keys.prover, fields, reply.result.proof), 'the inviter proves it knows the code');
    // Nothing about the team has gone out yet.
    for (const word of [made.id, '"core"', '"side"', '"ana"']) assert.equal(joiner.wire.out.includes(word), false, word);
    joiner.say({ jsonrpc: '2.0', id: 2, method: 'elu.invite.prove', params: { proof: joinerProof(keys.seed, fields), name: 'li' } });
    const proved = await until(() => joiner.frames().find(frame => frame.id === 2), 'the prove reply', 5000);
    assert.equal(proved.result.teamId, made.id); assert.equal(proved.result.inviter, me.key);
    await until(() => daemon.sessions.get(li.key)?.admitted, 'the joiner admitted', 5000);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(topics, [`+${keys.topic}`], 'still announced, in case the reply was lost');
    assert.deepEqual(openInvites([made.id]), []);
    daemon.inviteTopics(Date.now() + RETRY_MS + 1000);
    assert.deepEqual(topics, [`+${keys.topic}`, `-${keys.topic}`], 'the used invite\'s topic is left');
    joiner.socket.destroy();
    assert.equal(joiner.wire.out.includes('"side"'), false);
    return { teamId: made.id, ops: proved.result.ops };
  });
  withHome(liHome, () => {
    assert.deepEqual(merge(teamId, ops).rejected, []);
    assert.deepEqual(team(teamId).members.map(m => m.name), ['ana', 'li']);
  });
});

test('a short invite refuses whoever cannot prove the code: a wrong code, a relay, a replay, a proof before the start, elu.join, and too many failures from one key', async t => {
  peerHome(t);
  const me = createIdentity({ name: 'ana' }), made = createTeam(me, 'core');
  const code = createInvite(me, made.id, { hours: 1 }), keys = inviteKeys(code), wrong = inviteKeys('k7qm-x2pd-9fhw');
  const { daemon } = inviterDaemon(me);
  const someone = () => withHome(newHome(t), () => createIdentity({ name: 'x' }).key);
  const refused = async (joiner, id, pattern) => {
    const frame = await until(() => joiner.frames().find(row => row.id === id), `reply ${id}`, 5000);
    assert.match(frame.error?.message ?? '', pattern); await until(() => joiner.socket.destroyed, 'closed', 5000);
  };
  const prove = (joiner, fields, seed) => joiner.say({ jsonrpc: '2.0', id: 2, method: 'elu.invite.prove', params: { proof: joinerProof(seed, fields), name: 'eve' } });
  // Someone who found the topic but has the wrong code: the start is answered, the proof is not.
  const eve = someone(), first = await startInvite(daemon, eve, keys.topic);
  assert.equal(checkInviterProof(wrong.prover, first.fields, first.reply.result.proof), false, 'the inviter proof is no help without the code');
  prove(first.joiner, first.fields, wrong.seed); await refused(first.joiner, 2, /proof did not match/);
  // A relay that passes along a proof the real joiner made for its connection to the relay.
  const kim = someone(), relay = someone(), leg = await startInvite(daemon, relay, keys.topic);
  prove(leg.joiner, { ...leg.fields, inviter: relay, joiner: kim }, keys.seed); await refused(leg.joiner, 2, /proof did not match/);
  // A proof replayed on a new connection: the inviter's nonce is new.
  const dan = someone(), once = await startInvite(daemon, dan, keys.topic);
  const replay = await startInvite(daemon, dan, keys.topic);
  replay.joiner.say({ jsonrpc: '2.0', id: 2, method: 'elu.invite.prove', params: { proof: joinerProof(keys.seed, once.fields), name: 'dan' } }); await refused(replay.joiner, 2, /proof did not match/);
  // A proof with no start, and a short invite's keys sent through elu.join.
  for (const frame of [{ method: 'elu.invite.prove', params: { proof: '0'.repeat(128), name: 'x' } }, { method: 'elu.join', params: { teamId: made.id, secret: keys.verifier, name: 'x' } }]) {
    const joiner = fakeSocket(); daemon.attach(joiner.socket, someone()); joiner.say(hi);
    joiner.say({ jsonrpc: '2.0', id: 9, ...frame });
    await until(() => joiner.socket.destroyed, `${frame.method} closed`, 5000);
  }
  // An unknown or malformed topic is refused and closed, and does not count.
  const bob = someone();
  for (const topic of [wrong.topic, wrong.topic, wrong.topic, wrong.topic, 'nope']) { const { joiner, reply } = await startInvite(daemon, bob, topic); assert.match(reply.error.message, /not valid/); await until(() => joiner.socket.destroyed, 'closed', 5000); }
  assert.equal(daemon.proofFails.has(bob), false);
  // Failed proofs on a known topic do: a key with three gets no more answers, even with the right code.
  for (let i = 0; i < 3; i++) { const next = await startInvite(daemon, bob, keys.topic); prove(next.joiner, next.fields, wrong.seed); await refused(next.joiner, 2, /proof did not match/); }
  const blocked = await startInvite(daemon, bob, keys.topic); assert.match(blocked.reply.error.message, /Too many failed invite attempts/);
  // Failures from many keys lock nobody else out: eleven throwaway keys fail three times each.
  await Promise.all(Array.from({ length: 11 }, async () => {
    const key = someone();
    for (let i = 0; i < 3; i++) { const next = await startInvite(daemon, key, keys.topic); prove(next.joiner, next.fields, wrong.seed); await refused(next.joiner, 2, /proof did not match/); }
  }));
  assert.ok([...daemon.proofFails.values()].reduce((sum, times) => sum + times.length, 0) >= 33);
  // None of it used the invite, and nobody was admitted.
  assert.equal(openInvites([made.id]).length, 1); assert.deepEqual(team(made.id).members.map(m => m.name), ['ana']);
  assert.equal(daemon.sessions.size, 0);
  // The real joiner still gets in.
  const li = someone(), real = await startInvite(daemon, li, keys.topic);
  real.joiner.say({ jsonrpc: '2.0', id: 2, method: 'elu.invite.prove', params: { proof: joinerProof(keys.seed, real.fields), name: 'li' } });
  await until(() => daemon.sessions.get(li)?.admitted, 'li admitted', 5000);
  assert.deepEqual(team(made.id).members.map(m => m.name), ['ana', 'li']);
});

test('a joiner whose reply was lost comes back with the same code and gets the same admit; nobody else can, and not after the retry window', async t => {
  const anaHome = newHome(t), li = withHome(newHome(t), () => createIdentity({ name: 'li' })), kim = withHome(newHome(t), () => createIdentity({ name: 'kim' }));
  await withHome(anaHome, async () => {
    const me = createIdentity({ name: 'ana' }), made = createTeam(me, 'core');
    const code = createInvite(me, made.id, { hours: 1 }), keys = inviteKeys(code);
    const { daemon, topics } = inviterDaemon(me);
    daemon.inviteTopics();
    const exchange = async key => {
      const { joiner, reply, fields } = await startInvite(daemon, key, keys.topic);
      if (reply.error) return { joiner, error: reply.error.message };
      assert.ok(checkInviterProof(keys.prover, fields, reply.result.proof));
      joiner.say({ jsonrpc: '2.0', id: 2, method: 'elu.invite.prove', params: { proof: joinerProof(keys.seed, fields), name: key === li.key ? 'li' : 'kim' } });
      const proved = await until(() => joiner.frames().find(frame => frame.id === 2 && !Object.hasOwn(frame, 'method')), 'the prove reply', 5000);
      return { joiner, result: proved.result, error: proved.error?.message };
    };
    // The first exchange admits li; the connection drops before li reads the reply.
    const first = await exchange(li.key); first.joiner.socket.destroy();
    const admits = () => readLog(made.id).ops.filter(op => op.type === 'admit');
    assert.equal(admits().length, 1);
    // li comes back on a new connection, now as a member here, and gets the same op and the roster.
    const again = await exchange(li.key);
    assert.equal(again.error, undefined); assert.equal(again.result.teamId, made.id);
    assert.deepEqual(again.result.ops.filter(op => op.type === 'admit'), admits()); assert.equal(admits().length, 1);
    again.joiner.socket.destroy();
    // With no invite open, a stranger is closed at the hello.
    const stranger = fakeSocket(); daemon.attach(stranger.socket, kim.key); stranger.say(hi);
    await until(() => stranger.socket.destroyed, 'a stranger closed', 5000);
    // With another invite open, someone else with the used code is told so, and that is not a failed proof.
    const next = inviteKeys(createInvite(me, made.id, { hours: 1 }));
    const other = await exchange(kim.key);
    assert.match(other.error, /already used/); assert.equal(daemon.proofFails.has(kim.key), false);
    assert.deepEqual(topics, [`+${keys.topic}`], 'still announced for the retry window');
    // After the window the topic is left and li's start finds nothing.
    const file = teamPath(made.id, 'invites.json'), rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify(rows.map(row => row.usedBy ? { ...row, usedAt: new Date(Date.now() - RETRY_MS - 1000).toISOString() } : row)));
    daemon.inviteTopics(); assert.deepEqual(topics, [`+${keys.topic}`, `+${next.topic}`, `-${keys.topic}`]);
    const late = await exchange(li.key); assert.match(late.error, /not valid/); late.joiner.socket.destroy();
  });
});

test('an expired short invite is no longer announced, and its topic is left', async t => {
  peerHome(t);
  const me = createIdentity({ name: 'ana' }), made = createTeam(me, 'core'), keys = inviteKeys(createInvite(me, made.id, { hours: 1 }));
  const { daemon, topics } = inviterDaemon(me);
  daemon.inviteTopics(); daemon.inviteTopics(Date.now() + 2 * 3600 * 1000);
  assert.deepEqual(topics, [`+${keys.topic}`, `-${keys.topic}`]);
});

test('a team ask goes to every teammate as one thread; the first to take it answers and the other copies are withdrawn', t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member.identity, li = withHome(newHome(t), () => createIdentity({ name: 'li' }));
  withHome(crew.founder.home, () => {
    redeemCode(createInvite(ana, crew.teamId, { hours: 1 }), li.key, 'li');
    const events = [], ctx = { me: loadIdentity(), session: () => null, dial: () => {}, event: text => events.push(text), kick: () => {} };
    const sent = teamAsk(ctx, { text: 'Where does the parser trim a coupon code?' });
    assert.deepEqual(sent.map(ask => ask.to).sort(), [sara.key, li.key].sort());
    assert.equal(new Set(sent.map(ask => ask.group)).size, 1); assert.equal(new Set(sent.map(ask => ask.threadId)).size, 1);
    assert.deepEqual(events, ['ask to the team (2)'], 'one event, not one per teammate');
    const team = () => peer.peerItems().filter(item => item.kind !== 'incoming');
    assert.deepEqual(team().map(item => [item.kind, item.name, item.team, item.state]), [['asked', 'team', true, 'pending']], 'one thread for the team');
    const [toSara, toLi] = [sara, li].map(member => sent.find(ask => ask.to === member.key));
    const reply = (state, id) => a2aTask({ id, contextId: toSara.threadId, state });
    applyTask(ctx, sara.key, reply(TaskState.SUBMITTED, 'task-sara'), toSara.id); applyTask(ctx, li.key, reply(TaskState.SUBMITTED, 'task-li'), toLi.id);
    assert.deepEqual(team().map(item => [item.kind, item.state]), [['asked', 'submitted']]);
    // Sara's agent starts on it: she took it, and Li's copy is withdrawn with a cancel to send.
    applyTask(ctx, sara.key, reply(TaskState.WORKING, 'task-sara'));
    assert.equal(getAsk(toSara.id).state, 'working');
    assert.deepEqual((({ state, cancel, dismissed, reason }) => ({ state, cancel, dismissed, reason }))(getAsk(toLi.id)), { state: 'canceled', cancel: true, dismissed: true, reason: '@sara took it.' });
    assert.ok(events.includes('@sara took the team ask'));
    assert.deepEqual(team().map(item => [item.kind, item.name, item.peer]), [['asked', 'sara', sara.key]], 'now the thread is Sara\'s');
    applyTask(ctx, li.key, reply(TaskState.WORKING, 'task-li'));
    assert.equal(getAsk(toLi.id).state, 'canceled', 'a late start on a withdrawn copy changes nothing');
    // Nobody takes a second one: dismissing it withdraws every copy.
    const second = teamAsk(ctx, { text: 'Which schema version?' });
    dismissTeam(ctx, second[0].group);
    assert.ok(second.every(ask => getAsk(ask.id).dismissed && getAsk(ask.id).state === 'canceled'));
    assert.ok(!peer.peerItems().some(item => item.id === `team:${second[0].group}`));
    // All copies refused: one rejected thread with a reason.
    const third = teamAsk(ctx, { text: 'Who owns the deploy?' });
    for (const ask of third) applyTask(ctx, ask.to, a2aTask({ id: `r-${ask.to.slice(0, 6)}`, contextId: ask.threadId, state: TaskState.REJECTED, statusMessage: 'No project is shared.' }), ask.id);
    assert.deepEqual(peer.peerItems().filter(item => item.id === `team:${third[0].group}`).map(item => [item.kind, item.text]), [['rejected', 'No project is shared.']]);
    const before = allAsks().length;
    assert.throws(() => teamAsk(ctx, { text: 'token ghp_' + 'a'.repeat(36) }), /possible secret/);
    assert.equal(allAsks().length, before, 'a secret saves no copy');
  });
  withHome(newHome(t), () => { const me = createIdentity({ name: 'solo' }); assert.throws(() => teamAsk({ me, session: () => null, dial: () => {}, event: () => {} }, { text: 'hi' }), /No teammates yet/); });
});

test('a teammate sees a team ask as asking the team', t => {
  const crew = makeTeam(t), ana = crew.founder.identity;
  withHome(crew.member.home, () => {
    const { root } = registeredProject(t); share(root, { handle: 'app' });
    const methods = intakeMethods({ me: loadIdentity(), kick: () => {}, event: () => {} });
    methods.SendMessage({ message: message({ text: 'Where is it?', contextId: 'thread-t', messageId: 'm-t', ext: { kind: 'ask', project: null, hop: 1, team: true, from: { key: ana.key, name: 'ana' } } }) }, { key: ana.key });
    methods.SendMessage({ message: message({ text: 'And you?', contextId: 'thread-u', messageId: 'm-u', ext: { kind: 'ask', project: null, hop: 1, from: { key: ana.key, name: 'ana' } } }) }, { key: ana.key });
    const incoming = peer.peerItems().filter(item => item.kind === 'incoming');
    assert.deepEqual(incoming.map(item => [item.text, item.team === true]).sort(), [['And you?', false], ['Where is it?', true]]);
  });
});

test('an ask sent in a team goes to that team, and one sent in a channel to the others in that channel', t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member.identity;
  const [li, mo] = ['li', 'mo'].map(name => withHome(newHome(t), () => createIdentity({ name })));
  withHome(crew.founder.home, () => {
    const join = (teamId, who) => redeemCode(createInvite(ana, teamId, { hours: 1 }), who.key, who.name);
    const core = crew.teamId, side = createTeam(ana, 'side').id; join(core, li); join(side, mo);
    const events = [], ctx = { me: loadIdentity(), session: () => null, dial: () => {}, event: text => events.push(text), kick: () => {} };
    const to = sent => sent.map(ask => ask.to).sort(), keys = (...who) => who.map(member => member.key).sort();
    // No team: every teammate on every team of mine, and no room.
    const all = teamAsk(ctx, { text: 'Who is around?' });
    assert.deepEqual(to(all), keys(sara, li, mo)); assert.ok(all.every(ask => !('room' in getAsk(ask.id))));
    // A team: everyone else on it. That is #general, a room with no channel.
    const general = teamAsk(ctx, { text: 'Where is the schema?', team: core });
    assert.deepEqual(to(general), keys(sara, li));
    for (const ask of general) assert.deepEqual(getAsk(ask.id).room, { team: core, channel: null });
    assert.equal(new Set(general.map(ask => ask.group)).size, 1); assert.equal(new Set(general.map(ask => ask.threadId)).size, 1);
    assert.deepEqual(to(teamAsk(ctx, { text: 'And on this one?', team: side })), keys(mo));
    // A channel: only the others in it.
    const design = setChannel(ana, core, { name: 'design', members: [ana.key, li.key] }).id;
    const [font, ...more] = teamAsk(ctx, { text: 'Which font?', team: core, channel: design });
    assert.equal(font.to, li.key); assert.deepEqual(more, []); assert.deepEqual(getAsk(font.id).room, { team: core, channel: design });
    assert.deepEqual(events, ['ask to the team (3)', 'ask to #general (2)', 'ask to #general (1)', 'ask to #design (1)']);
    // The thread says where it was asked, while it waits and once a teammate takes it.
    const threads = () => Object.fromEntries(peer.peerItems().map(item => [item.text, [item.id.split(':')[0], item.name, item.room ?? null]]));
    assert.deepEqual(threads(), { 'Who is around?': ['team', 'team', null], 'Where is the schema?': ['team', 'team', { team: core, channel: null }], 'And on this one?': ['team', 'team', { team: side, channel: null }], 'Which font?': ['team', 'team', { team: core, channel: design }] });
    applyTask(ctx, li.key, a2aTask({ id: 'task-li', contextId: font.threadId, state: TaskState.WORKING }), font.id);
    assert.deepEqual(threads()['Which font?'], ['asked', 'li', { team: core, channel: design }]);
    // Refusals save no copy and say nothing in the ticker.
    const before = allAsks().length, said = events.length;
    assert.throws(() => teamAsk(ctx, { text: 'x', team: 'f'.repeat(64) }), /You are not on that team\./);
    assert.throws(() => teamAsk(ctx, { text: 'x', team: core, channel: 'f'.repeat(16) }), /You are not in that channel\./);
    assert.throws(() => teamAsk(ctx, { text: 'x', channel: design }), /Name the team that channel is on\./, 'a channel with no team never becomes an ask to everyone');
    assert.throws(() => teamAsk(ctx, { text: 'x', team: side, channel: design }), /You are not in that channel\./, 'a channel belongs to its own team');
    appendOp(core, makeOp(sara, core, 'channel', { id: 'ab'.repeat(8), name: 'ops', members: [sara.key, li.key] }));
    assert.throws(() => teamAsk(ctx, { text: 'x', team: core, channel: 'ab'.repeat(8) }), /You are not in that channel\./);
    const solo = setChannel(ana, core, { name: 'solo', members: [ana.key] }).id;
    assert.throws(() => teamAsk(ctx, { text: 'x', team: core, channel: solo }), /No one else is in #solo\./);
    assert.throws(() => teamAsk(ctx, { text: `token ghp_${'a'.repeat(36)}`, team: core, channel: design }), /possible secret/);
    // Li is removed from the team, and so from the channel: nobody is left to ask there.
    appendOp(core, makeOp(ana, core, 'remove', { key: li.key }));
    assert.throws(() => teamAsk(ctx, { text: 'x', team: core, channel: design }), /No one else is in #design\./);
    assert.equal(allAsks().length, before); assert.equal(events.length, said);
    assert.deepEqual(to(teamAsk(ctx, { text: 'Still here?', team: core })), keys(sara));
  });
  // Someone removed from a team no longer asks in it.
  const removal = withHome(crew.founder.home, () => appendOp(crew.teamId, makeOp(ana, crew.teamId, 'remove', { key: sara.key })).op);
  withHome(crew.member.home, () => {
    const ctx = { me: loadIdentity(), session: () => null, dial: () => {}, event: () => {}, kick: () => {} };
    assert.equal(teamAsk(ctx, { text: 'Am I on it?', team: crew.teamId }).length, 1);
    appendOp(crew.teamId, removal);
    assert.throws(() => teamAsk(ctx, { text: 'x', team: crew.teamId }), /You are not on that team\./);
  });
});

test('the wire says which room an ask was sent in, beside team, and names none for a plain ask', async t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member.identity;
  await withHome(crew.founder.home, async () => {
    const sent = [], session = { request: async (method, params) => { sent.push(params); return { task: a2aTask({ id: `t-${sent.length}`, contextId: params.message.contextId }) }; } };
    const ctx = { me: loadIdentity(), session: () => session, dial: () => {}, event: () => {}, kick: () => {} };
    const design = setChannel(ana, crew.teamId, { name: 'design', members: [ana.key, sara.key] }).id, room = { team: crew.teamId, channel: design };
    teamAsk(ctx, { text: 'To every team.' }); teamAsk(ctx, { text: 'In general.', team: crew.teamId }); teamAsk(ctx, { text: 'In design.', team: crew.teamId, channel: design });
    // createAsk saves the room it is given, for one teammate too.
    const direct = createAsk(ctx, { to: 'sara', text: 'To you, in design.', room }), plain = createAsk(ctx, { to: 'sara', text: 'Only you.' });
    assert.deepEqual(getAsk(direct.id).room, room); assert.equal('room' in getAsk(plain.id), false);
    await until(() => sent.length === 5, 'all delivered', 5000);
    const base = { kind: 'ask', project: null, hop: 1, from: { key: ana.key, name: 'ana' } };
    assert.deepEqual(Object.fromEntries(sent.map(params => [params.message.parts[0].text, peerExt(params.message)])), {
      'To every team.': { ...base, team: true },
      'In general.': { ...base, team: true, room: { team: crew.teamId, channel: null } },
      'In design.': { ...base, team: true, room },
      'To you, in design.': { ...base, room },
      'Only you.': base,
    });
  });
});

test('the peer extension takes a room of a team and a channel, drops unknown fields, and refuses a malformed room', () => {
  const core = 'a'.repeat(64), design = 'b'.repeat(16), from = { key: 'c'.repeat(64), name: 'ana' }, base = { kind: 'ask', project: null, hop: 1, from };
  const ext = extra => peerExt(message({ text: 'x', ext: { kind: 'ask', from, ...extra } }));
  assert.deepEqual(ext({ team: true, room: { team: core, channel: design } }), { ...base, team: true, room: { team: core, channel: design } });
  assert.deepEqual(ext({ room: { team: core, channel: null } }), { ...base, room: { team: core, channel: null } });
  assert.deepEqual(ext({ room: { team: core } }), { ...base, room: { team: core, channel: null } }, 'no channel is #general');
  assert.deepEqual(ext({ room: { team: core, channel: design, topic: 'x' }, colour: 'red' }), { ...base, room: { team: core, channel: design } }, 'unknown fields are dropped');
  assert.deepEqual(ext({}), base); assert.deepEqual(ext({ room: null }), base);
  for (const room of [{}, { channel: design }, { team: core.slice(1) }, { team: core.toUpperCase() }, { team: 7 }, { team: [core], channel: design },
    { team: core, channel: design.slice(1) }, { team: core, channel: `${design}b` }, { team: core, channel: design.toUpperCase() }, { team: core, channel: '' }, { team: core, channel: 7 }, { team: core, channel: core }])
    assert.throws(() => ext({ room }), /Peer metadata room must name a team and a channel\./, JSON.stringify(room));
  for (const room of ['general', 7, true, [core, design]]) assert.throws(() => ext({ room }), /Peer metadata room must be an object\./, JSON.stringify(room));
});

test('an incoming ask keeps its room only when both sides are really in it', t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member.identity;
  withHome(crew.member.home, () => {
    const { root } = registeredProject(t); share(root, { handle: 'app' });
    savePeerSettings({ caps: { peerRunsPerDay: 100, peerUsdPerDay: 100, teamUsdPerDay: 100 } });
    const core = crew.teamId, both = setChannel(sara, core, { name: 'design', members: [sara.key, ana.key] }).id, mine = setChannel(sara, core, { name: 'notes', members: [sara.key] }).id;
    const theirs = appendOp(core, makeOp(ana, core, 'channel', { id: 'ab'.repeat(8), name: 'leads', members: [ana.key] })).op.body.id;
    assert.deepEqual(team(core).channels.map(row => row.id), [both, mine, theirs]);
    const methods = intakeMethods({ me: loadIdentity(), kick: () => {}, event: () => {} });
    let n = 0;
    const got = ext => { const id = `m-${++n}`; return getRecord(methods.SendMessage({ message: message({ text: `Ask ${n}`, contextId: `thread-${id}`, messageId: id, ext: { kind: 'ask', project: null, hop: 1, team: true, from: { key: ana.key, name: 'ana' }, ...ext } }) }, { key: ana.key }).id); };
    const general = got({ room: { team: core, channel: null } }), design = got({ room: { team: core, channel: both } });
    assert.deepEqual(general.room, { team: core, channel: null }); assert.deepEqual(design.room, { team: core, channel: both });
    // Anything else is shown as a plain team ask.
    const unreal = { 'no room': {}, 'a team we do not share': { room: { team: 'f'.repeat(64), channel: null } }, 'that team with a channel of ours': { room: { team: 'f'.repeat(64), channel: both } },
      'no such channel': { room: { team: core, channel: 'cd'.repeat(8) } }, 'a channel the sender is not in': { room: { team: core, channel: mine } }, 'a channel I am not in': { room: { team: core, channel: theirs } } };
    for (const [label, ext] of Object.entries(unreal)) {
      const record = got(ext);
      assert.equal('room' in record, false, label); assert.equal(record.team, true, label); assert.equal(record.task.status.state, TaskState.SUBMITTED, label);
    }
    const incoming = peer.peerItems().filter(item => item.kind === 'incoming');
    assert.equal(incoming.length, 8); assert.ok(incoming.every(item => item.team === true));
    assert.deepEqual(Object.fromEntries(incoming.filter(item => item.room).map(item => [item.text, item.room])), { 'Ask 1': { team: core, channel: null }, 'Ask 2': { team: core, channel: both } });
    // The room stays with the thread once it is taken.
    acceptIncoming({ me: loadIdentity(), kick: () => {}, event: () => {} }, design.task.id, { how: 'answer' });
    assert.deepEqual(peer.peerItems().find(item => item.id === `answering:${design.task.id}`).room, { team: core, channel: both });
  });
});

test('a question for a teammate\'s bot keeps the bot\'s name on the ask, on the wire and on its thread, and only a question to one teammate names one', async t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member.identity;
  await withHome(crew.founder.home, async () => {
    const sent = [], session = { request: async (method, params) => { sent.push(params); return { task: a2aTask({ id: `t-${sent.length}`, contextId: params.message.contextId }) }; } };
    const ctx = { me: loadIdentity(), session: () => session, dial: () => {}, event: () => {}, kick: () => {} };
    const forBot = createAsk(ctx, { to: 'sara', text: 'Review my diff.', bot: 'reviewer' }), plain = createAsk(ctx, { to: 'sara', text: 'Only you.' });
    assert.equal(getAsk(forBot.id).bot, 'reviewer'); assert.equal('bot' in getAsk(plain.id), false, 'a plain ask is saved as before');
    // A team ask never names a bot, whatever it is handed.
    const toTeam = teamAsk(ctx, { text: 'Anyone?', bot: 'reviewer' });
    assert.ok(toTeam.every(ask => !('bot' in getAsk(ask.id))));
    await until(() => sent.length === 3, 'all delivered', 5000);
    const base = { kind: 'ask', project: null, hop: 1, from: { key: ana.key, name: 'ana' } };
    assert.deepEqual(Object.fromEntries(sent.map(params => [params.message.parts[0].text, peerExt(params.message)])), { 'Review my diff.': { ...base, bot: 'reviewer' }, 'Only you.': base, 'Anyone?': { ...base, team: true } });
    // The thread says which bot was asked while it waits, once it is answered, and when it is refused.
    const thread = ask => { const item = peer.peerItems().find(row => row.threadId === ask.threadId); return [item.kind, item.bot, 'bot' in item]; };
    assert.deepEqual(thread(forBot), ['asked', 'reviewer', true]); assert.deepEqual(thread(plain), ['asked', undefined, false]); assert.deepEqual(thread(toTeam[0]), ['asked', undefined, false]);
    applyTask(ctx, sara.key, a2aTask({ id: getAsk(forBot.id).taskId, contextId: forBot.threadId, state: TaskState.COMPLETED, artifacts: [{ artifactId: 'a-1', name: 'Answer', parts: [{ text: 'Safe to merge.' }] }] }));
    assert.deepEqual(thread(forBot), ['answer', 'reviewer', true]);
    const refused = createAsk(ctx, { to: 'sara', text: 'And this one?', bot: 'private' });
    await until(() => getAsk(refused.id).taskId, 'the second one delivered', 5000);
    applyTask(ctx, sara.key, a2aTask({ id: getAsk(refused.id).taskId, contextId: refused.threadId, state: TaskState.REJECTED, statusMessage: 'That bot is not shared with teammates.' }));
    assert.deepEqual(thread(refused), ['rejected', 'private', true]);
    assert.equal(peer.peerItems().find(row => row.threadId === refused.threadId).text, 'That bot is not shared with teammates.');
    // Refusals save nothing: a name that is not a bot name, and a bot on anything but a question to one teammate.
    const count = allAsks().length;
    for (const bot of ['', 'Reviewer', '@reviewer', 'a b', `a${'1'.repeat(30)}`, 7, ['reviewer']])
      assert.throws(() => createAsk(ctx, { to: 'sara', text: 'x', bot }), /A bot name is 1 to 30 lowercase letters, digits or -, starting with a letter\./, JSON.stringify(bot));
    for (const extra of [{ kind: 'handoff' }, { kind: 'review' }, { group: '11111111-1111-4111-8111-111111111111' }])
      assert.throws(() => createAsk(ctx, { to: 'sara', text: 'x', bot: 'reviewer', ...extra }), /Only a question to one teammate can name a bot\./, JSON.stringify(extra));
    assert.equal(allAsks().length, count);
    // The ask command carries the bot; a handoff refuses one and a team question drops it.
    const daemon = Object.assign(new PeerDaemon(), { me: ctx.me, ctx });
    assert.equal(getAsk((await daemon.command({ type: 'ask', to: 'sara', text: 'And the tests?', bot: 'reviewer' })).askId).bot, 'reviewer');
    assert.equal('bot' in getAsk((await daemon.command({ type: 'ask', to: 'sara', text: 'Just you.' })).askId), false);
    // The owner's own message is never refused for looking like it holds a key: a long file path
    // reads as one, and so does a real key the owner chose to send.
    const pathLike = 'See Support/CleanShot/media/media_8Qw4Rt2LmZ/CleanShot and compare.', keyLike = `Use ghp_${'a1B2'.repeat(9)} to push.`;
    for (const text of [pathLike, keyLike]) assert.equal(getAsk((await daemon.command({ type: 'ask', to: 'sara', text })).askId).text, text);
    assert.equal((await daemon.command({ type: 'teamAsk', text: keyLike })).askIds.length > 0, true);
    await assert.rejects(daemon.command({ type: 'handoff', to: 'sara', text: 'Take this over.', bot: 'reviewer' }), /Only a question to one teammate can name a bot\./);
    await assert.rejects(daemon.command({ type: 'ask', to: 'sara', text: 'x', bot: 'Not A Bot' }), /A bot name is 1 to 30 lowercase letters/);
    const { askIds } = await daemon.command({ type: 'teamAsk', text: 'Anyone else?', bot: 'reviewer' });
    assert.equal(askIds.length, 1); assert.ok(askIds.every(id => !('bot' in getAsk(id))));
  });
});

test('a question for a bot is taken only when that bot is shared, waits for the owner like any other, and is queued for that bot', t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member;
  withHome(sara.home, () => {
    const { root } = registeredProject(t); share(root, { handle: 'app' });
    savePeerSettings({ caps: { peerRunsPerDay: 100, peerUsdPerDay: 100, teamUsdPerDay: 100 } });
    saveBot({ name: 'reviewer', instructions: 'Review the diff.', shared: true }); saveBot({ name: 'private', instructions: 'Only for me.' });
    const ctx = { me: loadIdentity(), kick: () => {}, event: () => {}, push: () => {} }, methods = intakeMethods(ctx);
    let n = 0;
    const send = (ext = {}) => { const id = `m-${++n}`; return methods.SendMessage({ message: message({ text: `Ask ${n}`, contextId: `thread-${id}`, messageId: id, ext: { kind: 'ask', project: null, hop: 1, from: { key: ana.key, name: 'ana' }, ...ext } }) }, { key: ana.key }); };
    const reason = task => task.status.message.parts[0].text, origin = task => pendingRequests(root).find(row => row.origin?.a2aTaskId === task.id).origin;
    const forBot = send({ bot: 'reviewer' }), plain = send();
    assert.equal(forBot.status.state, TaskState.SUBMITTED); assert.equal(getRecord(forBot.id).bot, 'reviewer'); assert.equal(getRecord(forBot.id).waiting, true);
    assert.equal('bot' in getRecord(plain.id), false, 'a plain ask is recorded as before');
    assert.deepEqual(pendingRequests(root), [], 'nothing is queued until the owner accepts');
    // A bot that is kept private and a name that is no bot at all are refused the same way, and the record keeps neither the name nor the text.
    for (const bot of ['private', 'nobody']) {
      const task = send({ bot }), record = getRecord(task.id);
      assert.equal(task.status.state, TaskState.REJECTED, bot); assert.equal(reason(task), 'That bot is not shared with teammates.', bot);
      assert.equal('bot' in record, false, bot); assert.equal(record.text, '', bot); assert.equal(record.waiting, false, bot);
    }
    // A team question, a review or a handoff that names a bot is refused before anything is written.
    const written = records(sara.home).length;
    for (const ext of [{ team: true }, { kind: 'review' }, { kind: 'handoff' }]) assert.throws(() => send({ bot: 'reviewer', ...ext }), /Only a question to one teammate can name a bot\./, JSON.stringify(ext));
    assert.equal(records(sara.home).length, written);
    // The owner sees which bot each waiting question is for.
    const waiting = () => Object.fromEntries(peer.peerItems().filter(item => item.kind === 'incoming').map(item => [item.text, 'bot' in item ? item.bot : null]));
    assert.deepEqual(waiting(), { 'Ask 1': 'reviewer', 'Ask 2': null });
    // Accepted, the request names the bot that answers it; a plain ask's request is what it was before bots.
    acceptIncoming(ctx, forBot.id, { how: 'answer' }); acceptIncoming(ctx, plain.id, { how: 'answer' });
    assert.deepEqual(origin(forBot), { kind: 'ask', peer: ana.key, name: 'ana', a2aTaskId: forBot.id, threadId: 'thread-m-1', hop: 1, bot: 'reviewer', teams: [crew.teamId] });
    assert.deepEqual(origin(plain), { kind: 'ask', peer: ana.key, name: 'ana', a2aTaskId: plain.id, threadId: 'thread-m-2', hop: 1, teams: [crew.teamId] }, 'the teams of the project, whose rules the run is told');
    assert.equal(pendingRequests(root).every(row => row.readOnly === true && row.state === 'queued'), true);
    const mine = task => { const item = peer.peerItems().find(row => row.taskId === task.id); return [item.kind, 'bot' in item ? item.bot : null]; };
    assert.deepEqual(mine(forBot), ['answering', 'reviewer']); assert.deepEqual(mine(plain), ['answering', null]);
    // The reply stays with the bot's thread.
    fs.mkdirSync(peerFile('outbox'), { recursive: true });
    for (const task of [forBot, plain]) { const { requestId } = getRecord(task.id); fs.writeFileSync(peerFile('outbox', `${requestId}.json`), JSON.stringify({ requestId, root, origin: origin(task), taskId: '1', outcome: 'done', text: 'Safe to merge.', costUsd: 0, finishedAt: new Date().toISOString(), error: null })); }
    processOutbox(ctx);
    assert.deepEqual(mine(forBot), ['replied', 'reviewer']); assert.deepEqual(mine(plain), ['replied', null]);
    // A question the owner works on themselves is their own session: its request names no bot.
    const worked = send({ bot: 'reviewer' }); acceptIncoming(ctx, worked.id, { how: 'work', permissions: 'ask' });
    assert.deepEqual(origin(worked), { kind: 'handoff', peer: ana.key, name: 'ana', a2aTaskId: worked.id, threadId: worked.contextId, hop: 1, teams: [crew.teamId] });
    // A bot taken back, and a bots file that cannot be read, share nothing from then on.
    const declined = () => { const task = send({ bot: 'reviewer' }); return [task.status.state, reason(task)]; };
    saveBot({ name: 'reviewer', instructions: 'Review the diff.' });
    assert.deepEqual(declined(), [TaskState.REJECTED, 'That bot is not shared with teammates.']);
    saveBot({ name: 'reviewer', instructions: 'Review the diff.', shared: true });
    assert.equal(send({ bot: 'reviewer' }).status.state, TaskState.SUBMITTED, 'shared again, it is taken again');
    // Intake takes exactly the bots teammates are told about: one on a vendor that cannot answer teammates is in neither.
    const vendor = botVendors().find(name => !canShare(name)); assert.ok(vendor, 'a vendor that cannot answer teammates');
    fs.writeFileSync(botsFile(), JSON.stringify({ version: 1, bots: [{ name: 'reviewer', vendor, instructions: 'Review the diff.', shared: true }] }));
    assert.deepEqual(thisMachine().bots, []); assert.deepEqual(declined(), [TaskState.REJECTED, 'That bot is not shared with teammates.']);
    fs.writeFileSync(botsFile(), '{');
    assert.deepEqual(declined(), [TaskState.REJECTED, 'That bot is not shared with teammates.']);
    assert.equal(send().status.state, TaskState.SUBMITTED, 'a plain ask still arrives');
  });
});

test('a later question in a thread continues the run that answered before only when the same bot, or the owner\'s agent both times, answers it', t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member;
  withHome(sara.home, () => {
    const { root } = registeredProject(t); share(root, { handle: 'app' });
    savePeerSettings({ caps: { peerRunsPerDay: 100, peerUsdPerDay: 100, teamUsdPerDay: 100, threadMessages: 100, threadUsd: 100 } });
    for (const name of ['reviewer', 'docs']) saveBot({ name, instructions: 'Answer.', shared: true });
    const ctx = { me: loadIdentity(), kick: () => {}, event: () => {}, push: () => {} }, methods = intakeMethods(ctx);
    fs.mkdirSync(peerFile('outbox'), { recursive: true });
    let n = 0;
    // One question in the thread: sent, accepted, and answered by local task ran. Returns the task its run continued.
    const turn = (bot, ran) => {
      const id = `m-${++n}`, task = methods.SendMessage({ message: message({ text: `Ask ${n}`, contextId: 'thread-c', messageId: id, ext: { kind: 'ask', project: null, hop: 1, from: { key: ana.key, name: 'ana' }, ...(bot ? { bot } : {}) } }) }, { key: ana.key });
      acceptIncoming(ctx, task.id, { how: 'answer' });
      const row = pendingRequests(root).find(request => request.origin?.a2aTaskId === task.id);
      fs.writeFileSync(peerFile('outbox', `${row.id}.json`), JSON.stringify({ requestId: row.id, root, origin: row.origin, taskId: ran, outcome: 'done', text: 'Done.', costUsd: 0, finishedAt: new Date().toISOString(), error: null }));
      processOutbox(ctx); assert.equal(getRecord(task.id).localTaskId, ran);
      return row.continuationTaskId;
    };
    assert.equal(turn('reviewer', '11'), null, 'the first question starts a run');
    assert.equal(turn(null, '12'), null, 'the owner\'s agent does not continue the bot\'s run');
    assert.equal(turn('reviewer', '11'), '11', 'the bot continues its own');
    assert.equal(turn(null, '12'), '12', 'and the owner\'s agent its own');
    assert.equal(turn('docs', '13'), null, 'another bot starts its own');
    assert.equal(turn('docs', '13'), '13');
  });
});

test('teamAsk and channelSet are peer commands, and peer status lists the channels this machine is in', t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member.identity;
  withHome(crew.founder.home, () => {
    const saved = id => { const { at, ...command } = JSON.parse(fs.readFileSync(peerFile('commands', `${id}.json`), 'utf8')); assert.ok(Date.parse(at) <= Date.now()); return command; };
    const commands = [{ type: 'teamAsk', text: 'x' }, { type: 'channelSet', team: 'a'.repeat(64), name: 'design', members: [] }];
    for (const command of commands) { const { id } = peer.sendPeerCommand(command); assert.match(id, /^\d+-[0-9a-f-]{36}$/); assert.deepEqual(saved(id), command); }
    for (const bad of [{ type: 'channelDelete' }, { type: 'teamask' }, { type: 'nope' }, {}, null, 'teamAsk']) assert.throws(() => peer.sendPeerCommand(bad), /Unknown peer command\./, JSON.stringify(bad));
    assert.equal(fs.readdirSync(peerFile('commands')).length, 2, 'a refused command writes no file');
    // Status: with the daemon off it is read from the roster, with it on from the daemon's heartbeat.
    const design = setChannel(ana, crew.teamId, { name: 'design', members: [ana.key, sara.key] }).id;
    appendOp(crew.teamId, makeOp(sara, crew.teamId, 'channel', { id: 'ab'.repeat(8), name: 'notes', members: [sara.key] }));
    assert.deepEqual(team(crew.teamId).channels.map(row => row.name), ['design', 'notes']);
    const mine = [{ id: design, name: 'design', members: [ana.key, sara.key] }], off = peer.peerStatus();
    assert.equal(off.running, false); assert.deepEqual(off.teams.map(row => [row.id, row.channels]), [[crew.teamId, mine]]);
    Object.assign(new PeerDaemon(), { me: loadIdentity() }).heartbeat();
    const on = peer.peerStatus();
    assert.equal(on.running, true); assert.deepEqual(on.teams.map(row => [row.id, row.channels]), [[crew.teamId, mine]]);
    // A team with no channels lists none.
    setChannel(ana, crew.teamId, { id: design, members: [] }); fs.rmSync(peerFile('state.json'));
    assert.deepEqual(peer.peerStatus().teams[0].channels, []);
  });
});

test('peer status shows each machine\'s box name and shared bots, from the daemon and after it stops, and none for a teammate on an older build', t => {
  const crew = makeTeam(t), sara = crew.member.identity;
  withHome(crew.founder.home, () => {
    // What this machine tells its teammates: its box name and only the bots its owner shares.
    assert.deepEqual(thisMachine(), { box: defaultBox(), bots: [] });
    savePeerSettings({ box: 'ana-mbp' });
    saveBot({ name: 'reviewer', instructions: 'Review the diff.\nBe brief.', shared: true }); saveBot({ name: 'private', instructions: 'Only for me.' });
    saveBot({ name: 'docs', about: 'Answers from the docs.', instructions: 'Read docs/.', shared: true });
    // Bots are told in the order they are listed: the ones the app comes with first, then the owner's own.
    const mine = [{ name: 'reviewer', about: 'Review the diff.' }, { name: 'docs', about: 'Answers from the docs.' }], triage = { name: 'triage', about: 'Sorts issues.' };
    assert.deepEqual(thisMachine(), { box: 'ana-mbp', bots: mine });
    const shown = status => status.teams[0].members.map(m => [m.name, m.box, m.bots]), ana = ['ana', 'ana-mbp', mine];
    // Daemon off and nothing heard yet: my own row is filled, a teammate's is empty.
    const off = peer.peerStatus();
    assert.equal(off.running, false); assert.equal(off.box, 'ana-mbp'); assert.deepEqual(shown(off), [ana, ['sara', null, []]]);
    // Daemon on: Sara's machine says what it is called and shares with its status rows.
    const daemon = Object.assign(new PeerDaemon(), { me: loadIdentity() }), session = { key: sara.key, admitted: true };
    const hear = (from, params, stopped = false) => { from.extensions()['elu.status'](params, session); from.heartbeat(stopped); return peer.peerStatus(); };
    daemon.heartbeat(); assert.deepEqual(shown(peer.peerStatus()), [ana, ['sara', null, []]]);
    const on = hear(daemon, { rows: [], box: 'sara-studio', bots: [triage, { name: 'Not A Bot', about: 'x' }] });
    assert.equal(on.running, true); assert.equal(on.box, 'ana-mbp'); assert.deepEqual(shown(on), [ana, ['sara', 'sara-studio', [triage]]]);
    // A malformed field is dropped on its own: the other one still shows.
    assert.deepEqual(shown(hear(daemon, { rows: [], box: 'not a box name', bots: [triage] })), [ana, ['sara', null, [triage]]]);
    assert.deepEqual(shown(hear(daemon, { rows: [], box: 'sara-studio', bots: 'all of them' })), [ana, ['sara', 'sara-studio', []]]);
    // A machine that is not admitted is not heard.
    daemon.extensions()['elu.status']({ rows: [], box: 'someone-else', bots: [{ name: 'intruder', about: '' }] }, { key: sara.key, admitted: false }); daemon.heartbeat();
    assert.deepEqual(shown(peer.peerStatus()), [ana, ['sara', 'sara-studio', []]]);
    // The daemon stops: the last it heard still shows, and the next start still knows it.
    const stopped = hear(daemon, { rows: [], box: 'sara-studio', bots: [triage] }, true);
    assert.equal(stopped.running, false); assert.deepEqual(shown(stopped), [ana, ['sara', 'sara-studio', [triage]]]);
    const next = Object.assign(new PeerDaemon(), { me: loadIdentity() }); next.recall(); next.heartbeat();
    assert.equal(peer.peerStatus().running, true); assert.deepEqual(shown(peer.peerStatus()), [ana, ['sara', 'sara-studio', [triage]]]);
    // A teammate on a build from before bots sends only its rows: no box name and no bots.
    assert.deepEqual(shown(hear(next, { rows: [] })), [ana, ['sara', null, []]]);
    // A state file written by such a build, or left by another identity, shows none either.
    const state = JSON.parse(fs.readFileSync(peerFile('state.json'), 'utf8')), member = state.teams[0].members.find(m => m.key === sara.key);
    assert.equal(member.box, null); assert.deepEqual(member.bots, []);
    delete member.box; delete member.bots; fs.writeFileSync(peerFile('state.json'), JSON.stringify(state));
    assert.deepEqual(shown(peer.peerStatus()), [ana, ['sara', null, []]]);
    Object.assign(member, { box: 'sara-studio', bots: [triage] }); fs.writeFileSync(peerFile('state.json'), JSON.stringify({ ...state, running: false, key: 'f'.repeat(64) }));
    assert.deepEqual(shown(peer.peerStatus()), [ana, ['sara', null, []]]);
    const fresh = Object.assign(new PeerDaemon(), { me: loadIdentity() }); fresh.recall(); assert.equal(fresh.machines.size, 0);
  });
});

test('a status row names a bot at work only when the owner shares that bot', t => {
  withHome(newHome(t), () => {
    const project = registeredProject(t, { origin: ORIGIN }); share(project.root, { handle: 'app' });
    liveTask(project.root, { activeRole: botKey('scout') }); liveTask(project.root, { id: '2', files: { 'README.md': 'x\n' } });
    // A bot teammates were never told about is not named to them, and neither is the key it runs under.
    assert.deepEqual(statusRows().map(row => [row.taskId, row.now]), [['1', 'ready · bot'], ['2', 'ready · lead']]);
    saveBot({ name: 'scout', instructions: 'Look around.' });
    assert.equal(statusRows()[0].now, 'ready · bot');
    saveBot({ name: 'scout', instructions: 'Look around.', shared: true });
    assert.equal(statusRows()[0].now, 'ready · @scout');
  });
});

test('a teammate is told this machine\'s box name and shared bots when they connect, and again within a tick when either changes', async t => {
  const crew = makeTeam(t), sara = crew.member.identity;
  await withHome(crew.founder.home, async () => {
    savePeerSettings({ box: 'ana-mbp' }); saveBot({ name: 'reviewer', instructions: 'Review the diff.', shared: true });
    const reviewer = { name: 'reviewer', about: 'Review the diff.' }, docs = { name: 'docs', about: 'Answers from the docs.' };
    const daemon = Object.assign(new PeerDaemon({ conductor: () => {} }), { me: loadIdentity(), methods: {} });
    // A fake socket: what the daemon writes collects in out; Sara's hello is emitted as data.
    let out = '';
    const socket = Object.assign(new EventEmitter(), { destroyed: false, write: chunk => { out += chunk; return true; }, destroy() { this.destroyed = true; this.emit('close'); } });
    const told = () => out.split('\n').flatMap(line => { try { const frame = JSON.parse(line); return frame.method === 'elu.status' ? [frame] : []; } catch { return []; } });
    daemon.attach(socket, sara.key);
    socket.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'elu.hello', params: { binding: BINDING, a2aVersion: '1.0', name: 'sara', teams: [{ id: crew.teamId, ...head(crew.teamId), ops: [] }], handles: [] } })}\n`));
    assert.equal(daemon.sessions.get(sara.key)?.admitted, true);
    // On connect, with the rows, as a notification an older build reads the rows of.
    assert.deepEqual(told(), [{ jsonrpc: '2.0', method: 'elu.status', params: { rows: [], box: 'ana-mbp', bots: [reviewer] } }]);
    // The first tick settles the rows; after that a tick with nothing changed says nothing.
    daemon.tick(); const settled = told().length; daemon.tick(); daemon.tick();
    assert.equal(told().length, settled); assert.equal(daemon.error, null);
    const next = change => { const count = told().length; change(); daemon.tick(); assert.equal(told().length, count + 1, 'told once'); daemon.tick(); assert.equal(told().length, count + 1, 'and not again'); return told().at(-1).params; };
    assert.deepEqual(next(() => saveBot({ name: 'docs', about: docs.about, instructions: 'Read docs/.', shared: true })), { rows: [], box: 'ana-mbp', bots: [reviewer, docs] });
    assert.deepEqual(next(() => saveBot({ name: 'reviewer', instructions: 'Review the diff.' })), { rows: [], box: 'ana-mbp', bots: [docs] }, 'a bot taken back is no longer told');
    assert.deepEqual(next(() => savePeerSettings({ box: 'ana-studio' })), { rows: [], box: 'ana-studio', bots: [docs] });
    assert.deepEqual(next(() => saveBot({ name: 'docs', about: 'Answers from docs/ and the README.', instructions: 'Read docs/.', shared: true })).bots, [{ name: 'docs', about: 'Answers from docs/ and the README.' }]);
    // A bot that is not shared changes nothing teammates are told.
    const quiet = told().length; saveBot({ name: 'private', instructions: 'Only for me.' }); daemon.tick();
    assert.equal(told().length, quiet);
    // A bots file that cannot be read shares none; removing a bot does the same.
    const saved = fs.readFileSync(botsFile(), 'utf8');
    assert.deepEqual(next(() => fs.writeFileSync(botsFile(), '{')).bots, []);
    assert.deepEqual(next(() => fs.writeFileSync(botsFile(), saved)).bots.map(bot => bot.name), ['docs']);
    assert.deepEqual(next(() => removeBot('docs')).bots, []);
    // More than 20 shared bots: the first 20 by name are told.
    for (let n = 0; n < 22; n++) saveBot({ name: `bot-${String(n).padStart(2, '0')}`, instructions: 'Answer.', shared: true });
    daemon.tick();
    assert.deepEqual(told().at(-1).params.bots.map(bot => bot.name), Array.from({ length: 20 }, (_, n) => `bot-${String(n).padStart(2, '0')}`));
    daemon.sessions.get(sara.key).close();
  });
});

test('the daemon sets a channel as a signed op, pushes it to connected teammates, and asks in it', async t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member.identity;
  await withHome(crew.founder.home, async () => {
    const pushes = [], events = [], me = loadIdentity();
    const daemon = Object.assign(new PeerDaemon(), { me, ctx: { me, session: () => null, dial: () => {}, event: text => events.push(text), kick: () => {} } });
    daemon.sessions.set(sara.key, { key: sara.key, admitted: true, request: async (method, params) => { pushes.push([method, params]); return {}; } });
    const { id } = await daemon.command({ type: 'channelSet', team: crew.teamId, name: 'design', members: [ana.key, sara.key] });
    assert.deepEqual(team(crew.teamId).channels, [{ id, name: 'design', members: [ana.key, sara.key], createdBy: ana.key, createdAt: pushes[0][1].ops[0].at }]);
    assert.deepEqual(pushes.map(([method, params]) => [method, params.teamId, params.ops.map(op => [op.type, op.by, op.body])]), [['elu.roster.push', crew.teamId, [['channel', ana.key, { id, name: 'design', members: [ana.key, sara.key] }]]]]);
    // The same command with an id changes that channel.
    assert.deepEqual(await daemon.command({ type: 'channelSet', team: crew.teamId, id, name: 'ux', members: [ana.key, sara.key] }), { id });
    assert.deepEqual(team(crew.teamId).channels.map(row => [row.id, row.name]), [[id, 'ux']]); assert.equal(pushes.length, 2);
    await assert.rejects(daemon.command({ type: 'channelSet', team: 'a'.repeat(64), name: 'ops', members: [ana.key] }), /Choose one of your teams\./);
    await assert.rejects(daemon.command({ type: 'channelSet', name: 'ops', members: [ana.key] }), /Choose one of your teams\./);
    await assert.rejects(daemon.command({ type: 'channelSet', team: crew.teamId, name: 'general', members: [ana.key] }), /general is taken/);
    await assert.rejects(daemon.command({ type: 'channelSet', team: crew.teamId, id: 'f'.repeat(16), members: [ana.key] }), /That channel no longer exists\./);
    assert.equal(pushes.length, 2, 'a refused change pushes nothing');
    // teamAsk carries the team and the channel through to the asks.
    const inChannel = await daemon.command({ type: 'teamAsk', text: 'Which font?', team: crew.teamId, channel: id }), toAll = await daemon.command({ type: 'teamAsk', text: 'Who is around?' });
    assert.deepEqual(inChannel.askIds.map(askId => [getAsk(askId).to, getAsk(askId).room]), [[sara.key, { team: crew.teamId, channel: id }]]);
    assert.deepEqual(toAll.askIds.map(askId => [getAsk(askId).to, 'room' in getAsk(askId)]), [[sara.key, false]]);
    assert.deepEqual(events, ['ask to #ux (1)', 'ask to the team (1)']);
    await assert.rejects(daemon.command({ type: 'teamAsk', text: 'x', team: crew.teamId, channel: 'f'.repeat(16) }), /You are not in that channel\./);
  });
});

test('intake writes nothing for strangers or muted teammates, keeps no text on rejections, and reserves runUsd for a burst', t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member;
  withHome(sara.home, () => {
    const { root } = registeredProject(t); share(root, { handle: 'app' });
    const ctx = { me: loadIdentity(), kick: () => {}, event: () => {} }, methods = intakeMethods(ctx), session = { key: ana.key };
    const send = (text, extra = {}) => methods.SendMessage({ message: message({ text, contextId: extra.thread ?? 'thread-a', messageId: extra.id, ext: { kind: 'ask', project: extra.project ?? null, hop: 1, from: { key: ana.key, name: 'ana' } } }) }, session);
    const files = dir => fs.existsSync(peerFile(dir)) ? fs.readdirSync(peerFile(dir)) : [];
    const reason = task => task.status.message.parts[0].text;
    const eve = 'c'.repeat(64);
    assert.match(reason(methods.SendMessage({ message: message({ text: 'x'.repeat(1000), messageId: 's-1', ext: { kind: 'ask', from: { key: eve, name: 'eve' } } }) }, { key: eve })), /not on a team/);
    savePeerPolicy(ana.key, { muted: true });
    assert.match(reason(send('y'.repeat(1000), { id: 'm-1' })), /not taking requests/);
    assert.deepEqual([files('tasks'), files('threads')], [[], []], 'nothing written');
    savePeerPolicy(ana.key, { muted: false });
    const big = 'z'.repeat(5000), refused = send(big, { id: 'm-2', project: 'nope' });
    assert.equal(read(sara.home, 'tasks', `${refused.id}.json`).text, '');
    assert.ok(!fs.readFileSync(peerFile('threads', 'thread-a.jsonl'), 'utf8').includes(big));
    assert.equal(send(big, { id: 'm-2', project: 'nope' }).id, refused.id, 'a resend of a rejection returns it');
    // runUsd 0.5 is reserved per accepted ask, so peerUsdPerDay 1 admits two of a burst.
    savePeerSettings({ caps: { peerUsdPerDay: 1, threadMessages: 100, threadUsd: 100 } });
    const burst = [3, 4, 5].map(n => send('Where?', { id: `b-${n}`, thread: `t-${n}` }));
    assert.deepEqual(burst.map(task => task.status.state), ['TASK_STATE_SUBMITTED', 'TASK_STATE_SUBMITTED', 'TASK_STATE_REJECTED']);
    assert.match(reason(burst[2]), /daily spending limit/);
    methods.CancelTask({ id: burst[0].id }, session);
    assert.equal(send('Where?', { id: 'b-6', thread: 't-6' }).status.state, 'TASK_STATE_SUBMITTED', 'a cancel releases its reservation');
    // Every message counts toward the daily message cap, rejected or not.
    count(ana.key, [], { messages: MESSAGES_PER_DAY });
    assert.match(reason(send('Where?', { id: 'b-7', thread: 't-7' })), /too many messages/);
  });
});

test('a shutdown is honoured whatever an old setting says, unless it predates the daemon', async t => {
  const home = newHome(t), exits = [];
  await withHome(home, async () => {
    const daemon = Object.assign(new PeerDaemon({ onExit: () => exits.push('exit') }), { startedAt: new Date().toISOString() });
    // enabled, saved by 0.1.5 and earlier, means nothing now.
    savePeerSettings({ enabled: true });
    assert.deepEqual(await daemon.command({ type: 'shutdown', at: new Date(Date.now() - 60000).toISOString() }), { stopping: false });
    assert.deepEqual(await daemon.command({ type: 'shutdown', at: new Date(Date.now() + 1000).toISOString() }), { stopping: true });
    await new Promise(resolve => setImmediate(resolve));
  });
  assert.deepEqual(exits, ['exit']);
});

test('the daemon stops by itself once this machine has been on no team for a while, and not while a join or a command is under way', async t => {
  const home = newHome(t), exits = [];
  await withHome(home, async () => {
    const me = createIdentity({ name: 'ana' }), daemon = Object.assign(new PeerDaemon({ idleMs: 1000, conductor: () => {}, onExit: () => exits.push('exit') }), { me });
    const now = Date.now();
    assert.equal(daemon.idle(now), false); assert.equal(daemon.idle(now + 999), false);
    // A join, or a command, keeps it up and starts the wait again.
    daemon.joins.set('k', {}); assert.equal(daemon.idle(now + 5000), false); daemon.joins.clear();
    daemon.running.add('c'); assert.equal(daemon.idle(now + 5000), false); daemon.running.clear();
    assert.equal(daemon.idle(now + 5000), false, 'the wait starts again');
    // On a team it never stops by itself.
    const made = createTeam(me, 'core');
    assert.equal(daemon.idle(now + 60000), false); assert.equal(daemon.idleSince, null);
    // No team left (here the roster is gone; leaving does the same): it stops after idleMs.
    fs.rmSync(teamPath(made.id), { recursive: true, force: true });
    assert.equal(daemon.idle(now + 70000), false); assert.equal(daemon.idle(now + 71000), true);
    assert.equal(daemon.idle(now + 80000), false, 'once');
    await new Promise(resolve => setImmediate(resolve));
  });
  assert.deepEqual(exits, ['exit']);
});

test('elu peer --daemon on a machine on no team exits at once and connects to nothing; with a team and an old enabled false it runs', { timeout: 120000 }, async t => {
  const bootstrap = await testnet(t), home = newHome(t), env = { ...process.env, XDG_CONFIG_HOME: home };
  withHome(home, () => { createIdentity({ name: 'ana' }); savePeerSettings({ enabled: false, bootstrap }); });
  const started = Date.now(), quiet = spawnSync(process.execPath, [CLI, 'peer', '--daemon'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(quiet.status, 0, quiet.stderr); assert.equal(quiet.stdout, '');
  assert.ok(Date.now() - started < 30000);
  assert.equal(state(home), null, 'no heartbeat'); assert.equal(read(home, 'peer.lock'), null, 'no lock');
  assert.equal(withHome(home, () => peer.peerWanted()), false);
  // The same machine on a team: an enabled false saved by an older version is ignored.
  withHome(home, () => createTeam(loadIdentity(), 'core'));
  assert.equal(withHome(home, () => peer.peerWanted()), true);
  const child = spawn(process.execPath, [CLI, 'peer', '--daemon'], { env, stdio: 'ignore' }), exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await exited; } });
  await until(() => state(home)?.running && withHome(home, () => peer.peerStatus().running), 'the daemon running', 30000);
  assert.equal(read(home, 'settings.json').enabled, false);
  child.kill('SIGTERM'); await exited;
});

test('asks reach a teammate by display name or fingerprint, are scanned, paced on reconnect, back off offline, and cancel on dismiss', async t => {
  const crew = makeTeam(t, { memberName: 'Sara Khan' }), sara = crew.member.identity;
  await withHome(crew.founder.home, async () => {
    const calls = [], dials = [];
    let session = null;
    const ctx = { me: loadIdentity(), session: () => session, dial: key => dials.push(key), event: () => {}, kick: () => {} };
    assert.equal(teammate(ctx.me, '@SaraKhan').key, sara.key);
    assert.equal(teammate(ctx.me, sara.key.slice(0, 8)).key, sara.key);
    assert.throws(() => createAsk(ctx, { to: 'SaraKhan', text: `Use ghp_${'a1B2'.repeat(9)} to push.` }), /possible secret/);
    assert.equal(createAsk(ctx, { to: 'SaraKhan', text: `Read ${os.homedir()}/notes/x.txt` }).text, 'Read [path]', 'paths outside the repo go');
    // Offline: one dial per backoff step, not one per tick.
    const before = dials.length; tickAsks(ctx); tickAsks(ctx);
    assert.equal(dials.length, before + 1);
    // 25 submitted asks: a reconnect polls at most 10 at once and backs off on a rate limit.
    const ids = Array.from({ length: 25 }, () => createAsk(ctx, { to: 'SaraKhan', text: 'Where?' }).id);
    for (const [n, id] of ids.entries()) { const file = peerFile('asks', `${id}.json`); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), state: 'submitted', taskId: `task-${n}` })); }
    // Dismissing an open ask sends CancelTask for it.
    const cancels = [];
    session = { request: async (method, params) => { cancels.push([method, params]); return {}; } };
    const dismissed = dismissAsk(ctx, ids[24]);
    assert.equal(dismissed.state, 'canceled');
    await until(() => read(crew.founder.home, 'asks', `${ids[24]}.json`).cancel === false, 'cancel sent', 5000);
    assert.deepEqual(cancels, [['CancelTask', { id: 'task-24' }]]);
    session = { request: async (method, params) => { calls.push([method, params]); throw Object.assign(new Error('Too many requests.'), { details: { rpc: { code: -32000 } } }); } };
    await reconnect(ctx, sara.key);
    assert.ok(calls.length <= 10, `${calls.length} requests in one burst`);
    const asks = ids.map(id => read(crew.founder.home, 'asks', `${id}.json`));
    assert.ok(asks.filter(ask => ask.pollAt > Date.now()).length >= 1, 'a rate-limited poll waits');
    assert.ok(asks.filter(ask => ask.pollAt === 0).length >= 14, 'the rest stay due');
    assert.ok(asks.slice(0, 24).every(ask => ask.state === 'submitted'), 'nothing is dropped');
    assert.ok(calls.every(([method]) => ['GetTask', 'SendMessage'].includes(method)), 'the pending ask goes out too');
  });
});

test('a local /a2a task keeps the client context and answers GetTask after the conductor drops its row', t => {
  withHome(newHome(t), () => {
    createIdentity({ name: 'ana' });
    const { root } = registeredProject(t); share(root, { handle: 'app' });
    const daemon = new PeerDaemon({ conductor: () => {} }), local = { peerName: null };
    const msg = extra => ({ messageId: 'l-1', role: 'ROLE_USER', parts: [{ text: 'Summarise the README.' }], ...extra });
    saveDefaultMode('full');
    const sent = daemon.localCall('SendMessage', { message: msg({ contextId: 'ctx-1' }), metadata: { project: 'app' } }, local);
    assert.equal(sent.contextId, 'ctx-1');
    assert.equal(pendingRequests(root).find(row => row.id === sent.id).permissions, 'auto', 'an owner request from another machine runs the default, capped at Approve for me');
    assert.throws(() => daemon.localCall('SendMessage', { message: msg({ taskId: sent.id }), metadata: { project: 'app' } }, local), error => error.details.rpc.code === ErrorCode.UNSUPPORTED_OPERATION);
    assert.throws(() => daemon.localCall('SendMessage', { message: msg({ contextId: 'a b' }), metadata: { project: 'app' } }, local), error => error.details.rpc.code === ErrorCode.INVALID_PARAMS);
    const repo = repository(root);
    saveTask(repo, { id: '5', kind: 'conversation', base: null, branch: null, goal: 'Summarise the README.', state: 'answered', worktree: repo.root, createdAt: new Date().toISOString(), runs: [], reviews: [], messages: [], sessions: {}, result: { summary: 'It explains setup.' } });
    updateRequest(root, sent.id, { state: 'running', taskId: '5' }); daemon.syncLocal();
    assert.equal(daemon.localCall('GetTask', { id: sent.id }, local).status.state, 'TASK_STATE_WORKING');
    removeRequest(root, sent.id);
    const done = daemon.localCall('GetTask', { id: sent.id }, local);
    assert.equal(done.status.state, 'TASK_STATE_COMPLETED'); assert.equal(done.contextId, 'ctx-1');
    assert.equal(done.artifacts[0].parts[0].text, 'It explains setup.');
  });
});

// --- Trusted peers: paths pass through, the secret scan does not. ---
test('a handoff to a trusted teammate keeps its paths, an untrusted one gets [path], and a secret still refuses', async t => {
  const crew = makeTeam(t), sara = crew.member.identity;
  await withHome(crew.founder.home, async () => {
    const sent = [], session = { request: async (method, params) => { sent.push(params); return { task: a2aTask({ id: `t-${sent.length}`, contextId: params.message.contextId }) }; } };
    const ctx = { me: loadIdentity(), session: () => session, dial: () => {}, event: () => {}, kick: () => {} };
    const text = `Start from ${os.homedir()}/evals/run.json and ~/.ssh/config.`;
    const cut = createAsk(ctx, { to: 'sara', kind: 'handoff', text });
    assert.equal(cut.text, 'Start from [path] and [path].'); assert.equal(cut.pathsCut, true);
    assert.equal(peer.peerItems().find(item => item.id === `asked:${cut.id}`).pathsCut, true);
    savePeerPolicy(sara.key, { trusted: true });
    const kept = createAsk(ctx, { to: 'sara', kind: 'handoff', text });
    assert.equal(kept.text, text); assert.equal(kept.pathsCut, undefined);
    assert.equal(peer.peerItems().find(item => item.id === `asked:${kept.id}`).trusted, true);
    await until(() => sent.length === 2, 'both delivered', 5000);
    assert.deepEqual(sent.map(params => params.message.parts[0].text), ['Start from [path] and [path].', text], 'the wire carries what was saved');
    assert.throws(() => createAsk(ctx, { to: 'sara', kind: 'handoff', text: `${text} Token ghp_${'a1B2'.repeat(9)}` }), /possible secret/);
    assert.equal(allAsks().length, 2, 'a secret saves nothing, trusted or not');
    // The model sees the same block for a trusted sender: trust is about display and paths.
    const block = trusted => { savePeerPolicy(sara.key, { trusted }); return peerDataBlock({ text, from: 'sara', key: sara.key, kind: 'handoff' }).replace(/peer-data-[0-9a-f]{16}/g, 'peer-data-N'); };
    assert.equal(block(true), block(false));
  });
});

test('a reply to a trusted teammate keeps its paths but a secret still holds it, and items carry the trust flag', t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member;
  withHome(sara.home, () => {
    const { root } = registeredProject(t); share(root, { handle: 'app' });
    const ctx = { me: loadIdentity(), kick: () => {}, event: () => {}, push: () => {} }, methods = intakeMethods(ctx);
    const incoming = (id, threadId) => getRecord(methods.SendMessage({ message: message({ text: 'Where are the eval files?', contextId: threadId, messageId: id, ext: { kind: 'ask', project: 'app', hop: 1, from: { key: ana.key, name: 'ana' } } }) }, { key: ana.key }).id);
    fs.mkdirSync(peerFile('outbox'), { recursive: true });
    const finish = (record, text) => {
      const { requestId } = getRecord(record.task.id);
      fs.writeFileSync(peerFile('outbox', `${requestId}.json`), JSON.stringify({ requestId, root, origin: { kind: 'ask', peer: ana.key, name: 'ana', a2aTaskId: record.task.id, threadId: record.threadId, hop: 1 }, taskId: '1', outcome: 'done', text, costUsd: 0, finishedAt: new Date().toISOString(), error: null }));
      processOutbox(ctx); return getRecord(record.task.id);
    };
    const reply = `They are in ${os.homedir()}/evals/run.json.`;
    const first = incoming('m-1', 'thread-1'); acceptIncoming(ctx, first.task.id, { how: 'answer' });
    const cut = finish(first, reply);
    assert.equal(cut.reply.text, 'They are in [path].'); assert.equal(cut.reply.pathsCut, true); assert.equal(cut.task.status.state, TaskState.COMPLETED);
    assert.equal(peer.peerItems().find(item => item.id === `replied:${first.task.id}`).pathsCut, true);
    savePeerPolicy(ana.key, { trusted: true });
    const second = incoming('m-2', 'thread-2'); acceptIncoming(ctx, second.task.id, { how: 'answer' });
    const kept = finish(second, reply);
    assert.equal(kept.reply.text, reply); assert.equal(kept.reply.pathsCut, false); assert.equal(kept.task.status.state, TaskState.COMPLETED);
    assert.equal(kept.task.artifacts[0].parts[0].text, reply); assert.equal(thread('thread-2').at(-1).text, reply);
    const third = incoming('m-3', 'thread-3'); acceptIncoming(ctx, third.task.id, { how: 'answer' });
    const held = finish(third, `${reply} Use ${ACCESS_KEY}.`);
    assert.equal(held.reply.blocked, true); assert.equal(held.task.status.state, TaskState.WORKING, 'held, not sent');
    assert.ok(held.reply.text.startsWith(reply), 'the held text keeps its paths for the owner to edit');
    assert.throws(() => sendReply(ctx, third.task.id), /possible secret/);
    assert.throws(() => sendReply(ctx, third.task.id, { text: `Still ${ACCESS_KEY}.` }), /still contains a possible secret/);
    assert.equal(sendReply(ctx, third.task.id, { text: `${reply} Use your own key.` }).artifacts[0].parts[0].text, `${reply} Use your own key.`);
    // Items and thread messages say whether I trust the teammate they are with.
    const mine = () => peer.peerItems().filter(item => item.peer === ana.key);
    assert.equal(mine().length, 3); assert.ok(mine().every(item => item.trusted === true && item.request === 'ask'));
    assert.ok(peer.threadMessages('thread-2').length >= 2 && peer.threadMessages('thread-2').every(m => m.trusted === true));
    savePeerPolicy(ana.key, { trusted: false });
    assert.ok(mine().every(item => item.trusted === false)); assert.ok(peer.threadMessages('thread-2').every(m => m.trusted === false));
  });
});

test('an a2a refusal keeps its paths for a trusted caller and cuts them for anyone else', async t => {
  const crew = makeTeam(t), sara = crew.member.identity;
  await withHome(crew.founder.home, async () => {
    const where = `${os.homedir()}/evals/run.json`;
    const daemon = Object.assign(new PeerDaemon({ conductor: () => {} }), { me: loadIdentity(), methods: { 'elu.ping': () => refuse(`No file at ${where}.`) } });
    const refusal = async trusted => {
      savePeerPolicy(sara.key, { trusted });
      // A fake socket: frames written by the daemon collect in out; Sara's frames are emitted as data.
      let out = '';
      const socket = Object.assign(new EventEmitter(), { destroyed: false, write: chunk => { out += chunk; return true; }, destroy() { this.destroyed = true; this.emit('close'); } });
      const say = value => socket.emit('data', Buffer.from(`${JSON.stringify(value)}\n`));
      daemon.attach(socket, sara.key);
      say({ jsonrpc: '2.0', method: 'elu.hello', params: { binding: BINDING, a2aVersion: '1.0', name: 'sara', teams: [{ id: crew.teamId, ...head(crew.teamId), ops: [] }], handles: [] } });
      assert.equal(daemon.sessions.get(sara.key)?.admitted, true);
      say({ jsonrpc: '2.0', id: 7, method: 'elu.ping', params: {} });
      const response = await until(() => out.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(row => row?.id === 7 && row.error), 'refusal', 5000);
      daemon.sessions.get(sara.key).close();
      return response.error.message;
    };
    // The cut swallows the sentence's full stop too: that is the existing publicMessage pattern.
    assert.equal(await refusal(false), 'No file at [path]');
    assert.equal(await refusal(true), `No file at ${where}.`);
    assert.equal(await refusal(false), 'No file at [path]', 'trust removed applies to the next refusal');
  });
});

test('elu team leave and elu team remove: plain refusals, and the op written here when the daemon cannot start', async t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member.identity, teamId = crew.teamId;
  await withHome(crew.founder.home, async () => {
    await assert.rejects(peerCli(['team', 'leave'], {}), /^.*You made core, so you cannot leave it\. elu team remove NAME removes a teammate\.$/);
    await assert.rejects(peerCli(['team', 'remove'], {}), /Use elu team remove NAME \[--team TEAM\]\./);
    await assert.rejects(peerCli(['team', 'remove', 'kim'], {}), /No teammate kim on core\./);
    await assert.rejects(peerCli(['team', 'remove', 'sara'], { team: 'nope' }), /No team of yours matches --team\./);
  });
  await withHome(crew.member.home, async () => {
    await assert.rejects(peerCli(['team', 'remove', 'ana'], {}), /Only an admin of core can remove a teammate\./);
    // Without the networking packages the CLI and the app write the op here: what they call then.
    assert.deepEqual(peer.leaveTeam(teamId), { team: teamId, name: 'core' });
    assert.equal(team(teamId).members.find(m => m.key === sara.key).left, true);
    assert.equal(peer.leaveUnheard(), true, 'noted, so the daemon tells them once it can start');
    assert.equal(peer.peerWanted(), true);
    await assert.rejects(peerCli(['team', 'leave'], {}), /Create a team first/);
  });
  await withHome(crew.founder.home, async () => {
    // The founder's log has not heard yet; once it has, sara is no longer there to remove.
    merge(teamId, withHome(crew.member.home, () => readLog(teamId).ops));
    await assert.rejects(peerCli(['team', 'remove', '@sara'], {}), /No teammate sara on core\./);
    redeemCode(createInvite(ana, teamId, { hours: 1 }), sara.key, 'sara');
    assert.deepEqual(peer.removeMember(teamId, sara.key), { team: teamId, name: 'core', key: sara.key, member: 'sara' });
    assert.equal(team(teamId).members.find(m => m.key === sara.key).removed, true);
    await assert.rejects(peer.teamChange({ type: 'teamJoin', team: teamId }), /Unknown team change\./);
  });
});

test('elu peer trust and untrust resolve a roster name, refuse unknown and ambiguous names, and show in elu peers; peer on, off and status are gone', async t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member.identity;
  await withHome(crew.founder.home, async () => {
    const peers = () => JSON.parse(fs.readFileSync(peerFile('peers.json'), 'utf8'));
    const result = await peerCli(['peer', 'trust', '@sara'], {});
    assert.equal(result.message, 'Trusted @sara. Paths go out as they are. Their text shows as sent.');
    assert.deepEqual(result.peer, { key: sara.key, name: 'sara', trusted: true }); assert.equal(peers()[sara.key].trusted, true);
    const listed = await peerCli(['peers'], {}), lines = listed.lines;
    assert.match(lines.find(line => line.includes(' sara ')), /offline  trusted$/); assert.doesNotMatch(lines.find(line => line.includes(' ana ')), /trusted/);
    assert.match(listed.message, /^The peer daemon is not running\. It starts when you open ELU Code, invite or ask\. /);
    for (const gone of [['peer'], ['peer', 'on'], ['peer', 'off'], ['peer', 'status']]) await assert.rejects(peerCli(gone, {}), new RegExp(`Unknown command: ${gone.join(' ')}\\. Use elu peer install\\|uninstall or elu peer trust\\|untrust @NAME\\.$`));
    await assert.rejects(peerCli(['peer', 'trust', '@nobody'], {}), /No teammate is named @nobody\./);
    await assert.rejects(peerCli(['peer', 'trust'], {}), /Use elu peer trust @NAME\./);
    await assert.rejects(peerCli(['peer', 'untrust', '@sara', 'extra'], {}), /Use elu peer untrust @NAME\./);
    await assert.rejects(peerCli(['peer', 'bogus'], {}), /trust\|untrust @NAME/);
    await assert.rejects(peerCli(['team', 'bogus'], {}), /Use elu team create NAME, elu team leave \[TEAM\] or elu team remove NAME \[--team TEAM\]\./);
    redeemCode(createInvite(ana, crew.teamId, { hours: 1 }), 'c'.repeat(64), 'sara');
    await assert.rejects(peerCli(['peer', 'trust', '@sara'], {}), /More than one teammate is named @sara\./);
    const untrusted = await peerCli(['peer', 'untrust', sara.key.slice(0, 8)], {});
    assert.equal(untrusted.message, '@sara is no longer trusted. Paths go out as [path].'); assert.equal(untrusted.peer.trusted, false);
    assert.equal(peers()[sara.key].trusted, false);
    // The daemon command does the same for the TUI's t key, for teammates only.
    const daemon = Object.assign(new PeerDaemon(), { me: loadIdentity() });
    assert.deepEqual(await daemon.command({ type: 'trust', key: sara.key }), { key: sara.key, trusted: true });
    assert.equal(peers()[sara.key].trusted, true);
    assert.deepEqual(await daemon.command({ type: 'untrust', key: sara.key }), { key: sara.key, trusted: false });
    await assert.rejects(daemon.command({ type: 'trust', key: 'd'.repeat(64) }), /Choose a teammate to trust\./);
    await assert.rejects(daemon.command({ type: 'trust', key: 'nope' }), /Choose a teammate to trust\./);
  });
});

test('ops another process writes to the log are pushed to connected teammates', t => {
  const crew = makeTeam(t), sara = crew.member.identity;
  withHome(crew.founder.home, () => {
    const pushes = [], daemon = Object.assign(new PeerDaemon(), { me: loadIdentity(), recheck: () => {} });
    daemon.sessions.set(sara.key, { key: sara.key, admitted: true, request: async (method, params) => { pushes.push([method, params]); return {}; } });
    daemon.forwardLocal();
    assert.equal(pushes.length, 0, 'the first tick only notes what is there');
    const { op } = appendOp(crew.teamId, makeOp(loadIdentity(), crew.teamId, 'relays', { keys: ['e'.repeat(64)] }));
    daemon.forwardLocal(); daemon.forwardLocal();
    assert.deepEqual(pushes, [['elu.roster.push', { teamId: crew.teamId, ops: [op] }]]);
  });
});

test('teammates\' saved status rows show only while they are online', t => {
  withHome(newHome(t), () => {
    const me = createIdentity({ name: 'ana' }), sara = 'b'.repeat(64), repoId = 'f'.repeat(64);
    const heartbeat = online => fs.writeFileSync(peerFile('state.json'), JSON.stringify({ running: true, pid: process.pid, at: new Date().toISOString(), key: me.key, rows: [], teams: [{ id: 'x', name: 'Core', members: [{ key: me.key, name: 'ana', online: true }, { key: sara, name: 'sara', online }] }] }));
    fs.mkdirSync(peerFile('status'), { recursive: true });
    fs.writeFileSync(peerFile('status', `${sara}.json`), JSON.stringify({ at: new Date(Date.now() - 86400000).toISOString(), rows: [{ repoId, handle: 'app', taskId: '7', label: 'editing', now: 'running', files: ['src/a.js'] }] }));
    heartbeat(false); assert.deepEqual(peer.teamAgents()[0].rows, []);
    heartbeat(true); assert.equal(peer.teamAgents()[0].rows.length, 1);
  });
});

// --- Network tests: hyperdht/testnet on 127.0.0.1, two homes, one daemon process each. ---
test('team create, invite and join over the network with a short code', async t => {
  const bootstrap = await testnet(t), ana = newHome(t), sara = newHome(t);
  const { teamId, code } = withHome(ana, () => { const me = createIdentity({ name: 'ana' }), made = createTeam(me, 'core'); return { teamId: made.id, code: createInvite(me, made.id, { hours: 1 }) }; });
  assert.match(code, /^[2-9a-hjkmnp-z]{4}-[2-9a-hjkmnp-z]{4}-[2-9a-hjkmnp-z]{4}$/);
  const saraKey = withHome(sara, () => createIdentity({ name: 'sara' }).key);
  enable(ana, bootstrap); enable(sara, bootstrap);
  // Sara starts looking before Ana's daemon is up, and keeps looking until it announces.
  const s = await daemon(t, sara, { conductor: false }), joining = run(sara, { type: 'join', code });
  await new Promise(resolve => setTimeout(resolve, 4000));
  const a = await daemon(t, ana, { conductor: false });
  // The joiner is told who admitted it, to check with the person who sent the code.
  assert.deepEqual(await joining, { id: teamId, name: 'core', inviter: { name: 'ana', fingerprint: a.key.slice(0, 8) } });
  assert.deepEqual(withHome(sara, () => head(teamId)), withHome(ana, () => head(teamId)));
  assert.deepEqual(withHome(ana, () => team(teamId)).members.map(m => m.name), ['ana', 'sara']);
  await until(() => online(ana, saraKey) && online(sara, a.key), 'teammates online after the join');
  // Each state.json names the version of the daemon that wrote it.
  assert.equal(state(ana).version, require('../package.json').version);
  const status = withHome(sara, () => peer.peerStatus());
  assert.equal(status.running, true); assert.equal(status.teams[0].members.find(m => m.key === a.key).path, 'direct');
  // A stopped daemon leaves its DHT routing table for the next start.
  await a.stop();
  const routing = read(ana, 'routing.json');
  assert.ok(Array.isArray(routing) && routing.length && routing.every(node => node.host && node.port));
  assert.equal(withHome(ana, () => peer.peerStatus()).running, false);
  void s;
});

test('a long code from 0.1.3 still joins over the network', async t => {
  const bootstrap = await testnet(t), ana = newHome(t), sara = newHome(t);
  const { teamId, code } = withHome(ana, () => { const me = createIdentity({ name: 'ana' }), made = createTeam(me, 'core'); return { teamId: made.id, code: longInvite(me, made.id).code }; });
  withHome(sara, () => createIdentity({ name: 'sara' }));
  enable(ana, bootstrap); enable(sara, bootstrap);
  const a = await daemon(t, ana, { conductor: false }); await daemon(t, sara, { conductor: false });
  assert.deepEqual(await run(sara, { type: 'join', code: `${code.slice(0, 200)}\n${code.slice(200)}` }), { id: teamId, name: 'core', inviter: { name: 'ana', fingerprint: a.key.slice(0, 8) } });
  assert.deepEqual(withHome(ana, () => team(teamId)).members.map(m => m.name), ['ana', 'sara']);
  await assert.rejects(run(sara, { type: 'join', code }), /already on this team/);
});

test('a joiner whose reply was lost joins again over the network with the same code', async t => {
  const bootstrap = await testnet(t), ana = newHome(t), sara = newHome(t);
  const { teamId, code } = withHome(ana, () => { const me = createIdentity({ name: 'ana' }), made = createTeam(me, 'core'); return { teamId: made.id, code: createInvite(me, made.id, { hours: 1 }) }; });
  const saraKey = withHome(sara, () => createIdentity({ name: 'sara' }).key);
  enable(ana, bootstrap); enable(sara, bootstrap);
  // Ana's daemon admits Sara, then drops the connection before its reply goes out.
  const a = await daemon(t, ana, { conductor: false, dropProveReply: true }); await daemon(t, sara, { conductor: false });
  await assert.rejects(run(sara, { type: 'join', code }), /disconnected/);
  assert.deepEqual(withHome(ana, () => team(teamId)).members.map(m => m.name), ['ana', 'sara'], 'admitted at the inviter');
  assert.equal(withHome(sara, () => team(teamId)), null, 'but not told so');
  // The same code again: Ana is still on its topic, and Sara gets the admit it missed.
  assert.deepEqual(await run(sara, { type: 'join', code }), { id: teamId, name: 'core', inviter: { name: 'ana', fingerprint: a.key.slice(0, 8) } });
  assert.equal(withHome(ana, () => readLog(teamId)).ops.filter(op => op.type === 'admit').length, 1);
  assert.deepEqual(withHome(sara, () => head(teamId)), withHome(ana, () => head(teamId)));
  await until(() => online(ana, saraKey) && online(sara, a.key), 'teammates online after the join');
});

// A daemon as 0.1.3 runs it, for the version check: a heartbeat with no version, and a
// shutdown honoured only while the saved setting says enabled false, unless told to ignore it.
const OLD_DAEMON = `const fs = require('fs'), path = require('path'), [dir, obey] = process.argv.slice(2);
const beat = stopped => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ running: !stopped, stopped, pid: process.pid, at: new Date().toISOString(), teams: [] }));
beat(false);
setInterval(() => {
  beat(false);
  const folder = path.join(dir, 'commands');
  for (const name of fs.existsSync(folder) ? fs.readdirSync(folder) : []) {
    if (name.endsWith('.result.json')) continue;
    const file = path.join(folder, name); let command; try { command = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; } fs.rmSync(file, { force: true });
    const enabled = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).enabled;
    if (command.type === 'shutdown' && obey === 'yes' && enabled === false) { beat(true); process.exit(0); }
  }
}, 100);`;
test('a daemon from another version is restarted when the daemon is started and before an invite, and one that does not stop is refused with what to do', { timeout: 180000 }, async t => {
  // Added first, so it runs before the home is removed and the testnet goes.
  const exits = []; let home = null;
  t.after(async () => { for (const kill of exits) await kill(); if (home) await withHome(home, async () => { if (peer.peerStatus().running) await stopCurrent().catch(() => {}); }); });
  const bootstrap = await testnet(t), version = require('../package.json').version; home = peerHome(t);
  const me = createIdentity({ name: 'ana' }), made = createTeam(me, 'core'); enable(home, bootstrap);
  const script = path.join(path.dirname(home), 'old-daemon.cjs'); fs.writeFileSync(script, OLD_DAEMON);
  const old = async obey => {
    const child = spawn(process.execPath, [script, peerFile(), obey], { stdio: 'ignore' });
    const exited = new Promise(resolve => child.once('exit', resolve)); exits.push(() => { child.kill('SIGKILL'); return exited; });
    await until(() => peer.peerStatus().running, 'the old daemon running', 10000);
    return { child, exited };
  };
  const current = () => { const status = peer.peerStatus(); return status.running && !status.stale && state(home)?.version === version; };
  async function stopCurrent() {
    const pid = state(home)?.pid; peer.stopPeer();
    await until(() => !peer.peerStatus().running && !(() => { try { process.kill(pid, 0); return true; } catch { return false; } })(), 'the daemon stopped', 20000);
  }
  // Starting with an old daemon running: it is shut down and this version's starts. The old
  // one is told with enabled false, which this version's ignores.
  savePeerSettings({ enabled: true });
  const first = await old('yes');
  assert.equal(peer.peerStatus().stale, true);
  assert.equal(await peer.startPeer(), true);
  await first.exited; await until(current, 'this version\'s daemon running', 30000);
  assert.equal(peer.peerSettings().enabled, false);
  await stopCurrent();
  // An invite with an old daemon running: restarted first, and the new one announces the code's topic.
  const second = await old('yes');
  const code = await peer.createInvite(made.id, { hours: 1 });
  assert.ok(current(), 'the new daemon is running when the invite is made, so the CLI says to stay online');
  await second.exited;
  await until(() => fs.readFileSync(peerFile('daemon.log'), 'utf8').includes(`invite topic ${inviteKeys(code).topic.slice(0, 8)} announced`), 'the topic announced', 30000);
  await stopCurrent();
  // One that ignores the shutdown: refused with what to do, and no invite is made.
  const stubborn = await old('no'), before = fs.readFileSync(teamPath(made.id, 'invites.json'), 'utf8');
  await assert.rejects(peer.createInvite(made.id, { hours: 1 }), /The peer daemon of another version of ELU Code did not stop\. Wait a moment, then try again\./);
  assert.equal(fs.readFileSync(teamPath(made.id, 'invites.json'), 'utf8'), before);
  assert.equal(stubborn.child.exitCode, null);
});

test('the daemon\'s teamLeave pushes the leave to the teammates online and stops on no team; one that hears it was removed from its last team stops too', async t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member.identity, pushed = [], closed = [], exits = [];
  // The member, with the founder connected, and a project that is the team's.
  await withHome(crew.member.home, async () => {
    const { root } = registeredProject(t), row = shareWith(root, { teams: [crew.teamId] }); setTeamProject(crew.teamId, row.handle);
    const daemon = Object.assign(new PeerDaemon({ conductor: () => {}, onExit: () => exits.push('sara') }), { me: sara, node: { dial: () => {}, leave: () => {} } });
    daemon.sessions.set(ana.key, { key: ana.key, admitted: true, request: async (method, params) => { pushed.push({ method, params }); return { added: 1, rejected: 0 }; }, close: reason => closed.push(reason) });
    assert.deepEqual(await daemon.command({ type: 'teamLeave', team: crew.teamId }), { team: crew.teamId, name: 'core', told: true, stopping: true });
    assert.equal(peer.leaveUnheard(), false, 'the founder took the leave, so nothing is left to tell');
    assert.equal(pushed.length, 1); assert.equal(pushed[0].method, 'elu.roster.push');
    assert.deepEqual(pushed[0].params.ops.map(op => [op.type, op.by]), [['leave', sara.key]]);
    assert.deepEqual(closed, ['no longer a teammate'], 'the connection closes after the push');
    assert.equal(peer.onTeam(), false); assert.equal(peer.peerWanted(), false);
    assert.deepEqual(peer.teamProjects(), {}, 'no project is the team\'s any more'); assert.deepEqual(peer.shares()[0].teams, [], 'and the share is open to no team');
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(daemon.command({ type: 'teamLeave', team: crew.teamId }), /Choose one of your teams\./);
  });
  assert.deepEqual(exits, ['sara']);
  // The founder takes the leave in, cannot leave, lets sara back in and removes her: still on
  // the team, the founder's daemon keeps running.
  let back = [], removal = null;
  await withHome(crew.founder.home, async () => {
    assert.equal(merge(crew.teamId, pushed[0].params.ops).added.length, 1);
    assert.deepEqual(team(crew.teamId).members.filter(m => m.key === sara.key).map(m => [m.removed, m.left]), [[true, true]]);
    const daemon = Object.assign(new PeerDaemon({ conductor: () => {}, onExit: () => exits.push('ana') }), { me: ana });
    await assert.rejects(daemon.command({ type: 'teamLeave', team: crew.teamId }), /You made core, so you cannot leave it\./);
    redeemCode(createInvite(ana, crew.teamId, { hours: 1 }), sara.key, 'sara'); back = readLog(crew.teamId).ops;
    assert.deepEqual(await daemon.command({ type: 'teamRemove', team: crew.teamId, key: sara.key }), { team: crew.teamId, name: 'core', key: sara.key, member: 'sara' });
    removal = readLog(crew.teamId).ops.at(-1); assert.equal(removal.type, 'remove');
    await new Promise(resolve => setImmediate(resolve));
  });
  assert.deepEqual(exits, ['sara']);
  // Sara is back on the team, then hears she was removed from it: on no team, her daemon stops.
  await withHome(crew.member.home, async () => {
    merge(crew.teamId, back); assert.equal(peer.onTeam(), true);
    const daemon = Object.assign(new PeerDaemon({ conductor: () => {}, onExit: () => exits.push('sara again') }), { me: sara });
    assert.deepEqual(daemon.extensions()['elu.roster.push']({ teamId: crew.teamId, ops: [removal] }, { key: ana.key }), { added: 1, rejected: 0 });
    // It stops a moment after its answer, so the answer is not lost to the close.
    await new Promise(resolve => setTimeout(resolve, 300)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(peer.onTeam(), false);
  });
  assert.deepEqual(exits, ['sara', 'sara again']);
});

// The daemon of a member, as a test drives it: dials and leaves are recorded, and nothing connects.
const memberDaemon = (me, exits, dials = []) => Object.assign(new PeerDaemon({ conductor: () => {}, onExit: () => exits.push(me.name) }), { me, node: { dial: key => dials.push(key), leave: () => {} } });

test('a leave no teammate heard keeps the daemon running and dialling them; the first to connect is given it, and then the daemon stops', async t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member.identity, exits = [], dials = [];
  const founderIds = withHome(crew.founder.home, () => readLog(crew.teamId).ops.map(op => op.id));
  // The founder's hello to sara: it still lists the team, since its log has her on it.
  const hello = withHome(crew.founder.home, () => Object.assign(new PeerDaemon({ conductor: () => {} }), { me: ana }).hello(sara.key));
  assert.deepEqual(hello.teams.map(row => row.id), [crew.teamId]);
  const pushed = [];
  await withHome(crew.member.home, async () => {
    const daemon = memberDaemon(sara, exits, dials);
    // Nobody is connected: the leave is written and noted as unheard, and the daemon does not stop.
    assert.deepEqual(await daemon.command({ type: 'teamLeave', team: crew.teamId }), { team: crew.teamId, name: 'core', told: false, stopping: false });
    assert.equal(peer.onTeam(), false); assert.equal(peer.leaveUnheard(), true); assert.equal(peer.peerWanted(), true);
    assert.deepEqual([...new Set(dials)], [ana.key], 'it dials the founder');
    assert.equal(daemon.idle(Date.now() + 3600000), false); assert.equal(daemon.alone(), false);
    // The founder connects. Its hello says it still counts sara in, so the connection only brings it up to date.
    const session = { key: ana.key, state: 'open', remoteHello: hello, close: () => {},
      request: async (method, params) => { pushed.push({ method, params }); return method === 'elu.roster.get' ? { teamId: crew.teamId, ids: founderIds } : { added: params.ops.length, rejected: 0 }; } };
    assert.equal(daemon.admit(hello, session), 'member'); assert.equal(session.departed, true);
    await daemon.sync(session);
    assert.deepEqual(pushed.map(row => row.method), ['elu.roster.get', 'elu.roster.push']);
    assert.deepEqual(pushed[1].params.ops.map(op => [op.type, op.by]), [['leave', sara.key]]);
    assert.equal(peer.leaveUnheard(), false); assert.equal(peer.peerWanted(), false);
    await new Promise(resolve => setImmediate(resolve));
  });
  assert.deepEqual(exits, ['sara'], 'with nothing left to tell, it stops');
  await withHome(crew.founder.home, async () => {
    assert.equal(merge(crew.teamId, pushed[1].params.ops).added.length, 1);
    assert.equal(team(crew.teamId).members.find(m => m.key === sara.key).left, true);
  });
});

test('an unheard leave goes with the invite proof, so the inviter lets the member back in; one whose teammates all count it out already is dropped', async t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member.identity, exits = [];
  const sent = await withHome(crew.member.home, async () => {
    const daemon = memberDaemon(sara, exits);
    assert.equal((await daemon.command({ type: 'teamLeave', team: crew.teamId })).told, false);
    const list = daemon.exitsFor(ana.key);
    assert.deepEqual(list.map(row => [row.teamId, row.ops.at(-1).type, row.ops.at(-1).by]), [[crew.teamId, 'leave', sara.key]]);
    assert.deepEqual(daemon.exitsFor('f'.repeat(64)), [], 'only for a former teammate');
    return list;
  });
  await withHome(crew.founder.home, async () => {
    const daemon = memberDaemon(ana, exits);
    const prove = (exitsSent) => {
      const code = createInvite(ana, crew.teamId, { hours: 1 }), keys = inviteKeys(code), row = openInvites([crew.teamId]).find(x => x.topic === keys.topic);
      const fields = { topic: row.topic, joinerNonce: 'a'.repeat(64), inviterNonce: 'b'.repeat(64), inviter: ana.key, joiner: sara.key };
      return daemon.extensions()['elu.invite.prove']({ proof: joinerProof(keys.seed, fields), name: 'sara', ...(exitsSent ? { exits: exitsSent } : {}) }, { key: sara.key, invite: { row, fields }, close: () => {} });
    };
    // Without the leave, the founder still has her on the team; an entry for another team is not taken.
    assert.throws(() => prove(null), /You are already on this team\./);
    assert.throws(() => prove([{ teamId: 'e'.repeat(64), ops: sent[0].ops }]), /You are already on this team\./);
    const back = prove(sent);
    assert.equal(back.teamId, crew.teamId);
    const mine = team(crew.teamId).members.find(m => m.key === sara.key);
    assert.deepEqual([mine.removed, mine.role], [false, 'member']);
    assert.ok(readLog(crew.teamId).ops.some(op => op.type === 'leave' && op.by === sara.key), 'the leave came first');
    await new Promise(resolve => setImmediate(resolve));
  });
  // Back on the team, sara's unheard leave is moot.
  await withHome(crew.member.home, async () => {
    const daemon = memberDaemon(sara, exits);
    merge(crew.teamId, withHome(crew.founder.home, () => readLog(crew.teamId).ops)); daemon.heard(crew.teamId);
    assert.equal(peer.onTeam(), true); assert.equal(peer.leaveUnheard(), false);
    assert.equal(fs.readFileSync(peerFile('unheard.json'), 'utf8').trim(), '[]');
    // She leaves again, unheard; the founder has removed her meanwhile, so its hello leaves the team out: nobody needs the leave.
    assert.equal((await daemon.command({ type: 'teamLeave', team: crew.teamId })).told, false);
    assert.equal(peer.leaveUnheard(), true);
    assert.equal(daemon.admit({ teams: [] }, { key: ana.key }), null);
    assert.equal(peer.leaveUnheard(), false); assert.equal(peer.peerWanted(), false);
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  });
  assert.deepEqual(exits, ['sara']);
});

test('elu team leave and remove start the daemon for them, and a member on no team after a leave stops it; elu peer uninstall stops it from any folder; elu peers stops an older version\'s daemon on no team', { timeout: 240000 }, async t => {
  const exits = [], crew = makeTeam(t), home = crew.member.home, founderHome = crew.founder.home;
  t.after(async () => { for (const kill of exits) await kill(); for (const h of [home, founderHome]) withHome(h, () => { if (peer.peerStatus().running) peer.stopPeer(); }); });
  const bootstrap = await testnet(t); enable(home, bootstrap); enable(founderHome, bootstrap);
  // The login item lives under HOME on macOS: a scratch one, so nothing of this machine's is touched.
  const previous = process.env.HOME; process.env.HOME = path.dirname(home);
  t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
  const gone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };
  const stopped = async (where, label) => { const pid = state(where)?.pid; await until(() => !withHome(where, () => peer.peerStatus().running) && (!pid || gone(pid)), label, 30000); };
  await withHome(home, async () => {
    // elu peer uninstall: no login item here, and the daemon stops.
    await peer.ensurePeer();
    const uninstalled = await peerCli(['peer', 'uninstall'], {});
    assert.equal(uninstalled.peerStopped, true); assert.equal(uninstalled.message, 'The peer daemon no longer starts at login, and it stopped.');
  });
  await stopped(home, 'the daemon stopped by peer uninstall');
  // elu team leave on the last team, with the founder offline: the daemon is started for it,
  // nobody is there to hear it, so it keeps running for the leave.
  const left = await withHome(home, () => peerCli(['team', 'leave'], {}));
  assert.equal(left.message, 'You left core. No teammate was online, so the first one to connect is told.');
  assert.equal(left.told, false);
  await withHome(home, async () => {
    assert.equal(peer.onTeam(), false); assert.equal(peer.peerWanted(), true); assert.equal(peer.peerStatus().running, true);
    await assert.rejects(peerCli(['team', 'leave'], {}), /Create a team first/);
  });
  // The founder comes online: sara's daemon gives it the leave, and with nothing left to tell, exits.
  await withHome(founderHome, () => peer.ensurePeer());
  await until(() => withHome(founderHome, () => team(crew.teamId).members.find(m => m.key === crew.member.identity.key).left === true), 'the founder has the leave', 90000);
  await stopped(home, 'the daemon exited once the leave was heard');
  withHome(home, () => { assert.equal(peer.leaveUnheard(), false); assert.equal(peer.peerWanted(), false); });
  // elu team remove: the founder's daemon keeps running on the team. Sara is let back in first.
  await withHome(founderHome, async () => {
    redeemCode(createInvite(crew.founder.identity, crew.teamId, { hours: 1 }), crew.member.identity.key, 'sara');
    const removed = await peerCli(['team', 'remove', 'sara'], {});
    assert.equal(removed.message, 'Removed sara from core. A new invite brings them back.');
    assert.equal(team(crew.teamId).members.find(m => m.key === crew.member.identity.key).removed, true);
    assert.equal(peer.peerStatus().running, true);
  });
  // A daemon of 0.1.5 left running on no team: elu peers stops it and starts none.
  await withHome(home, async () => {
    const script = path.join(path.dirname(home), 'old-daemon.cjs'); fs.writeFileSync(script, OLD_DAEMON);
    const child = spawn(process.execPath, [script, peerFile(), 'yes'], { stdio: 'ignore' }), exited = new Promise(resolve => child.once('exit', resolve));
    exits.push(() => { child.kill('SIGKILL'); return exited; });
    await until(() => withHome(home, () => peer.peerStatus().running && peer.peerStatus().stale), 'the old daemon running', 10000);
    const listed = await peerCli(['peers'], {});
    assert.match(listed.message, /^No team yet, so nothing runs\./);
    await exited; await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(peer.peerStatus().running, false, 'nothing started in its place');
    await assert.rejects(peerCli(['ask', '@ana', 'hi'], {}), /No team yet\. Create one with elu team create NAME, or join one with elu join CODE\./);
  });
});

test('a teammate the other side has not heard of proves it in the hello, and each side then pushes the roster ops the other lacks', async t => {
  const bootstrap = await testnet(t), founder = newHome(t), bea = newHome(t), cy = newHome(t);
  const beaKey = withHome(bea, () => createIdentity({ name: 'bea' }).key), cyKey = withHome(cy, () => createIdentity({ name: 'cy' }).key);
  const danKey = withHome(newHome(t), () => createIdentity({ name: 'dan' }).key);
  const { teamId, early, all } = withHome(founder, () => {
    const me = createIdentity({ name: 'ana' }), made = createTeam(me, 'core');
    const admit = (key, name) => redeemCode(createInvite(me, made.id, { hours: 1 }), key, name);
    admit(cyKey, 'cy'); const early = readLog(made.id).ops;
    admit(beaKey, 'bea'); admit(danKey, 'dan');
    return { teamId: made.id, early, all: readLog(made.id).ops };
  });
  // Cy joined before Bea and has heard nothing since, and made a channel Bea has not seen. Ana is away.
  withHome(cy, () => { merge(teamId, early); setChannel(loadIdentity(), teamId, { name: 'notes', members: [cyKey] }); });
  withHome(bea, () => merge(teamId, all));
  enable(bea, bootstrap); enable(cy, bootstrap);
  await daemon(t, bea, { conductor: false }); await daemon(t, cy, { conductor: false });
  const ids = home => withHome(home, () => readLog(teamId).ops.map(op => op.id).sort().join());
  await until(() => ids(bea).split(',').length === 5 && ids(bea) === ids(cy), 'both logs whole', 60000);
  assert.deepEqual(withHome(cy, () => team(teamId)).members.map(m => m.name), ['ana', 'cy', 'bea', 'dan']);
  assert.deepEqual(withHome(bea, () => team(teamId)).channels.map(row => row.name), ['notes']);
});

test('an accepted question is answered in its thread: the reply goes at once and no session is listed', async t => {
  const { ana, sara, side } = await pair(t);
  await daemon(t, ana.home, { conductor: false }); await daemon(t, sara.home, { env: side.env });
  await connected(ana, sara);
  const QUESTION = 'Where is coupon normalization?';
  const { askId } = await run(ana.home, { type: 'ask', to: 'sara', text: QUESTION });
  const incoming = await until(() => item(sara.home, 'incoming'), 'incoming ask');
  await run(sara.home, { type: 'accept', id: incoming.id });
  const answered = await until(() => askRecord(ana.home, askId)?.state === 'answered' && askRecord(ana.home, askId), 'answer at the asker with no approve step');
  assert.match(answered.answer.text, /add multiple agents/);
  const replied = await until(() => item(sara.home, 'replied'), 'the reply in Sara\'s thread');
  assert.equal(replied.threadId, answered.threadId); assert.match(replied.text, /add multiple agents/);
  assert.equal(item(sara.home, 'held'), undefined);
  // Sara's run keeps its record, but Sessions lists no session for a question.
  const projects = withHome(sara.home, () => dashboardSnapshot().projects);
  assert.ok(projects.flatMap(project => project.tasks).some(task => task.origin?.kind === 'ask'), 'the run kept its record');
  assert.deepEqual(boardRows(projects).filter(row => row.kind !== 'peer').map(row => row.label), []);
  // Each side reads the thread as a chat.
  const said = home => withHome(home, () => peer.threadMessages(answered.threadId)).map(m => [m.from, m.text]);
  assert.deepEqual(said(sara.home), [['peer', QUESTION], ['me', answered.answer.text]]);
  assert.deepEqual(said(ana.home), [['me', QUESTION], ['peer', answered.answer.text]]);
});

test('an ask waits, runs read-only after accept, is held when Sara holds replies, and reaches the asker on approve', async t => {
  const { ana, sara, side } = await pair(t);
  withHome(sara.home, () => savePeerPolicy(ana.identity.key, { holdReplies: true }));
  await daemon(t, ana.home, { conductor: false }); await daemon(t, sara.home, { env: side.env });
  await connected(ana, sara);
  const QUESTION = 'Where is coupon normalization?';
  const { askId } = await run(ana.home, { type: 'ask', to: 'sara', text: QUESTION });
  const incoming = await until(() => item(sara.home, 'incoming'), 'incoming ask');
  assert.equal(incoming.name, 'ana'); assert.equal(incoming.project, 'app'); assert.equal(incoming.text, QUESTION);
  assert.equal(incoming.request, 'ask'); assert.equal(incoming.trusted, false); assert.equal(incoming.requestId, null);
  assert.deepEqual(withHome(sara.home, () => pendingRequests(side.root)), [], 'nothing is queued until Sara decides');
  await until(() => askRecord(ana.home, askId)?.state === 'submitted', 'asker sees SUBMITTED');

  await run(sara.home, { type: 'accept', id: incoming.id });
  const row = await until(() => withHome(sara.home, () => pendingRequests(side.root)).find(r => r.origin?.a2aTaskId === incoming.taskId), 'the queued request');
  assert.ok(['queued', 'starting', 'running', 'done'].includes(row.state), row.state); assert.equal(row.readOnly, true);
  assert.equal(row.context, QUESTION); assert.doesNotMatch(row.goal, /coupon/, 'the remote text never becomes the goal');
  const held = await until(() => item(sara.home, 'held'), 'held reply');
  assert.match(held.text, /add multiple agents/); assert.equal(held.blocked, false);
  const calls = fs.readFileSync(side.fake.calls, 'utf8').trim().split('\n').map(JSON.parse).filter(c => c.vendor === 'claude' && c.args.includes('--json-schema'));
  assert.ok(calls.length >= 1);
  const args = calls.at(-1).args;
  assert.ok(args.includes('--tools')); assert.doesNotMatch(args[args.indexOf('--tools') + 1], /Write|Edit|Bash/, 'the peer run is read-only with no commands');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '0.5');
  await until(() => askRecord(ana.home, askId)?.state === 'held', 'asker sees the held state');

  await run(sara.home, { type: 'approve', id: held.id });
  const answered = await until(() => askRecord(ana.home, askId)?.state === 'answered' && askRecord(ana.home, askId), 'answer at the asker');
  assert.match(answered.answer.text, /add multiple agents/);
  const served = records(sara.home).find(r => r.task.id === answered.taskId);
  assert.equal(served.task.status.state, 'TASK_STATE_COMPLETED'); assert.equal(served.task.artifacts[0].name, 'Answer');
  const lines = withHome(sara.home, () => thread(answered.threadId));
  assert.ok(verifyThread(lines)); assert.deepEqual(lines.map(l => l.dir), ['in', 'local', 'out']);

  // A resend of the same message (the first reply was lost) returns the original task.
  withHome(ana.home, () => fs.writeFileSync(peerFile('asks', `${askId}.json`), JSON.stringify({ ...answered, state: 'pending', taskId: null, answer: null, nextAt: 0 })));
  await until(() => askRecord(ana.home, askId)?.state === 'answered', 'resent ask answered again');
  assert.equal(askRecord(ana.home, askId).taskId, answered.taskId);
  assert.equal(records(sara.home).length, 1, 'no second task for the same message');

  // Caps: with one message per thread, a second ask in the thread is rejected with the reason.
  withHome(sara.home, () => savePeerSettings({ caps: { threadMessages: 1 } }));
  const second = await run(ana.home, { type: 'ask', to: 'sara', text: 'And the tests?', threadId: answered.threadId });
  const rejected = await until(() => askRecord(ana.home, second.askId)?.state === 'rejected' && askRecord(ana.home, second.askId), 'capped ask rejected');
  assert.match(rejected.reason, /message limit/);
  assert.equal(item(ana.home, 'rejected').text, rejected.reason);
});

test('an asker offline during the run gets the answer through GetTask on reconnect', async t => {
  const { ana, sara, side } = await pair(t);
  withHome(sara.home, () => savePeerPolicy(ana.identity.key, { holdReplies: true }));
  const first = await daemon(t, ana.home, { conductor: false }); await daemon(t, sara.home, { env: side.env });
  await connected(ana, sara);
  const { askId } = await run(ana.home, { type: 'ask', to: 'sara', text: 'Which file builds the coupon?' });
  const incoming = await until(() => item(sara.home, 'incoming'), 'incoming ask');
  // Under load the SendMessage reply can reach the asker after the ask shows at sara.
  await until(() => askRecord(ana.home, askId)?.state === 'submitted', 'asker sees SUBMITTED');
  await first.stop();
  await run(sara.home, { type: 'accept', id: incoming.id });
  const held = await until(() => item(sara.home, 'held'), 'held reply');
  await run(sara.home, { type: 'approve', id: held.id });
  assert.equal(records(sara.home)[0].task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(askRecord(ana.home, askId).state, 'submitted', 'the asker was offline');
  assert.equal(item(ana.home, 'asked').state, 'submitted');
  await daemon(t, ana.home, { conductor: false });
  const answered = await until(() => askRecord(ana.home, askId)?.state === 'answered' && askRecord(ana.home, askId), 'answer after reconnect');
  assert.match(answered.answer.text, /add multiple agents/);
  assert.equal(item(ana.home, 'answer').id, `answer:${askId}`);
});

test('a member removed while away is told so at admission, and served nothing', async t => {
  const { crew, ana, sara, side } = await pair(t);
  // Sara is removed while she is away, so her log still says she is a member.
  withHome(ana.home, () => appendOp(crew.teamId, makeOp(loadIdentity(), crew.teamId, 'remove', { key: sara.identity.key })));
  // After it, dan joins and gets a channel: Sara is told she is out, and nothing written since.
  const dan = 'd'.repeat(64);
  const later = withHome(ana.home, () => { const op = redeemCode(createInvite(loadIdentity(), crew.teamId, { hours: 1 }), dan, 'dan'); return [op.id, setChannel(loadIdentity(), crew.teamId, { name: 'later', members: [ana.identity.key, dan] }).op.id]; });
  await daemon(t, ana.home, { conductor: false }); const hers = await daemon(t, sara.home, { env: side.env });
  // Ana's machine pushes her the removal on that connection and nothing else: her machine then
  // shows no team, and on no team her daemon stops.
  await until(() => withHome(sara.home, () => team(crew.teamId)).members.find(m => m.key === sara.identity.key).removed, 'the removal at sara');
  await until(() => state(sara.home)?.teams?.length === 0, 'no team at sara');
  await until(() => hers.child.exitCode !== null, 'sara\'s daemon stops on no team');
  const log = withHome(ana.home, () => fs.readFileSync(peerFile('daemon.log'), 'utf8'));
  assert.ok(log.includes(`telling ${sara.identity.key.slice(0, 8)} about a team`), log);
  assert.equal(records(ana.home).length, 0);
  assert.equal(online(sara.home, ana.identity.key), false); assert.equal(online(ana.home, sara.identity.key), false);
  assert.ok(!withHome(ana.home, () => team(crew.teamId)).members.find(m => m.key === sara.identity.key && !m.removed));
  const ids = withHome(sara.home, () => readLog(crew.teamId).ops.map(op => op.id));
  for (const id of later) assert.ok(!ids.includes(id), 'nothing after her removal');
  assert.ok(!withHome(sara.home, () => team(crew.teamId)).members.some(m => m.key === dan));
});

test('leaving and removing reach the teammates online, and the same key joins again with a new code', async t => {
  const { crew, ana, sara, side } = await pair(t);
  const a = await daemon(t, ana.home, { conductor: false }); let hers = await daemon(t, sara.home, { env: side.env });
  await connected(ana, sara);
  // The founder cannot leave; Sara cannot remove anyone.
  await assert.rejects(run(ana.home, { type: 'teamLeave', team: crew.teamId }), /You made core, so you cannot leave it\./);
  await assert.rejects(run(sara.home, { type: 'teamRemove', team: crew.teamId, key: ana.identity.key }), /Only an admin of core/);
  // Sara leaves: Ana's machine gets the op at once, and Sara's no longer lists the team or its project.
  withHome(sara.home, () => setTeamProject(crew.teamId, 'app'));
  assert.deepEqual(await run(sara.home, { type: 'teamLeave', team: crew.teamId }), { team: crew.teamId, name: 'core', told: true, stopping: true });
  await until(() => withHome(ana.home, () => team(crew.teamId)).members.find(m => m.key === sara.identity.key)?.left, `the leave at ana\n${a.log()}`);
  await until(() => state(sara.home)?.teams?.length === 0 && !state(ana.home)?.teams[0].members.some(m => m.key === sara.identity.key), 'both heartbeats');
  assert.deepEqual(read(sara.home, 'team-projects.json'), {});
  // On no team, her daemon stops; a join starts one again.
  await until(() => hers.child.exitCode !== null, 'sara\'s daemon stops after the leave');
  hers = await daemon(t, sara.home, { env: side.env });
  // A new code brings the same key back.
  const code = withHome(ana.home, () => createInvite(ana.identity, crew.teamId, { hours: 1 }));
  assert.deepEqual(await run(sara.home, { type: 'join', code }, 120000), { id: crew.teamId, name: 'core', inviter: { name: 'ana', fingerprint: ana.identity.key.slice(0, 8) } });
  await until(() => online(ana.home, sara.identity.key) && online(sara.home, ana.identity.key), 'online again');
  assert.equal(read(sara.home, 'team-projects.json')?.[crew.teamId], undefined, 'coming back shares nothing');
  // Ana removes her: Sara's machine gets it too, and then she joins once more.
  const removed = await run(ana.home, { type: 'teamRemove', team: crew.teamId, key: sara.identity.key });
  assert.deepEqual(removed, { team: crew.teamId, name: 'core', key: sara.identity.key, member: 'sara' });
  await until(() => withHome(sara.home, () => team(crew.teamId)).members.find(m => m.key === sara.identity.key)?.removed && state(sara.home)?.teams?.length === 0, 'the removal at sara');
  await until(() => hers.child.exitCode !== null, 'sara\'s daemon stops after the removal');
  hers = await daemon(t, sara.home, { env: side.env });
  const again = withHome(ana.home, () => createInvite(ana.identity, crew.teamId, { hours: 1 }));
  // The code she came back with is still in its retry window, but its admit no longer stands.
  // The refusal is followed at once by the close, so her side may see either.
  await assert.rejects(run(sara.home, { type: 'join', code }, 120000), /already used|disconnected/);
  assert.equal(withHome(ana.home, () => readLog(crew.teamId)).ops.at(-1).type, 'remove', 'nothing written for the old code');
  assert.ok(withHome(ana.home, () => team(crew.teamId)).members.find(m => m.key === sara.identity.key).removed);
  assert.equal(online(ana.home, sara.identity.key), false);
  await run(sara.home, { type: 'join', code: again }, 120000);
  await until(() => online(ana.home, sara.identity.key) && online(sara.home, ana.identity.key), 'online after the second return');
  assert.deepEqual(withHome(ana.home, () => team(crew.teamId)).members.map(m => [m.name, m.removed]), [['ana', false], ['sara', false]]);
  await until(() => JSON.stringify(withHome(ana.home, () => head(crew.teamId))) === JSON.stringify(withHome(sara.home, () => head(crew.teamId))), 'the same log on both');
});

test('review over the network, a handoff that waits for accept, and status rows with an overlap', async t => {
  const { ana, sara, side } = await pair(t, { origin: ORIGIN });
  const mine = withHome(ana.home, () => { const p = registeredProject(t, { origin: ORIGIN }); share(p.root, { handle: 'web' }); return p; });
  liveTask(mine.root, { goal: 'Trim coupon codes' });
  liveTask(side.root, { goal: 'Uppercase coupons\nand more', files: { 'src/coupon.mjs': 'export const normalize = (value) => value.toUpperCase();\n', 'README.md': 'x\n' } });
  withHome(sara.home, () => savePeerPolicy(ana.identity.key, { autoAccept: true, holdReplies: true }));
  await daemon(t, ana.home, { conductor: false }); await daemon(t, sara.home, { env: side.env });
  await connected(ana, sara);

  const agents = await until(() => { const rows = withHome(ana.home, () => peer.teamAgents()); return rows[0]?.rows.length && rows; }, 'teammate status rows');
  assert.equal(agents[0].name, 'sara'); assert.equal(agents[0].online, true);
  assert.deepEqual(agents[0].rows[0], { repoId: agents[0].rows[0].repoId, handle: 'app', taskId: '1', label: 'Uppercase coupons', now: 'ready · lead', files: ['README.md', 'src/coupon.mjs'], overlap: ['src/coupon.mjs'] });
  await until(() => withHome(sara.home, () => peer.teamAgents())[0]?.rows[0]?.overlap.includes('src/coupon.mjs'), 'overlap on the other side');

  // Review: the local task's diff goes to Sara, whose autoAccept starts the read-only run.
  const { askId } = await run(ana.home, { type: 'review', to: 'sara', root: mine.root, taskId: '1' });
  const held = await until(() => item(sara.home, 'held'), 'held review');
  const served = records(sara.home)[0];
  assert.equal(served.kind, 'review'); assert.match(served.text, /value\.trim\(\)/);
  await run(sara.home, { type: 'approve', id: held.id });
  await until(() => askRecord(ana.home, askId)?.state === 'answered', 'review answer');
  liveTask(mine.root, { id: '2', files: { 'src/coupon.mjs': `// ${'a'.repeat(96)}\n`.repeat(1700) } });
  assert.throws(() => withHome(ana.home, () => reviewText(mine.root, '2')), /over 160000 characters/);

  // A handoff is never auto-accepted: it waits with nothing queued until Sara picks w and a mode.
  const handoff = await run(ana.home, { type: 'handoff', to: 'sara', project: 'app', text: 'Add a coupon expiry check.' });
  assert.equal(handoff.pathsCut, false);
  const incoming = await until(() => item(sara.home, 'incoming', row => row.request === 'handoff'), 'waiting handoff');
  assert.equal(incoming.requestId, null);
  assert.equal(withHome(sara.home, () => pendingRequests(side.root)).some(r => r.origin?.kind === 'handoff'), false);
  await until(() => askRecord(ana.home, handoff.askId)?.state === 'submitted', 'handoff submitted');
  await assert.rejects(run(sara.home, { type: 'work', id: incoming.id }), /Pick a mode to work on a teammate's request\./);
  await run(sara.home, { type: 'work', id: incoming.id, permissions: 'ask' });
  const row = await until(() => withHome(sara.home, () => pendingRequests(side.root)).find(r => r.origin?.a2aTaskId === incoming.taskId), 'the queued work');
  assert.equal(row.readOnly, false); assert.equal(row.permissions, 'ask'); assert.equal(row.origin.kind, 'handoff');
  assert.match(row.goal, /^Work on the handoff from @ana/); assert.equal(row.context, 'Add a coupon expiry check.');
  assert.ok(item(sara.home, 'answering', row => row.request === 'handoff') || item(sara.home, 'replied') || item(sara.home, 'failed'), 'the worked handoff stays in its thread');
  // The work session runs in the mode the owner picked, and its reply waits for the owner's approval.
  const ended = await until(() => ['held', 'answered', 'failed'].includes(askRecord(ana.home, handoff.askId)?.state) && askRecord(ana.home, handoff.askId), 'the work session ended');
  assert.equal(ended.state, 'held');
});

test('an approved Task reaches a teammate\'s machine over the network, follows its changes, and leaves when it is no longer approved', async t => {
  const { ana, sara, side } = await pair(t, { origin: ORIGIN });
  const mine = withHome(ana.home, () => { const p = registeredProject(t, { origin: ORIGIN }); share(p.root, { handle: 'web' }); return p; });
  const task = (extra = {}) => ({ id: 't-0a1b2c3d', session: '1', revision: 1, title: 'Trim coupon codes', description: 'Codes arrive with spaces around them.', goal: 'A coupon code matches whatever spaces surround it.', objectives: ['Leading and trailing spaces are ignored'],
    priority: 'medium', severity: 'low', state: 'approved', startedBy: 'owner', by: 'lead', approvedAt: new Date().toISOString(), subtasks: [{ id: 's1', text: 'Trim in normalize', state: 'doing' }], met: [], edit: { repository: mine.root, request: 'trim them' }, ...extra });
  const write = tasks => withHome(ana.home, () => { const folder = path.join(repository(mine.root).state, 'tasks', '1'); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'plan.json'), JSON.stringify({ version: 1, tasks })); });
  write([task()]);
  await daemon(t, ana.home, { conductor: false }); await daemon(t, sara.home, { conductor: false, env: side.env });
  await connected(ana, sara);
  // Sara's machine has the same repository shared with the team, so Ana's Task shows in that project.
  const seen = () => withHome(sara.home, () => peer.teammateTasks(side.root));
  const first = await until(() => { const rows = seen(); return rows[0]?.tasks.length && rows; }, 'the teammate\'s Task');
  assert.deepEqual([first[0].name, first[0].online, first[0].tasks.map(row => [row.title, row.state, row.priority, row.severity, row.who, row.subtasks.map(step => step.state)])], ['ana', true, [['Trim coupon codes', 'approved', 'medium', 'low', 'model', ['doing']]]]);
  const kept = fs.readFileSync(withHome(sara.home, () => peerFile('plans', `${ana.identity.key}.json`)), 'utf8');
  for (const word of ['edit', 'trim them', mine.root]) assert.equal(kept.includes(word), false, word);
  // A subtask finishes and the Task is done: the other side follows.
  write([task({ state: 'done', doneAt: new Date().toISOString(), subtasks: [{ id: 's1', text: 'Trim in normalize', state: 'done' }], met: [1] })]);
  await until(() => seen()[0]?.tasks[0]?.state === 'done' && seen()[0].tasks[0].met.length === 1, 'the finished Task');
  // No approved Task in the session any more: it leaves the teammate's side.
  write([task({ state: 'rejected' })]);
  await until(() => seen().length === 0, 'the Task withdrawn');
  // Nothing of Sara's goes to Ana: she has no Task.
  assert.deepEqual(withHome(ana.home, () => peer.teammateTasks(mine.root)), []);
});

test('autoAccept answers end to end, autoContinue queues the chat, and a secret keeps a reply held', async t => {
  const { ana, sara, side } = await pair(t);
  const mine = withHome(ana.home, () => registeredProject(t));
  withHome(sara.home, () => savePeerPolicy(ana.identity.key, { autoAccept: true }));
  withHome(ana.home, () => { savePeerPolicy(sara.identity.key, { autoContinue: true }); savePeerSettings({ localA2A: true }); });
  await daemon(t, ana.home, { conductor: false }); await daemon(t, sara.home, { env: side.env });
  await connected(ana, sara);

  const { askId } = await run(ana.home, { type: 'ask', to: 'sara', text: 'How do I add agents?', root: mine.root, chatTaskId: '7' });
  const answered = await until(() => askRecord(ana.home, askId)?.continued && askRecord(ana.home, askId), 'answered and continued');
  assert.match(answered.answer.text, /add multiple agents/);
  const follow = withHome(ana.home, () => pendingRequests(mine.root)).find(r => r.origin?.kind === 'answer');
  assert.equal(follow.continuationTaskId, '7'); assert.equal(follow.priority, 0); assert.equal(follow.context, answered.answer.text);
  assert.equal(item(ana.home, 'answer'), undefined, 'a continued answer leaves the list');

  // The local A2A endpoint turns SendMessage at /a2a/peer/sara into an ask; GetTask follows it.
  const local = await until(() => read(ana.home, 'local-a2a.json'), 'local A2A endpoint');
  const call = async (method, params) => (await (await fetch(`http://127.0.0.1:${local.port}/a2a/peer/sara`, { method: 'POST', headers: { Authorization: `Bearer ${local.token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
  const viaLocal = await call('SendMessage', { message: { messageId: 'local-1', role: 'ROLE_USER', parts: [{ text: 'Asked from another A2A tool.' }] } });
  assert.equal(viaLocal.result.task.status.state, 'TASK_STATE_SUBMITTED');
  const completed = await until(() => askRecord(ana.home, viaLocal.result.task.id)?.state === 'answered', 'local ask answered');
  assert.ok(completed);
  const got = await call('GetTask', { id: viaLocal.result.task.id });
  assert.equal(got.result.status.state, 'TASK_STATE_COMPLETED'); assert.match(got.result.artifacts[0].parts[0].text, /add multiple agents/);

  // An approved agent draft is sent as an ask.
  const draftId = 'aaaaaaaa-1111-4222-8333-444444444444';
  withHome(ana.home, () => fs.mkdirSync(peerFile('drafts'), { recursive: true }));
  withHome(ana.home, () => fs.writeFileSync(peerFile('drafts', `${draftId}.json`), JSON.stringify({ id: draftId, to: 'sara', project: null, question: 'Is the cache safe?', root: mine.root, taskId: '7', threadId: null, createdAt: new Date().toISOString(), state: 'draft' })));
  assert.equal(item(ana.home, 'draft').id, `draft:${draftId}`);
  const sent = await run(ana.home, { type: 'approve', id: `draft:${draftId}` });
  await until(() => askRecord(ana.home, sent.askId)?.state === 'answered', 'draft answered');
  assert.equal(read(ana.home, 'drafts', `${draftId}.json`).state, 'sent');

  // A reply with a secret is held though replies go at once, and cannot be approved as it is.
  side.fake.summary(`Call it with ${ACCESS_KEY} as the key.`);
  const secret = await run(ana.home, { type: 'ask', to: 'sara', text: 'Which key do I use?' });
  const held = await until(() => item(sara.home, 'held'), 'blocked reply');
  assert.equal(held.blocked, true); assert.deepEqual(held.problems, ['aws-access-key']);
  await until(() => askRecord(ana.home, secret.askId)?.state === 'held', 'asker sees it held');
  await assert.rejects(run(sara.home, { type: 'approve', id: held.id }), /possible secret/);
  await assert.rejects(run(sara.home, { type: 'approve', id: held.id, text: `Still ${ACCESS_KEY}.` }), /still contains a possible secret/);
  await run(sara.home, { type: 'approve', id: held.id, text: 'Use the key from your own vault.' });
  const fixed = await until(() => askRecord(ana.home, secret.askId)?.state === 'answered' && askRecord(ana.home, secret.askId), 'edited reply');
  assert.equal(fixed.answer.text, 'Use the key from your own vault.');
});

// Relaying: on loopback hyperdht takes the LAN shortcut, so the testnet runs on a LAN
// address, and both daemons turn off holepunching, fast open and the LAN path, as
// hyperdht's own test/relaying.js does. Hyperswarm then retries through the relay array.
const lan = Object.values(os.networkInterfaces()).flat().find(row => row?.family === 'IPv4' && !row.internal)?.address;
test('a relayed connection carries an ask and its answer, and the relay refuses strangers', { skip: lan ? false : 'This machine has no non-loopback IPv4 address for the testnet.' }, async t => {
  const bootstrap = await testnet(t, lan), crew = makeTeam(t), ana = crew.founder, sara = crew.member;
  const side = answering(t, sara.home);
  // The relay runs in this process with a home of its own that holds a copy of the roster.
  const relayHome = newHome(t), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = relayHome; t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  fs.cpSync(withHome(ana.home, () => peerFile('teams')), peerFile('teams'), { recursive: true });
  const { runRelay } = await import('../lib/peer/relay.mjs');
  const relay = await runRelay({ identity: createIdentity({ name: 'relay' }), bootstrap, testing: { dht: { quickFirewall: false, ephemeral: true } } });
  t.after(() => relay.close());
  for (const home of [ana.home, sara.home]) enable(home, bootstrap, { relays: [relay.key] });
  withHome(sara.home, () => savePeerPolicy(ana.identity.key, { autoAccept: true }));
  await daemon(t, ana.home, { conductor: false, noPunch: true }); await daemon(t, sara.home, { env: side.env, noPunch: true });
  await connected(ana, sara);
  const path = state(ana.home).teams[0].members.find(m => m.key === sara.identity.key).path;
  assert.equal(path, 'relayed');
  const { askId } = await run(ana.home, { type: 'ask', to: 'sara', text: 'Through the relay?' });
  await until(() => askRecord(ana.home, askId)?.state === 'answered', 'relayed answer');
  assert.ok(relay.stats().sessions.accepted >= 2 && relay.stats().pairings.matched >= 1); assert.ok(state(ana.home).counters.relayed >= 1);

  const DHT = require('hyperdht'), stranger = new DHT({ bootstrap: bootstrap.map(row => ({ host: row.split(':')[0], port: Number(row.split(':')[1]) })) });
  t.after(() => stranger.destroy());
  const socket = stranger.connect(Buffer.from(relay.key, 'hex'));
  const outcome = await new Promise(resolve => { socket.on('open', () => resolve('open')); socket.on('error', error => resolve(error.code ?? 'error')); socket.on('close', () => resolve('closed')); });
  assert.notEqual(outcome, 'open', 'a key outside the team gets no relay session');
});
