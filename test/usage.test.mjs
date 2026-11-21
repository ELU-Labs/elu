import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { temp, fakeClis, keyLike } from './helpers.mjs';
import { claudeUsage, codexUsage, usageSnapshot, observeClaudeLog, readCodexUsage, refreshCodexUsage, personalDirectory, claudeAccount, codexAccount, readAccounts, recordAccount, refreshUsage, usageStale, usageTab , agyUsage, grokUsageWords, grokAccount, accountOf, GROK_USAGE_ELSEWHERE } from '../lib/usage.mjs';
import { usageBlocks, usageDetailLines } from '../lib/terminal.mjs';
import { readSignInsBeforeCheck, signInsUnread, withCheck } from '../lib/vendor-check.mjs';
import { atomic } from '../lib/util.mjs';

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const event = windows => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: windows } });
const future = () => Math.floor(Date.now() / 1000) + 3600;
// The tab's lines under the summary, without the rules between the vendors.
const vendorLines = (rows, options) => usageBlocks(rows, options).filter(row => !row.summary && !row.rule);
const RULE = width => '─'.repeat(width);
// A limit's columns as the tab draws them: its name, its bar, the percent in four columns, the time left in seven.
const bar = (filled, size) => '█'.repeat(filled) + '░'.repeat(size - filled);
const fullBar = size => { const before = Math.floor((size - 4) / 2); return `${'█'.repeat(before)}FULL${'█'.repeat(size - 4 - before)}`; };
const limit = (name, cells, percent, left) => `${name} ${cells} ${percent.padStart(4)}  ${left.padStart(7)}`;

test('Claude headless windows are fractions and missing windows stay unreported', () => {
  const resetsAt = future();
  const result = claudeUsage(event({ seven_day: { utilization: 0.23, resetsAt, status: 'allowed' } }));
  assert.equal(result.fiveHour, undefined); assert.deepEqual(result.weekly, { usedPercent: 23, resetsAt });
  assert.equal(claudeUsage('not JSON\n' + JSON.stringify({ type: 'assistant', message: 'no limits' })), null);
  assert.deepEqual(claudeUsage(event({ five_hour: { utilization: 0, resetsAt } })).fiveHour, { usedPercent: 0, resetsAt });
  assert.equal(claudeUsage(event({ five_hour: { utilization: -1 }, seven_day: { utilization: 2 } })), null);
  const resetOnly = claudeUsage(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', resetsAt } }));
  assert.deepEqual(resetOnly.weekly, { usedPercent: null, resetsAt });
});

test('Codex maps actual window lengths and does not invent a five-hour window', () => {
  const resetsAt = future();
  const result = codexUsage({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt } } } });
  assert.equal(result.fiveHour.usedPercent, 0); assert.equal(result.weekly.usedPercent, 100);
  assert.equal(codexUsage({ rateLimits: { primary: { usedPercent: 30, windowDurationMins: 60, resetsAt } } }), null);
  assert.equal(codexUsage({ rateLimits: { primary: { usedPercent: '0', windowDurationMins: 300 } } }), null);
});

test('live Claude output stores only numeric windows and observation time', t => {
  const folder = temp(t); environment(t, { XDG_CONFIG_HOME: folder });
  const file = path.join(folder, 'output.log'); fs.writeFileSync(file, ''); const stop = observeClaudeLog(file);
  const row = event({ five_hour: { utilization: 0.36, resetsAt: future(), accountId: 'do-not-store', token: 'do-not-store' } });
  fs.appendFileSync(file, row.slice(0, 30)); stop();
  assert.equal(usageSnapshot().claude, null);
  const finish = observeClaudeLog(file); fs.appendFileSync(file, row.slice(30) + '\n'); finish();
  assert.equal(usageSnapshot().claude.fiveHour.usedPercent, 36);
  const cache = path.join(personalDirectory(), 'usage.json');
  assert.doesNotMatch(fs.readFileSync(cache, 'utf8'), /do-not-store|accountId|token/);
  assert.equal(fs.statSync(cache).mode & 0o777, 0o600);
});

test('expired windows become unreported without resetting them to zero', t => {
  const folder = temp(t); environment(t, { XDG_CONFIG_HOME: folder }); fs.mkdirSync(personalDirectory());
  const now = Date.now(), resetsAt = Math.floor(now / 1000) - 1;
  const file = path.join(personalDirectory(), 'usage.json');
  fs.writeFileSync(file, JSON.stringify({ claude: { observedAt: new Date(now - 1000).toISOString(), fiveHour: { usedPercent: 99, resetsAt }, weekly: { usedPercent: 0, resetsAt: resetsAt + 604800 } } }));
  const before = fs.readFileSync(file, 'utf8'), report = usageSnapshot(now);
  assert.equal(report.claude.fiveHour, null); assert.equal(report.claude.weekly.usedPercent, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a snapshot must not write');
});

test('Codex metadata sends no thread or turn RPC and shares a one-minute cache across projects', async t => {
  const folder = temp(t), fake = fakeClis(folder); environment(t, fake.env);
  await Promise.all([refreshCodexUsage(), refreshCodexUsage()]); await refreshCodexUsage();
  const calls = fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call => call.args[0] === 'app-server').length, 1);
  assert.deepEqual(calls.filter(call => call.rpc).map(call => call.rpc), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.equal(usageSnapshot().codex.fiveHour.usedPercent, 18); assert.equal(usageSnapshot().codex.weekly.usedPercent, 62);
  assert.deepEqual(fs.readdirSync(personalDirectory()), ['usage.json']);
});

test('failed and stalled metadata servers are closed without producing a zero reading', async t => {
  const folder = temp(t), script = path.join(folder, 'server');
  fs.writeFileSync(script, `#!${process.execPath}\nprocess.stdin.resume();setInterval(()=>{},1000);\n`, { mode: 0o755 });
  assert.equal(await readCodexUsage({ bin: script, cwd: folder, timeoutMs: 60 }), null);
  fs.writeFileSync(script, `#!${process.execPath}\nprocess.stdout.write('bad JSON\\n');process.stdin.resume();\n`, { mode: 0o755 });
  assert.equal(await readCodexUsage({ bin: script, cwd: folder }), null);
  fs.writeFileSync(script, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({id:1,error:{code:-1,message:'signed out'}})+'\\n');process.stdin.resume();\n`, { mode: 0o755 });
  assert.equal(await readCodexUsage({ bin: script, cwd: folder }), null);
});

test('the Codex app-server is told the ELU version from package.json', async t => {
  // A copy of lib/ beside a package.json with another version: a version written into the code would not follow it.
  const folder = fs.realpathSync(temp(t)), script = path.join(folder, 'server.cjs'), seen = path.join(folder, 'initialize.json');
  fs.cpSync(fileURLToPath(new URL('../lib', import.meta.url)), path.join(folder, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: '@elu-labs/elu', version: '9.8.7' }));
  const copy = await import(pathToFileURL(path.join(folder, 'lib', 'usage.mjs')).href);
  fs.writeFileSync(script, `#!${process.execPath}\nlet text='';process.stdin.on('data',chunk=>{text+=chunk;if(text.includes('\\n')){require('fs').writeFileSync(${JSON.stringify(seen)},text.split('\\n')[0]);process.exit(0);}});\n`, { mode: 0o755 });
  assert.equal(await copy.readCodexUsage({ bin: script, cwd: folder }), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(seen, 'utf8')).params.clientInfo, { name: 'elu_code', title: 'ELU', version: '9.8.7' });
});

