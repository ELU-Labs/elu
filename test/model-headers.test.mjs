import test from 'node:test';
import assert from 'node:assert/strict';
import { project, fakeClis, autoApprove } from './helpers.mjs';
import { claudeId, entryTag, modelTag, shortEffort, shortModel } from '../lib/models.mjs';
import { claudeOwnEffort, runEffort } from '../lib/bot-models.mjs';
import { chatBlock, tagged, visible } from '../lib/terminal-visuals.mjs';
import { saveBot } from '../lib/bots.mjs';
import { ProjectController, conversationEntries } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';

// Each chat entry a model wrote names that model and its effort in parentheses after the
// name in its header: "@lead (fable 5.2 med)". The model is the one that really ran.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function setup(t, options = {}) {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer', ...options });
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  return { ...p, controller, repo: controller.repo, clis: next => fakeClis(p.parent, { mode: 'answer', ...next }) };
}
// The header the chat shows for an entry, as the terminal builds it, at this width.
const header = (entry, width = 80, after = '') => visible(chatBlock({ ...tagged(entry.role, entryTag(entry), after), time: '4:37 PM', text: 'x', tone: 'orange', width, colour: false })).split('\n')[0];

test('model names and efforts read short: Claude ids by family and version, other vendors as reported', () => {
  for (const id of ['claude-opus-5-5', 'claude-opus-5-5-20261001', 'claude-opus-5-5[1m]', 'us.anthropic.claude-opus-5-5-v1:0', 'anthropic.claude-opus-5-5', 'claude-opus-5-5@20261001']) {
    assert.equal(claudeId(id), 'claude-opus-5-5', id); assert.equal(shortModel(id), 'opus 5.5', id);
  }
  assert.deepEqual(['claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-3-5-sonnet-20241022'].map(shortModel), ['fable 5.2', 'sonnet 5.5', 'haiku 5.5', 'sonnet 3.5']);
  assert.equal(shortModel('gpt-6.1-sol'), 'gpt-6.1-sol'); assert.equal(shortModel('gemini-3-pro'), 'gemini-3-pro', 'another vendor\'s name as it reported it');
  assert.equal(shortModel('fable'), 'fable', 'a name a bot was saved with');
  assert.equal(claudeId('gpt-6.1-sol'), null); assert.equal(shortModel(null), null);
  assert.deepEqual(['low', 'medium', 'high', 'xhigh', 'max', 'minimal', null].map(shortEffort), ['low', 'med', 'high', 'xhigh', 'max', 'minimal', null]);
  assert.equal(modelTag({ model: 'claude-fable-5-2', effort: 'medium' }, '@lead'), 'fable 5.2 med');
  assert.equal(modelTag({ model: 'claude-opus-5-5', effort: 'medium' }, 'Opus 5.5'), 'med', 'an agent named by its model says only the effort');
  assert.equal(modelTag({ model: 'claude-opus-5-5' }, 'Opus 5.5'), null);
  assert.equal(modelTag({ model: 'claude-opus-4-6' }, '@reviewer'), 'opus 4.6', 'an effort that is not known is left out');
  assert.equal(modelTag({}, '@reviewer'), null);
});

test('an effort comes from the run, else the vendor\'s own default where it is known, never made up', () => {
  assert.equal(runEffort('claude', { effort: 'xhigh', model: 'claude-opus-5-5', release: '2.1.322' }), 'xhigh', 'the bot\'s own setting first');
  assert.equal(runEffort('claude', { model: 'claude-opus-5-5', release: '2.1.322' }), 'medium');
  assert.equal(runEffort('claude', { model: 'us.anthropic.claude-fable-5-2-v1:0', release: '2.1.322' }), 'medium');
  assert.equal(runEffort('claude', { model: 'claude-fable-5-1[1m]', release: '2.1.319' }), 'high');
  assert.equal(claudeOwnEffort('claude-opus-5-5', '2.1.400'), null, 'a release whose catalog was not read');
  assert.equal(claudeOwnEffort('claude-opus-4-6', '2.1.322'), null, 'a model the catalog gives no effort');
  assert.equal(claudeOwnEffort('opus', '2.1.322'), null, 'an alias is not a model id');
  assert.equal(runEffort('agy', { model: 'gemini-3-pro' }), null); assert.equal(runEffort('grok', {}), null);
  assert.equal(runEffort('codex', { model: null }), null);
});

