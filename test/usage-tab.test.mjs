import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.mjs';
import { USAGE_LEVELS, accountLimits, tightest, timeLeft, usageBlocks, usageDetailLines, usageLevel } from '../lib/terminal-usage.mjs';
import * as terminal from '../lib/terminal.mjs';
import { claudeUsage, codexUsage, keepClaudeUsage, observeClaudeLog, personalDirectory, readAccounts, recordAccount, usageSnapshot, usageTab } from '../lib/usage.mjs';
import { THRESHOLD, markSpent } from '../lib/claude-switch.mjs';

// The Usage tab's lines (lib/terminal-usage.mjs): the summary, the vendors with a rule between,
// each limit in columns that line up, open and closed accounts, and the limits of one model.
// Every account here is made up.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const NOW = new Date(2026, 10, 16, 18, 0, 0), observedAt = NOW.toISOString();
// A reset that many hours and minutes after NOW, in seconds.
const at = (hours, minutes = 0) => Math.floor((NOW.getTime() + hours * 3600000 + minutes * 60000) / 1000);
const KEYS = 'enter on an account uses it · x forgets it · a adds one';
const bar = (filled, size) => '█'.repeat(filled) + '░'.repeat(size - filled);
const fullBar = size => { const before = Math.floor((size - 4) / 2); return `${'█'.repeat(before)}FULL${'█'.repeat(size - 4 - before)}`; };
// A limit's columns: its name, its bar, the percent in four columns, the time left in seven.
const limit = (name, cells, percent, left) => `${name} ${cells} ${percent.padStart(4)}  ${left.padStart(7)}`;
const texts = (rows, options) => usageBlocks(rows, { now: NOW, ...options }).map(row => row.text);

// Five Claude accounts: the one in use with three limits and room; one tight on its week; one
// whose week has room while Fable's own week is full; one full on the one limit it has; one
// never seen. Codex with its week only, Antigravity signed in (no limit is read for it), Grok
// Build not installed.
function scene() {
  const windows = (fiveHour, weekly, models) => ({ observedAt, fiveHour, weekly, ...(models ? { models } : {}) });
  const accounts = [
    { login: 'default', account: 'owner@example.invalid', plan: 'Max 20x', active: true, usage: windows({ usedPercent: 8, resetsAt: at(4, 29) }, { usedPercent: 3, resetsAt: at(42) }, [{ id: 'fable', weekly: { usedPercent: 62, resetsAt: at(66) } }]) },
    { login: 'a1', account: 'second@example.invalid', plan: 'Max 20x', active: false, usage: windows({ usedPercent: 21, resetsAt: at(2, 5) }, { usedPercent: 77, resetsAt: at(67) }) },
    { login: 'a2', account: 'third@example.invalid', plan: 'Max 5x', active: false, usage: windows({ usedPercent: 40, resetsAt: at(2) }, { usedPercent: 41, resetsAt: at(73) }, [{ id: 'fable', weekly: { usedPercent: 99, resetsAt: at(30) } }]) },
    { login: 'a3', account: 'fourth@example.invalid', plan: 'Pro', active: false, usage: windows(null, { usedPercent: 100, resetsAt: at(9, 39) }) },
    { login: 'a4', account: 'fifth@example.invalid', plan: 'Pro', active: false, usage: null },
  ];
  const claude = { vendor: 'claude', installed: true, signedIn: true, accounts, active: { account: 'owner@example.invalid', plan: 'Max 20x' }, usage: accounts[0].usage, others: [], keysHint: KEYS, switches: { auto: true, extraUsage: false } };
  const week = windows(null, { usedPercent: 12, resetsAt: at(146) });
  const codex = { vendor: 'codex', installed: true, signedIn: true, accounts: [{ login: 'default', account: 'owner@example.invalid', plan: 'Pro', active: true, usage: week }], active: { account: 'owner@example.invalid', plan: 'Pro' }, usage: week, others: [], keysHint: KEYS };
  return [claude, codex, { vendor: 'agy', installed: true, signedIn: true, check: 'ready', active: null }, { vendor: 'grok', installed: false }];
}
const SETTINGS = ['            Switch accounts by itself  on', '            Use paid extra usage       off'];

