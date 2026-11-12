import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeTeam, withHome, registeredProject, liveTask } from './peer-helpers.mjs';
import { bothMine, dropStrangers, markMine, markedMine, mineRows, noteTheirs, unmarkMine } from '../lib/peer/mine.mjs';
import { NOT_MINE, UPDATE, hostMethods, hostTick, remoteCommand, remoteConnected, remoteSessions, viewMethods, viewTick } from '../lib/peer/remote.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { leaveOp, merge } from '../lib/peer/roster.mjs';
import { createInvite } from '../lib/peer/invite.mjs';
import { pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { requestApproval, pendingApprovals } from '../lib/approvals.mjs';
import { enqueue } from '../lib/conductor.mjs';
import { boardRows, remoteRow, rowActions, rowTitle } from '../lib/board.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';
import { teamPath } from '../lib/peer/roster.mjs';

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
const METHODS = ['elu.remote.start', 'elu.remote.send', 'elu.remote.stop', 'elu.remote.answer', 'elu.remote.task', 'elu.remote.since'];
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
    // No project chosen for the team yet: said plainly.
    assert.throws(() => methods['elu.remote.start'](START, from), /This computer has no project for the team yet\. On it, open the project in ELU Code and run \/access there/);
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
  assert.deepEqual(rowActions(running), [['enter', 'open'], ['s', 'stop']]);
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
  const status = { key: 'k'.repeat(64), teams: [{ members: [{ key: 'k'.repeat(64), name: 'ana' }, { key: 'd'.repeat(64), name: 'ana', box: 'devbox', online: true }, { key: 'e'.repeat(64), name: 'kim', box: 'kims-mac', online: true }] }] };
  const commands = [], facade = { mineRows: () => [{ key: 'd'.repeat(64), mine: true, theirs: true }], remoteSessions: () => [] };
  const glue = remoteGlue({ facade, peerRead: () => status, peerCommand: async command => { commands.push(command); return command.type === 'remoteStart' ? { id: START.id, project: 'shop' } : command.type === 'mine' ? { both: false, older: false } : { answered: true }; }, chatMessage: ({ text }) => text, ink: text => text, colour: false });
  assert.equal(glue.named('@devbox').key, 'd'.repeat(64));
  assert.equal(glue.named('@DevBox').key, 'd'.repeat(64), 'any case');
  assert.equal(glue.named('@kim'), null, 'a teammate who is not mine is asked a question as before');
  assert.equal(glue.named('@kims-mac'), null);
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
  assert.equal(await glue.mine(['@devbox']), 'Waiting for @devbox to mark this machine too.');
  await assert.rejects(glue.mine(['@nobody']), { message: "No teammate's computer is called @nobody." });
});
