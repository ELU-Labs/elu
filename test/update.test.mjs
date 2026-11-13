import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CLI, temp } from './helpers.mjs';
import { peerHome } from './peer-helpers.mjs';
import { REGISTRY, latestVersion, noticeText, openApps, registryUrl, runUpdate, updateNotice } from '../lib/update.mjs';
import { Conductor, conductorAlive } from '../lib/conductor.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { createTeam } from '../lib/peer/roster.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { processIdentity } from '../lib/process.mjs';

const NAME = '@elu-labs/elu';
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  for (const started = Date.now(); !(await check());) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`); await pause(50); }
}
// A registry on this computer. body is what /@elu-labs/elu/latest answers; null never answers.
async function registry(t, body = { name: NAME, version: '3.3.0' }) {
  const seen = [], state = { body, status: 200 };
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url, method: request.method, headers: request.headers });
    if (state.body === null) return;
    response.writeHead(state.status, { 'content-type': 'application/json' }); response.end(typeof state.body === 'string' ? state.body : JSON.stringify(state.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}/${NAME}/latest`, seen, state };
}
// The state folder of this test, so nothing reads or writes the real one.
function personal(t) {
  const config = path.join(temp(t), 'config'), previous = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = config;
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  return path.join(config, 'elu-code');
}
// The command line, run without blocking this process: the registry it asks is served here.
function cli(args, cwd, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
}
// A package under an npm prefix, linked from its bin folder the way npm links one.
function place(prefix, { version, entry = '' }) {
  const root = path.join(prefix, 'lib', 'node_modules', '@elu-labs', 'elu');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true }); fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: NAME, version }));
  fs.writeFileSync(path.join(root, 'bin', 'elu.cjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
  if (entry) fs.writeFileSync(path.join(root, 'bin', 'elu-code.mjs'), entry);
  fs.rmSync(path.join(prefix, 'bin', 'elu'), { force: true });
  fs.symlinkSync(path.relative(path.join(prefix, 'bin'), path.join(root, 'bin', 'elu.cjs')), path.join(prefix, 'bin', 'elu'));
  return root;
}
// elu installed at 3.2.1 under a global folder, and an npm that installs what it is asked for there.
function installed(t, { entry = '' } = {}) {
  const dir = temp(t), home = path.join(dir, 'home'), prefix = path.join(dir, 'global'); fs.mkdirSync(home);
  const root = place(prefix, { version: '3.2.1', entry }), calls = [], said = [];
  const run = (npm, args, options) => {
    calls.push({ args, options });
    if (args[0] === 'prefix') return { status: 0, stdout: `${prefix}\n`, stderr: '' };
    place(prefix, { version: args.at(-1).split('@').at(-1), entry });
    return { status: 0, stdout: '', stderr: '' };
  };
  return { dir, home, prefix, root, calls, said, update: (options = {}) => runUpdate({ home, npm: ['npm'], run, write: text => said.push(text), apps: () => 0, waitMs: 15000, ...options, env: { HOME: home, PATH: `${path.join(prefix, 'bin')}:/usr/bin`, ...options.env } }) };
}

test('the registry address is npm\'s, and only an http address on this computer replaces it', () => {
  assert.equal(REGISTRY, 'https://registry.npmjs.org/@elu-labs/elu/latest');
  assert.equal(registryUrl({}), REGISTRY);
  for (const url of ['http://127.0.0.1:4873/x', 'http://localhost:9/x']) assert.equal(registryUrl({ ELU_UPDATE_REGISTRY: url }), url);
  for (const url of ['https://example.com/x', 'http://example.com/x', 'http://127.0.0.1.example.com/x', 'file:///etc/passwd', 'nonsense']) assert.equal(registryUrl({ ELU_UPDATE_REGISTRY: url }), REGISTRY, url);
});

test('the latest version is read from the registry, and anything else is no answer', async t => {
  const r = await registry(t), env = { ELU_UPDATE_REGISTRY: r.url };
  assert.equal(await latestVersion({ env }), '3.3.0');
  // One plain GET with no cookie, token or anything about this computer.
  assert.equal(r.seen.length, 1); assert.equal(r.seen[0].method, 'GET'); assert.equal(r.seen[0].url, '/@elu-labs/elu/latest');
  assert.deepEqual(Object.keys(r.seen[0].headers).filter(name => /cookie|authorization|token/i.test(name)), []);
  for (const body of [{ version: '3.3.0-beta.1' }, { version: '3.3' }, { version: 3 }, { name: NAME }, 'not json', { version: '1.2.3; rm -rf ~' }]) { r.state.body = body; assert.equal(await latestVersion({ env }), null, JSON.stringify(body)); }
  r.state.body = { version: '3.3.0' }; r.state.status = 500; assert.equal(await latestVersion({ env }), null);
  // A registry that does not answer in time, and one that is not there.
  r.state.body = null; const started = Date.now();
  assert.equal(await latestVersion({ env, timeoutMs: 300 }), null);
  assert.ok(Date.now() - started < 3000);
  assert.equal(await latestVersion({ env: { ELU_UPDATE_REGISTRY: 'http://127.0.0.1:9/x' } }), null);
});

test('the new-version line: at most one check a day, kept in the state folder, and nothing when current, offline or turned off', async t => {
  const dir = personal(t), file = path.join(dir, 'update-check.json'), now = Date.parse('2026-11-12T09:00:00Z');
  let calls = 0, answer = '3.3.0';
  const latest = async () => { calls++; return answer; }, check = (options = {}) => updateNotice({ env: {}, current: '3.2.1', latest, now, ...options });
  assert.equal(await check(), 'ELU 3.3.0 is out. /quit, then elu update.');
  assert.equal(noticeText('3.3.0'), 'ELU 3.3.0 is out. /quit, then elu update.');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { checkedAt: '2026-11-12T09:00:00.000Z', version: '3.3.0' });
  // The same day reads what was kept and asks nothing.
  assert.equal(await check({ now: now + 23 * 3600000 }), 'ELU 3.3.0 is out. /quit, then elu update.');
  assert.equal(calls, 1);
  // Once current, nothing is said.
  assert.equal(await check({ current: '3.3.0', now: now + 3600000 }), null);
  assert.equal(await check({ current: '3.10.0', now: now + 3600000 }), null);
  // A day later it asks again.
  answer = '3.4.0';
  assert.equal(await check({ now: now + 25 * 3600000 }), 'ELU 3.4.0 is out. /quit, then elu update.');
  assert.equal(calls, 2);
  // Offline: nothing new is said, the last version seen is kept, and the next check is a day on.
  fs.rmSync(file); answer = null;
  assert.equal(await check(), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { checkedAt: '2026-11-12T09:00:00.000Z', version: null });
  assert.equal(await check({ now: now + 3600000 }), null); assert.equal(calls, 3);
  // A kept time in the future is not trusted.
  fs.writeFileSync(file, JSON.stringify({ checkedAt: '2027-01-01T00:00:00Z', version: '3.2.1' })); answer = '3.5.0';
  assert.equal(await check(), 'ELU 3.5.0 is out. /quit, then elu update.'); assert.equal(calls, 4);
  // Off: ELU_NO_UPDATE_CHECK=1, and in tests.
  fs.rmSync(file);
  assert.equal(await check({ env: { ELU_NO_UPDATE_CHECK: '1' } }), null);
  assert.equal(await check({ env: { NODE_TEST_CONTEXT: 'child-v8' } }), null);
  assert.equal(await updateNotice({ current: '0.0.1', latest }), null, 'this test runs under node --test');
  assert.equal(calls, 4); assert.equal(fs.existsSync(file), false);
});

