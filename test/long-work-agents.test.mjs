import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, autoApprove, approvingConductor, git } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { ProjectController, registerProject } from '../lib/projects.mjs';
import { lock, readTask, saveTask } from '../lib/state.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import { Conductor, conductorAlive, enqueue } from '../lib/conductor.mjs';
import { readBoard } from '../lib/kanban.mjs';
import { approveTask, proposeTask, reportProgress } from '../lib/plan.mjs';
import { answerApproval, approvalSummary, pendingApprovals } from '../lib/approvals.mjs';
import { allowedFirst } from '../lib/session-commands.mjs';
import { usableSandbox } from '../lib/sandbox.mjs';
import { LABELS } from '../lib/modes.mjs';
import { blockedRows } from '../lib/blocked.mjs';
import { overloadClock } from '../lib/runner.mjs';
import { HELPER_JOBS } from '../lib/adapters/claude.mjs';
import { JOB_RULES, endJobs, jobsDir, listJobs, startJob, waitingJobs } from '../lib/jobs.mjs';
import { KEEP_GOING_TEXT, sentByElu } from '../lib/elu-sent.mjs';
import { lookJobs } from '../lib/long-work.mjs';
import { lookKeepGoing, readKeepGoing, setKeepGoing, standing } from '../lib/keep-going.mjs';

