import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { project, temp, fakeClis, keyThenEnter } from './helpers.mjs';
import { liveTask, makeTeam, registeredProject, withHome } from './peer-helpers.mjs';
import { hash } from '../lib/util.mjs';
import { shareProjects } from './peer-helpers.mjs';
import { newLogin, finishLogin } from '../lib/logins.mjs';
import { personalDirectory, recordAccount } from '../lib/usage.mjs';
import { hostMethods, remoteCommand, watchId } from '../lib/peer/remote.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { offerFiles, offerPaths, stageFiles } from '../lib/peer/index.mjs';
import { BYTES_MAX } from '../lib/peer/files.mjs';
import { repository } from '../lib/git.mjs';
import { claimView, nameProject, registerProject, sessionWire } from '../lib/projects.mjs';
import { saveRequest, pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { launchTerminal } from '../lib/terminal.mjs';
import { listBots, removeBot, saveBot } from '../lib/bots.mjs';
import { boardRows, barCells, barColumns } from '../lib/board.mjs';
import { closeSession, readBoard, reopenSession } from '../lib/kanban.mjs';
import { readTask, saveTask, taskDir, tasks } from '../lib/state.mjs';
import { markMyComputer } from '../lib/peer/my-computers.mjs';
import { helperLink } from '../lib/remote-helper.mjs';
import { clockTime } from '../lib/terminal-plan.mjs';
import { botTarget, chatBar, dmTarget, fitWords, ink, membersLine, peerName, roomTarget, teamPanes, threadTarget, visible } from '../lib/terminal-visuals.mjs';
import { joinWait, noRoute } from '../lib/peer/join-text.mjs';
import { columns } from '../lib/width.mjs';
import { readProjectSettings } from '../lib/project-settings.mjs';
import { defaultBox, peerBox, peerSettings } from '../lib/peer/settings.mjs';

const ME = 'a'.repeat(64), SARA = 'b'.repeat(64), LI = 'c'.repeat(64);
const LONG = 'Could you check whether the retry budget in the uploader resets after a successful flush or only after restart because we keep seeing duplicate batches';
const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();

// teamless: this machine is on no team until /invite makes one (createTeam).
// sharing: the keys of computers that share a project with this one; remote: remoteSessions(); machines: remoteMachines(); repoId: projectRepoId(); joined: what joinTeam answers.
// answer(command): what the daemon answers a command, when it is not the usual {}.
function fakePeer({ items, saraName = 'sara', running = true, refuse = () => null, remoteBots = [], teamless = false, access = { 'team-1': { handling: 'auto', rules: '', root: null, at: null } }, sharing = [], remote = [], machines = [], repoId = null, joined = null, answer = null } = {}) {
  const calls = [];
  const record = (name, value) => (...args) => { calls.push([name, ...args]); return typeof value === 'function' ? value(...args) : value; };
  const facade = {
    calls, running, channels: [],
    sent: () => calls.filter(row => row[0] === 'sendPeerCommand').map(row => row[1]),
    onTeam: () => !facade.left && (!teamless || facade.made === true),
    peerStatus: record('peerStatus', () => ({ running: facade.running, stale: facade.stale === true, pid: 1, key: ME, name: 'ana', fingerprint: 'aaaaaaaa', error: null, counters: { direct: 1, relayed: 0, failed: 0 },
      teams: teamless && !facade.made ? [] : [{ id: 'team-1', name: 'Core', role: 'admin', members: [
        { key: ME, fingerprint: 'aaaaaaaa', name: 'ana', role: 'admin', online: true, path: null, lastSeen: ago(0) },
        { key: SARA, fingerprint: 'bbbbbbbb', name: saraName, role: 'member', online: true, path: 'direct', lastSeen: ago(0), box: 'sara-box', bots: remoteBots },
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
    joinedProject: record('joinedProject', (teamId, project) => project),
    remoteSessions: () => remote,
    // A computer in sharing shares a project with this one: it has listed here, with nothing yet unless machines says.
    // A computer lists only the projects it shares, each with its team (team-1 unless said).
    // The rows are the test's own, so what a test changes in them shows at the next read.
    remoteMachines: () => { for (const row of machines) for (const project of row.projects ?? []) project.teams ??= ['team-1']; return [...machines, ...sharing.filter(key => !machines.some(row => row.key === key)).map(key => ({ key, theirs: true, listedAt: ago(0), projects: [], sessions: [] }))]; },
    // Team-1's project here is the folder the app opened (view sets root), else one of no project.
    teamProjectRoots: () => [{ team: 'team-1', root: facade.root ?? '/nowhere/team-project', name: 'shop' }],
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
  const values = { XDG_CONFIG_HOME: path.join(parent, 'personal'), ELU_NO_COLOR: '1', TERM: 'xterm-256color' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  owned(t).files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// The user name this computer gives, as USER says, for the test only.
function userName(t, name) {
  const previous = { USER: process.env.USER, LOGNAME: process.env.LOGNAME };
  process.env.USER = name; delete process.env.LOGNAME;
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
async function view(t, { columns = 160, rows = 40, ...options } = {}) {
  // The folder the app opens is the team's project there, as /join made it.
  if (options.peer && options.repo && options.peer.root === undefined) options.peer.root = options.repo.root;
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = columns; output.rows = rows;
  let rendered, renders = 0, writes = 0;
  output.on('data', () => { writes++; });
  const finished = launchTerminal({ ...options, input, output, refreshMs: 30, startConductor: () => false, onRender: value => { rendered = value; renders++; } });
  finished.catch(() => {});
  await until(() => rendered, 'first render');
  // A row's key is its letter, then Enter (keyThenEnter). type() writes text as it is.
  const write = keyThenEnter(input, () => rendered);
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
      else { rendered.panels.tabs[0].focus(); rendered.screen.emit('keypress', 'q', { name: 'q' }); }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    input.destroy(); output.destroy();
  });
  return { type(text) { for (const ch of text) write(ch); }, input, output, finished, get current() { return rendered; }, get panels() { return rendered.panels; }, get renders() { return renders; }, get writes() { return writes; },
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
  // Channels, then people, then my own bots: the six the app comes with. A teammate's sessions sit under that teammate, named by what they do with no number, and a row counts the threads that wait for me.
  const items = v.panels.teamLists[0].items.map(item => plainItem(item).trimEnd()), sara = items.findIndex(line => /@sara-box · sara\s+direct/.test(line));
  assert.deepEqual(items.slice(0, 5), ['Channels', '# general  3', '+ Add channel', '', 'Direct messages']);
  assert.match(items[sara], /^● @sara-box · sara\s+direct\s+1$/); assert.match(items[sara + 1], /^\s+⚠ @sara web editing · overlap/); assert.ok(!/#\d/.test(items[sara + 1]), 'a teammate’s session shows no number');
  assert.match(items[sara + 2], /^○ @li\s+offline\s+2$/); assert.deepEqual(items.slice(sara + 3), ['◆ @reviewer', '◆ @lead', '◆ @qa', '◆ @pair', '◆ @orchestrator', '◆ @elu', '+ Add teammate']);
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

test('a thread whose row is as wide as its pane keeps its last word, in colour as the app runs', async t => {
  const parent = temp(later(t)); environment(t, parent); delete process.env.ELU_NO_COLOR;
  const peer = fakePeer({ items: [] }), v = await view(t, { peer });
  await send(v, '/chats'); await until(() => v.current.view === 'chats', 'Chats');
  await openRow(v, /@sara/, '@sara');
  // A list row stops one column short of its pane. This one is as wide as a row may be, 中
  // counted as the two columns it takes. blessed wrapped it again at its last space, and a
  // list shows one row of each.
  const list = v.panels.teamLists[1], room = list.width - 2, lead = '← @sara asks you · ', words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda'.split(' ');
  let question = '中 '; for (let at = 0; columns(question) < room - lead.length - 12; at++) question += `${words[at % words.length]} `;
  question += `${'m'.repeat(room - lead.length - columns(question) - 3)} et`;
  peer.peerItems = () => [{ id: 'incoming-9', kind: 'incoming', peer: SARA, name: 'sara', project: 'web', text: question, at: ago(1), state: 'submitted', threadId: 'th-9' }];
  const row = () => list.items.find(item => /asks you/.test(plainItem(item)));
  await until(() => row(), 'the thread'); v.current.screen.render();
  assert.equal(plainItem(row()).replace(/\x03/g, '').trimEnd(), `${lead}${question}`); assert.equal(columns(plainItem(row()).replace(/\x03/g, '').trimEnd()), room, 'one short of the pane, as every list row is');
  assert.equal(row()._clines.length, 1, 'one row, not two');
  assert.ok(v.lines()[row().atop].replace(/\x03/g, '').includes(`${lead}${question}`), 'the whole row is drawn, "et" with it');
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

// Chats was opened by typing /chats. The first Up from the message box brought /chats back into it and the first Down
// emptied it again: the cursor never left the box, and the key bar said nothing about either key.
for (const [columns, rows] of [[140, 50], [80, 24]]) test(`the key bar says where the cursor is after every Up and Down from the message box in Chats at ${columns}x${rows}`, { timeout: 30000 }, async t => {
  const peer = fakePeer({ items: [] }); peer.channels = [{ id: 'd'.repeat(16), name: 'design', members: [ME, SARA] }];
  const { v } = await teamView(t, { columns, rows, peer });
  const [bar] = v.panels.teamLists, ask = v.panels.ask, keys = () => v.panels.keys.getText().trim(), at = () => plainItem(bar.items[bar.selected]).trim(), focused = () => v.current.screen.focused;
  // The empty box sends nothing, so its bar names no Enter; with text in it, Enter sends.
  const box = '@name one member  / commands  ! run a shell command', typed = `enter send  ${box}`;
  await until(() => bar.items.length > 5 && focused() === ask && ask.getValue() === '' && keys() === box, `the cursor is in the empty message box, not ${keys()}`);
  // Up: /chats is in the box again and the cursor is still there. The bar names the key that takes it out.
  v.input.write('\x1b[A'); await until(() => ask.getValue() === '/chats' && focused() === ask, 'Up brings /chats back');
  await until(() => keys() === 'enter send  ↓ clear  @name one member  / commands  ! run a shell command', 'the bar says what Down does with it');
  // Down: the box is empty again, and the bar is the empty box's.
  v.input.write('\x1b[B'); await until(() => ask.getValue() === '' && focused() === ask && keys() === box, 'Down clears the box');
  // Down again leaves the box for the Team bar, and the bar is that row's.
  v.input.write('\x1b[B'); await until(() => focused() === bar && keys() === 'enter write  n new channel  tab threads', 'Down from the empty box reaches the Team bar');
  assert.equal(at(), '# general  3');
  // Every row of the bar, down and back up: the bar names that row's keys after each key. A teammate's live session has its teammate's keys.
  // A teammate's keys: the bar holds as many as fit, and n new channel is the one that goes at 80 columns.
  // Enter on a teammate's live session opens what it works on, not the message box.
  const person = `enter write  t trust  h hold replies  o auto-continue  tab threads${columns >= 83 ? '  n new channel' : ''}`, agent = `enter details  t trust  h hold replies  o auto-continue  tab threads${columns >= 85 ? '  n new channel' : ''}`;
  const hints = line => /^\+ Add channel/.test(line) ? 'enter new channel  ↑↓ choose' : /^\+ Add teammate/.test(line) ? 'enter invite a teammate  ↑↓ choose' : /^# design/.test(line) ? 'enter write  n new channel  m members  x leave  tab threads'
    : /^[⚠·] @/.test(line) ? agent : /^[●○] @/.test(line) ? person : 'enter write  n new channel  tab threads';
  const stops = bar.items.map(item => plainItem(item).trim()).filter(line => !['Channels', '', 'Direct messages'].includes(line));
  assert.ok(stops.some(line => /^# design/.test(line)) && stops.some(line => /^● @sara/.test(line)) && /^\+ Add teammate/.test(stops.at(-1)));
  for (const [key, order] of [['\x1b[B', stops.slice(1)], ['\x1b[A', stops.slice(0, -1).reverse()]]) for (const line of order) { v.input.write(key); await until(() => focused() === bar && at() === line && keys() === hints(line), `the keys of ${line}, now ${keys()}`); }
  // Up from the first channel is the Chats tab; Down comes back to the bar, and Esc goes to the message box.
  v.input.write('\x1b[A'); await until(() => focused() === v.panels.tabs.find(tab => tab.viewName === 'chats') && keys() === '←→ switch  enter open  ↓ chats', 'the tab and its keys');
  v.input.write('\x1b[B'); await until(() => focused() === bar && keys() === hints(stops[0]), 'back on the bar');
  v.input.write('\x1b'); await until(() => focused() === ask && keys() === box, 'Esc returns to the message box and its keys');
  // With more sent, the bar says which way is older and which is newer, and stops saying so once the text is changed.
  await send(v, 'one'); await send(v, 'two');
  await until(() => focused() === ask && ask.getValue() === '' && keys() === box, 'both are sent and the box is empty');
  v.input.write('\x1b[A'); await until(() => ask.getValue() === 'two' && keys().startsWith('enter send  ↑ older  ↓ clear  @name one member'), 'the newest: older is up, clear is down');
  v.input.write('\x1b[A'); await until(() => ask.getValue() === 'one' && keys().startsWith('enter send  ↑ older  ↓ newer  @name one member'), 'between two');
  v.input.write('\x1b[A'); await until(() => ask.getValue() === '/chats' && keys().startsWith('enter send  ↓ newer  @name one member'), 'the oldest has none over it');
  v.input.write('\x1b[B'); await until(() => ask.getValue() === 'one' && keys().startsWith('enter send  ↑ older  ↓ newer'), 'and down is newer');
  v.input.write('x'); await until(() => ask.getValue() === 'onex' && keys() === typed, 'changed text is the owner\'s own: the arrows no longer walk');
  assert.equal(focused(), ask);
});

// A click on a heading or on the blank row puts the cursor on the row next to it, the way the click went from
// the cursor; a heading with no row over it gives the row under it.
for (const [columns, rows] of [[140, 50], [80, 24]]) test(`a click on a heading of the Team bar lands on the row next to it at ${columns}x${rows}`, { timeout: 30000 }, async t => {
  const { v } = await teamView(t, { columns, rows, peer: fakePeer({ items: [] }) });
  const [bar] = v.panels.teamLists, at = () => plainItem(bar.items[bar.selected]).trim(), open = () => v.panels.teamBoxes[1]._label.getText().trim(), keys = () => v.panels.keys.getText().trim();
  await until(() => bar.items.length > 5 && open() === '#general', 'the bar opens on #general');
  const all = bar.items.map(item => plainItem(item).trim()), place = pattern => all.findIndex(line => pattern.test(line));
  assert.deepEqual(all.slice(0, 6).map(line => line.replace(/^(● @sara).*/, '$1')), ['Channels', '# general  3', '+ Add channel', '', 'Direct messages', '● @sara']);
  // The cursor starts on one row and the mouse presses another, where that row is drawn now (a short bar scrolls).
  const click = async (from, to) => {
    bar.focus(); bar.select(to); bar.select(from); await until(() => bar.selected === from, `the cursor on row ${from}`);
    const y = bar.atop + to - bar.childBase; assert.ok(to >= bar.childBase && y < bar.atop + bar.height, `row ${to} shows`);
    await until(() => bar.items[to].lpos?.yi === y && bar.items[from].lpos?.yi === bar.atop + from - bar.childBase, `row ${to} is drawn where the mouse presses`);
    v.input.write(`\x1b[<0;${bar.aleft + 4};${y + 1}M`); v.input.write(`\x1b[<0;${bar.aleft + 4};${y + 1}m`);
    await until(() => bar.selected !== from || to === from, `a click on row ${to} from row ${from} moves the cursor`); return at();
  };
  const general = place(/^# general/), add = place(/^\+ Add channel/), blank = all.indexOf(''), direct = all.indexOf('Direct messages'), sara = place(/^● @sara/), li = place(/^○ @li/);
  // Going down: the heading gives the first direct chat under it, and the threads beside the bar are that person's.
  assert.match(await click(general, direct), /^● @sara/); await until(() => open() === '@sara' && keys() === `enter write  t trust  h hold replies  o auto-continue  tab threads${columns >= 83 ? '  n new channel' : ''}`, '@sara opens, with a person\'s keys');
  assert.equal(v.current.screen.focused, bar);
  assert.match(await click(add, blank), /^● @sara/);
  // Going up: the row over the blank row.
  assert.equal(await click(sara, direct), '+ Add channel'); await until(() => keys() === 'enter new channel  ↑↓ choose', 'the add row\'s keys');
  assert.equal(await click(li, blank), '+ Add channel');
  // The first heading has no row over it: the first channel, from wherever the cursor was.
  assert.equal(await click(add, 0), '# general  3'); await until(() => open() === '#general' && keys() === 'enter write  n new channel  tab threads', '#general opens');
  // A bar too short to show both rows at once cannot have this click.
  if (bar.height > sara) assert.equal(await click(sara, 0), '# general  3');
  // A row that can be chosen takes the click itself.
  assert.match(await click(sara, li), /^○ @li/); await until(() => open() === '@li', '@li opens with a click');
  assert.ok(!['Channels', '', 'Direct messages'].includes(at()));
});

// In a bar too short to show every row, the cursor came up to the first row under a heading with that heading
// scrolled out of view over it: the first channel showed with no Channels over it until Up left the bar.
test('a heading of the Team bar stays in view over its first row when the bar is short, at 80x24', { timeout: 30000 }, async t => {
  const { v } = await teamView(t, { columns: 80, rows: 24, peer: fakePeer({ items: [] }) });
  const [bar] = v.panels.teamLists, at = () => plainItem(bar.items[bar.selected]).trim(), shown = () => v.lines().slice(bar.atop, bar.atop + bar.height).map(line => line.slice(bar.aleft, bar.aleft + 20).trim());
  await until(() => bar.items.length > 5, 'the bar');
  const all = bar.items.map(item => plainItem(item).trim());
  assert.ok(bar.height < all.length && bar.height > 2, 'the bar is shorter than its rows');
  bar.focus(); bar.select(all.length - 1); await until(() => bar.childBase > 0 && shown().at(-1) === all.at(-1), 'the bar is scrolled to its last row');
  const up = async to => { for (let from = at(); !to.test(at()); from = at()) { v.input.write('\x1b[A'); await until(() => at() !== from, `Up from ${from}`); } };
  // Up to the first direct chat: Direct messages is drawn over it, at the top of the bar.
  await up(/^● @sara/); await until(() => shown()[0] === 'Direct messages' && /^● @sara/.test(shown()[1]), `Direct messages over @sara, now ${shown().join(' | ')}`);
  // Up to the first channel: Channels is drawn over it, with the focus still on the bar.
  await up(/^# general/); await until(() => shown()[0] === 'Channels' && /^# general/.test(shown()[1]), `Channels over #general, now ${shown().join(' | ')}`);
  assert.equal(v.current.screen.focused, bar); assert.equal(bar.childBase, 0);
  // Down again keeps one row a key, and the cursor in view.
  v.input.write('\x1b[B'); await until(() => at() === '+ Add channel' && shown().includes('+ Add channel'), 'Down from the first channel');
  v.input.write('\x1b[B'); await until(() => /^● @sara/.test(at()) && shown().some(line => /^● @sara/.test(line)), 'Down to the first direct chat');
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
  await openRow(v, /@sara-box · sara\s+direct/, '@sara'); threads.focus(); selectRow(threads, /answered/); v.input.write('c');
  await until(() => peer.sent().some(row => row.type === 'continue' && row.id === 'answer-1'), 'continue');
  threads.focus(); selectRow(threads, /answered/); v.input.write('\r');
  await until(() => modal(v, 'Thread with @sara'), 'thread details');
  await closeDialog(v, 'Thread with @sara');
  roster.focus(); selectRow(roster, /@sara-box · sara\s+direct/); v.input.write('\r');
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
  await open(threads, /asks you/, 'Thread with @sara', 'y starts it now, as if you typed it. w picks the mode first. n declines.');
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
    await openRow(v, who === 'sara' ? /@sara-box · sara\s+direct/ : /@li\s+offline/, `@${who}`);
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
  await openRow(v, /@sara-box · sara\s+direct/, '@sara'); threads.focus(); selectRow(threads, /reply ready/); v.input.write('\r'); await until(() => modal(v, 'Thread with @sara'), 'dialog');
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
  threads.focus(); await until(() => /^\s*tab next$/.test(keys()), 'no thread to read, and no m or x for #general');
  v.input.write('m'); await until(() => /Everyone on the team is in #general\. \+ Add teammate invites someone\./.test(status()), 'm on #general');
  // A created channel lists its own people and names the key that changes them.
  await openRow(v, /# design/, '#design');
  await until(() => inside(v) === 'In #design · you, @sara · m changes who is in it', 'who is in #design');
  assert.deepEqual(threadLines(v), ['Nothing in #design yet. Type below to write to it. m changes who is in it.']);
  await until(() => /^\s*m members {2}x leave {2}tab next$/.test(keys()), 'm and x for a created channel');
  // A person's line says what is on for them, and their threads start under it too.
  await openRow(v, /@sara-box · sara\s+direct/, '@sara');
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
  await openRow(v, /@sara-box · sara\s+direct/, '@sara');
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
  bar.focus(); selectRow(bar, /@sara-box · sara\s+direct/); v.input.write('t'); await until(() => modal(v, 'Teammate @sara'), 'her screen');
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
  await openRow(v, /@sara-box · sara\s+direct/, '@sara');
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
  await openRow(v, /@sara-box · sara\s+direct/, '@sara');
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

// /ask typed on the list over a draft, refused with a teammate's name: the box held "@sara why"
// and the draft was gone. It comes back once the question is sent or cleared; Esc brings it
// back too, and ↑ the question.
test('a draft /ask was typed over comes back once the question to the teammate is sent or cleared, and Esc keeps both', { timeout: 30000 }, async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [] }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, ask = v.panels.ask, focused = () => v.current.screen.focused, status = () => v.panels.status.getText().replace(/\s+/g, ' '), asked = () => peer.sent().filter(row => row.type === 'ask');
  const askOver = async () => {
    v.input.write('\x1b'); await until(() => focused() === board, 'the list');
    v.type('/ask @sara why'); await until(() => ask.getValue() === '/ask @sara why', 'the command, set apart from the draft');
    v.type('\r'); await until(() => /Ask by name: Enter sends this to @sara\./.test(status()) && ask.getValue() === '@sara why' && ask.__listener, 'the question, ready to send');
  };
  ask.focus(); ask.readInput(); await until(() => ask.__listener && v.current.session === 'new', 'the new session box');
  ask.setValue('fix login'); await askOver();
  // Sent: the draft is back in the box.
  v.type('\r'); await until(() => asked().length === 1, 'asked');
  await until(() => ask.getValue() === 'fix login', `the draft is back once it is sent, not "${ask.getValue()}"`);
  // Cleared: the draft is back.
  await askOver();
  v.type('\x7f'.repeat('@sara why'.length)); await until(() => ask.getValue() === 'fix login', `the draft is back once it is cleared, not "${ask.getValue()}"`);
  assert.equal(asked().length, 1, 'nothing more was sent');
  // Esc: the draft is back, and ↑ brings the question back.
  await askOver();
  v.input.write('\x1b'); await until(() => focused() === board && ask.getValue() === 'fix login', `Esc brings the draft back, not "${ask.getValue()}"`);
  ask.focus(); ask.readInput(); await until(() => ask.__listener, 'the box'); ask.setValue('');
  v.input.write('\x1b[A'); await until(() => ask.getValue() === '@sara why', `↑ brings the question back, not "${ask.getValue()}"`);
});

// A character that is no key on a session's row went to that session as a message on Enter: x on
// a row under my other computer started a turn there with "x". It is not sent: the line under the
// box says it is no key there and names the row's keys, and more typed after it makes a message.
test('a lone character that is no key on a session row is not sent on Enter, there or here; the line under the box names the row keys, and more typing makes a message', { timeout: 30000 }, async t => {
  const T = Date.now(), stamp = minutes => new Date(T - minutes * 60000).toISOString(), id = '44444444-4444-4444-8444-444444444444';
  const remote = [{ id, machine: SARA, createdAt: stamp(5), lastAt: stamp(5), title: 'Invoice totals fix', state: 'answered', question: null, choices: [], steps: [], entries: [{ role: 'You', at: stamp(5), text: 'Fix the totals' }, { role: 'Opus 5.5', lead: true, at: stamp(5), text: 'Fixed them.' }], approvals: [] }];
  const p = project(later(t)); environment(t, p.parent);
  const repo = repository(p.root), at = new Date().toISOString();
  saveTask(repo, { id: '1', kind: 'conversation', goal: 'Find the tax rates', state: 'answered', worktree: repo.root, base: null, branch: null, createdAt: at, runs: [], reviews: [], responses: [], messages: [{ at, text: 'Find the tax rates' }], sessions: {}, result: null });
  const peer = fakePeer({ items: [], sharing: [SARA], remote, answer: command => command.type === 'remoteSend' ? { id: command.id } : null }), v = await view(t, { repo, dashboard: true, peer });
  const board = v.panels.board, ask = v.panels.ask, keys = () => v.panels.keys.getText().trim(), status = () => v.panels.status.getText().replace(/\s+/g, ' '), sentThere = () => peer.sent().filter(row => row.type === 'remoteSend');
  // A session on my other computer, under its name: x is no key there.
  await until(() => board.items.map(plainItem).some(row => /Invoice totals fix/.test(row)), 'its row');
  board.focus(); selectRow(board, /Invoice totals fix/); await until(() => / on @sara-box /.test(ask._label.getText()), 'its box');
  v.type('x'); await until(() => ask.getValue() === 'x', 'x in the box');
  await until(() => /^x is no key on this row {2}.*d changes/.test(keys()), `the line names it and the row's keys, not "${keys()}"`);
  v.type('\r'); await until(() => /x is no key on this row\./.test(status()), 'Enter says so');
  await new Promise(resolve => setTimeout(resolve, 300)); assert.deepEqual(sentThere(), [], 'nothing went there'); assert.equal(ask.getValue(), 'x', 'it stays in the box');
  // More typed after it is a message, sent there as always.
  v.type('yz'); await until(() => ask.getValue() === 'xyz', 'typed on');
  v.type('\r'); await until(() => sentThere().length === 1, 'sent there');
  assert.equal(sentThere()[0].text, 'xyz');
  // A session here: the same.
  board.focus(); selectRow(board, /Find the tax rates/); await until(() => v.current.session === '1', 'the session here');
  v.type('k'); await until(() => ask.getValue() === 'k' && /^k is no key on this row {2}.*e rename/.test(keys()), `k is no key there, not "${keys()}"`);
  v.type('\r'); await until(() => /k is no key on this row\./.test(status()), 'Enter says so');
  await new Promise(resolve => setTimeout(resolve, 300)); assert.deepEqual(pendingRequests(p.root), [], 'nothing was sent here');
});

test('at 80 columns the key bar of an open session on a team shows whole hints, none cut in the middle', { timeout: 20000 }, async t => {
  const p = project(later(t)); environment(t, p.parent);
  // In colour, as a terminal shows it: a coloured line as wide as its box loses its last word there.
  delete process.env.ELU_NO_COLOR;
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
  // With nothing typed, Enter sends nothing, so the bar leaves it out. ctrl+t, @name and / take
  // 54 of the 78 columns, and /model would not fit whole, so it is left out.
  await until(() => shown() === keys(), 'the screen shows the whole empty-box bar');
  assert.equal(shown(), 'ctrl+t Task  @name ask a bot or a teammate  / commands');
  // With text, the hints may take 78 columns here: enter, ctrl+t, @name and / take 67, and
  // /model would not fit whole, so it is left out. The screen shows all of what the bar holds.
  ask.setValue('Show the rates'); await until(() => keys().startsWith('enter send'), 'with text, Enter sends it');
  await until(() => shown() === keys(), 'the screen shows the whole bar');
  assert.equal(shown(), 'enter send  ctrl+t Task  @name ask a bot or a teammate  / commands');
});

test('m and x on a created channel also work from its threads, and nothing is cut at 80 columns', { timeout: 20000 }, async t => {
  const peer = fakePeer({ items: [] }), id = 'd'.repeat(16); peer.channels = [{ id, name: 'design', members: [ME, SARA] }];
  const { v } = await teamView(t, { peer, columns: 80, rows: 24 });
  const [, threads] = v.panels.teamLists, status = () => v.panels.status.getText(), keys = () => v.panels.keys.getText(), who = 'Who is in #design';
  await openRow(v, /# design/, '#design'); threads.focus();
  await until(() => /^\s*m members {2}x leave {2}tab next$/.test(keys()) && inside(v) === 'In #design · you, @sara · m changes who is in it', 'the open channel');
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
  threads.focus(); await until(() => /^\s*tab next$/.test(keys()), 'no thread to read, and no m or x for #general');
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
  await openRow(v, /@sara-box · sara\s+direct/, '@sara'); await says('/invite @li', 'A direct message is just the two of you. Open a channel to add a teammate.');
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
  await openRow(v, /@sara-box · sara\s+direct/, '@sara'); await send(v, 'are you free?');
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

test('a session on my other computer that waits for y or n shows n once in the key bar, and @name of that computer names it in the new session box', async t => {
  const at = new Date().toISOString(), base = { machine: SARA, createdAt: at, lastAt: at, title: 'Make coupons upper case', steps: [], entries: [] };
  const remote = [{ ...base, id: '11111111-1111-4111-8111-111111111111', state: 'running', approvals: [{ id: 'approval-1', summary: 'Run ls', at }] },
    { ...base, id: '22222222-2222-4222-8222-222222222222', state: 'answered', title: 'Uppercase plan', plan: { title: 'Uppercase coupons', description: 'Make coupon codes upper case.', goal: 'Codes match in any case.', objectives: ['Codes are upper case'], priority: 'low', severity: 'low', state: 'proposed', subtasks: [], met: [] }, approvals: [] }];
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], sharing: [SARA], remote }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, keys = () => v.panels.keys.getText();
  await until(() => board.items.map(plainItem).some(row => /wants to run ls/.test(row)), 'the remote rows');
  // In the new session box, @sara-box first says the session starts there.
  const ask = v.panels.ask; ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box');
  v.input.write('@sara-box fix the flaky test');
  await until(() => /New session on @sara-box/.test(ask._label.getText()), 'the label names the computer');
  ask.clearValue(); ask.cancel();
  board.focus(); selectRow(board, /wants to run ls/);
  await until(() => /y allow {2}n deny {2}enter open {2}d changes {2}letter then enter {2}tab next/.test(keys()), 'approval keys');
  assert.doesNotMatch(keys(), /new session/);
  // A Task waiting in a session started from here waits under Needs you, marked with the computer.
  selectRow(board, /on sara-box · Uppercase plan/);
  await until(() => /y approve {2}n reject {2}enter open {2}d changes {2}e rename {2}letter then enter {2}tab next/.test(keys()), 'Task keys');
  assert.doesNotMatch(keys(), /new session/);
});

test('over a session on my other computer whose Task waits, a plainly typed yes approves the Task there as y does, with or without that computer\'s @name', async t => {
  const at = new Date().toISOString(), plan = { title: 'Uppercase coupons', description: 'Make coupon codes upper case.', goal: 'Codes match in any case.', objectives: ['Codes are upper case'], priority: 'low', severity: 'low', state: 'proposed', subtasks: [], met: [] };
  const waits = (id, title, task = plan.title) => ({ id, machine: SARA, createdAt: at, lastAt: at, title, state: 'answered', steps: [], entries: [], plan: { ...plan, title: task }, approvals: [] });
  const first = '22222222-2222-4222-8222-222222222222', second = '33333333-3333-4333-8333-333333333333';
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], sharing: [SARA], remote: [waits(first, 'Uppercase plan'), waits(second, 'Trim plan', 'Trim coupons')] }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, ask = v.panels.ask, sent = type => peer.sent().filter(row => row.type === type);
  await until(() => board.items.map(plainItem).some(row => /on sara-box · Uppercase plan/.test(row)), 'the rows of the sessions there');
  board.focus(); selectRow(board, /on sara-box · Uppercase plan/);
  await until(() => /Message the session on @sara-box/.test(ask._label.getText()), 'the box says where a message goes');
  // No @name: the yes is his answer to the Task that waits there, not a message the session there has to read.
  await send(v, 'yes go ahead');
  await until(() => sent('remoteTask').length === 1, 'the Task is approved there');
  assert.deepEqual(sent('remoteTask')[0], { type: 'remoteTask', id: first, decision: 'approve' });
  // With the @name: the same approval, not a message that the session there has to read.
  board.focus(); selectRow(board, /on sara-box · Trim plan/); await until(() => /Trim coupons/.test(v.panels.chat.getText()), 'the second session beside the list');
  await send(v, '@sara-box sounds good, do it');
  await until(() => sent('remoteTask').length === 2, 'the second Task is approved there');
  assert.deepEqual(sent('remoteTask')[1], { type: 'remoteTask', id: second, decision: 'approve' });
  assert.deepEqual(sent('remoteSend'), [], 'no message went to either session'); assert.deepEqual(pendingRequests(p.root).filter(row => row.helps), [], 'and no agent started here');
  // Anything that is not a plain yes goes where it went before: to the session there.
  await send(v, 'why does this need a new helper?');
  await until(() => sent('remoteSend').length === 1, 'a question goes to the session there');
  assert.deepEqual([sent('remoteSend')[0].id, sent('remoteSend')[0].text], [second, 'why does this need a new helper?']);
  assert.equal(sent('remoteTask').length, 2); assert.deepEqual(pendingRequests(p.root).filter(row => row.helps), []);
  // A yes after @here is for my agent here: it approves nothing there.
  await send(v, '@here yes');
  await until(() => pendingRequests(p.root).some(row => row.helps), 'the yes goes to my agent here');
  assert.equal(sent('remoteTask').length, 2); assert.equal(sent('remoteSend').length, 1);
});
// Its Task, from Task in its header, says it waits with the keys that answer it, and y or n
// there answers it on that computer as y or n on its row does.
test('over a session on my other computer whose Task waits, its Task names y and n, and y in it approves the Task there', async t => {
  const at = new Date().toISOString(), id = '22222222-2222-4222-8222-222222222222';
  const plan = { title: 'Uppercase coupons', description: 'Make coupon codes upper case.', goal: 'Codes match in any case.', objectives: ['Codes are upper case'], priority: 'low', severity: 'low', state: 'proposed', subtasks: [], met: [] };
  const p = project(later(t)); environment(t, p.parent);
  const answer = command => command.type === 'remoteTask' ? { answered: true } : null;
  const peer = fakePeer({ items: [], sharing: [SARA], remote: [{ id, machine: SARA, createdAt: at, lastAt: at, title: 'Uppercase plan', state: 'answered', steps: [], entries: [], plan, approvals: [] }], answer }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, sent = type => peer.sent().filter(row => row.type === type);
  await until(() => board.items.map(plainItem).some(row => /on sara-box · Uppercase plan/.test(row)), 'its row');
  board.focus(); selectRow(board, /on sara-box · Uppercase plan/);
  await until(() => /Message the session on @sara-box/.test(v.panels.ask._label.getText()), 'the session there beside the list');
  v.input.write('\x14'); await until(() => modal(v, 'Task'), 'its Task');
  const rows = modal(v, 'Task').children.find(child => child.type === 'list').items.map(item => item.getText().trimEnd()).filter(Boolean);
  assert.equal(rows[1], 'Its Task waits for your approval: y approves it, n rejects it.');
  assert.match(modal(v, 'Task').children.filter(child => child.type === 'text').map(child => child.getText()).join(' '), /y approve · n reject · ↑↓ scroll · esc close/);
  v.input.write('y'); await until(() => sent('remoteTask').length === 1 && !modal(v, 'Task'), 'y in its Task approves it there');
  assert.deepEqual(sent('remoteTask')[0], { type: 'remoteTask', id, decision: 'approve' });
  await until(() => /Task approved\. It starts on @sara-box\./.test(v.panels.status.getContent()), 'and says so');
});
// A run on my other computer that waits to start there says what it waits for in its Task, in
// the words its chat says it, never only "starting": it is not at work. Its title row says Task.
test('a run that waits to start on my other computer says what it waits for in its Task, as its chat says it; its title row says Task, at 140 and at 80 columns', async t => {
  const at = new Date().toISOString(), id = '66666666-6666-4666-8666-666666666666';
  const p = project(later(t)); environment(t, p.parent);
  const remote = [{ id, machine: SARA, createdAt: at, lastAt: at, title: 'Check the nightly build', text: 'Check the nightly build', project: 'billing', state: 'starting', queued: true, waits: { on: 'slot', running: 1, limit: 1 }, mode: 'auto', place: 'worktree', steps: [], entries: [], approvals: [] }];
  const peer = fakePeer({ items: [], sharing: [SARA], remote }), v = await view(t, { columns: 140, rows: 50, repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, header = () => v.panels.header.getText().trim().replace(/ {2}· {2}/g, ' · ');
  const titled = async (want, what) => { try { await until(() => typeof want === 'string' ? header() === want : want.test(header()), what); } catch { assert.fail(`${what}: "${header()}"`); } };
  const redraw = (columns, rows) => { v.output.columns = columns; v.output.rows = rows; v.output.emit('resize'); };
  // Ctrl+T: its Task, from what its list told. Nothing is asked of that computer: it has not started there.
  const taskSays = async (wait, words, what) => {
    v.input.write('\x14'); await until(() => modal(v, 'Task'), `${what}: its Task`);
    const rows = modal(v, 'Task').children.find(child => child.type === 'list').items.map(item => item.getText().trim()).filter(Boolean);
    v.input.write('\x1b'); await until(() => !modal(v, 'Task'), `${what}: closed`);
    assert.deepEqual(rows.slice(0, 5), ['Check the nightly build', 'Goal', 'Check the nightly build', 'Checklist', `· ${wait}`], what);
    assert.equal(rows.slice(5).join(' '), words, what);
  };
  await until(() => board.items.map(plainItem).some(row => /Check the nightly build/.test(row)), 'its row');
  board.focus(); selectRow(board, /Check the nightly build/);
  // Its chat says the wait in a sentence, and its Task says it the same way, never "starting".
  await until(() => /Waiting for a free slot: 1 of 1 session is running\. \/slots on @sara-box changes it\./.test(v.panels.chat.getText()), 'its chat says what it waits for');
  await titled('billing · Check the nightly build · Task · Agents · Auto', 'the title at 140 columns');
  await taskSays('Waiting to start', 'Waiting for a free slot: 1 of 1 session is running. /slots on @sara-box changes it.', 'a free slot');
  redraw(80, 24); await until(() => v.current.screen.width === 80, '80 columns');
  // The request is cut to the room left, at a word; Task and the mode stay whole.
  await titled(/^(billing · )?Check the[\w ]* · Task · Agents · Auto$/, 'the title at 80 columns');
  await taskSays('Waiting to start', 'Waiting for a free slot: 1 of 1 session is running. /slots on @sara-box changes it.', 'a free slot at 80 columns');
  // Each other wait in its own words.
  Object.assign(remote[0], { waits: { on: 'teammates', running: 1, limit: 1 } }); redraw(140, 50);
  await titled('billing · Check the nightly build · Task · Agents · Auto', 'a teammate slot');
  await taskSays('Waiting to start', 'Waiting for a free teammate slot: 1 of 1 is in use.', 'a teammate slot');
  Object.assign(remote[0], { waits: { on: 'turn' } }); redraw(140, 50);
  await taskSays('Waiting to start', "Waiting for this session's current turn to end.", 'the current turn of its session');
  Object.assign(remote[0], { waits: { on: 'time', until: new Date(Date.now() + 300000).toISOString(), why: 'The model was busy.' } }); redraw(140, 50);
  await taskSays('Waiting to start', 'The model was busy. It tries again in 5m.', 'a time');
  // One kept here until that computer connects says so, as its row does.
  Object.assign(remote[0], { waits: undefined, queued: undefined, unsent: true }); redraw(140, 50);
  await taskSays('Not sent yet', 'It is kept here until that computer is online.', 'not sent yet');
  assert.deepEqual(peer.sent().filter(row => row.type === 'remoteCheck'), [], 'nothing was asked there');
  // Once it starts there it is at work, and its title row still says Task.
  Object.assign(remote[0], { unsent: undefined, state: 'running' }); redraw(140, 50);
  await titled('billing · Check the nightly build · Task · Agents · Auto', 'at work');
});
// A session on my other computer beside the list is named over it as a session here is: its
// project, its request, Task and its mode, cut to the room as a session here is.
test('a session on my other computer beside the list has its title row: project, request, Task and mode, at 140 and at 80 columns', async t => {
  const at = new Date().toISOString(), id = '55555555-5555-4555-8555-555555555555';
  const p = project(later(t)); environment(t, p.parent);
  const remote = [{ id, machine: SARA, createdAt: at, lastAt: at, title: 'Round the invoice totals to cents before they are saved', project: 'billing', state: 'running', mode: 'auto', place: 'worktree', steps: [], entries: [], approvals: [] }];
  const peer = fakePeer({ items: [], sharing: [SARA], remote }), v = await view(t, { columns: 140, rows: 50, repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, header = () => v.panels.header.getText().trim().replace(/ {2}· {2}/g, ' · ');
  const titled = async (want, what) => { try { await until(() => typeof want === 'string' ? header() === want : want.test(header()), what); } catch { assert.fail(`${what}: "${header()}"`); } };
  await until(() => board.items.map(plainItem).some(row => /Round the invoice totals/.test(row)), 'its row');
  board.focus(); selectRow(board, /Round the invoice totals/);
  await until(() => /Runs on @sara-box/.test(v.panels.chat.getText()), 'its chat beside the list');
  await titled('billing · Round the invoice totals to cents before they are saved · Task · Agents · Auto', 'the title at 140 columns');
  // At 80 columns the request is cut at a word to the room left; Task and the mode stay whole.
  v.output.columns = 80; v.output.rows = 24; v.output.emit('resize');
  await until(() => v.current.screen.width === 80, '80 columns'); await titled(/^Round the invoice[\w ]*… · Task · Agents · Auto$/, 'the title at 80 columns');
  // What that computer says next shows here: it waits for an approval in Full access, in my checkout there.
  // The title still says Task, and the badge says the mode and the place; its Task says what it waits for.
  Object.assign(remote[0], { state: 'running', mode: 'full', place: 'here', approvals: [{ id: 'run-9-a', summary: 'Run: npm test', at }] });
  v.output.columns = 140; v.output.rows = 50; v.output.emit('resize');
  await titled(/^(billing · )?Round the invoice totals to cents before they are saved · Task · Agents · Full Here$/, 'the title as it waits');
});
test("over a session on my other computer that waits for my answer, a typed yes goes to that session and no session is made here; its row keeps the cursor when it goes on, and only @here asks my agent here", async t => {
  const T = Date.now(), at = new Date(T).toISOString(), stamp = minutes => new Date(T - minutes * 60000).toISOString(), id = '44444444-4444-4444-8444-444444444444';
  const waits = (n, minutes, title) => ({ id: `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`, machine: SARA, createdAt: stamp(minutes), lastAt: stamp(minutes), title, state: 'needs_input', question: 'Which one?', choices: ['A', 'B'], steps: [], entries: [{ role: 'You', at: stamp(minutes), text: title }], approvals: [] });
  // Three sessions there wait for me: the one I answer sits between the other two under Needs you.
  const remote = [waits(5, 9, 'An older one that waits'),
    { id, machine: SARA, createdAt: stamp(5), lastAt: stamp(5), title: 'Invoice totals fix', state: 'needs_input', question: 'May the next turn update the tests that are broken and go on?', choices: [], steps: [], entries: [{ role: 'You', at: stamp(5), text: 'Fix the totals, update the tests that are broken' }, { role: 'Opus 5.5', lead: true, at: stamp(5), text: 'I need a yes first.' }], approvals: [] },
    waits(6, 1, 'A newer one that waits')];
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], sharing: [SARA], remote, answer: command => command.type === 'remoteSend' ? { id: command.id } : null }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, ask = v.panels.ask, palette = v.panels.palette, sentThere = () => peer.sent().filter(row => row.type === 'remoteSend');
  const chat = () => v.panels.chat.getText().replace(/\s+/g, ' '), status = () => v.panels.status.getText(), under = () => plainItem(board.items[board.selected]), keys = () => v.panels.keys.getText();
  const offered = () => palette.hidden ? [] : palette.items.map(item => item.getText().split(/\s+/)[0]);
  await until(() => board.items.map(plainItem).some(row => /on sara-box · Invoice totals fix/.test(row)), 'it waits under Needs you');
  board.focus(); selectRow(board, /on sara-box · Invoice totals fix/);
  // The box says who gets the message and on which computer, and the pane how to answer and how to ask my agent here.
  await until(() => / Message Opus 5\.5 on @sara-box /.test(ask._label.getText()), 'the box names its model and its computer');
  await until(() => /go on\? Type your answer below\./.test(chat()), 'how to answer the question');
  assert.match(chat(), /Runs on @sara-box\. Type below to write to it there\. Start with @here to ask your agent here\./);
  assert.doesNotMatch(chat(), /Answer it there/);
  ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box');
  // The empty box sends nothing there: its keys name Enter once there is text.
  await until(() => /^@here asks your agent here {2}ctrl\+t Task {2}esc sessions$/.test(keys().trim()), `the empty box names no Enter, not ${keys().trim()}`);
  // The owner types yes and presses Enter: it goes to the session there, as typed.
  v.input.write('yes');
  await until(() => ask.getValue() === 'yes', 'typed');
  await until(() => /enter send to @sara-box {2}@here asks your agent here {2}ctrl\+t Task {2}esc sessions/.test(keys()), 'the keys say where Enter sends');
  assert.match(ask._label.getText(), / Message Opus 5\.5 on @sara-box /);
  v.input.write('\r');
  await until(() => sentThere().length === 1, 'sent there');
  assert.deepEqual(sentThere()[0], { type: 'remoteSend', id, text: 'yes', typed: true });
  await until(() => /Sent to Opus 5\.5 on @sara-box\./.test(status()) && ask.getValue() === '', 'the line says where it went');
  // No session is made on this computer, and no agent here is linked to that one.
  assert.deepEqual(pendingRequests(p.root), [], 'nothing was queued here');
  assert.equal(helperLink(SARA, id), null);
  assert.ok(!board.items.map(plainItem).some(row => /Help:/.test(row)), 'no Help: session');
  // The session there takes the answer and works: it leaves Needs you, and the cursor stays with
  // it, on its row under its computer, not on another session that waits.
  Object.assign(remote[1], { state: 'running', question: null, lastAt: at, entries: [...remote[1].entries, { role: 'You', at, text: 'yes' }] });
  await until(() => !board.items.map(plainItem).some(row => /on sara-box · Invoice totals fix/.test(row)), 'it no longer waits');
  await until(() => /Invoice totals fix/.test(under()) && !/on sara-box ·/.test(under()), 'the cursor is on its row under its computer');
  await until(() => /You → @sara-box.*yes/.test(chat()) && / Message Opus 5\.5 on @sara-box /.test(ask._label.getText()), 'its pane stays open, with my answer in it');
  // What it answers arrives in the same pane.
  Object.assign(remote[1], { state: 'answered', lastAt: at, entries: [...remote[1].entries, { role: 'Opus 5.5', lead: true, at, text: 'Updated 14 which were broken.' }] });
  await until(() => /Opus 5\.5 on @sara-box.*Updated 14 which were broken\./.test(chat()), 'its answer shows where I wrote');
  assert.match(under(), /Invoice totals fix/);
  // A second plain message continues it there the same way.
  await send(v, 'now go on to the next ones');
  await until(() => sentThere().length === 2, 'sent there again');
  assert.deepEqual(sentThere()[1], { type: 'remoteSend', id, text: 'now go on to the next ones', typed: true });
  // That computer's @name first, by its row's name or its owner's there, still means the session there.
  await send(v, '@sara-box 1'); await until(() => sentThere().length === 3, 'with its name');
  await send(v, '@sara and the tests'); await until(() => sentThere().length === 4, 'with its owner name there');
  assert.deepEqual(sentThere().slice(2).map(row => row.text), ['1', 'and the tests']);
  assert.deepEqual(pendingRequests(p.root), [], 'still nothing here');
  // Typing @ offers the one name that does not go there: my agent here.
  ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box');
  v.input.write('@'); await until(() => offered().join() === '@here', 'only @here is offered');
  v.input.write('\t'); await until(() => ask.getValue() === '@here ', 'Tab fills it in');
  await until(() => / Message your agent here · it helps the session on @sara-box /.test(ask._label.getText()), 'the box says it goes to my agent here');
  await until(() => /enter send to your agent here {2}ctrl\+t Task {2}esc sessions/.test(keys()), 'and the keys');
  // With nothing after it, nothing is sent anywhere.
  v.input.write('\r'); await until(() => /Write your message after @here\./.test(status()), 'it asks for the message');
  assert.deepEqual(pendingRequests(p.root), []); assert.equal(sentThere().length, 4);
  // @here and a message starts my agent here, in this project, as a new session that helps that one.
  await send(v, '@here can you check which files that session is asking about');
  await until(() => pendingRequests(p.root).some(row => row.helps), 'my agent here starts');
  const first = pendingRequests(p.root).find(row => row.helps);
  assert.deepEqual(first.helps, { machine: SARA, remoteId: id, name: 'sara-box', title: 'Invoice totals fix' });
  assert.equal(first.goal, 'can you check which files that session is asking about'); assert.equal(first.continuationTaskId, null);
  assert.equal(helperLink(SARA, id).requestId, first.id);
  await until(() => /Sent to your agent here\./.test(status()), 'the line says so');
  // Before it started, the next message to it goes with the first.
  await send(v, '@here and the logs');
  await until(() => pendingRequests(p.root).find(row => row.id === first.id)?.goal === `${first.goal}\n\nand the logs`, 'with the first message');
  // Once it started, the next one continues it: one helper for that session.
  const repo = repository(p.root);
  saveTask(repo, { id: '1', kind: 'conversation', goal: first.goal, state: 'answered', worktree: repo.root, base: null, branch: null, createdAt: at, runs: [], reviews: [], responses: [], messages: [{ at, text: first.goal }], sessions: {}, result: null, helps: first.helps });
  updateRequest(p.root, first.id, { taskId: '1', state: 'done' });
  board.focus(); selectRow(board, /^(?!.*Help:).*Invoice totals fix/);
  await send(v, '@here what does it still need?');
  await until(() => pendingRequests(p.root).some(row => row.continuationTaskId === '1' && row.goal === 'what does it still need?'), 'the helper is continued');
  assert.equal(pendingRequests(p.root).filter(row => row.helps).length, 1);
  await until(() => /You \(starts next\)/.test(chat()), 'the message to it shows beside the session there');
  // A plain message still goes to the session there, with my agent here at work beside it.
  board.focus(); selectRow(board, /^(?!.*Help:).*Invoice totals fix/);
  await send(v, 'yes');
  await until(() => sentThere().length === 5, 'sent there');
  assert.deepEqual(sentThere()[4], { type: 'remoteSend', id, text: 'yes', typed: true });
  assert.equal(pendingRequests(p.root).filter(row => row.continuationTaskId === '1').length, 1, 'it did not go to my agent here');
});

// The owner opened a session of his devbox and typed /stop. It went to this computer's
// project, which another window had, and he was told the view was read only. A session on
// another computer stops there, whatever this window may change here.
test('/stop over a session on my other computer stops it there, in a window that is read only here', async t => {
  const at = new Date().toISOString(), id = '55555555-5555-4555-8555-555555555555';
  const remote = [{ id, machine: SARA, createdAt: at, lastAt: at, title: 'Prepare the release notes', state: 'running', steps: [{ at, text: 'model: started' }], entries: [{ role: 'You', at, text: 'Prepare the release notes' }], approvals: [] }];
  const p = project(later(t)); environment(t, p.parent);
  // Another window has this project here.
  const other = claimView(repository(p.root)); owned(t).files.push(() => other.release());
  const peer = fakePeer({ items: [], sharing: [SARA], remote }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, ask = v.panels.ask, status = () => v.panels.status.getText().replace(/\s+/g, ' ');
  await until(() => board.items.map(plainItem).some(row => /Prepare the release notes/.test(row)), 'the row of the session there');
  board.focus(); selectRow(board, /Prepare the release notes/);
  await until(() => /Working on @sara-box/.test(v.panels.chat.getText()) && /Message the session on @sara-box/.test(ask._label.getText()), 'the session there beside the list');
  await send(v, '/stop');
  await until(() => /Stopping it on @sara-box|That window is/.test(status()), 'what /stop says');
  assert.doesNotMatch(status(), /view.only|read.only/i);
  assert.match(status(), /Stopping it on @sara-box\. Changes and chat history are kept there\./);
  assert.deepEqual(peer.sent().filter(row => row.type === 'remoteStop'), [{ type: 'remoteStop', id }], 'the stop went there, once');
});

// The owner, on his laptop, in a session that lives on his devbox ("Message Opus 5.5 on
// @devbox"), typed /rename and was told "Open a session to rename it. In Sessions, e
// renames the selected one." Over a session on my other computer, /rename, /archive,
// /archived, and e, c and u on its row work as they do on a session here; the work is done
// there (the daemon's remoteRename and remoteArchive), and its row here shows it at once.
const P1 = '1'.repeat(16), SHOP_REPO = 'e'.repeat(64), THERE_ID = '11111111-1111-4111-8111-111111111111';
function editableThere({ edit = true, state = 'answered', title = 'Make coupons upper case' } = {}) {
  const listed = { id: THERE_ID, ref: `${P1}:1`, project: P1, title, state, at: ago(2), createdAt: ago(3), approvals: [], by: 'you', who: null };
  const machines = [{ key: SARA, listedAt: ago(0), older: false, ...(edit === null ? {} : { edit }), projects: [{ id: P1, name: 'shop', repoId: SHOP_REPO, home: false }], sessions: [listed] }];
  // What the daemon does once that computer did it: its list here shows the change at once.
  const change = patch => { machines[0].sessions = machines[0].sessions.map(row => Object.fromEntries(Object.entries({ ...row, ...patch }).filter(([, value]) => value !== undefined))); };
  const answer = command => {
    if (command.type === 'remoteRename') { const name = command.title.trim(); change({ title: name || title, named: name ? true : undefined }); return { title: name || null, titleBy: name ? 'owner' : null, shown: name || title }; }
    if (command.type === 'remoteArchive') { change({ archived: command.archived ? true : undefined }); return { archived: command.archived, shown: machines[0].sessions[0].title }; }
    return null;
  };
  return { listed, machines, answer };
}
test('/rename and /archive over a session on my other computer rename and archive it there, never "Open a session"; /rename alone opens the same field', async t => {
  const { listed, machines, answer } = editableThere(), p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], sharing: [SARA], machines, repoId: SHOP_REPO, answer }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, ask = v.panels.ask, status = () => v.panels.status.getText().replace(/\s+/g, ' '), rows = () => board.items.map(plainItem).map(row => row.trim());
  const sent = type => peer.sent().filter(row => row.type === type).map(({ type: _type, ...rest }) => rest), field = () => modal(v, 'Rename session')?.children.find(child => child.type === 'textbox');
  const over = async pattern => { board.focus(); selectRow(board, pattern); await until(() => /Message the session on @sara-box/.test(ask._label.getText()), 'the session there beside the list'); };
  await until(() => rows().some(row => /Make coupons upper case/.test(row)), 'the row of the session there');
  // In that session, as the owner was: /rename NAME goes there.
  await over(/Make coupons upper case/); await send(v, '/rename Coupon casing');
  await until(() => /Renamed to Coupon casing\./.test(status()), 'renamed there');
  assert.doesNotMatch(status(), /Open a session/);
  assert.deepEqual(sent('remoteRename'), [{ id: THERE_ID, to: SARA, ref: listed.ref, title: 'Coupon casing' }]);
  await until(() => rows().some(row => /Coupon casing/.test(row)), 'its row shows the new name at once');
  // /rename alone opens the field it opens here, with the name it was given, checked as here.
  await over(/Coupon casing/); await send(v, '/rename');
  await until(() => field()?.__listener, 'the rename field');
  assert.equal(field().getValue(), 'Coupon casing');
  assert.match(modal(v, 'Rename session').children.find(child => child.options?.scrollable).getText().replace(/\s+/g, ' '), /One line of up to 60 characters\. It shows in the list and the title\. Leave it empty to go back to the name ELU gave it\./);
  await closeDialog(v, 'Rename session', 'Coupons shout');
  await until(() => /Renamed to Coupons shout\./.test(status()), 'renamed from the field');
  assert.equal(sent('remoteRename').at(-1).title, 'Coupons shout');
  // A name that is too long is refused before it goes, in the line it has here; what was typed stays.
  await over(/Coupons shout/); await send(v, `/rename ${'x'.repeat(61)}`);
  await until(() => /A session name is one line of up to 60 characters\. This one is 61\./.test(status()), 'refused here');
  assert.equal(sent('remoteRename').length, 2); assert.equal(ask.getValue(), `/rename ${'x'.repeat(61)}`); ask.setValue('');
  // An empty name in the field gives it back the name ELU gave it.
  await over(/Coupons shout/); await send(v, '/rename'); await until(() => field()?.__listener, 'the field again');
  await closeDialog(v, 'Rename session', '');
  await until(() => /The session is named after your first message again\./.test(status()), 'the name is taken away');
  // /archive archives it there: it leaves the list. Archived sessions are each computer's own:
  // this one neither counts nor lists it, and /archived on that computer does.
  await over(/Make coupons upper case/); await send(v, '/archive');
  await until(() => /Archived "Make coupons upper case" on @sara-box\. \/archived there lists it\./.test(status()), 'archived there');
  assert.deepEqual(sent('remoteArchive'), [{ id: THERE_ID, to: SARA, ref: listed.ref, archived: true }]);
  await until(() => !rows().some(row => /Make coupons upper case/.test(row)), 'gone from the list');
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.ok(!rows().some(row => /archived · \/archived$/.test(row)), `not counted here:\n${rows().join('\n')}`);
  await send(v, '/archived'); await new Promise(resolve => setTimeout(resolve, 700));
  assert.ok(!rows().some(row => /ARCHIVED|Make coupons upper case/.test(row)), `not listed here:\n${rows().join('\n')}`);
  await send(v, '/archived');
  // Brought back there, it is in the list here again.
  answer({ type: 'remoteArchive', archived: false });
  await until(() => rows().some(row => /Make coupons upper case/.test(row)), 'back in the list');
  // e and c on its row do the same.
  board.focus(); selectRow(board, /Make coupons upper case/); await until(() => /e rename/.test(v.panels.keys.getText()), 'e on its row');
  v.input.write('e'); await until(() => field()?.__listener, 'the field from e');
  await closeDialog(v, 'Rename session', 'Coupons by e');
  await until(() => /Renamed to Coupons by e\./.test(status()) && rows().some(row => /Coupons by e/.test(row)), 'renamed by e');
  board.focus(); selectRow(board, /Coupons by e/); v.input.write('c');
  await until(() => /Archived "Coupons by e" on @sara-box\./.test(status()), 'archived by c');
  assert.equal(sent('remoteArchive').length, 2);
});

test('over a session on my other computer: one on an ELU before 0.1.26 is named with the version it needs, one at work is not archived, and nothing goes', async t => {
  // Its list says its ELU cannot: the line comes at once, before any field opens.
  for (const edit of [false, null]) {
    const { machines, answer } = editableThere({ edit }), p = project(later(t)); environment(t, p.parent);
    const refuse = command => ['remoteRename', 'remoteArchive'].includes(command.type) ? `@sara-box needs ELU 0.1.26 to ${command.type === 'remoteRename' ? 'rename' : 'archive'} its sessions.` : null;
    const peer = fakePeer({ items: [], sharing: [SARA], machines, repoId: SHOP_REPO, answer, refuse }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
    const board = v.panels.board, status = () => v.panels.status.getText().replace(/\s+/g, ' ');
    await until(() => board.items.map(plainItem).some(row => /Make coupons upper case/.test(row)), 'the row there');
    board.focus(); selectRow(board, /Make coupons upper case/); await until(() => /@sara-box/.test(v.panels.ask._label.getText()), 'over it');
    if (edit === false) {
      await send(v, '/rename');
      await until(() => /@sara-box needs ELU 0\.1\.26 to rename its sessions\./.test(status()), 'the version it needs');
      assert.equal(modal(v, 'Rename session'), undefined, 'no field opened');
      assert.deepEqual(peer.sent().filter(row => row.type === 'remoteRename'), [], 'nothing went');
    }
    // A computer whose list says nothing of it is asked, and the daemon's line is said as it is.
    await send(v, '/rename Coupons'); await until(() => /@sara-box needs ELU 0\.1\.26 to rename its sessions\./.test(status()), 'the version it needs, from the daemon');
    await send(v, '/archive'); await until(() => /@sara-box needs ELU 0\.1\.26 to archive its sessions\./.test(status()), 'and to archive');
    assert.doesNotMatch(status(), /Open a session/);
  }
  // At work there: archived it is refused as here, with nothing sent; renamed it goes.
  const { machines, answer } = editableThere({ state: 'running' }), p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], sharing: [SARA], machines, repoId: SHOP_REPO, answer }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, status = () => v.panels.status.getText().replace(/\s+/g, ' ');
  await until(() => board.items.map(plainItem).some(row => /Make coupons upper case/.test(row)), 'the row there');
  board.focus(); selectRow(board, /Make coupons upper case/); await until(() => /@sara-box/.test(v.panels.ask._label.getText()), 'over it');
  await send(v, '/archive'); await until(() => /"Make coupons upper case" is running\. Stop it first with \/stop\./.test(status()), 'refused as here');
  assert.deepEqual(peer.sent().filter(row => row.type === 'remoteArchive'), []);
  await send(v, '/rename Nightly'); await until(() => /Renamed to Nightly\./.test(status()), 'renamed while it works');
});

// Nothing goes to Done by itself (lib/owner-check.mjs): a session on my other computer that ended
// waits there for my check. Over it, its title says so, and /done shows its goal and objectives
// from there; each answer is done there (the daemon's remoteCheck). One on an ELU before 0.1.26
// is named with the version it needs, and nothing goes.
// Over a session on my other computer the title says Task, never its state, as here: Ctrl+T or
// a click on it opens its Task as that computer has it, with the checklist of its work from that
// computer's own records (the daemon's remoteCheck with look). Check goes on to my check there.
// One on an ELU before 0.1.26 shows what its list told, says why, and nothing is sent to it.
test('over a session on my other computer the title says Task: Ctrl+T or a click opens its Task and checklist from there, Check goes on to the check, and an older one shows what its list told', async t => {
  const { listed, machines, answer } = editableThere({ state: 'unverified' }), p = project(later(t)); environment(t, p.parent);
  machines[0].check = true; machines[0].sessions[0].check = true; machines[0].sessions[0].finished = true;
  const CHECKLIST = [{ text: 'Edits committed', met: true, evidence: 'Committed on feat/task-1 at abc1234.' }, { text: 'Checks passed', met: false, evidence: 'Not set for this project: no test or build command checks the edits.' }, { text: 'Pull request', met: false, evidence: '/publish opens a draft pull request.' }];
  const LOOK = { title: 'Make coupons upper case', waits: true, goal: 'Codes compare equal whatever their case.', objectives: [{ text: 'normalize returns upper case', met: true, evidence: 'npm test: 1 passed' }], checklist: CHECKLIST };
  const VIEW = { title: 'Make coupons upper case', ended: 'committed', goal: LOOK.goal, objectives: LOOK.objectives, checklist: CHECKLIST };
  // The daemon answers a look or a check after a round trip to that computer, not at once.
  const trip = value => new Promise(resolve => setTimeout(() => resolve(value), 30));
  const looked = command => command.type !== 'remoteCheck' ? answer(command) : command.answer ? { answer: command.answer, shown: listed.title } : trip(command.look ? LOOK : VIEW);
  const peer = fakePeer({ items: [], sharing: [SARA], machines, repoId: SHOP_REPO, answer: looked }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, header = () => v.panels.header.getText().trim(), keys = () => v.panels.keys.getText().trim();
  const sent = type => peer.sent().filter(row => row.type === type).map(({ type: _type, ...rest }) => rest);
  const dialogList = title => modal(v, title)?.children.find(child => child.type === 'list'), dialogRows = title => (dialogList(title)?.items.map(item => item.getText().trimEnd()) ?? []).filter(Boolean);
  const over = async () => { board.focus(); selectRow(board, /Make coupons upper case/); await until(() => /Message the session on @sara-box/.test(v.panels.ask._label.getText()), 'the session there beside the list'); };
  await until(() => board.items.map(plainItem).some(row => /Make coupons upper case/.test(row)), 'the row there');
  await over(); await until(() => /Make coupons upper case {2}· {2}Task\b/.test(header()), 'its title names its Task');
  assert.doesNotMatch(header(), /check it|committed|unverified|not verified/);
  // The empty box names no Enter: there is nothing to send yet.
  v.panels.ask.focus(); await until(() => keys() === '@here asks your agent here  ctrl+t Task  esc sessions', 'the bar names Ctrl+T').catch(error => { throw new Error(`${error.message}: ${keys()}`); });
  // Ctrl+T: its Task as that computer has it.
  v.input.write('\x14'); await until(() => modal(v, 'Task'), 'its Task');
  assert.deepEqual(dialogRows('Task'), ['Make coupons upper case', 'It waits for your check.', 'Goal', LOOK.goal, 'Objectives · 1 of 1 met', '  ✓ normalize returns upper case', '    npm test: 1 passed', 'Checklist', '  ✓ Edits committed', '    Committed on feat/task-1 at abc1234.', '  · Checks passed', '    Not set for this project: no test or build command checks the edits.', '  · Pull request', '    /publish opens a draft pull request.']);
  assert.deepEqual(sent('remoteCheck'), [{ id: THERE_ID, to: SARA, ref: listed.ref, look: true }], 'only its Task was asked');
  // Check: my check there, with the same checklist.
  v.input.write('\r'); await until(() => modal(v, 'Check'), 'the check');
  for (const line of ['Checklist', '  ✓ Edits committed', '  · Pull request']) assert.ok(dialogRows('Check').includes(line), line);
  v.input.write('\x1b'); await until(() => !modal(v, 'Check'), 'Esc changes nothing');
  // Ctrl+T was pressed while typing: Esc goes back to the message box, not to the list.
  await until(() => v.current.screen.focused === v.panels.ask && v.panels.ask._reading, 'Esc goes back to the message box');
  assert.deepEqual(sent('remoteCheck').at(-1), { id: THERE_ID, to: SARA, ref: listed.ref });
  // A click on Task opens it too.
  await over(); const at = header().lastIndexOf('Task'); v.input.write(`\x1b[<0;${v.panels.header.aleft + at + 1};${v.panels.header.atop + 1}M\x1b[<0;${v.panels.header.aleft + at + 1};${v.panels.header.atop + 1}m`);
  await until(() => modal(v, 'Task'), 'a click opens it'); v.input.write('\x1b'); await until(() => !modal(v, 'Task'), 'closed');
  // On an ELU before 0.1.26: what its list told, why, no Check, and nothing sent.
  machines[0].check = false; const before = sent('remoteCheck').length;
  await over(); v.input.write('\x14'); await until(() => modal(v, 'Task'), 'its Task from what its list told');
  assert.deepEqual(dialogRows('Task'), ['Make coupons upper case', 'It waits for your check.', '@sara-box needs ELU 0.1.26 to check its sessions.', 'Goal', 'Make coupons upper case', 'Checklist', '  ✓ Edits committed', '    Its work is committed.']);
  assert.equal(modal(v, 'Task').children.find(child => child.type === 'button'), undefined);
  assert.equal(sent('remoteCheck').length, before, 'nothing asked');
  v.input.write('\x1b'); await until(() => !modal(v, 'Task'), 'closed');
});
// A shared project with no origin remote: its sessions are seen by everyone on its team, so
// the line under its Kanban never says teammates do not see them.
test('the Kanban of a shared project with no origin remote does not say teammates do not see its sessions', async t => {
  const { machines } = editableThere(), p = project(later(t)); environment(t, p.parent);
  machines[0].theirs = true; machines[0].projects[0].teams = ['team-1']; machines[0].projects[0].repoId = null; machines[0].sessions[0].repoId = null;
  const repo = repository(p.root), at = ago(1);
  saveTask(repo, { id: '1', kind: 'conversation', goal: 'Write the release notes', state: 'answered', worktree: repo.root, base: null, branch: null, createdAt: at, runs: [], reviews: [], responses: [], messages: [{ at, text: 'Write the release notes' }], sessions: {}, result: null });
  const peer = fakePeer({ items: [], machines });
  peer.teamProjectRoots = () => [{ team: 'team-1', root: repo.root, name: 'shop' }]; peer.boardKeptOff = () => false;
  const v = await view(t, { repo, peer }), panels = v.panels, cards = () => panels.kanbanLists.flatMap(list => list.items.map(item => plainItem(item).trimEnd()));
  await send(v, '/kanban'); await until(() => v.current.view === 'kanban' && cards().some(card => /^Make coupons.*@sara · sara-box/.test(card)) && cards().some(card => /Write the release notes/.test(card)), 'its cards and sara\'s').catch(error => { throw new Error(`${error.message}: ${JSON.stringify(cards())} ${v.current.view} ${panels.kanbanTeam.getText()}`); });
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.ok(panels.kanbanTeam.hidden || !/teammates do not see/.test(panels.kanbanTeam.getText()), panels.kanbanTeam.getText());
});
test('/done over a session on my other computer that waits for my check shows its goal and objectives from there, and its answers go there', async t => {
  const { listed, machines, answer } = editableThere(), p = project(later(t)); environment(t, p.parent);
  machines[0].check = true; machines[0].sessions[0].check = true;
  const VIEW = { title: 'Make coupons upper case', ended: 'published', goal: 'Codes compare equal whatever their case.', objectives: [{ text: 'normalize returns upper case', met: true, evidence: 'npm test: 1 passed' }, { text: 'Docs say so', met: false, evidence: null }] };
  const checked = command => {
    if (command.type !== 'remoteCheck') return answer(command);
    if (!command.answer) return VIEW;
    if (command.answer === 'done') machines[0].sessions[0] = { ...machines[0].sessions[0], check: undefined };
    return { answer: command.answer, shown: listed.title, ...(command.answer === 'copy' ? { branch: 'feat/task-1-next' } : {}) };
  };
  const peer = fakePeer({ items: [], sharing: [SARA], machines, repoId: SHOP_REPO, answer: checked }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, status = () => v.panels.status.getText().replace(/\s+/g, ' ');
  const sent = type => peer.sent().filter(row => row.type === type).map(({ type: _type, ...rest }) => rest);
  // The check's rows: its text, then its answers, the last list, which takes the keys.
  const lists = title => modal(v, title)?.children.filter(child => child.type === 'list') ?? [], dialogList = title => lists(title).at(-1), dialogRows = title => lists(title).flatMap(list => list.items.map(item => item.getText()));
  const over = async () => { board.focus(); selectRow(board, /Make coupons upper case/); await until(() => /Message the session on @sara-box/.test(v.panels.ask._label.getText()), 'the session there beside the list'); };
  await until(() => board.items.map(plainItem).some(row => /Make coupons upper case/.test(row)), 'the row there');
  await over(); await until(() => /Make coupons upper case {2}· {2}Task\b/.test(v.panels.header.getText()), 'its title names its Task');
  // /done: the check, as that computer has it. Esc changes nothing there.
  await send(v, '/done'); await until(() => modal(v, 'Check'), 'the check');
  const rows = dialogRows('Check').map(row => row.trimEnd());
  for (const line of ['Make coupons upper case', 'published', 'Goal', VIEW.goal, 'Objectives · 1 of 2 met', '  ✓ normalize returns upper case', '    npm test: 1 passed', '  · Docs say so']) assert.ok(rows.includes(line), line);
  assert.deepEqual(rows.slice(-3), ['› Done', '› Keep open, new goal', '› Done, and a copy with a new goal']);
  v.input.write('\x1b'); await until(() => !modal(v, 'Check'), 'Esc closes it');
  assert.deepEqual(sent('remoteCheck'), [{ id: THERE_ID, to: SARA, ref: listed.ref }], 'only what it shows was asked');
  // Keep open, new goal: typed here, done there.
  await over(); await send(v, '/done'); await until(() => modal(v, 'Check'), 'the check again');
  dialogList('Check').select(dialogList('Check').items.findIndex(item => item.getText().trimEnd() === '› Keep open, new goal')); v.input.write('\r');
  const title = 'New goal (objectives below it, one per line)';
  await until(() => modal(v, title)?.children.find(child => child.type === 'textarea')?.__listener, 'the new goal editor');
  modal(v, title).children.find(child => child.type === 'textarea').setValue('Trim spaces too\nnormalize trims the code'); v.input.write('\x13');
  await until(() => /"Make coupons upper case" carries on with the new goal\./.test(status()), 'carried on there');
  assert.deepEqual(sent('remoteCheck').at(-1), { id: THERE_ID, to: SARA, ref: listed.ref, answer: 'goal', text: 'Trim spaces too\nnormalize trims the code' });
  // Done: done there.
  await over(); await send(v, '/done'); await until(() => modal(v, 'Check'), 'the check once more');
  v.input.write('\r'); await until(() => /Moved "Make coupons upper case" to Done\./.test(status()), 'moved to Done there');
  assert.deepEqual(sent('remoteCheck').at(-1), { id: THERE_ID, to: SARA, ref: listed.ref, answer: 'done', text: '' });
  // On an ELU before 0.1.26: named, and nothing goes.
  machines[0].check = false; machines[0].sessions[0] = { ...machines[0].sessions[0], check: true };
  const before = sent('remoteCheck').length;
  await over(); await send(v, '/done'); await until(() => /@sara-box needs ELU 0\.1\.26 to check its sessions\./.test(status()), 'the version it needs');
  assert.equal(modal(v, 'Check'), undefined); assert.equal(sent('remoteCheck').length, before);
});

// A new goal of any length goes with /done to a session on my other computer: the daemon is
// waited for as long as for a message that long, not the 10 s of a short command. One refused
// there keeps what he typed: the editor opens again with it and says why.
test('/done over a session on my other computer: a long new goal is waited for as long as a message that long, and a refused one keeps what he typed', async t => {
  const { listed, machines, answer } = editableThere(), p = project(later(t)); environment(t, p.parent);
  machines[0].check = true; machines[0].sessions[0].check = true;
  const VIEW = { title: 'Make coupons upper case', ended: 'published', goal: 'Codes compare equal whatever their case.', objectives: [{ text: 'normalize returns upper case', met: true, evidence: 'npm test: 1 passed' }] };
  const REFUSED = '@sara-box could not take the new goal: try again.';
  let refusals = 1;
  const checked = command => command.type !== 'remoteCheck' ? answer(command) : command.answer ? { answer: command.answer, shown: listed.title } : VIEW;
  const refuse = command => command.type === 'remoteCheck' && command.answer && refusals > 0 ? (refusals -= 1, REFUSED) : null;
  const peer = fakePeer({ items: [], sharing: [SARA], machines, repoId: SHOP_REPO, answer: checked, refuse }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, status = () => v.panels.status.getText().replace(/\s+/g, ' ');
  // The check's answers are its last list: the text above them is a list of its own.
  const choose = label => { const list = modal(v, 'Check').children.filter(child => child.type === 'list').at(-1), at = list.items.findIndex(item => item.getText().trimEnd() === label); assert.ok(at >= 0, label); list.select(at); };
  const title = 'New goal (objectives below it, one per line)', field = () => modal(v, title)?.children.find(child => child.type === 'textarea');
  const why = () => modal(v, title)?.children.find(child => child.type === 'text' && /Ctrl-S saves/.test(child.getText()))?.getText().replace(/\s+/g, ' ') ?? '';
  await until(() => board.items.map(plainItem).some(row => /Make coupons upper case/.test(row)), 'the row there');
  board.focus(); selectRow(board, /Make coupons upper case/); await until(() => /Message the session on @sara-box/.test(v.panels.ask._label.getText()), 'the session there beside the list');
  await send(v, '/done'); await until(() => modal(v, 'Check'), 'the check');
  choose('› Keep open, new goal'); v.input.write('\r');
  await until(() => field()?.__listener, 'the new goal editor');
  const goal = `Codes compare equal ${'whatever their case and wherever they are typed '.repeat(2500)}THE END`, text = `${goal}\n${Array.from({ length: 12 }, (_, n) => `Objective ${n + 1}`).join('\n')}`;
  assert.ok(Buffer.byteLength(text) > 120000);
  field().setValue(text); v.input.write('\x13');
  // Refused there: the editor again, with every character he typed and why.
  await until(() => field()?.__listener && why().includes(REFUSED), 'the editor again, saying why').catch(error => { throw new Error(`${error.message}: ${why()} | ${status()}`); });
  assert.ok(field().getValue() === text, 'what he typed, every character');
  // Saved again, it goes, and the daemon is waited for as long as for a message that long.
  v.input.write('\x13');
  await until(() => /"Make coupons upper case" carries on with the new goal\./.test(status()), 'carried on there').catch(error => { throw new Error(`${error.message}: ${status()}`); });
  const asked = peer.calls.flatMap((row, index) => row[0] === 'sendPeerCommand' && row[1].type === 'remoteCheck' && row[1].answer ? [index] : []);
  assert.equal(asked.length, 2, 'sent twice: refused, then taken');
  for (const index of asked) {
    assert.ok(peer.calls[index][1].text === text, 'the whole goal');
    const waited = peer.calls.slice(index).find(row => row[0] === 'awaitCommand');
    assert.equal(waited[2], 10000 + Math.ceil(Buffer.byteLength(text) / 300));
  }
});

// The owner: "archived should only show the ones on my machine, not the other machines". Each
// computer lists, counts and cleans up its own archived sessions. Here /archived lists this
// computer's only, the line under the list counts only those, and x on the Archived heading and
// /archived clean ask about and delete only those; Learn first still saves what was taught to
// the project's memory. Another computer of mine is sent nothing and its archived sessions are not
// listed here: /archived on that computer lists them. Its sessions that are not archived still
// show under its heading.
test("/archived lists, counts and cleans up only this computer's archived sessions, never those of my other computers", async t => {
  const { listed, machines, answer } = editableThere(), p = project(later(t)); environment(t, p.parent);
  const fake = fakeClis(p.parent, { mode: 'answer', learned: { add: ['Use pnpm, not npm.'], remove: [] } }), previous = Object.fromEntries(['PATH', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(previous)) process.env[key] = fake.env[key];
  owned(t).files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  // Here: one archived session, with a file not committed in its folder.
  const repo = repository(p.root); registerProject(repo);
  liveTask(p.root, { id: '4', goal: 'Tidy the logs', state: 'stopped' }); closeSession(repo, '4');
  // sara-box, mine: one archived there and one open. li, mine too: one archived there.
  machines[0].clean = true;
  machines[0].sessions = [{ ...listed, archived: true }, { ...listed, id: '33333333-3333-4333-8333-333333333333', ref: `${P1}:3`, title: 'Sort imports' }];
  machines.push({ key: LI, listedAt: ago(0), older: false, edit: true, clean: true, projects: machines[0].projects, sessions: [{ ...listed, id: '44444444-4444-4444-8444-444444444444', ref: `${P1}:4`, title: 'Round the refunds', archived: true }] });
  const peer = fakePeer({ items: [], sharing: [SARA, LI], machines, repoId: SHOP_REPO, answer }), v = await view(t, { repo, dashboard: true, peer });
  const board = v.panels.board, rows = () => board.items.map(plainItem).map(row => row.trim());
  const notes = title => modal(v, title)?.children.filter(child => child.type === 'text').map(child => child.getText().replace(/\s+/g, ' ')).join(' ') ?? '';
  const settle = () => new Promise(resolve => setTimeout(resolve, 700));
  // sara-box's open session shows under its heading; the line under the list counts this computer's one.
  await until(() => rows().some(row => /^ON SARA-BOX/.test(row)) && rows().some(row => /Sort imports/.test(row)), "sara-box's open session under its heading");
  await settle();
  assert.deepEqual(rows().filter(row => /archived · \/archived$/.test(row)), ['1 archived · /archived'], rows().join('\n'));
  // /archived lists this computer's only: no Archived group for another computer.
  await send(v, '/archived'); await until(() => rows().some(row => /^ARCHIVED 1\b/.test(row)) && rows().some(row => /Tidy the logs/.test(row)), "this computer's archived session");
  await settle();
  assert.deepEqual(rows().filter(row => /ARCHIVED/.test(row)).map(row => row.replace(/[\s─]+/g, ' ').trim()), ['ARCHIVED 1'], rows().join('\n'));
  assert.ok(!rows().some(row => /Make coupons upper case|Round the refunds/.test(row)), `another computer's archived sessions are not listed:\n${rows().join('\n')}`);
  assert.ok(rows().some(row => /Sort imports/.test(row)), "sara-box's open session stays");
  // x on the Archived heading asks about this computer's one only; Esc cancels.
  board.focus(); selectRow(board, /ARCHIVED 1\b/); await until(() => /x clean up all/.test(v.panels.keys.getText()), 'x clean up all on the heading');
  v.input.write('x'); await until(() => modal(v, 'Clean up'), 'the question for all');
  assert.match(notes('Clean up'), /Deletes "Tidy the logs" for good\. Learn first saves what you taught in it to the project's memory\./);
  assert.doesNotMatch(notes('Clean up'), /sara-box|@li|here/);
  v.input.write('\x1b'); await until(() => !modal(v, 'Clean up'), 'cancelled');
  // /archived clean: the same one only. Learn, then delete saves to this project's context.
  await send(v, '/archived clean'); await until(() => modal(v, 'Clean up'), 'the question from /archived clean');
  assert.match(notes('Clean up'), /Deletes "Tidy the logs" for good\./);
  assert.doesNotMatch(notes('Clean up'), /sara-box|@li|here/);
  v.input.write('\r'); await until(() => modal(v, 'Work not pushed'), 'its work on no remote');
  assert.match(notes('Work not pushed'), /It has 1 file not committed\./);
  v.input.write('\r');
  await until(() => modal(v, 'Saved to memory'), 'what its lessons run saved', 20000);
  assert.deepEqual(modal(v, 'Saved to memory').children.find(child => child.type === 'list').items.map(item => item.getText().trim()), ['Use pnpm, not npm.']);
  assert.match(notes('Saved to memory'), /Deleted "Tidy the logs"\. Kept its work on feat\/task-4\./);
  assert.doesNotMatch(notes('Saved to memory'), /sara-box|@li|needs ELU/);
  assert.match(readProjectSettings(p.root).context, /Use pnpm, not npm\./);
  assert.ok(!tasks(repo).some(task => task.id === '4'), 'the one here is deleted');
  assert.deepEqual(peer.sent().filter(row => row.type === 'remoteClean'), [], 'nothing went to my other computers');
  v.input.write('\r'); await until(() => !modal(v, 'Saved to memory') && !rows().some(row => /ARCHIVED|Tidy the logs/.test(row)), 'nothing archived is left here');
  await settle();
  assert.ok(rows().some(row => /Sort imports/.test(row)), "sara-box's open session stays");
  assert.ok(!rows().some(row => /archived · \/archived$/.test(row)), `nothing archived here to count:\n${rows().join('\n')}`);
});

// x on an archived row of this computer offers clean up; a session of my other computer has no
// archived row here, so x over one of its rows cleans up nothing there and sends nothing.
test('x over a session of my other computer sends no clean-up there', async t => {
  const { machines, answer } = editableThere(), p = project(later(t)); environment(t, p.parent);
  machines[0].clean = true;
  const peer = fakePeer({ items: [], sharing: [SARA], machines, repoId: SHOP_REPO, answer }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board;
  await until(() => board.items.map(plainItem).some(row => /Make coupons upper case/.test(row)), 'its row');
  board.focus(); selectRow(board, /Make coupons upper case/); await until(() => /@sara-box/.test(v.panels.ask._label.getText()), 'over it');
  assert.doesNotMatch(v.panels.keys.getText(), /x clean up/);
  v.input.write('x'); await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(modal(v, 'Clean up'), undefined, 'no question');
  assert.deepEqual(peer.sent().filter(row => row.type === 'remoteClean'), [], 'nothing went');
});

// A dialog as drawn: its border is whole, with its title, and nothing of the screen behind it
// touches its sides. On its rows the column beside each side is blank, and so is the screen's
// edge where only that column is left (at 80 columns the message box's border met its right
// side as "│─┘"). Returns its rows, inside the border.
function framed(v, title) {
  v.current.screen.render();
  const lines = v.lines(), dialog = modal(v, title), top = dialog.atop, left = dialog.aleft, right = left + dialog.width - 1, bottom = top + dialog.height - 1, width = v.current.screen.width;
  const problems = [], beside = [left - 1, right + 1, ...(left - 2 === 0 ? [0] : []), ...(right + 2 === width - 1 ? [width - 1] : [])].filter(x => x >= 0 && x < width);
  if (!new RegExp(`^┌─ ${title} ─+┐$`).test(lines[top].slice(left, right + 1))) problems.push(`its top: ${lines[top].slice(left, right + 1)}`);
  if (!/^└─+┘$/.test(lines[bottom].slice(left, right + 1))) problems.push(`its bottom: ${lines[bottom].slice(left, right + 1)}`);
  for (let y = top; y <= bottom; y++) {
    if (y > top && y < bottom && (lines[y][left] !== '│' || lines[y][right] !== '│')) problems.push(`its sides on row ${y}`);
    for (const x of beside) if (lines[y][x] !== ' ') problems.push(`"${lines[y][x]}" beside it at ${x},${y}`);
  }
  assert.deepEqual(problems, [], `${title}:\n${lines.join('\n')}`);
  return lines.slice(top + 1, bottom).map(row => row.slice(left + 1, right).trimEnd());
}

// Every step of /archived clean, at 80x24 and 140x50, beside a computer of mine that lists
// archived sessions of its own: no dialog is drawn over, none draws over its own border, and
// none names that computer. With many lessons saved, the rows scroll and the short result under
// them shows whole, between the OK button and the hint.
for (const [cols, high] of [[80, 24], [140, 50]]) test(`at ${cols}x${high} every dialog of /archived clean keeps its border whole, nothing behind it touches its sides, and it names no other computer`, async t => {
  const { listed, machines, answer } = editableThere(), p = project(later(t)); environment(t, p.parent);
  const lessons = Array.from({ length: 40 }, (_, at) => `Lesson ${at + 1} for the shop.`);
  const fake = fakeClis(p.parent, { mode: 'answer', learned: { add: lessons, remove: [] } }), previous = Object.fromEntries(['PATH', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(previous)) process.env[key] = fake.env[key];
  owned(t).files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  // Here: one archived session, with a file not committed. sara-box: one archived there.
  const repo = repository(p.root); registerProject(repo);
  liveTask(p.root, { id: '4', goal: 'Tidy the logs', state: 'stopped' }); closeSession(repo, '4');
  machines[0].sessions[0].archived = true; machines[0].clean = true;
  const peer = fakePeer({ items: [], sharing: [SARA], machines, repoId: SHOP_REPO, answer }), v = await view(t, { repo, dashboard: true, peer, columns: cols, rows: high });
  const board = v.panels.board, rows = () => board.items.map(plainItem).map(row => row.trim());
  // sara-box lists none of its archived sessions here: archived sessions are each computer's own.
  await send(v, '/archived'); await until(() => rows().some(row => /^ARCHIVED 1\b/.test(row)), 'the archived group here');
  assert.ok(!rows().some(row => /^ON SARA-BOX/.test(row)), 'no heading for sara-box with nothing of it to show');
  await send(v, '/archived clean'); await until(() => modal(v, 'Clean up'), 'the question');
  assert.match(framed(v, 'Clean up').join(' '), /Learn, then delete.*Deletes "Tidy the logs" for good\./);
  v.input.write('\r'); await until(() => modal(v, 'Work not pushed'), 'its work on no remote');
  assert.match(framed(v, 'Work not pushed').join(' '), /Keep it.*It has 1 file not committed\..*enter choose · esc cancel$/);
  v.input.write('\r'); await until(() => modal(v, 'Saved to memory'), 'the result with 40 lessons', 20000);
  const tail = () => framed(v, 'Saved to memory').map(row => row.replace(/┃$/, '').trim());
  const end = ['OK', '', 'Deleted "Tidy the logs".', 'Kept its work on feat/task-4.', '', 'enter close'];
  assert.deepEqual(tail().slice(-end.length), end, tail().join('\n'));
  assert.ok(tail().some(row => row === 'Lesson 1 for the shop.') && !tail().includes('Lesson 40 for the shop.'), `the rows scroll:\n${tail().join('\n')}`);
  v.input.write('\x1b[F'); await until(() => tail().includes('Lesson 40 for the shop.'), 'the last lesson, after End');
  assert.deepEqual(tail().slice(-end.length), end, 'the result stays whole under the rows');
  assert.doesNotMatch(tail().join(' '), /sara-box/);
  v.input.write('\r'); await until(() => !modal(v, 'Saved to memory'), 'closed');
  assert.deepEqual(peer.sent().filter(row => row.type === 'remoteClean'), [], 'nothing went to sara-box');
});

// /archived clean on this computer where 8 of its 9 archived sessions were brought back while
// the question was open: each is not deleted, and says why. At 80x24 those notes do not fit, so
// they go on after what was saved, under the OK button's keys, and the hint says pgdn more only
// while there is more below; PgDn and End show the last of them, PgUp and Home the top again.
// At 140x50 every note shows.
for (const [cols, high] of [[80, 24], [140, 50]]) test(`at ${cols}x${high} the notes of /archived clean's result that do not fit go on after what was saved, and pgdn more says so`, async t => {
  const { machines, answer } = editableThere(), p = project(later(t)); environment(t, p.parent);
  const fake = fakeClis(p.parent, { mode: 'answer', learned: { add: ['Use pnpm, not npm.', 'Keep replies short.'], remove: [] } }), previous = Object.fromEntries(['PATH', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(previous)) process.env[key] = fake.env[key];
  owned(t).files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  // Here: one archived session with a file not committed, and 8 more. sara-box: one archived there.
  const repo = repository(p.root); registerProject(repo);
  liveTask(p.root, { id: '4', goal: 'Tidy the logs', state: 'stopped' }); closeSession(repo, '4');
  const back = Array.from({ length: 8 }, (_, at) => String(at + 5));
  for (const [at, id] of back.entries()) { liveTask(p.root, { id, goal: `Round the refunds to the cent for shop ${at + 1}`, state: 'stopped', files: {} }); closeSession(repo, id); }
  machines[0].sessions[0].archived = true; machines[0].clean = true;
  const peer = fakePeer({ items: [], sharing: [SARA], machines, repoId: SHOP_REPO, answer }), v = await view(t, { repo, dashboard: true, peer, columns: cols, rows: high });
  const board = v.panels.board, rows = () => board.items.map(plainItem).map(row => row.trim()), narrow = cols === 80, title = 'Saved to memory';
  await send(v, '/archived'); await until(() => rows().some(row => /^ARCHIVED 9\b/.test(row)), "this computer's 9 archived sessions");
  await send(v, '/archived clean'); await until(() => modal(v, 'Clean up'), 'the question');
  assert.match(framed(v, 'Clean up').join(' '), /Deletes 9 archived sessions for good\./);
  // While it is open, 8 of them are brought back on this computer, from another window.
  for (const id of back) reopenSession(repo, id);
  v.input.write('\r'); await until(() => modal(v, 'Work not pushed'), 'its work on no remote');
  assert.match(framed(v, 'Work not pushed').join(' '), /1 of them has 1 file not committed\./);
  v.input.write('\r'); await until(() => modal(v, title), 'the result', 20000);
  const saved = framed(v, title), text = () => framed(v, title).join(' ').replace(/\s+/g, ' ');
  // What was saved shows first, under the border; then the button, and the hint last.
  // (A list with more than it shows draws its scrollbar at its right.)
  assert.deepEqual(saved.slice(0, 2).map(row => row.replace(/┃$/, '').trim()), ['Use pnpm, not npm.', 'Keep replies short.']);
  assert.ok(saved.some(row => row.trim() === 'OK'), saved.join('\n'));
  assert.equal(saved.at(-1).trim(), narrow ? 'enter close · pgdn more' : 'enter close');
  // The newest first, as the list shows them: shop 1's note is the last.
  const last = () => framed(v, title).some(row => row.includes('the cent for shop 1"'));
  if (narrow) {
    // The notes are in the text the keys scroll: PgDn shows the last of them, inside the border,
    // where they stand when they fit: one column in, in line with the hint.
    assert.ok(!last(), `the last note is further down:\n${saved.join('\n')}`);
    v.input.write('\x1b[6~'); await until(last, 'the last note, after PgDn');
    assert.ok(framed(v, title).some(row => row.startsWith(' Not deleted: "Round the refunds to the cent for shop 1"')), framed(v, title).join('\n'));
    // At the end nothing more is below, and the hint says only what Enter does.
    assert.equal(framed(v, title).at(-1).trim(), 'enter close', 'at the end');
    v.input.write('\x1b[5~'); await until(() => framed(v, title).some(row => row.includes('Use pnpm, not npm.')), 'the top again, after PgUp');
    assert.equal(framed(v, title).at(-1).trim(), 'enter close · pgdn more', 'more below again');
    // End and Home do the same.
    v.input.write('\x1b[F'); await until(last, 'the last note, after End');
    assert.equal(framed(v, title).at(-1).trim(), 'enter close', 'at the end again');
    v.input.write('\x1b[H'); await until(() => framed(v, title).some(row => row.includes('Use pnpm, not npm.')), 'the top again, after Home');
    assert.equal(framed(v, title).at(-1).trim(), 'enter close · pgdn more', 'more below once more');
  } else assert.match(text(), /OK Deleted "Tidy the logs"\. Kept its work on feat\/task-4\. Not deleted: "Round the refunds to the cent for shop 8": It is no longer archived\..* Not deleted: "Round the refunds to the cent for shop 1": It is no longer archived\. enter close$/, `every note shows:\n${framed(v, title).join('\n')}`);
  assert.doesNotMatch(text(), /sara-box/);
  v.input.write('\r'); await until(() => !modal(v, title), 'closed');
  // The 8 brought back are still here, open; the one still archived is deleted. Nothing went to sara-box.
  const left = tasks(repo).map(task => String(task.id));
  assert.ok(back.every(id => left.includes(id)) && !left.includes('4'), left.join(' '));
  assert.deepEqual(readBoard(repo).archived.filter(id => back.includes(id)), []);
  assert.deepEqual(peer.sent().filter(row => row.type === 'remoteClean'), [], 'nothing went to sara-box');
});

test("over a session on my other computer, its @name that is also a name on my team keeps the box on that computer, never a teammate ask", async t => {
  const at = new Date().toISOString(), id = '55555555-5555-4555-8555-555555555555';
  const remote = [{ id, machine: SARA, createdAt: at, lastAt: at, title: 'Roll the release', state: 'needs_input', question: 'Ship it?', choices: [], steps: [], entries: [{ role: 'You', at, text: 'Roll the release' }], approvals: [] }];
  const p = project(later(t)); environment(t, p.parent);
  // sara-box is mine; on the team it goes by sara, so @sara names it there and is a team name too.
  const peer = fakePeer({ items: [], sharing: [SARA], remote }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, ask = v.panels.ask, label = () => ask._label.getText();
  await until(() => board.items.map(plainItem).some(row => /Roll the release/.test(row)), 'the row of the session there');
  board.focus(); selectRow(board, /on sara-box/);
  await until(() => /Message the session on @sara-box/.test(label()), 'the session there under the cursor');
  ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box');
  v.input.write('@sara second message');
  await until(() => /Message the session on @sara-box/.test(label()), 'the box says it goes there');
  assert.doesNotMatch(label(), /teammate|Ask @/);
  await until(() => /enter send to @sara-box/.test(v.panels.keys.getText()), 'and the keys');
  ask.submit();
  await until(() => peer.sent().some(row => row.type === 'remoteSend'), 'sent there');
  assert.deepEqual(peer.sent().filter(row => row.type === 'remoteSend'), [{ type: 'remoteSend', id, text: 'second message', typed: true }]);
  assert.deepEqual(peer.sent().filter(row => row.type === 'ask'), [], 'no teammate was asked anything');
});


test('a message to someone who is not connected: the line under the chat and its open thread follow it while they are shown', { timeout: 40000 }, async t => {
  // The daemon's list as the message goes on: kept until they connect, delivered, answered.
  const items = [], at = new Date().toISOString(), base = { peer: LI, name: 'li', project: null, threadId: 'th-9' };
  const peer = fakePeer({ items, answer: command => command.type === 'ask' ? { askId: '9' } : null });
  peer.threadMessages = id => id === 'th-9' ? [{ from: 'me', kind: 'ask', text: 'Are the totals right?', at }] : [];
  const { v } = await teamView(t, { peer }), [, threads] = v.panels.teamLists, status = () => v.panels.status.getText(), title = 'Thread with @li';
  await openRow(v, /@li\s+offline/, '@li');
  items.push({ ...base, id: 'asked:9', kind: 'asked', text: 'Are the totals right?', at, state: 'pending' });
  await send(v, 'Are the totals right?');
  // Offline in the roster when it is sent: the line says that first, never that it was sent with no more.
  await until(() => /@li is offline(?: \(\d+s\))?\. Your message goes as soon as they connect\./.test(status()), 'offline is said first');
  await until(() => threads.items.some(item => /not connected to @li yet/.test(plainItem(item))), 'its row in the thread');
  threads.focus(); selectRow(threads, /you asked/); v.input.write('\r'); await until(() => modal(v, title), 'the thread');
  const body = () => modal(v, title).children.find(child => child.options?.scrollable).getContent();
  assert.match(body(), /↳ @li is offline[^\n]*\. Your message goes as soon as they connect\./);
  // Delivered: the line and the open thread say so by themselves.
  items[0] = { ...items[0], state: 'submitted', deliveredAt: at };
  await until(() => /Delivered to @li at \d\d:\d\d\./.test(status()), 'delivered, under the chat');
  await until(() => /↳ Delivered to @li at \d\d:\d\d\./.test(body()), 'delivered, in the open thread');
  // Answered.
  items[0] = { ...base, id: 'answer:9', kind: 'answer', text: 'Yes.', question: 'Are the totals right?', at, state: 'answered' };
  await until(() => /@li answered\. The reply is in Chats\./.test(status()), 'answered, under the chat');
  await until(() => /↳ @li answered\. The reply is in Chats\./.test(body()), 'answered, in the open thread');
  await closeDialog(v, title);
});

// /access reads the same whoever owns the other computers: there is no "mine", so no line
// for your computers and no separate wording for a team of them.
test('/access names no computer of yours, whoever owns the computers on the team', { timeout: 30000 }, async t => {
  const notes = (v, title) => modal(v, title).children.filter(child => child.type !== 'list').map(child => child.getText?.() ?? '').join('\n');
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], sharing: [SARA, LI] }), v = await view(t, { repo: repository(p.root), peer });
  await send(v, '/access'); await until(() => modal(v, 'What teammates can do here'), 'the handling');
  assert.doesNotMatch(notes(v, 'What teammates can do here'), /your computer/);
  await choose(v, 'What teammates can do here', /^Auto/); await closeDialog(v, 'Rules for teammates', '');
  assert.deepEqual(peer.calls.filter(row => row[0] === 'saveTeamAccess').map(row => row[2].handling), ['auto']);
});

// The owner's other computer heads this one's sessions with its name (On laptop-one · online).
// /computer says that name here and how to change it, and /computer name changes it at once;
// the other computers hear the new one from the daemon within a tick (test/peer-e2e.test.mjs).
// A bot's name is refused too: on the other computer @name finds the bot first, never this one.
for (const [columns, rows] of [[140, 50], [80, 24]]) test(`at ${columns}x${rows} /computer says what this computer is called and how to rename it, /computer name renames it at once, and a bad or taken name or a bot's name is refused in one line`, async t => {
  const p = project(later(t)); environment(t, p.parent); saveBot({ name: 'sec', instructions: 'Check for secrets.' });
  const peer = fakePeer({ items: [], sharing: [SARA], remoteBots: [{ name: 'deploy', about: 'Ships it' }] }), v = await view(t, { repo: repository(p.root), peer, columns, rows });
  const status = () => v.panels.status.getText().replace(/\s+/g, ' ').trim(), host = defaultBox();
  const says = async (typed, line) => { await send(v, typed); await until(() => status() === `› ${line}`, `${typed}: ${line}`).catch(error => { throw new Error(`${error.message}\nThe status: ${status()}`); }); };
  // At 80 columns the status is narrow: each line says it in fewer words.
  const wide = columns > 80, renamed = name => wide ? `This computer is @${name} now. Every computer on your team sees it within seconds.` : `This computer is @${name} now; the others see it within seconds.`;
  await says('/computer', wide ? `This computer is @${host}, from its host name. /computer name NAME renames it.` : `This computer is @${host}. /computer name NAME renames it.`);
  await says('/computer name studio', renamed('studio'));
  assert.equal(peerSettings().box, 'studio'); assert.equal(peerBox(), 'studio');
  await says('/computer', wide ? 'This computer is @studio. /computer name NAME renames it, or default for its host name.' : 'This computer is @studio. /computer name NAME renames it.');
  const RULE = "A computer's name is 1 to 32 letters, digits, dots, - or _.";
  for (const [typed, line] of [['/computer name my box', RULE], [`/computer name ${'x'.repeat(33)}`, RULE], ['/computer name sara-box', 'Another computer on your team is called sara-box.'], ['/computer name model', '@model already means something in ELU. Choose another name.'],
    // Bots: one ELU comes with, one saved here, one the other computer shares.
    ['/computer name qa', '@qa is the name of a bot. Choose another name.'], ['/computer name Reviewer', '@reviewer is the name of a bot. Choose another name.'], ['/computer name sec', '@sec is the name of a bot. Choose another name.'], ['/computer name deploy', '@deploy is the name of a bot. Choose another name.'], ['/computer studio', 'Use /computer name NAME, or /computer name default.']]) {
    await send(v, typed); await until(() => status().includes(line), `${typed}: ${line}`);
  }
  assert.equal(peerBox(), 'studio', 'a refused name changes nothing');
  await says('/computer name @box-one', renamed('box-one'));
  await says('/computer name default', `This computer goes by its host name again: @${host}.`);
  assert.equal(peerSettings().box, null); assert.equal(peerBox(), host);
  await says('/computer name studio', renamed('studio'));
  // Typed in the box: Enter on /computer name fills it in and offers default, and Enter on that gives the host name back.
  const ask = v.panels.ask; ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box'); ask.clearValue(); v.input.write('/computer name');
  await until(() => v.lines().some(line => /name\s+Rename this computer/.test(line)), 'name offered');
  v.input.write('\r'); await until(() => ask.getValue() === '/computer name ', 'filled in');
  await until(() => v.lines().some(line => /default\s+Go back to its host name/.test(line)), 'default offered');
  v.input.write('\r'); await until(() => status() === `› This computer goes by its host name again: @${host}.`, 'back to the host name');
  assert.equal(peerSettings().box, null);
  // The command list names it.
  ask.clearValue(); v.input.write('/comp');
  await until(() => v.lines().some(line => /\/computer\s+This computer's name/.test(line)), 'the command list');
});

test('Sessions names a message from a computer whose person goes by my name by its computer name, as Chats does, and /mine marks nothing', async t => {
  const at = new Date().toISOString(), p = project(later(t)); environment(t, p.parent);
  const repo = repository(p.root), origin = { kind: 'handoff', own: true, peer: SARA, name: 'sara', a2aTaskId: 'task-1' };
  // A session its message started here, and a question from it that waits for me.
  saveTask(repo, { id: '1', kind: 'conversation', goal: 'Run the release checks', state: 'answered', worktree: repo.root, base: null, branch: null, createdAt: at, origin, runs: [], reviews: [], responses: [], messages: [{ at, text: 'Run the release checks' }], sessions: {}, result: null });
  const items = [{ id: 'incoming-1', kind: 'incoming', peer: SARA, name: 'sara', project: null, text: 'Where are the fixtures?', at: ago(1), state: 'submitted', threadId: 'th-1' }];
  // That computer's person goes by my name (one person's two computers): "@ana" would read as me.
  const peer = fakePeer({ items, sharing: [SARA], saraName: 'ana' }), v = await view(t, { repo, dashboard: true, peer });
  const board = v.panels.board, status = () => v.panels.status.getText(), text = () => board.items.map(plainItem).join('\n');
  await until(() => /Run the release checks/.test(text()) && /@sara-box question/.test(text()), 'both rows').catch(error => { throw new Error(`${error.message}\n${text()}`); });
  assert.doesNotMatch(text(), /@sara(?!-box)|@ana/, 'never under its person name');
  // The rows as the list is built: the session its message started carries the same name.
  const rows = boardRows([{ root: repo.root, name: 'sample', tasks: [readTask(repo, '1')], queue: [] }], Date.now(), { called: (name, key) => key === SARA ? '@sara-box' : peerName(name, key) });
  assert.equal(rows.find(row => row.kind === 'task').agent, '@sara-box');
  assert.equal(boardRows([{ root: repo.root, name: 'sample', tasks: [readTask(repo, '1')], queue: [] }]).find(row => row.kind === 'task').agent, '@sara', 'without the app, as the team names it');
  // /mine from before marks nothing, and says so in one line.
  await send(v, '/mine @nobody');
  await until(() => /Every computer on a project works the same: there is nothing to mark\./.test(status()), '/mine marks nothing');
});

test('/model NAME and a message over a session on my other computer go there as typed: that computer reads the name, and the status names the model it took', async t => {
  const at = new Date().toISOString(), id = '55555555-5555-4555-8555-555555555555';
  const remote = [{ id, machine: SARA, createdAt: at, lastAt: at, title: 'Invoice page test handoff', state: 'running', steps: [], entries: [{ role: 'You', at, text: 'Start the handoff' }], approvals: [] }];
  const p = project(later(t)); environment(t, p.parent);
  const before = process.env.PATH; process.env.PATH = fakeClis(p.parent).env.PATH; owned(t).files.push(() => { process.env.PATH = before; });
  // What the other computer answers: the model it read at the start of the text, by the name it shows it by, and whether words came after it.
  const THERE = [[/^opus 5\.5\b/i, 'Opus 5.5'], [/^opus\b/, 'Opus 5.5'], [/^sonnet 5\b/, 'Sonnet 5'], [/^devbox-model\b/, 'devbox-model']];
  const took = text => THERE.find(([name]) => name.test(text));
  let older = false, works = false;
  const peer = fakePeer({ items: [], sharing: [SARA], remote, refuse: command => command.type !== 'remoteSend' || !command.model ? null
    : older ? 'Update ELU on @sara-box to change its model from here.' : took(command.text) ? null : `@sara-box: No model named ${command.text.split(' ')[0]}. /model lists them; /model add adds one by name.` });
  const answer = peer.awaitCommand; peer.awaitCommand = async (...args) => { const out = await answer(...args), command = peer.last; return command.type === 'remoteSend' && command.model ? { id, model: took(command.text)[1], sent: command.text.replace(took(command.text)[0], '').trim() !== '', ...(works ? { later: true } : {}) } : out; };
  const v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, sentThere = () => peer.sent().filter(row => row.type === 'remoteSend'), status = () => v.panels.status.getText().replace(/\s+/g, ' ');
  const over = async () => { board.focus(); selectRow(board, /Invoice page test handoff/); await until(() => /@sara-box/.test(v.panels.ask._label.getText()), 'the box writes about the session there'); };
  await until(() => board.items.map(plainItem).some(row => /Invoice page test handoff/.test(row)), 'the row of the session there');
  await over(); await send(v, '/model opus can you check which files that session is asking about and instruction to start the handoff');
  await until(() => sentThere().length === 1, 'sent there');
  assert.deepEqual(sentThere()[0], { type: 'remoteSend', id, text: 'opus can you check which files that session is asking about and instruction to start the handoff', model: true, typed: true });
  await until(() => /Sent to the session on @sara-box, now on Opus 5\.5\./.test(status()), 'the status says where it went and names the model as that computer does');
  // The name alone. No Opus ever ran on this computer, so it has no model it shows as Opus 5.5: the two words still go as typed, and no id is made up here.
  await over(); await send(v, '/model opus 5.5');
  await until(() => sentThere().length === 2, 'the model alone');
  assert.deepEqual(sentThere()[1], { type: 'remoteSend', id, text: 'opus 5.5', model: true, typed: true });
  await until(() => /The session on @sara-box uses Opus 5\.5 from your next message\./.test(status()), 'the status names the model');
  await over(); await send(v, '/model sonnet 5');
  await until(() => sentThere().length === 3 && /The session on @sara-box uses Sonnet 5 from your next message\./.test(status()), 'a name and version');
  assert.deepEqual(sentThere()[2], { type: 'remoteSend', id, text: 'sonnet 5', model: true, typed: true });
  // A model only that computer has: this one's /model would say there is none, and it is not asked.
  await over(); await send(v, '/model devbox-model  and the tests');
  await until(() => sentThere().length === 4 && /Sent to the session on @sara-box, now on devbox-model\./.test(status()), 'a model of that computer alone');
  assert.deepEqual(sentThere()[3], { type: 'remoteSend', id, text: 'devbox-model  and the tests', model: true, typed: true });
  // A name that computer does not know: its own line, and the text stays to be corrected.
  await over(); await send(v, '/model nosuch and the tests');
  await until(() => /@sara-box: No model named nosuch\. \/model lists them; \/model add adds one by name\./.test(status()), 'that computer says it has no such model');
  assert.equal(v.panels.ask.getValue(), '/model nosuch and the tests'); v.panels.ask.setValue('');
  // Its turn works there (later): the model starts with its next turn, and a message after the name waits for that turn to end. Each line says so.
  works = true;
  await over(); await send(v, '/model opus 5.5');
  await until(() => sentThere().at(-1).text === 'opus 5.5' && /The session on @sara-box uses Opus 5\.5 from its next turn\./.test(status()), 'the model alone, while it works there');
  await over(); await send(v, '/model opus 5.5 and the tests');
  await until(() => sentThere().at(-1).text === 'opus 5.5 and the tests' && /Sent to the session on @sara-box\. Opus 5\.5 takes it when its running turn ends\./.test(status()), 'a message with it, while it works there');
  works = false;
  // That computer runs an older ELU, which would send the whole text as a message and keep the old model: one plain line, nothing sent, and the text stays.
  older = true;
  await over(); await send(v, '/model opus 5.5 and the tests');
  await until(() => /Update ELU on @sara-box to change its model from here\./.test(status()), 'the status says to update it');
  assert.equal(v.panels.ask.getValue(), '/model opus 5.5 and the tests');
});

// The check's report: over an open session on another computer, /agent change read "Open a
// session first." and a click on its reply heading did nothing. Its agents are changed on the
// computer that runs it, and both say so, with what does work from here.
test('over a session on my other computer, /agent and a click on a reply heading say where its agents are changed, and nothing is sent there', { timeout: 60000 }, async t => {
  const at = new Date().toISOString(), id = '55555555-5555-4555-8555-555555555555';
  const remote = [{ id, machine: SARA, createdAt: at, lastAt: at, title: 'Invoice totals fix', state: 'answered', question: null, choices: [], steps: [], entries: [{ role: 'You', at, text: 'Fix the totals' }, { role: 'Opus 5.5', lead: true, at, text: 'Fixed them.' }, { role: '@reviewer', bot: 'reviewer', at, text: 'The totals read right.' }], approvals: [] }];
  const p = project(later(t)); environment(t, p.parent);
  const before = process.env.PATH; process.env.PATH = fakeClis(p.parent).env.PATH; owned(t).files.push(() => { process.env.PATH = before; });
  const peer = fakePeer({ items: [], sharing: [SARA], remote });
  const v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, pane = v.panels.chat, status = () => v.panels.status.getText().replace(/\s+/g, ' ').trim();
  const opened = start => v.current.screen.children.find(child => !child.destroyed && child.options?.label?.trim().startsWith(start));
  const over = async () => { board.focus(); selectRow(board, /Invoice totals fix/); await until(() => /@sara-box/.test(v.panels.ask._label.getText()), 'the box writes about the session there'); };
  const THERE = "This session's agents are changed on @sara-box. /model <name> changes its model from here.";
  await until(() => board.items.map(plainItem).some(row => /Invoice totals fix/.test(row)), 'the row of the session there');
  await over();
  const plainRow = index => String(pane._clines?.[index] ?? '').replace(/\x1b\[[\d;]*m/g, '').trimStart();
  const heading = start => (pane._clines ?? []).findIndex((_, index) => plainRow(index).startsWith(start));
  await until(() => heading('Opus 5.5') >= 0 && heading('@reviewer') >= 0, 'the reply headings of the session there show');
  // Another line under the box first, so each one below is seen to come.
  const other = async () => { await over(); await send(v, '/model'); await until(() => /\/model default <name> changes it\./.test(status()), 'another line'); };
  // By keys: every /agent line, and the text stays in the box.
  for (const typed of ['/agent change @model effort high', '/agent change @reviewer model sonnet --every-session', '/agents', '/agent add sonnet', '/agent remove reviewer']) {
    await other(); await over(); await send(v, typed);
    try { await until(() => status().includes(THERE), typed, 5000); } catch { assert.fail(`${typed}: ${status()} | box: ${v.panels.ask.getValue()}`); }
    assert.equal(v.panels.ask.getValue(), typed); v.panels.ask.setValue('');
  }
  // By mouse: the heading of the model's reply and of a bot's, where each is drawn.
  for (const start of ['Opus 5.5', '@reviewer']) {
    await other(); await over();
    const x = pane.aleft + 3, y = pane.atop + heading(start) + pane.itop - pane.childBase + 1;
    v.input.write(`\x1b[<0;${x};${y}M`); v.input.write(`\x1b[<0;${x};${y}m`);
    try { await until(() => status().includes(THERE), start, 5000); } catch { assert.fail(`a click on ${start}: ${status()}`); }
    assert.equal(opened('Agent '), undefined, 'no page of an agent that is not changed from here');
  }
  assert.deepEqual(peer.sent().filter(row => /^remote(Send|Start)$/.test(row.type)), [], 'nothing was sent there');
});

test('status typed on the row of a running session on my other computer is a message and stops nothing there; s then Enter stops it', async t => {
  const at = new Date().toISOString(), id = '66666666-6666-4666-8666-666666666666';
  const remote = [{ id, machine: SARA, createdAt: at, lastAt: at, title: 'Run the nightly checks', state: 'running', steps: [], entries: [{ role: 'You', at, text: 'Run the nightly checks' }], approvals: [] }];
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], sharing: [SARA], remote }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, ask = v.panels.ask, keys = () => v.panels.keys.getText(), stops = () => peer.sent().filter(row => row.type === 'remoteStop');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const onRow = async () => { board.focus(); selectRow(board, /Run the nightly/); await until(() => v.current.screen.focused === board && /enter open {2}s stop {2}d changes {2}e rename {2}n new session {2}letter then enter/.test(keys()) && /Message the session on @sara-box/.test(ask._label.getText()), 'its row, with s stop'); };
  await until(() => board.items.map(plainItem).some(row => /ON SARA-BOX/.test(row)) && board.items.map(plainItem).some(row => /Run the nightly checks/.test(row)), 'the row of the session there, under its computer');
  // The owner's word, a key at a time. s is this row's key for stop, and it stops nothing there.
  await onRow(); v.type('status');
  await until(() => ask.getValue() === 'status' && v.current.screen.focused === ask, 'status is in the box');
  await wait(300); assert.deepEqual(stops(), [], 'nothing was stopped there');
  // Enter sends it as a message, to the session there, which still runs. No session is made here.
  v.type('\r'); await until(() => peer.sent().some(row => row.type === 'remoteSend' && row.id === id && row.text === 'status'), 'sent as a message');
  assert.deepEqual(pendingRequests(p.root), [], 'nothing was queued here');
  await wait(200); assert.deepEqual(stops(), [], 'still running there'); assert.equal(ask.getValue(), '');
  // s alone: the line under the box says what Enter does. Enter stops it there.
  await onRow(); v.type('s');
  await until(() => ask.getValue() === 's' && /enter stops this session · keep typing to write a message/.test(keys()), 'the line under the box names s');
  await wait(200); assert.deepEqual(stops(), []);
  v.type('\r'); await until(() => stops().length === 1, 's then Enter stops it there');
  assert.equal(stops()[0].id, id); assert.equal(ask.getValue(), '');
});

// --- Projects: what a teammate shares that this computer does not have ---
// As lib/peer/shared.mjs lists one (teammateProjects) and its team board (teammateProjectBoard).
const SHARED = '9'.repeat(64);
const sharedRow = (extra = {}, sharer = {}) => ({ id: SHARED, name: 'Shop', handle: 'shop', repoId: SHARED, address: 'https://github.com/acme/shop.git', teams: [{ id: 'team-1', name: 'Core' }],
  sharers: [{ key: SARA, name: 'sara', box: 'sara-box', online: true, mine: false, handle: 'shop', title: 'Shop', older: false, ...sharer }], ...extra });
function sharing(peer, rows, board = {}) {
  peer.shared = rows; peer.teammateProjects = () => peer.shared;
  peer.teammateProjectBoard = id => { const row = peer.shared.find(value => value.id === id); return row ? { row, plans: board.plans ?? [], sessions: board.sessions ?? [] } : null; };
  return peer;
}

test('Projects lists a project a teammate shares that is not on this computer: Enter opens its team board, the box there writes to whoever shares it, and c brings it here as the one row', async t => {
  const { git } = await import('./helpers.mjs'), fs = await import('node:fs');
  const p = project(later(t)), source = project(later(t)); environment(t, p.parent);
  const task = { repoId: SHARED, handle: 'shop', id: 't-0a1b2c3d', revision: 1, title: 'Fix the login redirect', description: '', goal: 'Sign-in returns to the page that asked for it.', objectives: [], priority: 'high', severity: 'high', state: 'approved', startedBy: 'owner', who: 'Opus 5.5', subtasks: [], met: [], approvedAt: ago(30), doneAt: null, updatedAt: ago(2) };
  const peer = sharing(fakePeer({ items: [] }), [sharedRow()], {
    plans: [{ peer: SARA, name: 'sara', box: 'sara-box', online: true, heardAt: ago(0), tasks: [task] }],
    sessions: [{ peer: SARA, name: 'sara', box: 'sara-box', online: true, heardAt: ago(0), sessions: [{ repoId: SHARED, id: '0123456789abcdef', title: 'Fix the cart total', column: 'needs', by: 'sara', at: ago(1) }] }] });
  // The clone, as git makes it. From then on the project is here, so nothing lists it as shared.
  peer.cloneProject = async (address, folder) => { peer.calls.push(['cloneProject', address, folder]); git(source.root, ['clone', '--quiet', source.root, folder]); peer.shared = []; return { root: folder }; };
  const v = await view(t, { repo: repository(p.root), dashboard: true, peer }), panels = v.panels, list = panels.projectsList;
  const rows = () => list.items.map(plainItem).map(row => row.trimEnd()), status = () => panels.status.getText(), keys = () => panels.keys.getText(), label = () => panels.ask._label.getText();
  const column = index => panels.kanbanLists[index].items.map(item => plainItem(item).trimEnd());
  await send(v, '/projects'); await until(() => v.current.view === 'projects' && rows().some(row => /Shop/.test(row)), 'the shared project');
  assert.equal(rows().length, 2, 'this computer\'s project, then the shared one');
  assert.match(rows()[1], /^ {2}Shop\s+shared by @sara {3}on @sara-box\s+online$/);
  list.focus(); selectRow(list, /shared by @sara/);
  await until(() => /enter team board/.test(keys()), 'its keys'); assert.match(keys(), /c bring here/); assert.doesNotMatch(keys(), /archive|make active/);
  // o and x are for a project of this computer.
  v.input.write('x'); await until(() => /Shop is not on this computer\. Enter opens its team board; c brings it here\./.test(status()), 'x does nothing to it');
  // Enter: its team board, read-only, under its name and who shares it.
  v.input.write('\r'); await until(() => v.current.view === 'kanban' && column(1).length === 1 && column(2).length === 1, 'the team board');
  assert.match(panels.header.getText(), /Shop {2}· {2}shared by @sara {2}· {2}on @sara-box/);
  assert.match(column(1)[0], /^Fix the login.*sara on sara-box$/); assert.match(column(2)[0], /^Fix the cart total\s+@sara · sara-box$/);
  assert.equal(panels.newCard.hidden, true, 'no task is added to a project that is not here'); assert.equal(panels.back.hidden, false); assert.equal(panels.back.content, ' ‹ Projects ');
  assert.equal(panels.kanbanTeam.getText(), "Shop is @sara's project, on @sara-box, not on this computer. A message here starts a session there. c in Projects brings it here.");
  assert.match(label(), /^ Message @sara about Shop · starts a session on their computer, under the access they chose $/);
  // n goes to the box; what is typed there is sent to the sharer about that project, and no card or session is made here.
  v.input.write('n'); await until(() => v.current.screen.focused === panels.ask, 'the message box');
  // Empty, it sends nothing: Enter is named once there is text.
  await until(() => keys().trim() === '/ commands', `the empty box names no Enter, not ${keys()}`);
  panels.ask.readInput(); await until(() => panels.ask.__listener, 'the box reads');
  v.input.write('Can'); await until(() => /^enter send to @sara {2}\/ commands$/.test(keys().trim()), 'with text, Enter sends it to her');
  panels.ask.clearValue();
  await send(v, 'Can you rebase the cart branch?');
  await until(() => peer.sent().some(row => row.type === 'ask'), 'the message');
  assert.deepEqual(peer.sent().filter(row => row.type === 'ask'), [{ type: 'ask', to: SARA, project: 'shop', text: 'Can you rebase the cart branch?' }]);
  await until(() => /Sent to @sara\. It starts a session on their computer, under the access they chose\. The reply shows in Chats\./.test(status()), 'what happened to it');
  assert.deepEqual(readBoard(repository(p.root)).cards, []); assert.deepEqual(pendingRequests(p.root), []);
  assert.equal(v.current.view, 'kanban', 'the board stays open');
  // Back to Projects, and c: where to put it, then the clone, registered under its name and made active.
  panels.back.focus(); v.input.write('\r'); await until(() => v.current.view === 'projects', 'Projects again');
  list.focus(); selectRow(list, /shared by @sara/); v.input.write('c');
  await until(() => modal(v, 'Bring Shop here'), 'where to put it');
  assert.match(v.text(), /https:\/\/github\.com\/acme\/shop\.git/); assert.equal(modal(v, 'Bring Shop here').children.find(child => child.type === 'textbox').getValue(), '~/shop');
  const here = path.join(p.parent, 'shop here'); await closeDialog(v, 'Bring Shop here', here);
  await until(() => /Shop is here now, in \S.*shop here\. It is the active project\./.test(status()), 'brought here');
  assert.deepEqual(peer.calls.filter(row => row[0] === 'cloneProject').map(row => row.slice(1)), [['https://github.com/acme/shop.git', here]]);
  assert.ok(fs.existsSync(path.join(here, '.git')));
  await until(() => rows().length === 2 && rows().some(row => /^● Shop\s/.test(row)), 'one row for it: the project here');
  assert.ok(!rows().some(row => /shared by/.test(row)), 'never a second row for the same project');
});

// A team's project this computer has no folder of yet (lib/peer/shared.mjs gives its row the team):
// a project of its own here, never "shared by". Its page has its sessions and its board on every
// computer of the team, its instructions and memory to read, and which folder here it is.
test("a team's project with no folder here opens its page from Projects: its sessions and board on every computer of the team, its instructions and memory to read, and e on them asks which folder here it is", async t => {
  const TEAM = 'f'.repeat(64), p2 = '2'.repeat(16);
  const session = (n, title, minutes, extra = {}) => ({ id: `${n}1111111-1111-4111-8111-11111111111${n}`, ref: `${p2}:${n}`, project: p2, title, state: 'answered', at: ago(minutes), createdAt: ago(minutes + 1), approvals: [], by: 'you', who: null, ...extra });
  const machines = [{ key: SARA, theirs: true, listedAt: ago(0), older: false, projects: [{ id: p2, name: 'ELU', repoId: null, home: false, teams: [TEAM] }], sessions: [session(1, 'Fix the login page', 2), session(2, 'Write the release notes', 5, { state: 'running' })] }];
  const p = project(later(t)); environment(t, p.parent);
  const peer = sharing(fakePeer({ items: [], machines }), [sharedRow({ id: `${SARA.slice(0, 16)}-elu`, name: 'ELU', handle: 'elu', repoId: null, address: null, team: TEAM }, { handle: 'elu', title: 'ELU' })]);
  peer.teamNotes = team => team === TEAM ? { instructions: 'Use pnpm, not npm.\n', memory: 'The login page lives in web/login.\n' } : { instructions: '', memory: '' };
  peer.keepTeamFolder = (team, root) => { peer.calls.push(['keepTeamFolder', team, root]); peer.shared = []; return root; };
  const v = await view(t, { repo: repository(p.root), dashboard: true, peer }), panels = v.panels, list = panels.projectsList;
  const rows = () => list.items.map(plainItem).map(row => row.trimEnd()), column = index => panels.kanbanLists[index].items.map(item => plainItem(item).trimEnd());
  await send(v, '/projects'); await until(() => v.current.view === 'projects' && rows().some(row => /no folder here yet/.test(row)), 'the team\'s project');
  assert.match(rows()[1], /^ {2}ELU\s+no folder here yet\s+2 sessions · 2 on @sara-box/);
  assert.ok(!rows().some(row => /shared by/.test(row)), rows().join('\n'));
  list.focus(); selectRow(list, /no folder here yet/);
  await until(() => /enter open/.test(panels.keys.getText()), 'its keys');
  v.input.write('\r'); await until(() => rowsOf(v, 'Project ELU').length === 5, 'its page');
  const page = rowsOf(v, 'Project ELU').map(row => row.trimEnd());
  assert.match(page[0], /^Sessions\s+2 sessions · 2 on @sara-box$/); assert.match(page[1], /^Kanban\s+its board on every computer$/);
  assert.match(page[2], /^Instructions\s+Use pnpm, not npm\.$/); assert.match(page[3], /^Memory\s+The login page lives in web\/login\.$/);
  assert.match(page[4], /^Folder here\s+none yet · Enter chooses which$/);
  // Its instructions, the team's, to read; Esc goes back to its page.
  await choose(v, 'Project ELU', /^Instructions/);
  await until(() => modal(v, 'Instructions · ELU'), 'its instructions');
  assert.match(modal(v, 'Instructions · ELU').children.find(child => child.options?.scrollable).getText(), /Use pnpm, not npm\./);
  v.input.write('\x1b'); await until(() => rowsOf(v, 'Project ELU').length === 5, 'its page again');
  // Kanban: its board, the sessions of it on every computer of the team.
  await choose(v, 'Project ELU', /^Kanban/);
  await until(() => v.current.view === 'kanban' && column(1).length === 1 && column(2).length === 1, 'its board');
  assert.match(panels.header.getText(), /ELU {2}· {2}no folder here yet/); assert.doesNotMatch(panels.header.getText(), /shared by|on @sara-box/);
  assert.match(column(1)[0], /^Write the release.*@sara · sara-box$/); assert.match(column(2)[0], /^Fix the login page.*@sara · sara-box$/);
  assert.match(panels.kanbanTeam.getText(), /^ELU on every computer of the team\. It has no folder here yet/);
  // Sessions shows its sessions under each computer, and keeps it open: back in Kanban, it is its board still.
  await send(v, '/sessions'); await until(() => v.current.view === 'tasks' && v.panels.board.items.some(item => /ELU ON SARA-BOX/.test(plainItem(item))) && v.panels.board.items.some(item => /Fix the login page/.test(plainItem(item))), 'its sessions');
  await send(v, '/kanban'); await until(() => v.current.view === 'kanban' && column(2).some(row => /Fix the login page/.test(row)), 'its board again');
  // e on its memory: written here, it is its folder's, so it asks which folder that is.
  await send(v, '/projects'); await until(() => v.current.view === 'projects' && rows().some(row => /no folder here yet/.test(row)), 'Projects');
  list.focus(); selectRow(list, /no folder here yet/); v.input.write('\r');
  await choose(v, 'Project ELU', /^Memory/);
  await until(() => modal(v, 'Memory · ELU'), 'its memory');
  v.input.write('e'); await until(() => rowsOf(v, 'Which folder here is ELU?').length === 1, 'which folder');
  await choose(v, 'Which folder here is ELU?', /sample app|shop|\S/);
  await until(() => peer.calls.some(row => row[0] === 'keepTeamFolder'), 'kept');
  assert.deepEqual(peer.calls.filter(row => row[0] === 'keepTeamFolder').map(row => row.slice(1)), [[TEAM, v.current.controller.repo.root]]);
});

// No length of ours on what the owner sends: a long spec typed on a shared project's team board
// goes to whoever shares it whole, as a long message in Chats goes (lib/peer/asks.mjs sends one
// too long for a line on the link in pieces ahead of its message).
test("a message of any length on a shared project's team board goes to whoever shares it, whole", async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = sharing(fakePeer({ items: [] }), [sharedRow()]);
  const v = await view(t, { repo: repository(p.root), dashboard: true, peer }), panels = v.panels, list = panels.projectsList, status = () => panels.status.getText();
  await send(v, '/projects'); await until(() => v.current.view === 'projects' && list.items.some(item => /shared by @sara/.test(plainItem(item))), 'the shared project');
  list.focus(); selectRow(list, /shared by @sara/); v.input.write('\r');
  await until(() => v.current.view === 'kanban' && /Message @sara/.test(panels.ask._label.getText()), 'its team board');
  const spec = `Spec for the cart page.\n${'Every line of this spec matters to the cart. '.repeat(460)}THE END`;
  assert.ok(spec.length > 20000);
  await send(v, spec);
  await until(() => peer.sent().some(row => row.type === 'ask') || /Keep it under/.test(status()), 'the message, or a refusal');
  assert.doesNotMatch(status(), /Keep it under/);
  assert.deepEqual(peer.sent().filter(row => row.type === 'ask'), [{ type: 'ask', to: SARA, project: 'shop', text: spec }]);
  await until(() => /Sent to @sara\./.test(status()), 'what happened to it');
});

test('a shared project with no git address says how to get it here, the board of one that is no longer shared closes, and its row fits at 80 columns', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = sharing(fakePeer({ items: [] }), [sharedRow({ address: null, name: 'A much longer project name than fits' }, { name: 'a-teammate-with-a-long-name', box: 'their-very-long-machine-name' }), sharedRow({ id: '8'.repeat(64), repoId: '8'.repeat(64), name: 'Old one', handle: 'old', address: null }, { older: true, online: false })]);
  // The status line is one row here: each line is the longest form of it that fits.
  const v = await view(t, { repo: repository(p.root), dashboard: true, peer, columns: 80, rows: 24 }), panels = v.panels, list = panels.projectsList, status = () => panels.status.getText().trimEnd();
  const rows = () => list.items.map(plainItem).map(row => row.trimEnd());
  await send(v, '/projects'); await until(() => v.current.view === 'projects' && rows().length === 3, 'both shared projects');
  for (const row of rows()) assert.ok(row.length <= list.width - 2, `it fits at 80: ${row}`);
  assert.match(rows()[1], /^ {2}A much longer proje\.\.\.\s+shared by @a-teammate-with-a-long-name/); assert.match(rows()[2], /Old one\s+shared by @sara {3}on @sara-box\s+offline$/);
  // c with no address: nothing to clone, and what to do instead.
  list.focus(); selectRow(list, /A much longer/); v.input.write('c');
  await until(() => /› No git address\. Copy its folder here, open a terminal in it and run ELU\.$/.test(status()), 'no address');
  // A teammate on an older ELU sends no address: the line says which side needs the update.
  selectRow(list, /Old one/); v.input.write('c');
  await until(() => /› No git address: @sara needs ELU 0\.1\.20\. Copy its folder here and run ELU\.$/.test(status()), 'an older teammate');
  // Its board at 80 columns: the box's title is the longest form that fits.
  v.input.write('\r'); await until(() => v.current.view === 'kanban' && /Message @sara/.test(panels.ask._label.getText()), 'the team board');
  assert.match(status(), /› Old one, shared by @sara on @sara-box\. The box below writes to @sara\.$/);
  await send(v, 'Is the old one still used?');
  await until(() => /› Sent to @sara\. It starts a session there\. The reply shows in Chats\.$/.test(status()), 'sent, in a line that fits');
  assert.deepEqual(peer.sent().filter(row => row.type === 'ask'), [{ type: 'ask', to: SARA, project: 'old', text: 'Is the old one still used?' }]);
  assert.ok(panels.ask._label.getText().length <= panels.ask.width - 2, panels.ask._label.getText());
  assert.match(panels.ask._label.getText(), /^ Message @sara about Old one · starts a session there $/);
  // No longer shared (unshared, or the team left): Kanban is this computer's again, and Projects lists it no more.
  peer.shared = [];
  await until(() => /That project is no longer shared with this computer\./.test(status()), 'it says so', 15000);
  assert.equal(panels.newCard.hidden, false); assert.doesNotMatch(panels.ask._label.getText(), /Message @sara/);
  await send(v, '/projects'); await until(() => v.current.view === 'projects' && rows().length === 1, 'only this computer\'s project');
});

test('leaving the team while the board of a project it shares is open closes that board, and the line still says the leave', async t => {
  const p = project(later(t)); environment(t, p.parent);
  // The only team: leaving it takes this machine off every team.
  const peer = sharing(fakePeer({ items: [] }), [sharedRow()]); peer.lastTeam = true;
  const v = await view(t, { repo: repository(p.root), dashboard: true, peer }), panels = v.panels, list = panels.projectsList, status = () => panels.status.getText().trimEnd();
  await send(v, '/projects'); await until(() => v.current.view === 'projects' && list.items.length === 2, 'the shared project');
  list.focus(); selectRow(list, /Shop/); v.input.write('\r');
  await until(() => v.current.view === 'kanban' && /Message @sara/.test(panels.ask._label.getText()), 'its team board');
  await send(v, '/leave'); await closeDialog(v, 'Leave Core', 'y');
  await until(() => panels.newCard.hidden === false && !/Message @sara/.test(panels.ask._label.getText()), 'Kanban is this computer\'s again');
  assert.match(status(), /› You left Core\. You are on no team now, so the peer daemon stops\./);
  // It stays the line: the board closing does not replace it.
  await new Promise(resolve => setTimeout(resolve, 3500)); assert.match(status(), /› You left Core\./);
});

test('a project my other computer shares opens as that computer lists it, and is one row beside its sessions there', async t => {
  const now = Date.now(), at = minutes => new Date(now - minutes * 60000).toISOString(), p1 = '1'.repeat(16);
  const session = { id: '11111111-1111-4111-8111-111111111111', ref: `${p1}:1`, project: p1, title: 'Typed there by hand', state: 'answered', at: at(5), createdAt: at(6), approvals: [], by: 'you', who: null };
  const machines = [{ key: SARA, listedAt: at(0), older: false, projects: [{ id: p1, name: 'Shop', repoId: SHARED, home: false }], sessions: [] }];
  const p = project(later(t)); environment(t, p.parent);
  const peer = sharing(fakePeer({ items: [], sharing: [SARA], machines }), [sharedRow({}, { mine: true })]);
  const v = await view(t, { repo: repository(p.root), dashboard: true, peer }), list = v.panels.projectsList, rows = () => list.items.map(plainItem).map(row => row.trimEnd());
  await send(v, '/projects'); await until(() => v.current.view === 'projects' && rows().some(row => /Shop\s+shared by you {3}on @sara-box/.test(row)), 'the project of my other computer');
  // Enter: its sessions there, as for any project of that computer.
  list.focus(); selectRow(list, /shared by you/); await until(() => /enter open/.test(v.panels.keys.getText()), 'its keys');
  v.input.write('\r'); await until(() => v.current.view === 'tasks' && /Sessions of Shop on @sara-box: none yet\./.test(v.panels.status.getText()), 'the view of its sessions there');
  // Once that computer has a session in it, Sessions shows it there. No project here holds it, so
  // Projects keeps its one row: it is not listed again as that computer's.
  machines[0].sessions = [session];
  await until(() => v.panels.board.items.some(item => /Typed there by hand/.test(plainItem(item))), 'its session in Sessions');
  await send(v, '/projects'); await until(() => v.current.view === 'projects' && rows().some(row => /Shop\s+shared by you {3}on @sara-box/.test(row)), 'its one row');
  assert.equal(rows().filter(row => /Shop/.test(row)).length, 1, `one row for it: ${rows().join(' | ')}`);
});

// The owner's report, on the computer with no session of its own: its project read "0 sessions"
// while 22 ran in it on his other computer. The row counts them, says where when the folder
// still shows beside it, and its last activity is theirs. One archived there is not counted.
test("a project here counts my other computer's sessions in it, says where when the row has room, and its last activity is theirs, at 160 and at 80 columns", async t => {
  const now = Date.now(), at = minutes => new Date(now - minutes * 60000).toISOString(), ELU = 'e'.repeat(64), home = '2'.repeat(16);
  const session = (n, minutes, extra = {}) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, ref: `${home}:${n}`, project: home, title: `Session ${n}`, state: 'answered', at: at(minutes), createdAt: at(minutes + 1), approvals: [], by: 'you', who: null, repoId: ELU, ...extra });
  const machines = [{ key: SARA, listedAt: at(0), older: false, projects: [{ id: home, name: 'ELU', repoId: null, home: true }], sessions: [...Array.from({ length: 22 }, (_, n) => session(n + 1, n + 1)), session(99, 0, { archived: true })] }];
  for (const columns of [160, 80]) {
    const p = project(later(t)); environment(t, p.parent);
    // This project is a folder holding a clone of that repository, with none of its own.
    const peer = fakePeer({ items: [], sharing: [SARA], machines }); peer.projectRepoIds = () => [ELU];
    const v = await view(t, { repo: repository(p.root), dashboard: true, peer, columns, rows: 24 }), list = v.panels.projectsList, rows = () => list.items.map(plainItem).map(row => row.trimEnd());
    await send(v, '/projects'); await until(() => v.current.view === 'projects' && /\s22 sessions/.test(rows()[0] ?? ''), `the row counts them at ${columns}`);
    assert.equal(rows().length, 1, `one row, this computer's project: ${rows().join(' | ')}`);
    assert.ok(rows()[0].length <= list.width - 2, `it fits at ${columns}: ${rows()[0]}`);
    assert.match(rows()[0], columns === 160 ? /^● sample app\s+\S.*\s22 sessions · 22 on @sara-box {2}1m ago$/ : /^● sample app\s+\S.*\s22 sessions {2}1m ago$/);
  }
});

// A project in the home folder ("~", the owner's own setup on his other computer) says where its
// sessions run only when the whole row still fits: at 80 columns with a long computer name, the
// last activity was cut off. With exactly enough room it still says where.
test("a project in the home folder says where its sessions run only when the whole row fits, at 160 and at 80 columns", async t => {
  const now = Date.now(), at = minutes => new Date(now - minutes * 60000).toISOString(), ELU = 'e'.repeat(64), home = '2'.repeat(16);
  const session = n => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, ref: `${home}:${n}`, project: home, title: `Session ${n}`, state: 'answered', at: at(n), createdAt: at(n + 1), approvals: [], by: 'you', who: null, repoId: ELU });
  const machines = [{ key: SARA, listedAt: at(0), older: false, projects: [{ id: home, name: 'ELU', repoId: null, home: true }], sessions: Array.from({ length: 22 }, (_, n) => session(n + 1)) }];
  // 160 columns: room for all of it. 80: a name too long to fit beside "~", then one that fits it to the column.
  for (const [cols, box, where] of [[160, 'workstation-west-2-builds', true], [80, 'workstation-west-2-builds', false], [80, 'workstation-west-2', true]]) {
    const p = project(later(t)); environment(t, p.parent);
    const folder = repository(p.root).root, before = process.env.HOME; process.env.HOME = folder;
    owned(t).files.push(() => { if (before === undefined) delete process.env.HOME; else process.env.HOME = before; });
    // This project is the home folder, holding a clone of that repository, with no session of its own.
    const peer = fakePeer({ items: [], sharing: [SARA], machines }); peer.projectRepoIds = () => [ELU];
    const status = peer.peerStatus; peer.peerStatus = (...args) => { const value = status(...args); for (const member of value.teams.flatMap(team => team.members)) if (member.key === SARA) member.box = box; return value; };
    const v = await view(t, { repo: repository(folder), dashboard: true, peer, columns: cols, rows: 24 }), list = v.panels.projectsList, rows = () => list.items.map(plainItem).map(row => row.trimEnd());
    await send(v, '/projects'); await until(() => v.current.view === 'projects' && /\s22 sessions/.test(rows()[0] ?? ''), `the row counts them at ${cols}`);
    assert.equal(rows().length, 1, `one row: ${rows().join(' | ')}`);
    assert.ok(columns(rows()[0]) <= list.width - 2, `it fits at ${cols} with @${box}: ${rows()[0]}`);
    assert.match(rows()[0], where ? new RegExp(`^● sample app\\s+~\\s+22 sessions · 22 on @${box} {2}1m ago$`) : /^● sample app\s+~\s+22 sessions {2}1m ago$/, `at ${cols} with @${box}`);
  }
});

// The other side of it: the project my other computer shares is the one here, so Projects has
// one row for it: by its repository, which a project here holds, else by its name. A teammate's
// share, and a project of my other computer that is not here, keep their rows.
test("Projects lists a project my other computer shares once when this computer has it, by its repository or its name; a teammate's share and one not here keep their rows", async t => {
  const at = minutes => new Date(Date.now() - minutes * 60000).toISOString(), WEB = '7'.repeat(64), NOTES = '6'.repeat(64);
  const machines = [{ key: SARA, listedAt: at(0), older: false, projects: [{ id: '1'.repeat(16), name: 'ELU', repoId: null, home: false }, { id: '2'.repeat(16), name: 'website', repoId: WEB, home: false }, { id: '3'.repeat(16), name: 'notes', repoId: NOTES, home: false }], sessions: [] }];
  const p = project(later(t)); environment(t, p.parent); nameProject(repository(p.root), 'ELU');
  const share = (id, name, repoId, sharer = { mine: true }) => sharedRow({ id, name, handle: name.toLowerCase(), repoId, address: null }, { handle: name.toLowerCase(), title: name, ...sharer });
  const peer = sharing(fakePeer({ items: [], sharing: [SARA], machines }), [share(`${SARA.slice(0, 16)}-elu`, 'ELU', null), share(WEB, 'website', WEB), share(NOTES, 'notes', NOTES), share(`${LI.slice(0, 16)}-elu`, 'ELU', null, { key: LI, name: 'li', box: 'li-box', online: false })]);
  // The project here is a folder that also holds a clone of the website.
  peer.projectRepoIds = () => [WEB];
  const v = await view(t, { repo: repository(p.root), dashboard: true, peer }), list = v.panels.projectsList, rows = () => list.items.map(plainItem).map(row => row.trimEnd());
  await send(v, '/projects'); await until(() => v.current.view === 'projects' && rows().some(row => /notes\s+shared by you {3}on @sara-box\s+online$/.test(row)), 'the project of my other computer that is not here');
  assert.match(rows()[0], /^● ELU\s/);
  assert.ok(!rows().some(row => /(ELU|website)\s+shared by you/.test(row)), `never a second row for a project here: ${rows().join(' | ')}`);
  assert.ok(rows().some(row => /ELU\s+shared by @li {3}on @li-box\s+offline$/.test(row)), `a teammate's share stays: ${rows().join(' | ')}`);
  assert.equal(rows().length, 3, rows().join(' | '));
});

test('/join names the project the team shares once it is in Projects', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = sharing(fakePeer({ joined: { id: 'team-2', name: 'ELU', inviter: { name: 'sara', fingerprint: 'bbbbbbbb' } } }), []), v = await view(t, { repo: repository(p.root), peer }), status = () => v.panels.status.getText();
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => /Joined ELU with sara\. Their messages start sessions here, as if you typed them\./.test(status()), 'joined');
  // What the inviter shares arrives a moment later; a project of another team is not named.
  peer.shared = [sharedRow({ id: '7'.repeat(64), name: 'Other' }), sharedRow({ name: 'ELU', teams: [{ id: 'team-2', name: 'ELU' }] })];
  await until(() => /Joined ELU with sara\. Its project ELU is in Projects\. Their messages start sessions here, as if you typed them\./.test(status()), 'the line names it');
  await send(v, '/projects'); await until(() => v.current.view === 'projects' && v.panels.projectsList.items.some(item => /ELU\s+shared by @sara {3}on @sara-box/.test(plainItem(item))), 'and it is there');
});

// At 80 columns the status line cut what /peers and a join say: beside the session list it kept
// two rows of it, and in Chats one. It now takes as many rows as the line needs.
test('at 80x24 /peers and the line of a join that names the shared project show whole, beside the session list and in Chats', { timeout: 30000 }, async t => {
  const p = project(later(t)); environment(t, p.parent);
  // A team name long enough that the join's line is as long as the one a join gives when it also closes an own team of one.
  const TEAM = 'The payments and platform guild, north', SHARED_NAME = 'checkout-service';
  const peer = sharing(fakePeer({ joined: { id: 'team-2', name: TEAM, inviter: { name: 'sara', fingerprint: 'bbbbbbbb' } } }), []), v = await view(t, { columns: 80, rows: 24, repo: repository(p.root), peer });
  const status = v.panels.status, drawn = () => status.getScreenLines().map(row => row.trimEnd()), whole = () => drawn().map((row, at) => at ? row.replace(/^ {2}/, '') : row.replace(/^› /, '')).join(' ');
  const statusTop = 24 - 1 - 6 - 1, fits = name => { assert.ok(drawn().every(row => row.length < status.width), `${name}: every row fits`); assert.equal(status.atop + status.height - 1, statusTop, `${name}: it ends over the box`); };
  // Two teammates online with long names: the line is longer than the two rows beside the list.
  const members = peer.peerStatus().teams[0].members; peer.peerStatus = () => ({ running: true, pid: 1, key: members[0].key, name: 'ana', fingerprint: 'aaaaaaaa', error: null, counters: { direct: 1, relayed: 1, failed: 0 }, teams: [{ id: 'team-1', name: 'Core', role: 'admin', members: [members[0], { ...members[1], name: 'sara-of-the-platform-team' }, { ...members[2], name: 'li-on-the-night-shift', online: true, path: 'relayed' }], channels: [] }] });
  // The teammate whose connection another computer passes along is said as the Team list says it.
  const PEERS = '2 of 2 teammates online: @sara-of-the-platform-team (direct), @li-on-the-night-shift (through another computer)';
  await send(v, '/peers'); await until(() => whole() === PEERS, `beside the list: ${drawn().join(' | ')}`);
  assert.ok(v.current.view === 'tasks' && drawn().length >= 3 && status.width < 50, 'on three rows or more beside the list'); fits('/peers beside the list');
  assert.ok(v.panels.compose.atop + v.panels.compose.height <= status.atop, 'the form above ends over it');
  await send(v, '/chats'); await until(() => v.current.view === 'chats', 'Chats');
  await send(v, '/peers'); await until(() => whole() === PEERS, `in Chats: ${drawn().join(' | ')}`);
  assert.equal(drawn().length, 2, 'two rows across the screen'); fits('/peers in Chats');
  assert.ok(v.panels.teamBoxes.every(box => box.atop + box.height <= status.atop), 'the panes of Chats end over it');
  // A join, then the project its team shares: the line that names it is whole too, on three rows.
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => whole() === `Joined ${TEAM} with sara. Their messages start sessions here, as if you typed them.`, 'joined');
  peer.shared = [sharedRow({ name: SHARED_NAME, teams: [{ id: 'team-2', name: TEAM }] })];
  const JOINED = `Joined ${TEAM} with sara. Its project ${SHARED_NAME} is in Projects. Their messages start sessions here, as if you typed them.`;
  await until(() => whole() === JOINED, `the join's line in Chats: ${drawn().join(' | ')}`); fits('the join in Chats');
  assert.ok(JOINED.length > 150 && drawn().length === 3, 'three rows at 80 columns');
  assert.ok(v.panels.teamBoxes.every(box => box.atop + box.height <= status.atop), 'the panes of Chats end over the three rows');
});

// A teammate's request under the cursor in Sessions: the pane beside the list names its keys.
// At 80 columns that bar was too long, and what it left out was the page keys.
test('at 80 columns the keys of a teammate\'s card in the pane beside the list end at the page keys', { timeout: 30000 }, async t => {
  const p = project(later(t)); environment(t, p.parent);
  const v = await view(t, { columns: 80, rows: 24, repo: repository(p.root), peer: fakePeer() }), board = v.panels.board, bar = () => v.panels.keys.getText().trim();
  await until(() => board.items.some(item => /reply to @sara/.test(plainItem(item))), 'the reply that waits to be sent');
  board.focus(); selectRow(board, /reply to @sara/); await until(() => /^y send {2}n discard/.test(bar()), 'its keys in the list');
  v.panels.chat.focus();
  await until(() => bar() === 'y send  n discard  c discard  letter ⏎  ↑↓ scroll  esc back  pgup pgdn page', 'the pane\'s keys at 80');
  assert.ok(bar().length <= v.panels.keys.width);
});

// The wheel at a pane, as SGR reports in one read: up or down, a step each.
const wheelAt = (v, widget, step, times = 1) => v.input.write(`\x1b[<${step < 0 ? 64 : 65};${widget.aleft + 3};${widget.atop + 3}M`.repeat(times));
const pause = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));

test('a session on my other computer stays where the owner scrolled it through every draw and every update, stays at the top, and follows its end again once he is back there', { timeout: 30000 }, async t => {
  const at = new Date().toISOString(), said = n => Array.from({ length: n }, (_, index) => ({ role: index % 2 ? 'Claude' : 'You', at, text: `Line ${index + 1} of the long chat`, ...(index % 2 ? { lead: true } : {}) }));
  const remote = [{ id: '33333333-3333-4333-8333-333333333333', machine: SARA, createdAt: at, lastAt: at, title: 'Read the long chat', state: 'answered', steps: [], approvals: [], entries: said(60) },
    { id: '44444444-4444-4444-8444-444444444444', machine: SARA, createdAt: at, lastAt: at, title: 'A short one', state: 'answered', steps: [], approvals: [], entries: said(2) }];
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], sharing: [SARA], remote }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, chat = v.panels.chat, ask = v.panels.ask;
  await until(() => board.items.some(item => /Read the long chat/.test(plainItem(item))), 'the remote row');
  board.focus(); selectRow(board, /Read the long chat/);
  await until(() => /Runs on @sara-box/.test(chat.getContent()) && chat.getScrollPerc(true) === 100, 'its chat, at the end');
  // The owner's cursor stays in the message box while he scrolls the chat with the trackpad.
  ask.focus(); await until(() => /Message Claude on @sara-box/.test(ask._label.getText()), 'the message box names it');
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

test('a session on my other computer keeps the lines the owner reads while its oldest entries leave the top and new ones land above its Task and its steps', { timeout: 30000 }, async t => {
  // The viewer keeps the last 200 entries of a session; this one has said more than that.
  const KEPT = 200, at = new Date().toISOString(), entry = n => ({ role: n % 2 ? 'Claude' : 'You', at, text: `Line ${n} of the long chat`, ...(n % 2 ? { lead: true } : {}) });
  const upTo = n => Array.from({ length: n }, (_, index) => entry(index + 1)).slice(-KEPT);
  const patch = ['diff --git a/src/totals.mjs b/src/totals.mjs', '--- a/src/totals.mjs', '+++ b/src/totals.mjs', '@@ -1,0 +1,40 @@', ...Array.from({ length: 40 }, (_, index) => `+changed line ${index + 1}`)].join('\n'), subtasks = Array.from({ length: 30 }, (_, index) => ({ text: `Step ${index + 1} of the plan`, state: index ? 'todo' : 'doing' }));
  const session = { id: '55555555-5555-4555-8555-555555555555', machine: SARA, createdAt: at, lastAt: at, title: 'Read the long chat', state: 'running', approvals: [], entries: upTo(230),
    steps: [{ at, text: 'Reading the cart' }], diff: { summary: '1 file changed', patch }, plan: { title: 'Fix the totals', goal: 'Totals add up', priority: 'P2', severity: 'S3', state: 'approved', objectives: ['Totals add up'], subtasks, met: [] } };
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], sharing: [SARA], remote: [session] }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
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
  // Reading the first line of its Task: an entry lands above it, two leave the top, a step and a subtask move on.
  assert.equal(lineOf('+changed line 20'), -1, 'the chat never holds the changes'); assert.ok(!(chat._clines ?? []).some(line => /Changes · /.test(bare(line))), 'nor a line that counts them');
  await scrollTo('Task · approved · 0 of 30 subtasks done');
  await more([...upTo(230), { role: 'Claude', at, text: 'A longer answer\nthat takes\nfour lines\nof the pane', lead: true }, entry(231)].slice(-KEPT),
    { steps: [...session.steps, { at, text: 'Running the tests' }], plan: { ...session.plan, subtasks: subtasks.map((step, index) => ({ ...step, state: index ? index === 1 ? 'doing' : 'todo' : 'done' })) } });
  assert.equal(top(), 'Task · approved · 1 of 30 subtasks done', 'the line stays where he reads it');
  // Reading the chat: the oldest entries leave the top as new ones arrive.
  await scrollTo('Line 150 of the long chat');
  await more([...session.entries, ...Array.from({ length: 12 }, (_, index) => entry(232 + index))].slice(-KEPT));
  assert.equal(top(), 'Line 150 of the long chat', 'the entry he reads stays at the top of the pane');
  await pause(300);
  assert.equal(top(), 'Line 150 of the long chat', 'and through every draw after');
  // Reading an entry when the Task above the steps changes and the work ends: the entry stays.
  await scrollTo('Line 243 of the long chat');
  await more([...session.entries, entry(244)].slice(-KEPT), { state: 'answered', plan: { ...session.plan, subtasks: subtasks.map(step => ({ ...step, state: 'done' })) } });
  assert.equal(top(), 'Line 243 of the long chat', 'the entry he reads stays, whatever changed under it');
  // At the top it stays at the top while the first entry there leaves.
  wheelAt(v, chat, -1, 2000); await until(() => chat.childBase === 0, 'the top');
  await more([...session.entries, entry(245), entry(246)].slice(-KEPT));
  assert.equal(chat.childBase, 0, 'at the top it stays at the top');
  // Back at the end, it follows the newest line again.
  wheelAt(v, chat, 1, 2000); await until(() => chat.getScrollPerc(true) === 100, 'the end');
  await more([...session.entries, entry(247)].slice(-KEPT));
  assert.equal(chat.getScrollPerc(true), 100, 'it follows the newest line');
});

// PgUp and PgDn as a terminal sends them, and a click at a place in a widget.
const PGUP = '\x1b[5~', PGDN = '\x1b[6~';
const clickAt = (v, widget, dx = 4, dy = 2) => v.input.write(`\x1b[<0;${widget.aleft + dx + 1};${widget.atop + dy + 1}M\x1b[<0;${widget.aleft + dx + 1};${widget.atop + dy + 1}m`);
const resizeTo = async (v, columns, rows) => { v.output.columns = columns; v.output.rows = rows; v.output.emit('resize'); await until(() => v.current.screen.width === columns && v.current.screen.height === rows, `${columns}x${rows}`); };

test('PgUp and PgDn page a session on my other computer, from the message box and in its chat, at 80x24 and at 140x50, and the key bar names them there', { timeout: 60000 }, async t => {
  const at = new Date().toISOString(), said = n => Array.from({ length: n }, (_, index) => ({ role: index % 2 ? 'Claude' : 'You', at, text: `Line ${index + 1} of the long chat`, ...(index % 2 ? { lead: true } : {}) }));
  const remote = [{ id: '33333333-3333-4333-8333-333333333333', machine: SARA, createdAt: at, lastAt: at, title: 'Read the long chat', state: 'answered', steps: [], approvals: [], entries: said(120) },
    { id: '44444444-4444-4444-8444-444444444444', machine: SARA, createdAt: at, lastAt: at, title: 'A short one', state: 'answered', steps: [], approvals: [], entries: said(1) }];
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], sharing: [SARA], remote }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, chat = v.panels.chat, ask = v.panels.ask, keys = () => v.panels.keys.getText().trim(), page = () => chat.height - chat.iheight - 1;
  const box = async () => { ask.focus(); ask.readInput(); await until(() => ask.__listener && /Message (Claude|the session) on @sara-box/.test(ask._label.getText()), 'the message box over the session there'); };
  await until(() => board.items.some(item => /Read the long chat/.test(plainItem(item))), 'the remote rows');
  // A chat that fits its pane: the bar is as it was.
  board.focus(); selectRow(board, /A short one/); await until(() => /Line 1 of the long chat/.test(chat.getContent()) && !/Line 2 of/.test(chat.getContent()), 'the short chat');
  await box(); await until(() => /^@here asks your agent here {2}ctrl\+t Task {2}esc sessions$/.test(keys()), 'the keys over a short chat: the empty box names no Enter');
  board.focus(); selectRow(board, /Read the long chat/); await until(() => /Line 120 of the long chat/.test(chat.getContent()), 'the long chat');
  for (const [columns, rows] of [[80, 24], [140, 50]]) {
    await resizeTo(v, columns, rows); await box();
    // To the end first: a size change keeps the place the chat was at.
    for (let presses = 0; chat.getScrollPerc(true) !== 100 && presses < 200; presses++) { v.input.write(PGDN); await pause(30); }
    await until(() => chat.getScrollPerc(true) === 100, `the chat there at its end, ${columns}x${rows}`);
    const end = chat.childBase; assert.ok(end > 2 * page(), 'more than two pages');
    // More chat than the pane shows: the bar names the keys, before Esc.
    // Empty, the box names no Enter, and the whole bar fits at 80 columns too.
    await until(() => /^@here asks your agent here {2}pgup pgdn page {2}ctrl\+t Task {2}esc sessions$/.test(keys()), `the keys over a long chat, ${columns}x${rows}`).catch(error => { throw new Error(`${error.message}: ${keys()}`); });
    // From the message box: the chat moves a page, the text and the focus stay.
    ask.setValue('half a thought'); v.input.write(PGUP);
    await until(() => chat.childBase === end - page(), `a page up from the box, ${columns}x${rows}`); await pause(200);
    assert.equal(chat.childBase, end - page(), 'the draws keep the page'); assert.equal(ask.getValue(), 'half a thought'); assert.equal(v.current.screen.focused, ask);
    v.input.write(PGUP); await until(() => chat.childBase === end - 2 * page(), `another page up, ${columns}x${rows}`);
    v.input.write(PGDN); await until(() => chat.childBase === end - page(), `a page down from the box, ${columns}x${rows}`);
    // With text that goes there, Enter names where it sends. Narrow, @here's hint is said in fewer
    // words, so Ctrl+T for the Task in its header still shows.
    await until(() => (columns < 100 ? /^enter send to @sara-box {2}@here your agent here {2}pgup pgdn page {2}ctrl\+t Task$/ : /^enter send to @sara-box {2}@here asks your agent here {2}pgup pgdn page {2}ctrl\+t Task {2}esc sessions$/).test(keys()), `the keys with text over a long chat, ${columns}x${rows}`).catch(error => { throw new Error(`${error.message}: ${keys()}`); });
    // Written to my agent here by its name, the bar still names them.
    ask.setValue('@here and then'); v.input.write(' ');
    await until(() => /^enter send to your agent here {2}pgup pgdn page {2}ctrl\+t Task {2}esc sessions$/.test(keys()), `the keys when it is sent to my agent here, ${columns}x${rows}`);
    assert.equal(chat.childBase, end - page(), 'typing keeps the page');
    ask.clearValue(); ask.cancel();
    // A click on its chat gives it the keys: the same page each way.
    clickAt(v, chat); await until(() => v.current.screen.focused === chat, `the chat there has the focus, ${columns}x${rows}`);
    await until(() => /↑↓ scroll {2}esc sessions\b.* {2}pgup pgdn page$/.test(keys()), `the keys in the chat there, ${columns}x${rows}`);
    assert.equal(chat.childBase, end - page(), 'the click keeps the page');
    v.input.write(PGUP); await until(() => chat.childBase === end - 2 * page(), `a page up in the chat there, ${columns}x${rows}`);
    v.input.write(PGDN); v.input.write(PGDN); await until(() => chat.childBase === end && chat.getScrollPerc(true) === 100, `two pages down reach the end, ${columns}x${rows}`);
  }
});

test("PgUp and PgDn page a teammate's message beside the Sessions list, from the message box and in the card, where it is taller than its pane", { timeout: 60000 }, async t => {
  // A row's card holds the first 400 characters of the message: taller than the pane at 80x24, and all of it shows at 140x50.
  const words = Array.from({ length: 80 }, (_, index) => `word${index + 1}`).join(' ');
  const peer = fakePeer({ items: [{ id: 'incoming-9', kind: 'incoming', peer: SARA, name: 'sara', project: 'web', text: words, at: ago(1), state: 'submitted', threadId: 'th-long' }] });
  const p = project(later(t)); environment(t, p.parent);
  const v = await view(t, { repo: repository(p.root), dashboard: true, peer, columns: 80, rows: 24 });
  const board = v.panels.board, chat = v.panels.chat, ask = v.panels.ask, keys = () => v.panels.keys.getText().trim(), page = () => chat.height - chat.iheight - 1;
  await until(() => board.items.some(item => /@sara question/.test(plainItem(item))), 'the row of the question');
  board.focus(); selectRow(board, /@sara question/);
  await until(() => /word1 /.test(chat.getText()) && /y accept · n decline/.test(chat.getText()) && chat.getScrollPerc(true) === 100, 'the card, at its end');
  const end = chat.childBase; assert.ok(end > 0 && end < page(), 'taller than its pane, by less than a page');
  // From the message box, which starts a new session here: the card moves, the text stays.
  ask.focus(); ask.readInput(); await until(() => ask.__listener && /^enter new session {2}pgup pgdn page/.test(keys()), 'the keys from the box');
  ask.setValue('half a thought'); v.input.write(PGUP);
  await until(() => chat.childBase === 0, 'a page up from the box shows its top'); await pause(200);
  assert.equal(chat.childBase, 0, 'the draws keep the place'); assert.equal(ask.getValue(), 'half a thought'); assert.equal(v.current.screen.focused, ask);
  v.input.write(PGDN); await until(() => chat.childBase === end, 'a page down from the box shows its end');
  ask.clearValue(); ask.cancel();
  // A click on the card gives it the keys.
  clickAt(v, chat); await until(() => v.current.screen.focused === chat, 'the card has the focus');
  await until(() => /^y accept {2}n decline {2}c decline\b.*↑↓ scroll {2}esc (?:sessions|back) {2}pgup pgdn page$/.test(keys()), 'the keys in the card, to the page keys');
  v.input.write(PGUP); await until(() => chat.childBase === 0, 'a page up in the card');
  v.input.write(PGDN); await until(() => chat.childBase === end, 'a page down in the card');
  // Where all of it shows, there is nothing to page and the bar does not offer it.
  await resizeTo(v, 140, 50);
  ask.focus(); ask.readInput(); await until(() => ask.__listener && /^enter new session/.test(keys()), 'the message box at 140x50');
  await until(() => chat._clines.length <= chat.height - chat.iheight, 'all of the card shows');
  assert.doesNotMatch(keys(), /pgup/);
  v.input.write(PGUP); await pause(150); assert.equal(chat.childBase, 0);
});

test("PgUp and PgDn page a teammate's thread in its dialog a page at a time, as they page a chat, opened from Sessions and from Chats, at 80x24 and at 140x50", { timeout: 60000 }, async t => {
  const talk = Array.from({ length: 70 }, (_, index) => ({ from: index % 2 ? 'me' : 'peer', peer: SARA, name: 'sara', kind: index % 2 ? 'answer' : 'ask', text: `Thread line ${index + 1}`, at: ago(100 - index) }));
  const peer = fakePeer({ items: [{ id: 'incoming-9', kind: 'incoming', peer: SARA, name: 'sara', project: 'web', text: 'Thread line 1', at: ago(1), state: 'submitted', threadId: 'th-long' }] });
  peer.threadMessages = id => id === 'th-long' ? talk : [];
  const p = project(later(t)); environment(t, p.parent);
  const v = await view(t, { repo: repository(p.root), dashboard: true, peer, columns: 80, rows: 24 });
  const board = v.panels.board, [, threads] = v.panels.teamLists, title = 'Thread with @sara';
  const body = () => modal(v, title).children.find(child => child.options?.scrollable), field = () => modal(v, title).children.find(child => child.type === 'textbox');
  // In the open dialog: a page is its text's height less one line, so the last line of a page is the first of the next.
  const pages = async where => {
    await until(() => modal(v, title) && /Thread line 1\b/.test(body().getText()) && field().__listener, `the thread, ${where}`);
    const text = body(), page = text.height - text.iheight - 1;
    assert.equal(text.childBase, 0, 'it opens at its first message'); assert.ok(text.getScrollHeight() > 3 * text.height, 'more than three pages');
    assert.match(field()._label.getText(), /Press y, w, n or Enter \/ Esc cancels \/ PgUp PgDn page/);
    // Its keys, with the page keys where they fit.
    await until(() => /^y start it {2}w pick the mode {2}n decline {2}enter start it {2}esc cancel(?: {2}pgup pgdn page)?$/.test(v.panels.keys.getText().trim()), `the keys of the thread, ${where}`);
    v.input.write(PGDN); await until(() => text.childBase === page, `a page down, ${where}`);
    v.input.write(PGDN); await until(() => text.childBase === 2 * page, `another page down, ${where}`);
    v.input.write(PGUP); await until(() => text.childBase === page, `a page up, ${where}`);
    v.input.write(PGUP); await until(() => text.childBase === 0, `back at its first message, ${where}`);
    // The letter Enter would send is still the field's text, and nothing was decided.
    assert.equal(field().value, 'y'); assert.ok(modal(v, title), 'the dialog stays open');
    await closeDialog(v, title);
    assert.deepEqual(peer.sent(), [], 'nothing was sent');
  };
  for (const [columns, rows] of [[80, 24], [140, 50]]) {
    await resizeTo(v, columns, rows);
    // From Sessions: Enter on its row.
    await send(v, '/sessions'); await until(() => v.current.view === 'tasks' && board.items.some(item => /@sara question/.test(plainItem(item))), 'Sessions');
    board.focus(); selectRow(board, /@sara question/); await until(() => /enter read/.test(v.panels.keys.getText()), 'its row'); v.input.write('\r');
    await pages(`from Sessions, ${columns}x${rows}`);
    // From Chats: Enter on its thread.
    await send(v, '/chats'); await until(() => v.current.view === 'chats' && threads.items.some(item => /asks you/.test(plainItem(item))), 'Chats');
    threads.focus(); selectRow(threads, /asks you/); v.input.write('\r');
    await pages(`from Chats, ${columns}x${rows}`);
  }
});

test("in Chats PgUp and PgDn move a page in the open one's threads, in the threads and from the message box, at 80x24 and at 140x50", { timeout: 60000 }, async t => {
  const items = Array.from({ length: 120 }, (_, index) => ({ id: `answer-${index + 1}`, kind: 'answer', peer: SARA, name: 'sara', project: 'web', text: `Answer number ${index + 1}`, at: ago(index + 1), state: 'completed', threadId: `th-${index + 1}` }));
  const { v, peer } = await teamView(t, { peer: fakePeer({ items }), columns: 80, rows: 24 }), [, threads] = v.panels.teamLists, ask = v.panels.ask;
  await openRow(v, /sara/, '@sara');
  for (const [columns, rows] of [[80, 24], [140, 50]]) {
    await resizeTo(v, columns, rows);
    await until(() => threads.items.length > 3 * threads.height, `more than three pages of threads, ${columns}x${rows}`);
    const page = () => threads.height - threads.iheight - 1, last = threads.items.length - 1;
    threads.select(0);
    // From the message box: the threads move a page, the text and the focus stay.
    ask.focus(); ask.readInput(); await until(() => ask.__listener, 'the message box');
    // More threads than their pane shows: the bar names the keys after Enter, as over a session's chat.
    await until(() => /^pgup pgdn page {2}@name one \w+ {2}\/ commands/.test(v.panels.keys.getText().trim()), `the keys over the empty message box, ${columns}x${rows}`);
    ask.setValue('half a thought'); v.input.write(PGDN);
    await until(() => /^enter send {2}pgup pgdn page {2}@name one \w+ {2}\/ commands/.test(v.panels.keys.getText().trim()), `the keys with text in the box, ${columns}x${rows}`);
    await until(() => threads.selected === page(), `a page down from the box, ${columns}x${rows}`); await pause(200);
    assert.equal(threads.selected, page(), 'the draws keep the place'); assert.equal(ask.getValue(), 'half a thought'); assert.equal(v.current.screen.focused, ask);
    v.input.write(PGDN); await until(() => threads.selected === 2 * page(), `another page down, ${columns}x${rows}`);
    assert.equal(threads.childBase, page(), 'the list moves with its cursor: the last row of one page is the first of the next');
    v.input.write(PGUP); await until(() => threads.selected === page(), `a page up from the box, ${columns}x${rows}`);
    ask.clearValue(); ask.cancel();
    // In the threads themselves, to both ends.
    threads.focus(); await until(() => v.current.screen.focused === threads, 'the threads');
    await until(() => /^y accept\/send {2}n decline {2}c continue {2}enter read {2}pgup pgdn page$/.test(v.panels.keys.getText().trim()), `the keys in the threads, ${columns}x${rows}`);
    v.input.write(PGUP); await until(() => threads.selected === 0, `a page up in the threads, ${columns}x${rows}`);
    v.input.write(PGUP); await pause(100); assert.equal(threads.selected, 0, 'it stops at the first row');
    v.input.write(PGDN); await until(() => threads.selected === page(), `a page down in the threads, ${columns}x${rows}`);
    threads.select(last - 1); v.input.write(PGDN); await until(() => threads.selected === last, `it stops at the last row, ${columns}x${rows}`);
    assert.equal(v.panels.teamBoxes[1]._label.getText().trim(), '@sara', 'the same chat is open');
  }
  // A chat whose threads all show has nothing to page: both bars are as they were.
  await openRow(v, /# general/, '#general');
  await until(() => threads.items.length <= threads.height - threads.iheight, 'all the threads of #general show');
  ask.focus(); ask.readInput(); await until(() => ask.__listener && /^@name one \w+ {2}\/ commands/.test(v.panels.keys.getText().trim()), 'the keys over the empty message box of a short chat');
  // #general has no thread yet: nothing to read or answer there.
  ask.cancel(); threads.focus(); await until(() => v.panels.keys.getText().trim() === 'tab next', `the keys in the threads of a short chat, not ${v.panels.keys.getText().trim()}`);
  assert.deepEqual(peer.sent(), [], 'nothing was sent');
});

test('a session on my other computer shows every line of its changes, and its earlier messages load as the owner pages up to the oldest one here', { timeout: 30000 }, async t => {
  const began = Date.now() - 400 * 60000, at = n => new Date(began + n * 60000).toISOString(), entry = n => ({ n, role: n % 2 ? 'Claude' : 'You', at: at(n), text: `Line ${n} of the long chat`, ...(n % 2 ? { lead: true } : {}) });
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => entry(from + index));
  const patch = ['diff --git a/notes.txt b/notes.txt', '--- a/notes.txt', '+++ b/notes.txt', '@@ -1,0 +1,300 @@', ...Array.from({ length: 300 }, (_, index) => `+changed line ${index + 1}`)].join('\n');
  const session = { id: '66666666-6666-4666-8666-666666666666', machine: SARA, createdAt: at(0), lastAt: at(300), title: 'Read the long chat', state: 'answered', approvals: [], entries: range(221, 300), steps: [], diff: { summary: '1 file changed', patch }, plan: null };
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], sharing: [SARA], remote: [session] }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, chat = v.panels.chat, ask = v.panels.ask;
  const bare = line => (line ?? '').replace(/\x1b\[[\d;]*m/g, '').replace(/^\s*┃/, '').trim();
  const asked = () => peer.sent().filter(command => command.type === 'remoteOlder');
  await until(() => board.items.some(item => /Read the long chat/.test(plainItem(item))), 'the remote row');
  board.focus(); selectRow(board, /Read the long chat/);
  await until(() => /Runs on @sara-box/.test(chat.getContent()) && chat.getScrollPerc(true) === 100, 'its chat, at the end');
  ask.focus();
  // Every line of its changes: ELU 0.1.19 showed the first 120 and three dots in the chat. The
  // chat holds none of them now, nor a line that counts them: the name of its Changes tab does, and the tab holds every one (read at the end).
  assert.doesNotMatch(chat.getContent().replace(/\x1b\[[\d;]*m/g, ''), /Changes · |d opens them|changed line \d/); assert.equal(v.panels.sessionTabs.getText().trim(), 'Chat   Changes 1');
  // The line over its oldest entry here counts the ones before it, and says how to get them.
  assert.match(chat.getContent(), /220 earlier messages are on @sara-box\. Page up to load them\./);
  await pause(300);
  assert.deepEqual(asked(), [], 'nothing is asked for while he reads the end');
  // Paged up to the top: they are asked for once, and the line says they are loading.
  wheelAt(v, chat, -1, 3000); await until(() => chat.childBase === 0, 'the top');
  await until(() => asked().length === 1, 'the earlier messages asked for');
  assert.equal(asked()[0].id, session.id);
  await until(() => /Loading earlier messages from @sara-box… 220 more are there\./.test(chat.getContent()), 'the line says they are loading');
  await pause(400);
  assert.equal(asked().length, 1, 'asked once while they load');
  // They arrive above the oldest one he had: he stays on that one, and they are a page up.
  Object.assign(session, { entries: range(141, 300) });
  await until(() => chat.getContent().includes('Line 141 of the long chat'), 'the earlier messages');
  await until(() => /140 earlier messages are on @sara-box\. Page up to load them\./.test(chat.getContent()), 'the count of what is left');
  await pause(200);
  const lines = chat._clines.map(bare), top = chat.childBase;
  assert.ok(top > 0, 'not thrown to the top');
  assert.ok(lines.indexOf('Line 221 of the long chat') - top >= 0 && lines.indexOf('Line 221 of the long chat') - top <= 2, 'the oldest entry he had is at the top of the pane');
  assert.equal(asked().length, 1, 'the next page is not asked for until he pages up to it');
  // Paging up again reaches the top again and asks for the next page, down to the first entry.
  wheelAt(v, chat, -1, 3000); await until(() => asked().length === 2, 'the next page asked for');
  Object.assign(session, { entries: range(1, 300) });
  await until(() => chat.getContent().includes('Line 1 of the long chat') && !/earlier message/.test(chat.getContent()), 'the first entry, and no line over it');
  wheelAt(v, chat, -1, 3000); await until(() => chat.childBase === 0, 'the top'); await pause(400);
  assert.equal(asked().length, 2, 'nothing more to ask for at the first entry');
  // Its Changes tab holds every line of its changes, to the last one.
  const changes = v.panels.changes;
  board.focus(); v.input.write('d'); await until(() => v.current.sessionView === 'changes' && /1 file changed · \+300 −0/.test(changes.getText()), 'its Changes');
  v.input.write('\x1b[F'); await until(() => /300 \+ changed line 300/.test(changes.getText()), 'the last line of its changes');
  assert.doesNotMatch(changes.getText(), /not shown|more character|not read/);
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

// One person's computers go by one name: each of those goes by its computer name in a channel,
// as on its Direct messages row, so none reads as another; a teammate's own name stays.
test('a channel names each computer that goes by the same person name as another by its computer name', () => {
  const DEVBOX = 'd'.repeat(64), WORKBOX = 'e'.repeat(64);
  const team = { id: 'team-1', name: 'Core', members: [{ key: ME, name: 'ana', box: 'laptop', online: true }, { key: DEVBOX, name: 'ana', box: 'devbox', online: true }, { key: WORKBOX, name: 'ana', box: 'workbox' }, { key: LI, name: 'li', box: 'studio', online: true }], channels: [] };
  const general = chatBar({ status: { key: ME, teams: [team] }, items: [] }, 60, false).find(row => row.value?.type === 'room').value;
  assert.deepEqual(general.people, ['you', '@devbox', '@li', '@workbox']);
  assert.equal(membersLine(general, 76, false), 'In #general · you, @devbox, @li, @workbox · /invite adds a teammate');
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
  assert.deepEqual(lines(bar).slice(4), ['Direct messages', '● @sara-box · sara online', '○ @li offline', '◆ @reviewer', '◆ @reviewer · sara-box', '◆ @docs · @li', '+ Add teammate']);
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
  assert.match(lines(chatBar({ status, items, bots: mine }, 60, false))[5], /^● @sara-box · sara online 1$/);
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
  // This computer's user name was made from an email address whose plain part cannot be told: the field is left for the owner.
  userName(t, 'sam_example_com');
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v); await until(() => modal(v, 'Your name'), 'name prompt');
  const field = modal(v, 'Your name').children.find(child => child.type === 'textbox');
  await until(() => field.__listener, 'name input'); assert.equal(field.getValue(), '', 'no part of an email address is offered');
  field.setValue('ana'); field.submit();
  await until(() => /Joined Docs with sara\./.test(v.panels.status.getText()), 'joined after the name');
  assert.deepEqual(peer.calls.find(row => row[0] === 'identity'), ['identity', 'ana']);
  assert.ok(peer.calls.findIndex(row => row[0] === 'identity') < peer.calls.findIndex(row => row[0] === 'joinTeam'));
  assert.equal(peer.calls.filter(row => row[0] === 'startPeer').length, 0, 'joinTeam starts the daemon; the app asks nothing more');
});

// Before the team list arrives (the daemon has not said yet), Chats has no channel or person
// to write to and no thread to read: its bar names no Enter there, only the commands.
test('Chats with no team listed: neither pane names Enter, since it has nothing to open', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], teamless: true }); peer.onTeam = () => true;
  const v = await view(t, { repo: repository(p.root), peer }), [bar, threads] = v.panels.teamLists, keys = () => v.panels.keys.getText().trim();
  await send(v, '/chats'); await until(() => v.current.view === 'chats' && bar.items.some(item => /No team yet/.test(plainItem(item))), 'Chats with no team');
  bar.focus(); await until(() => v.current.screen.focused === bar && keys() === '/ commands  tab threads', `the bar's keys, not ${keys()}`);
  threads.focus(); await until(() => v.current.screen.focused === threads && keys() === 'tab next', `the threads' keys, not ${keys()}`);
  assert.deepEqual(peer.sent(), [], 'nothing was sent');
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
  // The open project is shared before the code is made, and the code is made for it.
  assert.deepEqual(peer.calls.find(row => row[0] === 'createInvite').slice(1), ['team-1', { hours: 24, root: p.root }]);
  assert.ok(peer.calls.findIndex(row => row[0] === 'share') < peer.calls.findIndex(row => row[0] === 'createInvite'), 'shared before the code');
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
  // This computer's user name was made from an email address (name_gmail_com): only its plain part is offered.
  userName(t, 'ana_gmail_com');
  await send(v, '/invite'); await choose(v, 'Invite', /^Someone new/); await until(() => modal(v, 'Your name'), 'name prompt');
  const field = modal(v, 'Your name').children.find(child => child.type === 'textbox');
  await until(() => field.__listener, 'name input'); assert.equal(field.getValue(), 'ana', 'the plain part, never the address');
  field.submit();
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
  // With status on: a project kept off with /share off is shared again, as whoever joins it sees it.
  assert.deepEqual(peer.calls.filter(row => row[0] === 'share').at(-1).slice(1), [p.root, { teams: ['team-1'], status: true }]);
  const window = modal(v, 'Team invite').children.find(child => child.options?.scrollable).getText();
  assert.match(window, /It shares \S[^]*, the folder \S[^]*sample app: whoever joins with it joins that project\.[^]*Run npx -y @elu-labs\/elu[^]*type \/join and paste this code/); assert.doesNotMatch(window, /fingerprint/i);
  await closeDialog(v, 'Team invite');
  await send(v, '/join nope'); await until(() => /That is not an invite code\. Use \/join code/.test(v.panels.status.getText()), 'join usage');
  assert.equal(peer.calls.some(row => row[0] === 'joinTeam'), false);
  // Joining shares nothing of the joiner's: teammates' messages start sessions in the open project.
  const shares = () => peer.calls.filter(row => row[0] === 'share').length, before = shares();
  await send(v, '/join K7QM X2PD 9FHW'); await answerJoin(v);
  await until(() => /Joined Docs with sara\. Their messages start sessions here, as if you typed them\./.test(v.panels.status.getText()), 'joined');
  assert.deepEqual(peer.calls.find(row => row[0] === 'joinTeam').slice(1, 2), ['k7qm-x2pd-9fhw']);
  assert.equal(shares(), before, 'nothing shared');
  assert.ok(!peer.calls.some(row => row[0] === 'joinedProject'), 'a code made in the first project names none');
  assert.deepEqual(peer.calls.find(row => row[0] === 'saveTeamAccess').slice(1), ['team-2', { handling: 'auto', rules: '', root: p.root }]);
});

test('a code made in another project of the team: /join takes the open project as that one, before what teammates can do here is saved', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const other = 'e'.repeat(16), peer = fakePeer({ joined: { id: 'team-2', name: 'Docs', project: other, inviter: { name: 'sara', fingerprint: 'bbbbbbbb' } } });
  const v = await view(t, { repo: repository(p.root), peer });
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => /Joined Docs with sara./.test(v.panels.status.getText()), 'joined');
  assert.deepEqual(peer.calls.filter(row => row[0] === 'joinedProject').map(row => row.slice(1)), [['team-2', other, p.root, { member: false }]]);
  assert.ok(peer.calls.findIndex(row => row[0] === 'joinedProject') < peer.calls.findIndex(row => row[0] === 'saveTeamAccess'), 'the project first');
  assert.deepEqual(peer.calls.find(row => row[0] === 'saveTeamAccess').slice(1), ['team-2', { handling: 'auto', rules: '', root: p.root }]);
});

test('already on the team, /join with a code made in another project of it takes the open project as that one, and leaves what teammates can do here as it was', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const other = 'e'.repeat(16), peer = fakePeer({ joined: { id: 'team-2', name: 'Docs', project: other, member: true, inviter: { name: 'sara', fingerprint: 'bbbbbbbb' } } });
  const v = await view(t, { repo: repository(p.root), peer });
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => /Joined sara's project in this folder\. You see each other's sessions here now\./.test(v.panels.status.getText()), 'joined');
  assert.deepEqual(peer.calls.filter(row => row[0] === 'joinedProject').map(row => row.slice(1)), [['team-2', other, p.root, { member: true }]]);
  assert.equal(peer.calls.some(row => row[0] === 'saveTeamAccess'), false, 'nothing about what teammates can do here changed');
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

test('the Team list says how a teammate is reached in the room its row has: through which computer, never offline, and why when nothing gets through', () => {
  const team = members => ({ key: ME, teams: [{ id: 'team-1', name: 'Core', members: [{ key: ME, name: 'ana' }, ...members], channels: [] }] });
  const row = (member, width, extra = {}) => visible(chatBar({ status: team([{ key: SARA, name: 'sara', ...member }]), items: [], ...extra }, width, false).find(item => item.value?.type === 'member').line);
  const through = { online: true, path: 'relayed', via: "li's computer" }, blocked = { online: false, reach: 'blocked' };
  // The list beside the chat at 140 columns is 40 wide: the computer it goes through is named whole.
  assert.equal(row(through, 40), "● @sara online · through li's computer");
  assert.equal(row(through, 78), "● @sara          online · through li's computer", 'with room, in the column the other rows use');
  assert.equal(row({ online: true, path: 'direct' }, 40), '● @sara          direct');
  // Offline with why, in the longest words the row has room for; the window of the teammate says it whole.
  assert.equal(row(blocked, 78), '○ @sara          offline · no computer on the team reaches you both');
  assert.equal(row(blocked, 60), '○ @sara offline · no computer on the team reaches you both');
  assert.equal(row(blocked, 50), '○ @sara offline · no computer reaches you both');
  assert.equal(row(blocked, 42), '○ @sara offline · nobody reaches you both');
  assert.equal(row(blocked, 40), '○ @sara offline · no way through');
  assert.equal(row({ online: false }, 40), '○ @sara          offline', 'a teammate whose computer is off is only that');
  // What else the row carries keeps its place.
  assert.equal(row(through, 40, { trusted: [SARA] }), "● @sara through li's computer · trusted", 'too narrow for both: the dot says online');
  assert.equal(row({ ...through, via: "kim's computer" }, 38), "● @sara through kim's computer");
  assert.match(row(through, 28), /^● @sara online · through/); assert.ok(row(through, 28).length <= 28, 'cut to the row, still online');
  assert.equal(row(blocked, 44, { trusted: [SARA] }), '○ @sara offline · no way through · trusted');
  assert.equal(row(blocked, 51, { trusted: [SARA] }), '○ @sara offline · nobody reaches you both · trusted');
});

// The owner's report: at 140 columns a long teammate name cut how they are reached to
// "online ·…". The name gives way first: the reason keeps the room a name of 12 columns
// leaves, in the longest words that fit there, and the name is cut to what is left.
test('a long teammate name gives way to how they are reached: the name is cut, the computer it goes through is named whole', () => {
  const team = (name, member) => ({ key: ME, teams: [{ id: 'team-1', name: 'Core', members: [{ key: ME, name: 'ana' }, { key: SARA, name, ...member }], channels: [] }] });
  const row = (name, member, width, extra = {}) => visible(chatBar({ status: team(name, member), items: [], ...extra }, width, false).find(item => item.value?.type === 'member').line);
  const through = { online: true, path: 'relayed', via: "li's computer" }, blocked = { online: false, reach: 'blocked' };
  // The list beside the chat at 140 columns is 40 wide.
  assert.equal(row('alexandra-whitfield', through, 40), "● @alexandra-whit… through li's computer");
  assert.equal(row('alexandra-whitfield', through, 60), "● @alexandra-whitfield online · through li's computer", 'with room, whole');
  assert.equal(row('alexandra-whitfield', blocked, 40), '○ @alexandra-w… offline · no way through');
  assert.equal(row('alexandra-whitfield', through, 44, { trusted: [SARA] }), "● @alexandr… through li's computer · trusted", 'with less room the name gives more');
  for (const width of [28, 34, 40, 44]) assert.ok(row('alexandra-whitfield', through, width).length <= width, `fits ${width}`);
  // A short name is never cut for it.
  assert.equal(row('sara', through, 40), "● @sara online · through li's computer");
});

test('quitting ELU while /join is still looking ends that join first, as Esc does, and saves nothing', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer(), v = await view(t, { repo: repository(p.root), peer });
  const signals = []; let ended = 0;
  // The join waits until it is told to stop, and then says it was cancelled, as the daemon's does.
  peer.joinTeam = (code, options = {}) => { peer.calls.push(['joinTeam', code]); signals.push(options.signal); return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => setTimeout(() => reject(new Error('Join cancelled. You did not join.')), 50))); };
  peer.endJoins = () => { ended++; };
  await send(v, '/join k7qm-x2pd-9fhw'); await answerJoin(v);
  await until(() => /Looking for the person who invited you…/.test(v.panels.status.getText()), 'the search under way');
  await send(v, '/quit');
  await v.finished;
  assert.equal(ended, 1, 'the join was ended before the app was gone'); assert.equal(signals[0].aborted, true, 'and told to stop');
  assert.deepEqual(peer.calls.filter(row => row[0] === 'saveTeamAccess'), [], 'nothing was saved for a team it did not join');
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
  await until(() => /^› Joined Docs with sara\. Connected through your computer studio\. Their messages start sessions here, as if you typed them\./.test(status()), 'joined, and it says which computer it went through');
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
  // Auto with no project saved starts nothing by itself, and the line says so.
  assert.match(status(), /Core now: Auto, no project saved: messages wait · rules: Be brief\./); assert.equal(list().selected, 0);
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
  assert.match(status(), /Core now: Manual · rules: none/); assert.equal(list().selected, 1);
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

// The owner's devbox: its project is its home folder. /access there offers Auto as anywhere, and
// asks once whether the other computers on the project may work in his home folder without
// asking; only his y saves that (home), and the line says what the setting does until then.
test('/access in a project that is the home folder asks before Auto lets the other computers work there, once; n keeps their work waiting', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const folder = repository(p.root).root, before = process.env.HOME; process.env.HOME = folder;
  owned(t).files.push(() => { if (before === undefined) delete process.env.HOME; else process.env.HOME = before; });
  // As a join in the home folder left it, and as the real setting saves it: the home folder is
  // never saved as the project, and home is kept only with Auto.
  const peer = fakePeer({ access: { 'team-1': { handling: 'auto', rules: '', root: null, at: 'then' } } }), status = () => v.panels.status.getText();
  const save = peer.saveTeamAccess;
  peer.saveTeamAccess = (id, update) => {
    if (update.root && !update.home) throw new Error('Your home folder cannot be the project teammates work in. Open the project\'s own folder.');
    const { root: _root, home, ...rest } = update, kept = { ...peer.access[id] }; delete kept.home; peer.access[id] = kept;
    return save(id, { ...rest, ...(home && rest.handling === 'auto' ? { home: true } : {}) });
  };
  const v = await view(t, { repo: repository(p.root), peer });
  const asked = () => modal(v, 'Home folder')?.children.find(child => child.options?.scrollable).getText();
  const auto = async () => { await send(v, '/access'); await choose(v, 'What teammates can do here', /^Auto/); await closeDialog(v, 'Rules for teammates', ''); };
  await send(v, '/access'); await until(() => modal(v, 'What teammates can do here'), 'the handling');
  assert.match(status(), /Core now: Auto, no project saved: messages wait · rules: none/);
  await choose(v, 'What teammates can do here', /^Auto/); await closeDialog(v, 'Rules for teammates', '');
  await until(() => modal(v, 'Home folder'), 'the question');
  assert.equal(asked(), 'This project is your home folder. Let the other computers on it work here without asking?\n\ny yes · n no');
  // n: saved as before, by hand, and the line says so.
  await closeDialog(v, 'Home folder', 'n');
  await until(() => /Saved for Core/.test(status()), 'saved');
  assert.match(status(), /No project was saved for their sessions: Your home folder cannot be the project teammates work in\. Open the project's own folder\. Until one is, their messages wait for you\./);
  assert.equal(peer.access['team-1'].home, undefined);
  // y: saved with home, and said once.
  await auto(); await closeDialog(v, 'Home folder', 'y');
  await until(() => /Saved for Core: messages start sessions here, as if you typed them in your home folder\.$/.test(status().trim()), 'saved with home');
  assert.deepEqual([peer.access['team-1'].handling, peer.access['team-1'].root, peer.access['team-1'].home], ['auto', null, true]);
  // Allowed already: not asked again.
  await send(v, '/access'); await until(() => modal(v, 'What teammates can do here'), 'the handling again');
  assert.match(status(), /Core now: Auto · rules: none · ~/);
  await choose(v, 'What teammates can do here', /^Auto/); await closeDialog(v, 'Rules for teammates', 'Never print a key.');
  await until(() => /Saved for Core: messages start sessions here, as if you typed them, with your rules in your home folder\./.test(status()), 'saved again');
  assert.equal(modal(v, 'Home folder'), undefined, 'not asked again');
  assert.equal(peer.access['team-1'].home, true);
  // Manual takes it back, and Auto after that asks again.
  await send(v, '/access'); await choose(v, 'What teammates can do here', /^Manual/); await closeDialog(v, 'Rules for teammates', '');
  await until(() => /Saved for Core: messages wait for you to approve them/.test(status()), 'manual');
  assert.equal(peer.access['team-1'].home, undefined);
  await auto(); await until(() => modal(v, 'Home folder'), 'asked again'); await closeDialog(v, 'Home folder', 'n');
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
  await openRow(v, /@sara-box · sara\s+direct/, '@sara');
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

test('the Threads key bar offers c on an answer that waits, and not on a thread the session already continued with', { timeout: 30000 }, async t => {
  const peer = fakePeer({ items: [
    { id: 'answer:r1', kind: 'answer', continued: true, result: true, peer: SARA, name: 'sara', project: null, text: 'Coupon codes are uppercase now.', question: 'Make coupon codes uppercase.', at: ago(2), state: 'answered', threadId: 'th-2' },
    { id: 'answer:r2', kind: 'answer', peer: SARA, name: 'sara', project: null, text: 'In src/cache.js.', question: 'Where is the cache?', at: ago(1), state: 'answered', threadId: 'th-3' },
  ] });
  const { v } = await teamView(t, { peer });
  const [, threads] = v.panels.teamLists, keys = () => v.panels.keys.getText().trim(), status = () => v.panels.status.getText().trim();
  await openRow(v, /@sara-box · sara\s+direct/, '@sara');
  await until(() => threads.items.some(item => /continued in your session/.test(plainItem(item))) && threads.items.some(item => /@sara answered · In src/.test(plainItem(item))), 'both threads');
  // An answer that waits: c continues the chat with it, and the bar says so.
  threads.focus(); selectRow(threads, /@sara answered · In src/);
  await until(() => /^y accept\/send {2}n decline {2}c continue {2}enter read/.test(keys()), 'c on an answer that waits');
  // The one the session already went on with: no c in the bar, and the rest stays.
  selectRow(threads, /continued in your session/);
  await until(() => /^y accept\/send {2}n decline {2}enter read/.test(keys()), 'no c on a continued thread');
  assert.doesNotMatch(keys(), /continue/);
  // The key still answers there, and says why it does nothing.
  v.input.write('c'); await until(() => /Your session already continued with this result\./.test(status()), 'c on a continued thread');
  assert.ok(!peer.sent().some(row => row.type === 'continue'));
  // Back on the waiting answer the bar offers it again, and c continues with it.
  selectRow(threads, /@sara answered · In src/);
  await until(() => /^y accept\/send {2}n decline {2}c continue {2}enter read/.test(keys()), 'c again');
  v.input.write('c'); await until(() => peer.sent().some(row => row.type === 'continue' && row.id === 'answer:r2'), 'c continues the waiting answer');
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
  // Each board goes by its repository, so the title beside Board ▾ names the project.
  assert.ok(v.current.snapshot.name); assert.equal(panels.header.getText().trim(), v.current.snapshot.name);
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

test('a finished session of my other computer or of a teammate, in Done, is never in progress, with no ETA and no met count nobody marked', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const HOME = '0123456789abcdef', peer = fakePeer({ sharing: [SARA], machines: [{ key: SARA, listedAt: ago(0), older: false, projects: [{ id: HOME, name: 'home', repoId: null, home: true }], sessions: [] }], repoId: WEB });
  // A scheduled run there that ended: its Task approved hours ago, overdue, nothing marked met.
  const task = { id: 't-5e1f0a2c', revision: 1, title: 'Nightly dependency check', description: 'Look for outdated packages.', goal: 'Every package is current.', objectives: ['List outdated packages', 'Open one update', 'Say what was skipped'],
    priority: 'high', severity: 'medium', state: 'approved', startedBy: 'schedule', subtasks: [], met: [], proposedAt: ago(400), approvedAt: ago(390), doneAt: null, criteria: [], estimateMinutes: 30 };
  const people = [{ peer: SARA, name: 'sara', box: 'sara-box', online: true, heardAt: ago(0), mine: true, sessions: [teamSession({ id: '0123456789abcdee', title: 'Nightly checks', column: 'done', by: 'ana', own: true, at: ago(5), plan: task.id, task, ref: `${HOME}:6` })] }];
  peer.teammateTasks = () => []; peer.boardKeptOff = () => false;
  peer.teammateSessions = () => ({ repos: [{ repoId: WEB, name: 'acme/web', at: ago(0) }], people });
  const v = await view(t, { repo: repository(p.root), peer }), panels = v.panels, title = 'Your session on sara-box';
  await send(v, '/kanban'); await until(() => v.current.view === 'kanban' && panels.kanbanLists[3].items.length === 1, 'the card under Done');
  panels.kanbanLists[3].focus(); panels.kanbanLists[3].select(0); v.input.write('\r');
  await until(() => rowsOf(v, title).length, 'the card opens');
  const rows = rowsOf(v, title).map(line => line.trimEnd());
  assert.deepEqual(rows.slice(0, 3), ['Nightly dependency check', 'Done · priority high · severity medium', 'you · sara-box']);
  assert.ok(rows.includes('Objectives'), rows.join('\n'));
  assert.doesNotMatch(rows.join('\n'), /in progress|^ETA |overdue|of 3 met|Subtasks · none yet/m);
});

test('a teammate\'s session on my other computer opens with their name, not as mine: its first message, and its Go to session button opens it in Sessions', async t => {
  const p = project(later(t)); environment(t, p.parent);
  const HOME = '0123456789abcdef', listed = { id: '11111111-2222-4333-8444-555555555556', ref: `${HOME}:9`, project: HOME, title: 'Kim asks for a fix', state: 'running', at: ago(0), createdAt: ago(60), approvals: [], by: 'teammate', who: 'kim', repoId: WEB, question: null, error: null, plan: null };
  const peer = fakePeer({ sharing: [SARA], machines: [{ key: SARA, listedAt: ago(0), older: false, projects: [{ id: HOME, name: 'home', repoId: null, home: true }], sessions: [listed] }], repoId: WEB });
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
test('Usage lists the top ten agents by cost with their tokens, t shows the last 7 days, Enter opens a session here or there, and the total names a computer of mine on an older ELU', { timeout: 60000 }, async t => {
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
  const remoteRow = { ref: `${P}:5`, id: RID, agent: 'Opus 5.5', title: 'Remote job', model: 'opus 5.5', tokens: { input: 900, output: 80, cacheRead: 40000, cacheWrite: 0 }, costUsd: 20, partial: false, at: now };
  const machines = [{ key: SARA, listedAt: now, older: false, projects: [{ id: P, name: 'shop', repoId: null, home: false }],
    sessions: [{ id: RID, ref: `${P}:5`, project: P, title: 'Remote job', state: 'answered', at: now, createdAt: now, approvals: [], by: 'you', who: null, repoId: null }],
    topAgents: { today: { costUsd: 20, partial: false, rows: [remoteRow] }, week: { costUsd: 25, partial: false, rows: [{ ...remoteRow, costUsd: 25 }] } } }];
  const peer = fakePeer({ items: [], sharing: [SARA], machines });
  const v = await view(t, { repo: repository(p.root), dashboard: true, peer, usage: { env: { HOME: temp(t) }, vendors: () => [] } });
  const list = v.panels.usageList, rows = () => list.items.map(plainItem);
  // The agents' lines: after the table's header and its rule, before the total under it.
  const agentRows = () => { const after = rows().slice(rows().findIndex(row => /^Session /.test(row)) + 2); return after.slice(0, after.findIndex(row => /^ *(Today|7 days) {2}/.test(row))); };
  const total = text => rows().some(row => row.trim() === text);
  await send(v, '/usage'); await until(() => v.current.view === 'usage' && rows().includes('Top agents today'), 'the section');
  await until(() => agentRows().length === 3, 'three agents today');
  // Most cost first: the session (a bot's name first), the computer, the model, In, Out, Cache,
  // the cost and its share of today's total. The Codex run reported tokens and no cost: it costs
  // gpt-6.1-sol's list price, 2 cents, so the total ($32.42) is known.
  assert.match(rows().find(row => /^Session /.test(row)), /^Session +Computer +Model +In +Out +Cache +Cost +Share$/);
  assert.match(rows()[rows().findIndex(row => /^Session /.test(row)) + 1], /^─+$/);
  assert.equal(rows().filter(row => /\bCost\b/.test(row)).length, 1);
  const [first, second, third] = agentRows();
  assert.match(first, /^Remote job +sara-box +Opus 5\.5 +900 +80 +40k +\$20\.00 +62%$/);
  assert.match(second, /^Fix the coupons +here +Opus 5\.5 +1\.2M +34k +8\.1M +\$12\.40 +38%$/);
  assert.match(third, /^@pair Fix the coupons +here +GPT-6\.1 Sol +5k +900 +1k +\$0\.02 +<1%$/);
  // Under the table, one total, and each computer's part; no footnote.
  assert.ok(total('Today  $32.42') && total('here $12.42 · sara-box $20.00'), rows().join('\n'));
  assert.ok(!rows().some(row => /not reported|reports tokens but no cost|ELU spend today|API price/.test(row)));
  assert.ok(rows().every(row => row.length <= list.width - 2), 'every line fits');
  // t: the last seven days. The keys say so.
  list.focus(); await until(() => v.current.screen.focused === list, 'list focused');
  assert.match(v.panels.keys.getText(), /r refresh {2}t 7 days/);
  v.input.write('t'); await until(() => rows().includes('Top agents, last 7 days'), 'the week');
  assert.match(agentRows()[0], /^Speed up the build +here +Claude +— +— +— +\$50\.00 +57%$/);
  assert.match(agentRows()[1], /^Remote job +sara-box .* \$25\.00 +29%$/);
  assert.ok(total('7 days  $87.42') && total('here $62.42 · sara-box $25.00'), 'the total of the seven days');
  v.input.write('t'); await until(() => rows().includes('Top agents today'), 'today again');
  // Enter on a row here opens its session, in Sessions beside the list.
  selectRow(list, /^Fix the coupons +here /); await until(() => /enter open/.test(v.panels.keys.getText()), 'enter opens');
  v.input.write('\r'); await until(() => v.current.view === 'tasks' && v.current.session === '1', 'the session here');
  // Enter on a row of my other computer opens it in Sessions, under that computer.
  await send(v, '/usage'); await until(() => v.current.view === 'usage' && agentRows().length === 3, 'back in Usage');
  list.focus(); selectRow(list, /^Remote job +sara-box /); v.input.write('\r');
  await until(() => v.current.view === 'tasks' && /Remote job/.test(plainItem(v.panels.board.items[v.panels.board.selected] ?? { getText: () => '' })), 'the session there, under the cursor');
  // At most ten rows: nine more sessions here.
  for (let id = 3; id <= 11; id++) conversation(id, `Small job ${id}`, [{ role: 'lead', vendor: 'claude', at: now, costUsd: id / 100 }]);
  await send(v, '/usage'); await until(() => v.current.view === 'usage' && agentRows().length === 10 && rows().some(row => /Small job 11/.test(row)), 'ten rows');
  assert.ok(!rows().some(row => /Small job 3 /.test(row) || /^@pair/.test(row)), 'the two cheapest are left out');
  assert.ok(total('Today  $33.05') && total('here $13.05 · sara-box $20.00'), 'the total still counts every run here');
  // At 80 columns each agent is still one line that fits the pane.
  v.output.columns = 80; v.output.rows = 24; v.output.emit('resize');
  await until(() => v.current.screen.width === 80 && list.width < 80, '80 columns');
  await until(() => agentRows().length === 10 && rows().every(row => row.length <= list.width - 2), 'every row fits');
  // The total and each computer's part, under the cost.
  const costEnd = () => { const header = rows().find(row => /^Session /.test(row)); return header.indexOf('Cost') + 4; };
  assert.ok(rows().some(row => row === `${' '.repeat(costEnd() - 13)}Today  $33.05`), 'the total ends where Cost ends');
  // A computer that sends none, as every ELU after 0.1.33 (its agents cover all its projects,
  // shared or not, so their spend stays there): it is not named, it needs no update, and none
  // of its rows show. Usage is this computer's then.
  machines[0] = { ...machines[0], topAgents: null };
  await until(() => total('Today  $13.05') && !rows().some(row => /Remote job|sara-box/.test(row)), 'only this computer').catch(error => { throw new Error(`${error.message}:\n${rows().join('\n')}`); });
  assert.ok(!rows().some(row => /needs an ELU update|waiting|offline/.test(row)), rows().join('\n'));
  // A computer of mine on a build before 0.1.20, which counts a session's total again for each
  // of its turns: its rows stay, and its part of the total says older ELU.
  const sent = { today: { costUsd: 20, partial: false, rows: [remoteRow] }, week: { costUsd: 25, partial: false, rows: [remoteRow] } };
  machines[0] = { ...machines[0], topAgents: { own: false, ...sent } };
  await until(() => total('here $13.05 · sara-box $20.00 (older ELU)') && rows().some(row => /Remote job/.test(row)), 'the older build');
  assert.ok(rows().every(row => row.length <= list.width - 2), 'every line fits');
  // Once it is updated it says each cost is a run's own, and that goes.
  machines[0] = { ...machines[0], topAgents: { own: true, ...sent } };
  await until(() => !rows().some(row => /older ELU/.test(row)) && total('here $13.05 · sara-box $20.00'), 'the note gone');
});

// Where the accounts of the Usage tab meet the other computers of a project: a computer on
// this ELU sends no agents of its own, so the tab is this computer's alone, with nothing named
// for that computer; and each key acts on the account of the line the cursor is on.
test('Usage with several accounts and another computer on the project that sends no agents: Top agents are this computer\'s alone, and f, Down and Enter act on the line shown', { timeout: 60000 }, async t => {
  const p = project(later(t)); environment(t, p.parent); registerProject(repository(p.root));
  const before = process.env.PATH; process.env.PATH = fakeClis(p.parent).env.PATH; owned(t).files.push(() => { process.env.PATH = before; });
  const now = new Date().toISOString(), logFile = path.join(p.parent, 'run.log'), soon = Math.floor(Date.now() / 1000) + 4 * 3600, week = soon + 2 * 86400;
  const { repo } = liveTask(p.root, { id: '1', goal: 'Fix the coupons' });
  saveTask(repo, { ...readTask(repo, '1'), runs: [{ role: 'lead', vendor: 'claude', logFile, at: now, costUsd: 12.4, model: 'claude-opus-5-5', tokens: { input: 1200000, output: 34000, cacheRead: 8100000, cacheWrite: 0 } }] });
  // The other computer: one session of the project there, and no agents sent.
  const P = '5'.repeat(16), RID = '55555555-5555-4555-8555-555555555555';
  const machines = [{ key: SARA, listedAt: now, older: false, projects: [{ id: P, name: 'shop', repoId: null, home: false }], topAgents: null,
    sessions: [{ id: RID, ref: `${P}:5`, project: P, title: 'Remote job', state: 'answered', at: now, createdAt: now, approvals: [], by: 'you', who: null, repoId: null }] }];
  // Two Claude accounts of three limits each: the one in use open, the tight one closed to its tightest.
  const limits = (fiveHour, weekly, fable) => ({ observedAt: now, fiveHour: { usedPercent: fiveHour, resetsAt: soon }, weekly: { usedPercent: weekly, resetsAt: week }, models: [{ id: 'fable', weekly: { usedPercent: fable, resetsAt: week } }] });
  const OWNER = 'owner@example.invalid', SECOND = 'second@example.invalid';
  const home = temp(t); for (const name of ['claude', 'codex']) fs.mkdirSync(path.join(home, name));
  const signedIn = (dir, email) => fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, planDisplayName: 'Max 20x' } }));
  signedIn(path.join(home, 'claude'), OWNER); fs.mkdirSync(personalDirectory(), { recursive: true });
  fs.writeFileSync(path.join(personalDirectory(), 'usage.json'), JSON.stringify({ version: 1, claude: limits(8, 3, 62) }));
  const slot = newLogin('claude'); signedIn(slot.dir, SECOND); finishLogin('claude', slot.id); recordAccount('claude', SECOND, 'Max 20x', limits(21, 77, 30));
  const usage = { home, env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex') }, vendors: () => [{ vendor: 'claude', available: true, signedIn: true }, { vendor: 'codex', available: true, signedIn: false }, { vendor: 'agy', available: true, signedIn: false }, { vendor: 'grok', available: false, signedIn: false }] };
  const v = await view(t, { repo: repository(p.root), dashboard: true, peer: fakePeer({ items: [], sharing: [SARA], machines }), usage });
  const list = v.panels.usageList, rows = () => list.items.map(plainItem), text = () => rows().join('\n');
  const head = email => rows().findIndex(row => row.includes(`▾ ${email} · `) || row.includes(`▸ ${email} · `)), isOpen = email => rows()[head(email)].includes(`▾ ${email}`);
  await send(v, '/usage'); await until(() => v.current.view === 'usage' && head(SECOND) >= 0 && rows().some(row => /^Fix the coupons /.test(row)), 'the accounts and the agents').catch(error => { throw new Error(`${error.message}:\n${text()}`); });
  // Top agents: this computer's one, with no column, part or note for the other computer.
  assert.match(rows().find(row => /^Session /.test(row)), /^Session +Model +In +Out +Cache +Cost +Share$/, text());
  assert.ok(rows().some(row => row.trim() === 'Today  $12.40'), text());
  assert.ok(!rows().some(row => /Remote job|sara|Computer|here \$|offline|needs an ELU update|older ELU/.test(row)), text());
  // f on a limit's line of the open account folds that account, and the other stays as it was.
  assert.deepEqual([isOpen(OWNER), isOpen(SECOND)], [true, false], text());
  list.focus(); await until(() => v.current.screen.focused === list, 'the list has the keys');
  list.select(head(OWNER) + 2); v.input.write('f'); await until(() => !isOpen(OWNER), `f on a limit of the first account:\n${text()}`);
  assert.equal(isOpen(SECOND), false);
  list.select(head(SECOND)); v.input.write('f'); await until(() => isOpen(SECOND), `f on the second account:\n${text()}`);
  assert.equal(isOpen(OWNER), false, 'the first stays folded');
  assert.equal(head(SECOND), head(OWNER) + 1, 'the folded account is one line');
  // Enter on the agent's line opens its session here.
  selectRow(list, /^Fix the coupons /); await until(() => /enter open/.test(v.panels.keys.getText()), 'enter opens');
  v.input.write('\r'); await until(() => v.current.view === 'tasks' && v.current.session === '1', 'the session here');
});

// What a session's computer sends of its changes: 7 files, +76 −5. One of them is the line the
// owner could not read in the chat, a template literal of about 400 characters.
const WIDE = tail => `    lines.push(\`\\nMatching orders with the same coupon on this page (\${d.matchingOrders.length} returned; \${Math.min(d.matchingOrders.length, 5)} shown; \${Math.max(0, d.matchingOrders.length - 5)} omitted; may include this order's own sample; matched by page + coupon code, not by customer — some may belong to a different customer, so do not report their dates, totals${tail} as this order's):\`);`;
function sentChanges() {
  const lines = (count, text) => Array.from({ length: count }, (_, index) => text(index + 1));
  const file = (name, at, around, removed, added, after = []) => [`diff --git a/${name} b/${name}`, 'index 1111111..2222222 100644', `--- a/${name}`, `+++ b/${name}`, `@@ -${at},${removed.length + after.length} +${at},${added.length + after.length} @@${around ? ` ${around}` : ''}`, ...removed.map(line => `-${line}`), ...added.map(line => `+${line}`), ...after.map(line => ` ${line}`)].join('\n');
  return [
    file('README.md', 3, '', ['A small shop.'], lines(10, n => `Readme line ${n}`)),
    file('src/cart.mjs', 2, 'export function addItem(cart, item) {', ['  cart.items.push(item);'], lines(9, n => `  cart.step${n}(item);`), ['  return cart;']),
    file('src/coupon.mjs', 1, '', ['export const normalize = (value) => value;'], ['export const normalize = (value) => value.toUpperCase();']),
    file('src/report/format.mjs', 644, 'function formatOrderDetail(d, ctx = {}) {', [WIDE(' or buyers')], [WIDE(', buyers or notes'), ...lines(6, n => `      // Note ${n} on each row.`)], ['    });']),
    file('src/totals.mjs', 2, 'export function total(cart) {', ['  return 0;'], lines(11, n => `  sum += step${n}(cart);`)),
    file('test/cart.test.mjs', 8, '', [], lines(16, n => `// Test line ${n}`)),
    `New file: docs/changes.md\n${lines(22, n => `Step ${n} of the work.`).join('\n')}\n`,
  ].join('\n');
}
// The rows of the Changes pane as they read: the cursor's mark first, no spaces at the end.
const changeLines = v => v.panels.changes.getText().split('\n').map(row => row.replace(/┃$/, '').trimEnd());
const cursorLine = v => changeLines(v).find(row => row.startsWith('▌')) ?? '';
const squeezed = row => row.replace(/ {2,}/g, '  ');

for (const [columns, rows] of [[140, 50], [80, 24]]) test(`a session on my other computer has a Changes tab of its own at ${columns}x${rows}: its name counts the changes, no line of the chat does, d opens them, and they read as files and hunks`, { timeout: 60000 }, async t => {
  const at = new Date().toISOString();
  const session = { id: '66666666-6666-4666-8666-666666666666', machine: SARA, createdAt: at, lastAt: at, title: 'Fix the report', state: 'needs_input', question: 'Which format?', choices: ['Uppercase', 'Lowercase'], approvals: [], steps: [],
    entries: [{ role: 'You', at, text: 'Fix the report' }, { role: 'Claude', at, text: 'I changed the report and the cart.', lead: true }], diff: { summary: '7 files · +76 −5', patch: sentChanges() } };
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], sharing: [SARA], remote: [session] }), v = await view(t, { columns, rows, repo: repository(p.root), dashboard: true, peer });
  const { board, chat, changes, sessionTabs } = v.panels, keys = () => v.panels.keys.getText().trim(), focused = () => v.current.screen.focused;
  await until(() => board.items.some(item => /Fix the report/.test(plainItem(item))), 'the remote row');
  board.focus(); selectRow(board, /Fix the report/);
  // The chat: no line for the changes, as a session here has none, and never the diff. Its question ends it.
  await until(() => /Which format\?/.test(chat.getText()) && sessionTabs.getText().trim() === 'Chat   Changes 7', 'its chat, and the tab whose name counts its changes');
  assert.doesNotMatch(chat.getText(), /Changes · |d opens them|diff --git|index 1111111|@@ -|\+\+\+ b\/|--- a\/|Readme line|Matching orders/);
  assert.match(chat.getText().trimEnd(), /Type its number or your answer below\.$/);
  // The same two tabs a session here has, and d among the row's keys.
  assert.equal(sessionTabs.hidden, false); assert.equal(sessionTabs.getText().trim(), 'Chat   Changes 7'); assert.equal(changes.hidden, true);
  assert.match(keys(), /enter open {2}c remove {2}d changes/);
  // d on its row: the files, each with its counts, the cursor on the first.
  v.input.write('d');
  await until(() => v.current.sessionView === 'changes' && focused() === changes && /7 files changed/.test(changes.getText()), 'd on its row opens Changes');
  assert.equal(chat.hidden, true);
  assert.deepEqual(changeLines(v).slice(0, 9).map(squeezed), [' 7 files changed · +76 −5', '', '▌▸ README.md  +10 −1', ' ▸ src/cart.mjs  +9 −1', ' ▸ src/coupon.mjs  +1 −1', ' ▸ src/report/format.mjs  +7 −1', ' ▸ src/totals.mjs  +11 −1', ' ▸ test/cart.test.mjs  +16 −0', ' ▸ docs/changes.md  new  +22 −0']);
  // The key bar names the keys between files, between changes, and the page keys.
  // Ctrl+T, for the Task in the header, comes last where there is room.
  assert.equal(keys(), columns >= 100 ? '↑↓ move  enter unfold  [ ] file  n p change  pgup pgdn page  esc chat  tab next  ctrl+t Task' : '↑↓ move  enter unfold  [ ] file  n p change  pgup pgdn page  esc chat');
  // ] to the file with the long line, Enter unfolds it: one hunk, said in words.
  v.input.write(']]]'); await until(() => /^▌▸ src\/report\/format\.mjs/.test(cursorLine(v)), '] moves between files');
  v.input.write('['); await until(() => /^▌▸ src\/coupon\.mjs/.test(cursorLine(v)), '[ goes back a file');
  v.input.write(']\r'); await until(() => /^▌▾ src\/report\/format\.mjs/.test(cursorLine(v)), 'Enter unfolds it');
  const shown = changeLines(v), from = shown.findIndex(row => row.startsWith('▌'));
  assert.match(shown[from + 1], columns >= 100 ? /^ src\/report\/format\.mjs · line 644 · function formatOrderDetail\(d, ctx = \{\}\) \{$/ : /format\.mjs · line 644 · function/);
  assert.match(shown[from + 2], /^ 644 {5}- {5}lines\.push\(`\\nMatching orders/);
  // The long line goes on under its own text: the rows after its first hold no number and no sign.
  // In a pane too short to hold the removed line and the added one, the rest is a page away.
  const added = shown.findIndex(row => /^ {5}644 \+ {5}lines\.push\(/.test(row));
  assert.ok(rows === 24 ? added < 0 : added > from + 3, 'the added line starts on a row of its own');
  for (const row of shown.slice(from + 3, added < 0 ? shown.length : added)) assert.match(row, /^ {15,}\S/, row);
  if (added >= 0) assert.match(shown[added + 1], /^ {15,}\S/);
  // Nothing of Git's own header is drawn, and no row is wider than the pane.
  for (const row of changeLines(v)) { assert.doesNotMatch(row, /diff --git|index 1111111|^.(?:---|\+\+\+) |@@/); assert.ok(row.length <= changes.width - 2, row); }
  // n to the next change, opening the folded file on the way; p back.
  v.input.write('n'); await until(() => /^▌.*format\.mjs · line 644/.test(cursorLine(v)), 'n goes to the change');
  // Where the rows are more than the pane holds, the change comes to its top.
  if (rows === 24) assert.equal(changeLines(v)[0], cursorLine(v));
  assert.equal(keys(), '↑↓ move  [ ] file  n p change  pgup pgdn page  esc chat  tab next  ctrl+t Task');
  v.input.write('n'); await until(() => /^▌.*totals\.mjs · line 2 · export function total/.test(cursorLine(v)), 'n opens the next file and goes to its change');
  v.input.write('p'); await until(() => /^▌.*format\.mjs · line 644/.test(cursorLine(v)), 'p goes back a change');
  v.input.write('['); await until(() => /^▌▾ src\/report\/format\.mjs/.test(cursorLine(v)), '[ from inside a file goes to its name');
  // PgDn and PgUp move a page.
  const before = changeLines(v).join('\n');
  v.input.write('\x1b[6~'); await until(() => changeLines(v).join('\n') !== before, 'a page down');
  const paged = changeLines(v).join('\n');
  v.input.write('\x1b[5~'); await until(() => changeLines(v).join('\n') !== paged, 'a page up');
  // Tab moves on from the view as it does for a session here: the tabs, the list, the box, the view.
  v.input.write('\t'); await until(() => v.panels.tabs.includes(focused()), 'Tab leaves the view');
  v.input.write('\t'); await until(() => focused() === board, 'to the list');
  v.input.write('\t'); await until(() => focused() === v.panels.ask, 'to the message box');
  v.input.write('\t'); await until(() => focused() === changes, 'and back to Changes');
  // Esc goes back to the chat, and to the row d was pressed on.
  board.focus(); v.input.write('d'); await until(() => focused() === changes, 'd again');
  const left = cursorLine(v);
  v.input.write('\x1b'); await until(() => v.current.sessionView === 'chat' && focused() === board, 'Esc goes back to the row');
  assert.equal(changes.hidden, true); assert.match(chat.getText(), /Which format\?/); assert.equal(sessionTabs.getText().trim(), 'Chat   Changes 7');
  // Tab reaches its chat as it does for a session here (the list, the box, the chat). d in the pane does the same, and Esc goes back to the pane.
  v.input.write('\t'); await until(() => focused() === v.panels.ask, 'Tab from the row: the message box');
  v.input.write('\t'); await until(() => focused() === chat && /d changes/.test(keys()), 'then its chat, which names d');
  v.input.write('d'); await until(() => v.current.sessionView === 'changes' && focused() === changes, 'd in its pane');
  assert.equal(cursorLine(v), left, 'where he left it');
  v.input.write('\x1b'); await until(() => v.current.sessionView === 'chat' && focused() === chat, 'Esc goes back to the pane');
  // A click on the tab's name opens it too, and a message sent from there shows in the chat.
  sessionTabs.emit('click', { x: sessionTabs.aleft + 9, y: sessionTabs.atop }); await until(() => v.current.sessionView === 'changes', 'a click on Changes');
  await send(v, '@sara-box 1'); await until(() => v.current.sessionView === 'chat', 'the chat shows what was sent');
  assert.ok(peer.sent().some(row => row.type === 'remoteSend' && row.text === '1'));
});

test('the Changes of a session its computer has not sent yet say so and ask for them when the tab opens, and a long diff opens at once, whole', { timeout: 60000 }, async t => {
  const now = Date.now(), at = new Date(now).toISOString(), SHOP = 'e'.repeat(64), P = '1'.repeat(16), id = '71111111-1111-4111-8111-111111111117';
  const machines = [{ key: SARA, listedAt: at, older: false, projects: [{ id: P, name: 'shop', repoId: SHOP, home: false }], sessions: [{ id, ref: `${P}:1`, project: P, title: 'Fix the report', state: 'ready', at, createdAt: at, approvals: [], by: 'you', who: null }] }];
  const remote = [], p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], sharing: [SARA], machines, remote, repoId: SHOP }), v = await view(t, { columns: 140, rows: 50, repo: repository(p.root), dashboard: true, peer });
  const { board, changes, sessionTabs } = v.panels;
  await until(() => board.items.some(item => /Fix the report/.test(plainItem(item))), 'the listed row');
  board.focus(); selectRow(board, /Fix the report/); v.input.write('d');
  await until(() => v.current.sessionView === 'changes' && /@sara-box has not sent its changes yet\. Asking for them…/.test(changes.getText()), 'it says they are not here yet');
  await until(() => peer.sent().some(row => row.type === 'remoteWatch' && row.ref === `${P}:1` && row.to === SARA), 'and asks for them');
  assert.equal(sessionTabs.getText().trim(), 'Chat   Changes');
  // They arrive: 300 files of 200 lines, a new file of 30,000 lines and one line of 50,000 characters.
  const many = Array.from({ length: 300 }, (_, file) => [`diff --git a/src/f${file}.mjs b/src/f${file}.mjs`, `--- a/src/f${file}.mjs`, `+++ b/src/f${file}.mjs`, '@@ -1,100 +1,100 @@', ...Array.from({ length: 100 }, (_, line) => `-old ${line}`), ...Array.from({ length: 100 }, (_, line) => `+new ${line}`)].join('\n')).join('\n');
  const patch = [many, `New file: big.txt\n${Array.from({ length: 30000 }, (_, line) => `line ${line + 1}`).join('\n')}\n`, `New file: wide.txt\n${'word '.repeat(10000)}\n`].join('\n');
  const started = Date.now();
  remote.push({ id, ref: `${P}:1`, machine: SARA, createdAt: at, lastAt: at, title: 'Fix the report', state: 'ready', approvals: [], steps: [], entries: [{ role: 'You', at, text: 'Fix the report' }], diff: { summary: '302 files · +60001 −30000', patch } });
  await until(() => /302 files changed · \+60,001 −30,000/.test(changes.getText()), 'the changes, once they are here');
  // The app looks for what arrived every half second; the view itself takes a moment.
  assert.ok(Date.now() - started < 3000, `it took ${Date.now() - started} ms`);
  assert.equal(sessionTabs.getText().trim(), 'Chat   Changes 302');
  assert.doesNotMatch(changes.getText(), /not shown|not read|truncated/);
  assert.match(cursorLine(v), /^▌▸ big\.txt +new +\+30,000 +−0$/, 'a long list starts folded, the cursor on its first file');
  // So many files are listed folder by folder: the project's own files first, then each folder's under its name, the counts in columns.
  assert.deepEqual(changeLines(v).slice(2, 7).map(squeezed), ['▌▸ big.txt  new  +30,000  −0', ' ▸ wide.txt  new  +1  −0', ' src/', '  ▸ f0.mjs  +100 −100', '  ▸ f1.mjs  +100 −100']);
  assert.deepEqual([...new Set(changeLines(v).slice(2, 7).filter(row => /▸/.test(row)).map(row => row.length))].length, 1);
  // The end of the list, and the end of the longest file: every line is there.
  v.input.write('\x1b[F'); await until(() => /^▌ {2}▸ f299\.mjs +\+100 −100$/.test(cursorLine(v)), 'End goes to the last file');
  v.input.write('\x1b[H]'); await until(() => /^▌▸ big\.txt +new +\+30,000 +−0$/.test(cursorLine(v)), 'Home, then ] to the first file');
  const opened = Date.now();
  v.input.write('\r'); await until(() => /^▌▾ big\.txt/.test(cursorLine(v)) && changeLines(v).some(row => / {5}1 \+ line 1$/.test(row)), 'its 30,000 lines open');
  assert.ok(Date.now() - opened < 3000, `unfolding took ${Date.now() - opened} ms`);
  v.input.write(']'); await until(() => /^▌▸ wide\.txt/.test(cursorLine(v)) && changeLines(v).some(row => /30000 \+ line 30000$/.test(row)), 'its last line is one file away');
  v.input.write('\r]'); await until(() => /^▌ {2}▸ f0\.mjs/.test(cursorLine(v)) && changeLines(v).some(row => /^ +(?:word ?)+$/.test(row)), 'the line of 50,000 characters, to its end');
  assert.doesNotMatch(changes.getText(), /not shown|more character/);
});

test('the Changes of a session here and of the same session followed from another computer read the same, with the same keys', { timeout: 60000 }, async t => {
  const p = project(later(t)); environment(t, p.parent); registerProject(repository(p.root));
  const files = { 'src/coupon.mjs': 'export const normalize = (value) => value.trim().toUpperCase();\n', 'src/report.mjs': `export function report(d) {\n  const lines = [];\n${WIDE(', buyers or notes')}\n  return lines;\n}\n`, 'docs/notes.md': '# Notes\n\nOne.\nTwo.\n' };
  const { repo } = liveTask(p.root, { id: '1', goal: 'Fix the coupons', files });
  // What this session's computer sends of it is what a computer that follows it shows.
  const at = new Date().toISOString(), patch = sessionWire(repo, '1');
  const session = { id: '88888888-8888-4888-8888-888888888888', machine: SARA, createdAt: at, lastAt: at, title: 'Followed from afar', state: 'ready', approvals: [], steps: [], entries: [{ role: 'You', at, text: 'Fix the coupons' }], diff: { summary: '3 files', patch } };
  const peer = fakePeer({ items: [], sharing: [SARA], remote: [session] }), v = await view(t, { columns: 140, rows: 50, repo, dashboard: true, peer });
  const { board, chat, changes } = v.panels, keys = () => v.panels.keys.getText().trim(), focused = () => v.current.screen.focused;
  await until(() => board.items.some(item => /Followed from afar/.test(plainItem(item))) && board.items.some(item => /Fix the coupons/.test(plainItem(item))), 'both rows');
  // Here: d on its row opens its Changes, three files unfolded, each hunk under its place in words.
  board.focus(); selectRow(board, /Fix the coupons/); v.input.write('d');
  await until(() => v.current.sessionView === 'changes' && focused() === changes && /3 files changed/.test(changes.getText()), 'the Changes of the session here');
  // A session here takes line notes, and says how in a row under the summary. One followed from another computer does not.
  assert.match(changeLines(v)[1], /^ \+ beside a line notes what should change\. Notes go to the model together\.$/);
  const here = changeLines(v).filter((_, index) => index !== 1);
  assert.equal(here[0], ' 3 files changed · +10 −1 · compared with main as it was when this session started');
  assert.equal(squeezed(here[2]), '▌▾ src/coupon.mjs  +1 −1');
  assert.deepEqual(here.slice(3, 7), [' src/coupon.mjs · line 1', ' 1   - export const normalize = (value) => value;', '   1 + export const normalize = (value) => value.trim().toUpperCase();', '']);
  assert.ok(here.some(row => /^ src\/report\.mjs · line 1$/.test(row)) && here.some(row => /^ docs\/notes\.md · line 1$/.test(row)));
  for (const row of here) assert.doesNotMatch(row, /diff --git|^.index [0-9a-f]|^.(?:---|\+\+\+) |@@/);
  assert.equal(keys(), '↑↓ move  enter fold  [ ] file  n p change  pgup pgdn page  esc chat  tab next  ctrl+t Task');
  v.input.write(']'); await until(() => /^▌▾ docs\/notes\.md/.test(cursorLine(v)), '] to the next file');
  v.input.write('n'); await until(() => /^▌docs\/notes\.md · line 1$/.test(cursorLine(v)), 'n to its change');
  v.input.write('n'); await until(() => /^▌src\/report\.mjs · line 1$/.test(cursorLine(v)), 'n to the next one');
  // The terminal is made narrower and the rows wrap anew: the cursor stays at its change.
  v.output.columns = 80; v.output.rows = 24; v.output.emit('resize');
  await until(() => v.current.screen.width === 80 && /^▌.*report\.mjs · line 1/.test(cursorLine(v)), 'at 80 columns the cursor is still at that change');
  v.output.columns = 140; v.output.rows = 50; v.output.emit('resize');
  await until(() => v.current.screen.width === 140 && /^▌src\/report\.mjs · line 1$/.test(cursorLine(v)), 'and at 140 again');
  v.input.write('pp'); await until(() => /^▌src\/coupon\.mjs · line 1$/.test(cursorLine(v)), 'p back to the first');
  // A view that shows its first row keeps showing it when the summary above the cursor wraps to more rows.
  v.output.columns = 80; v.output.rows = 24; v.output.emit('resize');
  await until(() => v.current.screen.width === 80 && /^▌.*coupon\.mjs · line 1/.test(cursorLine(v)), 'at 80 columns, at the first change');
  assert.equal(changeLines(v)[0], ' 3 files changed · +10 −1');
  v.output.columns = 140; v.output.rows = 50; v.output.emit('resize');
  await until(() => v.current.screen.width === 140 && /^▌src\/coupon\.mjs · line 1$/.test(cursorLine(v)), 'and wide again');
  // d in its chat opens them too, and Esc goes back to the chat.
  v.input.write('\x1b'); await until(() => v.current.sessionView === 'chat' && focused() === board, 'Esc');
  chat.focus(); await until(() => /d changes/.test(keys()), 'the chat names d');
  v.input.write('d'); await until(() => v.current.sessionView === 'changes' && focused() === changes, 'd in its chat');
  v.input.write('\x1b'); await until(() => v.current.sessionView === 'chat' && focused() === chat, 'Esc goes back to its chat');
  // There: the same files and the same rows under the summary, drawn by the same code.
  v.input.write('\x1b'); await until(() => focused() === board, 'back to the list');
  selectRow(board, /Followed from afar/); v.input.write('d');
  await until(() => v.current.sessionView === 'changes' && focused() === changes && /^ 3 files changed · \+10 −1 · compared with main/.test(changeLines(v)[0]), 'the Changes of the session there');
  assert.deepEqual(changeLines(v), here);
});

test('at 80x24 the line that says a session’s changes are not here yet is whole, on the rows it needs, with no cursor beside it', { timeout: 30000 }, async t => {
  const at = new Date().toISOString(), SHOP = 'e'.repeat(64), P = '1'.repeat(16), id = '71111111-1111-4111-8111-111111111118';
  const machines = [{ key: SARA, listedAt: at, older: false, projects: [{ id: P, name: 'shop', repoId: SHOP, home: false }], sessions: [{ id, ref: `${P}:1`, project: P, title: 'Report', state: 'ready', at, createdAt: at, approvals: [], by: 'you', who: null }] }];
  const p = project(later(t)); environment(t, p.parent);
  const peer = fakePeer({ items: [], sharing: [SARA], machines, remote: [], repoId: SHOP }), v = await view(t, { columns: 80, rows: 24, repo: repository(p.root), dashboard: true, peer });
  const { board, changes } = v.panels;
  await until(() => board.items.some(item => /Report/.test(plainItem(item))), 'the listed row');
  board.focus(); selectRow(board, /Report/); v.input.write('d');
  await until(() => v.current.sessionView === 'changes' && /has not sent/.test(changes.getText()), 'the line');
  const rows = changeLines(v).filter(Boolean);
  assert.equal(rows.length, 2, rows.join('|'));
  assert.equal(rows.map(row => row.trim()).join(' '), '@sara-box has not sent its changes yet. Asking for them…');
  assert.ok(rows.every(row => !row.includes('▌') && row.length <= changes.width - 2));
});

test("a project's settings say which other computers have it, read only, with nothing to link; with none there is no row; a text both changed is said once", { timeout: 30000 }, async t => {
  const p = project(later(t)); environment(t, p.parent);
  const repo = repository(p.root), there = [{ id: '1'.repeat(16), name: 'sample app', home: true }, { id: '2'.repeat(16), name: 'shop', home: false }], said = [];
  const peer = fakePeer({ items: [], sharing: [SARA] });
  let links = [{ key: SARA, older: false, linked: { id: there[0].id, name: 'sample app' }, same: null, projects: there }];
  peer.projectLinks = () => links;
  peer.notesSaid = after => said.filter(row => row.at > after);
  const v = await view(t, { repo, dashboard: true, peer }), list = v.panels.projectsList, status = () => v.panels.status.getText(), title = 'Project sample app';
  const row = () => rowsOf(v, title).map(text => text.trimEnd()).find(text => /^Also on/.test(text));
  await send(v, '/projects'); await until(() => v.current.view === 'projects' && list.items.some(item => /sample app/.test(plainItem(item))), 'Projects');
  list.focus(); selectRow(list, /sample app/); v.input.write('\r');
  await until(() => modal(v, title) && row(), 'its settings');
  rowsOf(v, title).forEach((text, n) => assert.match(text, [/^● Active project/, /^Instructions/, /^Memory/, /^Also on/, /^Default model/, /^This computer/, /^Archive/][n]));
  assert.equal(row(), 'Also on       @sara-box');
  assert.ok(!rowsOf(v, title).some(text => /link/i.test(text)));
  // Enter on it only says what it means: nothing to choose, nothing changed.
  await choose(v, title, /^Also on/);
  await until(() => /sample app is the same project on @sara-box: the same instructions and memory\./.test(status()), 'what it means');
  assert.deepEqual(peer.calls.filter(call => call[0] === 'linkProject'), []);
  // Instructions and Memory each say first what they are, and that sessions on @sara-box use the
  // same. A project on another computer can be a team's: what is in them was written, and
  // learned, from everyone on it, not from this computer's owner alone, so neither says "you".
  const reader = name => modal(v, name)?.children.find(child => child.options?.scrollable && child.type !== 'textarea');
  const abouts = [['Instructions', ['Rules every session in this project follows, here and on @sara-box.', 'Everyone on it writes them; e edits.']], ['Memory', ['What ELU learned from everyone on it, and what they added.', 'Sessions here and on @sara-box read it. e edits; remove anything wrong.']]];
  for (const [label, about] of abouts) {
    const name = `${label} · sample app`;
    await choose(v, title, new RegExp(`^${label}`)); await until(() => reader(name)?.lpos, `${label} to read`);
    assert.deepEqual(reader(name).getText().split('\n'), [...about, '', `No ${label.toLowerCase()} yet. e adds text.`]);
    assert.doesNotMatch(reader(name).getText(), /\byou\b/i);
    v.input.write('\x1b'); await until(() => modal(v, title) && !modal(v, name), 'back in its settings');
  }
  // At 80 columns each still says it in two rows.
  v.output.columns = 80; v.output.rows = 24; v.output.emit('resize'); await until(() => v.current.screen.width === 80, '80 columns');
  for (const [label, about] of abouts) {
    const name = `${label} · sample app`;
    await choose(v, title, new RegExp(`^${label}`)); await until(() => reader(name)?.lpos, `${label} to read at 80 columns`);
    assert.deepEqual(reader(name).getText().split('\n').slice(0, 3), [...about, ''], reader(name).getText());
    v.input.write('\x1b'); await until(() => modal(v, title) && !modal(v, name), 'back in its settings at 80 columns');
  }
  v.output.columns = 160; v.output.rows = 40; v.output.emit('resize'); await until(() => v.current.screen.width === 160, '160 columns');
  // On no other computer (one there on an older ELU says none): no row.
  links = [{ key: SARA, older: true, linked: null, same: null, projects: [] }];
  v.input.write('\x1b'); await until(() => !modal(v, title), 'closed');
  list.focus(); selectRow(list, /sample app/); v.input.write('\r');
  await until(() => modal(v, title) && rowsOf(v, title).some(text => /^Default model/.test(text)), 'its settings again');
  assert.equal(row(), undefined);
  v.input.write('\x1b'); await until(() => !modal(v, title), 'closed again');
  // A text both computers changed: said once, with where the other one is kept.
  said.push({ at: Date.now(), text: 'Instructions of sample app changed here and on @sara-box: the newer, from @sara-box, is in use. The other is in ~/sample app/.elu-code/history/instructions-2026-11-14-101500.md.' });
  await until(() => status().includes('Instructions of sample app changed here and on @sara-box'), 'said');
});

// The owner's case: his Mac's ELU, a session on his devbox open, and a CleanShot capture
// dragged onto the terminal, which pastes its path bare with the spaces escaped. Two homes,
// one for each computer, marked as each other's; the daemons are joined by calls, each side's
// methods running in its own home (test/peer-files.test.mjs).
test('a picture dropped over a session on my other computer, its path first with spaces escaped, shows in the box at once and goes there with the message, never Unknown command; with words after it and quoted too', { timeout: 60000 }, async t => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), at = new Date().toISOString();
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), laptop = team.founder, devbox = team.member;
  const home = temp(later(t)), shot = path.join(home, 'Library', 'Application Support', 'Shots', 'shot 1.png'), dropped = shot.replaceAll(' ', '\\ ');
  const values = { HOME: home, XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: laptop.home, ELU_NO_COLOR: '1', TERM: 'xterm-256color' }, previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  owned(t).files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, values);
  fs.mkdirSync(path.dirname(shot), { recursive: true }); fs.writeFileSync(shot, PNG);
  // The devbox: a session of the owner's (1) in the project of the team, followed from the Mac.
  const there = withHome(devbox.home, () => {
    const made = registeredProject(t); saveTeamAccess(team.teamId, { root: made.root });
    shareProjects(devbox.identity.key, laptop.identity.key);
    liveTask(made.root, { id: '1', goal: 'Look at the batch results', state: 'ready' });
    return made;
  });
  shareProjects(laptop.identity.key, devbox.identity.key);
  const link = key => ({ key, admitted: true, remoteHello: { remote: 1, files: 1 }, notify: () => {}, request: async () => { throw new Error('No answer'); } });
  const ctx = (me, sessions) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: key => key === me.key ? null : 'mac', log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
  const toHost = link(laptop.identity.key), toViewer = link(devbox.identity.key);
  const host = hostMethods(ctx(devbox.identity, { [laptop.identity.key]: toHost })), viewCtx = ctx(laptop.identity, { [devbox.identity.key]: toViewer });
  toViewer.request = async (method, params) => withHome(devbox.home, () => host[method](params, toHost));
  const ref = `${hash(`project\0${there.root}`).slice(0, 16)}:1`, id = watchId(laptop.identity.key, devbox.identity.key, ref);
  // The Mac's window: its daemon is the stand-in, which hands what goes to the session there to the real calls.
  const remote = [{ id, machine: SARA, createdAt: at, lastAt: at, title: 'Look at the batch results', state: 'answered', steps: [], entries: [{ role: 'You', at, text: 'Look at the batch results' }, { role: 'Opus 5.5', lead: true, at, text: 'Done.' }], approvals: [] }];
  const peer = fakePeer({ items: [], sharing: [SARA], remote, answer: command => ['remoteFiles', 'remoteSend'].includes(command.type) ? remoteCommand(viewCtx, { ...command, to: devbox.identity.key, ref }) : null });
  Object.assign(peer, { offerFiles, offerPaths, stageFiles });
  const p = project(later(t)), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, ask = v.panels.ask, status = () => v.panels.status.getText().replace(/\s+/g, ' ');
  const asked = () => modal(v, 'Send files')?.children.map(child => child.getText?.() ?? '').join(' ').replace(/\s+/g, ' ') ?? '';
  const goals = () => withHome(devbox.home, () => pendingRequests(there.root).filter(row => row.continuationTaskId === '1').map(row => row.goal));
  const landed = goal => /Files from @\S+: 1 file \(1 KB\) in (.+)$/m.exec(goal)?.[1];
  await until(() => board.items.map(plainItem).some(row => /Look at the batch results/.test(row)), 'the session there is listed');
  board.focus(); selectRow(board, /Look at the batch results/);
  await until(() => / on @sara-box /.test(ask._label.getText()), 'the box writes to the session there');
  // Dropped in the box: Enter offers the picture to go with the message, and y sends both.
  ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box');
  v.input.write(`\x1b[200~${dropped}\x1b[201~`); await until(() => ask.getValue() === dropped, 'the drop is in the box');
  v.input.write('\r');
  await until(() => /Send 1 file \(1 KB\) from this computer with this message\?/.test(asked()) || /Unknown command/.test(status()), 'answered');
  assert.doesNotMatch(status(), /Unknown command/); assert.match(asked(), /Send 1 file \(1 KB\) from this computer with this message\?/);
  v.input.write('y');
  await until(() => /Sent 1 file to the session on @sara-box\./.test(status()) && ask.getValue() === '', 'sent there with the picture');
  // There, the message names where the picture landed, and the picture is whole.
  const [first] = goals(), dir = landed(first);
  assert.ok(dir, first); assert.ok(first.startsWith(`"${path.join(dir, 'shot 1.png')}"`), first); assert.ok(!first.includes(path.dirname(shot)), 'the path on the Mac is gone from it');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'shot 1.png')), PNG);
  // Dropped while the list has the focus: it shows in the box at once; words after it go too.
  board.focus(); await until(() => v.current.screen.focused === board, 'the list has the focus');
  v.input.write(`\x1b[200~${dropped}\x1b[201~`);
  await until(() => ask.getValue() === dropped && v.current.screen.focused === ask, 'the drop shows in the box at once');
  v.input.write(' this is stuck'); await until(() => ask.getValue() === `${dropped} this is stuck`, 'typed after the drop');
  v.input.write('\r'); await until(() => /Send 1 file/.test(asked()), 'offered again'); v.input.write('y');
  await until(() => goals().length === 2, 'the second one went');
  assert.match(goals()[1], /^".*shot 1\.png" this is stuck\n\nFiles from @\S+: 1 file \(1 KB\) in /);
  // Quoted, as some terminals paste it.
  await send(v, `'${shot}' and this one`); await until(() => /Send 1 file/.test(asked()), 'offered for the quoted one'); v.input.write('y');
  await until(() => goals().length === 3, 'the quoted one went');
  assert.match(goals()[2], /^".*shot 1\.png" and this one\n\nFiles from @\S+: 1 file \(1 KB\) in /);
  // A command over that session is still a command: /foo is refused here, and nothing more goes.
  await send(v, '/foo'); await until(() => status().includes('Unknown command: /foo. Type / to see commands.'), '/foo is refused');
  assert.equal(goals().length, 3);
});

// The Agents tab of a session on my other computer: its rows and one agent's thread are asked of
// that computer (remoteAgents, elu.remote.agents there), read only, through the real calls of
// both sides, each in its own home. Each computer marked the other as the owner's.
test('the Agents tab of a session on my other computer lists the agents that computer reads, and opens one agent\'s thread', { timeout: 60000 }, async t => {
  const at = new Date(Date.now() - 30 * 60000).toISOString();
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), laptop = team.founder, devbox = team.member;
  const values = { XDG_CONFIG_HOME: laptop.home, ELU_NO_COLOR: '1', TERM: 'xterm-256color' }, previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  owned(t).files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, values);
  // The devbox: a session of the owner's whose coder started a sub-agent, and the laptop marked as his.
  const there = withHome(devbox.home, () => {
    const made = registeredProject(t); saveTeamAccess(team.teamId, { root: made.root });
    shareProjects(devbox.identity.key, laptop.identity.key);
    const { repo } = liveTask(made.root, { id: '1', goal: 'Uppercase coupon codes', state: 'answered', activeRole: null });
    const log = path.join(taskDir(repo, '1'), 'lead-1.jsonl'), said = (content, parent = null, model = 'claude-opus-5-5') => ({ type: 'assistant', message: { id: `msg_${Math.random().toString(36).slice(2)}`, model, content }, parent_tool_use_id: parent });
    fs.writeFileSync(log, [
      { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
      said([{ type: 'text', text: 'Looking for the coupon code.' }, { type: 'tool_use', id: 'toolu_A', name: 'Task', input: { description: 'Find the coupon code', prompt: 'Find where coupons are read.' } }]),
      { type: 'user', message: { content: [{ type: 'text', text: 'Find where coupons are read.' }] }, parent_tool_use_id: 'toolu_A' },
      said([{ type: 'tool_use', id: 'toolu_A1', name: 'Grep', input: { pattern: 'coupon' } }], 'toolu_A', 'claude-sonnet-5'),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_A1', content: 'src/coupon.mjs:1' }] }, parent_tool_use_id: 'toolu_A' },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: [{ type: 'text', text: 'In src/coupon.mjs, line 1.' }] }] }, parent_tool_use_id: null },
      { type: 'result', subtype: 'success', total_cost_usd: 0.42, structured_output: { summary: 'Codes are upper case now.' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    saveTask(repo, { ...readTask(repo, '1'), runs: [{ role: 'lead', vendor: 'claude', logFile: log, code: 0, startedAt: at, at, model: 'claude-opus-5-5', asked: 'opus', effort: 'high' }] });
    markMyComputer(laptop.identity.key, 'laptop');
    return made;
  });
  shareProjects(laptop.identity.key, devbox.identity.key);
  withHome(laptop.home, () => markMyComputer(devbox.identity.key, 'devbox'));
  const link = key => ({ key, admitted: true, remoteHello: { remote: 1, shared: 1, oversee: 1, full: 1 }, notify: () => {}, request: async () => { throw new Error('No answer'); } });
  const ctx = (me, sessions) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: key => key === me.key ? null : 'mac', log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
  const toHost = link(laptop.identity.key), toViewer = link(devbox.identity.key), asked = [];
  const host = hostMethods(ctx(devbox.identity, { [laptop.identity.key]: toHost })), viewCtx = ctx(laptop.identity, { [devbox.identity.key]: toViewer });
  toViewer.request = async (method, params) => { asked.push([method, params]); return withHome(devbox.home, () => host[method](params, toHost)); };
  const ref = `${hash(`project\0${there.root}`).slice(0, 16)}:1`, id = watchId(laptop.identity.key, devbox.identity.key, ref), now = new Date().toISOString();
  // The laptop's window: its daemon is the stand-in, which hands remoteAgents to the real calls.
  const remote = [{ id, machine: SARA, createdAt: now, lastAt: now, title: 'Uppercase coupon codes', project: 'billing', state: 'answered', mode: 'auto', steps: [], entries: [{ role: 'You', at: now, text: 'Uppercase coupon codes' }, { role: 'Opus 5.5', lead: true, at: now, text: 'Done.' }], approvals: [] }];
  const peer = fakePeer({ items: [], sharing: [SARA], remote, answer: command => command.type === 'remoteAgents' ? withHome(laptop.home, () => remoteCommand(viewCtx, { ...command, to: devbox.identity.key, ref })) : null });
  const p = project(later(t)), v = await view(t, { columns: 140, rows: 40, repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, agents = v.panels.agents, shown = () => agents.getText().split('\n').map(line => line.replace(/┃\s*$/, '').trimEnd());
  await until(() => board.items.map(plainItem).some(row => /Uppercase coupon codes/.test(row)), 'the session there is listed');
  board.focus(); selectRow(board, /Uppercase coupon codes/);
  await until(() => /Task {2}· {2}Agents/.test(v.panels.header.getText()), 'its header names Agents');
  // Ctrl+A from the list: the rows that computer read, the coder and the sub-agent it started.
  v.input.write('\x01'); await until(() => v.current.sessionView === 'agents' && v.current.screen.focused === agents, 'Ctrl+A shows its agents');
  await until(() => shown().some(line => /Find the coupon code/.test(line)), 'the rows from there').catch(error => { throw new Error(`${error.message}: ${shown().join('\n')}`); });
  const rows = shown().filter(line => line.trim());
  assert.match(rows[0], /Opus 5\.5 {2}high +done/); assert.match(rows[1], /Codes are upper case now\./);
  assert.match(rows[2], /└ Find the coupon code {2}sonnet 5 +done/); assert.match(rows[3], /In src\/coupon\.mjs, line 1\./);
  const listedThere = asked.filter(([method]) => method === 'elu.remote.agents');
  assert.ok(listedThere.length >= 1); assert.deepEqual(listedThere[0][1], { ref }, 'the rows, asked by its place there');
  const sentAgents = peer.sent().filter(row => row.type === 'remoteAgents');
  assert.deepEqual(Object.keys(sentAgents[0]).sort(), ['id', 'type'], 'the window asks by the session it follows');
  // Down and Enter: the sub-agent's thread, as that computer sends it ({ agent, entries }).
  v.input.write('\x1b[B'); await until(() => /▌└ Find the coupon code/.test(shown().filter(line => line.trim())[2] ?? ''), 'the cursor on the sub-agent');
  v.input.write('\r'); await until(() => /← Find the coupon code {2}sonnet 5/.test(shown()[0] ?? ''), 'its thread').catch(error => { throw new Error(`${error.message}: ${shown().join('\n')}`); });
  await until(() => /┃ In src\/coupon\.mjs, line 1\./.test(shown().join('\n')), 'its answer, from there').catch(error => { throw new Error(`${error.message}: ${shown().join('\n')}`); });
  const thread = asked.filter(([method, params]) => method === 'elu.remote.agents' && params.agent).at(-1);
  assert.equal(thread[1].ref, ref); assert.match(thread[1].agent, /\S/);
  const answered = await withHome(laptop.home, () => remoteCommand(viewCtx, { type: 'remoteAgents', to: devbox.identity.key, ref, agent: thread[1].agent }));
  assert.deepEqual(Object.keys(answered).sort(), ['agent', 'entries']); assert.ok(answered.entries.some(entry => entry.text === 'In src/coupon.mjs, line 1.'), JSON.stringify(answered.entries));
  // Esc goes back to the rows, and again to the list.
  v.input.write('\x1b'); await until(() => /▌└ Find the coupon code/.test(shown().filter(line => line.trim())[2] ?? ''), 'back to the rows');
  v.input.write('\x1b'); await until(() => v.current.sessionView === 'chat' && v.current.screen.focused === board, 'back to the list');
});

// In Chats the message box writes to the open channel or person: a dropped file shows in it at
// once while the list has the focus, and a message that starts with its path goes to them.
test('in Chats a dropped picture shows in the box at once from the list, and a message that starts with its path goes to the person, never Unknown command', async t => {
  const { v, peer } = await teamView(t), ask = v.panels.ask, [bar] = v.panels.teamLists, status = () => v.panels.status.getText().replace(/\s+/g, ' ');
  const dropped = '/Users/someone/Library/Application\\ Support/Shots/shot\\ 1.png';
  await openRow(v, /@li\s+offline/, '@li');
  bar.focus(); await until(() => v.current.screen.focused === bar, 'the list has the focus');
  v.input.write(`\x1b[200~${dropped}\x1b[201~`);
  await until(() => ask.getValue() === dropped && v.current.screen.focused === ask, 'the drop shows in the box at once');
  v.input.write(' see this'); v.input.write('\r');
  await until(() => peer.sent().some(row => row.type === 'ask') || /Unknown command/.test(status()), 'answered');
  assert.doesNotMatch(status(), /Unknown command/);
  assert.deepEqual(peer.sent().at(-1), { type: 'ask', to: LI, project: null, text: `${dropped} see this` });
});

// The owner's case: his Mac's ELU, the New session box, @ his devbox first, then a CleanShot
// capture dragged onto the terminal, then his words. The picture is on the Mac only. As for a
// session that runs there already, Enter offers it to go with the message, and y sends both:
// the session there starts with the message naming where the picture landed, and may read it
// from its first turn. A build there from before this takes files only into a session that has
// started: he is asked whether the text goes alone, and n keeps the message in the box.
test('a picture dropped in the New session box after @ my other computer goes there with the message; an older ELU there asks whether the text goes alone', { timeout: 60000 }, async t => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), laptop = team.founder, devbox = team.member;
  const home = temp(later(t)), shot = path.join(home, 'Library', 'Application Support', 'Shots', 'shot 1.png'), dropped = shot.replaceAll(' ', '\\ ');
  const values = { HOME: home, XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: laptop.home, ELU_NO_COLOR: '1', TERM: 'xterm-256color' }, previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  owned(t).files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, values);
  fs.mkdirSync(path.dirname(shot), { recursive: true }); fs.writeFileSync(shot, PNG);
  const there = withHome(devbox.home, () => {
    const made = registeredProject(t); saveTeamAccess(team.teamId, { root: made.root });
    shareProjects(devbox.identity.key, laptop.identity.key);
    return made;
  });
  shareProjects(laptop.identity.key, devbox.identity.key);
  const link = key => ({ key, admitted: true, remoteHello: { remote: 1, files: 1, startFiles: 1 }, notify: () => {}, request: async () => { throw new Error('No answer'); } });
  const ctx = (me, sessions) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: key => key === me.key ? null : 'mac', log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
  const toHost = link(laptop.identity.key), toViewer = link(devbox.identity.key);
  const host = hostMethods(ctx(devbox.identity, { [laptop.identity.key]: toHost })), viewCtx = ctx(laptop.identity, { [devbox.identity.key]: toViewer });
  // The devbox has a home of its own, without the picture.
  const devboxHome = temp(later(t));
  toViewer.request = async (method, params) => withHome(devbox.home, () => { const mac = process.env.HOME; process.env.HOME = devboxHome; try { return host[method](params, toHost); } finally { process.env.HOME = mac; } });
  // The Mac's window: its daemon is the stand-in, which hands a start to the real calls.
  const peer = fakePeer({ items: [], sharing: [SARA], answer: command => command.type === 'remoteStart' ? remoteCommand(viewCtx, { ...command, to: devbox.identity.key }) : null });
  Object.assign(peer, { offerFiles, offerPaths, stageFiles });
  const p = project(later(t)), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const ask = v.panels.ask, status = () => v.panels.status.getText().replace(/\s+/g, ' ');
  const asked = () => modal(v, 'Send files')?.children.map(child => child.getText?.() ?? '').join(' ').replace(/\s+/g, ' ') ?? '';
  const started = () => withHome(devbox.home, () => pendingRequests(there.root).filter(row => row.mine));
  const landed = goal => /Files from @\S+: 1 file \(1 KB\) in (.+)$/m.exec(goal)?.[1];
  ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box');
  v.input.write('@sara-box '); v.input.write(`\x1b[200~${dropped}\x1b[201~`); v.input.write(' why is this cut off');
  await until(() => ask.getValue() === `@sara-box ${dropped} why is this cut off`, 'typed');
  v.input.write('\r');
  await until(() => /Send 1 file \(1 KB\) from this computer with this message\?/.test(asked()) || /Started on @sara-box/.test(status()), 'asked, or started');
  assert.match(asked(), /Send 1 file \(1 KB\) from this computer with this message\?/, `the picture is offered, not left behind: ${status()}`);
  assert.deepEqual(started(), [], 'nothing starts before he answers');
  v.input.write('y');
  await until(() => /Started on @sara-box in .+ with 1 file\. It shows here as it works\./.test(status()), 'started there with the picture');
  // There, its first message names where the picture landed, and the session may read that folder.
  const [first] = started(), dir = landed(first.goal);
  assert.ok(dir, first.goal); assert.ok(first.goal.startsWith(`"${path.join(dir, 'shot 1.png')}" why is this cut off`), first.goal);
  assert.ok(!first.goal.includes(dropped) && !first.goal.includes(path.dirname(shot)), 'the path on the Mac is gone from it');
  assert.equal(first.continuationTaskId, null); assert.deepEqual(first.folders, [path.dirname(dir)]);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'shot 1.png')), PNG);
  // The copies made for sending are gone once sent.
  assert.deepEqual(fs.readdirSync(path.join(laptop.home, 'elu-code', 'peer', 'files', 'out')), []);
  // An older ELU there: y to the files asks whether the text goes alone. n sends nothing and keeps it.
  toViewer.remoteHello = { remote: 1, files: 1 };
  await send(v, `@sara-box ${dropped} and this`);
  await until(() => /Send 1 file/.test(asked()), 'offered'); v.input.write('y');
  await until(() => /@sara-box has an older ELU, which takes files only into a session that has started\. Start it with the text only\?/.test(asked()), 'asked about the text alone');
  assert.doesNotMatch(status(), /Sending/, 'nothing under the question says the file is on its way');
  v.input.write('n');
  await until(() => /Nothing was sent\. The message is still here\./.test(status()) && ask.getValue() === `@sara-box ${dropped} and this`, 'kept in the box');
  assert.equal(started().length, 1);
  // y: the text alone starts it, as typed.
  ask.setValue(''); await send(v, `@sara-box ${dropped} and this`);
  await until(() => /Send 1 file/.test(asked()), 'offered again'); v.input.write('y');
  await until(() => /older ELU/.test(asked()), 'asked again'); v.input.write('y');
  await until(() => started().length === 2 && /Started on @sara-box/.test(status()), 'the text alone');
  assert.equal(started()[1].goal, `${dropped} and this`);
});

// The files question says Esc cancels. Over a session on my other computer, Esc there sends
// nothing: not the text without the picture. The message stays in the box as typed, and the
// line says so. n still sends the text alone.
test('Esc on the files question over a session on my other computer sends nothing and keeps the message in the box; n still sends the text alone', { timeout: 60000 }, async t => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), at = new Date().toISOString();
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), laptop = team.founder, devbox = team.member;
  const home = temp(later(t)), shot = path.join(home, 'Library', 'Application Support', 'Shots', 'shot 1.png'), dropped = shot.replaceAll(' ', '\\ ');
  const values = { HOME: home, XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: laptop.home, ELU_NO_COLOR: '1', TERM: 'xterm-256color' }, previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  owned(t).files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, values);
  fs.mkdirSync(path.dirname(shot), { recursive: true }); fs.writeFileSync(shot, PNG);
  const there = withHome(devbox.home, () => {
    const made = registeredProject(t); saveTeamAccess(team.teamId, { root: made.root });
    shareProjects(devbox.identity.key, laptop.identity.key);
    liveTask(made.root, { id: '1', goal: 'Look at the batch results', state: 'ready' });
    return made;
  });
  shareProjects(laptop.identity.key, devbox.identity.key);
  const link = key => ({ key, admitted: true, remoteHello: { remote: 1, files: 1 }, notify: () => {}, request: async () => { throw new Error('No answer'); } });
  const ctx = (me, sessions) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: key => key === me.key ? null : 'mac', log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
  const toHost = link(laptop.identity.key), toViewer = link(devbox.identity.key);
  const host = hostMethods(ctx(devbox.identity, { [laptop.identity.key]: toHost })), viewCtx = ctx(laptop.identity, { [devbox.identity.key]: toViewer });
  toViewer.request = async (method, params) => withHome(devbox.home, () => host[method](params, toHost));
  const ref = `${hash(`project\0${there.root}`).slice(0, 16)}:1`, id = watchId(laptop.identity.key, devbox.identity.key, ref);
  const remote = [{ id, machine: SARA, createdAt: at, lastAt: at, title: 'Look at the batch results', state: 'answered', steps: [], entries: [{ role: 'You', at, text: 'Look at the batch results' }, { role: 'Opus 5.5', lead: true, at, text: 'Done.' }], approvals: [] }];
  const peer = fakePeer({ items: [], sharing: [SARA], remote, answer: command => ['remoteFiles', 'remoteSend'].includes(command.type) ? remoteCommand(viewCtx, { ...command, to: devbox.identity.key, ref }) : null });
  Object.assign(peer, { offerFiles, offerPaths, stageFiles });
  const p = project(later(t)), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, ask = v.panels.ask, status = () => v.panels.status.getText().replace(/\s+/g, ' ');
  const asked = () => modal(v, 'Send files')?.children.map(child => child.getText?.() ?? '').join(' ').replace(/\s+/g, ' ') ?? '';
  const keysSaid = () => modal(v, 'Send files')?.children.find(child => child.type === 'textbox')?._label?.getText() ?? '';
  const goals = () => withHome(devbox.home, () => pendingRequests(there.root).filter(row => row.continuationTaskId === '1').map(row => row.goal));
  await until(() => board.items.map(plainItem).some(row => /Look at the batch results/.test(row)), 'the session there is listed');
  board.focus(); selectRow(board, /Look at the batch results/);
  await until(() => / on @sara-box /.test(ask._label.getText()), 'the box writes to the session there');
  // Dropped in the box, words after it, Enter: the question, which says Esc cancels.
  ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box');
  v.input.write(`\x1b[200~${dropped}\x1b[201~`); await until(() => ask.getValue() === dropped, 'the drop is in the box');
  v.input.write(' why is this cut off'); await until(() => ask.getValue() === `${dropped} why is this cut off`, 'typed');
  v.input.write('\r');
  await until(() => /Send 1 file \(1 KB\) from this computer with this message\?/.test(asked()), 'asked');
  assert.match(keysSaid(), /Esc cancels/);
  // Esc: nothing goes there, the message is in the box as typed, and the line says so.
  v.input.write('\x1b');
  await until(() => !modal(v, 'Send files') && (/Nothing was sent/.test(status()) || /Sent /.test(status()) || goals().length > 0), 'answered');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(goals(), [], 'nothing went there');
  assert.match(status(), /Nothing was sent\. The message is still here\./);
  assert.equal(ask.getValue(), `${dropped} why is this cut off`);
  // n, as before: the text alone.
  await send(v, ask.getValue());
  await until(() => /Send 1 file/.test(asked()), 'asked again'); v.input.write('n');
  await until(() => goals().length === 1 && /Sent to .* on @sara-box\./.test(status()) && ask.getValue() === '', 'the text alone went');
  assert.doesNotMatch(goals()[0], /Files from/); assert.match(goals()[0], /why is this cut off$/);
});

// The same for a new session on my other computer: Esc on the files question, and on the
// questions about the text alone (an older ELU there, or more than a send carries), starts
// nothing. The message stays in the box as typed, and the line says so. n starts it with the text alone.
test('Esc on the files question for a new session on my other computer starts nothing and keeps the message in the box; so does Esc on "Start it with the text only?"', { timeout: 60000 }, async t => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), laptop = team.founder, devbox = team.member;
  const home = temp(later(t)), shot = path.join(home, 'Library', 'Application Support', 'Shots', 'shot 1.png'), dropped = shot.replaceAll(' ', '\\ ');
  const values = { HOME: home, XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: laptop.home, ELU_NO_COLOR: '1', TERM: 'xterm-256color' }, previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  owned(t).files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, values);
  fs.mkdirSync(path.dirname(shot), { recursive: true }); fs.writeFileSync(shot, PNG);
  const huge = path.join(home, 'huge.bin'); fs.writeFileSync(huge, ''); fs.truncateSync(huge, BYTES_MAX + 1);
  const there = withHome(devbox.home, () => {
    const made = registeredProject(t); saveTeamAccess(team.teamId, { root: made.root });
    shareProjects(devbox.identity.key, laptop.identity.key);
    return made;
  });
  shareProjects(laptop.identity.key, devbox.identity.key);
  const link = key => ({ key, admitted: true, remoteHello: { remote: 1, files: 1, startFiles: 1 }, notify: () => {}, request: async () => { throw new Error('No answer'); } });
  const ctx = (me, sessions) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: key => key === me.key ? null : 'mac', log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
  const toHost = link(laptop.identity.key), toViewer = link(devbox.identity.key);
  const host = hostMethods(ctx(devbox.identity, { [laptop.identity.key]: toHost })), viewCtx = ctx(laptop.identity, { [devbox.identity.key]: toViewer });
  const devboxHome = temp(later(t));
  toViewer.request = async (method, params) => withHome(devbox.home, () => { const mac = process.env.HOME; process.env.HOME = devboxHome; try { return host[method](params, toHost); } finally { process.env.HOME = mac; } });
  const peer = fakePeer({ items: [], sharing: [SARA], answer: command => command.type === 'remoteStart' ? remoteCommand(viewCtx, { ...command, to: devbox.identity.key }) : null });
  Object.assign(peer, { offerFiles, offerPaths, stageFiles });
  const p = project(later(t)), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const ask = v.panels.ask, status = () => v.panels.status.getText().replace(/\s+/g, ' ');
  const asked = () => modal(v, 'Send files')?.children.map(child => child.getText?.() ?? '').join(' ').replace(/\s+/g, ' ') ?? '';
  const started = () => withHome(devbox.home, () => pendingRequests(there.root).filter(row => row.mine));
  const starts = () => peer.sent().filter(command => command.type === 'remoteStart').length;
  // Esc on a question: once it closes, nothing started, the box holds the message as typed, and the line says so.
  const escKeeps = async (typed, what) => {
    v.input.write('\x1b');
    await until(() => !modal(v, 'Send files') && (/Nothing was sent/.test(status()) || /Start(?:ed|ing) on/.test(status())), `${what}: answered`);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(started(), [], `${what}: nothing started`);
    assert.match(status(), /Nothing was sent\. The message is still here\./, what);
    assert.equal(ask.getValue(), typed, what);
  };
  ask.focus(); ask.readInput(); await until(() => ask.__listener, 'message box');
  const typed = `@sara-box ${dropped} why is this cut off`;
  v.input.write('@sara-box '); v.input.write(`\x1b[200~${dropped}\x1b[201~`); v.input.write(' why is this cut off');
  await until(() => ask.getValue() === typed, 'typed');
  v.input.write('\r');
  await until(() => /Send 1 file \(1 KB\) from this computer with this message\?/.test(asked()), 'asked');
  await escKeeps(typed, 'the files question');
  assert.equal(starts(), 0, 'nothing was asked to start there');
  // More than a send carries: "Send the text only?", and Esc keeps it too.
  const over = `@sara-box ${huge} look`;
  ask.setValue(''); await send(v, over);
  await until(() => /Send the text only\?/.test(asked()), 'asked about the text alone');
  await escKeeps(over, 'the text-only question');
  // An older ELU there: y to the files asks whether the text goes alone. Esc starts nothing.
  toViewer.remoteHello = { remote: 1, files: 1 };
  ask.setValue(''); await send(v, typed);
  await until(() => /Send 1 file/.test(asked()), 'offered'); v.input.write('y');
  await until(() => /older ELU, which takes files only into a session that has started\. Start it with the text only\?/.test(asked()), 'asked about the text alone');
  await escKeeps(typed, 'Start it with the text only?');
  // n to the files question, as before: it starts there with the text alone.
  ask.setValue(''); await send(v, typed);
  await until(() => /Send 1 file/.test(asked()), 'offered again'); v.input.write('n');
  await until(() => started().length === 1 && /Started on @sara-box/.test(status()), 'the text alone');
  assert.equal(started()[0].goal, `${dropped} why is this cut off`);
});

// @here and a CleanShot capture dropped from ~/Library, over a session on my other computer:
// my agent here runs on the computer that has the picture, but no session may read ~/Library.
// As a message to a session here does, each message to it names a copy it may read: its first,
// one that goes with that first before it starts, and one that continues it.
test('a picture dropped after @here over a session on my other computer goes to my agent here as a copy it may read', { timeout: 30000 }, async t => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), at = new Date().toISOString(), id = '44444444-4444-4444-8444-444444444444';
  const p = project(later(t)); environment(t, p.parent);
  const home = temp(later(t)), shot = path.join(home, 'Library', 'Application Support', 'Shots', 'shot 1.png'), dropped = shot.replaceAll(' ', '\\ '), before = process.env.HOME;
  process.env.HOME = home; owned(t).files.push(() => { if (before === undefined) delete process.env.HOME; else process.env.HOME = before; });
  fs.mkdirSync(path.dirname(shot), { recursive: true }); fs.writeFileSync(shot, PNG);
  const remote = [{ id, machine: SARA, createdAt: at, lastAt: at, title: 'Invoice totals fix', state: 'answered', steps: [], entries: [{ role: 'You', at, text: 'Fix the totals' }, { role: 'Opus 5.5', lead: true, at, text: 'Done.' }], approvals: [] }];
  const peer = fakePeer({ items: [], sharing: [SARA], remote }), v = await view(t, { repo: repository(p.root), dashboard: true, peer });
  const board = v.panels.board, status = () => v.panels.status.getText();
  const copies = goal => goal.match(/\/\S*elu-code-pictures\/[0-9a-f]{8}-shot-1\.png/g) ?? [];
  await until(() => board.items.map(plainItem).some(row => /Invoice totals fix/.test(row)), 'the session there is listed');
  board.focus(); selectRow(board, /Invoice totals fix/);
  await until(() => / on @sara-box /.test(v.panels.ask._label.getText()), 'the box writes to the session there');
  await send(v, `@here what is in ${dropped}`);
  await until(() => pendingRequests(p.root).some(row => row.helps), 'my agent here starts');
  const first = pendingRequests(p.root).find(row => row.helps);
  assert.ok(!first.goal.includes(dropped), `it is given the path under ~/Library, which it may not read: ${first.goal}`);
  assert.equal(copies(first.goal).length, 1, first.goal); assert.equal(first.goal, `what is in ${copies(first.goal)[0]}`);
  assert.deepEqual(fs.readFileSync(copies(first.goal)[0]), PNG);
  await until(() => /Sent to your agent here\./.test(status()), 'the line says so');
  // Before it started, the next one goes with the first, with its own copy.
  await send(v, `@here and ${dropped}`);
  await until(() => pendingRequests(p.root).find(row => row.id === first.id)?.goal.includes('\n\nand '), 'with the first message');
  const both = pendingRequests(p.root).find(row => row.id === first.id).goal;
  assert.equal(copies(both).length, 2, both); assert.ok(!both.includes(dropped), both);
  // Once it started, the next one continues it, with a copy too.
  const repo = repository(p.root);
  saveTask(repo, { id: '1', kind: 'conversation', goal: first.goal, state: 'answered', worktree: repo.root, base: null, branch: null, createdAt: at, runs: [], reviews: [], responses: [], messages: [{ at, text: first.goal }], sessions: {}, result: null, helps: first.helps });
  updateRequest(p.root, first.id, { taskId: '1', state: 'done' });
  board.focus(); selectRow(board, /^(?!.*Help:).*Invoice totals fix/);
  await send(v, `@here ${dropped} again`);
  await until(() => pendingRequests(p.root).some(row => row.continuationTaskId === '1'), 'the helper is continued');
  const next = pendingRequests(p.root).find(row => row.continuationTaskId === '1').goal;
  assert.equal(copies(next).length, 1, next); assert.equal(next, `${copies(next)[0]} again`);
});
