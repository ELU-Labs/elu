import test from 'node:test';
import assert from 'node:assert/strict';
import { readData } from '../lib/artifacts.mjs';
import { artifactsView, chartAxis, chartPictures } from '../lib/terminal-artifacts.mjs';
import { chartColumn, chartRow, png, xtermRgb } from '../lib/chart-picture.mjs';
import { PICTURE_CELL } from '../lib/terminal-pictures.mjs';
import { PALETTE, visible } from '../lib/terminal-visuals.mjs';
import { readPng } from './picture-terminal.mjs';

// A chart's axis always has room between its ends, whatever the block says. Found by a check on
// 2026-11-16: a chart whose min was above all its values, which elu artifacts set takes, threw
// "Invalid array length" as its rows were made, and the session's Artifacts tab was blank. An
// end the block fixes stays where the block put it, and a value beyond it sits on that edge, as
// it does when only some values are beyond it.

const NOW = Date.parse('2026-11-15T10:05:00.000Z'), CELL = { width: 10, height: 20 }, BLUE = [...xtermRgb(PALETTE.blue), 255];
const items = block => [{ title: 'Eval history', every: null, updates: [{ at: '2026-11-15T10:00:00.000Z', data: readData(JSON.stringify({ blocks: [block] })) }] }];
const view = (block, picture = false) => artifactsView(items(block), { width: 70, colour: false, now: NOW, picture });
// The rows of the plot as they read: from the row under the label to the axis under them.
function plot(rows) {
  const plain = rows.map(row => visible(row)), last = plain.findIndex(row => /^ +└─+$/.test(row));
  return plain.slice(2, last);
}

const ABOVE = { kind: 'chart', label: 'Latency', unit: 's', min: 2, x: ['Mon', 'Tue'], series: [{ label: 'Median', values: [1.2, 0.9] }] };
const BELOW = { kind: 'chart', label: 'Errors', max: 5, x: ['run 1', 'run 2'], series: [{ label: 'Errors', values: [10, 20] }] };
const EMPTY = { kind: 'chart', label: 'Later', min: 500, x: ['run 1'], series: [{ label: 'Later', values: [null] }] };

test('a chart whose min is above all its values keeps that min, and its values sit on the bottom edge', () => {
  const rows = plot(view(ABOVE));
  assert.equal(rows.length, 9);
  assert.match(rows.at(-1), /^ *2 s ┤●⣀+●$/, 'both points and the line between them on the row of 2 s');
  assert.match(rows[0], /^ *2\.\d+ s ┤ +$/, 'the axis goes up from it, with nothing there');
  assert.ok(visible(view(ABOVE).at(-1)).startsWith('● Median 0.9 s'), 'the legend says its newest value');
});

test('a chart whose max is below all its values keeps that max, and its values sit on the top edge', () => {
  const rows = plot(view(BELOW));
  assert.equal(rows.length, 9);
  assert.match(rows[0], /^ *5 ┤●⠉+●$/, 'both points and the line between them on the row of 5');
  assert.match(rows.at(-1), /^ *4\.\d+ ┤ +$/, 'the axis goes down from it');
});

test('a chart with a min and no value yet shows its axis from that min', () => {
  const rows = plot(view(EMPTY));
  assert.equal(rows.length, 9);
  assert.match(rows.at(-1), /^ *500 ┤ +$/);
  assert.ok(rows.every(row => !/[●⠁-⣿]/.test(row)), 'nothing is drawn on it');
  assert.equal(visible(view(EMPTY).at(-1)), '● Later');
});

test('where the plot is a picture, the same charts leave it room, and the picture has the values on that edge', () => {
  for (const [block, low, high] of [[ABOVE, 2, null], [BELOW, null, 5], [EMPTY, 500, null]]) {
    const rows = view(block, true), [found] = rows.pictures, text = plot(rows);
    assert.equal(rows.length, view(block).length, `${block.label}: as many rows as the text chart`);
    assert.ok(text.every(row => row.endsWith(PICTURE_CELL.repeat(found.cols))), `${block.label}: its plot is left blank`);
    if (low !== null) { assert.equal(found.chart.low, low); assert.ok(found.chart.high > low, `${block.label}: the axis goes up from ${low}`); }
    if (high !== null) { assert.equal(found.chart.high, high); assert.ok(found.chart.low < high, `${block.label}: the axis goes down from ${high}`); }
    const [picture] = chartPictures(rows, { cell: CELL }), read = readPng(png(picture.draw()));
    assert.deepEqual([read.width, read.height], [found.cols * 10, 180]);
    // Each point where the picture puts a value beyond the axis: the middle of its edge row.
    block.series[0].values.forEach((value, at) => {
      if (value === null) return;
      const x = Math.floor(chartColumn(at, found.chart) * 10), y = Math.floor(chartRow(value, found.chart) * 20);
      assert.equal(y, low !== null ? 170 : 10, `${block.label}: on the edge`);
      assert.deepEqual(read.at(x, y), BLUE, `${block.label}: point ${at}`);
    });
  }
  // The value the block fixes is beside the row the picture puts it on.
  assert.match(plot(view(ABOVE, true)).at(-1), /^ *2 s ┤/); assert.match(plot(view(BELOW, true))[0], /^ *5 ┤/);
});

