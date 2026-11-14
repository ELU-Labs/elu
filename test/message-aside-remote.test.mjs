import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTeam, withHome, registeredProject } from './peer-helpers.mjs';
import { fakeClis } from './helpers.mjs';
import { markMine, noteTheirs } from '../lib/peer/mine.mjs';
import { hostMethods, hostTick, remoteCommand, remoteSessions, viewMethods } from '../lib/peer/remote.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { pendingRequests, projectFolder } from '../lib/workspace.mjs';
import { Conductor } from '../lib/conductor.mjs';
import { remoteRow } from '../lib/board.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';
import { readTask } from '../lib/state.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { ASIDE_ANSWERED } from '../lib/message-aside.mjs';

// The owner's case: from one computer he writes to a session that works on his other one, on
// a vendor whose turn takes no message. The computer the session runs on answers beside the
// turn (test/message-aside.test.mjs), with no window open there: only its conductor and its
// daemon run. The computer he typed on is told at once what happens, and shows the answer.
function connection(key) {
  const sent = [];
  return { key, admitted: true, remoteHello: { remote: 1 }, sent, notify: (method, params) => sent.push([method, params]), request: async () => { throw new Error('No answer'); } };
}
const context = (me, sessions = {}) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
// Two computers of one owner, each marked as the other's: here (he types on it) and there (the session runs on it).
function pair(t) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), here = team.founder, there = team.member;
  const project = withHome(there.home, () => { const project = registeredProject(t, { origin: 'https://github.com/acme/shop.git' }); saveTeamAccess(team.teamId, { root: project.root }); markMine(there.identity.key, here.identity.key); noteTheirs(here.identity.key, true); return project; });
  withHome(here.home, () => { markMine(here.identity.key, there.identity.key); noteTheirs(there.identity.key, true); });
  const toHost = connection(here.identity.key), toViewer = connection(there.identity.key);
  const hostCtx = context(there.identity, { [here.identity.key]: toHost }), viewCtx = context(here.identity, { [there.identity.key]: toViewer });
  const host = hostMethods(hostCtx), viewer = viewMethods(viewCtx);
  toViewer.request = async (method, params) => withHome(there.home, () => host[method](params, toHost));
  return { here, there, project, toHost, hostCtx, viewCtx, host, viewer };
}
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function until(check, message, timeout = 20000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const BESIDE = 'You are not that turn: you run beside it';

test('a message from my other computer to a session whose turn takes none is answered beside the turn there, with no window open there, and shows here; one that asks for work says so, and Enter here starts it there', { timeout: 90000 }, async t => {
  const { here, there, project, toHost, hostCtx, viewCtx, host, viewer } = pair(t);
  // The computer the session runs on: a stand-in Codex whose turn never ends, while a run beside it answers at once.
  const fake = fakeClis(project.parent, { mode: 'slow' }), file = path.join(fake.dir, 'fake.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), byInput: [
    { includes: 'Rename the helper', set: { mode: 'normal', summary: 'The turn is running the tests now. Your message starts when it ends.' } },
    { includes: BESIDE, set: { mode: 'answer', summary: 'Two of three steps are done. It is running the tests now.' } }] }));
  const names = [...Object.keys(fake.env), 'HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME'], previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  // He starts the session from here, in Full access, before anything runs there.
  const started = await withHome(here.home, () => remoteCommand(viewCtx, { type: 'remoteStart', to: there.identity.key, text: 'Tidy the coupon module', permissions: 'full', place: null, model: null, bots: [] }));
  Object.assign(process.env, fake.env, { HOME: project.parent, CODEX_HOME: path.join(project.parent, 'codex-home'), XDG_CONFIG_HOME: there.home });
  new ProjectController(projectFolder(project.root)).setDefaultModel({ vendor: 'codex' });
  // There, nothing but the conductor runs it: no window is open.
  const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop());
  const repo = projectFolder(project.root), task = () => { try { return readTask(repo, '1'); } catch { return null; } };
  const turns = () => rows(path.join(project.parent, 'inputs.jsonl')).filter(row => row.vendor === 'codex' && row.args[0] === 'exec' && !row.input.includes(BESIDE));
  await until(() => task()?.state === 'running' && task().activeDeaf === true, 'the turn works there and takes no message');
  // One look there, and what it sends arrives here.
  let delivered = 0;
  const look = () => {
    hostTick(hostCtx, Date.now());
    const events = toHost.sent.filter(([method]) => method === 'elu.remote.events');
    for (const [, params] of events.slice(delivered)) withHome(here.home, () => viewer['elu.remote.events'](params, connection(there.identity.key)));
    delivered = events.length;
  };
  const seen = () => withHome(here.home, () => remoteSessions().find(row => row.id === started.id));
  const app = remoteGlue({ facade: { mineRows: () => [{ key: there.identity.key, mine: true, theirs: true }], remoteSessions: () => [] }, peerRead: () => null, peerCommand: async () => ({}), chatMessage: ({ title, text }) => `${title}: ${text}`, ink: text => text, colour: false });
  const pane = () => app.view(remoteRow(seen(), 'box'), 140);
  look(); assert.equal(seen().state, 'running');
  // A question, typed here: that computer says at once what its running turn does with it.
  const asked = Date.now();
  assert.deepEqual(host['elu.remote.send']({ id: started.id, text: 'How far are you?' }, toHost), { id: started.id, working: true, takes: 'beside' });
  const question = pendingRequests(project.root).find(row => row.goal === 'How far are you?');
  await until(() => pendingRequests(project.root).find(row => row.id === question.id)?.state === 'done', 'the answer beside the turn, there');
  assert.ok(Date.now() - asked < 10000, 'within seconds');
  assert.equal(task().state, 'running', 'the turn there goes on');
  look();
  assert.deepEqual(seen().entries.slice(-3).map(entry => [entry.role.replace(/^.* · /, '· '), entry.text, entry.update === true, entry.line === true]), [['You', 'How far are you?', false, false], ['· beside the turn', 'Two of three steps are done. It is running the tests now.', true, false], ['ELU', ASIDE_ANSWERED, false, true]]);
  assert.equal(seen().waiting?.length ?? 0, 0, 'nothing of it is left to run');
  // Under the working line there, where he typed it, so a turn with many steps never pushes it out of sight.
  assert.match(pane(), /Working on @box\n[\s\S]*You → @box: How far are you\?\n\n[^\n]+ on @box · beside the turn: Two of three steps are done\. It is running the tests now\.\n\nAnswered beside the running turn, from what it has done so far\. The turn goes on\.\n\n(?:Catching up with @box…\n\n)?Runs on @box/);
  assert.doesNotMatch(pane(), /\(waiting\)|current turn ends/);
  // An instruction: answered beside the turn too, it says that it asks for work, and it keeps its place there.
  assert.deepEqual(host['elu.remote.send']({ id: started.id, text: 'Rename the helper too' }, toHost), { id: started.id, working: true, takes: 'beside' });
  const work = pendingRequests(project.root).find(row => row.goal === 'Rename the helper too');
  look();
  assert.match(pane(), /You → @box \((answered in a moment|being answered now|answered · starts when this turn ends)\): Rename the helper too\n/, 'from the first look it says what happens');
  await until(() => pendingRequests(project.root).find(row => row.id === work.id)?.aside?.state === 'answered', 'its answer beside the turn');
  look();
  const [item] = seen().waiting;
  assert.deepEqual([item.state, item.takes, item.aside.state, item.aside.text], ['turn', 'beside', 'answered', 'The turn is running the tests now. Your message starts when it ends.']);
  assert.equal(seen().held, 1, 'this computer knows one message can be sent now');
  assert.match(pane(), /You → @box \(answered · starts when this turn ends\): Rename the helper too\n\n[^\n]+ on @box · beside the turn: The turn is running the tests now\. Your message starts when it ends\.\nAnswered beside the running turn, from what it has done so far\. The turn goes on\.\nIt asks for work, so it also starts the next turn when this one ends\.\nEnter in the empty box sends it now: that stops the turn on @box and the command that is running\n/);
  // Enter in the empty box here: the turn there stops, and the message starts the next one in the same thread.
  assert.deepEqual(host['elu.remote.stop']({ id: started.id, now: true }, toHost), { stopping: true });
  await until(() => turns().some(row => row.input.includes('Rename the helper too')), 'the next turn there started with it', 40000);
  assert.deepEqual(turns().find(row => row.input.includes('Rename the helper too')).args.slice(0, 3), ['exec', 'resume', '12345678-1234-4234-8234-123456789abc']);
  look();
  assert.ok(seen().entries.some(entry => entry.role === 'You' && entry.text === 'Rename the helper too'), 'it is a message of the chat here now');
  assert.equal(seen().waiting?.length ?? 0, 0);
});
