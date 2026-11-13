import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.mjs';
import { agentSpend, agentTable, cleanTopAgents, topAgentsWire } from '../lib/agent-spend.mjs';
import * as terminal from '../lib/terminal.mjs';
import * as claude from '../lib/adapters/claude.mjs';
import { getBot, saveBot } from '../lib/bots.mjs';

// The owner's Usage tab on his Mac showed "Top agents today" of his devbox: every session's
// agent as @lead, tokens for two rows only, two rows each for Testing Agent and Chat/MCP/Slack,
// @reviewer as "claude" with no cost, "≥$3.12" with no reason, and "ELU spend today not
// reported" under $149 of agents. These are his devbox's records of that day, as its runs
// wrote them (task.json runs and the Claude Code and Codex logs), with the numbers they hold.

const DAY = new Date(2026, 10, 13, 0, 0, 0).getTime(), NOW = DAY + 17.7 * 3600000;
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
function devboxRecords(t) {
  const dir = temp(t); let n = 0;
  const log = (role, data) => { const file = path.join(dir, `${role.replace(':', '-')}-${++n}.log`); if (data === '') fs.writeFileSync(file, ''); else if (typeof data === 'string') fs.writeFileSync(file, data); else claudeLog(file, data); return file; };
  // A run as 0.1.18 recorded it: the cost Claude Code reported, the model, no tokens.
  const run = (role, hours, data, extra = {}) => ({ role, vendor: 'claude', at: at(hours), session: data.session, logFile: log(role, data), code: 0, costUsd: data.total, model: MODELS[data.model ?? 'opus'], ...extra });
  const codex = (hours, usage) => ({ role: 'lead', vendor: 'codex', at: at(hours), session: '01a1d338', code: 0, costUsd: null,
    logFile: log('lead', [{ type: 'thread.started' }, { type: 'turn.started' }, { type: 'turn.completed', usage: { input_tokens: usage[0], cached_input_tokens: usage[1], cache_write_input_tokens: 0, output_tokens: usage[2] } }].map(row => JSON.stringify(row)).join('\n')) });
  // The reviewer's run that never started: Claude Code refused its input ("piped stdin input exceeds 10MB").
  const refused = hours => { const file = log('bot:reviewer', ''); fs.writeFileSync(`${file}.stderr`, 'Error: piped stdin input exceeds 10MB. Pass large content as a file path in your prompt instead.\n'); return { role: 'bot:reviewer', vendor: 'claude', at: at(hours), session: `rev-${hours}`, logFile: file, code: 1, costUnknown: true }; };
  const task = (id, title, runs, extra = {}) => ({ id: String(id), title, goal: title, createdAt: at(-30), runs, bots: ['reviewer', 'lead'], ...extra });
  const tasks = [
    task(3, 'ELU Issues', [
      run('lead', -2.7, { session: '95a24808', total: 5.3842792, usage: [34, 11066, 3218307, 225405], models: { opus: [102, 34497, 5522456, 448680, 5.3842792] } }),
      run('lead', 4.4, { session: '95a24808', total: 8.4864434, usage: [36, 12419, 4148561, 252991], models: { opus: [138, 46916, 9671017, 701671, 8.4864434] } }),
      run('lead', 5.57, { session: '95a24808', total: 10.6654922, usage: [4, 1236, 261884, 262742], models: { opus: [142, 48152, 9932901, 964413, 10.6654922] } }),
      run('lead', 5.84, { session: '95a24808', total: 10.8567714, usage: [6, 1090, 532796, 7862], models: { opus: [148, 49242, 10465697, 972275, 10.8567714] } }),
      run('lead', 5.88, { session: '95a24808', total: 10.9812402, usage: [4, 667, 270604, 7124], models: { opus: [152, 49909, 10736301, 979399, 10.9812402] } }),
      run('lead', 5.97, { session: '95a24808', total: 11.1109378, usage: [4, 890, 277728, 7042], models: { opus: [156, 50799, 11014029, 986441, 11.1109378] } })]),
    task(5, 'Native replay e2e handoff', [
      run('lead', -2.74, { session: '390aac32', total: 0.2722544, usage: [8, 2391, 74132, 26197], models: { opus: [8, 2391, 74132, 26197, 0.2722544] } }),
      run('lead', 0.87, { session: '390aac32', total: 0.6191622, usage: [6, 3218, 64459, 33704], models: { opus: [14, 5609, 138591, 59901, 0.6191622] } })], { bots: null }),
    task(6, 'Testing Agent', [
      run('bot:lead', 1, { session: '6ff9affb', model: 'fable', total: 12.8538574, usage: [18, 19661, 475052, 133758], models: { fable: [18, 19661, 475052, 133758, 3.022], opus: [284, 71647, 12758120, 1169287, 9.8318574] } }),
      run('lead', 4.78, { session: 'f0724458', total: 0.2222186, usage: [4, 1865, 21833, 22567], models: { opus: [4, 1865, 21833, 22567, 0.2222186] } }),
      run('lead', 5.12, { session: '074b98af', total: 7.1339468, usage: [188, 93353, 16220074, 252765], models: { opus: [188, 93353, 16220074, 252765, 7.1339468] } }),
      run('lead', 7.06, { session: '074b98af', total: 22.7794616, usage: [262, 99421, 59781074, 212479], models: { opus: [450, 192774, 76001148, 465244, 22.7794616] } })]),
    task(7, 'Self Healing', [
      run('bot:lead', 0.62, { session: 'e475e753', model: 'fable', total: 4.762853, usage: [14, 11886, 315095, 66096], models: { fable: [14, 11886, 315095, 66096, 1.596], opus: [124, 30589, 4876875, 315819, 3.166853] } }),
      run('bot:lead', 7.5, { session: '8497226e', model: 'fable', total: 16.086573, usage: [74, 55809, 5402785, 235940], models: { fable: [74, 55809, 5402785, 235940, 7.089], opus: [206, 117574, 12595625, 825319, 8.997573] } })]),
    task(8, 'Chat/MCP/Slack', [
      run('bot:lead', 4.16, { session: '89832dba', model: 'fable', total: 1.2530434, usage: [16, 6996, 280337, 57313], models: { fable: [16, 6996, 280337, 57313, 1.2530434] } }),
      run('lead', 7.76, { session: '393fede2', total: 3.4875286, usage: [148, 46064, 7258803, 139237], models: { opus: [148, 46064, 7258803, 139237, 3.4875286] } }),
      refused(7.761),
      // 0.1.19 kept tokens: the totals Claude Code reported, the session's so far.
      run('lead', 17.48, { session: '393fede2', total: 4.6143814, usage: [6, 1389, 151324, 133598], models: { opus: [154, 47453, 7410127, 272835, 4.6143814] } }, { tokens: { input: 154, output: 47453, cacheRead: 7410127, cacheWrite: 272835 }, effort: 'medium' }),
      refused(17.481)]),
    task(9, 'Session backlog 3h', [
      run('lead', 0.76, { session: 'c823cc53', total: 0.233468, usage: [6, 1514, 44100, 24293], models: { opus: [6, 1514, 44100, 24293, 0.233468] } }),
      run('lead', 2.02, { session: 'c823cc53', total: 0.5166854, usage: [4, 1191, 31307, 31640], models: { opus: [10, 2705, 75407, 55933, 0.5166854] } }),
      run('lead', 2.03, { session: 'c823cc53', total: 0.5918494, usage: [2, 733, 31640, 6771], models: { opus: [12, 3438, 107047, 62704, 0.5918494] } }),
      run('lead', 2.05, { session: 'c823cc53', total: 0.692264, usage: [4, 1383, 83293, 7010], models: { opus: [16, 4821, 190340, 69714, 0.692264] } }),
      run('lead', 2.14, { session: 'c823cc53', total: 1.0871564, usage: [32, 5172, 877182, 14486], models: { opus: [48, 9993, 1067522, 84200, 1.0871564] } }),
      codex(4.7, [84939, 63104, 984]), codex(4.74, [58987, 38400, 402]), codex(6.08, [439436, 365824, 2303])], { bots: null }),
    task(10, 'Roll', [
      run('lead', 4.62, { session: 'ee08f23d', total: 0.4013288, usage: [10, 3594, 117524, 38238], models: { opus: [10, 3594, 117524, 38238, 0.4013288] } }),
      run('lead', 4.68, { session: 'ee08f23d', total: 0.8320178, usage: [8, 2309, 129505, 44822], models: { opus: [18, 5903, 247029, 83060, 0.8320178] } }),
      run('lead', 4.81, { session: 'e45fce62', total: 1.7289146, usage: [80, 21511, 2614273, 96940], models: { opus: [80, 21511, 2614273, 96940, 1.7289146] } }),
      run('lead', 5.92, { session: 'e45fce62', total: 2.9518748, usage: [22, 7707, 998661, 108625], models: { opus: [102, 29218, 3612934, 205565, 2.9518748] } }),
      run('lead', 5.97, { session: 'e45fce62', total: 3.0628788, usage: [6, 1125, 239840, 5064], models: { opus: [108, 30343, 3852774, 210629, 3.0628788] } }),
      run('lead', 5.98, { session: 'e45fce62', total: 3.1721154, usage: [6, 1134, 249183, 4587], models: { opus: [114, 31477, 4101957, 215216, 3.1721154] } }),
      run('lead', 6.1, { session: 'e45fce62', total: 3.2898348, usage: [6, 1581, 258217, 4304], models: { opus: [120, 33058, 4360174, 219520, 3.2898348] } }),
      run('lead', 17.33, { session: 'e45fce62', total: 4.9793796, usage: [22, 10942, 1266884, 152155], models: { opus: [142, 44000, 5627058, 371675, 4.9793796] } }, { tokens: { input: 142, output: 44000, cacheRead: 5627058, cacheWrite: 371675 }, effort: 'medium' })], { bots: ['reviewer'] }),
  ];
  return [{ root: '/home/owner', key: 'fbdf1e0160350b93', tasks }];
}
// The owner's bots on the devbox: the reviewer runs on opus.
function bots(t) {
  const dir = temp(t), before = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = dir;
  t.after(() => { if (before === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = before; });
  saveBot({ name: 'reviewer', vendor: 'claude', model: 'opus', color: 'aqua', about: 'Reviews', instructions: 'Review the change.' }, { previous: getBot('reviewer') ? 'reviewer' : null });
}

test("the owner's top agents of the devbox: each agent named as the chat names it, one row per agent, each run's own cost and tokens", t => {
  bots(t);
  const today = agentSpend(devboxRecords(t), { now: NOW });
  const rows = today.rows.map(row => [row.agent, row.title, row.model, row.costUsd === null ? null : Number(row.costUsd.toFixed(2)), row.tokens && [row.tokens.input, row.tokens.output, row.tokens.cacheRead]]);
  assert.deepEqual(rows, [
    // The session's own agent reads as its model, as its chat header does; a resumed turn counts only what it added.
    ['Opus 5.5', 'Testing Agent', 'opus 5.5', 23, [454, 194639, 76022981]],
    // The lead bot of a team is @lead, with what its helpers on opus spent.
    ['@lead', 'Self Healing', 'fable 5.2', 20.85, [418, 215858, 23190380]],
    ['@lead', 'Testing Agent', 'fable 5.2', 12.85, [302, 91308, 13233172]],
    ['Opus 5.5', 'Roll', 'opus 5.5', 5.81, [160, 49903, 5874087]],
    ['Opus 5.5', 'ELU Issues', 'opus 5.5', 5.73, [54, 16302, 5491573]],
    ['Opus 5.5', 'Chat/MCP/Slack', 'opus 5.5', 4.61, [154, 47453, 7410127]],
    ['@lead', 'Chat/MCP/Slack', 'fable 5.2', 1.25, [16, 6996, 280337]],
    // One row for the session that moved from Opus to Codex: both models, Codex's tokens counted, its cost not reported.
    ['Opus 5.5 + Codex', 'Session backlog 3h', 'opus 5.5 + codex', 1.09, [48 + 21835 + 20587 + 73612, 9993 + 984 + 402 + 2303, 1067522 + 63104 + 38400 + 365824]],
    ['Opus 5.5', 'Native replay e2e handoff', 'opus 5.5', 0.35, [6, 3218, 64459]],
    // The reviewer never started (Claude Code refused its input): the model it was asked for, nothing spent.
    ['@reviewer', 'Chat/MCP/Slack', 'opus 5.5', 0, null],
  ]);
  const backlog = today.rows.find(row => row.title === 'Session backlog 3h'), reviewer = today.rows.find(row => row.agent === '@reviewer');
  assert.equal(backlog.partial, true); assert.deepEqual(backlog.unpriced, ['codex']);
  assert.equal(reviewer.started, false);
  assert.equal(Number(today.costUsd.toFixed(2)), 75.54); assert.equal(today.partial, true); assert.deepEqual(today.unpriced, ['codex']);
});

test("on the Mac, the devbox's rows read the same, every row with a cost has tokens, a lower bound says why, and the spend line counts the devbox", t => {
  bots(t);
  const wire = cleanTopAgents(JSON.parse(JSON.stringify(topAgentsWire(devboxRecords(t), NOW))), ref => `id-${ref}`);
  const rows = wire.today.rows.map(row => ({ ...row, where: 'on devbox' }));
  const wide = agentTable(rows, { width: 138, total: wire.today.costUsd });
  assert.match(wide[0], /^Agent +Session +Model +in · out · cache +Cost \(API price\) +Share$/);
  const line = name => wide.find(row => row.includes(name));
  assert.match(wide[1], /^Opus 5\.5 +Testing Agent +on devbox +opus 5\.5 +454 · 195k · 76M +\$23\.00 +30%$/);
  assert.match(line('ELU Issues'), /^Opus 5\.5 +ELU Issues +on devbox +opus 5\.5 +54 · 16k · 5\.5M +\$5\.73 +8%$/);
  assert.match(line('Session backlog'), /^Opus 5\.5 \+ Codex +Session backlog 3h +on devbox +opus 5\.5 \+ codex +116k · 14k · 1\.5M +\$1\.09 \+ codex +1%$/);
  assert.match(line('@reviewer'), /^@reviewer +Chat\/MCP\/Slack +on devbox +opus 5\.5 +did not start +\$0\.00 +0%$/);
  assert.ok(!wide.some(row => /@lead +ELU Issues|—/.test(row)), 'no @lead for a solo agent, and no dash');
  assert.equal(wide.filter(row => /Testing Agent/.test(row)).length, 2, 'two agents in Testing Agent: the session\'s own and the @lead bot');
  // 80 columns: the cost and tokens stay; the share and the model (the agent names it) go, and a
  // name of two models is cut so each session's title keeps its words.
  const narrow = agentTable(rows, { width: 76, total: wire.today.costUsd });
  assert.match(narrow[0], /^Agent +Session +in · out · cache +Cost$/);
  for (const row of narrow) assert.ok(row.length <= 76, row);
  assert.match(narrow.find(row => row.includes('116k')), /^Opus 5\.5 … +Session backlog 3h +on devbox +116k · 14k · 1\.5M +\$1\.09 \+ codex$/);
  assert.equal(narrow.filter(row => / Testing Agent /.test(row)).length, 2); assert.ok(narrow.some(row => /^Opus 5\.5 +Chat\/MCP\/Slack /.test(row)));
  assert.match(narrow.find(row => row.startsWith('@reviewer')), /did not start +\$0\.00$/);
  // The spend line: what every computer shown spent today, each one's part, at least that as Codex reported no cost.
  assert.equal(terminal.spendLine([{ name: 'this computer', spend: agentSpend([], { now: NOW }) }, { name: 'devbox', spend: wire.today }]), 'ELU spend today at least $75.54: this computer $0.00, devbox at least $75.54');
  assert.equal(terminal.spendLine([{ name: 'this computer', spend: agentSpend([], { now: NOW }) }], ['devbox']), 'ELU spend today $0.00; waiting for devbox');
  assert.equal(terminal.spendLine([{ name: 'this computer', spend: agentSpend([], { now: NOW }) }], [], ['devbox']), 'ELU spend today $0.00; devbox offline, not counted');
});

test("today on the devbox is the Mac's today: runs before the Mac's midnight are yesterday's", t => {
  bots(t);
  // The Mac's day started 17 hours into the devbox's: only the runs after it count.
  const wire = topAgentsWire(devboxRecords(t), NOW, DAY + 17 * 3600000);
  assert.deepEqual(wire.today.rows.map(row => [row.agent, row.title, Number(row.costUsd.toFixed(2))]), [['Opus 5.5', 'Roll', 1.69], ['Opus 5.5', 'Chat/MCP/Slack', 1.13], ['@reviewer', 'Chat/MCP/Slack', 0]]);
  assert.equal(wire.week.rows.length, 10);
});

test('a review Claude Code refuses for its input size is too long, so it is given a smaller shape', () => {
  assert.equal(claude.classify('', { stderr: 'Error: piped stdin input exceeds 10MB. Pass large content as a file path in your prompt instead.\n' }), 'too-long');
  assert.equal(claude.classify('', { stderr: 'Error: something else' }), 'unknown');
  assert.equal(claude.classify(''), 'unknown');
});
