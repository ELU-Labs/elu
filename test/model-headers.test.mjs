import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, autoApprove, temp } from './helpers.mjs';
import { claudeId, entryTag, modelTag, shortEffort, shortModel } from '../lib/models.mjs';
import { claudeOwnEffort, runEffort } from '../lib/bot-models.mjs';
import { catalogEfforts, catalogRow, fileEfforts, forgetCatalogs, installedEfforts } from '../lib/claude-catalog.mjs';
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

// A model catalog as Claude Code bundles it (2.1.323, trimmed): rows with nested objects and
// lists, braces and quotes inside texts, and a default_effort nested in another object.
const ROWS = [
  '{id:"claude-opus-5-5",family:"opus",display_name:"Opus 5.5 {beta}",provider_ids:{firstParty:"claude-opus-5-5",note:"a \\"quoted\\" } brace"},context:{window:1e6,native_1m:!0},capabilities:["effort","max_effort"],default_effort:"medium",effort_cost_index:{low:0.48,medium:0.66,high:1},image_limits:{maxWidth:2576},advisor_rank:7}',
  '{id:"claude-fable-5-2",family:"fable",capabilities:["effort"],runtime:{default_effort:"max"},default_effort:"medium",image_limits:{maxWidth:2576}}',
  '{id:"claude-sonnet-5-5",family:"sonnet",default_effort:"medium"}',
  '{id:"claude-haiku-5-5",family:"haiku",default_effort:"medium"}',
  '{id:"claude-fable-5-1",family:"fable",default_effort:"high"}',
  '{id:"claude-3-5-sonnet",family:"sonnet",capabilities:[]}',
];
const CATALOG = `models:[${ROWS.join(',')}],aliases:{opus:{default:"claude-opus-5-5"}}`;
// A native program: bytes that are not text around the catalog, the way a compiled build carries its source.
const native = (text, junk = 4096) => Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, ...Array(junk).fill(0x90)]), Buffer.from(text, 'latin1'), Buffer.from([0, 0xff, 0x80, 0x7b])]);
// A program that writes a mark when it is run, which a read must never do.
function program(t, body, name = 'claude') {
  const dir = temp(t), file = path.join(dir, name), mark = path.join(dir, 'was-run');
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`#!/bin/sh\ntouch '${mark}'\nexit 0\n`), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')]), { mode: 0o755 });
  return { dir, file, mark, cache: path.join(dir, 'personal', 'claude-catalog.json') };
}

test('a Claude Code catalog gives each model its own default effort, from a native build or a JavaScript one', () => {
  const want = { 'claude-opus-5-5': 'medium', 'claude-fable-5-2': 'medium', 'claude-sonnet-5-5': 'medium', 'claude-haiku-5-5': 'medium', 'claude-fable-5-1': 'high' };
  assert.deepEqual(catalogEfforts(native(CATALOG)), want, 'a nested default_effort and a brace inside a text change nothing');
  assert.deepEqual(catalogEfforts(`#!/usr/bin/env node\nvar Q=${CATALOG};function f(){}`), want);
  assert.deepEqual(catalogEfforts('{"models":[{"id":"claude-opus-5-5","family":"opus","default_effort":"high"}]}'), { 'claude-opus-5-5': 'high' }, 'the catalog as JSON');
  assert.deepEqual(catalogRow(ROWS[1]), { id: 'claude-fable-5-2', effort: 'medium' });
  assert.deepEqual(catalogRow(ROWS[5]), { id: 'claude-3-5-sonnet', effort: null }, 'a model the catalog gives no effort');
  // The same model twice with one effort is that effort; with two, neither.
  assert.deepEqual(catalogEfforts(`${ROWS[2]} ${ROWS[2]} {id:"claude-haiku-5-5",default_effort:"medium"} {id:"claude-haiku-5-5",default_effort:"high"}`), { 'claude-sonnet-5-5': 'medium' });
});

