import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { project, fakeClis, autoApprove, CLI } from './helpers.mjs';
import { ProjectController, registerProject } from '../lib/projects.mjs';
import { projectFolder, pendingRequests } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';
import { approveTask, currentTask, proposeTask, reportProgress } from '../lib/plan.mjs';
import { answerCheck } from '../lib/owner-check.mjs';
import { conductorRunning } from '../lib/conductor.mjs';
import { addUpdate, artifactRows, checkData, readSharedArtifacts, readStore, sharedArtifacts, storeFile } from '../lib/artifacts.mjs';
import { artifactsView } from '../lib/terminal-artifacts.mjs';
import { chartColumn, chartPicture, chartRow, png } from '../lib/chart-picture.mjs';
import { rowActions, rowArtifacts, rowArtifactsNamed } from '../lib/board.mjs';
import { columns } from '../lib/width.mjs';
import { readPng } from './picture-terminal.mjs';
import fs from 'node:fs';

// The edges of the artifact features an independent check of ELU 0.1.34 found: a new goal that
// is only an Artifact: line, v on a session whose Task has no artifact yet, a chart whose label
// and series names are longer than the tab, the mark of a chart's fourth series, and what
// another computer of the project is sent (one with data that arrived with none, and one on
// ELU 0.1.33 that dropped an update over its own limits). Made-up data only.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const TASK = { title: 'Uppercase coupons', description: 'Make normalize return the code in upper case.', goal: 'Coupon codes compare equal whatever their case.', objectives: ['normalize returns upper case', 'The coupon test passes'], priority: 'medium', severity: 'low', criteria: [], estimateMinutes: null };
// Session 1: a chat that replied, with an approved Task of two objectives, the first one met,
// with its evidence and an ETA. It is idle, so it waits for the owner's check.
async function world(t, { artifacts = [] } = {}) {
  const p = project(t), clis = fakeClis(p.parent, { mode: 'answer' });
  environment(t, { ...clis.env, HOME: p.parent, ELU_NO_UPDATE_CHECK: '1', ELU_SESSION: undefined, ELU_PROJECT: undefined, ELU_COMMAND_FOLDER: undefined, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); registerProject(controller.repo);
  const repo = controller.repo;
  await controller.ask('Look at the coupon code and plan the work.', null, { permissions: 'ask' }).finished;
  proposeTask(repo, '1', { ...TASK, artifacts }); approveTask(repo, '1');
  reportProgress(repo, '1', { met: [1], evidence: [[1, 'normalize returns value.toUpperCase()']], eta: 20 });
  return { ...p, repo, root: repo.root };
}
async function until(check, message, timeout = 30000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 100)); }
}
const plain = row => String(row).replace(/\{\/?[a-z#0-9-]+\}/gi, '');
const shown = (blocks, width) => artifactsView([{ title: 'Eval history', shows: '', every: null, key: 'eval history', updates: [{ at: '2026-11-16T09:40:00.000Z', data: checkData({ blocks }) }], script: null, run: null }], { width, colour: false, now: Date.parse('2026-11-16T10:00:00.000Z') }).map(plain);

// The empty Artifacts tab says: "Say in the chat what to show, or Ctrl+T, New goal, with an
// Artifact: line." On a session that waits for his check the New goal editor opens empty, so the
// owner writes that one line. It answered with a program error ("Cannot destructure property
// 'goal' of 'object null'"), and so did elu sessions goal.
test('a new goal that is only Artifact: lines adds them to what the Task shows, and its marks, evidence and ETA stay', async t => {
  const w = await world(t), session = () => readTask(w.repo, '1');
  const progress = task => [task.revision, task.met, task.evidence, task.etaMinutes, task.etaAt, task.goals, task.goal, task.objectives, task.state];
  const before = currentTask(w.repo, '1'), titles = () => currentTask(w.repo, '1').artifacts.map(row => row.title);
  // From the app: Ctrl+T, Check, Keep open, new goal.
  const line = 'Artifact: Eval history · accuracy by run';
  assert.deepEqual(answerCheck(w.repo, w.root, session(), 'goal', line), { answer: 'goal', task: true, artifacts: true });
  assert.deepEqual(currentTask(w.repo, '1').artifacts, [{ title: 'Eval history', shows: 'accuracy by run', every: null }]);
  assert.deepEqual(progress(currentTask(w.repo, '1')), progress(before), 'nothing of its progress changes');
  // His words go to the session as his message, so its work fills it: never as a new goal.
  assert.deepEqual(pendingRequests(w.root).filter(row => row.continuationTaskId === '1').map(row => [row.goal, row.goalChange]), [[line, undefined]]);
  // One more line is added to the one it has; a line that names one it has changes that one, in its place.
  answerCheck(w.repo, w.root, session(), 'goal', 'Artifact: Latency · median seconds · every 10 min');
  answerCheck(w.repo, w.root, session(), 'goal', 'Artifact: Eval history · accuracy and cost by run');
  assert.deepEqual(currentTask(w.repo, '1').artifacts.map(row => [row.title, row.shows, row.every]), [['Eval history', 'accuracy and cost by run', null], ['Latency', 'median seconds', 10]]);
  // The same line again changes nothing, and says so: no new revision clears its marks.
  assert.throws(() => answerCheck(w.repo, w.root, session(), 'goal', 'Artifact: Latency · median seconds · every 10 min'), { message: 'It shows that already.' });
  assert.deepEqual(progress(currentTask(w.repo, '1')), progress(before));
  // "Artifact: none" alone removes them, as it does under a goal.
  assert.equal(answerCheck(w.repo, w.root, session(), 'goal', 'Artifact: none').artifacts, true);
  assert.deepEqual([titles(), progress(currentTask(w.repo, '1'))], [[], progress(before)]);
  // From elu sessions goal in his shell, the same way. It starts the conductor for what he sent:
  // that one is told to stop once it runs, and is gone before this test's folder is.
  const owner = { ...process.env }; delete owner.ELU_SESSION; delete owner.ELU_PROJECT;
  const cli = spawnSync(process.execPath, [CLI, 'sessions', 'goal', '1', line], { cwd: w.root, env: owner, encoding: 'utf8', timeout: 60000 });
  try {
    assert.doesNotMatch(cli.stdout + cli.stderr, /Cannot destructure|of 'object null'/);
    assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /has the new artifacts; its progress stays\./);
    assert.deepEqual([titles(), currentTask(w.repo, '1').revision], [['Eval history'], before.revision]);
  } finally {
    const stop = () => spawnSync(process.execPath, [CLI, 'conductor', 'stop'], { cwd: w.root, env: owner, encoding: 'utf8', timeout: 30000 }).stdout;
    if (cli.status === 0) { await until(() => /stops its runs/.test(stop()), 'the conductor to run'); await until(() => !conductorRunning(), 'the conductor to stop'); }
  }
});

// The tab is on every session with a Task; its key was only on one whose Task had an artifact,
// and the key bar said "v is no key on this row" beside the tab. In the app: test/terminal.test.mjs,
// "a session whose Task has no artifact yet has an Artifacts tab that says how to add one".
test('v shows the Artifacts tab from the row of every session with a Task, and the row names it once the Task has an artifact', () => {
  const row = plan => ({ kind: 'task', group: 3, task: { id: '1', state: 'answered', plan } });
  const task = artifacts => ({ state: 'approved', goal: 'g', objectives: ['o'], artifacts });
  const some = row(task([{ title: 'Eval history', shows: '', every: null }])), none = row(task([]));
  assert.equal(rowArtifacts(some), true); assert.equal(rowArtifactsNamed(some), true); assert.deepEqual(rowActions(some).slice(0, 2), [['enter', 'open'], ['v', 'artifacts']]);
  assert.equal(rowArtifacts(none), true, 'with none yet'); assert.equal(rowArtifactsNamed(none), false); assert.ok(!rowActions(none).some(([key]) => key === 'v'), 'its row names the keys it named');
  // A session with no Task has no tab, and no key for it; nor has one whose Task he rejected, or an archived one.
  assert.equal(rowArtifacts(row(null)), false); assert.equal(rowArtifacts(row({ ...task([]), state: 'rejected' })), false); assert.equal(rowArtifacts({ ...some, archived: true }), false);
  assert.ok(!rowActions({ ...some, archived: true }).some(([key]) => key === 'v'));
});

// Nothing limits how long a label is, so one longer than the tab has to fit it: the rows were
// cut at the tab's edge, and a legend lost its series' newest value and its change.
test('a chart with a long label and long series names draws no row wider than the tab, and its legend keeps each value and change', () => {
  const label = 'A chart whose label is long enough to pass the width of a narrow tab more than once, as a model may well write one';
  const chart = { kind: 'chart', label, unit: '%', x: ['the first run', 'the second run'], series: [{ label: 'Accuracy on the whole held-out set with every case counted once and none left out', values: [78, 84] }, { label: 'Success rate on the same set, counted the strict way, with retries counted as failures', values: [40, 44] }] };
  for (const width of [44, 92]) {
    const rows = shown([chart], width), text = rows.join('\n');
    assert.deepEqual(rows.filter(row => columns(row) > width), [], `no row is wider than ${width} columns`);
    // The label is whole, over as many rows as it needs.
    assert.ok(text.replace(/\s+/g, ' ').includes(label), 'the whole label');
    // A series' name that does not fit is cut, and its newest value and its change since the first still show.
    assert.match(text, width < 92 ? /^● Accuracy on the whole .*… 84% ▲ 6$/m : /^● Accuracy on the whole .* none left out 84% ▲ 6$/m); assert.match(text, /^■ Success rate on the .*… 44% ▲ 4$/m);
  }
  // One that fits is drawn as before.
  assert.match(shown([{ ...chart, label: 'By run', series: [{ label: 'Accuracy', values: [78, 84] }] }], 44).join('\n'), /^By run\n[^]*^● Accuracy 84% ▲ 6$/m);
});
test('a long label of a note, bars, a trend or a table takes the rows it needs, and none is wider than the tab', () => {
  const label = 'A label that says at length what these numbers are, where they came from and which run they are of';
  const blocks = [{ kind: 'note', label, text: 'Last run Nov 5.' }, { kind: 'bars', label, unit: '%', target: 85, rows: [{ label: 'Chat', value: 91 }] }, { kind: 'trend', label, unit: '%', target: 85, value: 84 }, { kind: 'table', label, columns: ['Surface', 'Median'], rows: [['Chat', 14.2]] }];
  for (const width of [44, 92]) for (const block of blocks) {
    const rows = shown([block], width), text = rows.join('\n').replace(/\s+/g, ' ');
    assert.deepEqual(rows.filter(row => columns(row) > width), [], `${block.kind} at ${width} columns`);
    assert.ok(text.includes(label), `the whole label of the ${block.kind}`);
    if (block.target) assert.ok(text.includes('target ≥ 85%'), `the target of the ${block.kind}`);
  }
  // The app draws a note's text as Markdown (noteRows): its label is above it, in rows that fit too.
  const item = { title: 'Eval history', shows: '', every: null, key: 'eval history', updates: [{ at: '2026-11-16T09:40:00.000Z', data: checkData({ blocks: [blocks[0]] }) }], script: null, run: null };
  const app = artifactsView([item], { width: 44, colour: false, now: Date.parse('2026-11-16T10:00:00.000Z'), noteRows: () => ['Last run **Nov 5**.'] }).map(plain);
  assert.deepEqual(app.filter(row => columns(row) > 44), []); assert.ok(app.join(' ').replace(/\s+/g, ' ').endsWith(`${label} Last run **Nov 5**.`), app.join('\n'));
  // A label that fits stays on one row with its target.
  assert.ok(shown([{ ...blocks[1], label: 'By surface' }], 44).includes('By surface · target ≥ 85%'));
});

// The fourth series' mark was ▲, the sign the legend uses for "went up": "▲ Refused 13.5% ▲ 1.5".
test('no series of a chart has the mark the legend uses for a rise or a fall, in text or in a picture', () => {
  const names = ['Accuracy', 'Success rate', 'Grounded', 'Refused', 'Slow', 'Wrong', 'Empty', 'Late'];
  const chart = { kind: 'chart', label: 'By run', unit: '%', x: ['Nov 1', 'Nov 2'], series: names.map((label, index) => ({ label, values: [10 + index * 10, 12 + index * 10] })) };
  const legend = shown([chart], 120).filter(row => names.some(name => row.includes(` ${name} `))).join('   ');
  const marks = names.map(name => new RegExp(`(\\S) ${name} `).exec(legend)?.[1]);
  assert.equal(new Set(marks).size, 8, `eight series, eight marks: ${marks.join(' ')}`);
  for (const mark of marks) assert.doesNotMatch(mark, /[▲▼△▽]/);
  assert.match(legend, /✚ Refused 42% ▲ 2/);
  // A picture draws the same mark: a cross, filled along its arms and clear between them.
  const one = { cols: 12, rows: 6, low: 0, high: 10, points: 3, ticks: [], target: null, series: [{ values: [null, 5, null], rgb: [215, 175, 0], mark: 3 }] }, cell = { width: 16, height: 32 };
  const read = readPng(png(chartPicture(one, cell))), cx = Math.floor(chartColumn(1, one) * cell.width), cy = Math.floor(chartRow(5, one) * cell.height);
  for (const [dx, dy] of [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]]) assert.ok(read.at(cx + dx, cy + dy)[3] > 200, `filled at ${dx}, ${dy}: ${read.at(cx + dx, cy + dy)[3]}`);
  for (const [dx, dy] of [[5, 5], [-5, 5], [5, -5], [-5, -5]]) assert.ok(read.at(cx + dx, cy + dy)[3] < 60, `clear at ${dx}, ${dy}: ${read.at(cx + dx, cy + dy)[3]}`);
});

// What another computer of the project is sent was one budget for all of a Task's artifacts,
// spent on the first one's history first: a later artifact then arrived with no update, and that
// computer drew "no data yet" for one that is filled here.
test('an artifact with data shows its data on another computer, whatever the history of the artifact above it', async t => {
  const w = await world(t, { artifacts: [{ title: 'Eval history', shows: 'accuracy by run', every: 10 }, { title: 'Latency', shows: 'median seconds by surface', every: 10 }, { title: 'Cost', shows: 'dollars by run', every: null }] });
  const table = (n, rows = 124) => checkData({ blocks: [{ kind: 'table', label: `Run ${n}`, columns: ['Case', { label: 'Score', unit: '%', target: 85 }], rows: Array.from({ length: rows }, (_, i) => [`case ${String(i).padStart(3, '0')} of the eval set`, (i * 7 + n) % 100]) }] });
  const at = n => new Date(Date.UTC(2026, 10, 16, 9, n * 10)).toISOString();
  for (let n = 1; n <= 12; n++) addUpdate(w.repo, '1', 'Eval history', table(n), { by: 'script', at: at(n) });
  addUpdate(w.repo, '1', 'Latency', table(50), { by: 'script', at: at(12) }); addUpdate(w.repo, '1', 'Cost', table(60), { at: at(12) });
  const rows = artifactRows(currentTask(w.repo, '1'), readStore(w.repo, '1'));
  const sent = sharedArtifacts(rows), there = readSharedArtifacts(JSON.parse(JSON.stringify(sent)));
  assert.deepEqual(rows.map(row => row.updates.length), [12, 1, 1], 'kept here');
  // Each one's newest update is sent, then the history of the first as far as it fits.
  assert.deepEqual(there.map(row => row.updates.at(-1)?.at), [at(12), at(12), at(12)]);
  assert.ok(sent[0].updates.length > 1 && sent[0].updates.length < 12, `the first is sent ${sent[0].updates.length} of its 12 updates`);
  assert.deepEqual(sent[0].updates.map(update => update.at), rows[0].updates.slice(-sent[0].updates.length).map(update => update.at), 'its newest ones, oldest first');
  assert.ok(JSON.stringify(sent).length < 52000, `what is sent stays small: ${JSON.stringify(sent).length} characters`);
  const drawn = artifactsView(there, { width: 76, colour: false, now: Date.parse(at(13)) }).map(plain).join('\n');
  assert.doesNotMatch(drawn, /no data yet/); assert.match(drawn, /^Latency +every 10 min · updated /m); assert.match(drawn, /^Run 50$/m); assert.match(drawn, /^Run 60$/m);
  // Three artifacts whose newest updates are each near the size one update may have: all three arrive.
  const full = n => table(n, 480); assert.ok(JSON.stringify(full(1)).length > 15000);
  for (const [n, title] of [[70, 'Eval history'], [71, 'Latency'], [72, 'Cost']]) addUpdate(w.repo, '1', title, full(n), { at: at(14) });
  const large = readSharedArtifacts(JSON.parse(JSON.stringify(sharedArtifacts(artifactRows(currentTask(w.repo, '1'), readStore(w.repo, '1'))))));
  assert.deepEqual(large.map(row => row.updates.at(-1)?.at), [at(14), at(14), at(14)]);
});

// A computer on ELU 0.1.33 reads an update's data against its own limits (12 blocks, 20 bars, a
// table of 12 columns and 40 rows, a label of 80 characters, a note of 2,000) and drops the whole
// update over one block beyond them, so it drew "no data yet" for an artifact of 22 blocks.
test('what a computer on ELU 0.1.33 reads of an update stays within what it takes, and this ELU reads it whole', async t => {
  const w = await world(t, { artifacts: [{ title: 'Every run', shows: 'the score of each run', every: null }] });
  const scores = Array.from({ length: 22 }, (_, i) => ({ kind: 'score', label: `Run ${i + 1}`, value: 60 + i, unit: '%' }));
  const wide = { kind: 'table', columns: Array.from({ length: 14 }, (_, i) => `C${i}`), rows: [Array.from({ length: 14 }, (_, i) => i)] }, long = { kind: 'table', columns: ['Case', 'Score'], rows: Array.from({ length: 41 }, (_, i) => [`case ${i}`, i]) };
  const many = { kind: 'bars', label: 'By surface', rows: Array.from({ length: 21 }, (_, i) => ({ label: `Surface ${i}`, value: i })) }, named = { kind: 'score', label: 'L'.repeat(81), value: 1 }, note = { kind: 'note', text: 'word '.repeat(401).trim() };
  const fine = [{ kind: 'bars', label: 'By surface', unit: '%', rows: [{ label: 'Chat', value: 91 }] }, { kind: 'table', columns: ['Case', 'Score'], rows: [['case 1', 80]] }, { kind: 'note', text: 'Last run Nov 5.' }];
  const sendOf = blocks => { addUpdate(w.repo, '1', 'Every run', checkData({ blocks })); return JSON.parse(JSON.stringify(sharedArtifacts(artifactRows(currentTask(w.repo, '1'), readStore(w.repo, '1')))))[0].updates.at(-1); };
  // 22 blocks: the first 12 are what that computer reads, and the rest are beside them.
  const sent = sendOf(scores);
  assert.deepEqual(sent.data.blocks.map(block => block.label), scores.slice(0, 12).map(block => block.label));
  assert.deepEqual(sent.newer.map(row => [row.index, row.block.label]), scores.slice(12).map((block, i) => [12 + i, block.label]));
  assert.deepEqual(readSharedArtifacts([{ title: 'Every run', updates: [sent] }])[0].updates[0].data.blocks, scores, 'this ELU reads all 22, in their order');
  // A block beyond one of its limits goes beside the others, which it still draws.
  const mixed = [wide, fine[0], long, fine[1], many, named, note, fine[2]], other = sendOf(mixed);
  assert.deepEqual(other.data.blocks, checkData({ blocks: fine }).blocks);
  assert.deepEqual(other.newer.map(row => row.index), [0, 2, 4, 5, 6]);
  assert.deepEqual(readSharedArtifacts([{ title: 'Every run', updates: [other] }])[0].updates[0].data.blocks, checkData({ blocks: mixed }).blocks);
  // What this computer keeps is as before: every block of a kind 0.1.33 draws is in data.
  const kept = JSON.parse(fs.readFileSync(storeFile(w.repo, '1'), 'utf8')).items['every run'].updates;
  assert.deepEqual(kept.map(update => [update.data.blocks.length, update.newer]), [[22, undefined], [8, undefined]]);
});
