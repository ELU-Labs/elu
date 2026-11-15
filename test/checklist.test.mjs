import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, git } from './helpers.mjs';
import { liveTask } from './peer-helpers.mjs';
import { taskChanges } from '../lib/git.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { sessionChecklist, toldChecklist, cleanChecklist } from '../lib/checklist.mjs';
import { plainState, stateText, takeHead, toldState } from '../lib/task-head.mjs';
import { boardColumns, readBoard, sessionDetail } from '../lib/kanban.mjs';
import { remoteRow, rowBadge } from '../lib/board.mjs';
import { checkView, taskView } from '../lib/owner-check.mjs';
import { approveTask, proposeTask, reportProgress } from '../lib/plan.mjs';
import { formatResult } from '../lib/format.mjs';

// What a session's header used to say in one stored word (unverified, answered, ready…) is the
// checklist of its Task now (lib/checklist.mjs): rows from ELU's own records, each with ✓ or not
// and one line of evidence. The header says Task, and no view shows a stored state as stored.
const rows = list => list.map(row => [row.met ? '✓' : '·', row.text, row.evidence]);
const save = (repo, id, change) => { const task = readTask(repo, id); change(task); saveTask(repo, task); return readTask(repo, id); };

test('the checklist says from ELU\'s records whether the edits are committed, the checks passed, the review passed, and it is pushed with a pull request', t => {
  const p = project(t), { repo, worktree } = liveTask(p.root, { id: '1', goal: 'Uppercase coupon codes', state: 'unverified' });
  // Edited, nothing committed, never checked: what is not committed is named.
  let task = readTask(repo, '1');
  assert.deepEqual(rows(sessionChecklist(task)), [
    ['·', 'Edits committed', 'Not committed: src/coupon.mjs. /publish commits them.'],
    ['·', 'Checks passed', 'Not run since the last edit. /publish runs them first.'],
    ['·', 'Pushed', '/publish commits and pushes it.'],
    ['·', 'Pull request', '/publish opens a draft pull request.'],
  ]);
  // The agent committed it, and a file it added after is not committed.
  git(worktree, ['add', '.']); git(worktree, ['commit', '-m', 'Uppercase codes']);
  task = save(repo, '1', row => takeHead(row));
  fs.writeFileSync(path.join(worktree, 'notes.md'), 'later\n');
  assert.deepEqual(rows(sessionChecklist(task)).slice(0, 1), [['·', 'Edits committed', 'Not committed: notes.md. /changes shows them.']]);
  fs.rmSync(path.join(worktree, 'notes.md'));
  assert.deepEqual(rows(sessionChecklist(task))[0], ['✓', 'Edits committed', `Committed on feat/task-1 at ${task.commit.slice(0, 7)}.`]);
  // The checks: none of the project's own (not set), passed, failed, then an edit after them.
  const checked = results => save(repo, '1', row => { row.evidence = { base: row.base, digest: taskChanges(row).digest, results, checkedAt: new Date().toISOString() }; });
  task = checked([{ name: 'declared-paths', status: 'passed', details: [] }]);
  assert.deepEqual(rows(sessionChecklist(task))[1], ['·', 'Checks passed', 'Not set for this project: no test or build command checks the edits.']);
  task = checked([{ name: 'declared-paths', status: 'passed', details: [] }, { name: 'test', status: 'passed', logFile: '/x/check-test.log' }, { name: 'build', status: 'passed', logFile: '/x/check-build.log' }]);
  assert.deepEqual(rows(sessionChecklist(task))[1], ['✓', 'Checks passed', 'Passed: test and build.']);
  task = checked([{ name: 'declared-paths', status: 'passed', details: [] }, { name: 'test', status: 'failed', logFile: '/x/check-test.log' }]);
  assert.deepEqual(rows(sessionChecklist(task))[1], ['·', 'Checks passed', 'Failed: test.']);
  task = checked([{ name: 'test', status: 'passed', logFile: '/x/check-test.log' }]);
  fs.appendFileSync(path.join(worktree, 'src/coupon.mjs'), '// later\n'); git(worktree, ['commit', '-am', 'Later']); task = save(repo, '1', row => takeHead(row));
  assert.deepEqual(rows(sessionChecklist(task))[1], ['·', 'Checks passed', 'Not run since the last edit. /publish runs them first.']);
  task = checked([{ name: 'test', status: 'passed', logFile: '/x/check-test.log' }]);
  // The review: passed, or the fixes it still asks for. A session no bot reviews has no row for it.
  assert.equal(sessionChecklist(task).some(row => row.text === 'Review passed'), false);
  task = save(repo, '1', row => { row.reviewStatus = 'passed'; row.reviews = [{ round: 1, role: 'bot:qa', result: { summary: 'Fine', comments: [] } }]; });
  assert.deepEqual(rows(sessionChecklist(task))[2], ['✓', 'Review passed', '@qa asked for no fixes.']);
  task = save(repo, '1', row => { row.reviewStatus = 'blocked'; row.reviews.push({ round: 2, role: 'bot:qa', result: { summary: 'Two left', comments: [{ severity: 'must_fix', body: 'a' }, { severity: 'must_fix', body: 'b' }, { severity: 'note', body: 'c' }] } }); });
  assert.deepEqual(rows(sessionChecklist(task))[2], ['·', 'Review passed', 'It still asks for 2 fixes.']);
  // Pushed, and its pull request.
  task = save(repo, '1', row => { row.reviewStatus = 'passed'; row.committed = { ...row.committed, pushed: true }; });
  assert.deepEqual(rows(sessionChecklist(task)).slice(3), [['✓', 'Pushed', 'feat/task-1 is on the remote.'], ['·', 'Pull request', '/publish opens a draft pull request.']]);
  task = save(repo, '1', row => { row.pr = 'https://github.com/example/shop/pull/7'; });
  assert.deepEqual(rows(sessionChecklist(task)).at(-1), ['✓', 'Pull request', 'https://github.com/example/shop/pull/7']);
  assert.ok(sessionChecklist(task).every(row => row.met), 'all done');
});