test('a malformed or missing catalog gives nothing, never a made-up effort', () => {
  for (const text of [
    '', 'no catalog here', native(''),
    '{id:"claude-opus-5-5",family:"opus",default_effort:"medium"', // never closes
    '{id:"claude-opus-5-5",context:{window:1e6,default_effort:"medium"}', // the brace that would close it is missing
    '{id:"claude-opus-5-5",default_effort:"turbo"}', '{id:"claude-opus-5-5",default_effort:Ze}', '{id:"claude-opus-5-5",default_effort:"medium",default_effort:"high"}',
    '{id:"claude-Opus 5",default_effort:"medium"}', '{id:"gpt-6",default_effort:"medium"}', '{id:"claude-opus-5-5",name:"x\\",default_effort:"medium"}',
    '{id:"claude-opus-5-5",default_effort:"medium"]', `{id:"claude-opus-5-5",note:"${'x'.repeat(70 * 1024)}",default_effort:"medium"}`,
  ]) assert.deepEqual(catalogEfforts(text), {}, String(text).slice(0, 80));
  assert.deepEqual(catalogEfforts(`{id:"claude-opus-5-5",default_effort:"medium" ${ROWS[3]}`), { 'claude-haiku-5-5': 'medium' }, 'a row that never closes is left out; a whole one inside it still counts');
  assert.deepEqual(catalogEfforts(`{id:"claude-opus-5-5",default_effort:"medium"}} ${ROWS[3]}`), { 'claude-opus-5-5': 'medium', 'claude-haiku-5-5': 'medium' });
});

test('a large program is read a piece at a time; a row across two pieces is read once', t => {
  const file = path.join(temp(t), 'claude');
  fs.writeFileSync(file, Buffer.concat([Buffer.alloc(8 * 1024 * 1024 - 40, 0x90), Buffer.from(ROWS[0], 'latin1'), Buffer.alloc(1024, 0x90), Buffer.from(ROWS[4], 'latin1')]));
  assert.deepEqual(fileEfforts(file), { 'claude-opus-5-5': 'medium', 'claude-fable-5-1': 'high' });
});

test('the installed program is read once and kept by its path, size and time, in memory and in the personal folder; it is never run', t => {
  forgetCatalogs(); t.after(forgetCatalogs);
  const p = program(t, native(CATALOG)), link = path.join(p.dir, 'on-path');
  fs.symlinkSync(p.file, link);
  assert.equal(installedEfforts(link, { cache: p.cache })['claude-opus-5-5'], 'medium');
  assert.equal(fs.existsSync(p.mark), false, 'the program was only read');
  const kept = JSON.parse(fs.readFileSync(p.cache, 'utf8'));
  assert.deepEqual(kept.programs.map(row => [row.file, row.size, row.efforts['claude-fable-5-2']]), [[p.file, fs.statSync(p.file).size, 'medium']], 'kept by the real path');
  // Another app start reads the kept answer, without reading the program again.
  kept.programs[0].efforts['claude-opus-5-5'] = 'high'; fs.writeFileSync(p.cache, JSON.stringify(kept));
  assert.equal(installedEfforts(link, { cache: p.cache })['claude-opus-5-5'], 'medium', 'this app keeps what it read');
  forgetCatalogs();
  assert.equal(installedEfforts(link, { cache: p.cache })['claude-opus-5-5'], 'high', 'a new app start uses the file');
  // An update changes the program: it is read again, and the new catalog decides.
  fs.writeFileSync(p.file, native(CATALOG.replace('default_effort:"medium",effort_cost_index', 'default_effort:"xhigh",effort_cost_index')));
  fs.utimesSync(p.file, new Date(), new Date(Date.now() + 5000));
  assert.equal(installedEfforts(link, { cache: p.cache })['claude-opus-5-5'], 'xhigh');
  assert.equal(JSON.parse(fs.readFileSync(p.cache, 'utf8')).programs.length, 1, 'the older reading of the same path is replaced');
  // A kept answer that is not valid is not trusted.
  forgetCatalogs(); fs.writeFileSync(p.cache, JSON.stringify({ version: 1, programs: [{ file: p.file, size: fs.statSync(p.file).size, mtimeMs: fs.statSync(p.file).mtimeMs, efforts: { 'claude-opus-5-5': 'turbo', 'not a model': 'high' } }] }));
  assert.deepEqual(installedEfforts(link, { cache: p.cache }), {});
  forgetCatalogs(); fs.writeFileSync(p.cache, '{not json');
  assert.equal(installedEfforts(link, { cache: p.cache })['claude-opus-5-5'], 'xhigh', 'a broken file is read past');
  assert.deepEqual(installedEfforts(path.join(p.dir, 'missing'), { cache: p.cache }), {});
  assert.deepEqual(installedEfforts(p.dir, { cache: p.cache }), {}, 'a folder is not a program');
  assert.equal(fs.existsSync(p.mark), false);
});

