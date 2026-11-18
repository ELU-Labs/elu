import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { temp, fakeClis, fakeKeychain, project } from './helpers.mjs';
import { standInAnthropic } from './fakes/anthropic.mjs';
import { activeLogin, finishLogin, newLogin, useLogin } from '../lib/logins.mjs';
import { WAITS_FOR, changeSwitch, familyOf, markSignIn, markSpent, notePicked, readSwitch, restartsOnOther, setAuto, setExtraUsage, switchOn, waitsForReset } from '../lib/claude-switch.mjs';
import { claudeModelFree, familyOf as familyOfAccounts, firstFree, limitOf, modelOver, pick, usable } from '../lib/claude-accounts.mjs';
import { closeRelay, familyOf as familyOfRelay, openLaunch } from '../lib/claude-relay.mjs';
import { keepClaudeUsage, readAccounts } from '../lib/usage.mjs';
import { botModels, keptModels, modelsFile, readBotModels } from '../lib/bot-models.mjs';
import { repository } from '../lib/git.mjs';
import { ProjectController, projectSnapshot, registerProject } from '../lib/projects.mjs';
import { Conductor, conductorTakesAuto, enqueue } from '../lib/conductor.mjs';
import { conductorFolder } from '../lib/conductor-files.mjs';
import { pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { lock, readTask, saveTask } from '../lib/state.mjs';
import { setSessionModel } from '../lib/models.mjs';
import { stopLine } from '../lib/stop-line.mjs';
import { boardRows, rowTitle } from '../lib/board.mjs';
import { LINES, saveAutoSettings } from '../lib/auto-model.mjs';
import { parseWhen, runScheduleNow, saveSchedule } from '../lib/schedules.mjs';

// The limits Auto model goes by when it sends a step to a model: whether a Claude model has
// room now and until when (claudeModelFree and modelOver in lib/claude-accounts.mjs), the
// relay's refusal that names one model's own week for a run that asked for it
// (lib/claude-relay.mjs), and Codex's model names saved between starts (lib/bot-models.mjs).
// Then how the conductor ends a turn of Auto model's that stopped (lib/conductor.mjs): the
// restart on the other model after one model's week and the line it shows meanwhile, a quick
// answer ELU ended under, a think that failed, and which new sessions take this computer's default.
// Nothing here starts a vendor's program: the accounts are files in a temp folder, Anthropic
// is the stand-in on this computer, and Codex and Claude Code are stand-in scripts.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
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

// How the conductor ends a turn of Auto model's that stopped. A project of the owner's, with
// the stand-ins of the vendors' programs: Claude Code's fable and opus answer as Fable 5.2 and
// Opus 5.5, and calls.jsonl keeps each run's flags.
function autoProject(t) {
  const p = project(t), clis = fakeClis(p.parent, { mode: 'answer', models: { fable: 'claude-fable-5-2', opus: 'claude-opus-5-5' } });
  fs.mkdirSync(path.join(p.parent, 'home'), { recursive: true });
  environment(t, { ...clis.env, HOME: path.join(p.parent, 'home'), ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined });
  const controller = new ProjectController(repository(p.root)); registerProject(controller.repo);
  return { ...p, ...clis, controller, repo: controller.repo };
}
// With a session he started with Auto model on.
async function autoSession(t) {
  const s = autoProject(t), first = await s.controller.ask('Look at the coupon code.', null, { auto: true }).finished;
  assert.equal(readTask(s.repo, first.id).auto, true);
  return { ...s, id: String(first.id) };
}
const request = (root, id) => pendingRequests(root).find(row => row.id === id);
async function until(check, message, timeout = 30000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await sleep(20); }
}
// One request started by a conductor that is not running on its own, to its end.
async function turn(conductor, repo, row) {
  conductor.launch(repo, row);
  const record = [...conductor.runs.values()].find(value => value.requestId === row.id); assert.ok(record, 'it started');
  await record.done;
}
const leadCalls = s => fs.readFileSync(s.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.vendor === 'claude' && row.args.includes('--output-format'));
const flag = (args, name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;

test("one model's own week stops a turn of Auto model's: its message starts again at once, waiting for no reset, and goes on with the other model", { timeout: 60000 }, async t => {
  const s = await autoSession(t), conductor = new Conductor({ tickMs: 3600000 }), real = conductor.controller(s.repo);
  // His plan runs on the top model, where its step puts the session.
  setSessionModel(s.repo, s.id, { vendor: 'claude', model: 'fable' });
  const sent = enqueue(s.root, 'Plan the coupon change.', { continuationTaskId: s.id, priority: 0, typed: true });
  const resets = Date.now() + 2 * DAY, limit = { model: 'fable', until: resets, step: 'plan' }, asked = [];
  // Its turn ends as the runner ends one Fable's own week refused (lib/runner.mjs, modelLimit).
  conductor.controller = () => ({ repo: real.repo, ask: (text, id, options) => {
    asked.push(options);
    if (asked.length > 1) return real.ask(text, id, options);
    return { id, finished: Promise.reject(Object.assign(new Error('Fable 5.2 could not finish.'), { details: { cause: 'quota', modelLimit: limit } })), worked: () => false };
  } });
  await turn(conductor, s.repo, request(s.root, sent.id));
  const again = request(s.root, sent.id);
  assert.deepEqual([again.state, again.notBefore ?? null, String(again.continuationTaskId), again.modelLimit, again.attempts ?? 0, again.waitsFor], ['queued', null, s.id, limit, 0, undefined], 'queued to start at once, no retry counted, no reset waited for');
  await turn(conductor, s.repo, again);
  assert.deepEqual([asked[1].limited, asked[1].again], [limit, true], 'the turn starts again, told what stopped it');
  assert.equal(request(s.root, sent.id).state, 'done');
  assert.equal(readTask(s.repo, s.id).runs.filter(run => run.role === 'lead').at(-1).asked, 'opus');
  assert.equal(flag(leadCalls(s).at(-1).args, '--model'), 'opus', 'Claude Code was asked for the other model');
});

test("with Auto model this computer's default, only a session he starts himself begins with it: not a schedule's run, nor one his other computer starts", { timeout: 60000 }, async t => {
  const s = autoProject(t); saveAutoSettings({ default: true });
  const schedule = saveSchedule({ root: s.root, goal: 'Check the build.', when: parseWhen('daily 9:00') });
  runScheduleNow(schedule.id, new Date(), { start: () => true });
  enqueue(s.root, 'Look at the cart.', { priority: 0, computer: 'b'.repeat(64) });
  enqueue(s.root, 'Look at the tax.', { priority: 0, typed: true });
  const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop());
  const sessions = () => projectSnapshot(s.repo).tasks, of = goal => sessions().find(task => task.goal === goal);
  await until(() => sessions().length === 3 && pendingRequests(s.root).every(row => ['done', 'blocked'].includes(row.state)) && sessions().every(task => !['running', 'preparing'].includes(task.state)), 'the three sessions');
  assert.equal(of('Look at the tax.').auto, true, 'his own begins with it');
  assert.equal(of('Check the build.').auto, undefined, "the schedule's run does not");
  assert.equal(of('Look at the cart.').auto, undefined, 'nor the one his other computer started');
});

