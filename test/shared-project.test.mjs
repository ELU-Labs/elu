import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeTeam, newHome, withHome, registeredProject } from './peer-helpers.mjs';
import { repository } from '../lib/git.mjs';
import { saveTask } from '../lib/state.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import * as inviteStore from '../lib/peer/invite.mjs';
import { createTeam, merge, readLog, removeOp, team as teamState } from '../lib/peer/roster.mjs';
import { share, setTeamProject, setBoardOff } from '../lib/peer/shares.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { saveLearned } from '../lib/project-learnings.mjs';
import { readProjectSettings, saveContext, saveInstructions } from '../lib/project-settings.mjs';
import { nameProject } from '../lib/projects.mjs';
import { localNotes, mergeNotes, splitContext } from '../lib/project-notes.mjs';
import { notesRows, notesSaid, notesTick, takeNotes } from '../lib/peer/notes.mjs';
import { saveTold, teammateProjects, toldProjects } from '../lib/peer/shared.mjs';
import { hostMethods, hostTick, listTick, relist, remoteCommand, remoteMachines, remoteSessions, viewMethods, viewTick } from '../lib/peer/remote.mjs';
import { boxKeys, remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';
import { rowActions, rowTitle } from '../lib/board.mjs';
import { closeSession } from '../lib/kanban.mjs';
import { proposeTask } from '../lib/plan.mjs';
import * as peerFacade from '../lib/peer/index.mjs';
import { dropStrangers, unmarkMine } from '../lib/peer/mine.mjs';
import { shareProjects } from './peer-helpers.mjs';
import { createAsk, deliver } from '../lib/peer/asks.mjs';
import { intakeMethods } from '../lib/peer/intake.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import { getRecord } from '../lib/peer/taskstore.mjs';
import { projectKey } from '../lib/peer/remote.mjs';

const { admitProven, createInvite, inviteKeys, openInvites, redeemCode } = inviteStore;

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
  // Acting follows A's handling of ELU, as any member's request does, whoever owns B: under
  // Auto (the first save) B's message goes in at once; under Manual it waits there for A's yes.
  const goes = () => withHome(a.home, () => pendingRequests(elu.root).filter(row => row.continuationTaskId != null).map(row => [row.goal, row.state]));
  await withHome(b.home, () => remoteCommand(ab.viewCtx, { type: 'remoteSend', id: view.id, text: 'Check the signup page too' }));
  assert.deepEqual(goes(), [['Check the signup page too', 'queued']]);
  withHome(a.home, () => saveTeamAccess(team.teamId, { handling: 'manual', root: elu.root }));
  await withHome(b.home, () => remoteCommand(ab.viewCtx, { type: 'remoteSend', id: view.id, text: 'And the footer' }));
  assert.deepEqual(goes(), [['Check the signup page too', 'queued'], ['And the footer', 'waiting']]);
  // The project A never shared cannot be watched by its place either.
  const hidden = withHome(a.home, () => ab.methods['elu.remote.list']({}, ab.toHost)).sessions.map(row => row.ref);
  assert.equal(hidden.length, 1);
  // A row of A's computer here works as a row here does: it opens, shows its changes, and renames and archives there.
  withHome(a.home, () => nameProject(repository(elu.root), 'ELU')); withHome(b.home, () => nameProject(repository(mine.root), 'elu-copy'));
  const row = withHome(b.home, () => remoteGlue({ facade: peerFacade, peerRead: () => ({ key: b.identity.key, teams: [{ members: Object.entries(names).map(([key, value]) => ({ key, ...value })) }] }), peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false, roots: () => [mine.root] }).sections(Date.now(), mine.root).find(line => line.row)?.row);
  assert.deepEqual(rowActions(row).map(([key]) => key), ['enter', 'd', 'e', 'c']);
  // It is the same project: B reads it by the name B gave it, whatever A calls it.
  assert.equal(row.project, 'elu-copy');
  // Its message box writes to it there, as to a session here; A's handling decides what runs.
  const glue = remoteGlue({ facade: peerFacade, peerRead: () => ({ key: b.identity.key, name: 'ben', teams: [{ members: Object.entries(names).map(([key, value]) => ({ key, ...value })) }] }), peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false });
  assert.deepEqual(glue.route(row, 'please stop'), { to: 'there', text: 'please stop' });
  assert.match(glue.label(row), /@box-one/); assert.doesNotMatch(glue.label(row), /read here/);
  assert.ok(boxKeys(row, 'there').some(([key]) => key === 'enter'));
  // Its chat says whose words are whose: what ana wrote there is ana's, never "You", and it runs in B's project.
  const reader = remoteGlue({ facade: peerFacade, peerRead: () => ({ key: b.identity.key, name: 'ben', teams: [] }), peerCommand: async () => ({}), chatMessage: message => `${message.title}: ${message.text}`, ink: text => text, colour: false });
  const read = withHome(b.home, () => reader.view(row, 100));
  assert.match(read, /Runs on @box-one in elu-copy\./); assert.doesNotMatch(read, /you read it here/);
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
  // Both daemons send what they have every few seconds: B's says which projects it has, so A's
  // sends a project's notes only to a computer that has that project too.
  send(b, a);
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
  // B has two projects: with one, that one would be the team's project here from the start.
  const elu = withHome(a.home, () => registeredProject(t)), docs = withHome(a.home, () => registeredProject(t)), mine = withHome(b.home, () => registeredProject(t));
  withHome(b.home, () => registeredProject(t));
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

// What a computer is told by another's notes, and what it takes in: as two daemons do it.
const sendNotes = (from, to) => { const rows = withHome(from.home, () => notesRows(to.identity.key, notesTick({ me: from.identity.key, who: () => '@peer' }))); withHome(to.home, () => takeNotes(to.identity.key, from.identity.key, rows)); withHome(to.home, () => notesTick({ me: to.identity.key, who: () => '@peer' })); };
const lessonsOf = (side, root) => withHome(side.home, () => splitContext(readProjectSettings(root).context).learned.map(row => row.line.replace(/^- \S+ /, '')));
async function listedBy(viewer, host) { const pair = link(viewer, host); await withHome(viewer.home, () => listTick(pair.viewCtx, Date.now() + 20000)); return withHome(viewer.home, () => remoteMachines().find(row => row.key === host.identity.key)?.sessions.map(item => item.title) ?? []); }

test('sharing or inviting from another project shares it as another project of the team, and moving where teammates\' messages run leaves the first where the invite and the join put it', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member;
  const elu = withHome(a.home, () => registeredProject(t)), notes = withHome(a.home, () => registeredProject(t));
  const mine = withHome(b.home, () => registeredProject(t)), side = withHome(b.home, () => registeredProject(t));
  // As the app does it: /invite in ELU on A, /join in B's own folder, through the same calls.
  withHome(a.home, () => { peerFacade.share(elu.root, { teams: [team.teamId] }); peerFacade.saveTeamAccess(team.teamId, { handling: 'auto', rules: '', root: elu.root }); });
  withHome(b.home, () => peerFacade.saveTeamAccess(team.teamId, { handling: 'auto', rules: '', root: mine.root }));
  withHome(a.home, () => { chat(elu.root, 1, { goal: 'Fix the login page' }); chat(notes.root, 1, { goal: 'Draft the meeting notes' }); saveLearned(elu.root, { add: ['Deploys go through staging first.'], remove: [] }); saveLearned(notes.root, { add: ['The meeting is on Tuesdays.'], remove: [] }); saveInstructions(notes.root, 'Rules of the notes.'); relist(); });
  withHome(b.home, () => { chat(mine.root, 1, { goal: 'Write the release notes' }); chat(side.root, 1, { goal: 'Side task of ben' }); saveLearned(side.root, { add: ['Side lesson only.'], remove: [] }); relist(); });
  assert.deepEqual(await listedBy(b, a), ['Fix the login page'], 'before');
  assert.deepEqual(await listedBy(a, b), ['Write the release notes'], 'before');
  // A runs elu share in ~/notes, and later makes another invite there; B runs /share in its other folder, and /access there.
  withHome(a.home, () => { peerFacade.share(notes.root, { handle: 'notes' }); peerFacade.share(notes.root, { teams: [team.teamId] }); });
  withHome(b.home, () => { peerFacade.share(side.root, { handle: 'side-work', status: true }); peerFacade.saveTeamAccess(team.teamId, { root: side.root }); });
  withHome(a.home, () => relist()); withHome(b.home, () => relist());
  // Each folder shared with the team is a project of it: the notes on A, the other folder on B.
  // Neither joined the other's, so neither is told its sessions: only the first project's.
  assert.deepEqual(await listedBy(b, a), ['Fix the login page'], 'B sees A\'s ELU sessions, and not the notes');
  assert.deepEqual(await listedBy(a, b), ['Write the release notes'], 'A sees B\'s ELU sessions, and not the other folder\'s');
  // An ELU before 0.1.31 says no project it has, and is told the first project's alone, as before.
  const older = link(b, a), olderList = withHome(a.home, () => { relist(); return older.methods['elu.remote.list']({ archived: true }, older.toHost); });
  assert.deepEqual(olderList.sessions.map(row => row.title), ['Fix the login page']);
  // The first project stays where the invite and the join put it, and the others come after it.
  assert.deepEqual(withHome(a.home, () => peerFacade.teamProjectRoots()).map(row => row.root), [elu.root, notes.root]);
  assert.deepEqual(withHome(b.home, () => peerFacade.teamProjectRoots()).map(row => row.root), [mine.root, side.root]);
  const [first, ...others] = withHome(a.home, () => peerFacade.teamProjectRoots()).map(row => row.team);
  assert.equal(first, team.teamId); assert.match(others[0], new RegExp(`^${team.teamId}:[0-9a-f]{16}$`));
  assert.notEqual(others[0], withHome(b.home, () => peerFacade.teamProjectRoots())[1].team, 'A\'s notes and B\'s other folder are two projects');
  // Instructions, context and lessons of one project never reach another.
  sendNotes(a, b); sendNotes(b, a); sendNotes(a, b);
  assert.ok(lessonsOf(b, mine.root).includes('Deploys go through staging first.'), lessonsOf(b, mine.root).join(' | '));
  for (const root of [mine.root, side.root]) assert.ok(!lessonsOf(b, root).some(line => /Tuesdays/.test(line)), `the notes lesson reached B: ${lessonsOf(b, root).join(' | ')}`);
  for (const root of [elu.root, notes.root]) assert.ok(!lessonsOf(a, root).some(line => /Side lesson/.test(line)), `B's other folder reached A: ${lessonsOf(a, root).join(' | ')}`);
  assert.ok(!lessonsOf(a, notes.root).some(line => /staging/.test(line)), 'ELU\'s lesson stays out of the notes');
  for (const root of [mine.root, side.root]) assert.doesNotMatch(withHome(b.home, () => readProjectSettings(root).instructions), /Rules of the notes/);
  // What A tells its teammates of its shares: the ELU share is the team's first project, the notes another.
  const told = withHome(a.home, () => toldProjects([team.teamId])), handle = root => withHome(a.home, () => peerFacade.shares().find(row => row.root === root).handle);
  assert.deepEqual(told.find(row => row.handle === handle(elu.root)).project, [team.teamId]);
  assert.deepEqual(told.find(row => row.handle === handle(notes.root)).project, [others[0]]);
});

