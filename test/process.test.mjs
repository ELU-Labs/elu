import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runProcess, processIdentity, recoverProcess, agentEnv } from '../lib/process.mjs';
import { temp } from './helpers.mjs';

test('timeouts terminate the process group and preserve a local diagnostic', async (t) => {
  const cwd = temp(t); const logFile = path.join(cwd, 'timeout.log');
  const r = await runProcess({ bin: process.execPath, args: ['-e', 'console.log("started");setInterval(()=>{},1000)'], cwd, env: agentEnv(), logFile, timeoutSeconds: 1 });
  assert.equal(r.timedOut, true); assert.notEqual(r.code, 0); assert.match(fs.readFileSync(logFile, 'utf8'), /started/);
});
test('a process that keeps printing outlives the quiet limit; a silent one is stopped by it; the cap stops either; a hold is not quiet', async (t) => {
  const cwd = temp(t), log = name => path.join(cwd, `${name}.log`);
  const chatty = 'let n=0;const t=setInterval(()=>{console.log("tick "+n);if(++n===12){clearInterval(t);}},150)';
  const silent = 'console.log("started");setInterval(()=>{},1000)';
  const [talking, quiet, capped] = await Promise.all([
    runProcess({ bin: process.execPath, args: ['-e', chatty], cwd, env: agentEnv(), logFile: log('chatty'), timeoutSeconds: 60, quietSeconds: 1 }),
    runProcess({ bin: process.execPath, args: ['-e', silent], cwd, env: agentEnv(), logFile: log('silent'), timeoutSeconds: 60, quietSeconds: 1 }),
    runProcess({ bin: process.execPath, args: ['-e', `${chatty.replace('12', '1000')}`], cwd, env: agentEnv(), logFile: log('capped'), timeoutSeconds: 1, quietSeconds: 1 }),
  ]);
  assert.deepEqual([talking.code, talking.timedOut, talking.stoppedBy], [0, false, null], 'printed for 1.8 seconds with a 1 second quiet limit and finished');
  assert.match(fs.readFileSync(log('chatty'), 'utf8'), /tick 11/);
  assert.deepEqual([quiet.timedOut, quiet.stoppedBy], [true, 'quiet']); assert.match(fs.readFileSync(log('silent'), 'utf8'), /started/);
  assert.deepEqual([capped.timedOut, capped.stoppedBy], [true, 'cap'], 'printing does not get past the cap');
  // Held for two seconds of silence (an approval waiting), then quiet for less than the limit: it ends by itself.
  const until = Date.now() + 2000, held = await runProcess({ bin: process.execPath, args: ['-e', 'setTimeout(()=>{console.log("answered")},2600)'], cwd, env: agentEnv(), logFile: log('held'), timeoutSeconds: 60, quietSeconds: 1, hold: () => Date.now() < until });
  assert.deepEqual([held.code, held.timedOut, held.stoppedBy], [0, false, null]); assert.match(fs.readFileSync(log('held'), 'utf8'), /answered/);
});
test('a run is never stopped for the size of its output: 20 MiB goes to the log and it ends on its own', { timeout: 120000 }, async (t) => {
  const cwd = temp(t), logFile = path.join(cwd, 'big.log');
  const big = 'const row="x".repeat(1024*1024-1)+"\\n";let n=0;const more=()=>{while(n<20){n++;if(!process.stdout.write(row)){process.stdout.once("drain",more);return;}}setTimeout(()=>{console.log("done");},1500);};more()';
  const r = await runProcess({ bin: process.execPath, args: ['-e', big], cwd, env: agentEnv(), logFile, timeoutSeconds: 100 });
  assert.equal(r.code, 0); assert.equal(r.timedOut, false); assert.equal(r.outputLimit, false);
  assert.ok(fs.statSync(logFile).size > 20 * 1024 * 1024); assert.match(fs.readFileSync(logFile, 'utf8').slice(-10), /done/);
});
test('recovery stops only the exact recorded process, never a reused PID', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  const ended = new Promise((resolve) => child.once('close', resolve));
  const identity = processIdentity(child.pid); assert.ok(identity);
  assert.equal(recoverProcess({ pid: child.pid, identity: 'a different process' }), 'interrupted');
  assert.equal(processIdentity(child.pid), identity);
  assert.equal(recoverProcess({ pid: child.pid, identity }), 'stopped'); await ended;
  assert.equal(processIdentity(child.pid), null);
});
test('role environments omit application credentials and nested-session control variables', () => {
  const env = agentEnv({ PATH: '/usr/bin', HOME: '/example', CLAUDECODE: '1', GH_TOKEN: 'synthetic', OPENAI_API_KEY: 'synthetic', ANTHROPIC_API_KEY: 'synthetic', CLOUDSDK_AUTH_ACCESS_TOKEN: 'synthetic', SECRET: 'synthetic' });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/example' });
});
