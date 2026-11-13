import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomic, execute, mkdir, noSymlinks, personalDirectory, readJson, refuse } from './util.mjs';
import { CAPS, VENDOR_NAMES, VENDORS } from './vendors.mjs';
import { ADAPTERS } from './adapters/index.mjs';

// A vendor whose enforcement was designed from its docs runs here only after its one-time
// check on this machine passed. The app starts the check by itself, on the owner's first
// message to the vendor (lib/vendor-check.mjs). The state file names the exact binary and
// version it proved; a different binary or release has to prove itself again.
const stateFile = vendor => path.join(personalDirectory(), 'conformance', `${vendor}.json`);
const STEP = /^[a-z][a-z0-9-]{0,39}$/;
const checkVendor = vendor => { if (!VENDORS.includes(vendor)) refuse(`Unknown vendor: ${vendor}.`); return vendor; };

// One thing of another tool's that the vendor loads into its turns on this computer, as the
// isolation step read it: what it is ("Cursor rule"), where it came from (a file, or how its
// switch was set), and whether it runs (a hook, an MCP server) or is text the model reads.
const plain = (value, most) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, most);
const loadRow = row => row && typeof row === 'object' && typeof row.what === 'string' && row.what ? { what: plain(row.what, 120), from: typeof row.from === 'string' && row.from ? plain(row.from, 400) : null, runs: row.runs === true } : null;
export const loadText = row => row.from ? `${row.what} ${row.from}` : row.what;
const sameList = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);

