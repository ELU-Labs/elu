import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { project, fakeClis, vendorPath } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { ProjectController, registerProject } from '../lib/projects.mjs';
import { readTask } from '../lib/state.mjs';
import { pendingRequests, projectFolder } from '../lib/workspace.mjs';
import { Conductor } from '../lib/conductor.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { createTeam } from '../lib/peer/roster.mjs';
import { createInvite, redeemCode } from '../lib/peer/invite.mjs';
import { share } from '../lib/peer/shares.mjs';
import { message } from '../lib/peer/a2a.mjs';
import { intakeMethods } from '../lib/peer/intake.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { saveBot } from '../lib/bots.mjs';
import * as models from '../lib/models.mjs';

// A computer where Grok Build is the only vendor installed: the stand-in grok is on PATH, and
// no claude, codex or agy is (helpers.mjs, vendorPath).
const SARA = 'b'.repeat(64);
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const LIVE = new WeakMap();
function setup(t, keep = ['grok']) {
  LIVE.set(t, []); t.after(async () => { for (const conductor of LIVE.get(t)) await conductor.stop(); });
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer' }), only = vendorPath(p.parent, fake.dir, keep);
  environment(t, { ...fake.env, PATH: only.PATH, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  // Grok Build is signed in, and its one-time check passed on this computer.
  fs.mkdirSync(path.join(p.parent, '.grok')); fs.writeFileSync(path.join(p.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
  if (keep.includes('grok')) atomic(path.join(personalDirectory(), 'conformance', 'grok.json'), { v: 1, bin: fs.realpathSync(path.join(only.dir, 'grok')), version: '1.0.77', steps: Object.fromEntries(ADAPTERS.grok.conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });
  const repo = repository(p.root); registerProject(repo);
  return { ...p, repo, only, with: more => vendorPath(p.parent, fake.dir, more).PATH };
}
function conduct(t) { const conductor = new Conductor({ tickMs: 20 }).start(); LIVE.get(t).push(conductor); return conductor; }
async function until(check, label, timeout = 60000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const request = (root, id) => pendingRequests(root).find(row => row.id === id);
const lastRun = (repo, id) => readTask(repo, id).runs.at(-1);

test("on a computer with only Grok Build, a teammate's message starts a session that runs on Grok Build with nothing set", async t => {
  const p = setup(t);
  const me = createIdentity({ name: 'ana' }), team = createTeam(me, 'core');
  redeemCode(createInvite(me, team.id, { hours: 1 }), SARA, 'sara');
  share(p.root, { teams: [team.id], handle: 'app' });
  saveTeamAccess(team.id, { handling: 'auto', root: p.root });
  const methods = intakeMethods({ me, kick: () => {}, event: () => {}, push: () => {} });
  const sent = methods.SendMessage({ message: message({ text: 'Where is coupon normalization?', contextId: 'thread-1', messageId: crypto.randomUUID(), ext: { kind: 'ask', project: 'app', hop: 1, from: { key: SARA, name: 'sara' } } }) }, { key: SARA });
  const row = pendingRequests(p.root).find(item => item.origin?.a2aTaskId === sent.id);
  assert.equal(row.state, 'queued'); assert.equal(row.origin.own, true, "Auto starts it as the owner's own session");
  conduct(t);
  await until(() => ['done', 'failed'].includes(request(p.root, row.id)?.state), 'the session to run or fail');
  const ended = request(p.root, row.id);
  assert.equal(ended.state, 'done', `it ran: ${ended.reason ?? ended.error ?? ''}`);
  const task = readTask(p.repo, ended.taskId), run = task.runs.at(-1);
  assert.ok(run, `a model answered: ${JSON.stringify(task.messages.at(-1))}`);
  assert.equal(run.vendor, 'grok'); assert.equal(task.state, 'answered', JSON.stringify(task.error));
});

test('a new session and a bot that names no model run on Grok Build there; a bot that names its model keeps it', async t => {
  const p = setup(t), controller = new ProjectController(projectFolder(p.root));
  assert.deepEqual(controller.defaultModel(), { vendor: 'grok', model: null });
  const task = await controller.ask('Where is coupon normalization?').finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error)); assert.equal(lastRun(p.repo, task.id).vendor, 'grok');
  // A bot saved for Claude Code with no model runs on this computer's default here.
  saveBot({ name: 'scout', vendor: 'claude', model: null, instructions: 'Look for risks.' });
  const asked = await controller.ask('Thoughts?', task.id, { bot: 'scout' }).finished;
  const run = readTask(p.repo, asked.id).runs.at(-1);
  assert.equal(run.role, 'bot:scout'); assert.equal(run.vendor, 'grok');
  assert.deepEqual(models.botHere({ name: 'scout', vendor: 'claude', model: null, effort: 'max', subagents: 'sonnet' }), { name: 'scout', vendor: 'grok', model: null, effort: null, subagents: null });
  // One that names its model is not moved: it says why it cannot start.
  saveBot({ name: 'judge', vendor: 'claude', model: 'opus', instructions: 'Judge it.' });
  const judged = await controller.ask('And you?', task.id, { bot: 'judge' }).finished.then(value => JSON.stringify([value.error, value.messages.at(-1)]), error => error.message);
  assert.match(judged, /@judge can't start\. Claude Code is not installed or not on your PATH\./);
  // A review is only moved to a vendor that can review, which Grok Build cannot.
  assert.equal(models.botHere({ name: 'scout', vendor: 'claude', model: null }, { review: true }).vendor, 'claude');
});

test("the default is the project's choice, else this computer's, else the first vendor installed; a saved one whose vendor is not installed is passed over and named", t => {
  const p = setup(t), controller = new ProjectController(projectFolder(p.root)), config = () => new ProjectController(projectFolder(p.root)).draftConfig;
  const all = p.with(['claude', 'codex', 'agy', 'grok']), codexGrok = p.with(['codex', 'grok']), none = p.with([]);
  const at = (PATH, settings = config()) => models.startModel(settings, { env: { ...process.env, PATH } });
  // Nothing chosen anywhere: the first installed, in the usual order.
  assert.deepEqual(at(all), { from: 'installed', vendor: 'claude', model: 'opus', missing: [] });
  assert.deepEqual(at(codexGrok), { from: 'installed', vendor: 'codex', model: null, missing: [] });
  assert.deepEqual(at(p.only.PATH), { from: 'installed', vendor: 'grok', model: null, missing: [] });
  assert.deepEqual(at(none), { from: 'none', vendor: 'claude', model: 'opus', missing: [] });
  // This computer's default is used by a project that has not chosen.
  assert.equal(models.computerDefault(), null);
  models.saveComputerDefault({ vendor: 'grok', model: 'grok-4.6' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(personalDirectory(), 'default-model.json'), 'utf8')), { version: 1, default: { vendor: 'grok', model: 'grok-4.6' } });
  assert.deepEqual(at(all), { from: 'computer', vendor: 'grok', model: 'grok-4.6', missing: [] });
  assert.deepEqual(at(all, null), { from: 'computer', vendor: 'grok', model: 'grok-4.6', missing: [] });
  // The project's own choice wins.
  environment(t, { PATH: all });
  controller.setDefaultModel({ vendor: 'codex', model: 'gpt-6.1-sol' });
  assert.deepEqual(at(all), { from: 'project', vendor: 'codex', model: 'gpt-6.1-sol', missing: [] });
  // Its vendor is not installed here: this computer's default is used, and the project's is named.
  assert.deepEqual(at(p.only.PATH), { from: 'computer', vendor: 'grok', model: 'grok-4.6', missing: [{ from: 'project', vendor: 'codex', model: 'gpt-6.1-sol' }] });
  assert.equal(models.passedOver(at(p.only.PATH).missing, row => row.model), "gpt-6.1-sol is this project's default, but Codex is not installed here.");
  // Neither saved default can run: the first installed, and both are named.
  const claudeOnly = p.with(['claude']);
  assert.deepEqual(at(claudeOnly), { from: 'installed', vendor: 'claude', model: 'opus', missing: [{ from: 'project', vendor: 'codex', model: 'gpt-6.1-sol' }, { from: 'computer', vendor: 'grok', model: 'grok-4.6' }] });
  assert.deepEqual(at(none).from, 'none'); assert.equal(at(none).vendor, 'codex');
  // none: the project goes back to this computer's, and this computer to the first installed.
  controller.setDefaultModel(null);
  assert.deepEqual(at(all), { from: 'computer', vendor: 'grok', model: 'grok-4.6', missing: [] });
  models.saveComputerDefault(null); assert.equal(models.computerDefault(), null);
  assert.deepEqual(at(all), { from: 'installed', vendor: 'claude', model: 'opus', missing: [] });
  // A file that is not a model is no default.
  fs.writeFileSync(path.join(personalDirectory(), 'default-model.json'), '{"version":1,"default":{"vendor":"nope","model":"x"}}');
  assert.equal(models.computerDefault(), null);
});
