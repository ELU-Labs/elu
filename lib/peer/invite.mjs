import fs from 'node:fs';
import crypto from 'node:crypto';
import { atomic, hash, isObject, noSymlinks, readJson, refuse } from '../util.mjs';
import { waitLock } from '../state.mjs';
import { peerRepo } from './paths.mjs';
import { base32, canonical, unbase32 } from './canonical.mjs';
import { identity, validName } from './identity.mjs';
import { appendOp, makeOp, readLog, team, teamPath } from './roster.mjs';

// An invite code carries a one-time secret. The inviter keeps only sha256(secret), so a
// copied invites.json cannot be used to join. expiresAt is milliseconds since the epoch.
const PREFIX = 'elu-team:v1:';
const HEX64 = /^[0-9a-f]{64}$/;
const DAY = 24 * 3600 * 1000;
const file = teamId => teamPath(teamId, 'invites.json');
function readInvites(teamId) {
  const path = file(teamId); noSymlinks(path);
  if (!fs.existsSync(path)) return [];
  let rows; try { rows = readJson(path); } catch { refuse('The invite list is unreadable.'); }
  if (!Array.isArray(rows)) refuse('The invite list is invalid.');
  return rows.filter(row => isObject(row) && HEX64.test(row.hash ?? '') && Number.isSafeInteger(row.expiresAt) && (row.usedBy === null || HEX64.test(row.usedBy ?? '')));
}
function saveInvites(teamId, rows) { atomic(file(teamId), rows); fs.chmodSync(file(teamId), 0o600); }
function locked(teamId, fn) { teamPath(teamId); const release = waitLock(peerRepo(), `invites-${teamId}`); try { return fn(); } finally { release(); } }
function requireAdmin(me, teamId) {
  const state = team(teamId); if (!state) refuse('That team is not on this machine.');
  const member = state.members.find(m => m.key === me.key);
  if (!member || member.removed || member.role !== 'admin') refuse('Only a team admin can invite.');
  return state;
}
export function createInvite(me, teamId, { hours = 24 } = {}) {
  if (typeof hours !== 'number' || !(hours > 0) || hours > 720) refuse('Invite hours must be above 0 and at most 720.');
  requireAdmin(me, teamId);
  const secret = crypto.randomBytes(32).toString('hex'), now = Date.now(), expiresAt = now + Math.round(hours * 3600 * 1000);
  return locked(teamId, () => {
    // Long-expired rows are dropped so the list stays small; used rows stay a week for retries.
    const rows = readInvites(teamId).filter(row => row.expiresAt > now - 7 * DAY);
    saveInvites(teamId, [...rows, { hash: hash(secret), expiresAt, usedBy: null }]);
    return PREFIX + base32(Buffer.from(canonical({ teamId, inviter: me.key, secret, expiresAt })));
  });
}
export function parseInvite(code) {
  const bad = () => refuse('This invite code is not valid.');
  const text = typeof code === 'string' ? code.trim() : '';
  if (!text.startsWith(PREFIX) || text.length > 600) bad();
  const bytes = unbase32(text.slice(PREFIX.length)); if (!bytes) bad();
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { bad(); }
  if (!isObject(value) || Object.keys(value).sort().join() !== 'expiresAt,inviter,secret,teamId') bad();
  const { teamId, inviter, secret, expiresAt } = value;
  if (![teamId, inviter, secret].every(x => typeof x === 'string' && HEX64.test(x)) || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) bad();
  if (canonical(value) !== bytes.toString('utf8')) bad();
  return { teamId, inviter, secret, expiresAt };
}
// The local identity (an admin of teamId) admits joinerKey. A retry by the same joiner
// returns the original admit op, so a dropped reply does not burn the invite.
export function redeemInvite(teamId, secret, joinerKey, name) {
  if (typeof secret !== 'string' || !HEX64.test(secret)) refuse('This invite is not valid.');
  if (typeof joinerKey !== 'string' || !HEX64.test(joinerKey)) refuse('The joiner key is not valid.');
  if (!validName(name)) refuse('The joiner name is not valid.');
  const me = identity();
  return locked(teamId, () => {
    const rows = readInvites(teamId), digest = hash(secret), row = rows.find(x => x.hash === digest);
    if (!row) refuse('This invite is not valid.');
    if (row.usedBy === joinerKey) {
      const op = readLog(teamId).ops.find(x => x.type === 'admit' && x.body.invite === digest && x.body.key === joinerKey);
      if (op) return op;
    }
    if (row.usedBy) refuse('This invite was already used.');
    if (row.expiresAt <= Date.now()) refuse('This invite has expired.');
    requireAdmin(me, teamId);
    const op = makeOp(me, teamId, 'admit', { key: joinerKey, name, role: 'member', invite: digest });
    appendOp(teamId, op);
    saveInvites(teamId, rows.map(x => x === row ? { ...x, usedBy: joinerKey, usedAt: new Date().toISOString() } : x));
    return op;
  });
}
