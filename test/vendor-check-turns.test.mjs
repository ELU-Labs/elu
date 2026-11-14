import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis } from './helpers.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { SEND_AGAIN, createConversation } from '../lib/runner.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { approveTask, proposeTask } from '../lib/plan.mjs';
import { saveBot } from '../lib/bots.mjs';
import { conformanceState } from '../lib/conformance.mjs';

// Turns the owner did not type, on a vendor that is installed, signed in and was never
// checked on this machine: a schedule's, a shadow's and a Task's work. Each starts the
// one-time check the way a typed message does and then runs. And a Full access session,
// where nothing is refused: a bot that only answers and a shadow run on a vendor whose
// check did not pass, and the chat says once what was not proven. A session's model runs on
// Grok Build here, and a bot on Antigravity CLI: bots do not run on Grok Build.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// lead: the vendor the session's model runs on. Claude Code is installed only when it leads.
// agy: what the stand-in Antigravity CLI is told (ignoreDenies: it writes in a read-only turn).
function machine(t, { lead = 'grok', mode = 'answer', agy = undefined } = {}) {
  const p = project(t), fake = fakeClis(p.parent, { mode }), config = path.join(fake.dir, 'fake.json');
  if (agy) fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), agy }));
  // A vendor that is not installed: a wrapper that exits 127 stands wherever one would be found on PATH.
  for (const other of ['claude', 'codex'].filter(vendor => vendor !== lead)) fs.writeFileSync(path.join(fake.dir, other), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  fs.mkdirSync(path.join(p.parent, '.grok')); fs.writeFileSync(path.join(p.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
  const controller = new ProjectController(projectFolder(p.root)); Object.assign(controller.draftConfig.roles.lead, { vendor: lead, maxCostUsd: null });
  const calls = () => fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const send = async (text, id, options) => controller.ask(text, id, options).finished;
  return { ...p, fake, controller, calls, send, checks: () => calls().filter(call => call.vendor === 'grok' && call.args.includes('inspect')).length };
}
// The chat's lines from ELU about Antigravity CLI: the check's first line, then its result.
const AGY_FIRST = 'One-time check of Antigravity CLI on this machine first: about seven short turns on it, a few minutes.';
const AGY_PASSED = /^Antigravity CLI 1\.5\.4 passed its check on this machine\.( It can't ask live here: blocked actions are reported\.)?$/;
const AGY_NOT_PROVEN = 'Not proven: a read-only turn writes no file \\(locked run: wrote [^)]+\\), and 2 more\\.';
const AGY_IN_FULL = new RegExp(`^Antigravity CLI did not pass its check on this machine\\. ${AGY_NOT_PROVEN} Full access runs it anyway; Read only, Ask for approval and Approve for me stay off\\.$`);
const AGY_REFUSAL = new RegExp(`^@critic can't start\\. Antigravity CLI did not pass its check on this machine, so it runs in Full access only here\\. ${AGY_NOT_PROVEN} Switch this session to Full access to use it; c on its line in the Usage tab runs the check again\\.$`);
const UNCHECKED_AGY = /Antigravity CLI has not been checked on this machine yet/;
function saidAgy(task, result) {
  const lines = said(task); assert.equal(lines.length, 2, JSON.stringify(lines)); assert.equal(lines[0], AGY_FIRST); assert.match(lines[1], result);
}
const said = task => (task.messages ?? []).filter(row => row.from === 'ELU').map(row => row.text);
const why = task => task.error?.message ?? JSON.stringify(task.error);
const FIRST = 'One-time check of Grok Build on this machine first: about seven short turns on it, a few minutes.';
const PASSED = 'Grok Build 1.0.77 passed its check on this machine.';
const UNCHECKED = /Grok Build has not been checked on this machine yet/;
const NOT_PROVEN = 'Not proven: a read-only turn writes no file (locked run wrote a file: created.txt), and 2 more.';
const IN_FULL = `Grok Build did not pass its check on this machine. ${NOT_PROVEN} Full access runs it anyway; Read only, Ask for approval and Approve for me stay off.`;
const REFUSAL = `Grok Build did not pass its check on this machine, so it runs in Full access only here. ${NOT_PROVEN} Switch this session to Full access to use it; c on its line in the Usage tab runs the check again.`;

test('a /schedule job\'s turn on a Grok Build that was never checked runs the one-time check first and then answers', { timeout: 300000 }, async t => {
  const f = machine(t);
  // Before: refused with "Grok Build has not been checked on this machine yet. Your first message to it runs the check."
  const task = await f.send('Reply done with the summary "on time".', null, { timed: true, permissions: 'auto' });
  assert.equal(task.state, 'answered', why(task)); assert.equal(task.result.summary, 'on time'); assert.equal(task.runs[0].vendor, 'grok');
  assert.deepEqual(said(task), [FIRST, PASSED]); assert.equal(f.checks(), 1);
});

test('a bot\'s scheduled turn on an Antigravity CLI that was never checked runs the one-time check first and then runs', { timeout: 300000 }, async t => {
  const f = machine(t, { lead: 'claude' });
  saveBot({ name: 'nightly', vendor: 'agy', instructions: 'Check the nightly build.', schedule: 'every 1h' });
  const chat = await f.send('Reply done with the summary "hello".', null, { bots: ['nightly'], permissions: 'auto' });
  assert.equal(chat.state, 'answered', why(chat)); assert.deepEqual(said(chat), [], 'Claude Code needs no check, and nothing ran on Antigravity CLI yet');
  // Before: "@nightly can't start. Antigravity CLI has not been checked on this machine yet. Your first message to it runs the check."
  const run = await f.controller.ask('Do your scheduled work.', chat.id, { bot: 'nightly', scheduled: true }).finished;
  assert.doesNotMatch(why(run), UNCHECKED_AGY);
  assert.ok(run.runs.some(row => row.role === 'bot:nightly' && row.vendor === 'agy'), JSON.stringify(run.runs.map(row => [row.role, row.vendor])));
  saidAgy(run, AGY_PASSED);
});

test('a shadow\'s comment on an Antigravity CLI that was never checked runs the one-time check first and then speaks', { timeout: 300000 }, async t => {
  const f = machine(t, { lead: 'claude' });
  saveBot({ name: 'echo', vendor: 'agy', shadow: true, instructions: 'Say what you would do differently.' });
  // Before: the shadow said "Not shadowing here. Antigravity CLI has not been checked on this machine yet. Your first message to it runs the check."
  const task = await f.send('Reply done with the summary "hello".', null, { bots: ['echo'], permissions: 'auto' });
  assert.equal(task.state, 'answered', why(task));
  const shadow = task.messages.filter(row => row.bot === 'echo' && row.shadow);
  assert.ok(shadow.length && shadow.every(row => !UNCHECKED_AGY.test(row.text)), JSON.stringify(shadow.map(row => row.text)));
  assert.ok(shadow.some(row => !row.quiet), `the shadow spoke: ${JSON.stringify(shadow.map(row => row.text))}`);
  assert.ok(task.runs.some(row => row.role === 'bot:echo' && row.vendor === 'agy'));
  saidAgy(task, AGY_PASSED);
});

test('the work of a Task the owner approved, on a Grok Build that was never checked, runs the one-time check first and then starts', { timeout: 300000 }, async t => {
  const f = machine(t), repo = f.controller.repo;
  // A session whose Task waits for the owner's y, on a Grok Build with no record here (a new
  // release proves itself again): nothing was sent to Grok Build before the y.
  const session = createConversation(repo, f.controller.draftConfig, 'Uppercase coupon codes', { permissions: 'auto' });
  saveTask(repo, { ...readTask(repo, session.id), state: 'answered' });
  proposeTask(repo, session.id, { title: 'Uppercase coupons', description: 'Make normalize return the code in upper case.', goal: 'Codes compare equal whatever their case.', objectives: ['normalize returns upper case'], priority: 'medium', severity: 'low' }, { edit: { intent: 'edit', repository: null, bot: null, request: 'Uppercase coupon codes', started: false } });
  approveTask(repo, session.id);
  assert.equal(conformanceState('grok'), null);
  // Before: the y stopped on "Grok Build has not been checked on this machine yet. Your first message to it runs the check."
  const done = await f.controller.ask('Approved the Task: Uppercase coupons', session.id, { approved: true }).finished.catch(error => ({ error: { message: error.message }, runs: [], messages: readTask(repo, session.id).messages }));
  assert.doesNotMatch(why(done), UNCHECKED);
  assert.ok(done.runs.some(row => row.vendor === 'grok'), `the work started on Grok Build: ${why(done)}`);
  assert.deepEqual(said(done).slice(0, 2), [FIRST, PASSED]); assert.equal(f.checks(), 1);
});

test('in a Full access session a bot that only answers and a shadow run on an Antigravity CLI whose check did not pass, and the chat says once what was not proven', { timeout: 300000 }, async t => {
  // This agy writes in a read-only turn: three required steps are not proven, and no second check can prove them.
  const f = machine(t, { lead: 'claude', agy: { ignoreDenies: true } });
  saveBot({ name: 'critic', vendor: 'agy', instructions: 'Say what is wrong.' });
  saveBot({ name: 'echo', vendor: 'agy', shadow: true, instructions: 'Say what you would do differently.' });
  const full = await f.send('Reply done with the summary "in full".', null, { permissions: 'full', bots: ['echo'] });
  assert.equal(full.state, 'answered', why(full)); saidAgy(full, AGY_IN_FULL);
  // Before: "Not shadowing here. Antigravity CLI did not pass its check on this machine, so it runs in Full access only here. ... Switch this session to Full access to use it; ..."
  const shadow = full.messages.filter(row => row.bot === 'echo' && row.shadow);
  assert.ok(shadow.some(row => !row.quiet), JSON.stringify(shadow.map(row => row.text)));
  // Before: "@critic can't start. Antigravity CLI did not pass its check on this machine, so it runs in Full access only here. ... Switch this session to Full access to use it; ..."
  const answer = await f.send('Reply done with the summary "from the bot".', full.id, { bot: 'critic' });
  assert.equal(answer.state, 'answered', why(answer));
  const turns = answer.runs.filter(row => row.role === 'bot:critic');
  assert.ok(turns.length && turns.every(row => row.vendor === 'agy' && row.permissions === 'full'), JSON.stringify(answer.runs.map(row => [row.role, row.vendor, row.permissions])));
  saidAgy(answer, AGY_IN_FULL);
  // Below Full access the same bot is still refused, with what to do.
  const lower = await f.send('Reply done with the summary "below".', null, { permissions: 'auto' });
  await assert.rejects(f.send('Reply done.', lower.id, { bot: 'critic' }), error => AGY_REFUSAL.test(error.message) || assert.fail(error.message));
});

test('a session a failed check stopped says the check\'s result once when it is switched to Full access, and then runs', { timeout: 300000 }, async t => {
  const f = machine(t, { mode: 'leaky' }), repo = f.controller.repo;
  await assert.rejects(f.send('Is the coupon code trimmed?', null, { permissions: 'ask' }), error => error.message === REFUSAL);
  const id = f.controller.snapshot().tasks[0].id;
  assert.deepEqual(said(readTask(repo, id)), [FIRST]);
  // Before: the switch said nothing, and neither did the message after it.
  assert.equal(readTask(repo, id).error.message, REFUSAL);
  f.controller.setPermissions(id, 'full');
  assert.deepEqual(said(readTask(repo, id)), [FIRST, IN_FULL]);
  // The refusal told him to switch to Full access. He has, so it no longer says that.
  assert.equal(readTask(repo, id).error.message, SEND_AGAIN);
  const task = await f.send('Reply done with the summary "now in full".', id);
  assert.equal(task.state, 'answered', why(task)); assert.equal(task.result.summary, 'now in full'); assert.equal(task.runs.at(-1).permissions, 'full');
  assert.deepEqual(said(task), [FIRST, IN_FULL], 'said once'); assert.equal(f.checks(), 1);
  // Switched away and back: nothing is said a second time.
  f.controller.setPermissions(id, 'auto'); f.controller.setPermissions(id, 'full');
  assert.deepEqual(said(readTask(repo, id)), [FIRST, IN_FULL]);
});
