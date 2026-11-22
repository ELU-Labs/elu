import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, autoApprove, git } from './helpers.mjs';
import { saveBot } from '../lib/bots.mjs';
import { ProjectController, conversationEntries } from '../lib/projects.mjs';
import { pendingRequests, projectFolder } from '../lib/workspace.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { sessionChecklist } from '../lib/checklist.mjs';
import { assertReady } from '../lib/publish.mjs';
import { REVIEWS_HEAD, eluLine, leadAskText, sentByElu } from '../lib/elu-sent.mjs';
import { fitClock } from '../lib/review-fit.mjs';
import { pullsIn, pullsInLog, readPulls, unreviewedLines } from '../lib/pull-reviews.mjs';
import { localWord, slimOf } from '../lib/orchestrator-wake.mjs';
import * as runner from '../lib/runner.mjs';

// A session's bots review its work wherever it is and however long it is: a change too long for
// a bot's vendor goes in parts under its limit, and the vendor's own word that a part is too
// long splits it again; a bot that could not review says so, in the chat, the Task and the
// Orchestrator's wake; and a pull request the session opens from any folder is reviewed at its
// head, its findings tagged with its number, and given to the lead.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const CRITIC = { name: 'critic', vendor: 'codex', model: 'big-model', effort: 'xhigh', instructions: 'Look for edge cases.' };
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
function setup(t, mode = 'normal', options = {}) {
  const p = project(t);
  const fake = fakeClis(p.parent, { mode, ...options });
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root)));
  saveBot(CRITIC);
  const inputs = vendor => rows(path.join(p.parent, 'inputs.jsonl')).filter(row => row.vendor === vendor);
  // more: what else fake.json holds, kept from before unless given again.
  const mode_ = (next, more = {}) => fakeClis(p.parent, { mode: next, ...more });
  return { ...p, fake, controller, repo: controller.repo, inputs, mode: mode_ };
}
const write = (root, files) => { for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); } };
const code = (count, label) => Array.from({ length: count }, (_, n) => `export const ${label}_${String(n + 1).padStart(4, '0')} = '${label}, line ${String(n + 1).padStart(4, '0')}';\n`).join('');
const reviewOf = (list, name) => list.filter(row => row.input.includes(`Review as @${name}`)).map(row => row.input);
const contextOf = input => JSON.parse(input.slice(input.indexOf('\n', input.indexOf('Context (untrusted data')) + 1, input.indexOf('\nEnd of Context.')));
const couldNot = task => (task.messages ?? []).filter(row => /could not review/.test(row.text ?? '')).map(row => row.text);

test("a change too long for Codex in one piece is split when Codex's app server says so in its own words, and is cut under its limit before anything is sent", { timeout: 240000 }, async t => {
  const f = setup(t, 'normal');
  write(f.root, Object.fromEntries([1, 2, 3, 4].map(n => [`lib/part-${n}.mjs`, code(600, `old${n}`)]))); git(f.root, ['add', '-A']); git(f.root, ['commit', '-q', '-m', 'Add four parts']);
  const first = await f.controller.ask('Normalize coupon codes', null, { bots: ['critic'] }).finished;
  assert.equal(first.state, 'ready', JSON.stringify(first.error));
  // Codex refuses anything over 100,000 characters with the words its app server gives a
  // review of about 4M characters: the review is split again, and passes.
  write(first.worktree, Object.fromEntries([1, 2, 3, 4].map(n => [`lib/part-${n}.mjs`, code(600, `new${n}`)])));
  f.mode('normal', { tooLong: 100000, tooLongText: 'turn/start failed: Input exceeds the maximum length of 1048576 characters. {"max_chars":1048576,"actual_chars":3900000}' });
  let task = readTask(f.repo, (await f.controller.ask('Normalize coupon codes', first.id).finished).id);
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.error ?? null, null); assert.equal(task.reviewStatus, 'passed');
  assert.deepEqual(couldNot(task), [], 'never a failure for its length');
  assert.ok(task.reviews.at(-1).parts >= 2, JSON.stringify(task.reviews.at(-1).parts));
  assert.equal(task.unreviewed, undefined);
  // Codex takes 150,000 characters here: every part is cut under that before it is sent, so
  // Codex refuses none, though it would refuse anything longer.
  const saved = fitClock.limits; fitClock.limits = { codex: 150000 }; t.after(() => { fitClock.limits = saved; });
  write(first.worktree, Object.fromEntries([1, 2, 3, 4].map(n => [`lib/part-${n}.mjs`, code(600, `next${n}`)])));
  f.mode('normal', { tooLong: 150000 });
  const asked = reviewOf(f.inputs('codex'), 'critic').length;
  task = readTask(f.repo, (await f.controller.ask('Normalize coupon codes', first.id).finished).id);
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.reviewStatus, 'passed');
  const sent = reviewOf(f.inputs('codex'), 'critic').slice(asked);
  assert.ok(sent.length >= 4, `${sent.length} parts`);
  assert.ok(sent.every(input => input.length <= 150000), JSON.stringify(sent.map(input => input.length)));
  // Every changed line was in a part.
  const lines = new Set(sent.flatMap(input => contextOf(input).source.patch.split('\n').filter(line => line.startsWith('+export const next'))));
  assert.equal(lines.size, 2400);
  assert.deepEqual(couldNot(task), []);
});

