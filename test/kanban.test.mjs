import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readBoard, addCard, editCard, removeCard, startCard, linkCards, setDone, boardColumns, fitDetail, fitCard, closeSession, reopenSession } from '../lib/kanban.mjs';
import { project } from './helpers.mjs';
import { projectFolder } from '../lib/workspace.mjs';

const names = columns => Object.fromEntries(columns.map(column => [column.column, column.items.map(item => item.title)]));
const task = (id, goal, state, extra = {}) => ({ id, goal, state, createdAt: new Date().toISOString(), runs: [], messages: [], ...extra });

test('cards wait in To do, follow their session once started, and go to Done by hand', t => {
  const p = project(t), repo = projectFolder(p.root);
  const first = addCard(repo, 'Add rate limiting to login'), second = addCard(repo, 'Write coupon docs');
  assert.throws(() => addCard(repo, '   '), /1 to 16000/);
  editCard(repo, second.id, 'Write coupon API docs');
  let columns = boardColumns(readBoard(repo), { tasks: [], queue: [] });
  assert.deepEqual(names(columns), { todo: ['Add rate limiting to login', 'Write coupon API docs'], progress: [], needs: [], done: [] });
  // Started: queued, then a session that runs, then stops for the owner.
  startCard(repo, first.id, 'request-1');
  assert.throws(() => editCard(repo, first.id, 'x'), /Only a To do task/); assert.throws(() => removeCard(repo, first.id), /Move it to Done/);
  columns = boardColumns(readBoard(repo), { tasks: [], queue: [{ id: 'request-1', goal: 'Add rate limiting to login', state: 'queued' }] });
  assert.deepEqual(names(columns).progress, ['Add rate limiting to login']); assert.equal(columns[1].items[0].detail, 'queued');
  assert.equal(linkCards(repo, [{ id: 'request-1', state: 'running', taskId: '4' }]), true);
  assert.equal(readBoard(repo).cards[0].taskId, '4');
  columns = boardColumns(readBoard(repo), { tasks: [task('4', 'Add rate limiting to login', 'running')], queue: [] });
  // A bot at work in the session is named as the owner writes it. No card shows a session number.
  const detail = extra => boardColumns(readBoard(repo), { tasks: [task('4', 'Add rate limiting to login', 'running', { activeRole: 'bot:sec', ...extra })], queue: [] }).flatMap(column => column.items).find(item => item.task?.id === '4').detail;
  assert.equal(detail({}), '@sec reviewing');
  assert.equal(detail({ messages: [{ at: new Date().toISOString(), text: 'safe?', to: '@sec' }] }), '@sec answering');
  assert.equal(columns[1].items[0].detail, 'working');
  columns = boardColumns(readBoard(repo), { tasks: [task('4', 'Add rate limiting to login', 'ready')], queue: [] });
  assert.deepEqual(names(columns).needs, ['Add rate limiting to login']); assert.equal(columns[2].items[0].detail, 'ready to publish');
  setDone(repo, columns[2].items[0], true);
  columns = boardColumns(readBoard(repo), { tasks: [task('4', 'Add rate limiting to login', 'ready')], queue: [] });
  assert.deepEqual(names(columns).done, ['Add rate limiting to login']);
  setDone(repo, columns[3].items[0], false);
  assert.equal(readBoard(repo).cards[0].column, 'started', 'a started card reopens to its session');
  removeCard(repo, second.id); assert.equal(readBoard(repo).cards.length, 1);
  assert.ok(fs.existsSync(path.join(repo.state, 'kanban.json'))); assert.equal(fs.existsSync(path.join(p.root, '.elu-code', 'kanban.json')), false, 'the board is not a project file');
});

