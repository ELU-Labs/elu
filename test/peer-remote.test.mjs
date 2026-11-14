import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTeam, newHome, withHome, registeredProject, liveTask } from './peer-helpers.mjs';
import { fakeClis } from './helpers.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { bothMine, dropStrangers, markMine, markedMine, mineRows, noteTheirs, unmarkMine } from '../lib/peer/mine.mjs';
import { NOT_MINE, UPDATE, UPDATE_LIST, hostMethods, hostTick, listTick, relist, remoteCommand, remoteConnected, remoteMachines, remoteSessions, viewMethods, viewTick, watchId } from '../lib/peer/remote.mjs';
import { repository } from '../lib/git.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { leaveOp, merge, readLog } from '../lib/peer/roster.mjs';
import { otherSessions } from '../lib/peer/session-tools.mjs';
import { createInvite, redeemCode, takeMineOffer } from '../lib/peer/invite.mjs';
import { pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { requestApproval, pendingApprovals } from '../lib/approvals.mjs';
import { Conductor, enqueue } from '../lib/conductor.mjs';
import { boardRows, remoteRow, rowActions, rowTitle } from '../lib/board.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';
import { sessionChanges } from '../lib/diff.mjs';
import { sessionFiles } from '../lib/session-work.mjs';
import { teamPath } from '../lib/peer/roster.mjs';
import { readTask, saveTask, taskPlace } from '../lib/state.mjs';
import { spawnSync } from 'node:child_process';
import { projectFolder } from '../lib/workspace.mjs';
import { registerProject, registeredProjects } from '../lib/projects.mjs';
import { localRepos, saveLocalRepos } from '../lib/peer/cards.mjs';
import { folderRemote } from '../lib/kanban-repos.mjs';
import { closeSession } from '../lib/kanban.mjs';
import * as peerFacade from '../lib/peer/index.mjs';
import { listEntries, usesSavedRules } from '../lib/permission-rules.mjs';
import { getRecord, records, saveRecord } from '../lib/peer/taskstore.mjs';
import { task as a2aTask, TaskState } from '../lib/peer/a2a.mjs';
import { textMethods } from '../lib/peer/texts.mjs';
import { FRAME_MAX } from '../lib/peer/transport.mjs';
import { PIECE } from '../lib/peer/pictures.mjs';
import { savePeerPolicy } from '../lib/peer/settings.mjs';

// A connection as the daemon hands it to a method: admitted, on a build that has remote
// sessions unless said otherwise, recording what is sent to it.
function connection(key, { remote = 1, answer = null } = {}) {
  const sent = [];
  return { key, admitted: true, remoteHello: remote ? { remote } : {}, sent, notify: (method, params) => sent.push([method, params]), request: async (method, params) => { sent.push([method, params]); if (!answer) throw new Error('No answer'); return answer(method, params); } };
}
const context = (me, sessions = {}) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
// Ana's two machines: the team's founder (ana, the laptop) and a member (sara, the devbox).
function machines(t) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' });
  return { team, laptop: team.founder, devbox: team.member };
}
const METHODS = ['elu.remote.start', 'elu.remote.send', 'elu.remote.stop', 'elu.remote.answer', 'elu.remote.task', 'elu.remote.since', 'elu.remote.list', 'elu.remote.watch'];
const START = { id: crypto.randomUUID(), text: 'Make coupons upper case', permissions: 'ask', place: null, model: null, bots: ['reviewer'] };

test('a machine is mine only when both machines mark each other, and either side ends it', t => {
  const { laptop, devbox } = machines(t);
  withHome(laptop.home, () => {
    assert.equal(bothMine(laptop.identity.key, devbox.identity.key), false);
    markMine(laptop.identity.key, devbox.identity.key);
    assert.equal(markedMine(devbox.identity.key), true);
    assert.equal(bothMine(laptop.identity.key, devbox.identity.key), false, 'one side alone is not enough');
    noteTheirs(devbox.identity.key, true);
    assert.equal(bothMine(laptop.identity.key, devbox.identity.key), true);
    assert.deepEqual(mineRows().map(row => [row.key, row.mine, row.theirs]), [[devbox.identity.key, true, true]]);
    // The other side takes its mark back: no longer mine here either.
    noteTheirs(devbox.identity.key, false);
    assert.equal(bothMine(laptop.identity.key, devbox.identity.key), false);
    noteTheirs(devbox.identity.key, true); unmarkMine(devbox.identity.key);
    assert.equal(bothMine(laptop.identity.key, devbox.identity.key), false, 'this side took it back');
    assert.throws(() => markMine(laptop.identity.key, 'f'.repeat(64)), { message: 'Choose one of your teammates.' });
    assert.throws(() => markMine(laptop.identity.key, laptop.identity.key), { message: 'Choose one of your teammates.' });
  });
});

test('leaving the last team two machines share drops the mark on both', t => {
  const { team, laptop, devbox } = machines(t);
  withHome(laptop.home, () => { markMine(laptop.identity.key, devbox.identity.key); noteTheirs(devbox.identity.key, true); });
  withHome(devbox.home, () => { markMine(devbox.identity.key, laptop.identity.key); noteTheirs(laptop.identity.key, true); assert.equal(bothMine(devbox.identity.key, laptop.identity.key), true); });
  const leave = withHome(devbox.home, () => leaveOp(devbox.identity, team.teamId).op);
  withHome(laptop.home, () => {
    merge(team.teamId, [leave]);
    assert.equal(bothMine(laptop.identity.key, devbox.identity.key), false, 'not on a team together');
    assert.deepEqual(dropStrangers(laptop.identity.key), [devbox.identity.key]);
    assert.deepEqual(mineRows(), []);
  });
  withHome(devbox.home, () => { assert.deepEqual(dropStrangers(devbox.identity.key), [laptop.identity.key]); assert.deepEqual(mineRows(), []); });
});

test('an invite for another computer of mine is marked on its row', t => {
  const { team, laptop } = machines(t);
  withHome(laptop.home, () => {
    createInvite(laptop.identity, team.teamId, { hours: 1, mine: true });
    const rows = JSON.parse(fs.readFileSync(teamPath(team.teamId, 'invites.json'), 'utf8'));
    assert.equal(rows.at(-1).mine, true);
  });
});

test('a code for another computer of mine marks nothing until its joiner says yes, and that yes is taken once', t => {
  const { team, laptop, devbox } = machines(t);
  const box = withHome(newHome(t), () => createIdentity({ name: 'ana' })), kim = withHome(newHome(t), () => createIdentity({ name: 'kim' }));
  withHome(laptop.home, () => {
    redeemCode(createInvite(laptop.identity, team.teamId, { hours: 1, mine: true }), box.key, 'ana');
    redeemCode(createInvite(laptop.identity, team.teamId, { hours: 1 }), kim.key, 'kim');
    assert.deepEqual(mineRows(), [], 'the join itself marks nothing');
    const ctx = context(laptop.identity), mine = viewMethods(ctx)['elu.mine'];
    // A teammate from a plain invite says yes: that only waits for /mine here.
    const fromKim = connection(kim.key); mine({ mine: true }, fromKim);
    assert.equal(markedMine(kim.key), false); assert.deepEqual(fromKim.sent, []);
    // A no from the machine the mine code admitted marks nothing either.
    const fromBox = connection(box.key); mine({ mine: false }, fromBox);
    assert.equal(markedMine(box.key), false);
    // Its yes does: this side marks it back and says so.
    mine({ mine: true }, fromBox);
    assert.equal(bothMine(laptop.identity.key, box.key), true); assert.deepEqual(fromBox.sent, [['elu.mine', { mine: true }]]);
    // Taken once: after /mine remove here, saying yes again does not bring it back.
    unmarkMine(box.key); mine({ mine: false }, fromBox); mine({ mine: true }, fromBox);
    assert.equal(markedMine(box.key), false);
    // Not after a week.
    redeemCode(createInvite(laptop.identity, team.teamId, { hours: 1, mine: true }), 'f'.repeat(64), 'eve');
    assert.equal(takeMineOffer([team.teamId], 'f'.repeat(64), Date.now() + 8 * 86400000), false);
    assert.equal(takeMineOffer([team.teamId], 'f'.repeat(64)), true);
    void devbox;
  });
});

test('every remote method is refused from a teammate who is not mine, and a refused start leaves nothing', t => {
  const { team, laptop, devbox } = machines(t);
  withHome(devbox.home, () => {
    const project = registeredProject(t); saveTeamAccess(team.teamId, { root: project.root });
    const stranger = connection(laptop.identity.key), ctx = context(devbox.identity), methods = { ...hostMethods(ctx), ...viewMethods(ctx) };
    for (const method of [...METHODS, 'elu.remote.events']) assert.throws(() => methods[method]({ ...START, items: [] }, stranger), { message: NOT_MINE }, method);
    // Marked on this side only: still refused.
    markMine(devbox.identity.key, laptop.identity.key);
    for (const method of METHODS) assert.throws(() => methods[method](START, stranger), { message: NOT_MINE }, method);
    // Mine on both sides, but over a connection that was never admitted: refused.
    noteTheirs(laptop.identity.key, true);
    for (const method of METHODS) assert.throws(() => methods[method](START, { ...stranger, admitted: false }), { message: NOT_MINE }, method);
    assert.deepEqual(pendingRequests(project.root), []);
    // Nothing goes out to a key that is not mine: the events of a session started by another key stay here.
    assert.deepEqual(stranger.sent, []);
  });
});

test('a session from my other computer starts as my own, with its bots, in the project of our team', t => {
  const { team, laptop, devbox } = machines(t);
  withHome(devbox.home, () => {
    markMine(devbox.identity.key, laptop.identity.key); noteTheirs(laptop.identity.key, true);
    const from = connection(laptop.identity.key), ctx = context(devbox.identity, { [laptop.identity.key]: from }), methods = hostMethods(ctx);
    // No project on this computer at all: said plainly.
    assert.throws(() => methods['elu.remote.start'](START, from), { message: 'No project is open there yet. Open ELU once on that computer, in the folder to work in, then send it again.' });
    const project = registeredProject(t); saveTeamAccess(team.teamId, { root: project.root });
    assert.throws(() => methods['elu.remote.start']({ ...START, bots: ['nobody'] }, from), { message: '@nobody is not a bot on this computer. Make it there, or start without it.' });
    const started = methods['elu.remote.start'](START, from);
    assert.equal(started.id, START.id); assert.equal(started.project, path.basename(project.root));
    const [request] = pendingRequests(project.root);
    assert.equal(request.goal, START.text); assert.equal(request.permissions, 'ask'); assert.deepEqual(request.bots, ['reviewer']);
    assert.deepEqual(request.mine, { machine: laptop.identity.key, name: laptop.identity.key.slice(0, 4), remoteId: START.id });
    assert.equal(request.origin, undefined, 'no teammate origin: it is my own session');
    // The same id again is the same session; another key cannot take it.
    assert.deepEqual(methods['elu.remote.start'](START, from), started);
    assert.equal(pendingRequests(project.root).length, 1);
    // A message before the session started waits for it; stop before it started takes the request back.
    assert.throws(() => methods['elu.remote.send']({ id: START.id, text: 'And the tests' }, from), { message: 'This session has not started yet. Send this once it has.' });
    assert.throws(() => methods['elu.remote.send']({ id: crypto.randomUUID(), text: 'x' }, from), { message: 'That session is not on this computer.' });
    assert.deepEqual(methods['elu.remote.stop']({ id: START.id }, from), { stopping: true });
    assert.deepEqual(pendingRequests(project.root), []);
  });
});

