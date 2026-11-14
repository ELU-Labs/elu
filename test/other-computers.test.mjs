import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis } from './helpers.mjs';
import { makeTeam, newHome, withHome, registeredProject } from './peer-helpers.mjs';
import { registerProject } from '../lib/projects.mjs';
import { Conductor, enqueue } from '../lib/conductor.mjs';
import { stopLine } from '../lib/stop-line.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { createTeam, merge, readLog } from '../lib/peer/roster.mjs';
import { createInvite, redeemCode } from '../lib/peer/invite.mjs';
import { intakeMethods } from '../lib/peer/intake.mjs';
import { processOutbox, syncRecords } from '../lib/peer/replies.mjs';
import { records } from '../lib/peer/taskstore.mjs';
import { applyTask, createAsk, getAsk, reconnect, tickAsks } from '../lib/peer/asks.mjs';
import { peerItems } from '../lib/peer/index.mjs';
import { peerCli } from '../lib/peer/cli.mjs';
import * as visuals from '../lib/terminal-visuals.mjs';
import { yourComputer } from '../lib/terminal-commands.mjs';

const { clockTime, teamPanes, visible } = visuals, sentState = (...args) => visuals.sentState(...args);
import { markMine, mineRows, noteTheirs } from '../lib/peer/mine.mjs';
import { hostMethods, listTick, relist, remoteMachines, remoteSessions, viewMethods } from '../lib/peer/remote.mjs';
import { repository } from '../lib/git.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { requestApproval, pendingApprovals } from '../lib/approvals.mjs';
import { boardRows, remoteRow } from '../lib/board.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';
import { saveTask, taskTitle } from '../lib/state.mjs';
import { projectSnapshot } from '../lib/projects.mjs';

// A connection as the daemon hands it to a method, recording what is sent to it.
function connection(key) {
  const sent = [];
  return { key, admitted: true, remoteHello: { remote: 1 }, sent, notify: (method, params) => sent.push([method, params]), request: async () => { throw new Error('No answer'); } };
}
const context = (me, sessions = {}) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
// Two computers of one owner, each marked by the other: the laptop looks, the devbox has the sessions.
function pair(t) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), laptop = team.founder, devbox = team.member;
  const project = withHome(devbox.home, () => { const made = registeredProject(t, { origin: 'https://github.com/acme/shop.git' }); saveTeamAccess(team.teamId, { root: made.root }); markMine(devbox.identity.key, laptop.identity.key); noteTheirs(laptop.identity.key, true); return made; });
  withHome(laptop.home, () => { markMine(laptop.identity.key, devbox.identity.key); noteTheirs(devbox.identity.key, true); });
  const toHost = connection(laptop.identity.key), toViewer = connection(devbox.identity.key);
  const hostCtx = context(devbox.identity, { [laptop.identity.key]: toHost }), viewCtx = context(laptop.identity, { [devbox.identity.key]: toViewer });
  const host = hostMethods(hostCtx), viewer = viewMethods(viewCtx);
  toViewer.request = async (method, params) => withHome(devbox.home, () => host[method](params, toHost));
  return { team, laptop, devbox, project, toHost, toViewer, hostCtx, viewCtx, host, viewer };
}
// A session saved as the app saves one.
function session(root, id, goal, state, extra = {}) {
  const repo = repository(root);
  saveTask(repo, { id: String(id), kind: 'conversation', goal, state, worktree: root, base: null, branch: null, runs: [], reviews: [], responses: [], messages: [], sessions: {}, result: null, activeRole: state === 'running' ? 'lead' : null, ...extra });
  return repo;
}

