import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, git, autoApprove } from './helpers.mjs';
import { makeTeam, withHome, registeredProject, liveTask } from './peer-helpers.mjs';
import { ProjectController, taskPatch } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask, saveTask, taskDir } from '../lib/state.mjs';
import { stopLine } from '../lib/stop-line.mjs';
import { boardRows, remoteRow, rowActions, rowBadge, rowTitle } from '../lib/board.mjs';
import { committedLine, finished, movedLine, publishWords, restingMove, settleFinished, settleHead } from '../lib/task-head.mjs';
import { currentTask, reopenTask } from '../lib/plan.mjs';
import { findBin } from '../lib/util.mjs';
import { hostMethods, hostTick, listTick, relist, remoteCommand, remoteMachines, remoteSessions, viewMethods, viewTick } from '../lib/peer/remote.mjs';
import { remoteError } from '../lib/peer/failure.mjs';
import { otherSessions } from '../lib/peer/session-tools.mjs';
import { markMine, noteTheirs } from '../lib/peer/mine.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';

// A session whose agent commits its own work with Git, end to end against the stand-in
// Claude Code (commit in fake.json: once, twice, amend, branch, dirty, push).
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function setup(t, options = {}) {
  const p = project(t), fake = fakeClis(p.parent, options);
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  const turns = () => fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.vendor === 'claude' && call.args.includes('-p')).length : 0;
  return { ...p, fake, controller, repo: controller.repo, turns };
}
const NOW = Date.now() + 60000;
// The session's row in Sessions, as the list draws it.
const rowOf = (f, task) => boardRows([{ name: 'shop', root: f.root, activity: [], tasks: [task], queue: [] }], NOW)[0];
const files = (f, id) => taskPatch(f.repo, id).files.map(file => file.path).sort();
// The subject of the newest commit there: the agent's own, never one ELU made.
const subject = task => git(task.worktree, ['log', '-1', '--format=%s']);

for (const [commit, changed, commits] of [['once', ['src/coupon.mjs'], 1], ['twice', ['notes.md', 'src/coupon.mjs'], 2], ['amend', ['notes.md', 'src/coupon.mjs'], 1], ['branch', ['src/coupon.mjs'], 1], ['dirty', ['notes.md', 'src/coupon.mjs'], 1]]) {
  test(`a Full access turn that commits its own work (${commit}) ends as any turn does: checked, with no error and nothing to type`, async t => {
    const f = setup(t, { commit });
    const task = await f.controller.ask('Normalize coupon codes', undefined, { permissions: 'full' }).finished;
    assert.equal(task.error ?? null, null, task.error?.message);
    // The project's checks ran on the real change and passed.
    assert.equal(task.state, 'ready');
    assert.ok(task.evidence.results.some(row => row.name === 'test' && row.status === 'passed') || task.evidence.results.every(row => row.status !== 'failed'), JSON.stringify(task.evidence.results));
    // The agent's commit is the session's: the record is at the folder's HEAD.
    const head = git(task.worktree, ['rev-parse', 'HEAD']);
    assert.match(subject(task), /^(Normalize coupons|Add notes|Normalize coupons, with notes)$/); assert.notEqual(head, task.base);
    assert.equal(git(task.worktree, ['rev-list', '--count', `${task.base}..HEAD`]), String(commits));
    assert.equal(readTask(f.repo, task.id).commit, head);
    assert.equal(stopLine(task), null);
    const row = rowOf(f, task);
    assert.deepEqual([rowBadge(row, NOW).icon, rowBadge(row, NOW).tone], ['✓', 'green']);
    assert.doesNotMatch(rowTitle(row, NOW), /continue/);
    // Changes shows the whole change against the base, commits included.
    assert.deepEqual(files(f, task.id), changed);
  });
}

test('with no checks in the project, a turn that commits all of its work has finished: no !, no retry, no continue', async t => {
  const f = setup(t, { commit: 'once' }); f.controller.draftConfig.checks = [];
  const task = await f.controller.ask('Normalize coupon codes', undefined, { permissions: 'full' }).finished;
  assert.equal(task.error ?? null, null, task.error?.message); assert.equal(task.state, 'unverified');
  assert.equal(stopLine(task), null);
  const row = rowOf(f, task), badge = rowBadge(row, NOW);
  assert.deepEqual([badge.icon, badge.tone, badge.title], ['✓', 'green', 'committed']);
  assert.equal(rowTitle(row, NOW), row.task.title ?? rowTitle(row, NOW)); assert.doesNotMatch(rowTitle(row, NOW), /continue/);
  assert.ok(!rowActions(row).some(([, name]) => name === 'retry'), JSON.stringify(rowActions(row)));
  assert.doesNotMatch(row.now, /not verified|continue/);
});

