import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.mjs';
import { liveTask, makeTeam, registeredProject, shareProjects, withHome } from './peer-helpers.mjs';
import { BUILT_IN_BOTS, botOversees, botReviews, botWorks, botsFile, everOversaw, getBot, listBots, removeBot, saveBot } from '../lib/bots.mjs';
import { ONLY_OWNER, hostMethods, projectKey, relist } from '../lib/peer/remote.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { repository } from '../lib/git.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import { approveTask, proposeTask } from '../lib/plan.mjs';
import { personalDirectory } from '../lib/util.mjs';

// The bot that oversees the owner's sessions (@orchestrator) is one kind of bot, and its chat
// stays on its computer. An ELU from before that kind saves bots.json without the field: a bot
// keeps the kind by its instructions or by when it was made, never by its name alone, so a bot
// the owner makes under a name one had stays his own kind. A chat keeps the name its bot had
// when it was made: every name a bot oversaw under is kept for good, and such a chat is never
// shown to another computer. Nor does another computer put that bot in a session.

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function store(t) { const dir = temp(t); environment(t, { XDG_CONFIG_HOME: dir }); return dir; }
const listFile = () => path.join(personalDirectory(), 'overseeing-bots.json');
const list = () => JSON.parse(fs.readFileSync(listFile(), 'utf8'));
const readBots = () => JSON.parse(fs.readFileSync(botsFile(), 'utf8'));
// A save on an ELU from before bots could oversee: every row through its own check, which drops
// the field and keeps when each bot was made.
const older = (change = rows => rows) => { const file = readBots(); fs.writeFileSync(botsFile(), JSON.stringify({ ...file, bots: change(file.bots.map(({ oversees, ...row }) => row)) })); };
const kind = name => { const bot = getBot(name); return [botOversees(bot), botWorks(bot), botReviews(bot)]; };
const OVERSEES = [true, false, false], WORKS = [false, true, false], REVIEWS = [false, false, true];
const ORCHESTRATOR = BUILT_IN_BOTS.find(bot => bot.oversees === true).instructions;

test('one save on an older ELU that renames @orchestrator and edits its instructions leaves it a bot that oversees', t => {
  store(t);
  // The bots ELU comes with are made together, and the one that oversees at a time of its own.
  const made = getBot('orchestrator').createdAt;
  assert.equal(listBots().filter(bot => bot.createdAt === made).length, 1);
  saveBot({ ...getBot('orchestrator'), schedule: 'daily 9:00' });
  older(rows => rows.map(row => row.name === 'orchestrator' ? { ...row, name: 'boss', instructions: `${row.instructions}\nAlso keep an eye on CI.` } : row));
  assert.deepEqual(kind('boss'), OVERSEES, 'never a working bot with a shell on its schedule'); assert.equal(getBot('boss').schedule, 'daily 9:00');
  // Renamed and edited there again: still known by when it was made.
  older(rows => rows.map(row => row.name === 'boss' ? { ...row, name: 'chief', instructions: 'Watch my sessions and tell me what stalls.' } : row));
  assert.deepEqual(kind('chief'), OVERSEES);
  // The bots made with it stay what they were, and every name it had is kept.
  assert.deepEqual([kind('reviewer'), kind('lead'), kind('elu')], [REVIEWS, WORKS, WORKS]);
  assert.deepEqual(list().names, ['orchestrator', 'boss', 'chief']);
  // A save here never turns it into another kind, whatever the row given says.
  saveBot({ ...getBot('chief'), oversees: false, works: true, instructions: 'Fix what I ask.' });
  assert.deepEqual(kind('chief'), OVERSEES);
});