// The devbox with no team setting: sessions from my laptop run where my own sessions there run.
test('with no team setting, a session from my other computer runs in the only project there, the home folder too, to the end', async t => {
  const { laptop, devbox } = machines(t);
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-remote-home-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const home = path.join(parent, 'home'); fs.mkdirSync(home);
  const fake = fakeClis(parent, { mode: 'answer' }), names = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, fake.env, { HOME: home, XDG_CONFIG_HOME: devbox.home });
  let conductor = null;
  try {
    // He runs the app from his home folder there, a folder that is no repository, and never chose a project with /access.
    const repo = projectFolder(home); registerProject(repo);
    assert.equal(repo.common, null);
    markMine(devbox.identity.key, laptop.identity.key); noteTheirs(laptop.identity.key, true);
    const from = connection(laptop.identity.key), methods = hostMethods(context(devbox.identity, { [laptop.identity.key]: from }));
    const started = methods['elu.remote.start']({ ...START, id: crypto.randomUUID(), text: 'Where are the tests?', bots: [] }, from);
    assert.equal(started.project, 'home');
    const [request] = pendingRequests(home);
    assert.equal(request.mine.machine, laptop.identity.key); assert.equal(request.origin, undefined);
    // The conductor runs it there as a session typed there would run.
    conductor = new Conductor({ tickMs: 20 }).start();
    for (const at = Date.now(); pendingRequests(home).find(row => row.id === request.id)?.state !== 'done';) {
      if (Date.now() - at > 30000) throw new Error(`Timed out: ${JSON.stringify(pendingRequests(home))}`);
      await new Promise(done => setTimeout(done, 20));
    }
    const task = readTask(repo, pendingRequests(home).find(row => row.id === request.id).taskId);
    assert.equal(task.state, 'answered'); assert.equal(task.worktree, home); assert.equal(task.origin.mine, true); assert.equal(task.origin.peer, undefined);
  } finally {
    await conductor?.stop();
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

// The devbox with no team setting, where the owner runs the app from his home folder: a session
// from his laptop would run in the home folder. The laptop asks that computer first, and he picks
// the folder the session works in: a project there, or a Git repository in its home folder, which
// becomes a project there as opening it there would. It is asked each time, while the home folder
// is a project there: the folder where it would run is the one picked unless he moves.
test('a session from my other computer that would run where the home folder is a project works in the folder I pick there, to the end', async t => {
  const { team, laptop, devbox } = machines(t);
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-remote-pick-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const home = path.join(parent, 'home'); fs.mkdirSync(home);
  const fake = fakeClis(parent, { mode: 'answer' }), names = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, fake.env, { HOME: home, XDG_CONFIG_HOME: devbox.home });
  const clone = dir => {
    fs.mkdirSync(dir, { recursive: true });
    for (const args of [['init', '-q', '--initial-branch=main'], ['config', 'user.name', 'Test Owner'], ['config', 'user.email', 'owner@example.invalid'], ['commit', '-q', '--allow-empty', '-m', 'First']]) assert.equal(spawnSync('git', args, { cwd: dir }).status, 0, args.join(' '));
    return fs.realpathSync(dir);
  };
  let conductor = null;
  try {
    const repo = projectFolder(home); registerProject(repo);
    // Two clones in the home folder, one inside a folder of its own; a folder that is no
    // repository; a linked worktree of the first; and a folder outside the home folder.
    const shop = clone(path.join(home, 'shop')), infra = clone(path.join(home, 'work', 'infra'));
    fs.mkdirSync(path.join(home, 'notes')); fs.mkdirSync(path.join(shop, 'sub')); const outside = clone(path.join(parent, 'outside'));
    assert.equal(spawnSync('git', ['worktree', 'add', '-q', '-b', 'two', path.join(home, 'shop-two')], { cwd: shop }).status, 0);
    markMine(devbox.identity.key, laptop.identity.key); noteTheirs(laptop.identity.key, true);
    const from = connection(laptop.identity.key), methods = hostMethods(context(devbox.identity, { [laptop.identity.key]: from }));
    // It would run in the home folder: the home folder first, then each repository in it.
    const where = methods['elu.remote.folders']({}, from);
    assert.deepEqual({ ...where, folders: null }, { pick: true, root: home, project: 'home', folders: null });
    assert.deepEqual(where.folders[0], { path: home, label: '~', name: 'home', project: true });
    assert.deepEqual(where.folders.slice(1).map(row => row.label).sort(), ['~/shop', '~/work/infra']);
    assert.deepEqual(where.folders.find(row => row.label === '~/shop'), { path: shop, label: '~/shop', name: 'shop', project: false });
    assert.equal(where.folders.find(row => row.label === '~/work/infra').path, infra);
    // A folder it did not list is refused, and nothing is queued anywhere.
    const start = (folder, text = 'Where are the tests?') => methods['elu.remote.start']({ ...START, id: crypto.randomUUID(), text, bots: [], folder }, from);
    const NOT_HERE = /is not a project or a Git repository in the home folder here\. Pick one of the folders listed\./;
    for (const folder of [path.join(home, 'notes'), path.join(home, 'shop-two'), parent, outside, path.join(shop, 'sub')]) assert.throws(() => start(folder), NOT_HERE, folder);
    assert.throws(() => start('shop'), { message: 'Pick one of the folders listed.' });
    assert.throws(() => start(path.join(home, 'gone')), /is not on this computer any more\. Pick one of the folders listed\./);
    assert.deepEqual(pendingRequests(home), []);
    // The one he picks: a session of his there, in that repository, made a project there.
    const started = start(shop);
    assert.equal(started.project, 'shop');
    assert.ok(registeredProjects().some(row => row.root === shop), 'a project there now');
    assert.deepEqual(pendingRequests(home), []);
    const [request] = pendingRequests(shop);
    assert.equal(request.mine.machine, laptop.identity.key); assert.equal(request.origin, undefined);
    conductor = new Conductor({ tickMs: 20 }).start();
    for (const at = Date.now(); pendingRequests(shop).find(row => row.id === request.id)?.state !== 'done';) {
      if (Date.now() - at > 30000) throw new Error(`Timed out: ${JSON.stringify(pendingRequests(shop))}`);
      await new Promise(done => setTimeout(done, 20));
    }
    const task = readTask(registeredProjects().find(row => row.root === shop), pendingRequests(shop).find(row => row.id === request.id).taskId);
    assert.equal(task.state, 'answered'); assert.equal(task.worktree, shop); assert.equal(task.origin.mine, true);
    // Next time it is asked again, now with that project where it would run.
    const again = methods['elu.remote.folders']({}, from);
    assert.equal(again.pick, true); assert.equal(again.root, shop); assert.equal(again.project, 'shop');
    assert.deepEqual(again.folders.filter(row => row.project).map(row => row.label).sort(), ['~', '~/shop']);
    assert.equal(again.folders.filter(row => row.path === shop).length, 1, 'listed once');
    // The home folder, picked: it runs there, as before.
    start(home, 'Tidy my notes'); assert.equal(pendingRequests(home).length, 1);
    // A team setting decides where they run: not asked. A folder picked anyway still goes where he picked.
    saveTeamAccess(team.teamId, { root: shop });
    assert.deepEqual(methods['elu.remote.folders']({}, from), { pick: false, root: shop, project: 'shop', folders: [] });
    start(infra, 'Look at the infra'); assert.equal(pendingRequests(infra).length, 1);
    // A teammate's computer is refused, as for every remote method.
    assert.throws(() => methods['elu.remote.folders']({}, connection('e'.repeat(64))), { message: NOT_MINE });
  } finally {
    await conductor?.stop();
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

// The laptop's daemon asks before it starts: an older build there is not asked, and starts as before.
test('my computer asks where a session would run there, and an older build there is not asked', async t => {
  const { laptop, devbox } = machines(t);
  await withHome(laptop.home, async () => {
    markMine(laptop.identity.key, devbox.identity.key); noteTheirs(devbox.identity.key, true);
    const answers = { 'elu.remote.folders': { pick: true, root: '/home/ana', project: 'home', folders: [{ path: '/home/ana', label: '~', name: 'home', project: true }, { path: '/home/ana/shop', label: '~/shop', name: 'shop', project: false }, { path: 'not/absolute', label: 'x', name: 'x', project: false }, { path: '/home/ana/\u0007bell', label: 'bell', name: 'bell', project: false }] }, 'elu.remote.start': { id: START.id, project: 'shop' } };
    const other = connection(devbox.identity.key, { answer: method => answers[method] }); other.remoteHello = { remote: 1, folders: 1 };
    const ctx = context(laptop.identity, { [devbox.identity.key]: other });
    assert.deepEqual(await remoteCommand(ctx, { type: 'remoteFolders', to: devbox.identity.key }), { pick: true, root: '/home/ana', project: 'home', folders: [{ path: '/home/ana', label: '~', name: 'home', project: true }, { path: '/home/ana/shop', label: '~/shop', name: 'shop', project: false }] }, 'a folder that is not a whole path is left out');
    const started = await remoteCommand(ctx, { type: 'remoteStart', to: devbox.identity.key, text: 'Where are the tests?', permissions: 'ask', folder: '/home/ana/shop' });
    assert.equal(started.project, 'shop');
    assert.deepEqual(other.sent.find(([method]) => method === 'elu.remote.start')[1].folder, '/home/ana/shop');
    // No folder picked: the start says nothing of one, as an older build expects.
    await remoteCommand(ctx, { type: 'remoteStart', to: devbox.identity.key, text: 'Again', permissions: 'ask' });
    assert.equal('folder' in other.sent.filter(([method]) => method === 'elu.remote.start')[1][1], false);
    // An older build: not asked, and the app starts where it would before.
    const old = connection(devbox.identity.key, { answer: () => ({}) });
    assert.deepEqual(await remoteCommand(context(laptop.identity, { [devbox.identity.key]: old }), { type: 'remoteFolders', to: devbox.identity.key }), { pick: false, root: null, project: null, folders: [], older: true });
    assert.deepEqual(old.sent, [], 'nothing was asked of it');
  });
});

test('a team setting still decides where a session from my other computer runs; without one, of several projects the one with the newest session does', t => {
  const { team, laptop, devbox } = machines(t);
  withHome(devbox.home, () => {
    markMine(devbox.identity.key, laptop.identity.key); noteTheirs(laptop.identity.key, true);
    const from = connection(laptop.identity.key), methods = hostMethods(context(devbox.identity, { [laptop.identity.key]: from }));
    const start = () => methods['elu.remote.start']({ ...START, id: crypto.randomUUID(), bots: [] }, from);
    const older = registeredProject(t), newer = registeredProject(t);
    chat(older.root, 1, { minutes: 30 }); chat(newer.root, 1, { minutes: 5 });
    start(); assert.equal(pendingRequests(newer.root).length, 1); assert.equal(pendingRequests(older.root).length, 0);
    // A session that started long ago and works now counts from when it started working.
    chat(older.root, 2, { minutes: 90, state: 'running', activeSince: new Date().toISOString() });
    start(); assert.equal(pendingRequests(older.root).length, 1);
    // The project /access chose wins over the newest.
    chat(newer.root, 2, { minutes: 0, activeSince: new Date(Date.now() + 60000).toISOString() });
    saveTeamAccess(team.teamId, { root: older.root });
    start(); assert.equal(pendingRequests(older.root).length, 2); assert.equal(pendingRequests(newer.root).length, 1);
    // A teammate's computer is refused as before, and nothing is queued.
    const kim = connection('e'.repeat(64));
    assert.throws(() => methods['elu.remote.start']({ ...START, id: crypto.randomUUID(), bots: [] }, kim), { message: NOT_MINE });
    assert.equal(pendingRequests(older.root).length + pendingRequests(newer.root).length, 3);
  });
});

test('mine on a request is checked and never mixed with a teammate origin', t => {
  const { devbox, laptop } = machines(t);
  withHome(devbox.home, () => {
    const project = registeredProject(t), mine = { machine: laptop.identity.key, name: 'ana', remoteId: START.id };
    assert.throws(() => enqueue(project.root, 'x', { mine: { ...mine, machine: 'nope' } }), /needs its key/);
    assert.throws(() => enqueue(project.root, 'x', { mine: { ...mine, extra: 1 } }));
    assert.throws(() => enqueue(project.root, 'x', { mine, continuationTaskId: '1' }), { message: 'Only a new session of yours comes from your other computer.' });
  });
});

// The host's events as one tick makes them, folded on the viewer. A gap waits for a catch-up.
test('events stream to the viewer, a gap is caught up by seq, and approvals are answered once from either side', async t => {
  const { team, laptop, devbox } = machines(t);
  const project = withHome(devbox.home, () => { const project = registeredProject(t); saveTeamAccess(team.teamId, { root: project.root }); markMine(devbox.identity.key, laptop.identity.key); noteTheirs(laptop.identity.key, true); return project; });
  withHome(laptop.home, () => { markMine(laptop.identity.key, devbox.identity.key); noteTheirs(devbox.identity.key, true); });
  // The two daemons, joined by calls: each side's methods run in its own home.
  const toHost = connection(laptop.identity.key), toViewer = connection(devbox.identity.key);
  const hostCtx = context(devbox.identity, { [laptop.identity.key]: toHost }), viewCtx = context(laptop.identity, { [devbox.identity.key]: toViewer });
  const host = hostMethods(hostCtx), viewer = viewMethods(viewCtx);
  toViewer.request = (method, params) => withHome(devbox.home, () => host[method](params, toHost));
  const started = await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteStart', to: devbox.identity.key, text: 'Make coupons upper case', permissions: 'ask', bots: ['reviewer'] }));
  assert.equal(started.project, path.basename(project.root));
  const viewed = () => withHome(laptop.home, () => remoteSessions().find(row => row.id === started.id));
  assert.equal(viewed().behind, true, 'it catches up at once');
  // Before the conductor takes it, the host says it is starting.
  withHome(devbox.home, () => hostTick(hostCtx));
  let pushed = toHost.sent.filter(([method]) => method === 'elu.remote.events');
  assert.equal(pushed.length, 1, 'events pushed to my other computer');
  assert.equal(pushed[0][1].items[0].events[0].state, 'starting');
  // The conductor took the request: the session (an editing one here) has a record and changes.
  const taskId = '1';
  withHome(devbox.home, () => { liveTask(project.root, { id: taskId, goal: 'Make coupons upper case' }); const [request] = pendingRequests(project.root); updateRequest(project.root, request.id, { state: 'running', taskId }); hostTick(hostCtx); });
  pushed = toHost.sent.filter(([method]) => method === 'elu.remote.events');
  assert.equal(pushed.length, 2);
  // The viewer missed the first push: what it has starts after a gap, so it shows nothing yet and catches up.
  withHome(laptop.home, () => viewer['elu.remote.events'](pushed[1][1], toViewer));
  assert.equal(viewed().seq, 0); assert.equal(viewed().behind, true);
  await withHome(laptop.home, () => viewTick(viewCtx));
  const caught = viewed();
  assert.equal(caught.behind, false); assert.equal(caught.state, 'ready'); assert.equal(caught.title, 'Make coupons upper case');
  assert.match(caught.diff.summary, /^1 file · \+\d+ −\d+$/); assert.match(caught.diff.patch, /value\.trim\(\)/);
  assert.equal(caught.seq, withHome(devbox.home, () => JSON.parse(fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'peer', 'remote', 'host', `${started.id}.json`), 'utf8')).seq));
  // Events already folded are not folded twice; one past a gap waits for the next catch-up.
  withHome(laptop.home, () => viewer['elu.remote.events'](pushed[1][1], toViewer));
  assert.equal(viewed().seq, caught.seq);
  withHome(laptop.home, () => viewer['elu.remote.events']({ items: [{ id: started.id, events: [{ seq: caught.seq + 5, type: 'step', text: 'later' }] }] }, toViewer));
  assert.equal(viewed().behind, true);
  assert.ok(!viewed().steps?.some(step => step.text === 'later'), 'nothing out of order is shown');
  // Another key's events for this session are dropped.
  withHome(laptop.home, () => assert.throws(() => viewer['elu.remote.events']({ items: [{ id: started.id, events: [{ seq: caught.seq + 1, type: 'step', text: 'forged' }] }] }, connection('e'.repeat(64))), { message: NOT_MINE }));
  // An approval the session waits for there: answered here, and only once.
  withHome(devbox.home, () => requestApproval({ id: 'approval-1x', root: project.root, taskId, role: 'lead', vendor: 'claude', tool: 'Bash', input: { command: 'touch x' } }));
  assert.deepEqual(await withHome(devbox.home, () => host['elu.remote.answer']({ id: started.id, approval: 'approval-1x', decision: 'allow' }, toHost)), { answered: true });
  assert.deepEqual(await withHome(devbox.home, () => host['elu.remote.answer']({ id: started.id, approval: 'approval-1x', decision: 'deny' }, toHost)), { answered: false }, 'the first answer wins');
  withHome(devbox.home, () => assert.deepEqual(pendingApprovals({ taskId }), []));
  // One the host's owner answers there is answered for the viewer too.
  withHome(devbox.home, () => requestApproval({ id: 'approval-2', root: project.root, taskId, role: 'bot:reviewer', vendor: 'claude', tool: 'Bash', input: { command: 'ls' } }));
  assert.deepEqual(await withHome(devbox.home, () => host['elu.remote.answer']({ id: started.id, approval: 'approval-2', decision: 'deny' }, toHost)), { answered: true });
  assert.deepEqual(await withHome(devbox.home, () => host['elu.remote.answer']({ id: started.id, approval: 'approval-2', decision: 'allow' }, toHost)), { answered: false });
  assert.throws(() => withHome(devbox.home, () => host['elu.remote.answer']({ id: started.id, approval: 'approval-2', decision: 'maybe' }, toHost)), { message: 'Answer allow or deny.' });
});

// A message I hand off from my laptop to my devbox and work on there as my own session is
// followed from the laptop like one it started: its approval waits there too, and my rules apply.
test('a handoff I work on as my own on my other computer shows there with its approvals, and uses my rules', async t => {
  const { team, laptop, devbox } = machines(t);
  const project = withHome(devbox.home, () => { const project = registeredProject(t); saveTeamAccess(team.teamId, { root: project.root }); markMine(devbox.identity.key, laptop.identity.key); noteTheirs(laptop.identity.key, true); return project; });
  withHome(laptop.home, () => { markMine(laptop.identity.key, devbox.identity.key); noteTheirs(devbox.identity.key, true); });
  const toHost = connection(laptop.identity.key), toViewer = connection(devbox.identity.key);
  const hostCtx = context(devbox.identity, { [laptop.identity.key]: toHost }), viewCtx = context(laptop.identity, { [devbox.identity.key]: toViewer });
  const host = hostMethods(hostCtx), viewer = viewMethods(viewCtx);
  toViewer.request = (method, params) => withHome(devbox.home, () => host[method](params, toHost));
  const taskId = '1', origin = { kind: 'handoff', peer: laptop.identity.key, name: 'ana', a2aTaskId: 'h-1', threadId: 'th-1', hop: 1, own: true };
  withHome(devbox.home, () => {
    const { repo } = liveTask(project.root, { id: taskId, goal: 'Run evals', state: 'running' });
    saveTask(repo, { ...readTask(repo, taskId), origin });
    enqueue(project.root, 'Run evals'); const [request] = pendingRequests(project.root); updateRequest(project.root, request.id, { state: 'running', taskId });
    saveRecord({ task: a2aTask({ id: 'h-1', contextId: 'th-1', state: TaskState.WORKING }), peer: laptop.identity.key, name: 'ana', kind: 'handoff', threadId: 'th-1', root: project.root, requestId: request.id, localTaskId: taskId, text: 'Run evals', createdAt: new Date().toISOString() });
    // A stranger's handoff is not followed from anywhere.
    saveRecord({ task: a2aTask({ id: 'h-2', contextId: 'th-2', state: TaskState.WORKING }), peer: 'e'.repeat(64), name: 'eve', kind: 'handoff', threadId: 'th-2', root: project.root, requestId: 'req-x', localTaskId: '9', text: 'Other', createdAt: new Date().toISOString() });
    assert.equal(usesSavedRules(origin), true, 'my own rules answer its approvals');
    assert.equal(usesSavedRules({ ...origin, peer: 'e'.repeat(64) }), false, 'a teammate\'s handoff gets the defaults');
    // A mark this machine made alone is not enough: the other machine must mark it back.
    noteTheirs(laptop.identity.key, false);
    assert.equal(markedMine(laptop.identity.key), true); assert.equal(usesSavedRules(origin), false, 'one side alone gets the defaults');
    noteTheirs(laptop.identity.key, true); assert.equal(usesSavedRules(origin), true);
    requestApproval({ id: 'approval-h1', root: project.root, taskId, role: 'lead', vendor: 'claude', tool: 'Bash', input: { command: 'npm install' } });
    hostTick(hostCtx); hostTick(hostCtx);
  });
  const remoteId = withHome(devbox.home, () => getRecord('h-1').remoteId);
  assert.ok(remoteId, 'the handoff is hosted');
  assert.equal(withHome(devbox.home, () => getRecord('h-2').remoteId), undefined);
  assert.equal(withHome(devbox.home, () => records().filter(record => record.remoteId).length), 1, 'once');
  const pushed = toHost.sent.filter(([method]) => method === 'elu.remote.events');
  assert.ok(pushed.length >= 1 && pushed.every(([, params]) => params.items.every(item => item.id === remoteId)));
  withHome(laptop.home, () => viewer['elu.remote.events'](pushed[0][1], toViewer));
  await withHome(laptop.home, () => viewTick(viewCtx));
  const seen = withHome(laptop.home, () => remoteSessions().find(row => row.id === remoteId));
  assert.ok(seen, 'the laptop shows it'); assert.equal(seen.title, 'Run evals');
  assert.deepEqual(seen.approvals.map(item => item.id), ['approval-h1']);
  assert.deepEqual(await withHome(devbox.home, () => host['elu.remote.answer']({ id: remoteId, approval: 'approval-h1', decision: 'allow' }, toHost)), { answered: true });
});

// a on an approval answered from the other computer keeps the rule where the session runs:
// its relay reads the rules there. The rule is made there from the request, never sent.
test('a session on another computer is drawn in parts, each keyed by what it shows, that keep their keys as entries come and go', () => {
  const glue = remoteGlue({ facade: { mineRows: () => [], remoteSessions: () => [] }, peerRead: () => null, peerCommand: async () => ({}), chatMessage: ({ title, text }) => `${title}\n${text}`, ink: text => text, colour: false });
  const at = new Date().toISOString(), said = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => ({ role: 'You', at, text: `Entry ${from + index}` }));
  const session = entries => remoteRow({ id: START.id, machine: 'd'.repeat(64), createdAt: at, state: 'running', title: 'Long', entries, steps: [{ at, text: 'Reading the cart' }], approvals: [], diff: { summary: '1 file', patch: '+ one' }, plan: { title: 'Fix it', goal: 'Totals add up', priority: 'P2', severity: 'S3', state: 'approved', objectives: [], subtasks: [], met: [] } }, 'devbox');
  const before = glue.parts(session(said(1, 5)), 80), after = glue.parts(session([...said(3, 5), { role: 'You', at, text: 'Entry 5' }, ...said(6, 7)]), 80);
  assert.equal(glue.view(session(said(1, 5)), 80), before.map(part => part.text).join('\n\n'));
  assert.equal(new Set(before.map(part => part.key)).size, before.length, 'no two parts share a key');
  // The entries that stay keep their keys; so do the parts below them.
  for (const part of before.filter(part => !/Entry [12]$/.test(part.text))) assert.ok(after.some(other => other.key === part.key && other.text === part.text), part.text);
  assert.ok(!after.some(part => before.slice(0, 2).some(gone => gone.key === part.key)), 'the entries that left the top are gone');
  assert.equal(after.filter(part => /Entry 5$/.test(part.text)).length, 2, 'the same entry twice is drawn twice');
});

test('a from my other computer keeps the rule on the computer the session runs on', async t => {
  const { team, laptop, devbox } = machines(t);
  const project = withHome(devbox.home, () => { const project = registeredProject(t); saveTeamAccess(team.teamId, { root: project.root }); markMine(devbox.identity.key, laptop.identity.key); noteTheirs(laptop.identity.key, true); return project; });
  withHome(laptop.home, () => { markMine(laptop.identity.key, devbox.identity.key); noteTheirs(devbox.identity.key, true); });
  const toHost = connection(laptop.identity.key), toViewer = connection(devbox.identity.key);
  const hostCtx = context(devbox.identity, { [laptop.identity.key]: toHost }), viewCtx = context(laptop.identity, { [devbox.identity.key]: toViewer });
  const host = hostMethods(hostCtx), viewer = viewMethods(viewCtx);
  toViewer.request = (method, params) => withHome(devbox.home, () => host[method](params, toHost));
  const started = await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteStart', to: devbox.identity.key, text: 'Run the tests', permissions: 'ask' }));
  const taskId = '1';
  // The session the laptop started is the owner's own there (origin.mine), so his rules apply.
  const worktree = withHome(devbox.home, () => {
    const { repo, worktree } = liveTask(project.root, { id: taskId, goal: 'Run the tests', state: 'running' });
    saveTask(repo, { ...readTask(repo, taskId), origin: { kind: 'mine', mine: true, machine: laptop.identity.key, name: 'ana', remoteId: started.id } });
    const [request] = pendingRequests(project.root); updateRequest(project.root, request.id, { state: 'running', taskId });
    const ask = (id, command) => requestApproval({ id, root: project.root, taskId, role: 'lead', vendor: 'claude', tool: 'Bash', input: { command }, cwd: worktree, access: 'read', rules: 'saved', sandboxed: true });
    ask('approval-a1', 'npm test'); ask('approval-a2', 'npm test -- --watch=false'); ask('approval-a3', 'git push origin main');
    hostTick(hostCtx);
    return worktree;
  });
  await withHome(laptop.home, () => viewTick(viewCtx));
  const pushed = toHost.sent.filter(([method]) => method === 'elu.remote.events').flatMap(([, params]) => params.items.flatMap(item => item.events));
  for (const event of pushed) withHome(laptop.home, () => viewer['elu.remote.events']({ items: [{ id: started.id, events: [event] }] }, toViewer));
  const seen = withHome(laptop.home, () => remoteSessions().find(row => row.id === started.id));
  // The laptop is told what a would keep, and is offered a only where a rule can be kept.
  assert.deepEqual(seen.approvals.map(item => [item.id, item.always ?? null]), [['approval-a1', 'Run npm test, with any arguments'], ['approval-a2', 'Run npm test, with any arguments'], ['approval-a3', null]]);
  const row = remoteRow(seen, 'devbox');
  assert.deepEqual(rowActions(row).map(([key]) => key), ['y', 'n', 'a', 'enter', 'd']);
  const glue = remoteGlue({ facade: { mineRows: () => [], remoteSessions: () => [] }, peerRead: () => null, peerCommand: command => withHome(laptop.home, () => remoteCommand(viewCtx, command)), chatMessage: ({ text }) => text, ink: text => text, colour: false });
  assert.match(glue.view(row, 80), /Esc, then y allow · n deny · a always/);
  assert.equal(await glue.action(row, 'always', 'project'), 'Allowed. From now on, without asking on @devbox: Run npm test, with any arguments (this project).');
  // Kept on the devbox, for its project; the laptop keeps nothing.
  withHome(devbox.home, () => {
    assert.deepEqual(listEntries().filter(entry => entry.kind === 'rule').map(entry => [entry.rule.words.join(' '), entry.rule.scope, entry.rule.project]), [['npm test', 'project', project.root]]);
    // What else waits that the rule covers is allowed too; the never list still waits.
    assert.deepEqual(pendingApprovals({ taskId }).map(item => item.id), ['approval-a3']);
  });
  withHome(laptop.home, () => assert.deepEqual(listEntries().filter(entry => entry.kind === 'rule'), []));
  // Never for the never list, whatever the laptop sends; deny with a rule is refused.
  await assert.rejects(withHome(devbox.home, async () => host['elu.remote.answer']({ id: started.id, approval: 'approval-a3', decision: 'allow', always: 'all' }, toHost)), /never list/);
  assert.throws(() => withHome(devbox.home, () => host['elu.remote.answer']({ id: started.id, approval: 'approval-a3', decision: 'deny', always: 'all' }, toHost)), { message: 'Keep the rule for this project or all your projects.' });
  withHome(devbox.home, () => assert.deepEqual(pendingApprovals({ taskId }).map(item => item.id), ['approval-a3'], 'still waits for y or n'));
  assert.ok(worktree);
});

test('an older build is told to update, never asked a question instead', async t => {
  const { laptop, devbox } = machines(t);
  await withHome(laptop.home, async () => {
    markMine(laptop.identity.key, devbox.identity.key); noteTheirs(devbox.identity.key, true);
    const old = connection(devbox.identity.key, { remote: 0 }), ctx = context(laptop.identity, { [devbox.identity.key]: old });
    await assert.rejects(remoteCommand(ctx, { type: 'remoteStart', to: devbox.identity.key, text: 'hello', permissions: 'ask' }), { message: UPDATE('@' + devbox.identity.key.slice(0, 4)) });
    assert.deepEqual(old.sent, [], 'nothing was sent to it');
    // A build that says remote: 1 but has no such method answers Method not found: the same line.
    const missing = connection(devbox.identity.key); missing.request = async () => { const error = new Error('Method not found'); error.details = { rpc: { code: -32601 } }; throw error; };
    await assert.rejects(remoteCommand(context(laptop.identity, { [devbox.identity.key]: missing }), { type: 'remoteStart', to: devbox.identity.key, text: 'hello', permissions: 'ask' }), { message: UPDATE('@' + devbox.identity.key.slice(0, 4)) });
    assert.deepEqual(remoteSessions(), [], 'no row is left for a session that never started');
    // On connect, an older build is not told about marks.
    remoteConnected(ctx, old); assert.deepEqual(old.sent, []);
    // Marked on one side only: waits for the other.
    noteTheirs(devbox.identity.key, false);
    await assert.rejects(remoteCommand(context(laptop.identity, { [devbox.identity.key]: connection(devbox.identity.key) }), { type: 'remoteStart', to: devbox.identity.key, text: 'hello', permissions: 'ask' }), /Waiting for @.{4} to mark this machine too\. On it, run \/mine @ana\./);
    // What to type there is this machine's box name when it has one: the name that computer shows it under.
    await assert.rejects(remoteCommand({ ...context(laptop.identity, { [devbox.identity.key]: connection(devbox.identity.key) }), boxName: () => 'laptop' }, { type: 'remoteStart', to: devbox.identity.key, text: 'hello', permissions: 'ask' }), /Waiting for @.{4} to mark this machine too\. On it, run \/mine @laptop\./);
  });
});

test('mine and unmine tell the other machine, and connecting says each side\'s half', async t => {
  const { laptop, devbox } = machines(t);
  await withHome(laptop.home, async () => {
    const other = connection(devbox.identity.key), ctx = context(laptop.identity, { [devbox.identity.key]: other });
    assert.deepEqual(await remoteCommand(ctx, { type: 'mine', key: devbox.identity.key }), { key: devbox.identity.key, both: false, older: false });
    assert.deepEqual(other.sent.at(-1), ['elu.mine', { mine: true }]);
    viewMethods(ctx)['elu.mine']({ mine: true }, other);
    assert.equal(bothMine(laptop.identity.key, devbox.identity.key), true);
    remoteConnected(ctx, other); assert.deepEqual(other.sent.at(-1), ['elu.mine', { mine: true }]);
    await remoteCommand(ctx, { type: 'unmine', key: devbox.identity.key });
    assert.deepEqual(other.sent.at(-1), ['elu.mine', { mine: false }]);
    assert.equal(bothMine(laptop.identity.key, devbox.identity.key), false);
  });
});

test('Sessions lists a session on my other computer, says where, and offers its keys', () => {
  const now = Date.parse('2026-11-11T10:00:00Z'), view = { id: START.id, machine: 'a'.repeat(64), createdAt: '2026-11-11T09:59:00Z', lastAt: '2026-11-11T09:59:30Z', state: 'running', title: 'Make coupons upper case', approvals: [], steps: [{ text: 'Reading src/coupon.mjs' }] };
  const running = remoteRow(view, 'devbox', now);
  assert.equal(running.group, 1); assert.equal(rowTitle(running, now), 'on devbox · Make coupons upper case');
  assert.deepEqual(rowActions(running), [['enter', 'open'], ['s', 'stop'], ['d', 'changes']]);
  const asking = remoteRow({ ...view, approvals: [{ id: 'approval-1', role: 'bot:reviewer', summary: 'Run ls', at: '2026-11-11T09:59:40Z' }] }, 'devbox', now);
  assert.equal(asking.group, 0); assert.equal(rowTitle(asking, now), 'on devbox · @reviewer wants to run ls');
  assert.deepEqual(rowActions(asking).slice(0, 2), [['y', 'allow'], ['n', 'deny']]);
  const task = remoteRow({ ...view, state: 'answered', plan: { title: 'Uppercase coupons', state: 'proposed' } }, 'devbox', now);
  assert.equal(task.label, 'TASK'); assert.deepEqual(rowActions(task).slice(0, 2), [['y', 'approve'], ['n', 'reject']]);
  const rows = boardRows([], now, { remote: [running, asking] });
  assert.deepEqual(rows.map(row => row.kind), ['remote', 'remote']);
  assert.equal(rows[0].key, `remote:${'a'.repeat(64)}\0remote\0${START.id}`);
  // A finished one stays as long as finished sessions here do.
  assert.deepEqual(boardRows([], now + 8 * 86400000, { remote: [remoteRow({ ...view, state: 'answered' }, 'devbox', now + 8 * 86400000)] }), []);
});

test('the new session box starts a session on my computer by its @name, and a message continues one', async t => {
  const status = { key: 'k'.repeat(64), name: 'ana', box: 'laptop', teams: [{ members: [{ key: 'k'.repeat(64), name: 'ana' }, { key: 'd'.repeat(64), name: 'ana', box: 'devbox', online: true }, { key: 'e'.repeat(64), name: 'kim', box: 'kims-mac', online: true }] }] };
  const commands = [], facade = { mineRows: () => [{ key: 'd'.repeat(64), mine: true, theirs: true }], remoteSessions: () => [] };
  const glue = remoteGlue({ facade, peerRead: () => status, peerCommand: async command => { commands.push(command); return command.type === 'remoteStart' ? { id: START.id, project: 'shop' } : command.type === 'mine' ? { both: false, older: false } : { answered: true }; }, chatMessage: ({ text }) => text, ink: text => text, colour: false });
  assert.equal(glue.named('@devbox').key, 'd'.repeat(64));
  assert.equal(glue.named('@DevBox').key, 'd'.repeat(64), 'any case');
  assert.equal(glue.named('@kim'), null, 'a teammate who is not mine is asked a question as before');
  assert.equal(glue.named('@kims-mac'), null);
  // What the app calls it wherever a peer is named: one name, the one Sessions shows, and your computer. A teammate has no such words.
  assert.deepEqual([...glue.yours().values()], [{ key: 'd'.repeat(64), name: 'devbox', waiting: false }]);
  assert.deepEqual([glue.own('d'.repeat(64)), glue.own('e'.repeat(64))], [true, false]);
  assert.deepEqual([glue.words('d'.repeat(64)), glue.words('e'.repeat(64))], ['your computer', '']);
  // One that has not marked this machine back yet is not mine yet, and its words say so.
  const waits = remoteGlue({ facade: { mineRows: () => [{ key: 'd'.repeat(64), mine: true, theirs: false }, { key: 'e'.repeat(64), mine: false, theirs: true }], remoteSessions: () => [] }, peerRead: () => status, peerCommand: async () => ({}), chatMessage: ({ text }) => text, ink: text => text, colour: false });
  assert.deepEqual([...waits.yours().values()], [{ key: 'd'.repeat(64), name: 'devbox', waiting: true }], 'one that only marks this machine is no computer of mine');
  assert.deepEqual([waits.words('d'.repeat(64)), waits.words('d'.repeat(64), ', '), waits.words('e'.repeat(64))], ['your computer · waiting for it to confirm', 'your computer, waiting for it to confirm', '']);
  const started = await glue.start(glue.named('@devbox'), 'Make coupons upper case', { permissions: 'auto', place: { kind: 'worktree' }, model: { vendor: 'claude', model: 'opus' }, bots: ['reviewer'] });
  assert.deepEqual(commands.at(-1), { type: 'remoteStart', to: 'd'.repeat(64), text: 'Make coupons upper case', permissions: 'auto', place: { kind: 'worktree' }, model: { vendor: 'claude', model: 'opus' }, bots: ['reviewer'] });
  assert.equal(started.line, 'Started on @devbox in shop. It shows here as it works.');
  assert.equal(started.key, `remote:${'d'.repeat(64)}\0remote\0${START.id}`);
  const row = remoteRow({ id: START.id, machine: 'd'.repeat(64), createdAt: new Date().toISOString(), state: 'running', title: 'x', approvals: [{ id: 'approval-1', summary: 'Run ls', at: new Date().toISOString() }] }, 'devbox');
  assert.equal(await glue.send(row, 'And the tests'), 'Sent to the session on @devbox.');
  assert.deepEqual(commands.at(-1), { type: 'remoteSend', id: START.id, text: 'And the tests' });
  assert.equal(await glue.action(row, 'accept'), 'Allowed.');
  assert.deepEqual(commands.at(-1), { type: 'remoteAnswer', id: START.id, approval: 'approval-1', decision: 'allow' });
  assert.match(glue.view({ ...row, remote: { ...row.remote, entries: [{ role: 'You', text: 'Make coupons upper case' }, { role: '@reviewer · review 1', text: 'Looks right.', bot: 'reviewer' }] } }, 80), /Looks right\.[\s\S]*Waiting for your approval on @devbox/);
  // It says what to type on the other computer: this one's box name, which /mine there finds.
  assert.equal(await glue.mine(['@devbox']), 'Waiting for @devbox to mark this machine too. On @devbox, type /mine @laptop.');
  // After joining with a code made for that, yes marks the inviter here.
  assert.equal(await glue.agree('d'.repeat(64), 'ana'), 'Marked as yours. Type @devbox first in the new session box to start a session there.');
  assert.deepEqual(commands.at(-1), { type: 'mine', key: 'd'.repeat(64) });
  // Machines already on the team that are not both mine yet: the ones /invite offers to mark without a code.
  assert.deepEqual(glue.unmarked().map(row => row.name), ['kims-mac']);
  await assert.rejects(glue.mine(['@nobody']), { message: 'No computer on your team is called @nobody.' });
});

// ---- Every session on a computer of mine ----

// A chat session saved as the app saves one: by hand, or with the origin a teammate's message, a bot or my other computer gives it.
function chat(root, id, { goal = `Session ${id}`, state = 'answered', minutes = 0, ...extra } = {}) {
  const at = new Date(Date.now() - minutes * 60000).toISOString(), repo = repository(root);
  saveTask(repo, { id: String(id), kind: 'conversation', goal, state, worktree: root, base: null, branch: null, createdAt: at, runs: [], reviews: [], responses: [], messages: [], sessions: {}, result: null, activeRole: state === 'running' ? 'lead' : null, ...extra });
  return repo;
}
// Both machines mine, the devbox (host) with a project of the given origin; the two daemons joined by calls.
function pair(t, { origin = 'https://github.com/acme/shop.git' } = {}) {
  const { team, laptop, devbox } = machines(t);
  const project = withHome(devbox.home, () => { const project = registeredProject(t, { origin }); saveTeamAccess(team.teamId, { root: project.root }); markMine(devbox.identity.key, laptop.identity.key); noteTheirs(laptop.identity.key, true); return project; });
  withHome(laptop.home, () => { markMine(laptop.identity.key, devbox.identity.key); noteTheirs(devbox.identity.key, true); });
  const toHost = connection(laptop.identity.key), toViewer = connection(devbox.identity.key);
  const hostCtx = context(devbox.identity, { [laptop.identity.key]: toHost }), viewCtx = context(laptop.identity, { [devbox.identity.key]: toViewer });
  const host = hostMethods(hostCtx), viewer = viewMethods(viewCtx);
  toViewer.request = async (method, params) => withHome(devbox.home, () => host[method](params, toHost));
  return { team, laptop, devbox, project, toHost, toViewer, hostCtx, viewCtx, host, viewer };
}
const pause = ms => new Promise(done => setTimeout(done, ms));

test('a computer of mine lists every session here, whoever started it, a page at a time, and then only what changed', async t => {
  const { laptop, devbox, project, toHost, host } = pair(t), kim = 'e'.repeat(64);
  const other = withHome(devbox.home, () => {
    chat(project.root, 1, { goal: 'Typed here by hand', minutes: 6 });
    chat(project.root, 2, { goal: 'Nightly dependency check', minutes: 5 });
    // A schedule started session 2.
    fs.writeFileSync(path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'schedules.json'), JSON.stringify({ version: 1, schedules: [{ id: 'schedule-1', root: project.root, project: 'shop', goal: 'Nightly dependency check', when: { kind: 'once', at: new Date(Date.now() + 3600000).toISOString() }, enabled: true, lastTaskId: '2', runs: 1 }] }));
    chat(project.root, 3, { goal: 'Fix the login redirect', minutes: 4, origin: { kind: 'handoff', peer: kim, name: 'kim', threadId: null } });
    chat(project.root, 4, { goal: 'Which schema does the API use?', minutes: 3, origin: { kind: 'ask', peer: kim, name: 'kim', threadId: null } });
    chat(project.root, 5, { goal: 'Started from the laptop', minutes: 2, origin: { kind: 'mine', mine: true, machine: laptop.identity.key, name: 'ana', remoteId: START.id } });
    chat(project.root, 6, { goal: 'Notes for the week', minutes: 1, botChat: 'reviewer' });
    chat(project.root, 7, { goal: 'Run the tests', state: 'running' });
    // Finished a month ago: not listed. Waiting for an answer since then: listed.
    chat(project.root, 8, { goal: 'Last month', minutes: 60 * 24 * 30 });
    chat(project.root, 9, { goal: 'Asked last month', state: 'needs_input', minutes: 60 * 24 * 30 });
    requestApproval({ id: 'approval-7a', root: project.root, taskId: '7', role: 'lead', vendor: 'claude', tool: 'Bash', input: { command: 'npm test' } });
    // A second project here with no origin remote.
    const other = registeredProject(t); chat(other.root, 1, { goal: 'Tidy my notes' }); relist();
    return other;
  });
  const listed = withHome(devbox.home, () => host['elu.remote.list']({}, toHost));
  assert.equal(listed.full, true); assert.equal(listed.next, null);
  const by = Object.fromEntries(listed.sessions.map(row => [row.title, row.by]));
  assert.deepEqual(by, { 'Run the tests': 'you', 'Tidy my notes': 'you', 'Notes for the week': 'bot', 'Started from the laptop': 'mine', 'Fix the login redirect': 'teammate', 'Nightly dependency check': 'schedule', 'Typed here by hand': 'you', 'Asked last month': 'you' });
  assert.ok(!listed.sessions.some(row => row.title === 'Last month'), 'a session done with for more than a week is not listed');
  assert.ok(!listed.sessions.some(row => row.title === 'Which schema does the API use?'), "a teammate's question is answered in Chats there, not listed");
  const row = title => listed.sessions.find(item => item.title === title);
  assert.equal(row('Fix the login redirect').who, 'kim'); assert.equal(row('Notes for the week').who, 'reviewer');
  assert.equal(row('Started from the laptop').remoteId, START.id, 'the computer that started it learns which it is');
  assert.deepEqual(row('Run the tests').approvals.map(item => [item.id, item.summary]), [['approval-7a', 'Run: npm test']]);
  // The two projects: the one with an origin has its repository; the other has none.
  const shop = listed.projects.find(item => item.id === row('Run the tests').project), notes = listed.projects.find(item => item.id === row('Tidy my notes').project);
  assert.match(shop.repoId, /^[0-9a-f]{64}$/); assert.equal(notes.repoId, null);
  // Each session names the repository it works in: here the project's own, or none.
  assert.equal(row('Run the tests').repoId, shop.repoId); assert.equal(row('Tidy my notes').repoId, null);
  // standup: false only on a session a standup here would not ask (lib/standup.mjs).
  assert.deepEqual(Object.keys(listed.sessions[0]).filter(name => name !== 'standup').sort(), ['approvals', 'at', 'by', 'createdAt', 'error', 'plan', 'project', 'question', 'ref', 'repoId', 'state', 'title', 'who'].sort());
  assert.ok(listed.sessions.every(item => item.standup === undefined || item.standup === false));
  void other;
  // A page at a time.
  const first = withHome(devbox.home, () => host['elu.remote.list']({ limit: 3 }, toHost));
  assert.deepEqual(first.sessions.map(item => item.title), listed.sessions.slice(0, 3).map(item => item.title));
  const second = withHome(devbox.home, () => host['elu.remote.list']({ limit: 3, after: first.next }, toHost));
  assert.deepEqual(second.sessions.map(item => item.title), listed.sessions.slice(3, 6).map(item => item.title));
  // Since the cursor: only what changed, and what left.
  await pause(5);
  withHome(devbox.home, () => { chat(project.root, 1, { goal: 'Typed here by hand', minutes: 6, messages: [{ at: new Date().toISOString(), text: 'And the docs' }] }); fs.rmSync(path.join(repository(project.root).state, 'tasks', '6'), { recursive: true }); relist(); });
  const since = withHome(devbox.home, () => host['elu.remote.list']({ since: listed.cursor }, toHost));
  assert.equal(since.full, false);
  assert.deepEqual(since.sessions.map(item => item.title), ['Typed here by hand']);
  assert.deepEqual(since.gone, [row('Notes for the week').ref]);
  // A cursor from before this daemon started lists everything again.
  assert.equal(withHome(devbox.home, () => host['elu.remote.list']({ since: 1 }, toHost)).full, true);
});

