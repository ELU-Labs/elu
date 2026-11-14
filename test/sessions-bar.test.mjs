import test from 'node:test';
import assert from 'node:assert/strict';
import { boardRows, boardSections, barCells, barColumns, rowTitle, rowCard, rowActions, rowBadge } from '../lib/board.mjs';
import { supersededRequests } from '../lib/workspace.mjs';

// The Sessions bar: one line per row, as wide as the bar, beside the open session.
const now = Date.parse('2026-11-08T20:00:00Z'), at = minutes => new Date(now - minutes * 60000).toISOString();
const base = { runs: [{ role: 'lead', at: at(30) }], messages: [], createdAt: at(40) };
const shop = { name: 'shop', root: '/p/shop', activity: [{ at: at(1), taskId: '2', step: 'Read src/cart.mjs', text: 'model: Read src/cart.mjs' }], tasks: [
  { ...base, id: '1', state: 'answered', kind: 'conversation', goal: 'Trim coupon codes before they are compared', result: { summary: 'Done.' } },
  { ...base, id: '2', state: 'running', activeRole: 'lead', activeSince: at(4), goal: 'Why does the checkout total round down on mixed carts' },
  { ...base, id: '3', state: 'needs_input', goal: 'Add a loyalty badge to the order page', result: { question: 'Which page?' } },
  { ...base, id: '4', state: 'ready', goal: 'Rename the cart module', runs: [{ role: 'lead', at: at(200) }], createdAt: at(210) },
  { ...base, id: '5', state: 'running', activeRole: 'lead', activeSince: at(9), goal: 'Bump the test runner' },
], queue: [
  { id: 'request-a', goal: 'Write the release notes for the coupon change', state: 'queued', priority: 1, queuedAt: at(2), createdAt: at(2) },
  { id: 'request-b', goal: 'Add a retry budget to the payment client', state: 'blocked', reason: 'Project checks are still needed.', createdAt: at(3) },
] };
const billing = { name: 'billing service', root: '/p/billing', activity: [], tasks: [{ ...base, id: '1', state: 'ready', goal: 'Send the invoice email again when a card is retried' }], queue: [] };
const schedule = { id: 'schedule-1', root: '/p/shop', project: 'shop', goal: 'Check the nightly build and list what failed', enabled: true, nextRunAt: new Date(now + 18 * 3600000).toISOString(), createdAt: at(60), when: { kind: 'daily', label: 'daily 9:00' } };
// Session 5 waits for an approval. The other approval is for a session that is not listed, so it has a row of its own.
const approval = { id: 'run-5-a', root: '/p/shop', taskId: '5', role: 'lead', summary: 'Run: npm install', at: at(1) };
const stray = { id: 'run-9-a', root: '/p/shop', taskId: '9', role: 'lead', summary: 'Edit: src/auth.mjs', at: at(2) };
const items = [{ id: 'task-a', kind: 'incoming', request: 'ask', peer: 'b'.repeat(64), name: 'sara', text: 'How do we rotate the signing keys on the build machines?', at: at(5), root: '/p/shop', project: 'shop' }];
const extra = { items, schedules: [schedule], approvals: [approval, stray] };
const one = boardRows([shop], now, extra), two = boardRows([shop, billing], now, extra);
const line = (row, width, columns) => barCells(row, width, now, columns).map(cell => cell.text).join('');
const find = (rows, kind, id) => rows.find(row => row.kind === kind && (id === undefined || row.id === id || row.request?.id === id));

test('a bar row is exactly as wide as the bar at every width from 24 to 60', () => {
  for (const rows of [one, two]) for (let width = 24; width <= 60; width++) {
    const columns = barColumns(rows, width);
    for (const row of rows) { const text = line(row, width, columns); assert.equal(text.length, width, `${width}: ${text}`); assert.doesNotMatch(text, /\n/); }
  }
});

