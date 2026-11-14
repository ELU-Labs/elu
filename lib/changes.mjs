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
// Cuts a line of code into rows of at most `room` columns; the rows after the first are
// `hang` columns shorter, as they go on under the line's own first character. A row ends
// after a space where one is in its second half, else after the last character there that
// is not part of a name, so a word is cut in two only when it is longer than half a row.
// Every character is kept: the rows joined are the line. A row costs its own length,
// whatever the line's, so one line of a megabyte is cut as fast as the same text in many.
const NAMED = /[\p{L}\p{N}\p{M}_$]/u, JOINED = /[\p{M}\u200d]/u;
function chop(text, room, hang = 0) {
  const out = [];
  for (let at = 0; at < text.length;) {
    const width = Math.max(1, out.length ? room - hang : room);
    // A character is at most two units of the text, and the marks on it are few.
    let piece = head(text.slice(at, at + width * 4 + 8), width) || String.fromCodePoint(text.codePointAt(at));
    if (at + piece.length < text.length) {
      const half = piece.length >> 1;
      let end = piece.lastIndexOf(' ') + 1;
      for (let index = piece.length - 1; end <= half && index >= half; index--) if (!NAMED.test(piece[index]) && !JOINED.test(piece[index + 1] ?? '')) end = index + 1;
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
const row = (text, kind, file = null) => ({ text, kind, file });
const notes = (text, width, colour, file = null, indent = '') => wrapText(safe(text), Math.max(8, width - columns(indent))).map(line => row(indent + paint(line, 'muted', colour), 'note', file));

// A record with no parts of its own is one branch: the session's folder.
const partsOf = changes => changes.parts?.length ? changes.parts : [{ branch: changes.branch ?? null, current: true, pull: null, compared: changes.compared ?? null, from: 0, files: changes.files?.length ?? 0, added: changes.added ?? 0, removed: changes.removed ?? 0, hiddenFiles: changes.hiddenFiles ?? 0 }];
// What every branch is compared with, when all of them say the same.
const sameGround = parts => parts[0]?.compared && parts.every(part => part.compared === parts[0].compared) ? parts[0].compared : null;
// `24 files changed · +2,468 −177 · compared with main as it was when this session started`:
// how much changed in all and what it is compared with, in words. What it is compared with
// goes on a row of its own when the two do not fit one. Then what a limit left out, and the
// one line that says where the session's own changes could not be told.
function summaryRows(changes, parts, width, colour) {
  const total = (changes.files?.length ?? 0) + (changes.hiddenFiles ?? 0);
  const said = changes.note ? wrapText(safe(changes.note), Math.max(8, width)).map(line => row(paint(line, 'text', colour), 'note')) : [];
  if (!total) return [row(paint('No changes yet.', 'muted', colour), 'summary'), ...said];
  const many = parts.length > 1, same = sameGround(parts), ground = same ? `${many ? 'each ' : ''}compared with ${safe(same)}` : '';
  const branches = many ? `${count(parts.length)} branches` : '', files = `${plural(total, 'file')} changed`, plus = `+${count(changes.added)}`, minus = `−${count(changes.removed)}`;
  const plain = `${branches ? `${branches} · ` : ''}${files} · ${plus} ${minus}`, dot = paint(' · ', 'dim', colour);
  const rows = [];
  if (columns(plain) > width) rows.push(...wrapText(plain, width).map(line => row(paint(line, 'text', colour), 'summary')));
  else {
    const counts = `${branches ? `${paint(branches, 'text', colour, true)}${dot}` : ''}${paint(files, 'text', colour, true)}${dot}${paint(plus, 'green', colour)} ${paint(minus, 'red', colour)}`;
    const beside = ground && columns(plain) + 3 + columns(ground) <= width;
    rows.push(row(beside ? `${counts}${dot}${paint(ground, 'muted', colour)}` : counts, 'summary'));
    if (ground && !beside) rows.push(...wrapText(ground, Math.max(8, width)).map(line => row(paint(line, 'muted', colour), 'summary')));
  }
  if (changes.cut) {
    const left = [changes.hiddenFiles ? plural(changes.hiddenFiles, 'file') : '', changes.hiddenLines ? plural(changes.hiddenLines, 'changed line') : ''].filter(Boolean);
    const text = left.length ? `Not shown: ${left.join(' · ')}.` : 'Parts of some files are not shown. Each file says what is missing.';
    rows.push(...notes(`${text}${changes.uncounted ? ' The totals leave out new files that were not read in full.' : ''}`, width, colour));
  }
  return [...rows, ...said];
}
// `fix/rounding · checked out · PR #14 · 3 files · +40 −5`: one branch of the session, with
// its pull request where one is known, and its own counts when there are several branches.
// The pull request's address follows where the row has room. Under it, what the branch is
// compared with, when the branches do not all say the same.
function branchRows(part, parts, width, colour) {
  const many = parts.length > 1, total = part.files + (part.hiddenFiles ?? 0), dot = paint(' · ', 'dim', colour);
  const name = safe(part.branch ?? 'no branch'), pull = part.pull ? `PR #${part.pull.number}` : '', link = part.pull?.url ? safe(part.pull.url) : '';
  const tail = [many && part.current ? 'checked out' : '', pull, many ? total ? `${plural(total, 'file')} · +${count(part.added)} −${count(part.removed)}` : 'no changes' : ''].filter(Boolean);
  const rest = tail.length ? ` · ${tail.join(' · ')}` : '', room = width - columns(rest);
  const rows = [];
  if (room < 8) rows.push(...wrapText(`${name}${rest}`, width).map(line => row(paint(line, 'text', colour), 'branch')));
  else {
    const shown = clip(name, room), fits = link && columns(shown) + columns(rest) + 3 + columns(link) <= width;
    const painted = [many && part.current ? paint('checked out', 'muted', colour) : '', pull ? paint(pull, 'blue', colour) : '', many ? total ? `${paint(plural(total, 'file'), 'text', colour)}${dot}${paint(`+${count(part.added)}`, 'green', colour)} ${paint(`−${count(part.removed)}`, 'red', colour)}` : paint('no changes', 'muted', colour) : ''].filter(Boolean);
    rows.push(row(`${paint(shown, 'text', colour, true)}${painted.map(text => `${dot}${text}`).join('')}${fits ? `${dot}${paint(link, 'muted', colour)}` : ''}`, 'branch'));
  }
  if (part.compared && !sameGround(parts)) rows.push(...notes(`compared with ${part.compared}`, width, colour));
  return rows;
}
// The widths of the two counts, so they stand in columns down the list: every + count ends
// in one column and every − count in another. `binary` stands in their place.
function tallyColumns(files) {
  let added = 0, removed = 0, binary = false;
  for (const file of files) {
    if (file.binary) { binary = true; continue; }
    added = Math.max(added, count(file.added).length + 1); removed = Math.max(removed, count(file.removed).length + 1);
  }
  return { added, removed, tally: Math.max(added || removed ? added + 1 + removed : 0, binary ? 6 : 0) };
}
// `▾ src/coupon.mjs        new   +82  −1`: the fold marker, the path, then what happened to
// the file (new, deleted, renamed from its old path) and its counts in their columns at the
// right edge. label: the name to show in place of the path, under a row that names its folder.
// A file with no line changed says what did change in place of its counts, such as that it
// now runs as a program. Answers the row, and whether it said the file's note.
function fileRow(file, index, width, colour, unfolded, cols, label = null, indent = '') {
  const shown = label ?? safe(file.path), free = width - columns(indent) - 4 - cols.tally;
  let state = file.status === 'added' ? 'new' : file.status === 'deleted' ? 'deleted' : file.status === 'renamed' && file.from ? 'renamed' : '';
  let noted = !state && !file.binary && !file.added && !file.removed && Boolean(file.note);
  if (noted) state = safe(file.note);
  // When the path has little room, what happened to the file is the first thing to go.
  if (state && free - columns(state) - 2 < Math.min(16, columns(shown))) { state = ''; noted = false; }
  if (state === 'renamed') {
    // The old path is said whole when it fits beside the new one, and with its middle left out otherwise.
    const from = safe(file.from), room = free - 2 - Math.min(columns(shown), Math.max(16, free >> 1)) - 13;
    if (room >= columns(from)) state = `renamed from ${from}`; else if (room >= 10) state = `renamed from ${clipPath(from, room)}`;
  }
  const name = clipPath(shown, Math.max(1, free - (state ? columns(state) + 2 : 0)));
  const gap = ' '.repeat(Math.max(2, width - columns(indent) - 2 - columns(name) - (state ? columns(state) + 2 : 0) - cols.tally));
  const plus = `+${count(file.added)}`, minus = `−${count(file.removed)}`;
  const right = noted ? ' '.repeat(cols.tally) : file.binary ? paint('binary'.padStart(cols.tally), 'muted', colour) : `${' '.repeat(Math.max(0, cols.tally - 1 - cols.removed - plus.length))}${paint(plus, 'green', colour)} ${' '.repeat(Math.max(0, cols.removed - minus.length))}${paint(minus, 'red', colour)}`;
  return { noted, row: row(`${indent}${paint(unfolded ? '▾' : '▸', 'muted', colour)} ${paint(name, 'text', colour, true)}${gap}${state ? `${paint(state, 'muted', colour)}  ` : ''}${right}`, 'file', index) };
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
// Which words changed inside a changed line. A removed line and an added line are a pair
// when they stand in one run of changed lines and share enough of their words: each line
// goes with the one most like it, as a reader pairs them. Inside a pair the words that
// differ are marked, and a line with nothing in common with any other has no marks.
const WORDS = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
const PAIRED = 0.3, NEAR = 8, CELLS = 4000000;
// The words of a line with how often each stands in it, and how long they are together.
function bag(text) {
  const words = new Map(); let size = 0;
  for (const word of text.match(WORDS) ?? []) { if (!word.trim()) continue; words.set(word, (words.get(word) ?? 0) + 1); size += word.length; }
  return { words, size };
}
// How much of two lines is the same, from 0 to 1, whatever the order of their words.
function alike(one, two) {
  if (!one.size || !two.size) return 0;
  const [few, more] = one.words.size <= two.words.size ? [one, two] : [two, one];
  let shared = 0;
  for (const [word, times] of few.words) shared += Math.min(times, more.words.get(word) ?? 0) * word.length;
  return 2 * shared / (one.size + two.size);
}
// The parts of two lines that differ, as [start, end) places in each: the words outside
// their longest run of shared words. null where they share too little to be read as one line
// changed. left: how much comparing is still paid for; past it only the two ends are compared.
function differing(old, now, left) {
  const a = old.match(WORDS) ?? [], b = now.match(WORDS) ?? [];
  let head = 0, tail = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.length - head - tail, y = b.length - head - tail, same = [new Uint8Array(a.length), new Uint8Array(b.length)];
  for (let at = 0; at < head; at++) same[0][at] = same[1][at] = 1;
  for (let at = 1; at <= tail; at++) same[0][a.length - at] = same[1][b.length - at] = 1;
  if (x && y && x * y <= left.cells) {
    left.cells -= x * y;
    // The most the two middles share, found from their ends back. A word counts by its
    // length and a space for little, so of two ways to line them up the one that keeps the
    // longer words wins.
    const wide = y + 1, table = new Uint32Array((x + 1) * wide), worth = word => word.trim() ? 2 * word.length : 1;
    for (let i = x - 1; i >= 0; i--) for (let j = y - 1; j >= 0; j--) table[i * wide + j] = a[head + i] === b[head + j] ? table[(i + 1) * wide + j + 1] + worth(a[head + i]) : Math.max(table[(i + 1) * wide + j], table[i * wide + j + 1]);
    for (let i = 0, j = 0; i < x && j < y;) {
      if (a[head + i] === b[head + j]) { same[0][head + i++] = same[1][head + j++] = 1; }
      else if (table[(i + 1) * wide + j] >= table[i * wide + j + 1]) i++; else j++;
    }
  }
  let shared = 0, all = 0;
  for (const [side, words] of [a, b].entries()) for (const [at, word] of words.entries()) if (word.trim()) { all += word.length; if (same[side][at]) shared += word.length; }
  if (!all || shared / all < PAIRED) return null;
  return [a, b].map((words, side) => {
    const text = side ? now : old, out = []; let at = 0, open = null;
    // A mark that holds a word does not start or end with a space.
    const close = end => { const part = text.slice(open, end), bare = part.trim(); out.push(bare ? [open + part.indexOf(bare), open + part.indexOf(bare) + bare.length] : [open, end]); open = null; };
    for (const [index, word] of words.entries()) {
      // A space between two words that changed is part of the change.
      const kept = same[side][index] && !(open !== null && !word.trim() && index + 1 < words.length && !same[side][index + 1]);
      if (!kept) open ??= at; else if (open !== null) close(at);
      at += word.length;
    }
    if (open !== null) close(at);
    return out;
  });
}
// For one hunk: the marks of each line that has some, by the line's place in the hunk. The
// texts are the lines as they are shown. A run of many lines pairs each one with those near
// its own place in the other half, so a large change costs no more for each line than a small one.
function wordMarks(lines, texts) {
  const marks = new Map(), left = { cells: CELLS };
  for (let at = 0; at < lines.length;) {
    if (lines[at].kind !== 'del') { at++; continue; }
    let mid = at; while (mid < lines.length && lines[mid].kind === 'del') mid++;
    let end = mid; while (end < lines.length && lines[end].kind === 'add') end++;
    const gone = mid - at, come = end - mid;
    if (come) {
      const bags = texts.slice(at, end).map(bag), found = [];
      for (let i = 0; i < gone; i++) {
        const centre = gone * come <= 256 ? null : Math.round(i * (come - 1) / Math.max(1, gone - 1));
        for (let j = centre === null ? 0 : Math.max(0, centre - NEAR); j < (centre === null ? come : Math.min(come, centre + NEAR + 1)); j++) {
          const score = alike(bags[i], bags[gone + j]);
          if (score >= PAIRED) found.push([score, i, j]);
        }
      }
      // The most alike first; of two as alike, the pair whose lines stand nearer each other.
      found.sort((one, two) => two[0] - one[0] || Math.abs(one[1] - one[2]) - Math.abs(two[1] - two[2]) || one[1] - two[1]);
      const used = [new Set(), new Set()];
      for (const [, i, j] of found) {
        if (used[0].has(i) || used[1].has(j)) continue;
        used[0].add(i); used[1].add(j);
        const parts = texts[at + i] === texts[mid + j] ? null : differing(texts[at + i], texts[mid + j], left);
        if (parts?.[0].length) marks.set(at + i, parts[0]);
        if (parts?.[1].length) marks.set(mid + j, parts[1]);
      }
    }
    at = Math.max(end, at + 1);
  }
  return marks;
}
// The changed words stand out by more than colour: bold and underlined, in a lighter shade
// of the line's own colour where there is colour.
const STRONG = { green: 121, red: 217 };
const stress = (text, tone, colour) => `${colour ? `{${STRONG[tone]}-fg}` : ''}{bold}{underline}${ink(text, '', false, false, { trusted: true })}{/underline}{/bold}${colour ? '{/}' : ''}`;
// One row of a line: `lead` (the sign) and the text from `from`, the marked parts stressed.
function linePiece(lead, piece, from, marks, tone, colour) {
  const end = from + piece.length, inside = (marks ?? []).filter(([start, stop]) => start < end && stop > from);
  if (!inside.length) return paint(lead + piece, tone, colour);
  let out = '', at = from;
  for (const [start, stop] of inside) {
    const first = Math.max(start, from), last = Math.min(stop, end);
    if (first > at || lead && at === from) out += paint((at === from ? lead : '') + piece.slice(at - from, first - from), tone, colour);
    out += stress(piece.slice(first - from, last - from), tone, colour); at = last;
  }
  return at < end ? out + paint(piece.slice(at - from), tone, colour) : out;
}
// Old number, new number, then +, - or a space, then the text: added lines green, removed
// lines red, the lines around them dimmer than both. A long line goes on under its own
// first character, so the numbers and the signs keep a column to themselves and nothing is cut.
// The words that changed inside a changed line are marked (wordMarks), on every row it takes.
const MARKS = new WeakMap();
function lineRows(file, index, width, colour) {
  const lines = file.hunks.flatMap(hunk => hunk.lines), mask = masker(), rows = [];
  const digits = String(lines.reduce((most, line) => Math.max(most, line.old ?? 0, line.now ?? 0), 0)).length;
  const indent = ' '.repeat(2 * digits + 4), room = Math.max(1, width - columns(indent));
  // A file with Windows line ends shows no mark for them. A file that mixes both shows each one.
  const windows = lines.some(line => line.text.endsWith('\r')) && lines.every(line => line.more || line.text.endsWith('\r'));
  for (const hunk of file.hunks) {
    rows.push(hunkRow(file, hunk, index, width, colour));
    const texts = hunk.lines.map(line => expandTabs(mask(windows && line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text)));
    // The marks depend on the text alone, so they are found once for a hunk, whatever the width.
    let marks = MARKS.get(hunk);
    if (!marks) { marks = wordMarks(hunk.lines, texts); MARKS.set(hunk, marks); }
    for (const [place, line] of hunk.lines.entries()) {
      const tone = line.kind === 'add' ? 'green' : line.kind === 'del' ? 'red' : 'muted', mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      const text = texts[place], marked = marks.get(place);
      // The rows after the first start under the line's first character, in at most half the room.
      const hang = Math.min(text.length - text.trimStart().length, room >> 1), under = indent + ' '.repeat(hang), pieces = chop(text, room, hang);
      rows.push(row(`${paint(`${String(line.old ?? '').padStart(digits)} ${String(line.now ?? '').padStart(digits)}`, 'dim', colour)} ${linePiece(`${mark} `, pieces[0], 0, marked, tone, colour)}`, line.kind, index));
      for (let at = 1, from = pieces[0].length; at < pieces.length; from += pieces[at++].length) rows.push(row(under + linePiece('', pieces[at], from, marked, tone, colour), line.kind, index));
      if (line.more) rows.push(...notes(`… ${plural(line.more, 'more character')} not shown`, width, colour, index, indent));
      if (line.eol === false) rows.push(...notes('no line break at the end of the file', width, colour, index, indent));
    }
  }
  return rows;
}
// More files than this on one branch are listed under the folders they are in.
const GROUPED = 10;
const folderOf = file => { const at = file.path.lastIndexOf('/'); return at < 0 ? '' : file.path.slice(0, at + 1); };
// Names in the order a reader expects: letter by letter, and a number inside a name by its
// value, so order-2 stands before order-10.
const runs = name => name.match(/\d+|\D+/g) ?? [];
function byName(one, two) {
  for (let at = 0; at < one.length && at < two.length; at++) {
    const a = one[at], b = two[at];
    if (a === b) continue;
    if (a.charCodeAt(0) < 58 && a.charCodeAt(0) > 47 && b.charCodeAt(0) < 58 && b.charCodeAt(0) > 47) {
      const x = a.replace(/^0+(?=\d)/, ''), y = b.replace(/^0+(?=\d)/, '');
      if (x.length !== y.length) return x.length - y.length;
      if (x !== y) return x < y ? -1 : 1;
      return a.length - b.length;
    }
    return a < b ? -1 : 1;
  }
  return one.length - two.length;
}
// The files of one branch in the order they are listed: as they came, or, when there are
// many, folder by folder, the files of the project's own folder first.
function listed(files, part) {
  const order = Array.from({ length: part.files }, (_, at) => part.from + at);
  if (part.files <= GROUPED) return { order, grouped: false };
  const folders = order.map(at => folderOf(files[at])), names = new Map(order.map((at, place) => [at, [runs(folders[place]), runs(files[at].path)]]));
  return { order: order.sort((one, two) => byName(names.get(one)[0], names.get(two)[0]) || byName(names.get(one)[1], names.get(two)[1]) || one - two), grouped: true };
}
// What marks a file apart from every other in the record: its branch and its path.
export const fileKey = file => `${file?.branch ?? ''}\0${file?.path ?? ''}`;
// The rows of the view, top to bottom: [{ text, kind, file }]. kind is summary, branch,
// folder, file, hunk, context, add, del, note or blank. file is the index of the row's file,
// null above the first one and on the rows that belong to none. open: a Set of the file
// indexes that are unfolded. Without it every file is open. A folded file is its header row
// alone. Each branch of the session has a row of its own when there are several, or when
// its pull request is known.
export function changeRows(changes, width, colour = true, { open } = {}) {
  width = Math.max(1, Math.floor(width));
  const record = changes ?? {}, files = record.files ?? [], parts = partsOf(record), titled = parts.length > 1 || Boolean(parts[0]?.pull);
  const rows = summaryRows(record, parts, width, colour), cols = tallyColumns(files);
  let spaced = true;
  for (const part of parts) {
    if (titled && (files.length || parts.length > 1)) { rows.push(row('', 'blank'), ...branchRows(part, parts, width, colour)); spaced = false; }
    const { order, grouped } = listed(files, part);
    let folder = null;
    for (const index of order) {
      const file = files[index], unfolded = !open || open.has(index), inside = grouped ? folderOf(file) : '';
      if (grouped && inside !== folder) {
        folder = inside;
        if (inside) { if (spaced) rows.push(row('', 'blank')); rows.push(row(paint(clipPath(safe(inside), width), 'muted', colour), 'folder')); spaced = false; }
      }
      if (spaced) rows.push(row('', 'blank'));
      const header = fileRow(file, index, width, colour, unfolded, cols, inside ? safe(file.path.slice(inside.length)) : null, inside ? '  ' : '');
      rows.push(header.row);
      spaced = unfolded;
      if (!unfolded) continue;
      // The header of a binary file already says so, as does one that said the file's note.
      const note = header.noted ? '' : file.binary ? String(file.note ?? '').split(' · ').filter(part => part !== 'binary file').join(' · ') : file.note;
      if (note) rows.push(...notes(note, width, colour, index, '  '));
      rows.push(...lineRows(file, index, width, colour));
    }
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
