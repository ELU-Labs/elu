import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { temp } from './helpers.mjs';
import { lock, waitLock } from '../lib/state.mjs';
import { processIdentity } from '../lib/process.mjs';

const lib = new URL('../lib/state.mjs', import.meta.url).href;

test('a lock is never found half written or missing: a process taking and releasing it all the time never breaks another', async t => {
  const state = temp(t);
  // The other process takes and releases the same lock without pause. Any answer but the
  // lock or "held" ends it with the message.
  const script = `import { lock } from ${JSON.stringify(lib)}; const repo = { state: ${JSON.stringify(state)} }; console.log('ready');
    for (;;) { try { lock(repo, 'busy')(); } catch (error) { if (!/holds this lock/.test(error.message)) { console.log('BROKEN ' + (error.stack || error.message)); process.exit(3); } } }`;
  const other = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  let said = ''; other.stdout.on('data', chunk => { said += chunk; });
  t.after(() => other.kill('SIGKILL'));
  for (const until = Date.now() + 10000; !said.includes('ready');) { assert.ok(Date.now() < until && other.exitCode === null, `the other process starts: ${said}`); await new Promise(resolve => setTimeout(resolve, 20)); }
  let taken = 0, held = 0;
  for (const until = Date.now() + 2000; Date.now() < until;) {
    try { lock({ state }, 'busy')(); taken++; }
    catch (error) { assert.match(error.message, /holds this lock/, `only the lock or "held" is an answer: ${error.stack}`); held++; }
    if ((taken + held) % 50 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  assert.doesNotMatch(said, /BROKEN/, said); assert.equal(other.exitCode, null, `the other process is still at it: ${said}`);
  assert.ok(taken > 0, `this process took the lock ${taken} times and found it held ${held} times`);
  // A waiting taker gets it too, and nothing is left beside the lock when all is released.
  waitLock({ state }, 'busy', 500)();
  other.kill('SIGKILL'); await new Promise(resolve => other.once('exit', resolve));
  assert.deepEqual(fs.readdirSync(state).filter(name => !/^busy\.lock(\.\d+\.tmp)?$/.test(name)), []);
});

test('a lock left by a process that is gone is taken over, one held by a live process is not, and half a lock is not an error', t => {
  const state = temp(t), file = path.join(state, 'x.lock');
  const gone = Number(spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim());
  fs.writeFileSync(file, JSON.stringify({ pid: gone, identity: 'a process that ended' }));
  const release = lock({ state }, 'x');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  assert.throws(() => lock({ state }, 'x'), /holds this lock/);
  release(); assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, identity: processIdentity(process.ppid) }));
  assert.throws(() => lock({ state }, 'x'), /holds this lock/);
  // Half a lock, as a file system without hard links could show it: held while it is new, removed once it is old.
  fs.writeFileSync(file, '{"pid":');
  assert.throws(() => lock({ state }, 'x'), /holds this lock/);
  const old = new Date(Date.now() - 60000); fs.utimesSync(file, old, old);
  lock({ state }, 'x')(); assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(state), []);
});

