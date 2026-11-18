import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { project as sampleProject, temp } from './helpers.mjs';
import { liveTask } from './peer-helpers.mjs';
import { readTask } from '../lib/state.mjs';
import { repository } from '../lib/git.mjs';
import { registerProject } from '../lib/projects.mjs';
import { setDone } from '../lib/kanban.mjs';
import { checkData } from '../lib/artifacts.mjs';
import { artifactsView } from '../lib/terminal-artifacts.mjs';
import { clockTime } from '../lib/terminal-plan.mjs';
import { getBot, saveBot } from '../lib/bots.mjs';
import { DIGEST_CHARS, DIGEST_ROWS, PROOF_BUDGET, PROOF_STEPS, STATUS_WORDS, agentsTable, clock, forgetOverview, overview, overviewArtifacts, proofText, readOverview, readSession, requestStatus, sessionAgents, sessionStatus, sessionsTable, stateDigest, statusRows } from '../lib/session-overview.mjs';

// The two tables of the bot that oversees the sessions (lib/session-overview.mjs), on made-up
// records: every title, name and number here is invented; the shapes are the ones ELU and the
// vendors write. Nothing here asks a model, and the personal folder is a new empty one, so no
// saved bot, account or board of whoever runs this is read.
let personal = null, had;
before(() => { personal = fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-test-')); had = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = personal; });
after(() => { if (had === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = had; fs.rmSync(personal, { recursive: true, force: true }); });
beforeEach(() => forgetOverview());

const NOW = Date.parse('2026-11-17T18:00:00Z'), ago = min => new Date(NOW - min * 60000).toISOString();
// A folder that is not there: the checklist then says what the records alone say.
const NONE = path.join(os.tmpdir(), 'elu-code-test-no-such-folder');
const chat = extra => ({ id: '1', kind: 'conversation', base: null, branch: null, worktree: NONE, goal: 'Which database fits', createdAt: ago(120), runs: [], messages: [], reviews: [], responses: [], permissions: 'auto', ...extra });
const edit = extra => ({ id: '1', mode: 'automatic', base: 'a'.repeat(40), branch: 'feat/task-1', worktree: NONE, goal: 'Uppercase coupon codes', createdAt: ago(120), runs: [], messages: [], reviews: [], responses: [], permissions: 'auto', ...extra });
const board = extra => ({ cards: [], done: [], closed: {}, archived: [], checked: {}, since: NOW - 86400000, moved: {}, ...extra });
const okChecks = { base: 'a'.repeat(40), digest: 'd1', changedLines: 12, checkedAt: ago(5), results: [{ name: 'declared-paths', status: 'passed', details: [] }, { name: 'tests', status: 'passed', logFile: '/x/check-tests.log' }] };
const badChecks = { ...okChecks, results: [{ name: 'declared-paths', status: 'noted', details: ['x/y.js'] }, { name: 'tests', status: 'failed', logFile: '/x/check-tests.log' }] };
const plan = extra => ({ id: 't-1', title: 'T', state: 'approved', objectives: ['a', 'b'], met: [1], subtasks: [{ id: 's1', text: 'x', state: 'done' }, { id: 's2', text: 'y', state: 'doing' }], approvedAt: ago(100), estimateMinutes: 60, ...extra });
const web = extra => ({ root: '/work/web', name: 'web', tasks: [], queue: [], activity: [], ...extra });
const fixes = count => ({ round: 2, role: 'bot:reviewer', digest: 'd1', result: { comments: Array.from({ length: count }, (_, at) => ({ id: `c${at}`, severity: 'must_fix', body: 'x' })) } });
const status = (task, { queue = [], activity = [], ...options } = {}) => sessionStatus(web({ tasks: [task], queue, activity }), task, { now: NOW, ...options });

test('each of sixteen made-up sessions gets one of the eight words, from its records and not from its stored state', () => {
  const working = { state: 'running', activeRole: 'lead', activeSince: ago(7) };
  const cases = [
    ['its model works', 'Working', /^working$/, chat(working)],
    ['the checks run', 'Working', /^running the checks$/, edit({ state: 'running', activeRole: 'checks', activeSince: ago(2) })],
    ['a permission waits', 'Needs approval', /^Wants to run: npm install$/, chat(working), { approvals: [{ id: 'a', root: '/work/web', taskId: '1', summary: 'run: npm install', at: ago(1) }] }],
    ['its Task waits for approval', 'Needs approval', /^Task to approve: T$/, chat({ state: 'answered', plan: plan({ state: 'proposed', met: [], subtasks: [], proposedAt: ago(9) }) })],
    ['it asks a question', 'Asks you', /^Which database\?$/, chat({ state: 'needs_input', reply: { outcome: 'needs_input', question: 'Which database?' } })],
    // A stored blocked is a dropped connection here, and a review that ran out of rounds below.
    ['the connection dropped', 'Stopped', /connection/, chat({ state: 'blocked', error: { message: 'Claude could not finish: the connection dropped.', cause: 'network' } })],
    ['the owner stopped it', 'Stopped', /^You stopped it\./, edit({ state: 'stopped', error: { message: 'Stopped by the owner.' } })],
    ['the review rounds ran out', 'Blocked', /The review still asks for fixes/, edit({ state: 'blocked', reviewStatus: 'blocked', evidence: okChecks, reviews: [{ ...fixes(1), round: 1, digest: 'd0' }, fixes(1)] })],
    // Stored as not verified, with no stop line: only the checks' own record says they failed.
    ['the checks failed and no bot reviews', 'Blocked', /^Checks failed: tests\.$/, edit({ state: 'unverified', reviewStatus: 'skipped', evidence: badChecks })],
    ['ready to publish', 'Ready for your check', /^ready to publish$/, edit({ state: 'ready', reviewStatus: 'passed', evidence: okChecks, reviews: [{ ...fixes(0), round: 1 }] })],
    ['committed by the agent', 'Ready for your check', /^committed$/, edit({ state: 'unverified', commit: 'c'.repeat(40), committed: { branch: 'feat/task-1', clean: true, pushed: false } })],
    // A published session is still stored as ready: its pull request says it is published.
    ['published, with a pull request', 'Ready for your check', /^published$/, edit({ state: 'ready', reviewStatus: 'passed', evidence: okChecks, commit: 'c'.repeat(40), pushedCommit: 'c'.repeat(40), committed: { branch: 'feat/task-1', clean: true, pushed: true }, pr: 'https://example.invalid/pr/1' })],
    ['a chat that replied', 'Ready for your check', /^replied$/, chat({ state: 'answered', reply: { outcome: 'done', summary: 's' } })],
    ['keep going gave up', 'Blocked', /^no progress twice$/, chat({ state: 'answered', plan: plan(), keepStopped: { at: ago(3), text: 'no progress twice' } })],
    ['the owner checked it', 'Done', /^You checked it /, chat({ state: 'answered' }), { board: board({ done: ['1'], closed: { 1: ago(1) }, checked: { 1: ago(1) } }) }],
    ['a message to it did not run', 'Blocked', /^Its spending limit is reached\.$/, chat({ state: 'answered' }), { queue: [{ id: 'r1', state: 'blocked', continuationTaskId: '1', goal: 'Go on', reason: 'Its spending limit is reached.', createdAt: ago(4) }] }],
  ];
  assert.equal(cases.length, 16);
  for (const [name, word, why, task, options] of cases) {
    const row = status(task, options);
    assert.equal(row?.word, word, name); assert.match(row.why, why, name);
    assert.equal(row.rank, STATUS_WORDS.indexOf(word), name); assert.equal(row.kind, 'session'); assert.equal(row.project, 'web'); assert.equal(row.id, '1');
  }
  assert.deepEqual(STATUS_WORDS, ['Needs approval', 'Asks you', 'Blocked', 'Stopped', 'Ready for your check', 'Working', 'Queued', 'Done']);
  // What the published one's records prove, and the one thing to do where a stop names it.
  assert.equal(status(cases[11][3]).done, 'published'); assert.equal(proofText(status(cases[11][3])), 'Published');
  assert.equal(status(cases[6][3]).action, 'Type continue to carry on.');
  // Since: a working turn counts up from its start, an approval from when it was asked, the rest from the last activity.
  assert.deepEqual(status(cases[0][3]).since, { run: true, at: ago(7) }); assert.equal(status(cases[0][3]).role, 'lead');
  assert.deepEqual(status(cases[2][3], cases[2][4]).since, { at: ago(1) });
  assert.deepEqual(status(cases[12][3]).since, { at: ago(120) });
  assert.deepEqual(status(cases[14][3], cases[14][4]).since, { at: ago(1) });
});

test('a working turn says its latest step, and who does it when a bot does', () => {
  const activity = [{ at: ago(3), text: 'model: Read a.js', taskId: '1', step: 'Read a.js' }, { at: ago(2), text: 'model: Edit b.js', taskId: '2', step: 'Edit b.js' }, { at: ago(1), text: 'model: Run npm test', taskId: '1', step: 'Run npm test\nand more' }];
  assert.equal(status(chat({ state: 'running', activeRole: 'lead', activeSince: ago(7) }), { activity }).why, 'Run npm test');
  assert.equal(status(chat({ state: 'running', activeRole: 'bot:qa', activeSince: ago(7) }), { activity }).why, '@qa reviewing: Run npm test');
  assert.equal(status(chat({ state: 'running', activeRole: 'bot:qa', activeSince: ago(7) })).why, '@qa reviewing');
  // Its turn ended and a long job of it still runs: it is at work.
  const jobs = status(chat({ state: 'answered', jobs: [{ name: 'nightly', state: 'running', startedAt: ago(43) }] }));
  assert.equal(jobs.word, 'Working'); assert.match(jobs.why, /^1 job running · nightly/);
  // A key in a step is masked before a table or a model reads it.
  assert.doesNotMatch(status(chat({ state: 'running', activeRole: 'lead' }), { activity: [{ taskId: '1', step: 'Run curl -H token=abcdef123456' }] }).why, /abcdef/);
});

test('what the tables leave out, and what is not called working', () => {
  const answered = chat({ state: 'answered' });
  // Archived, a teammate's question, and one the board no longer shows.
  assert.equal(status(answered, { board: board({ done: ['1'], closed: { 1: ago(1) }, archived: ['1'] }) }), null);
  assert.equal(status(chat({ state: 'answered', origin: { kind: 'ask', peer: 'k', name: 'Sam' } })), null);
  assert.equal(status(chat({ state: 'answered', createdAt: ago(15 * 1440) })), null);
  // In Done for over a day. One that worked since the owner checked it waits for his check again.
  assert.equal(status(chat({ state: 'answered', createdAt: ago(3000) }), { board: board({ done: ['1'], closed: { 1: ago(1500) }, checked: { 1: ago(1500) } }) }), null);
  const again = status(answered, { board: board({ done: ['1'], closed: { 1: ago(1500) }, checked: { 1: ago(1500) } }) });
  assert.deepEqual([again.word, again.done], ['Ready for your check', 'none']);
  // The owner's check wins over the state it was stored with.
  const checked = status(chat({ state: 'stopped', error: { message: 'Stopped by the owner.' } }), { board: board({ done: ['1'], closed: { 1: ago(1) }, checked: { 1: ago(1) } }) });
  assert.equal(checked.word, 'Done'); assert.equal(checked.done, 'accepted'); assert.equal(proofText(checked), PROOF_STEPS.accepted);
  // A standup's answer turn leaves the session where it stood.
  const standup = status(chat({ state: 'running', standupTurn: { round: 'r', state: 'answered' }, activeRole: 'lead', activeSince: ago(1) }));
  assert.equal(standup.word, 'Ready for your check'); assert.equal(standup.role, null);
  // A working record whose process is gone is not working. One that names no process, or whose process cannot be read, is.
  const owned = chat({ state: 'running', activeRole: 'lead', activeSince: ago(30), owner: { pid: 4242, born: 'x' } });
  const gone = status(owned, { alive: () => false });
  assert.equal(gone.word, 'Stopped'); assert.equal(gone.why, 'ELU stopped before this response finished. Type continue to carry on.'); assert.deepEqual(gone.since, { at: ago(30) });
  assert.equal(status(owned, { alive: () => true }).word, 'Working'); assert.equal(status(owned, { alive: () => null }).word, 'Working');
  assert.equal(status(chat({ state: 'running', activeRole: 'lead' }), { alive: () => false }).word, 'Working');
  // A refused command while it asks is Blocked, not a question.
  const refused = chat({ state: 'needs_input', reply: { outcome: 'needs_input', question: 'May I?' }, runs: [{ role: 'lead', vendor: 'claude', permissions: 'auto', session: 's', denials: [{ tool: 'Bash', input: { command: 'curl example.invalid' }, network: 'example.invalid' }] }] });
  assert.equal(status(refused).word, 'Blocked'); assert.match(status(refused).why, /^Blocked: Connect to example\.invalid\./);
  // A project that cannot be read, and the session of the bot that asks.
  const rows = statusRows([web({ tasks: [answered, chat({ id: '2', state: 'answered' })] }), { root: '/work/gone', name: 'gone', unavailable: 'No such folder.', tasks: [] }], { now: NOW, except: { root: '/work/web', id: '2' } });
  assert.deepEqual(rows.map(row => [row.project, row.id]), [['web', '1']]);
});

test('messages that wait: on their session\'s row, or a row of their own when no session has started', () => {
  const queued = { id: 'r2', state: 'queued', continuationTaskId: '1', goal: 'continue', createdAt: ago(3), queuedAt: ago(3), waits: { on: 'slot', running: 2, limit: 2 } };
  const next = status(chat({ state: 'stopped', error: { message: 'Stopped by the owner.' } }), { queue: [queued] });
  assert.equal(next.word, 'Queued'); assert.match(next.why, /^Waiting for a free slot: 2 of 2 sessions are running/); assert.deepEqual(next.since, { at: ago(3) });
  // While its turn works, a message behind it changes nothing.
  assert.equal(status(chat({ state: 'running', activeRole: 'lead' }), { queue: [queued] }).word, 'Working');
  assert.equal(status(chat({ state: 'answered' }), { queue: [{ id: 'r3', state: 'waiting', continuationTaskId: '1', goal: 'Deploy it\nnow', createdAt: ago(2) }] }).why, 'A message waits for your yes: Deploy it');
  const fresh = { id: 'r4', state: 'queued', goal: 'Add a sitemap\nwith every page', createdAt: ago(6), queuedAt: ago(6) };
  const rows = statusRows([web({ tasks: [chat({ state: 'answered' })], queue: [queued, fresh, { id: 'r5', state: 'blocked', goal: 'Rename the app', reason: 'No vendor is signed in.', createdAt: ago(8) },
    { id: 'r6', state: 'queued', goal: 'standup', standupFor: 'x', createdAt: ago(1) }, { id: 'r7', state: 'waiting', goal: 'q', origin: { kind: 'ask', peer: 'k' }, createdAt: ago(1) }, { id: 'r8', state: 'done', goal: 'old', createdAt: ago(1) }] })], { now: NOW });
  assert.deepEqual(rows.map(row => [row.kind, row.word, row.id ?? row.request, row.title]), [['request', 'Blocked', 'r5', 'Rename the app'], ['request', 'Queued', 'r4', 'Add a sitemap'], ['session', 'Queued', '1', 'Which database fits']]);
  assert.equal(rows[0].why, 'No vendor is signed in.'); assert.equal(rows[1].why, 'Waiting to start.'); assert.deepEqual(rows[1].proof, []); assert.equal(rows[1].id, null);
  assert.equal(requestStatus(web(), { id: 'r9', state: 'waiting', goal: 'Ship it', createdAt: ago(2) }, NOW).word, 'Needs approval');
});

test('the rows are in the order of what needs the owner first, and inside a word as the design orders them', () => {
  const working = extra => chat({ state: 'running', activeRole: 'lead', ...extra }), at = (id, min) => ({ id, root: '/work/web', taskId: id, summary: 'Run make', at: ago(min) });
  const stop = extra => chat({ state: 'stopped', error: { message: 'Stopped by the owner.' }, ...extra });
  const tasks = [
    working({ id: '1', activeSince: ago(4) }), working({ id: '2', activeSince: ago(9) }),
    chat({ id: '3', state: 'answered' }), chat({ id: '4', state: 'answered', plan: plan({ state: 'proposed', met: [], proposedAt: ago(20) }) }),
    chat({ id: '5', state: 'needs_input', reply: { outcome: 'needs_input', question: 'A?' }, createdAt: ago(30) }), chat({ id: '6', state: 'needs_input', reply: { outcome: 'needs_input', question: 'B?' }, createdAt: ago(90) }),
    stop({ id: '7', createdAt: ago(40) }), chat({ id: '8', state: 'blocked', createdAt: ago(300), error: { message: 'Every Claude account is at its limit.', waitsFor: 'claude-limit' } }),
    chat({ id: '9', state: 'answered', createdAt: ago(200) }), chat({ id: '10', state: 'answered', createdAt: ago(50), plan: plan({ met: [0, 1] }) }),
    working({ id: '11', activeSince: ago(50) }), working({ id: '12', activeSince: ago(10), plan: plan({ approvedAt: ago(100), estimateMinutes: 60 }) }),
    chat({ id: '13', state: 'answered', createdAt: ago(400) }), chat({ id: '14', state: 'answered', createdAt: ago(400) }), chat({ id: '15', state: 'answered', createdAt: ago(4000) }),
    chat({ id: '16', state: 'answered', keepStopped: { at: ago(15), text: 'no progress twice' } }), edit({ id: '17', state: 'unverified', reviewStatus: 'skipped', evidence: badChecks, createdAt: ago(60) }),
  ];
  const queue = [{ id: 'q1', state: 'waiting', continuationTaskId: '3', goal: 'yes?', createdAt: ago(25) }, { id: 'q2', state: 'queued', goal: 'later', priority: 1, createdAt: ago(70), queuedAt: ago(70) }, { id: 'q3', state: 'queued', goal: 'first', priority: 0, createdAt: ago(5), queuedAt: ago(5) }];
  const done = board({ done: ['13', '14', '15'], closed: { 13: ago(60), 14: ago(10), 15: ago(2880) }, checked: { 13: ago(60), 14: ago(10), 15: ago(2880) } });
  const rows = statusRows([web({ tasks, queue })], { now: NOW, approvals: [at('1', 1), at('2', 5)], boards: new Map([['/work/web', done]]), proof: false });
  assert.deepEqual(rows.map(row => `${row.word} ${row.id ?? row.request}`), [
    // A permission holds a turn now, the oldest first; then a message that waits for a yes; then a Task to approve.
    'Needs approval 2', 'Needs approval 1', 'Needs approval 3', 'Needs approval 4',
    // The longest waiting first.
    'Asks you 6', 'Asks you 5',
    'Blocked 17', 'Blocked 16',
    // One that waits for a Claude account to reset comes last.
    'Stopped 7', 'Stopped 8',
    // Every objective reported met first, then the oldest.
    'Ready for your check 10', 'Ready for your check 9',
    // Past its agent's own estimate first, then the longest running.
    'Working 12', 'Working 11',
    // The order they start in.
    'Queued q3', 'Queued q2',
    // The newest first, the last day only.
    'Done 14', 'Done 13',
  ]);
  // boards may be an object by root too.
  assert.equal(statusRows([web({ tasks: [tasks[12]] })], { now: NOW, boards: { '/work/web': done } })[0].word, 'Done');
});

test('the proof is the highest step the records reach, and a session that says done with a later step missing is named', () => {
  const rows = (...list) => () => list.map(([text, met, evidence = '']) => ({ text, met, evidence }));
  const said = (task, checklist) => { forgetOverview(); const row = status(task, { checklist }); return [row.done, proofText(row)]; };
  const open = edit({ state: 'unverified' }), reported = edit({ state: 'unverified', plan: plan({ met: [0, 1] }) });
  assert.deepEqual(said(open, rows()), ['none', null]);
  assert.deepEqual(said(reported, rows()), ['reported', 'Reported']);
  assert.deepEqual(said(open, rows(['Edits committed', true])), ['committed', 'Committed']);
  assert.deepEqual(said(open, rows(['Edits committed', false], ['Checks passed', true])), ['checked', 'Checks passed']);
  assert.deepEqual(said(open, rows(['Checks passed', true], ['Review passed', true])), ['reviewed', 'Review passed']);
  assert.deepEqual(said(open, rows(['Checks passed', true], ['Pushed', true], ['Pull request', false])), ['checked', 'Checks passed']);
  assert.deepEqual(said(open, rows(['Checks passed', true], ['Pushed', true], ['Pull request', true])), ['published', 'Published']);
  // The agent's word alone, against what the checks and the review say.
  assert.deepEqual(said(reported, rows(['Edits committed', false, '/publish commits them.'], ['Checks passed', false, 'Not run since the last edit. /publish runs them first.'])), ['reported', 'says done, checks not run']);
  assert.deepEqual(said(reported, rows(['Edits committed', true], ['Checks passed', false, 'Failed: tests.'])), ['committed', 'says done, checks failed']);
  assert.deepEqual(said(reported, rows(['Checks passed', true, 'Passed: tests.'], ['Review passed', false, 'It still asks for 2 fixes.'])), ['checked', 'says done, 2 fixes open']);
  assert.deepEqual(said(reported, rows(['Checks passed', true, 'Passed: tests.'], ['Review passed', false, 'It still asks for 1 fix.'])), ['checked', 'says done, 1 fix open']);
  assert.deepEqual(said(reported, rows(['Checks passed', true, 'Passed: tests.'], ['Review passed', false, 'It still asks for fixes.'])), ['checked', 'says done, fixes open']);
  assert.deepEqual(said(reported, rows(['Checks passed', true, 'Passed: tests.'], ['Review passed', false, 'Not reviewed since the last edit.'])), ['checked', 'says done, not reviewed']);
  // A project with no checks of its own has none to miss, and edits that wait for /publish to commit them are not named.
  assert.deepEqual(said(reported, rows(['Edits committed', false, '/publish commits them.'], ['Checks passed', false, 'Not set for this project: no test or build command checks the edits.'])), ['reported', 'Reported']);
  assert.deepEqual(said(reported, rows(['Checks passed', true, 'Passed: tests.'], ['Review passed', true, '@reviewer asked for no fixes.'])), ['reviewed', 'Review passed']);
  // One that does not say done is never named so, whatever failed.
  assert.deepEqual(said(open, rows(['Checks passed', false, 'Failed: tests.'])), ['none', null]);
  // The rows about what it waits on are the state word, not proof; the proof rows keep their evidence.
  forgetOverview();
  assert.deepEqual(status(open, { checklist: rows(['Stopped', false, 'x'], ['Edits committed', true, 'Committed on feat/task-1 at ccccccc.'], ['nightly', true, 'ended']) }).proof, [{ key: 'committed', text: 'Edits committed', met: true, evidence: 'Committed on feat/task-1 at ccccccc.' }]);
  // With the checklist itself (lib/checklist.mjs), whose words the names are read from.
  forgetOverview();
  assert.equal(proofText(status(edit({ state: 'blocked', reviewStatus: 'blocked', evidence: okChecks, reviews: [fixes(2)], plan: plan({ met: [0, 1] }) }))), 'says done, 2 fixes open');
  assert.equal(proofText(status(edit({ id: '2', state: 'unverified', plan: plan({ met: [0, 1] }) }))), 'says done, checks not run');
  assert.equal(proofText(status(edit({ id: '3', state: 'unverified', evidence: badChecks, plan: plan({ met: [0, 1] }) }))), 'says done, checks failed');
  assert.equal(proofText(status(edit({ id: '4', state: 'ready', reviewStatus: 'passed', evidence: okChecks, reviews: [{ ...fixes(0), round: 1 }], plan: plan({ met: [0, 1] }) }))), 'Review passed');
  assert.deepEqual(status(chat({ id: '5', state: 'answered' })).proof, [{ key: 'replied', text: 'Replied', met: true, evidence: 'Its reply is in the chat.' }]);
  // The Task in numbers.
  assert.deepEqual(status(chat({ id: '6', state: 'answered', plan: plan() })).task, { id: 't-1', title: 'T', state: 'approved', met: 1, objectives: 2, stepsDone: 1, steps: 2, etaAt: ago(40) });
});

test('the ETA is the Task\'s own estimate as a clock time, and says overdue once it has passed', () => {
  const working = extra => chat({ state: 'running', activeRole: 'lead', activeSince: ago(5), plan: plan(extra) });
  // Approved 100 minutes ago with an estimate of 60.
  assert.deepEqual(status(working()).eta, { at: ago(40), overdue: true, text: 'overdue 40 min' });
  assert.equal(status(working({ estimateMinutes: 20, approvedAt: ago(200) })).eta.text, 'overdue 3 h');
  const later = status(working({ estimateMinutes: 180 })).eta;
  assert.deepEqual(later, { at: ago(-80), overdue: false, text: clockTime(NOW + 80 * 60000, NOW) });
  // The agent's last revision wins over its first estimate.
  assert.equal(status(working({ etaMinutes: 20, etaAt: ago(5) })).eta.text, clockTime(NOW + 15 * 60000, NOW));
  // Nobody estimated it, it waits for approval, every objective is reported met, or it is in Done.
  assert.equal(status(working({ estimateMinutes: null })).eta, null);
  assert.equal(status(chat({ state: 'answered', plan: plan({ state: 'proposed' }) })).eta, null);
  assert.equal(status(chat({ state: 'answered', plan: plan({ met: [0, 1] }) })).eta, null);
  assert.equal(status(chat({ state: 'answered', plan: plan() }), { board: board({ done: ['1'], closed: { 1: ago(1) }, checked: { 1: ago(1) } }) }).eta, null);
  // The clock reads as a Task's own ETA line does, today and on another day.
  for (const at of [NOW, NOW + 3600000, NOW - 5 * 86400000, NOW + 40 * 86400000]) assert.equal(clock(at, NOW), clockTime(at, NOW));
});

test('the checklist, which asks git, is asked once per session until its records change', t => {
  let asked = 0; const checklist = () => { asked++; return [{ text: 'Edits committed', met: true, evidence: 'Committed.' }]; };
  // A record handed in as it is: the same record is not asked about again, a new one is.
  const record = edit({ state: 'unverified' });
  for (let n = 0; n < 5; n++) assert.equal(status(record, { checklist }).done, 'committed');
  assert.equal(asked, 1);
  status(edit({ state: 'unverified' }), { checklist }); assert.equal(asked, 2);
  status(record, { checklist, proof: false }); assert.equal(asked, 2);
  assert.equal(status(record, { checklist, proof: false }).done, 'none');
  // A session in Done is not asked about.
  status(edit({ id: '9', state: 'unverified' }), { checklist, board: board({ done: ['9'], closed: { 9: ago(1) }, checked: { 9: ago(1) } }) }); assert.equal(asked, 2);
  status(edit({ state: 'unverified' }), { checklist, fresh: true }); assert.equal(asked, 3);
  // A session with its record files: whatever record is handed in, it is asked again only when one of the files changed.
  const state = temp(t), dir = path.join(state, 'tasks', '7'), repo = { root: '/work/web', state };
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'task.json'), '{}');
  asked = 0;
  for (let n = 0; n < 4; n++) status(edit({ id: '7', state: 'unverified' }), { checklist, repo });
  assert.equal(asked, 1);
  fs.writeFileSync(path.join(dir, 'plan.json'), '{"tasks":[]}');
  status(edit({ id: '7', state: 'unverified' }), { checklist, repo }); status(edit({ id: '7', state: 'unverified' }), { checklist, repo });
  assert.equal(asked, 2);
  fs.writeFileSync(path.join(dir, 'task.json'), '{"id":"7"}');
  status(edit({ id: '7', state: 'unverified' }), { checklist, repo }); assert.equal(asked, 3);
  fs.writeFileSync(path.join(dir, 'keep-going.json'), '{}'); fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
  status(edit({ id: '7', state: 'unverified' }), { checklist, repo }); assert.equal(asked, 4);
  status(edit({ id: '7', state: 'unverified' }), { checklist, repo, fresh: true }); assert.equal(asked, 5);
});

test('one look of the tables asks git only so long about proofs not kept yet; later looks ask about the rest', t => {
  // Forty editing sessions, each checklist a stand-in that takes 20 ms, as git does on a busy computer.
  const p = sampleProject(t), state = temp(t), repo = { root: p.root, state, worktrees: path.join(state, 'worktrees') }, ids = Array.from({ length: 40 }, (_, at) => String(at + 1));
  for (const id of ids) { fs.mkdirSync(path.join(state, 'tasks', id), { recursive: true }); fs.writeFileSync(path.join(state, 'tasks', id, 'task.json'), JSON.stringify({ id })); }
  const tasks = ids.map(id => edit({ id, state: 'unverified', goal: `Session ${id}` }));
  let asked = 0; const checklist = () => { asked++; const end = Date.now() + 20; while (Date.now() < end) { /* As git takes its time. */ } return [{ text: 'Edits committed', met: true, evidence: 'Committed.' }]; };
  const look = () => overview([web({ root: p.root, tasks })], { now: NOW, repos: new Map([[p.root, repo]]), checklist, proofMs: PROOF_BUDGET });
  const began = Date.now(), first = look(), took = Date.now() - began;
  assert.ok(took < 400, `one look took ${took} ms`);
  assert.ok(asked >= 1 && asked < 40, `asked ${asked}`);
  // A session not asked about yet has no proof yet, never a lower step than its records reach.
  const waiting = first.status.filter(row => row.done === null);
  assert.equal(waiting.length, 40 - asked); assert.ok(waiting.every(row => row.proof.length === 0 && proofText(row) === null));
  assert.equal(first.status.filter(row => row.done === 'committed').length, asked);
  for (let n = 0; n < 40 && look().status.some(row => row.done === null); n++);
  assert.deepEqual(look().status.map(row => row.done), ids.map(() => 'committed'));
  assert.equal(asked, 40, 'each asked once');
  // With no budget, as for one session a tool reads, every proof is asked for at once.
  forgetOverview(); asked = 0;
  assert.deepEqual(overview([web({ root: p.root, tasks })], { now: NOW, repos: new Map([[p.root, repo]]), checklist }).status.map(row => row.done), ids.map(() => 'committed'));
  assert.equal(asked, 40);
  // This computer's own records are read with the budget.
  forgetOverview(); asked = 0;
  const mine = sampleProject(t).root;
  for (const id of ids.slice(0, 12)) liveTask(mine, { id, goal: `Session ${id}`, state: 'unverified' });
  registerProject(repository(mine));
  const read = readOverview({ now: Date.now(), checklist });
  assert.ok(asked >= 1 && asked < 12, `asked ${asked}`); assert.equal(read.status.filter(row => row.done === null).length, 12 - asked);
});

// A Claude Code log: its first line and its result. models: { name: [in, out, cacheRead,
// cacheWrite, dollars] }; usage: the tokens of the agent's own loop.
const MODELS = { opus: 'claude-opus-5-5', fable: 'claude-fable-5-2', haiku: 'claude-haiku-5' };
function claudeLog(file, { session, model, usage, models }) {
  const tokens = ([input, output, read, write]) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write });
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: session, model: MODELS[model] }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: session, total_cost_usd: Object.values(models).reduce((sum, row) => sum + row[4], 0), usage: tokens(usage),
      modelUsage: Object.fromEntries(Object.entries(models).map(([name, [input, output, read, write, cost]]) => [MODELS[name], { inputTokens: input, outputTokens: output, cacheReadInputTokens: read, cacheCreationInputTokens: write, costUSD: cost }])) }),
  ].join('\n') + '\n');
}
const counts = ([input, output, cacheRead, cacheWrite]) => ({ input, output, cacheRead, cacheWrite });
const add = (...lists) => lists.reduce((sum, list) => sum.map((value, at) => value + list[at]));
// A run as the runner keeps it now: its own tokens (every model it called) and its own cost.
const run = (role, min, model, used, extra = {}) => ({ role, vendor: 'claude', at: ago(min), code: 0, model: MODELS[model], ownCost: true, tokens: counts(used), costUsd: used[4], permissions: 'auto', ...extra });
const shown = rows => rows.map(row => [row.agent, row.model, row.tokens && [row.tokens.input, row.tokens.output, row.tokens.cacheRead, row.tokens.cacheWrite], row.costUsd === null ? null : Number(row.costUsd.toFixed(2)), row.atMost, row.within]);

