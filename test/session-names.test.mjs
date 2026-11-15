import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project } from './helpers.mjs';
import { liveTask } from './peer-helpers.mjs';
import { repository } from '../lib/git.mjs';
import { projectSnapshot } from '../lib/projects.mjs';
import { readTask, saveTask, taskTitle, setTitle, suggestTitle, titleFromTask, modelTitle, hasTitle, nameFile, lock, TITLE_MAX, MODEL_TITLE_MAX } from '../lib/state.mjs';

// A project whose list is read: ELU's own folder is in a temporary place for the test,
// so the record of approved project files is never written to the real one.
function listedProject(t) {
  const p = project(t), previous = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = path.join(p.parent, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  return p;
}

test('a name from the model is taken only as two to six plain words on one line', () => {
  for (const [given, taken] of [['Coupon normalization question', 'Coupon normalization question'], ['  "Receipt email fixes."  ', 'Receipt email fixes'], ['Fix read/write split', 'Fix read/write split'],
    ['Remises de l’été', 'Remises de l’été'], ['レシートの合計', 'レシートの合計'], ['Raise coverage   to 80%', 'Raise coverage to 80%'], ['a b c d e f', 'a b c d e f']]) assert.equal(modelTitle(given), taken, given);
  const bad = ['', '   ', 'Coupons', 'a b c d e f g', `Receipt email ${'x'.repeat(MODEL_TITLE_MAX)}`, 'Coupon\nnormalization', 'Coupon\tfix now', 'Coupon \x1b[31mfix', 'Coupon \u202efix now', 'Coupon\u200b fix now',
    '/srv/shots/first run@2x.png', 'Fix src/coupon.mjs rounding', 'Look at ~/notes today', 'Fix ../lib rounding', 'Read a/b/c first', 'Fix lib/state-2 names', 'C:\\temp\\run notes', 'See https://example.test now',
    '<b>Coupon</b> fix', '**Coupon fix**', '`coupon` fix', '{bold}Coupon fix{/bold}', '# Coupon fix', '[Coupon](fix) now', 'Coupon | fix', '... --- !!!'];
  for (const given of bad) assert.equal(modelTitle(given), null, JSON.stringify(given));
  for (const given of [null, undefined, 7, true, ['Coupon fix'], { name: 'Coupon fix' }]) assert.equal(modelTitle(given), null);
});

test('without a name a session shows the first words of its request, in one row cut at a word', () => {
  const long = 'Work on our receipt email, we have two cases for it that need to be corrected, one is this: /srv/shots/first run@2x.png as you can see the total is off';
  const shown = taskTitle({ goal: `${long}\nand a second line` });
  assert.equal(shown, 'Work on our receipt email, we have two cases for it that…'); assert.ok(shown.length <= TITLE_MAX && !shown.includes('\n'));
  assert.equal(taskTitle({ goal: 'Where is coupon normalization?' }), 'Where is coupon normalization?');
  assert.equal(taskTitle({ goal: '\n\n  Trim   spaces\tin codes  \nmore' }), 'Trim spaces in codes'); assert.equal(taskTitle({ goal: 'x'.repeat(200) }), `${'x'.repeat(TITLE_MAX - 1)}…`);
  assert.equal(taskTitle({ goal: `${'word '.repeat(11)}stop, and more words after it` }), `${'word '.repeat(11)}stop…`, 'a cut right after a word keeps the word');
  assert.equal(taskTitle({ goal: `Trim the codes, ${'x'.repeat(70)}` }), 'Trim the codes…', 'no comma is left before the dots');
  assert.equal(taskTitle({ goal: long, title: 'Receipt email fixes' }), 'Receipt email fixes'); assert.equal(taskTitle({}), '');
});

test('the model names a session once; the owner\'s name always shows, and comes off to the model\'s again', t => {
  const p = listedProject(t), repo = repository(p.root), title = id => { const task = readTask(repo, id); return [task.title, task.titleBy]; }, shown = id => projectSnapshot(repo).tasks.find(task => task.id === id);
  liveTask(p.root, { id: '2', goal: 'Where is coupon normalization, and which file would change?', state: 'ready' });
  assert.equal(hasTitle(repo, '2'), false); assert.equal(fs.existsSync(nameFile(repo, '2')), false);
  // A name that is not one changes nothing, and the session can still be named.
  for (const bad of ['/srv/app/src/coupon.mjs', 'Coupons', '<b>Coupon</b> fix', 7]) assert.equal(suggestTitle(repo, '2', bad), false);
  assert.equal(hasTitle(repo, '2'), false); assert.equal(taskTitle(readTask(repo, '2')), 'Where is coupon normalization, and which file would change?');
  // It is saved while a turn holds the session, and shows at once.
  const release = lock(repo, 'task-2');
  try { assert.equal(suggestTitle(repo, '2', 'Coupon normalization question'), true); } finally { release(); }
  assert.deepEqual(title('2'), ['Coupon normalization question', 'model']); assert.equal(shown('2').title, 'Coupon normalization question'); assert.equal(hasTitle(repo, '2'), true);
  assert.equal(suggestTitle(repo, '2', 'Another name entirely'), false, 'the first name stays'); assert.deepEqual(title('2'), ['Coupon normalization question', 'model']);
  // The owner's name shows over it. A later name from the model changes nothing.
  assert.deepEqual([setTitle(repo, '2', 'My coupons').title, setTitle(repo, '2', 'My coupons').titleBy], ['My coupons', 'owner']); assert.equal(shown('2').titleBy, 'owner');
  assert.equal(suggestTitle(repo, '2', 'Yet another name'), false); assert.deepEqual(title('2'), ['My coupons', 'owner']);
  assert.deepEqual([setTitle(repo, '2', '').title, title('2')[1]], ['Coupon normalization question', 'model'], 'taken away, the model\'s name is back');
  // The owner named it first: the model's name is kept under it and never shows until the owner's is gone.
  liveTask(p.root, { id: '3', goal: 'Read the logs of the last run', state: 'ready' }); setTitle(repo, '3', 'Log reading');
  assert.equal(suggestTitle(repo, '3', 'Last run logs'), true); assert.deepEqual(title('3'), ['Log reading', 'owner']);
  setTitle(repo, '3', ''); assert.deepEqual(title('3'), ['Last run logs', 'model']);
  // A name older versions saved in the record is the owner's, and is kept when the model's arrives.
  liveTask(p.root, { id: '4', goal: 'Bump the dependencies', state: 'ready' }); saveTask(repo, { ...readTask(repo, '4'), title: 'Dependency bump' });
  assert.equal(hasTitle(repo, '4'), true); assert.equal(suggestTitle(repo, '4', 'Bump project dependencies'), true); assert.deepEqual(title('4'), ['Dependency bump', 'owner']);
  // A name file that was tampered with names nothing unsafe.
  fs.writeFileSync(nameFile(repo, '4'), JSON.stringify({ owner: 'two\x07tone', model: '/srv/app/secret path' })); assert.deepEqual(title('4'), [undefined, undefined]); assert.equal(taskTitle(readTask(repo, '4')), 'Bump the dependencies');
  fs.writeFileSync(nameFile(repo, '4'), '{ not json'); assert.equal(taskTitle(readTask(repo, '4')), 'Dependency bump', 'an unreadable name file counts as none');
});

test('an approved Task names its session over the model\'s name, and never over the owner\'s', t => {
  const p = listedProject(t), repo = repository(p.root), title = id => { const task = readTask(repo, id); return [task.title, task.titleBy]; };
  liveTask(p.root, { id: '2', goal: 'Where is coupon normalization, and which file would change?', state: 'ready' });
  assert.equal(suggestTitle(repo, '2', 'Coupon normalization question'), true);
  // Saved while a turn holds the session. It shows in place of the model's name.
  const release = lock(repo, 'task-2');
  try { assert.equal(titleFromTask(repo, '2', '  Trim coupon codes\n before comparing  '), true); } finally { release(); }
  assert.deepEqual(title('2'), ['Trim coupon codes before comparing', 'task']); assert.equal(projectSnapshot(repo).tasks.find(task => task.id === '2').titleBy, 'task'); assert.equal(hasTitle(repo, '2'), true);
  // A later Task replaces it; one that is too long is cut at a word; one that is not plain text changes nothing.
  assert.equal(titleFromTask(repo, '2', 'Round refunds to the cent'), true); assert.deepEqual(title('2'), ['Round refunds to the cent', 'task']);
  assert.equal(titleFromTask(repo, '2', 'Round \x1b[31mrefunds'), false); assert.equal(titleFromTask(repo, '2', 'Round\u202e refunds'), false); assert.deepEqual(title('2'), ['Round refunds to the cent', 'task']);
  assert.equal(titleFromTask(repo, '2', `Make the receipt email show both of its taxes ${'and more '.repeat(9)}`), true);
  assert.deepEqual(title('2'), ['Make the receipt email show both of its taxes and more and…', 'task']); assert.ok(title('2')[0].length <= TITLE_MAX);
  // The owner's name shows over it, stays when a Task is approved, and gives way to the Task's title only when the owner takes it away.
  assert.equal(setTitle(repo, '2', 'My coupons').titleBy, 'owner'); assert.equal(titleFromTask(repo, '2', 'Round refunds to the cent'), true); assert.deepEqual(title('2'), ['My coupons', 'owner']);
  assert.deepEqual([setTitle(repo, '2', '').title, title('2')[1]], ['Round refunds to the cent', 'task']);
  // An empty title takes the Task's away: the model's name is back.
  assert.equal(titleFromTask(repo, '2', ''), true); assert.deepEqual(title('2'), ['Coupon normalization question', 'model']);
  // A name older versions saved in the record stays the owner's when a Task is approved.
  liveTask(p.root, { id: '3', goal: 'Bump the dependencies', state: 'ready' }); saveTask(repo, { ...readTask(repo, '3'), title: 'Dependency bump' });
  assert.equal(titleFromTask(repo, '3', 'Bump project dependencies'), true); assert.deepEqual(title('3'), ['Dependency bump', 'owner']);
  // A turn saves its copy of the record, the model's name in it. With the name file gone that copy is not the owner's name.
  liveTask(p.root, { id: '4', goal: 'Why is the build slow?', state: 'ready' }); assert.equal(suggestTitle(repo, '4', 'Slow build question'), true);
  saveTask(repo, readTask(repo, '4')); fs.rmSync(nameFile(repo, '4'));
  assert.equal(titleFromTask(repo, '4', 'Speed up the build'), true); assert.deepEqual(title('4'), ['Speed up the build', 'task']);
  assert.throws(() => titleFromTask(repo, '9', 'No such session'));
});

test("a session a schedule's run started keeps the schedule's wording: only the owner's name shows over it", t => {
  const p = listedProject(t), repo = repository(p.root), title = id => { const task = readTask(repo, id); return [taskTitle(task), task.titleBy]; };
  liveTask(p.root, { id: '2', goal: 'Review the unreviewed session findings\nand record a verdict', state: 'ready' }); saveTask(repo, { ...readTask(repo, '2'), scheduleId: 'schedule-0a1b2c3d' });
  // Neither the model's name nor an approved Task's title shows on it, in the list or anywhere.
  assert.equal(suggestTitle(repo, '2', 'Adjudicate unreviewed findings'), true); assert.equal(titleFromTask(repo, '2', 'Record verdicts'), true);
  assert.deepEqual(title('2'), ['Review the unreviewed session findings', undefined]);
  assert.equal(taskTitle(projectSnapshot(repo).tasks.find(task => task.id === '2')), 'Review the unreviewed session findings');
  // The owner's name shows; taken away, the wording is back.
  setTitle(repo, '2', 'Backlog review'); assert.deepEqual(title('2'), ['Backlog review', 'owner']);
  setTitle(repo, '2', ''); assert.deepEqual(title('2'), ['Review the unreviewed session findings', undefined]);
  // A session the owner started is named as before.
  liveTask(p.root, { id: '3', goal: 'Review the unreviewed session findings', state: 'ready' }); assert.equal(suggestTitle(repo, '3', 'Adjudicate unreviewed findings'), true);
  assert.deepEqual(title('3'), ['Adjudicate unreviewed findings', 'model']);
});
