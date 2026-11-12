import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readBoard, addCard, editCard, removeCard, startCard, linkCards, setDone, boardColumns, fitDetail, fitCard, fitTeammateCard, teammateLabel, closeSession, reopenSession, sessionPlace } from '../lib/kanban.mjs';
import { boardSlice, folderRemote, projectBoards, repoName } from '../lib/kanban-repos.mjs';
import { project, git } from './helpers.mjs';
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

test('teammates\' Tasks are cards on the same columns, with their name, counted with mine', t => {
  const p = project(t), repo = projectFolder(p.root), now = Date.now(), ago = minutes => new Date(now - minutes * 60000).toISOString();
  addCard(repo, 'My own card');
  const shared = (extra = {}) => ({ repoId: 'e'.repeat(64), handle: 'shop', id: 't-1', revision: 1, title: 'Fix the real issues', description: '', goal: 'It works.', objectives: ['One', 'Two'], priority: 'high', severity: 'medium', state: 'approved', startedBy: 'owner', who: 'Opus 5.5',
    subtasks: [{ text: 'A', state: 'done' }, { text: 'B', state: 'doing' }], met: [], approvedAt: ago(30), doneAt: null, updatedAt: ago(2), ...extra });
  const people = [
    { peer: 'b'.repeat(64), name: 'sara', box: 'devbox', online: true, heardAt: ago(0), tasks: [shared(), shared({ id: 't-2', title: 'Old work', state: 'done', met: [1, 2], doneAt: ago(60) })] },
    { peer: 'c'.repeat(64), name: 'li', box: null, online: false, heardAt: ago(90), tasks: [shared({ id: 't-3', title: 'Li work', subtasks: [] })] },
  ];
  const columns = boardColumns(readBoard(repo), { tasks: [task('4', 'My session', 'running')], queue: [] }, now, people);
  assert.deepEqual(names(columns), { todo: ['My own card'], progress: ['Fix the real issues', 'Li work', 'My session'], needs: [], done: ['Old work'] });
  const items = columns.flatMap(column => column.items), sara = items.find(item => item.title === 'Fix the real issues');
  assert.equal(sara.detail, 'sara on devbox · 1/2 · high · medium');
  assert.equal(items.find(item => item.title === 'Li work').detail, 'li · approved · high · medium');
  assert.equal(items.find(item => item.title === 'Old work').detail, 'sara on devbox · done 2/2 · high · medium');
  assert.equal(sara.note, "sara on devbox's Task · approved · 1 of 2 subtasks done · high priority · medium severity · worked on by Opus 5.5 · read-only");
  assert.match(items.find(item => item.title === 'Li work').note, /· offline · read-only$/);
  assert.deepEqual([sara.teammate.name, sara.shared.id, sara.key, Boolean(sara.card || sara.task || sara.request)], ['sara', 't-1', `peer-${'b'.repeat(64)}/t-1`, false]);
  // The counts each column shows include them.
  assert.deepEqual(columns.map(column => column.items.length), [1, 3, 0, 1]);
  // None, or nothing usable, changes nothing.
  assert.deepEqual(names(boardColumns(readBoard(repo), { tasks: [], queue: [] }, now, [{ name: 'x' }, null])), { todo: ['My own card'], progress: [], needs: [], done: [] });
  // The name stays beside the title however narrow the column, and a long name is cut.
  assert.deepEqual(fitTeammateCard('Fix the real ELU issues in the web app', 'sara on devbox · 1/2 · high', 30), { title: 'Fix the real…', detail: 'sara on devbox' });
  assert.deepEqual(fitTeammateCard('Short', 'sara · 1/2 · high', 30), { title: 'Short', detail: 'sara · 1/2 · high' });
  assert.equal(teammateLabel({ name: 'a'.repeat(40), box: 'b'.repeat(40) }).length, 24 + 4 + 24);
  assert.deepEqual(fitTeammateCard('Title', teammateLabel({ name: 'a'.repeat(40), box: 'b'.repeat(40) }), 20), { title: 'Title', detail: `${'a'.repeat(9)}…` });
});

test('a session\'s place on the board is the column boardColumns shows it in, or none', t => {
  const p = project(t), repo = projectFolder(p.root), old = new Date(Date.now() - 30 * 86400000).toISOString();
  const tasks = [task('1', 'Speed up search', 'running'), task('2', 'Which cache?', 'needs_input'), task('3', 'What runner?', 'answered', { kind: 'conversation' }), task('6', 'Ancient', 'stopped', { createdAt: old }),
    task('7', 'Rename billing', 'blocked'), task('8', 'A teammate asks', 'needs_input', { origin: { kind: 'ask', peer: 'b'.repeat(64) } }), task('9', 'Started from a card', 'ready')];
  const card = addCard(repo, 'My words for it'); startCard(repo, card.id, 'request-1'); linkCards(repo, [{ id: 'request-1', taskId: '9' }]);
  setDone(repo, { task: tasks[4] }, true); closeSession(repo, '3');
  const board = readBoard(repo), shown = new Map(boardColumns(board, { tasks, queue: [] }).flatMap(column => column.items.filter(item => item.task).map(item => [item.task.id, column.column])));
  for (const row of tasks) assert.equal(sessionPlace(board, row), shown.get(row.id) ?? null, row.goal);
  assert.deepEqual(tasks.map(row => sessionPlace(board, row)), ['progress', 'needs', null, null, 'done', null, 'needs']);
});