test('a title too long for the bar is cut at a word, never inside one', () => {
  let cut = 0;
  for (const rows of [one, two]) for (let width = 24; width <= 60; width++) for (const row of rows) {
    const full = rowTitle(row, now), shown = barCells(row, width, now, barColumns(rows, width))[1].text.trimEnd();
    // A session that waits on an approval is cut twice, its name and then the whole: see below.
    if (shown === full || row.kind === 'task' && row.approval) continue;
    cut++;
    assert.ok(shown.endsWith('…'), `${width}: ${shown}`);
    assert.ok(full.startsWith(`${shown.slice(0, -1)} `), `${width}: "${shown}" cuts a word of "${full}"`);
    assert.doesNotMatch(shown, /·…$/, `${width}: ${shown}`);
  }
  assert.ok(cut > 100, 'most rows are cut at these widths');
  // 30 columns: the icon takes 2 and the age 5, so 23 are left and "total" does not fit.
  assert.equal(barCells(find(one, 'task', '2'), 30, now)[1].text, 'Why does the checkout…'.padEnd(23));
  // 43 columns leave 36: "round" fits and "down" does not.
  assert.equal(barCells(find(one, 'task', '2'), 43, now)[1].text, 'Why does the checkout total round…'.padEnd(36));
  // 41 columns leave 34, and "round" ends at the edge with the mark after it: it stays.
  assert.equal(barCells(find(one, 'task', '2'), 41, now)[1].text, 'Why does the checkout total round…');
  // A cut never ends on the dot between a row's two parts.
  assert.equal(barCells(find(one, 'peer'), 24, now)[1].text, '@sara question…'.padEnd(19));
  assert.equal(barCells(find(one, 'schedule'), 30, now)[1].text, 'daily 9:00 · Check…'.padEnd(21));
});

