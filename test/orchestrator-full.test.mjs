import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { temp } from './helpers.mjs';
import { readTask, saveTask, taskDir } from '../lib/state.mjs';
import { pendingRequests, projectFolder, saveRequest } from '../lib/workspace.mjs';
import { registerProject } from '../lib/projects.mjs';
import { readBoard, sessionArchived } from '../lib/kanban.mjs';
import { currentTask, planFile } from '../lib/plan.mjs';
import { saveBot } from '../lib/bots.mjs';
import { pendingApprovals, readApprovalLog, requestApproval } from '../lib/approvals.mjs';
import { forgetOverview } from '../lib/session-overview.mjs';
import { FULL_DEFAULT_CAPS, capLines, levelLines, readSettings, setCap, setLevel, settingsFile } from '../lib/orchestrator-settings.mjs';
import { FULL_ASK_LIST, FULL_TOOLS } from '../lib/orchestrator-seams.mjs';
import { DECISIONS_HEADING, decisionLines } from '../lib/owner-decisions.mjs';
import { ownerDecisionsPart } from '../lib/runner.mjs';
import { act, actionLine, askListed, readActions, undoAction } from '../lib/orchestrator-actions.mjs';
import { ORCH_TOOLS, ORCH_TOOL_DEFS, orchToolDefs, overseeingAnswer } from '../lib/orchestrator-tools.mjs';
import { OVERSEE_OWN_DENIED, TOOL_NAME, overseeing, serve } from '../lib/approval-server.mjs';

// The level Full, the default: the Orchestrator's session tools on this computer and on the
// owner's own others, his word in his own sessions with no step of his, his decisions kept in a
// session's task, the ask list that still asks him, and the audit of what it did as him. Below Full nothing of this exists (test/orchestrator-actions.test.mjs).

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const T0 = Date.now(), HOUR = 3600000;
const BOT = Object.freeze({ name: 'orchestrator', oversees: true, mcp: ['elu'] });
const ASKS = { state: 'needs_input', reply: { outcome: 'needs_input', question: 'Which database?' } };
const ME = 'a'.repeat(64), DEVBOX = 'b'.repeat(64), SARA = 'c'.repeat(64);
const said = out => [out.decision, out.by];
const inBlock = text => JSON.parse(text.split('\n').find(line => /^[\[{]/.test(line)));
// As the devbox (one of the owner's own) and Sara's laptop (a teammate's) listed their sessions here.
const LISTED = [
  { key: DEVBOX, listedAt: new Date(T0 - 60000).toISOString(), projects: [{ id: 'c0ffee00c0ffee00', name: 'shop' }],
    sessions: [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ref: 'c0ffee00c0ffee00:27', project: 'c0ffee00c0ffee00', title: 'Speedup', state: 'answered', at: new Date(T0 - HOUR).toISOString(), question: null, error: null, plan: { title: 'Speed round 1', state: 'proposed' }, approvals: [{ id: 'perm-1', summary: 'Run: npm test' }], by: 'you' },
      { id: '11111111-1111-4111-8111-111111111111', ref: 'c0ffee00c0ffee00:69', project: 'c0ffee00c0ffee00', title: 'Deploy', state: 'needs_input', at: new Date(T0 - HOUR).toISOString(), question: 'Deploy to staging now?', error: null, plan: null, approvals: [], by: 'you' },
    ] },
  { key: SARA, listedAt: new Date(T0 - 60000).toISOString(), projects: [{ id: 'beef0000beef0000', name: 'docs' }],
    sessions: [{ id: '44444444-4444-4444-8444-444444444444', ref: 'beef0000beef0000:3', project: 'beef0000beef0000', title: 'Docs', state: 'answered', at: new Date(T0 - HOUR).toISOString(), question: null, error: null, plan: null, approvals: [], by: 'you' }] },
];
function world(t, { level = 'full' } = {}) {
  environment(t, { XDG_CONFIG_HOME: temp(t) }); forgetOverview();
  const root = path.join(temp(t), 'web'); fs.mkdirSync(root);
  const repo = projectFolder(root); registerProject(repo);
  if (level) setLevel(level, { by: 'owner' });
  const w = { root, repo, asked: [], queued: [], sent: [], stops: [], changes: [], answer: 'allow', reply: { id: 'x', overseer: 'orchestrator' }, started: 0 };
  w.session = (id, extra = {}) => {
    saveTask(repo, { id: String(id), kind: 'conversation', base: null, branch: null, worktree: repo.root, goal: `Goal of session ${id}`, state: 'answered', createdAt: new Date(T0 - HOUR).toISOString(), runs: [], messages: [], reviews: [], responses: [], sessions: {}, permissions: 'auto', ...extra });
    return readTask(repo, String(id));
  };
  // The conductor's part, as one that keeps every field it is handed with the request.
  w.enqueue = (at, goal, { priority = 0, continuationTaskId = null, ...fields } = {}) => {
    const row = saveRequest(at, goal, undefined, { state: 'queued', priority, continuationTaskId: continuationTaskId == null ? null : String(continuationTaskId), taskId: null, reason: 'Waiting to start.', ...fields });
    w.queued.push(row); return row;
  };
  w.ctx = (extra = {}) => ({ repo, task: readTask(repo, '1'), bot: BOT, mode: 'full', run: 'run-1', now: T0, enqueue: w.enqueue, startConductor: () => { w.started++; },
    askOwner: question => { w.asked.push(question); return w.answer; }, servers: () => ({}), reached: () => new Map(),
    computers: () => [{ key: DEVBOX, name: 'devbox', online: true }, { key: SARA, name: 'laptop', person: 'sara', online: true }], machines: () => LISTED, views: () => [], viewWaitMs: 50,
    peerCommand: async command => { w.sent.push(command); return typeof w.reply === 'function' ? w.reply(command) : w.reply; },
    isMyComputer: key => key === DEVBOX, myKey: ME,
    sendCommand: command => { w.stops.push(command); }, stopLongWork: (at, id) => { w.stops.push({ jobs: id }); return [{ name: 'dev-server' }]; },
    runner: { setPermissions: (at, id, mode) => w.changes.push(['access', id, mode]), setBots: (at, id, bots) => w.changes.push(['bots', id, bots]) },
    agents: { changeAgent: (at, id, change) => { w.changes.push(['model', id, change.bot, change.to]); return { later: false }; } }, ...extra });
  w.act = (name, input = {}, extra = {}) => act(name, input, w.ctx(extra));
  // The bot's own chat, in Full access as /orchestrator full sets it.
  w.session(1, { goal: 'Oversee the sessions', botChat: 'orchestrator', permissions: 'full' });
  return w;
}
const proposed = (w, id, title = 'Ship it') => fs.writeFileSync(planFile(w.repo, String(id)), JSON.stringify({ tasks: [{ id: 't-0000000a', title, state: 'proposed', objectives: ['It ships'], subtasks: [], met: [] }] }));
const TEAMMATE = { origin: { kind: 'handoff', peer: SARA, name: 'sara' } };

test('settings: Full is set only by the owner, has its own caps and ceilings, and lowers nothing below it', t => {
  world(t, { level: null });
  assert.deepEqual([readSettings().level, readSettings().chosen], ['full', false], 'a new install is at Full with no command');
  assert.deepEqual(readSettings().caps, { ...FULL_DEFAULT_CAPS });
  for (const who of [undefined, { by: 'turn' }, { typed: true }]) assert.throws(() => setLevel('full', who), /Only you set the level to Full/);
  // A level the owner chose stays, Suggest among them; a file ELU wrote with the old default reads as Full.
  setLevel('suggest', { by: 'owner' });
  assert.equal(readSettings().level, 'suggest');
  fs.writeFileSync(settingsFile(), JSON.stringify({ version: 1, level: 'suggest', caps: {} }));
  assert.equal(readSettings().level, 'full', 'the old default, never chosen');
  fs.writeFileSync(settingsFile(), JSON.stringify({ version: 1, level: 'act', caps: {} }));
  assert.equal(readSettings().level, 'act', 'any other level was his choice');
  setLevel('suggest', { by: 'owner' });
  setCap('messagesPerHour', 4);
  assert.equal(readSettings().level, 'suggest', 'a cap keeps the level he set');
  assert.equal(setLevel('FULL', { by: 'owner' }).level, 'full');
  assert.deepEqual(readSettings().caps, { ...FULL_DEFAULT_CAPS });
  assert.deepEqual([FULL_DEFAULT_CAPS.sessionsPerDay, FULL_DEFAULT_CAPS.messagesPerHour, FULL_DEFAULT_CAPS.messagesInARow, FULL_DEFAULT_CAPS.startBudgetUsd, FULL_DEFAULT_CAPS.turnLimitUsd, FULL_DEFAULT_CAPS.startMode], [20, 60, 5, null, null, 'full']);
  assert.equal(setCap('sessionsPerDay', 100).caps.sessionsPerDay, 100);
  assert.throws(() => setCap('sessionsPerDay', 101), /0 to 100/);
  assert.equal(setCap('messagesPerHour', 300).caps.messagesPerHour, 300);
  assert.equal(setCap('startBudgetUsd', 10).caps.startBudgetUsd, 10);
  assert.equal(setCap('startBudgetUsd', 'none').caps.startBudgetUsd, null);
  assert.ok(capLines(readSettings().caps).includes("Budget of a session it starts: none: the session's own budget"));
  assert.match(levelLines().join('\n'), /publishing, tags, releases, workflow runs, force-pushes/);
  // Back below Full, the caps the owner set there are as he left them.
  setLevel('run', { by: 'owner' });
  assert.equal(readSettings().caps.messagesPerHour, 4);
  assert.equal(readSettings().caps.startMode, 'auto');
  assert.equal(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).fullCaps.sessionsPerDay, 100);
});

