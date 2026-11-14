import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EluCodeError, inFolders, isObject, noSymlinks, onDisk, onDiskPath, personalDirectory, refuse, within } from '../util.mjs';
import { git } from '../git.mjs';
import { HOME_SECRETS } from '../vendors.mjs';
import { PICTURE_PATHS } from '../pictures.mjs';
import { secretFileName } from '../permission-rules.mjs';
import { peerFile } from './paths.mjs';
import { sanitize } from './peerdata.mjs';
import { PIECE, sizeText } from './pictures.mjs';
import { a2aError } from './a2a.mjs';

// Files to a session on another computer of mine (docs/peer-network.md, "Your other
// computers", "Files"). The app or the session's tool collects what was named and copies it to
// files/out/<set>/ in the state folder; the daemon sends only from there, as one stream in
// pieces: the list of files as one JSON line, then each file's bytes in that order. The host
// stages the pieces in files/in/<sender key>/, and once the last is in, writes the files
// to the session's inbox, checking each against its SHA-256.
const MB = 1024 * 1024;
export const FILES_MAX = 5000, BYTES_MAX = 200 * MB;
// The list of files is at most this long; with the files it makes the stream.
export const LIST_MAX = 4 * MB, STREAM_MAX = BYTES_MAX + LIST_MAX + 1;
// Sends from one computer on their way at once, and how long a half-sent one is kept.
export const SENDS_AT_ONCE = 2, STAGE_MS = 10 * 60000, OUT_MS = 2 * 3600000;
export { PIECE, sizeText };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAGED = /^([0-9a-f-]{36})-(\d{1,10})\.part$/, HEX64 = /^[0-9a-f]{64}$/;
const PATH_MAX = 1024, WRITTEN_MAX = 4096, DEPTH_MAX = 64;
export const fileCount = count => count === 1 ? '1 file' : `${count.toLocaleString('en-US')} files`;
const keyCount = count => count === 1 ? '1 key file' : `${count} key files`;

// ---- The inbox: where files sent to a session land ----