test('a session reads as its title, never its number, and any other row as what it is', () => {
  assert.equal(rowTitle(find(one, 'task', '2'), now), 'Why does the checkout total round down on mixed carts');
  assert.equal(rowTitle(find(one, 'task', '3'), now), 'Add a loyalty badge to the order page');
  assert.equal(rowTitle({ ...find(one, 'task', '3'), task: { ...find(one, 'task', '3').task, title: ' Loyalty badge ' } }, now), 'Loyalty badge', 'the name the owner gave it comes first');
  assert.equal(rowTitle(find(one, 'request', 'request-a'), now), 'Write the release notes for the coupon change');
  // A blocked request says why beside the list, in its chat. The bar keeps the room for the message.
  assert.equal(rowTitle(find(one, 'request', 'request-b'), now), 'Add a retry budget to the payment client');
  // A session that waits for an approval keeps its name, then what its model wants to do. An approval with a row of its own reads as what is wanted.
  assert.equal(rowTitle(find(one, 'task', '5'), now), 'Bump the test runner · run: npm install');
  assert.equal(rowTitle({ ...find(one, 'task', '5'), agent: '@qa' }, now), 'Bump the test runner · @qa wants to run: npm install');
  // In a row the name comes first at every width, and the start of the approval shows as soon as both fit.
  const waits = find(one, 'task', '5'), shown = (row, width) => barCells(row, width, now)[1].text.trimEnd();
  for (let width = 24; width <= 60; width++) assert.match(shown(waits, width), /^Bump the/, String(width));
  assert.equal(shown(waits, 60), 'Bump the test runner · run: npm install'); assert.match(shown(waits, 44), /^Bump the test runner · run: npm/);
  // A long name is cut at a word to leave the approval its start. One that would be left with a single word keeps the row.
  const renamed = goal => ({ ...waits, task: { ...waits.task, goal } });
  assert.match(shown(renamed('Work on our receipt email, we have two cases for it that need to be corrected'), 44), /^Work on our receipt( email,)?… · run: npm/);
  assert.match(shown(renamed('Internationalization groundwork'), 30), /^Internationalization…$/);
  assert.equal(rowTitle(find(one, 'approval'), now), 'wants to edit: src/auth.mjs');
  assert.equal(rowTitle({ ...find(one, 'approval'), agent: '@qa' }, now), '@qa wants to edit: src/auth.mjs', 'a bot is named, the session\'s model is not');
  assert.equal(rowTitle(find(one, 'peer'), now), '@sara question · How do we rotate the signing keys on the build machines?');
  assert.equal(rowTitle(find(one, 'schedule'), now), 'daily 9:00 · Check the nightly build and list what failed');
  const later = boardRows([{ ...shop, tasks: [], queue: [{ id: 'request-c', goal: 'Try again', state: 'queued', notBefore: new Date(now + 30000).toISOString(), queuedAt: at(1) }, { id: 'request-d', goal: 'Continue it', state: 'queued', continuationTaskId: '7', queuedAt: at(0) }] }], now);
  assert.deepEqual(later.map(row => rowTitle(row, now)), ['retry 30s · Try again', 'Continue it']);
  // What the conductor said a queued one waits for (lib/waiting.mjs): a free slot is said once, in the Queued heading, with a
  // shorter form for a narrow list; its session's turn is said on its row, where the row has room for both.
  const held = boardRows([{ ...shop, tasks: [], queue: [{ id: 'request-f', goal: 'Rename the order model', state: 'queued', queuedAt: at(1), waits: { on: 'slot', running: 4, limit: 4 } }, { id: 'request-g', goal: 'Go on', state: 'queued', continuationTaskId: '7', queuedAt: at(0), waits: { on: 'turn' } }] }], now);
  const of = id => held.find(row => row.request.id === id);
  assert.deepEqual([rowTitle(of('request-f'), now), rowTitle(of('request-g'), now), rowTitle(of('request-g'), now, 23), rowTitle(of('request-g'), now, 22)], ['Rename the order model', 'after this turn · Go on', 'after this turn · Go on', 'Go on']);
  assert.equal(line({ ...of('request-g'), request: { ...of('request-g').request, goal: 'Is the yearly plan covered?' } }, 38), '· after this turn · Is the yearly… now');
  // One the running turn has on its input does not wait for the turn to end: its row is the message alone.
  assert.equal(rowTitle({ ...of('request-g'), request: { ...of('request-g').request, turn: { run: 'run-7', uuid: 'a' } } }, now), 'Go on');
  assert.deepEqual(boardSections(held).find(line => line.header === 'Queued').said, ['4 of 4 running', '4 of 4']);
  assert.equal(boardSections(later).find(line => line.header === 'Queued').said, undefined);
  // /slots lowered below what runs: nothing is interrupted, so the heading says both numbers.
  assert.deepEqual(boardSections(boardRows([{ ...shop, tasks: [], queue: [{ id: 'request-h', goal: 'Later', state: 'queued', queuedAt: at(1), waits: { on: 'slot', running: 6, limit: 2 } }] }], now)).find(line => line.header === 'Queued').said, ['6 running, 2 at once', '2 at once']);
  // The icon in front says the state, in the colour the row had before.
  assert.deepEqual(['3', '2', '4', '1', '5'].map(id => { const [icon] = barCells(find(one, 'task', id), 30, now); return [icon.text.trim().replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, 'spin'), icon.tone]; }), [['?', 'orange'], ['spin', 'blue'], ['✓', 'green'], ['✓', 'green'], ['?', 'orange']], 'a session that waits for an approval has no spinner');
  assert.deepEqual([barCells(find(one, 'request', 'request-b'), 30, now)[0], barCells(find(one, 'schedule'), 30, now)[0]].map(cell => [cell.text, cell.tone]), [['✗ ', 'red'], ['◷ ', 'blue']]);
});

