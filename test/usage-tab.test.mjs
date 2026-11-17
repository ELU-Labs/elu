import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.mjs';
import { USAGE_LEVELS, accountLimits, tightest, timeLeft, usageBlocks, usageDetailLines, usageLevel } from '../lib/terminal-usage.mjs';
import * as terminal from '../lib/terminal.mjs';
import { claudeUsage, codexUsage, keepClaudeUsage, observeClaudeLog, personalDirectory, readAccounts, recordAccount, usageSnapshot, usageTab } from '../lib/usage.mjs';
import { THRESHOLD, markSpent } from '../lib/claude-switch.mjs';
import { finishLogin, newLogin } from '../lib/logins.mjs';

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
  // Under a minute; and none once the limit has started again.
  assert.equal(timeLeft(seconds(16, 23, 50, 30), late), '<1m'); assert.equal(timeLeft(seconds(16, 23, 49), late), ''); assert.equal(timeLeft(seconds(16, 23, 50), late), '');
  assert.equal(timeLeft(null, late), '');
  // On its line a limit that resets after midnight says how long, and its details say the day.
  const usage = { observedAt: late.toISOString(), fiveHour: { usedPercent: 30, resetsAt: seconds(17, 0, 10) }, weekly: { usedPercent: 10, resetsAt: seconds(18, 17, 50) } };
  const codex = { vendor: 'codex', installed: true, signedIn: true, accounts: [{ login: 'default', account: 'owner@example.invalid', plan: 'Pro', active: true, usage }], active: { account: 'owner@example.invalid', plan: 'Pro' }, usage, keysHint: KEYS };
  assert.deepEqual(usageBlocks([codex], { now: late }).slice(3, 5).map(row => row.text.trim()), [limit('5h', bar(3, 9), '30%', '20m'), limit('wk', bar(1, 9), '10%', '1d 18h')]);
  assert.deepEqual(usageDetailLines(codex, late).slice(0, 5), ['owner@example.invalid · Pro', 'Reported 23:50', '', '5h ██░░░░░░   30%  resets Nov 17 00:10', 'wk █░░░░░░░   10%  resets Nov 18 17:50']);
});

test('Claude: a limit of one model\'s own week is read from the event that names it, kept with the account beside its windows, and gone once it has reset', t => {
  const folder = temp(t), config = path.join(folder, 'claude'); fs.mkdirSync(config, { recursive: true });
  environment(t, { XDG_CONFIG_HOME: path.join(folder, 'personal'), HOME: path.join(folder, 'home'), CLAUDE_CONFIG_DIR: config });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'owner@example.invalid', planDisplayName: 'Max 20x' } }));
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
  // A session's log on the owner's own sign-in: the reading is kept with the account that
  // sign-in names, the model's week with it, and a later reading that does not name the model
  // keeps it until it resets.
  const log = path.join(folder, 'session.log'), fable = [{ id: 'fable', weekly: { usedPercent: 99, resetsAt: later } }];
  const own = at => usageTab({ vendors: [{ vendor: 'claude', available: true, signedIn: true }], now: at })[0].accounts[0].usage;
  fs.writeFileSync(log, `${event({ status: 'allowed_warning', resetsAt: later, rateLimitType: 'seven_day_fable', utilization: 0.99 })}\n${event({ unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: soon }, seven_day: { utilization: 0.41, resetsAt: later } } })}\n`); observeClaudeLog(log)();
  assert.deepEqual([own(now).weekly.usedPercent, own(now).models], [41, fable]);
  keepClaudeUsage('default', { observedAt: new Date(now).toISOString(), fiveHour: { usedPercent: 9, resetsAt: soon }, weekly: { usedPercent: 42, resetsAt: later } });
  assert.deepEqual([own(now).weekly.usedPercent, own(now).models], [42, fable]);
  assert.equal(own((later + 1) * 1000), null, 'every window has reset');
  // usage.json has the two windows, numbers and times only; the model's name is with the
  // account, in accounts.json. Both files are the owner's alone.
  const file = path.join(personalDirectory(), 'usage.json');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).claude).sort(), ['fiveHour', 'observedAt', 'weekly']); assert.equal(usageSnapshot(now).claude.models, undefined);
  for (const name of ['usage.json', 'accounts.json']) assert.equal(fs.statSync(path.join(personalDirectory(), name)).mode & 0o777, 0o600, name);
  const [row] = readAccounts();
  assert.deepEqual([row.account, row.usage.fiveHour, row.usage.weekly, row.usage.models], ['owner@example.invalid', { usedPercent: 9, resetsAt: soon }, { usedPercent: 42, resetsAt: later }, fable]);
  // A record with a junk model keeps none.
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
  // At 80 columns too the model's name is whole on its own line, which has the room, and its bar stands under the others.
  const narrow = usageBlocks([codex], { now, width: 76 }).map(row => row.text);
  assert.deepEqual(narrow.slice(3, 8).map(text => text.trim()), ['5h █░░░░░  18%    2h 0m', 'wk ████░░  62%    1d 2h', 'Small-Model 5h █░░░░░   4%    2h 0m', 'Small-Model wk ███░░░  51%    1d 2h', 'Unnamed █░░░░░   7%    1d 2h']);
  assert.equal(new Set(narrow.slice(3, 8).map(text => text.search(/[█░]/))).size, 1, 'one column of bars');
  assert.deepEqual(usageDetailLines(codex, now).slice(3), ['5h             █░░░░░░░   18%  resets ' + usageDetailLines(codex, now)[3].split('resets ')[1], 'wk             █████░░░   62%  resets ' + usageDetailLines(codex, now)[4].split('resets ')[1], 'Small-Model 5h █░░░░░░░    4%  resets ' + usageDetailLines(codex, now)[5].split('resets ')[1], 'Small-Model wk ████░░░░   51%  resets ' + usageDetailLines(codex, now)[6].split('resets ')[1], 'Unnamed        █░░░░░░░    7%  resets ' + usageDetailLines(codex, now)[7].split('resets ')[1]]);
});

