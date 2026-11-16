import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { project, fakeClis, autoApprove, git } from './helpers.mjs';
import { changed, taskChanges } from '../lib/git.mjs';
import { ProjectController, projectSnapshot, registerProject, sessionModel, taskPatch } from '../lib/projects.mjs';
import { readTask } from '../lib/state.mjs';
import { projectFolder, pendingRequests, dropRequests, asksYes } from '../lib/workspace.mjs';
import { Conductor, enqueue, retryRequest } from '../lib/conductor.mjs';
import { sessionBots, sessionWorker } from '../lib/bots.mjs';
import { approveTask, proposeTask } from '../lib/plan.mjs';
import { readStore, saveScript } from '../lib/artifacts.mjs';
import { SCRIPT_TOOL, answerApproval, pendingApprovals, requestApproval } from '../lib/approvals.mjs';
import { remoteRow } from '../lib/board.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { createTeam } from '../lib/peer/roster.mjs';
import { createInvite, redeemCode } from '../lib/peer/invite.mjs';
import { share, setTeamProject } from '../lib/peer/shares.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { BY_HAND, hostMethods, hostTick, projectKey, relist } from '../lib/peer/remote.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';

// Where two rules meet. A session the owner wrote to a working bot (@lead) is that bot's, and
// what another computer writes over it with no @name goes to that bot, @model to its model
// (lib/peer/remote.mjs deliver, lib/bots.mjs sessionWorker). Every computer on a shared project
// acts on it under the project's /access on the computer that runs it: Auto takes its message
// at once, a project worked by hand keeps it for the owner's yes, and its turn is told the
// project's rules, whichever agent it goes to. What it may change of the session's agents and
// artifacts is the same for every computer, whoever owns it.
const SARA = 'b'.repeat(64), RULES = 'Only work on the docs folder. Never print a key.';
const LIVE = new WeakMap(), STOP_MS = 20000;
function giveUp(message) { console.error(`other-computer-lead: ${message} Ending the test process.`); process.exit(1); }
async function stopAll(t) {
  for (const conductor of LIVE.get(t) ?? []) {
    const late = setTimeout(() => giveUp(`A conductor did not stop within ${STOP_MS / 1000} s.`), STOP_MS);
    try { await conductor.stop(); } finally { clearTimeout(late); }
  }
}
after(() => { setTimeout(() => giveUp('Something is still running 10 s after the last test.'), 10000).unref(); });
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const OWNER = { GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' };
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function until(check, message, timeout = 60000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
// The stand-in Claude Code, with the --agents flag the real one has: @lead's helpers need it.
function withAgents(dir) {
  const file = path.join(dir, 'claude'), text = fs.readFileSync(file, 'utf8'), from = "console.log('--print ";
  if (!text.includes("console.log('--agents --print ")) { assert.ok(text.includes(from), 'the stand-in lists its flags'); fs.writeFileSync(file, text.replace(from, "console.log('--agents --print ")); }
}
// ana's project, shared with a team that sara's computer is on, with the rules ana wrote for it.
function shareWithSara(root, handling) {
  const me = createIdentity({ name: 'ana' }), team = createTeam(me, 'core');
  redeemCode(createInvite(me, team.id, { hours: 1 }), SARA, 'sara');
  const shared = share(root, { teams: [team.id] }); setTeamProject(team.id, shared.handle);
  saveTeamAccess(team.id, { handling, rules: RULES, root });
  return me;
}
const TASK = { title: 'Uppercase coupons', description: 'Make normalize return the code in upper case.', goal: 'Coupon codes compare equal whatever their case.', objectives: ['normalize returns upper case', 'The coupon test passes'], priority: 'medium', severity: 'low', criteria: [], estimateMinutes: null };
// ana's computer: that project, and session 1, which ana wrote to @lead (mode: its permission
// mode; artifacts: what its approved Task shows). What sara's computer asks comes over the
// link, as the daemon hands it to the host methods.
async function world(t, handling, { mode = 'ask', artifacts = null } = {}) {
  LIVE.set(t, []); t.after(() => stopAll(t));
  const p = project(t), clis = fakeClis(p.parent, { mode: 'answer' }); withAgents(clis.dir);
  environment(t, { ...clis.env, HOME: p.parent, ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, ...OWNER });
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); registerProject(controller.repo);
  const repo = controller.repo, root = repo.root, me = shareWithSara(root, handling);
  const first = await controller.ask('Look at the coupon code and plan the work.', null, { bot: 'lead', permissions: mode }).finished;
  assert.equal(first.id, '1'); assert.equal(first.messages[0].to, '@lead');
  if (artifacts) { proposeTask(repo, '1', { ...TASK, artifacts }); approveTask(repo, '1'); }
  // sara's computer on the link, and what this computer tells it of the sessions it follows.
  const heard = [];
  const link = { key: SARA, admitted: true, remoteHello: { remote: 1, shared: 1 }, notify: (method, params) => heard.push([method, params]), request: async () => { throw new Error('No answer'); } };
  const ctx = { me, session: () => null, name: () => 'sara', box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} };
  const methods = hostMethods(ctx);
  relist();
  const watched = methods['elu.remote.watch']({ ref: `${projectKey(root)}:1` }, link);
  const inputs = path.join(p.parent, 'inputs.jsonl');
  return {
    ...p, fake: clis, controller, repo, root, methods, link, watched,
    session: () => readTask(repo, '1'),
    prompts: () => rows(inputs).filter(item => item.vendor === 'claude'),
    shell: () => rows(path.join(clis.dir, 'shell.jsonl')),
    request: id => pendingRequests(root).find(row => row.id === id),
    from: text => pendingRequests(root).find(row => row.computer === SARA && row.goal === text),
    // A message sara's computer sends into session 1, with what its app says of where it goes.
    send: params => methods['elu.remote.send']({ id: watched.id, ...params }, link),
    answer: params => methods['elu.remote.answer']({ id: watched.id, ...params }, link),
    // Everything this computer has told sara's of the session, after one more look at it.
    heard: () => { relist(); hostTick({ ...ctx, session: key => key === SARA ? link : null }, Date.now() + heard.length + 1); return heard; },
  };
}
function conduct(t) { const conductor = new Conductor({ tickMs: 20 }).start(); LIVE.get(t).push(conductor); return conductor; }
// Waits for the turn of request id in session 1, and returns the roles of the turns since count.
async function turns(w, count, id) {
  await until(() => w.request(id)?.state === 'done' && w.session().runs.length > count && !['running', 'preparing'].includes(w.session().state), 'its turn');
  return w.session().runs.slice(count).map(run => run.role);
}
// A message of the chat that no agent wrote: who it was written to, and which computer sent it.
const kept = (w, text) => { const row = w.session().messages.findLast(message => message.text === text && !message.from); return row ? [row.to ?? null, row.toModel ?? null, row.computer ?? null] : null; };
const underRules = input => /The owner's rules for teammates\n@sara sent this message from another computer on this project\./.test(input) && input.includes(RULES);

