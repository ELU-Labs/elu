import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EluCodeError, isObject, noSymlinks, onDisk, onDiskUp, personalDirectory, refuse, systemTemp, within } from '../util.mjs';
import { HOME_SECRETS } from '../vendors.mjs';
import { PICTURE_PATHS, pictureKind, picturesRoot } from '../pictures.mjs';
import { peerFile } from './paths.mjs';
import { peerPolicy } from './settings.mjs';
import { sanitize } from './peerdata.mjs';
import { teams } from './roster.mjs';
import { refuser } from './mine.mjs';
import { PEER_EXT, PICTURE_URN, TaskState, a2aError, filePart } from './a2a.mjs';
import { getRecord, updateRecord } from './taskstore.mjs';

// Pictures with a message to a teammate (docs/peer-network.md, "Pictures").
// The owner's app copies each picture a typed message names into pictures/out/<set>/<n>;
// the daemon sends only from there, in pieces, before the message that names them.
// The receiving side stages pieces in pictures/in/<sender key>/ and, once the message is
// accepted, keeps them in pictures/kept/<sender key>/<task id>/<n>.<ending>.
const MB = 1024 * 1024;
export const PICTURE_MAX = 8 * MB, PICTURES_MAX = 4, MESSAGE_MAX = 16 * MB;
// A piece is one JSON line of at most 1 MiB once it is base64.
export const PIECE = 700 * 1024;
// What one teammate may have on this machine: on its way, and kept; and what all may keep.
export const FLIGHT_MAX = 32 * MB, KEPT_PEER_MAX = 64 * MB, KEPT_MAX = 256 * MB, STAGE_MS = 10 * 60000;
// How many pictures one teammate may have on their way: four messages' worth. Every new
// picture walks the folder they wait in, so small ones without number would stall the daemon.
export const FLIGHT_COUNT = 4 * PICTURES_MAX;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEPT_FILE = /^[1-9]\.(png|jpg|gif|webp)$/, STAGED = /^([0-9a-f-]{36})-(\d{1,8})\.(part|done)$/;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function sizeText(bytes) {
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const tenths = Math.round(bytes / MB * 10) / 10;
  return `${tenths >= 10 || Number.isInteger(tenths) ? Math.round(tenths) : tenths.toFixed(1)} MB`;
}
export const countText = count => count === 1 ? '1 picture' : `${count} pictures`;
// A picture's name as shown and sent: the file's own name, never its folder.
function cleanName(value, ending) {
  const name = sanitize(value, 200).replace(/[\\/"<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return name && !/^\.+$/.test(name) ? name : `picture.${ending}`;
}
function kindOf(file) {
  const head = Buffer.alloc(12); let fd = null;
  try { fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, 12, 0); } catch { return null; } finally { if (fd !== null) fs.closeSync(fd); }
  return pictureKind(head);
}
const folderOf = (...parts) => { const dir = peerFile('pictures', ...parts); noSymlinks(dir); return dir; };
function folderSize(dir) {
  let total = 0, entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) total += folderSize(target);
    else { try { total += fs.lstatSync(target).size; } catch { /* Gone already. */ } }
  }
  return total;
}

