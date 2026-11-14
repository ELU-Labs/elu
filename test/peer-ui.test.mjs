import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { project, temp, fakeClis } from './helpers.mjs';
import { liveTask } from './peer-helpers.mjs';
import { repository } from '../lib/git.mjs';
import { registerProject } from '../lib/projects.mjs';
import { saveRequest, pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { launchTerminal } from '../lib/terminal.mjs';
import { listBots, removeBot, saveBot } from '../lib/bots.mjs';
import { boardRows, barCells, barColumns } from '../lib/board.mjs';
import { readBoard } from '../lib/kanban.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { helperLink } from '../lib/remote-helper.mjs';
import { clockTime } from '../lib/terminal-plan.mjs';
import { botTarget, chatBar, dmTarget, fitWords, ink, membersLine, peerName, roomTarget, teamPanes, threadTarget, visible } from '../lib/terminal-visuals.mjs';
import { joinWait, noRoute } from '../lib/peer/join-text.mjs';

const ME = 'a'.repeat(64), SARA = 'b'.repeat(64), LI = 'c'.repeat(64);
const LONG = 'Could you check whether the retry budget in the uploader resets after a successful flush or only after restart because we keep seeing duplicate batches';
const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();

// teamless: this machine is on no team until /invite makes one (createTeam).
// mine: mineRows(); remote: remoteSessions(); machines: remoteMachines(); repoId: projectRepoId(); joined: what joinTeam answers.
// answer(command): what the daemon answers a command, when it is not the usual {}.
function fakePeer({ items, running = true, refuse = () => null, remoteBots = [], teamless = false, access = { 'team-1': { handling: 'auto', rules: '', root: null, at: null } }, mine = [], remote = [], machines = [], repoId = null, joined = null, answer = null } = {}) {
  const calls = [];
  const record = (name, value) => (...args) => { calls.push([name, ...args]); return typeof value === 'function' ? value(...args) : value; };
  const facade = {
    calls, running, channels: [],
    sent: () => calls.filter(row => row[0] === 'sendPeerCommand').map(row => row[1]),
    onTeam: () => !facade.left && (!teamless || facade.made === true),
    peerStatus: record('peerStatus', () => ({ running: facade.running, stale: facade.stale === true, pid: 1, key: ME, name: 'ana', fingerprint: 'aaaaaaaa', error: null, counters: { direct: 1, relayed: 0, failed: 0 },
      teams: teamless && !facade.made ? [] : [{ id: 'team-1', name: 'Core', role: 'admin', members: [
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
      // lastTeam: a leave takes this machine off its only team, and a teammate took it, so the daemon stops.
      if (type === 'teamLeave' && facade.lastTeam) facade.left = true;
      if (type === 'teamLeave') return { team: 'team-1', name: 'Core', told: true, stopping: facade.lastTeam === true };
      const answered = answer?.(facade.last); if (answered !== undefined && answered !== null) return answered;
      if (type !== 'channelSet') return {};
      facade.channels = [...facade.channels.filter(row => row.id !== id), ...(members.length ? [{ id, name, members }] : [])]; return { id };
    }),
    startPeer: record('startPeer', true),
    // index.teamChange: the daemon is started when it is not running, then the change is sent to it.
    teamChange: record('teamChange', async command => {
      if (!facade.running) { await facade.startPeer(); facade.running = true; }
      const { id } = facade.sendPeerCommand(command); return { told: true, ...await facade.awaitCommand(id, 30000), daemon: true };
    }),
    // On no team, the app asks once for a daemon of another version to be stopped.
    restartStale: record('restartStale', false),
    share: record('share', (root, { handle }) => ({ handle: handle ?? 'sample', root, status: true })),
    createInvite: record('createInvite', () => ({ code: 'k7qm-x2pd-9fhw' })),
    createTeam: record('createTeam', name => { facade.made = true; return { id: 'team-1', name }; }),
    joinTeam: record('joinTeam', async () => joined ?? ({ id: 'team-2', name: 'Docs', inviter: { name: 'sara', fingerprint: 'bbbbbbbb' } })),
    mineRows: () => mine,
    remoteSessions: () => remote,
    remoteMachines: () => machines,
    projectRepoId: () => repoId,
    // What teammates can do here, per team: team-1 was set before these tests start, unless a test says otherwise.
    access: { ...access },
    teamAccess: id => facade.access[id] ?? null,
    saveTeamAccess: record('saveTeamAccess', (id, update) => { facade.access[id] = { handling: 'auto', rules: '', root: null, ...facade.access[id], ...update, at: 'now' }; return facade.access[id]; }),
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
// /join's questions: Join, then what teammates can do here (Auto or Manual), then the rules.
async function answerJoin(v, { handling = /^Auto/, rules = '' } = {}) {
  await choose(v, 'Join a team', /^Join$/);
  await choose(v, 'What teammates can do here', handling);
  await closeDialog(v, 'Rules for teammates', rules);
}
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
    { id: 'went-on', kind: 'answer', continued: true, peer: SARA, name: 'sara', text: 'Already in the session.', at: at(2) },
    { kind: 'held', text: 'no id' },
  ];
  const rows = boardRows(projects, now, { items, online: new Set([SARA]) });
  assert.ok(!rows.some(row => row.item?.id === 'went-on'), 'an answer the chat went on with is in Chats only, not a row in Sessions');
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

// The arrows stopped at the Direct messages heading and the cursor went back to #general, so a direct chat opened with a click only.
for (const [columns, rows] of [[160, 40], [140, 50], [80, 24]]) test(`Up and Down in the Team bar reach every channel and every direct chat and skip the headings at ${columns}x${rows}`, { timeout: 30000 }, async t => {
  const { v } = await teamView(t, { columns, rows, peer: fakePeer({ items: [] }) });
  const [bar, threads] = v.panels.teamLists, at = () => plainItem(bar.items[bar.selected]).trim(), open = () => v.panels.teamBoxes[1]._label.getText().trim();
  await until(() => bar.items.length > 5 && open() === '#general', 'the bar opens on #general');
  const all = bar.items.map(item => plainItem(item).trim()), stops = all.filter(line => !['Channels', '', 'Direct messages'].includes(line));
  assert.deepEqual(all.slice(0, 5), ['Channels', '# general  3', '+ Add channel', '', 'Direct messages']); assert.match(stops[2], /^● @sara/);
  // One key, one row: the next row that can be chosen, or the bar is left.
  const press = async key => { const from = at(); v.input.write(key); await until(() => v.current.screen.focused !== bar || at() !== from && stops.includes(at()), `a move from ${from}`); return at(); };
  bar.focus(); assert.equal(at(), '# general  3');
  const down = [at()]; for (let step = 1; step < stops.length; step++) down.push(await press('\x1b[B'));
  assert.deepEqual(down, stops, 'Down stops on every channel, person, bot and add row, and on no heading');
  // The threads beside the bar follow the cursor to a direct chat, and Enter there writes to that person.
  bar.select(all.findIndex(line => /^\+ Add channel/.test(line)));
  assert.match(await press('\x1b[B'), /^● @sara/); await until(() => open() === '@sara', '@sara opens from the keyboard');
  v.input.write('\r'); await until(() => v.current.screen.focused === v.panels.ask && /Message @sara/.test(v.panels.ask._label.getText()), 'Enter on @sara writes to them');
  bar.focus(); bar.select(all.findIndex(line => /^○ @li/.test(line))); await until(() => open() === '@li', '@li opens');
  // Up goes back the same way, over the headings, to the first channel; one more Up leaves the bar for the tabs.
  bar.select(bar.items.length - 1);
  const up = [at()]; for (let step = 1; step < stops.length; step++) up.push(await press('\x1b[A'));
  assert.deepEqual(up, [...stops].reverse(), 'Up stops on the same rows');
  await until(() => open() === '#general', '#general is open again');
  v.input.write('\x1b[A'); await until(() => v.current.screen.focused === v.panels.tabs.find(tab => tab.viewName === 'chats'), 'Up from the first channel reaches the Chats tab');
  assert.equal(at(), '# general  3', 'the cursor stays on the first channel');
  // Down from the last row leaves for the threads under the bar, or the message box beside it.
  bar.focus(); bar.select(bar.items.length - 1); v.input.write('\x1b[B');
  await until(() => v.current.screen.focused === (columns < 100 ? threads : v.panels.ask), 'Down from the last row leaves the bar');
  // The wheel passes the headings too, both ways.
  bar.focus(); bar.select(all.findIndex(line => /^\+ Add channel/.test(line))); wheelAt(v, bar, 1);
  await until(() => /^● @sara/.test(at()), 'a wheel step down from + Add channel lands on @sara');
  wheelAt(v, bar, -1); await until(() => at() === '+ Add channel', 'a wheel step up from @sara lands on + Add channel');
  assert.ok(stops.includes(at()) && v.current.screen.focused === bar);
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
  // y approves a teammate's message: it starts as if you typed it, with no picker.
  selectRow(threads, /@li asks you/); v.input.write('y');
  await until(() => peer.sent().some(row => row.type === 'approve' && row.id === 'incoming-1'), 'approve incoming without a saved request');
  assert.equal(modal(v, 'Accept'), undefined, 'no picker');
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
  assert.deepEqual(peer.sent().map(row => Object.keys(row).sort().join()), ['id,type', 'id,type', 'id,type', 'id,type']);
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
  // Enter reads an ask; w in the dialog opens the picker, Enter starts it in the picked mode.
  await open(threads, /asks you/, 'Thread with @sara', 'y approves: it starts as if you typed it. w picks the mode first. n declines.');
  v.input.write('w'); await until(() => modal(v, 'Accept'), 'accept picker'); v.input.write('\r');
  // The daemon runs it as the owner's session in the picked mode; the dialog only sends the command.
  await until(() => peer.sent().some(row => row.type === 'work' && row.id === 'incoming:task-ask' && row.permissions === 'ask'), 'ask accepted from the dialog');
  await until(() => !modal(v, 'Thread with @sara') && /Accepted @sara/.test(v.panels.status.getText()), 'dialog closed');
  // Once something is typed, letters are text.
  await open(threads, /reply ready/, 'Thread with @sara', 'y sends. e edits it first. n discards.');
  // The thread reads like a chat: Sara's question, then my model's reply waiting to go.
  assert.match(v.text(), /@sara · question · \d\d:\d\d[^]*How do we rotate keys\?[^]*↳ your model · answer · not sent yet · \d\d:\d\d[^]*Rotate with bin\/rotate\./);
  v.input.write('x'); v.input.write('y'); await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(modal(v, 'Thread with @sara'), 'typed letters keep the dialog open');
  await closeDialog(v, 'Thread with @sara');
  assert.ok(!peer.sent().some(row => row.type === 'approve'), 'nothing approved');
  await open(threads, /reply ready/, 'Thread with @sara', 'y sends. e edits it first. n discards.'); v.input.write('n');
  await until(() => peer.sent().some(row => row.type === 'discard' && row.id === 'held-1'), 'reply discarded from the dialog');
  await open(threads, /answered/, 'Thread with @sara', 'c continues'); v.input.write('c');
  await until(() => peer.sent().some(row => row.type === 'continue' && row.id === 'answer-1'), 'continued from the dialog');
});

test('a thread names its project: the one a teammate\'s message runs in here, the one I asked from, or the share I named; one with no project has no such line', { timeout: 30000 }, async t => {
  const p = project(later(t)); environment(t, p.parent); registerProject(repository(p.root));
  const name = path.basename(p.root);
  const peer = fakePeer({ items: [
    // Sara's message names no project; its session runs in this one.
    { id: 'incoming:task-in', kind: 'incoming', peer: SARA, name: 'sara', project: null, root: p.root, text: 'How do we rotate keys?', at: ago(1), state: 'submitted', threadId: 'th-in' },
    // A result of mine that waits to go, from the work in this project.
    { id: 'held:result-1', kind: 'held', result: true, peer: SARA, name: 'sara', project: null, root: p.root, text: 'Keys rotate nightly now.', question: 'Rotate the keys nightly.', at: ago(2), state: 'held', threadId: 'th-held' },
    // A question I asked from this project, naming none of hers, and her answer.
    { id: 'answer:1', kind: 'answer', peer: SARA, name: 'sara', project: null, root: p.root, text: 'Use v2.', question: 'Which endpoint?', at: ago(4), state: 'answered', threadId: 'th-out' },
    // One I sent to a share of Li's by its name.
    { id: 'asked:2', kind: 'asked', peer: LI, name: 'li', project: 'api', root: p.root, text: 'Where are the fixtures?', at: ago(5), state: 'submitted', threadId: 'th-api' },
    // One that came with no project and waits for one.
    { id: 'incoming:task-none', kind: 'incoming', peer: LI, name: 'li', project: null, root: null, text: 'Anyone there?', at: ago(6), state: 'submitted', threadId: 'th-none' },
  ] });
  const v = await view(t, { peer });
  await send(v, '/chats'); await until(() => v.current.view === 'chats', 'Chats');
  const [, threads] = v.panels.teamLists;
  const shown = async (who, pattern) => {
    await openRow(v, who === 'sara' ? /@sara\s+direct/ : /@li\s+offline/, `@${who}`);
    await until(() => threads.items.some(item => pattern.test(plainItem(item))), `row ${pattern}`);
    threads.focus(); selectRow(threads, pattern); v.input.write('\r');
    await until(() => modal(v, `Thread with @${who}`), `the thread with @${who}`);
    const said = modal(v, `Thread with @${who}`).children.find(child => child.options?.scrollable).getContent(); await closeDialog(v, `Thread with @${who}`);
    return said;
  };
  for (const [who, pattern] of [['sara', /asks you/], ['sara', /result ready/], ['sara', /answered/]]) {
    const said = await shown(who, pattern);
    assert.ok(said.startsWith(`Project: ${name}\n`), `${pattern}: ${said.slice(0, 80)}`); assert.doesNotMatch(said, /not named/);
  }
  assert.ok((await shown('li', /you asked/)).startsWith('Project: api\n'));
  const none = await shown('li', /asks you/);
  assert.doesNotMatch(none, /Project:|not named/); assert.match(none, /^Anyone there\?/);
});

test('Shift letters and typed text never fail silently, and nothing opens an external editor', async t => {
  const { v, peer } = await teamView(t);
  const [, threads] = v.panels.teamLists, status = () => v.panels.status.getText(), screen = v.current.screen;
  await until(() => threads.items.length > 1, 'threads');
  // Caps Lock or Shift: Y on the list and N in a dialog still decide.
  await openRow(v, /@li\s+offline/, '@li'); threads.focus(); selectRow(threads, /@li asks you/); v.input.write('Y');
  await until(() => peer.sent().some(row => row.type === 'approve' && row.id === 'incoming-1'), 'Y approves on the list');
  await openRow(v, /@sara\s+direct/, '@sara'); threads.focus(); selectRow(threads, /reply ready/); v.input.write('\r'); await until(() => modal(v, 'Thread with @sara'), 'dialog');
  v.input.write('N'); await until(() => peer.sent().some(row => row.type === 'discard' && row.id === 'held-1'), 'N discards in the dialog');
  // Other text and Enter says what to press.
  await until(() => !modal(v, 'Thread with @sara'), 'closed');
  await openRow(v, /@li\s+offline/, '@li'); threads.focus(); selectRow(threads, /draft to send/); v.input.write('\r'); await until(() => modal(v, 'Thread with @li'), 'draft dialog');
  v.input.write('maybe'); v.input.write('\r');
  await until(() => /Nothing was done\. Press y or n\./.test(status()), 'typed text explains');
  assert.ok(!peer.sent().some(row => row.id === 'draft-1'), 'the draft is untouched');
  // blessed opens $EDITOR on e, Ctrl-E and a right-click; ELU types in place instead.
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
  await until(() => /Sent to @sara\. Their reply shows in this thread\./.test(status()) && v.panels.ask.getValue() === '', 'sent');
  // A person: every word is the message, even one that is a project they share.
  await openRow(v, /@li\s+offline/, '@li');
  await until(() => /Message @li/.test(label()), 'the box names the person');
  await send(v, 'api tests fail on my machine');
  await until(() => peer.sent().at(-1).to === LI, 'direct message');
  assert.deepEqual(peer.sent().at(-1), { type: 'ask', to: LI, project: null, text: 'api tests fail on my machine' });
  await until(() => /Sent to @li\. Their reply shows in this thread\./.test(status()) && v.panels.ask.getValue() === '', 'sent to the person');
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
  // A person's line says what is on for them, and their threads start under it too.
  await openRow(v, /@sara\s+direct/, '@sara');
  await until(() => inside(v) === 'Hold replies: off · Auto-continue: off · h and o change them' && threads.atop === box.atop + 2, 'the line for a person');
  assert.deepEqual(threadLines(v), ['Nothing in @sara yet. Type below to write to it.']); assertPanes(v, 160);
  // A bot of mine has no line, and its threads start at the top again.
  await openRow(v, /◆ @reviewer\s*$/, '@reviewer');
  await until(() => inside(v) === null && threads.atop === box.atop + 1, 'no line for a bot');
});

// The daemon keeps what h and o set for a teammate (peerSetting, lib/peer/daemon.mjs); this
// stand-in keeps it the same way, and answers peerPolicy from it as lib/peer/settings.mjs does.
function withPolicy(peer, policy = {}) {
  const sendCommand = peer.sendPeerCommand;
  peer.peerPolicy = key => ({ autoAccept: false, holdReplies: false, autoAsk: false, autoContinue: false, muted: false, trusted: false, ...policy[key] });
  peer.sendPeerCommand = command => { if (command.type === 'peerSetting') policy[command.key] = { ...policy[command.key], [command.name]: command.on }; return sendCommand(command); };
  return peer;
}
const dialogBody = (v, title) => modal(v, title).children.find(child => child.options?.scrollable).getText();

test('h and o on a teammate turn hold replies and auto-continue on and off: the line over their threads says what is on, and their screen and the help name the keys', { timeout: 30000 }, async t => {
  const peer = withPolicy(fakePeer()), { v } = await teamView(t, { peer });
  const [bar, threads] = v.panels.teamLists, keys = () => v.panels.keys.getText().trim(), status = () => v.panels.status.getText();
  const settings = () => peer.sent().filter(row => row.type === 'peerSetting').map(row => [row.key === SARA ? 'sara' : row.key, row.name, row.on]);
  await openRow(v, /@sara\s+direct/, '@sara');
  await until(() => inside(v) === 'Hold replies: off · Auto-continue: off · h and o change them', 'the line over her threads');
  bar.focus(); await until(() => /^enter write {2}t trust {2}h hold replies {2}o auto-continue {2}tab threads/.test(keys()), 'the keys on her row');
  // h holds my replies and results to her; the line and the status say so.
  v.input.write('h');
  await until(() => inside(v) === 'Hold replies: on · Auto-continue: off · h and o change them', 'hold replies on');
  await until(() => /Holding replies to @sara: y sends each one, e edits it, n drops it\./.test(status()), 'what h did');
  assert.deepEqual(settings(), [['sara', 'holdReplies', true]]);
  // From her threads the same keys act on her.
  threads.focus(); v.input.write('o');
  await until(() => inside(v) === 'Hold replies: on · Auto-continue: on · h and o change them' && /Auto-continue on for @sara: their answer or result continues your chat\./.test(status()), 'auto-continue on');
  v.input.write('h');
  await until(() => inside(v) === 'Hold replies: off · Auto-continue: on · h and o change them' && /Replies to @sara go when ready\. One with a possible secret still waits\./.test(status()), 'hold replies off');
  // Her screen says both, and h and o there change them.
  bar.focus(); selectRow(bar, /@sara\s+direct/); v.input.write('t'); await until(() => modal(v, 'Teammate @sara'), 'her screen');
  assert.match(dialogBody(v, 'Teammate @sara'), /Hold replies: off · your replies and results go to them when ready\.\nAuto-continue: on · their answer or result continues the chat you asked from\.\n\nt trusts them · h holds replies · o turns auto-continue off/);
  v.input.write('o');
  await until(() => !modal(v, 'Teammate @sara') && /Auto-continue off for @sara: their answers wait here; c continues one\./.test(status()), 'o on her screen');
  await until(() => inside(v) === 'Hold replies: off · Auto-continue: off · h and o change them', 'both off again');
  assert.deepEqual(settings(), [['sara', 'holdReplies', true], ['sara', 'autoContinue', true], ['sara', 'holdReplies', false], ['sara', 'autoContinue', false]]);
  // On a channel there is no teammate to set it for.
  await openRow(v, /# general/, '#general'); bar.focus(); v.input.write('h');
  await until(() => /Choose a teammate first\./.test(status()), 'h on a channel');
  assert.equal(settings().length, 4);
  // The help says where the two are.
  await send(v, '/help'); await until(() => modal(v, 'Commands'), 'help');
  assert.match(dialogBody(v, 'Commands').replace(/\s+/g, ' '), /On a teammate, h holds your replies and results to them until you send each one: y sends it, e edits it first, n drops it\. o lets their answer or result continue the chat you asked from\./);
  await closeDialog(v, 'Commands');
  // At 80 columns the line still says what is on.
  v.output.columns = 80; v.output.rows = 24; v.output.emit('resize');
  await openRow(v, /@sara/, '@sara');
  await until(() => v.current.screen.width === 80 && /^Hold replies: off · Auto-continue: off/.test(inside(v) ?? ''), 'the line at 80 columns');
  assertPanes(v, 80);
  // What h and o say is whole on the status line there: nothing is cut.
  const said = () => status().trim();
  bar.focus(); selectRow(bar, /@sara/); v.input.write('h');
  await until(() => said() === '› Holding replies to @sara: y sends each one, e edits it, n drops it.', 'h at 80 columns');
  v.input.write('o'); await until(() => said() === '› Auto-continue on for @sara: their answer or result continues your chat.', 'o at 80 columns');
  v.input.write('h'); await until(() => said() === '› Replies to @sara go when ready. One with a possible secret still waits.', 'h again at 80 columns');
  v.input.write('o'); await until(() => said() === '› Auto-continue off for @sara: their answers wait here; c continues one.', 'o again at 80 columns');
});

test('e on a held reply or a held result opens its whole text in the message box: Enter sends the edited text, a refused edit stays in the box, Esc leaves it held, and n drops a result as a result', { timeout: 30000 }, async t => {
  const SECRET = `AKIA${'A1B2'.repeat(4)}`, WHOLE = `Done. Call it with ${SECRET} as the key. ${'The next part of what was done. '.repeat(20)}The end.`;
  const peer = fakePeer({ items: [
    { id: 'held:task-1', kind: 'held', peer: SARA, name: 'sara', project: 'web', text: 'The deploy script lives in bin/deploy.', question: 'Where is the deploy script?', at: ago(3), state: 'awaiting-owner', threadId: 'th-1', blocked: false },
    { id: 'held:result-r1', kind: 'held', result: true, blocked: true, problems: ['aws-access-key'], peer: SARA, name: 'sara', project: null, text: WHOLE.slice(0, 400), question: 'Make coupon codes uppercase.', at: ago(2), state: 'held', threadId: 'th-2' },
    { id: 'answer-1', kind: 'answer', peer: SARA, name: 'sara', project: 'web', text: 'Use the v2 endpoint.', at: ago(10), state: 'completed', threadId: 'th-5' },
  ], refuse: command => command.type === 'approve' && String(command.text ?? '').includes(SECRET) ? 'This result contains a possible secret. Remove it before sending.' : null });
  peer.heldText = id => ({ 'held:result-r1': WHOLE, 'held:task-1': 'The deploy script lives in bin/deploy.' })[id] ?? null;
  const { v } = await teamView(t, { peer });
  const [, threads] = v.panels.teamLists, ask = v.panels.ask, keys = () => v.panels.keys.getText().trim(), status = () => v.panels.status.getText(), label = () => ask._label.getText().trim();
  const approved = () => peer.sent().filter(row => row.type === 'approve').map(row => [row.id, row.text]);
  await openRow(v, /@sara\s+direct/, '@sara');
  await until(() => threads.items.some(item => /result ready/.test(plainItem(item))) && threads.items.some(item => /reply ready/.test(plainItem(item))), 'the held rows');
  // e is offered on a row that waits to be sent, and nowhere else.
  threads.focus(); selectRow(threads, /answered/); await until(() => /^y accept\/send {2}n decline/.test(keys()), 'no e on an answer');
  v.input.write('e'); await until(() => /e edits a reply or a result that waits for you\. Choose one in Threads\./.test(status()), 'e on an answer');
  selectRow(threads, /result ready/); await until(() => /^y accept\/send {2}e edit {2}n decline/.test(keys()), 'e on a held result');
  // e: the whole text is in the message box, which says what Enter and Esc do.
  v.input.write('e');
  await until(() => v.current.screen.focused === ask && ask.getValue() === WHOLE, 'the whole result in the box');
  await until(() => label() === 'Edit the result for @sara · Enter sends it · Esc leaves it held' && keys() === 'enter send the edited result  esc leave it held', 'the box says it is an edit');
  assert.match(status(), /Take out the possible secret\. Enter sends it to @sara, Esc leaves it held\./);
  assert.ok(v.panels.palette.hidden, 'no command list over an edit');
  // Enter with the secret still in it: refused, and the text stays in the box as an edit.
  await until(() => ask.__listener, 'the box reads'); ask.submit();
  await until(() => /This result contains a possible secret\. Remove it before sending\./.test(status()), 'the refusal');
  assert.equal(ask.getValue(), WHOLE); assert.equal(label(), 'Edit the result for @sara · Enter sends it · Esc leaves it held');
  assert.deepEqual(approved(), [['held:result-r1', WHOLE]]);
  // The secret taken out: Enter sends the edited text, and the box writes to her again.
  await until(() => ask.__listener, 'the box reads again'); ask.setValue('Done. Use the key from your own vault.'); ask.submit();
  await until(() => /Sending the edited result to @sara\./.test(status()) && ask.getValue() === '' && label() === 'Message @sara', 'the edited result went');
  assert.deepEqual(approved().at(-1), ['held:result-r1', 'Done. Use the key from your own vault.']);
  // A held reply the same way; Esc leaves it held and sends nothing.
  threads.focus(); selectRow(threads, /reply ready/); v.input.write('e');
  await until(() => ask.getValue() === 'The deploy script lives in bin/deploy.' && label() === 'Edit the reply to @sara · Enter sends it · Esc leaves it held', 'the reply in the box');
  assert.match(status(), /Change the text below, then Enter sends it to @sara\. Esc leaves it held\./);
  v.input.write('\x1b');
  await until(() => ask.getValue() === '' && label() === 'Message @sara' && /The reply is still held\. y sends it as it is, e edits it, n drops it\./.test(status()), 'Esc leaves it held');
  assert.equal(approved().length, 2); assert.ok(!peer.sent().some(row => row.type === 'discard'), 'nothing was dropped');
  // Its thread names e too, and e there opens the same edit. Text that starts like a command is still the reply.
  threads.focus(); selectRow(threads, /reply ready/); v.input.write('\r');
  await until(() => modal(v, 'Thread with @sara') && v.text().includes('y sends. e edits it first. n discards.'), 'the thread');
  v.input.write('e');
  await until(() => !modal(v, 'Thread with @sara') && ask.getValue() === 'The deploy script lives in bin/deploy.' && /^Edit the reply to @sara/.test(label()), 'e in the thread');
  await until(() => ask.__listener, 'the box reads'); ask.setValue('/usr/local/bin/deploy is the script.'); ask.submit();
  await until(() => /Sending the edited reply to @sara\./.test(status()), 'the edited reply went');
  assert.deepEqual(approved().at(-1), ['held:task-1', '/usr/local/bin/deploy is the script.']);
  // n on a held result says result, not reply.
  threads.focus(); selectRow(threads, /result ready/); v.input.write('n');
  await until(() => peer.sent().some(row => row.type === 'discard' && row.id === 'held:result-r1'), 'the result dropped');
  await until(() => /Dropped the result\. Nothing was sent to @sara\./.test(status()), 'what n did');
});

test('the status of a held edit tells to take the possible secret out only while the box holds one: it clears as the key is deleted, before Enter', { timeout: 30000 }, async t => {
  const SECRET = `AKIA${'A1B2'.repeat(4)}`, WHOLE = `Coupon codes are uppercase now. The key is ${SECRET}`;
  const refusal = 'This result contains a possible secret. Remove it before sending.';
  const peer = fakePeer({ items: [
    { id: 'held:result-r1', kind: 'held', result: true, blocked: true, problems: ['aws-access-key'], peer: SARA, name: 'sara', project: null, text: WHOLE, question: 'Make coupon codes uppercase.', at: ago(2), state: 'held', threadId: 'th-2' },
    { id: 'held:task-1', kind: 'held', peer: SARA, name: 'sara', project: 'web', text: 'The deploy script lives in bin/deploy.', question: 'Where is the deploy script?', at: ago(3), state: 'awaiting-owner', threadId: 'th-1', blocked: false },
  ], refuse: command => command.type === 'approve' && String(command.text ?? '').includes(SECRET) ? refusal : null });
  peer.heldText = id => ({ 'held:result-r1': WHOLE, 'held:task-1': 'The deploy script lives in bin/deploy.' })[id] ?? null;
  const { v } = await teamView(t, { peer });
  const [, threads] = v.panels.teamLists, ask = v.panels.ask, status = () => v.panels.status.getText().trim();
  const TAKE = '› Take out the possible secret. Enter sends it to @sara, Esc leaves it held.', READY = '› Enter sends it to @sara. Esc leaves it held.';
  await openRow(v, /@sara\s+direct/, '@sara');
  await until(() => threads.items.some(item => /result ready/.test(plainItem(item))), 'the held result');
  threads.focus(); selectRow(threads, /result ready/); v.input.write('e');
  await until(() => v.current.screen.focused === ask && ask.getValue() === WHOLE && status() === TAKE, 'the edit, with the key still in it');
  // Enter with the key still in it: the daemon refuses, and the status says why.
  await until(() => ask.__listener, 'the box reads'); v.input.write('\r');
  await until(() => status() === `› ${refusal}`, 'the refusal');
  assert.equal(ask.getValue(), WHOLE);
  // He deletes the key, a character at a time. The line stays while the text still holds
  // it, and is gone with the keystroke after which it no longer does, before any Enter.
  await until(() => ask.__listener && v.current.screen.focused === ask, 'the box reads again');
  v.input.write('\x7f');
  await until(() => ask.getValue() === WHOLE.slice(0, -1), 'one character deleted');
  await until(() => status() === READY, 'the status once the key is gone');
  assert.equal(peer.sent().filter(row => row.type === 'approve').length, 1, 'nothing was sent again');
  // Typed back, the box holds it again and the status says so again.
  v.input.write(SECRET.at(-1));
  await until(() => ask.getValue() === WHOLE && status() === TAKE, 'the key typed back');
  for (let left = SECRET.length; left > 0; left--) v.input.write('\x7f');
  await until(() => ask.getValue() === WHOLE.slice(0, -SECRET.length) && status() === READY, 'the whole key deleted');
  v.input.write('in your vault.'); await until(() => ask.getValue().endsWith('in your vault.'), 'typed');
  assert.equal(status(), READY);
  v.input.write('\r');
  await until(() => /Sending the edited result to @sara\./.test(status()) && ask.getValue() === '', 'the edited result went');
  assert.equal(peer.sent().filter(row => row.type === 'approve').at(-1).text, 'Coupon codes are uppercase now. The key is in your vault.');
  // An edit that never held one keeps its own line, and says so once a key is typed into it.
  threads.focus(); selectRow(threads, /reply ready/); v.input.write('e');
  await until(() => ask.getValue() === 'The deploy script lives in bin/deploy.' && status() === '› Change the text below, then Enter sends it to @sara. Esc leaves it held.', 'the reply in the box');
  v.input.write(' x'); await until(() => ask.getValue().endsWith(' x'), 'typed into the reply');
  assert.equal(status(), '› Change the text below, then Enter sends it to @sara. Esc leaves it held.');
});

test('e on a reply or a result that waits in Sessions opens its text to edit in Chats, and a draft of yours has no e', { timeout: 20000 }, async t => {
  const p = project(later(t)); environment(t, p.parent); registerProject(repository(p.root));
  const SECRET = `AKIA${'A1B2'.repeat(4)}`, WHOLE = `Lowercase input is covered by a test now. The key is ${SECRET}`;
  const peer = fakePeer({ items: [
    { id: 'held:result-r1', kind: 'held', result: true, blocked: true, problems: ['aws-access-key'], peer: SARA, name: 'sara', project: null, text: WHOLE, question: 'Add a test.', at: ago(1), state: 'held', threadId: 'th-2' },
    { id: 'draft-1', kind: 'draft', peer: LI, name: 'li', text: 'Which schema?', at: ago(3) },
  ] });
  peer.heldText = id => id === 'held:result-r1' ? WHOLE : null;
  const v = await view(t, { dashboard: true, peer });
  const board = v.panels.board, ask = v.panels.ask, keys = () => v.panels.keys.getText().trim(), status = () => v.panels.status.getText();
  await until(() => board.items.some(item => /result for @sara/.test(plainItem(item))), 'the held result in Sessions');
  // A draft of yours is sent or dropped; only what waits to go to a teammate is edited.
  board.focus(); selectRow(board, /ask @li\?/); await until(() => /^y send {2}n discard {2}enter read/.test(keys()), 'a draft has no e');
  selectRow(board, /result for @sara/); await until(() => /^y send {2}n discard {2}e edit {2}enter read/.test(keys()), 'e on the row');
  await until(() => v.panels.chat.getText().includes('y send · n discard · e edit · enter read · c discard'), 'e beside the list');
  // e: Chats, on that teammate, with the whole text in the message box.
  v.input.write('e');
  await until(() => v.current.view === 'chats' && v.current.screen.focused === ask && ask.getValue() === WHOLE, 'the result in the box of Chats');
  await until(() => ask._label.getText().trim() === 'Edit the result for @sara · Enter sends it · Esc leaves it held' && keys() === 'enter send the edited result  esc leave it held', 'the box says it is an edit');
  assert.match(status(), /Take out the possible secret\. Enter sends it to @sara, Esc leaves it held\./);
  // Esc leaves it held, with the cursor on it in her threads: y, e and n act on it from there.
  const [, threads] = v.panels.teamLists;
  v.input.write('\x1b');
  await until(() => /The result is still held\. y sends it as it is, e edits it, n drops it\./.test(status()) && ask.getValue() === '', 'Esc leaves it held');
  await until(() => v.current.screen.focused === threads && /result ready/.test(plainItem(threads.items[threads.selected])) && /^y accept\/send {2}e edit {2}n decline/.test(keys()), 'the cursor is on the held result');
  v.input.write('e');
  await until(() => v.current.screen.focused === ask && ask.getValue() === WHOLE, 'e edits it again');
  await until(() => ask.__listener, 'the box reads'); ask.setValue('Lowercase input is covered by a test now.'); ask.submit();
  await until(() => /Sending the edited result to @sara\./.test(status()), 'the edited result went');
  assert.deepEqual(peer.sent().filter(row => row.type === 'approve').map(row => [row.id, row.text]), [['held:result-r1', 'Lowercase input is covered by a test now.']]);
});

test('@name in an open session asks that teammate from the session, and /ask says so and leaves the question ready to send', { timeout: 30000 }, async t => {
  const p = project(later(t)); environment(t, p.parent);
  const repo = repository(p.root), at = new Date().toISOString();
  saveTask(repo, { id: '1', kind: 'conversation', goal: 'Find the tax rates', state: 'answered', worktree: repo.root, base: null, branch: null, createdAt: at, runs: [], reviews: [], responses: [], messages: [{ at, text: 'Find the tax rates' }], sessions: {}, result: null });
  const peer = fakePeer({ items: [] }), v = await view(t, { repo, dashboard: true, peer });
  const board = v.panels.board, ask = v.panels.ask, status = () => v.panels.status.getText(), keys = () => v.panels.keys.getText().trim(), label = () => ask._label.getText().trim();
  await until(() => board.items.map(plainItem).some(row => /Find the tax rates/.test(row)), 'the session row');
  board.focus(); selectRow(board, /Find the tax rates/); v.input.write('\r');
  await until(() => v.current.session === '1', 'the session is open');
  // The key bar says @name reaches a teammate too, not only a bot.
  ask.focus(); await until(() => /@name ask a bot or a teammate/.test(keys()), 'the key bar names teammates');
  // /ask is not a command. With a teammate of that name the box keeps the part that asks them.
  await send(v, '/ask @sara where are the tax rates?');
  await until(() => /Unknown command: \/ask\. Ask by name: Enter sends this to @sara\./.test(status()), 'what to do instead');
  assert.equal(ask.getValue(), '@sara where are the tax rates?'); assert.deepEqual(peer.sent(), [], 'nothing was sent yet');
  await until(() => label() === 'Ask @sara · teammate', 'the box says who gets it');
  // Enter sends it to her from this session: her answer can continue it.
  await until(() => ask.__listener, 'the box reads'); ask.submit();
  await until(() => peer.sent().some(row => row.type === 'ask'), 'the ask');
  assert.deepEqual(peer.sent().at(-1), { type: 'ask', to: 'sara', project: null, text: 'where are the tax rates?', root: repo.root, taskId: '1' });
  await until(() => /Sent to @sara\. Their reply shows in this thread\./.test(status()) && ask.getValue() === '', 'sent');
  assert.equal(pendingRequests(p.root).length, 0, 'the session model got nothing');
  // @name typed straight away does the same, also in another case.
  await send(v, '@Sara and the VAT ones?');
  await until(() => peer.sent().filter(row => row.type === 'ask').length === 2, 'the second ask');
  assert.deepEqual(peer.sent().at(-1), { type: 'ask', to: 'sara', project: null, text: 'and the VAT ones?', root: repo.root, taskId: '1' });
  // With no teammate of that name the text stays as typed, and nothing goes to the model.
  await send(v, '/ask @nobody hello');
  await until(() => /Unknown command: \/ask\. Write @name and your question to ask a teammate\./.test(status()), 'no such teammate');
  assert.equal(ask.getValue(), '/ask @nobody hello'); assert.equal(pendingRequests(p.root).length, 0); assert.equal(peer.sent().length, 2);
});

test('at 80 columns the key bar of an open session on a team shows whole hints, none cut in the middle', { timeout: 20000 }, async t => {
  const p = project(later(t)); environment(t, p.parent);
  // In colour, as a terminal shows it: a coloured line as wide as its box loses its last word there.
  delete process.env.NO_COLOR;
  const repo = repository(p.root), at = new Date().toISOString();
  saveTask(repo, { id: '1', kind: 'conversation', goal: 'Find the tax rates', state: 'answered', worktree: repo.root, base: null, branch: null, createdAt: at, runs: [], reviews: [], responses: [], messages: [{ at, text: 'Find the tax rates' }], sessions: {}, result: null });
  const peer = fakePeer({ items: [] }), v = await view(t, { repo, dashboard: true, peer, columns: 80, rows: 24 });
  const board = v.panels.board, ask = v.panels.ask, keys = () => v.panels.keys.getText().trim();
  // The last line as a render leaves it.
  const shown = () => { v.current.screen.render(); return v.lines().at(-1).trim(); };
  await until(() => board.items.map(plainItem).some(row => /Find the tax/.test(row)), 'the session row');
  board.focus(); selectRow(board, /Find the tax/); v.input.write('\r');
  await until(() => v.current.session === '1', 'the session is open');
  ask.focus(); await until(() => /@name ask a bot or a teammate/.test(keys()), 'the key bar names teammates');
  // The hints may take 78 columns here, and enter, @name, / and /model together are 78:
  // the screen shows all of what the bar holds.
  await until(() => shown() === keys(), 'the screen shows the whole bar');
  assert.equal(shown(), 'enter send  @name ask a bot or a teammate  / commands  /model choose the model');
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
  await send(v, '/invite'); await choose(v, 'Invite', /^Someone new/); await until(() => modal(v, 'Team invite'), 'the invite');
  assert.match(modal(v, 'Team invite').children.find(child => child.options?.scrollable).getText(), /^╭────────────────────╮\n│   k7qm-x2pd-9fhw   │\n╰────────────────────╯\n\nOne use, expires in 24 h\./);
  await closeDialog(v, 'Team invite'); assert.deepEqual(invites(), [['createInvite', 'team-1', { hours: 24 }]]);
  await send(v, '/invite Core'); await until(() => modal(v, 'Team invite'), 'the invite for a named team');
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

test('/leave leaves the team after one confirm, the founder is told why not, and only an admin’s /remove takes a teammate off', { timeout: 20000 }, async t => {
  const peer = fakePeer({ items: [] }), base = peer.peerStatus, TWIN = 'e'.repeat(64); let founder = SARA, role = 'admin', two = false, twin = false;
  peer.peerStatus = () => {
    const value = base(); Object.assign(value.teams[0], { founder, role }); if (two) value.teams.push({ ...value.teams[0], id: 'team-2', name: 'Docs' });
    if (twin) value.teams[0].members = [...value.teams[0].members, { key: TWIN, fingerprint: 'eeeeeeee', name: 'sara', role: 'member', online: false, path: null, lastSeen: null }];
    return value;
  };
  const { v } = await teamView(t, { peer }), status = () => v.panels.status.getText(), changes = () => peer.sent().filter(row => ['teamLeave', 'teamRemove'].includes(row.type));
  const body = title => modal(v, title).children.find(child => child.options?.scrollable).getText();
  // One confirm; anything but y sends nothing.
  await send(v, '/leave'); await until(() => modal(v, 'Leave Core'), 'the confirm');
  assert.equal(body('Leave Core'), 'Leave Core? You stop getting its messages.\n\n[y/N]');
  await closeDialog(v, 'Leave Core', 'n'); assert.deepEqual(changes(), []);
  await send(v, '/leave'); await closeDialog(v, 'Leave Core', 'y');
  await until(() => /You left Core\./.test(status()), 'left');
  assert.deepEqual(changes(), [{ type: 'teamLeave', team: 'team-1' }]);
  // On two teams, it is named.
  two = true;
  await send(v, '/leave'); await until(() => /You are on 2 teams\. Use \/leave NAME: Core, Docs\./.test(status()), 'which team');
  await send(v, '/leave docs'); await closeDialog(v, 'Leave Docs', 'y'); await until(() => /You left Docs\./.test(status()), 'left Docs');
  assert.deepEqual(changes().at(-1), { type: 'teamLeave', team: 'team-2' });
  two = false;
  // The person who made the team cannot leave it.
  founder = ME;
  await send(v, '/leave'); await until(() => /You made Core, so you cannot leave it\. \/remove @name removes a teammate\./.test(status()), 'the founder');
  assert.ok(!modal(v, 'Leave Core'));
  // /remove: one confirm, then the change; a name nobody has is refused.
  await send(v, '/remove @sara'); await until(() => modal(v, 'Remove @sara'), 'remove confirm');
  assert.equal(body('Remove @sara'), 'Remove @sara (bbbbbbbb) from Core?\n\n[y/N]');
  await closeDialog(v, 'Remove @sara', 'y'); await until(() => /Removed @sara from Core\./.test(status()), 'removed');
  assert.deepEqual(changes().at(-1), { type: 'teamRemove', team: 'team-1', key: SARA });
  await send(v, '/remove @bob'); await until(() => /No teammate @bob on Core\./.test(status()), 'unknown');
  // Two teammates called @sara: the name alone is refused, and the first 8 characters of a key pick one.
  twin = true;
  await send(v, '/remove @sara'); await until(() => /Two teammates are called @sara\. Use \/remove with the first 8 characters of their key \(elu peers --json shows it\)\./.test(status()), 'two saras');
  await send(v, '/remove eeeeeeee'); await until(() => modal(v, 'Remove @sara'), 'remove by key');
  assert.equal(body('Remove @sara'), 'Remove @sara (eeeeeeee) from Core?\n\n[y/N]');
  await closeDialog(v, 'Remove @sara', 'y'); await until(() => changes().length === 4, 'removed by key');
  assert.deepEqual(changes().at(-1), { type: 'teamRemove', team: 'team-1', key: TWIN });
  twin = false;
  // Nobody removes the founder, and someone who is not an admin removes nobody.
  founder = LI; await send(v, '/remove @li'); await until(() => /@li made Core, so they cannot be removed\./.test(status()), 'the founder stays');
  role = 'member'; await send(v, '/remove @sara'); await until(() => /Only an admin of Core can remove a teammate\./.test(status()), 'not an admin');
  assert.equal(changes().length, 4);
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

test('/invite offers a code for someone new or which bots teammates may use, and the code comes without a bots question', async t => {
  const { v } = await teamView(t), title = 'Bots your teammates can use', status = () => v.panels.status.getText(), shared = () => listBots().map(bot => [bot.name, bot.shared]);
  const invite = () => modal(v, 'Team invite').children.find(child => child.options?.scrollable).getText();
  // Plain /invite says what it can do first.
  await send(v, '/invite');
  await until(() => rowsOf(v, 'Invite').length === 2, 'the invite menu');
  assert.deepEqual(rowsOf(v, 'Invite'), ['Someone new: get an invite code to send them', 'Choose which of your bots teammates can use']);
  // Someone new goes straight to the code. A new home has the bots the app comes with, none shared.
  await choose(v, 'Invite', /^Someone new/); await until(() => modal(v, 'Team invite'), 'the invite');
  assert.equal(modal(v, title), undefined, 'no bots question on the way to the code');
  assert.match(invite(), /No bot is shared, so a teammate’s message comes to you\./); assert.ok(shared().every(([, on]) => !on), 'none shared');
  await closeDialog(v, 'Team invite');
  // The bots choice lists the bots a teammate can use. @pair is not offered: it runs on Codex, and a teammate's question cannot run there.
  await send(v, '/invite'); await choose(v, 'Invite', /^Choose which of your bots/);
  await until(() => rowsOf(v, title).includes('Done'), 'the bots the app comes with');
  assert.deepEqual(rowsOf(v, title), ['[ ] @reviewer', '[ ] @lead', '[ ] @qa', '[ ] @elu', 'Done']);
  await choose(v, title, /^Done$/); await until(() => /No bot is shared, so a teammate’s message comes to you\./.test(status()), 'none shared');
  assert.equal(modal(v, 'Team invite'), undefined, 'choosing bots makes no code');
  // With no bots to share the menu offers only the code, and the code says nothing about bots.
  for (const bot of listBots()) removeBot(bot.name);
  await send(v, '/invite'); await until(() => rowsOf(v, 'Invite').length === 1, 'the code');
  await choose(v, 'Invite', /^Someone new/); await until(() => modal(v, 'Team invite'), 'the invite');
  assert.ok(!/bot/i.test(invite()), 'the invite says nothing about bots'); await closeDialog(v, 'Team invite');
  saveBot({ name: 'notes', vendor: 'claude', instructions: 'Keep notes.' }); saveBot({ name: 'docs', vendor: 'claude', instructions: 'Write docs.', shared: true });
  await send(v, '/invite'); await choose(v, 'Invite', /^Choose which of your bots/);
  await until(() => rowsOf(v, title).length === 3, 'the bots list');
  assert.deepEqual(rowsOf(v, title), ['[x] @docs', '[ ] @notes', 'Done']);
  await choose(v, title, /\[ \] @notes/); await until(() => rowsOf(v, title).includes('[x] @notes'), 'ticked'); await choose(v, title, /^Done$/);
  await until(() => /Teammates can write to @docs, @notes\./.test(status()), 'both shared');
  assert.deepEqual(shared(), [['docs', true], ['notes', true]]);
  // Joining asks nothing about bots: only to join, and what teammates can do here.
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => /Joined Docs with sara\. Their messages start sessions here, as if you typed them\./.test(status()), 'joined');
  assert.equal(modal(v, title), undefined);
});

test('joining with a code made for another computer asks whether it is yours: No is first and marks nothing, Yes marks it', async t => {
  const joined = { id: 'team-1', name: 'Core', inviter: { name: 'sara', fingerprint: 'bbbbbbbb' }, mineOffer: { key: SARA } };
  const { v, peer } = await teamView(t, { peer: fakePeer({ joined }) }), status = () => v.panels.status.getText(), title = "Is sara's computer yours too?";
  const marked = () => peer.sent().filter(row => row.type === 'mine');
  // Enter on the first row is No.
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => rowsOf(v, title).length === 2, 'the question');
  assert.deepEqual(rowsOf(v, title), ['No', 'Yes, both are mine']);
  await until(() => /Only say yes if you set up both computers\./.test(v.text()), 'the note under the question');
  v.input.write('\r'); await until(() => /Joined Core with sara\..*Not marked as yours\./.test(status()), 'no');
  assert.deepEqual(marked(), []);
  // Esc is No too.
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => modal(v, title), 'the question again'); v.input.write('\x1b');
  await until(() => !modal(v, title) && /Not marked as yours\./.test(status()), 'esc');
  assert.deepEqual(marked(), []);
  // Yes marks the inviter's computer here, and says how to start a session there.
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await choose(v, title, /^Yes/);
  await until(() => /Joined Core with sara\. Marked as yours\. Type @sara-box first in the new session box to start a session there\./.test(status()), 'yes');
  assert.deepEqual(marked(), [{ type: 'mine', key: SARA }]);
});

test('a session on my other computer that waits for y or n shows n once in the key bar, and @name of that computer names it in the new session box', async t => {
  const at = new Date().toISOString(), base = { machine: SARA, createdAt: at, lastAt: at, title: 'Make coupons upper case', steps: [], entries: [] };
  const remote = [{ ...base, id: '11111111-1111-4111-8111-111111111111', state: 'running', approvals: [{ id: 'approval-1', summary: 'Run ls', at }] },
    { ...base, id: '22222222-2222-4222-8222-222222222222', state: 'answered', title: 'Uppercase plan', plan: { title: 'Uppercase coupons', description: 'Make coupon codes upper case.', goal: 'Codes match in any case.', objectives: ['Codes are upper case'], priority: 'low', severity: 'low', state: 'proposed', subtasks: [], met: [] }, approvals: [] }];
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], mine: [{ key: SARA, mine: true, theirs: true }], remote }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, keys = () => v.panels.keys.getText();
  await until(() => board.items.map(plainItem).some(row => /wants to run ls/.test(row)), 'the remote rows');
  // In the new session box, @sara-box first says the session starts there.
  const ask = v.panels.ask; ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box');
  v.input.write('@sara-box fix the flaky test');
  await until(() => /New session on @sara-box/.test(ask._label.getText()), 'the label names the computer');
  ask.clearValue(); ask.cancel();
  board.focus(); selectRow(board, /wants to run ls/);
  await until(() => /y allow {2}n deny {2}enter open {2}tab next/.test(keys()), 'approval keys');
  assert.doesNotMatch(keys(), /new session/);
  // A Task waiting in a session started from here waits under Needs you, marked with the computer.
  selectRow(board, /on sara-box · Uppercase plan/);
  await until(() => /y approve {2}n reject {2}enter open {2}tab next/.test(keys()), 'Task keys');
  assert.doesNotMatch(keys(), /new session/);
});

test('over a session on my other computer the box writes to my agent here, started once and then continued, and @ that computer writes there', async t => {
  const at = new Date().toISOString(), id = '44444444-4444-4444-8444-444444444444';
  const remote = [{ id, machine: SARA, createdAt: at, lastAt: at, title: 'Native replay e2e handoff', state: 'needs_input', question: 'Which batch results?', choices: ['Mine', 'New ones'], steps: [], entries: [{ role: 'You', at, text: 'Start the handoff' }], approvals: [] }];
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], mine: [{ key: SARA, mine: true, theirs: true }], remote }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, ask = v.panels.ask, sentThere = () => peer.sent().filter(row => row.type === 'remoteSend');
  await until(() => board.items.map(plainItem).some(row => /Native replay e2e handoff/.test(row)), 'the row of the session there');
  board.focus(); selectRow(board, /on sara-box/);
  await until(() => /Message your agent here/.test(ask._label.getText()), 'the box says where a message goes');
  await until(() => /Answer it there: @sara-box 1/.test(v.panels.chat.getText()), 'how to answer the question there');
  assert.match(v.panels.chat.getText(), /You → @sara-box/);
  // No @name: the first message starts my agent here, in this project, as a new session that helps that one.
  await send(v, 'can you help this remote agent with the files it needs');
  await until(() => pendingRequests(p.root).some(row => row.helps), 'my agent here starts');
  const first = pendingRequests(p.root).find(row => row.helps);
  assert.deepEqual(first.helps, { machine: SARA, remoteId: id, name: 'sara-box', title: 'Native replay e2e handoff' });
  assert.equal(first.goal, 'can you help this remote agent with the files it needs'); assert.equal(first.continuationTaskId, null);
  assert.equal(helperLink(SARA, id).requestId, first.id);
  assert.deepEqual(sentThere(), [], 'nothing went to the session there');
  // Before it started, the next message goes with the first.
  await send(v, 'and the logs');
  await until(() => pendingRequests(p.root).find(row => row.id === first.id)?.goal === `${first.goal}\n\nand the logs`, 'with the first message');
  // Once it started, the next one continues it: one helper for that session.
  const repo = repository(p.root);
  saveTask(repo, { id: '1', kind: 'conversation', goal: first.goal, state: 'answered', worktree: repo.root, base: null, branch: null, createdAt: at, runs: [], reviews: [], responses: [], messages: [{ at, text: first.goal }], sessions: {}, result: null, helps: first.helps });
  updateRequest(p.root, first.id, { taskId: '1', state: 'done' });
  board.focus(); selectRow(board, /on sara-box/);
  await send(v, 'what does it still need?');
  await until(() => pendingRequests(p.root).some(row => row.continuationTaskId === '1' && row.goal === 'what does it still need?'), 'the helper is continued');
  assert.equal(pendingRequests(p.root).filter(row => row.helps).length, 1);
  await until(() => /You \(waiting\)/.test(v.panels.chat.getText()), 'the message to it shows beside the session there');
  // @ that computer, by its row's name or its owner's there, writes to the session there without it.
  board.focus(); selectRow(board, /on sara-box/);
  ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box');
  // The key bar says the same: Enter writes to my agent here, @sara-box writes there.
  await until(() => /enter send to your agent here {2}@sara-box writes there/.test(v.panels.keys.getText()), 'the keys say where Enter sends');
  v.input.write('@sara-box 1');
  await until(() => /Message the session on @sara-box/.test(ask._label.getText()), 'the box says it goes there');
  await until(() => /enter send to @sara-box/.test(v.panels.keys.getText()), 'and the keys');
  ask.submit();
  await until(() => sentThere().length === 1, 'sent there');
  assert.deepEqual(sentThere()[0], { type: 'remoteSend', id, text: '1' });
  await send(v, '@sara Mine');
  await until(() => sentThere().length === 2, 'sent there again');
  assert.deepEqual(sentThere()[1], { type: 'remoteSend', id, text: 'Mine' });
  assert.equal(pendingRequests(p.root).filter(row => row.continuationTaskId === '1').length, 1, 'neither went to my agent here');
});

test("over a session on my other computer, its @name that is also a name on my team keeps the box on that computer, never a teammate ask", async t => {
  const at = new Date().toISOString(), id = '55555555-5555-4555-8555-555555555555';
  const remote = [{ id, machine: SARA, createdAt: at, lastAt: at, title: 'Roll the release', state: 'needs_input', question: 'Ship it?', choices: [], steps: [], entries: [{ role: 'You', at, text: 'Roll the release' }], approvals: [] }];
  const p = project(later(t)); environment(t, p.parent);
  // sara-box is mine; on the team it goes by sara, so @sara names it there and is a team name too.
  const peer = fakePeer({ items: [], mine: [{ key: SARA, mine: true, theirs: true }], remote }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, ask = v.panels.ask, label = () => ask._label.getText();
  await until(() => board.items.map(plainItem).some(row => /Roll the release/.test(row)), 'the row of the session there');
  board.focus(); selectRow(board, /on sara-box/);
  await until(() => /Message your agent here/.test(label()), 'the session there under the cursor');
  ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box');
  v.input.write('@sara second message');
  await until(() => /Message the session on @sara-box/.test(label()), 'the box says it goes there');
  assert.doesNotMatch(label(), /teammate|Ask @/);
  await until(() => /enter send to @sara-box/.test(v.panels.keys.getText()), 'and the keys');
  ask.submit();
  await until(() => peer.sent().some(row => row.type === 'remoteSend'), 'sent there');
  assert.deepEqual(peer.sent().filter(row => row.type === 'remoteSend'), [{ type: 'remoteSend', id, text: 'second message' }]);
  assert.deepEqual(peer.sent().filter(row => row.type === 'ask'), [], 'no teammate was asked anything');
});

// A session open on this computer, with sara's computer marked as mine (mine: its row of mineRows()) and li a teammate.
async function ownSession(t, mine, size = {}) {
  const at = new Date().toISOString(), p = project(later(t)); environment(t, p.parent);
  const repo = repository(p.root);
  saveTask(repo, { id: '1', kind: 'conversation', goal: 'Tidy the notes', state: 'answered', worktree: repo.root, base: null, branch: null, createdAt: at, runs: [], reviews: [], responses: [], messages: [{ at, text: 'Tidy the notes' }], sessions: {}, result: null });
  // What that computer listed last: Sessions gives it a heading once it has listed.
  const peer = fakePeer({ items: [], mine: [{ key: SARA, ...mine }], machines: [{ key: SARA, listedAt: at, projects: [], sessions: [] }] }), v = await view(t, { repo, dashboard: true, peer, ...size });
  const board = v.panels.board, ask = v.panels.ask, palette = v.panels.palette;
  await until(() => board.items.map(plainItem).some(row => /Tidy the notes/.test(row)), 'the session here');
  board.focus(); selectRow(board, /Tidy the notes/);
  // Beside the list the session shows at once; on a small screen Enter opens it.
  if (!v.current.layout?.wide && v.current.view !== 'chat') v.input.write('\r');
  await until(() => /^ Message /.test(ask._label.getText()), 'the session here is open');
  ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box');
  return { v, peer, board, ask, palette, label: () => ask._label.getText(), status: () => v.panels.status.getText(),
    rows: () => palette.hidden ? [] : palette.items.map(item => item.getText().replace(/\s+/g, ' ').trim()),
    type: text => { ask.clearValue(); v.input.write(text); } };
}
// The box label of a message to another computer of mine: the longest of its forms that fits in the box, drawn whole on the screen.
async function assertLabel(v, ask, forms) {
  const room = ask.width - 4, wanted = forms.find(form => form.length <= room) ?? forms.at(-1), label = ask._label.getText();
  assert.equal(label, wanted, `the longest form that fits ${room} columns`);
  // A label that was set again is blank in the screen's rows until the next render.
  v.current.screen.render();
  assert.ok(v.lines().some(line => line.includes(wanted.trim())), `the screen shows it whole: ${wanted.trim()}\n${v.lines().join('\n')}`);
  return wanted;
}
const ASK_MINE = [' Ask @sara-box · your computer · Enter sends it there, the reply shows here ', ' Ask @sara-box · your computer ', ' Ask @sara-box '];
// A narrow box keeps that it waits before whose it is.
const ASK_WAITING = [' Ask @sara-box · your computer · waiting for it to confirm · Enter sends it there, the reply shows here ', ' Ask @sara-box · your computer · waiting for it to confirm ', ' Ask @sara-box · waiting for it to confirm ', ' Ask @sara-box '];

test("in a session open on this computer, my other computer reads as your computer in the @ list, the box and the sent line, under the name Sessions calls it, never as a teammate", async t => {
  const { v, peer, board, ask, label, status, rows, type } = await ownSession(t, { mine: true, theirs: true });
  // Sessions calls it by its box name, and so does the @ list: one name, never the one it has on the team.
  await until(() => board.items.map(plainItem).some(row => /ON SARA-BOX · ONLINE/.test(row)), 'its heading in Sessions');
  type('@sa');
  await until(() => rows().some(row => /^@sara-box your computer · online$/.test(row)), 'the @ list calls it your computer');
  assert.deepEqual(rows().filter(row => /sara/.test(row)), ['@sara-box your computer · online'], 'once, under the one name');
  assert.ok(!rows().some(row => /teammate/.test(row)), 'and never a teammate');
  type('@l'); await until(() => rows().some(row => /^@li teammate · offline$/.test(row)), 'a teammate keeps the word');
  type('@sara-box what runs there?');
  await until(() => label() === ASK_MINE[0], 'the box says whose it is and what Enter does');
  // The name it has on the team still names it when typed, and the box shows the one name.
  type('@sara what runs there?');
  await until(() => label() === ASK_MINE[0], 'its team name reaches it too');
  assert.doesNotMatch(label(), /teammate/);
  ask.submit();
  await until(() => peer.sent().some(row => row.type === 'ask'), 'asked');
  const asked = peer.sent().find(row => row.type === 'ask');
  assert.deepEqual([asked.to, asked.text], [SARA, 'what runs there?'], 'asked by its key, since the daemon does not know its box name');
  await until(() => /Sent to @sara-box, your computer\. Its reply shows in this thread\./.test(status()), 'and the line after sending');
  await send(v, '/peers');
  await until(() => /^› 0 of 1 teammates online · 1 of 1 of your computers online: @sara-box \(direct\)$/.test(status().trim()), '/peers counts it apart, under the same name');
});

for (const [columns, rows] of [[140, 50], [80, 24]]) test(`at ${columns}x${rows} the box label of a message to my other computer fits the box, and gives up its last part before it would be cut`, async t => {
  const own = await ownSession(t, { mine: true, theirs: true }, { columns, rows });
  own.type('@sara-box what runs there?');
  await until(() => /^ Ask @sara-box/.test(own.label()), 'the label');
  const shown = await assertLabel(own.v, own.ask, ASK_MINE);
  assert.match(shown, /your computer/, 'it still says whose it is at this size');
  if (columns === 80) assert.equal(shown, ASK_MINE[1], 'beside the list on a small screen, what Enter does gives way');
  own.type('@sa'); await until(() => own.rows().some(row => /^@sara-box your computer · online$/.test(row)), 'the @ list at this size');
  await until(() => own.v.lines().some(line => /@sara-box\s+your computer · online/.test(line)), 'the @ list drawn whole');
});

for (const [columns, rows] of [[160, 40], [140, 50], [80, 24]]) test(`at ${columns}x${rows} a computer of mine that has not marked this one back says it waits, in the @ list, the box, the sent line and /peers`, async t => {
  const { v, peer, ask, label, status, rows: listed, type } = await ownSession(t, { mine: true, theirs: false }, { columns, rows });
  type('@sa');
  await until(() => listed().some(row => /^@sara-box your computer · waiting for it to confirm$/.test(row)), 'the @ list says it waits');
  assert.ok(!listed().some(row => /teammate|@sara-box your computer · online/.test(row)), 'neither a teammate nor fully mine');
  type('@sara-box what runs there?');
  await until(() => /^ Ask @sara-box/.test(label()), 'the label');
  const shown = await assertLabel(v, ask, ASK_WAITING);
  assert.match(shown, /waiting for it to confirm/, 'that it waits stays at this size');
  if (columns === 80) assert.equal(shown, ASK_WAITING[2], 'beside the list on a small screen, that it waits stays and whose it is gives way');
  ask.submit();
  await until(() => peer.sent().some(row => row.type === 'ask' && row.to === SARA), 'asked');
  // Beside the list on a small screen a long line is cut at a word after two rows: its first sentence shows whole.
  await until(() => (columns === 80 ? /Sent to @sara-box, your computer \(waiting for it to confirm\)\. / : /Sent to @sara-box, your computer \(waiting for it to confirm\)\. Its reply shows in this thread\./).test(status()), 'the line after sending');
  await send(v, '/peers');
  await until(() => (columns === 80 ? /^› 0 of 1 teammates online · 1 of 1 of your computers online: @sara-box \(direct\)/ : /^› 0 of 1 teammates online · 1 of 1 of your computers online: @sara-box \(direct\) · waiting for @sara-box to confirm$/).test(status().trim()), '/peers says which one waits');
  await send(v, '/mine');
  await until(() => /^› @sara-box: waiting for it to mark this machine too/.test(status().trim()), '/mine, as before');
});

test('in Chats my other computer is yours in the bar, the box, its screen, the threads and the lines after sending, under the name Sessions calls it', { timeout: 30000 }, async t => {
  const id = 'd'.repeat(16), peer = fakePeer({ mine: [{ key: SARA, mine: true, theirs: true }] }); peer.channels = [{ id, name: 'ops', members: [ME, LI] }];
  const { v } = await teamView(t, { peer }), [bar] = v.panels.teamLists, ask = v.panels.ask, palette = v.panels.palette;
  const label = () => ask._label.getText(), status = () => v.panels.status.getText(), body = title => modal(v, title).children.find(child => child.options?.scrollable).getText();
  const rows = () => palette.hidden ? [] : palette.items.map(item => item.getText().replace(/\s+/g, ' ').trim());
  const type = async text => { ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box'); ask.clearValue(); v.input.write(text); };
  // The bar: one row, by its box name, marked yours; li stays as he was.
  // (A number at the end of a row counts its threads that wait.)
  await until(() => bar.items.some(item => /^● @sara-box\s+yours · direct(\s+\d+)?$/.test(plainItem(item).trimEnd())), 'its row in the bar');
  assert.ok(!bar.items.some(item => /@sara(?!-box)/.test(plainItem(item))), 'never under its name on the team');
  assert.ok(bar.items.some(item => /^○ @li\s+offline(\s+\d+)?$/.test(plainItem(item).trimEnd())), 'a teammate reads as before');
  // Nothing open names no teammate either.
  await openRow(v, /@sara-box/, '@sara-box');
  await until(() => label() === ' Message @sara-box · your computer ', 'the box of its direct chat');
  // The threads with it name it the same way.
  assert.ok(threadLines(v).some(line => /@sara-box answered · Use the v2 endpoint\./.test(line)), threadLines(v).join('\n'));
  assert.ok(!threadLines(v).some(line => /@sara(?!-box)/.test(line)), 'no thread names it by its team name');
  // Its screen: your computer, and t trusts it. What is held or continued is said of it, never of them.
  bar.focus(); v.input.write('t'); await until(() => modal(v, 'Your computer @sara-box'), 'its screen');
  assert.match(body('Your computer @sara-box'), /Trust: not trusted · paths go out as \[path\]\.\nHold replies: off · your replies and results go to it when ready\.\nAuto-continue: off · its answers wait in its thread\.\n\nt trusts it · h holds replies · o turns auto-continue on$/);
  assert.doesNotMatch(body('Your computer @sara-box'), /teammate|them|Waiting for it/i);
  v.input.write('t'); await until(() => modal(v, 'Trust @sara-box'), 'the confirm');
  assert.match(body('Trust @sara-box'), /Trust @sara-box\? Paths on this machine reach it as written\.\nSecrets are still held back\./);
  await closeDialog(v, 'Trust @sara-box', 'y');
  await until(() => /Trusted @sara-box\. Paths go out as they are\. Its text shows as sent\./.test(status()), 'trusted, in its words');
  assert.deepEqual(peer.sent().at(-1), { type: 'trust', key: SARA });
  // A message in its direct chat.
  await send(v, 'what runs there?');
  await until(() => peer.sent().at(-1).type === 'ask', 'sent');
  assert.deepEqual(peer.sent().at(-1), { type: 'ask', to: SARA, project: null, text: 'what runs there?' });
  await until(() => /Sent to @sara-box, your computer\. Its reply shows in this thread\./.test(status()), 'the line after sending');
  // The @ list of Chats, and @name from anywhere in Chats: by either name, asked by its key, with the project it shares.
  await type('@sa'); await until(() => rows().some(row => /^@sara-box your computer · online · direct$/.test(row)), 'the @ list of Chats');
  assert.deepEqual(rows().filter(row => /sara/.test(row)), ['@sara-box your computer · online · direct']);
  await openRow(v, /# general/, '#general');
  await send(v, '@sara-box web How do we deploy?');
  await until(() => peer.sent().at(-1).text === 'How do we deploy?', 'asked by @name');
  assert.deepEqual(peer.sent().at(-1), { type: 'ask', to: SARA, project: 'web', text: 'How do we deploy?' });
  await until(() => /Sent to @sara-box, your computer\. Its reply shows in this thread\./.test(status()), 'the same line');
  await send(v, '@sara And the tests?');
  await until(() => peer.sent().at(-1).text === 'And the tests?', 'asked by its team name');
  assert.equal(peer.sent().at(-1).to, SARA);
  // /peers counts it apart; /invite lists it as yours and adds it by the name shown.
  await send(v, '/peers');
  await until(() => /^› 0 of 1 teammates online · 1 of 1 of your computers online: @sara-box \(direct\)$/.test(status().trim()), '/peers');
  await openRow(v, /# ops/, '#ops');
  await type('/invite '); await until(() => rows().some(row => /^@sara-box add to #ops · your computer · online$/.test(row)), '/invite lists it as yours');
  await send(v, '/invite @sara-box');
  await until(() => /Added @sara-box to #ops\./.test(status()), 'added under the same name');
  assert.deepEqual(peer.sent().at(-1), { type: 'channelSet', team: 'team-1', id, name: 'ops', members: [ME, LI, SARA] });
  // A channel where everyone else is a computer of mine names no teammate.
  peer.channels = [{ id, name: 'ops', members: [ME, SARA] }];
  await until(() => label() === ' Message #ops · the first of your computers to take it answers ', 'the channel box');
  await send(v, 'who is free?');
  await until(() => /Sent to #ops\. The first of your computers to take it answers\./.test(status()), 'and its line');
  // Who is in a channel counts a computer of mine apart, never as a teammate.
  const who = 'Who is in #ops', ticked = pattern => until(() => rowsOf(v, who).some(line => pattern.test(line)), `${pattern}`);
  selectRow(bar, /# ops/); bar.focus(); v.input.write('m'); await ticked(/\[x\] @sara-box/);
  assert.deepEqual(rowsOf(v, who), ['[x] @sara-box', '[ ] @li', 'Save'], 'the list names it as everywhere');
  await choose(v, who, /\[ \] @li/); await ticked(/\[x\] @li/); await choose(v, who, /^Save$/);
  await until(() => /#ops now has 1 teammate, your computer and you\./.test(status()), 'the saved line');
  peer.channels = [{ id, name: 'ops', members: [ME, SARA] }];
  await until(() => label() === ' Message #ops · the first of your computers to take it answers ', 'the channel as it was');
  bar.focus(); v.input.write('m'); await ticked(/\[x\] @sara-box/); await choose(v, who, /\[x\] @sara-box/); await ticked(/\[ \] @sara-box/); await choose(v, who, /^Save$/);
  await until(() => /Tick at least one teammate or one of your computers\. To leave the channel, press x on it\./.test(status()), 'what a channel needs');
  bar.focus(); v.input.write('n'); await closeDialog(v, 'New channel', 'lab');
  await choose(v, 'Who is in #lab', /\[ \] @sara-box/); await until(() => rowsOf(v, 'Who is in #lab').some(line => /\[x\] @sara-box/.test(line)), 'ticked'); await choose(v, 'Who is in #lab', /Create channel/);
  await until(() => /Created #lab with your computer\. It sees it when it is online\./.test(status()), 'a channel with only my computer in it');
  // t with nobody chosen says a computer of mine can be chosen too.
  selectRow(bar, /\+ Add channel/); bar.focus(); v.input.write('t');
  await until(() => /Choose a teammate or one of your computers first\./.test(status()), 'what t says with nobody chosen');
});

test('in Chats a computer of mine that has not marked this one back says it waits in the bar, the box, its screen and the @ list', { timeout: 30000 }, async t => {
  const peer = fakePeer({ items: [], mine: [{ key: SARA, mine: true, theirs: false }] });
  const { v } = await teamView(t, { peer }), [bar] = v.panels.teamLists, ask = v.panels.ask, palette = v.panels.palette;
  const label = () => ask._label.getText(), status = () => v.panels.status.getText(), body = title => modal(v, title).children.find(child => child.options?.scrollable).getText();
  const rows = () => palette.hidden ? [] : palette.items.map(item => item.getText().replace(/\s+/g, ' ').trim());
  // Not mine yet, so the row says that it waits in place of yours, in the few words the bar has room for.
  await until(() => bar.items.some(item => /^● @sara-box\s+waiting to confirm$/.test(plainItem(item).trimEnd())), 'its row in the bar');
  // A bar with the room for it, as under 100 columns, says it whole.
  const member = (waiting, online = true) => ({ status: { key: ME, teams: [{ id: 'team-1', name: 'Core', members: [{ key: ME, name: 'ana' }, { key: SARA, name: 'sara-box', online, path: 'direct', mine: true, waiting }] }] }, items: [] });
  const drawn = (frame, width) => visible(chatBar(frame, width, false).find(row => row.value?.type === 'member').line).replace(/\s+/g, ' ').trim();
  assert.equal(drawn(member(true), 78), '● @sara-box waiting for it to confirm');
  assert.equal(drawn(member(true), 40), '● @sara-box waiting to confirm');
  assert.equal(drawn(member(false), 40), '● @sara-box yours · direct');
  assert.equal(drawn(member(false, false), 40), '○ @sara-box yours · offline');
  await openRow(v, /@sara-box/, '@sara-box');
  await until(() => label() === ' Message @sara-box · your computer · waiting for it to confirm ', 'the box of its direct chat');
  const title = 'Your computer @sara-box · waiting for it to confirm';
  bar.focus(); v.input.write('t'); await until(() => modal(v, title), 'its screen');
  assert.match(body(title), /^Waiting for it to confirm: on @sara-box, type \/mine @ana\.\n\nKey: /, 'and what ends the wait');
  modal(v, title).children.find(child => child.type === 'textbox').emit('cancel'); await until(() => !modal(v, title), 'closed');
  await send(v, 'what runs there?');
  await until(() => /Sent to @sara-box, your computer \(waiting for it to confirm\)\. Its reply shows in this thread\./.test(status()), 'the line after sending');
  ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box'); ask.clearValue(); v.input.write('@sa');
  await until(() => rows().some(row => /^@sara-box your computer · waiting for it to confirm$/.test(row)), 'the @ list of Chats');
});

test('/access says a message from my other computer follows the setting too, and names no teammate where every other member is mine', { timeout: 30000 }, async t => {
  const notes = (v, title) => modal(v, title).children.filter(child => child.type !== 'list').map(child => child.getText?.() ?? '').join('\n');
  await t.test('a team with a teammate and a computer of mine', async t => {
    const p = project(later(t)); environment(t, p.parent);
    const peer = fakePeer({ items: [], mine: [{ key: SARA, mine: true, theirs: true }] }), v = await view(t, { repo: repository(p.root), peer });
    await send(v, '/access'); await until(() => modal(v, 'What teammates can do here'), 'the handling');
    assert.match(notes(v, 'What teammates can do here'), /Messages from your computer @sara-box follow this too\./);
    await choose(v, 'What teammates can do here', /^Manual/); await until(() => modal(v, 'Rules for teammates'), 'the rules');
    assert.match(modal(v, 'Rules for teammates').children.find(child => child.options?.scrollable).getText(), /Messages from your computer @sara-box follow this too\./);
    await closeDialog(v, 'Rules for teammates', '');
    assert.deepEqual(peer.calls.filter(row => row[0] === 'saveTeamAccess').map(row => row[2].handling), ['manual']);
  });
  await t.test('a team of my computers only', async t => {
    const p = project(later(t)); environment(t, p.parent);
    const peer = fakePeer({ items: [], mine: [{ key: SARA, mine: true, theirs: true }, { key: LI, mine: true, theirs: true }] }), v = await view(t, { repo: repository(p.root), peer });
    await send(v, '/access'); await until(() => modal(v, 'What your computers can do here'), 'the handling, in its words');
    assert.equal(modal(v, 'What teammates can do here'), undefined);
    await choose(v, 'What your computers can do here', /^Auto/); await closeDialog(v, 'Rules for your computers', '');
    assert.deepEqual(peer.calls.filter(row => row[0] === 'saveTeamAccess').map(row => row[2].handling), ['auto']);
  });
  await t.test('a team of teammates reads as before', async t => {
    const p = project(later(t)); environment(t, p.parent);
    const peer = fakePeer({ items: [] }), v = await view(t, { repo: repository(p.root), peer });
    await send(v, '/access'); await until(() => modal(v, 'What teammates can do here'), 'the handling');
    assert.doesNotMatch(notes(v, 'What teammates can do here'), /your computer/);
    await choose(v, 'What teammates can do here', /^Auto/); await closeDialog(v, 'Rules for teammates', '');
  });
});

test('Sessions names a message from my other computer by the name it shows under everywhere, and /mine names no teammate for a name nobody has', async t => {
  const at = new Date().toISOString(), p = project(later(t)); environment(t, p.parent);
  const repo = repository(p.root), origin = { kind: 'handoff', own: true, peer: SARA, name: 'sara', a2aTaskId: 'task-1' };
  // A session its message started here, and a question from it that waits for me.
  saveTask(repo, { id: '1', kind: 'conversation', goal: 'Run the release checks', state: 'answered', worktree: repo.root, base: null, branch: null, createdAt: at, origin, runs: [], reviews: [], responses: [], messages: [{ at, text: 'Run the release checks' }], sessions: {}, result: null });
  const items = [{ id: 'incoming-1', kind: 'incoming', peer: SARA, name: 'sara', project: null, text: 'Where are the fixtures?', at: ago(1), state: 'submitted', threadId: 'th-1' }];
  const peer = fakePeer({ items, mine: [{ key: SARA, mine: true, theirs: true }] }), v = await view(t, { repo, dashboard: true, peer });
  const board = v.panels.board, status = () => v.panels.status.getText(), text = () => board.items.map(plainItem).join('\n');
  await until(() => /Run the release checks/.test(text()) && /@sara-box question/.test(text()), 'both rows');
  assert.doesNotMatch(text(), /@sara(?!-box)/, 'never under its name on the team');
  // The rows as the list is built: the session its message started carries the same name.
  const rows = boardRows([{ root: repo.root, name: 'sample', tasks: [readTask(repo, '1')], queue: [] }], Date.now(), { called: (name, key) => key === SARA ? '@sara-box' : peerName(name, key) });
  assert.equal(rows.find(row => row.kind === 'task').agent, '@sara-box');
  assert.equal(boardRows([{ root: repo.root, name: 'sample', tasks: [readTask(repo, '1')], queue: [] }]).find(row => row.kind === 'task').agent, '@sara', 'without the app, as the team names it');
  await send(v, '/mine @nobody');
  await until(() => /No computer on your team is called @nobody\./.test(status()), '/mine names no teammate');
});

test('Sessions lists every session of my other computer in this repository under its name, and Projects opens its other projects', async t => {
  const now = Date.now(), at = minutes => new Date(now - minutes * 60000).toISOString(), SHOP = 'e'.repeat(64);
  const p1 = '1'.repeat(16), p2 = '2'.repeat(16);
  const session = (ref, title, minutes, extra = {}) => ({ id: `${ref.slice(-1)}1111111-1111-4111-8111-11111111111${ref.slice(-1)}`, ref, project: ref.split(':')[0], title, state: 'answered', at: at(minutes), createdAt: at(minutes + 1), approvals: [], by: 'you', who: null, ...extra });
  const machines = [{ key: SARA, listedAt: at(0), older: false, projects: [{ id: p1, name: 'shop', repoId: SHOP, home: false }, { id: p2, name: 'ana', repoId: null, home: true }],
    sessions: [session(`${p1}:1`, 'Typed there by hand', 5), session(`${p1}:2`, 'Kim asked for a fix', 2, { by: 'teammate', who: 'kim', state: 'running', approvals: [{ id: 'approval-1', role: 'lead', summary: 'Run npm test', at: at(1) }] }), session(`${p2}:3`, 'Tidy my notes', 3, { state: 'running', approvals: [{ id: 'approval-2', role: 'lead', summary: 'Run rm notes.tmp', at: at(2) }] })] },
    // li is not mine: what is kept for li shows nowhere.
    { key: LI, listedAt: at(0), projects: [{ id: p1, name: 'shop', repoId: SHOP }], sessions: [session(`${p1}:4`, 'Li private', 1)] }];
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], mine: [{ key: SARA, mine: true, theirs: true }], machines, repoId: SHOP }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, rows = () => board.items.map(plainItem).map(row => row.trim());
  await until(() => rows().some(row => /ON SARA-BOX · ONLINE/.test(row)), 'the heading of my other computer');
  const at2 = rows(), heading = at2.findIndex(row => /ON SARA-BOX · ONLINE/.test(row));
  assert.match(at2[heading + 1], /Kim asked for a fix/); assert.match(at2[heading + 2], /Typed there by hand/);
  assert.ok(!at2.some(row => /Tidy my notes|Li private/.test(row)), 'another project of it, and a computer that is not mine, are not listed here');
  // Its approval also waits under Needs you, marked with the computer.
  assert.ok(at2.findIndex(row => /on sara-box · wants to run npm/.test(row)) >= 0 && at2.findIndex(row => /on sara-box · wants to run npm/.test(row)) < heading);
  // So does one in its home folder, which Sessions does not list under this project.
  assert.ok(at2.findIndex(row => /on sara-box · wants to run rm/.test(row)) >= 0 && at2.findIndex(row => /on sara-box · wants to run rm/.test(row)) < heading);
  // Projects lists its other project; Enter opens it in Sessions under a heading of its own.
  await send(v, '/projects'); await until(() => v.current.view === 'projects' && v.panels.projectsList.items.some(item => /ana on sara-box/.test(plainItem(item))), 'the other project');
  assert.ok(!v.panels.projectsList.items.some(item => /shop on sara-box/.test(plainItem(item))), 'the project of this repository is in Sessions');
  v.panels.projectsList.focus(); selectRow(v.panels.projectsList, /ana on sara-box/); v.input.write('\r');
  await until(() => v.current.view === 'tasks' && rows().some(row => /ANA ON SARA-BOX/.test(row)), 'its sessions');
  assert.match(rows()[rows().findIndex(row => /ANA ON SARA-BOX/.test(row)) + 1], /Tidy my notes/);
  // The row under the cursor is opened: watched on that computer.
  await until(() => peer.sent().some(row => row.type === 'remoteWatch' && row.ref === `${p2}:3`), 'watched there');
  assert.match(rows()[board.selected], /Tidy my notes/, 'the cursor is on it');
  assert.equal(peer.sent().find(row => row.type === 'remoteWatch').to, SARA);
});

test("Projects says how many sessions of my other computer's project are not in this one, in a row that fits its line at 80 columns as at 160", async t => {
  const now = Date.now(), at = minutes => new Date(now - minutes * 60000).toISOString(), SHOP = 'e'.repeat(64), p2 = '2'.repeat(16);
  const session = (n, title) => ({ id: `${n}1111111-1111-4111-8111-11111111111${n}`, ref: `${p2}:${n}`, project: p2, title, state: 'answered', at: at(n), createdAt: at(n + 1), approvals: [], by: 'you', who: null });
  const machines = [{ key: SARA, listedAt: at(0), older: false, projects: [{ id: p2, name: 'ana', repoId: null, home: true }], sessions: [session(3, 'Tidy my notes'), session(4, 'Sort the photos')] }];
  for (const columns of [160, 80]) {
    const p = project(later(t)); environment(t, p.parent);
    const peer = fakePeer({ items: [], mine: [{ key: SARA, mine: true, theirs: true }], machines, repoId: SHOP }), v = await view(t, { repo: repository(p.root), dashboard: true, peer, columns, rows: 24 });
    const list = v.panels.projectsList, row = () => list.items.map(plainItem).find(item => /ana on sara-box/.test(item));
    await send(v, '/projects'); await until(() => v.current.view === 'projects' && row(), 'the other project');
    assert.ok(row().trimEnd().length <= list.width - 2, `it fits at ${columns}: ${row()}`);
    assert.match(row(), columns === 160 ? /online\s+2 sessions not in this project {2}\d+m ago/ : /online\s+2 not in this project/);
  }
});

// The wheel at a pane, as SGR reports in one read: up or down, a step each.
const wheelAt = (v, widget, step, times = 1) => v.input.write(`\x1b[<${step < 0 ? 64 : 65};${widget.aleft + 3};${widget.atop + 3}M`.repeat(times));
const pause = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));

test('a session on my other computer stays where the owner scrolled it through every draw and every update, stays at the top, and follows its end again once he is back there', { timeout: 30000 }, async t => {
  const at = new Date().toISOString(), said = n => Array.from({ length: n }, (_, index) => ({ role: index % 2 ? 'Claude' : 'You', at, text: `Line ${index + 1} of the long chat`, ...(index % 2 ? { lead: true } : {}) }));
  const remote = [{ id: '33333333-3333-4333-8333-333333333333', machine: SARA, createdAt: at, lastAt: at, title: 'Read the long chat', state: 'answered', steps: [], approvals: [], entries: said(60) },
    { id: '44444444-4444-4444-8444-444444444444', machine: SARA, createdAt: at, lastAt: at, title: 'A short one', state: 'answered', steps: [], approvals: [], entries: said(2) }];
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], mine: [{ key: SARA, mine: true, theirs: true }], remote }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, chat = v.panels.chat, ask = v.panels.ask;
  await until(() => board.items.some(item => /Read the long chat/.test(plainItem(item))), 'the remote row');
  board.focus(); selectRow(board, /Read the long chat/);
  await until(() => /Runs on @sara-box/.test(chat.getContent()) && chat.getScrollPerc(true) === 100, 'its chat, at the end');
  // The owner's cursor stays in the message box while he scrolls the chat with the trackpad.
  ask.focus(); await until(() => /Message your agent here · @sara-box/.test(ask._label.getText()), 'the message box names it');
  const end = chat.childBase;
  wheelAt(v, chat, -1, 10); await until(() => chat.childBase === end - 10, 'ten lines up');
  // The app draws every 30 ms here: none of those draws takes the chat back to its end.
  await pause(300);
  assert.equal(chat.childBase, end - 10, 'it stays on the lines he chose');
  // More arrives below: the place is kept.
  remote[0].entries = [...remote[0].entries, { role: 'Claude', at, text: 'Arrived while he read', lead: true }, ...said(6)];
  await until(() => /Arrived while he read/.test(chat.getContent()), 'the new lines'); await pause(150);
  assert.equal(chat.childBase, end - 10, 'what arrives below does not move it');
  // Up past the top it stays at the top, through every draw and update.
  wheelAt(v, chat, -1, 400); await until(() => chat.childBase === 0, 'the top');
  await pause(300);
  assert.equal(chat.childBase, 0, 'at the top it stays at the top');
  remote[0].entries = [...remote[0].entries, { role: 'Claude', at, text: 'Arrived at the top', lead: true }];
  await until(() => /Arrived at the top/.test(chat.getContent()), 'more new lines'); await pause(150);
  assert.equal(chat.childBase, 0, 'and never starts again from the bottom');
  // Back at the end, it follows the newest line again.
  wheelAt(v, chat, 1, 600); await until(() => chat.getScrollPerc(true) === 100, 'the end');
  remote[0].entries = [...remote[0].entries, { role: 'Claude', at, text: 'The newest line', lead: true }];
  await until(() => /The newest line/.test(chat.getContent()), 'the newest line'); await pause(150);
  assert.equal(chat.getScrollPerc(true), 100, 'it follows the end again');
  // Scrolled up, then another row and back: it opens at its end again.
  const before = chat.childBase;
  wheelAt(v, chat, -1, 20); await until(() => chat.childBase === before - 20, 'up again');
  board.focus(); selectRow(board, /A short one/); await until(() => !/Line 60 of the long chat/.test(chat.getContent()), 'the other row');
  selectRow(board, /Read the long chat/); await until(() => /Line 60 of the long chat/.test(chat.getContent()), 'the long chat again');
  await until(() => chat.getScrollPerc(true) === 100, 'opened at its end');
});

test('a session on my other computer keeps the lines the owner reads while its oldest entries leave the top and new ones land above its changes and its Task', { timeout: 30000 }, async t => {
  // The viewer keeps the last 200 entries of a session; this one has said more than that.
  const KEPT = 200, at = new Date().toISOString(), entry = n => ({ role: n % 2 ? 'Claude' : 'You', at, text: `Line ${n} of the long chat`, ...(n % 2 ? { lead: true } : {}) });
  const upTo = n => Array.from({ length: n }, (_, index) => entry(index + 1)).slice(-KEPT);
  const patch = Array.from({ length: 40 }, (_, index) => `+ changed line ${index + 1}`).join('\n'), subtasks = Array.from({ length: 30 }, (_, index) => ({ text: `Step ${index + 1} of the plan`, state: index ? 'todo' : 'doing' }));
  const session = { id: '55555555-5555-4555-8555-555555555555', machine: SARA, createdAt: at, lastAt: at, title: 'Read the long chat', state: 'running', approvals: [], entries: upTo(230),
    steps: [{ at, text: 'Reading the cart' }], diff: { summary: '1 file changed', patch }, plan: { title: 'Fix the totals', goal: 'Totals add up', priority: 'P2', severity: 'S3', state: 'approved', objectives: ['Totals add up'], subtasks, met: [] } };
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], mine: [{ key: SARA, mine: true, theirs: true }], remote: [session] }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, chat = v.panels.chat, ask = v.panels.ask;
  // A line as it reads: no colour, and no bar before a message's text.
  const bare = line => (line ?? '').replace(/\x1b\[[\d;]*m/g, '').replace(/^\s*┃/, '').trim();
  const top = () => bare(chat._clines?.[chat.childBase]), lineOf = text => (chat._clines ?? []).findIndex(line => bare(line) === text);
  // To a line, a wheel step a line, the owner's cursor in the message box.
  const scrollTo = async text => { const to = lineOf(text); assert.ok(to >= 0, text); wheelAt(v, chat, Math.sign(to - chat.childBase), Math.abs(to - chat.childBase)); await until(() => top() === text, text); };
  const more = async (entries, also = {}) => { const last = entries.at(-1).text; Object.assign(session, { entries, ...also }); await until(() => chat.getContent().includes(last), last); await pause(150); };
  await until(() => board.items.some(item => /Read the long chat/.test(plainItem(item))), 'the remote row');
  board.focus(); selectRow(board, /Read the long chat/);
  await until(() => /Runs on @sara-box/.test(chat.getContent()) && chat.getScrollPerc(true) === 100, 'its chat, at the end');
  ask.focus();
  // Reading the changes: an entry lands above them, two leave the top, a step and a subtask move on.
  await scrollTo('+ changed line 20');
  await more([...upTo(230), { role: 'Claude', at, text: 'A longer answer\nthat takes\nfour lines\nof the pane', lead: true }, entry(231)].slice(-KEPT),
    { steps: [...session.steps, { at, text: 'Running the tests' }], plan: { ...session.plan, subtasks: subtasks.map((step, index) => ({ ...step, state: index ? index === 1 ? 'doing' : 'todo' : 'done' })) } });
  assert.equal(top(), '+ changed line 20', 'the changes stay where he reads them');
  // Reading the chat: the oldest entries leave the top as new ones arrive.
  await scrollTo('Line 150 of the long chat');
  await more([...session.entries, ...Array.from({ length: 12 }, (_, index) => entry(232 + index))].slice(-KEPT));
  assert.equal(top(), 'Line 150 of the long chat', 'the entry he reads stays at the top of the pane');
  await pause(300);
  assert.equal(top(), 'Line 150 of the long chat', 'and through every draw after');
  // Reading a step when the work ends and the steps go: the place is the part after them, the Task.
  await scrollTo('Reading the cart');
  await more([...session.entries, entry(244)].slice(-KEPT), { state: 'answered' });
  assert.match(top(), /^Task · /, 'the part after the steps, from its first line');
  // At the top it stays at the top while the first entry there leaves.
  wheelAt(v, chat, -1, 2000); await until(() => chat.childBase === 0, 'the top');
  await more([...session.entries, entry(245), entry(246)].slice(-KEPT));
  assert.equal(chat.childBase, 0, 'at the top it stays at the top');
  // Back at the end, it follows the newest line again.
  wheelAt(v, chat, 1, 2000); await until(() => chat.getScrollPerc(true) === 100, 'the end');
  await more([...session.entries, entry(247)].slice(-KEPT));
  assert.equal(chat.getScrollPerc(true), 100, 'it follows the newest line');
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
  for (const text of ['Invite someone: /invite', 'Got a code? /join CODE']) assert.ok(empty.join(' ').replace(/\s+/g, ' ').includes(text), text);
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
  // There is no peer on or off: /peer on and /peer off are unknown commands.
  for (const gone of ['/ask @sara hello', '/handoff @li Fix the flaky upload test', '/review @sara', '/peer on', '/peer off']) { await send(v, gone); await until(() => status().includes(`Unknown command: ${gone.split(' ')[0]}.`), `${gone} is unknown`); }
  assert.ok(!peer.sent().some(row => ['handoff', 'review'].includes(row.type)), 'nothing sends a handoff or a review');
  await send(v, '/share'); await until(() => /Open a project to share it/.test(status()), 'share needs a project');
  // A home has the bots the app comes with, so /invite first asks which of them teammates may use.
  await send(v, '/invite'); await choose(v, 'Invite', /^Someone new/);
  await until(() => modal(v, 'Team invite'), 'invite code');
  assert.deepEqual(peer.calls.find(row => row[0] === 'createInvite').slice(1), ['team-1', { hours: 24 }]);
  assert.match(modal(v, 'Team invite').children.find(child => child.options?.scrollable).getText(), /k7qm-x2pd-9fhw[^]*Type \/share in a project so teammates can ask about it\./);
  await closeDialog(v, 'Team invite');
  assert.ok(!peer.calls.some(row => row[0] === 'share'), 'no project open, nothing shared');
  assert.equal(peer.calls.filter(row => row[0] === 'startPeer').length, 0, 'the daemon was running, so nothing was started');
  assert.equal(peer.sent().length, 2, 'only the two questions went out; refused and unknown commands send nothing');
});

test('a first /join asks to join and what teammates can do, then your name, then joins; the join starts the daemon itself', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ teamless: true, running: false }); let me = null;
  peer.identity = ({ create, name } = {}) => { if (create) { peer.calls.push(['identity', name]); me = { name }; return me; } if (!me) throw new Error('Create your peer identity first with elu id --name NAME.'); return me; };
  const v = await view(t, { repo: repository(p.root), peer });
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v); await until(() => modal(v, 'Your name'), 'name prompt');
  const field = modal(v, 'Your name').children.find(child => child.type === 'textbox');
  await until(() => field.__listener, 'name input'); field.setValue('ana'); field.submit();
  await until(() => /Joined Docs with sara\./.test(v.panels.status.getText()), 'joined after the name');
  assert.deepEqual(peer.calls.find(row => row[0] === 'identity'), ['identity', 'ana']);
  assert.ok(peer.calls.findIndex(row => row[0] === 'identity') < peer.calls.findIndex(row => row[0] === 'joinTeam'));
  assert.equal(peer.calls.filter(row => row[0] === 'startPeer').length, 0, 'joinTeam starts the daemon; the app asks nothing more');
});

test('Enter in the command list runs /peers, fills in /join, and shows a failed command\'s error; there is no /peer', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ teamless: true }), v = await view(t, { repo: repository(p.root), peer });
  const status = () => v.panels.status.getText(), palette = v.panels.palette;
  const type = async text => { v.panels.ask.focus(); v.panels.ask.readInput(); await until(() => v.panels.ask.__listener, 'message box'); v.panels.ask.clearValue(); v.input.write(text); await until(() => !palette.hidden, `list for ${text}`); };
  await type('/peer');
  assert.deepEqual(palette.items.map(item => item.getText().trim().split(/\s+/)[0]), ['/peers'], 'no /peer to turn anything on or off');
  v.input.write('\r');
  await until(() => /No team yet\. Invite someone with \/invite, or join with \/join CODE\./.test(status()), '/peers on no team');
  assert.equal(peer.calls.filter(row => row[0] === 'startPeer').length, 0);
  await type('/joi'); v.input.write('\r');
  await until(() => v.panels.ask.getValue() === '/join ' && /Usage: \/join code/.test(status()), '/join needs a code, so Enter fills it in');
  assert.equal(peer.sent().length, 0);
  await type('/chan'); v.input.write('\r');
  await until(() => /Open a session first/.test(status()) && palette.hidden, 'the error shows and the list stays closed');
  assert.equal(v.panels.ask.getValue(), '/changes', 'the command is kept');
});

test('the first /invite makes the team, named after the open project', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ teamless: true, access: {} }), v = await view(t, { repo: repository(p.root), peer });
  await send(v, '/invite @kim'); await until(() => /No team yet\. \/invite alone starts one/.test(v.panels.status.getText()), 'a name with no team');
  assert.deepEqual(peer.calls.filter(row => row[0] === 'createTeam'), []);
  await send(v, '/invite'); await choose(v, 'Invite', /^Someone new/);
  // What teammates can do here is asked before the team is made.
  await until(() => modal(v, 'What teammates can do here'), 'asked first');
  assert.deepEqual(peer.calls.filter(row => row[0] === 'createTeam'), [], 'no team before the answers');
  await choose(v, 'What teammates can do here', /^Auto/); await closeDialog(v, 'Rules for teammates', '');
  await until(() => modal(v, 'Team invite'), 'invite');
  assert.deepEqual(peer.calls.filter(row => row[0] === 'createTeam'), [['createTeam', path.basename(p.root)]]);
  assert.deepEqual(peer.calls.find(row => row[0] === 'createInvite').slice(1), ['team-1', { hours: 24 }]);
  await closeDialog(v, 'Team invite');
});

