import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, noSymlinks, personalDirectory, readJson, refuse } from './util.mjs';
import { agentEnv, killGroup, processIdentity } from './process.mjs';
import { loginEnv } from './logins.mjs';
import { saveSignIn, savedSignIn } from './usage.mjs';
import { ADAPTERS } from './adapters/index.mjs';
import { CAPS, VENDOR_NAMES } from './vendors.mjs';
import { STEP_TEXT, conformanceState, conformant, runConformance, uncheckedText } from './conformance.mjs';
import { probeVersion, vendorProblem } from './detect.mjs';

// The one-time check of a vendor (lib/conformance.mjs), started by the app itself. A vendor
// that needs the check gets it before the first turn the owner sends to it on this machine:
// there is no command to type. Only a message the owner just sent, a teammate's message that
// starts the owner's own kind of session (his setting let it, or he approved it), or c on the
// vendor in the Usage tab, starts a check, because the check spends the owner's usage of that
// vendor: a schedule's turn, a shadow's or a review never does (the runner says there that
// the owner's first message will). The check
// is the same one, with the same steps and the same record, and a vendor that has not
// passed still cannot run: requireConformance in the runner refuses it, whatever happened here.

// About how many model turns the steps of either vendor take, for the line before it starts.
const TURNS = 'about seven short turns';

// One check of a vendor at a time on this machine, whichever process starts it. A second
// turn waits here and then reads what the first one proved.
async function machineLock(vendor, { signal, waiting }) {
  const file = path.join(personalDirectory(), 'conformance', `${vendor}.lock`); mkdir(path.dirname(file));
  for (let attempt = 0, unread = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      noSymlinks(file); fs.writeFileSync(file, JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) }), { flag: 'wx', mode: 0o600 });
      return () => { try { fs.unlinkSync(file); } catch { /* Already gone. */ } };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    let holder = null; try { holder = readJson(file); } catch { /* Being written, or left half written. */ }
    // Left by a process that is gone, or never finished after several looks: taken over.
    if (holder ? !holder.identity || processIdentity(holder.pid) !== holder.identity : ++unread > 5) { try { fs.unlinkSync(file); } catch { /* Another turn took it over. */ } continue; }
    if (attempt === 0) waiting();
    await new Promise(resolve => setTimeout(resolve, holder ? 1000 : 100));
  }
}
// The check goes on when the owner stops the turn: its steps cannot be interrupted, and
// what it proves is kept for the next message.
function stoppable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason ?? new Error('Stopped.'));
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
const failedSteps = (vendor, steps) => ADAPTERS[vendor].conformance.filter(step => step.required && steps[step.id] !== 'pass').map(step => step.id);

