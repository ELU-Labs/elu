import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis } from './helpers.mjs';
import { standInAnthropic } from './fakes/anthropic.mjs';
import { ProjectController, conversationEntries, registerProject } from '../lib/projects.mjs';
import { projectFolder, pendingRequests } from '../lib/workspace.mjs';
import { repository } from '../lib/git.mjs';
import { readTask } from '../lib/state.mjs';
import { personalDirectory } from '../lib/util.mjs';
import { activeLogin, finishLogin, newLogin, useLogin } from '../lib/logins.mjs';
import { closeRelay } from '../lib/claude-relay.mjs';
import { notePicked, readSwitch, setAuto } from '../lib/claude-switch.mjs';
import { usageTab } from '../lib/usage.mjs';
import { stopLine } from '../lib/stop-line.mjs';
import { Conductor, enqueue } from '../lib/conductor.mjs';
import { saveBot } from '../lib/bots.mjs';
import { boardRows, rowBadge, rowTitle } from '../lib/board.mjs';

// Claude work moving between the owner's Claude accounts by itself, end to end: a session's
// turn on the stand-in Claude Code (test/fakes/claude.mjs, api in fake.json), which sends its
// requests as the real one does to ELU's relay, which sends them on to a stand-in Anthropic API
// (test/fakes/anthropic.mjs). a@example.com is the owner's own account, b@example.com one he
// added in Usage.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what, timeout = 20000) { const began = Date.now(); while (!check()) { if (Date.now() - began > timeout) throw new Error(`timed out waiting for ${what}`); await sleep(25); } }
const UUIDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const MOVED = 'Moved to b@example.com: a@example.com reached its weekly limit.';
async function setup(t, specs, { requests = 3, direct = false } = {}) {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer' });
  const config = path.join(p.parent, 'anthropic.json'); fs.writeFileSync(config, JSON.stringify({ accounts: {}, refresh: {} }));
  const api = await standInAnthropic(config);
  environment(t, { ...fake.env, HOME: p.parent, ELU_TEST_ANTHROPIC_URL: api.url, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.com' });
  t.after(async () => { closeRelay(); await api.close(); });
  closeRelay();
  const accounts = specs.map((spec, at) => {
    const token = `sk-ant-oat01-standin-${'ab'[at]}-${'x'.repeat(24)}`, slot = at === 0 ? null : newLogin('claude'), id = slot?.id ?? 'default', folder = slot?.dir ?? fake.env.CLAUDE_CONFIG_DIR;
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: spec.email, accountUuid: UUIDS[at], organizationUuid: UUIDS[at], planDisplayName: 'Max 20x' } }));
    fs.writeFileSync(path.join(folder, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `sk-ant-ort01-standin-${'ab'[at]}`, expiresAt: Date.now() + 8 * 3600 * 1000 } }));
    if (slot) finishLogin('claude', id);
    return { ...spec, id, token, folder };
  });
  api.set(value => { for (const { id, token, folder, ...rest } of accounts) value.accounts[token] = rest; });
  const file = path.join(fake.dir, 'fake.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...saved, accounts: {}, api: { requests, ...(direct ? { direct: api.url } : {}) } }));
  const controller = new ProjectController(projectFolder(p.root)); Object.assign(controller.draftConfig.roles.lead, { vendor: 'claude', maxCostUsd: null });
  const runs = () => fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(call => call.vendor === 'claude' && call.args[0] === '-p') : [];
  const messages = () => api.calls().filter(row => row.path === '/v1/messages');
  const mode = (email, changes) => api.set(value => { for (const row of Object.values(value.accounts)) if (row.email === email) Object.assign(row, changes); });
  return { ...p, fake, api, accounts, controller, runs, messages, mode, b: accounts[1] };
}
const moveLines = (repo, task) => conversationEntries(repo, task).filter(entry => entry.line && /^Moved to /.test(entry.text)).map(entry => entry.text);
const secrets = text => /sk-ant-|@example\.com/.test(text);

