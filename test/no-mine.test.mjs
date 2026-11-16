import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTeam, newHome, withHome, registeredProject } from './peer-helpers.mjs';
import { repository } from '../lib/git.mjs';
import crypto from 'node:crypto';
import { readTask, saveTask } from '../lib/state.mjs';
import { createConversation } from '../lib/runner.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { fromTeammate } from '../lib/modes.mjs';
import { archivedRecord } from '../lib/projects.mjs';
import { boardRows } from '../lib/board.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import * as inviteStore from '../lib/peer/invite.mjs';
import { merge, readLog } from '../lib/peer/roster.mjs';
import { keepTeamRoot, share, setTeamProject } from '../lib/peer/shares.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { hostMethods, hostTick, listTick, projectKey, relist, remoteCommand, remoteConnected, remoteMachines, remoteSessions, viewMethods, viewTick } from '../lib/peer/remote.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import { COMMANDS, parseCommand } from '../lib/terminal-commands.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';
import * as peerFacade from '../lib/peer/index.mjs';
import { otherSessions } from '../lib/peer/session-tools.mjs';

const { createInvite, redeemCode } = inviteStore;

// The owner's cases (README, "A shared project"): there is no "mine". An invite shares the
// project, and every computer on it sees it and works on it under the project's access rules
// on the computer that runs it, the owner's own computers included. Nothing reaches a project
// that was never shared, whatever an older ELU marked.

function chat(root, id, goal) {
  const at = new Date().toISOString();
  saveTask(repository(root), { id: String(id), kind: 'conversation', goal, state: 'answered', worktree: root, base: null, branch: null, createdAt: at, runs: [], reviews: [], responses: [], messages: [], sessions: {}, result: null, activeRole: null });
}
function addMember(t, team, name) {
  const home = newHome(t), identity = withHome(home, () => createIdentity({ name }));
  const log = withHome(team.founder.home, () => { redeemCode(createInvite(team.founder.identity, team.teamId, { hours: 1 }), identity.key, name); return readLog(team.teamId).ops; });
  for (const side of [home, team.member.home]) withHome(side, () => { const { rejected } = merge(team.teamId, log); if (rejected.length) throw new Error(rejected[0].reason); });
  return { home, identity };
}
// /invite in a project: shared with the team, its project, and where teammates' work runs.
const invited = (team, side, root, handling) => withHome(side.home, () => { const row = share(root, { teams: [team.teamId] }); setTeamProject(team.teamId, row.handle); saveTeamAccess(team.teamId, { root, ...(handling ? { handling } : {}) }); });
function connection(key, hello = { remote: 1, shared: 1 }) {
  const sent = [];
  return { key, admitted: true, remoteHello: hello, sent, notify: (method, params) => sent.push([method, params]), request: async () => { throw new Error('No answer'); } };
}
const context = (me, sessions = {}, events = []) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: text => events.push(text) });
function link(viewer, host) {
  const toHost = connection(viewer.identity.key), toViewer = connection(host.identity.key);
  const hostCtx = context(host.identity, { [viewer.identity.key]: toHost }), viewCtx = context(viewer.identity, { [host.identity.key]: toViewer });
  const methods = hostMethods(hostCtx);
  toViewer.request = async (method, params) => withHome(host.home, () => { relist(); return methods[method](params, toHost); });
  return { toHost, toViewer, hostCtx, viewCtx, methods };
}
// What an ELU from 0.1.26 to 0.1.33 left in peer/mine.json: the two computers marked each
// other, or (claim) only the other one said this computer is its own.
function markedOld(side, other, { claim = false } = {}) {
  const file = withHome(side.home, () => peerFile('mine.json')), at = new Date().toISOString();
  fs.mkdirSync(file.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ [other.identity.key]: { ...(claim ? {} : { at }), theirs: true, theirsAt: at } }));
  return file;
}
const START = { type: 'remoteStart', text: 'Fix the login page', permissions: 'ask', place: null, model: null, bots: [] };

