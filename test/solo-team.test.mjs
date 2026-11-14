import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { project } from './helpers.mjs';
import { newHome, withHome, registeredProject } from './peer-helpers.mjs';
import { repository } from '../lib/git.mjs';
import { launchTerminal } from '../lib/terminal.mjs';
import { chatBar } from '../lib/terminal-visuals.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { savePeerSettings } from '../lib/peer/settings.mjs';
import { createIdentity, identity as loadIdentity } from '../lib/peer/identity.mjs';
import { createTeam, merge, readLog, removeOp, team, teams as everyTeam } from '../lib/peer/roster.mjs';
import { createInvite, openInvites, redeemCode } from '../lib/peer/invite.mjs';
import { shares, teamProjects } from '../lib/peer/shares.mjs';
import { peerCli } from '../lib/peer/cli.mjs';
import * as peer from '../lib/peer/index.mjs';

// One #general after a join. The first /invite makes a team so there is a code to send; a
// computer that then joins someone else's team must not keep its own, with only itself in
// it, as a second #general. Homes are XDG_CONFIG_HOME values, as in test/peer-helpers.mjs.

const require = createRequire(import.meta.url);
const RUNNER = fileURLToPath(new URL('./peer-runner.mjs', import.meta.url));
const CODE = 'k7qm-x2pd-9fhw';

// A team made in a home by a new identity there; its id.
const founded = (home, name, teamName) => withHome(home, () => createTeam(createIdentity({ name }), teamName).id);
// The identity of a home joins a team through a real invite of its founder's and gets the
// founder's whole log, as elu.invite.prove returns it (no network).
function admitTo(founderHome, teamId, home) {
  const me = withHome(home, () => loadIdentity());
  const log = withHome(founderHome, () => { redeemCode(createInvite(loadIdentity(), teamId, { hours: 1 }), me.key, me.name); return readLog(teamId).ops; });
  withHome(home, () => { const { rejected } = merge(teamId, log); if (rejected.length) throw new Error(rejected[0].reason); });
}
// What the first /invite does on a computer on no team (lib/terminal.mjs): a team named
// after the open project, and a code for it that nobody uses.
const firstInvite = (home, name = 'workspace') => withHome(home, () => { const made = peer.createTeam(name); return { id: made.id, name, code: createInvite(loadIdentity(), made.id, { hours: 24 }) }; });
// The #general rows of the Chats bar in a home, as drawn without colour.
const generals = home => withHome(home, () => chatBar({ status: peer.peerStatus(), items: [] }, 60, false).filter(row => row.value?.type === 'room' && row.value.channel === null).map(row => row.line.trimEnd()));
const teamNames = home => withHome(home, () => peer.peerStatus().teams.map(row => row.name).sort());
const closedFolder = (home, id) => withHome(home, () => peerFile('closed-teams', id));

