import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { project, fakeClis, CLI } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { conversationEntries, registerProject } from '../lib/projects.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { asksYes, pendingRequests, removeRequest } from '../lib/workspace.mjs';
import { Conductor, enqueue } from '../lib/conductor.mjs';
import { readBoard } from '../lib/kanban.mjs';
import { approveTask, proposeTask, reportProgress } from '../lib/plan.mjs';
import { TEAMMATE_REFUSAL, ownSession, runOwnCommand } from '../lib/session-commands.mjs';
import { JOB_RULES, endJobs, jobsDir, listJobs, waitingJobs } from '../lib/jobs.mjs';
import { KEEP_GOING_LINE, KEEP_GOING_TEXT, jobsEndedText } from '../lib/elu-sent.mjs';
import { stopLongWork } from '../lib/long-work.mjs';
import { lookKeepGoing, setKeepGoing, standing } from '../lib/keep-going.mjs';
import { readData, readSharedArtifacts, sharedArtifacts } from '../lib/artifacts.mjs';
import { COMMANDS } from '../lib/terminal-commands.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { createTeam } from '../lib/peer/roster.mjs';
import { createInvite, redeemCode } from '../lib/peer/invite.mjs';
import { share, setTeamProject } from '../lib/peer/shares.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { hostMethods, projectKey, relist } from '../lib/peer/remote.mjs';