// The owner's app. A message the owner typed, with each picture it names copied for the
// daemon and its path replaced by the picture's name: { text, pictures: { set, list } | null }.
// A path is a picture when the file's first bytes say PNG, JPEG, GIF or WebP; any other
// path stays the text it was. A message over a limit, or naming a picture in a folder that
// holds secrets, is refused with one line and nothing is copied.
export function attachPictures(text, { home = os.homedir() } = {}) {
  const none = { text, pictures: null };
  if (typeof text !== 'string' || !/[~/]/.test(text)) return none;
  let base; try { base = fs.realpathSync(home); } catch { return none; }
  // Screenshot tools save under ~/Library, so that one folder of the list stays open, as it
  // is for a picture in a local session (lib/pictures.mjs).
  const closed = [...HOME_SECRETS.filter(name => name !== 'Library').map(name => path.join(base, name)), path.resolve(personalDirectory())];
  try { closed.push(fs.realpathSync(personalDirectory())); } catch { /* No state folder yet. */ }
  // A closed folder is the folder on disk, however its path is written: in other letter
  // case, through the disk's other mount point, or when the folder's own name is a link.
  // So every folder above the picture is compared by what it is, not only by its path.
  const closedOnDisk = new Set(closed.map(onDisk).filter(Boolean));
  const isClosed = real => closed.some(folder => within(folder, real)) || onDiskUp(real).some(id => !id || closedOnDisk.has(id));
  const found = new Map(), names = new Set();
  const picture = given => {
    let real, stat; try { real = fs.realpathSync(given); stat = fs.statSync(real); } catch { return null; }
    if (!stat.isFile()) return null;
    const kind = kindOf(real); if (!kind) return null;
    if (found.has(real)) return found.get(real);
    let name = cleanName(path.basename(real), kind[1]);
    if (isClosed(real)) refuse(`${name} is in a folder ELU keeps private, so it can't be sent.`);
    if (stat.size > PICTURE_MAX) refuse(`${name} is ${sizeText(stat.size)}; a picture can be up to ${sizeText(PICTURE_MAX)}.`);
    for (let n = 2; names.has(name); n++) name = cleanName(path.basename(real), kind[1]).replace(/(\.[A-Za-z0-9]+)?$/, `-${n}$1`);
    names.add(name);
    const row = { real, name, size: stat.size, type: kind[0] }; found.set(real, row); return row;
  };
  const out = text.replace(PICTURE_PATHS, (whole, single, double, bare) => {
    const written = single ?? double ?? bare.replace(/\\(.)/g, '$1');
    const full = value => value.startsWith('~/') ? path.join(base, value.slice(2)) : value;
    let row = picture(full(written)), tail = '';
    // A bare path at the end of a sentence carries its full stop or comma.
    if (!row && bare) { tail = /[.,;:!?)\]]+$/.exec(written)?.[0] ?? ''; if (tail) row = picture(full(written.slice(0, -tail.length))); }
    return row ? `${row.name}${tail}` : whole;
  });
  const rows = [...found.values()], total = rows.reduce((sum, row) => sum + row.size, 0);
  if (!rows.length) return none;
  if (rows.length > PICTURES_MAX) refuse(`This message names ${rows.length} pictures; a message can carry up to ${PICTURES_MAX}.`);
  if (total > MESSAGE_MAX) refuse(`These pictures are ${sizeText(total)} together; a message can carry up to ${sizeText(MESSAGE_MAX)}.`);
  const set = crypto.randomUUID(), dir = folderOf('out', set);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    rows.forEach((row, index) => {
      const to = path.join(dir, String(index + 1));
      fs.copyFileSync(row.real, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, 0o600);
      // The copy is what is sent, so it is the copy that must still be a picture of that size.
      if (fs.lstatSync(to).size !== row.size || !kindOf(to)) refuse(`${row.name} changed while it was read. Send the message again.`);
    });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (error instanceof EluCodeError) throw error;
    refuse(`${rows[0].name} could not be read, so the message was not sent.`);
  }
  return { text: out, pictures: { set, list: rows.map(({ name, size, type }) => ({ name, size, type })) } };
}

