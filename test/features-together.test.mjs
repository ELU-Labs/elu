import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { project, fakeClis, autoApprove } from './helpers.mjs';
import { liveTask, makeTeam, withHome, registeredProject, shareProjects } from './peer-helpers.mjs';
import { repository } from '../lib/git.mjs';
import { ProjectController, conversationEntries, modelWaiting, registerProject } from '../lib/projects.mjs';
import { projectFolder, pendingRequests } from '../lib/workspace.mjs';
import { readTask, saveTask, taskDir } from '../lib/state.mjs';
import { Conductor, enqueue, sendCommand } from '../lib/conductor.mjs';
import { CARRIED_ON_CALLS } from '../lib/runner.mjs';
import { WHILE_WORKING, readWords } from '../lib/message-aside.mjs';
import { runSteps, runsOfEntries, turnMoves } from '../lib/run-activity.mjs';
import { messageTime } from '../lib/terminal-visuals.mjs';
import { KEEP_GOING_LINE, KEEP_GOING_TEXT, jobsEndedText, sentByElu } from '../lib/elu-sent.mjs';
import { endJobs, startJob, waitingJobs } from '../lib/jobs.mjs';
import { changeLine } from '../lib/agent-change.mjs';
import { hostMethods, hostTick, remoteCommand, remoteSessions, viewMethods } from '../lib/peer/remote.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { remoteRow, rowActions, rowArtifacts, rowArtifactsNamed } from '../lib/board.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';
import { readData, readSharedArtifacts, sharedArtifacts } from '../lib/artifacts.mjs';
import { artifactsView, chartPictures } from '../lib/terminal-artifacts.mjs';
import { PICTURE_CELL } from '../lib/terminal-pictures.mjs';
import { launchTerminal } from '../lib/terminal.mjs';