test('the same holds below Full access when the commit was let through, and a message to the finished session runs one turn that ends the same way', async t => {
  const f = setup(t, { commit: 'once' });
  const task = await f.controller.ask('Normalize coupon codes').finished;
  assert.notEqual(task.permissions, 'full'); assert.equal(task.error ?? null, null, task.error?.message); assert.equal(task.state, 'ready');
  assert.equal(readTask(f.repo, task.id).commit, git(task.worktree, ['rev-parse', 'HEAD']));
  const turns = f.turns(), again = await f.controller.ask('continue', task.id).finished;
  assert.equal(again.error ?? null, null, again.error?.message); assert.ok(f.turns() > turns, 'continue ran a turn');
  assert.equal(stopLine(again), null); assert.ok(['ready', 'unverified', 'answered'].includes(again.state), again.state);
  assert.equal(readTask(f.repo, task.id).commit, git(task.worktree, ['rev-parse', 'HEAD']));
});

// What a session that is ready says of publishing it, in the status line and under its chat:
// pushed, by the agent or by /publish, with the pull request ELU knows; else what /publish does.
test('a ready session says pushed once its work is pushed, with its pull request when there is one, else what /publish does', () => {
  const PR_URL = 'https://github.com/example/sample/pull/7';
  assert.equal(publishWords({ state: 'ready', commit: 'abc', committed: { branch: 'feat/task-1', clean: true, pushed: false } }), '/publish to review push');
  assert.equal(publishWords({ state: 'ready', commit: 'abc' }), '/publish to review push');
  assert.equal(publishWords({ state: 'ready', commit: 'abc', committed: { branch: 'feat/task-1', clean: true, pushed: true } }), 'pushed · /publish opens a draft pull request');
  assert.equal(publishWords({ state: 'ready', commit: 'abc', committed: { branch: 'feat/task-1', clean: true, pushed: true }, pr: PR_URL }), `pushed · ${PR_URL}`);
  assert.equal(publishWords({ state: 'ready', commit: 'abc', pushedCommit: 'abc', pr: PR_URL }), `pushed · ${PR_URL}`, 'pushed by /publish');
  assert.equal(publishWords({ state: 'ready', commit: 'def', pushedCommit: 'abc', pr: PR_URL }), '/publish to review push', 'a commit on top is not pushed yet');
});

test('the session says where its committed work is: the branch, the commit, and whether it is pushed or something is left uncommitted', async t => {
  // Pushed by the agent itself, to a remote the folder knows.
  const f = setup(t, { commit: 'push' }); f.controller.draftConfig.checks = [];
  const bare = path.join(f.parent, 'origin.git'); git(f.parent, ['init', '--bare', '--initial-branch=main', bare]); git(f.root, ['remote', 'add', 'origin', bare]);
  const pushed = await f.controller.ask('Normalize coupon codes', undefined, { permissions: 'full' }).finished, head = git(pushed.worktree, ['rev-parse', 'HEAD']);
  assert.equal(pushed.error ?? null, null, pushed.error?.message);
  assert.deepEqual(pushed.committed, { branch: 'feat/task-1', clean: true, pushed: true });
  assert.equal(git(bare, ['rev-parse', 'refs/heads/feat/task-1']), head, 'the agent pushed it');
  assert.equal(committedLine(pushed), `Committed on feat/task-1 at ${head.slice(0, 7)} and pushed.`); assert.equal(finished(pushed), true);
  // Committed on a branch of its own, not pushed.
  const g = setup(t, { commit: 'branch' }); g.controller.draftConfig.checks = [];
  const own = await g.controller.ask('Normalize coupon codes', undefined, { permissions: 'full' }).finished;
  assert.equal(committedLine(own), `Committed on agent/coupons at ${git(own.worktree, ['rev-parse', 'HEAD']).slice(0, 7)}, not pushed. /publish pushes it and opens a draft pull request.`);
  assert.equal(finished(own), true); assert.equal(taskPatch(g.repo, own.id).branch, 'agent/coupons');
  // Something left uncommitted: edits that are not verified, as after any editing turn. Still nothing to type.
  const h = setup(t, { commit: 'dirty' }); h.controller.draftConfig.checks = [];
  const dirty = await h.controller.ask('Normalize coupon codes', undefined, { permissions: 'full' }).finished;
  assert.equal(dirty.error ?? null, null); assert.equal(dirty.state, 'unverified'); assert.equal(finished(dirty), false); assert.equal(stopLine(dirty), null);
  assert.equal(committedLine(dirty), `Committed on feat/task-1 at ${git(dirty.worktree, ['rev-parse', 'HEAD']).slice(0, 7)}. Some edits are not committed: /changes shows them.`);
  assert.equal(rowBadge(rowOf(h, dirty), NOW).title, 'not verified');
});

