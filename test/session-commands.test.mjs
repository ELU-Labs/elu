import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, fakeClis, autoApprove, approvingConductor, CLI } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { ProjectController, projectSnapshot, registerProject } from '../lib/projects.mjs';
import { readTask } from '../lib/state.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import { Conductor, conductorAlive, enqueue } from '../lib/conductor.mjs';
import { listSchedules, parseWhen, runScheduleNow, saveSchedule } from '../lib/schedules.mjs';
import { readBoard, sessionClosed } from '../lib/kanban.mjs';
import { SCHEDULE_NOTE } from '../lib/bots.mjs';
import { allowedBy } from '../lib/permission-rules.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { OWN_COMMANDS, SESSIONS_HELP, SCHEDULES_HELP, TEAMMATE_REFUSAL, checkRequest, runOwnCommand } from '../lib/session-commands.mjs';
import { answerApproval, pendingApprovals } from '../lib/approvals.mjs';

// ELU from inside a session (README, "ELU from a session"): elu sessions and elu schedules,
// from the owner's shell and from a turn, through the app's own records and locks.
after(() => { setTimeout(() => { console.error('session-commands.test: something is still running 10 s after the last test.'); process.exit(1); }, 10000).unref(); });
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// The conductors a test starts stop before its folder goes (registered first: hooks run in order).
function setup(t, fake = {}) {
  const live = []; t.after(async () => { for (const conductor of live) await conductor.stop(); });
  const p = project(t), clis = fakeClis(p.parent, { mode: 'answer', ...fake });
  environment(t, { ...clis.env, HOME: p.parent, ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const repo = repository(p.root); registerProject(repo);
  const controller = autoApprove(new ProjectController(repo));
  const conduct = () => { const conductor = approvingConductor(new Conductor({ tickMs: 20 })).start(); live.push(conductor); return conductor; };
  const rows = name => { const file = path.join(clis.dir, name); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; };
  const inputs = vendor => fs.existsSync(path.join(p.parent, 'inputs.jsonl')) ? fs.readFileSync(path.join(p.parent, 'inputs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => !vendor || row.vendor === vendor) : [];
  const leads = () => rows('../calls.jsonl').filter(call => call.vendor === 'claude' && call.args.includes('-p'));
  return { ...p, ...clis, repo, root: repo.root, controller, conduct, rows, inputs, leads };
}
// elu as the owner runs it in his shell in the project, or as a session's turn does (session).
const elu = (f, args, { session = null, cwd = f.root } = {}) => {
  const env = { ...process.env }; delete env.ELU_SESSION; delete env.ELU_PROJECT;
  if (session) Object.assign(env, { ELU_SESSION: String(session), ELU_PROJECT: f.root });
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
};
const json = r => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
async function until(check, message, timeout = 30000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 25)); }
}
const closed = (f, id) => projectSnapshot(f.repo).closed.includes(String(id));
const sessions = f => projectSnapshot(f.repo).tasks;
const settingsOf = args => JSON.parse(args[args.indexOf('--settings') + 1]);
const SARA = 'b'.repeat(64);
const origin = kind => ({ kind, peer: SARA, name: 'sara', a2aTaskId: 'task-1', threadId: 'thread-1', hop: 1 });
const ASK = 'archive this chat and start a new session that says hello';
const SHELL = [{ when: 'archive this chat', run: ['elu sessions archive this', 'elu sessions new "hello"'] }];

test('elu sessions lists the project\'s sessions and archives, brings back and renames them in the app\'s own records', async t => {
  const f = setup(t);
  const one = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'ask' }).finished;
  const two = await f.controller.ask('Check the build', null, { permissions: 'auto' }).finished;
  let out = json(elu(f, ['sessions', '--json']));
  assert.deepEqual(out.sessions.map(row => [row.id, row.state, row.archived, row.mode]), [[one.id, 'answered', false, 'ask'], [two.id, 'answered', false, 'auto']]);
  assert.match(elu(f, ['sessions']).stdout, /^Sessions in sample app:\n {2}1 {2}answered {4}"Where is coupon normalization\?"\n {2}2 {2}answered {4}"Check the build"\n$/);
  let r = elu(f, ['sessions', 'archive', '1']); assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Archived session 1 "Where is coupon normalization?". elu sessions unarchive 1 brings it back.\n');
  assert.ok(closed(f, 1) && !closed(f, 2), 'Sessions in the app no longer lists it');
  assert.deepEqual(json(elu(f, ['sessions', '--json'])).sessions.map(row => row.id), ['2']);
  assert.deepEqual(json(elu(f, ['sessions', '--all', '--json'])).sessions.map(row => [row.id, row.archived]), [['1', true], ['2', false]]);
  r = elu(f, ['sessions', 'unarchive', '1']); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /is back in the list/);
  assert.ok(!closed(f, 1));
  r = elu(f, ['sessions', 'rename', '2', 'Build', 'watch']); assert.equal(r.status, 0, r.stderr);
  assert.equal(readTask(f.repo, '2').title, 'Build watch'); assert.equal(readTask(f.repo, '2').titleBy, 'owner');
  r = elu(f, ['sessions', 'rename', '2', '']); assert.equal(r.status, 0, r.stderr); assert.notEqual(readTask(f.repo, '2').titleBy, 'owner');
  // this is the session the command runs in: from the owner's shell there is none.
  r = elu(f, ['sessions', 'archive', 'this']); assert.equal(r.status, 1); assert.match(r.stderr, /use it inside a session/);
  r = elu(f, ['sessions', 'archive', '9']); assert.equal(r.status, 1); assert.match(r.stderr, /No session 9 in sample app/);
  // From a folder that is no project of ELU's.
  r = elu(f, ['sessions'], { cwd: f.parent }); assert.equal(r.status, 1); assert.match(r.stderr, /Run this in a project folder of ELU/);
});

