import blessed from 'blessed';

// A cursor for the message box: arrows, word and line moves, and a click that puts the cursor
// where you clicked. blessed's textarea only appends at the end.

const CONTROL = /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g;
const charAt = (value, index) => String.fromCodePoint(value.codePointAt(index));
const before = (value, index) => index >= 2 && /[\udc00-\udfff]/.test(value[index - 1]) && /[\ud800-\udbff]/.test(value[index - 2]) ? index - 2 : Math.max(0, index - 1);
const after = (value, index) => Math.min(value.length, index + (index < value.length ? charAt(value, index).length : 0));
const defaultWidth = ch => ch === '\t' ? 4 : Math.max(0, blessed.unicode.charWidth(ch, 0));
const widthOf = (text, charWidth) => { let total = 0; for (const ch of text) total += charWidth(ch); return total; };

// Rows of the value at this width. Each row shows value.slice(start, end); next is where the
// following row starts: end + 1 after a newline or a space that would not fit, else end.
export function layout(value, width, charWidth = defaultWidth) {
  width = Math.max(1, width);
  const rows = []; let start = 0, col = 0, space = -1, index = 0;
  while (index < value.length) {
    const ch = charAt(value, index);
    if (ch === '\n') { rows.push({ start, end: index, next: index + 1 }); start = index + 1; col = 0; space = -1; index++; continue; }
    const size = charWidth(ch);
    if (col + size > width && index > start) {
      if (ch === ' ') { rows.push({ start, end: index, next: index + 1 }); start = index + 1; col = 0; space = -1; index++; continue; }
      const cut = space >= start ? space + 1 : index;
      rows.push({ start, end: cut, next: cut }); start = cut; space = -1; col = widthOf(value.slice(start, index), charWidth);
      continue;
    }
    if (ch === ' ') space = index;
    col += size; index += ch.length;
  }
  rows.push({ start, end: value.length, next: value.length });
  return rows;
}
// The row and column the cursor shows at. At a soft wrap it shows at the start of the next row.
export function position(value, rows, index, charWidth = defaultWidth) {
  for (let row = 0; row < rows.length; row++) {
    const r = rows[row];
    if (index < r.start) continue;
    if (index < r.end || row === rows.length - 1 || index === r.end && r.next > r.end) return { row, col: widthOf(value.slice(r.start, Math.min(index, r.end)), charWidth) };
  }
  return { row: 0, col: 0 };
}
// The index at a row and column: the boundary at or before that column.
export function indexAt(value, rows, row, col, charWidth = defaultWidth) {
  const r = rows[Math.max(0, Math.min(rows.length - 1, row))];
  let index = r.start, used = 0;
  while (index < r.end) { const ch = charAt(value, index), size = charWidth(ch); if (used + size > col) break; used += size; index += ch.length; }
  return index;
}
const lineStart = (value, index) => value.lastIndexOf('\n', index - 1) + 1;
const lineEnd = (value, index) => { const end = value.indexOf('\n', index); return end < 0 ? value.length : end; };
const word = ch => /[\p{L}\p{N}_]/u.test(ch);
function wordBefore(value, index) {
  while (index > 0 && !word(charAt(value, before(value, index)))) index = before(value, index);
  while (index > 0 && word(charAt(value, before(value, index)))) index = before(value, index);
  return index;
}
function wordAfter(value, index) {
  while (index < value.length && !word(charAt(value, index))) index = after(value, index);
  while (index < value.length && word(charAt(value, index))) index = after(value, index);
  return index;
}

// The text a key types, or '' for one that types nothing.
function typedText(ch, key) {
  if (['enter', 'return', 'escape', 'tab'].includes(key.name) && key.sequence !== '\n') return '';
  return key.name === 'enter' ? '\n' : typeof ch === 'string' ? ch.replace(CONTROL, '') : '';
}
// The keys that move the cursor; with Shift they highlight as they go.
const MOVES = ['left', 'right', 'up', 'down', 'home', 'end'];

