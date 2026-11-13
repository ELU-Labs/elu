import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stopLine, logCause } from '../lib/stop-line.mjs';
import { boardRows, rowTitle } from '../lib/board.mjs';
import { STUCK_LINE } from '../lib/runner.mjs';
import * as claude from '../lib/adapters/claude.mjs';

// A session as it is kept: an edit session (no kind) unless said otherwise, whose last turn ran on Claude.
const at = '2026-11-12T10:00:00.000Z';
const session = fields => ({ id: '4', goal: 'Normalize coupons', state: 'blocked', permissions: 'full', createdAt: at, runs: [{ role: 'lead', vendor: 'claude', at }], messages: [{ at, text: 'Normalize coupons' }], ...fields });
const none = () => null;
const said = (fields, options = { logCause: none, account: none }) => stopLine(session(fields), options);

test("the owner's stopped session: 0.1.9's time limit, kept as could not finish, says it stopped, that the changes are kept, and to type continue", () => {
  const stop = said({ error: { message: 'The model could not finish.', cause: 'unknown', timedOut: true } });
  assert.equal(stop.text, 'Stopped before it finished. Your changes are kept. Type continue to carry on.');
  assert.equal(stop.action, 'Type continue to carry on.'); assert.equal(stop.short, 'type continue');
  // An answer-only turn names no changes.
  assert.equal(said({ kind: 'conversation', error: { message: 'The model could not finish.', cause: 'unknown', timedOut: true } }).text, 'Stopped before it finished. Type continue to carry on.');
  // A vendor over ACP that reports only that it could not finish, stopped by the quiet limit.
  assert.equal(said({ error: { message: 'Antigravity could not finish.', cause: 'unknown', timedOut: true, stoppedBy: 'quiet' } }).text, 'Stopped before it finished. Your changes are kept. Type continue to carry on.');
});

test("0.1.11's quiet and cap lines already say what to do, and stay as they are", () => {
  for (const message of ['Stopped after 10 minutes with no output. Your changes are kept. Reply to carry on.', 'Stopped after 2 hours, the most one turn may run. Reply to carry on.']) {
    const stop = said({ error: { message, cause: 'quiet', timedOut: true, stoppedBy: 'quiet' } });
    assert.equal(stop.text, message); assert.equal(stop.action, 'Reply to carry on.'); assert.equal(stop.short, 'reply to carry on');
  }
});

test('a turn that could not finish names the cause when it is known, then the one thing to do', () => {
  const failed = cause => said({ error: { message: 'The model could not finish.', cause, logFile: null } }).text;
  assert.equal(failed('quota'), 'The model could not finish: the account is out of usage credits. Switch account in Usage, then type continue.');
  assert.equal(failed('rate-limit'), 'The model could not finish: the account hit its rate limit. Switch account in Usage, or type continue to try again.');
  assert.equal(failed('auth'), 'The model could not finish: Claude Code is signed out. Sign in again with claude, then type continue.');
  assert.equal(failed('model-unavailable'), 'The model could not finish: that model is not available. Choose another with /model, then type continue.');
  assert.equal(failed('unknown'), 'The model could not finish. Type continue to try again.');
  // Codex signs in with its own command.
  assert.equal(said({ runs: [{ role: 'lead', vendor: 'codex', at }], error: { message: 'The model could not finish.', cause: 'unknown' } }, { logCause: () => 'auth' }).text, 'The model could not finish: Codex is signed out. Sign in again with codex login, then type continue.');
  // A bot's turn says who.
  assert.equal(said({ error: { message: '@scout could not finish.', cause: 'rate-limit' } }).text, '@scout could not finish: the account hit its rate limit. Switch account in Usage, or type continue to try again.');
  // What Claude printed on stderr stays, with the action after it.
  assert.equal(said({ error: { message: 'The model could not finish. Error: sandbox required but unavailable', cause: 'unknown' } }).text, 'The model could not finish. Error: sandbox required but unavailable. Type continue to try again.');
});

