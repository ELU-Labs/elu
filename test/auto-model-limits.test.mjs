import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { temp, fakeClis, fakeKeychain } from './helpers.mjs';
import { standInAnthropic } from './fakes/anthropic.mjs';
import { activeLogin, finishLogin, newLogin, useLogin } from '../lib/logins.mjs';
import { changeSwitch, familyOf, markSignIn, markSpent, notePicked, readSwitch, setAuto, setExtraUsage, switchOn } from '../lib/claude-switch.mjs';
import { claudeModelFree, familyOf as familyOfAccounts, firstFree, limitOf, modelOver, pick, usable } from '../lib/claude-accounts.mjs';
import { closeRelay, familyOf as familyOfRelay, openLaunch } from '../lib/claude-relay.mjs';
import { keepClaudeUsage, readAccounts } from '../lib/usage.mjs';
import { botModels, keptModels, modelsFile, readBotModels } from '../lib/bot-models.mjs';

// The limits Auto model goes by when it sends a step to a model: whether a Claude model has
// room now and until when (claudeModelFree and modelOver in lib/claude-accounts.mjs), the
// relay's refusal that names one model's own week for a run that asked for it
// (lib/claude-relay.mjs), and Codex's model names saved between starts (lib/bot-models.mjs).
// Nothing here starts a vendor's program: the accounts are files in a temp folder, Anthropic
// is the stand-in on this computer, and Codex is a stand-in script.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const UUIDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// The Claude accounts signed in here, by the files that name them: the first is the owner's
// own (default), each next one added as Usage adds it.
function signedIn(t, emails) {
  const dir = temp(t), config = path.join(dir, 'claude');
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  environment(t, { XDG_CONFIG_HOME: path.join(dir, 'personal'), HOME: path.join(dir, 'home'), CLAUDE_CONFIG_DIR: config });
  return emails.map((email, at) => {
    const slot = at === 0 ? null : newLogin('claude'), id = slot?.id ?? 'default', folder = slot?.dir ?? config;
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: UUIDS[at], organizationUuid: UUIDS[at], planDisplayName: 'Max 20x' } }));
    if (at > 0) finishLogin('claude', id);
    return { id, email, folder };
  });
}
// One model's own week as a run reports it and Usage keeps it with the account (accounts.json).
function week(login, family, { used = 100, reached = false, until = Date.now() + 3 * DAY, observedAt = new Date().toISOString() } = {}) {
  keepClaudeUsage(login, { models: [{ id: family, weekly: { usedPercent: used, resetsAt: Math.round(until / 1000), ...(reached ? { reached: true } : {}) } }], observedAt });
  return Math.round(until / 1000) * 1000;
}

test('a model is named by its family the same way wherever a limit is read', () => {
  assert.equal(familyOfAccounts, familyOf); assert.equal(familyOfRelay, familyOf);
  for (const [name, family] of [['fable', 'fable'], ['opus', 'opus'], ['claude-fable-5-2', 'fable'], ['claude-opus-5-5', 'opus'], ['claude-haiku-5-5', 'haiku'], ['Sonnet', 'sonnet'], ['opus[1m]', 'opus'], ['us.anthropic.claude-fable-5-2-v1:0', 'fable'], ['gpt-6-astra', null], ['opusplan', null], ['', null], [null, null], [undefined, null]]) assert.equal(familyOf(name), family, String(name));
});

test('one account, a mark: the model the mark names has no room until the mark ends, and every other model has', t => {
  signedIn(t, ['a@example.com']);
  const now = Date.now(), until = now + 3 * DAY;
  assert.deepEqual(claudeModelFree('fable'), { free: true }, 'nothing is known: it has room');
  markSpent('default', { window: 'model', until, model: 'fable' });
  for (const name of ['fable', 'claude-fable-5-2', 'Fable']) assert.deepEqual(claudeModelFree(name, { now }), { free: false, until, why: 'model' }, name);
  assert.deepEqual(modelOver('default', 'fable', { now }), { window: 'model', model: 'fable', until, reached: true }, 'a mark is a refusal');
  assert.equal(modelOver('default', 'opus', { now }), null);
  assert.deepEqual(claudeModelFree('opus', { now }), { free: true });
  assert.deepEqual(claudeModelFree('claude-haiku-5-5', { now }), { free: true });
  assert.deepEqual(claudeModelFree('some-other-model', { now }), { free: true }, 'a model of no known family has no week of its own');
  assert.deepEqual(claudeModelFree('fable', { now: until + 1 }), { free: true }, 'the mark has ended');
  // A limit of the account's own holds every model alike, and is not the model's own week.
  markSpent('default', { window: 'fiveHour', until: now + 3 * HOUR });
  for (const name of ['fable', 'opus']) assert.deepEqual(claudeModelFree(name, { now }), { free: false, until: now + 3 * HOUR, why: 'account' }, name);
});

