import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { approvalsDir, approvalSummary, requestApproval, answerApproval, awaitDecision, pendingApprovals, readApprovalLog } from '../lib/approvals.mjs';

function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-approvals-'))), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('summaries are one short line per tool, stripped of control characters and clipped', () => {
  assert.equal(approvalSummary('Bash', { command: 'npm test' }), 'Run: npm test');
  assert.equal(approvalSummary('Bash', { command: 'rm -rf build', dangerouslyDisableSandbox: true }), 'Run: rm -rf build outside the sandbox');
  assert.equal(approvalSummary('Edit', { file_path: '/h/me/src/a.mjs' }, { home: '/h/me' }), 'Edit: ~/src/a.mjs');
  assert.equal(approvalSummary('Write', { file_path: '/elsewhere/a' }, { home: '/h/me' }), 'Edit: /elsewhere/a');
  assert.equal(approvalSummary('NotebookEdit', { notebook_path: '/h/me/n.ipynb' }, { home: '/h/me' }), 'Edit: ~/n.ipynb');
  assert.equal(approvalSummary('WebFetch', { url: 'https://example.test/' }), 'Open: https://example.test/');
  assert.equal(approvalSummary('WebSearch', { query: 'elu code' }), 'Search: elu code');
  assert.equal(approvalSummary('mcp__thing__do', {}), 'Use mcp__thing__do');
  assert.equal(approvalSummary('Bash', { command: 'a\u001b[31m\nb​ c' }), 'Run: a[31m bc');
  assert.equal(approvalSummary('Bash', { command: 'x'.repeat(500) }).length, 200);
  assert.equal(approvalSummary('Bash', { command: 'x' }, { title: 'Write\u0007 /outside' }), 'Write /outside');
  assert.equal(approvalSummary('Bash', { command: 42 }), 'Run:');
  assert.equal(approvalSummary('', {}), 'Use a tool');
});

test('a request is written once, answered once, and both files go when the wait ends', async t => {
  home(t);
  const { id, summary } = requestApproval({ id: 'run-1-a', root: '/p', taskId: 3, role: 'lead', vendor: 'claude', tool: 'Bash', input: { command: 'npm test' } });
  assert.equal(summary, 'Run: npm test');
  const dir = approvalsDir(); assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const file = path.join(dir, 'run-1-a.json'); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(record.taskId, '3'); assert.equal(record.pid, process.pid); assert.equal(record.vendor, 'claude'); assert.ok(Date.parse(record.expiresAt) > Date.now());
  assert.throws(() => requestApproval({ id, tool: 'Bash', input: {} }), /already requested/);
  assert.deepEqual(pendingApprovals().map(row => [row.id, row.summary, row.tool]), [[id, 'Run: npm test', 'Bash']]);
  assert.deepEqual(pendingApprovals({ root: '/other' }), []); assert.equal(pendingApprovals({ root: '/p', taskId: 3 }).length, 1); assert.equal(pendingApprovals({ taskId: '4' }).length, 0);
  const waiting = awaitDecision(id, { waitSeconds: 10 });
  assert.equal(answerApproval(id, 'allow'), true);
  assert.equal(answerApproval(id, 'deny'), false, 'the first answer stands');
  assert.deepEqual(pendingApprovals(), [], 'answered requests are no longer pending');
  assert.equal(await waiting, 'allow');
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(answerApproval(id, 'allow'), false, 'nothing left to answer');
  for (const bad of ['', '../x', 'a b', 'a/b', 'x'.repeat(161), 5]) assert.throws(() => requestApproval({ id: bad, tool: 'Bash', input: {} }), /Invalid approval ID/, String(bad));
  assert.throws(() => answerApproval('ok-id', 'maybe'), /allow or deny/);
  assert.throws(() => requestApproval({ id: 'no-tool', tool: '', input: {} }), /names its tool/);
  assert.throws(() => requestApproval({ id: 'no-wait', tool: 'Bash', input: {}, waitSeconds: 0 }), /positive wait/);
});

