import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { project, temp } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { registerProject } from '../lib/projects.mjs';
import { saveRequest, pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { launchTerminal } from '../lib/terminal.mjs';
import { listBots, removeBot, saveBot } from '../lib/bots.mjs';
import { boardRows, barCells, barColumns } from '../lib/board.mjs';
import { readBoard } from '../lib/kanban.mjs';
import { botTarget, chatBar, dmTarget, fitWords, ink, membersLine, peerName, roomTarget, teamPanes, threadTarget, visible } from '../lib/terminal-visuals.mjs';

const ME = 'a'.repeat(64), SARA = 'b'.repeat(64), LI = 'c'.repeat(64);
const LONG = 'Could you check whether the retry budget in the uploader resets after a successful flush or only after restart because we keep seeing duplicate batches';
const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();

function fakePeer({ enabled = true, items, running = true, refuse = () => null, remoteBots = [] } = {}) {
  const calls = [];
  const record = (name, value) => (...args) => { calls.push([name, ...args]); return typeof value === 'function' ? value(...args) : value; };
  const facade = {
    calls, enabled, channels: [],
    sent: () => calls.filter(row => row[0] === 'sendPeerCommand').map(row => row[1]),
    peerSettings: () => ({ enabled: facade.enabled }),
    peerStatus: record('peerStatus', () => ({ running, pid: 1, key: ME, name: 'ana', fingerprint: 'aaaaaaaa', error: null, counters: { direct: 1, relayed: 0, failed: 0 },
      teams: [{ id: 'team-1', name: 'Core', role: 'admin', members: [
        { key: ME, fingerprint: 'aaaaaaaa', name: 'ana', role: 'admin', online: true, path: null, lastSeen: ago(0) },
        { key: SARA, fingerprint: 'bbbbbbbb', name: 'sara', role: 'member', online: true, path: 'direct', lastSeen: ago(0), box: 'sara-box', bots: remoteBots },
        { key: LI, fingerprint: 'cccccccc', name: 'li', role: 'member', online: false, path: null, lastSeen: ago(90), handles: ['api'] },
      ], channels: facade.channels.filter(row => row.members.includes(ME)) }] })),
    peerItems: record('peerItems', () => items ?? [
      { id: 'held-1', kind: 'held', peer: SARA, name: 'sara', project: 'web', text: 'The deploy script lives in bin/deploy.', at: ago(2), state: 'awaiting-owner', threadId: 'th-1' },
      { id: 'draft-1', kind: 'draft', peer: LI, name: 'li', project: null, text: 'Which schema version does the API use?', at: ago(3), state: 'draft', threadId: 'th-2' },
      { id: 'incoming-1', kind: 'incoming', peer: LI, name: 'li', project: 'api', text: 'Where are the fixtures?', at: ago(4), state: 'submitted', threadId: 'th-3' },
      { id: 'asked-1', kind: 'asked', peer: LI, name: 'li', project: null, text: LONG, at: ago(5), state: 'submitted', threadId: 'th-4' },
      { id: 'answer-1', kind: 'answer', peer: SARA, name: 'sara', project: 'web', text: 'Use the v2 endpoint.', at: ago(10), state: 'completed', threadId: 'th-5' },
    ]),
    teamAgents: record('teamAgents', () => [
      { peer: SARA, name: 'sara', online: true, rows: [{ handle: 'web', taskId: '7', label: 'editing', now: 'Refactor the login form', files: ['src/login.js'], overlap: ['src/login.js'] }] },
      { peer: LI, name: 'li', online: false, rows: [] },
    ]),
    tickerEvents: record('tickerEvents', () => [{ at: ago(1), text: 'sara is online' }, { at: ago(6), text: 'li went offline' }]),
    sendPeerCommand: record('sendPeerCommand', command => { facade.last = command; return { id: `command-${calls.length}` }; }),
    // The daemon's answer to the last command: refuse(command) returns a refusal or null. A channel change lands in the roster.
    awaitCommand: record('awaitCommand', async () => {
      const reason = refuse(facade.last), { type, id = 'c'.repeat(16), name, members } = facade.last; if (reason) throw new Error(reason);
      if (type !== 'channelSet') return {};
      facade.channels = [...facade.channels.filter(row => row.id !== id), ...(members.length ? [{ id, name, members }] : [])]; return { id };
    }),
    startPeer: record('startPeer', { running: true }), stopPeer: record('stopPeer', { running: false }),
    share: record('share', (root, { handle }) => ({ handle: handle ?? 'sample', root, status: true })),
    createInvite: record('createInvite', () => ({ code: 'elu-team:v1:TESTCODE' })),
    joinTeam: record('joinTeam', async () => ({ id: 'team-2', name: 'Docs' })),
  };
  return facade;
}

// One after hook for each test: node:test stops at the first after hook that throws, so a
// second hook could be left unrun. Views close first, then the environment goes back and the
// folders are removed. Every cleanup runs, a failed one included, so a view that would not
// close cannot leave the next one open or the environment changed for the next test; the
// first failure is thrown after the last cleanup.
const cleanups = new WeakMap();
function owned(t) {
  if (!cleanups.has(t)) {
    const value = { views: [], files: [] }; cleanups.set(t, value);
    t.after(async () => {
      let failure = null;
      for (const close of [...value.views.reverse(), ...value.files.reverse()]) { try { await close(); } catch (error) { failure ??= error; } }
      if (failure) throw failure;
    });
  }
  return cleanups.get(t);
}
const later = t => ({ after: close => owned(t).files.push(close) });
async function until(check, message = 'condition', timeout = 10000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function environment(t, parent) {
  const values = { XDG_CONFIG_HOME: path.join(parent, 'personal'), NO_COLOR: '1', TERM: 'xterm-256color' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  owned(t).files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
async function view(t, { columns = 160, rows = 40, ...options } = {}) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = columns; output.rows = rows;
  let rendered, renders = 0, writes = 0;
  output.on('data', () => { writes++; });
  const finished = launchTerminal({ ...options, input, output, refreshMs: 30, startConductor: () => false, onRender: value => { rendered = value; renders++; } });
  finished.catch(() => {});
  await until(() => rendered, 'first render');
  // A failed test can leave a dialog open, and the app ignores q while one is: every pass
  // closes what is open (closing one can open the next) and presses q again. A view that
  // still will not close is interrupted the way a hangup would, and if even that fails the
  // test fails here: this never waits forever.
  owned(t).views.push(async () => {
    let closed = false; finished.then(() => { closed = true; }, () => { closed = true; });
    for (const started = Date.now(); !closed && !rendered.screen.destroyed;) {
      const waited = Date.now() - started;
      if (waited > 10000) { input.destroy(); output.destroy(); throw new Error('The view did not close after its test.'); }
      rendered.panels.ask.cancel();
      for (const child of [...rendered.screen.children]) { child.dismiss?.(); child.children?.find(item => item.type === 'textbox')?.emit('cancel'); }
      if (waited > 3000) process.emit('SIGHUP');
      else { rendered.panels.chat.focus(); rendered.screen.emit('keypress', 'q', { name: 'q' }); }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    input.destroy(); output.destroy();
  });
  return { input, output, finished, get current() { return rendered; }, get panels() { return rendered.panels; }, get renders() { return renders; }, get writes() { return writes; },
    lines() { return rendered.screen.lines.map(row => row.map(cell => cell[1]).join('')); }, text() { return this.lines().join('\n'); } };
}
async function send(v, text) {
  v.panels.ask.focus(); v.panels.ask.readInput();
  await until(() => v.panels.ask.__listener, 'chat input');
  v.panels.ask.setValue(text); v.panels.ask.submit();
}
const modal = (v, title) => v.current.screen.children.find(child => !child.destroyed && child.options?.label?.trim() === title);
async function closeDialog(v, title, value = '') {
  await until(() => modal(v, title), title);
  const field = modal(v, title).children.find(child => child.type === 'textbox');
  await until(() => field.__listener, `${title} input`); field.setValue(value); field.submit();
  await until(() => !modal(v, title), `${title} closed`);
}
const plainItem = item => item.getText();
function selectRow(list, pattern) {
  const index = list.items.findIndex(item => pattern.test(plainItem(item)));
  assert.ok(index >= 0, `no row matches ${pattern}`); list.select(index); return index;
}
// Opens a row of the Chats bar, a channel or a person: its threads show beside it under its name.
async function openRow(v, pattern, name) {
  const [bar] = v.panels.teamLists;
  await until(() => bar.items.some(item => pattern.test(plainItem(item))), `bar row ${pattern}`);
  selectRow(bar, pattern);
  await until(() => v.panels.teamBoxes[1]._label.getText().trim() === name, `${name} open`);
}
// A list dialog's rows, and Enter on the one that matches.
const rowsOf = (v, title) => modal(v, title)?.children.find(child => child.type === 'list')?.items.map(plainItem) ?? [];
async function choose(v, title, pattern) {
  await until(() => rowsOf(v, title).some(line => pattern.test(line)), `${title}: ${pattern}`);
  selectRow(modal(v, title).children.find(child => child.type === 'list'), pattern); v.input.write('\r');
}
// The line over the open channel's threads, read from its widget: text that is set again is blank in the screen's rows until the next render.
const inside = v => v.panels.teamBoxes[1].children.find(child => child.type === 'text' && !child.hidden)?.getText() ?? null;
const threadLines = v => v.panels.teamLists[1].items.map(item => plainItem(item).trimEnd());
async function teamView(t, options = {}) {
  const parent = temp(later(t)); environment(t, parent);
  const peer = options.peer === undefined ? fakePeer() : options.peer;
  const v = await view(t, { ...options, peer });
  await send(v, '/chats');
  await until(() => v.current.view === 'chats', 'Chats');
  return { v, peer, parent };
}
function assertPanes(v, width) {
  const lines = v.lines();
  assert.ok(lines.every(line => line.length <= width), 'a line exceeds the width');
  for (const pane of v.panels.teamBoxes.filter(box => !box.hidden)) {
    const left = pane.aleft, right = pane.aleft + pane.width - 1, top = pane.atop, bottom = pane.atop + pane.height - 1;
    assert.ok(right < width && bottom < v.current.screen.height, 'pane fits the screen');
    assert.equal(lines[top][left], '┌'); assert.equal(lines[top][right], '┐');
    assert.equal(lines[bottom][left], '└'); assert.equal(lines[bottom][right], '┘');
    for (let y = top + 1; y < bottom; y++) { assert.equal(lines[y][left], '│', `left border row ${y}`); assert.equal(lines[y][right], '│', `right border row ${y}`); }
  }
  for (const list of v.panels.teamLists.filter(list => !list.parent.hidden)) for (const item of list.items) assert.ok(plainItem(item).length <= list.width - 1, `row wider than its pane: ${plainItem(item)}`);
}

test('board rows put peer work that needs the owner first and keep lines within width', () => {
  const now = Date.now(), at = minutes => new Date(now - minutes * 60000).toISOString();
  const projects = [{ name: 'web', root: '/p/web', activity: [], tasks: [{ id: '1', kind: 'conversation', state: 'running', activeRole: 'lead', activeSince: at(2), goal: 'Fix it', runs: [], messages: [], createdAt: at(3) }], queue: [
    { id: 'request-a', goal: 'Answer the question from @sara', state: 'waiting', createdAt: at(1), context: 'How do we rotate keys?\nmore', origin: { kind: 'ask', peer: SARA, name: 'sara', a2aTaskId: 'task-a', threadId: 'th', hop: 1 } },
    { id: 'request-b', goal: 'Work on the handoff from @li', state: 'waiting', createdAt: at(2), context: 'Fix the flaky upload test', origin: { kind: 'handoff', peer: LI, name: 'li', a2aTaskId: 'task-b', threadId: 'th', hop: 1 } },
    { id: 'request-c', goal: 'Answer the question from @sara', state: 'queued', queuedAt: at(1), origin: { kind: 'ask', peer: SARA, name: 'sara', a2aTaskId: 'task-c', threadId: 'th', hop: 1 } },
  ] }];
  const items = [
    { id: 'task-a', kind: 'incoming', peer: SARA, name: 'sara', requestId: 'request-a', root: '/p/web', text: 'How do we rotate keys?', at: at(1) },
    { id: 'held-1', kind: 'held', peer: SARA, name: 'sara', text: 'bin/deploy', at: at(4) },
    { id: 'draft-1', kind: 'draft', peer: LI, name: 'li‮', text: 'Which schema?', at: at(5) },
    { id: 'asked-1', kind: 'asked', peer: LI, name: 'li', text: 'Warm?', at: at(6) },
    { id: 'answer-1', kind: 'answer', peer: SARA, name: 'sara', text: 'Use v2.', at: at(7) },
    { id: 'expired-1', kind: 'expired', peer: LI, name: 'li', text: 'Old ask', at: at(8) },
    { id: 'rejected-1', kind: 'rejected', peer: LI, name: 'li', text: 'Over the cap', at: at(9) },
    { id: 'ancient', kind: 'answer', peer: LI, name: 'li', text: 'Too old', at: at(3000) },
    { kind: 'held', text: 'no id' },
  ];
  const rows = boardRows(projects, now, { items, online: new Set([SARA]) });
  // Like questions, the longest-waiting peer row comes first.
  assert.deepEqual(rows.filter(row => row.group === 0).map(row => row.label), ['SEND @li?', 'REPLY @sara', 'TASK @li', 'ASK @sara']);
  const [draft, held, handoff, ask] = rows;
  assert.equal(ask.now, 'Question · How do we rotate keys? more'); assert.equal(ask.item.id, 'task-a'); assert.equal(handoff.now, 'Task · Fix the flaky upload test');
  assert.match(held.now, /^Reply ready to send/); assert.match(draft.now, /^Your model wants to ask/); assert.equal(draft.agent, '@li');
  assert.equal(rows.filter(row => row.item?.id === 'task-a').length, 1, 'an incoming item matched to its request shows once');
  assert.equal(rows.find(row => row.request?.id === 'request-c'), undefined, 'an accepted question is answered in its thread, not listed as a session');
  assert.equal(rows.find(row => row.item?.id === 'asked-1').now, '@li offline · will retry');
  assert.deepEqual(rows.filter(row => row.group === 3).map(row => row.label), ['answer', 'expired', 'rejected']);
  assert.ok(!rows.some(row => row.item?.id === 'ancient'));
  // In the Sessions list every one of these rows is exactly as wide as the list, at the narrowest and the widest it gets.
  for (const width of [24, 28, 42, 60]) assert.ok(rows.every(row => barCells(row, width, now, barColumns(rows, width)).map(cell => cell.text).join('').length === width), `width ${width}`);
  assert.equal(peerName('sa ra​', SARA), '@sara'); assert.equal(peerName('', SARA), '@bbbbbbbb');
  assert.equal(fitWords('hello wonderful world', 16), 'hello…'); assert.equal(fitWords('hello', 16), 'hello');
});

test('Chats shows channels and direct messages beside the open one at 160x40', async t => {
  const { v } = await teamView(t);
  // It opens on the first row with a thread that waits for me: here @sara.
  await until(() => v.panels.teamLists[0].items.length && /reply ready/.test(v.text()), 'panes');
  const text = v.text();
  for (const value of ['Team', 'Channels', '# general', '+ Add channel', 'Direct messages', '● @sara', 'direct', '○ @li', 'offline', '+ Add teammate', '⚠ @sara web editing · overlap', 'reply ready', 'answered', '● 1 online'])
    assert.ok(text.includes(value), `missing ${value}`);
  assert.ok(!text.includes('Internal') && !text.includes('Global'), 'Chats has no sub-tabs');
  const [mates, threads] = v.panels.teamBoxes;
  assert.equal(v.panels.teamBoxes.length, 2); assert.equal(mates.atop, threads.atop); assert.ok(threads.aleft > mates.aleft);
  // Channels, then people, then my own bots: the five the app comes with. A teammate's sessions sit under that teammate, named by what they do with no number, and a row counts the threads that wait for me.
  const items = v.panels.teamLists[0].items.map(item => plainItem(item).trimEnd()), sara = items.findIndex(line => /@sara\s+direct/.test(line));
  assert.deepEqual(items.slice(0, 5), ['Channels', '# general  3', '+ Add channel', '', 'Direct messages']);
  assert.match(items[sara], /^● @sara\s+direct\s+1$/); assert.match(items[sara + 1], /^\s+⚠ @sara web editing · overlap/); assert.ok(!/#\d/.test(items[sara + 1]), 'a teammate’s session shows no number');
  assert.match(items[sara + 2], /^○ @li\s+offline\s+2$/); assert.deepEqual(items.slice(sara + 3), ['◆ @reviewer', '◆ @lead', '◆ @qa', '◆ @pair', '◆ @elu', '+ Add teammate']);
  assert.equal(v.panels.teamBoxes[1]._label.getText().trim(), '@sara'); assert.ok(!/draft to send|@li/.test(v.panels.teamLists[1].items.map(plainItem).join('\n')), 'only the open row’s threads show');
  assertPanes(v, 160);
  await openRow(v, /# general/, '#general');
  await until(() => /Nothing in #general yet\. Everyone on the team is in it\. Type below to write to it\./.test(v.text()), 'an empty channel says so');
  await openRow(v, /@li\s+offline/, '@li');
  await until(() => { const rows = v.panels.teamLists[1].items.map(plainItem).join('\n'); return ['draft to send', '@li asks you', 'you asked @li'].every(value => rows.includes(value)) && !/reply ready|@sara/.test(rows); }, 'threads with @li');
  assertPanes(v, 160);
  const asked = v.panels.teamLists[1].items.map(plainItem).find(line => line.includes('asked'));
  assert.match(asked, /…$/); const words = asked.slice(0, -1).trim().split(' '); assert.ok(LONG.includes(words.at(-1)), 'cut at a word boundary');
});

test('Chats stacks the bar over threads at 80x24 without breaking borders', async t => {
  const { v } = await teamView(t, { columns: 80, rows: 24 });
  await until(() => v.panels.teamLists[1].items.length > 1 && v.panels.teamBoxes[1]._label.getText().trim() === '@sara', 'stacked panes');
  const [mates, threads] = v.panels.teamBoxes;
  assert.ok([mates, threads].every(pane => pane.aleft === 0 && pane.width === 80 && pane.height >= 4));
  assert.equal(threads.atop, mates.atop + mates.height); assert.ok(threads.atop + threads.height <= v.panels.status.atop);
  const text = v.text();
  for (const value of ['Team', '@sara', '● @sara']) assert.ok(text.includes(value), `missing ${value}`);
  assertPanes(v, 80);
  // Stacked panes lead into each other with the arrows.
  const [roster, list] = v.panels.teamLists; roster.focus(); roster.select(roster.items.length - 1); v.input.write('\x1b[B');
  await until(() => v.current.screen.focused === list, 'Down from the last teammate reaches Threads');
  list.select(0); v.input.write('\x1b[A'); await until(() => v.current.screen.focused === roster, 'Up from the first thread returns');
});

test('a message that starts with ! in Chats runs in a shell and is never asked to the team', async t => {
  const { v, peer } = await teamView(t);
  await send(v, '!echo not-for-the-team');
  await until(() => modal(v, '$ echo not-for-the-team'), 'the output dialog');
  assert.match(modal(v, '$ echo not-for-the-team').children.find(child => child.options?.scrollable).getText(), /not-for-the-team/);
  assert.deepEqual(peer.sent(), [], 'nothing was sent to a teammate');
  await closeDialog(v, '$ echo not-for-the-team');
});

test('Chats keys approve, discard, accept, continue and write to a teammate', async t => {
  const { v, peer } = await teamView(t);
  await until(() => v.panels.teamLists[1].items.length > 1, 'threads');
  const [roster, threads] = v.panels.teamLists;
  threads.focus(); selectRow(threads, /reply ready/); v.input.write('y');
  await until(() => peer.sent().some(row => row.type === 'approve' && row.id === 'held-1'), 'approve held reply');
  await openRow(v, /@li\s+offline/, '@li'); threads.focus(); selectRow(threads, /draft to send/); v.input.write('n');
  await until(() => peer.sent().some(row => row.type === 'discard' && row.id === 'draft-1'), 'discard draft');
  selectRow(threads, /@li asks you/); v.input.write('y'); await until(() => modal(v, 'Accept'), 'accept picker'); v.input.write('\r');
  await until(() => peer.sent().some(row => row.type === 'work' && row.id === 'incoming-1'), 'accept incoming without a saved request');
  await openRow(v, /@sara\s+direct/, '@sara'); threads.focus(); selectRow(threads, /answered/); v.input.write('c');
  await until(() => peer.sent().some(row => row.type === 'continue' && row.id === 'answer-1'), 'continue');
  threads.focus(); selectRow(threads, /answered/); v.input.write('\r');
  await until(() => modal(v, 'Thread with @sara'), 'thread details');
  await closeDialog(v, 'Thread with @sara');
  roster.focus(); selectRow(roster, /@sara\s+direct/); v.input.write('\r');
  await until(() => v.panels.ask.getValue() === '' && v.current.screen.focused === v.panels.ask && /Message @sara/.test(v.panels.ask._label.getText()), 'Enter on a teammate moves to the message box, which writes to them');
  // a starts an @name ask, as it always did.
  roster.focus(); v.input.write('a'); await until(() => v.panels.ask.getValue() === '@sara ' && v.current.screen.focused === v.panels.ask, 'a starts an ask');
  v.panels.ask.clearValue();
  assert.deepEqual(peer.sent().map(row => Object.keys(row).sort().join()), ['id,type', 'id,type', 'folders,id,permissions,place,type', 'id,type']);
});

test('a thread dialog acts on the letter it names, only while its field is empty', { timeout: 20000 }, async t => {
  const p = project(later(t)); environment(t, p.parent); registerProject(repository(p.root));
  const ask = saveRequest(p.root, 'Answer the question from @sara (shown in the peer data block) using this repository. Do not edit files.', undefined, { state: 'waiting', origin: { kind: 'ask', peer: SARA, name: 'sara', a2aTaskId: 'task-ask', threadId: 'th', hop: 1 }, readOnly: true, context: 'How do we rotate keys?' });
  const peer = fakePeer({ items: [
    { id: 'incoming:task-ask', kind: 'incoming', peer: SARA, name: 'sara', project: 'app', root: p.root, requestId: ask.id, text: 'How do we rotate keys?', at: ago(1), state: 'submitted' },
    { id: 'held-1', kind: 'held', peer: SARA, name: 'sara', text: 'Rotate with bin/rotate.', at: ago(2), threadId: 'th-held' },
    { id: 'answer-1', kind: 'answer', peer: SARA, name: 'sara', text: 'Use v2.', at: ago(4) },
  ] });
  peer.threadMessages = id => id === 'th-held' ? [
    { from: 'peer', peer: SARA, name: 'sara', kind: 'ask', text: 'How do we rotate keys?', at: ago(3) },
    { from: 'me', held: true, peer: SARA, name: 'sara', kind: 'held', text: 'Rotate with bin/rotate.', at: ago(2) },
  ] : [];
  const v = await view(t, { peer });
  await send(v, '/chats'); await until(() => v.current.view === 'chats', 'Chats');
  const [, threads] = v.panels.teamLists;
  // A message row each, and a reply row under the held reply and the answer.
  await until(() => threads.items.length === 5, 'threads');
  const open = async (list, pattern, title, hint) => { list.focus(); selectRow(list, pattern); v.input.write('\r'); await until(() => modal(v, title) && v.text().includes(hint), hint); };
  // Enter reads an ask; y in the dialog accepts it, as y does on the list: the picker opens, Enter starts it.
  await open(threads, /asks you/, 'Thread with @sara', 'y accepts in a mode you pick. n declines.');
  v.input.write('y'); await until(() => modal(v, 'Accept'), 'accept picker'); v.input.write('\r');
  // The daemon runs it as the owner's session in the picked mode; the dialog only sends the command.
  await until(() => peer.sent().some(row => row.type === 'work' && row.id === 'incoming:task-ask' && row.permissions === 'ask'), 'ask accepted from the dialog');
  await until(() => !modal(v, 'Thread with @sara') && /Accepted @sara/.test(v.panels.status.getText()), 'dialog closed');
  // Once something is typed, letters are text.
  await open(threads, /reply ready/, 'Thread with @sara', 'y sends. n discards.');
  // The thread reads like a chat: Sara's question, then my model's reply waiting to go.
  assert.match(v.text(), /@sara · question · \d\d:\d\d[^]*How do we rotate keys\?[^]*↳ your model · answer · not sent yet · \d\d:\d\d[^]*Rotate with bin\/rotate\./);
  v.input.write('x'); v.input.write('y'); await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(modal(v, 'Thread with @sara'), 'typed letters keep the dialog open');
  await closeDialog(v, 'Thread with @sara');
  assert.ok(!peer.sent().some(row => row.type === 'approve'), 'nothing approved');
  await open(threads, /reply ready/, 'Thread with @sara', 'y sends. n discards.'); v.input.write('n');
  await until(() => peer.sent().some(row => row.type === 'discard' && row.id === 'held-1'), 'reply discarded from the dialog');
  await open(threads, /answered/, 'Thread with @sara', 'c continues'); v.input.write('c');
  await until(() => peer.sent().some(row => row.type === 'continue' && row.id === 'answer-1'), 'continued from the dialog');
});

test('Shift letters and typed text never fail silently, and nothing opens an external editor', async t => {
  const { v, peer } = await teamView(t);
  const [, threads] = v.panels.teamLists, status = () => v.panels.status.getText(), screen = v.current.screen;
  await until(() => threads.items.length > 1, 'threads');
  // Caps Lock or Shift: Y on the list and N in a dialog still decide.
  await openRow(v, /@li\s+offline/, '@li'); threads.focus(); selectRow(threads, /@li asks you/); v.input.write('Y'); await until(() => modal(v, 'Accept'), 'Y opens the picker'); v.input.write('\r');
  await until(() => peer.sent().some(row => row.type === 'work' && row.id === 'incoming-1'), 'Y accepts on the list');
  await openRow(v, /@sara\s+direct/, '@sara'); threads.focus(); selectRow(threads, /reply ready/); v.input.write('\r'); await until(() => modal(v, 'Thread with @sara'), 'dialog');
  v.input.write('N'); await until(() => peer.sent().some(row => row.type === 'discard' && row.id === 'held-1'), 'N discards in the dialog');
  // Other text and Enter says what to press.
  await until(() => !modal(v, 'Thread with @sara'), 'closed');
  await openRow(v, /@li\s+offline/, '@li'); threads.focus(); selectRow(threads, /draft to send/); v.input.write('\r'); await until(() => modal(v, 'Thread with @li'), 'draft dialog');
  v.input.write('maybe'); v.input.write('\r');
  await until(() => /Nothing was done\. Press y or n\./.test(status()), 'typed text explains');
  assert.ok(!peer.sent().some(row => row.id === 'draft-1'), 'the draft is untouched');
  // blessed opens $EDITOR on e, Ctrl-E and a right-click; ELU Code types in place instead.
  const editors = []; screen.readEditor = (...args) => { editors.push(args); args.at(-1)?.(null, null); };
  const ask = v.panels.ask; ask.focus(); ask.readInput(); await until(() => ask._reading, 'reading');
  v.input.write('\r'); await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(ask._reading && screen.focused === ask, 'an empty Enter keeps the box reading');
  v.input.write('e'); await until(() => ask.getValue() === 'e', 'e is typed');
  // e, Ctrl-E and a right-click all reach readEditor.
  ask.clearValue(); ask.readEditor(); await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(editors.length, 0, 'no external editor');
  assert.ok(ask._reading && screen.focused === ask, 'it reads input instead');
});

test('typing in Chats writes to the open channel or person, and @name to one teammate', async t => {
  const { v, peer } = await teamView(t);
  const status = () => v.panels.status.getText(), label = () => v.panels.ask._label.getText();
  // A channel: everyone in it gets the question, and the first to take it answers.
  await openRow(v, /# general/, '#general');
  await until(() => /Message #general · the first teammate to take it answers/.test(label()), 'the box names the channel');
  await send(v, 'where is the deploy script?');
  await until(() => peer.sent().some(row => row.type === 'teamAsk'), 'team ask');
  assert.deepEqual(peer.sent().at(-1), { type: 'teamAsk', project: null, text: 'where is the deploy script?', team: 'team-1', channel: null });
  await until(() => /Sent to #general\. The first teammate to take it answers\./.test(status()) && v.panels.ask.getValue() === '', 'team ask sent');
  // @name goes to that teammate whatever is open.
  await send(v, '@sara web How do we deploy?');
  await until(() => peer.sent().some(row => row.type === 'ask'), 'ask');
  assert.deepEqual(peer.sent().at(-1), { type: 'ask', to: 'sara', project: 'web', text: 'How do we deploy?' });
  await until(() => /Sent to @sara\. It runs after they accept it\./.test(status()) && v.panels.ask.getValue() === '', 'sent');
  // A person: every word is the message, even one that is a project they share.
  await openRow(v, /@li\s+offline/, '@li');
  await until(() => /Message @li/.test(label()), 'the box names the person');
  await send(v, 'api tests fail on my machine');
  await until(() => peer.sent().at(-1).to === LI, 'direct message');
  assert.deepEqual(peer.sent().at(-1), { type: 'ask', to: LI, project: null, text: 'api tests fail on my machine' });
  await until(() => /Sent to @li\. It runs after they accept it\./.test(status()) && v.panels.ask.getValue() === '', 'sent to the person');
});

test('a channel is made from teammates on the team; typing writes to it, m changes who is in it, x leaves it', { timeout: 20000 }, async t => {
  const { v, peer } = await teamView(t);
  const [bar] = v.panels.teamLists, status = () => v.panels.status.getText(), who = 'Who is in #design', id = 'c'.repeat(16);
  const ticked = pattern => until(() => rowsOf(v, who).some(line => pattern.test(line)), `${pattern}`);
  await until(() => bar.items.length > 4, 'the bar');
  // #general is everyone on the team: m says so, and how someone gets in.
  bar.focus(); selectRow(bar, /# general/); v.input.write('m');
  await until(() => /Everyone on the team is in #general\. \+ Add teammate invites someone\./.test(status()), 'general has no member list');
  // + Add channel asks for a name, then for the people. A channel needs a name of its own and someone in it.
  selectRow(bar, /\+ Add channel/); v.input.write('\r'); await closeDialog(v, 'New channel', 'general');
  await until(() => /general is taken\./.test(status()), 'general is taken');
  bar.focus(); v.input.write('n'); await closeDialog(v, 'New channel', '#Design');
  await ticked(/Create channel/); assert.deepEqual(rowsOf(v, who), ['[ ] @sara', '[ ] @li', 'Create channel'], 'only teammates already on the team');
  await choose(v, who, /Create channel/);
  await until(() => /Tick at least one teammate, then Create channel\./.test(status()), 'nobody ticked');
  assert.ok(!peer.sent().some(row => row.type === 'channelSet'));
  bar.focus(); v.input.write('n'); await closeDialog(v, 'New channel', 'design');
  await choose(v, who, /\[ \] @sara/); await ticked(/\[x\] @sara/); await choose(v, who, /Create channel/);
  await until(() => peer.sent().some(row => row.type === 'channelSet'), 'channel created');
  assert.deepEqual(peer.sent().at(-1), { type: 'channelSet', team: 'team-1', name: 'design', members: [ME, SARA] });
  // It is in the bar with the cursor on it, and the message box writes to it.
  await until(() => /# design/.test(plainItem(bar.items[bar.selected])) && /Message #design/.test(v.panels.ask._label.getText()), 'the channel opens');
  assert.match(status(), /Created #design with 1 teammate\. They see it when they are online\./);
  assert.deepEqual(bar.items.map(item => plainItem(item).trimEnd()).slice(0, 4), ['Channels', '# general  3', '# design  2', '+ Add channel']);
  await send(v, 'who owns the tokens?');
  await until(() => peer.sent().at(-1).type === 'teamAsk', 'channel ask');
  assert.deepEqual(peer.sent().at(-1), { type: 'teamAsk', project: null, text: 'who owns the tokens?', team: 'team-1', channel: id });
  await until(() => /Sent to #design\. The first teammate to take it answers\./.test(status()), 'sent to the channel');
  // m keeps someone else in the channel: leaving is x.
  bar.focus(); v.input.write('m'); await choose(v, who, /\[x\] @sara/); await ticked(/\[ \] @sara/); await choose(v, who, /^Save$/);
  await until(() => /Tick at least one teammate\. To leave the channel, press x on it\./.test(status()), 'a channel keeps someone else in it');
  // m ticks @li too.
  bar.focus(); v.input.write('m'); await ticked(/\[x\] @sara/); assert.deepEqual(rowsOf(v, who), ['[x] @sara', '[ ] @li', 'Save']);
  await choose(v, who, /\[ \] @li/); await ticked(/\[x\] @li/); await choose(v, who, /^Save$/);
  await until(() => peer.sent().at(-1).members?.length === 3, 'members saved');
  assert.deepEqual(peer.sent().at(-1), { type: 'channelSet', team: 'team-1', id, name: 'design', members: [ME, SARA, LI] });
  await until(() => /#design now has 2 teammates and you\./.test(status()), 'saved message');
  // x leaves it: the others keep the channel and it is gone from my bar.
  bar.focus(); v.input.write('x'); await closeDialog(v, 'Leave #design', 'y');
  await until(() => peer.sent().at(-1).members?.length === 2, 'left');
  assert.deepEqual(peer.sent().at(-1), { type: 'channelSet', team: 'team-1', id, name: 'design', members: [SARA, LI] });
  await until(() => !bar.items.some(item => /# design/.test(plainItem(item))) && /Left #design\./.test(status()), 'gone from my bar');
});

test('the open channel names who is in it over its threads, and an empty one says how people get in', async t => {
  const peer = fakePeer({ items: [] }); peer.channels = [{ id: 'd'.repeat(16), name: 'design', members: [ME, SARA] }];
  const { v } = await teamView(t, { peer });
  const [bar, threads] = v.panels.teamLists, [, box] = v.panels.teamBoxes, status = () => v.panels.status.getText(), keys = () => v.panels.keys.getText();
  // #general is everyone on the team: me, then who is online, then the rest. Each channel's row counts its people.
  await openRow(v, /# general/, '#general');
  await until(() => inside(v) === 'In #general · you, @sara, @li · /invite adds a teammate', 'who is in #general');
  assert.deepEqual(threadLines(v), ['Nothing in #general yet. Everyone on the team is in it. Type below to write to it.']);
  assert.deepEqual(bar.items.map(item => plainItem(item).trimEnd()).slice(0, 4), ['Channels', '# general  3', '# design  2', '+ Add channel']);
  // The line is no row of the list: the threads start under it, with the cursor on the first.
  assert.equal(threads.atop, box.atop + 2); assert.equal(threads.selected, 0); assertPanes(v, 160);
  // From the threads, m on #general says how someone gets in. The key bar offers m and x for a created channel only.
  threads.focus(); await until(() => /enter read$/.test(keys()), 'no m or x for #general');
  v.input.write('m'); await until(() => /Everyone on the team is in #general\. \+ Add teammate invites someone\./.test(status()), 'm on #general');
  // A created channel lists its own people and names the key that changes them.
  await openRow(v, /# design/, '#design');
  await until(() => inside(v) === 'In #design · you, @sara · m changes who is in it', 'who is in #design');
  assert.deepEqual(threadLines(v), ['Nothing in #design yet. Type below to write to it. m changes who is in it.']);
  await until(() => /enter read {2}m members {2}x leave$/.test(keys()), 'm and x for a created channel');
  // A person has no such line, and their threads start at the top again.
  await openRow(v, /@sara\s+direct/, '@sara');
  await until(() => inside(v) === null && threads.atop === box.atop + 1, 'no line for a person');
  assert.deepEqual(threadLines(v), ['Nothing in @sara yet. Type below to write to it.']);
});

test('m and x on a created channel also work from its threads, and nothing is cut at 80 columns', { timeout: 20000 }, async t => {
  const peer = fakePeer({ items: [] }), id = 'd'.repeat(16); peer.channels = [{ id, name: 'design', members: [ME, SARA] }];
  const { v } = await teamView(t, { peer, columns: 80, rows: 24 });
  const [, threads] = v.panels.teamLists, status = () => v.panels.status.getText(), keys = () => v.panels.keys.getText(), who = 'Who is in #design';
  await openRow(v, /# design/, '#design'); threads.focus();
  await until(() => /enter read {2}m members {2}x leave$/.test(keys()) && inside(v) === 'In #design · you, @sara · m changes who is in it', 'the open channel');
  assert.deepEqual(threadLines(v), ['Nothing in #design yet. Type below to write to it. m changes who is in it.']); assertPanes(v, 80);
  // m ticks @li too, and the line follows.
  v.input.write('m'); await choose(v, who, /\[ \] @li/); await until(() => rowsOf(v, who).includes('[x] @li'), 'ticked'); await choose(v, who, /^Save$/);
  await until(() => peer.sent().at(-1)?.members?.length === 3, 'members saved');
  assert.deepEqual(peer.sent().at(-1), { type: 'channelSet', team: 'team-1', id, name: 'design', members: [ME, SARA, LI] });
  await until(() => inside(v) === 'In #design · you, @sara, @li · m changes who is in it' && /#design now has 2 teammates and you\./.test(status()), 'the line follows');
  // x leaves it, and #general is open instead. Its sentences break between them when they do not fit one row.
  threads.focus(); v.input.write('x'); await closeDialog(v, 'Leave #design', 'y');
  await until(() => peer.sent().at(-1).members?.length === 2 && /Left #design\./.test(status()), 'left');
  assert.deepEqual(peer.sent().at(-1), { type: 'channelSet', team: 'team-1', id, name: 'design', members: [SARA, LI] });
  await until(() => inside(v) === 'In #general · you, @sara, @li · /invite adds a teammate', '#general is open');
  assert.deepEqual(threadLines(v), ['Nothing in #general yet. Everyone on the team is in it.', 'Type below to write to it.']); assertPanes(v, 80);
  // #general has nobody to change and cannot be left.
  threads.focus(); await until(() => /enter read$/.test(keys()), 'no m or x for #general');
  v.input.write('m'); await until(() => /Everyone on the team is in #general\. \+ Add teammate invites someone\./.test(status()), 'm on #general');
  const sent = peer.sent().length; v.input.write('x'); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(peer.sent().length, sent); assert.equal(modal(v, 'Leave #general'), undefined, 'x does nothing on #general');
});

test('/invite offers the teammates not in the open channel, and Tab then Enter, or Enter on one, adds them', { timeout: 20000 }, async t => {
  // A third teammate whose name has a capital and a space: the screen shows them as @OmarK.
  const OMAR = 'e'.repeat(64), id = 'd'.repeat(16); let refused = true;
  const peer = fakePeer({ items: [], refuse: command => refused && command.type === 'channelSet' ? 'Only a channel member can change it.' : null }), base = peer.peerStatus;
  peer.peerStatus = () => { const value = base(); value.teams[0].members.push({ key: OMAR, fingerprint: 'eeeeeeee', name: 'Omar K', role: 'member', online: false, path: null, lastSeen: ago(5) }); return value; };
  peer.channels = [{ id, name: 'design', members: [ME, SARA] }];
  const { v } = await teamView(t, { peer });
  const ask = v.panels.ask, palette = v.panels.palette, status = () => v.panels.status.getText(), sets = () => peer.sent().filter(row => row.type === 'channelSet');
  const rows = () => palette.hidden ? [] : palette.items.map(item => item.getText().trim().replace(/\s{2,}/g, ' | '));
  const type = async text => { ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box'); ask.clearValue(); v.input.write(text); };
  await openRow(v, /# design/, '#design');
  await until(() => inside(v) === 'In #design · you, @sara · m changes who is in it', 'who is in #design');
  // Only the people who can join: not me, not @sara who is in it, and no bot.
  await type('/invite '); await until(() => rows().length === 2, 'the teammates not in #design');
  assert.deepEqual(rows(), ['@li | add to #design · offline', '@OmarK | add to #design · offline']);
  // A refusal of the change is shown as it is, and nothing changes.
  v.input.write('o'); await until(() => rows().join() === '@OmarK | add to #design · offline', 'narrowed as typed, whatever the case');
  v.input.write('\t'); await until(() => ask.getValue() === '/invite @OmarK ' && palette.hidden, 'Tab fills in the name');
  v.input.write('\r'); await until(() => /Only a channel member can change it\./.test(status()), 'the refusal');
  assert.equal(inside(v), 'In #design · you, @sara · m changes who is in it'); assert.equal(ask.getValue().trim(), '/invite @OmarK', 'what was typed is kept');
  // The same change m saves: everyone who was in it, and the one more.
  refused = false; await send(v, '/invite @OmarK'); await until(() => /Added @OmarK to #design\./.test(status()), 'added');
  assert.deepEqual(sets().at(-1), { type: 'channelSet', team: 'team-1', id, name: 'design', members: [ME, SARA, OMAR] });
  await until(() => inside(v) === 'In #design · you, @sara, @OmarK · m changes who is in it', 'the line names them');
  // Enter on a name in the list adds that teammate.
  await type('/invite l'); await until(() => rows().join() === '@li | add to #design · offline', 'the one left');
  v.input.write('\r'); await until(() => /Added @li to #design\./.test(status()), 'added from the list');
  assert.deepEqual(sets().at(-1), { type: 'channelSet', team: 'team-1', id, name: 'design', members: [ME, SARA, OMAR, LI] });
  // With everyone in it the list offers nobody, and a name says so.
  const saved = sets().length; await type('/invite '); await new Promise(resolve => setTimeout(resolve, 100)); assert.deepEqual(rows(), []);
  await send(v, '/invite @li'); await until(() => /@li is already in #design\./.test(status()), 'already in it');
  await send(v, '/invite @bob'); await until(() => /Everyone is in #design already\. \/invite alone makes a code for someone new\./.test(status()), 'nobody left to add');
  assert.equal(sets().length, saved);
});

test('/invite with a name says in one line why there is nobody to add, and plain /invite still makes a code', { timeout: 20000 }, async t => {
  const id = 'd'.repeat(16), peer = fakePeer({ items: [] }), title = 'Bots your teammates can use'; peer.channels = [{ id, name: 'design', members: [ME, SARA] }];
  const { v } = await teamView(t, { peer }), status = () => v.panels.status.getText(), sets = () => peer.sent().filter(row => row.type === 'channelSet');
  const invites = () => peer.calls.filter(row => row[0] === 'createInvite');
  const says = async (text, line) => { await send(v, text); await until(() => status().includes(line), line); assert.equal(v.panels.ask.getValue(), text, 'what was typed is kept'); };
  // #general holds everyone, a direct message is two people, and a bot's chat has no members.
  await openRow(v, /# general/, '#general'); await says('/invite @li', 'Everyone is in #general already. /invite alone makes a code for someone new.');
  await openRow(v, /@sara\s+direct/, '@sara'); await says('/invite @li', 'A direct message is just the two of you. Open a channel to add a teammate.');
  await openRow(v, /@reviewer/, '@reviewer'); await says('/invite @li', 'A bot’s chat has no members. Open a channel to add a teammate.');
  // In a channel: a name nobody has, with who can still be added, and someone who is in it.
  await openRow(v, /# design/, '#design');
  await says('/invite @bob', 'No teammate @bob to add to #design. Not in it yet: @li.'); await says('/invite @sara', '@sara is already in #design.');
  assert.deepEqual(sets(), []); assert.deepEqual(invites(), []);
  // The name works without its @ and in any case.
  await send(v, '/invite LI'); await until(() => /Added @li to #design\./.test(status()), 'a bare name');
  assert.deepEqual(sets(), [{ type: 'channelSet', team: 'team-1', id, name: 'design', members: [ME, SARA, LI] }]);
  // Plain /invite makes the one-use code, and so does a team's name: neither changes a channel.
  await send(v, '/invite'); await choose(v, title, /^Done$/); await until(() => modal(v, 'Team invite'), 'the invite');
  assert.match(modal(v, 'Team invite').children.find(child => child.options?.scrollable).getText(), /^elu-team:v1:TESTCODE\n\nOne use, expires in 24 h\./);
  await closeDialog(v, 'Team invite'); assert.deepEqual(invites(), [['createInvite', 'team-1', { hours: 24 }]]);
  await send(v, '/invite Core'); await choose(v, title, /^Done$/); await until(() => modal(v, 'Team invite'), 'the invite for a named team');
  await closeDialog(v, 'Team invite'); assert.equal(invites().length, 2); assert.equal(sets().length, 1);
  // Outside Chats there is no open channel.
  await send(v, '/sessions'); await until(() => v.current.view === 'tasks', 'Sessions');
  await says('/invite @sara', 'Open a channel in Chats first: /invite @name adds a teammate to it.'); assert.equal(sets().length, 1);
});

test('/invite offers someone on two teams once, and with no teammates it points at plain /invite', { timeout: 20000 }, async t => {
  const id = 'd'.repeat(16), peer = fakePeer({ items: [] }), base = peer.peerStatus; let alone = false;
  // Everyone is on a second team too. The channel belongs to the first.
  peer.peerStatus = () => {
    const value = base(), [team] = value.teams;
    if (alone) team.members = team.members.filter(member => member.key === ME); else value.teams.push({ ...team, id: 'team-2', name: 'Docs', channels: [] });
    return value;
  };
  peer.channels = [{ id, name: 'design', members: [ME, SARA] }];
  const { v } = await teamView(t, { peer }), [bar] = v.panels.teamLists, ask = v.panels.ask, palette = v.panels.palette, status = () => v.panels.status.getText();
  const rows = () => palette.hidden ? [] : palette.items.map(item => item.getText().split(/\s+/)[0]);
  await until(() => bar.items.some(item => /# design/.test(plainItem(item))), 'the channel');
  selectRow(bar, /# design/); await until(() => /Message #design/.test(ask._label.getText()), 'the channel is open');
  ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box'); ask.clearValue(); v.input.write('/invite ');
  await until(() => rows().length > 0, 'the teammates not in #design'); assert.deepEqual(rows(), ['@li']);
  // A team of one has nobody to add anywhere.
  alone = true; await send(v, '/invite @li');
  await until(() => /No teammates yet\. \/invite alone makes a code for someone new\./.test(status()), 'no teammates yet');
  assert.ok(!peer.sent().some(row => row.type === 'channelSet'));
});

test('a teammate’s shared bot is in Direct messages with its machine name, and writing to it asks that bot', async t => {
  const { v, peer } = await teamView(t, { peer: fakePeer({ remoteBots: [{ name: 'reviewer', about: 'Reviews code' }] }) });
  const status = () => v.panels.status.getText();
  await openRow(v, /◆ @reviewer · sara-box/, '@reviewer · sara-box');
  await until(() => /Message @reviewer on sara-box · runs after @sara accepts it/.test(v.panels.ask._label.getText()), 'the box names the bot and where it runs');
  await send(v, 'review my branch');
  await until(() => peer.sent().at(-1)?.bot === 'reviewer', 'the bot was asked');
  assert.deepEqual(peer.sent().at(-1), { type: 'ask', to: SARA, bot: 'reviewer', project: null, text: 'review my branch' });
  await until(() => /Sent to @reviewer on sara-box\. It runs after @sara accepts it\./.test(status()) && v.panels.ask.getValue() === '', 'sent');
  // The teammate herself is still one row up, and a message there goes to her, with no bot.
  await openRow(v, /@sara\s+direct/, '@sara'); await send(v, 'are you free?');
  await until(() => peer.sent().at(-1).text === 'are you free?', 'a plain message');
  assert.deepEqual(peer.sent().at(-1), { type: 'ask', to: SARA, project: null, text: 'are you free?' });
});

test('my own bot is in Direct messages, and writing to it starts a session with it in the active project', async t => {
  const p = project(later(t)); environment(t, p.parent);
  saveBot({ name: 'helper', vendor: 'claude', instructions: 'Answer briefly.' });
  const peer = fakePeer(), v = await view(t, { repo: repository(p.root), peer, team: true });
  await until(() => v.current.view === 'chats', 'Chats');
  await openRow(v, /◆ @helper\s*$/, '@helper');
  await until(() => /Message @helper · it answers in its own session/.test(v.panels.ask._label.getText()), 'the box names my bot');
  await send(v, 'what does this repo do?');
  await until(() => /@helper answers in a new session\. It is in Sessions\./.test(v.panels.status.getText()), 'started');
  assert.deepEqual(pendingRequests(p.root).map(row => [row.goal, row.bot]), [['what does this repo do?', 'helper']]);
  assert.deepEqual(peer.sent(), [], 'nothing went to a teammate');
});

test('/invite and /join ask which bots teammates may use', async t => {
  const { v } = await teamView(t), title = 'Bots your teammates can use', status = () => v.panels.status.getText(), shared = () => listBots().map(bot => [bot.name, bot.shared]);
  const invite = () => modal(v, 'Team invite').children.find(child => child.options?.scrollable).getText();
  // A new home has the bots the app comes with, none of them shared: the question lists them, and Done with none ticked shares none.
  // @pair is not offered: it runs on Codex, and a teammate's question cannot run there.
  await send(v, '/invite');
  await until(() => rowsOf(v, title).includes('Done'), 'the bots the app comes with');
  assert.deepEqual(rowsOf(v, title), ['[ ] @reviewer', '[ ] @lead', '[ ] @qa', '[ ] @elu', 'Done']);
  await choose(v, title, /^Done$/); await until(() => modal(v, 'Team invite'), 'the invite');
  assert.match(invite(), /No bot is shared, so a teammate’s message comes to you\./); assert.ok(shared().every(([, on]) => !on), 'none shared');
  await closeDialog(v, 'Team invite');
  // With no bots the question is not asked: a teammate's message comes to me, as before.
  for (const bot of listBots()) removeBot(bot.name);
  await send(v, '/invite'); await until(() => modal(v, 'Team invite'), 'the invite, with no question'); assert.equal(modal(v, title), undefined);
  assert.ok(!/bot/i.test(invite()), 'the invite says nothing about bots'); await closeDialog(v, 'Team invite');
  saveBot({ name: 'notes', vendor: 'claude', instructions: 'Keep notes.' }); saveBot({ name: 'docs', vendor: 'claude', instructions: 'Write docs.', shared: true });
  await send(v, '/invite');
  await until(() => rowsOf(v, title).length === 3, 'the bots list');
  assert.deepEqual(rowsOf(v, title), ['[x] @docs', '[ ] @notes', 'Done']);
  await choose(v, title, /\[ \] @notes/); await until(() => rowsOf(v, title).includes('[x] @notes'), 'ticked'); await choose(v, title, /^Done$/);
  await until(() => modal(v, 'Team invite'), 'the invite');
  assert.match(invite(), /Teammates can write to @docs, @notes\./);
  assert.deepEqual(shared(), [['docs', true], ['notes', true]]);
  await closeDialog(v, 'Team invite');
  // Joining asks the same. With none ticked, every message comes to me.
  await send(v, '/join elu-team:v1:TESTCODE');
  await choose(v, title, /\[x\] @docs/); await until(() => rowsOf(v, title).includes('[ ] @docs'), 'unticked');
  await choose(v, title, /\[x\] @notes/); await until(() => rowsOf(v, title).includes('[ ] @notes'), 'unticked'); await choose(v, title, /^Done$/);
  await until(() => /Joined Docs\..*No bot is shared, so a teammate’s message comes to you\./.test(status()), 'joined');
  assert.deepEqual(shared(), [['docs', false], ['notes', false]]);
});

test('a thread shows under its channel, #general or its teammate, and a row counts what waits for me', () => {
  const core = { id: 'team-1', name: 'Core', members: [{ key: ME, name: 'ana' }, { key: SARA, name: 'sara', online: true }, { key: LI, name: 'li' }], channels: [{ id: 'c1', name: 'design', members: [ME, SARA] }] };
  const status = { key: ME, teams: [core] }, general = roomTarget('team-1', null), design = roomTarget('team-1', 'c1');
  const items = [
    { id: 'a', kind: 'incoming', peer: SARA, name: 'sara', team: true, room: { team: 'team-1', channel: 'c1' }, text: 'Asked in design', at: ago(1) },
    // A teammate on an older build sends no room: a team ask lands in #general.
    { id: 'b', kind: 'incoming', peer: LI, name: 'li', team: true, text: 'Asked by an older build', at: ago(2) },
    { id: 'c', kind: 'asked', peer: null, name: 'team', team: true, room: { team: 'team-1', channel: null }, text: 'Asked of everyone', at: ago(3) },
    { id: 'd', kind: 'held', peer: SARA, name: 'sara', text: 'Said directly', at: ago(4) },
    // Its channel was removed since: the thread is kept, in #general.
    { id: 'e', kind: 'answer', peer: SARA, name: 'sara', team: true, room: { team: 'team-1', channel: 'gone' }, text: 'Answered in a removed channel', at: ago(5) },
    { id: 'f', kind: 'draft', name: 'li', text: 'A draft for li', at: ago(6) },
  ];
  assert.deepEqual(items.map(item => threadTarget(item, status)), [design, general, general, dmTarget(SARA), general, dmTarget(LI)]);
  const lines = rows => rows.map(row => visible(row.line).replace(/\s+/g, ' ').trim());
  assert.deepEqual(lines(chatBar({ status, items }, 60, false)), ['Channels', '# general 3 1', '# design 2 1', '+ Add channel', '', 'Direct messages', '● @sara online 1', '○ @li offline 1', '+ Add teammate']);
  const threads = (target, where) => lines(teamPanes({ status, agents: [], items }, [40, 40, 100], false, target, where)[2]).join('\n');
  assert.match(threads(design, '#design'), /Asked in design/); assert.doesNotMatch(threads(design, '#design'), /directly|everyone|older build/);
  for (const text of ['Asked by an older build', 'Asked of everyone', 'Answered in a removed channel']) assert.ok(threads(general, '#general').includes(text), text);
  assert.match(threads(dmTarget(SARA), '@sara'), /Said directly/); assert.doesNotMatch(threads(dmTarget(SARA), '@sara'), /design|everyone/);
  assert.equal(lines(teamPanes({ status, agents: [], items: [] }, [40, 40, 100], false, design, '#design')[2]).join(), 'Nothing in #design yet. Type below to write to it. m changes who is in it.');
  // On two teams, each #general names its team, and a person on both is listed once.
  const docs = { id: 'team-2', name: 'Docs', members: [{ key: ME, name: 'ana' }, { key: SARA, name: 'sara', online: true }] };
  assert.deepEqual(lines(chatBar({ status: { key: ME, teams: [core, docs] }, items: [] }, 60, false)), ['Channels', '# general · Core 3', '# design · Core 2', '# general · Docs 2', '+ Add channel', '', 'Direct messages', '● @sara online', '○ @li offline', '+ Add teammate']);
  const empty = lines(chatBar({ status: { key: ME, teams: [] }, items: [] }, 40, false));
  assert.ok(empty.every(text => text.length <= 40 && !text.endsWith('…')), empty.join('|'));
  for (const text of ['To invite someone:', '/invite', '!elu team create NAME', '/join']) assert.ok(empty.join(' ').replace(/\s+/g, ' ').includes(text), text);
});

test('a channel lists me first, then who is online, then the rest, and counts the names that do not fit', () => {
  const DEVBOX = 'd'.repeat(64), LAPTOP = 'e'.repeat(64), GONE = 'f'.repeat(64);
  const core = { id: 'team-1', name: 'Core', members: [{ key: LI, name: 'li' }, { key: ME, name: 'ana', online: true }, { key: SARA, name: 'sara', online: true }, { key: LAPTOP, name: 'laptop' }, { key: DEVBOX, name: 'devbox', online: true }],
    // Someone who left the team is still named in the channel: they are not listed or counted.
    channels: [{ id: 'c1', name: 'design', members: [LI, ME, SARA, GONE] }] };
  const status = { key: ME, teams: [core] }, plain = rows => rows.map(row => visible(row.line));
  const room = (state, channel, items = []) => chatBar({ status: state, items }, 60, false).find(row => row.value?.type === 'room' && row.value.channel === channel);
  const general = room(status, null).value, design = room(status, 'c1').value;
  assert.deepEqual(general.people, ['you', '@sara', '@devbox', '@li', '@laptop']); assert.deepEqual(design.people, ['you', '@sara', '@li']);
  // Each person has one colour wherever Chats names them: I am blue, a teammate's is their place among everyone's keys.
  assert.deepEqual(general.tones, ['blue', 'gold', 'lime', 'pink', 'aqua']); assert.deepEqual(design.tones, ['blue', 'gold', 'pink']);
  // The line names who is in the channel, then how someone gets in while there is room for it: /invite for #general, m for a created channel.
  const line = (value, width) => membersLine(value, width, false);
  assert.equal(line(general, 76), 'In #general · you, @sara, @devbox, @li, @laptop · /invite adds a teammate'); assert.equal(line(design, 76), 'In #design · you, @sara, @li · m changes who is in it');
  assert.equal(line(general, 73), 'In #general · you, @sara, @devbox, @li, @laptop · /invite adds a teammate'); assert.equal(line(general, 72), 'In #general · you, @sara, @devbox, @li, @laptop', 'the hint goes first when the line is too narrow');
  // With colours every name is in its person's colour, and the words are the same.
  for (const [at, name] of general.people.entries()) assert.ok(membersLine(general, 76).includes(ink(name, general.tones[at], true)), `${name} in ${general.tones[at]}`);
  // Whole names only: the rest are counted.
  assert.equal(line(general, 42), 'In #general · you, @sara, @devbox, +2 more'); assert.equal(line(general, 41), 'In #general · you, @sara, +3 more'); assert.equal(line(general, 26), 'In #general · you, +4 more');
  for (let width = 8; width <= 80; width++) for (const value of [general, design]) { assert.ok(line(value, width).length <= width, `width ${width}`); assert.equal(visible(membersLine(value, width)), line(value, width), `the same words with colours at ${width}`); }
  // The bar counts the people after the name, before the threads that wait for me.
  assert.equal(visible(room(status, null).line), '# general  5'); assert.equal(visible(room(status, 'c1').line), '# design  3');
  const waits = [{ id: 'a', kind: 'incoming', peer: SARA, name: 'sara', team: true, room: { team: 'team-1', channel: 'c1' }, text: 'Asked in design', at: ago(1) }];
  assert.equal(visible(room(status, 'c1', waits).line), '# design  3  1'); assert.equal(room(status, 'c1', waits).value.waiting, 1);
  assert.equal(visible(chatBar({ status, items: waits }, 60, true).find(row => row.value?.channel === 'c1').line), '# design  3  1', 'the same with colours');
  for (let width = 8; width <= 40; width++) assert.ok(chatBar({ status, items: waits }, width, false).every(row => visible(row.line).length <= width), `bar width ${width}`);
  // An empty channel says who is in it and how that changes. At 80 columns a pane holds 76: sentences break between them.
  const empty = (state, target, where, width) => plain(teamPanes({ status: state, agents: [], items: [] }, [40, 40, width], false, target, where)[2]);
  assert.deepEqual(empty(status, general.target, '#general', 100), ['Nothing in #general yet. Everyone on the team is in it. Type below to write to it.']);
  assert.deepEqual(empty(status, general.target, '#general', 76), ['Nothing in #general yet. Everyone on the team is in it.', 'Type below to write to it.']);
  assert.deepEqual(empty(status, design.target, '#design', 76), ['Nothing in #design yet. Type below to write to it. m changes who is in it.']);
  assert.deepEqual(empty(status, dmTarget(SARA), '@sara', 76), ['Nothing in @sara yet. Type below to write to it.']);
  // Alone on the team: only me, and the way to add someone.
  const alone = { key: ME, teams: [{ id: 'team-1', name: 'Core', members: [{ key: ME, name: 'ana', online: true }], channels: [] }] }, mine = room(alone, null);
  assert.equal(visible(mine.line), '# general  1'); assert.equal(line(mine.value, 76), 'In #general · you · /invite adds a teammate'); assert.equal(line(mine.value, 20), 'In #general · you');
  assert.deepEqual(empty(alone, mine.value.target, '#general', 100), ['Nothing in #general yet. Nobody else is on the team yet. + Add teammate invites someone.']);
  assert.deepEqual(empty(alone, mine.value.target, '#general', 76), ['Nothing in #general yet. Nobody else is on the team yet.', '+ Add teammate invites someone.']);
});

test('Direct messages lists my bots and each teammate’s shared bots with the machine that runs them', () => {
  const team = { id: 'team-1', name: 'Core', members: [{ key: ME, name: 'ana' },
    { key: SARA, name: 'sara', online: true, box: 'sara-box', bots: [{ name: 'reviewer', about: 'Reviews code' }, { name: 'Not A Name', about: 'dropped' }] },
    // An older build sends no machine name: the teammate's name stands in.
    { key: LI, name: 'li', bots: [{ name: 'docs', about: 'Writes docs' }] }] };
  const status = { key: ME, teams: [team] }, mine = [{ name: 'reviewer', about: 'My reviewer' }], lines = rows => rows.map(row => visible(row.line).replace(/\s+/g, ' ').trim());
  const bar = chatBar({ status, items: [], bots: mine }, 60, false);
  assert.deepEqual(lines(bar).slice(4), ['Direct messages', '● @sara online', '○ @li offline', '◆ @reviewer', '◆ @reviewer · sara-box', '◆ @docs · @li', '+ Add teammate']);
  const values = bar.filter(row => row.value?.type === 'bot').map(row => row.value);
  assert.deepEqual(values.map(value => [value.target, value.peer, value.box, value.about, value.online]), [[botTarget(null, 'reviewer'), null, null, 'My reviewer', true], [botTarget(SARA, 'reviewer'), SARA, 'sara-box', 'Reviews code', true], [botTarget(LI, 'docs'), LI, null, 'Writes docs', false]]);
  // What I asked a teammate's bot lists under that bot. A teammate's request to my bot lists under them, and waits for me.
  const items = [
    { id: 'a', kind: 'asked', peer: SARA, name: 'sara', bot: 'reviewer', text: 'Review my branch', at: ago(1) },
    { id: 'b', kind: 'answer', peer: SARA, name: 'sara', bot: 'reviewer', question: 'Review my branch', text: 'Two problems.', at: ago(2) },
    { id: 'c', kind: 'incoming', peer: SARA, name: 'sara', bot: 'reviewer', text: 'Check this diff', at: ago(3) },
    // She stopped sharing it: the thread stays, under her.
    { id: 'd', kind: 'asked', peer: SARA, name: 'sara', bot: 'planner', text: 'Plan the week', at: ago(4) },
  ];
  assert.deepEqual(items.map(item => threadTarget(item, status)), [botTarget(SARA, 'reviewer'), botTarget(SARA, 'reviewer'), dmTarget(SARA), dmTarget(SARA)]);
  const threads = target => lines(teamPanes({ status, agents: [], items, bots: mine }, [40, 40, 100], false, target, '@x')[2]);
  assert.deepEqual(threads(botTarget(SARA, 'reviewer')), ['→ you asked @reviewer (@sara) · Review my branch', '↳ sent', '→ you asked @reviewer (@sara) · Review my branch', '↳ @reviewer answered · Two problems.']);
  assert.deepEqual(threads(dmTarget(SARA)), ['← @sara asks your bot @reviewer · Check this diff', '→ you asked @planner (@sara) · Plan the week', '↳ sent']);
  assert.match(lines(chatBar({ status, items, bots: mine }, 60, false))[5], /^● @sara online 1$/);
});

test('a typed @name and the peer commands call the facade and report in the status line', async t => {
  const { v, peer } = await teamView(t);
  const status = () => v.panels.status.getText();
  await until(() => v.panels.teamLists[0].items.length, 'teammates');
  await send(v, '@sara web How do we deploy?');
  await until(() => peer.sent().some(row => row.type === 'ask'), 'ask');
  assert.deepEqual(peer.sent().at(-1), { type: 'ask', to: 'sara', project: 'web', text: 'How do we deploy?' });
  await until(() => /Sent to @sara\./.test(status()), 'ask message after the daemon answers');
  await send(v, "@li what's the cache key?");
  await until(() => peer.sent().at(-1).to === 'li', 'free text ask');
  assert.deepEqual(peer.sent().at(-1), { type: 'ask', to: 'li', project: null, text: "what's the cache key?" });
  await send(v, '/peers'); await until(() => /1 of 2 teammates online: @sara \(direct\)/.test(status()), 'peers');
  for (const gone of ['/ask @sara hello', '/handoff @li Fix the flaky upload test', '/review @sara']) { await send(v, gone); await until(() => status().includes(`Unknown command: ${gone.split(' ')[0]}.`), `${gone} is unknown`); }
  assert.ok(!peer.sent().some(row => ['handoff', 'review'].includes(row.type)), 'nothing sends a handoff or a review');
  await send(v, '/share'); await until(() => /Open a project to share it/.test(status()), 'share needs a project');
  // A home has the bots the app comes with, so /invite first asks which of them teammates may use.
  await send(v, '/invite'); await choose(v, 'Bots your teammates can use', /^Done$/);
  await until(() => modal(v, 'Team invite'), 'invite code');
  assert.deepEqual(peer.calls.find(row => row[0] === 'createInvite').slice(1), ['team-1', { hours: 24 }]);
  assert.match(modal(v, 'Team invite').children.find(child => child.options?.scrollable).getText(), /elu-team:v1:TESTCODE[^]*Type \/share in a project so teammates can ask about it\./);
  await closeDialog(v, 'Team invite');
  assert.ok(!peer.calls.some(row => row[0] === 'share'), 'no project open, nothing shared');
  await send(v, '/peer off'); await until(() => peer.calls.some(row => row[0] === 'stopPeer'), 'peer off');
  await until(() => /Peer mode is off/.test(status()), 'peer off message');
  await send(v, '/peer on'); await until(() => peer.calls.some(row => row[0] === 'startPeer'), 'peer on');
  assert.equal(peer.sent().length, 2, 'only the two questions went out; refused and unknown commands send nothing');
});

test('/peer on with no identity asks for your name and creates it, no CLI step needed', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ enabled: false }); let me = null;
  peer.identity = ({ create, name } = {}) => { if (create) { peer.calls.push(['identity', name]); me = { name }; return me; } if (!me) throw new Error('Create your peer identity first with elu id --name NAME.'); return me; };
  const v = await view(t, { repo: repository(p.root), peer });
  await send(v, '/peer on'); await until(() => modal(v, 'Your name'), 'name prompt');
  const field = modal(v, 'Your name').children.find(child => child.type === 'textbox');
  await until(() => field.__listener, 'name input'); field.setValue('ana'); field.submit();
  await until(() => peer.calls.some(row => row[0] === 'startPeer'), 'peer on after the name');
  assert.deepEqual(peer.calls.find(row => row[0] === 'identity'), ['identity', 'ana']);
  assert.ok(peer.calls.findIndex(row => row[0] === 'identity') < peer.calls.findIndex(row => row[0] === 'startPeer'));
});

test('Enter in the command list runs /peer, fills in /join, and shows a failed command\'s error', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ enabled: false }), v = await view(t, { repo: repository(p.root), peer });
  const status = () => v.panels.status.getText(), palette = v.panels.palette;
  const type = async text => { v.panels.ask.focus(); v.panels.ask.readInput(); await until(() => v.panels.ask.__listener, 'message box'); v.panels.ask.clearValue(); v.input.write(text); await until(() => !palette.hidden, `list for ${text}`); };
  await type('/peer'); v.input.write('\r');
  await until(() => peer.calls.some(row => row[0] === 'startPeer'), 'a bare /peer turns peer mode on');
  await until(() => /Peer mode is on/.test(status()), 'on message');
  peer.enabled = true; await type('/peer'); v.input.write('\r');
  await until(() => peer.calls.some(row => row[0] === 'stopPeer'), 'a bare /peer turns it off again');
  await type('/joi'); v.input.write('\r');
  await until(() => v.panels.ask.getValue() === '/join ' && /Usage: \/join code/.test(status()), '/join needs a code, so Enter fills it in');
  assert.equal(peer.sent().length, 0);
  await type('/chan'); v.input.write('\r');
  await until(() => /Open a session first/.test(status()) && palette.hidden, 'the error shows and the list stays closed');
  assert.equal(v.panels.ask.getValue(), '/changes', 'the command is kept');
});

test('share, invite and join use the open project', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer(), v = await view(t, { repo: repository(p.root), peer });
  await send(v, '/share web');
  await until(() => peer.calls.some(row => row[0] === 'share'), 'share');
  assert.deepEqual(peer.calls.find(row => row[0] === 'share').slice(1), [p.root, { handle: 'web', status: true }]);
  await until(() => /Shared \S*sample app with your team as web/.test(v.panels.status.getText()), 'share message');
  await send(v, '/share ../x'); await until(() => /Use \/share \[handle\]/.test(v.panels.status.getText()), 'bad handle');
  // Adding a teammate picks this project for the team: the inviter's and the joiner's. Both are first asked which bots teammates may use.
  const bots = 'Bots your teammates can use';
  await send(v, '/invite'); await choose(v, bots, /^Done$/);
  await until(() => modal(v, 'Team invite'), 'invite');
  assert.deepEqual(peer.calls.filter(row => row[0] === 'share').at(-1).slice(1), [p.root, { teams: ['team-1'] }]);
  assert.match(modal(v, 'Team invite').children.find(child => child.options?.scrollable).getText(), /Teammates can ask about sample, the folder \S[^]*sample app\.[^]*types \/join and this code in the project you can ask about/);
  await closeDialog(v, 'Team invite');
  await send(v, '/join nope'); await until(() => /Use \/join code/.test(v.panels.status.getText()), 'join usage');
  await send(v, '/join elu-team:v1:TESTCODE'); await choose(v, bots, /^Done$/);
  await until(() => /Joined Docs\. Teammates can ask about sample, the folder \S[^]*sample app\. No bot is shared, so a teammate’s message comes to you\./.test(v.panels.status.getText()), 'joined');
  assert.deepEqual(peer.calls.find(row => row[0] === 'joinTeam').slice(1), ['elu-team:v1:TESTCODE']);
  assert.deepEqual(peer.calls.filter(row => row[0] === 'share').at(-1).slice(1), [p.root, { teams: ['team-2'] }]);
});

test('Chats shows one line when peer mode is off or the facade is missing', async t => {
  for (const peer of [fakePeer({ enabled: false }), null]) {
    await t.test(peer ? 'off' : 'missing', async t => {
      const { v } = await teamView(t, { peer, columns: 80, rows: 24 });
      await until(() => v.text().includes(peer ? 'Peer mode is off. Type /peer on to start it.' : 'Peer mode needs the optional networking packages'), 'off line');
      assert.ok(v.panels.teamBoxes.every(pane => pane.hidden));
      if (peer) assert.equal(peer.calls.length, 0, 'no peer reads while off');
      await send(v, '@sara hello');
      await until(() => /Peer mode (is off|needs the optional)/.test(v.panels.status.getText()), 'a message to a teammate is refused');
    });
  }
});

test('Tasks shows peer work that waits for you first, and y / n decide it', { timeout: 20000 }, async t => {
  const p = project(later(t)); environment(t, p.parent); registerProject(repository(p.root));
  const origin = (kind, id) => ({ kind, peer: SARA, name: 'sara', a2aTaskId: id, threadId: 'th', hop: 1 });
  const ask = saveRequest(p.root, 'Answer the question from @sara (shown in the peer data block) using this repository. Do not edit files.', undefined, { state: 'waiting', origin: origin('ask', 'task-ask'), readOnly: true, context: 'How do we rotate keys?' });
  const handoff = saveRequest(p.root, 'Work on the handoff from @sara shown in the peer data block', undefined, { state: 'waiting', origin: origin('handoff', 'task-handoff'), context: 'Split the upload worker' });
  const peer = fakePeer({ items: [
    { id: 'task-ask', kind: 'incoming', peer: SARA, name: 'sara', root: p.root, requestId: ask.id, text: 'How do we rotate keys?', at: ago(1) },
    { id: 'held-1', kind: 'held', peer: SARA, name: 'sara', text: 'Rotate with bin/rotate.', at: ago(2) },
    { id: 'draft-1', kind: 'draft', peer: LI, name: 'li', text: 'Which schema?', at: ago(3) },
    { id: 'answer-1', kind: 'answer', peer: SARA, name: 'sara', text: 'Use v2.', at: ago(4) },
  ] });
  const v = await view(t, { dashboard: true, peer });
  const board = v.panels.board, rows = () => board.items.map(plainItem);
  await until(() => rows().length >= 7, 'board rows');
  // + New session, then the Needs you heading and its four rows; each says who does what. A question and a task are the same message.
  assert.match(rows()[0], /\+ New session/); assert.match(rows()[2], /^ NEEDS YOU 4 ─+/);
  assert.deepEqual(rows().slice(3, 7).map(row => row.match(/ask @li\?|reply to @sara|@sara task|@sara question/)?.[0]).sort(), ['@sara question', '@sara task', 'ask @li?', 'reply to @sara']);
  // The list has room for the start of the message, cut at a word, with its age at the right edge. The whole of it shows beside the list when its row is selected.
  assert.match(rows().find(row => row.includes('@sara question')), /^ \? @sara question · How do we…\s+now$/);
  // An answer waits for nothing, so it stays in Chats.
  assert.ok(!rows().some(row => /answered/.test(row))); assert.match(v.panels.pills.getText(), /● 1 online/);
  assert.ok(v.lines().every(line => line.length <= 160));
  board.focus(); selectRow(board, /reply to @sara/); await until(() => /y send {2}n discard/.test(v.panels.keys.getText()), 'reply row hint');
  selectRow(board, /@sara question/); await until(() => /y accept {2}n decline/.test(v.panels.keys.getText()), 'question row hint');
  await until(() => /^\? @sara question · sample app\n┃ Question · How do we rotate keys\?\n\ny accept · n decline · enter open$/.test(v.panels.chat.getText()), 'the question beside the list');
  assert.equal(v.current.session, null, 'a teammate’s message is not a session of yours'); assert.equal(v.current.screen.focused, board);
  v.input.write('y'); await until(() => modal(v, 'Accept'), 'accept picker'); v.input.write('\r');
  // y accepts: the daemon queues the run in the picked mode, which the board then shows as a session.
  await until(() => peer.sent().some(row => row.type === 'work' && row.id === 'task-ask' && row.permissions === 'ask'), 'ask accepted');
  assert.match(v.panels.status.getText(), /Accepted @sara\. It runs as your session; the reply goes back to this thread\./);
  updateRequest(p.root, ask.id, { state: 'queued' });
  await until(() => !rows().some(row => row.includes('@sara question')), 'accepted row leaves group 0');
  selectRow(board, /@sara task/); v.input.write('n');
  await until(() => !pendingRequests(p.root).some(row => row.id === handoff.id), 'handoff declined');
  assert.deepEqual(peer.sent().at(-1), { type: 'discard', id: 'task-handoff' });
  selectRow(board, /reply to @sara/); v.input.write('y');
  await until(() => peer.sent().some(row => row.type === 'approve' && row.id === 'held-1'), 'reply approved');
  selectRow(board, /ask @li\?/); v.input.write('n');
  await until(() => peer.sent().some(row => row.type === 'discard' && row.id === 'draft-1'), 'draft discarded');
});

test('an idle Chats view reads peer files at most once per draw and does not render', async t => {
  const { v, peer } = await teamView(t);
  await until(() => v.panels.teamLists[1].items.length > 1, 'chats panes');
  await new Promise(resolve => setTimeout(resolve, 200));
  const writes = v.writes, renders = v.renders, reads = () => peer.calls.filter(row => row[0] === 'peerItems').length, before = reads();
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(v.renders > renders + 3, 'the timer keeps drawing');
  assert.equal(v.writes, writes, 'no output while nothing changed');
  assert.ok(reads() - before <= v.renders - renders, 'one read per draw at most');
});

test('team pane lines never exceed their widths', () => {
  const panes = teamPanes({ status: { key: ME, teams: [{ id: 't', name: 'Core', members: [{ key: SARA, name: 'x'.repeat(300), online: true, path: 'relayed' }] }] }, agents: [{ peer: SARA, name: 'sara', rows: [{ handle: 'web', taskId: '1', label: 'editing', now: LONG, overlap: ['a/b.js', 'c.js'] }] }], items: [{ id: '1', kind: 'held', name: 'sara', text: LONG }] }, [20, 30, 40], false);
  assert.equal(panes.length, 3);
  panes.forEach((rows, index) => rows.forEach(row => assert.ok(row.line.replace(/\{[^}]+\}/g, '').length <= [20, 30, 40][index], row.line)));
});

test('a message to a teammate waits for the daemon and shows its refusal', async t => {
  const peer = fakePeer({ refuse: command => command.to === 'SaraKhan' ? 'No teammate is named @SaraKhan.' : null });
  const { v } = await teamView(t, { peer });
  const status = () => v.panels.status.getText();
  await send(v, '@SaraKhan where is it?');
  await until(() => /No teammate is named @SaraKhan/.test(status()), 'daemon refusal');
  assert.doesNotMatch(status(), /Sent to/);
  assert.ok(peer.calls.some(row => row[0] === 'awaitCommand'));
  await send(v, '@li api Where are the fixtures?');
  await until(() => /Sent to @li\./.test(status()), 'ask with a handle from the hello');
  assert.deepEqual(peer.sent().at(-1), { type: 'ask', to: 'li', project: 'api', text: 'Where are the fixtures?' });
  await send(v, `@${'c'.repeat(64)} hi`);
  await until(() => peer.sent().at(-1).to === 'c'.repeat(64), 'a key works as the address');
  const threads = v.panels.teamLists[1]; threads.focus(); selectRow(threads, /answered/); v.input.write('n');
  await until(() => peer.sent().some(row => row.type === 'discard' && row.id === 'answer-1'), 'n dismisses an answer');
  await until(() => /Dismissed/.test(status()), 'dismissed message');
});

test('with the daemon stopped, a message to a teammate is refused and the header says so', async t => {
  const peer = fakePeer({ running: false });
  const { v } = await teamView(t, { peer });
  await until(() => /○ peers stopped/.test(v.panels.pills.getText()), 'stopped summary');
  // Peer mode is on, so the view starts the daemon again, once a minute at most.
  await until(() => peer.calls.some(row => row[0] === 'startPeer'), 'restart');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(peer.calls.filter(row => row[0] === 'startPeer').length, 1);
  await send(v, '@sara hello');
  await until(() => /The peer daemon is not running/.test(v.panels.status.getText()), 'refused');
  assert.equal(peer.sent().length, 0);
});

test('typing @ in Chats offers teammates by name', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const v = await view(t, { repo: repository(p.root), peer: fakePeer(), team: true });
  await until(() => v.current.view === 'chats', 'Chats');
  const ask = v.panels.ask, palette = v.panels.palette, rows = () => palette.hidden ? [] : palette.items.map(item => item.getText().split(/\s+/)[0]);
  ask.focus(); ask.readInput(); await until(() => ask.__listener, 'input');
  v.input.write('@'); await until(() => rows().join() === '@sara,@li', 'teammates, online first, without you');
  v.input.write('l'); await until(() => rows().join() === '@li', 'filtered as typed');
  v.input.write('\r'); await until(() => ask.getValue() === '@li ' && palette.hidden, 'Enter fills in the name');
  ask.clearValue(); v.input.write('@s'); await until(() => rows().join() === '@sara', 'offered again for another name');
  v.input.write('\t'); await until(() => ask.getValue() === '@sara ', 'Tab fills in the name');
  assert.equal(v.panels.ask._label.getText().trim().length > 0, true);
});

test('elu team inside a repository opens Chats with the project still open', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const v = await view(t, { repo: repository(p.root), peer: fakePeer(), team: true });
  await until(() => v.current.view === 'chats', 'Chats');
  await send(v, '/new');
  await until(() => v.panels.header.getText().includes('sample app') && !v.panels.compose.hidden, 'the project is still open');
});

test('a question I took stays in its thread: answering, my reply, or a failed run', () => {
  const at = ago(1), items = [
    { id: 'answering:1', kind: 'answering', peer: SARA, name: 'sara', text: 'Where is the cache?', at },
    { id: 'replied:2', kind: 'replied', peer: LI, name: 'li', question: 'Where is it?', text: 'In src/cache.js.', at: ago(2) },
    { id: 'failed:3', kind: 'failed', peer: SARA, name: 'sara', text: 'Which port?', at: ago(3), team: true },
  ];
  const lines = teamPanes({ status: { key: ME, teams: [] }, agents: [], items }, [60, 60, 120], false)[2].map(row => visible(row.line));
  // Each message, with my side indented under it.
  const text = lines.join('\n');
  assert.match(text, /← @sara asks you · Where is the cache\?\n {3}↳ your model is answering…/);
  assert.match(text, /← @li asks you · Where is it\?\n {3}↳ you replied · In src\/cache\.js\./);
  assert.match(text, /← @sara asks the team · Which port\?\n {3}↳ your model could not answer/);
});

test('my question shows the answer, rejection or wait under it', () => {
  const at = ago(1), items = [
    { id: 'answer:1', kind: 'answer', peer: SARA, name: 'sara', question: 'Where is the cache?', text: 'In src/cache.js.', at },
    { id: 'asked:2', kind: 'asked', peer: LI, name: 'li', text: 'Which port?', state: 'working', at: ago(2) },
    { id: 'team:3', kind: 'rejected', peer: null, name: 'team', team: true, question: 'Who owns CI?', text: 'The owner declined this request.', at: ago(3) },
  ];
  const text = teamPanes({ status: { key: ME, teams: [] }, agents: [], items }, [60, 60, 120], false)[2].map(row => visible(row.line)).join('\n');
  assert.match(text, /→ you asked @sara · Where is the cache\?\n {3}↳ @sara answered · In src\/cache\.js\./);
  assert.match(text, /→ you asked @li · Which port\?\n {3}↳ working/);
  assert.match(text, /→ you asked your team · Who owns CI\?\n {3}↳ rejected · The owner declined this request\./);
});

// --- Kanban: teammates' Tasks ---
const teamTask = (extra = {}) => ({ repoId: 'e'.repeat(64), handle: 'web', id: 't-0a1b2c3d', revision: 2, title: 'Fix the login redirect', description: 'After sign-in the app returns to the home page.', goal: 'Sign-in returns to the page that asked for it.',
  objectives: ['The return address survives sign-in', 'A bad return address falls back to home'], priority: 'high', severity: 'critical', state: 'approved', startedBy: 'owner', who: 'Opus 5.5',
  subtasks: [{ text: 'Carry the return address through the form', state: 'done' }, { text: 'Check the address is on this site', state: 'doing' }, { text: 'Tests', state: 'todo' }], met: [1], approvedAt: ago(30), doneAt: null, updatedAt: ago(2), ...extra });

test('Kanban shows teammates\' Tasks under their names, apart from my cards and read-only, and Enter shows the whole Task', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer(), asked = [];
  let people = [
    { peer: SARA, name: 'sara', online: true, heardAt: ago(0), tasks: [teamTask(), teamTask({ id: 't-2', title: '{red-fg}Loud{/} title', priority: 'low', severity: 'medium', who: '@scout', subtasks: [], met: [], updatedAt: ago(5) })] },
    { peer: LI, name: 'li', online: false, heardAt: ago(180), tasks: [teamTask({ id: 't-3', title: 'Old cleanup', state: 'done', priority: 'low', severity: 'low', who: 'bot', subtasks: [], met: [1, 2], doneAt: ago(60), updatedAt: ago(60) })] },
  ], sharing = 'on';
  peer.teammateTasks = root => { asked.push(root); return people; }; peer.taskSharing = () => sharing;
  const v = await view(t, { repo: repository(p.root), peer }), panels = v.panels, focused = () => v.current.screen.focused, rows = () => panels.kanbanTeamList.items.map(plainItem);
  await send(v, '/kanban'); await until(() => v.current.view === 'kanban' && !panels.kanbanTeam.hidden && rows().length === 5, 'the Teammates section');
  assert.deepEqual(asked.slice(0, 1), [p.root], 'asked for this project only');
  assert.equal(panels.kanbanTeam._label.getText().trim(), "Teammates' Tasks 3 · read-only");
  assert.deepEqual(rows().map(row => row.trimEnd()), [
    '● sara · online',
    '  Fix the login redirect  high · critical · in progress · 1/3 done · Opus 5.5 · 2m ago',
    '  {red-fg}Loud{/} title  low · medium · in progress · @scout · 5m ago',
    '○ li · offline · last heard 3h ago',
    '  Old cleanup  low · low · done · bot · 1h ago',
  ]);
  // It sits under the four columns, which end where it starts; my cards stay in the columns.
  const column = panels.kanbanBoxes[0], full = column.height + 7;
  assert.equal(panels.kanbanTeam.top, column.top + column.height); assert.equal(panels.kanbanTeam.height, 7);
  assert.equal(panels.kanbanBoxes.every(frame => frame.height === column.height && !frame.hidden), true);
  // Down from the end of a column goes to the first Task, not to a teammate's name.
  panels.kanbanLists[0].focus(); v.input.write('\x1b[B');
  await until(() => focused() === panels.kanbanTeamList && panels.kanbanTeamList.selected === 1, 'the first Task');
  await until(() => /enter view/.test(panels.keys.getText()), 'the keys for a teammate\'s Task');
  v.input.write('\x1b[B'); await until(() => panels.kanbanTeamList.selected === 2, 'the next Task');
  v.input.write('\x1b[B'); await until(() => panels.kanbanTeamList.selected === 4, 'over the next teammate\'s name');
  // No key changes a teammate's Task or makes a card of it.
  const open = v.current.screen.children.length;
  for (const key of ['x', 'n', '+', '>', '<', '\x1b[C', '\x1b[D', '\x1b[1;2C', '\x1b[1;2D']) v.input.write(key);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(focused(), panels.kanbanTeamList); assert.equal(panels.kanbanTeamList.selected, 4); assert.equal(v.current.screen.children.length, open, 'no dialog opened');
  assert.deepEqual(readBoard(repository(p.root)).cards, []); assert.deepEqual(peer.sent(), []);
  // Enter shows the whole Task to read.
  panels.kanbanTeamList.select(1); v.input.write('\r');
  await until(() => modal(v, "sara's Task"), 'the Task opens');
  const lines = rowsOf(v, "sara's Task");
  assert.deepEqual(lines.map(line => line.trimEnd()), [
    'Fix the login redirect',
    'in progress · priority high · severity critical · revision 2',
    "Worked on by Opus 5.5 on sara's machine · started by its owner",
    'approved 30m ago · updated 2m ago',
    '', 'Goal', 'Sign-in returns to the page that asked for it.',
    '', 'Description', 'After sign-in the app returns to the home page.',
    '', 'Objectives · 1 of 2 met', '  ✓ The return address survives sign-in', '  · A bad return address falls back to home',
    '', 'Subtasks · 1 of 3 done', '  ✓ Carry the return address through the form', '  ▸ Check the address is on this site', '  · Tests',
  ]);
  v.input.write('\x1b'); await until(() => !modal(v, "sara's Task"), 'Esc closes it');
  // A Task a teammate took over from a handoff says so.
  people = [{ ...people[0], tasks: [teamTask({ startedBy: 'handoff' })] }, people[1]];
  await until(() => rows().length === 4, 'the changed list', 8000);
  panels.kanbanTeamList.focus(); panels.kanbanTeamList.select(1); v.input.write('\r');
  await until(() => rowsOf(v, "sara's Task").some(line => /started by a handoff/.test(line)), 'started by a handoff');
  v.input.write('\x1b'); await until(() => !modal(v, "sara's Task"), 'Esc closes it again');
  assert.deepEqual(readBoard(repository(p.root)).cards, []); assert.deepEqual(peer.sent(), []);
  // Up from the first Task goes back to the columns; down from the last goes to the message box.
  panels.kanbanTeamList.focus(); panels.kanbanTeamList.select(1); v.input.write('\x1b[A');
  await until(() => panels.kanbanLists.includes(focused()), 'back to a column');
  panels.kanbanTeamList.focus(); panels.kanbanTeamList.select(3); v.input.write('\x1b[B');
  await until(() => focused() === panels.ask, 'the message box');
  // A teammate's Tasks that are gone leave the section, and the columns take the room back.
  panels.kanbanTeamList.focus(); people = [];
  await until(() => panels.kanbanTeam.hidden && panels.kanbanLists.includes(focused()), 'the section closes', 8000);
  assert.equal(column.height, full);
  // A shared project with no origin remote says once why its Tasks are not told.
  sharing = 'no-origin';
  await until(() => !panels.kanbanTeam.hidden && /Tasks are not shown to teammates: this project has no origin remote\./.test(panels.kanbanTeam.getText()), 'the note', 8000);
  assert.equal(panels.kanbanTeamList.hidden, true); assert.equal(panels.kanbanTeam.height, 3);
});

test('with peer mode off, Kanban has no Teammates section and asks for nothing', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ enabled: false }); let asked = 0;
  peer.teammateTasks = () => { asked++; return [{ peer: SARA, name: 'sara', online: true, heardAt: ago(0), tasks: [teamTask()] }]; }; peer.taskSharing = () => { asked++; return 'on'; };
  const v = await view(t, { repo: repository(p.root), peer });
  await send(v, '/kanban'); await until(() => v.current.view === 'kanban' && !v.panels.kanbanBoxes[0].hidden, 'Kanban');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(v.panels.kanbanTeam.hidden, true); assert.equal(asked, 0);
});
