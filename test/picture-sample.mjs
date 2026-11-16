#!/usr/bin/env node
// A sample chart in this terminal, drawn by the code the Artifacts tab uses: a picture where the
// terminal shows pictures, the text chart where it does not. For a terminal no test has seen.
//
//   node test/picture-sample.mjs
//
// Keys: ↑ ↓ scroll · d a dialog over the chart · t text or picture · q quit. Its first line says
// how the chart is drawn, and after q it says what the terminal answered. It opens no project,
// and ELU's own folders are left alone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error('Run this in a terminal window: it draws on the screen.'); process.exit(1); }
// ELU's folders are, for this sample, an empty one that goes when it ends.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'elu-picture-sample-'));
Object.assign(process.env, { XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_DATA_HOME: path.join(scratch, 'data'), ELU_NO_UPDATE_CHECK: '1' });
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* It is in the temporary folder. */ } });

const { default: blessed } = await import('blessed');
await import('../lib/terminal-cells.mjs');
const { artifactsView, chartPictures } = await import('../lib/terminal-artifacts.mjs');
const { attachPictures, pictureSwitch } = await import('../lib/terminal-pictures.mjs');
const { readData } = await import('../lib/artifacts.mjs');
const { PALETTE, keepRows, visible } = await import('../lib/terminal-visuals.mjs');
const { columns: widthOf } = await import('../lib/width.mjs');
const { adviceLine, answerLine } = await import('./picture-sample-lines.mjs');

const NOTES = Array.from({ length: 30 }, (_, index) => `Line ${index + 1} of the notes: scroll, and the chart moves with the text.`).join('\n\n');
const ITEMS = [{ title: 'Eval history', every: null, updates: [{ at: new Date().toISOString(), data: readData(JSON.stringify({ blocks: [
  { kind: 'score', label: 'Accuracy, last run', value: 84, unit: '%', target: 85 },
  { kind: 'chart', label: 'Over time', unit: '%', target: 85, x: ['Oct 24', 'Oct 25', 'Oct 26', 'Oct 28', 'Oct 30', 'Oct 30', 'Nov 1', 'Nov 1', 'Nov 1', 'Nov 2', 'Nov 4', 'Nov 5'], series: [{ label: 'Accuracy', values: [78, 75, 74, 83, 85, 86, 80, 84, 93, 86, 61, 84] }, { label: 'Success rate', values: [40, 40, 40, 50, 40, 40, 50, 30, null, 50, 20, 30] }] },
  { kind: 'note', text: NOTES },
] })) }] }];

const colour = !process.env.ELU_NO_COLOR || process.env.ELU_NO_COLOR === '0';
const shade = name => colour ? PALETTE[name] : 'default';
const screen = blessed.screen({ terminal: process.env.TERM || 'xterm', smartCSR: true, fullUnicode: true, warnings: false, autoPadding: false, dockBorders: false });
keepRows(screen);
blessed.box({ parent: screen, top: 0, left: 0, width: '100%', height: '100%', style: { bg: shade('background') } });
const line = options => blessed.box({ parent: screen, left: 1, width: '100%-2', height: 1, tags: false, style: { fg: shade('muted'), bg: shade('background') }, ...options });
const head = line({ top: 0 });
line({ bottom: 0, content: '↑ ↓ scroll · d dialog over the chart · t text or picture · q quit' });
const pane = blessed.box({ parent: screen, top: 1, left: 0, width: '100%', height: '100%-2', border: 'line', label: ' Artifacts ', tags: true, wrap: false, style: { fg: shade('text'), bg: shade('panel'), border: { fg: shade('border') }, label: { fg: shade('muted'), bold: true } } });
const dialog = blessed.box({ parent: screen, hidden: true, top: 6, left: 'center', width: 46, height: 6, border: 'line', label: ' A dialog ', tags: false, content: '\n  No picture shows around this.\n  d closes it.', style: { fg: shade('text'), bg: shade('raised'), border: { fg: shade('orange') }, label: { fg: shade('muted'), bold: true } } });

let top = 0, textOnly = false, last = '', pictures = null;
// What the terminal answered, in a line (test/picture-sample-lines.mjs).
const answer = () => answerLine(pictures, pictureSwitch(process.env), Boolean(process.env.TMUX || process.env.STY || /^(?:screen|tmux)/.test(process.env.TERM ?? '')));
// The pane, as lib/terminal.mjs draws the Artifacts tab.
function draw() {
  const high = Math.max(1, pane.height - 2), width = Math.max(8, pane.width - 6);
  const cell = textOnly ? null : pictures.cell;
  const rows = artifactsView(ITEMS, { width, colour, picture: Boolean(cell) });
  const most = Math.max(0, rows.length - high); top = Math.max(0, Math.min(top, most));
  pane.setContent(rows.slice(top, top + high).map(row => `  ${row}${' '.repeat(Math.max(0, width - widthOf(visible(row))))}  `).join('\n'));
  const charts = cell ? chartPictures(rows, { cell, colour, solid: pictures.protocol === 'iterm', top }) : [];
  pictures.show(charts.length ? { box: pane, left: 3, top: 1, high, pictures: charts } : null);
  last = answer();
  const how = pictures.protocol === null ? 'asking the terminal…' : pictures.protocol === 'off' ? 'the text chart: no pictures in this terminal' : textOnly ? 'the text chart, as where no picture shows' : cell ? `a picture, by the ${pictures.protocol === 'kitty' ? 'Kitty graphics' : 'iTerm2 inline-image'} protocol` : 'text until the terminal says the size of a cell';
  head.setContent(`ELU sample chart · ${how}`);
  screen.render();
}
function quit() {
  const advice = adviceLine(pictures, pictureSwitch(process.env));
  screen.destroy();
  console.log(last);
  if (advice) console.log(advice);
  process.exit(0);
}
pictures = attachPictures(screen, { onChange: () => { if (pictures) draw(); } });
screen.key(['up', 'k'], () => { top--; draw(); });
screen.key(['down', 'j'], () => { top++; draw(); });
screen.key(['pageup'], () => { top -= Math.max(1, pane.height - 3); draw(); });
screen.key(['pagedown', 'space'], () => { top += Math.max(1, pane.height - 3); draw(); });
screen.key(['d'], () => { dialog.toggle(); if (!dialog.hidden) dialog.setFront(); draw(); });
screen.key(['t'], () => { textOnly = !textOnly; draw(); });
screen.key(['q', 'escape', 'C-c'], quit);
screen.on('resize', () => draw());
draw();
