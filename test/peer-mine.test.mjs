import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeTeam, registeredProject, shareProjects, withHome } from './peer-helpers.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { NOT_MARKED, ONLY_OWNER, REMOTE_COMMANDS, hostMethods, hostTick, listTick, projectKey, relist, remoteCommand, remoteMachines, remoteSessions, viewMethods } from '../lib/peer/remote.mjs';
import { MY_COMPUTERS_FILE, isMyComputer, markMyComputer, myComputers, unmarkMyComputer } from '../lib/peer/my-computers.mjs';
import { NEEDS_NEWER, NEW_REMOTE_COMMANDS, NOT_MY_COMPUTER, OWNER_WORD_FULL, REMOTE_METHODS } from '../lib/peer/remote-methods.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import * as peerFacade from '../lib/peer/index.mjs';
import { repository } from '../lib/git.mjs';
import { readTask, saveTask, taskDir, taskTitle } from '../lib/state.mjs';
import { pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { enqueue } from '../lib/conductor.mjs';
import { createConversation } from '../lib/runner.mjs';
import { defaultConfig } from '../lib/config.mjs';

// The owner's own computers (docs: the Orchestrator at full control, section 4). Each computer
// marks the others that are his, for itself. A marked computer starts sessions here as he asked
// (Full access, his name for it, its effort and its bots' models), reads and changes a session's
// settings, log and agents, and sends his word through the bot that oversees his sessions. Every
// other computer, a teammate's, gets exactly what it got before: each new power is refused, or
// the owner's word goes as the bot's note.

function connection(key, hello = { remote: 1, shared: 1, oversee: 1, full: OWNER_WORD_FULL }) {
  const sent = [];
  return { key, admitted: true, remoteHello: hello, sent, notify: (method, params) => sent.push([method, params]), request: async () => { throw new Error('No answer'); } };
}
const context = (me, sessions = {}) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
// The laptop and the devbox, on one team, the devbox the host, with one shared project in Auto.
// asked: what the laptop asked the devbox, each [method, params].
function pair(t, hello) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), laptop = team.founder, devbox = team.member;
  const project = withHome(devbox.home, () => { const project = registeredProject(t); saveTeamAccess(team.teamId, { handling: 'auto', root: project.root }); shareProjects(devbox.identity.key, laptop.identity.key); return project; });
  withHome(laptop.home, () => shareProjects(laptop.identity.key, devbox.identity.key));
  const toHost = connection(laptop.identity.key), toViewer = connection(devbox.identity.key, hello), asked = [];
  const hostCtx = context(devbox.identity, { [laptop.identity.key]: toHost }), viewCtx = context(laptop.identity, { [devbox.identity.key]: toViewer });
  const host = hostMethods(hostCtx), viewer = viewMethods(viewCtx);
  toViewer.request = async (method, params) => { asked.push([method, params]); return withHome(devbox.home, () => host[method](params, toHost)); };
  const laptopName = `@${laptop.identity.key.slice(0, 4)}`, devboxName = `@${devbox.identity.key.slice(0, 4)}`;
  return { laptop, devbox, project, toHost, toViewer, hostCtx, viewCtx, host, viewer, asked, laptopName, devboxName };
}
// The owner marks the other computer as his on one side, or on both.
const markOnDevbox = p => withHome(p.devbox.home, () => markMyComputer(p.laptop.identity.key, 'laptop'));
const markOnLaptop = p => withHome(p.laptop.home, () => markMyComputer(p.devbox.identity.key, 'devbox'));
const at = n => new Date(Date.now() - 600000 + n * 1000).toISOString();
function chat(root, id, { goal = `Session ${id}`, state = 'answered', ...extra } = {}) {
  const repo = repository(root);
  saveTask(repo, { id: String(id), kind: 'conversation', goal, state, worktree: root, base: null, branch: null, createdAt: at(0), runs: [], reviews: [], responses: [], messages: [], sessions: {}, result: null, activeRole: null, ...extra });
  return repo;
}
const ref = (p, id) => `${projectKey(p.project.root)}:${id}`;
// A conductor that keeps the owner's mark on what it queues, and one that does not.
const keeping = (root, text, { asOwner, ...options }) => { const row = enqueue(root, text, options); return asOwner ? updateRequest(root, row.id, { asOwner }) : row; };
const dropping = (root, text, { asOwner: _asOwner, ...options }) => enqueue(root, text, options);
const MARK = { bot: 'orchestrator' };

