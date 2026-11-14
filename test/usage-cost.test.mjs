import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.mjs';
import { agentSpend, agentTable, cleanTopAgents, costText, runCosts, topAgentsWire } from '../lib/agent-spend.mjs';

// What a run costs where its vendor reports tokens but no cost: each kind of token at the
// model's API list price (lib/prices.mjs). Every number here is made up; the log shapes are
// the ones Codex, Grok Build and Antigravity write.

const NOW = new Date(2026, 10, 14, 15, 0, 0).getTime();
const at = hours => new Date(NOW - hours * 3600000).toISOString();
const near = (actual, expected, label) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9, `${label ?? ''} ${actual} is not ${expected}`);
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const KEY = 'a1b2c3d4e5f60718';
const task = (id, title, runs) => ({ id: String(id), title, goal: title, createdAt: at(3), runs });
const projects = tasks => [{ root: '/work/shop', key: KEY, tasks }];
// Codex: input_tokens hold the cached and the written tokens. 1,200,000 = 200,000 plain + 900,000 read from the cache + 100,000 written to it.
const CODEX_USAGE = { input_tokens: 1200000, cached_input_tokens: 900000, cache_write_input_tokens: 100000, output_tokens: 50000, reasoning_output_tokens: 9000 };
function codexLog(dir, usage = CODEX_USAGE) {
  const file = path.join(dir, `codex-${Math.random().toString(36).slice(2)}.log`);
  fs.writeFileSync(file, lines([{ type: 'thread.started', thread_id: 'thread-1' }, { type: 'turn.started' }, { type: 'turn.completed', usage }]));
  return file;
}

test("a Codex run costs its model's API list price, each kind of token at its own rate, and every place that adds costs says the same", t => {
  const dir = temp(t), logFile = codexLog(dir);
  const codex = task(1, 'Fix the coupons', [{ role: 'lead', vendor: 'codex', at: at(1), asked: 'gpt-6.1-sol', logFile, code: 0, costUsd: null }]);
  // gpt-6.1-sol, per million: $2 input, $0.10 cached input, $2.50 cache write, $10 output.
  // 0.2M × $2 + 0.9M × $0.10 + 0.1M × $2.50 + 0.05M × $10 = $0.40 + $0.09 + $0.25 + $0.50.
  const spend = agentSpend(projects([codex]), { now: NOW });
  near(spend.rows[0].costUsd, 1.24, 'the row'); near(spend.costUsd, 1.24, 'the day'); assert.equal(spend.partial, false);
  assert.equal(costText(spend.rows[0]), '$1.24');
  // The written tokens are counted once: as cache writes, not as input too.
  assert.deepEqual(spend.rows[0].tokens, { input: 200000, output: 50000, cacheRead: 900000, cacheWrite: 100000 });
  // The session's cost, its budget and its stop line read runCosts; a computer of mine reads the wire.
  near(runCosts(codex)[0], 1.24, 'runCosts');
  const wire = cleanTopAgents(JSON.parse(JSON.stringify(topAgentsWire(projects([codex]), NOW))));
  near(wire.today.costUsd, 1.24, 'sent'); near(wire.today.rows[0].costUsd, 1.24, 'its row'); assert.equal(wire.today.partial, false);
  // The run as the runner keeps it, its log gone: the tokens it recorded, input as Codex counts it (written ones inside), and its model.
  const kept = task(2, 'Kept', [{ role: 'lead', vendor: 'codex', at: at(1), model: 'gpt-6.1-sol', tokens: { input: 300000, output: 50000, cacheRead: 900000, cacheWrite: 100000 }, costUsd: null }]);
  near(runCosts(kept)[0], 1.24, 'from its record');
  // A bot on another Codex model: gpt-6.1-terra is $1 / $0.05 / $1.25 / $5.
  const terra = task(3, 'Terra', [{ role: 'bot:pair', vendor: 'codex', at: at(1), asked: 'gpt-6.1-terra', logFile: codexLog(dir), costUsd: null }]);
  near(runCosts(terra)[0], 0.2 + 0.045 + 0.125 + 0.25, 'gpt-6.1-terra');
});

