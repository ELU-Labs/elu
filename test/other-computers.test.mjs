import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTeam, withHome, registeredProject } from './peer-helpers.mjs';
import { markMine, mineRows, noteTheirs } from '../lib/peer/mine.mjs';
import { hostMethods, listTick, relist, remoteMachines, remoteSessions, viewMethods } from '../lib/peer/remote.mjs';
import { repository } from '../lib/git.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { requestApproval, pendingApprovals } from '../lib/approvals.mjs';
import { enqueue } from '../lib/conductor.mjs';
import { boardRows, remoteRow } from '../lib/board.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';
import { saveTask } from '../lib/state.mjs';
import { projectSnapshot } from '../lib/projects.mjs';

// A connection as the daemon hands it to a method, recording what is sent to it.
function connection(key) {
  const sent = [];
  return { key, admitted: true, remoteHello: { remote: 1 }, sent, notify: (method, params) => sent.push([method, params]), request: async () => { throw new Error('No answer'); } };
}
const context = (me, sessions = {}) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
// Two computers of one owner, each marked by the other: the laptop looks, the devbox has the sessions.
function pair(t) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), laptop = team.founder, devbox = team.member;
  const project = withHome(devbox.home, () => { const made = registeredProject(t, { origin: 'https://github.com/acme/shop.git' }); saveTeamAccess(team.teamId, { root: made.root }); markMine(devbox.identity.key, laptop.identity.key); noteTheirs(laptop.identity.key, true); return made; });
  withHome(laptop.home, () => { markMine(laptop.identity.key, devbox.identity.key); noteTheirs(devbox.identity.key, true); });
  const toHost = connection(laptop.identity.key), toViewer = connection(devbox.identity.key);
  const hostCtx = context(devbox.identity, { [laptop.identity.key]: toHost }), viewCtx = context(laptop.identity, { [devbox.identity.key]: toViewer });
  const host = hostMethods(hostCtx), viewer = viewMethods(viewCtx);
  toViewer.request = async (method, params) => withHome(devbox.home, () => host[method](params, toHost));
  return { team, laptop, devbox, project, toHost, toViewer, hostCtx, viewCtx, host, viewer };
}
// A session saved as the app saves one.
function session(root, id, goal, state, extra = {}) {
  const repo = repository(root);
  saveTask(repo, { id: String(id), kind: 'conversation', goal, state, worktree: root, base: null, branch: null, runs: [], reviews: [], responses: [], messages: [], sessions: {}, result: null, activeRole: state === 'running' ? 'lead' : null, ...extra });
  return repo;
}

