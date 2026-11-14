import fs from 'node:fs';
import path from 'node:path';
import { mkdir, noSymlinks, personalDirectory, readJson, refuse, tempFolder } from './util.mjs';
import { agentEnv, processRecord, sameProcess } from './process.mjs';
import { saveSignIn, savedSignIn } from './usage.mjs';
import { ADAPTERS } from './adapters/index.mjs';
import { CAPS, VENDOR_NAMES } from './vendors.mjs';
import { STEP_TEXT, answerLoads, checkResult, conformanceState, conformant, failedText, loadsList, runConformance } from './conformance.mjs';
import { probeVersion } from './detect.mjs';

// The one-time check of a vendor (lib/conformance.mjs), started by the app itself. A vendor
// that needs the check gets it before the first turn the owner sends to it on this machine:
// there is no command to type. Whatever is about to start a turn on the vendor starts its
// check first, the same way: a message the owner just sent, a teammate's message that starts
// a session of the owner's (his setting let it, or he approved it with y or w), a schedule's turn, a shadow's
// comment, a review, a standup or a Task's work (vendorFor in lib/runner.mjs), and c on the
// vendor in the Usage tab. The check spends the owner's usage of that vendor once. The check
// is the same one, with the same steps and the same record. What it turns off is decided by
// the record alone (modeBlock in lib/conformance.mjs), which the runner asks before every
// turn: a required step not proven keeps Read only, Ask for approval and Approve for me off,
// and never Full access.

// About how many model turns the steps of either vendor take, for the line before it starts.
const TURNS = 'about seven short turns';

// One check of a vendor at a time on this machine, whichever process starts it. A second
// turn waits here and then reads what the first one proved.
async function machineLock(vendor, { signal, waiting }) {
  const file = path.join(personalDirectory(), 'conformance', `${vendor}.lock`); mkdir(path.dirname(file));
  for (let attempt = 0, unread = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      noSymlinks(file); fs.writeFileSync(file, JSON.stringify(processRecord()), { flag: 'wx', mode: 0o600 });
      return () => { try { fs.unlinkSync(file); } catch { /* Already gone. */ } };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    let holder = null; try { holder = readJson(file); } catch { /* Being written, or left half written. */ }
    // Left by a process that is gone, or never finished after several looks: taken over.
    if (holder ? !sameProcess(holder) : ++unread > 5) { try { fs.unlinkSync(file); } catch { /* Another turn took it over. */ } continue; }
    if (attempt === 0) waiting();
    await new Promise(resolve => setTimeout(resolve, holder ? 1000 : 100));
  }
}
// The check goes on when the owner stops the turn: its steps cannot be interrupted, and
// what it proves is kept for the next message. A reading of a vendor (its release, its
// sign-in) is not like that: the stop ends its programs at once (detect, probeVersion and
// the adapters' sign-in reads take the signal).
export function stoppable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason ?? new Error('Stopped.'));
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
// What the check found that the vendor also loads on this computer, in the owner's words: said
// once when the check ends, and shown on the vendor in the Usage tab. Text the model reads is
// only named. Something that runs is asked about once outside Full access (allowLoads).
// asking: the owner is about to be asked about what runs, so that line is left to the question.
export function loadsNotes(vendor, result, { asking = false } = {}) {
  if (!result) return [];
  const reads = result.loads.filter(row => !row.runs), out = [];
  if (reads.length) out.push(`It also loads on this machine: ${loadsList(reads)}.`);
  if (result.runs.length && !(asking && !result.answer)) out.push(`It would also run on this machine: ${loadsList(result.runs)}.`, result.answer === 'allow' ? 'You allowed that.' : result.answer === 'deny' ? 'You said no, so it runs in Full access only. c asks again.' : 'Outside Full access your next message to it asks you once.');
  if (result.unread) out.push(`What else it loads on this machine was not read (${result.unread}).`);
  return out;
}
// Where a vendor stands with its sign-in for ELU, read without waiting on it: { signedIn: true
// | false | null, reason }, or undefined when signal stopped the read. Antigravity CLI is run
// (`agy -p /usage`, stopped the moment it asks for a sign-in); Grok Build's token file is looked for.
async function signInOf(vendor, { bin, cwd, env, signal }) {
  const adapter = ADAPTERS[vendor];
  if (adapter.readSignIn) return adapter.readSignIn({ bin, cwd, env, signal });
  const value = await adapter.signedIn({ bin, cwd, env: agentEnv(env), signal });
  if (signal?.aborted) return undefined;
  return { signedIn: typeof value === 'boolean' ? value : null, reason: null };
}
// What the owner does next when a vendor is not signed in for ELU, or did not say.
export const SIGN_IN_KEY = 'Sign it in with s on its line in the Usage tab.';
export const notSignedInText = (vendor, read) => read?.signedIn === false
  ? `${VENDOR_NAMES[vendor]} is not signed in for ELU. ${SIGN_IN_KEY}`
  : `${VENDOR_NAMES[vendor]} did not say whether it is signed in${read?.reason ? ` (it ${read.reason})` : ''}. r in the Usage tab reads it again.`;

