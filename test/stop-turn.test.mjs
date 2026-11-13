import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, fakeClis, autoApprove } from './helpers.mjs';
import { ProjectController, conversationEntries } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';

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
