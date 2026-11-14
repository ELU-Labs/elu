import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText } from '../lib/terminal-visuals.mjs';
import { stopLine } from '../lib/stop-line.mjs';
import { joinWaiting } from '../lib/peer/cli.mjs';
import { joinWait } from '../lib/peer/join-text.mjs';

// A command the owner copies from a line is never broken across rows: the row that has no room
// for all of it ends before it, so the command starts the next row whole.
const at = '2026-11-12T10:00:00.000Z';
const signedOut = stopLine({ id: '4', goal: 'Normalize coupons', state: 'blocked', permissions: 'full', createdAt: at, runs: [{ role: 'lead', vendor: 'codex', at }], messages: [{ at, text: 'Normalize coupons' }], error: { message: 'The model could not finish.', cause: 'auth', logFile: null } }, { logCause: () => null, account: () => null }).text;
const LINES = [
  [signedOut, ['codex login']],
  ['The model could not finish: Codex is signed out. Sign in again with codex login --device-auth, then type continue.', ['codex login --device-auth']],
  ['Grok Build is signed out. Run grok login --device-auth to sign in, then send again.', ['grok login --device-auth']],
  ['Claude Code is signed out. Run claude auth login to sign in, then send again.', ['claude auth login']],
  ['sara made this code for another computer of theirs. Nothing was marked as yours. If you set up both computers, run elu mine @sara-box.', ['elu mine @sara-box']],
  ['On your other computer, run: elu join CODE --mine', ['elu join CODE --mine']],
  ['Twice in one line: codex login --device-auth here, and grok login --device-auth there, then type continue.', ['codex login --device-auth', 'grok login --device-auth']],
];

test('the stop line of a signed-out Codex names its sign-in command', () => {
  assert.equal(signedOut, 'The model could not finish: Codex is signed out. Sign in again with codex login, then type continue.');
});

test('a command in a line is on one row at every width that can hold it, and the words around it are as they were', () => {
  for (const [line, commands] of LINES) for (let width = 28; width <= 140; width++) {
    const rows = wrapText(line, width);
    assert.equal(rows.join(' '), line, `nothing is lost or changed at ${width}: ${JSON.stringify(rows)}`);
    assert.ok(rows.every(row => row.length <= width && !row.includes(' ')), `every row fits and holds plain spaces at ${width}`);
    for (const command of commands) assert.ok(rows.some(row => row.includes(command)), `"${command}" is whole on a row at ${width}: ${JSON.stringify(rows)}`);
  }
});

test('a row ends before a command it has no room for, and a list item keeps its indent', () => {
  assert.deepEqual(wrapText('Sign in again with codex login --device-auth, then type continue.', 30), ['Sign in again with', 'codex login --device-auth,', 'then type continue.']);
  assert.deepEqual(wrapText('- Sign in again with codex login --device-auth, then type continue.', 34), ['- Sign in again with', '  codex login --device-auth, then', '  type continue.']);
  // Words that only look like a command's start stay ordinary words.
  assert.deepEqual(wrapText('Codex login failed for the grok account', 16), ['Codex login', 'failed for the', 'grok account']);
});

// elu join draws its waiting line again in place each second. A line longer than the terminal
// wrapped, and every count left a row of it behind.
test('the waiting line of elu join fits one row of the terminal at every width, in fewer words where it must', () => {
  assert.equal(joinWaiting(12, 120), 'Looking for the person who invited you… 12 s. Their ELU must be open. Ctrl-C cancels.');
  assert.equal(joinWaiting(12, 80), 'Looking for who invited you… 12 s. Their ELU must be open. Ctrl-C cancels.');
  assert.equal(joinWaiting(12, undefined), joinWaiting(12, 80), 'a terminal that gives no width counts as 80 columns');
  assert.equal(joinWaiting(12, 60), 'Looking… 12 s. Their ELU must be open. Ctrl-C cancels.');
  assert.equal(joinWaiting(12, 40), 'Looking… 12 s. Ctrl-C cancels.');
  assert.equal(joinWaiting(12, 20), 'Looking… 12 s');
  for (let columns = 20; columns <= 200; columns++) for (const seconds of [0, 9, 59, 600]) assert.ok(joinWaiting(seconds, columns).length < columns, `${columns} columns, ${seconds} s`);
  // What the join is doing now (lib/peer/join-text.mjs) is the line wherever it fits the row.
  // Still looking, a narrow row says it in fewer words; found and connecting, it keeps what it is doing.
  const doing = (progress, seconds) => width => joinWait(progress, seconds, 'Ctrl-C', width), relay = { stage: 'relay', via: 'your computer studio' };
  assert.equal(joinWaiting(12, 120, doing(null, 12)), 'Looking for the person who invited you… 12 s. Their ELU must be open. Ctrl-C cancels.');
  assert.equal(joinWaiting(12, 80, doing(null, 12)), 'Looking for who invited you… 12 s. Their ELU must be open. Ctrl-C cancels.');
  assert.equal(joinWaiting(12, 40, doing({ stage: 'looking' }, 12)), 'Looking… 12 s. Ctrl-C cancels.');
  assert.equal(joinWaiting(4, 80, doing({ stage: 'connecting' }, 4)), 'Found them. Connecting… 4 s. Ctrl-C cancels.');
  assert.equal(joinWaiting(9, 80, doing(relay, 9)), 'Found them. Connecting through your computer studio… 9 s. Ctrl-C cancels.');
  assert.equal(joinWaiting(9, 41, doing(relay, 9)), 'Found them. Connecting through your com…');
  assert.equal(joinWaiting(12, 80, () => { throw new Error('no state'); }), joinWaiting(12, 80), 'with nothing to read, the plain line');
  for (let columns = 20; columns <= 200; columns++) for (const progress of [null, { stage: 'connecting' }, { stage: 'retrying' }, relay]) for (const seconds of [0, 59, 600]) assert.ok(joinWaiting(seconds, columns, doing(progress, seconds)).length < columns, `${columns} columns, ${progress?.stage ?? 'looking'}, ${seconds} s`);
});
