import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { newHome, peerHome, withHome, makeTeam, registeredProject, answeringClis } from './peer-helpers.mjs';
import { project, readRole, temp } from './helpers.mjs';
import { EluCodeError, personalDirectory } from '../lib/util.mjs';
import { checkRunPictures, pictureKind, picturesRoot } from '../lib/pictures.mjs';
import * as claude from '../lib/adapters/claude.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { savePeerPolicy, savePeerSettings } from '../lib/peer/settings.mjs';
import { identity as loadIdentity } from '../lib/peer/identity.mjs';
import { share } from '../lib/peer/shares.mjs';
import { PEER_EXT, createRpcHandler, filePart, message, task as a2aTask, textPart } from '../lib/peer/a2a.mjs';
import { intakeMethods } from '../lib/peer/intake.mjs';
import { declineIncoming } from '../lib/peer/replies.mjs';
import { RETAIN_MS, getRecord, prune } from '../lib/peer/taskstore.mjs';
import { autoDrafts, createAsk, getAsk, sendDraft } from '../lib/peer/asks.mjs';
import { FLIGHT_COUNT, FLIGHT_MAX, KEPT_MAX, KEPT_PEER_MAX, MESSAGE_MAX, PICTURE_MAX, PICTURES_MAX, PIECE, attachPictures, pictureMethods, picturesForRun, sizeText, stagedPictures, sweepPictures, unsentLine } from '../lib/peer/pictures.mjs';
import * as peer from '../lib/peer/index.mjs';
import { teamPanes, visible } from '../lib/terminal-visuals.mjs';

const require = createRequire(import.meta.url);
const RUNNER = fileURLToPath(new URL('./peer-runner.mjs', import.meta.url));
const MB = 1024 * 1024;
const HEADS = { png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], jpg: [0xff, 0xd8, 0xff, 0xe0], gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], webp: [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50] };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// A file that starts as a picture of that kind does, filled out with random bytes.
function picture(file, size = 3000, kind = 'png') {
  const bytes = Buffer.concat([Buffer.from(HEADS[kind]), crypto.randomBytes(size - HEADS[kind].length)]);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return bytes;
}
// A file of that size with a picture's first bytes and nothing written after them.
function hollow(file, size) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(HEADS.png)); fs.truncateSync(file, size); }
const staged = () => { const dir = peerFile('pictures', 'out'); return fs.existsSync(dir) ? fs.readdirSync(dir) : []; };
const mode = file => fs.lstatSync(file).mode & 0o777;
// The rows of the Chats tab for the active home, as plain text.
const chatRows = () => teamPanes({ status: peer.peerStatus(), agents: [], items: peer.peerItems() }, [40, 40, 220], false)[2].map(row => visible(row.line).replace(/\s+/g, ' ').trim());
async function until(check, label, timeout = 90000) {
  const started = Date.now();
  for (;;) {
    let value; try { value = check(); } catch { value = null; }
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}
// The temporary directory for the rest of a test, so copies for a run land in the test's own folder.
function ownTemp(t) {
  const dir = temp(t), previous = process.env.TMPDIR; process.env.TMPDIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; });
  return dir;
}

test('a typed message carries the pictures it names: a dragged, a quoted and a home path become names, and anything else stays the text it was', t => {
  peerHome(t); const home = temp(t);
  const shot = path.join(home, 'Library', 'Application Support', 'Shots', 'Shot 2026-01-02 at 3.04.05 PM@2x.png');
  const a = picture(shot, 4000), b = picture(path.join(home, 'pics', 'b.jpg'), 2000, 'jpg'), c = picture(path.join(home, 'c.gif'), 1500, 'gif'), d = picture(path.join(home, 'pics', 'd.bin'), 1200, 'webp');
  // A picture's ending on a file that is not one, and a path that is not there.
  const notes = path.join(home, 'notes.png'), missing = path.join(home, 'gone.png'); fs.writeFileSync(notes, 'just words\n');
  const typed = `look at ${shot.replaceAll(' ', '\\ ')} and '${path.join(home, 'pics', 'b.jpg')}' and ~/c.gif, then "${path.join(home, 'pics', 'd.bin')}" but not ${notes} or ${missing} or ${home}`;
  const out = attachPictures(typed, { home });
  assert.equal(out.text, `look at Shot 2026-01-02 at 3.04.05 PM@2x.png and b.jpg and c.gif, then d.bin but not ${notes} or ${missing} or ${home}`);
  assert.deepEqual(out.pictures.list, [{ name: 'Shot 2026-01-02 at 3.04.05 PM@2x.png', size: 4000, type: 'image/png' }, { name: 'b.jpg', size: 2000, type: 'image/jpeg' }, { name: 'c.gif', size: 1500, type: 'image/gif' }, { name: 'd.bin', size: 1200, type: 'image/webp' }]);
  // The copies the daemon sends are in the private state folder, closed to others, under numbers.
  const dir = peerFile('pictures', 'out', out.pictures.set);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['1', '2', '3', '4']); assert.equal(mode(dir), 0o700);
  [a, b, c, d].forEach((bytes, index) => { const file = path.join(dir, String(index + 1)); assert.ok(fs.readFileSync(file).equals(bytes)); assert.equal(mode(file), 0o600); });
  // The daemon reads the copies itself: its own sizes, kinds and hashes, one id a picture.
  const checked = stagedPictures({ set: out.pictures.set, list: out.pictures.list.map(row => ({ ...row, size: 1, type: 'text/plain' })) });
  assert.deepEqual(checked.list.map(({ id, ...row }) => row), [a, b, c, d].map((bytes, index) => ({ n: index + 1, ...out.pictures.list[index], sha256: sha(bytes) })));
  assert.equal(new Set(checked.list.map(row => row.id)).size, 4);
  // The same picture named twice is one picture; two files of one name are told apart.
  const again = picture(path.join(home, 'other', 'b.jpg'), 900, 'jpg');
  const twice = attachPictures(`${path.join(home, 'c.gif')} ${path.join(home, 'c.gif')} '${path.join(home, 'pics', 'b.jpg')}' '${path.join(home, 'other', 'b.jpg')}'`, { home });
  assert.equal(twice.text, 'c.gif c.gif b.jpg b-2.jpg'); assert.deepEqual(twice.pictures.list.map(row => row.size), [1500, 2000, again.length]);
  // Text with no picture in it is untouched and copies nothing.
  const before = staged().length;
  for (const plain of ['no paths here', `see ${notes}`, `open ${home} and/or https://example.invalid/a.png`]) assert.deepEqual(attachPictures(plain, { home }), { text: plain, pictures: null });
  assert.equal(staged().length, before);
  assert.throws(() => stagedPictures({ set: crypto.randomUUID(), list: [{ name: 'a.png' }] }), /not ready/);
  assert.throws(() => stagedPictures({ set: '../x', list: [{ name: 'a.png' }] }), /not ready/);
  assert.equal(stagedPictures(null), null);
});