test('The owner\'s devbox, once marked as his, reaches only the shared project on his Mac, and its work waits for a yes there until the project is Auto', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ana' }), mac = team.founder, devbox = team.member;
  const elu = withHome(mac.home, () => registeredProject(t)), secret = withHome(mac.home, () => registeredProject(t));
  invited(team, mac, elu.root, 'manual');
  withHome(mac.home, () => { chat(elu.root, 1, 'Fix the login page'); chat(secret.root, 1, 'Private plans'); relist(); });
  const before = [markedOld(mac, devbox), markedOld(devbox, mac)].map(file => fs.readFileSync(file, 'utf8'));
  const ab = link(devbox, mac);
  // The devbox lists the Mac's shared project and its session, never the project not shared.
  await withHome(devbox.home, () => listTick(ab.viewCtx));
  const listed = withHome(devbox.home, () => remoteMachines().find(row => row.key === mac.identity.key));
  assert.deepEqual(listed.sessions.map(row => row.title), ['Fix the login page']);
  assert.equal(listed.projects.length, 1);
  assert.equal(listed.topAgents ?? null, null, 'top agents cover every project, so they stay on the Mac');
  // Manual: a new session waits for a yes on the Mac.
  await withHome(devbox.home, () => remoteCommand(ab.viewCtx, { ...START, to: mac.identity.key }));
  const waiting = withHome(mac.home, () => pendingRequests(elu.root));
  assert.deepEqual(waiting.map(row => row.state), ['waiting'], JSON.stringify(waiting));
  assert.equal(withHome(mac.home, () => pendingRequests(secret.root)).length, 0);
  // The project it was never given cannot be picked either.
  await assert.rejects(withHome(devbox.home, () => remoteCommand(ab.viewCtx, { ...START, to: mac.identity.key, folder: secret.root })), /Pick one of the folders listed/);
  // Auto: the next one runs at once.
  withHome(mac.home, () => saveTeamAccess(team.teamId, { handling: 'auto', root: elu.root }));
  await withHome(devbox.home, () => remoteCommand(ab.viewCtx, { ...START, to: mac.identity.key }));
  assert.deepEqual(withHome(mac.home, () => pendingRequests(elu.root)).map(row => row.state).sort(), ['queued', 'waiting']);
  // The old marks give nothing and are left as they were.
  assert.deepEqual([mac, devbox].map(side => fs.readFileSync(withHome(side.home, () => peerFile('mine.json')), 'utf8')), before);
});

// What waits for a yes is not a failure and is not to be sent again. The computer that sent it
// is told it waits (waits), and its state and its message say so by a key of their own (yes),
// beside the words an ELU up to 0.1.33 shows for them; the message names the computer it came
// from (computer), so no other computer reads it as its own.
test('A new session and a message that wait for a yes say so to the computer that sent them, by a key of their own', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ana' }), mac = team.founder, devbox = team.member;
  const elu = withHome(mac.home, () => registeredProject(t));
  invited(team, mac, elu.root, 'manual');
  withHome(mac.home, () => { chat(elu.root, 1, 'Fix the login page'); relist(); });
  const ab = link(devbox, mac), views = viewMethods(ab.viewCtx);
  let clock = Date.now();
  // The Mac looks at its sessions and tells the devbox, which takes it in.
  const told = async () => {
    const from = ab.toHost.sent.length;
    withHome(mac.home, () => hostTick(ab.hostCtx, clock += 1000));
    const pushed = ab.toHost.sent.slice(from).filter(([method]) => method === 'elu.remote.events');
    withHome(devbox.home, () => { for (const [, params] of pushed) views['elu.remote.events'](params, ab.toViewer); });
    await withHome(devbox.home, () => viewTick(ab.viewCtx));
  };
  const started = await withHome(devbox.home, () => remoteCommand(ab.viewCtx, { ...START, text: 'List the big files', to: mac.identity.key }));
  assert.equal(started.waits, true, 'the devbox is told its new session waits');
  assert.equal(started.projectId, projectKey(elu.root), 'and which project it went to, by the id the Mac lists it under');
  await told();
  const fresh = withHome(devbox.home, () => remoteSessions().find(row => row.id === started.id));
  assert.deepEqual([fresh.state, fresh.yes], ['blocked', true], JSON.stringify(fresh));
  assert.match(fresh.error, /^Waits for a yes on @\S+\.$/);
  // A message into a session there.
  await withHome(devbox.home, () => listTick(ab.viewCtx));
  const ref = withHome(devbox.home, () => remoteMachines().find(row => row.key === mac.identity.key)).sessions.find(row => row.title === 'Fix the login page').ref;
  await withHome(devbox.home, () => remoteCommand(ab.viewCtx, { type: 'remoteWatch', to: mac.identity.key, ref }));
  await told();
  const view = () => withHome(devbox.home, () => remoteSessions().find(row => row.ref === ref));
  const sent = await withHome(devbox.home, () => remoteCommand(ab.viewCtx, { type: 'remoteSend', id: view().id, text: 'Keep the logo as it is' }));
  assert.equal(sent.waits, true, 'the devbox is told its message waits');
  await told();
  const [held] = view().waiting ?? [];
  assert.ok(held, JSON.stringify(view()));
  assert.deepEqual([held.text, held.state, held.yes, held.computer], ['Keep the logo as it is', 'blocked', true, devbox.identity.key], JSON.stringify(held));
  assert.match(held.reason, /^Waits for a yes on @\S+\.$/);
});

