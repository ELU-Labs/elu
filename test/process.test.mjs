import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runProcess, processIdentity, recoverProcess, agentEnv } from '../lib/process.mjs';
import { commandWatch } from '../lib/turn-limits.mjs';
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
// The owner's case: a long test run inside a turn prints nothing until it ends.
test('a command the vendor runs is working while it runs: its silence does not stop the process, and the cap still does', async (t) => {
  const cwd = temp(t), log = name => path.join(cwd, `${name}.log`), print = value => `console.log(${JSON.stringify(JSON.stringify(value))})`;
  const claude = [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }];
  const codex = [{ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'npm test', status: 'in_progress' } }, { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'npm test', status: 'completed' } }];
  // The call, two and a half seconds of nothing while it runs, its result, then silence.
  const script = ([call, done]) => `${print(call)};setTimeout(()=>{${print(done)};setInterval(()=>{},1000)},2500)`;
  const run = (name, args, extra) => runProcess({ bin: process.execPath, args: ['-e', args], cwd, env: agentEnv(), logFile: log(name), timeoutSeconds: 60, quietSeconds: 1, ...extra });
  const [fromClaude, fromCodex, unread, endless] = await Promise.all([
    run('claude', script(claude), { working: commandWatch('claude') }), run('codex', script(codex), { working: commandWatch('codex') }),
    run('unread', script(claude)), run('endless', `${print(claude[0])};setInterval(()=>{},1000)`, { timeoutSeconds: 3, working: commandWatch('claude') }),
  ]);
  for (const [name, value] of [['claude', fromClaude], ['codex', fromCodex]]) {
    assert.match(fs.readFileSync(log(name), 'utf8'), /tool_result|item\.completed/, `${name}: the command ran its two and a half silent seconds to the end`);
    assert.equal(value.stoppedBy, 'quiet', `${name}: once it ended, silence counts again`);
  }
  assert.equal(unread.stoppedBy, 'quiet'); assert.doesNotMatch(fs.readFileSync(log('unread'), 'utf8'), /tool_result/, 'a stream nobody reads has the quiet limit alone');
  assert.deepEqual([endless.timedOut, endless.stoppedBy], [true, 'cap'], 'a command that never ends stops at the cap');
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
