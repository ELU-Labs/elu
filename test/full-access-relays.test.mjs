import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { project, fakeClis, autoApprove, git } from './helpers.mjs';
import { ProjectController, registerProject } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';
import { serve, TOOL_NAME } from '../lib/approval-server.mjs';
import { answerApproval, pendingApprovals, readApprovalLog, requestApproval } from '../lib/approvals.mjs';
import { awaitOrFull, switchedToFull } from '../lib/full-access.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';

// The owner's rule: Full access is everything. A turn in it asks him nothing and is refused
// nothing, whichever way its vendor asks: through the approval relay (lib/approval-server.mjs),
// on Claude Code's own output (lib/runner.mjs controlRelay), or over ACP. That holds for a
// turn that started in Full access and for one whose session he set to it while it worked,
// and it does not wait for the app: the relay that was asked answers.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
// registered: the project is one of this computer's, as every project the app opens is, so
// the approval relay (a process of its own) finds the session it serves.
function setup(t, options = {}, { vendor = 'claude' } = {}) {
  const p = project(t), fake = fakeClis(p.parent, options);
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); registerProject(controller.repo);
  if (vendor !== 'claude') Object.assign(controller.draftConfig.roles.lead, { vendor, maxCostUsd: null });
  const root = controller.repo.project ?? controller.repo.root;
  return { ...p, fake, controller, root };
}
// Runs a turn to its end. Every request that waits for the owner is kept in asked, once. at
// the first one, switch() is called (the owner sets the mode); nothing is ever answered here,
// so a request only ends when ELU answers it.
async function follow(f, run, switchTo) {
  const asked = new Map(); let done = false, switched = false;
  const finished = run.finished.finally(() => { done = true; });
  // A failure must not leave the turn waiting on a request.
  const giveUp = setTimeout(() => { for (const row of pendingApprovals({ root: f.root })) answerApproval(row.id, 'deny'); }, 40000);
  try {
    while (!done) {
      for (const row of pendingApprovals({ root: f.root })) asked.set(row.id, row);
      if (asked.size && !switched && switchTo) { switched = true; assert.equal(readTask(f.controller.repo, run.id).state, 'running'); f.controller.setPermissions(run.id, switchTo); }
      await sleep(25);
    }
    return { task: await finished, asked: [...asked.values()] };
  } finally { clearTimeout(giveUp); }
}
const PUSH = { tool_name: 'Bash', input: { command: 'git push origin main', dangerouslyDisableSandbox: true } }, REMOVE = { tool_name: 'Bash', input: { command: 'rm -rf build', dangerouslyDisableSandbox: true } };
const TOOL = { tool_name: 'mcp__deploy__ship', input: { target: 'production', force: true } }, HOST = { tool_name: 'SandboxNetworkAccess', input: { host: 'elu.dev' } };