// Features that each have a test file of their own, where they meet in one session:
// a message a working turn takes and answers at once (test/reply-while-working.test.mjs) with
// the messages ELU sends by itself (long jobs, keep going), with another computer of the
// project, and with a model chosen while the turn works; the Artifacts tab's rows as a picture
// here and as text on another computer; and the line for a second launch, in a session written
// to @lead and under a turn that a job's end started.
after(() => { setTimeout(() => { console.error('features-together.test: something is still running 10 s after the last test.'); process.exit(1); }, 10000).unref(); });
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const rows = file => file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(text => JSON.parse(text)) : [];
async function until(check, message, timeout = 30000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${typeof message === 'function' ? message() : message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TIME = /\d{1,2}:\d\d [AP]M/.source;
const ANSWERED = new RegExp(`^Read ${TIME} · answered ${TIME}\\.$`), CARRIED = new RegExp(`^Read ${TIME} · carried on without answering\\.$`);
// A project with the conductor running. Its turns go as fake (fake.json) says. What a test
// started stops before its folder goes: its conductors, then every job that still runs.
function setup(t, fake = {}) {
  const live = []; t.after(async () => { for (const conductor of live) await conductor.stop(); for (const row of waitingJobs()) { try { endJobs(row.dir, { by: 'delete' }); } catch { /* Gone. */ } } });
  const p = project(t), clis = fakeClis(p.parent, fake);
  environment(t, { ...clis.env, HOME: p.parent, ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, ELU_TURN: undefined, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); registerProject(controller.repo);
  const repo = controller.repo, root = repo.root;
  const runs = () => rows(clis.calls).filter(row => row.vendor === 'claude' && row.args.includes('-p'));
  const start = () => { const conductor = new Conductor({ tickMs: 20 }).start(); live.push(conductor); };
  const session = () => { try { return readTask(repo, '1'); } catch { return null; } };
  const chat = () => conversationEntries(repo, session());
  // A message the turn that works took, as the record keeps it: the one with this text, or one of ELU's own.
  const fed = text => (session()?.messages ?? []).find(row => row.during && (text ? row.text === text : sentByElu(row.text)));
  // The turn started more calls of its own, after what it last took, than it takes to say it carried on.
  const wentOn = async () => {
    const log = session().activeLog, from = rows(log).length;
    await until(() => rows(log).slice(from).flatMap(turnMoves).filter(move => move.call).length > CARRIED_ON_CALLS, 'the turn went on with its steps');
  };
  const stop = async () => { sendCommand({ type: 'stop', root, taskId: '1' }); await until(() => !['running', 'preparing'].includes(session().state), 'the turn stopped'); };
  // Its turns are over and nothing waits for it: in the state a turn's end leaves, answered or with its changes ready.
  const idle = () => ['answered', 'ready'].includes(session()?.state) && !pendingRequests(root).some(row => ['queued', 'starting', 'running'].includes(row.state));
  const waiting = () => `${session()?.state} ${JSON.stringify(pendingRequests(root).filter(row => row.state !== 'done').map(row => [row.goal, row.state, row.reason ?? null]))}`;
  return { ...p, fake: clis, controller, repo, root, runs, start, session, chat, fed, wentOn, stop, idle, waiting, absorbed: () => rows(path.join(clis.dir, 'absorbed.jsonl')), set: more => { const file = path.join(clis.dir, 'fake.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...more })); } };
}
const works = f => f.session()?.state === 'running' && f.session().activeInbox === true;
// His message as the chat shows it once a working turn took it, and the line under it.
const asked = (f, text) => f.chat().find(row => row.during && row.text === text);
const line = (f, text) => readWords(asked(f, text), messageTime);
const whileWorking = f => f.chat().filter(row => row.whileWorking);
const marks = row => [row.answeredAt, row.carriedOn];

// A message of ELU's own (lib/elu-sent.mjs) goes to the turn that works as his messages do,
// and nobody waits for an answer to it. The turn's record kept when it "carried on without
// answering" it, as for a question of his, and the text the turn wrote next was shown in the
// chat as an answer written while it worked, under no question.
test("a job that ends while a turn works, and ELU's keep-going message: each is one line of ELU's that waits for no answer, and his question between them is answered at once", { timeout: 150000 }, async t => {
  const f = setup(t, { mode: 'listen', steps: 110, stepMs: 150 }); f.start();
  enqueue(f.root, 'Tidy the coupon module', { priority: 0, typed: true, permissions: 'full', bots: [] });
  await until(() => works(f), 'the turn works and takes messages');
  await startJob({ repo: f.repo, task: f.session(), root: f.root, name: 'gate', command: ['echo through'], mode: 'full' });
  await until(() => f.fed(), "the job's end went to the turn that works", 60000);
  await f.wentOn();
  assert.equal(f.session().state, 'running');
  assert.deepEqual(marks(f.fed()), [undefined, undefined], 'nothing is kept of an answer to it, or of the turn going on without one');
  // The chat: one line of ELU's, with no line under it that says it was read, answered or not answered.
  const said = f.chat().at(-1);
  assert.match(said.text, /^Job gate ended with exit code 0 after \S+\. ELU told the session\.$/);
  assert.deepEqual([said.role, said.line, said.sent, said.during, ...marks(said)], ['ELU', true, true, undefined, undefined, undefined]);
  assert.deepEqual(f.chat().filter(row => row.during), [], 'no message of his is said to be on the turn');
  assert.deepEqual(whileWorking(f), []);
  // His question now: read and answered at once, under his own message.
  const QUESTION = 'Did the gate pass?';
  enqueue(f.root, QUESTION, { continuationTaskId: '1', priority: 0, typed: true });
  await until(() => whileWorking(f).length === 1, 'his question is answered while the turn works');
  assert.equal(f.session().state, 'running'); assert.match(line(f, QUESTION), ANSWERED);
  assert.deepEqual(f.chat().slice(-3).map(row => [row.role === 'ELU', row.during === true, row.whileWorking === true, row.text]), [[true, false, false, said.text], [false, true, false, QUESTION], [false, false, true, `Answer while working: ${QUESTION}`]]);
  // ELU's other message, to carry on, reaches the same turn: again one line, and no answer is waited for.
  enqueue(f.root, KEEP_GOING_TEXT, { continuationTaskId: '1', priority: 0 });
  await until(() => f.fed(KEEP_GOING_TEXT), 'the keep-going message went to the turn that works');
  await f.wentOn();
  assert.deepEqual(marks(f.fed(KEEP_GOING_TEXT)), [undefined, undefined]);
  const last = f.chat().at(-1);
  assert.deepEqual([last.role, last.text, last.line, last.during], ['ELU', KEEP_GOING_LINE, true, undefined]);
  assert.equal(whileWorking(f).length, 1, 'nothing more is shown as an answer'); assert.match(line(f, QUESTION), ANSWERED, 'the line under his question stays');
  assert.deepEqual(f.chat().filter(row => row.during).map(row => row.text), [QUESTION], 'his question is the only message said to be read by the turn');
  await f.stop();
  assert.equal(f.runs().length, 1, 'one turn took all three');
});

test("the text a turn writes after it took a message of ELU's is not shown as an answer to the owner", { timeout: 90000 }, async t => {
  // quiet: after its command the stand-in writes a line of text and then nothing for a minute.
  const f = setup(t, { mode: 'command', commandMs: 2500 }); f.set({ quiet: 'always' }); f.start();
  enqueue(f.root, 'Run the long check', { priority: 0, typed: true, permissions: 'full', bots: [] });
  await until(() => works(f) && runSteps(f.session().activeLog).some(step => step.status === 'running'), 'the turn runs its command');
  enqueue(f.root, KEEP_GOING_TEXT, { continuationTaskId: '1', priority: 0 });
  await until(() => f.fed(KEEP_GOING_TEXT), 'the turn took it when its command ended');
  const log = f.session().activeLog;
  await until(() => rows(log).flatMap(turnMoves).some(move => move.said === 'Reading the code. Thinking.'), 'the turn wrote text after it');
  await sleep(300);
  assert.deepEqual(whileWorking(f), [], 'what it wrote is its own note, not an answer to a question of his');
  assert.deepEqual(marks(f.fed(KEEP_GOING_TEXT)), [undefined, undefined]);
  assert.deepEqual(f.chat().slice(1).map(row => [row.role, row.text]), [['ELU', KEEP_GOING_LINE]]);
  await f.stop();
});

test('a turn ELU started by itself takes his message as any turn does: read and answered at once, and its reply at the end holds the turn', { timeout: 120000 }, async t => {
  const f = setup(t, { mode: 'answer' });
  const first = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(first.state, 'answered', JSON.stringify(first.error));
  const before = f.runs().length;
  // intent: each turn of the stand-in answers, and none proposes work that would start a turn of its own.
  f.set({ mode: 'listen', steps: 45, stepMs: 150, intent: 'answer' }); f.start();
  // As lib/keep-going.mjs sends it: the Task's objectives are not all met and nothing runs.
  enqueue(f.root, KEEP_GOING_TEXT, { continuationTaskId: '1', priority: 0 });
  await until(() => works(f), 'the turn ELU started works and takes messages');
  const told = f.chat().at(-1);
  assert.deepEqual([told.role, told.text, told.line, told.sent, told.during], ['ELU', KEEP_GOING_LINE, true, true, undefined]);
  const QUESTION = 'Which objective is left?';
  enqueue(f.root, QUESTION, { continuationTaskId: '1', priority: 0, typed: true });
  await until(() => whileWorking(f).length === 1, 'his question is answered while the turn works');
  assert.equal(f.session().state, 'running'); assert.match(line(f, QUESTION), ANSWERED);
  await until(() => f.idle(), () => `the turn to end: ${f.waiting()}`);
  const task = f.session(), entries = f.chat(), reply = entries.at(-1);
  assert.equal(f.runs().length, before + 1, 'one turn');
  assert.deepEqual(entries.slice(-4).map(row => [row.role === 'ELU', row.during === true, row.whileWorking === true, row.lead === true]), [[true, false, false, false], [false, true, false, false], [false, false, true, true], [false, false, false, true]]);
  assert.equal(reply.text.includes(QUESTION), false, 'its reply does not repeat the answer');
  assert.deepEqual(entries.filter(row => row.during).map(row => row.text), [QUESTION]);
  // The turn's steps fold above the reply it ended with: ELU's line started it, and the answer on the way does not hold it.
  const turns = task.runs.map(run => ({ role: run.role, at: run.at, key: run.logFile })), { owned, left } = runsOfEntries(entries, turns);
  assert.deepEqual([owned.get(reply), owned.get(entries.at(-2)), left], [[turns.at(-1)], undefined, []]);
});

// Two computers of one owner on one project: here (he types on it) and there (the session runs on it).
function connection(key) {
  const sent = [];
  return { key, admitted: true, remoteHello: { remote: 1, shared: 1 }, sent, notify: (method, params) => sent.push([method, params]), request: async () => { throw new Error('No answer'); } };
}
const context = (me, sessions = {}) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: () => null, log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
// A session he started from here that works there and takes messages. look: this computer
// takes in what that one has to say. fake: more of the stand-in's fake.json.
async function across(t, fake = {}) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), here = team.founder, there = team.member;
  const shop = withHome(there.home, () => { const made = registeredProject(t, { origin: 'https://github.com/acme/shop.git' }); saveTeamAccess(team.teamId, { root: made.root }); shareProjects(there.identity.key, here.identity.key); return made; });
  withHome(here.home, () => { shareProjects(here.identity.key, there.identity.key); });
  const toHost = connection(here.identity.key), toViewer = connection(there.identity.key);
  const hostCtx = context(there.identity, { [here.identity.key]: toHost }), viewCtx = context(here.identity, { [there.identity.key]: toViewer });
  const host = hostMethods(hostCtx), viewer = viewMethods(viewCtx);
  toViewer.request = async (method, params) => withHome(there.home, () => host[method](params, toHost));
  const clis = fakeClis(shop.parent, { mode: 'listen', steps: 40, stepMs: 150 });
  if (Object.keys(fake).length) { const file = path.join(clis.dir, 'fake.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...fake })); }
  const names = [...Object.keys(clis.env), 'HOME', 'XDG_CONFIG_HOME'], previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const started = await withHome(here.home, () => remoteCommand(viewCtx, { type: 'remoteStart', to: there.identity.key, text: 'Tidy the coupon module', permissions: 'full', place: null, model: null, bots: [] }));
  Object.assign(process.env, clis.env, { HOME: shop.parent, XDG_CONFIG_HOME: there.home });
  const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop());
  const repo = projectFolder(shop.root), task = () => { try { return readTask(repo, '1'); } catch { return null; } };
  await until(() => task()?.state === 'running' && task().activeInbox === true, 'the turn works there and takes messages');
  let delivered = 0;
  const look = () => {
    hostTick(hostCtx, Date.now());
    const events = toHost.sent.filter(([method]) => method === 'elu.remote.events');
    for (const [, params] of events.slice(delivered)) withHome(here.home, () => viewer['elu.remote.events'](params, connection(there.identity.key)));
    delivered = events.length;
  };
  const seen = () => withHome(here.home, () => remoteSessions().find(row => row.id === started.id));
  const app = remoteGlue({ facade: { remoteSessions: () => [] }, peerRead: () => ({ key: here.identity.key, teams: [] }), peerCommand: async () => ({}), chatMessage: ({ title, text }) => `${title}: ${text}`, ink: text => text, colour: false });
  look(); assert.equal(seen().state, 'running');
  const send = text => assert.deepEqual(host['elu.remote.send']({ id: started.id, text }, toHost), { id: started.id, working: true, takes: 'turn' });
  // The chat there, as that computer's own app shows it, and the entries and the pane's parts here.
  return { task, look, send, there: () => conversationEntries(repo, task()), here: () => seen().entries, parts: () => app.parts(remoteRow(seen(), 'box'), 140) };
}
// The line under his message on each computer: there, and here where it names that computer.
const lines = (s, text) => { const of = list => list.find(row => row.during && row.text === text); return [readWords(of(s.there()), messageTime), readWords(of(s.here()), messageTime, '@box')]; };

test('a message from another computer of the project that the turn answers: both computers say when it was read and answered, and show the answer once', { timeout: 120000 }, async t => {
  const s = await across(t), QUESTION = 'How far are you?', ANSWER = `Answer while working: ${QUESTION}`;
  s.send(QUESTION);
  await until(() => (s.task().messages ?? []).some(row => row.whileWorking), 'the turn there answered it');
  assert.equal(s.task().state, 'running'); s.look();
  const [there, here] = lines(s, QUESTION);
  assert.match(there, ANSWERED); assert.equal(here, there.replace(/^Read /, 'Read on @box '), 'the same times on both');
  const once = () => [s.there(), s.here()].map(list => list.filter(row => row.text === ANSWER).map(row => [row.whileWorking === true, row.lead === true]));
  assert.deepEqual(once(), [[[true, true]], [[true, true]]]);
  // Here its heading says where it was written and that the turn still works; a click on it finds the heading.
  const titled = s.parts().filter(part => part.text.includes(ANSWER));
  assert.equal(titled.length, 1); assert.ok(titled[0].head?.title.endsWith(` on @box${WHILE_WORKING}`), JSON.stringify(titled[0].head));
  // ELU's own words, sent from his other computer, are that computer's message, and are answered as any message is.
  s.send(KEEP_GOING_TEXT);
  await until(() => (s.task().messages ?? []).filter(row => row.whileWorking).length === 2, 'the turn there answered that too', 5000);
  s.look(); assert.match(lines(s, KEEP_GOING_TEXT)[0], ANSWERED); assert.equal(lines(s, KEEP_GOING_TEXT)[1], lines(s, KEEP_GOING_TEXT)[0].replace(/^Read /, 'Read on @box '));
  // The turn ends: its reply comes after, on both, and the answer is still there once.
  await until(() => s.task().state !== 'running', 'the turn there ends'); s.look();
  assert.deepEqual(once(), [[[true, true]], [[true, true]]]);
  for (const list of [s.there(), s.here()]) { const reply = list.at(-1); assert.deepEqual([reply.lead, reply.whileWorking, reply.text.includes(QUESTION)], [true, undefined, false]); }
  assert.deepEqual(lines(s, QUESTION), [there, here], 'the lines stay');
});

test('a message from another computer of the project that the turn reads and does not answer: both computers say it carried on without answering, and show no answer', { timeout: 120000 }, async t => {
  // noAnswer: the stand-in reads the message and writes nothing on the way.
  const s = await across(t, { noAnswer: true }), QUESTION = 'How far are you?';
  s.send(QUESTION);
  await until(() => (s.task().messages ?? []).some(row => row.text === QUESTION && row.carriedOn), 'the turn there went on with no answer');
  assert.equal(s.task().state, 'running'); s.look();
  const [there, here] = lines(s, QUESTION);
  assert.match(there, CARRIED); assert.equal(here, there.replace(/^Read /, 'Read on @box '));
  assert.deepEqual([s.there(), s.here()].map(list => list.filter(row => row.whileWorking).length), [0, 0], 'no answer is made up on either');
  await until(() => s.task().state !== 'running', 'the turn there ends'); s.look();
  // Its reply answers it, once on each, and the lines stay as they were.
  assert.deepEqual([s.there(), s.here()].map(list => list.filter(row => row.lead && row.text.includes(QUESTION)).length), [1, 1]);
  assert.deepEqual(lines(s, QUESTION), [there, here]);
});

// /model NAME and a message, typed while a turn works (test/terminal.test.mjs), waits for that
// turn to end. What he typed before it the working turn answers; what he types after it never
// overtakes it, and is answered by the turn of the model he named.
test('a question, then a model with a message, then one more message, all while a turn works: each is answered under it, by the model that read it', { timeout: 150000 }, async t => {
  const f = setup(t, { mode: 'listen', steps: 45, stepMs: 150, intent: 'answer' }); f.start();
  const models = () => f.runs().map(call => call.args[call.args.indexOf('--model') + 1]);
  enqueue(f.root, 'Tidy the coupon module', { priority: 0, typed: true, permissions: 'full', bots: [] });
  await until(() => works(f), 'the turn works and takes messages');
  assert.deepEqual(models(), ['opus']);
  const QUESTION = 'Why not merge them?', WITH_MODEL = 'Use the short form', LATER = 'And keep the tests';
  enqueue(f.root, QUESTION, { continuationTaskId: '1', priority: 0, typed: true });
  await until(() => whileWorking(f).length === 1, 'the working turn answered his question');
  const first = whileWorking(f)[0];
  // The model is changed while that turn works, and a message is sent with it.
  const saved = f.controller.changeAgent('1', { bot: null, to: { vendor: 'claude', model: 'sonnet', effort: null }, line: later => changeLine({ who: 'this session', model: ['Opus', 'Sonnet'], later }) });
  assert.deepEqual(saved, { later: true, line: 'Model of this session: Opus → Sonnet. It applies from the next turn.' });
  const model = modelWaiting(f.repo, f.session());
  assert.deepEqual(model, { vendor: 'claude', model: 'sonnet' });
  const held = enqueue(f.root, WITH_MODEL, { continuationTaskId: '1', priority: 0, typed: true, model });
  const after = enqueue(f.root, LATER, { continuationTaskId: '1', priority: 0, typed: true });
  await sleep(1200);
  // Neither is on the turn that works: the one with the model waits for its end, and nothing overtakes it.
  assert.equal(f.session().state, 'running');
  const waits = id => pendingRequests(f.root).find(row => row.id === id);
  assert.deepEqual([held, after].map(row => [waits(row.id)?.state, waits(row.id)?.turn]), [['queued', undefined], ['queued', undefined]]);
  assert.deepEqual(f.absorbed().filter(row => row.mid && /Use the short form|And keep the tests/.test(row.content)), [], 'the turn of Opus read neither');
  assert.equal(whileWorking(f).length, 1);
  // That turn ends, and the next one starts on the model he named, with his message.
  await until(() => models().length === 2, 'the next turn starts', 60000);
  assert.deepEqual(models(), ['opus', 'sonnet']);
  await until(() => f.idle(), () => `every message to be answered: ${f.waiting()}`, 90000);
  const task = f.session(), entries = f.chat(), at = text => entries.findIndex(row => !row.lead && row.text === text);
  // Which model wrote an entry: the one its turn was started on. A reply at a turn's end is that
  // turn's; an answer written on the way is the turn's that worked then.
  const turns = task.runs.filter(run => run.role === 'lead'), { owned } = runsOfEntries(entries, turns.map(run => ({ role: 'lead', at: run.at, key: run.logFile })));
  assert.deepEqual(turns.map(run => run.asked), ['opus', 'sonnet'], 'two turns, each on its model');
  const wrote = entry => entry.whileWorking ? turns.findLast(run => Date.parse(run.startedAt) <= Date.parse(entry.at))?.asked : turns.find(run => run.logFile === owned.get(entry)?.[0]?.key)?.asked;
  // His question, with the answer of the turn that read it right under it.
  assert.deepEqual([entries[at(QUESTION)].during, entries[at(QUESTION) + 1], wrote(first)], [true, first, 'opus']);
  // The message with the model: a message of its own turn, never said to be read by the other one,
  // after that turn's reply and in the order he sent them.
  assert.equal(entries[at(WITH_MODEL)].during, undefined);
  assert.ok(at(WITH_MODEL) > at(QUESTION) + 1 && at(LATER) > at(WITH_MODEL), 'in the order he sent them');
  const ended = entries.slice(0, at(WITH_MODEL)).findLast(row => row.lead && !row.whileWorking);
  assert.equal(wrote(ended), 'opus', 'the turn that worked replied before the message with the model started the next');
  // Every reply after it is the named model's: the answer to what he sent last, and the reply that ends its turn.
  const replies = entries.slice(at(WITH_MODEL) + 1).filter(row => row.lead);
  assert.ok(replies.length >= 1 && replies.every(row => wrote(row) === 'sonnet'), JSON.stringify(replies.map(row => [row.text.slice(0, 40), wrote(row)])));
  assert.ok(entries.slice(at(LATER) + 1).some(row => row.lead), 'what he sent last is answered after it');
  assert.equal(replies.filter(row => !row.whileWorking).length, 1, 'one reply ends the turn of the named model');
  assert.equal(task.messages.filter(row => [QUESTION, WITH_MODEL, LATER].includes(row.text)).length, 3, 'each of his messages is kept once');
});

// The Artifacts tab draws a chart's plot as a picture where the terminal shows pictures, and as
// text for a session on another computer, which is sent each artifact's newest update. A label
// of any length takes the rows it needs, and a fourth series has a mark of its own.
const LABEL = 'Share of the nightly eval cases that pass on the first try, by the run that produced them, for the four agents';
const RUNS = Array.from({ length: 8 }, (_, index) => `run ${index + 1}`);
const chart = shift => ({ blocks: [{ kind: 'chart', label: LABEL, unit: '%', target: 85, x: RUNS, series: ['Planner', 'Builder', 'Reviewer', 'Tester'].map((label, index) => ({ label, values: RUNS.map((_, run) => 40 + index * 12 + run + shift) })) }] });
const cellRows = list => list.flatMap((row, index) => row.includes(PICTURE_CELL) ? [index] : []);
const plain = row => row.replace(/\{\/?[a-z-]+\}/g, '').trim();
// The rows that hold the label, wherever it was broken: each no wider than the tab.
function labelRows(list, width) {
  const from = list.findIndex(row => plain(row) && LABEL.startsWith(plain(row)));
  let to = from; while (to < list.length && list.slice(from, to + 1).map(plain).join(' ') !== LABEL) to++;
  assert.ok(from >= 0 && to < list.length, `the label is not whole in the rows:\n${list.join('\n')}`);
  for (const row of list.slice(from, to + 1)) assert.ok(plain(row).length <= width, row);
  return { from, to };
}

test('a chart with a long label and four series: a picture under its label here, and text with every mark on another computer, from the newest update it was sent', () => {
  const at = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  const kept = [{ title: 'Eval history', shows: 'first-try passes by run', every: null, script: 'node eval.mjs', run: null, updates: [3, 2, 1, 0].map(back => ({ at: at(back * 60 + 5), data: readData(JSON.stringify(chart(-back))) })) },
    { title: 'Open questions', shows: 'what is not decided', every: null, script: null, run: null, updates: [] }];
  const width = 56;
  // Here, in a terminal that shows pictures: the cells under the picture start right under the label, however many rows it took.
  const pictured = artifactsView(kept, { width, colour: false, picture: true });
  const label = labelRows(pictured, width), blank = cellRows(pictured);
  assert.ok(label.to > label.from, 'the label takes more than one row');
  assert.equal(pictured.pictures.length, 1);
  const [picture] = pictured.pictures;
  assert.deepEqual([picture.row, picture.rows, blank.length, blank[0], blank.at(-1)], [label.to + 1, blank.length, picture.rows, label.to + 1, label.to + picture.rows]);
  assert.deepEqual(picture.chart.series.map(row => row.mark), [0, 1, 2, 3], 'each series has its own mark, the fourth too');
  // Scrolled by two rows, the picture is two rows higher, and it is the same picture.
  const cell = { width: 8, height: 16 }, [drawn] = chartPictures(pictured, { cell, colour: false }), [scrolled] = chartPictures(pictured, { cell, colour: false, top: 2 });
  assert.deepEqual([drawn.row, scrolled.row, scrolled.key, drawn.cols, drawn.rows], [picture.row, picture.row - 2, drawn.key, picture.cols, picture.rows]);
  // Another computer: what it is sent, as it reads it. The newest update is among them, whole; no script goes.
  const sent = JSON.parse(JSON.stringify(sharedArtifacts(kept))), there = readSharedArtifacts(sent);
  assert.deepEqual(there.map(row => [row.title, row.updates.length > 0, row.script]), [['Eval history', true, ''], ['Open questions', false, null]]);
  assert.ok(!JSON.stringify(sent).includes('eval.mjs'), 'the script stays on the computer that runs it');
  assert.deepEqual(there[0].updates.at(-1), kept[0].updates.at(-1));
  // Its tab there: the same label rows, the plot as text, and the four marks in it and in its legend.
  const text = artifactsView(there, { width, colour: false });
  assert.deepEqual(labelRows(text, width), label); assert.equal(text.pictures, undefined); assert.deepEqual(cellRows(text), []);
  assert.match(text.join('\n'), /[⠁-⣿]/);
  for (const mark of ['●', '■', '◆', '✚']) assert.ok(text.filter(row => row.includes(mark)).length >= 2, `${mark} is on the plot and in the legend`);
  for (const name of ['Planner', 'Builder', 'Reviewer', 'Tester']) assert.ok(text.some(row => row.includes(name)), name);
  // Its row here has v for the tab, as a session here has, and a Task with no artifact yet has the tab with no key named.
  const plan = artifacts => ({ id: 't-1', session: '1', revision: 1, title: 'Raise the pass rate', description: 'The eval runs each night.', goal: 'Passes reach the target.', objectives: ['85% or more pass'], priority: 'high', severity: 'low', startedBy: 'owner', by: 'lead', state: 'approved', proposedAt: at(300), approvedAt: at(300), rejectedAt: null, doneAt: null, subtasks: [], met: [], criteria: [], estimateMinutes: null, etaMinutes: null, etaAt: null, artifacts });
  const row = artifacts => remoteRow({ id: '66666666-6666-4666-8666-666666666666', machine: 'b'.repeat(64), createdAt: at(300), lastAt: at(0), title: 'Raise the pass rate', project: 'shop', approvals: [], steps: [], state: 'answered', plan: plan(artifacts), entries: [] }, 'box');
  assert.deepEqual([rowArtifacts(row(there)), rowArtifactsNamed(row(there)), rowActions(row(there)).some(([key]) => key === 'v')], [true, true, true]);
  assert.deepEqual([rowArtifacts(row([])), rowArtifactsNamed(row([])), rowActions(row([])).some(([key]) => key === 'v')], [true, false, false]);
});

// The app, for the line that says a message started an agent twice (lib/terminal.mjs).
function owned(t) {
  const value = { views: [], files: [] };
  t.after(async () => { let failure = null; for (const close of [...value.views.reverse(), ...value.files.reverse()]) { try { await close(); } catch (error) { failure ??= error; } } if (failure) throw failure; });
  return value;
}
function appProject(t) {
  const mine = owned(t), p = project({ after: close => mine.files.push(close) });
  const values = { XDG_CONFIG_HOME: path.join(p.parent, 'personal'), ELU_NO_COLOR: '1', ELU_NO_UPDATE_CHECK: '1', TERM: 'xterm-256color' }, previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  mine.files.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return { ...p, repo: repository(p.root), mine };
}
async function view(p, { columns, rows: high, ...options }) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = columns; output.rows = high;
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
  return { get panels() { return rendered.panels; } };
}
// A stand-in for the peer process: this computer is on a team with one other computer of the owner's, which lists no session.
function fakePeer() {
  const ME = 'a'.repeat(64), BOX = 'b'.repeat(64), now = new Date().toISOString();
  const facade = {
    running: true, channels: [], onTeam: () => true,
    peerStatus: () => ({ running: true, stale: false, pid: 1, key: ME, name: 'ana', fingerprint: 'aaaaaaaa', error: null, counters: { direct: 1, relayed: 0, failed: 0 },
      teams: [{ id: 'team-1', name: 'Core', role: 'admin', members: [{ key: ME, fingerprint: 'aaaaaaaa', name: 'ana', role: 'admin', online: true, path: null, lastSeen: now }, { key: BOX, fingerprint: 'bbbbbbbb', name: 'ana', role: 'member', online: true, path: 'direct', lastSeen: now, box: 'my-box', bots: [] }], channels: [] }] }),
    peerItems: () => [], teamAgents: () => [], tickerEvents: () => [],
    sendPeerCommand: () => ({ id: 'command-1' }), awaitCommand: async () => ({}), startPeer: () => true, restartStale: () => false,
    remoteSessions: () => [], remoteMachines: () => [], projectRepoId: () => null,
    access: { 'team-1': { handling: 'auto', rules: '', root: null, at: null } }, teamAccess: id => facade.access[id] ?? null,
  };
  return facade;
}
// The cursor on the row that matches: its session shows beside the list. What its chat says, as one line.
async function chatOf(v, pattern, last) {
  const { board, chat } = v.panels, flat = () => chat.getText().replace(/^\s*┃ ?/gm, '').replace(/\s+/g, ' ').trim();
  await until(() => board.items.some(item => pattern.test(item.getText())), `the row ${pattern}`);
  board.focus(); board.select(board.items.findIndex(item => pattern.test(item.getText())));
  await until(() => flat().includes(last), `its chat, to "${last}"`);
  return flat();
}
const TWICE = 'was started twice for this message: its first reply was not accepted. Anything it ran may have run twice.';
const count = (text, part) => text.split(part).length - 1;

test("the started-twice line names the agent that was started twice and sits under its reply: the model's and @lead's in a session written to @lead, and the reply of a turn a job's end started", { timeout: 60000 }, async t => {
  const p = appProject(t), ago = seconds => new Date(Date.now() - seconds * 1000).toISOString(), WHY = 'The run returned an invalid outcome or summary.';
  const log = (id, name, summary) => { const file = path.join(taskDir(p.repo, id), name); fs.writeFileSync(file, `${JSON.stringify(summary ? { type: 'result', structured_output: { outcome: 'done', summary } } : { type: 'system', subtype: 'init' })}\n`); return file; };
  // A session written to @lead. The model answered first, on its second launch; @lead's first turn
  // took two launches too, and its next one took one.
  liveTask(p.root, { id: '6', goal: 'Run the tests', state: 'answered' });
  saveTask(p.repo, { ...readTask(p.repo, '6'), createdAt: ago(90), messages: [{ at: ago(90), text: 'Run the tests', to: '@lead' }, { at: ago(50), text: 'All of them pass.', from: '@lead', bot: 'lead' }, { at: ago(20), text: 'Good, thanks.', to: '@lead' }, { at: ago(10), text: 'Any time.', from: '@lead', bot: 'lead' }],
    runs: [{ role: 'lead', vendor: 'claude', startedAt: ago(75), at: ago(70), logFile: log('6', 'lead-1.jsonl', 'Here is the plan.'), again: WHY }, { role: 'bot:lead', vendor: 'claude', startedAt: ago(60), at: ago(51), logFile: log('6', 'bot-lead-1.jsonl'), again: WHY }, { role: 'bot:lead', vendor: 'claude', startedAt: ago(15), at: ago(11), logFile: log('6', 'bot-lead-2.jsonl') }] });
  // A session whose long job ended: ELU told it, and the turn that started for that took two launches.
  liveTask(p.root, { id: '7', goal: 'Start the eval', state: 'answered' });
  const ended = jobsEndedText([{ name: 'gate', code: 0, ranMs: 2000, log: path.join(taskDir(p.repo, '7'), 'gate.log') }]);
  saveTask(p.repo, { ...readTask(p.repo, '7'), createdAt: ago(300), messages: [{ at: ago(300), text: 'Start the eval' }, { at: ago(100), text: ended }, { at: ago(30), text: 'And the report?' }],
    runs: [{ role: 'lead', vendor: 'claude', startedAt: ago(290), at: ago(280), logFile: log('7', 'lead-1.jsonl', 'The eval runs as a job.') }, { role: 'lead', vendor: 'claude', startedAt: ago(95), at: ago(80), logFile: log('7', 'lead-2.jsonl', 'The eval passed.'), again: WHY }, { role: 'lead', vendor: 'claude', startedAt: ago(25), at: ago(20), logFile: log('7', 'lead-3.jsonl', 'The report is written.') }] });
  const v = await view(p, { columns: 150, rows: 50, repo: p.repo, dashboard: true, peer: fakePeer() });
  const lead = await chatOf(v, /Run the tests/, 'Any time.');
  // Under the model's reply, by the model's name; under @lead's first reply, by @lead; never under a later one.
  assert.match(lead, new RegExp(`Here is the plan\\. \\S+ ${TWICE.replace(/[.]/g, '\\.')} @lead[^┃]* All of them pass\\. @lead ${TWICE.replace(/[.]/g, '\\.')} You → @lead`), lead);
  assert.equal(count(lead, 'was started twice'), 2, lead);
  assert.ok(!lead.slice(lead.indexOf('Good, thanks.')).includes('was started twice'), 'none under what came later');
  // The turn a job's end started: under that turn's reply, after ELU's line, and before what he wrote next.
  const job = await chatOf(v, /Start the eval/, 'The report is written.');
  const order = ['The eval runs as a job.', 'Job gate ended with exit code 0 after 2s. ELU told the session.', 'The eval passed.', TWICE, 'And the report?', 'The report is written.'].map(part => job.indexOf(part));
  assert.ok(order.every((found, index) => found >= 0 && (index === 0 || found > order[index - 1])), `${JSON.stringify(order)}\n${job}`);
  assert.equal(count(job, 'was started twice'), 1, job);
});