test("a row of another computer of mine shows the time that computer's own Sessions row shows, in every state", async t => {
  const { laptop, devbox, project, viewCtx } = pair(t), now = Date.now(), ago = minutes => new Date(now - minutes * 60000).toISOString();
  const said = (minutes, text = 'go on') => ({ role: 'user', at: ago(minutes), text });
  withHome(devbox.home, () => {
    // Created 28 hours ago; the turn that works now started a minute ago.
    session(project.root, 1, 'Works since a minute', 'running', { createdAt: ago(28 * 60), activeSince: ago(1), messages: [said(28 * 60), said(1)], runs: [{ role: 'lead', at: ago(27 * 60) }] });
    session(project.root, 2, 'Answered seven minutes ago', 'answered', { createdAt: ago(3 * 60), messages: [said(3 * 60)], runs: [{ role: 'lead', at: ago(7) }] });
    session(project.root, 3, 'Asks since a day', 'needs_input', { createdAt: ago(2 * 24 * 60), messages: [said(2 * 24 * 60)], runs: [{ role: 'lead', at: ago(24 * 60) }], result: { outcome: 'needs_input', question: 'Which one?' } });
    // Works for twenty minutes, and waits on an approval asked just now.
    session(project.root, 4, 'Wants a command', 'running', { createdAt: ago(5 * 60), activeSince: ago(20), messages: [said(5 * 60), said(20)] });
    requestApproval({ id: 'approval-4a', root: project.root, taskId: '4', role: 'lead', vendor: 'claude', tool: 'Bash', input: { command: 'npm test' } });
    // Answered two hours ago; a message of the owner's to it from four minutes ago did not run.
    session(project.root, 5, 'Message did not run', 'answered', { createdAt: ago(6 * 60), messages: [said(6 * 60)], runs: [{ role: 'lead', at: ago(2 * 60) }] });
    const blocked = enqueue(project.root, 'and the tests', { priority: 0, continuationTaskId: '5' });
    updateRequest(project.root, blocked.id, { state: 'blocked', reason: 'The model could not run.', createdAt: ago(4) });
    session(project.root, 6, 'Task to approve', 'answered', { createdAt: ago(9 * 60), messages: [said(9 * 60)], runs: [{ role: 'lead', at: ago(50) }], plan: { state: 'proposed', title: 'Trim the codes' } });
    session(project.root, 7, 'Getting ready', 'preparing', { createdAt: ago(26 * 60), activeSince: ago(3), messages: [said(26 * 60), said(3)] });
    relist();
  });
  const here = withHome(devbox.home, () => { assert.equal(pendingRequests(project.root).find(row => row.continuationTaskId === '5').state, 'blocked'); return boardRows([projectSnapshot(repository(project.root))], now, { approvals: pendingApprovals() }); });
  const own = Object.fromEntries(here.filter(row => row.kind === 'task').map(row => [row.task.goal, row.time]));
  assert.deepEqual(own, { 'Works since a minute': '1m00', 'Answered seven minutes ago': '7m ago', 'Asks since a day': '1d ago', 'Wants a command': 'just now', 'Message did not run': '4m ago', 'Task to approve': '50m ago', 'Getting ready': '3m00' });
  await withHome(laptop.home, () => listTick(viewCtx));
  const there = withHome(laptop.home, () => {
    const [machine] = remoteMachines(), status = { key: laptop.identity.key, name: 'ana', box: 'laptop', teams: [{ members: [{ key: laptop.identity.key, name: 'ana' }, { key: devbox.identity.key, name: 'ana', box: 'devbox', online: true }] }] };
    const facade = { mineRows, remoteSessions, remoteMachines, projectRepoId: () => machine.projects[0].repoId };
    const glue = remoteGlue({ facade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: ({ text }) => text, ink: text => text, colour: false, restMs: 0 });
    return glue.sections(now, '/work/shop').filter(line => line.row).map(line => line.row);
  });
  assert.equal(there.length, 7);
  assert.deepEqual(Object.fromEntries(there.map(row => [row.remote.title, row.time])), own, 'each row there shows what the row here shows');
});

test('a row of a session on a computer of mine counts from what that computer says, and for one on an earlier version from the start of its run', () => {
  const now = Date.parse('2026-11-11T10:00:00Z'), view = { id: 'a'.repeat(8), machine: 'a'.repeat(64), createdAt: '2026-11-10T06:00:00Z', lastAt: '2026-11-11T09:59:00Z', state: 'running', title: 'Works since a minute', approvals: [], steps: [] };
  // What a computer on 0.1.20 sends with its list and with a session's state.
  assert.equal(remoteRow({ ...view, since: { run: true, at: '2026-11-11T09:20:00Z' } }, 'devbox', now).time, '40m00');
  assert.equal(remoteRow({ ...view, state: 'answered', since: { at: '2026-11-11T09:53:00Z' } }, 'devbox', now).time, '7m ago');
  // What it said belongs to another state than the one shown: the row counts as it did before.
  assert.equal(remoteRow({ ...view, state: 'answered', since: { run: true, at: '2026-11-11T09:20:00Z' } }, 'devbox', now).time, '1m ago');
  // An earlier version says nothing: a turn that works counts from the start of its run when this machine follows it.
  assert.equal(remoteRow({ ...view, runs: [{ run: 'r1', startedAt: '2026-11-10T06:00:00Z', at: '2026-11-10T06:10:00Z' }, { run: 'r2', startedAt: '2026-11-11T09:58:00Z', at: null }] }, 'devbox', now).time, '2m00');
  assert.equal(remoteRow(view, 'devbox', now).time, '28h00');
});
