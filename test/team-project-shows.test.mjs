import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTeam, newHome, withHome, registeredProject } from './peer-helpers.mjs';
import { saveTask } from '../lib/state.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import * as inviteStore from '../lib/peer/invite.mjs';
import { merge, readLog } from '../lib/peer/roster.mjs';
import { keptTeamRoots, share, setTeamProject } from '../lib/peer/shares.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { dashboardSnapshot, nameProject, registerProject } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { saveTold, teammateProjects, toldProjects } from '../lib/peer/shared.mjs';
import { hostMethods, listTick, relist, remoteMachines, viewMethods } from '../lib/peer/remote.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';
import { rowTitle } from '../lib/board.mjs';
import * as peerFacade from '../lib/peer/index.mjs';
import { markMine, noteTheirs } from '../lib/peer/mine.mjs';
import { notesRows, notesTick, takeNotes } from '../lib/peer/notes.mjs';
import { readProjectSettings, saveContext, saveInstructions } from '../lib/project-settings.mjs';

const { createInvite, redeemCode } = inviteStore;

// The case: the computer that founded the team shares ELU, a plain folder of
// several repositories, by the invite. A computer that joined with ELU 0.1.19, or in its home
// folder, has no folder of the team recorded. It is on the team all the same: its one project
// is ELU there, it shows ELU's sessions from every computer of the team, and they show its.

function chat(root, id, { goal = `Session ${id}` } = {}) {
  const at = new Date().toISOString();
  saveTask(projectFolder(root), { id: String(id), kind: 'conversation', goal, state: 'answered', worktree: root, base: null, branch: null, createdAt: at, runs: [], reviews: [], responses: [], messages: [], sessions: {}, result: null, activeRole: null });
}
// A folder that is a project and no Git repository, as ~/projects/ELU and /workspace are.
function plainProject(t, name) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-plain-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, name); fs.mkdirSync(root);
  const repo = projectFolder(root); registerProject(repo);
  return { root: repo.root };
}
function addMember(t, team, name) {
  const home = newHome(t), identity = withHome(home, () => createIdentity({ name }));
  const log = withHome(team.founder.home, () => { redeemCode(createInvite(team.founder.identity, team.teamId, { hours: 1 }), identity.key, name); return readLog(team.teamId).ops; });
  for (const side of [home, team.member.home]) withHome(side, () => { const { rejected } = merge(team.teamId, log); if (rejected.length) throw new Error(rejected[0].reason); });
  return { home, identity };
}
// /invite in a project, as the app does it.
function invited(team, side, root) {
  withHome(side.home, () => { const row = share(root, { teams: [team.teamId] }); setTeamProject(team.teamId, row.handle); saveTeamAccess(team.teamId, { root }); });
}
function connection(key, hello = { remote: 1, shared: 1 }) {
  const sent = [];
  return { key, admitted: true, remoteHello: hello, sent, notify: (method, params) => sent.push([method, params]), request: async () => { throw new Error('No answer'); } };
}
const context = (me, sessions = {}) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
function link(viewer, host) {
  const toHost = connection(viewer.identity.key), toViewer = connection(host.identity.key);
  const hostCtx = context(host.identity, { [viewer.identity.key]: toHost }), viewCtx = context(viewer.identity, { [host.identity.key]: toViewer });
  const methods = hostMethods(hostCtx);
  viewMethods(viewCtx);
  toViewer.request = async (method, params) => withHome(host.home, () => { relist(); return methods[method](params, toHost); });
  return { viewCtx };
}
async function listed(viewer, host) {
  const pair = link(viewer, host);
  await withHome(viewer.home, () => listTick(pair.viewCtx, Date.now() + 20000));
  return withHome(viewer.home, () => remoteMachines().find(row => row.key === host.identity.key)?.sessions.map(item => item.title) ?? []);
}
function sessionsShown(side, root, names) {
  const status = { key: side.identity.key, teams: [{ members: Object.entries(names).map(([key, value]) => ({ key, ...value })) }] };
  const glue = remoteGlue({ facade: peerFacade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false, roots: () => [root] });
  return withHome(side.home, () => glue.sections(Date.now(), root).flatMap(line => line.header ? [`# ${line.header}`] : line.row ? [rowTitle(line.row)] : []));
}
// The join was a while ago: the clock moves on two minutes.
function later(t, ms = 120000) {
  const real = Date.now; Date.now = () => real() + ms; t.after(() => { Date.now = real; });
}
const tellProjects = (from, to, team) => { const told = withHome(from.home, () => toldProjects([team.teamId])); withHome(to.home, () => saveTold(from.identity.key, told)); };

