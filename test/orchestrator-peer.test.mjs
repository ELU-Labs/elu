import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { liveTask, makeTeam, newHome, registeredProject, shareProjects, withHome } from './peer-helpers.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { ONLY_OWNER, hostMethods, hostTick, listTick, projectKey, relist, remoteCommand, remoteMachines, remoteSessions, viewMethods, viewTick } from '../lib/peer/remote.mjs';
import { repository } from '../lib/git.mjs';
import { readTask, saveTask, taskDir } from '../lib/state.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import { pendingApprovals, requestApproval } from '../lib/approvals.mjs';
import { enqueue } from '../lib/conductor.mjs';
import { removeBot } from '../lib/bots.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { share } from '../lib/peer/shares.mjs';
import { localRepos, repoProof, saveProofs, sessionCards } from '../lib/peer/cards.mjs';
import { hostStandup, hostStandupRead, teamStandupAsk, teamStandupRead } from '../lib/peer/standup.mjs';
import { statusRows } from '../lib/peer/status.mjs';
import { planRows } from '../lib/peer/plans.mjs';
import { planFile } from '../lib/plan.mjs';
import { newRound } from '../lib/standup.mjs';
import { ink } from '../lib/terminal-visuals.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';

// The bot that oversees the owner's sessions (@orchestrator) reads every session and fact on
// its computer. What it holds stays there: another computer on a shared project, the owner's
// own included, never lists, watches, asks or writes to its chat, never sees its runs or its
// replies in a session, never answers what it asks, and writes to it nowhere. A note it sent a
// session, and a session it starts, show there as the bot's.

function connection(key) {
  const sent = [];
  return { key, admitted: true, remoteHello: { remote: 1, shared: 1 }, sent, notify: (method, params) => sent.push([method, params]), request: async () => { throw new Error('No answer'); } };
}
const context = (me, sessions = {}) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
// Both computers the owner's (a laptop and a devbox, on one team), the devbox the host, with one shared project.
function pair(t) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), laptop = team.founder, devbox = team.member;
  const project = withHome(devbox.home, () => { const project = registeredProject(t); saveTeamAccess(team.teamId, { root: project.root }); shareProjects(devbox.identity.key, laptop.identity.key); return project; });
  withHome(laptop.home, () => shareProjects(laptop.identity.key, devbox.identity.key));
  const toHost = connection(laptop.identity.key), toViewer = connection(devbox.identity.key);
  const hostCtx = context(devbox.identity, { [laptop.identity.key]: toHost }), viewCtx = context(laptop.identity, { [devbox.identity.key]: toViewer });
  const host = hostMethods(hostCtx), viewer = viewMethods(viewCtx);
  toViewer.request = async (method, params) => withHome(devbox.home, () => host[method](params, toHost));
  return { laptop, devbox, project, toHost, hostCtx, viewCtx, host, viewer };
}
const at = n => new Date(Date.now() - 600000 + n * 1000).toISOString();
function chat(root, id, { goal = `Session ${id}`, state = 'answered', ...extra } = {}) {
  const repo = repository(root);
  saveTask(repo, { id: String(id), kind: 'conversation', goal, state, worktree: root, base: null, branch: null, createdAt: at(0), runs: [], reviews: [], responses: [], messages: [], sessions: {}, result: null, activeRole: null, ...extra });
  return repo;
}
// A run's log in the session's own folder, as the runner keeps one.
function log(repo, id, name, text) {
  const file = path.join(taskDir(repo, id), `${name}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`);
  return file;
}
const SECRET_REPLY = 'Across your projects: secret-plans #4 waits on the billing fix. Fact f3 says the customer is Acme.';
const NOTE = 'Run the tests before you publish.';