test('Usage: a model\'s name is whole wherever its line has the room: on its own line as far left as it needs, and on an account\'s one line while the account keeps 12 columns', () => {
  const long = 'GPT-6.1-Sol-Codex-Spark', resetsAt = at(2), week = at(26);
  const usage = tightWeek => ({ observedAt, fiveHour: { usedPercent: 18, resetsAt }, weekly: { usedPercent: 62, resetsAt: week }, models: [{ id: 'spark', name: long, fiveHour: { usedPercent: 4, resetsAt }, weekly: { usedPercent: tightWeek, resetsAt: week } }] });
  const codex = (active, tightWeek = 51) => ({ vendor: 'codex', installed: true, signedIn: true, keysHint: KEYS, others: [], accounts: [
    { login: 'default', account: 'owner@example.invalid', plan: 'Pro', active, usage: usage(tightWeek) },
    { login: 'b', account: 'b@example.invalid', plan: 'Plus', active: !active, usage: { observedAt, fiveHour: null, weekly: { usedPercent: 5, resetsAt: week } } }] });
  // Open, at 140 and at 80 columns: the whole name, and every bar in one column.
  for (const [width, size] of [[136, 20], [76, 6]]) {
    const lines = texts([codex(true)], { width }).slice(3, 7);
    assert.deepEqual(lines.map(text => text.trim().replace(/ [█░]+ +/, ' | ')), ['5h | 18%    2h 0m', 'wk | 62%    1d 2h', `${long} 5h | 4%    2h 0m`, `${long} wk | 51%    1d 2h`], `at ${width}`);
    assert.deepEqual([...new Set(lines.map(text => text.search(/[█░]/)))].length, 1, `one column of bars at ${width}`); assert.ok(lines.every(text => /[█░]{6,}/.exec(text)[0].length === size && text.length <= width));
  }
  // Closed to its tightest limit, the model's week: the name is whole and the account's is cut in its middle, the plan kept.
  assert.equal(texts([codex(false, 80)], { width: 76 })[2], `Codex     ▸ owne…alid · Pro  ${limit(`${long} wk`, bar(5, 6), '80%', '1d 2h')}`);
  assert.equal(texts([codex(false, 80)], { width: 136 })[2], `Codex     ▸ ${'owner@example.invalid · Pro'.padEnd(34)}  ${limit(`${long} wk`, bar(16, 20), '80%', '1d 2h')}`);
  // Only a line with no room for it cuts the name, in its middle, with the window after it kept.
  assert.equal(texts([codex(false, 80)], { width: 60 })[2], `Codex     ▸ owner@…valid  ${limit('GPT-6…park wk', bar(5, 6), '80%', '1d 2h')}`);
  // A name of 40 characters, the longest kept, under a short account: whole, further left than the account starts.
  const wide = { ...codex(true), accounts: [{ login: 'default', account: 'o@example.invalid', plan: null, active: true, usage: { observedAt, fiveHour: { usedPercent: 18, resetsAt }, weekly: null, models: [{ id: 'long', name: 'M'.repeat(40), fiveHour: { usedPercent: 4, resetsAt }, weekly: { usedPercent: 51, resetsAt: week } }] } }] };
  assert.deepEqual(texts([wide], { width: 76 }).slice(2, 6).map(text => text.replace(/ [█░]+ .*$/, '')), ['Codex     ▾ o@example.invalid · active', `${' '.repeat(48)}5h`, `${' '.repeat(7)}${'M'.repeat(40)} 5h`, `${' '.repeat(7)}${'M'.repeat(40)} wk`]);
});