test('one account, a row for the model\'s own week: a week Anthropic refused holds the model until its reset, with no mark and with switching off', t => {
  signedIn(t, ['a@example.com']);
  assert.equal(switchOn(), false, 'one account never switches');
  const until = week('default', 'fable', { reached: true }), now = Date.now();
  assert.deepEqual(readAccounts()[0].usage.models, [{ id: 'fable', weekly: { usedPercent: 100, resetsAt: until / 1000, reached: true } }]);
  assert.equal(readSwitch().spent, undefined, 'no mark was written');
  assert.deepEqual(modelOver('default', 'fable', { now }), { window: 'model', model: 'fable', until, reached: true });
  assert.deepEqual(modelOver('default', 'claude-fable-5-2', { now }), { window: 'model', model: 'fable', until, reached: true });
  assert.equal(modelOver('default', 'opus', { now }), null); assert.equal(modelOver('default', 'gpt-6-astra', { now }), null); assert.equal(modelOver('abcd1234', 'fable', { now }), null, 'an account that is not here');
  assert.deepEqual(claudeModelFree('fable', { now }), { free: false, until, why: 'model' });
  assert.deepEqual(claudeModelFree('opus', { now }), { free: true }, 'the work model answers');
  assert.equal(modelOver('default', 'fable', { now: until + 1 }), null); assert.deepEqual(claudeModelFree('fable', { now: until + 1 }), { free: true }, 'the week has reset');
  // What moves work between accounts goes by the marks and the account's own windows, as before.
  assert.equal(usable('default', { model: 'fable', now }), true); assert.equal(limitOf('default', { model: 'fable', now }), null);
  assert.deepEqual(firstFree({ model: 'fable', now }), { id: 'default', at: now }); assert.equal(pick({ model: 'fable', now }), 'default');
  // Opus at its own week too: neither has room, each for its own week.
  const opus = week('default', 'opus', { reached: true, until: now + 5 * DAY });
  assert.deepEqual(claudeModelFree('opus', { now }), { free: false, until: opus, why: 'model' }); assert.deepEqual(claudeModelFree('fable', { now }), { free: false, until, why: 'model' });
  assert.deepEqual(claudeModelFree('sonnet', { now }), { free: true });
});

test('"Use paid extra usage" off: a model at 98% of its own week counts as at its limit; on: only a week Anthropic refused does', t => {
  signedIn(t, ['a@example.com']);
  const now = Date.now(), resets = now + 3 * DAY, until = week('default', 'fable', { used: 99, until: resets });
  assert.equal(readSwitch().extraUsage, undefined, 'off unless the owner turns it on');
  assert.deepEqual(modelOver('default', 'fable', { now }), { window: 'model', model: 'fable', until, reached: false });
  assert.deepEqual(claudeModelFree('fable', { now }), { free: false, until, why: 'model' });
  week('default', 'fable', { used: 97, until: resets });
  assert.equal(modelOver('default', 'fable', { now }), null); assert.deepEqual(claudeModelFree('fable', { now }), { free: true }, 'under the threshold');
  changeSwitch(state => { state.threshold = 0.9; });
  assert.deepEqual(claudeModelFree('fable', { now }), { free: false, until, why: 'model' }, 'the threshold is the one accounts switch at');
  changeSwitch(state => { delete state.threshold; });
  week('default', 'fable', { used: 99, until: resets });
  setExtraUsage(true);
  assert.equal(modelOver('default', 'fable', { now }), null); assert.deepEqual(claudeModelFree('fable', { now }), { free: true }, 'it goes on until Anthropic refuses it');
  week('default', 'fable', { used: 100, reached: true, until: resets });
  assert.deepEqual(claudeModelFree('fable', { now }), { free: false, until, why: 'model' }, 'refused: at its limit whatever the setting');
  setExtraUsage(false);
  assert.deepEqual(claudeModelFree('fable', { now }), { free: false, until, why: 'model' });
  // A share with no reset says nothing of when, so it holds nothing.
  keepClaudeUsage('default', { models: [{ id: 'opus', weekly: { usedPercent: 100, resetsAt: null } }], observedAt: new Date().toISOString() });
  assert.equal(modelOver('default', 'opus', { now }), null); assert.deepEqual(claudeModelFree('opus', { now }), { free: true });
});

