import fs from 'node:fs';
import { atomic, isObject, noSymlinks, readJson, refuse } from '../util.mjs';
import { waitLock } from '../state.mjs';
import { peerFile, peerRepo } from './paths.mjs';
import { teams } from './roster.mjs';
import { loadIdentity } from './identity.mjs';

// My machines (docs/peer-network.md, "Your other computers"). A teammate's machine counts as
// mine only when both machines say so: this one marked it, and it told this one that it
// marked this machine too. peer/mine.json = {key: {at, theirs, theirsAt}}: at, when this
// machine marked key; theirs, what key said last about this machine. It is kept here only;
// what goes on the wire is elu.mine {mine}, each side's own half.
const HEX64 = /^[0-9a-f]{64}$/;
const file = () => peerFile('mine.json');
function readAll() {
  try { noSymlinks(file()); if (!fs.existsSync(file())) return {}; const value = readJson(file()); return isObject(value) ? value : {}; } catch { return {}; }
}
const clean = row => isObject(row) ? { at: typeof row.at === 'string' ? row.at : null, theirs: row.theirs === true, theirsAt: typeof row.theirsAt === 'string' ? row.theirsAt : null } : null;
function change(key, update) {
  if (!HEX64.test(key ?? '')) refuse('Choose one of your teammates.');
  const release = waitLock(peerRepo(), 'mine');
  try {
    const all = readAll(), next = update(clean(all[key]) ?? { at: null, theirs: false, theirsAt: null });
    const rest = Object.fromEntries(Object.entries(all).filter(([id]) => id !== key && HEX64.test(id)));
    // A row neither side marks is dropped.
    atomic(file(), next && (next.at || next.theirs) ? { ...rest, [key]: next } : rest);
    return next;
  } finally { release(); }
}
const onTeamWith = (me, key) => teams().some(state => [me, key].every(k => state.members.some(m => m.key === k && !m.removed)));
// Every key this machine marked or that marked it: [{key, mine, theirs, at}].
export function mineRows() {
  return Object.entries(readAll()).filter(([key]) => HEX64.test(key)).map(([key, row]) => ({ key, ...clean(row) })).map(row => ({ key: row.key, mine: Boolean(row.at), theirs: row.theirs, at: row.at }));
}
// Whether this machine marked key as mine.
export const markedMine = key => Boolean(clean(readAll()[key])?.at);
// Mine on both sides, and still on a team with this machine: the only keys the remote
// session methods take anything from, and the only ones they send anything to.
export function bothMine(me, key) {
  if (!HEX64.test(key ?? '') || key === me) return false;
  const row = clean(readAll()[key]);
  return Boolean(row?.at && row.theirs) && onTeamWith(me, key);
}
// The same, for this machine's own identity: false when it has none or cannot read it.
export function pairedMine(key) { try { const me = loadIdentity()?.key; return Boolean(me) && bothMine(me, key); } catch { return false; } }
// Marks key as mine. Only a teammate on a team with this machine can be marked.
export function markMine(me, key) {
  if (!HEX64.test(key ?? '') || key === me || !onTeamWith(me, key)) refuse('Choose one of your teammates.');
  return change(key, row => ({ ...row, at: row.at ?? new Date().toISOString() }));
}
// Takes the mark away. The other machine is told, and then no longer counts this one as its own either.
export function unmarkMine(key) { return change(key, row => ({ ...row, at: null })); }
// What key said about this machine: mine or not. Kept even before this machine marks key,
// so the second /mine completes the pair at once.
export function noteTheirs(key, theirs) {
  const row = clean(readAll()[key]);
  if (Boolean(row?.theirs) === Boolean(theirs)) return row;
  return change(key, value => ({ ...value, theirs: theirs === true, theirsAt: new Date().toISOString() }));
}
// A key that shares no team with this machine any more is not mine: leaving the last team
// we share, or being removed from it, ends the pair on this side. Returns the keys dropped.
export function dropStrangers(me) {
  const gone = Object.keys(readAll()).filter(key => !HEX64.test(key) || !onTeamWith(me, key));
  if (!gone.length) return [];
  const release = waitLock(peerRepo(), 'mine');
  try { const all = readAll(); atomic(file(), Object.fromEntries(Object.entries(all).filter(([key]) => !gone.includes(key)))); }
  finally { release(); }
  return gone;
}
