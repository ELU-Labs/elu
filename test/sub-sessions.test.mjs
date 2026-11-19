import test from 'node:test';
import assert from 'node:assert/strict';
import { boardRows, boardSections, barCells } from '../lib/board.mjs';
import { makeTeam, withHome, registeredProject, shareProjects } from './peer-helpers.mjs';
import { hostMethods, listTick, relist, remoteMachines, remoteSessions, viewMethods } from '../lib/peer/remote.mjs';
import { repository } from '../lib/git.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';
import { saveTask } from '../lib/state.mjs';

// Sub sessions (lib/session-commands.mjs subParent) in Sessions: under the session that
// started them, drawn while that session is the cursor's row or open, and all the time when
// one waits for the owner.
const NOW = Date.parse('2026-11-18T20:00:00Z');
const at = minutes => new Date(NOW - minutes * 60000).toISOString();
const task = (id, fields = {}) => ({ id: String(id), kind: 'conversation', goal: `Session ${id}`, title: `Session ${id}`, titleBy: 'owner', state: 'answered', createdAt: at(60 - id), activeSince: at(60 - id), runs: [], sessions: {}, reviews: [], responses: [], messages: [], result: { summary: 'done' }, ...fields });
const project = tasks => [{ root: '/p', name: 'P', tasks, queue: [], closed: [], archived: [], activity: [] }];
const rowsOf = (tasks, open = []) => boardSections(boardRows(project(tasks), NOW), NOW, { open }).filter(line => line.row).map(line => line.row);
const names = rows => rows.map(row => `${row.sub ? '  ' : ''}${row.task?.title ?? row.id}${row.subs ? ` [${row.subs.open ? 'open' : 'folded'} ${row.subs.count}]` : ''}`);

test('sub sessions fold under the session that started them, and open under it while it is the cursor\'s row or open', () => {
  const tasks = [task(1, { state: 'running', title: 'Release rollout' }), ...[2, 3, 4].map(id => task(id, { parent: '1', title: `Hourly check ${id}` })), task(5, { title: 'Standup' })];
  const folded = rowsOf(tasks);
  assert.deepEqual(names(folded), ['Release rollout [folded 3]', 'Standup']);
  const parent = folded[0];
  const opened = rowsOf(tasks, [parent.key]);
  assert.deepEqual(names(opened), ['Release rollout [open 3]', '  Hourly check 4', '  Hourly check 3', '  Hourly check 2', 'Standup']);
  // The cursor on one of them keeps them open; on another row, they fold.
  assert.deepEqual(names(rowsOf(tasks, [opened[2].key])), names(opened));
  assert.deepEqual(names(rowsOf(tasks, [opened.at(-1).key])), names(folded));
  // The heading counts the sessions the owner started.
  const headers = boardSections(boardRows(project(tasks), NOW), NOW, { open: [parent.key] }).filter(line => line.header).map(line => [line.header, line.count]);
  assert.deepEqual(headers, [['Running', 1], ['Recent', 1]]);
});

test('a sub session that needs the owner is drawn under its session all the time, and takes that session to Needs you', () => {
  const tasks = [task(1, { title: 'Release rollout' }), task(2, { parent: '1', title: 'Hourly check' }), task(3, { parent: '1', state: 'needs_input', title: 'Asks', result: { outcome: 'needs_input', question: 'Stop the rollout?' } })];
  const lines = boardSections(boardRows(project(tasks), NOW), NOW);
  const shown = lines.filter(line => line.row).map(line => line.row);
  assert.deepEqual(names(shown), ['Release rollout [folded 2]', '  Asks']);
  assert.equal(lines.find(line => line.header)?.header, 'Needs you');
  // Its own row keeps its own state: the parent is done, the sub session asks.
  assert.equal(shown[0].group, 3); assert.equal(shown[1].group, 0);
});

test('a sub session whose session is not in the list is listed on its own; one that names itself is not a sub session', () => {
  const tasks = [task(2, { parent: '1', title: 'Orphan' }), task(4, { parent: '4', title: 'Itself' })];
  assert.deepEqual(names(rowsOf(tasks)), ['Itself', 'Orphan']);
});

test('a sub session row is indented and its session row says how many it has, in exactly the width', () => {
  const tasks = [task(1, { title: 'Release rollout' }), task(2, { parent: '1', title: 'Hourly check' })];
  const [parent] = rowsOf(tasks), [, child] = rowsOf(tasks, [parent.key]);
  for (const [row, width] of [[parent, 40], [child, 40], [parent, 18], [child, 18]]) {
    const text = barCells(row, width, NOW).map(cell => cell.text).join('');
    assert.equal(text.length, width, JSON.stringify(text));
  }
  assert.match(barCells(parent, 40, NOW).map(cell => cell.text).join(''), /Release rollout\s+▸1 /);
  assert.match(barCells({ ...parent, subs: { ...parent.subs, open: true } }, 40, NOW).map(cell => cell.text).join(''), /▾1 /);
  assert.match(barCells(child, 40, NOW).map(cell => cell.text).join(''), /^ {2}✓ Hourly check/);
});

