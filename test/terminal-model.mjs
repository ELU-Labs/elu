import { units, unitWidth, spread } from '../lib/width.mjs';

// A terminal, for tests: a grid of cells that follows what the app writes the way tmux and
// today's terminals do. A character of two columns takes two cells (the second one is ''), a
// mark goes on the character before it, and writing over half of a wide character blanks its
// other half. It knows the control codes blessed sends.
//
// measure: how this terminal measures text. The default is the app's own width, which
// test/wide-char-rows.test.mjs holds against what a real tmux reported. OLD measures as a
// terminal that joins nothing: every code point by itself, so a family of three is six cells
// and ⚠️ is one.
export const OLD = { units: text => Array.from(text), width: ch => spread(ch) };
const MODERN = { units, width: unitWidth };
const ACS = { l: '┌', q: '─', k: '┐', x: '│', m: '└', j: '┘', t: '├', u: '┤', v: '┴', w: '┬', n: '┼', '~': '·', a: '▒', '`': '◆', f: '°', g: '±', o: '⎺', s: '⎽' };
const TOKEN = /\x1b\[([?>=]?)([\d;]*)[ -\/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b([()])(.)|\x1b([78=>MDEc])|([\x00-\x1f\x7f])|([^\x00-\x1f\x7f]+)/g;

export function terminalModel(columns, rows, measure = MODERN) {
  const blank = () => Array.from({ length: columns }, () => ' ');
  let grid = Array.from({ length: rows }, blank);
  let x = 0, y = 0, wrap = true, pending = false, top = 0, bottom = rows - 1, acs = false, saved = { x: 0, y: 0, wrap: true }, wrapped = 0, scrolled = 0;
  const clamp = () => { x = Math.max(0, Math.min(columns - 1, x)); y = Math.max(0, Math.min(rows - 1, y)); pending = false; };
  // Writing into one half of a wide character leaves no half of it.
  const free = (row, at) => {
    if (at < 0 || at >= columns) return;
    if (row[at] === '' && at > 0) row[at - 1] = ' ';
    if (row[at + 1] === '') row[at + 1] = ' ';
  };
  const scroll = by => {
    scrolled += Math.abs(by);
    for (let step = 0; step < Math.abs(by); step++) { if (by > 0) { grid.splice(top, 1); grid.splice(bottom, 0, blank()); } else { grid.splice(bottom, 1); grid.splice(top, 0, blank()); } }
  };
  const newline = () => { if (y === bottom) scroll(1); else if (y < rows - 1) y++; };
  const put = unit => {
    const size = measure.width(unit);
    if (size <= 0) { const at = pending ? x : x - 1; if (at >= 0 && grid[y][at] !== '') grid[y][at] += unit; else if (at > 0) grid[y][at - 1] += unit; return; }
    if (pending) { if (wrap) { x = 0; newline(); wrapped++; } pending = false; }
    if (size === 2 && x === columns - 1) { if (!wrap) return; x = 0; newline(); wrapped++; }
    const row = grid[y];
    for (let at = x; at < x + size; at++) { free(row, at); row[at] = at === x ? unit : ''; }
    x += size;
    if (x >= columns) { x = columns - 1; pending = true; }
  };
  const erase = (row, from, to) => { for (let at = from; at <= to && at < columns; at++) { free(row, at); row[at] = ' '; } };
  const csi = (mark, text, final) => {
    const args = text.split(';').map(value => value === '' ? null : Number(value)), n = args[0] ?? 1;
    if (mark === '?') { if (args.includes(7)) wrap = final === 'h'; return; }
    if (mark) return;
    if (final === 'H' || final === 'f') { y = (args[0] ?? 1) - 1; x = (args[1] ?? 1) - 1; clamp(); }
    else if (final === 'G' || final === '`') { x = n - 1; clamp(); }
    else if (final === 'd') { y = n - 1; clamp(); }
    else if (final === 'A') { y -= n; clamp(); } else if (final === 'B') { y += n; clamp(); }
    else if (final === 'C') { x += n; clamp(); } else if (final === 'D') { x -= n; clamp(); }
    else if (final === 'K') { const mode = args[0] ?? 0; erase(grid[y], mode === 0 ? x : 0, mode === 1 ? x : columns - 1); }
    else if (final === 'J') { const mode = args[0] ?? 0; if (mode === 2 || mode === 3) grid = Array.from({ length: rows }, blank); else { erase(grid[y], x, columns - 1); for (let row = y + 1; row < rows; row++) grid[row] = blank(); } }
    else if (final === 'X') erase(grid[y], x, x + n - 1);
    else if (final === 'r') { top = (args[0] ?? 1) - 1; bottom = (args[1] ?? rows) - 1; x = 0; y = 0; pending = false; }
    else if (final === 'L' && y >= top && y <= bottom) { for (let step = 0; step < n; step++) { grid.splice(bottom, 1); grid.splice(y, 0, blank()); } }
    else if (final === 'M' && y >= top && y <= bottom) { for (let step = 0; step < n; step++) { grid.splice(y, 1); grid.splice(bottom, 0, blank()); } }
    else if (final === 'S') scroll(n); else if (final === 'T') scroll(-n);
  };
  return {
    write(data) {
      for (const found of String(data).matchAll(TOKEN)) {
        const [, mark, args, final, set, charset, escape, control, text] = found;
        if (final) csi(mark, args, final);
        else if (set) { if (set === '(') acs = charset === '0'; }
        else if (escape === '7') saved = { x, y, wrap };
        else if (escape === '8') { ({ x, y, wrap } = saved); pending = false; }
        else if (escape === 'M') { if (y === top) scroll(-1); else if (y > 0) y--; }
        else if (escape === 'D') newline();
        else if (escape === 'E') { x = 0; newline(); }
        else if (control === '\r') { x = 0; pending = false; }
        else if (control === '\n') newline();
        else if (control === '\b') { x = Math.max(0, x - 1); pending = false; }
        else if (control === '\x0e') acs = true; else if (control === '\x0f') acs = false;
        else if (text) for (const unit of measure.units(text)) put(acs && ACS[unit] ? ACS[unit] : unit);
      }
      return this;
    },
    get grid() { return grid; },
    // Row y as text, as tmux capture-pane prints it.
    line: row => grid[row].join(''),
    lines: () => grid.map(row => row.join('').trimEnd()),
    // How often the terminal wrapped a row by itself, or scrolled: an app that places every cell never causes either.
    get wrapped() { return wrapped; },
    get cursor() { return { x, y }; },
  };
}
// What blessed holds for the screen, as the cells a terminal shows for it: the character in
// the first cell of a wide one, '' in its second.
export function heldCells(screen, cellText) {
  return screen.lines.map(line => line.map((cell, at) => cell[1] === '\x03' ? (at > 0 && line[at - 1][1] !== '\x03' && line[at - 1][1].length && unitWidth(cellText(line[at - 1][1])) === 2 ? '' : ' ') : cell[1].length > 1 || cell[1] >= '\u1100' ? (unitWidth(cellText(cell[1])) === 2 && line[at + 1]?.[1] !== '\x03' ? ' ' : cellText(cell[1])) : cell[1]));
}