test('the relay serves the ten below Full and all of them at Full, each defined', t => {
  world(t);
  assert.deepEqual(ORCH_TOOL_DEFS.map(def => def.name), ORCH_TOOLS);
  assert.deepEqual(ORCH_TOOLS.slice(10), [...FULL_TOOLS]);
  assert.deepEqual(orchToolDefs('run').map(def => def.name), ORCH_TOOLS.slice(0, 10));
  const full = orchToolDefs('full');
  assert.deepEqual(full.map(def => def.name), ORCH_TOOLS);
  assert.deepEqual(orchToolDefs().map(def => def.name), ORCH_TOOLS, 'the level on disk is read');
  for (const def of full) {
    assert.ok(def.description.length > 40 && def.description.length < 900, def.name);
    for (const name of def.inputSchema.required ?? []) assert.ok(Object.hasOwn(def.inputSchema.properties, name), `${def.name}.${name}`);
  }
  const start = full.find(def => def.name === 'session_start');
  assert.deepEqual(Object.keys(start.inputSchema.properties).sort(), ['access', 'botModels', 'bots', 'computer', 'folders', 'goal', 'model', 'place', 'project', 'title']);
  for (const def of full) assert.doesNotMatch(`${def.description} ${JSON.stringify(def.inputSchema)}`, /mandate/i, def.name);
  assert.equal(full.some(def => def.name === 'mandate_propose'), false);
  assert.deepEqual(full.find(def => def.name === 'session_update_task').inputSchema.required, ['session']);
});

