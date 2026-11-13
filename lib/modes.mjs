import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, noSymlinks, onDisk, onDiskUp, personalDirectory, readJson, refuse, within } from './util.mjs';
import { HOME_SECRETS } from './vendors.mjs';

// Per-session permission modes. The owner picks one of MODES for a session; `locked` is
// the profile every other run gets: read-only, no shell, no network, edits only in a
// task worktree. Modes live in task.json and the request row, never in repository files.
export const MODES = Object.freeze(['ask', 'auto', 'full']);
export const PROFILES = Object.freeze(['locked', 'ask', 'auto', 'full']);
export const PLACES = Object.freeze(['worktree', 'branch', 'here']);
export const LABELS = Object.freeze({ locked: 'Read only', ask: 'Ask for approval', auto: 'Approve for me', full: 'Full access' });
export const BADGES = Object.freeze({ locked: 'Read only', ask: 'Ask', auto: 'Auto', full: 'Full' });
export const DEFAULT_MODE = 'ask';
export const APPROVAL_WAIT_SECONDS = 1200;
// Asks and reviews from a teammate run hardened: read-only, Claude only, no state reads.
export const PEER_RUN_KINDS = Object.freeze(['ask', 'review']);
export const isPeerRun = origin => PEER_RUN_KINDS.includes(origin?.kind);
// A session a teammate's message started. One the owner's other computer started (origin.mine,
// lib/peer/remote.mjs) is the owner's own, wherever it was typed.
export const fromTeammate = origin => Boolean(origin) && origin.mine !== true;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/, BAD_BRANCH = /(^|\/)\.|\.\.|\/\/|\.lock$|^-|\/$|^\/|@\{/;
const FOLDER_LIMIT = 8;

export function checkMode(value) {
  if (!MODES.includes(value)) refuse('Choose ask, auto, or full.');
  return value;
}
// A place is 'worktree', 'here', 'branch:<name>', or { kind, branch }. Returns { kind, branch? }.
export function checkPlace(place, { mode } = {}) {
  let kind, branch;
  if (place == null) kind = 'worktree';
  else if (typeof place === 'string') [kind, branch] = place.startsWith('branch:') ? ['branch', place.slice(7)] : [place];
  else if (typeof place === 'object' && !Array.isArray(place)) ({ kind, branch } = place);
  if (!PLACES.includes(kind)) refuse('Choose worktree, branch, or here.');
  if (kind === 'here' && mode !== 'full') refuse('Here needs Full access.');
  if (kind === 'branch') { if (typeof branch !== 'string' || !BRANCH.test(branch) || BAD_BRANCH.test(branch)) refuse('Choose a plain branch name.'); return { kind, branch }; }
  if (branch !== undefined) refuse('Only a branch place names a branch.');
  return { kind };
}
// Extra folders the lead may read this session: existing directories in the owner's home,
// never a secret or ELU state folder, at most eight, each listed once.
export function checkFolders(list, { home = os.homedir() } = {}) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) refuse('Folders must be a list of paths.');
  const root = fs.realpathSync(home), denied = [...HOME_SECRETS.map(name => path.join(root, name)), path.resolve(personalDirectory())];
  // The closed folders by what they are on disk, and the folders that hold one: a closed
  // folder whose own name is a link is closed where it leads, and so is what lies above that.
  const closed = new Set(denied.map(onDisk).filter(Boolean));
  const holders = new Set(denied.flatMap(dir => { try { return onDiskUp(path.dirname(fs.realpathSync(dir))); } catch { return []; } }).filter(Boolean));
  const out = [];
  for (const item of list) {
    if (!path.isAbsolute(item) || /[\x00-\x1f]/.test(item)) refuse('Folders must be absolute paths in your home.');
    let real; try { if (!fs.statSync(item).isDirectory()) throw new Error('not a directory'); real = fs.realpathSync(item); } catch { refuse(`Folder not found: ${item}`); }
    if (!within(root, real) || real === root) refuse('Folders must be inside your home, not your home itself.');
    const here = onDiskUp(real);
    if (denied.some(dir => within(dir, real) || within(real, dir)) || here.some(id => !id || closed.has(id)) || holders.has(here[0])) refuse('That folder holds secrets or ELU state.');
    if (!out.includes(real)) out.push(real);
  }
  if (out.length > FOLDER_LIMIT) refuse(`Name at most ${FOLDER_LIMIT} folders.`);
  return out;
}
// The named folders a turn in Ask for approval or Approve for me is denied writing to. A
// folder may hold the workspace (the folder of all your projects holds each project and the
// worktrees beside it) or lie inside it; such a folder is left to the workspace's own rules,
// because in the vendors a deny wins over an allow and would refuse every edit there. So is
// a folder that holds one the run itself writes to (keep). Compared as written and on disk.
export function readOnlyFolders(folders, { cwd, keep = [] }) {
  const spelled = p => { const resolved = path.resolve(p); let real = resolved; try { real = fs.realpathSync(resolved); } catch { /* Missing: as written. */ } return [...new Set([resolved, real])]; };
  const work = spelled(cwd), kept = keep.flatMap(spelled);
  const above = new Set([...work, ...kept].flatMap(onDiskUp).filter(Boolean)), workIds = new Set(work.map(onDisk).filter(Boolean));
  const left = dir => spelled(dir).some(p => work.some(w => within(p, w) || within(w, p)) || kept.some(k => within(p, k)) || above.has(onDisk(p)) || onDiskUp(p).some(id => workIds.has(id)));
  return folders.filter(dir => !left(dir));
}
// The lower of two profiles, so a schedule or an automatic request never exceeds its cap.
// A schedule has one only when the owner did not pick its mode (lib/schedules.mjs).
export function capMode(mode, cap) {
  const at = value => { const index = PROFILES.indexOf(value); if (index < 0) refuse('Choose ask, auto, or full.'); return index; };
  return PROFILES[Math.min(at(mode), at(cap))];
}
const defaultFile = () => path.join(personalDirectory(), 'permissions.json');
// The personal default for new sessions. Anything unreadable means ask.
export function defaultMode() {
  try { const file = defaultFile(); noSymlinks(file); if (!fs.existsSync(file)) return DEFAULT_MODE; const value = readJson(file).default; return MODES.includes(value) ? value : DEFAULT_MODE; }
  catch { return DEFAULT_MODE; }
}
export function saveDefaultMode(mode) {
  checkMode(mode); atomic(defaultFile(), { version: 1, default: mode }); return mode;
}
// Which profile a turn runs with, checked in order: only the owner's lead
// gets a mode; teammate questions, reviews and read-only turns stay locked; a task without
// permissions was saved before modes existed and stays locked.
export function runProfile({ roleName, task, origin = null, readOnly = false }) {
  if (roleName !== 'lead') return 'locked';
  if (isPeerRun(origin) || readOnly) return 'locked';
  return MODES.includes(task?.permissions) ? task.permissions : 'locked';
}