test('an account keeps one mark: a five-hour limit that replaced the mark of a model\'s week does not free the model when it ends', t => {
  signedIn(t, ['a@example.com']);
  const now = Date.now(), until = week('default', 'fable', { reached: true });
  markSpent('default', { window: 'model', until, model: 'fable' });
  markSpent('default', { window: 'fiveHour', until: now + 3 * HOUR });
  assert.deepEqual(readSwitch().spent.default, { window: 'fiveHour', until: new Date(now + 3 * HOUR).toISOString() }, 'the later mark took its place');
  assert.deepEqual(claudeModelFree('opus', { now }), { free: false, until: now + 3 * HOUR, why: 'account' });
  assert.deepEqual(claudeModelFree('fable', { now }), { free: false, until, why: 'account' }, 'the account\'s own limit holds it now, and its own week after');
  const later = now + 3 * HOUR + 1;
  assert.deepEqual(claudeModelFree('opus', { now: later }), { free: true });
  assert.deepEqual(claudeModelFree('fable', { now: later }), { free: false, until, why: 'model' }, 'what Usage keeps of the refusal still holds it');
});

test('the owner chose the account by hand: what was read of the model\'s week before that says nothing, and a reading after it holds again', async t => {
  signedIn(t, ['a@example.com']);
  const resets = Date.now() + 3 * DAY, until = week('default', 'fable', { reached: true, until: resets, observedAt: new Date(Date.now() - 1000).toISOString() });
  markSpent('default', { window: 'model', until, model: 'fable' });
  assert.equal(claudeModelFree('fable').free, false);
  notePicked('default');
  assert.equal(readSwitch().spent, undefined); assert.deepEqual(claudeModelFree('fable'), { free: true }, 'he chose it to be tried');
  await sleep(5);
  week('default', 'fable', { reached: true, until: resets });
  assert.deepEqual(claudeModelFree('fable'), { free: false, until, why: 'model' }, 'tried, and refused again');
});

test('two accounts that take over from each other: another account is tried first, and the other model only when no account has the model left', t => {
  const [a, b] = signedIn(t, ['a@example.com', 'b@example.com']);
  assert.equal(switchOn(), true); assert.equal(activeLogin('claude'), 'default');
  const now = Date.now(), first = now + 2 * DAY, second = now + 4 * DAY;
  markSpent(a.id, { window: 'model', until: second, model: 'fable' });
  assert.deepEqual(claudeModelFree('fable', { now }), { free: true }, 'the other account has it');
  // The other account's own week of the model is used up too, as Usage keeps it.
  week(b.id, 'fable', { reached: true, until: first });
  assert.deepEqual(claudeModelFree('fable', { now }), { free: false, until: Math.round(first / 1000) * 1000, why: 'model' }, 'until the first of them has it again');
  assert.deepEqual(claudeModelFree('opus', { now }), { free: true });
  // One held by the model's week and the other by its own five hours: the model's week is
  // still what stands in the way, since the first account would take another model now.
  week(b.id, 'fable', { used: 10, until: first });
  markSpent(b.id, { window: 'fiveHour', until: now + 3 * HOUR });
  assert.deepEqual(claudeModelFree('fable', { now }), { free: false, until: now + 3 * HOUR, why: 'model' });
  assert.deepEqual(claudeModelFree('opus', { now }), { free: true });
  // Both at their own limits: every model meets that alike, so it is not a reason to change model.
  markSpent(a.id, { window: 'weekly', until: second });
  assert.deepEqual(claudeModelFree('fable', { now }), { free: false, until: now + 3 * HOUR, why: 'account' });
  assert.deepEqual(claudeModelFree('opus', { now }), { free: false, until: now + 3 * HOUR, why: 'account' });
});