// The daemon. What a command says it staged, checked against the files themselves:
// { set, list: [{ id, n, name, size, type, sha256 }] }, or null when it names none.
export function stagedPictures(value) {
  if (value == null) return null;
  const bad = () => refuse('The pictures for this message are not ready. Send it again.');
  if (!isObject(value) || !UUID.test(value.set ?? '') || !Array.isArray(value.list) || !value.list.length || value.list.length > PICTURES_MAX) bad();
  const dir = folderOf('out', value.set); let total = 0;
  const list = value.list.map((row, index) => {
    const file = path.join(dir, String(index + 1)); let bytes = null;
    try { noSymlinks(file); const stat = fs.lstatSync(file); if (stat.isFile() && stat.size > 0 && stat.size <= PICTURE_MAX) bytes = fs.readFileSync(file); } catch { bytes = null; }
    const kind = bytes && pictureKind(bytes); if (!kind) bad();
    total += bytes.length;
    return { id: crypto.randomUUID(), n: index + 1, name: cleanName(row?.name, kind[1]), size: bytes.length, type: kind[0], sha256: sha(bytes) };
  });
  if (total > MESSAGE_MAX) bad();
  return { set: value.set, list };
}
// Sends an ask's pictures in pieces. wait() resolves when the next request may go.
// Returns { parts } to name in the message, or { unsent, reason } when the teammate cannot
// take them; anything else throws and the ask is tried again later.
export async function pushPictures(session, pictures, wait) {
  const dir = folderOf('out', pictures.set), parts = [];
  for (const row of pictures.list) {
    let bytes = null;
    try { const file = path.join(dir, String(row.n)); noSymlinks(file); bytes = fs.readFileSync(file); } catch { bytes = null; }
    if (!bytes || bytes.length !== row.size || sha(bytes) !== row.sha256) return { unsent: 'missing' };
    const pieces = Math.ceil(bytes.length / PIECE);
    for (let seq = 0; seq < pieces; seq++) {
      await wait();
      try { await session.request('elu.picture.put', { id: row.id, seq, last: seq === pieces - 1, size: row.size, sha256: row.sha256, data: bytes.subarray(seq * PIECE, (seq + 1) * PIECE).toString('base64') }, { timeoutMs: 60000 }); }
      catch (error) {
        const code = error.details?.rpc?.code;
        // A build from before pictures does not know the method.
        if (code === -32601) return { unsent: 'version' };
        if (code === -32602) return { unsent: 'refused', reason: sanitize(error.message, 200) };
        throw error;
      }
    }
    parts.push(filePart(row));
  }
  return { parts };
}
// The staged copies of a set go once no ask still waits to send them.
export function dropOutgoing(set) { if (UUID.test(set ?? '')) fs.rmSync(folderOf('out', set), { recursive: true, force: true }); }
// One line for the sender when pictures did not go with the text.
export function unsentLine(pictures, name) {
  const who = `@${sanitize(name, 64)}`, all = pictures?.list?.length ?? 0;
  switch (pictures?.unsent) {
    case 'version': return `${who}'s ELU can't take pictures yet. The text went without them.`;
    case 'refused': return `${who} did not take the pictures: ${sanitize(pictures.reason, 200) || 'refused.'}`;
    case 'missing': return 'The pictures were no longer on this machine. The text went without them.';
    case 'partly': return `${who} kept ${pictures.kept ?? 0} of ${countText(all)}.`;
    default: return null;
  }
}

