import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { project } from './helpers.mjs';
import { liveTask } from './peer-helpers.mjs';
import { repository } from '../lib/git.mjs';
import { launchTerminal } from '../lib/terminal.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';
import { remoteRow } from '../lib/board.mjs';
import { taskPlace } from '../lib/terminal-plan.mjs';
import { proposeTask, approveTask, planFile } from '../lib/plan.mjs';
import { saveRequest } from '../lib/workspace.mjs';
import { saveTask, readTask, taskDir, lock } from '../lib/state.mjs';
import { processIdentity } from '../lib/process.mjs';

// The owner typed a message over a session on his other computer and the pane drew it above
// the session's Changes line and its Task card; over a working one, above the turn's working
// line and live steps. A chat reads in time order: what he sent last, which the session has
// not read yet, is the last thing in it, right above the message box, and nothing is under it.
// These are the rows of the pane, for a session on another computer and for one here.

const ME = 'a'.repeat(64), BOX = 'b'.repeat(64);
const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const TASK = { id: 't-1', session: '1', revision: 1, title: 'Fix the report totals', description: 'One file changes.', goal: 'The totals add up.', objectives: ['The totals add up'], priority: 'high', severity: 'low', startedBy: 'owner', by: 'lead', rejectedAt: null, doneAt: null, subtasks: [], met: [], criteria: [], estimateMinutes: null, etaMinutes: null, etaAt: null };
const proposed = at => ({ ...TASK, state: 'proposed', proposedAt: at, approvedAt: null });
const approved = at => ({ ...TASK, state: 'approved', proposedAt: at, approvedAt: at });
// What its computer sent of its changes: 2 files.
const PATCH = ['diff --git a/src/report.mjs b/src/report.mjs', 'index 1111111..2222222 100644', '--- a/src/report.mjs', '+++ b/src/report.mjs', '@@ -1,1 +1,2 @@', '-export const total = () => 0;', '+export const total = rows => rows.reduce((sum, row) => sum + row, 0);', '+export const count = rows => rows.length;', 'New file: docs/report.md\n# Report\n'].join('\n');
const STEPS = [{ kind: 'tool', text: 'Read: src/report.mjs', status: 'ok' }, { kind: 'tool', text: 'Run: npm test', status: 'running' }];