// Long jobs and keep going (README, "Long jobs") beside what a session has of its own: the
// agent it works with (@lead in a session written to @lead, the model after @model), what a
// working bot's turn may run, the model and effort the owner gave it, and the states of a turn
// that is not over: one that waits to try again after an overloaded answer, a review that
// runs in parts, a session that shows a Blocked line.
after(() => { setTimeout(() => { console.error('long-work-agents.test: something is still running 10 s after the last test.'); process.exit(1); }, 10000).unref(); });
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const rowsOf = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const TASK = { title: 'Pass the gates', description: 'Ten gates.', goal: 'Every gate passes.', objectives: ['Gate one passes', 'Gate two passes'], priority: 'medium', severity: 'low' };
const MINUTE = 60000;
// The stand-in Claude Code, with the --agents flag the real one has: a working bot's helpers need it.
function withAgents(dir) {
  const file = path.join(dir, 'claude'), text = fs.readFileSync(file, 'utf8'), from = "console.log('--print ";
  if (!text.includes("console.log('--agents --print ")) { assert.ok(text.includes(from), 'the stand-in lists its flags'); fs.writeFileSync(file, text.replace(from, "console.log('--agents --print ")); }
}
// What a test started stops before its folder goes: its conductors, then every job that still runs.
function setup(t, fake = {}) {
  const live = []; t.after(async () => { for (const conductor of live) await conductor.stop(); for (const row of waitingJobs()) { try { endJobs(row.dir, { by: 'delete' }); } catch { /* Gone. */ } } });
  const p = project(t), clis = fakeClis(p.parent, { mode: 'answer', ...fake }); withAgents(clis.dir);
  environment(t, { ...clis.env, HOME: p.parent, ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, ELU_TURN: undefined, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const repo = repository(p.root); registerProject(repo);
  const controller = autoApprove(new ProjectController(repo));
  const conduct = (longWork = {}) => { const conductor = approvingConductor(new Conductor({ tickMs: 20 })); conductor.longWork = longWork; conductor.start(); live.push(conductor); return conductor; };
  // What the stand-in does from now on, over what it did.
  const tells = more => { const file = path.join(clis.dir, 'fake.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...more })); };
  const leads = () => rowsOf(clis.calls).filter(call => call.vendor === 'claude' && call.args.includes('-p'));
  const inputs = () => rowsOf(path.join(p.parent, 'inputs.jsonl')).filter(row => row.vendor === 'claude');
  const shell = () => rowsOf(path.join(clis.dir, 'shell.jsonl'));
  const session = id => { try { return readTask(repo, String(id)); } catch { return null; } };
  const jobs = id => listJobs(jobsDir(repo, id));
  // A session as its last turn left it ten minutes ago, with an approved Task whose first
  // objective is met. said: the owner's messages there, oldest first.
  const chat = (id, { ago = 10 * MINUTE, said = [{ text: `Session ${id}` }], ...extra } = {}) => {
    const at = n => new Date(Date.now() - ago - (said.length - n) * 1000).toISOString();
    saveTask(repo, { id: String(id), kind: 'conversation', goal: `Session ${id}`, state: 'answered', permissions: 'full', worktree: repo.root, base: null, branch: null, createdAt: at(0), runs: [{ role: 'lead', vendor: 'claude', code: 0, logFile: path.join(p.parent, 'no-log.log'), startedAt: at(said.length), at: at(said.length) }], reviews: [], responses: [], messages: said.map((row, n) => ({ at: at(n), ...row })), sessions: {}, result: { outcome: 'done', summary: 'Looked.' }, ...extra });
    proposeTask(repo, String(id), TASK); approveTask(repo, String(id)); reportProgress(repo, String(id), { met: [1] });
    return readTask(repo, String(id));
  };
  // The check first ran on this computer an hour ago: sessions that worked since are its.
  const first = Date.now() - 60 * MINUTE;
  const stands = (id, extra = {}) => { const at = standing(repo, session(id), { requests: pendingRequests(repo.root), board: readBoard(repo), first, ...extra }); return at.go ? 'go' : at.why; };
  const sent = [], send = (root, text, options) => { sent.push({ root, text, options }); };
  const look = (options = {}) => lookKeepGoing({ enqueue: send, projects: () => [repo], ...options });
  return { ...p, ...clis, repo, root: repo.root, controller, conduct, tells, leads, inputs, shell, session, jobs, chat, stands, sent, send, look, first, live };
}
async function until(check, message, timeout = 30000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${typeof message === 'function' ? message() : message}`); await new Promise(resolve => setTimeout(resolve, 25)); }
}
const arg = (call, name) => call.args.includes(name) ? call.args[call.args.indexOf(name) + 1] : null;
const idle = (f, id) => !['running', 'preparing'].includes(f.session(id).state) && pendingRequests(f.root).every(row => row.state === 'done');
// The owner's messages in a session: to a bot, to @model, and to nobody (his approval, a continue).
const to = (name, text = 'Plan it.') => ({ text, to: `@${name}` }), plain = text => ({ text }), toModel = text => ({ text, toModel: true });

test('what ELU sends a session by itself goes to its working agent: @lead in a session written to @lead, the model after @model, never a bot that only answers', { timeout: 90000 }, async t => {
  const f = setup(t); f.look({ now: f.first });
  const lead = { bots: ['lead'], botsPicked: true };
  // 1: written to @lead, then his approval and a message that named nobody: @lead's.
  f.chat(1, { ...lead, said: [to('lead'), plain('Approved the Task: Pass the gates'), plain('continue')] });
  // 2: written to @lead, then to @model: the model's.
  f.chat(2, { ...lead, said: [to('lead'), toModel('Carry on yourself')] });
  // 3: written to @reviewer, which only answers: the model's.
  f.chat(3, { bots: ['reviewer'], botsPicked: true, said: [to('reviewer', 'Is this right?')] });
  // 4: written to @lead, then a question to @reviewer: still @lead's.
  f.chat(4, { bots: ['lead', 'reviewer'], botsPicked: true, said: [to('lead'), to('reviewer', 'Is this right?')] });
  // 5: written to @lead, which the owner then took out of the session: the model's.
  f.chat(5, { bots: [], botsPicked: true, said: [to('lead'), plain('continue')] });
  // 6: written to nobody, with @lead in it.
  f.chat(6, { ...lead, said: [plain('Look at the gates')] });
  for (const id of [1, 2, 3, 4, 5, 6]) assert.equal(f.stands(id), 'go', `session ${id}`);
  // Keep going: one message each, to its working agent.
  assert.deepEqual(f.look(), { pending: 0, sent: 6, stopped: 0 });
  const kept = Object.fromEntries(f.sent.map(row => [row.options.continuationTaskId, row.options.bot ?? null]));
  assert.ok(f.sent.every(row => row.text === KEEP_GOING_TEXT && row.root === f.root));
  assert.deepEqual(kept, { 1: 'lead', 2: null, 3: null, 4: 'lead', 5: null, 6: null });
  // A message of his to @lead that still waits in session 6 counts as written: its job's end is @lead's.
  enqueue(f.root, 'Take the gates over', { continuationTaskId: '6', priority: 0, typed: true, bot: 'lead' });
  assert.equal(f.stands(6), 'queued', 'and nothing more is sent it while that waits');
  // A long job of each ends: one message each, to the same agent.
  for (const id of [1, 2, 3, 4, 5, 6]) await startJob({ repo: f.repo, task: f.session(id), root: f.root, name: 'gate', command: ['echo gate-ok'], mode: 'full' });
  await until(() => [1, 2, 3, 4, 5, 6].every(id => f.jobs(id)[0]?.state === 'ended'), 'the six jobs to end');
  const told = []; lookJobs({ enqueue: (root, text, options) => { told.push({ root, text, options }); }, projects: () => [f.repo], joinMs: 0 });
  assert.equal(told.length, 6); assert.ok(told.every(row => sentByElu(row.text) && /Job gate ended with exit code 0/.test(row.text)));
  assert.deepEqual(Object.fromEntries(told.map(row => [row.options.continuationTaskId, row.options.bot ?? null])), { 1: 'lead', 2: null, 3: null, 4: 'lead', 5: null, 6: 'lead' });
});

// With the conductor and the stand-in vendor. The owner gave @lead a model and an effort for
// this session, and the session's own model another: each turn ELU starts runs as the agent it
// goes to runs in this session now.
test('a session written to @lead whose Task is not met is started again with @lead, on the model and effort @lead has in it; after @model, with the model, on the session\'s', { timeout: 180000 }, async t => {
  const f = setup(t); f.tells({ objectivesMet: [], subtasks: [] }); f.look({ now: f.first });
  const first = await f.controller.ask('Look at the gates and plan the work.', null, { bot: 'lead', permissions: 'full' }).finished;
  assert.equal(first.id, '1'); assert.equal(first.messages[0].to, '@lead'); assert.deepEqual(first.runs.map(run => run.role), ['bot:lead']);
  proposeTask(f.repo, '1', TASK); approveTask(f.repo, '1');
  f.controller.changeAgent('1', { bot: 'lead', to: { vendor: 'claude', model: 'opus', effort: 'high' } });
  f.controller.changeAgent('1', { bot: null, to: { vendor: 'claude', model: 'sonnet', effort: 'low' } });
  const said = () => f.session(1).messages.filter(row => row.text === KEEP_GOING_TEXT).length;
  const state = () => JSON.stringify({ kept: readKeepGoing(f.repo, '1'), state: f.session(1).state, roles: f.session(1).runs.map(run => run.role), stands: f.stands(1), queue: pendingRequests(f.root).map(row => [row.state, row.goal.slice(0, 30), row.bot ?? null]) });
  let before = f.leads().length;
  f.conduct({ jobsEveryMs: 50, keepEveryMs: 100, idleMs: 300 }); await until(() => conductorAlive(), 'the conductor');
  // Two turns with no progress, then it waits for him: both were @lead's.
  await until(() => readKeepGoing(f.repo, '1').stopped && said() === 2 && idle(f, 1), () => `ELU to stop starting it: ${state()}`, 60000);
  assert.deepEqual(f.session(1).runs.map(run => run.role), ['bot:lead', 'bot:lead', 'bot:lead'], 'the working agent, not the model');
  assert.deepEqual(pendingRequests(f.root).filter(row => row.goal === KEEP_GOING_TEXT).map(row => row.bot ?? null), ['lead', 'lead']);
  let started = f.leads().slice(before);
  assert.ok(started.length >= 2 && started.every(call => arg(call, '--model') === 'opus' && arg(call, '--effort') === 'high'), JSON.stringify(started.map(call => [arg(call, '--model'), arg(call, '--effort')])));
  // He writes to @model: the session is the model's, and so is each turn ELU starts from then on.
  before = f.leads().length;
  enqueue(f.root, 'Carry on yourself', { continuationTaskId: '1', priority: 0, typed: true, toModel: true });
  await until(() => readKeepGoing(f.repo, '1').stopped && said() === 4 && idle(f, 1), () => `ELU to stop starting it again: ${state()}`, 90000);
  assert.deepEqual(f.session(1).runs.slice(3).map(run => run.role), ['lead', 'lead', 'lead'], 'the model, after @model');
  assert.deepEqual(pendingRequests(f.root).filter(row => row.goal === KEEP_GOING_TEXT).map(row => row.bot ?? null), ['lead', 'lead', null, null]);
  started = f.leads().slice(before);
  assert.equal(started.length, 3); assert.ok(started.every(call => arg(call, '--model') === 'sonnet' && arg(call, '--effort') === 'low'), JSON.stringify(started.map(call => [arg(call, '--model'), arg(call, '--effort')])));
});

// A model and an effort the owner chooses for the session while its job runs. One chosen while
// something held the session waits for the next turn (lib/models.mjs nextModel): the turn ELU
// starts when the job ends is that next turn.
test('the turn ELU starts when a job ends runs on the model and effort the session has by then, and so does a working bot\'s', { timeout: 180000 }, async t => {
  const gate = name => `test -e ${JSON.stringify(name)} || { touch ${JSON.stringify(name)}; elu jobs start gate -- "sleep 2; echo gate-ok"; }`;
  const f = setup(t); f.tells({ shell: [{ when: 'run the gate', run: [gate(path.join(f.parent, 'gate-started'))] }] });
  // The session's model.
  const one = await f.controller.ask('run the gate and tell me when it is through', null, { permissions: 'full' }).finished;
  assert.equal(one.id, '1'); assert.deepEqual(f.jobs(1).map(job => [job.name, job.state, job.by]), [['gate', 'running', 'lead']]);
  const release = lock(f.repo, 'task-1');
  assert.equal(f.controller.changeAgent('1', { bot: null, to: { vendor: 'claude', model: 'sonnet', effort: 'low' } }).later, true);
  release();
  assert.deepEqual(f.session(1).nextModel, { vendor: 'claude', model: 'sonnet' }); assert.equal(f.session(1).leadEffort, 'low');
  let before = f.leads().length;
  const conductor = f.conduct({ jobsEveryMs: 50, joinMs: 0 }); await until(() => conductorAlive(), 'the conductor');
  await until(() => f.session(1).runs.length === 2 && idle(f, 1), 'the turn ELU started with the result', 60000);
  assert.ok(f.inputs().at(-1).input.includes('Job gate ended with exit code 0 after'), 'that turn read it');
  assert.deepEqual(f.leads().slice(before).map(call => [arg(call, '--model'), arg(call, '--effort')]), [['sonnet', 'low']]);
  assert.equal(f.session(1).nextModel, undefined, 'the turn took the choice in'); assert.equal(f.session(1).runs.at(-1).role, 'lead');
  await conductor.stop();
  // A session written to @lead: the owner gives @lead a model and an effort for it while its job runs.
  f.tells({ shell: [{ when: 'run the gate', run: [gate(path.join(f.parent, 'gate-started-2'))] }] });
  const two = await f.controller.ask('run the gate and tell me when it is through', null, { bot: 'lead', permissions: 'full' }).finished;
  assert.equal(two.id, '2'); assert.deepEqual(f.jobs(2).map(job => [job.name, job.state, job.by]), [['gate', 'running', 'bot:lead']]);
  f.controller.changeAgent('2', { bot: 'lead', to: { vendor: 'claude', model: 'opus', effort: 'high' } });
  assert.deepEqual(f.session(2).botModels, { lead: { vendor: 'claude', model: 'opus', effort: 'high' } });
  before = f.leads().length;
  f.conduct({ jobsEveryMs: 50, joinMs: 0 });
  await until(() => f.session(2).runs.length === 2 && idle(f, 2), 'the turn ELU started with the result', 60000);
  assert.deepEqual(f.session(2).runs.map(run => run.role), ['bot:lead', 'bot:lead']);
  const started = f.leads().slice(before);
  assert.ok(started.length >= 1 && started.every(call => arg(call, '--model') === 'opus' && arg(call, '--effort') === 'high'), JSON.stringify(started.map(call => [arg(call, '--model'), arg(call, '--effort')])));
});

// What a bot's turn may run (lib/session-commands.mjs BOT_VERBS): a bot that works in the
// session has elu artifacts and elu jobs, and its helpers with it. elu jobs start is asked for
// in its turn exactly as in the model's: Ask for approval asks the owner once, Approve for me
// and Full access ask nobody. The job has the mode of the turn that started it and writes what
// that turn may write, never more.
const GATE = 'run the gate';
for (const mode of ['ask', 'auto', 'full']) {
  test(`in ${LABELS[mode]}, @lead's turn starts a long job as the model's turn does, and the job has that turn's mode and writes no more than it`, { timeout: 180000 }, async t => {
    const f = setup(t, { asksOutside: true });
    let box = null, refusal = null; if (mode !== 'full') { try { box = usableSandbox({ what: 'a long job', then: 'start the job again' }); } catch (error) { refusal = error.message; } }
    // The owner's answers: he allows what he is asked, and each question is kept.
    const asked = [], known = new Set(), timer = setInterval(() => { try { for (const row of pendingApprovals({})) { if (known.has(row.id)) continue; known.add(row.id); asked.push({ role: row.role, summary: row.summary, taskId: String(row.taskId) }); answerApproval(row.id, 'allow'); } } catch { /* Read again. */ } }, 20);
    t.after(() => clearInterval(timer));
    const seen = {};
    for (const who of ['model', 'lead']) {
      const role = who === 'lead' ? 'bot:lead' : 'lead', made = `made-by-${who}.txt`, start = `elu jobs start gate -- "echo x > ${made}; echo done"`;
      f.tells({ shell: [{ when: GATE, run: [start, 'elu sessions'] }] });
      const before = f.leads().length, ran = f.shell().length;
      const task = await f.controller.ask(`${GATE} and tell me when it is through`, null, { permissions: mode, ...(who === 'lead' ? { bot: 'lead' } : {}) }).finished;
      assert.equal(task.runs[0].role, role); assert.equal(task.kind, 'conversation');
      // What the turn was given: the two lines, and the one rule for the command.
      const launch = f.leads()[before], settings = JSON.parse(arg(launch, '--settings')), allowed = launch.args.filter(row => row.startsWith('--allowedTools=Bash(elu'));
      assert.ok(JOB_RULES.every(line => f.inputs().find(row => row.input.includes(GATE) && row.input.includes(line))), `${who}: the turn was told`);
      if (mode === 'full') assert.deepEqual(settings.sandbox, { enabled: false });
      else { assert.ok(settings.sandbox.excludedCommands.includes('elu jobs:*'), `${who}: ${JSON.stringify(settings.sandbox.excludedCommands)}`); assert.equal(allowed.includes('--allowedTools=Bash(elu jobs:*)'), mode === 'auto', `${who}: ${allowed}`); }
      if (who === 'lead') {
        assert.deepEqual(mode === 'full' ? [] : settings.sandbox.excludedCommands, mode === 'full' ? [] : ['elu artifacts:*', 'elu jobs:*'], 'a working bot has elu artifacts and elu jobs');
        const agents = JSON.parse(arg(launch, '--agents')); assert.ok(Object.values(agents)[0].prompt.includes(HELPER_JOBS), 'its helpers were told');
      }
      // Asked for as the mode asks: once in Ask for approval, by nobody above it.
      const questions = asked.filter(row => row.taskId === String(task.id) && row.summary.startsWith('Run: elu jobs start gate'));
      assert.deepEqual(questions.map(row => row.role), mode === 'ask' ? [role] : [], `${who}: ${JSON.stringify(asked)}`);
      const [started, sessions] = f.shell().slice(ran);
      assert.equal(started.command, start);
      // The session's other commands are its model's.
      assert.deepEqual([sessions.command, sessions.status === 0], ['elu sessions', who === 'model'], sessions.out);
      if (who === 'lead') assert.equal(sessions.out, "In a bot's turn, elu has elu artifacts and elu jobs.");
      // Where this computer has no sandbox, a job below Full access is refused plainly, to both.
      if (mode !== 'full' && !box) { assert.ok(started.out.includes(refusal), started.out); assert.equal(f.jobs(task.id).length, 0); seen[who] = { asked: questions.length, job: null }; continue; }
      assert.match(started.out, new RegExp(`^Started job gate \\(${LABELS[mode]}\\)\\. Its log: `));
      await until(() => f.jobs(task.id)[0]?.state === 'ended', `${who}: the job to end`);
      const job = f.jobs(task.id)[0], record = JSON.parse(fs.readFileSync(path.join(jobsDir(f.repo, task.id), 'gate', 'job.json'), 'utf8'));
      assert.deepEqual([job.name, job.mode, job.by], ['gate', mode, role]);
      const file = path.join(task.worktree, made);
      if (mode === 'full') { assert.equal(record.sandbox, undefined); assert.equal(fs.existsSync(file), true, 'Full access keeps a job from nothing'); }
      else {
        // What the turn itself may write in its folder is what its job may.
        const turnWrites = !settings.sandbox.filesystem.denyWrite.includes(task.worktree);
        assert.deepEqual([record.sandbox, record.writes], [box.kind, turnWrites], `${who}: ${JSON.stringify(record)}`);
        // (The stand-in for Codex's sandbox helper runs a command as it is; a real sandbox keeps the write out.)
        if (!turnWrites && box.kind !== 'codex') assert.equal(fs.existsSync(file), false, `${who}: the job wrote the folder its turn could not`);
      }
      seen[who] = { asked: questions.length, job: [job.mode, record.sandbox ?? null] };
    }
    assert.deepEqual(seen.lead, seen.model, 'the bot is asked, and its job runs, as the model\'s');
  });
}

// A turn that is not over is not "idle with nothing running", whatever it waits on inside. The
// test looks as the check looks (standing, then the check itself with its idle minutes made
// none) every few milliseconds from the turn's first moment at work to its last.
const atWork = row => ['running', 'preparing'].includes(row.state);
function watch(t, f, id) {
  const seen = []; let over = false;
  const timer = setInterval(() => {
    if (over) return; const task = f.session(id); if (!task) return;
    const waits = (task.messages ?? []).some(row => row.from === 'ELU' && row.line && /Trying again/.test(row.text));
    // The turn runs in this process, so its state cannot change between this read and the check.
    seen.push({ state: task.state, stands: f.stands(id), waits, sent: atWork(task) ? f.look({ idleMs: 0 }).sent : 0 });
  }, 10);
  t.after(() => clearInterval(timer));
  return { stop() { over = true; clearInterval(timer); const from = seen.findIndex(atWork); return from < 0 ? [] : seen.slice(from); } };
}
// Every look from the turn's start to its end found it at work, and the check started nothing.
function leftAlone(f, during) {
  const last = during.findLastIndex(atWork), turn = during.slice(0, last + 1);
  assert.ok(turn.length > 5, `${turn.length} looks while the turn ran`);
  assert.deepEqual([...new Set(turn.map(row => `${row.state}: ${row.stands}`))].filter(row => !/^(?:running|preparing): working$/.test(row)), [], 'at work at every look, with no pause between its steps the check could take for idle');
  assert.equal(during.reduce((sum, row) => sum + row.sent, 0), 0, 'nothing was sent while the turn ran'); assert.equal(f.sent.length, 0);
}
test('a turn that waits to try again after an overloaded answer, with a model chosen for the next turn, is left to finish; then ELU starts the session on that model', { timeout: 120000 }, async t => {
  const waits = overloadClock.waits; overloadClock.waits = [600, 600, 600]; t.after(() => { overloadClock.waits = waits; });
  const f = setup(t); f.tells({ objectivesMet: [], subtasks: [] }); f.look({ now: f.first });
  const first = await f.controller.ask('Where are the gates?', null, { permissions: 'full' }).finished, id = first.id;
  proposeTask(f.repo, id, TASK); approveTask(f.repo, id);
  assert.equal(f.stands(id), 'go', 'idle, its Task not met');
  f.tells({ overloaded: 2 });
  const before = f.leads().length, looks = watch(t, f, id), turn = f.controller.ask('What would you change?', id);
  await until(() => (f.session(id).messages ?? []).some(row => row.from === 'ELU' && row.line && /Trying again/.test(row.text)), 'the turn to wait to try again', 20000);
  assert.equal(f.controller.changeAgent(id, { bot: null, to: { vendor: 'claude', model: 'sonnet', effort: 'low' } }).later, true, 'the choice waits for the next turn');
  const task = await turn.finished, during = looks.stop();
  assert.equal(task.state, 'answered', JSON.stringify(task.error)); assert.equal(f.leads().length - before, 3, 'twice overloaded, then it ran');
  assert.ok(during.some(row => row.waits && atWork(row)), 'the check looked while the turn waited to try again');
  leftAlone(f, during);
  // The turn has ended: the session is idle with its Task not met, and ELU starts it, once.
  assert.equal(f.stands(id), 'go'); assert.deepEqual(f.look({ idleMs: 0 }), { pending: 0, sent: 1, stopped: 0 });
  assert.deepEqual(f.sent.map(row => [row.text, row.options]), [[KEEP_GOING_TEXT, { continuationTaskId: String(id), priority: 0 }]]);
  const next = await f.controller.ask(f.sent[0].text, id).finished, call = f.leads().at(-1);
  assert.equal(next.state, 'answered', JSON.stringify(next.error));
  assert.deepEqual([arg(call, '--model'), arg(call, '--effort')], ['sonnet', 'low'], 'on the model and effort he chose while it waited');
});

// A change too long for the reviewer's model in one piece is reviewed in parts, one after
// another, inside the turn that made it (lib/runner.mjs); here one part is answered overloaded
// and tried again after its wait. The session's bot only reviews: what ELU sends is the model's.
test('a turn whose review runs in parts, one part waiting to try again, is left to finish; then ELU starts the session with its model, not the bot that reviewed', { timeout: 180000 }, async t => {
  const waits = overloadClock.waits; overloadClock.waits = [600, 600, 600]; t.after(() => { overloadClock.waits = waits; });
  const f = setup(t, { mode: 'normal' }); f.look({ now: f.first });
  const write = (root, label) => { for (const n of [1, 2, 3, 4]) { fs.mkdirSync(path.join(root, 'lib'), { recursive: true }); fs.writeFileSync(path.join(root, 'lib', `part-${n}.mjs`), Array.from({ length: 600 }, (_, line) => `export const ${label}${n}_${String(line + 1).padStart(4, '0')} = '${label}${n}, line ${String(line + 1).padStart(4, '0')}';\n`).join('')); } };
  fs.writeFileSync(path.join(f.root, '.gitignore'), 'node_modules/\n'); write(f.root, 'old'); git(f.root, ['add', '-A']); git(f.root, ['commit', '-q', '-m', 'Add four parts']);
  const first = await f.controller.ask('Normalize coupon codes', null, { bots: ['reviewer'] }).finished, id = first.id;
  assert.equal(first.state, 'ready', JSON.stringify(first.error)); assert.equal(first.reviewStatus, 'passed');
  // Its Task is approved and not met, and the owner turned keep going on for it.
  proposeTask(f.repo, id, TASK); approveTask(f.repo, id); setKeepGoing(f.repo, id, true);
  // The session rewrites the four files whole: too long in one piece, and the first part is answered 529 Overloaded once.
  write(first.worktree, 'new');
  f.tells({ mode: 'normal', tooLong: 150000, overloaded: 1, overloadedOn: ['"otherFiles":'], objectivesMet: [], subtasks: [] });
  const looks = watch(t, f, id), task = await f.controller.ask('Normalize coupon codes', id).finished, during = looks.stop();
  assert.equal(task.state, 'ready', JSON.stringify(task.error));
  assert.deepEqual(task.reviews.slice(1).map(row => [row.role, row.parts]), [['bot:reviewer', 2]], 'one review, in two parts');
  assert.deepEqual((task.messages ?? []).filter(row => row.from === 'ELU' && row.line).map(row => row.text), ['Claude was overloaded. Tried again once.']);
  assert.ok(during.some(row => row.waits && atWork(row)), 'the check looked while a part of the review waited to try again');
  leftAlone(f, during);
  // The review has passed and the Task is not met: ELU starts the session, with its model.
  assert.equal(f.stands(id), 'go'); assert.deepEqual(f.look({ idleMs: 0 }), { pending: 0, sent: 1, stopped: 0 });
  assert.deepEqual(f.sent.map(row => [row.text, row.options]), [[KEEP_GOING_TEXT, { continuationTaskId: String(id), priority: 0 }]]);
});

test('a session that shows a Blocked line waits for the owner: ELU does not start it again until he writes to it', { timeout: 90000 }, async t => {
  const f = setup(t); f.look({ now: f.first });
  const at = new Date(Date.now() - 10 * MINUTE).toISOString(), log = path.join(f.parent, 'no-log.log');
  const turn = (role, more = {}) => ({ role, vendor: 'claude', code: 0, session: 'work-1', launch: 'work-1', logFile: log, startedAt: at, at, permissions: 'auto', ...more });
  // A command no mode but Full access allows, which a stand-in command refused; the turn went on to answer.
  const push = { tool: 'Bash', tool_use_id: 'toolu_1', input: { command: 'git push --force origin main' }, never: 'git push' };
  const PUSH_LINE = 'Blocked: git push is not allowed outside Full access (git push --force origin main). Run it yourself.';
  // 1: the session's model was refused it.
  f.chat(1, { permissions: 'auto', runs: [turn('lead', { denials: [push] })] });
  assert.deepEqual(blockedRows(f.session(1)).map(row => row.text), [PUSH_LINE]);
  assert.equal(f.stands(1), 'blocked');
  // 2: the same in a session written to @lead, whose turns do its work.
  f.chat(2, { permissions: 'auto', bots: ['lead'], botsPicked: true, said: [to('lead')], runs: [turn('bot:lead', { denials: [push] })] });
  assert.deepEqual(blockedRows(f.session(2)).map(row => row.text), [PUSH_LINE]); assert.equal(f.stands(2), 'blocked');
  // 3: an approval nobody answered: the turn went on without it, and says what it left undone.
  f.chat(3, { permissions: 'ask', runs: [turn('lead', { permissions: 'ask', denials: [{ tool: 'Bash', tool_use_id: 'toolu_2', input: { command: 'npm install' } }] })], approvals: [{ id: 'work-1-toolu_2', role: 'lead', session: 'work-1', tool: 'Bash', summary: 'Run: npm install', decision: 'timeout', at }] });
  // (Keep going is off in Ask for approval until he turns it on.)
  assert.equal(f.stands(3), 'off'); setKeepGoing(f.repo, '3', true);
  assert.deepEqual(blockedRows(f.session(3)).map(row => row.text), ['Not done: Run npm install. No answer in 20 minutes; reply to try again.']);
  assert.equal(f.stands(3), 'blocked');
  // 4: a turn that was refused nothing, and 5: one refused a command its mode keeps from it, which
  // shows no line once the turn has answered. Both are started.
  f.chat(4, { permissions: 'auto' }); assert.equal(f.stands(4), 'go');
  f.chat(5, { permissions: 'auto', runs: [turn('lead', { denials: [{ tool: 'Bash', tool_use_id: 'toolu_3', input: { command: 'npm install' } }] })] });
  assert.deepEqual(blockedRows(f.session(5)), []); assert.equal(f.stands(5), 'go');
  assert.deepEqual(f.look({ idleMs: 0 }), { pending: 0, sent: 2, stopped: 0 }); assert.deepEqual(f.sent.map(row => row.options.continuationTaskId).sort(), ['4', '5']);
  // His next message there has a turn of its own: what that turn is refused, or not, decides from then on.
  const task = f.session(1), now = new Date().toISOString();
  saveTask(f.repo, { ...task, messages: [...task.messages, { at: now, text: 'Leave the push to me' }], runs: [...task.runs, turn('lead', { session: 'work-2', launch: 'work-2', startedAt: now, at: now })] });
  assert.deepEqual(blockedRows(f.session(1)), []); assert.equal(f.stands(1), 'go');
});

// In Ask for approval the vendor asks the owner before a command of ELU's runs, and ELU runs
// what he allowed there without asking again (lib/session-commands.mjs allowedFirst). A long
// job's command is a shell line in quotes: && ; and | inside it are the job's, not the turn's.
test('a long job the owner allowed when the vendor asked is started without a second question, whatever its quoted command holds', () => {
  const row = (id, command, more = {}) => ({ id, tool: 'Bash', summary: approvalSummary('Bash', { command }), decision: 'allow', ...more });
  const JOB = 'npm ci && npm test; echo done | tee out.log', argv = ['jobs', 'start', 'gate', '--', JOB];
  for (const typed of [`elu jobs start gate -- "${JOB}"`, `elu jobs start gate -- '${JOB}'`, `cd app && elu jobs start gate -- "${JOB}" > start.log`]) {
    const rows = [row('work-1-toolu_1', typed)], used = new Map();
    assert.equal(allowedFirst(rows, argv, used), true, typed);
    assert.equal(allowedFirst(rows, argv, used), false, `${typed}: it answers one request, once`);
  }
  // Typed with no quotes, the shell runs three commands: the job is npm ci alone.
  const open = [row('work-1-toolu_2', `elu jobs start gate -- ${JOB}`)];
  assert.equal(allowedFirst(open, argv, new Map()), false); assert.equal(allowedFirst(open, ['jobs', 'start', 'gate', '--', 'npm', 'ci'], new Map()), true);
  // What a quoted command holds is no command of the line: it answers no request of its own.
  const inside = [row('work-1-toolu_3', 'elu jobs start gate -- "sleep 1; elu sessions delete 5"')];
  assert.equal(allowedFirst(inside, ['sessions', 'delete', '5'], new Map()), false);
  assert.equal(allowedFirst(inside, ['jobs', 'start', 'gate', '--', 'sleep 1; elu sessions delete 5'], new Map()), true);
  // A ; the model escaped is a word of the command, as the shell hands it over.
  assert.equal(allowedFirst([row('work-1-toolu_4', String.raw`elu jobs start sweep -- find . -name "*.tmp" -exec ls {} \;`)], ['jobs', 'start', 'sweep', '--', 'find', '.', '-name', '*.tmp', '-exec', 'ls', '{}', ';'], new Map()), true);
  // A line of two answers both, each once; one he declined, and a row of ELU's own, answer nothing.
  const two = [row('work-1-toolu_5', 'elu jobs start a -- "x; y" && elu jobs start b -- z')], used = new Map();
  assert.equal(allowedFirst(two, ['jobs', 'start', 'b', '--', 'z'], used), true); assert.equal(allowedFirst(two, ['jobs', 'start', 'a', '--', 'x; y'], used), true);
  assert.equal(allowedFirst(two, ['jobs', 'start', 'a', '--', 'x; y'], used), false);
  assert.equal(allowedFirst([row('work-1-toolu_6', `elu jobs start gate -- "${JOB}"`, { decision: 'deny' })], argv, new Map()), false);
  assert.equal(allowedFirst([row('work-1-own-1', `elu jobs start gate -- "${JOB}"`)], argv, new Map()), false);
});
