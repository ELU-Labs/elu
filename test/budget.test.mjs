import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { project, fakeClis, autoApprove, cli, git, temp, keyThenEnter } from './helpers.mjs';
import { liveTask } from './peer-helpers.mjs';
import { repository } from '../lib/git.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { launchTerminal } from '../lib/terminal.mjs';
import { Conductor } from '../lib/conductor.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import * as spend from '../lib/agent-spend.mjs';
import { budgetMessage } from '../lib/budget.mjs';
import { boardRows } from '../lib/board.mjs';

// A session's /budget, on every vendor: what it says the session spent, a run whose cost is not
// known, and a turn that would go over the limit.

const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
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
  // A limit under a dollar is the owner's to set too.
  await send(v, '/budget 0.01'); await until(() => status().endsWith('This session may now spend up to $0.01.'), `the limit of a cent, not ${JSON.stringify(status())}`);
  await said([claude(0.4), codex('gpt-6.1-sol')], 'This session has spent $1.40 of its $0.01 limit. /budget off removes the limit.');
});

// The runner, against the stand-in vendors.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// A project whose stand-in Claude Code spends 30 cents a turn, and whose stand-in Codex keeps its
// threads in CODEX_HOME. config: more of fake.json.
function setup(t, config = {}) {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer', models: { opus: 'claude-opus-5-5' } }), file = path.join(fake.dir, 'fake.json');
  const set = values => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...values }));
  set({ spend: { model: 'claude-opus-5-5', tokens: [10, 200, 3000, 400], usd: 0.3 }, ...config });
  environment(t, { ...fake.env, HOME: p.parent, CODEX_HOME: path.join(p.parent, 'codex-home'), GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  fs.mkdirSync(path.join(p.parent, 'codex-home'), { recursive: true });
  fs.mkdirSync(path.join(p.parent, '.grok')); fs.writeFileSync(path.join(p.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  // The launches of a turn: headless, through Codex's app-server, or over ACP (not a version or sign-in check).
  const turn = { codex: args => ['exec', 'app-server'].includes(args[0]), claude: args => args.includes('-p'), agy: args => args.includes('--json-schema') || args.at(-1) === 'acp', grok: args => args.includes('--prompt-file') || args.at(-1) === 'stdio' };
  const launches = vendor => rows(fake.calls).filter(call => call.vendor === vendor && !call.rpc && turn[vendor](call.args));
  return { ...p, fake, controller, repo: controller.repo, set, launches, bin: vendor => path.join(fake.dir, vendor) };
}
// A Codex request of 10,000 cached input tokens and 99,900 output: a dollar on gpt-6.1-sol. Half of that: 50 cents.
const DOLLAR = { input_tokens: 10_000, cached_input_tokens: 10_000, output_tokens: 99_900 }, HALF = { input_tokens: 10_000, cached_input_tokens: 10_000, output_tokens: 49_900 };
// The one-time check's record for this program, so Antigravity and Grok Build run over ACP.
const proven = (vendor, bin, version) => atomic(path.join(personalDirectory(), 'conformance', `${vendor}.json`), { v: 1, bin, version, steps: Object.fromEntries(ADAPTERS[vendor].conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });
const near = (value, wanted, text) => assert.ok(Math.abs(value - wanted) < 1e-6, `${text ?? 'value'}: ${value}, not ${wanted}`);
// A message the runner refuses: the session as it was left.
async function refused(f, id, text) {
  await assert.rejects(f.controller.ask(text, id).finished);
  return readTask(f.repo, id);
}

test("a Codex run whose cost is not known counts as all of the session's limit, as a Claude Code run's does", async t => {
  const f = setup(t, { codexTurn: { requests: [DOLLAR] } });
  f.controller.setDefaultModel({ vendor: 'codex', model: 'gpt-unlisted' });
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  assert.equal(spend.runCosts(readTask(f.repo, first.id))[0], null, 'its model has no price here');
  // The next message goes to Claude Code, which would be told it may spend the whole limit.
  f.controller.setBudget(first.id, 5); f.controller.setModel(first.id, { vendor: 'claude' });
  const next = await refused(f, first.id, 'And the tests?');
  assert.equal(next.state, 'blocked');
  assert.equal(next.error?.message, 'What this session has spent is not known, so it counts as all of its $5 limit. /budget off removes it; then send your message again.');
  assert.equal(f.launches('claude').length, 0, 'Claude Code was not started');
  // With the limit off the session goes on.
  f.controller.setBudget(first.id, null);
  const after = await f.controller.ask('And the tests?', first.id).finished;
  assert.equal(after.state, 'answered', JSON.stringify(after.error)); assert.equal(f.launches('claude').length, 1);
});

// A Codex turn that failed before Codex recorded any request of it (its account had reached its
// usage limit) cost at least nothing, as Codex's record of the thread says: the session goes on.
test('a Codex run that failed before any request Codex recorded counts as at least nothing, not as all of the limit', async t => {
  const f = setup(t, { codexTurn: { requests: [DOLLAR] } });
  f.controller.setDefaultModel({ vendor: 'codex', model: 'gpt-6.1-sol' });
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  f.controller.setBudget(first.id, 3);
  // The next turn fails as Codex fails one whose account has reached its usage limit.
  fs.writeFileSync(path.join(f.parent, 'codex-home', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: `h.${Buffer.from(JSON.stringify({ email: 'codex@example.invalid' })).toString('base64url')}.s`, access_token: 'never-shown' } }));
  f.set({ accounts: { limited: ['codex@example.invalid'] } });
  await assert.rejects(f.controller.ask('And the tests?', first.id).finished);
  const failed = readTask(f.repo, first.id), own = spend.runSpends(failed)[1];
  assert.equal(failed.runs.length, 2);
  assert.equal(own.costUsd, 0); assert.equal(own.atLeast, true);
  assert.equal(budgetMessage(f.controller.budget(first.id)), 'This session has spent ≥$1.00 of its $3.00 limit. /budget off removes the limit.');
  f.set({ accounts: {} });
  const after = await f.controller.ask('And the tests?', first.id).finished;
  assert.equal(after.state, 'answered', JSON.stringify(after.error));
});

// A run ELU 0.1.25 recorded with its cost not known counted as nothing toward a limit there, and
// counts so still: a Codex run on Codex's own default model, which 0.1.25 kept no name of, and a
// headless Antigravity run that went on with a conversation whose turn before ran elsewhere.
test('a session from ELU 0.1.25 with a run whose cost is not known goes on under its limit, as it did there', async t => {
  const f = setup(t);
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  const task = readTask(f.repo, first.id), at = task.runs[0].at, log = path.join(f.parent, 'agy-0125.jsonl');
  fs.writeFileSync(log, `${JSON.stringify({ conversation_id: 'conv-1', num_turns: 2, usage: { input_tokens: 278, output_tokens: 4, thinking_tokens: 0, cache_read_tokens: 30214, total_tokens: 282 } })}\n`);
  task.runs.unshift({ role: 'lead', vendor: 'codex', at, code: 0, session: 'thread-0125', tokens: { input: 0, output: 99_900, cacheRead: 10_000, cacheWrite: 0 }, logFile: path.join(f.parent, 'gone.jsonl') },
    { role: 'lead', vendor: 'agy', at, code: 0, session: 'conv-1', tokens: { input: 30662, output: 8, cacheRead: 30214, cacheWrite: 0 }, logFile: log });
  saveTask(f.repo, task);
  assert.deepEqual(spend.runCosts(task).slice(0, 2), [null, null], 'neither cost is known');
  f.controller.setBudget(first.id, 1);
  assert.equal(budgetMessage(f.controller.budget(first.id)), 'This session has spent ≥$0.30 of its $1.00 limit. /budget off removes the limit.');
  const next = await f.controller.ask('And the tests?', first.id).finished;
  assert.equal(next.state, 'answered', JSON.stringify(next.error));
});

// A session that has spent its limit starts no more turns, on any vendor: the line says what it spent and how to change the limit.
const REFUSED = (spent, limit, more = 20) => `This session has spent ${spent} of its $${limit} limit. /budget ${more} raises it and /budget off removes it; then send your message again.`;
const vendors = [
  // Codex: a dollar a turn on gpt-6.1-sol.
  ['a Codex', 'codex', 'gpt-6.1-sol', f => f.set({ codexTurn: { requests: [DOLLAR] } }), '$1.00'],
  // Grok Build: 50,000 input and 150,000 output tokens on grok-4.6, a dollar.
  ['a Grok Build', 'grok', 'grok-4.6', f => f.set({ grok: { usage: [{ input_tokens: 50_000, output_tokens: 150_000 }] } }), '$1.00'],
  // Antigravity: 1M input, 100k output, 100k thinking and 200k read from the cache on gemini-3-flash, $1.11.
  ['an Antigravity', 'agy', 'gemini-3-flash', f => f.set({ agy: { headlessUsage: { input_tokens: 1_000_000, output_tokens: 100_000, thinking_tokens: 100_000, cache_read_tokens: 200_000, total_tokens: 1_400_000 } } }), '$1.11'],
];
for (const [name, vendor, model, spends, spent] of vendors) {
  test(`${name} session that has spent its /budget starts no more turns, and says so`, async t => {
    const f = setup(t); spends(f);
    f.controller.setDefaultModel({ vendor, model });
    const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
    assert.equal(first.state, 'answered', JSON.stringify(first.error));
    f.controller.setBudget(first.id, 1);
    const launched = f.launches(vendor).length, next = await refused(f, first.id, 'And the tests?');
    assert.equal(next.state, 'blocked');
    assert.equal(next.error?.message, REFUSED(spent, 1));
    assert.equal(f.launches(vendor).length, launched, `${vendor} was not started again`);
    // A limit raised over what was spent lets it go on.
    f.controller.setBudget(first.id, 3);
    const after = await f.controller.ask('And the tests?', first.id).finished;
    assert.equal(after.state, 'answered', JSON.stringify(after.error));
  });
}

// Antigravity's headless docs print a conversation's counts with the cache read apart from the
// input and left out of the total (the input and the output): their two-turn example on
// gemini-3.1-pro, $0.0608 and then $0.0066, and a third turn. Each run is counted once, at what
// it cost, so a session with a limit goes on.
test("a headless Antigravity session with /budget set goes on to its next messages, its counts read as Antigravity's docs print them", async t => {
  const turn = (input, output, read) => ({ input_tokens: input, output_tokens: output, thinking_tokens: 0, cache_read_tokens: read, total_tokens: input + output });
  const f = setup(t, { agy: { headlessTurns: [turn(30384, 4, 0), turn(278, 4, 30214), turn(300, 6, 30500)] } });
  f.controller.setDefaultModel({ vendor: 'agy', model: 'gemini-3.1-pro' });
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  f.controller.setBudget(first.id, 1);
  for (const text of ['And the tests?', 'And the docs?']) { const next = await f.controller.ask(text, first.id).finished; assert.equal(next.state, 'answered', JSON.stringify(next.error)); }
  const costs = spend.runCosts(readTask(f.repo, first.id));
  [(30384 * 2 + 4 * 12) / 1e6, (278 * 2 + 30214 * 0.2 + 4 * 12) / 1e6, (300 * 2 + 30500 * 0.2 + 6 * 12) / 1e6].forEach((cost, at) => near(costs[at], cost, `run ${at + 1}`));
  const budget = f.controller.budget(first.id);
  near(budget.spent, costs.reduce((total, cost) => total + cost, 0), 'spent'); assert.equal(budget.partial, false); assert.equal(budget.unknown, 0);
});

test('a Codex session given /budget 0.01 after it spent more starts no more turns, and says so', async t => {
  const f = setup(t, { codexTurn: { requests: [DOLLAR] } });
  f.controller.setDefaultModel({ vendor: 'codex', model: 'gpt-6.1-sol' });
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  assert.equal(f.controller.setBudget(first.id, 0.01).budgetUsd, 0.01);
  const launched = f.launches('codex').length, next = await refused(f, first.id, 'And the tests?');
  assert.equal(next.state, 'blocked');
  assert.equal(next.error?.message, REFUSED('$1.00', 0.01));
  assert.equal(f.launches('codex').length, launched, 'Codex was not started again');
});

// A turn of a vendor that reports what it spends while it works stops when that reaches the limit.
const STOPPED = (spent, limit, more = 20) => `ELU stopped this turn: this session has spent ${spent} of its $${limit} limit. /budget ${more} raises it and /budget off removes it; then send your message again.`;

test('a Codex turn through its app-server stops when what it has spent reaches the limit', { timeout: 60000 }, async t => {
  // Four requests of 50 cents a turn, a second apart; the app-server reports the thread's tokens after each.
  const f = setup(t, { appServer: 'steer', codexTurn: { requests: [HALF, HALF, HALF, HALF], liveMs: 1000 } });
  f.controller.setDefaultModel({ vendor: 'codex', model: 'gpt-6.1-sol' });
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  assert.ok(f.launches('codex').every(call => call.args[0] === 'app-server'), 'the turn ran through the app-server');
  near(spend.runCosts(readTask(f.repo, first.id))[0], 2, 'the first turn');
  // A dollar is left: the second turn stops after its second request.
  f.controller.setBudget(first.id, 3);
  const next = await refused(f, first.id, 'And the tests?');
  assert.equal(next.state, 'blocked');
  assert.equal(next.error?.message, STOPPED('$3.00', 3));
  // What it spent is Codex's own record of the requests it made.
  near(spend.runCosts(next)[1], 1, 'the stopped turn');
  const rollouts = [], walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else rollouts.push(file); } };
  walk(path.join(f.parent, 'codex-home', 'sessions'));
  assert.equal(rollouts.flatMap(file => rows(file)).filter(row => row.type === 'token_usage_record').length, 6, 'Codex never made the other two requests');
  // Raised, the next message goes on in the stopped turn's thread.
  f.controller.setBudget(first.id, 10);
  const after = await f.controller.ask('Carry on.', first.id).finished;
  assert.equal(after.state, 'answered', JSON.stringify(after.error));
});