// row: the vendor's row from detect(). Returns false when the vendor needs no check now, and
// true when one just passed (the caller reads the vendor again). Refuses, with what was not
// proven, when it did not pass. say gets each line for the screen: what is about to happen
// and what it costs, then each step as it ends, then that it passed. The first and the last
// come with keep, for the caller to leave in the chat: a step's line lasts only until the next.
export async function checkOnFirstUse(row, { cwd, environment = process.env, signal, say = () => {} } = {}) {
  const vendor = row?.vendor;
  if (!row?.available || !CAPS[vendor]?.conformance || row.conformant !== false) return false;
  const name = VENDOR_NAMES[vendor], { bin } = row, since = Date.now();
  const release = await machineLock(vendor, { signal, waiting: () => say(`Waiting for the check of ${name} that is already running on this machine.`) });
  let handed = false;
  try {
    // The vendor is asked for its release here and nowhere else before a pass: the record names the release it proves.
    const version = probeVersion(vendor, bin, cwd, environment, { check: true });
    if (!version.supported) refuse(`${name} ${version.release ?? ''}`.trim() + `: ${version.reason}`);
    if (conformant(vendor, { bin, version: version.release })) return true;
    // Another turn's check of this release ended while this one waited: its result stands.
    const earlier = conformanceState(vendor);
    if (earlier && earlier.bin === bin && earlier.version === version.release && Date.parse(earlier.at) >= since) refuse(uncheckedText(vendor, { bin, version: version.release }));
    // Signed out, the first step would fail and the rest would spend their time for nothing.
    if (ADAPTERS[vendor].signedIn({ bin, cwd, env: agentEnv(environment) }) === false) refuse(vendorProblem(vendor, [{ vendor, available: true, supported: true, signedIn: false }]));
    const steps = ADAPTERS[vendor].conformance, why = {}; let ended = 0;
    const again = earlier && earlier.bin === bin && earlier.version === version.release;
    say(`${again ? `Checking ${name} again first` : `One-time check of ${name} on this machine first`}: ${TURNS} on it, a few minutes.`, { keep: true });
    say(`Checking ${name}, 0 of ${steps.length} done.`);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `elu-code-check-${vendor}-`));
    const log = line => {
      // A reason names files by their place in the throwaway folder, never by its long path.
      const failed = /^([a-z][a-z0-9-]*): fail: ([\s\S]*)$/.exec(line); if (failed) { why[failed[1]] = failed[2].split('\n')[0].replaceAll(scratch + path.sep, '').slice(0, 200); return; }
      const step = /^([a-z][a-z0-9-]*): (pass|fail|skip)$/.exec(line); if (!step) return;
      const what = STEP_TEXT[step[1]] ?? step[1];
      say(`Checking ${name}, ${++ended} of ${steps.length} done${step[2] === 'pass' ? `: ${what}.` : step[2] === 'skip' ? `. Skipped: ${what}.` : `. Not proven: ${what}.`}`);
    };
    const run = runConformance(vendor, { bin, version: version.release, scratch, env: agentEnv(environment), log })
      .finally(() => { try { fs.rmSync(scratch, { recursive: true, force: true }); } finally { release(); } });
    handed = true; run.catch(() => {});
    const result = await stoppable(run, signal), failed = failedSteps(vendor, result.steps);
    if (failed.length) {
      const first = failed[0], more = failed.length - 1;
      refuse(`${name} did not pass its check on this machine, so it stays off here. Not proven: ${STEP_TEXT[first] ?? first}${why[first] ? ` (${why[first]})` : ''}${more ? `, and ${more} more` : ''}. Your next message to it runs the check again.`);
    }
    say(`${name} ${version.release} passed its check on this machine.${result.relay ? '' : " It can't ask live here: blocked actions are reported."}`, { keep: true });
    return true;
  } finally { if (!handed) release(); }
}

