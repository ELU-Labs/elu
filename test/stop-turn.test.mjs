import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, fakeClis, autoApprove } from './helpers.mjs';
import { ProjectController, conversationEntries } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';
import { afterResult } from '../lib/process.mjs';
import { runSteps, endedSteps, runsOfEntries } from '../lib/run-activity.mjs';

// The owner stops a turn whose agent already gave its answer and then waits on a command it
// left running in the background, in a session of its own (Claude Code's background Bash).
// The stop ends that command too, says so in one line, and the answer is the turn's.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
async function until(check, message, timeout = 20000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const alive = pid => { const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }); return r.status === 0 && Boolean(r.stdout.trim()) && !r.stdout.trim().startsWith('Z'); };
const ANSWER = 'The deploy is running. Should I tell you when it is done?';

test('a stop after the agent answered ends the command it left running in the background and keeps that answer as the turn\'s', async t => {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer' });
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  // The stand-in Claude Code, once the flag is there: it answers, starts a loop in a session of
  // its own, and stays, as the real one waits on a background command after its result.
  const flag = path.join(p.parent, 'linger'), pids = path.join(p.parent, 'loop.pid'), file = path.join(fake.dir, 'claude'), text = fs.readFileSync(file, 'utf8');
  const answerAt = '// blocked (fake.json): the question this turn ends on', stayAt = '// A stream-json run ends when its input does;';
  assert.equal(text.includes(answerAt) && text.includes(stayAt), true);
  fs.writeFileSync(file, text.replace(answerAt, `if(fs.existsSync(${JSON.stringify(flag)}))result.summary=${JSON.stringify(ANSWER)};\n${answerAt}`)
    .replace(stayAt, `if(fs.existsSync(${JSON.stringify(flag)})){const {spawn}=await import('node:child_process');const loop=spawn('sh',['-c','for i in $(seq 1 110); do sleep 1; done'],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pids)},String(loop.pid));setInterval(()=>{},1000);await new Promise(()=>{});}\n${stayAt}`));
  const first = await controller.ask('Where is coupon normalization?').finished;
  const before = readTask(controller.repo, first.id).result.summary;
  assert.notEqual(before, ANSWER);
  fs.writeFileSync(flag, '');
  const run = controller.ask('Deploy it and watch the run.', first.id);
  await until(() => fs.existsSync(pids) && readTask(controller.repo, first.id).state === 'running', 'the answer and the background loop');
  const loop = Number(fs.readFileSync(pids, 'utf8'));
  t.after(() => { try { process.kill(loop, 'SIGKILL'); } catch {} });
  assert.equal(alive(loop), true);
  await controller.stop(first.id);
  await run.finished.catch(() => {});
  const gone = Date.now() + 3000; while (alive(loop) && Date.now() < gone) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(alive(loop), false, 'the stop ends the command the turn left running');
  const task = readTask(controller.repo, first.id);
  assert.equal(task.result.summary, ANSWER, 'the answer it gave is the turn\'s, not the one before');
  assert.equal(task.state, 'answered');
  const said = task.messages.filter(row => row.from === 'ELU');
  assert.equal(said.length, 1); assert.match(said[0].text, /^Stopping also ended a command the agent started: for i in \$\(seq 1 110\); do sleep 1; done\.$/);
  const entries = conversationEntries(controller.repo, task).map(row => row.text);
  assert.equal(entries.includes(ANSWER), true, 'the chat shows the answer');
  assert.equal(entries.indexOf(said[0].text), entries.indexOf(ANSWER) + 1, 'and the line on what the stop ended right below it');
});