// The four scenes, as a session on another computer sends them. Each: the view, and what its
// pane reads top to bottom (every text is found after the one before it), ending with last.
const SCENES = {
  'a finished session with a Task and changes and one waiting message': {
    view: { state: 'ready', finished: true, plan: approved(ago(9)), diff: { summary: '2 files · +2 −1', patch: PATCH }, waiting: [{ at: ago(0), text: 'Also update the docs', state: 'queued' }],
      entries: [{ role: 'You', at: ago(10), text: 'Fix the report' }, { role: 'Claude', lead: true, at: ago(9.5), text: 'Here is the Task for it.' }, { role: 'Claude', lead: true, at: ago(5), text: 'Done. The totals add up.' }] },
    order: ['Fix the report', 'Here is the Task for it.', 'Task · approved', 'Done. The totals add up.', '(waiting)', 'Also update the docs'], last: 'Waiting to start.' },
  'a working session with steps and one waiting message': {
    view: { state: 'running', held: 1, plan: approved(ago(8.9)), waiting: [{ at: ago(0), text: 'Use CSV for it', state: 'turn' }], runs: [{ run: 'run-1', role: 'lead', startedAt: ago(1), at: null, steps: STEPS }],
      entries: [{ role: 'You', at: ago(10), text: 'Fix the report' }, { role: 'Claude', lead: true, at: ago(9), text: 'Here is the Task for it.' }, { role: 'You', at: ago(1), text: 'Go on with it' }] },
    order: ['Fix the report', 'Here is the Task for it.', 'Task · approved', 'Go on with it', 'Working on @my-box', 'Read: src/report.mjs', 'Run: npm test', '(waiting)', 'Use CSV for it', 'It reads this when its current turn ends.'], last: 'sends it now.' },
  'two waiting messages': {
    view: { state: 'answered', waiting: [{ at: ago(2), text: 'First of the two', state: 'queued', reason: 'Waiting for a free slot: 1 of 1 session is running. /slots changes it.' }, { at: ago(1), text: 'Second of the two', state: 'queued' }],
      entries: [{ role: 'You', at: ago(10), text: 'Fix the report' }, { role: 'Claude', lead: true, at: ago(9), text: 'It is fixed.' }] },
    order: ['Fix the report', 'It is fixed.', '(waiting)', 'First of the two', '/slots', '(waiting)', 'Second of the two'], last: 'Waiting to start.' },
  'a Task that waits for approval with nothing after it': {
    view: { state: 'answered', plan: proposed(ago(9)),
      entries: [{ role: 'You', at: ago(10), text: 'Fix the report' }, { role: 'Claude', lead: true, at: ago(9.5), text: 'Here is the Task for it.' }] },
    order: ['Fix the report', 'Here is the Task for it.', 'Task · waits for your approval', 'Fix the report totals'], last: 'or type what to change' },
};
const remoteView = view => ({ id: '66666666-6666-4666-8666-666666666666', machine: BOX, createdAt: ago(10), lastAt: ago(0), title: 'Fix the report', project: 'shop', approvals: [], steps: [], ...view });
// What the pane says as one line, however it wrapped its sentences: a message's bar off each row.
const flat = said => said.replace(/^\s*┃ ?/gm, '').replace(/\s+/g, ' ').trim();
// Each text after the one before it; what follows the last one found.
function inOrder(said, order) {
  const text = flat(said); let from = 0;
  for (const part of order) { const found = text.indexOf(part, from); assert.ok(found >= from, `"${part}" is not after what comes before it:\n${said}`); from = found + part.length; }
  return text.slice(from).trim();
}
const rowsOf = said => said.split('\n').map(row => row.trimEnd()).filter(row => row.trim());
// The pane ends with these words.
const endsWith = (said, last) => assert.ok(flat(said).endsWith(last), `the pane does not end with "${last}":\n${said}`);

test('taskPlace: the Task card comes after the reply that proposed it and before anything that came later', () => {
  const at = (seconds, ms = 0) => new Date(Date.UTC(2026, 10, 13, 9, 0, seconds, ms)).toISOString();
  const entries = [{ role: 'You', at: at(0) }, { role: 'Claude', lead: true, at: at(10) }, { role: 'You', at: at(20) }, { role: 'Claude', lead: true, at: at(30) }];
  // The model's reply is noted before its Task is: the card follows it.
  assert.equal(taskPlace(entries, { by: 'lead', proposedAt: at(10, 200) }), 2);
  assert.equal(taskPlace(entries, { by: 'lead', proposedAt: at(31) }), 4, 'one that waits with nothing after it is last');
  // The reply that proposed it was said before the entries held here: the card is above them.
  assert.equal(taskPlace(entries, { by: 'lead', proposedAt: new Date(Date.UTC(2026, 10, 12)).toISOString() }), 0);
  // A Task that does not say when it was proposed comes after them all, and so does one with none.
  assert.equal(taskPlace(entries, { by: 'lead' }), 4); assert.equal(taskPlace([], { by: 'lead', proposedAt: at(1) }), 0);
  // A bot's reply is noted a moment after its Task is: the card follows what it said then, not what it said later.
  const bot = [{ role: 'You → @fixer', at: at(0) }, { role: '@fixer', bot: 'fixer', at: at(10, 300) }, { role: '@fixer', bot: 'fixer', at: at(40) }];
  assert.equal(taskPlace(bot, { by: '@fixer', proposedAt: at(10, 200) }), 2);
  assert.equal(taskPlace(bot, { by: 'lead', proposedAt: at(10, 200) }), 1);
});