// Made-up accounts in shapes drawn from a fixed seed, at many widths: what holds whatever they are.
test('Usage at any width from 21 columns: no line of an account is wider than the pane, each limit shown keeps its whole percent, time left and FULL, and the limits stand in one column', () => {
  let seed = 20261116; const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }, pick = list => list[Math.floor(random() * list.length)];
  const word = size => Array.from({ length: size }, () => pick([...'abcdefghijklmnopqrstuvwxyz'])).join('');
  const win = () => random() < 0.15 ? null : { usedPercent: pick([0, 1, 8, 49, 50, 74, 75, 97, 97.5, 98, 100]), resetsAt: at(pick([0, 1, 4, 24, 42, 167]), pick([1, 30, 59])), ...(random() < 0.1 ? { reached: true } : {}) };
  const models = () => Array.from({ length: pick([0, 0, 1, 2, 3]) }, (_, place) => ({ id: `m${place}`, name: pick(['Fable', 'Small-Model', 'GPT-6.1-Sol-Codex-Spark', 'M'.repeat(40)]), ...(random() < 0.6 ? { fiveHour: win() ?? undefined } : {}), weekly: win() ?? { usedPercent: 5, resetsAt: at(100) } }));
  const account = (login, active) => ({ login, account: `${word(3 + Math.floor(random() * 26))}@${word(3 + Math.floor(random() * 20))}.example.invalid`, plan: pick([null, 'Pro', 'Max 20x']), active, usage: random() < 0.15 ? null : { observedAt, fiveHour: win(), weekly: win(), models: models() } });
  for (let round = 0; round < 200; round++) {
    const many = 1 + Math.floor(random() * 8), accounts = Array.from({ length: many }, (_, place) => account(place ? `a${place}` : 'default', place === 0));
    const rows = [{ vendor: 'claude', installed: true, signedIn: true, accounts, others: [], keysHint: KEYS, ...(many > 1 ? { switches: { auto: true, extraUsage: false } } : {}) }, { vendor: 'codex', installed: true, signedIn: true, accounts: [account('default', true)], others: [], keysHint: KEYS }];
    for (const width of [21, 26, 40, 60, 76, 96, 136, 200, ...Array.from({ length: 3 }, () => 21 + Math.floor(random() * 180))]) {
      const drawn = usageBlocks(rows, { now: NOW, width }), say = () => `at ${width}:\n${drawn.map(row => row.text).join('\n')}`;
      for (const row of drawn.filter(row => row.login && row.parts)) { assert.ok(row.text.length <= width, say()); assert.equal(row.parts.map(part => part.text).join(''), row.text); }
      for (const vendor of rows) for (const item of vendor.accounts) {
        const lines = drawn.filter(row => row.vendor === vendor.vendor && row.login === item.login), limits = accountLimits(item, NOW);
        if (!limits.length) continue;
        for (const limit of (lines[0].flips ? lines[0].open : limits.length > 1) ? limits : [tightest(limits)]) {
          const percent = limit.usedPercent == null ? '—' : `${Math.round(limit.usedPercent)}%`;
          assert.ok(lines.some(row => { const from = row.text.lastIndexOf(percent); return from >= 0 && row.text.includes(timeLeft(limit.resetsAt, NOW), from) && (usageLevel(limit) !== 'full' || row.text.includes('FULL')); }), `${limit.label} ${percent} ${say()}`);
        }
      }
      // Where the limits stand in columns, with the two words over them: every bar starts in one column and every line of a limit ends in one.
      if (!drawn.some(row => row.summary && /used +left$/.test(row.text))) continue;
      const bars = drawn.filter(row => row.login && /[█░]/.test(row.text));
      assert.ok(new Set(bars.map(row => row.text.search(/[█░]/))).size <= 1 && new Set(bars.map(row => row.text.length)).size <= 1, say());
    }
  }
});

