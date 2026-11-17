import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTeam, withHome, registeredProject, shareProjects } from './peer-helpers.mjs';
import { BY_HAND, hostMethods, listTick, relist, remoteMachines, remoteSessions, viewMethods } from '../lib/peer/remote.mjs';
import { repository } from '../lib/git.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { rowBadge } from '../lib/board.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { approveTask, proposeTask } from '../lib/plan.mjs';
import { cleanJobsWire, endJobs, jobsDir, jobsLine, jobsWire, listJobs, sessionJobsNow, startJob, stoppedNotes, waitingJobs } from '../lib/jobs.mjs';
import { STOPPED_LINE } from '../lib/elu-sent.mjs';
import { keepGoingFile, lookKeepGoing } from '../lib/keep-going.mjs';
import { registeredProjects } from '../lib/projects.mjs';

// A session's long jobs and ELU's keep-going stop (docs/jobs.md), as another computer
// on its project shows them: its Sessions row is at work while jobs run there and waits when
// ELU stopped starting it, its chat has the jobs line, and its Task lists each job, to read.
// What that computer may stop follows the project's /access there, whoever owns it.
after(() => { setTimeout(() => { console.error('long-work-remote.test: something is still running 10 s after the last test.'); process.exit(1); }, 10000).unref(); });
// Every job a test here starts has ended when the test has: none runs on after its folder is gone.
const runners = [];
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
after(async () => {
  // One that was just ended is there until this process has taken its end: a moment.
  for (const until = Date.now() + 3000; runners.some(alive) && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 50));
  const left = runners.filter(alive); for (const pid of left) { try { process.kill(-pid, 'SIGKILL'); } catch { /* Gone. */ } }
  assert.deepEqual(left, [], 'a job a test started still ran after the test');
});
const job = async (repo, root, id, name) => { const started = await startJob({ repo, task: readTask(repo, String(id)), root, name, command: ['sleep 300'], mode: 'full' }); runners.push(JSON.parse(fs.readFileSync(`${started.dir}/${name}/job.json`, 'utf8')).runner.pid); return started; };
function connection(key) {
  const sent = [];
  return { key, admitted: true, remoteHello: { remote: 1, shared: 1 }, sent, notify: (method, params) => sent.push([method, params]), request: async () => { throw new Error('No answer'); } };
}
const context = (me, sessions = {}) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
// Two computers on a team with a shared project (handling: its /access on the devbox): the
// laptop looks, the devbox has the sessions.
function pair(t, handling = 'auto') {
  // Added before the two homes are made, so it runs before they are removed (hooks run in the order added): the jobs end while their files are there.
  let home = null; t.after(() => { if (home) withHome(home, () => { for (const row of waitingJobs()) { try { endJobs(row.dir, { by: 'delete' }); } catch { /* Gone. */ } } }); });
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), laptop = team.founder, devbox = team.member; home = devbox.home;
  const project = withHome(devbox.home, () => { const made = registeredProject(t, { origin: 'https://github.com/acme/shop.git' }); saveTeamAccess(team.teamId, { root: made.root }); shareProjects(devbox.identity.key, laptop.identity.key, { handling }); return made; });
  withHome(laptop.home, () => { shareProjects(laptop.identity.key, devbox.identity.key); });
  const toHost = connection(laptop.identity.key), toViewer = connection(devbox.identity.key);
  const hostCtx = context(devbox.identity, { [laptop.identity.key]: toHost }), viewCtx = context(laptop.identity, { [devbox.identity.key]: toViewer });
  const host = hostMethods(hostCtx), viewer = viewMethods(viewCtx);
  toViewer.request = async (method, params) => withHome(devbox.home, () => host[method](params, toHost));
  return { team, laptop, devbox, project, toHost, toViewer, hostCtx, viewCtx, host, viewer };
}
function session(root, id, goal, extra = {}) {
  const repo = repository(root), at = new Date(Date.now() - 20 * 60000).toISOString();
  saveTask(repo, { id: String(id), kind: 'conversation', goal, state: 'answered', permissions: 'full', worktree: root, base: null, branch: null, createdAt: at, runs: [{ role: 'lead', vendor: 'claude', code: 0, startedAt: at, at }], reviews: [], responses: [], messages: [{ at, text: goal }], sessions: {}, result: { outcome: 'done', summary: 'Started the gates.' }, activeRole: null, ...extra });
  return repo;
}
// What the laptop's Sessions shows of the devbox, and its glue.
function shown(p, now = Date.now()) {
  return withHome(p.laptop.home, () => {
    const [machine] = remoteMachines(), status = { key: p.laptop.identity.key, name: 'ana', box: 'laptop', teams: [{ members: [{ key: p.laptop.identity.key, name: 'ana' }, { key: p.devbox.identity.key, name: 'ana', box: 'devbox', online: true }] }] };
    // The laptop has the team's project in /work/shop: the devbox's sessions of it show there.
    const facade = { remoteSessions, remoteMachines, projectRepoId: () => machine.projects[0].repoId, teamProjectRoots: () => [{ team: p.team.teamId, root: '/work/shop', name: 'shop' }] };
    const glue = remoteGlue({ facade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: ({ title, text }) => `${title}: ${text}`, ink: text => text, colour: false, restMs: 0 });
    const rows = glue.sections(now, '/work/shop').filter(line => line.row).map(line => line.row);
    return { rows, by: title => rows.find(row => row.remote.title === title), chat: row => withHome(p.laptop.home, () => glue.parts({ ...row, listed: true, watched: true, online: true }, 100).map(part => part.text).join('\n')) };
  });
}
const TASK = { title: 'Pass the gates', description: 'Ten gates.', goal: 'Every gate passes.', objectives: ['Gate one passes', 'Gate two passes'], priority: 'medium', severity: 'low' };

