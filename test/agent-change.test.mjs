import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis } from './helpers.mjs';
import { ProjectController, conversationEntries, sessionModel } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { lock, readTask, taskDir, settingsFile } from '../lib/state.mjs';
import { parseConfig } from '../lib/config.mjs';
import { takeNextModel } from '../lib/models.mjs';
import { getBot, saveBot } from '../lib/bots.mjs';
import { CHANGE_USAGE, changeKind, changeLine, changeWarning, changeWords, everyBot, sessionBot } from '../lib/agent-change.mjs';

// Changing an agent of a session (lib/agent-change.mjs), against the stand-in vendors: the
// session's model by effort, by another model of its vendor and by another vendor, a bot in
// it for this session or for every one, while a turn runs, and what is refused.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function setup(t, vendor = 'claude', model = 'opus') {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer' });
  environment(t, { ...fake.env, HOME: p.parent, XDG_CONFIG_HOME: path.join(p.parent, 'personal'), GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = new ProjectController(projectFolder(p.root)); Object.assign(controller.draftConfig.roles.lead, { vendor, model, ...(vendor === 'claude' ? {} : { maxCostUsd: null }) });
  const lines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  // The vendor launches that ran a turn, and what each was given to read.
  const turns = () => lines(fake.calls).filter(call => call.vendor === 'claude' ? call.args.includes('-p') : call.vendor === 'codex' ? call.args[0] === 'exec' : false);
  const inputs = () => lines(path.join(p.parent, 'inputs.jsonl'));
  const policy = id => fs.readFileSync(path.join(taskDir(controller.repo, id), 'policy.yaml'), 'utf8');
  const elu = task => conversationEntries(controller.repo, task).filter(entry => entry.role === 'ELU' && entry.line).map(entry => entry.text);
  return { ...p, fake, controller, turns, inputs, policy, elu };
}
const arg = (call, name) => call.args.includes(name) ? call.args[call.args.indexOf(name) + 1] : null;

test('effort alone changes nothing else: the same conversation goes on, the next turn runs with the new level, and the chat says so in one line', async t => {
  const f = setup(t);
  const first = await f.controller.ask('Reply with the summary "one".').finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  const session = first.runs[0].session; assert.ok(session);
  const before = f.policy(first.id);
  // No warning for an effort alone.
  assert.equal(changeKind({ vendor: 'claude', model: 'opus', effort: null }, { vendor: 'claude', model: 'opus', effort: 'high' }), 'effort');
  assert.equal(changeWarning('effort', { from: 'Opus', to: 'Opus' }), null);
  const saved = f.controller.changeAgent(first.id, { bot: null, to: { vendor: 'claude', model: 'opus', effort: 'high' }, line: later => changeLine({ who: 'Opus', effort: ['medium', 'high'], later }) });
  assert.deepEqual(saved, { later: false, line: 'Effort of Opus: medium → high' });
  assert.equal(f.policy(first.id), before, 'the saved policy is as it was: an older ELU reads it as before');
  assert.equal(parseConfig(f.policy(first.id)).roles.lead.effort, undefined);
  assert.equal(readTask(f.controller.repo, first.id).leadEffort, 'high');
  const second = await f.controller.ask('Reply with the summary "two".', first.id).finished;
  assert.equal(second.state, 'answered', JSON.stringify(second.error));
  const call = f.turns().at(-1);
  assert.equal(arg(call, '--resume'), session, 'the same vendor session goes on');
  assert.equal(arg(call, '--effort'), 'high', 'with the new level');
  assert.equal(second.runs.at(-1).effort, 'high');
  assert.doesNotMatch(f.inputs().at(-1).input, /You take over this session/, 'nothing is handed over');
  assert.deepEqual(f.elu(second), ['Effort of Opus: medium → high']);
  // The first turn ran with the vendor's own level: no --effort before the change.
  assert.equal(arg(f.turns()[0], '--effort'), null);
});

test('another model of the same vendor resumes the same vendor session on that model, and says it reads the conversation again', async t => {
  const f = setup(t, 'codex', 'big-model');
  // In Full access a Codex session goes on from turn to turn (exec resume); in Read only every turn is a new one (below).
  const first = await f.controller.ask('Reply with the summary "one".', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  const session = first.runs[0].session; assert.ok(session);
  assert.equal(changeKind({ vendor: 'codex', model: 'big-model' }, { vendor: 'codex', model: 'quick-model' }), 'model');
  assert.equal(changeWarning('model', { from: 'Big Model', to: 'Quick Model' }), "Quick Model reads this session's conversation again on its next turn: the first turn is slower and costs more.");
  f.controller.changeAgent(first.id, { bot: null, to: { vendor: 'codex', model: 'quick-model', effort: null } });
  assert.equal(parseConfig(f.policy(first.id)).roles.lead.model, 'quick-model');
  const second = await f.controller.ask('Reply with the summary "two".', first.id).finished;
  assert.equal(second.state, 'answered', JSON.stringify(second.error));
  const call = f.turns().at(-1);
  assert.deepEqual(call.args.slice(0, 3), ['exec', 'resume', session], 'codex exec resume, the same session');
  assert.equal(arg(call, '--model'), 'quick-model');
  assert.equal(second.runs.at(-1).session, session);
  assert.doesNotMatch(f.inputs().at(-1).input, /You take over this session/, 'no handoff: the vendor session holds the conversation');
  // Read only: Codex has no read-only resume (exec resume takes no --sandbox), so every turn
  // starts a new vendor session from the chat, and another model of it reads nothing more.
  assert.equal(changeWarning('model', { from: 'Big Model', to: 'Quick Model', fresh: true }), 'Quick Model starts its next turn from this chat, as every turn here does: nothing more is read.');
  const plain = await f.controller.ask('Reply with the summary "read only".').finished;
  assert.equal(plain.state, 'answered', JSON.stringify(plain.error));
  const again = await f.controller.ask('Reply with the summary "again".', plain.id).finished;
  assert.equal(again.state, 'answered', JSON.stringify(again.error));
  assert.equal(f.turns().at(-1).args[1], '--ignore-user-config', 'a new codex session, not exec resume');
  assert.ok(f.turns().at(-1).args.includes('read-only'));
});

test('another vendor starts a new vendor session, handed what the model before it replied; the next turn resumes its own', async t => {
  const f = setup(t, 'claude', 'opus');
  // Full access, where each vendor's session goes on from turn to turn.
  const first = await f.controller.ask('Reply with the summary "alpha reply from the first model".', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  assert.equal(changeKind({ vendor: 'claude', model: 'opus' }, { vendor: 'codex', model: 'big-model' }), 'vendor');
  assert.equal(changeWarning('vendor', { from: 'Opus', to: 'Big Model' }), 'Handoff: Big Model starts a new conversation, given this chat, the replies so far and the Task, not the steps taken to make them.');
  f.controller.changeAgent(first.id, { bot: null, to: { vendor: 'codex', model: 'big-model', effort: null } });
  const second = await f.controller.ask('Reply with the summary "beta".', first.id).finished;
  assert.equal(second.state, 'answered', JSON.stringify(second.error));
  const call = f.turns().at(-1), given = f.inputs().at(-1).input;
  assert.equal(call.vendor, 'codex'); assert.equal(call.args[1] === 'resume', false, 'a new codex session');
  assert.match(given, /You take over this session from .+, a model of another vendor, and start a new conversation here\./);
  const reply = first.result.summary.split('\n')[0]; assert.ok(reply);
  assert.ok(given.includes(`"handoff":[{"at":`) && given.includes(JSON.stringify(reply).slice(1, -1)), "the first model's reply is handed over as data");
  // The codex session now holds the conversation: the turn after resumes it, with no handoff.
  const third = await f.controller.ask('Reply with the summary "gamma".', first.id).finished;
  assert.equal(third.state, 'answered', JSON.stringify(third.error));
  assert.deepEqual(f.turns().at(-1).args.slice(0, 3), ['exec', 'resume', second.runs.at(-1).session]);
  assert.doesNotMatch(f.inputs().at(-1).input, /You take over this session/);
});

test('a change made while a turn runs waits for the next turn, and the chat says so; the turn takes it when it ends, or the next one when it starts', async t => {
  const f = setup(t);
  const first = await f.controller.ask('Reply with the summary "one".').finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  const repo = f.controller.repo, before = f.policy(first.id);
  // A turn holds the session: its lock.
  let release = lock(repo, `task-${first.id}`);
  const saved = f.controller.changeAgent(first.id, { bot: null, to: { vendor: 'claude', model: 'sonnet', effort: 'low' }, line: later => changeLine({ who: 'this session', model: ['Opus', 'Sonnet'], effort: ['medium', 'low'], later }) });
  assert.deepEqual(saved, { later: true, line: 'Model of this session: Opus → Sonnet, effort medium → low. It applies from the next turn.' });
  assert.equal(f.policy(first.id), before, 'the running turn keeps its policy');
  assert.ok(fs.existsSync(settingsFile(repo, first.id)), 'kept beside the record');
  const during = readTask(repo, first.id);
  assert.deepEqual(during.nextModel, { vendor: 'claude', model: 'sonnet' }); assert.equal(during.leadEffort, 'low');
  assert.deepEqual(sessionModel(repo, during), { vendor: 'claude', model: 'sonnet' }, 'shown as the model of the next message');
  // The turn ends: it takes the model in before it lets the session go.
  assert.equal(takeNextModel(repo, during), true);
  release();
  assert.equal(parseConfig(f.policy(first.id)).roles.lead.model, 'sonnet');
  assert.equal(readTask(repo, first.id).nextModel, undefined);
  // Another change while a turn runs, that no turn's end took in: the next turn starts on it.
  release = lock(repo, `task-${first.id}`);
  f.controller.changeAgent(first.id, { bot: null, to: { vendor: 'claude', model: 'opus', effort: 'low' } });
  release();
  assert.deepEqual(readTask(repo, first.id).nextModel, { vendor: 'claude', model: 'opus' });
  const second = await f.controller.ask('Reply with the summary "two".', first.id).finished;
  assert.equal(second.state, 'answered', JSON.stringify(second.error));
  const call = f.turns().at(-1);
  assert.equal(arg(call, '--model'), 'opus'); assert.equal(arg(call, '--effort'), 'low');
  assert.equal(readTask(repo, first.id).nextModel, undefined); assert.equal(parseConfig(f.policy(first.id)).roles.lead.model, 'opus');
  assert.deepEqual(f.elu(second), ['Model of this session: Opus → Sonnet, effort medium → low. It applies from the next turn.']);
});

test('what is refused: an effort the vendor does not offer, a bot not in the session, every session for the model, and words /agent change does not take', async t => {
  const f = setup(t);
  const first = await f.controller.ask('Reply with the summary "one".').finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  const change = to => f.controller.changeAgent(first.id, to);
  assert.throws(() => change({ bot: null, to: { vendor: 'grok', model: null, effort: 'high' } }), { message: 'Grok Build has no effort setting.' });
  assert.throws(() => change({ bot: null, to: { vendor: 'claude', model: 'opus', effort: 'extreme' } }), { message: 'Effort on Opus is one of: low, medium, high, xhigh, max.' });
  assert.throws(() => change({ bot: 'ghost', to: { vendor: 'claude', model: null, effort: null } }), { message: '@ghost is not in this session.' });
  assert.throws(() => change({ bot: null, every: true, to: { vendor: 'claude', model: 'opus', effort: null } }), { message: 'Every session is for a bot. /model default <name> sets what new sessions start with.' });
  assert.throws(() => change({ bot: null, to: { vendor: 'nobody', model: null, effort: null } }), { message: 'Choose a supported vendor: nobody.' });
  const task = readTask(f.controller.repo, first.id);
  for (const key of ['leadEffort', 'botModels', 'agentChanges', 'nextModel']) assert.equal(task[key], undefined, `${key}: nothing was kept`);
  assert.throws(() => changeWords(['model']), { message: CHANGE_USAGE });
  assert.throws(() => changeWords(['size', 'big']), { message: CHANGE_USAGE });
  assert.throws(() => changeWords(['effort']), { message: CHANGE_USAGE });
  assert.deepEqual(changeWords(['model', 'opus', '5.5', 'effort', 'high', '--every-session']), { model: ['opus', '5.5'], effort: 'high', every: true });
  assert.deepEqual(changeWords(['effort', 'low']), { model: null, effort: 'low', every: false });
});

test("a bot's change is for this session only, unless it is for every session; its next turn runs on it", async t => {
  const f = setup(t);
  saveBot({ name: 'critic', vendor: 'claude', model: 'sonnet', effort: 'low', about: 'Reads for risk', instructions: 'Say what could break.' });
  const first = await f.controller.ask('Reply with the summary "one".').finished, other = await f.controller.ask('Reply with the summary "other".').finished;
  for (const task of [first, other]) f.controller.setBots(task.id, ['critic']);
  const saved = f.controller.changeAgent(first.id, { bot: 'critic', to: { vendor: 'codex', model: 'quick-model', effort: 'high' }, line: later => changeLine({ who: '@critic', model: ['Sonnet', 'Quick Model'], effort: ['low', 'high'], later }) });
  assert.equal(saved.line, 'Model of @critic: Sonnet → Quick Model, effort low → high');
  assert.deepEqual(readTask(f.controller.repo, first.id).botModels, { critic: { vendor: 'codex', model: 'quick-model', effort: 'high' } });
  assert.deepEqual([getBot('critic').vendor, getBot('critic').model], ['claude', 'sonnet'], 'the saved bot is as it was');
  const here = sessionBot(readTask(f.controller.repo, first.id), getBot('critic')), there = sessionBot(readTask(f.controller.repo, other.id), getBot('critic'));
  assert.deepEqual([here.vendor, here.model, here.effort], ['codex', 'quick-model', 'high']);
  assert.deepEqual([there.vendor, there.model, there.effort], ['claude', 'sonnet', 'low'], 'another session keeps the bot as saved');
  assert.equal(changeWarning('vendor', { bot: 'critic', from: 'Sonnet', to: 'Quick Model' }), "Handoff: Quick Model takes over @critic from its next turn, from this session's chat.");
  assert.equal(changeWarning('model', { bot: 'critic', from: 'Sonnet', to: 'Opus' }), '@critic starts each turn from the chat, so Opus takes over with nothing to read again.');
  // Written to, it answers on its model in this session.
  const asked = await f.controller.ask('Reply with the summary "risk".', first.id, { bot: 'critic' }).finished;
  assert.equal(asked.state, 'answered', JSON.stringify(asked.error));
  const call = f.turns().at(-1);
  assert.equal(call.vendor, 'codex'); assert.equal(arg(call, '--model'), 'quick-model'); assert.ok(call.args.includes('model_reasoning_effort="high"'), call.args.join(' '));
  // For every session: saved with the bot, and this session runs it as saved again.
  f.controller.changeAgent(first.id, { bot: 'critic', every: true, to: { vendor: 'claude', model: 'opus', effort: null } });
  assert.deepEqual([getBot('critic').vendor, getBot('critic').model, getBot('critic').effort ?? null], ['claude', 'opus', null]);
  assert.equal(readTask(f.controller.repo, first.id).botModels, undefined);
  assert.equal(sessionBot(readTask(f.controller.repo, other.id), getBot('critic')).model, 'opus', 'every session runs the saved bot');
});

test("the agent's page says each change once: the vendor's own effort on both sides is no change, and another model of the vendor says what it does", async () => {
  const { agentDialogs } = await import('../lib/terminal-agent.mjs');
  const names = { opus: 'Opus', sonnet: 'Sonnet', 'big-model': 'Big Model' }, said = [], saved = [], asked = [];
  const pages = agentDialogs({ listDialog: async () => null, yes: async (...words) => { asked.push(words); return true; }, setMessage: text => said.push(text), colour: false, pickModel: async () => null, pickEffort: async () => undefined,
    nameOf: choice => names[choice.model] ?? choice.vendor, save: (agent, to, every, line) => { saved.push(line(false)); return { later: false, line: line(false) }; } });
  const lead = { who: 'Opus', bot: null, vendor: 'claude', model: 'opus', effort: null };
  assert.equal(await pages.apply(lead, { vendor: 'codex', model: 'big-model', effort: null }), true);
  assert.equal(saved.at(-1), 'Model of this session: Opus → Big Model', "Claude Code's own and Codex's own are no effort change");
  assert.equal(asked.length, 1, 'another vendor is asked first');
  assert.equal(await pages.apply(lead, { vendor: 'claude', model: 'sonnet', effort: null }), true);
  assert.equal(saved.at(-1), 'Model of this session: Opus → Sonnet');
  assert.equal(said.at(-1), "Sonnet reads this session's conversation again on its next turn: the first turn is slower and costs more.", 'what it does, under the box');
  assert.equal(asked.length, 1, 'no question for the same vendor');
  assert.equal(await pages.apply(lead, { vendor: 'claude', model: 'opus', effort: 'high' }), true);
  assert.equal(said.at(-1), "Effort of Opus: Claude Code's own → high");
});

// The check's report: a bot given Opus for this session only, then "effort high" for every
// session, was saved on Opus for every session, under a line that named the effort alone,
// and the session's own entry was removed.
test("for every session, a bot's change saves what he changed now: the model it has in this session only stays this session's, and the line says what every session gets", async t => {
  const f = setup(t);
  saveBot({ name: 'critic', vendor: 'claude', model: 'sonnet', effort: 'low', about: 'Reads for risk', instructions: 'Say what could break.' });
  const first = await f.controller.ask('Reply with the summary "one".').finished;
  f.controller.setBots(first.id, ['critic']);
  const bot = () => [getBot('critic').vendor, getBot('critic').model ?? null, getBot('critic').effort ?? null], here = () => readTask(f.controller.repo, first.id).botModels;
  f.controller.changeAgent(first.id, { bot: 'critic', to: { vendor: 'claude', model: 'opus', effort: 'low' } });
  assert.deepEqual([bot(), here()], [['claude', 'sonnet', 'low'], { critic: { vendor: 'claude', model: 'opus', effort: 'low' } }], 'Opus, for this session only');
  // Effort alone, for every session: the saved bot keeps Sonnet, and this session keeps Opus.
  f.controller.changeAgent(first.id, { bot: 'critic', every: true, to: { vendor: 'claude', model: 'opus', effort: 'high' } });
  assert.deepEqual(bot(), ['claude', 'sonnet', 'high'], 'the saved bot takes the effort, and keeps its model');
  assert.deepEqual(here(), { critic: { vendor: 'claude', model: 'opus', effort: 'high' } }, 'this session keeps the model it was given');
  // The model too, for every session: now the saved bot is as this session runs it, which keeps nothing of its own.
  f.controller.changeAgent(first.id, { bot: 'critic', every: true, to: { vendor: 'claude', model: 'opus', effort: 'high' } });
  assert.deepEqual([bot(), here()], [['claude', 'opus', 'high'], undefined], 'every session alone saves the bot as this session runs it');
  // What is saved, by what was changed: the effort, the model, both, or neither (the bot as it runs here).
  const saved = { vendor: 'claude', model: 'sonnet', effort: 'low' }, own = { vendor: 'codex', model: 'big-model', effort: 'high' };
  assert.deepEqual(everyBot(saved, { ...saved, model: 'opus' }, { vendor: 'claude', model: 'opus', effort: 'high' }), { vendor: 'claude', model: 'sonnet', effort: 'high' });
  assert.deepEqual(everyBot(saved, own, { ...own, model: 'quick-model' }), { vendor: 'codex', model: 'quick-model', effort: 'low' });
  assert.deepEqual(everyBot(saved, saved, { vendor: 'claude', model: 'opus', effort: null }), { vendor: 'claude', model: 'opus', effort: null });
  assert.deepEqual(everyBot(saved, own, own), own);
  // The line: what the saved bot gets, never the model this session alone has.
  const { agentDialogs } = await import('../lib/terminal-agent.mjs');
  const names = { opus: 'Opus', sonnet: 'Sonnet' }, said = [], lines = [];
  const pages = agentDialogs({ listDialog: async () => null, yes: async () => true, setMessage: text => said.push(text), colour: false, pickModel: async () => null, pickEffort: async () => undefined,
    nameOf: choice => names[choice.model] ?? choice.vendor, save: (agent, to, every, line) => { lines.push(line(false)); return { later: false, line: line(false) }; } });
  const critic = { who: '@critic', bot: 'critic', vendor: 'claude', model: 'opus', effort: 'low', saved };
  assert.equal(await pages.apply(critic, { vendor: 'claude', model: 'opus', effort: 'high' }, true), true);
  assert.equal(lines.at(-1), 'Effort of @critic: low → high, in every session');
  assert.equal(await pages.apply({ ...critic, effort: 'high', saved: { ...saved, effort: 'high' } }, { vendor: 'claude', model: 'opus', effort: 'high' }, true), true);
  assert.equal(lines.at(-1), 'Model of @critic: Sonnet → Opus, in every session');
  assert.equal(await pages.apply(critic, { vendor: 'claude', model: 'opus', effort: 'high' }), true);
  assert.equal(lines.at(-1), 'Effort of @critic: low → high', 'this session only, as before');
  // Saved so already, and run so here: nothing to do.
  assert.equal(await pages.apply({ ...critic, model: 'sonnet' }, { vendor: 'claude', model: 'sonnet', effort: 'low' }, true), false);
  assert.equal(said.at(-1), '@critic already runs on Sonnet, low.'); assert.equal(lines.length, 3);
});

// The check's report: the page and the chat's line read "Claude Code's own" where the clicked
// heading showed the level, and that same level picked read as a change.
test("an effort reads as its level where the vendor's own is known: the page and the line name it, and that same level picked is no change", async () => {
  const { agentDialogs, effortText } = await import('../lib/terminal-agent.mjs');
  const names = { opus: 'Opus', sonnet: 'Sonnet' }, said = [], lines = [], rows = [];
  const lead = { who: 'Opus', bot: null, vendor: 'claude', model: 'opus', effort: null, own: 'high' };
  assert.equal(effortText(lead), 'high'); assert.equal(effortText({ ...lead, own: null }), "Claude Code's own"); assert.equal(effortText({ ...lead, effort: 'low' }), 'low');
  const pages = agentDialogs({ listDialog: async (title, list) => { rows.push(list); return null; }, yes: async () => true, setMessage: text => said.push(text), colour: false, pickModel: async () => null, pickEffort: async () => undefined,
    nameOf: choice => names[choice.model] ?? choice.vendor, save: (agent, to, every, line) => { lines.push(line(false)); return { later: false, line: line(false) }; } });
  await pages.open(lead);
  assert.match(rows.at(-1)[1].replace(/\s+/g, ' '), /^Effort high$/, 'the page names the level');
  assert.equal(await pages.apply(lead, { vendor: 'claude', model: 'opus', effort: 'high' }), false);
  assert.equal(said.at(-1), 'This session already runs on Opus, high.'); assert.equal(lines.length, 0, 'nothing saved, no line');
  assert.equal(await pages.apply(lead, { vendor: 'claude', model: 'opus', effort: 'low' }), true);
  assert.equal(lines.at(-1), 'Effort of Opus: high → low');
  // Another model, with no effort chosen on either: the model alone is said.
  assert.equal(await pages.apply(lead, { vendor: 'claude', model: 'sonnet', effort: null }), true);
  assert.equal(lines.at(-1), 'Model of this session: Opus → Sonnet');
});

// The bot that oversees the sessions works in every session: its page has no For row, and a
// change to it is always the saved bot's. Every other bot keeps the row.
test('the Orchestrator\'s page has no For row: a change to it is for every session; another bot keeps the row', async () => {
  const { agentDialogs } = await import('../lib/terminal-agent.mjs');
  const rows = [], saved = [];
  const pages = agentDialogs({ listDialog: async (title, list) => { rows.push(list.map(item => String(item).replace(/\s+/g, ' ').trim())); return null; }, yes: async () => true, setMessage: () => {}, colour: false, pickModel: async () => null, pickEffort: async () => undefined,
    nameOf: choice => choice.model ?? choice.vendor, save: (agent, to, every, line) => { saved.push([agent.bot, every]); return { later: false, line: line(false) }; } });
  const orchestrator = { who: '@orchestrator', bot: 'orchestrator', oversees: true, vendor: 'claude', model: 'opus', effort: null, saved: { vendor: 'claude', model: 'opus', effort: null } };
  await pages.open(orchestrator);
  assert.equal(rows.at(-1).some(text => /^For\b/.test(text)), false, 'no For row');
  assert.equal(await pages.apply(orchestrator, { vendor: 'claude', model: 'sonnet', effort: null }, false), true);
  assert.deepEqual(saved.at(-1), ['orchestrator', true], 'saved with the bot, whatever was asked');
  const reviewer = { ...orchestrator, who: '@reviewer', bot: 'reviewer', oversees: false };
  await pages.open(reviewer);
  assert.equal(rows.at(-1).some(text => /^For this session$/.test(text)), true, 'another bot keeps it');
  assert.equal(await pages.apply(reviewer, { vendor: 'claude', model: 'sonnet', effort: null }, false), true);
  assert.deepEqual(saved.at(-1), ['reviewer', false]);
});
