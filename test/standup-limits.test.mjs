import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, git } from './helpers.mjs';
import { makeTeam } from './peer-helpers.mjs';
import { ProjectController, registerProject } from '../lib/projects.mjs';
import { projectFolder, pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';
import { Conductor, OLDER_CONDUCTOR, conductorTakesStandup, enqueue, saveConductorSettings } from '../lib/conductor.mjs';
import { personalDirectory } from '../lib/usage.mjs';
import { readBoard, setDone } from '../lib/kanban.mjs';
import { createConversation } from '../lib/runner.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { localRepos, repoProof, saveProofs, sessionCards } from '../lib/peer/cards.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { readCaps } from '../lib/peer/intake.mjs';
import { savePeerPolicy, savePeerSettings } from '../lib/peer/settings.mjs';
import { share } from '../lib/peer/shares.mjs';
import { saveRemotePlans } from '../lib/peer/plans.mjs';
import { approveStandup, hostStandup, teamStandupAsk, teamStandupCommand, teamStandupRead, waitingStandups } from '../lib/peer/standup.mjs';
import { peerRunUsd } from '../lib/adapters/claude.mjs';
import { STANDUP_QUESTION, newRound, standupOpen } from '../lib/standup.mjs';
import { runStandupRound, standupPlan } from '../lib/standup-round.mjs';

// What a standup may cost and start: never run again on its own, counted against the agent
// limit while its model works, never queued for an older conductor, a summary turn that only
// answers, a teammate's round spent from their allowance and checked again at approval, and
// the same rule for which sessions are open on every computer.

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function setup(t, options = { mode: 'answer' }) {
  const p = project(t), fake = fakeClis(p.parent, options); environment(t, fake.env);
  const controller = new ProjectController(projectFolder(p.root)); controller.draftConfig.checks = [];
  registerProject(controller.repo);
  return { ...p, fake, controller, repo: controller.repo };
}
const inputs = fake => fs.existsSync(path.join(path.dirname(fake.calls), 'inputs.jsonl')) ? fs.readFileSync(path.join(path.dirname(fake.calls), 'inputs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const valueOf = (args, flag) => args[args.indexOf(flag) + 1];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function answering(controller, done) {
  const handled = new Set();
  return (async () => {
    while (!done()) {
      for (const row of pendingRequests(controller.repo.root).filter(value => value.standupFor && value.state === 'queued' && !handled.has(value.id))) {
        handled.add(row.id); updateRequest(controller.repo.root, row.id, { state: 'running' });
        await controller.ask(row.goal, row.continuationTaskId, { standupFor: row.standupFor }).finished;
        updateRequest(controller.repo.root, row.id, { state: 'done', reason: 'Finished.' });
      }
      await sleep(20);
    }
  })();
}
const TIMES = { pollMs: 20, remoteMs: 20, waitMs: 0, capMs: 20000 };

test('a round and its questions are never run again on their own after a rate limit; other work is', t => {
  const f = setup(t), conductor = new Conductor();
  const error = () => Object.assign(new Error('Rate limited.'), { details: { cause: 'rate-limit' } });
  const record = (row, extra) => ({ root: f.root, requestId: row.id, taskId: '1', goal: row.goal, origin: null, scheduled: false, round: false, answers: false, attempts: 0, controller: f.controller, stalled: false, ...extra });
  const round = enqueue(f.root, '/standup', { standup: true }); updateRequest(f.root, round.id, { state: 'running' });
  conductor.finish(record(round, { round: true }), error());
  const question = enqueue(f.root, STANDUP_QUESTION, { continuationTaskId: '1', priority: 1, standupFor: { round: newRound(), by: 'You' } }); updateRequest(f.root, question.id, { state: 'running' });
  conductor.finish(record(question, { answers: true, stalled: true }), error());
  const work = enqueue(f.root, 'Fix the cart', { continuationTaskId: '1' }); updateRequest(f.root, work.id, { state: 'running' });
  conductor.finish(record(work), error());
  const state = id => pendingRequests(f.root).find(row => row.id === id);
  assert.equal(state(round.id).state, 'done'); assert.equal(state(round.id).attempts, 0);
  assert.equal(state(question.id).state, 'done');
  assert.equal(state(work.id).state, 'queued', 'ordinary work is retried as before');
});

test("a round takes no slot while it waits for answers, and one once its summary turn starts", t => {
  const f = setup(t);
  saveConductorSettings({ maxAgents: 1 });
  const conductor = new Conductor(), launched = [];
  let summing = false;
  conductor.runs.set('round', { root: path.join(f.parent, 'elsewhere'), taskId: '9', round: true, summing: () => summing });
  conductor.launch = (repo, row) => launched.push(row.id);
  const row = enqueue(f.root, 'Explain coupons');
  conductor.dispatch();
  assert.deepEqual(launched, [row.id]);
  launched.length = 0; summing = true;
  conductor.dispatch();
  assert.deepEqual(launched, [], 'the summary is a model turn within the limit');
});

test('while the conductor here runs an older build, nothing of a standup is queued for it', t => {
  const f = setup(t);
  const status = path.join(personalDirectory(), 'conductor', 'state.json');
  fs.mkdirSync(path.dirname(status), { recursive: true });
  const write = extra => fs.writeFileSync(status, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), stopped: false, error: null, queued: 0, runs: [], heartbeatAt: new Date().toISOString(), ...extra }));
  t.after(() => fs.rmSync(status, { force: true }));
  write({});
  assert.equal(conductorTakesStandup(), false);
  assert.throws(() => enqueue(f.root, '/standup', { standup: true }), new RegExp(OLDER_CONDUCTOR.slice(0, 40)));
  assert.throws(() => enqueue(f.root, STANDUP_QUESTION, { continuationTaskId: '1', standupFor: { round: newRound(), by: 'You' } }), /build from before your update/);
  assert.deepEqual(hostStandup({ round: newRound(), refs: [] }, 'a'.repeat(64), { projectKey: () => '0123456789abcdef' }), { older: true, asked: [], skipped: [] });
  write({ standup: 1 });
  assert.equal(conductorTakesStandup(), true);
  assert.equal(enqueue(f.root, '/standup', { standup: true }).standup, true);
});

