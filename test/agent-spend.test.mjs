import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fakeClis, temp } from './helpers.mjs';
import { TOP_AGENTS, agentSpend, agentTable, byCost, cleanTopAgents, compact, costText, modelLabel, moneyText, runSpends, runUsage, shareText, topAgentsWire } from '../lib/agent-spend.mjs';
import { usageTotal } from '../lib/terminal.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NOW = new Date(2026, 10, 12, 15, 0, 0).getTime();
const hoursAgo = hours => new Date(NOW - hours * 3600000).toISOString();
const daysAgo = days => new Date(NOW - days * 86400000).toISOString();
const run = (role, extra = {}) => ({ role, vendor: 'claude', at: hoursAgo(1), ...extra });
const task = (id, title, runs, extra = {}) => ({ id: String(id), title, goal: title, createdAt: hoursAgo(2), runs, ...extra });

test('a run records the tokens and model its vendor reported, and none where it reported none', () => {
  // Claude Code: the last result event; modelUsage counts every model the run called, and names the one that cost most.
  const claude = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }),
    JSON.stringify({ type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 1 } }),
    JSON.stringify({ type: 'result', total_cost_usd: 1.25, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
      modelUsage: { 'claude-haiku-5': { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 }, 'claude-opus-5-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40, costUSD: 1.24 } } }),
  ].join('\n');
  assert.deepEqual(runUsage('claude', claude), { tokens: { input: 15, output: 21, cacheRead: 300, cacheWrite: 40 }, model: 'claude-opus-5-5' });
  // Without modelUsage, usage alone.
  assert.deepEqual(runUsage('claude', JSON.stringify({ type: 'result', usage: { input_tokens: 6, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })).tokens, { input: 6, output: 6, cacheRead: 0, cacheWrite: 0 });
  // The recorded native stream: its result's usage.
  assert.deepEqual(runUsage('claude', fs.readFileSync(path.join(FIXTURES, 'native-claude.jsonl'), 'utf8')).tokens?.output, 6);
  // Codex: every turn, input without the cached part, which is the cache read.
  const codex = fs.readFileSync(path.join(FIXTURES, 'codex-blocked.jsonl'), 'utf8') + '\n' + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 10 } });
  assert.deepEqual(runUsage('codex', codex), { tokens: { input: 34605 - 17024 + 600, output: 612, cacheRead: 17024 + 400, cacheWrite: 0 }, model: null });
  // Grok Build: its one JSON result.
  const grok = JSON.stringify({ text: '{}', stopReason: 'end_turn', usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, output_tokens: 5 } });
  assert.deepEqual(runUsage('grok', grok), { tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0 }, model: null });
  // A streaming-json run: its end event, not the per-response usage lines before it.
  const streamed = [{ type: 'text', data: '{}' }, { type: 'usage', usage: { input_tokens: 99, output_tokens: 99 } }, { type: 'end', stopReason: 'end_turn', usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, output_tokens: 5 }, modelUsage: { 'grok-4.6': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2 } } }].map(row => JSON.stringify(row)).join('\n');
  assert.deepEqual(runUsage('grok', streamed), { tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0 }, model: 'grok-4.6' });
  // Antigravity reports none; nor does a log of noise, a negative count, or a result without usage.
  assert.deepEqual(runUsage('agy', claude), { tokens: null, model: null });
  assert.deepEqual(runUsage('claude', 'not json\n{"type":"result"}'), { tokens: null, model: null });
  assert.deepEqual(runUsage('codex', JSON.stringify({ type: 'turn.completed', usage: { input_tokens: -5 } })), { tokens: null, model: null });
  assert.deepEqual(runUsage('claude', ''), { tokens: null, model: null });
});