// The parts of the pane of a session on another computer, as the app's glue draws them.
function glue() {
  const status = { key: ME, name: 'ana', teams: [{ id: 'team-1', members: [{ key: ME, name: 'ana', online: true }, { key: BOX, name: 'ana', box: 'my-box', online: true }] }] };
  return remoteGlue({ facade: { mineRows: () => [], remoteSessions: () => [] }, peerRead: () => status, peerCommand: async () => ({}), chatMessage: ({ title, text }) => `${title}: ${text}`, ink: text => text, colour: false, restMs: 1e9 });
}
const partRow = (view, extra = {}) => ({ ...remoteRow(remoteView(view), 'my-box'), listed: true, watched: true, ref: 'p:1', online: true, ...extra });

for (const width of [96, 44]) test(`a session on another computer, ${width} columns of chat: what he sent last ends the pane, the Task sits where it was proposed, and its changes are not a line of the chat`, () => {
  const app = glue();
  for (const [name, scene] of Object.entries(SCENES)) {
    const parts = app.parts(partRow(scene.view), width), said = parts.map(part => part.text).join('\n\n');
    inOrder(said, scene.order); endsWith(said, scene.last);
    // What is about the session and not about a moment is above its first message.
    assert.equal(parts[0].key.split('\0')[0], 'runs', name); assert.equal(flat(parts[0].text), 'Runs on @my-box in shop. Type below to write to it there. Start with @here to ask your agent here.');
    // No line of the chat counts the changes: the tab's name does, as for a session here.
    assert.ok(!parts.some(part => part.key.startsWith('changes') || /Changes · /.test(part.text)), name);
    // Nothing is under what waits: the last parts are his waiting messages, in the order he sent them.
    const waiting = (scene.view.waiting ?? []).map(item => item.text);
    assert.deepEqual(parts.slice(parts.length - waiting.length).map(part => part.key.split('\0')[0]), waiting.map(() => 'waiting'), name);
    assert.deepEqual(parts.filter(part => part.key.startsWith('waiting')).map(part => part.text.split('\n')[0].replace(/^.*\): /, '')), waiting, name);
  }
});