test('the agents of a session: its model, each bot, and a bot\'s helpers as one row per model', t => {
  const dir = temp(t), log = name => path.join(dir, `${name}.log`);
  const fable = [16, 9000, 400000, 90000, 2.1], opus = [200, 50000, 9000000, 700000, 6.4], haiku = [5, 100, 0, 0, 0.01];
  claudeLog(log('qa-1'), { session: 's-qa', model: 'fable', usage: fable, models: { fable, opus, haiku } });
  const task = chat({ state: 'answered', title: 'Search speed', runs: [
    run('lead', 60, 'opus', [150, 80000, 12000000, 240000, 6]), run('lead', 40, 'opus', [250, 90000, 40000000, 200000, 12.3]),
    run('bot:qa', 30, 'fable', add(fable, opus, haiku), { session: 's-qa', logFile: log('qa-1') }),
  ] });
  // Helpers on another model than their bot's: that model's line, exact, and out of the bot's own row.
  assert.deepEqual(shown(sessionAgents(task, { helpersOf: () => 'opus' })), [
    ['Opus 5.5', 'opus 5.5', [400, 170000, 52000000, 440000], 18.3, false, null],
    ['@qa', 'fable 5.2', [21, 9100, 400000, 90000], 2.11, false, null],
    ['@qa helpers', 'opus 5.5', [200, 50000, 9000000, 700000], 6.4, false, null],
  ]);
  assert.deepEqual(sessionAgents(task, { helpersOf: () => 'opus' }).map(row => [row.key, row.kind, row.parent, row.runs]), [['lead', 'model', null, 2], ['bot:qa', 'bot', null, 1], ['bot:qa#helpers:claude-opus-5-5', 'helpers', 'bot:qa', 1]]);
  // A bot that starts no helpers, or one whose log is gone: one row, the whole run.
  const whole = [['Opus 5.5', 'opus 5.5', [400, 170000, 52000000, 440000], 18.3, false, null], ['@qa', 'fable 5.2', [221, 59100, 9400000, 790000], 8.51, false, null]];
  assert.deepEqual(shown(sessionAgents(task, { helpersOf: () => null })), whole);
  assert.deepEqual(shown(sessionAgents(task, { helpersOf: () => 'opus', read: () => null })), whole);
  // The session's own model starts no helpers, whatever its log holds.
  assert.equal(sessionAgents(chat({ runs: [run('lead', 30, 'fable', add(fable, opus), { logFile: log('qa-1') })] }), { helpersOf: () => 'opus' }).length, 1);

  // Helpers on the bot's own model: what that model's line holds over the bot's own loop, at
  // most; their cost is not reported apart and stays in the bot's row.
  const loop = [12, 11000, 300000, 60000], line = [112, 41000, 4300000, 360000, 4.3];
  claudeLog(log('lead-1'), { session: 's-lead', model: 'fable', usage: loop, models: { fable: line } });
  const own = chat({ state: 'answered', runs: [run('bot:lead', 20, 'fable', line, { session: 's-lead', logFile: log('lead-1') })] });
  assert.deepEqual(shown(sessionAgents(own, { helpersOf: () => 'inherit' })), [
    ['@lead', 'fable 5.2', [112, 41000, 4300000, 360000], 4.3, false, null],
    ['@lead helpers', 'fable 5.2', [100, 30000, 4000000, 300000], null, true, '@lead'],
  ]);
  // Named by its own model's name, it is the same case; a run with no helpers has no such row.
  assert.equal(sessionAgents(own, { helpersOf: () => 'fable' })[1].within, '@lead');
  claudeLog(log('lead-2'), { session: 's-alone', model: 'fable', usage: line, models: { fable: line } });
  assert.equal(sessionAgents(chat({ runs: [run('bot:lead', 20, 'fable', line, { session: 's-alone', logFile: log('lead-2') })] }), { helpersOf: () => 'inherit' }).length, 1);
  // A result with nothing for the agent's own loop tells nothing apart.
  claudeLog(log('lead-3'), { session: 's-zero', model: 'fable', usage: [0, 0, 0, 0], models: { fable: line, opus } });
  assert.equal(sessionAgents(chat({ runs: [run('bot:lead', 20, 'fable', add(line, opus), { session: 's-zero', logFile: log('lead-3') })] }), { helpersOf: () => 'opus' }).length, 1);

  // A turn that went on with its vendor's session reports that session's totals so far: its
  // helpers are what the totals grew by.
  const first = { fable: [10, 1000, 100000, 20000, 0.5], opus: [50, 10000, 1000000, 100000, 1] }, second = { fable: [20, 2000, 200000, 40000, 1], opus: [70, 30000, 3000000, 300000, 3] };
  claudeLog(log('team-1'), { session: 's-team', model: 'fable', usage: first.fable, models: first });
  claudeLog(log('team-2'), { session: 's-team', model: 'fable', usage: second.fable, models: { fable: add(first.fable, second.fable), opus: add(first.opus, second.opus) } });
  const team = chat({ state: 'answered', runs: [run('bot:lead', 20, 'fable', add(first.fable, first.opus), { session: 's-team', logFile: log('team-1') }), run('bot:lead', 10, 'fable', add(second.fable, second.opus), { session: 's-team', logFile: log('team-2') })] });
  assert.deepEqual(shown(sessionAgents(team, { helpersOf: () => 'opus' })), [
    ['@lead', 'fable 5.2', [30, 3000, 300000, 60000], 1.5, false, null],
    ['@lead helpers', 'opus 5.5', [120, 40000, 4000000, 400000], 4, false, null],
  ]);
  assert.equal(sessionAgents(team, { helpersOf: () => 'opus' })[1].runs, 2);

  // A turn that was stopped reported no cost: its agent's cost is at least what its runs said.
  const stopped = chat({ state: 'stopped', runs: [run('lead', 30, 'opus', [10, 1000, 20000, 3000, 0.4])], stops: [{ role: 'lead', vendor: 'claude', at: ago(5), model: MODELS.opus, tokens: counts([5, 500, 10000, 0]) }, { role: 'lead', vendor: 'claude', at: ago(4), counted: true, tokens: counts([9, 9, 9, 9]) }] });
  const [lead] = sessionAgents(stopped);
  assert.deepEqual([lead.tokens, lead.costUsd, lead.partial, lead.runs], [counts([15, 1500, 30000, 3000]), 0.4, true, 2]);
  // The turn in progress has no run yet: its agent is listed all the same.
  const working = sessionAgents(chat({ state: 'running', activeRole: 'bot:qa', runs: [run('lead', 30, 'opus', [10, 1000, 20000, 3000, 0.4])] }));
  assert.deepEqual(working.map(row => [row.agent, row.working, row.runs, row.tokens, row.costUsd]), [['Opus 5.5', false, 1, counts([10, 1000, 20000, 3000]), 0.4], ['@qa', true, 0, null, null]]);
  assert.deepEqual(sessionAgents(chat({})), []);
});

