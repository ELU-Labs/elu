import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdir, noSymlinks, personalDirectory, readJson, refuse } from './util.mjs';
import { agentEnv, processIdentity } from './process.mjs';
import { ADAPTERS } from './adapters/index.mjs';
import { CAPS, VENDOR_NAMES } from './vendors.mjs';
import { STEP_TEXT, conformanceState, conformant, runConformance, uncheckedText } from './conformance.mjs';
import { probeVersion, vendorProblem } from './detect.mjs';

// The one-time check of a vendor (lib/conformance.mjs), started by the app itself. A vendor
// that needs the check gets it before the first turn the owner sends to it on this machine:
// there is no command to type. Only a message the owner just sent starts a check, because
// the check spends the owner's usage of that vendor: a schedule's turn, a shadow's or a
// review never does (the runner says there that the owner's first message will). The check
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
