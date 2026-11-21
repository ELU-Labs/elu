import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { atomic, mkdir, noSymlinks, readJson } from './util.mjs';
import { waitLock } from './state.mjs';
import { personalDirectory } from './usage.mjs';
import { processRecord, sameProcess } from './process.mjs';
import { listSchedules } from './schedules.mjs';
import { conductorStatus } from './conductor.mjs';

// While an agent works or a schedule is on, caffeinate -i keeps the Mac from sleeping when
// idle. The display still sleeps and locks as set. One caffeinate serves every terminal,
// the conductor and the scheduler. Its process is recorded, so whoever sees nothing left
// to do stops it.
const BIN = '/usr/bin/caffeinate';
const record = () => path.join(personalDirectory(), 'caffeinate.json');

export function keepAwake(wanted, { platform = process.platform, bin = BIN, start = spawn, stop = pid => process.kill(pid, 'SIGTERM') } = {}) {
  if (platform !== 'darwin' || !fs.existsSync(bin)) return false;
  // Tests use their own start and stop, and never keep the real computer awake.
  if (process.env.NODE_TEST_CONTEXT && start === spawn) return false;
  mkdir(personalDirectory());
  const release = waitLock({ state: personalDirectory() }, 'caffeinate', 100);
  try {
    const file = record(); noSymlinks(file);
    let saved = null; try { saved = fs.existsSync(file) ? readJson(file) : null; } catch { saved = null; }
    const running = sameProcess(saved) === true;
    if (wanted && !running) {
      const child = start(bin, ['-i'], { detached: true, stdio: 'ignore' }); child.unref?.();
      atomic(file, { ...processRecord(child.pid), startedAt: new Date().toISOString() });
      return true;
    }
    if (!wanted && running) { try { stop(saved.pid); } catch { /* It already ended. */ } }
    if (!wanted && saved) fs.rmSync(file, { force: true });
    return wanted;
  } finally { release(); }
}
// The conductor's own caffeinate while its agents work, beside the shared one: -w ends it
// with the conductor, so it never outlives it, and no other process stops it. The shared one
// is stopped by whoever reads that nothing is left to do, such as a terminal that read the
// conductors' status in between: with the Mac set to sleep after a minute idle, the seconds
// until the conductor started it again could put the Mac to sleep in the middle of a turn.
let own = null;
export function holdAwake(wanted, { platform = process.platform, bin = BIN, start = spawn, stop = pid => process.kill(pid, 'SIGTERM'), pid = process.pid } = {}) {
  if (platform !== 'darwin' || !fs.existsSync(bin)) return false;
  // Tests use their own start and stop, and never keep the real computer awake.
  if (process.env.NODE_TEST_CONTEXT && start === spawn) return false;
  if (wanted && !own) {
    try {
      const child = start(bin, ['-i', '-w', String(pid)], { stdio: 'ignore' }); child.unref?.(); own = child;
      // Ended some other way: the conductor's next look starts it again.
      const gone = () => { if (own === child) own = null; }; child.once?.('exit', gone); child.once?.('error', gone);
    } catch { own = null; }
  } else if (!wanted && own) { const child = own; own = null; try { stop(child.pid); } catch { /* It already ended. */ } }
  return Boolean(own);
}
// Forgets the conductor's caffeinate, for tests.
export const forgetHold = () => { own = null; };
// Busy means the conductor has work, or a schedule is on. busy overrides the first part
// for the conductor itself.
export function refreshAwake({ busy, ...options } = {}) {
  let working = busy;
  if (working === undefined) { try { working = conductorStatus().runs.length > 0; } catch { working = false; } }
  let scheduled = false; try { scheduled = listSchedules().some(row => row.enabled); } catch { /* Unreadable schedules keep nothing awake. */ }
  try { return keepAwake(working || scheduled, options); } catch { return false; }
}