test('on no team, Esc on what teammates can do here makes no team and starts nothing', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ teamless: true, running: false, access: {} }), v = await view(t, { repo: repository(p.root), peer }), status = () => v.panels.status.getText();
  peer.startPeer = () => { peer.calls.push(['startPeer']); peer.running = true; return true; };
  await send(v, '/invite'); await choose(v, 'Invite', /^Someone new/);
  await until(() => modal(v, 'What teammates can do here'), 'asked first');
  v.input.write('\x1b'); await until(() => /Nothing was done\. No invite was made\./.test(status()), 'Esc makes nothing');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(peer.calls.filter(row => ['createTeam', 'startPeer', 'createInvite', 'saveTeamAccess'].includes(row[0])), [], 'no team, no daemon, no code');
  assert.equal(peer.onTeam(), false);
  // Esc on the rules makes nothing either.
  await send(v, '/invite'); await choose(v, 'Invite', /^Someone new/);
  await choose(v, 'What teammates can do here', /^Manual/); await until(() => modal(v, 'Rules for teammates'), 'the rules');
  modal(v, 'Rules for teammates').children.find(child => child.type === 'textbox').emit('cancel');
  await until(() => !modal(v, 'Rules for teammates'), 'closed');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(peer.calls.filter(row => ['createTeam', 'startPeer', 'createInvite', 'saveTeamAccess'].includes(row[0])), []);
});