test('a Grok Build turn that streams its usage stops when what it has spent reaches the limit', { timeout: 60000 }, async t => {
  // Four model responses of 100,000 input and 50,000 output tokens on grok-4.6, 50 cents each, a second apart.
  const f = setup(t, { grok: { usage: Array(4).fill({ input_tokens: 100_000, output_tokens: 50_000 }), usageMs: 1000 } });
  f.controller.setDefaultModel({ vendor: 'grok', model: 'grok-4.6' });
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  assert.ok(f.launches('grok').at(-1).args.includes('streaming-json'), 'the turn streams');
  near(spend.runCosts(readTask(f.repo, first.id))[0], 2, 'the first turn');
  f.controller.setBudget(first.id, 3);
  const next = await refused(f, first.id, 'And the tests?');
  assert.equal(next.state, 'blocked');
  // Grok Build says what a turn cost only when it ends: the stopped one cost at least the dollar it had reported.
  assert.equal(next.error?.message, STOPPED('≥$3.00', 3));
  assert.equal(spend.runCosts(next)[1], null); assert.equal(next.runs[1].stoppedAtUsd, 1);
  assert.equal(rows(next.runs[1].logFile).filter(row => row.type === 'usage').length, 2, 'it stopped after its second response');
  // The Usage tab and the session's row in elu conductor --json count it as /budget does (the
  // Kanban card shows no cost).
  const usage = spend.agentSpend([{ root: f.root, tasks: [next] }]);
  assert.equal(spend.moneyText(usage.costUsd, usage.partial, usage.runs), '≥$3.00', 'the Usage tab');
  assert.equal(spend.costText(usage.rows[0]), '≥$3.00', 'its row');
  assert.equal(String(boardRows([{ root: f.root, name: 'shop', tasks: [next], activity: [], queue: [] }]).find(row => row.id === next.id).cost), '≥$3.00', 'its row in elu conductor --json');
});