test('a request is never found half written: a list running in another process leaves every new request alone', async t => {
  home(t);
  const dir = approvalsDir(), lib = pathToFileURL(fileURLToPath(new URL('../lib/approvals.mjs', import.meta.url))).href;
  const lister = spawn(process.execPath, ['--input-type=module', '-e', `import { pendingApprovals } from ${JSON.stringify(lib)}; console.log('ready'); for (;;) pendingApprovals();`], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => lister.kill('SIGKILL'));
  await new Promise((resolve, reject) => { lister.stdout.once('data', resolve); lister.once('exit', () => reject(new Error('The lister ended early.'))); });
  const input = { command: 'x'.repeat(4000) }, lost = [];
  for (let n = 0; n < 300; n++) {
    const id = `race-${n}`, file = path.join(dir, `${id}.json`);
    requestApproval({ id, tool: 'Bash', input });
    await sleep(2);
    try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch { lost.push(id); }
    fs.rmSync(file, { force: true });
  }
  lister.kill('SIGKILL'); await new Promise(resolve => lister.exitCode !== null || lister.signalCode !== null ? resolve() : lister.once('exit', resolve));
  assert.deepEqual(lost, [], 'the list removed requests it read while they were being written');
  // A writer that died mid-way leaves only its draft: never listed, never answerable, and removed once it is old.
  const draft = path.join(dir, '.left-1.json.0123456789ab.tmp'); fs.writeFileSync(draft, '{"version": 1, "id": "left-1", "pi');
  assert.deepEqual(pendingApprovals(), []); assert.equal(answerApproval('left-1', 'allow'), false); assert.equal(fs.existsSync(draft), true);
  const past = new Date(Date.now() - 5 * 60000); fs.utimesSync(draft, past, past);
  assert.deepEqual(pendingApprovals(), []); assert.deepEqual(fs.readdirSync(dir), []);
  // An answer is written the same way, and the first one still stands.
  requestApproval({ id: 'left-1', tool: 'Bash', input });
  assert.equal(answerApproval('left-1', 'deny'), true); assert.equal(answerApproval('left-1', 'allow'), false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['left-1.answer.json', 'left-1.json']);
  assert.equal(await awaitDecision('left-1', { waitSeconds: 5 }), 'deny'); assert.deepEqual(fs.readdirSync(dir), []);
});

test('a wait that passes is a timeout, an abort stops it, and dead or expired requests are pruned', async t => {
  home(t);
  requestApproval({ id: 'short', tool: 'Edit', input: { file_path: '/x' }, waitSeconds: 0.2 });
  assert.equal(await awaitDecision('short', { waitSeconds: 0.2 }), 'timeout');
  requestApproval({ id: 'aborted', tool: 'Edit', input: {}, waitSeconds: 60 });
  const controller = new AbortController(), wait = awaitDecision('aborted', { waitSeconds: 60, signal: controller.signal });
  controller.abort(); await assert.rejects(wait);
  assert.deepEqual(fs.readdirSync(approvalsDir()), [], 'nothing is left behind');
  const dead = Number(spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim());
  requestApproval({ id: 'dead', tool: 'Bash', input: { command: 'x' }, pid: dead });
  requestApproval({ id: 'expired', tool: 'Bash', input: { command: 'x' }, waitSeconds: 0.001 });
  await sleep(5);
  requestApproval({ id: 'live', tool: 'Bash', input: { command: 'y' } });
  fs.writeFileSync(path.join(approvalsDir(), 'junk.json'), '{');
  assert.deepEqual(pendingApprovals().map(row => row.id), ['live']);
  assert.deepEqual(fs.readdirSync(approvalsDir()), ['live.json']);
  // Model output is clipped before it reaches disk.
  requestApproval({ id: 'big', tool: 'Bash', input: { command: 'x'.repeat(10000) } });
  const record = JSON.parse(fs.readFileSync(path.join(approvalsDir(), 'big.json'), 'utf8'));
  assert.equal(record.input.clipped, true); assert.equal(record.input.text.length, 4096); assert.equal(record.summary.length, 200);
});

test("a run's approval log is read leniently and clipped", t => {
  const dir = home(t), file = path.join(dir, 'approvals.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ id: 'a', tool: 'Bash', summary: 'Run: x\u0007', decision: 'allow', at: 't' })}\nnot json\n${JSON.stringify({ id: 'b', tool: 'Edit', summary: 'y', decision: 'nope' })}\n[]\n`);
  assert.deepEqual(readApprovalLog(file), [{ id: 'a', tool: 'Bash', summary: 'Run: x', decision: 'allow', at: 't' }, { id: 'b', tool: 'Edit', summary: 'y', decision: 'deny', at: null }]);
  assert.deepEqual(readApprovalLog(path.join(dir, 'missing.jsonl')), []);
});