test('Usage at 80 columns: the summary, a rule between the vendors, and each limit in the same columns; the account in use open, a tight and a full one closed to their tightest limit', () => {
  const rule = '─'.repeat(76), pad = ' '.repeat(50);
  assert.deepEqual(texts(scene(), { width: 76 }), [
    `7 accounts · 2 free · 1 tight · 2 FULL · 2 no reading${' '.repeat(10)}used     left`,
    rule,
    // In use, with room: open, a line for each of its three limits, Fable's own week among them.
    'Claude    ▾ owner@example.invalid · Max 20x · active',
    pad + limit('   5h', bar(1, 6), '8%', '4h 29m'),
    pad + limit('   wk', bar(1, 6), '3%', '1d 18h'),
    pad + limit('Fable', bar(4, 6), '62%', '2d 18h'),
    // Tight on its week: one line, that limit.
    `          ▸ ${'second@example.invalid · Max 20x'.padEnd(36)}  ${limit('   wk', bar(5, 6), '77%', '2d 19h')}`,
    // Its week has room (41%) and Fable's week is full: one line, Fable.
    `          ▸ ${'third@example.invalid · Max 5x'.padEnd(36)}  ${limit('Fable', fullBar(6), '99%', '1d 6h')}`,
    // One limit: its line, with nothing to open.
    `            ${'fourth@example.invalid · Pro'.padEnd(36)}  ${limit('   wk', fullBar(6), '100%', '9h 39m')}`,
    `            ${'fifth@example.invalid · Pro'.padEnd(36)}  no usage yet`,
    ...SETTINGS,
    `            ${KEYS}`,
    rule,
    `Codex       ${'owner@example.invalid · Pro · active'.padEnd(36)}  ${limit('   wk', bar(1, 6), '12%', '6d 2h')}`,
    `            ${KEYS}`,
    rule,
    'Antigravity signed in · ready',
    rule,
    'Grok Build  not installed',
  ]);
});

test('Usage at 140 columns: the same lines with a bar of 20, the whole sentence of an account not seen yet, and every percent and time left in one column', () => {
  const rows = usageBlocks(scene(), { now: NOW, width: 136 }), text = rows.map(row => row.text), pad = ' '.repeat(55);
  assert.equal(text[0], `7 accounts · 2 free · 1 tight · 2 FULL · 2 no reading${' '.repeat(29)}used     left`);
  assert.deepEqual(text.slice(2, 10), [
    'Claude    ▾ owner@example.invalid · Max 20x · active',
    pad + limit('   5h', bar(2, 20), '8%', '4h 29m'),
    pad + limit('   wk', bar(1, 20), '3%', '1d 18h'),
    pad + limit('Fable', bar(12, 20), '62%', '2d 18h'),
    `          ▸ ${'second@example.invalid · Max 20x'.padEnd(41)}  ${limit('   wk', bar(15, 20), '77%', '2d 19h')}`,
    `          ▸ ${'third@example.invalid · Max 5x'.padEnd(41)}  ${limit('Fable', fullBar(20), '99%', '1d 6h')}`,
    `            ${'fourth@example.invalid · Pro'.padEnd(41)}  ${limit('   wk', fullBar(20), '100%', '9h 39m')}`,
    `            ${'fifth@example.invalid · Pro'.padEnd(41)}  Usage shows after a session on this account.`,
  ]);
  assert.equal(text[14], `Codex       ${'owner@example.invalid · Pro · active'.padEnd(41)}  ${limit('   wk', bar(2, 20), '12%', '6d 2h')}`);
  // Down the whole tab, across the vendors: the percent ends in one column, and the time left in one.
  for (const width of [76, 96, 136]) {
    const limits = texts(scene(), { width }).filter(line => /\d%/.test(line) && !/accounts/.test(line));
    assert.equal(limits.length, 7, `seven limits at ${width}`);
    assert.equal(new Set(limits.map(line => line.indexOf('%'))).size, 1, `one column of percents at ${width}`);
    assert.equal(new Set(limits.map(line => line.length)).size, 1, `one column of times at ${width}`);
    assert.ok(texts(scene(), { width }).every(line => line.length <= width), `every line fits ${width}`);
    // The two words over those columns end where the columns do.
    const head = texts(scene(), { width })[0];
    assert.deepEqual([head.indexOf('used') + 3, head.length], [limits[0].indexOf('%'), limits[0].length]);
  }
});