test("the summary turn only answers: Full access runs as Approve for me, with no Task and no edit", async t => {
  const f = setup(t);
  await f.controller.ask('Explain coupons').finished;
  let over = false; const loop = answering(f.controller, () => over);
  const standup = await f.controller.ask('/standup', null, { standup: true, permissions: 'full' }).finished;
  over = true; await loop;
  assert.equal(readTask(f.repo, standup.id).permissions, 'full');
  const turn = inputs(f.fake).at(-1);
  assert.match(turn.input, /Give a short summary/);
  assert.equal(valueOf(turn.args, '--permission-mode'), 'auto');
  assert.deepEqual(JSON.parse(valueOf(turn.args, '--json-schema')).properties.intent.enum, ['answer']);
  // The owner's own message in the Standup runs in the session's mode, as any of his messages.
  await f.controller.ask('Make sure the Kanban is right.', standup.id).finished;
  assert.equal(valueOf(inputs(f.fake).at(-1).args, '--permission-mode'), 'bypassPermissions');
});

test("a Claude Code session answers in a fork of its vendor session; its next turn resumes its own", async t => {
  const f = setup(t);
  // The fake Claude Code lists --fork-session in its help, as the real one does.
  const file = path.join(f.fake.dir, 'claude'), script = fs.readFileSync(file, 'utf8');
  assert.ok(script.includes("'--print --add-dir"), 'the fake prints its help as expected');
  fs.writeFileSync(file, script.replace("'--print --add-dir", "'--fork-session --print --add-dir"), { mode: 0o755 });
  const task = await f.controller.ask('Explain coupons').finished;
  const before = readTask(f.repo, task.id).sessions;
  await f.controller.ask(STANDUP_QUESTION, task.id, { standupFor: { round: newRound(), by: 'You' } }).finished;
  const answer = inputs(f.fake).at(-1).args;
  assert.ok(answer.includes('--resume') && answer[answer.indexOf('--resume') + 2] === '--fork-session', answer.join(' '));
  assert.deepEqual(readTask(f.repo, task.id).sessions, before);
  await f.controller.ask('And the tests?', task.id).finished;
  const next = inputs(f.fake).at(-1).args;
  assert.ok(next.includes('--resume') && !next.includes('--fork-session'));
});

