import fs from 'node:fs';
import { atomic, isObject, noSymlinks, readJson, refuse } from '../util.mjs';
import { waitLock } from '../state.mjs';
import { peerFile, peerRepo } from './paths.mjs';
import { teams } from './roster.mjs';
import { loadIdentity } from './identity.mjs';
import { mineRows, pairedMine } from './mine.mjs';
import { githubPaired, pairingStatus } from './github-pairing.mjs';

// The owner's own computers, as this computer knows them. Every computer on a project still
// works the same (lib/peer/remote.mjs NO_MINE): this only says that another computer is the
// owner's, so that what it sends for him is his word here, and what this one sends it is his
// there (the Orchestrator at Full, lib/orchestrator-seams.mjs).
//
// A computer is his here when it is paired with this one as his: both signed in with gh to the same
// GitHub account (lib/peer/github-pairing.mjs githubPaired), or paired on both sides by an ELU up
// to 0.1.33 (lib/peer/mine.mjs pairedMine), and on a team with this one; or when he marked it here
// with /computers mine NAME, for one that is not paired. /computers unmine NAME
// keeps a "not mine" here that wins over both, until he marks it again. Each is made on this
// computer, by its owner, and only here: a message from another computer can never make or keep
// one. Nothing paired or marked: every computer is a teammate's, as before.
//
// <personal>/peer/my-computers.json =
//   { version: 1, computers: { <key>: { name, at } }, notMine: { <key>: { name, at } } }
// A file of its own, never the old mine.json (lib/peer/mine.mjs), which holds the pairing.
const HEX64 = /^[0-9a-f]{64}$/, WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const MY_COMPUTERS_FILE = 'my-computers.json';
const file = () => peerFile(MY_COMPUTERS_FILE);
const cleanName = value => String(value ?? '').replace(/[\x00-\x1f"<>@\s]+/g, '').slice(0, 64);

/** @typedef {{ key: string, name: string, at: string, paired?: boolean }} MyComputer */

const rowsOf = value => isObject(value) ? Object.fromEntries(Object.entries(value)
  .filter(([key, row]) => HEX64.test(key) && isObject(row) && WHEN.test(row.at ?? ''))
  .map(([key, row]) => [key, { name: cleanName(row.name) || key.slice(0, 8), at: row.at }])) : {};
function readFile() {
  try {
    noSymlinks(file());
    if (!fs.existsSync(file())) return { marked: {}, notMine: {} };
    const value = readJson(file());
    if (!isObject(value) || value.version !== 1) return { marked: {}, notMine: {} };
    const marked = rowsOf(value.computers), notMine = rowsOf(value.notMine);
    for (const key of Object.keys(notMine)) delete marked[key];
    return { marked, notMine };
  } catch { return { marked: {}, notMine: {} }; }
}
function myKey() { try { return loadIdentity()?.key ?? null; } catch { return null; } }
const onTeamWith = (me, key) => { try { return teams().some(state => [me, key].every(k => state.members.some(m => m.key === k && !m.removed))); } catch { return false; } };
const paired = (me, key) => { try { return pairedMine(key) || githubPaired(key) && onTeamWith(me, key); } catch { return false; } };
// The keys paired with this one, by either way.
function pairedKeys() {
  const keys = new Set();
  try { for (const row of mineRows()) keys.add(row.key); } catch { /* None from before. */ }
  try { for (const key of pairingStatus()?.keys ?? []) if (HEX64.test(key)) keys.add(key); } catch { /* None by GitHub. */ }
  return keys;
}

// The computers that are the owner's here: the ones he marked, then the paired ones he did not
// say are not his, [{ key, name, at, paired? }], oldest first. A paired one is named by its key
// here: the roster (lib/peer/session-tools.mjs computers) has its name.
/** @returns {MyComputer[]} */
export function myComputers() {
  const { marked, notMine } = readFile(), rows = Object.entries(marked).map(([key, row]) => ({ key, ...row })), me = myKey();
  if (me) for (const key of pairedKeys()) if (!marked[key] && !notMine[key] && key !== me && paired(me, key)) rows.push({ key, name: key.slice(0, 8), at: '', paired: true });
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}
// Whether key is one of the owner's computers here: not this computer itself, not one he said is
// not his (/computers unmine), and paired with this one as his, or marked here and still on a team
// with it. Anything that cannot be read is false.
/** @param {string} key @returns {boolean} */
export function isMyComputer(key) {
  if (!HEX64.test(key ?? '')) return false;
  const me = myKey();
  if (!me || key === me) return false;
  const { marked, notMine } = readFile();
  if (notMine[key]) return false;
  return marked[key] ? onTeamWith(me, key) : paired(me, key);
}
// Whether the owner said here that key is not his (/computers unmine), over its pairing.
/** @param {string} key @returns {boolean} */
export const notMyComputer = key => HEX64.test(key ?? '') && Boolean(readFile().notMine[key]);
function change(update) {
  const release = waitLock(peerRepo(), 'my-computers');
  try { const next = update(readFile()); atomic(file(), { version: 1, computers: next.marked, notMine: next.notMine }); return next; } finally { release(); }
}
// The owner marks key as his, on this computer: one that is not paired, or one he said was not
// his. Only for a computer on a team with this one.
/** @param {string} key @param {string} name @returns {MyComputer} */
export function markMyComputer(key, name) {
  if (!HEX64.test(key ?? '')) refuse('Choose one of the computers on your projects.');
  const me = myKey();
  if (!me) refuse('This computer has no peer identity yet.');
  if (key === me) refuse('This is the computer you are on.');
  if (!onTeamWith(me, key)) refuse('That computer is on none of your projects.');
  const at = new Date().toISOString(), row = { name: cleanName(name) || key.slice(0, 8), at };
  change(({ marked, notMine }) => { const { [key]: _was, ...rest } = notMine; return { marked: { ...marked, [key]: row }, notMine: rest }; });
  return { key, ...row };
}
// The owner says key is not his, here: its mark goes, and "not mine" is kept over its pairing.
// Its next request is a teammate's again. Returns whether it was his here before.
/** @param {string} key @param {string} [name] @returns {boolean} */
export function unmarkMyComputer(key, name = '') {
  if (!HEX64.test(key ?? '')) refuse('Choose one of your computers.');
  const had = isMyComputer(key), at = new Date().toISOString();
  change(({ marked, notMine }) => { const { [key]: was, ...rest } = marked; return { marked: rest, notMine: { ...notMine, [key]: { name: cleanName(name) || was?.name || key.slice(0, 8), at } } }; });
  return had;
}
