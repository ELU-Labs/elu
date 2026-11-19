import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.mjs';
import { liveTask, makeTeam, registeredProject, shareProjects, withHome } from './peer-helpers.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { OVERSEE_UPDATE, hostMethods, listTick, relist, remoteCommand, remoteMachines, viewMethods } from '../lib/peer/remote.mjs';
import { repository } from '../lib/git.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { pendingRequests, projectFolder } from '../lib/workspace.mjs';
import { registerProject } from '../lib/projects.mjs';
import { forgetOverview } from '../lib/session-overview.mjs';
import { setLevel } from '../lib/orchestrator-settings.mjs';
import { act, questionMark, readActions } from '../lib/orchestrator-actions.mjs';
import { ORCH_TOOL_DEFS } from '../lib/orchestrator-tools.mjs';
import { botOverseeInstructions } from '../lib/bots.mjs';

// The bot that oversees the owner's sessions sees every session of his projects, on this
// computer and on the other computers on them (his devbox), reads one there in full, and writes
// a note or an answer to one there. What it sends there goes in as a note of that computer's own
// bot that oversees the sessions, under the same rules it keeps here, never as the owner's words.

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const T0 = Date.now(), HOUR = 3600000;
const BOT = Object.freeze({ name: 'orchestrator', oversees: true, mcp: ['elu'] });
const DEVBOX = 'b'.repeat(64);
// As the devbox listed its sessions here, and the one this computer follows (Speedup).
const LISTED = [{
  key: DEVBOX, listedAt: new Date(T0 - 60000).toISOString(), projects: [{ id: 'c0ffee00c0ffee00', name: 'shop' }],
  sessions: [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ref: 'c0ffee00c0ffee00:27', project: 'c0ffee00c0ffee00', title: 'Speedup', state: 'answered', at: new Date(T0 - 6 * HOUR).toISOString(), question: null, error: null, plan: null, approvals: [], by: 'you', check: true, kept: true },
    { id: '11111111-1111-4111-8111-111111111111', ref: 'c0ffee00c0ffee00:69', project: 'c0ffee00c0ffee00', title: 'Deploy', state: 'needs_input', at: new Date(T0 - HOUR).toISOString(), question: 'Deploy to staging now?', error: null, plan: null, approvals: [], by: 'you' },
    { id: '22222222-2222-4222-8222-222222222222', ref: 'c0ffee00c0ffee00:5', project: 'c0ffee00c0ffee00', title: 'Login question', state: 'answered', at: new Date(T0 - HOUR).toISOString(), question: null, error: null, plan: null, approvals: [], by: 'teammate', who: 'sam' },
    { id: '33333333-3333-4333-8333-333333333333', ref: 'c0ffee00c0ffee00:3', project: 'c0ffee00c0ffee00', title: 'Old work', state: 'answered', at: new Date(T0 - HOUR).toISOString(), question: null, error: null, plan: null, approvals: [], by: 'you', archived: true },
  ],
}];
const VIEWS = [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', machine: DEVBOX, ref: 'c0ffee00c0ffee00:27', title: 'Speedup', state: 'answered', mode: 'full', model: 'Opus 5.5', ended: 'replied · check it',
  plan: { title: 'Speed round 1', state: 'approved', goal: 'Every page under 1 second', objectives: ['Checkout under 1 second', 'Search under 1 second'], met: [2], subtasks: [{ state: 'done' }, { state: 'open' }] },
  entries: [{ n: 1, role: 'You', at: new Date(T0 - 7 * HOUR).toISOString(), text: 'Run round 1.' }, { n: 2, role: '@lead', at: new Date(T0 - 6 * HOUR).toISOString(), text: 'The three load runs are used: checkout at 1.4 seconds. I need your decision on a fourth.' }] }];
