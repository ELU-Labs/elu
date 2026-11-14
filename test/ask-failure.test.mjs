import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { project, fakeClis } from './helpers.mjs';
import { makeTeam, withHome, registeredProject } from './peer-helpers.mjs';
import { repository } from '../lib/git.mjs';
import { registerProject } from '../lib/projects.mjs';
import { saveTask } from '../lib/state.mjs';
import { Conductor } from '../lib/conductor.mjs';
import { uncheckedText } from '../lib/conformance.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { createIdentity, loadIdentity } from '../lib/peer/identity.mjs';
import { createTeam, teams as everyTeam } from '../lib/peer/roster.mjs';
import { createInvite, redeemCode } from '../lib/peer/invite.mjs';
import { share } from '../lib/peer/shares.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { markMine, noteTheirs } from '../lib/peer/mine.mjs';
import { savePeerPolicy, savePeerSettings } from '../lib/peer/settings.mjs';
import { message, task as a2aTask, TaskState } from '../lib/peer/a2a.mjs';
import { intakeMethods } from '../lib/peer/intake.mjs';
import { acceptIncoming, processOutbox } from '../lib/peer/replies.mjs';
import { getRecord } from '../lib/peer/taskstore.mjs';
import { applyTask, createAsk, getAsk } from '../lib/peer/asks.mjs';
import { hostMethods } from '../lib/peer/remote.mjs';
import { peerItems } from '../lib/peer/index.mjs';
import { boardRows, remoteRow, rowBadge, rowTitle } from '../lib/board.mjs';
import { teamPanes, visible } from '../lib/terminal-visuals.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';