test('with no stand-in, a bot\'s helpers are told from the bot as it is saved and the run\'s permissions', t => {
  const dir = temp(t), file = path.join(dir, 'lead.log'), fable = [16, 9000, 400000, 90000, 2.1], opus = [200, 50000, 9000000, 700000, 6.4];
  claudeLog(file, { session: 's', model: 'fable', usage: fable, models: { fable, opus } });
  saveBot({ name: 'scout', vendor: 'claude', model: 'fable', color: 'aqua', about: 'Looks things up', instructions: 'Find it.', works: true, subagents: 'opus' }, { previous: getBot('scout') ? 'scout' : null });
  const runs = extra => chat({ runs: [run('bot:scout', 20, 'fable', add(fable, opus), { session: 's', logFile: file, ...extra })] });
  assert.deepEqual(sessionAgents(runs()).map(row => row.agent), ['@scout', '@scout helpers']);
  // A read-only turn starts no helpers, and neither does a bot that is no longer saved.
  assert.deepEqual(sessionAgents(runs({ permissions: undefined })).map(row => row.agent), ['@scout']);
  assert.deepEqual(sessionAgents(chat({ runs: [run('bot:nobody', 20, 'fable', add(fable, opus), { session: 's', logFile: file })] })).map(row => row.agent), ['@nobody']);
});

