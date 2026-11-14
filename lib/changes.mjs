import fs from 'node:fs';
import path from 'node:path';
import { redact } from './publish.mjs';
import { ink, wrapText } from './terminal-visuals.mjs';
import { atomic, isObject, noSymlinks, readJson } from './util.mjs';
import { taskDir } from './state.mjs';
import { columns, head, tail, unitAfter, unitAt, unitBefore } from './width.mjs';

// The Changes view of a session: what taskPatch found, as rows to draw. Each row is one
// screen line that already fits the width, with the same tags the other views use.

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
// Cuts a line of code into rows of at most `room` columns; the rows after the first are
// `hang` columns shorter, as they go on under the line's own first character. A row ends
// after a space where one is in its second half, else after the last character there that
// is not part of a name, so a word is cut in two only when it is longer than half a row.
// Every character is kept: the rows joined are the line. A mark that sits on a character
// stays with it, and so does what an emoji is joined with. A row costs its own length,
// whatever the line's, so one line of a megabyte is cut as fast as the same text in many.
const NAMED = /[\p{L}\p{N}\p{M}_$]/u;
// Whether a character starts at index: a row never ends inside one.
const starts = (text, index) => index >= text.length || text.charCodeAt(index) < 0x80 || unitAfter(text, unitBefore(text, index)) === index;
function chop(text, room, hang = 0) {
  const out = [];
  for (let at = 0; at < text.length;) {
    const width = Math.max(1, out.length ? room - hang : room);
    // A character is mostly at most two units of the text, and the marks on it are few. Where
    // joined emoji make it longer, more of the line is read, so none of them is cut in two.
    let piece = '';
    for (let span = width * 4 + 8; ; span *= 2) {
      piece = head(text.slice(at, at + span), width);
      if (piece.length < span || at + span >= text.length) break;
    }
    // A character wider than the row has a row to itself.
    if (!piece) piece = unitAt(text, at) || String.fromCodePoint(text.codePointAt(at));
    if (at + piece.length < text.length) {
      const half = piece.length >> 1;
      let end = piece.lastIndexOf(' ') + 1;
      for (let index = piece.length - 1; end <= half && index >= half; index--) if (!NAMED.test(piece[index]) && starts(piece, index + 1)) end = index + 1;
      if (end > half) piece = piece.slice(0, end);
    }
    out.push(piece); at += piece.length;
  }
  return out.length ? out : [''];
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
const row = (text, kind, file = null, line = null) => line ? { text, kind, file, line } : { text, kind, file };
const notes = (text, width, colour, file = null, indent = '') => wrapText(safe(text), Math.max(8, width - columns(indent))).map(line => row(indent + paint(line, 'muted', colour), 'note', file));

// `BASE...BRANCH · 24 files changed · +2,468 −177`, then what a limit left out, then how
// line notes work when the view takes them. Notes that wait say how they are sent, also
// when no change is left to show.
function summaryRows(changes, width, colour, marks = null) {
  const total = (changes.files?.length ?? 0) + (changes.hiddenFiles ?? 0);
  const waiting = marks?.size ? notes(marks.size === 1 ? '1 note. s sends it to the model.' : `${plural(marks.size, 'note')}. s sends them to the model together.`, width, colour) : null;
  if (!total) return [row(paint('No changes yet.', 'muted', colour), 'summary'), ...(waiting ?? [])];
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
  if (marks) rows.push(...(waiting ?? notes('+ beside a line notes what should change. Notes go to the model together.', width, colour)));
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
// Where a hunk is, in words: the file, the line of its first change, then what Git names
// around it, such as the function. `@@ -642,9 +642,15 @@ function total(cart) {` reads
// `src/cart.mjs · line 645 · function total(cart) {`. A path that does not fit keeps its
// file name, and the function gives way before it.
const PLACE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/;
function hunkRow(file, hunk, index, width, colour) {
  const at = PLACE.exec(hunk.header), first = hunk.lines.find(line => line.kind !== 'context') ?? hunk.lines[0], number = first?.now ?? first?.old;
  const place = at ? number ? `line ${number}` : '' : safe(hunk.header), around = at ? safe(at[1]).trim() : '', taken = place ? 3 + columns(place) : 0;
  const path = safe(file.path), name = path.slice(path.lastIndexOf('/') + 1);
  // The path has what the place and 24 columns of the function leave, and at least its file name.
  const short = clipPath(path, Math.max(1, width - taken - (around ? 3 + Math.min(columns(around), 24) : 0), Math.min(columns(name) + 2, width - taken)));
  const where = place && columns(short) + taken <= width ? `${short} · ${place}` : clipPath(path, width), left = width - columns(where) - 3;
  return row(`${paint(where, 'blue', colour)}${around && left >= 8 ? paint(` · ${clip(around, left)}`, 'muted', colour) : ''}`, 'hunk', index);
}
// Old number, new number, then +, - or a space, then the text: added lines green, removed
// lines red, the lines around them dimmer than both. A long line goes on under its own
// first character, so the numbers and the signs keep a column to themselves and nothing is cut.
// A line's rows carry it as `line`, and its note shows under it.
function lineRows(file, index, width, colour, marks = null) {
  const lines = file.hunks.flatMap(hunk => hunk.lines), mask = masker(), rows = [];
  const digits = String(lines.reduce((most, line) => Math.max(most, line.old ?? 0, line.now ?? 0), 0)).length;
  const indent = ' '.repeat(2 * digits + 4), room = Math.max(1, width - columns(indent));
  // A file with Windows line ends shows no mark for them. A file that mixes both shows each one.
  const windows = lines.some(line => line.text.endsWith('\r')) && lines.every(line => line.more || line.text.endsWith('\r'));
  for (const hunk of file.hunks) {
    rows.push(hunkRow(file, hunk, index, width, colour));
    for (const line of hunk.lines) {
      const tone = line.kind === 'add' ? 'green' : line.kind === 'del' ? 'red' : 'muted', mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      const shown = expandTabs(mask(windows && line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text));
      // The rows after the first start under the line's first character, in at most half the room.
      const hang = Math.min(shown.length - shown.trimStart().length, room >> 1), under = indent + ' '.repeat(hang), pieces = chop(shown, room, hang);
      const at = { path: file.path, kind: line.kind, old: line.old ?? null, now: line.now ?? null, text: shown };
      rows.push(row(`${paint(`${String(line.old ?? '').padStart(digits)} ${String(line.now ?? '').padStart(digits)}`, 'dim', colour)} ${paint(`${mark} ${pieces[0]}`, tone, colour)}`, line.kind, index, at));
      for (const piece of pieces.slice(1)) rows.push(row(under + paint(piece, tone, colour), line.kind, index, at));
      if (line.more) rows.push(...notes(`… ${plural(line.more, 'more character')} not shown`, width, colour, index, indent));
      if (line.eol === false) rows.push(...notes('\\ No newline at end of file', width, colour, index, indent));
      // A note shows under the line it was written on. Once that line reads differently, it shows above.
      const kept = marks?.get(noteKey(at)), said = sameLine(kept, at) ? kept.note : null;
      if (said) for (const piece of wrapText(safe(said), Math.max(8, room - 2))) rows.push(row(indent + paint(`✎ ${piece}`, 'orange', colour), 'mark', index, at));
    }
  }
  return rows;
}
// The rows of the view, top to bottom: [{ text, kind, file, line? }]. kind is summary, file,
// hunk, context, add, del, note, mark (a line's note) or blank. file is the index of the
// row's file, null above the first one and on blank rows. A changed or context line's rows
// carry it as line: { path, kind, old, now, text }. open: a Set of the file indexes that are
// unfolded. Without it every file is open. A folded file is its header row alone. notes: the
// line notes, a Map from noteKey(line) to { ...line, note }; with it the summary says how
// notes work and each note shows under its line.
export function changeRows(changes, width, colour = true, { open, notes: marks = null } = {}) {
  width = Math.max(1, Math.floor(width));
  const rows = summaryRows(changes ?? {}, width, colour, (changes?.files?.length ?? 0) || marks?.size ? marks : null);
  // A note whose line the model has changed since shows here, with the line as it was.
  for (const item of lostNotes(changes, marks)) {
    for (const piece of wrapText(safe(`${item.path}, ${whereOf(item)} has changed since this note. It was: ${item.text.trim()}`), Math.max(8, width))) rows.push(row(paint(piece, 'muted', colour), 'mark', null, item));
    for (const piece of wrapText(safe(item.note), Math.max(8, width - 2))) rows.push(row(paint(`✎ ${piece}`, 'orange', colour), 'mark', null, item));
  }
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
    rows.push(...lineRows(file, index, width, colour, marks));
  }
  return rows;
}
// The changes in a few words, where they are only named: `7 files · +76 −5`.
export function changeCounts(changes, colour = true) {
  const total = (changes?.files?.length ?? 0) + (changes?.hiddenFiles ?? 0);
  return `${paint(plural(total, 'file'), 'text', colour)}${paint(' · ', 'dim', colour)}${paint(`+${count(changes?.added)}`, 'green', colour)} ${paint(`−${count(changes?.removed)}`, 'red', colour)}`;
}
// The label of the view's tab: `Changes 24`, or `Changes` when there are none.
export function changeSummary(changes) {
  const total = (changes?.files?.length ?? 0) + (changes?.hiddenFiles ?? 0);
  return total ? `Changes ${count(total)}` : 'Changes';
}
// A line note is kept by its file and its two numbers, so it stays on its line while the
// rows are drawn again.
export const noteKey = line => `${line.path}\0${line.old ?? ''}\0${line.now ?? ''}`;
const whereOf = item => item.kind === 'del' ? `removed line ${item.old}` : `line ${item.now ?? item.old}`;
// A file's lines as the view names them: masked, tabs as spaces, no Windows line end.
function namedLines(file) {
  const lines = file.hunks.flatMap(hunk => hunk.lines), mask = masker();
  const windows = lines.some(line => line.text.endsWith('\r')) && lines.every(line => line.more || line.text.endsWith('\r'));
  return lines.map(line => ({ path: file.path, kind: line.kind, old: line.old ?? null, now: line.now ?? null, text: expandTabs(mask(windows && line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text)) }));
}
const sameLine = (line, item) => Boolean(line) && line.kind === item.kind && line.text === item.text;
// The notes whose line is no longer in the changes as it was noted: the model changed it since.
export function lostNotes(changes, notes) {
  if (!notes?.size) return [];
  const live = new Map((changes?.files ?? []).flatMap(namedLines).map(line => [noteKey(line), line]));
  return [...notes.values()].filter(item => !sameLine(live.get(noteKey(item)), item));
}
// After the changes were read again: a note whose line only moved (the same text, once in
// its file, with no note of its own) goes with it. Says whether a note moved.
export function placeNotes(changes, notes) {
  let moved = false;
  for (const item of lostNotes(changes, notes)) {
    const same = (changes.files ?? []).filter(file => file.path === item.path).flatMap(namedLines).filter(line => sameLine(line, item));
    if (same.length !== 1 || notes.has(noteKey(same[0]))) continue;
    notes.delete(noteKey(item)); notes.set(noteKey(same[0]), { ...same[0], note: item.note }); moved = true;
  }
  return moved;
}
// Line notes are kept beside the session record, so they are still there when ELU starts again.
const notesFile = (repo, id) => path.join(taskDir(repo, id), 'line-notes.json');
const whole = value => Number.isInteger(value) ? value : null;
export function readNotes(repo, id) {
  try {
    const file = notesFile(repo, id); noSymlinks(file);
    const rows = fs.existsSync(file) ? readJson(file)?.notes : [];
    const kept = (Array.isArray(rows) ? rows : []).filter(item => isObject(item) && typeof item.path === 'string' && typeof item.text === 'string' && typeof item.note === 'string' && item.note.trim());
    return new Map(kept.map(item => ({ path: item.path, kind: ['add', 'del'].includes(item.kind) ? item.kind : 'context', old: whole(item.old), now: whole(item.now), text: item.text, note: item.note })).map(item => [noteKey(item), item]));
  } catch { return new Map(); }
}
export function saveNotes(repo, id, notes) {
  const file = notesFile(repo, id);
  if (notes.size) atomic(file, { version: 1, notes: [...notes.values()] });
  else { noSymlinks(file); fs.rmSync(file, { force: true }); }
}
// The one message the notes go in, file by file and line by line.
// changes: what the session changed now. A note whose line has changed since goes with the
// line as it was, and says so, so the model can find where it belongs.
export function notesMessage(notes, changes = null) {
  const list = [...(notes?.values() ?? [])].filter(item => String(item.note ?? '').trim());
  if (!list.length) return '';
  list.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : (a.now ?? a.old ?? 0) - (b.now ?? b.old ?? 0) || (a.kind === 'del' ? 0 : 1) - (b.kind === 'del' ? 0 : 1));
  const lost = new Set(changes ? lostNotes(changes, notes) : []);
  return [`Notes on your changes. Change what each one asks:`, ...list.flatMap(item => ['', `${item.path}, ${whereOf(item)}${lost.has(item) ? ' as it was when I wrote this note (it has changed since)' : ''}: ${item.text.trim()}`, String(item.note).trim()])].join('\n');
}
