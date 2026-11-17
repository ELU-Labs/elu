#!/usr/bin/env node
// render.mjs: turns a story (a few captured terminal screens) into one looping SVG animation.
//
//   node render.mjs <story folder> <out.svg> [--stills <folder>] [--width <px>]
//
// A story folder holds story.json and one .ansi file per frame, each exactly what
// `tmux capture-pane -e -p` printed. USAGE.md beside this file has the story format.
// No dependencies. Node 22.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

// ---------------------------------------------------------------- look

const CW = 10; // one cell, in drawing units
const CH = 20;
const BASE = 15; // text baseline inside a cell
const FONT_SIZE = 16.67; // 10 / 0.6: the usual advance of a monospace font
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono","DejaVu Sans Mono",monospace';
const SANS = 'system-ui,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif';

const CARD_BG = '#0d0e11'; // also the screen's default background
const CARD_EDGE = '#3a3f47';
const DEFAULT_FG = '#d0d0d0';
const RULE = '#2a2e35';
const CAPTION = '#c9d1d9';
const MARK_OFF = '#4b5059';
const MARK_ON = '#e6edf3';

// The 16 basic colours. Chosen to read on the dark card and to sit beside the 256-colour
// tones the app itself uses. Black is a grey so that black text still shows.
const BASIC16 = [
  '#3a3a3a', '#ff5f5f', '#5fd787', '#ffd75f', '#5fafff', '#af87ff', '#5fd7d7', '#c6c6c6',
  '#767676', '#ff8787', '#87ffaf', '#ffff87', '#87d7ff', '#d7afff', '#87ffff', '#ffffff',
];

const LIGHT = 1.3; // stroke widths of the drawn lines
const HEAVY = 2.8;
const DOUBLE = 1.6; // half the gap of a double line

// ---------------------------------------------------------------- small helpers

function fail(msg) {
  process.stderr.write(`render: ${msg}\n`);
  process.exit(1);
}
function warn(msg) {
  process.stderr.write(`render: warning: ${msg}\n`);
}
function num(v) {
  const s = String(Math.round(v * 100) / 100);
  if (s.startsWith('0.')) return s.slice(1);
  if (s.startsWith('-0.')) return '-' + s.slice(2);
  return s;
}
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;');
}
function hex(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}
function xterm(n) {
  if (!(n >= 0 && n <= 255)) return null;
  if (n < 16) return BASIC16[n];
  if (n < 232) {
    const l = [0, 95, 135, 175, 215, 255];
    const v = n - 16;
    return hex(l[Math.floor(v / 36)], l[Math.floor(v / 6) % 6], l[v % 6]);
  }
  const g = 8 + 10 * (n - 232);
  return hex(g, g, g);
}

// ---------------------------------------------------------------- reading a capture