test('a header keeps one row on a narrow pane: the parentheses go before the name or the time is cut', () => {
  const lead = { role: '@lead', bot: 'lead', model: 'claude-fable-5-2', effort: 'medium' };
  assert.equal(header(lead, 80, ' on @ali-devbox'), '@lead (fable 5.2 med) on @ali-devbox  4:37 PM');
  assert.equal(header(lead, 36, ' on @ali-devbox'), '@lead on @ali-devbox  4:37 PM');
  assert.equal(header(lead, 30), '@lead (fable 5.2 med)  4:37 PM', 'exactly the width still fits');
  assert.equal(header(lead, 29), '@lead  4:37 PM');
  assert.equal(header({ role: 'You → @lead' }, 80), 'You → @lead  4:37 PM', 'the owner\'s own message is unchanged');
  assert.equal(header({ role: 'Shell', shell: true, model: 'claude-opus-5-5' }, 80), 'Shell  4:37 PM', 'only an entry a model wrote has a model');
});

test('the agent of a solo session, a bot, and a bot that fell back each name the model that ran and its effort', async t => {
  const f = setup(t, { models: { fable: 'claude-fable-5-2', opus: 'claude-opus-5-5' } });
  saveBot({ name: 'lead', vendor: 'claude', model: 'fable', instructions: 'Lead the work.' });
  saveBot({ name: 'scout', vendor: 'claude', model: 'opus', effort: 'high', instructions: 'Look around.' });
  // The fake Claude Code is 2.1.319; a new session runs on opus, which it reports as claude-opus-5-5.
  const solo = await f.controller.ask('Where is coupon normalization?').finished;
  assert.deepEqual([solo.runs.at(-1).model, solo.runs.at(-1).effort], ['claude-opus-5-5', 'medium']);
  let entries = conversationEntries(f.repo, readTask(f.repo, solo.id));
  assert.equal(header(entries.find(entry => entry.lead)), 'Opus 5.5 (med)  4:37 PM');
  await f.controller.ask('What would you change?', solo.id, { bot: 'lead' }).finished;
  await f.controller.ask('Anything risky?', solo.id, { bot: 'scout' }).finished;
  let task = readTask(f.repo, solo.id);
  assert.deepEqual(task.messages.filter(row => row.bot).map(row => [row.bot, row.model, row.effort]), [['lead', 'claude-fable-5-2', 'medium'], ['scout', 'claude-opus-5-5', 'high']]);
  entries = conversationEntries(f.repo, task);
  assert.deepEqual(entries.filter(entry => entry.bot).map(entry => header(entry)), ['@lead (fable 5.2 med)  4:37 PM', '@scout (opus 5.5 high)  4:37 PM']);
  assert.deepEqual(entries.filter(entry => !entry.bot && !entry.lead).map(entry => header(entry)).slice(-2), ['You → @lead  4:37 PM', 'You → @scout  4:37 PM']);
  // Fable has no usage credits now: @lead runs once more on the session's model, and the header
  // names that model, never the one @lead was saved with.
  const first = await f.controller.ask('Where is the cart total?').finished;
  f.clis({ models: { fable: 'claude-fable-5-2', opus: 'claude-opus-5-5' }, noCredits: 'fable' });
  task = await f.controller.ask('What would you change?', first.id, { bot: 'lead' }).finished;
  const reply = task.messages.at(-1);
  assert.deepEqual([reply.bot, reply.model, reply.effort], ['lead', 'claude-opus-5-5', 'medium']);
  assert.equal(header(conversationEntries(f.repo, task).at(-1), 80, ' on @ali-devbox'), '@lead (opus 5.5 med) on @ali-devbox  4:37 PM');
});