test('a session on another computer: its question, why it stopped, an approval, its agent here and what catches up are all above what he sent last', () => {
  const app = glue(), entries = [{ role: 'You', at: ago(10), text: 'Fix the report' }, { role: 'Claude', lead: true, at: ago(9), text: 'I looked at it.' }];
  const keys = (view, helper = null, extra = {}) => app.parts(partRow(view, extra), 96, helper).map(part => part.key.split('\0')[0]);
  const waiting = [{ at: ago(1), text: 'CSV', state: 'queued' }];
  // A question: after the reply that asked it, above his answer that waits.
  assert.deepEqual(keys({ state: 'needs_input', question: 'Which format?', choices: ['CSV', 'JSON'], entries, waiting }), ['runs', 'entry', 'entry', 'question', 'waiting']);
  // A Task that waits, then a message typed after it: the Task stays where it was proposed.
  assert.deepEqual(keys({ state: 'answered', plan: proposed(ago(8.9)), entries, waiting }), ['runs', 'entry', 'entry', 'task', 'waiting']);
  // The chat went on after the Task: the Task is above what came later.
  assert.deepEqual(keys({ state: 'answered', plan: approved(ago(8.9)), entries: [...entries, { role: 'You', at: ago(5), text: 'Go on' }, { role: 'Claude', lead: true, at: ago(4), text: 'Done.' }], waiting }), ['runs', 'entry', 'entry', 'task', 'entry', 'entry', 'waiting']);
  // Why it stopped, and that this computer is catching up with it.
  assert.deepEqual(keys({ state: 'stopped', error: 'Claude Code is not signed in on that computer.', behind: true, entries, waiting }), ['runs', 'behind', 'entry', 'entry', 'error', 'waiting']);
  // An approval there: above the message, which says where the approval is.
  const asks = app.parts(partRow({ state: 'running', approvals: [{ id: 'a-1', role: 'lead', summary: 'Run: npm test', at: ago(2) }], entries, waiting: [{ at: ago(1), text: 'yes', state: 'turn' }] }), 96);
  assert.deepEqual(asks.map(part => part.key.split('\0')[0]), ['runs', 'entry', 'entry', 'approval', 'waiting']);
  assert.match(asks.at(-1).text, /It reads this when its current turn ends\. The approval above still needs your answer\.$/);
  // A computer whose ELU lists no waiting messages says that one waits under the steps, as before.
  assert.deepEqual(keys({ state: 'running', held: 1, runs: [{ run: 'run-1', role: 'lead', startedAt: ago(1), at: null, steps: STEPS }], entries }), ['runs', 'entry', 'entry', 'working', 'live', 'held']);
  // Earlier messages still there: the line that counts them stays right above the oldest one held.
  assert.deepEqual(keys({ state: 'answered', entries: entries.map((entry, index) => ({ ...entry, n: index + 7 })), waiting }), ['runs', 'earlier', 'entry', 'entry', 'waiting']);
  // His agent here: what it said is in time order; a message to it that it has not read yet is
  // last with the others, in the order sent, under the line that says it works.
  const helper = { model: 'Opus 5.5', title: 'Help', working: true, stopped: null, sends: [], approvals: [], entries: [{ role: 'You', at: ago(8), text: 'Help it' }, { role: 'Opus 5.5', lead: true, at: ago(7), text: 'I will.' }, { role: 'You', at: ago(0.5), text: 'And the tests', waiting: true }] };
  const both = app.parts(partRow({ state: 'running', runs: [{ run: 'run-1', role: 'lead', startedAt: ago(1), at: null, steps: STEPS }], entries: [...entries, { role: 'Claude', lead: true, at: ago(0.2), text: 'One more thing.' }], waiting: [{ at: ago(1), text: 'CSV', state: 'turn' }] }), 96, helper);
  assert.deepEqual(both.map(part => part.key.split('\0')[0]), ['runs', 'entry', 'entry', 'here', 'here', 'entry', 'here-working', 'working', 'live', 'waiting', 'here']);
  assert.match(both.at(-1).text, /^You \(waiting\): And the tests$/);
  // One not followed here yet: the message to his agent here is still last.
  const listed = app.parts(partRow({ state: 'answered', entries: [] }, { watched: false }), 96, { ...helper, entries: [helper.entries[2], helper.entries[0], helper.entries[1]] });
  assert.deepEqual(listed.map(part => part.key.split('\0')[0]), ['listed', 'opening', 'here', 'here', 'here']); assert.match(listed.at(-1).text, /^You \(waiting\): And the tests$/);
});

