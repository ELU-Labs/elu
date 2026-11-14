import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOP_AGENTS, agentSpend, agentTable, byCost, cleanTopAgents, compact, costText, runUsage, shareText, spendText, tokensText, topAgentsWire } from '../lib/agent-spend.mjs';
import { todayCost } from '../lib/terminal.mjs';

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

test('top agents are one row per agent in a session, most cost first, today or the last seven days, and old runs count without tokens', () => {
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
    ['@lead', 'Fix the coupons', 'opus 5.5', 12.4, false],
    ['@lead', 'Old shape', 'claude', 1.1, false],
    ['@reviewer', 'Fix the coupons', 'sonnet 5', 0.3, false],
    ['@writer', 'Notes', 'claude', 0.2, false],
    ['@pair', 'Fix the coupons', 'gpt-6.1-sol', null, false],
  ]);
  assert.deepEqual(today.rows[0].tokens, { input: 1200000, output: 34000, cacheRead: 8100000, cacheWrite: 10 });
  assert.equal(today.rows[1].tokens, null, 'an old run has no tokens');
  // The spend line counts the same runs: some reported no cost, so at least.
  assert.equal(Number(today.costUsd.toFixed(2)), 14); assert.equal(today.partial, true);
  assert.equal(spendText(today), 'at least $14.00');
  assert.equal(todayCost(projects, new Date(NOW)), spendText(today), 'the spend line and the section agree');
  const week = agentSpend(projects, { now: NOW, days: 7 });
  assert.deepEqual(week.rows.slice(0, 2).map(row => [row.title, row.costUsd]), [['Last week', 50], ['Fix the coupons', 12.4]]);
  assert.ok(!week.rows.some(row => row.title === 'Too old'));
  // A row with some runs of unknown cost is at least its known cost.
  const mixed = agentSpend([{ root: '/r', tasks: [task(1, 'Mixed', [run('lead', { costUsd: 3 }), run('lead', { costUsd: null })])] }], { now: NOW });
  assert.equal(costText(mixed.rows[0]), '≥$3.00'); assert.equal(spendText(mixed), 'at least $3.00');
  // Nothing reported a cost: no number.
  const none = agentSpend([{ root: '/r', tasks: [task(1, 'Codex only', [run('lead', { vendor: 'codex', costUsd: null })])] }], { now: NOW });
  assert.equal(costText(none.rows[0]), '—'); assert.equal(spendText(none), 'not reported'); assert.equal(todayCost([], new Date(NOW)), 'not reported');
  // Tasks of any shape a state file may hold do not break it.
  assert.deepEqual(agentSpend([{ root: '/r', tasks: [{ id: '1' }, { id: '2', runs: null }, null] }], { now: NOW }).rows, []);
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
    ['id-4', '@lead', 'odd agent', '', null, null, false],
  ]);
  assert.deepEqual(clean.week, { costUsd: null, partial: false, rows: [] });
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
  // No tokens with the turn: not reported, whatever the context meter said, and never zeros.
  assert.deepEqual(runUsage('agy', log(meter, answer({ stopReason: 'end_turn' }))), { tokens: null, model: null });
  assert.deepEqual(runUsage('grok', log(answer({ stopReason: 'end_turn', _meta: { usage: { usageIsIncomplete: true } } }))), { tokens: null, model: null });
  assert.equal(tokensText(runUsage('agy', log(answer({ stopReason: 'end_turn' }))).tokens), 'not reported');
});

test('tokens read compact, costs and shares say only what was reported', () => {
  assert.deepEqual([0, 950, 1000, 1234, 9949, 9950, 34000, 999499, 999500, 1200000, 12345678, 1100000000, 25e9].map(compact), ['0', '950', '1k', '1.2k', '9.9k', '10k', '34k', '999k', '1M', '1.2M', '12M', '1.1B', '25B']);
  assert.equal(compact(-1), '—'); assert.equal(compact(NaN), '—');
  assert.equal(tokensText({ input: 1200000, output: 340000, cacheRead: 8100000, cacheWrite: 5 }), '1.2M · 340k · 8.1M');
  assert.equal(tokensText(null), 'not reported');
  assert.equal(costText({ costUsd: 12.4 }), '$12.40'); assert.equal(costText({ costUsd: null }), '—');
  assert.equal(shareText({ costUsd: 12.4 }, 97.51), '13%'); assert.equal(shareText({ costUsd: 0.1 }, 97.51), '<1%'); assert.equal(shareText({ costUsd: null }, 97.51), '—'); assert.equal(shareText({ costUsd: 1 }, 0), '—');
});

test('the table labels the cost once, and a narrow pane drops whole columns right to left without wrapping', () => {
  const rows = [
    { agent: '@lead', title: 'Make the coupon codes upper case everywhere', where: '', model: 'opus 5.5', tokens: { input: 1200000, output: 34000, cacheRead: 8100000, cacheWrite: 0 }, costUsd: 12.4, partial: false },
    { agent: '@pair', title: 'Make the coupon codes upper case everywhere', where: 'on devbox', model: 'gpt-6.1-sol', tokens: null, costUsd: null, partial: false },
  ];
  const wide = agentTable(rows, { width: 120, total: 20 });
  assert.equal(wide.length, 3);
  assert.match(wide[0], /^Agent +Session +Model +in · out · cache +Cost \(API price\) +Share$/);
  assert.match(wide[1], /^@lead +Make the coupon codes upper case everywhere +opus 5\.5 +1\.2M · 34k · 8\.1M +\$12\.40 +62%$/);
  assert.match(wide[2], /^@pair +Make the coupon .* +on devbox +gpt-6\.1-sol +not reported +— +—$/);
  assert.equal(wide.join('\n').match(/Cost \(API price\)/g).length, 1, 'the cost column is labelled once');
  const headers = width => agentTable(rows, { width, total: 20 })[0].split(/ {2,}/);
  let last = null;
  for (let width = 120; width >= 12; width--) {
    const lines = agentTable(rows, { width, total: 20 });
    assert.equal(lines.length, 3, `${width}: one line per row`);
    for (const line of lines) { assert.ok(line.length <= width, `${width}: ${JSON.stringify(line)}`); assert.ok(!line.includes('\n')); }
    // Columns only ever go from the right: what is left is always a prefix of the full set.
    // (Below 15 columns only Agent and the start of Session are left, cut at the edge.)
    const now = headers(width), full = ['Agent', 'Session', 'Model', 'in · out · cache', 'Cost (API price)', 'Share'];
    const fixed = names => names.filter(name => !name.startsWith('Sess'));
    assert.deepEqual(fixed(now), fixed(full).slice(0, fixed(now).length), `${width}: ${now}`);
    if (last) assert.ok(now.length <= last.length);
    last = now;
  }
  assert.deepEqual(headers(60), ['Agent', 'Session', 'Model', 'in · out · cache'], 'at 60 the share and the cost have gone');  assert.ok(!agentTable(rows, { width: 60, total: 20 })[1].includes('$'));
});
