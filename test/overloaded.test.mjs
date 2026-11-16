import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, autoApprove } from './helpers.mjs';
import { ProjectController, activity, conversationEntries } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask, taskDir } from '../lib/state.mjs';
import { parseConfig } from '../lib/config.mjs';
import { changeLine } from '../lib/agent-change.mjs';
import { overloadClock } from '../lib/runner.mjs';
import * as claude from '../lib/adapters/claude.mjs';
import * as codex from '../lib/adapters/codex.mjs';
import * as grok from '../lib/adapters/grok.mjs';
import * as agy from '../lib/adapters/agy.mjs';

// The owner on 2026-11-15: a turn failed with Claude's "API Error: 529 Overloaded", the vendor's
// own answer that its service is busy for now. Such a turn is tried again after a short wait, a
// few times, before it is reported, and the chat says so in one line while it waits. Nothing else
// is tried again: no credits, a prompt too long and a refusal keep their own ways.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
// The waits, shrunk for the test, as the owner's ELU waits 15, 30 and 60 seconds.
function shortWaits(t) { const kept = overloadClock.waits; overloadClock.waits = [300, 300, 300]; t.after(() => { overloadClock.waits = kept; }); }
// A session that answered once; from then on the stand-in Claude Code is overloaded for that many turns.
async function setup(t, overloaded) {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer' });
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  const first = await controller.ask('Where is coupon normalization?').finished;
  const file = path.join(fake.dir, 'fake.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), overloaded }));
  const runs = () => rows(fake.calls).filter(row => row.vendor === 'claude' && row.args.includes('-p')).length, before = runs();
  return { ...p, fake, controller, first, turns: () => runs() - before, lines: () => (readTask(controller.repo, first.id).messages ?? []).filter(row => row.from === 'ELU' && row.line), working: () => readTask(controller.repo, first.id).activeLog ?? null };
}
// Each line the chat showed while the turn ran, as it changed, and whether the working steps
// under it read a log then (steps: the turned-away try's own, while it waits).
function watchLines(t, f) {
  const seen = [], steps = [], timer = setInterval(() => { const log = f.working(); for (const row of f.lines()) { if (seen.at(-1) !== row.text) seen.push(row.text); if (/Trying again/.test(row.text) && log) steps.push(log); } }, 10);
  t.after(() => clearInterval(timer));
  return { seen, steps, stop: () => clearInterval(timer) };
}

test('a turn Claude answers with 529 Overloaded is tried again after a short wait, and the chat says so in one line while it waits', { timeout: 60000 }, async t => {
  shortWaits(t);
  const f = await setup(t, 2), watch = watchLines(t, f);
  const task = await f.controller.ask('What would you change?', f.first.id).finished;
  watch.stop();
  assert.equal(task.state, 'answered');
  assert.equal(f.turns(), 3, 'twice overloaded, then it ran');
  // One line, changed in place: what it waits for, then what happened.
  assert.deepEqual(f.lines().map(row => row.text), ['Claude was overloaded. Tried again 2 times.']);
  assert.ok(watch.seen.includes('Claude is overloaded. Trying again in 1 s (1 of 3).'), watch.seen.join(' | '));
  assert.ok(watch.seen.includes('Claude is overloaded. Trying again in 1 s (2 of 3).'), watch.seen.join(' | '));
  // While it waits, the working steps under the line show nothing of the try it turned away, nor
  // does the session's activity, whose newest row shows there before a try's first step.
  assert.deepEqual(watch.steps, []);
  assert.ok(!activity(f.controller.repo).some(row => /529|Overloaded/.test(String(row.text))), 'no row of a turned-away try');
  assert.ok(!(task.messages ?? []).some(row => /could not run|could not finish/.test(String(row.text))));
  // The chat shows the line and the answer: the tries the vendor turned away are not replies.
  const chat = conversationEntries(f.controller.repo, task).map(row => String(row.text));
  assert.ok(!chat.some(text => /529|Overloaded/.test(text)), chat.join(' | '));
  assert.equal(chat.filter(text => text === 'Claude was overloaded. Tried again 2 times.').length, 1);
});

// A model and an effort the owner chooses for the session while its turn waits to try again
// (lib/agent-change.mjs): the turn goes on as it started, every try on the model and effort it
// began with, and takes the choice in as it ends. The next turn runs on it, in the same
// conversation. The chat keeps one line of each.
test('a model and effort chosen while an overloaded turn waits to try again start with the next turn', { timeout: 60000 }, async t => {
  shortWaits(t); overloadClock.waits = [600, 600, 600];
  const f = await setup(t, 2), repo = f.controller.repo, id = f.first.id;
  const policy = () => parseConfig(fs.readFileSync(path.join(taskDir(repo, id), 'policy.yaml'), 'utf8')).roles.lead;
  const launches = () => rows(f.fake.calls).filter(row => row.vendor === 'claude' && row.args.includes('-p')), arg = (call, name) => call.args.includes(name) ? call.args[call.args.indexOf(name) + 1] : null;
  const started = launches().at(-1), before = launches().length, own = policy().model ?? null;
  assert.notEqual(own, 'sonnet');
  const asked = f.controller.ask('What would you change?', id);
  for (const from = Date.now(); !f.lines().some(row => /Trying again/.test(row.text));) { assert.ok(Date.now() - from < 20000, 'the turn waits to try again'); await new Promise(resolve => setTimeout(resolve, 10)); }
  const saved = f.controller.changeAgent(id, { bot: null, to: { vendor: 'claude', model: 'sonnet', effort: 'low' }, line: later => changeLine({ who: 'this session', model: ['Opus', 'Sonnet'], effort: ['medium', 'low'], later }) });
  assert.deepEqual(saved, { later: true, line: 'Model of this session: Opus → Sonnet, effort medium → low. It applies from the next turn.' });
  assert.equal(policy().model ?? null, own, 'the turn that waits keeps its model');
  const task = await asked.finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  // Twice overloaded, then it ran: each try as the turn started.
  const tries = launches().slice(before);
  assert.deepEqual(tries.map(call => [arg(call, '--model'), arg(call, '--effort')]), Array.from({ length: 3 }, () => [arg(started, '--model'), null]));
  // As it ended it took the choice in: the session's saved model, and nothing left waiting.
  assert.equal(policy().model, 'sonnet');
  const kept = readTask(repo, id);
  assert.equal(kept.nextModel, undefined); assert.equal(kept.leadEffort, 'low');
  assert.deepEqual(conversationEntries(repo, kept).filter(entry => entry.role === 'ELU' && entry.line).map(entry => entry.text).sort(), ['Claude was overloaded. Tried again 2 times.', 'Model of this session: Opus → Sonnet, effort medium → low. It applies from the next turn.']);
  // The next turn: the same conversation, on the model and effort he chose.
  const next = await f.controller.ask('And then?', id).finished;
  assert.equal(next.state, 'answered', JSON.stringify(next.error));
  const call = launches().at(-1);
  assert.equal(launches().length, before + 4, 'one launch: nothing is overloaded now');
  assert.deepEqual([arg(call, '--model'), arg(call, '--effort'), arg(call, '--resume')], ['sonnet', 'low', task.runs.at(-1).session]);
});

test('a turn still overloaded after three more tries is reported as Claude said it', { timeout: 60000 }, async t => {
  shortWaits(t);
  const f = await setup(t, 9);
  await assert.rejects(f.controller.ask('What would you change?', f.first.id).finished, /The model could not run: Claude says: API Error: 529 Overloaded/);
  assert.equal(f.turns(), 4, 'the first try and three more');
  assert.deepEqual(f.lines().map(row => row.text), ['Claude was overloaded. Tried again 3 times.']);
  // What the vendor said shows once, from the try that was reported.
  const chat = conversationEntries(f.controller.repo, readTask(f.controller.repo, f.first.id)).map(row => String(row.text));
  assert.equal(chat.filter(text => /API Error: 529 Overloaded/.test(text)).length, 1, chat.join(' | '));
});

test('only the vendor\'s own overloaded answer is tried again: credits, limits, a prompt too long and other errors are not', () => {
  const result = extra => JSON.stringify({ type: 'result', subtype: 'success', is_error: true, ...extra });
  assert.equal(claude.classify(result({ api_error_status: 529, api_error: 'overloaded_error', result: 'API Error: 529 Overloaded' })), 'overloaded');
  assert.equal(claude.classify(result({ result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' })), 'overloaded');
  assert.equal(claude.classify(result({ api_error_status: 429, api_error: 'model_requires_usage_credits', result: "You're out of usage credits." })), 'model-unavailable');
  assert.equal(claude.classify(result({ api_error_status: 429, api_error: 'usage_limit_reached', result: "You've hit your 5-hour limit" })), 'quota');
  assert.equal(claude.classify(result({ result: 'Prompt is too long' })), 'too-long');
  assert.equal(claude.classify(result({ api_error_status: 500, api_error: 'api_error', result: 'Internal server error' })), 'unknown');
  // Codex, Grok Build and Antigravity say the same in their own words.
  assert.equal(codex.classify(JSON.stringify({ type: 'turn.failed', error: { message: 'exceeded retry limit, last status: 529 Overloaded' } })), 'overloaded');
  assert.equal(codex.classify(JSON.stringify({ type: 'error', message: 'The server is overloaded. Please try again later.' })), 'overloaded');
  assert.equal(codex.classify(JSON.stringify({ type: 'turn.failed', error: { message: 'You exceeded your current quota: insufficient_quota' } })), 'quota');
  assert.equal(grok.classify(JSON.stringify({ type: 'error', message: '503 Service Unavailable: the model is overloaded' })), 'overloaded');
  assert.equal(grok.classify(JSON.stringify({ type: 'error', message: '429 Too Many Requests' })), 'rate-limit');
  assert.equal(agy.classify('Error: [503 UNAVAILABLE] The model is overloaded. Please try again later.'), 'overloaded');
  assert.equal(agy.classify('Error: [429 RESOURCE_EXHAUSTED] quota exceeded'), 'quota');
  // A word in a reply about overloaded functions is no answer of the vendor's.
  assert.equal(agy.classify('The parser has two overloaded functions, parse and parseAll.'), 'unknown');
});
