import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { atomic, mkdir, noSymlinks, readJson } from './util.mjs';
import { waitLock } from './state.mjs';
import { personalDirectory } from './usage.mjs';
import { processIdentity } from './process.mjs';
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
    const running = Boolean(saved?.identity) && processIdentity(saved.pid) === saved.identity;
    if (wanted && !running) {
      const child = start(bin, ['-i'], { detached: true, stdio: 'ignore' }); child.unref?.();
      atomic(file, { pid: child.pid, identity: processIdentity(child.pid), startedAt: new Date().toISOString() });
      return true;
    }
    if (!wanted && running) { try { stop(saved.pid); } catch { /* It already ended. */ } }
    if (!wanted && saved) fs.rmSync(file, { force: true });
    return wanted;
  } finally { release(); }
}
// Busy means the conductor has work, or a schedule is on. busy overrides the first part
// for the conductor itself.
export function refreshAwake({ busy, ...options } = {}) {
  let working = busy;
  if (working === undefined) { try { working = conductorStatus().runs.length > 0; } catch { working = false; } }
  let scheduled = false; try { scheduled = listSchedules().some(row => row.enabled); } catch { /* Unreadable schedules keep nothing awake. */ }
  try { return keepAwake(working || scheduled, options); } catch { return false; }
}
