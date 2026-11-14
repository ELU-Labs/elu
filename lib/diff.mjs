import crypto from 'node:crypto';

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
// the ones past a limit, so the totals stay right when only part is kept. until: a line that
// ends the patch where it stands outside a hunk; the lines from it on come back as rest.
function scan(text, limits, until = null) {
  const rows = String(text ?? '').split('\n');
  if (rows.at(-1) === '') rows.pop();
  const files = [], sum = { added: 0, removed: 0, hiddenFiles: 0, shown: 0, changed: 0 };
  let file = null, hunk = null, last = null, left = 0, right = 0, old = 0, now = 0, read = 0, stopped = false;
  const close = () => {
    if (!file) return;
    sum.added += file.added; sum.removed += file.removed;
    if (file.keep) files.push(file); else sum.hiddenFiles++;
    file = hunk = last = null; left = right = 0;
  };
  for (const row of rows) {
    read++;
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
    if (until?.test(row)) { stopped = true; break; }
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
  return { files, sum, rest: stopped ? rows.slice(read - 1) : [] };
}
// The record a view gets: the working fields go, the notes become one line.
function seal(file) {
  const notes = [...file.notes];
  if (file.combined) notes.push('merge conflict, not shown');
  if (file.binary) notes.push('binary file');
  if (file.mode === '120000') notes.push('symbolic link'); else if (file.mode === '160000') notes.push('submodule');
  if (file.oldMode && file.newMode) notes.push(file.oldMode === '100644' && file.newMode === '100755' ? 'now runs as a program' : file.oldMode === '100755' && file.newMode === '100644' ? 'no longer runs as a program' : `file mode ${file.oldMode} → ${file.newMode}`);
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
// The branches of one session as one record: the files of each in turn, the totals of all,
// and parts: [{ branch, current, pull, compared, commits, from, files, added, removed,
// hiddenFiles }], where from is the place of a part's first file and files how many it has.
// pull: its pull request, { number, url }, where one is known. compared: what it is compared
// with, in words. note: one line to say where the session's own changes could not be told.
// With more than one part each file carries its branch, as one path may be in several.
export function joinChanges(parts, { note = null } = {}) {
  const files = [], rows = [], many = parts.length > 1;
  let added = 0, removed = 0, hiddenFiles = 0, hiddenLines = 0, cut = false, uncounted = false;
  for (const { changes, branch = null, current = false, pull = null, compared = null, commits = 0 } of parts) {
    rows.push({ branch, current, pull, compared, commits, from: files.length, files: changes.files.length, added: changes.added, removed: changes.removed, hiddenFiles: changes.hiddenFiles });
    for (const file of changes.files) files.push(many ? { ...file, branch: branch ?? '' } : file);
    added += changes.added; removed += changes.removed; hiddenFiles += changes.hiddenFiles; hiddenLines += changes.hiddenLines;
    cut ||= changes.cut; uncounted ||= changes.uncounted;
  }
  return { base: parts[0]?.changes.base ?? null, branch: parts[0]?.changes.branch ?? null, files, added, removed, cut, hiddenFiles, hiddenLines, uncounted, compared: rows.length === 1 ? rows[0].compared : null, note, parts: rows };
}
// What a session's computer sends of its changes (sessionWire in projects.mjs): a first line
// that names the format and a mark, a line of what is known of each branch, then each
// branch's text after a line that holds the mark. The mark is drawn from the text itself and
// is in none of it, so no line of a file can be taken for the start of a branch.
const SENT = 'ELU changes 2 ';
export function packChanges({ note = null, parts = [] } = {}) {
  if (!parts.length && !note) return '';
  const about = JSON.stringify({ note, parts: parts.map(({ branch = null, current = false, pull = null, compared = null, commits = 0 }) => ({ branch, current, pull, compared, commits })) });
  let mark, round = 0;
  do mark = crypto.createHash('sha256').update(`${round++}\0${about}\0${parts.map(part => part.text).join('\0')}`).digest('hex').slice(0, 16); while (parts.some(part => part.text.includes(mark)));
  return `${SENT}${mark}\n${about}${parts.map(part => `\n=== ${mark} ===\n${part.text}`).join('')}`;
}
// What came from another computer is checked before it is shown: words are one line and
// short, a pull request is a number and a web address.
function unpack(value) {
  const head = /^ELU changes 2 ([0-9a-f]{16})\n([^\n]*)/.exec(value);
  if (!head) return null;
  let about; try { about = JSON.parse(head[2]); } catch { return null; }
  if (!about || typeof about !== 'object' || !Array.isArray(about.parts)) return null;
  const words = (text, most) => typeof text === 'string' && text.trim() ? text.replace(/\s+/g, ' ').trim().slice(0, most) : null;
  const texts = value.slice(head[0].length).split(`\n=== ${head[1]} ===\n`).slice(1);
  return { note: words(about.note, 300), parts: texts.map((text, at) => {
    const row = about.parts[at] && typeof about.parts[at] === 'object' ? about.parts[at] : {}, number = row.pull?.number;
    return { text, branch: words(row.branch, 250), current: row.current === true, compared: words(row.compared, 300), commits: Number.isSafeInteger(row.commits) && row.commits > 0 ? row.commits : 0,
      pull: Number.isSafeInteger(number) && number > 0 ? { number, url: typeof row.pull.url === 'string' && /^https:\/\/\S{1,300}$/.test(row.pull.url) ? row.pull.url : null } : null };
  }) };
}
// The text of one branch (taskDetails in projects.mjs): Git's patch, then each file Git does
// not track yet under a `New file: NAME` line, with its content. Read into the record
// buildChanges gives, every line kept: nothing here is a limit of the view. A new file that
// came without its start says so, and its lines have no numbers. A text an older ELU sent is
// one branch with no first line.
const NEW = /^New (?:file|path): /, PREVIEW = '[File preview truncated.]';
export function sessionChanges(text) {
  const value = String(text ?? ''), sent = unpack(value);
  return sent ? joinChanges(sent.parts.map(part => ({ ...part, changes: branchChanges(part.text) })), { note: sent.note }) : branchChanges(value);
}
function branchChanges(value) {
  const { files, sum, rest } = scan(value, OPEN, NEW);
  let short = false;
  for (let at = 0; at < rest.length;) {
    const title = rest[at++], body = [];
    while (at < rest.length && !NEW.test(rest[at])) body.push(rest[at++]);
    if (title.startsWith('New path: ')) { files.push({ ...blank(title.slice(10).replace(/ \(not a regular file\)$/, '')), status: 'added', notes: ['not a regular file'] }); continue; }
    const file = { ...blank(title.slice(10)), status: 'added' }, last = at >= rest.length, cut = body.at(-1) === PREVIEW;
    if (cut) body.pop();
    // The text ends each new file's content with one line break of its own: where the content
    // ended with one too, an empty row is left, but for the last file, whose row scan dropped.
    const whole = last && !cut ? value.endsWith('\n') : body.at(-1) === '';
    if (whole && !(last && !cut)) body.pop();
    if (body.length === 1 && body[0] === '(binary content)') file.binary = true;
    else {
      const lines = body.map((row, index) => ({ kind: 'add', old: null, now: cut ? null : index + 1, text: row }));
      if (lines.length && !whole && !cut) lines.at(-1).eol = false;
      if (lines.length) file.hunks.push({ header: cut ? 'the end of the file' : `@@ -0,0 +${lines.length === 1 ? '1' : `1,${lines.length}`} @@`, lines });
      file.added = lines.length; sum.added += lines.length;
    }
    if (cut) { file.notes.push('only the end of this file was sent'); short = true; }
    files.push(file);
  }
  return { base: null, branch: null, files: files.map(seal), added: sum.added, removed: sum.removed, cut: short, hiddenFiles: 0, hiddenLines: 0, uncounted: short };
}
