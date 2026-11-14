import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { temp, project, fakeClis, autoApprove } from './helpers.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import * as spend from '../lib/agent-spend.mjs';
import { boardRows } from '../lib/board.mjs';
import { stopLine } from '../lib/stop-line.mjs';
import { Conductor } from '../lib/conductor.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { usageTotal } from '../lib/terminal.mjs';

// What a run cost by itself, wherever a session's runs are added up: its budget, its stop
// line, its row and its reply to a teammate. Claude Code reports what a whole session has spent
// when a turn resumes it, and builds before 0.1.20 kept that total as the run's cost.

const OPUS = 'claude-opus-5-5', AT = '2026-05-12T10:00:00.000Z';
const tokens = ([input, output, read, write]) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write });
const counted = ([input, output, cacheRead, cacheWrite]) => ({ input, output, cacheRead, cacheWrite });
// A Claude Code log. own: the turn's own tokens; so far: the session's, [in, out, cacheRead, cacheWrite, dollars].
const claudeRows = (session, own, soFar) => [
  { type: 'system', subtype: 'init', session_id: session, model: OPUS },
  { type: 'assistant', session_id: session, message: { id: 'msg_1', model: OPUS, usage: tokens(own) } },
  ...(soFar ? [{ type: 'result', subtype: 'success', is_error: false, session_id: session, total_cost_usd: soFar[4], usage: tokens(own),
    modelUsage: { [OPUS]: { inputTokens: soFar[0], outputTokens: soFar[1], cacheReadInputTokens: soFar[2], cacheCreationInputTokens: soFar[3], costUSD: soFar[4] } } }] : []),
];
function logs(t) {
  const dir = temp(t);
  return (name, rows) => { const file = path.join(dir, name); fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')); return file; };
}
const rounded = values => values.map(value => value === null ? null : Number(value.toFixed(2)));

test('runs recorded before 0.1.20 cost what each added, in the helper, a Sessions row and the stop line', t => {
  const log = logs(t);
  // One Claude Code session resumed twice: its results report 2, then 4.5, then 6 dollars so far,
  // and 0.1.19 kept each as that run's cost. Between them a review that never started (kept
  // with no cost) and a Codex turn, which reports none.
  const runs = [
    { role: 'lead', vendor: 'claude', at: AT, session: 'launch-1', code: 0, costUsd: 2, model: OPUS, logFile: log('lead-1.log', claudeRows('s-1', [10, 100, 1000, 50], [10, 100, 1000, 50, 2])) },
    { role: 'lead', vendor: 'claude', at: AT, session: 'launch-2', launch: 'launch-2', code: 0, costUsd: 4.5, model: OPUS, logFile: log('lead-2.log', claudeRows('s-1', [20, 200, 2000, 60], [30, 300, 3000, 110, 4.5])) },
    { role: 'bot:reviewer', vendor: 'claude', at: AT, session: 'launch-3', code: 1, costUnknown: true, logFile: log('bot-reviewer-3.log', []) },
    { role: 'lead', vendor: 'codex', at: AT, session: 'launch-4', code: 0, costUsd: null, logFile: log('lead-4.log', [{ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 9 } }]) },
    { role: 'lead', vendor: 'claude', at: AT, session: 'launch-5', launch: 'launch-5', code: 0, costUsd: 6, model: OPUS, logFile: log('lead-5.log', claudeRows('s-1', [5, 50, 500, 15], [35, 350, 3500, 125, 6])) },
  ];
  const task = { id: '1', goal: 'Checkout page', title: 'Checkout page', kind: 'conversation', state: 'answered', createdAt: AT, messages: [{ at: AT, text: 'Checkout page' }], result: { summary: 'Done.' }, runs };
  assert.deepEqual(rounded(spend.runCosts(task)), [2, 2.5, 0, null, 1.5]);
  // The session's row: six dollars, at least that as Codex reported none. Each total added up was 12.50.
  const [row] = boardRows([{ name: 'shop', root: '/work/shop', activity: [], queue: [], tasks: [task] }], Date.parse(AT) + 60000);
  assert.equal(String(row.cost), '≥$6.00');
  // The stop line: six dollars have not spent a $7 limit, so it was the account's own limit that stopped the turn.
  const stopped = { ...task, state: 'blocked', budgetUsd: 7, error: { message: 'The model could not finish.', cause: 'quota' } }, read = { logCause: () => null, account: () => null };
  assert.equal(stopLine(stopped, read).text, 'The model could not finish: the account hit its usage limit. Switch account in Usage, then type continue.');
  assert.equal(stopLine({ ...stopped, budgetUsd: 6 }, read).text, 'This session has spent its $6 limit. /budget 20 raises it, then type continue.');
  // A record that already holds a run's own cost is taken as it is, and no log is read for it.
  assert.deepEqual(spend.runCosts({ runs: [{ role: 'lead', vendor: 'claude', at: AT, ownCost: true, costUsd: 0.4, logFile: '/nowhere.log' }, { role: 'lead', vendor: 'claude', at: AT, ownCost: true, costUnknown: true, logFile: '/nowhere.log' }] }, () => { throw new Error('read'); }), [0.4, null]);
  assert.deepEqual(spend.runCosts(null), []); assert.deepEqual(spend.runCosts({ runs: [null, 'x'] }), [null, null]);
});