test('Usage in a narrow pane: an account has its limits on the lines under it, the bar gets shorter, a long name is cut in its middle, and no percent or time left is cut', () => {
  const rule = '─'.repeat(44), pad = ' '.repeat(12);
  assert.deepEqual(texts(scene(), { width: 44 }), [
    // The counts go on to a second line, none of them split.
    '7 accounts · 2 free · 1 tight · 2 FULL',
    '2 no reading',
    rule,
    'Claude    ▾ owner@…nvalid · Max 20x · active',
    pad + limit('   5h', bar(1, 11), '8%', '4h 29m'),
    pad + limit('   wk', bar(1, 11), '3%', '1d 18h'),
    pad + limit('Fable', bar(7, 11), '62%', '2d 18h'),
    '          ▸ second@example.invalid · Max 20x',
    pad + limit('   wk', bar(8, 11), '77%', '2d 19h'),
    '          ▸ third@example.invalid · Max 5x',
    pad + limit('Fable', fullBar(11), '99%', '1d 6h'),
    '            fourth@example.invalid · Pro',
    pad + limit('   wk', fullBar(11), '100%', '9h 39m'),
    '            fifth@example.invalid · Pro',
    '              Usage shows after a session.',
    ...SETTINGS,
    `            ${KEYS}`,
    rule,
    'Codex       owner@ex….invalid · Pro · active',
    pad + limit('   wk', bar(1, 11), '12%', '6d 2h'),
    `            ${KEYS}`,
    rule,
    'Antigravity signed in · ready',
    rule,
    'Grok Build  not installed',
  ]);
  // Narrower still, down to 26 columns: every line of an account fits, and each limit keeps its
  // whole percent and its whole time left. With no room for a bar, FULL stands after the time.
  for (const width of [60, 50, 40, 34, 30, 26]) {
    const rows = usageBlocks(scene(), { now: NOW, width }).filter(row => row.login);
    assert.ok(rows.every(row => row.text.length <= width), `an account's lines fit ${width}: ${rows.map(row => row.text).join('\n')}`);
    const limits = rows.map(row => row.text).filter(line => /\d%/.test(line));
    assert.deepEqual(limits.map(line => /(\d+%) +(\d\S*(?: \d\S*)?)(?: FULL)?$/.exec(line)?.slice(1)), [['8%', '4h 29m'], ['3%', '1d 18h'], ['62%', '2d 18h'], ['77%', '2d 19h'], ['99%', '1d 6h'], ['100%', '9h 39m'], ['12%', '6d 2h']], `the numbers at ${width}`);
    assert.equal(limits.filter(line => /FULL/.test(line)).length, 2, `FULL is said at ${width}`);
  }
  assert.match(texts(scene(), { width: 30 }).join('\n'), /^ +Fable █FULL█ {2}99% {4}1d 6h$/m);
  assert.match(texts(scene(), { width: 26 }).join('\n'), /^ +Fable {2}99% {4}1d 6h FULL\n[^\n]+\n +wk 100% {3}9h 39m FULL$/m);
});

test('Usage: a long account name is cut in its middle with its plan kept, or with the word active alone where the plan leaves it too little', () => {
  const usage = { observedAt, fiveHour: { usedPercent: 10, resetsAt: at(1) }, weekly: { usedPercent: 80, resetsAt: at(50) } };
  const row = active => ({ vendor: 'claude', installed: true, signedIn: true, keysHint: KEYS, others: [], usage, accounts: [
    { login: 'default', account: 'firstname.lastname@a-long-company-name.example.invalid', plan: 'Max 20x', active, usage },
    { login: 'b', account: 'b@example.invalid', plan: 'Pro', active: !active, usage },
  ] });
  // Not in use, and tight: closed to one line, the name cut, the plan and every number whole.
  assert.equal(texts([row(false)], { width: 76 })[2], `Claude    ▸ firstname.last…xample.invalid · Max 20x  ${limit('wk', bar(5, 6), '80%', '2d 2h')}`);
  // In use and folded by f: its plan and its word active stay while the name keeps 8 columns;
  // in a narrower pane the plan goes and the word stays.
  const folded = new Map([['claude\0default', false]]);
  assert.equal(texts([row(true)], { width: 76, opened: folded })[2], `Claude    ▸ firstname.…e.invalid · Max 20x · active  ${limit('wk', bar(5, 6), '80%', '2d 2h')}`);
  assert.equal(texts([row(true)], { width: 60, opened: folded })[2], `Claude    ▸ firstna…nvalid · active  ${limit('wk', bar(5, 6), '80%', '2d 2h')}`);
  // Open, an account has its line to itself: more of its name at 80 columns, all of it at 100.
  assert.equal(texts([row(true)], { width: 76 })[2], 'Claude    ▾ firstname.lastname@a-l…y-name.example.invalid · Max 20x · active');
  assert.equal(texts([row(true)], { width: 96 })[2], 'Claude    ▾ firstname.lastname@a-long-company-name.example.invalid · Max 20x · active');
  // On one line with its limit, an account has the columns up to that limit's own name. Beside
  // wk it has three more than beside Fable, whose name the column of the limits' names is as
  // wide as: a name that fills them is whole, and one a letter longer is cut.
  const named = account => { const rows = scene(); rows[0].accounts[1].account = account; return texts(rows, { width: 76 })[6]; };
  assert.equal(named('second.person@example.invalid'), `          ▸ second.person@example.invalid · Max 20x  ${limit('wk', bar(5, 6), '77%', '2d 19h')}`);
  assert.equal(named('second.persons@example.invalid'), `          ▸ second.persons…xample.invalid · Max 20x  ${limit('wk', bar(5, 6), '77%', '2d 19h')}`);
});

