import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
// A stop ends everything the run started (lib/process.mjs endRun). The stand-in vendor prints
// its result, starts a loop in a session of its own, as a vendor's background command runs,
// and another whose parent leaves it behind at once (re-parented to init), then keeps running.
test('a stop ends everything the run started: its background commands in a session of their own, and those whose parent already ended', async (t) => {
  const cwd = temp(t), logFile = path.join(cwd, 'stop.log'), pids = path.join(cwd, 'pids.json');
  const alive = pid => { const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }); return r.status === 0 && Boolean(r.stdout.trim()) && !r.stdout.trim().startsWith('Z'); };
  const vendor = `const { spawn } = require('node:child_process'); const fs = require('node:fs');
    console.log(JSON.stringify({ type: 'result', result: 'Which deploy?' }));
    const loop = spawn('sh', ['-c', 'while :; do sleep 1; done'], { detached: true, stdio: 'ignore' });
    const middle = spawn(process.execPath, ['-e', "const c=require('node:child_process').spawn('sh',['-c','while :; do sleep 1; done'],{detached:true,stdio:'ignore'});console.log(c.pid);c.unref()"], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; middle.stdout.on('data', data => { out += data; }); middle.on('close', () => fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify([loop.pid, Number(out.trim())])));
    setInterval(() => {}, 1000);`;
  const controller = new AbortController(); let ended = null, started = null;
  const run = runProcess({ bin: process.execPath, args: ['-e', vendor], cwd, env: agentEnv(), logFile, timeoutSeconds: 60, signal: controller.signal, onStart: record => { started = record.pid; }, onEnded: rows => { ended = rows; } });
  const until = Date.now() + 10000; while (!fs.existsSync(pids) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  const [loop, orphan] = JSON.parse(fs.readFileSync(pids, 'utf8'));
  t.after(() => { for (const pid of [loop, orphan]) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  assert.equal(alive(loop), true); assert.equal(alive(orphan), true);
  assert.notEqual(Number(spawnSync('ps', ['-o', 'ppid=', '-p', String(orphan)], { encoding: 'utf8' }).stdout.trim()), started, 'its parent already left it behind');
  controller.abort(new Error('Stopped by the owner.'));
  await assert.rejects(run, /Stopped by the owner/);
  const gone = Date.now() + 3000; while ((alive(loop) || alive(orphan)) && Date.now() < gone) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([alive(loop), alive(orphan)], [false, false], 'nothing the run started is left');
  assert.deepEqual(ended?.map(row => row.pid).sort(), [loop, orphan].sort(), 'it names what it ended outside the vendor itself');
  assert.match(fs.readFileSync(logFile, 'utf8'), /Which deploy\?/);
});
