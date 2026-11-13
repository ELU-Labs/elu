import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { project, fakeClis, keyLike, git } from './helpers.mjs';
import { makeTeam, answeringClis, withHome } from './peer-helpers.mjs';
import { markMine, noteTheirs } from '../lib/peer/mine.mjs';
import { ProjectController, registerProject } from '../lib/projects.mjs';
import { projectFolder, pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { readTask, saveTask, taskTitle } from '../lib/state.mjs';
import { enqueue } from '../lib/conductor.mjs';
import { addCard, closeSession, readBoard, setDone } from '../lib/kanban.mjs';
import { currentTask } from '../lib/plan.mjs';
import { createConversation } from '../lib/runner.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { localRepos, repoProof, saveProofs, sessionCards } from '../lib/peer/cards.mjs';
import { savePeerPolicy } from '../lib/peer/settings.mjs';
import { declineStandup, teamStandupAsk, teamStandupCommand, teamStandupRead, waitingStandups } from '../lib/peer/standup.mjs';
import { remoteCommand } from '../lib/peer/remote.mjs';
import { STANDUP_QUESTION, UPDATES_MAX, boundedUpdates, checkStandupFor, everyoneMessage, newRound, standupAgent, standupLeftOut, standupReply, teammateAnswer } from '../lib/standup.mjs';
import { endLine, runStandupRound, standupPlan } from '../lib/standup-round.mjs';
import { kanbanTool, standupSession } from '../lib/standup-kanban.mjs';
import { serve, TOOL_NAME } from '../lib/approval-server.mjs';
import { answerApproval, pendingApprovals } from '../lib/approvals.mjs';

// /standup (README, "Standup"): who is asked, the read-only answer turn, a round, its summary,
// @everyone, the Standup's Kanban tools, and what reaches another computer.

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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// What the conductor does with a standup's question: the request runs, the session answers it
// once its turn is over, and the request is done. A session that works is left for the round to list.
function answering(controller, done) {
  const handled = new Set();
  const loop = (async () => {
    while (!done()) {
      for (const row of pendingRequests(controller.repo.root).filter(value => value.standupFor && value.state === 'queued' && !handled.has(value.id))) {
        if (['running', 'preparing'].includes(readTask(controller.repo, row.continuationTaskId).state)) continue;
        handled.add(row.id); updateRequest(controller.repo.root, row.id, { state: 'running' });
        await controller.ask(row.goal, row.continuationTaskId, { standupFor: row.standupFor }).finished;
        updateRequest(controller.repo.root, row.id, { state: 'done', reason: 'Finished.' });
      }
      await sleep(20);
    }
  })();
  return loop;
}
const TIMES = { pollMs: 20, remoteMs: 20, waitMs: 0, capMs: 20000 };
const none = { computers: () => [], teammates: () => [], peer: null };

test('@everyone and a standup question are read as the round asks them', () => {
  assert.deepEqual(everyoneMessage('@everyone standup'), { question: null });
  assert.deepEqual(everyoneMessage('@everyone'), { question: null });
  assert.deepEqual(everyoneMessage('@Everyone  did anyone touch auth?'), { question: 'did anyone touch auth?' });
  assert.equal(everyoneMessage('@everyoneelse hi'), null); assert.equal(everyoneMessage('hello @everyone'), null);
  const round = newRound();
  assert.deepEqual(checkStandupFor({ round, by: 'You' }), { round, by: 'You', question: null });
  assert.throws(() => checkStandupFor(round), /asks one of your sessions/);
  assert.throws(() => checkStandupFor({ round, by: '' }), /says who asks/);
  assert.throws(() => checkStandupFor({ round, by: '@kim', peer: 'not-a-key' }), /by key/);
});

test('who is asked: open sessions with an agent; archived, Done, quiet, a Standup and a teammate session are not', () => {
  const now = Date.parse('2026-11-12T12:00:00Z'), day = 86400000, at = ms => new Date(ms).toISOString();
  const board = { cards: [], done: ['2', '3'], archived: ['2'], closed: { 2: at(now - 2 * day), 3: at(now - 2 * day) } };
  const task = (id, fields = {}) => ({ id, createdAt: at(now - 30 * day), state: 'answered', runs: [{ role: 'lead', at: at(now - day) }], messages: [], ...fields });
  assert.equal(standupLeftOut(board, task('1'), { now }), null, 'active this week');
  assert.equal(standupLeftOut(board, task('2', { runs: [{ role: 'lead', at: at(now - 3 * day) }] }), { now }), 'archived');
  assert.equal(standupLeftOut(board, task('3', { runs: [{ role: 'lead', at: at(now - 3 * day) }] }), { now }), 'done');
  assert.equal(standupLeftOut(board, task('4', { runs: [{ role: 'lead', at: at(now - 9 * day) }] }), { now }), 'quiet');
  assert.equal(standupLeftOut(board, task('5', { state: 'running', runs: [{ role: 'lead', at: at(now - 9 * day) }] }), { now }), null, 'working');
  assert.equal(standupLeftOut(board, task('6', { state: 'needs_input', runs: [{ role: 'lead', at: at(now - 9 * day) }] }), { now, waits: { question: 'asks you' } }), null, 'waiting for him');
  assert.equal(standupLeftOut(board, task('7', { standup: { rounds: [] } }), { now }), 'standup');
  assert.equal(standupLeftOut(board, task('8', { origin: { peer: 'a'.repeat(64), kind: 'ask', name: 'kim' } }), { now }), 'teammate');
  assert.equal(standupLeftOut(board, task('9', { runs: [] }), { now }), 'no agent');
  // A standup answered last week is not activity: the session stays quiet.
  assert.equal(standupLeftOut(board, task('10', { runs: [{ role: 'lead', at: at(now - 9 * day) }, { role: 'lead', at: at(now - day), standup: 'standup-0000000000000000' }] }), { now }), 'quiet');
});

test('a session with a worker bot is answered by that bot; otherwise by its lead', () => {
  const find = name => name === 'billing' ? { name: 'billing', vendor: 'claude', works: 'always' } : null;
  assert.deepEqual(standupAgent({ runs: [{ role: 'lead' }] }, find), { lead: true });
  assert.deepEqual(standupAgent({ runs: [], botChat: 'billing' }, find), { bot: find('billing') });
  assert.deepEqual(standupAgent({ runs: [], botChat: 'gone' }, find), { lead: true });
});

test('what leaves for a teammate: paths cut, and an update that may hold a secret is held', () => {
  const cut = teammateAnswer('Working on /srv/notes/billing.txt and src/billing.mjs, tests next.', { root: '/srv/shop' });
  assert.equal(cut.held, false); assert.equal(cut.text, 'Working on [path] and src/billing.mjs, tests next.');
  const held = teammateAnswer(`Set the token to ${keyLike('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')}`, { root: '/tmp' });
  assert.deepEqual(held, { text: null, held: true });
  // A random temporary folder in a path is not a secret: the update goes, with the path cut.
  const temp = teammateAnswer('Fixed the round in /tmp/su2-9SAVeT/x-link/tmp/elu-Qw8RtZ/project/notes/round.mjs, tests next.', { root: '/srv/shop' });
  assert.deepEqual(temp, { text: 'Fixed the round in [path], tests next.', held: false });
  // Nor is a path with spaces in a folder and file name: all of it is cut, written plain or in quotes.
  const spaced = '/Library/Application Support/CleanShot/media/media_8Qw4Rt2LmZ/CleanShot 2026-11-12 at 10.14.07@2x.png';
  assert.deepEqual(teammateAnswer(`Screenshot saved in ~${spaced}, tests next.`, { root: '/srv/shop' }), { text: 'Screenshot saved in [path], tests next.', held: false });
  assert.deepEqual(teammateAnswer(`Screenshot saved in '/Users/sam${spaced}', tests next.`, { root: '/srv/shop' }), { text: "Screenshot saved in '[path]', tests next.", held: false });
  // A base64 key split by its own "/" under a folder named like secrets is held.
  assert.deepEqual(teammateAnswer(`The deploy key is config/secrets/${keyLike('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY')}.`, { root: '/srv/shop' }), { text: null, held: true });
});

test("the Standup's model reads every update whole, newest first; only a model that says they are too long for it is given fewer", () => {
  const updates = Array.from({ length: 45 }, (_, n) => ({ id: `u${n + 1}`, at: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(), text: 'x'.repeat(n === 44 ? 5000 : 100) }));
  const whole = boundedUpdates(updates);
  assert.equal(whole.length, 45); assert.equal(whole[0].id, 'u45'); assert.equal(whole[0].text.length, 5000);
  const kept = boundedUpdates(updates, { fitted: true });
  assert.equal(kept.length, UPDATES_MAX + 1); assert.equal(kept[0].id, 'u45');
  assert.match(kept[0].text, /cut this update here/); assert.ok(kept[0].text.length < 3200);
  assert.match(kept.at(-1).note, /15 older updates are left out/);
  assert.equal(endLine({ answered: [{ where: 'here' }, { where: '@devbox' }, { where: '@devbox' }], notAsked: 2 }), 'Standup done · 3 sessions on 2 computers · 2 not asked');
});

test('a standup request is checked: it asks one session, or is a round of a Standup', t => {
  const { root } = project(t), round = newRound();
  environment(t, { XDG_CONFIG_HOME: path.join(path.dirname(root), 'personal') });
  const asked = enqueue(root, STANDUP_QUESTION, { continuationTaskId: '1', priority: 1, standupFor: { round, by: 'You', question: 'What blocks you?' } });
  assert.deepEqual(asked.standupFor, { round, by: 'You', question: 'What blocks you?' });
  assert.throws(() => enqueue(root, STANDUP_QUESTION, { continuationTaskId: '1', standupFor: round }), /asks one of your sessions/);
  assert.throws(() => enqueue(root, STANDUP_QUESTION, { standupFor: { round, by: 'You' } }), /asks one of your sessions/);
  assert.throws(() => enqueue(root, STANDUP_QUESTION, { continuationTaskId: '1', standupFor: { round, by: 'You' }, permissions: 'full' }), /asks one of your sessions/);
  assert.equal(enqueue(root, '/standup', { standup: true }).standup, true);
  assert.deepEqual(enqueue(root, '@everyone what blocks you?', { continuationTaskId: '4', standup: { question: 'what blocks you?' } }).standup, { question: 'what blocks you?' });
  assert.throws(() => enqueue(root, '/standup', { continuationTaskId: '4', standup: true }), /round of a Standup/);
  assert.throws(() => enqueue(root, '/standup', { standup: { question: 'x', bot: 'qa' } }), /round of a Standup/);
});

test('the answer turn is read-only: the session keeps its state, Task, vendor session and Kanban place, and its chat shows the ask', async t => {
  const f = setup(t);
  const task = await f.controller.ask('How are coupons normalized?').finished;
  const before = readTask(f.repo, task.id), place = readBoard(f.repo);
  const round = newRound();
  await f.controller.ask(STANDUP_QUESTION, task.id, { standupFor: { round, by: 'You' } }).finished;
  const after = readTask(f.repo, task.id);
  assert.equal(after.state, before.state); assert.deepEqual(after.sessions, before.sessions); assert.equal(after.standupTurn, undefined);
  assert.equal(currentTask(f.repo, task.id), null, 'no Task was proposed');
  assert.equal(after.runs.length, before.runs.length + 1); assert.equal(after.runs.at(-1).standup, round);
  assert.equal(after.title ?? null, before.title ?? null, 'the session keeps its name');
  const rows = after.messages.filter(row => row.standup === round);
  assert.deepEqual(rows.map(row => row.line ? row.text : 'update'), ['You ask: standup', 'update', 'Sent to your Standup']);
  assert.equal(rows[1].answer, true);
  assert.deepEqual(readBoard(f.repo), place);
  const turn = inputs(f.fake).at(-1);
  assert.match(turn.input, /This turn only answers\. Change nothing/);
  assert.ok(!turn.args.includes('--mcp-config') || !turn.args.join(' ').includes('kanban'), 'no Kanban tools in an answer turn');
  // Its own next turn does not see the standup as part of its work.
  await f.controller.ask('And the tests?', task.id).finished;
  assert.doesNotMatch(inputs(f.fake).at(-1).input, /You ask: standup|Sent to your Standup/);
});

test("a teammate's standup is told the owner's rules, gets the question as a teammate's text, and sends back only what passes", async t => {
  const p = project(t), fake = answeringClis(p.parent); environment(t, fake.env);
  const controller = new ProjectController(projectFolder(p.root)); controller.draftConfig.checks = []; registerProject(controller.repo);
  const task = await controller.ask('Where is billing?').finished;
  const team = 'b'.repeat(64), peer = 'c'.repeat(64); saveTeamAccess(team, { handling: 'manual', rules: 'Never share invoice totals.' });
  // The project's own random temporary folder: a path like it is cut, not held as a secret.
  fake.summary(`Fixing billing from ${path.join(p.parent, 'notes', 'billing.txt')} next.`);
  const round = newRound();
  await controller.ask(STANDUP_QUESTION, task.id, { standupFor: { round, by: '@kim', question: 'Is billing done?', peer, teams: [team] } }).finished;
  const turn = inputs(fake).at(-1).input;
  assert.match(turn, /Never share invoice totals\./); assert.match(turn, /A teammate of the owner is asking/);
  assert.match(turn, /Is billing done\?/);
  const rows = readTask(controller.repo, task.id).messages.filter(row => row.standup === round);
  assert.equal(rows[0].text, '@kim asks: Is billing done?'); assert.equal(rows.at(-1).text, 'Sent to @kim');
  assert.equal(rows[1].sent, 'Fixing billing from [path] next.');
  fake.summary(`Token is ${keyLike('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')}`);
  const second = newRound();
  await controller.ask(STANDUP_QUESTION, task.id, { standupFor: { round: second, by: '@kim', peer, teams: [team] } }).finished;
  const held = readTask(controller.repo, task.id).messages.filter(row => row.standup === second);
  assert.equal(held[1].held, true); assert.equal(held[1].sent, null); assert.equal(held.at(-1).text, 'Not sent to @kim: it may hold a secret.');
});

test('a round asks open sessions, lists a working one after the wait, leaves archived, Done and quiet ones out, and ends with one line', async t => {
  const f = setup(t);
  const a = await f.controller.ask('Explain coupons').finished, b = await f.controller.ask('Explain carts').finished;
  const c = await f.controller.ask('Explain taxes').finished, d = await f.controller.ask('Explain refunds').finished, e = await f.controller.ask('Explain fees').finished;
  saveTask(f.repo, { ...readTask(f.repo, b.id), state: 'running' });
  closeSession(f.repo, c.id); setDone(f.repo, { task: readTask(f.repo, d.id) }, true);
  const old = new Date(Date.now() - 9 * 86400000).toISOString(), quiet = readTask(f.repo, e.id);
  saveTask(f.repo, { ...quiet, createdAt: old, runs: quiet.runs.map(run => ({ ...run, at: old })), messages: quiet.messages.map(row => ({ ...row, at: old })) });
  const standup = createConversation(f.repo, f.controller.draftConfig, '/standup');
  let over = false; const loop = answering(f.controller, () => over);
  const { task, answered, listed } = await runStandupRound(f.repo, standup.id, { sources: none, times: TIMES });
  over = true; await loop;
  assert.equal(answered, 1, JSON.stringify(task.messages.slice(-4))); assert.equal(listed, 1);
  const lines = task.messages.filter(row => row.standupChat).map(row => row.text);
  assert.match(lines[0], /^Asking 2 sessions on 1 computer \(2 here\) for a standup update\./);
  const update = task.messages.find(row => row.update);
  assert.match(update.from, /^Explain coupons · .+ here$/); assert.match(update.text, /multiple agents/);
  assert.match(lines.at(-2), /Explain carts · here · working · last reply: Yes\. .+ · still working after 0 minutes$/);
  assert.equal(lines.at(-1), 'Standup done · 1 session on 1 computer · 1 not asked');
  assert.doesNotMatch(lines.join('\n'), /Explain taxes|Explain refunds|Explain fees/);
  assert.equal(task.standup.updates[0].id, 'u1'); assert.equal(task.standup.updates[0].agent, update.from.split(' · ')[1].replace(/ here$/, ''));
  assert.equal(pendingRequests(f.root).filter(row => row.standupFor && row.continuationTaskId === b.id).length, 0, 'the working one is not asked later');
  assert.equal(readTask(f.repo, a.id).state, 'answered');
});

test("every one of your sessions and your teammates' is asked, newest first; offline and older computers are listed, and an older one is never sent the question", async t => {
  const f = setup(t);
  const first = await f.controller.ask('Explain coupons').finished, model = readTask(f.repo, first.id);
  for (let n = 2; n <= 22; n++) saveTask(f.repo, { ...model, id: String(n), goal: `Session ${n}`, title: `Session ${n}`, createdAt: new Date(Date.now() - n * 60000).toISOString(), runs: model.runs.map(run => ({ ...run, at: new Date(Date.now() - n * 60000).toISOString() })), messages: [] });
  const computers = () => [
    { key: 'd'.repeat(64), name: '@devbox', online: true, standup: false, sessions: [{ here: false, where: '@devbox', key: 'd'.repeat(64), ref: '0123456789abcdef:1', title: 'Flaky test', at: Date.now(), state: 'answered', waits: null, last: '' }] },
    { key: 'e'.repeat(64), name: '@mini', online: false, standup: true, sessions: [{ here: false, where: '@mini', key: 'e'.repeat(64), ref: '0123456789abcdef:2', title: 'Docs', at: Date.now(), state: 'answered', waits: null, last: '' }] },
  ];
  const kim = 'f'.repeat(64), now = new Date().toISOString();
  const people = () => [{ peer: kim, name: 'kim', online: true, sessions: Array.from({ length: 25 }, (_, n) => ({ id: n.toString(16).padStart(16, '0'), title: `Kim ${n}`, column: 'progress', by: 'kim', at: now, standup: true })) }];
  const plan = await standupPlan({ root: f.root, id: '999' }, { sources: { computers, teammates: people } });
  assert.equal(plan.asked.filter(row => !row.team).length, 22); assert.equal(plan.asked[0].title, 'Explain coupons');
  assert.equal(plan.asked.filter(row => row.team).length, 25);
  assert.deepEqual(plan.notAsked.map(row => row.why).sort(), ['@devbox runs an older ELU', '@mini is offline'].sort());
  // A round never sends a computer whose hello lacks standup: 1 the question.
  const sent = [];
  const peer = { peerStatus: () => ({ running: true }), sendPeerCommand: body => { sent.push(body); return { id: 'x' }; }, awaitCommand: async () => ({}) };
  const standup = createConversation(f.repo, f.controller.draftConfig, '/standup');
  const stop = new AbortController(); stop.abort(new Error('Stopped by the owner.'));
  await runStandupRound(f.repo, standup.id, { signal: stop.signal, sources: { computers, teammates: () => [], peer }, times: TIMES });
  assert.deepEqual(sent.filter(body => body.type === 'remoteStandup'), []);
});

test("teammates' shared sessions are asked when online; offline and Done ones are not, and a decline is listed", async t => {
  const f = setup(t);
  const kim = 'f'.repeat(64), lee = '1'.repeat(64), now = new Date().toISOString();
  const people = () => [
    { peer: kim, name: 'kim', online: true, sessions: [{ id: '0123456789abcdef', title: 'Billing', column: 'progress', by: 'kim', at: now }, { id: '1123456789abcdef', title: 'Old work', column: 'done', by: 'kim', at: now, standup: false }] },
    { peer: lee, name: 'lee', online: false, sessions: [{ id: '2123456789abcdef', title: 'Search', column: 'needs', by: 'lee', at: now }] },
  ];
  const plan = await standupPlan({ root: f.root, id: '999' }, { sources: { computers: () => [], teammates: people } });
  assert.deepEqual(plan.asked.map(row => [row.title, row.where]), [['Billing', '@kim']]);
  assert.deepEqual(plan.notAsked.map(row => [row.title, row.why]), [['Search', '@lee is offline']]);
  const sent = [];
  const peer = { peerStatus: () => ({ running: true }), sendPeerCommand: body => { sent.push(body); return { id: String(sent.length) }; }, awaitCommand: async id => sent[Number(id) - 1].type === 'teamStandup' ? { state: 'declined', asked: [], skipped: [] } : {} };
  const standup = createConversation(f.repo, f.controller.draftConfig, '/standup');
  const { task } = await runStandupRound(f.repo, standup.id, { sources: { computers: () => [], teammates: people, peer }, times: TIMES, question: 'Is billing done?' });
  assert.deepEqual(sent[0], { type: 'teamStandup', to: kim, round: task.standup.rounds.at(-1).round, cards: ['0123456789abcdef'], question: 'Is billing done?' });
  const text = task.messages.map(row => row.text).join('\n');
  assert.match(text, /Billing · on @kim · In progress · @kim declined/); assert.match(text, /Search · on @lee · Needs you · @lee is offline/);
  assert.match(text, /Standup done · 0 sessions on 0 computers · 2 not asked/);
});

test('/standup runs a round, then one summary turn of its model with the updates and the boards; @everyone asks the same sessions again with the question', async t => {
  const f = setup(t);
  const a = await f.controller.ask('Explain coupons').finished;
  let over = false; const loop = answering(f.controller, () => over);
  const standup = await f.controller.ask('/standup', null, { standup: true }).finished;
  const summaries = standup.messages.filter(row => row.summary);
  assert.equal(summaries.length, 1);
  const turn = inputs(f.fake).at(-1).input;
  assert.match(turn, /This session is the owner's Standup/); assert.match(turn, /Give a short summary/);
  assert.match(turn, /"u1"/); assert.match(turn, /"boards"/);
  assert.match(taskTitle(readTask(f.repo, standup.id)), /^Standup /);
  assert.ok(standupReply(readTask(f.repo, a.id), standup.standup.rounds[0].round));
  // @everyone in the Standup: the same session, with the question.
  const again = await f.controller.ask('@everyone what blocks you?', standup.id, { standup: { question: 'what blocks you?' } }).finished;
  over = true; await loop;
  assert.equal(again.standup.rounds.length, 2); assert.equal(again.standup.rounds[1].question, 'what blocks you?');
  assert.ok(readTask(f.repo, a.id).messages.some(row => row.text === 'You ask: what blocks you?'));
  assert.equal(again.messages.filter(row => row.summary).length, 2, 'one summary for each round');
  // A message from the owner goes to the model with the updates.
  await f.controller.ask('Make sure the Kanban is right.', standup.id).finished;
  assert.match(inputs(f.fake).at(-1).input, /This session is the owner's Standup/);
});

test("the Standup's Kanban tools change only this computer's boards for its rounds, say where a card came from, and refuse a teammate's card", async t => {
  const f = setup(t);
  await f.controller.ask('Explain coupons').finished;
  const standup = createConversation(f.repo, f.controller.draftConfig, '/standup');
  saveTask(f.repo, { ...readTask(f.repo, standup.id), standup: { rounds: [], projects: [f.root], updates: [{ id: 'u1', session: 'Billing', agent: '@billing', computer: '@kim', at: new Date().toISOString(), text: 'Check the JWT aud claim.' }], notAsked: [], last: [], next: 2 } });
  const session = standupSession(f.root, standup.id);
  assert.ok(session); assert.equal(standupSession(f.root, '1'), null, 'an ordinary session has no Kanban tools');
  const listed = JSON.parse(kanbanTool('kanban_list', {}, session)), board = listed.boards[0].board;
  assert.equal(listed.boards.length, 1);
  assert.equal(kanbanTool('kanban_add', { board, text: 'Check JWT aud claim', from: 'u1' }, session), "Added 'Check JWT aud claim' to To do, from @billing on @kim");
  const card = readBoard(f.repo).cards.find(row => row.text === 'Check JWT aud claim');
  assert.equal(card.from, '@billing on @kim');
  assert.throws(() => kanbanTool('kanban_add', { board, text: 'x', from: 'u9' }, session), /No update of this standup has that id/);
  assert.match(kanbanTool('kanban_edit', { board, card: card.id, text: 'Check the aud claim' }, session), /^Changed 'Check JWT aud claim' to 'Check the aud claim'/);
  assert.equal(kanbanTool('kanban_move', { board, id: card.id, done: true }, session), "Moved 'Check the aud claim' to Done");
  assert.throws(() => kanbanTool('kanban_move', { board, id: 'peer-0123', done: true }, session), /teammate's card/);
  assert.throws(() => kanbanTool('kanban_list_x', { board }, session), /Unknown tool/);
  assert.throws(() => kanbanTool('kanban_add', { board: 'elsewhere', text: 'x' }, session), /not one of this standup's on this computer/);
  const other = readBoard(f.repo).cards.length, own = addCard(f.repo, 'Owner card');
  assert.throws(() => kanbanTool('kanban_remove', { board, card: own.id }, session), /Only a card this standup added/);
  assert.equal(readBoard(f.repo).cards.length, other + 1);
  // In Ask for approval each change asks the owner first, and says what it changes.
  const relay = startRelay(t, ['--session', 'standup-1', '--root', f.root, '--task', standup.id, '--role', 'lead', '--vendor', 'claude', '--log', path.join(f.parent, 'approvals.jsonl'), '--wait', '600', '--cwd', f.root, '--access', 'read', '--rules', 'saved', '--sandboxed', 'no', '--mode', 'ask']);
  relay.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok((await relay.next(row => row.id === 1)).result.tools.some(tool => tool.name === 'kanban_add'));
  relay.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: TOOL_NAME, arguments: { tool_name: 'mcp__elu-code-approval__kanban_add', input: { board, text: 'Ship it', from: 'u1' }, tool_use_id: 'toolu_2' } } });
  for (let n = 0; n < 250 && !pendingApprovals().length; n++) await sleep(20);
  const [waiting] = pendingApprovals();
  assert.match(`${waiting.summary} ${waiting.title ?? ''}`, /Kanban: add 'Ship it' to To do.*from @billing on @kim/);
  answerApproval(waiting.id, 'deny'); await relay.next(row => row.id === 2);
  assert.equal(readBoard(f.repo).cards.some(row => row.text === 'Ship it'), false);
});
function startRelay(t, argv) {
  const input = new PassThrough(), output = new PassThrough(), rows = [], waiting = [];
  let buffer = '';
  output.on('data', chunk => { buffer += chunk; let index; while ((index = buffer.indexOf('\n')) >= 0) { rows.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); waiting.splice(0).forEach(resolve => resolve()); } });
  const done = serve({ argv, input, output }); t.after(() => { input.end(); return done; });
  return { send: value => input.write(`${JSON.stringify(value)}\n`), next: async predicate => { for (;;) { const row = rows.find(predicate); if (row) return row; await new Promise(resolve => waiting.push(resolve)); } } };
}

test("a teammate's standup: manual waits for the owner and a decline is told; auto asks at once; a card not shared with them, a muted teammate and a non-teammate are refused", async t => {
  const { teamId, founder, member } = makeTeam(t);
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer' }); environment(t, { ...fake.env, XDG_CONFIG_HOME: founder.home });
  git(p.root, ['remote', 'add', 'origin', 'https://github.com/example/shop.git']);
  const controller = new ProjectController(projectFolder(p.root)); controller.draftConfig.checks = []; registerProject(controller.repo);
  const task = await controller.ask('Explain coupons').finished;
  const repos = localRepos(), [row] = repos.values(); assert.ok(row, 'the project is a repository this machine has');
  saveProofs(member.identity.key, [repoProof(member.identity.key, founder.identity.key, row.repoId, row.commit)]);
  const card = sessionCards({ owner: 'ana', repos }).find(value => value.taskId === task.id).card.id;
  let kicks = 0; const ctx = { me: founder.identity, repos: () => repos, kick: () => kicks++, event: () => {} };
  // A card they were never told is not asked.
  const unknown = teamStandupAsk(ctx, member.identity.key, { round: newRound(), cards: ['abcdefabcdefabcd'] });
  assert.deepEqual(unknown.skipped, [{ card: 'abcdefabcdefabcd', why: 'not shared with you' }]);
  // Manual (no setting yet): one item waits for the owner; n declines, and the asker reads that.
  const round = newRound(), waiting = teamStandupAsk(ctx, member.identity.key, { round, cards: [card] });
  assert.equal(waiting.state, 'waiting'); assert.equal(kicks, 0);
  const [item] = waitingStandups(); assert.equal(item.name, 'sara'); assert.equal(item.sessions, 1);
  declineStandup(item.id);
  assert.equal(teamStandupRead(member.identity.key, { round }).state, 'declined');
  assert.equal(pendingRequests(p.root).filter(value => value.standupFor).length, 0);
  // Auto: asked at once, as sara, with the team for its rules; asked again it is answered as before.
  saveTeamAccess(teamId, { handling: 'auto' });
  const auto = newRound(), asked = teamStandupAsk(ctx, member.identity.key, { round: auto, cards: [card] });
  assert.equal(asked.state, 'asked'); assert.equal(kicks, 1);
  const [request] = pendingRequests(p.root).filter(value => value.standupFor?.round === auto);
  assert.deepEqual(request.standupFor, { round: auto, by: '@sara', question: null, peer: member.identity.key, teams: [teamId] });
  teamStandupAsk(ctx, member.identity.key, { round: auto, cards: [card] });
  assert.equal(pendingRequests(p.root).filter(value => value.standupFor?.round === auto).length, 1, 'one answer turn a round');
  await controller.ask(request.goal, task.id, { standupFor: request.standupFor }).finished;
  const read = teamStandupRead(member.identity.key, { round: auto });
  assert.equal(read.answers.length, 1); assert.match(read.answers[0].text, /multiple agents/); assert.equal(read.answers[0].card, card);
  assert.deepEqual(Object.keys(read.answers[0]).sort(), ['card', 'text', 'title', 'who']);
  // Muted: declined. Not a teammate: refused.
  savePeerPolicy(member.identity.key, { muted: true });
  assert.equal(teamStandupAsk(ctx, member.identity.key, { round: newRound(), cards: [card] }).state, 'declined');
  assert.throws(() => teamStandupAsk(ctx, '9'.repeat(64), { round: newRound(), cards: [card] }), /not shared with you/);
  await assert.rejects(teamStandupCommand(ctx, { type: 'teamStandup', to: '9'.repeat(64), round: newRound() }), /Choose a teammate/);
  // A teammate whose hello lacks standup: 1 is never sent it.
  const requests = [];
  const older = await teamStandupCommand({ ...ctx, session: () => ({ remoteHello: { cards: 1 }, request: async (...args) => { requests.push(args); return {}; } }) }, { type: 'teamStandup', to: member.identity.key, round: newRound(), cards: [card] });
  assert.deepEqual(older, { older: true }); assert.deepEqual(requests, []);
  assert.deepEqual(await teamStandupCommand({ ...ctx, session: () => null }, { type: 'teamStandupRead', to: member.identity.key, round: newRound() }), { offline: true });
});

test('another computer of mine whose hello lacks standup: 1 is never sent the question', async () => {
  const requests = [], key = 'a'.repeat(64);
  const ctx = { session: () => ({ remoteHello: { remote: 1 }, request: async (...args) => { requests.push(args); return {}; } }) };
  assert.deepEqual(await remoteCommand(ctx, { type: 'remoteStandup', to: key, round: newRound(), refs: [] }), { older: true });
  assert.deepEqual(await remoteCommand({ session: () => null }, { type: 'remoteStandupRead', to: key, round: newRound() }), { offline: true });
  assert.deepEqual(requests, []);
});

test('another computer of mine is sent every session of the round to ask', async t => {
  const { founder, member } = makeTeam(t), key = member.identity.key, sent = [];
  const ctx = { me: founder.identity, session: () => ({ remoteHello: { remote: 1, standup: 1 }, request: async (method, params) => { sent.push([method, params]); return { asked: [], skipped: [] }; } }) };
  const refs = Array.from({ length: 25 }, (_, n) => `0123456789abcdef:${n + 1}`);
  await withHome(founder.home, async () => { markMine(founder.identity.key, key); noteTheirs(key, true); await remoteCommand(ctx, { type: 'remoteStandup', to: key, round: newRound(), refs }); });
  assert.deepEqual(sent.map(([method, params]) => [method, params.refs.length]), [['elu.remote.standup', 25]]);
});
