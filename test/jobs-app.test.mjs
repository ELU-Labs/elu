import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { project, fakeClis, cli, git, temp, keyThenEnter } from './helpers.mjs';
import { liveTask } from './peer-helpers.mjs';
import { repository } from '../lib/git.mjs';
import { launchTerminal } from '../lib/terminal.mjs';
import { Conductor } from '../lib/conductor.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { approveTask, proposeTask } from '../lib/plan.mjs';
import { atomic } from '../lib/util.mjs';
import { endJobs, jobsDir, listJobs, startJob } from '../lib/jobs.mjs';
import { KEEP_OFF, KEEP_ON, keepGoingFile, readKeepGoing } from '../lib/keep-going.mjs';
import { KEEP_GOING_LINE, KEEP_GOING_TEXT, STOPPED_LINE } from '../lib/elu-sent.mjs';

// Long jobs and keep going (README, "Long jobs"), as the app's screen shows them: the chat, the
// Sessions list, the Kanban, the Task, /keepgoing and Stop.
after(() => { setTimeout(() => { console.error('jobs-app.test: something is still running 10 s after the last test.'); process.exit(1); }, 10000).unref(); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanups = new WeakMap();
function resources(t) {
  if (!cleanups.has(t)) {
    const value = { views: [], files: [] }; cleanups.set(t, value);
    t.after(async () => {
      let failure = null;
      for (const close of [...value.views.reverse(), ...value.files.reverse()]) { try { await close(); } catch (error) { failure ??= error; } }
      if (failure) throw failure;
    });
  }
  return cleanups.get(t);
}
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const set = all => { for (const [key, value] of Object.entries(all)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  set(values); resources(t).files.push(() => set(previous));
}
async function until(check, message = 'condition', timeout = 20000) {
  const started = Date.now();
  while (!await check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${typeof message === 'function' ? message() : message}`); await sleep(20); }
}
// A project with one session that replied, and the app open on it (80x24 unless said) with its own conductor.
function setup(t, goal) {
  const p = project({ after: close => resources(t).files.push(close) }), fake = fakeClis(p.parent, { mode: 'answer' });
  environment(t, { ...fake.env, HOME: p.parent, XDG_CONFIG_HOME: path.join(p.parent, 'personal'), ELU_NO_COLOR: '1', ELU_NO_UPDATE_CHECK: '1', TERM: 'xterm-256color', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, ELU_TURN: undefined });
  assert.equal(cli(p.root, ['init', '--yes'], fake.env).status, 0);
  git(p.root, ['add', '.']); git(p.root, ['commit', '-m', 'Configure checks']);
  const repo = repository(p.root);
  liveTask(p.root, { id: '4', goal, state: 'answered' });
  // Every job a test started ends before its folder goes.
  resources(t).files.push(() => { try { endJobs(jobsDir(repo, '4'), { by: 'delete' }); } catch { /* None started. */ } });
  return { ...p, repo };
}
async function view(t, repo, { columns = 80, rows = 24 } = {}) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = columns; output.rows = rows;
  let rendered;
  const owned = resources(t), conductor = new Conductor({ tickMs: 20 }).start(); owned.views.push(() => conductor.stop());
  const home = temp(t); for (const name of ['claude', 'codex']) fs.mkdirSync(path.join(home, name));
  const usage = { home, env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex') }, vendors: () => [{ vendor: 'claude', available: true, signedIn: true }, { vendor: 'codex', available: true, signedIn: true }] };
  const finished = launchTerminal({ usage, repo, input, output, refreshMs: 30, startConductor: () => false, onRender: value => { rendered = value; } });
  finished.catch(() => {});
  await until(() => rendered, 'first render');
  keyThenEnter(input, () => rendered);
  owned.views.push(async () => {
    let closed = false, stopped = false, failure = null; finished.then(() => { closed = true; }, () => { closed = true; });
    if (!rendered.screen.destroyed) Promise.resolve().then(() => rendered.controller?.close()).then(() => { stopped = true; }, error => { failure = error; stopped = true; });
    for (const started = Date.now(); !closed && !rendered.screen.destroyed;) {
      const waited = Date.now() - started;
      if (waited > 10000) { input.destroy(); output.destroy(); throw new Error('The view did not close after its test.'); }
      if (stopped || waited > 3000) {
        rendered.panels.ask.cancel();
        for (const child of [...rendered.screen.children]) { child.dismiss?.(); child.children?.find(item => item.type === 'textbox')?.emit('cancel'); }
        if (waited > 3000) process.emit('SIGHUP');
        else { rendered.panels.tabs[0].focus(); rendered.screen.emit('keypress', 'q', { name: 'q' }); }
      }
      await sleep(stopped ? 20 : 2);
    }
    input.destroy(); output.destroy();
    if (failure) throw failure;
  });
  const v = { input, get current() { return rendered; } };
  // What the screen says, its line breaks and runs of spaces as one space, without the bar beside a message.
  const one = text => text.replace(/┃/g, ' ').replace(/\s+/g, ' ').trim();
  return Object.assign(v, {
    status: () => one(rendered.panels.status.getText()), chat: () => one(rendered.panels.chat.getText()),
    list: () => rendered.panels.board.items.map(item => item.getText().trimEnd()),
    // The Kanban: which column has the session's card (0 To do, 1 In progress, 2 Needs you, 3 Done), and what the card says.
    card: pattern => rendered.panels.kanbanLists.flatMap((list, column) => list.items.map(item => [column, one(item.getText())])).find(([, text]) => pattern.test(text)) ?? null,
  });
}
async function send(v, text) {
  v.current.panels.ask.focus(); v.current.panels.ask.readInput();
  await until(() => v.current.panels.ask.__listener, 'message box');
  v.current.panels.ask.setValue(text); v.current.panels.ask.submit();
}
async function openTask(v, pattern) {
  if (v.current.view !== 'tasks') await send(v, '/tasks');
  await until(() => v.current.view === 'tasks' && v.list().some(row => pattern.test(row)), `row ${pattern}`);
  const board = v.current.panels.board; board.focus(); board.select(v.list().findIndex(row => pattern.test(row)));
  await until(() => v.current.screen.focused === board, 'its row');
  v.input.write('\r'); await until(() => v.current.screen.focused === v.current.panels.ask && v.current.session, 'its chat');
}
const modal = (v, title) => v.current.screen.children.find(child => !child.destroyed && child.options?.label?.trim() === title);
// The session's Task as Ctrl+T opens it: its lines, then closed again.
async function taskRows(v) {
  v.input.write('\x14'); await until(() => modal(v, 'Task'), 'its Task');
  const rows = modal(v, 'Task').children.filter(child => child.type === 'list').flatMap(list => list.items.map(item => item.getText().trimEnd())).filter(row => row);
  v.input.write('\x1b'); await until(() => !modal(v, 'Task'), 'its Task closed');
  return rows;
}
const said = async (v, text) => until(() => v.status().endsWith(text), () => `${JSON.stringify(text)}, not ${JSON.stringify(v.status())}`);

for (const [columns, rows] of [[80, 24], [140, 50]]) test(`in the app at ${columns}x${rows}, a session whose long job runs: its chat says so, the list and the Kanban have it at work, its Task lists the job and asks for no check, and Stop ends the job`, { timeout: 120000 }, async t => {
  const f = setup(t, 'Run the gates'), v = await view(t, f.repo, { columns, rows });
  await openTask(v, /Run the gates/);
  // Before any job: it replied, and waits for his check.
  let lines = await taskRows(v);
  assert.ok(lines.includes('It waits for your check.'), lines.join('\n'));
  assert.equal(lines.some(row => /Job /.test(row)), false);
  await startJob({ repo: f.repo, task: readTask(f.repo, '4'), root: f.root, name: 'nightly-gates', command: ['sleep 300'], mode: 'full' });
  // Its chat: one line under the messages, with how long the job has run.
  await until(() => /1 job running · nightly-gates \d+s/.test(v.chat()), () => `the job in the chat, not ${JSON.stringify(v.chat().slice(-300))}`);
  // Its Task: the job, how long it has run and its log, and no check to give while it runs.
  lines = await taskRows(v);
  assert.ok(lines.includes('  · Job nightly-gates'), lines.join('\n'));
  assert.ok(lines.some(row => /^ {4}Running for \d+s\. Log:/.test(row)), lines.join('\n'));
  assert.equal(lines.includes('It waits for your check.'), false, 'no check while its job runs');
  // The Sessions list: under RUNNING.
  await send(v, '/sessions');
  await until(() => v.current.view === 'tasks' && /RUNNING 1[^]*Run the gates/.test(v.list().join('\n')), () => `the session under RUNNING, not ${JSON.stringify(v.list())}`);
  // The Kanban: In progress, not under Needs you, with how many jobs run where the card has room for it.
  await send(v, '/kanban');
  await until(() => v.current.view === 'kanban' && v.card(/Run the/), 'its card');
  await until(() => v.card(/Run the/)[0] === 1, () => `its card In progress, not ${JSON.stringify(v.card(/Run the/))}`);
  if (columns > 80) assert.match(v.card(/Run the/)[1], /^Run the gates 1 job running$/);
  // Stop, with no turn running: it ends the job and says which.
  await send(v, '/sessions'); await openTask(v, /Run the gates/);
  await send(v, '/stop'); await said(v, 'Stopping job nightly-gates.');
  await until(() => listJobs(jobsDir(f.repo, '4'))[0].state !== 'running', 'the job to end');
  await until(() => /Stopping also ended a job the agent started: nightly-gates\./.test(v.chat()) && !/job running/.test(v.chat()), () => `the chat to say the stop ended it, not ${JSON.stringify(v.chat().slice(-300))}`);
  // It waits for his check again, in its Task and on the Kanban.
  lines = await taskRows(v);
  assert.ok(lines.includes('It waits for your check.'), lines.join('\n'));
  assert.ok(lines.includes('  · Job nightly-gates'), lines.join('\n'));
  await send(v, '/kanban');
  await until(() => v.current.view === 'kanban' && v.card(/Run the/)?.[0] === 2, () => `its card under Needs you, not ${JSON.stringify(v.card(/Run the/))}`);
  if (columns > 80) assert.match(v.card(/Run the/)[1], /^Run the gates (?:replied · )?check it$/);
});

// Its row in Sessions is under RUNNING and offers s stop: that ends its jobs too, as /stop in its chat does.
for (const [columns, rows] of [[80, 24], [140, 50]]) test(`in the app at ${columns}x${rows}, s on the row of a session whose long job runs ends the job, as /stop in it does`, { timeout: 120000 }, async t => {
  const f = setup(t, 'Run the gates'), v = await view(t, f.repo, { columns, rows });
  await startJob({ repo: f.repo, task: readTask(f.repo, '4'), root: f.root, name: 'nightly-gates', command: ['sleep 300'], mode: 'full' });
  if (v.current.view !== 'tasks') await send(v, '/tasks');
  await until(() => v.current.view === 'tasks' && /RUNNING 1[^]*Run the gates/.test(v.list().join('\n')), () => `the session under RUNNING, not ${JSON.stringify(v.list())}`);
  const board = v.current.panels.board; board.focus(); board.select(v.list().findIndex(row => /Run the gates/.test(row)));
  await until(() => v.current.screen.focused === board, 'its row');
  v.input.write('s'); await said(v, 'Stopping job nightly-gates.');
  await until(() => listJobs(jobsDir(f.repo, '4'))[0].state !== 'running', 'the job to end');
  await until(() => !/RUNNING/.test(v.list().join('\n')), () => `the row to leave RUNNING, not ${JSON.stringify(v.list())}`);
  assert.equal(listJobs(jobsDir(f.repo, '4'))[0].stopped.by, 'stop');
});

test('/keepgoing in a session says whether ELU starts it again, and on and off change it; in the list it says to open a session', { timeout: 60000 }, async t => {
  const f = setup(t, 'Pass the gates'), v = await view(t, f.repo);
  // In the list no session is open.
  await send(v, '/keepgoing'); await said(v, 'Open a session to see or change whether it keeps going.');
  await openTask(v, /Pass the gates/);
  // A session in Ask for approval: off until he turns it on.
  await send(v, '/keepgoing'); await said(v, KEEP_OFF);
  await send(v, '/keepgoing on'); await said(v, KEEP_ON); assert.equal(readKeepGoing(f.repo, '4').on, true);
  await send(v, '/keepgoing'); await said(v, KEEP_ON);
  await send(v, '/keepgoing sometimes'); await said(v, 'Use /keepgoing [on|off].'); assert.equal(readKeepGoing(f.repo, '4').on, true);
  await send(v, '/keepgoing off'); await said(v, KEEP_OFF); assert.equal(readKeepGoing(f.repo, '4').on, false);
  await send(v, '/keepgoing'); await said(v, KEEP_OFF);
});

test('in the app, what ELU sent a session reads as one line of ELU\'s, never as a message of the owner\'s; one ELU stopped starting waits for him in the list and says why', { timeout: 60000 }, async t => {
  const f = setup(t, 'Pass the gates');
  proposeTask(f.repo, '4', { title: 'Pass the gates', description: 'Two gates.', goal: 'Every gate passes.', objectives: ['Gate one passes', 'Gate two passes'], priority: 'medium', severity: 'low' }); approveTask(f.repo, '4');
  // ELU started it twice, and neither turn made progress: it stopped there.
  const at = ago => new Date(Date.now() - ago).toISOString(), task = readTask(f.repo, '4');
  task.messages.push({ at: at(50000), text: KEEP_GOING_TEXT }, { at: at(30000), text: KEEP_GOING_TEXT }); saveTask(f.repo, task);
  atomic(keepGoingFile(f.repo, '4'), { sent: true, flat: 2, stopped: { at: at(10000), flat: 2 } });
  const v = await view(t, f.repo);
  // The list: it waits for him, under what needs him, never as at work.
  await until(() => v.current.view === 'tasks' && v.list().some(row => /Pass the gates/.test(row)), 'its row');
  assert.equal(v.list().some(row => /RUNNING/.test(row)), false, v.list().join('\n'));
  assert.ok(v.list().some(row => /^\s*\? Pass the gates/.test(row)), v.list().join('\n'));
  await openTask(v, /Pass the gates/);
  await until(() => v.chat().includes(STOPPED_LINE), () => `why it stopped, not ${JSON.stringify(v.chat().slice(-400))}`);
  const chat = v.chat();
  assert.equal(chat.split(KEEP_GOING_LINE).length - 1, 2, 'one line of ELU\'s for each message it sent');
  assert.equal(chat.includes(KEEP_GOING_TEXT), false, 'the message itself is not shown as one of his');
  // Its Task says why too, in its checklist.
  const rows = (await taskRows(v)).join(' ').replace(/\s+/g, ' ');
  assert.ok(rows.includes('ELU stopped starting this session'), rows);
});