test("a row of another computer of mine shows the time that computer's own Sessions row shows, in every state", async t => {
  const { laptop, devbox, project, viewCtx } = pair(t), now = Date.now(), ago = minutes => new Date(now - minutes * 60000).toISOString();
  const said = (minutes, text = 'go on') => ({ role: 'user', at: ago(minutes), text });
  withHome(devbox.home, () => {
    // Created 28 hours ago; the turn that works now started a minute ago.
    session(project.root, 1, 'Works since a minute', 'running', { createdAt: ago(28 * 60), activeSince: ago(1), messages: [said(28 * 60), said(1)], runs: [{ role: 'lead', at: ago(27 * 60) }] });
    session(project.root, 2, 'Answered seven minutes ago', 'answered', { createdAt: ago(3 * 60), messages: [said(3 * 60)], runs: [{ role: 'lead', at: ago(7) }] });
    session(project.root, 3, 'Asks since a day', 'needs_input', { createdAt: ago(2 * 24 * 60), messages: [said(2 * 24 * 60)], runs: [{ role: 'lead', at: ago(24 * 60) }], result: { outcome: 'needs_input', question: 'Which one?' } });
    // Works for twenty minutes, and waits on an approval asked just now.
    session(project.root, 4, 'Wants a command', 'running', { createdAt: ago(5 * 60), activeSince: ago(20), messages: [said(5 * 60), said(20)] });
    requestApproval({ id: 'approval-4a', root: project.root, taskId: '4', role: 'lead', vendor: 'claude', tool: 'Bash', input: { command: 'npm test' } });
    // Answered two hours ago; a message of the owner's to it from four minutes ago did not run.
    session(project.root, 5, 'Message did not run', 'answered', { createdAt: ago(6 * 60), messages: [said(6 * 60)], runs: [{ role: 'lead', at: ago(2 * 60) }] });
    const blocked = enqueue(project.root, 'and the tests', { priority: 0, continuationTaskId: '5' });
    updateRequest(project.root, blocked.id, { state: 'blocked', reason: 'The model could not run.', createdAt: ago(4) });
    session(project.root, 6, 'Task to approve', 'answered', { createdAt: ago(9 * 60), messages: [said(9 * 60)], runs: [{ role: 'lead', at: ago(50) }], plan: { state: 'proposed', title: 'Trim the codes' } });
    session(project.root, 7, 'Getting ready', 'preparing', { createdAt: ago(26 * 60), activeSince: ago(3), messages: [said(26 * 60), said(3)] });
    relist();
  });
  const here = withHome(devbox.home, () => { assert.equal(pendingRequests(project.root).find(row => row.continuationTaskId === '5').state, 'blocked'); return boardRows([projectSnapshot(repository(project.root))], now, { approvals: pendingApprovals() }); });
  const own = Object.fromEntries(here.filter(row => row.kind === 'task').map(row => [row.task.goal, row.time]));
  assert.deepEqual(own, { 'Works since a minute': '1m00', 'Answered seven minutes ago': '7m ago', 'Asks since a day': '1d ago', 'Wants a command': 'just now', 'Message did not run': '4m ago', 'Task to approve': '50m ago', 'Getting ready': '3m00' });
  await withHome(laptop.home, () => listTick(viewCtx));
  const there = withHome(laptop.home, () => {
    const [machine] = remoteMachines(), status = { key: laptop.identity.key, name: 'ana', box: 'laptop', teams: [{ members: [{ key: laptop.identity.key, name: 'ana' }, { key: devbox.identity.key, name: 'ana', box: 'devbox', online: true }] }] };
    const facade = { mineRows, remoteSessions, remoteMachines, projectRepoId: () => machine.projects[0].repoId };
    const glue = remoteGlue({ facade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: ({ text }) => text, ink: text => text, colour: false, restMs: 0 });
    return glue.sections(now, '/work/shop').filter(line => line.row).map(line => line.row);
  });
  assert.equal(there.length, 7);
  assert.deepEqual(Object.fromEntries(there.map(row => [row.remote.title, row.time])), own, 'each row there shows what the row here shows');
});

test('a row of a session on a computer of mine counts from what that computer says, and for one on an earlier version from the start of its run', () => {
  const now = Date.parse('2026-11-11T10:00:00Z'), view = { id: 'a'.repeat(8), machine: 'a'.repeat(64), createdAt: '2026-11-10T06:00:00Z', lastAt: '2026-11-11T09:59:00Z', state: 'running', title: 'Works since a minute', approvals: [], steps: [] };
  // What a computer on 0.1.20 sends with its list and with a session's state.
  assert.equal(remoteRow({ ...view, since: { run: true, at: '2026-11-11T09:20:00Z' } }, 'devbox', now).time, '40m00');
  assert.equal(remoteRow({ ...view, state: 'answered', since: { at: '2026-11-11T09:53:00Z' } }, 'devbox', now).time, '7m ago');
  // What it said belongs to another state than the one shown: the row counts as it did before.
  assert.equal(remoteRow({ ...view, state: 'answered', since: { run: true, at: '2026-11-11T09:20:00Z' } }, 'devbox', now).time, '1m ago');
  // An earlier version says nothing: a turn that works counts from the start of its run when this machine follows it.
  assert.equal(remoteRow({ ...view, runs: [{ run: 'r1', startedAt: '2026-11-10T06:00:00Z', at: '2026-11-10T06:10:00Z' }, { run: 'r2', startedAt: '2026-11-11T09:58:00Z', at: null }] }, 'devbox', now).time, '2m00');
  assert.equal(remoteRow(view, 'devbox', now).time, '28h00');
});