test('the checklist says what a session waits for: an answer, an approval, a block with its reason, a stop, the turn at work; a chat that replied says so', t => {
  const p = project(t), { repo } = liveTask(p.root, { id: '2', goal: 'Export the report', state: 'needs_input' });
  let task = save(repo, '2', row => { row.reply = { outcome: 'needs_input', question: 'Which format should the export use?\nCSV or JSON.' }; });
  assert.deepEqual(rows(sessionChecklist(task))[0], ['·', 'Needs your answer', 'Which format should the export use?']);
  assert.deepEqual(rows(sessionChecklist(task, { approvals: [{ summary: 'Run npm test' }] }))[0], ['·', 'Needs your approval', 'It wants to Run npm test.']);
  task = save(repo, '2', row => { row.state = 'blocked'; row.reviewStatus = 'blocked'; row.reply = null; });
  assert.deepEqual(rows(sessionChecklist(task))[0], ['·', 'Blocked', 'The review still asks for fixes. Type continue to work on them.']);
  task = save(repo, '2', row => { row.state = 'stopped'; row.reviewStatus = null; row.error = { message: 'Stopped by the owner.' }; });
  assert.deepEqual(rows(sessionChecklist(task))[0], ['·', 'Stopped', 'You stopped it. Your changes are kept. Type continue to carry on.']);
  task = save(repo, '2', row => { row.state = 'running'; row.error = null; row.activeRole = 'checks'; });
  assert.deepEqual(rows(sessionChecklist(task)).slice(0, 2), [['·', 'Working now', 'The checks are running.'], ['·', 'Edits committed', 'Not committed: src/coupon.mjs. /publish commits them.']]);
  // A chat has no edits: it replied.
  const chat = { id: '3', kind: 'conversation', state: 'answered', goal: 'Where is the export?', reply: { summary: 'It is in lib/export.mjs.\nMore here.' } };
  assert.deepEqual(rows(sessionChecklist(chat)), [['✓', 'Replied', 'Its reply is in the chat.']]);
});