test('a session written to @lead, written into from another computer of an Auto project: with no @name it is @lead\'s turn, @model the model\'s, an older ELU\'s the model\'s as before, and each is told the project\'s rules', { timeout: 180000 }, async t => {
  const w = await world(t, 'auto');
  conduct(t);
  assert.equal(sessionWorker(w.session()), 'lead');
  // No @name, from an ELU that says where it goes: @lead's, as one typed here.
  let count = w.session().runs.length;
  assert.deepEqual(w.send({ text: 'continue', typed: true, toSession: true }), { id: w.watched.id, bot: 'lead' });
  let row = w.from('continue');
  assert.deepEqual([row.state, row.bot, row.toModel, row.computer, row.typed], ['queued', 'lead', undefined, SARA, undefined], 'to @lead, as sara\'s computer\'s, and never typed here');
  assert.deepEqual(await turns(w, count, row.id), ['bot:lead']);
  assert.ok(underRules(w.prompts().at(-1).input), '@lead\'s turn for it is told the rules');
  assert.deepEqual(kept(w, 'continue'), ['@lead', null, SARA]);
  // The owner's own next message to @lead is his: no rules, and the session is still @lead's.
  count = w.session().runs.length;
  const own = enqueue(w.root, 'Now add a changelog', { continuationTaskId: '1', priority: 0, typed: true, bot: 'lead' });
  assert.deepEqual(await turns(w, count, own.id), ['bot:lead']);
  assert.ok(w.prompts().at(-1).input.includes('Now add a changelog') && !w.prompts().at(-1).input.includes(RULES), 'his own message is put under no rules');
  assert.equal(sessionWorker(w.session()), 'lead');
  // An ELU up to 0.1.33 there says nothing of where it goes: the model's, as before, under the rules.
  count = w.session().runs.length;
  assert.deepEqual(w.send({ text: 'go on', typed: true }), { id: w.watched.id });
  row = w.from('go on');
  assert.deepEqual([row.state, row.bot, row.toModel, row.computer, row.typed], ['queued', undefined, undefined, SARA, undefined]);
  assert.deepEqual(await turns(w, count, row.id), ['lead']);
  assert.ok(underRules(w.prompts().at(-1).input));
  assert.equal(sessionWorker(w.session()), 'lead', 'a message that named nobody leaves the session @lead\'s');
  // @model there: the model's, kept as written to it, under the rules.
  count = w.session().runs.length;
  assert.deepEqual(w.send({ text: 'hi', typed: true, toModel: true }), { id: w.watched.id });
  row = w.from('hi');
  assert.deepEqual([row.state, row.bot, row.toModel, row.computer], ['queued', undefined, true, SARA]);
  assert.deepEqual(await turns(w, count, row.id), ['lead']);
  assert.ok(underRules(w.prompts().at(-1).input));
  assert.deepEqual(kept(w, 'hi'), [null, true, SARA]);
});