// Before the check, for the Usage tab. A vendor's sign-in shows as soon as it is installed,
// checked or not, read the way the check reads it before its first step and with nothing
// more. Grok Build: its token file is looked for, never opened, and no program runs.
// Antigravity: it is asked for its release and its help, as the check asks first, then
// `agy -p /usage`, which starts no model turn and spends no quota; only the exit code is
// read. Nothing in a read starts a turn, and only the check (c, or a message) proves the vendor.
const awaits = row => Boolean(row?.available) && CAPS[row.vendor]?.conformance === true && row.conformant === false && row.version === null;
// The vendors whose read runs their program: read when the Usage tab opens or on r, and kept
// (lib/usage.mjs, signIns) for that program until the next read.
const RUNS_PROGRAM = new Set(['agy']);
// Where a vendor that needs the check stands with it: ready (passed for the program and
// release found), failed (the record for them names a required step not proven: notProven is
// the first, more how many others), or needed (no record for them).
export function checkState(row) {
  if (row.conformant === true) return { check: 'ready', notProven: null, more: 0 };
  const record = row.version === null ? null : conformanceState(row.vendor);
  const failed = record && record.bin === row.bin && record.version === (row.release ?? null) ? failedSteps(row.vendor, record.steps) : [];
  return failed.length ? { check: 'failed', notProven: STEP_TEXT[failed[0]] ?? failed[0], more: failed.length - 1 } : { check: 'needed', notProven: null, more: 0 };
}
const fileSignIn = (vendor, env) => { try { return ADAPTERS[vendor].signedIn({ env: agentEnv(env, [], loginEnv(vendor)) }) === true; } catch { return null; } };
// detect() rows for usageTab: each vendor that needs the check gets checkState, and one still
// waiting for it gets beforeCheck, its sign-in as last read ({ signedIn, supported, reason }),
// or null when it was never read for this program.
export function withCheck(rows, { env = process.env } = {}) {
  return rows.map(row => {
    if (!row?.available || !CAPS[row.vendor]?.conformance) return row;
    const out = { ...row, checkState: checkState(row) };
    if (!awaits(row)) return out;
    if (!RUNS_PROGRAM.has(row.vendor)) return { ...out, beforeCheck: { signedIn: fileSignIn(row.vendor, env), supported: true, reason: null } };
    const saved = savedSignIn(row.vendor);
    return { ...out, beforeCheck: saved && saved.bin === row.bin ? { signedIn: saved.signedIn, supported: saved.supported, reason: saved.reason } : null };
  });
}
// True when a vendor waiting for its check has never had its sign-in read for this program.
export const signInsUnread = rows => rows.some(row => awaits(row) && RUNS_PROGRAM.has(row.vendor) && savedSignIn(row.vendor)?.bin !== row.bin);
// Reads them: every one with all (r, or a tab check that was due), else only the unread.
export async function readSignInsBeforeCheck(rows, { env = process.env, signal, all = false } = {}) {
  for (const row of rows.filter(row => awaits(row) && RUNS_PROGRAM.has(row.vendor))) {
    if (signal?.aborted) return;
    if (!all && savedSignIn(row.vendor)?.bin === row.bin) continue;
    const read = await readSignIn(row, { env, signal });
    if (read && !signal?.aborted) saveSignIn(row.vendor, { bin: row.bin, ...read });
  }
}
async function readSignIn({ vendor, bin }, { env, signal }) {
  const name = VENDOR_NAMES[vendor], scratch = fs.mkdtempSync(path.join(os.tmpdir(), `elu-code-signin-${vendor}-`));
  try {
    // The release first, as the check asks it: one that cannot run here is not asked more.
    const version = probeVersion(vendor, bin, scratch, env, { check: true });
    if (!version.supported) return { signedIn: null, supported: false, reason: `${name} ${version.release ?? ''}`.trim() + `: ${version.reason}` };
    const { SIGN_IN_SECONDS: seconds, signInCommand } = ADAPTERS[vendor];
    const code = await exitCode(bin, signInCommand({ env }), { cwd: scratch, signal, timeoutMs: seconds * 1000 });
    if (code === undefined) return null;
    return code === null ? { signedIn: null, supported: true, reason: `${name} did not say within ${seconds} seconds whether it is signed in.` } : { signedIn: code === 0, supported: true, reason: null };
  } finally { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* A leftover temp folder is harmless. */ } }
}
// The exit code of one program run without waiting on it: null when it did not end in time or
// could not start, undefined when the caller stopped waiting. Its output is not read.
function exitCode(bin, { args, env }, { cwd, signal, timeoutMs }) {
  return new Promise(resolve => {
    let child = null, done = false, timer = null;
    const finish = (value, kill = false) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (kill && child?.pid) killGroup(child.pid, 'SIGKILL');
      resolve(value);
    };
    const stop = () => finish(undefined, true);
    if (signal?.aborted) return finish(undefined);
    try { child = spawn(bin, args, { cwd, env, stdio: 'ignore', detached: true }); } catch { return finish(null); }
    timer = setTimeout(() => finish(null, true), timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.once('error', () => finish(null)); child.once('exit', code => finish(code));
  });
}