test('unsafe personal cache paths are never followed', async t => {
  const folder = temp(t), fake = fakeClis(folder); environment(t, fake.env);
  fs.mkdirSync(personalDirectory(), { recursive: true }); const outside = path.join(folder, 'outside.json'); fs.writeFileSync(outside, '{}');
  fs.symlinkSync(outside, path.join(personalDirectory(), 'usage.json'));
  assert.deepEqual(usageSnapshot(), { claude: null, codex: null });
  await refreshCodexUsage(); assert.equal(fs.readFileSync(outside, 'utf8'), '{}');
});

// A temp home with the sign-in files a test plants. Every secret below is a marker that
// must never show up anywhere. Claude Code's own sign-in file is planted only to show that
// ELU never reads it or sends its token.
const TOKEN = keyLike('sk-ant-', 'oat01-fake-access-token-never-stored'), OTHERS = ['refresh-token-never-stored', 'codex-access-never-stored', 'account-id-never-stored', 'uuid-never-stored'];
const SECRETS = new RegExp([TOKEN, ...OTHERS].join('|'));
function home(t, { claude = true, codex = true } = {}) {
  const dir = temp(t); fs.mkdirSync(path.join(dir, 'claude')); fs.mkdirSync(path.join(dir, 'codex'));
  if (claude) {
    fs.writeFileSync(path.join(dir, 'claude', '.claude.json'), JSON.stringify({ numStartups: 3, oauthAccount: { accountUuid: OTHERS[3], emailAddress: 'owner@example.invalid', organizationName: 'Example Org', planDisplayName: 'Max 20x', userRateLimitTier: 'default_claude_max_20x', hasExtraUsageEnabled: false } }));
    fs.writeFileSync(path.join(dir, 'claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: OTHERS[0], expiresAt: Date.now() + 3600000, scopes: ['user:inference'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }));
  }
  if (codex) {
    const payload = Buffer.from(JSON.stringify({ email: 'owner@example.invalid', 'https://api.openai.com/auth': { chatgpt_plan_type: 'team', chatgpt_account_id: OTHERS[2] } })).toString('base64url');
    fs.writeFileSync(path.join(dir, 'codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: `eyJhbGciOiJSUzI1NiJ9.${payload}.signature`, access_token: OTHERS[1], refresh_token: OTHERS[0], account_id: OTHERS[2] }, last_refresh: new Date().toISOString() }));
  }
  return { dir, env: { HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CODEX_HOME: path.join(dir, 'codex') } };
}

test('the Claude and Codex accounts come from the vendor files, without their tokens', t => {
  const { env } = home(t);
  assert.deepEqual(claudeAccount({ env }), { email: 'owner@example.invalid', org: 'Example Org', plan: 'Max 20x', tier: 'default_claude_max_20x', extraUsage: false });
  assert.deepEqual(codexAccount({ env }), { email: 'owner@example.invalid', plan: 'Team' });
  assert.doesNotMatch(JSON.stringify([claudeAccount({ env }), codexAccount({ env })]), SECRETS);
  const empty = home(t, { claude: false, codex: false }).env;
  assert.equal(claudeAccount({ env: empty }), null); assert.equal(codexAccount({ env: empty }), null);
  assert.equal(codexAccount({ env, readFile: () => JSON.stringify({ tokens: { id_token: 'not-a-jwt' } }) }), null);
  assert.equal(claudeAccount({ env, readFile: () => '{"oauthAccount":{"emailAddress":""}}' }), null);
});

test('a check asks Codex, records both accounts with the usage last seen, never sends the Claude sign-in, and skips a fresh cache unless forced', async t => {
  const folder = temp(t), fake = fakeClis(folder); environment(t, fake.env);
  const { env } = home(t), requests = [];
  t.mock.method(globalThis, 'fetch', async url => { requests.push(String(url)); throw new Error('No network in tests.'); });
  const appServers = () => fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.args[0] === 'app-server').length;
  // Before any session on Claude Code there is no Claude usage, and the account is still recorded.
  const first = await refreshUsage({ env });
  assert.ok(Number.isFinite(Date.parse(first.at))); assert.equal(appServers(), 1);
  let cache = JSON.parse(fs.readFileSync(path.join(personalDirectory(), 'usage.json'), 'utf8'));
  assert.equal(cache.claude, null); assert.equal(cache.codex.weekly.usedPercent, 62); assert.ok(cache.checkedAt);
  assert.deepEqual(readAccounts().map(row => [row.vendor, row.account, row.plan, row.usage?.weekly?.usedPercent ?? null]).sort(), [['claude', 'owner@example.invalid', 'Max 20x', null], ['codex', 'owner@example.invalid', 'Team', 62]]);
  assert.equal(usageStale(), false);
  assert.equal(await refreshUsage({ env }), null); assert.equal(appServers(), 1, 'a fresh cache is not checked again');
  // A session on Claude Code reports its windows; the next check records them with the account.
  const log = path.join(folder, 'session.log'); fs.writeFileSync(log, event({ seven_day: { utilization: 0.12, resetsAt: future() } }) + '\n'); observeClaudeLog(log)();
  assert.equal(usageStale({ now: Date.now() + 121000 }), true);
  assert.ok(await refreshUsage({ force: true, env })); assert.equal(appServers(), 2, 'r asks Codex again');
  cache = JSON.parse(fs.readFileSync(path.join(personalDirectory(), 'usage.json'), 'utf8'));
  assert.equal(cache.claude.weekly.usedPercent, 12); assert.equal(cache.claude.fiveHour, null);
  assert.equal(readAccounts().find(row => row.vendor === 'claude').usage.weekly.usedPercent, 12);
  // ELU made no request of its own, and no sign-in reached personal state.
  assert.deepEqual(requests, []);
  for (const name of ['usage.json', 'accounts.json']) assert.doesNotMatch(fs.readFileSync(path.join(personalDirectory(), name), 'utf8'), SECRETS, name);
  assert.deepEqual(fs.readdirSync(personalDirectory()).sort(), ['accounts.json', 'usage.json']);
});

test('accounts.json upserts by vendor and account, keeps first seen, and drops rows it cannot trust', t => {
  const folder = temp(t); environment(t, { XDG_CONFIG_HOME: folder });
  const t0 = Date.parse('2026-11-01T10:00:00Z'), weekly = { usedPercent: 40, resetsAt: future() }, at = ms => new Date(ms).toISOString();
  recordAccount('claude', 'a@example.invalid', 'Max', { weekly, fiveHour: null, observedAt: at(t0) }, t0);
  recordAccount('claude', 'b@example.invalid', null, null, t0 + 1000);
  recordAccount('claude', 'a@example.invalid', 'Max 20x', { weekly: { ...weekly, usedPercent: 100 }, fiveHour: null }, t0 + 86400000);
  recordAccount('codex', 'a@example.invalid', 'Team', null, t0);
  recordAccount('nope', 'a@example.invalid', 'x', null, t0); recordAccount('claude', '', 'x', null, t0);
  assert.deepEqual(readAccounts().map(row => [row.vendor, row.account, row.plan, row.firstSeen, row.lastSeen, row.usage?.weekly?.usedPercent ?? null]), [
    ['claude', 'b@example.invalid', null, at(t0 + 1000), at(t0 + 1000), null],
    ['claude', 'a@example.invalid', 'Max 20x', at(t0), at(t0 + 86400000), 100],
    ['codex', 'a@example.invalid', 'Team', at(t0), at(t0), null],
  ]);
  const file = path.join(personalDirectory(), 'accounts.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, JSON.stringify({ version: 1, rows: [{ vendor: 'claude', account: 'ok@example.invalid', lastSeen: 'yesterday' }, { vendor: 'claude', account: 'ok@example.invalid', lastSeen: at(t0), token: 'x', usage: { weekly: { usedPercent: 'many' } } }, 'junk'] }));
  assert.deepEqual(readAccounts(), [{ vendor: 'claude', account: 'ok@example.invalid', plan: null, firstSeen: at(t0), lastSeen: at(t0), usage: null }]);
  fs.unlinkSync(file); fs.symlinkSync(path.join(folder, 'elsewhere.json'), file);
  recordAccount('claude', 'c@example.invalid', null, null, t0); assert.deepEqual(readAccounts(), []); assert.equal(fs.existsSync(path.join(folder, 'elsewhere.json')), false);
});

test('the Usage tab names the active account per vendor, lists the others, and hides usage for a signed-out or missing CLI', t => {
  const folder = temp(t); environment(t, { XDG_CONFIG_HOME: folder });
  const { env } = home(t), now = Date.now(), resetsAt = future(), observedAt = new Date(now).toISOString();
  fs.mkdirSync(personalDirectory(), { recursive: true });
  const usageFile = path.join(personalDirectory(), 'usage.json'), codexSeen = { observedAt, fiveHour: { usedPercent: 34, resetsAt }, weekly: { usedPercent: 10, resetsAt } };
  fs.writeFileSync(usageFile, JSON.stringify({ version: 1, claude: { observedAt, fiveHour: null, weekly: { usedPercent: 12, resetsAt } }, codex: codexSeen }));
  recordAccount('claude', 'old@example.invalid', 'Pro', { weekly: { usedPercent: 100, resetsAt }, fiveHour: null }, now - 86400000);
  recordAccount('claude', 'owner@example.invalid', 'Max 20x', null, now);
  const vendors = [{ vendor: 'claude', available: true, signedIn: true }, { vendor: 'codex', available: true, signedIn: true }, { vendor: 'agy', available: true, signedIn: false }, { vendor: 'grok', available: false, signedIn: false }];
  const [claude, codex, agy, grok] = usageTab({ vendors, env, now });
  assert.deepEqual(claude.active, { account: 'owner@example.invalid', plan: 'Max 20x', tier: 'default_claude_max_20x' });
  assert.deepEqual(claude.usage, { observedAt, fiveHour: null, weekly: { usedPercent: 12, resetsAt } });
  assert.deepEqual(claude.others.map(row => [row.account, row.usage.weekly.usedPercent]), [['old@example.invalid', 100]]);
  // The accounts' line of keys: Enter uses an account on its own line, not on this one.
  assert.equal(claude.keysHint, 'enter on an account uses it · x forgets it · a adds one');
  assert.deepEqual(claude.accounts.map(row => [row.login, row.account, row.active]), [['default', 'owner@example.invalid', true]]);
  assert.deepEqual(codex.active, { account: 'owner@example.invalid', plan: 'Team', tier: null }); assert.equal(codex.usage.fiveHour.usedPercent, 34);
  assert.deepEqual([agy.installed, agy.signedIn, agy.usage, agy.signInHint], [true, false, null, 's signs in']);
  assert.deepEqual([grok.installed, grok.signedIn, grok.active], [false, false, null]);
  const signedOut = usageTab({ vendors: vendors.map(row => ({ ...row, signedIn: false })), env, now });
  assert.equal(signedOut[0].usage, null); assert.equal(signedOut[0].active, null);
  // The blocks fit the 80-column pane and read as designed: the summary, then each account with its limit in its columns.
  const lines = usageBlocks([claude, codex, agy, grok], { now: new Date(now) }), text = lines.map(row => row.text).join('\n');
  assert.ok(lines.every(row => row.text.length <= 76), text);
  assert.match(lines[0].text, /^2 accounts · 2 free {2,}used {5}left$/); assert.equal(lines[1].text, '─'.repeat(76));
  // Claude Code reported its weekly window only: the 5-hour one is left out, never "not reported".
  assert.match(text, /^Claude {6}owner@exam…e\.invalid · Max 20x · active {2}wk █░░░░░ {2}12% +(?:59m|1h 0m)$/m); assert.doesNotMatch(text.split('\nCodex')[0], /5h|not reported/);
  assert.match(text, /^ {12}old@example.invalid · Pro {16}last seen \w{3} \d+\n {12}enter on an account uses it · x forgets it · a adds one$/m);
  // Codex reported both its windows: the account in use is open, a line for each.
  assert.match(text, /^Codex {5}▾ owner@example.invalid · Team · active\n {53}5h ██░░░░ {2}34% +(?:59m|1h 0m)\n {53}wk █░░░░░ {2}10% +(?:59m|1h 0m)$/m);
  assert.match(text, /^Antigravity not signed in for ELU · s signs in$/m); assert.match(text, /^Grok Build {2}not installed$/m);
  // At 140 columns: a bar of 20, and the week an old account used.
  const wide = usageBlocks([claude, codex, agy, grok], { now: new Date(now), width: 136 }).map(row => row.text).join('\n');
  assert.match(wide, /^Claude {6}owner@example.invalid · Max 20x · active {2}wk ██░{18} {2}12% [^\n]+\n {12}old@example.invalid · Pro {17}last seen \w{3} \d+ · wk 100% then$/m);
  assert.match(wide, /^Codex {5}▾ owner@example.invalid · Team · active\n {54}5h █{7}░{13} {2}34% [^\n]+\n {54}wk ██░{18} {2}10% /m);
  const details = usageDetailLines(claude, new Date(now)).join('\n');
  assert.match(details, /owner@example.invalid · Max 20x · default_claude_max_20x\nReported \d\d:\d\d\n\nwk █░░░░░░░ {3}12% {2}resets /); assert.doesNotMatch(details, /5h|not reported/); assert.match(details, /Other accounts\nold@example.invalid · Pro · first seen/);
  // The keys are the list's: in the dialog Enter closes it.
  assert.doesNotMatch(details, /enter|x forget|a add/);
  assert.deepEqual(usageDetailLines(grok), ['Not installed.']); assert.deepEqual(usageDetailLines(agy), ['Not signed in for ELU. s signs it in.']);
  // Before a session on Claude Code has reported a window, or once every window it reported
  // has reset, the Claude block and its details say when usage shows, and the summary that
  // there is no reading.
  for (const seen of [null, { observedAt, fiveHour: { usedPercent: 99, resetsAt: Math.floor(now / 1000) - 1 }, weekly: null }]) {
    fs.writeFileSync(usageFile, JSON.stringify({ version: 1, claude: seen, codex: codexSeen }));
    const [unseen] = usageTab({ vendors, env, now });
    assert.equal(unseen.usage, null);
    assert.equal(usageBlocks([unseen], { now: new Date(now), width: 136 })[0].text, '1 account · 1 no reading');
    assert.equal(vendorLines([unseen], { now: new Date(now), width: 136 })[0].text, 'Claude      owner@example.invalid · Max 20x · active  Usage shows after your next session on Claude Code.');
    assert.equal(vendorLines([unseen], { now: new Date(now) })[0].text, 'Claude      owner@example.invalid · Max 20x · active  no usage yet');
    assert.deepEqual(usageDetailLines(unseen, new Date(now)).slice(0, 3), ['owner@example.invalid · Max 20x · default_claude_max_20x', '', 'Usage shows after your next session on Claude Code.']);
  }
  // A record that names neither window's percent or reset says the same, not two rows of "not reported".
  const reported = (row, usage) => ({ ...row, usage, accounts: (row.accounts ?? []).map(item => item.active ? { ...item, usage } : item) });
  const bare = reported(claude, { observedAt, fiveHour: null, weekly: { usedPercent: null, resetsAt: null } });
  assert.equal(vendorLines([bare], { now: new Date(now), width: 136 })[0].text, 'Claude      owner@example.invalid · Max 20x · active  Usage shows after your next session on Claude Code.');
  assert.deepEqual(usageDetailLines(bare, new Date(now)).slice(0, 3), ['owner@example.invalid · Max 20x · default_claude_max_20x', '', 'Usage shows after your next session on Claude Code.']);
  // Codex shows the window it reported and none it did not; an account with neither says so in a few words.
  assert.match(vendorLines([reported(codex, { observedAt, fiveHour: null, weekly: codexSeen.weekly })], { now: new Date(now), width: 136 })[0].text, /^Codex {7}owner@example.invalid · Team · active {2}wk ██░{18} {2}10% +(?:59m|1h 0m)$/);
  assert.equal(vendorLines([reported(codex, null)], { now: new Date(now) })[0].text, 'Codex       owner@example.invalid · Team · active  usage not reported');
});

// The owner's case: five Claude accounts and a Codex account with its two windows.
test('Usage: an account with one limit is one line, the limits in columns that line up, the account in use in its own colour, and no name or number cut at 80 columns', () => {
  const now = new Date(2026, 10, 15, 17, 29), at = (...parts) => Math.floor(new Date(2026, 10, ...parts).getTime() / 1000), observedAt = now.toISOString();
  const week = (usedPercent, resetsAt) => ({ observedAt, fiveHour: null, weekly: { usedPercent, resetsAt } });
  const claudeAccounts = [
    { login: 'default', account: 'admin@ab.test', plan: 'Ultra', active: true, usage: week(42, at(18, 12)) },
    { login: 'b', account: 'engineering@ab.test', plan: 'Ultra', active: false, usage: null },
    { login: 'c', account: 'someone992@mail.test', plan: 'Ultra', active: false, usage: week(100, at(20, 13)) },
    { login: 'd', account: 'owner@ab.test', plan: 'Ultra', active: false, usage: week(70, at(19, 19)) },
    { login: 'e', account: 'no-reply@ab.test', plan: 'Ultra', active: false, usage: null },
  ];
  const keysHint = 'enter on an account uses it · x forgets it · a adds one';
  const claude = { vendor: 'claude', installed: true, signedIn: true, accounts: claudeAccounts, active: { account: 'admin@ab.test', plan: 'Ultra' }, usage: claudeAccounts[0].usage, others: [], keysHint, switches: { auto: true, extraUsage: false } };
  const codexUsage = { observedAt, fiveHour: { usedPercent: 0, resetsAt: at(15, 20, 52) }, weekly: { usedPercent: 100, resetsAt: at(17, 20, 35) } };
  const codex = { vendor: 'codex', installed: true, signedIn: true, accounts: [{ login: 'default', account: 'owner@ab.test', plan: 'Team', active: true, usage: codexUsage }], active: { account: 'owner@ab.test', plan: 'Team' }, usage: codexUsage, others: [], keysHint };
  const rows = [claude, codex, { vendor: 'agy', installed: false }, { vendor: 'grok', installed: false }];
  const blocks = width => usageBlocks(rows, { now, width }), text = width => blocks(width).map(row => row.text);
  const after = ['            Switch accounts by itself  on', '            Use paid extra usage       off', `            ${keysHint}`];
  // An account's line: the vendor's column, the account in a column as wide as the widest
  // account would be in use (someone992@mail.test · Ultra · active), then its limit.
  const line = (column, cell, usage, vendor = '') => `${vendor.padEnd(12)}${cell.padEnd(column)}  ${usage}`;
  // 80 columns: a bar of 8, and both of Codex's windows under its account, which is in use.
  assert.deepEqual(text(76), [
    `6 accounts · 2 free · 2 FULL · 2 no reading${' '.repeat(20)}used     left`,
    RULE(76),
    line(37, 'admin@ab.test · Ultra · active', limit('wk', bar(3, 8), '42%', '2d 18h'), 'Claude'),
    line(37, 'engineering@ab.test · Ultra', 'no usage yet'),
    line(37, 'someone992@mail.test · Ultra', limit('wk', fullBar(8), '100%', '4d 19h')),
    line(37, 'owner@ab.test · Ultra', limit('wk', bar(6, 8), '70%', '4d 1h')),
    line(37, 'no-reply@ab.test · Ultra', 'no usage yet'),
    ...after,
    RULE(76),
    'Codex     ▾ owner@ab.test · Team · active',
    `${' '.repeat(51)}${limit('5h', bar(0, 8), '0%', '3h 23m')}`,
    `${' '.repeat(51)}${limit('wk', fullBar(8), '100%', '2d 3h')}`,
    `            ${keysHint}`,
    RULE(76),
    'Antigravity not installed',
    RULE(76),
    'Grok Build  not installed',
  ]);
  // 100 columns: a bar of 20 and the whole sentence of an account not seen yet.
  assert.deepEqual(text(96).slice(2, 4), [line(37, 'admin@ab.test · Ultra · active', limit('wk', bar(8, 20), '42%', '2d 18h'), 'Claude'), line(37, 'engineering@ab.test · Ultra', 'Usage shows after a session on this account.')]);
  assert.deepEqual(text(96).slice(11, 14), ['Codex     ▾ owner@ab.test · Team · active', `${' '.repeat(51)}${limit('5h', bar(0, 20), '0%', '3h 23m')}`, `${' '.repeat(51)}${limit('wk', fullBar(20), '100%', '2d 3h')}`]);
  for (const width of [76, 96, 136]) {
    const lines = blocks(width), accounts = lines.filter(row => row.login), named = accounts.filter(row => /@/.test(row.text));
    assert.ok(lines.every(row => row.text.length <= width), `every line fits ${width}`);
    // Every line of an account is the account's, and Enter on it uses that account: one line
    // for each of Claude's, and Codex's with a line under it for each of its two windows.
    assert.deepEqual(accounts.map(row => [row.vendor, row.login]), [...claudeAccounts.map(item => ['claude', item.login]), ['codex', 'default'], ['codex', 'default'], ['codex', 'default']]);
    // Every percent ends in one column, down both vendors.
    assert.equal(new Set(accounts.map(row => row.text.indexOf('%')).filter(place => place >= 0)).size, 1, `one column of percents at ${width}`);
    // The account in use in the accent colour, its word active kept; the others as the text.
    assert.deepEqual(named.map(row => { const part = row.parts.find(part => /@/.test(part.text)); return [part.text.trim(), part.tone, part.bold]; }), [['admin@ab.test · Ultra · active', 'orange', true], ...claudeAccounts.slice(1).map(item => [`${item.account} · Ultra`, 'text', false]), ['owner@ab.test · Team · active', 'orange', true]]);
    // A limit's percent in the colour of how full it is, and the words of an account with none muted.
    assert.deepEqual(named.slice(0, 5).map(row => (row.parts.find(part => /%/.test(part.text)) ?? row.parts.at(-1)).tone), ['green', 'muted', 'red', 'gold', 'muted']);
    assert.equal(accounts[0].parts[0].text, 'Claude      '); assert.equal(accounts[0].parts[0].bold, true);
    assert.equal(accounts.map(row => row.parts.map(part => part.text).join('')).join('\n'), accounts.map(row => row.text).join('\n'));
  }
  // An account ELU holds at its week is FULL until then, whatever share it last read; one whose sign-in lapsed says so.
  claudeAccounts[3].spentUntil = at(19, 19) * 1000; claudeAccounts[3].spent = { window: 'weekly', until: at(19, 19) * 1000 }; claudeAccounts[4].needsSignIn = true;
  assert.deepEqual(text(76).slice(5, 7), [line(37, 'owner@ab.test · Ultra', limit('wk', fullBar(8), '70%', '4d 1h')), line(37, 'no-reply@ab.test · Ultra', 'sign in again')]);
  assert.equal(text(76)[0].replace(/ {2,}.*$/, ''), '6 accounts · 1 free · 3 FULL · 2 no reading');
  // One ELU holds for another reason than a limit it reads says until when, on its line.
  claudeAccounts[3].spent = { window: 'billing', until: at(19, 19) * 1000 };
  assert.equal(text(76)[5], line(37, 'owner@ab.test · Ultra', 'at its limit until Nov 19'));
  // A narrower pane: a shorter bar, and the fewest words that still say it, never part of one.
  assert.deepEqual(text(70).slice(2, 7), [
    line(33, 'admin@ab.test · Ultra · active', limit('wk', bar(3, 6), '42%', '2d 18h'), 'Claude'),
    line(33, 'engineering@ab.test · Ultra', 'no usage yet'),
    line(33, 'someone992@mail.test · Ultra', limit('wk', fullBar(6), '100%', '4d 19h')),
    line(33, 'owner@ab.test · Ultra', 'until Nov 19 19:00'),
    line(33, 'no-reply@ab.test · Ultra', 'sign in again'),
  ]);
});

// At 80 columns a long account name was cut mid-word at the pane, with its usage, and its
// column left the other accounts so little room that their texts lost their meaning ("sign
// in", "last seen", "usage not"). Another account in use changed every line, and at 140
// columns one account's week stood where another's 5 hours did.
test('Usage: a long account name in use is whole with its limits under it, every text keeps its meaning, another account in use changes no other line, and limits line up by kind', () => {
  const now = new Date(2026, 10, 15, 17, 29), at = (...parts) => Math.floor(new Date(2026, 10, ...parts).getTime() / 1000), observedAt = now.toISOString();
  const keysHint = 'enter on an account uses it · x forgets it · a adds one', keys = `            ${keysHint}`, settings = ['            Switch accounts by itself  on', '            Use paid extra usage       off'];
  const windows = (fiveHour, weekly) => ({ observedAt, fiveHour, weekly });
  const claude = (accounts, others = []) => ({ vendor: 'claude', installed: true, signedIn: true, accounts, usage: accounts.find(item => item.active)?.usage ?? null, others, keysHint, switches: { auto: true, extraUsage: false } });
  const codex = usage => ({ vendor: 'codex', installed: true, signedIn: true, accounts: [{ login: 'default', account: 'owner@ab.test', plan: 'Team', active: true, usage }], usage, others: [], keysHint });
  // A line: the vendor's column, the account in a column this wide, then its limit.
  const line = (column, cell, usage, vendor = '') => `${vendor.padEnd(12)}${cell.padEnd(column)}  ${usage}`;
  // A long name in use, an account whose sign-in lapsed, one ELU holds at its limit, one seen before, and Codex with no usage.
  const long = claude([
    { login: 'default', account: 'firstname.lastname@longcompany.test', plan: 'Max 20x', active: true, usage: windows({ usedPercent: 8, resetsAt: at(15, 22, 10) }, { usedPercent: 42, resetsAt: at(18, 12) }) },
    { login: 'b', account: 'b@ab.test', plan: 'Pro', active: false, usage: null, needsSignIn: true },
    { login: 'c', account: 'c@ab.test', plan: 'Pro', active: false, usage: null, spentUntil: at(19, 19) * 1000 },
  ], [{ account: 'old@ab.test', plan: 'Pro', lastSeen: new Date(2026, 10, 9, 12).toISOString(), usage: windows(null, { usedPercent: 100, resetsAt: at(16, 12) }) }]);
  const narrow = usageBlocks([long, codex(null)], { now, width: 76 });
  assert.deepEqual(narrow.map(row => row.text), [
    `4 accounts · 1 free · 1 FULL · 2 no reading${' '.repeat(20)}used     left`,
    RULE(76),
    'Claude    ▾ firstname.lastname@longcompany.test · Max 20x · active',
    `${' '.repeat(53)}${limit('5h', bar(1, 6), '8%', '4h 41m')}`,
    `${' '.repeat(53)}${limit('wk', bar(3, 6), '42%', '2d 18h')}`,
    line(39, 'b@ab.test · Pro', 'sign in again'),
    // Held at its limit with no share read: FULL, and the time left until ELU tries it again.
    line(39, 'c@ab.test · Pro', limit('wk', fullBar(6), '—', '4d 1h')),
    ...settings,
    line(39, 'old@ab.test · Pro', 'last seen Nov 9'),
    keys,
    RULE(76),
    line(39, 'owner@ab.test · Team · active', 'usage not reported', 'Codex'),
    keys,
  ]);
  // The three lines are the account's, so Enter on any uses it; the account in its colour, a limit's time left as the text.
  assert.deepEqual(narrow.slice(2, 5).map(row => [row.vendor, row.login]), [['claude', 'default'], ['claude', 'default'], ['claude', 'default']]);
  const named = narrow[2].parts.find(part => /@/.test(part.text));
  assert.deepEqual([named.tone, named.bold, narrow[3].parts.at(-1).tone], ['orange', true, 'text']);
  for (const row of narrow.slice(2, 5)) assert.equal(row.parts.map(part => part.text).join(''), row.text);
  // Where the pane has room, the same lines with a longer bar.
  const wide = usageBlocks([long, codex(null)], { now, width: 136 }).map(row => row.text);
  assert.deepEqual(wide.slice(2, 5), ['Claude    ▾ firstname.lastname@longcompany.test · Max 20x · active', `${' '.repeat(68)}${limit('5h', bar(2, 20), '8%', '4h 41m')}`, `${' '.repeat(68)}${limit('wk', bar(8, 20), '42%', '2d 18h')}`]);
  assert.equal(wide.length, narrow.length);
  // The owner's five accounts: the column is as wide as the widest account would be in use,
  // so putting another one in use changes those two accounts' lines and nothing else.
  const five = active => claude([
    { login: 'default', account: 'admin@ab.test', plan: 'Ultra', usage: windows({ usedPercent: 8, resetsAt: at(15, 22, 10) }, { usedPercent: 42, resetsAt: at(18, 12) }) },
    { login: 'b', account: 'engineering@ab.test', plan: 'Ultra', usage: null },
    { login: 'c', account: 'someone992@mail.test', plan: 'Ultra', usage: windows(null, { usedPercent: 100, resetsAt: at(20, 13) }) },
    { login: 'd', account: 'owner@ab.test', plan: 'Ultra', usage: windows(null, { usedPercent: 70, resetsAt: at(19, 19) }) },
    { login: 'e', account: 'no-reply@ab.test', plan: 'Ultra', usage: null },
  ].map(item => ({ ...item, active: item.login === active })));
  const both = codex(windows({ usedPercent: 0, resetsAt: at(15, 20, 52) }, { usedPercent: 100, resetsAt: at(17, 20, 35) }));
  const text = (active, width) => usageBlocks([five(active), both], { now, width }).map(row => row.text);
  const head = [`6 accounts · 2 free · 2 FULL · 2 no reading${' '.repeat(20)}used     left`, RULE(76)], under = size => ' '.repeat(51);
  const rest = [...settings, keys, RULE(76), 'Codex     ▾ owner@ab.test · Team · active', under() + limit('5h', bar(0, 8), '0%', '3h 23m'), under() + limit('wk', fullBar(8), '100%', '2d 3h'), keys];
  assert.deepEqual(text('default', 76), [
    ...head,
    'Claude    ▾ admin@ab.test · Ultra · active',
    under() + limit('5h', bar(1, 8), '8%', '4h 41m'),
    under() + limit('wk', bar(3, 8), '42%', '2d 18h'),
    line(37, 'engineering@ab.test · Ultra', 'no usage yet'),
    line(37, 'someone992@mail.test · Ultra', limit('wk', fullBar(8), '100%', '4d 19h')),
    line(37, 'owner@ab.test · Ultra', limit('wk', bar(6, 8), '70%', '4d 1h')),
    line(37, 'no-reply@ab.test · Ultra', 'no usage yet'),
    ...rest,
  ]);
  // The one that was in use has room, so it stays open.
  assert.deepEqual(text('c', 76), [
    ...head,
    'Claude    ▾ admin@ab.test · Ultra',
    under() + limit('5h', bar(1, 8), '8%', '4h 41m'),
    under() + limit('wk', bar(3, 8), '42%', '2d 18h'),
    line(37, 'engineering@ab.test · Ultra', 'no usage yet'),
    line(37, 'someone992@mail.test · Ultra · active', limit('wk', fullBar(8), '100%', '4d 19h')),
    line(37, 'owner@ab.test · Ultra', limit('wk', bar(6, 8), '70%', '4d 1h')),
    line(37, 'no-reply@ab.test · Ultra', 'no usage yet'),
    ...rest,
  ]);
  // At 140 columns too a limit stands under the same kind of limit: an account's week under another's week, never under its 5 hours.
  assert.deepEqual(text('default', 136).slice(2, 9), [
    'Claude    ▾ admin@ab.test · Ultra · active',
    under() + limit('5h', bar(2, 20), '8%', '4h 41m'),
    under() + limit('wk', bar(8, 20), '42%', '2d 18h'),
    line(37, 'engineering@ab.test · Ultra', 'Usage shows after a session on this account.'),
    line(37, 'someone992@mail.test · Ultra', limit('wk', fullBar(20), '100%', '4d 19h')),
    line(37, 'owner@ab.test · Ultra', limit('wk', bar(14, 20), '70%', '4d 1h')),
    line(37, 'no-reply@ab.test · Ultra', 'Usage shows after a session on this account.'),
  ]);
  for (const width of [76, 96, 136]) for (const active of ['default', 'c']) assert.ok(text(active, width).every(row => row.length <= width), `every line fits ${width}`);
});

test('the Usage tab reads Antigravity and Grok Build sign-in before their one-time check, starting no turn, and says c runs it', async t => {
  const folder = temp(t); environment(t, { XDG_CONFIG_HOME: path.join(folder, 'personal') });
  const { env } = home(t), now = Date.now(), fake = fakeClis(folder), config = path.join(fake.dir, 'fake.json');
  const calls = () => fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  // detect() never runs such a vendor: null sign-in, and no release.
  const waiting = vendor => ({ vendor, available: true, bin: path.join(fake.dir, vendor), supported: false, signedIn: null, version: null, conformant: false });
  const rows = [waiting('agy'), waiting('grok')], tab = () => { const [, , agy, grok] = usageTab({ vendors: withCheck(rows, { env }), env, now, browser: true }); return { agy, grok }; };
  const text = row => vendorLines([row], { now: new Date(now) }).map(line => line.text);
  // Before any read: Grok's token file is looked for at once, Antigravity is not read yet.
  let { agy, grok } = tab();
  assert.deepEqual([agy.unchecked, agy.check, agy.signInRead, grok.check, grok.signInRead], [true, 'needed', null, 'needed', false]);
  assert.deepEqual(text(agy), ['Antigravity (agy) sign-in not read yet · Full access only (c checks it)']);
  assert.deepEqual(text(grok), ['Grok Build  (grok) not signed in for ELU · s signs in']);
  // On a computer with no browser, the sign-in that needs none: Codex has a device code one, and
  // Antigravity and Grok Build are signed in from ELU either way.
  assert.deepEqual(usageTab({ vendors: [{ vendor: 'codex', available: true, signedIn: false }, ...withCheck(rows, { env })], env, now, browser: false }).map(row => row.signInHint), ['Run: claude', 'Run: codex login --device-auth', 's signs in', 's signs in']);
  assert.deepEqual(usageTab({ vendors: [{ vendor: 'codex', available: true, signedIn: false }], env, now, browser: true })[1].signInHint, 'Run: codex login');
  assert.equal(signInsUnread(rows), true);
  fs.mkdirSync(path.join(env.HOME, '.grok')); fs.writeFileSync(path.join(env.HOME, '.grok', 'auth.json'), '{"token":"never-read"}\n', { mode: 0o600 });
  assert.deepEqual(text(tab().grok), ['Grok Build  (grok) signed in · Full access only (c checks it)']);
  // Antigravity: its release and help, as the check asks first, then agy -p /usage under the
  // private sign-in HOME. Only the exit code is read; nothing reaches a model turn.
  await readSignInsBeforeCheck(rows, { env: { ...process.env, ...env } });
  assert.deepEqual(calls().map(call => [call.vendor, call.args]), [['agy', ['--version']], ['agy', ['--help']], ['agy', ['-p', '/usage', '--output-format', 'json']]]);
  assert.equal(calls().at(-1).home, path.join(personalDirectory(), 'agy-home', 'signin')); assert.equal(calls().at(-1).autoUpdate, 'true');
  assert.equal(fs.existsSync(path.join(folder, 'inputs.jsonl')), false, 'no prompt was sent');
  ({ agy, grok } = tab());
  assert.deepEqual(text(agy), ['Antigravity (agy) signed in · Full access only (c checks it)']);
  assert.equal(signInsUnread(rows), false);
  assert.deepEqual(usageDetailLines(agy), ['Signed in.', '', 'Antigravity CLI (the agy command) has not been checked on this machine yet. Your first message to it outside Full access runs the check; Full access needs none.', 'c runs it now.']);
  // A read is kept for its program: the tab does not ask again until r (all), or for another program.
  await readSignInsBeforeCheck(rows, { env: { ...process.env, ...env } }); assert.equal(calls().length, 3);
  assert.equal(signInsUnread([{ ...rows[0], bin: path.join(folder, 'elsewhere', 'agy') }]), true);
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), agy: { signedIn: false } }));
  await readSignInsBeforeCheck(rows, { env: { ...process.env, ...env }, all: true }); assert.equal(calls().length, 6);
  ({ agy } = tab());
  assert.deepEqual(text(agy), ['Antigravity (agy) not signed in for ELU · s signs in']);
  assert.deepEqual(usageDetailLines(agy), ['Not signed in for ELU. s signs it in.', '', 'Antigravity CLI (the agy command) has not been checked on this machine yet. Your first message to it outside Full access runs the check; Full access needs none.', 'c runs it now.']);
  // A release that cannot run here is not asked for its sign-in.
  fs.writeFileSync(path.join(fake.dir, 'agy'), `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('agy version 1.5.4'); else if (process.argv.includes('--help')) console.log('--output-format'); else { require('node:fs').writeFileSync(${JSON.stringify(path.join(folder, 'asked'))}, 'x'); process.exit(0); }\n`, { mode: 0o755 });
  await readSignInsBeforeCheck(rows, { env: { ...process.env, ...env }, all: true });
  assert.equal(fs.existsSync(path.join(folder, 'asked')), false);
  ({ agy } = tab());
  assert.deepEqual(text(agy), ['Antigravity (agy) this release cannot run here', '            Antigravity CLI 1.5.4: This untested version is missing required', '            flags: --input-format, --json-schema, --conversation, --mode,', '            --sandbox, --add-dir, --print-timeout,', '            --dangerously-skip-permissions.']);
  assert.ok(text(agy).every(line => line.length <= 76));
  // Saved: the program, the answer and when; never more.
  const saved = JSON.parse(fs.readFileSync(path.join(personalDirectory(), 'usage.json'), 'utf8')).signIns;
  assert.deepEqual(Object.keys(saved), ['agy']); assert.deepEqual(Object.keys(saved.agy).sort(), ['at', 'bin', 'reason', 'signedIn', 'supported']);
  // Once the check ran, it says where the vendor stands: ready, or which step failed.
  const ran = conformant => withCheck([{ vendor: 'grok', available: true, bin: rows[1].bin, supported: true, signedIn: true, version: '1.0.77', release: '1.0.77', conformant }], { env });
  assert.deepEqual(text(usageTab({ vendors: ran(true), env, now })[3]), ['Grok Build  signed in · ready']);
  atomic(path.join(personalDirectory(), 'conformance', 'grok.json'), { v: 1, bin: rows[1].bin, version: '1.0.77', steps: { signin: 'pass', 'locked-no-write': 'pass', 'locked-no-shell': 'fail', 'locked-no-network': 'fail', json: 'pass', resume: 'pass', relay: 'fail', isolation: 'pass' }, why: { 'locked-no-shell': 'locked run ran a shell command' }, stable: ['locked-no-shell'], loads: [], relay: false, at: new Date().toISOString() });
  const failed = usageTab({ vendors: ran(false), env, now })[3];
  assert.deepEqual(text(failed), ['Grok Build  (grok) signed in · Full access only (c checks again)', '            Not proven: a read-only turn runs no command (locked run ran a', '            shell command), and 1 more.']);
  assert.deepEqual(usageDetailLines(failed), ['Signed in.', '', 'Grok Build (the grok command) did not pass its check on this machine, so it runs in Full access only here. Not proven: a read-only turn runs no command (locked run ran a shell command), and 1 more.', 'c runs the check again.']);
  // What its check found that it also loads here shows under a vendor that is ready; something that runs says what the owner answered.
  const loaded = answer => { atomic(path.join(personalDirectory(), 'conformance', 'grok.json'), { v: 1, bin: rows[1].bin, version: '1.0.77', steps: { signin: 'pass', 'locked-no-write': 'pass', 'locked-no-shell': 'pass', 'locked-no-network': 'pass', json: 'pass', resume: 'pass', relay: 'pass', isolation: 'fail' }, why: { isolation: 'it also loads Cursor rule /x/rules/style.md, Cursor hook /x/.cursor' }, stable: [], loads: [{ what: 'Cursor rule', from: '/x/rules/style.md', runs: false }, { what: 'Cursor hook', from: '/x/.cursor', runs: true }], ...(answer ? { answer: { decision: answer, for: ['Cursor hook /x/.cursor'] } } : {}), relay: true, at: new Date().toISOString() }); return usageTab({ vendors: ran(true), env, now })[3]; };
  assert.deepEqual(text(loaded(null)), ['Grok Build  signed in · ready', '            It also loads on this machine: Cursor rule /x/rules/style.md.', '            It would also run on this machine: Cursor hook /x/.cursor.', '            Outside Full access your next message to it asks you once.']);
  assert.equal(loaded(null).asks, false);
  assert.deepEqual(text(loaded('allow')).slice(2), ['            It would also run on this machine: Cursor hook /x/.cursor.', '            You allowed that.']);
  const denied = loaded('deny');
  assert.equal(denied.asks, true); assert.deepEqual(text(denied).slice(2), ['            It would also run on this machine: Cursor hook /x/.cursor.', '            You said no, so it runs in Full access only. c asks again.']);
  // A check c started shows its lines under the vendor as it goes, then why it stopped.
  const checks = new Map([['grok', { running: true, lines: ['Checking Grok Build (the grok command): 8 steps, once on this machine for release 1.0.77.'], current: 'Grok Build: 2 of 8 steps, 14s so far. Proven: a read-only turn writes no file.', error: null }]]);
  assert.deepEqual(vendorLines([usageTab({ vendors: withCheck([waiting('grok')], { env }), env, now })[3]], { checks }).map(line => line.text), ['Grok Build  (grok) signed in · checking…', '            Checking Grok Build (the grok command): 8 steps, once on this', '            machine for release 1.0.77.', '            Grok Build: 2 of 8 steps, 14s so far. Proven: a read-only turn', '            writes no file.']);
  assert.ok(!calls().some(call => call.vendor === 'grok'), 'grok was never run');
});
test("Antigravity's /usage answer becomes a row of limits per model group, as shares used", () => {
  const hour = 3600 * 1000, at = offset => new Date(Date.now() + offset).toISOString().replace(/\.\d+Z$/, 'Z');
  const answer = { status: 'SUCCESS', response: 'Gemini Models\tWeekly Limit Remaining\t99%', command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [{ id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.9881, reset_time: at(150 * hour) }, { id: 'gemini-5h', window: '5h', remaining_fraction: 0.25, reset_time: at(4 * hour) }] },
    { name: 'Claude and GPT models', buckets: [{ id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: at(160 * hour) }, { id: '3p-5h', window: '5h', remaining_fraction: 7, reset_time: at(hour) }] },
  ] } } };
  const usage = agyUsage(JSON.stringify(answer));
  assert.deepEqual(usage.models.map(row => [row.id, row.name, row.fiveHour?.usedPercent ?? null, row.weekly?.usedPercent ?? null]), [['gemini', 'Gemini', 75, 1], ['3p', 'Claude and GPT', null, 0]]);
  assert.equal(usage.models[0].fiveHour.resetsAt, Math.floor(Date.parse(at(4 * hour)) / 1000));
  assert.equal(agyUsage('Authentication required. Please visit the URL to log in:'), null);
  assert.equal(agyUsage(JSON.stringify({ command: { data: { groups: [] } } })), null);
});