const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xfe50, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f2ff], [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];
const ZERO = [
  [0x300, 0x36f], [0x483, 0x489], [0x591, 0x5bd], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064],
  [0x20d0, 0x20f0], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff], [0xe0100, 0xe01ef],
];
function inRanges(cp, ranges) {
  for (const [a, b] of ranges) if (cp >= a && cp <= b) return true;
  return false;
}
function cellWidth(cp) {
  if (cp < 0x300) return 1;
  if (inRanges(cp, ZERO)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

// The line-drawing set a terminal switches to with shift-out.
const ACS = {
  '`': '◆', a: '▒', f: '°', g: '±', j: '┘', k: '┐', l: '┌', m: '└', n: '┼', q: '─', t: '├', u: '┤',
  v: '┴', w: '┬', x: '│', y: '≤', z: '≥', '{': 'π', '|': '≠', '}': '£', '~': '·',
};

function newState() {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, ul: false, rev: false, hidden: false, strike: false, acs: false };
}

function applySgr(st, text) {
  const parts = text === '' ? ['0'] : text.split(';');
  for (let i = 0; i < parts.length; i++) {
    const sub = parts[i].split(':');
    const n = sub[0] === '' ? 0 : Number(sub[0]);
    if (n === 38 || n === 48 || n === 58) {
      let col = null;
      if (sub.length > 1) {
        // 38:5:n  or  38:2::r:g:b
        if (sub[1] === '5') col = xterm(Number(sub[2]));
        else if (sub[1] === '2') col = hex(...sub.slice(-3).map(Number));
      } else if (parts[i + 1] === '5') {
        col = xterm(Number(parts[i + 2]));
        i += 2;
      } else if (parts[i + 1] === '2') {
        col = hex(Number(parts[i + 2]), Number(parts[i + 3]), Number(parts[i + 4]));
        i += 4;
      }
      if (col && n === 38) st.fg = col;
      if (col && n === 48) st.bg = col;
      continue;
    }
    if (n === 0) Object.assign(st, newState(), { acs: st.acs });
    else if (n === 1) st.bold = true;
    else if (n === 2) st.dim = true;
    else if (n === 3) st.italic = true;
    else if (n === 4) st.ul = !(sub.length > 1 && sub[1] === '0');
    else if (n === 7) st.rev = true;
    else if (n === 8) st.hidden = true;
    else if (n === 9) st.strike = true;
    else if (n === 21) st.ul = true;
    else if (n === 22) st.bold = st.dim = false;
    else if (n === 23) st.italic = false;
    else if (n === 24) st.ul = false;
    else if (n === 27) st.rev = false;
    else if (n === 28) st.hidden = false;
    else if (n === 29) st.strike = false;
    else if (n >= 30 && n <= 37) st.fg = BASIC16[n - 30];
    else if (n === 39) st.fg = null;
    else if (n >= 40 && n <= 47) st.bg = BASIC16[n - 40];
    else if (n === 49) st.bg = null;
    else if (n >= 90 && n <= 97) st.fg = BASIC16[n - 90 + 8];
    else if (n >= 100 && n <= 107) st.bg = BASIC16[n - 100 + 8];
  }
}

// flag bits of a cell
const F_BOLD = 1, F_DIM = 2, F_ITALIC = 4, F_UL = 8, F_STRIKE = 16;

function makeCell(ch, w, st) {
  let fg = st.fg ?? DEFAULT_FG;
  let bg = st.bg;
  if (st.rev) {
    const f = fg;
    fg = bg ?? CARD_BG;
    bg = f;
  }
  const fl = (st.bold ? F_BOLD : 0) | (st.dim ? F_DIM : 0) | (st.italic ? F_ITALIC : 0) | (st.ul ? F_UL : 0) | (st.strike ? F_STRIKE : 0);
  return { ch: st.hidden ? ' ' : ch, w, fg, bg, fl, cont: false };
}

// One capture -> rows of cells. The colour state carries from one line to the next, as tmux writes it.
function parseScreen(text, cols, rows, name) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length > rows) fail(`${name} has ${lines.length} lines, but the story says rows is ${rows}`);
  if (lines.length < rows) warn(`${name} has ${lines.length} lines, fewer than rows ${rows}; the missing rows are left empty`);
  const st = newState();
  const grid = [];
  for (let y = 0; y < rows; y++) {
    const row = [];
    const have = y < lines.length;
    const line = have ? lines[y].replace(/\r$/, '') : '';
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (c === '\x1b') {
        const next = line[i + 1];
        if (next === '[') {
          let j = i + 2;
          while (j < line.length && !(line.charCodeAt(j) >= 0x40 && line.charCodeAt(j) <= 0x7e)) j++;
          if (line[j] === 'm') applySgr(st, line.slice(i + 2, j));
          i = j + 1;
        } else if (next === ']') {
          let j = i + 2;
          while (j < line.length && line[j] !== '\x07' && !(line[j] === '\x1b' && line[j + 1] === '\\')) j++;
          i = line[j] === '\x07' ? j + 1 : j + 2;
        } else if (next === '(' || next === ')' || next === '*' || next === '+') {
          i += 3;
        } else {
          i += 2;
        }
        continue;
      }
      if (c === '\x0e') { st.acs = true; i++; continue; }
      if (c === '\x0f') { st.acs = false; i++; continue; }
      const cp = line.codePointAt(i);
      let ch = String.fromCodePoint(cp);
      i += ch.length;
      if (cp === 9) ch = ' ';
      else if (cp < 0x20 || cp === 0x7f) continue;
      if (st.acs && ACS[ch]) ch = ACS[ch];
      const w = cellWidth(ch.codePointAt(0));
      if (w === 0) {
        let k = row.length - 1;
        while (k >= 0 && row[k].cont) k--;
        if (k >= 0 && row[k].ch !== ' ') row[k].ch += ch;
        continue;
      }
      if (row.length + w > cols) fail(`${name}: line ${y + 1} is wider than cols ${cols}`);
      const cell = makeCell(ch, w, st);
      row.push(cell);
      if (w === 2) row.push({ ch: '', w: 0, fg: cell.fg, bg: cell.bg, fl: 0, cont: true });
    }
    // tmux drops the spaces at the end of a line. They had the background in effect there.
    const fill = have ? makeCell(' ', 1, st).bg : null;
    while (row.length < cols) row.push({ ch: ' ', w: 1, fg: DEFAULT_FG, bg: fill, fl: 0, cont: false });
    grid.push(row);
  }
  return grid;
}

// ---------------------------------------------------------------- characters drawn as shapes