test('a session told "archive this chat and start a new session that says hello" ends archived, with the new session started', { timeout: 90000 }, async t => {
  const f = setup(t, { shell: SHELL });
  f.conduct(); await until(() => conductorAlive(), 'the conductor');
  const request = enqueue(f.root, ASK, { priority: 0, typed: true, permissions: 'auto', bots: [] });
  await until(() => sessions(f).some(task => task.goal === 'hello' && task.state === 'answered') && pendingRequests(f.root).find(row => row.id === request.id)?.state === 'done', 'both sessions');
  const first = sessions(f).find(task => task.goal === ASK), hello = sessions(f).find(task => task.goal === 'hello');
  assert.equal(first.state, 'answered');
  // The model ran both commands in its turn, with the session it is in.
  const ran = f.rows('shell.jsonl');
  assert.deepEqual(ran.map(row => [row.command, row.status, row.session, row.project]), [['elu sessions archive this', 0, first.id, f.root], ['elu sessions new "hello"', 0, first.id, f.root]]);
  assert.equal(ran[0].out, `Session ${first.id} "${ASK}" is archived when this turn ends.`);
  assert.match(ran[1].out, /^Started a new session with Approve for me: "hello"\. It shows in Sessions\.$/);
  // Its reply is kept, and the session left the list only when the turn had ended.
  assert.match(first.result.summary, /is archived when this turn ends/);
  await until(() => closed(f, first.id), 'the archive');
  assert.ok(sessionClosed(readBoard(f.repo), readTask(f.repo, first.id)));
  assert.ok(!closed(f, hello.id), 'the new session is in the list');
  assert.equal(hello.permissions, 'auto', "the new session has the calling session's mode");
  assert.ok(!fs.existsSync(path.join(f.repo.state, 'tasks', first.id, 'archive.json')));
  // The model was told the commands, and the new session ran nothing.
  const told = f.inputs('claude').filter(row => row.input.includes(OWN_COMMANDS[0]) && row.input.includes(OWN_COMMANDS[1]));
  assert.equal(told.length, 2, 'both sessions were told');
  assert.equal(f.rows('shell.jsonl').length, 2);
  // elu sessions from the shell lists them: the new one, and with --all the archived one.
  assert.deepEqual(json(elu(f, ['sessions', '--json'])).sessions.map(row => [row.id, row.archived]), [[hello.id, false]]);
  assert.deepEqual(json(elu(f, ['sessions', '--all', '--json'])).sessions.map(row => [row.id, row.archived]).sort(), [[first.id, true], [hello.id, false]].sort());
});

