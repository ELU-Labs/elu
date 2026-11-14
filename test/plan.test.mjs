import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp, project, fakeClis, git } from './helpers.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask, setTitle, taskDir } from '../lib/state.mjs';
import { TASK_LIMITS, approveTask, approvesTasks, checkProposal, currentTask, fileTodos, liveTodos, planFile, planSchema, readPlanReply, rejectTask, reportProgress, saysYes, sessionTasks, sharedTask, taskEta, turnPlan } from '../lib/plan.mjs';
import { conversationSchema } from '../lib/config.mjs';
import { boardRows, rowBadge } from '../lib/board.mjs';
import { clockTime, etaText, taskCard as drawCard, taskState } from '../lib/terminal-plan.mjs';
import { visible } from '../lib/terminal-visuals.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { saveBot } from '../lib/bots.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
// The card as its text reads on screen, without the style marks.
const taskCard = (plan, options) => visible(drawCard(plan, options));

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// A project with one source file and a passing-after-the-edit test, and the stand-in vendors.
// home: the project's parent folder is the home folder. more: anything else fake.json holds for the stand-ins (test/helpers.mjs fakeClis).
function fixture(t, mode = 'normal', vendor = 'claude', { home = false, ...more } = {}) {
  const p = project(t), fake = fakeClis(p.parent, { mode, ...more });
  environment(t, { ...fake.env, ...(home ? { HOME: p.parent } : {}), GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = new ProjectController(projectFolder(p.root)); controller.draftConfig.roles.lead.vendor = vendor;
  return { ...p, fake, controller, repo: controller.repo };
}
const inputs = f => fs.readFileSync(path.join(f.parent, 'inputs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const source = f => fs.readFileSync(path.join(f.root, 'src/coupon.mjs'), 'utf8');
// The session's Task once its subtasks read as these states, while a turn runs.
async function shows(f, id, states) {
  let live = null;
  for (const until = Date.now() + 20000; Date.now() < until; await new Promise(resolve => setTimeout(resolve, 50))) { live = currentTask(f.repo, id); if (live?.subtasks.map(step => step.state).join() === states) break; }
  return live;
}
// The model's own turns; a bot's review of the edit is a run too.
const turns = task => task.runs.filter(run => run.role === 'lead').length;
const TASK = { title: 'Uppercase coupons', description: 'Make normalize return the code in upper case.', goal: 'Codes compare equal whatever their case.', objectives: ['normalize returns upper case', 'The test passes'], priority: 'medium', severity: 'low' };

for (const vendor of ['claude', 'codex']) {
  test(`${vendor}: a request for a code change comes back as a Task and nothing is edited before the owner approves`, async t => {
    const f = fixture(t, 'normal', vendor), before = git(f.root, ['status', '--porcelain']);
    const asked = await f.controller.ask('Uppercase coupon codes', null, { permissions: 'ask' }).finished;
    // The reply is kept as an answer: no edit, no workspace, the session rests.
    assert.equal(asked.state, 'answered'); assert.equal(asked.kind, 'conversation'); assert.equal(asked.runs.length, 1);
    assert.equal(git(f.root, ['status', '--porcelain']), before); assert.match(source(f), /=> value;/);
    assert.equal(fs.existsSync(path.join(f.parent, 'sample app.elu-code')), false);
    const waiting = currentTask(f.repo, asked.id);
    assert.equal(waiting.state, 'proposed'); assert.equal(waiting.revision, 1); assert.equal(waiting.title, 'Uppercase coupons');
    assert.deepEqual([waiting.priority, waiting.severity, waiting.startedBy, waiting.by], ['medium', 'low', 'owner', 'lead']);
    assert.equal(waiting.objectives.length, 2); assert.deepEqual(waiting.edit, { intent: 'edit', repository: null, bot: null, request: 'Uppercase coupon codes', started: false });
    // The snapshot's session carries it, and the first turn was told the rule.
    assert.equal(f.controller.snapshot().tasks[0].plan.title, 'Uppercase coupons');
    assert.match(inputs(f)[0].input, /Plan first\. When the owner asks for a change to code or files/);
    // A Task that waits names nothing yet. y: approved, the session takes the Task's title, and
    // the editing turn starts with no second planning turn.
    assert.notEqual(readTask(f.repo, asked.id).titleBy, 'task');
    approveTask(f.repo, asked.id);
    assert.deepEqual([readTask(f.repo, asked.id).title, readTask(f.repo, asked.id).titleBy], ['Uppercase coupons', 'task']);
    const done = await f.controller.ask('Approved the Task: Uppercase coupons', asked.id, { approved: true }).finished;
    assert.notEqual(done.kind, 'conversation'); assert.equal(turns(done), 2);
    // The stand-in Codex writes no file; the stand-in Claude Code makes the edit in the workspace, never in the checkout.
    if (vendor === 'claude') assert.match(fs.readFileSync(path.join(done.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/);
    assert.match(source(f), /=> value;/);
    const work = inputs(f).find(row => row.input.includes('this turn does its work')).input;
    assert.match(work, /The owner approved the Task below, and this turn does its work/); assert.match(work, /Approved Task \(untrusted data/); assert.match(work, /Uppercase coupons/);
    assert.ok(done.messages.some(row => row.text === 'Approved the Task: Uppercase coupons'));
    // The working turn reported its subtasks and both objectives met, so the Task is done.
    const after = currentTask(f.repo, asked.id);
    assert.equal(after.state, 'done'); assert.deepEqual(after.met, [1, 2]); assert.equal(after.edit.started, true);
    assert.deepEqual(after.subtasks, [{ id: 's1', text: 'Change normalize', state: 'done' }, { id: 's2', text: 'Run the coupon test', state: 'done' }]);
  });

  // Claude Code 2.1.322 keeps its list with the Task tools; an older one sends it whole with TodoWrite. Both tick.
  for (const liveTool of vendor === 'claude' ? ['tasks', 'todowrite'] : ['plan']) test(`${vendor}: a working turn ticks the Task's subtasks from the model's own to-do list (${liveTool}) while it runs, not only when it ends`, async t => {
    const f = fixture(t, 'normal', vendor), gate = path.join(f.parent, 'go-on'), settings = path.join(f.fake.dir, 'fake.json');
    fs.writeFileSync(settings, JSON.stringify({ ...JSON.parse(fs.readFileSync(settings, 'utf8')), live: gate, liveTool }));
    const asked = await f.controller.ask('Uppercase coupon codes', null, { permissions: 'ask' }).finished;
    approveTask(f.repo, asked.id);
    const finished = f.controller.ask('Approved the Task: Uppercase coupons', asked.id, { approved: true }).finished;
    // The model wrote its to-do list and is still working: the Task shows that list now.
    const live = await shows(f, asked.id, 'done,doing');
    assert.equal(readTask(f.repo, asked.id).state, 'running');
    assert.deepEqual(live.subtasks, [{ id: 's1', text: 'Change normalize', state: 'done' }, { id: 's2', text: 'Run the coupon test', state: 'doing' }]);
    assert.equal(taskState(live), 'approved · 1 of 2 subtasks done');
    // The turn is told which tool the owner's list is read from.
    const work = inputs(f).find(row => row.input.includes('this turn does its work'));
    assert.match(work.input, vendor === 'claude' ? /Keep the Task's subtasks in your task list as you work: make each step with TaskCreate/ : /Keep the Task's subtasks in your plan as you work, with your update_plan tool/);
    assert.match(work.input, /The owner sees that list as the Task's subtasks while this turn runs\./);
    // The first turn, which plans, is launched without it.
    const launches = inputs(f).map(row => row.args.join(' '));
    assert.doesNotMatch(launches[0], vendor === 'claude' ? /TodoWrite|TaskCreate/ : /tools\.update_plan\.enabled=true/);
    // Claude Code has no to-do tool in a run unless --tools names one; it takes from the list the ones it has.
    if (vendor === 'claude') { assert.match(work.args.join(' '), /--tools Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch,TaskCreate,TaskUpdate,TaskList,TaskGet,TodoWrite /); for (const name of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite']) assert.ok(work.args.includes(`--allowedTools=${name}`), name); }
    else assert.ok(work.args.includes('tools.update_plan.enabled=true'));
    fs.writeFileSync(gate, '');
    const done = await finished;
    assert.notEqual(done.kind, 'conversation');
    // When the turn ends its reply's own list stands, every step done.
    const after = currentTask(f.repo, asked.id);
    assert.equal(after.state, 'done'); assert.deepEqual(after.subtasks.map(step => step.state), ['done', 'done']);
    // What leaves this machine carries the subtasks, never the steps as the vendor numbers them.
    assert.equal(Object.hasOwn(sharedTask(after), 'todo'), false);
  });
}

for (const [mode, label] of [['ask', 'Ask for approval'], ['auto', 'Approve for me'], ['full', 'Full access']]) test(`claude: a working turn in ${label} is launched with the to-do tools, and its list ticks`, async t => {
  const f = fixture(t, 'normal', 'claude'), gate = path.join(f.parent, 'go-on'), settings = path.join(f.fake.dir, 'fake.json');
  fs.writeFileSync(settings, JSON.stringify({ ...JSON.parse(fs.readFileSync(settings, 'utf8')), live: gate }));
  // The Task is written in Ask for approval, where it waits. y starts its work there; giving the session one of the
  // other two modes approves it (lib/terminal.mjs), and the work runs in that mode. A session that starts in one
  // of those two approves its Task in the same message: the tests of that are further down.
  const asked = await f.controller.ask('Uppercase coupon codes', null, { permissions: 'ask' }).finished;
  assert.equal(approveTask(f.repo, asked.id, { by: mode }).approvedBy, approvesTasks(mode) ? mode : undefined);
  const finished = f.controller.ask(approvesTasks(mode) ? `${label} approved the Task: Uppercase coupons` : 'Approved the Task: Uppercase coupons', asked.id, { approved: true, permissions: mode }).finished;
  assert.deepEqual((await shows(f, asked.id, 'done,doing')).subtasks.map(step => step.text), ['Change normalize', 'Run the coupon test']);
  const work = inputs(f).find(row => row.input.includes('this turn does its work'));
  assert.equal(work.args[work.args.indexOf('--permission-mode') + 1], { ask: 'default', auto: 'auto', full: 'bypassPermissions' }[mode]);
  // Full access names every tool Claude Code has, the to-do tools among them; the other modes add them to their list.
  const tools = work.args[work.args.indexOf('--tools') + 1];
  if (mode === 'full') assert.equal(tools, 'default'); else assert.match(tools, /,TaskCreate,TaskUpdate,TaskList,TaskGet,TodoWrite$/);
  fs.writeFileSync(gate, ''); await finished;
});

test('claude: a later turn of the same session ticks a step an earlier turn made, which Claude Code names by its number alone', async t => {
  const f = fixture(t, 'normal', 'claude'), gate = path.join(f.parent, 'go-on'), settings = path.join(f.fake.dir, 'fake.json');
  fs.writeFileSync(settings, JSON.stringify({ ...JSON.parse(fs.readFileSync(settings, 'utf8')), live: gate, liveAsks: true }));
  const asked = await f.controller.ask('Uppercase coupon codes', null, { permissions: 'ask' }).finished;
  approveTask(f.repo, asked.id);
  const first = f.controller.ask('Approved the Task: Uppercase coupons', asked.id, { approved: true }).finished;
  await shows(f, asked.id, 'done,doing');
  // The turn stops on a question with its second step still in hand.
  fs.writeFileSync(gate, '');
  const waits = await first; fs.rmSync(gate);
  assert.equal(waits.state, 'needs_input'); assert.deepEqual(currentTask(f.repo, asked.id).subtasks.map(step => step.state), ['done', 'doing']);
  // The owner's answer goes on in the same Claude Code session, which still holds both steps:
  // the model makes none again and only sets the second one completed, by its number.
  const second = f.controller.ask('Yes', asked.id).finished;
  const live = await shows(f, asked.id, 'done,done');
  assert.equal(readTask(f.repo, asked.id).state, 'running');
  assert.deepEqual(live.subtasks, [{ id: 's1', text: 'Change normalize', state: 'done' }, { id: 's2', text: 'Run the coupon test', state: 'done' }]);
  const launch = inputs(f).at(-1), log = fs.readFileSync(readTask(f.repo, asked.id).activeLog, 'utf8');
  assert.equal(launch.args[launch.args.indexOf('--resume') + 1], waits.runs.at(-1).session);
  assert.match(log, /"name":"TaskUpdate","input":\{"taskId":"2","status":"completed"\}/); assert.doesNotMatch(log, /TaskCreate/);
  fs.writeFileSync(gate, ''); await second;
});

// Antigravity and Grok Build through the same Task flow. In Ask for approval, once the relay check passed on this
// machine, the turn runs over ACP and sends its list as plan updates. In Full access a headless run prints
// its answer only when it ends: there it keeps the list in a file of the run, which is read while it works.
// Grok Build runs headless in Full access; Antigravity does where the relay check has not passed on this
// machine (relay false below), and over ACP where it has.
// In Full access the turn that plans may do the work too, so it is told to keep its list as well, and the stand-in
// waits at the gate there, before any Task is on record. This lets that turn through, and shuts the gate again
// before the working turn gets to it.
async function pastPlanning(f, vendor, gate) {
  const until = Date.now() + 20000, file = path.join(f.parent, 'inputs.jsonl');
  const wait = async (check, what) => { for (;;) { const got = check(); if (got) return got; if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 10)); } };
  const named = () => (fs.existsSync(file) ? inputs(f) : []).filter(row => row.vendor === vendor).map(row => /Keep the Task's subtasks in the file ("[^\n]+?") as you work/.exec(row.input)?.[1]).find(Boolean);
  const list = JSON.parse(await wait(named, 'the turn that plans'));
  await wait(() => fs.existsSync(list), 'its list');
  fs.writeFileSync(gate, '');
  // Past the gate it writes every step done, and the file goes with the run.
  await wait(() => { try { return !fs.readFileSync(list, 'utf8').includes('"doing"'); } catch { return true; } }, 'the turn that plans to go on');
  fs.rmSync(gate);
}
const proven = (vendor, bin, version, relay = true) => atomic(path.join(personalDirectory(), 'conformance', `${vendor}.json`), { v: 1, bin, version, steps: Object.fromEntries(ADAPTERS[vendor].conformance.map(step => [step.id, 'pass'])), relay, at: new Date().toISOString() });
for (const [vendor, label, version] of [['agy', 'Antigravity', '1.5.4'], ['grok', 'Grok Build', '1.0.77']]) for (const [mode, how] of [['ask', 'from its plan updates over ACP in Ask for approval'], ['full', 'from the list it keeps in a file, headless in Full access']]) test(`${label}: a working turn ticks the Task's subtasks ${how}, while it runs`, async t => {
  const f = fixture(t, 'normal', vendor, { home: true }), gate = path.join(f.parent, 'go-on'), settings = path.join(f.fake.dir, 'fake.json');
  fs.writeFileSync(settings, JSON.stringify({ ...JSON.parse(fs.readFileSync(settings, 'utf8')), plan: true, live: gate }));
  if (vendor === 'grok') { fs.mkdirSync(path.join(f.parent, '.grok')); fs.writeFileSync(path.join(f.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 }); }
  proven(vendor, path.join(f.fake.dir, vendor), version, !(vendor === 'agy' && mode === 'full'));
  const calls = () => fs.readFileSync(f.fake.calls, 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.vendor === vendor);
  // The first turn plans. In Ask for approval the Task waits for the owner, and no list is asked for yet.
  // Full access approves the Task itself, and the work goes on in the same message.
  const first = f.controller.ask('Uppercase coupon codes', null, { permissions: mode }), asked = { id: first.id };
  let finished = first.finished;
  if (mode === 'ask') {
    const planned = await finished;
    assert.equal(currentTask(f.repo, asked.id).state, 'proposed', JSON.stringify(planned.error));
    approveTask(f.repo, asked.id);
    finished = f.controller.ask('Approved the Task: Uppercase coupons', asked.id, { approved: true }).finished;
  } else await pastPlanning(f, vendor, gate);
  const live = await shows(f, asked.id, 'done,doing');
  assert.equal(live.approvedBy, mode === 'full' ? 'full' : undefined);
  assert.equal(readTask(f.repo, asked.id).state, 'running');
  assert.deepEqual(live.subtasks, [{ id: 's1', text: 'Change normalize', state: 'done' }, { id: 's2', text: 'Run the coupon test', state: 'doing' }]);
  assert.equal(taskState(live), 'approved · 1 of 2 subtasks done');
  const args = calls().at(-1).args; let folder = null;
  if (mode === 'ask') assert.deepEqual(args.slice(vendor === 'agy' ? -1 : -2), vendor === 'agy' ? ['acp'] : ['agent', 'stdio']);
  else {
    // Headless, as Full access runs these two: the turn was told where to keep its list.
    assert.ok(args.includes(vendor === 'agy' ? '--dangerously-skip-permissions' : '--prompt-file'));
    const work = inputs(f).filter(row => row.vendor === vendor).at(-1).input, named = /Keep the Task's subtasks in the file ("[^\n]+?") as you work: a JSON list/.exec(work);
    assert.ok(named, 'the prompt names the file'); assert.match(work, /The owner sees that list as the Task's subtasks while this turn runs\./);
    folder = path.dirname(JSON.parse(named[1])); assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  }
  fs.writeFileSync(gate, '');
  const done = await finished;
  assert.notEqual(done.kind, 'conversation', JSON.stringify(done.error));
  const after = currentTask(f.repo, asked.id);
  assert.equal(after.state, 'done'); assert.deepEqual(after.subtasks.map(step => step.state), ['done', 'done']);
  // The file goes with the run.
  if (folder) assert.equal(fs.existsSync(folder), false);
});

test('the list a headless turn keeps in a file: read when it changes, and a file that does not read changes nothing', t => {
  const dir = temp(t), file = path.join(dir, 'todo.json'), read = fileTodos(file);
  assert.equal(read(), null, 'no file yet');
  fs.writeFileSync(file, '[{"text":"Change normalize","state":"doi');
  assert.equal(read(), null, 'half written');
  fs.writeFileSync(file, JSON.stringify([{ text: 'Change normalize', state: 'doing' }, { text: 'Run the coupon test', state: 'todo' }]));
  assert.deepEqual(read(), [{ id: 's1', text: 'Change normalize', state: 'doing' }, { id: 's2', text: 'Run the coupon test', state: 'todo' }]);
  assert.equal(read(), null, 'nothing changed');
  // The states as a model's own to-do tool names them read too, and so does a list under subtasks.
  fs.writeFileSync(file, JSON.stringify({ subtasks: [{ text: 'Change normalize', state: 'completed' }, { text: 'Run the coupon test', state: 'in_progress' }, { text: '' }, 7] }));
  assert.deepEqual(read().map(step => step.state), ['done', 'doing']);
  // Never a link to another file, and never a file that is no list.
  fs.rmSync(file); fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify([{ text: 'From elsewhere', state: 'done' }])); fs.symlinkSync(path.join(dir, 'other.json'), file);
  assert.equal(read(), null);
  fs.rmSync(file); fs.writeFileSync(file, '"done"'); assert.equal(read(), null);
});

// Lines in the shape each vendor prints them, with made-up content (test/fixtures/live-todos.json).
// Claude Code's are the shapes of 2.1.322: a step shows once Claude Code says it made or changed it.
// seed: the steps an earlier turn of the same vendor session left.
for (const { name, seed, lines } of JSON.parse(fs.readFileSync(new URL('./fixtures/live-todos.json', import.meta.url), 'utf8'))) test(`the model's own to-do list reads as the Task's subtasks, line by line: ${name}`, () => {
  const read = liveTodos(seed);
  lines.forEach(({ row, reads }, index) => assert.deepEqual(read(row), reads, `line ${index + 1}`));
});

test('the steps a reader keeps go to the next turn of the session, and a long list leaves out its oldest finished steps first', () => {
  const read = liveTodos(), made = (id, subject) => { read({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `call-${id}`, name: 'TaskCreate', input: { subject, description: 'x' } }] } }); return read({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `call-${id}`, content: `Task #${id} created successfully: ${subject}` }] }, tool_use_result: { task: { id: String(id), subject } } }); };
  const set = (id, status) => { read({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `set-${id}`, name: 'TaskUpdate', input: { taskId: String(id), status } }] } }); return read({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `set-${id}`, content: `Updated task #${id} status` }] }, tool_use_result: { success: true, taskId: String(id), updatedFields: ['status'] } }); };
  made(1, 'First'); made(2, 'Second'); set(1, 'completed');
  assert.deepEqual(read.kept(), [{ id: '1', text: 'First', state: 'done' }, { id: '2', text: 'Second', state: 'todo' }]);
  // The next turn of that session starts from them: Claude Code keeps its list with the session.
  const next = liveTodos(read.kept());
  next({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c', name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' } }] } });
  assert.deepEqual(next({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c', content: 'Updated task #2 status' }] }, tool_use_result: { success: true, taskId: '2', updatedFields: ['status'] } }), [{ id: 's1', text: 'First', state: 'done' }, { id: 's2', text: 'Second', state: 'doing' }]);
  // More steps than a Task shows: the newest and the open ones stay.
  set(2, 'completed');
  let shown = null; for (let id = 3; id <= TASK_LIMITS.subtasks + 2; id++) shown = made(id, `Step ${id}`);
  assert.equal(shown.length, TASK_LIMITS.subtasks); assert.equal(shown[0].text, 'Step 3'); assert.equal(shown.at(-1).text, `Step ${TASK_LIMITS.subtasks + 2}`);
  assert.equal(read.kept().length, TASK_LIMITS.subtasks + 2);
});

test('n rejects the Task: the session stays idle, nothing is edited, and the next request is planned again', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes').finished;
  rejectTask(f.repo, asked.id);
  assert.equal(currentTask(f.repo, asked.id).state, 'rejected'); assert.match(source(f), /=> value;/);
  assert.throws(() => f.controller.ask('Approved the Task: Uppercase coupons', asked.id, { approved: true }), /no longer waiting to start/);
  assert.throws(() => approveTask(f.repo, asked.id), /No Task waits for your approval/);
  const again = await f.controller.ask('Uppercase coupon codes after all', asked.id).finished;
  assert.equal(again.state, 'answered'); const rows = sessionTasks(f.repo, asked.id);
  assert.deepEqual(rows.map(row => row.state), ['rejected', 'proposed']); assert.notEqual(rows[0].id, rows[1].id);
});