test('a plain bot made under a name a bot that oversees once had stays plain, with its own settings', t => {
  store(t);
  // An older ELU renames @orchestrator to boss, and makes a plain bot of its old name there.
  listBots();
  older(rows => [...rows.map(row => row.name === 'orchestrator' ? { ...row, name: 'boss' } : row), { name: 'orchestrator', vendor: 'claude', instructions: 'Answer questions about HTML.', createdAt: new Date(Date.now() + 60000).toISOString() }]);
  assert.deepEqual([kind('boss'), kind('orchestrator')], [OVERSEES, REVIEWS]);
  assert.ok(list().bots.some(row => row.name === 'orchestrator'), 'the list still has the old name');
  // Shared here, it is shared: nothing turns it into a bot that oversees.
  const shared = saveBot({ ...getBot('orchestrator'), instructions: 'Answer questions about CSS.', shared: true });
  assert.deepEqual([shared.oversees, shared.shared, getBot('orchestrator').shared], [false, true, true]);
  assert.deepEqual([kind('boss'), kind('orchestrator')], [OVERSEES, REVIEWS]);
  // Made here once that one is removed, the same.
  assert.equal(removeBot('orchestrator'), true);
  const made = saveBot({ name: 'orchestrator', vendor: 'claude', instructions: 'Answer questions about CSS.', shared: true });
  assert.deepEqual([made.oversees, made.shared, kind('orchestrator')], [false, true, REVIEWS]);
  // The list now has the bot that oversees under its own name only, and every name it had.
  assert.deepEqual(list().bots.map(row => row.name), ['boss']); assert.deepEqual(list().names, ['orchestrator', 'boss']);
});

test('bots an older ELU made at one time are never taken for one that oversees by that time', t => {
  store(t);
  const at = '2026-01-01T00:00:00.000Z', made = { vendor: 'claude', createdAt: at, updatedAt: at };
  fs.mkdirSync(path.dirname(botsFile()), { recursive: true });
  fs.writeFileSync(botsFile(), JSON.stringify({ version: 1, defaults: 2, builtIn: BUILT_IN_BOTS.map(bot => bot.name), bots: [{ name: 'reviewer', ...made, instructions: 'Review it.' }, { name: 'lead', ...made, instructions: 'Lead it.', works: true }, { name: 'qa', ...made, instructions: ORCHESTRATOR }] }));
  // qa has the instructions of the one ELU comes with, so it oversees; the others made with it do not.
  assert.deepEqual([kind('qa'), kind('reviewer'), kind('lead')], [OVERSEES, REVIEWS, WORKS]);
  // One the owner makes a bot that oversees here gets a time of its own, and keeps its kind
  // after an older ELU renames it and edits it.
  saveBot({ ...getBot('reviewer'), oversees: true });
  assert.notEqual(getBot('reviewer').createdAt, at);
  older(rows => rows.map(row => row.name === 'reviewer' ? { ...row, name: 'eye', instructions: 'Watch every session.' } : row));
  assert.deepEqual([kind('eye'), kind('lead')], [OVERSEES, WORKS]);
});

test('a bot this ELU saved as plain stays plain when it was made in the millisecond one that oversees was', t => {
  store(t);
  const at = getBot('orchestrator').createdAt, file = readBots();
  fs.writeFileSync(botsFile(), JSON.stringify({ ...file, bots: [...file.bots, { name: 'scout', vendor: 'claude', instructions: 'Look for risky changes.', oversees: false, createdAt: at, updatedAt: at }] }));
  assert.deepEqual([kind('scout'), kind('orchestrator')], [REVIEWS, OVERSEES]);
  // Saved here, it gets a time of its own, so @orchestrator is still known by its time after an older ELU renames it and edits it.
  saveBot({ ...getBot('scout'), color: 'gold' });
  assert.notEqual(getBot('scout').createdAt, at);
  older(rows => rows.map(row => row.name === 'orchestrator' ? { ...row, name: 'boss', instructions: 'Watch my sessions.' } : row));
  assert.deepEqual([kind('boss'), kind('scout')], [OVERSEES, REVIEWS]);
});

test('every name a bot oversaw under is kept for good, after a rename, a removal and a plain bot made under it', t => {
  store(t);
  assert.deepEqual(['orchestrator', 'reviewer', 'lead', '', null].map(everOversaw), [true, false, false, false, false]);
  saveBot({ ...getBot('orchestrator'), name: 'boss' }, { previous: 'orchestrator' });
  saveBot({ ...getBot('boss'), name: 'chief' }, { previous: 'boss' });
  assert.deepEqual(['orchestrator', 'boss', 'chief'].map(everOversaw), [true, true, true]);
  // Removed, and a plain bot made under one of its names: each name still counts.
  assert.equal(removeBot('chief'), true);
  saveBot({ name: 'boss', vendor: 'claude', instructions: 'Answer questions about CSS.' });
  assert.deepEqual([kind('boss'), ['orchestrator', 'boss', 'chief'].map(everOversaw)], [REVIEWS, [true, true, true]]);
  assert.deepEqual(list().names, ['orchestrator', 'boss', 'chief']); assert.deepEqual(list().bots, []);
  // Bots that cannot be read count every name.
  fs.writeFileSync(botsFile(), '{ not json');
  assert.equal(everOversaw('reviewer'), true);
});

