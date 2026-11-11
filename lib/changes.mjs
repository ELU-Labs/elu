import blessed from 'blessed';
import { redact } from './publish.mjs';
import { ink, wrapText } from './terminal-visuals.mjs';

// The Changes view of a session: what taskPatch found, as rows to draw. Each row is one
// screen line that already fits the width, with the same tags the other views use.

// Plain ASCII is one column a character. Only other text needs the library's width table.
const ASCII = /^[\x20-\x7e]*$/;
const columns = value => ASCII.test(value) ? value.length : blessed.unicode.strWidth(value);
const count = value => Number(value ?? 0).toLocaleString('en-US');
const plural = (value, word) => `${count(value)} ${word}${value === 1 ? '' : 's'}`;

// File content and paths on screen. A control character becomes a visible sign, and the
// characters that reorder text become their code, so nothing reaches the terminal as a
// control. Known secrets are masked like everywhere else.
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
const sign = ch => { const code = ch.charCodeAt(0); return code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? '\u2421' : `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`; };
const safe = value => redact(String(value ?? '').replace(CONTROL, sign), Infinity);
// Text that went through safe() is painted as it is. Masking a piece of a line a second
// time could change its width after it was measured.
const paint = (text, tone, colour, bold = false) => ink(text, tone, colour, bold, { trusted: true });
// redact() masks a private key inside one text. A diff shows the key line by line, so the
// lines between its first and its last are masked here.
const KEY_START = /-----BEGIN [^-]*PRIVATE KEY-----/, KEY_END = /-----END [^-]*PRIVATE KEY-----/;
function masker() {
  let inside = false;
  return text => {
    if (inside) { if (KEY_END.test(text)) inside = false; return '[redacted]'; }
    const at = text.search(KEY_START);
    if (at >= 0 && !KEY_END.test(text.slice(at))) inside = true;
    return safe(text);
  };
}
// Tabs become spaces up to the next multiple of 4, counted from the start of the text.
function expandTabs(text) {
  if (!text.includes('\t')) return text;
  let out = '', used = 0;
  for (const part of text.split(/(\t)/)) {
    if (part === '\t') { const pad = 4 - used % 4; out += ' '.repeat(pad); used += pad; }
    else { out += part; used += columns(part); }
  }
  return out;
}
// Cuts a line of code into rows of at most `room` columns. Every character is kept, so the
// cut is by column and never by word. A mark that sits on a character stays with it.
function chop(text, room) {
  const out = [];
  if (ASCII.test(text)) {
    for (let at = 0; at < text.length; at += room) out.push(text.slice(at, at + room));
    return out.length ? out : [''];
  }
  let piece = '', used = 0;
  for (const ch of text) {
    const size = columns(ch);
    if (used + size > room && piece) { out.push(piece); piece = ''; used = 0; }
    piece += ch; used += size;
  }
  out.push(piece);
  return out;
}
function head(text, room) {
  let out = '', used = 0;
  for (const ch of text) { const size = columns(ch); if (used + size > room) break; out += ch; used += size; }
  return out;
}
function tail(text, room) {
  const chars = Array.from(text); let out = '', used = 0;
  for (let index = chars.length - 1; index >= 0; index--) { const size = columns(chars[index]); if (used + size > room) break; out = chars[index] + out; used += size; }
  return out;
}
const clip = (text, room) => columns(text) <= room ? text : `${head(text, Math.max(0, room - 1))}…`;
// A path that does not fit loses its middle and keeps the file name.
function clipPath(value, room) {
  if (columns(value) <= room) return value;
  const slash = value.lastIndexOf('/'), name = slash < 0 ? value : value.slice(slash), keep = room - 1 - columns(name);
  return slash > 0 && keep >= 1 ? `${head(value.slice(0, slash), keep)}…${name}` : `…${tail(value, Math.max(0, room - 1))}`;
}
// A rename reads `old → new`. When both do not fit, the shorter side keeps its length.
function renamed(from, to, room) {
  if (columns(from) + 3 + columns(to) <= room) return `${from} → ${to}`;
  let left = Math.floor((room - 3) / 2), right = room - 3 - left;
  if (columns(from) < left) { right += left - columns(from); left = columns(from); }
  else if (columns(to) < right) { left += right - columns(to); right = columns(to); }
  return `${clipPath(from, left)} → ${clipPath(to, right)}`;
}
const row = (text, kind, file = null) => ({ text, kind, file });
const notes = (text, width, colour, file = null, indent = '') => wrapText(safe(text), Math.max(8, width - columns(indent))).map(line => row(indent + paint(line, 'muted', colour), 'note', file));

