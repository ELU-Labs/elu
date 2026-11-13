import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp, project, fakeClis, git } from './helpers.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask, setTitle, taskDir } from '../lib/state.mjs';
import { TASK_LIMITS, approveTask, checkProposal, currentTask, fileTodos, liveTodos, planFile, planSchema, readPlanReply, rejectTask, reportProgress, sessionTasks, sharedTask, taskEta } from '../lib/plan.mjs';
import { conversationSchema } from '../lib/config.mjs';
import { boardRows, rowBadge } from '../lib/board.mjs';
import { clockTime, etaText, taskCard as drawCard, taskState } from '../lib/terminal-plan.mjs';
import { visible } from '../lib/terminal-visuals.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
// The card as its text reads on screen, without the style marks.
const taskCard = (plan, options) => visible(drawCard(plan, options));

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// A project with one source file and a passing-after-the-edit test, and the stand-in vendors.
function fixture(t, mode = 'normal', vendor = 'claude', { home = false } = {}) {
  const p = project(t), fake = fakeClis(p.parent, { mode });
  environment(t, { ...fake.env, ...(home ? { HOME: p.parent } : {}), GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = new ProjectController(projectFolder(p.root)); controller.draftConfig.roles.lead.vendor = vendor;
  return { ...p, fake, controller, repo: controller.repo };
}
const inputs = f => fs.readFileSync(path.join(f.parent, 'inputs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const source = f => fs.readFileSync(path.join(f.root, 'src/coupon.mjs'), 'utf8');
// The session's Task once its subtasks read as these states, while a turn runs.
async function shows(f, id, states) {
  let live = null;
  for (const until = Date.now() + 20000; Date.now() < until; await new Promise(resolve => setTimeout(resolve, 50))) { live = currentTask(f.repo, id); if (live.subtasks.map(step => step.state).join() === states) break; }
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
  const asked = await f.controller.ask('Uppercase coupon codes', null, { permissions: mode }).finished;
  approveTask(f.repo, asked.id);
  const finished = f.controller.ask('Approved the Task: Uppercase coupons', asked.id, { approved: true }).finished;
  assert.deepEqual((await shows(f, asked.id, 'done,doing')).subtasks.map(step => step.text), ['Change normalize', 'Run the coupon test']);
  const work = inputs(f).find(row => row.input.includes('this turn does its work'));
  assert.equal(work.args[work.args.indexOf('--permission-mode') + 1], { ask: 'default', auto: 'auto', full: 'bypassPermissions' }[mode]);
  assert.match(work.args[work.args.indexOf('--tools') + 1], /,TaskCreate,TaskUpdate,TaskList,TaskGet,TodoWrite$/);
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
// machine, the turn runs over ACP and sends its list as plan updates. In Full access it runs headless and prints
// its answer only when it ends: there it keeps the list in a file of the run, which is read while it works.
const proven = (vendor, bin, version) => atomic(path.join(personalDirectory(), 'conformance', `${vendor}.json`), { v: 1, bin, version, steps: Object.fromEntries(ADAPTERS[vendor].conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });
for (const [vendor, label, version] of [['agy', 'Antigravity', '1.5.4'], ['grok', 'Grok Build', '1.0.77']]) for (const [mode, how] of [['ask', 'from its plan updates over ACP in Ask for approval'], ['full', 'from the list it keeps in a file, headless in Full access']]) test(`${label}: a working turn ticks the Task's subtasks ${how}, while it runs`, async t => {
  const f = fixture(t, 'normal', vendor, { home: true }), gate = path.join(f.parent, 'go-on'), settings = path.join(f.fake.dir, 'fake.json');
  fs.writeFileSync(settings, JSON.stringify({ ...JSON.parse(fs.readFileSync(settings, 'utf8')), plan: true, live: gate }));
  if (vendor === 'grok') { fs.mkdirSync(path.join(f.parent, '.grok')); fs.writeFileSync(path.join(f.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 }); }
  proven(vendor, path.join(f.fake.dir, vendor), version);
  const calls = () => fs.readFileSync(f.fake.calls, 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.vendor === vendor);
  // The first turn plans: the Task waits for the owner, and no list is asked for yet.
  const asked = await f.controller.ask('Uppercase coupon codes', null, { permissions: mode }).finished;
  assert.equal(currentTask(f.repo, asked.id).state, 'proposed', JSON.stringify(asked.error));
  approveTask(f.repo, asked.id);
  const finished = f.controller.ask('Approved the Task: Uppercase coupons', asked.id, { approved: true }).finished;
  const live = await shows(f, asked.id, 'done,doing');
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
  assert.match(card, /Goal: Coupon codes compare equal whatever their case\.\nObjectives\n  1\. normalize returns the code in upper case\n  2\. The coupon test passes\nSuccess criteria · not set\nEsc, then y approve · n reject, then Enter · or type what to change$/);
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