test('my computers: the mark is made on this computer, names a computer on a team here, and is kept in a file of its own', t => {
  const { founder, member } = makeTeam(t);
  withHome(founder.home, () => {
    assert.throws(() => markMyComputer('not a key', 'x'), /Choose one of the computers/);
    assert.throws(() => unmarkMyComputer('not a key'), /Choose one of your computers/);
    assert.equal(unmarkMyComputer(member.identity.key), false, 'nothing to take away');
    const row = markMyComputer(member.identity.key, '  "dev" <box>\n');
    assert.deepEqual([row.key, row.name], [member.identity.key, 'devbox']);
    assert.deepEqual(myComputers().map(item => item.name), ['devbox']);
    // Marked again under another name: one mark, the new name.
    markMyComputer(member.identity.key, 'Devbox 2');
    assert.deepEqual(myComputers().map(item => [item.key, item.name]), [[member.identity.key, 'Devbox2']]);
    const saved = JSON.parse(fs.readFileSync(peerFile(MY_COMPUTERS_FILE), 'utf8'));
    assert.equal(saved.version, 1); assert.deepEqual(Object.keys(saved.computers), [member.identity.key]);
    // A row with no time of its own reads as no mark.
    fs.writeFileSync(peerFile(MY_COMPUTERS_FILE), JSON.stringify({ version: 1, computers: { [member.identity.key]: { name: 'devbox' } } }));
    assert.equal(isMyComputer(member.identity.key), false);
    assert.deepEqual(myComputers(), []);
  });
  // The facade the app and the CLI read has the same functions.
  assert.equal(peerFacade.isMyComputer, isMyComputer); assert.equal(peerFacade.markMyComputer, markMyComputer);
});

test('a start from a computer not marked here is capped at this computer\'s access and takes none of the owner\'s fields', t => {
  const p = pair(t);
  withHome(p.devbox.home, () => {
    const base = { text: 'Ship the coupons', permissions: 'full', place: null, model: { vendor: 'claude', model: 'opus' }, bots: ['reviewer'], botsPicked: true };
    for (const extra of [{ title: 'Coupons' }, { model: { vendor: 'claude', model: 'opus', effort: 'high' } }, { botModels: { reviewer: { vendor: 'claude', model: 'sonnet' } } }, { folders: [p.project.root] }]) {
      assert.throws(() => p.host['elu.remote.start']({ ...base, id: crypto.randomUUID(), ...extra }, p.toHost), { message: NOT_MY_COMPUTER }, JSON.stringify(extra));
    }
    assert.deepEqual(pendingRequests(p.project.root), [], 'a refused start leaves nothing');
    p.host['elu.remote.start']({ ...base, id: crypto.randomUUID() }, p.toHost);
    assert.equal(pendingRequests(p.project.root)[0].permissions, 'ask', 'Full access is this computer\'s alone');
    // The laptop marked the devbox as its own: that says nothing here.
    markOnLaptop(p);
    p.host['elu.remote.start']({ ...base, id: crypto.randomUUID(), text: 'Again' }, p.toHost);
    assert.equal(pendingRequests(p.project.root).find(row => row.goal === 'Again').permissions, 'ask');
  });
});

