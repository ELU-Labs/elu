import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.mjs';
import { agentSpend, agentTable, cleanTopAgents, topAgentsWire } from '../lib/agent-spend.mjs';
import * as terminal from '../lib/terminal.mjs';
import * as claude from '../lib/adapters/claude.mjs';
import { getBot, saveBot } from '../lib/bots.mjs';

// One day of a computer's sessions, as builds before 0.1.20 recorded them (task.runs and the
// Claude Code and Codex logs beside them), read on another computer of the same owner. Every
// title and number here is made up; the shapes are the ones those builds and the vendors write.

const DAY = new Date(2026, 4, 12, 0, 0, 0).getTime(), NOW = DAY + 16.5 * 3600000;
const at = hours => new Date(DAY + hours * 3600000).toISOString();
const MODELS = { opus: 'claude-opus-5-5', fable: 'claude-fable-5-2' };
// A Claude Code log: its first line, and its result. models: { opus: [in, out, cacheRead, cacheWrite, costUSD] };
// usage: the turn's own model tokens. Claude Code reports a resumed session's totals so far.
function claudeLog(file, { session, model = 'opus', total, usage, models }) {
  const tokens = ([input, output, read, write]) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write });
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: session, model: MODELS[model] }),
    JSON.stringify({ type: 'assistant', session_id: session, message: { id: 'm1', usage: tokens([1, 1, 0, 0]) } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: session, total_cost_usd: total, usage: tokens(usage),
      modelUsage: Object.fromEntries(Object.entries(models).map(([name, [input, output, read, write, cost]]) => [MODELS[name], { inputTokens: input, outputTokens: output, cacheReadInputTokens: read, cacheCreationInputTokens: write, costUSD: cost }])) }),
  ].join('\n') + '\n');
}
function records(t) {
  const dir = temp(t); let n = 0;
  const log = role => path.join(dir, `${role.replace(':', '-')}-${++n}.log`);
  // One Claude Code session on one model. Each turn is given what it used itself, [in, out,
  // cacheRead, cacheWrite, dollars]; its log reports the session's totals so far, and its run
  // is as 0.1.18 recorded it: that total as its cost, the model, no tokens. kept: as 0.1.19
  // recorded it, with the tokens the log reported, which are the session's so far too.
  const session = (id, model = 'opus') => {
    const sum = [0, 0, 0, 0, 0];
    return (role, hours, own, { kept = false } = {}) => {
      own.forEach((value, index) => { sum[index] += value; });
      const logFile = log(role);
      claudeLog(logFile, { session: id, model, total: sum[4], usage: own.slice(0, 4), models: { [model]: [...sum] } });
      return { role, vendor: 'claude', at: at(hours), session: id, logFile, code: 0, costUsd: sum[4], model: MODELS[model],
        ...(kept ? { tokens: { input: sum[0], output: sum[1], cacheRead: sum[2], cacheWrite: sum[3] }, effort: 'medium' } : {}) };
    };
  };
  // The lead bot of a team, on fable, with helpers on opus: one turn of a session of its own.
  const team = (hours, id, fable, opus) => {
    const logFile = log('bot:lead'), total = fable[4] + (opus?.[4] ?? 0);
    claudeLog(logFile, { session: id, model: 'fable', total, usage: fable.slice(0, 4), models: { fable, ...(opus ? { opus } : {}) } });
    return { role: 'bot:lead', vendor: 'claude', at: at(hours), session: id, logFile, code: 0, costUsd: total, model: MODELS.fable };
  };
  // A Codex turn: what its thread had used when it ended, [input_tokens, cached_input_tokens,
  // output_tokens], as Codex reports it; each turn goes on with the session's thread. Codex reports no cost.
  const codex = (hours, usage) => {
    const logFile = log('lead');
    fs.writeFileSync(logFile, [{ type: 'thread.started' }, { type: 'turn.started' }, { type: 'turn.completed', usage: { input_tokens: usage[0], cached_input_tokens: usage[1], cache_write_input_tokens: 0, output_tokens: usage[2] } }].map(row => JSON.stringify(row)).join('\n'));
    return { role: 'lead', vendor: 'codex', at: at(hours), session: 'codex-cart', code: 0, costUsd: null, logFile };
  };
  // The reviewer's run that never started: Claude Code refused its input ("piped stdin input exceeds 10MB").
  const refused = hours => {
    const logFile = log('bot:reviewer'); fs.writeFileSync(logFile, '');
    fs.writeFileSync(`${logFile}.stderr`, 'Error: piped stdin input exceeds 10MB. Pass large content as a file path in your prompt instead.\n');
    return { role: 'bot:reviewer', vendor: 'claude', at: at(hours), session: `review-${hours}`, logFile, code: 1, costUnknown: true };
  };
  const task = (id, title, runs, extra = {}) => ({ id: String(id), title, goal: title, createdAt: at(-30), runs, bots: ['reviewer', 'lead'], ...extra });
  const checkout = session('s-checkout'), searchA = session('s-search-a'), searchB = session('s-search-b'), cart = session('s-cart'), reset = session('s-reset'), login = session('s-login'), imageA = session('s-image-a'), imageB = session('s-image-b');
  const tasks = [
    // One session resumed across midnight: yesterday's turn is not today's, and today's turns count only what each added.
    task(1, 'Checkout page', [
      checkout('lead', -3.1, [20, 4000, 900000, 80000, 2.5]),
      checkout('lead', 3.2, [30, 6000, 1500000, 100000, 3.25]),
      checkout('lead', 4.5, [10, 1000, 200000, 50000, 0.75])]),
    // Two agents in one session: the lead bot of a team, and the session's own agent, which started a second session.
    task(2, 'Search speed', [
      team(1.3, 's-search-team', [16, 9000, 400000, 90000, 2.1], [200, 50000, 9000000, 700000, 6.4]),
      searchA('lead', 4.9, [4, 1800, 20000, 21000, 0.2]),
      searchB('lead', 5.2, [150, 80000, 12000000, 240000, 6]),
      searchB('lead', 7.1, [250, 90000, 40000000, 200000, 12.3])]),
    task(3, 'Nightly review', [
      team(0.5, 's-night-1', [12, 11000, 300000, 60000, 1.4], [100, 30000, 4000000, 300000, 2.9]),
      team(7.4, 's-night-2', [70, 50000, 5000000, 200000, 6.2], [180, 100000, 11000000, 800000, 7.7])]),
    // A model change in one session: Claude Code on opus, then Codex.
    task(4, 'Cart totals', [
      cart('lead', 0.8, [6, 1500, 40000, 24000, 0.25]),
      cart('lead', 2.2, [4, 1200, 30000, 31000, 0.3]),
      cart('lead', 2.3, [2, 700, 31000, 6000, 0.1]),
      cart('lead', 2.4, [4, 1300, 80000, 7000, 0.15]),
      cart('lead', 2.5, [30, 5000, 800000, 14000, 0.4]),
      codex(4.3, [80000, 60000, 900]), codex(4.35, [130000, 90000, 1300]), codex(6.3, [530000, 440000, 3300])], { bots: null }),
    task(5, 'Password reset email flow', [
      reset('lead', -2.2, [8, 2400, 70000, 26000, 0.3]),
      reset('lead', 0.9, [6, 3200, 60000, 33000, 0.45])], { bots: null }),
    task(6, 'Login form', [
      team(4.1, 's-login-team', [16, 7000, 280000, 57000, 1.3]),
      login('lead', 7.8, [140, 46000, 7000000, 140000, 3.5]),
      refused(7.81),
      login('lead', 15.6, [6, 1400, 150000, 130000, 1.1], { kept: true }),
      refused(15.61)]),
    task(7, 'Image upload', [
      imageA('lead', 3.6, [10, 3600, 110000, 38000, 0.4]),
      imageA('lead', 3.7, [8, 2300, 130000, 45000, 0.45]),
      imageB('lead', 3.8, [90, 21000, 2600000, 97000, 0.9]),
      imageB('lead', 5.3, [22, 7700, 1000000, 108000, 1.2]),
      imageB('lead', 6.4, [6, 1100, 240000, 5000, 0.1]),
      imageB('lead', 6.5, [6, 1100, 250000, 4600, 0.1]),
      imageB('lead', 6.6, [6, 1600, 260000, 4300, 0.15]),
      imageB('lead', 15.4, [22, 11000, 1270000, 152000, 1.7], { kept: true })], { bots: ['reviewer'] }),
  ];
  return [{ root: '/work/shop', key: 'a1b2c3d4e5f60718', tasks }];
}
// The bots saved on that computer: the reviewer runs on opus.
function bots(t) {
  const dir = temp(t), before = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = dir;
  t.after(() => { if (before === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = before; });
  saveBot({ name: 'reviewer', vendor: 'claude', model: 'opus', color: 'aqua', about: 'Reviews', instructions: 'Review the change.' }, { previous: getBot('reviewer') ? 'reviewer' : null });
}

test("a day's top agents: each agent named as the chat names it, one row per agent, each run's own cost and tokens", t => {
  bots(t);
  const today = agentSpend(records(t), { now: NOW });
  const rows = today.rows.map(row => [row.agent, row.title, row.model, row.costUsd === null ? null : Number(row.costUsd.toFixed(2)), row.tokens && [row.tokens.input, row.tokens.output, row.tokens.cacheRead]]);
  assert.deepEqual(rows, [
    // The session's own agent reads as its model, as its chat header does; a resumed turn counts only what it added.
    ['Opus 5.5', 'Search speed', 'opus 5.5', 18.5, [404, 171800, 52020000]],
    // The lead bot of a team is @lead, with what its helpers on opus spent.
    ['@lead', 'Nightly review', 'fable 5.2', 18.2, [362, 191000, 20300000]],
    ['@lead', 'Search speed', 'fable 5.2', 8.5, [216, 59000, 9400000]],
    ['Opus 5.5', 'Image upload', 'opus 5.5', 5, [170, 49400, 5860000]],
    ['Opus 5.5', 'Login form', 'opus 5.5', 4.6, [146, 47400, 7150000]],
    // Yesterday's turn of the same session is the base, not part of today.
    ['Opus 5.5', 'Checkout page', 'opus 5.5', 4, [40, 7000, 1700000]],
    ['@lead', 'Login form', 'fable 5.2', 1.3, [16, 7000, 280000]],
    // One row for the session that moved from Opus to Codex: both models, Codex's tokens counted. Codex named no model, so its cost is not known.
    ['Opus 5.5 + Codex', 'Cart totals', 'opus 5.5 + codex', 1.2, [46 + 20000 + 20000 + 50000, 9700 + 900 + 400 + 2000, 981000 + 60000 + 30000 + 350000]],
    ['Opus 5.5', 'Password reset email flow', 'opus 5.5', 0.45, [6, 3200, 60000]],
    // The reviewer never started (Claude Code refused its input): the model it was asked for, nothing spent.
    ['@reviewer', 'Login form', 'opus 5.5', 0, null],
  ]);
  const cart = today.rows.find(row => row.title === 'Cart totals'), reviewer = today.rows.find(row => row.agent === '@reviewer');
  assert.equal(cart.partial, true); assert.deepEqual(cart.unpriced, ['codex']);
  assert.equal(reviewer.started, false);
  assert.equal(Number(today.costUsd.toFixed(2)), 61.75); assert.equal(today.partial, true); assert.deepEqual(today.unpriced, ['codex']);
});

test("on another computer of mine the rows read the same, every row with a cost has tokens, a lower bound reads ≥, and the total counts that computer", t => {
  bots(t);
  const wire = cleanTopAgents(JSON.parse(JSON.stringify(topAgentsWire(records(t), NOW))), ref => `id-${ref}`);
  const rows = wire.today.rows.map(row => ({ ...row, where: 'devbox' }));
  // Nothing ran here today; devbox sent its list; the laptop is offline.
  const idle = agentSpend([], { now: NOW }), parts = [{ name: 'here', costUsd: idle.costUsd, partial: idle.partial, runs: idle.runs }, { name: 'devbox', costUsd: wire.today.costUsd, partial: wire.today.partial, runs: wire.today.runs }, { name: 'laptop', note: 'offline' }];
  const total = terminal.usageTotal(parts);
  const wide = agentTable(rows, { width: 136, total: total.costUsd, foot: total });
  assert.match(wide.head, /^Session +Computer +Model +In +Out +Cache +Cost +Share$/);
  const line = name => wide.rows.find(row => row.includes(name));
  assert.match(wide.rows[0], /^Search speed +devbox +Opus 5\.5 +404 +172k +52M +\$18\.50 +30%$/);
  assert.match(line('Checkout page'), /^Checkout page +devbox +Opus 5\.5 +40 +7k +1\.7M +\$4\.00 +6%$/);
  assert.match(line('Cart totals'), /^Cart totals +devbox +Opus 5\.5 \+ Codex +90k +13k +1\.4M +≥\$1\.20 +2%$/);
  assert.match(line('@reviewer'), /^@reviewer Login form \(did not start\) +devbox +Opus 5\.5 +— +— +— +\$0\.00 +0%$/);
  assert.ok(!wide.rows.some(row => /@lead Checkout page/.test(row)), 'no @lead for a solo agent');
  assert.equal(wide.rows.filter(row => /Search speed/.test(row)).length, 2, 'two agents in Search speed: the session\'s own and the @lead bot');
  assert.ok(wide.rows.some(row => /^@lead Search speed +devbox +Fable 5\.2 /.test(row)));
  // The total: every computer shown, at least that as Codex's cost is not known, and each one's part.
  assert.deepEqual(wide.foot.map(text => text.trim()), ['Today  ≥$61.75', 'here $0.00 · devbox ≥$61.75 · laptop offline']);
  // 80 columns: Cache, In, Out and Computer go; the session, the model, the cost and the share stay.
  const narrow = agentTable(rows, { width: 76, total: total.costUsd, foot: total });
  assert.match(narrow.head, /^Session +Model +Cost +Share$/);
  for (const row of [narrow.head, narrow.rule, ...narrow.rows, ...narrow.foot]) assert.ok(row.length <= 76, row);
  assert.match(narrow.rows.find(row => row.startsWith('Cart totals')), /^Cart totals +Opus 5\.5 \+ Codex +≥\$1\.20 +2%$/);
  assert.equal(narrow.rows.filter(row => / ?Search speed /.test(row)).length, 2); assert.ok(narrow.rows.some(row => /^Login form +Opus 5\.5 /.test(row)));
  assert.match(narrow.rows.find(row => row.startsWith('@reviewer')), /\(did not start\) +Opus 5\.5 +\$0\.00 +0%$/);
  // Before devbox sends its list, the total counts what is known and names it.
  assert.deepEqual(terminal.usageTotal([parts[0], { name: 'devbox', note: 'waiting' }]), { label: 'Today', costUsd: 0, partial: false, runs: 0, parts: [parts[0], { name: 'devbox', note: 'waiting' }] });
});

test("today on a computer of mine is the viewer's today: runs before the viewer's midnight are yesterday's", t => {
  bots(t);
  // The viewer's day started 15 hours into that computer's: only the runs after it count.
  const wire = topAgentsWire(records(t), NOW, DAY + 15 * 3600000);
  assert.deepEqual(wire.today.rows.map(row => [row.agent, row.title, Number(row.costUsd.toFixed(2))]), [['Opus 5.5', 'Image upload', 1.7], ['Opus 5.5', 'Login form', 1.1], ['@reviewer', 'Login form', 0]]);
  assert.equal(wire.week.rows.length, 10);
});

test('a review Claude Code refuses for its input size is too long, so it is given a smaller shape', () => {
  assert.equal(claude.classify('', { stderr: 'Error: piped stdin input exceeds 10MB. Pass large content as a file path in your prompt instead.\n' }), 'too-long');
  assert.equal(claude.classify('', { stderr: 'Error: something else' }), 'unknown');
  assert.equal(claude.classify(''), 'unknown');
});