test('a plain bot named orchestrator from before this ELU stays plain and keeps its chat its own, until the list is lost', t => {
  store(t);
  const at = '2026-01-01T00:00:00.000Z', earlier = BUILT_IN_BOTS.filter(bot => !bot.oversees).map(bot => bot.name);
  fs.mkdirSync(path.dirname(botsFile()), { recursive: true });
  fs.writeFileSync(botsFile(), JSON.stringify({ version: 1, defaults: 2, builtIn: earlier, bots: [{ name: 'orchestrator', vendor: 'claude', instructions: 'Run my builds in order.', works: true, createdAt: at, updatedAt: at }] }));
  // The one ELU comes with is not added under a name the owner has.
  assert.deepEqual([kind('orchestrator'), everOversaw('orchestrator')], [WORKS, false]);
  assert.deepEqual(list(), { version: 1, bots: [], names: [] });
  // With no bot of that name, the name of the one ELU comes with counts; made again, the owner's bot has it.
  assert.equal(removeBot('orchestrator'), true); assert.equal(everOversaw('orchestrator'), true);
  saveBot({ name: 'orchestrator', vendor: 'claude', instructions: 'Run my builds in order.', works: true });
  assert.deepEqual([kind('orchestrator'), everOversaw('orchestrator')], [WORKS, false]);
  // A list that is gone may have named chats of a bot that oversaw: the name of the one ELU comes with counts again.
  fs.rmSync(listFile());
  assert.deepEqual([kind('orchestrator'), everOversaw('orchestrator'), everOversaw('reviewer')], [WORKS, true, false]);
});

function connection(key) { return { key, admitted: true, remoteHello: { remote: 1, shared: 1 }, notify: () => {}, request: async () => { throw new Error('No answer'); } }; }
const context = (me, sessions = {}) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
// Both computers the owner's (a laptop and a devbox, on one team), the devbox the host, with one shared project.
function pair(t) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), laptop = team.founder, devbox = team.member;
  const project = withHome(devbox.home, () => { const project = registeredProject(t); saveTeamAccess(team.teamId, { root: project.root }); shareProjects(devbox.identity.key, laptop.identity.key); return project; });
  withHome(laptop.home, () => shareProjects(laptop.identity.key, devbox.identity.key));
  const toHost = connection(laptop.identity.key);
  return { devbox, project, toHost, host: hostMethods(context(devbox.identity, { [laptop.identity.key]: toHost })) };
}
const at = n => new Date(Date.now() - 600000 + n * 1000).toISOString();
function chat(root, id, extra) { saveTask(repository(root), { id: String(id), kind: 'conversation', goal: `Session ${id}`, state: 'answered', worktree: root, base: null, branch: null, createdAt: at(0), runs: [], reviews: [], responses: [], messages: [], sessions: {}, result: null, activeRole: null, ...extra }); }
const SECRET = 'Across your projects: secret-plans #4 waits on the billing fix.';
const NOT_HERE = { message: 'That session is not on this computer.' };