// One key on the editor state { value, cursor, goal }. Returns the next state, or null when the
// key is not an edit (Enter, Escape and Tab stay with the caller).
export function editKey(state, ch, key = {}, view = {}) {
  const { value, cursor } = state, name = key.name;
  const rows = view.rows ?? layout(value, view.width ?? 80, view.charWidth), charWidth = view.charWidth ?? defaultWidth;
  const at = (next, goal = null) => ({ value, cursor: Math.max(0, Math.min(value.length, next)), goal });
  const cut = (from, to) => ({ value: value.slice(0, from) + value.slice(to), cursor: from, goal: null });
  const vertical = step => {
    const here = position(value, rows, cursor, charWidth), goal = state.goal ?? here.col, row = here.row + step;
    if (row < 0) return at(0, goal);
    if (row >= rows.length) return at(value.length, goal);
    return at(indexAt(value, rows, row, goal, charWidth), goal);
  };
  if (key.meta && (name === 'b' || name === 'left') || key.ctrl && name === 'left') return at(wordBefore(value, cursor));
  if (key.meta && (name === 'f' || name === 'right') || key.ctrl && name === 'right') return at(wordAfter(value, cursor));
  if (key.meta && name === 'backspace' || key.ctrl && name === 'w') return cut(wordBefore(value, cursor), cursor);
  if (key.meta && name === 'd') return cut(cursor, wordAfter(value, cursor));
  if (name === 'left' || key.ctrl && name === 'b') return at(before(value, cursor));
  if (name === 'right' || key.ctrl && name === 'f') return at(after(value, cursor));
  if (name === 'up' || key.ctrl && name === 'p') return vertical(-1);
  if (name === 'down' || key.ctrl && name === 'n') return vertical(1);
  if (name === 'home' || key.ctrl && name === 'a') return at(lineStart(value, cursor));
  if (name === 'end' || key.ctrl && name === 'e') return at(lineEnd(value, cursor));
  if (name === 'backspace') return cut(before(value, cursor), cursor);
  if (name === 'delete' || key.ctrl && name === 'd') return cut(cursor, after(value, cursor));
  if (key.ctrl && name === 'u') return cut(lineStart(value, cursor), cursor);
  if (key.ctrl && name === 'k') { const end = lineEnd(value, cursor); return cut(cursor, end === cursor ? after(value, cursor) : end); }
  if (['enter', 'return', 'escape', 'tab'].includes(name) && key.sequence !== '\n') return null;
  const text = typedText(ch, key);
  if (!text || key.ctrl || key.meta) return key.ctrl || key.meta ? state : null;
  return { value: value.slice(0, cursor) + text + value.slice(cursor), cursor: cursor + text.length, goal: null };
}

