import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis } from './helpers.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { conformanceState } from '../lib/conformance.mjs';
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
function onlyGrok(t, { grok = undefined } = {}) {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer' }), config = path.join(fake.dir, 'fake.json');
  for (const other of ['claude', 'codex', 'agy']) fs.rmSync(path.join(fake.dir, other));
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
