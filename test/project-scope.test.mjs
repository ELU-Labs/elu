import test from 'node:test';
import assert from 'node:assert/strict';
import { boardRows } from '../lib/board.mjs';
import { botChats, itemInScope, ofProject, otherTeams, projectScope, scopeChats } from '../lib/project-scope.mjs';
import { chatBar, NO_PROJECT_TEAM, NO_TEAM, visible } from '../lib/terminal-visuals.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';

// The owner made a new project and set it active: Sessions still listed the sessions of his
// other project, here and on his other computer, and Chats every channel, teammate, computer and
// bot of his other project's team. While a project is active, every list is that project's.
const now = Date.parse('2026-11-08T20:00:00Z'), at = minutes => new Date(now - minutes * 60000).toISOString();
const ME = 'a'.repeat(64), SARA = 'b'.repeat(64), KIM = 'c'.repeat(64), BOX = 'd'.repeat(64), RIO = 'e'.repeat(64);
const base = { runs: [{ role: 'lead', at: at(30) }], messages: [], createdAt: at(40) };
const shop = { name: 'shop', root: '/p/shop', activity: [], closed: [], tasks: [
  { ...base, id: '1', state: 'answered', kind: 'conversation', goal: 'Trim coupon codes', result: { summary: 'Done.' } },
  { ...base, id: '2', state: 'needs_input', goal: 'Pick the coupon rule', result: { question: 'Which rule?' } },
  { ...base, id: '3', state: 'answered', kind: 'conversation', goal: 'Standup notes', botChat: 'reviewer', result: { summary: 'Noted.' } },
], queue: [{ id: 'request-s', goal: 'Write the coupon release notes', state: 'queued', priority: 1, queuedAt: at(2), createdAt: at(2) }] };
const notes = { name: 'notes', root: '/p/notes', activity: [], closed: [], tasks: [
  { ...base, id: '1', state: 'answered', kind: 'conversation', goal: 'Sort the reading list', result: { summary: 'Sorted.' } },
], queue: [{ id: 'request-n', goal: 'Ask the advisor about the outline', state: 'queued', priority: 0, botChat: true, bot: 'advisor', queuedAt: at(1), createdAt: at(1) }] };
const schedules = [
  { id: 'schedule-s', root: '/p/shop', project: 'shop', goal: 'Check the nightly build', enabled: true, nextRunAt: new Date(now + 3600000).toISOString(), createdAt: at(60), when: { kind: 'daily', label: 'daily 9:00' } },
  { id: 'schedule-n', root: '/p/notes', project: 'notes', goal: 'Tidy the inbox', enabled: true, nextRunAt: new Date(now + 7200000).toISOString(), createdAt: at(60), when: { kind: 'daily', label: 'daily 8:00' } },
];
const approvals = [{ id: 'run-s', root: '/p/shop', taskId: '9', role: 'lead', summary: 'Run: npm install', at: at(1) }, { id: 'run-n', root: '/p/notes', taskId: '8', role: 'lead', summary: 'Edit: outline.md', at: at(1) }];
// Three teams: shop's, with sara and my other computer, notes', with kim, and one that is no project here, with rio.
const status = { key: ME, name: 'ana', teams: [
  { id: 'team-s', name: 'Core', members: [{ key: ME, name: 'ana' }, { key: SARA, name: 'sara', online: true }, { key: BOX, name: 'ana', box: 'devbox', online: true }], channels: [{ id: 'c1', name: 'release', members: [ME, SARA] }] },
  { id: 'team-n', name: 'Writers', members: [{ key: ME, name: 'ana' }, { key: KIM, name: 'kim', online: false }], channels: [] },
  { id: 'team-x', name: 'Friends', members: [{ key: ME, name: 'ana' }, { key: RIO, name: 'rio', online: true }], channels: [] },
] };
const claimed = ['team-s', 'team-n'];
const items = [
  { id: 'incoming:1', kind: 'incoming', request: 'ask', peer: SARA, name: 'sara', text: 'Where is the coupon rule?', at: at(5), root: '/p/shop', project: 'shop' },
  { id: 'held:2', kind: 'held', peer: SARA, name: 'sara', text: 'The rule is in src/rules.mjs.', at: at(4) },
  { id: 'incoming:3', kind: 'incoming', request: 'ask', peer: KIM, name: 'kim', text: 'Is the outline done?', at: at(3) },
  { id: 'draft:4', kind: 'draft', peer: null, name: 'kim', text: 'Which chapter first?', at: at(2) },
  { id: 'incoming:5', kind: 'incoming', request: 'ask', peer: KIM, name: 'kim', text: 'In the channel', at: at(2), room: { team: 'team-s', channel: null } },
  { id: 'incoming:6', kind: 'incoming', request: 'ask', peer: RIO, name: 'rio', text: 'Can you look at the flaky test?', at: at(1) },
];

