import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkResult, conformanceHarness, conformanceState, conformant, failedText, requireConformance, runConformance, vendorReading } from '../lib/conformance.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';

function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-conformance-'))), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('the harness gives a step a repository, a planted secret, a listener and a marker command', async t => {
  const dir = home(t), h = await conformanceHarness({ scratch: path.join(dir, 'h') });
  t.after(() => h.close());
  assert.equal(spawnSync('git', ['-C', h.repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), 'main');
  assert.equal(spawnSync('git', ['-C', h.repo, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, '', 'the fixture is committed');
  assert.ok(fs.existsSync(path.join(h.repo, 'README.md')));
  assert.ok(!h.outsideFile.startsWith(`${h.repo}/`)); assert.match(fs.readFileSync(h.outsideFile, 'utf8'), /^planted-/);
  assert.equal(h.listener.hits(), 0);
  assert.equal((await fetch(h.listener.url)).status, 404); assert.equal(h.listener.hits(), 1);
  assert.equal(h.marker.ran(), false);
  assert.equal(spawnSync(h.marker.command).status, 0); assert.equal(h.marker.ran(), true);
  await h.close(); await assert.rejects(fetch(h.listener.url), 'the listener is gone after close');
  await assert.rejects(conformanceHarness({ scratch: 'relative' }), /absolute scratch folder/);
});

test('a gated vendor refuses to run until its one-time check ran here, for this exact binary and version; a step not proven leaves it Full access only', async t => {
  const dir = home(t), log = [];
  assert.equal(requireConformance('claude', { bin: '/x/claude', version: '2.1.319' }), true, 'Claude is not gated');
  assert.equal(requireConformance('codex', { bin: '/x/codex', version: '0.166.0-alpha.5.1' }), true, 'Codex is not gated');
  assert.throws(() => requireConformance('grok', { bin: '/x/grok', version: '1.0.0' }), /^EluCodeError: Grok Build \(the grok command\) has not been checked on this machine yet\. Your first message to it outside Full access runs the check; Full access needs none\.$/);
  assert.throws(() => requireConformance('agy', { bin: '/x/agy', version: '1.0.0' }), /^EluCodeError: Antigravity CLI \(the agy command\) has not been checked on this machine yet\. Your first message to it outside Full access runs the check; Full access needs none\.$/);
  assert.throws(() => requireConformance('cursor', { bin: '/x/agent', version: '1' }), /Unknown vendor/);
  assert.equal(conformanceState('grok'), null); assert.equal(conformant('grok', { bin: '/x/grok', version: '1.0.0' }), false);
  await assert.rejects(runConformance('grok', { bin: 'grok', version: '1.0.0', scratch: path.join(dir, 's') }), /resolved binary path/);
  await assert.rejects(runConformance('grok', { bin: '/x/grok', version: '', scratch: path.join(dir, 's') }), /version it proves/);
  // The record the check writes (each adapter's own tests run the steps). An optional step may fail; a required one shuts the gate.
  const file = path.join(personalDirectory(), 'conformance', 'grok.json'), steps = Object.fromEntries(ADAPTERS.grok.conformance.map(step => [step.id, 'pass']));
  for (const vendor of ['agy', 'grok']) assert.ok(ADAPTERS[vendor].conformance.some(step => step.required) && ADAPTERS[vendor].conformance.some(step => !step.required), `${vendor} has required and optional steps`);
  const record = extra => atomic(file, { v: 1, bin: '/x/grok', version: '1.0.0', steps, relay: false, at: new Date().toISOString(), ...extra });
  record({});
  const state = conformanceState('grok');
  assert.equal(state.bin, '/x/grok'); assert.equal(state.version, '1.0.0'); assert.equal(state.relay, false); assert.ok(Date.parse(state.at) > 0);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(requireConformance('grok', { bin: '/x/grok', version: '1.0.0' }), true);
  assert.throws(() => requireConformance('grok', { bin: '/x/grok', version: '1.0.1' }), /Grok Build \(the grok command\) has not been checked on this machine yet/, 'a new release proves itself again');
  assert.throws(() => requireConformance('grok', { bin: '/other/grok', version: '1.0.0' }), /Grok Build \(the grok command\) has not been checked on this machine yet/, 'another binary proves itself again');
  assert.throws(() => requireConformance('agy', { bin: '/x/agy', version: '1.0.0' }), /Antigravity CLI \(the agy command\) has not been checked on this machine yet/, 'one vendor never vouches for another');
  const optional = ADAPTERS.grok.conformance.find(step => !step.required).id, required = ADAPTERS.grok.conformance.find(step => step.required).id;
  record({ steps: { ...steps, [optional]: 'fail' } }); assert.equal(requireConformance('grok', { bin: '/x/grok', version: '1.0.0' }), true, 'an optional step may fail');
  // A required step that is not proven turns off Read only, Ask for approval and Approve for me, and never Full access.
  const at = { bin: '/x/grok', version: '1.0.0' };
  record({ steps: { ...steps, [required]: 'fail' } });
  for (const mode of ['locked', 'ask', 'auto']) assert.throws(() => requireConformance('grok', { ...at, mode }), /^EluCodeError: Grok Build \(the grok command\) did not pass its check on this machine, so it runs in Full access only here\. Not proven: it is signed in\. Your next message to it runs the check again\.$/, `a failed required step keeps ${mode} off, and the refusal names it`);
  assert.throws(() => requireConformance('grok', at), /so it runs in Full access only here/, 'a turn that names no mode is read-only');
  assert.equal(requireConformance('grok', { ...at, mode: 'full' }), true, 'Full access runs the vendor as it is');
  assert.equal(requireConformance('grok', { bin: '/x/grok', version: '1.0.1', mode: 'full' }), true, 'and a release that was never checked: Full access needs no check');
  assert.throws(() => requireConformance('grok', { bin: '/x/grok', version: '1.0.1', mode: 'auto' }), /Grok Build \(the grok command\) has not been checked on this machine yet/, 'the other modes run only the release the check ran on');
  // The record says why, and whether checking again can change it.
  record({ steps: { ...steps, [required]: 'fail' }, why: { [required]: 'the agent offers no cached token' }, stable: [] });
  assert.throws(() => requireConformance('grok', at), /^EluCodeError: Grok Build \(the grok command\) did not pass its check on this machine, so it runs in Full access only here\. Not proven: it is signed in \(the agent offers no cached token\)\. Your next message to it runs the check again\.$/);
  record({ steps: { ...steps, 'locked-no-shell': 'fail', 'locked-no-network': 'fail' }, why: { 'locked-no-shell': 'locked run ran a shell command' }, stable: ['locked-no-shell'] });
  assert.throws(() => requireConformance('grok', at), /^EluCodeError: Grok Build \(the grok command\) did not pass its check on this machine, so it runs in Full access only here\. Not proven: a read-only turn runs no command \(locked run ran a shell command\), and 1 more\. Switch this session to Full access to use it; c on its line in the Usage tab runs the check again\.$/, 'a step that cannot pass on a second try promises no second try');
  assert.deepEqual(checkResult('grok', at).failed, [{ id: 'locked-no-shell', text: 'a read-only turn runs no command', why: 'locked run ran a shell command', stable: true }, { id: 'locked-no-network', text: 'a read-only turn reaches no network', why: null, stable: false }]);
  assert.equal(failedText('grok', checkResult('grok', at), { full: true }), 'Grok Build (the grok command) did not pass its check on this machine. Not proven: a read-only turn runs no command (locked run ran a shell command), and 1 more. Full access runs it anyway; Read only, Ask for approval and Approve for me stay off.');
  record({ steps: { ...steps, [required]: 'skip' } }); assert.throws(() => requireConformance('grok', at), /Grok Build \(the grok command\) did not pass its check on this machine, so it runs in Full access only here\. Not proven: it is signed in\./, 'a skipped required step too');
  // A record from before 0.1.20 whose step about other tools failed is not kept: that step failed on every computer.
  record({ steps: { ...steps, isolation: 'fail' } }); assert.equal(conformanceState('grok'), null); assert.throws(() => requireConformance('grok', at), /Grok Build \(the grok command\) has not been checked on this machine yet\. Your first message to it outside Full access runs the check; Full access needs none\./);
  record({ steps: { ...steps, isolation: 'fail' }, loads: [{ what: 'Cursor rule', from: '/x/home/.cursor/rules/style.md', runs: false }] });
  assert.equal(requireConformance('grok', at), true, 'what it also loads is recorded and stops nothing'); assert.deepEqual(checkResult('grok', at).loads, [{ what: 'Cursor rule', from: '/x/home/.cursor/rules/style.md', runs: false }]);
  assert.equal(log.length, 0, 'no step ran');
  // The state file is read strictly: unknown shapes mean no check passed.
  fs.writeFileSync(file, JSON.stringify({ v: 1, bin: '/x/grok', version: '1.0.0', steps: { ok: 'pass', 'Bad Id': 'pass', odd: 'maybe' }, relay: 'yes' }));
  assert.deepEqual(conformanceState('grok'), { bin: '/x/grok', version: '1.0.0', steps: { ok: 'pass' }, relay: false, at: null, why: {}, stable: [], loads: [], answer: null });
  // What it holds beside the steps is read as strictly: a reason is one plain line, a load has a name, an answer is allow or deny.
  fs.writeFileSync(file, JSON.stringify({ v: 1, bin: '/x/grok', version: '1.0.0', steps: { ok: 'fail' }, why: { ok: 'line\u001b[31m one', 'Bad Id': 'x', odd: 7 }, stable: ['ok', 'Bad Id'], loads: [{ what: 'Cursor hook', from: '/x', runs: true }, { from: '/y' }, 'text', { what: 'Cursor rule', runs: 'yes' }], answer: { decision: 'perhaps', for: [] } }));
  assert.deepEqual(conformanceState('grok'), { bin: '/x/grok', version: '1.0.0', steps: { ok: 'fail' }, relay: false, at: null, why: { ok: 'line [31m one' }, stable: ['ok'], loads: [{ what: 'Cursor hook', from: '/x', runs: true }, { what: 'Cursor rule', from: null, runs: false }], answer: null });
  for (const text of ['{"v":2}', '{"v":1,"bin":"/x/grok","version":"1.0.0"}', 'not json']) { fs.writeFileSync(file, text); assert.equal(conformanceState('grok'), null, text); }
  assert.throws(() => requireConformance('grok', { bin: '/x/grok', version: '1.0.0' }), /Grok Build \(the grok command\) has not been checked on this machine yet/);
});

test('a kept reading of the vendors is read again once a check wrote its record', async t => {
  home(t);
  let reads = 0;
  const list = vendorReading(), source = () => [{ reading: ++reads }], file = path.join(personalDirectory(), 'conformance', 'grok.json');
  const record = (version, signin) => atomic(file, { v: 1, bin: '/x/grok', version, steps: { signin }, relay: false, at: new Date().toISOString() });
  assert.equal(list.kept(), null);
  assert.deepEqual(list.read(source), [{ reading: 1 }]); assert.deepEqual(list.kept(), [{ reading: 1 }]); assert.deepEqual(list.kept(), [{ reading: 1 }]);
  assert.equal(reads, 1, 'one reading serves until a check ran');
  // Grok's check passed: the reading from before still says the check is to come.
  record('1.0.0', 'pass'); assert.equal(list.kept(), null);
  assert.deepEqual(list.read(source), [{ reading: 2 }]); assert.deepEqual(list.kept(), [{ reading: 2 }]);
  // A check that failed, or ran for a new release, changes the rows as well.
  record('1.0.0', 'fail'); assert.equal(list.kept(), null); list.read(source);
  record('1.0.1', 'pass'); assert.equal(list.kept(), null);
  // A check that finishes while the vendors are being read is not missed.
  list.read(() => { record('1.0.2', 'pass'); return [{ reading: 'during' }]; }); assert.equal(list.kept(), null);
  // A source that fails leaves nothing kept, and forget drops a good reading.
  assert.throws(() => list.read(() => { throw new Error('no vendors'); }), /no vendors/); assert.equal(list.kept(), null);
  list.read(source); assert.equal(list.kept().length, 1); list.forget(); assert.equal(list.kept(), null);
});

test('a reading of the vendors that takes time is one reading for everyone who asks meanwhile, and one forgotten while it ran is never kept', async t => {
  home(t);
  const list = vendorReading(); let reads = 0, release = null;
  const slow = () => { const mine = ++reads; return new Promise(resolve => { release = () => resolve([{ reading: mine }]); }); };
  // Two ask while it runs: the programs are started once, and nothing is kept until it ends.
  const first = list.read(slow), second = list.read(slow);
  assert.equal(first, second); assert.equal(reads, 1); assert.equal(list.kept(), null);
  release(); assert.deepEqual(await first, [{ reading: 1 }]); assert.deepEqual(list.kept(), [{ reading: 1 }]);
  // Kept: the next reading is a new one.
  list.forget(); const third = list.read(slow), letThird = release; assert.equal(reads, 2);
  // Forgotten while it runs (a sign-in, r): whoever asks next starts another, and the one from before is not kept when it ends.
  list.forget(); const fourth = list.read(slow); assert.notEqual(third, fourth); assert.equal(reads, 3);
  letThird(); assert.deepEqual(await third, [{ reading: 2 }]); assert.equal(list.kept(), null);
  release(); assert.deepEqual(await fourth, [{ reading: 3 }]); assert.deepEqual(list.kept(), [{ reading: 3 }]);
  // One that fails keeps nothing and is not handed to the next who asks.
  list.forget(); await assert.rejects(list.read(() => Promise.reject(new Error('no vendors'))), /no vendors/); assert.equal(list.kept(), null);
  assert.deepEqual(await list.read(async () => [{ reading: 'after' }]), [{ reading: 'after' }]); assert.deepEqual(list.kept(), [{ reading: 'after' }]);
});
