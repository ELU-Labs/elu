import fs from 'node:fs';
import { atomic, isObject, noSymlinks, readJson, refuse } from '../util.mjs';
import { waitLock } from '../state.mjs';
import { peerFile, peerRepo } from './paths.mjs';
import { teams } from './roster.mjs';
import { loadIdentity } from './identity.mjs';

// The owner's own computers, as this computer knows them. Every computer on a project still
// works the same (lib/peer/remote.mjs NO_MINE): a mark here only says that another computer is
// the owner's, so that what it sends for him is his word here (the Orchestrator at Full,
// lib/orchestrator-seams.mjs). Nothing is marked by default, and with nothing marked every
// computer is a teammate's, as before.
//
// The mark is made on this computer, by its owner, and only here: /computers mine NAME. A message
// from another computer can never make or keep one. Each computer marks the other for itself: the
// devbox is the Mac's on the Mac, and the Mac is the devbox's on the devbox.
//
// <personal>/peer/my-computers.json = { version: 1, computers: { <key>: { name, at } } }.
// A file of its own, never the old mine.json (lib/peer/mine.mjs): marks left there from before
// would otherwise count again.
const HEX64 = /^[0-9a-f]{64}$/, WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const MY_COMPUTERS_FILE = 'my-computers.json';
const file = () => peerFile(MY_COMPUTERS_FILE);
const cleanName = value => String(value ?? '').replace(/[\x00-\x1f"<>@\s]+/g, '').slice(0, 64);

/** @typedef {{ key: string, name: string, at: string }} MyComputer */

function readAll() {
  try {
    noSymlinks(file());
    if (!fs.existsSync(file())) return {};
    const value = readJson(file());
    if (!isObject(value) || value.version !== 1 || !isObject(value.computers)) return {};
    return Object.fromEntries(Object.entries(value.computers)
      .filter(([key, row]) => HEX64.test(key) && isObject(row) && WHEN.test(row.at ?? ''))
      .map(([key, row]) => [key, { name: cleanName(row.name) || key.slice(0, 8), at: row.at }]));
  } catch { return {}; }
}
function myKey() { try { return loadIdentity()?.key ?? null; } catch { return null; } }
const onTeamWith = (me, key) => { try { return teams().some(state => [me, key].every(k => state.members.some(m => m.key === k && !m.removed))); } catch { return false; } };

// The computers this one marked as the owner's: [{ key, name, at }], oldest first.
/** @returns {MyComputer[]} */
export function myComputers() {
  return Object.entries(readAll()).map(([key, row]) => ({ key, ...row })).sort((a, b) => a.at.localeCompare(b.at));
}
// Whether key is one of the owner's computers here: marked on this computer, not this computer
// itself, and still on a team with it. Anything that cannot be read is false.
/** @param {string} key @returns {boolean} */
export function isMyComputer(key) {
  if (!HEX64.test(key ?? '')) return false;
  const me = myKey();
  if (!me || key === me || !readAll()[key]) return false;
  return onTeamWith(me, key);
}
function change(update) {
  const release = waitLock(peerRepo(), 'my-computers');
  try { const next = update(readAll()); atomic(file(), { version: 1, computers: next }); return next; } finally { release(); }
}
// The owner marks key as his, on this computer. Only for a computer on a team with this one.
/** @param {string} key @param {string} name @returns {MyComputer} */
export function markMyComputer(key, name) {
  if (!HEX64.test(key ?? '')) refuse('Choose one of the computers on your projects.');
  const me = myKey();
  if (!me) refuse('This computer has no peer identity yet.');
  if (key === me) refuse('This is the computer you are on.');
  if (!onTeamWith(me, key)) refuse('That computer is on none of your projects.');
  const at = new Date().toISOString(), row = { name: cleanName(name) || key.slice(0, 8), at };
  change(all => ({ ...all, [key]: row }));
  return { key, ...row };
}
// The owner takes the mark away. Its next request is a teammate's again.
/** @param {string} key @returns {boolean} whether it was marked */
export function unmarkMyComputer(key) {
  if (!HEX64.test(key ?? '')) refuse('Choose one of your computers.');
  let had = false;
  change(all => { had = Boolean(all[key]); const { [key]: _gone, ...rest } = all; return rest; });
  return had;
}