test("an unknown cause is read from the run log's last result line: credits, rate limit, sign-in, network; a turn that went on to finish is no failure", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-line-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = (name, rows) => { const file = path.join(dir, name); fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); return file; };
  const init = { type: 'system', subtype: 'init', model: 'claude-x' };
  const failing = result => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result });
  const cases = [
    [log('credits.log', [init, failing('Credit balance is too low')]), 'quota', 'The model could not finish: the account is out of usage credits. Switch account in Usage, then type continue.'],
    [log('rate.log', [init, failing('API Error: 429 rate_limit_error')]), 'rate-limit', 'The model could not finish: the account hit its rate limit. Switch account in Usage, or type continue to try again.'],
    [log('auth.log', [init, failing('Invalid API key · Please run /login')]), 'auth', 'The model could not finish: Claude Code is signed out. Sign in again with claude, then type continue.'],
    [log('network.log', [init, failing('API Error: Connection error. (ECONNRESET)')]), 'network', 'The model could not finish: the connection dropped. Type continue to try again.'],
    [log('later.log', [init, failing('API Error: Connection error.'), { type: 'result', subtype: 'success', is_error: false, result: 'ok' }]), null, 'The model could not finish. Type continue to try again.'],
    [path.join(dir, 'gone.log'), null, 'The model could not finish. Type continue to try again.'],
  ];
  for (const [file, cause, text] of cases) {
    assert.equal(logCause(file), cause, file);
    assert.equal(stopLine(session({ error: { message: 'The model could not finish.', cause: 'unknown', logFile: file } }), { account: none }).text, text, file);
  }
});

test('a limit on Claude Code or Codex names the account the run was on and says to switch in Usage; other vendors keep their line', () => {
  const asked = [], account = run => { asked.push([run.vendor, run.login ?? 'default']); return run.vendor === 'codex' ? 'work@example.com' : 'home@example.com'; };
  const limited = (runs, cause) => stopLine(session({ runs, error: { message: 'The model could not finish.', cause, logFile: null } }), { logCause: none, account });
  assert.equal(limited([{ role: 'lead', vendor: 'claude', at, login: 'k2v8m1qz' }], 'quota').text, 'The model could not finish: home@example.com is out of usage credits. Switch account in Usage, then type continue.');
  assert.equal(limited([{ role: 'lead', vendor: 'codex', at }], 'rate-limit').text, 'The model could not finish: work@example.com hit its rate limit. Switch account in Usage, or type continue to try again.');
  assert.deepEqual(asked, [['claude', 'k2v8m1qz'], ['codex', 'default']]);
  assert.equal(limited([{ role: 'lead', vendor: 'grok', at }], 'quota').text, 'The model could not finish: the account is out of usage credits. Type continue to try again.');
  assert.equal(limited([{ role: 'lead', vendor: 'claude', at }], 'network').text, 'The model could not finish: the connection dropped. Type continue to try again.');
  assert.equal(asked.length, 2, 'the account is read only for a limit');
});