test('weekly limit in the middle of a turn: the rest of its requests go to the next account, the turn finishes in one run, and the chat says so in one line', { timeout: 60000 }, async t => {
  const f = await setup(t, [{ email: 'a@example.com', weekly: 0.9, after: 2, mode: 'weekly' }, { email: 'b@example.com', weekly: 0.2 }], { requests: 5 });
  const done = await f.controller.ask('Where is coupon normalization?').finished;
  assert.equal(done.state, 'answered', JSON.stringify(done.error));
  assert.deepEqual(f.messages().map(row => [row.account, row.status]), [['a@example.com', 200], ['a@example.com', 200], ['a@example.com', 429], ['b@example.com', 200], ['b@example.com', 200], ['b@example.com', 200]]);
  assert.equal(f.runs().length, 1, 'one run'); assert.equal(f.runs()[0].base, 'relay');
  const task = readTask(f.controller.repo, done.id);
  assert.deepEqual(moveLines(f.controller.repo, task), [MOVED]);
  assert.deepEqual(task.runs.at(-1).moves.map(move => [move.from, move.to, move.why]), [['default', f.b.id, 'weekly']]);
  assert.equal(activeLogin('claude'), f.b.id, 'Usage shows b in use');
  const [claude] = usageTab({ vendors: [{ vendor: 'claude', available: true, signedIn: true }], now: Date.now() });
  assert.deepEqual(claude.accounts.map(row => [row.account, row.active, row.usage?.weekly?.usedPercent ?? null, Boolean(row.spentUntil)]), [['a@example.com', false, 100, true], ['b@example.com', true, 20, false]]);
  assert.deepEqual(claude.switches, { auto: true, extraUsage: false });
  // The line of keys under the accounts fits an 80-column terminal: 2 for the border, 12 for the indent.
  assert.ok(claude.keysHint.length <= 80 - 2 - 12, `the hint fits at 80 columns: ${claude.keysHint}`);
  // The session keeps account ids, never an email or a sign-in.
  assert.equal(secrets(JSON.stringify(task)), false, 'no email or sign-in in the session');
  // The next turn starts on b at once.
  const next = await f.controller.ask('And the tests?', done.id).finished;
  assert.equal(next.state, 'answered'); assert.equal(f.runs().at(-1).config, f.b.folder);
  assert.deepEqual(f.messages().slice(6).map(row => row.account), Array(5).fill('b@example.com'));
});

test('a per-minute slowdown twice: everything stays on the same account, no line, and the turn finishes', { timeout: 60000 }, async t => {
  const f = await setup(t, [{ email: 'a@example.com', mode: 'minute', times: 2, retryAfter: 1 }, { email: 'b@example.com' }]);
  const done = await f.controller.ask('Where is coupon normalization?').finished;
  assert.equal(done.state, 'answered', JSON.stringify(done.error));
  assert.ok(f.messages().every(row => row.account === 'a@example.com'));
  assert.equal(f.messages().filter(row => row.status === 200).length, 3);
  assert.deepEqual(moveLines(f.controller.repo, readTask(f.controller.repo, done.id)), []);
  assert.equal(activeLogin('claude'), 'default'); assert.equal(readSwitch().lastMove, undefined);
});

