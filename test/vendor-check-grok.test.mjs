import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis } from './helpers.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { answerLoads, checkResult, conformanceState, loadsList } from '../lib/conformance.mjs';
import { answerApproval, pendingApprovals } from '../lib/approvals.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';

// A computer where Grok Build is the only vendor installed, signed in, and never checked: the
// owner's messages go through the runner as the app sends them. The stand-in grok answers
// `inspect --json` in the shape the real 1.0.77 prints (test/fakes/grok.mjs): a row for
// every Cursor, Claude and Codex switch on every computer, on or off.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function onlyGrok(t, { grok = undefined, mode = 'answer' } = {}) {
  const p = project(t), fake = fakeClis(p.parent, { mode }), config = path.join(fake.dir, 'fake.json');
  // No other vendor is installed: a wrapper that exits 127 stands wherever one would be found on PATH.
  for (const other of ['claude', 'codex', 'agy']) fs.writeFileSync(path.join(fake.dir, other), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  const set = value => fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), grok: value }));
  set(grok);
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  fs.mkdirSync(path.join(p.parent, '.grok')); fs.writeFileSync(path.join(p.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
  const controller = new ProjectController(projectFolder(p.root)); Object.assign(controller.draftConfig.roles.lead, { vendor: 'grok', maxCostUsd: null });
  const calls = () => fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const send = async (text, id, options) => controller.ask(text, id, options).finished;
  return { ...p, fake, controller, calls, send, set, bin: path.join(fake.dir, 'grok'), privateHome: path.join(personalDirectory(), 'grok-home') };
}
const said = task => (task.messages ?? []).filter(row => row.from === 'ELU').map(row => row.text);
const why = task => task.error?.message ?? JSON.stringify(task.error);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// The question ELU puts to the owner about what Grok Build would run, as it waits for y or n.
async function question() {
  for (let i = 0; i < 600; i++) { const row = pendingApprovals().find(row => row.vendor === 'grok' && row.tool === 'OtherTools'); if (row) return row; await sleep(50); }
  throw new Error('the owner was not asked');
}
const checks = f => f.calls().filter(call => call.args.includes('inspect')).length;
const FIRST = 'One-time check of Grok Build on this machine first: about seven short turns on it, a few minutes.';
const notPassed = () => Object.entries(conformanceState('grok')?.steps ?? { none: 'no record' }).filter(([, status]) => status !== 'pass').map(([id]) => id);

test('a computer with only Grok Build: the first message runs its check, the check passes on what grok inspect prints on every computer, and the turn runs in Ask for approval, Approve for me and Full access', { timeout: 300000 }, async t => {
  const f = onlyGrok(t);
  const first = await f.send('Reply done with the summary "grok answered".', null, { permissions: 'ask' });
  // Before: "Grok Build did not pass its check on this machine, so it stays off here. Not proven:
  // no other tool's settings reach its turn (Claude or Cursor configuration reached the run:
  // cursor, cursor, cursor). Your next message to it runs the check again."
  assert.equal(first.state, 'answered', why(first)); assert.equal(first.result.summary, 'grok answered');
  assert.deepEqual(notPassed(), [], 'every step passed, the one that reads what else it loads too');
  assert.deepEqual(said(first), ['One-time check of Grok Build on this machine first: about seven short turns on it, a few minutes.', 'Grok Build 1.0.77 passed its check on this machine.']);
  // The stand-in listed every switch, as the real one does, and all of them off.
  const inspect = f.calls().filter(call => call.args.includes('inspect'));
  assert.equal(inspect.length, 1);
  for (const permissions of ['auto', 'full']) {
    const task = await f.send(`Reply done with the summary "again in ${permissions}".`, null, { permissions });
    assert.equal(task.state, 'answered', `${permissions}: ${why(task)}`); assert.equal(task.result.summary, `again in ${permissions}`); assert.equal(task.runs[0].vendor, 'grok'); assert.equal(task.runs[0].permissions, permissions);
    assert.deepEqual(said(task), [], 'the check ran once');
  }
  assert.equal(f.calls().filter(call => call.args.includes('inspect')).length, 1);
});

test('a record ELU 0.1.19 left, with that step failed on the list of switches, is not kept: the next message checks Grok Build again and it runs', { timeout: 300000 }, async t => {
  const f = onlyGrok(t);
  // What 0.1.19 wrote on a computer with Grok Build signed in and nothing of Cursor's or Claude's on it.
  atomic(path.join(personalDirectory(), 'conformance', 'grok.json'), { v: 1, bin: f.bin, version: '1.0.77', steps: { ...Object.fromEntries(ADAPTERS.grok.conformance.map(step => [step.id, 'pass'])), isolation: 'fail' }, relay: true, at: new Date(Date.now() - 86400000).toISOString() });
  const task = await f.send('Reply done with the summary "after the update".', null, { permissions: 'auto' });
  assert.equal(task.state, 'answered', why(task)); assert.equal(task.result.summary, 'after the update');
  assert.deepEqual(notPassed(), []);
  assert.equal(said(task).at(-1), 'Grok Build 1.0.77 passed its check on this machine.');
});

test('a check that did not pass leaves Grok Build to Full access: a Full access message runs with the result said once, and Ask for approval and Approve for me say what still works', { timeout: 300000 }, async t => {
  // This grok writes in a read-only turn: three required steps are not proven, and no second check can prove them.
  const f = onlyGrok(t, { mode: 'leaky' });
  const notProven = 'Not proven: a read-only turn writes no file (locked run wrote a file: created.txt), and 2 more.';
  const full = await f.send('Reply done with the summary "in full".', null, { permissions: 'full' });
  assert.equal(full.state, 'answered', why(full)); assert.equal(full.result.summary, 'in full'); assert.equal(full.runs[0].permissions, 'full');
  assert.deepEqual(said(full), [FIRST, `Grok Build did not pass its check on this machine. ${notProven} Full access runs it anyway; Read only, Ask for approval and Approve for me stay off.`]);
  assert.equal(checks(f), 1);
  // The next Full access message says nothing more and checks nothing again.
  const next = await f.send('Reply done with the summary "again".', full.id);
  assert.equal(next.state, 'answered', why(next)); assert.equal(next.runs.length, 2); assert.equal(said(next).length, 2); assert.equal(checks(f), 1);
  // Any other mode is refused with what still works and what to do, and starts no check that cannot change the result.
  const refusal = `Grok Build did not pass its check on this machine, so it runs in Full access only here. ${notProven} Switch this session to Full access to use it; c on its line in the Usage tab runs the check again.`;
  for (const permissions of ['ask', 'auto']) await assert.rejects(f.send('Reply done.', null, { permissions }), error => error.message === refusal, permissions);
  assert.equal(checks(f), 1);
  assert.deepEqual(checkResult('grok', { bin: f.bin, version: '1.0.77' }).failed.map(step => step.id), ['locked-no-write', 'locked-no-shell', 'locked-no-network']);
});

test('a rule of another tool that Grok Build loads is named once after the check, and stops no mode', { timeout: 300000 }, async t => {
  // A grok that reads Cursor's rules whatever ELU set, and a rule in the home ELU runs it under.
  const f = onlyGrok(t, { grok: { inspect: { on: ['cursor.rules'] } } }), home = ADAPTERS.grok.childEnv({ mode: 'locked', home: f.parent }).HOME, file = path.join(home, '.cursor', 'rules', 'style.md');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'Be terse.\n');
  const task = await f.send('Reply done with the summary "with a rule".', null, { permissions: 'ask' });
  assert.equal(task.state, 'answered', why(task)); assert.equal(task.result.summary, 'with a rule');
  assert.deepEqual(said(task), [FIRST, 'Grok Build 1.0.77 passed its check on this machine.', `It also loads on this machine: ${loadsList([{ what: 'Cursor rule', from: file }])}.`]);
  assert.deepEqual(notPassed(), ['isolation'], 'the step is recorded as not proven, and it is not a required one');
  assert.deepEqual(pendingApprovals(), [], 'text the model reads is not asked about');
  for (const permissions of ['auto', 'full']) { const again = await f.send('Reply done with the summary "again".', null, { permissions }); assert.equal(again.state, 'answered', `${permissions}: ${why(again)}`); assert.deepEqual(said(again), []); }
});