test('while a project is active, Sessions lists its own sessions, approvals, schedules and teammates’ messages only, and every project’s with All projects', () => {
  const only = projectScope('/p/notes', { teams: ['team-n'], claimed, status });
  // Its teams: notes' own, and rio's, which no project here is.
  assert.deepEqual([...only.teams], ['team-n', 'team-x']); assert.deepEqual([...only.peers], [KIM, RIO]); assert.deepEqual([...only.others].sort(), [SARA, BOX].sort());
  const scoped = boardRows([shop, notes], now, { items, schedules, approvals, only }), all = boardRows([shop, notes], now, { items, schedules, approvals });
  const what = rows => rows.map(row => `${row.kind} ${row.root} ${row.kind === 'peer' ? row.item.id : row.kind === 'schedule' ? row.schedule.id : row.kind === 'approval' ? row.approval.id : row.id || row.request?.id}`);
  // Every row is the project's, whatever it is: a session, a queued message, a schedule, an approval.
  assert.ok(scoped.filter(row => row.kind !== 'peer').every(row => row.root === '/p/notes'), what(scoped).join('\n'));
  assert.ok(!what(scoped).some(text => /shop|request-s|schedule-s|run-s/.test(text)), what(scoped).join('\n'));
  assert.ok(['task /p/notes 1', 'request /p/notes request-n', 'schedule /p/notes schedule-n', 'approval /p/notes run-n'].every(text => what(scoped).includes(text)), what(scoped).join('\n'));
  // A teammate's message is the project's by the project it runs in, else by its channel's team, else by who it is with.
  // One of no project here (rio's team is none's) waits for the owner in every project: it is never out of reach.
  assert.deepEqual(scoped.filter(row => row.kind === 'peer').map(row => row.item.id).sort(), ['draft:4', 'incoming:3', 'incoming:6']);
  assert.deepEqual(items.map(item => ofProject(item, only)), [false, false, true, true, false, true]);
  assert.equal(ofProject({ id: 'x', kind: 'incoming', peer: 'f'.repeat(64) }, only), null); assert.equal(itemInScope({ id: 'x', kind: 'incoming', peer: 'f'.repeat(64) }, only), true);
  // All projects: everything, as before.
  assert.ok(['task /p/shop 2', 'request /p/shop request-s', 'schedule /p/shop schedule-s', 'approval /p/shop run-s', 'peer /p/shop incoming:1'].every(text => what(all).includes(text)), what(all).join('\n'));
  assert.equal(projectScope(null), null); assert.equal(itemInScope(items[0], null), true);
});

test('while a project is active, Chats lists its team’s channels and people and the chats with my bots started in it, and a project with no team says so', () => {
  const lines = bar => bar.map(row => visible(row.line).replace(/\s+/g, ' ').trim()), two = { ...status, teams: status.teams.slice(0, 2) };
  // A team no project here is shows in every project.
  assert.deepEqual(scopeChats({ status, items }, projectScope('/p/notes', { teams: ['team-n'], claimed, status })).status.teams.map(team => team.id), ['team-n', 'team-x']);
  const frame = { on: true, status: two, items, agents: [{ peer: SARA, name: 'sara', online: true, rows: [] }, { peer: KIM, name: 'kim', online: false, rows: [] }], bots: ['reviewer', 'lead', 'advisor', 'elu'].map(name => ({ name, about: '' })) };
  // A bot's chat in a project: a session of it that is not archived, or the message that starts one.
  assert.deepEqual([...botChats(shop)], ['reviewer']); assert.deepEqual([...botChats(notes)], ['advisor']);
  assert.deepEqual([...botChats({ ...shop, closed: ['3'] })], []);
  const notesChats = scopeChats(frame, projectScope('/p/notes', { teams: ['team-n'], claimed, status: two }), botChats(notes));
  assert.deepEqual(notesChats.status.teams.map(team => team.id), ['team-n']); assert.deepEqual(notesChats.agents.map(mate => mate.name), ['kim']);
  assert.deepEqual(notesChats.items.map(item => item.id), ['incoming:3', 'draft:4', 'incoming:6']);
  assert.deepEqual(lines(chatBar(notesChats, 60, false)), ['Channels', '# general 2', '+ Add channel', '', 'Direct messages', '○ @kim offline 2', '◆ @advisor', '+ Add teammate']);
  // A project of no team lists no one, says so, and keeps the chats with my bots started in it.
  const alone = scopeChats(frame, projectScope('/p/shop', { teams: [], claimed, status: two }), botChats(shop));
  assert.deepEqual(lines(chatBar(alone, 60, false)), [...NO_PROJECT_TEAM.split('\n'), '', 'Direct messages', '◆ @reviewer']);
  assert.deepEqual(lines(chatBar(scopeChats(frame, projectScope('/p/shop', { teams: [], claimed, status: two }), new Set()), 60, false)), NO_PROJECT_TEAM.split('\n'));
  // On no team at all, it says no team, as before, and keeps them too.
  const teamless = { ...frame, status: { ...two, teams: [] } };
  assert.deepEqual(lines(chatBar(scopeChats(teamless, projectScope('/p/shop', { status: teamless.status }), botChats(shop)), 60, false)), [...NO_TEAM.split('\n'), '', 'Direct messages', '◆ @reviewer']);
  // Projects offers All projects while I am on a team of another project.
  assert.equal(otherTeams(projectScope('/p/notes', { teams: ['team-n'], claimed, status }), status), true);
  assert.equal(otherTeams(projectScope('/p/notes', { teams: ['team-n'], claimed: ['team-n'], status }), status), false); assert.equal(otherTeams(null, status), false);
  // All projects: every team, as before.
  assert.equal(scopeChats(frame, null), frame); assert.deepEqual(lines(chatBar({ ...frame, status: { ...two, teams: [] } }, 60, false)), NO_TEAM.split('\n'));
});