// ---- A HEAD that moved while nothing ran ----

test('a commit made in the session\'s workspace while nothing ran is a notice that names it; the checks and continue go on from it', async t => {
  const f = setup(t); f.controller.draftConfig.checks = [];
  const task = await f.controller.ask('Normalize coupon codes', undefined, { permissions: 'full' }).finished;
  assert.equal(task.state, 'unverified'); assert.equal(movedLine(task), null); assert.equal(restingMove(task, NOW), null);
  // The owner commits there by hand.
  git(task.worktree, ['add', '-A']); git(task.worktree, ['commit', '-m', 'By hand']);
  const moved = git(task.worktree, ['rev-parse', 'HEAD']), line = `feat/task-1 moved outside this session: 1 new commit, now at ${moved.slice(0, 7)}.`;
  const resting = readTask(f.repo, task.id);
  assert.equal(resting.error ?? null, null); assert.equal(stopLine(resting), null, 'it is not a stop');
  assert.equal(movedLine(resting), line); assert.equal(restingMove(resting, NOW + 5000), `${line} Type continue to go on from there.`);
  // The checks take it in and run; they refuse nothing.
  const result = await f.controller.verify(task.id, ['node', '--test']);
  assert.ok(result.results.every(row => row.status !== 'failed'), JSON.stringify(result.results));
  const checked = readTask(f.repo, task.id);
  assert.equal(checked.commit, moved); assert.equal(checked.error ?? null, null);
  assert.deepEqual(checked.messages.filter(row => row.from === 'ELU' && /moved outside/.test(row.text)).map(row => row.text), [`${line} The session goes on from there.`]);
  assert.equal(movedLine(checked), null); assert.equal(restingMove(checked, NOW + 10000), null, 'settled: the notice is gone');
  // Moved again, somewhere that is not ahead: said as where it is and where it was. Continue goes on from it.
  git(task.worktree, ['commit', '--amend', '-m', 'By hand, reworded']);
  const amended = git(task.worktree, ['rev-parse', 'HEAD']);
  assert.equal(movedLine(readTask(f.repo, task.id)), `feat/task-1 moved outside this session: now at ${amended.slice(0, 7)}, was at ${moved.slice(0, 7)}.`);
  const turns = f.turns(), again = await f.controller.ask('continue', task.id).finished;
  assert.ok(f.turns() > turns); assert.equal(again.error ?? null, null, again.error?.message); assert.equal(stopLine(again), null);
  assert.equal(readTask(f.repo, task.id).commit, git(task.worktree, ['rev-parse', 'HEAD']));
  assert.equal(again.messages.filter(row => row.from === 'ELU' && /moved outside/.test(row.text)).length, 2);
  assert.equal(movedLine(readTask(f.repo, task.id)), null);
});

// ---- Sessions an earlier version left stopped ----

// What 0.1.19 and 0.1.20 saved when the agent had committed its own work.
const OLD_ERROR = { message: 'Your edits are kept, but the checks and review could not go on: the task worktree HEAD changed outside ELU. Type continue to try again.', detail: 'The task worktree HEAD changed outside ELU.' };
const raw = (f, id) => JSON.parse(fs.readFileSync(path.join(taskDir(f.repo, id), 'task.json'), 'utf8'));
// The session as that version left it: no commit of its own on record, the refusal as its error, its Task still open.
function asSavedBefore(f, id, state = 'unverified') {
  const { commit: _commit, committed: _committed, ...old } = readTask(f.repo, id);
  saveTask(f.repo, { ...old, state, error: OLD_ERROR }); reopenTask(f.repo, id);
  assert.match(raw(f, id).error.message, /Type continue to try again/);
}

