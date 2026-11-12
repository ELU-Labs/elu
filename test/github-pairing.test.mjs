import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { makeTeam, newHome, peerHome, withHome } from './peer-helpers.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { createInvite, redeemCode } from '../lib/peer/invite.mjs';
import { createTeam, readLog, merge } from '../lib/peer/roster.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { peerSettings, savePeerSettings } from '../lib/peer/settings.mjs';
import { PAIRED_BY_GITHUB, bothMine, markMine, markedMine, mineRows, unmarkMine } from '../lib/peer/mine.mjs';
import { viewMethods } from '../lib/peer/remote.mjs';
import { GIST, HINT, checkGithub, githubPairing, githubStatus, pairingHint, runGh } from '../lib/peer/github.mjs';
import { PeerDaemon } from '../lib/peer/daemon.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';

// GitHub pairing (docs/peer-network.md, "Your other computers"): a fake gh first on PATH keeps
// each account's gists in a temp folder, so nothing here reaches GitHub.
const FAKE = fileURLToPath(new URL('./fakes/gh.mjs', import.meta.url));
const IDS = { 'octo-user': 1001, 'other-user': 2002 };
function fakeGh(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-gh-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), store = path.join(dir, 'store'), empty = path.join(dir, 'empty');
  for (const folder of [bin, store, empty]) fs.mkdirSync(folder);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\n${fs.readFileSync(FAKE, 'utf8')}`, { mode: 0o755 });
  const { ELU_NO_GITHUB_PAIRING, ...base } = process.env; void ELU_NO_GITHUB_PAIRING;
  return {
    store,
    // The environment a machine signed in as account runs gh in. The test asks for pairing with ELU_GITHUB_PAIRING=1.
    env: (account, extra = {}) => ({ ...base, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STORE: store, ...(account ? { FAKE_GH_ACCOUNT: account, FAKE_GH_ID: String(IDS[account]) } : {}), ELU_GITHUB_PAIRING: '1', ...extra }),
    noGh: () => ({ ...base, PATH: empty, FAKE_GH_STORE: store, ELU_GITHUB_PAIRING: '1' }),
    calls: () => { try { return fs.readFileSync(path.join(store, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
    gists: account => { try { return JSON.parse(fs.readFileSync(path.join(store, `${account}.json`), 'utf8')); } catch { return []; } },
    saveGists: (account, gists) => fs.writeFileSync(path.join(store, `${account}.json`), JSON.stringify(gists, null, 2)),
  };
}
const writes = calls => calls.filter(call => call.args.includes('-X'));

// Two machines on one team, each with its own box name, a context as the daemon gives
// remote.mjs and github.mjs, and a connection to the other: elu.mine sent on one arrives at
// the other's handler at once, in the other's home.
function twoMachines(t, gh, { accounts = ['octo-user', 'octo-user'], names = ['laptop', 'devbox'] } = {}) {
  const team = makeTeam(t, { founderName: 'ana', memberName: names[1] === 'devbox' ? 'ana' : names[1] });
  const sides = [team.founder, team.member].map((machine, i) => ({ ...machine, box: names[i], account: accounts[i], events: [], soon: 0 }));
  for (const [i, side] of sides.entries()) {
    const other = sides[1 - i];
    side.conn = { key: other.identity.key, admitted: true, remoteHello: { remote: 1 }, sent: [], notify: (method, params) => { side.conn.sent.push([method, params]); if (method === 'elu.mine') withHome(other.home, () => viewMethods(other.ctx)['elu.mine'](params, other.conn)); } };
    side.ctx = { me: side.identity, session: key => key === other.identity.key ? side.conn : null, name: () => 'ana', box: key => key === other.identity.key ? other.box : null, log: () => {}, event: text => side.events.push(text), pairSoon: () => { side.soon++; } };
    side.check = (options = {}) => withHome(side.home, () => checkGithub(side.ctx, { env: gh.env(side.account), name: side.box, ...options }));
    side.read = fn => withHome(side.home, fn);
  }
  return { team, laptop: sides[0], devbox: sides[1] };
}
const paired = (a, b) => a.read(() => bothMine(a.identity.key, b.identity.key)) && b.read(() => bothMine(b.identity.key, a.identity.key));
// The pair made the way the daemons make it: laptop first, then the devbox, then the laptop again.
async function pairUp(laptop, devbox) { await laptop.check(); await devbox.check(); await laptop.check(); assert.ok(paired(laptop, devbox)); }
const glueFor = (side, commands = []) => remoteGlue({ facade: { mineRows: () => side.read(() => mineRows()), pairingHint: () => side.read(() => pairingHint()), remoteSessions: () => [] }, peerRead: () => ({ key: side.identity.key, box: side.box, teams: [{ members: [{ key: side.identity.key, name: 'ana' }, { key: side.conn.key, name: 'ana', box: side.box === 'laptop' ? 'devbox' : 'laptop', online: true }] }] }), peerCommand: async command => { commands.push(command); return {}; }, chatMessage: ({ text }) => text, ink: text => text, colour: false });

test('two computers signed in to the same GitHub account pair with no step, from one secret gist', async t => {
  const gh = fakeGh(t), { laptop, devbox } = twoMachines(t, gh);
  // The laptop is first: it makes the gist, secret, with its own file, and vouches for nobody yet.
  const first = await laptop.check();
  assert.equal(first.state, 'ok'); assert.equal(first.login, 'octo-user'); assert.deepEqual(first.marked, []);
  const [gist] = gh.gists('octo-user');
  assert.equal(gist.description, GIST); assert.equal(gist.public, false);
  assert.deepEqual(Object.keys(gist.files), [`${laptop.identity.key}.json`]);
  assert.deepEqual(JSON.parse(gist.files[`${laptop.identity.key}.json`].content), { key: laptop.identity.key, name: 'laptop', at: JSON.parse(gist.files[`${laptop.identity.key}.json`].content).at });
  // The devbox adds its file to that gist and marks the laptop; the laptop hears it and looks again soon.
  assert.deepEqual((await devbox.check()).marked, [laptop.identity.key]);
  assert.equal(devbox.read(() => markedMine(laptop.identity.key)), true);
  assert.deepEqual(devbox.conn.sent, [['elu.mine', { mine: true }]]);
  assert.equal(laptop.soon, 1);
  assert.deepEqual(laptop.events, ['@devbox marks this computer as theirs']);
  // The laptop looks again: the pair is made, and each side says so once.
  assert.deepEqual((await laptop.check()).marked, [devbox.identity.key]);
  assert.ok(paired(laptop, devbox));
  assert.equal(laptop.events.at(-1), PAIRED_BY_GITHUB('@devbox', 'octo-user'));
  assert.equal(laptop.events.at(-1), '@devbox is yours: both computers are signed in to GitHub as octo-user.');
  assert.deepEqual(devbox.events, ['@laptop is yours: both computers are signed in to GitHub as octo-user.']);
  assert.deepEqual(laptop.read(() => mineRows()).map(row => [row.key, row.auto, row.login, row.account, Boolean(row.pairedAt)]), [[devbox.identity.key, 'github', 'octo-user', 1001, true]]);
  // One gist, made once; each machine wrote only its own file, once.
  assert.equal(gh.gists('octo-user').length, 1);
  assert.deepEqual(writes(gh.calls()).map(call => [call.args.slice(1, 4).join(' '), Object.keys(call.input.files)]), [['-X POST gists', [`${laptop.identity.key}.json`]], [`-X PATCH gists/${gist.id}`, [`${devbox.identity.key}.json`]]]);
  // Looking again writes nothing and says nothing.
  const before = gh.calls().length, said = [laptop.events.length, devbox.events.length];
  await laptop.check(); await devbox.check();
  assert.deepEqual(writes(gh.calls().slice(before)), []); assert.deepEqual([laptop.events.length, devbox.events.length], said);
  // A new box name is written, the file alone.
  devbox.box = 'devbox2'; await devbox.check();
  assert.deepEqual(writes(gh.calls().slice(before)).map(call => Object.keys(call.input.files)), [[`${devbox.identity.key}.json`]]);
  assert.equal(JSON.parse(gh.gists('octo-user')[0].files[`${devbox.identity.key}.json`].content).name, 'devbox2');
  assert.ok(gh.gists('octo-user')[0].files[`${laptop.identity.key}.json`], 'the laptop file is untouched');
  // The app says it once.
  const glue = glueFor(laptop);
  assert.equal(glue.paired(), '@devbox is yours: both computers are signed in to GitHub as octo-user.');
  assert.equal(glue.paired(), null);
  assert.equal(await glue.mine([]), '@devbox is yours (GitHub octo-user)');
});

test('a teammate signed in to another GitHub account never pairs, whatever their gist says', async t => {
  const gh = fakeGh(t), { laptop, devbox: kim } = twoMachines(t, gh, { accounts: ['octo-user', 'other-user'], names: ['laptop', 'kims-mac'] });
  await laptop.check();
  // Kim's account vouches for the laptop's key too: that marks the laptop on kim's side only.
  gh.saveGists('other-user', [{ id: 'f'.repeat(32), description: GIST, public: false, created_at: '2026-01-01T00:00:00Z', files: { [`${laptop.identity.key}.json`]: { filename: `${laptop.identity.key}.json`, content: JSON.stringify({ key: laptop.identity.key, name: 'laptop' }) } } }]);
  await kim.check(); await laptop.check(); await kim.check(); await laptop.check();
  assert.equal(kim.read(() => markedMine(laptop.identity.key)), true);
  assert.equal(laptop.read(() => markedMine(kim.identity.key)), false, 'kim cannot claim the laptop');
  assert.equal(paired(laptop, kim), false);
  // A file in my own gist whose content names another key vouches for nobody.
  const gists = gh.gists('octo-user'); gists[0].files[`${kim.identity.key}.json`] = { filename: `${kim.identity.key}.json`, content: JSON.stringify({ key: laptop.identity.key, name: 'x' }) };
  gh.saveGists('octo-user', gists);
  assert.equal((await laptop.check()).vouched, 0);
  assert.equal(laptop.read(() => markedMine(kim.identity.key)), false);
});

test('a computer removed with /mine remove does not pair again by GitHub until marked by hand', async t => {
  const gh = fakeGh(t), { laptop, devbox } = twoMachines(t, gh);
  await pairUp(laptop, devbox);
  laptop.read(() => unmarkMine(devbox.identity.key));
  await laptop.check(); await devbox.check(); await laptop.check();
  assert.equal(laptop.read(() => markedMine(devbox.identity.key)), false);
  assert.equal(laptop.read(() => mineRows()).find(row => row.key === devbox.identity.key).refused, true);
  assert.equal(await glueFor(laptop).mine(['remove', '@devbox']), '@devbox is no longer yours. Neither computer can start sessions on the other now, and it does not pair again by GitHub until you type /mine @devbox.');
  // Marked by hand, it is his own mark: GitHub pairing never takes it away.
  laptop.read(() => markMine(laptop.identity.key, devbox.identity.key));
  assert.deepEqual(laptop.read(() => mineRows()).map(row => [row.mine, row.auto, row.refused]), [[true, null, false]]);
  const gists = gh.gists('octo-user'); delete gists[0].files[`${devbox.identity.key}.json`]; gh.saveGists('octo-user', gists);
  await laptop.check();
  assert.equal(laptop.read(() => markedMine(devbox.identity.key)), true);
});

test('a GitHub mark goes when its file leaves the gist or another account signs in, and comes back with the file', async t => {
  const gh = fakeGh(t), { laptop, devbox } = twoMachines(t, gh);
  await pairUp(laptop, devbox);
  const gists = gh.gists('octo-user'), file = gists[0].files[`${devbox.identity.key}.json`];
  delete gists[0].files[`${devbox.identity.key}.json`]; gh.saveGists('octo-user', gists);
  assert.deepEqual((await laptop.check()).gone, [devbox.identity.key]);
  assert.equal(paired(laptop, devbox), false);
  assert.deepEqual(laptop.conn.sent.at(-1), ['elu.mine', { mine: false }]);
  assert.equal(laptop.events.at(-1), '@devbox is no longer yours: the two computers are not signed in to the same GitHub account any more.');
  assert.equal(devbox.events.at(-1), '@laptop no longer marks this computer as theirs');
  // Not a refusal: back in the gist, it pairs again.
  gists[0].files[`${devbox.identity.key}.json`] = file; gh.saveGists('octo-user', gists);
  await laptop.check();
  assert.ok(paired(laptop, devbox));
  // Another account signs in on the laptop: the marks made for the first one go.
  laptop.account = 'other-user';
  const result = await laptop.check();
  assert.equal(result.login, 'other-user'); assert.deepEqual(result.gone, [devbox.identity.key]);
  assert.equal(laptop.read(() => markedMine(devbox.identity.key)), false);
});

test('several gists from a race are all read, and this machine writes only to the oldest', async t => {
  const gh = fakeGh(t), { laptop, devbox } = twoMachines(t, gh);
  const file = side => ({ [`${side.identity.key}.json`]: { filename: `${side.identity.key}.json`, content: JSON.stringify({ key: side.identity.key, name: side.box, at: '2026-01-01T00:00:00Z' }) } });
  gh.saveGists('octo-user', [
    { id: 'b'.repeat(32), description: GIST, public: false, created_at: '2026-01-02T00:00:00Z', files: file(devbox) },
    { id: 'a'.repeat(32), description: GIST, public: false, created_at: '2026-01-01T00:00:00Z', files: file(laptop) },
    { id: 'c'.repeat(32), description: 'Something else', public: false, created_at: '2025-01-01T00:00:00Z', files: { 'notes.md': { filename: 'notes.md', content: 'x' } } },
  ]);
  await laptop.check();
  assert.deepEqual(writes(gh.calls()), [], 'the laptop is in the oldest already');
  assert.equal(laptop.read(() => markedMine(devbox.identity.key)), true, 'vouched for by the newer gist');
  await devbox.check();
  assert.deepEqual(writes(gh.calls()).map(call => [call.args[3], Object.keys(call.input.files)]), [[`gists/${'a'.repeat(32)}`, [`${devbox.identity.key}.json`]]]);
  assert.ok(paired(laptop, devbox));
  assert.deepEqual(gh.gists('octo-user').find(row => row.id === 'c'.repeat(32)).files, { 'notes.md': { filename: 'notes.md', content: 'x' } }, 'another gist is never touched');
});

test('without gh, signed out, without the gist scope, on a timeout or a GitHub error nothing changes, and /mine says how to pair once', async t => {
  const gh = fakeGh(t), { laptop, devbox } = twoMachines(t, gh);
  await pairUp(laptop, devbox);
  const marks = () => laptop.read(() => fs.readFileSync(peerFile('mine.json'), 'utf8')), before = marks();
  const quick = (args, options) => runGh(args, { ...options, timeoutMs: 400 });
  const cases = [
    ['nogh', { env: gh.noGh() }],
    ['signedout', { env: gh.env('octo-user', { FAKE_GH_MODE: 'signedout' }) }],
    ['signedout', { env: gh.env(null) }],
    ['noscope', { env: gh.env('octo-user', { FAKE_GH_MODE: 'noscope' }) }],
    ['error', { env: gh.env('octo-user', { FAKE_GH_MODE: 'error' }) }],
    ['error', { env: gh.env('octo-user', { FAKE_GH_MODE: 'slow' }), run: quick }],
  ];
  for (const [state, options] of cases) {
    const calls = gh.calls().length, result = await laptop.check(options);
    assert.equal(result.state, state, JSON.stringify(result));
    assert.equal(marks(), before, `${state}: the marks are as they were`);
    assert.deepEqual(writes(gh.calls().slice(calls)), [], `${state}: nothing was written`);
    assert.equal(laptop.read(() => githubStatus()).state, state);
    assert.equal(laptop.read(() => pairingHint()), HINT);
    const said = await glueFor(laptop).mine([]);
    assert.equal(said, `@devbox is yours (GitHub octo-user). ${HINT}`);
    assert.equal(said.split(HINT).length, 2, 'said once');
  }
  assert.equal(HINT, 'Sign in to GitHub with gh auth login on both computers to pair them by themselves, or type /mine @name on each.');
  assert.ok(paired(laptop, devbox));
  // With nothing marked, the hint is how to pair.
  assert.equal(await glueFor(devbox).mine([]).then(text => text.endsWith('yours (GitHub octo-user)')), true);
  laptop.read(() => fs.rmSync(peerFile('mine.json')));
  assert.equal(await glueFor(laptop).mine([]), `No other computer is yours yet. ${HINT}`);
  // Working again, the hint is gone.
  await laptop.check();
  assert.equal(laptop.read(() => pairingHint()), null);
});

test('checks are never retried in a tight loop: one at a time, at most once a gap, and every so often', async t => {
  const gh = fakeGh(t), { laptop } = twoMachines(t, gh);
  // A check the timer starts runs in whatever home is active: a temp one here.
  peerHome(t);
  let runs = 0;
  const run = async () => { runs++; await new Promise(done => setTimeout(done, 20)); return { code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)' }; };
  const pairing = laptop.read(() => githubPairing(laptop.ctx, { env: gh.env('octo-user'), run, gapMs: 300, everyMs: 5000 }));
  t.after(() => pairing.stop());
  await laptop.read(() => pairing.start());
  for (let i = 0; i < 50; i++) pairing.soon();
  pairing.tick();
  await new Promise(done => setTimeout(done, 150));
  assert.equal(runs, 1, 'soon waits out the gap');
  await new Promise(done => setTimeout(done, 400));
  assert.equal(runs, 2, 'fifty asks make one more check');
  pairing.tick(); await new Promise(done => setTimeout(done, 100));
  assert.equal(runs, 2, 'not due yet');
  pairing.tick(Date.now() + 6000); await pairing.running;
  assert.equal(runs, 3, 'due every so often');
});

test('ELU_NO_GITHUB_PAIRING, /mine auto off and a test run that did not ask make no gh call', async t => {
  const gh = fakeGh(t), { laptop } = twoMachines(t, gh);
  assert.deepEqual(await laptop.check({ env: gh.env('octo-user', { ELU_NO_GITHUB_PAIRING: '1' }) }), { state: 'off', why: 'env' });
  assert.equal(laptop.read(() => pairingHint()), null, 'off is not a failure');
  // A test or CI run asks with ELU_GITHUB_PAIRING=1; one that does not, gets nothing, and leaves no file.
  const { ELU_GITHUB_PAIRING, ...plain } = gh.env('octo-user'); void ELU_GITHUB_PAIRING;
  laptop.read(() => fs.rmSync(peerFile('github.json')));
  assert.deepEqual(await laptop.check({ env: { ...plain, NODE_TEST_CONTEXT: 'child' } }), { state: 'off', why: 'test' });
  assert.deepEqual(await laptop.check({ env: { ...plain, CI: 'true' } }), { state: 'off', why: 'test' });
  assert.equal(laptop.read(() => githubStatus()), null);
  // /mine auto off goes to the daemon, which saves it in peer/settings.json; on again checks.
  const commands = [], glue = glueFor(laptop, commands);
  assert.equal(await glue.mine(['auto', 'off']), 'Computers no longer pair by GitHub account. The ones already yours stay yours; /mine remove @name ends one.');
  assert.deepEqual(commands, [{ type: 'mineAuto', on: false }]);
  await assert.rejects(glue.mine(['auto']), { message: 'Use /mine [@name | remove @name | auto on | auto off].' });
  const daemon = new PeerDaemon();
  await laptop.read(() => daemon.command({ type: 'mineAuto', on: false }));
  assert.equal(laptop.read(() => peerSettings()).githubPairing, false);
  assert.deepEqual(await laptop.check(), { state: 'off', why: 'setting' });
  assert.deepEqual(gh.calls(), [], 'no gh call at all');
  await laptop.read(() => daemon.command({ type: 'mineAuto', on: true }));
  assert.equal((await laptop.check()).state, 'ok');
  laptop.read(() => savePeerSettings({ githubPairing: false }));
  assert.equal((await laptop.check()).state, 'off');
});

test('"no longer marks this computer" is said only when that computer took its mark back', t => {
  const gh = fakeGh(t), { laptop, devbox } = twoMachines(t, gh);
  const mine = params => laptop.read(() => viewMethods(laptop.ctx)['elu.mine'](params, laptop.conn));
  // Every connection says each side's half: a computer that never marked this one says no each time.
  mine({ mine: false }); mine({ mine: false }); mine({ mine: false });
  assert.deepEqual(laptop.events, []);
  mine({ mine: true }); mine({ mine: true });
  assert.deepEqual(laptop.events, ['@devbox marks this computer as theirs']);
  mine({ mine: false }); mine({ mine: false });
  assert.deepEqual(laptop.events, ['@devbox marks this computer as theirs', '@devbox no longer marks this computer as theirs']);
  void devbox;
});

// ---- Two real daemons ----

const require = createRequire(import.meta.url);
const RUNNER = fileURLToPath(new URL('./peer-runner.mjs', import.meta.url));
async function until(check, label, timeout = 90000) {
  for (const started = Date.now(); ;) {
    let value; try { value = check(); } catch { value = null; }
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}
async function daemon(t, home, env) {
  const child = spawn(process.execPath, [RUNNER, JSON.stringify({ tickMs: 200, statusMs: 500, conductor: false, github: { gapMs: 500 } })], { env: { ...env, XDG_CONFIG_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stderr.on('data', data => { err += data; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const ready = await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { out += data; const line = out.split('\n').find(row => row.startsWith('{')); if (line) resolve(JSON.parse(line)); });
    child.once('exit', code => reject(new Error(`daemon exited ${code}: ${err}`)));
  });
  if (!ready.ready) throw new Error(ready.error);
  return async () => { if (child.exitCode !== null || child.signalCode) return; child.stdin.end(); const timer = setTimeout(() => child.kill('SIGKILL'), 8000); await exited; clearTimeout(timer); };
}

test('two daemons on one team, signed in to the same GitHub account, become each other\'s computers by themselves', async t => {
  const createTestnet = require('hyperdht/testnet.js'), net = await createTestnet(3, { host: '127.0.0.1' }), stops = [];
  t.after(async () => { await Promise.all(stops.map(stop => stop())); await Promise.race([net.destroy(), new Promise(resolve => setTimeout(resolve, 10000))]); });
  const bootstrap = net.bootstrap.map(node => `${node.host}:${node.port}`), gh = fakeGh(t);
  const laptop = newHome(t), devbox = newHome(t);
  const box = withHome(devbox, () => createIdentity({ name: 'ana' }));
  const { teamId, log, me } = withHome(laptop, () => {
    const me = createIdentity({ name: 'ana' }), made = createTeam(me, 'core');
    redeemCode(createInvite(me, made.id, { hours: 1 }), box.key, 'ana');
    return { teamId: made.id, log: readLog(made.id).ops, me: me.key };
  });
  withHome(devbox, () => merge(teamId, log));
  withHome(laptop, () => savePeerSettings({ bootstrap, box: 'laptop' })); withHome(devbox, () => savePeerSettings({ bootstrap, box: 'devbox' }));
  // Nobody types /mine. The laptop starts first and makes the gist; the devbox finds it.
  stops.push(await daemon(t, laptop, gh.env('octo-user')));
  await until(() => gh.gists('octo-user').length === 1, 'the gist');
  stops.push(await daemon(t, devbox, gh.env('octo-user')));
  await until(() => withHome(laptop, () => bothMine(me, box.key)) && withHome(devbox, () => bothMine(box.key, me)), 'both computers mine');
  const logged = home => withHome(home, () => fs.readFileSync(peerFile('daemon.log'), 'utf8'));
  await until(() => logged(laptop).includes('@devbox is yours: both computers are signed in to GitHub as octo-user.'), 'the laptop says so');
  await until(() => logged(devbox).includes('@laptop is yours: both computers are signed in to GitHub as octo-user.'), 'the devbox says so');
  assert.equal(gh.gists('octo-user').length, 1);
  assert.deepEqual(Object.keys(gh.gists('octo-user')[0].files).sort(), [`${me}.json`, `${box.key}.json`].sort());
  assert.equal(writes(gh.calls()).filter(call => call.args.includes('POST')).length, 1, 'one gist made');
});
