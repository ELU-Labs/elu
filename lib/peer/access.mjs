import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, isHomeFolder, isObject, noSymlinks, readJson, refuse, within } from '../util.mjs';
import { waitLock } from '../state.mjs';
import { peerFile, peerRepo } from './paths.mjs';
import { teams } from './roster.mjs';

// What teammates can do here: one setting per team on this machine (docs/peer-network.md,
// "What teammates can do here"). access.json = {teamId: {handling, rules, root, at}}.
// handling: auto, a teammate's message starts a session in root at once, as if the owner
// had typed it; manual, it waits for the owner's approval and starts the same session then.
// rules: the owner's plain-English rules for teammates, told to every session a teammate
// starts here. root: the project those sessions run in. A team with no row was joined
// before this setting existed: its messages wait for the owner, with no rules. Leaving a team,
// or being removed from it, drops its row, so coming back with a new invite asks again.
// home: true only where the owner answered y to HOME_AUTO_QUESTION (lib/util.mjs) in /access,
// or ran elu access --auto --home, in his home folder: the home folder is this team's project
// here and what another computer on it asks starts by itself (lib/peer/remote.mjs handling).
// root stays null there, as it always was for the home folder, so an ELU up to 0.1.34 reads the
// row as it did and keeps that work by hand; one that saves the row drops home, which is the
// same. It is kept only while handling is auto and no other project is saved.
export const HANDLINGS = Object.freeze(['auto', 'manual']);
export const DEFAULT_ACCESS = Object.freeze({ handling: 'auto', rules: '' });
const HEX64 = /^[0-9a-f]{64}$/;
const file = () => peerFile('access.json');
function readAll() {
  try { noSymlinks(file()); if (!fs.existsSync(file())) return {}; const value = readJson(file()); return isObject(value) ? value : {}; } catch { return {}; }
}
const clean = row => isObject(row) && HANDLINGS.includes(row.handling) ? {
  handling: row.handling,
  rules: typeof row.rules === 'string' ? row.rules : '',
  root: typeof row.root === 'string' && path.isAbsolute(row.root) ? row.root : null,
  at: typeof row.at === 'string' ? row.at : null,
  ...(row.home === true && row.handling === 'auto' && !(typeof row.root === 'string' && path.isAbsolute(row.root)) ? { home: true } : {}),
} : null;
// The team's setting, or null when it was never set.
export function teamAccess(teamId) { return HEX64.test(teamId ?? '') ? clean(readAll()[teamId]) : null; }
export function accessRows() { return Object.fromEntries(Object.entries(readAll()).filter(([id]) => HEX64.test(id)).map(([id, row]) => [id, clean(row)]).filter(([, row]) => row)); }
export function checkRules(value) {
  if (typeof value !== 'string') refuse('Write the rules as plain text.');
  const text = value.replace(/\r\n?/g, '\n').trim();
  return text;
}
// The project teammates' sessions run in: an existing folder, never the home folder itself
// or above it, so a teammate's session never runs over all of the owner's files.
export function checkRoot(value) {
  if (value === null) return null;
  let real; try { real = fs.realpathSync(path.resolve(String(value ?? ''))); if (!fs.statSync(real).isDirectory()) throw new Error('not a folder'); } catch { refuse('That project folder does not exist.'); }
  let home = os.homedir(); try { home = fs.realpathSync(home); } catch { /* Compared as given. */ }
  if (within(real, home)) refuse('Your home folder cannot be the project teammates work in. Open the project\'s own folder.');
  return real;
}
// Saves what is given and keeps the rest. A first save fills in the defaults.
export function saveTeamAccess(teamId, update = {}) {
  if (!HEX64.test(teamId ?? '')) refuse('Choose a team.');
  if (!isObject(update)) refuse('Choose what teammates can do.');
  for (const name of Object.keys(update)) if (!['handling', 'rules', 'root', 'home'].includes(name)) refuse(`Unknown access setting: ${name}.`);
  if (update.handling !== undefined && !HANDLINGS.includes(update.handling)) refuse('Choose auto or manual.');
  // home goes with the home folder itself as root, and with Auto: nothing else is allowed this way.
  if (update.home !== undefined && typeof update.home !== 'boolean') refuse('Unknown access setting: home.');
  if (update.home === true && !isHomeFolder(update.root)) refuse('Only your home folder itself is allowed this way. Run it there.');
  const release = waitLock(peerRepo(), 'access');
  try {
    const all = readAll(), current = clean(all[teamId]) ?? { ...DEFAULT_ACCESS, root: null };
    const handling = update.handling ?? current.handling, root = update.home === true ? null : update.root === undefined ? current.root : checkRoot(update.root);
    if (update.home === true && handling !== 'auto') refuse('The home folder is allowed only with Auto.');
    const home = handling === 'auto' && root === null && (update.home === true || update.home === undefined && update.root === undefined && current.home === true);
    const next = { handling, rules: update.rules === undefined ? current.rules : checkRules(update.rules), root, at: new Date().toISOString(), ...(home ? { home: true } : {}) };
    atomic(file(), { ...all, [teamId]: next }); return next;
  } finally { release(); }
}
// Drops a team's row: after leaving it, on hearing this machine was removed from it, and
// before coming back to it. Teams with no row behave as Manual with no rules.
export function forgetTeamAccess(teamId) {
  if (!HEX64.test(teamId ?? '') || !(teamId in readAll())) return false;
  const release = waitLock(peerRepo(), 'access');
  try {
    const all = readAll(); if (!(teamId in all)) return false;
    atomic(file(), Object.fromEntries(Object.entries(all).filter(([id]) => id !== teamId))); return true;
  } finally { release(); }
}
// The name on the roster of the person whose computer has this key, on any team this computer
// is on; null when it is on none.
export function memberName(key) {
  try { for (const state of teams()) { const found = state.members.find(m => m.key === key && !m.removed); if (found?.name) return found.name; } } catch { /* Named by its key. */ }
  return null;
}
// Whether the home folder (root) takes by itself what another computer on its project asks:
// only the home folder itself, with every one of the project's teams there (ids) set to Auto
// and allowed by the owner in so many words (home). A folder above it never does.
export const autoAtHome = (root, ids) => isHomeFolder(root) && ids.length > 0 && ids.every(id => { const row = teamAccess(id); return row?.handling === 'auto' && row.home === true && row.root === null; });
// The owner's rules for a session a teammate started, read when each turn starts so a
// change applies to the next turn. A session that names its teams (the teams of the project
// it runs in) gets the rules of all of them, so the sender cannot pick the laxer ones; one
// that names none gets the rules of every team the teammate is on here.
export function teammateRules(origin) {
  if (!HEX64.test(origin?.peer ?? '')) return '';
  const named = Array.isArray(origin.teams) ? origin.teams.filter(id => HEX64.test(id ?? '')) : HEX64.test(origin.team ?? '') ? [origin.team] : [];
  const all = accessRows(), ids = named.length ? named
    : teams().filter(state => state.members.some(m => m.key === origin.peer && !m.removed)).map(state => state.id);
  return [...new Set(ids.map(id => all[id]?.rules ?? '').filter(Boolean))].join('\n\n');
}