test('a computer on ELU 0.1.29 whose team project moved to another share takes the one the invite and the join put it in again', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member;
  const elu = withHome(a.home, () => registeredProject(t)), notes = withHome(a.home, () => registeredProject(t)), mine = withHome(b.home, () => registeredProject(t)), side = withHome(b.home, () => registeredProject(t));
  // What 0.1.29 left: the invite's folder and the join's folder in the team's setting, and the
  // team's share moved to the project shared last.
  invited(team, a, elu.root); joined(team, b, mine.root);
  withHome(a.home, () => { const row = share(notes.root, { handle: 'notes', teams: [team.teamId] }); setTeamProject(team.teamId, row.handle); chat(elu.root, 1, { goal: 'Fix the login page' }); chat(notes.root, 1, { goal: 'Draft the meeting notes' }); relist(); });
  withHome(b.home, () => { const row = share(side.root, { handle: 'side-work', teams: [team.teamId] }); setTeamProject(team.teamId, row.handle); chat(mine.root, 1, { goal: 'Write the release notes' }); chat(side.root, 1, { goal: 'Side task of ben' }); relist(); });
  assert.deepEqual(await listedBy(b, a), ['Fix the login page']);
  assert.deepEqual(await listedBy(a, b), ['Write the release notes']);
});