// Antigravity and Grok Build over ACP send a turn's tokens with its answer. They count where
// every run's spend is worked out: from the run's record, and from its log for a run recorded
// without them. Neither vendor reports a cost: a run that named its model costs that model's
// list price, and one that named none has no known cost.
test("a run over ACP counts the tokens its vendor sent with the turn where runs are added up, at its model's list price", t => {
  const log = logs(t), answer = result => ({ jsonrpc: '2.0', id: 4, result });
  const runs = [
    { role: 'lead', vendor: 'agy', at: AT, code: 0, costUsd: null, model: 'gemini-3-flash', tokens: counted([1200, 120, 200, 10]), logFile: log('lead-1.log', [answer({ stopReason: 'end_turn', usage: { inputTokens: 1200, outputTokens: 120, cachedReadTokens: 200, cachedWriteTokens: 10 } })]) },
    { role: 'lead', vendor: 'agy', at: AT, code: 0, costUsd: null, logFile: log('lead-2.log', [answer({ stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 2 } })]) },
    { role: 'lead', vendor: 'grok', at: AT, code: 0, costUsd: null, logFile: log('lead-3.log', [answer({ stopReason: 'end_turn', _meta: { usage: { inputTokens: 40, outputTokens: 5, cachedReadTokens: 30 } } })]) },
    // A turn whose answer carried no tokens reports none, never zeros.
    { role: 'lead', vendor: 'agy', at: AT, code: 0, costUsd: null, logFile: log('lead-4.log', [answer({ stopReason: 'end_turn' })]) },
  ];
  const task = { id: '1', goal: 'Checkout page', createdAt: AT, runs };
  assert.deepEqual(spend.runSpends(task).map(row => row.tokens), [counted([1200, 120, 200, 10]), counted([7, 2, 0, 0]), counted([10, 5, 30, 0]), null]);
  // gemini-3-flash, per million: $0.50 input and cache write, $0.05 cached, $3 output.
  const costs = spend.runCosts(task);
  near(costs[0], (1200 * 0.5 + 200 * 0.05 + 10 * 0.5 + 120 * 3) / 1e6, 'gemini-3-flash'); assert.deepEqual(costs.slice(1), [null, null, null]);
  // The Usage tab's row adds them up: at least the priced run's cost.
  const [row] = spend.agentSpend([{ root: '/work/shop', tasks: [task] }], { now: Date.parse(AT) + 60000 }).rows;
  assert.deepEqual(row.tokens, counted([1217, 127, 230, 10])); near(row.costUsd, costs[0]); assert.equal(row.partial, true); assert.equal(spend.costText(row), '≥$0.00');
});

// Grok Build's spend covers every turn a run made and none of an earlier run of its session, so
// a run that resumed a session reports its own. A count Grok says may miss a model call is
// shown, and not priced: its cost is not known.
test("a Grok Build run that resumed its session counts what it reported, and a count Grok says may be incomplete is not priced", t => {
  const log = logs(t), answer = result => ({ jsonrpc: '2.0', id: 4, result }), session = 'grok-session-1';
  const headless = (usage, extra = {}) => [{ text: '{}', stopReason: 'end_turn', sessionId: session, usage, ...extra }];
  const runs = [
    { role: 'lead', vendor: 'grok', at: AT, session, code: 0, costUsd: null, model: 'grok-4.6', logFile: log('lead-1.log', headless({ input_tokens: 100_000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 0, output_tokens: 20_000 })) },
    { role: 'lead', vendor: 'grok', at: AT, session, code: 0, costUsd: null, model: 'grok-4.6', logFile: log('lead-2.log', headless({ input_tokens: 50_000, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0, output_tokens: 10_000 })) },
    { role: 'lead', vendor: 'grok', at: AT, session, code: 0, costUsd: null, model: 'grok-4.6', logFile: log('lead-3.log', headless({ input_tokens: 50_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1_000 }, { usage_is_incomplete: true })) },
    { role: 'lead', vendor: 'grok', at: AT, session, code: 0, costUsd: null, model: 'grok-4.6', logFile: log('lead-4.log', [answer({ stopReason: 'end_turn', _meta: { usage: { inputTokens: 40, outputTokens: 5, cachedReadTokens: 30, usageIsIncomplete: true } } })]) },
  ];
  const task = { id: '1', goal: 'Search speed', createdAt: AT, runs };
  // grok-4.6, per million: $2 input, $0.50 cached, $6 output.
  const costs = spend.runCosts(task);
  near(costs[0], 0.52, 'first'); near(costs[1], 0.26, 'second, its own'); assert.deepEqual(costs.slice(2), [null, null]);
  assert.deepEqual(spend.runSpends(task).slice(2).map(row => row.tokens), [counted([50_000, 1_000, 0, 0]), counted([10, 5, 30, 0])]);
});

// Codex reports what its thread has used so far: each turn.completed holds the thread's total,
// begun from the thread's own record when a run resumes it. A session's next message resumes
// its thread, so a run that resumed it used its total less the total of the run before it on
// that thread. Three runs whose own requests cost about 2, 4 and 6 dollars report about 2, 6
// and 12: 20 dollars where they spent 12.
const THREAD = '019a1b2c-3d4e-7f00-8a00-000000000001';
const codexRows = (thread, [input, cached, output, write = 0], extra = {}) => [{ type: 'thread.started', thread_id: thread, ...extra }, { type: 'turn.completed', usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write, output_tokens: output, reasoning_output_tokens: 0 } }];
// gpt-6.1-sol, per million: $2 input, $0.10 cached, $2.50 cache write, $10 output. tokens as Codex
// counts them: input holds the cache write.
const solCost = ({ input, output, cacheRead, cacheWrite }) => ((input - cacheWrite) * 2 + cacheRead * 0.1 + cacheWrite * 2.5 + output * 10) / 1e6;
const priced = tokens => ({ ...tokens, input: tokens.input - tokens.cacheWrite });