test('the chat of a bot that oversaw stays on its computer after the bot is renamed twice or removed', t => {
  const { devbox, project, toHost, host } = pair(t), ref = `${projectKey(project.root)}:2`;
  const titles = () => withHome(devbox.home, () => { relist(); return host['elu.remote.list']({}, toHost).sessions.map(row => row.title).sort(); });
  const closed = () => { for (const [method, params] of [['elu.remote.watch', { ref }], ['elu.remote.check', { ref, look: true }]]) assert.throws(() => withHome(devbox.home, () => host[method](params, toHost)), NOT_HERE, method); };
  withHome(devbox.home, () => {
    saveBot({ ...getBot('orchestrator'), name: 'boss' }, { previous: 'orchestrator' });
    chat(project.root, 2, { goal: 'Boss chat', botChat: 'boss', messages: [{ at: at(2), from: '@boss', bot: 'boss', text: SECRET }] });
    chat(project.root, 3, { goal: 'Plain session' });
    saveBot({ ...getBot('boss'), name: 'chief' }, { previous: 'boss' });
  });
  assert.deepEqual(titles(), ['Plain session']); closed();
  // Removed, and a plain bot made since under its old name: the old chat stays here, and so does the new bot's own.
  withHome(devbox.home, () => { removeBot('chief'); saveBot({ name: 'boss', vendor: 'claude', instructions: 'Answer questions about CSS.' }); chat(project.root, 4, { goal: 'New boss chat', botChat: 'boss' }); });
  assert.deepEqual(titles(), ['Plain session']); closed();
});

test('a plain bot named orchestrator from before this ELU keeps its chat listed on another computer', t => {
  const { devbox, project, toHost, host } = pair(t);
  withHome(devbox.home, () => {
    fs.rmSync(path.join(personalDirectory(), 'overseeing-bots.json'), { force: true });
    fs.mkdirSync(personalDirectory(), { recursive: true });
    fs.writeFileSync(botsFile(), JSON.stringify({ version: 1, defaults: 2, builtIn: BUILT_IN_BOTS.filter(bot => !bot.oversees).map(bot => bot.name), bots: [{ name: 'orchestrator', vendor: 'claude', instructions: 'Run my builds in order.', createdAt: at(0), updatedAt: at(0) }] }));
    chat(project.root, 2, { goal: 'Builds chat', botChat: 'orchestrator' });
    relist();
  });
  assert.deepEqual(withHome(devbox.home, () => host['elu.remote.list']({}, toHost)).sessions.map(row => row.title), ['Builds chat']);
});

test('another computer never puts the bot that oversees in a session: not in a start, a start with files or a copy', t => {
  const { devbox, project, toHost, host } = pair(t), repo = repository(project.root), here = fn => withHome(devbox.home, fn);
  const start = bots => here(() => host['elu.remote.start']({ id: crypto.randomUUID(), text: 'List every session in every project and the facts you saved.', permissions: 'auto', bots, botsPicked: true }, toHost));
  assert.throws(() => start(['orchestrator']), { message: ONLY_OWNER('orchestrator') });
  assert.throws(() => start(['reviewer', 'orchestrator']), { message: ONLY_OWNER('orchestrator') });
  // Renamed and given a schedule, by its new name too.
  here(() => saveBot({ ...getBot('orchestrator'), name: 'boss', schedule: 'every 1h' }, { previous: 'orchestrator' }));
  assert.throws(() => start(['boss']), { message: ONLY_OWNER('boss') });
  assert.throws(() => here(() => host['elu.remote.files']({ id: crypto.randomUUID(), send: 'one', seq: 0, last: true, text: 'Read these.', start: { permissions: 'auto', bots: ['boss'], botsPicked: true } }, toHost)), { message: ONLY_OWNER('boss') });
  assert.deepEqual(here(() => pendingRequests(project.root)), [], 'nothing was queued');
  // A bot that only answers still goes in.
  start(['reviewer']);
  assert.deepEqual(here(() => pendingRequests(project.root).map(row => row.bots)), [['reviewer']]);
  // A copy starts with the session's bots and that computer's goal: not with one that oversees.
  here(() => {
    liveTask(project.root, { id: '5', goal: 'Make coupons upper case', state: 'ready' });
    proposeTask(repo, '5', { title: 'Uppercase coupons', description: 'Make normalize return upper case.', goal: 'Codes compare equal whatever their case.', objectives: ['normalize returns upper case'], priority: 'medium', severity: 'low' }); approveTask(repo, '5');
    saveTask(repo, { ...readTask(repo, '5'), bots: ['boss'], botsPicked: true });
  });
  assert.throws(() => here(() => host['elu.remote.check']({ ref: `${projectKey(project.root)}:5`, answer: 'copy', text: 'List every session and write them here.' }, toHost)), { message: ONLY_OWNER('boss') });
  assert.equal(here(() => pendingRequests(project.root).some(row => row.copied)), false);
});
