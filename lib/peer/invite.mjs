import fs from 'node:fs';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { atomic, hash, isObject, noSymlinks, readJson, refuse } from '../util.mjs';
import { waitLock } from '../state.mjs';
import { peerRepo } from './paths.mjs';
import { canonical, publicKeyHex, sign, unbase32, verify } from './canonical.mjs';
import { identity, validName } from './identity.mjs';
import { appendOp, latestAdmit, makeOp, readLog, team, teamPath, teams } from './roster.mjs';
import { LONG_PREFIX, newCode, readCode } from './invite-code.mjs';

// Invites (docs/peer-network.md, "Invites"). A code is 12 characters (invite-code.mjs).
// It names no team and no key: the inviter's daemon waits on a network topic derived from
// the code, the joiner finds it there, and each proves to the other that it knows the code
// before the inviter says which team it is. expiresAt is milliseconds since the epoch.
//
// invites.json keeps, for each code: the topic, the key the inviter proves itself with, and
// the public key a joiner's proof is checked against. Never the code, and nothing a joiner
// proves itself with, so a copied invites.json cannot be used to join. A row from 0.1.3 or
// earlier has only hash: sha256 of the secret its long code carries. A short row's hash is
// sha256 of "short:" and its verifier, which no long code's secret hashes to, so a 0.1.3
// daemon that reads this file cannot be made to admit the verifier as a secret.
const HEX64 = /^[0-9a-f]{64}$/;
const DAY = 24 * 3600 * 1000;
// A used short invite is answered for 10 minutes more, for its joiner only, in case the
// reply that admitted them was lost.
export const RETRY_MS = 10 * 60000;
const file = teamId => teamPath(teamId, 'invites.json');
const shortRow = row => 'topic' in row || 'prover' in row || 'verifier' in row;
const validRow = row => isObject(row) && HEX64.test(row.hash ?? '') && Number.isSafeInteger(row.expiresAt) && (row.usedBy === null || HEX64.test(row.usedBy ?? ''))
  && (!shortRow(row) || [row.topic, row.prover, row.verifier].every(value => HEX64.test(value ?? '')));
function readInvites(teamId) {
  const path = file(teamId); noSymlinks(path);
  if (!fs.existsSync(path)) return [];
  let rows; try { rows = readJson(path); } catch { refuse('The invite list is unreadable.'); }
  if (!Array.isArray(rows)) refuse('The invite list is invalid.');
  return rows.filter(validRow);
}
function saveInvites(teamId, rows) { atomic(file(teamId), rows); fs.chmodSync(file(teamId), 0o600); }
function locked(teamId, fn) { teamPath(teamId); const release = waitLock(peerRepo(), `invites-${teamId}`); try { return fn(); } finally { release(); } }
function requireAdmin(me, teamId) {
  const state = team(teamId); if (!state) refuse('That team is not on this machine.');
  const member = state.members.find(m => m.key === me.key);
  if (!member || member.removed || member.role !== 'admin') refuse('Only a team admin can invite.');
  return state;
}

// What a code derives. scrypt makes each guess at a code cost 64 MiB of memory and a
// fraction of a second, so the topic, which anyone on the DHT near it can see, does not give
// the code away: trying every code would take hundreds of thousands of GPU-years, and a
// code lasts a day. scrypt is in Node itself; argon2 is not in Node 22. The three keys come
// from the one scrypt output through HKDF, so knowing the topic gives neither proof key.
//   topic:    the 32-byte Hyperswarm topic the inviter announces on
//   prover:   HMAC key for the inviter's proof
//   seed:     ed25519 seed for the joiner's proof (only the joiner computes it)
//   verifier: the public key of seed, which the inviter keeps to check the joiner's proof
export const SCRYPT = Object.freeze({ N: 2 ** 16, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
const SALT = 'elu-code invite code';
const scrypt = promisify(crypto.scrypt);
const known = new Map();
function expand(code, master) {
  const part = info => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `elu-code invite ${info}`, 32));
  const seed = part('joiner proof'), keys = { topic: part('topic').toString('hex'), prover: part('inviter proof').toString('hex'), verifier: publicKeyHex(seed) };
  Object.defineProperty(keys, 'seed', { value: seed });
  known.set(code, Object.freeze(keys)); if (known.size > 16) known.delete(known.keys().next().value);
  return known.get(code);
}
const plain = code => { const read = readCode(code); if (!read?.short) refuse('This invite code is not valid.'); return read.short; };
export function inviteKeys(code) {
  const short = plain(code);
  return known.get(short) ?? expand(short, crypto.scryptSync(short.replace(/-/g, ''), SALT, 32, SCRYPT));
}
// The same, without holding the daemon's event loop while scrypt runs.
export async function inviteKeysAsync(code) {
  const short = plain(code);
  return known.get(short) ?? expand(short, await scrypt(short.replace(/-/g, ''), SALT, 32, SCRYPT));
}