test('a new person: /invite asks their name, makes the team, starts the daemon, then makes the code', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ teamless: true, running: false }); let me = null;
  peer.identity = ({ create, name } = {}) => { if (create) { peer.calls.push(['identity', name]); me = { name }; return me; } if (!me) throw new Error('Create your peer identity first with elu id --name NAME.'); return me; };
  peer.startPeer = () => { peer.calls.push(['startPeer']); peer.running = true; return true; };
  const v = await view(t, { repo: repository(p.root), peer });
  // On no team, opening the app starts nothing.
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(peer.calls.filter(row => row[0] === 'startPeer').length, 0, 'nothing started before the invite');
  await send(v, '/invite'); await choose(v, 'Invite', /^Someone new/); await until(() => modal(v, 'Your name'), 'name prompt');
  const field = modal(v, 'Your name').children.find(child => child.type === 'textbox');
  await until(() => field.__listener, 'name input'); field.setValue('ana'); field.submit();
  await choose(v, 'What teammates can do here', /^Auto/); await closeDialog(v, 'Rules for teammates', '');
  await until(() => modal(v, 'Team invite'), 'invite');
  const order = ['identity', 'createTeam', 'startPeer', 'createInvite'].map(name => peer.calls.findIndex(row => row[0] === name));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), JSON.stringify(order));
  await closeDialog(v, 'Team invite');
});

