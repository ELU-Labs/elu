import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, autoApprove, git } from './helpers.mjs';
import { saveBot } from '../lib/bots.mjs';
import { ProjectController, conversationEntries, registerProject } from '../lib/projects.mjs';
import { Conductor, enqueue } from '../lib/conductor.mjs';
import { pendingRequests, projectFolder } from '../lib/workspace.mjs';
import { readTask, saveTask, taskDir } from '../lib/state.mjs';
import { sessionChecklist } from '../lib/checklist.mjs';
import { assertReady } from '../lib/publish.mjs';
import { REVIEWS_HEAD, eluLine, leadAskText, leadBackText, sentByElu } from '../lib/elu-sent.mjs';
import { fitClock } from '../lib/review-fit.mjs';
import { pullsAsked, pullsIn, pullsInLog, readPulls, reviewAgain, unreviewedLines } from '../lib/pull-reviews.mjs';
import { localWord, slimOf } from '../lib/orchestrator-wake.mjs';
import * as runner from '../lib/runner.mjs';
import * as pullReviews from '../lib/pull-reviews.mjs';

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

// A gh that answers for #7 of acme/shop, and for any other pull request state.pulls names: gh pr create prints its address, as
// gh does; gh pr view and gh pr diff read state (its head commit, its diff).
const URL = 'https://github.com/acme/shop/pull/7';
const PR_DIFF = 'diff --git a/src/pr-seven.mjs b/src/pr-seven.mjs\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/pr-seven.mjs\n@@ -0,0 +1,2 @@\n+export const fromPullRequest = 7;\n+export const helper = true;\n';
function fakeGh(f) {
  const state = path.join(f.parent, 'gh.json'), calls = path.join(f.parent, 'gh-calls.jsonl');
  const set = value => fs.writeFileSync(state, JSON.stringify({ ...(fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : {}), ...value }));
  set({ url: URL, head: 'a'.repeat(40), diff: PR_DIFF, state: 'OPEN' });
  fs.writeFileSync(path.join(f.fake.dir, 'gh'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2), all = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
// Another pull request (all.pulls, by address) answers with its own number, head, diff and hold.
const s = { ...all, ...((all.pulls ?? {})[args[2]] ?? {}) };
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'pr' && args[1] === 'create') { console.error('Creating pull request for feat/coupons into main in acme/shop'); console.log(s.url); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'view') { console.log(JSON.stringify({ number: s.number ?? 7, title: s.title ?? 'Coupons', state: s.state, url: s.url, headRefOid: s.head, headRefName: 'feat/coupons', baseRefName: 'main', baseRefOid: 'b'.repeat(40) })); process.exit(0); }
if (args[0] === 'api' && String(args[1]).includes('/compare/')) { if (!s.changed) process.exit(1); console.log(JSON.stringify(s.changed)); process.exit(0); }
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
  gh.set({ head: 'c'.repeat(40), changed: ['src/pr-seven.mjs'] });
  f.mode('normal', { intent: 'answer', commands: [] });
  await f.controller.ask('Go on.', own.id).finished; await runner.pullSweepsDone();
  task = readTask(f.repo, own.id);
  assert.equal(task.pullReviews[URL].reviews.critic.head, 'c'.repeat(40));
  // Its review at the new head has its own earlier must-fix to check, and the files changed
  // since (2026-11-23: each push was reviewed anew and the must-fixes never went down).
  const again = contextOf(reviewOf(f.inputs('codex'), 'critic').filter(input => input.includes('"pullRequest":')).at(-1));
  assert.equal(again.pullRequest.head, 'c'.repeat(40));
  assert.equal(again.previousReview.head, 'a'.repeat(40));
  assert.deepEqual(again.previousReview.findings.map(row => [row.severity, row.body]), [['must_fix', 'Handle the edge case.']]);
  assert.deepEqual(again.previousReview.changedSinceReview, ['src/pr-seven.mjs']);
  assert.ok(gh.calls().some(call => call.args[0] === 'api' && call.args[1] === `repos/acme/shop/compare/${'a'.repeat(40)}...${'c'.repeat(40)}`));
  assert.equal(conversationEntries(f.repo, task).filter(row => row.pull === 7).at(-1).text, 'PR #7: Passed.');
});