// A small made-up day: three sessions of one project, one of them with a bot and its helpers.
function day() {
  const tasks = [
    chat({ id: '1', title: 'Fix the login form', state: 'running', activeRole: 'lead', activeSince: ago(48), plan: plan({ estimateMinutes: 180 }), runs: [run('lead', 50, 'opus', [1200, 34000, 400000, 12000, 3.1])] }),
    chat({ id: '2', title: 'Search speed', state: 'needs_input', reply: { outcome: 'needs_input', question: 'Which index should it use?' }, runs: [run('lead', 30, 'opus', [150, 80000, 1200000, 240000, 6]), run('bot:qa', 20, 'fable', [16, 9000, 400000, 90000, 2.1])] }),
    chat({ id: '3', title: 'Old question', state: 'answered', createdAt: ago(300) }),
  ];
  return { projects: [web({ tasks, activity: [{ taskId: '1', step: 'Edit src/login.ts' }] })], boards: new Map([['/work/web', board({ done: ['3'], closed: { 3: ago(30) }, checked: { 3: ago(30) } })]]) };
}

test('the two tables are artifact blocks the Artifacts tab draws as it draws a Task\'s own', () => {
  const { projects, boards } = day(), view = overview(projects, { now: NOW, boards });
  assert.deepEqual(view.status.map(row => row.word), ['Asks you', 'Working', 'Done']);
  assert.deepEqual(view.agents.map(row => [row.id, row.title, row.agent]), [['2', 'Search speed', 'Opus 5.5'], ['2', 'Search speed', '@qa'], ['1', 'Fix the login form', 'Opus 5.5']]);
  const items = overviewArtifacts(view, { width: 140 });
  assert.deepEqual(items.map(item => [item.title, item.key, item.every, item.script, item.run, item.updates.length, item.updates[0].at]), [['Sessions', 'sessions', null, null, null, 1, new Date(NOW).toISOString()], ['Agents', 'agents', null, null, null, 1, new Date(NOW).toISOString()]]);
  // Each is data a session could have sent: the renderer's own check takes it as it is.
  for (const item of items) assert.deepEqual(checkData(item.updates[0].data), item.updates[0].data);
  const [sessions, agents] = items.map(item => item.updates[0].data.blocks[0]);
  assert.deepEqual(sessions.columns.map(column => column.label), ['Project', 'Session', 'State', 'Doing', 'Since', "Agent's ETA", 'Proof']);
  assert.deepEqual(sessions.rows, [
    ['web', 'Search speed', 'Asks you', 'Which index should it use?', clockTime(NOW - 20 * 60000, NOW), null, null],
    ['web', 'Fix the login form', 'Working', 'Edit src/login.ts', clockTime(NOW - 48 * 60000, NOW), clockTime(NOW + 80 * 60000, NOW), null],
    ['web', 'Old question', 'Done', `You checked it ${clockTime(NOW - 30 * 60000, NOW)}.`, clockTime(NOW - 30 * 60000, NOW), null, 'Accepted'],
  ]);
  // Token counts are short text, never numbers the renderer would write out in full.
  assert.deepEqual(agents.columns.map(column => column.label), ['Session', 'Agent', 'Model', 'In', 'Out', 'Cache', 'Cost']);
  assert.deepEqual(agents.rows, [
    ['Search speed', 'Opus 5.5', 'Opus 5.5', '150', '80k', '1.2M', '$6.00'],
    ['Search speed', '@qa', 'Fable 5.2', '16', '9k', '400k', '$2.10'],
    ['Fix the login form', 'Opus 5.5', 'Opus 5.5', '1.2k', '34k', '400k', '$3.10'],
  ]);
  const drawn = artifactsView(items, { width: 140, colour: false, now: NOW });
  const text = drawn.join('\n');
  for (const part of ['Sessions', 'Agents', 'Project', "Agent's ETA", 'Proof', 'Asks you', 'Which index should it use?', 'Accepted', 'Cache', '400k', '$3.10', `updated ${clockTime(NOW, NOW)}`]) assert.ok(text.includes(part), part);
  assert.ok(!text.includes('more column'), text);
  // What is at most, at least, or inside another row is said in the cell.
  const marks = agentsTable([
    { title: 'A', agent: '@lead', model: 'fable 5.2', tokens: counts([112, 41000, 4300000, 360000]), costUsd: 4.3, partial: true, atMost: false, within: null },
    { title: 'A', agent: '@lead helpers', model: 'fable 5.2', tokens: counts([100, 30000, 4000000, 300000]), costUsd: null, partial: false, atMost: true, within: '@lead' },
    { title: 'A', agent: '@qa', model: '', tokens: null, costUsd: null, partial: false, atMost: false, within: null },
  ]).rows;
  assert.deepEqual(marks, [['A', '@lead', 'Fable 5.2', '112', '41k', '4.3M', '≥$4.30'], ['A', '@lead helpers', 'Fable 5.2', '≤100', '≤30k', '≤4M', 'in @lead'], ['A', '@qa', null, null, null, null, '—']]);
  // Cache is what was read from the cache, as the Usage tab's Cache counts it: what was written to it is not added.
  assert.deepEqual(agentsTable([{ title: 'B', agent: '@lead', model: 'opus 5.5', tokens: counts([1000, 200, 50000, 20000]), costUsd: 1, partial: false, atMost: false, within: null }]).rows[0].slice(3, 6), ['1k', '200', '50k']);
});