test('top agents are one row per agent in a session, named as the chat names them, most cost first, today or the last seven days, and old runs count without tokens', () => {
  const projects = [{ root: '/work/shop', tasks: [
    task(1, 'Fix the coupons', [
      run('lead', { costUsd: 2, model: 'claude-opus-5-5', tokens: { input: 1200, output: 340, cacheRead: 8100000, cacheWrite: 0 } }),
      run('lead', { costUsd: 10.4, model: 'claude-opus-5-5', tokens: { input: 1198800, output: 33660, cacheRead: 0, cacheWrite: 10 } }),
      run('reviewer', { costUsd: 0.3, model: 'claude-sonnet-5' }),
      run('bot:pair', { vendor: 'codex', costUsd: null, model: 'gpt-6.1-sol', tokens: { input: 5000, output: 900, cacheRead: 1000, cacheWrite: 0 } }),
    ]),
    // A run from before runs had a time counts on the day its session started; this one has no tokens and no model.
    task(2, 'Old shape', [{ role: 'lead', vendor: 'claude', costUsd: 1.1 }], { createdAt: hoursAgo(3) }),
    // Three days ago: in the last seven days, not today.
    task(3, 'Last week', [run('lead', { at: daysAgo(3), costUsd: 50 })]),
    // Eight days ago: in neither.
    task(4, 'Too old', [run('lead', { at: daysAgo(8), costUsd: 99 })]),
    // A chat with one bot: its lead is that bot.
    task(5, 'Notes', [run('lead', { costUsd: 0.2 })], { botChat: 'writer' }),
  ] }];
  const today = agentSpend(projects, { now: NOW });
  assert.deepEqual(today.rows.map(row => [row.agent, row.title, row.model, row.costUsd === null ? null : Number(row.costUsd.toFixed(2)), row.partial]), [
    // A session's own agent reads as its model, a vendor's default as the vendor; a bot as @name.
    ['Opus 5.5', 'Fix the coupons', 'opus 5.5', 12.4, false],
    ['Claude', 'Old shape', 'claude', 1.1, false],
    ['@reviewer', 'Fix the coupons', 'sonnet 5', 0.3, false],
    ['@writer', 'Notes', 'claude', 0.2, false],
    ['@pair', 'Fix the coupons', 'gpt-6.1-sol', 0.02, false],
  ]);
  assert.deepEqual(today.rows[0].tokens, { input: 1200000, output: 34000, cacheRead: 8100000, cacheWrite: 10 });
  assert.equal(today.rows[1].tokens, null, 'an old run has no tokens');
  // The Codex run reported tokens and no cost: it costs gpt-6.1-sol's list price, 5k × $2 + 1k
  // × $0.10 + 900 × $10 per million, so the day's total is known. The total under the table counts the same runs.
  assert.equal(Number(today.rows[4].costUsd.toFixed(4)), 0.0191);
  assert.equal(Number(today.costUsd.toFixed(2)), 14.02); assert.equal(today.partial, false);
  const total = usageTotal([{ name: 'here', costUsd: today.costUsd, partial: today.partial, runs: today.runs }]);
  assert.equal(agentTable(today.rows, { width: 120, total: today.costUsd, foot: total }).foot[0].trim(), 'Today  $14.02', 'the total and the section agree');
  const week = agentSpend(projects, { now: NOW, days: 7 });
  assert.deepEqual(week.rows.slice(0, 2).map(row => [row.title, row.costUsd]), [['Last week', 50], ['Fix the coupons', 12.4]]);
  assert.ok(!week.rows.some(row => row.title === 'Too old'));
  // A row with some runs of unknown cost is at least its known cost.
  const mixed = agentSpend([{ root: '/r', tasks: [task(1, 'Mixed', [run('lead', { costUsd: 3 }), run('lead', { costUsd: null })])] }], { now: NOW });
  assert.equal(costText(mixed.rows[0]), '≥$3.00'); assert.equal(moneyText(mixed.costUsd, mixed.partial, mixed.runs), '≥$3.00');
  // No cost known (no tokens to price): a dash, never $0.00; no run at all spent nothing.
  const none = agentSpend([{ root: '/r', tasks: [task(1, 'Codex only', [run('lead', { vendor: 'codex', costUsd: null })])] }], { now: NOW });
  assert.equal(costText(none.rows[0]), '—'); assert.equal(moneyText(none.costUsd, none.partial, none.runs), '—');
  const idle = agentSpend([], { now: NOW });
  assert.equal(moneyText(idle.costUsd, idle.partial, idle.runs), '$0.00'); assert.equal(usageTotal([{ name: 'here', costUsd: idle.costUsd, partial: idle.partial, runs: idle.runs }]).costUsd, 0);
  // Tasks of any shape a state file may hold do not break it.
  assert.deepEqual(agentSpend([{ root: '/r', tasks: [{ id: '1' }, { id: '2', runs: null }, null] }], { now: NOW }).rows, []);
});

