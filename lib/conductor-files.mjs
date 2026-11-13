import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { noSymlinks, personalDirectory, readJson } from './util.mjs';
import { processIdentity } from './process.mjs';

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

// The process that holds a lock file, while it runs: a reused process number is not it.
export function lockHolder(file) {
  try {
    noSymlinks(file); if (!fs.existsSync(file)) return null;
    const record = readJson(file);
    return record?.identity && processIdentity(record.pid) === record.identity ? record : null;
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
// conductor of 0.1.17 or earlier never sees them, so after a downgrade to one nothing waits
// there. An unknown version counts as one that reads them.
export function readsBeside(version = installed.version()) {
  const parts = typeof version === 'string' ? version.split('-')[0].split('.').map(Number) : [];
  if (parts.length !== 3 || parts.some(part => !Number.isInteger(part))) return true;
  for (const [i, first] of [0, 1, 18].entries()) if (parts[i] !== first) return parts[i] > first;
  return true;
}