test('elu update installs the newer version where elu is and says so; when current, offline or open elsewhere it changes nothing', async t => {
  personal(t);
  const r = await registry(t), s = installed(t), env = { ELU_UPDATE_REGISTRY: r.url };
  const done = await s.update({ env });
  assert.equal(done.message, 'Updated ELU 3.2.1 → 3.3.0. Open it again with elu.');
  assert.deepEqual(s.calls.map(call => call.args), [['prefix', '--global'], ['install', '--global', '--ignore-scripts', '@elu-labs/elu@3.3.0']]);
  assert.deepEqual(s.said, ['Installing ELU 3.3.0: npm install --global --ignore-scripts @elu-labs/elu@3.3.0\n']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.root, 'package.json'), 'utf8')).version, '3.3.0');
  for (const call of s.calls) assert.equal(call.options.cwd, s.home);
  // Current now.
  s.calls.length = 0;
  assert.equal((await s.update({ env })).message, 'ELU 3.3.0 is the latest.');
  r.state.body = { version: '3.2.9' };
  assert.equal((await s.update({ env })).message, 'ELU 3.3.0 is the latest.', 'an older latest is not a downgrade');
  // Offline.
  const offline = await s.update({ env: { ELU_UPDATE_REGISTRY: 'http://127.0.0.1:9/x' } });
  assert.deepEqual([offline.success, offline.message], [false, 'Could not reach the npm registry. Check your connection, then run elu update again.']);
  // Open in another terminal: nothing is replaced under it.
  r.state.body = { version: '3.4.0' };
  const open = await s.update({ env, apps: () => 1 });
  assert.deepEqual([open.success, open.message], [false, 'ELU is open in another terminal. /quit it there, then run elu update again.']);
  assert.deepEqual(s.calls, []);
  // A failed install says how to update by hand.
  const failed = await runUpdate({ home: s.home, npm: ['npm'], apps: () => 0, run: (npm, args) => args[0] === 'prefix' ? { status: 0, stdout: `${s.prefix}\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'npm error code EACCES\n' }, env: { HOME: s.home, PATH: `${path.join(s.prefix, 'bin')}:/usr/bin`, ...env } });
  assert.deepEqual([failed.success, failed.message], [false, 'The update did not work (code EACCES). To update by hand: npm install --global --ignore-scripts @elu-labs/elu@3.4.0']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.root, 'package.json'), 'utf8')).version, '3.3.0');
});

test('the line to update by hand installs under ~/.local when elu is there, after npm fails or when npm is missing', async t => {
  personal(t);
  const dir = temp(t), home = path.join(dir, 'home'), npmGlobal = path.join(dir, 'global'), empty = path.join(dir, 'empty'); fs.mkdirSync(empty);
  place(path.join(home, '.local'), { version: '3.2.1' });
  const calls = [], run = (npm, args) => { calls.push(args); return args[0] === 'prefix' ? { status: 0, stdout: `${npmGlobal}\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'npm error code ETIMEDOUT\n' }; };
  const update = options => runUpdate({ home, run, latest: async () => '3.4.0', apps: () => 0, env: { HOME: home, PATH: empty }, ...options });
  const line = `npm install --global --prefix ${path.join(home, '.local')} --ignore-scripts @elu-labs/elu@3.4.0`;
  const failed = await update({ npm: ['npm'] });
  assert.deepEqual(calls, [['prefix', '--global'], line.split(' ').slice(1)]);
  assert.deepEqual([failed.success, failed.message], [false, `The update did not work (code ETIMEDOUT). To update by hand: ${line}`]);
  const missing = await update({ npm: null });
  assert.deepEqual([missing.success, missing.message], [false, `npm was not found. To update by hand: ${line}`]);
  assert.equal(calls.length, 2);
  // With no installed command to go by, the line is npm's own.
  fs.rmSync(path.join(home, '.local'), { recursive: true });
  assert.equal((await update({ npm: null })).message, 'npm was not found. To update by hand: npm install --global --ignore-scripts @elu-labs/elu@3.4.0');
});

