import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isObject, noSymlinks, refuse } from '../util.mjs';
import { peerFile } from './paths.mjs';
import { peerPolicy } from './settings.mjs';
import { teams } from './roster.mjs';
import { PEER_EXT, TEXT_URN, a2aError, textRefPart } from './a2a.mjs';
import { lookup } from './taskstore.mjs';
import { PIECE, sizeText } from './pictures.mjs';
import { bothMine, refuser } from './mine.mjs';

// Long messages to a teammate (docs/peer-network.md, "Long messages"). A message whose text
// does not fit in one line on the link (1 MiB) goes before it in elu.text.put pieces, like a
// picture, and the message names it by TEXT_URN. The receiving side stages the pieces in
// texts/in/<sender key>/ and puts the whole text back into the message before intake reads it,
// so a teammate's agent gets every character of a review, a question or a handoff. A message
// to a session on another computer of mine goes the same way (lib/peer/remote.mjs): its
// request names the text ({ id, size, sha256 }), and stagedText gives it back whole.
const MB = 1024 * 1024;
// The most text sent inside the message itself, as JSON; anything longer goes in pieces.
export const INLINE_MAX = 768 * 1024;
// What one text may be, and what one teammate may have on its way. These hold this disk, not
// what an agent is given: 64 MB of text is far more than any model takes in one prompt.
export const LONG_MAX = 64 * MB, LONG_FLIGHT_MAX = 128 * MB, LONG_FLIGHT_COUNT = 8, STAGE_MS = 10 * 60000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAGED = /^([0-9a-f-]{36})-(\d{1,9})\.(part|done)$/;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const folderOf = (...parts) => { const dir = peerFile('texts', ...parts); noSymlinks(dir); return dir; };
const stagedFile = (key, id, size, state) => path.join(folderOf('in', key), `${id}-${size}.${state}`);
export const longText = text => Buffer.byteLength(JSON.stringify(String(text ?? ''))) > INLINE_MAX;

// The sending side. wait() resolves when the next request may go. Returns { part } to name
// in the message, or { unsent: 'version' } from a build that cannot take a long message;
// a refusal or anything else throws, and deliver() says or retries it.
export async function pushText(session, text, wait) {
  const bytes = Buffer.from(text, 'utf8'), id = crypto.randomUUID(), sha256 = sha(bytes), pieces = Math.ceil(bytes.length / PIECE);
  for (let seq = 0; seq < pieces; seq++) {
    await wait();
    try { await session.request('elu.text.put', { id, seq, last: seq === pieces - 1, size: bytes.length, sha256, data: bytes.subarray(seq * PIECE, (seq + 1) * PIECE).toString('base64') }, { timeoutMs: 60000 }); }
    catch (error) { if (error.details?.rpc?.code === -32601) return { unsent: 'version' }; throw error; }
  }
  return { part: textRefPart({ id, size: bytes.length, sha256 }) };
}