// A message longer than one line on the link (1 MiB) goes ahead of its request in elu.text.put
// pieces, as a long message to a teammate does, and the request names it. Nothing is cut.
test('a message too long for one line on the link reaches a session on my other computer whole, in pieces: a new session and a message to it', async t => {
  const { laptop, devbox, project, toHost, toViewer, hostCtx, viewCtx, host } = pair(t);
  const put = textMethods(hostCtx, {})['elu.text.put'];
  toViewer.request = async (method, params) => { toViewer.sent.push([method, params]); return withHome(devbox.home, () => (method === 'elu.text.put' ? put : host[method])(params, toHost)); };
  const long = `Plan the coupons.\n${'Every line of this message matters. '.repeat(40000)}THE END`;
  assert.ok(Buffer.byteLength(JSON.stringify(long)) > FRAME_MAX, 'longer than one line on the link');
  const started = await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteStart', to: devbox.identity.key, text: long, permissions: 'ask', bots: [] }));
  const requests = () => withHome(devbox.home, () => pendingRequests(project.root));
  assert.equal(requests().length, 1);
  assert.ok(requests()[0].goal === long, 'every character of it starts the session');
  const lines = toViewer.sent.map(([method, params]) => [method, Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))]);
  assert.deepEqual(lines.map(([method]) => method), ['elu.text.put', 'elu.text.put', 'elu.text.put', 'elu.remote.start']);
  assert.ok(lines.every(([, size]) => size < FRAME_MAX), 'each request fits one line on the link');
  assert.equal('text' in toViewer.sent.at(-1)[1], false, 'the request names the text');
  // What was sent shows here whole until the session's own chat arrives, and nothing stays staged there.
  assert.ok(withHome(laptop.home, () => remoteSessions().find(row => row.id === started.id)).text === long);
  const staged = () => withHome(devbox.home, () => { const dir = path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'peer', 'texts', 'in', laptop.identity.key); return fs.existsSync(dir) ? fs.readdirSync(dir) : []; });
  assert.deepEqual(staged(), []);
  // A message to it, once the conductor started it.
  const first = requests()[0].id;
  withHome(devbox.home, () => { liveTask(project.root, { id: '1', goal: 'Plan the coupons.' }); updateRequest(project.root, first, { state: 'running', taskId: '1' }); });
  const more = `And this too.\n${'Line. '.repeat(200000)}DONE`;
  assert.ok(Buffer.byteLength(JSON.stringify(more)) > FRAME_MAX);
  await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteSend', id: started.id, text: more }));
  assert.ok(requests().find(row => row.continuationTaskId === '1').goal === more, 'every character of it continues the session');
  assert.deepEqual(staged(), []);
  // A short message still travels in its request.
  toViewer.sent.length = 0;
  await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteSend', id: started.id, text: 'And the tests' }));
  assert.deepEqual(toViewer.sent.map(([method, params]) => [method, params.text]), [['elu.remote.send', 'And the tests']]);
  // A computer on a build before long messages is said to need an update: nothing is cut to fit, and no session starts.
  const before = requests().length;
  toViewer.request = async method => { if (method === 'elu.text.put') throw Object.assign(new Error('Method not found'), { details: { rpc: { code: -32601 } } }); throw new Error('Nothing else is asked.'); };
  const update = { message: `@${devbox.identity.key.slice(0, 4)} needs to update ELU to get a message this long.` };
  await assert.rejects(withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteStart', to: devbox.identity.key, text: long, permissions: 'ask', bots: [] })), update);
  await assert.rejects(withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteSend', id: started.id, text: more })), update);
  assert.equal(requests().length, before);
  assert.equal(withHome(laptop.home, () => remoteSessions().length), 1, 'a refused start leaves no row here');
});