test('while a project is active, the sessions of my other computer show by the project both computers share, not by its name', () => {
  // My devbox lists two projects: one it calls "notes" that is shop's team's project, and "writing", notes' team's project here.
  const SHOP = '1'.repeat(16), WRITING = '2'.repeat(16);
  const item = (project, n, title, extra = {}) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, ref: `${project}:${n}`, project, title, state: 'needs_input', question: 'Which one?', at: at(n), createdAt: at(n + 1), approvals: [], by: 'you', who: null, repoId: null, ...extra });
  const machine = { key: BOX, listedAt: at(0), older: false, projects: [{ id: SHOP, name: 'notes', repoId: null, teams: ['team-s'] }, { id: WRITING, name: 'writing', repoId: null, teams: ['team-n'] }],
    sessions: [item(SHOP, 1, 'Pick the coupon rule'), item(WRITING, 2, 'Outline the second chapter'), item(SHOP, 3, 'Started from here', { remoteId: '00000000-0000-4000-8000-0000000000ff' })] };
  // One started from here, in shop's project there, and listed; one started from here that it has not listed yet, of shop's project there.
  const views = [{ id: '00000000-0000-4000-8000-0000000000ff', machine: BOX, createdAt: at(4), state: 'needs_input', title: 'Started from here', question: 'Which one?', entries: [], steps: [], approvals: [] },
    { id: '00000000-0000-4000-8000-0000000000ee', machine: BOX, createdAt: at(1), state: 'needs_input', title: 'Not listed yet', projectId: SHOP, entries: [], steps: [], approvals: [] }];
  const facade = { remoteSessions: () => views, remoteMachines: () => [machine], projectRepoId: () => null, projectRepoIds: () => [], teamProjectRoots: () => [{ team: 'team-s', root: '/p/shop', name: 'shop' }, { team: 'team-n', root: '/p/notes', name: 'notes' }] };
  const glue = remoteGlue({ facade, peerRead: () => status, peerCommand: async () => ({}), chatMessage: ({ title, text }) => `${title}\n${text}`, ink: text => text, colour: false, restMs: 1e9 });
  let n = 0;
  const titles = rows => rows.map(row => row.remote.title).sort();
  const sections = (root, only) => glue.sections(now + 1000 * ++n, root, [], { only }).filter(line => line.row).map(line => line.row);
  assert.deepEqual([...glue.teamsOf('/p/notes')], ['team-n']);
  // Needs you: only what waits in the active project.
  assert.deepEqual(titles(glue.rows(now + 1000 * ++n, '/p/notes')), ['Outline the second chapter']);
  assert.deepEqual(titles(glue.rows(now + 1000 * ++n, '/p/shop')), ['Not listed yet', 'Pick the coupon rule', 'Started from here']);
  assert.deepEqual(titles(glue.rows(now + 1000 * ++n)), ['Not listed yet', 'Outline the second chapter', 'Pick the coupon rule', 'Started from here']);
  // Under the devbox: the project's only, those started from here in another project too.
  assert.deepEqual(titles(sections('/p/notes', true)), ['Outline the second chapter']);
  assert.deepEqual(titles(sections('/p/notes', false)), ['Not listed yet', 'Outline the second chapter', 'Started from here']);
  assert.deepEqual(titles(sections('/p/shop', true)), ['Not listed yet', 'Pick the coupon rule', 'Started from here']);
  // Something of my devbox is not shown: Projects offers All projects.
  assert.equal(glue.hides(now + 1000 * ++n, '/p/notes'), true); assert.equal(glue.hides(now + 1000 * ++n, '/p/shop'), true);
  assert.equal(remoteGlue({ facade: { ...facade, remoteMachines: () => [{ ...machine, sessions: [machine.sessions[1]] }], remoteSessions: () => [] }, peerRead: () => status, peerCommand: async () => ({}), chatMessage: () => '', ink: text => text, colour: false, restMs: 1e9 }).hides(now, '/p/notes'), false);
});