// The app itself, at two sizes.
function fakePeer({ remote = [] } = {}) {
  const calls = [], record = (name, value) => (...args) => { calls.push([name, ...args]); return typeof value === 'function' ? value(...args) : value; };
  const facade = {
    calls, running: true, channels: [], onTeam: () => true,
    peerStatus: record('peerStatus', () => ({ running: true, stale: false, pid: 1, key: ME, name: 'ana', fingerprint: 'aaaaaaaa', error: null, counters: { direct: 1, relayed: 0, failed: 0 },
      teams: [{ id: 'team-1', name: 'Core', role: 'admin', members: [{ key: ME, fingerprint: 'aaaaaaaa', name: 'ana', role: 'admin', online: true, path: null, lastSeen: ago(0) }, { key: BOX, fingerprint: 'bbbbbbbb', name: 'ana', role: 'member', online: true, path: 'direct', lastSeen: ago(0), box: 'my-box', bots: [] }], channels: [] }] })),
    peerItems: record('peerItems', () => []), teamAgents: record('teamAgents', () => []), tickerEvents: record('tickerEvents', () => []),
    sendPeerCommand: record('sendPeerCommand', command => { facade.last = command; return { id: `command-${calls.length}` }; }), awaitCommand: record('awaitCommand', async () => ({})),
    startPeer: record('startPeer', true), restartStale: record('restartStale', false),
    mineRows: () => [{ key: BOX, mine: true, theirs: true }], remoteSessions: () => remote, remoteMachines: () => [], projectRepoId: () => null,
    access: { 'team-1': { handling: 'auto', rules: '', root: null, at: null } }, teamAccess: id => facade.access[id] ?? null,
  };
  return facade;
}
async function until(check, message = 'condition', timeout = 10000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
// One after hook for each test: views close first, then the environment goes back and the folders are removed.
function owned(t) {
  const value = { views: [], files: [] };
  t.after(async () => { let failure = null; for (const close of [...value.views.reverse(), ...value.files.reverse()]) { try { await close(); } catch (error) { failure ??= error; } } if (failure) throw failure; });
  return value;
}
function start(t) {
  const mine = owned(t), p = project({ after: close => mine.files.push(close) });
  const values = { XDG_CONFIG_HOME: path.join(p.parent, 'personal'), NO_COLOR: '1', TERM: 'xterm-256color' }, previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  mine.files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return { ...p, repo: repository(p.root), mine };
}
async function view(p, { columns, rows, ...options }) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = columns; output.rows = rows;
  let rendered;
  const finished = launchTerminal({ ...options, input, output, refreshMs: 30, startConductor: () => false, onRender: value => { rendered = value; } });
  finished.catch(() => {});
  await until(() => rendered, 'first render');
  p.mine.views.push(async () => {
    let closed = false; finished.then(() => { closed = true; }, () => { closed = true; });
    for (const started = Date.now(); !closed && !rendered.screen.destroyed;) {
      const waited = Date.now() - started;
      if (waited > 10000) { input.destroy(); output.destroy(); throw new Error('The view did not close after its test.'); }
      rendered.panels.ask.cancel();
      if (waited > 3000) process.emit('SIGHUP'); else { rendered.panels.tabs[0].focus(); rendered.screen.emit('keypress', 'q', { name: 'q' }); }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    input.destroy(); output.destroy();
  });
  return { input, output, get current() { return rendered; }, get panels() { return rendered.panels; }, lines() { return rendered.screen.lines.map(row => row.map(cell => cell[1]).join('')); } };
}
// The cursor on the row that matches: its session shows beside the list.
async function onRow(v, pattern) {
  const { board } = v.panels;
  await until(() => board.items.some(item => pattern.test(item.getText())), `the row ${pattern}`);
  board.focus(); board.select(board.items.findIndex(item => pattern.test(item.getText())));
}
// The rows of the pane as the screen shows them, inside its border, and the row the message box starts on.
function onScreen(v) {
  const { chat, ask } = v.panels, lines = v.lines();
  const rows = lines.slice(chat.atop + 1, chat.atop + chat.height - 1).map(row => row.slice(chat.aleft + 1, chat.aleft + chat.width - 1).replace(/┃\s*$/, '').trimEnd());
  return { rows, shown: rows.filter(row => row.trim()), under: chat.atop + chat.height, box: ask.atop };
}

for (const [columns, rows] of [[140, 50], [80, 24]]) for (const [name, scene] of Object.entries(SCENES)) test(`the app at ${columns}x${rows}, a session on another computer: ${name}`, { timeout: 60000 }, async t => {
  const p = start(t), v = await view(p, { columns, rows, repo: p.repo, dashboard: true, peer: fakePeer({ remote: [remoteView(scene.view)] }) });
  await onRow(v, /Fix the report/);
  const { chat, sessionTabs } = v.panels;
  await until(() => flat(chat.getText()).includes(scene.order.at(-1)), 'its chat beside the list');
  const said = chat.getText();
  inOrder(said, scene.order); endsWith(said, scene.last);
  assert.match(flat(said), /^Runs on @my-box in shop\. Type below to write to it there\. Start with @here to ask your agent here\./);
  assert.doesNotMatch(flat(said), /Changes · |d opens them/);
  // Its changes are the tab's name, as for a session here.
  assert.equal(sessionTabs.hidden, false); assert.equal(sessionTabs.getText().trim(), scene.view.diff ? 'Chat   Changes 2' : 'Chat   Changes');
  // On the screen: the pane ends with it, and the message box starts right under the pane.
  const screen = onScreen(v); assert.ok(screen.box >= screen.under && screen.box - screen.under <= 1, 'the message box is under the pane, after the status row at most');
  assert.ok(flat(screen.shown.join('\n')).endsWith(scene.last), `the pane on the screen does not end with "${scene.last}":\n${screen.rows.join('\n')}`);
  // A chat longer than the pane is at its end: the row above the box's border is its last row.
  if (rowsOf(said).length > chat.height) assert.ok(scene.last.endsWith(screen.rows.at(-1).trim().split(/\s+/).at(-1)), `the last row of the pane is not the end of the chat:\n${screen.rows.join('\n')}`);
});

// A session here in the same four scenes, built as the runner leaves one: its replies in its
// runs' logs, its Task in its plan file, what waits in the project's requests.
const say = content => ({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [content] }, parent_tool_use_id: null, session_id: 's' });
const done = id => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'out' }] } });
const logged = (file, rows) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
function localSession(p, { state, replies = [], asked = [], live = false, plan = null, waiting = [] }) {
  const id = '4', { repo, worktree } = liveTask(p.root, { id, goal: 'Fix the report', state: 'ready' }), dir = taskDir(repo, id);
  fs.mkdirSync(dir, { recursive: true });
  const runs = replies.map(([minutes, text], index) => { const logFile = path.join(dir, `lead-${index + 1}.log`); logged(logFile, [{ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }, { type: 'result', structured_output: { outcome: 'done', summary: text } }]); return { role: 'lead', vendor: 'claude', logFile, code: 0, startedAt: ago(minutes + 0.2), at: ago(minutes) }; });
  const working = {};
  if (live) {
    const activeLog = path.join(dir, 'lead-live.log');
    logged(activeLog, [{ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }, say({ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: path.join(worktree, 'src', 'report.mjs') } }), done('t1'), say({ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } })]);
    Object.assign(working, { activeRole: 'lead', activeSince: ago(1), activeLog, owner: { pid: process.pid, identity: processIdentity(process.pid) } });
    p.mine.files.push(lock(repo, `task-${id}`));
  }
  saveTask(repo, { ...readTask(repo, id), permissions: 'ask', state, runs, messages: [{ at: ago(10), text: 'Fix the report' }, ...asked.map(([minutes, text]) => ({ at: ago(minutes), text }))], ...working });
  if (plan) {
    proposeTask(repo, id, { title: TASK.title, description: TASK.description, goal: TASK.goal, objectives: TASK.objectives, priority: 'high', severity: 'low' });
    if (plan.approved) approveTask(repo, id);
    // It was proposed when the reply that holds it was written, not when this test wrote it.
    const kept = JSON.parse(fs.readFileSync(planFile(repo, id), 'utf8'));
    for (const row of kept.tasks) Object.assign(row, { proposedAt: ago(plan.minutes), ...(plan.approved ? { approvedAt: ago(plan.minutes) } : {}) });
    fs.writeFileSync(planFile(repo, id), JSON.stringify(kept));
  }
  for (const [minutes, text] of waiting) saveRequest(p.root, text, null, { state: 'queued', priority: 0, continuationTaskId: id, attempts: 0, notBefore: null, queuedAt: ago(minutes), createdAt: ago(minutes) });
  return repo;
}
const HERE = {
  'a finished session with a Task and changes and one waiting message': {
    make: { state: 'ready', replies: [[9.5, 'Here is the Task for it.'], [5, 'Done. The totals add up.']], plan: { minutes: 9.4, approved: true }, waiting: [[0.1, 'Also update the docs']] },
    order: ['Fix the report', 'Here is the Task for it.', 'Task · approved', 'Done. The totals add up.', '(waiting)', 'Also update the docs'] },
  'a working session with steps and one waiting message': {
    make: { state: 'running', live: true, replies: [[9, 'Here is the Task for it.']], plan: { minutes: 8.9, approved: true }, asked: [[1, 'Go on with it']], waiting: [[0.1, 'Use CSV for it']] },
    order: ['Fix the report', 'Here is the Task for it.', 'Task · approved', 'Go on with it', 'is working', 'Read: src/report.mjs', 'Run: npm test', '(waiting)', 'Use CSV for it'] },
  'two waiting messages': {
    make: { state: 'answered', replies: [[9, 'It is fixed.']], waiting: [[2, 'First of the two'], [1, 'Second of the two']] },
    order: ['Fix the report', 'It is fixed.', '(waiting)', 'First of the two', '(waiting)', 'Second of the two'] },
  'a Task that waits for approval with nothing after it': {
    make: { state: 'answered', replies: [[9.5, 'Here is the Task for it.']], plan: { minutes: 9.4, approved: false } },
    order: ['Fix the report', 'Here is the Task for it.', 'Task · waits for your approval', 'Fix the report totals'], last: 'or type what to change' },
};