test('a computer whose join recorded no folder, with one project, has it as the team\'s project: it shows ELU by its name, every computer\'s sessions of it, and theirs show its', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member;
  later(t);
  // ana's ELU is a plain folder, so it has no repository id to match by.
  const elu = withHome(a.home, () => plainProject(t, 'ELU')), secret = withHome(a.home, () => registeredProject(t));
  invited(team, a, elu.root);
  // ben joined with ELU 0.1.19: no access.json, no share, nothing kept. He runs ELU in /workspace.
  const workspace = withHome(b.home, () => plainProject(t, 'workspace'));
  withHome(a.home, () => { chat(elu.root, 1, { goal: 'Fix the login page' }); chat(secret.root, 1, { goal: 'Private plans' }); relist(); });
  withHome(b.home, () => { chat(workspace.root, 1, { goal: 'Check the GPU' }); relist(); });
  tellProjects(a, b, team);
  const names = { [a.identity.key]: { name: 'ana', box: 'laptop', online: true }, [b.identity.key]: { name: 'ben', box: 'gpubox', online: true } };

  // ben's Sessions with his one project open: ana's ELU session under ana's computer, nothing of her other project.
  assert.deepEqual(await listed(b, a), ['Fix the login page']);
  const onB = sessionsShown(b, workspace.root, names);
  assert.ok(onB.includes('# On laptop · ana') && onB.includes('Fix the login page'), JSON.stringify(onB));
  assert.ok(!onB.some(line => /Private plans/.test(line)), JSON.stringify(onB));
  // His Projects has ELU as his own project, by its name, and no row of it shared by ana.
  assert.deepEqual(withHome(b.home, () => teammateProjects().map(row => row.name)), []);
  assert.deepEqual(withHome(b.home, () => dashboardSnapshot().projects.map(row => row.name)), ['ELU']);
  // Kept once: a second project later does not move it.
  assert.equal(withHome(b.home, () => keptTeamRoots()[team.teamId]), workspace.root);
  withHome(b.home, () => registeredProject(t));
  assert.equal(withHome(b.home, () => peerFacade.teamProjectRoots().find(row => row.team === team.teamId)?.root), workspace.root);

  // And ana sees ben's sessions of it under his computer.
  assert.deepEqual(await listed(a, b), ['Check the GPU']);
  const onA = sessionsShown(a, elu.root, names);
  assert.ok(onA.includes('# On gpubox · ben') && onA.includes('Check the GPU'), JSON.stringify(onA));
});

test('a computer whose one project is its home folder has it as the team\'s project too', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member;
  later(t);
  const elu = withHome(a.home, () => plainProject(t, 'ELU'));
  invited(team, a, elu.root);
  const home = withHome(b.home, () => plainProject(t, 'ben'));
  const previous = process.env.HOME; process.env.HOME = home.root; t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
  withHome(a.home, () => { chat(elu.root, 1, { goal: 'Fix the login page' }); relist(); });
  withHome(b.home, () => { chat(home.root, 1, { goal: 'Release notes' }); relist(); });
  tellProjects(a, b, team);
  const names = { [a.identity.key]: { name: 'ana', box: 'laptop', online: true }, [b.identity.key]: { name: 'ben', box: 'devbox', online: true } };
  assert.deepEqual(await listed(b, a), ['Fix the login page']);
  assert.ok(sessionsShown(b, home.root, names).includes('Fix the login page'));
  assert.deepEqual(await listed(a, b), ['Release notes']);
});

test('with several projects and none recorded, none of them is taken for the team\'s project, and one never shared stays private', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member, c = addMember(t, team, 'sara');
  const elu = withHome(a.home, () => plainProject(t, 'ELU'));
  invited(team, a, elu.root);
  const one = withHome(c.home, () => plainProject(t, 'one')), two = withHome(c.home, () => plainProject(t, 'two'));
  withHome(c.home, () => { chat(one.root, 1, { goal: 'Private one' }); chat(two.root, 1, { goal: 'Private two' }); relist(); });
  assert.deepEqual(await listed(a, c), []);
  assert.deepEqual(withHome(c.home, () => keptTeamRoots()), {});
});