// Arms of each box-drawing character: left, up, right, down. 1 light, 2 heavy, 3 double.
const BOX = new Map();
for (const item of (
  '─1010 ━2020 │0101 ┃0202 ┌0011 ┍0021 ┎0012 ┏0022 ┐1001 ┑2001 ┒1002 ┓2002 └0110 ┕0120 ┖0210 ┗0220 ' +
  '┘1100 ┙2100 ┚1200 ┛2200 ├0111 ┝0121 ┞0211 ┟0112 ┠0212 ┡0221 ┢0122 ┣0222 ┤1101 ┥2101 ┦1201 ┧1102 ' +
  '┨1202 ┩2201 ┪2102 ┫2202 ┬1011 ┭2011 ┮1021 ┯2021 ┰1012 ┱2012 ┲1022 ┳2022 ┴1110 ┵2110 ┶1120 ┷2120 ' +
  '┸1210 ┹2210 ┺1220 ┻2220 ┼1111 ┽2111 ┾1121 ┿2121 ╀1211 ╁1112 ╂1212 ╃2211 ╄1221 ╅2112 ╆1122 ╇2221 ' +
  '╈2122 ╉2212 ╊1222 ╋2222 ╴1000 ╵0100 ╶0010 ╷0001 ╸2000 ╹0200 ╺0020 ╻0002 ╼1020 ╽0102 ╾2010 ╿0201 ' +
  '═3030 ║0303 ╔0033 ╗3003 ╚0330 ╝3300'
).split(' ')) {
  BOX.set(item[0], [...item.slice(1)].map(Number));
}
// Dashed lines: direction, weight, dashes in one cell.
const DASH = new Map(Object.entries({
  '┄': ['h', 1, 3], '┅': ['h', 2, 3], '┆': ['v', 1, 3], '┇': ['v', 2, 3], '┈': ['h', 1, 4], '┉': ['h', 2, 4],
  '┊': ['v', 1, 4], '┋': ['v', 2, 4], '╌': ['h', 1, 2], '╍': ['h', 2, 2], '╎': ['v', 1, 2], '╏': ['v', 2, 2],
}));
const ARC = new Map(Object.entries({ '╭': [1, 1], '╮': [-1, 1], '╯': [-1, -1], '╰': [1, -1] })); // toward x, toward y

// Characters that can be drawn as one shape across a run of cells.
const MERGE = new Set(['─', '━', '═', '┄', '┅', '┈', '┉', '╌', '╍', '▀', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '░', '▒', '▓', '▔']);

const rect = (x, y, w, h) => `M${num(x)} ${num(y)}h${num(w)}v${num(h)}h${num(-w)}z`;
const poly = (pts) => 'M' + pts.map(([x, y]) => `${num(x)} ${num(y)}`).join('L') + 'z';
const line = (pts) => 'M' + pts.map(([x, y]) => `${num(x)} ${num(y)}`).join('L');
const ring = (cx, cy, r) => `M${num(cx - r)} ${num(cy)}a${num(r)} ${num(r)} 0 1 0 ${num(2 * r)} 0a${num(r)} ${num(r)} 0 1 0 ${num(-2 * r)} 0z`;

const SLANT = new Set(['╱', '╲', '╳']);
const isLineChar = (ch) => BOX.has(ch) || DASH.has(ch) || ARC.has(ch) || SLANT.has(ch);

// The lines of one whole frame. Box-drawing characters are not drawn row by row: all the lines
// of one colour and weight become one shape, so borders join and no joint shows.
class Lines {
  constructor() {
    this.sets = new Map();
  }
  add(kind, fg, dim, piece) {
    const key = `${kind}|${fg}|${dim ? 1 : 0}`;
    let s = this.sets.get(key);
    if (!s) this.sets.set(key, (s = { kind, fg, dim, h: [], v: [], p: '' }));
    if (piece.h) s.h.push(piece.h);
    else if (piece.v) s.v.push(piece.v);
    else s.p += piece.p;
  }
  markup(classes) {
    let out = '';
    for (const s of this.sets.values()) {
      let d = '';
      for (const [at, a, b] of joined(s.h)) d += `M${num(a)} ${num(at)}H${num(b)}`;
      for (const [at, a, b] of joined(s.v)) d += `M${num(at)} ${num(a)}V${num(b)}`;
      out += `<path${classAttr([s.kind, classes.stroke(s.fg), s.dim ? 'D' : ''])} d="${d + s.p}"/>`;
    }
    return out;
  }
}
// pieces [line, from, to] on the same line that touch become one piece
function joined(pieces) {
  const sorted = [...pieces].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && last[0] === s[0] && s[1] <= last[2] + 0.001) last[2] = Math.max(last[2], s[2]);
    else out.push([...s]);
  }
  return out;
}