test('another computer on the project lists a session whose long jobs run there as at work, with the jobs line in its chat and each job in its Task; one ELU stopped starting waits there too', { timeout: 120000 }, async t => {
  const p = pair(t), root = p.project.root;
  const listed = await withHome(p.devbox.home, async () => {
    // Two jobs run in one session; one session only answered; ELU stopped starting a third.
    const repo = session(root, 1, 'Run the gates');
    await job(repo, root, 1, 'gate-one'); await job(repo, root, 1, 'gate-two');
    session(root, 2, 'Where is the export?');
    session(root, 3, 'Fix the flaky gate'); proposeTask(repo, '3', TASK); approveTask(repo, '3');
    fs.writeFileSync(keepGoingFile(repo, '3'), JSON.stringify({ sent: 2, flat: 2, stopped: { at: new Date().toISOString(), flat: 2 } }));
    relist();
    return p.host['elu.remote.list']({}, p.toHost).sessions;
  });
  // What the devbox sends: the running jobs by name and start, and that ELU stopped starting one. Nothing more of a job.
  const sent = title => listed.find(row => row.title === title);
  assert.deepEqual(sent('Run the gates').jobs.map(job => Object.keys(job).sort().join()), ['name,startedAt', 'name,startedAt']);
  assert.deepEqual(sent('Run the gates').jobs.map(job => job.name), ['gate-one', 'gate-two']); assert.equal(sent('Run the gates').kept, undefined);
  assert.deepEqual([sent('Where is the export?').jobs, sent('Where is the export?').kept], [undefined, undefined]);
  assert.deepEqual([sent('Pass the gates').jobs, sent('Pass the gates').kept], [undefined, true]);
  // The laptop lists them.
  await withHome(p.laptop.home, () => listTick(p.viewCtx));
  const now = Date.now(); let there = shown(p, now);
  const gates = there.by('Run the gates');
  assert.deepEqual([gates.group, gates.label, gates.jobs], [1, '2 jobs running', 2], 'at work: not idle, not waiting for me');
  assert.equal(gates.now, jobsLine(gates.remote.jobs, now)); assert.match(gates.now, /^2 jobs running · gate-one \d/);
  assert.equal(rowBadge(gates, now).title, 'on devbox · 2 jobs running');
  assert.match(there.chat(gates), /^2 jobs running · gate-one \d+[sm]/m, 'its chat says the same line');
  assert.deepEqual([there.by('Where is the export?').group, there.by('Where is the export?').label], [3, 'replied']);
  const kept = there.by('Pass the gates');
  assert.deepEqual([kept.group, kept.label, kept.now, rowBadge(kept, now).title], [0, 'WAITING YOU', STOPPED_LINE, 'on devbox · waits for you']);
  // Keep going is the work of the computer that runs the session: the laptop starts nothing
  // for a session it only sees, and asks the devbox for nothing.
  const asked = [], was = p.toViewer.request; p.toViewer.request = async (method, params) => { asked.push(method); return was(method, params); };
  const looked = withHome(p.laptop.home, () => lookKeepGoing({ enqueue: (...args) => asked.push(args), projects: () => registeredProjects(), idleMs: 0 }));
  assert.deepEqual([looked.sent, asked], [0, []]); p.toViewer.request = was;
  // Its Task there lists each job, to read (elu.remote.check with look).
  const view = withHome(p.devbox.home, () => p.host['elu.remote.check']({ ref: sent('Run the gates').ref, look: true }, p.toHost));
  assert.deepEqual(view.checklist.filter(item => /^Job /.test(item.text)).map(item => [item.text, item.met]), [['Job gate-one', false], ['Job gate-two', false]]);
  // One job is stopped there: the next listing says one; both: the row is as it was before jobs.
  withHome(p.devbox.home, () => { const repo = repository(root); endJobs(jobsDir(repo, '1'), { by: 'command' }); relist(); });
  await new Promise(resolve => setTimeout(resolve, 1100));
  const after = withHome(p.devbox.home, () => { relist(); return p.host['elu.remote.list']({}, p.toHost).sessions; });
  assert.equal(after.find(row => row.title === 'Run the gates').jobs, undefined, 'the devbox lists it with no job');
  // The laptop asks again a few seconds on, as it does.
  await new Promise(resolve => setTimeout(resolve, 3100));
  await withHome(p.laptop.home, () => listTick(p.viewCtx));
  there = shown(p);
  assert.deepEqual([there.by('Run the gates').group, there.by('Run the gates').label, there.by('Run the gates').jobs], [3, 'replied', undefined]);
  assert.doesNotMatch(there.chat(there.by('Run the gates')), /jobs? running/);
});