test('an archived session of the shared project stays on its computer: a teammate is never sent it, nor can open it, and one archived since leaves their list', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member;
  const elu = withHome(a.home, () => registeredProject(t)), mine = withHome(b.home, () => registeredProject(t));
  invited(team, a, elu.root); joined(team, b, mine.root);
  withHome(a.home, () => { chat(elu.root, 1, { goal: 'Fix the login page' }); chat(elu.root, 2, { goal: 'Speed up the build' }); chat(elu.root, 3, { goal: 'Tidy the docs' }); closeSession(repository(elu.root), '2'); relist(); });
  const ab = link(b, a), ask = params => withHome(a.home, () => { relist(); return ab.methods['elu.remote.list'](params, ab.toHost); });
  // B's ELU asks for archived sessions too, as it asks every computer: none of A's is sent.
  const first = ask({ archived: true });
  assert.deepEqual(first.sessions.map(row => row.title).sort(), ['Fix the login page', 'Tidy the docs']);
  assert.ok(!JSON.stringify(first).includes('Speed up the build'));
  // Nor is it opened by its place there.
  const ref = `${first.sessions[0].ref.split(':')[0]}:2`;
  assert.throws(() => withHome(a.home, () => ab.methods['elu.remote.watch']({ ref }, ab.toHost)), /That session is not on this computer\./);
  // One A archives later leaves B's list (gone), and is not sent either.
  withHome(a.home, () => closeSession(repository(elu.root), '3'));
  const next = ask({ since: first.cursor, archived: true });
  assert.ok(!next.sessions.some(row => row.title === 'Tidy the docs'), JSON.stringify(next.sessions));
  assert.ok(next.full || next.gone.includes(`${ref.split(':')[0]}:3`), JSON.stringify(next));
  await withHome(b.home, () => listTick(ab.viewCtx, Date.now() + 20000));
  assert.deepEqual(withHome(b.home, () => remoteMachines().find(row => row.key === a.identity.key)?.sessions.map(item => item.title)), ['Fix the login page']);
});

test('/share off on the computer that joined shows none of the teammates\' sessions there, as it says, and /share on brings them back', async t => {
  for (const origin of ['https://example.invalid/acme/elu.git', null]) {
    const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member;
    const elu = withHome(a.home, () => registeredProject(t, origin ? { origin } : {})), mine = withHome(b.home, () => registeredProject(t, origin ? { origin } : {})), other = withHome(b.home, () => registeredProject(t));
    invited(team, a, elu.root); joined(team, b, mine.root);
    withHome(a.home, () => { chat(elu.root, 1, { goal: 'Fix the login page' }); relist(); });
    const names = { [a.identity.key]: { name: 'ana', box: 'box-one', online: true }, [b.identity.key]: { name: 'ben', box: 'box-two', online: true } };
    const ab = link(b, a), glue = () => remoteGlue({ facade: peerFacade, peerRead: () => ({ key: b.identity.key, teams: [{ members: Object.entries(names).map(([key, value]) => ({ key, ...value })) }] }), peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false, roots: () => [mine.root, other.root] });
    await withHome(b.home, () => listTick(ab.viewCtx));
    assert.ok(sessionsShown(b, mine.root, names).includes('Fix the login page'), `before /share off (${origin ?? 'no origin'})`);
    // B runs /share off in its folder of the team's project.
    withHome(b.home, () => peerFacade.taskBoard(mine.root, false));
    await withHome(b.home, () => listTick(ab.viewCtx, Date.now() + 20000));
    for (const root of [mine.root, other.root]) {
      const shown = sessionsShown(b, root, names);
      assert.ok(!shown.some(line => /box-one|Fix the login page/.test(line)), `after /share off, with ${root === mine.root ? 'its folder' : 'another project'} open (${origin ?? 'no origin'}): ${JSON.stringify(shown)}`);
    }
    assert.equal(withHome(b.home, () => glue().counts(Date.now(), [mine.root]).get(mine.root).sessions), 0, 'Projects counts none of them');
    assert.deepEqual(withHome(b.home, () => glue().teamCards(mine.root)), []);
    // /share on: they are back.
    withHome(b.home, () => peerFacade.taskBoard(mine.root, true));
    assert.ok(sessionsShown(b, mine.root, names).includes('Fix the login page'), `after /share on (${origin ?? 'no origin'})`);
  }
});

// Who did what, by computer: in a session of the shared project, the words its own computer's
// person typed there read as that person's on that computer, and a message sent from this
// computer reads You, on every computer, whoever owns them; neither reads as the other's.
test('a message sent into a session of the shared project from another computer reads You there, and the words typed on the session\'s computer read as its person\'s', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ana' }), a = team.founder, b = team.member, c = addMember(t, team, 'li');
  const elu = withHome(a.home, () => registeredProject(t)), mine = withHome(b.home, () => registeredProject(t));
  invited(team, a, elu.root); joined(team, b, mine.root);
  const at = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  // On A: ana typed the first, B sent the second (a message from B, by its key), and C the third.
  withHome(a.home, () => chat(elu.root, 1, { goal: 'Tidy the footer', messages: [{ at: at(3), text: 'Tidy the footer' }, { at: at(2), text: 'And the header too', computer: b.identity.key }, { at: at(1), text: 'Leave the logo', computer: c.identity.key }] }));
  const names = { [a.identity.key]: { name: 'ana', box: 'box-one', online: true }, [b.identity.key]: { name: 'ana', box: 'box-two', online: true }, [c.identity.key]: { name: 'li', box: 'box-three', online: true } };
  const ab = link(b, a);
  await withHome(b.home, () => listTick(ab.viewCtx));
  const ref = withHome(b.home, () => remoteMachines().find(row => row.key === a.identity.key)).sessions[0].ref;
  await withHome(b.home, () => remoteCommand(ab.viewCtx, { type: 'remoteWatch', to: a.identity.key, ref }));
  withHome(a.home, () => hostTick(ab.hostCtx));
  withHome(b.home, () => { for (const [, params] of ab.toHost.sent.filter(([method]) => method === 'elu.remote.events')) ab.views['elu.remote.events'](params, ab.toViewer); });
  await withHome(b.home, () => viewTick(ab.viewCtx));
  const status = { key: b.identity.key, name: 'ana', teams: [{ members: Object.entries(names).map(([key, value]) => ({ key, ...value })) }] };
  const reader = remoteGlue({ facade: peerFacade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: message => `${message.title}: ${message.text}`, ink: text => text, colour: false });
  const row = withHome(b.home, () => reader.sections(Date.now(), mine.root).find(line => line.row)?.row);
  assert.ok(row, 'the session of A is a row here');
  const read = withHome(b.home, () => reader.view(row, 120));
  assert.match(read, /ana on @box-one: Tidy the footer/);
  assert.match(read, /You → @box-one: And the header too/);
  assert.match(read, /li on @box-three: Leave the logo/);
  assert.doesNotMatch(read, /You → @box-one: (Tidy the footer|Leave the logo)/);
});