// Gives a blessed textarea the cursor: its own wrapping, scrolling that follows the cursor,
// the terminal cursor at that spot, and a click that moves it there.
// With field.selection and field.highlight (the app's highlight, lib/selection.mjs), Shift and
// the arrows highlight text from the cursor, and typing, Backspace or Delete replace it.
export function editable(field) {
  const screen = field.screen;
  const charWidth = ch => ch === '\t' ? screen.tabc.length : Math.max(0, blessed.unicode.charWidth(ch, 0));
  field.cursor = field.value.length; field.goal = null;
  // mark: where a highlight made with the keys began; the cursor is its other end.
  field.mark = null;
  let laid = null;
  // The view a drag past the box's edge scrolled to (scrollView). It stays until the cursor
  // moves or the text changes; until then the view does not go back to the cursor.
  let scrolled = null;
  // blessed wraps a textarea one column short, leaving room for the cursor; rows here match it.
  const width = () => Math.max(1, field.width - field.iwidth - 1 - (field.scrollbar ? 1 : 0));
  const rows = () => {
    const w = width();
    if (laid?.value !== field.value || laid.width !== w) laid = { value: field.value, width: w, rows: layout(field.value, w, charWidth) };
    return laid.rows;
  };
  field.editorView = () => ({ rows: rows(), width: width(), charWidth });
  // Typing keeps the cursor; a value set from outside puts it at the end.
  field.setValue = function(value) {
    if (value != null && value !== this.value) { this.cursor = value.length; this.goal = null; }
    if (value != null) this.value = value;
    this.cursor = Math.max(0, Math.min(this.cursor, this.value.length));
    const list = rows(), content = list.map(row => this.value.slice(row.start, row.end)).join('\n');
    if (this._editorContent !== content) { this._editorContent = content; this.setContent(content); }
    const height = Math.max(1, this.height - this.iheight), row = position(this.value, list, this.cursor, charWidth).row;
    let base = this.childBase || 0;
    if (!scrolled || scrolled.value !== this.value || scrolled.cursor !== this.cursor || scrolled.base !== base) {
      scrolled = null;
      if (row < base) base = row; else if (row >= base + height) base = row - height + 1;
    }
    this.childBase = Math.max(0, Math.min(base, Math.max(0, list.length - height))); this.childOffset = 0;
    this._updateCursor();
  };
  field.clearValue = field.clearInput = function() { return this.setValue(''); };
  // Scrolls the view lines rows down (up when negative) as far as the text goes, leaving the
  // cursor and the text as they are. Returns whether it moved.
  field.scrollView = function(lines) {
    const height = Math.max(1, this.height - this.iheight), base = this.childBase || 0;
    const next = Math.max(0, Math.min(Math.max(0, rows().length - height), base + lines));
    if (next === base) return false;
    this.childBase = next; this.childOffset = 0; scrolled = { value: this.value, cursor: this.cursor, base: next };
    return true;
  };
  field._updateCursor = function(get) {
    if (screen.focused !== this) return;
    const lpos = get ? this.lpos : this._getCoords(); if (!lpos) return;
    const { row, col } = position(this.value, rows(), this.cursor, charWidth), program = screen.program;
    const y = lpos.yi + this.itop + Math.max(0, Math.min(row - (this.childBase || 0), lpos.yl - lpos.yi - this.iheight - 1));
    const x = Math.min(lpos.xl - 1, lpos.xi + this.ileft + col);
    if (y !== program.y || x !== program.x) program.cup(y, x);
  };
  // With text highlighted in the box, Backspace or Delete removes it, typing or a paste takes
  // its place, and Left or Right goes to its start or end. Shift and an arrow, Home or End
  // highlight from the cursor, or move the end of the highlight there is. field.selection
  // gives the highlighted cells { from, to, by } in the field, or null; field.highlight(from, to)
  // highlights from one cell to another, and highlight(null) ends it.
  field._listener = function(ch, key = {}) {
    if (key.name === 'escape') return this._done?.(null, null);
    // Ctrl-C copies the highlight (the app's key) and changes nothing here: the highlight and
    // where it began stay, so typing next replaces it.
    if (key.ctrl && !key.meta && key.name === 'c') return;
    const range = field.selection?.(), keyed = range?.by === KEYS && this.mark !== null, span = range ? spanOf(range) : null;
    if (key.shift && MOVES.includes(key.name) && typeof field.highlight === 'function') {
      // From the highlight there is, the end the cursor is at moves; one made by the mouse runs forward.
      const mark = keyed ? this.mark : span ? span[0] : this.cursor, from = keyed ? this.cursor : span ? span[1] : this.cursor;
      const moved = editKey({ value: this.value, cursor: from, goal: keyed || !span ? this.goal : null }, ch, { ...key, shift: false }, field.editorView());
      this.mark = mark; this.cursor = moved.cursor; this.goal = moved.goal;
      this.setValue(); show(mark, this.cursor); screen.render(); return;
    }
    this.mark = null;
    const plain = !key.ctrl && !key.meta, state = { value: this.value, cursor: this.cursor, goal: this.goal };
    let next;
    if (span && plain && ['backspace', 'delete'].includes(key.name)) next = cut(span);
    else if (span && plain && ['left', 'right'].includes(key.name)) next = { value: this.value, cursor: span[key.name === 'left' ? 0 : 1], goal: null };
    else next = editKey(span && plain && !MOVES.includes(key.name) && typedText(ch, key) ? cut(span) : state, ch, key, field.editorView());
    if (span && next && next.value !== this.value) field.highlight?.(null);
    if (!next) return;
    const changed = next.value !== this.value || next.cursor !== this.cursor;
    this.value = next.value; this.cursor = next.cursor; this.goal = next.goal;
    if (changed) { this.setValue(); screen.render(); }
  };
  // The text between two screen cells, for copying a selection.
  const cellIndex = (x, y, lpos = field.lpos) => {
    if (!lpos) return 0;
    return indexAt(field.value, rows(), y - lpos.yi - field.itop + (field.childBase || 0), Math.max(0, x - lpos.xi - field.ileft), charWidth);
  };
  const cellRange = (from, to) => { const a = cellIndex(from.x, from.y), b = cellIndex(to.x + 1, to.y); return [Math.min(a, b), Math.max(a, b)]; };
  // The highlighted text as [start, end) in the value: from the mark to the cursor for one made
  // with the keys, else the cells it covers.
  const KEYS = 'keys';
  const spanOf = range => range.by === KEYS && field.mark !== null ? [Math.min(field.mark, field.cursor), Math.max(field.mark, field.cursor)] : cellRange(range.from, range.to);
  field.selectText = (from, to) => { const [a, b] = spanOf({ from, to, by: field.selection?.()?.by }); return field.value.slice(a, b); };
  const cut = ([a, b]) => ({ value: field.value.slice(0, a) + field.value.slice(b), cursor: a, goal: null });
  // Highlights value[a, b), on rows out of view too, from the cell of a to the cell before b.
  const show = (a, b) => {
    const lpos = field.lpos;
    if (a === b || !lpos) { field.highlight(null); return; }
    const list = rows(), [start, end] = [Math.min(a, b), Math.max(a, b)].map(index => position(field.value, list, index, charWidth));
    const x0 = lpos.xi + field.ileft, y0 = lpos.yi + field.itop - (field.childBase || 0);
    field.highlight({ x: x0 + start.col, y: y0 + start.row }, { x: x0 + end.col - 1, y: y0 + end.row }, KEYS);
  };
  // A click puts the cursor at that character; past a wrapped row's end it stays on that row.
  field.on('click', data => {
    if (data.button !== 'left' || !field.lpos) return;
    const list = rows(), row = Math.max(0, Math.min(list.length - 1, data.y - field.lpos.yi - field.itop + (field.childBase || 0)));
    let index = cellIndex(data.x, data.y);
    if (index === list[row].end && list[row].next === list[row].end && index > list[row].start && row < list.length - 1) index = before(field.value, index);
    field.cursor = index; field.goal = null;
    if (screen.focused !== field) field.focus();
    if (!field._reading) field.readInput?.();
    field.setValue(); screen.render();
  });
  return field;
}