test('Grok Build and Antigravity runs are priced the same way, and a cost the vendor reported stands as it is', t => {
  const dir = temp(t), file = (name, text) => { const at = path.join(dir, name); fs.writeFileSync(at, text); return at; };
  // Grok Build headless, signed in with a subscription: tokens by model, no cost. grok-4.6 is $2 / $0.50 cached / $6.
  const grokLog = file('grok.log', `${JSON.stringify({ text: '{"outcome":"done","summary":"ok"}', stopReason: 'end_turn', sessionId: 's1', usage: { input_tokens: 100000, cache_read_input_tokens: 400000, cache_creation_input_tokens: 0, output_tokens: 20000 }, modelUsage: { 'grok-4.6': { inputTokens: 100000, outputTokens: 20000, cacheReadInputTokens: 400000, cacheCreationInputTokens: 0 } } })}\n`);
  const grok = task(1, 'Search', [{ role: 'lead', vendor: 'grok', at: at(1), model: 'grok-4.6', logFile: grokLog, costUsd: null }]);
  near(runCosts(grok)[0], 0.2 + 0.2 + 0.12, 'grok-4.6');
  // An API key's run reports its cost: that figure stands.
  const paid = task(2, 'Paid', [{ role: 'lead', vendor: 'grok', at: at(1), model: 'grok-4.6', logFile: grokLog, costUsd: 0.9 }]);
  near(runCosts(paid)[0], 0.9, 'its own figure');
  // Antigravity over ACP: the turn's tokens; the model as the session named it (agy names its effort too). Gemini 3.1 Pro is $2 / $0.20 / $12.
  const answer = usage => ({ jsonrpc: '2.0', id: 4, result: { stopReason: 'end_turn', usage } });
  const agyLog = file('agy.log', lines([answer({ inputTokens: 50000, outputTokens: 10000, cachedReadTokens: 200000 })]));
  const agy = task(3, 'Docs', [{ role: 'lead', vendor: 'agy', at: at(1), model: 'gemini-3.1-pro-high', logFile: agyLog, costUsd: null }]);
  near(runCosts(agy)[0], 0.1 + 0.04 + 0.12, 'gemini-3.1-pro');
  // A Claude model Antigravity runs: Claude Sonnet 4.6 is $3 / $0.30 read / $3.75 written / $15.
  const sonnetLog = file('sonnet.log', lines([answer({ inputTokens: 100000, outputTokens: 10000, cachedReadTokens: 1000000, cachedWriteTokens: 40000 })]));
  const sonnet = task(4, 'Sonnet', [{ role: 'lead', vendor: 'agy', at: at(1), model: 'claude-sonnet-4-6', logFile: sonnetLog, costUsd: null }]);
  near(runCosts(sonnet)[0], 0.3 + 0.3 + 0.15 + 0.15, 'claude-sonnet-4-6');
  const spend = agentSpend(projects([grok, paid, agy, sonnet]), { now: NOW });
  near(spend.costUsd, 0.52 + 0.9 + 0.26 + 0.9, 'the day'); assert.equal(spend.partial, false);
});

// Grok's headless guide: cost_is_partial says some calls had no cost, so Grok leaves every cost
// out; the tokens are whole. Only usage_is_incomplete says the tokens may miss some.
test('a Grok Build run whose cost Grok says is partial has every token, and is priced at list from them', t => {
  const dir = temp(t), logFile = path.join(dir, 'grok.log');
  // grok-4.6, per million: $2 input, $0.50 cached, $6 output. 100k + 40k cached in, 10k out: $0.28.
  const result = { text: '{"outcome":"done","summary":"ok"}', stopReason: 'end_turn', sessionId: 's1', cost_is_partial: true, usage: { input_tokens: 100000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0, output_tokens: 10000 }, modelUsage: { 'grok-4.6': { inputTokens: 100000, outputTokens: 10000, cacheReadInputTokens: 40000 } } };
  fs.writeFileSync(logFile, `${JSON.stringify(result)}\n`);
  const grok = task(1, 'Search', [{ role: 'lead', vendor: 'grok', at: at(1), model: 'grok-4.6', logFile, costUsd: null }]);
  near(runCosts(grok)[0], 0.28, 'grok-4.6 at list');
  const spend = agentSpend(projects([grok]), { now: NOW });
  assert.equal(costText(spend.rows[0]), '$0.28'); assert.equal(spend.partial, false);
});

