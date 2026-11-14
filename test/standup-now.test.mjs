import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { project, fakeClis } from './helpers.mjs';
import { ProjectController, registerProject } from '../lib/projects.mjs';
import { projectFolder, pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { readTask, saveTask, taskDir, tasks } from '../lib/state.mjs';
import { Conductor, enqueue, saveConductorSettings, stopStandupAnswer } from '../lib/conductor.mjs';
import { planFile } from '../lib/plan.mjs';
import { createConversation } from '../lib/runner.mjs';
import { STANDUP_QUESTION, foldStandup, newRound, sideAnswer, standupHas, standupLeftOut, standupReply, standupWaitLine } from '../lib/standup.mjs';
import { cleanRecord, listedRecord, localRecord, recordLines, sessionRecord, span } from '../lib/standup-record.mjs';
import { headLine, runStandupRound } from '../lib/standup-round.mjs';

// /standup answers within seconds (README, "Standup"): one block for every session at once,
// from what ELU has on record and with no model run; each model update added to its block
// when it arrives; a session in the middle of a turn answers beside that turn, with every
// slot taken, here and on another computer; the first line says what is in and what is
// missing, with why; /stop takes every question back; and the summaries never claim an
// update that is not there.

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
async function until(check, message, timeout = 20000) {
  const started = Date.now();
  for (;;) { const value = await check(); if (value) return value; if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await sleep(20); }
}
// The conductor's part in a round, without one: every standup question is started as soon as
// go() says so, whatever its session is doing. A session in a turn answers beside it.
function answering(t, controller, done, go = () => true) {
  const handled = new Set(); let ended = false; t.after(() => { ended = true; });
  return (async () => {
    while (!done() && !ended) {
      for (const row of go() ? pendingRequests(controller.repo.root).filter(value => value.standupFor && value.state === 'queued' && !handled.has(value.id)) : []) {
        handled.add(row.id); updateRequest(controller.repo.root, row.id, { state: 'running' });
        await controller.ask(row.goal, row.continuationTaskId, { standupFor: row.standupFor }).finished;
        updateRequest(controller.repo.root, row.id, { state: 'done', reason: 'Finished.' });
      }
      await sleep(20);
    }
  })();
}
const TIMES = { pollMs: 20, remoteMs: 20, waitMs: 60000, capMs: 30000, recordsMs: 50 };
const none = { computers: () => [], teammates: () => [], peer: null };
// A session in the middle of a turn, as its record and its live log say: it began `since`,
// wrote one line, changed a file, and runs a command that has not ended.
function midTurn(repo, id, { since = Date.now() - 100 * 60000, wrote = Date.now() - 20000 } = {}) {
  const task = readTask(repo, id), file = path.join(taskDir(repo, id), 'lead-live.log');
  const rows = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Starting the watcher, then the tests.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: path.join(task.worktree, 'src/coupon.mjs'), old_string: 'value', new_string: 'value.trim()' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_test', name: 'Bash', input: { command: 'npm test' } }] } },
  ];
  fs.writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`); fs.utimesSync(file, wrote / 1000, wrote / 1000);
  saveTask(repo, { ...task, state: 'running', activeRole: 'lead', activeLog: file, activeSince: new Date(since).toISOString() });
  return file;
}
const planned = (repo, id) => fs.writeFileSync(planFile(repo, id), JSON.stringify({ tasks: [{ id: 't1', session: id, revision: 1, title: 'Uppercase the coupon codes', state: 'approved', objectives: [], met: [], subtasks: [{ text: 'Change normalize', state: 'done' }, { text: 'Run the coupon test', state: 'doing' }, { text: 'Update the notes', state: 'todo' }] }] }));
const blocks = task => (task.messages ?? []).filter(row => row.update && !/^First summary/.test(row.from));

test('what is on record for a session, read with no model run: its state, its Task and subtasks, the last things its turn said and did, its branch or pull request, and when it last wrote', async t => {
  const f = setup(t);
  const a = await f.controller.ask('Explain coupons').finished, b = await f.controller.ask('Explain carts').finished, now = Date.now();
  // In no turn: finished, with its last reply and its model.
  const idle = localRecord(f.repo, readTask(f.repo, a.id), { now });
  assert.equal(idle.state, 'finished'); assert.ok(idle.said.length > 0); assert.ok(idle.who.length > 0); assert.ok(Date.parse(idle.at) <= now);
  assert.match(recordLines(idle, now)[0], /^Finished · last wrote \d+ s ago$/); assert.match(recordLines(idle, now)[1], /^Last said: /);
  // In a turn that began 100 minutes ago: for how long, its Task, and the newest of its live activity.
  midTurn(f.repo, b.id, { since: now - 100 * 60000, wrote: now - 20000 }); planned(f.repo, b.id);
  const before = inputs(f.fake).length;
  const record = localRecord(f.repo, readTask(f.repo, b.id), { now });
  assert.equal(inputs(f.fake).length, before, 'no model ran for it');
  assert.equal(record.state, 'working'); assert.equal(record.since, new Date(now - 100 * 60000).toISOString());
  assert.deepEqual(record.task, { title: 'Uppercase the coupon codes', state: 'approved', done: 1, of: 3, now: 'Run the coupon test' });
  assert.equal(record.said, 'Starting the watcher, then the tests.'); assert.equal(record.command, 'npm test'); assert.equal(record.file, 'src/coupon.mjs');
  assert.deepEqual(recordLines(record, now), ['Working for 1 h 40 min · last wrote 20 s ago', 'Task: Uppercase the coupon codes · 1 of 3 subtasks done · now: Run the coupon test', 'Last said: Starting the watcher, then the tests.', 'Last command: npm test', 'Last file: src/coupon.mjs']);
  // Waiting for him: its question first. Blocked: why. A pull request or a branch it made.
  const base = { id: '9', createdAt: new Date(now - 3600000).toISOString(), runs: [{ role: 'lead', at: new Date(now - 600000).toISOString() }], messages: [] };
  const waiting = sessionRecord(f.repo, { ...base, state: 'needs_input', reply: { outcome: 'needs_input', question: 'Which format?' } }, { now, plan: null });
  assert.equal(waiting.state, 'waiting'); assert.equal(recordLines(waiting, now)[0], 'Waiting for you: Which format? · last wrote 10 min ago');
  const blocked = sessionRecord(f.repo, { ...base, state: 'blocked', error: { message: 'Claude Code is not signed in.' }, branch: 'feat/task-9' }, { now, plan: null });
  assert.deepEqual(recordLines(blocked, now), ['Blocked: Claude Code is not signed in. · last wrote 10 min ago', 'Branch: feat/task-9']);
  const published = sessionRecord(f.repo, { ...base, state: 'ready', branch: 'feat/task-9', pr: 'https://example.invalid/acme/shop/pull/12' }, { now, plan: null });
  assert.deepEqual(recordLines(published, now), ['Finished · ready to publish · last wrote 10 min ago', 'Pull request: https://example.invalid/acme/shop/pull/12']);
  // What another computer sends is kept as a record and nothing else.
  assert.deepEqual(cleanRecord({ state: 'working', since: record.since, command: 'npm\u001b[31m test', extra: 'x', task: { title: 'T', state: 'approved', done: 1, of: 2 } }), { state: 'working', command: 'npm test', since: record.since, task: { title: 'T', state: 'approved', done: 1, of: 2 } });
  assert.equal(cleanRecord({ state: 'nope' }), null); assert.equal(cleanRecord('working'), null);
  assert.deepEqual(listedRecord({ state: 'running', waits: null, at: now }), { state: 'working', at: new Date(now).toISOString() });
  assert.deepEqual([span(45000), span(12 * 60000), span(100 * 60000), span(2 * 3600000), span(72 * 3600000)], ['45 s', '12 min', '1 h 40 min', '2 h', '3 d']);
});

test('not asked at all: a helper copy of a session on another computer, a Standup, a session no agent ran in, an archived one', () => {
  const now = Date.parse('2026-11-13T12:00:00Z'), at = ms => new Date(ms).toISOString(), board = { cards: [], done: ['4'], archived: ['4'], closed: { 4: at(now - 3600000) } };
  const task = (id, fields = {}) => ({ id, createdAt: at(now - 86400000), state: 'answered', runs: [{ role: 'lead', at: at(now - 7200000) }], messages: [], ...fields });
  assert.equal(standupLeftOut(board, task('1'), { now }), null);
  assert.equal(standupLeftOut(board, task('2', { helps: { machine: 'a'.repeat(64), remoteId: 'r1', name: 'devbox', title: 'Roll out' } }), { now }), 'helper');
  assert.equal(standupLeftOut(board, task('2', { state: 'running', helps: { machine: 'a'.repeat(64), remoteId: 'r1', name: 'devbox', title: 'Roll out' } }), { now }), 'helper', 'also while it works');
  assert.equal(standupLeftOut(board, task('3', { standup: { rounds: [] } }), { now }), 'standup');
  assert.equal(standupLeftOut(board, task('4'), { now }), 'archived');
  assert.equal(standupLeftOut(board, task('5', { runs: [] }), { now }), 'no agent');
});

test('a round shows one block for every session at once, the one that waits for you first, and adds each model update to its block; a session in a turn answers beside it and its turn goes on', async t => {
  const f = setup(t);
  const a = await f.controller.ask('Explain coupons').finished, b = await f.controller.ask('Explain carts').finished, c = await f.controller.ask('Explain taxes').finished;
  // The session that works was moved to a model of its own.
  f.controller.setModel(b.id, { vendor: 'claude', model: 'sonnet' });
  midTurn(f.repo, b.id); planned(f.repo, b.id);
  saveTask(f.repo, { ...readTask(f.repo, c.id), state: 'needs_input', reply: { outcome: 'needs_input', summary: 'Two ways to go.', question: 'Which tax table?' } });
  const working = readTask(f.repo, b.id), standup = createConversation(f.repo, f.controller.draftConfig, '/standup');
  let over = false, go = false; const loop = answering(t, f.controller, () => over, () => go), ran = inputs(f.fake).length;
  const started = Date.now(), round = runStandupRound(f.repo, standup.id, { sources: none, times: TIMES });
  // Within two seconds, and before any model has run: a block for each, from its record.
  const first = await until(() => { const task = readTask(f.repo, standup.id); return blocks(task).length === 3 && blocks(task).every(row => row.text) ? task : null; }, 'the three blocks');
  assert.ok(Date.now() - started < 2000, `the blocks took ${Date.now() - started} ms`);
  assert.equal(inputs(f.fake).length, ran, 'no model had run when the blocks were shown');
  const shown = blocks(first);
  assert.match(shown[0].from, /^Explain taxes · .+ here$/); assert.match(shown[1].from, /^Explain carts · .+ here$/); assert.match(shown[2].from, /^Explain coupons · .+ here$/);
  assert.match(shown[0].text, /^Waiting for you: Which tax table\? · last wrote /, 'its question first');
  assert.match(shown[1].text, /^Working for 1 h 40 min · last wrote \d+ s ago\nTask: Uppercase the coupon codes · 1 of 3 subtasks done · now: Run the coupon test\nLast said: Starting the watcher, then the tests\.\nLast command: npm test\nLast file: src\/coupon\.mjs\n\nModel update: waiting to start…$/);
  assert.match(shown[2].text, /^Finished · last wrote .+\nLast said: .+\n\nModel update: waiting to start…$/s);
  assert.equal(first.messages.find(row => row.standupChat && row.line).text, '3 sessions on 1 computer (3 here). 3 answered from records at once. Model updates: 0 written, 3 being written. /stop stops waiting.');
  assert.equal(standupWaitLine(first), '3 model updates still being written'); assert.equal(standupHas(first), 'it has 0 of 3 model updates');
  // Each model update is added to its block when it arrives.
  go = true;
  const { task, answered, shown: count } = await round; over = true; await loop;
  assert.equal(answered, 3); assert.equal(count, 3);
  for (const row of blocks(task)) assert.match(row.text, /\n\n(?!Model update:|No model update:)\S/, `the update is in the block: ${row.text}`);
  assert.match(blocks(task)[1].text, /^Working for 1 h 40 min/, 'what was on record stays above it');
  const lines = task.messages.filter(row => row.standupChat && row.line).map(row => row.text);
  assert.equal(lines[0], '3 sessions on 1 computer (3 here). 3 answered from records at once. Model updates: 3 written.');
  assert.equal(lines.at(-1), 'Standup done · 3 sessions on 1 computer · 3 model updates · 0 not asked');
  assert.equal(standupHas(task), 'it has every update');
  assert.deepEqual(task.standup.updates.map(row => [row.session, row.record.state, Boolean(row.text)]), [['Explain taxes', 'waiting', true], ['Explain carts', 'working', true], ['Explain coupons', 'finished', true]]);
  // The session in a turn was never touched: it answered in a run beside its turn, told what that turn did.
  const still = readTask(f.repo, b.id), code = task.standup.rounds.at(-1).round;
  assert.equal(still.state, 'running'); assert.deepEqual(still.messages, working.messages); assert.equal(still.runs.length, working.runs.length); assert.deepEqual(still.sessions, working.sessions);
  const beside = sideAnswer(f.repo, b.id, code);
  assert.equal(beside.beside, true); assert.equal(beside.answer, true); assert.equal(beside.runs.length, 1);
  const turn = inputs(f.fake).find(row => /in the middle of a turn right now/.test(row.input));
  assert.ok(turn, 'the run beside the turn is told so'); assert.match(turn.input, /Run: npm test/); assert.match(turn.input, /This turn only answers\. Change nothing/);
  assert.ok(!turn.args.includes('--resume'), 'it never resumes the vendor session the turn works in');
  assert.equal(turn.args[turn.args.indexOf('--model') + 1], 'sonnet', "it is written by the session's own model");
  // When its turn ends, its chat takes the answer, once.
  saveTask(f.repo, { ...still, state: 'answered', activeRole: null, activeLog: null });
  assert.equal(foldStandup(f.repo, b.id), 1); assert.equal(foldStandup(f.repo, b.id), 0);
  const after = readTask(f.repo, b.id);
  assert.deepEqual(after.messages.filter(row => row.standup === code).map(row => row.line ? row.text : 'update'), ['You ask: standup', 'update', 'Sent to your Standup']);
  assert.equal(after.runs.length, working.runs.length + 1); assert.equal(after.runs.at(-1).standup, code);
  assert.equal(standupReply(after, code).text, beside.text);
});

test('the first line and each block say what is missing and why; a session whose run cannot answer keeps its record', async t => {
  const f = setup(t);
  const a = await f.controller.ask('Explain coupons').finished, b = await f.controller.ask('Explain carts').finished;
  const standup = createConversation(f.repo, f.controller.draftConfig, '/standup');
  // The question of one of them is never started: after the wait it is taken back and named.
  let over = false; const only = String(a.id); t.after(() => { over = true; });
  const loop = (async () => { const handled = new Set(); while (!over) { for (const row of pendingRequests(f.root).filter(value => value.standupFor && value.state === 'queued' && value.continuationTaskId === only && !handled.has(value.id))) { handled.add(row.id); updateRequest(f.root, row.id, { state: 'running' }); await f.controller.ask(row.goal, row.continuationTaskId, { standupFor: row.standupFor }).finished; updateRequest(f.root, row.id, { state: 'done', reason: 'Finished.' }); } await sleep(20); } })();
  const { task, answered } = await runStandupRound(f.repo, standup.id, { sources: none, times: { ...TIMES, waitMs: 400 } }); over = true; await loop;
  assert.equal(answered, 1);
  const missing = blocks(task).find(row => /^Explain carts/.test(row.from));
  assert.match(missing.text, /^Finished · last wrote .+\n\nNo model update: it did not start in 0 minutes$/s);
  const head = task.messages.find(row => row.standupChat && row.line).text;
  assert.equal(head, '2 sessions on 1 computer (2 here). 2 answered from records at once. Model updates: 1 written, 1 missing. Missing: Explain carts here (it did not start in 0 minutes).');
  assert.equal(task.messages.at(-1).text, 'Standup done · 2 sessions on 1 computer · 1 model update · 1 missing · 0 not asked');
  assert.equal(pendingRequests(f.root).filter(row => row.standupFor && row.state === 'queued').length, 0, 'its question was taken back');
  assert.equal(standupHas(task), 'it has 1 of 2 model updates');
  const kept = task.standup.updates.find(row => row.session === 'Explain carts');
  assert.equal(kept.missing, 'it did not start in 0 minutes'); assert.equal(kept.record.state, 'finished');
  assert.equal(b.id, readTask(f.repo, b.id).id);
  assert.equal(headLine([]), 'No session is open to ask: none of yours works, waits for you, or was active in the last 7 days, and no teammate\'s shared session is online.');
});

test('/stop takes back every question still out, here and on the other computer, so none runs later in a session', async t => {
  const f = setup(t), devbox = 'd'.repeat(64);
  await f.controller.ask('Explain coupons').finished;
  const standup = createConversation(f.repo, f.controller.draftConfig, '/standup'), sent = [];
  const computers = () => [{ key: devbox, name: '@devbox', online: true, standup: true, sessions: [{ here: false, where: '@devbox', key: devbox, ref: '0123456789abcdef:1', title: 'Rollout', at: Date.now(), state: 'running', waits: null, last: '', record: listedRecord({ state: 'running', at: Date.now() }), listed: true }] }];
  const peer = { peerStatus: () => ({ running: true }), sendPeerCommand: body => { sent.push(body); return { id: String(sent.length) }; },
    awaitCommand: async id => { const body = sent[Number(id) - 1]; return body.type === 'remoteStandup' ? { asked: [{ ref: '0123456789abcdef:1', title: 'Rollout' }], skipped: [], records: [{ ref: '0123456789abcdef:1', record: { state: 'working', since: new Date(Date.now() - 100 * 60000).toISOString(), command: 'npm test', who: 'Opus 5.5' } }] } : body.type === 'remoteStandupRead' ? { answers: [], pending: [{ ref: '0123456789abcdef:1', working: true, queued: false, why: 'writing' }] } : { stopped: 1 }; } };
  const stop = new AbortController();
  const round = runStandupRound(f.repo, standup.id, { signal: stop.signal, sources: { computers, teammates: () => [], peer }, times: TIMES });
  await until(() => { const task = readTask(f.repo, standup.id); return blocks(task).some(row => /Last command: npm test/.test(row.text)) ? task : null; }, 'the record of the other computer');
  assert.equal(pendingRequests(f.root).filter(row => row.standupFor).length, 1);
  stop.abort(new Error('Stopped by the owner.'));
  const { task, answered } = await round;
  assert.equal(answered, 0);
  assert.equal(pendingRequests(f.root).filter(row => row.standupFor).length, 0, 'the question here was taken back');
  const stops = sent.filter(body => body.type === 'remoteStandupStop');
  assert.deepEqual(stops, [{ type: 'remoteStandupStop', to: devbox, round: task.standup.rounds.at(-1).round }], 'and every one on the other computer');
  const head = task.messages.find(row => row.standupChat && row.line).text;
  assert.match(head, /^2 sessions on 2 computers \(1 on @devbox, 1 here\)\. 2 answered from records at once\. Model updates: 0 written, 2 missing\. Missing: Rollout on @devbox \(you stopped the standup before it was written\); Explain coupons here \(you stopped the standup before it was written\)\.$/);
  assert.equal(task.messages.at(-1).text, 'Standup stopped · 2 sessions on 2 computers · 0 model updates · 2 missing · 0 not asked');
  assert.match(blocks(task)[0].from, /^Rollout · Opus 5\.5 on @devbox$/);
});

test('another computer whose ELU sends no record is named as such, and one whose conductor answers only after the turn says so', async t => {
  const f = setup(t), devbox = 'd'.repeat(64), ref = '0123456789abcdef:1', sent = [];
  const standup = createConversation(f.repo, f.controller.draftConfig, '/standup');
  const computers = () => [{ key: devbox, name: '@devbox', online: true, standup: true, sessions: [{ here: false, where: '@devbox', key: devbox, ref, title: 'Rollout', at: Date.now() - 60000, state: 'running', waits: null, last: '', record: listedRecord({ state: 'running', at: Date.now() - 60000 }), listed: true }] }];
  let reads = 0;
  const peer = { peerStatus: () => ({ running: true }), sendPeerCommand: body => { sent.push(body); return { id: String(sent.length) }; },
    awaitCommand: async id => { const body = sent[Number(id) - 1]; return body.type === 'remoteStandup' ? { asked: [{ ref, title: 'Rollout' }], skipped: [] } : body.type === 'remoteStandupRead' ? ++reads < 4 ? { answers: [], pending: [{ ref, working: true, queued: true }] } : { answers: [{ ref, title: 'Rollout', who: 'Opus 5.5', text: 'Working on: the rollout.' }], pending: [] } : {}; } };
  const seen = [];
  const watch = setInterval(() => { try { const row = blocks(readTask(f.repo, standup.id))[0]; if (row && !seen.includes(row.text)) seen.push(row.text); } catch { /* Not saved yet. */ } }, 5);
  const { task } = await runStandupRound(f.repo, standup.id, { sources: { computers, teammates: () => [], peer }, times: { ...TIMES, pollMs: 40, remoteMs: 40 } });
  clearInterval(watch);
  assert.ok(seen.some(text => /^Working · last wrote 1 min ago\n@devbox runs an older ELU that sends no record: this is what this computer last listed for it\.\n\nModel update: it comes when its turn ends \(the ELU that runs it is from before this update\)…$/.test(text)), seen.join('\n---\n'));
  assert.match(blocks(task)[0].text, /this is what this computer last listed for it\.\n\nWorking on: the rollout\.$/);
  assert.match(task.messages.find(row => row.standupChat && row.line).text, /^1 session on 1 computer \(1 on @devbox\)\. 0 answered from records at once; 1 shown as this computer last listed it\. Model updates: 1 written\.$/);
});

test('the first summary is written from the records while the model updates are still being written, and never says it has every update', async t => {
  const f = setup(t);
  await f.controller.ask('Explain coupons').finished; const b = await f.controller.ask('Explain carts').finished;
  midTurn(f.repo, b.id);
  const standup = createConversation(f.repo, f.controller.draftConfig, '/standup');
  let over = false, go = false, told = null; const loop = answering(t, f.controller, () => over, () => go);
  const first = async value => { told = value; return { text: 'From the records alone: Explain carts works on the tests; 2 model updates are still being written.', who: 'Opus 5.5', runs: [{ role: 'lead', vendor: 'claude', at: new Date().toISOString(), costUsd: 0.01 }] }; };
  const round = runStandupRound(f.repo, standup.id, { sources: none, times: TIMES, first });
  const early = await until(() => { const task = readTask(f.repo, standup.id); return task.messages?.some(row => /^First summary/.test(row.from ?? '')) ? task : null; }, 'the first summary');
  assert.equal(blocks(early).filter(row => /Model update: waiting to start…$/.test(row.text)).length, 2, 'no model update was in yet');
  assert.equal(told.writing, 2); assert.deepEqual(told.records.map(row => [row.session, row.record.state]), [['Explain carts', 'working'], ['Explain coupons', 'finished']]);
  assert.equal(told.records[0].record.command, 'npm test');
  const row = early.messages.find(value => /^First summary/.test(value.from ?? ''));
  assert.equal(row.from, 'First summary · from the records · Opus 5.5'); assert.match(row.text, /2 model updates are still being written/);
  go = true; const { task } = await round; over = true; await loop;
  assert.equal(task.runs.filter(run => run.standup === task.standup.rounds.at(-1).round).length, 1, 'what it spent is counted with the Standup');
  // The real one, on the Standup's own model: told the records, and that updates are still to come.
  let done = false; const again = answering(t, f.controller, () => done);
  const session = await f.controller.ask('/standup', null, { standup: true }).finished; done = true; await again;
  const summaries = inputs(f.fake).filter(value => /This run writes the first summary of the owner's standup/.test(value.input));
  assert.equal(summaries.length, 1);
  assert.match(summaries[0].input, /from the records alone and that 2 model updates are still being written\. Never say you have every update\./);
  assert.match(summaries[0].input, /"command":"npm test"/); assert.match(summaries[0].input, /"sessions"/);
  assert.ok(!summaries[0].args.includes('--resume'));
  // The summary of the round comes once the updates are in, and reads the records too.
  assert.equal(session.messages.filter(value => value.summary).length, 1);
  const last = inputs(f.fake).at(-1).input;
  assert.match(last, /Give a short summary: first what waits for the owner/); assert.match(last, /"record"/); assert.match(last, /never say you have every update while one is missing/);
  assert.equal(readTask(f.repo, b.id).state, 'running');
});

function conduct(t, options = {}) { const conductor = new Conductor({ tickMs: 20, ...options }).start(); t.after(() => conductor.stop()); return conductor; }
// The stand-in Claude Code's turn in Full access never ends until the gate file is there
// (mode live); every other turn of it, a standup's answer too, answers at once.
// answer: how its read-only runs behave instead (a standup's answer run asks for no permission: dontAsk).
const neverEnding = (gate, answer = null) => ({ mode: 'answer', byMode: { bypassPermissions: { mode: 'live', gate, live: { seconds: 0, think: 40 } }, ...(answer ? { dontAsk: answer } : {}) } });

test('with every slot taken by a turn that never ends, a standup question starts at once beside that turn; the turn goes on, and its chat takes the answer when it ends', async t => {
  const gate = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'standup-gate-')), 'go'); t.after(() => fs.rmSync(path.dirname(gate), { recursive: true, force: true }));
  const f = setup(t, neverEnding(gate));
  saveConductorSettings({ maxAgents: 1 });
  conduct(t);
  enqueue(f.root, 'Uppercase the coupon codes', { permissions: 'full' });
  const session = await until(() => tasks(f.repo).find(task => task.state === 'running' && task.activeLog && fs.existsSync(task.activeLog) && /npm test/.test(fs.readFileSync(task.activeLog, 'utf8'))), 'the turn that never ends');
  // Every slot is taken: other work waits.
  const other = enqueue(f.root, 'Explain carts');
  const round = newRound(), asked = enqueue(f.root, STANDUP_QUESTION, { continuationTaskId: session.id, priority: 1, standupFor: { round, by: 'You' } });
  const started = Date.now();
  const answer = await until(() => sideAnswer(f.repo, session.id, round), 'the answer beside the turn');
  assert.ok(Date.now() - started < 15000);
  assert.equal(answer.answer, true); assert.equal(answer.beside, true);
  const now = readTask(f.repo, session.id);
  assert.equal(now.state, 'running', 'the turn goes on'); assert.equal(now.standupTurn, undefined); assert.equal(now.activeLog, session.activeLog);
  assert.equal(now.messages.filter(row => row.standup).length, 0, 'nothing was written into the record the turn holds');
  await until(() => pendingRequests(f.root).find(row => row.id === asked.id)?.state === 'done', 'its request to end');
  assert.equal(pendingRequests(f.root).find(row => row.id === other.id).state, 'queued', 'the slot is still taken');
  const turn = inputs(f.fake).find(row => /in the middle of a turn right now/.test(row.input));
  assert.match(turn.input, /Run: npm test/);
  // A second standup beside the same turn, stopped while its run goes: only that run stops.
  const second = newRound(), again = enqueue(f.root, STANDUP_QUESTION, { continuationTaskId: session.id, priority: 1, standupFor: { round: second, by: 'You' } });
  await until(() => ['running', 'done'].includes(pendingRequests(f.root).find(row => row.id === again.id)?.state), 'the second question to start');
  stopStandupAnswer(f.root, again.id);
  await until(() => pendingRequests(f.root).find(row => row.id === again.id)?.state === 'done', 'the second question to end');
  assert.equal(readTask(f.repo, session.id).state, 'running', 'a stop of a standup answer never stops the turn');
  // The turn ends: its chat takes each answer once, and the work that waited starts.
  fs.writeFileSync(gate, '');
  const ended = await until(() => { const task = readTask(f.repo, session.id); return task.messages.some(row => row.standup === round && row.answer) ? task : null; }, 'the answer in its chat');
  assert.deepEqual(ended.messages.filter(row => row.standup === round).map(row => row.line ? row.text : 'update'), ['You ask: standup', 'update', 'Sent to your Standup']);
  assert.equal(ended.runs.filter(run => run.standup === round).length, 1);
  await until(() => pendingRequests(f.root).find(row => row.id === other.id)?.state !== 'queued', 'the other work to start');
});

// Another computer of the owner's, in a process of its own (test/standup-host.mjs).
async function otherComputer(t, { asker, slots = 1, answer = null } = {}) {
  const p = project(t), gate = path.join(p.parent, 'go'), fake = fakeClis(p.parent, neverEnding(gate, answer));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./standup-host.mjs', import.meta.url)), JSON.stringify({ root: p.root, asker, slots })], { env: { ...process.env, ...fake.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => { child.stdin.end(); child.kill('SIGTERM'); });
  const waiting = new Map(), lines = readline.createInterface({ input: child.stdout });
  let ready; const started = new Promise(resolve => { ready = resolve; });
  lines.on('line', line => { let row; try { row = JSON.parse(line); } catch { return; } if (row.ready) return ready(); const take = waiting.get(row.id); if (take) { waiting.delete(row.id); if (row.ok) take.resolve(row.result); else take.reject(new Error(row.error)); } });
  await started;
  let next = 0;
  const request = (type, params = {}) => new Promise((resolve, reject) => { const id = ++next; waiting.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({ id, type, params })}\n`); });
  return { request, gate, fake, root: p.root };
}