test('Usage: the summary counts the accounts of every vendor by their tightest limit, with those ELU has no reading for', () => {
  const summary = rows => usageBlocks(rows, { now: NOW }).filter(row => row.summary).map(row => row.text.replace(/ {2,}used +left$/, ''));
  assert.deepEqual(summary(scene()), ['7 accounts · 2 free · 1 tight · 2 FULL · 2 no reading']);
  const [claude, codex, agy, grok] = scene();
  // A count of none is left out, and one account is not "accounts".
  assert.deepEqual(summary([codex]), ['1 account · 1 free']);
  assert.deepEqual(summary([agy]), ['1 account · 1 no reading']);
  // Nothing signed in: no summary, and no rule over the first vendor.
  assert.deepEqual(texts([grok, { vendor: 'agy', installed: true, signedIn: false, signInHint: 's signs in' }]), ['Grok Build  not installed', '─'.repeat(76), 'Antigravity not signed in. s signs in']);
  // An account whose sign-in lapsed has no reading, whatever was read before; one seen before
  // that is not signed in here is not counted.
  const lapsed = { ...claude, accounts: claude.accounts.map(item => item.login === 'a1' ? { ...item, needsSignIn: true } : item), others: [{ account: 'old@example.invalid', plan: 'Pro', lastSeen: '2026-11-02T10:00:00Z', usage: { weekly: { usedPercent: 55, resetsAt: 1 } } }] };
  assert.deepEqual(summary([lapsed]), ['5 accounts · 1 free · 2 FULL · 2 no reading']);
  // The tones: the count of each level in the colour of its bars, FULL in bold.
  const parts = usageBlocks(scene(), { now: NOW })[0].parts.filter(part => /\d/.test(part.text));
  assert.deepEqual(parts.map(part => [part.text, part.tone, part.bold]), [['7 accounts', 'text', true], ['2 free', 'green', false], ['1 tight', 'orange', false], ['2 FULL', 'red', true], ['2 no reading', 'muted', false]]);
});

test('Usage levels: free under 75%, tight from 75%, FULL from the share ELU itself counts an account as spent or when the vendor says the limit is reached', () => {
  assert.deepEqual({ ...USAGE_LEVELS }, { mid: 50, tight: 75, full: 98 });
  assert.equal(USAGE_LEVELS.full, Math.round(THRESHOLD * 100), 'the share at which ELU moves off a Claude account');
  const level = (usedPercent, more = {}) => usageLevel({ usedPercent, resetsAt: at(1), ...more });
  assert.deepEqual([0, 49, 74, 74.4].map(value => level(value)), ['free', 'free', 'free', 'free']);
  // The level is that of the percent the line shows: 74.5 is drawn as 75%.
  assert.deepEqual([74.5, 75, 97, 97.4].map(value => level(value)), ['tight', 'tight', 'tight', 'tight']);
  assert.deepEqual([97.5, 98, 99, 100].map(value => level(value)), ['full', 'full', 'full', 'full']);
  // The vendor refused a request for the limit: FULL whatever share it last gave, or with none.
  assert.equal(level(40, { reached: true }), 'full'); assert.equal(level(null, { reached: true }), 'full');
  assert.equal(level(null), null); assert.equal(usageLevel(null), null);
  // Four colours on the bar and the percent: green, yellow from half, orange when tight, red when FULL.
  const tones = usedPercent => { const usage = { observedAt, fiveHour: null, weekly: { usedPercent, resetsAt: at(30) } }; const row = usageBlocks([{ vendor: 'codex', installed: true, signedIn: true, accounts: [{ login: 'default', account: 'owner@example.invalid', plan: 'Pro', active: true, usage }], usage, keysHint: KEYS }], { now: NOW })[2]; return [...new Set(row.parts.filter(part => /[█%]/.test(part.text) || part.text === 'FULL').map(part => part.tone))]; };
  assert.deepEqual([10, 49, 50, 74, 75, 97, 98, 100].map(value => tones(value)), [['green'], ['green'], ['gold'], ['gold'], ['orange'], ['orange'], ['red'], ['red']]);
  // Without colour the line says the same: the bar, the percent, and the word in a full bar.
  assert.match(texts([scene()[1]].map(row => ({ ...row, accounts: [{ ...row.accounts[0], usage: { observedAt, fiveHour: null, weekly: { usedPercent: 98, resetsAt: at(30) } } }] })))[2], /wk █+FULL█+ {2}98% {4}1d 6h$/);
  // A bar is full only at 100% or when the limit is reached, and has a cell filled once anything is used.
  const cells = usedPercent => /wk ([█░]+)/.exec(texts([{ vendor: 'codex', installed: true, signedIn: true, keysHint: KEYS, accounts: [{ login: 'default', account: 'o@example.invalid', plan: 'Pro', active: true, usage: { observedAt, fiveHour: null, weekly: { usedPercent, resetsAt: at(30) } } }] }], { width: 136 })[2])[1];
  assert.deepEqual([0, 1, 50, 94, 97].map(cells), [bar(0, 20), bar(1, 20), bar(10, 20), bar(19, 20), bar(19, 20)]);
});