test('the pieces of a long message are taken from a computer of mine whatever its teammate setting, one sent again is taken once, and a message whose text is not there is asked for again', async t => {
  const { laptop, devbox, project, toHost, hostCtx, host } = pair(t), put = textMethods(hostCtx, {})['elu.text.put'];
  const bytes = Buffer.from(`Start here.\n${'x'.repeat(PIECE * 2)}`), id = crypto.randomUUID(), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const piece = seq => ({ id, seq, last: seq === 2, size: bytes.length, sha256, data: bytes.subarray(seq * PIECE, (seq + 1) * PIECE).toString('base64') });
  const longText = { id, size: bytes.length, sha256 }, start = { ...START, id: crypto.randomUUID(), text: undefined, longText };
  await withHome(devbox.home, async () => {
    // Named before its pieces are here: said as a rate limit, which the sender takes as "send it again".
    await assert.rejects(async () => host['elu.remote.start'](start, toHost), error => error.details?.rpc?.code === -32000 && /has not arrived/.test(error.message));
    assert.equal(pendingRequests(project.root).length, 0);
    // Muted as a teammate, it is still my own computer.
    savePeerPolicy(laptop.identity.key, { muted: true });
    for (const seq of [0, 1, 1, 2, 2]) assert.deepEqual(put(piece(seq), toHost), { ok: true });
    const result = await host['elu.remote.start'](start, toHost);
    assert.ok(pendingRequests(project.root)[0].goal === bytes.toString('utf8'));
    // Asked again after its answer was lost: the same session, though the text is gone from the staging folder.
    assert.deepEqual(await host['elu.remote.start'](start, toHost), result);
    assert.equal(pendingRequests(project.root).length, 1);
    // A computer that is not mine on both sides and is muted is refused as a muted teammate is,
    // and since this computer still marks it as mine the refusal says computer, never teammate.
    noteTheirs(laptop.identity.key, false);
    assert.throws(() => put({ ...piece(0), id: crypto.randomUUID() }, toHost), { message: 'This computer is not taking requests from you.' });
  });
});

test('the model and effort of each entry travel with it to my other computer, checked there; an entry without them reads as before', async t => {
  const { laptop, devbox, project, toHost, hostCtx, viewCtx, viewer } = pair(t), at = () => new Date().toISOString();
  withHome(devbox.home, () => { chat(project.root, 1, { goal: 'Plan the coupons', state: 'answered', messages: [{ at: at(), text: 'Plan the coupons', to: '@lead' }, { at: at(), from: '@lead', bot: 'lead', text: 'Planned.', model: 'claude-fable-5-2', effort: 'medium' }, { at: at(), from: '@reviewer', bot: 'reviewer', text: 'Looks right.' }] }); relist(); });
  await withHome(laptop.home, () => listTick(viewCtx));
  const item = withHome(laptop.home, () => remoteMachines())[0].sessions[0];
  await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteWatch', to: devbox.identity.key, ref: item.ref }));
  withHome(devbox.home, () => hostTick(hostCtx));
  const pushed = toHost.sent.filter(([method]) => method === 'elu.remote.events').at(-1)[1];
  const sent = pushed.items.flatMap(row => row.events).filter(event => event.type === 'entry');
  assert.deepEqual(sent.filter(event => event.bot).map(event => [event.bot, event.model ?? null, event.effort ?? null]), [['lead', 'claude-fable-5-2', 'medium'], ['reviewer', null, null]]);
  // What arrives is checked: a model or an effort that does not read as one is left out.
  const forged = structuredClone(pushed); forged.items[0].events.find(event => event.bot === 'reviewer').model = 'opus 5.5\u001b[2J'; forged.items[0].events.find(event => event.bot === 'reviewer').effort = 'MAX!';
  withHome(laptop.home, () => viewer['elu.remote.events'](forged, connection(devbox.identity.key)));
  await withHome(laptop.home, () => viewTick(viewCtx));
  const seen = withHome(laptop.home, () => remoteSessions().find(row => row.id === item.id));
  assert.deepEqual(seen.entries.filter(entry => entry.bot).map(entry => [entry.role, entry.model ?? null, entry.effort ?? null]), [['@lead', 'claude-fable-5-2', 'medium'], ['@reviewer', null, null]]);
  // Watched again, the host sends nothing new for entries it already sent: the model is not part of an entry's key.
  withHome(devbox.home, () => { const repo = repository(project.root), task = readTask(repo, '1'); delete task.messages[1].model; saveTask(repo, task); hostTick(hostCtx, Date.now() + 1); });
  const again = toHost.sent.filter(([method]) => method === 'elu.remote.events').slice(1).flatMap(([, params]) => params.items.flatMap(row => row.events)).filter(event => event.type === 'entry');
  assert.deepEqual(again, []);
});

// Nothing of a session on my other computer is cut on its way here: an entry or a diff longer
// than one event carries goes in several, in order, and what one notification does not hold is
// asked for (elu.remote.since), each line on the link under its limit.
test('a chat entry, a review and a diff of any length reach the computer that follows the session whole', async t => {
  const { laptop, devbox, project, toHost, toViewer, hostCtx, viewCtx, viewer, host } = pair(t), at = n => new Date(Date.now() - 60000 + n * 1000).toISOString();
  const answer = `Here is the whole plan.\n${'Every step of the plan, in full. '.repeat(40000)}THE END \u{1F600}`;
  const generated = `${'export const line = "a long generated line";\n'.repeat(30000)}// LAST LINE\n`;
  withHome(devbox.home, () => {
    const { repo, worktree } = liveTask(project.root, { id: '1', goal: 'Plan the coupons', files: { 'src/generated.mjs': generated } });
    assert.equal(spawnSync('git', ['-C', worktree, 'add', 'src/generated.mjs']).status, 0);
    const task = readTask(repo, '1');
    task.messages = [{ at: at(0), text: 'Plan the coupons', to: '@lead' }, { at: at(1), from: '@lead', bot: 'lead', text: answer }];
    task.reviews = [{ role: 'bot:reviewer', round: 1, at: at(2), result: { summary: 'Thirty things to fix.', comments: Array.from({ length: 30 }, (_, n) => ({ id: `c${n + 1}`, severity: 'must_fix', body: `Comment ${n + 1}: ${'x'.repeat(1000)}` })) } }];
    saveTask(repo, task); relist();
  });
  const lines = [];
  toViewer.request = async (method, params) => { const result = await withHome(devbox.home, () => host[method](params, toHost)); lines.push(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))); return result; };
  await withHome(laptop.home, () => listTick(viewCtx));
  const item = withHome(laptop.home, () => remoteMachines())[0].sessions[0];
  await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteWatch', to: devbox.identity.key, ref: item.ref }));
  withHome(devbox.home, () => hostTick(hostCtx));
  const pushed = toHost.sent.filter(([method]) => method === 'elu.remote.events');
  for (const [method, params] of pushed) { lines.push(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', method, params }))); withHome(laptop.home, () => viewer[method](params, connection(devbox.identity.key))); }
  const seen = () => withHome(laptop.home, () => remoteSessions().find(row => row.id === item.id));
  // The rest is asked for, a few requests at a time, until nothing is missing.
  for (let n = 0, now = Date.now(); n < 60 && seen().behind; n++) await withHome(laptop.home, () => viewTick(viewCtx, now += 2000));
  const view = seen();
  assert.equal(view.behind, false);
  assert.ok(lines.length > 4 && lines.every(size => size < FRAME_MAX), 'each line on the link is under its limit');
  const lead = view.entries.find(entry => entry.bot === 'lead'), review = view.entries.find(entry => entry.bot === 'reviewer');
  assert.ok(lead.text === answer, 'every character of the answer');
  assert.match(review.text, /^Thirty things to fix\.\nmust_fix: Comment 1: x+\n/); assert.match(review.text, /\nmust_fix: Comment 30: x{1000}$/);
  assert.ok(view.diff.patch.length > generated.length && view.diff.patch.includes('+// LAST LINE'), 'every line of the diff');
  assert.equal(view.diff.patch.includes('The rest of the diff is on the other computer'), false);
  assert.match(view.diff.summary, /^1 file · \+30001 −0$/);
  // Looked at again, the host sends none of it twice.
  const before = toHost.sent.length;
  withHome(devbox.home, () => hostTick(hostCtx, Date.now() + 1));
  assert.deepEqual(toHost.sent.slice(before).flatMap(([, params]) => params.items.flatMap(row => row.events)).filter(event => /^(entry|diff)/.test(event.type)), []);
});

// A session that moved to a newer main and committed on branches of its own: its folder against
// the commit it started from counts what other people landed too. What its computer sends is
// what the session itself changed, branch by branch.
test('a session on my other computer that moved to a newer main and made branches there sends only what it changed itself, and the computer that follows it counts the same', async t => {
  const { laptop, devbox, project, toHost, toViewer, hostCtx, viewCtx, viewer, host } = pair(t);
  const run = (root, ...args) => { const done = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); assert.equal(done.status, 0, done.stderr); return done.stdout.trim(); };
  const worktree = withHome(devbox.home, () => {
    const made = liveTask(project.root, { id: '1', goal: 'Fix the totals', files: {} });
    // Other people land forty files on main. The session moves to it and commits on a branch of its own, twice.
    for (let at = 0; at < 40; at++) fs.writeFileSync(path.join(project.root, `landed-${at}.txt`), `landed ${at}\n`.repeat(20));
    run(project.root, 'add', '-A'); run(project.root, 'commit', '-q', '-m', 'Land forty files');
    for (const [branch, file, text] of [['fix/one', 'src/one.mjs', 'export const one = 1;\n'], ['fix/two', 'src/two.mjs', 'export const two = 2;\nexport const more = 3;\n']]) {
      run(made.worktree, 'checkout', '-q', '-b', branch, 'main'); fs.writeFileSync(path.join(made.worktree, file), text); run(made.worktree, 'add', '-A'); run(made.worktree, 'commit', '-q', '-m', `Add ${file}`);
    }
    fs.writeFileSync(path.join(made.worktree, 'notes.md'), 'not committed\n');
    // The session's folder against the commit it started from counts all forty.
    assert.equal(run(made.worktree, 'diff', '--name-only', made.base, '--').split('\n').length, 41);
    relist(); return made.worktree;
  });
  toViewer.request = (method, params) => withHome(devbox.home, () => host[method](params, toHost));
  await withHome(laptop.home, () => listTick(viewCtx));
  const item = withHome(laptop.home, () => remoteMachines())[0].sessions[0];
  await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteWatch', to: devbox.identity.key, ref: item.ref }));
  const seen = () => withHome(laptop.home, () => remoteSessions().find(row => row.id === item.id));
  const follow = async now => {
    const before = toHost.sent.length; withHome(devbox.home, () => hostTick(hostCtx, now));
    for (const [method, params] of toHost.sent.slice(before).filter(([name]) => name === 'elu.remote.events')) withHome(laptop.home, () => viewer[method](params, connection(devbox.identity.key)));
    for (let n = 0; n < 60 && seen().behind; n++) await withHome(laptop.home, () => viewTick(viewCtx, now += 2000));
    return seen().diff;
  };
  const diff = await follow(Date.now());
  assert.equal(diff.summary, '3 files · +4 −0');
  assert.doesNotMatch(diff.patch, /landed-/);
  const changes = sessionChanges(diff.patch), BRANCHED = 'main as it was when this session branched';
  assert.deepEqual(changes.parts.map(part => [part.branch, part.current, part.files, part.added, part.removed, part.compared]), [['fix/two', true, 2, 3, 0, BRANCHED], ['fix/one', false, 1, 1, 0, BRANCHED]]);
  assert.deepEqual(changes.files.map(file => [file.branch, file.path, file.status]), [['fix/two', 'src/two.mjs', 'added'], ['fix/two', 'notes.md', 'added'], ['fix/one', 'src/one.mjs', 'added']]);
  assert.deepEqual([changes.files.length, changes.added, changes.removed, changes.note], [3, 4, 0, null]);
  // What its teammates' boards are told it changed is the same three files.
  assert.deepEqual(withHome(devbox.home, () => sessionFiles(readTask(repository(project.root), '1'))), ['notes.md', 'src/one.mjs', 'src/two.mjs']);
  // It stops with one more commit: the next look sends the new count.
  withHome(devbox.home, () => { run(worktree, 'add', '-A'); run(worktree, 'commit', '-q', '-m', 'Add the notes'); const repo = repository(project.root); saveTask(repo, { ...readTask(repo, '1'), state: 'blocked' }); });
  const later = await follow(Date.now() + 60000);
  assert.equal(later.summary, '3 files · +4 −0');
  assert.deepEqual(sessionChanges(later.patch).parts.map(part => [part.branch, part.commits, part.files]), [['fix/two', 2, 2], ['fix/one', 1, 1]]);
});

test('a new file of any size in a session on my other computer reaches the computer that follows it whole, and a binary one is only named', async t => {
  const { laptop, devbox, project, toHost, toViewer, hostCtx, viewCtx, viewer, host } = pair(t);
  // 6,000 lines, about 170,000 bytes: well past the 64,000 a preview held.
  const notes = `${Array.from({ length: 6000 }, (_, n) => `Note ${n + 1} of the new file.`).join('\n')}\n`;
  withHome(devbox.home, () => { liveTask(project.root, { id: '1', goal: 'Write the notes', files: { 'docs/notes.md': notes, 'art/logo.bin': Buffer.concat([Buffer.from([137, 0, 1, 2]), Buffer.alloc(300000, 65)]) } }); relist(); });
  toViewer.request = (method, params) => withHome(devbox.home, () => host[method](params, toHost));
  await withHome(laptop.home, () => listTick(viewCtx));
  const item = withHome(laptop.home, () => remoteMachines())[0].sessions[0];
  await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteWatch', to: devbox.identity.key, ref: item.ref }));
  withHome(devbox.home, () => hostTick(hostCtx));
  for (const [method, params] of toHost.sent.filter(([name]) => name === 'elu.remote.events')) withHome(laptop.home, () => viewer[method](params, connection(devbox.identity.key)));
  const seen = () => withHome(laptop.home, () => remoteSessions().find(row => row.id === item.id));
  for (let n = 0, now = Date.now(); n < 60 && seen().behind; n++) await withHome(laptop.home, () => viewTick(viewCtx, now += 2000));
  const patch = seen().diff.patch;
  assert.equal(patch.includes('[File preview truncated.]'), false);
  assert.ok(patch.includes(`New file: docs/notes.md\n${notes}`), 'every line of the new file');
  assert.ok(patch.includes('New file: art/logo.bin\n(binary content)') && patch.length < notes.length + 1000, 'the binary file is named, not sent');
  // The Changes tab reads it as two new files, the text one whole from its line 1.
  const changes = sessionChanges(patch), text = changes.files.find(file => file.path === 'docs/notes.md');
  assert.deepEqual([changes.files.length, changes.added, changes.cut, text.added, text.note ?? null], [2, 6000, false, 6000, null]);
  assert.deepEqual([text.hunks[0].lines[0], text.hunks[0].lines.at(-1)].map(line => [line.now, line.text]), [[1, 'Note 1 of the new file.'], [6000, 'Note 6000 of the new file.']]);
  assert.equal(changes.files.find(file => file.path === 'art/logo.bin').binary, true);
});