for (const [columns, rows] of [[140, 50], [80, 24]]) for (const [name, scene] of Object.entries(HERE)) test(`the app at ${columns}x${rows}, a session here: ${name}`, { timeout: 60000 }, async t => {
  const p = start(t); localSession(p, scene.make);
  const v = await view(p, { columns, rows, repo: p.repo, dashboard: true, peer: fakePeer() });
  await onRow(v, /Fix the report/);
  const { chat } = v.panels, waiting = (scene.make.waiting ?? []).map(([, text]) => text);
  await until(() => flat(chat.getText()).includes(scene.order.at(-1)) && flat(chat.getText()).includes(scene.order.at(-2)), 'its chat beside the list');
  const said = chat.getText(), rest = inOrder(said, scene.order);
  // A session here has no line of its chat for its changes either.
  assert.doesNotMatch(flat(said), /Changes · |d opens them/);
  if (scene.last) endsWith(said, scene.last);
  // Under his last waiting message: only what says when it goes and the keys for it. No Task, no steps, no reply.
  else assert.doesNotMatch(rest, /Task ·|is working|Read: |Run: |Objectives|Claude|Opus|Checks complete|\(waiting\)/, `something is drawn under what he sent last:\n${said}`);
  // In the order he sent them, each once.
  assert.deepEqual([...said.matchAll(/\(waiting\)/g)].length, waiting.length);
  // On the screen: the pane ends with the end of the chat, and the message box starts right under it.
  const screen = onScreen(v), end = rowsOf(said).at(-1).trim().split(/\s+/).at(-1); assert.ok(screen.box >= screen.under && screen.box - screen.under <= 1, 'the message box is under the pane, after the status row at most');
  assert.ok(screen.shown.at(-1).trim().endsWith(end), `the pane on the screen does not end with the end of the chat ("${end}"):\n${screen.rows.join('\n')}`);
});

