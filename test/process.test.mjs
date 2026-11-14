import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runProcess, processIdentity, processRecord, sameProcess, recoverProcess, agentEnv } from '../lib/process.mjs';
import { commandWatch } from '../lib/turn-limits.mjs';
import { temp } from './helpers.mjs';
import * as claude from '../lib/adapters/claude.mjs';
import * as codex from '../lib/adapters/codex.mjs';

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
test('a process that wrote the row ending its turn and stays for a child it left is ended with that child', async (t) => {
  const cwd = temp(t), logFile = path.join(cwd, 'codex.log'), pidFile = path.join(cwd, 'child.pid');
  const script = `const c=require('node:child_process').spawn('/bin/sh',['-c','for i in $(seq 1 110); do sleep 60; done'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));console.log(JSON.stringify({type:'turn.completed',usage:{}}));c.on('exit',()=>{})`;
  const started = Date.now(), r = await runProcess({ bin: process.execPath, args: ['-e', script], cwd, env: agentEnv(), logFile, timeoutSeconds: 60, finished: codex.finalEvent });
  assert.ok(Date.now() - started < 15000, 'ended after its result, not when the child would');
  assert.deepEqual([r.code, r.endedAfterResult, r.timedOut], [0, true, false]);
  assert.ok(r.left.some(command => command.includes('seq 1 110')), r.left.join('\n'));
  const pid = Number(fs.readFileSync(pidFile, 'utf8')), alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const until = Date.now() + 5000; alive() && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(alive(), false);
  // A process that ends by itself after its result is left as it ended.
  const quick = await runProcess({ bin: process.execPath, args: ['-e', 'console.log(JSON.stringify({type:"result"}))'], cwd, env: agentEnv(), logFile: path.join(cwd, 'quick.log'), timeoutSeconds: 60, finished: claude.finalEvent });
  assert.deepEqual([quick.code, quick.endedAfterResult], [0, undefined]);
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
// A turn that ends at its result is ended by the same helper (endRun), so the commands it left
// in a session of their own, or whose parent already ended, end with it too. It is no stop:
// nothing is reported as ended by one.
test('a process that stays after the row ending its turn is ended with the commands it left in a session of their own, and those whose parent already ended', async (t) => {
  const cwd = temp(t), logFile = path.join(cwd, 'result.log'), pids = path.join(cwd, 'pids.json');
  const alive = pid => { const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }); return r.status === 0 && Boolean(r.stdout.trim()) && !r.stdout.trim().startsWith('Z'); };
  const vendor = `const { spawn } = require('node:child_process'); const fs = require('node:fs');
    console.log(JSON.stringify({ type: 'result', result: 'Which deploy?' }));
    const loop = spawn('sh', ['-c', 'while :; do sleep 1; done'], { detached: true, stdio: 'ignore' });
    const middle = spawn(process.execPath, ['-e', "const c=require('node:child_process').spawn('sh',['-c','while :; do sleep 1; done'],{detached:true,stdio:'ignore'});console.log(c.pid);c.unref()"], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; middle.stdout.on('data', data => { out += data; }); middle.on('close', () => fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify([loop.pid, Number(out.trim())])));
    setInterval(() => {}, 1000);`;
  let ended = null;
  const started = Date.now(), r = await runProcess({ bin: process.execPath, args: ['-e', vendor], cwd, env: agentEnv(), logFile, timeoutSeconds: 60, finished: claude.finalEvent, onEnded: rows => { ended = rows; } });
  const [loop, orphan] = JSON.parse(fs.readFileSync(pids, 'utf8'));
  t.after(() => { for (const pid of [loop, orphan]) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  assert.ok(Date.now() - started < 15000, 'ended after its result');
  assert.deepEqual([r.code, r.endedAfterResult, r.timedOut], [0, true, false]);
  assert.ok(r.left.length >= 2 && r.left.every(command => typeof command === 'string'), r.left.join('\n'));
  const gone = Date.now() + 5000; while ((alive(loop) || alive(orphan)) && Date.now() < gone) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([alive(loop), alive(orphan)], [false, false], 'nothing the turn left is running');
  assert.equal(ended, null, 'the turn ended at its result: no stop is reported');
});
// The turn is over only once what it left is gone: a command that ignores being asked to end
// (SIGTERM) is ended before the turn returns, never on a timer that an exit of ELU would skip.
test('a turn ended at its result returns only once a command it left that ignores being asked to end is gone', async (t) => {
  const cwd = temp(t), logFile = path.join(cwd, 'deaf.log'), pidFile = path.join(cwd, 'loop.pid');
  const alive = pid => { const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }); return r.status === 0 && Boolean(r.stdout.trim()) && !r.stdout.trim().startsWith('Z'); };
  const vendor = `const loop = require('node:child_process').spawn('sh', ['-c', "trap '' TERM; while :; do sleep 1; done"], { detached: true, stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(loop.pid)); console.log(JSON.stringify({ type: 'result', result: 'Done.' })); setInterval(() => {}, 1000);`;
  const r = await runProcess({ bin: process.execPath, args: ['-e', vendor], cwd, env: agentEnv(), logFile, timeoutSeconds: 60, finished: claude.finalEvent });
  const loop = Number(fs.readFileSync(pidFile, 'utf8')); t.after(() => { try { process.kill(-loop, 'SIGKILL'); } catch {} });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual([r.endedAfterResult, alive(loop)], [true, false], 'gone when the turn returned');
});
// ELU itself exits in the two seconds between asking and ending: a conductor an update
// replaced leaves as soon as its last turn is over. The vendor here ignores being asked too,
// so the turn has not returned when the process exits.
test('ELU exiting just after a turn ended at its result still ends what the turn left', async (t) => {
  const cwd = temp(t), pidFile = path.join(cwd, 'pids.json'), lib = new URL('../lib/process.mjs', import.meta.url).href, claudeLib = new URL('../lib/adapters/claude.mjs', import.meta.url).href;
  const alive = pid => { const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }); return r.status === 0 && Boolean(r.stdout.trim()) && !r.stdout.trim().startsWith('Z'); };
  const vendor = `process.on('SIGTERM', () => {}); const loop = require('node:child_process').spawn('sh', ['-c', "trap '' TERM; while :; do sleep 1; done"], { detached: true, stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, loop.pid])); console.log(JSON.stringify({ type: 'result', result: 'Done.' })); setInterval(() => {}, 1000);`;
  const elu = `import { runProcess, agentEnv, afterResult } from ${JSON.stringify(lib)}; import { finalEvent } from ${JSON.stringify(claudeLib)};
    afterResult.graceSeconds = 0.2; setTimeout(() => process.exit(0), 1500);
    runProcess({ bin: process.execPath, args: ['-e', ${JSON.stringify(vendor)}], cwd: ${JSON.stringify(cwd)}, env: agentEnv(), logFile: ${JSON.stringify(path.join(cwd, 'exit.log'))}, timeoutSeconds: 60, finished: finalEvent });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', elu], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  const [vendorPid, loop] = JSON.parse(fs.readFileSync(pidFile, 'utf8')); t.after(() => { for (const pid of [vendorPid, loop]) { try { process.kill(-pid, 'SIGKILL'); } catch {} } });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual([alive(vendorPid), alive(loop)], [false, false], 'nothing of the turn outlives ELU');
});
test('a limit that stops a run ends its background commands too', async (t) => {
  const cwd = temp(t), pid = path.join(cwd, 'loop.pid');
  const alive = id => { const r = spawnSync('ps', ['-o', 'stat=', '-p', String(id)], { encoding: 'utf8' }); return r.status === 0 && Boolean(r.stdout.trim()) && !r.stdout.trim().startsWith('Z'); };
  const vendor = `const loop = require('node:child_process').spawn('sh', ['-c', 'while :; do sleep 1; done'], { detached: true, stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pid)}, String(loop.pid)); setInterval(() => {}, 1000);`;
  let ended = null;
  const r = await runProcess({ bin: process.execPath, args: ['-e', vendor], cwd, env: agentEnv(), logFile: path.join(cwd, 'quiet.log'), timeoutSeconds: 60, quietSeconds: 1, onEnded: rows => { ended = rows; } });
  const loop = Number(fs.readFileSync(pid, 'utf8')); t.after(() => { try { process.kill(loop, 'SIGKILL'); } catch {} });
  assert.equal(r.stoppedBy, 'quiet');
  const gone = Date.now() + 3000; while (alive(loop) && Date.now() < gone) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(alive(loop), false); assert.deepEqual(ended?.map(row => row.pid), [loop]);
});

// A look from a process of its own with that environment: an app in a terminal and a daemon
// that a login item started do not have the same time zone, language or COLUMNS.
const lib = new URL('../lib/process.mjs', import.meta.url).href;
const from = (env, code) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { processRecord, sameProcess, recoverProcess } from ${JSON.stringify(lib)}; console.log(JSON.stringify(${code}));`], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
};
// What 0.1.19 and earlier wrote as a process's identity: the line ps printed for the writer.
const written = (pid, env) => spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', env: { ...process.env, ...env } }).stdout.trim();
const ENVS = [{ TZ: 'America/Los_Angeles' }, { TZ: 'UTC' }, { TZ: 'Asia/Kolkata', LC_ALL: 'de_DE.UTF-8', COLUMNS: '40' }];
const sleeper = t => { const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }); t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }); return child; };