test('Usage: a limit that has started again is not drawn, whenever the tab last read it: its account is no longer FULL', () => {
  const usage = { observedAt, fiveHour: null, weekly: { usedPercent: 100, resetsAt: at(0, 1) } };
  const codex = { vendor: 'codex', installed: true, signedIn: true, keysHint: KEYS, others: [], accounts: [{ login: 'default', account: 'owner@example.invalid', plan: 'Pro', active: true, usage }], active: { account: 'owner@example.invalid', plan: 'Pro' }, usage };
  const lines = now => usageBlocks([codex], { now }).map(row => row.text);
  assert.match(lines(NOW)[0], /^1 account · 1 FULL/); assert.match(lines(NOW)[2], /wk █+FULL█+ 100% {7}1m$/);
  assert.match(lines(new Date(NOW.getTime() + 30000))[2], /wk █+FULL█+ 100% {6}<1m$/);
  // Three seconds after its reset: nothing of it, and the account is one ELU has no reading for.
  const after = lines(new Date(NOW.getTime() + 63000));
  assert.match(after[0], /^1 account · 1 no reading$/); assert.equal(after[2], 'Codex       owner@example.invalid · Pro · active  usage not reported'); assert.doesNotMatch(after.join('\n'), /FULL|100%|<1m/);
  assert.deepEqual(accountLimits({ usage }, new Date(NOW.getTime() + 63000)), []);
  assert.match(usageDetailLines(codex, new Date(NOW.getTime() + 63000)).join('\n'), /Usage not reported\./);
});

test('Claude: a model\'s limit is kept with the account it was read for, so the account the owner signs in next in the same folder never shows it', t => {
  const folder = temp(t), config = path.join(folder, 'claude'); fs.mkdirSync(config, { recursive: true });
  environment(t, { XDG_CONFIG_HOME: path.join(folder, 'personal'), HOME: path.join(folder, 'home'), CLAUDE_CONFIG_DIR: config });
  const signIn = (email, plan) => fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, planDisplayName: plan } }));
  const soon = Math.floor(Date.now() / 1000) + 3600, fable = { id: 'fable', weekly: { usedPercent: 99, resetsAt: soon + 5 * 86400 } };
  const reading = (five, week, models) => ({ observedAt: new Date().toISOString(), fiveHour: { usedPercent: five, resetsAt: soon }, weekly: { usedPercent: week, resetsAt: soon + 86400 }, ...(models ? { models } : {}) });
  const tab = () => usageTab({ vendors: [{ vendor: 'claude', available: true, signedIn: true }], now: Date.now() }), own = () => tab()[0].accounts.find(item => item.login === 'default');
  const lines = () => usageBlocks(tab(), { width: 76 }).filter(row => row.summary || row.login).map(row => row.text.replace(/ {2,}/g, '  ').trim());
  // A session on first@: its two windows, and Fable's own week at 99%, five days to run.
  signIn('first@example.invalid', 'Max 20x'); keepClaudeUsage('default', reading(8, 3, [fable]));
  assert.deepEqual([own().account, own().usage.fiveHour.usedPercent, own().usage.models], ['first@example.invalid', 8, [fable]]);
  // Its next reading names no model: Fable's week is still running, and stays.
  keepClaudeUsage('default', reading(9, 4));
  assert.deepEqual([own().usage.fiveHour.usedPercent, own().usage.models], [9, [fable]]); assert.match(lines().join('\n'), /^1 account · 1 FULL/);
  // The owner signs Claude Code in as another account (claude /login). Fable's week was first@'s.
  signIn('other@example.invalid', 'Pro');
  assert.deepEqual([own().account, own().usage?.models ?? []], ['other@example.invalid', []]);
  // Its first session reports its two windows: that is all it shows.
  keepClaudeUsage('default', reading(1, 2));
  assert.deepEqual([own().account, own().usage.fiveHour.usedPercent, own().usage.weekly.usedPercent, own().usage.models ?? []], ['other@example.invalid', 1, 2, []]);
  assert.deepEqual(lines().map(text => text.replace(/  (?:\d+[dhm] ?)+$/, '')), ['1 account · 1 free  used  left', 'Claude  ▾ other@example.invalid · Pro · active', '5h █░░░░░░░░  1%', 'wk █░░░░░░░░  2%']);
  // usage.json, which has no account's name, has no model's limit of Claude's either.
  const kept = JSON.parse(fs.readFileSync(path.join(personalDirectory(), 'usage.json'), 'utf8')).claude;
  assert.deepEqual(Object.keys(kept).sort(), ['fiveHour', 'observedAt', 'weekly']); assert.equal(usageSnapshot().claude.models, undefined);
  // Signed in as first@ again: its Fable week, still running, is its own.
  signIn('first@example.invalid', 'Max 20x'); keepClaudeUsage('default', reading(10, 5));
  assert.deepEqual([own().account, own().usage.fiveHour.usedPercent, own().usage.models], ['first@example.invalid', 10, [fable]]);
});

