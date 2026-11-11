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
