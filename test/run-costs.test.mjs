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
import { spendLine } from '../lib/terminal.mjs';

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

test('a turn the owner stops is kept with what it had used; Usage shows it, and counts it once when its session goes on', async t => {
  const f = setup(t, 'slow');
  const run = f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' });
  const live = () => { try { return readTask(f.repo, run.id); } catch { return null; } };
  await until(() => { const log = live()?.activeLog; return log && fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('"assistant"'); }, 'the turn to report its tokens');
  await f.controller.stop(run.id); await assert.rejects(run.finished);
  let task = readTask(f.repo, run.id);
  // No run ended, so task.runs holds none; the stopped turn is kept apart with its log, its vendor session, the model it was asked for and its tokens so far.
  assert.equal(task.runs.length, 0); assert.equal(task.stops?.length, 1);
  const [stop] = task.stops, named = valueOf(f.turns()[0].args, '--session-id');
  assert.deepEqual({ ...stop, at: null, logFile: null }, { role: 'lead', vendor: 'claude', logFile: null, session: named, at: null, asked: 'opus', tokens: counted(EACH.tokens) });
  assert.ok(fs.existsSync(stop.logFile) && Number.isFinite(Date.parse(stop.at)));
  // Usage: its tokens, and no cost, which Claude Code says only when a turn ends. The line under the table says so.
  const usage = () => spend.agentSpend([{ root: f.repo.root, tasks: [readTask(f.repo, run.id)] }], { now: Date.now() });
  let today = usage();
  assert.deepEqual(today.rows.map(row => [row.agent, row.tokens, row.costUsd, row.started, row.unpriced]), [['Opus', counted(EACH.tokens), null, true, ['claude']]]);
  assert.equal(spend.costText(today.rows[0]), 'not reported'); assert.equal(today.runs, 1); assert.deepEqual(today.unpriced, ['claude']);
  // It does not use up the session's budget: the next turn may spend all of it.
  f.controller.setBudget(run.id, 1); assert.equal(f.controller.budget(run.id).spent, 0);
  // The next message starts a new Claude Code session (the stopped one never said its id), whose
  // result holds its own 30 cents only. The stopped turn stays a spend of its own, so the
  // session's row has the tokens of both and a cost that is at least 30 cents.
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
  // The stopped turn never said which model it ran on: it reads as the one this session's runs reported for the name it was asked for, not as a second model.
  assert.deepEqual(usage().rows.map(row => [row.agent, row.model]), [['Opus 5.5', 'opus 5.5']]);
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
  assert.match(spend.agentTable(shown, { width: 130, total: 78 }).at(-1), /^@reviewer +Refused review +opus 5\.5 +did not start +\$0\.00 +0%$/);
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
  // Usage says so under the table, and beside that computer's part of the spend line.
  assert.equal(spend.OLD_COUNT('devbox'), 'devbox: older ELU, its costs may be too high. Update ELU there.');
  const here = spend.agentSpend(projects, { now });
  assert.equal(spendLine([{ name: 'this computer', spend: here }, { name: 'devbox', spend: there.today, old: true }]), 'ELU spend today $11.00: this computer $2.00, devbox $9.00 (older ELU)');
  assert.equal(spendLine([{ name: 'this computer', spend: here }, { name: 'devbox', spend: spend.cleanTopAgents(sent).today }]), 'ELU spend today $4.00: this computer $2.00, devbox $2.00');
  // A viewer on 0.1.19 keeps every row a 0.1.20 computer sends, with its cost and tokens; the session's own agent reads @lead there.
  const read = cleanAs019(sent);
  assert.deepEqual(read.today.rows.map(row => [row.agent, row.title, row.model, row.costUsd, row.tokens]), [['@lead', 'Checkout page', 'opus 5.5', 1.5, counted([1, 2, 3, 4])], ['@lead', 'Checkout page', 'opus 5.5', 0.5, counted([1, 2, 3, 4])]]);
  assert.equal(read.today.costUsd, 2);
});