test('in a project that takes its work by hand, a message from another computer into a session written to @lead waits for the yes, whatever the owner writes meanwhile; after the yes it is @lead\'s turn, told the rules', { timeout: 180000 }, async t => {
  const w = await world(t, 'manual');
  assert.deepEqual(w.send({ text: 'continue', typed: true, toSession: true }), { id: w.watched.id, bot: 'lead', waits: true });
  const waiting = w.from('continue');
  assert.deepEqual([waiting.state, waiting.bot, waiting.computer, waiting.typed, asksYes(waiting)], ['waiting', 'lead', SARA, undefined, true]);
  // The owner writes to @lead meanwhile: his turn runs, under no rules, and theirs still waits.
  conduct(t);
  let count = w.session().runs.length;
  const own = enqueue(w.root, 'Also fix the footer', { continuationTaskId: '1', priority: 0, typed: true, bot: 'lead' });
  assert.deepEqual(await turns(w, count, own.id), ['bot:lead']);
  assert.ok(!w.prompts().at(-1).input.includes(RULES));
  dropRequests(w.root, projectSnapshot(w.repo).superseded ?? []);
  assert.equal(w.request(waiting.id)?.state, 'waiting', 'the message that waits for a yes is still in the queue');
  assert.equal(kept(w, 'continue'), null, 'and nothing of it ran');
  // r on it, the owner's yes: it goes where it was going, as sara's computer's.
  count = w.session().runs.length;
  assert.ok(retryRequest(w.root, waiting.id));
  assert.deepEqual([w.request(waiting.id).bot, w.request(waiting.id).computer], ['lead', SARA]);
  assert.deepEqual(await turns(w, count, waiting.id), ['bot:lead']);
  assert.ok(underRules(w.prompts().at(-1).input), '@lead\'s turn for it is told the rules');
  assert.deepEqual(kept(w, 'continue'), ['@lead', null, SARA]);
});