test('A teammate\'s computer, never marked, works on the shared project exactly as the owner\'s own computer does', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ana' }), mac = team.founder;
  const grok = addMember(t, team, 'ben');
  const elu = withHome(mac.home, () => registeredProject(t));
  invited(team, mac, elu.root, 'auto');
  const gm = link(grok, mac);
  await withHome(grok.home, () => remoteCommand(gm.viewCtx, { ...START, to: mac.identity.key }));
  assert.deepEqual(withHome(mac.home, () => pendingRequests(elu.root)).map(row => row.state), ['queued']);
  // Manual: what it asks waits for the owner there, and a rename is refused with what to do.
  withHome(mac.home, () => saveTeamAccess(team.teamId, { handling: 'manual', root: elu.root }));
  withHome(mac.home, () => { chat(elu.root, 7, 'Write the notes'); relist(); });
  const ref = withHome(mac.home, () => gm.methods['elu.remote.list']({}, gm.toHost)).sessions.find(row => row.title === 'Write the notes').ref;
  // The line is the Mac's own half: the computer that asked puts "@mac: " before it. Nothing of
  // a rename waits for a yes, so it says where to do it and what would let it through.
  const rename = () => withHome(mac.home, () => gm.methods['elu.remote.rename']({ ref, title: 'Notes' }, gm.toHost));
  assert.throws(rename, error => { assert.equal(error.message, 'This project takes its work by hand. Do it there, or set /access to Auto there.'); return true; });
});