// The receiving side. Pieces are taken only from a teammate or a computer of mine, a text at
// a time, into a file named by its id and the size it said; a finished one waits there for
// its message. A piece sent again (its answer was lost) is taken once.
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
  // A computer both sides marked as mine is taken from whatever its teammate setting says.
  const mine = session.admitted === true && bothMine(ctx.me.key, key);
  if (!session.admitted || !mine && !teams().some(team => active(team, ctx.me.key) && active(team, key))) refuse('You are not on a team with this machine.');
  // To another computer of this owner's, by either side's mark, a refusal says computer, never teammate.
  if (!mine && peerPolicy(key).muted) refuse(`This ${refuser(key)} is not taking requests from you.`);
  const piece = 'That is not a piece of a message.';
  if (!isObject(params) || !UUID.test(params.id ?? '') || !Number.isInteger(params.seq) || params.seq < 0 || typeof params.last !== 'boolean' || !Number.isInteger(params.size) || params.size < 1 || !/^[0-9a-f]{64}$/.test(params.sha256 ?? '') || typeof params.data !== 'string') refuse(piece);
  if (params.size > LONG_MAX) refuse(`A message to this ${refuser(key)} can be up to ${sizeText(LONG_MAX)}.`);
  if (params.data.length > Math.ceil(PIECE / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(params.data)) refuse(piece);
  const bytes = Buffer.from(params.data, 'base64'), dir = folderOf('in', key);
  const part = stagedFile(key, params.id, params.size, 'part'), done = stagedFile(key, params.id, params.size, 'done');
  const drop = line => { fs.rmSync(part, { force: true }); refuse(line); };
  if (!bytes.length || bytes.length > PIECE || params.seq * PIECE + bytes.length > params.size || (!params.last && bytes.length !== PIECE)) drop('That message is not the size it said.');
  if (params.seq === 0) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.rmSync(part, { force: true }); fs.rmSync(done, { force: true });
    const waiting = sweepStaged(dir), flight = waiting.reduce((sum, row) => sum + row.size, 0);
    // Too much on its way is said as a rate limit, which the sender tries again.
    if (flight + params.size > LONG_FLIGHT_MAX || waiting.length >= LONG_FLIGHT_COUNT) throw a2aError(-32000, 'Too many long messages at once. Try again shortly.');
    fs.writeFileSync(part, bytes, { mode: 0o600, flag: 'wx' });
  } else {
    let size = -1; try { noSymlinks(part); size = fs.lstatSync(part).size; } catch { size = -1; }
    // The last piece sent again: the text is whole already.
    if (size < 0 && params.last) { try { noSymlinks(done); if (fs.lstatSync(done).size === params.size) return { ok: true }; } catch { /* Not here: out of order. */ } }
    if (size === params.seq * PIECE + bytes.length) { /* Sent again: already here. */ }
    else if (size === params.seq * PIECE) fs.appendFileSync(part, bytes);
    else drop('That piece of the message is out of order.');
  }
  if (params.last) {
    const whole = fs.readFileSync(part);
    if (whole.length !== params.size || sha(whole) !== params.sha256) drop('That message did not arrive whole.');
    try { new TextDecoder('utf-8', { fatal: true }).decode(whole); } catch { drop('That message is not text.'); }
    fs.renameSync(part, done);
  }
  return { ok: true };
}
// A finished text from key, by what names it: { text, drop() }, drop() once its message was
// taken. One that is not here whole is said as a rate limit, so the sender sends the pieces again.
export function stagedText(key, ref) {
  if (!isObject(ref) || !UUID.test(ref.id ?? '') || !Number.isInteger(ref.size) || ref.size < 1 || ref.size > LONG_MAX || typeof ref.sha256 !== 'string') refuse('That message names a text it does not carry.');
  const file = stagedFile(key, ref.id, ref.size, 'done'); let bytes = null;
  try { noSymlinks(file); bytes = fs.readFileSync(file); } catch { bytes = null; }
  if (!bytes || bytes.length !== ref.size || sha(bytes) !== ref.sha256) throw a2aError(-32000, 'The long text of this message has not arrived. Send it again.');
  return { text: bytes.toString('utf8'), drop: () => fs.rmSync(file, { force: true }) };
}
const named = part => typeof part?.url === 'string' && part.url.startsWith(TEXT_URN);
// Before intake reads a message: each text it names, whole, in the place of its name. A
// repeat of a message already taken (its reply was lost) goes on as it came, to the answer
// the first one got. One whose text is not here is said as a rate limit, so the sender sends
// the pieces again.
function withText(key, params) {
  const message = params?.message;
  if (!Array.isArray(message?.parts) || !message.parts.some(named)) return params;
  if (lookup(key, message.messageId)) return params;
  const taken = [];
  const parts = message.parts.map(part => {
    if (!named(part)) return part;
    const staged = stagedText(key, { id: part.url.slice(TEXT_URN.length), size: part.metadata?.[PEER_EXT]?.size, sha256: part.metadata?.[PEER_EXT]?.sha256 });
    taken.push(staged);
    return { text: staged.text };
  });
  for (const staged of taken) staged.drop();
  return { ...params, message: { ...message, parts } };
}
// The daemon's methods with long messages: elu.text.put, and SendMessage reading them.
export function textMethods(ctx, methods) {
  return { ...methods, 'elu.text.put': (params, session) => put(ctx, params, session), SendMessage: (params, session) => methods.SendMessage(withText(session.key, params), session) };
}
// Hourly: staged pieces past their time.
export function sweepTexts(now = Date.now()) {
  let keys = []; try { keys = fs.readdirSync(folderOf('in')); } catch { return; }
  for (const key of keys) { const dir = path.join(folderOf('in'), key); if (!sweepStaged(dir, now).length) fs.rmSync(dir, { recursive: true, force: true }); }
}