test('the same rule says which sessions are open everywhere: an answered chat is asked, one moved to Done is not', async t => {
  const f = setup(t);
  const task = await f.controller.ask('Explain coupons').finished;
  assert.equal(readTask(f.repo, task.id).state, 'answered');
  assert.equal(standupOpen(readBoard(f.repo), readTask(f.repo, task.id)), true);
  setDone(f.repo, { task: readTask(f.repo, task.id) }, true);
  assert.equal(standupOpen(readBoard(f.repo), readTask(f.repo, task.id)), false);
  // On the asker's side a teammate's card is asked by what their computer says, in any column;
  // a card of an older build in Done is left out, as before. None of those is listed.
  const kim = 'f'.repeat(64), now = new Date().toISOString();
  const people = () => [{ peer: kim, name: 'kim', online: true, sessions: [
    { id: '0123456789abcdef', title: 'Answered chat', column: 'done', by: 'kim', at: now, standup: true },
    { id: '1123456789abcdef', title: 'Moved to Done', column: 'done', by: 'kim', at: now, standup: false },
    { id: '2123456789abcdef', title: 'Older card', column: 'done', by: 'kim', at: now },
    { id: '3123456789abcdef', title: 'Older open card', column: 'progress', by: 'kim', at: now },
  ] }];
  const plan = await standupPlan({ root: f.root, id: '999' }, { sources: { computers: () => [], teammates: people } });
  assert.deepEqual(plan.asked.map(row => row.title).sort(), ['Answered chat', 'Older open card']);
  assert.deepEqual(plan.notAsked, []);
});

test('a session another computer would not ask is dropped without a word, and not counted as not asked', async t => {
  const f = setup(t), devbox = 'd'.repeat(64);
  const computers = () => [{ key: devbox, name: '@devbox', online: true, standup: true, sessions: [{ here: false, where: '@devbox', key: devbox, ref: '0123456789abcdef:1', title: 'Old chat', at: Date.now(), state: 'answered', waits: null, last: '' }] }];
  const peer = { peerStatus: () => ({ running: true }), sendPeerCommand: body => ({ id: body.type }), awaitCommand: async id => id === 'remoteStandup' ? { asked: [], skipped: [{ ref: '0123456789abcdef:1', why: 'done' }] } : {} };
  const standup = createConversation(f.repo, f.controller.draftConfig, '/standup');
  const { task, listed } = await runStandupRound(f.repo, standup.id, { sources: { computers, teammates: () => [], peer }, times: TIMES });
  assert.equal(listed, 0);
  assert.doesNotMatch(task.messages.map(row => row.text).join('\n'), /Old chat/);
  assert.equal(task.messages.at(-1).text, 'Standup done · 0 sessions on 0 computers · 0 not asked');
});