test('switching turned off, or one account waiting for a sign-in: only an account a turn can run on counts', t => {
  const [a, b] = signedIn(t, ['a@example.com', 'b@example.com']);
  const now = Date.now(), until = now + 2 * DAY;
  markSpent(a.id, { window: 'model', until, model: 'fable' });
  assert.deepEqual(claudeModelFree('fable', { now }), { free: true });
  // The other account needs to sign in again: it is left out, and says nothing of when.
  markSignIn(b.id);
  assert.deepEqual(claudeModelFree('fable', { now }), { free: false, until, why: 'model' });
  markSignIn(b.id, false);
  // A mark for a sign-in on the account in use says nothing: a turn there runs on Claude Code's own.
  markSignIn(a.id); markSpent(b.id, { window: 'model', until, model: 'fable' });
  changeSwitch(state => { delete state.spent[a.id]; });
  assert.deepEqual(claudeModelFree('fable', { now }), { free: true });
  markSignIn(a.id, false); markSpent(a.id, { window: 'model', until, model: 'fable' });
  changeSwitch(state => { delete state.spent[b.id]; });
  // Off: a turn stays on the account in use, so only that one is looked at.
  setAuto(false);
  assert.equal(switchOn(), false);
  assert.deepEqual(claudeModelFree('fable', { now }), { free: false, until, why: 'model' }, 'the account in use has none, and nothing moves by itself');
  useLogin('claude', b.id);
  assert.deepEqual(claudeModelFree('fable', { now }), { free: true }, 'the owner moved to the other account');
  // The accounts to look at, and the one that runs on its own sign-in, can be named by the caller.
  assert.deepEqual(claudeModelFree('fable', { now, ids: [a.id], own: a.id }), { free: false, until, why: 'model' });
  assert.deepEqual(claudeModelFree('fable', { now, ids: [] }), { free: true });
});