test('Usage: f folds an open account to its tightest limit and unfolds a closed one; an account with one limit has nothing to fold', () => {
  const lines = opened => usageBlocks(scene(), { now: NOW, opened });
  const of = (rows, login) => rows.filter(row => row.vendor === 'claude' && row.login === login);
  const plain = lines(null);
  // As it opens: in use, or with room, open; tight or full, closed. Every line of an account is its own.
  assert.deepEqual(['default', 'a1', 'a2', 'a3', 'a4'].map(login => [of(plain, login).length, of(plain, login)[0].flips ?? false, of(plain, login)[0].open ?? null, of(plain, login)[0].level ?? null]),
    [[4, true, true, 'free'], [1, true, false, 'tight'], [1, true, false, 'full'], [1, false, null, 'full'], [1, false, null, null]]);
  // Folded: the account in use is one line, its tightest limit (Fable, at 62%).
  const folded = lines(new Map([['claude\0default', false]]));
  assert.deepEqual(of(folded, 'default').map(row => row.text), [`Claude    ▸ owner@ex….invalid · Max 20x · active  ${limit('Fable', bar(4, 6), '62%', '2d 18h')}`]);
  assert.equal(of(folded, 'default')[0].open, false);
  // Unfolded: the one whose Fable week is full shows its 5 hours and its week too, which have room.
  const unfolded = lines(new Map([['claude\0a2', true]])), pad = ' '.repeat(50);
  assert.deepEqual(of(unfolded, 'a2').map(row => row.text), ['          ▾ third@example.invalid · Max 5x', pad + limit('   5h', bar(2, 6), '40%', '2h 0m'), pad + limit('   wk', bar(2, 6), '41%', '3d 1h'), pad + limit('Fable', fullBar(6), '99%', '1d 6h')]);
  // Nothing else moves, and the other accounts stay as they were.
  assert.deepEqual(of(unfolded, 'default').map(row => row.text), of(plain, 'default').map(row => row.text)); assert.deepEqual(of(unfolded, 'a1'), of(plain, 'a1'));
  // An account with room that is not in use opens by itself.
  const roomy = scene(); roomy[0].accounts[1].usage.weekly.usedPercent = 30;
  assert.deepEqual(usageBlocks(roomy, { now: NOW }).filter(row => row.login === 'a1').map(row => row.text.trim()), ['▾ second@example.invalid · Max 20x', limit('   5h', bar(1, 6), '21%', '2h 5m').trim(), limit('   wk', bar(2, 6), '30%', '2d 19h').trim()]);
});

test('Usage: the time left is counted from the two times, across midnight and across days', () => {
  const late = new Date(2026, 10, 16, 23, 50, 0), seconds = (...parts) => Math.floor(new Date(2026, 10, ...parts).getTime() / 1000);
  assert.equal(timeLeft(seconds(17, 0, 10), late), '20m');
  assert.equal(timeLeft(seconds(17, 8, 0), late), '8h 10m');
  assert.equal(timeLeft(seconds(18, 17, 50), late), '1d 18h');
  assert.equal(timeLeft(seconds(23, 23, 49), late), '6d 23h');
  assert.equal(timeLeft(seconds(16, 23, 59), late), '9m');
  assert.equal(timeLeft(seconds(17, 0, 50), late), '1h 0m');
  // Under a minute, and a reset that has passed and is not read again yet.
  assert.equal(timeLeft(seconds(16, 23, 50, 30), late), '<1m'); assert.equal(timeLeft(seconds(16, 23, 49), late), '<1m');
  assert.equal(timeLeft(null, late), '');
  // On its line a limit that resets after midnight says how long, and its details say the day.
  const usage = { observedAt: late.toISOString(), fiveHour: { usedPercent: 30, resetsAt: seconds(17, 0, 10) }, weekly: { usedPercent: 10, resetsAt: seconds(18, 17, 50) } };
  const codex = { vendor: 'codex', installed: true, signedIn: true, accounts: [{ login: 'default', account: 'owner@example.invalid', plan: 'Pro', active: true, usage }], active: { account: 'owner@example.invalid', plan: 'Pro' }, usage, keysHint: KEYS };
  assert.deepEqual(usageBlocks([codex], { now: late }).slice(3, 5).map(row => row.text.trim()), [limit('5h', bar(3, 9), '30%', '20m'), limit('wk', bar(1, 9), '10%', '1d 18h')]);
  assert.deepEqual(usageDetailLines(codex, late).slice(0, 5), ['owner@example.invalid · Pro', 'Reported 23:50', '', '5h ██░░░░░░   30%  resets Nov 17 00:10', 'wk █░░░░░░░   10%  resets Nov 18 17:50']);
});