test('the chat of the bot that oversees the sessions, and a start of one, are never listed, followed or asked from another computer; an ordinary bot chat still is', t => {
  const { devbox, project, toHost, host } = pair(t);
  const ref = id => `${projectKey(project.root)}:${id}`;
  withHome(devbox.home, () => {
    chat(project.root, 1, { goal: 'Fix the login redirect' });
    chat(project.root, 2, { goal: 'How are my sessions?', botChat: 'orchestrator', messages: [{ at: at(1), text: 'How are my sessions?', to: '@orchestrator' }, { at: at(2), from: '@orchestrator', bot: 'orchestrator', text: SECRET_REPLY }] });
    chat(project.root, 3, { goal: 'Notes for the week', botChat: 'reviewer' });
    enqueue(project.root, 'What runs here now?', { botChat: true, bot: 'orchestrator' });
    relist();
  });
  const listed = withHome(devbox.home, () => host['elu.remote.list']({}, toHost));
  assert.deepEqual(listed.sessions.map(row => row.title).sort(), ['Fix the login redirect', 'Notes for the week']);
  assert.equal(JSON.stringify(listed).includes('secret-plans'), false);
  // Named by its place, it is no session at all: not followed, renamed, checked or asked.
  const gone = { message: 'That session is not on this computer.' };
  withHome(devbox.home, () => {
    assert.throws(() => host['elu.remote.watch']({ ref: ref(2) }, toHost), gone);
    assert.throws(() => host['elu.remote.rename']({ ref: ref(2), title: 'Mine now' }, toHost), gone);
    assert.throws(() => host['elu.remote.check']({ ref: ref(2), look: true }, toHost), gone);
    const asked = host['elu.remote.standup']({ round: 'standup-1234567890abcdef', refs: [ref(2)] }, toHost);
    assert.deepEqual([asked.asked ?? [], asked.skipped.filter(row => row.ref === ref(2))], [[], [{ ref: ref(2), why: 'gone' }]]);
    assert.equal(pendingRequests(project.root).filter(row => row.standupFor).length, 0);
    // The ordinary bot chat is followed as before.
    assert.equal(typeof host['elu.remote.watch']({ ref: ref(3) }, toHost).id, 'string');
  });
  // With the bot taken out and nothing in its place, its old chat still stays here.
  withHome(devbox.home, () => { assert.equal(removeBot('orchestrator'), true); relist(); });
  assert.deepEqual(withHome(devbox.home, () => host['elu.remote.list']({}, toHost)).sessions.map(row => row.title).sort(), ['Fix the login redirect', 'Notes for the week']);
  withHome(devbox.home, () => assert.throws(() => host['elu.remote.watch']({ ref: ref(2) }, toHost), gone));
});