// ELU's data folder, beside the stand-in commands (lib/never-shims.mjs): outside the state
// folder, which no session may read, and outside every project and worktree. It must lie in
// the home folder, since a session reads only folders there (/permissions folders).
export function inboxRoot({ home = os.homedir(), env = process.env } = {}) {
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? path.resolve(env.XDG_DATA_HOME) : null;
  const base = data && within(path.resolve(home), data) && data !== path.resolve(home) ? data : path.join(home, '.local', 'share');
  return path.join(onDiskPath(base), 'elu-code', 'inbox');
}
// The inbox lies outside every Git work tree, or where that repository ignores it, so a
// session that runs git add -A there never commits what landed: a home folder that is a
// repository, or XDG_DATA_HOME inside one, would put it in one. Made first, so Git can say
// whether the folder is ignored.
export function checkInbox(inbox = inboxRoot()) {
  noSymlinks(inbox); fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
  const top = git(inbox, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (top.status !== 0 || top.error || !top.stdout.trim()) return inbox;
  const ignored = git(inbox, ['check-ignore', '-q', '--', inbox], { allowFailure: true });
  if (ignored.status === 0 && !ignored.error) return inbox;
  refuse(`Files are not received here: the folder for them, ${inbox}, is inside the Git repository ${top.stdout.trim()}, which could commit them. Add it to that repository's .gitignore.`);
}

// ---- What a message names, and what goes ----

// A name made safe: one part of a relative path, never . or .., no slash or control character.
const PART = /^[^\x00-\x1f\x7f/\\]{1,255}$/;
export const safePart = value => typeof value === 'string' && PART.test(value) && value !== '.' && value !== '..' && Buffer.byteLength(value) <= 255;
export function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > PATH_MAX || value.startsWith('/')) return false;
  const parts = value.split('/');
  return parts.length <= DEPTH_MAX && parts.every(safePart) && !parts.includes('.git');
}
const expand = (written, home) => written === '~' ? home : written.startsWith('~/') ? path.join(home, written.slice(2)) : written;
// The paths a typed message names that are on this computer: absolute, ~/, quoted, or with
// their spaces escaped as a terminal writes a dropped file. [{ written, path }], written as
// it stands in the text, so the other computer can put where it landed in its place.
export function pathsInText(text, { home = os.homedir() } = {}) {
  if (typeof text !== 'string' || !/[~/]/.test(text)) return [];
  const out = [], seen = new Set();
  for (const match of text.matchAll(PICTURE_PATHS)) {
    const [whole, single, double, bare] = match;
    let written = whole, given = single ?? double ?? bare.replace(/\\(.)/g, '$1');
    const exists = value => { try { fs.statSync(expand(value, home)); return true; } catch { return false; } };
    // A bare path at the end of a sentence carries its full stop or comma.
    if (!exists(given) && bare) { const tail = /[.,;:!?)\]]+$/.exec(given)?.[0] ?? ''; if (!tail || !exists(given.slice(0, -tail.length))) continue; given = given.slice(0, -tail.length); written = whole.slice(0, -tail.length); }
    else if (!exists(given)) continue;
    const full = path.resolve(expand(given, home));
    if (seen.has(full)) continue; seen.add(full);
    out.push({ written, path: full });
  }
  return out;
}
// Paths given one by one (/send, the session's tool): each must be there. A message sent
// with them that names one as it was given gets where it landed in its place.
export function namedPaths(list, { home = os.homedir() } = {}) {
  if (!Array.isArray(list) || !list.length) refuse('Name a file or folder to send.');
  return [...new Map(list.map(given => {
    if (typeof given !== 'string' || !given.trim() || /[\x00]/.test(given)) refuse('Name a file or folder to send.');
    const full = path.resolve(expand(given.trim(), home));
    try { fs.statSync(full); } catch { refuse(`${given.trim()} is not on this computer.`); }
    return [full, { written: given.trim(), path: full }];
  })).values()];
}
// What a send would carry, without copying anything: { items, files, bytes, keys, skipped }.
// items are the paths named, each a file or a folder; files are the regular files in them,
// with their path under the item's name. A folder's .git is left out, and so is a link that
// leads out of the folder sent (counted in skipped) and anything that is not a file or a
// folder. A link in the folder to a file in it goes as that file. check(file): why this
// sender may not read that file, or null; one refusal stops the whole send. ELU's own
// state folder is never sent. Folders are compared by what they are on disk (inFolders). Each
// file keeps what it was on disk when it was checked (id), and only that file is copied
// (stageFiles), so one swapped for a link or another file after its check is not.
const stateOf = () => { const dir = personalDirectory(); let real = path.resolve(dir); try { real = fs.realpathSync(dir); } catch { /* None yet. */ } return real; };
const linkFree = file => { try { noSymlinks(file); return true; } catch { return false; } };
export function collectFiles(entries, { check = null, home = os.homedir() } = {}) {
  const stateDir = stateOf(), isState = inFolders([stateDir], { caseless: true });
  // An item that holds the state folder: the item is that folder or one above it.
  const holdsState = real => inFolders([real], { caseless: true })(stateDir);
  const inSecretDir = inFolders(HOME_SECRETS.filter(name => name !== 'Library').map(name => path.join(home, name)), { caseless: true });
  const items = [], files = [], names = new Set();
  let bytes = 0, keys = 0, skipped = 0;
  const tooMany = () => refuse(`That is more than ${fileCount(FILES_MAX)}; a send carries up to ${fileCount(FILES_MAX)}. Name fewer.`);
  const tooBig = () => refuse(`That is more than ${sizeText(BYTES_MAX)}; a send carries up to ${sizeText(BYTES_MAX)}. Name fewer files.`);
  // What the file is on disk, by a path with no link in it, the same before and after its checks.
  const take = (real, shown, size) => {
    const changed = () => refuse(`${shown} changed while it was read. Send it again.`);
    const before = linkFree(real) ? onDisk(real) : null; if (!before) changed();
    if (isState(real)) refuse(`${shown} is ELU's own state, which is never sent.`);
    const why = check?.(real, shown); if (why) refuse(why);
    if (!linkFree(real) || onDisk(real) !== before) changed();
    if (files.length >= FILES_MAX) tooMany();
    bytes += size; if (bytes > BYTES_MAX) tooBig();
    if (secretFileName(path.basename(real)) || inSecretDir(real)) keys++;
    return before;
  };
  for (const entry of entries) {
    let real, stat;
    try { real = fs.realpathSync(entry.path); stat = fs.statSync(real); } catch { refuse(`${entry.path} is not on this computer.`); }
    if (isState(real) || holdsState(real)) refuse(`${entry.path} holds ELU's own state, which is never sent.`);
    let base = sanitize(path.basename(entry.path), 200).replace(/[/\\]/g, '').trim();
    if (!safePart(base) || base === '.git') base = stat.isDirectory() ? 'folder' : 'file';
    let name = base;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base}-${n}`;
    names.add(name.toLowerCase());
    if (stat.isFile()) { const id = take(real, entry.path, stat.size); files.push({ path: name, real, size: stat.size, id }); items.push({ name, written: entry.written ?? null }); continue; }
    if (!stat.isDirectory()) refuse(`${entry.path} is not a file or a folder.`);
    const before = files.length;
    const walk = (dir, rel) => {
      // A folder inside that cannot be read is left out; the folder named must be readable.
      let rows; try { rows = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { if (!rel) refuse(`${entry.path} could not be read.`); skipped++; return; }
      for (const row of rows) {
        if (row.name === '.git') continue;
        const full = path.join(dir, row.name), at = rel ? `${rel}/${row.name}` : row.name;
        if (!safePart(row.name)) { skipped++; continue; }
        if (row.isSymbolicLink()) {
          let target, kind; try { target = fs.realpathSync(full); kind = fs.statSync(target); } catch { skipped++; continue; }
          // A link is never followed out of the folder sent, and a link to a folder in it is that folder, sent once already.
          if (!within(real, target) || !kind.isFile()) { skipped++; continue; }
          const id = take(target, path.join(entry.path, at), kind.size); files.push({ path: `${name}/${at}`, real: target, size: kind.size, id }); continue;
        }
        if (row.isDirectory()) { walk(full, at); continue; }
        if (!row.isFile()) { skipped++; continue; }
        const size = fs.lstatSync(full).size;
        const id = take(full, path.join(entry.path, at), size); files.push({ path: `${name}/${at}`, real: full, size, id });
      }
    };
    walk(real, '');
    if (files.length === before) refuse(`${entry.path} has no files to send.`);
    items.push({ name, written: entry.written ?? null });
  }
  if (!files.length) refuse('Name a file or folder to send.');
  for (const row of files) if (!safePath(row.path)) refuse(`${row.path} has a name that can't be sent.`);
  return { items, files, bytes, keys, skipped };
}
// The one line that offers a send: "Send 14 files (2.1 MB), including 1 key file, from this computer with this message?"
export function offerLine(collected, { message = true } = {}) {
  const extra = [collected.keys ? `including ${keyCount(collected.keys)}` : '', collected.skipped ? `leaving out ${collected.skipped === 1 ? '1 link or special file' : `${collected.skipped} links or special files`}` : ''].filter(Boolean).join(', ');
  return `Send ${fileCount(collected.files.length)} (${sizeText(collected.bytes)})${extra ? `, ${extra},` : ''} from this computer${message ? ' with this message' : ''}?`;
}