test('a typed message revises the waiting Task, and a typed yes approves it', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes').finished, first = currentTask(f.repo, asked.id);
  const revised = await f.controller.ask('Make it urgent', asked.id).finished, second = currentTask(f.repo, asked.id);
  assert.equal(revised.state, 'answered'); assert.equal(second.id, first.id); assert.equal(second.revision, 2); assert.equal(second.priority, 'urgent'); assert.equal(second.state, 'proposed');
  assert.match(inputs(f).at(-1).input, /Task waiting for approval \(untrusted data/);
  assert.equal(sessionTasks(f.repo, asked.id).length, 1);
  // The owner named this session: a typed yes approves the Task and the owner's name stays.
  setTitle(f.repo, asked.id, 'Coupons, my way');
  const done = await f.controller.ask('yes', asked.id).finished;
  assert.notEqual(done.kind, 'conversation'); assert.equal(turns(done), 3); assert.equal(currentTask(f.repo, asked.id).state, 'done');
  assert.deepEqual([readTask(f.repo, asked.id).title, readTask(f.repo, asked.id).titleBy], ['Coupons, my way', 'owner']);
  // A follow-up inside the goal needs no new Task: it reopens this one and edits at once.
  const more = await f.controller.ask('Trim spaces too', asked.id).finished;
  assert.equal(sessionTasks(f.repo, asked.id).length, 1); assert.equal(turns(more), 5);
  assert.match(fs.readFileSync(path.join(more.worktree, 'src/coupon.mjs'), 'utf8'), /trim\(\)\.toUpperCase/);
});