test('a session an earlier version left stopped on its own commit reads as finished at once, and the app settles it with no turn and no message', async t => {
  const f = setup(t, { commit: 'once' }); f.controller.draftConfig.checks = [];
  const done = await f.controller.ask('Normalize coupon codes', undefined, { permissions: 'full' }).finished, head = git(done.worktree, ['rev-parse', 'HEAD']), turns = f.turns();
  asSavedBefore(f, done.id);
  // Read: finished, with its answer, no error. Nothing is written for that.
  const read = readTask(f.repo, done.id);
  assert.equal(read.state, 'unverified'); assert.equal(read.error, null); assert.equal(stopLine(read), null); assert.equal(finished(read), true);
  assert.equal(read.result.summary, done.result.summary, 'its last answer is kept');
  const row = rowOf(f, read);
  assert.deepEqual([rowBadge(row, NOW).icon, rowBadge(row, NOW).title], ['✓', 'committed']); assert.doesNotMatch(`${rowTitle(row, NOW)} ${row.now}`, /continue|not verified/);
  assert.ok(raw(f, done.id).error, 'reading alone leaves the file');
  // The app reads it (its start, and every look after): its commit is taken in and its Task closed, once.
  const shown = f.controller.snapshot().tasks.find(task => task.id === done.id);
  assert.equal(shown.commit, head); assert.deepEqual(shown.committed, { branch: 'feat/task-1', clean: true, pushed: false }); assert.equal(shown.error, null);
  const saved = raw(f, done.id);
  assert.equal(saved.error, null); assert.equal(saved.state, 'unverified'); assert.equal(saved.commit, head);
  assert.equal(currentTask(f.repo, done.id).state, 'done', 'its Task is closed');
  assert.equal(f.turns(), turns, 'no turn ran'); assert.equal(saved.messages.length, done.messages.length, 'and no message was added');
  assert.equal(settleFinished(f.repo, done.id), false, 'settled once');
  // One that was saved as blocked for the same reason heals the same way.
  asSavedBefore(f, done.id, 'blocked');
  assert.deepEqual([readTask(f.repo, done.id).state, readTask(f.repo, done.id).error], ['unverified', null]);
  // A session that stopped for any other reason keeps it.
  saveTask(f.repo, { ...readTask(f.repo, done.id), state: 'unverified', committed: undefined, error: { message: 'Your edits are kept, but the checks and review could not go on: the pinned task policy changed. Type continue to try again.', detail: 'The pinned task policy changed.' } });
  const other = readTask(f.repo, done.id);
  assert.match(other.error.message, /pinned task policy/); assert.ok(stopLine(other), 'it still waits, with its own reason');
});

test('one with edits left uncommitted heals to edits that are not verified: no error, nothing to type', async t => {
  const f = setup(t, { commit: 'dirty' }); f.controller.draftConfig.checks = [];
  const done = await f.controller.ask('Normalize coupon codes', undefined, { permissions: 'full' }).finished;
  asSavedBefore(f, done.id);
  assert.equal(settleFinished(f.repo, done.id), true);
  const healed = readTask(f.repo, done.id);
  assert.equal(healed.error, null); assert.equal(healed.committed.clean, false); assert.equal(stopLine(healed), null);
  assert.equal(rowBadge(rowOf(f, healed), NOW).title, 'not verified');
});

// ---- The owner's other computer ----

// A connection as the daemon hands it to a method, and two computers of one owner joined by
// calls: the devbox hosts a project, the laptop lists and follows its sessions.
function connection(key) {
  const sent = [];
  return { key, admitted: true, remoteHello: { remote: 1 }, sent, notify: (method, params) => sent.push([method, params]), request: async () => { throw new Error('No answer'); } };
}
const context = (me, sessions = {}) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
function pair(t) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), laptop = team.founder, devbox = team.member;
  const shop = withHome(devbox.home, () => { const shop = registeredProject(t, { origin: 'https://github.com/acme/shop.git' }); saveTeamAccess(team.teamId, { root: shop.root }); markMine(devbox.identity.key, laptop.identity.key); noteTheirs(laptop.identity.key, true); return shop; });
  withHome(laptop.home, () => { markMine(laptop.identity.key, devbox.identity.key); noteTheirs(devbox.identity.key, true); });
  const toHost = connection(laptop.identity.key), toViewer = connection(devbox.identity.key);
  const hostCtx = context(devbox.identity, { [laptop.identity.key]: toHost }), viewCtx = context(laptop.identity, { [devbox.identity.key]: toViewer });
  const host = hostMethods(hostCtx), viewer = viewMethods(viewCtx);
  // older: the devbox answers as a version from before this did, when the test says so.
  const link = { older: null };
  toViewer.request = async (method, params) => { const answer = await withHome(devbox.home, () => host[method](params, toHost)); return link.older ? link.older(method, answer) : answer; };
  return { laptop, devbox, shop, toHost, hostCtx, viewCtx, host, viewer, link };
}
// Three sessions on the devbox: one whose agent committed all of its work, one that an earlier
// version left stopped on such a commit, and one that is blocked for a reason of its own.
function hosted(p) {
  return withHome(p.devbox.home, () => {
    const at = new Date().toISOString(), rest = { responses: [], mode: 'automatic', permissions: 'full', result: { outcome: 'completed', summary: 'Coupons are upper case now.' }, activeRole: null };
    const committed = (id, goal, extra) => {
      const live = liveTask(p.shop.root, { id, goal, state: 'unverified', activeRole: null });
      git(live.worktree, ['add', '-A']); git(live.worktree, ['commit', '-m', goal]);
      saveTask(live.repo, { ...readTask(live.repo, id), ...rest, messages: [{ at, text: goal }], ...extra(git(live.worktree, ['rev-parse', 'HEAD'])) });
      return live;
    };
    committed('1', 'Normalize coupons', head => ({ commit: head, committed: { branch: 'feat/task-1', clean: true, pushed: true } }));
    committed('2', 'Trim coupon codes', () => ({ error: OLD_ERROR }));
    const live = liveTask(p.shop.root, { id: '3', goal: 'Sort the coupons', state: 'blocked', activeRole: null });
    saveTask(live.repo, { ...readTask(live.repo, '3'), ...rest, result: null, messages: [{ at, text: 'Sort the coupons' }], error: { message: 'Claude could not finish.', cause: 'auth' }, runs: [{ role: 'lead', vendor: 'claude', at }] });
    relist();
    // What a version up to 0.1.20 sent for the second one.
    return remoteError({ ...readTask(live.repo, '3'), state: 'unverified', error: OLD_ERROR, runs: [] });
  });
}
const shownRow = (session, now = Date.now()) => { const row = remoteRow({ ...session, machine: 'b'.repeat(64), lastAt: session.at, approvals: session.approvals ?? [], steps: [], entries: [] }, 'box', now); return { row, badge: rowBadge(row, now), title: rowTitle({ ...row, grouped: true }, now) }; };