// A turn that showed its work keeps it when the owner stops it (lib/run-activity.mjs), whether
// or not it had answered. Stopped while its command runs, it is no run of the session: its
// log is kept with the stops, its steps are read from there with the command cut, and the
// line on what the stop ended comes after them. Stopped after its answer, it is a run like
// any other: the answer is the turn's, and its steps go with that answer.
test('a stopped turn keeps its steps: with no answer yet they stay where it stopped, and after its answer they go with the answer it keeps', async t => {
  const p = project(t), gate = path.join(p.parent, 'gate'), fake = fakeClis(p.parent, { mode: 'steps', intent: 'answer', gate });
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  // The stopped turn below has answered and stays: the stop is what ends it, however slow the machine.
  const grace = afterResult.graceSeconds; afterResult.graceSeconds = 60; t.after(() => { afterResult.graceSeconds = grace; });
  // The stand-in Claude Code starts a loop in a session of its own: while its command still
  // runs (no gate yet), and once the flag is there after its answer, where it then stays.
  const flag = path.join(p.parent, 'linger'), early = path.join(p.parent, 'early.pid'), late = path.join(p.parent, 'late.pid'), file = path.join(fake.dir, 'claude'), text = fs.readFileSync(file, 'utf8');
  const waitAt = ' if(cfg.gate){while(!fs.existsSync(cfg.gate))await new Promise(resolve=>setTimeout(resolve,20));}', stayAt = '// A stream-json run ends when its input does;';
  assert.equal(text.split(waitAt).length === 2 && text.split(stayAt).length === 2, true);
  const loop = pid => `{const {spawn}=await import('node:child_process');const loop=spawn('sh',['-c','for i in $(seq 1 110); do sleep 1; done'],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pid)},String(loop.pid));}`;
  fs.writeFileSync(file, text.replace(waitAt, ` if(!fs.existsSync(cfg.gate))${loop(early)}\n${waitAt}`).replace(stayAt, `if(fs.existsSync(${JSON.stringify(flag)})){${loop(late)}setInterval(()=>{},1000);await new Promise(()=>{});}\n${stayAt}`));
  const tools = steps => steps.filter(step => step.kind === 'tool').map(step => [step.text, step.status]);
  const gone = async pid => { const until = Date.now() + 3000; while (alive(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20)); return !alive(pid); };
  const ENDED = /^Stopping also ended a command the agent started: for i in \$\(seq 1 110\); do sleep 1; done\.$/;
  // The runs the chat reads steps from, as lib/terminal.mjs lists them.
  const stepRuns = task => [...task.runs, ...(task.stops ?? []).map(run => ({ ...run, stopped: true }))].map(run => ({ role: run.role, at: run.at, key: run.logFile, ...(run.stopped ? { stopped: true } : {}) })).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // Stopped while its command runs: no answer yet.
  const first = controller.ask('Why do lower case coupons fail?');
  await until(() => fs.existsSync(early) && readTask(controller.repo, first.id).state === 'running', 'the command it runs and the loop it started');
  const loop1 = Number(fs.readFileSync(early, 'utf8'));
  t.after(() => { try { process.kill(loop1, 'SIGKILL'); } catch {} });
  await controller.stop(first.id);
  await first.finished.catch(() => {});
  assert.equal(await gone(loop1), true, 'the stop ends the command the turn started');
  let task = readTask(controller.repo, first.id);
  assert.equal(task.state, 'stopped'); assert.equal(task.runs.length, 0, 'a turn stopped before its answer is no run');
  assert.equal(task.stops.length, 1); assert.deepEqual([task.stops[0].role, typeof task.stops[0].startedAt, typeof task.stops[0].at], ['lead', 'string', 'string']);
  assert.deepEqual(tools(endedSteps(runSteps(task.stops[0].logFile, { cwd: task.worktree }), Date.parse(task.stops[0].at))), [['Read: src/coupon.mjs', 'ok'], ['Run: npm test', 'stopped']], 'what it did, the command cut where it stopped');
  let said = task.messages.filter(row => row.from === 'ELU');
  assert.equal(said.length, 1); assert.match(said[0].text, ENDED);
  let entries = conversationEntries(controller.repo, task), placed = runsOfEntries(entries, stepRuns(task));
  assert.deepEqual(placed.before.get(entries.find(row => row.text === said[0].text))?.map(run => run.key), [task.stops[0].logFile], 'its steps stay where it stopped, above the line on what the stop ended');

  // Stopped after its answer: the answer is the turn's, and so are its steps.
  fs.writeFileSync(gate, ''); fs.writeFileSync(flag, '');
  const second = controller.ask('Carry on', first.id);
  await until(() => fs.existsSync(late) && readTask(controller.repo, first.id).state === 'running', 'the answer and the loop it left running');
  const loop2 = Number(fs.readFileSync(late, 'utf8'));
  t.after(() => { try { process.kill(loop2, 'SIGKILL'); } catch {} });
  await controller.stop(first.id);
  await second.finished.catch(() => {});
  assert.equal(await gone(loop2), true, 'the stop ends the command the turn left running');
  task = readTask(controller.repo, first.id);
  assert.equal(task.state, 'answered'); assert.equal(task.result.summary, 'Looked.', 'the answer it printed is kept');
  assert.equal(task.runs.length, 1, 'a turn stopped after its answer is a run'); assert.equal(task.stops.length, 1, 'and not also a stop');
  assert.deepEqual([task.runs[0].role, task.runs[0].code, typeof task.runs[0].startedAt], ['lead', 0, 'string']);
  assert.deepEqual(tools(endedSteps(runSteps(task.runs[0].logFile, { cwd: task.worktree }), Date.parse(task.runs[0].at))), [['Read: src/coupon.mjs', 'ok'], ['Run: npm test', 'failed']], 'what it did, to the end');
  said = task.messages.filter(row => row.from === 'ELU');
  assert.equal(said.length, 2); assert.match(said[1].text, ENDED);
  entries = conversationEntries(controller.repo, task); placed = runsOfEntries(entries, stepRuns(task));
  const reply = entries.find(row => row.lead && row.text === 'Looked.');
  assert.deepEqual(placed.owned.get(reply)?.map(run => run.key), [task.runs[0].logFile], 'its steps go with the answer it kept');
  assert.equal(entries.indexOf(entries.findLast(row => row.text === said[1].text)), entries.indexOf(reply) + 1, 'and the line on what the stop ended right below that answer');
  assert.deepEqual(placed.before.get(entries.find(row => row.text === said[0].text))?.map(run => run.key), [task.stops[0].logFile], 'the turn stopped before it stays in its place');
});