test("a Codex thread that later runs resume counts what each run used once, on today's records and on those 0.1.25 kept", t => {
  const log = logs(t);
  // The thread's totals after each run, [input (the cached ones in it), cached, output, cache write].
  const totals = [[1_000_000, 100_000, 10_000, 50_000], [3_000_000, 300_000, 30_000, 150_000], [6_000_000, 600_000, 60_000, 300_000]];
  const own = [counted([900_000, 10_000, 100_000, 50_000]), counted([1_800_000, 20_000, 200_000, 100_000]), counted([2_700_000, 30_000, 300_000, 150_000])];
  // As 0.1.25 recorded them: the thread's total as each run's tokens, the thread as its session.
  const runs = totals.map((total, at) => ({ role: 'lead', vendor: 'codex', at: AT, session: THREAD, code: 0, costUsd: null, model: 'gpt-6.1-sol', tokens: counted([total[0] - total[1], total[2], total[1], total[3]]), logFile: log(`lead-${at + 1}.log`, codexRows(THREAD, total)) }));
  const task = { id: '1', goal: 'Checkout page', title: 'Checkout page', kind: 'conversation', state: 'answered', createdAt: AT, messages: [{ at: AT, text: 'Checkout page' }], result: { summary: 'Done.' }, runs };
  assert.deepEqual(spend.runSpends(task).map(row => row.tokens), own.map(priced));
  spend.runCosts(task).forEach((cost, at) => near(cost, solCost(own[at]), `run ${at + 1}`)); near(solCost(own[0]), 1.935, 'the first run');
  // With their logs gone, the totals the records kept are taken less the one before them.
  const gone = { ...task, runs: runs.map(run => ({ ...run, logFile: path.join(path.dirname(run.logFile), 'gone.log') })) };
  spend.runCosts(gone).forEach((cost, at) => near(cost, solCost(own[at]), `run ${at + 1}, its log gone`));
  // The session's row, the Usage tab and the stop line add the three runs' own spend up once: 11.61, not 19.35.
  const [row] = spend.agentSpend([{ root: '/work/shop', tasks: [task] }], { now: Date.parse(AT) + 60000 }).rows;
  assert.deepEqual(row.tokens, counted([5_100_000, 60_000, 600_000, 300_000])); near(row.costUsd, 11.61, 'the row');
  assert.equal(String(boardRows([{ name: 'shop', root: '/work/shop', activity: [], queue: [], tasks: [task] }], Date.parse(AT) + 60000)[0].cost), '$11.61');
  const stopped = { ...task, state: 'blocked', budgetUsd: 15, error: { message: 'The model could not finish.', cause: 'quota' } }, read = { logCause: () => null, account: () => null };
  assert.equal(stopLine(stopped, read).text, 'The model could not finish: the account hit its usage limit. Switch account in Usage, then type continue.');
  // A run lib/codex-live.mjs ran names its model on thread.started, and counts the same way.
  const live = runs.map((run, at) => ({ ...run, model: undefined, tokens: undefined, logFile: log(`live-${at + 1}.log`, codexRows(THREAD, totals[at], { model: 'gpt-6.1-sol' })) }));
  assert.deepEqual(spend.runSpends({ ...task, runs: live }).map(spent => [spent.model, spent.tokens]), own.map(tokens => ['gpt-6.1-sol', priced(tokens)]));
  // A run on another thread starts its own count, and so does one whose total went down: Codex began counting again.
  const other = [runs[0], { ...runs[1], session: 'another', logFile: log('lead-other.log', codexRows('019a1b2c-3d4e-7f00-8a00-000000000002', totals[1])) }];
  assert.deepEqual(spend.runSpends({ ...task, runs: other }).map(spent => spent.tokens.output), [10_000, 30_000]);
  const reset = [runs[1], { ...runs[0], logFile: log('lead-reset.log', codexRows(THREAD, [2_000_000, 100_000, 5_000])) }];
  assert.deepEqual(spend.runSpends({ ...task, runs: reset }).map(spent => spent.tokens.output), [30_000, 5_000]);
  // A run recorded since runs keep their own share holds it, and the thread's total beside it: no
  // log is read for it, and a run after it on the thread counts from that total.
  const kept = [{ ...runs[0], ownCost: true, tokens: own[0], logFile: '/nowhere.log' }, { ...runs[1], ownCost: true, tokens: own[1], sessionTokens: counted([2_700_000, 30_000, 300_000, 150_000]), logFile: '/nowhere.log' }, { ...runs[2], logFile: '/nowhere.log' }];
  assert.deepEqual(spend.runSpends({ ...task, runs: kept }).map(spent => spent.tokens.output), [10_000, 20_000, 30_000]);
});

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// A project whose stand-in Claude Code uses, each turn, ten input, 200 output, 3,000 cached
// and 400 cache-write tokens and 30 cents, and reports them as the real one does.
const EACH = { model: OPUS, tokens: [10, 200, 3000, 400], usd: 0.3 };
function setup(t, mode) {
  const p = project(t), fake = fakeClis(p.parent, { mode, models: { opus: OPUS } }), config = path.join(fake.dir, 'fake.json');
  const set = values => fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), ...values }));
  set({ spend: EACH });
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  const turns = () => (fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(JSON.parse) : []).filter(call => call.vendor === 'claude' && call.args.includes('-p'));
  return { ...p, controller, repo: controller.repo, turns, set };
}
const valueOf = (args, flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const near = (value, wanted, text) => assert.ok(Math.abs(value - wanted) < 1e-6, `${text ?? 'value'}: ${value}, not ${wanted}`);
async function until(check, text, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return; await sleep(25); }
  throw new Error(`Timed out waiting for ${text}`);
}

test("a session's budget is spent once by a session that goes on over several turns, on today's records and on those from before 0.1.20", async t => {
  const f = setup(t, 'answer');
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished, id = first.id;
  f.controller.setBudget(id, 1);
  await f.controller.ask('And the tests?', id).finished; await f.controller.ask('And the docs?', id).finished;
  const turns = f.turns();
  assert.equal(turns.length, 3); assert.ok(turns[1].args.includes('--resume') && turns[2].args.includes('--resume'), 'each later turn resumes the session');
  // What is left of the dollar: 70 cents for the second turn, 40 for the third.
  near(Number(valueOf(turns[1].args, '--max-budget-usd')), 0.7, 'second turn'); near(Number(valueOf(turns[2].args, '--max-budget-usd')), 0.4, 'third turn');
  let task = readTask(f.repo, id);
  // Each run keeps its own 30 cents and tokens; beside it, what its session reported so far.
  assert.deepEqual(rounded(task.runs.map(run => run.costUsd)), [0.3, 0.3, 0.3]); assert.deepEqual(rounded(task.runs.map(run => run.sessionCostUsd ?? null)), [null, 0.6, 0.9]);
  assert.ok(task.runs.every(run => run.ownCost === true)); assert.deepEqual(task.runs.map(run => run.tokens), Array(3).fill(counted(EACH.tokens)));
  near(f.controller.budget(id).spent, 0.9, 'spent');
  // The same three runs as 0.1.19 recorded them: the session's total as each run's cost, the session's tokens, no mark.
  task.runs = task.runs.map(({ ownCost, sessionCostUsd, tokens: own, ...run }, at) => ({ ...run, costUsd: sessionCostUsd ?? run.costUsd, tokens: counted(EACH.tokens.map(value => value * (at + 1))) }));
  saveTask(f.repo, task);
  assert.deepEqual(rounded(readTask(f.repo, id).runs.map(run => run.costUsd)), [0.3, 0.6, 0.9]);
  near(f.controller.budget(id).spent, 0.9, 'spent, on records from before 0.1.20');
  // The fourth turn may spend the 10 cents left. (Adding the three totals up made 1.80: over the limit, and refused.)
  const fourth = await f.controller.ask('And the changelog?', id).finished;
  assert.equal(fourth.state, 'answered', JSON.stringify(fourth.error));
  near(Number(valueOf(f.turns()[3].args, '--max-budget-usd')), 0.1, 'fourth turn');
  // A reply to a teammate says what the turns it took cost: all four here, 1.20.
  new Conductor().outbox({ controller: f.controller, taskId: id, runsBefore: 0, root: f.repo.root, requestId: 'request-1', origin: { peer: 'p', name: 'sara', kind: 'ask' } }, null, AT);
  near(JSON.parse(fs.readFileSync(peerFile('outbox', 'request-1.json'), 'utf8')).costUsd, 1.2, 'reply');
});