// Copies what collectFiles found to files/out/<set>/ for the daemon: the list in list.json and
// each file as data/<n>. Returns { set, count, bytes }. A file that changed while it was read
// stops the send, and nothing stays behind: one of another size, or one that is no longer the
// file collectFiles checked (id), as when it or a folder above it became a link. It is opened
// without following a link, and its path must have none before and after.
const outDir = set => { const dir = peerFile('files', 'out', set); noSymlinks(dir); return dir; };
const sha = () => crypto.createHash('sha256');
function copyHashed(from, to, size, id) {
  const hash = sha(), buffer = Buffer.alloc(MB); let read = 0, input = null, output = null;
  try {
    if (!id || !linkFree(from)) return null;
    try { input = fs.openSync(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); } catch { return null; }
    const opened = fs.fstatSync(input, { bigint: true });
    if (!opened.isFile() || `${opened.dev}:${opened.ino}` !== id || opened.size !== BigInt(size) || !linkFree(from) || onDisk(from) !== id) return null;
    output = fs.openSync(to, 'wx', 0o600);
    for (let n; (n = fs.readSync(input, buffer, 0, buffer.length, null)) > 0;) { hash.update(buffer.subarray(0, n)); fs.writeSync(output, buffer, 0, n); read += n; if (read > size) break; }
  } finally { if (input !== null) fs.closeSync(input); if (output !== null) fs.closeSync(output); }
  return read === size ? hash.digest('hex') : null;
}
export function stageFiles(collected) {
  const set = crypto.randomUUID(), dir = outDir(set);
  try {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true, mode: 0o700 });
    const list = collected.files.map((row, index) => {
      const digest = copyHashed(row.real, path.join(dir, 'data', String(index + 1)), row.size, row.id);
      if (!digest) refuse(`${row.path} changed while it was read. Send it again.`);
      return { path: row.path, size: row.size, sha256: digest };
    });
    fs.writeFileSync(path.join(dir, 'list.json'), JSON.stringify({ items: collected.items.map(({ name, written }) => ({ name, written })), files: list }), { mode: 0o600, flag: 'wx' });
    return { set, count: list.length, bytes: list.reduce((sum, row) => sum + row.size, 0) };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (error instanceof EluCodeError) throw error;
    refuse(`The files could not be read, so nothing was sent: ${error.message}`);
  }
}
export function dropOutgoingFiles(set) { if (UUID.test(set ?? '')) fs.rmSync(outDir(set), { recursive: true, force: true }); }