test('every account at its limit: the session says which one resets first and when, waits for it with nothing running, and goes on in the same session when the owner picks one', { timeout: 90000 }, async t => {
  const f = await setup(t, [{ email: 'a@example.com', mode: 'weekly' }, { email: 'b@example.com', mode: 'weekly' }]);
  const repo = repository(f.root); registerProject(repo);
  const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop());
  const row = enqueue(f.root, 'Where is coupon normalization?');
  const request = () => pendingRequests(f.root).find(item => item.id === row.id);
  await until(() => request()?.waitsFor === 'claude-limit', 'the wait');
  const waiting = request(), task = readTask(f.controller.repo, waiting.continuationTaskId);
  assert.equal(waiting.state, 'queued'); assert.equal(waiting.reason, 'Waiting for a Claude account to reset.');
  assert.ok(Date.parse(waiting.notBefore) > Date.now() + 2 * 86400000, 'not before the first week resets');
  assert.equal(waiting.attempts ?? 0, 0, 'no retry counted');
  // It waits: it does not read as failed. Its line says when it goes on, and only because its message is queued for then.
  const queue = pendingRequests(f.root), [listed] = boardRows([{ root: f.root, name: 'shop', tasks: [task], queue }]).filter(item => item.kind === 'task');
  assert.deepEqual([rowBadge(listed).icon, rowBadge(listed).title], ['◷', 'waiting']);
  assert.equal(rowTitle(listed), 'Where is coupon normalization? · waits for a Claude account to reset');
  const line = stopLine(task, { goesOn: true });
  assert.match(line.text, /^Every Claude account is at its limit\. a@example\.com resets at \w{3} \d{1,2}:\d{2} [AP]M; this session goes on then\.$/);
  assert.equal(line.short, 'waits for a Claude account to reset');
  assert.doesNotMatch(task.error.message, /goes on/, 'what the session keeps promises nothing');
  assert.match(stopLine(task).text, /^Every Claude account is at its limit\. a@example\.com resets at \w{3} \d{1,2}:\d{2} [AP]M\. Type continue then\.$/, 'with no message queued, it says when and what to do');
  assert.equal(secrets(JSON.stringify(task)), false);
  const launches = f.runs().length; await sleep(1500);
  assert.equal(f.runs().length, launches, 'nothing runs while it waits');
  // What the owner types meanwhile waits with it: it would only stop at the same limit.
  const typed = enqueue(f.root, 'And where are its tests?', { continuationTaskId: task.id, priority: 0, typed: true });
  await until(() => pendingRequests(f.root).find(item => item.id === typed.id)?.waits?.on === 'time', 'the typed message waiting with it');
  await sleep(500); assert.equal(f.runs().length, launches, 'the typed message starts nothing');
  // The owner picks b in Usage: the session goes on now, in the session it stopped in.
  f.mode('b@example.com', { mode: 'ok' });
  useLogin('claude', f.b.id); notePicked(f.b.id);
  await until(() => !pendingRequests(f.root).some(item => [row.id, typed.id].includes(item.id) && item.state !== 'done') && readTask(f.controller.repo, task.id).state === 'answered', 'the session going on');
  const after = readTask(f.controller.repo, task.id);
  assert.equal(after.state, 'answered', JSON.stringify(after.error));
  const first = f.runs()[0], resumed = f.runs()[launches], session = first.args[first.args.indexOf('--session-id') + 1];
  assert.equal(resumed.args[resumed.args.indexOf('--resume') + 1], session, 'the same session goes on');
  assert.equal(resumed.config, f.b.folder);
  // Each message shows once in the chat, in the order sent.
  assert.deepEqual(after.messages.filter(item => !item.line && !item.from).map(item => item.text), ['Where is coupon normalization?', 'And where are its tests?']);
});

test('a session waiting while the other account needs a sign-in goes on by itself once a sign-in that works is there', { timeout: 90000 }, async t => {
  const f = await setup(t, [{ email: 'a@example.com', mode: 'weekly' }, { email: 'b@example.com' }]);
  // b's sign-in ended and Claude Code could not renew it: b is marked to sign in again.
  const credentials = path.join(f.b.folder, '.credentials.json');
  fs.writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-standin-b-ended', refreshToken: 'sk-ant-ort01-standin-b-ended', expiresAt: Date.now() - 60000 } }));
  const repo = repository(f.root); registerProject(repo);
  const conductor = new Conductor({ tickMs: 20, signInsEveryMs: 100 }).start(); t.after(() => conductor.stop());
  const row = enqueue(f.root, 'Where is coupon normalization?');
  const request = () => pendingRequests(f.root).find(item => item.id === row.id);
  await until(() => request()?.waitsFor === 'claude-limit', 'the wait');
  assert.ok(readSwitch().signIn?.[f.b.id], 'b waits for a sign-in');
  const task = request().continuationTaskId, launches = f.runs().length;
  // The owner signs b in again outside ELU: nothing else is done, and the session goes on on b.
  fs.writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: f.b.token, refreshToken: 'sk-ant-ort01-standin-b', expiresAt: Date.now() + 8 * 3600 * 1000 } }));
  await until(() => request() === undefined || request().state === 'done', 'the session going on');
  const after = readTask(f.controller.repo, task);
  assert.equal(after.state, 'answered', JSON.stringify(after.error));
  assert.equal(readSwitch().signIn?.[f.b.id], undefined, 'b is back');
  assert.equal(f.runs().length, launches + 1); assert.equal(f.runs().at(-1).config, f.b.folder);
});

