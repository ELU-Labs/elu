import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTeam, newHome, withHome, registeredProject } from './peer-helpers.mjs';
import { repository } from '../lib/git.mjs';
import { saveTask } from '../lib/state.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { createInvite, redeemCode } from '../lib/peer/invite.mjs';
import { merge, readLog } from '../lib/peer/roster.mjs';
import { share, setTeamProject, setBoardOff } from '../lib/peer/shares.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { saveLearned } from '../lib/project-learnings.mjs';
import { readProjectSettings, saveInstructions } from '../lib/project-settings.mjs';
import { nameProject } from '../lib/projects.mjs';
import { splitContext } from '../lib/project-notes.mjs';
import { notesRows, notesTick, takeNotes } from '../lib/peer/notes.mjs';
import { saveTold, teammateProjects, toldProjects } from '../lib/peer/shared.mjs';
import { hostMethods, hostTick, listTick, relist, remoteCommand, remoteMachines, remoteSessions, viewMethods, viewTick } from '../lib/peer/remote.mjs';
import { boxKeys, remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';
import { rowActions, rowTitle } from '../lib/board.mjs';
import * as peerFacade from '../lib/peer/index.mjs';

// The owner's cases (README, "Teams"): an invite shares the project. Every computer that joined
// it has the same project, sees its sessions from every other one, and has the same
// instructions, context and lessons, with nothing to pair or link. Nobody here is "mine".

// A chat session as the app saves one.
function chat(root, id, { goal = `Session ${id}`, state = 'answered', messages = [] } = {}) {
  const at = new Date().toISOString();
  saveTask(repository(root), { id: String(id), kind: 'conversation', goal, state, worktree: root, base: null, branch: null, createdAt: at, runs: [], reviews: [], responses: [], messages, sessions: {}, result: null, activeRole: null });
}
// A third person on the team: invited by the founder, known to every member.
function addMember(t, team, name) {
  const home = newHome(t), identity = withHome(home, () => createIdentity({ name }));
  const log = withHome(team.founder.home, () => { redeemCode(createInvite(team.founder.identity, team.teamId, { hours: 1 }), identity.key, name); return readLog(team.teamId).ops; });
  for (const side of [home, team.member.home]) withHome(side, () => { const { rejected } = merge(team.teamId, log); if (rejected.length) throw new Error(rejected[0].reason); });
  return { home, identity };
}
// /invite in a project, as the app does it: the project is shared with the team, is the team's
// project, and teammates' sessions run in it.
function invited(team, side, root) {
  withHome(side.home, () => { const row = share(root, { teams: [team.teamId] }); setTeamProject(team.teamId, row.handle); saveTeamAccess(team.teamId, { root }); });
}
// /join in a project folder of one's own, as the app does it.
const joined = (team, side, root) => withHome(side.home, () => saveTeamAccess(team.teamId, { root }));
// A connection the daemon hands a method: admitted, on this build (shared: 1) unless told otherwise.
function connection(key, hello = { remote: 1, shared: 1 }) {
  const sent = [];
  return { key, admitted: true, remoteHello: hello, sent, notify: (method, params) => sent.push([method, params]), request: async () => { throw new Error('No answer'); } };
}
const context = (me, sessions = {}) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
// Viewer and host joined by calls, as two daemons are: the viewer asks, the host answers in its own home.
function link(viewer, host, hello) {
  const toHost = connection(viewer.identity.key, hello), toViewer = connection(host.identity.key, hello);
  const hostCtx = context(host.identity, { [viewer.identity.key]: toHost }), viewCtx = context(viewer.identity, { [host.identity.key]: toViewer });
  const methods = hostMethods(hostCtx), views = viewMethods(viewCtx);
  // One process holds every home here: what a host listed last is read again in its own.
  toViewer.request = async (method, params) => withHome(host.home, () => { relist(); return methods[method](params, toHost); });
  return { toHost, toViewer, hostCtx, viewCtx, methods, views };
}
// What Sessions shows on side with the project at root open: its headings and session titles.
function sessionsShown(side, root, names) {
  const status = { key: side.identity.key, teams: [{ members: Object.entries(names).map(([key, value]) => ({ key, ...value })) }] };
  const glue = remoteGlue({ facade: peerFacade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false, roots: () => [root] });
  return withHome(side.home, () => glue.sections(Date.now(), root).flatMap(line => line.header ? [`# ${line.header}`] : line.row ? [rowTitle(line.row)] : line.sub ? [`## ${line.sub}`] : []));
}

test('A invites B to the project ELU and B joins in a folder of its own: each sees the other\'s ELU sessions under that computer, and never a project not shared', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member;
  const elu = withHome(a.home, () => registeredProject(t)), secret = withHome(a.home, () => registeredProject(t)), mine = withHome(b.home, () => registeredProject(t));
  invited(team, a, elu.root); joined(team, b, mine.root);
  withHome(a.home, () => { chat(elu.root, 1, { goal: 'Fix the login page', messages: [{ at: new Date().toISOString(), text: 'Fix the login page' }, { at: new Date().toISOString(), from: '@lead', bot: 'lead', lead: true, text: 'Fixed: the form posts again.' }] }); chat(secret.root, 1, { goal: 'Private plans' }); relist(); });
  withHome(b.home, () => { chat(mine.root, 1, { goal: 'Write the release notes' }); relist(); });
  const names = { [a.identity.key]: { name: 'ana', box: 'box-one', online: true }, [b.identity.key]: { name: 'ben', box: 'studio', online: true } };

  // B lists A's sessions: the ELU one, and not the one in A's project that was never shared.
  const ab = link(b, a);
  await withHome(b.home, () => listTick(ab.viewCtx));
  const listed = withHome(b.home, () => remoteMachines().find(row => row.key === a.identity.key));
  assert.ok(listed, 'B lists A');
  assert.deepEqual(listed.sessions.map(row => row.title), ['Fix the login page']);
  assert.deepEqual(listed.projects.map(row => row.name).length, 1, 'only the shared project is told');
  // In B's Sessions with its ELU open: A's session under A's computer and its owner.
  const shown = sessionsShown(b, mine.root, names);
  assert.ok(shown.includes('# On box-one · ana'), JSON.stringify(shown));
  assert.ok(shown.includes('Fix the login page'), JSON.stringify(shown));
  assert.ok(!shown.some(line => /Private plans/.test(line)), JSON.stringify(shown));
  // Its Kanban has it as a card to read, and Projects counts it in B's ELU.
  const glueB = () => remoteGlue({ facade: peerFacade, peerRead: () => ({ key: b.identity.key, teams: [{ members: Object.entries(names).map(([key, value]) => ({ key, ...value })) }] }), peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false, roots: () => [mine.root] });
  assert.deepEqual(withHome(b.home, () => glueB().teamCards(mine.root)).map(person => [person.name, person.sessions.map(card => [card.title, card.column])]), [['ana', [['Fix the login page', 'needs']]]]);
  assert.equal(withHome(b.home, () => glueB().counts(Date.now(), [mine.root]).get(mine.root).sessions), 1);
  // Opened, it shows its chat: B follows it and A sends its events.
  const ref = listed.sessions[0].ref;
  await withHome(b.home, () => remoteCommand(ab.viewCtx, { type: 'remoteWatch', to: a.identity.key, ref }));
  withHome(a.home, () => hostTick(ab.hostCtx));
  const pushed = ab.toHost.sent.filter(([method]) => method === 'elu.remote.events');
  assert.ok(pushed.length, 'A sends the events of the session B opened');
  withHome(b.home, () => { for (const [, params] of pushed) ab.views['elu.remote.events'](params, ab.toViewer); });
  await withHome(b.home, () => viewTick(ab.viewCtx));
  const view = withHome(b.home, () => remoteSessions().find(row => row.ref === ref));
  assert.ok(view.entries.some(entry => entry.text === 'Fixed: the form posts again.'), JSON.stringify(view.entries));
  // Seeing is not acting: B cannot write to it, stop it or start one on A.
  await assert.rejects(withHome(b.home, () => remoteCommand(ab.viewCtx, { type: 'remoteSend', id: view.id, text: 'hi', typed: true })));
  await assert.rejects(withHome(b.home, () => remoteCommand(ab.viewCtx, { type: 'remoteStart', to: a.identity.key, text: 'hi', permissions: 'ask', place: null, model: null, bots: [] })));
  // The project A never shared cannot be watched by its place either.
  const hidden = withHome(a.home, () => ab.methods['elu.remote.list']({}, ab.toHost)).sessions.map(row => row.ref);
  assert.equal(hidden.length, 1);
  // A row of A's computer here only opens and shows its changes.
  withHome(a.home, () => nameProject(repository(elu.root), 'ELU')); withHome(b.home, () => nameProject(repository(mine.root), 'elu-copy'));
  const row = withHome(b.home, () => remoteGlue({ facade: peerFacade, peerRead: () => ({ key: b.identity.key, teams: [{ members: Object.entries(names).map(([key, value]) => ({ key, ...value })) }] }), peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false, roots: () => [mine.root] }).sections(Date.now(), mine.root).find(line => line.row)?.row);
  assert.deepEqual(rowActions(row).map(([key]) => key), ['enter', 'd']);
  // It is the same project: B reads it by the name B gave it, whatever A calls it.
  assert.equal(row.project, 'elu-copy');
  // Its message box says whose it is and sends nothing: the key bar offers no Enter.
  const glue = remoteGlue({ facade: peerFacade, peerRead: () => ({ key: b.identity.key, teams: [{ members: Object.entries(names).map(([key, value]) => ({ key, ...value })) }] }), peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false });
  assert.deepEqual(glue.route(row, 'please stop'), { to: 'none', text: 'please stop' });
  assert.equal(glue.label(row).trim(), "ana's session on @box-one · read here");
  assert.deepEqual(boxKeys(row, 'none').map(([key]) => key), ['esc']);
  // Its chat says whose words are whose: what ana wrote there is ana's, never "You", and it runs in B's project.
  const reader = remoteGlue({ facade: peerFacade, peerRead: () => ({ key: b.identity.key, teams: [] }), peerCommand: async () => ({}), chatMessage: message => `${message.title}: ${message.text}`, ink: text => text, colour: false });
  const read = withHome(b.home, () => reader.view(row, 100));
  assert.match(read, /Runs on @box-one in elu-copy\. It is ana's: you read it here\./);
  assert.match(read, /ana on @box-one/);
  assert.doesNotMatch(read, /\bYou\b/);

  // And the other way: A sees B's ELU sessions under B's computer.
  const ba = link(a, b);
  await withHome(a.home, () => listTick(ba.viewCtx));
  assert.deepEqual(withHome(a.home, () => remoteMachines().find(row => row.key === b.identity.key)?.sessions.map(item => item.title)), ['Write the release notes']);
  const there = sessionsShown(a, elu.root, names);
  assert.ok(there.includes('# On studio · ben'), JSON.stringify(there));
  assert.ok(there.includes('Write the release notes'), JSON.stringify(there));
});

test('a third computer, of someone else, joins the same project: it sees A\'s and B\'s sessions, they see its, and /share off keeps a project to itself', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member, c = addMember(t, team, 'sara');
  const origin = 'https://github.com/acme/elu.git';
  const elu = withHome(a.home, () => registeredProject(t, { origin })), bFolder = withHome(b.home, () => registeredProject(t)), cFolder = withHome(c.home, () => registeredProject(t, { origin }));
  invited(team, a, elu.root); joined(team, b, bFolder.root); joined(team, c, cFolder.root);
  withHome(a.home, () => { chat(elu.root, 1, { goal: 'Fix the login page' }); relist(); });
  withHome(b.home, () => { chat(bFolder.root, 1, { goal: 'Write the release notes' }); relist(); });
  withHome(c.home, () => { chat(cFolder.root, 1, { goal: 'Speed up the build' }); relist(); });
  const names = { [a.identity.key]: { name: 'ana', box: 'box-one', online: true }, [b.identity.key]: { name: 'ben', box: 'devbox', online: true }, [c.identity.key]: { name: 'sara', box: 'studio', online: true } };
  const titles = async (viewer, host) => { const pair = link(viewer, host); await withHome(viewer.home, () => listTick(pair.viewCtx)); return withHome(viewer.home, () => remoteMachines().find(row => row.key === host.identity.key)?.sessions.map(item => item.title) ?? []); };
  assert.deepEqual(await titles(c, a), ['Fix the login page']);
  assert.deepEqual(await titles(c, b), ['Write the release notes']);
  assert.deepEqual(await titles(a, c), ['Speed up the build']);
  assert.deepEqual(await titles(b, c), ['Speed up the build']);
  const onC = sessionsShown(c, cFolder.root, names);
  for (const line of ['# On box-one · ana', '# On devbox · ben', 'Fix the login page', 'Write the release notes']) assert.ok(onC.includes(line), JSON.stringify(onC));
  const onA = sessionsShown(a, elu.root, names);
  for (const line of ['# On studio · sara', 'Speed up the build']) assert.ok(onA.includes(line), JSON.stringify(onA));
  // /share off on C: its project is its own again, and nobody lists its sessions.
  withHome(c.home, () => { setBoardOff(cFolder.root, true); relist(); });
  const pair = link(a, c);
  await withHome(a.home, () => listTick(pair.viewCtx, Date.now() + 10000));
  assert.deepEqual(withHome(a.home, () => remoteMachines().find(row => row.key === c.identity.key)?.sessions ?? []), []);
});