test('the invite window shows a short code and copies it; a drag over its row copies it too, and pasting that after /join joins with it', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer(), copied = [];
  const v = await view(t, { repo: repository(p.root), peer, clipboard: text => copied.push(text) });
  await send(v, '/invite'); await choose(v, 'Invite', /^Someone new/);
  await until(() => modal(v, 'Team invite'), 'invite');
  // The window copies the code as it opens, and says so.
  const body = modal(v, 'Team invite').children.find(child => child.options?.scrollable);
  assert.deepEqual(copied, ['k7qm-x2pd-9fhw']); assert.match(body.getText(), /^╭────────────────────╮\n│   k7qm-x2pd-9fhw   │\n╰────────────────────╯\n\nCopied to your clipboard\. One use, expires in 24 h\./);
  assert.doesNotMatch(body.getText(), /elu-team/); assert.match(v.panels.status.getText(), /ready and copied/);
  copied.length = 0;
  await until(() => body.lpos, 'drawn');
  // A drag along the code's row (the frame's middle row), from its first column to the window's edge, takes the frame and the row's padding with it.
  const pos = body.lpos, x0 = pos.xi + body.ileft, y0 = pos.yi + body.itop + 1, x1 = pos.xl - 1 - body.iright;
  const sgr = (b, x, y, up = false) => `\x1b[<${b};${x + 1};${y + 1}${up ? 'm' : 'M'}`;
  v.input.write(sgr(0, x0, y0)); v.input.write(sgr(32, x1, y0)); v.input.write(sgr(0, x1, y0, true));
  await until(() => copied.length, 'copied');
  assert.equal(copied[0].trim(), '│   k7qm-x2pd-9fhw   │');
  await closeDialog(v, 'Team invite');
  // Pasted after /join, as the terminal hands a paste over, then Enter.
  const ask = v.panels.ask; ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box');
  v.input.write('/join '); v.input.write(`\x1b[200~${copied[0]}\x1b[201~`);
  await until(() => ask.getValue() === `/join ${copied[0]}`, 'the box holds the paste as it came');
  v.input.write('\r'); await answerJoin(v);
  await until(() => peer.calls.some(row => row[0] === 'joinTeam'), 'joined');
  assert.deepEqual(peer.calls.find(row => row[0] === 'joinTeam').slice(1, 2), ['k7qm-x2pd-9fhw']);
});