test('what another computer changes of a session\'s agents where the project is Auto: its model with /model, and a bot it writes to joins the chat; no effort and no bot\'s model', { timeout: 180000 }, async t => {
  const w = await world(t, 'auto');
  // Nothing another computer can ask names an agent's effort, a bot's model or the list of bots.
  assert.deepEqual(Object.keys(w.methods).filter(name => /agent|effort|bots/i.test(name)), []);
  const before = sessionModel(w.repo, w.session());
  assert.notEqual(before?.model, 'sonnet');
  // /model NAME message there: the session's model changes, and the words go on to @lead.
  const took = await w.send({ text: 'sonnet And the tests', typed: true, model: true, toSession: true });
  assert.deepEqual([took.id, took.sent, took.bot, typeof took.model], [w.watched.id, true, 'lead', 'string']);
  assert.deepEqual([sessionModel(w.repo, w.session()).vendor, sessionModel(w.repo, w.session()).model], ['claude', 'sonnet'], 'the session runs on the model it named');
  assert.deepEqual([w.from('And the tests').bot, w.from('And the tests').computer], ['lead', SARA]);
  assert.deepEqual([w.session().leadEffort, w.session().botModels], [undefined, undefined], 'no effort and no bot\'s model changed');
  // A message to a bot from there adds it to the chat, as one typed here does.
  assert.ok(!sessionBots(w.session()).includes('reviewer'));
  conduct(t);
  const count = w.session().runs.length;
  assert.deepEqual(w.send({ text: '@reviewer Is the plan sound?', typed: true, toSession: true }), { id: w.watched.id, bot: 'reviewer' });
  await turns(w, count, w.from('Is the plan sound?').id);
  await until(() => pendingRequests(w.root).every(item => item.state === 'done'), 'every message');
  assert.ok(sessionBots(w.session()).includes('reviewer'));
  assert.deepEqual(kept(w, 'Is the plan sound?'), ['@reviewer', null, SARA]);
  assert.deepEqual(kept(w, 'And the tests'), ['@lead', null, SARA]);
});

test('in a project worked by hand another computer changes nothing of a session\'s agents: /model is refused, and a message to a bot waits for the yes', { timeout: 120000 }, async t => {
  const w = await world(t, 'manual');
  const before = JSON.stringify(sessionModel(w.repo, w.session())), bots = sessionBots(w.session());
  for (const text of ['sonnet And the tests', 'sonnet']) assert.throws(() => w.send({ text, typed: true, model: true, toSession: true }), { message: BY_HAND });
  assert.equal(JSON.stringify(sessionModel(w.repo, w.session())), before);
  assert.deepEqual(pendingRequests(w.root).filter(row => row.computer === SARA), [], 'and nothing of the refused message was kept');
  assert.deepEqual(w.send({ text: '@reviewer Is the plan sound?', typed: true, toSession: true }), { id: w.watched.id, bot: 'reviewer', waits: true });
  assert.equal(w.from('Is the plan sound?').state, 'waiting');
  assert.deepEqual(sessionBots(w.session()), bots, '@reviewer is not in the chat before the yes');
});

// The refresh script of an artifact runs on its own on the computer that keeps it, so it is
// allowed only there, where it shows whole, and it never leaves that computer. An Auto project
// changes none of that for another computer, a teammate's included: its message to @lead may
// lead @lead to elu artifacts script, and the question is still this computer's owner's.
const WATCHED = { title: 'Eval history', shows: 'accuracy by run', every: 5 };
const SCRIPT = ['#!/usr/bin/env node', '// Prints the last run for the Artifacts tab.', "console.log(JSON.stringify({ kind: 'note', text: 'Run 4 of the eval.' }));", ''].join('\n');
const PROBE = 'Keep the refresh script of the eval history.', QUESTION = 'Save the refresh script of "Eval history", which ELU runs every 5 min';
const REFUSED = 'A refresh script is allowed on the computer it runs on, where it shows whole. n declines it from here.';
// Whether sara's computer was told that this approval waits, and by which words.
const toldOf = (w, id) => w.heard().flatMap(([method, params]) => method === 'elu.remote.events' ? params.items : []).flatMap(item => item.events).filter(event => event.type === 'approvals').flatMap(event => event.list).find(item => item.id === id)?.summary ?? null;