test('with several projects and none recorded, the team\'s project is still a project of its own: by its name, with every computer\'s sessions of it, until a session there says which folder it is', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member, c = addMember(t, team, 'sara');
  const elu = withHome(a.home, () => plainProject(t, 'ELU'));
  invited(team, a, elu.root);
  const one = withHome(c.home, () => plainProject(t, 'one')), two = withHome(c.home, () => plainProject(t, 'two'));
  // two has the name a new project gets, its folder's; one has a name she gave it.
  withHome(c.home, () => { nameProject(projectFolder(two.root), 'two'); nameProject(projectFolder(one.root), 'Side work'); });
  withHome(a.home, () => { chat(elu.root, 1, { goal: 'Fix the login page' }); relist(); });
  withHome(c.home, () => { chat(one.root, 1, { goal: 'Private one' }); relist(); });
  tellProjects(a, c, team);
  const names = { [a.identity.key]: { name: 'ana', box: 'laptop', online: true }, [b.identity.key]: { name: 'ben', box: 'gpubox', online: true }, [c.identity.key]: { name: 'sara', box: 'studio', online: true } };
  assert.deepEqual(await listed(c, a), ['Fix the login page']);
  // Projects: ELU, the team's, not a row shared by ana.
  const rows = withHome(c.home, () => teammateProjects());
  assert.deepEqual(rows.map(row => [row.name, row.team]), [['ELU', team.teamId]]);
  // Opened, Sessions shows its sessions under each computer, whatever project is open here.
  const status = { key: c.identity.key, teams: [{ members: Object.entries(names).map(([key, value]) => ({ key, ...value })) }] };
  const glue = remoteGlue({ facade: peerFacade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false, roots: () => [one.root, two.root] });
  const shown = () => withHome(c.home, () => glue.sections(Date.now(), one.root).flatMap(line => line.header ? [`# ${line.header}`] : line.row ? [rowTitle(line.row)] : []));
  assert.ok(!shown().includes('Fix the login page'), JSON.stringify(shown()));
  assert.ok(withHome(c.home, () => glue.openTeam(team.teamId, 'ELU', one.root)));
  assert.deepEqual(shown(), ['# ELU on laptop · ana', 'Fix the login page']);
  assert.deepEqual(withHome(c.home, () => glue.teamCount(team.teamId)), { sessions: 1, last: withHome(c.home, () => remoteMachines().find(row => row.key === a.identity.key).sessions[0].at), on: [{ name: 'laptop', sessions: 1 }] });
  // Nothing of sara's goes before she says which folder it is.
  assert.deepEqual(await listed(a, c), []);
  // Her first session there asks; she picks two. From then on two is ELU here, and nothing moves it.
  assert.equal(withHome(c.home, () => peerFacade.keepTeamFolder(team.teamId, two.root)), two.root);
  assert.throws(() => withHome(c.home, () => peerFacade.keepTeamFolder(team.teamId, one.root)), /already/);
  assert.deepEqual(withHome(c.home, () => teammateProjects()), []);
  // two goes by ELU now; the name she gave one stays.
  assert.deepEqual(withHome(c.home, () => dashboardSnapshot().projects.map(row => row.name).sort()), ['ELU', 'Side work']);
  withHome(c.home, () => { chat(two.root, 1, { goal: 'Speed up the build' }); relist(); });
  assert.deepEqual(await listed(a, c), ['Speed up the build']);
  glue.closeOpened();
  const there = sessionsShown(c, two.root, names);
  assert.ok(there.includes('# On laptop · ana') && there.includes('Fix the login page'), JSON.stringify(there));
});

test('a computer with one project that joins in a new folder has the folder it joined in as the team\'s project, never its other one', t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member;
  const elu = withHome(a.home, () => plainProject(t, 'ELU'));
  invited(team, a, elu.root);
  const other = withHome(b.home, () => plainProject(t, 'other'));
  tellProjects(a, b, team);
  // In the moment between the join and the folder it saves, the one project shows as the team's, and is not kept.
  assert.equal(withHome(b.home, () => peerFacade.teamProjectRoots().find(row => row.team === team.teamId)?.root), other.root);
  assert.deepEqual(withHome(b.home, () => keptTeamRoots()), {});
  // elu join in ~/elu, a folder not opened in ELU yet: that one is the team's, once it is.
  const joinedIn = path.join(path.dirname(other.root), 'elu'); fs.mkdirSync(joinedIn);
  withHome(b.home, () => peerFacade.saveTeamAccess(team.teamId, { handling: 'auto', rules: '', root: joinedIn }));
  later(t);
  assert.equal(withHome(b.home, () => peerFacade.teamProjectRoots().find(row => row.team === team.teamId)), undefined);
  withHome(b.home, () => registerProject(projectFolder(joinedIn)));
  assert.equal(withHome(b.home, () => peerFacade.teamProjectRoots().find(row => row.team === team.teamId)?.root), fs.realpathSync(joinedIn));
});