// row: the vendor's row from detect(). Returns false when the vendor needs no check now, and
// true when one just ran and the turn may go on (the caller reads the vendor again). say gets
// each line for the screen: what is about to happen and what it costs, then each step as it
// ends, then the result. The first and the last come with keep, for the caller to leave in
// the chat: a step's line lasts only until the next.
// mode: the mode of the turn that is about to start; null for c in the Usage tab. When a
// required step is not proven, a turn in Full access goes on with the result said, and any
// other is refused with what still works and what to do. A check that failed runs again by
// itself only when that can change its result, never before a turn in Full access; force
// (c) runs it again whatever it said.
export async function checkOnFirstUse(row, { cwd, environment = process.env, signal, say = () => {}, mode = null, force = false } = {}) {
  const vendor = row?.vendor;
  if (!row?.available || !CAPS[vendor]?.conformance) return false;
  const known = row.version === null ? null : checkResult(vendor, { bin: row.bin, version: row.release ?? null });
  if (known && !(known.failed.length && (force || (mode !== 'full' && known.again)))) return false;
  const name = VENDOR_NAMES[vendor], { bin } = row, since = Date.now();
  const release = await machineLock(vendor, { signal, waiting: () => say(`Waiting for the check of ${name} that is already running on this machine.`) });
  let handed = false;
  try {
    // The vendor is asked for its release here and nowhere else before a pass: the record names the release it proves.
    say(`Reading ${name}'s release…`);
    const version = await probeVersion(vendor, bin, cwd, environment, { check: true, signal });
    if (!version.supported) refuse(`${name} ${version.release ?? ''}`.trim() + `: ${version.reason}`);
    // What the check said, for the screen and for the turn: refused outside Full access when a required step is not proven.
    const ended = () => {
      const result = checkResult(vendor, { bin, version: version.release });
      if (result.failed.length && mode !== 'full') refuse(failedText(vendor, result));
      say(result.failed.length ? failedText(vendor, result, { full: true }) : `${name} ${version.release} passed its check on this machine.${result.relay ? '' : " It can't ask live here: blocked actions are reported."}`, { keep: true });
      for (const note of loadsNotes(vendor, result, { asking: mode !== null && mode !== 'full' })) say(note, { keep: true });
      return true;
    };
    if (conformant(vendor, { bin, version: version.release })) return true;
    // Another turn's check of this release ended while this one waited: its result stands.
    const earlier = conformanceState(vendor);
    if (earlier && earlier.bin === bin && earlier.version === version.release && Date.parse(earlier.at) >= since) return ended();
    // Signed out, the first step would fail and the rest would spend their time for nothing.
    // The read never waits on a sign-in: the owner signs in with s in the Usage tab.
    say(`Reading ${name}'s sign-in…`);
    const read = await signInOf(vendor, { bin, cwd, env: environment, signal });
    if (read === undefined) signal?.throwIfAborted();
    if (read?.signedIn !== true) refuse(notSignedInText(vendor, read), { cause: 'signin', vendor, signedIn: read?.signedIn ?? null });
    const steps = ADAPTERS[vendor].conformance; let done = 0;
    const again = earlier && earlier.bin === bin && earlier.version === version.release;
    say(`${again ? `Checking ${name} again first` : `One-time check of ${name} on this machine first`}: ${TURNS} on it, a few minutes.`, { keep: true });
    say(`Checking ${name}, 0 of ${steps.length} done.`);
    const scratch = tempFolder(`elu-code-check-${vendor}-`);
    const log = line => {
      const step = /^([a-z][a-z0-9-]*): (pass|fail|skip)$/.exec(line); if (!step) return;
      const what = STEP_TEXT[step[1]] ?? step[1];
      say(`Checking ${name}, ${++done} of ${steps.length} done${step[2] === 'pass' ? `: ${what}.` : step[2] === 'skip' ? `. Skipped: ${what}.` : `. Not proven: ${what}.`}`);
    };
    const run = runConformance(vendor, { bin, version: version.release, scratch, env: agentEnv(environment), log })
      .finally(() => { try { fs.rmSync(scratch, { recursive: true, force: true }); } finally { release(); } });
    handed = true; run.catch(() => {});
    await stoppable(run, signal);
    return ended();
  } finally { if (!handed) release(); }
}
// Another tool's hooks or MCP servers that the vendor would run on this computer: before a turn
// outside Full access the owner is asked once, with their names, and his answer is kept for
// that release of the vendor. ask(title) shows the question and gives 'allow', 'deny' or
// 'timeout'. Full access is never asked, and neither is a vendor with nothing of the kind.
export async function allowLoads(row, { mode, ask, say = () => {} } = {}) {
  const vendor = row?.vendor;
  if (!row?.available || !CAPS[vendor]?.conformance || mode === 'full' || row.version === null || typeof ask !== 'function') return;
  const result = checkResult(vendor, { bin: row.bin, version: row.release ?? null });
  if (!result || result.failed.length || !result.runs.length || result.answer) return;
  const name = VENDOR_NAMES[vendor], names = loadsList(result.runs);
  say(`${name} would also run ${names} on this machine. You are asked once: yes lets it, no keeps ${name} to Full access.`, { keep: true });
  const decision = await ask(`Run ${names}`);
  if (decision === 'allow' || decision === 'deny') answerLoads(vendor, decision);
  if (decision !== 'allow') refuse(decision === 'deny' ? `${name} is off outside Full access on this machine: you did not let it run ${names}. c on its line in the Usage tab asks again.` : `${name} did not start: no answer about ${names}. Your next message to it asks again.`);
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
// the first with why, more how many others; it runs in Full access only), or needed (no
// record for them). notes: what the Usage tab says under the vendor, the same words the chat
// got. asks: the owner said no to what it would run, and c asks him again.
export function checkState(row) {
  const result = row.version === null ? null : checkResult(row.vendor, { bin: row.bin, version: row.release ?? null });
  if (row.conformant === true) return { check: 'ready', notProven: null, more: 0, notes: loadsNotes(row.vendor, result), asks: result?.answer === 'deny' };
  const [first] = result?.failed ?? [];
  if (!first) return { check: 'needed', notProven: null, more: 0, notes: [], asks: false };
  const notProven = `${first.text}${first.why ? ` (${first.why})` : ''}`, more = result.failed.length - 1;
  return { check: 'failed', notProven, more, notes: [`Not proven: ${notProven}${more ? `, and ${more} more` : ''}.`], asks: false };
}
// c on a vendor whose owner said no to what it would run: the answer is forgotten, so his next message to it asks again.
export function askLoadsAgain(vendor) { answerLoads(vendor, null); }
// A vendor read by its token file (Grok Build): true or false; null for one that has no such file to look for.
const fileSignIn = (vendor, env) => { try { return ADAPTERS[vendor].signInFile?.({ env }) ?? null; } catch { return null; } };
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
  const name = VENDOR_NAMES[vendor], scratch = tempFolder(`elu-code-signin-${vendor}-`);
  try {
    // The release first, as the check asks it: one that cannot run here is not asked more.
    // A stop (the tab is left, the app closes) ends the program and the read says nothing.
    let version; try { version = await probeVersion(vendor, bin, scratch, env, { check: true, signal }); } catch (error) { if (signal?.aborted) return null; throw error; }
    if (!version.supported) return { signedIn: null, supported: false, reason: `${name} ${version.release ?? ''}`.trim() + `: ${version.reason}` };
    const read = await signInOf(vendor, { bin, cwd: scratch, env, signal });
    if (read === undefined) return null;
    return { signedIn: read.signedIn, supported: true, reason: read.signedIn === null ? `${name} did not say whether it is signed in: it ${read.reason ?? 'gave no answer'}.` : null };
  } finally { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* A leftover temp folder is harmless. */ } }
}
// One vendor's sign-in read now, for the Usage tab after the owner signed it in there (s):
// saved as the tab's reads are. Returns the read, or null when it was stopped.
export async function readSignInNow(row, { env = process.env, signal } = {}) {
  if (!row?.available || !CAPS[row.vendor]?.conformance) return null;
  if (!RUNS_PROGRAM.has(row.vendor)) return { signedIn: fileSignIn(row.vendor, env), supported: true, reason: null };
  const read = await readSignIn(row, { env, signal });
  if (read && !signal?.aborted) saveSignIn(row.vendor, { bin: row.bin, ...read });
  return read;
}