// ---- The stream ----

// What a send reads: the list it names, checked, and its files as they are on disk.
// { set, head (the list line), parts: [{ file, size }], total, count, bytes }.
function checkList(list) {
  const bad = message => refuse(message ?? 'That send is not whole.');
  if (!isObject(list) || !Array.isArray(list.items) || !Array.isArray(list.files) || !list.items.length || !list.files.length) bad();
  if (list.items.length > FILES_MAX) bad(`A send carries up to ${fileCount(FILES_MAX)}.`);
  if (list.files.length > FILES_MAX) bad(`A send carries up to ${fileCount(FILES_MAX)}.`);
  const items = new Map();
  for (const item of list.items) {
    if (!isObject(item) || !safePart(item.name) || item.name === '.git' || items.has(item.name.toLowerCase())) bad(`${sanitize(item?.name, 80) || 'A name'} can't be used here.`);
    if (item.written != null && (typeof item.written !== 'string' || item.written.length > WRITTEN_MAX)) bad();
    items.set(item.name.toLowerCase(), { name: item.name, written: item.written ?? null });
  }
  const seen = new Set(); let bytes = 0;
  for (const row of list.files) {
    if (!isObject(row) || !safePath(row.path)) bad(`${sanitize(row?.path, 120) || 'A path'} can't be used here: names are relative, with no .. and no .git.`);
    if (!Number.isSafeInteger(row.size) || row.size < 0 || !HEX64.test(row.sha256 ?? '')) bad();
    if (!items.has(row.path.split('/')[0].toLowerCase())) bad();
    // Two names that differ only in case are one file on many disks.
    if (seen.has(row.path.toLowerCase())) bad(`${sanitize(row.path, 120)} is named twice.`);
    seen.add(row.path.toLowerCase());
    bytes += row.size;
  }
  if (bytes > BYTES_MAX) bad(`A send carries up to ${sizeText(BYTES_MAX)}.`);
  return { items: [...items.values()], files: list.files.map(({ path: at, size, sha256 }) => ({ path: at, size, sha256 })), bytes };
}
export function stagedFiles(value) {
  const bad = () => refuse('The files for this message are not ready. Send it again.');
  if (!isObject(value) || !UUID.test(value.set ?? '')) bad();
  const dir = outDir(value.set);
  let list; try { const file = path.join(dir, 'list.json'); noSymlinks(file); list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { bad(); }
  const checked = checkList(list);
  const head = Buffer.from(`${JSON.stringify({ items: checked.items, files: checked.files })}\n`);
  if (head.length > LIST_MAX) refuse('Those files have too many long names for one send. Name fewer.');
  const parts = checked.files.map((row, index) => {
    const file = path.join(dir, 'data', String(index + 1));
    try { noSymlinks(file); const stat = fs.lstatSync(file); if (!stat.isFile() || stat.size !== row.size) bad(); } catch (error) { if (error instanceof EluCodeError) throw error; bad(); }
    return { file, size: row.size };
  });
  return { set: value.set, head, parts, total: head.length + checked.bytes, count: checked.files.length, bytes: checked.bytes };
}
// The stream in pieces of PIECE bytes: the list line, then each file.
export function* pieces(staged) {
  const segments = [{ buffer: staged.head, size: staged.head.length }, ...staged.parts], piece = Buffer.alloc(PIECE);
  let filled = 0;
  for (const segment of segments) {
    if (segment.buffer) {
      for (let at = 0; at < segment.size;) { const n = Math.min(PIECE - filled, segment.size - at); segment.buffer.copy(piece, filled, at, at + n); filled += n; at += n; if (filled === PIECE) { yield Buffer.from(piece); filled = 0; } }
      continue;
    }
    const fd = fs.openSync(segment.file, 'r');
    try {
      for (let at = 0; at < segment.size;) {
        const n = fs.readSync(fd, piece, filled, Math.min(PIECE - filled, segment.size - at), at);
        if (n <= 0) refuse('A file changed while it was sent. Send it again.');
        filled += n; at += n;
        if (filled === PIECE) { yield Buffer.from(piece); filled = 0; }
      }
    } finally { fs.closeSync(fd); }
  }
  if (filled) yield Buffer.from(piece.subarray(0, filled));
}

// ---- The receiving side ----

// Pieces are staged per sender: files/in/<sender key>/<send>-<size>.part.
const inDir = key => { const dir = peerFile('files', 'in', key); noSymlinks(dir); return dir; };
function sweepIn(dir, now = Date.now()) {
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  const left = [];
  for (const name of names) {
    const target = path.join(dir, name), match = STAGED.exec(name);
    try { if (!match || now - fs.lstatSync(target).mtimeMs > STAGE_MS) fs.rmSync(target, { recursive: true, force: true }); else left.push({ send: match[1], size: Number(match[2]) }); } catch { /* Gone already. */ }
  }
  return left;
}
// One piece of a send from key. Returns { done: false }, or { done: true, file, size } once
// the last piece is in. A piece sent again (its answer was lost) is taken once.
export function takePiece(key, params) {
  const piece = 'That is not a piece of a send.';
  if (!isObject(params) || !UUID.test(params.send ?? '') || !Number.isSafeInteger(params.seq) || params.seq < 0 || typeof params.last !== 'boolean' || !Number.isSafeInteger(params.size) || params.size < 1 || typeof params.data !== 'string') refuse(piece);
  if (params.size > STREAM_MAX) refuse(`A send carries up to ${sizeText(BYTES_MAX)}.`);
  if (params.data.length > Math.ceil(PIECE / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(params.data)) refuse(piece);
  const bytes = Buffer.from(params.data, 'base64'), dir = inDir(key), part = path.join(dir, `${params.send}-${params.size}.part`), end = params.seq * PIECE + bytes.length;
  const drop = line => { fs.rmSync(part, { force: true }); refuse(line); };
  if (!bytes.length || bytes.length > PIECE || end > params.size || (!params.last && bytes.length !== PIECE) || (params.last && end !== params.size)) drop('That send is not the size it said.');
  if (params.seq === 0) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.rmSync(part, { force: true });
    const others = sweepIn(dir).filter(row => row.send !== params.send);
    // Too many at once is said as a rate limit, which the sender tries again shortly.
    if (others.length >= SENDS_AT_ONCE) throw a2aError(-32000, 'Other files from this computer are still on their way. Try again shortly.');
    fs.writeFileSync(part, bytes, { mode: 0o600, flag: 'wx' });
  } else {
    let size = -1; try { noSymlinks(part); size = fs.lstatSync(part).size; } catch { size = -1; }
    if (size === end) { /* Sent again: already here. */ }
    else if (size === params.seq * PIECE) fs.appendFileSync(part, bytes);
    else drop('That piece of the send is out of order. Send it again.');
  }
  if (!params.last) return { done: false };
  if (fs.lstatSync(part).size !== params.size) drop('That send did not arrive whole. Send it again.');
  return { done: true, file: part, size: params.size };
}
// Reads the list line of a finished stream.
function readHead(fd, size) {
  const length = Math.min(size, LIST_MAX + 1), buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, 0);
  const end = buffer.indexOf(0x0a);
  if (end < 0) refuse('That send has no list of its files.');
  let list; try { list = JSON.parse(buffer.subarray(0, end).toString('utf8')); } catch { refuse('That send has no list of its files.'); }
  return { list: checkList(list), offset: end + 1 };
}
// Writes the files of a finished stream into a new folder dir, each checked against its
// SHA-256, and removes the stream. Only folders and regular files are made, by names checked
// here; nothing is ever followed. Returns { items, count, bytes }. On any fault nothing stays.
export function landFiles(file, size, dir) {
  let fd = null;
  try {
    noSymlinks(file); fd = fs.openSync(file, 'r');
    const { list, offset } = readHead(fd, size);
    if (offset + list.bytes !== size) refuse('That send is not the size its list says.');
    noSymlinks(path.dirname(dir)); fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 }); fs.mkdirSync(dir, { mode: 0o700 });
    const buffer = Buffer.alloc(MB); let at = offset;
    for (const row of list.files) {
      const target = path.join(dir, ...row.path.split('/'));
      if (!within(dir, target) || target === dir) refuse(`${row.path} can't be used here.`);
      let folder = dir;
      for (const part of row.path.split('/').slice(0, -1)) {
        folder = path.join(folder, part);
        try { fs.mkdirSync(folder, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (!fs.lstatSync(folder).isDirectory()) refuse(`${row.path} is a file and a folder at once.`);
      }
      let out = null; const hash = sha();
      try {
        out = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
        for (let left = row.size; left > 0;) {
          const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, left), at);
          if (n <= 0) refuse('That send ended early.');
          hash.update(buffer.subarray(0, n)); fs.writeSync(out, buffer, 0, n); at += n; left -= n;
        }
      } catch (error) { if (error.code === 'EEXIST') refuse(`${row.path} is named twice.`); throw error; }
      finally { if (out !== null) fs.closeSync(out); }
      if (hash.digest('hex') !== row.sha256) refuse(`${row.path} did not arrive whole. Send it again.`);
    }
    return { items: list.items, count: list.files.length, bytes: list.bytes };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (error instanceof EluCodeError) throw error;
    refuse(`The files could not be written here: ${error.message}`);
  } finally { if (fd !== null) fs.closeSync(fd); fs.rmSync(file, { force: true }); }
}
// The message with each path the sender wrote in it put where its file or folder landed.
const quoted = value => /[\s'"\\]/.test(value) ? `"${value.replace(/(["\\$`])/g, '\\$1')}"` : value;
export function landedText(text, items, dir) {
  let out = String(text ?? '');
  for (const item of [...items].filter(row => row.written).sort((a, b) => b.written.length - a.written.length)) if (out.includes(item.written)) out = out.split(item.written).join(quoted(path.join(dir, item.name)));
  return out;
}
export const filesLine = (from, count, bytes, dir) => `Files from ${from}: ${fileCount(count)} (${sizeText(bytes)}) in ${dir}`;
// Hourly: half-sent streams past their time, and copies for sending that no send needs now.
export function sweepFiles(now = Date.now()) {
  const list = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
  const root = peerFile('files'); try { noSymlinks(root); } catch { return; }
  for (const key of list(path.join(root, 'in'))) { const dir = path.join(root, 'in', key); if (!sweepIn(dir, now).length) fs.rmSync(dir, { recursive: true, force: true }); }
  for (const set of list(path.join(root, 'out'))) {
    const dir = path.join(root, 'out', set);
    try { if (now - fs.lstatSync(dir).mtimeMs > OUT_MS) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Gone already. */ }
  }
}