// One Claude Code session that changes model: two turns on Opus, then /model sonnet and two on
// Sonnet. Each resumed turn reports the session's totals so far, one line per model: Claude Code
// (2.1.322) keeps a session's cost state with its modelUsage per model and restores it on
// --resume, so the Opus line is still there beside Sonnet's. The stand-in reports the same way.
test("a session that changes model counts each turn's own cost once: two Opus turns and two Sonnet turns add up to what they spent", t => {
  const parent = temp(t), { env } = fakeClis(parent), bin = path.join(parent, 'bin'), config = path.join(bin, 'fake.json');
  const base = JSON.parse(fs.readFileSync(config, 'utf8')), session = '5f0e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
  const OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5';
  const turns = [['opus', OPUS, [4, 1500, 52000, 9000], 0.42], ['opus', OPUS, [3, 1400, 61000, 4000], 0.42], ['sonnet', SONNET, [2, 900, 70000, 3000], 0.12], ['sonnet', SONNET, [2, 700, 74000, 1000], 0.12]];
  const results = [];
  const runs = turns.map(([alias, model, tokens, usd], index) => {
    fs.writeFileSync(config, JSON.stringify({ ...base, models: { opus: OPUS, sonnet: SONNET }, spend: { model, tokens, usd } }));
    const out = spawnSync(path.join(bin, 'claude'), ['-p', '--output-format', 'stream-json', '--verbose', '--model', alias, index ? '--resume' : '--session-id', session], { input: 'Fix the login form.', env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    const logFile = path.join(parent, `lead-${index + 1}.log`); fs.writeFileSync(logFile, out.stdout);
    const result = out.stdout.trim().split('\n').map(line => JSON.parse(line)).findLast(row => row.type === 'result'); results.push(result);
    // As 0.1.18 recorded a run: what its result said the session had spent, and its model.
    return run('lead', { session, logFile, code: 0, model, costUsd: result.total_cost_usd });
  });
  const spent = runSpends(task(1, 'Login fix solo', runs)).map(spend => Number(spend.costUsd.toFixed(2)));
  assert.deepEqual(spent, [0.42, 0.42, 0.12, 0.12], 'each turn its own cost, the first Sonnet turn too');
  assert.deepEqual(Object.keys(results[3].modelUsage).sort(), [OPUS, SONNET], 'the last turn reports both models');
  assert.equal(Number(results[3].total_cost_usd.toFixed(2)), 1.08);
  const today = agentSpend([{ root: '/work/login', tasks: [task(1, 'Login fix solo', runs)] }], { now: NOW });
  assert.equal(today.rows.length, 1, 'one row for the session');
  assert.equal(today.rows[0].model, 'opus 5.5 + sonnet 5.5'); assert.equal(Number(today.rows[0].costUsd.toFixed(2)), 1.08);
});

test('ties and unknown costs sort after known ones, and at most ten go over the wire', () => {
  const rows = [{ costUsd: null, tokens: { input: 9, output: 0, cacheRead: 0, cacheWrite: 0 }, at: 'b' }, { costUsd: 1, tokens: null, at: 'a' }, { costUsd: 1, tokens: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 }, at: 'a' }, { costUsd: 0, tokens: null, at: 'c' }];
  assert.deepEqual([...rows].sort(byCost).map(row => rows.indexOf(row)), [2, 1, 3, 0]);
  const tasks = Array.from({ length: 14 }, (_, at) => task(at + 1, `Session ${at + 1}`, [run('lead', { costUsd: at + 1 })]));
  const wire = topAgentsWire([{ root: '/r', key: 'a'.repeat(16), tasks }], NOW);
  assert.equal(wire.today.rows.length, TOP_AGENTS);
  assert.deepEqual(wire.today.rows.map(row => row.costUsd), [14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
  assert.equal(wire.today.costUsd, 105, 'the total counts every agent, not only the ten shown');
  assert.equal(wire.today.rows[0].ref, `${'a'.repeat(16)}:14`);
});

test('what a computer of mine sends is checked, and a build that sends nothing is told apart', () => {
  const sent = { today: { costUsd: 4, partial: false, rows: [
    { ref: `${'b'.repeat(16)}:3`, agent: '@lead', title: 'Fix\u001b[31m the\nbuild', model: 'Opus 5.5', tokens: { input: 10, output: 2, cacheRead: -1 }, costUsd: 4, partial: false, at: hoursAgo(1) },
    { ref: '../etc:1', agent: '@x', title: 'bad ref' },
    { ref: `${'b'.repeat(16)}:4`, agent: 'rm -rf', title: 'odd agent', costUsd: 'lots', partial: true },
  ] }, week: 'nonsense' };
  const clean = cleanTopAgents(sent, ref => `id-${ref.split(':')[1]}`);
  assert.deepEqual(clean.today.rows.map(row => [row.id, row.agent, row.title, row.model, row.tokens, row.costUsd, row.partial]), [
    ['id-3', '@lead', 'Fix the build', 'opus 5.5', { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }, 4, false],
    ['id-4', 'rm -rf', 'odd agent', '', null, null, false],
  ]);
  // A name that is neither @name nor a model's reads as Model.
  assert.equal(cleanTopAgents({ today: { rows: [{ ref: `${'b'.repeat(16)}:5`, agent: '$(x)' }] } }).today.rows[0].agent, 'Model');
  assert.deepEqual(clean.week, { costUsd: null, partial: false, runs: null, unpriced: [], rows: [] });
  assert.equal(cleanTopAgents(undefined), null); assert.equal(cleanTopAgents('x'), null);
  assert.ok(cleanTopAgents({ today: { rows: Array.from({ length: 30 }, (_, at) => ({ ref: `${'c'.repeat(16)}:${at + 1}` })) } }).today.rows.length <= TOP_AGENTS);
});

test('an ACP run records the tokens its vendor sent with the turn, however it names them, and none where it sent none', () => {
  const log = (...rows) => rows.map(row => JSON.stringify(row)).join('\n'), answer = result => ({ jsonrpc: '2.0', id: 4, result });
  const meter = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'usage_update', used: 53000, size: 200000 } } };
  // The protocol's own usage: input apart from the cache, and thought tokens are output where the total counts them apart.
  assert.deepEqual(runUsage('agy', log(meter, answer({ stopReason: 'end_turn', usage: { totalTokens: 1530, inputTokens: 1200, outputTokens: 80, thoughtTokens: 40, cachedReadTokens: 200, cachedWriteTokens: 10 } }))), { tokens: { input: 1200, output: 120, cacheRead: 200, cacheWrite: 10 }, model: null });
  assert.deepEqual(runUsage('agy', log(answer({ stopReason: 'end_turn', usage: { totalTokens: 1280, inputTokens: 1200, outputTokens: 80, thoughtTokens: 40 } }))).tokens, { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0 }, 'a total that holds the thought tokens inside the output adds none twice');
  // Grok Build: _meta.usage, whose inputTokens is the whole prompt, cache included.
  assert.deepEqual(runUsage('grok', log(answer({ stopReason: 'end_turn', _meta: { usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45, cachedReadTokens: 30, cacheCreationTokens: 4 } } }))).tokens, { input: 6, output: 5, cacheRead: 30, cacheWrite: 4 });
  // Input and output alone, under _meta.quota.
  assert.deepEqual(runUsage('agy', log(answer({ stopReason: 'end_turn', _meta: { quota: { token_count: { input_tokens: 900, output_tokens: 30 } } } }))).tokens, { input: 900, output: 30, cacheRead: 0, cacheWrite: 0 });
  // Two turns of one run add up.
  assert.deepEqual(runUsage('agy', log(answer({ stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } }), answer({ stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 2 } }))).tokens, { input: 12, output: 3, cacheRead: 0, cacheWrite: 0 });
  // No tokens with the turn: none, whatever the context meter said, and never zeros.
  assert.deepEqual(runUsage('agy', log(meter, answer({ stopReason: 'end_turn' }))), { tokens: null, model: null });
  assert.deepEqual(runUsage('grok', log(answer({ stopReason: 'end_turn', _meta: { usage: { usageIsIncomplete: true } } }))), { tokens: null, model: null });
  assert.match(agentTable([{ agent: 'Gemini 3 Flash', title: 'Docs', model: 'gemini-3-flash', tokens: runUsage('agy', log(answer({ stopReason: 'end_turn' }))).tokens, costUsd: null }], { width: 80 }).rows[0], /^Docs +Gemini 3 Flash +— +— +— +— +—$/);
});