// The files 0.1.35 left. It kept a model's limit of the owner's own sign-in in usage.json, and
// its tab's check copied that reading to the account the sign-in named then; an added account's
// was with the account from the start.
test('Claude after an update from 0.1.35: a model\'s limit kept with an account shows on that account; one kept only in usage.json, which names no account, shows on none and comes back when Claude names it again', t => {
  const folder = temp(t), config = path.join(folder, 'claude'); fs.mkdirSync(config, { recursive: true });
  environment(t, { XDG_CONFIG_HOME: path.join(folder, 'personal'), HOME: path.join(folder, 'home'), CLAUDE_CONFIG_DIR: config });
  const account = (dir, email, plan) => fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, planDisplayName: plan } }));
  const soon = Math.floor(Date.now() / 1000) + 3600, seen = new Date().toISOString(), fable = share => ({ id: 'fable', weekly: { usedPercent: share, resetsAt: soon + 5 * 86400 } });
  const reading = (five, week, models) => ({ observedAt: seen, fiveHour: { usedPercent: five, resetsAt: soon }, weekly: { usedPercent: week, resetsAt: soon + 86400 }, ...(models ? { models } : {}) });
  const file = name => path.join(personalDirectory(), name), claudeKept = () => JSON.parse(fs.readFileSync(file('usage.json'), 'utf8')).claude;
  // left(own, rows): usage.json and accounts.json as 0.1.35 wrote them.
  const left = (own, rows) => { fs.writeFileSync(file('usage.json'), JSON.stringify({ version: 1, claude: own, codex: null, codexCheckedAt: null, checkedAt: seen, signIns: {} })); fs.writeFileSync(file('accounts.json'), JSON.stringify({ version: 1, rows: rows.map(([email, plan, usage]) => ({ vendor: 'claude', account: email, plan, firstSeen: seen, lastSeen: seen, usage })) })); };
  const shown = email => { const item = usageTab({ vendors: [{ vendor: 'claude', available: true, signedIn: true }], now: Date.now() })[0].accounts.find(row => row.account === email); return [item.usage?.fiveHour?.usedPercent ?? null, item.usage?.models ?? []]; };
  account(config, 'owner@example.invalid', 'Max 20x'); fs.mkdirSync(personalDirectory(), { recursive: true });
  const slot = newLogin('claude'); account(slot.dir, 'second@example.invalid', 'Pro'); finishLogin('claude', slot.id);
  // Its tab checked after the reading: Fable's week is with the owner's account too, and shows. So does an added account's.
  left(reading(8, 41, [fable(60)]), [['owner@example.invalid', 'Max 20x', reading(8, 41, [fable(60)])], ['second@example.invalid', 'Pro', reading(12, 80, [fable(99)])]]);
  assert.deepEqual([shown('owner@example.invalid'), shown('second@example.invalid')], [[8, [fable(60)]], [12, [fable(99)]]]);
  // Its tab did not check after the reading: Fable's week is in usage.json only, and shows on no account.
  left(reading(8, 41, [fable(99)]), [['second@example.invalid', 'Pro', reading(12, 80)]]);
  assert.deepEqual([shown('owner@example.invalid'), shown('second@example.invalid')], [[8, []], [12, []]]);
  // The same two files are left when Claude Code was signed in as another account after that
  // reading: whose limit it was cannot be told, and it must not show on that account.
  account(config, 'other@example.invalid', 'Pro');
  assert.deepEqual(shown('other@example.invalid'), [8, []]);
  // The next reading, with the two windows only, takes it out of usage.json; the answer that names Fable's week brings it back, with its account.
  account(config, 'owner@example.invalid', 'Max 20x'); keepClaudeUsage('default', reading(9, 42));
  assert.deepEqual(Object.keys(claudeKept()).sort(), ['fiveHour', 'observedAt', 'weekly']); assert.deepEqual(shown('owner@example.invalid'), [9, []]);
  keepClaudeUsage('default', reading(10, 43, [fable(99)]));
  assert.deepEqual(shown('owner@example.invalid'), [10, [fable(99)]]); assert.equal(claudeKept().models, undefined);
  account(config, 'other@example.invalid', 'Pro'); assert.deepEqual(shown('other@example.invalid')[1], []);
});

