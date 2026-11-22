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
import { mandateFor, mandates, mandatesFile, removeMandate, saveMandate } from '../lib/orchestrator-mandates.mjs';
import { projectKey } from '../lib/peer/remote.mjs';
import { act, actionLine, askListed, readActions, undoAction } from '../lib/orchestrator-actions.mjs';
import { ORCH_TOOLS, ORCH_TOOL_DEFS, orchToolDefs, overseeingAnswer } from '../lib/orchestrator-tools.mjs';
import { OVERSEE_OWN_DENIED, TOOL_NAME, overseeing, serve } from '../lib/approval-server.mjs';

// The level Full: the Orchestrator's session tools on this computer and on the owner's own
// others, his word inside his mandates, the ask list that still asks him, and the audit of what
// it did as him. Below Full nothing of this exists (test/orchestrator-actions.test.mjs).

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
const mandate = (w, sessions, extra = {}) => saveMandate({ name: 'Checkout', goal: 'Checkout under one second', decisions: ['Helpers may run on credits.', 'Postgres, not MySQL.'], sessions, ...extra }, { by: 'owner' });
const here = (w, id) => ({ computer: null, project: projectKey(w.root), session: String(id) });

test('settings: Full is set only by the owner, has its own caps and ceilings, and lowers nothing below it', t => {
  const w = world(t, { level: null });
  assert.equal(readSettings().level, 'suggest', 'a new install stays at Suggest');
  for (const who of [undefined, { by: 'turn' }, { typed: true }]) assert.throws(() => setLevel('full', who), /Only you set the level to Full/);
  setCap('messagesPerHour', 4);
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
  assert.deepEqual(Object.keys(start.inputSchema.properties).sort(), ['access', 'botModels', 'bots', 'computer', 'folders', 'goal', 'mandate', 'model', 'place', 'project', 'title']);
});

