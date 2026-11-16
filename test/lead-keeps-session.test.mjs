import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { project, fakeClis, autoApprove, cli, git, CLI, keyThenEnter } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { ProjectController, registerProject } from '../lib/projects.mjs';
import { launchTerminal } from '../lib/terminal.mjs';
import { projectFolder, pendingRequests } from '../lib/workspace.mjs';
import { readTask, saveTask, setTitle, taskTitle } from '../lib/state.mjs';
import { Conductor } from '../lib/conductor.mjs';
import { approveTask, proposeTask } from '../lib/plan.mjs';
import { keepOpen } from '../lib/owner-check.mjs';
import { sessionTalker, sessionWorker } from '../lib/bots.mjs';
import { standupAgent } from '../lib/standup.mjs';

// A session the owner wrote to a working bot (@lead, @qa) stays that bot's (lib/bots.mjs
// sessionTalker, sessionWorker): his approval of its Task, a new goal, a message the elu
// command sends for him and one an earlier build kept with no to name nobody, so every later
// turn goes to that bot, which plans and hands the work to its helpers. Only what he names
// changes it: @model gives the session's model, and it stays the model; another @name that bot.
// A bot that does not work (@reviewer) is as before: it answers what is written to it, and a
// message after his approval goes to the model.

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const after = (args, flag) => args[args.indexOf(flag) + 1];
async function until(check, message, timeout = 30000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const at = () => new Date().toISOString();
// The stand-in Claude Code, with the --agents flag the real one has: @lead's helpers need it.
function withAgents(dir) {
  const file = path.join(dir, 'claude'), text = fs.readFileSync(file, 'utf8'), from = "console.log('--print ";
  if (!text.includes("console.log('--agents --print ")) { assert.ok(text.includes(from), 'the stand-in lists its flags'); fs.writeFileSync(file, text.replace(from, "console.log('--agents --print ")); }
}
// The rows his sessions have after their first message to @lead (row 1): his approval of the
// Task (row 2), two the elu command sent for him (row 3) and his typed continue (row 4), each
// with no to, as this build and the ones before it keep them.
const LATER_ROWS = () => [
  { at: at(), text: 'Approved the Task: Uppercase coupons' },
  { at: at(), text: 'New goal from the owner, replacing the old one: trim the codes too.' },
  { at: at(), text: 'The keys are in the settings now.' },
  { at: at(), text: 'continue' },
];
const TASK = { title: 'Uppercase coupons', description: 'Make normalize return the code in upper case.', goal: 'Coupon codes compare equal whatever their case.', objectives: ['normalize returns upper case', 'The coupon test passes'], priority: 'medium', severity: 'low' };

test('who a session talks to and works with, read from its records', () => {
  const bots = { lead: { name: 'lead', works: true }, qa: { name: 'qa', works: true }, reviewer: { name: 'reviewer' } }, find = name => bots[name] ?? null;
  const session = (messages, extra = {}) => ({ id: '7', bots: ['lead', 'qa', 'reviewer'], botsPicked: true, messages, ...extra });
  const to = name => ({ at: at(), text: 'Plan it.', to: `@${name}` });
  const plain = text => ({ at: at(), text });
  const both = task => [sessionTalker(task, { find }), sessionWorker(task, { find })];
  // The exact shape: @lead, then rows that name nobody.
  assert.deepEqual(both(session([to('lead'), ...LATER_ROWS()])), ['lead', 'lead']);
  // His reply and a bot's line in between change nothing; a message that waits counts as written.
  const lead = session([to('lead'), { at: at(), text: 'Planned.', from: '@lead', bot: 'lead' }, plain('Approved the Task: X')]);
  assert.deepEqual(both(lead), ['lead', 'lead']);
  const waits = row => ({ id: 'r', continuationTaskId: '7', state: 'queued', queuedAt: at(), ...row });
  assert.equal(sessionTalker(lead, { find, waiting: [waits({})] }), 'lead');
  assert.equal(sessionTalker(lead, { find, waiting: [waits({ toModel: true })] }), null, 'a waiting message to @model');
  assert.equal(sessionTalker(lead, { find, waiting: [waits({ bot: 'qa' })] }), 'qa');
  // @model, then a plain message and an approval: the model, both ways.
  assert.deepEqual(both(session([to('lead'), { at: at(), text: 'hi', toModel: true }, plain('continue'), plain('Approved the Task: X')])), [null, null]);
  // Another working bot named last is the one.
  assert.deepEqual(both(session([to('lead'), to('qa'), plain('continue')])), ['qa', 'qa']);
  // A bot that does not work answers what is written to it, as before; after his approval the
  // session goes to the working bot before it, and with none to the model.
  assert.deepEqual(both(session([to('reviewer')])), ['reviewer', null]);
  assert.deepEqual(both(session([to('reviewer'), plain('Approved the Task: X')])), [null, null]);
  assert.deepEqual(both(session([to('lead'), to('reviewer')])), ['reviewer', 'lead']);
  assert.deepEqual(both(session([to('lead'), to('reviewer'), plain('continue')])), ['lead', 'lead']);
  // No bot: the model. A bot taken out of the session or deleted: the model.
  assert.deepEqual(both(session([plain('hi'), plain('Approved the Task: X')])), [null, null]);
  assert.deepEqual(both(session([to('lead'), plain('continue')], { bots: ['qa'] })), [null, null]);
  assert.deepEqual(both(session([to('gone'), plain('continue')], { bots: ['gone'] })), [null, null]);
  // A teammate's question is never a bot's.
  assert.deepEqual(both(session([to('lead'), plain('continue')], { origin: { kind: 'ask', peer: 'b'.repeat(64) } })), [null, null]);
  // The standup answer comes from the bot the session works with, whoever ran last.
  const found = name => name === 'lead' ? { name: 'lead', works: true } : null;
  assert.equal(standupAgent({ ...session([to('lead'), ...LATER_ROWS()]), runs: [{ role: 'bot:lead' }, { role: 'lead' }, { role: 'lead' }] }, found).bot?.name, 'lead');
  assert.deepEqual(standupAgent({ ...session([to('lead'), { at: at(), text: 'hi', toModel: true }]), runs: [{ role: 'bot:lead' }, { role: 'lead' }] }, found), { lead: true });
});

// A project with the app's conductor running, and session 1 written to @lead, which answered.
async function leadSession(t, { mode = 'answer', fake = {}, bot = 'lead', conduct = true } = {}) {
  const p = project(t), clis = fakeClis(p.parent, { mode, ...fake }); withAgents(clis.dir);
  environment(t, { ...clis.env, HOME: p.parent, ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); registerProject(controller.repo);
  const repo = controller.repo, root = repo.root;
  // Not Read only: a working bot hands work to its helpers in any other mode.
  const first = await controller.ask('Look at the coupon code and plan the work.', null, { bot, permissions: 'ask' }).finished;
  assert.equal(first.id, '1'); assert.equal(first.messages[0].to, `@${bot}`);
  if (conduct) { const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop()); }
  const ofClaude = row => row.vendor === 'claude' && row.args.includes('-p');
  const runs = () => rows(clis.calls).filter(ofClaude);
  return { ...p, fake: clis, controller, repo, root, runs, session: () => readTask(repo, '1') };
}
// Waits for session 1's next turn after count runs, and returns its role.
async function nextTurn(f, count) {
  await until(() => f.session().runs.length > count && !['running', 'preparing'].includes(f.session().state) && pendingRequests(f.root).every(row => row.state === 'done'), 'its next turn');
  return f.session().runs.slice(count).map(run => run.role);
}
const elu = (f, args) => new Promise(resolve => {
  const env = { ...process.env }; delete env.ELU_SESSION; delete env.ELU_PROJECT;
  const child = spawn(process.execPath, [CLI, ...args], { cwd: f.root, env }); let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('close', status => resolve({ status, stdout, stderr }));
});

test('elu sessions goal on a session written to @lead goes to @lead: a message with no Task, then a new goal for its Task', { timeout: 90000 }, async t => {
  const f = await leadSession(t);
  saveTask(f.repo, { ...f.session(), messages: [...f.session().messages, ...LATER_ROWS()] });
  let count = f.session().runs.length;
  let r = await elu(f, ['sessions', 'goal', '1', 'The keys are in the settings now.']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(await nextTurn(f, count), ['bot:lead'], 'the message the command sent went to @lead');
  const sent = f.runs().at(-1).args; assert.equal(after(sent, '--model'), 'fable', "on @lead's own model");
  assert.equal(Object.values(JSON.parse(after(sent, '--agents')))[0].model, 'opus', 'with its Opus helpers');
  // A new goal for its approved Task goes to @lead too.
  proposeTask(f.repo, '1', TASK); approveTask(f.repo, '1');
  count = f.session().runs.length;
  r = await elu(f, ['sessions', 'goal', '1', 'Coupon codes compare equal whatever their case or spaces\nnormalize trims spaces']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(await nextTurn(f, count), ['bot:lead'], 'the new goal went to @lead');
  // @lead keeps the goal as a message to it, so an older build reads the session as @lead's too.
  assert.equal(f.session().messages.filter(row => !row.bot && !row.from).at(-1).to, '@lead');
});

test('a new goal goes to the model in a session with no working bot, and one whose last word was @model', async t => {
  const f = await leadSession(t, { bot: 'reviewer', conduct: false });
  proposeTask(f.repo, '1', TASK); approveTask(f.repo, '1');
  const goal = text => { keepOpen(f.repo, f.root, readTask(f.repo, '1'), text); return pendingRequests(f.root).filter(row => row.continuationTaskId === '1').at(-1); };
  // No conductor runs: the requests stay to be read.
  const reviewer = goal('Trim the codes too.');
  assert.equal(reviewer.bot, undefined, 'a bot that does not work keeps today: the goal goes to the model');
  assert.ok(reviewer.goalChange);
  // @lead, then @model: the model.
  const task = readTask(f.repo, '1');
  saveTask(f.repo, { ...task, bots: ['reviewer', 'lead'], messages: [...task.messages, { at: at(), text: 'Plan it.', to: '@lead' }, { at: at(), text: 'hi', toModel: true }] });
  assert.equal(goal('Trim them and upper-case them.').bot, undefined);
});

test('his y on a Task the model wrote in a session written to @lead: @lead does the work, with its helpers', { timeout: 90000 }, async t => {
  const f = await leadSession(t, { conduct: false });
  withAgents(fakeClis(f.parent, { mode: 'normal' }).dir);
  // An earlier build sent his plain message to the model, which proposes a Task naming no bot.
  // His y follows, as the app sends it (autoApprove: the Task approved, then a request approved
  // and written to nobody).
  saveTask(f.repo, { ...f.session(), messages: [...f.session().messages, { at: at(), text: 'continue' }] });
  const count = f.session().runs.length;
  const done = await f.controller.ask('Uppercase coupon codes', '1').finished;
  const roles = done.runs.slice(count).map(run => run.role);
  assert.equal(roles[0], 'lead', 'the model proposed the Task');
  assert.ok(done.messages.some(row => /^Approved the Task: /.test(row.text) && !row.to), 'his approval names nobody');
  assert.ok(roles.length > 1 && roles.slice(1).every(role => role !== 'lead'), `@lead did the work, not the model: ${roles}`);
  assert.equal(roles[1], 'bot:lead');
  const edit = f.runs().find(row => after(row.args, '--tools')?.includes('Write') && after(row.args, '--model') === 'fable');
  assert.ok(edit, "the edit ran on @lead's own model"); assert.equal(Object.values(JSON.parse(after(edit.args, '--agents')))[0].model, 'opus');
});

// The record the vendor fake says has no usage credits for the model.
const NO_CREDITS = { models: { fable: 'claude-fable-5-2', opus: 'claude-opus-5-5' } };
// Each turn after that tries @lead's own model first: while the account still has no credits
// for it the turn runs on the session's model again, and the chat does not say so twice; once
// it has credits again the turn runs on @lead's own model.
test('@lead that ran on the session\'s model once (no credits) still has the session: the next turn is @lead\'s, and tries its own model again', { timeout: 90000 }, async t => {
  const f = await leadSession(t, { fake: { ...NO_CREDITS, noCredits: 'fable' } });
  assert.deepEqual(f.session().modelFallback, { lead: 'fable' }, 'it ran on the session\'s model in its place');
  const said = () => f.session().messages.filter(row => row.bot === 'lead' && / ran on .* instead\.$/.test(row.text ?? '')).length;
  assert.equal(said(), 1, 'the chat says it once');
  saveTask(f.repo, { ...f.session(), messages: [...f.session().messages, ...LATER_ROWS()] });
  let count = f.session().runs.length, calls = f.runs().length;
  const r = await elu(f, ['sessions', 'goal', '1', 'The keys are in the settings now.']);
  assert.equal(r.status, 0, r.stderr);
  const roles = await nextTurn(f, count);
  assert.ok(roles.length && roles.every(role => role === 'bot:lead'), `the next turn is @lead again, not the model: ${roles}`);
  assert.deepEqual(f.runs().slice(calls).map(row => after(row.args, '--model')), ['fable', 'opus'], 'it tried its own model first, then ran on the session\'s');
  assert.equal(said(), 1, 'and the chat does not say it again');
  // His account has credits for @lead's model again: the following turn runs on it.
  withAgents(fakeClis(f.parent, { mode: 'answer', ...NO_CREDITS }).dir);
  count = f.session().runs.length; calls = f.runs().length;
  const again = await elu(f, ['sessions', 'goal', '1', 'And trim the spaces.']);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(await nextTurn(f, count), ['bot:lead']);
  assert.deepEqual(f.runs().slice(calls).map(row => after(row.args, '--model')), ['fable'], "the following turn runs on @lead's own model");
  assert.equal(f.session().modelFallback, undefined, 'and the session no longer keeps the fallback');
});

// The app, as the owner uses it: his sessions' records, and what he types.
function appEnvironment(t, mode) {
  const p = project(t), fake = fakeClis(p.parent, { mode }); withAgents(fake.dir);
  environment(t, { ...fake.env, XDG_CONFIG_HOME: path.join(p.parent, 'personal'), ELU_NO_COLOR: '1', TERM: 'xterm-256color' });
  assert.equal(cli(p.root, ['init', '--yes'], fake.env).status, 0);
  git(p.root, ['add', '.']); git(p.root, ['commit', '-m', 'Configure checks']);
  return { ...p, ...fake, repo: repository(p.root) };
}
async function app(t, repo) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = 120; output.rows = 40;
  let rendered; const conductor = new Conductor({ tickMs: 20 }).start();
  const home = path.join(process.env.XDG_CONFIG_HOME, 'usage'); for (const name of ['claude', 'codex']) fs.mkdirSync(path.join(home, name), { recursive: true });
  const usage = { home, env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex') }, vendors: () => [{ vendor: 'claude', available: true, signedIn: true }, { vendor: 'codex', available: true, signedIn: true }] };
  const finished = launchTerminal({ repo, input, output, refreshMs: 30, startConductor: () => false, usage, onRender: value => { rendered = value; } });
  finished.catch(() => {});
  await until(() => rendered, 'first render');
  t.after(async () => {
    let closed = false; finished.then(() => { closed = true; }, () => { closed = true; });
    try { await rendered.controller?.close(); } catch { /* Closed below. */ }
    for (const started = Date.now(); !closed && !rendered.screen.destroyed;) {
      const waited = Date.now() - started; if (waited > 10000) break;
      rendered.panels.ask.cancel(); for (const child of [...rendered.screen.children]) { child.dismiss?.(); child.children?.find(item => item.type === 'textbox')?.emit('cancel'); }
      if (waited > 3000) process.emit('SIGHUP'); else { rendered.panels.tabs[0].focus(); rendered.screen.emit('keypress', 'q', { name: 'q' }); }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    await conductor.stop(); input.destroy(); output.destroy();
  });
  return { input, output, get current() { return rendered; } };
}
const label = v => v.current.panels.ask._label.getText();
async function send(v, text) {
  v.current.panels.ask.focus(); v.current.panels.ask.readInput();
  await until(() => v.current.panels.ask.__listener, 'message box');
  v.current.panels.ask.setValue(text); v.current.panels.ask.submit();
}
async function open(v, title, id) {
  if (v.current.view !== 'tasks') await send(v, '/tasks');
  const items = () => v.current.panels.board.items.map(item => item.getText());
  await until(() => v.current.view === 'tasks' && items().some(row => row.includes(title)), `the row of ${title}`);
  const board = v.current.panels.board; board.focus(); board.select(items().findIndex(row => row.includes(title)));
  await until(() => v.current.session === id, 'its chat');
  v.input.write('\r'); await until(() => v.current.screen.focused === v.current.panels.ask, 'the message box');
}

test('his session written to @lead, then his approval, two command-line messages and continue: what he types next is @lead\'s, and @model then plain is the model\'s', { timeout: 120000 }, async t => {
  const p = appEnvironment(t, 'answer');
  // Session 1 as his are: @lead planned on its own model, then rows that name nobody.
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  const first = await controller.ask('Plan coupons', null, { bot: 'lead', permissions: 'ask' }).finished;
  await controller.close();
  const title = taskTitle(first);
  saveTask(p.repo, { ...readTask(p.repo, first.id), messages: [...readTask(p.repo, first.id).messages, ...LATER_ROWS()] });
  const session = () => readTask(p.repo, first.id), roles = () => session().runs.map(run => run.role);
  const calls = () => rows(p.calls).filter(row => row.vendor === 'claude' && row.args.includes('-p'));
  const turn = async (count, what) => { await until(() => roles().length > count && session().state === 'answered' && pendingRequests(p.root).every(row => row.state === 'done'), what); return roles().slice(count); };
  const v = await app(t, p.repo);
  await open(v, title, first.id);
  await until(() => /^ Message @lead · @model writes to Opus $/.test(label(v)), `the box names @lead, not the model: "${label(v)}"`);
  // His next message, with no @name.
  let count = roles().length;
  await send(v, 'go on');
  assert.deepEqual(await turn(count, '@lead answers'), ['bot:lead'], 'an @lead turn, not the model');
  const sent = calls().at(-1).args;
  assert.equal(after(sent, '--model'), 'fable', "on @lead's own model");
  assert.equal(Object.values(JSON.parse(after(sent, '--agents')))[0].model, 'opus', 'with its Opus helpers');
  assert.equal(session().messages.filter(row => !row.bot && !row.from).at(-1).to, '@lead');
  await until(() => /^ Message @lead · @model writes to Opus $/.test(label(v)), 'still @lead');
  // @model writes to the session's model, and it stays the model's.
  count = roles().length;
  await send(v, '@model hi');
  assert.deepEqual(await turn(count, 'the model answers'), ['lead']);
  assert.equal(session().messages.filter(row => !row.bot && !row.from).at(-1).toModel, true);
  await until(() => /^ Message Opus · .* · with @lead $/.test(label(v)), `the box names the model: "${label(v)}"`);
  count = roles().length;
  await send(v, 'continue');
  assert.deepEqual(await turn(count, 'the model answers again'), ['lead'], 'continue after @model is the model');
});

// A dialog of the app by its label, and its text field answered.
const modalNamed = (v, pattern) => v.current.screen.children.find(child => !child.destroyed && pattern.test(child.options?.label ?? ''));
async function fill(v, pattern, value) {
  await until(() => modalNamed(v, pattern), `the dialog ${pattern}`);
  const field = modalNamed(v, pattern).children.find(child => child.type === 'textbox');
  await until(() => field.__listener, 'its text field');
  field.setValue(value); field.submit();
}
// A session's row under Sessions, selected there (not opened).
async function selectRow(v, title, id) {
  if (v.current.view !== 'tasks') await send(v, '/tasks');
  const items = () => v.current.panels.board.items.map(item => item.getText());
  await until(() => v.current.view === 'tasks' && items().some(row => row.includes(title)), `the row of ${title}`);
  const board = v.current.panels.board; board.focus(); board.select(items().findIndex(row => row.includes(title)));
  await until(() => v.current.session === id && v.current.screen.focused === board, 'the row is selected');
}
// @lead's own work turn after his y stopped on what Ask for approval refuses, the internet: its
// run as the runner keeps it, by @lead (bot:lead), with the action it was refused.
function stoppedOnTheInternet(repo, id) {
  const task = readTask(repo, id), log = path.join(path.dirname(task.runs.at(-1).logFile), 'bot-lead-work.jsonl');
  fs.writeFileSync(log, `${JSON.stringify({ type: 'result', structured_output: { summary: 'I stopped here.' } })}\n`);
  const run = { role: 'bot:lead', vendor: 'claude', session: 'work-1', launch: 'work-1', at: new Date().toISOString(), logFile: log, permissions: 'ask', denials: [{ tool: 'Bash', tool_use_id: 'toolu_1', input: { command: 'curl -sS https://elu.dev/' }, network: 'elu.dev' }] };
  saveTask(repo, { ...task, state: 'needs_input', permissions: 'ask', runs: [...task.runs, run] });
}

// Before, the work turn after his y was the model's, and the chat said what stopped it and
// /permissions full continued it at once. The work turn is @lead's now: so does @lead's.
test("his session written to @lead: @lead's work turn after his y stops on the internet, the chat says what blocked it, and /permissions full continues it with @lead", { timeout: 120000 }, async t => {
  const p = appEnvironment(t, 'answer');
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  const first = await controller.ask('Plan coupons', null, { bot: 'lead', permissions: 'ask' }).finished;
  await controller.close();
  saveTask(p.repo, { ...readTask(p.repo, first.id), messages: [...readTask(p.repo, first.id).messages, { at: at(), text: 'Approved the Task: Uppercase coupons' }] });
  stoppedOnTheInternet(p.repo, first.id);
  const session = () => readTask(p.repo, first.id), count = session().runs.length;
  const v = await app(t, p.repo);
  await open(v, taskTitle(first), first.id);
  const chat = () => v.current.panels.chat.getText().replace(/\s+/g, ' ');
  await until(() => /Blocked: Connect to elu\.dev\. The internet is off for commands in Ask for approval: \/permissions full continues it\./.test(chat()), `the Blocked line in the chat: "${chat().slice(-400)}"`);
  await send(v, '/permissions full');
  await fill(v, /Full access/, 'y');
  await until(() => /Full access\. Continuing where it stopped\./.test(v.current.panels.status.getText()), `the status line: "${v.current.panels.status.getText()}"`);
  assert.deepEqual(pendingRequests(p.root).filter(row => /^Continue where you stopped: /.test(row.goal)).map(row => row.bot ?? null), ['lead'], 'it goes on with @lead');
  await until(() => session().runs.length > count && pendingRequests(p.root).every(row => row.state === 'done') && !['running', 'preparing'].includes(session().state), 'the turn that goes on');
  assert.deepEqual(session().runs.slice(count).map(run => run.role), ['bot:lead']);
});

// a on a session's row answers it from the list: as a message typed in it with no @name goes,
// to the working bot it is written to; a bot that does not work (@reviewer) keeps today, and
// the answer goes to the model.
test('the answer prompt (a on its row) sends to @lead in a session written to @lead, and to the model in one written only to @reviewer, as before', { timeout: 120000 }, async t => {
  const p = appEnvironment(t, 'answer');
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  const lead = await controller.ask('Plan coupons', null, { bot: 'lead', permissions: 'ask' }).finished;
  const reviewer = await controller.ask('Look at the coupon code', null, { bot: 'reviewer', permissions: 'ask' }).finished;
  await controller.close();
  saveTask(p.repo, { ...readTask(p.repo, lead.id), messages: [...readTask(p.repo, lead.id).messages, ...LATER_ROWS()] });
  setTitle(p.repo, lead.id, 'Coupons plan'); setTitle(p.repo, reviewer.id, 'Coupon review');
  const v = await app(t, p.repo);
  // A key on the list is its letter, then Enter, as he presses it.
  keyThenEnter(v.input, () => v.current);
  const answer = async (title, id, text) => {
    await selectRow(v, title, id);
    v.input.write('a');
    await fill(v, /Answer /, text);
    await until(() => pendingRequests(p.root).some(row => row.goal === text), 'the answer is sent');
    return pendingRequests(p.root).find(row => row.goal === text);
  };
  assert.equal((await answer('Coupon review', reviewer.id, 'Use upper case.')).bot ?? null, null, 'a bot that does not work keeps today: the model');
  assert.equal((await answer('Coupons plan', lead.id, 'Trim them too.')).bot, 'lead');
});
