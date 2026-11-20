import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { project, fakeClis, cli, git, temp, autoApprove, keyThenEnter } from './helpers.mjs';
import { liveTask } from './peer-helpers.mjs';
import { repository } from '../lib/git.mjs';
import { ProjectController, registerProject, sessionModel } from '../lib/projects.mjs';
import { launchTerminal } from '../lib/terminal.mjs';
import { projectFolder, pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { typedCommand, argumentMatches } from '../lib/terminal-commands.mjs';
import { Conductor, enqueue } from '../lib/conductor.mjs';
import { conductorFolder, statusPath } from '../lib/conductor-files.mjs';
import { readTask, saveTask, changeSettings, taskTitle } from '../lib/state.mjs';
import { LINES, AUTO_NAME, autoSettings, ownerWords, saveAutoSettings } from '../lib/auto-model.mjs';
import { answerCheck } from '../lib/owner-check.mjs';
import { noteChange, pickedOverAuto } from '../lib/agent-change.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { createTeam } from '../lib/peer/roster.mjs';
import { createInvite, redeemCode } from '../lib/peer/invite.mjs';
import { share, setTeamProject } from '../lib/peer/shares.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { hostMethods, hostTick, projectKey, relist } from '../lib/peer/remote.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';

// Auto model as a person types it and reads it (lib/auto-model.mjs): /model auto in a session
// and in the new session form, the pickers, the agent page, a conductor too old to take it, and
// a session followed from another computer. Turned on, the box and the form name it and ELU
// writes one line; a model or an effort picked by hand, or /model auto off, turns it off with
// one line; the settings of this computer (/model auto <effort>, /model auto quick, /model
// computer auto) change no session. The retry key and a check answered from another computer
// pick no step. With it off, every path reads as before.

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
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  resources(t).files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function setup(t, mode = 'normal', options = {}) {
  const p = project({ after: close => resources(t).files.push(close) }), fake = fakeClis(p.parent, { mode, ...options });
  environment(t, { ...fake.env, XDG_CONFIG_HOME: path.join(p.parent, 'personal'), ELU_NO_COLOR: '1' });
  assert.equal(cli(p.root, ['init', '--yes'], fake.env).status, 0);
  git(p.root, ['add', '.']); git(p.root, ['commit', '-m', 'Configure checks']);
  return { ...p, ...fake, repo: repository(p.root) };
}
async function until(check, message = 'condition', timeout = 10000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
// Where the Usage tab reads from: an empty temp home and fixed vendor rows.
function fakeUsage(t) {
  const home = temp(t); for (const name of ['claude', 'codex']) fs.mkdirSync(path.join(home, name));
  const vendors = [{ vendor: 'claude', available: true, signedIn: true }, { vendor: 'codex', available: true, signedIn: true }, { vendor: 'agy', available: true, signedIn: false }, { vendor: 'grok', available: false, signedIn: false }];
  return { home, env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex') }, vendors: () => vendors };
}
// The app on a fake terminal, with a conductor of its own in this process (conductor: false
// opens it with none running).
async function view(t, options = {}) {
  environment(t, { TERM: 'xterm-256color' });
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = 80; output.rows = 24;
  let rendered;
  const owned = resources(t), { conductor: background = true, ...given } = options;
  if (background && !owned.conductor) { const conductor = new Conductor({ tickMs: 20 }).start(); owned.conductor = conductor; owned.views.push(() => conductor.stop()); }
  const finished = launchTerminal({ usage: fakeUsage(t), ...given, input, output, refreshMs: 30, startConductor: () => false, onRender: value => { rendered = value; } });
  finished.catch(() => {});
  await until(() => rendered, 'first render');
  const write = keyThenEnter(input, () => rendered);
  const state = { type(text) { for (const ch of text) write(ch); }, input, output, finished, get current() { return rendered; } };
  // A failed test can leave a dialog open: every pass closes what is open and presses q again,
  // and a view that still will not close is interrupted the way a hangup would.
  resources(t).views.push(async () => {
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
      await new Promise(resolve => setTimeout(resolve, stopped ? 20 : 2));
    }
    input.destroy(); output.destroy();
    if (failure) throw failure;
  });
  return state;
}
function modal(v, title) { return v.current.screen.children.find(child => !child.destroyed && child.options?.label?.trim() === title); }
function dialogText(v, title) { return modal(v, title).children.find(child => child.options?.scrollable).getText(); }
async function dialog(v, title, value) {
  await until(() => modal(v, title), title);
  const field = modal(v, title).children.find(child => child.type === 'textbox');
  await until(() => field.__listener, `${title} input`);
  field.setValue(value); field.submit();
}
async function send(v, text) {
  v.current.panels.ask.focus(); v.current.panels.ask.readInput();
  await until(() => v.current.panels.ask.__listener, 'message box');
  v.current.panels.ask.setValue(text); v.current.panels.ask.submit();
}
// A session of the owner's that answered, as a message he typed leaves it, with no turn run here.
function chatSession(p, id, goal) {
  const at = new Date().toISOString(); fs.mkdirSync(path.join(p.repo.state, 'tasks', id), { recursive: true });
  saveTask(p.repo, { id, kind: 'conversation', base: null, branch: null, worktree: p.repo.root, goal, state: 'answered', activeRole: null, activeLog: null, createdAt: at, runs: [], sessions: {}, reviews: [], responses: [], messages: [{ at, text: goal }] });
}
// The Sessions list, and the session a row shows.
const rows = v => v.current.panels.board.items.map(item => item.getText());
const cursor = v => rows(v)[v.current.panels.board.selected] ?? '';
function rowSession(v, text) {
  const titled = (v.current.controller?.snapshot().tasks ?? []).filter(task => taskTitle(task) && text.includes(taskTitle(task)));
  return titled.sort((a, b) => taskTitle(b).length - taskTitle(a).length)[0]?.id ?? /#(\d+) /.exec(text)?.[1];
}
// The cursor on the first row that matches, its session shown beside the list.
async function selectRow(v, pattern) {
  if (v.current.view !== 'tasks') await send(v, '/tasks');
  await until(() => v.current.view === 'tasks' && rows(v).some(row => pattern.test(row)), `row ${pattern}`);
  const board = v.current.panels.board, before = v.current; board.focus(); board.select(rows(v).findIndex(row => pattern.test(row)));
  const id = rowSession(v, rows(v).find(row => pattern.test(row)));
  await until(() => v.current !== before && pattern.test(cursor(v)) && v.current.screen.focused === board && (!id || v.current.session === id), `row ${pattern} shown`);
}
async function openTask(v, pattern) {
  await selectRow(v, pattern);
  v.input.write('\r'); await until(() => v.current.screen.focused === v.current.panels.ask && v.current.session, 'task chat');
}
const squash = text => text.replace(/\s+/g, ' ').trim();
const handles = v => ({
  status: () => squash(v.current.panels.status.getText()).replace(/^› /, ''),
  label: () => v.current.panels.ask._label.getText(),
  chat: () => squash(v.current.panels.chat.getText()),
  form: () => v.current.panels.composeList.items.map(item => squash(item.getText())),
  note: () => squash(v.current.panels.composeHint.getText()),
});

test('/model auto in an open session: the line, the chat, the box; a model or an effort picked turns it off', { timeout: 120000 }, async t => {
  const p = setup(t, 'answer'), v = await view(t, { repo: p.repo }), { status, label, chat } = handles(v);
  await until(() => v.current.panels.ask.__listener, 'default input');
  await send(v, 'Reply with the summary "first".');
  await until(() => v.current.snapshot?.tasks?.[0]?.state === 'answered', 'the first reply', 15000);
  const id = v.current.snapshot.tasks[0].id, task = () => readTask(p.repo, id), lines = () => (task().agentChanges ?? []).map(row => row.text);
  // On: the line under the box, once in the chat, and the box names it.
  await send(v, '/model auto');
  await until(() => /^Auto model is on\. Plans: .+ · Edits: .+/.test(status()), `the line: ${status()}`);
  assert.equal(task().auto, true);
  assert.equal(lines().length, 1); assert.match(lines()[0], /^Auto model is on\. Plans: /);
  await until(() => /^ Message Auto model · /.test(label()), `the box: ${label()}`);
  await until(() => /Auto model is on\. Plans: /.test(chat()), 'the chat keeps the line');
  await send(v, '/agents'); await until(() => /In this session: Auto model\./.test(status()), `agents: ${status()}`);
  // Again: it says what is on, and the chat keeps no second line.
  await send(v, '/model auto'); await until(() => /^Auto model is on\./.test(status()), 'said again');
  assert.equal(lines().length, 1);
  // A model picked: off, and the line says so.
  await send(v, '/model sonnet');
  await until(() => /Model of this session: Sonnet\. Auto model is off\./.test(status()), `picked: ${status()}`);
  assert.equal(task().auto, undefined); assert.equal(lines().at(-1), 'Model of this session: Sonnet. Auto model is off.');
  assert.deepEqual(sessionModel(p.repo, task()), { vendor: 'claude', model: 'sonnet' });
  await until(() => /^ Message Sonnet/.test(label()), `the box names the model again: ${label()}`);
  // The model it runs on already, picked while Auto model is on: still off, with the line.
  await send(v, '/model auto'); await until(() => task().auto === true, 'on again');
  await send(v, '/model sonnet');
  await until(() => task().auto === undefined, 'the same model still turns it off');
  await until(() => /Model of this session: Sonnet\. Auto model is off\./.test(status()), `same model: ${status()}`);
  assert.equal(lines().filter(text => text === 'Model of this session: Sonnet. Auto model is off.').length, 2);
  // With it off the same pick is no change, as before.
  await send(v, '/model sonnet'); await until(() => /This session already runs on Sonnet/.test(status()), `already: ${status()}`);
  // An effort picked: off too.
  await send(v, '/model auto'); await until(() => task().auto === true, 'on a third time');
  await send(v, '/agent change @model effort high');
  await until(() => task().auto === undefined, 'an effort turns it off');
  assert.equal(task().leadEffort, 'high'); assert.match(lines().at(-1), /^Model of this session: Sonnet high\. Auto model is off\.$/);
  // The settings of this computer change no session.
  await send(v, '/model auto high'); await until(() => status() === LINES.effortSet('high'), `effort: ${status()}`);
  assert.equal(autoSettings().effort, 'high'); assert.equal(task().auto, undefined);
  await send(v, '/model auto quick home'); await until(() => status() === LINES.quickSet('home'), `quick: ${status()}`);
  assert.equal(autoSettings().quick, 'home');
  await send(v, '/model auto quick'); await until(() => status() === LINES.quickUse, `quick alone: ${status()}`); v.current.panels.ask.setValue('');
  assert.equal(task().auto, undefined, 'quick alone turns nothing on');
  await send(v, '/model auto quick agy'); await until(() => status() === LINES.quickNone('agy'), `quick agy: ${status()}`); v.current.panels.ask.setValue('');
  await send(v, '/model default auto'); await until(() => status() === LINES.defaultHint, `default auto: ${status()}`); v.current.panels.ask.setValue('');
  await send(v, '/model computer auto'); await until(() => status() === LINES.computerOn, `computer auto: ${status()}`);
  assert.equal(autoSettings().default, true);
  await send(v, '/model computer auto now'); await until(() => /Use \/model computer <name>, or none\./.test(status()), 'no message after it'); v.current.panels.ask.setValue('');
  await send(v, '/model computer none'); await until(() => status().endsWith(LINES.computerOff), `computer none: ${status()}`);
  assert.equal(autoSettings().default, false);
  await send(v, '/agent add auto'); await until(() => status() === LINES.reserved, `agent add auto: ${status()}`); v.current.panels.ask.setValue('');
  await send(v, '/agent change @model model auto'); await until(() => task().auto === true, 'model auto by /agent change');
  // A message after auto is sent with it on.
  await send(v, '/model sonnet'); await until(() => task().auto === undefined, 'off');
  const runs = task().runs.length;
  await send(v, '/model auto Reply with the summary "second".');
  await until(() => task().auto === true, 'on with a message');
  await until(() => task().runs.length > runs && task().state === 'answered', 'the message ran', 20000);
});

test('the new session form: /model auto with no session open opens it with Auto model on, the request carries auto, and a model picked takes it off', { timeout: 60000 }, async t => {
  const p = setup(t, 'answer'); registerProject(p.repo);
  const v = await view(t, { repo: p.repo, conductor: false }), { status, label, form, note } = handles(v);
  const waiting = () => pendingRequests(p.root);
  await send(v, '/projects'); await until(() => v.current.view === 'projects', 'the Projects tab');
  await send(v, '/model auto');
  await until(() => /^Auto model is on\. Plans: /.test(status()), `on: ${status()}`);
  await until(() => v.current.session === 'new' && /New session → Auto model · sample app/.test(label()), `the form is open on it: ${label()}`);
  assert.ok(form().some(row => /^Model\s+Auto model/.test(row)), 'the Model row names it');
  assert.match(note(), /^Auto model is on\. Plans: .+ No bot reviews the changes/);
  // A model picked in the form: off, and the line says so.
  await send(v, '/model sonnet'); await until(() => status() === 'Model of this session: Sonnet. Auto model is off.', `picked: ${status()}`);
  await until(() => /New session → Sonnet · sample app/.test(label()), `the box: ${label()}`);
  assert.ok(form().some(row => /^Model\s+Sonnet/.test(row)));
  // On again over that model, then a message: the request carries the mark and the model.
  await send(v, '/model auto'); await until(() => /New session → Auto model/.test(label()), 'on again');
  await send(v, 'Where is the cart total?');
  await until(() => waiting().length === 1, 'queued');
  assert.equal(waiting()[0].auto, true); assert.deepEqual(waiting()[0].model, { vendor: 'claude', model: 'sonnet' });
  // The box over the request that waits names it too.
  await until(() => /Auto model/.test(label()), `over the saved request: ${label()}`);
  // A new form starts without it: the computer's default is off.
  await send(v, '/new'); await until(() => v.current.session === 'new' && /New session → Opus · sample app/.test(label()), `a new form: ${label()}`);
  await send(v, 'And the tax line?'); await until(() => waiting().length === 2, 'the second is queued');
  assert.equal(waiting().find(row => row.goal === 'And the tax line?').auto, undefined, 'no mark with Auto model off');
  // /model auto and a message in one line, with no session open.
  await send(v, '/projects'); await until(() => v.current.view === 'projects', 'Projects');
  await send(v, '/model auto Write the release note.'); await until(() => waiting().length === 3, 'the third is queued');
  assert.equal(waiting().find(row => row.goal === 'Write the release note.').auto, true);
  await until(() => /^Auto model is on\./.test(status()), `the line stays after it is sent: ${status()}`);
  // The computer's default: new forms begin with it, and the box says so before a form is open.
  await send(v, '/model computer auto'); await until(() => status() === LINES.computerOn, `computer: ${status()}`);
  await send(v, '/projects'); await until(() => v.current.view === 'projects', 'Projects again');
  await until(() => /New session → Auto model/.test(label()), `the box that starts a session: ${label()}`);
  await send(v, 'Check the totals.'); await until(() => waiting().length === 4, 'the fourth is queued');
  assert.equal(waiting().find(row => row.goal === 'Check the totals.').auto, true, 'the default marks it');
  // /model with nothing named and no session open says the default.
  await send(v, '/projects'); await until(() => v.current.view === 'projects', 'Projects a third time');
  await send(v, '/model'); await until(() => status().endsWith(LINES.computerOn), `the default: ${status()}`);
});

test('an older conductor: /model auto is refused with one line, and nothing is turned on', { timeout: 60000 }, async t => {
  const p = setup(t, 'answer');
  liveTask(p.root, { id: '4', goal: 'Trim coupon codes', state: 'answered' });
  // A conductor of a build before Auto model: its status has no auto mark.
  const plant = () => { fs.mkdirSync(path.dirname(statusPath()), { recursive: true }); fs.writeFileSync(statusPath(), JSON.stringify({ pid: process.pid, version: '0.0.1', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), queued: 0, runs: [], copies: 1, goals: 1 })); };
  plant();
  const v = await view(t, { repo: p.repo, conductor: false }), { status, label } = handles(v);
  await openTask(v, /Trim coupon codes/); plant();
  await send(v, '/model auto');
  await until(() => status() === LINES.older, `older: ${status()}`);
  assert.equal(readTask(p.repo, '4').auto, undefined);
  assert.doesNotMatch(label(), /Auto model/);
  // The settings of this computer are still taken.
  v.current.panels.ask.setValue(''); plant();
  await send(v, '/model auto max'); await until(() => status() === LINES.effortSet('max'), `effort: ${status()}`);
  // With the default on, the form does not say Auto model while that conductor runs, and no request is marked.
  saveAutoSettings({ default: true }); plant();
  await send(v, '/new'); await until(() => v.current.session === 'new' && /New session → Opus/.test(label()), `the form: ${label()}`);
  plant(); await send(v, 'And the tax line?'); await until(() => pendingRequests(p.root).length === 1, 'queued');
  assert.equal(pendingRequests(p.root)[0].auto, undefined);
});

test('a session whose turn still runs on the conductor an update replaced: /model auto is refused with the one line, and nothing is turned on', { timeout: 60000 }, async t => {
  const p = setup(t, 'answer');
  chatSession(p, '4', 'Trim coupon codes'); chatSession(p, '5', 'Round the tax line');
  // The conductor that takes new work is of this build. The one it replaced, of the build before
  // Auto model, still finishes session 4's turn: when that turn saves, the setting would be dropped.
  const at = new Date().toISOString(), id = '0f0e0d0c-0b0a-4990-8807-0605040302ab', drain = path.join(conductorFolder(), `draining-${id}.json`);
  const plant = (extra = {}) => {
    fs.mkdirSync(conductorFolder(), { recursive: true });
    fs.writeFileSync(statusPath(), JSON.stringify({ pid: process.pid, version: '0.0.2', startedAt: at, heartbeatAt: new Date().toISOString(), queued: 0, runs: [], standup: 1, standupAside: 1, copies: 1, goals: 1, auto: 1 }));
    fs.writeFileSync(drain, JSON.stringify({ id, pid: process.pid, version: '0.0.1', startedAt: at, error: null, runs: [{ root: p.repo.root, project: path.basename(p.repo.root), taskId: '4', requestId: 'r-older', startedAt: at, attempts: 0, stalled: false, origin: null }], heartbeatAt: new Date().toISOString(), goals: 1, ...extra }));
  };
  plant();
  const v = await view(t, { repo: p.repo, conductor: false }), { status, label } = handles(v), task = id => readTask(p.repo, id);
  await openTask(v, /Trim coupon codes/); plant();
  await send(v, '/model auto'); await until(() => status() === LINES.older, `older: ${status()}`);
  assert.deepEqual([task('4').auto, task('4').agentChanges], [undefined, undefined], 'not on, and the chat keeps no line');
  assert.doesNotMatch(label(), /Auto model/);
  // Another session, whose turn that conductor does not run, takes it.
  v.current.panels.ask.setValue('');
  await openTask(v, /Round the tax line/); plant();
  await send(v, '/model auto'); await until(() => task('5').auto === true, 'on in the other session');
  // So does session 4 once the conductor that finishes its turn is of this build.
  await openTask(v, /Trim coupon codes/); plant({ auto: 1 });
  await send(v, '/model auto'); await until(() => task('4').auto === true, 'on');
});

test('/model auto off: the open session goes on with the model it has, with one line; with it off nothing changes; on the form it takes it away; nothing is sent', { timeout: 60000 }, async t => {
  const p = setup(t, 'answer'); chatSession(p, '4', 'Trim coupon codes');
  const task = () => readTask(p.repo, '4'), lines = () => (task().agentChanges ?? []).map(row => row.text), waiting = () => pendingRequests(p.root);
  const v = await view(t, { repo: p.repo, conductor: false }), { status, label } = handles(v);
  await openTask(v, /Trim coupon codes/);
  // auto on is auto.
  await send(v, '/model auto on'); await until(() => task().auto === true && /^Auto model is on\./.test(status()), `on: ${status()}`);
  assert.equal(lines().length, 1);
  await send(v, '/model auto off'); await until(() => task().auto === undefined, 'off');
  await until(() => status() === LINES.picked('Opus'), `off: ${status()}`);
  assert.deepEqual(lines().slice(1), [LINES.picked('Opus')]);
  await until(() => /^ Message Opus/.test(label()), `the box names the model: ${label()}`);
  // Already off: it says so, and nothing changes.
  await send(v, '/model auto off'); await until(() => status() === LINES.off, `already off: ${status()}`);
  assert.equal(lines().length, 2);
  assert.deepEqual([waiting(), task().runs], [[], []], 'nothing was sent');
  // The new session form: it takes Auto model off the form.
  await send(v, '/new'); await until(() => v.current.session === 'new', 'the form');
  await send(v, '/model auto'); await until(() => /New session → Auto model/.test(label()), `on the form: ${label()}`);
  await send(v, '/model auto off'); await until(() => status() === LINES.off && /New session → Opus/.test(label()), `off the form: ${status()} ${label()}`);
  await send(v, 'And the tax line?'); await until(() => waiting().length === 1, 'queued');
  assert.equal(waiting()[0].auto, undefined);
});

test('/model auto quick names a vendor that is not ready: the line says which vendor answers quick questions until it is', { timeout: 60000 }, async t => {
  const p = setup(t, 'answer'); environment(t, { HOME: p.parent }); saveAutoSettings({ quick: 'off' });
  const v = await view(t, { repo: p.repo, conductor: false }), { status } = handles(v);
  await until(() => v.current.panels.ask.__listener, 'default input');
  // Grok Build is installed here and not signed in; Claude Code, which new sessions start on, takes them.
  await send(v, '/model auto quick grok');
  await until(() => status() === `${LINES.quickSet('grok')} ${LINES.quickWaits('grok', 'claude')}`, `grok: ${status()}`);
  assert.equal(autoSettings().quick, 'grok');
});

test('/model computer auto where no vendor here can have it: the line is about this computer, typed or picked', { timeout: 60000 }, async t => {
  const p = setup(t, 'answer');
  for (const vendor of ['claude', 'codex']) fs.rmSync(path.join(p.dir, vendor));
  environment(t, { PATH: [p.dir, '/usr/bin', '/bin'].join(path.delimiter) });
  const v = await view(t, { repo: p.repo, conductor: false }), { status } = handles(v);
  await until(() => v.current.panels.ask.__listener, 'default input');
  await send(v, '/model computer auto'); await until(() => status() === LINES.needsHomeHere, `computer auto: ${status()}`);
  assert.notEqual(autoSettings().default, true);
  // Typed with the command list closed (Esc), so Enter runs it as it is.
  const ask = v.current.panels.ask; ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box');
  ask.setValue('/model computer'); ask.__listener('\x1b', { name: 'escape' }); ask.submit();
  await until(() => modal(v, 'Model'), 'the picker');
  const field = modal(v, 'Model').children.find(child => child.type === 'textbox'); await until(() => field.__listener, 'field');
  field.setValue('auto'); field.emit('keypress', '\r', { name: 'enter' });
  await until(() => squash(dialogText(v, 'Model')).includes(LINES.needsHomeHere), `picked: ${squash(dialogText(v, 'Model'))}`);
  field.emit('cancel'); await until(() => !modal(v, 'Model'), 'picker closed');
  assert.notEqual(autoSettings().default, true);
});

test("a session stopped at one model's own week whose message starts again on its other model: the chat and the line under it say it goes on by itself", { timeout: 60000 }, async t => {
  const p = setup(t, 'answer'); liveTask(p.root, { id: '4', goal: 'Trim coupon codes', state: 'blocked', activeRole: null });
  const resets = Date.now() + 2 * 24 * 3600 * 1000;
  changeSettings(p.repo, '4', row => { row.auto = true; });
  const stopped = readTask(p.repo, '4'); stopped.error = { message: 'Fable 5.2 could not finish.', modelLimit: { model: 'fable', until: resets } }; saveTask(p.repo, stopped);
  // The conductor queued it to start again on the other model (lib/conductor.mjs finish).
  const sent = enqueue(p.root, 'Plan the coupon change.', { continuationTaskId: '4', priority: 0, typed: true });
  updateRequest(p.root, sent.id, { modelLimit: { model: 'fable', until: resets, step: 'plan' } });
  const v = await view(t, { repo: p.repo, conductor: false }), { chat } = handles(v);
  await openTask(v, /Trim coupon codes/);
  await until(() => /Fable is at its limit until .+\. This session goes on with its other model\./.test(chat()), `the chat: ${chat()}`);
  assert.doesNotMatch(chat(), /Type continue/);
});

test('the command list: auto is the first row of /model, and nothing is offered after it but where quick questions go', () => {
  const ctx = { models: () => [{ name: 'opus', vendor: 'claude', note: '', current: true }], auto: () => ({ note: LINES.listNote, current: false, computer: 'New sessions you start on this computer begin with Auto model', quick: [{ word: 'grok', description: 'g' }, { word: 'home', description: 'h' }, { word: 'off', description: 'o' }] }) };
  const words = text => argumentMatches(text, ctx).map(row => row.word);
  assert.deepEqual(words('/model '), ['auto', 'opus', 'default', 'computer', 'add']);
  assert.deepEqual(argumentMatches('/model ', ctx)[0], { word: 'auto', description: 'ELU picks the model for each step', more: false, value: '/model auto' });
  assert.deepEqual(words('/model a'), ['auto', 'add']);
  assert.deepEqual(words('/model auto '), []); assert.deepEqual(words('/model auto hi'), []); assert.deepEqual(words('/model auto q'), []);
  assert.deepEqual(words('/model auto quick '), ['grok', 'home', 'off']); assert.deepEqual(words('/model auto quick fix'), []); assert.deepEqual(words('/model auto quick fix the'), []);
  assert.deepEqual(words('/model computer '), ['opus', 'auto', 'none']); assert.deepEqual(words('/model default '), ['opus', 'none']);
  assert.equal(argumentMatches('/model ', { ...ctx, auto: () => ({ ...ctx.auto(), current: true }) })[0].description, 'ELU picks the model for each step · in use');
  // With none offered (no vendor that can have it), and for a caller that gives none: as before.
  assert.deepEqual(argumentMatches('/model ', { ...ctx, auto: () => null }).map(row => row.word), ['opus', 'default', 'computer', 'add']);
  assert.deepEqual(argumentMatches('/model ', { models: ctx.models }).map(row => row.word), ['opus', 'default', 'computer', 'add']);
  assert.deepEqual(argumentMatches('/model computer ', { models: ctx.models }).map(row => row.word), ['opus', 'none']);
  assert.equal(typedCommand('/model ').usage, '/model [name [message]|auto [message]|default <name>|computer <name>|add]');
});

test('a line of ELU in the chat, and a model picked by a path with no line of its own', async t => {
  const p = setup(t, 'answer'); liveTask(p.root, { id: '4', goal: 'Trim coupon codes', state: 'answered' });
  const task = () => readTask(p.repo, '4'), lines = () => (task().agentChanges ?? []).map(row => row.text);
  assert.equal(pickedOverAuto(p.repo, '4', 'Sonnet'), false); assert.deepEqual(lines(), [], 'with it off nothing is said');
  noteChange(p.repo, '4', 'Auto model is on.'); assert.deepEqual(lines(), ['Auto model is on.']);
  changeSettings(p.repo, '4', row => { row.auto = true; row.autoEffort = 'high'; }); assert.equal(task().auto, true);
  assert.equal(pickedOverAuto(p.repo, '4', 'Sonnet'), true);
  assert.equal(task().auto, undefined); assert.equal(task().autoEffort, undefined);
  assert.deepEqual(lines(), ['Auto model is on.', 'Model of this session: Sonnet. Auto model is off.']);
});

test('the pickers: auto is the first row of the Model picker, and the agent page reads Auto model until a model or an effort is picked there', { timeout: 120000 }, async t => {
  const p = setup(t, 'answer'), v = await view(t, { repo: p.repo }), { status } = handles(v);
  const opened = start => v.current.screen.children.find(child => !child.destroyed && child.options?.label?.trim().startsWith(start));
  const listOf = start => opened(start)?.children.filter(child => child.type === 'list').at(-1);
  const rowsOf = start => listOf(start).items.map(item => squash(item.getText()));
  const notesOf = start => squash(opened(start).children.filter(child => child.type !== 'list').map(child => child.getText?.() ?? '').join(' '));
  const choose = async (start, index) => { await until(() => listOf(start), start); const list = listOf(start); list.focus(); list.select(index); v.input.write('\r'); };
  await until(() => v.current.panels.ask.__listener, 'default input');
  await send(v, 'Reply with the summary "first".');
  await until(() => v.current.snapshot?.tasks?.[0]?.state === 'answered', 'the first reply', 15000);
  const id = v.current.snapshot.tasks[0].id, task = () => readTask(p.repo, id), lines = () => (task().agentChanges ?? []).map(row => row.text);
  // A command as typed with the command list closed (Esc), so Enter runs it as it is.
  const run = async text => { const ask = v.current.panels.ask; ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box'); ask.setValue(text); ask.__listener('\x1b', { name: 'escape' }); ask.submit(); };
  const page = async () => { await run('/agent change @model'); await until(() => opened('Agent '), 'the agent page'); };
  // /model alone: the picker, with auto first.
  await send(v, '/model'); await until(() => modal(v, 'Model'), 'the picker');
  const body = () => squash(dialogText(v, 'Model'));
  assert.match(body(), /auto ELU picks the model for each step/);
  await dialog(v, 'Model', 'auto');
  await until(() => task().auto === true && /^Auto model is on\./.test(status()), `picked auto: ${status()}`);
  // Again: it says what is on, and auto is the one marked.
  await send(v, '/model'); await until(() => modal(v, 'Model'), 'the picker again');
  assert.match(body(), /^Auto model is on\. Plans: .+ Choose one/); assert.match(body(), /> auto ELU picks the model for each step · in use/);
  assert.equal(modal(v, 'Model').children.find(child => child.type === 'textbox').getValue(), 'auto');
  await dialog(v, 'Model', 'opus');
  await until(() => task().auto === undefined && status().startsWith('Model of this session: Opus. Auto model is off.'), `picked the model it ran on: ${status()}`);
  // The agent page under Auto model.
  await send(v, '/model auto'); await until(() => task().auto === true, 'on');
  await page();
  assert.equal(opened('Agent ').options.label.trim(), 'Agent Auto model');
  assert.deepEqual(rowsOf('Agent '), ['Model Auto model', 'Effort xhigh', 'Save', 'Cancel']);
  assert.match(notesOf('Agent '), /Auto model is on\. Plans: /);
  // Save with nothing picked: nothing changes.
  await choose('Agent ', 2); await until(() => !opened('Agent '), 'closed');
  assert.equal(task().auto, true); assert.match(status(), /^Auto model is on\./);
  // An effort picked there: the page shows the model it will run on, and Save turns Auto model off.
  await page();
  await choose('Agent ', 1); await until(() => listOf('Effort'), 'the levels');
  await choose('Effort', rowsOf('Effort').findIndex(row => /^medium/.test(row)));
  await until(() => opened('Agent ') && !opened('Effort') && /^Effort medium/.test(rowsOf('Agent ')[1]), 'back on the page');
  assert.equal(rowsOf('Agent ')[0], 'Model Opus'); assert.match(notesOf('Agent '), /Model of this session: Opus medium\. Auto model is off\./);
  await choose('Agent ', 2);
  await until(() => task().auto === undefined, 'saved');
  assert.equal(task().leadEffort, 'medium'); assert.equal(lines().at(-1), 'Model of this session: Opus medium. Auto model is off.');
  // The Agents list names it too.
  await send(v, '/model auto'); await until(() => task().auto === true, 'on once more');
  await run('/agent change'); await until(() => opened('Agents'), 'the list');
  assert.match(rowsOf('Agents')[0], /^Auto model xhigh$/);
  v.input.write('\x1b'); await until(() => !opened('Agents'), 'closed');
  // The word auto in a picker that takes no Auto model: the agent page's.
  await page();
  await choose('Agent ', 0); await until(() => modal(v, 'Model'), 'its picker');
  assert.doesNotMatch(squash(dialogText(v, 'Model')), /ELU picks the model/);
  const field = modal(v, 'Model').children.find(child => child.type === 'textbox'); await until(() => field.__listener, 'field');
  field.setValue('auto'); field.emit('keypress', '\r', { name: 'enter' });
  await until(() => squash(dialogText(v, 'Model')).includes(LINES.reserved), `reserved: ${squash(dialogText(v, 'Model'))}`);
  field.emit('cancel'); await until(() => !modal(v, 'Model'), 'picker closed');
});

// The owner's example, typed in order in a session with Auto model on Claude Code, with Grok
// Build signed in and past its one-time check: where each message runs, at what effort, and the
// step each run records. The stand-in's script changes between messages (fake.json).
function grokReady(t) {
  const p = setup(t, 'answer', { models: { fable: 'claude-fable-5-2', opus: 'claude-opus-5-5' } });
  environment(t, { HOME: p.parent });
  fs.mkdirSync(path.join(p.parent, '.grok')); fs.writeFileSync(path.join(p.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
  atomic(path.join(personalDirectory(), 'conformance', 'grok.json'), { v: 1, bin: fs.realpathSync(path.join(p.dir, 'grok')), version: '1.0.77', steps: Object.fromEntries(ADAPTERS.grok.conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });
  const script = change => { const file = path.join(p.dir, 'fake.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...change })); };
  return { ...p, script };
}

test('the owner\'s example: a question, a quick question, an edit that asks, his answer and his thanks each run where Auto model sends them', { timeout: 120000 }, async t => {
  const p = grokReady(t), { script } = p;
  const v = await view(t, { repo: p.repo }), { status, label } = handles(v);
  await until(() => v.current.panels.ask.__listener, 'default input');
  await send(v, '/model auto'); await until(() => /New session → Auto model/.test(label()), `the form: ${label()}`);
  await send(v, '/permissions auto'); await until(() => /Approve for me/.test(status()), `the mode: ${status()}`);
  const id = () => v.current.snapshot?.tasks?.[0]?.id, task = () => readTask(p.repo, id()), lead = () => task().runs.filter(run => run.role === 'lead');
  const settled = count => id() && lead().length === count && !['running', 'preparing'].includes(task().state);
  // 1. A tough question: the top model, as a plan.
  await send(v, 'Why do coupon codes that differ only in case not match, and what would break if normalize changed?');
  await until(() => settled(1), 'the first answer', 20000);
  assert.equal(task().state, 'answered');
  // 2. A simple lookup: the fast vendor answers beside the session, read-only.
  await send(v, 'where is the build script?');
  await until(() => task().messages.some(row => row.from === 'Grok Build · quick answer' && row.update), 'the quick answer', 20000);
  await until(() => status() === 'Grok Build answered', `the line under the box: ${status()}`);
  assert.equal(lead().length, 1, 'no turn of the session model');
  // 3. Implement it: the top model writes the Task, the mode approves it, the work model edits and asks.
  script({ mode: 'question', task: { title: 'Normalize coupon codes', description: 'Make normalize return the code in upper case.', goal: 'Coupon codes compare equal whatever their case.', objectives: ['normalize returns the code in upper case', 'The coupon test passes'], priority: 'medium', severity: 'low' } });
  await send(v, 'Implement it');
  await until(() => task().state === 'needs_input', 'the question of the edit', 30000);
  assert.equal(task().auto, true, 'the setting survives the first edit');
  // 4. His answer: the edit goes on.
  const asked = lead().length;
  await send(v, 'Uppercase');
  await until(() => settled(asked + 1), 'the edit', 30000);
  // 5. His thanks: no step, the model that ran last.
  script({ mode: 'answer', answer: 'Glad it helps.' });
  await send(v, 'thanks');
  await until(() => settled(asked + 2), 'the thanks', 20000);
  assert.deepEqual(lead().map(run => [run.asked, run.step ?? null]), [['fable', 'plan'], ['fable', 'plan'], ['opus', 'edit'], ['opus', 'edit'], ['opus', null]]);
  assert.deepEqual(task().runs.filter(run => run.role !== 'lead').map(run => [run.role, run.vendor, run.step]), [['quick', 'grok', 'quick']]);
  // Each model keeps a conversation of its own, and every turn runs at Auto model's effort.
  const calls = fs.readFileSync(p.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)), flag = (args, name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;
  const turns = calls.filter(row => row.vendor === 'claude' && row.args.includes('--output-format')).map(row => [flag(row.args, '--model'), flag(row.args, '--effort'), row.args.includes('--resume')]);
  assert.deepEqual(turns, [['fable', 'xhigh', false], ['fable', 'xhigh', true], ['opus', 'xhigh', false], ['opus', 'xhigh', true], ['opus', 'xhigh', true]]);
  const quick = calls.filter(row => row.vendor === 'grok' && row.args.includes('--sandbox'));
  assert.equal(quick.length, 1); assert.equal(flag(quick[0].args, '--sandbox'), 'elu-read-only'); assert.equal(flag(quick[0].args, '--effort'), null);
});

test('a quick question the fast vendor says needs work: ELU says who takes it, and the top model takes it as a plan, written once', { timeout: 120000 }, async t => {
  const p = grokReady(t), { script } = p;
  const v = await view(t, { repo: p.repo }), { label, chat } = handles(v);
  await until(() => v.current.panels.ask.__listener, 'default input');
  await send(v, '/model auto'); await until(() => /New session → Auto model/.test(label()), `the form: ${label()}`);
  const id = () => v.current.snapshot?.tasks?.[0]?.id, task = () => readTask(p.repo, id()), lead = () => task().runs.filter(run => run.role === 'lead');
  await send(v, 'Why do coupon codes that differ only in case not match?');
  await until(() => id() && lead().length === 1 && task().state === 'answered', 'the first answer', 20000);
  // Grok Build answers that the message asks for an edit.
  script({ mode: 'normal', grok: 'edits' });
  await send(v, 'where is the build script?');
  await until(() => lead().length === 2 && !['running', 'preparing'].includes(task().state), 'the top model takes it', 30000);
  const said = LINES.handUp('Fable 5.2');
  assert.deepEqual(task().messages.filter(row => row.from === 'ELU' && row.line).map(row => row.text), [said]);
  await until(() => chat().includes(said), 'the chat shows the line');
  assert.equal(task().messages.filter(row => row.text === 'where is the build script?').length, 1, 'his message is written once');
  assert.deepEqual(task().runs.map(run => [run.role, run.vendor, run.asked ?? null, run.step ?? null]), [['lead', 'claude', 'fable', 'plan'], ['quick', 'grok', null, 'quick'], ['lead', 'claude', 'fable', 'plan']]);
});

test('r on a session of Auto model\'s that stopped sends his last message again on the model that stopped: a quick question handed up to the top model is not asked of the fast vendor again', { timeout: 120000 }, async t => {
  const p = grokReady(t);
  const v = await view(t, { repo: p.repo }), { label, status } = handles(v);
  await until(() => v.current.panels.ask.__listener, 'default input');
  await send(v, '/model auto'); await until(() => /New session → Auto model/.test(label()), `the form: ${label()}`);
  const id = () => v.current.snapshot?.tasks?.[0]?.id, task = () => readTask(p.repo, id()), lead = () => task().runs.filter(run => run.role === 'lead');
  await send(v, 'Why do coupon codes that differ only in case not match?');
  await until(() => id() && lead().length === 1 && task().state === 'answered', 'the first answer', 20000);
  // His quick question went up to Fable 5.2, and that turn failed.
  const stopped = task(), at = () => new Date().toISOString();
  stopped.messages.push({ at: at(), text: 'where is the build script?', quick: 'q1' }, { at: at(), text: LINES.handUp('Fable 5.2'), from: 'ELU', line: true, quick: 'q1' });
  Object.assign(stopped, { state: 'blocked', error: { message: 'Fable 5.2 could not finish.' } }); saveTask(p.repo, stopped);
  await selectRow(v, new RegExp(`✗ ${taskTitle(task()).slice(0, 10).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)); v.input.write('r');
  await until(() => /^Retrying /.test(status()), `retry: ${status()}`);
  await until(() => lead().length === 2 && !['running', 'preparing'].includes(task().state), 'the turn again', 30000);
  assert.deepEqual(task().runs.map(run => [run.role, run.vendor, run.asked ?? null, run.step ?? null]), [['lead', 'claude', 'fable', 'plan'], ['lead', 'claude', 'fable', null]], 'no quick answer, and no step: the model that stopped');
  assert.equal(fs.readFileSync(p.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.vendor === 'grok' && row.args.includes('--sandbox')).length, 0);
});

// The owner's project, shared with a team that another computer (sara's) is on; session 1 on
// it, and what that computer asks over the link, as the daemon hands it to the host methods.
const SARA = 'b'.repeat(64);
async function sharedSession(t) {
  const p = project(t), clis = fakeClis(p.parent, { mode: 'answer' });
  environment(t, { ...clis.env, HOME: p.parent, ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); registerProject(controller.repo);
  const repo = controller.repo, root = repo.root;
  const me = createIdentity({ name: 'ana' }), team = createTeam(me, 'core');
  redeemCode(createInvite(me, team.id, { hours: 1 }), SARA, 'sara');
  const shared = share(root, { teams: [team.id] }); setTeamProject(team.id, shared.handle);
  saveTeamAccess(team.id, { handling: 'auto', root });
  const first = await controller.ask('Look at the coupon code.', null, { permissions: 'ask' }).finished;
  assert.equal(first.id, '1');
  const heard = [];
  const link = { key: SARA, admitted: true, remoteHello: { remote: 1, shared: 1 }, notify: (method, params) => heard.push([method, params]), request: async () => { throw new Error('No answer'); } };
  const ctx = { me, session: () => null, name: () => 'sara', box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} };
  const methods = hostMethods(ctx);
  relist();
  const watched = methods['elu.remote.watch']({ ref: `${projectKey(root)}:1` }, link);
  return {
    repo, root, session: () => readTask(repo, '1'),
    send: params => methods['elu.remote.send']({ id: watched.id, ...params }, link),
    check: params => methods['elu.remote.check']({ id: watched.id, ...params }, link),
    // Everything this computer has told sara's of the session, after one more look at it.
    heard: () => { relist(); hostTick({ ...ctx, session: key => key === SARA ? link : null }, Date.now() + heard.length + 1); return heard; },
  };
}

test('a session with Auto model, from another computer: its model reads Auto model there, the word auto is refused with the one line, and a model picked there turns it off', { timeout: 120000 }, async t => {
  const w = await sharedSession(t);
  const lines = () => (w.session().agentChanges ?? []).map(row => row.text);
  // What this computer tells the other one of the session: its model, as the box there names it.
  const told = () => w.heard().flatMap(([, params]) => (params?.items ?? []).flatMap(item => item.events ?? [])).findLast(event => event.type === 'state')?.model ?? null;
  assert.notEqual(told(), AUTO_NAME);
  changeSettings(w.repo, '1', task => { task.auto = true; task.autoEffort = 'high'; });
  assert.equal(told(), AUTO_NAME);
  // The word auto from there.
  for (const text of ['auto', 'Auto', 'auto And the tests']) assert.throws(() => w.send({ text, typed: true, model: true, toModel: true }), { message: LINES.otherComputer });
  assert.equal(w.session().auto, true);
  // A model picked from there: the session's, and Auto model is off, with the line in the chat.
  const took = await w.send({ text: 'sonnet', typed: true, model: true, toModel: true });
  assert.deepEqual([sessionModel(w.repo, w.session()).vendor, sessionModel(w.repo, w.session()).model], ['claude', 'sonnet']);
  assert.equal(w.session().auto, undefined); assert.equal(w.session().autoEffort, undefined);
  assert.deepEqual(lines(), [`Model of this session: ${took.model}. Auto model is off.`]);
  assert.equal(told(), took.model);
  // With it off the same pick keeps no line, as before.
  await w.send({ text: 'opus', typed: true, model: true, toModel: true });
  assert.equal(lines().length, 1);
});

test("his answer to a session's check from another computer picks no step of Auto model: it was not typed here; the same answer here does", { timeout: 120000 }, async t => {
  const w = await sharedSession(t);
  changeSettings(w.repo, '1', task => { task.auto = true; });
  w.check({ answer: 'goal', text: 'And the import path?' });
  const away = pendingRequests(w.root).find(row => row.goal === 'And the import path?');
  assert.deepEqual([String(away.continuationTaskId), away.typed, away.byElu], ['1', true, true]);
  assert.equal(ownerWords(away), false);
  answerCheck(w.repo, w.root, w.session(), 'goal', 'And the export path?');
  const here = pendingRequests(w.root).find(row => row.goal === 'And the export path?');
  assert.deepEqual([String(here.continuationTaskId), here.typed, here.byElu], ['1', true, undefined]);
  assert.equal(ownerWords(here), true);
});