test('a code pasted into the message box with /join, broken by line breaks, spaces, tabs and CRLF as a terminal hands it over, joins with that code', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer(), v = await view(t, { repo: repository(p.root), peer });
  const ask = v.panels.ask, joins = () => peer.calls.filter(row => row[0] === 'joinTeam').map(row => row[1]);
  const paste = async (typed, pasted, holds) => {
    ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box'); ask.clearValue();
    if (typed) v.input.write(typed);
    const before = joins().length;
    v.input.write(`\x1b[200~${pasted}\x1b[201~`);
    // What the message box holds after the paste: CRLF and a lone CR become line breaks, everything else stays.
    await until(() => ask.getValue() === holds, `the box holds ${JSON.stringify(holds)}, not ${JSON.stringify(ask.getValue())}`);
    v.input.write('\r'); await answerJoin(v);
    await until(() => joins().length === before + 1, `joined after ${JSON.stringify(pasted)}`);
    assert.equal(joins().at(-1), 'k7qm-x2pd-9fhw', JSON.stringify(pasted));
  };
  // Soft-wrapped rows with trailing spaces and a CRLF, the whole line pasted with its /join.
  await paste('', '/join k7qm-x2pd-   \r\n9fhw  \n', '/join k7qm-x2pd-   \n9fhw  \n');
  // A tab, a lone CR and upper case, after a typed /join.
  await paste('/join ', 'K7QM\tX2PD\r9FHW', '/join K7QM\tX2PD\n9FHW');
  // /join typed, then the whole line pasted again: the second /join is not part of the code.
  await paste('/join ', '/join\nk7qm -\nx2pd - 9fhw', '/join /join\nk7qm -\nx2pd - 9fhw');
  // The command a teammate was sent, pasted after /join.
  await paste('/join ', 'elu join k7qm-x2pd-9fhw', '/join elu join k7qm-x2pd-9fhw');
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
  await send(v, '/invite'); await choose(v, 'Invite', /^Someone new/);
  await until(() => modal(v, 'Team invite'), 'invite');
  assert.deepEqual(peer.calls.filter(row => row[0] === 'share').at(-1).slice(1), [p.root, { teams: ['team-1'] }]);
  const window = modal(v, 'Team invite').children.find(child => child.options?.scrollable).getText();
  assert.match(window, /Teammates can ask about sample, the folder \S[^]*sample app\.[^]*Run npx -y @elu-labs\/elu[^]*type \/join and paste this code/); assert.doesNotMatch(window, /fingerprint/i);
  await closeDialog(v, 'Team invite');
  await send(v, '/join nope'); await until(() => /That is not an invite code\. Use \/join code/.test(v.panels.status.getText()), 'join usage');
  assert.equal(peer.calls.some(row => row[0] === 'joinTeam'), false);
  // Joining shares nothing of the joiner's: teammates' messages start sessions in the open project.
  const shares = () => peer.calls.filter(row => row[0] === 'share').length, before = shares();
  await send(v, '/join K7QM X2PD 9FHW'); await answerJoin(v);
  await until(() => /Joined Docs with sara\. Their messages start sessions here, as if you typed them\./.test(v.panels.status.getText()), 'joined');
  assert.deepEqual(peer.calls.find(row => row[0] === 'joinTeam').slice(1, 2), ['k7qm-x2pd-9fhw']);
  assert.equal(shares(), before, 'nothing shared');
  assert.deepEqual(peer.calls.find(row => row[0] === 'saveTeamAccess').slice(1), ['team-2', { handling: 'auto', rules: '', root: p.root }]);
});