// An entry from the other computer that says no time: an ELU there up to 0.1.19 sent a bot's
// review with none, and the pane drew it above the first message. It goes after the entry it
// came after, and a Task proposed before it is still drawn above it.
test('an entry from the other computer that says no time is drawn after the entry it came after, never above the first message', () => {
  const app = glue(), review = { role: '@reviewer · review 1', at: null, text: 'Looks right.', bot: 'reviewer' };
  const said = entries => app.parts(partRow({ state: 'answered', entries }), 96).map(part => part.text).join('\n\n');
  const you = [{ role: 'You', at: ago(10), text: 'Fix the report' }, { role: 'Claude', lead: true, at: ago(9), text: 'I looked at it.' }];
  inOrder(said([...you, review, { role: 'You', at: ago(5), text: 'Go on' }]), ['Runs on @my-box', 'Fix the report', 'I looked at it.', 'Looks right.', 'Go on']);
  // Sent first, it is still under the first message.
  inOrder(said([review, ...you]), ['Runs on @my-box', 'Fix the report', 'Looks right.', 'I looked at it.']);
  // Sent last, it is last, and a Task proposed before it stays above it.
  const parts = app.parts(partRow({ state: 'answered', plan: approved(ago(9.5)), entries: [...you, review] }), 96);
  assert.deepEqual(parts.map(part => part.key.split('\0')[0]), ['runs', 'entry', 'task', 'entry', 'entry']); assert.match(parts.at(-1).text, /Looks right\.$/);
  const at = seconds => new Date(Date.UTC(2026, 10, 13, 9, 0, seconds)).toISOString();
  assert.equal(taskPlace([{ at: at(0) }, { at: at(10) }, { at: at(20) }, { at: null }], { by: 'lead', proposedAt: at(15) }), 2);
  assert.equal(taskPlace([{ at: at(0) }, { at: at(10) }, { at: null }, { at: at(20) }], { by: 'lead', proposedAt: at(15) }), 3);
});