test('in an Auto project another computer\'s message has @lead keep a refresh script: the question is the owner\'s here, that computer may only decline it, and the script never reaches it', { timeout: 180000 }, async t => {
  const w = await world(t, 'auto', { artifacts: [WATCHED] });
  const script = path.join(w.root, 'refresh.cjs'); fs.writeFileSync(script, SCRIPT);
  const file = path.join(w.fake.dir, 'fake.json'), keep = `elu artifacts script 1 ${JSON.stringify(script)}`;
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), asksOutside: true, shell: [{ when: PROBE, anywhere: true, run: [keep, keep, 'elu sessions'] }] }));
  assert.deepEqual(Object.keys(w.methods).filter(name => /artifact/i.test(name)), [], 'nothing another computer asks changes an artifact');
  w.heard();
  conduct(t);
  const count = w.session().runs.length;
  assert.deepEqual(w.send({ text: PROBE, typed: true, toSession: true }), { id: w.watched.id, bot: 'lead' });
  const row = w.from(PROBE), seen = new Set();
  const next = () => pendingApprovals({ taskId: '1' }).find(item => !seen.has(item.id));
  const ended = () => ['done', 'failed', 'blocked'].includes(w.request(row.id)?.state);
  // The first time: sara's computer is told of the question, with no script; its allow is refused; it declines.
  await until(() => ended() || next(), 'the question for the script');
  let asked = next();
  assert.ok(asked, `the script was kept unasked: ${JSON.stringify([w.request(row.id), w.shell()])}`);
  assert.ok(asked.summary.startsWith(QUESTION), asked.summary);
  assert.deepEqual([asked.role, asked.tool, asked.script], ['bot:lead', SCRIPT_TOOL, { artifact: 'Eval history', every: 5, text: SCRIPT }]);
  await until(() => toldOf(w, asked.id), 'the question to be told to that computer');
  assert.ok(toldOf(w, asked.id).startsWith(QUESTION));
  for (const always of [undefined, 'project']) assert.throws(() => w.answer({ approval: asked.id, decision: 'allow', ...(always ? { always } : {}) }), { message: REFUSED });
  assert.equal(readStore(w.repo, '1').items['eval history']?.script, undefined, 'nothing is kept before the owner\'s answer');
  seen.add(asked.id);
  assert.deepEqual(w.answer({ approval: asked.id, decision: 'deny' }), { answered: true });
  // The second time: the owner allows it here.
  await until(() => ended() || next(), 'the question again');
  asked = next(); assert.ok(asked, JSON.stringify(w.shell()));
  assert.ok(asked.summary.startsWith(QUESTION), asked.summary);
  seen.add(asked.id); assert.ok(answerApproval(asked.id, 'allow'));
  assert.deepEqual(await turns(w, count, row.id), ['bot:lead']);
  const ran = w.shell();
  assert.equal(ran[0].out, 'The owner did not save the refresh script of "Eval history". Nothing was saved. Do not try it another way.');
  assert.match(ran[1].out, /^Saved the refresh script of "Eval history"\./);
  assert.equal(ran[2].status, 1); assert.match(ran[2].out, /In a bot's turn, elu has elu artifacts and elu jobs\./);
  assert.equal(readStore(w.repo, '1').items['eval history'].script.text, SCRIPT);
  assert.ok(underRules(w.prompts().at(-1).input), 'the turn that kept it was told the rules');
  // What sara's computer was told, then and now, and what it reads of the Task: the artifact
  // and that it has a script, never the script.
  const look = w.methods['elu.remote.check']({ id: w.watched.id, look: true }, w.link);
  assert.deepEqual(look.artifacts, [{ title: 'Eval history', shows: 'accuracy by run', every: 5, script: true }]);
  const sent = JSON.stringify([w.heard(), look]);
  assert.ok(sent.includes('"script":true'), sent.slice(0, 2000));
  assert.ok(!sent.includes('Prints the last run') && !sent.includes('Run 4 of the eval'), 'the script stays on the computer it runs on');
});

