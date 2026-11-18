import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis } from './helpers.mjs';
import { ProjectController, registerProject } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';
import { setSessionAuto } from '../lib/auto-model.mjs';
import { Conductor, enqueue } from '../lib/conductor.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import { setSessionModel } from '../lib/models.mjs';
import { createConversation } from '../lib/runner.mjs';

// Where the bot that oversees the sessions (docs/orchestrator.md) meets Auto model
// (docs/models.md): only the owner's own typed words pick a step or begin a session with Auto
// model, so nothing the bot sends does, whatever comes with it.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const flag = (args, name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const MODELS = { fable: 'claude-fable-5-2', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5', 'claude-haiku-5-5': 'claude-haiku-5-5' };
function setup(t) {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer', models: MODELS });
  environment(t, { ...fake.env, HOME: p.parent, CODEX_HOME: path.join(p.parent, 'codex-home'), GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = new ProjectController(projectFolder(p.root)); registerProject(controller.repo);
  const turns = () => rows(fake.calls).filter(row => row.vendor === 'claude' && row.args.includes('--output-format'));
  return { ...p, fake, controller, repo: controller.repo, turns };
}
const NOTE = { overseer: 'orchestrator' }, START = { permissions: 'auto', place: { kind: 'worktree' }, folders: [], bots: [], overseer: 'orchestrator', budgetUsd: 1.5 };

test("a note of the bot that oversees the sessions picks no step of Auto model: the turn runs on the model the session ran last", { timeout: 90000 }, async t => {
  const f = setup(t);
  const first = await f.controller.ask('Explain the coupon module').finished;
  assert.equal(flag(f.turns()[0].args, '--model'), 'opus');
  setSessionAuto(f.repo, first.id, true);
  // The bot's note, even when a caller says the words are the owner's: no step, so no top model.
  const noted = await f.controller.ask('Plan the change to the coupon module', first.id, { ...NOTE, ownerWords: true }).finished;
  assert.equal(noted.state, 'answered', JSON.stringify(noted.error));
  assert.equal(flag(f.turns().at(-1).args, '--model'), 'opus', 'the model the session ran last');
  assert.equal(readTask(f.repo, first.id).messages.at(-1).overseer ?? readTask(f.repo, first.id).messages.find(row => row.text === 'Plan the change to the coupon module')?.overseer, true, 'the note is the bot\'s');
  // The owner's own words do pick the step: a plan goes to the top model.
  const planned = await f.controller.ask('Plan the change to the coupon module', first.id, { ownerWords: true }).finished;
  assert.equal(planned.state, 'answered', JSON.stringify(planned.error));
  assert.equal(flag(f.turns().at(-1).args, '--model'), 'fable');
});

test('nothing the bot that oversees the sessions sends carries a mark of Auto model, and a session it starts never begins with it', async t => {
  const f = setup(t);
  const first = await f.controller.ask('Explain the coupon module').finished;
  const only = /nothing of yours goes with it/;
  assert.throws(() => enqueue(f.root, 'Run the tests again.', { continuationTaskId: first.id, ...NOTE, retried: true }), only);
  assert.throws(() => enqueue(f.root, 'Run the tests again.', { continuationTaskId: first.id, ...NOTE, byElu: true }), only);
  assert.throws(() => enqueue(f.root, 'Tidy the docs', { ...START, auto: true }), /Only a new session of yours starts with Auto model|nothing of yours goes with it/);
  // A session it starts, with Auto model asked for beside it: its record has none.
  const started = await f.controller.ask('Tidy the docs', null, { ...START, auto: true }).finished;
  assert.equal(started.overseer, 'orchestrator'); assert.equal(started.auto, undefined, 'never begins with Auto model');
  const made = createConversation(f.repo, f.controller.draftConfig, 'Tidy the tests', { ...START, auto: true });
  assert.equal(made.overseer, 'orchestrator'); assert.equal(made.auto, undefined);
});

// One model's weekly limit makes Auto model start the owner's own message again on the session's
// other model. A note of the bot is not his message: it ends there, and the session keeps its model.
test("a note of the bot whose turn meets one model's weekly limit is not started again on the other model", { timeout: 90000 }, async t => {
  const f = setup(t);
  const first = await f.controller.ask('Look at the coupon code.', null, { auto: true }).finished, id = String(first.id);
  assert.equal(readTask(f.repo, id).auto, true);
  setSessionModel(f.repo, id, { vendor: 'claude', model: 'fable' });
  const conductor = new Conductor({ tickMs: 3600000 }), real = conductor.controller(f.repo), asked = [];
  const limit = { model: 'fable', until: Date.now() + 2 * 86400000 };
  conductor.controller = () => ({ repo: real.repo, ask: (text, session, options) => {
    asked.push(options);
    if (asked.length > 1) return real.ask(text, session, options);
    return { id: session, finished: Promise.reject(Object.assign(new Error('Fable 5.2 could not finish.'), { details: { cause: 'quota', modelLimit: limit } })), worked: () => false };
  } });
  const sent = enqueue(f.root, 'Did the tests pass?', { continuationTaskId: id, priority: 1, overseer: 'orchestrator' });
  const row = () => pendingRequests(f.root).find(value => value.id === sent.id);
  conductor.launch(f.repo, row());
  await [...conductor.runs.values()].find(value => value.requestId === sent.id).done;
  assert.notEqual(row()?.state, 'queued', 'the note does not wait to run again');
  assert.equal(asked.length, 1);
  const lines = () => readTask(f.repo, id).messages.filter(message => message.line === true && /answers until then/.test(message.text));
  assert.deepEqual(lines(), [], 'no line says another model answers');
  // Handed a limit all the same, a note still runs on the model the session ran last.
  const before = f.turns().length;
  await f.controller.ask('Did the tests pass?', id, { ...NOTE, limited: limit }).finished;
  assert.equal(flag(f.turns().at(-1).args, '--model'), 'fable'); assert.equal(f.turns().length, before + 1);
  assert.deepEqual(lines(), []);
  assert.notEqual(readTask(f.repo, id).nextModel?.model, 'opus');
});