test('Claude: a limit of one model\'s own week is read from the event that names it, kept beside the account\'s windows, and gone once it has reset', t => {
  const folder = temp(t); environment(t, { XDG_CONFIG_HOME: folder });
  const now = Date.now(), soon = Math.floor(now / 1000) + 3600, later = soon + 86400;
  const event = info => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info });
  // Refused for Fable's own week, as Claude Code says it: no share, the reset, and the windows of the account, which have room.
  const refused = claudeUsage(event({ status: 'rejected', resetsAt: later, rateLimitType: 'seven_day_fable', overageStatus: 'rejected', isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: soon }, seven_day: { utilization: 0.41, resetsAt: later } } }));
  assert.deepEqual(refused, { fiveHour: { usedPercent: 20, resetsAt: soon }, weekly: { usedPercent: 41, resetsAt: later }, models: [{ id: 'fable', weekly: { usedPercent: null, resetsAt: later, reached: true } }] });
  // Named with its share before it is reached.
  assert.deepEqual(claudeUsage(event({ status: 'allowed_warning', resetsAt: later, rateLimitType: 'seven_day_opus', utilization: 0.8 })).models, [{ id: 'opus', weekly: { usedPercent: 80, resetsAt: later } }]);
  // A refusal for a window of the account marks that window reached; nothing else is a model.
  assert.deepEqual(claudeUsage(event({ status: 'rejected', resetsAt: soon, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: soon } } })), { fiveHour: { usedPercent: 100, resetsAt: soon, reached: true } });
  for (const type of ['overage', 'seven_day_', 'seven_day_Opus!', 'seven_day_../x']) assert.equal(claudeUsage(event({ status: 'rejected', resetsAt: later, rateLimitType: type })), null, type);
  // A session's log: the reading is kept with the model's week, and a later reading that does
  // not name the model keeps it until it resets.
  const log = path.join(folder, 'session.log');
  fs.writeFileSync(log, `${event({ status: 'allowed_warning', resetsAt: later, rateLimitType: 'seven_day_fable', utilization: 0.99 })}\n${event({ unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: soon }, seven_day: { utilization: 0.41, resetsAt: later } } })}\n`); observeClaudeLog(log)();
  assert.deepEqual(usageSnapshot(now).claude.models, [{ id: 'fable', weekly: { usedPercent: 99, resetsAt: later } }]);
  keepClaudeUsage('default', { observedAt: new Date(now).toISOString(), fiveHour: { usedPercent: 9, resetsAt: soon }, weekly: { usedPercent: 42, resetsAt: later } });
  assert.deepEqual([usageSnapshot(now).claude.weekly.usedPercent, usageSnapshot(now).claude.models], [42, [{ id: 'fable', weekly: { usedPercent: 99, resetsAt: later } }]]);
  assert.deepEqual([usageSnapshot((later + 1) * 1000).claude.weekly, usageSnapshot((later + 1) * 1000).claude.models], [null, undefined], 'every window has reset');
  // Nothing but the numbers is kept, and the file is the owner's alone.
  const file = path.join(personalDirectory(), 'usage.json');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).claude).sort(), ['fiveHour', 'models', 'observedAt', 'weekly']); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // The account's own record keeps it too, as an ELU before this reads it: the two windows as they were.
  recordAccount('claude', 'owner@example.invalid', 'Max 20x', usageSnapshot(now).claude, now);
  const [row] = readAccounts();
  assert.deepEqual([row.usage.fiveHour, row.usage.weekly, row.usage.models], [{ usedPercent: 9, resetsAt: soon }, { usedPercent: 42, resetsAt: later }, [{ id: 'fable', weekly: { usedPercent: 99, resetsAt: later } }]]);
  // A reading that names no model keeps the one recorded while it runs, and a record with a junk model keeps none.
  recordAccount('claude', 'owner@example.invalid', 'Max 20x', { observedAt: new Date(now).toISOString(), fiveHour: null, weekly: { usedPercent: 43, resetsAt: later } }, now);
  assert.deepEqual([readAccounts()[0].usage.weekly.usedPercent, readAccounts()[0].usage.models.map(model => model.id)], [43, ['fable']]);
  fs.writeFileSync(path.join(personalDirectory(), 'accounts.json'), JSON.stringify({ version: 1, rows: [{ vendor: 'claude', account: 'owner@example.invalid', lastSeen: new Date(now).toISOString(), usage: { weekly: { usedPercent: 43, resetsAt: later }, models: [{ id: '../x', weekly: { usedPercent: 1, resetsAt: later } }, { id: 'opus', token: 'never', weekly: { usedPercent: 'many' } }, 'junk'] } }] }));
  assert.deepEqual(readAccounts()[0].usage, { fiveHour: null, weekly: { usedPercent: 43, resetsAt: later }, observedAt: null });
});

