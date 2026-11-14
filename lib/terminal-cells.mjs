import blessed from 'blessed';
import { columns, units, unitWidth, spread, isMark, NARROW_CLASS } from './width.mjs';

// Makes blessed draw every character as wide as the app counts it (lib/width.mjs).
//
// What blessed does by itself, with its fullUnicode screen option on (ELU always had it on):
// its width table (lib/unicode.js) is East Asian wide and full width as of 2015. An emoji is
// not in it, so blessed gave 🚀 one cell and the terminal drew it over two: the rest of the row
// moved a column right and the border left its column. blessed also skips cells that did not
// change by moving the cursor forward a counted number of columns; after an emoji that count
// was one short, so the next write landed in a cell the terminal had already covered, and
// "Launch notes: the uploader" became "Launchtnotes: the uplwader". An emoji made of several
// code points (a flag, a skin tone, a joined family) was laid out one cell per code point.
//
// What is done here, once, for every blessed screen in the process:
// - blessed measures with the app's width (strWidth, charWidth).
// - Where blessed marks its wide characters (the step that puts a second, empty cell after
//   each), every character of two columns gets that cell, by the app's width. The code points
//   that belong to one character go into its one cell: a mark as blessed already keeps marks,
//   and a joined emoji, a skin tone or a second flag letter under a stand-in code point that
//   blessed is told is a mark too. The stand-ins never leave the process.
// - When the screen is drawn, a character of two columns first clears its two cells, is
//   written, and the cursor is then put by column where the next cell starts. So the row
//   stays in its columns in a terminal that draws that character narrower or wider than the
//   app counts it, and no cell is written by a count that the terminal did not follow. The
//   cells such a terminal could have covered are written again, and the terminal does not
//   wrap while they are.
// blessed removes marks on iTerm2 (written when it could not draw them); that step is off,
// because it would take the selector out of ⚠️ and the joiner out of a family.
const unicode = blessed.unicode;
const STAND_INS = /[\u{f0000}-\u{10fffd}]/gu, HAS_STAND_IN = /[\udb80-\udbff]/;
const standIn = point => String.fromCodePoint(point < 0x10000 ? 0x100000 + point : 0xe0000 + point);
// The text of a screen cell, or of a row blessed laid out, as it was written: stand-ins back to their emoji.
export const cellText = text => HAS_STAND_IN.test(text) ? text.replace(STAND_INS, ch => { const point = ch.codePointAt(0); return String.fromCodePoint(point >= 0x100000 ? point - 0x100000 : point - 0xe0000); }) : text;
// One character as blessed takes it: its first code point, the rest as marks on it, and the cell for its second column.
function cellUnit(unit) {
  const size = unitWidth(unit);
  if (!size) return '';
  const first = String.fromCodePoint(unit.codePointAt(0));
  if (first.codePointAt(0) >= 0xf0000) return '\ufffd';
  let out = first;
  for (const ch of unit.slice(first.length)) {
    const point = ch.codePointAt(0), kept = isMark(ch) ? ch : point < 0x20000 ? standIn(point) : '';
    if (kept) { unicode.combining[kept.codePointAt(0)] = true; out += kept; }
  }
  return size === 2 ? `${out}\x03` : out;
}
// A run of text that is not all single narrow characters, with the character before it: a mark
// sits on that one. A brace and the end of a colour code never take a mark, so the tags and
// codes around a text stay whole.
const RUN = new RegExp(`(?:(?<!\\x1b\\[[\\d;]*)[${NARROW_CLASS.replace('\\x20-\\x7e', '\\x20-\\x7a\\x7c\\x7e')}])?[^\\n\\x1b${NARROW_CLASS}]+`, 'g');
const SPECIAL = new RegExp(`[^\\n\\x1b${NARROW_CLASS}]`);
export const cellContent = content => SPECIAL.test(content) ? content.replace(RUN, run => units(run).map(cellUnit).join('')) : content;

// The pattern blessed marks its wide characters with: here every character gets its cells.
class Cells extends RegExp { [Symbol.replace](text, value) { return value === '$1\x03' ? cellContent(text) : super[Symbol.replace](text, value); } }
unicode.chars.all = new Cells(unicode.chars.all.source, 'g');
unicode.chars.combining = /(?!)/g;
// blessed's own list of marks is from 2015: it lacks over a thousand, and holds a few that terminals
// draw in a column of their own (the Arabic signs before a number). The marks are the app's.
for (const point of Object.keys(unicode.combining)) delete unicode.combining[point];
unicode.strWidth = columns;
unicode.charWidth = (text, at = 0) => typeof text === 'number' ? columns(String.fromCodePoint(text)) : text.length <= at ? 0 : columns(String.fromCodePoint(text.codePointAt(at)));

const CSI = '\x1b[', FORWARD = `${CSI}C`;
const Screen = blessed.screen, draw = Screen.prototype.draw;
Screen.prototype.draw = function (start, end) {
  if (!this.fullUnicode) return draw.call(this, start, end);
  const undo = []; let wide = false;
  for (let y = start; y <= end; y++) {
    const line = this.lines[y], old = this.olines[y];
    if (!line || !old || !line.dirty && !(this.cursor.artificial && y === this.program.y)) continue;
    for (let x = 0; x < line.length; x++) {
      const cell = line[x], ch = cell[1];
      if (ch.length === 1 && ch !== '\x03' && ch < '\u1100') continue;
      const shown = ch === '\x03' ? ' ' : cellText(ch);
      if (ch === '\x03' || columns(shown) < 2) { if (shown !== ch) { undo.push(cell, ch); cell[1] = shown; } continue; }
      // No cell for its second column (the pane ends here, or something is drawn over it): a space.
      if (line[x + 1]?.[1] !== '\x03') { undo.push(cell, ch); cell[1] = ' '; continue; }
      const text = `  ${CSI}${x + 1}G${shown}${CSI}${x + 2}G`, next = line[x + 1];
      if (cell[0] !== old[x][0] || text !== old[x][1]) {
        wide = true;
        for (let over = x + 2, last = Math.min(line.length, x + spread(shown)); over < last; over++) old[over][1] = '\0';
      }
      undo.push(cell, ch, next, next[1]); cell[1] = text; next[1] = FORWARD; x++;
    }
  }
  if (!undo.length) return draw.call(this, start, end);
  const program = this.program, write = program._write;
  if (wide) program._write = function (text) { return write.call(this, `${CSI}?7l${text}${CSI}?7h`); };
  try { return draw.call(this, start, end); }
  finally {
    if (wide) { if (Object.hasOwn(program, '_write') && write === Object.getPrototypeOf(program)._write) delete program._write; else program._write = write; }
    for (let at = 0; at < undo.length; at += 2) undo[at][1] = undo[at + 1];
  }
};