test('tokens read compact, costs and shares say only what is known, and a model reads by its name', () => {
  assert.deepEqual([0, 950, 1000, 1234, 9949, 9950, 34000, 999499, 999500, 1200000, 12345678, 1100000000, 25e9].map(compact), ['0', '950', '1k', '1.2k', '9.9k', '10k', '34k', '999k', '1M', '1.2M', '12M', '1.1B', '25B']);
  assert.equal(compact(-1), '—'); assert.equal(compact(NaN), '—');
  assert.equal(costText({ costUsd: 12.4 }), '$12.40'); assert.equal(costText({ costUsd: null }), '—');
  assert.equal(costText({ costUsd: 2.75, partial: true, unpriced: ['codex'] }), '≥$2.75');
  assert.equal(moneyText(null, false, 0), '$0.00'); assert.equal(moneyText(null), '—');
  assert.deepEqual(['claude-opus-5-5', 'opus 5.5', 'gpt-6.1-sol', 'opus 5.5 + sonnet 5.5', 'codex', 'grok-4.6', 'gemini-3.1-pro-high', ''].map(modelLabel),
    ['Opus 5.5', 'Opus 5.5', 'GPT-6.1 Sol', 'Opus 5.5 + Sonnet 5.5', 'Codex', 'Grok 4.6', 'Gemini 3.1 Pro High', '']);
  assert.equal(shareText({ costUsd: 12.4 }, 97.51), '13%'); assert.equal(shareText({ costUsd: 0.1 }, 97.51), '<1%'); assert.equal(shareText({ costUsd: null }, 97.51), '—'); assert.equal(shareText({ costUsd: 1 }, 0), '—');
});

