import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { project } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { columns } from '../lib/width.mjs';
import { artifactRows as tabRows, artifactsView } from '../lib/terminal-artifacts.mjs';
import { addUpdate, artifactRows, artifactText, checkArtifacts, errorLine, everyText, knownArtifacts, readArtifactLine, readData, readSharedArtifacts, readStore, saveScript, sharedArtifacts, storeFile, taskArtifacts } from '../lib/artifacts.mjs';
import { namedFile } from '../lib/artifact-file.mjs';

test('an artifact line reads its title, what it shows and its interval', () => {
  assert.deepEqual(readArtifactLine('Artifact: Chat eval · answered per surface · every 10 min'), { title: 'Chat eval', shows: 'answered per surface', every: 10 });
  assert.deepEqual(readArtifactLine('Artifact: none'), { none: true });
  assert.equal(everyText(120), 'every 2 h');
  assert.equal(everyText(null), 'no refresh');
  assert.deepEqual(readArtifactLine('Artifact: Chat eval: answered per surface, every 10 min'), { title: 'Chat eval', shows: 'answered per surface', every: 10 });
  // The interval is the line's last part, as the New goal box writes it: one in what it shows stays there.
  for (const row of [{ title: 'Writes', shows: 'What the eval wrote, written every 30 min', every: 5 }, { title: 'Nightly', shows: 'The run, refreshed every 2 h', every: null }]) assert.deepEqual(readArtifactLine(artifactText(row)), row, artifactText(row));
});

test('data that ELU cannot draw is refused with what is wrong', () => {
  assert.deepEqual(readData('{"blocks":[{"kind":"score","label":"Answered","value":86.2,"unit":"%","target":85}]}').blocks[0].value, 86.2);
  assert.throws(() => readData('{"blocks":[{"kind":"score","label":"Answered","value":"86%"}]}'), /value is "86%", not a number/);
  assert.throws(() => readData('{"blocks":[{"kind":"pie"}]}'), /pie/);
  assert.throws(() => readData('not json'), /not JSON/);
});

test('a failed refresh says the line that names the error', () => {
  assert.equal(errorLine('node:fs:440\n    return binding.readFileUtf8(path, flags);\n\nError: ENOENT: no such file or directory'), 'Error: ENOENT: no such file or directory');
  assert.equal(errorLine('just one line'), 'just one line');
});

test('artifacts shared with another computer carry their data, never their script', () => {
  const rows = [{ title: 'Chat eval', shows: 'answered', every: 1, updates: [{ at: '2026-11-15T10:00:00.000Z', by: 'script', data: { blocks: [{ kind: 'note', text: 'Run 1' }] } }], script: '#!/bin/sh\ncat results.json', run: { at: '2026-11-15T10:01:00.000Z', ok: false, error: 'It ran past 60 seconds.' } }];
  const sent = sharedArtifacts(rows);
  assert.equal(sent[0].script, true);
  assert.ok(!JSON.stringify(sent).includes('results.json'));
  const read = readSharedArtifacts(JSON.parse(JSON.stringify(sent)));
  assert.equal(read[0].updates.length, 1);
  assert.equal(read[0].run.error, 'It ran past 60 seconds.');
});

test("a turn's elu and ELU's relay read the same file from elu artifacts, and only that one", () => {
  assert.deepEqual(namedFile(['artifacts', 'set', '1', '--file', 'run.json']), { file: 'run.json', rest: ['artifacts', 'set', '1'] });
  assert.deepEqual(namedFile(['artifacts', 'set', '1', '--file=run.json']), { file: 'run.json', rest: ['artifacts', 'set', '1'] });
  assert.deepEqual(namedFile(['artifacts', 'set', '1', '-']), { file: '-', rest: ['artifacts', 'set', '1'] });
  // The script's file is the fourth word, even when it reads as the artifact's number.
  assert.deepEqual(namedFile(['artifacts', 'script', '1', '1']), { file: '1', rest: ['artifacts', 'script', '1'] });
  assert.deepEqual(namedFile(['artifacts', 'set', '1', '--file']), { error: '--file needs a file, or - for standard input.\n' });
  for (const argv of [['artifacts'], ['artifacts', 'set', '1', '{"kind":"note","text":"x"}'], ['artifacts', 'script', '1', '--remove'], ['artifacts', 'set', '1', '--text', 'x'], ['artifacts', 'set', '1', '--', '--file', 'x'], ['sessions', 'set', '1', '--file', 'x']]) assert.equal(namedFile(argv), null, argv.join(' '));
});