test('a start at Full gives the session everything it is told, its mandate\'s decisions, and no budget of the bot\'s', async t => {
  const w = world(t), extra = temp(t);
  saveBot({ name: 'reviewer', instructions: 'Review the change.' });
  const m = mandate(w, []);
  const out = await w.act('session_start', { goal: 'Make checkout fast', title: 'Checkout speed', model: { vendor: 'claude', model: 'opus', effort: 'high' }, bots: ['@reviewer'], botModels: { reviewer: { vendor: 'claude', effort: 'low' } }, access: 'full', place: 'here', folders: [extra], mandate: 'checkout' });
  assert.deepEqual(said(out), ['allow', 'level'], out.text);
  assert.equal(w.asked.length, 0);
  const [row] = w.queued;
  assert.deepEqual([row.permissions, row.place, row.bots, row.title, row.model, row.botModels, row.overseer, row.budgetUsd, row.mandate],
    ['full', { kind: 'here' }, ['reviewer'], 'Checkout speed', { vendor: 'claude', model: 'opus', effort: 'high' }, { reviewer: { vendor: 'claude', model: null, effort: 'low' } }, 'orchestrator', undefined, m.id]);
  assert.equal(row.folders.length, 1);
  assert.equal(row.goal, "Make checkout fast\n\nOwner's decisions (mandate Checkout):\n- Helpers may run on credits.\n- Postgres, not MySQL.");
  assert.match(out.text, /Full access, its own budget, in its project folder itself, claude · opus at high, @reviewer, 1 extra folder, under the mandate Checkout/);
  assert.deepEqual(mandates()[0].sessions, [{ computer: null, project: projectKey(w.root), session: `request-${row.id}` }]);
  // Never more than this session and this turn have.
  const capped = await w.act('session_start', { goal: 'Look around', access: 'full' }, { mode: 'auto' });
  assert.equal(w.queued.at(-1).permissions, 'auto', capped.text);
  assert.match(capped.text, /Approve for me \(the most it may give; Full access was asked\)/);
  for (const [input, why] of [
    [{ goal: 'x', bots: ['orchestrator'] }, /oversees the sessions: it joins none of them/],
    [{ goal: 'x', bots: ['nobody'] }, /There is no bot named nobody/],
    [{ goal: 'x', model: { vendor: 'claude', effort: 'ultra' } }, /takes the efforts low, medium, high, xhigh, max, not ultra/],
    [{ goal: 'x', mandate: 'nope' }, /The owner has no mandate named nope\. His mandates: m1 Checkout/],
    [{ goal: 'x', title: 'a\nb'.repeat(150) }, /Keep the name to 200 characters|A session name is one line/],
    [{ goal: 'x', computer: 'laptop' }, /@laptop is not marked as one of the owner's own computers here/],
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

test("inside a mandate a message and an answer are the owner's word; outside it they stay notes, and the log says which", async t => {
  const w = world(t); w.session(2); w.session(3, ASKS); w.session(4, { permissions: 'full' }); w.session(5); proposed(w, 5);
  w.session(6, { state: 'stopped', error: { message: 'Stopped by the owner.' } });
  const m = mandate(w, [here(w, 3), here(w, 5), here(w, 6)]);
  const note = await w.act('session_message', { session: '2', text: 'The checks fail on main.' });
  assert.deepEqual(said(note), ['allow', 'level']);
  assert.equal(w.queued.at(-1).overseer, 'orchestrator'); assert.equal(w.queued.at(-1).asOwner, undefined);
  // Outside a mandate a session in Full access still asks him first.
  await w.act('session_message', { session: '4', text: 'Carry on.' });
  assert.equal(w.asked.length, 1);
  const word = await w.act('session_answer', { session: '3', text: 'Use Postgres.' });
  assert.deepEqual(said(word), ['allow', 'level'], word.text);
  assert.deepEqual(w.queued.at(-1).asOwner, { bot: 'orchestrator', mandate: m.id, computer: null });
  assert.equal(w.queued.at(-1).overseer, undefined, 'his word never carries the bot\'s mark');
  assert.match(word.text, /as the owner's word, under his mandate Checkout/);
  // His word goes where only his goes: a Task that waits for him, a session he stopped.
  assert.deepEqual(said(await w.act('session_message', { session: '5', text: 'Go on with the plan.' })), ['allow', 'level']);
  assert.deepEqual(said(await w.act('session_message', { session: '6', text: 'Go on.' })), ['allow', 'level']);
  const dropped = await w.act('session_message', { session: '3', text: 'Use Postgres 16.' }, { enqueue: (at, goal, { asOwner, ...fields }) => w.enqueue(at, goal, fields) });
  assert.deepEqual(said(dropped), ['refused', 'level'], 'a conductor that drops his mark sends nothing');
  // The audit: asOwner and the mandate on what it did as him, and only on that.
  const rows = readActions();
  assert.deepEqual(rows.map(row => [row.action, row.target?.session ?? null, row.asOwner ?? false, row.mandate ?? null, row.decision]).filter(row => row[4] === 'allow'),
    [['session_message', '2', false, null, 'allow'], ['session_message', '4', false, null, 'allow'], ['session_answer', '3', true, 'm1', 'allow'], ['session_message', '5', true, 'm1', 'allow'], ['session_message', '6', true, 'm1', 'allow']]);
  assert.match(actionLine(rows[2], T0), /as you, under the mandate Checkout/);
  assert.equal(actionLine(rows[0], T0).includes('as you'), false);
  // Below Full the same mandate makes nothing his.
  setLevel('run', { by: 'owner' });
  const run = await w.act('session_message', { session: '5', text: 'Go on.' });
  assert.match(run.text, /waits for the owner's approval\. Only he approves a Task/);
});

test('session_approve approves a Task or a permission for him only inside a mandate, and never what only he answers', async t => {
  const w = world(t); w.session(2); proposed(w, 2); w.session(3); proposed(w, 3, 'Other');
  const outside = await w.act('session_approve', { session: '3' });
  assert.deepEqual(said(outside), ['refused', 'level']); assert.match(outside.text, /in none of the owner's mandates/);
  mandate(w, [here(w, 2)]);
  const out = await w.act('session_approve', { session: '2' });
  assert.deepEqual(said(out), ['allow', 'level'], out.text);
  assert.equal(currentTask(w.repo, '2').state, 'approved');
  assert.deepEqual([w.queued.at(-1).goal, w.queued.at(-1).approved, w.queued.at(-1).asOwner?.mandate], ['Approved the Task: Ship it', true, 'm1']);
  assert.equal(currentTask(w.repo, '3').state, 'proposed');
  assert.match((await w.act('session_approve', { session: '2' })).text, /No Task waits for approval/);
  // A permission request, by its id from session_read.
  const ask = (id, tool, input, extra = {}) => requestApproval({ id, root: w.root, taskId: '2', role: 'lead', vendor: 'claude', tool, input, waitSeconds: 600, ...extra });
  ask('perm-test', 'Bash', { command: 'npm test' }); ask('perm-publish', 'Bash', { command: 'cd pkg && npm publish' }); ask('perm-force', 'Bash', { command: 'git push origin main --force' });
  ask('perm-mine', 'mcp__elu-code-approval__session_start', {}, { oversee: true }); ask('perm-mail', 'mcp__gmail__send_email', { to: 'a@example.test' });
  const read = inBlock((await w.act('session_read', { session: '2' })).text);
  assert.equal(read.mandate, 'm1 Checkout: your words there are the owner\'s');
  assert.deepEqual(read.approvals.map(row => row.id).sort(), ['perm-force', 'perm-mail', 'perm-mine', 'perm-publish', 'perm-test']);
  const allowed = await w.act('session_approve', { session: '2', approval: 'perm-test', decision: 'allow' });
  assert.deepEqual(said(allowed), ['allow', 'level'], allowed.text);
  assert.equal(pendingApprovals({ taskId: '2' }).some(row => row.id === 'perm-test'), false);
  for (const [id, why] of [['perm-publish', /the owner's to answer, at every level/], ['perm-force', /the owner's to answer/], ['perm-mine', /a question of the bot that oversees the sessions/], ['perm-mail', /reads that request .* whole/], ['perm-none', /No permission request perm-none waits/]]) {
    const refused = await w.act('session_approve', { session: '2', approval: id, decision: 'allow' });
    assert.deepEqual(said(refused), ['refused', 'level'], id); assert.match(refused.text, why);
  }
  assert.equal(pendingApprovals({ taskId: '2' }).length, 4);
  assert.deepEqual(readActions().filter(row => row.decision === 'allow' && row.action === 'session_approve').map(row => [row.asOwner, row.mandate]), [[true, 'm1'], [true, 'm1']]);
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
  assert.match((await w.act('session_rename', { session: '4', title: 'Theirs' })).text, /The owner named web #4 .*himself/);
  mandate(w, [here(w, 4)]);
  assert.deepEqual(said(await w.act('session_rename', { session: '4', title: 'Theirs' })), ['allow', 'level'], 'inside a mandate it may');
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

test('on the owner\'s own computer it does all of it, his word inside a mandate; on a teammate\'s nothing', async t => {
  const w = world(t);
  // A note there outside a mandate asks him, as below Full, and a Task that waits for him takes none.
  assert.match((await w.act('session_message', { computer: 'devbox', session: '27', text: 'Look at the checkout page.' })).text, /waits for the owner's approval/);
  await w.act('session_message', { computer: 'devbox', session: '69', text: 'Look at the checkout page.' });
  assert.equal(w.asked.length, 1); assert.equal(w.sent.at(-1).asOwner, undefined);
  saveMandate({ name: 'Speed', goal: 'Every page fast', decisions: [], sessions: [{ computer: DEVBOX, project: 'c0ffee00c0ffee00', session: '27' }] }, { by: 'owner' });
  w.reply = { id: 'x', overseer: 'orchestrator', asOwner: true };
  const word = await w.act('session_message', { computer: 'devbox', session: '27', text: 'Approve round 2.' });
  assert.deepEqual(said(word), ['allow', 'level'], word.text);
  assert.equal(w.asked.length, 1, 'his word inside a mandate is not asked about');
  assert.deepEqual(w.sent.at(-1), { type: 'remoteSend', to: DEVBOX, ref: 'c0ffee00c0ffee00:27', text: 'Approve round 2.', overseer: 'orchestrator', asOwner: { bot: 'orchestrator', mandate: 'm1', computer: ME } });
  assert.equal(readActions().at(-1).asOwner, true);
  // A computer that did not take it as his: said so, and not logged as his.
  w.reply = { id: 'x', overseer: 'orchestrator' };
  const older = await w.act('session_message', { computer: 'devbox', session: '27', text: 'Again.' });
  assert.match(older.text, /did not take it as the owner's word/);
  assert.equal(readActions().at(-1).asOwner, undefined);
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
    assert.deepEqual(said(out), ['refused', 'level'], name); assert.match(out.text, /not marked as one of the owner's own computers|in none of the owner's mandates/);
  }
  assert.equal(w.sent.length, before);
  // A start there: only on his own, with what it is told, and the session joins the mandate.
  w.reply = command => command.type === 'remoteFolders' ? { pick: true, folders: [{ path: '/work/shop', label: 'shop', name: 'shop', project: true }] } : { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', project: 'shop', projectId: 'c0ffee00c0ffee00' };
  const start = await w.act('session_start', { computer: 'devbox', project: 'shop', goal: 'Profile search', title: 'Search', access: 'full', bots: ['tester'], mandate: 'm1' });
  assert.deepEqual(said(start), ['allow', 'level'], start.text);
  const sent = w.sent.at(-1);
  assert.deepEqual([sent.type, sent.to, sent.folder, sent.permissions, sent.title, sent.bots, sent.mandate, sent.budgetUsd], ['remoteStart', DEVBOX, '/work/shop', 'full', 'Search', ['tester'], 'm1', undefined]);
  assert.ok(mandateFor({ computer: DEVBOX, project: 'c0ffee00c0ffee00', session: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }));
  assert.match((await w.act('session_start', { computer: 'laptop', goal: 'x' })).text, /not marked as one of the owner's own computers/);
});

test('mandate_propose always asks him, and only his yes makes one', async t => {
  const w = world(t); w.session(2);
  w.answer = 'deny';
  const no = await w.act('mandate_propose', { name: 'Release', goal: 'Ship 2.0', decisions: ['Merge when green.'], sessions: [{ session: '2' }] });
  assert.deepEqual(said(no), ['deny', 'owner']); assert.deepEqual(mandates(), []);
  w.answer = 'allow';
  const yes = await w.act('mandate_propose', { name: 'Release', goal: 'Ship 2.0', decisions: ['Merge when green.'], sessions: [{ session: '2' }] });
  assert.deepEqual(said(yes), ['allow', 'owner'], yes.text);
  assert.match(w.asked.at(-1).whole, /Mandate: Release\nGoal: Ship 2\.0\nDecisions:\n- Merge when green\.\nSessions:\n- web #2/);
  assert.deepEqual(mandates().map(row => [row.id, row.name, row.decisions, row.sessions]), [['m1', 'Release', ['Merge when green.'], [here(w, 2)]]]);
  const changed = await w.act('mandate_propose', { id: 'm1', decisions: ['Merge when green.', 'No Friday deploys.'] });
  assert.deepEqual(said(changed), ['allow', 'owner']);
  assert.deepEqual(mandates()[0].decisions, ['Merge when green.', 'No Friday deploys.']);
  assert.equal(mandates()[0].sessions.length, 1);
  // Ended by the owner only, and its id is never given again.
  assert.throws(() => removeMandate('m1', { by: 'turn' }), /Only the owner/);
  assert.equal(removeMandate('release', { by: 'owner' }).id, 'm1');
  assert.equal(saveMandate({ name: 'Next', goal: '' }, { by: 'owner' }).id, 'm2');
  assert.ok(fs.existsSync(mandatesFile()));
});

test('caps at Full: approvals count with messages an hour, and starts against the day', async t => {
  const w = world(t); w.session(2);
  setCap('messagesPerHour', 2);
  mandate(w, [here(w, 2)]);
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
