import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, git } from './helpers.mjs';
import { makeTeam } from './peer-helpers.mjs';
import { ProjectController, registerProject } from '../lib/projects.mjs';
import { projectFolder, pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { Conductor, OLDER_CONDUCTOR, conductorTakesStandup, enqueue, saveConductorSettings } from '../lib/conductor.mjs';
import { personalDirectory } from '../lib/usage.mjs';
import { addCard, lastActivity, readBoard, setDone } from '../lib/kanban.mjs';
import { boardRows } from '../lib/board.mjs';
import { createConversation } from '../lib/runner.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { localRepos, repoProof, saveCards, saveLocalRepos, saveProofs, sessionCards } from '../lib/peer/cards.mjs';
import { markMine, noteTheirs } from '../lib/peer/mine.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { readCaps } from '../lib/peer/intake.mjs';
import { savePeerPolicy, savePeerSettings } from '../lib/peer/settings.mjs';
import { share } from '../lib/peer/shares.mjs';
import { saveRemotePlans } from '../lib/peer/plans.mjs';
import { approveStandup, hostStandup, hostStandupRead, teamStandupAsk, teamStandupCommand, teamStandupRead, waitingStandups } from '../lib/peer/standup.mjs';
import { remoteCommand } from '../lib/peer/remote.mjs';
import { FRAME_MAX } from '../lib/peer/transport.mjs';
import { STANDUP_QUESTION, newRound, standupOpen, standupStage } from '../lib/standup.mjs';
import { runStandupRound, standupPlan } from '../lib/standup-round.mjs';
import { boardsFor } from '../lib/standup-kanban.mjs';

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
const TIMES = { pollMs: 20, remoteMs: 20, waitMs: 60000, capMs: 20000, recordsMs: 20 };

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

test("the summary turn only answers: Full access runs as Approve for me, with no Task, no edit, no shell and no web", async t => {
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
  // It reads, and has the Kanban tools its relay serves: nothing that edits, runs a command or fetches.
  assert.equal(valueOf(turn.args, '--tools'), 'Read,Grep,Glob');
  for (const name of ['Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch']) assert.ok(valueOf(turn.args, '--disallowedTools').split(',').includes(name), name);
  // The owner's own message in the Standup runs in the session's mode, as any of his messages.
  await f.controller.ask('Make sure the Kanban is right.', standup.id).finished;
  assert.equal(valueOf(inputs(f.fake).at(-1).args, '--permission-mode'), 'bypassPermissions');
  assert.equal(valueOf(inputs(f.fake).at(-1).args, '--tools'), 'default', 'his own messages keep the tools of his mode: every tool in Full access');
});

test('a summary reply that asks to edit is taken as an answer: the Standup ends, never left preparing', async t => {
  const f = setup(t);
  await f.controller.ask('Explain coupons').finished;
  // A vendor that does not hold its reply to the schema says edit, as the stand-in does in normal mode.
  const file = path.join(f.fake.dir, 'fake.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), mode: 'normal' }));
  let over = false; const loop = answering(f.controller, () => over);
  const standup = await f.controller.ask('/standup', null, { standup: true }).finished;
  over = true; await loop;
  assert.match(inputs(f.fake).at(-1).input, /Give a short summary/);
  assert.equal(readTask(f.repo, standup.id).state, 'answered');
  assert.equal(readTask(f.repo, standup.id).codingGoal, undefined);
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
  // On the asker's side a teammate's card is asked by what their computer says, in any column,
  // and one moved to Done is not, as his own. A card of an older build in Done may have
  // answered: it is listed with why, never dropped. A withheld card is never one to ask.
  const kim = 'f'.repeat(64), now = new Date().toISOString();
  const people = () => [{ peer: kim, name: 'kim', online: true, sessions: [
    { id: '0123456789abcdef', title: 'Answered chat', column: 'done', by: 'kim', at: now, standup: true },
    { id: '1123456789abcdef', title: 'Moved to Done', column: 'done', by: 'kim', at: now, standup: false },
    { id: '2123456789abcdef', title: 'Older card', column: 'done', by: 'kim', at: now },
    { id: '3123456789abcdef', title: 'Older open card', column: 'progress', by: 'kim', at: now },
    { id: '4123456789abcdef', title: 'Session', column: 'done', by: 'teammate', at: now },
  ] }];
  const plan = await standupPlan({ root: f.root, id: '999' }, { sources: { computers: () => [], teammates: people } });
  assert.deepEqual(plan.asked.map(row => row.title).sort(), ['Answered chat', 'Older open card']);
  assert.deepEqual(plan.notAsked.map(row => [row.title, row.where, row.why]), [['Older card', '@kim', '@kim runs an older ELU, which does not say whether it answered']]);
  // The round says so in its list of sessions not asked.
  const peer = { peerStatus: () => ({ running: true }), sendPeerCommand: body => ({ id: body.type }), awaitCommand: async () => ({ state: 'declined', asked: [], skipped: [] }) };
  const standup = createConversation(f.repo, f.controller.draftConfig, '/standup');
  const { task: round } = await runStandupRound(f.repo, standup.id, { sources: { computers: () => [], teammates: people, peer }, times: TIMES });
  assert.match(round.messages.map(row => row.text).join('\n'), /- Older card · on @kim · Done · @kim runs an older ELU, which does not say whether it answered/);
});

test('a session another computer would not ask is dropped without a word, and not counted as not asked', async t => {
  const f = setup(t), devbox = 'd'.repeat(64);
  const computers = () => [{ key: devbox, name: '@devbox', online: true, standup: true, sessions: [{ here: false, where: '@devbox', key: devbox, ref: '0123456789abcdef:1', title: 'Old chat', at: Date.now(), state: 'answered', waits: null, last: '' }] }];
  const peer = { peerStatus: () => ({ running: true }), sendPeerCommand: body => ({ id: body.type }), awaitCommand: async id => id === 'remoteStandup' ? { asked: [], skipped: [{ ref: '0123456789abcdef:1', why: 'done' }] } : {} };
  const standup = createConversation(f.repo, f.controller.draftConfig, '/standup');
  const { task, listed } = await runStandupRound(f.repo, standup.id, { sources: { computers, teammates: () => [], peer }, times: TIMES });
  assert.equal(listed, 0);
  assert.doesNotMatch(task.messages.map(row => row.text).join('\n'), /Old chat/);
  assert.equal(task.messages.at(-1).text, 'Standup done · 0 sessions on 0 computers · 0 model updates · 0 not asked');
  assert.match(task.messages.find(row => row.standupChat && row.line).text, /^No session is open to ask/);
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
  // Auto: the round is one of sara's requests here; nothing is spent before an update runs.
  saveTeamAccess(teamId, { handling: 'auto' });
  const round = newRound();
  assert.equal(teamStandupAsk(ctx, sara, { round, cards: [card.id] }).state, 'asked');
  assert.deepEqual([readCaps().peers[sara].runs, readCaps().peers[sara].usd], [1, 0]);
  const [request] = pendingRequests(p.root).filter(value => value.standupFor?.round === round);
  await controller.ask(request.goal, task.id, { standupFor: request.standupFor }).finished;
  assert.doesNotMatch(inputs(fake).at(-1).input, /Private plan of sara/);
  assert.equal(teamStandupRead(sara, { round }).answers.length, 1);
  assert.equal(readCaps().peers[sara].usd, 0, 'counted at what the turn cost');
  teamStandupRead(sara, { round });
  assert.equal(readCaps().peers[sara].usd, 0, 'counted once');
  // Past the day's requests a session is not asked, and the asker reads why.
  savePeerSettings({ caps: { peerRunsPerDay: 1 } });
  const full = newRound();
  teamStandupAsk(ctx, sara, { round: full, cards: [card.id] });
  assert.equal(pendingRequests(p.root).filter(value => value.standupFor?.round === full).length, 0);
  assert.deepEqual(teamStandupRead(sara, { round: full }).answers.map(value => [value.text, value.failed]), [["Not asked: you have used the 1 request a day this teammate's computer allows you.", true]]);
  // To another computer of its owner's this machine is a computer, never a teammate.
  noteTheirs(sara, true);
  const fullMine = newRound();
  teamStandupAsk(ctx, sara, { round: fullMine, cards: [card.id] });
  assert.deepEqual(teamStandupRead(sara, { round: fullMine }).answers.map(value => [value.text, value.failed]), [['Not asked: you have used the 1 request a day this computer allows you.', true]]);
  noteTheirs(sara, false);
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

test("a teammate's standup asks every session: each model update counts what it cost, and a limit truly reached is said plainly on each line", async t => {
  const { teamId, founder, member } = makeTeam(t);
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer' }); environment(t, { ...fake.env, XDG_CONFIG_HOME: founder.home });
  const file = path.join(fake.dir, 'fake.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), spend: { model: 'claude-opus-5-5', tokens: [10, 200, 3000, 400], usd: 0.15 } }));
  git(p.root, ['remote', 'add', 'origin', 'https://github.com/example/shop.git']);
  const controller = new ProjectController(projectFolder(p.root)); controller.draftConfig.checks = []; registerProject(controller.repo);
  for (let n = 1; n <= 26; n++) await controller.ask(`Question ${n}: what does coupons do?`).finished;
  const repos = localRepos(), [row] = repos.values(), sara = member.identity.key, ctx = { me: founder.identity, repos: () => repos, kick: () => {}, event: () => {} };
  saveProofs(sara, [repoProof(sara, founder.identity.key, row.repoId, row.commit)]);
  const rows = sessionCards({ owner: 'ana', repos }), cards = rows.map(value => value.card);
  assert.deepEqual([cards.length, cards.every(card => card.standup)], [26, true]);
  saveTeamAccess(teamId, { handling: 'auto' });
  const near = (value, wanted) => assert.ok(Math.abs(value - wanted) < 1e-6, `${value}, not ${wanted}`);
  const answer = async round => { for (const request of pendingRequests(p.root).filter(value => value.standupFor?.round === round)) await controller.ask(request.goal, request.continuationTaskId, { standupFor: request.standupFor }).finished; return teamStandupRead(sara, { round }).answers; };
  // With the limits as they come, all 26 are asked and answer. The round is one request; each
  // update counts what it cost, and nothing is held or spent before one runs.
  const round = newRound(), asked = teamStandupAsk(ctx, sara, { round, cards: cards.map(card => card.id) });
  assert.deepEqual([asked.state, asked.asked.length, asked.skipped.length], ['asked', 26, 0]);
  assert.deepEqual([readCaps().peers[sara].runs, readCaps().peers[sara].usd], [1, 0]);
  const answers = await answer(round);
  assert.equal(answers.length, 26); assert.deepEqual(answers.filter(value => value.failed).map(value => value.text), []);
  assert.equal(readCaps().peers[sara].runs, 1); near(readCaps().peers[sara].usd, 26 * 0.15);
  // A limit truly reached: no session is asked, and each line says which limit, plainly.
  savePeerSettings({ caps: { peerUsdPerDay: 3.95 } });
  const over = newRound(); teamStandupAsk(ctx, sara, { round: over, cards: cards.slice(0, 2).map(card => card.id) });
  assert.equal(pendingRequests(p.root).filter(value => value.standupFor?.round === over).length, 0);
  assert.deepEqual((await answer(over)).map(value => [value.text, value.failed]), Array(2).fill(["Not asked: you have used the $3.95 a day this teammate's computer allows you.", true]));
  // Reached while the round runs: an update that would pass it is not run, and its session's chat here says why.
  savePeerSettings({ caps: { peerUsdPerDay: 5 } });
  const late = newRound(); teamStandupAsk(ctx, sara, { round: late, cards: cards.slice(0, 2).map(card => card.id) });
  savePeerSettings({ caps: { peerUsdPerDay: 3.95 } });
  assert.deepEqual((await answer(late)).map(value => [value.text, value.failed]), Array(2).fill(["Not asked: you have used the $3.95 a day this teammate's computer allows you.", true]));
  const said = readTask(controller.repo, rows[0].taskId).messages.find(value => value.standup === late && value.failed);
  assert.deepEqual([said.text, said.sent], ['Not asked: @sara has used the $3.95 a day this computer allows them.', "Not asked: you have used the $3.95 a day this teammate's computer allows you."]);
  near(readCaps().peers[sara].usd, 26 * 0.15);
  // The team's limit here, the same way.
  savePeerSettings({ caps: { peerUsdPerDay: 5, teamUsdPerDay: 3.95 } });
  const team = newRound(); teamStandupAsk(ctx, sara, { round: team, cards: [cards[0].id] });
  assert.deepEqual((await answer(team)).map(value => value.text), ["Not asked: your team has used the $3.95 a day this teammate's computer allows it."]);
});

// What a session answers leaves its computer whole, for my other computer and for a teammate:
// nothing is cut at 4000 characters there. One read answers with about 500 KB of updates at
// most, so each answer fits one line on the link; the rest come with the next read, and an
// update longer than that comes in parts, which the asking computer joins.
test('an update leaves the answering computer whole, for my other computer and for a teammate, in as many reads as its length takes', async t => {
  const { teamId, founder, member } = makeTeam(t);
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer' }); environment(t, { ...fake.env, XDG_CONFIG_HOME: founder.home });
  git(p.root, ['remote', 'add', 'origin', 'https://github.com/example/shop.git']);
  const controller = new ProjectController(projectFolder(p.root)); controller.draftConfig.checks = []; registerProject(controller.repo);
  const tasks = []; for (const goal of ['Explain coupons', 'Explain refunds', 'Explain taxes']) tasks.push(await controller.ask(goal).finished);
  const other = member.identity.key, KEY = '0123456789abcdef', refs = tasks.map(task => `${KEY}:${task.id}`);
  const texts = ['Short update.', `Long update.\n${'A line of the update that matters. '.repeat(1000)}END1`, `Longer than one read holds.\n${'Every word of this update counts. '.repeat(40000)}END2 \u{1F600}`];
  const answer = round => tasks.forEach((task, n) => { const now = readTask(controller.repo, task.id); now.messages.push({ at: new Date().toISOString(), text: texts[n], from: 'Opus 5.5', who: 'Opus 5.5', standup: round, answer: true, sent: texts[n] }); saveTask(controller.repo, now); });
  // My other computer asks.
  const round = newRound();
  assert.equal(hostStandup({ round, refs }, other, { projectKey: () => KEY }).asked.length, 3);
  answer(round);
  // A build that cuts updates at 4000 characters itself is sent no more than that, in one answer as before.
  assert.deepEqual(hostStandupRead({ round }, other).answers.map(row => row.text.length), [13, 4000, 4000]);
  // This build reads them whole: every answer is one line on the link, and the parts are joined here.
  markMine(founder.identity.key, other); noteTheirs(other, true);
  const lines = [], asked = [];
  const ctx = { me: founder.identity, session: () => ({ remoteHello: { remote: 1, standup: 1 }, request: async (method, params) => { asked.push([method, params]); const result = hostStandupRead(params, other); lines.push(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))); return result; } }) };
  const got = new Map();
  for (let n = 0; n < 6 && got.size < 3; n++) for (const row of (await remoteCommand(ctx, { type: 'remoteStandupRead', to: other, round, refs: refs.filter(ref => !got.has(ref)) })).answers) got.set(row.ref, row);
  assert.deepEqual(refs.map(ref => got.get(ref).text === texts[refs.indexOf(ref)]), [true, true, true], 'every character of every update');
  assert.deepEqual(refs.map(ref => got.get(ref).who), ['Opus 5.5', 'Opus 5.5', 'Opus 5.5']);
  assert.ok(lines.length > 1 && lines.every(size => size < FRAME_MAX * 0.75), `each answer fits one line on the link: ${lines.join(' ')}`);
  assert.ok(asked.every(([method, params]) => method === 'elu.remote.standupRead' && params.parts === 1));
  // A teammate asks the same sessions through their cards: the same updates, whole, as the teammate check left them.
  const repos = localRepos(), [repo] = repos.values();
  saveProofs(other, [repoProof(other, founder.identity.key, repo.repoId, repo.commit)]);
  const cards = tasks.map(task => sessionCards({ owner: 'ana', repos }).find(value => value.taskId === task.id).card.id);
  saveTeamAccess(teamId, { handling: 'auto' });
  const teamRound = newRound(), host = { me: founder.identity, repos: () => repos, kick: () => {}, event: () => {} };
  assert.equal(teamStandupAsk(host, other, { round: teamRound, cards }).state, 'asked');
  answer(teamRound);
  assert.deepEqual(teamStandupRead(other, { round: teamRound }).answers.map(row => row.text.length), [13, 4000, 4000]);
  const sizes = [], asker = { me: member.identity, session: () => ({ remoteHello: { cards: 1, standup: 1 }, request: async (method, params) => { const result = teamStandupRead(other, params); sizes.push(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))); return result; } }) };
  const told = new Map();
  for (let n = 0; n < 6 && told.size < 3; n++) for (const row of (await teamStandupCommand(asker, { type: 'teamStandupRead', to: founder.identity.key, round: teamRound, cards: cards.filter(card => !told.has(card)) })).answers) told.set(row.card, row);
  assert.deepEqual(cards.map(card => told.get(card).text === texts[cards.indexOf(card)]), [true, true, true]);
  assert.ok(sizes.length > 1 && sizes.every(size => size < FRAME_MAX * 0.75));
});

test('an answer turn is not activity: the session keeps when it last worked and its place in Sessions', async t => {
  const f = setup(t);
  const task = await f.controller.ask('Explain coupons').finished, before = readTask(f.repo, task.id);
  const row = () => boardRows([{ name: 'shop', root: f.root, activity: [], tasks: [readTask(f.repo, task.id)], queue: [] }], Date.parse(before.createdAt) + 3600000).find(value => value.id === task.id);
  const place = row();
  await sleep(20);
  await f.controller.ask(STANDUP_QUESTION, task.id, { standupFor: { round: newRound(), by: 'You' } }).finished;
  const after = readTask(f.repo, task.id);
  assert.ok(after.runs.length > before.runs.length, 'it answered');
  assert.equal(after.activeSince, before.activeSince);
  assert.equal(lastActivity(after), lastActivity(before));
  assert.deepEqual([row().group, row().order, row().time], [place.group, place.order, place.time]);
});

test('the Standup says what it does while it runs: waiting for the sessions, then writing the summary', () => {
  const at = ms => new Date(Date.parse('2026-11-12T12:00:00Z') + ms).toISOString();
  const standup = (messages, fields = {}) => ({ state: 'running', activeRole: null, standup: { rounds: [{ round: 'standup-0000000000000000', at: at(1000) }] }, messages, ...fields });
  const summary = { at: at(500), text: 'Summary of this round.', from: 'Standup', standupChat: true, line: true, summary: true };
  assert.equal(standupStage(standup([summary])), 'round', "a new round, after the last one's summary");
  assert.equal(standupStage(standup([{ at: at(2000), text: 'Asking 2 sessions', standupChat: true, line: true }])), 'round');
  assert.equal(standupStage(standup([{ ...summary, at: at(3000) }])), 'summary');
  assert.equal(standupStage(standup([{ ...summary, at: at(3000) }], { activeRole: 'lead' })), 'summary', 'while its model works on it too');
  assert.equal(standupStage(standup([{ at: at(4000), text: 'Make sure the Kanban is right.' }])), null, "the owner's own message");
  assert.equal(standupStage(standup([], { state: 'answered' })), null);
  assert.equal(standupStage({ state: 'running', messages: [] }), null, 'not a Standup');
});

test("the Standup's model reads the owner's other computers apart from his teammates", async t => {
  const { teamId, founder, member } = makeTeam(t);
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer' }); environment(t, { ...fake.env, XDG_CONFIG_HOME: founder.home });
  git(p.root, ['remote', 'add', 'origin', 'https://github.com/example/shop.git']);
  const controller = new ProjectController(projectFolder(p.root)); controller.draftConfig.checks = []; registerProject(controller.repo);
  await controller.ask('Explain coupons').finished;
  const repos = localRepos(), [repo] = repos.values(), other = member.identity.key, me = founder.identity.key;
  saveLocalRepos(repos);
  saveProofs(other, [repoProof(other, me, repo.repoId, repo.commit)]);
  fs.mkdirSync(peerFile(), { recursive: true });
  fs.writeFileSync(peerFile('state.json'), JSON.stringify({ key: me, running: true, at: new Date().toISOString(), teams: [{ id: teamId, members: [{ key: me, online: true }, { key: other, online: true, box: 'devbox' }] }] }));
  saveCards(other, me, [{ repoId: repo.repoId, id: '0123456789abcdef', title: 'Flaky test', column: 'done', by: 'ana', at: new Date().toISOString() }], { repos });
  const standup = createConversation(controller.repo, controller.draftConfig, '/standup');
  const board = () => boardsFor(controller.repo, readTask(controller.repo, standup.id))[0];
  assert.deepEqual(board().teammates, [{ who: '@ana', title: 'Flaky test', column: 'Done' }]);
  assert.equal(board().otherComputers, undefined);
  // Once it is his own other computer, its session is his, named by that computer.
  markMine(me, other); noteTheirs(other, true);
  assert.deepEqual(board().otherComputers, [{ computer: '@devbox', title: 'Flaky test', column: 'Done' }]);
  assert.equal(board().otherComputersReadOnly, true);
  assert.equal(board().teammates, undefined);
  // It reads every card: of a column, and of the owner's other computers.
  saveCards(other, me, Array.from({ length: 60 }, (_, n) => ({ repoId: repo.repoId, id: n.toString(16).padStart(16, '0'), title: `Card ${n}`, column: 'progress', by: 'ana', at: new Date().toISOString() })), { repos });
  for (let n = 0; n < 45; n++) addCard(controller.repo, `To do ${n}`);
  assert.equal(board().otherComputers.length, 60);
  const todo = board().columns.find(column => column.column === 'To do');
  assert.equal(todo.cards.length, 45); assert.equal(todo.more, undefined);
});

test("a Standup's model reads every update whole; only when it says that is too long for it does the same turn read them bounded", async t => {
  const f = setup(t), config = path.join(f.parent, 'bin', 'fake.json');
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), standupTooLong: 60000 }));
  const standup = createConversation(f.repo, f.controller.draftConfig, '/standup'), kept = readTask(f.repo, standup.id);
  const updates = Array.from({ length: 45 }, (_, n) => ({ id: `u${n + 1}`, session: `Session ${n + 1}`, agent: 'Claude', computer: 'here', at: new Date(Date.now() - (60 - n) * 60000).toISOString(), text: `Update ${n + 1}: ${'x'.repeat(1500)}` }));
  saveTask(f.repo, { ...kept, standup: { ...kept.standup, updates } });
  const task = await f.controller.ask('What is done?', standup.id).finished;
  assert.equal(task.state, 'answered');
  const asked = inputs(f.fake).filter(row => row.vendor === 'claude' && row.input.includes("owner's Standup"));
  assert.equal(asked.length, 2);
  for (const n of [1, 45]) assert.ok(asked[0].input.includes(`Update ${n}:`), `the whole has update ${n}`);
  assert.ok(asked[1].input.includes('Update 45:')); assert.ok(!asked[1].input.includes('Update 1:'));
  assert.match(asked[1].input, /older updates are left out here for length/);
});
