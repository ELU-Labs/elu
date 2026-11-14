import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis } from './helpers.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';
import { conformanceState, failedText, uncheckedText } from '../lib/conformance.mjs';
import { checkOnFirstUse, notSignedInText } from '../lib/vendor-check.mjs';
import { detect, vendorProblem } from '../lib/detect.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import * as vendors from '../lib/vendors.mjs';

// Full access waits for no check. A computer where a vendor that has a one-time check is the
// only one installed and is signed in; the owner's messages go through the runner as the app
// sends them. The stand-in's check is slow here, as the real one is: each of its seven model
// turns takes nine seconds, so a check takes over a minute (test/fakes/grok.mjs,
// grok.checkSeconds). A test that is done with a check ends its wait by writing the gate file.
const SLOW = 9, CHECK_MS = SLOW * 7 * 1000;
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function machine(t, { lead = 'grok', grok = {}, mode = 'answer', signedIn = true } = {}) {
  // Whatever a check was doing ends with the test, before the test's folders go.
  let ends = null; t.after(() => { try { if (ends) fs.writeFileSync(ends, ''); } catch { /* The folder is gone already. */ } });
  const p = project(t), fake = fakeClis(p.parent, { mode }), config = path.join(fake.dir, 'fake.json'), gate = ends = path.join(p.parent, 'check-gate');
  // No other vendor is installed: a wrapper that exits 127 stands wherever one would be found on PATH.
  for (const other of ['claude', 'codex', 'agy', 'grok'].filter(vendor => vendor !== lead)) fs.writeFileSync(path.join(fake.dir, other), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  const set = value => fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), grok: { checkSeconds: SLOW, checkGate: gate, ...value } }));
  set(grok);
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  if (signedIn) { fs.mkdirSync(path.join(p.parent, '.grok')); fs.writeFileSync(path.join(p.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 }); }
  const controller = new ProjectController(projectFolder(p.root)); Object.assign(controller.draftConfig.roles.lead, { vendor: lead, maxCostUsd: null });
  const calls = () => fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(JSON.parse) : [];
  // What the stand-in was given to answer, turn by turn: a step of a check among them.
  const inputs = () => { const file = path.join(p.parent, 'inputs.jsonl'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : []; };
  // A message as the app sends it. sent: when; first(): how long until the vendor had the
  // message itself, which is when its turn began.
  const send = (text, id, options) => {
    const sent = Date.now(), words = /summary "([^"]+)"/.exec(text)?.[1] ?? text, finished = controller.ask(text, id, options).finished;
    const first = async () => { for (;;) { if (inputs().some(row => row.input.includes(words))) return Date.now() - sent; if (Date.now() - sent > 120000) throw new Error('the turn did not begin within two minutes'); await sleep(25); } };
    return { finished, first, sent };
  };
  return { ...p, fake, controller, calls, send, set, gate, release: () => fs.writeFileSync(gate, ''), bin: path.join(fake.dir, lead), lock: path.join(personalDirectory(), 'conformance', `${lead}.lock`), record: path.join(personalDirectory(), 'conformance', `${lead}.json`) };
}
// The model turns a stand-in was started for: a prompt, never a read of its release, its help or its sign-in.
const turns = calls => calls.filter(call => call.args.includes('--prompt-file') || call.args.includes('--json-schema') || (call.args.includes('agent') && call.args.includes('stdio')) || call.args.includes('acp'));
// A turn of the one-time check runs in the check's own folder.
const checkTurns = calls => calls.filter(call => call.args.some(arg => String(arg).includes('elu-code-check-')));
const said = task => (task.messages ?? []).filter(row => row.from === 'ELU').map(row => row.text);
const why = task => task.error?.message ?? JSON.stringify(task.error);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, what, ms = 30000) { const end = Date.now() + ms; for (;;) { const value = test(); if (value) return value; if (Date.now() > end) throw new Error(`never: ${what}`); await sleep(50); } }
const notes = f => fs.existsSync(path.join(f.controller.repo.state, 'events.jsonl')) ? fs.readFileSync(path.join(f.controller.repo.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.type === 'vendor-check') : [];
const passed = (f, version, steps = {}) => atomic(f.record, { v: 1, bin: f.bin, version, steps: { ...Object.fromEntries(ADAPTERS.grok.conformance.map(step => [step.id, 'pass'])), ...steps }, relay: true, at: new Date(Date.now() - 86400000).toISOString(), stable: Object.keys(steps) });
const session = (f, at = -1) => f.controller.snapshot().tasks.at(at).id;

const FULL_NOW = 'Full access needs no check: /permissions full runs your message now.';
const FIRST = `Checking Grok Build (the grok command) first: 8 steps, once on this machine for release 1.0.77. ${FULL_NOW}`;
const PASSED = 'Grok Build 1.0.77 passed its check on this machine.';
const COUNTING = /^Checking Grok Build: (\d) of 8 steps done, (\d+m )?\d+s so far\.( (Proven|Not proven|Skipped): [^.]+\.)?$/;

test('Full access, first use on this computer: a message to a Grok Build that was never checked starts at once, runs no check and says nothing about one', { timeout: 300000 }, async t => {
  const f = machine(t);
  const hi = f.send('Reply done with the summary "hi back".', null, { permissions: 'full' }), first = await hi.first(), task = await hi.finished, whole = Date.now() - hi.sent;
  // Before: "One-time check of Grok Build on this machine first: about seven short turns on it,
  // a few minutes." and then all eight steps, over a minute here, before the message was sent on.
  assert.equal(task.state, 'answered', why(task)); assert.equal(task.result.summary, 'hi back'); assert.equal(task.runs[0].vendor, 'grok'); assert.equal(task.runs[0].permissions, 'full');
  t.diagnostic(`first use: the turn began ${first} ms after the message, and the reply was there after ${whole} ms; a check here takes ${CHECK_MS} ms`);
  assert.ok(first < 10000, `the turn began after ${first} ms`); assert.ok(whole < CHECK_MS / 2, `the reply took ${whole} ms`);
  assert.deepEqual(said(task), [], 'nothing about a check in the chat'); assert.deepEqual(notes(f), [], 'and nothing under the working line');
  assert.deepEqual(checkTurns(f.calls()), [], 'no step of a check ran'); assert.equal(conformanceState('grok'), null, 'and there is no record of one'); assert.equal(fs.existsSync(f.lock), false);
  // The next message in the session, and one in a new Full access session: the same.
  for (const id of [task.id, null]) {
    const next = f.send('Reply done with the summary "again".', id, id ? undefined : { permissions: 'full' }), began = await next.first(), done = await next.finished;
    assert.equal(done.state, 'answered', why(done)); assert.ok(began < 10000, `the turn began after ${began} ms`); assert.deepEqual(said(done), []);
  }
  assert.deepEqual(notes(f), []); assert.deepEqual(checkTurns(f.calls()), []); assert.equal(conformanceState('grok'), null);
});

test('outside Full access the first message still waits for the check, and says the honest thing: how many steps, once for this release, how long so far, and that Full access needs none', { timeout: 300000 }, async t => {
  const f = machine(t);
  const ask = f.send('Reply done with the summary "after the check".', null, { permissions: 'ask' }); let ended = false; ask.finished.then(() => { ended = true; }, () => { ended = true; });
  await until(() => said(readTask(f.controller.repo, session(f)))[0], 'the first line of the check');
  // Before: "One-time check of Grok Build on this machine first: about seven short turns on it, a few minutes."
  assert.deepEqual(said(readTask(f.controller.repo, session(f))), [FIRST]);
  // Under the working line: the steps done of the real number, and the time so far, counted on while a step runs.
  const counted = () => notes(f).map(row => row.note).filter(note => COUNTING.test(note));
  await until(() => counted().length >= 3, 'the counting line, said again while the first step runs', 30000);
  assert.match(counted()[0], /^Checking Grok Build: 0 of 8 steps done, 0s so far\.$/);
  const seconds = counted().map(note => Number(/(\d+)s so far/.exec(note)[1]));
  assert.ok(seconds.at(-1) >= 5, `the time is counted on: ${counted().join(' | ')}`);
  assert.equal(ended, false, 'the message waits for the check');
  assert.ok(checkTurns(f.calls()).length > 0, 'the check is running');
  // The check ends: the turn goes on by itself and the chat keeps what it found.
  f.release();
  const task = await ask.finished;
  assert.equal(task.state, 'answered', why(task)); assert.equal(task.result.summary, 'after the check'); assert.equal(task.runs[0].permissions, 'ask');
  assert.deepEqual(said(task), [FIRST, PASSED]);
  assert.match(counted().at(-1), /^Checking Grok Build: 8 of 8 steps done, /);
  for (const note of notes(f).map(row => row.note)) assert.doesNotMatch(note, /a few minutes|seven short turns|One-time check/);
});

test('a new release of Grok Build: a Full access message runs at once on it with no check; outside Full access the check runs again and says why', { timeout: 300000 }, async t => {
  const f = machine(t);
  // Release 1.0.77 passed its check here; the program has been updated since.
  passed(f, '1.0.77'); f.set({ version: '1.0.78' });
  const full = f.send('Reply done with the summary "on the new release".', null, { permissions: 'full' }), first = await full.first(), task = await full.finished;
  // Before: "Checking Grok Build again first: about seven short turns on it, a few minutes." and the whole check, in Full access too.
  assert.equal(task.state, 'answered', why(task)); assert.equal(task.result.summary, 'on the new release'); assert.equal(task.runs[0].permissions, 'full');
  t.diagnostic(`a new release: the turn began ${first} ms after the message`);
  assert.ok(first < 10000, `the turn began after ${first} ms`);
  assert.deepEqual(said(task), []); assert.deepEqual(notes(f), []); assert.deepEqual(checkTurns(f.calls()), []);
  assert.equal(conformanceState('grok').version, '1.0.77', 'the record is the old release\'s still');
  // Approve for me checks the new release first, and says that the program changed.
  const auto = f.send('Reply done with the summary "checked again".', null, { permissions: 'auto' });
  await until(() => said(readTask(f.controller.repo, session(f)))[0], 'the first line of the check');
  assert.deepEqual(said(readTask(f.controller.repo, session(f))), [`Grok Build (the grok command) is now release 1.0.78 (1.0.77 was checked), so its check runs again first: 8 steps, once for this release. ${FULL_NOW}`]);
  f.release();
  const again = await auto.finished;
  assert.equal(again.state, 'answered', why(again)); assert.equal(said(again).at(-1), 'Grok Build 1.0.78 passed its check on this machine.'); assert.equal(conformanceState('grok').version, '1.0.78');
  // An older release than the one that was checked is a release like any other: it runs in Full access.
  f.set({ version: '1.0.70' });
  const older = await f.send('Reply done with the summary "on the older one".', null, { permissions: 'full' }).finished;
  assert.equal(older.state, 'answered', why(older)); assert.deepEqual(said(older), []);
});

test('a check that did not pass before: a Full access message runs at once, checks nothing again and says nothing about it', { timeout: 300000 }, async t => {
  const f = machine(t);
  // One required step failed for good, another in a way a second check could change.
  for (const steps of [{ 'locked-no-write': 'fail' }, { json: 'fail' }]) {
    passed(f, '1.0.77', steps); if (steps.json) atomic(f.record, { ...JSON.parse(fs.readFileSync(f.record, 'utf8')), stable: [] });
    const full = f.send('Reply done with the summary "in full".', null, { permissions: 'full' }), first = await full.first(), task = await full.finished;
    // Before: "Grok Build did not pass its check on this machine. Not proven: ... Full access runs it anyway; ..." in the chat.
    assert.equal(task.state, 'answered', why(task)); assert.equal(task.runs[0].permissions, 'full'); assert.ok(first < 10000, `the turn began after ${first} ms`);
    assert.deepEqual(said(task), []); assert.deepEqual(notes(f), []); assert.deepEqual(checkTurns(f.calls()), []);
  }
});

test('a check that another session is running: a Full access message does not wait for it; a session in Ask for approval waits and says so, and runs at once when it is set to Full access', { timeout: 300000 }, async t => {
  const f = machine(t), repo = f.controller.repo;
  // One session's first message in Ask for approval starts the check, which takes over a minute.
  const a = f.send('Reply done with the summary "from the first".', null, { permissions: 'ask' }), aId = await until(() => f.controller.snapshot().tasks[0]?.id, 'the first session'); let aEnded = false; a.finished.then(() => { aEnded = true; }, () => { aEnded = true; });
  await until(() => fs.existsSync(f.lock) && said(readTask(repo, aId)).length === 1, 'the check of the first session');
  // A second session in Full access: its message runs now.
  const b = f.send('Reply done with the summary "from the second".', null, { permissions: 'full' }), first = await b.first(), second = await b.finished;
  // Before: "Waiting for the check of Grok Build that is already running on this machine." until that check ended.
  assert.equal(second.state, 'answered', why(second)); assert.equal(second.result.summary, 'from the second'); assert.equal(second.runs[0].permissions, 'full');
  t.diagnostic(`beside another session's check: the turn began ${first} ms after the message`);
  assert.ok(first < 10000, `the turn began after ${first} ms`); assert.deepEqual(said(second), []);
  assert.deepEqual(notes(f).filter(row => row.taskId === second.id), [], 'nothing about a check under its working line');
  assert.equal(aEnded, false); assert.equal(fs.existsSync(f.lock), true, 'the first session\'s check runs on');
  // A third session in Ask for approval waits for that check, and says what it waits for.
  const c = f.send('Reply done with the summary "from the third".', null, { permissions: 'ask' }), cId = await until(() => f.controller.snapshot().tasks.find(task => ![aId, second.id].includes(task.id))?.id, 'the third session'); let cEnded = false; c.finished.then(() => { cEnded = true; }, () => { cEnded = true; });
  await until(() => said(readTask(repo, cId)).length, 'what the third session says');
  assert.deepEqual(said(readTask(repo, cId)), [`Grok Build (the grok command) is being checked by another session on this machine. This one goes on when that ends. ${FULL_NOW}`]);
  await until(() => notes(f).some(row => row.taskId === cId && /^Waiting for the check of Grok Build, \d+s so far\.$/.test(row.note)), 'the time it has waited');
  await sleep(1500); assert.equal(cEnded, false, 'it waits');
  // Set to Full access, as its line says: its message runs now, and starts no check.
  const switched = Date.now(), before = checkTurns(f.calls()).length;
  f.controller.setPermissions(cId, 'full');
  const third = await c.finished, took = Date.now() - switched;
  assert.equal(third.state, 'answered', why(third)); assert.equal(third.result.summary, 'from the third'); assert.equal(third.runs[0].permissions, 'full');
  t.diagnostic(`set to Full access while it waited: the reply was there after ${took} ms`);
  assert.ok(took < CHECK_MS / 2, `the reply took ${took} ms`); assert.equal(said(third).length, 1, 'nothing more is said');
  assert.equal(aEnded, false, 'the first session still waits for its own check'); assert.equal(fs.existsSync(f.lock), true);
  assert.ok(checkTurns(f.calls()).length - before <= 1, 'the third session started no check of its own');
  // The check ends: the first session goes on.
  f.release();
  const one = await a.finished;
  assert.equal(one.state, 'answered', why(one)); assert.deepEqual(said(one), [FIRST, PASSED]);
});

test('a session set to Full access while its own check runs: the message runs at once, the check ends there and records nothing', { timeout: 300000 }, async t => {
  const f = machine(t), repo = f.controller.repo;
  const a = f.send('Reply done with the summary "ran in full".', null, { permissions: 'ask' }), id = await until(() => f.controller.snapshot().tasks[0]?.id, 'the session');
  await until(() => said(readTask(repo, id)).length === 1 && checkTurns(f.calls()).length > 0, 'the check, started');
  const switched = Date.now();
  f.controller.setPermissions(id, 'full');
  const task = await a.finished, took = Date.now() - switched;
  assert.equal(task.state, 'answered', why(task)); assert.equal(task.result.summary, 'ran in full'); assert.equal(task.runs[0].permissions, 'full');
  t.diagnostic(`set to Full access while its check ran: the reply was there after ${took} ms`);
  assert.ok(took < CHECK_MS / 2, `the reply took ${took} ms`);
  assert.deepEqual(said(task), [FIRST], 'the chat keeps the line that was said, and nothing after it');
  // Nothing of the check runs beside the turn or after it: its lock is gone, no step starts, and there is no record.
  await until(() => !fs.existsSync(f.lock), 'the lock of the check, gone', 10000);
  const steps = checkTurns(f.calls()).length; await sleep(SLOW * 1000 + 2000);
  assert.equal(checkTurns(f.calls()).length, steps, 'no other step of the check started'); assert.equal(conformanceState('grok'), null);
  // Back in Ask for approval, the next message checks it, from its first step.
  f.controller.setPermissions(id, 'ask'); f.release();
  const next = await f.send('Reply done with the summary "checked".', id).finished;
  assert.equal(next.state, 'answered', why(next)); assert.deepEqual(said(next), [FIRST, FIRST, PASSED]);
});

test('Grok Build signed out: a Full access message says so at once, with the step that signs it in, and starts no check', { timeout: 300000 }, async t => {
  const f = machine(t, { signedIn: false }), sent = Date.now();
  await assert.rejects(f.send('Reply done.', null, { permissions: 'full' }).finished, error => error.message === 'Grok Build (the grok command) is signed out. Sign it in with s on its line in the Usage tab, then send again.' || assert.fail(error.message));
  assert.ok(Date.now() - sent < 15000); assert.deepEqual(turns(f.calls()), [], 'no turn was started'); assert.deepEqual(notes(f), []);
});

test('Antigravity CLI never checked, or updated since its check: a Full access message runs at once, headless, with no check', { timeout: 300000 }, async t => {
  const f = machine(t, { lead: 'agy' });
  const hi = f.send('Reply done with the summary "from agy".', null, { permissions: 'full' }), first = await hi.first(), task = await hi.finished;
  // Before: "One-time check of Antigravity CLI on this machine first: about seven short turns on it, a few minutes."
  assert.equal(task.state, 'answered', why(task)); assert.equal(task.result.summary, 'from agy'); assert.equal(task.runs[0].vendor, 'agy'); assert.equal(task.runs[0].permissions, 'full');
  t.diagnostic(`Antigravity CLI, first use: the turn began ${first} ms after the message`);
  assert.ok(first < 10000, `the turn began after ${first} ms`);
  assert.deepEqual(said(task), []); assert.deepEqual(notes(f), []); assert.equal(conformanceState('agy'), null);
  // Its steps show live over ACP only where a check proved that: this turn ran the way that needs no proof.
  assert.deepEqual(f.calls().filter(call => call.args.includes('acp')), [], 'not over ACP');
  // A check of an earlier release proved ACP there. It proves nothing of this one: headless again.
  atomic(f.record, { v: 1, bin: f.bin, version: '1.5.3', steps: Object.fromEntries(ADAPTERS.agy.conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date(Date.now() - 86400000).toISOString() });
  const next = await f.send('Reply done with the summary "after an update".', null, { permissions: 'full' }).finished;
  assert.equal(next.state, 'answered', why(next)); assert.deepEqual(said(next), []); assert.deepEqual(f.calls().filter(call => call.args.includes('acp')), []);
  assert.equal(conformanceState('agy').version, '1.5.3');
});

test('a line about a vendor\'s check or its sign-in names the command with it, from one helper', async t => {
  const { VENDOR_NAMES, vendorWithCommand } = vendors;
  assert.equal(vendorWithCommand('grok'), 'Grok Build (the grok command)'); assert.equal(vendorWithCommand('agy'), 'Antigravity CLI (the agy command)');
  // A vendor whose name is its command is named as before.
  assert.equal(vendorWithCommand('claude'), VENDOR_NAMES.claude); assert.equal(vendorWithCommand('codex'), VENDOR_NAMES.codex);
  const f = machine(t);
  assert.equal(uncheckedText('grok'), 'Grok Build (the grok command) has not been checked on this machine yet. Your first message to it outside Full access runs the check; Full access needs none.');
  assert.equal(uncheckedText('agy'), 'Antigravity CLI (the agy command) has not been checked on this machine yet. Your first message to it outside Full access runs the check; Full access needs none.');
  assert.equal(notSignedInText('grok', { signedIn: false }), 'Grok Build (the grok command) is not signed in for ELU. Sign it in with s on its line in the Usage tab.');
  assert.equal(notSignedInText('agy', { signedIn: null, reason: 'gave no answer' }), 'Antigravity CLI (the agy command) did not say whether it is signed in (it gave no answer). r in the Usage tab reads it again.');
  assert.match(failedText('grok', { failed: [{ text: 'a read-only turn writes no file' }], again: false }), /^Grok Build \(the grok command\) did not pass its check on this machine, so it runs in Full access only here\. /);
  for (const [vendor, name] of [['grok', 'Grok Build (the grok command)'], ['agy', 'Antigravity CLI (the agy command)']]) {
    assert.equal(vendorProblem(vendor, [{ vendor, available: true, supported: true, signedIn: false, version: '1', conformant: false }]), `${name} is signed out. Sign it in with s on its line in the Usage tab, then send again.`);
    assert.ok(ADAPTERS[vendor].meta.signInHint.startsWith(`${name}: not signed in`), ADAPTERS[vendor].meta.signInHint);
  }
  assert.equal(vendorProblem('claude', [{ vendor: 'claude', available: true, supported: true, signedIn: false }]).startsWith('Claude Code is signed out. '), true);
  // The check's own lines, as c in the Usage tab and a turn get them: the first names the command, the rest the vendor alone.
  const row = (await detect(f.root, process.env, { only: 'grok' }))[0], lines = [];
  f.release();
  assert.equal(await checkOnFirstUse(row, { cwd: f.root, say: (text, { keep = false } = {}) => { if (keep) lines.push(text); } }), true);
  assert.deepEqual(lines, ['Checking Grok Build (the grok command): 8 steps, once on this machine for release 1.0.77.', PASSED]);
  // A turn that the owner's switch to Full access would not start is not told to switch.
  f.set({ version: '1.0.79' });
  const other = (await detect(f.root, process.env, { only: 'grok' }))[0], kept = [];
  assert.equal(await checkOnFirstUse(other, { cwd: f.root, mode: 'locked', fullNote: false, say: (text, { keep = false } = {}) => { if (keep) kept.push(text); } }), true);
  assert.equal(kept[0], 'Grok Build (the grok command) is now release 1.0.79 (1.0.77 was checked), so its check runs again first: 8 steps, once for this release.');
  // A turn in Full access is never checked here, whatever the record says.
  f.set({ version: '1.0.80' });
  assert.equal(await checkOnFirstUse((await detect(f.root, process.env, { only: 'grok', full: 'grok' }))[0], { cwd: f.root, mode: 'full', say: () => assert.fail('nothing is said') }), false);
});