test('an artifact with no data yet says so in lines that fit the tab', () => {
  for (const [script, said] of [[null, 'The session fills it, then refreshes it with a script of its own.'], ['echo', 'The session fills it as the work goes.']]) {
    const rows = tabRows({ title: 'Chat eval', shows: 'Answered against 85%', every: 1, updates: [], script, run: null }, { width: 44, colour: false }).map(row => row.replace(/\{\/?[a-z-]+\}/g, ''));
    assert.ok(rows.every(row => columns(row) <= 44), rows.join('\n'));
    assert.equal(rows.slice(2).join(' ').replace(/\s+/g, ' '), said);
  }
});

// A history the model has at once (each run's scores) is one chart block: drawn as a line chart,
// a line for each series with its own mark, the target dashed, the x labels that fit, a legend.
const RUNS = ['Oct 24, 04:49 PM', 'Oct 25, 12:02 PM', 'Oct 26, 11:31 AM', 'Oct 28, 12:36 PM', 'Oct 30, 12:22 AM', 'Oct 30, 07:18 PM', 'Nov 1, 08:56 AM', 'Nov 1, 02:05 PM', 'Nov 1, 11:55 PM', 'Nov 2, 09:52 PM', 'Nov 4, 09:13 PM', 'Nov 5, 04:36 PM'];
const HISTORY = { kind: 'chart', label: 'Over time', unit: '%', target: 85, x: RUNS, series: [{ label: 'Accuracy', values: [78, 75, 74, 83, 85, 86, 80, 84, 93, 86, 61, 84] }, { label: 'Success rate', values: [40, 40, 40, 50, 40, 40, 50, 30, null, 50, 20, 30] }] };
const plainRows = (data, width) => artifactsView([{ title: 'Eval history', every: null, updates: [{ at: '2026-11-15T10:00:00.000Z', data }] }], { width, colour: false }).map(row => row.replace(/\{\/?bold\}/g, ''));

test('a chart draws a history given at once: axis, a mark per series, the target dashed, x labels that fit and a legend', () => {
  const data = readData(JSON.stringify({ blocks: [HISTORY] }));
  assert.deepEqual(data.blocks[0].series[1].values[8], null);
  for (const width of [128, 70]) {
    const rows = plainRows(data, width), text = rows.join('\n');
    assert.ok(rows.every(row => columns(row) <= width), `every row fits ${width} columns`);
    // The axis, 0 to 100 for a percent, with its values on the left.
    for (const tick of ['100% ┤', '75% ┤', '50% ┤', '25% ┤', '0% ┤']) assert.ok(rows.some(row => row.trimStart().startsWith(tick)), `${tick} at ${width}`);
    assert.ok(rows.some(row => /^\s+└─+$/.test(row)), 'the x axis');
    // Each series has its own mark at its points, lines of braille dots between them, and the target is dashed.
    assert.equal((text.match(/●/g) ?? []).length, 12 + 1, 'twelve points and the legend');
    assert.equal((text.match(/■/g) ?? []).length, 11 + 1, 'eleven points (one is null) and the legend');
    assert.match(text, /[⠁-⣿]/);
    assert.match(text, /╌{4,}/);
    // The first and the last x labels show; those that would touch are left out.
    const under = rows.find(row => row.includes(RUNS[0]));
    assert.ok(under?.includes(RUNS.at(-1)), 'the last label shows');
    assert.ok(RUNS.filter(label => under.includes(label)).length < RUNS.length, 'labels are thinned');
    // The legend: each series with its mark, its newest value and its change since its first.
    assert.match(text, /● Accuracy 84% ▲ 6/); assert.match(text, /■ Success rate 30% ▼ 10/); assert.match(text, /╌ target ≥ 85%/);
  }
  // A null leaves a gap: no line between the points around it.
  const one = readData(JSON.stringify({ kind: 'chart', x: ['a', 'b', 'c'], series: [{ label: 'Gap', values: [10, null, 10] }] }));
  const rows = plainRows(one, 60).filter(row => /[┤│]/.test(row) && row.includes('●'));
  assert.equal(rows.length, 1); assert.doesNotMatch(rows[0].slice(rows[0].indexOf('●') + 1, rows[0].lastIndexOf('●')), /[⠁-⣿]/);
  assert.throws(() => readData(JSON.stringify({ kind: 'chart', x: ['a', 'b'], series: [{ label: 'One', values: [1] }] })), /values has 1 values and blocks\[0\] \(chart\)\.x 2 labels/);
  assert.throws(() => readData(JSON.stringify({ kind: 'chart', x: ['a'], series: [{ label: 'One', values: ['80%'] }] })), /values\[0\] is "80%", not a number/);
});