test('/join counts while it looks for the inviter and says their ELU must be open; Esc cancels it at once; a join that goes through clears the line', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer(), v = await view(t, { repo: repository(p.root), peer }), status = () => v.panels.status.getText();
  // A join that waits, as one does while the inviter's ELU is closed: the daemon answers a cancel a moment later.
  let held = null; const signals = [];
  peer.joinTeam = (code, options = {}) => {
    peer.calls.push(['joinTeam', code]); signals.push(options.signal);
    return new Promise((resolve, reject) => { held = { resolve, reject }; options.signal?.addEventListener('abort', () => setTimeout(() => reject(new Error('Join cancelled. You did not join.')), 400)); });
  };
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  // The seconds shown, or NaN when the line says something else. A busy machine may skip a second, never go back.
  const count = () => Number(/^› Looking for the person who invited you… (\d+) s\. Their ELU must be open\. Esc cancels\.$/.exec(status().replace(/\s+/g, ' ').trim())?.[1] ?? NaN);
  await until(() => count() >= 0, 'the line as the search starts');
  await until(() => count() >= 1, 'it counts');
  const first = count(); await until(() => count() > first, 'and goes on counting');
  // Esc says so at once, before the daemon has answered, and the count stops.
  v.input.write('\x1b');
  await until(() => /Join cancelled\. You did not join\./.test(status()), 'cancelled');
  assert.equal(signals[0].aborted, true, 'the join was told to stop');
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.match(status(), /Join cancelled\. You did not join\./, 'the line no longer counts');
  assert.doesNotMatch(status(), /Looking for/);
  assert.deepEqual(peer.calls.filter(row => row[0] === 'saveTeamAccess'), [], 'nothing was saved for a team it did not join');
  // The same wait, and this time the inviter answers: the line says it joined and stops counting.
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => count() >= 1, 'counting again');
  held.resolve({ id: 'team-2', name: 'Docs', inviter: { name: 'sara', fingerprint: 'bbbbbbbb' } });
  await until(() => /^› Joined Docs with sara\./.test(status()), 'joined');
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.match(status(), /^› Joined Docs with sara\./, 'the line stays as it joined');
  // One that gives up shows the daemon's reason and what to do, whole.
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => /Looking for the person who invited you…/.test(status()), 'a third search');
  held.reject(new Error('Nobody answered for this code. Their ELU is closed or offline, or the code was already used or is older than 24 h. Ask them to open ELU and send a new code with /invite.'));
  await until(() => /Nobody answered for this code\./.test(status().replace(/\s+/g, ' ')), 'why it gave up');
  assert.match(status().replace(/\s+/g, ' '), /Their ELU is closed or offline, or the code was already used or is older than 24 h\. Ask them to open ELU and send a new code with \/invite\./);
});

test('/join says when it has found the inviter and what it is trying; a reason too long for the status row shows whole in a window', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer(), v = await view(t, { repo: repository(p.root), peer }), status = () => v.panels.status.getText().replace(/\s+/g, ' ');
  let held = null, progress = null;
  peer.joinTeam = code => { peer.calls.push(['joinTeam', code]); return new Promise((resolve, reject) => { held = { resolve, reject }; }); };
  // What the daemon says it is doing now, as the app reads it while the join waits.
  peer.joinLine = (seconds, cancel) => joinWait(progress, seconds, cancel);
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => /Looking for the person who invited you… \d+ s\. Their ELU must be open\. Esc cancels\./.test(status()), 'looking');
  progress = { stage: 'connecting', via: null };
  await until(() => /Found them\. Connecting… \d+ s\. Esc cancels\./.test(status()), 'found');
  progress = { stage: 'retrying', via: null };
  await until(() => /Found them, but could not connect yet\. Trying again… \d+ s\. Esc cancels\./.test(status()), 'trying again');
  assert.doesNotMatch(status(), /Looking for|Their ELU must be open/);
  progress = { stage: 'relay', via: 'your computer studio' };
  await until(() => /Found them\. Connecting through your computer studio… \d+ s\. Esc cancels\./.test(status()), 'through another computer');
  held.resolve({ id: 'team-2', name: 'Docs', inviter: { name: 'sara', fingerprint: 'bbbbbbbb' }, via: 'your computer studio' });
  await until(() => /^› Joined Docs with sara\. Their messages start sessions here, as if you typed them\./.test(status()), 'joined');
  // No way through: longer than the row holds, so a window shows the reason and what works, a sentence to a line.
  progress = null;
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => /Looking for the person who invited you…/.test(status()), 'a second search');
  const why = noRoute({ theirs: 3, mine: 2 });
  held.reject(new Error(why));
  await until(() => modal(v, 'Could not join'), 'the window');
  assert.deepEqual(rowsOf(v, 'Could not join').map(line => line.trim()), ['Found their computer, but could not connect: their network gives every connection a', 'new port, as a phone hotspot does.', 'No other computer was online to pass it along.', 'Join again from another network, or while ELU is open on another computer on your', 'team or theirs.']);
  assert.doesNotMatch(v.text(), /Nobody/);
  v.input.write('\x1b');
  await until(() => !modal(v, 'Could not join'), 'closed with Esc');
  assert.match(status(), /^› Found their computer, but could not connect: their network gives every connection a new port/, 'the row keeps the start of it');
  // A reason the row holds whole stays in the row, with no window.
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => /Looking for the person who invited you…/.test(status()), 'a third search');
  held.reject(new Error('Join cancelled. You did not join.'));
  await until(() => /Join cancelled\. You did not join\./.test(status()), 'a short reason');
  assert.equal(modal(v, 'Could not join'), undefined);
  // A facade that cannot say what the daemon is doing keeps the plain line.
  peer.joinLine = () => { throw new Error('no state'); };
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => /Looking for the person who invited you… \d+ s\. Their ELU must be open\. Esc cancels\./.test(status()), 'the plain line');
  held.resolve({ id: 'team-2', name: 'Docs', inviter: { name: 'sara', fingerprint: 'bbbbbbbb' } });
  await until(() => /Joined Docs with sara\./.test(status()), 'joined');
});

test('/join at 80 columns: a reason the short status row cannot hold shows whole in a window, and Enter closes it', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer(), v = await view(t, { repo: repository(p.root), peer, columns: 80, rows: 24 }), status = () => v.panels.status.getText().replace(/\s+/g, ' ');
  peer.joinTeam = code => { peer.calls.push(['joinTeam', code]); return Promise.reject(new Error('Nobody answered for this code. Their ELU is closed or offline, or the code was already used or is older than 24 h. Ask them to open ELU and send a new code with /invite.')); };
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => modal(v, 'Could not join'), 'the window');
  assert.deepEqual(rowsOf(v, 'Could not join').map(line => line.trim()), ['Nobody answered for this code.', 'Their ELU is closed or offline, or the code was already used or is', 'older than 24 h.', 'Ask them to open ELU and send a new code with /invite.']);
  v.input.write('\r');
  await until(() => !modal(v, 'Could not join'), 'closed with Enter');
  assert.match(status(), /^› Nobody answered for this code\./);
});

test('/join asks to join first, then what teammates can do here: Cancel or Esc joins nothing, Enter twice takes Auto with no rules', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer(), v = await view(t, { repo: repository(p.root), peer }), status = () => v.panels.status.getText();
  const joins = () => peer.calls.filter(row => row[0] === 'joinTeam').length, saves = () => peer.calls.filter(row => row[0] === 'saveTeamAccess').map(row => row.slice(1));
  // Cancel on the confirm joins nothing.
  await send(v, '/join k7qm-x2pd-9fhw'); await until(() => rowsOf(v, 'Join a team').length === 2, 'the confirm');
  assert.deepEqual(rowsOf(v, 'Join a team'), ['Join', 'Cancel']);
  assert.match(v.text(), /This code joins the team of the person who sent it to you\./);
  await choose(v, 'Join a team', /^Cancel$/);
  await until(() => /Nothing was done\. You did not join\./.test(status()), 'cancelled');
  assert.equal(joins(), 0);
  // Esc on the rules joins nothing either.
  await send(v, '/join k7qm-x2pd-9fhw'); await choose(v, 'Join a team', /^Join$/);
  await until(() => rowsOf(v, 'What teammates can do here').length === 2, 'what teammates can do');
  assert.deepEqual(rowsOf(v, 'What teammates can do here'), ['Auto: their message starts a session here, as if you typed it', 'Manual: each message waits for you to approve it']);
  assert.match(v.text(), /Push, merge, deploy and publish need Full access either way\./);
  await choose(v, 'What teammates can do here', /^Auto/); await until(() => modal(v, 'Rules for teammates'), 'the rules');
  assert.match(v.text().replace(/[│\s]+/g, ' '), /Optional, in plain English\. For example: Only work on the elu repo\. Don't write anything until I accept it\./, 'the hint, read across its wrap');
  modal(v, 'Rules for teammates').children.find(child => child.type === 'textbox').emit('cancel');
  await until(() => !modal(v, 'Rules for teammates'), 'closed');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(joins(), 0); assert.deepEqual(saves(), []);
  // Enter on each: Join, then Auto, then empty rules.
  await send(v, '/join k7qm-x2pd-9fhw');
  await until(() => modal(v, 'Join a team'), 'confirm'); v.input.write('\r');
  await until(() => modal(v, 'What teammates can do here'), 'handling'); v.input.write('\r');
  await closeDialog(v, 'Rules for teammates', '');
  await until(() => joins() === 1 && /Joined Docs with sara\. Their messages start sessions here, as if you typed them\./.test(status()), 'joined with Auto');
  assert.deepEqual(saves(), [['team-2', { handling: 'auto', rules: '', root: p.root }]]);
  // Manual and the rules are saved as typed, with the open project.
  const rules = "Only work on the elu repo. Don't write anything until I accept it.";
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v, { handling: /^Manual/, rules });
  await until(() => joins() === 2 && /Joined Docs with sara\. Their messages wait for you to approve them\./.test(status()), 'joined with Manual');
  assert.deepEqual(saves().at(-1), ['team-2', { handling: 'manual', rules, root: p.root }]);
});

test('the first /invite for a team asks what teammates can do here before the code; later invites do not ask again', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ access: {} }), v = await view(t, { repo: repository(p.root), peer }), status = () => v.panels.status.getText();
  const invites = () => peer.calls.filter(row => row[0] === 'createInvite').length, saves = () => peer.calls.filter(row => row[0] === 'saveTeamAccess').map(row => row.slice(1));
  await send(v, '/invite'); await choose(v, 'Invite', /^Someone new/);
  await until(() => modal(v, 'What teammates can do here'), 'asked first');
  assert.equal(invites(), 0, 'no code before the answers');
  v.input.write('\x1b'); await until(() => /Nothing was done\. No invite was made\./.test(status()), 'Esc makes no code');
  assert.equal(invites(), 0);
  await send(v, '/invite'); await choose(v, 'Invite', /^Someone new/);
  await choose(v, 'What teammates can do here', /^Manual/); await closeDialog(v, 'Rules for teammates', 'Only answer questions, do not edit files.');
  await until(() => modal(v, 'Team invite'), 'the code');
  assert.deepEqual(saves(), [['team-1', { handling: 'manual', rules: 'Only answer questions, do not edit files.', root: p.root }]]);
  await closeDialog(v, 'Team invite');
  await send(v, '/invite'); await choose(v, 'Invite', /^Someone new/); await until(() => modal(v, 'Team invite'), 'the second code');
  assert.equal(modal(v, 'What teammates can do here'), undefined, 'not asked again'); assert.equal(saves().length, 1); assert.equal(invites(), 2);
  await closeDialog(v, 'Team invite');
});

test('/access shows what teammates can do here and changes it; Esc changes nothing', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ access: { 'team-1': { handling: 'auto', rules: 'Be brief.', root: null, at: 'then' } } }), v = await view(t, { repo: repository(p.root), peer }), status = () => v.panels.status.getText();
  const list = () => modal(v, 'What teammates can do here').children.find(child => child.type === 'list');
  await send(v, '/access'); await until(() => modal(v, 'What teammates can do here'), 'the handling');
  assert.match(status(), /Core now: Auto · rules: Be brief\./); assert.equal(list().selected, 0);
  await choose(v, 'What teammates can do here', /^Manual/);
  await until(() => modal(v, 'Rules for teammates'), 'the rules');
  assert.equal(modal(v, 'Rules for teammates').children.find(child => child.type === 'textbox').getValue(), 'Be brief.', 'the rules as they are');
  await closeDialog(v, 'Rules for teammates', 'Only answer questions.');
  await until(() => /Saved for Core: messages wait for you to approve them, with your rules in /.test(status()), 'saved');
  assert.deepEqual(peer.calls.filter(row => row[0] === 'saveTeamAccess').map(row => row.slice(1)), [['team-1', { handling: 'manual', rules: 'Only answer questions.', root: p.root }]]);
  // It opens on what is saved now; Esc changes nothing.
  await send(v, '/access'); await until(() => modal(v, 'What teammates can do here') && list().selected === 1, 'Manual first');
  v.input.write('\x1b'); await until(() => /Nothing was changed\./.test(status()), 'Esc');
  assert.equal(peer.calls.filter(row => row[0] === 'saveTeamAccess').length, 1);
});

test('/access on a team with teammates and no setting offers Manual first, so Enter keeps their messages waiting', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ access: {} }), v = await view(t, { repo: repository(p.root), peer }), status = () => v.panels.status.getText();
  const list = () => modal(v, 'What teammates can do here').children.find(child => child.type === 'list');
  await send(v, '/access'); await until(() => modal(v, 'What teammates can do here'), 'the handling');
  assert.match(status(), /Core now: Not set: messages wait for you to approve them\./); assert.equal(list().selected, 1);
  v.input.write('\r'); await closeDialog(v, 'Rules for teammates', '');
  await until(() => /Saved for Core: messages wait for you to approve them/.test(status()), 'saved');
  assert.equal(peer.access['team-1'].handling, 'manual');
});

test('a project that cannot hold teammates\' sessions is left out, and the last status line of /join, /invite and /access says why', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ access: {} }), status = () => v.panels.status.getText();
  const save = peer.saveTeamAccess;
  peer.saveTeamAccess = (id, update) => { if (update.root) throw new Error('Your home folder cannot be the project teammates work in.'); return save(id, update); };
  const v = await view(t, { repo: repository(p.root), peer });
  const NOTE = /No project was saved for their sessions: Your home folder cannot be the project teammates work in\. Until one is, their messages wait for you\./;
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => /Joined Docs with sara\./.test(status()), 'joined');
  assert.match(status(), NOTE); assert.doesNotMatch(status(), /start sessions here/);
  assert.deepEqual(peer.access['team-2'], { handling: 'auto', rules: '', root: null, at: 'now' });
  await send(v, '/access'); await choose(v, 'What teammates can do here', /^Manual/); await closeDialog(v, 'Rules for teammates', '');
  await until(() => /Saved for Core/.test(status()), 'access saved'); assert.match(status(), NOTE);
  delete peer.access['team-1'];
  await send(v, '/invite'); await choose(v, 'Invite', /^Someone new/);
  await choose(v, 'What teammates can do here', /^Manual/); await closeDialog(v, 'Rules for teammates', '');
  await until(() => modal(v, 'Team invite'), 'the code'); assert.match(status(), NOTE);
  await closeDialog(v, 'Team invite');
});

test('a peer daemon an update left running is restarted before /join', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer(); peer.stale = true;
  peer.startPeer = () => { peer.calls.push(['startPeer']); peer.stale = false; return true; };
  const v = await view(t, { repo: repository(p.root), peer });
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => peer.calls.some(row => row[0] === 'joinTeam'), 'joined');
  const at = name => peer.calls.findIndex(row => row[0] === name);
  assert.ok(at('startPeer') >= 0 && at('startPeer') < at('joinTeam'), JSON.stringify(peer.calls.map(row => row[0])));
});

test('Chats shows a few lines on no team or when the facade is missing, and starts nothing', async t => {
  for (const peer of [fakePeer({ teamless: true, running: false }), null]) {
    await t.test(peer ? 'no team' : 'missing', async t => {
      const { v } = await teamView(t, { peer, columns: 80, rows: 24 });
      await until(() => peer ? ['No team yet.', 'Invite someone: /invite', 'Got a code? /join CODE'].every(line => v.text().includes(line)) : v.text().includes('Teammates need the optional networking packages'), `no team lines in\n${v.text()}`);
      assert.ok(v.panels.teamBoxes.every(pane => pane.hidden));
      if (peer) assert.match(v.panels.pills.getText(), /○ no team/);
      // No peer reads and no daemon started: only the one check for a daemon an older version left running.
      if (peer) { await until(() => peer.calls.length, 'the check'); await new Promise(resolve => setTimeout(resolve, 200)); assert.deepEqual(peer.calls, [['restartStale']]); }
      await send(v, '@sara hello');
      await until(() => /No team yet\. Invite someone with \/invite|Teammates need the optional/.test(v.panels.status.getText()), 'a message to a teammate is refused');
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
  await until(() => /^\? @sara question · sample app\n┃ Question · How do we rotate keys\?\n\ny accept · n decline · enter open · c decline$/.test(v.panels.chat.getText()), 'the question beside the list');
  assert.equal(v.current.session, null, 'a teammate’s message is not a session of yours'); assert.equal(v.current.screen.focused, board);
  v.input.write('y');
  // y approves: the daemon queues the session your own prompt would start, which the board then shows as a session.
  await until(() => peer.sent().some(row => row.type === 'approve' && row.id === 'task-ask'), 'ask approved');
  await until(() => /Approved @sara\. It runs as your session; the reply goes back to this thread\./.test(v.panels.status.getText()), 'approved line');
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
  // On a team, the view starts the daemon again, once a minute at most.
  await until(() => peer.calls.some(row => row[0] === 'startPeer'), 'restart');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(peer.calls.filter(row => row[0] === 'startPeer').length, 1);
  await send(v, '@sara hello');
  await until(() => /The peer daemon is not running/.test(v.panels.status.getText()), 'refused');
  assert.equal(peer.sent().length, 0);
});

test('on a team, the app starts the peer daemon as it opens, without a word, and restarts one of another version', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ running: false });
  peer.startPeer = () => { peer.calls.push(['startPeer']); peer.running = true; return true; };
  const v = await view(t, { repo: repository(p.root), peer });
  await until(() => peer.calls.some(row => row[0] === 'startPeer'), 'started as the app opens');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(peer.calls.filter(row => row[0] === 'startPeer').length, 1);
  assert.doesNotMatch(v.panels.status.getText(), /had stopped|could not start/);
  const stale = fakePeer(); stale.stale = true;
  stale.startPeer = () => { stale.calls.push(['startPeer']); stale.stale = false; return true; };
  await view(t, { repo: repository(p.root), peer: stale });
  await until(() => stale.calls.some(row => row[0] === 'startPeer'), 'a daemon an update left running is restarted as the app opens');
});

test('on no team, the app stops a daemon an older version left running, once, and starts none', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ teamless: true, running: false });
  // A 0.1.5 daemon still running after a join that failed: restartStale stops it and, on no team, starts nothing.
  peer.restartStale = () => { peer.calls.push(['restartStale']); peer.stopped = true; return false; };
  const v = await view(t, { repo: repository(p.root), peer });
  await until(() => peer.stopped, 'the stray daemon stopped');
  await send(v, '/chats'); await until(() => v.current.view === 'chats', 'Chats');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(peer.calls.map(row => row[0]), ['restartStale'], 'once, and nothing started');
});

test('/leave on the last team says the daemon stops, and nothing starts it again', async t => {
  const { v, peer } = await teamView(t), status = () => v.panels.status.getText();
  const body = () => modal(v, 'Leave Core').children.find(child => child.options?.scrollable).getText();
  await until(() => v.panels.teamLists[0].items.length, 'teammates');
  await send(v, '/leave Nope'); await until(() => /You are not on a team called Nope\./.test(status()), 'unknown team');
  peer.lastTeam = true;
  await send(v, '/leave core'); await until(() => modal(v, 'Leave Core'), 'confirm');
  assert.match(body(), /^Leave Core\? You stop getting its messages\./);
  await closeDialog(v, 'Leave Core', 'y');
  await until(() => /You left Core\. You are on no team now, so the peer daemon stops\./.test(status()), 'left');
  assert.deepEqual(peer.sent().filter(row => row.type === 'teamLeave'), [{ type: 'teamLeave', team: 'team-1' }]);
  // On no team now, so nothing starts the daemon again.
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(peer.calls.filter(row => row[0] === 'startPeer').length, 0);
  // Read from its widget: the screen's rows show it only after the next full render.
  await until(() => !v.panels.teamOff.hidden && v.panels.teamOff.getContent().startsWith('No team yet.\nInvite someone: /invite'), 'Chats shows no team');
});

test('/leave and /remove start a daemon that is not running before they send', async t => {
  const peer = fakePeer({ running: false }), { v } = await teamView(t, { peer }), status = () => v.panels.status.getText();
  let started = 0;
  peer.startPeer = () => { started++; peer.running = true; return true; };
  await send(v, '/remove @sara'); await closeDialog(v, 'Remove @sara', 'y');
  await until(() => /Removed @sara from Core\./.test(status()), 'removed');
  assert.equal(started, 1, 'the daemon was started for it');
  assert.deepEqual(peer.calls.filter(row => row[0] === 'teamChange').map(row => row[1]), [{ type: 'teamRemove', team: 'team-1', key: SARA }], 'through the facade the CLI uses');
  assert.deepEqual(peer.sent().filter(row => row.type === 'teamRemove'), [{ type: 'teamRemove', team: 'team-1', key: SARA }]);
});