test('a computer on an earlier ELU sends no jobs and its rows are as before; what it is sent is cleaned', { timeout: 120000 }, async t => {
  const p = pair(t), root = p.project.root;
  await withHome(p.devbox.home, async () => {
    const repo = session(root, 1, 'Run the gates');
    await job(repo, root, 1, 'gate-one');
    relist();
  });
  // What 0.1.34 and before send: the same rows, with neither field.
  const asked = p.toViewer.request;
  p.toViewer.request = async (method, params) => { const value = await asked(method, params); return method === 'elu.remote.list' ? { ...value, sessions: value.sessions.map(({ jobs, kept, ...row }) => row) } : value; };
  await withHome(p.laptop.home, () => listTick(p.viewCtx));
  const row = shown(p).by('Run the gates');
  assert.deepEqual([row.group, row.label, row.jobs, row.kept], [3, 'replied', undefined, undefined]);
  // Only a name ELU gives a job and a time are kept of what another computer sends.
  const at = new Date().toISOString();
  assert.deepEqual(jobsWire([{ name: 'gate', state: 'running', startedAt: at, line: 'npm test', log: '/x/log', mode: 'full' }, { name: 'old', state: 'ended', startedAt: at }]), [{ name: 'gate', startedAt: at }]);
  assert.deepEqual(cleanJobsWire([{ name: 'gate', startedAt: at, line: 'rm -rf /', log: '/etc/passwd' }, { name: '../x', startedAt: at }, { name: 'late', startedAt: 'soon' }, 'gate', null]), [{ name: 'gate', state: 'running', startedAt: at }]);
  assert.deepEqual([cleanJobsWire(undefined), cleanJobsWire('gate'), cleanJobsWire(Array.from({ length: 50 }, (_, index) => ({ name: `job-${index}`, startedAt: at }))).length], [[], [], 20]);
});