test('a refresh script that waits here is neither allowed nor declined from another computer where the project is worked by hand, and a kept one is never sent', async t => {
  const w = await world(t, 'manual', { artifacts: [WATCHED] });
  saveScript(w.repo, '1', 'Eval history', SCRIPT);
  requestApproval({ id: 'approval-s1', root: w.root, taskId: '1', role: 'bot:lead', vendor: 'claude', tool: SCRIPT_TOOL, input: { command: 'elu artifacts script 1 refresh.cjs' }, title: QUESTION, script: { artifact: 'Eval history', every: 5, text: SCRIPT } });
  for (const decision of ['allow', 'deny']) assert.throws(() => w.answer({ approval: 'approval-s1', decision }), { message: BY_HAND });
  assert.deepEqual(pendingApprovals({ taskId: '1' }).map(item => item.id), ['approval-s1']);
  // It sees that the question waits, and that the artifact has a script.
  assert.ok(toldOf(w, 'approval-s1')?.startsWith(QUESTION));
  const sent = JSON.stringify(w.heard());
  assert.ok(sent.includes('"script":true') && !sent.includes('Prints the last run'), sent.slice(0, 2000));
});

// A session another computer started here is recorded as that computer's (origin.mine). Its
// review, like its Changes tab, is measured from the branch its pull request goes to, as the
// owner's own is (lib/git.mjs changeBase): what its branch merged in from main is no part of it.
test('the review of a session another computer started holds what its pull request would hold: its own change, never what its branch merged in from main', { timeout: 240000 }, async t => {
  const p = project(t);
  fs.writeFileSync(path.join(p.root, '.gitignore'), 'node_modules/\n'); git(p.root, ['add', '.gitignore']); git(p.root, ['commit', '-m', 'Ignore installed packages']);
  const clis = fakeClis(p.parent, { mode: 'normal', commit: 'once', tooLong: 60000 });
  environment(t, { ...clis.env, HOME: p.parent, ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, ...OWNER });
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); registerProject(controller.repo);
  const repo = controller.repo;
  // The project as a clone has it, and a teammate's clone, where other pull requests are merged into main.
  const bare = path.join(p.parent, 'origin.git'), team = path.join(p.parent, 'teammate');
  git(p.parent, ['init', '-q', '--bare', '--initial-branch=main', bare]);
  git(p.root, ['remote', 'add', 'origin', bare]); git(p.root, ['push', '-q', '-u', 'origin', 'main']); git(p.root, ['remote', 'set-head', 'origin', 'main']);
  git(p.parent, ['clone', '-q', bare, team]);
  shareWithSara(repo.root, 'auto');
  // The session, as the conductor starts one that sara's computer asked for (elu.remote.start).
  const first = await controller.ask('Normalize coupon codes', null, { bots: ['reviewer'], computer: SARA, mine: { machine: SARA, name: 'sara', remoteId: crypto.randomUUID() } }).finished;
  assert.deepEqual([first.origin?.kind, first.origin?.machine], ['mine', SARA]);
  assert.equal(first.state, 'ready', JSON.stringify(first.error)); assert.equal(first.reviewStatus, 'passed');
  const reviews = () => rows(path.join(p.parent, 'inputs.jsonl')).filter(row => row.vendor === 'claude' && row.input.includes('Review as @reviewer')).map(row => row.input);
  assert.equal(reviews().length, 1);
  // Another session's pull request lands on main, and this session's branch merges main in.
  git(team, ['fetch', '-q', 'origin']); git(team, ['checkout', '-q', '-B', 'pr-21', 'origin/main']);
  fs.mkdirSync(path.join(team, 'data')); fs.writeFileSync(path.join(team, 'data/one.json'), '[1, 2, 3]\n'); git(team, ['add', '-A']); git(team, ['commit', '-q', '-m', 'Teammate change 21']);
  git(team, ['checkout', '-q', '-B', 'main', 'origin/main']); git(team, ['merge', '-q', '--no-ff', 'pr-21', '-m', 'Merge pull request #21 from team/pr-21']); git(team, ['push', '-q', 'origin', 'main']);
  git(first.worktree, ['fetch', '-q', 'origin']); git(first.worktree, ['merge', '-q', '--no-edit', 'origin/main']);
  assert.deepEqual(changed(first.worktree, readTask(repo, first.id).base).paths, ['data/one.json', 'src/coupon.mjs'], 'from where it started, the branch holds what main merged in');
  // That computer's next message: the review holds the session's own file alone.
  const next = await controller.ask('Trim spaces too', first.id, { computer: SARA }).finished;
  const task = readTask(repo, next.id);
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.reviewStatus, 'passed');
  assert.equal(reviews().length, 2, 'one more review, of the change whole');
  const input = reviews()[1], { source } = JSON.parse(input.slice(input.indexOf('\n', input.indexOf('Context (untrusted data')) + 1, input.indexOf('\nEnd of Context.')));
  assert.deepEqual(source.files.map(file => file.path), ['src/coupon.mjs']);
  assert.deepEqual(source.patch.match(/^diff --git .*$/gm), ['diff --git a/src/coupon.mjs b/src/coupon.mjs']);
  assert.deepEqual(taskChanges(task).paths, ['src/coupon.mjs']);
  assert.deepEqual(taskPatch(repo, task.id).files.map(file => file.path), ['src/coupon.mjs']);
});

