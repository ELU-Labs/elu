// The one width of the app: how many terminal columns a text takes. Every place that
// measures, pads, cuts or wraps a row counts with it, and blessed draws by it
// (lib/terminal-cells.mjs), so a row is as wide on the screen as the app counted it.
//
// A character is what the terminal draws as one: a letter with the marks on it, or an emoji
// with its selector, skin tone, joined emoji or second flag letter. It takes two columns when
// it is East Asian wide or full width, or an emoji drawn as a picture; a mark alone takes none.

// Marks, joiners, selectors and format characters, which take no column of their own. A soft
// hyphen and the Arabic signs that stand before a number are drawn, so they count.
const MARK = String.raw`[[\p{Mn}\p{Me}\p{Cf}\u1160-\u11ff\ud7b0-\ud7ff\u2028\u2029]--[\u00ad\u0600-\u0605\u06dd\u070f\u0890\u0891\u08e2\u{110bd}\u{110cd}]]`;
const MARK_NOT_JOINER = String.raw`[${MARK}--[\u200d]]`;
// East Asian wide and full width (Unicode 16), and every emoji that shows as a picture by itself.
const WIDE = String.raw`[\u1100-\u115f\u2329\u232a\u2630-\u2637\u268a-\u268f\u2e80-\u303e\u3041-\u4dff\u4e00-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{16fe0}-\u{16fe4}\u{16ff0}-\u{16ff1}\u{17000}-\u{18cd5}\u{18d00}-\u{18d08}\u{1aff0}-\u{1b2fb}\u{1d300}-\u{1d356}\u{1d360}-\u{1d376}\u{1f200}-\u{1f2ff}\u{20000}-\u{2fffd}\u{30000}-\u{3fffd}\p{Emoji_Presentation}]`;
const PICTURE = String.raw`\p{Extended_Pictographic}(?:\p{EMod}|${MARK_NOT_JOINER})*`;
// One character: a control character alone, a flag, an emoji with what is joined to it, or
// any other character with its marks.
const UNIT = String.raw`[\x00-\x1f]|\p{RI}\p{RI}${MARK}*|${PICTURE}(?:\u200d${PICTURE})*${MARK}*|[^]${MARK}*`;
const EACH = new RegExp(UNIT, 'gv'), COUNT = new RegExp(UNIT, 'gv'), HEAD = new RegExp(UNIT, 'gv'), AT = new RegExp(UNIT, 'yv');
const IS_MARK = new RegExp(`^${MARK}`, 'v'), IS_WIDE = new RegExp(`^${WIDE}`, 'v');
// More than one code point, drawn as one picture: a flag, an emoji with its selector, a skin
// tone or a joined emoji, a digit in a keycap.
const PICTURED = /^(?:\p{RI}\p{RI}|\p{Extended_Pictographic}[^]*?(?:\ufe0f|\p{EMod}|\u200d\p{Extended_Pictographic})|[0-9#*]\ufe0f?\u20e3)/v;
// Text where every character is one column and stands alone: its length is its width.
const NARROW = String.raw`\x20-\x7e\xa0-\u02ff\u0370-\u0482\u048a-\u052f\u2010-\u2027\u2030-\u205e\u2190-\u22ff\u2500-\u25fc\u2713\u2717\u2800-\u28ff`;
const PLAIN = new RegExp(`^[${NARROW}]*$`);

const known = new Map();
// The columns of one code point standing alone.
function pointWidth(point, text) {
  if (point < 0x300) return point < 0x20 || point >= 0x7f && point < 0xa0 ? 0 : 1;
  if (point >= 0x4e00 && point <= 0x9fff || point >= 0xac00 && point <= 0xd7a3 || point >= 0x3041 && point <= 0x3096 || point >= 0x309b && point <= 0x30ff) return 2;
  let size = known.get(point);
  if (size === undefined) { size = IS_MARK.test(text) ? 0 : IS_WIDE.test(text) ? 2 : 1; known.set(point, size); }
  return size;
}
// The columns of one character, as units() gives them.
export function unitWidth(unit) {
  const point = unit.codePointAt(0), alone = pointWidth(point, unit);
  return unit.length > (point > 0xffff ? 2 : 1) && PICTURED.test(unit) ? 2 : alone;
}
// The characters of a text, in order.
export const units = text => String(text ?? '').match(EACH) ?? [];
// The character that starts at index (a boundary), or '' at the end.
export function unitAt(text, index) { AT.lastIndex = index; return AT.exec(text)?.[0] ?? ''; }
// The boundaries around index: where the character before it starts, and where the one at it
// starts (a place inside a character counts as that character's start). A character starts at
// every ASCII one, so the scan begins at the nearest before index.
function around(text, index) {
  let at = Math.min(index, text.length) - 1;
  while (at > 0 && text.charCodeAt(at) > 0x7f) at--;
  let before = at = Math.max(0, at);
  while (at < index) { const size = unitAt(text, at).length || 1; if (at + size > index) break; before = at; at += size; }
  return { before: at < index ? at : before, start: at };
}
export const unitBefore = (text, index) => index <= 0 ? 0 : around(text, index).before;
export const unitAfter = (text, index) => { if (index >= text.length) return text.length; const { start } = around(text, index); return start + (unitAt(text, start).length || 1); };

export function columns(value) {
  const text = String(value ?? '');
  if (PLAIN.test(text)) return text.length;
  let total = 0; COUNT.lastIndex = 0;
  for (let found; (found = COUNT.exec(text));) total += unitWidth(found[0]);
  return total;
}
// The longest start of the text that fits in width columns, ending between two characters.
export function head(value, width) {
  const text = String(value ?? '');
  if (width <= 0) return '';
  if (PLAIN.test(text.length <= width ? text : text.slice(0, width + 1))) return text.slice(0, width);
  let used = 0, end = 0; HEAD.lastIndex = 0;
  for (let found; (found = HEAD.exec(text));) { const size = unitWidth(found[0]); if (used + size > width) break; used += size; end += found[0].length; }
  return text.slice(0, end);
}
// The longest end of the text that fits in width columns.
export function tail(value, width) {
  const text = String(value ?? '');
  if (PLAIN.test(text)) return text.length <= width ? text : text.slice(text.length - Math.max(0, width));
  let used = 0, start = text.length;
  for (const unit of units(text).reverse()) { const size = unitWidth(unit); if (used + size > width) break; used += size; start -= unit.length; }
  return text.slice(start);
}
// The text when it fits in width columns, else its start and the mark (…), cut between characters.
export function cut(value, width, mark = '…') {
  const text = String(value ?? '');
  if (columns(text) <= width) return text;
  const room = width - columns(mark);
  return room < 0 ? head(mark, width) : head(text, room) + mark;
}
// The text with spaces after it, or before it, up to width columns.
export const padEnd = (value, width) => { const text = String(value ?? ''); return text + ' '.repeat(Math.max(0, width - columns(text))); };
export const padStart = (value, width) => { const text = String(value ?? ''); return ' '.repeat(Math.max(0, width - columns(text))) + text; };
// Whether every character of the text is one column and stands alone, and its source for a pattern.
export const isPlain = text => PLAIN.test(text);
export const NARROW_CLASS = NARROW;
// The columns a terminal that joins nothing gives a character: each code point by itself.
export function spread(unit) { let total = 0; for (const ch of unit) total += pointWidth(ch.codePointAt(0), ch); return total; }
export const isMark = ch => pointWidth(ch.codePointAt(0), ch) === 0 && ch.codePointAt(0) >= 0x300;