test('the age sits at the right edge, in its short form', () => {
  const ends = (kind, id) => line(find(one, kind, id), 30).split(' ').at(-1);
  assert.deepEqual([ends('task', '2'), ends('task', '3'), ends('task', '4'), ends('request', 'request-a'), ends('approval'), ends('peer')], ['4m00', '30m', '3h', '2m', '2m', '5m']);
  // Session 5 has run for nine minutes. Its age is how long its approval has waited.
  assert.equal(ends('task', '5'), '1m');
  assert.match(line(find(one, 'schedule'), 30), / in 18h$/);
  const fresh = boardRows([{ ...shop, tasks: [], queue: [{ id: 'request-e', goal: 'Just sent', state: 'queued', queuedAt: at(0) }] }], now)[0];
  assert.match(line(fresh, 30), /^· Just sent +now$/);
  // A session at rest with a bot on a schedule shows when that bot runs next, in blue, in place of its age.
  const soon = [{ on: true, nextRunAt: new Date(now + 25 * 60000).toISOString() }], later = [{ on: true, nextRunAt: new Date(now + 3 * 3600000).toISOString() }];
  const timed = boardRows([shop], now, { ...extra, timed: { '/p/shop': { 1: [...later, ...soon], 2: soon, 4: [{ ...soon[0], on: false }] } } });
  const last = id => { const cell = barCells(find(timed, 'task', id), 30, now).at(-1); return [cell.text, cell.tone]; };
  assert.deepEqual([last('1'), last('4'), last('2')], [[' in 25m', 'blue'], [' 3h', 'muted'], [' 4m00', 'muted']], 'the soonest run; a schedule that is off and a session at work keep the age');
});

test('the project is named only when the rows come from more than one', () => {
  assert.deepEqual(barColumns(one, 40), { project: 0, clock: 0 });
  assert.ok(one.every(row => barCells(row, 40, now, barColumns(one, 40)).length === 3), 'icon, title, age');
  // 40 columns: a name gets up to 11, cut at a word, so "billing service" shows as "billing…".
  const columns = barColumns(two, 40); assert.deepEqual(columns, { project: 8, clock: 6 });
  const named = row => barCells(row, 40, now, columns)[2];
  assert.deepEqual([named(find(two, 'task', '2')).text, named(find(two, 'task', '2')).tone], [' shop    ', 'muted']);
  assert.equal(named(two.find(row => row.root === '/p/billing')).text, ' billing…');
  // The names start in one column, because the ages share a width.
  assert.equal(new Set(two.map(row => line(row, 40, columns).length - barCells(row, 40, now, columns).slice(2).map(cell => cell.text).join('').length)).size, 1);
  // A bar too narrow for a title and a project keeps the title.
  const narrow = barColumns(two, 24);
  for (const row of two) { const cells = barCells(row, 24, now, narrow); assert.equal(cells.length, 3, line(row, 24, narrow)); assert.equal(cells[1].text.length, 24 - 2 - cells[2].text.length, line(row, 24, narrow)); }
  assert.equal(line(find(two, 'task', '3'), 24, narrow), '? Add a loyalty…     30m');
  // One project with a teammate's row from no project is still one project.
  assert.equal(barColumns(boardRows([shop], now, { items: [{ ...items[0], root: undefined, project: undefined }] }), 40).project, 0);
});

test('every kind of row is listed once, under a heading that counts its group', () => {
  const lines = boardSections(one);
  assert.deepEqual(lines.filter(row => row.header).map(row => [row.header, row.count]), [['Needs you', 5], ['Running', 1], ['Queued', 1], ['Recent', 2], ['Scheduled', 1]]);
  assert.deepEqual(lines.filter(row => row.row).map(row => row.row.key), one.map(row => row.key));
  assert.deepEqual([...new Set(one.map(row => row.kind))].sort(), ['approval', 'peer', 'request', 'schedule', 'task']);
  assert.deepEqual(boardSections(two).filter(row => row.header).map(row => row.count), [5, 1, 1, 3, 1]);
});