// The relay in process, as test/approval-server.test.mjs drives it.
function relay(t, argv) {
  const input = new PassThrough(), output = new PassThrough(), got = [], waiting = [];
  let buffer = '';
  output.on('data', chunk => { buffer += chunk; let at; while ((at = buffer.indexOf('\n')) >= 0) { got.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); waiting.splice(0).forEach(resolve => resolve()); } });
  const done = serve({ argv, input, output }); t.after(() => { input.end(); return done; });
  const next = async id => { for (;;) { const row = got.find(value => value.id === id); if (row) return row; await new Promise(resolve => waiting.push(resolve)); } };
  const call = (id, ask) => input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: TOOL_NAME, arguments: { ...ask, tool_use_id: `toolu_${id}` } } })}\n`);
  return { call, next };
}

test('the approval relay of a turn that started in Full access allows every call at once: a removal, an MCP tool and a push, with nothing written for the owner', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-full-')));
  environment(t, { XDG_CONFIG_HOME: path.join(dir, 'personal') }); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'approvals.jsonl'), base = ['--session', 'sess-1', '--root', dir, '--task', '7', '--role', 'lead', '--vendor', 'claude', '--log', log, '--wait', '600'];
  const asks = [REMOVE, { tool_name: 'Bash', input: { command: 'rm -rf ~' } }, TOOL, PUSH, { tool_name: 'Write', input: { file_path: '/etc/hosts', content: 'x' } },
    // A script that rewrites files, and an edit: what a Full access turn once waited twenty minutes on.
    { tool_name: 'Bash', input: { command: 'sh scripts/rewrite-imports.sh src && node tools/codemod.mjs --write src' } }, { tool_name: 'Edit', input: { file_path: path.join(dir, 'src/coupon.mjs'), old_string: 'value', new_string: 'value.trim()' } }];
  // With the owner's rules too: Full access is asked first, so the answer never depends on a rule.
  for (const [n, extra] of [[], ['--cwd', dir, '--access', 'edit', '--rules', 'saved', '--sandboxed', 'no']].entries()) {
    const server = relay(t, [...base, '--mode', 'full', '--folders', '[]', ...extra]);
    for (const [i, ask] of asks.entries()) {
      server.call(n * 10 + i + 1, ask);
      assert.deepEqual((await server.next(n * 10 + i + 1)).result, { content: [{ type: 'text', text: '{"behavior":"allow"}' }] });
      assert.deepEqual(pendingApprovals(), [], 'nothing waits for the owner');
    }
  }
  const kept = readApprovalLog(log);
  assert.deepEqual(kept.map(row => [row.tool, row.decision, row.by]), [...asks, ...asks].map(ask => [ask.tool_name, 'allow', 'full']));
  assert.deepEqual(kept.slice(0, 2).map(row => row.summary), ['Run: rm -rf build outside the sandbox', 'Run: rm -rf ~']);
  // The same calls outside Full access still ask: the allow is Full access's alone.
  const asking = relay(t, [...base, '--mode', 'auto', '--folders', '[]']);
  asking.call(90, REMOVE);
  for (let i = 0; i < 200 && !pendingApprovals().length; i++) await sleep(25);
  assert.deepEqual(pendingApprovals().map(row => row.summary), ['Run: rm -rf build outside the sandbox']);
  answerApproval(pendingApprovals()[0].id, 'deny');
  assert.match((await asking.next(90)).result.content[0].text, /"behavior":"deny"/);
});

// What a Full access session stopped on: its edit was a shell command that runs a script which
// rewrites files, the vendor asked for it through the relay, and the request waited twenty
// minutes for an answer nobody could give. Here the relay's wait is two seconds, so a request
// that waited for the owner would be refused before the turn ends.
test('Full access: an edit made by a shell command that runs a script which rewrites files waits for nobody, in a turn that started in Full access and in one set to it while the command waited', { timeout: 120000 }, async t => {
  const SCRIPT = { tool_name: 'Bash', input: { command: 'sh scripts/upper.sh', description: 'Rewrite the code lists in upper case' }, run: true, work: true };
  for (const started of ['full', 'ask']) {
    const f = setup(t, { mode: 'relay', asks: [SCRIPT], asksInFull: true, ...(started === 'full' ? { wait: 2 } : {}) });
    fs.mkdirSync(path.join(f.root, 'scripts')); fs.writeFileSync(path.join(f.root, 'src/codes.txt'), 'save\nspring\n');
    fs.writeFileSync(path.join(f.root, 'scripts/upper.sh'), "#!/bin/sh\nfor f in src/*.txt; do tr a-z A-Z < \"$f\" > \"$f.new\" && mv \"$f.new\" \"$f\"; done\n");
    git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'Add the code lists']);
    const { task, asked } = await follow(f, f.controller.ask('Uppercase the code lists', null, { permissions: started }), 'full');
    // The editing turn asked, the script ran in the session's workspace and rewrote the file, and the turn ended.
    assert.ok(!['blocked', 'needs_input', 'stopped'].includes(task.state), `${started}: ${task.state} ${JSON.stringify(task.error)}`);
    assert.equal(fs.readFileSync(path.join(task.worktree, 'src/codes.txt'), 'utf8'), 'SAVE\nSPRING\n', started);
    assert.equal(fs.readFileSync(path.join(f.root, 'src/codes.txt'), 'utf8'), 'save\nspring\n', 'the checkout is as it was');
    assert.deepEqual(rows(path.join(f.fake.dir, 'ran.jsonl')), [SCRIPT.input]);
    assert.deepEqual(task.approvals.map(row => [row.tool, row.summary, row.decision, row.by]), [['Bash', 'Run: sh scripts/upper.sh', 'allow', 'full']]);
    assert.deepEqual(task.runs.flatMap(run => run.denials ?? []), []); assert.deepEqual(pendingApprovals({ root: f.root }), []);
    // Started in Full access, nothing was ever put to the owner; started below it, the one request that waited was answered by the switch.
    assert.deepEqual(asked.map(row => row.summary), started === 'full' ? [] : ['Run: sh scripts/upper.sh']);
    assert.equal(task.permissions, 'full');
  }
});

test('below Full access, an approval nobody answers is not a no: the turn is told so, goes on with the rest and ends saying what still waits; a no stops it', { timeout: 90000 }, async t => {
  // Nobody answers: the wait runs out.
  const f = setup(t, { mode: 'relay', intent: 'answer', asks: [REMOVE], wait: 2, tells: true });
  const { task, asked } = await follow(f, f.controller.ask('Clean up the build', null, { permissions: 'ask' }), null);
  assert.deepEqual(asked.map(row => row.summary), ['Run: rm -rf build outside the sandbox']);
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  assert.deepEqual(task.approvals.map(row => [row.tool, row.decision, row.wait]), [['Bash', 'timeout', 2]]);
  const told = rows(f.fake.calls).find(row => row.approval).approval.decision;
  assert.equal(told.behavior, 'deny'); assert.match(told.message, /^No answer from the owner within 1 minutes\. Do not retry it another way\. Nobody declined it\. Go on with the work that does not need it, and say at the end what still waits for their answer\.$/);
  assert.equal(task.result.summary, 'Did the rest. Still waits for your answer: rm -rf build.');
  assert.deepEqual(rows(path.join(f.fake.dir, 'ran.jsonl')), [], 'the call itself did not run');
  // The owner says no: that is a declined action, and the turn stops on it.
  const g = setup(t, { mode: 'relay', intent: 'answer', asks: [REMOVE], tells: true });
  const run = g.controller.ask('Clean up the build', null, { permissions: 'ask' });
  for (let pending = []; !pending.length;) { await sleep(25); pending = pendingApprovals({ root: g.root }); if (pending.length) answerApproval(pending[0].id, 'deny'); }
  const stopped = await run.finished;
  assert.equal(stopped.state, 'needs_input'); assert.equal(stopped.result.question, 'I needed this and it was not allowed: rm -rf build.');
  assert.match(rows(g.fake.calls).find(row => row.approval).approval.decision.message, /^The owner declined this\. Do not retry it another way\./);
});

test('a session set to Full access while its turn waits on the approval relay: the call that waits is allowed, and each one after it is allowed without asking', { timeout: 90000 }, async t => {
  const asks = [REMOVE, TOOL, PUSH, { tool_name: 'Bash', input: { command: 'rm -rf ~/old-notes' } }];
  const f = setup(t, { mode: 'relay', intent: 'answer', asks });
  const { task, asked } = await follow(f, f.controller.ask('Clean up and ship it', null, { permissions: 'ask' }), 'full');
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  // Only the first was ever put to the owner, and nobody answered it: Full access did.
  assert.deepEqual(asked.map(row => row.summary), ['Run: rm -rf build outside the sandbox']);
  assert.deepEqual(rows(path.join(f.fake.dir, 'ran.jsonl')), asks.map(ask => ask.input), 'every call ran');
  assert.deepEqual(task.approvals.map(row => [row.tool, row.decision, row.by]), asks.map(ask => [ask.tool_name, 'allow', 'full']));
  assert.deepEqual(task.runs.at(-1).denials ?? [], []); assert.deepEqual(pendingApprovals(), []);
  assert.equal(task.permissions, 'full'); assert.equal(task.runs.at(-1).permissions, 'ask', 'the turn itself had started in Ask for approval');
});

for (const [started, label] of [['ask', 'Ask for approval'], ['auto', 'Approve for me']]) test(`a session set to Full access while its turn, started in ${label}, asks on Claude Code's own output: the question that waits is allowed, and so are the removal, the MCP tool and the host after it`, { timeout: 90000 }, async t => {
  const asks = [PUSH, REMOVE, TOOL, HOST];
  const f = setup(t, { mode: 'answer', hostAsks: asks });
  const { task, asked } = await follow(f, f.controller.ask('Ship it', null, { permissions: started }), 'full');
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  assert.deepEqual(asked.map(row => row.summary), ['Run: git push origin main outside the sandbox'], 'only the first was put to the owner');
  const answers = rows(path.join(f.fake.dir, 'host-asks.jsonl'));
  assert.deepEqual(answers.map(row => [row.tool_name, row.allowed]), asks.map(ask => [ask.tool_name, true]));
  assert.deepEqual(task.approvals.map(row => [row.tool, row.decision, row.by]), asks.map(ask => [ask.tool_name, 'allow', 'full']));
  assert.deepEqual(task.runs.at(-1).denials ?? [], []); assert.deepEqual(pendingApprovals({ root: f.root }), []);
  assert.equal(task.runs.at(-1).permissions, started, 'the turn itself had started below Full access');
});