test('a model with no known price shows a dash, never 0, and is left out of the total', t => {
  const dir = temp(t);
  const grokFast = { role: 'lead', vendor: 'grok', at: at(1), model: 'grok-4.6-fast', tokens: { input: 1000, output: 100, cacheRead: 5000, cacheWrite: 0 }, costUsd: null };
  // Codex on its own default model, which it did not name: no model, no price.
  const codexDefault = { role: 'bot:pair', vendor: 'codex', at: at(1), logFile: codexLog(dir), costUsd: null };
  const tasks = [
    task(1, 'Fast search', [grokFast]),
    task(2, 'Opus work', [{ role: 'lead', vendor: 'claude', at: at(1), model: 'claude-opus-5-5', costUsd: 2, ownCost: true, tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0 } }]),
    task(3, 'Pair', [codexDefault]),
  ];
  const spend = agentSpend(projects(tasks), { now: NOW });
  const row = title => spend.rows.find(item => item.title === title);
  assert.equal(row('Fast search').costUsd, null); assert.equal(costText(row('Fast search')), '—');
  assert.equal(row('Pair').costUsd, null); assert.equal(costText(row('Pair')), '—');
  assert.equal(spend.costUsd, 2); assert.equal(spend.partial, true);
  assert.deepEqual(runCosts(tasks[0]), [null]);
  const table = agentTable(spend.rows.map(item => ({ ...item, where: 'here' })), { width: 136, total: 2, foot: { label: 'Today', costUsd: spend.costUsd, partial: spend.partial, runs: spend.runs, parts: [{ name: 'here', costUsd: spend.costUsd, partial: spend.partial, runs: spend.runs }] } });
  const fast = table.rows.find(line => /Fast search/.test(line));
  assert.match(fast, / Grok 4\.6 Fast +1k +100 +5k +— +—$/);
  assert.ok(!table.rows.some(line => / \$0\.00 /.test(line)), 'no row reads $0.00');
  assert.deepEqual(table.foot, [`${' '.repeat(table.head.indexOf('Cost') + 4 - 'Today  ≥$2.00'.length)}Today  ≥$2.00`]);
});

// The rows as the Usage tab gives them: where each ran ('here' or a computer of mine).
const ROWS = [
  { agent: 'Opus 5.5', title: 'Android/iOS/Web SDK and Rollout plan', where: 'ali-devbox', model: 'opus 5.5', tokens: { input: 138, output: 73000, cacheRead: 16000000, cacheWrite: 0 }, costUsd: 9.57, partial: false, started: true },
  { agent: '@pair', title: 'Adjudicate the unreviewed session backlog', where: 'ali-devbox', model: 'gpt-6.1-sol', tokens: { input: 304000, output: 43000, cacheRead: 18000000, cacheWrite: 0 }, costUsd: 3.84, partial: false, started: true },
  { agent: 'grok-4.6', title: 'Speed up search', where: 'here', model: 'grok-4.6', tokens: { input: 120000, output: 9000, cacheRead: 2100000, cacheWrite: 0 }, costUsd: 1.34, partial: false, started: true },
  { agent: 'gemini-3.5-flash-high', title: 'Docs pass', where: 'here', model: 'gemini-3.5-flash-high', tokens: { input: 40000, output: 2000, cacheRead: 300000, cacheWrite: 0 }, costUsd: null, partial: false, started: true },
  { agent: '@reviewer', title: 'Login form', where: 'here', model: 'opus 5.5', tokens: null, costUsd: 0, partial: false, started: false },
];
const FOOT = { label: 'Today', costUsd: 14.75, partial: true, runs: 6, parts: [{ name: 'here', costUsd: 1.34, partial: true, runs: 3 }, { name: 'ali-devbox', costUsd: 13.41, partial: false, runs: 3 }] };
// The columns of a header line: each name and where it starts and ends.
const columnsOf = head => [...head.matchAll(/\S+/g)].map(match => ({ name: match[0], start: match.index, end: match.index + match[0].length }));

test('the table at 140 columns: Session, Computer, Model, In, Out, Cache, Cost, Share, each number right-aligned under its header, a rule, and one total under Cost', () => {
  const table = agentTable(ROWS, { width: 136, total: 14.75, foot: FOOT });
  const columns = columnsOf(table.head);
  assert.deepEqual(columns.map(column => column.name), ['Session', 'Computer', 'Model', 'In', 'Out', 'Cache', 'Cost', 'Share']);
  assert.match(table.rule, /^─+$/); assert.equal(table.rule.length, table.head.length);
  assert.equal(table.rows.length, ROWS.length);
  // A number's cell ends where its header ends; a name's starts where its header starts. Cells are two spaces apart.
  const cell = (line, name) => { const column = columns.find(item => item.name === name);
    return ['In', 'Out', 'Cache', 'Cost', 'Share'].includes(name) ? line.slice(0, column.end).split(/ {2,}/).at(-1).trim() : line.slice(column.start).split(/ {2,}/)[0].trim(); };
  // Numbers line up: each ends where its header ends, with room before it.
  for (const line of table.rows) {
    for (const name of ['In', 'Out', 'Cache', 'Cost', 'Share']) {
      const { end } = columns.find(column => column.name === name);
      assert.notEqual(line[end - 1] ?? ' ', ' ', `${name} ends under its header: ${line}`);
      assert.equal(line[end] ?? ' ', ' ', `${name} ends under its header: ${line}`);
    }
    for (const name of ['Computer', 'Model']) { const { start } = columns.find(column => column.name === name); assert.equal(line[start - 1], ' ', `${name} starts under its header: ${line}`); assert.notEqual(line[start], ' ', `${name}: ${line}`); }
  }
  const [opus, pair, grok, gemini, reviewer] = table.rows;
  assert.deepEqual(['Session', 'Computer', 'Model', 'In', 'Out', 'Cache', 'Cost', 'Share'].map(name => cell(opus, name)), ['Android/iOS/Web SDK and Rollout plan', 'ali-devbox', 'Opus 5.5', '138', '73k', '16M', '$9.57', '65%']);
  // A bot's run: its name leads the session. The model by its display name.
  assert.deepEqual(['Session', 'Computer', 'Model', 'In', 'Out', 'Cache', 'Cost', 'Share'].map(name => cell(pair, name)), ['@pair Adjudicate the unreviewed session backlog', 'ali-devbox', 'GPT-6.1 Sol', '304k', '43k', '18M', '$3.84', '26%']);
  assert.deepEqual(['Computer', 'Model', 'Cost'].map(name => cell(grok, name)), ['here', 'Grok 4.6', '$1.34']);
  // No known price: a dash in Cost and Share.
  assert.deepEqual(['Model', 'Cost', 'Share'].map(name => cell(gemini, name)), ['Gemini 3.5 Flash High', '—', '—']);
  assert.match(reviewer, /^@reviewer Login form \(did not start\) +here +Opus 5\.5 +— +— +— +\$0\.00 +0%$/);
  // The total ends where Cost ends; each computer's part under it.
  const costEnd = columns.find(column => column.name === 'Cost').end;
  assert.deepEqual(table.foot, ['Today  ≥$14.75', 'here ≥$1.34 · ali-devbox $13.41'].map(text => `${' '.repeat(costEnd - text.length)}${text}`));
  for (const line of [table.head, table.rule, ...table.rows, ...table.foot]) { assert.ok(line.length <= 136, line); assert.doesNotMatch(line, /not reported|API price|Agent|\bon ali-devbox/); }
});