test('a session followed from another computer shows a note of the bot that oversees the sessions as its, and none of its replies, runs or questions', async t => {
  const { laptop, devbox, project, toHost, hostCtx, viewCtx, viewer, host } = pair(t);
  withHome(devbox.home, () => {
    const repo = chat(project.root, 1, { goal: 'Fix the login redirect' });
    const lead = log(repo, '1', 'run-lead', 'I fixed the redirect.'), oversee = log(repo, '1', 'run-orchestrator', SECRET_REPLY);
    saveTask(repo, { id: '1', kind: 'conversation', goal: 'Fix the login redirect', state: 'answered', worktree: project.root, base: null, branch: null, createdAt: at(0), reviews: [], responses: [], sessions: {}, result: null, activeRole: null,
      runs: [{ role: 'lead', logFile: lead, at: at(3), vendor: 'claude' }, { role: 'bot:orchestrator', logFile: oversee, at: at(5), vendor: 'claude' }],
      messages: [{ at: at(1), text: 'Fix the login redirect' }, { at: at(4), text: 'How are my sessions?', to: '@orchestrator' }, { at: at(5), from: '@orchestrator', bot: 'orchestrator', text: SECRET_REPLY }, { at: at(6), from: '@orchestrator', bot: 'orchestrator', overseer: true, text: NOTE }] });
    requestApproval({ id: 'approval-lead', root: project.root, taskId: '1', role: 'lead', vendor: 'claude', tool: 'Bash', input: { command: 'npm test' } });
    requestApproval({ id: 'approval-orchestrator', root: project.root, taskId: '1', role: 'bot:orchestrator', vendor: 'claude', tool: 'mcp__elu__session_message', input: { text: SECRET_REPLY } });
    // A note it sent that waits for the session's next turn, and one more that it asks itself.
    enqueue(project.root, 'Check the flaky test too.', { continuationTaskId: '1', priority: 1, overseer: 'orchestrator' });
    requestApproval({ id: 'approval-marked', root: project.root, taskId: '1', role: 'lead', vendor: 'claude', tool: 'mcp__elu__session_start', input: { goal: SECRET_REPLY }, oversee: true });
    relist();
  });
  await withHome(laptop.home, () => listTick(viewCtx));
  const item = withHome(laptop.home, () => remoteMachines())[0].sessions.find(row => row.title === 'Fix the login redirect');
  await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteWatch', to: devbox.identity.key, ref: item.ref }));
  withHome(devbox.home, () => hostTick(hostCtx));
  const pushed = toHost.sent.filter(([method]) => method === 'elu.remote.events'), events = pushed.flatMap(([, params]) => params.items.flatMap(row => row.events));
  assert.ok(events.length > 0);
  assert.equal(JSON.stringify(events).includes('secret-plans'), false, 'nothing the bot that oversees said or did');
  assert.deepEqual(events.filter(event => event.type === 'run').map(event => event.role), ['lead']);
  assert.deepEqual(events.filter(event => event.type === 'approvals').flatMap(event => event.list.map(row => row.id)), ['approval-lead']);
  const entries = events.filter(event => event.type === 'entry');
  assert.deepEqual(entries.filter(event => event.bot === 'orchestrator').map(event => event.text), [NOTE], 'its note goes, as its');
  assert.ok(entries.some(event => event.text === 'How are my sessions?'), "the owner's own words go");
  // Each entry has its place among those that go, so the viewer never waits for one that does not come.
  assert.deepEqual(entries.map(event => event.n), entries.map((_, index) => index + 1));
  for (const [method, params] of pushed) withHome(laptop.home, () => viewer[method](params, connection(devbox.identity.key)));
  await withHome(laptop.home, () => viewTick(viewCtx));
  const seen = withHome(laptop.home, () => remoteSessions().find(row => row.id === item.id));
  assert.deepEqual(seen.waiting.map(row => [row.text, row.from ?? null, row.overseer ?? null]), [['Check the flaky test too.', '@orchestrator', true]], 'a note that waits is the bot\'s there too');
  // What it asks is answered on its own computer alone.
  withHome(devbox.home, () => {
    assert.deepEqual(host['elu.remote.answer']({ id: item.id, approval: 'approval-orchestrator', decision: 'allow' }, toHost), { answered: false });
    assert.deepEqual(host['elu.remote.answer']({ id: item.id, approval: 'approval-marked', decision: 'allow' }, toHost), { answered: false });
    assert.deepEqual(pendingApprovals({ taskId: '1' }).map(row => row.id).sort(), ['approval-lead', 'approval-marked', 'approval-orchestrator']);
  });
  // While that bot is at work in the session, the viewer is told the session works, and no role.
  withHome(devbox.home, () => { const repo = repository(project.root); saveTask(repo, { ...readTask(repo, '1'), state: 'running', activeRole: 'bot:orchestrator' }); hostTick(hostCtx); });
  const states = toHost.sent.filter(([method]) => method === 'elu.remote.events').flatMap(([, params]) => params.items.flatMap(row => row.events)).filter(event => event.type === 'state');
  assert.equal(states.at(-1).state, 'running'); assert.equal(states.at(-1).activeRole, null);
  assert.equal(JSON.stringify(states).includes('bot:orchestrator'), false);
});