test('on a team nobody shared a project with, a computer that joined it keeps its one project its own: none of its sessions reach a teammate', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member, c = addMember(t, team, 'sara');
  later(t);
  // ana made the invite in her home folder, so she shares no project. Her own project stays hers.
  const secret = withHome(a.home, () => plainProject(t, 'secret'));
  const plans = withHome(b.home, () => plainProject(t, 'plans')), notes = withHome(c.home, () => plainProject(t, 'notes'));
  withHome(a.home, () => { chat(secret.root, 1, { goal: 'Ana private' }); relist(); });
  withHome(b.home, () => { chat(plans.root, 1, { goal: 'Ben private' }); relist(); });
  withHome(c.home, () => { chat(notes.root, 1, { goal: 'Sara private' }); relist(); });
  // What each computer tells the others of its projects, as on every status: none.
  for (const [from, to] of [[a, b], [a, c], [b, a], [b, c], [c, a], [c, b]]) tellProjects(from, to, team);
  assert.deepEqual(await listed(c, b), []);
  assert.deepEqual(await listed(a, b), []);
  assert.deepEqual(await listed(b, c), []);
  assert.deepEqual(withHome(b.home, () => keptTeamRoots()), {});
  assert.deepEqual(withHome(c.home, () => keptTeamRoots()), {});
  assert.deepEqual(withHome(b.home, () => dashboardSnapshot().projects.map(row => row.name)), ['plans']);
  // Once ana shares a project with the team by an invite, ben's one project is it.
  const elu = withHome(a.home, () => plainProject(t, 'ELU'));
  invited(team, a, elu.root);
  tellProjects(a, b, team);
  assert.deepEqual(await listed(a, b), ['Ben private']);
  assert.equal(withHome(b.home, () => keptTeamRoots()[team.teamId]), plans.root);
});

test('on the owner\'s other computer whose one project is the team\'s, Projects has that project once: no row of it on the first computer as well', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ana' }), a = team.founder, b = team.member;
  later(t);
  const elu = withHome(a.home, () => plainProject(t, 'ELU'));
  invited(team, a, elu.root);
  const home = withHome(b.home, () => plainProject(t, 'ana'));
  withHome(a.home, () => { chat(elu.root, 1, { goal: 'Fix the login page' }); chat(elu.root, 2, { goal: 'Write the release notes' }); relist(); });
  for (const [from, to] of [[a, b], [b, a]]) withHome(from.home, () => { markMine(from.identity.key, to.identity.key); noteTheirs(to.identity.key, true); });
  tellProjects(a, b, team);
  assert.deepEqual((await listed(b, a)).sort(), ['Fix the login page', 'Write the release notes']);
  const names = { [a.identity.key]: { name: 'ana', box: 'laptop', online: true }, [b.identity.key]: { name: 'ana', box: 'devbox', online: true } };
  const status = { key: b.identity.key, teams: [{ members: Object.entries(names).map(([key, value]) => ({ key, ...value })) }] };
  const glue = remoteGlue({ facade: peerFacade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false, roots: () => [home.root] });
  assert.deepEqual(withHome(b.home, () => glue.projects(Date.now(), home.root).map(row => row.name)), []);
  assert.equal(withHome(b.home, () => glue.counts(Date.now(), [home.root]).get(home.root).sessions), 2);
  const shown = withHome(b.home, () => glue.sections(Date.now(), home.root).flatMap(line => line.header ? [`# ${line.header}`] : line.row ? [rowTitle(line.row)] : []));
  assert.deepEqual(shown.slice(0, 1), ['# On laptop · online']);
  assert.deepEqual(shown.slice(1).sort(), ['Fix the login page', 'Write the release notes']);
});