// The response that reaches the limit may be the turn's last, its answer already written: Codex
// reports that request's usage after the answer and ends the turn a moment later, and Grok Build
// ends its run a moment after its last response's usage. Such a turn keeps its answer, and the
// next message is held to the limit before it starts.
test('a Codex turn through its app-server whose last request reaches the limit keeps its answer', { timeout: 60000 }, async t => {
  // Two requests of 50 cents a turn; the turn ends a second and a half after its last.
  const f = setup(t, { appServer: 'steer', codexTurn: { requests: [HALF, HALF], liveMs: 300, endMs: 1500 } });
  f.controller.setDefaultModel({ vendor: 'codex', model: 'gpt-6.1-sol' });
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  near(spend.runCosts(readTask(f.repo, first.id))[0], 1, 'the first turn');
  // 80 cents left: the second turn's last request, after its answer, takes it to $2.00.
  f.controller.setBudget(first.id, 1.8);
  const next = await f.controller.ask('And the tests?', first.id).finished;
  assert.equal(next.state, 'answered', JSON.stringify(next.error));
  assert.ok(f.launches('codex').every(call => call.args[0] === 'app-server'), 'the turns ran through the app-server');
  near(spend.runCosts(readTask(f.repo, first.id))[1], 1, 'the second turn');
  const after = await refused(f, first.id, 'And the docs?');
  assert.equal(after.error?.message, REFUSED('$2.00', 1.8));
});