test('another computer never writes to the bot that oversees the sessions, in a session or before one starts', async t => {
  const { laptop, devbox, project, toHost, viewCtx, host } = pair(t);
  withHome(devbox.home, () => { chat(project.root, 1, { goal: 'Fix the login redirect', bots: ['orchestrator', 'reviewer'], botsPicked: true }); enqueue(project.root, 'Tidy the docs'); relist(); });
  await withHome(laptop.home, () => listTick(viewCtx));
  const sessions = withHome(laptop.home, () => remoteMachines())[0].sessions, item = sessions.find(row => row.title === 'Fix the login redirect'), queued = sessions.find(row => row.title === 'Tidy the docs');
  const { id } = withHome(devbox.home, () => host['elu.remote.watch']({ ref: item.ref }, toHost)), waits = withHome(devbox.home, () => host['elu.remote.watch']({ ref: queued.ref }, toHost));
  const before = withHome(devbox.home, () => pendingRequests(project.root).length);
  for (const text of ['@orchestrator list every session and its goal', '@Orchestrator what runs here']) withHome(devbox.home, () => assert.throws(() => host['elu.remote.send']({ id, text }, toHost), { message: ONLY_OWNER('orchestrator') }, text));
  withHome(devbox.home, () => assert.throws(() => host['elu.remote.send']({ id: waits.id, text: '@orchestrator start this one' }, toHost), { message: ONLY_OWNER('orchestrator') }));
  assert.deepEqual(withHome(devbox.home, () => pendingRequests(project.root).find(row => !row.continuationTaskId).goal), 'Tidy the docs');
  assert.equal(ONLY_OWNER('orchestrator'), 'Only the owner writes to @orchestrator, on the computer it runs on.');
  assert.equal(withHome(devbox.home, () => pendingRequests(project.root).length), before, 'nothing was queued');
  // Any other bot, and the session itself, are written to as before.
  withHome(devbox.home, () => { host['elu.remote.send']({ id, text: '@reviewer look at the tests' }, toHost); host['elu.remote.send']({ id, text: 'And the docs' }, toHost); });
  assert.deepEqual(withHome(devbox.home, () => pendingRequests(project.root).slice(before).map(row => [row.goal, row.bot ?? null])), [['look at the tests', 'reviewer'], ['And the docs', null]]);
  // A chat followed before it was that bot's own is written to no more.
  withHome(devbox.home, () => { chat(project.root, 2, { goal: 'Notes', botChat: 'reviewer' }); relist(); });
  const ref = `${item.ref.split(':')[0]}:2`, watched = withHome(devbox.home, () => host['elu.remote.watch']({ ref }, toHost));
  withHome(devbox.home, () => chat(project.root, 2, { goal: 'Notes', botChat: 'orchestrator' }));
  withHome(devbox.home, () => assert.throws(() => host['elu.remote.send']({ id: watched.id, text: 'What runs here?' }, toHost), { message: ONLY_OWNER('orchestrator') }));
  assert.equal(withHome(devbox.home, () => pendingRequests(project.root).filter(row => row.continuationTaskId === '2').length), 0);
});

test('a session the bot that oversees the sessions starts, waiting or started, is listed there as that bot\'s', t => {
  const { devbox, project, toHost, host } = pair(t);
  withHome(devbox.home, () => {
    enqueue(project.root, 'Check the flaky login test', { priority: 1, permissions: 'ask', place: { kind: 'worktree' }, folders: [], bots: [], overseer: 'orchestrator', budgetUsd: 5 });
    chat(project.root, 1, { goal: 'Update the changelog', overseer: 'orchestrator' });
    chat(project.root, 2, { goal: 'Typed here by hand' });
    relist();
  });
  const listed = withHome(devbox.home, () => host['elu.remote.list']({}, toHost));
  assert.deepEqual(Object.fromEntries(listed.sessions.map(row => [row.title, [row.by, row.who]])), { 'Check the flaky login test': ['bot', 'orchestrator'], 'Update the changelog': ['bot', 'orchestrator'], 'Typed here by hand': ['you', null] });
});