test('a quick answer ELU ended under: his question stays, a line under it says it got no answer, and the session is as it was; one that was answered gets no line', t => {
  const s = autoProject(t), at = new Date(Date.now() - 60000).toISOString();
  const dead = Number(spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim());
  const left = (id, messages, extra = {}) => {
    fs.mkdirSync(path.join(s.repo.state, 'tasks', id), { recursive: true });
    saveTask(s.repo, { id, kind: 'conversation', base: null, branch: null, worktree: s.repo.root, goal: 'Look at the coupon code.', state: 'running', activeRole: 'lead', activeLog: null, createdAt: at, owner: { pid: dead, identity: 'not this process' }, runs: [], sessions: {}, reviews: [], responses: [], messages, auto: true, ...extra });
  };
  const asked = { at, text: 'where is the build script?', quick: 'q1' }, quickTurn = { state: 'answered', vendor: 'grok', model: null, name: 'Grok Build' };
  left('1', [{ at, text: 'Look at the coupon code.' }, asked], { quickTurn });
  left('2', [{ at, text: 'Look at the coupon code.' }, asked, { at, text: 'In package.json.', from: 'Grok Build · quick answer', update: true, quick: 'q1' }], { quickTurn });
  // A turn of the session's own model, after a quick answer that was answered: as before.
  left('3', [{ at, text: 'Look at the coupon code.' }, asked, { at, text: 'In package.json.', from: 'Grok Build · quick answer', update: true, quick: 'q1' }, { at, text: 'Now plan it.' }]);
  new Conductor().recover();
  const one = readTask(s.repo, '1'), cut = one.messages.at(-1);
  assert.deepEqual([one.state, one.quickTurn, one.error ?? null], ['answered', undefined, null]);
  assert.deepEqual([cut.text, cut.from, cut.line, cut.quick], [LINES.quickCut, 'ELU', true, 'q1']);
  assert.ok(Date.parse(cut.at) > Date.parse(at), 'under his question');
  assert.equal(one.messages.filter(row => row.text === asked.text).length, 1, 'his question is written once');
  const two = readTask(s.repo, '2');
  assert.deepEqual([two.state, two.messages.length], ['answered', 3]);
  const three = readTask(s.repo, '3');
  assert.deepEqual([three.state, three.messages.length], ['stopped', 4]); assert.match(three.error.message, /Retry to continue/);
});