// A row's evidence is what ELU saw, never what the agent says it did: a chat that replied, and a
// session that changed no file, say so in ELU's own words whatever the reply claims.
test('a reply\'s own words are never a row\'s evidence: Replied and No edits say what ELU saw', t => {
  const chat = { id: '3', kind: 'conversation', state: 'answered', goal: 'Where is the export?', reply: { summary: 'It is in lib/export.mjs.' }, result: { summary: 'Fixed it.' } };
  assert.deepEqual(rows(sessionChecklist(chat)), [['✓', 'Replied', 'Its reply is in the chat.']]);
  const p = project(t), { repo } = liveTask(p.root, { id: '7', goal: 'Fix the coupon bug', state: 'answered', files: {} });
  const task = save(repo, '7', row => { row.reply = { outcome: 'done', summary: 'Fixed the bug in coupon.mjs.' }; });
  assert.deepEqual(rows(sessionChecklist(task)), [['✓', 'No edits', 'It changed no files.']]);
});

// elu status and elu run print a session's state in plain words, as every view does; --json
// prints the stored state (bin/elu-code.mjs), which this does not change.
test('elu status and elu run say each state in plain words, never as stored', () => {
  const listed = formatResult({ tasks: [{ id: '3', state: 'needs_input', goal: 'Export the report' }, { id: '4', state: 'answered', goal: 'Where is it?' }] });
  assert.equal(listed, 'Task 3: asks you — Export the report\nTask 4: replied — Where is it?\n');
  const ran = formatResult({ id: '5', state: 'unverified', goal: 'Trim the codes', result: { summary: 'Trimmed them.' } }, 'run');
  assert.match(ran, /^Task 5: not verified$/m);
  assert.doesNotMatch(listed + ran, /_|needs input|answered|unverified/);
});

test('no view says a stored state as stored: plain words for every state, on a Kanban card and a Sessions row, here and for another computer', t => {
  const words = Object.fromEntries(['running', 'preparing', 'needs_input', 'answered', 'ready', 'unverified', 'blocked', 'stopped', 'queued', 'starting', 'waiting'].map(state => [state, plainState(state)]));
  assert.deepEqual(words, { running: 'working', preparing: 'working', needs_input: 'asks you', answered: 'replied', ready: 'ready to publish', unverified: 'not verified', blocked: 'blocked', stopped: 'stopped', queued: 'queued', starting: 'starting', waiting: 'saved' });
  assert.equal(stateText({ state: 'unverified' }), 'not verified');
  assert.equal(toldState({ state: 'unverified', finished: true }), 'committed');
  assert.equal(sessionDetail({ id: '1', state: 'answered', kind: 'conversation' }), 'replied');
  assert.equal(sessionDetail({ id: '1', state: 'unverified' }), 'not verified');
  // A Sessions row, here and on another computer of mine.
  assert.equal(rowBadge({ kind: 'task', task: { state: 'stopped' }, group: 3 }).title, 'stopped');
  const there = remoteRow({ id: 'r1', machine: 'k', state: 'answered', title: 'Where is the export?', createdAt: new Date().toISOString(), lastAt: new Date().toISOString(), approvals: [] }, 'devbox');
  assert.equal(there.label, 'replied'); assert.equal(rowBadge(there).title, 'on devbox · replied');
  assert.equal(rowBadge(remoteRow({ id: 'r2', machine: 'k', state: 'unverified', title: 'Fix', createdAt: new Date().toISOString(), lastAt: new Date().toISOString(), approvals: [] }, 'devbox')).title, 'on devbox · not verified');
  // A Kanban card: a session that replied, one not verified, and a message waiting to start.
  const p = project(t), { repo } = liveTask(p.root, { id: '4', goal: 'Tidy notes', state: 'unverified' });
  const columns = boardColumns(readBoard(repo), { tasks: [readTask(repo, '4'), { id: '5', kind: 'conversation', state: 'answered', goal: 'Where?', createdAt: new Date().toISOString(), messages: [] }], queue: [{ id: 'q1', state: 'waiting', goal: 'Later', createdAt: new Date().toISOString() }] });
  const details = columns.flatMap(column => column.items.map(item => item.detail));
  assert.ok(details.every(detail => !/_|unverified|answered|\bwaiting\b/.test(detail)), details.join(' | '));
  assert.ok(details.some(detail => /^not verified/.test(detail)) && details.some(detail => /^replied/.test(detail)) && details.includes('saved'), details.join(' | '));
});