// Codex reports a thread's numbers again when only its rate limits change, as a turn that goes on
// with the thread may begin (a usage limit reached, a compaction): its total, and the last request
// it had made, the turn before's. That request is not counted again.
test("a Codex turn through its app-server does not count again the turn before's request that Codex reports again", { timeout: 60000 }, async t => {
  // Three requests of 50 cents a turn; a turn that goes on with the thread first reports the thread's numbers again.
  const f = setup(t, { appServer: 'steer', codexTurn: { requests: [HALF, HALF, HALF], liveMs: 300, resend: true } });
  f.controller.setDefaultModel({ vendor: 'codex', model: 'gpt-6.1-sol' });
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  near(spend.runCosts(readTask(f.repo, first.id))[0], 1.5, 'the first turn');
  // $1.20 left: the second turn's last request, after its answer, takes it to $3.00. Counted
  // again, the first turn's last request would have stopped it at its second.
  f.controller.setBudget(first.id, 2.7);
  const next = await f.controller.ask('And the tests?', first.id).finished;
  assert.equal(next.state, 'answered', JSON.stringify(next.error));
  assert.equal(rows(next.runs[1].logFile).filter(row => row.type === 'thread.token_usage').length, 4, 'it began with the thread\'s numbers again');
  near(spend.runCosts(next)[1], 1.5, 'the second turn');
  const after = await refused(f, first.id, 'And the docs?');
  assert.equal(after.error?.message, REFUSED('$3.00', 2.7));
});