// 2026-11-22: a session's lead asked its bots to review after each push. Each ask waited for the
// lead's turn, then held the session for its whole review, and the owner's messages waited behind
// every one: up to an hour. The ask now starts beside the running turn and ends at once.
test('a review the lead asks for while its turn works starts beside that turn at once, and its review holds nothing', { timeout: 240000 }, async t => {
  const f = setup(t, 'slow');
  const gh = fakeGh(f);
  const own = runner.createConversation(f.repo, f.controller.draftConfig, 'Open the coupons pull request', { permissions: 'auto', bots: ['critic'] });
  saveTask(f.repo, { ...readTask(f.repo, own.id), state: 'answered' });
  registerProject(f.controller.repo);
  const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop());
  const until = async (check, what, timeout = 20000) => { const started = Date.now(); while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 20)); } };
  const request = id => pendingRequests(f.root).find(row => row.id === id);
  enqueue(f.root, 'Go on with the coupons.', { continuationTaskId: String(own.id), priority: 0 });
  await until(() => readTask(f.repo, own.id).state === 'running', 'the lead turn to work');
  // The review waits for the diff until the test lets it go.
  const hold = path.join(f.parent, 'hold-diff'); fs.writeFileSync(hold, ''); gh.set({ hold });
  const asked = enqueue(f.root, leadAskText('critic', `review ${URL}`), { continuationTaskId: String(own.id), priority: 0, bot: 'critic', byElu: true });
  await until(() => request(asked.id)?.state === 'done', 'the ask to be done beside the turn', 10000);
  await until(() => gh.calls().some(row => row.args[0] === 'pr' && row.args[1] === 'diff'), 'its review to start', 10000);
  assert.equal(readTask(f.repo, own.id).state, 'running', 'the lead turn still works');
  assert.equal(runner.pullSweepsRunning(), 1, 'its review runs beside the session');
  // Let go, the bot reviews the pull request at its head, and what it found goes to the lead.
  f.mode('normal', { intent: 'answer', commands: [] });
  fs.rmSync(hold); await runner.pullSweepsDone(); gh.set({ hold: null });
  assert.equal(readPulls(f.repo, own.id).pulls[URL].reviews.critic.head, 'a'.repeat(40));
  await until(() => readTask(f.repo, own.id).state !== 'running', 'the lead turn to end', 60000);
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

// 2026-11-22: six asks for a review waited in one session's queue, several at a head the bot had
// reviewed, and each was a new run of the bot. Such an ask now gets that review from the record.
test('a review the lead asks for at a head the bot reviewed is answered from the record, unless the head moved, it failed or the ask says again', { timeout: 240000 }, async t => {
  const f = setup(t, 'normal'), gh = fakeGh(f);
  const own = runner.createConversation(f.repo, f.controller.draftConfig, 'Open the coupons pull request', { permissions: 'auto', bots: ['critic'] });
  saveTask(f.repo, { ...readTask(f.repo, own.id), state: 'answered' });
  f.mode('review-fix', { intent: 'answer' });
  const ask = async words => { await f.controller.ask(leadAskText('critic', words), own.id, { bot: 'critic' }).finished; await runner.pullSweepsDone(); };
  const ran = () => reviewOf(f.inputs('codex'), 'critic').filter(input => input.includes('"pullRequest":')).length;
  const given = () => pendingRequests(f.root).filter(row => row.goal.startsWith(REVIEWS_HEAD)).at(-1).goal;
  await ask(`review ${URL}`);
  assert.equal(ran(), 1); assert.match(given(), /"body":"Handle the edge case\."/);

  await ask(`review ${URL}`);
  assert.equal(ran(), 1, 'no new run at the same head');
  assert.match(given(), /"alreadyReviewed":/); assert.match(given(), /"severity":"must_fix","body":"Handle the edge case\."/);
  assert.match(conversationEntries(f.repo, readTask(f.repo, own.id)).filter(row => row.pull === 7).at(-1).text, /@critic reviewed aaaaaaa already/);
  await ask(`review ${URL}. No need to review it again if you did.`);
  assert.equal(ran(), 1, 'those words do not ask for it again');

  // A record of ELU up to 0.1.50 kept no findings: those the chat showed are given.
  const file = path.join(taskDir(f.repo, own.id), 'pulls.json');
  const edit = change => { const value = JSON.parse(fs.readFileSync(file, 'utf8')); change(value.pulls[URL].reviews.critic); fs.writeFileSync(file, JSON.stringify(value)); };
  edit(review => { delete review.comments; delete review.summary; });
  await ask(`review ${URL}`);
  assert.equal(ran(), 1, 'an older record answers too'); assert.match(given(), /"findings":"PR #7: 1 must-fix:\\n- Handle the edge case\."/);

  await ask(`review ${URL} again`);
  assert.equal(ran(), 2, 'it was asked to review again');
  await ask(`review ${URL} once more`);
  assert.equal(ran(), 3, 'once more');
  edit(review => { review.failed = 'stream disconnected'; });
  await ask(`review ${URL}`);
  assert.equal(ran(), 4, 'the last review failed');
  gh.set({ head: 'c'.repeat(40) });
  await ask(`review ${URL}`);
  assert.equal(ran(), 5, 'the head moved');
});