test('a long session keeps its newest 4000 events there, and a computer that was away longer goes on from the oldest kept', async t => {
  const { laptop, devbox, project, toHost, hostCtx, viewCtx, viewer } = pair(t), at = () => new Date().toISOString();
  withHome(devbox.home, () => { chat(project.root, 1, { goal: 'Plan the coupons', messages: [{ at: at(), text: 'Plan the coupons', to: '@lead' }] }); relist(); });
  await withHome(laptop.home, () => listTick(viewCtx));
  const item = withHome(laptop.home, () => remoteMachines())[0].sessions[0];
  await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteWatch', to: devbox.identity.key, ref: item.ref }));
  withHome(devbox.home, () => {
    hostTick(hostCtx);
    const folder = path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'peer', 'remote', 'host'), file = path.join(folder, `${item.id}.json`), log = path.join(folder, `${item.id}.jsonl`);
    const row = JSON.parse(fs.readFileSync(file, 'utf8')), lines = [];
    // 6100 events, among them an answer in two events of which only the second will be kept.
    for (let seq = row.seq + 1; seq <= 6100; seq++) lines.push(JSON.stringify(seq === 2101 ? { seq, at: at(), type: 'entry', role: '@lead', bot: 'lead', text: 'Half of an answer', more: true } : seq === 2102 ? { seq, at: at(), type: 'entry+', text: ' and its orphaned rest' } : { seq, at: at(), type: 'step', text: `step ${seq}` }));
    fs.appendFileSync(log, `${lines.join('\n')}\n`); fs.writeFileSync(file, JSON.stringify({ ...row, seq: 6100 }));
    const repo = repository(project.root), task = readTask(repo, '1'); task.messages.push({ at: at(), from: '@lead', bot: 'lead', text: 'Planned.' }); saveTask(repo, task);
    hostTick(hostCtx, Date.now() + 1);
    const kept = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).seq);
    assert.equal(kept.length, 4000); assert.deepEqual([kept[0], kept.at(-1)], [2102, 6101]);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).first, 2102);
    assert.deepEqual(fs.readdirSync(folder).filter(name => name.endsWith('.tmp')), []);
  });
  for (const [method, params] of toHost.sent.filter(([method]) => method === 'elu.remote.events')) withHome(laptop.home, () => viewer[method](params, connection(devbox.identity.key)));
  const seen = () => withHome(laptop.home, () => remoteSessions().find(row => row.id === item.id));
  assert.equal(seen().behind, true);
  for (let n = 0, now = Date.now(); n < 20 && seen().behind; n++) await withHome(laptop.home, () => viewTick(viewCtx, now += 2000));
  assert.equal(seen().behind, false); assert.equal(seen().seq, 6101);
  assert.deepEqual(seen().entries.map(entry => entry.text), ['Plan the coupons', 'Planned.'], 'the rest of an answer whose start is gone is not shown as one');
  assert.equal(seen().steps.at(-1).text, 'step 6100');
});

test('a session started there by hand is watched from here: live, continued, stopped and answered as one started from here', async t => {
  const { laptop, devbox, project, toHost, hostCtx, viewCtx, viewer } = pair(t);
  withHome(devbox.home, () => { chat(project.root, 1, { goal: 'Make coupons upper case', state: 'answered', messages: [{ at: new Date().toISOString(), text: 'Make coupons upper case' }, { at: new Date().toISOString(), from: 'Lead', text: 'Done: codes are upper case now.' }] }); relist(); });
  // The laptop lists what is there.
  await withHome(laptop.home, () => listTick(viewCtx));
  const [listedHere] = withHome(laptop.home, () => remoteMachines());
  assert.equal(listedHere.key, devbox.identity.key); assert.equal(listedHere.older, false);
  const item = listedHere.sessions[0];
  assert.equal(item.title, 'Make coupons upper case'); assert.equal(item.by, 'you');
  assert.equal(item.id, watchId(laptop.identity.key, devbox.identity.key, item.ref), 'the id both sides give it');
  // Opened here: watched there, then caught up here.
  assert.deepEqual(await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteWatch', to: devbox.identity.key, ref: item.ref })), { id: item.id });
  withHome(devbox.home, () => hostTick(hostCtx));
  const pushed = toHost.sent.filter(([method]) => method === 'elu.remote.events').at(-1)[1];
  withHome(laptop.home, () => viewer['elu.remote.events'](pushed, connection(devbox.identity.key)));
  await withHome(laptop.home, () => viewTick(viewCtx));
  const seen = () => withHome(laptop.home, () => remoteSessions().find(row => row.id === item.id));
  assert.equal(seen().ref, item.ref); assert.equal(seen().state, 'answered');
  assert.deepEqual(seen().entries.map(entry => entry.text), ['Make coupons upper case', 'Done: codes are upper case now.']);
  // A reply from here continues it there, as typed there.
  await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteSend', id: item.id, to: devbox.identity.key, ref: item.ref, text: 'And the tests' }));
  const [request] = withHome(devbox.home, () => pendingRequests(project.root));
  assert.equal(request.goal, 'And the tests'); assert.equal(request.continuationTaskId, '1'); assert.equal(request.origin, undefined);
  // It works there and asks for an approval: the laptop answers it, and the first answer wins.
  withHome(devbox.home, () => { chat(project.root, 1, { goal: 'Make coupons upper case', state: 'running' }); requestApproval({ id: 'approval-3', root: project.root, taskId: '1', role: 'lead', vendor: 'claude', tool: 'Bash', input: { command: 'npm test' } }); hostTick(hostCtx, Date.now() + 1); });
  withHome(laptop.home, () => viewer['elu.remote.events'](toHost.sent.filter(([method]) => method === 'elu.remote.events').at(-1)[1], connection(devbox.identity.key)));
  assert.deepEqual(seen().approvals.map(entry => entry.summary), ['Run: npm test']);
  assert.deepEqual(await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteAnswer', id: item.id, approval: 'approval-3', decision: 'allow' })), { answered: true });
  withHome(devbox.home, () => assert.deepEqual(pendingApprovals({ taskId: '1' }), []));
  assert.deepEqual(seen().approvals, [], 'gone from Needs you here at once');
  // Stop reaches it there.
  assert.deepEqual(await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteStop', id: item.id })), { stopping: true });
  // Another key cannot read or act on the watch the laptop made, and gets no listing either.
  const kim = connection('e'.repeat(64));
  for (const method of ['elu.remote.since', 'elu.remote.send', 'elu.remote.answer', 'elu.remote.list', 'elu.remote.watch']) assert.throws(() => withHome(devbox.home, () => hostMethods(hostCtx)[method]({ id: item.id, ref: item.ref, text: 'x', approval: 'x', decision: 'allow' }, kim)), { message: NOT_MINE }, method);
  assert.deepEqual(kim.sent, []);
});

test("a teammate's session there is watched and answered from here by its place, with no watch first", async t => {
  const { laptop, devbox, project, hostCtx, viewCtx } = pair(t);
  withHome(devbox.home, () => { chat(project.root, 2, { goal: 'Fix the login redirect', state: 'running', origin: { kind: 'handoff', peer: 'e'.repeat(64), name: 'kim', threadId: null } }); requestApproval({ id: 'approval-4', root: project.root, taskId: '2', role: 'lead', vendor: 'claude', tool: 'Bash', input: { command: 'git status' } }); relist(); });
  await withHome(laptop.home, () => listTick(viewCtx));
  const item = withHome(laptop.home, () => remoteMachines()[0].sessions.find(row => row.title === 'Fix the login redirect'));
  assert.equal(item.by, 'teammate'); assert.equal(item.who, 'kim'); assert.deepEqual(item.approvals.map(row => row.id), ['approval-4']);
  // y on its row under Needs you: watched there first, then answered.
  assert.deepEqual(await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteAnswer', id: item.id, to: devbox.identity.key, ref: item.ref, approval: 'approval-4', decision: 'deny' })), { answered: true });
  withHome(devbox.home, () => { assert.deepEqual(pendingApprovals({ taskId: '2' }), []); hostTick(hostCtx); });
  assert.ok(withHome(laptop.home, () => remoteSessions().some(row => row.id === item.id && row.ref === item.ref)), 'it is followed here now');
  // A place that is not a session there is refused plainly.
  await assert.rejects(withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteWatch', to: devbox.identity.key, ref: `${item.project}:99` })), /That session is not on this computer\./);
});

test('a watch its computer let go is made again: a reply still reaches the session, and a listing it never sent catches the view up', async t => {
  const { laptop, devbox, project, hostCtx, viewCtx } = pair(t);
  withHome(devbox.home, () => { chat(project.root, 1, { goal: 'Make coupons upper case', messages: [{ at: new Date().toISOString(), text: 'Make coupons upper case' }] }); relist(); });
  await withHome(laptop.home, () => listTick(viewCtx));
  const item = withHome(laptop.home, () => remoteMachines()[0].sessions[0]);
  await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteWatch', to: devbox.identity.key, ref: item.ref }));
  withHome(devbox.home, () => hostTick(hostCtx));
  await withHome(laptop.home, () => viewTick(viewCtx));
  // A week with nothing new: the devbox lets the watch go.
  withHome(devbox.home, () => hostTick(hostCtx, Date.now() + 8 * 86400000));
  assert.throws(() => withHome(devbox.home, () => hostMethods(hostCtx)['elu.remote.since']({ id: item.id, after: 0 }, connection(laptop.identity.key))), /That session is not on this computer\./);
  // A reply from here watches it again and goes through.
  assert.deepEqual(await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteSend', id: item.id, text: 'And the tests' })), { id: item.id });
  assert.equal(withHome(devbox.home, () => pendingRequests(project.root)).at(-1).goal, 'And the tests');
  // A view whose listing shows a change it never sent is kept, and catches up.
  withHome(laptop.home, () => {
    const file = path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'peer', 'remote', 'view', `${item.id}.json`), hour = new Date(Date.now() - 3600000).toISOString();
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), behind: false, lastAt: hour, watchedAt: hour }));
  });
  withHome(devbox.home, () => { chat(project.root, 1, { goal: 'Make coupons upper case', messages: [{ at: new Date(Date.now() + 1000).toISOString(), text: 'Typed there later' }] }); relist(); });
  await withHome(laptop.home, () => listTick(viewCtx, Date.now() + 3001));
  const seen = () => withHome(laptop.home, () => remoteSessions().find(row => row.id === item.id));
  assert.equal(seen()?.behind, true, 'kept, to catch up');
  withHome(devbox.home, () => hostTick(hostCtx, Date.now() + 1));
  await withHome(laptop.home, () => viewTick(viewCtx));
  assert.ok(seen().entries.some(entry => entry.text === 'Typed there later')); assert.equal(seen().behind, false); assert.equal(seen().ref, item.ref);
});

test('a watched session whose events did not all arrive here keeps its view: the listing that shows more catches it up, a watch its computer let go is made again in place, and only a session gone there loses it', async t => {
  const { laptop, devbox, project, toHost, hostCtx, viewCtx, viewer } = pair(t), start = Date.now(), minute = 60000, day = 86400000;
  const said = (text, at) => ({ at: new Date(at).toISOString(), text });
  const typed = [said('Roll the release', start)];
  const there = (text, at) => { typed.push(said(text, at)); withHome(devbox.home, () => { chat(project.root, 1, { goal: 'Roll the release', state: 'needs_input', messages: typed }); relist(); }); };
  withHome(devbox.home, () => { chat(project.root, 1, { goal: 'Roll the release', state: 'needs_input', messages: typed }); relist(); });
  await withHome(laptop.home, () => listTick(viewCtx));
  const item = withHome(laptop.home, () => remoteMachines()[0].sessions[0]);
  await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteWatch', to: devbox.identity.key, ref: item.ref }));
  withHome(devbox.home, () => hostTick(hostCtx));
  withHome(laptop.home, () => viewer['elu.remote.events'](toHost.sent.filter(([method]) => method === 'elu.remote.events').at(-1)[1], connection(devbox.identity.key)));
  await withHome(laptop.home, () => viewTick(viewCtx));
  const file = withHome(laptop.home, () => path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'peer', 'remote', 'view', `${item.id}.json`));
  const seen = () => withHome(laptop.home, () => remoteSessions().find(row => row.id === item.id));
  assert.deepEqual(seen().entries.map(entry => entry.text), ['Roll the release']);
  // Five minutes on, something is typed there. The devbox sends its events, which never arrive here.
  there('Typed there later', start + 5 * minute);
  withHome(devbox.home, () => hostTick(hostCtx, start + 5 * minute));
  // The next listing shows that change. The devbox still keeps the watch: the view here stays, and catches up.
  await withHome(laptop.home, () => listTick(viewCtx, start + 5 * minute + 3001));
  assert.ok(fs.existsSync(file), 'the view here is kept');
  assert.equal(seen().behind, true);
  await withHome(laptop.home, () => viewTick(viewCtx));
  assert.deepEqual(seen().entries.map(entry => entry.text), ['Roll the release', 'Typed there later']);
  assert.equal(seen().behind, false); assert.equal(seen().ref, item.ref);
  // A listing that says the same again asks for nothing more.
  await withHome(laptop.home, () => listTick(viewCtx, start + 5 * minute + 6002));
  assert.equal(seen().behind, false);
  // A week with nothing new: the devbox lets the watch go. Then something is typed there again.
  withHome(devbox.home, () => hostTick(hostCtx, start + 8 * day));
  assert.throws(() => withHome(devbox.home, () => hostMethods(hostCtx)['elu.remote.since']({ id: item.id, after: 0 }, connection(laptop.identity.key))), /That session is not on this computer\./);
  there('Typed there a week later', start + 8 * day);
  await withHome(laptop.home, () => listTick(viewCtx, start + 8 * day + 3001));
  assert.ok(fs.existsSync(file)); assert.equal(seen().behind, true);
  // Catching up finds the watch gone: it is made again under the same id, and the view starts over in place, never removed.
  await withHome(laptop.home, () => viewTick(viewCtx));
  assert.ok(fs.existsSync(file), 'the view here is kept');
  assert.equal(seen().ref, item.ref); assert.equal(seen().title, 'Roll the release'); assert.equal(seen().behind, true);
  withHome(devbox.home, () => hostTick(hostCtx));
  await withHome(laptop.home, () => viewTick(viewCtx));
  assert.deepEqual(seen().entries.map(entry => entry.text), ['Roll the release', 'Typed there later', 'Typed there a week later']);
  assert.equal(seen().behind, false);
  // A message from here still goes there, to the same session.
  assert.deepEqual(await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteSend', id: item.id, text: 'Ship it' })), { id: item.id });
  assert.equal(withHome(devbox.home, () => pendingRequests(project.root)).at(-1).goal, 'Ship it');
  // The session is gone there: its project there is gone, and the watch too. Only then does the view here go.
  withHome(devbox.home, () => { hostTick(hostCtx, Date.now() + 8 * day); fs.rmSync(path.join(repository(project.root).state, 'tasks', '1'), { recursive: true, force: true }); relist(); });
  await assert.rejects(withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteSend', id: item.id, text: 'Still there?' })), /not on this computer/);
  assert.ok(!fs.existsSync(file), 'a session gone there loses its view here');
});

test('a watched session quiet for a while keeps its view here when something new happens there and the listing shows it before its events come', async t => {
  const { laptop, devbox, project, toHost, hostCtx, viewCtx, viewer } = pair(t), start = Date.now(), minute = 60000;
  const typed = [{ at: new Date(start).toISOString(), text: 'Roll the release' }];
  const save = () => withHome(devbox.home, () => { chat(project.root, 1, { goal: 'Roll the release', state: 'needs_input', messages: typed }); relist(); });
  const deliver = () => withHome(laptop.home, () => viewer['elu.remote.events'](toHost.sent.filter(([method]) => method === 'elu.remote.events').at(-1)[1], connection(devbox.identity.key)));
  save();
  await withHome(laptop.home, () => listTick(viewCtx, start));
  const item = withHome(laptop.home, () => remoteMachines()[0].sessions[0]);
  await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteWatch', to: devbox.identity.key, ref: item.ref }));
  withHome(devbox.home, () => hostTick(hostCtx, start)); deliver();
  await withHome(laptop.home, () => viewTick(viewCtx));
  const file = withHome(laptop.home, () => path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'peer', 'remote', 'view', `${item.id}.json`));
  const seen = () => withHome(laptop.home, () => remoteSessions().find(row => row.id === item.id));
  assert.deepEqual(seen().entries.map(entry => entry.text), ['Roll the release']);
  // Quiet for 15 minutes: the devbox looks at it every 30 s. It looks now, and a few seconds later something is typed there.
  const quiet = start + 15 * minute;
  withHome(devbox.home, () => hostTick(hostCtx, quiet));
  typed.push({ at: new Date(quiet + 5000).toISOString(), text: 'Typed there later' }); save();
  // The listing shows that change before the devbox looks again and sends its events: the view here is kept.
  await withHome(laptop.home, () => listTick(viewCtx, quiet + 6000));
  assert.ok(fs.existsSync(file), 'the view here is kept while the devbox keeps the watch');
  await withHome(laptop.home, () => viewTick(viewCtx));
  assert.ok(fs.existsSync(file));
  // The devbox looks again and sends the events: the same view shows them, with its place there.
  withHome(devbox.home, () => hostTick(hostCtx, quiet + 31000)); deliver();
  await withHome(laptop.home, () => viewTick(viewCtx));
  assert.deepEqual(seen().entries.map(entry => entry.text), ['Roll the release', 'Typed there later']);
  assert.equal(seen().ref, item.ref); assert.equal(seen().title, 'Roll the release'); assert.ok(!seen().handoff);
  assert.equal(seen().createdAt, item.createdAt, 'the same view, not one made again');
});

test('a watch whose view here went while its computer still sends its events keeps its listed place, and a view saved without one takes it at the next list', async t => {
  const { laptop, devbox, project, toHost, hostCtx, viewCtx, viewer } = pair(t);
  withHome(devbox.home, () => { chat(project.root, 1, { goal: 'Roll the release', state: 'running', messages: [{ at: new Date().toISOString(), text: 'Roll the release' }] }); relist(); });
  await withHome(laptop.home, () => listTick(viewCtx));
  const item = withHome(laptop.home, () => remoteMachines()[0].sessions[0]);
  await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteWatch', to: devbox.identity.key, ref: item.ref }));
  const viewPath = () => path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'peer', 'remote', 'view', `${item.id}.json`);
  // The view here goes; the devbox keeps the watch and sends its events on.
  withHome(laptop.home, () => fs.rmSync(viewPath()));
  withHome(devbox.home, () => hostTick(hostCtx));
  withHome(laptop.home, () => viewer['elu.remote.events'](toHost.sent.filter(([method]) => method === 'elu.remote.events').at(-1)[1], connection(devbox.identity.key)));
  const seen = () => withHome(laptop.home, () => remoteSessions().filter(row => row.id === item.id));
  assert.equal(seen().length, 1);
  assert.equal(seen()[0].ref, item.ref, 'the place its computer listed');
  assert.equal(seen()[0].handoff, undefined, 'not taken for a handoff');
  assert.equal(seen()[0].title, 'Roll the release');
  // A view an earlier build saved with no place takes the listed one at the next list.
  withHome(laptop.home, () => { const row = JSON.parse(fs.readFileSync(viewPath(), 'utf8')); delete row.ref; fs.writeFileSync(viewPath(), JSON.stringify({ ...row, project: null, handoff: true, title: 'Your handoff' })); });
  await withHome(laptop.home, () => listTick(viewCtx, Date.now() + 3001));
  assert.equal(seen()[0].ref, item.ref); assert.equal(seen()[0].handoff, undefined); assert.equal(seen()[0].project, withHome(laptop.home, () => remoteMachines()[0].projects.find(row => row.id === item.project).name));
  // A handoff whose id no listing has keeps no place and stays one of its own.
  const handoff = crypto.randomUUID();
  withHome(laptop.home, () => viewer['elu.remote.events']({ items: [{ id: handoff, events: [] }] }, connection(devbox.identity.key)));
  await withHome(laptop.home, () => listTick(viewCtx, Date.now() + 6002));
  const kept = withHome(laptop.home, () => remoteSessions().find(row => row.id === handoff));
  assert.equal(kept.ref, undefined); assert.equal(kept.handoff, true); assert.equal(kept.title, 'Your handoff');
});