test('an axis the block fixes with room for its values is drawn as before', () => {
  // A min below the values: the axis starts there.
  const from = plot(view({ kind: 'chart', label: 'Score', min: 0, x: ['run 1', 'run 2'], series: [{ label: 'Score', values: [61, 75] }] }));
  assert.match(from.at(-1), /^ *0 ┤/); assert.match(from[0], /^ *80 ┤/);
  // One value alone has room on both sides.
  const one = plot(view({ kind: 'chart', label: 'Score', x: ['run 1'], series: [{ label: 'Score', values: [50] }] }));
  assert.match(one[0], /^ *55 ┤/); assert.match(one.at(-1), /^ *45 ┤/); assert.ok(one[4].includes('●'), 'in the middle');
  // A min equal to every value: the axis goes up from it.
  const flat = plot(view({ kind: 'chart', label: 'Score', min: 5, x: ['run 1', 'run 2'], series: [{ label: 'Score', values: [5, 5] }] }));
  assert.match(flat.at(-1), /^ *5 ┤●⣀+●$/); assert.match(flat[0], /^ *5\.6 ┤/);
  // A percent with a min above its values already drew them on its edge.
  const percent = plot(view({ kind: 'chart', label: 'Score', unit: '%', min: 80, x: ['run 1', 'run 2'], series: [{ label: 'Score', values: [61, 75] }] }));
  assert.match(percent.at(-1), /^ *80% ┤●⣀+●$/); assert.match(percent[0], /^ *100% ┤/);
  // Large numbers one apart are two values: the line rises from the bottom left to the top right.
  const counter = plot(view({ kind: 'chart', label: 'Rows', x: ['run 1', 'run 2'], series: [{ label: 'Rows', values: [2000000000, 2000000001] }] }));
  assert.match(counter.at(-1), /┤●/); assert.ok(counter[0].endsWith('●'));
});

// Two values a rounding apart (0.3 and 0.1 + 0.2) left an axis whose step no number can count
// by: naming its values never ended, and ELU ended once that had taken all its memory. The step
// is checked before anything is drawn, so that this test ends where the chart would not.
test('two values a rounding apart have an axis a number can count along, and are drawn as one value', () => {
  const apart = { kind: 'chart', label: 'Share', x: ['run 1', 'run 2'], series: [{ label: 'Share', values: [0.3, 0.1 + 0.2] }] };
  assert.notEqual(apart.series[0].values[0], apart.series[0].values[1], 'the two differ in their last digit');
  for (const block of [apart, { ...apart, min: 0.3 }, { ...apart, max: 0.1 + 0.2 }, { ...apart, unit: 's', target: 0.3 }]) {
    const { low, high, step } = chartAxis(readData(JSON.stringify({ blocks: [block] })).blocks[0]), named = JSON.stringify({ min: block.min, max: block.max, target: block.target });
    assert.ok(low + step > low && high - step < high, `${named}: a step of ${step} from ${low} is another number`);
    assert.ok((high - low) / step >= 2 && (high - low) / step <= 10, `${named}: a few steps from ${low} to ${high}`);
  }
  for (const picture of [false, true]) {
    const text = plot(view(apart, picture));
    assert.equal(text.length, 9);
    assert.match(text[4], /^ *0\.3 ┤/, 'its value in the middle of the axis');
    if (!picture) assert.match(text[4], /┤●.*●$/, 'both points on its row');
    assert.match(text[0], /^ *0\.3\d ┤/, 'with room above it'); assert.match(text.at(-1), /^ *0\.2\d ┤/, 'and under it');
  }
  // A min right at them stays the bottom of the axis, and a max the top.
  assert.match(plot(view({ ...apart, min: 0.3 })).at(-1), /^ *0\.3 ┤●.*●$/); assert.match(plot(view({ ...apart, max: 0.1 + 0.2 }))[0], /^ *0\.3 ┤●.*●$/);
});