test("a message to a bot while every account is at its limit waits, then goes on once an account is picked, and the chat shows it once", { timeout: 90000 }, async t => {
  const f = await setup(t, [{ email: 'a@example.com' }, { email: 'b@example.com' }]);
  saveBot({ name: 'scout', vendor: 'claude', instructions: 'Find things in the code.' });
  const chat = await f.controller.ask('Hello.', null, { bots: ['scout'] }).finished;
  assert.equal(chat.state, 'answered', JSON.stringify(chat.error));
  f.mode('a@example.com', { mode: 'weekly' }); f.mode('b@example.com', { mode: 'weekly' });
  const repo = repository(f.root); registerProject(repo);
  const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop());
  const row = enqueue(f.root, 'Where is coupon normalization?', { continuationTaskId: chat.id, bot: 'scout', priority: 0, typed: true });
  const request = () => pendingRequests(f.root).find(item => item.id === row.id);
  await until(() => request()?.waitsFor === 'claude-limit', 'the wait');
  f.mode('b@example.com', { mode: 'ok' });
  useLogin('claude', f.b.id); notePicked(f.b.id);
  await until(() => request()?.state === 'done', 'the bot going on');
  const after = readTask(f.controller.repo, chat.id);
  assert.equal(after.messages.filter(item => item.to === '@scout' && item.text === 'Where is coupon normalization?').length, 1, 'the message once');
  assert.ok(after.messages.at(-1).from === '@scout' && !after.messages.at(-1).failed, 'the bot answered');
});

test("a bot's scheduled turn while every account is at its limit ends, says when the first resets, and promises nothing it does not do", { timeout: 90000 }, async t => {
  const f = await setup(t, [{ email: 'a@example.com' }, { email: 'b@example.com' }]);
  saveBot({ name: 'nightly', vendor: 'claude', instructions: 'Tidy the notes.', schedule: 'every 3h' });
  const chat = await f.controller.ask('Keep the notes tidy.', null, { bots: ['nightly'] }).finished;
  assert.equal(chat.state, 'answered', JSON.stringify(chat.error));
  f.mode('a@example.com', { mode: 'weekly' }); f.mode('b@example.com', { mode: 'weekly' });
  const repo = repository(f.root); registerProject(repo);
  const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop());
  const row = enqueue(f.root, 'Do your scheduled work.', { continuationTaskId: chat.id, bot: 'nightly', scheduled: true, priority: 1 });
  await until(() => pendingRequests(f.root).find(item => item.id === row.id)?.state === 'done', 'the scheduled turn ending');
  const said = readTask(f.controller.repo, chat.id).messages.findLast(item => item.from === '@nightly');
  assert.ok(said?.failed, JSON.stringify(said));
  assert.match(said.text, /^Could not answer\. Every Claude account is at its limit\. The first resets at \w{3} \d{1,2}:\d{2} [AP]M\.$/);
  assert.equal(pendingRequests(f.root).some(item => item.waitsFor === 'claude-limit'), false, 'nothing is queued to go on');
});

test('when Claude Code does not go through the relay, a turn its account stopped goes on in the same session on the next account', { timeout: 60000 }, async t => {
  const f = await setup(t, [{ email: 'a@example.com', mode: 'weekly' }, { email: 'b@example.com' }], { direct: true });
  const done = await f.controller.ask('Where is coupon normalization?').finished;
  assert.equal(done.state, 'answered', JSON.stringify(done.error));
  const [first, second] = f.runs();
  assert.equal(f.runs().length, 2);
  assert.equal(first.config, process.env.CLAUDE_CONFIG_DIR); assert.equal(second.config, f.b.folder);
  assert.equal(second.args[second.args.indexOf('--resume') + 1], first.args[first.args.indexOf('--session-id') + 1], 'resumed the same session');
  const task = readTask(f.controller.repo, done.id);
  assert.deepEqual(moveLines(f.controller.repo, task), [MOVED]);
  assert.equal(readSwitch().spent.default.window, 'weekly'); assert.equal(activeLogin('claude'), f.b.id);
  assert.equal(secrets(JSON.stringify(task)), false);
});

test('switching turned off: no relay, no address, and a limit stops the turn as before', { timeout: 60000 }, async t => {
  const f = await setup(t, [{ email: 'a@example.com' }, { email: 'b@example.com' }]);
  setAuto(false);
  const done = await f.controller.ask('Where is coupon normalization?').finished;
  assert.equal(done.state, 'answered', JSON.stringify(done.error));
  assert.equal(f.runs()[0].base, null, 'no ANTHROPIC_BASE_URL'); assert.equal(f.messages().length, 0);
  assert.equal(fs.existsSync(path.join(personalDirectory(), 'claude-switch.json')), true);
});