test('a start at Full gives the session everything it is told, and no budget of the bot\'s', async t => {
  const w = world(t), extra = temp(t);
  saveBot({ name: 'reviewer', instructions: 'Review the change.' });
  const out = await w.act('session_start', { goal: 'Make checkout fast', title: 'Checkout speed', model: { vendor: 'claude', model: 'opus', effort: 'high' }, bots: ['@reviewer'], botModels: { reviewer: { vendor: 'claude', effort: 'low' } }, access: 'full', place: 'here', folders: [extra] });
  assert.deepEqual(said(out), ['allow', 'level'], out.text);
  assert.equal(w.asked.length, 0);
  const [row] = w.queued;
  assert.deepEqual([row.permissions, row.place, row.bots, row.title, row.model, row.botModels, row.overseer, row.budgetUsd, row.mandate],
    ['full', { kind: 'here' }, ['reviewer'], 'Checkout speed', { vendor: 'claude', model: 'opus', effort: 'high' }, { reviewer: { vendor: 'claude', model: null, effort: 'low' } }, 'orchestrator', undefined, undefined]);
  assert.equal(row.folders.length, 1);
  assert.equal(row.goal, 'Make checkout fast');
  assert.match(out.text, /Full access, its own budget, in its project folder itself, claude · opus at high, @reviewer, 1 extra folder/);
  // Never more than this session and this turn have.
  const capped = await w.act('session_start', { goal: 'Look around', access: 'full' }, { mode: 'auto' });
  assert.equal(w.queued.at(-1).permissions, 'auto', capped.text);
  assert.match(capped.text, /Approve for me \(the most it may give; Full access was asked\)/);
  for (const [input, why] of [
    [{ goal: 'x', bots: ['orchestrator'] }, /oversees the sessions: it joins none of them/],
    [{ goal: 'x', bots: ['nobody'] }, /There is no bot named nobody/],
    [{ goal: 'x', model: { vendor: 'claude', effort: 'ultra' } }, /takes the efforts low, medium, high, xhigh, max, not ultra/],
    [{ goal: 'x', title: 'a\nb'.repeat(150) }, /Keep the name to 200 characters|A session name is one line/],
    [{ goal: 'x', computer: 'laptop' }, /@laptop is not one of the owner's own computers here/],
    [{ goal: 'x', place: 'here' }, null],
  ]) {
    const refused = await w.act('session_start', input, { mode: why ? 'full' : 'auto' });
    if (!why) { assert.match(refused.text, /Here needs Full access/); continue; }
    assert.deepEqual(said(refused), ['refused', 'level'], refused.text); assert.match(refused.text, why);
  }
  // A conductor that drops what it was told starts nothing.
  const dropping = (at, goal, { title, botModels, ...fields } = {}) => w.enqueue(at, goal, fields);
  const lost = await w.act('session_start', { goal: 'Name it', title: 'Named' }, { enqueue: dropping });
  assert.deepEqual(said(lost), ['refused', 'level']); assert.match(lost.text, /Nothing was started/);
  assert.equal(pendingRequests(w.root).some(request => request.goal === 'Name it'), false, 'the request is taken back');
});

test("at Full a message and an answer to his own session are the owner's word with no mandate; a teammate's session gets a note, and the log says which", async t => {
  const w = world(t); w.session(2); w.session(3, ASKS); w.session(4, { permissions: 'full' }); w.session(5); proposed(w, 5);
  w.session(6, { state: 'stopped', error: { message: 'Stopped by the owner.' } }); w.session(7, TEAMMATE);
  const word = await w.act('session_message', { session: '2', text: 'The checks fail on main.' });
  assert.deepEqual(said(word), ['allow', 'level'], word.text);
  assert.deepEqual(w.queued.at(-1).asOwner, { bot: 'orchestrator', computer: null });
  assert.equal(w.queued.at(-1).overseer, undefined, 'his word never carries the bot\'s mark');
  assert.match(word.text, /as the owner's word\. It shows there as his, via @orchestrator/);
  // His word in a session in Full access is not asked about.
  assert.deepEqual(said(await w.act('session_message', { session: '4', text: 'Carry on.' })), ['allow', 'level']);
  assert.equal(w.asked.length, 0);
  const answer = await w.act('session_answer', { session: '3', text: 'Use Postgres.' });
  assert.deepEqual(said(answer), ['allow', 'level'], answer.text);
  assert.deepEqual(w.queued.at(-1).asOwner, { bot: 'orchestrator', computer: null });
  // His word to a bot of the session (@NAME ...) goes to that bot, as his own does; never to a bot that oversees.
  saveBot({ name: 'advisor', instructions: 'Review designs.' });
  const toBot = await w.act('session_message', { session: '2', text: '@advisor Review the Wave 3 seams note.' });
  assert.deepEqual(said(toBot), ['allow', 'level'], toBot.text);
  assert.deepEqual([w.queued.at(-1).bot, w.queued.at(-1).goal, w.queued.at(-1).asOwner], ['advisor', 'Review the Wave 3 seams note.', { bot: 'orchestrator', computer: null }]);
  assert.match(toBot.text, /^Sent to @advisor in /);
  assert.match((await w.act('session_message', { session: '2', text: '@orchestrator look' })).text, /Only the owner writes to @orchestrator/);
  // His word goes where only his goes: a Task that waits for him, a session he stopped.
  assert.deepEqual(said(await w.act('session_message', { session: '5', text: 'Go on with the plan.' })), ['allow', 'level']);
  assert.deepEqual(said(await w.act('session_message', { session: '6', text: 'Go on.' })), ['allow', 'level']);
  // A teammate's session: a note under the bot's name, never his word.
  const note = await w.act('session_message', { session: '7', text: 'Look at this.' });
  if (note.decision === 'allow') { assert.equal(w.queued.at(-1).asOwner, undefined); assert.equal(w.queued.at(-1).overseer, 'orchestrator'); }
  else assert.equal(note.decision, 'refused');
  // The bot's own chat is never spoken to as him.
  assert.equal(w.queued.some(row => row.continuationTaskId === '1'), false);
  const dropped = await w.act('session_message', { session: '3', text: 'Use Postgres 16.' }, { enqueue: (at, goal, { asOwner, ...fields }) => w.enqueue(at, goal, fields) });
  assert.deepEqual(said(dropped), ['refused', 'level'], 'a conductor that drops his mark sends nothing');
  // The audit: asOwner on what it did as him, and only on that.
  const rows = readActions();
  assert.deepEqual(rows.filter(row => row.decision === 'allow' && row.target?.session !== '7').map(row => [row.action, row.target?.session ?? null, row.asOwner ?? false]),
    [['session_message', '2', true], ['session_message', '4', true], ['session_answer', '3', true], ['session_message', '2', true], ['session_message', '5', true], ['session_message', '6', true]]);
  assert.equal(rows.some(row => row.mandate), false);
  assert.match(actionLine(rows[0], T0), /as you/);
  // Below Full nothing is his word.
  setLevel('run', { by: 'owner' });
  const run = await w.act('session_message', { session: '5', text: 'Go on.' });
  assert.match(run.text, /waits for the owner's approval\. Only he approves a Task/);
});

test('session_approve approves a Task or a permission for him in his own session, and never what only he answers', async t => {
  const w = world(t); w.session(2); proposed(w, 2); w.session(3, TEAMMATE); proposed(w, 3, 'Other');
  const teammate = await w.act('session_approve', { session: '3' });
  assert.deepEqual(said(teammate), ['refused', 'level']); assert.match(teammate.text, /not one of the owner's own sessions/);
  const out = await w.act('session_approve', { session: '2' });
  assert.deepEqual(said(out), ['allow', 'level'], out.text);
  assert.equal(currentTask(w.repo, '2').state, 'approved');
  assert.deepEqual([w.queued.at(-1).goal, w.queued.at(-1).approved, w.queued.at(-1).asOwner], ['Approved the Task: Ship it', true, { bot: 'orchestrator', computer: null }]);
  assert.equal(currentTask(w.repo, '3').state, 'proposed');
  assert.match((await w.act('session_approve', { session: '2' })).text, /No Task waits for approval/);
  // A permission request, by its id from session_read.
  const ask = (id, tool, input, extra = {}) => requestApproval({ id, root: w.root, taskId: '2', role: 'lead', vendor: 'claude', tool, input, waitSeconds: 600, ...extra });
  ask('perm-test', 'Bash', { command: 'npm test' }); ask('perm-publish', 'Bash', { command: 'cd pkg && npm publish' }); ask('perm-force', 'Bash', { command: 'git push origin main --force' });
  ask('perm-mine', 'mcp__elu-code-approval__session_start', {}, { oversee: true }); ask('perm-mail', 'mcp__gmail__send_email', { to: 'a@example.test' });
  const read = inBlock((await w.act('session_read', { session: '2' })).text);
  assert.equal(read.yourWord, "your messages, answers and approvals there are the owner's");
  assert.equal(read.mandate, undefined);
  assert.deepEqual(read.approvals.map(row => row.id).sort(), ['perm-force', 'perm-mail', 'perm-mine', 'perm-publish', 'perm-test']);
  const allowed = await w.act('session_approve', { session: '2', approval: 'perm-test', decision: 'allow' });
  assert.deepEqual(said(allowed), ['allow', 'level'], allowed.text);
  assert.equal(pendingApprovals({ taskId: '2' }).some(row => row.id === 'perm-test'), false);
  for (const [id, why] of [['perm-publish', /the owner's to answer, at every level/], ['perm-force', /the owner's to answer/], ['perm-mine', /a question of the bot that oversees the sessions/], ['perm-mail', /reads that request .* whole/], ['perm-none', /No permission request perm-none waits/]]) {
    const refused = await w.act('session_approve', { session: '2', approval: id, decision: 'allow' });
    assert.deepEqual(said(refused), ['refused', 'level'], id); assert.match(refused.text, why);
  }
  assert.equal(pendingApprovals({ taskId: '2' }).length, 4);
  assert.deepEqual(readActions().filter(row => row.decision === 'allow' && row.action === 'session_approve').map(row => row.asOwner), [true, true]);
});

test('stop, rename and archive a session here, with undo where there is one', async t => {
  const w = world(t); w.session(2, { state: 'running' }); w.session(3); w.session(4, { titleBy: undefined }); w.session(7, { origin: { kind: 'handoff', peer: SARA, name: 'sara' } });
  assert.deepEqual(said(await w.act('session_stop', { session: '2' })), ['allow', 'level']);
  assert.deepEqual(w.stops, [{ type: 'stop', root: w.root, taskId: '2' }]);
  assert.match((await w.act('session_stop', { session: '3' })).text, /not at work: there is nothing to stop/);
  w.session(5, { jobs: [{ name: 'dev-server', state: 'running', startedAt: new Date(T0).toISOString() }] });
  assert.match((await w.act('session_stop', { session: '5' })).text, /Stopped the long jobs of .*dev-server/);
  assert.match((await w.act('session_stop', { session: '1' })).text, /That is the session you are in/);
  assert.match((await w.act('session_stop', { session: '7' })).text, /started from another computer or by a teammate/);
  // A name.
  const renamed = await w.act('session_rename', { session: '3', title: 'Checkout speed' });
  assert.deepEqual(said(renamed), ['allow', 'level'], renamed.text);
  assert.equal(readTask(w.repo, '3').title, 'Checkout speed');
  assert.deepEqual(said(await w.act('session_rename', { session: '3', title: 'Checkout, round 2' })), ['allow', 'level'], 'its own name it changes again');
  undoAction(readActions().at(-1).id);
  assert.equal(readTask(w.repo, '3').title, 'Checkout speed');
  const { setTitle } = await import('../lib/state.mjs'); setTitle(w.repo, '4', 'Mine');
  assert.deepEqual(said(await w.act('session_rename', { session: '4', title: 'Theirs' })), ['allow', 'level'], 'in his own session at Full it renames as he would');
  assert.match((await w.act('session_rename', { session: '3', title: 'x'.repeat(201) })).text, /200 characters/);
  // Archive and bring back.
  assert.match((await w.act('session_archive', { session: '2' })).text, /at work\. Stop it first/);
  const archived = await w.act('session_archive', { session: '3' });
  assert.deepEqual(said(archived), ['allow', 'level'], archived.text);
  assert.equal(sessionArchived(readBoard(w.repo), readTask(w.repo, '3')), true);
  assert.match((await w.act('session_message', { session: '3', text: 'x' })).text, /archived/);
  assert.match((await w.act('session_archive', { session: '3' })).text, /archived already/);
  undoAction(readActions().filter(row => row.action === 'session_archive' && row.decision === 'allow').at(-1).id);
  assert.equal(sessionArchived(readBoard(w.repo), readTask(w.repo, '3')), false);
  assert.deepEqual(said(await w.act('session_archive', { session: '3' })), ['allow', 'level']);
  const back = await w.act('session_archive', { session: '3', archived: false });
  assert.deepEqual(said(back), ['allow', 'level'], back.text);
  assert.equal(sessionArchived(readBoard(w.repo), readTask(w.repo, '3')), false);
  assert.ok(fs.existsSync(taskDir(w.repo, '3')), 'nothing is ever deleted');
});

test('session_settings changes access, model, bots and bots\' models, checked first', async t => {
  const w = world(t); w.session(2, { bots: ['reviewer'], botsPicked: true });
  saveBot({ name: 'reviewer', instructions: 'Review the change.' }); saveBot({ name: 'tester', instructions: 'Test the change.' });
  const out = await w.act('session_settings', { session: '2', access: 'full', model: { vendor: 'claude', model: 'opus', effort: 'max' }, bots: { add: ['tester'] }, botModels: { tester: { vendor: 'claude', effort: 'low' } } });
  assert.deepEqual(said(out), ['allow', 'level'], out.text);
  assert.deepEqual(w.changes, [['access', '2', 'full'], ['bots', '2', ['reviewer', 'tester']], ['model', '2', null, { vendor: 'claude', model: 'opus', effort: 'max' }], ['model', '2', 'tester', { vendor: 'claude', model: null, effort: 'low' }]]);
  for (const [input, why] of [[{ session: '2' }, /Name what to change/], [{ session: '2', access: 'root' }, /Set access to ask, auto or full/], [{ session: '2', bots: { remove: ['nobody'] } }, /@nobody is not in web #2/], [{ session: '2', botModels: { ghost: { vendor: 'claude' } } }, /@ghost is not one of the session's bots/], [{ session: '1', access: 'ask' }, /That is the session you are in/]]) {
    const refused = await w.act('session_settings', input);
    assert.deepEqual(said(refused), ['refused', 'level']); assert.match(refused.text, why);
  }
  assert.equal(w.changes.length, 4, 'a refused change changes nothing');
});

test('session_log reads the last rows of a run, a key masked, and session_agents lists the agents', async t => {
  const w = world(t), dir = taskDir(w.repo, '2'), log = path.join(dir, 'run-1.log');
  w.session(2);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(log, [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Running the checks now.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'all 12 pass' }] } }].map(row => JSON.stringify(row)).join('\n') + '\n');
  saveTask(w.repo, { ...readTask(w.repo, '2'), runs: [{ role: 'lead', vendor: 'claude', at: new Date(T0 - 60000).toISOString(), logFile: log }, { role: 'lead', vendor: 'claude', at: new Date(T0).toISOString(), logFile: '/etc/passwd' }] });
  const out = await w.act('session_log', { session: '2', rows: 5 });
  assert.deepEqual(said(out), ['allow', 'level'], out.text);
  const value = inBlock(out.text);
  assert.deepEqual(value.rows.map(row => [row.kind, row.text]), [['text', 'Running the checks now.'], ['tool', 'Run: npm test']]);
  assert.match((await w.act('session_log', { session: '2', role: '@reviewer' })).text, /has no log of @reviewer yet/);
  assert.match((await w.act('session_log', { session: '2', rows: 500 })).text, /Ask for 1 to 200 rows/);
  // The Agents tab's rows (lib/session-agents.mjs): its coder, as its runs say.
  const agents = inBlock((await w.act('session_agents', { session: '2' })).text);
  assert.deepEqual(agents.map(row => [row.id, row.kind]), [['lead', 'coder']]);
  assert.equal(readActions().filter(row => ['session_log', 'session_agents'].includes(row.action)).length, 4, 'each read is logged');
});

test('on the owner\'s own computer it does all of it as his word with no mandate; on a teammate\'s nothing', async t => {
  const w = world(t);
  w.reply = { id: 'x', overseer: 'orchestrator', asOwner: true };
  const word = await w.act('session_message', { computer: 'devbox', session: '27', text: 'Approve round 2.' });
  assert.deepEqual(said(word), ['allow', 'level'], word.text);
  assert.equal(w.asked.length, 0, 'his word on his own computer is not asked about, a Task that waits for him included');
  assert.deepEqual(w.sent.at(-1), { type: 'remoteSend', to: DEVBOX, ref: 'c0ffee00c0ffee00:27', text: 'Approve round 2.', overseer: 'orchestrator', asOwner: { bot: 'orchestrator', computer: ME } });
  assert.equal(readActions().at(-1).asOwner, true);
  // A computer that did not take it as his: said so, and not logged as his.
  w.reply = { id: 'x', overseer: 'orchestrator' };
  const older = await w.act('session_message', { computer: 'devbox', session: '27', text: 'Again.' });
  assert.match(older.text, /did not take it as the owner's word/);
  assert.equal(readActions().at(-1).asOwner, undefined);
  // A teammate's computer: a note under the bot's name, asked of him first, never his word.
  await w.act('session_message', { computer: 'laptop', session: '3', text: 'Look at the docs.' });
  assert.equal(w.asked.length, 1); assert.equal(w.sent.at(-1).asOwner, undefined);
  // Approve there, stop, rename, archive, settings, log and agents, each through its command.
  w.reply = command => ({ remoteTask: { answered: true }, remoteAnswer: { answered: true }, remoteStop: { stopping: true }, remoteRename: { shown: 'Fast' }, remoteArchive: {}, remoteSettings: {}, remoteLog: { rows: [{ kind: 'text', text: 'Done.' }] }, remoteAgents: { agents: [{ id: 'lead', kind: 'lead', name: 'lead', vendor: 'claude', model: 'opus', state: 'idle' }] } })[command.type];
  for (const [name, input, type] of [['session_approve', {}, 'remoteTask'], ['session_approve', { approval: 'perm-1', decision: 'allow' }, 'remoteAnswer'], ['session_stop', {}, 'remoteStop'], ['session_rename', { title: 'Fast' }, 'remoteRename'], ['session_archive', {}, 'remoteArchive'], ['session_settings', { access: 'auto' }, 'remoteSettings'], ['session_log', { rows: 3 }, 'remoteLog'], ['session_agents', {}, 'remoteAgents']]) {
    const out = await w.act(name, { computer: 'devbox', session: '27', ...input });
    assert.deepEqual(said(out), ['allow', 'level'], `${name}: ${out.text}`);
    assert.deepEqual([w.sent.at(-1).type, w.sent.at(-1).to, w.sent.at(-1).ref], [type, DEVBOX, 'c0ffee00c0ffee00:27'], name);
  }
  assert.equal(w.sent.find(command => command.type === 'remoteLog').rows, 3);
  assert.equal(w.sent.find(command => command.type === 'remoteSettings').access, 'auto');
  // A teammate's computer: no change, and never his word.
  const before = w.sent.length;
  for (const name of ['session_stop', 'session_rename', 'session_archive', 'session_log', 'session_approve']) {
    const out = await w.act(name, { computer: 'laptop', session: '3', title: 'x' });
    assert.deepEqual(said(out), ['refused', 'level'], name); assert.match(out.text, /not one of the owner's own computers|not one of the owner's own sessions/);
  }
  assert.equal(w.sent.length, before);
  // A start there: only on his own, with what it is told.
  w.reply = command => command.type === 'remoteFolders' ? { pick: true, folders: [{ path: '/work/shop', label: 'shop', name: 'shop', project: true }] } : { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', project: 'shop', projectId: 'c0ffee00c0ffee00' };
  const start = await w.act('session_start', { computer: 'devbox', project: 'shop', goal: 'Profile search', title: 'Search', access: 'full', bots: ['tester'], model: { vendor: 'codex', model: 'gpt-5', effort: 'high' } });
  assert.deepEqual(said(start), ['allow', 'level'], start.text);
  const sent = w.sent.at(-1);
  assert.deepEqual([sent.type, sent.to, sent.folder, sent.permissions, sent.title, sent.bots, sent.mandate, sent.budgetUsd], ['remoteStart', DEVBOX, '/work/shop', 'full', 'Search', ['tester'], undefined, undefined]);
  assert.equal(sent.model?.vendor, 'codex', 'any vendor, model and effort goes to his computer as asked');
  // A computer with one project and nothing to pick names it as root and project: naming it starts there.
  w.reply = command => command.type === 'remoteFolders' ? { pick: false, root: '/srv/shop', project: 'shop', folders: [] } : { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', project: 'shop', projectId: 'c0ffee00c0ffee00' };
  const one = await w.act('session_start', { computer: 'devbox', project: 'shop', goal: 'Profile search again', access: 'full' });
  assert.deepEqual(said(one), ['allow', 'level'], one.text);
  assert.equal(w.sent.at(-1).folder, '/srv/shop');
  w.reply = command => command.type === 'remoteFolders' ? { pick: false, root: '/srv/shop', project: 'shop', folders: [] } : { id: 'x' };
  assert.match((await w.act('session_start', { computer: 'devbox', project: 'blog', goal: 'x', access: 'full' })).text, /lists no project named blog/);
  assert.match((await w.act('session_start', { computer: 'laptop', goal: 'x' })).text, /not one of the owner's own computers/);
});

test('session_update_task keeps his decisions in his own session\'s task, which every turn there reads; never a teammate\'s', async t => {
  const w = world(t); w.session(2); w.session(3, TEAMMATE); w.session(4, { standup: true });
  const added = await w.act('session_update_task', { session: '2', add: ['Helpers may run on credits.', 'Postgres, not MySQL.'] });
  assert.deepEqual(said(added), ['allow', 'level'], added.text);
  assert.equal(w.asked.length, 0, 'nothing asks him');
  assert.deepEqual(readTask(w.repo, '2').ownerDecisions, ['Helpers may run on credits.', 'Postgres, not MySQL.']);
  assert.deepEqual(said(await w.act('session_update_task', { session: '2', change: [{ number: 2, text: 'Postgres 16.' }], remove: [1], add: ['Merge your own PRs.'] })), ['allow', 'level']);
  const task = readTask(w.repo, '2');
  assert.deepEqual(task.ownerDecisions, ['Postgres 16.', 'Merge your own PRs.']);
  // The chat shows each change as his, via the bot.
  const lines = decisionLines(task);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].role, 'You · via @orchestrator');
  assert.match(lines[0].text, /^Updated the task: added "Helpers may run on credits\."; added "Postgres, not MySQL\."\.$/);
  assert.match(lines[1].text, /^Updated the task: changed 2: "Postgres 16\."; removed 1 \("Helpers may run on credits\."\); added "Merge your own PRs\."\.$/);
  // Every turn there reads them, under the heading; a teammate's session reads none.
  assert.deepEqual(ownerDecisionsPart(task), [`${DECISIONS_HEADING}:\nThe owner set these for this session. Follow each of them in every turn, as his own instructions, until he changes them.\n1. Postgres 16.\n2. Merge your own PRs.`]);
  assert.deepEqual(ownerDecisionsPart({ ...readTask(w.repo, '3'), ownerDecisions: ['x'] }), []);
  // Audited as his.
  const rows = readActions().filter(row => row.action === 'session_update_task');
  assert.deepEqual(rows.map(row => [row.decision, row.asOwner, row.target?.session]), [['allow', true, '2'], ['allow', true, '2']]);
  // The goal grows only with an agreed Task.
  assert.match((await w.act('session_update_task', { session: '2', goal: 'Also make search fast.' })).text, /no agreed Task yet/);
  fs.writeFileSync(planFile(w.repo, '2'), JSON.stringify({ tasks: [{ id: 't-0000000b', title: 'Speed', goal: 'Checkout fast', state: 'approved', objectives: ['Checkout fast'], subtasks: [], met: [] }] }));
  const grown = await w.act('session_update_task', { session: '2', goal: 'Also make search fast.' });
  assert.deepEqual(said(grown), ['allow', 'level'], grown.text);
  assert.deepEqual(currentTask(w.repo, '2').objectives, ['Checkout fast', 'Also make search fast.']);
  // Refused: a number it does not have, a teammate's session, a Standup, the chat it is in, below Full.
  for (const [input, why] of [[{ session: '2', remove: [9] }, /There is no decision 9/], [{ session: '3', add: ['x'] }, /by a teammate\. Only its owner changes its task/], [{ session: '4', add: ['x'] }, /Standup/], [{ session: '1', add: ['x'] }, /the session you are in/], [{ session: '2' }, /Say what to change/]]) {
    const refused = await w.act('session_update_task', input);
    assert.deepEqual(said(refused), ['refused', 'level'], JSON.stringify(input)); assert.match(refused.text, why);
  }
  assert.equal(readTask(w.repo, '3').ownerDecisions, undefined);
  // On his own computer, through its command; on a teammate's, nothing.
  w.reply = command => command.type === 'remoteDecisions' ? { decisions: ['Ship Friday.'], line: 'Updated the task: added "Ship Friday.".' } : {};
  const there = await w.act('session_update_task', { computer: 'devbox', session: '27', add: ['Ship Friday.'] });
  assert.deepEqual(said(there), ['allow', 'level'], there.text);
  assert.deepEqual(w.sent.at(-1), { type: 'remoteDecisions', to: DEVBOX, ref: 'c0ffee00c0ffee00:27', change: { add: ['Ship Friday.'], change: [], remove: [], goal: null }, by: 'orchestrator' });
  const before = w.sent.length;
  assert.match((await w.act('session_update_task', { computer: 'laptop', session: '3', add: ['x'] })).text, /not one of the owner's own computers/);
  assert.equal(w.sent.length, before);
  setLevel('run', { by: 'owner' });
  assert.equal((await w.act('session_update_task', { session: '2', add: ['x'] })).decision, 'refused', 'Full only');
});

test('caps at Full: approvals count with messages an hour, and starts against the day', async t => {
  const w = world(t); w.session(2);
  setCap('messagesPerHour', 2);
  proposed(w, 2);
  assert.deepEqual(said(await w.act('session_message', { session: '2', text: 'One.' })), ['allow', 'level']);
  assert.deepEqual(said(await w.act('session_approve', { session: '2' })), ['allow', 'level']);
  const over = await w.act('session_message', { session: '2', text: 'Three.' });
  assert.deepEqual(said(over), ['capped', 'level']); assert.match(over.text, /2 messages and answers an hour/);
  setCap('sessionsPerDay', 1);
  assert.deepEqual(said(await w.act('session_start', { goal: 'One' })), ['allow', 'level']);
  assert.deepEqual(said(await w.act('session_start', { goal: 'Two' })), ['capped', 'level']);
});

test('the ask list: what publishes, tags, releases, runs a workflow, deploys, force-pushes or deletes is found however it is written', () => {
  for (const rule of FULL_ASK_LIST) assert.ok(askListed(rule.replace(/^Bash\(/, '').replace(/\)$/, '').replace(/:\*$/, ' x').replace(/\*/g, ' x ')), rule);
  for (const command of ['npm publish', 'cd pkg && npm publish --access public', 'bash -c "npm publish"', 'FOO=1 yarn publish', 'pnpm publish', 'npx -y lerna publish', 'git tag v1', 'git -C repo tag v2', 'git push --tags', 'git push origin main --follow-tags',
    'gh release create v1', 'gh workflow run ci.yml', 'gh repo delete me/x --yes', 'git push --force', 'git push -f origin x', 'git push origin +main', 'git -C repo push --force-with-lease', 'rm -rf ~', 'rm -rf ~/', 'rm -fr $HOME', 'rm -r -f ~/*',
    'firebase deploy', 'gcloud run deploy web', 'npm run deploy', 'make deploy:prod', 'terraform apply', 'kubectl apply -f a.yaml', 'helm upgrade web .', 'docker push web:1', 'vercel --prod']) assert.equal(askListed(command), true, command);
  for (const command of ['npm test', 'git push', 'git push origin feature', 'git commit -m "fix the deploy script"', 'gh pr create --title "deploy docs" --body "publish later"', 'ls ~', 'rm -rf node_modules', 'npm run build', 'git status', 'echo published', '', null]) assert.equal(askListed(command), false, String(command));
});

test('the ask list: what only lists, shows, verifies or rehearses never asks; making, pushing, publishing and deploying still do', () => {
  for (const command of ['git tag', 'git tag -l', 'git tag -l "v1.*"', 'git tag --list', 'git tag -n3', 'git tag --contains HEAD', 'git tag --merged main', 'git tag --points-at HEAD', 'git tag -v v1', 'git tag --sort=-creatordate', 'git -C repo tag -l', 'git --no-pager tag -l | head -5', 'cd repo && git tag -l', 'x=$(git tag -l)', 'git tag --help',
    'git push --dry-run --tags', 'git push -n --force origin x', 'gh release list', 'gh release view v1', 'gh release download v1', 'gh workflow view deploy', 'gh run list --workflow deploy', 'npm publish --dry-run', 'pnpm publish --dry-run',
    'kubectl get deploy -n prod', 'kubectl describe deploy web', 'kubectl rollout status deploy/web', 'kubectl apply -f a.yaml --dry-run=client', 'helm upgrade web . --dry-run', 'helm status deploy', 'gcloud deploy releases list --delivery-pipeline=web']) assert.equal(askListed(command), false, command);
  for (const command of ['git tag v1', 'git tag -a v1 -m "One"', 'git tag -d v1', 'git tag -f v1', 'git tag -i v1', 'git tag --format=%(refname) v1', 'git -c core.pager=less tag -l', 'git tag -l; git tag v2', 'git tag -l && npm publish', 'x=$(git tag -l) && git push --tags', 'echo v1 | xargs git tag', 'bash -c "git tag v1"',
    'gh release create v1', 'gh release delete v1', 'gh release upload v1 a.zip', 'yarn publish --dry-run', 'npx -y lerna publish --dry-run', 'npm run publish --dry-run', 'kubectl -n prod rollout restart deploy/web', 'kubectl apply -f a.yaml --dry-run=none', 'helm upgrade web .', 'gcloud run deploy list', 'gcloud deploy releases promote --release=r1']) assert.equal(askListed(command), true, command);
});

test('the relay at Full: its work allowed, the ask list asks him, its own files never, and below Full as before', async t => {
  const w = world(t), personal = path.join(process.env.XDG_CONFIG_HOME, 'elu-code');
  const at = (tool, input, mode = 'full') => overseeingAnswer(tool, { mode, input, full: true, cwd: w.root, servers: ['gmail'] });
  for (const [tool, input] of [['Bash', { command: 'npm test && gh pr merge 12 --squash' }], ['Edit', { file_path: path.join(w.root, 'a.js') }], ['Write', { file_path: 'b.js' }], ['Read', { file_path: '/etc/hosts' }], ['Task', {}], ['WebFetch', { url: 'https://example.test/?q=1' }]]) assert.equal(at(tool, input), 'allow', tool);
  assert.equal(at('Bash', { command: 'ls' }, 'auto'), 'allow', 'every other call is allowed at Full, whatever the mode');
  for (const command of ['npm publish', 'git push --force', 'gh release create v1', 'rm -rf ~']) assert.equal(at('Bash', { command }), 'ask', command);
  for (const [tool, input] of [['Edit', { file_path: path.join(personal, 'orchestrator.json') }], ['Write', { file_path: path.join(personal, 'orchestrator', 'mandates.json') }], ['Write', { file_path: path.join(personal, 'peer', 'my-computers.json') }], ['Bash', { command: `echo '{}' > ${path.join(personal, 'orchestrator.json')}` }], ['Bash', { command: 'cd ~/.config/elu-code && sed -i "" s/run/full/ orchestrator.json' }], ['Bash', { command: 'rm ~/.config/elu-code/peer/mine.json' }]]) assert.equal(at(tool, input), 'deny', `${tool} ${JSON.stringify(input)}`);
  assert.equal(at('mcp__gmail__send_email', {}), 'ask', 'a change through a source still asks');
  assert.equal(at('mcp__gmail__search_emails', { query: 'invoice' }), 'allow');
  assert.equal(at('Bash', { command: 'ls' }, 'locked'), 'deny');
  assert.equal(overseeingAnswer('Bash', { mode: 'full', input: { command: 'ls' } }), 'deny', 'below Full no shell');
  // Through the relay: the level on disk is read at each question.
  const ctx = { mode: 'full', root: w.root, taskId: '1', role: 'bot:orchestrator', vendor: 'claude', bot: 'orchestrator', servers: ['elu', 'gmail'], run: 'sess-1', rules: 'saved', cwd: w.root, waitSeconds: 600 };
  assert.deepEqual(await overseeing('Bash', { command: 'npm test' }, { id: 'f1', ...ctx }), { decision: 'allow', by: 'full', summary: 'Run: npm test' });
  const own = await overseeing('Write', { file_path: path.join(personal, 'orchestrator.json'), content: '{}' }, { id: 'f2', ...ctx });
  assert.deepEqual([own.decision, own.by, own.message], ['deny', 'oversee', OVERSEE_OWN_DENIED]);
  const publish = overseeing('Bash', { command: 'npm publish' }, { id: 'f3', ...ctx });
  for (let tries = 0; tries < 250 && !pendingApprovals().length; tries++) await new Promise(resolve => setTimeout(resolve, 20));
  const [asked] = pendingApprovals();
  assert.equal(asked.oversee, true, 'marked as the bot\'s, so the app never answers it for him');
  assert.equal(asked.rules, undefined, 'no rule is offered for it');
  const { answerApproval } = await import('../lib/approvals.mjs'); answerApproval(asked.id, 'deny');
  assert.equal((await publish).decision, 'deny');
  setLevel('run', { by: 'owner' });
  assert.equal((await overseeing('Bash', { command: 'npm test' }, { id: 'f4', ...ctx })).decision, 'deny', 'the level dropped: no shell from the next question on');
});

test('the relay serves all of Full\'s tools at Full, and allows its work by Full', async t => {
  const w = world(t), log = path.join(temp(t), 'approvals.jsonl');
  const argv = ['--session', 'sess-1', '--root', w.root, '--task', '1', '--role', 'bot:orchestrator', '--vendor', 'claude', '--log', log, '--wait', '600', '--rules', 'saved', '--sandboxed', 'no', '--mode', 'full', '--folders', '[]', '--oversee', 'orchestrator', '--servers', '["elu"]'];
  const input = new PassThrough(), output = new PassThrough(), rows = [];
  let buffer = '';
  output.on('data', chunk => { buffer += chunk; for (let index; (index = buffer.indexOf('\n')) >= 0;) { rows.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); } });
  const done = serve({ argv, input, output });
  t.after(() => { input.end(); return done; });
  const reply = async id => { for (let tries = 0; tries < 250; tries++) { const row = rows.find(value => value.id === id); if (row) return row; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('No reply.'); };
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
  assert.deepEqual((await reply(1)).result.tools.map(tool => tool.name), [TOOL_NAME, ...ORCH_TOOLS]);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: TOOL_NAME, arguments: { tool_name: 'Bash', input: { command: 'npm test' } } } })}\n`);
  assert.equal(JSON.parse((await reply(2)).result.content[0].text).behavior, 'allow');
  assert.deepEqual(readApprovalLog(log).map(row => [row.tool, row.decision, row.by ?? null]), [['Bash', 'allow', 'full']]);
});
