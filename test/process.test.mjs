import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runProcess, processIdentity, processRecord, sameProcess, recoverProcess, agentEnv } from '../lib/process.mjs';
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