// Codex below Full access runs each command in its sandbox, with the core environment alone:
// the fake runs it the same way, and with fence inside the profile's write limits where bwrap
// works (test/fakes/codex.mjs shell). The turn's elu hands each command to ELU, which runs it.
const BWRAP = spawnSync('bwrap', ['--die-with-parent', '--unshare-net', '--ro-bind', '/', '/', 'true']).status === 0;
const waiting = (f, start) => pendingApprovals({ root: f.root }).find(row => row.summary.startsWith(start));
const bothDone = (f, request) => sessions(f).some(task => task.goal === 'hello' && task.state === 'answered') && pendingRequests(f.root).find(row => row.id === request.id)?.state === 'done';
async function endsArchivedWithHello(f, request, mode) {
  await until(() => bothDone(f, request), 'both sessions');
  const first = sessions(f).find(task => task.goal === ASK), hello = sessions(f).find(task => task.goal === 'hello');
  await until(() => closed(f, first.id), 'the archive');
  assert.ok(sessionClosed(readBoard(f.repo), readTask(f.repo, first.id)));
  assert.ok(!closed(f, hello.id), 'the new session is in the list'); assert.equal(hello.permissions, mode);
  assert.match(readTask(f.repo, first.id).result.summary, /is archived when this turn ends/);
  return { first, hello };
}
async function codexStarted(t, mode, fake = {}) {
  const f = setup(t, { shell: SHELL, fence: true, ...fake });
  f.controller.setDefaultModel({ vendor: 'codex' });
  f.conduct(); await until(() => conductorAlive(), 'the conductor');
  return { f, request: enqueue(f.root, ASK, { priority: 0, typed: true, permissions: mode, bots: [] }) };
}

for (const [mode, label] of [['auto', 'Approve for me'], ['full', 'Full access']]) {
  test(`a Codex session in ${label} told "${ASK}" ends archived, with the new session started`, { timeout: 90000 }, async t => {
    const { f, request } = await codexStarted(t, mode);
    const { first } = await endsArchivedWithHello(f, request, mode);
    const ran = f.rows('shell.jsonl');
    assert.deepEqual(ran.map(row => [row.command, row.status, row.out]), [['elu sessions archive this', 0, `Session ${first.id} "${ASK}" is archived when this turn ends.`], ['elu sessions new "hello"', 0, `Started a new session with ${label}: "hello". It shows in Sessions.`]]);
    // Below Full access the commands had none of the session's environment, and could write
    // only the turn's own folder; in Full access they had all of it.
    assert.deepEqual(ran.map(row => [row.inherit, row.session, row.fenced]), mode === 'full' ? [['all', first.id, false], ['all', first.id, false]] : [['core', null, BWRAP], ['core', null, BWRAP]]);
    assert.deepEqual(readTask(f.repo, first.id).approvals ?? [], [], 'nothing was asked');
    assert.ok(f.inputs('codex').filter(row => OWN_COMMANDS.every(line => row.input.includes(line))).length >= 2, 'both sessions were told');
  });
}

test('a Codex session in Ask for approval asks before each command, which waits for the answer, runs once allowed, and changes nothing once declined', { timeout: 120000 }, async t => {
  const { f, request } = await codexStarted(t, 'ask');
  await until(() => waiting(f, 'Run: elu sessions archive this'), 'the first question');
  const first = sessions(f).find(task => task.goal === ASK);
  // The command waits for the answer, and nothing has changed.
  assert.equal(first.state, 'running'); assert.equal(f.rows('shell.jsonl').length, 0);
  assert.ok(!fs.existsSync(path.join(f.repo.state, 'tasks', first.id, 'archive.json')));
  assert.equal(waiting(f, 'Run: elu sessions archive this').summary, 'Run: elu sessions archive this');
  assert.ok(answerApproval(waiting(f, 'Run: elu sessions archive this').id, 'allow'));
  await until(() => waiting(f, 'Run: elu sessions new hello'), 'the second question');
  assert.ok(!sessions(f).some(task => task.goal === 'hello'), 'no new session before the answer');
  assert.deepEqual(f.rows('shell.jsonl').map(row => [row.command, row.status]), [['elu sessions archive this', 0]]);
  assert.ok(answerApproval(waiting(f, 'Run: elu sessions new hello').id, 'allow'));
  await endsArchivedWithHello(f, request, 'ask');
  assert.deepEqual(f.rows('shell.jsonl').map(row => [row.command, row.status, row.session]), [['elu sessions archive this', 0, null], ['elu sessions new "hello"', 0, null]]);
  assert.deepEqual(readTask(f.repo, first.id).approvals.map(row => [row.tool, row.summary, row.decision]), [['Bash', 'Run: elu sessions archive this', 'allow'], ['Bash', 'Run: elu sessions new hello', 'allow']]);
  // Declined: the command says so, and nothing changes.
  const again = enqueue(f.root, ASK, { priority: 0, typed: true, permissions: 'ask', bots: [] });
  for (const start of ['Run: elu sessions archive this', 'Run: elu sessions new hello']) { await until(() => waiting(f, start), start); assert.ok(answerApproval(waiting(f, start).id, 'deny')); }
  await until(() => pendingRequests(f.root).find(row => row.id === again.id)?.state === 'done', 'the second turn');
  const second = sessions(f).find(task => task.goal === ASK && task.id !== first.id);
  assert.deepEqual(f.rows('shell.jsonl').slice(2).map(row => [row.status, row.out]), [[1, 'The owner did not allow elu sessions archive this. Nothing was changed. Do not try it another way.'], [1, 'The owner did not allow elu sessions new hello. Nothing was changed. Do not try it another way.']]);
  assert.equal(readTask(f.repo, second.id).state, 'answered');
  assert.ok(!closed(f, second.id) && !fs.existsSync(path.join(f.repo.state, 'tasks', second.id, 'archive.json')));
  assert.equal(sessions(f).filter(task => task.goal === 'hello').length, 1);
});

