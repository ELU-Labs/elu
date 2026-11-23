import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CLI, temp } from './helpers.mjs';
import { keepUp } from '../lib/conductor.mjs';

// 2026-11-23: on a full disk, one conductor died on a write and another on a refusal of a
// session's lock that no handler saw. Each took every turn it ran with it, and nothing started a
// conductor again for 20 minutes. The real daemon, with both errors put in from outside its code.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('the conductor goes on after an error nothing caught: a stray rejection is kept and it keeps running; an exception hands over and it exits as a drained one does', { timeout: 60000 }, async t => {
  const home = temp(t), config = path.join(home, '.config'), dir = path.join(config, 'elu-code');
  const stray = path.join(home, 'stray.mjs');
  fs.writeFileSync(stray, [
    "setTimeout(() => { Promise.reject(new Error('Another ELU command holds this lock.')); }, 1000);",
    "setTimeout(() => { throw new Error('ENOSPC: no space left on device, write'); }, 2500);",
  ].join('\n'));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config };
  const daemon = spawn(process.execPath, ['--import', pathToFileURL(stray).href, CLI, 'conductor', '--daemon'], { cwd: home, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let said = ''; daemon.stderr.on('data', chunk => { said += chunk; });
  const ended = new Promise(resolve => daemon.once('exit', code => resolve(code)));
  t.after(() => { daemon.kill('SIGKILL'); return ended; });
  await sleep(2000);
  assert.equal(daemon.exitCode, null, `still running after the stray rejection:\n${said}`);
  assert.match(said, /ELU conductor went on after: Error: Another ELU command holds this lock\./);
  // The status keeps it until the next tick that goes well, as it does any error of a tick.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'conductor', 'state.json'), 'utf8')).stopped, false);
  const code = await Promise.race([ended, sleep(20000).then(() => 'still running')]);
  assert.equal(code, 0, `exits as a drained conductor does, not with the crash:\n${said}`);
  assert.match(said, /ELU conductor went on after: Error: ENOSPC: no space left on device, write/);
});

test('keepUp: a rejection is kept and nothing else; an exception also hands over, once', () => {
  const on = {}, lines = [];
  const owner = { draining: null, error: null, writes: 0, drains: 0, write() { this.writes++; }, drain() { this.drains++; this.draining = 'id'; } };
  keepUp(owner, { on: (event, handler) => { on[event] = handler; }, log: text => lines.push(text) });
  on.unhandledRejection(new Error('Another ELU command holds this lock.'));
  assert.deepEqual([owner.error, owner.drains, owner.writes], ['Another ELU command holds this lock.', 0, 1]);
  on.uncaughtException(new Error('ENOSPC: no space left on device, write'));
  on.uncaughtException(new Error('ENOSPC: no space left on device, write'));
  assert.deepEqual([owner.error, owner.drains], ['ENOSPC: no space left on device, write', 1]);
  assert.equal(lines.length, 3); assert.match(lines[0], /^ELU conductor went on after: Error: Another ELU command holds this lock\./);
  // A failing status write or log never throws out of the handler.
  const broken = { draining: null, write() { throw new Error('ENOSPC'); }, drain() { throw new Error('ENOSPC'); } };
  keepUp(broken, { on: (event, handler) => { on[event] = handler; }, log: () => { throw new Error('ENOSPC'); } });
  on.unhandledRejection(new Error('x')); on.uncaughtException(new Error('y'));
});
