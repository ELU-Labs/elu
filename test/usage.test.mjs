import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { temp, fakeClis, keyLike } from './helpers.mjs';
import { claudeUsage, codexUsage, usageSnapshot, observeClaudeLog, readCodexUsage, refreshCodexUsage, personalDirectory, claudeAccount, codexAccount, readAccounts, recordAccount, refreshUsage, usageStale, usageTab } from '../lib/usage.mjs';
import { usageBlocks, usageDetailLines } from '../lib/terminal.mjs';
import { readSignInsBeforeCheck, signInsUnread, withCheck } from '../lib/vendor-check.mjs';
import { atomic } from '../lib/util.mjs';

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const event = windows => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: windows } });
const future = () => Math.floor(Date.now() / 1000) + 3600;

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
  assert.equal(claude.keysHint, 'enter use · a add account · x forget');
  assert.deepEqual(claude.accounts.map(row => [row.login, row.account, row.active]), [['default', 'owner@example.invalid', true]]);
  assert.deepEqual(codex.active, { account: 'owner@example.invalid', plan: 'Team', tier: null }); assert.equal(codex.usage.fiveHour.usedPercent, 34);
  assert.deepEqual([agy.installed, agy.signedIn, agy.usage, agy.signInHint], [true, false, null, 's signs in']);
  assert.deepEqual([grok.installed, grok.signedIn, grok.active], [false, false, null]);
  const signedOut = usageTab({ vendors: vendors.map(row => ({ ...row, signedIn: false })), env, now });
  assert.equal(signedOut[0].usage, null); assert.equal(signedOut[0].active, null);
  // The blocks fit the 80-column pane and read as designed.
  const lines = usageBlocks([claude, codex, agy, grok], { now: new Date(now) }), text = lines.map(row => row.text).join('\n');
  assert.ok(lines.every(row => row.text.length <= 76), text);
  assert.match(text, /^Claude {6}owner@example.invalid · Max 20x · active$/m);
  assert.match(text, /^ {12}5h  \[------\]    —   not reported$/m); assert.match(text, /^ {12}wk  \[#-----\]   12%  resets /m);
  assert.match(text, /^ {12}old@example.invalid · last seen \w{3} \d+ · wk 100% then$/m);
  assert.match(text, /^ {12}old@example.invalid · last seen \w{3} \d+ · wk 100% then\n {12}enter use · a add account · x forget$/m); assert.match(text, /^Codex {7}owner@example.invalid · Team · active$/m); assert.match(text, /^ {12}5h  \[##----\]   34%  resets /m);
  assert.match(text, /^Antigravity not signed in for ELU · s signs in$/m); assert.match(text, /^Grok Build {2}not installed$/m);
  const details = usageDetailLines(claude, new Date(now)).join('\n');
  assert.match(details, /owner@example.invalid · Max 20x · default_claude_max_20x\nReported \d\d:\d\d\n\n5h  \[------\]    —   not reported\nwk  \[#-----\]   12%  resets /); assert.match(details, /Other accounts\nold@example.invalid · Pro · first seen/);
  assert.deepEqual(usageDetailLines(grok), ['Not installed.']); assert.deepEqual(usageDetailLines(agy), ['Not signed in for ELU. s signs it in.']);
  // Before a session on Claude Code has reported a window, or once every window it reported
  // has reset, the Claude block and its details say when usage shows.
  for (const seen of [null, { observedAt, fiveHour: { usedPercent: 99, resetsAt: Math.floor(now / 1000) - 1 }, weekly: null }]) {
    fs.writeFileSync(usageFile, JSON.stringify({ version: 1, claude: seen, codex: codexSeen }));
    const [unseen] = usageTab({ vendors, env, now });
    assert.equal(unseen.usage, null);
    assert.deepEqual(usageBlocks([unseen], { now: new Date(now) }).map(row => row.text.trim()).slice(0, 2), ['Claude      owner@example.invalid · Max 20x · active', 'Usage shows after your next session on Claude Code.']);
    assert.deepEqual(usageDetailLines(unseen, new Date(now)).slice(0, 3), ['owner@example.invalid · Max 20x · default_claude_max_20x', '', 'Usage shows after your next session on Claude Code.']);
  }
});

test('the Usage tab reads Antigravity and Grok Build sign-in before their one-time check, starting no turn, and says c runs it', async t => {
  const folder = temp(t); environment(t, { XDG_CONFIG_HOME: path.join(folder, 'personal') });
  const { env } = home(t), now = Date.now(), fake = fakeClis(folder), config = path.join(fake.dir, 'fake.json');
  const calls = () => fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  // detect() never runs such a vendor: null sign-in, and no release.
  const waiting = vendor => ({ vendor, available: true, bin: path.join(fake.dir, vendor), supported: false, signedIn: null, version: null, conformant: false });
  const rows = [waiting('agy'), waiting('grok')], tab = () => { const [, , agy, grok] = usageTab({ vendors: withCheck(rows, { env }), env, now, browser: true }); return { agy, grok }; };
  const text = row => usageBlocks([row], { now: new Date(now) }).map(line => line.text);
  // Before any read: Grok's token file is looked for at once, Antigravity is not read yet.
  let { agy, grok } = tab();
  assert.deepEqual([agy.unchecked, agy.check, agy.signInRead, grok.check, grok.signInRead], [true, 'needed', null, 'needed', false]);
  assert.deepEqual(text(agy), ['Antigravity sign-in not read yet · needs a one-time check (c runs it now)']);
  assert.deepEqual(text(grok), ['Grok Build  not signed in for ELU · s signs in']);
  // On a computer with no browser, the sign-in that needs none: Codex has a device code one, and
  // Antigravity and Grok Build are signed in from ELU either way.
  assert.deepEqual(usageTab({ vendors: [{ vendor: 'codex', available: true, signedIn: false }, ...withCheck(rows, { env })], env, now, browser: false }).map(row => row.signInHint), ['Run: claude', 'Run: codex login --device-auth', 's signs in', 's signs in']);
  assert.deepEqual(usageTab({ vendors: [{ vendor: 'codex', available: true, signedIn: false }], env, now, browser: true })[1].signInHint, 'Run: codex login');
  assert.equal(signInsUnread(rows), true);
  fs.mkdirSync(path.join(env.HOME, '.grok')); fs.writeFileSync(path.join(env.HOME, '.grok', 'auth.json'), '{"token":"never-read"}\n', { mode: 0o600 });
  assert.deepEqual(text(tab().grok), ['Grok Build  signed in · needs a one-time check (c runs it now)']);
  // Antigravity: its release and help, as the check asks first, then agy -p /usage under the
  // private sign-in HOME. Only the exit code is read; nothing reaches a model turn.
  await readSignInsBeforeCheck(rows, { env: { ...process.env, ...env } });
  assert.deepEqual(calls().map(call => [call.vendor, call.args]), [['agy', ['--version']], ['agy', ['--help']], ['agy', ['-p', '/usage', '--output-format', 'json']]]);
  assert.equal(calls().at(-1).home, path.join(personalDirectory(), 'agy-home', 'signin')); assert.equal(calls().at(-1).autoUpdate, 'true');
  assert.equal(fs.existsSync(path.join(folder, 'inputs.jsonl')), false, 'no prompt was sent');
  ({ agy, grok } = tab());
  assert.deepEqual(text(agy), ['Antigravity signed in · needs a one-time check (c runs it now)']);
  assert.equal(signInsUnread(rows), false);
  assert.deepEqual(usageDetailLines(agy), ['Signed in.', '', 'Antigravity CLI has not been checked on this machine yet. Your first message to it runs the check.', 'c runs it now.']);
  // A read is kept for its program: the tab does not ask again until r (all), or for another program.
  await readSignInsBeforeCheck(rows, { env: { ...process.env, ...env } }); assert.equal(calls().length, 3);
  assert.equal(signInsUnread([{ ...rows[0], bin: path.join(folder, 'elsewhere', 'agy') }]), true);
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), agy: { signedIn: false } }));
  await readSignInsBeforeCheck(rows, { env: { ...process.env, ...env }, all: true }); assert.equal(calls().length, 6);
  ({ agy } = tab());
  assert.deepEqual(text(agy), ['Antigravity not signed in for ELU · s signs in']);
  assert.deepEqual(usageDetailLines(agy), ['Not signed in for ELU. s signs it in.', '', 'Antigravity CLI has not been checked on this machine yet. Your first message to it runs the check.', 'c runs it now.']);
  // A release that cannot run here is not asked for its sign-in.
  fs.writeFileSync(path.join(fake.dir, 'agy'), `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('agy version 1.5.4'); else if (process.argv.includes('--help')) console.log('--output-format'); else { require('node:fs').writeFileSync(${JSON.stringify(path.join(folder, 'asked'))}, 'x'); process.exit(0); }\n`, { mode: 0o755 });
  await readSignInsBeforeCheck(rows, { env: { ...process.env, ...env }, all: true });
  assert.equal(fs.existsSync(path.join(folder, 'asked')), false);
  ({ agy } = tab());
  assert.deepEqual(text(agy), ['Antigravity this release cannot run here', '            Antigravity CLI 1.5.4: This untested version is missing required', '            flags: --json-schema, --conversation, --mode, --sandbox,', '            --add-dir, --print-timeout, --dangerously-skip-permissions.']);
  assert.ok(text(agy).every(line => line.length <= 76));
  // Saved: the program, the answer and when; never more.
  const saved = JSON.parse(fs.readFileSync(path.join(personalDirectory(), 'usage.json'), 'utf8')).signIns;
  assert.deepEqual(Object.keys(saved), ['agy']); assert.deepEqual(Object.keys(saved.agy).sort(), ['at', 'bin', 'reason', 'signedIn', 'supported']);
  // Once the check ran, it says where the vendor stands: ready, or which step failed.
  const ran = conformant => withCheck([{ vendor: 'grok', available: true, bin: rows[1].bin, supported: true, signedIn: true, version: '1.0.77', release: '1.0.77', conformant }], { env });
  assert.deepEqual(text(usageTab({ vendors: ran(true), env, now })[3]), ['Grok Build  signed in · ready']);
  atomic(path.join(personalDirectory(), 'conformance', 'grok.json'), { v: 1, bin: rows[1].bin, version: '1.0.77', steps: { signin: 'pass', 'locked-no-write': 'pass', 'locked-no-shell': 'fail', 'locked-no-network': 'pass', json: 'pass', resume: 'pass', relay: 'fail', isolation: 'fail' }, relay: false, at: new Date().toISOString() });
  const failed = usageTab({ vendors: ran(false), env, now })[3];
  assert.deepEqual(text(failed), ['Grok Build  signed in · check failed (c runs it again)', '            Not proven: a read-only turn runs no command, and 1 more.']);
  assert.equal(usageDetailLines(failed).at(-1), 'c runs it again.');
  // A check c started shows its lines under the vendor as it goes, then why it stopped.
  const checks = new Map([['grok', { running: true, lines: ['One-time check of Grok Build on this machine first: about seven short turns on it, a few minutes.'], current: 'Checking Grok Build, 2 of 8 done: a read-only turn writes no file.', error: null }]]);
  assert.deepEqual(usageBlocks([usageTab({ vendors: withCheck([waiting('grok')], { env }), env, now })[3]], { checks }).map(line => line.text), ['Grok Build  signed in · checking…', '            One-time check of Grok Build on this machine first: about seven', '            short turns on it, a few minutes.', '            Checking Grok Build, 2 of 8 done: a read-only turn writes no', '            file.']);
  assert.ok(!calls().some(call => call.vendor === 'grok'), 'grok was never run');
});