// ---- A message from one computer of mine to another ----

const LIVE = new WeakMap(), STOP_MS = 20000;
function giveUp(text) { console.error(`other-computers.test: ${text} Ending the test process.`); process.exit(1); }
after(() => { setTimeout(() => giveUp('Something is still running 10 s after the last test.'), 10000).unref(); });
async function until(check, what, timeout = 30000) {
  const started = Date.now();
  while (!await check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
// Three computers of one owner in three homes, on one team, each a computer of the others'.
// The first (laptop) has the project and the stand-in vendors, takes its own computers'
// messages by itself (Auto), and is the home the conductor runs in. The second (devbox) is
// connected to the third all along. The third (studio) sends. A message goes between them
// as the wire carries it: the laptop is reachable only while `online` holds it.
function three(t, mode = 'slow-answer') {
  LIVE.set(t, []);
  t.after(async () => { for (const conductor of LIVE.get(t)) { const late = setTimeout(() => giveUp('A conductor did not stop.'), STOP_MS); try { await conductor.stop(); } finally { clearTimeout(late); } } });
  const p = project(t), fake = fakeClis(p.parent, { mode }), previous = { PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  Object.assign(process.env, fake.env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const repo = repository(p.root); registerProject(repo);
  const laptop = { home: fake.env.XDG_CONFIG_HOME, identity: createIdentity({ name: 'ana' }) }, team = createTeam(laptop.identity, 'shop');
  saveTeamAccess(team.id, { root: p.root, handling: 'auto' });
  const joins = () => {
    const home = newHome(t), identity = withHome(home, () => createIdentity({ name: 'ana' }));
    redeemCode(createInvite(laptop.identity, team.id, { hours: 1 }), identity.key, 'ana');
    return { home, identity };
  };
  const devbox = joins(), studio = joins(), log = readLog(team.id).ops, all = [laptop, devbox, studio];
  for (const one of [devbox, studio]) withHome(one.home, () => { const { rejected } = merge(team.id, log); if (rejected.length) throw new Error(rejected[0].reason); });
  for (const one of all) withHome(one.home, () => { for (const other of all) if (other !== one) { markMine(one.identity.key, other.identity.key); noteTheirs(other.identity.key, true); } });
  // The laptop's daemon as far as a message goes; what it tells the sender reaches the studio as the wire would carry it.
  const online = new Map(), dialed = [], events = [];
  const sender = { me: studio.identity, session: key => online.get(key) ?? null, dial: key => dialed.push(key), event: text => events.push(text), kick: () => {} };
  const receiver = { me: laptop.identity, kick: () => {}, event: () => {}, boxName: () => 'laptop', name: () => 'ana', push: (key, task) => { if (key === studio.identity.key && online.has(laptop.identity.key)) withHome(studio.home, () => applyTask(sender, laptop.identity.key, task)); } };
  const methods = intakeMethods(receiver);
  const wire = { request: async (method, params) => { const out = withHome(laptop.home, () => methods[method](params, { key: studio.identity.key })); return method === 'SendMessage' ? { task: out } : out; } };
  online.set(devbox.identity.key, { request: async () => { throw new Error('Not asked.'); } });
  const item = id => withHome(studio.home, () => peerItems().find(row => row.id.endsWith(`:${id}`) && ['asked', 'answer', 'rejected', 'expired'].includes(row.kind)));
  const conduct = () => { const conductor = new Conductor({ tickMs: 20 }).start(); LIVE.get(t).push(conductor); return conductor; };
  return { ...p, repo, fake, team, laptop, devbox, studio, sender, receiver, online, dialed, wire, item, conduct };
}
// The thread in Chats on the studio, as its rows read: the laptop shows as a computer of mine by its machine name.
const threadRows = (m, items, { connected = false, width = 200 } = {}) => teamPanes({ status: { key: m.studio.identity.key, teams: [{ members: [{ key: m.laptop.identity.key, name: 'laptop', mine: true, online: connected }] }] }, agents: [], items: items.map(row => ({ ...row, name: 'laptop' })) }, [30, 30, width], false)[2].map(row => visible(row.line));

test('a message to a computer of mine that is not connected says so, then follows the message: delivered, started there as a session, answered', async t => {
  const m = three(t), to = m.laptop.identity.key;
  const ask = withHome(m.studio.home, () => createAsk(m.sender, { to, kind: 'ask', text: 'Can you see this one?', byOwner: true }));
  const sentAt = Date.parse(ask.createdAt), line = (now, connected = false) => sentState(m.item(ask.id), { who: '@laptop', online: connected, mine: true, now });
  // The laptop is not connected: the line says that first, then for how long, and that the message goes by itself.
  assert.deepEqual(m.dialed, [to]); assert.equal(m.item(ask.id).state, 'pending');
  assert.equal(line(sentAt).text, '@laptop is offline. Your message goes as soon as it connects.');
  assert.equal(line(sentAt + 40000).text, '@laptop is offline (40s). Your message goes as soon as it connects.');
  withHome(m.studio.home, () => tickAsks(m.sender, sentAt + 30000));
  assert.equal(m.item(ask.id).state, 'pending'); assert.deepEqual(m.dialed, [to, to], 'it is dialed again while the message waits');
  assert.equal(line(sentAt + 61000).text, '@laptop is offline (1m). Your message goes as soon as it connects.');
  assert.ok(!line(sentAt + 61000).done);
  const waiting = threadRows(m, [{ ...m.item(ask.id), at: new Date(Date.now() - 61000).toISOString() }]);
  assert.deepEqual(waiting, ['→ you asked @laptop · Can you see this one?', '   ↳ not connected to @laptop yet (1m) · it goes as soon as it connects']);
  assert.equal(boardRows([], sentAt + 61000, { items: [m.item(ask.id)], online: new Set([m.devbox.identity.key]) }).find(row => row.kind === 'peer').now, '@ana offline · will retry');
  for (const text of [line(sentAt).text, line(sentAt + 61000).text, ...waiting]) assert.doesNotMatch(text, /to (?:confirm|agree)|\bpending\b/);
  // A minute later the laptop connects: the message goes by itself, and the line says when it got there.
  m.online.set(to, m.wire);
  await withHome(m.studio.home, () => reconnect(m.sender, to));
  const delivered = withHome(m.studio.home, () => getAsk(ask.id));
  assert.ok(['submitted', 'working'].includes(delivered.state), delivered.state); assert.ok(Number.isFinite(Date.parse(delivered.deliveredAt)));
  if (delivered.state === 'submitted') {
    assert.equal(line(Date.now(), true).text, `Delivered to @laptop at ${clockTime(delivered.deliveredAt)}.`);
    // While that computer has not marked this one back, a delivered message says what ends the wait: never that it waits with no reason.
    assert.equal(sentState(m.item(ask.id), { who: '@laptop', online: true, mine: true, unconfirmed: 'studio' }).text, `Delivered to @laptop at ${clockTime(delivered.deliveredAt)}. Waiting for @laptop to agree: run /mine @studio there.`);
    assert.deepEqual(threadRows(m, [m.item(ask.id)], { connected: true }), ['→ you asked @laptop · Can you see this one?', `   ↳ delivered at ${clockTime(delivered.deliveredAt)}`]);
  }
  // It starts a session there, as the laptop is set to (Auto): the line names the session as the laptop's Sessions list does.
  m.conduct();
  await until(() => { syncRecords(m.receiver); return withHome(m.studio.home, () => getAsk(ask.id)).startedAs; }, 'the session to start on the laptop');
  const [session] = projectSnapshot(m.repo).tasks, name = withHome(m.studio.home, () => getAsk(ask.id)).startedAs;
  assert.ok(session && name, 'a session there, and its name here'); assert.equal(name, taskTitle(session));
  const working = m.item(ask.id);
  if (working.kind === 'asked' && working.state === 'working') {
    assert.equal(sentState(working, { who: '@laptop', online: true, mine: true }).text, `Started on @laptop as session "${name}".`);
    assert.deepEqual(threadRows(m, [working], { connected: true }), ['→ you asked @laptop · Can you see this one?', `   ↳ started there as session "${name}"`]);
  }
  // Its answer ends it.
  await until(() => { processOutbox(m.receiver); return withHome(m.studio.home, () => getAsk(ask.id)).state === 'answered'; }, 'the answer to come back');
  const answered = sentState(m.item(ask.id), { who: '@laptop', online: true, mine: true });
  assert.equal(answered.text, '@laptop answered. The reply is in Chats.'); assert.equal(answered.done, true);
});

test('a message from another computer of mine whose session cannot start comes back at once with why, and this computer says the same in Sessions, in Chats and in elu peers', async t => {
  const m = three(t), to = m.laptop.identity.key;
  // The vendor's command gives up as a turn starts, as a script in front of it that ends first does.
  const front = path.join(m.parent, 'front'); fs.mkdirSync(front);
  fs.writeFileSync(path.join(front, 'claude'), `#!/bin/sh\ncase " $* " in *' -p '*) ;; *) exec ${JSON.stringify(path.join(m.fake.dir, 'claude'))} "$@";; esac\necho "termapp: gave up: the claude command keeps coming back to this script." >&2\nexit 126\n`, { mode: 0o700 });
  process.env.PATH = `${front}${path.delimiter}${process.env.PATH}`;
  const ask = withHome(m.studio.home, () => createAsk(m.sender, { to, kind: 'ask', text: 'Can you see this one?', byOwner: true }));
  m.online.set(to, m.wire);
  await withHome(m.studio.home, () => reconnect(m.sender, to));
  assert.notEqual(withHome(m.studio.home, () => getAsk(ask.id)).state, 'pending', 'the message is delivered');
  m.conduct();
  await until(() => { syncRecords(m.receiver); processOutbox(m.receiver); return withHome(m.studio.home, () => getAsk(ask.id)).state === 'failed'; }, 'the failure to come back');
  // The sender: the line under the chat and the thread say it failed there, why, and the one thing to do.
  const why = 'The model could not run: Claude Code did not start. The claude command said: termapp: gave up: the claude command keeps coming back to this script.';
  const failed = m.item(ask.id), state = sentState(failed, { who: '@laptop', online: true, mine: true });
  assert.equal(state.text, `Failed on @laptop: ${why} Check that claude runs in your terminal on @laptop, then send it again.`); assert.equal(state.done, true);
  const thread = threadRows(m, [failed], { connected: true, width: 400 });
  assert.deepEqual(thread, ['→ you asked @laptop · Can you see this one?', `   ↳ failed · ${why} Check that claude runs in your terminal on @laptop, then send it again.`]);
  // The laptop: its session's row, its thread in Chats and elu peers give one reason, the session's own.
  const here = `${why} Check that claude runs in your terminal, then type continue.`;
  const row = boardRows([projectSnapshot(m.repo)], Date.now()).find(item => item.kind === 'task');
  assert.equal(row.task.state, 'blocked'); assert.equal(stopLine(row.task).text, here);
  const item = peerItems().find(value => value.kind === 'failed');
  assert.equal(item.reason, here); assert.equal(records().find(record => record.task.id === item.taskId).failure, here);
  assert.deepEqual(teamPanes({ status: { key: to, teams: [] }, agents: [], items: [{ ...item, name: 'studio' }] }, [30, 30, 400], false)[2].map(value => visible(value.line)), ['← @studio asks you · Can you see this one?', `   ↳ your model could not answer · ${here}`]);
  // elu peers names the computer as elu mine does (the name its daemon heard), not the owner's name on the team, which all his computers share.
  const heard = (one, names) => withHome(one.home, () => fs.writeFileSync(peerFile('state.json'), JSON.stringify({ key: one.identity.key, teams: [{ id: m.team.id, members: names.map(([other, box]) => ({ key: other.identity.key, box })) }] })));
  heard(m.laptop, [[m.studio, 'studio'], [m.devbox, 'devbox']]); heard(m.studio, [[m.laptop, 'laptop'], [m.devbox, 'devbox']]);
  const told = await peerCli(['peers'], {});
  assert.ok(told.lines.includes(`failed  @studio  Can you see this one? · ${here}`), told.lines.join('\n'));
  // The same command on the sender names the reason whole too.
  const there = await withHome(m.studio.home, () => peerCli(['peers'], {}));
  assert.ok(there.lines.includes(`failed  @laptop  Can you see this one? · ${why} Check that claude runs in your terminal on @laptop, then send it again.`), there.lines.join('\n'));
});

test('a computer of mine that has not agreed while it is offline says offline, the reason, wherever the app says it waits', () => {
  const D = 'd'.repeat(64), ME = 'k'.repeat(64);
  const frame = online => ({ status: { key: ME, teams: [{ id: 'team-1', name: 'Core', members: [{ key: ME, name: 'ana' }, { key: D, name: 'devbox', online, path: 'direct', mine: true, waiting: true }] }] }, items: [] });
  const bar = (online, width) => visuals.visible(visuals.chatBar(frame(online), width, false).find(row => row.value?.type === 'member').line).replace(/\s+/g, ' ').trim();
  assert.deepEqual([bar(false, 78), bar(false, 40), bar(true, 78)], ['○ @devbox offline · waiting for @devbox to agree', '○ @devbox offline · not agreed yet', '● @devbox waiting for @devbox to agree']);
  assert.deepEqual([yourComputer({ waiting: true, online: false }), yourComputer({ waiting: true, online: true }), yourComputer({ waiting: true }), yourComputer({ online: false })], ['your computer · offline, not agreed yet', 'your computer · waiting for it to agree', 'your computer · waiting for it to agree', 'your computer']);
  const glue = online => remoteGlue({ facade: { mineRows: () => [{ key: D, mine: true, theirs: false }], remoteSessions: () => [] }, peerRead: () => ({ key: ME, name: 'ana', box: 'laptop', teams: [{ members: [{ key: ME, name: 'ana' }, { key: D, name: 'ana', box: 'devbox', online }] }] }), peerCommand: async () => ({}), chatMessage: ({ text }) => text, ink: text => text, colour: false });
  assert.deepEqual([glue(false).words(D), glue(true).words(D)], ['your computer · offline, not agreed yet', 'your computer · waiting for it to agree']);
});

test('a computer that says it is mine is named, in the line and in its row, only by a name /mine finds it by', () => {
  // Three computers of one owner, all called sam on the team: the one that says it is mine is
  // found by its box name, which comes a moment after it connects.
  const ME = 'k'.repeat(64), D = 'd'.repeat(64), G = 'e'.repeat(64);
  let box;
  const status = () => ({ key: ME, name: 'sam', box: 'laptop', teams: [{ members: [{ key: ME, name: 'sam' }, { key: D, name: 'sam', box: 'devbox', online: true }, { key: G, name: 'sam', box, online: true }] }] });
  const glue = remoteGlue({ facade: { mineRows: () => [{ key: G, mine: false, theirs: true, theirsAt: '2026-11-14T18:59:17.000Z' }], remoteSessions: () => [] }, peerRead: status, peerCommand: async () => ({}), chatMessage: ({ text }) => text, ink: text => text, colour: false });
  assert.equal(glue.asking().size, 0, 'not while /mine @sam would find two computers');
  assert.equal(glue.asks(), null);
  box = 'studio';
  assert.deepEqual([...glue.asking(Date.now() + 1000).values()].map(row => row.name), ['studio']);
  assert.equal(glue.asks(), '@studio says it is your computer. /mine @studio agrees.');
  assert.equal(glue.asks(), null, 'said once');
});

test('the line for a message I sent says where it is in every state, and never that it waits with no reason', () => {
  const now = Date.parse('2026-01-05T10:00:00Z'), at = new Date(now - 65000).toISOString(), base = { kind: 'asked', peer: 'd'.repeat(64), text: 'Are the totals right?', at };
  const line = (item, where = {}) => sentState(item, { who: '@devbox', now, ...where });
  // Not there yet: offline in the roster says so first, with how long; connected says it is sent again.
  assert.deepEqual(line({ ...base, state: 'pending' }, { mine: true }), { text: '@devbox is offline (1m). Your message goes as soon as it connects.', short: 'not connected to @devbox yet (1m) · it goes as soon as it connects', late: true });
  assert.equal(line({ ...base, state: 'pending' }).text, '@devbox is offline (1m). Your message goes as soon as they connect.');
  assert.equal(line({ ...base, state: 'pending', at: new Date(now - 2000).toISOString() }).text, '@devbox is offline. Your message goes as soon as they connect.');
  assert.deepEqual(line({ ...base, state: 'pending' }, { online: true }), { text: 'Not delivered to @devbox yet (1m). It is sent again by itself.', short: 'not delivered yet (1m)', late: true });
  // There: when it got there, what it waits for there when that computer said it, then the session it started.
  const delivered = { ...base, state: 'submitted', deliveredAt: at };
  assert.deepEqual(line(delivered), { text: `Delivered to @devbox at ${clockTime(at)}.`, short: `delivered at ${clockTime(at)}` });
  assert.equal(line({ ...delivered, note: 'It waits for a project there.' }).text, `Delivered to @devbox at ${clockTime(at)}. It waits for a project there.`);
  // To a computer of mine that has not marked this one back: whose agreement it waits for, and what to run there, in the words its row and its screen use.
  assert.equal(line(delivered, { mine: true, online: true, unconfirmed: 'studio' }).text, `Delivered to @devbox at ${clockTime(at)}. Waiting for @devbox to agree: run /mine @studio there.`);
  assert.deepEqual(line({ ...base, state: 'working', startedAs: 'Check the totals' }), { text: 'Started on @devbox as session "Check the totals".', short: 'started there as session "Check the totals"' });
  assert.equal(line({ ...base, state: 'working' }).text, '@devbox is working on it.');
  assert.equal(line({ ...base, state: 'held' }).text, '@devbox has a reply that waits there to be sent.');
  // Over: answered, failed there with the reason, declined, or given up after a week.
  assert.deepEqual(line({ ...base, kind: 'answer', state: 'answered', text: 'Yes.' }), { text: '@devbox answered. The reply is in Chats.', short: 'answered', done: true });
  assert.equal(line({ ...base, kind: 'rejected', state: 'failed', question: base.text, text: 'Claude Code is signed out. Sign in on @devbox, then send it again.' }).text, 'Failed on @devbox: Claude Code is signed out. Sign in on @devbox, then send it again.');
  assert.equal(line({ ...base, kind: 'rejected', state: 'rejected', question: base.text, text: 'Not now.' }).text, '@devbox declined it: Not now.');
  assert.equal(line({ ...base, kind: 'expired', state: 'expired' }).text, 'Your message to @devbox was not delivered in a week and is no longer sent.');
  for (const item of [{ ...base, state: 'pending' }, delivered, { ...base, state: 'working' }, { ...base, state: 'held' }]) for (const where of [{}, { online: true }, { mine: true }, { mine: true, online: true }]) assert.doesNotMatch(line(item, where).text, /to (?:confirm|agree)/i);
  assert.equal(line(null), null);
});

test('a message delivered to a computer where messages are accepted by hand says it waits for a yes there', async t => {
  const m = three(t), to = m.laptop.identity.key;
  saveTeamAccess(m.team.id, { root: m.root, handling: 'manual' });
  const ask = withHome(m.studio.home, () => createAsk(m.sender, { to, kind: 'ask', text: 'Can you see this one?', byOwner: true }));
  m.online.set(to, m.wire);
  await withHome(m.studio.home, () => reconnect(m.sender, to));
  const delivered = withHome(m.studio.home, () => getAsk(ask.id)), waits = 'It waits for a yes on @laptop: messages there are accepted by hand (Chats, then y).';
  assert.equal(delivered.state, 'submitted');
  // Delivered is not started: the line and the thread say what it waits for there.
  assert.equal(sentState(m.item(ask.id), { who: '@laptop', online: true, mine: true }).text, `Delivered to @laptop at ${clockTime(delivered.deliveredAt)}. ${waits}`);
  assert.deepEqual(threadRows(m, [m.item(ask.id)], { connected: true, width: 400 }), ['→ you asked @laptop · Can you see this one?', `   ↳ delivered at ${clockTime(delivered.deliveredAt)} · ${waits}`]);
  // Nothing started on the laptop: it waits there for its owner.
  assert.equal(projectSnapshot(m.repo).tasks.length, 0); assert.equal(peerItems().find(item => item.kind === 'incoming')?.text, 'Can you see this one?');
});