// --- A local DHT testnet and one daemon process per home, as in test/peer-net.test.mjs. ---
const running = new WeakMap();
async function testnet(t) {
  const net = await require('hyperdht/testnet.js')(3, { host: '127.0.0.1' });
  running.set(t, []);
  t.after(async () => {
    await Promise.all(running.get(t).map(stop => stop()));
    await Promise.race([net.destroy(), new Promise(resolve => setTimeout(resolve, 10000))]);
  });
  return net.bootstrap.map(node => `${node.host}:${node.port}`);
}
async function daemon(t, home) {
  const child = spawn(process.execPath, [RUNNER, JSON.stringify({ conductor: false })], { env: { ...process.env, XDG_CONFIG_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stderr.on('data', data => { err += data; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const ready = await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { out += data; const line = out.split('\n').find(row => row.startsWith('{')); if (line) resolve(JSON.parse(line)); });
    child.once('exit', code => reject(new Error(`daemon exited ${code}: ${err}`)));
  });
  if (!ready.ready) throw new Error(ready.error);
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode) return;
    child.stdin.end(); const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    await exited; clearTimeout(timer);
  };
  running.get(t).push(stop);
  return ready;
}
async function wait(check, label, timeout = 90000) {
  for (const started = Date.now(); ;) {
    let value; try { value = await check(); } catch { value = null; }
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}
const read = (home, ...parts) => withHome(home, () => { const file = peerFile(...parts); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; });
const daemonLog = home => withHome(home, () => { try { return fs.readFileSync(peerFile('daemon.log'), 'utf8'); } catch { return ''; } });
async function run(home, command) {
  const { id } = withHome(home, () => peer.sendPeerCommand(command));
  const result = await wait(() => read(home, 'commands', `${id}.result.json`), `${command.type} result`);
  if (!result.ok) throw new Error(result.error);
  return result.result;
}

test('C runs /invite and nobody joins, A (on a team with B) invites, C joins: C has one #general with all three, and its own team is closed with nothing deleted', async t => {
  const bootstrap = await testnet(t), a = newHome(t), b = newHome(t), c = newHome(t);
  const elu = founded(a, 'ali', 'ELU');
  withHome(b, () => createIdentity({ name: 'sara' })); admitTo(a, elu, b);
  // C's first /invite makes its own team and a code. Nobody uses the code.
  withHome(c, () => createIdentity({ name: 'ali' }));
  const own = firstInvite(c), kept = withHome(c, () => fs.readFileSync(peerFile('teams', own.id, 'log.jsonl'), 'utf8'));
  for (const home of [a, c]) withHome(home, () => savePeerSettings({ bootstrap }));
  await daemon(t, a); await daemon(t, c);
  await wait(() => /invite topic [0-9a-f]{8} announced/.test(daemonLog(c)), 'the code of C to be announced');
  // A invites, and C joins with that code.
  const code = withHome(a, () => createInvite(loadIdentity(), elu, { hours: 1 }));
  const joined = await run(c, { type: 'join', code });
  assert.equal(joined.id, elu); assert.equal(joined.name, 'ELU');
  await wait(() => read(c, 'state.json')?.teams?.some(row => row.id === elu), 'the team in the state of C');
  // Chats on C: one #general, with A, B and C in it, and no second row.
  assert.deepEqual(generals(c), ['# general  3']);
  assert.deepEqual(teamNames(c), ['ELU']);
  // The join says which team it closed, and names no count of teams: there is one.
  assert.deepEqual(joined.closed, [{ id: own.id, name: 'workspace' }]);
  assert.equal(joined.teams, undefined);
  assert.match(daemonLog(c), /closed workspace: nobody else was ever on it/);
  // Its open code stops working: nothing on C answers for it, and its topic is left.
  assert.deepEqual(withHome(c, () => openInvites(everyTeam().map(row => row.id))), []);
  assert.throws(() => withHome(c, () => redeemCode(own.code, 'f'.repeat(64), 'kim')), /This invite is not valid\./);
  await wait(() => /invite topic [0-9a-f]{8} left/.test(daemonLog(c)), 'the topic of the closed code to be left');
  // Nothing was deleted: the team's log and its invite list are kept, out of the teams folder.
  assert.equal(fs.existsSync(withHome(c, () => peerFile('teams', own.id))), false);
  assert.equal(fs.readFileSync(path.join(closedFolder(c, own.id), 'log.jsonl'), 'utf8'), kept);
  assert.ok(fs.existsSync(path.join(closedFolder(c, own.id), 'invites.json')));
  // A sees C on the team.
  assert.deepEqual(withHome(a, () => team(elu)).members.map(member => member.name), ['ali', 'sara', 'ali']);
});

test('a join that leaves me on two teams that both have other people closes neither and says there are two; Chats names each #general by its team', async t => {
  const bootstrap = await testnet(t), a = newHome(t), c = newHome(t), d = newHome(t);
  const elu = founded(a, 'ali', 'ELU'), side = founded(c, 'kim', 'side');
  withHome(d, () => createIdentity({ name: 'dan' })); admitTo(c, side, d);
  for (const home of [a, c]) withHome(home, () => savePeerSettings({ bootstrap }));
  await daemon(t, a); await daemon(t, c);
  const code = withHome(a, () => createInvite(loadIdentity(), elu, { hours: 1 }));
  const joined = await withHome(c, () => peerCli(['join', code], {}));
  assert.equal(joined.team.closed, undefined);
  // The answer of a join holds nothing new unless a team was closed: the count is read from this machine's files.
  assert.equal(joined.team.teams, undefined);
  assert.equal(withHome(c, () => peer.teamCount()), 2);
  assert.match(joined.message, /^Joined ELU with ali\. .* You are on 2 teams now, each with its own #general\.$/);
  await wait(() => read(c, 'state.json')?.teams?.length === 2, 'both teams in the state of C');
  assert.deepEqual(generals(c).sort(), ['# general · ELU  2', '# general · side  2']);
  assert.ok(fs.existsSync(withHome(c, () => peerFile('teams', side))) && !fs.existsSync(closedFolder(c, side)));
});

test('only a team of mine that nobody else was ever on is closed, only beside a team somebody else is on, and its share and setting go with it', t => {
  const a = newHome(t), c = newHome(t), d = newHome(t);
  const elu = founded(a, 'ali', 'ELU');
  withHome(c, () => createIdentity({ name: 'kim' })); withHome(d, () => createIdentity({ name: 'dan' }));
  // My only team stays, however empty: it is where my code is.
  const own = firstInvite(c);
  const { root } = withHome(c, () => { const made = registeredProject(t); peer.share(made.root, { teams: [own.id] }); peer.saveTeamAccess(own.id, { handling: 'auto', rules: 'Read only.', root: made.root }); return made; });
  assert.deepEqual(withHome(c, () => peer.closeSoloTeams()), []);
  assert.deepEqual(teamNames(c), ['workspace']);
  // Teams that have, or had, someone else: a teammate still on one, and one who was removed from another.
  const { had, has } = withHome(c, () => ({ had: peer.createTeam('had').id, has: peer.createTeam('has').id }));
  admitTo(c, had, d); admitTo(c, has, d);
  withHome(c, () => removeOp(loadIdentity(), had, withHome(d, () => loadIdentity()).key));
  assert.deepEqual(withHome(c, () => team(had)).members.filter(member => !member.removed).map(member => member.name), ['kim']);
  // On a team with others now: the one nobody else was ever on is closed, and only that one.
  admitTo(a, elu, c);
  assert.deepEqual(withHome(c, () => peer.closeSoloTeams()), [{ id: own.id, name: 'workspace' }]);
  assert.deepEqual(teamNames(c), ['ELU', 'had', 'has']);
  assert.deepEqual(withHome(c, () => peer.closeSoloTeams()), [], 'a second look closes nothing');
  // As after a leave: the project is no longer that team's, and what teammates could do there is forgotten. The folder and its share row stay.
  assert.ok(fs.existsSync(path.join(root, 'package.json')));
  assert.deepEqual(withHome(c, () => shares().map(row => [row.root, row.teams])), [[root, []]]);
  assert.deepEqual(withHome(c, () => teamProjects()), {});
  assert.equal(withHome(c, () => peer.teamAccess(own.id)), null);
  assert.throws(() => withHome(c, () => redeemCode(own.code, 'f'.repeat(64), 'eve')), /This invite is not valid\./);
  assert.ok(fs.existsSync(path.join(closedFolder(c, own.id), 'log.jsonl')));
});

test('a team whose code somebody used is never closed, and a machine with no identity is asked nothing', t => {
  const a = newHome(t), c = newHome(t), d = newHome(t), empty = newHome(t);
  assert.deepEqual(withHome(empty, () => peer.closeSoloTeams({ once: true })), []);
  assert.equal(fs.existsSync(path.join(empty, 'elu-code')), false, 'nothing is written on a machine that never used teams');
  const elu = founded(a, 'ali', 'ELU');
  withHome(c, () => createIdentity({ name: 'kim' })); withHome(d, () => createIdentity({ name: 'kim' }));
  // Another computer of mine came on with my code: the team is ours, not mine alone.
  const own = firstInvite(c); withHome(c, () => redeemCode(own.code, withHome(d, () => loadIdentity()).key, 'kim'));
  admitTo(a, elu, c);
  assert.deepEqual(withHome(c, () => peer.closeSoloTeams()), []);
  assert.deepEqual(teamNames(c), ['ELU', 'workspace']);
});

// --- The app, over the real files of a home. No daemon is started. ---
const cleanups = new WeakMap();
function owned(t) {
  if (!cleanups.has(t)) {
    const value = { views: [], files: [] }; cleanups.set(t, value);
    t.after(async () => {
      let failure = null;
      for (const close of [...value.views.reverse(), ...value.files.reverse()]) { try { await close(); } catch (error) { failure ??= error; } }
      if (failure) throw failure;
    });
  }
  return cleanups.get(t);
}
const later = t => ({ after: close => owned(t).files.push(close) });
async function until(check, message = 'condition', timeout = 10000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${typeof message === 'function' ? message() : message}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
// The home the app reads, for the rest of the test.
function useHome(t, home) {
  const values = { XDG_CONFIG_HOME: home, NO_COLOR: '1', TERM: 'xterm-256color' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  owned(t).files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// The facade the app uses, over the files of the active home. Nothing is started, and the
// daemon reads as running so /invite goes on to its code.
const calm = (extra = {}) => ({ ...peer, startPeer: async () => false, restartStale: async () => false, peerStatus: (...args) => ({ ...peer.peerStatus(...args), running: true, stale: false }), ...extra });
async function view(t, { columns = 160, rows = 40, ...options } = {}) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = columns; output.rows = rows;
  let rendered;
  const finished = launchTerminal({ ...options, input, output, refreshMs: 30, startConductor: () => false, onRender: value => { rendered = value; } });
  finished.catch(() => {});
  await until(() => rendered, 'first render');
  // Closes what is open and quits, as the views of test/peer-ui.test.mjs do. A test that opens a second view closes the first itself.
  let done = false;
  const close = async () => {
    if (done) return; done = true;
    let closed = false; finished.then(() => { closed = true; }, () => { closed = true; });
    for (const started = Date.now(); !closed && !rendered.screen.destroyed;) {
      const waited = Date.now() - started;
      if (waited > 10000) { input.destroy(); output.destroy(); throw new Error('The view did not close after its test.'); }
      rendered.panels.ask.cancel();
      for (const child of [...rendered.screen.children]) { child.dismiss?.(); child.children?.find(item => item.type === 'textbox')?.emit('cancel'); }
      if (waited > 3000) process.emit('SIGHUP');
      else { rendered.panels.chat.focus(); rendered.screen.emit('keypress', 'q', { name: 'q' }); }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    input.destroy(); output.destroy();
  };
  owned(t).views.push(close);
  return { input, close, get current() { return rendered; }, get panels() { return rendered.panels; }, status: () => rendered.panels.status.getText() };
}
async function send(v, text) {
  v.panels.ask.focus(); v.panels.ask.readInput();
  await until(() => v.panels.ask.__listener, 'chat input');
  v.panels.ask.setValue(text); v.panels.ask.submit();
}
const modal = (v, title) => v.current.screen.children.find(child => !child.destroyed && child.options?.label?.trim() === title);
const rowsOf = (v, title) => modal(v, title)?.children.find(child => child.type === 'list')?.items.map(item => item.getText()) ?? [];
async function choose(v, title, pattern) {
  await until(() => rowsOf(v, title).some(line => pattern.test(line)), `${title}: ${pattern}`);
  const list = modal(v, title).children.find(child => child.type === 'list');
  list.select(list.items.findIndex(item => pattern.test(item.getText()))); v.input.write('\r');
}
async function closeDialog(v, title, value = '') {
  await until(() => modal(v, title), title);
  const field = modal(v, title).children.find(child => child.type === 'textbox');
  await until(() => field.__listener, `${title} input`); field.setValue(value); field.submit();
  await until(() => !modal(v, title), `${title} closed`);
}
// The #general rows of the Chats bar as the app draws them.
async function shownGenerals(v) {
  await send(v, '/chats'); await until(() => v.current.view === 'chats', 'Chats');
  const [bar] = v.panels.teamLists;
  await until(() => bar.items.some(item => /# general/.test(item.getText())), 'a #general row');
  return bar.items.map(item => item.getText().trim()).filter(line => /^# general/.test(line));
}

test('ELU opens on a computer an earlier version left on its own empty team and the team it joined: the empty one is closed once, one line says so, and Chats has one #general', { timeout: 60000 }, async t => {
  const a = newHome(t), b = newHome(t), c = newHome(t);
  const elu = founded(a, 'ali', 'ELU');
  withHome(b, () => createIdentity({ name: 'sara' })); admitTo(a, elu, b);
  // C ran /invite, nobody joined, and it then joined ELU with 0.1.19, which left it on both.
  withHome(c, () => createIdentity({ name: 'ali' }));
  const own = firstInvite(c); admitTo(a, elu, c);
  assert.deepEqual(generals(c).sort(), ['# general · ELU  3', '# general · workspace  1'], 'what 0.1.19 showed');
  const p = project(later(t)); useHome(t, c);
  const first = await view(t, { repo: repository(p.root), peer: calm() });
  let said = ''; try { await until(() => /closed/.test(first.status()), 'the line at the start', 3000); said = first.status(); } catch { said = first.status(); }
  assert.deepEqual(await shownGenerals(first), ['# general  3']);
  assert.match(said, /Your team workspace had only you, so it was closed\./);
  assert.ok(fs.existsSync(path.join(closedFolder(c, own.id), 'log.jsonl')), 'kept, out of the teams folder');
  // Once: the next start says nothing, and a team made on purpose after it stays.
  await first.close();
  const side = withHome(c, () => peer.createTeam('side').id);
  const second = await view(t, { repo: repository(p.root), peer: calm() });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.doesNotMatch(second.status(), /closed/);
  assert.deepEqual((await shownGenerals(second)).sort(), ['# general · ELU  3', '# general · side  1']);
  assert.ok(fs.existsSync(withHome(c, () => peerFile('teams', side))));
});

test('/join says in one sentence that my own empty team was closed, and that there are two teams when a join leaves two', { timeout: 60000 }, async t => {
  const c = newHome(t), elu = 'e'.repeat(64), own = 'f'.repeat(64);
  withHome(c, () => createIdentity({ name: 'ali' }));
  const p = project(later(t)); useHome(t, c);
  let answer = { id: elu, name: 'ELU', inviter: { name: 'ali', fingerprint: 'aaaaaaaa' }, closed: [{ id: own, name: 'workspace' }] };
  let count = 1;
  const v = await view(t, { repo: repository(p.root), peer: calm({ joinTeam: async () => answer, teamCount: () => count }) });
  const join = async () => { await send(v, `/join ${CODE}`); await choose(v, 'Join a team', /^Join$/); await choose(v, 'What teammates can do here', /^Auto/); await closeDialog(v, 'Rules for teammates', ''); };
  // The status row, without the mark it starts with.
  // What is new comes first: the row is one row, cut at its width, and what teammates can do here was just answered.
  const line = () => v.status().replace(/\s+/g, ' ').replace(/^› /, '').trim(), does = 'Their messages start sessions here, as if you typed them.';
  await join();
  await until(() => line().startsWith('Joined ELU with ali.'), () => `joined: ${JSON.stringify(line())}`);
  assert.equal(line(), `Joined ELU with ali. Your team workspace had only you, so it was closed. ${does}`);
  assert.ok('› Joined ELU with ali. Your team workspace had only you, so it was closed.'.length <= 78, 'the sentence is whole on a row of 80 columns');
  // Two teams that both have other people: nothing was closed, and the line says there are two.
  answer = { id: elu, name: 'ELU', inviter: { name: 'ali', fingerprint: 'aaaaaaaa' } }; count = 2;
  await join();
  await until(() => line().startsWith('Joined ELU with ali.') && !/closed/.test(line()), 'joined again');
  assert.equal(line(), `Joined ELU with ali. You are on 2 teams now, each with its own #general. ${does}`);
  // An ordinary join says neither.
  count = 1;
  await join();
  await until(() => line().startsWith('Joined ELU with ali.') && !/2 teams/.test(line()), 'joined a third time');
  assert.equal(line(), `Joined ELU with ali. ${does}`);
});

test('/invite on a team makes its code for that team and never another team: with several it asks which, and a member is told who can', { timeout: 60000 }, async t => {
  const a = newHome(t), c = newHome(t), d = newHome(t);
  withHome(c, () => createIdentity({ name: 'kim' })); withHome(d, () => createIdentity({ name: 'dan' }));
  const calls = [], facade = () => calm({ createInvite: async id => { calls.push(['createInvite', id]); return CODE; }, createTeam: name => { calls.push(['createTeam', name]); return peer.createTeam(name); } });
  const invite = async v => { await send(v, '/invite'); await choose(v, 'Invite', /^Someone new/); };
  const p = project(later(t)); useHome(t, c);
  // One team of my own with a teammate: the code is for it, with no question about which.
  const core = withHome(c, () => peer.createTeam('core').id); admitTo(c, core, d);
  withHome(c, () => peer.saveTeamAccess(core, { handling: 'auto', rules: '' }));
  const one = await view(t, { repo: repository(p.root), peer: facade() });
  await invite(one); await until(() => modal(one, 'Team invite'), 'the code');
  assert.equal(modal(one, 'Which team'), undefined);
  assert.deepEqual(calls, [['createInvite', core]]);
  await closeDialog(one, 'Team invite');
  // Two teams I can invite to: it asks which, and Esc makes no code.
  const docs = withHome(c, () => peer.createTeam('docs').id); admitTo(c, docs, d);
  withHome(c, () => peer.saveTeamAccess(docs, { handling: 'auto', rules: '' }));
  calls.length = 0;
  await invite(one); await until(() => rowsOf(one, 'Which team').length === 2, 'which team');
  assert.deepEqual(rowsOf(one, 'Which team').sort(), ['core', 'docs']);
  one.input.write('\x1b'); await until(() => /Nothing was done\. No invite was made\./.test(one.status()), 'esc');
  assert.deepEqual(calls, []);
  await invite(one); await choose(one, 'Which team', /^docs$/); await until(() => modal(one, 'Team invite'), 'the code for docs');
  assert.deepEqual(calls, [['createInvite', docs]]);
  await until(() => /Invite for docs ready/.test(one.status()), 'named in the line');
  await closeDialog(one, 'Team invite');
  // On a team somebody else made: no code, no new team, and who to ask.
  const b = newHome(t), elu = founded(a, 'ali', 'ELU');
  withHome(b, () => createIdentity({ name: 'sara' })); admitTo(a, elu, b);
  await one.close();
  calls.length = 0; process.env.XDG_CONFIG_HOME = b;
  const member = await view(t, { repo: repository(p.root), peer: facade() });
  await invite(member);
  await until(() => /Only an admin of ELU can make an invite code\. Ask ali, who made the team\./.test(member.status()), 'who can');
  assert.deepEqual(calls, []);
  assert.deepEqual(teamNames(b), ['ELU']);
});
