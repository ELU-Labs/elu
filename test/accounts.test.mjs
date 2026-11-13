import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, fakeClis, temp } from './helpers.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';
import { memoryFolder } from '../lib/memory.mjs';
import { personalDirectory } from '../lib/util.mjs';
import { agentEnv } from '../lib/process.mjs';
import { SIGN_IN, SHARED, activeLogin, finishLogin, hasBrowser, linkShared, listLogins, loginEnv, loginFolder, newLogin, useLogin } from '../lib/logins.mjs';
import { accountOf, forgetAccount, readAccounts, refreshUsage, usageTab } from '../lib/usage.mjs';
import { signInCommand, signInHintHere } from '../lib/vendors.mjs';
import { stopLine } from '../lib/stop-line.mjs';
import { usageBlocks } from '../lib/terminal.mjs';

// Several accounts of one vendor signed in at once, against stand-in command lines that read
// the account from the folder they are started with (test/fakes: accounts in fake.json).
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what) { for (let i = 0; i < 400; i++) { if (check()) return; await sleep(25); } throw new Error(`timed out waiting for ${what}`); }
const idToken = (email, plan) => `h.${Buffer.from(JSON.stringify({ email, 'https://api.openai.com/auth': { chatgpt_plan_type: plan } })).toString('base64url')}.s`;
// A project with the fakes on PATH, the owner signed in to Claude Code as first@example.com in
// its normal folder (CLAUDE_CONFIG_DIR, as fakeClis sets it) and to Codex as
// codex-first@example.com in CODEX_HOME, with settings, a skill, an MCP server and memory of his.
function setup(t, vendor, accounts) {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer', accounts });
  const codexHome = path.join(p.parent, 'codex-home');
  environment(t, { ...fake.env, HOME: p.parent, CODEX_HOME: codexHome, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.com' });
  const normal = fake.env.CLAUDE_CONFIG_DIR; fs.mkdirSync(path.join(normal, 'skills', 'review'), { recursive: true });
  fs.writeFileSync(path.join(normal, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'first@example.com', planDisplayName: 'Max 20x' }, mcpServers: { notes: { command: 'true' } } }));
  fs.writeFileSync(path.join(normal, 'settings.json'), '{"theme":"dark"}'); fs.writeFileSync(path.join(normal, 'CLAUDE.md'), 'Keep diffs small.');
  fs.writeFileSync(path.join(normal, 'skills', 'review', 'SKILL.md'), 'Review carefully.');
  fs.mkdirSync(codexHome, { recursive: true }); fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "big-model"\n');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: idToken('codex-first@example.com', 'pro'), access_token: 'access-never-shown' } }));
  const controller = new ProjectController(projectFolder(p.root)); Object.assign(controller.draftConfig.roles.lead, { vendor, maxCostUsd: null });
  const root = controller.repo.project ?? controller.repo.root;
  fs.mkdirSync(memoryFolder(root), { recursive: true }); fs.writeFileSync(path.join(memoryFolder(root), 'MEMORY.md'), 'The owner prefers small diffs.');
  const calls = () => fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.vendor === vendor) : [];
  const runs = () => calls().filter(call => vendor === 'claude' ? call.args[0] === '-p' : call.args[0] === 'exec');
  const setFake = edit => { const file = path.join(fake.dir, 'fake.json'), value = JSON.parse(fs.readFileSync(file, 'utf8')); edit(value); fs.writeFileSync(file, JSON.stringify(value)); };
  return { ...p, fake, normal, codexHome, controller, calls, runs, setFake, bin: path.join(fake.dir, vendor) };
}
// What the Usage tab's a does, without the screen: a folder for the account, the vendor's own
// sign-in run in it, then the account listed.
function addAccount(f, vendor) {
  const slot = newLogin(vendor), signIn = spawnSync(f.bin, [...SIGN_IN[vendor]], { env: { ...process.env, [vendor === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: slot.dir }, encoding: 'utf8' });
  assert.equal(signIn.status, 0, signIn.stderr); finishLogin(vendor, slot.id);
  return slot;
}
const read = file => fs.readFileSync(file, 'utf8');
const SEEN = ['settings', 'claudeMd', 'skills', 'projects', 'mcp', 'memory'];

test('Claude: a second account signs in beside the first; a switch moves new turns to it, a running turn keeps its own, and every account sees the same settings, MCP servers and memory', { timeout: 60000 }, async t => {
  const hold = path.join(temp(t), 'hold');
  const f = setup(t, 'claude', { loginAs: 'second@example.com', plan: 'Max 5x', hold, usage: { 'second@example.com': { fiveHour: 0.05, weekly: 0.4 } } });
  const ownSignIn = read(path.join(f.normal, '.claude.json'));
  // The owner's own sign-in is the first account, with nothing to do.
  assert.deepEqual(listLogins('claude'), ['default']); assert.equal(activeLogin('claude'), 'default');
  assert.equal(accountOf('claude').email, 'first@example.com');
  const slot = addAccount(f, 'claude');
  // Both stay signed in: the new sign-in went to the new folder, and the owner's own is as it was.
  assert.deepEqual(listLogins('claude'), ['default', slot.id]); assert.equal(activeLogin('claude'), 'default', 'adding does not switch');
  assert.equal(accountOf('claude', slot.id).email, 'second@example.com'); assert.equal(accountOf('claude', slot.id).plan, 'Max 5x');
  assert.equal(read(path.join(f.normal, '.claude.json')), ownSignIn); assert.equal(fs.existsSync(path.join(f.normal, '.credentials.json')), false);
  assert.equal(path.dirname(path.dirname(slot.dir)), path.join(personalDirectory(), 'logins', 'claude'));
  for (const name of ['.claude.json', '.credentials.json']) assert.equal(fs.lstatSync(path.join(slot.dir, name)).isSymbolicLink(), false, `${name} is the account's own`);
  for (const name of ['settings.json', 'CLAUDE.md', 'skills', 'projects']) assert.equal(fs.readlinkSync(path.join(slot.dir, name)), path.join(f.normal, name), `${name} is the owner's`);
  // A run on the owner's own account.
  const first = await f.controller.ask('Where is coupon normalization?').finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  const [own] = f.runs(); assert.equal(own.account, 'first@example.com'); assert.equal(own.config, f.normal);
  assert.equal(first.runs.at(-1).login, undefined);
  // One key: new turns use the second account. The next turn of the same session resumes its
  // session there, and sees the same settings, skills, MCP servers and memory.
  useLogin('claude', slot.id); assert.equal(activeLogin('claude'), slot.id);
  const second = await f.controller.ask('And the tests?', first.id).finished;
  assert.equal(second.state, 'answered', JSON.stringify(second.error));
  const other = f.runs().at(-1);
  assert.equal(other.account, 'second@example.com'); assert.equal(other.config, slot.dir); assert.ok(other.args.includes('--resume'), 'the session goes on');
  assert.equal(second.runs.at(-1).login, slot.id);
  for (const key of SEEN) assert.deepEqual(other[key], own[key], key);
  assert.deepEqual(own.mcp, ['notes']); assert.equal(own.settings, '{"theme":"dark"}'); assert.equal(own.claudeMd, 'Keep diffs small.'); assert.deepEqual(own.skills, ['review']);
  assert.ok(own.memory.some(row => row === 'MEMORY.md:The owner prefers small diffs.'), JSON.stringify(own.memory));
  // A turn that is running keeps the account it started on, whatever the switch says meanwhile.
  fs.writeFileSync(hold, '');
  const before = f.runs().length, held = f.controller.ask('Where are the fixtures?');
  await until(() => f.runs().length > before, 'the held run');
  useLogin('claude', 'default'); fs.rmSync(hold);
  const finished = await held.finished;
  assert.equal(finished.state, 'answered', JSON.stringify(finished.error));
  assert.equal(f.runs().at(-1).account, 'second@example.com'); assert.equal(finished.runs.at(-1).login, slot.id);
  const back = await f.controller.ask('Thanks.', finished.id).finished;
  assert.equal(f.runs().at(-1).account, 'first@example.com'); assert.equal(back.runs.at(-1).login, undefined);
  // Each account's usage is what its own runs reported.
  const rows = readAccounts(), mine = rows.find(row => row.account === 'second@example.com');
  assert.equal(mine.usage.weekly.usedPercent, 40); assert.equal(mine.usage.fiveHour.usedPercent, 5);
  const [claude] = usageTab({ vendors: [{ vendor: 'claude', available: true, signedIn: true }], now: Date.now() });
  assert.deepEqual(claude.accounts.map(row => [row.login, row.account, row.plan, row.active, row.usage?.weekly?.usedPercent ?? null]), [['default', 'first@example.com', 'Max 20x', true, 71], [slot.id, 'second@example.com', 'Max 5x', false, 40]]);
  const text = usageBlocks([claude]).map(row => row.text).join('\n');
  assert.match(text, /^Claude {6}first@example\.com · Max 20x · active\n {12}5h  \[##----\]   36%  resets [^\n]+\n {12}wk  \[####--\]   71%  resets [^\n]+\n {12}second@example\.com · Max 5x\n {12}5h  \[------\]    5%  resets [^\n]+\n {12}wk  \[##----\]   40%  resets [^\n]+\n {12}enter use · a add account · x forget$/m);
  assert.deepEqual(usageBlocks([claude]).filter(row => row.login === slot.id).length, 3, 'Enter on any line of the account uses it');
  // No sign-in, and no account's email, is kept with a session.
  for (const task of [first, second, finished, back]) assert.doesNotMatch(JSON.stringify(readTask(f.controller.repo, task.id)), /@example\.com|never-shown/);
  for (const name of ['accounts.json', 'logins.json', 'usage.json']) assert.doesNotMatch(read(path.join(personalDirectory(), name)), /never-shown|accessToken|refresh/, name);
  assert.doesNotMatch(read(path.join(personalDirectory(), 'logins.json')), /@/);
});

test('Claude: a run that hits the account limit names that account, the limit it hit and when it resets, and says to switch in Usage; nothing switches by itself', { timeout: 60000 }, async t => {
  const f = setup(t, 'claude', { loginAs: 'second@example.com', limited: ['second@example.com'] });
  const slot = addAccount(f, 'claude'); useLogin('claude', slot.id);
  const { id, finished } = f.controller.ask('Where is coupon normalization?');
  await assert.rejects(finished, /The model could not finish/);
  const task = readTask(f.controller.repo, id);
  assert.equal(task.error.cause, 'quota'); assert.equal(task.runs.at(-1).login, slot.id);
  const stop = stopLine(task);
  // What Claude said: "You've hit your session limit · resets 5pm" (test/fakes/claude.mjs).
  assert.equal(stop.text, 'The model could not finish: second@example.com hit its session limit (resets 5pm). Switch account in Usage, then type continue.');
  assert.equal(stop.short, 'switch account in Usage, then type continue');
  assert.equal(activeLogin('claude'), slot.id, 'no automatic switch');
  // The email is this machine's: the task keeps the account's id, never its email.
  assert.doesNotMatch(JSON.stringify(task), /second@example\.com/);
  // After the owner switches, the same session carries on on his own account.
  useLogin('claude', 'default');
  const again = await f.controller.ask('continue', id).finished;
  assert.equal(again.state, 'answered', JSON.stringify(again.error)); assert.equal(f.runs().at(-1).account, 'first@example.com');
});

test('forget removes only ELU\'s copy of an added account, after which new turns use the owner\'s own; nothing is signed out', { timeout: 60000 }, async t => {
  const f = setup(t, 'claude', { loginAs: 'second@example.com' });
  const slot = addAccount(f, 'claude'); f.setFake(value => { value.accounts.loginAs = 'third@example.com'; });
  const third = addAccount(f, 'claude'); useLogin('claude', slot.id);
  await refreshUsage({ force: true });
  assert.deepEqual(readAccounts().filter(row => row.vendor === 'claude').map(row => row.account).sort(), ['first@example.com', 'second@example.com', 'third@example.com']);
  const kept = Object.fromEntries(['.claude.json', 'settings.json', 'CLAUDE.md', path.join('skills', 'review', 'SKILL.md')].map(name => [name, read(path.join(f.normal, name))]));
  assert.equal(forgetAccount('claude', slot.id).email, 'second@example.com');
  assert.deepEqual(listLogins('claude'), ['default', third.id]); assert.equal(activeLogin('claude'), 'default', 'the account in use was forgotten');
  assert.equal(fs.existsSync(path.dirname(slot.dir)), false);
  // What the links pointed to, the owner's own sign-in, and the other account are all still there.
  for (const [name, text] of Object.entries(kept)) assert.equal(read(path.join(f.normal, name)), text, name);
  assert.equal(accountOf('claude', third.id).email, 'third@example.com'); assert.equal(accountOf('claude').email, 'first@example.com');
  assert.deepEqual(readAccounts().filter(row => row.vendor === 'claude').map(row => row.account).sort(), ['first@example.com', 'third@example.com']);
  // The owner's own sign-in is the vendor's, never ELU's to forget.
  assert.equal(forgetAccount('claude', 'default'), null); assert.equal(accountOf('claude').email, 'first@example.com');
  assert.ok(!f.calls().some(call => call.args.includes('logout')), 'never a sign-out');
});

test('Codex: each account has its own CODEX_HOME with the owner\'s config and sessions shared; the check reads each account\'s usage, and a run uses the chosen one', { timeout: 60000 }, async t => {
  const f = setup(t, 'codex', { loginAs: 'codex-second@example.com', plan: 'plus', codexUsage: { 'codex-first@example.com': { fiveHour: 10, weekly: 20 }, 'codex-second@example.com': { fiveHour: 70, weekly: 90 } } });
  const slot = addAccount(f, 'codex');
  assert.equal(accountOf('codex').email, 'codex-first@example.com'); assert.deepEqual(accountOf('codex', slot.id), { email: 'codex-second@example.com', plan: 'Plus' });
  assert.equal(JSON.parse(read(path.join(f.codexHome, 'auth.json'))).tokens.access_token, 'access-never-shown', "the owner's own sign-in is untouched");
  assert.equal(fs.lstatSync(path.join(slot.dir, 'auth.json')).isSymbolicLink(), false);
  for (const name of ['config.toml', 'sessions']) assert.equal(fs.readlinkSync(path.join(slot.dir, name)), path.join(f.codexHome, name), name);
  await refreshUsage({ force: true });
  const usage = Object.fromEntries(readAccounts().filter(row => row.vendor === 'codex').map(row => [row.account, [row.usage.fiveHour.usedPercent, row.usage.weekly.usedPercent]]));
  assert.deepEqual(usage, { 'codex-first@example.com': [10, 20], 'codex-second@example.com': [70, 90] });
  useLogin('codex', slot.id);
  const task = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'auto' }).finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  assert.equal(f.runs().at(-1).account, 'codex-second@example.com'); assert.equal(f.runs().at(-1).config, slot.dir); assert.equal(task.runs.at(-1).login, slot.id);
  const [, codex] = usageTab({ vendors: [{ vendor: 'claude', available: false }, { vendor: 'codex', available: true, signedIn: true }] });
  assert.deepEqual(codex.accounts.map(row => [row.account, row.active]), [['codex-first@example.com', false], ['codex-second@example.com', true]]);
  assert.deepEqual(codex.active, { account: 'codex-second@example.com', plan: 'Plus', tier: null }); assert.equal(codex.usage.weekly.usedPercent, 90);
  // At its limit, the chat names the account.
  f.setFake(value => { value.accounts.limited = ['codex-second@example.com']; });
  const { id, finished } = f.controller.ask('And the tests?', task.id);
  await assert.rejects(finished, /could not finish/);
  // Codex said its usage limit, and to try again later: no time to show (test/fakes/codex.mjs).
  assert.equal(stopLine(readTask(f.controller.repo, id)).text, 'The model could not finish: codex-second@example.com hit its usage limit. Switch account in Usage, then type continue.');
});

test('an account folder is ELU\'s own: links are laid again, a run environment can name only such a folder, and the folders never reach a peer', t => {
  const f = setup(t, 'claude', { loginAs: 'second@example.com' });
  const slot = addAccount(f, 'claude');
  // A shared entry the owner makes later is linked before the next run on the account.
  fs.mkdirSync(path.join(f.normal, 'agents')); fs.writeFileSync(path.join(f.normal, 'agents', 'helper.md'), 'Helps.');
  linkShared('claude', slot.id); assert.equal(read(path.join(slot.dir, 'agents', 'helper.md')), 'Helps.');
  // Never shared: the sign-in and what belongs to it.
  for (const name of ['.claude.json', '.credentials.json', '.config.json', 'policy-limits.json', 'remote-settings.json', 'statsig']) assert.ok(!SHARED.claude.includes(name), name);
  assert.ok(!SHARED.codex.includes('auth.json'));
  assert.deepEqual(loginEnv('claude', slot.id), { CLAUDE_CONFIG_DIR: loginFolder('claude', slot.id) }); assert.deepEqual(loginEnv('claude', 'default'), {});
  assert.equal(agentEnv(process.env, [], loginEnv('claude', slot.id)).CLAUDE_CONFIG_DIR, slot.dir);
  assert.throws(() => agentEnv(process.env, [], { CLAUDE_CONFIG_DIR: f.normal }), /inside ELU's personal directory/);
  assert.throws(() => agentEnv(process.env, [], { CODEX_HOME: path.join(personalDirectory(), 'elsewhere') }), /inside ELU's personal directory/);
  assert.throws(() => loginFolder('claude', '../x'), /not an account ELU added/); assert.throws(() => useLogin('claude', 'zzzzzzzz'), /not signed in here/);
  assert.throws(() => newLogin('agy'), /Claude Code and Codex/);
  // Nothing about accounts is in the files a teammate's machine is sent from.
  const peer = path.join(personalDirectory(), 'peer');
  if (fs.existsSync(peer)) for (const name of fs.readdirSync(peer, { recursive: true })) { const file = path.join(peer, name); if (fs.statSync(file).isFile()) assert.doesNotMatch(read(file), /second@example\.com|logins/, name); }
});

test('a computer has a browser for a sign-in unless it is reached over SSH, or is Linux with no display', () => {
  assert.equal(hasBrowser({}, 'darwin'), true); assert.equal(hasBrowser({}, 'win32'), true);
  assert.equal(hasBrowser({ SSH_CONNECTION: '10.0.0.2 52000 10.0.0.3 22' }, 'darwin'), false);
  assert.equal(hasBrowser({ SSH_TTY: '/dev/pts/1', DISPLAY: ':0' }, 'linux'), false);
  assert.equal(hasBrowser({}, 'linux'), false); assert.equal(hasBrowser({ DISPLAY: '' }, 'linux'), false);
  assert.equal(hasBrowser({ DISPLAY: ':0' }, 'linux'), true); assert.equal(hasBrowser({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), true);
  // What the owner is told to type follows it: the device code sign-in where the command has one.
  assert.deepEqual(['claude', 'codex', 'agy', 'grok'].map(vendor => signInCommand(vendor, true)), ['claude', 'codex login', 'agy', 'grok login']);
  assert.deepEqual(['claude', 'codex', 'agy', 'grok'].map(vendor => signInCommand(vendor, false)), ['claude', 'codex login --device-auth', 'agy', 'grok login --device-auth']);
  assert.equal(signInHintHere('codex', 'Codex: sign in with ChatGPT. Run: codex login', false), 'Codex: sign in with ChatGPT. Run: codex login --device-auth');
  assert.equal(signInHintHere('grok', 'Grok Build: not signed in. Run: grok login', true), 'Grok Build: not signed in. Run: grok login');
  // The sign-in is the vendor's same command either way: it prints the link the owner opens.
  assert.deepEqual(SIGN_IN, { claude: ['auth', 'login'], codex: ['login'] });
});