test('my other computer lists a session that committed its own work as finished, one an earlier version stopped there too, and a blocked one keeps its reason', async t => {
  const p = pair(t), sentBefore = hosted(p);
  assert.match(sentBefore, /HEAD changed outside ELU.*Send it again\.$/, sentBefore);
  // What the devbox sends now.
  const listed = withHome(p.devbox.home, () => p.host['elu.remote.list']({}, p.toHost)), by = title => listed.sessions.find(row => row.title === title);
  assert.deepEqual([by('Normalize coupons').state, by('Normalize coupons').finished, by('Normalize coupons').error], ['unverified', true, null]);
  assert.deepEqual([by('Trim coupon codes').state, by('Trim coupon codes').finished, by('Trim coupon codes').error], ['unverified', true, null], 'the one saved by an earlier version');
  assert.equal(by('Sort the coupons').state, 'blocked'); assert.equal(by('Sort the coupons').finished, undefined);
  assert.match(by('Sort the coupons').error, /signed out.*send it again\.$/i);
  // The laptop lists them.
  await withHome(p.laptop.home, () => listTick(p.viewCtx));
  const here = () => withHome(p.laptop.home, () => remoteMachines()[0].sessions), at = title => shownRow(here().find(row => row.title === title));
  for (const title of ['Normalize coupons', 'Trim coupon codes']) {
    const shown = at(title);
    assert.deepEqual([shown.badge.icon, shown.badge.tone, shown.badge.title], ['✓', 'green', 'on box · committed'], title);
    assert.equal(shown.title, title, 'its name alone: nothing to send again'); assert.equal(shown.row.group, 3);
  }
  const blocked = at('Sort the coupons');
  assert.deepEqual([blocked.badge.icon, blocked.badge.title], ['✗', 'on box · blocked']); assert.match(blocked.title, /^Sort the coupons · sign Claude Code in$/i);
  // An agent here that asks what runs on my other computer is told the same.
  const told = withHome(p.laptop.home, () => otherSessions()).computers[0].sessions;
  assert.deepEqual(told.map(row => [row.title, row.state]).sort(), [['Normalize coupons', 'committed'], ['Sort the coupons', 'blocked'], ['Trim coupon codes', 'committed']]);
});