test('two computers: a session there in a turn that never ends, every slot there taken; the standup shows its block within two seconds and its model update without the turn ending', async t => {
  const f = setup(t), devbox = 'd'.repeat(64), me = 'a'.repeat(64);
  const there = await otherComputer(t, { asker: me, slots: 1 });
  await there.request('start', { goal: 'Uppercase the coupon codes', permissions: 'full' });
  const session = await until(async () => (await there.request('sessions')).find(row => row.state === 'running' && /npm test/.test(row.log)), 'the turn that never ends there', 30000);
  const waits = await there.request('start', { goal: 'Explain carts' });
  const ref = `${await there.request('key')}:${session.id}`;
  // What this computer last listed of it, as its Sessions show it; the link carries the rest.
  const computers = () => [{ key: devbox, name: '@devbox', online: true, standup: true, sessions: [{ here: false, where: '@devbox', key: devbox, ref, title: 'Uppercase the coupon codes', at: Date.now(), state: 'running', waits: null, last: '', record: listedRecord({ state: 'running', at: Date.now() }), listed: true }] }];
  const sent = [], replies = [];
  const peer = { peerStatus: () => ({ running: true }), sendPeerCommand: body => { sent.push(body); replies.push(there.request(body.type, { round: body.round, ...(body.refs ? { refs: body.refs } : {}), ...(body.question ? { question: body.question } : {}) })); return { id: String(sent.length) }; }, awaitCommand: id => replies[Number(id) - 1] };
  const standup = createConversation(f.repo, f.controller.draftConfig, '/standup');
  const started = Date.now(), round = runStandupRound(f.repo, standup.id, { sources: { computers, teammates: () => [], peer }, times: { ...TIMES, pollMs: 50, remoteMs: 100 } });
  // Its block, from that computer's own record, with no model run there for it.
  const early = await until(() => { const task = readTask(f.repo, standup.id); return blocks(task).some(row => /Last command: npm test/.test(row.text)) ? task : null; }, 'the block from its record');
  assert.ok(Date.now() - started < 2000, `the block took ${Date.now() - started} ms`);
  assert.match(blocks(early)[0].text, /^Working for \d+ s · last wrote \d+ s ago\nLast said: Starting the watcher, then the tests\.\nLast command: npm test\n\nModel update: (being written|waiting to start)…$/);
  assert.match(early.messages.find(row => row.standupChat && row.line).text, /^1 session on 1 computer \(1 on @devbox\)\. 1 answered from its record at once\. Model updates: 0 written, 1 being written\. \/stop stops waiting\.$/);
  // Its model update, while its turn still runs and its only slot is taken.
  const { task, answered } = await round;
  assert.equal(answered, 1);
  assert.match(blocks(task)[0].text, /Last command: npm test\n\n(?!Model update:|No model update:)\S/);
  assert.match(blocks(task)[0].from, /^Uppercase the coupon codes · .+ on @devbox$/);
  const after = await there.request('session', { id: session.id });
  assert.equal(after.state, 'running', 'its turn has not ended'); assert.equal(after.standupTurn, null); assert.equal(after.messages.filter(row => row.standup).length, 0);
  const requests = await there.request('requests');
  assert.equal(requests.find(row => row.id === waits).state, 'queued', 'every slot there is still taken');
  assert.equal(requests.filter(row => row.standupFor && row.state !== 'done').length, 0, 'no standup question is left there');
  assert.equal(task.messages.at(-1).text, 'Standup done · 1 session on 1 computer · 1 model update · 0 not asked');
  assert.deepEqual(sent.map(body => body.type).filter((type, at, all) => all.indexOf(type) === at), ['remoteStandup', 'remoteStandupRead']);
});

