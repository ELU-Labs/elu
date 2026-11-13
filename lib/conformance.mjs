import fs from 'node:fs';
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

export function conformanceState(vendor) {
  checkVendor(vendor);
  let value;
  try { const file = stateFile(vendor); noSymlinks(file); if (!fs.existsSync(file)) return null; value = readJson(file); } catch { return null; }
  if (value?.v !== 1 || typeof value.bin !== 'string' || typeof value.version !== 'string' || !value.steps || typeof value.steps !== 'object') return null;
  const steps = Object.fromEntries(Object.entries(value.steps).filter(([id, status]) => STEP.test(id) && ['pass', 'fail', 'skip'].includes(status)));
  return { bin: value.bin, version: value.version, steps, relay: value.relay === true, at: typeof value.at === 'string' ? value.at : null };
}
export function conformant(vendor, { bin, version }) {
  const state = conformanceState(vendor);
  if (!state || state.bin !== bin || state.version !== version) return false;
  return ADAPTERS[vendor].conformance.every(step => !step.required || state.steps[step.id] === 'pass');
}
// One reading of the vendors serves a session, because reading them starts programs. It stops
// being true once a vendor's check writes its record, so whoever kept a reading reads again.
export function vendorReading() {
  let rows = null, record = null;
  const records = () => JSON.stringify(VENDORS.map(vendor => conformanceState(vendor)));
  return {
    kept() { if (rows && record !== records()) rows = null; return rows; },
    // The records are noted first: a check that finishes during the reading is not missed.
    read(source) { const before = records(); rows = source(); record = before; return rows; },
    forget() { rows = null; },
  };
}
// What each step proves, in the owner's words.
export const STEP_TEXT = Object.freeze({
  signin: 'it is signed in', 'locked-no-write': 'a read-only turn writes no file', 'locked-no-shell': 'a read-only turn runs no command',
  'locked-no-network': 'a read-only turn reaches no network', json: 'its answer can be read', resume: 'a conversation continues where it stopped',
  relay: 'it asks you before a blocked action', isolation: "no other tool's settings reach its turn",
});
// Why a vendor that needs the check cannot run yet, and what will start the check: never a
// command to type. bin and version, when given, are the program and release found now.
export function uncheckedText(vendor, { bin = null, version = null } = {}) {
  const name = VENDOR_NAMES[checkVendor(vendor)], state = conformanceState(vendor);
  const failed = state && (bin === null || state.bin === bin) && (version === null || state.version === version)
    ? ADAPTERS[vendor].conformance.filter(step => step.required && state.steps[step.id] !== 'pass').map(step => STEP_TEXT[step.id] ?? step.id) : [];
  if (!failed.length) return `${name} has not been checked on this machine yet. Your first message to it runs the check.`;
  return `${name} did not pass its check on this machine (not proven: ${failed[0]}${failed.length > 1 ? `, and ${failed.length - 1} more` : ''}). Your next message to it runs the check again.`;
}
export function requireConformance(vendor, { bin, version }) {
  checkVendor(vendor);
  if (!CAPS[vendor].conformance) return true;
  if (!conformant(vendor, { bin, version })) refuse(uncheckedText(vendor, { bin, version }));
  return true;
}
// Runs the adapter's steps in order and records every result, so a failed required step
// is on disk and the vendor refuses to run until a check passes.
export async function runConformance(vendor, { bin, version, scratch, env = process.env, log = () => {} }) {
  checkVendor(vendor);
  if (typeof bin !== 'string' || !path.isAbsolute(bin)) refuse('The conformance check needs the resolved binary path.');
  if (typeof version !== 'string' || !version) refuse('The conformance check needs the version it proves.');
  const harness = await conformanceHarness({ scratch }), steps = {};
  try {
    for (const step of ADAPTERS[vendor].conformance) {
      if (!STEP.test(step.id)) refuse(`Invalid conformance step: ${String(step.id).slice(0, 40)}`);
      let status;
      try { status = await step.run(harness, { bin, env, log }) === 'skip' ? 'skip' : 'pass'; }
      catch (error) { status = 'fail'; log(`${step.id}: fail: ${error.message}`); }
      steps[step.id] = status; log(`${step.id}: ${status}`);
    }
  } finally { await harness.close(); }
  const relay = steps.relay === 'pass';
  mkdir(path.dirname(stateFile(vendor)));
  atomic(stateFile(vendor), { v: 1, bin, version, steps, relay, at: new Date().toISOString() });
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