test('a computer of mine on a version from before sends the refusal as an error: here that session is finished, never one to send again', async t => {
  const p = pair(t), sentBefore = hosted(p);
  // The devbox answers as 0.1.19 did: no finished mark, the refusal as the error of the session it stopped.
  p.link.older = (method, answer) => method !== 'elu.remote.list' ? answer : { ...answer, sessions: answer.sessions.map(({ finished: _finished, ...row }) => row.title === 'Trim coupon codes' ? { ...row, state: 'unverified', error: sentBefore } : row.title === 'Normalize coupons' ? { ...row, state: 'unverified', error: sentBefore } : row) };
  await withHome(p.laptop.home, () => listTick(p.viewCtx));
  const sessions = withHome(p.laptop.home, () => remoteMachines()[0].sessions);
  for (const title of ['Normalize coupons', 'Trim coupon codes']) {
    const session = sessions.find(row => row.title === title), shown = shownRow(session);
    assert.deepEqual([session.state, session.error, session.finished], ['unverified', null, true], title);
    assert.deepEqual([shown.badge.icon, shown.badge.title], ['✓', 'on box · committed']); assert.doesNotMatch(`${shown.title} ${shown.row.now}`, /send it again|HEAD changed/i);
  }
  const blocked = sessions.find(row => row.title === 'Sort the coupons');
  assert.equal(blocked.state, 'blocked'); assert.match(blocked.error, /signed out/i, 'a real reason is kept');
});

test('a session followed from my other computer shows there as finished when its state arrives, from this version and from one before', async t => {
  const p = pair(t), sentBefore = hosted(p);
  await withHome(p.laptop.home, () => listTick(p.viewCtx));
  const item = withHome(p.laptop.home, () => remoteMachines()[0].sessions.find(row => row.title === 'Trim coupon codes'));
  await withHome(p.laptop.home, () => remoteCommand(p.viewCtx, { type: 'remoteWatch', to: p.devbox.identity.key, ref: item.ref }));
  withHome(p.devbox.home, () => hostTick(p.hostCtx));
  const pushed = p.toHost.sent.filter(([method]) => method === 'elu.remote.events').at(-1)[1], mine = pushed.items.find(row => row.id === item.id), state = mine.events.find(event => event.type === 'state');
  assert.deepEqual([state.state, state.finished, state.error], ['unverified', true, null]);
  const seen = () => withHome(p.laptop.home, () => remoteSessions().find(row => row.id === item.id));
  const take = events => withHome(p.laptop.home, () => p.viewer['elu.remote.events'](events, connection(p.devbox.identity.key)));
  take(pushed); await withHome(p.laptop.home, () => viewTick(p.viewCtx));
  assert.deepEqual([seen().state, seen().finished, seen().error], ['unverified', true, null]);
  // The same state as a version from before sent it: its error is the refusal.
  const { finished: _finished, ...before } = state, next = seen().seq + 1;
  take({ items: [{ id: item.id, events: [{ ...before, seq: next, error: sentBefore }], last: next }] });
  assert.equal(seen().seq, next, 'the state from before was taken');
  assert.deepEqual([seen().state, seen().finished, seen().error], ['unverified', true, null]);
  // A real reason arrives as it is.
  take({ items: [{ id: item.id, events: [{ ...before, seq: next + 1, state: 'blocked', error: 'Claude could not finish: Claude Code is signed out. Sign Claude Code in on @box, then send it again.' }], last: next + 1 }] });
  assert.deepEqual([seen().state, seen().finished], ['blocked', undefined]); assert.match(seen().error, /signed out/);
  take({ items: [{ id: item.id, events: [{ ...before, seq: next + 2, error: sentBefore }], last: next + 2 }] });
  const shown = shownRow({ ...seen(), at: seen().lastAt ?? seen().createdAt });
  assert.deepEqual([shown.badge.icon, shown.badge.title], ['✓', 'on box · committed']); assert.doesNotMatch(shown.title, /send it again/i);
});

// ---- /publish ----