test('a lesson learned in A\'s ELU is in B\'s ELU context with no step, and nothing of a project A never shared goes', t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member;
  const elu = withHome(a.home, () => registeredProject(t)), secret = withHome(a.home, () => registeredProject(t)), mine = withHome(b.home, () => registeredProject(t));
  invited(team, a, elu.root); joined(team, b, mine.root);
  withHome(a.home, () => { saveLearned(elu.root, { add: ['Deploys go through staging first.'], remove: [] }); saveLearned(secret.root, { add: ['The launch date is March 3.'], remove: [] }); saveInstructions(secret.root, 'Private rules.'); });
  const send = (from, to) => { const rows = withHome(from.home, () => notesRows(to.identity.key, notesTick({ me: from.identity.key, who: () => '@peer' }))); withHome(to.home, () => takeNotes(to.identity.key, from.identity.key, rows)); return rows; };
  const rows = send(a, b);
  assert.ok(!JSON.stringify(rows).includes('March 3') && !JSON.stringify(rows).includes('Private rules'), 'a project never shared is not sent');
  withHome(b.home, () => notesTick({ me: b.identity.key, who: () => '@box-one' }));
  const learned = withHome(b.home, () => splitContext(readProjectSettings(mine.root).context).learned.map(row => row.line));
  assert.ok(learned.some(line => line.endsWith('Deploys go through staging first.')), learned.join('\n'));
  assert.ok(!learned.some(line => line.includes('March 3')));
  // And back: a lesson on B reaches A's ELU.
  withHome(b.home, () => saveLearned(mine.root, { add: ['Run the tests before a push.'], remove: [] }));
  send(b, a); withHome(a.home, () => notesTick({ me: a.identity.key, who: () => '@studio' }));
  const back = withHome(a.home, () => splitContext(readProjectSettings(elu.root).context).learned.map(row => row.line));
  assert.ok(back.some(line => line.endsWith('Run the tests before a push.')), back.join('\n'));
  assert.ok(!withHome(a.home, () => splitContext(readProjectSettings(secret.root).context).learned.map(row => row.line)).some(line => line.includes('Run the tests')));
});

test('the team\'s project is the joiner\'s own folder, not a second row in Projects; another project shared with the team still is one', t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member;
  const elu = withHome(a.home, () => registeredProject(t)), docs = withHome(a.home, () => registeredProject(t)), mine = withHome(b.home, () => registeredProject(t));
  withHome(a.home, () => { nameProject(repository(elu.root), 'ELU'); nameProject(repository(docs.root), 'Docs site'); });
  invited(team, a, elu.root); withHome(a.home, () => share(docs.root, { handle: 'docs-site', teams: [team.teamId] }));
  // A tells B what it shares with the team, as its status does.
  const told = withHome(a.home, () => toldProjects([team.teamId]));
  withHome(b.home, () => saveTold(a.identity.key, told));
  // Before B joins in a folder, both are A's projects in B's Projects.
  assert.deepEqual(withHome(b.home, () => teammateProjects().map(row => row.name)), ['Docs site', 'ELU']);
  joined(team, b, mine.root);
  assert.deepEqual(withHome(b.home, () => teammateProjects().map(row => row.name)), ['Docs site']);
});