// One line character (or a run of n of the same) at cell corner x0, y0 -> pieces handed to add(kind, piece).
function addLines(ch, x0, y0, n, add) {
  const cx = x0 + CW / 2, cy = y0 + CH / 2, x1 = x0 + n * CW, yb = y0 + CH;
  if (DASH.has(ch)) {
    const [dir, w, count] = DASH.get(ch);
    const kind = (w === 1 ? 'L' : 'H') + (dir === 'h' ? ' Y' : ' Z') + count;
    add(kind, { p: dir === 'h' ? `M${num(x0)} ${num(cy)}H${num(x1)}` : `M${num(cx)} ${num(y0)}V${num(yb)}` });
    return;
  }
  if (ARC.has(ch)) {
    const [hx, vy] = ARC.get(ch);
    add('L', { p: `M${num(cx)} ${num(vy > 0 ? yb : y0)}V${num(cy + vy * 5)}Q${num(cx)} ${num(cy)} ${num(hx > 0 ? x0 + CW : x0)} ${num(cy)}` });
    return;
  }
  if (SLANT.has(ch)) {
    if (ch !== '╲') add('L', { p: line([[x0, yb], [x0 + CW, y0]]) });
    if (ch !== '╱') add('L', { p: line([[x0, y0], [x0 + CW, yb]]) });
    return;
  }
  const [l, u, r, d] = BOX.get(ch);
  if (l === 3 || u === 3 || r === 3 || d === 3) {
    if (l === 3 && r === 3) {
      add('L', { h: [cy - DOUBLE, x0, x1] });
      add('L', { h: [cy + DOUBLE, x0, x1] });
    } else if (u === 3 && d === 3) {
      add('L', { v: [cx - DOUBLE, y0, yb] });
      add('L', { v: [cx + DOUBLE, y0, yb] });
    } else {
      const hx = r ? 1 : -1, vy = d ? 1 : -1;
      const ex = r ? x0 + CW : x0, ey = d ? yb : y0;
      add('L', { p: `M${num(cx - hx * DOUBLE)} ${num(ey)}V${num(cy - vy * DOUBLE)}H${num(ex)}M${num(cx + hx * DOUBLE)} ${num(ey)}V${num(cy + vy * DOUBLE)}H${num(ex)}` });
    }
    return;
  }
  const widthOf = (w) => (w === 2 ? HEAVY : w === 1 ? LIGHT : 0);
  const reachH = Math.max(widthOf(u), widthOf(d)) / 2; // how far a lone side arm goes past the middle
  const reachV = Math.max(widthOf(l), widthOf(r)) / 2;
  for (const w of [1, 2]) {
    const L = l === w, U = u === w, R = r === w, D = d === w;
    if (!L && !U && !R && !D) continue;
    const kind = w === 1 ? 'L' : 'H';
    if (L + R === 1 && U + D === 1 && l + u + r + d === 2 * w) {
      // a plain corner: one bent stroke, so the corner is square
      add(kind, { p: `M${num(L ? x0 : x1)} ${num(cy)}H${num(cx)}V${num(U ? y0 : yb)}` });
      continue;
    }
    if (L && R) add(kind, { h: [cy, x0, x1] });
    else if (L) add(kind, { h: [cy, x0, cx + reachH] });
    else if (R) add(kind, { h: [cy, cx - reachH, x1] });
    if (U && D) add(kind, { v: [cx, y0, yb] });
    else if (U) add(kind, { v: [cx, y0, cy + reachV] });
    else if (D) add(kind, { v: [cx, cy - reachV, yb] });
  }
}

function blockShape(cp, x0, n) {
  const W = n * CW;
  if (cp === 0x2580) return [['X', rect(x0, 0, W, CH / 2)]];
  if (cp >= 0x2581 && cp <= 0x2588) {
    const h = (CH * (cp - 0x2580)) / 8;
    return [['X', rect(x0, CH - h, W, h)]];
  }
  if (cp >= 0x2589 && cp <= 0x258f) return [['X', rect(x0, 0, (CW * (0x2590 - cp)) / 8, CH)]];
  if (cp === 0x2590) return [['X', rect(x0 + CW / 2, 0, CW / 2, CH)]];
  if (cp >= 0x2591 && cp <= 0x2593) return [['X S' + (cp - 0x2590), rect(x0, 0, W, CH)]];
  if (cp === 0x2594) return [['X', rect(x0, 0, W, CH / 8)]];
  if (cp === 0x2595) return [['X', rect(x0 + (CW * 7) / 8, 0, CW / 8, CH)]];
  // quadrants: bits upper-left 1, upper-right 2, lower-left 4, lower-right 8
  const quads = { 0x2596: 4, 0x2597: 8, 0x2598: 1, 0x2599: 13, 0x259a: 9, 0x259b: 7, 0x259c: 11, 0x259d: 2, 0x259e: 6, 0x259f: 14 }[cp];
  if (!quads) return null;
  let p = '';
  if (quads & 1) p += rect(x0, 0, CW / 2, CH / 2);
  if (quads & 2) p += rect(x0 + CW / 2, 0, CW / 2, CH / 2);
  if (quads & 4) p += rect(x0, CH / 2, CW / 2, CH / 2);
  if (quads & 8) p += rect(x0 + CW / 2, CH / 2, CW / 2, CH / 2);
  return [['X', p]];
}

function brailleShape(cp, x0) {
  const bits = cp - 0x2800;
  const at = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]]; // column, row of each dot
  let p = '';
  for (let b = 0; b < 8; b++) {
    if (bits & (1 << b)) p += `M${num(x0 + 2.5 + at[b][0] * 5)} ${num(2.5 + at[b][1] * 5)}h.01`;
  }
  return p ? [['O', p]] : [];
}

