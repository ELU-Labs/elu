import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, autoApprove } from './helpers.mjs';
import { ProjectController, registerProject } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { approveTask, proposeTask, reportProgress, sessionTasks, settleReply } from '../lib/plan.mjs';
import { readStore } from '../lib/artifacts.mjs';
import { answerApproval, pendingApprovals } from '../lib/approvals.mjs';
import { repository } from '../lib/git.mjs';

// The owner on 2026-11-15: he asked @lead to put an eval's history on the session's Artifacts
// tab. @lead's shell had no elu artifacts ("elu artifacts works inside a session": only the
// model's turns had ELU's own commands), and it said it had added the artifact to the Task,
// which had none. Every agent that works in a session fills and changes its Task's artifacts:
// @lead and every other working bot, and the helpers it starts, which share its shell. A bot
// revises the Task's artifacts as the model does, approved as the session's mode approves a
// Task, and the work it did on the Task stays. Nothing says a Task changed when it did not.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const after = (args, flag) => args[args.indexOf(flag) + 1];
// The stand-in Claude Code, with the --agents flag the real one has: @lead's helpers need it.
function withAgents(dir) {
  const file = path.join(dir, 'claude'), text = fs.readFileSync(file, 'utf8'), from = "console.log('--print ";
  if (!text.includes("console.log('--agents --print ")) { assert.ok(text.includes(from), 'the stand-in lists its flags'); fs.writeFileSync(file, text.replace(from, "console.log('--agents --print ")); }
}
const TASK = { title: 'Uppercase coupons', description: 'Make normalize return the code in upper case.', goal: 'Coupon codes compare equal whatever their case.', objectives: ['normalize returns upper case', 'The coupon test passes'], priority: 'medium', severity: 'low', criteria: [], estimateMinutes: null };
const HISTORY = { title: 'Eval history', shows: 'accuracy by run', every: null };
// Session 1, written to @lead in the given mode, with an approved Task that has one artifact
// (artifacts: others) and one objective met. fake: what the stand-in does from then on.
async function leadSession(t, { mode = 'ask', fake = {}, artifacts = [HISTORY] } = {}) {
  const p = project(t), clis = fakeClis(p.parent, { mode: 'answer' }); withAgents(clis.dir);
  environment(t, { ...clis.env, HOME: p.parent, ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); registerProject(controller.repo);
  const repo = controller.repo;
  await controller.ask('Look at the coupon code and plan the work.', null, { bot: 'lead', permissions: mode }).finished;
  proposeTask(repo, '1', { ...TASK, artifacts }); approveTask(repo, '1');
  reportProgress(repo, '1', { met: [1], evidence: [[1, 'normalize returns value.toUpperCase()']] });
  const file = path.join(clis.dir, 'fake.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...fake }));
  const runs = () => rows(clis.calls).filter(row => row.vendor === 'claude' && row.args.includes('-p'));
  return { ...p, fake: clis, controller, repo, runs, shell: () => rows(path.join(clis.dir, 'shell.jsonl')), session: () => readTask(repo, '1') };
}
// The scores of 22 runs, a block each, as @lead built them.
const RUNS = JSON.stringify({ blocks: Array.from({ length: 22 }, (_, index) => ({ kind: 'score', label: `Run ${index + 1}`, value: 60 + index, unit: '%', target: 85 })) });
const ASK = 'Fill the eval history with the score of each run.';

test('@lead fills the session\'s artifacts from its shell, with as many blocks as it built, and has no other ELU command there', { timeout: 90000 }, async t => {
  const f = await leadSession(t, { fake: { shell: [{ when: ASK, anywhere: true, run: [`elu artifacts set 1 '${RUNS}'`, 'elu artifacts', `elu artifacts set Latency '{"kind":"score","value":4}'`, 'elu sessions'] }] } });
  const before = f.runs().length;
  const task = await f.controller.ask(ASK, '1', { bot: 'lead' }).finished;
  assert.equal(task.runs.at(-1).role, 'bot:lead');
  const [set, list, loose, sessions] = f.shell();
  assert.equal(set.status, 0, set.out); assert.match(set.out, /Filled "Eval history": 22 blocks\./);
  assert.equal(list.status, 0, list.out); assert.match(list.out, /"Eval history"/);
  // A title the Task does not have is never said to be added to it.
  assert.equal(loose.status, 0, loose.out); assert.match(loose.out, /The Task has no artifact "Latency", so it is not on the Artifacts tab/);
  assert.equal(sessions.status, 1); assert.match(sessions.out, /In a bot's turn, elu has elu artifacts\./);
  const kept = readStore(f.repo, '1').items['eval history'].updates;
  assert.equal(kept.length, 1); assert.equal(kept[0].by, 'model'); assert.equal(kept[0].data.blocks.length, 22);
  // Its launch: elu artifacts runs outside the sandbox, and no other ELU command does. Claude
  // Code allows it in no mode, as in the model's turn: ELU's relay answers it, unasked where
  // the file it names is one the sandbox lets the turn read (lib/permission-rules.mjs allowedBy).
  // Its helpers are of the same launch (--agents), with its shell and these settings.
  const run = f.runs().slice(before).find(row => after(row.args, '--model') === 'fable');
  assert.ok(run, "@lead's turn"); assert.ok(run.args.includes('--agents'), 'with its helpers');
  assert.deepEqual(JSON.parse(after(run.args, '--settings')).sandbox.excludedCommands, ['elu artifacts:*']);
  assert.deepEqual(run.args.filter(arg => arg.startsWith('--allowedTools=Bash(elu')), []);
});

test('@lead revises the Task\'s artifacts in Approve for me: the Task changes in place and what it marked stays', { timeout: 90000 }, async t => {
  const revised = { ...TASK, artifacts: [{ title: 'Eval history', shows: 'accuracy by run', everyMinutes: null }, { title: 'Latency', shows: 'median seconds', everyMinutes: 10 }] };
  // Its reply marks nothing more, so what stays is what was marked before.
  const f = await leadSession(t, { mode: 'auto', fake: { revise: { when: 'Add a latency artifact', task: revised }, objectivesMet: [] } });
  const before = sessionTasks(f.repo, '1');
  await f.controller.ask('Add a latency artifact too.', '1', { bot: 'lead' }).finished;
  const now = sessionTasks(f.repo, '1');
  assert.equal(now.length, before.length, 'no new Task');
  const task = now.at(-1);
  assert.deepEqual(task.artifacts.map(row => row.title), ['Eval history', 'Latency']);
  assert.deepEqual([task.id, task.revision, task.state, task.met, task.evidence], [before.at(-1).id, before.at(-1).revision, 'approved', [1], before.at(-1).evidence]);
});

test('a revised Task with the same goal and objectives keeps what was marked once the owner approves it, and an unread revision says the Task did not change', t => {
  const p = project(t), repo = repository(p.root);
  saveTask(repo, { id: '3', kind: 'conversation', worktree: p.root, base: null, branch: null, goal: 'Uppercase coupons', state: 'answered', createdAt: new Date().toISOString(), runs: [], reviews: [], messages: [], sessions: {} });
  // Ask for approval: the revision waits; his approval keeps the marks, evidence and ETA.
  proposeTask(repo, '3', { ...TASK, artifacts: [HISTORY] }); approveTask(repo, '3');
  reportProgress(repo, '3', { met: [1], evidence: [[1, 'It returns upper case']], eta: 15 });
  proposeTask(repo, '3', { ...TASK, artifacts: [HISTORY, { title: 'Latency', shows: 'median seconds', every: null }] }, { by: '@lead' });
  assert.equal(sessionTasks(repo, '3').at(-1).state, 'proposed');
  const approved = approveTask(repo, '3');
  assert.deepEqual([approved.met, approved.evidence, approved.etaMinutes, approved.artifacts.length], [[1], ['It returns upper case', ''], 15, 2]);
  // A new goal is a new Task, as before: nothing carried.
  proposeTask(repo, '3', { ...TASK, goal: 'Coupon codes are trimmed too.' }, { by: '@lead' });
  assert.deepEqual(approveTask(repo, '3').met, []);
  // A reply whose revised Task could not be read says so: the Task did not change.
  const response = { outcome: 'done', intent: 'answer', summary: 'Added Latency to the Task.', plan: { unread: true } };
  settleReply(repo, { id: '3' }, response, { plan: { propose: true }, message: 'Add latency' });
  assert.equal(response.summary, 'Added Latency to the Task.\n\nThe Task did not change: ELU could not read the revised Task in this reply.');
});

// A working bot's elu artifacts is answered as the model's own is (test/session-commands.test.mjs).
// Claude Code runs it outside its sandbox, where it reads the file it names: one the sandbox keeps
// from the turn (a key in ~/.ssh) is never read unasked, and a refresh script the bot saves is the
// owner's to read whole and allow, in Ask for approval and in Approve for me. A file in the
// project is read unasked. Full access asks nothing.
const WATCHED = { title: 'Eval history', shows: 'accuracy by run', every: 5 };
const SCRIPT = ['#!/usr/bin/env node', '// Prints the last run for the Artifacts tab.', "console.log(JSON.stringify({ kind: 'note', text: 'Run 4 of the eval.' }));", ''].join('\n');
const PROBE = 'Fill the eval history from the files.', QUESTION = 'Save the refresh script of "Eval history", which ELU runs every 5 min';
const KEY = path.join('.ssh', 'id_test'), SECRET = 'not a real key, a stand-in for a secret';
async function until(check, message, timeout = 30000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 25)); }
}
// The files a turn may name: a key in the owner's home, results and a refresh script in the project.
function probeFiles(f) {
  fs.mkdirSync(path.join(f.parent, '.ssh'), { mode: 0o700 }); fs.writeFileSync(path.join(f.parent, KEY), `${SECRET}\nline two of it\n`, { mode: 0o600 });
  const results = path.join(f.root, 'results.json'), script = path.join(f.root, 'refresh.cjs');
  fs.writeFileSync(results, '{"blocks":[{"kind":"note","text":"Run 3 read from the project."}]}\n'); fs.writeFileSync(script, SCRIPT);
  return { read: `elu artifacts set 1 --file ${JSON.stringify(results)}`, keep: `elu artifacts script 1 ${JSON.stringify(script)}` };
}
const tells = (f, run) => { const file = path.join(f.fake.dir, 'fake.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), asksOutside: true, shell: [{ when: PROBE, anywhere: true, run }] })); };
for (const mode of ['ask', 'auto']) {
  test(`@lead's elu artifacts in ${mode === 'ask' ? 'Ask for approval' : 'Approve for me'}: a file the sandbox keeps from its turn is asked about first, and a refresh script is asked for with the script whole`, { timeout: 180000 }, async t => {
    const f = await leadSession(t, { mode, artifacts: [WATCHED] }), { read, keep } = probeFiles(f);
    const kept = [`elu artifacts set 1 --file ~/${KEY}`, `elu artifacts script 1 ~/${KEY}`];
    tells(f, [...kept, read, keep, keep]);
    const seen = new Set(), waiting = start => pendingApprovals({ taskId: '1' }).find(row => !seen.has(row.id) && row.summary.startsWith(start));
    const turn = f.controller.ask(PROBE, '1', { bot: 'lead' });
    let failed = null; turn.finished.catch(error => { failed = error; });
    for (const command of kept) {
      // Run unasked, it would be in shell.jsonl with no question before it.
      await until(() => failed || waiting(`Run: ${command}`) || f.shell().some(row => row.command === command && row.asked !== true), `the question for ${command}`);
      const asked = waiting(`Run: ${command}`);
      assert.ok(asked, `${command} ran unasked: ${JSON.stringify(f.shell().at(-1))} ${failed?.message ?? ''}`);
      assert.equal(asked.role, 'bot:lead'); seen.add(asked.id);
      assert.ok(answerApproval(asked.id, 'deny'));
    }
    // The script: asked whole, as written, with nothing kept before the answer; declined, then allowed.
    for (const decision of ['deny', 'allow']) {
      await until(() => failed || waiting(QUESTION), `the question for the script (${decision})`);
      const asked = waiting(QUESTION);
      assert.ok(asked, `the script was kept unasked: ${JSON.stringify(f.shell().at(-1))} ${failed?.message ?? ''}`);
      assert.deepEqual([asked.role, asked.script], ['bot:lead', { artifact: 'Eval history', every: 5, text: SCRIPT }]);
      assert.equal(readStore(f.repo, '1').items['eval history']?.script, undefined);
      seen.add(asked.id); assert.ok(answerApproval(asked.id, decision));
    }
    const task = await turn.finished;
    assert.equal(task.runs.at(-1).role, 'bot:lead');
    const ran = f.shell();
    assert.deepEqual(ran.map(row => [row.status, row.asked === true]), [[1, true], [1, true], [0, false], [1, false], [0, false]], JSON.stringify(ran));
    assert.equal(ran[3].out, 'The owner did not save the refresh script of "Eval history". Nothing was saved. Do not try it another way.');
    assert.match(ran[4].out, /^Saved the refresh script of "Eval history"\./);
    // The file in the project was read unasked, as the relay's default allows it.
    assert.ok((task.approvals ?? []).some(row => row.decision === 'allow' && row.by === 'default' && row.rule === 'elu artifacts set'), JSON.stringify(task.approvals));
    const store = readStore(f.repo, '1').items['eval history'];
    assert.deepEqual([store.updates.length, store.script.text], [1, SCRIPT]);
    assert.ok(!JSON.stringify([ran, store, task.messages]).includes('not a real key'), 'nothing of the key reached the turn or the records');
  });
}

test('@lead in Full access fills an artifact from a file and saves its refresh script with nobody asked', { timeout: 120000 }, async t => {
  const f = await leadSession(t, { mode: 'full', artifacts: [WATCHED] }), { read, keep } = probeFiles(f);
  tells(f, [read, keep]);
  const task = await f.controller.ask(PROBE, '1', { bot: 'lead' }).finished;
  assert.deepEqual(f.shell().map(row => [row.status, row.asked === true]), [[0, false], [0, false]], JSON.stringify(f.shell()));
  const store = readStore(f.repo, '1').items['eval history'];
  assert.deepEqual([store.updates.length, store.script.text], [1, SCRIPT]);
  assert.equal(pendingApprovals({ taskId: '1' }).length, 0);
  assert.ok(!(task.approvals ?? []).some(row => row.summary === QUESTION));
});
