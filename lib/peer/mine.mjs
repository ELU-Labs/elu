import fs from 'node:fs';
import { atomic, isObject, noSymlinks, readJson, refuse } from '../util.mjs';
import { waitLock } from '../state.mjs';
import { peerFile, peerRepo } from './paths.mjs';
import { teams } from './roster.mjs';
import { loadIdentity } from './identity.mjs';
import { sign, verify } from './canonical.mjs';

// My machines (docs/peer-network.md, "Your other computers"). A teammate's machine counts as
// mine only when both machines say so: this one marked it, and it told this one that it
// marked this machine too. peer/mine.json = {key: {at, theirs, theirsAt}}: at, when this
// machine marked key; theirs, what key said last about this machine. It is kept here only;
// what goes on the wire is elu.mine {mine}, each side's own half.
// A mark made by GitHub pairing (github.mjs) also has auto: "github", the GitHub account id
// and login it was made for, and pairedAt, when both sides first marked each other with it.
// /mine remove leaves refused: true on the row: GitHub pairing never marks that key again
// until the owner marks it himself. refusedAt: when he said so, here or on another computer
// of his (takeVouches).
// A mark made because another computer of the owner's said the key is his (takeVouches) has
// auto: "vouch" and by, that computer's key. older: the key's ELU is from before vouches, so
// it cannot take one (the daemon notes it from the key's hello).
const HEX64 = /^[0-9a-f]{64}$/;
const file = () => peerFile('mine.json');
function readAll() {
  try { noSymlinks(file()); if (!fs.existsSync(file())) return {}; const value = readJson(file()); return isObject(value) ? value : {}; } catch { return {}; }
}
const LOGIN = /^[A-Za-z0-9-]{1,39}$/, WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const clean = row => {
  if (!isObject(row)) return null;
  const at = typeof row.at === 'string' ? row.at : null, auto = Boolean(at) && row.auto === 'github', vouched = Boolean(at) && row.auto === 'vouch' && HEX64.test(row.by ?? '');
  return { at, theirs: row.theirs === true, theirsAt: typeof row.theirsAt === 'string' ? row.theirsAt : null,
    ...(auto ? { auto: 'github', account: Number.isSafeInteger(row.account) ? row.account : null, login: LOGIN.test(row.login ?? '') ? row.login : null, ...(typeof row.pairedAt === 'string' ? { pairedAt: row.pairedAt } : {}) } : {}),
    ...(vouched ? { auto: 'vouch', by: row.by } : {}),
    ...(row.refused === true ? { refused: true, ...(WHEN.test(row.refusedAt ?? '') ? { refusedAt: row.refusedAt } : {}) } : {}),
    ...(row.older === true ? { older: true } : {}) };
};
const EMPTY = { at: null, theirs: false, theirsAt: null };
function change(key, update) {
  if (!HEX64.test(key ?? '')) refuse('Choose one of your teammates.');
  const release = waitLock(peerRepo(), 'mine');
  try {
    const all = readAll(), before = clean(all[key]) ?? EMPTY, next = clean(update(before));
    // A GitHub mark that just became mine on both sides notes when.
    if (next?.auto === 'github' && next.at && next.theirs && !next.pairedAt) next.pairedAt = new Date().toISOString();
    else if (next?.auto === 'github' && !next.theirs) delete next.pairedAt;
    const rest = Object.fromEntries(Object.entries(all).filter(([id]) => id !== key && HEX64.test(id)));
    // A row neither side marks, and that holds no refusal, is dropped.
    atomic(file(), next && (next.at || next.theirs || next.refused) ? { ...rest, [key]: next } : rest);
    return next;
  } finally { release(); }
}
const onTeamWith = (me, key) => teams().some(state => [me, key].every(k => state.members.some(m => m.key === k && !m.removed)));
// Every key this machine marked or that marked it: [{key, mine, theirs, at, theirsAt, auto,
// login, pairedAt, refused, by, older}]. auto is "github" for a mark GitHub pairing made,
// "vouch" for one another computer of the owner's made (by: its key), else null.
// theirsAt: when key last said what it says about this machine.
export function mineRows() {
  return Object.entries(readAll()).filter(([key]) => HEX64.test(key)).map(([key, row]) => ({ key, ...clean(row) }))
    .map(row => ({ key: row.key, mine: Boolean(row.at), theirs: row.theirs, at: row.at, theirsAt: row.theirsAt ?? null, auto: row.auto ?? null, login: row.login ?? null, account: row.account ?? null, pairedAt: row.pairedAt ?? null, refused: row.refused === true, by: row.by ?? null, older: row.older === true }));
}
// Whether this machine marked key as mine.
export const markedMine = key => Boolean(clean(readAll()[key])?.at);
// What a refusal sent to key calls this machine: to another computer of its owner's, by
// either side's mark, it is a computer, never a teammate.
export const refuser = key => { const row = clean(readAll()[key]); return row?.at || row?.theirs ? 'computer' : 'teammate'; };
// Mine on both sides, and still on a team with this machine: the only keys the remote
// session methods take anything from, and the only ones they send anything to.
export function bothMine(me, key) {
  if (!HEX64.test(key ?? '') || key === me) return false;
  const row = clean(readAll()[key]);
  return Boolean(row?.at && row.theirs) && onTeamWith(me, key);
}
// The same, for this machine's own identity: false when it has none or cannot read it.
export function pairedMine(key) { try { const me = loadIdentity()?.key; return Boolean(me) && bothMine(me, key); } catch { return false; } }
// A name as names are matched: no spaces or @, lower case.
export const plainName = value => String(value ?? '').replace(/[\s@]+/g, '').toLowerCase();
// The names the owner goes by: this machine's, those of his other computers on a team with it,
// and the ones in also. Only what a computer from before says is read by them: it names who
// started a session, and by name alone. Names are not unique: one that a teammate who is not his also goes by on a
// team with this machine says nothing, and is left out. None when the teams cannot be read.
export function ownNames(me, also = []) {
  const ours = new Set(also.map(plainName)), theirs = new Set();
  try {
    for (const team of teams()) if (team.members.some(m => m.key === me && !m.removed)) for (const m of team.members) if (!m.removed) (m.key === me || bothMine(me, m.key) ? ours : theirs).add(plainName(m.name));
  } catch { return new Set(); }
  for (const name of theirs) ours.delete(name);
  ours.delete(''); return ours;
}
// Marks key as mine. Only a teammate on a team with this machine can be marked. The owner
// marking it himself makes the mark his own (not GitHub's) and lifts an earlier refusal.
export function markMine(me, key) {
  if (!HEX64.test(key ?? '') || key === me || !onTeamWith(me, key)) refuse('Choose one of your teammates.');
  return change(key, row => ({ at: row.at ?? new Date().toISOString(), theirs: row.theirs, theirsAt: row.theirsAt, ...(row.older ? { older: true } : {}) }));
}
// Takes the mark away. The other machine is told, and then no longer counts this one as its own
// either. The owner said this key is not his: GitHub pairing leaves it alone from now on.
export function unmarkMine(key) { return change(key, row => ({ at: null, theirs: row.theirs, theirsAt: row.theirsAt, refused: true, refusedAt: new Date().toISOString() })); }
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
  if (row?.auto !== 'github') return false;
  change(key, value => value.auto === 'github' ? { at: null, theirs: value.theirs, theirsAt: value.theirsAt } : value);
  return true;
}
// The GitHub mark on key, when both sides mark each other: {login, pairedAt}, else null.
export function pairedByGithub(key) { const row = clean(readAll()[key]); return row?.auto === 'github' && row.at && row.theirs ? row : null; }
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
// Agreeing on one computer of the owner's is enough for all of them (docs/peer-network.md,
// "Your other computers"). Each computer that is his on both sides tells the others, signed,
// which computers it holds as his (mine, since at) and which he said are not (not mine, since
// refusedAt): vouches. The other takes it only from a computer that is his on both sides
// (takeVouches). A teammate's computer never vouches.
const FACTS_MAX = 64;
export function ownFacts(me, to) {
  const facts = [];
  for (const [key, value] of Object.entries(readAll())) {
    const row = clean(value);
    if (!row || !HEX64.test(key) || key === me || key === to) continue;
    if (row.at && row.theirs && bothMine(me, key)) facts.push({ key, mine: true, at: row.at });
    else if (!row.at && row.refused && row.refusedAt) facts.push({ key, mine: false, at: row.refusedAt });
  }
  return facts.sort((a, b) => a.key.localeCompare(b.key)).slice(0, FACTS_MAX);
}
// What this machine (identity, with its seed) sends to another computer of the owner's: the
// facts, for that computer only, signed.
export function vouches(identity, to, facts = ownFacts(identity.key, to)) {
  const body = { by: identity.key, to, facts };
  return { ...body, sig: sign(identity.seed, body) };
}
// What another computer of the owner's (from) said, on its own connection: each key it holds
// as his and that shares a team with this machine is marked here, unless he said here, later,
// that it is not his (or said so before refusedAt was kept); each key he said is not his is
// unmarked here, unless it was marked here later. The newer word wins. Returns the keys
// marked and unmarked, which the daemon tells (elu.mine).
export function takeVouches(me, from, message) {
  if (!bothMine(me, from)) refuse('Only your own computers say which computers are yours.');
  if (!isObject(message) || message.by !== from || message.to !== me || !Array.isArray(message.facts) || typeof message.sig !== 'string' || !verify(from, { by: message.by, to: message.to, facts: message.facts }, message.sig)) refuse('That list is not signed by the computer that sent it.');
  const marked = [], unmarked = [];
  for (const fact of message.facts.slice(0, FACTS_MAX)) {
    if (!isObject(fact) || !HEX64.test(fact.key ?? '') || fact.key === me || fact.key === from || typeof fact.mine !== 'boolean' || !WHEN.test(fact.at ?? '')) continue;
    const row = clean(readAll()[fact.key]);
    if (fact.mine) {
      if (row?.at || (row?.refused && !(row.refusedAt < fact.at)) || !onTeamWith(me, fact.key)) continue;
      change(fact.key, value => ({ at: fact.at, theirs: value.theirs, theirsAt: value.theirsAt, auto: 'vouch', by: from, ...(value.older ? { older: true } : {}) }));
      marked.push(fact.key);
    } else {
      if ((row?.at && !(row.at < fact.at)) || (row?.refusedAt && !(row.refusedAt < fact.at)) || (!row?.at && !onTeamWith(me, fact.key))) continue;
      change(fact.key, value => ({ at: null, theirs: value.theirs, theirsAt: value.theirsAt, refused: true, refusedAt: fact.at }));
      if (row?.at) unmarked.push(fact.key);
    }
  }
  return { marked, unmarked };
}
// Whether key's ELU is from before vouches (its hello has no own: 1). True when it changed.
export function noteOwnOlder(key, older) {
  const row = clean(readAll()[key]);
  if (!row || Boolean(row.older) === Boolean(older)) return false;
  change(key, value => ({ ...value, older: older === true }));
  return true;
}