// 2026-11-22, on 0.1.51: a session's lead asked its bots for reviews in these words, naming each
// pull request with no address. None was read as a review ask, so each waited for the lead's
// turn and then held the session for a turn of its own, some ten minutes each.
const ASKED_BY_NAME = [
  'Review ELU-Labs/elu-web PR #327 only, at GitHub head bc09cd9d5ee0b3102737f10b6eabf0c605bd1a78. Use the matching detached checkout .elu-code/tmp/workflows-pr-heads/327-bc09cd9d5ee0b3102737f10b6eabf0c605bd1a78/tree.',
  'Review ELU-Labs/elu-web PR #335 at 4a27d4449d13275910e803161c72a0c7e209cd8b. Your earlier path-based request did not provide tools.',
  'Review ELU-Labs/elu-web PR #326 at 8a7894f140d2cf1af3ab3e8adcf6d864604ec9bb only. The current matched detached tree is .elu-code/tmp/workflows-pr-heads/326-8a7894f140d2cf1af3ab3e8adcf6d864604ec9bb/tree.',
  'Review ELU-Labs/elu-web PR #326 at 8a7894f140d2cf1af3ab3e8adcf6d864604ec9bb. The following full fix delta is against your previously reviewed 5f07054.',
  'Review ELU-Labs/elu-web PR #327 at e27cdc013455e8bca66944a36b0ec29d65b691ce only. Use the matched detached checkout .elu-code/tmp/workflows-pr-heads/327-e27cdc013455e8bca66944a36b0ec29d65b691ce/tree.',
  'Review ELU-Labs/elu-web PR #327 at e27cdc013455e8bca66944a36b0ec29d65b691ce. Here is the complete fix delta against bc09cd9 from the verified checkout.',
];
test('a review the lead asks for by name (owner/repo PR #N, owner/repo#N, or PR #N alone where the session knows one repository) starts beside its turn as one by address does', { timeout: 240000 }, async t => {
  for (const text of ASKED_BY_NAME) assert.deepEqual(pullsAsked(text)?.map(row => row.url), [`https://github.com/ELU-Labs/elu-web/pull/${/PR #(\d+)/.exec(text)[1]}`], text);
  assert.deepEqual(pullsAsked('Review acme/shop#7, acme/shop pull 8 and acme/shop pull request 9')?.map(row => row.url), [7, 8, 9].map(n => `https://github.com/acme/shop/pull/${n}`));
  assert.equal(pullsAsked('What is left in acme/shop PR #7?'), null, 'it asks for no review');
  assert.equal(pullsAsked('Review PR #7'), null, 'no repository known');
  assert.deepEqual(pullsAsked('Review PR #7', { repos: ['acme/shop'] })?.map(row => row.url), [URL]);
  assert.equal(pullsAsked('Review PR #7', { repos: ['acme/shop', 'acme/web'] }), null, 'two repositories could have it');
  assert.deepEqual(pullsAsked('Review acme/shop PR #7 at its head. It replaces PR #6.', { repos: ['acme/shop'] })?.map(row => row.number), [7], 'a number beside one named is context');
  assert.equal(reviewAgain('Review acme/shop PR #7 again'), true); assert.equal(reviewAgain('Review PR #7 once more'), true);
  assert.equal(reviewAgain(ASKED_BY_NAME[0]), false); assert.equal(reviewAgain('Review acme/shop PR #7. No need to review it again if you did.'), false);

  const f = setup(t, 'slow');
  const gh = fakeGh(f);
  const own = runner.createConversation(f.repo, f.controller.draftConfig, 'Open the coupons pull request', { permissions: 'auto', bots: ['critic'] });
  saveTask(f.repo, { ...readTask(f.repo, own.id), state: 'answered' });
  registerProject(f.controller.repo);
  const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop());
  const until = async (check, what, timeout = 20000) => { const started = Date.now(); while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 20)); } };
  const request = id => pendingRequests(f.root).find(row => row.id === id);
  const ask = words => enqueue(f.root, leadAskText('critic', words), { continuationTaskId: String(own.id), priority: 0, bot: 'critic', byElu: true });
  enqueue(f.root, 'Go on with the coupons.', { continuationTaskId: String(own.id), priority: 0 });
  await until(() => readTask(f.repo, own.id).state === 'running', 'the lead turn to work');
  const hold = path.join(f.parent, 'hold-diff'); fs.writeFileSync(hold, ''); gh.set({ hold });
  const named = ask(`Review acme/shop PR #7 only, at GitHub head ${'a'.repeat(40)}.`);
  await until(() => request(named.id)?.state === 'done', 'the ask by name to be done beside the turn', 10000);
  await until(() => gh.calls().some(row => row.args[0] === 'pr' && row.args[1] === 'diff'), 'its review to start', 10000);
  assert.equal(readTask(f.repo, own.id).state, 'running', 'the lead turn still works');
  f.mode('normal', { intent: 'answer', commands: [] });
  fs.rmSync(hold); await runner.pullSweepsDone(); gh.set({ hold: null });
  assert.equal(readPulls(f.repo, own.id).pulls[URL].reviews.critic.head, 'a'.repeat(40));
  // The session knows acme/shop now (its pulls.json): PR #7 alone is that one, answered from the record.
  const bare = ask('Review PR #7 at its head.');
  await until(() => request(bare.id)?.state === 'done', 'the ask by number to be done beside the turn', 10000);
  await runner.pullSweepsDone();
  assert.equal(readTask(f.repo, own.id).state, 'running', 'the lead turn still works');
  await until(() => readTask(f.repo, own.id).state !== 'running', 'the lead turn to end', 60000);
});