// The proofs. Each covers both fresh nonces and both Noise public keys of the one
// connection, so a proof cannot be replayed on another connection, and a relay that does
// not know the code (it has its own key on each side) cannot pass one along.
const transcript = (role, f) => ({ proof: 'elu-code invite', role, topic: f.topic, joinerNonce: f.joinerNonce, inviterNonce: f.inviterNonce, inviter: f.inviter, joiner: f.joiner });
const fieldsValid = f => isObject(f) && ['topic', 'joinerNonce', 'inviterNonce', 'inviter', 'joiner'].every(name => HEX64.test(f[name] ?? ''));
export const inviterProof = (prover, f) => crypto.createHmac('sha256', Buffer.from(prover, 'hex')).update(canonical(transcript('inviter', f))).digest('hex');
export function checkInviterProof(prover, f, proof) {
  if (!fieldsValid(f) || !HEX64.test(prover ?? '') || typeof proof !== 'string' || !HEX64.test(proof)) return false;
  return crypto.timingSafeEqual(Buffer.from(inviterProof(prover, f), 'hex'), Buffer.from(proof, 'hex'));
}
export const joinerProof = (seed, f) => sign(seed, transcript('joiner', f));
export const checkJoinerProof = (verifier, f, proof) => fieldsValid(f) && verify(verifier, transcript('joiner', f), proof);

// mine: a code for another computer of the inviter's own. Making it is the inviter's yes;
// the machine it admits is asked on its own screen, and only its explicit yes, sent as
// elu.mine, makes this machine mark it (takeMineOffer, lib/peer/mine.mjs).
export function createInvite(me, teamId, { hours = 24, mine = false } = {}) {
  if (typeof hours !== 'number' || !(hours > 0) || hours > 720) refuse('Invite hours must be above 0 and at most 720.');
  requireAdmin(me, teamId);
  const code = newCode(), keys = inviteKeys(code), now = Date.now(), expiresAt = now + Math.round(hours * 3600 * 1000);
  return locked(teamId, () => {
    // Long-expired rows are dropped so the list stays small; used rows stay a week for retries.
    const rows = readInvites(teamId).filter(row => row.expiresAt > now - 7 * DAY);
    saveInvites(teamId, [...rows, { hash: hash(`short:${keys.verifier}`), expiresAt, usedBy: null, topic: keys.topic, prover: keys.prover, verifier: keys.verifier, ...(mine === true ? { mine: true } : {}) }]);
    return code;
  });
}
// {short: 'k7qm-x2pd-9fhw'}, or for a long code from 0.1.3 or earlier {teamId, inviter, secret, expiresAt}.
export function parseInvite(code) {
  const bad = () => refuse('This invite code is not valid.');
  const read = readCode(code); if (!read) bad();
  if (read.short) return { short: read.short };
  const bytes = unbase32(read.long.slice(LONG_PREFIX.length)); if (!bytes) bad();
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { bad(); }
  if (!isObject(value) || Object.keys(value).sort().join() !== 'expiresAt,inviter,secret,teamId') bad();
  const { teamId, inviter, secret, expiresAt } = value;
  if (![teamId, inviter, secret].every(x => typeof x === 'string' && HEX64.test(x)) || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) bad();
  if (canonical(value) !== bytes.toString('utf8')) bad();
  return { teamId, inviter, secret, expiresAt };
}
// The short invites on the given teams, each with its team id, that are still open; with
// retries, also those used less than RETRY_MS ago, which only their joiner may use again.
const retrying = (row, now) => row.usedBy !== null && now - Date.parse(row.usedAt) < RETRY_MS;
export function openInvites(teamIds, now = Date.now(), { retries = false } = {}) {
  return teamIds.flatMap(teamId => { try { return readInvites(teamId).filter(row => shortRow(row) && row.expiresAt > now && (row.usedBy === null || retries && retrying(row, now))).map(row => ({ teamId, ...row })); } catch { return []; } });
}