test('a session of another computer on the shared project whose Task waits offers y and n here, as one here does, whoever owns that computer', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member;
  const elu = withHome(a.home, () => registeredProject(t)), mine = withHome(b.home, () => registeredProject(t));
  invited(team, a, elu.root); joined(team, b, mine.root);
  withHome(a.home, () => { chat(elu.root, 1, { goal: 'Make coupons upper case', messages: [{ at: new Date().toISOString(), text: 'Make coupons upper case' }] }); proposeTask(repository(elu.root), '1', { title: 'Uppercase coupons', description: 'Make normalize return upper case.', goal: 'Codes compare equal whatever their case.', objectives: ['normalize returns upper case'], priority: 'medium', severity: 'low' }); relist(); });
  const names = { [a.identity.key]: { name: 'ana', box: 'box-one', online: true }, [b.identity.key]: { name: 'ben', box: 'box-two', online: true } };
  const ab = link(b, a);
  await withHome(b.home, () => listTick(ab.viewCtx));
  const ref = withHome(b.home, () => remoteMachines().find(row => row.key === a.identity.key)).sessions[0].ref;
  await withHome(b.home, () => remoteCommand(ab.viewCtx, { type: 'remoteWatch', to: a.identity.key, ref }));
  withHome(a.home, () => hostTick(ab.hostCtx));
  withHome(b.home, () => { for (const [, params] of ab.toHost.sent.filter(([method]) => method === 'elu.remote.events')) ab.views['elu.remote.events'](params, ab.toViewer); });
  await withHome(b.home, () => viewTick(ab.viewCtx));
  const reader = remoteGlue({ facade: peerFacade, peerRead: () => ({ key: b.identity.key, teams: [{ members: Object.entries(names).map(([key, value]) => ({ key, ...value })) }] }), peerCommand: async () => ({}), chatMessage: message => `${message.title}: ${message.text}`, ink: text => text, colour: false, roots: () => [mine.root] });
  const row = withHome(b.home, () => reader.sections(Date.now(), mine.root).find(line => line.row)?.row);
  assert.ok(row && !row.seeOnly, 'a row to work in');
  assert.deepEqual(rowActions(row).map(([key]) => key), ['y', 'n', 'enter', 'd', 'e', 'c']);
  const read = withHome(b.home, () => reader.view(row, 100));
  assert.match(read, /Uppercase coupons/);
  assert.doesNotMatch(read, /you read it here|waits for ana's approval/);
});

// /invite in a project, as the app does it: the project is shared with the team first, with
// status on, and the code is made for the team's project it is then. handle: the share's name,
// as the folder's name gives it (two test folders have one name).
function inviteIn(team, side, root, handle) {
  return withHome(side.home, () => {
    peerFacade.share(root, { teams: [team.teamId], handle, status: true });
    const project = peerFacade.invitedProject?.(team.teamId, root) ?? null;
    return createInvite(side.identity, team.teamId, { hours: 1, ...(project ? { project } : {}) });
  });
}
// /join CODE in a folder, as the two daemons and the app do it: the inviter admits the joiner
// and answers with the team's log and the project the code names (elu.invite.prove); the joiner
// takes the log, makes its folder that project, and saves what teammates can do here, in it.
// Someone already on the team is admitted to nothing (member): the folder becomes the project
// the code was made in, and what teammates can do there stays as it was.
function joinWith(team, inviter, code, side, root, others = []) {
  const answer = withHome(inviter.home, () => {
    const row = openInvites([team.teamId]).find(value => value.topic === inviteKeys(code).topic);
    const member = inviteStore.joinProject?.(row, side.identity.key) ?? false;
    if (!member) admitProven(row, side.identity.key, side.identity.name);
    return { ops: readLog(team.teamId).ops, ...(/^[0-9a-f]{16}$/.test(row.project ?? '') ? { project: row.project } : {}), ...(member ? { member: true } : {}) };
  });
  for (const member of [side, ...others]) withHome(member.home, () => { const { rejected } = merge(team.teamId, answer.ops); if (rejected.length) throw new Error(rejected[0].reason); });
  withHome(side.home, () => {
    if (answer.project || answer.member) peerFacade.joinedProject(team.teamId, answer.project ?? null, root, { member: answer.member === true });
    if (!answer.member) peerFacade.saveTeamAccess(team.teamId, { handling: 'auto', rules: '', root });
  });
  return answer;
}
// What Sessions shows under one computer's heading: the open project's rows, and the rows of
// each project there that is not here, by its sub heading.
function underHeading(lines, heading) {
  const at = lines.indexOf(heading), out = { open: [], subs: {} };
  if (at < 0) return out;
  let sub = null;
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith('# ')) break;
    if (line.startsWith('## ')) { sub = line.slice(3); out.subs[sub] = []; continue; }
    if (sub === null) out.open.push(line); else out.subs[sub].push(line);
  }
  return out;
}

