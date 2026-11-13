import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { withHome, makeTeam, registeredProject } from './peer-helpers.mjs';
import { git } from './helpers.mjs';
import { hash } from '../lib/util.mjs';
import { repository } from '../lib/git.mjs';
import { saveTask, taskPlace } from '../lib/state.mjs';
import { nameProject, registeredProjects } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { identity as loadIdentity } from '../lib/peer/identity.mjs';
import { head, team } from '../lib/peer/roster.mjs';
import { cloneAddress, setBoardOff, unshare } from '../lib/peer/shares.mjs';
import { cardsFor, localRepos, saveCards, sessionCards, teammateSessions } from '../lib/peer/cards.mjs';
import { saveRemoteBoards, saveRemotePlans } from '../lib/peer/plans.mjs';
import { BINDING } from '../lib/peer/a2a.mjs';
import { PeerDaemon } from '../lib/peer/daemon.mjs';
import { cloneProject, saveTold, sharedRepos, toldProjects } from '../lib/peer/shared.mjs';
import * as peer from '../lib/peer/index.mjs';

// After joining a team, the joiner sees the project the team is about (item 39 of 0.1.20):
// the inviter's /invite shares the open project with the team, and the joiner, in a folder
// of their own, had no row for it anywhere.
const ORIGIN = 'https://github.com/acme/shop.git', SHOP = hash('github.com/acme/shop');
const iso = (ago = 0) => new Date(Date.now() - ago).toISOString();
// What the daemon wrote last, as the app reads it: who is online, and each machine's name.
function daemonState(me, teamId, members) {
  fs.mkdirSync(peerFile(), { recursive: true });
  fs.writeFileSync(peerFile('state.json'), JSON.stringify({ key: me, running: true, at: new Date().toISOString(), teams: [{ id: teamId, members }] }));
}
// A session of a project, working in the project's own repository.
function session(root, id, extra = {}) {
  const repo = repository(root), place = taskPlace(repo, id, root);
  saveTask(repo, { id: String(id), goal: 'Fix the cart total', state: 'running', repository: root, worktree: place.worktree, branch: place.branch, base: 'a'.repeat(40), createdAt: new Date().toISOString(), runs: [], reviews: [], messages: [], sessions: {}, ...extra });
}
// A Task as a teammate's machine tells it.
const told = (extra = {}) => ({ repoId: SHOP, handle: 'shop', id: 't-0a1b2c3d', revision: 1, title: 'Fix the login redirect', description: 'Text', goal: 'Sign-in returns to the page that asked.', objectives: ['One'],
  priority: 'high', severity: 'low', state: 'approved', startedBy: 'owner', who: 'Opus 5.5', subtasks: [], met: [], approvedAt: iso(60000), doneAt: null, updatedAt: iso(30000), ...extra });
// Ana (the inviter) has the shop, with an origin remote that carries a sign-in, named Shop
// and shared with the team as /invite does; and notes, a project with no remote.
function inviter(t, crew, { origin = 'https://ana:ghp_secretToken1234@github.com/acme/shop.git' } = {}) {
  return withHome(crew.founder.home, () => {
    const shop = registeredProject(t, { origin }), notes = registeredProject(t);
    nameProject(projectFolder(shop.root), 'Shop');
    peer.share(shop.root, { handle: 'shop', teams: [crew.teamId] }); peer.share(notes.root, { handle: 'notes', teams: [crew.teamId] });
    return { shop, notes };
  });
}

test('a git address is told only when it is a network address, and never with a password or a token', () => {
  assert.deepEqual([
    cloneAddress('https://github.com/acme/shop.git'), cloneAddress('https://ana:ghp_secretToken1234@github.com/acme/shop.git'), cloneAddress('https://x-access-token@GitHub.com/acme/shop'),
    cloneAddress('git@github.com:acme/shop.git'), cloneAddress('ssh://git@example.org:2222/acme/shop.git'), cloneAddress('ssh://git:hunter2@example.org/acme/shop.git'), cloneAddress('git://example.org/acme/shop.git\n'),
  ], ['https://github.com/acme/shop.git', 'https://github.com/acme/shop.git', 'https://github.com/acme/shop', 'git@github.com:acme/shop.git', 'ssh://git@example.org:2222/acme/shop.git', 'ssh://git@example.org/acme/shop.git', 'git://example.org/acme/shop.git']);
  // A folder of this machine, another transport, an option, or text that is not one address: none.
  for (const bad of ['/srv/git/shop.git', '../shop', 'file:///srv/git/shop.git', 'ext::sh -c "touch /tmp/x"', 'ext::sh', '-oProxyCommand=x', '--upload-pack=x', 'ssh://-oProxyCommand=x/acme/shop', 'https://github.com', 'https://github.com/a b', 'git@github.com:acme/shop.git; rm -rf x', '', null, 7, `https://github.com/${'a'.repeat(600)}`])
    assert.equal(cloneAddress(bad), null, String(bad));
});

