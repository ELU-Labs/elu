import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { temp } from './helpers.mjs';
import { SESSION_TAG } from '../lib/process.mjs';
import { sessionTag } from '../lib/runner.mjs';
import { DONE_KEPT_MS, PROCESS_READ_MS, agentArgs, commandAgent, linuxTable, processTable, projectIdOf, psTable, sessionProcesses, useProcessLister } from '../lib/agent-processes.mjs';

// The helpers a session's agents start outside ELU jobs (lib/agent-processes.mjs): every turn's
// environment names its session and project (lib/runner.mjs sessionTag), and a vendor's program
// run headless that carries those names, below no turn or job of ELU's own, is one of its helpers.
// Read from a fake process table here (Linux's /proc, macOS's ps and lsof), and once from a real one.

const repo = { root: '/work/project', state: '/work/project/.git/elu' }, task = { id: '7' };
const tag = { [SESSION_TAG.session]: '7', [SESSION_TAG.project]: projectIdOf(repo) };

test('every turn names its session and project in its environment, as the helpers read them back', () => {
  assert.deepEqual(SESSION_TAG, { session: 'ELU_SESSION_ID', project: 'ELU_PROJECT_ID' });
  assert.deepEqual(sessionTag(repo, task), tag);
  assert.deepEqual(sessionTag({ ...repo, project: 'other' }, task)[SESSION_TAG.project], projectIdOf({ ...repo, project: 'other' }));
  // The launch puts them on the environment of every turn it starts, whatever the vendor.
  const runner = fs.readFileSync(new URL('../lib/runner.mjs', import.meta.url), 'utf8');
  assert.match(runner, /const env = adapter\.childEnv \?[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*Object\.assign\(env, sessionTag\(repo, task\)\);/);
});

test("a helper's command line: its vendor, model, effort and folder, and only a headless run counts", () => {
  assert.deepEqual(agentArgs(['node', '/usr/local/bin/codex', 'exec', '--json', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="xhigh"', '-C', '/work/a', '-o', '/tmp/last.txt', 'Review it']),
    { vendor: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', folder: '/work/a', lastMessage: '/tmp/last.txt' });
  assert.deepEqual(agentArgs(['/opt/codex/codex', '-c', 'model=gpt-6.1', 'exec', '--cd=/work/b', 'x']), { vendor: 'codex', model: 'gpt-6.1', effort: null, folder: '/work/b', lastMessage: null });
  assert.deepEqual(agentArgs(['claude', '-p', '--model=opus', '--effort', 'high', 'Summarise']), { vendor: 'claude', model: 'opus', effort: 'high', folder: null, lastMessage: null });
  assert.equal(agentArgs(['grok', '--prompt', 'x'])?.vendor, 'grok');
  assert.equal(agentArgs(['agy', '-p', 'x'])?.vendor, 'agy');
  // Not run headless, or not a vendor's program: none.
  for (const argv of [['codex', 'app-server'], ['claude'], ['claude', '--prompt', 'x'], ['node', 'server.js', 'exec', '-p'], ['/bin/zsh', '-c', 'codex exec x'], []]) assert.equal(agentArgs(argv), null, argv.join(' '));
});

test('Linux: the table from /proc, with the session names of vendor programs and where a helper writes', t => {
  const proc = path.join(temp(t), 'proc'), log = path.join(path.dirname(proc), 'helper.log'), cwd = path.dirname(proc);
  fs.writeFileSync(log, '');
  const put = (pid, { argv, ppid = 1, ticks = 500, env = null, out = null, at = null }) => {
    const dir = path.join(proc, String(pid)); fs.mkdirSync(path.join(dir, 'fd'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cmdline'), `${argv.join('\0')}\0`);
    fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${path.basename(argv[0]).slice(0, 15)} x) S ${ppid} ${pid} ${pid} 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 1000 100\n`);
    if (env) fs.writeFileSync(path.join(dir, 'environ'), `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\0')}\0`);
    if (out) fs.symlinkSync(out, path.join(dir, 'fd', '1'));
    if (at) fs.symlinkSync(at, path.join(dir, 'cwd'));
  };
  fs.mkdirSync(proc, { recursive: true }); fs.writeFileSync(path.join(proc, 'stat'), 'cpu  1 2 3\nbtime 1763700000\n');
  put(1, { argv: ['/sbin/init'], ppid: 0 });
  put(42, { argv: ['codex', 'exec', '--json', '-m', 'gpt-6.1-sol', 'go'], ticks: 1234, env: { HOME: '/home/me', SECRET_KEY: 'x', ...tag }, out: log, at: cwd });
  put(43, { argv: ['claude', '-p', 'x'], env: tag, out: 'pipe:[991]' });
  put(44, { argv: ['/bin/bash', '-c', 'sleep 1'], env: tag });
  const rows = linuxTable({ proc }), by = pid => rows.find(row => row.pid === pid);
  assert.deepEqual(rows.map(row => row.pid).sort((a, b) => a - b), [1, 42, 43, 44]);
  // Only the session's names are kept of its environment; its start is boot plus its ticks.
  assert.deepEqual(by(42), { pid: 42, ppid: 1, start: 1763700000 * 1000 + 1234 * 10, argv: ['codex', 'exec', '--json', '-m', 'gpt-6.1-sol', 'go'], env: tag, out: log, cwd });
  // A pipe is no file; a program that is no vendor's has no environment read at all.
  assert.equal(by(43).out, null); assert.equal(by(44).env, null);
  assert.deepEqual(linuxTable({ proc: path.join(proc, 'none') }), []);
});

test('macOS: the table from ps, the environment of vendor programs alone, and lsof once for each new helper', () => {
  const calls = [];
  const run = (bin, args) => {
    calls.push([bin, args.at(-1)]);
    if (bin === 'ps' && args[0] === '-A') return ['    1     0 /sbin/launchd', '  400     1 node /usr/local/lib/node_modules/@elu-labs/elu/bin/elu.cjs', '  501   400 /opt/homebrew/bin/codex exec --json -m gpt-6.1-sol -C /work/a go', '  502     1 claude -p --model opus x', '  503     1 /bin/zsh -l', ''].join('\n');
    if (bin === 'ps') return [`  501 Sat Nov 21 10:00:05 2026     /opt/homebrew/bin/codex exec --json -m gpt-6.1-sol -C /work/a go TERM=xterm ${SESSION_TAG.session}=7 ${SESSION_TAG.project}=${tag[SESSION_TAG.project]}`, '  502 Sat Nov 21 09:59:00 2026     claude -p --model opus x HOME=/Users/me', ''].join('\n');
    if (bin === 'lsof') return ['p501', 'fcwd', 'n/work/a', 'f1', 'n/work/a/helper.log', ''].join('\n');
    return null;
  };
  const rows = psTable({ run }), by = pid => rows.find(row => row.pid === pid);
  assert.deepEqual(calls.map(([bin, last]) => `${bin} ${last}`), ['ps command=', 'ps 501,502', 'lsof 501']);
  assert.deepEqual(by(501), { pid: 501, ppid: 400, start: Date.parse('Sat Nov 21 10:00:05 2026'), argv: ['/opt/homebrew/bin/codex', 'exec', '--json', '-m', 'gpt-6.1-sol', '-C', '/work/a', 'go'], env: tag, out: '/work/a/helper.log', cwd: '/work/a' });
  assert.equal(by(502).env, null); assert.equal(by(503).env, null); assert.equal(by(1).argv[0], '/sbin/launchd');
  // The same helper again: ps reads it, lsof is not asked again.
  calls.length = 0; assert.equal(psTable({ run }).find(row => row.pid === 501).out, '/work/a/helper.log');
  assert.deepEqual(calls.map(([bin]) => bin), ['ps', 'ps']);
  // No table, no rows; a table with no vendor program asks nothing more.
  assert.deepEqual(psTable({ run: () => null }), []);
  calls.length = 0; psTable({ run: (bin, args) => { calls.push(bin); return bin === 'ps' && args[0] === '-A' ? '  1 0 /sbin/launchd\n' : null; } }); assert.deepEqual(calls, ['ps']);
});

test('the table is read at most once every few seconds, and only when asked', t => {
  let reads = 0; t.after(useProcessLister(() => { reads += 1; return [{ pid: 9, ppid: 1, start: null, argv: ['x'], env: null, out: null, cwd: null }]; }));
  const now = Date.now();
  assert.equal(reads, 0);
  processTable({ now }); processTable({ now: now + PROCESS_READ_MS - 1 });
  assert.equal(reads, 1);
  processTable({ now: now + PROCESS_READ_MS }); assert.equal(reads, 2);
});

// The process table of a session with a lead at work: ELU (400) runs the lead (500, its run's
// record), which runs a shell (501), which runs a Codex helper through its node script (502) and
// that one's binary (503); one more helper was left by its starter (600). Then what is no helper.
function table({ log = null, without = [] } = {}) {
  const at = Date.now() - 60000;
  return [
    { pid: 1, ppid: 0, argv: ['/sbin/launchd'] },
    { pid: 400, ppid: 1, argv: ['node', '/usr/local/lib/node_modules/@elu-labs/elu/bin/elu.cjs'] },
    { pid: 500, ppid: 400, argv: ['claude', '-p', '--output-format', 'stream-json'], env: tag },
    { pid: 501, ppid: 500, argv: ['/bin/zsh', '-c', 'codex exec ...'], env: tag },
    { pid: 502, ppid: 501, start: at, argv: ['node', '/usr/local/bin/codex', 'exec', '--json', '-m', 'gpt-6.1-sol', '-C', '/work/a', 'go'], env: tag, out: log },
    { pid: 503, ppid: 502, start: at, argv: ['/usr/local/lib/node_modules/@openai/codex/bin/codex', 'exec', '--json', '-m', 'gpt-6.1-sol', '-C', '/work/a', 'go'], env: tag, out: log },
    { pid: 600, ppid: 1, start: at + 1000, argv: ['claude', '-p', '--model', 'opus', 'x'], env: tag, cwd: '/work/b' },
    // A turn of ELU's own that its run's record does not name (a bot's, a job's runner below ELU), another
    // session's, another project's, a vendor program that is not run headless, and one with no names.
    { pid: 650, ppid: 400, argv: ['codex', 'exec', '--json', 'x'], env: tag },
    { pid: 800, ppid: 1, argv: ['codex', 'exec', 'x'], env: { ...tag, [SESSION_TAG.session]: '8' } },
    { pid: 801, ppid: 1, argv: ['codex', 'exec', 'x'], env: { ...tag, [SESSION_TAG.project]: 'ffffffffffffffff' } },
    { pid: 802, ppid: 1, argv: ['codex', 'app-server'], env: tag },
    { pid: 803, ppid: 1, argv: ['codex', 'exec', 'x'], env: null },
  ].filter(row => !without.includes(row.pid)).map(row => ({ start: null, env: null, out: null, cwd: null, ...row }));
}

test('a session\'s helpers: below its turn or left by it, never the turn, a turn of ELU\'s, another session\'s or a launcher\'s binary', t => {
  t.after(useProcessLister(() => table({ log: '/work/a/helper.log' })));
  const now = Date.now(), found = sessionProcesses(repo, task, { now, runPid: 500 });
  assert.deepEqual(found.map(row => [row.pid, row.by, row.state, row.args.vendor, row.args.model]), [[502, 'run', 'working', 'codex', 'gpt-6.1-sol'], [600, null, 'working', 'claude', 'opus']]);
  // With the run's record unread, the turn is still told apart: ELU runs it.
  assert.deepEqual(sessionProcesses(repo, { id: '7' }, { now, runPid: null }).map(row => row.pid), [502, 600]);
  assert.deepEqual(sessionProcesses(repo, { id: '9' }, { now }), []);
});

test('a helper that ended stays as done for a while when what it wrote is known, and goes when it is not', t => {
  const session = { id: '17' }, own = { ...tag, [SESSION_TAG.session]: '17' };
  let rows = table({ log: '/work/a/helper.log' }).map(row => row.env?.[SESSION_TAG.session] === '7' && row.env[SESSION_TAG.project] === tag[SESSION_TAG.project] ? { ...row, env: own } : row);
  const restore = useProcessLister(() => rows); t.after(restore);
  const now = Date.now();
  assert.deepEqual(sessionProcesses(repo, session, { now, runPid: 500 }).map(row => row.pid), [502, 600]);
  rows = rows.filter(row => ![502, 503, 600].includes(row.pid));
  const later = now + PROCESS_READ_MS, ended = sessionProcesses(repo, session, { now: later, runPid: 500 });
  assert.deepEqual(ended.map(row => [row.pid, row.state, row.endedAt]), [[502, 'done', later]]);
  assert.deepEqual(sessionProcesses(repo, session, { now: later + DONE_KEPT_MS, runPid: 500 }).map(row => row.pid), [502]);
  assert.deepEqual(sessionProcesses(repo, session, { now: later + DONE_KEPT_MS + PROCESS_READ_MS, runPid: 500 }), []);
});

test('a real helper: a detached stand-in Codex that carries the session names is found in this computer\'s table', { skip: !['linux', 'darwin'].includes(process.platform) }, async t => {
  const dir = temp(t), bin = path.join(dir, 'bin'), work = path.join(dir, 'work'), log = path.join(dir, 'helper.log'), script = path.join(bin, 'codex');
  fs.mkdirSync(bin); fs.mkdirSync(work);
  fs.writeFileSync(script, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\\n');\nsetTimeout(() => {}, 60000);\n`, { mode: 0o755 });
  const real = { root: dir, state: path.join(dir, '.state') }, names = { [SESSION_TAG.session]: '5', [SESSION_TAG.project]: projectIdOf(real) };
  // Started from a shell that ends at once, as setsid nohup … & leaves one: its starter is gone.
  const started = spawnSync('/bin/sh', ['-c', `"${script}" exec --json -m gpt-test -c model_reasoning_effort=low -C "${work}" go > "${log}" 2>&1 < /dev/null & echo $!`], { encoding: 'utf8', env: { ...process.env, ...names } });
  const pid = Number(started.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 1, started.stderr);
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* Ended. */ } });
  t.after(useProcessLister(null));
  let found = null;
  for (let tries = 0; tries < 40 && !found; tries++) {
    await new Promise(resolve => setTimeout(resolve, 150));
    found = sessionProcesses(real, { id: '5' }, { now: Date.now() + (tries + 1) * PROCESS_READ_MS }).find(row => row.pid === pid && row.args.model) ?? null;
  }
  assert.ok(found, 'the helper is found by its session names');
  assert.deepEqual(found.args, { vendor: 'codex', model: 'gpt-test', effort: 'low', folder: work, lastMessage: null });
  assert.equal(found.state, 'working'); assert.ok(Number.isFinite(found.start));
  assert.equal(found.log && fs.realpathSync(found.log), fs.realpathSync(log), 'where its output goes');
});

// The owner may run the session on any of the four, and its lead may start a helper on any of
// them: each one's headless words, model and effort, as its --help says.
test("each of the four programs is a helper run headless, with its model and effort, on a command line and in a shell command", () => {
  const none = { folder: null, lastMessage: null };
  assert.deepEqual(agentArgs(['grok', '-p', 'Review it', '-m', 'grok-5', '--reasoning-effort', 'high']), { vendor: 'grok', model: 'grok-5', effort: 'high', ...none });
  assert.deepEqual(agentArgs(['/usr/local/bin/grok', '--prompt-file=/tmp/p.txt', '--model=grok-5-fast', '--effort=low']), { vendor: 'grok', model: 'grok-5-fast', effort: 'low', ...none });
  assert.equal(agentArgs(['grok', '--single', 'x'])?.vendor, 'grok'); assert.equal(agentArgs(['grok', '--prompt-json', '{}'])?.vendor, 'grok');
  assert.deepEqual(agentArgs(['agy', '--print', 'x', '--model', 'gemini-3.5-pro', '--effort', 'xhigh']), { vendor: 'agy', model: 'gemini-3.5-pro', effort: 'xhigh', ...none });
  assert.equal(agentArgs(['agy', '--prompt', 'x'])?.vendor, 'agy');
  assert.deepEqual(agentArgs(['claude', '--print', '--model', 'opus', '--effort=max', 'x']), { vendor: 'claude', model: 'opus', effort: 'max', ...none });
  assert.deepEqual(agentArgs(['codex', 'exec', '--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', 'x']), { vendor: 'codex', model: 'gpt-6.1-sol', effort: 'high', ...none });
  // Run in its own chat, not headless: none.
  for (const argv of [['grok'], ['grok', 'models'], ['agy'], ['agy', '-i', 'x'], ['codex', 'resume']]) assert.equal(agentArgs(argv), null, argv.join(' '));
  // A shell command of a turn, as its log has it.
  assert.deepEqual(commandAgent("cd /work && setsid nohup grok -p 'check the seams' -m grok-5 --reasoning-effort medium > /tmp/out.txt 2>&1 &"), { vendor: 'grok', model: 'grok-5', effort: 'medium' });
  assert.deepEqual(commandAgent('nohup agy --print "x" --model gemini-3.5-flash --effort low &'), { vendor: 'agy', model: 'gemini-3.5-flash', effort: 'low' });
  assert.deepEqual(commandAgent('codex exec -m gpt-6.1 -c model_reasoning_effort="xhigh" "x" | tee out'), { vendor: 'codex', model: 'gpt-6.1', effort: 'xhigh' });
  assert.deepEqual(commandAgent('claude -p --model sonnet "x"'), { vendor: 'claude', model: 'sonnet', effort: null });
  assert.equal(commandAgent('grep grok notes.txt; echo agy'), null);
});