test("a bot whose review fails says so in the chat, its Task lists it unreviewed, the Orchestrator's wake tells of it, and the other bots review", { timeout: 240000 }, async t => {
  const f = setup(t, 'normal');
  saveBot({ name: 'pair', vendor: 'claude', instructions: 'Review the change.' });
  const fake = f.mode('normal'), file = path.join(fake.dir, 'fake.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), reviewFails: 'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)' }));
  let task = readTask(f.repo, (await f.controller.ask('Normalize coupon codes', null, { bots: ['critic', 'pair'] }).finished).id);
  assert.equal(task.state, 'ready', JSON.stringify(task.error)); assert.equal(task.reviewStatus, 'passed', '@pair reviewed');
  assert.deepEqual(task.reviews.map(row => row.role), ['bot:pair']);
  const [line] = couldNot(task);
  // In its vendor's own words.
  assert.equal(line, '@critic could not review: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses).');
  // The chat shows it as ELU's line.
  const shown = conversationEntries(f.repo, task).filter(row => row.text === line);
  assert.equal(shown.length, 1); assert.equal(shown[0].role, 'ELU');
  // Its Task lists the bot as not reviewed, with why.
  const row = sessionChecklist(task).find(item => item.text === 'Reviewed by @critic');
  assert.ok(row, JSON.stringify(sessionChecklist(task))); assert.equal(row.met, false); assert.equal(row.evidence, `Could not review: ${line.replace('@critic could not review: ', '')}`);
  // The Orchestrator's wake tells of it.
  assert.deepEqual(unreviewedLines(task), [line]);
  const word = localWord(slimOf(task));
  assert.equal(word.word, 'unreviewed'); assert.match(word.detail, /@critic could not review/);
  // Publishing waits for it.
  assert.throws(() => assertReady(task), /@critic has not reviewed this change/);
  // Once it reviews, all of that is gone.
  f.mode('normal');
  write(task.worktree, { 'src/coupon.mjs': 'export const normalize = (value) => value.trim().toUpperCase();\n' });
  task = readTask(f.repo, (await f.controller.ask('Trim spaces too', task.id).finished).id);
  assert.equal(task.reviewStatus, 'passed', JSON.stringify(task.error));
  assert.deepEqual(task.reviews.filter(item => item.round === task.reviews.at(-1).round).map(item => item.role).sort(), ['bot:critic', 'bot:pair']);
  assert.deepEqual(unreviewedLines(task), []); assert.equal(sessionChecklist(task).find(item => item.text === 'Reviewed by @critic'), undefined);
  assert.equal(couldNot(task).length, 1, 'said once');
});