test('a session with a Task is on the board as that Task, and one that waits for approval is under Needs you', () => {
  const plan = (state, extra = {}) => ({ id: 't-1', title: 'Uppercase coupons', priority: 'high', severity: 'low', state, objectives: ['Upper case', 'The test passes'], met: [], subtasks: [], ...extra });
  const steps = [{ id: 's1', text: 'Change normalize', state: 'done' }, { id: 's2', text: 'Run the test', state: 'doing' }];
  const empty = { cards: [], done: [], closed: {}, archived: [] };
  const cards = (tasks, board = empty) => boardColumns(board, { tasks, queue: [] }).flatMap(column => column.items.map(item => [column.column, item.title, item.detail, item.note]));
  // It waits for the owner's yes: the session rests as an answer leaves it, and the card is under Needs you, not Done.
  assert.deepEqual(cards([task('1', 'Make coupons upper case', 'answered', { kind: 'conversation', plan: plan('proposed') })]),
    [['needs', 'Uppercase coupons', 'to approve · high · low', 'Task · waits for your approval · high priority · low severity · session: Make coupons upper case']]);
  // Approved and being worked on: the count of subtasks done. The session has the Task's name by now.
  const named = { title: 'Uppercase coupons' };
  assert.deepEqual(cards([task('1', 'Make coupons upper case', 'running', { ...named, plan: plan('approved', { subtasks: steps }) })]),
    [['progress', 'Uppercase coupons', '1/2 · high · low', 'Task · approved · 1 of 2 subtasks done · high priority · low severity · working']]);
  assert.deepEqual(cards([task('1', 'Make coupons upper case', 'running', { ...named, plan: plan('approved') })])[0].slice(2), ['approved · high · low', 'Task · approved · no subtasks yet · high priority · low severity · working']);
  // Under Needs you what the session waits for comes first.
  assert.deepEqual(cards([task('1', 'Make coupons upper case', 'needs_input', { ...named, plan: plan('approved', { subtasks: steps }) })]),
    [['needs', 'Uppercase coupons', 'asks you · 1/2 · high · low', 'Task · approved · 1 of 2 subtasks done · high priority · low severity · asks you']]);
  assert.deepEqual(cards([task('1', 'Make coupons upper case', 'ready', { ...named, plan: plan('done', { met: [1, 2], subtasks: steps }) })]),
    [['needs', 'Uppercase coupons', 'ready to publish · done 2/2 · high · low', 'Task · done · 2 of 2 objectives reported met · high priority · low severity · ready to publish']]);
  // Beside a title the detail is cut between its parts, never inside a word.
  assert.equal(fitDetail('to approve · high · low', 17), 'to approve · high'); assert.equal(fitDetail('to approve · high · low', 16), 'to approve');
  assert.equal(fitDetail('ready to publish · done 2/2 · high · low', 17), 'ready to publish'); assert.equal(fitDetail('1/2 · high · low', 40), '1/2 · high · low'); assert.equal(fitDetail('to approve · high · low', 5), '');
  // A rejected Task leaves the session's own card.
  assert.deepEqual(cards([task('1', 'Make coupons upper case', 'answered', { kind: 'conversation', plan: plan('rejected') })]), [['done', 'Make coupons upper case', 'answered', undefined]]);
  // A card the owner wrote keeps its own words; its session's Task shows beside them.
  const written = { ...empty, cards: [{ id: 'card-1', text: 'Coupons in capitals\nmore', column: 'started', requestId: 'request-1', taskId: '1' }] };
  assert.deepEqual(cards([task('1', 'Coupons in capitals', 'answered', { kind: 'conversation', plan: plan('proposed') })], written),
    [['needs', 'Coupons in capitals', 'to approve · high · low', 'Task · waits for your approval · high priority · low severity · session: Coupons in capitals']]);
});