test('a message over a limit, or naming a picture in a folder that holds secrets, is refused with one line and copies nothing', t => {
  peerHome(t); const home = temp(t);
  const refused = (text, line) => { assert.throws(() => attachPictures(text, { home }), error => { assert.ok(error instanceof EluCodeError); assert.match(error.message, line); return true; }); assert.deepEqual(staged(), []); };
  // One picture over the size for one.
  hollow(path.join(home, 'big.png'), 14 * MB);
  refused(`here ${path.join(home, 'big.png')}`, /^big\.png is 14 MB; a picture can be up to 8 MB\.$/);
  hollow(path.join(home, 'edge.png'), PICTURE_MAX); hollow(path.join(home, 'over.png'), PICTURE_MAX + 1);
  refused(path.join(home, 'over.png'), /^over\.png is 8 MB; a picture can be up to 8 MB\.$/);
  // Too many, and too much together.
  const five = [1, 2, 3, 4, 5].map(n => { const file = path.join(home, `p${n}.png`); picture(file, 500); return file; });
  refused(five.join(' '), /^This message names 5 pictures; a message can carry up to 4\.$/);
  const three = [1, 2, 3].map(n => { const file = path.join(home, `six${n}.png`); hollow(file, 6 * MB); return file; });
  refused(three.join(' '), /^These pictures are 18 MB together; a message can carry up to 16 MB\.$/);
  // A folder on the secrets list, and ELU Code's own state folder. ~/Library is the one that stays open.
  for (const folder of ['.ssh', '.aws', '.config', '.gnupg']) { picture(path.join(home, folder, 'key.png'), 400); refused(`'${path.join(home, folder, 'key.png')}'`, /^key\.png is in a folder ELU Code keeps private, so it can't be sent\.$/); }
  picture(path.join(personalDirectory(), 'peer', 'inside.png'), 400);
  refused(path.join(personalDirectory(), 'peer', 'inside.png'), /keeps private/);
  // A link out of an open folder into a closed one is followed before the check.
  fs.symlinkSync(path.join(home, '.ssh', 'key.png'), path.join(home, 'link.png'));
  refused(path.join(home, 'link.png'), /keeps private/);
  // A closed folder is closed however its path is written. When its own name is a link, the folder it leads to
  // is closed, by either path; so is the same folder in other letter case, on a disk that does not tell case apart.
  picture(path.join(home, 'vault', 'key.png'), 400); fs.symlinkSync(path.join(home, 'vault'), path.join(home, '.kube'));
  refused(path.join(home, '.kube', 'key.png'), /keeps private/); refused(path.join(home, 'vault', 'key.png'), /keeps private/);
  if (fs.existsSync(path.join(home, '.SSH', 'key.png'))) refused(path.join(home, '.SSH', 'key.png'), /keeps private/);
  // A secret that is not a picture is never opened up either: it stays text.
  fs.writeFileSync(path.join(home, '.ssh', 'id.png'), 'not a picture');
  assert.equal(attachPictures(path.join(home, '.ssh', 'id.png'), { home }).pictures, null);
  // At the limits it goes.
  assert.equal(attachPictures(`${path.join(home, 'edge.png')} ${five.slice(0, 3).join(' ')}`, { home }).pictures.list.length, PICTURES_MAX);
  assert.equal(sizeText(340 * 1024), '340 KB'); assert.equal(sizeText(1.24 * MB), '1.2 MB'); assert.equal(MESSAGE_MAX, 16 * MB);
});

test('a teammate\'s question run is given its one pictures folder only when the folder is ELU Code\'s own and holds nothing but pictures', t => {
  const base = ownTemp(t), cwd = project(t).root, session = '12345678-1234-4234-8234-123456789abc', role = readRole('claude');
  const launch = extra => claude.compile({ role, cwd, commonDir: path.join(cwd, '.git'), session, peer: true, ...extra });
  const dirs = args => args.flatMap((arg, index) => arg === '--add-dir' ? [args[index + 1]] : []);
  const root = picturesRoot(base), make = (name = `q-${crypto.randomBytes(8).toString('hex')}`) => { const dir = path.join(root, name); fs.mkdirSync(dir, { mode: 0o700 }); return dir; };
  const put = (dir, name, bytes = Buffer.concat([Buffer.from(HEADS.png), crypto.randomBytes(64)])) => { fs.writeFileSync(path.join(dir, name), bytes, { mode: 0o600 }); return dir; };
  const good = put(put(make(), '1.png'), '2.jpg', Buffer.concat([Buffer.from(HEADS.jpg), crypto.randomBytes(64)]));
  assert.equal(mode(root), 0o700); assert.equal(checkRunPictures(good), good);
  assert.deepEqual(dirs(launch({ pictures: good })), [good]); assert.deepEqual(dirs(launch({})), []);
  // Nothing else in the launch changes.
  const withFolder = launch({ pictures: good }), at = withFolder.indexOf('--add-dir');
  assert.deepEqual([...withFolder.slice(0, at), ...withFolder.slice(at + 2)], launch({}));
  const no = /A teammate's pictures must be in ELU Code's own pictures folder\./;
  // Only a teammate's question run, which stays read-only.
  assert.throws(() => claude.compile({ role, cwd, session, pictures: good }), /Only a teammate's question run is given a pictures folder\./);
  assert.throws(() => launch({ pictures: good, mode: 'ask' }), /A peer run stays read-only/);
  // Any other folder: the pictures folder itself, a folder beside it, one of another name, a relative one.
  const beside = path.join(base, 'q-0123456789abcdef'); fs.mkdirSync(beside, { mode: 0o700 }); put(beside, '1.png');
  for (const folder of [root, beside, put(make('pictures'), '1.png'), os.homedir(), cwd, 'q-0123456789abcdef', `${good}/../${path.basename(good)}`, 7]) assert.throws(() => launch({ pictures: folder }), no, String(folder));
  // A link in its path, an empty folder, a folder open to others, and anything in it that is not a picture under a generated name.
  const real = path.join(base, 'elsewhere'); fs.mkdirSync(real, { mode: 0o700 }); put(real, '1.png');
  const link = path.join(root, `q-${crypto.randomBytes(8).toString('hex')}`); fs.symlinkSync(real, link);
  const open = put(make(), '1.png'); fs.chmodSync(open, 0o755);
  const loose = put(make(), '1.png'); fs.chmodSync(path.join(loose, '1.png'), 0o644);
  const words = put(make(), '1.png', Buffer.from('not a picture at all'));
  const extra = put(put(make(), '1.png'), 'notes.txt'), nested = put(make(), '1.png'); fs.mkdirSync(path.join(nested, '2.png'));
  const inner = put(make(), '1.png'); fs.rmSync(path.join(inner, '1.png')); fs.symlinkSync(path.join(good, '1.png'), path.join(inner, '1.png'));
  const five = make(); for (const n of [1, 2, 3, 4, 5]) put(five, `${n}.png`);
  for (const [name, folder] of Object.entries({ link, empty: make(), open, loose, words, extra, nested, inner, five })) assert.throws(() => launch({ pictures: folder }), no, name);
  assert.deepEqual(pictureKind(Buffer.from(HEADS.webp)), ['image/webp', 'webp']); assert.equal(pictureKind(Buffer.from('%PDF-1.7 and more')), null);
});

test('the receiving side takes pieces only from a teammate, checks every picture, keeps them under its own names, and holds its caps', t => {
  const crew = makeTeam(t), ana = crew.founder.identity, sara = crew.member; ownTemp(t);
  withHome(sara.home, () => {
    const { root } = registeredProject(t); share(root, { handle: 'app' });
    const ctx = { me: loadIdentity(), kick() {}, event() {}, push() {} };
    const methods = pictureMethods(ctx, intakeMethods(ctx)), session = { key: ana.key, admitted: true };
    const inDir = peerFile('pictures', 'in', ana.key), waiting = () => fs.existsSync(inDir) ? fs.readdirSync(inDir).sort() : [];
    const piece = (id, bytes, seq, extra = {}) => methods['elu.picture.put']({ id, seq, last: (seq + 1) * PIECE >= bytes.length, size: bytes.length, sha256: sha(bytes), data: bytes.subarray(seq * PIECE, (seq + 1) * PIECE).toString('base64'), ...extra.params }, extra.session ?? session);
    const upload = (bytes, id = crypto.randomUUID()) => { for (let seq = 0; seq * PIECE < bytes.length; seq++) assert.deepEqual(piece(id, bytes, seq), { ok: true }); return id; };
    const send = (text, files, extra = {}) => methods.SendMessage({ message: message({ parts: [textPart(text), ...files], contextId: extra.thread ?? 'thread-p', messageId: extra.id, ext: { kind: 'ask', project: extra.project ?? null, hop: 1, from: { key: ana.key, name: 'ana' } } }) }, session);
    const part = (id, bytes, name = 'shot.png', type = 'image/png') => filePart({ id, name, type, size: bytes.length, sha256: sha(bytes) });
    const tmp = file => { const bytes = picture(path.join(temp(t), file), 2 * PIECE + 5000); return bytes; };

    // Whole, in three pieces, and waiting under its id and size until a message names it.
    const first = tmp('a.png'), id = upload(first);
    assert.deepEqual(waiting(), [`${id}-${first.length}.done`]); assert.equal(mode(path.join(inDir, waiting()[0])), 0o600); assert.equal(mode(inDir), 0o700);
    // Not from a stranger, a connection not admitted, or a muted teammate.
    const small = picture(path.join(temp(t), 's.png'), 900);
    assert.throws(() => piece(crypto.randomUUID(), small, 0, { session: { key: crypto.randomBytes(32).toString('hex'), admitted: true } }), /not on a team with this machine/);
    assert.throws(() => piece(crypto.randomUUID(), small, 0, { session: { key: ana.key, admitted: false } }), /not on a team/);
    savePeerPolicy(ana.key, { muted: true }); assert.throws(() => piece(crypto.randomUUID(), small, 0), /not taking requests from you/); savePeerPolicy(ana.key, { muted: false });
    // Not a picture, too large, out of order, not the size or the bytes it said, or not a piece at all.
    assert.throws(() => piece(crypto.randomUUID(), Buffer.from('#!/bin/sh\necho no\n'), 0), /Only PNG, JPEG, GIF and WebP pictures can be sent\./);
    assert.throws(() => piece(crypto.randomUUID(), small, 0, { params: { size: PICTURE_MAX + 1 } }), /A picture can be up to 8 MB\./);
    assert.throws(() => piece(crypto.randomUUID(), first, 1), /out of order/);
    assert.throws(() => piece(crypto.randomUUID(), small, 0, { params: { size: 100 } }), /not the size it said/);
    assert.throws(() => piece(crypto.randomUUID(), small, 0, { params: { sha256: sha(first) } }), /did not arrive whole/);
    for (const params of [{ id: '../../x' }, { seq: -1 }, { seq: 1.5 }, { last: 'yes' }, { size: 0 }, { sha256: 'abc' }, { data: 'not base64 !' }, { data: 'A'.repeat(Math.ceil(PIECE / 3) * 4 + 4) }]) assert.throws(() => piece(crypto.randomUUID(), small, 0, { params }), /not a piece of a picture|not the size/, JSON.stringify(params).slice(0, 40));
    assert.throws(() => methods['elu.picture.put'](null, session), /not a piece of a picture/);
    assert.deepEqual(waiting(), [`${id}-${first.length}.done`], 'nothing refused is left behind');

    // The message keeps what it names: a generated name on disk, the sender's only as cleaned text.
    const task = send('What is wrong in shot.png here?', [part(id, first, '../../etc/<shot>‮.png')], { id: 'm-1' });
    assert.equal(task.status.state, 'TASK_STATE_SUBMITTED'); assert.equal(task.metadata[PEER_EXT].pictures, 1);
    const record = getRecord(task.id), keptDir = peerFile('pictures', 'kept', ana.key, task.id);
    assert.deepEqual(record.pictures, [{ file: '1.png', name: '....etcshot.png', size: first.length, type: 'image/png' }]);
    assert.equal(record.text, 'What is wrong in shot.png here?');
    assert.deepEqual(fs.readdirSync(keptDir), ['1.png']); assert.ok(fs.readFileSync(path.join(keptDir, '1.png')).equals(first));
    assert.equal(mode(keptDir), 0o700); assert.equal(mode(path.join(keptDir, '1.png')), 0o600); assert.deepEqual(waiting(), []);
    // A repeat of the same message (its reply was lost) keeps the first one's pictures and drops the second upload.
    upload(first, id);
    const repeat = send('What is wrong in shot.png here?', [part(id, first)], { id: 'm-1' });
    assert.equal(repeat.id, task.id); assert.equal(repeat.metadata[PEER_EXT].pictures, 1); assert.deepEqual(waiting(), []); assert.deepEqual(fs.readdirSync(keptDir), ['1.png']);
    // The row and the thread show the name and the size.
    const row = peer.peerItems().find(item => item.kind === 'incoming');
    assert.deepEqual(row.pictures, { list: [{ name: '....etcshot.png', size: first.length }], count: '1 picture', size: sizeText(first.length), text: `....etcshot.png (${sizeText(first.length)})` });
    assert.equal(chatRows()[0], `← @ana asks you with 1 picture (${sizeText(first.length)}) · What is wrong in shot.png here?`);
    assert.deepEqual(peer.threadMessages('thread-p').map(m => m.text), [`What is wrong in shot.png here?\nPictures: ....etcshot.png (${sizeText(first.length)})`]);

    // A picture the message names that never arrived, or arrived as another size, is not kept; the text still is.
    const other = upload(small);
    const none = send('two more', [part(crypto.randomUUID(), small), filePart({ id: other, name: 'x.png', type: 'image/png', size: small.length + 1, sha256: sha(small) })], { id: 'm-2', thread: 'thread-q' });
    assert.equal(none.metadata[PEER_EXT].pictures, 0); assert.equal(getRecord(none.id).pictures, undefined); assert.equal(getRecord(none.id).text, 'two more');
    assert.equal(fs.existsSync(peerFile('pictures', 'kept', ana.key, none.id)), false);
    // A refused message keeps none of what was uploaded for it.
    const lost = upload(small);
    const rejected = send('for a project that is not shared', [part(lost, small)], { id: 'm-3', project: 'nope', thread: 'thread-r' });
    assert.equal(rejected.status.state, 'TASK_STATE_REJECTED'); assert.equal(fs.existsSync(path.join(inDir, `${lost}-${small.length}.done`)), false);
    assert.equal(fs.existsSync(peerFile('pictures', 'kept', ana.key, rejected.id)), false);
    // A message from a build without pictures is taken as before.
    const plain = methods.SendMessage({ message: message({ text: 'plain words', contextId: 'thread-s', ext: { kind: 'ask', project: null, hop: 1, from: { key: ana.key, name: 'ana' } } }) }, session);
    assert.equal(plain.status.state, 'TASK_STATE_SUBMITTED'); assert.equal(plain.metadata, undefined); assert.equal(getRecord(plain.id).pictures, undefined);

    // Caps. Too much on its way is a rate limit the sender tries again; too much kept is a refusal.
    fs.rmSync(inDir, { recursive: true, force: true }); fs.mkdirSync(inDir, { recursive: true });
    const fake = size => { const name = `${crypto.randomUUID()}-${size}.done`; fs.writeFileSync(path.join(inDir, name), 'x'); return path.join(inDir, name); };
    const flying = [fake(FLIGHT_MAX / 2), fake(FLIGHT_MAX / 2)];
    assert.throws(() => piece(crypto.randomUUID(), small, 0), error => error.details?.rpc?.code === -32000 && /Too many pictures at once/.test(error.message));
    // Pieces that waited ten minutes for a message that never came are dropped, and the room is back.
    const old = (Date.now() - 11 * 60000) / 1000; for (const file of flying) fs.utimesSync(file, old, old);
    upload(small); assert.equal(waiting().length, 1); assert.equal(flying.some(file => fs.existsSync(file)), false);
    // Too many on their way is the same rate limit however small they are, and the room is back the same way.
    const many = Array.from({ length: FLIGHT_COUNT - 1 }, () => fake(3)); assert.equal(waiting().length, FLIGHT_COUNT);
    assert.throws(() => piece(crypto.randomUUID(), small, 0), error => error.details?.rpc?.code === -32000 && /Too many pictures at once/.test(error.message));
    assert.equal(waiting().length, FLIGHT_COUNT); for (const file of many) fs.utimesSync(file, old, old);
    upload(small); assert.equal(waiting().length, 2);
    hollow(peerFile('pictures', 'kept', ana.key, 'filler', '1.png'), KEPT_PEER_MAX);
    assert.throws(() => piece(crypto.randomUUID(), small, 0), error => error.details?.rpc === undefined && /This teammate has no room for more pictures from you\./.test(error.message));
    // The hourly sweep drops kept pictures with no record, and a record takes its pictures with it.
    sweepPictures();
    assert.equal(fs.existsSync(peerFile('pictures', 'kept', ana.key, 'filler')), false); assert.deepEqual(fs.readdirSync(keptDir), ['1.png']);
    // Two pictures let in one at a time, each with room of its own, are not both kept when together they pass the
    // cap on all that is kept: it is held where a picture is kept. The text arrives, and the task says how many were kept.
    const size = dir => fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? size(path.join(dir, entry.name)) : fs.lstatSync(path.join(dir, entry.name)).size), 0);
    const others = peerFile('pictures', 'kept', crypto.randomBytes(32).toString('hex'), 'theirs', '1.png'), before = waiting();
    hollow(others, KEPT_MAX - size(peerFile('pictures', 'kept')) - PICTURE_MAX - MB);
    const pair = [1, 2].map(n => picture(path.join(temp(t), `pair${n}.png`), PICTURE_MAX)), pairIds = pair.map(bytes => upload(bytes));
    const tight = send('two large ones', pair.map((bytes, index) => part(pairIds[index], bytes, `${index + 1}.png`)), { id: 'm-4', thread: 'thread-t' });
    assert.equal(tight.status.state, 'TASK_STATE_SUBMITTED'); assert.equal(tight.metadata[PEER_EXT].pictures, 1);
    assert.deepEqual(getRecord(tight.id).pictures.map(row => row.name), ['1.png']); assert.equal(getRecord(tight.id).text, 'two large ones');
    assert.ok(size(peerFile('pictures', 'kept')) <= KEPT_MAX); assert.deepEqual(waiting(), before, 'the one not kept does not wait on');
    fs.rmSync(path.dirname(path.dirname(others)), { recursive: true });
    upload(small);

    // When the question runs: copies in a folder of their own that the launch accepts, named in the teammate's data.
    const origin = { kind: 'ask', peer: ana.key, name: 'ana', a2aTaskId: task.id, threadId: 'thread-p', hop: 1 };
    const seen = picturesForRun(origin);
    assert.match(seen.note, new RegExp(`^Pictures sent with this message, saved as files on this machine:\\n1\\. \\.\\.\\.\\.etcshot\\.png \\(${sizeText(first.length).replace('.', '\\.')}\\): `));
    assert.equal(seen.note.endsWith(path.join(seen.folder, '1.png')), true); assert.equal(checkRunPictures(seen.folder), seen.folder);
    assert.ok(fs.readFileSync(path.join(seen.folder, '1.png')).equals(first)); assert.equal(path.dirname(seen.folder), picturesRoot());
    assert.equal(picturesForRun({ ...origin, a2aTaskId: plain.id }), null); assert.equal(picturesForRun({ ...origin, peer: crypto.randomBytes(32).toString('hex') }), null);
    // With no temporary folder of its own to copy into, the model is told the names and that it could not see them.
    const blocked = path.join(temp(t), 'tmp'); fs.mkdirSync(blocked); fs.writeFileSync(path.join(blocked, 'elu-code-pictures'), 'a file in the way');
    assert.deepEqual(picturesForRun(origin, { temp: blocked }), { folder: null, note: `Pictures sent with this message could not be opened on this machine, so they were not seen: ....etcshot.png (${sizeText(first.length)}).` });

    // Removed with the question's record.
    declineIncoming(ctx, task.id); prune(Date.now() + RETAIN_MS + 60000);
    assert.equal(getRecord(task.id), null); assert.equal(fs.existsSync(keptDir), false);
  });
});

test('a build from before pictures takes the message as text, and a teammate on one gets the text alone while the sender is told', async t => {
  const crew = makeTeam(t), ana = crew.founder, sara = crew.member; const home = temp(t);
  const file = path.join(home, 'shots', 'Shot one.png'), bytes = picture(file, PIECE + 2000);
  // An older receiver: no elu.picture.put, and intake that reads the text parts only.
  await withHome(sara.home, async () => {
    const { root } = registeredProject(t); share(root, { handle: 'app' });
    const ctx = { me: loadIdentity(), kick() {}, event() {} }, old = createRpcHandler({ ...intakeMethods(ctx) });
    const sent = message({ parts: [textPart('What is wrong in Shot one.png here?'), filePart({ id: crypto.randomUUID(), name: 'Shot one.png', type: 'image/png', size: bytes.length, sha256: sha(bytes) })], contextId: 'thread-old', ext: { kind: 'ask', project: null, hop: 1, from: { key: ana.identity.key, name: 'ana' } } });
    const answer = await old({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: sent } }, { key: ana.identity.key });
    assert.equal(answer.result.task.status.state, 'TASK_STATE_SUBMITTED');
    assert.equal(getRecord(answer.result.task.id).text, 'What is wrong in Shot one.png here?'); assert.equal(getRecord(answer.result.task.id).pictures, undefined);
    const unknown = await old({ jsonrpc: '2.0', id: 2, method: 'elu.picture.put', params: {} }, { key: ana.identity.key });
    assert.equal(unknown.error.code, -32601);
    assert.equal(fs.existsSync(peerFile('pictures')), false, 'nothing is written for pictures');
  });
  // The sender against such a teammate: the first piece is refused as unknown, so the text goes alone.
  await withHome(ana.home, async () => {
    const puts = [], messages = [];
    const session = { request: async (method, params) => {
      if (method === 'elu.picture.put') { puts.push(params); throw new EluCodeError('Method not found.', { rpc: { code: -32601 } }); }
      messages.push(params.message); return { task: a2aTask({ id: crypto.randomUUID(), contextId: params.message.contextId }) };
    } };
    const ctx = { me: loadIdentity(), event() {}, kick() {}, dial() {}, session: () => session };
    const typed = attachPictures(`What is wrong in '${file}' here?`, { home });
    const ask = createAsk(ctx, { to: 'sara', text: typed.text, byOwner: true, pictures: stagedPictures(typed.pictures) });
    assert.equal(ask.pictures.list[0].name, 'Shot one.png');
    const done = await until(() => getAsk(ask.id).state === 'submitted' && getAsk(ask.id), 'the text to go');
    assert.equal(puts.length, 1, 'it stops at the first piece'); assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].parts, [{ text: 'What is wrong in Shot one.png here?' }]);
    assert.equal(done.pictures.unsent, 'version'); assert.equal(done.pictures.sentAt, undefined);
    assert.equal(unsentLine(done.pictures, 'sara'), "@sara's ELU Code can't take pictures yet. The text went without them.");
    assert.deepEqual(staged(), [], 'the copies for sending are gone');
    const row = peer.peerItems().find(item => item.kind === 'asked');
    assert.equal(row.pictures.count, '1 picture'); assert.equal(row.pictures.unsent, "@sara's ELU Code can't take pictures yet. The text went without them.");
    assert.equal(chatRows()[0], '→ you asked @sara, 1 picture not sent · What is wrong in Shot one.png here?');
    assert.match(chatRows()[1], /^↳ \S.* · @sara's ELU Code can't take pictures yet\. The text went without them\.$/);
    assert.match(peer.threadMessages(done.threadId)[0].text, /^What is wrong in Shot one\.png here\?\nPictures not sent: Shot one\.png \(\d+ KB\)\n@sara's ELU Code can't take pictures yet\./);
  });
});