test('the Kanban another computer reads has no card of the chat of the bot that oversees the sessions, nor of a start of one, and its turn in a session reads as the session working', t => {
  const { devbox, project, toHost, host } = pair(t), id = projectKey(project.root);
  withHome(devbox.home, () => {
    chat(project.root, 1, { goal: 'Fix the login redirect' });
    chat(project.root, 2, { goal: SECRET_REPLY, botChat: 'orchestrator' });
    chat(project.root, 3, { goal: 'Tidy the docs', state: 'running', activeRole: 'bot:orchestrator' });
    chat(project.root, 4, { goal: 'Notes for the week', botChat: 'reviewer' });
    enqueue(project.root, 'What waits on secret-plans?', { botChat: true, bot: 'orchestrator' });
  });
  const board = withHome(devbox.home, () => host['elu.remote.board']({ project: id }, toHost)), items = board.columns.flatMap(column => column.items);
  assert.deepEqual(items.map(item => item.title).sort(), ['Fix the login redirect', 'Notes for the week', 'Tidy the docs']);
  assert.equal(JSON.stringify(board).includes('secret-plans'), false);
  assert.equal(items.find(item => item.title === 'Tidy the docs').detail, 'working');
  // Nor is it moved from there.
  withHome(devbox.home, () => assert.throws(() => host['elu.remote.boardAct']({ project: id, act: 'back', key: 'task-2' }, toHost), { message: 'That card is no longer on the board there.' }));
});

const ORIGIN = 'https://github.com/elu-labs/shop.git';
const approved = (id, title) => ({ id, session: '1', revision: 1, title, description: 'Text', goal: title, objectives: ['One'], priority: 'high', severity: 'critical', state: 'approved', startedBy: 'owner', by: 'lead',
  proposedAt: at(1), approvedAt: at(2), rejectedAt: null, doneAt: null, subtasks: [], met: [], edit: { repository: null, bot: null, request: title } });
