import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stopLine, logCause } from '../lib/stop-line.mjs';
import { boardRows, rowTitle } from '../lib/board.mjs';
import { STUCK_LINE } from '../lib/runner.mjs';

// A session as it is kept: an edit session (no kind) unless said otherwise, whose last turn ran on Claude.
const at = '2026-11-12T10:00:00.000Z';
const session = fields => ({ id: '4', goal: 'Normalize coupons', state: 'blocked', permissions: 'full', createdAt: at, runs: [{ role: 'lead', vendor: 'claude', at }], messages: [{ at, text: 'Normalize coupons' }], ...fields });
const none = () => null;
const said = (fields, options = { logCause: none }) => stopLine(session(fields), options);

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
  assert.equal(failed('quota'), 'The model could not finish: the account is out of usage credits. Type continue to try again.');
  assert.equal(failed('rate-limit'), 'The model could not finish: the account hit its rate limit. Type continue to try again.');
  assert.equal(failed('auth'), 'The model could not finish: Claude Code is signed out. Sign in again with claude, then type continue.');
  assert.equal(failed('model-unavailable'), 'The model could not finish: that model is not available. Choose another with /model, then type continue.');
  assert.equal(failed('unknown'), 'The model could not finish. Type continue to try again.');
  // Codex signs in with its own command.
  assert.equal(said({ runs: [{ role: 'lead', vendor: 'codex', at }], error: { message: 'The model could not finish.', cause: 'unknown' } }, { logCause: () => 'auth' }).text, 'The model could not finish: Codex is signed out. Sign in again with codex login, then type continue.');
  // A bot's turn says who.
  assert.equal(said({ error: { message: '@scout could not finish.', cause: 'rate-limit' } }).text, '@scout could not finish: the account hit its rate limit. Type continue to try again.');
  // What Claude printed on stderr stays, with the action after it.
  assert.equal(said({ error: { message: 'The model could not finish. Error: sandbox required but unavailable', cause: 'unknown' } }).text, 'The model could not finish. Error: sandbox required but unavailable. Type continue to try again.');
});

test("an unknown cause is read from the run log's last result line: credits, rate limit, sign-in, network; a turn that went on to finish is no failure", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-line-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = (name, rows) => { const file = path.join(dir, name); fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); return file; };
  const init = { type: 'system', subtype: 'init', model: 'claude-x' };
  const failing = result => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result });
  const cases = [
    [log('credits.log', [init, failing('Credit balance is too low')]), 'quota', 'The model could not finish: the account is out of usage credits. Type continue to try again.'],
    [log('rate.log', [init, failing('API Error: 429 rate_limit_error')]), 'rate-limit', 'The model could not finish: the account hit its rate limit. Type continue to try again.'],
    [log('auth.log', [init, failing('Invalid API key · Please run /login')]), 'auth', 'The model could not finish: Claude Code is signed out. Sign in again with claude, then type continue.'],
    [log('network.log', [init, failing('API Error: Connection error. (ECONNRESET)')]), 'network', 'The model could not finish: the connection dropped. Type continue to try again.'],
    [log('later.log', [init, failing('API Error: Connection error.'), { type: 'result', subtype: 'success', is_error: false, result: 'ok' }]), null, 'The model could not finish. Type continue to try again.'],
    [path.join(dir, 'gone.log'), null, 'The model could not finish. Type continue to try again.'],
  ];
  for (const [file, cause, text] of cases) {
    assert.equal(logCause(file), cause, file);
    assert.equal(stopLine(session({ error: { message: 'The model could not finish.', cause: 'unknown', logFile: file } })).text, text, file);
  }
});

test('work that cannot go on in this session says why and to start a new session', () => {
  const blocked = message => said({ error: { message } }).text;
  assert.equal(blocked('The task policy changed. Start a new task.'), 'The task policy changed. Start a new session with /new.');
  assert.equal(blocked('This task cannot be continued. Start a new task for published work.'), 'This work is published, so it cannot go on here. Start a new session with /new.');
  assert.equal(blocked('Git hooks changed after the preview. Review the hooks before continuing.'), 'Git hooks changed after the preview. Start a new session with /new.');
  assert.equal(blocked('Submodules are not supported for checked tasks.'), 'Submodules are not supported for checked tasks. Start a new session with /new.');
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
  assert.equal(said({ error: { message: 'The model could not run: Claude says this account is out of usage credits for Fable 5.2.', cause: 'quota', vendorSaid: { code: 'model_requires_usage_credits' } } }).text, 'The model could not run: Claude says this account is out of usage credits for Fable 5.2. Type continue to try again.');
});

test('only a session that stopped and waits for the owner has the line', () => {
  for (const state of ['running', 'preparing', 'answered', 'ready', 'unverified']) assert.equal(said({ state, error: { message: 'The model could not finish.', timedOut: true } }), null, state);
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
});