// 2026-11-22, on 0.1.51: the lead's plain question to a reviewing bot (elu sessions ask NAME,
// no pull request in it) waited for the lead's turn to end, then held the session for a turn.
test('the lead\'s plain question to a reviewing bot, sent while its turn works, is answered beside that turn by the bot, read-only, and the answer goes to the lead', { timeout: 240000 }, async t => {
  const f = setup(t, 'slow');
  const file = path.join(f.fake.dir, 'fake.json'), answer = 'The parser bug is in src/coupon.mjs, where a blank code is read as a valid one.';
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), byInput: [{ includes: 'You are not that turn: you run beside it', set: { mode: 'answer', summary: answer } }] }));
  const own = runner.createConversation(f.repo, f.controller.draftConfig, 'Tidy the coupon parser', { permissions: 'auto', bots: ['critic'] });
  saveTask(f.repo, { ...readTask(f.repo, own.id), state: 'answered' });
  registerProject(f.controller.repo);
  const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop());
  const until = async (check, what, timeout = 20000) => { const started = Date.now(); while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 20)); } };
  const request = id => pendingRequests(f.root).find(row => row.id === id);
  enqueue(f.root, 'Go on with the parser.', { continuationTaskId: String(own.id), priority: 0 });
  await until(() => readTask(f.repo, own.id).state === 'running', 'the lead turn to work');
  const asked = enqueue(f.root, leadAskText('critic', 'Which file holds the parser bug you found?'), { continuationTaskId: String(own.id), priority: 0, bot: 'critic', byElu: true }), at = Date.now();
  await until(() => request(asked.id)?.state === 'done', 'the question to be answered beside the turn', 10000);
  assert.ok(Date.now() - at < 10000, 'within seconds, not when the turn ends');
  assert.equal(readTask(f.repo, own.id).state, 'running', 'the lead turn still works');
  assert.equal(request(asked.id).aside.text, answer);
  // The bot answered on its own vendor, read-only, told the question is the lead's.
  const side = rows(f.fake.calls).filter(row => row.vendor === 'codex' && row.args[0] === 'exec').at(-1).args;
  assert.ok(side.includes('read-only'), 'read-only');
  const prompt = f.inputs('codex').findLast(row => row.input.includes('Which file holds the parser bug')).input;
  assert.match(prompt, /This session's lead \(its working agent, not the owner\) asked you, @critic,/);
  assert.ok(prompt.includes('Which file holds the parser bug you found?'));
  // Its answer waits for the lead as a note of ELU's, as when the question had a turn of its own.
  const back = pendingRequests(f.root).filter(row => row.goal === leadBackText('critic', answer));
  assert.deepEqual(back.map(row => [row.byElu, String(row.continuationTaskId), row.state]), [[true, String(own.id), 'queued']]);
  await until(() => readTask(f.repo, own.id).state !== 'running', 'the lead turn to end', 60000);
});

