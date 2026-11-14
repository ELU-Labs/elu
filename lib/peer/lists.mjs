import crypto from 'node:crypto';
import { isObject, refuse } from '../util.mjs';

// A list one machine tells another whole (docs/peer-network.md, "Tasks" and "Kanban"): the
// Tasks its sessions work on (elu.plans) and its sessions' cards (elu.cards). One that fits
// one message goes in it, as before. A longer one goes in parts, like any other large
// content: elu.list.put requests of at most PART_BYTES each, one after the other, which the
// receiving side joins and takes as that one message once the last part is in. ELU sets no
// limit of its own on how many rows a list holds. A machine says in its hello that it joins
// parts (lists: 1); one that does not is sent the one message it can read.
export const PART_BYTES = 512 * 1024, STAGE_MS = 10 * 60000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The rows as parts, in order: each part within max bytes as JSON. A row is never split.
export function listParts(rows, max = PART_BYTES) {
  const parts = []; let part = [], size = 2;
  for (const row of rows) {
    const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (part.length && size + bytes > max) { parts.push(part); part = []; size = 2; }
    part.push(row); size += bytes;
  }
  if (part.length || !parts.length) parts.push(part);
  return parts;
}
// The sending side: each part is a request the other side answers, so the next goes only once
// the one before is in, paceMs apart so the parts stay within what a connection takes. A part
// the other side found too many at once is sent again shortly; anything else throws, and the
// list is sent again from its first part when it is next told.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function pushList(session, name, parts, { paceMs = 600, retryMs = 1000 } = {}) {
  const id = crypto.randomUUID();
  for (let seq = 0; seq < parts.length; seq++) {
    if (seq) await pause(paceMs);
    for (let tries = 0; ; tries++) {
      try { await session.request('elu.list.put', { list: name, id, seq, last: seq === parts.length - 1, rows: parts[seq] }, { timeoutMs: 60000 }); break; }
      catch (error) { if (error.details?.rpc?.code !== -32000 || tries >= 8) throw error; await pause(retryMs * (tries + 1)); }
    }
  }
}
// The receiving side: the parts of one list are kept with the connection they came on until
// the last is in, then take[list](rows, session) gets them all. A list started again replaces
// the one half here; a part out of order, or one that comes after STAGE_MS without another, is
// refused, and the sender starts again. A connection that ends takes its half lists with it.
export function listPart(params, session, take) {
  if (!session?.admitted) refuse('You are not on a team with this machine.');
  if (!isObject(params) || typeof params.list !== 'string' || !Object.hasOwn(take, params.list) || !UUID.test(params.id ?? '') || !Number.isInteger(params.seq) || params.seq < 0 || typeof params.last !== 'boolean' || !Array.isArray(params.rows)) refuse('That is not a part of a list.');
  const staged = session.lists ??= new Map(), now = Date.now();
  if (params.seq === 0) staged.set(params.list, { id: params.id, next: 0, rows: [], at: now });
  const row = staged.get(params.list);
  // A part sent again (its answer was lost) is in already.
  if (row?.id === params.id && params.seq === row.next - 1 && !params.last) return { ok: true };
  if (!row || row.id !== params.id || params.seq !== row.next || now - row.at > STAGE_MS) { staged.delete(params.list); refuse('That part of the list is out of order.'); }
  for (const value of params.rows) row.rows.push(value);
  row.next += 1; row.at = now;
  if (params.last) { staged.delete(params.list); take[params.list](row.rows, session); }
  return { ok: true };
}