test('a Grok Build turn that streams, whose last response reaches the limit, keeps its answer', { timeout: 60000 }, async t => {
  // One response of 50,000 input and 150,000 output tokens on grok-4.6, a dollar; the run ends a second and a half after it.
  const usage = { input_tokens: 50_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 150_000, reasoning_tokens: 0, total_tokens: 200_000 };
  const f = setup(t, { grokSpend: { usage, modelUsage: { 'grok-4.6': { inputTokens: 50_000, outputTokens: 150_000, cacheReadInputTokens: 0, modelCalls: 1 } } }, grok: { endMs: 1500 } });
  // The session starts on Claude Code (30 cents); with a $1 limit the Grok Build turn has 70 cents left.
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  f.controller.setBudget(first.id, 1); f.controller.setModel(first.id, { vendor: 'grok', model: 'grok-4.6' });
  const next = await f.controller.ask('And the tests?', first.id).finished;
  assert.equal(next.state, 'answered', JSON.stringify(next.error));
  assert.ok(f.launches('grok').at(-1).args.includes('streaming-json'), 'the turn streams');
  near(spend.runCosts(readTask(f.repo, first.id))[1], 1, 'the Grok Build turn');
  const after = await refused(f, first.id, 'And the docs?');
  assert.equal(after.error?.message, REFUSED('$1.30', 1));
});