test('a session that waits for your approval is listed once, under Needs you, and keeps its row when it goes back to work', () => {
  const waiting = one.filter(row => row.kind === 'task' && row.id === '5');
  assert.equal(waiting.length, 1); assert.equal(waiting[0].group, 0); assert.equal(waiting[0].approval.id, 'run-5-a');
  assert.equal(one.filter(row => row.approval?.id === 'run-5-a').length, 1, 'its approval has no row of its own');
  // Back at work it is the same row, so the list keeps its place under the cursor.
  const working = find(boardRows([shop], now, { ...extra, approvals: [stray] }), 'task', '5');
  assert.equal(working.group, 1); assert.equal(working.approval, undefined); assert.equal(working.key, waiting[0].key); assert.equal(rowTitle(working, now), 'Bump the test runner');
  // An approval for a session that is not listed has a row of its own. Approvals lead Needs you, the one that has waited longest first.
  assert.deepEqual(one.filter(row => row.kind === 'approval').map(row => [row.id, row.group, row.key]), [['9', 0, '/p/shop\0approval\0run-9-a']]);
  assert.deepEqual(one.slice(0, 3).map(row => row.approval?.id), ['run-9-a', 'run-5-a', undefined]);
  // A session at work shows its newest step in the list.
  assert.equal(find(one, 'task', '2').now, 'Read src/cart.mjs'); assert.equal(working.now, 'Bump the test runner');
});

test('a row that is not a session shows its own text and keys beside the list', () => {
  assert.deepEqual(rowCard(find(one, 'schedule'), now), { title: '◷ daily 9:00 · shop', tone: 'blue', text: 'Check the nightly build and list what failed\nNext run in 18h.', keys: 'r run now · p pause · x delete · enter last run' });
  assert.deepEqual(rowCard(find(one, 'approval'), now), { title: '? wants to · shop', tone: 'orange', text: 'The model wants to edit: src/auth.mjs', keys: 'y allow · n deny · enter open' });
  const ask = rowCard(find(one, 'peer'), now);
  assert.deepEqual([ask.title, ask.tone, ask.keys], ['? @sara question · shop', 'orange', 'y accept · n decline · enter read · c decline']);
  assert.match(ask.text, /How do we rotate the signing keys on the build machines\?/);
  const paused = boardRows([shop], now, { schedules: [{ ...schedule, enabled: false }] }).find(row => row.kind === 'schedule');
  assert.match(rowCard(paused, now).text, /\nPaused\.$/); assert.match(rowCard(paused, now).keys, /p resume/);
});

// The owner's list on 2026-11-12: session 3 runs his newest message; two older "I approve" were
// refused before he updated, and a teammate's question waits.
const REFUSED = "A teammate's message never runs in your home folder. Open ELU in the project folder, then approve again.";
const ownerTask = { id: '3', state: 'running', activeRole: 'lead', activeSince: at(1), goal: 'ELU Issues', title: 'ELU Issues', createdAt: at(700), runs: [{ role: 'lead', at: at(1) }], messages: [{ at: at(700), text: 'ELU Issues' }, { at: at(1), text: 'you have my approval' }] };
const ownerQueue = [
  { id: 'request-1', goal: 'I approve', state: 'blocked', reason: REFUSED, continuationTaskId: '3', taskId: null, createdAt: at(649) },
  { id: 'request-2', goal: 'I approve', state: 'blocked', reason: REFUSED, continuationTaskId: '3', taskId: null, createdAt: at(646) },
  { id: 'request-3', goal: 'you have my approval', state: 'running', continuationTaskId: '3', taskId: '3', createdAt: at(1) },
];
const ownerAsk = { id: 'peer-ask', kind: 'incoming', request: 'ask', peer: 'c'.repeat(64), name: 'ali', text: 'testing if u get my messages', at: at(648), root: '/p/home', project: 'home' };