test('a teammate that takes pictures gets them in pieces before the message that names them, and one that refuses them gets the text', async t => {
  const crew = makeTeam(t), ana = crew.founder; const home = temp(t);
  const file = path.join(home, 'two.png'), bytes = picture(file, 2 * PIECE + 100);
  await withHome(ana.home, async () => {
    const calls = [];
    const taking = { request: async (method, params) => { calls.push([method, params]); return method === 'elu.picture.put' ? { ok: true } : { task: a2aTask({ id: crypto.randomUUID(), contextId: params.message.contextId, ext: { pictures: 1 } }) }; } };
    const ctx = { me: loadIdentity(), event() {}, kick() {}, dial() {}, session: () => taking };
    const typed = attachPictures(`see ${file}`, { home });
    const ask = createAsk(ctx, { to: 'sara', text: typed.text, byOwner: true, pictures: stagedPictures(typed.pictures) });
    const done = await until(() => getAsk(ask.id).state === 'submitted' && getAsk(ask.id), 'the message to go');
    assert.deepEqual(calls.map(([method]) => method), ['elu.picture.put', 'elu.picture.put', 'elu.picture.put', 'SendMessage']);
    const pieces = calls.slice(0, 3).map(([, params]) => params);
    assert.deepEqual(pieces.map(({ seq, last, size }) => [seq, last, size]), [[0, false, bytes.length], [1, false, bytes.length], [2, true, bytes.length]]);
    assert.ok(Buffer.concat(pieces.map(row => Buffer.from(row.data, 'base64'))).equals(bytes)); assert.ok(pieces.every(row => row.sha256 === sha(bytes) && row.id === ask.pictures.list[0].id));
    // Each piece is one line under the 1 MiB a line may be.
    assert.ok(pieces.every(row => Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 123456, method: 'elu.picture.put', params: row })) < 1024 * 1024));
    const sent = calls[3][1].message;
    assert.deepEqual(sent.parts, [{ text: 'see two.png' }, { url: `urn:elu-code:picture:${ask.pictures.list[0].id}`, filename: 'two.png', mediaType: 'image/png', metadata: { [PEER_EXT]: { size: bytes.length, sha256: sha(bytes) } } }]);
    assert.ok(done.pictures.sentAt); assert.equal(done.pictures.unsent, undefined); assert.equal(unsentLine(done.pictures, 'sara'), null); assert.deepEqual(staged(), []);
    assert.equal(peer.peerItems().find(item => item.kind === 'asked').pictures.unsent, undefined);

    // A teammate with no room says so: the text goes, and the row says why the pictures did not.
    const full = { request: async (method, params) => { if (method === 'elu.picture.put') throw new EluCodeError('This teammate has no room for more pictures from you.', { rpc: { code: -32602 } }); return { task: a2aTask({ id: crypto.randomUUID(), contextId: params.message.contextId }) }; } };
    const again = attachPictures(`see ${file}`, { home });
    const second = createAsk({ ...ctx, session: () => full }, { to: 'sara', text: again.text, byOwner: true, pictures: stagedPictures(again.pictures) });
    const refused = await until(() => getAsk(second.id).state === 'submitted' && getAsk(second.id), 'the text to go');
    assert.equal(unsentLine(refused.pictures, 'sara'), '@sara did not take the pictures: This teammate has no room for more pictures from you.');
    // A teammate that kept fewer than were sent is said too.
    assert.equal(unsentLine({ list: [{}, {}], unsent: 'partly', kept: 1 }, 'sara'), '@sara kept 1 of 2 pictures.');
  });
});