test('an invite made in another project of the team shares that one: whoever joins with it joins it, the first stays shared as it was, and nothing of the two mixes', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member;
  const c = (() => { const home = newHome(t); return { home, identity: withHome(home, () => createIdentity({ name: 'sara' })) }; })();
  const elu = withHome(a.home, () => registeredProject(t)), notes = withHome(a.home, () => registeredProject(t));
  const mine = withHome(b.home, () => registeredProject(t)), hers = withHome(c.home, () => registeredProject(t));
  withHome(a.home, () => { nameProject(repository(elu.root), 'ELU'); nameProject(repository(notes.root), 'Team notes'); });
  // ana invited ben from ELU, and ben joined in a folder of his own, as before.
  withHome(a.home, () => { peerFacade.share(elu.root, { teams: [team.teamId] }); peerFacade.saveTeamAccess(team.teamId, { handling: 'auto', rules: '', root: elu.root }); });
  withHome(b.home, () => peerFacade.saveTeamAccess(team.teamId, { handling: 'auto', rules: '', root: mine.root }));
  // Later ana makes an invite in Team notes, and sara joins with it in a folder of hers.
  const code = inviteIn(team, a, notes.root, 'team-notes');
  joinWith(team, a, code, c, hers.root, [b]);
  withHome(a.home, () => { chat(elu.root, 1, { goal: 'Fix the login page' }); chat(notes.root, 1, { goal: 'Draft the meeting notes' }); relist(); });
  withHome(b.home, () => { chat(mine.root, 1, { goal: 'Write the release notes' }); relist(); });
  withHome(c.home, () => { chat(hers.root, 1, { goal: 'Plan the offsite' }); relist(); });
  const names = { [a.identity.key]: { name: 'ana', box: 'box-one', online: true }, [b.identity.key]: { name: 'ben', box: 'devbox', online: true }, [c.identity.key]: { name: 'sara', box: 'studio', online: true } };

  // Sessions: with her folder open, sara sees ana's Team notes sessions as its own, never ELU's.
  for (const [viewer, host] of [[c, a], [c, b], [a, c], [b, c], [a, b], [b, a]]) await listedBy(viewer, host);
  const onC = underHeading(sessionsShown(c, hers.root, names), '# On box-one · ana');
  assert.deepEqual(onC.open, ['Draft the meeting notes'], JSON.stringify(onC));
  assert.ok(!Object.values(onC.subs).flat().includes('Draft the meeting notes'), JSON.stringify(onC));
  // With ELU open, ana sees ben's sessions and none of sara's; with Team notes open, sara's and none of ben's.
  const eluOnA = sessionsShown(a, elu.root, names), notesOnA = sessionsShown(a, notes.root, names);
  assert.deepEqual(underHeading(eluOnA, '# On devbox · ben').open, ['Write the release notes'], JSON.stringify(eluOnA));
  assert.deepEqual(underHeading(eluOnA, '# On studio · sara').open, [], JSON.stringify(eluOnA));
  assert.deepEqual(underHeading(notesOnA, '# On studio · sara').open, ['Plan the offsite'], JSON.stringify(notesOnA));
  assert.deepEqual(underHeading(notesOnA, '# On devbox · ben').open, [], JSON.stringify(notesOnA));
  // ben, with his ELU open, sees ana's ELU sessions as its own, and sara's not.
  const onB = sessionsShown(b, mine.root, names);
  assert.deepEqual(underHeading(onB, '# On box-one · ana').open, ['Fix the login page'], JSON.stringify(onB));
  assert.deepEqual(underHeading(onB, '# On studio · sara').open, [], JSON.stringify(onB));

  // Instructions, context and lessons: each project's go to the computers that have it, and to no other project.
  withHome(a.home, () => { saveLearned(elu.root, { add: ['Deploys go through staging first.'], remove: [] }); saveLearned(notes.root, { add: ['The meeting is on Tuesdays.'], remove: [] }); saveInstructions(notes.root, 'Rules of the notes.'); });
  withHome(b.home, () => saveLearned(mine.root, { add: ['Run the tests before a push.'], remove: [] }));
  withHome(c.home, () => saveLearned(hers.root, { add: ['Send the agenda a day ahead.'], remove: [] }));
  for (let round = 0; round < 2; round++) for (const [from, to] of [[a, b], [a, c], [b, a], [c, a], [b, c], [c, b]]) sendNotes(from, to);
  const has = (side, root, words) => lessonsOf(side, root).some(line => line.includes(words));
  for (const [side, root, label] of [[a, elu.root, 'ana\'s ELU'], [b, mine.root, 'ben\'s ELU']]) {
    for (const words of ['staging first', 'tests before a push']) assert.ok(has(side, root, words), `${label} lacks "${words}": ${lessonsOf(side, root).join(' | ')}`);
    for (const words of ['Tuesdays', 'agenda']) assert.ok(!has(side, root, words), `${label} took "${words}": ${lessonsOf(side, root).join(' | ')}`);
  }
  for (const [side, root, label] of [[a, notes.root, 'ana\'s Team notes'], [c, hers.root, 'sara\'s Team notes']]) {
    for (const words of ['Tuesdays', 'agenda']) assert.ok(has(side, root, words), `${label} lacks "${words}": ${lessonsOf(side, root).join(' | ')}`);
    for (const words of ['staging first', 'tests before a push']) assert.ok(!has(side, root, words), `${label} took "${words}": ${lessonsOf(side, root).join(' | ')}`);
  }
  assert.match(withHome(c.home, () => readProjectSettings(hers.root).instructions), /Rules of the notes/);
  assert.doesNotMatch(withHome(b.home, () => readProjectSettings(mine.root).instructions), /Rules of the notes/);

  // An ELU up to 0.1.30 keeps only a team's id in teams: Team notes is never sent with one, so
  // such a computer never takes it for the team's first project.
  const rows = withHome(a.home, () => notesRows(b.identity.key, notesTick({ me: a.identity.key, who: () => '@peer' })));
  const told = new Map(rows.map(row => [row.id, JSON.parse(row.data)]));
  const notesTold = [...told.values()].find(row => row.name === 'Team notes'), eluTold = [...told.values()].find(row => row.name === 'ELU');
  assert.deepEqual(eluTold.teams, [team.teamId]);
  assert.equal(notesTold.teams.length, 1); assert.ok(notesTold.teams[0].startsWith(`${team.teamId}:`) && !/^[0-9a-f]{64}$/.test(notesTold.teams[0]), JSON.stringify(notesTold.teams));

  // Each computer's folders of the team's projects: ana has both, ben ELU, sara Team notes.
  assert.deepEqual(withHome(a.home, () => peerFacade.teamProjectRoots()).map(row => row.root).sort(), [elu.root, notes.root].sort());
  assert.deepEqual(withHome(b.home, () => peerFacade.teamProjectRoots()).map(row => row.root), [mine.root]);
  assert.deepEqual(withHome(c.home, () => peerFacade.teamProjectRoots()).map(row => row.root), [hers.root]);
});

test('before anyone joins, an invite made in another folder shares it beside the first, which stays where it was', t => {
  const home = newHome(t), ana = withHome(home, () => createIdentity({ name: 'ana' })), team = withHome(home, () => createTeam(ana, 'core'));
  const elu = withHome(home, () => registeredProject(t)), notes = withHome(home, () => registeredProject(t));
  // As the app does it: /invite in ELU makes the team, then /invite in the notes, with nobody on it yet.
  withHome(home, () => { peerFacade.share(elu.root, { teams: [team.id] }); peerFacade.share(notes.root, { handle: 'notes', teams: [team.id] }); });
  assert.deepEqual(withHome(home, () => peerFacade.teamProjectRoots()).map(row => row.root), [elu.root, notes.root]);
  // The code made in the notes names that project; one made in ELU, the first, names none, as before.
  assert.match(withHome(home, () => peerFacade.invitedProject(team.id, notes.root)) ?? '', /^[0-9a-f]{16}$/);
  assert.equal(withHome(home, () => peerFacade.invitedProject(team.id, elu.root)), null);
});