function symbolShape(cp, x0) {
  const cx = x0 + CW / 2, cy = CH / 2;
  const tri = (dx, dy, s, kind) => {
    // a triangle pointing toward (dx, dy), s is its size
    const tip = [cx + dx * s, cy + dy * s];
    const a = [cx - dx * s * 0.8 - dy * s, cy - dy * s * 0.8 - dx * s];
    const b = [cx - dx * s * 0.8 + dy * s, cy - dy * s * 0.8 + dx * s];
    return [[kind, poly([tip, a, b])]];
  };
  const diamond = poly([[cx, cy - 4.8], [cx + 4.3, cy], [cx, cy + 4.8], [cx - 4.3, cy]]);
  const cross = line([[x0 + 2.2, cy - 3.6], [x0 + 7.8, cy + 3.6]]) + line([[x0 + 7.8, cy - 3.6], [x0 + 2.2, cy + 3.6]]);
  const check = line([[x0 + 1.6, cy + 0.6], [x0 + 4, cy + 3.6], [x0 + 8.6, cy - 4]]);
  switch (cp) {
    case 0x25c6: return [['', diamond]];
    case 0x25c7: return [['A', poly([[cx, cy - 4.2], [cx + 3.7, cy], [cx, cy + 4.2], [cx - 3.7, cy]])]];
    case 0x25a0: case 0x25fc: return [['', rect(cx - 3.6, cy - 3.6, 7.2, 7.2)]];
    case 0x25aa: return [['', rect(cx - 2.2, cy - 2.2, 4.4, 4.4)]];
    case 0x25a1: case 0x25fb: return [['A', rect(cx - 3.2, cy - 3.2, 6.4, 6.4)]];
    case 0x25ab: return [['A', rect(cx - 2, cy - 2, 4, 4)]];
    case 0x25cf: return [['', ring(cx, cy, 3.9)]];
    case 0x25cb: case 0x25ef: return [['A', ring(cx, cy, 3.4)]];
    case 0x25c9: return [['A', ring(cx, cy, 3.6)], ['', ring(cx, cy, 1.6)]];
    case 0x2022: return [['', ring(cx, cy, 2)]];
    case 0x25b2: return tri(0, -1, 4.4, '');
    case 0x25bc: return tri(0, 1, 4.4, '');
    case 0x25b6: return tri(1, 0, 4.4, '');
    case 0x25c0: return tri(-1, 0, 4.4, '');
    case 0x25b4: return tri(0, -1, 3.2, '');
    case 0x25be: return tri(0, 1, 3.2, '');
    case 0x25b8: return tri(1, 0, 3.2, '');
    case 0x25c2: return tri(-1, 0, 3.2, '');
    case 0x25b3: return tri(0, -1, 3.8, 'A');
    case 0x25bd: return tri(0, 1, 3.8, 'A');
    case 0x25b7: return tri(1, 0, 3.8, 'A');
    case 0x25c1: return tri(-1, 0, 3.8, 'A');
    case 0x25b5: return tri(0, -1, 2.8, 'A');
    case 0x25bf: return tri(0, 1, 2.8, 'A');
    case 0x25b9: return tri(1, 0, 2.8, 'A');
    case 0x25c3: return tri(-1, 0, 2.8, 'A');
    case 0x2192: return [['A', line([[x0 + 1.4, cy], [x0 + 8.6, cy]]) + line([[x0 + 5.6, cy - 3], [x0 + 8.6, cy], [x0 + 5.6, cy + 3]])]];
    case 0x2190: return [['A', line([[x0 + 8.6, cy], [x0 + 1.4, cy]]) + line([[x0 + 4.4, cy - 3], [x0 + 1.4, cy], [x0 + 4.4, cy + 3]])]];
    case 0x2191: return [['A', line([[cx, cy + 5], [cx, cy - 5]]) + line([[cx - 3, cy - 2], [cx, cy - 5], [cx + 3, cy - 2]])]];
    case 0x2193: return [['A', line([[cx, cy - 5], [cx, cy + 5]]) + line([[cx - 3, cy + 2], [cx, cy + 5], [cx + 3, cy + 2]])]];
    case 0x2713: return [['A', check]];
    case 0x2714: return [['E', check]];
    case 0x2715: case 0x2717: return [['A', cross]];
    case 0x2716: case 0x2718: return [['E', cross]];
    case 0x271a: return [['E', line([[cx, cy - 3.8], [cx, cy + 3.8]]) + line([[x0 + 1.2, cy], [x0 + 8.8, cy]])]];
    default: return null;
  }
}

// A character as shapes: a list of [kind, path]. null when it is left to the font.
function shapeOf(ch, x0, n) {
  if (ch.length > 2) return null;
  const cp = ch.codePointAt(0);
  if (cp >= 0x2580 && cp <= 0x259f) return blockShape(cp, x0, n);
  if (cp >= 0x2800 && cp <= 0x28ff) return brailleShape(cp, x0);
  return symbolShape(cp, x0);
}

// ---------------------------------------------------------------- one row -> markup

class Classes {
  constructor() {
    this.names = new Map(); // colour -> class name
    this.fills = new Set();
    this.strokes = new Set();
  }
  name(colour) {
    if (!this.names.has(colour)) {
      const i = this.names.size;
      this.names.set(colour, String.fromCharCode(97 + (i % 26)) + (i >= 26 ? Math.floor(i / 26).toString(36) : ''));
    }
    return this.names.get(colour);
  }
  fill(colour) {
    if (colour === DEFAULT_FG) return '';
    this.fills.add(colour);
    return this.name(colour);
  }
  stroke(colour) {
    if (colour === DEFAULT_FG) return '';
    this.strokes.add(colour);
    return '_' + this.name(colour);
  }
  css() {
    let s = '';
    for (const c of this.fills) s += `.${this.name(c)}{fill:${c}}`;
    for (const c of this.strokes) s += `._${this.name(c)}{stroke:${c}}`;
    return s;
  }
}
const classAttr = (list) => {
  const s = list.filter(Boolean).join(' ');
  return s ? ` class="${s}"` : '';
};
const isPlain = (cell) => cell && !cell.cont && cell.ch.length === 1 && cell.ch > ' ' && cell.ch <= '~';
const STROKED = new Set(['L', 'H', 'O', 'A', 'E', 'U']);