// The owner's devbox: it joined the project from its home folder, so its project is that
// folder, and an ELU up to 0.1.33 took what his Mac asked there because it was marked his.
// With no mark, the home folder takes that work by itself only once he says so there, in
// /access (y to the home folder question) or with elu access --auto --home: nothing an update
// or an older row gives it. Until then each start and message waits for his yes there.
test('A computer whose project is its home folder takes the project\'s work by itself once its owner allows that there, and not before', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ana' }), mac = team.founder, devbox = team.member;
  const home = withHome(devbox.home, () => registeredProject(t));
  const previous = process.env.HOME; process.env.HOME = home.root; t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
  // As elu join in the home folder left it: Auto with no project saved, and the home folder, its
  // one project, kept as the team's project there (project-share.mjs onlyProject). It is never shared by hand.
  withHome(devbox.home, () => { keepTeamRoot(team.teamId, home.root); saveTeamAccess(team.teamId, { handling: 'auto' }); chat(home.root, 3, 'Write the notes'); relist(); });
  assert.throws(() => withHome(devbox.home, () => share(home.root, { teams: [team.teamId] })), /Your home folder cannot be shared/);
  assert.throws(() => withHome(devbox.home, () => saveTeamAccess(team.teamId, { root: home.root })), /Your home folder cannot be the project teammates work in/);
  const md = link(mac, devbox), states = () => withHome(devbox.home, () => pendingRequests(home.root)).map(row => row.state);
  const ref = withHome(devbox.home, () => md.methods['elu.remote.list']({}, md.toHost)).sessions.find(row => row.title === 'Write the notes').ref;
  const rename = title => withHome(devbox.home, () => md.methods['elu.remote.rename']({ ref, title }, md.toHost));
  // Not allowed yet: it waits for a yes there, and the line says what would let it through.
  assert.equal((await withHome(mac.home, () => remoteCommand(md.viewCtx, { ...START, to: devbox.identity.key }))).waits, true);
  assert.deepEqual(states(), ['waiting']);
  assert.throws(() => rename('Notes'), error => { assert.equal(error.message, 'This project takes its work by hand. Do it there, or set /access to Auto there.'); return true; });
  // Only the home folder itself is allowed this way, and only with Auto.
  assert.throws(() => withHome(devbox.home, () => saveTeamAccess(team.teamId, { handling: 'auto', root: home.parent, home: true })), /Only your home folder itself is allowed this way/);
  assert.throws(() => withHome(devbox.home, () => saveTeamAccess(team.teamId, { handling: 'manual', root: home.root, home: true })), /allowed only with Auto/);
  // He allows it: the row keeps no project, as before, and says home.
  const saved = withHome(devbox.home, () => saveTeamAccess(team.teamId, { handling: 'auto', root: home.root, home: true }));
  assert.deepEqual([saved.handling, saved.root, saved.home], ['auto', null, true]);
  assert.equal((await withHome(mac.home, () => remoteCommand(md.viewCtx, { ...START, text: 'List the big files', to: devbox.identity.key }))).waits, undefined);
  assert.deepEqual(states().sort(), ['queued', 'waiting']);
  rename('Notes');
  // A change of the rules keeps it; Manual takes it back, and Auto again does not bring it back by itself.
  assert.equal(withHome(devbox.home, () => saveTeamAccess(team.teamId, { rules: 'Never print a key.' })).home, true);
  assert.equal(withHome(devbox.home, () => saveTeamAccess(team.teamId, { handling: 'manual' })).home, undefined);
  assert.equal(withHome(devbox.home, () => saveTeamAccess(team.teamId, { handling: 'auto' })).home, undefined);
  assert.throws(() => rename('Notes again'), /takes its work by hand/);
  // A row an ELU up to 0.1.34 saved over it has no home: by hand, as that ELU keeps it.
  withHome(devbox.home, () => { saveTeamAccess(team.teamId, { handling: 'auto', root: home.root, home: true }); const file = peerFile('access.json'), all = JSON.parse(fs.readFileSync(file, 'utf8')); delete all[team.teamId].home; fs.writeFileSync(file, JSON.stringify(all)); });
  assert.throws(() => rename('Notes again'), /takes its work by hand/);
  // A folder above the home folder is never allowed.
  process.env.HOME = `${home.root}/src`; fs.mkdirSync(process.env.HOME, { recursive: true });
  assert.throws(() => withHome(devbox.home, () => saveTeamAccess(team.teamId, { handling: 'auto', root: home.root, home: true })), /Only your home folder itself is allowed this way/);
  assert.throws(() => rename('Notes again'), error => { assert.equal(error.message, 'Its project holds its whole home folder, where work is always by hand. Do it there.'); return true; });
});