test('Codex: every other limit its answer lists by id is kept under the name Codex gives it, beside the account\'s own two windows', () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 7200, five = usedPercent => ({ usedPercent, windowDurationMins: 300, resetsAt }), week = usedPercent => ({ usedPercent, windowDurationMins: 10080, resetsAt: resetsAt + 86400 });
  const answer = { rateLimits: { primary: five(18), secondary: week(62) }, rateLimitsByLimitId: {
    codex: { limitId: 'codex', limitName: null, primary: five(18), secondary: week(62) },
    codex_other: { limitId: 'codex_other', limitName: 'Small-Model', primary: five(4), secondary: week(51) },
    unnamed: { limitId: 'unnamed', limitName: null, secondary: week(7) },
    'bad id': { limitName: 'Never', primary: five(1) }, empty: { limitName: 'Nothing' }, hourly: { limitName: 'Hourly', primary: { usedPercent: 5, windowDurationMins: 60, resetsAt } },
  } };
  assert.deepEqual(codexUsage(answer), {
    fiveHour: { usedPercent: 18, resetsAt }, weekly: { usedPercent: 62, resetsAt: resetsAt + 86400 },
    models: [{ id: 'codex_other', name: 'Small-Model', fiveHour: { usedPercent: 4, resetsAt }, weekly: { usedPercent: 51, resetsAt: resetsAt + 86400 } }, { id: 'unnamed', weekly: { usedPercent: 7, resetsAt: resetsAt + 86400 } }],
  });
  // An answer with the account's own limit only reads as before.
  assert.deepEqual(codexUsage({ rateLimits: answer.rateLimits }), { fiveHour: { usedPercent: 18, resetsAt }, weekly: { usedPercent: 62, resetsAt: resetsAt + 86400 } });
  assert.deepEqual(codexUsage({ rateLimitsByLimitId: { codex: answer.rateLimitsByLimitId.codex } }), { fiveHour: { usedPercent: 18, resetsAt }, weekly: { usedPercent: 62, resetsAt: resetsAt + 86400 } });
  // On the tab: the model's two windows under its name, the name alone where it has one window.
  const usage = { observedAt, ...codexUsage(answer) }, now = new Date(resetsAt * 1000 - 7200000);
  const codex = { vendor: 'codex', installed: true, signedIn: true, accounts: [{ login: 'default', account: 'owner@example.invalid', plan: 'Pro', active: true, usage }], active: { account: 'owner@example.invalid', plan: 'Pro' }, usage, keysHint: KEYS };
  assert.deepEqual(usageBlocks([codex], { now, width: 136 }).filter(row => row.login).slice(1).map(row => row.text.trim().replace(/ +/g, ' ')), ['5h ████░░░░░░░░░░░░░░░░ 18% 2h 0m', 'wk ████████████░░░░░░░░ 62% 1d 2h', 'Small-Model 5h █░░░░░░░░░░░░░░░░░░░ 4% 2h 0m', 'Small-Model wk ██████████░░░░░░░░░░ 51% 1d 2h', 'Unnamed █░░░░░░░░░░░░░░░░░░░ 7% 1d 2h']);
  // At 80 columns a long name of a model is cut in its middle, its window kept.
  assert.match(usageBlocks([codex], { now, width: 76 }).map(row => row.text).join('\n'), /^ +Sma…del 5h █░░░░░ {3}4% {4}2h 0m\n +Sma…del wk ███░░░ {2}51% {4}1d 2h$/m);
  assert.deepEqual(usageDetailLines(codex, now).slice(3), ['5h             █░░░░░░░   18%  resets ' + usageDetailLines(codex, now)[3].split('resets ')[1], 'wk             █████░░░   62%  resets ' + usageDetailLines(codex, now)[4].split('resets ')[1], 'Small-Model 5h █░░░░░░░    4%  resets ' + usageDetailLines(codex, now)[5].split('resets ')[1], 'Small-Model wk ████░░░░   51%  resets ' + usageDetailLines(codex, now)[6].split('resets ')[1], 'Unnamed        █░░░░░░░    7%  resets ' + usageDetailLines(codex, now)[7].split('resets ')[1]]);
});

test('Usage: a limit ELU holds a Claude account at is FULL on its line until it resets: one model\'s week while the account\'s own week has room, or a window', t => {
  const folder = temp(t), home = path.join(folder, 'home'), config = path.join(home, 'claude'); fs.mkdirSync(config, { recursive: true });
  environment(t, { XDG_CONFIG_HOME: path.join(folder, 'personal'), HOME: home, CLAUDE_CONFIG_DIR: config });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'owner@example.invalid', planDisplayName: 'Max 20x' } }));
  const now = Date.now(), soon = Math.floor(now / 1000) + 3600, later = soon + 2 * 86400 + 1800;
  keepClaudeUsage('default', { observedAt: new Date(now).toISOString(), fiveHour: { usedPercent: 20, resetsAt: soon }, weekly: { usedPercent: 41, resetsAt: later } });
  const tab = () => usageTab({ vendors: [{ vendor: 'claude', available: true, signedIn: true }], env: process.env, now })[0];
  assert.equal(tab().accounts[0].spent, undefined);
  // Opus's own week: the account stays in use for every other model, so no "at its limit until" as for the whole account.
  markSpent('default', { window: 'model', until: later * 1000, model: 'opus' });
  let claude = tab();
  assert.deepEqual(claude.accounts[0].spent, { window: 'model', until: later * 1000, model: 'opus' }); assert.equal(claude.accounts[0].spentUntil, undefined);
  assert.deepEqual(accountLimits(claude.accounts[0], new Date(now)).map(limit => [limit.label, limit.usedPercent, limit.reached]), [['5h', 20, false], ['wk', 41, false], ['Opus', null, true]]);
  assert.equal(tightest(accountLimits(claude.accounts[0], new Date(now))).label, 'Opus');
  const lines = usageBlocks([claude], { now: new Date(now), opened: new Map([['claude\0default', false]]) }).map(row => row.text);
  assert.match(lines[0], /^1 account · 1 FULL/); assert.match(lines[2], /^Claude {4}▸ owner@exa…\.invalid · Max 20x · active {2}Opus █FULL█ {4}— {4}2d 1h$/);
  assert.match(usageDetailLines(claude, new Date(now)).join('\n'), /^5h {3}██░░░░░░ {3}20% {2}resets [^\n]+\nwk {3}███░░░░░ {3}41% {2}resets [^\n]+\nOpus ████████ {5}— {2}FULL {2}resets /m);
  // The account's week: that window is FULL on its line, with the time left until ELU tries it again.
  markSpent('default', { window: 'weekly', until: later * 1000 + 60000 });
  claude = tab();
  assert.deepEqual([claude.accounts[0].spent.window, claude.accounts[0].spentUntil], ['weekly', later * 1000 + 60000]);
  assert.match(usageBlocks([claude], { now: new Date(now), opened: new Map([['claude\0default', false]]) })[2].text, /^Claude {4}▸ owner@exam…e\.invalid · Max 20x · active {2}wk █FULL█ {2}41% {4}2d 1h$/);
  // The mark is over: the limits read as they were reported.
  assert.equal(usageTab({ vendors: [{ vendor: 'claude', available: true, signedIn: true }], env: process.env, now: later * 1000 + 120000 })[0].accounts[0].spent, undefined);
});