test('elu update from the command line asks the registry and prints one line', async t => {
  // elu at this version in a folder of the test's own, and nothing else of this computer on
  // PATH: node's folder could hold the elu installed here, and an older one would be updated.
  const r = await registry(t, { version: VERSION }), home = temp(t), prefix = path.join(temp(t), 'global');
  place(prefix, { version: VERSION });
  const files = () => fs.readdirSync(prefix, { recursive: true }).sort().map(name => { const stat = fs.lstatSync(path.join(prefix, name)); return [name, stat.size, stat.mtimeMs]; }), before = files();
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: `${path.join(prefix, 'bin')}:/usr/bin:/bin`, ELU_UPDATE_REGISTRY: r.url };
  const current = await cli(['update'], home, env);
  assert.equal(current.status, 0, current.stderr);
  assert.equal(current.stdout, `ELU ${VERSION} is the latest.\n`);
  const json = await cli(['update', '--json'], home, env);
  assert.equal(JSON.parse(json.stdout).message, `ELU ${VERSION} is the latest.`);
  const offline = await cli(['update'], home, { ...env, ELU_UPDATE_REGISTRY: 'http://127.0.0.1:9/x' });
  assert.equal(offline.status, 1);
  assert.match(offline.stdout + offline.stderr, /Could not reach the npm registry\./);
  const extra = await cli(['update', 'now'], home, env);
  assert.equal(extra.status, 1); assert.equal(extra.stderr, 'Use elu update.\n');
  assert.match((await cli(['--help'], home, env)).stdout, /^ {2}update$/m);
  // Nothing was installed.
  assert.deepEqual(files(), before);
});