test("a teammate's round spends from their allowance, is checked again when approved, and an older conductor there is told back", async t => {
  const { teamId, founder, member } = makeTeam(t);
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer' }); environment(t, { ...fake.env, XDG_CONFIG_HOME: founder.home });
  git(p.root, ['remote', 'add', 'origin', 'https://github.com/example/shop.git']);
  const controller = new ProjectController(projectFolder(p.root)); controller.draftConfig.checks = []; registerProject(controller.repo);
  const task = await controller.ask('Explain coupons').finished;
  const repos = localRepos(), [row] = repos.values();
  saveProofs(member.identity.key, [repoProof(member.identity.key, founder.identity.key, row.repoId, row.commit)]);
  const card = sessionCards({ owner: 'ana', repos }).find(value => value.taskId === task.id).card;
  assert.equal(card.standup, true, 'an answered chat is one to ask, whatever its column');
  const ctx = { me: founder.identity, repos: () => repos, kick: () => {}, event: () => {} }, sara = member.identity.key;
  // What only the owner reads, teammates' Tasks among it, is not given to a teammate's round.
  const shared = share(p.root, { handle: 'shop', teams: [teamId] });
  fs.mkdirSync(peerFile(), { recursive: true });
  fs.writeFileSync(peerFile('state.json'), JSON.stringify({ key: founder.identity.key, running: true, at: new Date().toISOString(), teams: [{ id: teamId, members: [{ key: founder.identity.key, online: true }, { key: sara, online: true }] }] }));
  saveRemotePlans(sara, [{ repoId: shared.repoId, handle: 'shop', id: 't-0a1b2c3d', revision: 1, title: 'Private plan of sara', description: 'Text', goal: 'Ship it.', objectives: ['One'], priority: 'high', severity: 'critical', state: 'approved', startedBy: 'owner', who: 'Opus 5.5', subtasks: [], met: [], approvedAt: new Date().toISOString(), doneAt: null, updatedAt: new Date().toISOString() }]);
  await controller.ask(STANDUP_QUESTION, task.id, { standupFor: { round: newRound(), by: 'You' } }).finished;
  assert.match(inputs(fake).at(-1).input, /Private plan of sara/, "the owner's own round is told teammates' Tasks");
  // Auto: each session asked is one of sara's runs here and reserves what one run may spend.
  saveTeamAccess(teamId, { handling: 'auto' });
  const round = newRound();
  assert.equal(teamStandupAsk(ctx, sara, { round, cards: [card.id] }).state, 'asked');
  assert.deepEqual([readCaps().peers[sara].runs, readCaps().peers[sara].usd], [1, peerRunUsd()]);
  const [request] = pendingRequests(p.root).filter(value => value.standupFor?.round === round);
  await controller.ask(request.goal, task.id, { standupFor: request.standupFor }).finished;
  assert.doesNotMatch(inputs(fake).at(-1).input, /Private plan of sara/);
  assert.equal(teamStandupRead(sara, { round }).answers.length, 1);
  assert.equal(readCaps().peers[sara].usd, 0, 'settled to what the turn cost');
  teamStandupRead(sara, { round });
  assert.equal(readCaps().peers[sara].usd, 0, 'settled once');
  // Past the day's requests a session is not asked, and the asker reads why.
  savePeerSettings({ caps: { peerRunsPerDay: 1 } });
  const full = newRound();
  teamStandupAsk(ctx, sara, { round: full, cards: [card.id] });
  assert.equal(pendingRequests(p.root).filter(value => value.standupFor?.round === full).length, 0);
  assert.deepEqual(teamStandupRead(sara, { round: full }).answers.map(value => [value.text, value.failed]), [['It was not asked: the daily request limit for this teammate.', true]]);
  savePeerSettings({ caps: { peerRunsPerDay: 20 } });
  // Manual: a teammate muted after asking is declined when the owner says y.
  saveTeamAccess(teamId, { handling: 'manual' });
  const waiting = newRound();
  assert.equal(teamStandupAsk(ctx, sara, { round: waiting, cards: [card.id] }).state, 'waiting');
  const [item] = waitingStandups();
  savePeerPolicy(sara, { muted: true });
  assert.deepEqual(approveStandup(ctx, item.id), { asked: 0, declined: true });
  assert.equal(teamStandupRead(sara, { round: waiting }).state, 'declined');
  assert.equal(pendingRequests(p.root).filter(value => value.standupFor?.round === waiting).length, 0);
  // Their conductor runs an older build: told back as older, never as an empty answer.
  const older = await teamStandupCommand({ ...ctx, session: () => ({ remoteHello: { cards: 1, standup: 1 }, request: async () => ({ older: true }) }) }, { type: 'teamStandup', to: sara, round: newRound(), cards: [card.id] });
  assert.deepEqual(older, { older: true });
});
