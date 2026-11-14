import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { project, fakeClis, vendorPath, autoApprove } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { ProjectController, conversationEntries, registerProject } from '../lib/projects.mjs';
import { readTask } from '../lib/state.mjs';
import { pendingRequests, projectFolder } from '../lib/workspace.mjs';
import { Conductor } from '../lib/conductor.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import { CAPS } from '../lib/vendors.mjs';
import { conformanceState } from '../lib/conformance.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { createTeam } from '../lib/peer/roster.mjs';
import { createInvite, redeemCode } from '../lib/peer/invite.mjs';
import { share } from '../lib/peer/shares.mjs';
import { TaskState, message } from '../lib/peer/a2a.mjs';
import { intakeMethods } from '../lib/peer/intake.mjs';
import { acceptIncoming, processOutbox } from '../lib/peer/replies.mjs';
import { getRecord } from '../lib/peer/taskstore.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { BUILT_IN_BOTS, botVendors, getBot, saveBot } from '../lib/bots.mjs';
import { botLines, botNotes } from '../lib/terminal-bots.mjs';
import * as models from '../lib/models.mjs';
import * as runner from '../lib/runner.mjs';

// A computer where one vendor is the only one installed: its stand-in is on PATH, and no
// other vendor's is (helpers.mjs, vendorPath). Most of these are a computer with only Grok
// Build. The owner here is kai; ana is the teammate who writes to him.
const ANA = 'a'.repeat(64);
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const RELEASE = { grok: '1.0.77', agy: '1.5.4' };
const LIVE = new WeakMap();
// checked: the one-time check of each vendor that needs one has passed on this computer.
// helper: the owner named the sandbox his project's checks run in (ELU_CODE_SANDBOX_HELPER),
// which no vendor on PATH gives here; checks never run outside it.
function setup(t, { keep = ['grok'], fake: options = { mode: 'answer' }, checked = true, helper = false } = {}) {
  LIVE.set(t, []); t.after(async () => { for (const conductor of LIVE.get(t)) await conductor.stop(); });
  const p = project(t), fake = fakeClis(p.parent, options), only = vendorPath(p.parent, fake.dir, keep);
  // The check keeps its throwaway folder under TMPDIR: a real folder here, so it runs wherever the suite does.
  environment(t, { ...fake.env, ...(helper ? { ELU_CODE_SANDBOX_HELPER: path.join(fake.dir, 'codex') } : {}), PATH: only.PATH, HOME: p.parent, TMPDIR: fs.realpathSync(os.tmpdir()), GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  // Grok Build is signed in.
  fs.mkdirSync(path.join(p.parent, '.grok')); fs.writeFileSync(path.join(p.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
  if (checked) for (const vendor of keep.filter(name => CAPS[name].conformance)) atomic(path.join(personalDirectory(), 'conformance', `${vendor}.json`), { v: 1, bin: fs.realpathSync(path.join(only.dir, vendor)), version: RELEASE[vendor], steps: Object.fromEntries(ADAPTERS[vendor].conformance.map(step => [step.id, 'pass'])), relay: vendor === 'grok', at: new Date().toISOString() });
  const repo = repository(p.root); registerProject(repo);
  const calls = () => fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { ...p, repo, only, calls };
}
function conduct(t) { const conductor = new Conductor({ tickMs: 20 }).start(); LIVE.get(t).push(conductor); return conductor; }
async function until(check, label, timeout = 60000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const request = (root, id) => pendingRequests(root).find(row => row.id === id);
const said = task => task.status.message?.parts?.map(part => part.text).join(' ') ?? null;
// Kai's daemon as far as a message goes: ana is on his team, the project is the one her
// messages run in, and send() delivers one of hers as the wire would.
function answering(p, handling) {
  const me = createIdentity({ name: 'kai' }), team = createTeam(me, 'core');
  redeemCode(createInvite(me, team.id, { hours: 1 }), ANA, 'ana');
  share(p.root, { teams: [team.id], handle: 'shop' });
  saveTeamAccess(team.id, { handling, root: p.root });
  const pushed = [], ctx = { me, kick: () => {}, event: () => {}, push: (key, task) => pushed.push({ key, task }) }, methods = intakeMethods(ctx);
  const send = (text, more = {}) => methods.SendMessage({ message: message({ text, contextId: crypto.randomUUID(), messageId: crypto.randomUUID(), ext: { kind: 'ask', project: 'shop', hop: 1, from: { key: ANA, name: 'ana' }, ...more } }) }, { key: ANA });
  return { ctx, send, pushed };
}
const BOTS = ['reviewer', 'lead', 'qa', 'pair'];

test('on a computer with only Grok Build, an edit is reviewed by @reviewer on Grok Build and reaches ready', async t => {
  const p = setup(t, { fake: { mode: 'normal', grok: 'edits' }, helper: true }), controller = autoApprove(new ProjectController(projectFolder(p.root)));
  const task = await controller.ask('Normalize coupon codes', null, { permissions: 'ask' }).finished;
  assert.equal(task.error, null, JSON.stringify(task.error)); assert.equal(task.state, 'ready');
  assert.equal(fs.readFileSync(path.join(task.worktree, 'src/coupon.mjs'), 'utf8'), 'export const normalize = (value) => value.toUpperCase();\n', 'the edit was made');
  // The session has @reviewer, as every new one does, and its review ran here, on Grok Build.
  assert.equal(task.reviewStatus, 'passed'); assert.deepEqual(task.reviews.map(review => review.role), ['bot:reviewer']);
  assert.deepEqual([...new Set(task.runs.map(run => run.vendor))], ['grok']);
  assert.ok(task.evidence.results.every(row => row.status === 'passed'), JSON.stringify(task.evidence.results));
  assert.equal(conversationEntries(p.repo, task).filter(row => row.bot === 'reviewer').at(-1).text, 'Passed.', 'the chat shows the review');
  // The review ran on the Read only launch: the read-only sandbox, no tool that writes, runs a command or fetches.
  const review = p.calls().filter(call => call.vendor === 'grok' && call.args.includes('--prompt-file')).at(-1).args;
  assert.equal(review[review.indexOf('--sandbox') + 1], 'read-only'); assert.equal(review[review.indexOf('--tools') + 1], 'read_file,grep,list_dir');
});

test('@reviewer, @lead, @qa and @pair each answer there, and Grok Build can be a bot\'s vendor', async t => {
  const p = setup(t, { fake: { mode: 'answer', grok: 'edits' } }), controller = new ProjectController(projectFolder(p.root));
  const task = await controller.ask('Where is coupon normalization?').finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  for (const name of BOTS) {
    const asked = await controller.ask('What do you make of it?', task.id, { bot: name }).finished, run = asked.runs.at(-1), reply = asked.messages.at(-1);
    assert.deepEqual([run.role, run.vendor], [`bot:${name}`, 'grok'], name);
    assert.deepEqual([reply.bot, reply.failed ?? false, reply.text], [name, false, 'Done as asked.'], JSON.stringify(reply));
  }
  // The bots are saved as they came: only where they run is this computer's.
  assert.deepEqual(BOTS.map(name => getBot(name).vendor), ['claude', 'claude', 'claude', 'codex']);
  // The Bots tab says where each runs here, and its page says why.
  const rows = botLines(BOTS.map(getBot), 200, false);
  for (const row of rows) assert.match(row, /\bgrok here\b/);
  assert.doesNotMatch(rows[1], /Opus helpers/, "@lead's helpers start on Claude Code only, so its row names none here");
  assert.equal(botNotes(getBot('reviewer'), [])[0], 'Claude Code is not installed here, so this bot runs on Grok Build.');
  assert.equal(botNotes(getBot('pair'), [])[0], 'Codex is not installed here, so this bot runs on Grok Build.');
  // A bot can be saved on Grok Build, and answers.
  assert.ok(botVendors().includes('grok'));
  saveBot({ name: 'scout', vendor: 'grok', instructions: 'Look for risks.' });
  const scouted = await controller.ask('Thoughts?', task.id, { bot: 'scout' }).finished;
  assert.deepEqual([scouted.runs.at(-1).role, scouted.runs.at(-1).vendor], ['bot:scout', 'grok']);
});

test('a computer with only Codex, or only Antigravity CLI: every built-in bot runs on what is installed', async t => {
  for (const [vendor, expected] of [['codex', { reviewer: null, lead: null, qa: null, pair: 'gpt-6.1-sol' }], ['agy', { reviewer: null, lead: null, qa: null, pair: null }]]) {
    await t.test(vendor, async t => {
      const p = setup(t, { keep: [vendor] }), controller = new ProjectController(projectFolder(p.root));
      assert.equal(controller.defaultModel().vendor, vendor);
      // Each built-in bot, as it runs here: the vendor installed, and its own model only where that vendor is its own.
      for (const name of BOTS) assert.deepEqual([models.botHere(getBot(name)).vendor, models.botHere(getBot(name)).model], [vendor, expected[name]], name);
      assert.equal(models.botHere(getBot('reviewer'), { review: true }).vendor, vendor, 'and it reviews there');
      const task = await controller.ask('Where is coupon normalization?').finished;
      assert.equal(task.state, 'answered', JSON.stringify(task.error));
      for (const name of ['reviewer', 'pair']) {
        const asked = await controller.ask('What do you make of it?', task.id, { bot: name }).finished, run = asked.runs.at(-1);
        assert.deepEqual([run.role, run.vendor, asked.messages.at(-1).failed ?? false], [`bot:${name}`, vendor, false], JSON.stringify(asked.messages.at(-1)));
      }
    });
  }
});

test('where no vendor installed can review, a bot is not moved and the chat line says the change was not reviewed', t => {
  setup(t);
  const reviewer = BUILT_IN_BOTS.find(bot => bot.name === 'reviewer');
  // Grok Build reviews, so the review moves to it; the model named for Claude Code goes with Claude Code.
  assert.deepEqual(models.botHere(reviewer, { review: true }), { ...reviewer, vendor: 'grok', model: null, effort: null, subagents: null });
  assert.equal(models.reviewsHere(), true);
  // A vendor that could not review would take no review: the bot stays as saved, and nothing here reviews.
  const caps = { ...CAPS, grok: { ...CAPS.grok, reviewer: false } };
  assert.equal(models.botHere(reviewer, { review: true, caps }), reviewer);
  assert.equal(models.reviewsHere({ caps }), false);
  assert.equal(models.botHere(reviewer, { caps }).vendor, 'grok', 'its other turns still run here');
  assert.equal(runner.NOT_REVIEWED, 'Not reviewed: no model on this computer can review.');
});

test("a teammate's message on a fresh computer starts the one-time check of Grok Build itself, and is answered", async t => {
  const p = setup(t, { checked: false }), kai = answering(p, 'auto');
  assert.equal(conformanceState('grok'), null, 'Grok Build was never checked here');
  const sent = kai.send('Where is coupon normalization?'), row = pendingRequests(p.root).find(item => item.origin?.a2aTaskId === sent.id);
  assert.equal(row.origin.own, true, "Auto starts it as the owner's own session");
  conduct(t);
  await until(() => ['done', 'failed'].includes(request(p.root, row.id)?.state), 'the session to run or fail', 240000);
  const ended = request(p.root, row.id), task = readTask(p.repo, ended.taskId);
  assert.equal(task.state, 'answered', JSON.stringify([ended.reason, task.error]));
  assert.equal(task.runs.at(-1).vendor, 'grok');
  // The chat there shows the check, and that it passed.
  const lines = task.messages.filter(item => item.from === 'ELU').map(item => item.text);
  assert.deepEqual(lines, ['One-time check of Grok Build on this machine first: about seven short turns on it, a few minutes.', 'Grok Build 1.0.77 passed its check on this machine.']);
  assert.equal(conformanceState('grok').version, '1.0.77');
});

test("a message that waits for the owner's y says so to its sender, with what the owner can do; his y starts the check too", async t => {
  const p = setup(t, { checked: false }), kai = answering(p, 'manual');
  const sent = kai.send('Where is coupon normalization?');
  assert.equal(sent.status.state, TaskState.SUBMITTED);
  assert.equal(said(sent), 'It waits for its owner on @kai, who approves each message from a teammate. On @kai: y on the message starts it, and /access set to Auto starts the next ones without asking.');
  assert.equal(pendingRequests(p.root).length, 0, 'nothing starts until he says so');
  // His y: the session starts, and its sender is no longer told that it waits.
  const accepted = acceptIncoming(kai.ctx, sent.id, { how: 'own' });
  assert.equal(said(accepted), null); assert.deepEqual(kai.pushed.at(-1), { key: ANA, task: accepted });
  const row = pendingRequests(p.root).find(item => item.origin?.a2aTaskId === sent.id);
  conduct(t);
  await until(() => ['done', 'failed'].includes(request(p.root, row.id)?.state), 'the session to run or fail', 240000);
  const task = readTask(p.repo, request(p.root, row.id).taskId);
  assert.equal(task.state, 'answered', JSON.stringify(task.error)); assert.equal(task.runs.at(-1).vendor, 'grok');
  assert.ok(task.messages.some(item => item.from === 'ELU' && /passed its check on this machine/.test(item.text)));
});

test("a teammate's question on a computer without Claude Code is not run: both sides read why, and what the owner can do", async t => {
  const p = setup(t), kai = answering(p, 'manual');
  const owner = "A teammate's question is answered by Claude Code only, and it is not installed here. Set /access to Auto, and teammates' messages start sessions on your model instead.";
  const asker = "@kai has no model that can answer a teammate's question: that takes Claude Code, which is not installed there. Its owner can let your messages start sessions instead: /access on @kai, then Auto.";
  // The read-only question, and the same asked of a bot kai shares.
  saveBot({ name: 'helper', vendor: 'claude', model: 'opus', shared: true, instructions: 'Explain where things are.' });
  conduct(t);
  for (const more of [{}, { bot: 'helper' }]) {
    const sent = kai.send('Where is coupon normalization?', more);
    if (more.bot) assert.equal(said(sent), 'It waits for its owner on @kai: a question for @helper is approved each time. On @kai: y on the message has @helper answer it.');
    acceptIncoming(kai.ctx, sent.id, { how: 'answer' });
    const row = pendingRequests(p.root).find(item => item.origin?.a2aTaskId === sent.id);
    assert.equal(row.origin.kind, 'ask'); assert.equal(row.readOnly, true);
    await until(() => request(p.root, row.id)?.state === 'done', 'the question to end');
    assert.equal(request(p.root, row.id).reason, owner, 'the owner reads why, and what he can do');
    processOutbox(kai.ctx);
    const reply = getRecord(sent.id).task;
    assert.equal(reply.status.state, TaskState.FAILED); assert.equal(said(reply), asker);
    assert.deepEqual(kai.pushed.at(-1), { key: ANA, task: reply }, 'the teammate is told at once');
  }
  // What hardening protects is kept: no model was given the question on another vendor's launch.
  assert.deepEqual(p.calls().filter(call => call.args.includes('--prompt-file') || call.args.includes('stdio')), []);
  for (const vendor of ['codex', 'agy', 'grok']) assert.equal(CAPS[vendor].peer, false, vendor);
});