test('on a narrow tab a long title or step gives up room before the state is pushed off the screen', () => {
  const long = 'Rewrite the whole checkout flow so that every coupon code is checked on the server before the order is placed';
  const tasks = [chat({ id: '1', title: long, state: 'running', activeRole: 'lead', activeSince: ago(3) }), chat({ id: '2', title: 'Short', state: 'answered' })];
  const view = overview([web({ name: 'a project with a very long name indeed', tasks, activity: [{ taskId: '1', step: `Run ${'npm test -- --grep coupon '.repeat(8)}` }] })], { now: NOW });
  for (const width of [150, 120, 100]) {
    const block = sessionsTable(view.status, { now: NOW, width }), drawn = artifactsView(overviewArtifacts(view, { width }), { width, colour: false, now: NOW });
    const wide = block.columns.map((column, at) => Math.max(column.label.length, ...block.rows.map(row => (row[at] ?? '–').length)));
    assert.ok(wide.reduce((sum, value) => sum + value, 0) + 12 <= width, `${width}: ${wide}`);
    assert.ok(!drawn.join('\n').includes('more column'), String(width));
    assert.ok(block.rows[1][1].endsWith('…') && block.rows[1][3].endsWith('…'), JSON.stringify(block.rows[1]));
    // The words, the times and the proof are never cut.
    assert.deepEqual(block.rows.map(row => row[2]), ['Ready for your check', 'Working']);
  }
  // Narrower than the columns can go: the renderer leaves the last ones out and says so; the state stays.
  const drawn = artifactsView(overviewArtifacts(view, { width: 56 }), { width: 56, colour: false, now: NOW }).join('\n');
  assert.ok(drawn.includes('Ready for your check') && drawn.includes('in a wider window'), drawn);
});