test('a session on Codex whose thread goes on over several turns spends each turn once, and its budget is not used up early', async t => {
  const f = setup(t, 'answer');
  // Each Codex turn makes one request: 10,000 cached input tokens and 99,900 output, a dollar at
  // gpt-6.1-sol's list price. The stand-in reports the thread's total, as Codex does.
  f.set({ codexTurn: { requests: [{ input_tokens: 10_000, cached_input_tokens: 10_000, output_tokens: 99_900 }] } });
  const home = path.join(f.parent, 'codex-home'); environment(t, { CODEX_HOME: home });
  f.controller.setDefaultModel({ vendor: 'codex', model: 'gpt-6.1-sol' });
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished, id = first.id;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  f.controller.setBudget(id, 5);
  for (const text of ['And the tests?', 'And the docs?']) { const next = await f.controller.ask(text, id).finished; assert.equal(next.state, 'answered', JSON.stringify(next.error)); }
  const execs = fs.readFileSync(path.join(f.parent, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.vendor === 'codex' && call.args[0] === 'exec');
  assert.deepEqual(execs.map(call => call.args[1] === 'resume'), [false, true, true], 'each later turn resumes the thread');
  const task = readTask(f.repo, id), thread = task.sessions.lead.id;
  assert.ok(execs.slice(1).every(call => call.args[2] === thread));
  // Codex reported one, two and three dollars' worth: what the thread had used so far. Each run keeps its own dollar's worth.
  const each = counted([0, 99_900, 10_000, 0]);
  assert.deepEqual(task.runs.map(run => [run.vendor, run.tokens]), Array(3).fill(['codex', each]));
  // Beside it, the thread's total, which the next run on the thread counts from.
  assert.deepEqual(task.runs.map(run => run.sessionTokens?.output ?? null), [null, 199_800, 299_700]);
  assert.ok(task.runs.every(run => run.ownCost === true));
  spend.runCosts(task).forEach((cost, at) => near(cost, 1, `run ${at + 1}`));
  near(f.controller.budget(id).spent, 3, 'spent');
  // The stop line: three dollars have not spent the $5 limit.
  const read = { logCause: () => null, account: () => null };
  assert.equal(stopLine({ ...task, state: 'blocked', error: { message: 'The model could not finish.', cause: 'quota' } }, read).text, 'The model could not finish: the account hit its usage limit. Switch account in Usage, then type continue.');
  // The next turn, on Claude Code, may spend the two dollars left. (Six dollars would be over the limit, and refused.)
  f.controller.setModel(id, { vendor: 'claude' });
  const fourth = await f.controller.ask('And the changelog?', id).finished;
  assert.equal(fourth.state, 'answered', JSON.stringify(fourth.error));
  near(Number(valueOf(f.turns().at(-1).args, '--max-budget-usd')), 2, 'the Claude Code turn');
  // Usage: the three Codex turns once, three dollars, and the Claude Code turn's 30 cents.
  const [row] = spend.agentSpend([{ root: f.repo.root, tasks: [readTask(f.repo, id)] }], { now: Date.now() }).rows;
  assert.deepEqual(row.tokens, counted([10, 299_900, 33_000, 400])); near(row.costUsd, 3.3, 'the row'); assert.equal(row.partial, false);
  // A reply to a teammate says what the turns it took cost: all four here.
  new Conductor().outbox({ controller: f.controller, taskId: id, runsBefore: 0, root: f.repo.root, requestId: 'request-2', origin: { peer: 'p', name: 'sara', kind: 'ask' } }, null, AT);
  near(JSON.parse(fs.readFileSync(peerFile('outbox', 'request-2.json'), 'utf8')).costUsd, 3.3, 'reply');
});

// A log longer than 16MB is read at its end, and the thread a Codex run went on with is named on
// its first line (thread.started). When the run ends its record still names ELU's own launch id,
// so the thread comes from that first line, else from the thread the run resumed.
test('a Codex run whose log is longer than ELU reads whole still counts only its own share of the thread it went on with', async t => {
  const f = setup(t, 'answer');
  f.set({ codexTurn: { requests: [{ input_tokens: 10_000, cached_input_tokens: 10_000, output_tokens: 99_900 }] } });
  environment(t, { CODEX_HOME: path.join(f.parent, 'codex-home') });
  f.controller.setDefaultModel({ vendor: 'codex', model: 'gpt-6.1-sol' });
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished, id = first.id;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  // The second turn prints 17MB before its answer.
  f.set({ codexTurn: { requests: [{ input_tokens: 10_000, cached_input_tokens: 10_000, output_tokens: 99_900 }], printed: 17 * 1024 * 1024 } });
  const next = await f.controller.ask('And the tests?', id).finished;
  assert.equal(next.state, 'answered', JSON.stringify(next.error));
  const task = readTask(f.repo, id);
  assert.ok(fs.statSync(task.runs[1].logFile).size > 16 * 1024 * 1024, 'the second log is longer than 16MB');
  // Each run keeps its own dollar's worth, not the thread's two.
  assert.deepEqual(task.runs.map(run => run.tokens), Array(2).fill(counted([0, 99_900, 10_000, 0])));
  spend.runCosts(task).forEach((cost, at) => near(cost, 1, `run ${at + 1}`));
});

test('a Codex run whose log names no thread counts from the thread it resumed', t => {
  const log = logs(t), totals = [[1_000_000, 100_000, 10_000, 50_000], [3_000_000, 300_000, 30_000, 150_000]];
  const runs = [
    { role: 'lead', vendor: 'codex', at: AT, session: THREAD, code: 0, costUsd: null, model: 'gpt-6.1-sol', logFile: log('lead-1.log', codexRows(THREAD, totals[0])) },
    // As the runner reads it when it ends: its record names ELU's launch id, and its log only the thread's total.
    { role: 'lead', vendor: 'codex', at: AT, session: 'launch-2', code: 0, costUsd: null, model: 'gpt-6.1-sol', logFile: log('lead-2.log', codexRows(THREAD, totals[1]).slice(1)) },
  ];
  const spent = spend.ownRunSpend(runs, 1, index => spend.logSpend(runs[index].logFile, runs[index].vendor), { thread: THREAD });
  assert.deepEqual(spent.tokens, counted([1_800_000, 20_000, 200_000, 100_000]));
});

// A Codex run started with no model runs on Codex's own default, which plain `codex exec`
// names nowhere in what it prints: only Codex's record of the thread names it (turn_context).
test("a Codex run on Codex's own default model is named by Codex's record of its thread, and priced", async t => {
  const f = setup(t, 'answer');
  f.set({ codexTurn: { requests: [{ input_tokens: 10_000, cached_input_tokens: 10_000, output_tokens: 99_900 }], model: 'gpt-6.1-sol' } });
  environment(t, { CODEX_HOME: path.join(f.parent, 'codex-home') });
  f.controller.setDefaultModel({ vendor: 'codex' });
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  const [exec] = fs.readFileSync(path.join(f.parent, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.vendor === 'codex' && call.args[0] === 'exec');
  assert.ok(!exec.args.includes('--model'), "started on Codex's own default");
  const task = readTask(f.repo, first.id);
  assert.equal(task.runs[0].model, 'gpt-6.1-sol');
  near(spend.runCosts(task)[0], 1, 'its list price');
  const [row] = spend.agentSpend([{ root: f.repo.root, tasks: [task] }], { now: Date.now() }).rows;
  assert.deepEqual([row.model, spend.costText(row)], ['gpt-6.1-sol', '$1.00']);
});

// OpenAI bills a request whose prompt is over 272K tokens at its long-context rate, every token
// of it. Codex's record of the thread says how big each request's prompt was.
test('a Codex request over 272K tokens costs the long-context rate, on each run of its thread', async t => {
  const f = setup(t, 'answer');
  // Each turn: a request of 100K, one of exactly 272K, and one of 400K (100K of it read from the cache, 50K written).
  f.set({ codexTurn: { requests: [{ input_tokens: 100_000, output_tokens: 10_000 }, { input_tokens: 272_000, output_tokens: 1_000 }, { input_tokens: 400_000, cached_input_tokens: 100_000, cache_write_input_tokens: 50_000, output_tokens: 20_000 }] } });
  environment(t, { CODEX_HOME: path.join(f.parent, 'codex-home') });
  f.controller.setDefaultModel({ vendor: 'codex', model: 'gpt-6.1-terra' });
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished, id = first.id;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  f.controller.setBudget(id, 10);
  const next = await f.controller.ask('And the tests?', id).finished;
  assert.equal(next.state, 'answered', JSON.stringify(next.error));
  const task = readTask(f.repo, id);
  // The 400K request is each run's long part, its input as Codex counts it (the written part in it).
  assert.deepEqual(task.runs.map(run => run.longTokens), Array(2).fill(counted([300_000, 20_000, 100_000, 50_000])));
  // gpt-6.1-terra, per million: $1 input and $5 output up to 272K; $2 input, $0.10 cached, $2.50 written and $7.50 output over it.
  const each = (372_000 * 1 + 11_000 * 5) / 1e6 + (250_000 * 2 + 100_000 * 0.1 + 50_000 * 2.5 + 20_000 * 7.5) / 1e6;
  spend.runCosts(task).forEach((cost, at) => near(cost, each, `run ${at + 1}`));
  near(f.controller.budget(id).spent, 2 * each, 'spent');
  const [row] = spend.agentSpend([{ root: f.repo.root, tasks: [task] }], { now: Date.now() }).rows;
  near(row.costUsd, 2 * each, 'the row');
});

// A headless Antigravity run ends with the tokens of its turns (agy -p --output-format json).
test('a headless Antigravity run keeps the tokens its result reports, priced at the model it was started with', async t => {
  const f = setup(t, 'answer');
  // 1M input, 100k output and 100k thinking, 200k read from the cache: every count apart in the total.
  f.set({ agy: { headlessUsage: { input_tokens: 1_000_000, output_tokens: 100_000, thinking_tokens: 100_000, cache_read_tokens: 200_000, total_tokens: 1_400_000 } } });
  f.controller.setDefaultModel({ vendor: 'agy', model: 'gemini-3-flash' });
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  const task = readTask(f.repo, first.id);
  assert.deepEqual(task.runs.map(run => [run.vendor, run.tokens]), [['agy', counted([1_000_000, 200_000, 200_000, 0])]]);
  // gemini-3-flash, per million: $0.50 input, $0.05 cached, $3 output (thinking is output).
  near(spend.runCosts(task)[0], 0.5 + 0.01 + 0.6, 'its list price');
});

// Grok Build says when its count may miss some of a run's calls (usage_is_incomplete). The run
// keeps that mark with its tokens, so once its log is gone it is still not priced as a whole count.
test('a Grok Build run whose count Grok says may be incomplete keeps that mark, and reads the same once its log is gone', async t => {
  const f = setup(t, 'answer');
  fs.mkdirSync(path.join(f.parent, '.grok')); fs.writeFileSync(path.join(f.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
  // 100k in, 40k read from the cache, 10k out: $0.28 at grok-4.6's list price, were the count whole.
  f.set({ grokSpend: { usage: { input_tokens: 100_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0, output_tokens: 10_000, reasoning_tokens: 0, total_tokens: 150_000 }, modelUsage: { 'grok-4.6': { inputTokens: 100_000, outputTokens: 10_000, cacheReadInputTokens: 40_000, modelCalls: 3 } }, extra: { usage_is_incomplete: true } } });
  f.controller.setDefaultModel({ vendor: 'grok', model: 'grok-4.6' });
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  const task = readTask(f.repo, first.id);
  assert.deepEqual(task.runs.map(run => [run.vendor, run.tokens, run.incomplete]), [['grok', counted([100_000, 10_000, 40_000, 0]), true]]);
  const read = () => { const [spent] = spend.runSpends(readTask(f.repo, first.id)); return [spent.costUsd, spent.incomplete ?? false]; };
  assert.deepEqual(read(), [null, true], 'not priced as a whole count');
  fs.rmSync(task.runs[0].logFile);
  assert.deepEqual(read(), [null, true], 'its log gone, the same');
});

test('a turn the owner stops is kept with what it had used; Usage shows it, and counts it once when its session goes on', async t => {
  const f = setup(t, 'slow');
  const run = f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' });
  const live = () => { try { return readTask(f.repo, run.id); } catch { return null; } };
  await until(() => { const log = live()?.activeLog; return log && fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('"assistant"'); }, 'the turn to report its tokens');
  await f.controller.stop(run.id); await assert.rejects(run.finished);
  let task = readTask(f.repo, run.id);
  // No run ended, so task.runs holds none; the stopped turn is kept apart with its log, its vendor session, when it started, the model it was asked for,
  // the model its first line named and its tokens so far.
  assert.equal(task.runs.length, 0); assert.equal(task.stops?.length, 1);
  const [stop] = task.stops, named = valueOf(f.turns()[0].args, '--session-id');
  assert.deepEqual({ ...stop, startedAt: null, at: null, logFile: null }, { role: 'lead', vendor: 'claude', logFile: null, session: named, startedAt: null, at: null, asked: 'opus', model: OPUS, tokens: counted(EACH.tokens) });
  assert.ok(fs.existsSync(stop.logFile) && Date.parse(stop.startedAt) <= Date.parse(stop.at));
  // Usage: its tokens under the model its first line named, and no cost, which Claude Code says only when a turn ends: a dash.
  const usage = () => spend.agentSpend([{ root: f.repo.root, tasks: [readTask(f.repo, run.id)] }], { now: Date.now() });
  let today = usage();
  assert.deepEqual(today.rows.map(row => [row.agent, row.tokens, row.costUsd, row.started, row.unpriced]), [['Opus 5.5', counted(EACH.tokens), null, true, ['claude']]]);
  assert.equal(spend.costText(today.rows[0]), '—'); assert.equal(today.runs, 1); assert.deepEqual(today.unpriced, ['claude']);
  // It does not use up the session's budget: the next turn may spend all of it.
  f.controller.setBudget(run.id, 1); assert.equal(f.controller.budget(run.id).spent, 0);
  // Where the stopped session cannot be picked up again (its record is taken away here, as when a
  // vendor never said its id), the next message starts a new Claude Code session, whose
  // result holds its own 30 cents only. The stopped turn stays a spend of its own, so the
  // session's row has the tokens of both and a cost that is at least 30 cents.
  { const { interrupted, ...kept } = readTask(f.repo, run.id); assert.equal(interrupted?.lead?.id, named, 'the stop kept the session to pick up'); saveTask(f.repo, kept); }
  f.set({ mode: 'answer' });
  const next = await f.controller.ask('continue', run.id).finished;
  assert.equal(next.state, 'answered', JSON.stringify(next.error)); assert.equal(valueOf(f.turns().at(-1).args, '--resume'), undefined); near(Number(valueOf(f.turns().at(-1).args, '--max-budget-usd')), 1, 'the turn after a stop');
  task = readTask(f.repo, run.id);
  assert.deepEqual(rounded(task.runs.map(run => run.costUsd)), [0.3]); assert.equal(task.stops[0].counted, undefined);
  const times = count => counted(EACH.tokens.map(value => value * count)), shown = () => usage().rows.map(row => [row.tokens, Number(row.costUsd.toFixed(2)), row.partial, row.unpriced]);
  assert.deepEqual(shown(), [[times(2), 0.3, true, ['claude']]]); assert.equal(usage().runs, 2);
  // A later turn of that session is stopped: it had resumed the session, so it is kept with that session's id.
  const session = task.sessions.lead.id; f.set({ mode: 'slow' });
  const second = f.controller.ask('And the tests?', run.id);
  await until(() => { const log = live()?.activeLog; return log && fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('"assistant"'); }, 'the second turn to report its tokens');
  await f.controller.stop(run.id); await assert.rejects(second.finished);
  task = readTask(f.repo, run.id);
  assert.equal(valueOf(f.turns().at(-1).args, '--resume'), session); assert.deepEqual(task.stops.map(stop => stop.session), [named, session]);
  assert.deepEqual(shown(), [[times(3), 0.3, true, ['claude']]]); near(f.controller.budget(run.id).spent, 0.3, 'spent');
  // The session goes on: Claude Code reports what it has spent so far, the stopped turn's 30 cents
  // with it. They are in that run's own cost now, and the stopped turn is not added a second time.
  f.set({ mode: 'answer' });
  const third = await f.controller.ask('continue', run.id).finished;
  assert.equal(third.state, 'answered', JSON.stringify(third.error)); assert.equal(valueOf(f.turns().at(-1).args, '--resume'), session); near(Number(valueOf(f.turns().at(-1).args, '--max-budget-usd')), 0.7, 'the turn after the second stop');
  task = readTask(f.repo, run.id);
  assert.deepEqual(rounded(task.runs.map(run => run.costUsd)), [0.3, 0.6]); assert.deepEqual(task.runs[1].tokens, times(2)); near(task.runs[1].sessionCostUsd, 0.9, 'the session so far');
  assert.deepEqual(task.stops.map(stop => stop.counted === true), [false, true]);
  // Four turns were started; the row has the tokens of all four once, and 90 cents: at least that, as the first stopped turn's cost was never reported.
  assert.deepEqual(shown(), [[times(4), 0.9, true, ['claude']]]); assert.equal(usage().runs, 3); near(f.controller.budget(run.id).spent, 0.9, 'spent');
  // One model, one row.
  assert.deepEqual(usage().rows.map(row => [row.agent, row.model]), [['Opus 5.5', 'opus 5.5']]);
  // A turn stopped before it said which model it ran on reads as the one this session's runs reported for the name it was asked for, not as a second model.
  const unnamed = { ...task, stops: task.stops.map(({ model, ...kept }) => kept) };
  assert.deepEqual(spend.agentSpend([{ root: f.repo.root, tasks: [unnamed] }], { now: Date.now() }).rows.map(row => [row.agent, row.model]), [['Opus 5.5', 'opus 5.5']]);
  // Alone, with no run of the session to say it, it is named as it was asked for.
  assert.deepEqual(spend.agentSpend([{ root: f.repo.root, tasks: [{ ...unnamed, runs: [], stops: unnamed.stops.slice(0, 1) }] }], { now: Date.now() }).rows.map(row => row.agent), ['Opus']);
});

test('a first turn the owner stops is picked up by the next message in its own Claude Code session, and what it spent is counted once, in that run', async t => {
  const f = setup(t, 'slow');
  const run = f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' });
  const live = () => { try { return readTask(f.repo, run.id); } catch { return null; } };
  await until(() => { const log = live()?.activeLog; return log && fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('"assistant"'); }, 'the turn to report its tokens');
  await f.controller.stop(run.id); await assert.rejects(run.finished);
  const named = valueOf(f.turns()[0].args, '--session-id');
  assert.deepEqual(readTask(f.repo, run.id).stops.map(stop => [stop.session, stop.counted]), [[named, undefined]]);
  // The next message goes on in the stopped session. Claude Code's result holds what that session has spent so far, the stopped turn's 30 cents with this turn's own.
  f.set({ mode: 'answer' }); f.controller.setBudget(run.id, 1);
  const next = await f.controller.ask('continue', run.id).finished;
  assert.equal(next.state, 'answered', JSON.stringify(next.error)); assert.equal(valueOf(f.turns().at(-1).args, '--resume'), named); near(Number(valueOf(f.turns().at(-1).args, '--max-budget-usd')), 1, 'the turn after a stop');
  const task = readTask(f.repo, run.id);
  assert.deepEqual(rounded(task.runs.map(run => run.costUsd)), [0.6]); assert.deepEqual(task.stops.map(stop => stop.counted === true), [true]);
  // Usage: two turns were started; the row has the tokens of both once and 60 cents, all of it reported.
  const today = spend.agentSpend([{ root: f.repo.root, tasks: [task] }], { now: Date.now() });
  assert.deepEqual(today.rows.map(row => [row.agent, row.tokens, Number(row.costUsd.toFixed(2)), row.partial, row.unpriced]), [['Opus 5.5', counted(EACH.tokens.map(value => value * 2)), 0.6, false, []]]);
  assert.equal(today.runs, 1); near(f.controller.budget(run.id).spent, 0.6, 'spent');
});

test("a stopped turn's spend is taken as counted only when the numbers of its session's next result say so", t => {
  const log = logs(t), stop = { role: 'lead', vendor: 'claude', at: AT, session: 's-1', tokens: counted([10, 100, 1000, 50]), logFile: log('lead-1.log', claudeRows('s-1', [10, 100, 1000, 50], null)) };
  const after = (name, own, soFar) => ({ role: 'lead', vendor: 'claude', at: '2026-05-12T11:00:00.000Z', session: 'launch-2', code: 0, logFile: log(name, claudeRows('s-1', own, soFar)) });
  const rows = task => spend.agentSpend([{ root: '/work/shop', tasks: [task] }], { now: Date.parse(AT) + 2 * 3600000 }).rows.map(row => [row.tokens, row.costUsd, row.partial, row.unpriced]);
  // Claude Code kept the stopped turn's spend: the session's totals are more than the next turn's own by at least what the stopped turn had reported.
  const kept = { id: '1', title: 'Checkout page', createdAt: AT, stops: [{ ...stop }], runs: [after('lead-2.log', [20, 200, 2000, 60], [30, 330, 3000, 110, 1.5])] };
  const run = spend.ownRunSpend(kept.runs, 0, index => spend.logSpend(kept.runs[index].logFile, 'claude'));
  assert.equal(run.session, 's-1'); assert.deepEqual(run.beyond, counted([10, 130, 1000, 50]));
  assert.deepEqual(spend.stopsCounted(kept.stops, run), [kept.stops[0]]);
  kept.stops[0].counted = true; Object.assign(kept.runs[0], { ownCost: true, costUsd: run.costUsd, tokens: run.tokens });
  assert.deepEqual(rows(kept), [[counted([30, 330, 3000, 110]), 1.5, false, []]]);
  // Claude Code did not: the next result holds exactly that turn's own. The stopped turn stays a spend of its own, its cost not reported.
  const lost = { id: '2', title: 'Search speed', createdAt: AT, stops: [{ ...stop }], runs: [after('lead-3.log', [20, 200, 2000, 60], [20, 200, 2000, 60, 1])] };
  const exact = spend.ownRunSpend(lost.runs, 0, index => spend.logSpend(lost.runs[index].logFile, 'claude'));
  assert.equal(exact.beyond, null); assert.deepEqual(spend.stopsCounted(lost.stops, exact), []);
  assert.deepEqual(rows(lost), [[counted([30, 300, 3000, 110]), 1, true, ['claude']]]);
  // Another session's result, or one that grew by less than the stopped turn had reported, says nothing about it.
  assert.deepEqual(spend.stopsCounted([{ ...stop, session: 's-9' }], run), []);
  assert.deepEqual(spend.stopsCounted([{ ...stop, tokens: counted([10, 100, 5000, 50]) }], run), []);
  // A run whose log ends before its result (a crash, a time limit) shows the tokens it had reported.
  const cut = { id: '3', title: 'Cart totals', createdAt: AT, runs: [{ role: 'lead', vendor: 'claude', at: AT, session: 'launch-4', code: 1, costUnknown: true, logFile: log('lead-4.log', claudeRows('s-4', [7, 70, 700, 7], null)) }] };
  assert.deepEqual(rows(cut), [[counted([7, 70, 700, 7]), null, false, ['claude']]]);
  // What the runner keeps of a stopped turn: its model and the tokens its log holds. One stopped before
  // its vendor wrote anything spent nothing, and Usage leaves it out.
  assert.deepEqual(spend.stoppedSpend(stop.logFile, 'claude'), { model: OPUS, tokens: counted([10, 100, 1000, 50]) });
  assert.deepEqual(spend.stoppedSpend(log('lead-5.log', []), 'claude'), { started: false });
  assert.deepEqual(rows({ id: '4', title: 'Login form', createdAt: AT, runs: [], stops: [{ role: 'lead', vendor: 'claude', at: AT, session: 's-5', started: false, logFile: log('lead-6.log', []) }] }), []);
});

test('an agent that did not start stays in the top ten on a busy day, and the cheapest that ran gives way', t => {
  const log = logs(t), now = Date.parse(AT) + 3600000;
  const session = id => ({ id: String(id), title: `Job ${id}`, createdAt: AT, runs: [{ role: 'lead', vendor: 'claude', at: AT, ownCost: true, costUsd: id, model: OPUS, tokens: counted([1, 2, 3, 4]) }] });
  // Twelve sessions that cost 1 to 12 dollars, and a review Claude Code refused before it started.
  const refused = { id: '20', title: 'Refused review', createdAt: AT, runs: [{ role: 'bot:reviewer', vendor: 'claude', at: AT, code: 1, costUnknown: true, asked: 'opus', logFile: log('bot-reviewer-1.log', []) }] };
  const projects = [{ root: '/work/shop', key: 'a1b2c3d4e5f60718', tasks: [...Array.from({ length: 12 }, (_, at) => session(at + 1)), refused] }];
  const all = spend.agentSpend(projects, { now }).rows;
  assert.equal(all.length, 13); assert.equal(all.at(-1).started, false);
  const shown = spend.topRows(all);
  assert.deepEqual(shown.map(row => row.title), ['Job 12', 'Job 11', 'Job 10', 'Job 9', 'Job 8', 'Job 7', 'Job 6', 'Job 5', 'Job 4', 'Refused review']);
  assert.match(spend.agentTable(shown, { width: 130, total: 78 }).rows.at(-1), /^@reviewer Refused review \(did not start\) +Opus 5\.5 +— +— +— +\$0\.00 +0%$/);
  // What a computer of mine sends is chosen the same way.
  assert.deepEqual(spend.topAgentsWire(projects, now).today.rows.map(row => row.title).slice(-2), ['Job 4', 'Refused review']);
  // Nothing failed: the ten that cost most, as before.
  assert.deepEqual(spend.topRows(all.filter(row => row.started)).map(row => row.title).at(-1), 'Job 3');
});

// What 0.1.19 does with the rows another computer sends (its cleanTopAgents, as published).
function cleanAs019(value) {
  const text = (item, max) => String(item ?? '').replace(/\s+/g, ' ').slice(0, max).trim(), money = item => Number.isFinite(item) && item >= 0 ? item : null;
  const period = item => ({ costUsd: money(item.costUsd), partial: item.partial === true && money(item.costUsd) !== null, rows: item.rows.slice(0, 10).filter(row => /^[0-9a-f]{16}:[1-9][0-9]{0,9}$/.test(row.ref ?? '')).map(row => {
    const agent = text(row.agent, 31).replace(/[^@A-Za-z0-9_-]/g, '');
    return { ref: row.ref, agent: /^@[A-Za-z0-9_-]{1,30}$/.test(agent) ? agent : '@lead', title: text(row.title, 80), model: text(row.model, 24).toLowerCase(), tokens: spend.cleanTokens(row.tokens), costUsd: money(row.costUsd), partial: row.partial === true && money(row.costUsd) !== null };
  }) });
  return { today: period(value.today), week: period(value.week) };
}

test('two computers on different builds: 0.1.20 says which one counts the old way, and what it sends reads whole on 0.1.19', t => {
  const now = Date.parse(AT) + 3600000;
  const projects = [{ root: '/work/shop', key: 'a1b2c3d4e5f60718', tasks: [{ id: '1', title: 'Checkout page', createdAt: AT, runs: [{ role: 'lead', vendor: 'claude', at: AT, ownCost: true, costUsd: 1.5, model: OPUS, tokens: counted([1, 2, 3, 4]) }, { role: 'bot:lead', vendor: 'claude', at: AT, ownCost: true, costUsd: 0.5, model: OPUS, tokens: counted([1, 2, 3, 4]) }] }] }];
  const sent = JSON.parse(JSON.stringify(spend.topAgentsWire(projects, now)));
  // 0.1.20 says its numbers are each run's own; a viewer on 0.1.20 reads that.
  assert.equal(sent.own, true); assert.equal(spend.cleanTopAgents(sent).own, true);
  // A computer on 0.1.19 sends no such word: its costs are each session's total added up again for every turn.
  const older = { today: { costUsd: 9, partial: false, rows: [{ ref: `${'a'.repeat(16)}:3`, agent: '@lead', title: 'Search speed', model: 'opus 5.5', tokens: null, costUsd: 9, partial: false, at: AT }] }, week: { costUsd: 9, partial: false, rows: [] } };
  const there = spend.cleanTopAgents(older);
  assert.equal(there.own, false);
  // Usage says so beside that computer's part of the total under the table.
  const here = spend.agentSpend(projects, { now }), part = (name, period, extra = {}) => ({ name, costUsd: period.costUsd, partial: period.partial, runs: period.runs, ...extra });
  const foot = parts => spend.agentTable(here.rows, { width: 100, total: 2, foot: usageTotal(parts) }).foot.map(line => line.trim());
  assert.deepEqual(foot([part('here', here), part('devbox', there.today, { old: true })]), ['Today  $11.00', 'here $2.00 · devbox $9.00 (older ELU)']);
  assert.deepEqual(foot([part('here', here), part('devbox', spend.cleanTopAgents(sent).today)]), ['Today  $4.00', 'here $2.00 · devbox $2.00']);
  // A viewer on 0.1.19 keeps every row a 0.1.20 computer sends, with its cost and tokens; the session's own agent reads @lead there.
  const read = cleanAs019(sent);
  assert.deepEqual(read.today.rows.map(row => [row.agent, row.title, row.model, row.costUsd, row.tokens]), [['@lead', 'Checkout page', 'opus 5.5', 1.5, counted([1, 2, 3, 4])], ['@lead', 'Checkout page', 'opus 5.5', 0.5, counted([1, 2, 3, 4])]]);
  assert.equal(read.today.costUsd, 2);
});