test("grok usage: its first line when it answers, where to look when it cannot read the plan here", () => {
  assert.equal(grokUsageWords({ code: 0, stdout: '\n\x1b[1mSuperGrok\x1b[0m · 12% of the weekly limit used\nmore\n' }), 'SuperGrok · 12% of the weekly limit used');
  assert.equal(grokUsageWords({ code: 1, stderr: "Error: `grok usage` can't show your plan's usage here yet. Run /usage inside grok instead.\n" }), GROK_USAGE_ELSEWHERE);
  assert.equal(grokUsageWords({ code: 1, stderr: 'Error: not signed in' }), null);
  assert.equal(grokUsageWords({ code: null, stdout: '', stderr: '' }), null);
});

test("Grok Build's account is the email its sign-in file names, and its key is never taken", t => {
  const home = temp(t), key = keyLike('xai-', 'test-', 'not-a-real-key-123');
  environment(t, { XDG_CONFIG_HOME: path.join(home, 'config') });
  fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
  fs.writeFileSync(path.join(home, '.grok', 'auth.json'), JSON.stringify({
    'https://auth.x.ai::older': { key, email: 'old@example.com', create_time: '2026-01-01T00:00:00Z' },
    'https://auth.x.ai::newer': { key, email: 'owner@example.com', create_time: '2026-11-01T00:00:00Z', refresh_token: key },
  }));
  const account = grokAccount({ env: { HOME: home } });
  assert.deepEqual(account, { email: 'owner@example.com', plan: null });
  assert.equal(JSON.stringify(accountOf('grok', 'default', { env: { HOME: home } })).includes(key), false);
  assert.equal(grokAccount({ env: { HOME: path.join(home, 'nobody') } }), null);
  assert.equal(accountOf('agy', 'default', { env: { HOME: home } }), null);
});