// Where long jobs and keep going (README, "Long jobs") meet the other computers of a shared
// project (README, "A shared project"). Every computer on the project acts on a session under
// that project's /access on the computer that runs it. A job has the mode of the turn that
// starts it and never more, whoever's message that turn answers; ELU's own commands, elu jobs
// among them, belong to the sessions started on the computer that runs them; and keep going is
// the work of that computer alone, which never answers a yes for its owner.
const SARA = 'b'.repeat(64), RULES = 'Only work on the docs folder. Never print a key.', PROBE = 'gates-probe-7';
const STOP_MS = 20000, OWNER = { GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' };
const TASK = { title: 'Pass the gates', description: 'Ten gates.', goal: 'Every gate passes.', objectives: ['Gate one passes', 'Gate two passes'], priority: 'medium', severity: 'low' };
function giveUp(message) { console.error(`other-computers-long-work: ${message} Ending the test process.`); process.exit(1); }
after(() => { setTimeout(() => giveUp('Something is still running 10 s after the last test.'), 10000).unref(); });
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function until(check, message, timeout = 60000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
// ana's computer with a project shared with a team that sara's computer is on (handling: its
// /access here), and what sara's computer asks of it over the link, as the daemon hands it to
// the host methods. fake: what the stand-in Claude Code does.
function world(t, handling, fake = {}) {
  // Added before the folders are made, so it runs before they go: the conductors stop, then every job that still runs.
  const live = [];
  t.after(async () => {
    for (const conductor of live) { const late = setTimeout(() => giveUp(`A conductor did not stop within ${STOP_MS / 1000} s.`), STOP_MS); try { await conductor.stop(); } finally { clearTimeout(late); } }
    for (const row of waitingJobs()) { try { endJobs(row.dir, { by: 'delete' }); } catch { /* Gone. */ } }
  });
  const p = project(t), clis = fakeClis(p.parent, { mode: 'answer', ...fake });
  environment(t, { ...clis.env, HOME: p.parent, ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, ELU_TURN: undefined, ...OWNER });
  const repo = repository(p.root); registerProject(repo);
  const me = createIdentity({ name: 'ana' }), team = createTeam(me, 'core');
  redeemCode(createInvite(me, team.id, { hours: 1 }), SARA, 'sara');
  const shared = share(p.root, { teams: [team.id] }); setTeamProject(team.id, shared.handle);
  saveTeamAccess(team.id, { handling, rules: RULES, root: p.root });
  const ctx = { me, session: () => null, name: () => 'sara', box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} };
  const link = { key: SARA, admitted: true, remoteHello: { remote: 1, shared: 1 }, notify: () => {}, request: async () => { throw new Error('No answer'); } };
  const inputs = path.join(p.parent, 'inputs.jsonl');
  const conduct = () => { const conductor = new Conductor({ tickMs: 20 }).start(); live.push(conductor); return conductor; };
  const request = id => pendingRequests(p.root).find(row => row.id === id);
  return {
    ...p, repo, methods: hostMethods(ctx), link, conduct, request,
    prompts: () => rows(inputs).filter(item => item.vendor === 'claude'),
    shell: () => rows(path.join(clis.dir, 'shell.jsonl')),
    jobs: id => listJobs(jobsDir(repo, id)),
    session: id => readTask(repo, String(id)),
    // The owner's own session, answered once, and its id as sara's computer names it.
    own: async ({ permissions = 'full' } = {}) => {
      const mine = enqueue(p.root, 'Tidy the readme', { priority: 0, permissions, typed: true }), conductor = conduct();
      await until(() => request(mine.id)?.state === 'done', "the owner's own session");
      const taskId = String(request(mine.id).taskId); relist();
      return { conductor, taskId, watched: hostMethods(ctx)['elu.remote.watch']({ ref: `${projectKey(p.root)}:${taskId}` }, link) };
    },
  };
}
const START = text => ({ id: crypto.randomUUID(), text, permissions: 'ask', place: null, bots: [] });
// Where a session stands for the keep-going check, in one word.
const stands = (w, id) => { const at = standing(w.repo, w.session(id), { requests: pendingRequests(w.root), board: readBoard(w.repo), first: 0 }); return at.go ? 'go' : at.why; };
// An approved Task with an objective left, and the switch on as the owner turns it on.
function unmet(w, id) { proposeTask(w.repo, String(id), TASK); approveTask(w.repo, String(id)); reportProgress(w.repo, String(id), { met: [1] }); setKeepGoing(w.repo, String(id), true); }

test("a job started in the turn that answers another computer's message has that turn's mode, the session's, and the turn is told the project's rules", { timeout: 120000 }, async t => {
  const w = world(t, 'auto', { shell: [{ when: PROBE, anywhere: true, run: ['elu jobs start gate -- "sleep 300"', 'elu jobs'] }] });
  const { taskId, watched } = await w.own({ permissions: 'full' });
  assert.deepEqual(w.jobs(taskId), [], 'his own first turn started none');
  const sent = w.methods['elu.remote.send']({ id: watched.id, text: `Run the gates ${PROBE}` }, w.link);
  assert.equal(sent.waits, undefined, 'Auto: it is taken');
  const row = pendingRequests(w.root).find(item => item.computer === SARA);
  assert.deepEqual([row.typed, row.state], [undefined, 'queued'], 'it is that computer\'s message, never one the owner typed');
  await until(() => w.request(row.id)?.state === 'done', "the turn for sara's message");
  const input = w.prompts().at(-1).input;
  assert.ok(input.includes(RULES), 'the turn is told the rules for other computers');
  for (const line of JOB_RULES) assert.ok(input.includes(line), 'and how a long job starts, as every turn of this session is');
  const ran = w.shell();
  assert.deepEqual(ran.map(item => [item.command.split(' ').slice(0, 3).join(' '), item.status]), [['elu jobs start', 0], ['elu jobs', 0]], JSON.stringify(ran));
  // The job: in the session's folder, in the mode of the turn that started it, which is the
  // session's own. Nothing gives a message from another computer a higher one.
  const [job] = w.jobs(taskId);
  assert.deepEqual([job.name, job.state, job.mode, job.by, job.session], ['gate', 'running', 'full', 'lead', taskId]);
  assert.equal(w.session(taskId).permissions, 'full');
  assert.equal(w.session(taskId).messages.findLast(message => message.text.includes(PROBE)).computer, SARA, 'the chat keeps which computer asked for it');
});

test("in a project worked by hand another computer's message waits for the owner's yes: no turn, no job, and keep going neither answers it nor starts the session", { timeout: 120000 }, async t => {
  const w = world(t, 'manual', { shell: [{ when: PROBE, anywhere: true, run: ['elu jobs start gate -- "sleep 300"'] }] });
  const { conductor, taskId, watched } = await w.own({ permissions: 'full' });
  await conductor.stop();
  unmet(w, taskId);
  assert.equal(stands(w, taskId), 'go', 'idle, its Task not met: the check would start it');
  const turns = w.prompts().length;
  // A message into the owner's session, and a new session: each waits for his yes here.
  assert.equal(w.methods['elu.remote.send']({ id: watched.id, text: `Run the gates ${PROBE}` }, w.link).waits, true);
  w.methods['elu.remote.start'](START(`Count the files ${PROBE}`), w.link);
  const waiting = () => pendingRequests(w.root).filter(row => row.computer === SARA).map(row => [row.continuationTaskId == null ? 'new' : 'message', row.state, asksYes(row)]).sort();
  assert.deepEqual(waiting(), [['message', 'waiting', true], ['new', 'waiting', true]]);
  // The check leaves a session alone while a message for it waits for his yes, and says yes to nothing.
  assert.equal(stands(w, taskId), 'queued');
  const sent = [], look = () => lookKeepGoing({ enqueue: (root, text, options) => sent.push({ root, text, options }), projects: () => [w.repo], idleMs: 0 });
  assert.equal(look().sent, 0);
  assert.deepEqual([sent, waiting()], [[], [['message', 'waiting', true], ['new', 'waiting', true]]]);
  // A conductor that runs meanwhile starts neither, and no job starts.
  const again = w.conduct(); await new Promise(resolve => setTimeout(resolve, 600)); await again.stop();
  assert.deepEqual([w.prompts().length, w.jobs(taskId), waiting().length], [turns, [], 2]);
  // He declines the message: the check then starts the session with its own one message, which
  // names no computer and is not marked as typed by him.
  removeRequest(w.root, pendingRequests(w.root).find(row => row.computer === SARA && row.continuationTaskId != null).id);
  assert.equal(look().sent, 1);
  assert.deepEqual(sent, [{ root: w.root, text: KEEP_GOING_TEXT, options: { continuationTaskId: taskId, priority: 0 } }]);
  assert.deepEqual(waiting(), [['new', 'waiting', true]], 'the new session still waits for his yes');
});

test('a session another computer started here has none of ELU\'s own commands, so it starts no long job, and keep going never starts it', { timeout: 120000 }, async t => {
  const w = world(t, 'auto');
  assert.equal(w.methods['elu.remote.start'](START('Count the files'), w.link).waits, undefined, 'Auto: it starts');
  const row = pendingRequests(w.root).find(item => item.computer === SARA);
  const conductor = w.conduct();
  await until(() => w.request(row.id)?.state === 'done', 'the session sara started');
  await conductor.stop();
  const taskId = String(w.request(row.id).taskId), task = w.session(taskId), input = w.prompts().at(-1).input;
  assert.equal(ownSession(task.origin), false);
  assert.ok(input.includes(RULES), 'its turn is told the rules');
  assert.ok(!input.includes(JOB_RULES[1]), 'and is not told of a command it does not have');
  // What its turn would get for the command, in any mode.
  for (const argv of [['jobs', 'start', 'gate', '--', 'sleep 300'], ['jobs'], ['jobs', 'stop', 'gate']]) assert.deepEqual(await runOwnCommand(argv, { repo: w.repo, taskId, mode: 'full' }), { code: 1, err: `${TEAMMATE_REFUSAL}\n` });
  assert.deepEqual(w.jobs(taskId), []);
  // With a Task not met and the switch on, it is still not one the check starts.
  unmet(w, taskId);
  assert.equal(stands(w, taskId), 'not-own');
  const sent = [];
  assert.equal(lookKeepGoing({ enqueue: (...args) => sent.push(args), projects: () => [w.repo], idleMs: 0 }).sent, 0);
  assert.deepEqual(sent, []);
});

// What ELU sends a session by itself is known by its text (lib/elu-sent.mjs). The same words
// from another computer on the project are that computer's message: the chat names who sent
// them, and the owner's Stop takes back only what ELU itself had sent.
test("the words ELU sends a session by itself, sent from another computer, stay that computer's message", { timeout: 60000 }, async t => {
  const w = world(t, 'auto'), from = Date.now() - 10 * 60000, at = n => new Date(from + n * 60000).toISOString();
  const ended = jobsEndedText([{ name: 'gate', code: 0, signal: null, ranMs: 61000, log: path.join(w.parent, 'no.log') }]);
  saveTask(w.repo, { id: '1', kind: 'conversation', goal: 'Run the gates', state: 'answered', permissions: 'full', worktree: w.root, base: null, branch: null, createdAt: at(0), runs: [], reviews: [], responses: [], sessions: {}, result: { outcome: 'done', summary: 'Looked.' },
    messages: [{ at: at(0), text: 'Run the gates' }, { at: at(1), text: KEEP_GOING_TEXT }, { at: at(2), text: KEEP_GOING_TEXT, computer: SARA }, { at: at(3), text: ended, computer: SARA }] });
  const shown = conversationEntries(w.repo, w.session(1)).filter(entry => entry.at !== at(0)).map(entry => [entry.role, entry.text, entry.computer ?? null]);
  assert.deepEqual(shown, [['ELU', KEEP_GOING_LINE, null], ['You', KEEP_GOING_TEXT, SARA], ['You', ended, SARA]], 'the chat says ELU only for what ELU sent');
  // Two wait for the session: ELU's own, and the same words from sara's computer.
  enqueue(w.root, KEEP_GOING_TEXT, { continuationTaskId: '1', priority: 0 });
  enqueue(w.root, KEEP_GOING_TEXT, { continuationTaskId: '1', priority: 0, computer: SARA });
  stopLongWork(w.root, '1');
  assert.deepEqual(pendingRequests(w.root).filter(row => row.continuationTaskId === '1').map(row => [row.goal, row.computer ?? null]), [[KEEP_GOING_TEXT, SARA]], "his Stop takes back ELU's own message and leaves the other computer's");
});

// A chart goes to another computer as the data it shows (lib/artifacts.mjs sharedArtifacts):
// its Artifacts tab there draws from that, to read. Its refresh script stays where it runs.
test('an artifact with a chart goes to another computer as its data alone: no script text, no file path, and nothing there changes it', t => {
  const w = world(t, 'auto'), at = new Date().toISOString();
  const data = readData(JSON.stringify({ blocks: [{ kind: 'score', label: 'Accuracy', value: 84, unit: '%', target: 85 }, { kind: 'chart', label: 'Over time', unit: '%', x: ['run 1', 'run 2', 'run 3'], series: [{ label: 'Accuracy', values: [78, 83, 84] }] }] }));
  const script = `#!/bin/sh\ncat ${path.join(w.parent, 'private', 'eval.json')}\n`;
  const sent = JSON.parse(JSON.stringify(sharedArtifacts([{ title: 'Eval history', shows: 'accuracy by run', every: 5, key: 'eval history', script, scriptAt: at, run: { ok: true, at }, updates: [{ at, data }] }])));
  assert.deepEqual(sent.map(row => Object.keys(row).sort()), [['every', 'script', 'shows', 'title', 'updates']]);
  assert.equal(sent[0].script, true, 'that it has a script, and no more of it');
  const wire = JSON.stringify(sent);
  assert.ok(!wire.includes(w.parent) && !wire.includes('cat ') && !wire.includes('#!/bin/sh'), wire.slice(0, 400));
  // What the other computer's Artifacts tab is given: the same chart, and a script it cannot read.
  const [read] = readSharedArtifacts(sent);
  assert.deepEqual(read.updates.map(update => update.data), [data]);
  assert.equal(read.script, '');
  assert.deepEqual(Object.keys(w.methods).filter(name => /artifact/i.test(name)), [], 'nothing another computer asks changes an artifact');
});

// The commands as they are named to the owner: each once, and none of what "mine" had.
test('elu --help, the README commands and the command list name the long-job commands once and nothing of "mine"', { timeout: 60000 }, () => {
  const names = COMMANDS.map(command => command.name);
  assert.deepEqual(names.filter((name, index) => names.indexOf(name) !== index), [], 'no command is listed twice');
  assert.ok(names.includes('keepgoing') && !names.includes('mine'));
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const table = [...readme.matchAll(/^\| `(\/[a-z-]+)[^`]*` \|/gm)].map(match => match[1]);
  assert.deepEqual(table.filter((name, index) => table.indexOf(name) !== index), [], 'the README table names each command once');
  for (const name of ['/stop', '/keepgoing', '/slots', '/standup', '/archived']) assert.ok(table.includes(name), name);
  assert.ok(!table.includes('/mine'));
  for (const gone of [/--mine\b/, /\belu mine\b/, /GitHub pairing/i]) assert.doesNotMatch(readme, gone);
  // Long jobs are told for the other computers of the project, whoever owns them.
  const jobs = readme.slice(readme.indexOf('### Long jobs'), readme.indexOf('\n## ', readme.indexOf('### Long jobs')));
  assert.match(jobs, /also on the other computers of its\s+project\./); assert.doesNotMatch(jobs, /your\s+other\s+computers?|your\s+teammates/i);
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ELU_NO_UPDATE_CHECK: '1' } });
  assert.equal(help.status, 0, help.stderr);
  const lines = help.stdout.split('\n');
  assert.deepEqual(lines.filter(line => /^ {2}jobs\b/.test(line)), ['  jobs | jobs start NAME -- COMMAND | jobs stop NAME | jobs log NAME']);
  assert.equal(lines.filter(line => /^Long jobs\b/.test(line)).length, 1);
  assert.deepEqual(lines.filter(line => /^ {2}access\b/.test(line)), ['  access [--team ID] [--auto|--manual] [--rules TEXT] [--project PATH] [--home]']);
  assert.doesNotMatch(help.stdout, /\bmine\b|GitHub/);
  // Each line of the peer commands starts with a command of its own.
  const peer = lines.slice(lines.indexOf('Peer network:') + 1, lines.findIndex((line, index) => index > lines.indexOf('Peer network:') && !line.trim())).map(line => line.trim().split(' ')[0]);
  assert.deepEqual(peer, ['id', 'team', 'invite', 'join', 'access', 'share', 'peers', 'peer', 'ask', 'relay']);
});