function renderRow(row, classes) {
  const cols = row.length;
  let out = '';

  // backgrounds: one path per colour
  const bgs = new Map();
  for (let x = 0; x < cols; ) {
    const bg = row[x].bg;
    let n = 1;
    while (x + n < cols && row[x + n].bg === bg) n++;
    if (bg) bgs.set(bg, (bgs.get(bg) ?? '') + rect(x * CW, 0, n * CW, CH));
    x += n;
  }
  for (const [bg, d] of bgs) out += `<path${classAttr(['X', classes.fill(bg)])} d="${d}"/>`;

  // shapes: one path per kind, colour and dimness
  const shapes = new Map();
  const addShape = (kind, fg, dim, d) => {
    if (!d) return;
    const key = `${kind}|${fg}|${dim ? 1 : 0}`;
    const cur = shapes.get(key);
    if (cur) cur.d += d;
    else shapes.set(key, { kind, fg, dim, d });
  };

  // underline and strike, drawn so that spaces carry them too
  for (let x = 0; x < cols; ) {
    const c = row[x];
    const marks = c.fl & (F_UL | F_STRIKE);
    if (!marks) { x++; continue; }
    let n = 1;
    while (x + n < cols && (row[x + n].fl & (F_UL | F_STRIKE)) === marks && row[x + n].fg === c.fg) n++;
    if (marks & F_UL) addShape('U', c.fg, false, `M${num(x * CW)} ${num(BASE + 2.5)}h${num(n * CW)}`);
    if (marks & F_STRIKE) addShape('U', c.fg, false, `M${num(x * CW)} ${num(CH / 2 + 0.5)}h${num(n * CW)}`);
    x += n;
  }

  // text
  let text = '';
  let run = null;
  const textClass = (fg, fl) => [classes.fill(fg), fl & F_BOLD ? 'B' : '', fl & F_DIM ? 'D' : '', fl & F_ITALIC ? 'I' : ''];
  const flush = () => {
    if (!run) return;
    const len = run.n > 1 ? ` textLength="${num(run.n * CW)}"` : '';
    text += `<text x="${num(run.x * CW)}" y="${BASE}"${classAttr(textClass(run.fg, run.fl))}${len}>${esc(run.s)}</text>`;
    run = null;
  };
  for (let x = 0; x < cols; x++) {
    const c = row[x];
    if (c.cont) continue;
    const style = c.fl & (F_BOLD | F_DIM | F_ITALIC);
    if (c.ch === ' ') {
      // one space stays inside a run when the same kind of text goes on after it
      const nx = row[x + 1];
      if (run && isPlain(nx) && nx.fg === run.fg && (nx.fl & (F_BOLD | F_DIM | F_ITALIC)) === run.fl) { run.s += ' '; run.n++; }
      else flush();
      continue;
    }
    if (isPlain(c)) {
      if (run && run.fg === c.fg && run.fl === style && run.x + run.n === x) { run.s += c.ch; run.n++; }
      else { flush(); run = { x, n: 1, s: c.ch, fg: c.fg, fl: style }; }
      continue;
    }
    flush();
    if (isLineChar(c.ch)) continue; // drawn with the frame's lines
    let n = 1;
    if (MERGE.has(c.ch)) {
      while (x + n < cols && row[x + n].ch === c.ch && row[x + n].fg === c.fg && (row[x + n].fl & F_DIM) === (c.fl & F_DIM)) n++;
    }
    const shape = shapeOf(c.ch, x * CW, n);
    if (shape) {
      for (const [kind, d] of shape) addShape(kind, c.fg, c.fl & F_DIM, d);
      x += n - 1;
      continue;
    }
    // any other character outside plain ASCII: alone, centred in its own cell
    text += `<text x="${num(x * CW + (c.w * CW) / 2)}" y="${BASE}"${classAttr([...textClass(c.fg, style), 'M'])}>${esc(c.ch)}</text>`;
  }
  flush();

  for (const { kind, fg, dim, d } of shapes.values()) {
    const colour = STROKED.has(kind[0]) ? classes.stroke(fg) : classes.fill(fg);
    out += `<path${classAttr([kind, colour, dim ? 'D' : ''])} d="${d}"/>`;
  }
  return out + text;
}

// ---------------------------------------------------------------- the picture

