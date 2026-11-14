// elu update, and the line the app shows when a newer version is out. Both ask the npm
// registry for the latest version of this package and send nothing else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomic, mkdir, noSymlinks, readJson, personalDirectory } from './util.mjs';
import { sameProcess } from './process.mjs';
import { PACKAGE, findCommand, installLine, installVersion, newer, npmCommand, prefixOf, runNpm } from './install.mjs';

export const REGISTRY = `https://registry.npmjs.org/${PACKAGE}/latest`;
const VERSION = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
const DAY_MS = 24 * 3600 * 1000;
export const ownVersion = () => readJson(fileURLToPath(new URL('../package.json', import.meta.url))).version;
export const noticeText = version => `ELU ${version} is out. /quit, then elu update.`;
export const UPDATE_IN_APP = 'To update, /quit, then run elu update.';

// Where the latest version is asked. Tests run a registry of their own on this computer and
// name it in ELU_UPDATE_REGISTRY; only an http address on this computer is taken from there.
export function registryUrl(env = process.env) {
  try {
    const url = new URL(env.ELU_UPDATE_REGISTRY ?? '');
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return url.href;
  } catch { /* Not set, or not an address. */ }
  return REGISTRY;
}
// The latest version on the registry, or null when it cannot be read in time: offline, an
// error, or an answer that is not a plain version number.
export async function latestVersion({ env = process.env, timeoutMs = 4000, fetcher = globalThis.fetch } = {}) {
  try {
    const response = await fetcher(registryUrl(env), { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const text = await response.text();
    const version = text.length < 1024 * 1024 ? JSON.parse(text)?.version : null;
    return typeof version === 'string' && VERSION.test(version) ? version : null;
  } catch { return null; }
}

// The new-version line, checked at most once a day. The time and the version seen are kept
// in the state folder, so a start the same day reads them and asks nothing. Off with
// ELU_NO_UPDATE_CHECK=1 and in tests. A check that fails says nothing.
const checkFile = () => path.join(personalDirectory(), 'update-check.json');
export const updateCheckOff = (env = process.env) => env.ELU_NO_UPDATE_CHECK === '1' || Boolean(env.NODE_TEST_CONTEXT);
export async function updateNotice({ env = process.env, now = Date.now(), current = ownVersion(), latest = latestVersion } = {}) {
  if (updateCheckOff(env)) return null;
  let saved = null;
  try { const file = checkFile(); noSymlinks(file); if (fs.existsSync(file)) saved = readJson(file); } catch { /* Checked again. */ }
  let version = typeof saved?.version === 'string' && VERSION.test(saved.version) ? saved.version : null;
  const at = Date.parse(saved?.checkedAt);
  if (!(at <= now && now - at < DAY_MS)) {
    version = await latest({ env }) ?? version;
    try { mkdir(personalDirectory()); atomic(checkFile(), { checkedAt: new Date(now).toISOString(), version }); } catch { /* Checked again next start. */ }
  }
  return version && newer(version, current) ? noticeText(version) : null;
}

// Other open apps: each holds the lock of the project it shows (claimView in projects.mjs).
export function openApps({ folder = personalDirectory(), self = process.pid } = {}) {
  let names = [];
  try { noSymlinks(folder); names = fs.readdirSync(folder).filter(name => /^view-[0-9a-f]{64}\.lock$/.test(name)); } catch { return 0; }
  const pids = new Set();
  for (const name of names) {
    try { const record = readJson(path.join(folder, name)); if (record.pid !== self && sameProcess(record)) pids.add(record.pid); } catch { /* Released meanwhile. */ }
  }
  return pids.size;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// The background parts still run the old code. The peer daemon is stopped and the new one
// started. The conductor is stopped when it has nothing running or queued; the next work
// starts the new one. A busy conductor takes no new work: it finishes the sessions it runs
// while the new version's conductor takes the queue (Conductor.drain).
// The login items need nothing: each start reads the files the update replaced.
// Both modules are loaded before the install, so this process never mixes files of two versions.
const background = () => Promise.all([import('./peer/index.mjs').catch(() => null), import('./conductor.mjs').catch(() => null)]);
async function restartBackground({ peer, conductor, bin, waitMs, from }) {
  const lines = [];
  try {
    if (peer && await peer.restartPeer({ bin, waitMs }) === 'stuck') lines.push('The old peer daemon did not stop. Open ELU and it restarts it.');
  } catch { /* No peer files: nothing runs. */ }
  try {
    // Any conductor that runs, a 0.1.16 one too, which takes no work from a later version.
    if (conductor?.conductorRunning()) {
      const status = conductor.conductorStatus(), running = status.runs.length;
      if (running) lines.push(`${running} running session${running === 1 ? ' finishes' : 's finish'} on ${from}. New sessions start on the new version.`);
      // Queued work only: it hands the queue to the new version's conductor by itself.
      else if (!status.queued) {
        conductor.sendCommand({ type: 'shutdown' });
        for (const until = Date.now() + waitMs; Date.now() < until && conductor.conductorRunning();) await pause(200);
      }
    }
  } catch { /* Nothing ran. */ }
  return lines;
}

// elu update: installs the latest version where the elu command is, then restarts what runs
// in the background. An app open in another terminal is not updated under it.
export async function runUpdate({ env = process.env, home = os.homedir(), write = () => {}, npm = npmCommand(env), run = runNpm, latest = latestVersion, apps = openApps, waitMs = 20000 } = {}) {
  const { have: found } = findCommand({ env, home }), have = found?.name === PACKAGE ? found : null;
  const current = have?.version ?? ownVersion();
  const version = await latest({ env, timeoutMs: 10000 });
  if (!version) return { success: false, message: 'Could not reach the npm registry. Check your connection, then run elu update again.' };
  if (!newer(version, current)) return { version: current, latest: version, message: `ELU ${current} is the latest.` };
  if (apps() > 0) return { success: false, version: current, latest: version, message: 'ELU is open in another terminal. /quit it there, then run elu update again.' };
  // The line to update by hand installs where the command is, as elu update does: under
  // ~/.local it names --prefix, or it would fail or put a second copy in npm's global folder.
  if (!npm) return { success: false, version: current, latest: version, message: `npm was not found. To update by hand: ${installLine(version, have?.root ? prefixOf(have.root) : null).text}` };
  const [peer, conductor] = await background();
  const done = installVersion(version, { have, env, home, npm, run, write, label: `Installing ELU ${version}` });
  if (done.failed) return { success: false, version: current, latest: version, message: `The update did not work (${done.failed}). To update by hand: ${done.line}` };
  const lines = await restartBackground({ peer, conductor, bin: path.join(done.made.root, 'bin', 'elu-code.mjs'), waitMs, from: current });
  return { version, previous: current, message: [`Updated ELU ${current} → ${version}. Open it again with elu.`, ...lines].join('\n') };
}
