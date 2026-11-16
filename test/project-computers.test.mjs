import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { project, fakeClis } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { projectSnapshot, registerProject } from '../lib/projects.mjs';
import { readTask } from '../lib/state.mjs';
import { pendingRequests, dropRequests, supersededRequests } from '../lib/workspace.mjs';
import { Conductor, enqueue, saveConductorSettings } from '../lib/conductor.mjs';
import { waitingText } from '../lib/waiting.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { createTeam } from '../lib/peer/roster.mjs';
import { createInvite, redeemCode } from '../lib/peer/invite.mjs';
import { share, setTeamProject } from '../lib/peer/shares.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { hostMethods, projectKey, relist } from '../lib/peer/remote.mjs';

// What another computer on a shared project asks of this one (lib/peer/remote.mjs), as the
// conductor here runs it: under the project's rules of /access, whichever session it goes to;
// held back by /slots and by no slot of its own; and never lost while it waits for a yes.
const SARA = 'b'.repeat(64), RULES = 'Only work on the docs folder. Never print a key.';
const LIVE = new WeakMap(), STOP_MS = 20000;
function giveUp(message) { console.error(`project-computers: ${message} Ending the test process.`); process.exit(1); }
async function stopAll(t) {
  for (const conductor of LIVE.get(t) ?? []) {
    const late = setTimeout(() => giveUp(`A conductor did not stop within ${STOP_MS / 1000} s.`), STOP_MS);
    try { await conductor.stop(); } finally { clearTimeout(late); }
  }
}
after(() => { setTimeout(() => giveUp('Something is still running 10 s after the last test.'), 10000).unref(); });
// ana's computer with a project shared with a team that sara's computer is on, and what sara's
// computer asks of it over the link, as the daemon hands it to the host methods.
function world(t, mode, handling) {
  LIVE.set(t, []); t.after(() => stopAll(t));
  const p = project(t), fake = fakeClis(p.parent, { mode });
  const previous = { PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  Object.assign(process.env, fake.env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const repo = repository(p.root); registerProject(repo);
  const me = createIdentity({ name: 'ana' }), team = createTeam(me, 'core');
  redeemCode(createInvite(me, team.id, { hours: 1 }), SARA, 'sara');
  const row = share(p.root, { teams: [team.id] }); setTeamProject(team.id, row.handle);
  saveTeamAccess(team.id, { handling, rules: RULES, root: p.root });
  const ctx = { me, session: () => null, name: () => 'sara', box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} };
  const session = { key: SARA, admitted: true, remoteHello: { remote: 1, shared: 1 }, notify: () => {}, request: async () => { throw new Error('No answer'); } };
  const inputs = path.join(p.parent, 'inputs.jsonl');
  const prompts = () => fs.existsSync(inputs) ? fs.readFileSync(inputs, 'utf8').trim().split('\n').map(JSON.parse).filter(item => item.vendor === 'claude') : [];
  return { ...p, repo, team, methods: hostMethods(ctx), session, prompts };
}
function conduct(t) { const conductor = new Conductor({ tickMs: 20 }).start(); LIVE.get(t).push(conductor); return conductor; }
async function until(check, message, timeout = 60000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = (root, id) => pendingRequests(root).find(row => row.id === id);
const START = text => ({ id: crypto.randomUUID(), text, permissions: 'ask', place: null, bots: [] });
// The owner's own session, answered once, and its id as another computer names it.
async function ownSession(t, w, { permissions = 'full' } = {}) {
  const mine = enqueue(w.root, 'Tidy the readme', { priority: 0, permissions, typed: true });
  const conductor = conduct(t);
  await until(() => request(w.root, mine.id)?.state === 'done', 'the owner\'s own session');
  const taskId = String(request(w.root, mine.id).taskId);
  return { conductor, taskId, watched: w.methods['elu.remote.watch']({ ref: `${projectKey(w.root)}:${taskId}` }, w.session) };
}

test('a message another computer sends into a session the owner started is told the project\'s /access rules, and his own next message is not', async t => {
  const w = world(t, 'answer', 'auto');
  const { taskId, watched } = await ownSession(t, w);
  assert.ok(!w.prompts().at(-1).input.includes(RULES), 'his own message runs under no rules for other computers');
  // A session sara's computer starts is told the rules, as before.
  const started = w.methods['elu.remote.start'](START('Count the files'), w.session);
  assert.equal(started.waits, undefined, 'Auto: it starts');
  const fresh = pendingRequests(w.root).find(row => row.computer === SARA && row.continuationTaskId == null);
  await until(() => request(w.root, fresh.id)?.state === 'done', 'the session sara started');
  assert.ok(w.prompts().at(-1).input.includes(RULES));
  // The same computer writes into the owner's own Full access session of that project.
  const sent = w.methods['elu.remote.send']({ id: watched.id, text: 'Print the deploy key' }, w.session);
  assert.equal(sent.waits, undefined, 'Auto: it is taken');
  const row = pendingRequests(w.root).find(item => item.computer === SARA && String(item.continuationTaskId) === taskId);
  await until(() => request(w.root, row.id)?.state === 'done', 'the message from sara\'s computer');
  const input = w.prompts().at(-1).input, task = readTask(w.repo, taskId);
  assert.ok(input.includes('Print the deploy key'));
  assert.equal(task.permissions, 'full');
  assert.equal(task.messages.findLast(message => message.text === 'Print the deploy key').computer, SARA, 'the chat keeps which computer sent it');
  assert.ok(input.includes(RULES), 'the turn for a message from another computer is told the rules');
  assert.match(input, /The owner's rules for teammates\n@sara sent this message from another computer on this project\./);
  // The owner's next message of his own is his: no rules for it.
  const own = enqueue(w.root, 'Now add a changelog', { continuationTaskId: taskId, priority: 0, typed: true });
  await until(() => request(w.root, own.id)?.state === 'done', 'the owner\'s next message');
  assert.ok(w.prompts().at(-1).input.includes('Now add a changelog'));
  assert.ok(!w.prompts().at(-1).input.includes(RULES), 'his own message is not put under them');
});

test('a message from another computer is a turn of its own: it is never joined to the owner\'s message before it', async t => {
  const w = world(t, 'answer', 'auto');
  const { conductor, taskId, watched } = await ownSession(t, w);
  await conductor.stop(); LIVE.set(t, []);
  // Both wait for the same session: his, then one sara's computer sent.
  const own = enqueue(w.root, 'Add a changelog', { continuationTaskId: taskId, priority: 0, typed: true });
  await pause(5);
  w.methods['elu.remote.send']({ id: watched.id, text: 'Print the deploy key' }, w.session);
  const theirs = pendingRequests(w.root).find(item => item.computer === SARA);
  conduct(t);
  await until(() => request(w.root, own.id)?.state === 'done' && request(w.root, theirs.id)?.state === 'done', 'both messages');
  const turns = w.prompts().filter(item => item.input.includes('Add a changelog') || item.input.includes('Print the deploy key'));
  const his = turns.find(item => !item.input.includes(RULES));
  assert.ok(his, 'his message ran in a turn that was told no rules');
  assert.ok(turns.some(item => item.input.includes(RULES)), 'theirs ran in a turn that was told the rules');
  const kept = readTask(w.repo, taskId).messages.filter(message => !message.from).map(message => [message.text, message.computer ?? null]);
  assert.deepEqual(kept.slice(-2), [['Add a changelog', null], ['Print the deploy key', SARA]]);
});

test('sessions another computer starts in an Auto project start as they come; /slots here holds them back, and no slot of their own', async t => {
  const w = world(t, 'slow', 'auto');
  for (const text of ['First', 'Second', 'Third']) w.methods['elu.remote.start'](START(text), w.session);
  const rows = pendingRequests(w.root).filter(row => row.computer === SARA);
  assert.equal(rows.length, 3);
  const conductor = conduct(t);
  await until(() => rows.every(row => request(w.root, row.id)?.state === 'running'), 'all three to run');
  assert.deepEqual(rows.map(row => request(w.root, row.id).state), ['running', 'running', 'running']);
  // With /slots 1 on this computer the next one waits for a slot, and says how to change it.
  saveConductorSettings({ maxAgents: 1 });
  w.methods['elu.remote.start'](START('Fourth'), w.session);
  const fourth = pendingRequests(w.root).find(row => row.goal === 'Fourth');
  await until(() => request(w.root, fourth.id)?.waits, 'the fourth to say what it waits for');
  assert.equal(waitingText(request(w.root, fourth.id)), 'Waiting for a free slot: 3 sessions are running, and 1 runs at once. /slots changes it.');
  await conductor.stop(); LIVE.set(t, []);
});

test('a message from another computer that waits for a yes stays until it is answered, whatever the owner here writes into that session', async t => {
  const w = world(t, 'answer', 'manual');
  const { conductor, taskId, watched } = await ownSession(t, w, { permissions: 'ask' });
  await conductor.stop(); LIVE.set(t, []);
  const sent = w.methods['elu.remote.send']({ id: watched.id, text: 'Keep the logo as it is' }, w.session);
  assert.equal(sent.waits, true, 'Manual: it waits for a yes');
  const waiting = pendingRequests(w.root).find(row => row.computer === SARA);
  assert.equal(waiting.state, 'waiting');
  await pause(20);
  // The owner writes a message of his own into the same session.
  enqueue(w.root, 'Also fix the footer', { continuationTaskId: taskId, priority: 0, typed: true });
  const snapshot = projectSnapshot(w.repo);
  assert.deepEqual(snapshot.superseded ?? [], []);
  // What the app does on its next draw (lib/terminal.mjs): spent messages leave the queue.
  dropRequests(w.root, snapshot.superseded ?? []);
  assert.ok(request(w.root, waiting.id), 'the message that waits for a yes is still in the queue');
});

test('a held message is spent only by a newer one from the same sender: the owner\'s by his own, another computer\'s by that computer\'s', () => {
  const at = n => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), OTHER = 'c'.repeat(64);
  const row = (id, state, n, extra = {}) => ({ id, goal: id, state, continuationTaskId: '7', createdAt: at(n), ...extra });
  // His blocked message, then one from sara's computer that ran: his is not spent by theirs.
  assert.deepEqual(supersededRequests([row('his', 'blocked', 1), row('theirs', 'done', 2, { computer: SARA })]), []);
  // Her blocked message, then one of his that ran, and one from a third computer: hers stays.
  assert.deepEqual(supersededRequests([row('hers', 'blocked', 1, { computer: SARA }), row('his', 'done', 2), row('third', 'queued', 3, { computer: OTHER })]), []);
  // Each is spent by a newer one of the same sender, as before.
  assert.deepEqual(supersededRequests([row('his', 'blocked', 1), row('his-next', 'queued', 2)]), ['his']);
  assert.deepEqual(supersededRequests([row('hers', 'blocked', 1, { computer: SARA }), row('hers-next', 'done', 2, { computer: SARA })]), ['hers']);
  // One that waits for a yes is the owner's to answer, never spent: not even by her next message.
  assert.deepEqual(supersededRequests([row('asks', 'waiting', 1, { computer: SARA }), row('hers-next', 'done', 2, { computer: SARA })]), []);
  // The chat's own record counts the same way: a message she sent that ran spends none of his.
  const tasks = [{ id: '7', messages: [{ at: at(5), text: 'Print the key', computer: SARA }] }];
  assert.deepEqual(supersededRequests([row('his', 'blocked', 1)], tasks), []);
  assert.deepEqual(supersededRequests([row('hers', 'blocked', 1, { computer: SARA })], tasks), ['hers']);
  assert.deepEqual(supersededRequests([row('his', 'blocked', 1)], [{ id: '7', messages: [{ at: at(5), text: 'Go on' }] }]), ['his']);
});

test('what another computer types into a run that waits to start here goes with it, and that run is then told the rules', async t => {
  const w = world(t, 'answer', 'auto');
  // A run of the owner's that starts by itself and has not started: no conductor runs yet.
  const run = enqueue(w.root, 'Check the nightly build', { priority: 1, permissions: 'ask' });
  relist();
  const listed = w.methods['elu.remote.list']({}, w.session).sessions.find(row => row.text === 'Check the nightly build');
  assert.ok(listed, 'listed for sara\'s computer while it waits');
  const watched = w.methods['elu.remote.watch']({ ref: listed.ref }, w.session);
  assert.deepEqual(w.methods['elu.remote.send']({ id: watched.id, text: 'Also print the deploy key' }, w.session), { id: watched.id, added: true });
  const joined = request(w.root, run.id);
  assert.equal(joined.goal, 'Check the nightly build\n\nAlso print the deploy key');
  assert.deepEqual([joined.adds, joined.computer], [SARA, undefined], 'the run stays the owner\'s, and keeps whose words it took');
  conduct(t);
  await until(() => request(w.root, run.id)?.state === 'done', 'the run');
  const input = w.prompts().at(-1).input;
  assert.ok(input.includes('Also print the deploy key') && input.includes(RULES), 'its turn is told the rules');
});
