// Git's patch text read into files, hunks and lines for the Changes view. Nothing here runs
// Git, opens a file or draws: callers hand in the text and the bytes, so every command can
// load this without the terminal library.

// What one view holds at most. More than this is counted and said, never dropped in silence.
export const LIMITS = Object.freeze({ files: 300, fileLines: 2000, lines: 20000, lineChars: 2000, previewBytes: 64000 });
const OPEN = Object.freeze({ files: Infinity, fileLines: Infinity, lines: Infinity, lineChars: Infinity, previewBytes: Infinity });
const count = value => value.toLocaleString('en-US');
const blank = name => ({ path: name, from: null, status: 'modified', binary: false, added: 0, removed: 0, hunks: [], hidden: 0, kept: 0, keep: true, notes: [] });

// Git writes a path with unusual bytes inside double quotes, with C escapes and octal bytes.
const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
function unquote(value) {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const parts = [];
  for (const [, octal, escaped, plain] of value.slice(1, -1).matchAll(/\\([0-7]{1,3})|\\([\s\S])|([^\\]+)/g)) {
    parts.push(octal !== undefined ? Buffer.from([parseInt(octal, 8) & 255]) : escaped !== undefined ? Buffer.from([ESCAPES[escaped] ?? escaped.charCodeAt(0)]) : Buffer.from(plain));
  }
  return Buffer.concat(parts).toString('utf8');
}
const strip = (name, prefix) => name.startsWith(prefix) ? name.slice(prefix.length) : name;
// `diff --git a/NAME b/NAME`: the two names are equal unless the file was renamed, and a
// rename has lines of its own. So a name with spaces is found by cutting the rest in half.
function headerPath(rest) {
  if (rest.startsWith('"')) {
    let end = 1;
    while (end < rest.length && rest[end] !== '"') end += rest[end] === '\\' ? 2 : 1;
    return strip(unquote(rest.slice(0, end + 1)), 'a/');
  }
  const half = (rest.length - 1) / 2, one = rest.slice(0, half), two = rest.slice(half + 1);
  if (Number.isInteger(half) && rest[half] === ' ') {
    if (one.startsWith('a/') && two.startsWith('b/') && one.slice(2) === two.slice(2)) return one.slice(2);
    if (one === two) return one;
  }
  const at = rest.search(/ "?b\//);
  return strip(at > 0 ? rest.slice(0, at) : rest, 'a/');
}
// The name on a `---` or `+++` line. Git ends it with a tab when the name holds a space.
function labelPath(value, prefix) {
  const name = unquote(value.replace(/\t$/, ''));
  return name === '/dev/null' ? null : strip(name, prefix);
}
// The lines between a file's first line and its first hunk.
function header(file, row) {
  let match;
  if (row.startsWith('--- ')) { const name = labelPath(row.slice(4), 'a/'); if (name === null) file.status = 'added'; else if (file.status !== 'renamed') file.path = name; }
  else if (row.startsWith('+++ ')) { const name = labelPath(row.slice(4), 'b/'); if (name === null) file.status = 'deleted'; else file.path = name; }
  else if (row.startsWith('rename from ')) { file.from = unquote(row.slice(12)); file.status = 'renamed'; }
  else if (row.startsWith('rename to ')) { file.path = unquote(row.slice(10)); file.status = 'renamed'; }
  else if (row.startsWith('copy to ')) { file.path = unquote(row.slice(8)); file.status = 'added'; }
  else if ((match = /^new file mode (\d+)$/.exec(row))) { file.status = 'added'; file.mode = match[1]; }
  else if ((match = /^deleted file mode (\d+)$/.exec(row))) { file.status = 'deleted'; file.mode = match[1]; }
  else if ((match = /^old mode (\d+)$/.exec(row))) file.oldMode = match[1];
  else if ((match = /^new mode (\d+)$/.exec(row))) file.newMode = match[1];
  else if ((match = /^index [0-9a-f]+\.\.[0-9a-f]+ (\d+)$/.exec(row))) file.mode ??= match[1];
  else if (row.startsWith('Binary files ') || row === 'GIT binary patch') file.binary = true;
}
// A very long line keeps its start. `more` says how many characters were left out.
function clipLine(line, body, max, file) {
  if (body.length <= max) { line.text = body; return line; }
  const end = /[\ud800-\udbff]/.test(body[max - 1]) ? max - 1 : max;
  line.text = body.slice(0, end); line.more = body.length - end; file.clipped = true;
  return line;
}
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
// One pass over the patch. A hunk's own counts say how many lines belong to it, so a removed
// line that reads `-- a/name` is never taken for a file header. Every line is counted, also
// the ones past a limit, so the totals stay right when only part is kept.
function scan(text, limits) {
  const rows = String(text ?? '').split('\n');
  if (rows.at(-1) === '') rows.pop();
  const files = [], sum = { added: 0, removed: 0, hiddenFiles: 0, shown: 0, changed: 0 };
  let file = null, hunk = null, last = null, left = 0, right = 0, old = 0, now = 0;
  const close = () => {
    if (!file) return;
    sum.added += file.added; sum.removed += file.removed;
    if (file.keep) files.push(file); else sum.hiddenFiles++;
    file = hunk = last = null; left = right = 0;
  };
  for (const row of rows) {
    if (left > 0 || right > 0) {
      // Git may write an empty context line with no leading space.
      const mark = row[0] ?? ' ';
      if (mark === '\\') { if (last) last.eol = false; continue; }
      if (mark === ' ' || mark === '+' || mark === '-') {
        const kind = mark === '+' ? 'add' : mark === '-' ? 'del' : 'context';
        if (kind === 'add') file.added++; else if (kind === 'del') file.removed++;
        if (file.keep && file.kept < limits.fileLines && sum.shown < limits.lines) {
          last = clipLine({ kind, old: kind === 'add' ? null : old, now: kind === 'del' ? null : now, text: '' }, row.slice(1), limits.lineChars, file);
          if (!hunk.lines.length) file.hunks.push(hunk);
          hunk.lines.push(last); file.kept++; sum.shown++;
          if (kind !== 'context') sum.changed++;
        } else { last = null; file.hidden++; }
        if (kind !== 'add') { old++; left--; }
        if (kind !== 'del') { now++; right--; }
        continue;
      }
      // The hunk stopped early, as in a patch that was cut short.
      left = right = 0;
    }
    if (/^diff --(?:git|cc|combined) /.test(row)) {
      close();
      const plain = row.startsWith('diff --git ');
      file = { ...blank(plain ? headerPath(row.slice(11)) : unquote(row.slice(row.indexOf(' ', 7) + 1))), keep: files.length < limits.files, combined: !plain };
      continue;
    }
    if (!file) continue;
    if (row[0] === '\\') { if (last) last.eol = false; continue; }
    const at = HUNK.exec(row);
    if (at) {
      hunk = { header: row, lines: [] }; last = null; file.body = true;
      old = Number(at[1]); now = Number(at[3]); left = at[2] === undefined ? 1 : Number(at[2]); right = at[4] === undefined ? 1 : Number(at[4]);
    } else if (!file.body) header(file, row);
  }
  close();
  return { files, sum };
}
// The record a view gets: the working fields go, the notes become one line.
function seal(file) {
  const notes = [...file.notes];
  if (file.combined) notes.push('merge conflict, not shown');
  if (file.binary) notes.push('binary file');
  if (file.mode === '120000') notes.push('symbolic link'); else if (file.mode === '160000') notes.push('submodule');
  if (file.oldMode && file.newMode) notes.push(`mode ${file.oldMode} → ${file.newMode}`);
  if (!notes.length && file.status !== 'modified' && file.status !== 'renamed' && !file.added && !file.removed) notes.push('empty file');
  if (file.hidden) notes.push(`${count(file.hidden)} more line${file.hidden === 1 ? '' : 's'} not shown`);
  return { path: file.path, from: file.status === 'renamed' ? file.from : null, status: file.status, binary: file.binary, added: file.added, removed: file.removed, hunks: file.hunks, note: notes.join(' · ') || null, hidden: file.hidden };
}
// Unified `git diff` output as a list of files:
// { path, from, status, binary, added, removed, hunks: [{ header, lines: [{ kind, old, now, text }] }], note, hidden }.
// status is modified, added, deleted or renamed, and from is the old path of a rename. A line's
// kind is context, add or del, with its old and new line numbers (null on the side it is not
// on). eol: false marks a last line with no newline.
export function parseDiff(text) { return scan(text, OPEN).files.map(seal); }

// `git diff --raw --numstat -z`: first each file's kind of change, then its added and
// removed counts. A rename carries two paths in both.
const KINDS = { A: 'added', C: 'added', D: 'deleted', R: 'renamed' };
function numstat(text) {
  const out = [], kinds = new Map(), parts = String(text ?? '').split('\0');
  for (let index = 0; index < parts.length; index++) {
    const raw = /^:\d+ \d+ [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(parts[index]);
    if (raw) { index += raw[1] === 'R' || raw[1] === 'C' ? 2 : 1; kinds.set(parts[index], raw[1]); continue; }
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(parts[index]);
    if (!match) continue;
    const moved = match[3] === '', name = moved ? parts[index + 2] ?? '' : match[3], status = KINDS[kinds.get(name)] ?? (moved ? 'renamed' : 'modified');
    out.push({ path: name, from: status === 'renamed' && moved ? parts[index + 1] : null, status, binary: match[1] === '-', added: Number(match[1]) || 0, removed: Number(match[2]) || 0 });
    if (moved) index += 2;
  }
  return out;
}
function lineCount(bytes) {
  let total = 0;
  for (let at = bytes.indexOf(10); at >= 0; at = bytes.indexOf(10, at + 1)) total++;
  return total + (bytes.length && bytes.at(-1) !== 10 ? 1 : 0);
}
// A file Git does not track yet: every line is an added line. room: lines left in the view.
function newFile(name, { bytes = null, size = 0, note = null }, limits, room) {
  const file = { ...blank(name), status: 'added' };
  if (note || !bytes) { file.notes.push(note ?? 'could not be read'); return file; }
  if (bytes.includes(0)) { file.binary = true; return file; }
  const whole = bytes.length >= size, start = bytes.subarray(0, Math.min(bytes.length, limits.previewBytes)), part = start.length < size;
  let text = start.toString('utf8');
  // A preview that stops inside a line leaves that line out.
  if (part && text.includes('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1);
  const rows = text.split('\n'), open = rows.at(-1) !== '';
  if (!open) rows.pop();
  const total = whole ? lineCount(bytes) : rows.length;
  const lines = rows.slice(0, Math.max(0, Math.min(limits.fileLines, room))).map((row, index) => clipLine({ kind: 'add', old: null, now: index + 1, text: '' }, row, limits.lineChars, file));
  if (open && !part && lines.length === rows.length && lines.length) lines.at(-1).eol = false;
  if (lines.length) file.hunks.push({ header: `@@ -0,0 +${total === 1 ? '1' : `1,${total}`} @@`, lines });
  if (part) { file.notes.push(`preview cut at ${count(limits.previewBytes)} bytes`); file.clipped = true; }
  // Past the part that was read, the lines of a very large file are not counted.
  if (!whole) file.uncounted = true;
  file.added = total; file.kept = lines.length; file.hidden = Math.max(0, total - lines.length);
  return file;
}
// Everything one session changed: { base, branch, files, added, removed, cut, hiddenFiles,
// hiddenLines, uncounted }. added and removed count every line, shown or not. cut is true
// when a limit left something out: hiddenFiles files, hiddenLines changed lines.
// patch: the `git diff` text. counts: Git's own list and totals (`--raw --numstat -z`),
// given only when the patch arrived cut short. untracked: paths of new files, read one by one through
// read(path), which answers { bytes, size } (the start of the file, all of it when the two
// agree), { note } for a path that must not be opened, or null for one that is gone.
export function buildChanges({ base = null, branch = null, patch = '', counts = null, untracked = [], read = () => null } = {}, limits = LIMITS) {
  const short = counts !== null, text = String(patch ?? '');
  const { files, sum } = scan(short ? text.slice(0, text.lastIndexOf('\n') + 1) : text, limits);
  let uncounted = false;
  if (short) {
    const known = numstat(counts), seen = new Map(files.map(file => [file.path, file]));
    sum.added = sum.removed = 0;
    for (const row of known) {
      sum.added += row.added; sum.removed += row.removed;
      let file = seen.get(row.path);
      if (!file) {
        if (files.length >= limits.files) continue;
        file = { ...blank(row.path), from: row.from, status: row.status, binary: row.binary };
        files.push(file);
      }
      file.hidden += Math.max(0, row.added + row.removed - file.added - file.removed);
      file.added = row.added; file.removed = row.removed;
    }
    sum.hiddenFiles = Math.max(0, known.length - files.length);
  }
  for (const name of untracked) {
    // A new file past the limit is not opened, so its lines are not in the totals.
    if (files.length >= limits.files) { sum.hiddenFiles++; uncounted = true; continue; }
    const got = read(name);
    if (!got) continue;
    const file = newFile(name, got, limits, limits.lines - sum.shown);
    sum.added += file.added; sum.shown += file.kept; sum.changed += file.kept;
    if (file.uncounted) uncounted = true;
    files.push(file);
  }
  const cut = short || uncounted || sum.hiddenFiles > 0 || files.some(file => file.hidden > 0 || file.clipped);
  return { base, branch, files: files.map(seal), added: sum.added, removed: sum.removed, cut, hiddenFiles: sum.hiddenFiles, hiddenLines: Math.max(0, sum.added + sum.removed - sum.changed), uncounted };
}