test('the Task view and the check carry the checklist: with no Task its goal is the first message, and it says when it waits for the owner\'s check', t => {
  const p = project(t), { repo } = liveTask(p.root, { id: '6', goal: 'Uppercase coupon codes\nand trim them', state: 'ready' });
  let view = taskView(repo, readTask(repo, '6'));
  assert.deepEqual([view.title, view.goal, view.objectives, view.waits], ['Uppercase coupon codes', 'Uppercase coupon codes\nand trim them', null, true]);
  assert.deepEqual(view.checklist.map(row => row.text), ['Edits committed', 'Checks passed', 'Pushed', 'Pull request']);
  assert.deepEqual(checkView(repo, readTask(repo, '6')).checklist, view.checklist, 'the check shows the same rows');
  // With a Task: its goal and objectives with the agent's marks; one that waits for approval says so and is still shown.
  proposeTask(repo, '6', { title: 'Uppercase coupons', description: 'Make it so.', goal: 'Codes compare equal.', objectives: ['normalize returns upper case', 'The test passes'], priority: 'medium', severity: 'low' });
  view = taskView(repo, readTask(repo, '6'));
  assert.deepEqual([view.goal, view.proposed, view.waits], ['Codes compare equal.', true, false]);
  approveTask(repo, '6'); reportProgress(repo, '6', { met: [1], evidence: [[1, 'src/coupon.mjs returns value.toUpperCase()']] });
  view = taskView(repo, readTask(repo, '6'));
  assert.deepEqual(view.objectives, [{ text: 'normalize returns upper case', met: true, evidence: 'src/coupon.mjs returns value.toUpperCase()' }, { text: 'The test passes', met: false, evidence: null }]);
  // One at work does not wait for the check.
  assert.equal(taskView(repo, save(repo, '6', row => { row.state = 'running'; })).waits, false);
});

test('an older computer\'s session gets the rows its list told; a checklist another computer sends is kept whole, every row, each a line', () => {
  assert.deepEqual(rows(toldChecklist({ state: 'needs_input', question: 'Which folder?' })), [['·', 'Needs your answer', 'Which folder?']]);
  assert.deepEqual(rows(toldChecklist({ state: 'unverified', finished: true })), [['✓', 'Edits committed', 'Its work is committed.']]);
  assert.deepEqual(rows(toldChecklist({ state: 'stopped', error: 'Stopped before it finished. Type continue to carry on.' })), [['·', 'Stopped', 'Stopped before it finished. Type continue to carry on.']]);
  // No number of rows and no length of ours: every row, its text and its evidence whole, each made one line.
  const kept = cleanChecklist([...Array.from({ length: 20 }, (_, index) => ({ text: `Row ${index} ${'t'.repeat(300)}`, met: index % 2 === 0, evidence: `${'x'.repeat(400)}\n${'y'.repeat(4000)}` })), null, { text: '' }]);
  assert.equal(kept.length, 20); assert.equal(kept[19].text, `Row 19 ${'t'.repeat(300)}`); assert.equal(kept[0].evidence, `${'x'.repeat(400)} ${'y'.repeat(4000)}`); assert.deepEqual([kept[0].met, kept[1].met], [true, false]);
  assert.deepEqual(cleanChecklist('no'), []);
});