test('only a message the owner typed carries pictures: a model\'s draft, sent by hand or by itself, and any other caller attach nothing', async t => {
  const crew = makeTeam(t), ana = crew.founder, sara = crew.member.identity; const home = temp(t);
  // A short folder: a long path can read as a possible secret, which holds a draft that sends itself.
  const dir = fs.mkdtempSync(path.join(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir(), 'p-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'plan.png'); picture(file, 2000);
  await withHome(ana.home, async () => {
    const calls = [];
    const session = { request: async (method, params) => { calls.push([method, params]); return { task: a2aTask({ id: crypto.randomUUID(), contextId: params.message.contextId }) }; } };
    const ctx = { me: loadIdentity(), event() {}, kick() {}, dial() {}, session: () => session };
    const draft = text => { const id = crypto.randomUUID(); fs.mkdirSync(peerFile('drafts'), { recursive: true }); fs.writeFileSync(peerFile('drafts', `${id}.json`), JSON.stringify({ id, to: 'sara', project: null, question: text, root: null, taskId: null, threadId: null, createdAt: new Date().toISOString(), state: 'draft' })); return id; };
    // A draft a model wrote, sent by the owner's hand: the path is words, never a file.
    const byHand = sendDraft(ctx, draft(`Please look at ${file} for me`), { byOwner: true });
    // The same with the teammate set to take drafts without asking.
    const auto = draft(`And again ${file}`); savePeerPolicy(sara.key, { autoAsk: true }); autoDrafts(ctx);
    const sentAuto = await until(() => JSON.parse(fs.readFileSync(peerFile('drafts', `${auto}.json`), 'utf8')).askId, 'the automatic draft to go');
    await until(() => calls.length === 2, 'both messages');
    for (const id of [byHand.id, sentAuto]) assert.equal(getAsk(id).pictures, undefined);
    assert.deepEqual(calls.map(([method]) => method), ['SendMessage', 'SendMessage']);
    for (const [, params] of calls) { assert.equal(params.message.parts.length, 1); assert.equal(typeof params.message.parts[0].text, 'string'); }
    assert.deepEqual(staged(), [], 'nothing was copied for sending');
    // Even handed staged pictures, anything but the owner's own message is refused.
    const typed = attachPictures(`see ${file}`, { home }), pictures = stagedPictures(typed.pictures);
    assert.throws(() => createAsk(ctx, { to: 'sara', text: typed.text, pictures }), /Only a message you typed can carry pictures\./);
    assert.throws(() => createAsk(ctx, { to: 'sara', kind: 'review', text: typed.text, byOwner: true, pictures }), /Only a message you typed can carry pictures\./);
    // The facade stages pictures for the three commands of the message box and no other.
    for (const type of ['review', 'approve', 'continue', 'discard']) assert.equal(peer.withPictures({ type, text: `see ${file}` }).pictures, undefined, type);
    for (const type of ['ask', 'handoff', 'teamAsk']) { const command = peer.withPictures({ type, to: 'sara', text: `see ${file}` }); assert.equal(command.text, 'see plan.png'); assert.equal(command.pictures.list.length, 1); }
    assert.deepEqual(peer.withPictures({ type: 'ask', to: 'sara', text: 'no picture here' }), { type: 'ask', to: 'sara', text: 'no picture here' });
  });
});

// --- Two daemons on one machine, as in peer-net.test.mjs. ---
const running = new WeakMap();
async function testnet(t, host = '127.0.0.1') {
  const createTestnet = require('hyperdht/testnet.js');
  const net = await createTestnet(3, { host });
  running.set(t, []);
  t.after(async () => {
    await Promise.all(running.get(t).map(stop => stop()));
    await Promise.race([net.destroy(), new Promise(resolve => setTimeout(resolve, 10000))]);
  });
  return net.bootstrap.map(node => `${node.host}:${node.port}`);
}
async function daemon(t, home, { env = {}, ...options } = {}) {
  const child = spawn(process.execPath, [RUNNER, JSON.stringify(options)], { env: { ...process.env, ...env, XDG_CONFIG_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stderr.on('data', data => { err += data; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const ready = await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { out += data; const line = out.split('\n').find(row => row.startsWith('{')); if (line) resolve(JSON.parse(line)); });
    child.once('exit', code => reject(new Error(`daemon exited ${code}: ${err}`)));
  });
  if (!ready.ready) throw new Error(ready.error);
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode) return;
    child.stdin.end(); const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    await exited; clearTimeout(timer);
  };
  running.get(t).push(stop);
  return { ...ready, child, stop };
}
const read = (home, ...parts) => withHome(home, () => { const file = peerFile(...parts); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; });
const online = (home, key) => read(home, 'state.json')?.teams?.some(team => team.members.some(m => m.key === key && m.online));
const item = (home, kind) => withHome(home, () => peer.peerItems()).find(row => row.kind === kind);
async function run(home, command) {
  const { id } = withHome(home, () => peer.sendPeerCommand(command));
  const result = await until(() => read(home, 'commands', `${id}.result.json`), `${command.type} result`);
  if (!result.ok) throw new Error(result.error);
  return result.result;
}

test('a picture typed into a message reaches the teammate whole, shows on both sides, and their model is given it for the run', async t => {
  const bootstrap = await testnet(t), crew = makeTeam(t), ana = crew.founder, sara = crew.member;
  for (const home of [ana.home, sara.home]) withHome(home, () => savePeerSettings({ enabled: true, bootstrap }));
  const { parent, root } = withHome(sara.home, () => registeredProject(t));
  const fake = answeringClis(parent); withHome(sara.home, () => share(root, { handle: 'app' }));
  // The stand-in vendor keeps a copy of whatever is in the folder it was given to read.
  const seenDir = path.join(parent, 'seen'), mark = "const session='12345678", cli = path.join(fake.dir, 'claude');
  fs.writeFileSync(cli, fs.readFileSync(cli, 'utf8').replace(mark, `{const at=args.indexOf('--add-dir');if(at>=0){fs.mkdirSync(${JSON.stringify(seenDir)},{recursive:true});for(const name of fs.readdirSync(args[at+1]))fs.copyFileSync(args[at+1]+'/'+name,${JSON.stringify(seenDir)}+'/'+name);}}\n${mark}`), { mode: 0o755 });
  const tmp = temp(t);
  await daemon(t, ana.home, { conductor: false }); await daemon(t, sara.home, { env: { PATH: fake.env.PATH, TMPDIR: tmp } });
  await until(() => online(ana.home, sara.identity.key) && online(sara.home, ana.identity.key), 'both daemons online');

  const NAME = 'Shot 2026-01-02 at 3.04.05 PM@2x.png', file = path.join(temp(t), 'Application Support', 'Shots', NAME);
  const bytes = picture(file, 2 * PIECE + 4321), size = sizeText(bytes.length);
  // What a terminal writes when the file is dragged into the message box.
  const command = withHome(ana.home, () => peer.withPictures({ type: 'ask', to: 'sara', text: `What is wrong in ${file.replaceAll(' ', '\\ ')} here?` }));
  assert.equal(command.text, `What is wrong in ${NAME} here?`);
  const result = await run(ana.home, command);
  assert.equal(result.pictures, 1);

  // Sara's side: the question with the picture's name and size, the picture kept whole under a generated name.
  const incoming = await until(() => { const row = item(sara.home, 'incoming'); return row?.pictures ? row : null; }, 'the question at Sara');
  assert.equal(incoming.text, `What is wrong in ${NAME} here?`);
  assert.deepEqual(incoming.pictures, { list: [{ name: NAME, size: bytes.length }], count: '1 picture', size, text: `${NAME} (${size})` });
  assert.equal(withHome(sara.home, chatRows)[0], `← @ana asks you with 1 picture (${size}) · What is wrong in ${NAME} here?`);
  const kept = withHome(sara.home, () => peerFile('pictures', 'kept', ana.identity.key, incoming.taskId));
  assert.deepEqual(fs.readdirSync(kept), ['1.png']); assert.ok(fs.readFileSync(path.join(kept, '1.png')).equals(bytes)); assert.equal(mode(path.join(kept, '1.png')), 0o600);
  assert.deepEqual(fs.readdirSync(withHome(sara.home, () => peerFile('pictures', 'in', ana.identity.key))), []);
  // Ana's side: the row says it went with a picture, and the copy made for sending is gone.
  const asked = await until(() => read(ana.home, 'asks', `${result.askId}.json`)?.pictures?.sentAt && read(ana.home, 'asks', `${result.askId}.json`), 'the picture marked as sent');
  assert.equal(asked.pictures.unsent, undefined); assert.equal(asked.text, `What is wrong in ${NAME} here?`);
  assert.deepEqual(item(ana.home, 'asked').pictures, { list: [{ name: NAME, size: bytes.length }], count: '1 picture', size, text: `${NAME} (${size})` });
  assert.equal(withHome(ana.home, chatRows)[0], `→ you asked @sara with 1 picture · What is wrong in ${NAME} here?`);
  assert.deepEqual(withHome(ana.home, staged), []);
  const said = home => withHome(home, () => peer.threadMessages(asked.threadId)).map(m => [m.from, m.text]);
  assert.deepEqual(said(sara.home), [['peer', `What is wrong in ${NAME} here?\nPictures: ${NAME} (${size})`]]);
  assert.deepEqual(said(ana.home), [['me', `What is wrong in ${NAME} here?\nPictures: ${NAME} (${size})`]]);

  // Sara accepts: her model's launch is given one folder under the pictures folder in temp, holding that picture, and its prompt names it.
  await run(sara.home, { type: 'accept', id: incoming.id });
  await until(() => read(ana.home, 'asks', `${result.askId}.json`)?.state === 'answered', 'the answer at Ana');
  const lines = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const launch = lines(path.join(parent, 'inputs.jsonl')).find(row => row.vendor === 'claude' && row.args.includes('--add-dir'));
  assert.ok(launch, 'the launch names a folder');
  const folder = launch.args[launch.args.indexOf('--add-dir') + 1];
  assert.equal(launch.args.filter(arg => arg === '--add-dir').length, 1);
  assert.equal(path.dirname(folder), path.join(fs.realpathSync(tmp), 'elu-code-pictures')); assert.match(path.basename(folder), /^q-[0-9a-f]{16}$/);
  assert.ok(launch.input.includes(`Pictures sent with this message, saved as files on this machine:\n1. ${NAME} (${size}): ${path.join(folder, '1.png')}`), 'the prompt names the picture inside the teammate\'s data');
  assert.ok(launch.input.includes('The peer data block lists pictures the teammate sent'));
  assert.deepEqual(fs.readdirSync(seenDir), ['1.png']); assert.ok(fs.readFileSync(path.join(seenDir, '1.png')).equals(bytes), 'the model could read the picture, whole');
  // The copy made for the run goes when the run ends; the kept one stays with the record.
  await until(() => !fs.existsSync(folder), 'the run\'s copy to be removed');
  assert.ok(fs.existsSync(path.join(kept, '1.png')));
});
