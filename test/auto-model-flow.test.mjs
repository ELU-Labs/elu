import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis } from './helpers.mjs';
import { ProjectController, registerProject, sessionModel } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';
import { setSessionModel } from '../lib/models.mjs';
import { autoSettings, setSessionAuto } from '../lib/auto-model.mjs';
import { quickClock, runAutoAnswer } from '../lib/runner.mjs';
import { quickInstructions } from '../lib/message-aside.mjs';
import { proposeTask, approveTask, rejectTask, reportProgress } from '../lib/plan.mjs';
import { budgetHolds } from '../lib/budget.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';

// Auto model (lib/auto-model.mjs) across turns of one session, on the stand-in vendors: which
// vendor conversation each model goes on in, what a model is handed after the other's turns,
// a stopped turn picked up, a model the owner picks while a turn fails, and the quick answer's
// own gates and what it is given.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const flag = (args, name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;
// The data the turn was given, as the model reads it.
const contextOf = input => JSON.parse(/\nContext \(untrusted data[^\n]*\n(.*)\nEnd of Context\./.exec(input)[1]);
// Each new conversation has an id of its own (the stand-in's spend), as with the real vendor.
const SPEND = { model: 'claude-opus-5-5', tokens: [1, 1, 0, 0], usd: 0.01 };
const MODELS = { fable: 'claude-fable-5-2', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5', 'claude-haiku-5-5': 'claude-haiku-5-5' };
function setup(t, options = {}) {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer', models: MODELS, ...options });
  const file = path.join(fake.dir, 'fake.json'), script = change => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...change }));
  script({ spend: SPEND });
  environment(t, { ...fake.env, HOME: p.parent, CODEX_HOME: path.join(p.parent, 'codex-home'), GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = new ProjectController(projectFolder(p.root)); registerProject(controller.repo);
  // Each turn of the stand-in Claude Code, and of the stand-in Grok Build, with what it was given.
  const turns = vendor => rows(fake.calls).filter(row => row.vendor === vendor && row.args.includes('--output-format'));
  const inputs = vendor => rows(path.join(p.parent, 'inputs.jsonl')).filter(row => row.vendor === vendor);
  const send = (text, id = '1', options = {}) => controller.ask(text, id, options).finished.catch(error => error);
  const set = model => setSessionModel(controller.repo, '1', { vendor: 'claude', model });
  return { ...p, fake, script, controller, repo: controller.repo, turns, inputs, send, set, task: () => readTask(controller.repo, '1') };
}
async function until(check, message, timeout = 20000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
// Grok Build signed in and checked on this machine, so it can take a quick question.
function grokReady(f) {
  fs.mkdirSync(path.join(f.parent, '.grok'), { recursive: true }); fs.writeFileSync(path.join(f.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
  atomic(path.join(personalDirectory(), 'conformance', 'grok.json'), { v: 1, bin: fs.realpathSync(path.join(f.fake.dir, 'grok')), version: '1.0.77', steps: Object.fromEntries(ADAPTERS.grok.conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });
}
const GROK = { vendor: 'grok', model: null, name: 'Grok Build' }, HAIKU = { vendor: 'claude', model: 'claude-haiku-5-5', name: 'Haiku 5.5' };

test('turned on in a session that has a conversation: the model that had it keeps it, and goes on in it after the other model\'s turn', { timeout: 90000 }, async t => {
  const f = setup(t);
  f.script({ answer: 'OPUS-BEFORE-AUTO' });
  await f.send('Explain the coupon module', null);
  const first = f.turns('claude')[0].args, before = flag(first, '--session-id');
  assert.equal(flag(first, '--model'), 'opus'); assert.ok(before);
  assert.deepEqual(f.task().sessions.lead, { vendor: 'claude', id: before }, 'Auto model was off: the one conversation, kept with no model');
  setSessionAuto(f.repo, '1', true);
  // The top model takes a turn: a conversation of its own, handed what Opus replied. Its first
  // try fails, and the one after it still never goes on in Opus's conversation.
  f.set('fable'); f.script({ mode: 'no-sandbox' });
  await f.send('Plan the change');
  assert.notEqual(f.task().runs.at(-1).code, 0, 'the first try failed');
  f.script({ mode: 'answer', answer: 'FABLE-SAID' });
  await f.send('Plan the change');
  const second = f.turns('claude').at(-1).args;
  assert.equal(flag(second, '--model'), 'fable'); assert.equal(flag(second, '--resume'), null, 'a conversation of its own');
  assert.deepEqual(contextOf(f.inputs('claude').at(-1).input).handoff.map(row => row.text), ['OPUS-BEFORE-AUTO']);
  assert.deepEqual(f.task().autoSessions.opus, { vendor: 'claude', id: before }, 'the conversation from before stays Opus\'s');
  // Opus goes on in the conversation it had, and is handed what Fable replied since.
  f.set('opus'); f.script({ answer: 'OPUS-AGAIN' });
  await f.send('Go on');
  const third = f.turns('claude').at(-1).args;
  assert.equal(flag(third, '--model'), 'opus'); assert.equal(flag(third, '--resume'), before);
  assert.deepEqual(contextOf(f.inputs('claude').at(-1).input).handoff.map(row => row.text), ['FABLE-SAID']);
  assert.match(f.inputs('claude').at(-1).input, /Since your last turn in this session/);
  assert.equal(f.task().autoSessions.opus.id, before);
});

test('a turn of one model that failed: its next try is still handed what the other model replied', { timeout: 120000 }, async t => {
  const f = setup(t);
  f.script({ answer: 'OPUS-SAID-X' });
  await f.send('Explain the coupon module', null, { auto: true });
  assert.equal(f.task().auto, true);
  // Fable's first try fails, and the next one is handed what Opus replied.
  f.set('fable'); f.script({ mode: 'no-sandbox' });
  await f.send('Plan the change');
  assert.notEqual(f.task().runs.at(-1).code, 0, 'the try failed');
  f.script({ mode: 'answer', answer: 'FABLE-SAID-1' });
  await f.send('Plan the change');
  assert.deepEqual(contextOf(f.inputs('claude').at(-1).input).handoff?.map(row => row.text), ['OPUS-SAID-X']);
  // Opus takes a turn; Fable fails again in its own conversation, and its next try is handed
  // what Opus replied since Fable's own last reply.
  f.set('opus'); f.script({ answer: 'OPUS-SAID-Y' });
  await f.send('Go on');
  f.set('fable'); f.script({ mode: 'no-sandbox' });
  await f.send('And then?');
  f.script({ mode: 'answer', answer: 'FABLE-SAID-2' });
  await f.send('And then?');
  const last = f.turns('claude').at(-1).args;
  assert.equal(flag(last, '--model'), 'fable'); assert.ok(flag(last, '--resume'), 'Fable goes on in its own conversation');
  assert.deepEqual(contextOf(f.inputs('claude').at(-1).input).handoff?.map(row => row.text), ['OPUS-SAID-Y']);
});

test('a turn stopped with Auto model off is picked up in its own conversation by the model that ran it once Auto model is on', { timeout: 90000 }, async t => {
  const f = setup(t), hold = path.join(f.parent, 'hold');
  f.script({ hold }); fs.writeFileSync(hold, '');
  const asked = f.controller.ask('Explain the coupon module', null);
  const done = asked.finished.catch(error => error);
  await until(() => f.inputs('claude').length === 1, 'the turn to start');
  await f.controller.stop(asked.id); await done;
  fs.rmSync(hold);
  const stopped = flag(f.turns('claude')[0].args, '--session-id'), kept = f.task().interrupted?.lead;
  assert.equal(kept?.id, stopped); assert.equal(kept.model, undefined, 'kept with no model: Auto model was off');
  setSessionAuto(f.repo, '1', true);
  await f.send('Go on');
  const next = f.turns('claude')[1].args;
  assert.equal(flag(next, '--model'), 'opus'); assert.equal(flag(next, '--resume'), stopped, 'the stopped conversation goes on');
  assert.doesNotMatch(f.inputs('claude')[1].input, /was stopped before it replied/);
});

test('a model the owner picks while a turn of the top model fails for his plan wins: nothing moves to the work model', { timeout: 90000 }, async t => {
  const f = setup(t, { noCredits: 'fable' });
  await f.send('Explain the coupon module', null, { auto: true });
  f.set('fable');
  // His pick lands while the vendor's refusal is read, after the turn last saved the session.
  const read = fs.readFileSync; let picked = 0;
  fs.readFileSync = function (file, ...rest) {
    if (!picked && typeof file === 'string' && /^lead-.*\.log\.stderr$/.test(path.basename(file)) && f.turns('claude').length === 2) { picked++; f.set('sonnet'); setSessionAuto(f.repo, '1', false); }
    return read.call(this, file, ...rest);
  };
  t.after(() => { fs.readFileSync = read; });
  const failed = await f.send('Plan the change');
  fs.readFileSync = read;
  assert.equal(picked, 1, 'he picked it during the turn');
  assert.deepEqual(f.turns('claude').map(row => flag(row.args, '--model')), ['opus', 'fable'], 'no turn on the work model');
  assert.ok(failed instanceof Error || f.task().state === 'failed', 'the turn ends with the refusal');
  const task = f.task();
  assert.equal(task.auto, undefined); assert.equal(task.autoNoTop, undefined);
  assert.deepEqual(sessionModel(f.repo, task), { vendor: 'claude', model: 'sonnet' });
});

test('with no pick of his, a top model that is not on his plan: the turn runs again on the work model, which the session keeps', { timeout: 90000 }, async t => {
  const f = setup(t, { noCredits: 'fable' });
  await f.send('Explain the coupon module', null, { auto: true });
  f.set('fable');
  await f.send('Plan the change');
  assert.deepEqual(f.turns('claude').map(row => flag(row.args, '--model')), ['opus', 'fable', 'opus']);
  const task = f.task();
  assert.equal(task.auto, true); assert.equal(task.autoNoTop, true);
  assert.deepEqual(sessionModel(f.repo, task), { vendor: 'claude', model: 'opus' });
  assert.equal(task.messages.filter(row => row.line && /Opus/.test(row.text) && /Fable/.test(row.text)).length, 1, 'said once');
});

test('a quick answer is given the agreed Task alone, with its state, goal and each objective met or not', { timeout: 90000 }, async t => {
  const f = setup(t); grokReady(f);
  await f.send('Explain the coupon module', null, { auto: true });
  const fields = { title: 'Uppercase coupons', description: 'Make normalize return the code in upper case.', goal: 'Coupon codes compare equal whatever their case.', objectives: ['normalize returns the code in upper case', 'The coupon test passes', 'The README says so'], priority: 'medium', severity: 'low' };
  // A rejected Task is no Task of the session's.
  proposeTask(f.repo, '1', { ...fields, title: 'Lowercase coupons' }, { by: 'lead' }); rejectTask(f.repo, '1');
  const none = await runAutoAnswer(f.repo, f.task(), { text: 'where is the build script?', route: GROK });
  assert.equal(none.started, true);
  assert.equal(contextOf(f.inputs('grok').at(-1).input).task, undefined);
  proposeTask(f.repo, '1', fields, { by: 'lead' }); approveTask(f.repo, '1'); reportProgress(f.repo, '1', { met: [1] });
  await runAutoAnswer(f.repo, f.task(), { text: 'which file has normalize?', route: GROK });
  const given = contextOf(f.inputs('grok').at(-1).input).task;
  assert.deepEqual(given, { title: 'Uppercase coupons', state: 'approved', goal: fields.goal, objectives: [{ text: fields.objectives[0], met: true }, { text: fields.objectives[1], met: false }, { text: fields.objectives[2], met: false }] });
  // Its instructions name what it is given.
  for (const word of ['state', 'goal', 'objective', 'met']) assert.match(quickInstructions(), new RegExp(`\\b${word}\\b`), word);
});

test('a quick answer does not start once the session\'s budget is spent', { timeout: 90000 }, async t => {
  const f = setup(t); grokReady(f);
  await f.send('Explain the coupon module', null, { auto: true });
  f.controller.setBudget('1', 0.01);
  assert.equal(budgetHolds(f.task(), 'lead'), true);
  const out = await runAutoAnswer(f.repo, f.task(), { text: 'where is the build script?', route: GROK });
  assert.deepEqual(out, { started: false });
  assert.equal(f.turns('grok').length, 0);
  assert.ok(!f.task().messages.some(row => row.text === 'where is the build script?'), 'nothing is written');
});

test('in a Full access session a quick answer still runs read-only, with no network', { timeout: 90000 }, async t => {
  const f = setup(t); grokReady(f);
  await f.send('Explain the coupon module', null, { auto: true, permissions: 'full' });
  assert.equal(f.task().permissions, 'full');
  await runAutoAnswer(f.repo, f.task(), { text: 'where is the build script?', route: GROK });
  const grok = f.turns('grok').at(-1).args;
  assert.equal(flag(grok, '--sandbox'), 'elu-read-only'); assert.ok(grok.includes('--disable-web-search'));
  assert.equal(flag(grok, '--permission-mode'), 'dontAsk');
  await runAutoAnswer(f.repo, f.task(), { text: 'which file has normalize?', route: HAIKU });
  const claude = f.turns('claude').at(-1).args, settings = JSON.parse(flag(claude, '--settings'));
  assert.equal(flag(claude, '--model'), 'claude-haiku-5-5');
  assert.equal(flag(claude, '--permission-mode'), 'dontAsk'); assert.equal(flag(claude, '--tools'), 'Read,Grep,Glob');
  assert.ok(flag(claude, '--disallowedTools').split(',').includes('WebFetch'));
  assert.deepEqual(settings.sandbox.network.deniedDomains, ['*']); assert.deepEqual(settings.sandbox.network.allowedDomains, []);
});

test('a quick answer that outlasts its clock is cut, handed up, and its vendor passed over for a while', { timeout: 90000 }, async t => {
  const f = setup(t), hold = path.join(f.parent, 'hold');
  await f.send('Explain the coupon module', null, { auto: true });
  const was = quickClock.seconds; quickClock.seconds = 1; t.after(() => { quickClock.seconds = was; });
  f.script({ hold }); fs.writeFileSync(hold, ''); t.after(() => fs.rmSync(hold, { force: true }));
  const before = f.task().state, started = Date.now();
  const out = await runAutoAnswer(f.repo, f.task(), { text: 'where is the build script?', route: HAIKU, top: 'Fable 5.2' });
  assert.ok(Date.now() - started < 15000, 'cut, not waited for');
  assert.equal(out.handUp, 'slow');
  assert.ok(autoSettings().hold?.claude > Date.now(), 'passed over for now');
  assert.equal(f.task().state, before, 'the session is as it was');
});