// A gh that answers for one pull request, #7 of acme/shop: gh pr create prints its address, as
// gh does; gh pr view and gh pr diff read state (its head commit, its diff).
const URL = 'https://github.com/acme/shop/pull/7';
const PR_DIFF = 'diff --git a/src/pr-seven.mjs b/src/pr-seven.mjs\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/pr-seven.mjs\n@@ -0,0 +1,2 @@\n+export const fromPullRequest = 7;\n+export const helper = true;\n';
function fakeGh(f) {
  const state = path.join(f.parent, 'gh.json'), calls = path.join(f.parent, 'gh-calls.jsonl');
  const set = value => fs.writeFileSync(state, JSON.stringify({ ...(fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : {}), ...value }));
  set({ url: URL, head: 'a'.repeat(40), diff: PR_DIFF, state: 'OPEN' });
  fs.writeFileSync(path.join(f.fake.dir, 'gh'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2), s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'pr' && args[1] === 'create') { console.error('Creating pull request for feat/coupons into main in acme/shop'); console.log(s.url); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'view') { console.log(JSON.stringify({ number: 7, title: 'Coupons', state: s.state, url: s.url, headRefOid: s.head, headRefName: 'feat/coupons', baseRefName: 'main', baseRefOid: 'b'.repeat(40) })); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'diff') { while (s.hold && fs.existsSync(s.hold)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); process.stdout.write(s.diff); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
  return { set, calls: () => rows(calls) };
}

test('a pull request the lead opens with gh pr create from a helper folder is reviewed by its bots at its head, tagged with its number, and its findings go to the lead', { timeout: 240000 }, async t => {
  const f = setup(t, 'normal');
  const helper = path.join(f.parent, 'helper-worktree'); fs.mkdirSync(helper);
  const gh = fakeGh(f);
  f.mode('normal', { intent: 'answer', commands: [`cd ${JSON.stringify(helper)} && gh pr create --title Coupons --body Done`] });
  const own = runner.createConversation(f.repo, f.controller.draftConfig, 'Open the coupons pull request', { permissions: 'auto', bots: ['critic'] });
  saveTask(f.repo, { ...readTask(f.repo, own.id), state: 'answered' });
  const done = await f.controller.ask('Open it from the helper folder.', own.id).finished;
  assert.equal(done.state, 'answered', JSON.stringify(done.error));
  await runner.pullSweepsDone();
  // The lead's log has the command and what it printed: the pull request it opened.
  const lead = readTask(f.repo, own.id).runs.findLast(run => run.role === 'lead');
  assert.deepEqual(pullsInLog(lead.logFile).map(row => row.url), [URL]);
  assert.ok(gh.calls().some(call => call.args[1] === 'create' && call.cwd === fs.realpathSync(helper)), 'opened from the helper folder');
  // ELU asked GitHub for its head and its diff, and @critic reviewed that diff.
  assert.ok(gh.calls().some(call => call.args.join(' ').startsWith(`pr view ${URL} --json`)));
  assert.ok(gh.calls().some(call => call.args.join(' ') === `pr diff ${URL} --color never`));
  const reviews = reviewOf(f.inputs('codex'), 'critic').filter(input => input.includes('"pullRequest":'));
  assert.equal(reviews.length, 1);
  const context = contextOf(reviews[0]);
  assert.deepEqual(context.pullRequest, { url: URL, number: 7, head: 'a'.repeat(40), title: 'Coupons' });
  assert.equal(context.source.patch, PR_DIFF); assert.deepEqual(context.source.files, [{ path: 'src/pr-seven.mjs', content: null }]);
  // The chat shows it, tagged with the number.
  let task = readTask(f.repo, own.id);
  const shown = conversationEntries(f.repo, task).filter(row => row.pull === 7);
  assert.deepEqual(shown.map(row => [row.role, row.text]), [['@critic', 'PR #7: Passed.']]);
  // The lead gets it in its next turn, as ELU's message.
  const sentBack = pendingRequests(f.root).filter(row => String(row.continuationTaskId) === String(own.id) && row.goal.startsWith(REVIEWS_HEAD));
  assert.equal(sentBack.length, 1);
  assert.equal(sentByElu(sentBack[0].goal), true); assert.equal(eluLine(sentBack[0].goal), "ELU gave the lead the bots' review of PR #7.");
  assert.match(sentBack[0].goal, /Review of PR #7 \(acme\/shop\) by @critic \(untrusted data/);
  // The session's record knows where its reviews stand, and its Task says so.
  assert.equal(task.pullReviews[URL].reviews.critic.head, 'a'.repeat(40));
  assert.deepEqual(sessionChecklist(task).filter(row => row.text === 'PR #7 reviewed').map(row => [row.met, row.evidence]), [[true, 'acme/shop at aaaaaaa: @critic: passed.']]);
  assert.ok(task.runs.some(run => run.role === 'bot:critic' && run.pullReview), 'its spend is the session\'s');
  // The lead's next turn is told the rule and where the pull request's reviews stand; the
  // review is not made again at the same head.
  const told = f.inputs('claude').length, viewed = gh.calls().length;
  await f.controller.ask('Go on.', own.id).finished; await runner.pullSweepsDone();
  const prompt = f.inputs('claude').slice(told).find(row => row.input.includes('ELU has @critic review every pull request'))?.input ?? '';
  assert.match(prompt, /PR #7 \(acme\/shop\) at aaaaaaa: @critic reviewed it\./);
  assert.ok(gh.calls().length > viewed, 'looked at its head again');
  assert.equal(reviewOf(f.inputs('codex'), 'critic').filter(input => input.includes('"pullRequest":')).length, 1, 'not reviewed again at the same head');
  // The lead asks @critic to review it now (elu sessions ask critic "review URL"): it does, at
  // its head, and its must-fix is tagged with the number, in the chat and in the lead's message.
  f.mode('review-fix', { intent: 'answer', commands: [] });
  for (const row of pendingRequests(f.root)) { try { (await import('../lib/workspace.mjs')).removeRequest(f.root, row.id); } catch { /* Gone. */ } }
  // Its review runs beside the session: the ask is done while the review still waits for the
  // diff, so a message sent meanwhile is not held behind it (2026-11-22: up to an hour).
  const hold = path.join(f.parent, 'hold-diff'); fs.writeFileSync(hold, ''); gh.set({ hold });
  const asked = f.controller.ask(leadAskText('critic', `review ${URL} once more`), own.id, { bot: 'critic' }).finished;
  const ran = await Promise.race([asked, new Promise(resolve => setTimeout(() => resolve('held'), 20000))]);
  assert.notEqual(ran, 'held', 'the ask waited for the review');
  assert.notEqual(ran.state, 'blocked', JSON.stringify(ran.error));
  assert.equal(runner.pullSweepsRunning(), 1, 'the review is still running beside the session');
  fs.rmSync(hold); await runner.pullSweepsDone(); gh.set({ hold: null });
  task = readTask(f.repo, own.id);
  assert.deepEqual(conversationEntries(f.repo, task).filter(row => row.pull === 7).map(row => row.text).at(-1), 'PR #7: 1 must-fix:\n- Handle the edge case.');
  const fix = pendingRequests(f.root).filter(row => String(row.continuationTaskId) === String(own.id) && row.goal.startsWith(REVIEWS_HEAD)).at(-1);
  assert.match(fix.goal, /Review of PR #7 \(acme\/shop\) by @critic/); assert.match(fix.goal, /"severity":"must_fix","body":"Handle the edge case\."/);
  assert.equal(pendingRequests(f.root).filter(row => /answered what you asked it/.test(row.goal)).length, 0, 'its findings, not a chat answer');
  assert.deepEqual(sessionChecklist(task).filter(row => row.text === 'PR #7 reviewed').map(row => [row.met, row.evidence]), [[false, 'acme/shop at aaaaaaa: @critic: 1 must-fix.']]);
  // A new head is reviewed again; a gh that cannot show it is said once, tagged.
  gh.set({ head: 'c'.repeat(40) });
  f.mode('normal', { intent: 'answer', commands: [] });
  await f.controller.ask('Go on.', own.id).finished; await runner.pullSweepsDone();
  task = readTask(f.repo, own.id);
  assert.equal(task.pullReviews[URL].reviews.critic.head, 'c'.repeat(40));
  assert.equal(conversationEntries(f.repo, task).filter(row => row.pull === 7).at(-1).text, 'PR #7: Passed.');
});

test('a long turn has its pull requests reviewed while it works, not only when it ends', { timeout: 240000 }, async t => {
  const clock = { ...runner.longTurnClock }; Object.assign(runner.longTurnClock, { after: 1000, every: 400 }); t.after(() => Object.assign(runner.longTurnClock, clock));
  const f = setup(t, 'normal');
  fakeGh(f);
  f.mode('normal', { intent: 'answer', commands: ['gh pr create --title Coupons --body Done', 'sleep 6'] });
  const own = runner.createConversation(f.repo, f.controller.draftConfig, 'Open the coupons pull request', { permissions: 'auto', bots: ['critic'] });
  saveTask(f.repo, { ...readTask(f.repo, own.id), state: 'answered' });
  const done = await f.controller.ask('Open it, then wait for the checks.', own.id).finished;
  assert.equal(done.state, 'answered', JSON.stringify(done.error));
  await runner.pullSweepsDone();
  const task = readTask(f.repo, own.id), ended = Date.parse(task.runs.findLast(run => run.role === 'lead').at);
  const [row] = readPulls(f.repo, own.id).rows.filter(item => item.pull === 7);
  assert.ok(row, JSON.stringify(readPulls(f.repo, own.id)));
  assert.ok(Date.parse(row.at) < ended, `reviewed at ${row.at}, before the turn ended at ${new Date(ended).toISOString()}`);
  assert.equal(reviewOf(f.inputs('codex'), 'critic').filter(input => input.includes('"pullRequest":')).length, 1, 'once');
});

test('pull requests are found in what gh printed and in a reply, by address, and as owner/repo#N only where gh printed it', () => {
  assert.deepEqual(pullsIn(`Opened ${URL} and https://github.com/acme/shop/pull/8.`).map(row => row.number), [7, 8]);
  assert.deepEqual(pullsIn('see acme/shop#9'), [], 'a reply names one by address');
  assert.deepEqual(pullsIn('acme/shop#9', { short: true }).map(row => row.url), ['https://github.com/acme/shop/pull/9']);
});