// The relay, with two accounts that are both at Opus's own week (the stand-in's mode opus).
async function relayed(t, modes) {
  const dir = temp(t), fake = fakeClis(dir, { mode: 'answer' }), config = path.join(dir, 'anthropic.json');
  fakeKeychain(fake.dir, []);
  fs.writeFileSync(config, JSON.stringify({ accounts: {}, refresh: {} }));
  const api = await standInAnthropic(config);
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  environment(t, { ...fake.env, HOME: path.join(dir, 'home'), ELU_TEST_ANTHROPIC_URL: api.url });
  t.after(async () => { closeRelay(); await api.close(); });
  closeRelay();
  const accounts = modes.map((mode, at) => {
    const email = `${String.fromCharCode(97 + at)}@example.com`, token = `sk-ant-oat01-standin-${String.fromCharCode(97 + at)}-${'x'.repeat(24)}`;
    const slot = at === 0 ? null : newLogin('claude'), id = slot?.id ?? 'default', folder = slot?.dir ?? fake.env.CLAUDE_CONFIG_DIR;
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: UUIDS[at], organizationUuid: UUIDS[at], planDisplayName: 'Max 20x' } }));
    fs.writeFileSync(path.join(folder, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `sk-ant-ort01-standin-${at}`, expiresAt: Date.now() + 8 * HOUR } }));
    if (at > 0) finishLogin('claude', id);
    return { id, email, token, uuid: UUIDS[at], mode };
  });
  api.set(value => { for (const { token, email, mode } of accounts) value.accounts[token] = { email, mode }; });
  const ask = async (launch, model) => {
    const [account] = accounts, res = await fetch(`${launch.env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, { method: 'POST', headers: { authorization: `Bearer ${account.token}`, 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'Hello.' }], metadata: { user_id: JSON.stringify({ device_id: 'device-1', account_uuid: account.uuid, session_id: 'session-1' }) } }) });
    return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
  };
  return { accounts, ask, bin: path.join(fake.dir, 'claude'), api };
}
const H = 'anthropic-ratelimit-unified-';

test('the relay: every account at one model\'s own week is refused as the accounts\' limit, as before; a run that asked for it is told it is that model\'s week', { timeout: 30000 }, async t => {
  const p = await relayed(t, ['opus', 'opus']), [a, b] = p.accounts;
  const plain = await openLaunch({ login: 'default', bin: p.bin });
  const before = await p.ask(plain, 'claude-opus-5-5');
  assert.equal(before.status, 429);
  assert.deepEqual([readSwitch().spent[a.id].model, readSwitch().spent[b.id].model], ['opus', 'opus'], 'each account was tried and is held for Opus');
  assert.equal(before.headers[`${H}7d-status`], 'rejected'); assert.equal(before.headers[`${H}representative-claim`], 'seven_day');
  assert.equal(before.headers[`${H}7d_opus-status`], undefined, 'a run that did not ask is told nothing of the model');
  assert.match(before.body, /Every Claude account signed in to ELU is at its limit\./);
  assert.equal((await p.ask(plain, 'claude-sonnet-5-5')).status, 200, 'the accounts take every other model');
  plain.close();
  const asked = await openLaunch({ login: 'default', bin: p.bin, modelStop: true });
  const after = await p.ask(asked, 'claude-opus-5-5');
  assert.equal(after.status, 429); assert.equal(after.headers[`${H}status`], 'rejected');
  assert.equal(after.headers[`${H}7d_opus-status`], 'rejected'); assert.equal(after.headers[`${H}representative-claim`], 'seven_day_opus');
  assert.equal(after.headers[`${H}7d-status`], undefined); assert.equal(after.headers[`${H}5h-status`], undefined);
  const held = claudeModelFree('opus');
  assert.equal(held.why, 'model'); assert.equal(Number(after.headers[`${H}7d_opus-reset`]), Math.ceil(held.until / 1000), 'when Opus has room again');
  assert.equal(after.headers[`${H}reset`], after.headers[`${H}7d_opus-reset`]);
  assert.match(after.body, /at its limit for Opus\./);
  assert.deepEqual(claudeModelFree('fable'), { free: true }, 'the session\'s other model has room');
  assert.equal((await p.ask(asked, 'claude-sonnet-5-5')).status, 200);
  asked.close();
});

test('the relay: a run that asked is still told of the accounts\' own limits when those are what holds them', { timeout: 30000 }, async t => {
  const p = await relayed(t, ['weekly', 'weekly']);
  const asked = await openLaunch({ login: 'default', bin: p.bin, modelStop: true });
  const res = await p.ask(asked, 'claude-opus-5-5');
  assert.equal(res.status, 429); assert.equal(res.headers[`${H}7d-status`], 'rejected'); assert.equal(res.headers[`${H}representative-claim`], 'seven_day');
  assert.equal(res.headers[`${H}7d_opus-status`], undefined);
  assert.equal(claudeModelFree('opus').why, 'account');
  asked.close();
});

// Codex's names between starts. The stand-in prints what `codex debug models --bundled` prints
// and records each call; a new start is a new process that only reads what was saved.
const CODEX = { models: [
  { slug: 'gpt-6-astra', description: 'The most capable model.', visibility: 'list', default_reasoning_level: 'high' },
  { slug: 'gpt-6.1-sol', description: 'For everyday coding.', visibility: 'list', default_reasoning_level: 'medium' },
  { slug: 'gpt-6-luna', description: 'Fast and affordable.', visibility: 'list' },
  { slug: 'gpt-6-review', description: 'Hidden.', visibility: 'hide' },
] };
const NAMES = [{ name: 'gpt-6-astra', note: 'The most capable model.', effort: 'high' }, { name: 'gpt-6.1-sol', note: 'For everyday coding.', effort: 'medium' }, { name: 'gpt-6-luna', note: 'Fast and affordable.' }];
function standIn(t, vendor, catalog) {
  const dir = temp(t), calls = path.join(dir, 'calls.txt'), file = path.join(dir, vendor);
  const write = value => fs.writeFileSync(file, `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');\nfs.writeSync(1, ${JSON.stringify(typeof value === 'string' ? value : JSON.stringify(value))});\n`, { mode: 0o755 });
  write(catalog);
  return { dir, env: { PATH: dir, HOME: dir }, write, calls: () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [] };
}
// What a new start of ELU knows of a vendor's models before it has read the vendor: a process
// of its own, with the stand-in's folder as its home.
const BOT_MODELS = fileURLToPath(new URL('../lib/bot-models.mjs', import.meta.url));
function newStart(cli, vendor = 'codex') {
  const script = `import { botModels, keptModels } from ${JSON.stringify(BOT_MODELS)}; console.log(JSON.stringify({ kept: keptModels(${JSON.stringify(vendor)}), read: botModels(${JSON.stringify(vendor)}) }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: cli.env, cwd: cli.dir, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('Codex\'s model names are saved between starts: the next start has them with no program run, and a new release is not taken for the old one', { timeout: 120000 }, async t => {
  const cli = standIn(t, 'codex', CODEX), file = modelsFile(cli.env);
  assert.equal(file, path.join(cli.dir, '.config', 'elu-code', 'vendor-models.json'), 'in the personal folder of the environment the read is asked with');
  assert.deepEqual(keptModels('codex', { env: cli.env }), []); assert.deepEqual(botModels('codex', { env: cli.env }), []);
  assert.deepEqual(cli.calls(), [], 'asking for the kept names starts no program'); assert.equal(fs.existsSync(file), false);
  assert.deepEqual(await readBotModels('codex', { env: cli.env, timeoutMs: 60000 }), NAMES);
  assert.deepEqual(keptModels('codex', { env: cli.env }), NAMES);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')), program = fs.statSync(path.join(cli.dir, 'codex'));
  assert.deepEqual(saved, { version: 1, programs: [{ vendor: 'codex', file: fs.realpathSync(path.join(cli.dir, 'codex')), size: program.size, mtimeMs: program.mtimeMs, models: NAMES }] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // The next start: the names are there before Codex is asked, and what the Model step shows
  // before its own read is as it was.
  assert.deepEqual(newStart(cli), { kept: NAMES, read: [] });
  assert.deepEqual(cli.calls(), ['debug models --bundled'], 'the program ran once, for the first read');
  // Codex is updated: the names of the release before it are not this one's.
  cli.write({ models: [{ slug: 'gpt-7-astra', description: 'Newer.', visibility: 'list' }] });
  assert.deepEqual(newStart(cli), { kept: [], read: [] });
  assert.deepEqual(cli.calls(), ['debug models --bundled']);
});

test('the saved names are read as carefully as the program\'s own: a file that is not ELU\'s, or holds a name no bot could save, gives none of it', { timeout: 120000 }, async t => {
  const cli = standIn(t, 'codex', CODEX), file = modelsFile(cli.env), program = fs.statSync(path.join(cli.dir, 'codex'));
  const row = models => ({ vendor: 'codex', file: fs.realpathSync(path.join(cli.dir, 'codex')), size: program.size, mtimeMs: program.mtimeMs, models });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const text of ['not json', '[]', '{"programs":"none"}', JSON.stringify({ version: 1, programs: [{ ...row(NAMES), vendor: 'claude' }] }), JSON.stringify({ version: 1, programs: [{ ...row(NAMES), size: program.size + 1 }] }), JSON.stringify({ version: 1, programs: [row('names')] })]) {
    fs.writeFileSync(file, text); assert.deepEqual(newStart(cli), { kept: [], read: [] }, text);
  }
  fs.writeFileSync(file, JSON.stringify({ version: 1, programs: [row([{ name: 'gpt-6-astra', note: 'x'.repeat(300), effort: 'HIGH!' }, { name: 'two words' }, { name: 7 }, null, { name: 'gpt-6-luna', note: 5 }])] }));
  assert.deepEqual(newStart(cli).kept, [{ name: 'gpt-6-astra', note: 'x'.repeat(120) }, { name: 'gpt-6-luna', note: '5' }]);
  assert.deepEqual(cli.calls(), [], 'nothing was run');
  // A read that gives no names saves nothing.
  const none = standIn(t, 'codex', 'not json');
  assert.deepEqual(await readBotModels('codex', { env: none.env, timeoutMs: 60000 }), []); assert.equal(fs.existsSync(modelsFile(none.env)), false);
  // Claude Code's names are its aliases, which never change with a release: nothing is saved for it.
  const claude = standIn(t, 'claude', "  --model <model>  Provide an alias (e.g. 'fable', 'opus', or 'sonnet') or a model's full name.\n  -n, --name <name>  A name.\n");
  assert.deepEqual((await readBotModels('claude', { env: claude.env, timeoutMs: 60000 })).map(row => row.name), ['fable', 'opus', 'sonnet']);
  assert.equal(fs.existsSync(modelsFile(claude.env)), false); assert.deepEqual(keptModels('claude', { env: claude.env }).map(row => row.name), ['fable', 'opus', 'sonnet']);
  for (const vendor of ['agy', 'grok', 'constructor', '']) assert.deepEqual(keptModels(vendor, { env: cli.env }), [], vendor);
});
