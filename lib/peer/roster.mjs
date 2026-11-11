import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomic, hash, isObject, mkdir, noSymlinks, refuse } from '../util.mjs';
import { waitLock } from '../state.mjs';
import { peerFile, peerRepo } from './paths.mjs';
import { canonical, sign, verify } from './canonical.mjs';
import { validName } from './identity.mjs';

// A team roster is a grow-only set of signed ops (docs/peer-network.md, "Roster").
//
//   op  = {teamId, id, type, by, at, body, sig}
//   id  = sha256 hex of canonical({teamId, type, by, at, body}); for create, teamId is
//         the empty string inside this hashed object, and the team id is the resulting id
//         (so the stored create op has teamId === id).
//   sig = ed25519 by `by` over canonical({id, teamId, type, by, at, body}), i.e. the
//         stored op without sig.
//   at  = integer milliseconds since the epoch. makeOp never goes below the newest op in
//         the local log, so an op always sorts after the ops its author had seen.
//
// Bodies: create {name, founderName} (the founder's display name, which the spec's {name}
// lacks), admit {key, name, role, invite: sha256(secret)}, remove {key}, role {key, role},
// relays {keys}, leave {}, channel {id, name, members}.
//
// A channel is a named group inside the team. Its op sets the whole channel: the name and
// the member keys; no members deletes it. Any active member may create one they are in; a
// channel's members and the team's admins may change it. Every team also has #general,
// which is everyone and needs no op.
//
// fold() -> {id, name, founder, relays, members: [{key, name, role, removed, left, joinedAt}],
// channels: [{id, name, members: [key], createdBy, createdAt}], rejected: [{id, reason}]}. State is the fold of all valid ops sorted by (at, id). Each
// op applies only if its signer holds the needed role at that point: the founder for
// create, an active admin for admit/remove/role/relays, and any active non-founder member
// for their own leave. The founder's role is admin.
// Removal wins: a removed or departed key's later ops are ignored and the key is never
// admitted again. The founder cannot be removed, leave, or change role.
// Ordering trusts `at`, so merge() refuses every new op from a key this machine already
// saw removed or departed (a backdated op cannot bring it back), ops more than SKEW_MS in
// the future, and ops the fold would not apply. Logs on two machines can then differ by
// ops one of them refused; sync keeps offering them and the other keeps refusing.
export const TYPES = Object.freeze(['create', 'admit', 'remove', 'role', 'relays', 'leave', 'channel']);
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,29}$/;
// A member can fill the log only this far: CHANNEL_CHANGES channel ops each, CHANNELS live channels a team.
const CHANNEL_ID = /^[0-9a-f]{16}$/, CHANNELS = 50, CHANNEL_CHANGES = 200, CHANNEL_MEMBERS = 20;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_OP = 4096, MAX_LINE = 8192, MAX_OPS = 10000, MAX_MERGE = 5000, MAX_LOG_BYTES = 16 * 1024 * 1024, SKEW_MS = 10 * 60000;
// Signature checks dominate reading a log, and teams() reads every log several times a
// tick. id binds every signed field but sig, so (id, sig) is checked once per process.
const verified = new Map();
function signed(op) {
  const key = `${op.id}:${op.sig}`;
  if (!verified.has(key)) { if (verified.size >= 50000) verified.clear(); verified.set(key, verify(op.by, unsigned(op), op.sig)); }
  return verified.get(key);
}
const isKey = value => typeof value === 'string' && HEX64.test(value);
export function teamPath(teamId, ...parts) {
  if (!isKey(teamId)) refuse('A team id must be 64 hex characters.');
  return peerFile('teams', teamId, ...parts);
}
const keysOf = (value, names) => isObject(value) && Object.keys(value).sort().join() === [...names].sort().join();
const BODY = {
  create: body => keysOf(body, ['name', 'founderName']) && validName(body.name, 60) && validName(body.founderName),
  admit: body => keysOf(body, ['key', 'name', 'role', 'invite']) && isKey(body.key) && validName(body.name) && ['member', 'admin'].includes(body.role) && isKey(body.invite),
  remove: body => keysOf(body, ['key']) && isKey(body.key),
  role: body => keysOf(body, ['key', 'role']) && isKey(body.key) && ['member', 'admin'].includes(body.role),
  relays: body => keysOf(body, ['keys']) && Array.isArray(body.keys) && body.keys.length <= 16 && body.keys.every(isKey) && new Set(body.keys).size === body.keys.length,
  leave: body => keysOf(body, []),
  channel: body => keysOf(body, ['id', 'name', 'members']) && typeof body.id === 'string' && CHANNEL_ID.test(body.id) && typeof body.name === 'string' && CHANNEL_NAME.test(body.name) && body.name !== 'general'
    && Array.isArray(body.members) && body.members.length <= CHANNEL_MEMBERS && body.members.every(isKey) && new Set(body.members).size === body.members.length,
};
const unsigned = op => ({ id: op.id, teamId: op.teamId, type: op.type, by: op.by, at: op.at, body: op.body });
const opId = ({ teamId, type, by, at, body }) => hash(canonical({ teamId: type === 'create' ? '' : teamId, type, by, at, body }));
// Returns why an op is malformed, or null. Never throws, whatever it is given.
export function opProblem(op) {
  try {
    if (!keysOf(op, ['teamId', 'id', 'type', 'by', 'at', 'body', 'sig'])) return 'The op has missing or unknown fields.';
    if (!isKey(op.teamId) || !isKey(op.id) || !isKey(op.by) || typeof op.sig !== 'string') return 'The op has a malformed id or key.';
    if (!TYPES.includes(op.type)) return 'The op type is unknown.';
    if (!Number.isSafeInteger(op.at) || op.at <= 0) return 'The op time is invalid.';
    if (!BODY[op.type](op.body)) return `The ${op.type} op body is invalid.`;
    if (canonical(op).length > MAX_OP) return 'The op is too large.';
    if (opId(op) !== op.id || (op.type === 'create' && op.teamId !== op.id)) return 'The op id does not match its contents.';
    if (!signed(op)) return 'The op signature is invalid.';
    return null;
  } catch { return 'The op is not valid JSON data.'; }
}
export function validateOp(op) { const reason = opProblem(op); if (reason) refuse(reason); return op; }
export function makeOp(identity, teamId, type, body) {
  if (!TYPES.includes(type)) refuse('Unknown roster op.');
  if (type !== 'create') teamPath(teamId);
  // An op stamped far in the future (kept from before merge refused them) must not freeze the log.
  const newest = type === 'create' ? 0 : readLog(teamId).ops.reduce((max, op) => op.at <= Date.now() + SKEW_MS ? Math.max(max, op.at) : max, 0);
  const draft = { teamId: type === 'create' ? '' : teamId, type, by: identity.key, at: Math.max(Date.now(), newest + 1), body };
  const id = opId(draft), op = { ...draft, id, teamId: type === 'create' ? id : teamId };
  return validateOp({ ...op, sig: sign(identity.seed, unsigned(op)) });
}

