import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, isObject, noSymlinks, readJson, refuse, within } from '../util.mjs';
import { waitLock } from '../state.mjs';
import { peerFile, peerRepo } from './paths.mjs';
import { teams } from './roster.mjs';

// What teammates can do here: one setting per team on this machine (docs/peer-network.md,
// "What teammates can do here"). access.json = {teamId: {handling, rules, root, at}}.
// handling: auto, a teammate's message starts a session in root at once, as if the owner
// had typed it; manual, it waits for the owner's approval and starts the same session then.
// rules: the owner's plain-English rules for teammates, told to every session a teammate
// starts here. root: the project those sessions run in. A team with no row was joined
// before this setting existed: its messages wait for the owner, with no rules.
export const HANDLINGS = Object.freeze(['auto', 'manual']);
export const RULES_MAX = 1000;
export const DEFAULT_ACCESS = Object.freeze({ handling: 'auto', rules: '' });
const HEX64 = /^[0-9a-f]{64}$/;
const file = () => peerFile('access.json');
function readAll() {
  try { noSymlinks(file()); if (!fs.existsSync(file())) return {}; const value = readJson(file()); return isObject(value) ? value : {}; } catch { return {}; }
}
const clean = row => isObject(row) && HANDLINGS.includes(row.handling) ? {
  handling: row.handling,
  rules: typeof row.rules === 'string' ? row.rules.slice(0, RULES_MAX) : '',
  root: typeof row.root === 'string' && path.isAbsolute(row.root) ? row.root : null,
  at: typeof row.at === 'string' ? row.at : null,
} : null;
// The team's setting, or null when it was never set.
export function teamAccess(teamId) { return HEX64.test(teamId ?? '') ? clean(readAll()[teamId]) : null; }
export function accessRows() { return Object.fromEntries(Object.entries(readAll()).filter(([id]) => HEX64.test(id)).map(([id, row]) => [id, clean(row)]).filter(([, row]) => row)); }
// The first of these teams whose setting is set, with its team id.
export function accessFor(teamIds) {
  for (const id of teamIds) { const row = teamAccess(id); if (row) return { team: id, ...row }; }
  return null;
}
export function checkRules(value) {
  if (typeof value !== 'string') refuse('Write the rules as plain text.');
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text.length > RULES_MAX) refuse(`Keep the rules to ${RULES_MAX} characters.`);
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
  for (const name of Object.keys(update)) if (!['handling', 'rules', 'root'].includes(name)) refuse(`Unknown access setting: ${name}.`);
  if (update.handling !== undefined && !HANDLINGS.includes(update.handling)) refuse('Choose auto or manual.');
  const release = waitLock(peerRepo(), 'access');
  try {
    const all = readAll(), current = clean(all[teamId]) ?? { ...DEFAULT_ACCESS, root: null };
    const next = { handling: update.handling ?? current.handling, rules: update.rules === undefined ? current.rules : checkRules(update.rules), root: update.root === undefined ? current.root : checkRoot(update.root), at: new Date().toISOString() };
    atomic(file(), { ...all, [teamId]: next }); return next;
  } finally { release(); }
}
// The owner's rules for a session a teammate started, read when each turn starts so a
// change applies to the next turn. A session that names its team gets that team's rules;
// one from before teams were named gets the rules of every team the teammate is on here.
export function teammateRules(origin) {
  if (!HEX64.test(origin?.peer ?? '')) return '';
  const all = accessRows(), ids = HEX64.test(origin.team ?? '') ? [origin.team]
    : teams().filter(state => state.members.some(m => m.key === origin.peer && !m.removed)).map(state => state.id);
  return [...new Set(ids.map(id => all[id]?.rules ?? '').filter(Boolean))].join('\n\n');
}