// origin on GitHub, a git that records each push in place of sending it, and a gh that
// answers from a file: prs is what the branch has there, view is the pull request after a push.
function publishing(f, there = {}) {
  git(f.root, ['remote', 'add', 'origin', 'https://github.com/example/sample.git']);
  const actual = findBin('git'), calls = path.join(f.parent, 'publication.jsonl'), state = path.join(f.parent, 'gh.json'), set = value => fs.writeFileSync(state, JSON.stringify({ prs: [], view: null, ...value }));
  set(there);
  fs.writeFileSync(path.join(f.fake.dir, 'git'), `#!${process.execPath}\nimport fs from 'node:fs';import {spawnSync} from 'node:child_process';const args=process.argv.slice(2);if(args.includes('push')){fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({kind:'push',args})+'\\n');process.exit(0);}const r=spawnSync(${JSON.stringify(actual)},args,{stdio:'inherit'});process.exit(r.status??1);\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(f.fake.dir, 'gh'), `#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({kind:'gh',args})+'\\n');const state=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8'));if(args[0]==='repo')console.log(JSON.stringify({nameWithOwner:'example/sample',defaultBranchRef:{name:'main'},url:'https://github.com/example/sample'}));else if(args[1]==='list')console.log(JSON.stringify(state.prs));else if(args[1]==='view')console.log(JSON.stringify(state.view));\n`, { mode: 0o755 });
  const all = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { set, pushes: () => all().filter(call => call.kind === 'push').map(call => call.args.at(-1)), gh: () => all().filter(call => call.kind === 'gh').map(call => call.args) };
}
const PR = 'https://github.com/example/sample/pull/12';
const pr = (head, extra = {}) => ({ number: 12, state: 'OPEN', headRefName: 'feat/task-1', baseRefName: 'main', isDraft: false, url: PR, headRefOid: head, ...extra });

for (const [commit, branch] of [['once', 'feat/task-1'], ['twice', 'feat/task-1'], ['amend', 'feat/task-1'], ['branch', 'agent/coupons']]) {
  test(`/publish after the agent committed (${commit}) pushes what is there, on the branch it is on, and opens a draft pull request`, async t => {
    const f = setup(t, { commit });
    const task = await f.controller.ask('Normalize coupon codes', undefined, { permissions: 'full' }).finished, head = git(task.worktree, ['rev-parse', 'HEAD']);
    const there = publishing(f);
    assert.equal(f.controller.published(task.id), null, 'nothing of it is on GitHub yet');
    const plan = await f.controller.pushPlan(task.id);
    assert.equal(plan.needsConfirmation, true); assert.equal(plan.commit, head, 'the commit the agent made, as it is'); assert.equal(plan.destination.ref, `refs/heads/${branch}`);
    assert.equal(git(task.worktree, ['rev-parse', 'HEAD']), head, 'ELU committed nothing on top');
    there.set({ view: { url: 'https://github.com/example/sample/pull/7', isDraft: true, headRefOid: head } });
    const done = await f.controller.push(task.id, plan.confirmationId);
    assert.deepEqual([done.pushed, done.pr, done.commit], [true, 'https://github.com/example/sample/pull/7', head]);
    assert.deepEqual(there.pushes(), [`${head}:refs/heads/${branch}`]);
    assert.equal(committedLine(readTask(f.repo, task.id)), `Committed on ${branch} at ${head.slice(0, 7)} and pushed. Pull request: https://github.com/example/sample/pull/7`, 'what /publish pushed reads as pushed, with its pull request');
    const created = there.gh().find(args => args[1] === 'create');
    assert.ok(created.includes('--draft')); assert.equal(created[created.indexOf('--head') + 1], branch);
  });
}

test('/publish commits what the agent left uncommitted on top of its commit, then pushes both', async t => {
  const f = setup(t, { commit: 'dirty' });
  const task = await f.controller.ask('Normalize coupon codes', undefined, { permissions: 'full' }).finished, head = git(task.worktree, ['rev-parse', 'HEAD']);
  const there = publishing(f), plan = await f.controller.pushPlan(task.id);
  assert.notEqual(plan.commit, head); assert.equal(git(task.worktree, ['rev-parse', `${plan.commit}^`]), head, "on top of the agent's commit");
  assert.deepEqual(git(task.worktree, ['show', '--name-only', '--format=', plan.commit]).split('\n'), ['notes.md']);
  there.set({ view: { url: 'https://github.com/example/sample/pull/7', isDraft: true, headRefOid: plan.commit } });
  await f.controller.push(task.id, plan.confirmationId);
  assert.deepEqual(there.pushes(), [`${plan.commit}:refs/heads/feat/task-1`]);
});

test('/publish on a branch the agent pushed, with a pull request open for it, says so and names the pull request: nothing is pushed, checked or refused', async t => {
  // No checks in the project: the session is not verified, and /publish would ask for a check first.
  const f = setup(t, { commit: 'once' }); f.controller.draftConfig.checks = [];
  const task = await f.controller.ask('Normalize coupon codes', undefined, { permissions: 'full' }).finished, head = git(task.worktree, ['rev-parse', 'HEAD']);
  assert.equal(task.state, 'unverified');
  const there = publishing(f, { prs: [pr(head)] }), said = `Already pushed: feat/task-1 at ${head.slice(0, 7)}. Pull request (open): ${PR}`;
  const found = f.controller.published(task.id);
  assert.deepEqual([found.published, found.pr, found.state, found.message], [true, PR, 'open', said]);
  const plan = await f.controller.pushPlan(task.id);
  assert.deepEqual([plan.published, plan.needsConfirmation, plan.message], [true, false, said]);
  assert.deepEqual(there.pushes(), []); assert.ok(!there.gh().some(args => ['create', 'edit'].includes(args[1])));
  const saved = readTask(f.repo, task.id);
  assert.equal(saved.pr, PR); assert.equal(saved.pushedCommit, undefined, 'the session can still go on');
  // GitHub holds the commit: the session says pushed, with the pull request, and keeps saying so.
  const line = `Committed on feat/task-1 at ${head.slice(0, 7)} and pushed. Pull request: ${PR}`;
  assert.equal(committedLine(saved), line); settleHead(f.repo, saved); assert.equal(committedLine(readTask(f.repo, task.id)), line);
  // A commit on top of it is not pushed yet, and /publish has a pull request to push it to.
  fs.writeFileSync(path.join(task.worktree, 'more.md'), 'More.\n'); git(task.worktree, ['add', 'more.md']); git(task.worktree, ['commit', '-m', 'Add more']);
  const next = readTask(f.repo, task.id); settleHead(f.repo, next);
  assert.equal(committedLine(next), `Committed on feat/task-1 at ${git(task.worktree, ['rev-parse', 'HEAD']).slice(0, 7)}, not pushed. /publish pushes it.`);
  git(task.worktree, ['reset', '--hard', head]); settleHead(f.repo, next);
  // A draft, a merged one and a closed one are named as what they are.
  there.set({ prs: [pr(head, { isDraft: true })] }); assert.match(f.controller.published(task.id).message, /Pull request \(draft\): /);
  there.set({ prs: [pr(head, { state: 'MERGED' })] }); assert.match(f.controller.published(task.id).message, /Pull request \(merged\): /);
  there.set({ prs: [pr(head, { state: 'CLOSED' })] }); assert.match(f.controller.published(task.id).message, /Pull request \(closed\): /);
  // A pull request at an older commit is not this work: there is something to publish.
  there.set({ prs: [pr(task.base)] }); assert.equal(f.controller.published(task.id), null);
  // With no gh that answers, nothing is claimed.
  fs.writeFileSync(path.join(f.fake.dir, 'gh'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
  assert.equal(f.controller.published(task.id), null);
});

test('in Full access /publish pushes to the pull request the agent opened, draft or not, and leaves its text alone; below it the refusal stays', async t => {
  const f = setup(t, { commit: 'once' });
  const task = await f.controller.ask('Normalize coupon codes', undefined, { permissions: 'full' }).finished, head = git(task.worktree, ['rev-parse', 'HEAD']);
  // The agent opened a pull request earlier, not a draft; the branch there is behind what is here.
  const there = publishing(f, { prs: [pr(task.base), pr(task.base, { number: 3, state: 'MERGED', url: 'https://github.com/example/sample/pull/3' })] });
  const plan = await f.controller.pushPlan(task.id);
  assert.equal(plan.destination.existingPr.number, 12);
  there.set({ prs: [pr(task.base), pr(task.base, { number: 3, state: 'MERGED', url: 'https://github.com/example/sample/pull/3' })], view: { url: PR, isDraft: false, headRefOid: head } });
  const done = await f.controller.push(task.id, plan.confirmationId);
  assert.equal(done.pr, PR); assert.deepEqual(there.pushes(), [`${head}:refs/heads/feat/task-1`]);
  assert.ok(!there.gh().some(args => ['create', 'edit'].includes(args[1])), 'its text and its state are the agent\'s');
  assert.ok(there.gh().some(args => args[1] === 'view' && args[2] === '12'));
  // Below Full access a pull request that is not a draft is not pushed to.
  const g = setup(t, { commit: 'once' });
  const lower = await g.controller.ask('Normalize coupon codes').finished;
  const guarded = publishing(g, { prs: [pr(lower.base)] });
  await assert.rejects(() => g.controller.pushPlan(lower.id), /closed, merged, non-draft, or incompatible pull request/);
  assert.deepEqual(guarded.pushes(), []);
});

test('/publish goes on from a commit made outside the session, with the line that names it', async t => {
  const f = setup(t);
  const task = await f.controller.ask('Normalize coupon codes', undefined, { permissions: 'full' }).finished;
  assert.equal(task.state, 'ready');
  git(task.worktree, ['add', '-A']); git(task.worktree, ['commit', '-m', 'By hand']);
  const moved = git(task.worktree, ['rev-parse', 'HEAD']), there = publishing(f);
  const plan = await f.controller.pushPlan(task.id);
  assert.equal(plan.commit, moved); assert.deepEqual(there.pushes(), []);
  assert.ok(readTask(f.repo, task.id).messages.some(row => row.from === 'ELU' && row.text === `feat/task-1 moved outside this session: 1 new commit, now at ${moved.slice(0, 7)}. The session goes on from there.`));
});