test('a record with a chart keeps it where an ELU of 0.1.33 skips it, here and on a teammate\'s computer', t => {
  const p = project(t), repo = repository(p.root), id = '7';
  const data = readData(JSON.stringify({ blocks: [{ kind: 'score', label: 'Accuracy', value: 84, unit: '%', target: 85 }, HISTORY, { kind: 'note', text: 'Last run Nov 5.' }] }));
  assert.equal(addUpdate(repo, id, 'Eval history', data).added, true);
  assert.equal(addUpdate(repo, id, 'Eval history', data).added, false, 'the same update adds nothing');
  // As kept: data holds the kinds 0.1.33 draws, the chart is beside it with its place.
  const kept = JSON.parse(fs.readFileSync(storeFile(repo, id), 'utf8')).items['eval history'].updates;
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].data.blocks.map(block => block.kind), ['score', 'note']);
  assert.deepEqual(kept[0].newer.map(row => [row.index, row.block.kind]), [[1, 'chart']]);
  // This ELU reads it whole, in its order.
  const task = { artifacts: [{ title: 'Eval history', shows: 'accuracy by run', every: null }] };
  const rows = artifactRows(task, readStore(repo, id));
  assert.deepEqual(rows[0].updates[0].data.blocks.map(block => block.kind), ['score', 'chart', 'note']);
  // A teammate gets the same shape; an older ELU reads data alone, and this one reads it whole.
  const sent = JSON.parse(JSON.stringify(sharedArtifacts(rows)));
  assert.deepEqual(sent[0].updates[0].data.blocks.map(block => block.kind), ['score', 'note']);
  assert.deepEqual(readSharedArtifacts(sent)[0].updates[0].data.blocks.map(block => block.kind), ['score', 'chart', 'note']);
  // A kind this ELU does not know, from a later one, is left out and the rest still reads.
  sent[0].updates[0].newer.push({ index: 0, block: { kind: 'gauge', value: 3 } });
  assert.deepEqual(readSharedArtifacts(sent)[0].updates[0].data.blocks.map(block => block.kind), ['score', 'chart', 'note']);
});

test('no count of ours limits blocks, rows, bars, columns, points, notes or artifacts; one update\'s size and plain text still hold', () => {
  const many = Array.from({ length: 22 }, (_, index) => ({ kind: 'score', label: `Metric ${index + 1}`, value: index }));
  assert.equal(readData(JSON.stringify({ blocks: many })).blocks.length, 22);
  const table = { kind: 'table', columns: Array.from({ length: 15 }, (_, index) => `C${index}`), rows: Array.from({ length: 50 }, (_, row) => Array.from({ length: 15 }, (_, index) => row + index)) };
  assert.equal(readData(JSON.stringify(table)).blocks[0].rows.length, 50);
  assert.equal(readData(JSON.stringify({ kind: 'bars', rows: Array.from({ length: 30 }, (_, index) => ({ label: `Bar ${index}`, value: index })) })).blocks[0].rows.length, 30);
  assert.equal(readData(JSON.stringify({ kind: 'note', label: 'L'.repeat(200), text: 'word '.repeat(1200) })).blocks[0].text.length, 5999);
  assert.equal(readData(JSON.stringify({ kind: 'chart', x: Array.from({ length: 200 }, (_, index) => `r${index}`), series: [{ label: 'A', values: Array.from({ length: 200 }, (_, index) => index % 100) }] })).blocks[0].x.length, 200);
  assert.equal(checkArtifacts(Array.from({ length: 8 }, (_, index) => ({ title: `Artifact ${index + 1}`, shows: 'numbers', everyMinutes: null }))).length, 8);
  assert.throws(() => readData(JSON.stringify({ kind: 'note', text: 'x'.repeat(17000) })), /at most 16000 in one update/);
  assert.throws(() => readData(JSON.stringify({ kind: 'note', text: 'bad\u001b[2J' })), /control characters/);
  // Every row of a long table is drawn; the tab scrolls.
  assert.equal(plainRows(readData(JSON.stringify(table)), 120).filter(row => /^\s*\d/.test(row)).length, 50);
});