test('the state digest: one line per session that is not Done, at most 30 lines and 3,000 characters', () => {
  const { projects, boards } = day(), view = overview(projects, { now: NOW, boards });
  const digest = stateDigest(view);
  assert.deepEqual(digest.lines, [
    `Asks you: web #2 Search speed · Which index should it use? · since ${clockTime(NOW - 20 * 60000, NOW)} (20 min) · 2 agents, 2M tokens, $8.10`,
    `Working: web #1 Fix the login form · Edit src/login.ts · since ${clockTime(NOW - 48 * 60000, NOW)} (48 min) · ETA ${clockTime(NOW + 80 * 60000, NOW)} (agent's estimate) · 1 agent, 447k tokens, $3.10`,
  ]);
  assert.equal(digest.text, digest.lines.join('\n')); assert.deepEqual(digest.rows.map(row => row.id), ['2', '1']);
  assert.deepEqual([digest.left, digest.total, digest.asOf], [0, 2, new Date(NOW).toISOString()]);
  assert.deepEqual([DIGEST_ROWS, DIGEST_CHARS], [30, 3000]);
  // A helpers row that is a part of its bot's row is not added to the session's total again.
  const part = stateDigest({ now: NOW, status: view.status, agents: [{ root: '/work/web', id: '1', tokens: counts([1000, 0, 0, 0]), costUsd: 1, partial: false, runs: 1, within: null }, { root: '/work/web', id: '1', tokens: counts([900, 0, 0, 0]), costUsd: null, partial: false, runs: 1, within: '@lead' }] });
  assert.match(part.lines[1], /2 agents, 1k tokens, \$1\.00$/);
  // Many sessions with long titles and steps: the lines get shorter before any session is left out.
  const many = count => { const tasks = Array.from({ length: count }, (_, at) => chat({ id: String(at + 1), title: `Session number ${at + 1} "with a title" that goes on for quite a while longer`, state: at % 3 ? 'answered' : 'running', activeRole: 'lead', activeSince: ago(at + 1), createdAt: ago(200 + at), plan: plan({ estimateMinutes: 400 }), runs: [run('lead', 30, 'opus', [10, 1000, 20000, 3000, 0.4])] }));
    return overview([web({ tasks, activity: tasks.map(task => ({ taskId: task.id, step: `Run a long command that checks every single thing ${task.id} `.repeat(4) })) })], { now: NOW, proof: false }); };
  for (const count of [8, 20, 30, 45, 120]) {
    const made = stateDigest(many(count));
    assert.ok(JSON.stringify(made.lines).length <= 3000 && made.text.length <= 3000, `${count}: ${JSON.stringify(made.lines).length}`);
    assert.ok(made.rows.length <= 30 && made.rows.length >= Math.min(count, 20), `${count}: ${made.rows.length}`);
    assert.equal(made.total, count); assert.equal(made.left, count - made.rows.length);
    assert.equal(made.lines.length, made.rows.length + (made.left ? 1 : 0));
    if (made.left) assert.equal(made.lines.at(-1), `${made.left} more ${made.left === 1 ? 'session is' : 'sessions are'} not shown.`);
    // What needs the owner first is what is kept.
    assert.match(made.lines[0], /^Ready for your check: web #/);
  }
  assert.match(stateDigest(many(8)).lines[0], /agent, .* tokens/); assert.doesNotMatch(stateDigest(many(45)).lines[0], /tokens/);
  // A smaller budget, and none at all.
  const small = stateDigest(many(8), { rows: 3, chars: 400 });
  assert.ok(small.rows.length <= 3 && JSON.stringify(small.lines).length <= 400 && small.left === 8 - small.rows.length);
  assert.deepEqual(stateDigest({ now: NOW, status: [], agents: [] }).lines, []);
});

test('read from this computer\'s own records: a project, its session, its board', t => {
  const p = sampleProject(t), { repo } = liveTask(p.root, { id: '1', goal: 'Uppercase coupon codes', state: 'unverified' });
  registerProject(repo);
  const now = Date.now(), view = readOverview({ now });
  assert.deepEqual(view.status.map(row => [row.project, row.id, row.title, row.word, row.why, row.column]), [['sample app', '1', 'Uppercase coupon codes', 'Ready for your check', 'not verified', 'needs']]);
  // Its proof is the checklist's own rows, read from its folder with git.
  assert.deepEqual(view.status[0].proof.map(row => [row.key, row.met]), [['committed', false], ['checks', false], ['pushed', false], ['pull', false]]);
  assert.match(view.status[0].proof[0].evidence, /^Not committed: src\/coupon\.mjs\./);
  assert.deepEqual([view.status[0].done, view.agents], ['none', []]);
  assert.equal(overviewArtifacts(view).length, 2); assert.match(stateDigest(view).text, /^Ready for your check: sample app #1 Uppercase coupon codes · not verified · since /);
  // A look made a moment ago is given again while the tab is drawn; a new look reads again.
  assert.equal(readOverview({ now, within: 60000 }), view); assert.notEqual(readOverview({ now }), view);
  assert.deepEqual(readOverview({ now, except: { root: repo.root, id: '1' } }).status, []);
  // One session, for a tool that reads it.
  const one = readSession(repo.root, '1', { now });
  assert.equal(one.status.word, 'Ready for your check'); assert.deepEqual(one.agents, []);
  assert.equal(readSession(repo.root, '9'), null); assert.equal(readSession(path.join(p.parent, 'nowhere'), '1'), null);
  // The owner checks it: it is Done and Accepted, and git is not asked about it again.
  setDone(repo, { task: readTask(repo, '1') }, true);
  const done = readOverview({ now: Date.now() }).status[0];
  assert.deepEqual([done.word, done.done, proofText(done), done.proof], ['Done', 'accepted', 'Accepted', []]);
  assert.deepEqual(stateDigest(readOverview({ now: Date.now() })).lines, []);
});
