import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp, fakeClis, fakeKeychain, claudeKeychainNames } from './helpers.mjs';
import { standInAnthropic, tagOf } from './fakes/anthropic.mjs';
import { personalDirectory } from '../lib/util.mjs';
import { activeLogin, finishLogin, listLogins, loginFolder, newLogin, useLogin } from '../lib/logins.mjs';
import { closeRelay, openLaunch, relayLog } from '../lib/claude-relay.mjs';
import { changeSwitch, moveUp, readSwitch, setExtraUsage, switchOn, setAuto } from '../lib/claude-switch.mjs';
import { noteReading, pick, signIn } from '../lib/claude-accounts.mjs';
import { readAccounts, usageSnapshot, usageTab } from '../lib/usage.mjs';
import { classify, quotaStop } from '../lib/adapters/claude.mjs';
import { shimEnvFile } from '../lib/never-shims.mjs';

// ELU's Claude relay (lib/claude-relay.mjs) against a stand-in Anthropic API on this computer
// (test/fakes/anthropic.mjs), with the requests Claude Code 2.1.325 sends when it is signed in
// with OAuth: its own sign-in as a bearer token, the OAuth beta, and its account in metadata.
// Accounts: a@example.com is the owner's own (default), then b@, c@ added in Usage.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const UUIDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// specs: per account { email, mode, … what the stand-in does (test/fakes/anthropic.mjs), expiresIn (ms) }.
async function pool(t, specs) {
  const dir = temp(t), fake = fakeClis(dir, { mode: 'answer' });
  const config = path.join(dir, 'anthropic.json');
  fs.writeFileSync(config, JSON.stringify({ accounts: {}, refresh: {} }));
  const api = await standInAnthropic(config);
  environment(t, { ...fake.env, HOME: dir, ELU_TEST_ANTHROPIC_URL: api.url });
  t.after(async () => { closeRelay(); await api.close(); });
  closeRelay();
  const accounts = specs.map((spec, at) => {
    const token = `sk-ant-oat01-standin-${String.fromCharCode(97 + at)}-${'x'.repeat(24)}`, refresh = `sk-ant-ort01-standin-${String.fromCharCode(97 + at)}`;
    const slot = at === 0 ? null : newLogin('claude'), id = slot?.id ?? 'default', folder = slot?.dir ?? fake.env.CLAUDE_CONFIG_DIR;
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: spec.email, accountUuid: UUIDS[at], organizationUuid: UUIDS[at], planDisplayName: 'Max 20x' } }));
    fs.writeFileSync(path.join(folder, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: refresh, expiresAt: Date.now() + (spec.expiresIn ?? 8 * 3600 * 1000) } }));
    if (at > 0) finishLogin('claude', id);
    return { ...spec, id, token, refresh, uuid: UUIDS[at], folder };
  });
  api.set(value => { for (const account of accounts) { const { id, token, refresh, uuid, folder, expiresIn, ...rest } = account; value.accounts[token] = rest; value.refresh[refresh] = token; } });
  const setFake = edit => { const file = path.join(fake.dir, 'fake.json'), value = JSON.parse(fs.readFileSync(file, 'utf8')); edit(value); fs.writeFileSync(file, JSON.stringify(value)); };
  setFake(value => { value.api = { tokenUrl: `${api.url}/v1/oauth/token` }; });
  const mode = (email, changes) => api.set(value => { for (const row of Object.values(value.accounts)) if (row.email === email) Object.assign(row, changes); });
  return { dir, api, accounts, fake, bin: path.join(fake.dir, 'claude'), mode, byEmail: email => accounts.find(account => account.email === email) };
}
// One request as Claude Code sends it, on the account whose sign-in it holds.
async function ask(launch, account, { model = 'claude-sonnet-5-5' } = {}) {
  const res = await fetch(`${launch.env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, { method: 'POST', headers: { authorization: `Bearer ${account.token}`, 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'Hello.' }], metadata: { user_id: JSON.stringify({ device_id: 'device-1', account_uuid: account.uuid, session_id: 'session-1' }) } }) });
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
}
const answered = (api, from = 0) => api.calls().slice(from).filter(row => row.path === '/v1/messages');

test('a run on an account with room goes to Anthropic as Claude Code sent it, and its windows are kept for Usage', { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com', fiveHour: 0.4, weekly: 0.7 }, { email: 'b@example.com' }]);
  const [a] = p.accounts, moves = [], launch = await openLaunch({ login: 'default', bin: p.bin, onMove: move => moves.push(move) });
  assert.match(launch.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+\/elu\/[0-9a-f]{64}$/);
  const res = await ask(launch, a);
  assert.equal(res.status, 200); assert.match(res.body, /event: message_stop/);
  const [call] = answered(p.api);
  assert.deepEqual([call.account, call.token, call.uuid], ['a@example.com', tagOf(a.token), a.uuid]);
  assert.deepEqual(moves, []); assert.equal(launch.served(), true);
  assert.equal(usageSnapshot().claude.weekly.usedPercent, 70); assert.equal(usageSnapshot().claude.fiveHour.usedPercent, 40);
  launch.close();
});

test('a weekly limit: the account rests until its week resets, the same request goes on the next account with its own sign-in and id, the account in use moves, and the move is said once', { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com', mode: 'weekly' }, { email: 'b@example.com', weekly: 0.2 }]);
  const [a, b] = p.accounts, moves = [], launch = await openLaunch({ login: 'default', bin: p.bin, onMove: move => moves.push(move) });
  const first = await ask(launch, a);
  assert.equal(first.status, 200, first.body);
  assert.deepEqual(answered(p.api).map(row => [row.account, row.status, row.token, row.uuid]), [['a@example.com', 429, tagOf(a.token), a.uuid], ['b@example.com', 200, tagOf(b.token), b.uuid]]);
  assert.equal(moves.length, 1); assert.deepEqual([moves[0].from, moves[0].to, moves[0].why], ['default', b.id, 'weekly']);
  assert.equal(activeLogin('claude'), b.id, 'new turns start on b');
  const spent = readSwitch().spent.default;
  assert.equal(spent.window, 'weekly'); assert.ok(Date.parse(spent.until) > Date.now() + 2 * 86400000, 'until its week resets');
  assert.deepEqual(readSwitch().lastMove && [readSwitch().lastMove.from, readSwitch().lastMove.to, readSwitch().lastMove.why], ['default', b.id, 'weekly']);
  // Its later requests go to b at once, and the move is not said again.
  const second = await ask(launch, a);
  assert.equal(second.status, 200); assert.deepEqual(answered(p.api).slice(2).map(row => row.account), ['b@example.com']); assert.equal(moves.length, 1);
  // a's week reads 100% in Usage.
  assert.equal(usageSnapshot().claude.weekly.usedPercent, 100);
  // No sign-in anywhere ELU writes, or in what the relay notes.
  for (const name of fs.readdirSync(personalDirectory()).filter(name => name.endsWith('.json'))) {
    const text = fs.readFileSync(path.join(personalDirectory(), name), 'utf8');
    for (const secret of [a.token, b.token, a.refresh, b.refresh, 'sk-ant-']) assert.ok(!text.includes(secret), `${name} holds no sign-in`);
  }
  assert.ok(!JSON.stringify(relayLog()).includes('sk-ant-'));
  assert.doesNotMatch(fs.readFileSync(path.join(personalDirectory(), 'claude-switch.json'), 'utf8'), /@/);
  launch.close();
});

test('a per-minute slowdown is waited out on the same account and never moves it; one longer than a minute goes back to Claude Code without the headers that would end its turn', { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com', mode: 'minute', times: 2, retryAfter: 1 }, { email: 'b@example.com' }]);
  const [a] = p.accounts, moves = [], launch = await openLaunch({ login: 'default', bin: p.bin, onMove: move => moves.push(move) });
  const began = Date.now(), res = await ask(launch, a);
  assert.equal(res.status, 200); assert.ok(Date.now() - began >= 1900, 'it waited the retry-after twice');
  assert.deepEqual(answered(p.api).map(row => [row.account, row.status]), [['a@example.com', 429], ['a@example.com', 429], ['a@example.com', 200]]);
  assert.deepEqual(moves, []); assert.equal(activeLogin('claude'), 'default'); assert.equal(readSwitch().spent, undefined);
  // A slowdown of two minutes is not waited for here: Claude Code gets it, without the unified
  // headers (a 429 with them ends its turn), and tries again by itself.
  p.mode('a@example.com', { mode: 'minute', times: 10, retryAfter: 120 });
  const long = await ask(launch, a);
  assert.equal(long.status, 429); assert.equal(long.headers['x-should-retry'], 'true'); assert.equal(long.headers['retry-after'], '120');
  assert.deepEqual(Object.keys(long.headers).filter(name => name.startsWith('anthropic-ratelimit-unified')), []);
  assert.deepEqual(moves, []);
  launch.close();
});

test('a 429 with no headers at all is tried once more after two seconds, on the same account', { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com', mode: 'headerless', times: 1 }, { email: 'b@example.com' }]);
  const [a] = p.accounts, launch = await openLaunch({ login: 'default', bin: p.bin });
  const began = Date.now(), res = await ask(launch, a);
  assert.equal(res.status, 200); assert.ok(Date.now() - began >= 1900);
  assert.deepEqual(answered(p.api).map(row => [row.account, row.status]), [['a@example.com', 429], ['a@example.com', 200]]);
  launch.close();
});

test('at 98% of a window an account is left for the next request', { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com', weekly: 0.985 }, { email: 'b@example.com' }]);
  const [a, b] = p.accounts, moves = [], launch = await openLaunch({ login: 'default', bin: p.bin, onMove: move => moves.push(move) });
  for (let n = 0; n < 2; n++) assert.equal((await ask(launch, a)).status, 200);
  assert.deepEqual(answered(p.api).map(row => row.account), ['a@example.com', 'b@example.com'], 'the answer at 98.5% is kept, the next request moves');
  assert.deepEqual(moves.map(move => [move.from, move.to, move.why]), [['default', b.id, 'weekly']]);
  launch.close();
});

test('with paid extra usage on, an account at 98% goes on until Anthropic refuses it', { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com', weekly: 0.985 }, { email: 'b@example.com' }]);
  const [a] = p.accounts, moves = [];
  setExtraUsage(true);
  const launch = await openLaunch({ login: 'default', bin: p.bin, onMove: move => moves.push(move) });
  for (let n = 0; n < 3; n++) assert.equal((await ask(launch, a)).status, 200);
  assert.deepEqual(answered(p.api).map(row => row.account), ['a@example.com', 'a@example.com', 'a@example.com']); assert.deepEqual(moves, []);
  launch.close();
});

test("a limit of one model's own moves only that model's requests, and the account stays in use for the others", { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com', mode: 'opus' }, { email: 'b@example.com' }]);
  const [a, b] = p.accounts, moves = [];
  const launch = await openLaunch({ login: 'default', bin: p.bin, onMove: move => moves.push(move) });
  assert.equal((await ask(launch, a, { model: 'claude-opus-5-5' })).status, 200);
  assert.deepEqual(answered(p.api).map(row => [row.account, row.status]), [['a@example.com', 429], ['b@example.com', 200]]);
  assert.deepEqual(moves.map(move => [move.to, move.why, move.model]), [[b.id, 'model', 'opus']]);
  assert.equal(activeLogin('claude'), 'default'); assert.equal(readSwitch().spent.default.model, 'opus');
  launch.close();
  const other = await openLaunch({ login: 'default', bin: p.bin });
  assert.equal((await ask(other, a)).status, 200); assert.equal(answered(p.api).at(-1).account, 'a@example.com');
  other.close();
});

test("the next account: the owner's order first, then the one whose week resets soonest", { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com' }, { email: 'b@example.com', weeklyResetIn: 5 * 86400 }, { email: 'c@example.com', weeklyResetIn: 86400 }]);
  const [a, b, c] = p.accounts;
  // Each account's week as its own answers said it.
  for (const account of [b, c]) { const launch = await openLaunch({ login: account.id, bin: p.bin }); assert.equal((await ask(launch, account)).status, 200); launch.close(); }
  changeSwitch(state => { state.spent = { default: { window: 'weekly', until: new Date(Date.now() + 86400000).toISOString() } }; });
  assert.equal(pick({ exclude: ['default'] }), c.id, "c's week resets first");
  moveUp(b.id); moveUp(b.id);
  assert.deepEqual(readSwitch().order, [b.id, 'default', c.id]);
  assert.equal(pick({ exclude: ['default'] }), b.id, 'the order comes first');
  // A sign-in that lapsed is left out until it is signed in again.
  changeSwitch(state => { state.signIn = { [b.id]: new Date().toISOString() }; });
  assert.equal(pick({ exclude: ['default'] }), c.id);
  assert.deepEqual(listLogins('claude'), ['default', b.id, c.id]); void a;
});

test('requests that move together reach the new account a few at a time at first', { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com', mode: 'weekly' }, { email: 'b@example.com', delayMs: 300 }]);
  const [a] = p.accounts, launch = await openLaunch({ login: 'default', bin: p.bin });
  const all = await Promise.all([0, 1, 2, 3].map(() => ask(launch, a)));
  assert.deepEqual(all.map(row => row.status), [200, 200, 200, 200]);
  const onB = answered(p.api).filter(row => row.account === 'b@example.com');
  assert.equal(onB.length, 4);
  // One at first, one more every quarter second: never all four at once.
  assert.ok(Math.max(...onB.map(row => row.active)) <= 3, `never all at once on b, got ${onB.map(row => row.active)}`);
  launch.close();
});

test('every account at its limit: a request gets one refusal that says when the first one resets; an account free within seconds is waited for', { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com', mode: 'weekly' }, { email: 'b@example.com', mode: 'fiveHour' }]);
  const [a, b] = p.accounts, launch = await openLaunch({ login: 'default', bin: p.bin });
  const res = await ask(launch, a);
  assert.equal(res.status, 429);
  assert.equal(res.headers['anthropic-ratelimit-unified-status'], 'rejected');
  // b's five hours reset first, in about three hours.
  const reset = Number(res.headers['anthropic-ratelimit-unified-reset']) * 1000;
  assert.ok(Math.abs(reset - Date.parse(readSwitch().spent[b.id].until)) < 2000, 'the first account to reset');
  assert.equal(res.headers['anthropic-ratelimit-unified-5h-status'], 'rejected');
  // Nearly three hours later, b is free in two seconds: the request waits for it.
  changeSwitch(state => { state.spent[b.id].until = new Date(Date.now() + 2000).toISOString(); });
  noteReading(b.id, { fiveHour: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) + 2 } });
  p.mode('b@example.com', { mode: 'ok' });
  const began = Date.now(), later = await ask(launch, a);
  assert.equal(later.status, 200); assert.ok(Date.now() - began >= 1500); assert.equal(answered(p.api).at(-1).account, 'b@example.com');
  launch.close();
});

test('a sign-in about to end is renewed by Claude Code itself, and the request goes on with the new one; the old one is never sent again', { timeout: 40000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com', mode: 'weekly' }, { email: 'b@example.com', expiresIn: 2 * 60 * 1000 }]);
  const [a, b] = p.accounts, credentials = path.join(b.folder, '.credentials.json'), before = fs.readFileSync(credentials, 'utf8');
  const launch = await openLaunch({ login: 'default', bin: p.bin });
  const res = await ask(launch, a);
  assert.equal(res.status, 200, res.body);
  const renewed = p.api.calls().find(row => row.path === '/v1/oauth/token');
  assert.ok(renewed, 'claude auth status renewed it'); assert.equal(renewed.was, tagOf(b.token));
  const now = JSON.parse(fs.readFileSync(credentials, 'utf8')).claudeAiOauth;
  assert.notEqual(now.accessToken, b.token); assert.ok(now.expiresAt > Date.now() + 3600000);
  assert.notEqual(fs.readFileSync(credentials, 'utf8'), before);
  const onB = answered(p.api).filter(row => row.account === 'b@example.com');
  assert.deepEqual(onB.map(row => [row.token, row.status]), [[tagOf(now.accessToken), 200]], 'only the new sign-in reached Anthropic');
  assert.equal((await ask(launch, a)).status, 200);
  assert.ok(answered(p.api).every(row => row.token !== tagOf(b.token)), 'the old one is never sent');
  launch.close();
});

test('a sign-in that no longer works and cannot be renewed: the account is left out to sign in again, and the request goes on another', { timeout: 40000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com', mode: 'weekly' }, { email: 'b@example.com', mode: 'expired' }, { email: 'c@example.com' }]);
  const [a, b] = p.accounts, launch = await openLaunch({ login: 'default', bin: p.bin });
  const res = await ask(launch, a);
  assert.equal(res.status, 200, res.body); assert.equal(answered(p.api).at(-1).account, 'c@example.com');
  assert.ok(readSwitch().signIn[b.id], 'b waits for a sign-in');
  launch.close();
});

test('a sign-in that could not be renewed for one request is taken back as soon as one that works is read', { timeout: 40000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com', mode: 'weekly' }, { email: 'b@example.com', expiresIn: -60 * 1000 }]);
  const [a, b] = p.accounts, credentials = path.join(b.folder, '.credentials.json');
  // b's sign-in has ended, and the address Claude Code renews it at cannot be reached.
  const file = path.join(p.fake.dir, 'fake.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), api: { tokenUrl: 'http://127.0.0.1:9/v1/oauth/token' } }));
  const launch = await openLaunch({ login: 'default', bin: p.bin });
  assert.equal((await ask(launch, a)).status, 429, 'a is at its limit and b could not be renewed');
  // Claude Code renews it later, on its own: b has a sign-in that works for hours.
  const renewedToken = `sk-ant-oat01-standin-b-renewed-${'y'.repeat(16)}`;
  p.api.set(value => { value.accounts[renewedToken] = { email: 'b@example.com' }; });
  fs.writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: renewedToken, refreshToken: 'sk-ant-ort01-standin-b-2', expiresAt: Date.now() + 8 * 3600 * 1000 } }));
  const res = await ask(launch, a);
  assert.equal(res.status, 200, res.body); assert.deepEqual([answered(p.api).at(-1).account, answered(p.api).at(-1).token], ['b@example.com', tagOf(renewedToken)]);
  assert.equal(readSwitch().signIn?.[b.id], undefined, 'b is not waiting for a sign-in');
  const [claude] = usageTab({ vendors: [{ vendor: 'claude', available: true, signedIn: true }], now: Date.now() });
  assert.equal(claude.accounts.find(row => row.login === b.id).needsSignIn, undefined, 'Usage does not say sign in again');
  launch.close();
});

test('the account a run started on is never left because of a sign-in mark: that run uses Claude Code\'s own sign-in', { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com' }, { email: 'b@example.com' }]);
  const [a] = p.accounts, moves = [];
  changeSwitch(state => { state.signIn = { default: new Date().toISOString() }; });
  const launch = await openLaunch({ login: 'default', bin: p.bin, onMove: move => moves.push(move) });
  assert.equal((await ask(launch, a)).status, 200);
  assert.deepEqual(answered(p.api).map(row => row.account), ['a@example.com']); assert.deepEqual(moves, []); assert.equal(activeLogin('claude'), 'default');
  launch.close();
});

test("the last reading of a run's answers is saved for Usage when the run ends, however soon after the one before", { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com', fiveHour: 0.2, weekly: 0.5 }, { email: 'b@example.com' }]);
  const [a] = p.accounts, launch = await openLaunch({ login: 'default', bin: p.bin });
  assert.equal((await ask(launch, a)).status, 200);
  assert.deepEqual([usageSnapshot().claude.fiveHour.usedPercent, usageSnapshot().claude.weekly.usedPercent], [20, 50]);
  p.mode('a@example.com', { fiveHour: 0.8, weekly: 0.9 });
  assert.equal((await ask(launch, a)).status, 200);
  launch.close();
  assert.deepEqual([usageSnapshot().claude.fiveHour.usedPercent, usageSnapshot().claude.weekly.usedPercent], [80, 90]);
});

test('a refusal that rejects the account as a whole while each of its windows allowed it is a slowdown: waited out on the same account, no account moves', { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com', mode: 'claimOnly', times: 1, retryAfter: 1 }, { email: 'b@example.com' }]);
  const [a] = p.accounts, moves = [], launch = await openLaunch({ login: 'default', bin: p.bin, onMove: move => moves.push(move) });
  assert.equal((await ask(launch, a)).status, 200);
  assert.deepEqual(answered(p.api).map(row => [row.account, row.status]), [['a@example.com', 429], ['a@example.com', 200]]);
  assert.deepEqual(moves, []); assert.equal(readSwitch().spent, undefined); assert.equal(activeLogin('claude'), 'default');
  launch.close();
});

test("a stop of Claude Code's whose windows all allowed the request is a slowdown, not an account's limit", () => {
  const stop = info => [JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.3 }, seven_day: { utilization: 0.4 } } } }), JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, api_error: 'usage_limit_reached', api_error_params: { rate_limit_info: info }, result: "You've hit your 5-hour limit · resets 5pm" })].join('\n');
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const allowed = stop({ status: 'allowed', resetsAt: reset, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.3 }, seven_day: { utilization: 0.4 } } });
  assert.equal(quotaStop(allowed), null); assert.equal(classify(allowed), 'rate-limit');
  const weekly = stop({ status: 'rejected', resetsAt: reset, rateLimitType: 'seven_day', overageStatus: 'rejected' });
  assert.deepEqual(quotaStop(weekly), { window: 'weekly', model: null, until: reset * 1000 }); assert.equal(classify(weekly), 'quota');
});

test('only a live launch reaches the relay, and only for the API', { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com' }, { email: 'b@example.com' }]);
  const [a] = p.accounts, launch = await openLaunch({ login: 'default', bin: p.bin });
  const base = launch.env.ANTHROPIC_BASE_URL, other = base.replace(/[0-9a-f]{64}$/, '0'.repeat(64));
  assert.equal((await fetch(`${other}/v1/messages`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/elsewhere`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await ask(launch, a)).status, 200);
  launch.close();
  assert.equal((await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' })).status, 404, 'a launch that ended');
  assert.equal(answered(p.api).length, 1);
});