test('work that cannot go on in this session says why and to start a new session', () => {
  const blocked = message => said({ error: { message } }).text;
  assert.equal(blocked('The task policy changed. Start a new task.'), 'The task policy changed. Start a new session with /new.');
  assert.equal(blocked('This task cannot be continued. Start a new task for published work.'), 'This work is published, so it cannot go on here. Start a new session with /new.');
  // A new session starts from the hooks as they are now: they are looked at first.
  assert.equal(blocked('Git hooks changed after the preview. Review the hooks before continuing.'), 'Git hooks changed after the preview. Review the hooks, then start a new session with /new.');
  assert.equal(blocked('The saved hooks are missing or changed. Start a new task before publishing.'), 'The saved hooks are missing or changed. Start a new session with /new.');
  // Every new session in such a repository is refused the same way, so /new is never the way out.
  const submodules = said({ error: { message: 'Submodules are not supported for checked tasks.' } });
  assert.equal(submodules.text, 'ELU Code cannot edit a repository that has submodules. Ask about it here instead.'); assert.doesNotMatch(submodules.text, /\/new/);
  const driver = said({ error: { message: 'Git attribute filter=lfs enables an executable driver.' } });
  assert.equal(driver.text, "Git runs a program for the filter=lfs attribute in this repository. Remove filter.lfs from Git's config, then type continue.");
  assert.doesNotMatch(driver.text, /\/new/);
  assert.equal(blocked('Git filesystem monitors can execute programs. Disable the monitor before starting a checked task.'), "Git's filesystem monitor is on, and it can run programs. Turn it off with git config core.fsmonitor false, then type continue.");
  // Too much output for one turn.
  const loud = said({ error: { message: 'The model could not finish.', cause: 'unknown', outputLimit: true } });
  assert.equal(loud.text, 'The model wrote more output than one turn may keep. Start a new session with /new.'); assert.equal(loud.short, 'start a new session');
  // A reply to work that could not go on ends with why; the session keeps no error then.
  const stuck = said({ error: null, reply: { outcome: 'done', summary: `It stopped on the coupon test.\n\n${STUCK_LINE('The task policy changed. Start a new task.')}` } });
  assert.equal(stuck.text, 'The task policy changed. Start a new session with /new.');
  assert.equal(said({ error: null, reply: { outcome: 'done', summary: STUCK_LINE('This task cannot be continued. Start a new task for published work.') } }).text, 'This work is published, so it cannot go on here. Start a new session with /new.');
});

test('a stop, a review or checks that did not pass, and older stored lines each end with one thing to do', () => {
  assert.equal(said({ state: 'stopped', error: { message: 'ELU Code stopped before this response finished. Retry to continue.' } }).text, 'ELU Code stopped before this response finished. Type continue to carry on.');
  assert.equal(said({ state: 'stopped', error: { message: 'Stopped by the owner.' } }).text, 'You stopped it. Your changes are kept. Type continue to carry on.');
  assert.equal(said({ state: 'stopped', error: null }).text, 'Stopped before it finished. Your changes are kept. Type continue to carry on.');
  assert.equal(said({ error: { message: 'The model did not answer every must-fix finding.' } }).text, 'The model did not answer every must-fix finding. Type continue to work on them.');
  assert.equal(said({ error: null, reviewStatus: 'blocked' }).text, 'The review still asks for fixes. Type continue to work on them.');
  assert.equal(said({ error: null, evidence: { results: [{ name: 'test', status: 'failed' }] } }).text, 'The checks did not pass. Type continue to fix them.');
  assert.equal(said({ error: { message: 'Claude Code is not installed or not on your PATH.' } }).text, 'Claude Code is not installed or not on your PATH. Install it, then type continue.');
  // A message that already says why and what to do is kept as it is.
  for (const message of ['Claude Code is signed out. Run claude to sign in, then send again.', 'This session has spent its $5 limit. /budget 20 raises it and /budget off removes it; then send your message again.', 'Stopped before answering. Write to @scout again and it picks up where it stopped.']) {
    assert.equal(said({ error: { message } }).text, message);
  }
  // Anything else says what happened, then to try again.
  assert.equal(said({ error: { message: 'Claude Code stopped for a reason of its own.' } }).text, 'Claude Code stopped for a reason of its own. Type continue to try again.');
});

// A Claude run refused with an API error, as the runner keeps it: who could not run, in
// Claude's words (adapter vendorError), with the cause adapter classify gives.
const init = model => ({ type: 'system', subtype: 'init', model });
const refused = extra => ({ type: 'result', subtype: 'success', is_error: true, duration_ms: 180, num_turns: 1, total_cost_usd: 0, ...extra });
// What test/fakes/claude.mjs prints for noCredits, as the real CLI does.
const NO_CREDITS = refused({ api_error_status: 429, api_error: 'model_requires_usage_credits', result: "You're out of usage credits. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue." });
const SIGNED_OUT = refused({ api_error_status: 401, api_error: 'authentication_error', result: 'Invalid API key · Please run /login' });
function kept(t, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-line-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'lead.log'), text = rows.map(row => JSON.stringify(row)).join('\n') + '\n'; fs.writeFileSync(logFile, text);
  const vendorSaid = claude.vendorError(text, { name: id => id === 'claude-fable-5-2' ? 'Fable 5.2' : id });
  return { message: `The model could not run: ${vendorSaid.text}`, cause: vendorSaid.cause, logFile };
}