test('a Task card is its title first: the detail goes beside a whole title, and only a title longer than the column is cut', () => {
  const waits = 'to approve · high · low', works = '1/2 · high · low', done = 'ready to publish · done 2/2 · high · low';
  // 38 cells, four columns in a wide terminal: the whole title and the parts that fit beside it.
  assert.deepEqual(fitCard('Uppercase coupons', waits, 38), { title: 'Uppercase coupons', detail: 'to approve · high' });
  assert.deepEqual(fitCard('Uppercase coupons', works, 38), { title: 'Uppercase coupons', detail: works });
  // 23 cells, four columns at 108: a title that fits is whole, and nothing that does not fit beside it takes its room.
  assert.deepEqual(fitCard('Round refunds to cents', done, 23), { title: 'Round refunds to cents', detail: '' });
  assert.deepEqual(fitCard('Uppercase coupons', waits, 23), { title: 'Uppercase coupons', detail: '' });
  assert.deepEqual(fitCard('Uppercase coupons', works, 23), { title: 'Uppercase coupons', detail: '1/2' });
  assert.deepEqual(fitCard('Round refunds to cents!', waits, 23), { title: 'Round refunds to cents!', detail: '' });
  // A title longer than the column is cut at a word. The first part stays beside it while the title keeps three fifths of the width.
  const long = 'Round every refund to whole cents before it is sent to banks'; assert.equal(long.length, 60);
  assert.deepEqual(fitCard(long, waits, 38), { title: 'Round every refund to…', detail: 'to approve' });
  assert.deepEqual(fitCard(long, waits, 23), { title: 'Round every refund to…', detail: '' });
  assert.deepEqual(fitCard(long, works, 23), { title: 'Round every…', detail: '1/2' });
  // One long word is cut inside, to the cell.
  const word = 'refundRoundingAndCurrencyConversionHelpers';
  assert.deepEqual(fitCard(word, waits, 38), { title: 'refundRoundingAndCurrency…', detail: 'to approve' });
  assert.deepEqual(fitCard(word, waits, 23), { title: 'refundRoundingAndCurre…', detail: '' });
  // A cut at a word that would leave most of the line empty is made inside the word instead.
  assert.deepEqual(fitCard(`A ${word} rewrite`, waits, 23), { title: 'A refundRoundingAndCur…', detail: '' });
  for (const width of [4, 12, 23, 38, 60]) for (const title of ['Uppercase coupons', long, word]) for (const detail of [waits, works, done, '']) {
    const card = fitCard(title, detail, width); assert.ok(card.title.length + (card.detail ? card.detail.length + 2 : 0) <= width, `${width}: ${card.title}  ${card.detail}`);
  }
});

test('sessions typed elsewhere appear by state; answered questions are done, old quiet ones drop off', t => {
  const p = project(t), repo = projectFolder(p.root), old = new Date(Date.now() - 30 * 86400000).toISOString();
  const tasks = [
    task('1', 'Speed up search', 'running'), task('2', 'Which cache does checkout use?', 'needs_input'),
    task('3', 'What is our test runner?', 'answered', { kind: 'conversation' }), task('5', 'Fix the footer', 'ready', { pr: 'https://github.com/x/y/pull/1' }),
    task('6', 'Ancient experiment', 'stopped', { createdAt: old }), task('7', 'Rename billing', 'blocked'),
  ];
  const queue = [{ id: 'request-9', goal: 'Bump dependencies', state: 'queued', createdAt: new Date(Date.now() + 1000).toISOString() }, { id: 'request-10', goal: 'Follow-up', state: 'queued', continuationTaskId: '2' }, { id: 'request-11', goal: 'Peer ask', state: 'waiting', origin: { kind: 'ask' } }];
  let columns = boardColumns(readBoard(repo), { tasks, queue });
  assert.deepEqual(names(columns), { todo: [], progress: ['Speed up search', 'Bump dependencies'], needs: ['Which cache does checkout use?', 'Rename billing'], done: ['What is our test runner?', 'Fix the footer'] });
  setDone(repo, columns[2].items[1], true);
  columns = boardColumns(readBoard(repo), { tasks, queue });
  assert.ok(names(columns).done.includes('Rename billing')); assert.deepEqual(names(columns).needs, ['Which cache does checkout use?']);
  // An archived session is on no column, Done included. One moved to Done by hand stays there.
  const shown = value => value.flatMap(column => column.items).some(item => item.task?.id === '3');
  assert.equal(shown(columns), true); closeSession(repo, '3');
  columns = boardColumns(readBoard(repo), { tasks, queue });
  assert.equal(shown(columns), false); assert.deepEqual([...names(columns).done].sort(), ['Fix the footer', 'Rename billing']);
  // A new message opens it again, and so does bringing it back by hand.
  const written = tasks.map(row => row.id === '3' ? { ...row, messages: [{ at: new Date(Date.now() + 60000).toISOString(), text: 'And in CI?' }] } : row);
  assert.ok(names(boardColumns(readBoard(repo), { tasks: written, queue })).done.includes('What is our test runner?'));
  reopenSession(repo, '3'); assert.ok(names(boardColumns(readBoard(repo), { tasks, queue })).done.includes('What is our test runner?'));
});