test("a sign-in kept in the macOS Keychain is read with the Keychain's own command", { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com' }, { email: 'b@example.com' }]);
  const keychain = path.join(p.dir, 'keychain'), names = claudeKeychainNames(loginFolder('claude', p.accounts[1].id));
  fakeKeychain(keychain, []);
  const { spawnSync } = await import('node:child_process');
  const saved = spawnSync(path.join(keychain, 'security'), ['add-generic-password', '-U', '-a', process.env.USER || 'claude-code-user', '-s', names.credentials, '-X', Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-from-keychain', expiresAt: Date.now() + 3600000 } })).toString('hex')]);
  assert.equal(saved.status, 0);
  const env = { ...process.env, PATH: `${keychain}${path.delimiter}${process.env.PATH}`, USER: process.env.USER || 'claude-code-user' };
  const read = await signIn(p.accounts[1].id, { env, platform: 'darwin', force: true });
  assert.equal(read.accessToken, 'sk-ant-oat01-from-keychain');
  assert.ok(!fs.readFileSync(path.join(keychain, 'keychain.json'), 'utf8').includes('from-keychain'));
});

test('switching is on with two or more Claude accounts and one setting turns it off; the env file a command reads takes the relay address away', { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com' }, { email: 'b@example.com' }]);
  assert.equal(switchOn(), true);
  setAuto(false); assert.equal(switchOn(), false); setAuto(true); assert.equal(switchOn(), true);
  const file = shimEnvFile({ unset: ['ANTHROPIC_BASE_URL'] });
  assert.match(fs.readFileSync(file, 'utf8'), /^unset ANTHROPIC_BASE_URL$/m);
  assert.doesNotMatch(fs.readFileSync(shimEnvFile(), 'utf8'), /unset/);
  void p;
});

// lib/logins.mjs is as 0.1.26 shipped it: its change() rewrites logins.json with the fields it knows.
test("ELU 0.1.26 changes logins.json with its known fields only, and leaves claude-switch.json as it is", { timeout: 30000 }, async t => {
  const p = await pool(t, [{ email: 'a@example.com' }, { email: 'b@example.com' }]);
  setExtraUsage(true); moveUp(p.accounts[1].id);
  const file = path.join(personalDirectory(), 'claude-switch.json'), kept = fs.readFileSync(file, 'utf8'), logins = path.join(personalDirectory(), 'logins.json');
  useLogin('claude', p.accounts[1].id);
  assert.equal(fs.readFileSync(file, 'utf8'), kept);
  assert.doesNotMatch(fs.readFileSync(logins, 'utf8'), /extraUsage|order|spent|@/);
  assert.equal(activeLogin('claude'), p.accounts[1].id);
  assert.deepEqual(readAccounts().filter(row => /token|sk-ant/.test(JSON.stringify(row))), []);
});
