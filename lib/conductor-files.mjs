import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { noSymlinks, personalDirectory, readJson } from './util.mjs';
import { sameProcess } from './process.mjs';

// Where the conductor keeps its lock and status, and which conductor holds the lock. Kept
// apart from conductor.mjs, which reads requests, so the request files can ask it too.

export const conductorFolder = () => path.join(personalDirectory(), 'conductor');
export const statusPath = () => path.join(conductorFolder(), 'state.json');
export const conductorLock = () => path.join(personalDirectory(), 'conductor.lock');
// While a conductor of a version without handover holds the lock and still runs sessions, the
// conductor of this version takes new work beside it, under its own lock and status file.
export const BESIDE_LOCK = 'conductor-beside';
export const besideLock = () => path.join(personalDirectory(), `${BESIDE_LOCK}.lock`);
export const besideStatusPath = () => path.join(conductorFolder(), 'beside.json');
// maxAgents: the most sessions that run at once, in one project as in several, or null: no
// limit, which it is until the owner sets one with /slots. It is the only limit on his own
// runs, and any whole number from 1. Only /slots has ever written the file (it writes every
// setting), so a number there is one he typed: the 4 that earlier versions ran at once was
// their default in the code, never saved, and limits nothing now. Read here, so a run
// started from the command line (lib/runner.mjs) holds to it too.
export const DEFAULT_SETTINGS = Object.freeze({ maxAgents: null, stallMinutes: 8, retries: 1 });
export const isLimit = value => Number.isSafeInteger(value) && value >= 1;
export function conductorSettings() {
  let value = {};
  try { const file = path.join(conductorFolder(), 'settings.json'); noSymlinks(file); if (fs.existsSync(file)) value = readJson(file); } catch { /* Defaults apply. */ }
  const pick = (name, min, max) => Number.isInteger(value?.[name]) && value[name] >= min && value[name] <= max ? value[name] : DEFAULT_SETTINGS[name];
  return { maxAgents: isLimit(value?.maxAgents) ? value.maxAgents : null, stallMinutes: pick('stallMinutes', 1, 120), retries: pick('retries', 0, 5) };
}
// The limit as a number, or null for none. Every place that holds sessions back asks
// atLimit with it: no limit is never reached, however many run.
export const sessionLimit = () => conductorSettings().maxAgents;
export const atLimit = (running, limit = sessionLimit()) => isLimit(limit) && running >= limit;
// The limit in a sentence, the same in /slots and where a run is refused.
export const limitText = (limit = sessionLimit()) => !isLimit(limit) ? 'No limit on sessions at once.' : `At most ${limit === 1 ? '1 session runs' : `${limit} sessions run`} at once.`;

// The process that holds a lock file, while it runs: a reused process number is not it.
export function lockHolder(file) {
  try {
    noSymlinks(file); if (!fs.existsSync(file)) return null;
    const record = readJson(file);
    return sameProcess(record) ? record : null;
  } catch { return null; }
}
// The conductor that holds the lock, from its lock and its status: null when none runs.
// older: a version without handover, 0.1.16 and earlier, which writes no version in its
// status and starts every queued request it reads until it is idle. Every later version
// hands its work over by itself once an update replaced it (Conductor.drain). known is false
// while it has not yet written its status, so nothing is decided about it then.
export function mainConductor(holder = lockHolder(conductorLock())) {
  if (!holder) return null;
  let status = null; try { const file = statusPath(); noSymlinks(file); status = readJson(file); } catch { /* Not written yet. */ }
  if (status?.pid !== holder.pid || status.stopped) return { pid: holder.pid, known: false, older: false, version: null, runs: [] };
  const version = typeof status.version === 'string' ? status.version : null;
  return { pid: holder.pid, known: true, older: !version, version, runs: Array.isArray(status.runs) ? status.runs : [] };
}
// The conductor without handover that holds the lock, or null. Every request this version
// queues while it runs waits where that version never looks (lib/workspace.mjs).
export function olderConductor() { const main = mainConductor(); return main?.older ? main : null; }
// The version of the copy installed where this code runs. An update, or a downgrade, replaces
// the files under a running process, so it is read from the disk each time. Tests set their own.
export const installed = { version: () => { try { return readJson(fileURLToPath(new URL('../package.json', import.meta.url))).version; } catch { return null; } } };
// Whether a version reads the requests that wait beside the main file: 0.1.18 and later. A
// conductor of 0.1.17 or earlier never sees them, so after a downgrade to one they wait there
// only while a conductor of a later version runs beside it, which starts them (holding). An
// unknown version counts as one that reads them.
export function readsBeside(version = installed.version()) {
  const parts = typeof version === 'string' ? version.split('-')[0].split('.').map(Number) : [];
  if (parts.length !== 3 || parts.some(part => !Number.isInteger(part))) return true;
  for (const [i, first] of [0, 1, 18].entries()) if (parts[i] !== first) return parts[i] > first;
  return true;
}
// The version of the code this process runs, read once as it starts.
export const RUNNING = installed.version();
// Whether version a is earlier than b. False when either is not a plain version.
export function earlierVersion(a, b) {
  const [x, y] = [a, b].map(value => typeof value === 'string' ? value.split('-')[0].split('.').map(Number) : []);
  if (x.length !== 3 || y.length !== 3 || [...x, ...y].some(part => !Number.isInteger(part))) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}
// Whether the conductor that holds the lock stays: it will not hand its work to the given
// version by itself. One without handover never does. One of 0.1.18 or 0.1.19 hands over
// when the files it was started from are replaced, and run with npx each version keeps a
// folder of its own, so an update never replaces them. The conductor of the later version
// takes new work beside either (Conductor.take), and tells it to leave once it runs nothing
// (Conductor.stepAside), so no work is started on an earlier version after an update.
export const stays = (main, version = installed.version()) => Boolean(main?.known && (main.older || earlierVersion(main.version, version)));
export function stayingConductor(version = installed.version()) { const main = mainConductor(); return stays(main, version) ? main : null; }
// How the queued requests wait now, from what is installed here (lib/workspace.mjs).
// 'beside': in the file beside the main one, while a conductor without handover holds the
// lock, and a conductor that reads that file runs beside it or would start there.
// 'kept': by their notBefore, while a conductor of an earlier version with handover stays,
// which reads both files. null: where every version reads and starts them.
export function waitMode() {
  const main = mainConductor();
  if (!main?.known) return null;
  if (main.older) return readsBeside() || lockHolder(besideLock()) ? 'beside' : null;
  return earlierVersion(main.version, installed.version()) ? 'kept' : null;
}
export function holding() { return waitMode() === 'beside'; }
// The ELU windows open on an earlier version than the given one, by process number. Each
// open window holds the lock of the project it shows (claimView in lib/projects.mjs), and from
// 0.1.20 on that lock names its version. A window starts the conductor of its own version
// when it finds none, from its own folder when run with npx: this version's conductor does
// not leave while one is open (Conductor.tick), so what that window sends runs here.
export function earlierWindows(version = installed.version()) {
  let names = [];
  try { const dir = personalDirectory(); noSymlinks(dir); names = fs.readdirSync(dir).filter(name => /^view-[0-9a-f]{64}\.lock$/.test(name)); } catch { return []; }
  const pids = new Set();
  for (const name of names) {
    const record = lockHolder(path.join(personalDirectory(), name));
    if (record && (typeof record.version !== 'string' || earlierVersion(record.version, version))) pids.add(record.pid);
  }
  return [...pids];
}