// The tab at a narrow width, whatever it holds: a Task with no artifact yet says how to add one,
// an artifact with no data yet says who fills it, and one filled with a chart draws it, each in
// rows that fit the tab.
test('the tab fits a narrow width with no artifact yet, with one that has no data, and with one that has a chart', () => {
  const width = 44, plain = rows => rows.map(row => row.replace(/\{\/?[a-z-]+\}/g, ''));
  const empty = plain(artifactsView([], { width, colour: false }));
  assert.equal(empty[0], 'No artifacts yet');
  assert.equal(empty.slice(1).join(' '), 'Say in the chat what to show, or Ctrl+T, New goal, with an Artifact: line.');
  const unfilled = { title: 'Chat eval', shows: 'Answered against 85%', every: 1, updates: [], script: null, run: null };
  const charted = { title: 'Eval history', shows: 'accuracy by run', every: 5, updates: [{ at: '2026-11-15T10:00:00.000Z', data: readData(JSON.stringify({ blocks: [HISTORY] })) }], script: 'echo', run: null };
  const rows = plain(artifactsView([unfilled, charted], { width, colour: false, now: Date.parse('2026-11-15T10:05:00.000Z') })), text = rows.join('\n');
  for (const row of [...empty, ...rows]) assert.ok(columns(row) <= width, `${columns(row)} columns: ${row}`);
  assert.ok(text.replace(/\s+/g, ' ').includes('The session fills it, then refreshes it with a script of its own.'));
  assert.match(text, /100% ┤/); assert.match(text, /● Accuracy 84% ▲ 6/); assert.match(text, /╌ target ≥ 85%/);
});

// An artifact kept with a chart (beside its data, in newer) and a refresh script is still the one
// its New goal line names, by the Task and, once it left the Task, by what ELU keeps of it; read
// again it has every block in its order and its script.
test('an artifact kept with a chart and a refresh script reads back by its New goal line, whole, with its script', t => {
  const p = project(t), repo = repository(p.root), id = '8';
  const task = { artifacts: [{ title: 'Eval: history', shows: 'accuracy by run', every: 5 }] };
  addUpdate(repo, id, 'Eval: history', readData(JSON.stringify({ blocks: [HISTORY, { kind: 'note', text: 'Last run Nov 5.' }] })));
  saveScript(repo, id, 'Eval: history', 'echo {}\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(storeFile(repo, id), 'utf8')).items['eval: history'].updates[0].newer.map(row => row.block.kind), ['chart']);
  const line = artifactText(taskArtifacts(task)[0]);
  assert.equal(line, 'Artifact: Eval: history · accuracy by run · every 5 min');
  assert.deepEqual(readArtifactLine(line, knownArtifacts(repo, id, task)), { title: 'Eval: history', shows: 'accuracy by run', every: 5 });
  // Out of the Task, its title is still known by what is kept: a colon in it ends no title.
  assert.deepEqual(knownArtifacts(repo, id, { artifacts: [] }).map(row => row.title), ['Eval: history']);
  assert.deepEqual(readArtifactLine('Artifact: Eval: history · by run · every 10 min', knownArtifacts(repo, id, { artifacts: [] })), { title: 'Eval: history', shows: 'by run', every: 10 });
  assert.equal(readArtifactLine('Artifact: Eval: history · by run').title, 'Eval');
  const [row] = artifactRows(task, readStore(repo, id));
  assert.deepEqual([row.updates[0].data.blocks.map(block => block.kind), row.script], [['chart', 'note'], 'echo {}\n']);
  const drawn = tabRows(row, { width: 70, colour: false }).join('\n');
  assert.match(drawn, /● Accuracy 84%/); assert.match(drawn, /Last run Nov 5\./);
});