// Every key of the tab acts on the account its line names (lib/terminal.mjs usageAction reads the
// line's vendor and login). So in every mix of open and folded accounts, at every width, each
// line of an account is that account's, an account's lines stand together under its own, and
// the lines that are no account's (the summary, a rule, the settings, the keys) name none.
test('Usage: in every mix of open and folded accounts, at every width, each line of an account names that account and no other line does', () => {
  const FOLDING = ['default', 'a1', 'a2'], LIMITS = { default: 3, a1: 2, a2: 3, a3: 1, a4: 0 }, STARTS = { default: 'own', a1: 'sec', a2: 'thi', a3: 'fou', a4: 'fif' };
  for (const width of [136, 76, 60, 44, 30]) for (let mix = 0; mix < 8; mix++) {
    const want = Object.fromEntries(FOLDING.map((login, n) => [login, Boolean(mix >> n & 1)])), opened = new Map(FOLDING.map(login => [`claude\0${login}`, want[login]]));
    const rows = usageBlocks(scene(), { now: NOW, width, opened }), where = `width ${width}, open: ${FOLDING.filter(login => want[login]).join(' ') || 'none'}\n${rows.map(row => row.text).join('\n')}`;
    // The accounts in their order.
    assert.deepEqual([...new Set(rows.filter(row => row.vendor === 'claude' && row.login).map(row => row.login))], Object.keys(LIMITS), where);
    for (const [login, count] of Object.entries(LIMITS)) {
      const own = rows.map((row, at) => row.vendor === 'claude' && row.login === login ? at : -1).filter(at => at >= 0), lines = own.map(at => rows[at]);
      assert.equal(own.at(-1) - own[0], own.length - 1, `${login}: its lines stand together, ${where}`);
      assert.ok(lines[0].text.includes(STARTS[login]), `${login}: its first line names it, ${where}`);
      const limits = lines.filter(row => /\d%/.test(row.text));
      if (login in want) {
        // Open: a line for each limit under the account's own. Folded: its tightest limit
        // alone, on the account's line, or under it in a pane too narrow for that.
        assert.equal(limits.length, want[login] ? count : 1, `${login}, ${where}`); assert.ok(lines.length <= (want[login] ? count : 1) + 1, `${login}, ${where}`);
        assert.ok(lines.every(row => row.flips === true && row.open === want[login]), `${login}: each of its lines says whether it is open, ${where}`);
        assert.match(lines[0].text, want[login] ? /▾ / : /▸ /, where);
      } else { assert.equal(limits.length, count ? 1 : 0, `${login}, ${where}`); assert.ok(lines.every(row => !row.flips), `${login}: nothing to fold, ${where}`); }
    }
    // The two settings and the keys come after the last account, and name no account.
    const last = rows.findLastIndex(row => row.vendor === 'claude' && row.login);
    assert.deepEqual(rows.slice(last + 1, last + 4).map(row => [row.vendor, row.login, row.setting ?? null, row.text.trim().replace(/ {2,}/g, ' ')]),
      [['claude', null, 'auto', 'Switch accounts by itself on'], ['claude', null, 'extraUsage', 'Use paid extra usage off'], ['claude', null, null, KEYS]], where);
    assert.ok(rows.filter(row => row.summary || row.rule).every(row => row.vendor === null && row.login === null), where);
    // Under them, Codex's lines are Codex's own.
    const codex = rows.filter(row => row.vendor === 'codex' && row.login);
    assert.ok(codex.length >= 1 && codex.every(row => row.login === 'default') && rows.indexOf(codex[0]) > last + 3, where);
    assert.ok(rows.filter(row => row.login).every(row => row.text.length <= width), `every line of an account fits, ${where}`);
  }
});

test('lib/terminal.mjs still gives the tab\'s lines to what imports them from it', () => {
  assert.equal(terminal.usageBlocks, usageBlocks); assert.equal(terminal.usageDetailLines, usageDetailLines); assert.equal(typeof terminal.usageTotal, 'function');
});