test('/leave says when no teammate was online to hear it, and when the daemon could not start; a daemon of another version that will not stop refuses it', async t => {
  const { v, peer } = await teamView(t), status = () => v.panels.status.getText();
  await until(() => v.panels.teamLists[0].items.length, 'teammates');
  const leave = async () => { await send(v, '/leave core'); await closeDialog(v, 'Leave Core', 'y'); };
  peer.teamChange = async command => { peer.calls.push(['teamChange', command]); return { team: 'team-1', name: 'Core', told: false, daemon: true, stopping: false }; };
  await leave();
  await until(() => /You left Core\. No teammate was online, so the first one to connect is told\./.test(status()), 'nobody heard it');
  peer.teamChange = async command => { peer.calls.push(['teamChange', command]); return { team: 'team-1', name: 'Core', told: false, daemon: false, stopping: false }; };
  await leave();
  await until(() => /You left Core\. Your teammates were not told, since the peer daemon could not start\. It tells them once it can\./.test(status()), 'written here');
  const STALE = 'The peer daemon of another version of ELU did not stop. Wait a moment, then try again.';
  peer.teamChange = async command => { peer.calls.push(['teamChange', command]); throw new Error(STALE); };
  await leave();
  await until(() => status().includes(STALE), 'refused');
  assert.equal(peer.calls.filter(row => ['leaveTeam', 'removeMember'].includes(row[0])).length, 0, 'nothing is written here behind the facade');
});

test('on no team with a leave nobody heard yet, the app starts the daemon for it as it opens', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ teamless: true, running: false });
  peer.leaveUnheard = () => true;
  await view(t, { repo: repository(p.root), peer });
  await until(() => peer.calls.some(row => row[0] === 'startPeer'), 'started for the leave');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(peer.calls.filter(row => ['startPeer', 'restartStale'].includes(row[0])).map(row => row[0]), ['startPeer'], 'once');
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
  // One the chat went on with stays, and says so: an answer, and a result.
  const went = teamPanes({ status: { key: ME, teams: [] }, agents: [], items: [
    { id: 'answer:4', kind: 'answer', continued: true, peer: SARA, name: 'sara', question: 'Where is the cache?', text: 'In src/cache.js.', at },
    { id: 'answer:5', kind: 'answer', continued: true, result: true, peer: SARA, name: 'sara', question: 'Make coupon codes uppercase.', text: 'Coupon codes are uppercase now.', at: ago(2) },
  ] }, [60, 60, 120], false)[2].map(row => visible(row.line)).join('\n');
  assert.match(went, /→ you asked @sara · Where is the cache\?\n {3}↳ @sara answered · continued in your session · In src\/cache\.js\./);
  assert.match(went, /→ you asked @sara · Make coupon codes uppercase\.\n {3}↳ result from @sara · continued in your session · Coupon codes are uppercase now\./);
});

test('a thread whose answer or result continued the chat stays in Chats, marked as continued: Enter reads it, c says it already went on, n dismisses it', { timeout: 30000 }, async t => {
  const peer = fakePeer({ items: [
    { id: 'answer:r1', kind: 'answer', continued: true, result: true, peer: SARA, name: 'sara', project: null, text: 'Coupon codes are uppercase now.', question: 'Make coupon codes uppercase.', at: ago(2), state: 'answered', threadId: 'th-2' },
  ] });
  peer.threadMessages = id => id === 'th-2' ? [
    { from: 'me', peer: SARA, name: 'sara', kind: 'ask', text: 'Make coupon codes uppercase.', at: ago(9) },
    { from: 'peer', peer: SARA, name: 'sara', kind: 'answer', text: 'The plan waits for my approval.', at: ago(8) },
    { from: 'peer', peer: SARA, name: 'sara', kind: 'result', text: 'Coupon codes are uppercase now.', at: ago(2) },
  ] : [];
  const { v } = await teamView(t, { peer });
  const [, threads] = v.panels.teamLists, status = () => v.panels.status.getText().trim(), rows = () => threads.items.map(plainItem).map(row => row.trim());
  await openRow(v, /@sara\s+direct/, '@sara');
  // Her thread is there, not "Nothing in @sara yet.", and its row says the chat went on with it.
  await until(() => rows().length === 2, 'the thread');
  assert.deepEqual(rows(), ['→ you asked @sara · Make coupon codes uppercase.', '↳ result from @sara · continued in your session · Coupon codes are uppercase now.']);
  assert.doesNotMatch(v.text(), /Nothing in @sara yet/);
  // Enter reads the whole thread; it offers no c, since the chat already went on with it.
  threads.focus(); selectRow(threads, /continued in your session/); v.input.write('\r');
  await until(() => modal(v, 'Thread with @sara'), 'the thread screen');
  const said = modal(v, 'Thread with @sara').children.find(child => child.options?.scrollable).getContent();
  assert.match(said, /you · question · \d\d:\d\d\nMake coupon codes uppercase\.[^]*↳ @sara · answer · \d\d:\d\d\nThe plan waits for my approval\.[^]*@sara · result · \d\d:\d\d\nCoupon codes are uppercase now\.\n\nYour session already continued with this result\.$/);
  assert.doesNotMatch(said, /c continues/);
  v.input.write('c'); await new Promise(resolve => setTimeout(resolve, 100));
  await closeDialog(v, 'Thread with @sara');
  // c on its row sends nothing to the daemon and says why.
  threads.focus(); selectRow(threads, /continued in your session/); v.input.write('c');
  await until(() => /Your session already continued with this result\./.test(status()), 'c on a continued thread');
  assert.ok(!peer.sent().some(row => row.type === 'continue'), 'nothing was continued twice');
  // n dismisses it, as any thread that waits for nothing.
  v.input.write('n');
  await until(() => peer.sent().some(row => row.type === 'discard' && row.id === 'answer:r1') && /Dismissed\./.test(status()), 'dismissed');
});

// --- Kanban: teammates' Tasks ---
const teamTask = (extra = {}) => ({ repoId: 'e'.repeat(64), handle: 'web', id: 't-0a1b2c3d', revision: 2, title: 'Fix the login redirect', description: 'After sign-in the app returns to the home page.', goal: 'Sign-in returns to the page that asked for it.',
  objectives: ['The return address survives sign-in', 'A bad return address falls back to home'], priority: 'high', severity: 'critical', state: 'approved', startedBy: 'owner', who: 'Opus 5.5',
  subtasks: [{ text: 'Carry the return address through the form', state: 'done' }, { text: 'Check the address is on this site', state: 'doing' }, { text: 'Tests', state: 'todo' }], met: [1], approvedAt: ago(30), doneAt: null, updatedAt: ago(2), ...extra });

test('Kanban shows teammates\' Tasks as cards in the same columns with their name, counted with mine, read-only, and Enter shows the whole Task', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer(), asked = [];
  let people = [
    { peer: SARA, name: 'sara', box: 'sara-box', online: true, heardAt: ago(0), tasks: [teamTask(), teamTask({ id: 't-2', title: '{red-fg}Loud{/} title', priority: 'low', severity: 'medium', who: '@scout', subtasks: [], met: [], approvedAt: ago(20), updatedAt: ago(5) })] },
    { peer: LI, name: 'li', online: false, heardAt: ago(180), tasks: [teamTask({ id: 't-3', title: 'Old cleanup', state: 'done', priority: 'low', severity: 'low', who: 'bot', subtasks: [], met: [1, 2], doneAt: ago(60), updatedAt: ago(60) })] },
  ], off = false;
  peer.teammateTasks = root => { asked.push(root); return people; }; peer.boardKeptOff = () => off;
  const v = await view(t, { repo: repository(p.root), peer }), panels = v.panels, focused = () => v.current.screen.focused;
  const column = index => panels.kanbanLists[index].items.map(item => plainItem(item).trimEnd()), label = index => panels.kanbanBoxes[index]._label.getText().trim();
  await send(v, '/kanban'); await until(() => v.current.view === 'kanban' && column(1).length === 2 && column(3).length === 1, 'the teammates\' cards');
  assert.deepEqual(asked.slice(0, 1), [p.root], 'asked for this project only');
  // Approved is In progress, done is Done; each card names whose it is, the name kept when the title is cut.
  assert.match(column(1)[0], /^Fix the login.*  sara on sara-box/); assert.match(column(1)[1], /^\{red-fg\}Loud\{\/\}.*  sara on sara-box/);
  assert.match(column(3)[0], /^Old cleanup  li · done 2\/2/);
  assert.deepEqual([label(0), label(1), label(2), label(3)], ['To do 0', 'In progress 2', 'Needs you 0', 'Done 1']);
  // No strip under the board: the columns take the whole height, and there is no separate list to move to.
  assert.equal(panels.kanbanTeam.hidden, true); assert.equal(panels.kanbanTeamList, undefined);
  // The line under the board names the whole of it, and that it is read-only; the keys say Enter reads it.
  panels.kanbanLists[1].focus(); panels.kanbanLists[1].select(0);
  await until(() => /sara on sara-box's Task · approved · 1 of 3 subtasks done · high priority · critical severity · worked on by Opus 5\.5 · read-only/.test(panels.status.getText()), 'the card\'s line');
  await until(() => /enter read/.test(panels.keys.getText()) && !/start|done|delete/.test(panels.keys.getText()), 'the keys for a teammate\'s card');
  // No key moves, edits or deletes it: each says whose it is.
  const open = v.current.screen.children.length;
  for (const key of ['x', '>', '<', '\x1b[1;2C', '\x1b[1;2D', '\x1b[3~']) {
    panels.kanbanLists[1].focus(); panels.kanbanLists[1].select(0); v.input.write(key);
    await until(() => /That is sara's Task\. Enter opens it to read; it changes only on their machine\./.test(panels.status.getText()), `the answer to ${JSON.stringify(key)}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  panels.kanbanLists[3].focus(); panels.kanbanLists[3].select(0); v.input.write('<');
  await until(() => /That is li's Task\./.test(panels.status.getText()), 'Done is read-only too');
  assert.equal(v.current.screen.children.length, open, 'no dialog opened');
  assert.deepEqual(readBoard(repository(p.root)).cards, []); assert.deepEqual(readBoard(repository(p.root)).done, []); assert.deepEqual(peer.sent(), []);
  // Enter shows the whole Task to read.
  panels.kanbanLists[1].focus(); panels.kanbanLists[1].select(0); v.input.write('\r');
  await until(() => modal(v, "sara's Task"), 'the Task opens');
  // A Task from a build before success criteria and estimates: both read as not set.
  assert.deepEqual(rowsOf(v, "sara's Task").map(line => line.trimEnd()), [
    'Fix the login redirect',
    'in progress · priority high · severity critical · revision 2',
    "Worked on by Opus 5.5 on sara's machine sara-box · started by its owner",
    '', 'Goal', 'Sign-in returns to the page that asked for it.',
    '', 'Description', 'After sign-in the app returns to the home page.',
    '', 'Objectives · 1 of 2 met', '  ✓ The return address survives sign-in', '  · A bad return address falls back to home',
    '', 'Success criteria · not set',
    '', 'Subtasks · 1 of 3 done', '  ✓ Carry the return address through the form', '  ▸ Check the address is on this site', '  · Tests',
    '', 'ETA not set',
    '', 'last activity 2m ago',
    '', 'It runs on their machine: only they can change it.',
  ]);
  v.input.write('\x1b'); await until(() => !modal(v, "sara's Task"), 'Esc closes it');
  // One with success criteria and an estimate: the ETA is its approval plus the estimate, or the minutes left it last reported.
  const estimated = teamTask({ criteria: ['A deep link survives sign-in'], estimateMinutes: 60 });
  people = [{ ...people[0], tasks: [estimated, people[0].tasks[1]] }, people[1]];
  await until(() => column(1).length === 2, 'the same cards'); await new Promise(resolve => setTimeout(resolve, 3200));
  panels.kanbanLists[1].focus(); panels.kanbanLists[1].select(0); v.input.write('\r');
  await until(() => rowsOf(v, "sara's Task").some(line => /^ETA /.test(line)), 'the Task with an estimate');
  const timed = rowsOf(v, "sara's Task").map(line => line.trimEnd()), eta = Date.parse(estimated.approvedAt) + 60 * 60000;
  assert.deepEqual(timed.slice(timed.indexOf('Success criteria'), timed.indexOf('Success criteria') + 2), ['Success criteria', '  · A deep link survives sign-in']);
  assert.match(timed.find(line => /^ETA /.test(line)), new RegExp(`^ETA ${clockTime(eta).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · in (29|30) min$`));
  v.input.write('\x1b'); await until(() => !modal(v, "sara's Task"), 'Esc closes it');
  people = [{ ...people[0], tasks: [teamTask({ estimateMinutes: 20, approvedAt: ago(30) }), people[0].tasks[1]] }, people[1]];
  await new Promise(resolve => setTimeout(resolve, 3200));
  panels.kanbanLists[1].focus(); panels.kanbanLists[1].select(0); v.input.write('\r');
  await until(() => rowsOf(v, "sara's Task").some(line => /^ETA .* · overdue by (9|10|11) min$/.test(line.trimEnd())), 'overdue');
  v.input.write('\x1b'); await until(() => !modal(v, "sara's Task"), 'Esc closes it');
  people = [{ ...people[0], tasks: [teamTask(), people[0].tasks[1]] }, people[1]];
  await new Promise(resolve => setTimeout(resolve, 3200));
  // A Task a teammate took over from a handoff says so; an offline teammate's says when they were last heard.
  panels.kanbanLists[3].focus(); panels.kanbanLists[3].select(0); v.input.write('\r');
  await until(() => rowsOf(v, "li's Task").some(line => /last heard 3h ago/.test(line)), 'last heard');
  v.input.write('\x1b'); await until(() => !modal(v, "li's Task"), 'Esc closes it');
  people = [{ ...people[0], tasks: [teamTask({ startedBy: 'handoff' })] }, people[1]];
  await until(() => column(1).length === 1 && label(1) === 'In progress 1', 'the changed list', 8000);
  panels.kanbanLists[1].focus(); panels.kanbanLists[1].select(0); v.input.write('\r');
  await until(() => rowsOf(v, "sara's Task").some(line => /started by a handoff/.test(line)), 'started by a handoff');
  v.input.write('\x1b'); await until(() => !modal(v, "sara's Task"), 'Esc closes it again');
  // The Task done on their machine moves to Done here.
  people = [{ ...people[0], tasks: [teamTask({ state: 'done', met: [1, 2], doneAt: ago(0) })] }, people[1]];
  await until(() => column(1).length === 0 && column(3).length === 2 && label(3) === 'Done 2', 'moved to Done', 8000);
  assert.match(column(3)[0], /^Fix the login.*  sara on sara-box/);
  assert.deepEqual(readBoard(repository(p.root)).cards, []); assert.deepEqual(peer.sent(), []);
  // Gone on their side: gone here.
  people = [];
  await until(() => column(1).length === 0 && column(3).length === 0, 'the cards leave', 8000);
  // While this project is kept off the team board, one line under the board says so; otherwise there is none.
  off = true;
  await until(() => !panels.kanbanTeam.hidden && /Kept off the team board: teammates do not see your sessions here, and theirs are not shown\. \/share on puts it back\./.test(panels.kanbanTeam.getText()), 'the note', 8000);
  assert.equal(panels.kanbanTeam.height, 3); assert.equal(panels.kanbanTeam.top, panels.kanbanBoxes[0].top + panels.kanbanBoxes[0].height);
  off = false;
  await until(() => panels.kanbanTeam.hidden, 'no note while it is on the board', 8000);
  await new Promise(resolve => setTimeout(resolve, 3500)); assert.equal(panels.kanbanTeam.hidden, true);
});

// --- Kanban: teammates' sessions, one board for each repository ---
const WEB = '1'.repeat(64), API = '2'.repeat(64);
const teamSession = (extra = {}) => ({ repoId: WEB, id: '0123456789abcdef', title: 'Fix the cart total', column: 'progress', by: 'sara', at: ago(1), ...extra });
test('Kanban shows every session teammates run in the same repository, with who and where, read-only, and a project in several repositories picks a board', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer();
  let people = [{ peer: SARA, name: 'sara', box: 'sara-box', online: true, heardAt: ago(0), sessions: [
    teamSession(), teamSession({ id: '1123456789abcdef', title: 'Which tax rate?', column: 'needs', by: 'li', at: ago(3) }),
    teamSession({ repoId: API, id: '2123456789abcdef', title: 'Document the v2 endpoint', column: 'done', at: ago(20) }) ] }];
  // The Task of a session they also told goes with its card, as one.
  const tasks = [{ peer: SARA, name: 'sara', box: 'sara-box', online: true, heardAt: ago(0), tasks: [teamTask({ repoId: WEB, id: 't-cart' })] }];
  people[0].sessions[0].plan = 't-cart';
  peer.teammateTasks = () => tasks; peer.boardKeptOff = () => false;
  peer.teammateSessions = () => ({ repos: [{ repoId: API, name: 'acme/api', at: ago(20) }, { repoId: WEB, name: 'acme/web', at: ago(1) }], people });
  const v = await view(t, { repo: repository(p.root), peer }), panels = v.panels;
  const column = index => panels.kanbanLists[index].items.map(item => plainItem(item).trimEnd()), label = index => panels.kanbanBoxes[index]._label.getText().trim();
  await send(v, '/kanban'); await until(() => v.current.view === 'kanban' && column(1).length === 1 && column(2).length === 1, 'the teammates\' sessions');
  // The board with the latest work leads. Each card says who started it and on which machine; the Task is not a second card.
  assert.match(column(1)[0], /^Fix the cart total  @sara · sara-box/); assert.match(column(2)[0], /^Which tax rate\?  @li · sara-box/);
  assert.deepEqual([label(0), label(1), label(2), label(3)], ['To do 0', 'In progress 1', 'Needs you 1', 'Done 0']);
  await until(() => !panels.kanbanPick.hidden && /Board: acme\/web ▾/.test(panels.kanbanPick.getText()), 'the board picker');
  // Read-only: Enter reads it, no key moves it.
  panels.kanbanLists[1].focus(); panels.kanbanLists[1].select(0);
  await until(() => /@sara's session on sara-box · In progress · Task: Fix the login redirect · read-only/.test(panels.status.getText()), 'the card\'s line');
  v.input.write('x'); await until(() => /That is sara's session\. Enter opens it to read; it changes only on their machine\./.test(panels.status.getText()), 'x refused');
  v.input.write('\r');
  await until(() => modal(v, "sara's session"), 'the session opens');
  // The whole Task it works on, as a Task card shows it.
  const rows = rowsOf(v, "sara's session").map(line => line.trimEnd());
  assert.deepEqual(rows.slice(0, 3), ['Fix the login redirect', 'in progress · priority high · severity critical · revision 2', "Started by @sara · on sara's machine sara-box"]);
  for (const line of ['Goal', 'Objectives · 1 of 2 met', 'Success criteria · not set', 'Subtasks · 1 of 3 done', 'ETA not set', 'last activity 1m ago', 'It runs on their machine: only they can change it.']) assert.ok(rows.includes(line), line);
  v.input.write('\x1b'); await until(() => !modal(v, "sara's session"), 'Esc closes it');
  // One with no Task: it says so. Their first message is never sent, so nothing else shows.
  panels.kanbanLists[2].focus(); panels.kanbanLists[2].select(0); v.input.write('\r');
  await until(() => rowsOf(v, "sara's session").includes('No Task yet'), 'no Task yet');
  assert.deepEqual(rowsOf(v, "sara's session").map(line => line.trimEnd()), ['Which tax rate?', 'Needs you', "Started by @li · on sara's machine sara-box", '', 'No Task yet', '', 'last activity 3m ago', '', 'It runs on their machine: only they can change it.']);
  assert.equal(modal(v, "sara's session").children.some(child => child.type === 'button'), false, 'a teammate\'s card has no Go to session');
  v.input.write('\x1b'); await until(() => !modal(v, "sara's session"), 'Esc closes it');
  // The other repository's board: its own cards only.
  panels.kanbanPick.focus(); panels.kanbanPick.emit('press');
  await until(() => modal(v, 'Kanban board'), 'the picker');
  v.input.write('\x1b[B'); v.input.write('\r');
  await until(() => column(3).length === 1 && column(1).length === 0 && column(2).length === 0, 'the api board');
  // A title too long for the column is cut so who and where stay beside it.
  assert.match(column(3)[0], /^Document the v2…  @sara · sara-box/);
  assert.match(panels.kanbanPick.getText(), /Board: acme\/api ▾/);
  // Moved on their machine: moved here; gone there: gone here.
  people = [{ ...people[0], sessions: [teamSession({ repoId: API, id: '2123456789abcdef', title: 'Document the v2 endpoint', column: 'needs', at: ago(0) })] }];
  await until(() => column(2).length === 1 && column(3).length === 0, 'moved to Needs you', 8000);
  people = [];
  await until(() => column(2).length === 0, 'gone', 8000);
  assert.deepEqual(readBoard(repository(p.root)).cards, []); assert.deepEqual(peer.sent(), []);
});

test('a card of my other computer opens as mine: its whole Task, you and that computer, and its Go to session button opens it in Sessions; one with no Task yet shows its first message', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const HOME = '0123456789abcdef', listed = { id: '11111111-2222-4333-8444-555555555555', ref: `${HOME}:6`, project: HOME, title: 'Nightly checks', state: 'running', at: ago(0), createdAt: ago(60), approvals: [], by: 'you', who: null, repoId: WEB, question: null, error: null, plan: null };
  const peer = fakePeer({ mine: [{ key: SARA, mine: true, theirs: true }], machines: [{ key: SARA, listedAt: ago(0), older: false, projects: [{ id: HOME, name: 'home', repoId: null, home: true }], sessions: [listed] }], repoId: WEB });
  // As the card brings it: the Task with its success criteria, its estimate and the minutes left it last reported.
  const task = { id: 't-5e1f0a2b', revision: 1, title: 'Make the search page fast', description: 'Measure first, then cache the slow query.', goal: 'The search page answers in under a second.', objectives: ['A timing test for the search page', 'The slow query is cached'],
    priority: 'high', severity: 'high', state: 'approved', startedBy: 'owner', subtasks: [{ text: 'Time the page', state: 'done' }, { text: 'Cache the query', state: 'doing' }, { text: 'Tests', state: 'todo' }], met: [1],
    proposedAt: ago(120), approvedAt: ago(100), doneAt: null, criteria: ['Three runs in a row answer in under a second'], estimateMinutes: 180, etaMinutes: 25, etaAt: ago(0) };
  // own: that computer says each was started by me (lib/peer/cards.mjs teammateSessions).
  const people = [{ peer: SARA, name: 'sara', box: 'sara-box', online: true, heardAt: ago(0), mine: true, sessions: [
    teamSession({ id: '0123456789abcdee', title: 'Nightly checks', by: 'ana', own: true, plan: task.id, task, ref: `${HOME}:6` }),
    teamSession({ id: '0123456789abcdef', title: 'Flaky upload', column: 'needs', by: 'ana', own: true, at: ago(2), first: 'Find why uploads fail on slow networks', ref: `${HOME}:7` }),
    teamSession({ id: '0123456789abcded', title: 'Release notes', column: 'done', by: 'ana', own: true, at: ago(4), plan: 't-77aa0c31', ref: `${HOME}:8` }) ] }];
  peer.teammateTasks = () => []; peer.boardKeptOff = () => false;
  peer.teammateSessions = () => ({ repos: [{ repoId: WEB, name: 'acme/web', at: ago(0) }], people });
  const v = await view(t, { repo: repository(p.root), peer }), panels = v.panels, title = 'Your session on sara-box';
  const column = index => panels.kanbanLists[index].items.map(item => plainItem(item).trimEnd());
  const hint = () => modal(v, title)?.children.filter(child => child.type === 'text').map(child => child.getText()).join('\n') ?? '';
  await send(v, '/kanban'); await until(() => v.current.view === 'kanban' && column(1).length === 1 && column(2).length === 1 && column(3).length === 1, 'the cards');
  panels.kanbanLists[1].focus(); panels.kanbanLists[1].select(0);
  // Its line under the board says it is mine, and a key that would move it says so too.
  await until(() => /Your session on sara-box · In progress · Task: Make the search page fast/.test(panels.status.getText()), 'its line says mine');
  assert.doesNotMatch(panels.status.getText(), /@ana|read-only/);
  v.input.write('x'); await until(() => /That is your session on sara-box\. Enter opens it; it changes only on that computer\./.test(panels.status.getText()), 'x refused as mine');
  v.input.write('\r');
  await until(() => rowsOf(v, title).length, 'the card opens');
  const rows = rowsOf(v, title).map(line => line.trimEnd());
  assert.deepEqual(rows.slice(0, 3), ['Make the search page fast', 'in progress · priority high · severity high', 'you · sara-box']);
  for (const line of ['Goal', 'The search page answers in under a second.', 'Description', 'Objectives · 1 of 2 met', '  ✓ A timing test for the search page', 'Success criteria', '  · Three runs in a row answer in under a second', 'Subtasks · 1 of 3 done', '  ▸ Cache the query', 'last activity 1m ago']) assert.ok(rows.includes(line), line);
  assert.match(rows.find(line => /^ETA /.test(line)), / · in (24|25) min$/, 'the minutes left it last reported');
  assert.doesNotMatch(rows.join('\n'), /their machine|only they can change it|read-only/);
  assert.match(hint(), /enter go to session/);
  assert.equal(modal(v, title).children.find(child => child.type === 'button')?.getText().trim(), 'Go to session');
  // Enter presses Go to session: it opens in Sessions, with the cursor on it under its computer.
  v.input.write('\r');
  await until(() => v.current.view === 'tasks' && !modal(v, title) && /Nightly checks/.test(plainItem(panels.board.items[panels.board.selected] ?? { getText: () => '' })), 'Sessions, on that session');
  assert.deepEqual(peer.sent(), []);
  await send(v, '/kanban'); await until(() => v.current.view === 'kanban' && column(2).length === 1, 'back on the board');
  // No Task yet: its first message. Sessions does not list it here, so Enter only closes.
  panels.kanbanLists[2].focus(); panels.kanbanLists[2].select(0); v.input.write('\r');
  await until(() => rowsOf(v, title).includes('No Task yet'), 'no Task yet');
  assert.deepEqual(rowsOf(v, title).map(line => line.trimEnd()), ['Flaky upload', 'Needs you', 'you · sara-box', '', 'No Task yet', 'Find why uploads fail on slow networks', '', 'last activity 2m ago']);
  assert.doesNotMatch(hint(), /enter (open|go to session)/); assert.equal(modal(v, title).children.some(child => child.type === 'button'), false, 'no Go to session');
  v.input.write('\x1b'); await until(() => !modal(v, title), 'Esc closes it');
  // From an older build there: it has a Task that did not come with the card.
  panels.kanbanLists[3].focus(); panels.kanbanLists[3].select(0); v.input.write('\r');
  await until(() => rowsOf(v, title).includes('No Task yet'), 'an older build');
  assert.ok(rowsOf(v, title).some(line => /It has a Task\. Update ELU on sara-box to see it here\./.test(line)));
  v.input.write('\x1b'); await until(() => !modal(v, title), 'Esc closes it');
});

test('a teammate\'s session on my other computer opens with their name, not as mine: its first message, and its Go to session button opens it in Sessions', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const HOME = '0123456789abcdef', listed = { id: '11111111-2222-4333-8444-555555555556', ref: `${HOME}:9`, project: HOME, title: 'Kim asks for a fix', state: 'running', at: ago(0), createdAt: ago(60), approvals: [], by: 'teammate', who: 'kim', repoId: WEB, question: null, error: null, plan: null };
  const peer = fakePeer({ mine: [{ key: SARA, mine: true, theirs: true }], machines: [{ key: SARA, listedAt: ago(0), older: false, projects: [{ id: HOME, name: 'home', repoId: null, home: true }], sessions: [listed] }], repoId: WEB });
  // own: false, as that computer tells it for a session a teammate's message started there.
  const people = [{ peer: SARA, name: 'sara', box: 'sara-box', online: true, heardAt: ago(0), mine: true, sessions: [teamSession({ id: '0123456789abcdee', title: 'Kim asks for a fix', by: 'kim', first: 'Fix the cart total for coupons', ref: `${HOME}:9` })] }];
  peer.teammateTasks = () => []; peer.boardKeptOff = () => false;
  peer.teammateSessions = () => ({ repos: [{ repoId: WEB, name: 'acme/web', at: ago(0) }], people });
  const v = await view(t, { repo: repository(p.root), peer }), panels = v.panels, title = "kim's session on sara-box";
  const column = index => panels.kanbanLists[index].items.map(item => plainItem(item).trimEnd());
  await send(v, '/kanban'); await until(() => v.current.view === 'kanban' && column(1).length === 1, 'the card');
  assert.match(column(1)[0], /@kim · sara-box/);
  panels.kanbanLists[1].focus(); panels.kanbanLists[1].select(0);
  await until(() => /@kim's session on sara-box · In progress · read-only/.test(panels.status.getText()), 'its note names kim');
  v.input.write('\r');
  await until(() => rowsOf(v, title).length, 'the card opens');
  const rows = rowsOf(v, title).map(line => line.trimEnd());
  assert.deepEqual(rows.slice(0, 3), ['Kim asks for a fix', 'In progress', 'Started by @kim · on sara-box']);
  assert.ok(rows.includes('Fix the cart total for coupons'));
  assert.doesNotMatch(rows.join('\n'), /you · |their machine/);
  // It is in Sessions, so the card has Go to session, with the focus: Enter presses it.
  const press = modal(v, title).children.find(child => child.type === 'button');
  assert.equal(press?.getText().trim(), 'Go to session'); assert.equal(v.current.screen.focused, press);
  v.input.write('\r');
  await until(() => v.current.view === 'tasks' && !modal(v, title) && /Kim asks for a fix/.test(plainItem(panels.board.items[panels.board.selected] ?? { getText: () => '' })), 'Sessions, on that session');
  assert.deepEqual(peer.sent(), []);
});

test('/share off keeps the open project\'s Tasks off the team board and /share on puts them back', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer(), calls = [];
  peer.taskBoard = (root, on) => { calls.push([root, on]); return null; };
  const v = await view(t, { repo: repository(p.root), peer });
  await send(v, '/share off'); await until(() => /kept off the team board: teammates do not see your sessions here, and theirs are not shown\. \/share on puts it back\./.test(v.panels.status.getText()), 'off');
  await send(v, '/share on'); await until(() => /on the team board again/.test(v.panels.status.getText()), 'on');
  assert.deepEqual(calls, [[p.root, false], [p.root, true]]);
});