test('a turn that started in Full access asks nothing on Claude Code\'s own output either, a removal included', { timeout: 60000 }, async t => {
  const asks = [REMOVE, { tool_name: 'Bash', input: { command: 'rm -rf ~' } }, TOOL, PUSH, HOST];
  const f = setup(t, { mode: 'answer', hostAsks: asks });
  const { task, asked } = await follow(f, f.controller.ask('Ship it', null, { permissions: 'full' }), 'full');
  assert.equal(task.state, 'answered', JSON.stringify(task.error)); assert.deepEqual(asked, []);
  assert.deepEqual(rows(path.join(f.fake.dir, 'host-asks.jsonl')).map(row => row.allowed), asks.map(() => true));
  assert.deepEqual(task.approvals.map(row => [row.tool, row.decision, row.by]), asks.map(ask => [ask.tool_name, 'allow', 'full']));
});

test('a Grok Build turn that waits on its owner over ACP is allowed once the session is set to Full access', { timeout: 60000 }, async t => {
  const f = setup(t, { mode: 'answer' }, { vendor: 'grok' }), marker = path.join(f.parent, 'marker.sh'), ran = path.join(f.parent, 'ran');
  fs.writeFileSync(marker, `#!/bin/sh\nprintf ran > ${JSON.stringify(ran)}\n`, { mode: 0o700 });
  fs.mkdirSync(path.join(f.parent, '.grok')); fs.writeFileSync(path.join(f.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
  atomic(path.join(personalDirectory(), 'conformance', 'grok.json'), { v: 1, bin: path.join(f.fake.dir, 'grok'), version: '1.0.77', steps: Object.fromEntries(ADAPTERS.grok.conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });
  const { task, asked } = await follow(f, f.controller.ask(`Run the command ${marker} then reply done with the summary "ran it".`, null, { permissions: 'ask' }), 'full');
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  assert.deepEqual(asked.map(row => [row.vendor, row.summary]), [['grok', `Run ${marker}`]]);
  assert.equal(fs.readFileSync(ran, 'utf8'), 'ran', 'the command ran');
  assert.deepEqual(task.approvals.map(row => [row.decision, row.by]), [['allow', 'full']]); assert.equal(task.runs.at(-1).denials, undefined);
});

test('only a turn that began below Full access because its session was below it is lifted: a lowered turn, a teammate\'s and a switch back are not', async t => {
  const began = '2026-11-13T10:00:00.000Z', later = '2026-11-13T10:05:00.000Z', earlier = '2026-11-13T09:00:00.000Z';
  const session = (extra = {}) => ({ id: '1', state: 'running', permissions: 'full', activeSince: began, messages: [{ at: began, text: 'Go' }], permissionChanges: [{ at: later, from: 'ask', to: 'full' }], ...extra });
  assert.equal(switchedToFull(session(), 'lead'), true);
  assert.equal(switchedToFull(session({ permissionChanges: [{ at: later, from: 'auto', to: 'full' }] }), 'bot:scout'), true, 'a bot of its chat, on the owner\'s message');
  // Back below Full access: the turn asks again.
  assert.equal(switchedToFull(session({ permissions: 'auto', permissionChanges: [{ at: later, from: 'ask', to: 'full' }, { at: '2026-11-13T10:06:00.000Z', from: 'full', to: 'auto' }] }), 'lead'), false);
  // The session had Full access before the turn began, and the turn runs below it: it was lowered on purpose.
  assert.equal(switchedToFull(session({ permissionChanges: [{ at: earlier, from: 'ask', to: 'full' }] }), 'lead'), false);
  assert.equal(switchedToFull(session({ permissionChanges: [] }), 'lead'), false);
  // A bot's scheduled turn runs with Approve for me at most.
  assert.equal(switchedToFull(session({ messages: [{ at: began, text: 'Sweep the logs', to: '@scout', scheduled: true }] }), 'bot:scout'), false);
  // A teammate's question, a session from before modes, another role, a turn that is over.
  assert.equal(switchedToFull(session({ origin: { kind: 'ask', peer: 'b'.repeat(64), name: 'sara' } }), 'lead'), false);
  assert.equal(switchedToFull(session({ permissions: undefined }), 'lead'), false);
  assert.equal(switchedToFull(session(), 'reviewer'), false);
  assert.equal(switchedToFull(session({ state: 'answered' }), 'lead'), false);
  assert.equal(switchedToFull(null, 'lead'), false);
  // The wait itself: the owner's own answer stands when it comes first, and a deny is never turned into an allow.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-full-')));
  environment(t, { XDG_CONFIG_HOME: path.join(dir, 'personal') }); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ask = id => requestApproval({ id, root: dir, taskId: '1', role: 'lead', vendor: 'claude', tool: 'Bash', input: { command: 'rm -rf build' } });
  ask('a-1'); let full = false;
  const first = awaitOrFull('a-1', () => full, { waitSeconds: 30 });
  await sleep(700); assert.equal(pendingApprovals().length, 1, 'it waits while the session is below Full access');
  full = true; assert.deepEqual(await first, { decision: 'allow', by: 'full' });
  ask('a-2'); const second = awaitOrFull('a-2', () => true, { waitSeconds: 30 }); answerApproval('a-2', 'deny');
  assert.deepEqual(await second, { decision: 'deny' });
  ask('a-3'); const third = awaitOrFull('a-3', null, { waitSeconds: 30 }); answerApproval('a-3', 'allow');
  assert.deepEqual(await third, { decision: 'allow' }, 'the owner\'s own allow is his, not Full access\'s');
});