// `BASE...BRANCH · 24 files changed · +2,468 −177`, then what a limit left out.
function summaryRows(changes, width, colour) {
  const total = (changes.files?.length ?? 0) + (changes.hiddenFiles ?? 0);
  if (!total) return [row(paint('No changes yet.', 'muted', colour), 'summary')];
  const base = /^[0-9a-f]{40,64}$/.test(changes.base ?? '') ? changes.base.slice(0, 8) : changes.base;
  const where = safe(base && changes.branch ? `${base}...${changes.branch}` : changes.branch ?? base ?? '');
  const files = `${plural(total, 'file')} changed`, plus = `+${count(changes.added)}`, minus = `−${count(changes.removed)}`;
  const room = width - columns(`${files} · ${plus} ${minus}`) - 3;
  const label = where && room >= 8 ? (columns(where) <= room ? where : `${head(where, Math.ceil((room - 1) / 2))}…${tail(where, Math.floor((room - 1) / 2))}`) : '';
  const fits = columns(`${files} · ${plus} ${minus}`) <= width;
  const rows = fits
    ? [row(`${label ? `${paint(label, 'muted', colour)}${paint(' · ', 'dim', colour)}` : ''}${paint(files, 'text', colour, true)}${paint(' · ', 'dim', colour)}${paint(plus, 'green', colour)} ${paint(minus, 'red', colour)}`, 'summary')]
    : wrapText(`${files} · ${plus} ${minus}`, width).map(line => row(paint(line, 'text', colour), 'summary'));
  if (changes.cut) {
    const left = [changes.hiddenFiles ? plural(changes.hiddenFiles, 'file') : '', changes.hiddenLines ? plural(changes.hiddenLines, 'changed line') : ''].filter(Boolean);
    const text = left.length ? `Not shown: ${left.join(' · ')}.` : 'Parts of some files are not shown. Each file says what is missing.';
    rows.push(...notes(`${text}${changes.uncounted ? ' The totals leave out new files that were not read in full.' : ''}`, width, colour));
  }
  return rows;
}
// `▾ src/coupon.mjs                +82 −1`: the fold marker, the path, the counts at the right edge.
function fileRow(file, index, width, colour, unfolded) {
  const word = file.status === 'added' ? 'new' : file.status === 'deleted' ? 'deleted' : '';
  const tally = file.binary ? 'binary' : `+${count(file.added)} −${count(file.removed)}`;
  // When the path has little room, the status word is the first thing to go.
  const status = word && width - 4 - columns(`${word}  ${tally}`) >= 16 ? word : '';
  const room = Math.max(1, width - 4 - columns(tally) - (status ? columns(status) + 2 : 0));
  const name = file.status === 'renamed' && file.from ? renamed(safe(file.from), safe(file.path), room) : clipPath(safe(file.path), room);
  const gap = ' '.repeat(Math.max(2, width - 2 - columns(name) - columns(tally) - (status ? columns(status) + 2 : 0)));
  const right = file.binary ? paint(tally, 'muted', colour) : `${paint(`+${count(file.added)}`, 'green', colour)} ${paint(`−${count(file.removed)}`, 'red', colour)}`;
  return row(`${paint(unfolded ? '▾' : '▸', 'muted', colour)} ${paint(name, 'text', colour, true)}${gap}${status ? `${paint(status, 'muted', colour)}  ` : ''}${right}`, 'file', index);
}
// Old number, new number, then +, - or a space, then the text. A long line goes on under
// its own text column, so nothing is cut.
function lineRows(file, index, width, colour) {
  const lines = file.hunks.flatMap(hunk => hunk.lines), mask = masker(), rows = [];
  const digits = String(lines.reduce((most, line) => Math.max(most, line.old ?? 0, line.now ?? 0), 0)).length;
  const indent = ' '.repeat(2 * digits + 4), room = Math.max(1, width - columns(indent));
  // A file with Windows line ends shows no mark for them. A file that mixes both shows each one.
  const windows = lines.some(line => line.text.endsWith('\r')) && lines.every(line => line.more || line.text.endsWith('\r'));
  for (const hunk of file.hunks) {
    rows.push(row(paint(clip(safe(hunk.header), width), 'muted', colour), 'hunk', index));
    for (const line of hunk.lines) {
      const tone = line.kind === 'add' ? 'green' : line.kind === 'del' ? 'red' : null, mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      const pieces = chop(expandTabs(mask(windows && line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text)), room);
      rows.push(row(`${paint(`${String(line.old ?? '').padStart(digits)} ${String(line.now ?? '').padStart(digits)}`, 'muted', colour)} ${paint(`${mark} ${pieces[0]}`, tone, colour)}`, line.kind, index));
      for (const piece of pieces.slice(1)) rows.push(row(indent + paint(piece, tone, colour), line.kind, index));
      if (line.more) rows.push(...notes(`… ${plural(line.more, 'more character')} not shown`, width, colour, index, indent));
      if (line.eol === false) rows.push(...notes('\\ No newline at end of file', width, colour, index, indent));
    }
  }
  return rows;
}
// The rows of the view, top to bottom: [{ text, kind, file }]. kind is summary, file, hunk,
// context, add, del, note or blank. file is the index of the row's file, null above the
// first one and on blank rows. open: a Set of the file indexes that are unfolded. Without
// it every file is open. A folded file is its header row alone.
export function changeRows(changes, width, colour = true, { open } = {}) {
  width = Math.max(1, Math.floor(width));
  const rows = summaryRows(changes ?? {}, width, colour);
  let spaced = true;
  for (const [index, file] of (changes?.files ?? []).entries()) {
    const unfolded = !open || open.has(index);
    if (spaced) rows.push(row('', 'blank'));
    rows.push(fileRow(file, index, width, colour, unfolded));
    spaced = unfolded;
    if (!unfolded) continue;
    // The header of a binary file already says so.
    const note = file.binary ? String(file.note ?? '').split(' · ').filter(part => part !== 'binary file').join(' · ') : file.note;
    if (note) rows.push(...notes(note, width, colour, index, '  '));
    rows.push(...lineRows(file, index, width, colour));
  }
  return rows;
}
// The label of the view's tab: `Changes 24`, or `Changes` when there are none.
export function changeSummary(changes) {
  const total = (changes?.files?.length ?? 0) + (changes?.hiddenFiles ?? 0);
  return total ? `Changes ${count(total)}` : 'Changes';
}