test('hooks of another tool that Grok Build would run: outside Full access the owner is asked once, by name; yes is kept, no leaves Grok Build to Full access', { timeout: 300000 }, async t => {
  const f = onlyGrok(t, { grok: { inspect: { on: ['cursor.hooks'] } } }), home = ADAPTERS.grok.childEnv({ mode: 'locked', home: f.parent }).HOME, folder = path.join(home, '.cursor');
  fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'hooks.json'), JSON.stringify({ hooks: { preToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint-all' }] }] } }));
  const names = loadsList([{ what: 'Cursor hook', from: folder }]);
  // The first message, in Ask for approval: the check, then the question, then the turn.
  const pending = f.send('Reply done with the summary "with hooks".', null, { permissions: 'ask' });
  const asked = await question();
  assert.equal(asked.summary, `Run Grok Build with ${names}`);
  assert.equal(answerApproval(asked.id, 'allow'), true);
  const task = await pending;
  assert.equal(task.state, 'answered', why(task)); assert.equal(task.result.summary, 'with hooks');
  assert.deepEqual(said(task), [FIRST, 'Grok Build 1.0.77 passed its check on this machine.', `Grok Build would also run ${names} on this machine. Asked once: y lets it, n keeps Grok Build to Full access.`]);
  assert.equal(checkResult('grok', { bin: f.bin, version: '1.0.77' }).answer, 'allow');
  // Asked once: the next message, in another mode, starts with no question.
  const second = await f.send('Reply done with the summary "not asked".', null, { permissions: 'auto' });
  assert.equal(second.state, 'answered', why(second)); assert.deepEqual(said(second), []); assert.deepEqual(pendingApprovals(), []);
  // The same question answered no: every mode but Full access is off, with what to press to be asked again.
  answerLoads('grok', null);
  const refused = f.send('Reply done.', null, { permissions: 'auto' });
  assert.equal(answerApproval((await question()).id, 'deny'), true);
  const off = `Grok Build is off outside Full access on this machine: you did not let it run ${names}. c on its line in the Usage tab asks again.`;
  await assert.rejects(refused, error => error.message === off);
  await assert.rejects(f.send('Reply done.', null, { permissions: 'ask' }), error => error.message === off, 'a no is not asked again by a message');
  assert.deepEqual(pendingApprovals(), []);
  // Full access is never asked, and runs.
  const full = await f.send('Reply done with the summary "in full".', null, { permissions: 'full' });
  assert.equal(full.state, 'answered', why(full)); assert.equal(full.result.summary, 'in full'); assert.deepEqual(said(full), []); assert.deepEqual(pendingApprovals(), []);
  assert.equal(checks(f), 1, 'the check ran once');
});