test("a Claude run refused with an API error keeps Claude's words and gets the action for its cause", t => {
  // No credits for the model asked for: classify keeps model-unavailable, and continuing on the same model would fail again.
  const credits = kept(t, [init('claude-fable-5-2'), NO_CREDITS]);
  assert.equal(credits.cause, 'model-unavailable');
  const stop = stopLine(session({ error: credits }));
  assert.equal(stop.text, 'The model could not run: Claude says this account is out of usage credits for Fable 5.2. Choose another with /model, then type continue.');
  assert.equal(stop.short, 'choose another with /model, then type continue');
  // Signed out: classify says nothing of it, the log does, and the owner signs in, not /login in Claude's own app.
  const signedOut = kept(t, [init('claude-opus-5-5'), SIGNED_OUT]);
  assert.equal(signedOut.cause, 'unknown');
  assert.equal(stopLine(session({ error: signedOut })).text, 'The model could not run: Claude Code is signed out. Sign in again with claude, then type continue.');
  // Any other refusal keeps Claude's words, then to try again.
  const other = kept(t, [init('claude-opus-5-5'), refused({ api_error_status: 500, api_error: 'api_error', result: 'Internal server error' })]);
  assert.equal(stopLine(session({ error: other })).text, 'The model could not run: Claude says: Internal server error. Type continue to try again.');
});

test("a bot's or a reviewer's failed run names that run's vendor, not the lead's", () => {
  const runs = [{ role: 'lead', vendor: 'claude', at, logFile: '/runs/lead.log' }, { role: 'bot:checker', vendor: 'agy', at, logFile: '/runs/checker.log' }, { role: 'lead', vendor: 'claude', at, logFile: '/runs/lead-2.log' }];
  assert.equal(said({ runs, error: { message: 'Antigravity could not finish.', cause: 'auth', logFile: '/runs/checker.log' } }).text, 'Antigravity could not finish: Antigravity CLI is signed out. Sign in again with agy, then type continue.');
  // A Codex bot whose log reads as signed out.
  const codex = [...runs, { role: 'bot:critic', vendor: 'codex', at, logFile: '/runs/critic.log' }];
  assert.equal(said({ runs: codex, error: { message: '@critic could not finish.', cause: 'unknown', logFile: '/runs/critic.log' } }, { logCause: () => 'auth' }).text, '@critic could not finish: Codex is signed out. Sign in again with codex login, then type continue.');
  // An error that names no log is the last run's.
  assert.equal(said({ runs: codex, error: { message: '@critic could not finish.', cause: 'auth' } }).text, '@critic could not finish: Codex is signed out. Sign in again with codex login, then type continue.');
});

