import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { project, fakeClis, autoApprove, git } from './helpers.mjs';
import { ProjectController, conversationEntries, registerProject } from '../lib/projects.mjs';
import { repository } from '../lib/git.mjs';
import { Conductor, enqueue, openingConductor } from '../lib/conductor.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask, taskDir } from '../lib/state.mjs';
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

// Claude Code's sandbox on Linux (sandbox-runtime 0.0.82 in 2.1.322) keeps a command from
// making a denied path that is missing, in a folder the command may write, by laying an empty
// file there while the command runs: ELU's protected paths in an edit turn, and Claude Code's
// own (.bashrc, .gitconfig and the rest). It takes them away once the command has ended, and
// leaves them when it is killed, or asked to end, while the command runs ("Leaving mount points
// in place while this process ends"). The stand-in does the same in a turn that may write its
// folder, where it runs its command in a session of its own, as bubblewrap's runs. Every other
// call, the turn that reads the message first among them, goes to the usual stand-in, which
// takes the message as work: the Task it proposes is approved (autoApprove), and the turn that
// works on it is the one stopped here.
const SANDBOXED = (real, record) => `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), { spawn, spawnSync } = require('node:child_process');
const onDisk = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }, spelled = p => path.join(onDisk(path.dirname(p)), path.basename(p));
const args = process.argv.slice(2), at = args.indexOf('--settings'), settings = at < 0 ? null : JSON.parse(args[at + 1]);
const deny = settings?.sandbox?.enabled ? settings.sandbox.filesystem?.denyWrite ?? [] : [], cwd = onDisk(process.cwd());
if (!deny.length || deny.some(p => onDisk(p) === cwd)) { const r = spawnSync(${JSON.stringify(real)}, args, { stdio: 'inherit' }); process.exit(r.status ?? 1); }
const own = ['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json', '.vscode', '.idea'];
const made = [...new Set([...deny.map(spelled), ...own.map(name => path.join(cwd, name))])].filter(p => path.dirname(p) === cwd && !fs.existsSync(p));
for (const p of made) fs.writeFileSync(p, '');
const tidy = () => { for (const p of made) { try { const held = fs.lstatSync(p); if (held.isFile() && held.size === 0) fs.unlinkSync(p); } catch {} } };
let running = true;
process.on('SIGTERM', () => { if (!running) tidy(); process.exit(143); });
process.on('exit', () => { if (!running) tidy(); });
const command = spawn('sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
command.on('exit', () => { running = false; tidy(); });
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ claude: process.pid, command: command.pid, made }));
setInterval(() => {}, 1000);
`;
test('a stop while Claude Code runs a command leaves none of the empty files its sandbox laid over missing denied paths', async t => {
  const p = project(t), fake = fakeClis(p.parent), real = path.join(fake.dir, 'claude-real'), record = path.join(p.parent, 'sandbox.json');
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  fs.renameSync(path.join(fake.dir, 'claude'), real); fs.writeFileSync(path.join(fake.dir, 'claude'), SANDBOXED(real, record), { mode: 0o755 });
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  for (const permissions of ['ask', 'auto']) {
    fs.rmSync(record, { force: true });
    const run = controller.ask('Run the tests.', null, { permissions });
    await until(() => fs.existsSync(record), `the ${permissions} turn's command`);
    const seen = JSON.parse(fs.readFileSync(record, 'utf8'));
    t.after(() => { for (const pid of [seen.claude, seen.command]) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
    assert.ok(seen.made.length > 20 && seen.made.every(file => fs.statSync(file).size === 0), `${permissions}: an edit turn, an empty file at each missing denied path while the command runs (${seen.made.length})`);
    const since = Date.now(); await controller.stop(run.id); await run.finished.catch(() => {});
    assert.ok(Date.now() - since < 3000, `${permissions}: the stop took ${Date.now() - since} ms`);
    assert.deepEqual([alive(seen.command), alive(seen.claude)], [false, false], `${permissions}: the command and Claude Code ended with the turn`);
    // Before: Claude Code was killed with its command, and every one of them stayed in the work
    // tree, where Git listed them and the protected-path check of the next turn failed on them.
    assert.deepEqual(seen.made.filter(file => fs.existsSync(file)), [], `${permissions}: the stop leaves none of them`);
    assert.equal(readTask(controller.repo, run.id).state, 'stopped');
  }
});

// ELU itself ends while Claude Code runs a command in an edit turn (a crash, kill -9, the
// computer losing power), and the owner opens ELU again and does nothing more. Opening it starts
// the conductor for the turn left running (openingConductor), and that start recovers it. Where
// Claude Code still runs, it is stopped as a stop does, and it takes its empty files away. Where
// it ended with ELU, killed with its command, the start takes them away: only the paths the
// turn's file names, and only where each is an empty file Git does not track. The owner's own
// empty files stay: tracked ones at a protected path and at a name of Claude Code's own, and one
// he made while the turn ran. Before: opening ELU started nothing, so the turn showed as running
// with every one of them in the work tree, and Claude Code and its command ran on, until a
// message, a stop or an approval of the owner's started a conductor; that start then killed
// Claude Code, or found it gone, and every one of them stayed.
const conductorLib = new URL('../lib/conductor.mjs', import.meta.url).href, helpersLib = new URL('./helpers.mjs', import.meta.url).href;
test('an ELU that ends while Claude Code runs a command takes away the empty files its sandbox laid when it is opened again, and nothing of the owner\'s', async t => {
  const p = project(t), fake = fakeClis(p.parent), real = path.join(fake.dir, 'claude-real'), record = path.join(p.parent, 'sandbox.json'), owned = ['.gitignore', '.profile'];
  for (const name of owned) fs.writeFileSync(path.join(p.root, name), '');
  git(p.root, ['add', ...owned]); git(p.root, ['commit', '-m', 'Add empty settings']);
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  fs.renameSync(path.join(fake.dir, 'claude'), real); fs.writeFileSync(path.join(fake.dir, 'claude'), SANDBOXED(real, record), { mode: 0o755 });
  const repo = repository(p.root); registerProject(repo);
  for (const ending of ['ELU alone', 'ELU, Claude Code and its command']) {
    fs.rmSync(record, { force: true });
    const elu = spawn(process.execPath, ['--input-type=module', '-e', `import { Conductor } from ${JSON.stringify(conductorLib)}; import { approvingConductor } from ${JSON.stringify(helpersLib)}; approvingConductor(new Conductor({ tickMs: 20 })).start();`], { stdio: 'ignore' });
    const exited = new Promise(resolve => elu.once('exit', resolve));
    t.after(() => { try { elu.kill('SIGKILL'); } catch {} });
    const sent = enqueue(p.root, 'Run the tests.', { permissions: 'ask' });
    await until(() => fs.existsSync(record), `the turn's command (${ending})`);
    const seen = JSON.parse(fs.readFileSync(record, 'utf8')), worktree = path.dirname(seen.made[0]), notes = path.join(worktree, 'notes.txt');
    t.after(() => { for (const pid of [seen.claude, seen.command]) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
    // ELU names Claude Code in the turn's file as it starts it, a moment before the command runs.
    const taskId = () => pendingRequests(p.root).find(row => row.id === sent.id)?.taskId, named = () => { try { return JSON.parse(fs.readFileSync(path.join(taskDir(repo, taskId()), 'process.json'), 'utf8')).pid; } catch { return null; } };
    await until(() => named() === seen.claude, `the turn's file to name Claude Code (${ending})`);
    assert.ok(seen.made.length > 20, `${ending}: an empty file at each missing denied path while the command runs (${seen.made.length})`);
    assert.deepEqual(owned.filter(name => seen.made.includes(path.join(worktree, name))), [], `${ending}: none over the owner's own`);
    fs.writeFileSync(notes, '');
    elu.kill('SIGKILL'); await exited;
    if (ending !== 'ELU alone') {
      // Claude Code first: killed after its command, it would take its files away first.
      for (const pid of [seen.claude, seen.command]) process.kill(pid, 'SIGKILL');
      await until(() => !alive(seen.command) && !alive(seen.claude), 'Claude Code and its command to end');
    }
    assert.deepEqual(seen.made.filter(file => !fs.existsSync(file)), [], `${ending}: ELU ended and every one is still there`);
    let again = null;
    openingConductor({ start: () => { again = new Conductor({ tickMs: 20 }).start(); } });
    assert.ok(again, `${ending}: opening ELU starts the conductor for the turn left running`);
    try {
      assert.deepEqual([alive(seen.command), alive(seen.claude)], [false, false], `${ending}: the command and Claude Code have ended`);
      assert.deepEqual(seen.made.filter(file => fs.existsSync(file)), [], `${ending}: the start leaves none of them`);
      assert.deepEqual(owned.map(name => fs.lstatSync(path.join(worktree, name)).size), [0, 0], `${ending}: the owner's tracked empty files stay`);
      assert.equal(fs.existsSync(notes), true, `${ending}: so does the empty file he made`);
      const left = spawnSync('git', ['-C', worktree, 'status', '--porcelain', '-z', '--untracked-files=all'], { encoding: 'utf8' }).stdout.split('\0').map(row => row.slice(3)).filter(name => seen.made.includes(path.join(worktree, name)));
      assert.deepEqual(left, [], `${ending}: Git lists none of them`);
      assert.equal(readTask(repo, taskId()).state, 'stopped');
    } finally { await again.stop(); fs.rmSync(notes, { force: true }); }
  }
});