test('a teammate is told each project shared with a team they are on: its handle, its name, its repository and its git address', t => {
  const crew = makeTeam(t), ana = crew.founder, { shop } = inviter(t, crew);
  withHome(ana.home, () => {
    // A folder of this machine as the remote: the repository is told, its address is not.
    const local = registeredProject(t, { origin: '/srv/git/tools.git' }); peer.share(local.root, { handle: 'tools', teams: [crew.teamId] });
    const daemon = Object.assign(new PeerDaemon({ conductor: () => {} }), { me: loadIdentity(), methods: {} });
    const wire = { out: '' }, socket = Object.assign(new EventEmitter(), { destroyed: false, write: chunk => { wire.out += chunk; return true; }, destroy() { this.destroyed = true; this.emit('close'); } });
    daemon.attach(socket, crew.member.identity.key);
    socket.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'elu.hello', params: { binding: BINDING, a2aVersion: '1.0', name: 'sara', teams: [{ id: crew.teamId, ...head(crew.teamId), ops: [] }], handles: [] } })}\n`));
    const status = () => wire.out.split('\n').flatMap(row => { try { const frame = JSON.parse(row); return frame.method === 'elu.status' ? [frame.params] : []; } catch { return []; } }).at(-1);
    assert.deepEqual(status().projects, [
      { handle: 'shop', name: 'Shop', repoId: SHOP, address: ORIGIN, teams: [crew.teamId] },
      { handle: 'notes', name: 'sample app', repoId: null, address: null, teams: [crew.teamId] },
      { handle: 'tools', name: 'sample app', repoId: hash('file/srv/git/tools'), address: null, teams: [crew.teamId] },
    ]);
    assert.equal(JSON.stringify(status()).includes('ghp_secretToken1234'), false, 'the sign-in in the remote never leaves');
    // Renamed, or no longer shared: every teammate hears it on the next tick.
    daemon.retell(); const before = wire.out.length;
    daemon.retell(); assert.equal(wire.out.length, before, 'nothing is sent again while nothing changed');
    nameProject(projectFolder(shop.root), 'Store'); unshare('notes'); daemon.retell();
    assert.deepEqual(status().projects.map(row => [row.handle, row.name]), [['shop', 'Store'], ['tools', 'sample app']]);
    // Someone on none of my teams is told nothing.
    assert.deepEqual(daemon.hello('f'.repeat(64)).handles, []);
  });
});

test('the joiner\'s Projects lists what the team shares and this computer does not have; a clone here, the share ending, or leaving the team takes the row away', t => {
  const crew = makeTeam(t), ana = crew.founder, sara = crew.member;
  inviter(t, crew);
  // What Ana's machine tells Sara's, and Sara's keeps as it comes in.
  const fromAna = withHome(ana.home, () => toldProjects([crew.teamId]));
  withHome(sara.home, () => {
    const me = loadIdentity();
    assert.deepEqual(peer.teammateProjects(), [], 'nothing before the inviter says what it shares');
    daemonState(me.key, crew.teamId, [{ key: ana.identity.key, name: 'ana', online: true, box: 'ana-mac' }]);
    saveTold(ana.identity.key, fromAna);
    const rows = peer.teammateProjects();
    assert.deepEqual(rows.map(row => [row.name, row.handle, row.repoId, row.address, row.teams.map(team => team.name), row.sharers.map(who => [who.name, who.box, who.online, who.mine])]), [
      ['sample app', 'notes', null, null, ['core'], [['ana', 'ana-mac', true, false]]],
      ['Shop', 'shop', SHOP, ORIGIN, ['core'], [['ana', 'ana-mac', true, false]]],
    ]);
    // Its team board: the Tasks and the sessions Ana's machine told for that repository.
    saveRemotePlans(ana.identity.key, [told(), told({ id: 't-other', repoId: 'e'.repeat(64), handle: 'docs', title: 'Elsewhere' })]);
    const kept = saveCards(ana.identity.key, me.key, [{ repoId: SHOP, id: '0123456789abcdef', title: 'Fix the cart total', column: 'progress', by: 'ana', at: iso(1000) }, { repoId: 'e'.repeat(64), id: '1123456789abcdef', title: 'Elsewhere', column: 'progress', by: 'ana', at: iso(1000) }], { repos: new Map(), proofs: [], shared: sharedRepos(me.key, ana.identity.key) });
    assert.deepEqual(kept.map(card => card.title), ['Fix the cart total'], 'kept without a clone here only for a repository she shares with our team');
    const board = peer.teammateProjectBoard(rows.find(row => row.handle === 'shop').id);
    assert.deepEqual([board.plans.map(person => [person.name, person.box, person.online, person.tasks.map(task => task.title)]), board.sessions.map(person => [person.name, person.sessions.map(card => [card.title, card.column])])],
      [[['ana', 'ana-mac', true, ['Fix the login redirect']]], [['ana', [['Fix the cart total', 'progress']]]]]);
    assert.deepEqual(peer.teammateProjectBoard(rows.find(row => row.handle === 'notes').id).plans, [], 'a project with no remote has no repository to tell Tasks for');
    assert.equal(peer.teammateProjectBoard('nope'), null);
    // This computer gets a clone of the same repository (another spelling of the same remote):
    // the local project is the row, so the shared one is gone at once. Never two rows for one project.
    const mine = registeredProject(t, { origin: 'git@github.com:acme/shop.git' });
    assert.deepEqual(peer.teammateProjects().map(row => row.handle), ['notes']);
    assert.equal(registeredProjects().some(repo => repo.root === mine.root), true);
    // The cards of that repository still show on the local project's board only by proof, as before.
    assert.deepEqual(teammateSessions(mine.root), { repos: [], people: [] });
    // She stops sharing notes: her next status leaves it out, and the row goes.
    saveTold(ana.identity.key, fromAna.filter(row => row.handle !== 'notes'));
    assert.deepEqual(peer.teammateProjects(), []);
    // Leaving the team takes every row of it away, whatever is still kept on disk.
    saveTold(ana.identity.key, [{ handle: 'web', name: 'Web', repoId: null, address: null, teams: [crew.teamId] }]);
    assert.deepEqual(peer.teammateProjects().map(row => row.name), ['Web']);
    peer.leaveTeam(crew.teamId);
    assert.equal(team(crew.teamId).members.find(m => m.key === me.key).removed, true);
    assert.deepEqual(peer.teammateProjects(), []);
  });
});

test('what a teammate says it shares is checked field by field, and an address of another repository is dropped', t => {
  const crew = makeTeam(t), ana = crew.founder.identity.key;
  withHome(crew.member.home, () => {
    saveTold(ana, [
      { handle: 'shop', name: '  Sh\x1b[31mop\x1b[0m\n\x07 ', repoId: SHOP, address: 'https://evil.example/other/repo.git', teams: [crew.teamId], path: '/Users/ana/shop' },
      { handle: 'shop', name: 'Again', repoId: SHOP, address: ORIGIN, teams: [crew.teamId] },
      { handle: 'ext', name: 'x', repoId: hash('sh -c x'), address: 'ext::sh -c x', teams: [crew.teamId] },
      { handle: 'Bad Handle', name: 'x', repoId: null, address: null, teams: [crew.teamId] }, { handle: 'noteam', name: 'x', repoId: null, address: null, teams: [] }, { handle: 'elsewhere', name: 'x', repoId: null, address: null, teams: ['f'.repeat(64)] },
      { handle: 'long', name: 'n'.repeat(500), repoId: 'nope', address: ORIGIN, teams: [crew.teamId, 7] }, null, 'x',
    ]);
    const rows = peer.teammateProjects();
    assert.deepEqual(rows.map(row => [row.handle, row.name.length <= 60 ? row.name : row.name.length, row.repoId, row.address]), [['long', 'n'.repeat(60), null, null], ['shop', 'Shop', SHOP, null], ['ext', 'x', hash('sh -c x'), null]]);
    assert.equal(JSON.stringify(rows).includes('/Users/ana'), false);
    // More than 20 are cut, and anything that is not a list keeps nothing.
    saveTold(ana, Array.from({ length: 40 }, (_, n) => ({ handle: `p${n}`, name: `P${n}`, repoId: null, address: null, teams: [crew.teamId] })));
    assert.equal(peer.teammateProjects().length, 20);
    saveTold(ana, null); assert.deepEqual(peer.teammateProjects(), []);
    assert.equal(fs.existsSync(peerFile('shared', `${ana}.json`)), false);
  });
});

test('a teammate on 0.1.19 still gives a row for each project it shares, from its boards and the handles its hello named', t => {
  const crew = makeTeam(t), ana = crew.founder.identity.key;
  withHome(crew.member.home, () => {
    const me = loadIdentity().key;
    // 0.1.19 sends no projects: boards for the shares with an origin remote, and handles in its hello.
    saveRemoteBoards(ana, [{ repoId: SHOP, handle: 'shop', commit: '1'.repeat(40), teams: [crew.teamId] }]);
    daemonState(me, crew.teamId, [{ key: ana, name: 'ana', online: true, box: 'ana-mac', handles: ['shop', 'notes'] }]);
    assert.deepEqual(peer.teammateProjects().map(row => [row.name, row.handle, row.repoId, row.address, row.sharers[0].older, row.sharers[0].name]), [['notes', 'notes', null, null, true, 'ana'], ['shop', 'shop', SHOP, null, true, 'ana']]);
    assert.deepEqual([...sharedRepos(me, ana)], [SHOP]);
    // Once it updates and tells its projects, those are what counts.
    saveTold(ana, [{ handle: 'shop', name: 'Shop', repoId: SHOP, address: ORIGIN, teams: [crew.teamId] }]);
    assert.deepEqual(peer.teammateProjects().map(row => [row.name, row.address, row.sharers[0].older]), [['Shop', ORIGIN, false]]);
  });
});

test('the sessions of a project shared with a team are told to its members who have no clone, and to nobody once it is kept off', t => {
  const crew = makeTeam(t), ana = crew.founder, sara = crew.member, now = Date.now();
  const { shop, notes } = inviter(t, crew, { origin: ORIGIN });
  withHome(ana.home, () => {
    // Another project of hers, of another repository, that she never shared.
    const own = registeredProject(t, { origin: 'https://github.com/acme/private.git' });
    session(shop.root, 1); session(own.root, 1, { goal: 'Private work' }); session(notes.root, 1, { goal: 'Notes work' });
    const repos = localRepos(now), rows = sessionCards({ me: ana.identity.key, owner: 'ana', repos, now });
    assert.deepEqual(rows.map(row => row.card.title).sort(), ['Fix the cart total', 'Private work']);
    // Sara proved no repository: she has no clone of any.
    const toSara = cardsFor(sara.identity.key, ana.identity.key, rows, repos, [], [crew.teamId]);
    assert.deepEqual(toSara.map(card => [card.title, card.repoId, card.column, card.by]), [['Fix the cart total', SHOP, 'progress', 'ana']]);
    for (const word of [shop.root, 'feat/task']) assert.equal(JSON.stringify(toSara).includes(word), false, word);
    // Someone on another team of hers, or on none, gets nothing without a proof.
    assert.deepEqual(cardsFor('d'.repeat(64), ana.identity.key, rows, repos, [], ['e'.repeat(64)]), []);
    assert.deepEqual(cardsFor('d'.repeat(64), ana.identity.key, rows, repos, [], []), []);
    // /share off keeps the project's sessions to herself again; /share on tells them again.
    setBoardOff(shop.root, true);
    assert.deepEqual(cardsFor(sara.identity.key, ana.identity.key, rows, repos, [], [crew.teamId]), []);
    assert.deepEqual(sessionCards({ me: ana.identity.key, owner: 'ana', repos, now }).map(row => row.card.title), ['Private work']);
    setBoardOff(shop.root, false);
    assert.deepEqual(cardsFor(sara.identity.key, ana.identity.key, rows, repos, [], [crew.teamId]).map(card => card.title), ['Fix the cart total']);
    // Unshared, nothing of it goes to a teammate who has no clone.
    unshare('shop');
    assert.deepEqual(cardsFor(sara.identity.key, ana.identity.key, rows, repos, [], [crew.teamId]), []);
  });
});

test('bringing a shared project here clones its address into a new folder, and says why when Git cannot', async t => {
  const crew = makeTeam(t), parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-bring-'))); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  // A repository served from this machine stands in for the network address: git reads the
  // https address through a rewrite rule of this test's own Git settings only.
  const source = path.join(parent, 'source'); fs.mkdirSync(source); git(source, ['init', '--initial-branch=main']); fs.writeFileSync(path.join(source, 'cart.js'), 'total = 1\n');
  git(source, ['add', '-A']); git(source, ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'first']);
  const config = path.join(parent, 'gitconfig'); fs.writeFileSync(config, `[url "${source}"]\n\tinsteadOf = https://github.com/acme/shop.git\n[url "${path.join(parent, 'nowhere')}"]\n\tinsteadOf = https://github.com/acme/missing.git\n`);
  const previous = process.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_GLOBAL = config; t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; });
  await withHome(crew.member.home, async () => {
    const target = path.join(parent, 'work', 'shop');
    assert.equal(await cloneProject(ORIGIN, target), target);
    assert.equal(fs.readFileSync(path.join(target, 'cart.js'), 'utf8'), 'total = 1\n');
    assert.equal(spawnSync('git', ['-C', target, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).stdout.trim(), ORIGIN);
    // A folder with something in it is never cloned over; an address that is not one is refused; a failed clone says Git's reason.
    await assert.rejects(async () => cloneProject(ORIGIN, target), /not empty/);
    await assert.rejects(async () => cloneProject('ext::sh -c x', path.join(parent, 'x')), /no git address/);
    await assert.rejects(async () => cloneProject('/srv/git/shop.git', path.join(parent, 'x')), /no git address/);
    await assert.rejects(cloneProject('https://github.com/acme/missing.git', path.join(parent, 'missing')), /Git could not copy it/);
    assert.equal(fs.existsSync(path.join(parent, 'x')), false);
  });
});