test('think after a quick answer that fails before it asks the question again is blocked, to send again; one that failed after it is shown in the session', { timeout: 60000 }, async t => {
  const s = await autoSession(t), conductor = new Conductor({ tickMs: 3600000 }), stamp = () => new Date().toISOString();
  const quick = readTask(s.repo, s.id);
  quick.messages.push({ at: stamp(), text: 'where is the build script?', quick: 'q1' }, { at: stamp(), text: 'In package.json.', from: 'Grok Build · quick answer', update: true, quick: 'q1' });
  saveTask(s.repo, quick);
  // Something holds the session as the turn starts (his /model, say): it fails before it writes anything.
  const first = enqueue(s.root, 'think', { continuationTaskId: s.id, priority: 0, typed: true }), release = lock(s.repo, `task-${s.id}`);
  try { await turn(conductor, s.repo, request(s.root, first.id)); } finally { release(); }
  assert.equal(request(s.root, first.id).state, 'blocked');
  assert.equal(readTask(s.repo, s.id).messages.filter(row => row.text === 'where is the build script?').length, 1, 'the question was not asked again');
  // A turn that asked it again, then failed: the session shows that, so the request is done.
  const second = enqueue(s.root, 'think', { continuationTaskId: s.id, priority: 0, typed: true });
  conductor.controller = () => ({ repo: s.repo, ask: (text, id) => ({ id, worked: () => false, finished: Promise.resolve().then(() => {
    const session = readTask(s.repo, id); session.messages.push({ at: stamp(), text: 'where is the build script?' }); Object.assign(session, { state: 'blocked', error: { message: 'Fable 5.2 could not finish.' } }); saveTask(s.repo, session);
    throw new Error('Fable 5.2 could not finish.');
  }) }) });
  await turn(conductor, s.repo, request(s.root, second.id));
  assert.equal(request(s.root, second.id).state, 'done');
});

test("one model's own week: while the message waits to start again on the other model, the session and its row say it goes on by itself", t => {
  const s = autoProject(t), resets = Date.now() + 2 * DAY, limit = { model: 'fable', until: resets };
  fs.mkdirSync(path.join(s.repo.state, 'tasks', '1'), { recursive: true });
  saveTask(s.repo, { id: '1', kind: 'conversation', base: null, branch: null, worktree: s.repo.root, goal: 'Plan the coupon change.', state: 'blocked', activeRole: null, activeLog: null, createdAt: new Date().toISOString(), runs: [], sessions: {}, reviews: [], responses: [], messages: [{ at: new Date().toISOString(), text: 'Plan the coupon change.' }], auto: true, error: { message: 'Fable 5.2 could not finish.', modelLimit: limit } });
  const task = readTask(s.repo, '1'), sent = enqueue(s.root, 'Plan the coupon change.', { continuationTaskId: '1', priority: 0, typed: true });
  // As before: nothing waits to go on, and he is told to type continue.
  assert.equal(restartsOnOther(task, pendingRequests(s.root)), false);
  assert.equal(stopLine(task).action, 'Type continue to go on with the other model.');
  // The conductor queued it to start again on the other model (lib/conductor.mjs finish).
  updateRequest(s.root, sent.id, { modelLimit: { ...limit, step: 'plan' } });
  const queue = pendingRequests(s.root);
  assert.deepEqual([restartsOnOther(task, queue), waitsForReset(task, queue)], [true, false]);
  const line = stopLine(task, { goesOn: true, other: true });
  assert.equal(line.action, 'Goes on with its other model.'); assert.match(line.text, /^Fable is at its limit until .+\. This session goes on with its other model\.$/);
  const row = boardRows([projectSnapshot(s.repo)], Date.now()).find(value => value.kind === 'task' && value.id === '1');
  assert.deepEqual([row.label, row.waiting, row.other], ['waiting', true, true]);
  assert.match(rowTitle(row), /· goes on with its other model$/);
  assert.match(row.now, /This session goes on with its other model\.$/);
  // Once it starts, nothing waits: as before.
  updateRequest(s.root, sent.id, { state: 'starting' });
  assert.equal(restartsOnOther(task, pendingRequests(s.root)), false);
  // Every Claude account was at its limit as well (lib/runner.mjs): it still starts again on the other model first.
  const both = { ...task, error: { ...task.error, waitsFor: WAITS_FOR, resetsAt: resets } };
  assert.equal(stopLine(both, { goesOn: true, other: true }).action, 'Goes on with its other model.');
  // And once it waits for an account to reset instead (the limit came again on the other model), it says that.
  const reset = [{ state: 'queued', continuationTaskId: '1', waitsFor: WAITS_FOR }];
  assert.deepEqual([waitsForReset(both, reset), restartsOnOther(both, reset)], [true, false]);
  assert.equal(stopLine(both, { goesOn: true }).action, 'Waits for a Claude account to reset.');
});