test('Claude: a reading that names only a model\'s limit leaves the account\'s two windows as they were kept', t => {
  const folder = temp(t), config = path.join(folder, 'claude'); fs.mkdirSync(config, { recursive: true });
  environment(t, { XDG_CONFIG_HOME: path.join(folder, 'personal'), HOME: path.join(folder, 'home'), CLAUDE_CONFIG_DIR: config });
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'owner@example.invalid', planDisplayName: 'Max 20x' } }));
  const now = Date.now(), soon = Math.floor(now / 1000) + 3600, later = soon + 86400, observed = new Date(now).toISOString();
  const own = () => usageTab({ vendors: [{ vendor: 'claude', available: true, signedIn: true }], now })[0].accounts[0].usage;
  keepClaudeUsage('default', { observedAt: observed, fiveHour: { usedPercent: 8, resetsAt: soon }, weekly: { usedPercent: 41, resetsAt: later } });
  // A short run whose only word on limits is a warning for Opus's own week.
  const log = path.join(folder, 'session.log'); fs.writeFileSync(log, `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: later, rateLimitType: 'seven_day_opus', utilization: 0.8 } })}\n`); observeClaudeLog(log)();
  assert.deepEqual([own().fiveHour, own().weekly, own().models], [{ usedPercent: 8, resetsAt: soon }, { usedPercent: 41, resetsAt: later }, [{ id: 'opus', weekly: { usedPercent: 80, resetsAt: later } }]]);
  assert.deepEqual([usageSnapshot(now).claude.fiveHour, usageSnapshot(now).claude.weekly], [{ usedPercent: 8, resetsAt: soon }, { usedPercent: 41, resetsAt: later }]);
  // The same for an account's own record.
  recordAccount('claude', 'second@example.invalid', 'Pro', { observedAt: observed, fiveHour: { usedPercent: 5, resetsAt: soon }, weekly: { usedPercent: 6, resetsAt: later } }, now);
  recordAccount('claude', 'second@example.invalid', 'Pro', { observedAt: observed, models: [{ id: 'fable', weekly: { usedPercent: 70, resetsAt: later } }] }, now);
  const second = readAccounts().find(row => row.account === 'second@example.invalid').usage;
  assert.deepEqual([second.fiveHour, second.weekly, second.models.map(model => model.id)], [{ usedPercent: 5, resetsAt: soon }, { usedPercent: 6, resetsAt: later }, ['fable']]);
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