test('a model whose effort is not known shows only the model; a Codex bot\'s effort comes from its model list', async t => {
  const f = setup(t, { models: [{ slug: 'big-model', display_name: 'Big Model', description: 'Frontier model.', visibility: 'list', priority: 1, default_reasoning_level: 'medium' }] });
  saveBot({ name: 'critic', vendor: 'codex', model: 'big-model', instructions: 'Look for edge cases.' });
  saveBot({ name: 'old', vendor: 'claude', model: 'claude-opus-4-6', instructions: 'Look.' });
  const first = await f.controller.ask('Where is coupon normalization?').finished;
  await f.controller.ask('Edge cases?', first.id, { bot: 'critic' }).finished;
  f.clis({ models: { 'claude-opus-4-6': 'claude-opus-4-6' } });
  const task = await f.controller.ask('And you?', first.id, { bot: 'old' }).finished;
  const bots = conversationEntries(f.repo, task).filter(entry => entry.bot);
  assert.deepEqual(bots.map(entry => header(entry)), ['@critic (big-model med)  4:37 PM', '@old (opus 4.6)  4:37 PM']);
});

test('a session saved before model and effort were kept shows its headers as before', async t => {
  const f = setup(t);
  const first = await f.controller.ask('Where is coupon normalization?').finished;
  const task = readTask(f.repo, first.id);
  for (const run of task.runs) { delete run.effort; delete run.model; delete run.asked; }
  task.messages.push({ at: new Date().toISOString(), text: 'Anything risky?', to: '@scout' }, { at: new Date().toISOString(), text: 'Nothing.', from: '@scout', bot: 'scout' });
  saveTask(f.repo, task);
  const entries = conversationEntries(f.repo, readTask(f.repo, first.id));
  assert.deepEqual(entries.filter(entry => entry.lead || entry.bot).map(entry => [entry.model ?? null, entry.effort ?? null]), [['claude-fable-5-1', null], [null, null]], 'the lead\'s model still comes from its log');
  assert.deepEqual(entries.filter(entry => entry.lead || entry.bot).map(entry => header(entry)), ['Fable 5.1  4:37 PM', '@scout  4:37 PM']);
});

test('a session on another computer names the model and effort of each entry with that computer; an older one there names none', () => {
  const glue = remoteGlue({ facade: { mineRows: () => [], remoteSessions: () => [] }, peerRead: () => null, peerCommand: async () => ({}), chatMessage: ({ title, narrow, text }, width) => `${narrow && title.length > width ? narrow : title}: ${text}`, ink: text => text, colour: false });
  const at = new Date().toISOString();
  const row = { kind: 'remote', id: 'r1', machine: 'ali-devbox', key: 'remote:x', label: 'Session', remote: { id: 'r1', machine: 'd'.repeat(64), state: 'answered', title: 'Remote', createdAt: at, entries: [
    { role: 'You → @lead', at, text: 'Plan it' },
    { role: '@lead', bot: 'lead', at, text: 'Planned.', model: 'claude-fable-5-2', effort: 'medium' },
    { role: 'Opus 5.5', lead: true, at, text: 'Done.', model: 'claude-opus-5-5', effort: 'medium' },
    { role: '@reviewer', bot: 'reviewer', at, text: 'Looks right.' },
  ], steps: [], approvals: [] } };
  const said = glue.view(row, 80);
  assert.match(said, /@lead \(fable 5\.2 med\) on @ali-devbox: Planned\.[\s\S]*Opus 5\.5 \(med\) on @ali-devbox: Done\.[\s\S]*@reviewer on @ali-devbox: Looks right\./);
  assert.match(glue.view(row, 20), /@lead on @ali-devbox: Planned\./, 'a narrow pane drops the parentheses first');
});