test('every axis has a step a number can count along, whatever ends the block fixes', () => {
  const series = values => [{ label: 'Score', values }];
  for (const block of [ABOVE, BELOW, EMPTY,
    { kind: 'chart', x: ['a'], series: series([0]) }, { kind: 'chart', x: ['a'], series: series([null]) }, { kind: 'chart', x: ['a', 'b'], series: series([-5, -5]) },
    { kind: 'chart', min: 0, x: ['a', 'b'], series: series([-3, -4]) }, { kind: 'chart', max: 0, x: ['a', 'b'], series: series([3, 4]) }, { kind: 'chart', min: -10, x: ['a'], series: series([-20]) },
    { kind: 'chart', unit: '%', max: 50, x: ['a', 'b'], series: series([120, 130]) }, { kind: 'chart', min: 1e15, x: ['a'], series: series([1]) }, { kind: 'chart', max: -1e15, x: ['a'], series: series([1]) },
    { kind: 'chart', target: 7, x: ['a'], series: series([7]) }, { kind: 'chart', x: ['a', 'b'], series: series([1e15, 1e15 - 1]) }, { kind: 'chart', x: ['a', 'b'], series: series([1e-12, 2e-12]) },
  ]) {
    const read = readData(JSON.stringify({ blocks: [block] })).blocks[0], { low, high, step } = chartAxis(read), named = JSON.stringify(block);
    assert.ok(high > low, `${named}: room from ${low} to ${high}`);
    assert.ok(low + step > low && high - step < high && (high - low) / step <= 10, `${named}: a step of ${step}`);
    if (read.min !== undefined) assert.equal(low, read.min, `${named}: its min stays`);
    if (read.max !== undefined) assert.equal(high, read.max, `${named}: its max stays`);
    for (const picture of [false, true]) assert.ok(view(read, picture).length > 9, `${named}: drawn`);
  }
});

// A seeded random number, so a chart that fails can be made again.
function random(seed) { let state = seed >>> 0; return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test('random charts of every size of number, with values a rounding apart and ends fixed anywhere among them, each have room on their axis and are drawn', () => {
  const next = random(20261116), pick = list => list[Math.floor(next() * list.length)];
  const number = () => { const at = (next() * 2 - 1) * pick([0, 1e-6, 0.01, 1, 100, 1e6, 1e12, 1e15]); return next() < 0.3 ? Math.round(at) : at; };
  // A number within eight roundings of another.
  const near = value => value * (1 + Math.round((next() * 2 - 1) * 8) * 2 ** -52);
  let drawn = 0, apart = 0, beyond = 0;
  for (let round = 0; round < 2000; round++) {
    const base = number(), other = () => pick([base, near(base), number()]), points = pick([1, 2, 3, 4]);
    const block = { kind: 'chart', x: Array.from({ length: points }, (_, at) => `p${at + 1}`), series: [{ label: 'Line', values: Array.from({ length: points }, () => next() < 0.1 ? null : other()) }] };
    if (next() < 0.25) block.min = other();
    if (next() < 0.25) block.max = other();
    if (next() < 0.2) block.target = other();
    if (next() < 0.2) block.unit = '%';
    let read; try { read = readData(JSON.stringify({ blocks: [block] })).blocks[0]; } catch { continue; }
    const { low, high, step } = chartAxis(read), named = `round ${round}: ${JSON.stringify(block)}`, seen = [...read.series[0].values.filter(value => value !== null), ...(read.target === undefined ? [] : [read.target])];
    // The axis first: a chart whose axis has no step to count by is not drawn here.
    assert.ok(high > low, `${named}: room from ${low} to ${high}`);
    assert.ok(low + step > low && high - step < high && (high - low) / step <= 10, `${named}: a step of ${step} from ${low} to ${high}`);
    // An end the block fixes stays (of two fixed a rounding apart, its min), and one it leaves
    // open is beyond every value, give or take the rounding of a step.
    const both = read.min !== undefined && read.max !== undefined && !(read.max - read.min > Math.max(Math.abs(read.min), Math.abs(read.max)) * 1e-10);
    if (read.min !== undefined) assert.equal(low, read.min, `${named}: its min stays`); else assert.ok(seen.every(value => value >= low - step * 1e-6), `${named}: no value under ${low}`);
    if (read.max !== undefined) { if (!both) assert.equal(high, read.max, `${named}: its max stays`); } else assert.ok(seen.every(value => value <= high + step * 1e-6), `${named}: no value over ${high}`);
    const spread = seen.length ? Math.max(...seen) - Math.min(...seen) : 0;
    if (spread > 0 && spread <= Math.abs(base) * 1e-14) apart++;
    if (seen.length && (seen.every(value => value < low) || seen.every(value => value > high))) beyond++;
    assert.equal(view(read, true).length, view(read).length, `${named}: as many rows with a picture as without`);
    drawn++;
  }
  assert.ok(drawn > 1500 && apart > 50 && beyond > 50, `${drawn} charts drawn, ${apart} with values a rounding apart, ${beyond} with every value beyond an end the block fixes`);
});