// A field on a session's record, as nothing but a test writes it to an editing session.
function mark(repo, id, extra) { const file = path.join(taskDir(repo, id), 'task.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...extra })); }

test('the status rows and Tasks teammates are told leave out the chat of the bot that oversees the sessions, and name no turn of its', t => {
  withHome(newHome(t), () => {
    createIdentity({ name: 'sara' });
    const now = Date.now(), project = registeredProject(t, { origin: ORIGIN }), repo = repository(project.root); share(project.root, { handle: 'app', teams: [] });
    liveTask(project.root, { id: '1', goal: 'Fix the cart total' });
    liveTask(project.root, { id: '2', goal: 'Normalize coupons', activeRole: 'bot:orchestrator', files: { 'README.md': 'x\n' } });
    liveTask(project.root, { id: '3', goal: SECRET_REPLY, files: { 'docs/plan.md': 'x\n' } }); mark(repo, '3', { botChat: 'orchestrator' });
    assert.deepEqual(statusRows().map(row => [row.taskId, row.now]), [['1', 'ready · lead'], ['2', 'ready']]);
    for (const [id, title] of [['1', 'Fix the cart total'], ['3', 'Tell no one about secret-plans']]) fs.writeFileSync(planFile(repo, id), JSON.stringify({ version: 1, tasks: [approved(`t-0000000${id}`, title)] }));
    assert.deepEqual(planRows(now).map(task => task.title), ['Fix the cart total']);
    // A session whose record cannot be read cannot say whose it is: none of its Tasks is told.
    fs.mkdirSync(taskDir(repo, '4'), { recursive: true }); fs.writeFileSync(path.join(taskDir(repo, '4'), 'task.json'), '{');
    fs.writeFileSync(planFile(repo, '4'), JSON.stringify({ version: 1, tasks: [approved('t-00000004', 'Unread')] }));
    assert.deepEqual(planRows(now).map(task => task.title), ['Fix the cart total']);
  });
});

test('a standup from another computer of the owner never asks the chat of the bot that oversees the sessions, and no record it sends holds what that bot said or asked', t => {
  const { laptop, devbox, project, toHost, host } = pair(t), key = projectKey(project.root), ref = id => `${key}:${id}`, old = new Date(Date.now() - 20 * 86400000).toISOString();
  const rounds = withHome(devbox.home, () => {
    const repo = chat(project.root, 1, { goal: 'Fix the login redirect' }), lead = path.join(taskDir(repo, '1'), 'run-lead.jsonl');
    fs.writeFileSync(lead, `${JSON.stringify({ type: 'result', result: JSON.stringify({ summary: 'I fixed the redirect.' }) })}\n`);
    saveTask(repo, { id: '1', kind: 'conversation', goal: 'Fix the login redirect', state: 'answered', worktree: project.root, base: null, branch: null, createdAt: at(0), reviews: [], responses: [], sessions: {}, result: null, activeRole: null,
      runs: [{ role: 'lead', logFile: lead, at: at(3), vendor: 'claude' }], messages: [{ at: at(1), text: 'Fix the login redirect' }, { at: at(4), text: 'How are my sessions?', to: '@orchestrator' }, { at: at(5), from: '@orchestrator', bot: 'orchestrator', text: SECRET_REPLY }] });
    requestApproval({ id: 'approval-orchestrator', root: project.root, taskId: '1', role: 'bot:orchestrator', vendor: 'claude', tool: 'mcp__elu__session_message', input: { text: SECRET_REPLY } });
    requestApproval({ id: 'approval-marked', root: project.root, taskId: '1', role: 'lead', vendor: 'claude', tool: 'mcp__elu__session_start', input: { goal: SECRET_REPLY }, oversee: true });
    // Quiet for weeks: only that bot wrote in it since, and only it asks something there.
    chat(project.root, 2, { goal: 'Old work', createdAt: old, runs: [{ role: 'lead', at: old, vendor: 'claude' }], messages: [{ at: old, text: 'Old work' }, { at: at(6), from: '@orchestrator', bot: 'orchestrator', overseer: true, text: NOTE }] });
    requestApproval({ id: 'approval-quiet', root: project.root, taskId: '2', role: 'bot:orchestrator', vendor: 'claude', tool: 'mcp__elu__session_message', input: { text: SECRET_REPLY } });
    chat(project.root, 3, { goal: 'Notes for the week', botChat: 'reviewer', runs: [{ role: 'lead', at: at(2), vendor: 'claude' }] });
    chat(project.root, 4, { goal: SECRET_REPLY, botChat: 'orchestrator', runs: [{ role: 'lead', at: at(2), vendor: 'claude' }] });
    const first = newRound(), asked = hostStandup({ round: first, refs: [1, 2, 3, 4].map(ref) }, laptop.identity.key, { projectKey });
    assert.deepEqual(asked.asked.map(row => row.ref), [ref(1), ref(3)]);
    assert.deepEqual(asked.skipped, [{ ref: ref(2), why: 'quiet' }, { ref: ref(4), why: 'gone' }]);
    const record = asked.records.find(row => row.ref === ref(1)).record;
    assert.equal(record.said, 'I fixed the redirect.'); assert.equal(record.question, undefined); assert.equal(record.state, 'finished');
    assert.equal(JSON.stringify(asked).includes('secret-plans'), false);
    return { first };
  });
  // A chat asked before it was that bot's: its answer is never read, and the round has no record of it.
  withHome(devbox.home, () => {
    chat(project.root, 3, { goal: 'Notes for the week', botChat: 'orchestrator', runs: [{ role: 'lead', at: at(2), vendor: 'claude' }] });
    const read = hostStandupRead({ round: rounds.first, parts: 1 }, laptop.identity.key);
    assert.deepEqual(read.pending.map(row => row.ref), [ref(1)]);
    assert.deepEqual(read.answers.map(row => [row.ref, row.failed, row.text.startsWith('It did not answer.')]), [[ref(3), true, true]]);
    assert.deepEqual(host['elu.remote.standup']({ round: rounds.first, refs: [ref(1), ref(3)] }, toHost).records.map(row => row.ref), [ref(1)]);
  });
});

test("a teammate's standup has no card of the chat of the bot that oversees the sessions, never reads one, and what that bot did or asks keeps no quiet session asked", t => {
  const { teamId, founder, member } = makeTeam(t), now = Date.now(), old = new Date(now - 10 * 86400000).toISOString();
  withHome(founder.home, () => {
    const project = registeredProject(t, { origin: ORIGIN }); saveTeamAccess(teamId, { handling: 'auto' });
    chat(project.root, 1, { goal: 'Old work', createdAt: old, runs: [{ role: 'lead', at: old, vendor: 'claude' }, { role: 'bot:orchestrator', at: at(5), vendor: 'claude' }], messages: [{ at: old, text: 'Old work' }] });
    requestApproval({ id: 'approval-quiet', root: project.root, taskId: '1', role: 'lead', vendor: 'claude', tool: 'mcp__elu__session_start', input: { goal: SECRET_REPLY }, oversee: true });
    chat(project.root, 2, { goal: 'Notes for the week', botChat: 'reviewer', runs: [{ role: 'lead', at: at(2), vendor: 'claude' }] });
    chat(project.root, 3, { goal: SECRET_REPLY, botChat: 'orchestrator', runs: [{ role: 'lead', at: at(2), vendor: 'claude' }] });
    const repos = localRepos(now), [row] = repos.values();
    saveProofs(member.identity.key, [repoProof(member.identity.key, founder.identity.key, row.repoId, row.commit)]);
    const rows = sessionCards({ owner: 'ana', repos, now });
    assert.deepEqual(rows.map(value => value.taskId).sort(), ['1', '2']);
    const card = id => rows.find(value => value.taskId === id).card.id, round = newRound();
    const ctx = { me: founder.identity, repos: () => repos, kick: () => {}, event: () => {} };
    const asked = teamStandupAsk(ctx, member.identity.key, { round, cards: [card('1'), card('2')] });
    assert.deepEqual([asked.state, asked.asked.map(value => value.card), asked.skipped], ['asked', [card('2')], [{ card: card('1'), why: 'quiet' }]]);
    // The chat becomes that bot's before it answers: it is never read.
    chat(project.root, 2, { goal: 'Notes for the week', botChat: 'orchestrator', runs: [{ role: 'lead', at: at(2), vendor: 'claude' }] });
    assert.deepEqual(teamStandupRead(member.identity.key, { round }).answers.map(value => [value.card, value.text]), [[card('2'), 'It did not answer.']]);
  });
});

test('a note of the bot that oversees the sessions that waits there reads as that bot\'s, and the key that sends messages now goes under the owner\'s own', () => {
  const glue = remoteGlue({ facade: {}, peerRead: () => null, peerCommand: async () => ({}), chatMessage: ({ title, text }) => `${title}: ${text}`, ink, colour: false });
  const row = { machine: 'devbox', by: 'mine', remote: { machine: 'd'.repeat(64), project: 'shop', state: 'running', entries: [], held: 1, waiting: [
    { at: at(1), text: 'And the docs', state: 'turn', takes: 'end' },
    { at: at(2), text: 'Check the flaky test too.', state: 'turn', takes: 'end', from: '@orchestrator', overseer: true },
    { at: at(3), text: 'Not a note of it', state: 'queued', from: '@orchestrator' }] } };
  const waiting = glue.parts(row, 100).filter(part => part.key.startsWith('waiting')).map(part => part.text);
  assert.deepEqual(waiting.map(text => text.split(':')[0]), ['You → @devbox (starts when this turn ends)', '@orchestrator → @devbox (starts when this turn ends)', 'You → @devbox (starts next)']);
  assert.match(waiting[0], /Enter in the empty box sends it now/);
  assert.doesNotMatch(waiting[1], /Enter in the empty box/);
});