test('a session followed here by the id both machines give it shows once in Sessions and under Needs you, and a handoff not listed yet shows once', async () => {
  const D = 'd'.repeat(64), SHOP = 'a'.repeat(64), p = '1'.repeat(16), now = Date.now(), ago = minutes => new Date(now - minutes * 60000).toISOString();
  const status = { key: 'k'.repeat(64), name: 'ana', box: 'laptop', teams: [{ members: [{ key: 'k'.repeat(64), name: 'ana' }, { key: D, name: 'ana', box: 'devbox', online: true }] }] };
  const listed = (task, title, minutes, extra = {}) => ({ id: crypto.randomUUID(), ref: `${p}:${task}`, project: p, title, state: 'running', at: ago(minutes), createdAt: ago(minutes + 1), approvals: [], by: 'you', who: null, repoId: SHOP, ...extra });
  const view = (id, title, minutes, extra = {}) => ({ id, machine: D, createdAt: ago(minutes + 1), lastAt: ago(minutes), state: 'running', title, project: null, entries: [], steps: [], approvals: [], ...extra });
  const wants = [{ id: 'approval-1', role: 'lead', summary: 'Run npm test', at: ago(1) }];
  const roll = listed(10, 'Roll', 1, { state: 'needs_input', question: 'Roll now?' }), backlog = listed(9, 'Session backlog', 2, { by: 'teammate', who: 'kim', approvals: wants });
  const healing = listed(7, 'Self healing', 3), mine = crypto.randomUUID(), started = listed(6, 'Started from the laptop', 4, { by: 'mine', remoteId: mine });
  const fresh = crypto.randomUUID();
  const views = [
    // Followed here under the listed id, with no place there: an earlier build made these.
    view(roll.id, 'Roll', 1, { state: 'needs_input', question: 'Roll now?', handoff: true }), view(backlog.id, 'Session backlog', 2, { approvals: wants, handoff: true }),
    // Paired by its place, and by the id it has here: as before.
    view(crypto.randomUUID(), 'Self healing', 3, { ref: healing.ref, project: 'shop' }), view(mine, 'Started from the laptop', 4),
    // Handed off just now: not listed yet.
    view(fresh, 'Your handoff', 0, { state: 'starting', handoff: true })];
  const machinesFile = [{ key: D, listedAt: ago(0), older: false, projects: [{ id: p, name: 'shop', repoId: SHOP, home: false }], sessions: [roll, backlog, healing, started] }];
  const facade = { mineRows: () => [{ key: D, mine: true, theirs: true }], remoteSessions: () => views, remoteMachines: () => machinesFile, projectRepoId: root => root === '/work/shop' ? SHOP : null };
  const commands = [], glue = remoteGlue({ facade, peerRead: () => status, peerCommand: async command => { commands.push(command); return { answered: true }; }, chatMessage: () => '', ink: text => text, colour: false, restMs: 0 });
  const rows = glue.sections(now, '/work/shop').filter(line => line.row).map(line => line.row);
  assert.deepEqual(rows.map(row => row.remote.title), ['Your handoff', 'Roll', 'Session backlog', 'Self healing', 'Started from the laptop'], 'each once');
  const by = title => rows.find(row => row.remote.title === title);
  for (const [title, item] of [['Roll', roll], ['Session backlog', backlog]]) { assert.equal(by(title).id, item.id); assert.equal(by(title).ref, item.ref, 'the view takes the listed place'); assert.equal(by(title).watched, true); assert.equal(by(title).listed, true); }
  assert.equal(by('Session backlog').by, 'teammate');
  assert.equal(by('Your handoff').listed, false); assert.equal(by('Your handoff').by, 'here');
  assert.equal(by('Self healing').ref, healing.ref); assert.equal(by('Self healing').id, views[2].id);
  assert.equal(by('Started from the laptop').id, mine); assert.equal(by('Started from the laptop').ref, started.ref); assert.equal(by('Started from the laptop').by, 'mine');
  // Needs you: each waiting session once, and the board lists it once.
  const waiting = glue.rows(now);
  assert.deepEqual(waiting.map(row => row.remote.title).sort(), ['Roll', 'Session backlog']);
  assert.equal(boardRows([], now, { remote: waiting }).filter(row => row.kind === 'remote').length, 2);
  // y answers it by the id it is followed by here: no second watch.
  await glue.action(waiting.find(row => row.approval), 'accept');
  assert.deepEqual(commands.at(-1), { type: 'remoteAnswer', id: backlog.id, approval: 'approval-1', decision: 'allow' });
  // Once listed, the fresh handoff is that one row too.
  const listedFresh = listed(11, 'Your handoff', 0, { id: fresh, state: 'starting' });
  machinesFile[0].sessions = [listedFresh, ...machinesFile[0].sessions];
  const later = remoteGlue({ facade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false }).sections(now, '/work/shop').filter(line => line.row).map(line => line.row);
  assert.equal(later.filter(row => row.id === fresh).length, 1); assert.equal(later.find(row => row.id === fresh).ref, listedFresh.ref);
  assert.equal(later.length, 5);
});

// A real handoff has an id of its own (adoptHandoffs), not the one a watch of its place gets.
// The computer it runs on lists it with that id, which its handoff record keeps, so the
// computer it came from shows it once, in its listed place, whether its events came first or after.
test('a handoff the other computer lists shows once here, by the id its handoff record keeps', async t => {
  const { laptop, devbox, project, toHost, viewCtx, host, viewer } = pair(t), kim = 'e'.repeat(64);
  const own = crypto.randomUUID(), picked = crypto.randomUUID(), theirs = crypto.randomUUID(), at = new Date().toISOString();
  const handoff = (id, peer, name, remoteId) => ({ task: a2aTask({ id, contextId: `th-${id}`, state: TaskState.WORKING }), peer, name, kind: 'handoff', threadId: `th-${id}`, root: project.root, requestId: `request-${id}`, localTaskId: null, text: 'Handed off', createdAt: at, remoteId });
  const origin = (id, peer, name, extra = {}) => ({ kind: 'handoff', peer, name, a2aTaskId: id, threadId: `th-${id}`, hop: 1, ...extra });
  withHome(devbox.home, () => {
    // No hosted row says which session each became (it was let go, or never learned it): only the handoff record keeps its id.
    chat(project.root, 1, { goal: 'Run the evals', state: 'running', origin: origin('h-1', laptop.identity.key, 'ana', { own: true }) });
    chat(project.root, 2, { goal: 'Tidy the docs', state: 'running', origin: origin('h-2', laptop.identity.key, 'ana') });
    chat(project.root, 3, { goal: 'Fix the login redirect', state: 'running', origin: origin('h-3', kim, 'kim', { own: true }) });
    saveRecord(handoff('h-1', laptop.identity.key, 'ana', own)); saveRecord(handoff('h-2', laptop.identity.key, 'ana', picked)); saveRecord(handoff('h-3', kim, 'kim', theirs));
    relist();
  });
  const listed = withHome(devbox.home, () => host['elu.remote.list']({}, toHost)).sessions, row = title => listed.find(item => item.title === title);
  assert.equal(row('Run the evals').remoteId, own, 'by the id the laptop follows it by');
  assert.equal(row('Tidy the docs').remoteId, picked, 'one worked there in a mode picked there too');
  assert.equal(row('Fix the login redirect').remoteId, undefined, "a teammate's handoff is not followed from here");
  // The laptop follows two of them, by their events, before the devbox lists them.
  const send = ids => withHome(laptop.home, () => viewer['elu.remote.events']({ items: ids.map(id => ({ id, events: [] })) }, connection(devbox.identity.key)));
  const viewOf = id => withHome(laptop.home, () => remoteSessions().find(item => item.id === id));
  send([own, picked]);
  assert.equal(viewOf(own).handoff, true); assert.equal(viewOf(own).ref, undefined);
  await withHome(laptop.home, () => listTick(viewCtx));
  for (const [id, title] of [[own, 'Run the evals'], [picked, 'Tidy the docs']]) { assert.equal(viewOf(id).ref, row(title).ref, 'it takes its listed place'); assert.equal(viewOf(id).handoff, undefined); }
  const status = { key: laptop.identity.key, name: 'ana', box: 'laptop', teams: [{ members: [{ key: laptop.identity.key, name: 'ana' }, { key: devbox.identity.key, name: 'box', box: 'devbox', online: true }] }] };
  const facade = { mineRows: peerFacade.mineRows, remoteSessions: peerFacade.remoteSessions, remoteMachines: peerFacade.remoteMachines, projectRepoId: () => row('Run the evals').repoId, projectRepoIds: () => [] };
  const rows = () => withHome(laptop.home, () => remoteGlue({ facade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false, restMs: 1e9 }).sections(Date.now(), '/work/shop').filter(line => line.row).map(line => line.row));
  const once = () => {
    const shown = rows();
    assert.equal(shown.length, 3, 'each session once');
    for (const [id, title] of [[own, 'Run the evals'], [picked, 'Tidy the docs']]) { const found = shown.filter(item => item.ref === row(title).ref); assert.equal(found.length, 1, title); assert.equal(found[0].id, id, 'by the id it is followed by'); assert.equal(found[0].listed, true); }
  };
  once();
  // Its view here went, and its events come again: it is made in its listed place, with its listed title.
  withHome(laptop.home, () => fs.rmSync(path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'peer', 'remote', 'view', `${own}.json`)));
  send([own]);
  assert.equal(viewOf(own).ref, row('Run the evals').ref); assert.equal(viewOf(own).title, 'Run the evals'); assert.equal(viewOf(own).handoff, undefined);
  once();
});

test('a computer with many sessions is listed a page a tick, everything only on connect, and lists, catch-ups and watches share one budget', async t => {
  const { laptop, devbox } = machines(t), key = devbox.identity.key, P = '1'.repeat(16);
  await withHome(laptop.home, async () => {
    markMine(laptop.identity.key, key); noteTheirs(key, true);
    const base = Date.now(), row = n => ({ ref: `${P}:${n}`, project: P, title: `Session ${n}`, state: 'answered', at: new Date(base - n * 1000).toISOString(), approvals: [], by: 'you' });
    const answer = (method, params) => method === 'elu.remote.watch' ? { id: watchId(laptop.identity.key, key, params.ref), project: 'shop', title: 'x' }
      : method === 'elu.remote.since' ? { id: params.id, events: [], more: false, last: 0, first: 1 }
      : params.after ? { full: params.since == null, cursor: 5, projects: [{ id: P, name: 'shop' }], sessions: [row(3)], gone: [], next: null }
      : { full: params.since == null, cursor: 5, projects: [{ id: P, name: 'shop' }], sessions: params.since == null ? [row(1), row(2)] : [], gone: [], next: params.since == null ? `${row(2).at}|${P}:2` : null };
    const link = connection(key, { answer }), ctx = context(laptop.identity, { [key]: link }), now = Date.now(), lists = () => link.sent.filter(([method]) => method === 'elu.remote.list');
    await listTick(ctx, now);
    assert.equal(lists().length, 1); assert.deepEqual(remoteMachines(), [], 'nothing is kept until the last page');
    await listTick(ctx, now + 100);
    assert.equal(lists().length, 2); assert.equal(lists()[1][1].after, `${row(2).at}|${P}:2`);
    assert.deepEqual(remoteMachines()[0].sessions.map(item => item.title), ['Session 1', 'Session 2', 'Session 3']);
    // Then only what changed, every few seconds, never everything again while it stays connected.
    await listTick(ctx, now + 200); assert.equal(lists().length, 2);
    for (let at = now + 3200; at < now + 140000; at += 12000) await listTick(ctx, at);
    assert.ok(lists().slice(2).every(([, params]) => params.since === 5), 'only what changed since');
    // On a new connection, everything once.
    remoteConnected(ctx, link); await listTick(ctx, now + 150000);
    assert.equal(lists().at(-1)[1].since, null);
    // Ten sessions behind and a list due at once: no more than 8 requests in 10 s.
    const views = path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'peer', 'remote', 'view'); fs.mkdirSync(views, { recursive: true });
    for (let n = 0; n < 10; n++) { const id = crypto.randomUUID(); fs.writeFileSync(path.join(views, `${id}.json`), JSON.stringify({ id, machine: key, seq: 0, behind: true, createdAt: new Date().toISOString() })); }
    link.sent.length = 0; ctx.sent = new Map(); ctx.listedAt = new Map(); ctx.paging = new Map(); const t0 = Date.now();
    await listTick(ctx, t0 + 0);
    for (let n = 0; n < 5; n++) await viewTick(ctx, t0);
    assert.equal(link.sent.length, 8);
    // A watch the cursor asks for still fits, up to 14; past that it waits a moment.
    for (let n = 10; n < 16; n++) await remoteCommand(ctx, { type: 'remoteWatch', to: key, ref: `${P}:${n}`, cursor: true });
    await assert.rejects(remoteCommand(ctx, { type: 'remoteWatch', to: key, ref: `${P}:16`, cursor: true }), /is busy\. It opens in a moment\./);
    // What the owner does is never held back.
    await remoteCommand(ctx, { type: 'remoteWatch', to: key, ref: `${P}:17` });
    assert.equal(link.sent.length, 15);
  });
});

test('a computer of mine on an older build is listed as one to update, and nothing is asked of one that is not mine', async t => {
  const { laptop, devbox } = machines(t);
  await withHome(laptop.home, async () => {
    markMine(laptop.identity.key, devbox.identity.key); noteTheirs(devbox.identity.key, true);
    // Sessions on other computers, but no list: Method not found.
    const missing = connection(devbox.identity.key); missing.request = async method => { missing.sent.push([method]); const error = new Error('Method not found'); error.details = { rpc: { code: -32601 } }; throw error; };
    await listTick(context(laptop.identity, { [devbox.identity.key]: missing }));
    assert.equal(remoteMachines()[0].older, true);
    assert.equal(UPDATE_LIST('devbox'), 'Update ELU on devbox to see its sessions here.');
    // Not asked again for ten minutes.
    await listTick(context(laptop.identity, { [devbox.identity.key]: missing })); assert.equal(missing.sent.length, 1);
    // A build from before sessions on other computers is asked nothing at all.
    fs.rmSync(path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'peer', 'remote', 'machines'), { recursive: true });
    const old = connection(devbox.identity.key, { remote: 0 });
    await listTick(context(laptop.identity, { [devbox.identity.key]: old }));
    assert.deepEqual(old.sent, []); assert.equal(remoteMachines()[0].older, true);
    // Marked here only: not listed, and no file is made for it.
    fs.rmSync(path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'peer', 'remote', 'machines'), { recursive: true });
    noteTheirs(devbox.identity.key, false);
    const asked = connection(devbox.identity.key, { answer: () => ({ full: true, cursor: 1, projects: [], sessions: [] }) });
    await listTick(context(laptop.identity, { [devbox.identity.key]: asked }));
    assert.deepEqual(asked.sent, []); assert.deepEqual(remoteMachines(), []);
  });
});

test('a computer of mine sends its top agents with its sessions list, and one on a build before them sends none', async t => {
  const { laptop, devbox, project, toViewer } = pair(t), now = new Date().toISOString(), twoDays = new Date(Date.now() - 2 * 86400000).toISOString();
  withHome(devbox.home, () => {
    chat(project.root, 1, { goal: 'Fix the cart total', runs: [
      { role: 'lead', vendor: 'claude', at: now, costUsd: 4.5, model: 'claude-opus-5-5', tokens: { input: 100, output: 20, cacheRead: 3000, cacheWrite: 0 } },
      { role: 'bot:pair', vendor: 'codex', at: now, costUsd: null, tokens: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 } }] });
    chat(project.root, 2, { goal: 'Speed up the build', minutes: 60 * 24 * 3, runs: [{ role: 'lead', vendor: 'claude', at: twoDays, costUsd: 7 }] });
    relist();
  });
  const status = { key: laptop.identity.key, name: 'ana', box: 'laptop', teams: [{ members: [{ key: laptop.identity.key, name: 'ana' }, { key: devbox.identity.key, name: 'ana', box: 'devbox', online: true }] }] };
  const agents = () => withHome(laptop.home, () => remoteGlue({ facade: peerFacade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false }).agents());
  const list = () => withHome(laptop.home, () => listTick(context(laptop.identity, { [devbox.identity.key]: toViewer })));
  await list();
  const top = withHome(laptop.home, () => remoteMachines()[0].topAgents), ref = withHome(laptop.home, () => remoteMachines()[0].sessions.find(row => row.title === 'Fix the cart total').ref);
  assert.deepEqual(top.today.rows.map(row => [row.agent, row.title, row.model, row.costUsd, row.tokens?.cacheRead ?? null]), [['@lead', 'Fix the cart total', 'opus 5.5', 4.5, 3000], ['@pair', 'Fix the cart total', 'codex', null, 0]]);
  assert.equal(top.today.costUsd, 4.5); assert.equal(top.today.partial, true);
  assert.deepEqual(top.week.rows.map(row => [row.title, row.costUsd]), [['Speed up the build', 7], ['Fix the cart total', 4.5], ['Fix the cart total', null]]);
  // Each row opens the session it names: the id this computer knows it by.
  assert.equal(top.today.rows[0].ref, ref); assert.equal(top.today.rows[0].id, watchId(laptop.identity.key, devbox.identity.key, ref));
  assert.deepEqual(agents().map(row => [row.machine.name, Boolean(row.top), row.listed]), [['devbox', true, true]]);
  // A build from before them: its list carries no topAgents, so nothing of it is counted and the Usage tab says to update it.
  const answer = toViewer.request;
  toViewer.request = async (method, params) => { const { topAgents, ...rest } = await answer(method, params); void topAgents; return rest; };
  await list();
  assert.equal(withHome(laptop.home, () => remoteMachines()[0].topAgents), null);
  assert.deepEqual(agents().map(row => [row.machine.name, row.top, row.listed]), [['devbox', null, true]]);
  // Offline, it is left out.
  status.teams[0].members[1].online = false;
  assert.deepEqual(agents(), []);
});