const order = (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// Folds any list of ops into team state. Bad and unauthorised ops land in `rejected`;
// duplicates are ignored. With teamId, only that team's create op can start the fold.
export function fold(ops, teamId = null) {
  const rejected = [], seen = new Set(), valid = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    const reason = opProblem(op);
    if (reason) rejected.push({ id: isKey(op?.id) ? op.id : null, reason });
    else if (!seen.has(op.id)) { seen.add(op.id); valid.push(op); }
  }
  const state = { id: null, name: null, founder: null, relays: [] }, members = new Map(), gone = new Set(), channels = new Map(), changes = new Map();
  const active = key => members.has(key) && !members.get(key).removed;
  const admin = key => active(key) && members.get(key).role === 'admin';
  // Someone who leaves the team leaves its channels then; an emptied channel frees its name and its place among CHANNELS.
  const quit = key => { for (const row of [...channels.values()]) { row.members = row.members.filter(k => k !== key); if (!row.members.length) channels.delete(row.id); } };
  const apply = op => {
    if (op.type === 'create') {
      if (teamId && op.id !== teamId) return 'The op belongs to another team.';
      if (state.id) return 'The team already exists.';
      Object.assign(state, { id: op.id, name: op.body.name, founder: op.by });
      members.set(op.by, { key: op.by, name: op.body.founderName, role: 'admin', removed: false, left: false, joinedAt: op.at }); return null;
    }
    if (!state.id) return 'The team does not exist yet.';
    if (op.teamId !== state.id) return 'The op belongs to another team.';
    if (gone.has(op.by)) return 'The signer was removed from the team.';
    if (!active(op.by)) return 'The signer is not a member of the team.';
    if (op.type === 'leave') {
      if (op.by === state.founder) return 'The founder cannot leave the team.';
      Object.assign(members.get(op.by), { removed: true, left: true }); gone.add(op.by); quit(op.by); return null;
    }
    if (op.type === 'channel') {
      const { id, name, members: wanted } = op.body, current = channels.get(id), count = (changes.get(op.by) ?? 0) + 1;
      if (count > CHANNEL_CHANGES) return 'The signer changed channels too many times.';
      if (wanted.some(key => !active(key))) return 'A channel member is not on the team.';
      if (!current) {
        if (!wanted.includes(op.by)) return 'A new channel needs its creator as a member.';
        if (channels.size >= CHANNELS) return 'The team has too many channels.';
      } else if (!current.members.includes(op.by) && !admin(op.by)) return 'Only a channel member can change it.';
      if (wanted.length && [...channels.values()].some(row => row.id !== id && row.name === name)) return 'A channel with that name exists.';
      changes.set(op.by, count);
      if (wanted.length) channels.set(id, { id, name, members: [...wanted], createdBy: current?.createdBy ?? op.by, createdAt: current?.createdAt ?? op.at });
      else channels.delete(id);
      return null;
    }
    if (!admin(op.by)) return 'The signer is not an admin.';
    const { key } = op.body;
    if (op.type === 'admit') {
      if (gone.has(key)) return 'A removed key cannot be admitted again.';
      if (active(key)) return 'The key is already a member.';
      members.set(key, { key, name: op.body.name, role: op.body.role, removed: false, left: false, joinedAt: op.at }); return null;
    }
    if (op.type === 'relays') { state.relays = [...op.body.keys]; return null; }
    if (key === state.founder) return `The founder cannot be ${op.type === 'remove' ? 'removed' : 'given another role'}.`;
    if (!active(key)) return 'The key is not a member of the team.';
    if (op.type === 'remove') { Object.assign(members.get(key), { removed: true }); gone.add(key); quit(key); return null; }
    members.get(key).role = op.body.role; return null;
  };
  for (const op of valid.sort(order)) { const reason = apply(op); if (reason) rejected.push({ id: op.id, reason }); }
  const list = [...members.values()].sort((a, b) => a.joinedAt - b.joinedAt || (a.key < b.key ? -1 : 1)).map(m => ({ ...m }));
  // Someone removed from the team is out of its channels; a channel nobody is left in is gone.
  const rooms = [...channels.values()].map(row => ({ ...row, members: row.members.filter(active) })).filter(row => row.members.length).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  return { ...state, members: list, channels: rooms, rejected };
}