function buildSvg(story, grids, opt) {
  // opt.frames: which frames to draw (indexes). opt.animated: loop through them.
  const { cols, top, show } = story;
  const total = story.frames.length;
  const classes = new Classes();

  const screenW = cols * CW;
  const screenH = show * CH;
  const W = Math.round(screenW / (1 - 28 / opt.width)); // 14 px of padding each side once shown at opt.width
  const u = W / opt.width; // drawing units in one shown pixel
  const pad = (W - screenW) / 2;
  const ruleY = pad + screenH + 10 * u;
  const H = Math.round(ruleY + 34 * u);
  const shownH = Math.round(H / u);

  // rows, each written once
  const ids = new Map();
  const lineIds = new Map();
  let defs = '';
  const frameUses = [];
  for (const f of opt.frames) {
    let uses = '';
    for (let r = 0; r < show; r++) {
      const markup = renderRow(grids[f][top + r], classes);
      if (!markup) continue;
      if (!ids.has(markup)) {
        const id = 'r' + ids.size.toString(36);
        ids.set(markup, id);
        defs += `<g id="${id}">${markup}</g>\n`;
      }
      uses += `<use href="#${ids.get(markup)}"${r ? ` y="${r * CH}"` : ''}/>`;
    }
    // the frame's lines, on top of its rows; frames with the same lines share them
    const lines = new Lines();
    for (let r = 0; r < show; r++) {
      const row = grids[f][top + r];
      for (let x = 0; x < cols; x++) {
        const c = row[x];
        if (c.cont || !isLineChar(c.ch)) continue;
        let n = 1;
        if (MERGE.has(c.ch)) {
          while (x + n < cols && row[x + n].ch === c.ch && row[x + n].fg === c.fg && (row[x + n].fl & F_DIM) === (c.fl & F_DIM)) n++;
        }
        addLines(c.ch, x * CW, r * CH, n, (kind, piece) => lines.add(kind, c.fg, c.fl & F_DIM, piece));
        x += n - 1;
      }
    }
    const lineMarkup = lines.markup(classes);
    if (lineMarkup) {
      if (!lineIds.has(lineMarkup)) {
        const id = 'l' + lineIds.size.toString(36);
        lineIds.set(lineMarkup, id);
        defs += `<g id="${id}">${lineMarkup}</g>\n`;
      }
      uses += `<use href="#${lineIds.get(lineMarkup)}"/>`;
    }
    frameUses.push(uses);
  }

  const markX = (i) => W - pad - 4 * u - (total - 1 - i) * 12 * u;
  const markY = ruleY + 17 * u;
  let frames = '';
  opt.frames.forEach((f, k) => {
    const cls = opt.animated ? ` class="F F${k + 1}${f === story.still - 1 ? ' S' : ''}"` : '';
    frames +=
      `<g${cls}><g transform="translate(${num(pad)} ${num(pad)})" clip-path="url(#v)">${frameUses[k]}</g>` +
      `<text class="C" x="${num(pad + 2 * u)}" y="${num(ruleY + 22 * u)}">${esc(story.frames[f].caption)}</text>` +
      `<circle class="N" cx="${num(markX(f))}" cy="${num(markY)}" r="${num(3.2 * u)}"/></g>\n`;
  });
  let marks = '';
  for (let i = 0; i < total; i++) marks += `<circle class="G" cx="${num(markX(i))}" cy="${num(markY)}" r="${num(3.2 * u)}"/>`;

  let css =
    `text{font-family:${MONO};font-size:${FONT_SIZE}px;font-variant-ligatures:none;fill:${DEFAULT_FG}}` +
    `path{fill:${DEFAULT_FG}}` +
    `.B{font-weight:700}.D{opacity:.6}.I{font-style:italic}.M{text-anchor:middle}` +
    `.X{shape-rendering:crispEdges}.S1{fill-opacity:.28}.S2{fill-opacity:.5}.S3{fill-opacity:.75}` +
    `.L,.H,.O,.A,.E,.U,.Q{fill:none;stroke:${DEFAULT_FG}}` +
    `.L{stroke-width:${LIGHT}}.H{stroke-width:${HEAVY}}.U{stroke-width:1.1}.O{stroke-width:2.4;stroke-linecap:round}` +
    `.A{stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}.E{stroke-width:2.3;stroke-linecap:round;stroke-linejoin:round}` +
    `.Y2{stroke-dasharray:3 2;stroke-dashoffset:4}.Y3{stroke-dasharray:2 1.333;stroke-dashoffset:2.667}.Y4{stroke-dasharray:1.5 1;stroke-dashoffset:2}` +
    `.Z2{stroke-dasharray:6 4;stroke-dashoffset:8}.Z3{stroke-dasharray:4 2.667;stroke-dashoffset:5.333}.Z4{stroke-dasharray:3 2;stroke-dashoffset:4}` +
    classes.css() +
    `.C{font-family:${SANS};font-size:${num(14 * u)}px;font-weight:500;fill:${CAPTION}}` +
    `.Q{stroke:${RULE};stroke-width:${num(u)}}.G{fill:${MARK_OFF}}.N{fill:${MARK_ON}}`;

  let seconds = 0;
  if (opt.animated && opt.frames.length > 1) {
    // One frame shows at a time: frame k is visible from edge k to edge k+1 of the loop.
    const times = opt.frames.map((f) => story.frames[f].seconds);
    seconds = times.reduce((a, b) => a + b, 0);
    const edges = [0];
    let t = 0;
    for (const s of times) { t += s; edges.push(+((t / seconds) * 100).toFixed(4)); }
    edges[edges.length - 1] = 100;
    css += `\n.F{visibility:hidden;animation:${num(seconds)}s step-end infinite}.S{visibility:visible}`;
    opt.frames.forEach((f, k) => {
      const a = edges[k], b = edges[k + 1];
      let keys = '';
      if (a === 0) keys += `0%{visibility:visible}`;
      else keys += `0%{visibility:hidden}${a}%{visibility:visible}`;
      if (b === 100) keys += `100%{visibility:visible}`;
      else keys += `${b}%,100%{visibility:hidden}`;
      css += `\n.F${k + 1}{animation-name:k${k + 1}}@keyframes k${k + 1}{${keys}}`;
    });
    css += `\n@media (prefers-reduced-motion:reduce){.F{animation:none}}`;
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${opt.width}" height="${shownH}" role="img" aria-label="${escAttr(story.alt)}">\n` +
    `<title>${esc(story.alt)}</title>\n` +
    `<style>${css}\n</style>\n` +
    `<rect x="${num(u / 2)}" y="${num(u / 2)}" width="${num(W - u)}" height="${num(H - u)}" rx="${num(10 * u)}" fill="${CARD_BG}" stroke="${CARD_EDGE}" stroke-width="${num(u)}"/>\n` +
    `<defs><clipPath id="v"><rect width="${screenW}" height="${screenH}"/></clipPath>\n${defs}</defs>\n` +
    `<path class="Q" d="M${num(pad)} ${num(ruleY)}H${num(W - pad)}"/>${marks}\n` +
    frames +
    `</svg>\n`;
  return { svg, seconds, rows: ids.size };
}

// ---------------------------------------------------------------- the story

function readStory(dir) {
  let story;
  try {
    story = JSON.parse(readFileSync(join(dir, 'story.json'), 'utf8'));
  } catch (e) {
    fail(`cannot read ${join(dir, 'story.json')}: ${e.message}`);
  }
  const int = (k, min) => {
    if (!Number.isInteger(story[k]) || story[k] < min) fail(`story.json: "${k}" must be a whole number, ${min} or more`);
  };
  if (typeof story.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(story.slug)) fail('story.json: "slug" must be lower-case letters, digits and dashes');
  if (typeof story.alt !== 'string' || !story.alt.trim()) fail('story.json: "alt" is missing');
  int('cols', 1);
  int('rows', 1);
  story.top ??= 0;
  story.show ??= story.rows - story.top;
  story.still ??= 1;
  int('top', 0);
  int('show', 1);
  int('still', 1);
  if (story.top + story.show > story.rows) fail(`story.json: top ${story.top} + show ${story.show} is more than rows ${story.rows}`);
  if (!Array.isArray(story.frames) || !story.frames.length) fail('story.json: "frames" is empty');
  if (story.still > story.frames.length) fail(`story.json: still ${story.still} is more than the ${story.frames.length} frames`);
  story.frames.forEach((f, i) => {
    if (typeof f.file !== 'string') fail(`story.json: frame ${i + 1} has no "file"`);
    if (!(typeof f.seconds === 'number' && f.seconds > 0)) fail(`story.json: frame ${i + 1} needs "seconds" above 0`);
    if (typeof f.caption !== 'string') fail(`story.json: frame ${i + 1} has no "caption"`);
    if ([...f.caption].length > 60) warn(`frame ${i + 1}: the caption is ${[...f.caption].length} characters, more than 60`);
  });
  return story;
}

function main() {
  const args = process.argv.slice(2);
  const rest = [];
  let stills = null;
  let width = 830;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--stills') stills = args[++i];
    else if (args[i] === '--width') width = Number(args[++i]);
    else rest.push(args[i]);
  }
  if (rest.length !== 2 || (stills !== null && !stills) || !(width >= 200)) {
    process.stderr.write('usage: node render.mjs <story folder> <out.svg> [--stills <folder>] [--width <px>]\n');
    process.exit(2);
  }
  const [dir, outFile] = rest.map((p) => resolve(p));
  const story = readStory(dir);
  const grids = story.frames.map((f) => {
    let text;
    try {
      text = readFileSync(join(dir, f.file), 'utf8');
    } catch (e) {
      fail(`cannot read ${f.file}: ${e.message}`);
    }
    const grid = parseScreen(text, story.cols, story.rows, f.file);
    // the plain capture beside it should hold the same text
    const plain = join(dir, f.file.replace(/\.ansi$/, '.txt'));
    if (plain !== join(dir, f.file) && existsSync(plain)) {
      const want = readFileSync(plain, 'utf8').split('\n');
      const at = grid.findIndex((row, y) => row.map((c) => c.ch).join('').trimEnd() !== (want[y] ?? '').trimEnd());
      if (at >= 0) warn(`${f.file} and its .txt differ at line ${at + 1} (fine if the screen moved between the two captures)`);
    }
    return grid;
  });
  const all = story.frames.map((_, i) => i);
  const anim = buildSvg(story, grids, { frames: all, animated: true, width });
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, anim.svg);
  const kb = (Buffer.byteLength(anim.svg) / 1024).toFixed(1);
  process.stdout.write(`${story.slug}: ${all.length} frames, ${num(anim.seconds)} s, ${anim.rows} different rows, ${kb} KB\n`);
  if (stills) {
    const sdir = resolve(stills);
    mkdirSync(sdir, { recursive: true });
    for (const i of all) {
      const one = buildSvg(story, grids, { frames: [i], animated: false, width });
      writeFileSync(join(sdir, `${story.slug}-${String(i + 1).padStart(2, '0')}.svg`), one.svg);
    }
    process.stdout.write(`${story.slug}: ${all.length} stills\n`);
  }
}

main();