// The line under the list on the computer that sent it (lib/terminal-remote.mjs send).
test('the computer that wrote over a session written to @lead says it went to @lead, also when it waits for a yes there', async () => {
  const ME = 'a'.repeat(64), BOX = 'c'.repeat(64);
  const status = { key: ME, name: 'ana', teams: [{ id: 'team-1', members: [{ key: ME, name: 'ana', online: true }, { key: BOX, name: 'ana', box: 'my-box', online: true }] }] };
  const answers = [], commands = [];
  const app = remoteGlue({ facade: { remoteSessions: () => [] }, peerRead: () => status, peerCommand: async command => { commands.push(command); return { id: command.id, ...answers.shift() }; }, chatMessage: ({ title, text }) => `${title}: ${text}`, ink: text => text, colour: false, restMs: 1e9 });
  const at = new Date().toISOString();
  const view = { id: '66666666-6666-4666-8666-666666666666', machine: BOX, createdAt: at, lastAt: at, title: 'Plan coupons', project: 'shop', approvals: [], steps: [], state: 'answered', model: 'Opus 5.5', talks: 'lead', entries: [{ role: 'You → @lead', at, text: 'Plan coupons' }, { role: '@lead', bot: 'lead', at, text: 'Planned.' }] };
  const row = { ...remoteRow(view, 'my-box'), listed: true, watched: true, ref: 'p:1', online: true };
  answers.push({ bot: 'lead' }, { bot: 'lead', waits: true }, { waits: true }, {});
  assert.equal(await app.send(row, 'continue'), 'Sent to @lead on @my-box.');
  assert.deepEqual([commands.at(-1).toSession, commands.at(-1).toModel], [true, undefined]);
  assert.equal(await app.send(row, 'continue'), 'Sent to @lead on @my-box. It waits for a yes there.');
  // To its model (@model there): as before.
  assert.equal(await app.send(row, 'hi', { toModel: true }), 'Sent to Opus 5.5 on @my-box. It waits for a yes there.');
  assert.deepEqual([commands.at(-1).toSession, commands.at(-1).toModel], [undefined, true]);
  assert.equal(await app.send(row, 'hi', { toModel: true }), 'Sent to Opus 5.5 on @my-box.');
});