test('a session whose turn still runs on a conductor an update replaced takes Auto model only where that conductor is of this build', t => {
  const s = autoProject(t), at = new Date().toISOString(), id = '0f0e0d0c-0b0a-4990-8807-0605040302ac', file = path.join(conductorFolder(), `draining-${id}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  // This build's conductor, replaced by an update, finishing session 4's turn: its record says it takes it.
  const replaced = new Conductor(); Object.assign(replaced, { draining: id, startedAt: at });
  replaced.runs.set('4', { root: s.repo.root, project: path.basename(s.repo.root), taskId: '4', requestId: 'r-4', startedAt: at, attempts: 0 });
  replaced.write();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).auto, 1);
  assert.equal(conductorTakesAuto('4', [s.repo.root]), true);
  // One of the build before Auto model writes no such mark: its turn would drop the setting as it saves.
  const record = JSON.parse(fs.readFileSync(file, 'utf8')); delete record.auto; fs.writeFileSync(file, JSON.stringify(record));
  assert.equal(conductorTakesAuto('4', [s.repo.root]), false);
  assert.equal(conductorTakesAuto('5', [s.repo.root]), true, 'another session is not its');
  assert.equal(conductorTakesAuto(), true, 'a new session starts on the conductor that takes new work');
});

test('in a session with Auto model, a message r sent again and his next one go as two turns, so only his new words pick a step; with it off they join, as before', t => {
  const s = autoProject(t), at = new Date().toISOString(), conductor = new Conductor();
  for (const [id, auto] of [['1', true], ['2', false]]) {
    fs.mkdirSync(path.join(s.repo.state, 'tasks', id), { recursive: true });
    saveTask(s.repo, { id, kind: 'conversation', base: null, branch: null, worktree: s.repo.root, goal: 'Look at the coupon code.', state: 'blocked', activeRole: null, activeLog: null, createdAt: at, runs: [], sessions: {}, reviews: [], responses: [], messages: [{ at, text: 'Look at the coupon code.' }], error: { message: 'Fable 5.2 could not finish.' }, ...(auto ? { auto: true } : {}) });
  }
  const pair = id => [enqueue(s.root, 'Look at the coupon code.', { continuationTaskId: id, priority: 0, typed: true, retried: true }), enqueue(s.root, 'And the tax line.', { continuationTaskId: id, priority: 0, typed: true })];
  // The first of the session's waiting messages, with the ones after it, as dispatch hands them over.
  const first = sent => { const ready = sent.map(row => ({ repo: s.repo, row: request(s.root, row.id) })); return conductor.together(s.repo, ready[0].row, ready); };
  const [again, next] = pair('1'), alone = first([again, next]);
  assert.deepEqual([alone.id, alone.goal, alone.retried], [again.id, 'Look at the coupon code.', true]);
  assert.equal(request(s.root, next.id).state, 'queued', 'his new words wait as a turn of their own');
  const [off, offNext] = pair('2'), joined = first([off, offNext]);
  assert.equal(joined.goal, 'Look at the coupon code.\n\nAnd the tax line.'); assert.equal(request(s.root, offNext.id), undefined);
});