test('a pane too narrow for Session, Model, Cost and Share cuts the model, then drops the share and the model, keeping the cost, without wrapping', () => {
  const rows = [
    { agent: '@lead', title: 'Make the coupon codes upper case everywhere', where: 'here', model: 'opus 5.5', tokens: { input: 1200000, output: 34000, cacheRead: 8100000, cacheWrite: 0 }, costUsd: 12.4, partial: false },
    { agent: '@pair', title: 'Make the coupon codes upper case everywhere', where: 'devbox', model: 'gpt-6.1-sol', tokens: null, costUsd: null, partial: false },
  ];
  const ALL = ['Session', 'Computer', 'Model', 'In', 'Out', 'Cache', 'Cost', 'Share'], ORDER = ['Cache', 'In', 'Out', 'Computer', 'Share', 'Model'];
  // A header cut with … stands for its column.
  const headers = width => agentTable(rows, { width, total: 20 }).head.split(/ {2,}/).filter(Boolean).map(name => ALL.find(full => full === name || name.endsWith('…') && full.startsWith(name.slice(0, -1))));
  const wide = agentTable(rows, { width: 120, total: 20 });
  assert.deepEqual(headers(120), ALL);
  assert.match(wide.rows[0], /^@lead Make the coupon codes upper case everywhere +here +Opus 5\.5 +1\.2M +34k +8\.1M +\$12\.40 +62%$/);
  assert.match(wide.rows[1], /^@pair Make the coupon codes upper case everywhere +devbox +GPT-6\.1 Sol +— +— +— +— +—$/);
  assert.equal([wide.head, ...wide.rows].join('\n').match(/Cost/g).length, 1, 'the cost column is labelled once');
  let last = null;
  for (let width = 120; width >= 12; width--) {
    const table = agentTable(rows, { width, total: 20 });
    assert.equal(table.rows.length, 2, `${width}: one line per row`);
    for (const line of [table.head, table.rule, ...table.rows]) { assert.ok(line.length <= width, `${width}: ${JSON.stringify(line)}`); assert.ok(!line.includes('\n')); }
    const now = headers(width), gone = ORDER.filter(name => !now.includes(name));
    assert.deepEqual(gone, ORDER.slice(0, gone.length), `${width}: ${now}`);
    assert.ok(now.includes('Cost'), `${width}: the cost stays`); assert.match(table.rows[0], /\$12\.40( +62%)?$/, `${width}`);
    if (last) assert.ok(now.length <= last.length, `${width}: ${now}`);
    last = now;
  }
  assert.deepEqual(headers(60), ['Session', 'Model', 'Cost', 'Share']);
  assert.deepEqual(headers(20), ['Session', 'Model', 'Cost'], 'the model cut to fit, the share gone');
  assert.deepEqual(headers(12), ['Session', 'Cost']);
  assert.equal(agentTable(rows, { width: 12, total: 20 }).rows[0], '@le…  $12.40');
});