const logFile = teamId => teamPath(teamId, 'log.jsonl');
// Reads a log, skipping (and reporting) lines that are not valid ops for this team.
export function readLog(teamId) {
  const file = logFile(teamId); noSymlinks(file);
  if (!fs.existsSync(file)) return { ops: [], bad: [] };
  if (fs.statSync(file).size > MAX_LOG_BYTES) return { ops: [], bad: [{ line: 0, reason: 'The roster log is too large.' }] };
  const ops = [], bad = [], seen = new Set();
  fs.readFileSync(file, 'utf8').split('\n').forEach((text, index) => {
    if (!text.trim()) return;
    const line = index + 1;
    if (text.length > MAX_LINE) return bad.push({ line, reason: 'The line is too long.' });
    let op; try { op = JSON.parse(text); } catch { return bad.push({ line, reason: 'The line is not JSON.' }); }
    const reason = opProblem(op) ?? (op.teamId !== teamId ? 'The op belongs to another team.' : null);
    if (reason) return bad.push({ line, reason });
    if (ops.length >= MAX_OPS) return bad.push({ line, reason: 'The roster log is full.' });
    if (!seen.has(op.id)) { seen.add(op.id); ops.push(op); }
  });
  return { ops, bad };
}
export function team(teamId) {
  const { ops, bad } = readLog(teamId);
  if (!ops.length) return null;
  const state = fold(ops, teamId); return state.id ? { ...state, bad } : null;
}
export function teams() {
  const dir = peerFile('teams'); noSymlinks(dir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => HEX64.test(name)).sort().flatMap(id => { try { const found = team(id); return found ? [found] : []; } catch { return []; } });
}
export function head(teamId) {
  const ids = readLog(teamId).ops.map(op => op.id).sort();
  return { seq: ids.length, head: hash(ids.join('\n')) };
}
function locked(teamId, fn) { teamPath(teamId); const release = waitLock(peerRepo(), `team-${teamId}`); try { return fn(); } finally { release(); } }
function write(teamId, ops) {
  if (ops.length > MAX_OPS) refuse('The roster log is full.');
  mkdir(path.dirname(logFile(teamId)));
  atomic(logFile(teamId), ops.map(op => `${JSON.stringify(op)}\n`).join(''));
}
// Adds one local op. It must apply on top of the current log, or nothing is written.
export function appendOp(teamId, op) {
  return locked(teamId, () => {
    validateOp(op);
    if (op.teamId !== teamId) refuse('The op belongs to another team.');
    const { ops } = readLog(teamId);
    if (ops.some(x => x.id === op.id)) return { added: false, op };
    const problem = fold([...ops, op], teamId).rejected.find(x => x.id === op.id);
    if (problem) refuse(problem.reason);
    write(teamId, [...ops, op]); return { added: true, op };
  });
}
// Merges ops from a teammate. Only ops the fold applies are written: malformed ops, other
// teams' ops, ops by keys that were never members, ops their signer had no authority for,
// ops stamped over SKEW_MS ahead, and any op by a key this log already shows removed or
// departed are dropped. So a plain member can add nothing but their own leave and channel ops.
export function merge(teamId, incoming, now = Date.now()) {
  if (!Array.isArray(incoming)) refuse('Roster ops must be a list.');
  return locked(teamId, () => {
    const { ops } = readLog(teamId), have = new Set(ops.map(op => op.id)), rejected = [], fresh = [];
    const gone = new Set(ops.length ? fold(ops, teamId).members.filter(m => m.removed).map(m => m.key) : []);
    incoming.forEach((op, index) => {
      const reason = index >= MAX_MERGE ? 'Too many ops in one push.' : opProblem(op) ?? (op.teamId !== teamId ? 'The op belongs to another team.' : op.at > now + SKEW_MS ? 'The op time is in the future.' : gone.has(op.by) ? 'The signer was removed from the team.' : null);
      if (reason) rejected.push({ id: isKey(op?.id) ? op.id : null, reason });
      else if (!have.has(op.id)) { have.add(op.id); fresh.push(op); }
    });
    const refused = new Map(fold([...ops, ...fresh], teamId).rejected.map(x => [x.id, x.reason])), added = [];
    for (const op of fresh) {
      if (refused.has(op.id)) rejected.push({ id: op.id, reason: refused.get(op.id) });
      else added.push(op);
    }
    if (added.length) write(teamId, [...ops, ...added]);
    return { added, rejected };
  });
}
export function opsMissing(teamId, theirIds) {
  if (!Array.isArray(theirIds) || theirIds.length > MAX_OPS * 2) refuse('Roster ids must be a list.');
  const theirs = new Set(theirIds.filter(isKey));
  return readLog(teamId).ops.filter(op => !theirs.has(op.id));
}
// Creates a channel (no id), or sets the name and members of one. No members deletes it.
export function setChannel(identity, teamId, { id = null, name = null, members }) {
  const state = team(teamId); if (!state) refuse('Unknown team.');
  const current = id ? state.channels.find(row => row.id === id) : null;
  if (id && !current) refuse('That channel no longer exists.');
  const label = String(name ?? current?.name ?? '').replace(/^#/, '');
  if (!CHANNEL_NAME.test(label) || label === 'general') refuse('Name a channel with 1 to 30 lowercase letters, digits, - or _. general is taken.');
  if (!Array.isArray(members) || members.length > CHANNEL_MEMBERS || !members.every(isKey)) refuse(`A channel holds up to ${CHANNEL_MEMBERS} teammates.`);
  const op = makeOp(identity, teamId, 'channel', { id: id ?? crypto.randomBytes(8).toString('hex'), name: label, members: [...new Set(members)] });
  appendOp(teamId, op); return { op, id: op.body.id };
}
export function createTeam(identity, name) {
  if (!validName(name, 60)) refuse('Choose a team name of 1 to 60 printable characters.');
  const op = makeOp(identity, '', 'create', { name, founderName: identity.name });
  appendOp(op.id, op); return team(op.id);
}