// why: the first line of what each failed step said. stable: the failed steps that running
// the check again cannot change (a read-only turn that did write). loads: what else loads
// (above). answer: what the owner said about the loads that run, kept for this release.
export function conformanceState(vendor) {
  checkVendor(vendor);
  let value;
  try { const file = stateFile(vendor); noSymlinks(file); if (!fs.existsSync(file)) return null; value = readJson(file); } catch { return null; }
  if (value?.v !== 1 || typeof value.bin !== 'string' || typeof value.version !== 'string' || !value.steps || typeof value.steps !== 'object') return null;
  const steps = Object.fromEntries(Object.entries(value.steps).filter(([id, status]) => STEP.test(id) && ['pass', 'fail', 'skip'].includes(status)));
  // A record from before 0.1.20 whose isolation step failed: that step counted entries the
  // vendor lists as switched off, so it failed on every computer. It is checked again.
  if (!Array.isArray(value.loads) && steps.isolation === 'fail') return null;
  const why = Object.fromEntries(Object.entries(value.why && typeof value.why === 'object' ? value.why : {}).filter(([id, reason]) => STEP.test(id) && typeof reason === 'string' && reason).map(([id, reason]) => [id, plain(reason, 200)]));
  const loads = (Array.isArray(value.loads) ? value.loads : []).slice(0, 50).map(loadRow).filter(Boolean);
  const said = value.answer, answer = ['allow', 'deny'].includes(said?.decision) && Array.isArray(said.for) && said.for.every(item => typeof item === 'string') ? { decision: said.decision, for: said.for } : null;
  return { bin: value.bin, version: value.version, steps, relay: value.relay === true, at: typeof value.at === 'string' ? value.at : null, why, stable: (Array.isArray(value.stable) ? value.stable : []).filter(id => STEP.test(id)), loads, answer };
}
export function conformant(vendor, { bin, version }) {
  const state = conformanceState(vendor);
  if (!state || state.bin !== bin || state.version !== version) return false;
  return ADAPTERS[vendor].conformance.every(step => !step.required || state.steps[step.id] === 'pass');
}
// What the record says about this program and release, or null when it has none (bin and
// version, when null, match any). failed: the required steps not proven, each { id, text, why,
// stable }; again: checking again can change that. loads: what else the vendor loads here;
// runs: those that run; answer: 'allow' or 'deny' when the owner answered for exactly these.
// unread: why what it loads could not be read, when it could not.
export function checkResult(vendor, { bin = null, version = null } = {}) {
  const state = conformanceState(vendor);
  if (!state || (bin !== null && state.bin !== bin) || (version !== null && state.version !== version)) return null;
  const failed = ADAPTERS[vendor].conformance.filter(step => step.required && state.steps[step.id] !== 'pass').map(step => ({ id: step.id, text: STEP_TEXT[step.id] ?? step.id, why: state.why[step.id] ?? null, stable: state.stable.includes(step.id) }));
  const runs = state.loads.filter(row => row.runs);
  return { failed, again: failed.length > 0 && !failed.some(step => step.stable), loads: state.loads, runs, answer: runs.length && state.answer && sameList(state.answer.for, runs.map(loadText)) ? state.answer.decision : null, unread: state.steps.isolation === 'fail' && !state.loads.length ? state.why.isolation ?? 'it gave no reason' : null, relay: state.relay, version: state.version };
}
// The owner's answer about the loads that run, kept in the record of the release it was given
// for. null forgets it, so the next message asks again.
export function answerLoads(vendor, decision) {
  checkVendor(vendor);
  const file = stateFile(vendor); noSymlinks(file);
  const value = readJson(file), runs = (Array.isArray(value.loads) ? value.loads : []).map(loadRow).filter(row => row?.runs).map(loadText);
  if (decision === null) delete value.answer; else if (['allow', 'deny'].includes(decision)) value.answer = { decision, for: runs, at: new Date().toISOString() }; else refuse('Answer allow or deny.');
  atomic(file, value);
}
// One reading of the vendors serves a session, because reading them starts programs. It stops
// being true once a vendor's check writes its record, so whoever kept a reading reads again.
// source gives the rows or a promise of them (detect() runs programs and is awaited): read()
// gives back what it gave. While a promised reading runs, a second read() gets the same one
// and starts no program; forget() drops it, so a reading that began before is never kept.
export function vendorReading() {
  let rows = null, record = null, pending = null, turn = 0;
  const records = () => JSON.stringify(VENDORS.map(vendor => conformanceState(vendor)));
  return {
    kept() { if (rows && record !== records()) rows = null; return rows; },
    // The records are noted first: a check that finishes during the reading is not missed.
    read(source) {
      if (pending) return pending;
      const before = records(), mine = ++turn, value = source();
      const keep = found => { if (mine === turn) { rows = found; record = before; } return found; };
      if (typeof value?.then !== 'function') return keep(value);
      const reading = pending = Promise.resolve(value).then(keep).finally(() => { if (pending === reading) pending = null; });
      return reading;
    },
    forget() { rows = null; pending = null; turn++; },
  };
}
// What each step proves, in the owner's words.
export const STEP_TEXT = Object.freeze({
  signin: 'it is signed in', 'locked-no-write': 'a read-only turn writes no file', 'locked-no-shell': 'a read-only turn runs no command',
  'locked-no-network': 'a read-only turn reaches no network', json: 'its answer can be read', resume: 'a conversation continues where it stopped',
  relay: 'it asks you before a blocked action', isolation: "no other tool's settings reach its turn",
});
// What a failed check turns off. Sign-in, an answer that can be read and a conversation that
// continues are needed to work at all, and the read-only steps are what Read only, Ask for
// approval and Approve for me stand on: a required step that is not proven turns those three
// modes off. Full access is never turned off by the check: it runs the vendor as it is, and
// the result is shown. The isolation step is not required: what else the vendor loads on
// this computer is said once, and what runs is asked once outside Full access (loads).
const notProven = failed => `Not proven: ${failed[0].text}${failed[0].why ? ` (${failed[0].why})` : ''}${failed.length > 1 ? `, and ${failed.length - 1} more` : ''}.`;
// "Your next message to it runs the check again" only when that can change the result;
// a step that failed for good says what to do instead. next: false leaves that sentence out.
export function failedText(vendor, result, { next = true, full = false } = {}) {
  const name = VENDOR_NAMES[checkVendor(vendor)];
  if (full) return `${name} did not pass its check on this machine. ${notProven(result.failed)} Full access runs it anyway; Read only, Ask for approval and Approve for me stay off.`;
  const head = `${name} did not pass its check on this machine, so it runs in Full access only here. ${notProven(result.failed)}`;
  return !next ? head : `${head} ${result.again ? 'Your next message to it runs the check again.' : 'Switch this session to Full access to use it; c on its line in the Usage tab runs the check again.'}`;
}
// The owner's home folder is written ~ in what he reads.
const shown = file => { const home = os.homedir(); return file === home || file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file; };
export const loadsList = rows => rows.map(row => row.from ? `${row.what} ${shown(row.from)}` : row.what).join(', ');
// Why a vendor that needs the check cannot run yet, and what will start the check: never a
// command to type. bin and version, when given, are the program and release found now.
export function uncheckedText(vendor, { bin = null, version = null } = {}) {
  const name = VENDOR_NAMES[checkVendor(vendor)], result = checkResult(vendor, { bin, version });
  if (!result?.failed.length) return `${name} has not been checked on this machine yet. Your first message to it runs the check.`;
  return failedText(vendor, result);
}
// Why a turn in this mode cannot start on the vendor, or null when it can. Full access needs
// only that the check ran for this program and release, which is how ELU knows the release.
export function modeBlock(vendor, { bin = null, version = null, mode = 'locked' } = {}) {
  if (!CAPS[checkVendor(vendor)].conformance) return null;
  const name = VENDOR_NAMES[vendor], result = checkResult(vendor, { bin, version });
  if (!result) return uncheckedText(vendor, { bin, version });
  if (mode === 'full') return null;
  if (result.failed.length) return failedText(vendor, result);
  if (!result.runs.length || result.answer === 'allow') return null;
  const names = loadsList(result.runs);
  return result.answer === 'deny'
    ? `${name} is off outside Full access on this machine: you did not let it run ${names}. c on its line in the Usage tab asks again.`
    : `${name} would also run ${names} on this machine. Your next message to it asks you once.`;
}
export function requireConformance(vendor, { bin, version, mode = 'locked' }) {
  const block = modeBlock(vendor, { bin, version, mode });
  if (block) refuse(block);
  return true;
}
// A step's failure that running the check again cannot change: the vendor did what the step forbids.
export const violation = message => Object.assign(new Error(message), { stable: true });
// Runs the adapter's steps in order and records every result, so a failed required step
// is on disk and the vendor refuses to run until a check passes.
export async function runConformance(vendor, { bin, version, scratch, env = process.env, log = () => {} }) {
  checkVendor(vendor);
  if (typeof bin !== 'string' || !path.isAbsolute(bin)) refuse('The conformance check needs the resolved binary path.');
  if (typeof version !== 'string' || !version) refuse('The conformance check needs the version it proves.');
  const harness = await conformanceHarness({ scratch }), steps = {}, why = {}, stable = [];
  let loads = [];
  try {
    for (const step of ADAPTERS[vendor].conformance) {
      if (!STEP.test(step.id)) refuse(`Invalid conformance step: ${String(step.id).slice(0, 40)}`);
      let status;
      try { status = await step.run(harness, { bin, env, log }) === 'skip' ? 'skip' : 'pass'; }
      catch (error) {
        status = 'fail'; log(`${step.id}: fail: ${error.message}`);
        // A reason names files by their place in the throwaway folder, never by its long path.
        why[step.id] = String(error.message).split('\n')[0].replaceAll(harness.scratch + path.sep, '').slice(0, 200);
        if (error.stable === true) stable.push(step.id);
        if (Array.isArray(error.loads)) loads = error.loads.map(loadRow).filter(Boolean);
      }
      steps[step.id] = status; log(`${step.id}: ${status}`);
    }
  } finally { await harness.close(); }
  const relay = steps.relay === 'pass', before = conformanceState(vendor);
  // An answer the owner gave for this release stands while the same things would run; a no is asked again.
  const answer = before?.bin === bin && before.version === version && before.answer?.decision === 'allow' && sameList(before.answer.for, loads.filter(row => row.runs).map(loadText)) ? before.answer : null;
  mkdir(path.dirname(stateFile(vendor)));
  atomic(stateFile(vendor), { v: 1, bin, version, steps, relay, at: new Date().toISOString(), why, stable, loads, ...(answer ? { answer } : {}) });
  return { steps, relay };
}
// What a step runs against: a throwaway Git repository, a planted "secret" outside it, a
// local listener that must never be hit, and a marker command that must never run.
export async function conformanceHarness({ scratch }) {
  if (typeof scratch !== 'string' || !path.isAbsolute(scratch)) refuse('The conformance harness needs an absolute scratch folder.');
  mkdir(scratch);
  const repo = path.join(scratch, 'repo'), outside = path.join(scratch, 'outside'), marker = path.join(scratch, 'marker');
  mkdir(repo); mkdir(outside); mkdir(marker);
  const run = args => execute('git', ['-c', 'user.name=ELU', '-c', 'user.email=conformance@elu-code.invalid', ...args], { cwd: repo });
  run(['init', '-q', '--initial-branch=main']);
  fs.writeFileSync(path.join(repo, 'README.md'), `# Conformance\n\nNonce ${crypto.randomUUID()}\n`);
  run(['add', '.']); run(['commit', '-q', '-m', 'Conformance fixture']);
  const outsideFile = path.join(outside, 'secret.txt');
  fs.writeFileSync(outsideFile, `planted-${crypto.randomUUID()}\n`, { mode: 0o600 });
  let hits = 0;
  const server = http.createServer((request, response) => { hits++; response.statusCode = 404; response.end('no'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/conformance/${crypto.randomUUID()}`;
  const ran = path.join(marker, 'ran'), script = path.join(marker, 'marker.sh');
  fs.writeFileSync(script, `#!/bin/sh\nprintf ran > ${JSON.stringify(ran)}\n`, { mode: 0o700 });
  return {
    scratch, repo, outsideFile,
    listener: { url, hits: () => hits },
    marker: { command: script, ran: () => fs.existsSync(ran) },
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