// The app's side: what Sessions and Projects show of each computer of mine.
test("Sessions groups my computer's sessions of this repository under its name, newest first, and Projects lists its other projects", async () => {
  const SHOP = 'a'.repeat(64), DOCS = 'f'.repeat(64), D = 'd'.repeat(64), K = 'e'.repeat(64), now = Date.now(), ago = minutes => new Date(now - minutes * 60000).toISOString();
  const status = { key: 'k'.repeat(64), name: 'ana', box: 'laptop', teams: [{ members: [{ key: 'k'.repeat(64), name: 'ana' }, { key: D, name: 'ana', box: 'devbox', online: true }, { key: K, name: 'kim', box: 'kims-mac', online: true }] }] };
  const session = (ref, title, minutes, extra = {}) => ({ id: crypto.randomUUID(), ref, project: ref.split(':')[0], title, state: 'answered', at: ago(minutes), createdAt: ago(minutes + 1), approvals: [], by: 'you', who: null, ...extra });
  const p = { shop: '1'.repeat(16), home: '2'.repeat(16), docs: '3'.repeat(16) };
  const started = { id: crypto.randomUUID(), machine: D, createdAt: ago(30), lastAt: ago(30), state: 'answered', title: 'Started from the laptop', entries: [], steps: [], approvals: [] };
  const machinesFile = [{ key: D, listedAt: ago(0), older: false, projects: [{ id: p.shop, name: 'shop', repoId: SHOP, home: false }, { id: p.home, name: 'ana', repoId: null, home: true }, { id: p.docs, name: 'docs', repoId: DOCS, home: false }],
    sessions: [session(`${p.shop}:3`, 'Fix the login redirect', 2, { by: 'teammate', who: 'kim', state: 'running', approvals: [{ id: 'approval-9', role: 'lead', summary: 'Run git push', at: ago(1) }] }), session(`${p.home}:1`, 'Tidy my notes', 3), session(`${p.shop}:1`, 'Typed there by hand', 5), session(`${p.shop}:2`, 'Nightly check', 9, { by: 'schedule' }), session(`${p.shop}:4`, 'Old one', 60 * 24 * 8), session(`${p.docs}:1`, 'Write the guide', 4),
      // A question in the home folder of that computer, and a session finished five days ago that was opened here just now.
      session(`${p.home}:2`, 'Pick a name', 7, { state: 'needs_input', question: 'Which name?' }), session(`${p.shop}:5`, 'Five days old', 60 * 24 * 5)] },
    // Kim's computer is not mine: a list kept for it (it never is) shows nowhere.
    { key: K, listedAt: ago(0), projects: [{ id: p.shop, name: 'shop', repoId: SHOP }], sessions: [session(`${p.shop}:8`, 'Kim private', 1)] }];
  // Watching it stamped its first events with the moment it was watched.
  const opened = { id: crypto.randomUUID(), machine: D, ref: `${p.shop}:5`, createdAt: ago(60 * 24 * 5 + 1), lastAt: ago(0), state: 'answered', title: 'Five days old', entries: [], steps: [], approvals: [] };
  const facade = { mineRows: () => [{ key: D, mine: true, theirs: true }, { key: K, mine: true, theirs: false }], remoteSessions: () => [started, opened], remoteMachines: () => machinesFile, projectRepoId: root => root === '/work/shop' ? SHOP : null };
  const commands = [], glue = remoteGlue({ facade, peerRead: () => status, peerCommand: async command => { commands.push(command); return { id: command.id ?? 'x', answered: true }; }, chatMessage: ({ title, text }) => `${title}: ${text}`, ink: text => text, colour: false, restMs: 0 });
  const lines = glue.sections(now, '/work/shop'), text = line => line.header ?? line.note ?? (line.row ? rowTitle(line.row, now) : '');
  assert.deepEqual(lines.filter(line => !line.spacer).map(text), ['On devbox · online', 'Fix the login redirect · wants to run git push', 'Typed there by hand', 'Nightly check', 'Started from the laptop', 'Five days old']);
  // The one opened here keeps the place and the age its computer listed, not the moment it was watched.
  const old = lines.find(line => line.row?.ref === `${p.shop}:5`).row;
  assert.equal(old.watched, true); assert.equal(old.last, Date.parse(ago(60 * 24 * 5))); assert.equal(old.time, remoteRow({ ...opened, lastAt: ago(60 * 24 * 5) }, 'devbox', now).time);
  assert.ok(lines.filter(line => line.row).every(line => line.row.key === `remote:${D}\0remote\0${line.row.id}`));
  // Its approval also waits under Needs you here, marked with the computer, and so does the
  // question in its home folder, which Sessions does not list under this project.
  const wants = glue.rows(now);
  assert.deepEqual(wants.map(row => rowTitle(row, now)).sort(), ['on devbox · Pick a name', 'on devbox · wants to run git push']);
  assert.equal(boardRows([], now, { remote: wants })[0].key, `remote:${D}\0remote\0${wants.find(row => row.approval).id}/wants`);
  // y there answers it on the devbox, by its place, as the session is not followed here yet.
  const wanted = wants.find(row => row.approval);
  assert.equal(await glue.action(wanted, 'accept'), 'Allowed.');
  assert.deepEqual(commands.at(-1), { type: 'remoteAnswer', id: wanted.id, to: D, ref: `${p.shop}:3`, approval: 'approval-9', decision: 'allow' });
  // A listed session is opened by watching it; until then what its computer listed shows.
  const listedRow = lines.find(line => line.row?.ref === `${p.shop}:1`).row;
  assert.match(glue.view(listedRow, 80), /Opening it on @devbox…/);
  // The model, a bot and the shell of a session there are named with that computer; the owner's message says it went there.
  const said = glue.view({ ...old, remote: { ...old.remote, entries: [{ role: 'You', at: ago(3), text: 'Check the build' }, { role: 'Opus 5.5', lead: true, at: ago(2), text: 'It builds.' }, { role: '@reviewer', bot: 'reviewer', at: ago(1), text: 'Looks right.' }, { role: 'Shell', shell: true, at: ago(0), text: '$ ls' }] } }, 80);
  assert.match(said, /You → @devbox: Check the build[\s\S]*Opus 5\.5 on @devbox: It builds\.[\s\S]*@reviewer on @devbox: Looks right\.[\s\S]*Shell on @devbox: \$ ls/);
  await pause(0); assert.deepEqual(commands.at(-1), { type: 'remoteWatch', to: D, ref: `${p.shop}:1`, cursor: true });
  assert.deepEqual(rowActions(listedRow), [['enter', 'open'], ['d', 'changes']], 'it stays as long as it is there: nothing to remove');
  // Another project open here, of no repository: only what was started from here.
  assert.deepEqual(glue.sections(now, '/work/elsewhere').filter(line => line.row).map(line => rowTitle(line.row, now)), ['Started from the laptop']);
  // Projects: its other projects, as "<project> on <name>".
  assert.deepEqual(glue.projects(now, '/work/shop').map(row => [row.name, row.sessions]), [['ana on devbox', 2], ['docs on devbox', 1]]);
  // Opened from Projects: that project's sessions under a heading of their own.
  const first = glue.openProject(D, p.home);
  const after = glue.sections(now, '/work/shop').filter(line => !line.spacer).map(text);
  assert.deepEqual(after.slice(-3), ['ana on devbox', 'Tidy my notes', 'Pick a name']);
  assert.equal(first, glue.sections(now, '/work/shop').find(line => line.row?.ref === `${p.home}:1`).row.key);
  // The cursor has to rest on a row before it is watched: passing over it asks nothing.
  const resting = [], slow = remoteGlue({ facade, peerRead: () => status, peerCommand: async command => { resting.push(command); return {}; }, chatMessage: () => '', ink: text => text, colour: false, restMs: 40 });
  const restRow = slow.sections(now, '/work/shop').find(line => line.row?.ref === `${p.shop}:1`).row;
  slow.view(restRow, 80); await pause(0); assert.deepEqual(resting, []);
  await pause(50); slow.view(restRow, 80); assert.equal(resting.length, 1);
  // A watch that fails says why, and is asked again only after a while, not on every draw.
  const failing = [], refused = remoteGlue({ facade, peerRead: () => status, peerCommand: async command => { failing.push(command); throw new Error('@devbox: Not now.'); }, chatMessage: () => '', ink: text => text, colour: false, restMs: 0 });
  const refusedRow = refused.sections(now, '/work/shop').find(line => line.row?.ref === `${p.shop}:1`).row;
  refused.view(refusedRow, 80); await pause(0);
  for (let i = 0; i < 5; i++) { assert.match(refused.view(refusedRow, 80), /@devbox: Not now\./); await pause(0); }
  assert.equal(failing.length, 1);
  // An offline computer is not asked at all: what it listed last shows, and says so.
  status.teams[0].members[1].online = false;
  const offline = [], away = remoteGlue({ facade, peerRead: () => status, peerCommand: async command => { offline.push(command); return {}; }, chatMessage: () => '', ink: text => text, colour: false, restMs: 0 });
  const awayRow = away.sections(now, '/work/shop').find(line => line.row?.ref === `${p.shop}:1`).row;
  for (let i = 0; i < 5; i++) { assert.match(away.view(awayRow, 80), /@devbox is offline\. What it listed last is shown\./); await pause(0); }
  assert.deepEqual(offline, []);
  // An offline computer keeps its last list, and says so; an older one says to update it.
  machinesFile[0].older = true;
  const older = remoteGlue({ facade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false }).sections(now, '/work/shop').filter(line => !line.spacer).map(text);
  assert.deepEqual(older.slice(0, 2), ['On devbox · offline', 'Update ELU on devbox to see its sessions here.']);
});