test('a record names its process the same from any time zone, language and width, and never another process with its number', async (t) => {
  const child = sleeper(t), ended = new Promise((resolve) => child.once('close', resolve));
  const records = ENVS.map(env => from(env, `processRecord(${child.pid})`));
  for (const record of records) { assert.equal(record.pid, child.pid); assert.ok(record.born); assert.equal(record.born, records[0].born); }
  // identity stays what 0.1.19 compares, ps's own line, which two time zones do not print alike.
  assert.equal(records[0].identity, written(child.pid, ENVS[0])); assert.notEqual(records[0].identity, records[1].identity);
  for (const record of records) for (const env of ENVS) assert.equal(from(env, `sameProcess(${JSON.stringify(record)})`), true, `written in ${record.identity.slice(0, 24)}, read in ${env.TZ}`);
  assert.deepEqual(processRecord(), processRecord(process.pid)); assert.equal(sameProcess(processRecord()), true);
  // born decides when it is there: another process that got the number is not this one.
  assert.equal(sameProcess({ ...records[0], born: `${records[0].born}0` }), false);
  for (const nameless of [null, {}, { pid: child.pid }, { pid: child.pid, identity: null }, { pid: null, identity: null }]) assert.equal(sameProcess(nameless), false);
  assert.equal(from({ TZ: 'UTC' }, `recoverProcess(${JSON.stringify({ ...records[0], born: 'another' })})`), 'interrupted');
  assert.equal(from({ TZ: 'UTC' }, `recoverProcess(${JSON.stringify(records[0])})`), 'stopped'); await ended;
  for (const record of records) assert.equal(sameProcess(record), false);
});
test('a record written by 0.1.19 names its process from any time zone, and not one that started at another time or runs another command', async (t) => {
  const child = sleeper(t), ended = new Promise((resolve) => child.once('close', resolve));
  for (const wrote of [...ENVS, { TZ: 'Asia/Kathmandu' }, { TZ: 'Pacific/Auckland' }]) {
    const record = { pid: child.pid, identity: written(child.pid, wrote) };
    for (const env of ENVS) assert.equal(from(env, `sameProcess(${JSON.stringify(record)})`), true, `written in ${wrote.TZ}, read in ${env.TZ}`);
  }
  const now = written(child.pid, { TZ: 'UTC' }), stamp = now.slice(0, 24), command = now.slice(25), seconds = Number(stamp.slice(17, 19));
  const at = (mm, ss) => `${stamp.slice(0, 14)}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}${stamp.slice(19)}`, minute = Number(stamp.slice(14, 16));
  // A quarter of an hour apart is another time zone's clock; any other minute is another process.
  assert.equal(sameProcess({ pid: child.pid, identity: `${at((minute + 15) % 60, seconds)} ${command}` }), true);
  assert.equal(sameProcess({ pid: child.pid, identity: `${at((minute + 7) % 60, seconds)} ${command}` }), false);
  assert.equal(sameProcess({ pid: child.pid, identity: `${at(minute, (seconds + 30) % 60)} ${command}` }), false);
  assert.equal(sameProcess({ pid: child.pid, identity: `${stamp} /usr/bin/another --command` }), false);
  assert.equal(sameProcess({ pid: child.pid, identity: 'a different process' }), false);
  assert.equal(from({ TZ: 'UTC' }, `recoverProcess(${JSON.stringify({ pid: child.pid, identity: written(child.pid, { TZ: 'America/Los_Angeles' }), bin: 'node' })})`), 'stopped'); await ended;
  assert.equal(sameProcess({ pid: child.pid, identity: now }), false);
});
// macOS has no /proc: there the start is what its ps prints, asked in UTC and in English. Its ps
// prints the start in the asker's time zone and language, in a column 28 wide, and shows a
// process that ended and waits for its parent as <defunct>. The stand-in does the same, here
// in German when asked in German.
const MAC_PS = `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2), pid = args[args.indexOf('-p') + 1], columns = args.flatMap((arg, at) => args[at - 1] === '-o' ? [arg.replace('=', '')] : []);
const real = spawnSync('/bin/ps', ['-ww', '-p', pid, '-o', 'stat=', '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
const found = real.status === 0 && /^(\\S+)\\s+(\\w{3}) (\\w{3}) +(\\d+) (\\S+) (\\d{4}) (.*)$/s.exec(real.stdout.trim());
if (!found) process.exit(1);
const [, stat, day, month, date, time, year, command] = found, german = /^de/.test(process.env.LC_ALL || process.env.LC_TIME || process.env.LANG || '');
const lstart = german ? [{ Mon: 'Mo', Tue: 'Di', Wed: 'Mi', Thu: 'Do', Fri: 'Fr', Sat: 'Sa', Sun: 'So' }[day], date.padStart(2), month, time, year].join(' ') : [day, month, date.padStart(2), time, year].join(' ');
const value = { stat: stat.padEnd(4), lstart: lstart.padEnd(28), command: stat.startsWith('Z') ? '<defunct>' : command };
console.log(columns.map(name => value[name]).join(' '));
`;
test('where the start is read from ps, as on macOS, a record names its process from any time zone and language, also one written by 0.1.19', { skip: process.platform !== 'linux' && 'the stand-in asks the ps of Linux' }, async (t) => {
  const bin = temp(t); fs.writeFileSync(path.join(bin, 'ps'), MAC_PS, { mode: 0o755 });
  const mac = env => ({ ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }), german = { TZ: 'Europe/Berlin', LC_ALL: 'de_DE.UTF-8' };
  const envs = [{ TZ: 'America/Los_Angeles' }, { TZ: 'UTC' }, german].map(mac);
  const child = sleeper(t), ended = new Promise((resolve) => child.once('close', resolve));
  assert.match(written(child.pid, envs[0]), /^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4} {5}\S.*setInterval/, 'the stand-in prints as macOS does');
  const records = envs.map(env => from(env, `processRecord(${child.pid}, 'darwin')`));
  for (const record of records) { assert.match(record.born, /^\d{10}$/); assert.equal(record.born, records[0].born); }
  assert.match(records[2].identity, /^(Mo|Di|Mi|Do|Fr|Sa|So) [ \d]\d \w{3} \d\d:\d\d:\d\d \d{4} {6}\S/);
  for (const record of records) for (const env of envs) assert.equal(from(env, `sameProcess(${JSON.stringify(record)}, 'darwin')`), true);
  assert.equal(from(envs[1], `sameProcess(${JSON.stringify({ ...records[0], born: String(Number(records[0].born) + 1) })}, 'darwin')`), false);
  // 0.1.19 wrote only ps's line. In English its start is read; in another language the same command is enough.
  for (const wrote of envs) for (const env of envs) assert.equal(from(env, `sameProcess(${JSON.stringify({ pid: child.pid, identity: written(child.pid, wrote) })}, 'darwin')`), true);
  const english = written(child.pid, envs[1]), other = `${english.slice(0, 14)}${String((Number(english.slice(14, 16)) + 7) % 60).padStart(2, '0')}${english.slice(16)}`;
  assert.equal(from(envs[0], `sameProcess(${JSON.stringify({ pid: child.pid, identity: other })}, 'darwin')`), false);
  assert.equal(from(envs[0], `sameProcess(${JSON.stringify({ pid: child.pid, identity: `${written(child.pid, envs[2]).slice(0, 29)}/usr/bin/another --command` })}, 'darwin')`), false);
  process.kill(-child.pid, 'SIGKILL'); await ended;
  for (const record of records) assert.equal(from(envs[1], `sameProcess(${JSON.stringify(record)}, 'darwin')`), false);
});
test('a process that ended and only waits for its parent is gone', { skip: process.platform !== 'linux' && 'the stand-in asks the ps of Linux' }, async (t) => {
  const bin = temp(t); fs.writeFileSync(path.join(bin, 'ps'), MAC_PS, { mode: 0o755 });
  const mac = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  // The shell starts a process that ends after a second, and becomes one that never asks how it ended.
  const parent = spawn('/bin/sh', ['-c', 'sleep 1 & echo $!; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => parent.kill('SIGKILL'));
  const pid = Number(await new Promise(resolve => parent.stdout.once('data', chunk => resolve(String(chunk).trim()))));
  const record = processRecord(pid), onMac = from(mac, `processRecord(${pid}, 'darwin')`), old = { pid, identity: written(pid, {}) };
  assert.equal(sameProcess(record), true); assert.equal(from(mac, `sameProcess(${JSON.stringify(onMac)}, 'darwin')`), true); assert.equal(sameProcess(old), true);
  for (const until = Date.now() + 10000; !/^Z/.test(spawnSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim());) { assert.ok(Date.now() < until, 'it ends'); await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.equal(sameProcess(record), false); assert.equal(from(mac, `sameProcess(${JSON.stringify(onMac)}, 'darwin')`), false); assert.equal(sameProcess(old), false);
});