test('an open app counts only while its process lives, and this process never counts', t => {
  const dir = personal(t); fs.mkdirSync(dir, { recursive: true });
  const lockOf = (pid, identity) => fs.writeFileSync(path.join(dir, `view-${'a'.repeat(63)}${pid % 10}.lock`), JSON.stringify({ pid, identity }));
  assert.equal(openApps(), 0);
  lockOf(process.pid, processIdentity(process.pid)); assert.equal(openApps(), 0);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); t.after(() => child.kill('SIGKILL'));
  lockOf(child.pid, processIdentity(child.pid)); assert.equal(openApps(), 1);
  fs.writeFileSync(path.join(dir, `view-${'b'.repeat(64)}.lock`), JSON.stringify({ pid: child.pid, identity: 'another process' }));
  assert.equal(openApps(), 1);
});

// A peer daemon of the old version: it keeps state.json fresh, and stops on a shutdown when obey is yes.
const OLD_DAEMON = `const fs = require('fs'), path = require('path'), [dir, obey] = process.argv.slice(2);
const beat = stopped => { const file = path.join(dir, 'state.json'), tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ running: !stopped, stopped, pid: process.pid, version: '3.2.1', at: new Date().toISOString(), teams: [] })); fs.renameSync(tmp, file); };
beat(false);
setInterval(() => {
  beat(false);
  const folder = path.join(dir, 'commands');
  for (const name of fs.existsSync(folder) ? fs.readdirSync(folder) : []) {
    if (name.endsWith('.result.json')) continue;
    const file = path.join(folder, name); let command; try { command = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; } fs.rmSync(file, { force: true });
    if (command.type === 'shutdown' && obey === 'yes') { beat(true); process.exit(0); }
  }
}, 100);`;
test('elu update stops the old peer daemon, waits until it is gone, and starts the new version\'s; one that does not stop is named', { timeout: 120000 }, async t => {
  const home = peerHome(t), r = await registry(t), mark = path.join(path.dirname(home), 'started.json');
  createTeam(createIdentity({ name: 'ana' }), 'core');
  const entry = `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(mark)}, JSON.stringify({ args: process.argv.slice(2), version: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version }));\n`;
  const s = installed(t, { entry }), script = path.join(path.dirname(home), 'old-daemon.cjs'); fs.writeFileSync(script, OLD_DAEMON);
  const old = async obey => {
    fs.mkdirSync(peerFile(), { recursive: true });
    const child = spawn(process.execPath, [script, peerFile(), obey], { stdio: 'ignore' }), exited = new Promise(resolve => child.once('exit', resolve));
    t.after(() => { child.kill('SIGKILL'); return exited; });
    await until(() => fs.existsSync(peerFile('state.json')) && JSON.parse(fs.readFileSync(peerFile('state.json'), 'utf8')).pid === child.pid, 'the old daemon running');
    return { child, exited };
  };
  const first = await old('yes');
  const done = await s.update({ env: { ELU_UPDATE_REGISTRY: r.url } });
  assert.equal(done.message, 'Updated ELU 3.2.1 → 3.3.0. Open it again with elu.');
  // The old one had exited before the new one was started, from the copy just installed.
  assert.equal(first.child.exitCode, 0);
  await until(() => fs.existsSync(mark), 'the new daemon started');
  assert.deepEqual(JSON.parse(fs.readFileSync(mark, 'utf8')), { args: ['peer', '--daemon'], version: '3.3.0' });
  // One that ignores the shutdown is left running and named.
  fs.rmSync(mark); fs.rmSync(peerFile('state.json')); r.state.body = { version: '3.4.0' };
  const stubborn = await old('no');
  const stuck = await s.update({ env: { ELU_UPDATE_REGISTRY: r.url }, waitMs: 1000 });
  assert.equal(stuck.message, 'Updated ELU 3.3.0 → 3.4.0. Open it again with elu.\nThe old peer daemon did not stop. Open ELU and it restarts it.');
  assert.equal(stubborn.child.exitCode, null); assert.equal(fs.existsSync(mark), false);
});

