import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { findBin, noSymlinks, personalDirectory } from './util.mjs';
import { agentEnv } from './process.mjs';
import { DEFAULT_LOGIN, keychainAccount, keychainItems, loginEnv, loginFolder, normalHome } from './logins.mjs';
import { readAccounts, usageSnapshot } from './usage.mjs';
import { claudeAccountOf, claudeAccounts, markSignIn, readSwitch, signedInAgain, spentMark, threshold } from './claude-switch.mjs';

// The Claude accounts the relay (lib/claude-relay.mjs) moves work between: the sign-in of each,
// read where Claude Code keeps it, how much of its windows each has used, and which one goes next.
//
// A sign-in is read, never written. On macOS Claude Code keeps it in the login Keychain, as a
// generic password named after the account's folder (keychainItems in lib/logins.mjs); on Linux
// in .credentials.json in that folder. It is held in memory only, for the relay to send to
// Anthropic, and never goes into a file, a log, an environment or an error. When one is about
// to run out, Claude Code renews it: `claude auth status` in that account's folder renews a
// sign-in that ends within five minutes (seen on 2.1.325), writing it back itself under its own
// lock. ELU never renews one: a renewal hands out a new refresh token, and two writers could
// sign an account out.
const RENEW_WITHIN_MS = 5 * 60 * 1000, READ_AGAIN_MS = 60 * 1000, FORCED_EVERY_MS = 10 * 1000;
const kept = new Map(), renewing = new Map(), forced = new Map(), failed = new Map();
// A sign-in is told apart from the one before it by the start of its SHA-256, kept in memory only.
const tagOf = token => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
const run = (bin, args, { env, timeout }) => new Promise(resolve => {
  execFile(bin, args, { env, timeout, encoding: 'utf8', maxBuffer: 1024 * 1024, cwd: personalDirectory() }, (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout: String(stdout ?? '') }));
});
// What Claude Code stores: { claudeAiOauth: { accessToken, refreshToken, expiresAt, … } }. The
// Keychain gives it back as text, or as hex when it was saved with -X and holds other bytes.
function signInOf(text) {
  let value = String(text ?? '').trim();
  if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) { try { const decoded = Buffer.from(value, 'hex').toString('utf8'); if (decoded.trim().startsWith('{')) value = decoded; } catch { /* Not hex. */ } }
  let row; try { row = JSON.parse(value)?.claudeAiOauth; } catch { return null; }
  if (!row || typeof row.accessToken !== 'string' || !row.accessToken || /[\s\x00-\x1f]/.test(row.accessToken)) return null;
  return { accessToken: row.accessToken, expiresAt: Number.isFinite(row.expiresAt) ? row.expiresAt : null };
}
// The account's own folder: the owner's own Claude Code home, or the one ELU made for it.
const folderOf = (id, env) => id === DEFAULT_LOGIN ? normalHome('claude', env) : loginFolder('claude', id);
// Where Claude Code keeps this account's sign-in on macOS: "Claude Code-credentials" for the
// owner's own (with "-" and the folder's hash when CLAUDE_CONFIG_DIR names his home), the
// folder's own name for an added one.
export function keychainService(id, env = process.env) {
  if (id !== DEFAULT_LOGIN) return keychainItems(loginFolder('claude', id))[0];
  return typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR ? keychainItems(env.CLAUDE_CONFIG_DIR)[0] : 'Claude Code-credentials';
}
async function readStore(id, { env, platform }) {
  if (platform === 'darwin') {
    const security = findBin('security', env) ?? '/usr/bin/security';
    const read = await run(security, ['find-generic-password', '-a', keychainAccount(env), '-w', '-s', keychainService(id, env)], { env: { PATH: env.PATH ?? '/usr/bin:/bin', HOME: env.HOME ?? '', USER: env.USER ?? '' }, timeout: 10000 });
    if (read.code === 0) { const found = signInOf(read.stdout); if (found) return found; }
    // 36: the Keychain is locked and nobody is there to open it. The account is left out.
    if (read.code === 36) return { locked: true };
  }
  const file = path.join(folderOf(id, env), '.credentials.json');
  try { noSymlinks(file); return signInOf(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
const stampOf = (id, env) => { try { const stat = fs.statSync(path.join(folderOf(id, env), '.credentials.json')); return `${stat.mtimeMs}:${stat.size}`; } catch { return '-'; } };
// The account's sign-in: { accessToken, expiresAt } or null. Read again when asked to (force),
// when it ends soon, when its file changed, and at least every minute.
// An account marked to sign in again is taken back the moment a sign-in that works is read for
// it: one that has not ended, and is not the one Anthropic or a renewal turned down here.
export async function signIn(id, options = {}) { return (await readSignIn(id, options)).value; }
async function readSignIn(id, { env = process.env, platform = process.platform, force = false, now = Date.now() } = {}) {
  const held = kept.get(id), stamp = stampOf(id, env);
  if (!force && held && held.stamp === stamp && now - held.at < READ_AGAIN_MS && !(held.value?.expiresAt && held.value.expiresAt - now < RENEW_WITHIN_MS)) return { value: held.value, locked: held.locked };
  const read = await readStore(id, { env, platform }), value = read?.locked ? null : read, locked = read?.locked === true;
  kept.set(id, { at: Date.now(), stamp, value, locked });
  if (value && !(value.expiresAt !== null && value.expiresAt <= Date.now()) && tagOf(value.accessToken) !== failed.get(id)) {
    try { if (readSwitch().signIn?.[id]) signedInAgain(id); } catch { /* Taken back at the next read. */ }
  }
  return { value, locked };
}
// Anthropic turned this sign-in down after Claude Code renewed it: the account waits for a new
// one, and this one never takes it back.
export function signInFailed(id, token) {
  if (token) failed.set(id, tagOf(token));
  try { markSignIn(id); } catch { /* Left out for this request all the same. */ }
}
export const forgetSignIns = () => { kept.clear(); };
// For a test: nothing held from an earlier one.
export function forgetAll() { kept.clear(); renewing.clear(); forced.clear(); failed.clear(); readings.clear(); }
// Claude Code renews the account's sign-in, and it is read again. Runs that ask at once share
// one renewal; a renewal that is asked for again is run at most every ten seconds. An account
// whose sign-in is gone, or still ended after Claude Code ran to the end, is marked to sign in
// again. A renewal that could not run (no network, a time out, a locked Keychain) marks
// nothing: the account is left out of that request only, and tried again on the next.
export function renew(id, { bin = findBin('claude'), env = process.env, platform = process.platform, timeout = 30000 } = {}) {
  if (renewing.has(id)) return renewing.get(id);
  const job = (async () => {
    let ran = null;
    if (bin && Date.now() - (forced.get(id) ?? 0) >= FORCED_EVERY_MS) {
      forced.set(id, Date.now());
      ran = await run(bin, ['auth', 'status'], { env: agentEnv(env, [], loginEnv('claude', id)), timeout });
    }
    const { value, locked } = await readSignIn(id, { env, platform, force: true });
    if (value && !(value.expiresAt !== null && value.expiresAt <= Date.now())) return value;
    if (ran?.code === 0 && !locked) signInFailed(id, value?.accessToken ?? null);
    return null;
  })().finally(() => renewing.delete(id));
  renewing.set(id, job);
  return job;
}
// A sign-in good for at least the next five minutes, renewed first when it is not.
export async function freshSignIn(id, options = {}) {
  const value = await signIn(id, options);
  if (value && !(value.expiresAt !== null && value.expiresAt - Date.now() < RENEW_WITHIN_MS)) return value;
  return renew(id, options);
}
// Each account marked to sign in again is read again, and renewed by Claude Code when its
// sign-in ends soon: one that works now is taken back (signIn). Returns whether any was.
// renewing false: only read, as the conductor does while nothing runs on it.
export async function recheckSignIns({ renewing = true, ...options } = {}) {
  const marked = () => { try { return Object.keys(readSwitch().signIn ?? {}); } catch { return []; } }, before = marked();
  for (const { id } of claudeAccounts(options.env ?? process.env)) if (before.includes(id)) { try { await (renewing ? freshSignIn : signIn)(id, { ...options, force: true }); } catch { /* Still marked. */ } }
  return marked().length < before.length;
}
export const signInsMarked = (state = readSwitch()) => Object.keys(state.signIn ?? {}).length > 0;

// How much of its windows each account has used, as last seen: the relay's own readings of
// this process first (fresher), then what Usage keeps (usage.json for the owner's own,
// accounts.json for each other). Windows as Usage keeps them: { usedPercent, resetsAt (s) }.
const readings = new Map();
export function noteReading(id, windows) { readings.set(id, { ...readings.get(id), ...windows, at: Date.now() }); }
export function readingOf(id, now = Date.now()) {
  const fresh = readings.get(id), current = row => row && !(row.resetsAt && row.resetsAt * 1000 <= now) ? row : null;
  if (fresh && now - fresh.at < 10 * 60 * 1000) return { fiveHour: current(fresh.fiveHour), weekly: current(fresh.weekly), at: fresh.at };
  let stored = null;
  try {
    if (id === DEFAULT_LOGIN) stored = usageSnapshot(now).claude;
    if (!stored?.fiveHour && !stored?.weekly) { const email = claudeAccountOf(id)?.email; stored = email ? readAccounts().find(row => row.vendor === 'claude' && row.account === email)?.usage ?? null : null; }
  } catch { stored = null; }
  return { fiveHour: current(stored?.fiveHour), weekly: current(stored?.weekly), at: Date.parse(stored?.observedAt ?? '') || 0 };
}
// The windows of an account at or over the threshold, with the latest reset among them (ms).
// A reading from before the owner chose the account by hand says nothing: he chose it to be tried.
export function overAt(id, { now = Date.now(), state = readSwitch() } = {}) {
  if (state.extraUsage === true) return null;
  const reading = readingOf(id, now), limit = threshold(state) * 100;
  if (state.picked?.id === id && reading.at <= Date.parse(state.picked.at)) return null;
  const over = [['fiveHour', reading.fiveHour], ['weekly', reading.weekly]].filter(([, row]) => Number.isFinite(row?.usedPercent) && row.usedPercent >= limit && row.resetsAt * 1000 > now);
  if (!over.length) return null;
  const [window, row] = over.sort((a, b) => b[1].resetsAt - a[1].resetsAt)[0];
  return { window, until: row.resetsAt * 1000 };
}
// Whether new work may go to this account now: not at a limit, not waiting for a sign-in.
// signIn false: the run uses Claude Code's own sign-in of this account (the account it was
// started on), which a mark for the sign-ins ELU reads says nothing about.
export function usable(id, { model = null, now = Date.now(), state = readSwitch(), signIn = true } = {}) {
  return !spentMark(state, id, { model, now }) && !(signIn && state.signIn?.[id]) && !overAt(id, { now, state });
}
// Why an account is not usable, for the line a move writes: the limit it reached.
export function whyLeft(id, { model = null, now = Date.now(), state = readSwitch() } = {}) {
  const mark = spentMark(state, id, { model, now });
  if (mark) return { why: mark.window, model: mark.model ?? null };
  if (state.signIn?.[id]) return { why: 'signIn', model: null };
  return { why: overAt(id, { now, state })?.window ?? 'weekly', model: null };
}
// The account work goes to next: one with room, the owner's order first, then the one whose
// week resets soonest (its room is lost soonest), then the one with the most of its five hours
// left. An account whose use is not known yet has room.
export function pick({ exclude = [], model = null, now = Date.now(), state = readSwitch(), env = process.env } = {}) {
  const ids = claudeAccounts(env).map(row => row.id).filter(id => !exclude.includes(id) && usable(id, { model, now, state }));
  const order = state.order ?? [], rank = id => order.includes(id) ? order.indexOf(id) : order.length;
  const weekly = id => readingOf(id, now).weekly?.resetsAt ?? Infinity, used = id => readingOf(id, now).fiveHour?.usedPercent ?? 0;
  return ids.sort((a, b) => rank(a) - rank(b) || weekly(a) - weekly(b) || used(a) - used(b))[0] ?? null;
}
// When the account's own limit ends (ms), or null when it is at none.
export function limitOf(id, { model = null, now = Date.now(), state = readSwitch() } = {}) {
  const mark = spentMark(state, id, { model, now }), over = overAt(id, { now, state });
  const at = Math.max(mark ? Date.parse(mark.until) : 0, over ? over.until : 0);
  return at > now ? at : null;
}
// When the first account is free again, when none is now: { id, at } (ms), or null when none
// will be by itself (each waits for a sign-in).
export function firstFree({ model = null, now = Date.now(), state = readSwitch(), env = process.env } = {}) {
  let best = null;
  for (const { id } of claudeAccounts(env)) {
    if (state.signIn?.[id]) continue;
    const at = limitOf(id, { model, now, state }) ?? now;
    if (!best || at < best.at) best = { id, at };
  }
  return best;
}