// What a daemon keeps of the notes another computer sent last (takeNotes): the project at root
// there, as a project of the teams it is one of, with what it has now. Sent by a teammate's computer, it is kept as theirs.
function saidLast(from, root, to, teams) {
  const project = withHome(from.home, () => ({ id: projectKey(root), name: path.basename(root), repoId: null, home: false, links: [], ...(teams.length ? { teams } : {}), notes: localNotes(root) }));
  withHome(to.home, () => takeNotes(to.identity.key, from.identity.key, [{ id: project.id, seq: 0, of: 1, data: JSON.stringify(project) }]));
}
// A lesson a session saved: in its project's context, and said in the session (id), as the runner saves it.
const learnIn = (side, root, text, id = 1) => withHome(side.home, () => { saveLearned(root, { add: [text], remove: [] }); chat(root, id, { messages: [{ at: new Date().toISOString(), text: `Saved to project context: ${text}`, from: 'ELU', line: true, learned: true }] }); });
// Two folders trading their notes, one way and then the other, as a daemon up to 0.1.30 did;
// teams: those the two are a project of (none for two projects of the owner's own computers).
function tradeNotes(teamId, one, oneRoot, two, twoRoot, teams = [teamId]) {
  const sent = withHome(one.home, () => localNotes(oneRoot)); withHome(two.home, () => mergeNotes(twoRoot, one.identity.key, sent));
  const back = withHome(two.home, () => localNotes(twoRoot)); withHome(one.home, () => mergeNotes(oneRoot, two.identity.key, back));
  saidLast(one, oneRoot, two, teams); saidLast(two, twoRoot, one, teams);
}
// What ELU 0.1.29 left on two computers, file by file: ana's ELU and ben's folder trade their
// notes; ana shares Team notes with the team, which makes it the team's project, so it trades
// with ben's folder. Each trade one way, then the other. A lesson each session saved is in its
// context and said in the session, as the runner saves it; ben's only when benLearns.
function mixedBy029(t, { benLearns = true } = {}) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member;
  const elu = withHome(a.home, () => registeredProject(t)), notes = withHome(a.home, () => registeredProject(t)), mine = withHome(b.home, () => registeredProject(t));
  withHome(a.home, () => { nameProject(repository(elu.root), 'ELU'); nameProject(repository(notes.root), 'Team notes'); saveContext(notes.root, 'The agenda lives in the wiki.\n'); });
  invited(team, a, elu.root); joined(team, b, mine.root);
  learnIn(a, elu.root, 'Deploys go through staging first.'); learnIn(a, notes.root, 'The meeting is on Tuesdays.'); if (benLearns) learnIn(b, mine.root, 'Run the tests before a push.');
  const trade = (...args) => tradeNotes(team.teamId, ...args);
  trade(a, elu.root, b, mine.root);
  withHome(a.home, () => { const row = share(notes.root, { handle: 'notes', teams: [team.teamId] }); setTeamProject(team.teamId, row.handle); });
  trade(a, notes.root, b, mine.root);
  return { team, a, b, elu, notes, mine, trade };
}

test('what ELU 0.1.29 mixed between two projects is put back once: a lesson a session saved goes back to its project on every computer, and what cannot be told apart stays, said in one line', t => {
  const { a, b, elu, notes, mine, trade } = mixedBy029(t);
  // 0.1.30 then put ELU back, which traded with ben's folder again.
  trade(b, mine.root, a, elu.root);
  assert.ok(lessonsOf(a, elu.root).some(line => /Tuesdays/.test(line)), 'mixed, as 0.1.29 left it');
  assert.match(withHome(a.home, () => readProjectSettings(elu.root).context), /agenda lives in the wiki/, 'Team notes\' text reached ELU too');

  // The update: the next trade puts it back first, on ana's computer, and it reaches ben's.
  sendNotes(a, b); sendNotes(b, a); sendNotes(a, b);
  const has = (side, root, words) => lessonsOf(side, root).some(line => line.includes(words));
  assert.ok(!has(a, elu.root, 'Tuesdays') && has(a, elu.root, 'staging first'), lessonsOf(a, elu.root).join(' | '));
  assert.ok(!has(a, notes.root, 'staging first') && has(a, notes.root, 'Tuesdays'), lessonsOf(a, notes.root).join(' | '));
  assert.ok(!has(b, mine.root, 'Tuesdays') && has(b, mine.root, 'staging first'), lessonsOf(b, mine.root).join(' | '));
  // ben's lesson was saved by no session on ana's computer: it stays in both of hers, and so does
  // the text 0.1.29 copied. Each says so in one line; ben's folder has ELU's.
  for (const root of [elu.root, notes.root]) assert.ok(has(a, root, 'tests before a push'), lessonsOf(a, root).join(' | '));
  const own = (side, root) => withHome(side.home, () => splitContext(readProjectSettings(root).context).own);
  assert.match(own(a, elu.root), /The agenda lives in the wiki\.\n\nELU 0\.1\.29 mixed this project with Team notes\. [^\n]*$/);
  assert.match(own(a, notes.root), /^The agenda lives in the wiki\.\n\nELU 0\.1\.29 mixed this project with ELU\. [^\n]*$/);
  assert.equal(own(b, mine.root), own(a, elu.root));
  const said = withHome(a.home, () => notesSaid().map(row => row.text));
  assert.ok(said.includes('A lesson of Team notes that ELU 0.1.29 put in ELU was taken out.'), said.join(' | '));
  assert.ok(said.includes('A lesson of ELU that ELU 0.1.29 put in Team notes was taken out.'), said.join(' | '));
  // The line it adds reaches ben's folder as his own text does, with no change said to be made on both.
  for (const side of [a, b]) assert.ok(!withHome(side.home, () => notesSaid()).some(row => /changed here and on/.test(row.text)), withHome(side.home, () => notesSaid()).map(row => row.text).join(' | '));
  // Once: later trades leave it as it is.
  sendNotes(a, b); sendNotes(b, a);
  for (const root of [elu.root, notes.root]) assert.equal(own(a, root).split('ELU 0.1.29 mixed').length, 2);
  assert.equal(withHome(a.home, () => notesSaid()).length, said.length);
});