test('the table at 80 columns drops Cache, In, Out, then Computer, keeps Session, Model, Cost and Share, and cuts the session with …', () => {
  const table = agentTable(ROWS, { width: 76, total: 14.75, foot: FOOT });
  const columns = columnsOf(table.head);
  assert.deepEqual(columns.map(column => column.name), ['Session', 'Model', 'Cost', 'Share']);
  for (const line of [table.head, table.rule, ...table.rows, ...table.foot]) assert.ok(line.length <= 76, `${line.length}: ${line}`);
  for (const line of table.rows) for (const name of ['Cost', 'Share']) { const { end } = columns.find(column => column.name === name); assert.notEqual(line[end - 1], ' ', line); assert.equal(line[end] ?? ' ', ' ', line); }
  assert.match(table.rows[1], /^@pair Adjudicate the unreviewed sessio…  +GPT-6\.1 Sol +\$3\.84 +26%$/);
  assert.match(table.rows[4], /^@reviewer Login form \(did not start\) +Opus 5\.5 +\$0\.00 +0%$/);
  const costEnd = columns.find(column => column.name === 'Cost').end;
  assert.equal(table.foot[0], `${' '.repeat(costEnd - 'Today  ≥$14.75'.length)}Today  ≥$14.75`);
  // Narrower and narrower, the columns go in that order and no line is ever wider than the pane.
  let last = null;
  for (let width = 136; width >= 12; width--) {
    const narrow = agentTable(ROWS, { width, total: 14.75, foot: FOOT }), names = columnsOf(narrow.head).map(column => column.name);
    for (const line of [narrow.head, narrow.rule, ...narrow.rows, ...narrow.foot]) assert.ok(line.length <= width, `${width}: ${line}`);
    const gone = ['Cache', 'In', 'Out', 'Computer'].filter(name => !names.includes(name));
    assert.deepEqual(gone, ['Cache', 'In', 'Out', 'Computer'].slice(0, gone.length), `${width}: ${names}`);
    if (last) assert.ok(names.length <= last.length, `${width}: ${names}`);
    last = names;
  }
});

test('one computer only: no Computer column and no line per computer', () => {
  const here = ROWS.filter(row => row.where === 'here');
  const table = agentTable(here, { width: 136, total: 1.34, foot: { label: 'Today', costUsd: 1.34, partial: true, runs: 3, parts: [{ name: 'here', costUsd: 1.34, partial: true, runs: 3 }] } });
  assert.deepEqual(columnsOf(table.head).map(column => column.name), ['Session', 'Model', 'In', 'Out', 'Cache', 'Cost', 'Share']);
  assert.equal(table.foot.length, 1); assert.match(table.foot[0], /^ +Today {2}≥\$1\.34$/);
  // The last seven days say so.
  assert.match(agentTable(here, { width: 136, total: 1.34, foot: { label: '7 days', costUsd: 1.34, partial: false, runs: 3, parts: [] } }).foot[0], /^ +7 days {2}\$1\.34$/);
});