test("requests put in a Codex turn's folder by hand are held to its own session and mode, and read as data", { timeout: 90000 }, async t => {
  // Each request is written straight into the folder, as a model that read the turn's elu could.
  const drop = 'd="$(dirname "$(command -v elu)")/../requests"';
  const answered = id => `i=0; while [ ! -f "$d/${id}.answer.json" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; cat "$d/${id}.answer.json"`;
  const put = (write) => { const id = crypto.randomBytes(12).toString('hex'); return `${drop}; ${write(`"$d/${id}.request.json"`)}; ${answered(id)}`; };
  const forged = (session, mode, argv) => put(file => `printf '%s' '${JSON.stringify({ v: 1, id: 'x', session, mode, argv, at: '2026-11-14T00:00:00.000Z' })}' > ${file}`);
  // A link to a request kept elsewhere is not followed.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'elu-linked-')), linked = path.join(elsewhere, 'linked.json');
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.writeFileSync(linked, JSON.stringify({ v: 1, session: '2', mode: 'auto', argv: ['sessions', 'rename', 'this', 'Linked'] }));
  const f = setup(t, { fence: true, shell: [{ when: 'forge them', run: [
    forged('1', 'auto', ['sessions', 'archive', '1']),
    forged('2', 'full', ['sessions', 'new', 'sneaky', '--mode', 'full']),
    put(file => `ln -s ${JSON.stringify(linked)} ${file}`),
    put(file => `printf 'not a request' > ${file}`),
    forged('2', 'auto', ['sessions', 'rename', 'this', 'Forged']),
  ] }] });
  const other = await f.controller.ask('Where is normalization?', null, { permissions: 'ask' }).finished;
  assert.equal(String(other.id), '1');
  f.controller.setDefaultModel({ vendor: 'codex' });
  f.conduct(); await until(() => conductorAlive(), 'the conductor');
  const request = enqueue(f.root, 'forge them', { priority: 0, typed: true, permissions: 'auto', bots: [] });
  await until(() => pendingRequests(f.root).find(row => row.id === request.id)?.state === 'done', 'the turn');
  const forging = sessions(f).find(task => task.goal === 'forge them');
  assert.equal(String(forging.id), '2');
  const answers = f.rows('shell.jsonl').map(row => { assert.equal(row.status, 0, row.out); return JSON.parse(row.out); });
  const unread = { code: 1, err: 'ELU could not read this request. Nothing was changed.\n' };
  assert.deepEqual(answers.slice(0, 4), [
    { code: 1, err: 'This request names session "1", not the session it came from. Nothing was changed.\n' },
    { code: 1, err: "This request asks for Full access, more than this session's Approve for me. Nothing was changed.\n" },
    unread, unread,
  ]);
  // Its own session, at its own mode: the same as the command itself.
  assert.equal(answers[4].code, 0, answers[4].err);
  assert.equal(readTask(f.repo, '2').title, 'Forged');
  assert.ok(!closed(f, '1')); assert.ok(!pendingRequests(f.root).some(row => row.goal === 'sneaky'));
  assert.ok(f.rows('shell.jsonl').every(row => row.inherit === 'core' && row.fenced === BWRAP));
});