// Grok Build's usage rows name no model. A session's record names the one it runs on
// (summary.json's current_model_id, Grok Build's guide 17-sessions.md), so the first turn of a
// session on Grok's own default model (none chosen) is priced at that one while it works.
test("a Grok Build turn that starts a session on Grok's own default model stops at the limit, priced at the model the session's record names", { timeout: 60000 }, async t => {
  const f = setup(t, { grok: { usage: Array(4).fill({ input_tokens: 100_000, output_tokens: 50_000 }), usageMs: 1000 } });
  // The session starts on Claude Code (30 cents); the next message starts a Grok Build session, $1 of the limit left.
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  f.controller.setBudget(first.id, 1.3); f.controller.setModel(first.id, { vendor: 'grok' });
  const next = await refused(f, first.id, 'And the tests?');
  assert.equal(next.state, 'blocked', JSON.stringify(next.error));
  const launch = f.launches('grok').at(-1).args;
  assert.ok(!launch.includes('--model') && !launch.includes('-r'), "a new Grok session on Grok's own model");
  assert.equal(next.error?.message, STOPPED('≥$1.30', 1.3));
  assert.equal(next.runs[1].stoppedAtUsd, 1);
  assert.equal(rows(next.runs[1].logFile).filter(row => row.type === 'usage').length, 2, 'it stopped after its second response');
});

// A session on Grok's own default model keeps the model Grok named for it, which its last run
// keeps too, so its next turn is priced at that one while it works.
test("a Grok Build turn on Grok's own default model stops at the limit, priced at the model Grok named for its session", { timeout: 60000 }, async t => {
  const f = setup(t, { grok: { usage: Array(4).fill({ input_tokens: 100_000, output_tokens: 50_000 }), usageMs: 1000 } });
  f.controller.setDefaultModel({ vendor: 'grok' });
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  assert.ok(!f.launches('grok').at(-1).args.includes('--model'), "the turn ran on Grok's own model");
  assert.equal(readTask(f.repo, first.id).runs[0].model, 'grok-4.6', 'Grok named it');
  near(spend.runCosts(readTask(f.repo, first.id))[0], 2, 'the first turn');
  f.controller.setBudget(first.id, 3);
  const next = await refused(f, first.id, 'And the tests?');
  assert.equal(next.state, 'blocked');
  assert.equal(next.error?.message, STOPPED('≥$3.00', 3));
  assert.equal(next.runs[1].stoppedAtUsd, 1);
  assert.equal(rows(next.runs[1].logFile).filter(row => row.type === 'usage').length, 2, 'it stopped after its second response');
});

for (const [name, vendor, mode, version] of [['An Antigravity', 'agy', 'full', '1.5.4'], ['A Grok Build', 'grok', 'auto', '1.0.77']]) {
  test(`${name} turn over ACP stops when the cost it reports reaches the limit`, { timeout: 60000 }, async t => {
    // Six model responses of 50 cents each, a second apart; the vendor sends the session's cost after each.
    const f = setup(t, { [vendor]: { usage: Array(6).fill({ input_tokens: 1000, output_tokens: 100, cost: 0.5 }), usageMs: 1000 } });
    proven(vendor, f.bin(vendor), version);
    // The session starts on Claude Code (30 cents); the next message goes to a new session of this vendor.
    const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: mode }).finished;
    assert.equal(first.state, 'answered', JSON.stringify(first.error));
    f.controller.setBudget(first.id, 2); f.controller.setModel(first.id, { vendor });
    const next = await refused(f, first.id, 'And the tests?');
    assert.equal(next.state, 'blocked', JSON.stringify(next.error));
    assert.equal(f.launches(vendor).at(-1).args.at(-1), vendor === 'agy' ? 'acp' : 'stdio', 'the turn ran over ACP');
    // $1.70 was left: it stopped at $2.00, after its fourth response. Its tokens come only with the turn's answer.
    assert.equal(next.error?.message, STOPPED('≥$2.30', 2));
    assert.equal(spend.runCosts(next)[1], null); assert.equal(next.runs[1].stoppedAtUsd, 2);
  });
}