test("a turn stopped by the session's own /budget says so, not that the account is out of credits", t => {
  const spent = { budgetUsd: 5, runs: [{ role: 'lead', vendor: 'claude', at, costUsd: 3 }, { role: 'lead', vendor: 'claude', at, costUsd: 2.01, logFile: null }] };
  // claude.classify keeps error_max_budget_usd as quota.
  assert.equal(claude.classify(JSON.stringify(refused({ subtype: 'error_max_budget_usd', is_error: true }))), 'quota');
  const stop = said({ ...spent, error: { message: 'The model could not finish.', cause: 'quota', logFile: null } });
  assert.equal(stop.text, 'This session has spent its $5 limit. /budget 20 raises it, then type continue.');
  assert.equal(said({ budgetUsd: 100, runs: [{ role: 'lead', vendor: 'claude', at, costUsd: 100 }], error:{ message: 'The model could not finish.', cause: 'quota' } }).text, 'This session has spent its $100 limit. /budget off removes it, then type continue.');
  // A bot's own share of the limit.
  assert.equal(said({ budgetUsd: 5, runs: [{ role: 'bot:scout', vendor: 'claude', at, costUsd: 5, logFile: '/runs/scout.log' }], error: { message: '@scout could not finish.', cause: 'quota', logFile: '/runs/scout.log' } }).text, '@scout has spent its $5 limit in this session. /budget 20 raises it, then type continue.');
  // Under the limit, quota is the account's.
  assert.equal(said({ budgetUsd: 5, runs: [{ role: 'lead', vendor: 'claude', at, costUsd: 1 }], error: { message: 'The model could not finish.', cause: 'quota' } }).text, 'The model could not finish: the account is out of usage credits. Switch account in Usage, then type continue.');
  // The log says it too, when the cost of the run that stopped is not known.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-line-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'lead.log');
  fs.writeFileSync(logFile, [init('claude-opus-5-5'), refused({ subtype: 'error_max_budget_usd', is_error: true, errors: [] })].map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.equal(logCause(logFile), 'budget');
  assert.equal(stopLine(session({ budgetUsd: 5, runs: [{ role: 'lead', vendor: 'claude', at, costUnknown: true, logFile }], error: { message: 'The model could not finish.', cause: 'quota', logFile } })).text, 'This session has spent its $5 limit. /budget 20 raises it, then type continue.');
});

test('only a session that stopped and waits for the owner has the line', () => {
  for (const state of ['running', 'preparing', 'answered', 'ready']) assert.equal(said({ state, error: { message: 'The model could not finish.', timedOut: true } }), null, state);
  // Edits kept as not verified wait for the owner only when a later turn of the work failed.
  assert.equal(said({ state: 'unverified', error: null }), null, 'edits that are only not verified');
  assert.equal(said({ state: 'unverified', error: { message: 'The model could not finish.', cause: 'unknown', timedOut: true } }).text, 'Stopped before it finished. Your changes are kept. Type continue to carry on.');
  assert.equal(said({ state: 'needs_input', error: null, result: { question: 'Which page?' } }), null, 'a question is answered, not continued');
  assert.equal(said({ state: 'needs_input', error: { message: 'The model could not finish.', cause: 'unknown', timedOut: true } }).action, 'Type continue to carry on.', 'one that waits after an error says what to do');
  assert.equal(stopLine(null), null);
});

test('in the Sessions list a stopped row keeps its name, then the action where it fits; its text is the whole line', () => {
  const now = Date.parse(at) + 60000;
  const task = session({ title: 'Normalize coupons', error: { message: 'The model could not finish.', cause: 'unknown', timedOut: true } });
  const [row] = boardRows([{ name: 'shop', root: '/p/shop', activity: [], tasks: [task], queue: [] }], now);
  assert.equal(row.group, 3); assert.equal(row.label, 'blocked');
  assert.equal(row.now, 'Stopped before it finished. Your changes are kept. Type continue to carry on.');
  assert.equal(rowTitle(row, now), 'Normalize coupons · type continue');
  // A row too narrow for both keeps the whole name, which is how the session is found.
  assert.equal(rowTitle(row, now, 33), 'Normalize coupons · type continue');
  assert.equal(rowTitle(row, now, 32), 'Normalize coupons');
  // A finished session's row is its name alone, as before.
  const [done] = boardRows([{ name: 'shop', root: '/p/shop', activity: [], tasks: [{ ...task, state: 'answered', error: null, result: { summary: 'Done.' } }], queue: [] }], now);
  assert.equal(rowTitle(done, now), 'Normalize coupons');
  // Edits a later turn could not finish: the stop line, not /publish.
  const [failed] = boardRows([{ name: 'shop', root: '/p/shop', activity: [], tasks: [{ ...task, state: 'unverified' }], queue: [] }], now);
  assert.equal(failed.now, 'Stopped before it finished. Your changes are kept. Type continue to carry on.'); assert.equal(rowTitle(failed, now), 'Normalize coupons · type continue');
  const [unverified] = boardRows([{ name: 'shop', root: '/p/shop', activity: [], tasks: [{ ...task, state: 'unverified', error: null }], queue: [] }], now);
  assert.equal(unverified.now, 'edits not verified · /publish runs the checks first'); assert.equal(rowTitle(unverified, now), 'Normalize coupons');
});