test('Grok Build in Ask for approval asks once for each command over ACP, and ELU runs what the owner allowed without asking again', { timeout: 120000 }, async t => {
  const f = setup(t, { shell: SHELL });
  fs.mkdirSync(path.join(f.parent, '.grok')); fs.writeFileSync(path.join(f.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
  atomic(path.join(personalDirectory(), 'conformance', 'grok.json'), { v: 1, bin: path.join(f.dir, 'grok'), version: '1.0.77', steps: Object.fromEntries(ADAPTERS.grok.conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });
  f.controller.setDefaultModel({ vendor: 'grok' });
  f.conduct(); await until(() => conductorAlive(), 'the conductor');
  const request = enqueue(f.root, ASK, { priority: 0, typed: true, permissions: 'ask', bots: [] });
  for (const start of ['Run elu sessions archive this', 'Run elu sessions new']) { await until(() => waiting(f, start), start); assert.ok(answerApproval(waiting(f, start).id, 'allow')); }
  const { first } = await endsArchivedWithHello(f, request, 'ask');
  assert.deepEqual(f.rows('shell.jsonl').map(row => [row.command, row.status]), [['elu sessions archive this', 0], ['elu sessions new "hello"', 0]]);
  // The two questions Grok Build asked, and none of ELU's own after them.
  const approvals = readTask(f.repo, first.id).approvals;
  assert.deepEqual(approvals.map(row => row.decision), ['allow', 'allow']);
  assert.ok(approvals.every(row => !/-own-[0-9]+$/.test(row.id)), JSON.stringify(approvals));
});

test('a schedule whose message says the same does it on each run', { timeout: 120000 }, async t => {
  const f = setup(t, { shell: SHELL });
  f.conduct(); await until(() => conductorAlive(), 'the conductor');
  const row = saveSchedule({ root: f.root, project: 'sample app', goal: ASK, when: parseWhen('every 3h'), permissions: 'auto', picked: true });
  for (let run = 1; run <= 2; run++) {
    runScheduleNow(row.id, new Date(), { start: () => true });
    await until(() => { const all = sessions(f); return all.filter(task => task.goal === ASK && closed(f, task.id)).length === run && all.filter(task => task.goal === 'hello' && task.state === 'answered').length === run; }, `run ${run}`);
    await until(() => !pendingRequests(f.root).some(value => value.scheduleId === row.id && value.state !== 'done'), `run ${run} to end`);
  }
  const all = sessions(f);
  assert.equal(all.filter(task => task.goal === ASK).length, 2); assert.ok(all.filter(task => task.goal === ASK).every(task => closed(f, task.id)));
  assert.equal(all.filter(task => task.goal === 'hello').length, 2); assert.ok(all.filter(task => task.goal === 'hello').every(task => !closed(f, task.id) && task.permissions === 'auto'));
  assert.equal(listSchedules().find(value => value.id === row.id).runs, 2);
  // elu sessions says which schedule started a run while it knows.
  const listed = json(elu(f, ['sessions', '--all', '--json'])).sessions;
  assert.deepEqual(listed.filter(value => value.archived).map(value => value.schedule), [{ id: row.id, label: 'every 3h' }, { id: row.id, label: 'every 3h' }]);
  assert.deepEqual(listed.filter(value => !value.archived).map(value => value.schedule), [null, null]);
  assert.match(elu(f, ['sessions', '--all']).stdout, /"archive this chat and start a new session that says hello" {2}· archived · from schedule every 3h\n/);
});

test("a session that keeps its schedule on its record (scheduleId) is listed with it once its request is gone", async t => {
  const f = setup(t);
  const row = saveSchedule({ root: f.root, project: 'sample app', goal: 'Check the build', when: parseWhen('every 3h'), permissions: 'auto', picked: true });
  const run = await f.controller.ask('Check the build', null, { permissions: 'auto' }).finished;
  const typed = await f.controller.ask('Check the build', null, { permissions: 'auto' }).finished;
  // As a version that keeps the field writes it; no request and no lastTaskId names this session.
  const file = path.join(f.repo.state, 'tasks', String(run.id), 'task.json');
  atomic(file, { ...JSON.parse(fs.readFileSync(file, 'utf8')), scheduleId: row.id });
  const listed = json(elu(f, ['sessions', '--json'])).sessions;
  assert.deepEqual(listed.map(value => [value.id, value.schedule]), [[String(run.id), { id: row.id, label: 'every 3h' }], [String(typed.id), null]]);
  assert.match(elu(f, ['sessions']).stdout, / {2}"Check the build" {2}· from schedule every 3h\n/);
});

test("a teammate's question is never told the commands, has no elu of its own, and they refuse to run from it", async t => {
  const f = setup(t, { envs: true });
  const peer = await f.controller.ask('Answer the question from @sara.', null, { origin: origin('ask'), readOnly: true, context: 'Where is normalization?' }).finished;
  const own = await f.controller.ask('Where is normalization?', null, { permissions: 'ask' }).finished;
  const [asked, mine] = f.inputs('claude');
  assert.ok(!asked.input.includes(OWN_COMMANDS[0]) && !asked.input.includes('elu sessions'), "the teammate's question is not told");
  assert.ok(mine.input.includes(OWN_COMMANDS[0]) && mine.input.includes(OWN_COMMANDS[1]), "the owner's session is told");
  // Only the owner's own turn was started with a folder to hand commands to ELU through.
  const launched = f.leads().filter(call => call.own);
  assert.ok(launched.length > 0 && launched.every(call => /\/elu-code-own-[^/]+\/bin$/.test(call.own) && call.session === String(own.id)), JSON.stringify(f.leads()));
  assert.ok(!f.leads().some(call => call.session === String(peer.id)), "the teammate's run has none");
  for (const args of [['sessions'], ['sessions', 'archive', String(own.id)], ['sessions', 'new', 'hello'], ['schedules'], ['schedules', 'add', 'every', '3h', 'check', 'the', 'build']]) {
    const r = elu(f, args, { session: peer.id });
    assert.equal(r.status, 1, args.join(' ')); assert.equal(r.stderr, `${TEAMMATE_REFUSAL}\n`);
    // Handed to ELU as from the teammate's run, the same.
    assert.deepEqual(await runOwnCommand(args, { repo: f.repo, taskId: peer.id, mode: 'full' }), { code: 1, err: `${TEAMMATE_REFUSAL}\n` });
  }
  // A request naming the teammate's session, put in the owner's turn's folder, is not run there.
  assert.throws(() => checkRequest({ session: String(peer.id), mode: 'ask', argv: ['sessions', 'archive', String(own.id)] }, { taskId: own.id, mode: 'ask' }), /not the session it came from/);
  assert.ok(!closed(f, own.id)); assert.deepEqual(listSchedules(), []);
});

test('a session started from a session gets its mode, or a lower one, never a higher one', async t => {
  const f = setup(t);
  const asking = await f.controller.ask('Where is normalization?', null, { permissions: 'ask' }).finished;
  const full = await f.controller.ask('Ship the fix', null, { permissions: 'full' }).finished;
  f.conduct(); await until(() => conductorAlive(), 'the conductor');
  const started = goal => pendingRequests(f.root).find(row => row.goal === goal);
  let r = elu(f, ['sessions', 'new', 'from', 'ask', '--mode', 'full'], { session: asking.id }); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /with Ask for approval: "from ask"\. It shows in Sessions\. This session has Ask for approval, so that is the most it gives\./);
  assert.equal(started('from ask').permissions, 'ask'); assert.equal(started('from ask').typed, true); assert.equal(started('from ask').picked, undefined);
  r = elu(f, ['sessions', 'new', 'from full'], { session: full.id }); assert.equal(r.status, 0, r.stderr); assert.equal(started('from full').permissions, 'full');
  r = elu(f, ['sessions', 'new', 'lower', '--mode', 'auto'], { session: full.id }); assert.equal(r.status, 0, r.stderr); assert.equal(started('lower').permissions, 'auto');
  // From his own shell, the mode he names, or his default.
  r = elu(f, ['sessions', 'new', 'mine', '--mode', 'full']); assert.equal(r.status, 0, r.stderr); assert.equal(started('mine').permissions, 'full'); assert.equal(started('mine').picked, true);
  r = elu(f, ['sessions', 'new', 'plain']); assert.equal(r.status, 0, r.stderr); assert.equal(started('plain').permissions, 'ask');
  r = elu(f, ['sessions', 'new', 'x', '--mode', 'everything']); assert.equal(r.status, 1); assert.match(r.stderr, /Choose ask, auto, or full/);
});

test('elu schedules adds, lists, pauses, resumes, runs and deletes with the words /schedule takes', async t => {
  const f = setup(t);
  const auto = await f.controller.ask('Check the build', null, { permissions: 'auto' }).finished;
  let r = elu(f, ['schedules', 'add', 'every', '3h', 'check', 'the', 'build']); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Scheduled every 3h, next .+: "check the build", with Ask for approval\./);
  let [row] = listSchedules();
  assert.equal(row.goal, 'check the build'); assert.equal(row.when.label, 'every 3h'); assert.equal(row.permissions, 'ask'); assert.equal(row.picked, undefined); assert.equal(row.root, f.root);
  r = elu(f, ['schedules', 'add', 'daily 9:00', 'tidy the notes', '--mode', 'full'], { session: auto.id }); assert.equal(r.status, 0, r.stderr);
  const second = listSchedules()[1]; assert.equal(second.when.label, 'daily 9:00'); assert.equal(second.permissions, 'auto', "no more than the session's own mode"); assert.equal(second.picked, true);
  const listed = json(elu(f, ['schedules', '--json'])).schedules; assert.deepEqual(listed.map(value => value.id), [row.id, second.id]);
  assert.match(elu(f, ['schedules']).stdout, /^Schedules in sample app:\n {2}1 {2}every 3h {7}next .+ "check the build" {2}· Ask for approval {2}· schedule-[a-f0-9]{8}\n/);
  r = elu(f, ['schedules', 'pause', '1']); assert.equal(r.status, 0, r.stderr); assert.equal(listSchedules()[0].enabled, false);
  r = elu(f, ['schedules', 'resume', row.id]); assert.equal(r.status, 0, r.stderr); assert.equal(listSchedules()[0].enabled, true);
  f.conduct(); await until(() => conductorAlive(), 'the conductor');
  r = elu(f, ['schedules', 'run', '1']); assert.equal(r.status, 0, r.stderr);
  assert.ok(pendingRequests(f.root).some(value => value.scheduleId === row.id), 'a run is queued');
  r = elu(f, ['schedules', 'delete', '2']); assert.equal(r.status, 0, r.stderr); assert.deepEqual(listSchedules().map(value => value.id), [row.id]);
  r = elu(f, ['schedules', 'add', 'every', '3h']); assert.equal(r.status, 1); assert.match(r.stderr, /Write the message after when it runs/);
  r = elu(f, ['schedules', 'pause', '7']); assert.equal(r.status, 1); assert.match(r.stderr, /No schedule 7 in sample app/);
});

test('each vendor of the owner\'s session is told the commands; the shell can run them, and Approve for me runs them unasked', { timeout: 120000 }, async t => {
  const f = setup(t);
  // Claude Code: outside the sandbox, so they read ELU's files; Approve for me allows them, Ask for approval asks.
  for (const mode of ['ask', 'auto', 'full']) await f.controller.ask(`Where is normalization? ${mode}`, null, { permissions: mode }).finished;
  const runs = f.leads(), told = f.inputs('claude');
  assert.equal(runs.length, 3); assert.ok(told.every(row => OWN_COMMANDS.every(line => row.input.includes(line))));
  const [ask, auto, full] = runs.map(call => call.args);
  for (const args of [ask, auto]) assert.deepEqual(settingsOf(args).sandbox.excludedCommands, ['elu sessions:*', 'elu schedules:*']);
  assert.ok(auto.includes('--allowedTools=Bash(elu sessions:*)') && auto.includes('--allowedTools=Bash(elu schedules:*)'));
  assert.ok(!ask.some(arg => arg.startsWith('--allowedTools=Bash(elu')), 'Ask for approval asks for them');
  assert.equal(settingsOf(full).sandbox.enabled, false);
  const ctx = { project: f.root, cwd: f.root, access: 'read', saved: true, sandboxed: true };
  assert.deepEqual(allowedBy('Bash', { command: 'elu sessions archive this' }, { ...ctx, mode: 'auto' }), { by: 'default', text: 'elu sessions' });
  assert.deepEqual(allowedBy('execute', { command: 'elu schedules add every 3h check the build' }, { ...ctx, mode: 'auto' }), { by: 'default', text: 'elu schedules' });
  assert.equal(allowedBy('Bash', { command: 'elu sessions archive this' }, { ...ctx, mode: 'ask' }), null);
  assert.equal(allowedBy('Bash', { command: 'elu uninstall --yes' }, { ...ctx, mode: 'auto' }), null);
  assert.equal(allowedBy('Bash', { command: 'elu sessions archive this && rm -rf src' }, { ...ctx, mode: 'auto' }), null);
  // Codex: told in every mode. Below Full access its sandbox keeps ELU's own files and the
  // session's environment from commands, so the turn's elu hands each one to ELU through a
  // folder of the turn's own, the one place the profile lets a command write besides the work.
  f.controller.setDefaultModel({ vendor: 'codex' });
  for (const mode of ['ask', 'auto', 'full']) await f.controller.ask(`Where is normalization? codex ${mode}`, null, { permissions: mode }).finished;
  const codex = f.inputs('codex');
  for (const mode of ['ask', 'auto', 'full']) assert.ok(OWN_COMMANDS.every(line => codex.find(row => row.input.includes(`codex ${mode}`)).input.includes(line)), `Codex in ${mode} is told`);
  const profiles = f.rows('../calls.jsonl').filter(call => call.vendor === 'codex' && call.args.includes('default_permissions="elu_ask"')).map(call => call.args.find(arg => arg.startsWith('permissions.elu_ask=')));
  assert.equal(profiles.length, 2, 'Ask for approval and Approve for me');
  for (const value of profiles) {
    const writes = [...value.matchAll(/"([^"]+)"="write"/g)].map(match => match[1]);
    assert.ok(writes.length > 0 && writes.every(dir => /\/elu-code-own-[^/]+\/requests$/.test(dir)), value);
    assert.ok(writes.every(dir => !fs.existsSync(path.dirname(dir))), 'the folder goes with the turn');
    assert.ok(value.includes(`${JSON.stringify(personalDirectory())}="deny"`), "ELU's own files stay denied");
  }
  // Grok Build and Antigravity: told in every mode with permissions.
  fs.mkdirSync(path.join(f.parent, '.grok')); fs.writeFileSync(path.join(f.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
  atomic(path.join(personalDirectory(), 'conformance', 'grok.json'), { v: 1, bin: path.join(f.dir, 'grok'), version: '1.0.77', steps: Object.fromEntries(ADAPTERS.grok.conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });
  atomic(path.join(personalDirectory(), 'conformance', 'agy.json'), { v: 1, bin: path.join(f.dir, 'agy'), version: '1.5.4', steps: Object.fromEntries(ADAPTERS.agy.conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });
  for (const vendor of ['grok', 'agy']) {
    f.controller.setDefaultModel({ vendor });
    const task = await f.controller.ask(`Where is normalization? ${vendor}`, null, { permissions: 'auto' }).finished;
    assert.equal(task.state, 'answered', JSON.stringify(task.error));
    const prompt = f.inputs(vendor).find(row => row.input.includes(`normalization? ${vendor}`));
    assert.ok(prompt && OWN_COMMANDS.every(line => prompt.input.includes(line)), `${vendor} is told`);
  }
  // Repeating work: made with elu schedules where the turn has it, never by a timer of the model's own.
  assert.match(SCHEDULE_NOTE, /Never create cron jobs or other timers yourself/);
});

test('elu --help and elu sessions --help list the commands', () => {
  const run = args => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ELU_NO_UPDATE_CHECK: '1' } });
  const help = run(['--help']).stdout;
  for (const line of ['sessions [--all] | sessions archive N|this | sessions unarchive N', 'sessions rename N|this NAME | sessions new MESSAGE [--mode ask|auto|full]', 'schedules [--all] | schedules add WHEN MESSAGE [--mode ask|auto|full]', 'schedules pause|resume|delete|run N']) assert.ok(help.includes(line), line);
  assert.equal(run(['sessions', '--help']).stdout, SESSIONS_HELP); assert.equal(run(['schedules', '-h']).stdout, SCHEDULES_HELP);
  assert.match(SESSIONS_HELP, /elu sessions archive N\|this/); assert.match(SESSIONS_HELP, /elu sessions new MESSAGE/);
});