// The owner's two computers as they are: projects that are folders holding clones, with no
// origin of their own. A session there shows here when it works in a repository this project
// holds, found as the Kanban finds it.
function folderAt(t, name) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-mine-'))); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, name); fs.mkdirSync(root);
  const repo = projectFolder(root); registerProject(repo); return repo;
}
function cloneAt(folder, name, origin) {
  const target = path.join(folder, name), run = args => { const r = spawnSync('git', ['-C', target, ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
  fs.mkdirSync(target); run(['init', '-q']); run(['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', `start ${name}`]); run(['remote', 'add', 'origin', origin]);
  return target;
}
// A session whose edit runs in a clone (task.repository), as a Task's edit does.
function editIn(repo, id, repository, goal, minutes = 0) {
  const place = taskPlace(repo, id, repository);
  saveTask(repo, { id: String(id), goal, state: 'answered', repository, worktree: place.worktree, branch: place.branch, base: 'a'.repeat(40), createdAt: new Date(Date.now() - minutes * 60000).toISOString(), runs: [], reviews: [], messages: [], sessions: {} });
}

test("my other computer's sessions show here by the repository each works in, from a folder holding several clones, as on the Kanban", async t => {
  const { laptop, devbox } = machines(t), X = 'https://github.com/acme/shop.git', Y = 'https://github.com/acme/docs.git', Z = 'https://github.com/acme/other.git', W = 'https://github.com/acme/tools.git';
  // The laptop: a folder holding a clone of X and one of Y, with no origin of its own, and a
  // session there that edited a clone of W outside it. Its Kanban has a board for each, as the
  // daemon found them (repos.json).
  const here = withHome(laptop.home, () => {
    const repo = folderAt(t, 'projects'); cloneAt(repo.root, 'shop', X); cloneAt(repo.root, 'docs', Y);
    editIn(repo, 1, cloneAt(path.dirname(repo.root), 'tools', W), 'Add a flag', 5);
    saveLocalRepos(localRepos()); markMine(laptop.identity.key, devbox.identity.key); noteTheirs(devbox.identity.key, true);
    return repo;
  });
  // The devbox: a home-like folder with no origin, holding a clone of X and one of Z. A session
  // whose Task works in X, one in Z. Another project folder holding one clone of X, with a
  // session that has no Task yet: it works in that project's main repository.
  withHome(devbox.home, () => {
    const home = folderAt(t, 'ana'), shop = cloneAt(home.root, 'shop-web', X), other = cloneAt(home.root, 'other', Z);
    editIn(home, 1, shop, 'Fix the cart total', 3); editIn(home, 2, other, 'Tidy the other one', 2); editIn(home, 3, cloneAt(home.root, 'tools', W), 'Speed up the build', 0.5);
    const hub = folderAt(t, 'hub'); cloneAt(hub.root, 'shop', X);
    saveTask(hub, { id: '1', kind: 'conversation', goal: 'Where is the cart?', state: 'answered', worktree: hub.root, base: null, branch: null, createdAt: new Date(Date.now() - 60000).toISOString(), runs: [], reviews: [], responses: [], messages: [], sessions: {}, result: null });
    markMine(devbox.identity.key, laptop.identity.key); noteTheirs(laptop.identity.key, true); relist();
  });
  const toHost = connection(laptop.identity.key), hostCtx = context(devbox.identity, { [laptop.identity.key]: toHost }), host = hostMethods(hostCtx);
  let strip = false;
  const toViewer = connection(devbox.identity.key, { answer: (method, params) => {
    const result = withHome(devbox.home, () => host[method](params, toHost));
    // A host on the build before: its sessions name no repository.
    return strip && method === 'elu.remote.list' ? { ...result, sessions: result.sessions.map(({ repoId, ...rest }) => rest) } : result;
  } });
  const status = { key: laptop.identity.key, name: 'ana', box: 'laptop', teams: [{ members: [{ key: laptop.identity.key, name: 'ana' }, { key: devbox.identity.key, name: 'ana', box: 'devbox', online: true }] }] };
  const shown = () => withHome(laptop.home, () => {
    const glue = remoteGlue({ facade: peerFacade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false });
    return glue.sections(Date.now(), here.root).filter(line => !line.spacer).map(line => line.header ?? line.note ?? line.row.remote.title);
  });
  const listed = async () => { withHome(laptop.home, () => fs.rmSync(path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'peer', 'remote', 'machines'), { recursive: true, force: true })); await withHome(laptop.home, () => listTick(context(laptop.identity, { [devbox.identity.key]: toViewer }))); };
  await listed();
  const kept = withHome(laptop.home, () => remoteMachines()[0]);
  const repoOf = title => kept.sessions.find(row => row.title === title).repoId;
  assert.equal(repoOf('Fix the cart total'), repoOf('Where is the cart?'), 'both work in X');
  assert.match(repoOf('Fix the cart total'), /^[0-9a-f]{64}$/); assert.notEqual(repoOf('Tidy the other one'), repoOf('Fix the cart total'));
  assert.deepEqual(kept.projects.map(row => row.repoId), [null, null], 'neither project folder has an origin');
  // Under its heading: the ones in X, which this folder holds, and the one in W, which a session
  // here works in, as on its Kanban; not the one in Z.
  assert.deepEqual(shown(), ['On devbox · online', 'Speed up the build', 'Where is the cart?', 'Fix the cart total']);
  // The host on the build before: each goes by its project's repository, and neither project has one.
  strip = true; await listed();
  assert.equal(withHome(laptop.home, () => remoteMachines()[0].sessions.every(row => row.repoId === null)), true);
  assert.deepEqual(shown(), ['On devbox · online', 'No sessions of this project. Projects lists its others.']);
  // A teammate's computer not marked mine: nothing is listed there, and nothing shows here.
  strip = false; await listed();
  withHome(devbox.home, () => unmarkMine(laptop.identity.key));
  assert.throws(() => withHome(devbox.home, () => host['elu.remote.list']({}, toHost)), { message: NOT_MINE });
  withHome(laptop.home, () => noteTheirs(devbox.identity.key, false));
  assert.deepEqual(shown(), []);
});

test("a session with no repository of its own goes with the main repository picked from every session of its project, archived and older ones too, as on the Kanban", t => {
  const { laptop, devbox } = machines(t), X = 'https://github.com/acme/shop.git', Z = 'https://github.com/acme/other.git';
  const toHost = connection(laptop.identity.key), host = hostMethods(context(devbox.identity, { [laptop.identity.key]: toHost }));
  withHome(devbox.home, () => {
    // The home-like folder holds a clone of X and one of Z. The newest session with a
    // repository of its own worked in X nine days ago, one in Z before it; neither is listed.
    // A conversation started there now has no Task.
    const home = folderAt(t, 'ana'), shop = cloneAt(home.root, 'shop-web', X), other = cloneAt(home.root, 'other', Z);
    editIn(home, 1, other, 'Tidy the other one', 60 * 24 * 12); editIn(home, 2, shop, 'Fix the cart total', 60 * 24 * 9);
    saveTask(home, { id: '3', kind: 'conversation', goal: 'Where is the cart?', state: 'answered', worktree: home.root, base: null, branch: null, createdAt: new Date(Date.now() - 60000).toISOString(), runs: [], reviews: [], responses: [], messages: [], sessions: {}, result: null });
    markMine(devbox.identity.key, laptop.identity.key); noteTheirs(laptop.identity.key, true);
    const listed = () => { relist(); return host['elu.remote.list']({}, toHost).sessions.map(row => [row.title, row.repoId]); };
    assert.deepEqual(listed(), [['Where is the cart?', folderRemote(shop).repoId]]);
    // A session in Z, newer, archived: not listed, and now the conversation goes with Z.
    editIn(home, 4, other, 'Rename the other one', 30); closeSession(home, '4');
    assert.deepEqual(listed(), [['Where is the cart?', folderRemote(other).repoId]]);
  });
});

test("Projects lists my computer's project of this repository while Sessions leaves out one of its sessions, and with no computer of mine nothing is read", () => {
  const SHOP = 'a'.repeat(64), DOCS = 'f'.repeat(64), D = 'd'.repeat(64), now = Date.now(), ago = minutes => new Date(now - minutes * 60000).toISOString();
  const status = { key: 'k'.repeat(64), name: 'ana', box: 'laptop', teams: [{ members: [{ key: 'k'.repeat(64), name: 'ana' }, { key: D, name: 'ana', box: 'devbox', online: true }] }] };
  const session = (ref, title, minutes, repoId) => ({ id: crypto.randomUUID(), ref, project: ref.split(':')[0], title, state: 'answered', at: ago(minutes), createdAt: ago(minutes + 1), approvals: [], by: 'you', who: null, repoId });
  const p = { shop: '1'.repeat(16), clone: '4'.repeat(16) };
  // Two clones of the shop there. A session in the second edited the docs, another clone in
  // that computer's home folder.
  const machinesFile = [{ key: D, listedAt: ago(0), older: false, projects: [{ id: p.shop, name: 'shop', repoId: SHOP, home: false }, { id: p.clone, name: 'shop-2', repoId: SHOP, home: false }],
    sessions: [session(`${p.shop}:1`, 'Fix the cart', 2, SHOP), session(`${p.clone}:1`, 'Edit the docs', 3, DOCS), session(`${p.clone}:2`, 'Fix the total', 4, SHOP)] }];
  let mine = [{ key: D, mine: true, theirs: true }], holds = [], asked = 0;
  const facade = { mineRows: () => mine, remoteSessions: () => [], remoteMachines: () => machinesFile, projectRepoId: root => root === '/work/shop' ? SHOP : null, projectRepoIds: () => { asked += 1; return holds; } };
  const glue = () => remoteGlue({ facade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false });
  const shown = view => view.sections(now, '/work/shop').filter(line => !line.spacer).map(line => line.header ?? line.note ?? line.row.remote.title);
  let view = glue();
  assert.deepEqual(shown(view), ['On devbox · online', 'Fix the cart', 'Fix the total']);
  // The shop there shows whole; its other clone does not, so Projects lists it, for the one session not shown here.
  assert.deepEqual(view.projects(now, '/work/shop').map(row => [row.name, row.sessions]), [['shop-2 on devbox', 1]]);
  view.openProject(D, p.clone);
  assert.deepEqual(shown(view).slice(-2), ['shop-2 on devbox', 'Edit the docs']);
  // This project's Kanban has a board for the docs too: the session shows, and Projects leaves the clone out.
  holds = [DOCS]; view = glue();
  assert.deepEqual(shown(view), ['On devbox · online', 'Fix the cart', 'Edit the docs', 'Fix the total']);
  assert.deepEqual(view.projects(now, '/work/shop'), []);
  // With no computer of mine, what this project holds is not read.
  mine = []; asked = 0; view = glue();
  assert.deepEqual(shown(view), []); assert.deepEqual(view.projects(now, '/work/shop'), []); assert.equal(asked, 0);
});

// The owner's two computers as he has them: here a folder holding clones, there the home
// folder, neither with a repository of its own. Every session there that works in a repository
// this project holds is part of this project: in Sessions under the computer's heading, and not
// a second time in Projects.
test("my computer's project is one with this one: Projects leaves it out while each of its sessions shows here, and lists it, with how many, for those that cannot", () => {
  const SHOP = 'a'.repeat(64), DOCS = 'f'.repeat(64), D = 'd'.repeat(64), now = Date.now(), ago = minutes => new Date(now - minutes * 60000).toISOString(), home = '5'.repeat(16);
  const status = { key: 'k'.repeat(64), name: 'ana', box: 'laptop', teams: [{ members: [{ key: 'k'.repeat(64), name: 'ana' }, { key: D, name: 'box', box: 'devbox', online: true }] }] };
  const session = (ref, title, minutes, extra = {}) => ({ id: crypto.randomUUID(), ref, project: home, title, state: 'answered', at: ago(minutes), createdAt: ago(minutes + 1), approvals: [], by: 'you', who: null, repoId: SHOP, ...extra });
  const machinesFile = [{ key: D, listedAt: ago(0), older: false, projects: [{ id: home, name: 'work', repoId: null, home: true }],
    sessions: [session(`${home}:1`, 'By hand there', 2), session(`${home}:2`, 'From the laptop', 3, { by: 'mine' }), session(`${home}:3`, 'A message from kim', 4, { by: 'teammate', who: 'kim' })] }];
  // Two of them are followed here, so their pane says who started them and where a message goes.
  const views = [2, 3].map(n => ({ id: crypto.randomUUID(), machine: D, ref: `${home}:${n}`, createdAt: ago(n + 1), lastAt: ago(n), state: 'answered', title: machinesFile[0].sessions[n - 1].title, entries: [], steps: [], approvals: [] }));
  const facade = { mineRows: () => [{ key: D, mine: true, theirs: true }], remoteSessions: () => views, remoteMachines: () => machinesFile, projectRepoId: () => null, projectRepoIds: () => [SHOP] };
  const glue = () => remoteGlue({ facade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: ({ title, text }) => `${title}: ${text}`, ink: text => text, colour: false, restMs: 1e9 });
  const shown = view => view.sections(now, '/work/projects').filter(line => !line.spacer).map(line => line.header ?? line.note ?? line.row.remote.title);
  let view = glue();
  assert.deepEqual(shown(view), ['On devbox · online', 'By hand there', 'From the laptop', 'A message from kim']);
  assert.deepEqual(view.projects(now, '/work/projects'), [], 'every session there is part of this project');
  // Mine, from the laptop: a plain message goes to the agent here, and no one is named as who started it.
  const rowOf = title => view.sections(now, '/work/projects').find(line => line.row?.remote.title === title).row;
  const laptops = rowOf('From the laptop'), kims = rowOf('A message from kim');
  assert.deepEqual(view.route(laptops, 'check the numbers'), { to: 'here', text: 'check the numbers' });
  assert.match(view.label(laptops), /Message your agent here/);
  assert.doesNotMatch(view.view(laptops, 200), /Started by/); assert.match(view.view(laptops, 200), /Type below to write to your agent here/);
  // A teammate's: named, and every message goes to it, as before.
  assert.deepEqual(view.route(kims, 'check the numbers'), { to: 'there', text: 'check the numbers' });
  assert.match(view.view(kims, 200), /Started by @kim\. Type below to continue it there\./);
  // Two that this project cannot show: one in no repository, one in a repository it does not
  // hold. Projects lists the project for those two only, and opening it shows them.
  machinesFile[0].sessions.push(session(`${home}:4`, 'Tidy my notes', 1, { repoId: null }), session(`${home}:5`, 'Edit the docs', 5, { repoId: DOCS }));
  view = glue();
  assert.deepEqual(view.projects(now, '/work/projects').map(row => [row.name, row.sessions]), [['work on devbox', 2]]);
  view.openProject(D, home);
  assert.deepEqual(shown(view).slice(-3), ['work on devbox', 'Tidy my notes', 'Edit the docs']);
  // No sessions there yet: nothing to open, so nothing in Projects, and the heading says so.
  machinesFile[0].sessions = []; views.length = 0; view = glue();
  assert.deepEqual(view.projects(now, '/work/projects'), []);
  assert.deepEqual(shown(view), ['On devbox · online', 'No sessions yet.']);
});

test("a session a message from my other computer started there is mine on its list, from before too, and goes to my agent here; a teammate's stays theirs, and an older host's row from my computer is read as mine", async t => {
  const { laptop, devbox, project, toHost, toViewer, host } = pair(t), kim = 'e'.repeat(64), followed = crypto.randomUUID();
  const repo = withHome(devbox.home, () => {
    // Started by messages through the teammate path, as a build from before keeps them: no mine on the origin.
    chat(project.root, 1, { goal: 'Run the evals', minutes: 3, origin: { kind: 'handoff', peer: laptop.identity.key, name: 'ana', threadId: null, own: true } });
    const repo = chat(project.root, 2, { goal: 'Fix the login redirect', minutes: 2, origin: { kind: 'handoff', peer: kim, name: 'kim', threadId: null, own: true } });
    // The laptop already follows the first, as a handoff of its own (adoptHandoffs).
    const folder = path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'peer', 'remote', 'host'), now = new Date().toISOString();
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${followed}.json`), JSON.stringify({ id: followed, machine: laptop.identity.key, root: project.root, requestId: null, taskId: '1', text: 'Run the evals', createdAt: now, updatedAt: now, seq: 0, first: 1, seen: {}, handoff: true }));
    relist(); return repo;
  });
  const listed = withHome(devbox.home, () => host['elu.remote.list']({}, toHost)), row = title => listed.sessions.find(item => item.title === title);
  assert.deepEqual([row('Run the evals').by, row('Run the evals').who, row('Run the evals').remoteId], ['mine', null, followed], 'by the id the laptop follows it by, so it is one session there');
  assert.deepEqual([row('Fix the login redirect').by, row('Fix the login redirect').who, row('Fix the login redirect').remoteId], ['teammate', 'kim', undefined]);
  // Nothing on the session itself changed: its mode and rules are what they were.
  assert.deepEqual(withHome(devbox.home, () => readTask(repo, '1').origin), { kind: 'handoff', peer: laptop.identity.key, name: 'ana', threadId: null, own: true });
  // The laptop lists them; old: the devbox on the build before, which lists that one as kim's is listed.
  const list = async (old = false) => {
    withHome(laptop.home, () => fs.rmSync(path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'peer', 'remote', 'machines'), { recursive: true, force: true }));
    toViewer.request = async (method, params) => {
      const result = withHome(devbox.home, () => host[method](params, toHost));
      // A build from before also does not say it decided mine by key.
      return old && method === 'elu.remote.list' ? { ...result, mineByPeer: undefined, sessions: result.sessions.map(({ remoteId, ...item }) => item.by === 'mine' ? { ...item, by: 'teammate', who: 'ana' } : item) } : result;
    };
    await withHome(laptop.home, () => listTick(context(laptop.identity, { [devbox.identity.key]: toViewer })));
    return withHome(laptop.home, () => Object.fromEntries(remoteMachines()[0].sessions.map(item => [item.title, [item.by, item.who]])));
  };
  const status = { key: laptop.identity.key, name: 'ana', box: 'laptop', teams: [{ members: [{ key: laptop.identity.key, name: 'ana' }, { key: devbox.identity.key, name: 'box', box: 'devbox', online: true }] }] };
  const facade = { mineRows: peerFacade.mineRows, remoteSessions: peerFacade.remoteSessions, remoteMachines: peerFacade.remoteMachines, projectRepoId: () => row('Run the evals').repoId, projectRepoIds: () => [] };
  const routes = () => withHome(laptop.home, () => {
    const glue = remoteGlue({ facade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false, restMs: 1e9 });
    return Object.fromEntries(glue.sections(Date.now(), '/work/shop').filter(line => line.row).map(line => [line.row.remote.title, glue.route(line.row, 'go on').to]));
  });
  assert.deepEqual(await list(), { 'Run the evals': ['mine', null], 'Fix the login redirect': ['teammate', 'kim'] });
  assert.deepEqual(routes(), { 'Run the evals': 'here', 'Fix the login redirect': 'there' });
  assert.deepEqual(await list(true), { 'Run the evals': ['mine', null], 'Fix the login redirect': ['teammate', 'kim'] }, "an older host names this computer: it is read as mine");
  assert.deepEqual(routes(), { 'Run the evals': 'here', 'Fix the login redirect': 'there' });
});

// A real teammate (kim, on another account) whose name is the laptop's, Ana, hands a session to
// my devbox. It is kim's on every list, whatever the name, and nothing of mine goes to it.
test("a teammate named like my computer keeps their session on my other computer's list, from a newer host and an older one, and only mine are offered to my sessions here", async t => {
  const { team, laptop, devbox, project, toHost, toViewer, host } = pair(t), kim = withHome(newHome(t), () => createIdentity({ name: 'Ana' }));
  const log = withHome(laptop.home, () => { redeemCode(createInvite(laptop.identity, team.teamId, { hours: 1 }), kim.key, 'Ana'); return readLog(team.teamId).ops; });
  withHome(devbox.home, () => {
    merge(team.teamId, log);
    chat(project.root, 1, { goal: 'Run the evals', minutes: 3, origin: { kind: 'handoff', peer: laptop.identity.key, name: 'ana', threadId: null, own: true } });
    chat(project.root, 2, { goal: 'Fix the login redirect', minutes: 2, origin: { kind: 'handoff', peer: kim.key, name: 'Ana', threadId: null, own: true } });
    // Taken on here in a mode picked by hand (w): still mine, as it came from my laptop.
    chat(project.root, 3, { goal: 'Check the build', minutes: 1, origin: { kind: 'handoff', peer: laptop.identity.key, name: 'ana', threadId: null } });
    relist();
  });
  const listed = withHome(devbox.home, () => host['elu.remote.list']({}, toHost)), row = title => listed.sessions.find(item => item.title === title);
  assert.equal(listed.mineByPeer, true);
  assert.deepEqual(['Run the evals', 'Fix the login redirect', 'Check the build'].map(title => [row(title).by, row(title).who]), [['mine', null], ['teammate', 'Ana'], ['mine', null]]);
  // The laptop lists them: from this host, and from one of the build before, which lists mine as a teammate's by the laptop's name.
  const list = async (old = false) => {
    withHome(laptop.home, () => fs.rmSync(path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'peer', 'remote', 'machines'), { recursive: true, force: true }));
    toViewer.request = async (method, params) => {
      const result = withHome(devbox.home, () => host[method](params, toHost));
      return old && method === 'elu.remote.list' ? { ...result, mineByPeer: undefined, sessions: result.sessions.map(({ remoteId, ...item }) => item.by === 'mine' ? { ...item, by: 'teammate', who: 'ana' } : item) } : result;
    };
    await withHome(laptop.home, () => listTick(context(laptop.identity, { [devbox.identity.key]: toViewer })));
    return withHome(laptop.home, () => Object.fromEntries(remoteMachines()[0].sessions.map(item => [item.title, [item.by, item.who]])));
  };
  const status = { key: laptop.identity.key, name: 'ana', box: 'laptop', teams: [{ members: [{ key: laptop.identity.key, name: 'ana' }, { key: devbox.identity.key, name: 'box', box: 'devbox', online: true }, { key: kim.key, name: 'Ana', box: 'kims-mac', online: true }] }] };
  const facade = { mineRows: peerFacade.mineRows, remoteSessions: peerFacade.remoteSessions, remoteMachines: peerFacade.remoteMachines, projectRepoId: () => row('Run the evals').repoId, projectRepoIds: () => [] };
  const routes = () => withHome(laptop.home, () => {
    const glue = remoteGlue({ facade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false, restMs: 1e9 });
    return Object.fromEntries(glue.sections(Date.now(), '/work/shop').filter(line => line.row).map(line => [line.row.remote.title, glue.route(line.row, 'go on').to]));
  });
  // What the laptop's own sessions may send to: only mine (lib/peer/session-tools.mjs).
  const offered = () => withHome(laptop.home, () => otherSessions().computers.flatMap(machine => machine.sessions.map(item => item.title)));
  assert.deepEqual(await list(), { 'Run the evals': ['mine', null], 'Fix the login redirect': ['teammate', 'Ana'], 'Check the build': ['mine', null] }, "kim's name is the laptop's, and kim's session stays kim's");
  assert.deepEqual(routes(), { 'Run the evals': 'here', 'Fix the login redirect': 'there', 'Check the build': 'here' });
  assert.deepEqual(offered().sort(), ['Check the build', 'Run the evals']);
  // From the build before, a name is all there is, and kim goes by the laptop's: it says nothing,
  // so mine there shows as a teammate's, as it did before, and kim's is never shown as mine.
  assert.deepEqual(await list(true), { 'Run the evals': ['teammate', 'ana'], 'Fix the login redirect': ['teammate', 'Ana'], 'Check the build': ['teammate', 'ana'] });
  assert.deepEqual(routes(), { 'Run the evals': 'there', 'Fix the login redirect': 'there', 'Check the build': 'there' });
  assert.deepEqual(offered(), []);
});

test('the Changes of a session on my other computer are read once and whole, named in its chat in one line, and asked for when the tab opens before they were sent', async () => {
  const ME = 'a'.repeat(64), D = 'd'.repeat(64), at = new Date().toISOString(), sent = [];
  const status = { key: ME, name: 'ana', teams: [{ id: 'team-1', members: [{ key: ME, name: 'ana', online: true }, { key: D, name: 'ana', box: 'devbox', online: true }] }] };
  const make = peerCommand => remoteGlue({ facade: { mineRows: () => [], remoteSessions: () => [] }, peerRead: () => status, peerCommand, chatMessage: ({ title, text }) => `${title}\n${text}`, ink: text => text, colour: false, restMs: 1e9 });
  const glue = make(async command => { sent.push(command); return {}; });
  const row = (view = {}, extra = {}) => ({ ...remoteRow({ id: START.id, machine: D, createdAt: at, state: 'ready', title: 'Fix the report', entries: [{ role: 'You', at, text: 'Fix the report' }], steps: [], approvals: [], ...view }, 'devbox'), listed: true, watched: true, ref: 'p:1', online: true, ...extra });
  const patch = ['diff --git a/src/cart.mjs b/src/cart.mjs', 'index 1111111..2222222 100644', '--- a/src/cart.mjs', '+++ b/src/cart.mjs', '@@ -2,2 +2,3 @@ export function addItem(cart, item) {', '-  cart.items.push(item);', '+  cart.items.push({ ...item });', '+  cart.count++;', '   return cart;', 'New file: docs/notes.md\n# Notes\n'].join('\n');
  // Sent: read into files once for each text, however often the pane is drawn.
  const first = glue.changes(row({ diff: { summary: '2 files · +3 −1', patch } }));
  assert.deepEqual([first.note, first.changes.files.map(file => [file.path, file.status, file.added, file.removed]), first.changes.added, first.changes.removed], [null, [['src/cart.mjs', 'modified', 2, 1], ['docs/notes.md', 'added', 1, 0]], 3, 1]);
  assert.equal(glue.changes(row({ diff: { summary: '2 files · +3 −1', patch: ` ${patch}`.slice(1) } })).changes, first.changes, 'the same text is not read again');
  assert.notEqual(glue.changes(row({ diff: { summary: '2 files · +4 −1', patch: `${patch}more\n` } })).changes, first.changes);
  // Its chat names them in one line and never holds the diff. A narrow pane leaves the key out.
  const parts = glue.parts(row({ diff: { summary: '2 files · +3 −1', patch } }), 80), named = parts.filter(part => part.key.startsWith('changes'));
  assert.deepEqual(named.map(part => part.text), ['Changes · 2 files · +3 −1 · d opens them']);
  assert.ok(parts.every(part => !/diff --git|@@|cart\.items|index 1111111/.test(part.text)));
  assert.deepEqual(glue.parts(row({ diff: { summary: '2 files · +3 −1', patch } }), 30).filter(part => part.key.startsWith('changes')).map(part => part.text), ['Changes · 2 files · +3 −1']);
  // Followed here with nothing changed, still arriving, or behind: a line says which.
  assert.deepEqual(glue.changes(row()), { changes: null, tone: 'muted', note: 'No changes yet.' });
  assert.equal(glue.changes(row({ diff: { summary: 'No changes', patch: '' } })).note, 'No changes yet.');
  assert.equal(glue.changes(row({ partialDiff: { summary: '9 files', patch: 'diff --git a/x b/x' } })).note, 'Its changes are arriving from @devbox…');
  assert.equal(glue.changes(row({ behind: true })).note, 'Catching up with @devbox…');
  assert.ok(!glue.parts(row(), 80).some(part => part.key.startsWith('changes')), 'no line in the chat without changes');
  assert.deepEqual(sent, []);
  // Not followed here yet: drawing the tab asks nothing, opening it asks at once, and once only while the answer is on its way.
  const waiting = row({}, { watched: false });
  assert.deepEqual(glue.changes(waiting), { changes: null, tone: 'muted', note: '@devbox has not sent its changes yet. Asking for them…' });
  assert.deepEqual(sent, []);
  glue.changes(waiting, { fetch: true });
  assert.deepEqual(sent, [{ type: 'remoteWatch', to: D, ref: 'p:1', cursor: true }], 'asked the moment the tab opens, with no wait for the cursor to rest');
  glue.changes(waiting, { fetch: true }); glue.parts(waiting, 80);
  assert.equal(sent.length, 1);
  // One that is followed is never asked for again, and an offline computer is not asked at all.
  glue.changes(row({ diff: { summary: '2 files · +3 −1', patch } }), { fetch: true });
  const away = row({}, { watched: false, online: false });
  assert.deepEqual(glue.changes(away, { fetch: true }), { changes: null, tone: 'muted', note: '@devbox is offline. Its changes show here once it is back.' });
  assert.equal(sent.length, 1);
  // A computer that refuses says why, in the tab.
  const refusing = make(async () => { throw new Error('@devbox: Not now.'); });
  refusing.changes(waiting, { fetch: true }); await pause(0);
  assert.deepEqual(refusing.changes(waiting), { changes: null, tone: 'orange', note: '@devbox: Not now.' });
});