test('a blocked message is spent once its session moves on: a newer message to it, or a message the session took after it', () => {
  assert.deepEqual(supersededRequests(ownerQueue, [ownerTask]), ['request-1', 'request-2'], "the owner's two old messages");
  // The newer message finished and left the queue: the session's own record still shows it moved on.
  assert.deepEqual(supersededRequests(ownerQueue.slice(0, 2), [ownerTask]), ['request-1', 'request-2']);
  assert.deepEqual(supersededRequests(ownerQueue, []), ['request-1', 'request-2'], 'a newer message to it is enough');
  // One blocked after the session's last message still waits for him, as does a new session's or a teammate's.
  const idle = { ...ownerTask, state: 'answered', messages: [{ at: at(700), text: 'ELU Issues' }] };
  assert.deepEqual(supersededRequests(ownerQueue.slice(0, 2), [idle]), []);
  assert.deepEqual(supersededRequests([{ ...ownerQueue[0], blockedAt: at(0) }], [ownerTask]), [], 'it stopped after that message');
  assert.deepEqual(supersededRequests([{ ...ownerQueue[0], continuationTaskId: null }, { ...ownerQueue[1], origin: { kind: 'handoff', name: 'ali' } }, ownerQueue[2]], [ownerTask]), []);
  // A bot's reply in the session is not a new message to it.
  assert.deepEqual(supersededRequests(ownerQueue.slice(0, 2), [{ ...idle, messages: [...idle.messages, { at: at(0), text: 'Looks fine.', bot: 'critic' }] }]), []);
});

test("the owner's list: one session is one row, and the teammate's question is the only thing that needs him", () => {
  const home = { name: 'home', root: '/p/home', activity: [], tasks: [ownerTask], queue: ownerQueue };
  // Even with the spent messages still in the queue, the session is listed once, as running.
  const rows = boardRows([home], now, { items: [ownerAsk] });
  assert.deepEqual(rows.map(row => [row.kind, row.group, row.kind === 'task' ? row.id : row.item.id]), [['peer', 0, 'peer-ask'], ['task', 1, '3']]);
  assert.deepEqual(boardSections(rows).filter(line => line.header).map(line => [line.header, line.count]), [['Needs you', 1], ['Running', 1]]);
  assert.deepEqual(rowActions(rows[0]), [['y', 'accept'], ['n', 'decline'], ['enter', 'read'], ['c', 'decline']]);
  // A reply or an ask of his that waits to go: c discards it, as n does.
  const reply = boardRows([home], now, { items: [{ ...ownerAsk, id: 'peer-reply', kind: 'held', request: undefined }] }).find(row => row.kind === 'peer');
  assert.deepEqual(rowActions(reply), [['y', 'send'], ['n', 'discard'], ['enter', 'read'], ['c', 'discard']]);
});

test("only the owner's own later turns spend his blocked message: a bot's scheduled turn or a teammate's message in the session does not", () => {
  const idle = { ...ownerTask, state: 'answered', messages: [{ at: at(700), text: 'ELU Issues' }] }, held = ownerQueue.slice(0, 2);
  const later = { continuationTaskId: '3', taskId: '3', createdAt: at(1) };
  // A bot's scheduled turn, done or failed, and a teammate's follow-up in the same thread.
  assert.deepEqual(supersededRequests([...held, { ...later, id: 'request-4', goal: 'Check the build', state: 'done', bot: 'critic', scheduled: true }], [idle]), []);
  assert.deepEqual(supersededRequests([...held, { ...later, id: 'request-5', goal: 'And the docs?', state: 'done', origin: { kind: 'handoff', name: 'ali', peer: 'c'.repeat(64) } }], [idle]), []);
  assert.deepEqual(supersededRequests([...held, { ...later, id: 'request-6', goal: 'Nightly', state: 'queued', scheduleId: 'schedule-0a1b2c3d' }], [idle]), []);
  // What those turns leave in the session: the bot's scheduled message and the teammate's.
  const ran = [{ at: at(0), text: 'Check the build', to: '@critic', scheduled: true }, { at: at(0), text: 'And the docs?', from: '@ali', peer: 'c'.repeat(64), kind: 'handoff' }];
  assert.deepEqual(supersededRequests(held, [{ ...idle, messages: [...idle.messages, ...ran] }]), []);
  // His own message to a bot in the session does spend them, as one to the lead does.
  assert.deepEqual(supersededRequests(held, [{ ...idle, messages: [...idle.messages, { at: at(0), text: 'Look again', to: '@critic' }] }]), ['request-1', 'request-2']);
  assert.deepEqual(supersededRequests([...held, { ...later, id: 'request-7', goal: 'Look again', state: 'done', bot: 'critic' }], [idle]), ['request-1', 'request-2']);
  // While a bot's turn runs, his message waits on the session's row, which stands for the turn.
  const busy = { ...idle, state: 'running', activeRole: 'bot:critic', activeSince: at(0) };
  const rows = boardRows([{ name: 'home', root: '/p/home', activity: [], tasks: [busy], queue: held }], now);
  assert.deepEqual(rows.map(row => [row.kind, row.group, row.id]), [['task', 1, '3']]);
});