test('when the text 0.1.29 copied is all that cannot be told apart, each of the two projects says so, not only the one put back first', t => {
  const { a, b, elu, notes, mine, trade } = mixedBy029(t, { benLearns: false });
  trade(b, mine.root, a, elu.root);
  sendNotes(a, b);
  const own = root => withHome(a.home, () => splitContext(readProjectSettings(root).context).own);
  assert.match(own(elu.root), /^The agenda lives in the wiki\.\n\nELU 0\.1\.29 mixed this project with Team notes\. [^\n]*$/);
  assert.match(own(notes.root), /^The agenda lives in the wiki\.\n\nELU 0\.1\.29 mixed this project with ELU\. [^\n]*$/);
});

test('a computer that goes from ELU 0.1.29 straight to this one: what its teammate\'s folder still has of the other project does not come back to the first', t => {
  const { a, b, elu, notes, mine } = mixedBy029(t);
  assert.ok(lessonsOf(b, mine.root).some(line => /Tuesdays/.test(line)), 'ben\'s folder has Team notes\' lesson');
  sendNotes(a, b); sendNotes(b, a); sendNotes(a, b);
  const has = (side, root, words) => lessonsOf(side, root).some(line => line.includes(words));
  assert.ok(!has(a, elu.root, 'Tuesdays') && has(a, elu.root, 'staging first'), lessonsOf(a, elu.root).join(' | '));
  assert.ok(!has(b, mine.root, 'Tuesdays') && has(b, mine.root, 'staging first') && has(b, mine.root, 'tests before a push'), lessonsOf(b, mine.root).join(' | '));
  assert.ok(has(a, notes.root, 'Tuesdays') && !has(a, notes.root, 'staging first'), lessonsOf(a, notes.root).join(' | '));
});

// Someone with a home of their own, on no team yet.
const person = (t, name) => { const home = newHome(t); return { home, identity: withHome(home, () => createIdentity({ name })) }; };
// ana invited ben from ELU, the team's first project, and ben joined in a folder of his own.
function firstProject(t) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member;
  const elu = withHome(a.home, () => registeredProject(t)), notes = withHome(a.home, () => registeredProject(t)), mine = withHome(b.home, () => registeredProject(t));
  withHome(a.home, () => { peerFacade.share(elu.root, { teams: [team.teamId] }); peerFacade.saveTeamAccess(team.teamId, { handling: 'auto', rules: '', root: elu.root }); });
  withHome(b.home, () => peerFacade.saveTeamAccess(team.teamId, { handling: 'auto', rules: '', root: mine.root }));
  return { team, a, b, elu, notes, mine };
}

test('a computer that joined only another project of the team: a folder it sets for messages, or shares, later never becomes the team\'s first, and nothing of the first reaches it', async t => {
  const { team, a, b, elu, notes } = firstProject(t), c = person(t, 'sara');
  const hers = withHome(c.home, () => registeredProject(t)), side = withHome(c.home, () => registeredProject(t)), other = withHome(c.home, () => registeredProject(t));
  joinWith(team, a, inviteIn(team, a, notes.root, 'team-notes'), c, hers.root, [b]);
  // Later sara runs /access in another folder of hers, and /share in a third.
  withHome(c.home, () => { peerFacade.saveTeamAccess(team.teamId, { root: other.root }); peerFacade.share(side.root, { teams: [team.teamId], handle: 'side-work', status: true }); });
  const slots = withHome(c.home, () => peerFacade.teamProjectRoots());
  assert.ok(!slots.some(row => row.team === team.teamId), `a folder of sara's became the team's first: ${JSON.stringify(slots)}`);
  // Nothing of ana's ELU reaches a folder of sara's: its sessions, nor its lessons.
  withHome(a.home, () => { chat(elu.root, 1, { goal: 'Fix the login page' }); chat(notes.root, 1, { goal: 'Draft the meeting notes' }); saveLearned(elu.root, { add: ['Deploys go through staging first.'], remove: [] }); relist(); });
  withHome(c.home, () => relist());
  assert.deepEqual(await listedBy(c, a), ['Draft the meeting notes']);
  for (let round = 0; round < 2; round++) for (const [from, to] of [[a, c], [c, a]]) sendNotes(from, to);
  for (const root of [hers.root, side.root, other.root]) assert.ok(!lessonsOf(c, root).some(line => /staging/.test(line)), lessonsOf(c, root).join(' | '));
});

test('an invite made in a project kept off with /share off still names that project, and turns it on again', t => {
  const { team, a, elu, notes } = firstProject(t);
  withHome(a.home, () => peerFacade.share(notes.root, { teams: [team.teamId], handle: 'notes', status: true }));
  const id = withHome(a.home, () => peerFacade.invitedProject(team.teamId, notes.root));
  assert.match(id ?? '', /^[0-9a-f]{16}$/);
  // ana runs /share off in the notes: kept off, it is still that project of the team.
  withHome(a.home, () => peerFacade.taskBoard(notes.root, false));
  assert.equal(withHome(a.home, () => peerFacade.invitedProject(team.teamId, notes.root)), id, 'kept off, the same project');
  // Then /invite there, as the app and elu invite make it: the code names it, and the project is shared again.
  const code = inviteIn(team, a, notes.root, 'notes'), row = withHome(a.home, () => openInvites([team.teamId]).find(value => value.topic === inviteKeys(code).topic));
  assert.equal(row.project, id);
  assert.deepEqual(withHome(a.home, () => peerFacade.teamProjectRoots()).map(item => item.root), [elu.root, notes.root]);
  assert.equal(withHome(a.home, () => peerFacade.shares().find(item => item.root === notes.root).status), true);
});