// /stop over a session on another computer stops that session there where its project is Auto
// (docs/commands.md, "/stop"): with no turn running and its long jobs running, it ends them there, as
// /stop there does.
test('/stop from another computer of an Auto project over a session whose long jobs run there ends them there, and both computers say so', { timeout: 120000 }, async t => {
  const p = pair(t), root = p.project.root;
  const listed = await withHome(p.devbox.home, async () => {
    const repo = session(root, 1, 'Run the gates');
    await job(repo, root, 1, 'gate-one'); await job(repo, root, 1, 'gate-two');
    session(root, 2, 'Where is the export?');
    // A session's jobs are read at most every second (lib/jobs.mjs): read now, as a later look would.
    sessionJobsNow(root, '1', { fresh: true }); relist();
    return p.host['elu.remote.list']({}, p.toHost).sessions;
  });
  const row = title => listed.find(item => item.title === title);
  assert.deepEqual(row('Run the gates').jobs.map(item => item.name), ['gate-one', 'gate-two'], 'the laptop is told its jobs run: its row there is at work');
  // The laptop opens the session and stops it, as /stop over its row does.
  const watched = await withHome(p.devbox.home, () => p.host['elu.remote.watch']({ ref: row('Run the gates').ref }, p.toHost));
  const stopped = await withHome(p.devbox.home, () => p.host['elu.remote.stop']({ id: watched.id }, p.toHost));
  assert.deepEqual(stopped, { stopping: true, jobs: ['gate-one', 'gate-two'] });
  withHome(p.devbox.home, () => {
    const repo = repository(root);
    assert.deepEqual(listJobs(jobsDir(repo, '1')).map(item => [item.name, item.state, Boolean(item.stopped)]), [['gate-one', 'ended', true], ['gate-two', 'ended', true]]);
    // What its chat there shows for it, in one line (lib/projects.mjs reads these), and why keep-going then leaves it to me.
    assert.deepEqual(stoppedNotes(jobsDir(repo, '1')).map(row => [row.by, row.text]), [['stop', 'Stopping also ended 2 jobs the agent started: gate-one, gate-two.']]);
  });
  // What the laptop says of it: the jobs, by how many.
  const said = async (answer, item) => withHome(p.laptop.home, () => remoteGlue({ facade: {}, peerRead: () => ({}), peerCommand: async () => answer, chatMessage: () => '', ink: text => text, colour: false, restMs: 0 }).action({ id: 'a'.repeat(32), machine: 'devbox', remote: {}, ...item }, 'stop'));
  assert.equal(await said(stopped, {}), 'Stopped its 2 jobs on @devbox.');
  assert.equal(await said({ stopping: true, jobs: ['gate-one'] }, {}), 'Stopped job gate-one on @devbox.');
  assert.equal(await said({ stopping: true }, {}), 'Stopping it on @devbox. Changes and chat history are kept there.', 'a turn it stopped, as before');
  // A session there with no turn and no job is refused as before.
  const idle = await withHome(p.devbox.home, () => p.host['elu.remote.watch']({ ref: row('Where is the export?').ref }, p.toHost));
  assert.throws(() => withHome(p.devbox.home, () => p.host['elu.remote.stop']({ id: idle.id }, p.toHost)), /That session is not running\./);
});

// Where the project is worked by hand there, another computer reads a session's jobs and stops
// none: /stop over a session it did not start is refused, and the jobs go on.
test('in a project worked by hand another computer sees a session\'s jobs and cannot stop them', { timeout: 120000 }, async t => {
  const p = pair(t, 'manual'), root = p.project.root;
  const listed = await withHome(p.devbox.home, async () => {
    const repo = session(root, 1, 'Run the gates');
    await job(repo, root, 1, 'gate-one');
    sessionJobsNow(root, '1', { fresh: true }); relist();
    return p.host['elu.remote.list']({}, p.toHost).sessions;
  });
  assert.deepEqual(listed.find(item => item.title === 'Run the gates').jobs.map(item => Object.keys(item).sort().join()), ['name,startedAt'], 'it is told the job runs, by name and start');
  await withHome(p.laptop.home, () => listTick(p.viewCtx));
  assert.deepEqual([shown(p).by('Run the gates').group, shown(p).by('Run the gates').label], [1, '1 job running']);
  const watched = await withHome(p.devbox.home, () => p.host['elu.remote.watch']({ ref: listed.find(item => item.title === 'Run the gates').ref }, p.toHost));
  assert.throws(() => withHome(p.devbox.home, () => p.host['elu.remote.stop']({ id: watched.id }, p.toHost)), { message: BY_HAND });
  withHome(p.devbox.home, () => {
    const repo = repository(root);
    assert.deepEqual(listJobs(jobsDir(repo, '1')).map(item => [item.name, item.state, Boolean(item.stopped)]), [['gate-one', 'running', false]], 'the job goes on');
    assert.deepEqual(stoppedNotes(jobsDir(repo, '1')), []);
  });
});