test('a blocked or saved message to a session shows on that session\'s row; one for a new session keeps its own row, and c takes either away', () => {
  const idle = { ...ownerTask, state: 'answered', result: { summary: 'Done.' }, messages: [{ at: at(700), text: 'ELU Issues' }] };
  const fresh = { id: 'request-9', goal: 'Add a retry budget', state: 'blocked', reason: 'Project checks are still needed.', createdAt: at(5) };
  const saved = { id: 'request-8', goal: 'Draft the notes', state: 'waiting', reason: 'Ready to review and start.', continuationTaskId: '4', createdAt: at(3) };
  const four = { ...idle, id: '4', goal: 'Release notes', title: 'Release notes' };
  const home = { name: 'home', root: '/p/home', activity: [], tasks: [idle, four], queue: [...ownerQueue.slice(0, 2), fresh, saved] };
  const rows = boardRows([home], now);
  assert.deepEqual(rows.map(row => [row.kind, row.group, row.kind === 'task' ? row.id : row.request.id]), [['task', 0, '3'], ['request', 0, 'request-9'], ['task', 0, '4']]);
  const three = rows[0];
  assert.equal(three.request.id, 'request-2', 'the newest message shows'); assert.deepEqual(three.requests.map(row => row.id), ['request-2', 'request-1']);
  assert.deepEqual(rowBadge(three, now), { icon: '✗', tone: 'red', title: 'blocked' }); assert.equal(rowTitle(three, now), 'ELU Issues');
  assert.equal(three.now, `I approve — ${REFUSED}`);
  assert.deepEqual(rowActions(three), [['enter', 'open'], ['r', 'retry'], ['s', 'remove'], ['e', 'rename'], ['c', 'archive']]);
  assert.deepEqual(rowBadge(rows[2], now), { icon: '!', tone: 'orange', title: 'saved' }); assert.equal(rows[2].request.id, 'request-8');
  assert.deepEqual(rowActions(rows[1]), [['enter', 'open'], ['r', 'retry'], ['c', 'remove']]);
  assert.deepEqual(rowActions(boardRows([{ ...home, tasks: [], queue: [{ ...fresh, state: 'queued' }] }], now)[0]), [['enter', 'open'], ['c', 'remove']]);
  // Without its messages the session is back where it was, under Recent.
  assert.equal(boardRows([{ ...home, queue: [] }], now).find(row => row.id === '3').group, 3);
  // An archived session does not show it: the message keeps a row of its own.
  assert.deepEqual(boardRows([{ ...home, closed: ['3'], queue: ownerQueue.slice(0, 1) }], now).map(row => [row.kind, row.kind === 'task' ? row.id : row.request.id]), [['request', 'request-1'], ['task', '4']]);
  // A teammate's message that waits for the owner keeps its own row under Needs you.
  const theirs = { id: 'request-7', goal: 'Work on the handoff', state: 'waiting', reason: 'handoff from @ali', continuationTaskId: '3', origin: { kind: 'handoff', name: 'ali', peer: 'c'.repeat(64) }, context: 'And the docs?', createdAt: at(2) };
  assert.deepEqual(boardRows([{ ...home, queue: [theirs] }], now).filter(row => row.kind === 'request').map(row => [row.request.id, row.group]), [['request-7', 0]]);
});