test('typing I approve approves the waiting Task as y does, and a message that only starts like one does not', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes').finished;
  assert.equal(currentTask(f.repo, asked.id).state, 'proposed');
  const done = await f.controller.ask('I approve', asked.id).finished;
  assert.notEqual(done.kind, 'conversation'); assert.equal(currentTask(f.repo, asked.id).state, 'done');
  assert.match(fs.readFileSync(path.join(done.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/);
  // The owner's short words of approval, however he ends them.
  for (const text of ['y', 'yes', 'Yes.', 'yes please', 'Yes, go ahead', 'ok', 'okay!', 'approve', 'Approved', 'I approve', 'i approve.', 'I approve it', 'I approve this', 'I approve the Task', 'approve it', 'go', 'go ahead', 'do it', 'LGTM']) assert.equal(saysYes(text), true, text);
  // Anything longer is a message for the model, which may be a change to the Task.
  for (const text of ['I approve of the idea, but make it urgent', 'approve nothing yet', 'yes but only src', 'I do not approve', 'not approved', 'no', 'Go on with the tests first', '']) assert.equal(saysYes(text), false, text);
});

test('a reply that asks for an edit with no Task is asked once more, then kept as a plain answer', async t => {
  const f = fixture(t, 'no-task');
  const asked = await f.controller.ask('Uppercase coupon codes').finished;
  assert.equal(asked.state, 'answered'); assert.equal(asked.runs.length, 2); assert.match(asked.result.summary, /No Task was read from this reply, so nothing was changed\./);
  assert.match(inputs(f).at(-1).input, /A request that changes files needs a Task first/);
  assert.equal(currentTask(f.repo, asked.id), null); assert.match(source(f), /=> value;/);
});

test('a Task that does not read is asked for again, then left out', async t => {
  const f = fixture(t, 'bad-task');
  const asked = await f.controller.ask('Uppercase coupon codes').finished;
  assert.equal(asked.state, 'answered'); assert.equal(asked.runs.length, 2); assert.match(inputs(f).at(-1).input, /A Task's priority is one of: urgent, high, medium, low\./);
  assert.match(asked.result.summary, /No Task was read/); assert.equal(currentTask(f.repo, asked.id), null);
});

test('a reply that asks the owner something first proposes no Task yet; the Task comes with the answer', async t => {
  const f = fixture(t, 'question');
  const asked = await f.controller.ask('Normalize coupon codes').finished;
  assert.equal(asked.state, 'needs_input'); assert.equal(asked.reply?.question ?? asked.result?.question, 'Which format?'); assert.equal(currentTask(f.repo, asked.id), null);
  const answered = await f.controller.ask('Uppercase', asked.id).finished;
  assert.equal(answered.state, 'answered'); assert.equal(currentTask(f.repo, asked.id).state, 'proposed'); assert.match(source(f), /=> value;/);
});

test('an edit never starts without an approved Task, whatever the session record says', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes').finished;
  // Approval is the owner's alone: not a schedule's, not a teammate's, not a new session's.
  assert.throws(() => f.controller.ask('go', asked.id, { approved: true, timed: true }), /Only the owner approves a Task/);
  assert.throws(() => f.controller.ask('go', null, { approved: true }), /Only the owner approves a Task/);
  assert.throws(() => f.controller.ask('go', asked.id, { approved: true }), /no longer waiting to start/);
  assert.equal(currentTask(f.repo, asked.id).state, 'proposed'); assert.match(source(f), /=> value;/);
});

test('a question gets a plain answer and no Task', async t => {
  const f = fixture(t, 'answer');
  const asked = await f.controller.ask('How do coupons work?').finished;
  assert.equal(asked.state, 'answered'); assert.equal(currentTask(f.repo, asked.id), null); assert.equal(f.controller.snapshot().tasks[0].plan, undefined);
});

test('a run a schedule starts records its Task as started by schedule and goes on without waiting', async t => {
  const f = fixture(t);
  const done = await f.controller.ask('Uppercase coupon codes', null, { timed: true }).finished;
  assert.notEqual(done.kind, 'conversation'); assert.match(fs.readFileSync(path.join(done.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/);
  const task = sessionTasks(f.repo, done.id)[0];
  assert.equal(task.startedBy, 'schedule'); assert.equal(task.edit, null); assert.ok(task.approvedAt); assert.equal(task.state, 'done');
  assert.deepEqual([readTask(f.repo, done.id).title, readTask(f.repo, done.id).titleBy], ['Uppercase coupons', 'task']);
  assert.match(inputs(f)[0].input, /A schedule started this turn and nobody is there to approve/);
});

test('a Task is checked as untrusted text', () => {
  assert.deepEqual(checkProposal({ ...TASK, title: '  Uppercase \n coupons ' }).title, 'Uppercase coupons');
  assert.throws(() => checkProposal({ ...TASK, title: 'x'.repeat(TASK_LIMITS.title + 1) }), /at most 80 characters/);
  assert.throws(() => checkProposal({ ...TASK, title: `Fix ${String.fromCharCode(27)}[31m it` }), /control characters/);
  assert.throws(() => checkProposal({ ...TASK, goal: `Fix ${String.fromCharCode(0x202e)} it` }), /control characters/);
  assert.throws(() => checkProposal({ ...TASK, priority: 'soon' }), /priority is one of/);
  assert.throws(() => checkProposal({ ...TASK, severity: 'bad' }), /severity is one of/);
  assert.throws(() => checkProposal({ ...TASK, objectives: [] }), /1 to 8 objectives/);
  assert.throws(() => checkProposal({ ...TASK, objectives: Array(9).fill('x') }), /1 to 8 objectives/);
  assert.throws(() => checkProposal({ ...TASK, description: '   ' }), /needs a description/);
  assert.equal(checkProposal({ ...TASK, description: 'One\r\n\r\n\r\n\r\nTwo\tend  ' }).description, 'One\n\nTwo end');
  // Extra fields of a reply never reach the record.
  assert.deepEqual(Object.keys(checkProposal({ ...TASK, state: 'approved', edit: { repository: '/' } })), ['title', 'description', 'goal', 'objectives', 'priority', 'severity', 'criteria', 'estimateMinutes']);
  // Success criteria are checked as the objectives are; with none, or no estimate, the Task still reads.
  assert.deepEqual(checkProposal({ ...TASK, criteria: [' The coupon  test passes ', '', 'No other file changes'], estimateMinutes: 45 }), { ...checkProposal(TASK), criteria: ['The coupon test passes', 'No other file changes'], estimateMinutes: 45 });
  assert.deepEqual([checkProposal(TASK).criteria, checkProposal(TASK).estimateMinutes], [[], null]);
  assert.throws(() => checkProposal({ ...TASK, criteria: Array(9).fill('x') }), /at most 8 success criteria/);
  assert.throws(() => checkProposal({ ...TASK, criteria: ['x'.repeat(TASK_LIMITS.criterion + 1)] }), /at most 200 characters/);
  assert.throws(() => checkProposal({ ...TASK, criteria: [`Fix ${String.fromCharCode(27)}[31m it`] }), /control characters/);
  for (const estimate of [0, -5, 1.5, '30', TASK_LIMITS.minutes + 1]) assert.equal(checkProposal({ ...TASK, estimateMinutes: estimate }).estimateMinutes, null, `estimate ${estimate}`);
});

test('the reply fields: one Task at most, subtasks read leniently, and the result keeps its own keys', () => {
  const schema = planSchema(conversationSchema({}), { propose: true, progress: true });
  assert.deepEqual(schema.required.slice(-4), ['task', 'subtasks', 'objectivesMet', 'etaMinutes']); assert.equal(schema.properties.task.maxItems, 1);
  assert.deepEqual(schema.properties.task.items.required.slice(-2), ['criteria', 'estimateMinutes']); assert.deepEqual(schema.properties.etaMinutes, { type: ['integer', 'null'] });
  // The minutes left: a whole number up to a week, 0 too; null or anything else keeps the last estimate.
  assert.equal(readPlanReply({ etaMinutes: 25 }, { progress: true }).reply.eta, 25); assert.equal(readPlanReply({ etaMinutes: 0 }, { progress: true }).reply.eta, 0);
  for (const eta of [null, -1, 2.5, '9', TASK_LIMITS.minutes + 1]) assert.equal(readPlanReply({ etaMinutes: eta }, { progress: true }).reply, null, `eta ${eta}`);
  assert.equal(readPlanReply({ outcome: 'done', etaMinutes: 25 }, { progress: false }).rest.etaMinutes, undefined);
  assert.equal(conversationSchema({}).properties.task, undefined);
  const read = readPlanReply({ outcome: 'done', task: [TASK], subtasks: [{ text: ' a  b ', state: 'doing' }, { text: '', state: 'done' }, { text: 'c', state: 'odd' }, 'no'], objectivesMet: [2, 2, 0, 9, 'x', 1] }, { propose: true, progress: true });
  assert.deepEqual(read.rest, { outcome: 'done' }); assert.equal(read.reply.proposal.title, 'Uppercase coupons');
  assert.deepEqual(read.reply.subtasks, [{ id: 's1', text: 'a b', state: 'doing' }, { id: 's2', text: 'c', state: 'todo' }]); assert.deepEqual(read.reply.met, [1, 2]);
  assert.throws(() => readPlanReply({ task: [TASK, TASK] }, { propose: true }), /one Task at most/);
  assert.deepEqual(readPlanReply({ task: [{ ...TASK, priority: 'soon' }] }, { propose: true, strict: false }).reply, { unread: true });
  // A turn that may not propose never does, and an empty list is no Task.
  assert.equal(readPlanReply({ task: [TASK] }, { propose: false }).reply, null); assert.equal(readPlanReply({ task: [] }, { propose: true }).reply, null);
});

test('subtasks change freely after approval; the goal and the objectives cannot be changed by a report', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes').finished;
  assert.equal(reportProgress(f.repo, asked.id, { subtasks: [{ id: 's1', text: 'early', state: 'done' }] }), null);
  approveTask(f.repo, asked.id);
  const moved = reportProgress(f.repo, asked.id, { subtasks: [{ id: 's1', text: 'one', state: 'doing' }], met: [1, 7], goal: 'Another goal', objectives: ['x'], title: 'Other' });
  assert.deepEqual(moved.subtasks, [{ id: 's1', text: 'one', state: 'doing' }]); assert.deepEqual(moved.met, [1]);
  assert.equal(moved.goal, 'Coupon codes compare equal whatever their case.'); assert.equal(moved.objectives.length, 2); assert.equal(moved.title, 'Uppercase coupons');
  // What a reader for someone else gets has no edit.
  const shared = sharedTask(currentTask(f.repo, asked.id));
  assert.equal(shared.edit, undefined); assert.equal(shared.title, 'Uppercase coupons'); assert.doesNotMatch(JSON.stringify(shared), /request|repository/);
  // The file sits beside the session record, private.
  const file = path.join(taskDir(f.repo, asked.id), 'plan.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
});

test('the card and the list row say what waits, and markup in a Task shows as typed', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes').finished, plan = currentTask(f.repo, asked.id);
  const card = taskCard(plan, { width: 60, colour: false });
  assert.match(card, /^Task · waits for your approval\nUppercase coupons\nmedium priority · low severity\nETA not set\n/);
  assert.match(card, /Goal: Coupon codes compare equal whatever their case\.\nObjectives\n  1\. normalize returns the code in upper case\n  2\. The coupon test passes\nSuccess criteria · not set\ny approve · n reject, then Enter · or type what to change$/);
  assert.match(taskCard(plan, { width: 60, colour: false, approval: true }), /y and n answer the approval below first/);
  assert.match(taskCard({ ...plan, revision: 3 }, { width: 60, colour: false }), /^Task · waits for your approval · revision 3\n/);
  const working = { ...plan, state: 'approved', subtasks: [{ id: 's1', text: 'Change normalize', state: 'done' }, { id: 's2', text: 'Run the test', state: 'doing' }, { id: 's3', text: 'Tidy', state: 'todo' }], met: [1] };
  assert.equal(taskState(working), 'approved · 1 of 3 subtasks done');
  assert.match(taskCard(working, { width: 60, colour: false }), /  ✓ 1\. normalize returns the code in upper case\n  · 2\. The coupon test passes\nSuccess criteria · not set\nSubtasks\n  \[x\] Change normalize\n  \[~\] Run the test\n  \[ \] Tidy$/);
  assert.equal(taskState({ ...working, state: 'done', met: [1, 2] }), 'done · 2 of 2 objectives reported met');
  assert.doesNotMatch(drawCard({ ...plan, title: '{red-fg}Loud{/red-fg}' }, { width: 60, colour: true }), /\{red-fg\}Loud/);
  const project = { ...f.controller.snapshot(), root: f.root, name: 'sample app' };
  const row = boardRows([project], Date.now(), { approvals: [] }).find(value => value.kind === 'task');
  assert.equal(row.group, 0); assert.equal(row.now, 'Task to approve: Uppercase coupons'); assert.equal(rowBadge(row).title, 'Task to approve');
});

test('a Task comes with its success criteria and an estimate; the ETA counts from approval and follows the minutes left the work reports', async t => {
  const f = fixture(t), fake = path.join(f.parent, 'bin', 'fake.json'), set = values => fs.writeFileSync(fake, JSON.stringify({ ...JSON.parse(fs.readFileSync(fake, 'utf8')), ...values }));
  set({ task: { ...TASK, criteria: ['The coupon test passes', 'Only src/coupon.mjs changes'], estimateMinutes: 40 }, etaMinutes: 12 });
  const asked = await f.controller.ask('Uppercase coupon codes').finished, waiting = currentTask(f.repo, asked.id);
  // Stored with the Task, and told to the turns that work on it.
  assert.deepEqual([waiting.criteria, waiting.estimateMinutes], [['The coupon test passes', 'Only src/coupon.mjs changes'], 40]);
  assert.equal(taskEta(waiting), Date.parse(waiting.proposedAt) + 40 * 60000, 'before approval it counts from the proposal');
  assert.match(taskCard(waiting, { width: 80, colour: false }), /ETA .* · in 40 min\n/);
  assert.match(taskCard(waiting, { width: 80, colour: false }), /Objectives\n.*\n.*\nSuccess criteria\n  · The coupon test passes\n  · Only src\/coupon\.mjs changes\n/);
  const approved = approveTask(f.repo, asked.id);
  assert.equal(taskEta(approved), Date.parse(approved.approvedAt) + 40 * 60000, 'from approval on');
  const done = await f.controller.ask('Approved the Task: Uppercase coupons', asked.id, { approved: true }).finished;
  const work = inputs(f).find(row => row.input.includes('this turn does its work')).input;
  assert.match(work, /"criteria":\["The coupon test passes","Only src\/coupon\.mjs changes"\]/); assert.match(work, /"estimateMinutes":40/); assert.match(work, /In etaMinutes give the minutes of work you think are left/);
  // The working turn said 12 minutes are left: the ETA is 12 minutes from when it said so.
  const after = currentTask(f.repo, done.id ?? asked.id);
  assert.equal(after.etaMinutes, 12); assert.ok(Number.isFinite(Date.parse(after.etaAt)));
  assert.equal(taskEta(after), Date.parse(after.etaAt) + 12 * 60000);
  // Done reads as when it was done; the shared Task carries all of it.
  assert.equal(after.state, 'done'); assert.equal(etaText(after), `done ${clockTime(Date.parse(after.doneAt))}`);
  assert.deepEqual((({ criteria, estimateMinutes, etaMinutes, etaAt }) => ({ criteria, estimateMinutes, etaMinutes, etaAt }))(sharedTask(after)), { criteria: after.criteria, estimateMinutes: 40, etaMinutes: 12, etaAt: after.etaAt });
  // A report while the Task is open moves it again.
  const open = { ...after, state: 'approved' }, now = Date.parse(after.etaAt);
  assert.equal(etaText({ ...open, etaAt: new Date(now).toISOString(), etaMinutes: 25 }, now), `${clockTime(now + 25 * 60000, now)} · in 25 min`);
  assert.equal(etaText({ ...open, etaAt: new Date(now - 40 * 60000).toISOString(), etaMinutes: 30 }, now), `${clockTime(now - 10 * 60000, now)} · overdue by 10 min`);
  assert.equal(etaText({ ...open, etaAt: new Date(now).toISOString(), etaMinutes: 150 }, now), `${clockTime(now + 150 * 60000, now)} · in 2 h 30 min`);
});

test('a Task saved before success criteria and estimates loads unchanged and reads as not set', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes').finished, file = planFile(f.repo, asked.id);
  // The file as an older build wrote it: no criteria, no estimate, no revision of the minutes left.
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')), old = saved.tasks[0];
  for (const key of ['criteria', 'estimateMinutes', 'etaMinutes', 'etaAt']) delete old[key];
  fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
  const read = currentTask(f.repo, asked.id);
  assert.deepEqual(read, old, 'loaded as it was written');
  assert.equal(taskEta(read), null); assert.equal(etaText(read), 'not set');
  const card = taskCard(read, { width: 80, colour: false });
  assert.match(card, /\nETA not set\n/); assert.match(card, /\nSuccess criteria · not set\n/);
  assert.deepEqual((({ criteria, estimateMinutes, etaMinutes, etaAt }) => ({ criteria, estimateMinutes, etaMinutes, etaAt }))(sharedTask(read)), { criteria: [], estimateMinutes: null, etaMinutes: null, etaAt: null });
  // Approved, it still has no estimate; a report of the minutes left gives it an ETA.
  approveTask(f.repo, asked.id);
  const moved = reportProgress(f.repo, asked.id, { eta: 20 });
  assert.equal(moved.etaMinutes, 20); assert.equal(taskEta(moved), Date.parse(moved.etaAt) + 20 * 60000);
  assert.equal(reportProgress(f.repo, asked.id, {}), null, 'nothing to report changes nothing');
});

// Full access and Approve for me approve the Task for the owner (approvesTasks): it is written
// and shown, nobody waits, and the agent is never told that somebody must approve.
for (const [mode, name] of [['full', 'Full access'], ['auto', 'Approve for me']]) {
  test(`${name}: a request for a code change writes its Task and does the work, and nobody approves`, async t => {
    const f = fixture(t, 'normal', 'claude', { tells: true });
    const done = await f.controller.ask('Uppercase coupon codes', null, { permissions: mode }).finished;
    // One message of the owner's, one planning turn, one working turn: no key and no typed approval.
    assert.notEqual(done.kind, 'conversation'); assert.equal(turns(done), 2);
    assert.deepEqual(done.messages.filter(row => !row.from && !row.to && !row.quiet).map(row => row.text), ['Uppercase coupon codes']);
    assert.match(fs.readFileSync(path.join(done.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/); assert.match(source(f), /=> value;/);
    // The Task is on record as any other, approved by the mode, and done.
    const task = currentTask(f.repo, done.id);
    assert.deepEqual([task.title, task.state, task.approvedBy, task.startedBy, task.by, task.edit], ['Uppercase coupons', 'done', mode, 'owner', 'lead', null]); assert.ok(task.approvedAt); assert.deepEqual(task.met, [1, 2]);
    assert.deepEqual([readTask(f.repo, done.id).title, readTask(f.repo, done.id).titleBy], ['Uppercase coupons', 'task']);
    assert.equal(sharedTask(task).approvedBy, mode); assert.equal(sharedTask(task).edit, undefined);
    assert.match(taskCard({ ...task, state: 'approved' }, { width: 70, colour: false }), new RegExp(`medium priority · low severity · approved by ${name}\n`));
    // The planning turn was told the mode approves, never that the owner must, and it answered so.
    const [first] = inputs(f), told = first.input;
    assert.match(told, new RegExp(`This session runs with ${name}, which approves the Task: it is recorded as approved by ${name}, nobody has to approve it, and the work goes on at once\\.`));
    assert.match(told, /Never tell the owner that a Task waits for approval and never ask them to approve one\./);
    assert.doesNotMatch(told, /Plan first|change nothing in this turn|only after they approve|waits for the owner's approval/);
    const work = inputs(f).find(row => row.input.includes('this turn does its work')).input;
    assert.match(work, new RegExp(`This session's ${name} approved the Task below, and this turn does its work`)); assert.doesNotMatch(work, /The owner approved the Task below/);
    // That turn keeps the model's own to-do list, which the Task's subtasks follow while it runs.
    const launch = inputs(f).find(row => row.input.includes('this turn does its work')).args, tools = launch[launch.indexOf('--tools') + 1];
    assert.match(work, /Keep the Task's subtasks in your task list as you work: make each step with TaskCreate/);
    if (mode === 'full') assert.equal(tools, 'default'); else assert.match(tools, /,TaskCreate,TaskUpdate,TaskList,TaskGet,TodoWrite$/);
  });
}

test('Ask for approval keeps the approval: the Task waits, and a plainly typed yes in any words starts it', async t => {
  const f = fixture(t, 'normal', 'claude', { tells: true });
  const asked = await f.controller.ask('Uppercase coupon codes', null, { permissions: 'ask' }).finished;
  assert.equal(asked.state, 'answered'); assert.equal(currentTask(f.repo, asked.id).state, 'proposed'); assert.match(source(f), /=> value;/);
  assert.match(asked.result.summary, /One Task is below for your approval\./);
  // The agent is told that the owner's own words approve, as the key does.
  assert.match(inputs(f)[0].input, /The owner approves or rejects the Task, with a key or by saying so in a message, and the work starts only after they approve\./);
  // A few words that all say go need no model turn: the work starts at once.
  const done = await f.controller.ask('yes go ahead', asked.id).finished;
  assert.notEqual(done.kind, 'conversation'); assert.equal(turns(done), 2); assert.equal(currentTask(f.repo, asked.id).state, 'done');
  assert.equal(currentTask(f.repo, asked.id).approvedBy, undefined, 'the owner approved it, not the mode');
  assert.match(fs.readFileSync(path.join(done.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/);
  assert.match(inputs(f).find(row => row.input.includes('this turn does its work')).input, /The owner approved the Task below, and this turn does its work/);
});

test('an approval typed in other words is read by the turn that answers it, and the work starts after that reply', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes', null, { permissions: 'ask' }).finished;
  // A question about the Task approves nothing: the turn is offered approved and leaves it false.
  const still = await f.controller.ask('Is the coupon test part of this, and would you go ahead without it?', asked.id).finished;
  assert.equal(still.state, 'answered'); assert.equal(currentTask(f.repo, asked.id).state, 'proposed'); assert.match(source(f), /=> value;/);
  const offered = inputs(f).at(-1);
  assert.match(offered.input, /A plain approval in their message counts, in any words \(yes go ahead, sounds good, do it\): then set approved to true and leave task empty/);
  assert.equal(JSON.parse(offered.args[offered.args.indexOf('--json-schema') + 1]).properties.approved.type, 'boolean');
  // His words approve it. They are no short yes, so the model reads them and says so; the editing turn follows with no key.
  const text = 'That plan is what I wanted, so go ahead and keep the test as it is';
  assert.equal(saysYes(text), false);
  const done = await f.controller.ask(text, asked.id).finished;
  assert.notEqual(done.kind, 'conversation'); assert.equal(turns(done), 4); assert.equal(currentTask(f.repo, asked.id).state, 'done'); assert.equal(currentTask(f.repo, asked.id).edit.started, true);
  assert.match(fs.readFileSync(path.join(done.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/);
  assert.equal(done.messages.filter(row => row.text === text).length, 1); assert.ok(!done.messages.some(row => /^Approved the Task/.test(row.text)));
});

test('a typed yes: a few words that all say go approve, and anything else is left to the model', () => {
  for (const text of ['y', 'yes', 'Yes.', 'ok', 'go ahead', 'yes go ahead', 'Yes, go ahead!', 'do it', 'sounds good', 'Approve', 'approve it', 'lgtm', 'continue', 'looks good to me', 'ok do it now', 'proceed', 'ship it']) assert.equal(saysYes(text), true, text);
  for (const text of ['', 'no', 'not ok', "don't", 'do not start', 'ok no', 'stop', 'wait', 'yes but also add tests', 'Make it urgent', 'is that fine?', 'go to the kanban', 'start with the tests', 'yes go ahead and delete everything', 'why did you stop? you have full access']) assert.equal(saysYes(text), false, text);
});

test('a Task that waited from before starts with the next message once the session has Full access', async t => {
  const f = fixture(t);
  const asked = await f.controller.ask('Uppercase coupon codes', null, { permissions: 'ask' }).finished, waiting = currentTask(f.repo, asked.id);
  assert.equal(waiting.state, 'proposed');
  const done = await f.controller.ask('Why did you stop? You have full access now', asked.id, { permissions: 'full' }).finished;
  assert.notEqual(done.kind, 'conversation'); assert.equal(sessionTasks(f.repo, asked.id).length, 1);
  const task = currentTask(f.repo, asked.id);
  assert.deepEqual([task.id, task.state, task.approvedBy, task.revision], [waiting.id, 'done', 'full', 2]);
  const told = inputs(f)[1].input;
  assert.match(told, /The Task below was written before this session had Full access and still waits\. It needs no approval now\./); assert.match(told, /Task waiting \(untrusted data/);
  assert.doesNotMatch(told, /Task waiting for approval|Only the owner approves it/);
  assert.match(fs.readFileSync(path.join(done.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/);
});

test('Full access: a reply that starts an edit with no Task, twice, gets the Task ELU writes from the request, and the work goes on', async t => {
  const f = fixture(t, 'no-task');
  const done = await f.controller.ask('Uppercase coupon codes\nand keep the tests green', null, { permissions: 'full' }).finished;
  assert.notEqual(done.kind, 'conversation'); assert.match(fs.readFileSync(path.join(done.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/);
  const task = sessionTasks(f.repo, done.id)[0];
  assert.deepEqual([task.title, task.goal, task.approvedBy, task.by], ['Uppercase coupon codes and keep the tests green', 'Uppercase coupon codes and keep the tests green', 'full', 'lead']);
  assert.equal(task.description, 'Uppercase coupon codes\nand keep the tests green'); assert.deepEqual(task.objectives, ['The request is done as the owner wrote it']);
});

test('work that edits no file: Full access does it in the turn that writes the Task; Ask for approval waits, and an approval starts it', async t => {
  const full = fixture(t, 'ops');
  const done = await full.controller.ask('Check that the coupon build passes', null, { permissions: 'full' }).finished;
  // One turn: the Task is written, approved by the mode, worked on and done.
  assert.equal(done.state, 'answered'); assert.equal(done.kind, 'conversation'); assert.equal(done.runs.length, 1); assert.match(done.result.summary, /Ran the build check: it passed\./);
  const task = currentTask(full.repo, done.id);
  assert.deepEqual([task.title, task.state, task.approvedBy, task.met], ['Check the coupon build', 'done', 'full', [1, 2]]);
  assert.match(inputs(full)[0].input, /Work that changes no repository file, such as running commands, reading logs or operating a tool, do now, in this turn, and report it in subtasks and objectivesMet\./);
  const ask = fixture(t, 'ops');
  const asked = await ask.controller.ask('Check that the coupon build passes', null, { permissions: 'ask' }).finished;
  assert.equal(asked.state, 'answered'); assert.equal(currentTask(ask.repo, asked.id).state, 'proposed'); assert.match(asked.result.summary, /One Task is below for your approval\./);
  const after = await ask.controller.ask('The plan is right, so go ahead with the check', asked.id).finished;
  assert.equal(after.state, 'answered'); assert.equal(after.runs.length, 3); assert.equal(currentTask(ask.repo, asked.id).state, 'done'); assert.match(after.result.summary, /Ran the build check: it passed\./);
  assert.ok(after.messages.some(row => row.text === 'Approved the Task: Check the coupon build'));
});

test("a schedule's turn and a handoff take the session's mode as the owner's own turn does; a teammate's question has none", t => {
  const dir = temp(t);
  assert.equal(approvesTasks('full'), true); assert.equal(approvesTasks('auto'), true); assert.equal(approvesTasks('ask'), false); assert.equal(approvesTasks('locked'), false); assert.equal(approvesTasks(null), false);
  const repo = { root: dir, common: path.join(dir, '.git') };
  // The runner gives a teammate's question no mode (mode: null): nothing approves for it.
  assert.equal(turnPlan(repo, '1', { mode: null, owner: false }).approves, null);
  // Approve for me and Full access approve whoever started the turn; Ask for approval keeps the rule each has.
  for (const unattended of [false, 'schedule', 'handoff']) {
    for (const mode of ['full', 'auto']) assert.equal(turnPlan(repo, '1', { mode, unattended }).approves, mode, `${mode} ${unattended}`);
    assert.equal(turnPlan(repo, '1', { mode: 'ask', unattended }).approves, null);
  }
  assert.equal(turnPlan(repo, '1', { mode: 'full', owner: true }).approves, 'full'); assert.equal(turnPlan(repo, '1', { mode: 'full', owner: true }).mayApprove, false);
});

// The owner's every-3-hours jobs run scripts, record verdicts and report: they change no file.
// A schedule he saved with Full access or Approve for me does such a job in its run, as his own
// turn in that mode does, and never says that a Task waits for his approval.
for (const [mode, name] of [['full', 'Full access'], ['auto', 'Approve for me']]) {
  test(`a schedule saved with ${name} does a job that changes no file in its run, and its Task is approved by ${name}`, async t => {
    const f = fixture(t, 'ops', 'claude', { tells: true });
    const done = await f.controller.ask('Review the session backlog and report what is left', null, { timed: true, permissions: mode }).finished;
    assert.equal(done.state, 'answered'); assert.equal(done.runs.length, 1); assert.match(done.result.summary, /Ran the build check: it passed\./);
    assert.doesNotMatch(done.result.summary, /for your approval/);
    const task = currentTask(f.repo, done.id);
    assert.deepEqual([task.title, task.state, task.approvedBy, task.startedBy, task.met], ['Check the coupon build', 'done', mode, 'schedule', [1, 2]]);
    const told = inputs(f)[0].input;
    assert.match(told, new RegExp(`This session runs with ${name}, which approves the Task: it is recorded as approved by ${name}, nobody has to approve it, and the work goes on at once\\.`));
    assert.match(told, /Work that changes no repository file, such as running commands, reading logs or operating a tool, do now, in this turn/);
    assert.doesNotMatch(told, /Plan first|change nothing in this turn|only after they approve/);
    // Its card says both: a schedule started it, and the mode approved it.
    assert.match(taskCard(task, { width: 100, colour: false }), new RegExp(` severity · started by schedule · approved by ${name}\n`));
  });
}

test('a schedule saved with Full access makes its edit with the Task approved by Full access, and one in Ask for approval keeps the rule it had', async t => {
  const f = fixture(t, 'normal', 'claude', { tells: true });
  const done = await f.controller.ask('Uppercase coupon codes', null, { timed: true, permissions: 'full' }).finished;
  assert.notEqual(done.kind, 'conversation'); assert.match(fs.readFileSync(path.join(done.worktree, 'src/coupon.mjs'), 'utf8'), /toUpperCase/);
  const task = currentTask(f.repo, done.id);
  assert.deepEqual([task.state, task.approvedBy, task.startedBy, task.edit], ['done', 'full', 'schedule', null]);
  assert.match(inputs(f)[0].input, /nobody has to approve it/); assert.doesNotMatch(inputs(f)[0].input, /Plan first/);
  assert.match(inputs(f).find(row => row.input.includes('this turn does its work')).input, /This session's Full access approved the Task below, and this turn does its work/);
  // Ask for approval: the run plans first, its Task is recorded as started by schedule and approved, and the job that changes no file is only written.
  const ask = fixture(t, 'ops');
  const asked = await ask.controller.ask('Review the session backlog and report what is left', null, { timed: true, permissions: 'ask' }).finished;
  const kept = currentTask(ask.repo, asked.id);
  assert.deepEqual([kept.state, kept.approvedBy, kept.startedBy, kept.met], ['approved', undefined, 'schedule', []]);
  assert.match(inputs(ask)[0].input, /Plan first\.[^]*A schedule started this turn and nobody is there to approve: the Task is recorded as started by schedule and the work goes on\./);
  assert.match(taskCard(kept, { width: 70, colour: false }), /started by schedule\n/);
});

test("a bot's own scheduled turn in a Full access session does a job that changes no file in that turn", async t => {
  const f = fixture(t, 'answer', 'claude', { home: true });
  saveBot({ name: 'nightly', vendor: 'claude', instructions: 'Review the session backlog and report what is left.', schedule: 'every 3h' });
  const chat = await f.controller.ask('Keep the backlog reviewed.', null, { bots: ['nightly'], permissions: 'full' }).finished;
  assert.equal(currentTask(f.repo, chat.id), null, 'the owner asked a question: no Task yet');
  // The stand-in now answers as for the job: it changes no file.
  const settings = path.join(f.fake.dir, 'fake.json'); fs.writeFileSync(settings, JSON.stringify({ ...JSON.parse(fs.readFileSync(settings, 'utf8')), mode: 'ops' }));
  const asked = inputs(f).length;
  const run = await f.controller.ask('Do your scheduled work.', chat.id, { bot: 'nightly', scheduled: true }).finished;
  const task = currentTask(f.repo, chat.id);
  assert.deepEqual([task.state, task.approvedBy, task.startedBy, task.by, task.met], ['done', 'full', 'schedule', '@nightly', [1, 2]]);
  assert.ok(run.messages.some(row => row.bot === 'nightly' && /Ran the build check: it passed\./.test(row.text)), JSON.stringify(run.messages));
  const told = inputs(f).slice(asked).find(row => row.input.includes('You are @nightly')).input;
  assert.match(told, /This session runs with Full access, which approves the Task/); assert.doesNotMatch(told, /Plan first/);
});

test('a step that fails is the agent\'s to fix: it goes another way and the work ends done, after an approval and in Full access', async t => {
  for (const mode of ['ask', 'full']) {
    const f = fixture(t, 'normal', 'claude', { failStep: true });
    let done = await f.controller.ask('Uppercase coupon codes', null, { permissions: mode }).finished;
    if (mode === 'ask') done = await f.controller.ask('yes', done.id).finished;
    // The first copy failed on a missing folder; the turn made the folder and copied again.
    assert.notEqual(done.state, 'needs_input', done.result?.question); assert.notEqual(done.kind, 'conversation');
    assert.equal(fs.existsSync(path.join(done.worktree, 'out/coupon.copy.mjs')), true);
    assert.match(done.result.summary, /Made the folder and copied the file\./);
    const work = inputs(f).find(row => row.input.includes('this turn does its work')).input;
    assert.match(work, /A step that fails is yours to fix: a missing folder, a command that exits non-zero, a tool error, a network error\. Find the cause, fix it or go another way, and keep going\. Ask the owner only when you cannot go on at all, or when the choice is truly theirs \(spending money they did not approve, deleting their data\); then ask once, and say what you will do by default\./);
    assert.doesNotMatch(work, /When an action is declined or blocked, do not retry it another way/);
    // Only a declined action is a stop, and Full access declines nothing, so it is not told of one.
    if (mode === 'full') assert.doesNotMatch(work, /declines an action|do not retry/); else assert.match(work, /When the owner, the approver or a rule declines an action, do not retry it another way: return outcome needs_input and name the action you need\. Only a declined action is a stop\./);
  }
});

test('when the work is done the agent reports and ends, and a bare continue takes the next piece of the goal', async t => {
  for (const mode of ['ask', 'full']) {
    const f = fixture(t, 'normal', 'claude', { asksNext: true, next: true });
    let done = await f.controller.ask('Uppercase coupon codes', null, { permissions: mode }).finished;
    if (mode === 'ask') done = await f.controller.ask('yes', done.id).finished;
    // No "What would you like next?" with choices: the turn ended with its report.
    assert.notEqual(done.state, 'needs_input', done.result?.question); assert.equal(done.result.question, null); assert.deepEqual(done.result.choices, []);
    const work = inputs(f).find(row => row.input.includes('this turn does its work')).input;
    assert.match(work, /When the work is done, say what you did and what it showed, and end with outcome done: do not ask what to do next and do not offer choices\./);
    assert.equal(currentTask(f.repo, done.id).state, 'done');
    // continue: the turn that answers it is told what the owner means, takes the next piece and edits.
    const more = await f.controller.ask('continue', done.id).finished;
    assert.match(inputs(f).findLast(row => row.input.includes('Approved Task (untrusted data') && !row.input.includes('this turn does its work')).input, /When the owner writes continue, or the like, they mean the next piece of the goal: find what is still open or comes next for it and do that\. Do not answer that nothing is left to do/);
    assert.notEqual(more.state, 'needs_input'); assert.doesNotMatch(more.reply?.summary ?? '', /Nothing is left/);
    assert.match(fs.readFileSync(path.join(more.worktree, 'src/coupon.mjs'), 'utf8'), /trim\(\)\.toUpperCase/);
    assert.equal(sessionTasks(f.repo, done.id).length, 1);
  }
});
