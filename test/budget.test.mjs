import test from 'node:test';
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

// A session's /budget, on every vendor: what it says the session spent, a run whose cost is not
// known, and a turn that would go over the limit.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// /budget in the app: a session whose runs are set here, and what the status line says.
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
function viewEnvironment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  resources(t).files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
async function until(check, message = 'condition', timeout = 15000) {
  const started = Date.now();
  while (!await check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await sleep(20); }
}
async function view(t, repo) {
  viewEnvironment(t, { TERM: 'xterm-256color' });
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = 80; output.rows = 24;
  let rendered;
  const owned = resources(t);
  if (!owned.conductor) { const conductor = new Conductor({ tickMs: 20 }).start(); owned.conductor = conductor; owned.views.push(() => conductor.stop()); }
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
  return { input, get current() { return rendered; } };
}
async function send(v, text) {
  v.current.panels.ask.focus(); v.current.panels.ask.readInput();
  await until(() => v.current.panels.ask.__listener, 'message box');
  v.current.panels.ask.setValue(text); v.current.panels.ask.submit();
}
async function openTask(v, pattern) {
  const list = () => v.current.panels.board.items.map(item => item.getText());
  if (v.current.view !== 'tasks') await send(v, '/tasks');
  await until(() => v.current.view === 'tasks' && list().some(row => pattern.test(row)), `row ${pattern}`);
  const board = v.current.panels.board; board.focus(); board.select(list().findIndex(row => pattern.test(row)));
  await until(() => v.current.screen.focused === board, 'its row');
  v.input.write('\r'); await until(() => v.current.screen.focused === v.current.panels.ask && v.current.session, 'its chat');
}

test('/budget says what the session spent as far as it is known: $X, ≥$X when a run has no price, and not known yet when none has', { timeout: 60000 }, async t => {
  const p = project({ after: close => resources(t).files.push(close) }), fake = fakeClis(p.parent, { mode: 'normal' });
  viewEnvironment(t, { ...fake.env, XDG_CONFIG_HOME: path.join(p.parent, 'personal'), NO_COLOR: '1' });
  assert.equal(cli(p.root, ['init', '--yes'], fake.env).status, 0);
  git(p.root, ['add', '.']); git(p.root, ['commit', '-m', 'Configure checks']);
  const repo = repository(p.root);
  // A Codex run's tokens are priced at its model's list price: a dollar on gpt-6.1-sol, nothing
  // known on a model with no price here. A Claude Code run reports its own cost.
  const at = new Date().toISOString(), tokens = { input: 0, output: 99_900, cacheRead: 10_000, cacheWrite: 0 }, logFile = path.join(p.parent, 'run.jsonl');
  const codex = model => ({ role: 'lead', vendor: 'codex', at, code: 0, session: 'thread-1', ownCost: true, model, tokens, logFile });
  const claude = usd => ({ role: 'lead', vendor: 'claude', at, code: 0, session: 'session-1', ownCost: true, costUsd: usd, logFile });
  liveTask(p.root, { id: '4', goal: 'Trim coupon codes', state: 'answered' });
  const v = await view(t, repo), status = () => v.current.panels.status.getText().replace(/\s+/g, ' ').trim();
  await openTask(v, /Trim coupon codes/);
  // A session saved while its chat is open is drawn again; the next command waits for that.
  const runs = async list => { const task = readTask(repo, '4'); task.runs = list; saveTask(repo, task); await sleep(500); };
  const said = async (list, text) => { await runs(list); await send(v, '/budget'); await until(() => status().endsWith(text), `${JSON.stringify(text)}, not ${JSON.stringify(status())}`); };
  await said([], 'This session has spent $0.00. It has no limit; /budget NUMBER sets one.');
  // Every run with no cost known: not $0.00.
  await said([codex('gpt-unlisted')], 'What this session has spent is not known yet. It has no limit; /budget NUMBER sets one.');
  // Some known: at least what they cost.
  await said([claude(0.4), codex('gpt-unlisted')], 'This session has spent ≥$0.40. It has no limit; /budget NUMBER sets one.');
  await send(v, '/budget 5'); await until(() => /may now spend up to \$5\.00/.test(status()), 'the limit is set');
  await said([codex('gpt-unlisted')], 'What this session has spent is not known yet. Its limit is $5.00; /budget off removes the limit.');
  await said([claude(0.4), codex('gpt-unlisted')], 'This session has spent ≥$0.40 of its $5.00 limit. /budget off removes the limit.');
  // All known: exactly that.
  await said([claude(0.4), codex('gpt-6.1-sol')], 'This session has spent $1.40 of its $5.00 limit. /budget off removes the limit.');
  await said([], 'This session has spent $0.00 of its $5.00 limit. /budget off removes the limit.');
});