test('/stop reaches an update that is being written beside a turn on the other computer: that run stops, its turn goes on, and nothing of the standup runs there later', async t => {
  const me = 'a'.repeat(64);
  // A model there that takes half a minute to write an update.
  const there = await otherComputer(t, { asker: me, slots: 1, answer: { mode: 'slow' } });
  await there.request('start', { goal: 'Uppercase the coupon codes', permissions: 'full' });
  const session = await until(async () => (await there.request('sessions')).find(row => row.state === 'running' && /npm test/.test(row.log)), 'the turn that never ends there', 30000);
  const ref = `${await there.request('key')}:${session.id}`, round = newRound();
  const asked = await there.request('remoteStandup', { round, refs: [ref] });
  assert.deepEqual(asked.asked.map(row => row.ref), [ref]); assert.equal(asked.records[0].ref, ref); assert.equal(asked.records[0].record.state, 'working'); assert.equal(asked.records[0].record.command, 'npm test');
  await until(async () => (await there.request('runs')).some(run => run.aside), 'the run beside the turn');
  assert.deepEqual((await there.request('remoteStandupRead', { round, refs: [ref] })).pending.map(row => [row.ref, row.why]), [[ref, 'writing']]);
  const started = Date.now();
  assert.deepEqual(await there.request('remoteStandupStop', { round }), { stopped: 1 });
  await until(async () => !(await there.request('runs')).some(run => run.aside), 'that run to stop', 10000);
  assert.ok(Date.now() - started < 10000, 'it stopped long before the model would have answered');
  assert.equal((await there.request('requests')).filter(row => row.standupFor && row.state !== 'done').length, 0, 'no standup question is left there');
  const after = await there.request('session', { id: session.id });
  assert.equal(after.state, 'running', 'its turn was not stopped'); assert.equal(after.standupTurn, null);
  assert.deepEqual(await there.request('remoteStandupStop', { round }), { stopped: 0 }, 'nothing is left to stop');
});