// The receiving side. Pieces are taken only from a teammate, a picture at a time, into a
// file named by its id and the size it said; a finished one waits there for its message.
const stagedFile = (key, id, size, state) => path.join(folderOf('in', key), `${id}-${size}.${state}`);
function sweepStaged(dir, now = Date.now()) {
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  const left = [];
  for (const name of names) {
    const target = path.join(dir, name), match = STAGED.exec(name);
    try { if (!match || now - fs.lstatSync(target).mtimeMs > STAGE_MS) fs.rmSync(target, { recursive: true, force: true }); else left.push({ id: match[1], size: Number(match[2]) }); } catch { /* Gone already. */ }
  }
  return left;
}
function put(ctx, params, session) {
  const key = session.key, active = (team, k) => team.members.some(m => m.key === k && !m.removed);
  if (!session.admitted || !teams().some(team => active(team, ctx.me.key) && active(team, key))) refuse('You are not on a team with this machine.');
  if (peerPolicy(key).muted) refuse(`This ${refuser(key)} is not taking requests from you.`);
  const piece = 'That is not a piece of a picture.';
  if (!isObject(params) || !UUID.test(params.id ?? '') || !Number.isInteger(params.seq) || params.seq < 0 || typeof params.last !== 'boolean' || !Number.isInteger(params.size) || params.size < 1 || !/^[0-9a-f]{64}$/.test(params.sha256 ?? '') || typeof params.data !== 'string') refuse(piece);
  if (params.size > PICTURE_MAX) refuse(`A picture can be up to ${sizeText(PICTURE_MAX)}.`);
  if (params.data.length > Math.ceil(PIECE / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(params.data)) refuse(piece);
  const bytes = Buffer.from(params.data, 'base64'), dir = folderOf('in', key);
  const part = stagedFile(key, params.id, params.size, 'part'), done = stagedFile(key, params.id, params.size, 'done');
  const drop = line => { fs.rmSync(part, { force: true }); refuse(line); };
  if (!bytes.length || bytes.length > PIECE || params.seq * PIECE + bytes.length > params.size || (!params.last && bytes.length !== PIECE)) drop('That picture is not the size it said.');
  if (params.seq === 0) {
    if (!pictureKind(bytes)) refuse('Only PNG, JPEG, GIF and WebP pictures can be sent.');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.rmSync(part, { force: true }); fs.rmSync(done, { force: true });
    const waiting = sweepStaged(dir), flight = waiting.reduce((sum, row) => sum + row.size, 0);
    // Too much on its way, by size or by count, is said as a rate limit, which the sender tries again.
    if (flight + params.size > FLIGHT_MAX || waiting.length >= FLIGHT_COUNT) throw a2aError(-32000, 'Too many pictures at once. Try again shortly.');
    if (folderSize(folderOf('kept', key)) + flight + params.size > KEPT_PEER_MAX || folderSize(folderOf('kept')) + params.size > KEPT_MAX) refuse(`This ${refuser(key)} has no room for more pictures from you.`);
    fs.writeFileSync(part, bytes, { mode: 0o600, flag: 'wx' });
  } else {
    let size = -1; try { noSymlinks(part); size = fs.lstatSync(part).size; } catch { size = -1; }
    if (size !== params.seq * PIECE) drop('That piece of the picture is out of order.');
    fs.appendFileSync(part, bytes);
  }
  if (params.last) {
    const whole = fs.readFileSync(part);
    if (whole.length !== params.size || sha(whole) !== params.sha256 || !pictureKind(whole)) drop('That picture did not arrive whole.');
    fs.renameSync(part, done);
  }
  return { ok: true };
}
// After SendMessage: an accepted message keeps the pictures it names, under generated
// names, and its task says how many were kept; a refused one keeps none.
function settle(key, message, task) {
  const named = (message?.parts ?? []).filter(part => typeof part.url === 'string' && part.url.startsWith(PICTURE_URN));
  if (!named.length || !isObject(task)) return task;
  const from = part => {
    const id = part.url.slice(PICTURE_URN.length), size = part.metadata?.[PEER_EXT]?.size;
    return UUID.test(id) && Number.isInteger(size) && size > 0 && size <= PICTURE_MAX ? { file: stagedFile(key, id, size, 'done'), size } : null;
  };
  const forget = () => { for (const part of named) { const staged = from(part); if (staged) fs.rmSync(staged.file, { force: true }); } };
  const record = task.status?.state === TaskState.SUBMITTED ? getRecord(task.id) : null;
  // A repeat of a message already taken (the reply was lost) keeps what the first one kept.
  if (!record || record.peer !== key || record.pictures) { forget(); return record?.peer === key ? record.task : task; }
  const dir = folderOf('kept', key, task.id), kept = []; let total = 0;
  // The cap on all that is kept is held here, where a picture is kept: several can be on
  // their way at once, from this teammate and from others, and each was let in on its own.
  const room = KEPT_MAX - folderSize(folderOf('kept'));
  for (const part of named.slice(0, PICTURES_MAX)) {
    const staged = from(part); if (!staged) continue;
    try {
      noSymlinks(staged.file);
      const kind = kindOf(staged.file); if (!kind || fs.lstatSync(staged.file).size !== staged.size || total + staged.size > MESSAGE_MAX) continue;
      if (total + staged.size > room) continue;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = `${kept.length + 1}.${kind[1]}`;
      fs.renameSync(staged.file, path.join(dir, file)); fs.chmodSync(path.join(dir, file), 0o600);
      total += staged.size; kept.push({ file, name: cleanName(part.filename, kind[1]), size: staged.size, type: kind[0] });
    } catch { /* Not here, or gone: the text still arrives. */ }
  }
  forget();
  const done = updateRecord(task.id, current => ({ ...current, ...(kept.length ? { pictures: kept } : {}), task: { ...current.task, metadata: { ...current.task.metadata, [PEER_EXT]: { ...current.task.metadata?.[PEER_EXT], pictures: kept.length } } } }));
  return done?.task ?? task;
}
// The daemon's methods with pictures: elu.picture.put, and SendMessage settling them.
export function pictureMethods(ctx, methods) {
  return { ...methods, 'elu.picture.put': (params, session) => put(ctx, params, session), SendMessage: (params, session) => settle(session.key, params.message, methods.SendMessage(params, session)) };
}
// Hourly: staged pieces past their time, kept pictures whose record is gone, and copies
// for sending that no ask waits for. pending(set) says whether an ask still does.
export function sweepPictures(pending = () => false, now = Date.now()) {
  const list = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
  for (const key of list(folderOf('in'))) { const dir = path.join(folderOf('in'), key); if (!sweepStaged(dir, now).length) fs.rmSync(dir, { recursive: true, force: true }); }
  for (const key of list(folderOf('kept'))) for (const id of list(path.join(folderOf('kept'), key))) {
    let record = null; try { record = getRecord(id); } catch { record = null; }
    if (!record || record.peer !== key || !record.pictures) fs.rmSync(path.join(folderOf('kept'), key, id), { recursive: true, force: true });
  }
  for (const set of list(folderOf('out'))) {
    const dir = path.join(folderOf('out'), set);
    try { if (now - fs.lstatSync(dir).mtimeMs > STAGE_MS && !pending(set)) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Gone already. */ }
  }
}

// When a teammate's request runs. Their pictures are copied into a folder of their own
// under ELU's pictures folder in the temporary directory, which the run is given to
// read: { folder, note }. note names them inside the teammate's data. folder is null, and
// the note says the pictures were not seen, when the copies cannot be made.
export function picturesForRun(origin, { temp = systemTemp() } = {}) {
  let record = null; try { record = typeof origin?.a2aTaskId === 'string' ? getRecord(origin.a2aTaskId) : null; } catch { record = null; }
  const rows = Array.isArray(record?.pictures) && record.peer === origin.peer ? record.pictures.filter(row => KEPT_FILE.test(row?.file ?? '')).slice(0, PICTURES_MAX) : [];
  if (!rows.length) return null;
  const label = row => `${cleanName(row.name, 'png')} (${sizeText(row.size)})`;
  const unseen = { folder: null, note: `Pictures sent with this message could not be opened on this machine, so they were not seen: ${rows.map(label).join(', ')}.` };
  const root = picturesRoot(temp); if (!root) return unseen;
  const folder = path.join(root, `q-${crypto.randomBytes(8).toString('hex')}`);
  try {
    fs.mkdirSync(folder, { mode: 0o700 });
    const from = folderOf('kept', record.peer, record.task.id);
    const lines = rows.map((row, index) => {
      const source = path.join(from, row.file), to = path.join(folder, row.file);
      noSymlinks(source); fs.copyFileSync(source, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, 0o600);
      return `${index + 1}. ${label(row)}: ${to}`;
    });
    return { folder, note: `Pictures sent with this message, saved as files on this machine:\n${lines.join('\n')}` };
  } catch { fs.rmSync(folder, { recursive: true, force: true }); return unseen; }
}