// The local identity (an admin of teamId) admits joinerKey through the invite row whose
// hash is digest. A key that left or was removed is admitted again the same way. A retry by
// the same joiner returns the original admit op while that admit still stands, so a dropped
// reply does not burn the invite.
function admit(teamId, digest, joinerKey, name, short) {
  if (typeof joinerKey !== 'string' || !HEX64.test(joinerKey)) refuse('The joiner key is not valid.');
  if (!validName(name)) refuse('The joiner name is not valid.');
  const me = identity();
  return locked(teamId, () => {
    const rows = readInvites(teamId), row = rows.find(x => x.hash === digest && shortRow(x) === short);
    if (!row) refuse('This invite is not valid.');
    // A retry gets the admit only while it still stands: the key is on the team, by that
    // admit. One removed since (or gone and back by another invite) needs a new invite.
    if (row.usedBy === joinerKey) {
      const { ops } = readLog(teamId), op = ops.find(x => x.type === 'admit' && x.body.invite === digest && x.body.key === joinerKey), state = team(teamId);
      if (op && state?.members.some(m => m.key === joinerKey && !m.removed) && latestAdmit(ops, joinerKey, teamId)?.id === op.id) return op;
    }
    if (row.usedBy) refuse('This invite was already used.');
    if (row.expiresAt <= Date.now()) refuse('This invite has expired.');
    // Someone who left the team or was removed from it comes back with a new admit; someone
    // still on it is told so, and the invite stays unused.
    const state = requireAdmin(me, teamId);
    if (state.members.some(m => m.key === joinerKey && !m.removed)) refuse('You are already on this team.');
    const op = makeOp(me, teamId, 'admit', { key: joinerKey, name, role: 'member', invite: digest });
    appendOp(teamId, op);
    saveInvites(teamId, rows.map(x => x === row ? { ...x, usedBy: joinerKey, usedAt: new Date().toISOString() } : x));
    return op;
  });
}
// A long code's secret (0.1.3 and earlier). A short invite is never redeemed this way.
export function redeemInvite(teamId, secret, joinerKey, name) {
  if (typeof secret !== 'string' || !HEX64.test(secret)) refuse('This invite is not valid.');
  return admit(teamId, hash(secret), joinerKey, name, false);
}
// A short invite, once the joiner's proof has been checked against its verifier.
export const admitProven = (row, joinerKey, name) => admit(row.teamId, row.hash, joinerKey, name, true);
// On the inviter's machine, with the code in hand: admits joinerKey without the network.
// The joiner of one of my mine codes said yes: true once, for the key that code admitted,
// within a week of the join, while the row is kept. Taken, it is never taken again, so a
// machine I later stop counting as mine cannot come back by saying yes again.
export function takeMineOffer(teamIds, key, now = Date.now()) {
  if (!HEX64.test(key ?? '')) return false;
  for (const teamId of teamIds) {
    const taken = locked(teamId, () => {
      const rows = readInvites(teamId), row = rows.find(x => x.mine === true && x.usedBy === key && !x.mineTaken && Date.parse(x.usedAt ?? '') > now - 7 * DAY);
      if (!row) return false;
      saveInvites(teamId, rows.map(x => x === row ? { ...x, mineTaken: new Date(now).toISOString() } : x));
      return true;
    });
    if (taken) return true;
  }
  return false;
}
export function redeemCode(code, joinerKey, name) {
  const { topic } = inviteKeys(code), row = openInvites(teams().map(state => state.id)).find(x => x.topic === topic);
  if (!row) refuse('This invite is not valid.');
  return admitProven(row, joinerKey, name);
}