// Two ELU processes whose time zones differ: the app in a terminal, and a daemon that a login
// item or another daemon started. Each look at the lock is a process of its own in that zone.
const zone = (TZ, more = {}) => ({ ...process.env, TZ, ...more });
const look = (state, name, env) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { lock } from ${JSON.stringify(lib)};
  try { lock({ state: ${JSON.stringify(state)} }, ${JSON.stringify(name)}); console.log('taken'); } catch (error) { console.log(error.message); }`], { encoding: 'utf8', env }).stdout.trim();
// What 0.1.19 and earlier wrote as a holder's identity: the line ps printed for the writer.
const written = (pid, env) => spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', env }).stdout.trim();
const ctime = date => { const [day, dd, month, year, time] = date.toUTCString().replace(',', '').split(' '); return `${day} ${month} ${String(Number(dd)).padStart(2)} ${time} ${year}`; };

test('a lock held by a process in another time zone is held, and is taken over once that process is gone', async t => {
  const state = temp(t), file = path.join(state, 'view.lock');
  const script = `import { lock } from ${JSON.stringify(lib)}; lock({ state: ${JSON.stringify(state)} }, 'view'); console.log('held'); setInterval(() => {}, 1000);`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', script], { env: zone('America/Los_Angeles'), stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill('SIGKILL'));
  let said = ''; holder.stdout.on('data', chunk => { said += chunk; });
  for (const until = Date.now() + 10000; !said.includes('held');) { assert.ok(Date.now() < until && holder.exitCode === null, 'the holder takes the lock'); await new Promise(resolve => setTimeout(resolve, 20)); }
  for (const env of [zone('UTC'), zone('Asia/Kolkata'), zone('America/Los_Angeles'), zone('Europe/Berlin', { LC_ALL: 'de_DE.UTF-8', COLUMNS: '40' })]) {
    assert.match(look(state, 'view', env), /holds this lock/, `seen from ${env.TZ}`);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, holder.pid, `still the holder's, seen from ${env.TZ}`);
  }
  holder.kill('SIGKILL'); await new Promise(resolve => holder.once('exit', resolve));
  assert.equal(look(state, 'view', zone('UTC')), 'taken');
});

test('a lock written by 0.1.19 is held while its process runs, whatever time zone wrote it, and taken over when another process has its number', async t => {
  const state = temp(t), file = path.join(state, 'x.lock');
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  for (const wrote of ['America/Los_Angeles', 'Asia/Kathmandu', 'UTC']) {
    const identity = written(child.pid, zone(wrote)); assert.match(identity, /^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4} .*setInterval/);
    for (const reads of ['UTC', 'Europe/Berlin', 'America/Los_Angeles']) {
      fs.writeFileSync(file, JSON.stringify({ pid: child.pid, identity }));
      assert.match(look(state, 'x', zone(reads)), /holds this lock/, `written in ${wrote}, read in ${reads}`);
    }
  }
  // The line as ps cut it for a writer whose COLUMNS was set: the same process still.
  fs.writeFileSync(file, JSON.stringify({ pid: child.pid, identity: written(child.pid, zone('America/Los_Angeles', { COLUMNS: '40' })) }));
  assert.match(look(state, 'x', zone('UTC')), /holds this lock/);
  // The same number, another process: one that started seven minutes later, and one that runs another command.
  const now = written(child.pid, zone('UTC')), stamp = now.slice(0, 24), command = now.slice(25);
  fs.writeFileSync(file, JSON.stringify({ pid: child.pid, identity: `${ctime(new Date(Date.parse(`${stamp} UTC`) + 7 * 60000))} ${command}` }));
  assert.equal(look(state, 'x', zone('UTC')), 'taken', 'another start');
  fs.writeFileSync(file, JSON.stringify({ pid: child.pid, identity: `${stamp} /usr/bin/another --command` }));
  assert.equal(look(state, 'x', zone('UTC')), 'taken', 'another command');
});

test('on Linux a holder is told from /proc when there is no ps to ask: held while it runs, taken over once it is gone', { skip: process.platform !== 'linux' && 'there is a /proc on Linux only' }, async t => {
  const state = temp(t), bin = temp(t), file = path.join(state, 'view.lock');
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const bare = { ...process.env, PATH: bin };
  assert.notEqual(spawnSync('ps', [], { env: bare }).error?.code ?? null, null, 'no ps on this PATH');
  const script = `import { lock } from ${JSON.stringify(lib)}; lock({ state: ${JSON.stringify(state)} }, 'view'); console.log('held'); setInterval(() => {}, 1000);`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', script], { env: bare, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill('SIGKILL'));
  let said = ''; holder.stdout.on('data', chunk => { said += chunk; });
  for (const until = Date.now() + 10000; !said.includes('held');) { assert.ok(Date.now() < until && holder.exitCode === null, 'the holder takes the lock'); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).identity, null, 'nothing for 0.1.19 to compare');
  for (const env of [bare, process.env]) assert.match(look(state, 'view', env), /holds this lock/);
  holder.kill('SIGKILL'); await new Promise(resolve => holder.once('exit', resolve));
  assert.equal(look(state, 'view', bare), 'taken');
});