test('on no team, Kanban has no teammates\' cards and asks for nothing', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ teamless: true }); let asked = 0;
  peer.teammateTasks = () => { asked++; return [{ peer: SARA, name: 'sara', online: true, heardAt: ago(0), tasks: [teamTask()] }]; }; peer.taskSharing = () => { asked++; return 'on'; };
  const v = await view(t, { repo: repository(p.root), peer });
  await send(v, '/kanban'); await until(() => v.current.view === 'kanban' && !v.panels.kanbanBoxes[0].hidden, 'Kanban');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(v.panels.kanbanTeam.hidden, true); assert.equal(asked, 0); assert.equal(v.panels.kanbanBoxes[1]._label.getText().trim(), 'In progress 0');
});

// Usage: the top agents by cost, from this computer and my computers that are online.
test('Usage lists the top ten agents by cost with their tokens, t shows the last 7 days, Enter opens a session here or there, and an older computer of mine is told to update', { timeout: 60000 }, async t => {
  const p = project(later(t)); environment(t, p.parent); registerProject(repository(p.root));
  // Stand-in vendor CLIs first on PATH: the tab's own check never reaches a real one.
  const before = process.env.PATH; process.env.PATH = fakeClis(p.parent).env.PATH; owned(t).files.push(() => { process.env.PATH = before; });
  // Each run names its log, as every run does; these logs lie outside the sessions, so no chat is read from them.
  const now = new Date().toISOString(), threeDays = new Date(Date.now() - 3 * 86400000).toISOString(), logFile = path.join(p.parent, 'run.log');
  const { repo } = liveTask(p.root, { id: '1', goal: 'Fix the coupons' });
  saveTask(repo, { ...readTask(repo, '1'), runs: [
    { role: 'lead', vendor: 'claude', logFile, at: now, costUsd: 12.4, model: 'claude-opus-5-5', tokens: { input: 1200000, output: 34000, cacheRead: 8100000, cacheWrite: 0 } },
    { role: 'bot:pair', vendor: 'codex', logFile, at: now, costUsd: null, model: 'gpt-6.1-sol', tokens: { input: 5000, output: 900, cacheRead: 1000, cacheWrite: 0 } }] });
  const conversation = (id, goal, runs) => saveTask(repo, { id: String(id), kind: 'conversation', goal, state: 'answered', worktree: p.root, base: null, branch: null, createdAt: now, runs: runs.map(run => ({ logFile, ...run })), reviews: [], responses: [], messages: [], sessions: {}, result: null });
  conversation(2, 'Speed up the build', [{ role: 'lead', vendor: 'claude', at: threeDays, costUsd: 50 }]);
  // My other computer: one session there, and what its agents spent.
  const P = '5'.repeat(16), RID = '55555555-5555-4555-8555-555555555555';
  const remoteRow = { ref: `${P}:5`, id: RID, agent: '@lead', title: 'Remote job', model: 'opus 5.5', tokens: { input: 900, output: 80, cacheRead: 40000, cacheWrite: 0 }, costUsd: 20, partial: false, at: now };
  const machines = [{ key: SARA, listedAt: now, older: false, projects: [{ id: P, name: 'shop', repoId: null, home: false }],
    sessions: [{ id: RID, ref: `${P}:5`, project: P, title: 'Remote job', state: 'answered', at: now, createdAt: now, approvals: [], by: 'you', who: null, repoId: null }],
    topAgents: { today: { costUsd: 20, partial: false, rows: [remoteRow] }, week: { costUsd: 25, partial: false, rows: [{ ...remoteRow, costUsd: 25 }] } } }];
  const peer = fakePeer({ items: [], mine: [{ key: SARA, mine: true, theirs: true }], machines });
  const v = await view(t, { repo: repository(p.root), dashboard: true, peer, usage: { env: { HOME: temp(t) }, vendors: () => [] } });
  const list = v.panels.usageList, rows = () => list.items.map(plainItem);
  const agentRows = () => rows().slice(rows().findIndex(row => /^Agent /.test(row)) + 1).filter(row => /^@/.test(row));
  await send(v, '/usage'); await until(() => v.current.view === 'usage' && rows().includes('Top agents today'), 'the section');
  await until(() => agentRows().length === 3, 'three agents today');
  // Most cost first, with where it ran, the model, tokens, the cost at API price and its share of today's total ($32.40).
  assert.match(rows().find(row => /^Agent /.test(row)), /^Agent +Session +Model +in · out · cache +Cost \(API price\) +Share$/);
  assert.equal(rows().join('\n').match(/Cost \(API price\)/g).length, 1);
  const [first, second, third] = agentRows();
  assert.match(first, /^@lead +Remote job +on sara-box +opus 5\.5 +900 · 80 · 40k +\$20\.00 +62%$/);
  assert.match(second, /^@lead +Fix the coupons +opus 5\.5 +1\.2M · 34k · 8\.1M +\$12\.40 +38%$/);
  assert.match(third, /^@pair +Fix the coupons +gpt-6\.1-sol +5k · 900 · 1k +— +—$/);
  // The spend line is this computer's: what the section counts here, at least that, as Codex reported no cost.
  assert.ok(rows().includes('ELU spend today at least $12.40'));
  assert.ok(rows().every(row => row.length <= list.width - 2), 'every line fits');
  // t: the last seven days. The keys say so.
  list.focus(); await until(() => v.current.screen.focused === list, 'list focused');
  assert.match(v.panels.keys.getText(), /d details {2}r refresh {2}t 7 days/);
  v.input.write('t'); await until(() => rows().includes('Top agents, last 7 days'), 'the week');
  assert.match(agentRows()[0], /^@lead +Speed up the build +claude +— +\$50\.00 +57%$/);
  assert.match(agentRows()[1], /^@lead +Remote job +on sara-box .* \$25\.00 +29%$/);
  assert.ok(rows().includes('ELU spend today at least $12.40'), 'the spend line stays today');
  v.input.write('t'); await until(() => rows().includes('Top agents today'), 'today again');
  // Enter on a row here opens its session, in Sessions beside the list.
  selectRow(list, /^@lead +Fix the coupons/); await until(() => /enter open/.test(v.panels.keys.getText()), 'enter opens');
  v.input.write('\r'); await until(() => v.current.view === 'tasks' && v.current.session === '1', 'the session here');
  // Enter on a row of my other computer opens it in Sessions, under that computer.
  await send(v, '/usage'); await until(() => v.current.view === 'usage' && agentRows().length === 3, 'back in Usage');
  list.focus(); selectRow(list, /^@lead +Remote job/); v.input.write('\r');
  await until(() => v.current.view === 'tasks' && /Remote job/.test(plainItem(v.panels.board.items[v.panels.board.selected] ?? { getText: () => '' })), 'the session there, under the cursor');
  // At most ten rows: nine more sessions here.
  for (let id = 3; id <= 11; id++) conversation(id, `Small job ${id}`, [{ role: 'lead', vendor: 'claude', at: now, costUsd: id / 100 }]);
  await send(v, '/usage'); await until(() => v.current.view === 'usage' && agentRows().length === 10 && rows().some(row => /Small job 11/.test(row)), 'ten rows');
  assert.ok(!rows().some(row => /Small job 3 /.test(row) || /^@pair/.test(row)), 'the cheapest and the one with no cost are left out');
  assert.ok(rows().includes('ELU spend today at least $13.03'), 'the spend line still counts every run here');
  // At 80 columns each agent is still one line that fits the pane.
  v.output.columns = 80; v.output.rows = 24; v.output.emit('resize');
  await until(() => v.current.screen.width === 80 && list.width < 80, '80 columns');
  await until(() => agentRows().length === 10 && rows().every(row => row.length <= list.width - 2), 'every row fits');
  // A computer of mine on a build that sends none: one line, and none of its rows.
  machines[0] = { ...machines[0], topAgents: null };
  await until(() => rows().includes('sara-box: update ELU to include it') && !rows().some(row => /Remote job/.test(row)), 'the update line');
});

// The new session box, @ a computer of mine where the home folder is a project and no team
// setting decides where its sessions run: before the session starts, the owner picks the folder
// it works in there. The cursor starts on where it would run.
test('@ my other computer asks which folder the session works in there, when its home folder is a project; Esc sends nothing, and an older build is not asked', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const asked = { pick: true, root: '/home/sara', project: 'sara', folders: [{ path: '/home/sara', label: '~', name: 'sara', project: true }, { path: '/home/sara/shop', label: '~/shop', name: 'shop', project: false }, { path: '/home/sara/work/infra', label: '~/work/infra', name: 'infra', project: false }] };
  let where = asked;
  const answer = command => command.type === 'remoteFolders' ? (() => { if (where instanceof Error) throw where; return where; })() : command.type === 'remoteStart' ? { id: '77777777-7777-4777-8777-777777777777', project: command.folder ? path.basename(command.folder) : 'sara' } : null;
  const peer = fakePeer({ items: [], mine: [{ key: SARA, mine: true, theirs: true }], answer }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const starts = () => peer.sent().filter(row => row.type === 'remoteStart'), status = () => v.panels.status.getText(), title = 'Folder on @sara-box';
  await send(v, '@sara-box fix the flaky test');
  await until(() => rowsOf(v, title).length === 3, 'the folders there');
  assert.deepEqual(rowsOf(v, title).map(row => row.trimEnd()), ['~  the home folder', '~/shop', '~/work/infra']);
  assert.match(v.text(), /Pick the folder this session works in on @sara-box\./);
  assert.equal(modal(v, title).children.find(child => child.type === 'list').selected, 0, 'on where it would run');
  assert.deepEqual(starts(), [], 'nothing starts before he picks');
  await choose(v, title, /shop/);
  await until(() => starts().length === 1, 'started');
  assert.equal(starts()[0].folder, '/home/sara/shop'); assert.equal(starts()[0].text, 'fix the flaky test'); assert.equal(starts()[0].to, SARA);
  await until(() => /Started on @sara-box in shop\./.test(status()), 'where it started');
  // Esc: nothing is sent, and the message is still in the box.
  await send(v, '@sara-box tidy the notes');
  await until(() => modal(v, title), 'asked again'); v.input.write('\x1b');
  await until(() => !modal(v, title) && /Nothing was sent\. The message is still here\./.test(status()), 'Esc');
  assert.equal(starts().length, 1); assert.equal(v.panels.ask.getValue(), '@sara-box tidy the notes');
  // Where it would run now is shop: the cursor starts there, and Enter picks it.
  where = { ...asked, root: '/home/sara/shop', project: 'shop', folders: [asked.folders[0], { ...asked.folders[1], project: true }, asked.folders[2]] };
  await send(v, '@sara-box run the tests');
  await until(() => modal(v, title), 'asked'); assert.equal(modal(v, title).children.find(child => child.type === 'list').selected, 1);
  v.input.write('\r'); await until(() => starts().length === 2, 'started there');
  assert.equal(starts()[1].folder, '/home/sara/shop');
  // The home folder, picked: it runs there.
  await send(v, '@sara-box read my notes'); await choose(v, title, /the home folder/);
  await until(() => starts().length === 3, 'started in the home folder'); assert.equal(starts()[2].folder, '/home/sara');
  // A team setting decides, an older build there, or a daemon that cannot ask: not asked, and it starts as before.
  for (const [said, made] of [['no choice', { pick: false, root: '/home/sara/shop', project: 'shop', folders: [] }], ['older', { pick: false, root: null, project: null, folders: [], older: true }], ['refused', new Error('Unknown peer command.')]]) {
    where = made; const before = starts().length;
    await send(v, `@sara-box ${said}`);
    await until(() => starts().length === before + 1, said);
    assert.equal(modal(v, title), undefined, `${said}: not asked`); assert.equal('folder' in starts().at(-1), false, said);
  }
});