// A message from another computer started a session here, and the session failed. The
// one who sent it is told why, and the one thing to do, in words that name this computer.
// The answering computer is kai's; ana sent the message.
const ANA = 'a'.repeat(64), STOP_MS = 20000;
const LIVE = new WeakMap();
function giveUp(text) { console.error(`ask-failure.test: ${text} Ending the test process.`); process.exit(1); }
after(() => { setTimeout(() => giveUp('Something is still running 10 s after the last test.'), 10000).unref(); });
// A project and the stand-in vendors in a home of its own, which is kai's computer.
function setup(t, mode = 'normal') {
  LIVE.set(t, []);
  t.after(async () => {
    for (const conductor of LIVE.get(t)) { const late = setTimeout(() => giveUp('A conductor did not stop.'), STOP_MS); try { await conductor.stop(); } finally { clearTimeout(late); } }
  });
  const p = project(t), fake = fakeClis(p.parent, { mode });
  const previous = { PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  Object.assign(process.env, fake.env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const repo = repository(p.root); registerProject(repo);
  return { ...p, ...fake, repo };
}
function conduct(t) { const conductor = new Conductor({ tickMs: 20 }).start(); LIVE.get(t).push(conductor); return conductor; }
async function until(check, what, timeout = 20000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
// Kai's daemon as far as a message goes: ana is on his team, and send() delivers one of
// hers as the wire would. shared: the project is the one teammates' messages run in.
function answering(p, { shared = true } = {}) {
  const me = createIdentity({ name: 'kai' }), team = createTeam(me, 'core');
  redeemCode(createInvite(me, team.id, { hours: 1 }), ANA, 'ana');
  if (shared) share(p.root, { teams: everyTeam().map(state => state.id), handle: 'shop' });
  const pushed = [], ctx = { me, kick: () => {}, event: () => {}, push: (key, task) => pushed.push({ key, task }) }, methods = intakeMethods(ctx);
  const send = (text = 'add a note to the readme') => {
    const sent = methods.SendMessage({ message: message({ text, contextId: crypto.randomUUID(), messageId: crypto.randomUUID(), ext: { kind: 'ask', project: shared ? 'shop' : null, hop: 1, from: { key: ANA, name: 'ana' } } }) }, { key: ANA });
    return getRecord(sent.id);
  };
  return { me, team, ctx, send, pushed };
}
const said = task => task.status.message?.parts?.map(part => part.text).join(' ') ?? null;
// A message of ana's that started a session here, and how that session ended: what the
// conductor writes for the daemon, and the session as it is kept. Returns what ana is told.
let serial = 0;
function ended(p, kai, { error = null, outcome = 'failed', text = null, session = null }) {
  const record = kai.send();
  acceptIncoming(kai.ctx, record.task.id, { how: 'own' });
  const requestId = getRecord(record.task.id).requestId, id = String(100 + ++serial), now = new Date().toISOString();
  if (session) saveTask(p.repo, { id, kind: 'conversation', goal: 'add a note to the readme', state: 'blocked', worktree: p.root, base: null, branch: null, createdAt: now, runs: [], reviews: [], responses: [], messages: [], sessions: {}, result: null, activeRole: null, ...session, error: { message: error, ...session.error } });
  fs.mkdirSync(peerFile('outbox'), { recursive: true });
  fs.writeFileSync(peerFile('outbox', `${requestId}.json`), JSON.stringify({ requestId, root: p.root, origin: { kind: 'handoff', peer: ANA, name: 'ana', a2aTaskId: record.task.id, threadId: record.threadId, hop: 1, own: true }, taskId: session ? id : null, outcome, text, costUsd: 0, finishedAt: now, error }));
  processOutbox(kai.ctx);
  const sent = getRecord(record.task.id).task;
  assert.equal(sent.status.state, TaskState.FAILED);
  assert.deepEqual(kai.pushed.at(-1), { key: ANA, task: sent }, 'the teammate is told at once');
  return said(sent);
}

test('a teammate\'s message to a computer whose model is signed out comes back with why and the one thing to do there', async t => {
  const p = setup(t, 'signed-out'), kai = answering(p);
  const record = kai.send('add a note to the readme');
  acceptIncoming(kai.ctx, record.task.id, { how: 'own' });
  const requestId = getRecord(record.task.id).requestId, outbox = peerFile('outbox', `${requestId}.json`);
  conduct(t);
  await until(() => fs.existsSync(outbox), 'the run to end');
  assert.match(JSON.parse(fs.readFileSync(outbox, 'utf8')).error, /^Claude Code is signed out\. Run claude to sign in, then send again\.$/, 'the conductor hands the daemon the reason');
  processOutbox(kai.ctx);
  const sent = getRecord(record.task.id).task;
  assert.equal(sent.status.state, TaskState.FAILED);
  assert.equal(said(sent), 'Claude Code is signed out. Sign Claude Code in on @kai, then send it again.');
  assert.deepEqual(kai.pushed.at(-1), { key: ANA, task: sent });
});

test('each way a session a teammate\'s message started can fail is told in plain words, with the one thing to do', t => {
  const p = setup(t), kai = answering(p);
  const claude = { runs: [{ role: 'lead', vendor: 'claude' }] };
  // The model's command line is signed out, not installed, or its one-time check is not done.
  assert.equal(ended(p, kai, { error: 'Grok Build is signed out. Run grok login to sign in, then send again.', session: {} }), 'Grok Build is signed out. Sign Grok Build in on @kai, then send it again.');
  assert.equal(ended(p, kai, { error: 'Claude could not finish.', session: { ...claude, error: { cause: 'auth' } } }), 'Claude could not finish: Claude Code is signed out. Sign Claude Code in on @kai, then send it again.');
  assert.equal(ended(p, kai, { error: 'Grok Build is not installed or not on your PATH.', session: {} }), 'Grok Build is not installed or not on its PATH. Install Grok Build on @kai, then send it again.');
  assert.equal(uncheckedText('grok'), 'Grok Build (the grok command) has not been checked on this machine yet. Your first message to it outside Full access runs the check; Full access needs none.');
  // The check is run there with c in the Usage tab, in any mode: a message runs it only below Full access.
  assert.equal(ended(p, kai, { error: uncheckedText('grok'), session: {} }), 'Grok Build (the grok command) has not been checked on @kai yet. Run the check of Grok Build with c on its line in the Usage tab of ELU on @kai, then send it again.');
  assert.equal(ended(p, kai, { error: 'Grok Build (the grok command) did not pass its check on this machine (not proven: it asks before it writes). Your next message to it outside Full access runs the check again.', session: {} }),
    'Grok Build (the grok command) did not pass its check on @kai (not proven: it asks before it writes). Run the check of Grok Build with c on its line in the Usage tab of ELU on @kai, then send it again.');
  // The run was stopped there, or ended with nothing to send.
  assert.equal(ended(p, kai, { error: 'Stopped by the owner.', outcome: 'stopped', session: { state: 'stopped' } }), 'It was stopped on @kai before it finished. Send it again.');
  assert.equal(ended(p, kai, { outcome: 'done', text: '  ' }), 'The session on @kai ended without an answer. Send it again.');
  assert.equal(ended(p, kai, { error: 'The run was interrupted.' }), 'The run was interrupted on @kai. Send it again.');
  // A limit was hit: the account's, the time one turn may run, the session's budget.
  const log = path.join(p.parent, 'limit.jsonl'); fs.writeFileSync(log, `${JSON.stringify({ type: 'result', is_error: true, result: 'You\'ve hit your weekly limit · resets 3pm' })}\n`);
  assert.equal(ended(p, kai, { error: 'Claude could not finish.', session: { runs: [{ role: 'lead', vendor: 'claude', logFile: log }], error: { cause: 'quota', logFile: log } } }),
    'Claude could not finish: the account hit its weekly limit (resets 3pm). Switch account in Usage on @kai, then send it again.');
  assert.equal(ended(p, kai, { error: 'Claude could not finish.', session: { ...claude, error: { cause: 'rate-limit' } } }), 'Claude could not finish: the account hit its rate limit. Switch account in Usage on @kai, or send it again.');
  assert.equal(ended(p, kai, { error: 'Stopped after 10 minutes with no output. Reply to carry on.', session: { ...claude, error: { cause: 'quiet', timedOut: true, stoppedBy: 'quiet' } } }), 'Stopped after 10 minutes with no output on @kai. Send it again.');
  assert.equal(ended(p, kai, { error: 'Claude could not finish.', session: { ...claude, budgetUsd: 5, runs: [{ role: 'lead', vendor: 'claude', costUsd: 5 }], error: { cause: 'quota' } } }), 'Claude has spent its $5 limit in that session. /budget 20 raises it on @kai, then send it again.');
  // The vendor refused the run: its own words stay.
  assert.equal(ended(p, kai, { error: 'Claude could not run: Your credit balance is too low to access the Anthropic API.', session: { ...claude, error: { cause: 'quota', vendorSaid: { status: 400, code: null, model: null } } } }),
    'Claude could not run on @kai: Your credit balance is too low to access the Anthropic API. Send it again.');
  assert.equal(ended(p, kai, { error: 'Claude could not finish.', session: { ...claude, error: { cause: 'model-unavailable' } } }), 'Claude could not finish: that model is not available. Choose another with /model on @kai, then send it again.');
  // Never just that it failed, and never longer than a sender on 0.1.19 keeps.
  const long = ended(p, kai, { error: `Claude could not run: ${'the vendor went on and on '.repeat(30)}.`, session: { ...claude, error: { vendorSaid: { status: 500 } } } });
  assert.ok(long.length <= 300 && long.endsWith('… Send it again.'), long);
});

test('a teammate gets the reason with paths cut, a trusted one and my own computer with paths kept, and a possible secret stays here', t => {
  const p = setup(t), kai = answering(p), place = '/srv/kai/private/notes.txt';
  const error = `Refusing a symbolic link at ${place}`;
  // A message that has a project to run in waits for the owner's y, and says so to its sender with what the owner can do.
  assert.equal(said(kai.send().task), 'It waits for its owner on @kai, who approves each message from a teammate. On @kai: y on the message starts it, and /access set to Auto starts the next ones without asking.');
  assert.equal(ended(p, kai, { error, session: {} }), 'Refusing a symbolic link at [path] on @kai. Send it again.');
  assert.equal(ended(p, kai, { error: 'Could not read the settings: API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789', session: {} }), 'The run failed on @kai. Its reason stays there: it may hold a secret.');
  savePeerPolicy(ANA, { trusted: true });
  assert.equal(ended(p, kai, { error, session: {} }), `Refusing a symbolic link at ${place} on @kai. Send it again.`);
  // Ana's key is another computer of kai's own: it reads this one by its machine name.
  savePeerPolicy(ANA, { trusted: false }); savePeerSettings({ box: 'Devbox' });
  markMine(kai.me.key, ANA); noteTheirs(ANA, true);
  assert.equal(ended(p, kai, { error, session: {} }), `Refusing a symbolic link at ${place} on @devbox. Send it again.`);
  assert.equal(ended(p, kai, { error: 'Grok Build is signed out. Run grok login to sign in, then send again.', session: {} }), 'Grok Build is signed out. Sign Grok Build in on @devbox, then send it again.');
});

test('a message to a computer with no project for teammates\' messages waits there, and its sender is told why', t => {
  const p = setup(t), kai = answering(p, { shared: false });
  const record = kai.send();
  assert.equal(record.waiting, true); assert.equal(record.root, null); assert.equal(record.task.status.state, TaskState.SUBMITTED);
  assert.equal(said(record.task), 'No project is set on @kai for teammates\' messages, so it waits for its owner. On @kai: open ELU in the project teammates work in, then use /access there.');
});

const rowsOf = (items, width) => teamPanes({ status: { key: 'f'.repeat(64), teams: [] }, agents: [], items }, [30, 30, width], false)[2].map(row => visible(row.line));
test('the sender keeps the reason, and Chats shows it whole: failed, why, and the one thing to do', t => {
  const crew = makeTeam(t, { founderName: 'ana', memberName: 'kai' }), kai = crew.member.identity.key;
  withHome(crew.founder.home, () => {
    const ctx = { me: loadIdentity(), event: () => {}, kick: () => {}, dial: () => {}, session: () => null };
    const failed = (reason, state = TaskState.FAILED) => {
      const ask = createAsk(ctx, { to: 'kai', text: 'add a note to the readme', byOwner: true });
      applyTask(ctx, kai, a2aTask({ id: crypto.randomUUID(), contextId: ask.threadId, state, ...(reason === undefined ? {} : { statusMessage: reason }) }), ask.id);
      return ask.id;
    };
    const why = 'Claude Code is signed out. Sign Claude Code in on @kai, then send it again.';
    const told = failed(why);
    assert.equal(getAsk(told).state, 'failed'); assert.equal(getAsk(told).reason, why);
    // A teammate on 0.1.19 says only that it failed.
    const old = failed('The run failed.'), stopped = failed('The run was stopped.'), silent = failed(undefined);
    assert.equal(getAsk(old).reason, 'The run failed on @kai. Update ELU there to see why.');
    assert.equal(getAsk(stopped).reason, 'The run was stopped on @kai. Update ELU there to see why.');
    assert.equal(getAsk(silent).reason, 'The run failed on @kai. Update ELU there to see why.');
    const declined = failed('The owner declined this request.', TaskState.REJECTED);
    assert.equal(getAsk(declined).reason, 'The owner declined this request.');
    // One that failed before this release kept only "The run failed.": its row is told the same way.
    const before = failed(why), file = peerFile('asks', `${before}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), reason: 'The run failed.' }));
    const items = peerItems(), item = id => items.find(row => row.id === `rejected:${id}`);
    assert.equal(item(told).state, 'failed'); assert.equal(item(told).text, why); assert.equal(item(told).question, 'add a note to the readme');
    assert.equal(item(before).text, 'The run failed on @kai. Update ELU there to see why.');
    // 140 columns: one row under the message. 80 columns: it wraps, and nothing is cut.
    assert.deepEqual(rowsOf([item(told)], 100), ['→ you asked @kai · add a note to the readme', '   ↳ failed · Claude Code is signed out. Sign Claude Code in on @kai, then send it again.']);
    for (const [id, text] of [[told, why], [old, 'The run failed on @kai. Update ELU there to see why.']]) {
      const [message, ...reply] = rowsOf([item(id)], 46);
      assert.equal(message, '→ you asked @kai · add a note to the readme');
      assert.ok(reply.length > 1 && reply.every(row => row.length <= 46), reply.join('|'));
      assert.ok(reply[0].startsWith('   ↳ failed · ') && reply.slice(1).every(row => /^ {5}\S/.test(row)), reply.join('|'));
      assert.equal(reply.map(row => row.trim()).join(' '), `↳ failed · ${text}`);
    }
    assert.deepEqual(rowsOf([item(declined)], 100), ['→ you asked @kai · add a note to the readme', '   ↳ rejected · The owner declined this request.']);
    // Its row in Sessions says failed too, with the reason as its text; one the owner there declined says rejected.
    const inSessions = id => boardRows([], Date.now(), { items: [item(id)] }).find(row => row.kind === 'peer');
    assert.equal(inSessions(told).label, 'failed'); assert.equal(rowBadge(inSessions(told)).title, 'ask failed · @kai'); assert.equal(inSessions(told).now, why);
    assert.equal(inSessions(declined).label, 'rejected'); assert.equal(rowBadge(inSessions(declined)).title, 'ask rejected · @kai'); assert.equal(inSessions(declined).now, 'The owner declined this request.');
    // A message that waits there says what it waits for.
    const waits = 'No project is set on @kai for teammates\' messages, so it waits for its owner. On @kai: open ELU in the project teammates work in, then use /access there.';
    const waiting = createAsk(ctx, { to: 'kai', text: 'and this one?', byOwner: true });
    applyTask(ctx, kai, a2aTask({ id: 'task-waits', contextId: waiting.threadId, statusMessage: waits }), waiting.id);
    const row = peerItems().find(item => item.id === `asked:${waiting.id}`);
    assert.equal(row.state, 'submitted'); assert.equal(row.note, waits);
    assert.equal(rowsOf([row], 200)[1], `   ↳ submitted · ${waits}`);
    // Once it runs, the note is gone.
    applyTask(ctx, kai, a2aTask({ id: 'task-waits', contextId: waiting.threadId, state: TaskState.WORKING }));
    assert.equal(peerItems().find(item => item.id === `asked:${waiting.id}`).note, undefined);
  });
});

// A connection as the daemon hands it to a method, from the owner's laptop.
const connection = key => ({ key, admitted: true, remoteHello: { remote: 1 }, sent: [], notify() {}, request: async () => { throw new Error('No answer'); } });
test('a session on my other computer that failed lists and shows there with the same words, naming that computer', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), laptop = team.founder, devbox = team.member;
  const shop = withHome(devbox.home, () => { const shop = registeredProject(t); saveTeamAccess(team.teamId, { root: shop.root }); savePeerSettings({ box: 'devbox' }); markMine(devbox.identity.key, laptop.identity.key); noteTheirs(laptop.identity.key, true); return shop; });
  const ctx = { me: devbox.identity, session: () => null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} };
  const host = hostMethods(ctx), from = connection(laptop.identity.key);
  const listed = await withHome(devbox.home, () => {
    const at = new Date().toISOString(), base = { kind: 'conversation', worktree: shop.root, base: null, branch: null, createdAt: at, runs: [], reviews: [], responses: [], messages: [], sessions: {}, result: null, activeRole: null };
    saveTask(repository(shop.root), { ...base, id: '1', goal: 'add a note to the readme', state: 'blocked', origin: { kind: 'mine', mine: true, machine: laptop.identity.key, name: 'ana', remoteId: crypto.randomUUID() }, error: { message: 'Grok Build is signed out. Run grok login to sign in, then send again.' } });
    // One that is not waiting for its owner keeps its error as it is.
    saveTask(repository(shop.root), { ...base, id: '2', goal: 'an older one', state: 'answered', error: { message: 'An older note.' } });
    return host['elu.remote.list']({ since: null, after: null, limit: 100 }, from);
  });
  const row = id => listed.sessions.find(session => session.ref.endsWith(`:${id}`));
  assert.equal(row(1).error, 'Grok Build is signed out. Sign Grok Build in on @devbox, then send it again.');
  assert.equal(row(2).error, 'An older note.');
  // Sessions on the laptop shows it on that session's row.
  const shown = remoteRow({ id: 'r1', machine: devbox.identity.key, state: 'blocked', title: 'add a note to the readme', error: row(1).error, createdAt: new Date().toISOString() }, 'devbox');
  assert.equal(shown.now, 'Grok Build is signed out. Sign Grok Build in on @devbox, then send it again.');
  // Its row ends with the one thing to do, in a few words, where there is room for all of it.
  assert.equal(rowTitle(shown), 'on devbox · add a note to the readme · sign Grok Build in');
  assert.equal(rowTitle(shown, Date.now(), 57), 'on devbox · add a note to the readme · sign Grok Build in');
  assert.equal(rowTitle(shown, Date.now(), 56), 'on devbox · add a note to the readme');
  assert.equal(rowTitle({ ...shown, grouped: true }), 'add a note to the readme · sign Grok Build in');
  // One that works, or ended well, says nothing more.
  assert.equal(rowTitle(remoteRow({ id: 'r2', machine: devbox.identity.key, state: 'answered', title: 'an older one', createdAt: new Date().toISOString() }, 'devbox')), 'on devbox · an older one');
});

// Seen in the real app at 80x24: the reason filled a row of the pane, the pane wrapped that
// row a second time, and "Code" of "Sign Claude Code in" stood on a row of its own.
test('the reason of a session on my other computer is wrapped one column short of its pane, so the pane never wraps a row of it again', () => {
  const glue = remoteGlue({ facade: { mineRows: () => [], remoteSessions: () => [] }, peerRead: () => null, peerCommand: async () => ({}), chatMessage: ({ title, text }) => `${title}\n${text}`, ink: text => text, colour: false });
  const row = remoteRow({ id: 'r1', machine: 'd'.repeat(64), state: 'blocked', title: 'fix typo', error: 'Claude Code is signed out. Sign Claude Code in on @devbox, then send it again.', entries: [], steps: [], approvals: [], createdAt: new Date().toISOString() }, 'devbox');
  const reason = width => glue.parts(row, width).find(part => part.key.startsWith('error')).text.split('\n');
  // The pane beside the list at 80 columns holds 43: its first row would be exactly as wide.
  assert.deepEqual(reason(43), ['Claude Code is signed out. Sign Claude', 'Code in on @devbox, then send it again.']);
  assert.deepEqual(reason(103), ['Claude Code is signed out. Sign Claude Code in on @devbox, then send it again.']);
});
