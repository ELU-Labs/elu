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