test('elu update stops an idle conductor and leaves one with sessions running to finish them', { timeout: 120000 }, async t => {
  const dir = personal(t), r = await registry(t), s = installed(t), env = { ELU_UPDATE_REGISTRY: r.url };
  // A conductor running a session: it is not stopped, and the line says what happens.
  const busy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }), gone = new Promise(resolve => busy.once('exit', resolve));
  t.after(() => { busy.kill('SIGKILL'); return gone; });
  fs.mkdirSync(path.join(dir, 'conductor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'conductor.lock'), JSON.stringify({ pid: busy.pid, identity: processIdentity(busy.pid) }));
  fs.writeFileSync(path.join(dir, 'conductor', 'state.json'), JSON.stringify({ pid: busy.pid, version: '3.2.1', stopped: false, heartbeatAt: new Date().toISOString(), runs: [{ root: '/x', taskId: '1' }] }));
  assert.equal(conductorAlive(), true);
  const kept = await s.update({ env });
  assert.equal(kept.message, 'Updated ELU 3.2.1 → 3.3.0. Open it again with elu.\n1 running session finishes on 3.2.1. New sessions start on the new version.');
  assert.equal(busy.exitCode, null);
  assert.equal(fs.existsSync(path.join(dir, 'conductor', 'commands')) ? fs.readdirSync(path.join(dir, 'conductor', 'commands')).length : 0, 0);
  // Sessions only queued keep it too: it hands them to the new version's conductor by itself.
  fs.writeFileSync(path.join(dir, 'conductor', 'state.json'), JSON.stringify({ pid: busy.pid, version: '3.3.0', stopped: false, heartbeatAt: new Date().toISOString(), runs: [], queued: 2 }));
  r.state.body = { version: '3.3.1' };
  assert.equal((await s.update({ env })).message, 'Updated ELU 3.3.0 → 3.3.1. Open it again with elu.');
  assert.equal(busy.exitCode, null);
  assert.equal(fs.existsSync(path.join(dir, 'conductor', 'commands')) ? fs.readdirSync(path.join(dir, 'conductor', 'commands')).length : 0, 0);
  busy.kill('SIGKILL'); await gone; fs.rmSync(path.join(dir, 'conductor.lock'));
  // An idle conductor, the real one: stopped, and gone before elu update returns.
  const conductor = spawn(process.execPath, [CLI, 'conductor', '--daemon'], { cwd: s.home, env: { ...process.env, HOME: s.home, XDG_CONFIG_HOME: path.dirname(dir) }, stdio: 'ignore' }), ended = new Promise(resolve => conductor.once('exit', resolve));
  t.after(() => { conductor.kill('SIGKILL'); return ended; });
  await until(() => conductorAlive(), 'the conductor running');
  r.state.body = { version: '3.4.0' };
  assert.equal((await s.update({ env })).message, 'Updated ELU 3.3.1 → 3.4.0. Open it again with elu.');
  assert.equal(conductorAlive(), false);
  await ended;
});

test('an idle conductor whose files an update replaced exits, so the next work starts the new code', async t => {
  personal(t);
  let exits = 0;
  const same = new Conductor({ tickMs: 20, onExit: () => { exits++; }, version: '3.2.1', onDisk: () => '3.2.1' }).start();
  await pause(300); await same.stop();
  assert.equal(exits, 0);
  const replaced = new Conductor({ tickMs: 20, onExit: () => { exits++; }, version: '3.2.1', onDisk: () => '3.3.0' }).start();
  await until(() => exits > 0, 'the conductor exits'); await replaced.stop();
  // Files half written during the install read as nothing: no exit for that.
  exits = 0;
  const halfway = new Conductor({ tickMs: 20, onExit: () => { exits++; }, version: '3.2.1', onDisk: () => null }).start();
  await pause(300); await halfway.stop();
  assert.equal(exits, 0);
});