function world(t, { level = 'act', online = true, views = VIEWS } = {}) {
  environment(t, { XDG_CONFIG_HOME: temp(t) }); forgetOverview();
  const root = path.join(temp(t), 'web'); fs.mkdirSync(root);
  const repo = projectFolder(root); registerProject(repo); setLevel(level);
  saveTask(repo, { id: '1', kind: 'conversation', base: null, branch: null, worktree: repo.root, goal: 'Oversee the sessions', botChat: 'orchestrator', state: 'answered', createdAt: new Date(T0 - HOUR).toISOString(), runs: [], messages: [], reviews: [], responses: [], sessions: {}, permissions: 'auto' });
  const w = { asked: [], sent: [], answer: 'allow', reply: { id: 'x', overseer: 'orchestrator' } };
  w.act = (name, input = {}) => act(name, input, { repo, task: readTask(repo, '1'), bot: BOT, mode: 'auto', run: 'run-1', now: T0, enqueue: () => { throw new Error('nothing is queued here'); }, startConductor: () => {},
    askOwner: question => { w.asked.push(question); return w.answer; }, servers: () => ({}), reached: () => new Map(),
    computers: () => [{ key: DEVBOX, name: 'devbox', online }], machines: () => LISTED, views: () => views, viewWaitMs: 50,
    peerCommand: async command => { w.sent.push(command); return w.reply; } });
  return w;
}
const blocks = text => text.split('\n').filter(line => /^[\[{]/.test(line)).map(line => JSON.parse(line));
const inBlock = text => blocks(text)[0];

test('sessions_list names every open session on the other computers too, what needs the owner first, and no archived one', async t => {
  const w = world(t);
  const out = await w.act('sessions_list');
  assert.equal(out.decision, 'allow');
  assert.match(out.text, /No session on this computer is open/);
  assert.match(out.text, /The sessions on the other computers of the owner's projects/);
  const lines = blocks(out.text).at(-1);
  assert.equal(lines.length, 3, out.text);
  assert.match(lines[0], /^Asks you: shop on @devbox #69 Deploy · Deploy to staging now\?/);
  assert.ok(lines.some(line => /Stopped: shop on @devbox #27 Speedup · ELU stopped starting it by itself/.test(line)), out.text);
  assert.ok(lines.some(line => /#5 Login question .*started by a teammate's message/.test(line)));
  assert.equal(out.text.includes('Old work'), false, 'an archived session is not listed');
});

test('session_read reads a session on the devbox by its computer: its Task, what it asks for and its last messages', async t => {
  const w = world(t);
  const out = await w.act('session_read', { computer: '@devbox', session: '27' });
  assert.equal(out.decision, 'allow', out.text);
  const value = inBlock(out.text);
  assert.equal(value.computer, '@devbox'); assert.equal(value.project, 'shop'); assert.equal(value.session, '27'); assert.equal(value.title, 'Speedup');
  assert.equal(value.state, 'Stopped'); assert.equal(value.access, 'Full access'); assert.equal(value.model, 'Opus 5.5');
  assert.deepEqual(value.task.objectives.map(row => row.met), [false, true]); assert.equal(value.task.steps, '1 of 2 done');
  assert.match(value.messages.at(-1).text, /1\.4 seconds/);
  assert.equal(w.sent.length, 0, 'a session this computer follows is read from its copy here');
  // A name it does not know, and a number the devbox does not list, are said plainly.
  assert.match((await w.act('session_read', { computer: 'laptop', session: '27' })).text, /No other computer on the owner's projects is named @laptop/);
  assert.match((await w.act('session_read', { computer: 'devbox', session: '3' })).text, /@devbox lists no open session 3/);
});

test('a session there that nothing here follows is followed first, then read', async t => {
  const w = world(t, { views: [] });
  const out = await w.act('session_read', { computer: 'devbox', project: 'shop', session: '69' });
  assert.deepEqual(w.sent, [{ type: 'remoteWatch', to: DEVBOX, ref: 'c0ffee00c0ffee00:69' }]);
  const value = inBlock(out.text);
  assert.equal(value.state, 'Asks you'); assert.equal(value.asks, 'Deploy to staging now?');
  assert.match(value.note, /did not come from that computer in time/);
});

test('a note to a session on the devbox goes through the devbox, marked as the bot\'s, after the owner\'s yes at every level', async t => {
  const w = world(t, { level: 'act' });
  const note = await w.act('session_message', { computer: 'devbox', session: '27', text: 'A fourth run cannot reach 1 second.' });
  assert.equal(note.decision, 'allow', note.text); assert.equal(note.by, 'owner', 'what leaves this computer is asked about, even at Act');
  assert.match(w.asked[0].title, /Send a note to shop on @devbox #27 'Speedup'/);
  assert.deepEqual(w.sent, [{ type: 'remoteSend', to: DEVBOX, ref: 'c0ffee00c0ffee00:27', text: 'A fourth run cannot reach 1 second.', overseer: 'orchestrator' }]);
  assert.match(note.text, /Sent to shop on @devbox #27 'Speedup'\. It shows there under @orchestrator, as a note and not as the owner's word\./);
  // An answer goes with the question it answers, as the devbox listed it.
  w.asked.length = 0;
  const answer = await w.act('session_answer', { computer: 'devbox', session: '69', text: 'Not before the tests pass.' });
  assert.equal(answer.decision, 'allow', answer.text); assert.equal(answer.by, 'owner');
  assert.deepEqual(w.sent.at(-1), { type: 'remoteSend', to: DEVBOX, ref: 'c0ffee00c0ffee00:69', text: 'Not before the tests pass.', overseer: 'orchestrator', answers: 'Deploy to staging now?' });
  assert.equal(readActions({ reads: false }).filter(row => row.decision === 'allow').length, 2);
  // He says no: nothing goes.
  w.answer = 'deny'; const before = w.sent.length;
  assert.equal((await w.act('session_message', { computer: 'devbox', session: '27', text: 'One more.' })).decision, 'deny');
  assert.equal(w.sent.length, before);
});

test('the bot writes to no session there that a teammate started, that asks nothing when it answers, or on a computer that is offline', async t => {
  const w = world(t);
  assert.match((await w.act('session_message', { computer: 'devbox', session: '5', text: 'Hi' })).text, /answers a teammate's message there/);
  assert.match((await w.act('session_answer', { computer: 'devbox', session: '27', text: 'Yes' })).text, /asks no question now/);
  assert.equal(w.sent.length, 0);
  const off = world(t, { online: false });
  const out = await off.act('session_message', { computer: 'devbox', session: '69', text: 'Hi' });
  assert.equal(out.decision, 'refused'); assert.match(out.text, /@devbox is offline/);
  // What the devbox refuses is the bot's answer, and nothing is said to be done.
  const refusing = world(t); refusing.act = (name, input) => act(name, input, { repo: readTask, task: {}, bot: BOT });
  assert.equal((await refusing.act('session_message', {})).decision, 'refused');
});

test('the tools say they reach the other computers, and its turn is told to look there before it says it cannot see a session', () => {
  for (const name of ['session_read', 'session_message', 'session_answer']) assert.ok(ORCH_TOOL_DEFS.find(row => row.name === name).inputSchema.properties.computer, name);
  assert.match(ORCH_TOOL_DEFS.find(row => row.name === 'sessions_list').description, /other computers of the owner's projects/);
  const told = botOverseeInstructions({ name: 'orchestrator', oversees: true, vendor: 'claude' });
  assert.match(told, /otherSessions/); assert.match(told, /Never say you cannot see a session on another computer before you looked for it there/);
});

// ---- The devbox's side: what it takes from the bot of the owner's other computer ----
function connection(key, hello = { remote: 1, shared: 1, oversee: 1 }) {
  const sent = [];
  return { key, admitted: true, remoteHello: hello, sent, notify: (method, params) => sent.push([method, params]), request: async () => { throw new Error('No answer'); } };
}
const context = (me, sessions = {}) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
function pair(t, hello) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), laptop = team.founder, devbox = team.member;
  const project = withHome(devbox.home, () => { const project = registeredProject(t); saveTeamAccess(team.teamId, { handling: 'auto', root: project.root }); shareProjects(devbox.identity.key, laptop.identity.key); return project; });
  withHome(laptop.home, () => shareProjects(laptop.identity.key, devbox.identity.key));
  const toHost = connection(laptop.identity.key), toViewer = connection(devbox.identity.key, hello);
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

test('the devbox takes a note of the bot from the owner\'s laptop as its own bot\'s, never as his words, and an answer only to the question it still asks', async t => {
  const { laptop, devbox, project, toHost, viewCtx, host } = pair(t);
  withHome(devbox.home, () => { chat(project.root, 1, { goal: 'Speedup' }); chat(project.root, 2, { goal: 'Deploy', state: 'needs_input', reply: { outcome: 'needs_input', question: 'Deploy to staging now?' } }); relist(); });
  await withHome(laptop.home, () => listTick(viewCtx));
  const listed = withHome(laptop.home, () => remoteMachines())[0].sessions, speedup = listed.find(row => row.title === 'Speedup'), rollout = listed.find(row => row.title === 'Deploy');
  assert.equal(rollout.question, 'Deploy to staging now?');
  const sent = await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteSend', to: devbox.identity.key, ref: speedup.ref, text: 'A fourth run cannot reach 1 second.', overseer: 'orchestrator' }));
  assert.equal(sent.overseer, 'orchestrator');
  const note = withHome(devbox.home, () => pendingRequests(project.root).find(row => row.goal === 'A fourth run cannot reach 1 second.'));
  assert.equal(note.overseer, 'orchestrator'); assert.equal(note.continuationTaskId, '1'); assert.equal(note.typed, undefined); assert.equal(note.computer, undefined, 'not his message from his other computer');
  // An answer carries the mark of the question it answers there.
  await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteSend', to: devbox.identity.key, ref: rollout.ref, text: 'Not before the tests pass.', overseer: 'orchestrator', answers: rollout.question }));
  const answer = withHome(devbox.home, () => pendingRequests(project.root).find(row => row.goal === 'Not before the tests pass.'));
  assert.equal(answer.asks, withHome(devbox.home, () => questionMark(readTask(repository(project.root), '2'))));
  // The question changed there in between: nothing goes in.
  const { id } = withHome(devbox.home, () => host['elu.remote.watch']({ ref: rollout.ref }, toHost));
  await withHome(devbox.home, () => assert.rejects(Promise.resolve().then(() => host['elu.remote.send']({ id, text: 'Yes', overseer: 'orchestrator', answers: 'Delete the cache?' }, toHost)), /asks another question now/));
  assert.equal(withHome(devbox.home, () => pendingRequests(project.root).some(row => row.goal === 'Yes')), false);
});

test('the devbox keeps the rules of the bot: no note to a bot\'s own chat or a Standup', async t => {
  const { devbox, project, toHost, host } = pair(t);
  withHome(devbox.home, () => { chat(project.root, 1, { goal: 'Notes', botChat: 'reviewer' }); chat(project.root, 2, { goal: 'Standup', standup: true }); relist(); });
  const listed = withHome(devbox.home, () => host['elu.remote.list']({}, toHost)).sessions;
  const before = withHome(devbox.home, () => pendingRequests(project.root).length);
  for (const [title, why] of [['Notes', /own chat with @reviewer/], ['Standup', /is a Standup session/]]) {
    const row = listed.find(item => item.title === title);
    assert.ok(row, `${title} is listed there`);
    const { id } = withHome(devbox.home, () => host['elu.remote.watch']({ ref: row.ref }, toHost));
    await withHome(devbox.home, () => assert.rejects(Promise.resolve().then(() => host['elu.remote.send']({ id, text: 'Go on', overseer: 'orchestrator' }, toHost)), why));
  }
  assert.equal(withHome(devbox.home, () => pendingRequests(project.root).length), before, 'nothing was queued');
});

test('a laptop never sends a note of the bot to a devbox whose ELU cannot keep its mark', async t => {
  const { laptop, devbox, project, viewCtx } = pair(t, { remote: 1, shared: 1 });
  withHome(devbox.home, () => { chat(project.root, 1, { goal: 'Speedup' }); relist(); });
  await withHome(laptop.home, () => listTick(viewCtx));
  const speedup = withHome(laptop.home, () => remoteMachines())[0].sessions.find(row => row.title === 'Speedup');
  await assert.rejects(withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteSend', to: devbox.identity.key, ref: speedup.ref, text: 'Hi', overseer: 'orchestrator' })), { message: OVERSEE_UPDATE('@' + devbox.identity.key.slice(0, 4)) });
  assert.equal(withHome(devbox.home, () => pendingRequests(project.root).length), 0);
});