test('An older ELU that claims this computer as its own is taken silently: nothing is marked, said or granted', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), mac = team.founder, grok = team.member;
  const events = [], toGrok = connection(grok.identity.key), ctx = context(mac.identity, { [grok.identity.key]: toGrok }, events);
  withHome(mac.home, () => viewMethods(ctx)['elu.mine']({ mine: true }, toGrok));
  assert.deepEqual(events, []);
  assert.equal(withHome(mac.home, () => fs.existsSync(peerFile('mine.json'))), false);
  // On connect nothing is said about whose computer either is.
  withHome(mac.home, () => remoteConnected(ctx, toGrok));
  assert.deepEqual(toGrok.sent.filter(([method]) => method === 'elu.mine'), []);
});

// A session another computer on the project started here (elu.remote.start) is that computer's,
// whoever owns it: it is a member's, as a teammate's message is, so its words never teach this
// computer's memory and the board names who started it.
test('A session another computer started here is a member\'s: its words stay out of the lessons, and the board names that computer\'s person', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), mac = team.founder, grok = team.member;
  withHome(mac.home, () => {
    const elu = registeredProject(t), repo = repository(elu.root);
    const task = createConversation(repo, defaultConfig(), 'Rewrite the release notes in the voice of Tidal Otter', { mine: { machine: grok.identity.key, name: 'ben', remoteId: crypto.randomUUID() } });
    saveTask(repo, { ...readTask(repo, task.id), state: 'answered', messages: [] });
    const origin = readTask(repo, task.id).origin;
    assert.equal(fromTeammate(origin), true);
    assert.doesNotMatch(JSON.stringify(archivedRecord(repo, readTask(repo, task.id))), /Tidal Otter/);
    const [row] = boardRows([{ root: elu.root, name: 'elu', tasks: [readTask(repo, task.id)] }]).filter(item => item.id === task.id);
    assert.ok(row); assert.equal(row.agent, '@ben');
  });
});

test('/mine answers one line, is not listed, and no computer says it is yours', async t => {
  assert.equal(COMMANDS.some(command => command.name === 'mine'), false);
  assert.equal(parseCommand('/mine @devbox').name, 'mine');
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), mac = team.founder, grok = team.member;
  markedOld(mac, grok, { claim: true });
  const status = { key: mac.identity.key, teams: [{ members: [{ key: grok.identity.key, name: 'ben', box: 'grok', online: true }] }] };
  const glue = withHome(mac.home, () => remoteGlue({ facade: peerFacade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false, roots: () => [] }));
  assert.equal(withHome(mac.home, () => glue.asking().size), 0);
  assert.equal(withHome(mac.home, () => glue.asks()), null);
  assert.equal(await withHome(mac.home, () => glue.mine(['@grok'])), 'Every computer on a project works the same: there is nothing to mark.');
  await assert.rejects(withHome(mac.home, () => remoteCommand(context(mac.identity), { type: 'mine', key: grok.identity.key })), /nothing to mark/);
});

// The two tools a session has for other computers (lib/approval-server.mjs) reach every
// computer on a team with this one, a teammate's too: their words to the model say so, and the
// helper that sends with them (lib/remote-helper.mjs) is told the same.
test('The session tools and the helper say the other computers may be another person\'s, as the list they reach is', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'sara' }), mac = team.founder;
  const listed = withHome(mac.home, () => otherSessions());
  assert.ok(listed.computers.some(row => row.computer === '@sara'), JSON.stringify(listed));
  const source = fs.readFileSync(new URL('../lib/approval-server.mjs', import.meta.url), 'utf8');
  const list = /name: LIST_TOOL, description: "([^"]+)"/.exec(source)[1], send = /name: SEND_TOOL, description: "([^"]+)"/.exec(source)[1];
  for (const text of [list, send]) { assert.match(text, /may be another person's/); assert.doesNotMatch(text, /the owner's other computers|as the owner's/); }
  assert.match(send, /reaches that session as one from this computer, under that project's access rules there/);
  const { helperInstructions } = await import('../lib/remote-helper.mjs');
  for (const canSend of [true, false]) assert.doesNotMatch(helperInstructions({ name: 'devbox', remoteId: crypto.randomUUID() }, { canSend }), /owner's other computer|his other computer|as the owner's message/);
});