// The window made smaller or larger: a chat longer than its pane, at its end, stays at its
// end, so the newest message stays in view. One the owner scrolled up stays where he put it.
const pause = ms => new Promise(done => setTimeout(done, ms));
const resizeTo = async (v, columns, rows) => { v.output.columns = columns; v.output.rows = rows; v.output.emit('resize'); await until(() => v.current.screen.width === columns && v.current.screen.height === rows, `${columns}x${rows}`); await pause(200); };
// The last row the pane shows on the screen, and the last row of its chat.
const ends = v => { const said = rowsOf(v.panels.chat.getText()), screen = onScreen(v); return { shown: screen.shown.at(-1)?.trim() ?? '', last: said.at(-1)?.trim() ?? '' }; };
const LINES = 'The report adds every row and keeps its totals in cents, so nothing is rounded on the way.';
const LONG = {
  here: { state: 'answered', replies: Array.from({ length: 30 }, (_, index) => [9 - index * 0.3, `Reply ${index + 1}. ${LINES} ${LINES}`]), asked: Array.from({ length: 29 }, (_, index) => [8.85 - index * 0.3, `Question ${index + 2} about the totals.`]), waiting: [[0.1, 'Also update the docs']] },
  remote: { state: 'answered', waiting: [{ at: ago(0), text: 'Also update the docs', state: 'queued' }], entries: Array.from({ length: 60 }, (_, index) => index % 2 ? { role: 'Claude', lead: true, at: ago(9 - index * 0.15), text: `Reply ${index}. ${LINES} ${LINES}` } : { role: 'You', at: ago(9 - index * 0.15), text: `Question ${index + 1} about the totals.` }) },
};
for (const kind of ['here', 'remote']) test(`a chat longer than its pane, at its end, stays at its end when the window is made smaller or larger: a session ${kind === 'here' ? 'here' : 'on another computer'}`, { timeout: 90000 }, async t => {
  const p = start(t); if (kind === 'here') localSession(p, LONG.here);
  const v = await view(p, { columns: 140, rows: 50, repo: p.repo, dashboard: true, peer: fakePeer(kind === 'here' ? {} : { remote: [remoteView(LONG.remote)] }) });
  await onRow(v, /Fix the report|Question 1/);
  const { chat } = v.panels;
  await until(() => flat(chat.getText()).includes('Also update the docs'), 'its chat'); await pause(200);
  assert.ok(rowsOf(chat.getText()).length > 2 * chat.height, 'the chat is longer than the pane');
  let end = ends(v); assert.equal(end.shown, end.last, `not at its end at 140x50:\n${onScreen(v).rows.join('\n')}`);
  for (const [columns, rows] of [[80, 24], [140, 50], [100, 30], [80, 24], [120, 40], [90, 26]]) {
    await resizeTo(v, columns, rows); end = ends(v);
    assert.equal(end.shown, end.last, `not at its end at ${columns}x${rows}:\n${onScreen(v).rows.join('\n')}`);
  }
  // Paged up by the owner: it stays on the lines he paged to, at every size.
  await resizeTo(v, 140, 50); chat.focus(); v.input.write('\x1b[5~'); await pause(200); v.input.write('\x1b[5~'); await pause(200);
  const first = flat(onScreen(v).shown[0]).split(' ').slice(0, 4).join(' ');
  assert.notEqual(ends(v).shown, ends(v).last, 'paged up');
  for (const [columns, rows] of [[80, 24], [120, 40], [140, 50]]) {
    await resizeTo(v, columns, rows); end = ends(v);
    assert.notEqual(end.shown, end.last, `back at the end at ${columns}x${rows}, though he paged up`);
    assert.ok(flat(onScreen(v).shown.join('\n')).includes(first), `"${first}" left the pane at ${columns}x${rows}:\n${onScreen(v).rows.join('\n')}`);
  }
});