// On another computer of the owner's: the devbox says which session started each one (parent),
// and the laptop's Sessions lists them under it, as the devbox's own does.

function connection(key) {
  const sent = [];
  return { key, admitted: true, remoteHello: { remote: 1, shared: 1 }, sent, notify: (method, params) => sent.push([method, params]), request: async () => { throw new Error('No answer'); } };
}
const context = (me, sessions = {}) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
function pair(t) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), laptop = team.founder, devbox = team.member;
  const project = withHome(devbox.home, () => { const made = registeredProject(t, { origin: 'https://github.com/acme/shop.git' }); saveTeamAccess(team.teamId, { root: made.root }); shareProjects(devbox.identity.key, laptop.identity.key, { handling: 'auto' }); return made; });
  withHome(laptop.home, () => { shareProjects(laptop.identity.key, devbox.identity.key); });
  const toHost = connection(laptop.identity.key), toViewer = connection(devbox.identity.key);
  const host = hostMethods(context(devbox.identity, { [laptop.identity.key]: toHost })), viewCtx = context(laptop.identity, { [devbox.identity.key]: toViewer });
  viewMethods(viewCtx);
  toViewer.request = async (method, params) => withHome(devbox.home, () => host[method](params, toHost));
  return { team, laptop, devbox, project, toHost, host, viewCtx };
}
function stored(root, id, title, fields = {}) {
  const repo = repository(root), when = new Date(Date.now() - (30 - Number(id)) * 60000).toISOString();
  saveTask(repo, { id: String(id), kind: 'conversation', goal: title, title, titleBy: 'owner', state: 'answered', permissions: 'auto', worktree: root, base: null, branch: null, createdAt: when, activeSince: when, runs: [{ role: 'lead', vendor: 'claude', code: 0, startedAt: when, at: when }], reviews: [], responses: [], messages: [{ at: when, text: title }], sessions: {}, result: { outcome: 'answered', summary: 'Done.' }, ...fields });
}
function shown(p, open = []) {
  return withHome(p.laptop.home, () => {
    const [machine] = remoteMachines(), status = { key: p.laptop.identity.key, name: 'ana', box: 'laptop', teams: [{ members: [{ key: p.laptop.identity.key, name: 'ana' }, { key: p.devbox.identity.key, name: 'ana', box: 'devbox', online: true }] }] };
    const facade = { remoteSessions, remoteMachines, projectRepoId: () => machine.projects[0].repoId, teamProjectRoots: () => [{ team: p.team.teamId, root: '/work/shop', name: 'shop' }] };
    const glue = remoteGlue({ facade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: ({ title, text }) => `${title}: ${text}`, ink: text => text, colour: false, restMs: 0 });
    return glue.sections(Date.now(), '/work/shop', open).filter(line => line.row).map(line => line.row);
  });
}

test('another computer lists the sub sessions there under the session that started them', { timeout: 120000 }, async t => {
  const p = pair(t), root = p.project.root;
  const listed = withHome(p.devbox.home, () => {
    stored(root, 1, 'Release rollout'); stored(root, 2, 'Hourly check 1', { parent: '1' }); stored(root, 3, 'Hourly check 2', { parent: '1' }); stored(root, 4, 'Standup');
    relist();
    return p.host['elu.remote.list']({}, p.toHost).sessions;
  });
  const sent = title => listed.find(row => row.title === title);
  assert.equal(sent('Hourly check 1').parent, `${sent('Release rollout').project}:1`); assert.equal(sent('Release rollout').parent, undefined);
  await withHome(p.laptop.home, () => listTick(p.viewCtx));
  const folded = shown(p);
  assert.deepEqual(folded.map(row => [row.remote.title, Boolean(row.sub), row.subs?.count ?? 0]), [['Standup', false, 0], ['Release rollout', false, 2]]);
  const opened = shown(p, [folded[1].key]);
  assert.deepEqual(opened.map(row => [row.remote.title, Boolean(row.sub)]), [['Standup', false], ['Release rollout', false], ['Hourly check 2', true], ['Hourly check 1', true]]);
  assert.equal(opened[1].subs.open, true);
});

test('schedules a session made fold under it while they wait for their first run', () => {
  const schedules = [9, 10, 11].map(hour => ({ id: `schedule-0000000${hour % 10}`, root: '/p', project: 'P', goal: 'Hourly release check.', when: { kind: 'once', label: `once ${hour}:05` }, enabled: true, nextRunAt: new Date(NOW + hour * 3600000).toISOString(), lastRunAt: null, runs: 0, createdAt: at(10), parent: '1' }));
  const rows = boardRows(project([task(1, { state: 'running', title: 'Release rollout' })]), NOW, { schedules });
  const lines = boardSections(rows, NOW).filter(line => line.row).map(line => line.row);
  assert.deepEqual(lines.map(row => [row.kind, row.subs?.count ?? 0]), [['task', 3]]);
  assert.equal(boardSections(rows, NOW, { open: [lines[0].key] }).filter(line => line.row?.sub).length, 3);
});