test('teammates\' sessions are cards in the column their board has them, with who started them and where; a Task told with one is that card', t => {
  const p = project(t), repo = projectFolder(p.root), now = Date.now(), ago = minutes => new Date(now - minutes * 60000).toISOString();
  const sara = 'b'.repeat(64), card = (extra = {}) => ({ repoId: 'e'.repeat(64), id: '0123456789abcdef', title: 'Fix the cart', column: 'progress', by: 'sara', at: ago(2), ...extra });
  const sessions = [{ peer: sara, name: 'sara', box: 'devbox', online: true, heardAt: ago(0), sessions: [card({ plan: 't-1' }), card({ id: '1123456789abcdef', title: 'Asks about tax', column: 'needs', by: 'li' }), card({ id: '2123456789abcdef', title: 'Shipped', column: 'done', at: ago(50) })] },
    { peer: 'c'.repeat(64), name: 'li', box: null, online: false, heardAt: ago(90), sessions: [card({ id: '3123456789abcdef', title: 'Li alone', by: 'li', at: ago(5) })] }];
  const tasks = [{ peer: sara, name: 'sara', box: 'devbox', online: true, heardAt: ago(0), tasks: [{ repoId: 'e'.repeat(64), handle: 'shop', id: 't-1', revision: 1, title: 'The cart Task', description: '', goal: 'Right totals.', objectives: ['One'], priority: 'high', severity: 'medium', state: 'approved', startedBy: 'owner', who: 'Opus 5.5', subtasks: [], met: [], approvedAt: ago(30), doneAt: null, updatedAt: ago(2) },
    { repoId: 'e'.repeat(64), handle: 'shop', id: 't-9', revision: 1, title: 'A Task with no session told', description: '', goal: 'x', objectives: ['One'], priority: 'low', severity: 'low', state: 'approved', startedBy: 'owner', who: 'model', subtasks: [], met: [], approvedAt: ago(30), doneAt: null, updatedAt: ago(1) }] }];
  const columns = boardColumns(readBoard(repo), { tasks: [], queue: [] }, now, tasks, sessions);
  assert.deepEqual(names(columns), { todo: [], progress: ['A Task with no session told', 'Li alone', 'Fix the cart'], needs: ['Asks about tax'], done: ['Shipped'] });
  const items = columns.flatMap(column => column.items), cart = items.find(item => item.title === 'Fix the cart');
  assert.deepEqual([cart.detail, cart.shared.id, cart.session.id, cart.key], ['@sara · devbox', 't-1', '0123456789abcdef', `peer-${sara}/session/0123456789abcdef`]);
  assert.equal(cart.note, "@sara's session on devbox · In progress · Task: The cart Task · read-only");
  assert.equal(items.find(item => item.title === 'Asks about tax').detail, '@li · devbox');
  assert.equal(items.find(item => item.title === 'Li alone').detail, '@li · offline');
  assert.equal(Boolean(cart.card || cart.task || cart.request), false);
  // The name stays beside the title when the column is narrow.
  assert.deepEqual(fitTeammateCard('Fix the cart total for every coupon there is', cart.detail, 30), { title: 'Fix the cart total for…', detail: '@sara' });
});

test('a project above several repositories has a board for each, led by the open session\'s; a session in no repository is on each', t => {
  const p = project(t), parent = fs.mkdtempSync(path.join(p.parent, 'work-'));
  const clone = (name, origin) => { const root = path.join(parent, name); fs.mkdirSync(root); git(root, ['init', '-q']); if (origin) git(root, ['remote', 'add', 'origin', origin]); return root; };
  const web = clone('web', 'git@github.com:acme/web.git'), api = clone('api', 'https://user:secret@github.com/acme/api.git'), loose = clone('loose', null);
  assert.equal(repoName('github.com/acme/web'), 'acme/web');
  assert.deepEqual(folderRemote(api).name, 'acme/api'); assert.equal(folderRemote(loose), null); assert.equal(folderRemote(parent), null);
  const repo = { root: parent, common: null, state: path.join(p.parent, 'state') }, now = Date.now(), ago = minutes => new Date(now - minutes * 60000).toISOString();
  const snapshot = { tasks: [task('1', 'Web work', 'running', { repository: web, createdAt: ago(10) }), task('2', 'Api work', 'needs_input', { repository: api, createdAt: ago(1) }), task('3', 'A question', 'answered', { kind: 'conversation' }), task('4', 'Loose work', 'ready', { repository: loose })], queue: [] };
  const found = projectBoards(repo, snapshot, { now });
  assert.deepEqual(found.boards.map(row => row.name), ['acme/api', 'acme/web']);
  assert.deepEqual(projectBoards(repo, snapshot, { first: folderRemote(web).repoId, now }).boards.map(row => row.name), ['acme/web', 'acme/api']);
  // A repository only a teammate's sessions are on has a board too.
  assert.deepEqual(projectBoards(repo, snapshot, { others: [{ repoId: 'f'.repeat(64), name: 'acme/docs', at: ago(0) }], now }).boards.map(row => row.name), ['acme/docs', 'acme/api', 'acme/web']);
  const kanban = { cards: [{ id: 'card-1', text: 'Todo', column: 'todo' }, { id: 'card-2', text: 'Started web', column: 'started', taskId: '1' }], done: [], closed: {}, archived: [] };
  const slice = boardSlice(kanban, snapshot, folderRemote(web).repoId, found);
  assert.deepEqual(slice.snapshot.tasks.map(row => row.id), ['1', '3', '4']); assert.deepEqual(slice.kanban.cards.map(row => row.id), ['card-1', 'card-2']);
  assert.deepEqual(boardSlice(kanban, snapshot, folderRemote(api).repoId, found).kanban.cards.map(row => row.id), ['card-1']);
  // With no repository at all, one board holds everything.
  const none = projectBoards(repo, { tasks: [snapshot.tasks[2]] }, { now });
  assert.deepEqual(none.boards, [{ id: null, name: 'No repository' }]); assert.equal(boardSlice(kanban, snapshot, null, none).snapshot, snapshot);
});
