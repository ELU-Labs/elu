import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText } from '../lib/terminal-visuals.mjs';
import { stopLine } from '../lib/stop-line.mjs';

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