test('a message from someone who joined another project of the team, naming none, runs in that project here, not where /access sends the team\'s', async t => {
  const { team, a, b, elu, notes } = firstProject(t), c = person(t, 'sara'), hers = withHome(c.home, () => registeredProject(t));
  joinWith(team, a, inviteIn(team, a, notes.root, 'team-notes'), c, hers.root, [b]);
  // sara asks ana from her folder of the notes; ana's daemon takes it as it takes any message.
  const anaSide = intakeMethods({ ...context(a.identity), push: () => {} });
  let taskId = null;
  const toAna = { admitted: true, remoteHello: { remote: 1, shared: 1, projects: 1 }, request: async (method, params) => { const task = withHome(a.home, () => anaSide[method](params, { key: c.identity.key })); taskId = task.id; return { task }; } };
  const saraCtx = { ...context(c.identity, { [a.identity.key]: toAna }), push: () => {}, dial: () => {} };
  const asked = withHome(c.home, () => createAsk(saraCtx, { to: a.identity.key, text: 'When is the next meeting?', from: hers.root }));
  await withHome(c.home, () => deliver(saraCtx, asked.id));
  // It runs in the notes, not in ELU, which sara never joined. ana's Auto is for the folder
  // /access set, ELU: in the notes it waits for her, as a message naming a project does.
  const record = withHome(a.home, () => getRecord(taskId));
  assert.equal(record?.root, notes.root, JSON.stringify(record));
  assert.equal(record.waiting, true);
  assert.equal(withHome(a.home, () => pendingRequests(elu.root).filter(row => row.origin?.peer === c.identity.key)).length, 0);
});

test('the owner\'s own computer that is not his any more, unmarked or off the team, shows nothing ELU 0.1.29 mixed: nothing is taken out or kept out, and no line is added', t => {
  for (const how of ['unmarked', 'removed']) {
    const team = makeTeam(t, { founderName: 'ana', memberName: 'ana' }), laptop = team.founder, devbox = team.member;
    for (const [side, other] of [[laptop, devbox], [devbox, laptop]]) withHome(side.home, () => { shareProjects(side.identity.key, other.identity.key); });
    const elu = withHome(laptop.home, () => registeredProject(t)), notes = withHome(laptop.home, () => registeredProject(t)), elu2 = withHome(devbox.home, () => registeredProject(t)), notes2 = withHome(devbox.home, () => registeredProject(t));
    withHome(laptop.home, () => { nameProject(repository(elu.root), 'ELU'); nameProject(repository(notes.root), 'Team notes'); });
    invited(team, laptop, elu.root); joined(team, devbox, elu2.root);
    withHome(laptop.home, () => share(notes.root, { handle: 'notes', teams: [team.teamId] }));
    learnIn(laptop, elu.root, 'Deploys go through staging first.'); learnIn(laptop, notes.root, 'The meeting is on Tuesdays.');
    learnIn(devbox, elu2.root, 'Run the tests before a push.'); learnIn(devbox, notes2.root, 'Send the agenda a day ahead.');
    // His two computers traded every project, each with its own, as before 0.1.29.
    tradeNotes(team.teamId, laptop, elu.root, devbox, elu2.root); tradeNotes(team.teamId, laptop, notes.root, devbox, notes2.root, []);
    if (how === 'unmarked') withHome(laptop.home, () => unmarkMine(devbox.identity.key));
    else withHome(laptop.home, () => { removeOp(laptop.identity, team.teamId, devbox.identity.key); dropStrangers(laptop.identity.key); });
    const contexts = () => [elu.root, notes.root].map(root => withHome(laptop.home, () => readProjectSettings(root).context)), was = contexts();
    withHome(laptop.home, () => notesTick({ me: laptop.identity.key, who: () => '@devbox' }));
    assert.deepEqual(contexts(), was, how);
    assert.deepEqual(withHome(laptop.home, () => notesSaid()), [], how);
    assert.ok(!JSON.stringify(withHome(laptop.home, () => localNotes(elu.root))).includes('Tuesdays'), `${how}: a lesson of the notes kept out of ELU`);
  }
});

test('a lesson the other project learned after ELU 0.1.30 was never mixed: it is not written into this one, so it never goes to whoever joined this one', t => {
  const { a, b, elu, notes, mine, trade } = mixedBy029(t);
  trade(b, mine.root, a, elu.root);
  // After 0.1.30 put ELU back, a session in Team notes learned one more thing.
  learnIn(a, notes.root, 'Minutes go in the wiki.', 2);
  sendNotes(a, b); sendNotes(b, a); sendNotes(a, b);
  for (const [side, root, label] of [[a, elu.root, 'ana\'s ELU'], [b, mine.root, 'ben\'s ELU']]) assert.ok(!JSON.stringify(withHome(side.home, () => localNotes(root))).includes('Minutes'), `${label} holds the notes' new lesson`);
  assert.ok(lessonsOf(a, notes.root).some(line => /Minutes/.test(line)), lessonsOf(a, notes.root).join(' | '));
});

test('someone already on the team joins another project of it with a code made there: the folder becomes that project, the first stays theirs, and a code for the first gives a folder that has none the first', async t => {
  const { team, a, b, elu, notes, mine } = firstProject(t), papers = withHome(b.home, () => registeredProject(t));
  const answer = joinWith(team, a, inviteIn(team, a, notes.root, 'team-notes'), b, papers.root);
  assert.equal(answer.member, true);
  assert.equal(withHome(a.home, () => teamState(team.teamId)).members.filter(member => member.key === b.identity.key).length, 1, 'not admitted again');
  assert.deepEqual(withHome(a.home, () => openInvites([team.teamId])), [], 'the code is used');
  assert.deepEqual(withHome(b.home, () => peerFacade.teamProjectRoots()).map(row => row.root), [mine.root, papers.root]);
  assert.equal(withHome(b.home, () => peerFacade.teamAccess(team.teamId)).root, mine.root, 'messages run where they did');
  // Each sees the other's sessions of both projects.
  withHome(a.home, () => { chat(elu.root, 1, { goal: 'Fix the login page' }); chat(notes.root, 1, { goal: 'Draft the meeting notes' }); relist(); });
  withHome(b.home, () => { chat(mine.root, 1, { goal: 'Write the release notes' }); chat(papers.root, 1, { goal: 'Sort the papers' }); relist(); });
  assert.deepEqual((await listedBy(b, a)).sort(), ['Draft the meeting notes', 'Fix the login page']);
  assert.deepEqual((await listedBy(a, b)).sort(), ['Sort the papers', 'Write the release notes']);
  // sara joined only the notes; a code ana makes in ELU later makes the folder sara uses it in the first.
  const c = person(t, 'sara'), hers = withHome(c.home, () => registeredProject(t)), hersToo = withHome(c.home, () => registeredProject(t));
  joinWith(team, a, inviteIn(team, a, notes.root, 'team-notes'), c, hers.root, [b]);
  assert.equal(joinWith(team, a, inviteIn(team, a, elu.root), c, hersToo.root).member, true);
  assert.deepEqual(withHome(c.home, () => peerFacade.teamProjectRoots()).map(row => [row.team === team.teamId, row.root]), [[true, hersToo.root], [false, hers.root]]);
});