// 2026-11-22, on 0.1.52: a session's lead waited on its bots' review of one pull request (its
// helpers' launch gate) while they reviewed another of its pull requests first. ELU gave the lead
// the bots' findings only once every pull request of that look was reviewed, so the gate waited
// on a review it did not need. Each pull request's findings now go to the lead when its review ends.
test("each pull request's findings go to the lead as soon as its bots review it, not when every pull request of the look is reviewed", { timeout: 240000 }, async t => {
  const f = setup(t, 'review-fix', { intent: 'answer' }), gh = fakeGh(f);
  const OTHER = 'https://github.com/acme/shop/pull/8', hold = path.join(f.parent, 'hold-eight');
  fs.writeFileSync(hold, '');
  gh.set({ pulls: { [OTHER]: { url: OTHER, number: 8, title: 'Refunds', head: 'd'.repeat(40), hold } } });
  const own = runner.createConversation(f.repo, f.controller.draftConfig, 'Open the coupons and refunds pull requests', { permissions: 'auto', bots: ['critic'] });
  saveTask(f.repo, { ...readTask(f.repo, own.id), state: 'answered' });
  // The lead opened both earlier; the end of this turn looks at each.
  (await import('../lib/pull-reviews.mjs')).notePulls(f.repo, own.id, [{ url: URL, owner: 'acme', repo: 'shop', number: 7 }, { url: OTHER, owner: 'acme', repo: 'shop', number: 8 }]);
  const done = await f.controller.ask('Carry on.', own.id).finished;
  assert.notEqual(done.state, 'blocked', JSON.stringify(done.error));
  const sent = () => pendingRequests(f.root).filter(row => String(row.continuationTaskId) === String(own.id) && row.goal.startsWith(REVIEWS_HEAD)).map(row => row.goal);
  // #8's diff is held: #7's findings are with the lead already, while #8's review waits.
  const waited = Date.now();
  while (!sent().length && Date.now() - waited < 60000) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(sent().length, 1, "PR #7's findings went to the lead while PR #8 was still under review");
  assert.match(sent()[0], /Review of PR #7 \(acme\/shop\) by @critic/); assert.doesNotMatch(sent()[0], /PR #8/);
  assert.equal(runner.pullSweepsRunning(), 1, "PR #8's review is still running");
  // #8's turn comes once its diff is read: its findings go to the lead on their own.
  fs.rmSync(hold); await runner.pullSweepsDone();
  assert.equal(sent().length, 2);
  assert.match(sent()[1], /Review of PR #8 \(acme\/shop\) by @critic/); assert.doesNotMatch(sent()[1], /PR #7 /);
  const reviews = readPulls(f.repo, own.id).pulls;
  assert.equal(reviews[URL].reviews.critic.head, 'a'.repeat(40)); assert.equal(reviews[OTHER].reviews.critic.head, 'd'.repeat(40));
  // Both bots' runs are the session's, as one look's were.
  assert.equal(readTask(f.repo, own.id).runs.filter(run => run.role === 'bot:critic' && run.pullReview).length, 2);
});

// 2026-11-22: a session with its helpers' pull requests had them reviewed one after another, so
// the last waited hours for every review before it. A look's pull requests are reviewed at once.
test("a look reviews its pull requests at once: one whose diff GitHub is slow to give holds up no other", { timeout: 240000 }, async t => {
  const f = setup(t, 'review-fix', { intent: 'answer' }), gh = fakeGh(f);
  const OTHER = 'https://github.com/acme/shop/pull/8', hold = path.join(f.parent, 'hold-seven');
  fs.writeFileSync(hold, '');
  // #7, the first of the look, waits for its diff; #8 answers at once.
  gh.set({ hold, pulls: { [OTHER]: { url: OTHER, number: 8, title: 'Refunds', head: 'd'.repeat(40), hold: null } } });
  const own = runner.createConversation(f.repo, f.controller.draftConfig, 'Open the coupons and refunds pull requests', { permissions: 'auto', bots: ['critic'] });
  saveTask(f.repo, { ...readTask(f.repo, own.id), state: 'answered' });
  (await import('../lib/pull-reviews.mjs')).notePulls(f.repo, own.id, [{ url: URL, owner: 'acme', repo: 'shop', number: 7 }, { url: OTHER, owner: 'acme', repo: 'shop', number: 8 }]);
  const done = await f.controller.ask('Carry on.', own.id).finished;
  assert.notEqual(done.state, 'blocked', JSON.stringify(done.error));
  const sent = () => pendingRequests(f.root).filter(row => String(row.continuationTaskId) === String(own.id) && row.goal.startsWith(REVIEWS_HEAD)).map(row => row.goal);
  const waited = Date.now();
  while (!sent().length && Date.now() - waited < 60000) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(sent().length, 1, "PR #8 was reviewed while PR #7's diff was still on its way");
  assert.match(sent()[0], /Review of PR #8 \(acme\/shop\) by @critic/);
  fs.rmSync(hold); await runner.pullSweepsDone();
  assert.equal(sent().length, 2); assert.match(sent()[1], /Review of PR #7 \(acme\/shop\) by @critic/);
  // A look asked while another runs starts at once, and a review already running of the same head is not started twice.
  assert.equal(reviewOf(f.inputs('codex'), 'critic').filter(input => input.includes('"pullRequest":')).length, 2);
});

// 2026-11-23: a session opened its helpers' 30 pull requests, and the record kept only the newest
// 30, so the session's own open pull requests from before them fell out with their reviews.
test('the record keeps every open pull request and its reviews, however many came after it; only merged and closed ones are let go', t => {
  const f = setup(t, 'normal');
  const own = runner.createConversation(f.repo, f.controller.draftConfig, 'Open many pull requests', { permissions: 'auto', bots: ['critic'] });
  const { changePulls, notePulls, PULLS_KEPT } = pullReviews;
  const pull = n => ({ url: `https://github.com/acme/shop/pull/${n}`, owner: 'acme', repo: 'shop', number: n });
  // The session's own contract pull request, reviewed, and before it ones that were merged.
  notePulls(f.repo, own.id, Array.from({ length: PULLS_KEPT + 5 }, (_, n) => pull(n + 1)));
  changePulls(f.repo, own.id, value => { for (const row of Object.values(value.pulls)) if (row.number <= PULLS_KEPT + 4) row.state = 'MERGED'; return value; });
  changePulls(f.repo, own.id, value => { Object.assign(value.pulls[pull(PULLS_KEPT + 5).url], { state: 'OPEN', reviews: { critic: { head: 'a'.repeat(40), mustFix: 0 } } }); return value; });
  // Then its helpers' 40 pull requests, each found later.
  for (let n = 100; n < 140; n += 1) notePulls(f.repo, own.id, [pull(n)]);
  const kept = readPulls(f.repo, own.id).pulls;
  assert.deepEqual(kept[pull(PULLS_KEPT + 5).url].reviews.critic.head, 'a'.repeat(40), 'the contract pull request and its review stay');
  for (let n = 100; n < 140; n += 1) assert.ok(kept[pull(n).url], `#${n} stays`);
  // The merged ones beyond PULLS_KEPT are let go, oldest first.
  const merged = Object.values(kept).filter(row => row.state === 'MERGED').map(row => row.number);
  assert.equal(merged.length, PULLS_KEPT); assert.ok(!merged.includes(1) && merged.includes(PULLS_KEPT + 4));
});