test('with several projects, a folder the join named that is not opened here does not stop the question: the folder chosen is the team\'s project', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, c = addMember(t, team, 'sara');
  later(t);
  const elu = withHome(a.home, () => plainProject(t, 'ELU'));
  invited(team, a, elu.root);
  const one = withHome(c.home, () => plainProject(t, 'one'));
  withHome(c.home, () => plainProject(t, 'two'));
  const joinedIn = path.join(path.dirname(one.root), 'elu'); fs.mkdirSync(joinedIn);
  withHome(c.home, () => peerFacade.saveTeamAccess(team.teamId, { handling: 'auto', rules: '', root: joinedIn }));
  tellProjects(a, c, team);
  assert.deepEqual(withHome(c.home, () => teammateProjects().map(row => [row.name, row.team])), [['ELU', team.teamId]]);
  assert.equal(withHome(c.home, () => peerFacade.keepTeamFolder(team.teamId, one.root)), one.root);
  assert.equal(withHome(c.home, () => peerFacade.teamProjectRoots().find(row => row.team === team.teamId)?.root), one.root);
  assert.deepEqual(withHome(c.home, () => teammateProjects()), []);
});

test('with several projects and no folder of it chosen yet, the team\'s project still has its instructions, memory and board here: as the team\'s computers have them', async t => {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ben' }), a = team.founder, b = team.member, c = addMember(t, team, 'sara');
  later(t);
  const elu = withHome(a.home, () => plainProject(t, 'ELU'));
  invited(team, a, elu.root);
  const workspace = withHome(b.home, () => plainProject(t, 'workspace'));
  const one = withHome(c.home, () => plainProject(t, 'one')), two = withHome(c.home, () => plainProject(t, 'two'));
  withHome(a.home, () => { saveInstructions(elu.root, 'Use pnpm, not npm.\n'); saveContext(elu.root, 'The login page lives in web/login.\n'); chat(elu.root, 1, { goal: 'Fix the login page' }); relist(); });
  withHome(b.home, () => { chat(workspace.root, 1, { goal: 'Check the GPU' }); relist(); });
  withHome(c.home, () => { chat(one.root, 1, { goal: 'Private one' }); relist(); });
  for (const [from, to] of [[a, b], [a, c], [b, c]]) tellProjects(from, to, team);
  // Each computer says what it has, then hears what the others have, as the daemon trades them.
  const send = (from, to) => { const rows = withHome(from.home, () => notesRows(to.identity.key, notesTick({ me: from.identity.key, who: () => '@peer' }))); withHome(to.home, () => takeNotes(to.identity.key, from.identity.key, rows)); };
  // Before sara's computer said what it has, nothing of ELU's text goes to it.
  send(a, c);
  assert.deepEqual(withHome(c.home, () => peerFacade.teamNotes(team.teamId)), { instructions: '', memory: '' });
  send(c, a); send(a, c);
  assert.deepEqual(withHome(c.home, () => peerFacade.teamNotes(team.teamId)), { instructions: 'Use pnpm, not npm.\n', memory: 'The login page lives in web/login.\n' });
  // Nothing of it went into either of her projects.
  assert.equal(withHome(c.home, () => readProjectSettings(one.root).instructions), '');
  assert.equal(withHome(c.home, () => readProjectSettings(two.root).instructions), '');
  // Its board: the sessions of it on every computer of the team, under each, and none of hers.
  const names = { [a.identity.key]: { name: 'ana', box: 'laptop', online: true }, [b.identity.key]: { name: 'ben', box: 'gpubox', online: true }, [c.identity.key]: { name: 'sara', box: 'studio', online: true } };
  assert.deepEqual(await listed(c, a), ['Fix the login page']);
  assert.deepEqual(await listed(c, b), ['Check the GPU']);
  const status = { key: c.identity.key, teams: [{ members: Object.entries(names).map(([key, value]) => ({ key, ...value })) }] };
  const glue = remoteGlue({ facade: peerFacade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false, roots: () => [one.root, two.root] });
  const cards = withHome(c.home, () => glue.teamCards(null, Date.now(), team.teamId));
  assert.deepEqual(cards.map(person => [person.name, person.box, person.sessions.map(card => card.title)]).sort(), [['ana', 'laptop', ['Fix the login page']], ['ben', 'gpubox', ['Check the GPU']]]);
  // Once she says which folder it is, that folder has them.
  withHome(c.home, () => peerFacade.keepTeamFolder(team.teamId, two.root));
  send(c, a); send(a, c); withHome(c.home, () => notesTick({ me: c.identity.key, who: () => '@peer' }));
  assert.equal(withHome(c.home, () => readProjectSettings(two.root).instructions), 'Use pnpm, not npm.\n');
  assert.equal(withHome(c.home, () => readProjectSettings(one.root).instructions), '');
});