test('a run\'s Claude effort comes from its own program\'s catalog for any release; the table only when none is read', t => {
  forgetCatalogs(); t.after(forgetCatalogs);
  const env = { XDG_CONFIG_HOME: path.join(temp(t), 'personal') }, previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME; t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  const read = program(t, native(CATALOG)).file, none = program(t, 'echo no catalog').file, broken = program(t, '{id:"claude-opus-5-5",default_effort:"medium"').file;
  assert.equal(runEffort('claude', { model: 'claude-opus-5-5', release: '2.1.400', bin: read }), 'medium', 'a release the table does not know');
  assert.equal(runEffort('claude', { model: 'us.anthropic.claude-fable-5-2-v1:0', release: '2.1.319', bin: read }), 'medium', 'the catalog, where the table has no Fable 5.2 for 2.1.319');
  assert.equal(runEffort('claude', { model: 'claude-opus-4-8', release: '2.1.322', bin: read }), null, 'a catalog that gives no effort for a model is not overruled by the table');
  assert.equal(runEffort('claude', { model: 'claude-3-5-sonnet', bin: read }), null);
  assert.equal(runEffort('claude', { effort: 'low', model: 'claude-opus-5-5', bin: read }), 'low', 'the bot\'s own setting first');
  assert.equal(runEffort('claude', { model: 'opus', bin: read }), null, 'an alias is not a model id');
  for (const bin of [none, broken, path.join(path.dirname(none), 'missing'), null]) {
    assert.equal(runEffort('claude', { model: 'claude-opus-5-5', release: '2.1.319', bin }), 'medium', `table: ${bin}`);
    assert.equal(runEffort('claude', { model: 'claude-fable-5-2', release: '2.1.319', bin }), null, 'Fable 5.2 is not in 2.1.319');
    assert.equal(runEffort('claude', { model: 'claude-fable-5-2', release: '2.1.322', bin }), 'medium');
    assert.equal(runEffort('claude', { model: 'claude-opus-5-5', release: '2.1.400', bin }), null, 'neither knows: no effort');
  }
  assert.deepEqual(fs.readdirSync(env.XDG_CONFIG_HOME), ['elu-code']);
  assert.deepEqual(fs.readdirSync(path.join(env.XDG_CONFIG_HOME, 'elu-code')), ['claude-catalog.json'], 'the cache is ELU\'s own file');
});

test('a Claude Code whose catalog cannot be read falls back to the table: on 2.1.319 Fable 5.2 has no effort', async t => {
  const f = setup(t, { models: { fable: 'claude-fable-5-2', opus: 'claude-opus-5-5' } });
  const claude = path.join(f.parent, 'bin', 'claude'), text = fs.readFileSync(claude, 'utf8');
  fs.writeFileSync(claude, text.replace(/^const CATALOG=.*$/m, 'const CATALOG=null;'));
  assert.notEqual(fs.readFileSync(claude, 'utf8'), text);
  saveBot({ name: 'lead', vendor: 'claude', model: 'fable', instructions: 'Lead the work.' });
  const solo = await f.controller.ask('Where is coupon normalization?').finished;
  assert.deepEqual([solo.runs.at(-1).model, solo.runs.at(-1).effort], ['claude-opus-5-5', 'medium']);
  const task = await f.controller.ask('What would you change?', solo.id, { bot: 'lead' }).finished;
  const reply = task.messages.at(-1);
  assert.deepEqual([reply.bot, reply.model, reply.effort ?? null], ['lead', 'claude-fable-5-2', null]);
  assert.equal(header(conversationEntries(f.repo, task).find(entry => entry.bot)), '@lead (fable 5.2)  4:37 PM');
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
  // The fake Claude Code is 2.1.319 and carries a catalog (test/fakes/claude.mjs); a new session
  // runs on opus, which it reports as claude-opus-5-5.
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