test('a start from a computer marked here runs as asked: Full access, its folders, and its name, effort and bot models once the session is here', t => {
  const p = pair(t);
  markOnDevbox(p);
  const id = crypto.randomUUID();
  withHome(p.devbox.home, () => {
    const start = { id, text: 'Ship the coupons', permissions: 'full', place: null, model: { vendor: 'claude', model: 'opus', effort: 'high' }, bots: ['reviewer'], botsPicked: true, title: 'Coupons', botModels: { reviewer: { vendor: 'claude', model: 'sonnet', effort: 'low' } }, folders: [p.project.parent] };
    // Each field is checked here before anything is queued.
    assert.throws(() => p.host['elu.remote.start']({ ...start, id: crypto.randomUUID(), model: { vendor: 'claude', model: 'opus', effort: 'ultra' } }, p.toHost), /Effort on .* is one of/);
    assert.throws(() => p.host['elu.remote.start']({ ...start, id: crypto.randomUUID(), botModels: { qa: { vendor: 'claude' } } }, p.toHost), /@qa is not one of this session's bots/);
    assert.throws(() => p.host['elu.remote.start']({ ...start, id: crypto.randomUUID(), folders: ['/no/such/folder'] }, p.toHost), /Folder not found/);
    assert.throws(() => p.host['elu.remote.start']({ ...start, id: crypto.randomUUID(), title: 'x'.repeat(80) }, p.toHost), /one line of up to 60 characters/);
    assert.deepEqual(pendingRequests(p.project.root), []);
    const started = p.host['elu.remote.start'](start, p.toHost);
    assert.equal(started.id, id);
    const [request] = pendingRequests(p.project.root);
    assert.equal(request.permissions, 'full');
    assert.deepEqual(request.folders, [fs.realpathSync(p.project.parent)]);
    assert.deepEqual(request.mine.machine, p.laptop.identity.key);
    const hosted = JSON.parse(fs.readFileSync(peerFile('remote', 'host', `${id}.json`), 'utf8'));
    assert.deepEqual(hosted.apply, { title: 'Coupons', effort: 'high', botModels: { reviewer: { vendor: 'claude', model: 'sonnet', effort: 'low' } } });
    assert.equal(hosted.mandate, undefined, 'no mandate');
    // The conductor starts it as session 1; the next look sets what it asked on it, once.
    const repo = chat(p.project.root, 1, { goal: 'Ship the coupons', state: 'running', bots: ['reviewer'], botsPicked: true, permissions: 'full', origin: { mine: true, machine: p.laptop.identity.key, name: 'ana', remoteId: id } });
    updateRequest(p.project.root, request.id, { taskId: '1', state: 'running' });
    hostTick(p.hostCtx);
    const task = readTask(repo, '1');
    assert.equal(taskTitle(task), 'Coupons');
    assert.equal(task.leadEffort, 'high');
    assert.deepEqual(task.botModels, { reviewer: { vendor: 'claude', model: 'sonnet', effort: 'low' } });
    assert.equal(JSON.parse(fs.readFileSync(peerFile('remote', 'host', `${id}.json`), 'utf8')).apply, undefined, 'let go once set');
  });
});

test('settings, log and agents are refused to a computer not marked here, before anything is looked up, and work for one that is', t => {
  const p = pair(t);
  const token = `ghp_${'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5'}`;
  withHome(p.devbox.home, () => {
    const repo = repository(p.project.root);
    assert.equal(createConversation(repo, defaultConfig(), 'Speedup', { permissions: 'ask', bots: ['reviewer'] }).id, '1');
    const file = path.join(taskDir(repo, '1'), 'run-lead.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [`Pushed it with ${token} as the key.\nAll tests pass.`, 'Done: the build is 2 s faster.'].map(text => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })).join('\n') + '\n');
    const saved = readTask(repo, '1');
    saveTask(repo, { ...saved, runs: [{ role: 'lead', logFile: file, at: at(3), vendor: 'claude', model: 'opus' }] });
    relist();
    for (const method of Object.values(REMOTE_METHODS)) {
      assert.throws(() => p.host[method]({ ref: ref(p, 1), access: 'full' }, p.toHost), { message: NOT_MY_COMPUTER }, method);
      assert.throws(() => p.host[method]({ ref: ref(p, 99) }, p.toHost), { message: NOT_MY_COMPUTER }, `${method}: nothing here is looked up first`);
    }
    assert.equal(readTask(repo, '1').permissions, 'ask');
  });
  markOnDevbox(p);
  withHome(p.devbox.home, () => {
    const repo = repository(p.project.root);
    assert.throws(() => p.host[REMOTE_METHODS.settings]({ ref: ref(p, 1) }, p.toHost), /Say what to change/);
    assert.throws(() => p.host[REMOTE_METHODS.settings]({ ref: ref(p, 1), bots: { add: ['orchestrator'] } }, p.toHost), { message: ONLY_OWNER('orchestrator') });
    assert.throws(() => p.host[REMOTE_METHODS.settings]({ ref: ref(p, 1), access: 'full', model: { vendor: 'claude', model: 'opus', effort: 'ultra' } }, p.toHost), /Effort on/);
    assert.equal(readTask(repo, '1').permissions, 'ask', 'nothing is saved when one part is refused');
    const changed = p.host[REMOTE_METHODS.settings]({ ref: ref(p, 1), access: 'full', bots: { remove: ['reviewer'] }, model: { vendor: 'claude', model: 'opus', effort: 'max' } }, p.toHost);
    assert.equal(changed.access, 'full'); assert.deepEqual(changed.bots, []); assert.equal(changed.effort, 'max');
    const task = readTask(repo, '1');
    assert.equal(task.permissions, 'full'); assert.equal(task.leadEffort, 'max'); assert.deepEqual(task.bots, []);
    // The log: the newest rows of its last run, a secret cut out of them.
    const read = p.host[REMOTE_METHODS.log]({ ref: ref(p, 1), rows: 5 }, p.toHost);
    assert.equal(read.run.role, 'lead'); assert.equal(read.run.model, 'opus');
    assert.equal(JSON.stringify(read).includes(token), false, 'no secret leaves this computer');
    assert.ok(read.rows.some(row => row.withheld && row.text.includes('[secret]') && row.text.includes('All tests pass.')), JSON.stringify(read.rows));
    assert.ok(read.rows.some(row => row.text === 'Done: the build is 2 s faster.'));
    assert.deepEqual(p.host[REMOTE_METHODS.log]({ ref: ref(p, 1), rows: 1 }, p.toHost).rows.map(row => row.text), ['Done: the build is 2 s faster.']);
    assert.throws(() => p.host[REMOTE_METHODS.log]({ ref: ref(p, 1), rows: 999 }, p.toHost), /Ask for 1 to 200 rows/);
    assert.throws(() => p.host[REMOTE_METHODS.log]({ ref: ref(p, 1), role: 'bot:orchestrator' }, p.toHost), /What @orchestrator does stays on that computer/);
    assert.deepEqual(p.host[REMOTE_METHODS.log]({ ref: ref(p, 1), role: 'bot:reviewer' }, p.toHost), { run: null, rows: [], more: false });
    // The agents, as the Agents tab lists them.
    assert.ok(Array.isArray(p.host[REMOTE_METHODS.agents]({ ref: ref(p, 1) }, p.toHost).agents));
    assert.throws(() => p.host[REMOTE_METHODS.agents]({ ref: ref(p, 1), agent: 'job:nothing' }, p.toHost), /not in this session/);
    // The owner's decisions for the session, kept for him by the bot that runs his sessions there.
    const updated = p.host[REMOTE_METHODS.decisions]({ ref: ref(p, 1), change: { add: ['Merge your own PRs.'] }, by: 'orchestrator' }, p.toHost);
    assert.deepEqual(updated, { decisions: ['Merge your own PRs.'], line: 'Updated the task: added "Merge your own PRs.".' });
    assert.deepEqual(readTask(repo, '1').ownerDecisions, ['Merge your own PRs.']);
    assert.equal(readTask(repo, '1').decisionChanges.at(-1).by, 'orchestrator');
    assert.throws(() => p.host[REMOTE_METHODS.decisions]({ ref: ref(p, 1), change: { remove: [5] }, by: 'orchestrator' }, p.toHost), /There is no decision 5/);
    assert.throws(() => p.host[REMOTE_METHODS.decisions]({ ref: ref(p, 1), change: { add: ['x'] } }, p.toHost), /Name the bot/);
    // A teammate's session here is never changed from there.
    chat(p.project.root, 2, { goal: 'Their fix', origin: { kind: 'handoff', peer: 'e'.repeat(64), name: 'kim', threadId: 't' } }); relist();
    assert.throws(() => p.host[REMOTE_METHODS.decisions]({ ref: ref(p, 2), change: { add: ['x'] }, by: 'orchestrator' }, p.toHost), /teammate's/);
    assert.equal(readTask(repo, '2').ownerDecisions, undefined);
  });
});

test('the owner\'s word from a computer marked here is his, with its mark; from any other, or to a teammate\'s session, it is the bot\'s note', async t => {
  const p = pair(t);
  withHome(p.devbox.home, () => { chat(p.project.root, 1, { goal: 'Speedup' }); chat(p.project.root, 2, { goal: 'Their fix', origin: { mine: true, machine: 'e'.repeat(64), name: 'kim', remoteId: crypto.randomUUID() } }); relist(); });
  const watch = id => withHome(p.devbox.home, () => p.host['elu.remote.watch']({ ref: ref(p, id) }, p.toHost).id);
  const send = (id, text, extra = {}) => withHome(p.devbox.home, () => Promise.resolve().then(() => p.host['elu.remote.send']({ id, text, overseer: 'orchestrator', asOwner: MARK, ...extra }, p.toHost)));
  const queued = text => withHome(p.devbox.home, () => pendingRequests(p.project.root).filter(row => row.goal === text));
  const one = watch(1);
  // Not marked here: the bot's note, and the answer says why.
  const note = await send(one, 'Run the tests first.');
  assert.deepEqual([note.asOwner, note.why, note.overseer], [false, NOT_MY_COMPUTER, 'orchestrator']);
  assert.deepEqual(queued('Run the tests first.').map(row => [row.overseer, row.asOwner]), [['orchestrator', undefined]]);
  markOnDevbox(p);
  // Marked here, with a conductor that keeps the mark: his word, marked who sent it for him.
  p.hostCtx.enqueue = keeping;
  const word = await send(one, 'Helpers may spend credits.');
  assert.deepEqual(word, { id: one, asOwner: true });
  const [mine] = queued('Helpers may spend credits.');
  assert.deepEqual(mine.asOwner, { ...MARK, computer: p.laptop.identity.key });
  assert.equal(mine.overseer, undefined); assert.equal(mine.computer, p.laptop.identity.key); assert.equal(mine.continuationTaskId, '1');
  // A conductor that does not keep it: taken back, and it goes as the note.
  p.hostCtx.enqueue = dropping;
  const lost = await send(one, 'Merge when green.');
  assert.equal(lost.asOwner, false); assert.match(lost.why, /could not keep the owner's mark/);
  assert.deepEqual(queued('Merge when green.').map(row => row.overseer), ['orchestrator'], 'one request, the note');
  // A session a teammate's computer started here is never his: the note's rules refuse it.
  p.hostCtx.enqueue = keeping;
  await assert.rejects(send(watch(2), 'Rewrite it.'), /started from another computer or by a teammate/);
  assert.deepEqual(queued('Rewrite it.'), []);
  // A mark that does not read as one is refused plainly, and so is an answer to a question it no longer asks.
  await assert.rejects(send(one, 'x', { asOwner: { bot: 'Orchestrator' } }), /names the bot that sends it/);
  await assert.rejects(send(one, 'Yes', { answers: 'Deploy now?' }), /asks no question now/);
});

test('the laptop sends the owner\'s word only to a computer it marked as his, on an ELU that keeps the mark; else it goes as the note and says why', async t => {
  const p = pair(t, { remote: 1, shared: 1, oversee: 1 });
  withHome(p.devbox.home, () => { chat(p.project.root, 1, { goal: 'Speedup' }); relist(); });
  markOnDevbox(p); p.hostCtx.enqueue = keeping;
  await withHome(p.laptop.home, () => listTick(p.viewCtx));
  const row = withHome(p.laptop.home, () => remoteMachines())[0].sessions.find(item => item.title === 'Speedup');
  const send = text => withHome(p.laptop.home, () => remoteCommand(p.viewCtx, { type: 'remoteSend', to: p.devbox.identity.key, ref: row.ref, text, overseer: 'orchestrator', asOwner: MARK }));
  const sent = () => p.asked.filter(([method]) => method === 'elu.remote.send').at(-1)[1];
  // The laptop did not mark the devbox: the note, and no mark goes.
  const first = await send('One');
  assert.deepEqual([first.asOwner, first.why, first.overseer], [false, NOT_MARKED(p.devboxName), 'orchestrator']);
  assert.equal(sent().asOwner, undefined); assert.equal(sent().overseer, 'orchestrator');
  // Marked, but the devbox's hello does not say it keeps the mark.
  markOnLaptop(p);
  const second = await send('Two');
  assert.deepEqual([second.asOwner, second.why], [false, NEEDS_NEWER(p.devboxName)]);
  assert.equal(sent().asOwner, undefined);
  // Both marked, on an ELU from 0.1.46 to 0.1.48, which keeps it only under a mandate: the note.
  p.toViewer.remoteHello = { ...p.toViewer.remoteHello, full: 1 };
  const older = await send('Older');
  assert.deepEqual([older.asOwner, older.why], [false, NEEDS_NEWER(p.devboxName)]);
  assert.equal(sent().asOwner, undefined);
  // On an ELU that keeps it with no mandate: his word.
  p.toViewer.remoteHello = { ...p.toViewer.remoteHello, full: OWNER_WORD_FULL };
  const third = await send('Three');
  assert.deepEqual([third.asOwner, third.overseer, third.why], [true, null, undefined]);
  assert.deepEqual(sent().asOwner, MARK);
  // The devbox unmarks the laptop: the next one is the note again, and says the devbox's reason.
  withHome(p.devbox.home, () => unmarkMyComputer(p.laptop.identity.key));
  const fourth = await send('Four');
  assert.deepEqual([fourth.asOwner, fourth.why], [false, `${p.devboxName}: ${NOT_MY_COMPUTER}`]);
  await assert.rejects(withHome(p.laptop.home, () => remoteCommand(p.viewCtx, { type: 'remoteSend', to: p.devbox.identity.key, ref: row.ref, text: 'x', asOwner: { bot: 'Orchestrator' } })), /names the bot that sends it/);
});

test('the mark comes to the computer that follows the session, on a message that waits and on a chat entry, and a mark that does not read as one is left out', async t => {
  const p = pair(t);
  withHome(p.devbox.home, () => { chat(p.project.root, 1, { goal: 'Speedup' }); relist(); });
  markOnDevbox(p); markOnLaptop(p); p.hostCtx.enqueue = keeping;
  await withHome(p.laptop.home, () => listTick(p.viewCtx));
  const row = withHome(p.laptop.home, () => remoteMachines())[0].sessions.find(item => item.title === 'Speedup');
  const { id } = await withHome(p.laptop.home, () => remoteCommand(p.viewCtx, { type: 'remoteWatch', to: p.devbox.identity.key, ref: row.ref }));
  await withHome(p.laptop.home, () => remoteCommand(p.viewCtx, { type: 'remoteSend', to: p.devbox.identity.key, ref: row.ref, text: 'Ship it after the review.', asOwner: MARK }));
  withHome(p.devbox.home, () => hostTick(p.hostCtx));
  const pushed = p.toHost.sent.filter(([method]) => method === 'elu.remote.events');
  const waiting = pushed.flatMap(([, params]) => params.items.flatMap(item => item.events)).filter(event => event.type === 'waiting').at(-1);
  assert.deepEqual(waiting.list.map(item => [item.text, item.asOwner]), [['Ship it after the review.', { ...MARK, computer: p.laptop.identity.key }]]);
  for (const [, params] of pushed) withHome(p.laptop.home, () => p.viewer['elu.remote.events'](params, p.toViewer));
  const view = () => withHome(p.laptop.home, () => remoteSessions()).find(item => item.id === id);
  assert.deepEqual(view().waiting.map(item => item.asOwner), [{ ...MARK, computer: p.laptop.identity.key }]);
  // Entries as that computer sends them: the mark is kept, checked; one that does not read as one goes.
  const seq = view().seq;
  withHome(p.laptop.home, () => p.viewer['elu.remote.events']({ items: [{ id, last: seq + 2, events: [
    { seq: seq + 1, type: 'entry', role: 'You', at: at(5), text: 'Ship it after the review.', asOwner: { ...MARK, computer: p.laptop.identity.key } },
    { seq: seq + 2, type: 'entry', role: 'You', at: at(6), text: 'Forged', asOwner: { bot: 'Orchestrator', mandate: 'm1' } },
  ] }] }, p.toViewer));
  const entries = view().entries;
  assert.deepEqual(entries.find(entry => entry.text === 'Ship it after the review.').asOwner, { ...MARK, computer: p.laptop.identity.key });
  assert.equal('asOwner' in entries.find(entry => entry.text === 'Forged'), false);
});

test('the laptop starts a session with the owner\'s fields, changes settings and reads the log and agents only on a computer it marked, whose ELU takes them', async t => {
  const p = pair(t, { remote: 1, shared: 1, oversee: 1 });
  withHome(p.devbox.home, () => { chat(p.project.root, 1, { goal: 'Speedup', permissions: 'ask' }); relist(); });
  await withHome(p.laptop.home, () => listTick(p.viewCtx));
  const row = withHome(p.laptop.home, () => remoteMachines())[0].sessions.find(item => item.title === 'Speedup');
  const start = extra => withHome(p.laptop.home, () => remoteCommand(p.viewCtx, { type: 'remoteStart', to: p.devbox.identity.key, text: 'Ship the coupons', permissions: 'full', model: { vendor: 'claude', model: 'opus' }, ...extra }));
  const own = (type, extra = {}) => withHome(p.laptop.home, () => remoteCommand(p.viewCtx, { type, to: p.devbox.identity.key, ref: row.ref, ...extra }));
  // Not marked here: nothing goes.
  const before = p.asked.length;
  await assert.rejects(start({ title: 'Coupons' }), { message: NOT_MARKED(p.devboxName) });
  await assert.rejects(start({ model: { vendor: 'claude', model: 'opus', effort: 'high' } }), { message: NOT_MARKED(p.devboxName) });
  for (const type of NEW_REMOTE_COMMANDS) await assert.rejects(own(type, { access: 'full' }), { message: NOT_MARKED(p.devboxName) }, type);
  assert.equal(p.asked.length, before);
  // Marked here, on an ELU there that does not take the fields: said plainly, nothing started.
  markOnLaptop(p);
  await assert.rejects(start({ title: 'Coupons' }), { message: NEEDS_NEWER(p.devboxName) });
  assert.equal(withHome(p.devbox.home, () => pendingRequests(p.project.root).length), 0);
  // It does; the devbox has not marked the laptop: its refusal.
  p.toViewer.remoteHello = { ...p.toViewer.remoteHello, full: 1 };
  await assert.rejects(start({ title: 'Coupons' }), { message: `${p.devboxName}: ${NOT_MY_COMPUTER}` });
  await assert.rejects(own('remoteLog'), { message: `${p.devboxName}: ${NOT_MY_COMPUTER}` });
  // Both marked: as asked.
  markOnDevbox(p);
  const started = await start({ title: 'Coupons', model: { vendor: 'codex', model: 'gpt-5.5', effort: 'xhigh' } });
  const asked = p.asked.filter(([method]) => method === 'elu.remote.start').at(-1)[1];
  assert.deepEqual([asked.title, asked.model, asked.mandate], ['Coupons', { vendor: 'codex', model: 'gpt-5.5', effort: 'xhigh' }, undefined], 'any vendor, model and effort');
  assert.equal(withHome(p.laptop.home, () => remoteSessions()).find(item => item.id === started.id).title, 'Coupons');
  assert.equal(withHome(p.devbox.home, () => pendingRequests(p.project.root)).find(item => item.goal === 'Ship the coupons').permissions, 'full');
  const changed = await own('remoteSettings', { access: 'full' });
  assert.equal(changed.access, 'full');
  assert.equal(withHome(p.devbox.home, () => readTask(repository(p.project.root), '1').permissions), 'full');
  assert.deepEqual(await own('remoteLog'), { run: null, rows: [], more: false });
  // Its task's decisions, only on an ELU that keeps the owner's word with no mandate.
  await assert.rejects(own('remoteDecisions', { change: { add: ['Ship Friday.'] }, by: 'orchestrator' }), { message: NEEDS_NEWER(p.devboxName) });
  p.toViewer.remoteHello = { ...p.toViewer.remoteHello, full: OWNER_WORD_FULL };
  assert.deepEqual((await own('remoteDecisions', { change: { add: ['Ship Friday.'] }, by: 'orchestrator' })).decisions, ['Ship Friday.']);
  assert.deepEqual(withHome(p.devbox.home, () => readTask(repository(p.project.root), '1').ownerDecisions), ['Ship Friday.']);
  assert.ok(Array.isArray((await own('remoteAgents')).agents));
  await assert.rejects(own('remoteSettings'), /Say what to change/);
  // An ELU there from before these methods: it needs the new one.
  p.toViewer.request = async method => { throw Object.assign(new Error('Method not found'), { details: { rpc: { code: -32601 } } }); };
  for (const type of NEW_REMOTE_COMMANDS) await assert.rejects(own(type, { access: 'full', change: { add: ['x'] }, by: 'orchestrator' }), { message: NEEDS_NEWER(p.devboxName) }, type);
});

test('the new commands are peer commands the app and the tools can send', t => {
  for (const type of NEW_REMOTE_COMMANDS) assert.ok(REMOTE_COMMANDS.includes(type), type);
  assert.ok(REMOTE_COMMANDS.includes('mine') && REMOTE_COMMANDS.includes('unmine'), 'the old ones still refuse, as before');
  const { laptop } = pair(t);
  withHome(laptop.home, () => { for (const type of NEW_REMOTE_COMMANDS) assert.match(peerFacade.sendPeerCommand({ type, to: 'a'.repeat(64), ref: 'b'.repeat(16) + ':1' }).id, /^\d+-/); });
});
