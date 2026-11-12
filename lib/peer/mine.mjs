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
// A mark made by GitHub pairing (github.mjs) also has auto: "github", the GitHub account id
// and login it was made for, and pairedAt, when both sides first marked each other with it.
// /mine remove leaves refused: true on the row: GitHub pairing never marks that key again
// until the owner marks it himself.
const HEX64 = /^[0-9a-f]{64}$/;
const file = () => peerFile('mine.json');
function readAll() {
  try { noSymlinks(file()); if (!fs.existsSync(file())) return {}; const value = readJson(file()); return isObject(value) ? value : {}; } catch { return {}; }
}
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const clean = row => {
  if (!isObject(row)) return null;
  const at = typeof row.at === 'string' ? row.at : null, auto = Boolean(at) && row.auto === 'github';
  return { at, theirs: row.theirs === true, theirsAt: typeof row.theirsAt === 'string' ? row.theirsAt : null,
    ...(auto ? { auto: 'github', account: Number.isSafeInteger(row.account) ? row.account : null, login: LOGIN.test(row.login ?? '') ? row.login : null, ...(typeof row.pairedAt === 'string' ? { pairedAt: row.pairedAt } : {}) } : {}),
    ...(row.refused === true ? { refused: true } : {}) };
};
const EMPTY = { at: null, theirs: false, theirsAt: null };
function change(key, update) {
  if (!HEX64.test(key ?? '')) refuse('Choose one of your teammates.');
  const release = waitLock(peerRepo(), 'mine');
  try {
    const all = readAll(), before = clean(all[key]) ?? EMPTY, next = clean(update(before));
    // A GitHub mark that just became mine on both sides notes when.
    if (next?.auto && next.at && next.theirs && !next.pairedAt) next.pairedAt = new Date().toISOString();
    else if (next?.auto && !next.theirs) delete next.pairedAt;
    const rest = Object.fromEntries(Object.entries(all).filter(([id]) => id !== key && HEX64.test(id)));
    // A row neither side marks, and that holds no refusal, is dropped.
    atomic(file(), next && (next.at || next.theirs || next.refused) ? { ...rest, [key]: next } : rest);
    return next;
  } finally { release(); }
}
const onTeamWith = (me, key) => teams().some(state => [me, key].every(k => state.members.some(m => m.key === k && !m.removed)));
// Every key this machine marked or that marked it: [{key, mine, theirs, at, auto, login,
// pairedAt, refused}]. auto is "github" for a mark GitHub pairing made, else null.
export function mineRows() {
  return Object.entries(readAll()).filter(([key]) => HEX64.test(key)).map(([key, row]) => ({ key, ...clean(row) }))
    .map(row => ({ key: row.key, mine: Boolean(row.at), theirs: row.theirs, at: row.at, auto: row.auto ?? null, login: row.login ?? null, account: row.account ?? null, pairedAt: row.pairedAt ?? null, refused: row.refused === true }));
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
// Marks key as mine. Only a teammate on a team with this machine can be marked. The owner
// marking it himself makes the mark his own (not GitHub's) and lifts an earlier refusal.
export function markMine(me, key) {
  if (!HEX64.test(key ?? '') || key === me || !onTeamWith(me, key)) refuse('Choose one of your teammates.');
  return change(key, row => ({ at: row.at ?? new Date().toISOString(), theirs: row.theirs, theirsAt: row.theirsAt }));
}
// Takes the mark away. The other machine is told, and then no longer counts this one as its own
// either. The owner said this key is not his: GitHub pairing leaves it alone from now on.
export function unmarkMine(key) { return change(key, row => ({ at: null, theirs: row.theirs, theirsAt: row.theirsAt, refused: true })); }
// The line said when GitHub pairing made a pair.
export const PAIRED_BY_GITHUB = (name, login) => `${name} is yours: both computers are signed in to GitHub as ${login}.`;
// GitHub pairing (github.mjs): key is vouched for by the GitHub account signed in here. True
// when this marked it now. A key the owner refused, one he marked himself, and one on no team
// with this machine are left as they are.
export function autoMarkMine(me, key, { account, login }) {
  if (!HEX64.test(key ?? '') || key === me || !Number.isSafeInteger(account) || !LOGIN.test(login ?? '') || !onTeamWith(me, key)) return false;
  const row = clean(readAll()[key]);
  if (row?.refused || (row?.at && !row.auto) || (row?.auto && row.account === account && row.login === login)) return false;
  change(key, value => value.refused || (value.at && !value.auto) ? value : { ...value, at: value.at ?? new Date().toISOString(), auto: 'github', account, login });
  return !row?.at;
}
// A GitHub mark whose key that account no longer vouches for goes. A mark the owner made stays.
export function autoUnmarkMine(key) {
  const row = clean(readAll()[key]);
  if (!row?.auto) return false;
  change(key, value => value.auto ? { at: null, theirs: value.theirs, theirsAt: value.theirsAt } : value);
  return true;
}
// The GitHub mark on key, when both sides mark each other: {login, pairedAt}, else null.
export function pairedByGithub(key) { const row = clean(readAll()[key]); return row?.auto && row.at && row.theirs ? row : null; }
// What key said about this machine: mine or not. Kept even before this machine marks key,
// so the second /mine completes the pair at once. True when it changed.
export function noteTheirs(key, theirs) {
  const row = clean(readAll()[key]);
  if (Boolean(row?.theirs) === Boolean(theirs)) return false;
  change(key, value => ({ ...value, theirs: theirs === true, theirsAt: new Date().toISOString() }));
  return true;
}
// A key that shares no team with this machine any more is not mine: leaving the last team
// we share, or being removed from it, ends the pair on this side. A /mine remove stays, so a
// key that comes back on a team is still not paired by GitHub until the owner marks it.
// Returns the keys dropped.
const REFUSED = { ...EMPTY, refused: true };
const refusalOnly = row => { const value = clean(row); return Boolean(value?.refused && !value.at && !value.theirs && !value.theirsAt); };
export function dropStrangers(me) {
  const gone = Object.entries(readAll()).filter(([key, row]) => !HEX64.test(key) || (!onTeamWith(me, key) && !refusalOnly(row))).map(([key]) => key);
  if (!gone.length) return [];
  const release = waitLock(peerRepo(), 'mine');
  try {
    const kept = Object.entries(readAll()).flatMap(([key, row]) => !gone.includes(key) ? [[key, row]] : HEX64.test(key) && clean(row)?.refused ? [[key, REFUSED]] : []);
    atomic(file(), Object.fromEntries(kept));
  } finally { release(); }
  return gone;
}
