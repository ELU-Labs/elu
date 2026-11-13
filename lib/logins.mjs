import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, mkdir, noSymlinks, personalDirectory, readJson, refuse, within } from './util.mjs';
import { lock } from './state.mjs';

// Several accounts of one vendor, all signed in at once. Each account the owner adds has a
// folder of its own that the vendor's command line takes as its home (Claude Code's
// CLAUDE_CONFIG_DIR, Codex's CODEX_HOME), so its sign-in sits apart from every other:
// Claude Code names its macOS Keychain item after the folder ("Claude Code-credentials-"
// and the first eight hex digits of the folder's SHA-256) and keeps .credentials.json in it
// on Linux; Codex keeps auth.json in it, or a keyring item named after it. The owner's own
// sign-in is the account "default": the vendor's normal home, which ELU never copies.
// Switching picks the folder a new run is started with. Nothing is signed out, moved or
// copied, so a turn that is running keeps its account, and a token that renews itself
// renews in its own folder.
// Everything but the sign-in is the owner's normal home: each entry SHARED names is a link to
// the entry of that name there, so settings, memory, skills, agents, plugins, hooks, and the
// sessions a later turn resumes are the same on every account. What is not shared is the
// sign-in and what belongs to it (Claude Code's .claude.json, which names the account, and the
// settings an organization sends its accounts).
export const LOGIN_VENDORS = Object.freeze(['claude', 'codex']);
export const DEFAULT_LOGIN = 'default';
const ID = /^[a-z0-9]{8}$/;
export const LOGIN_ENV = Object.freeze({ claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' });
const FOLDER = Object.freeze({ claude: '.claude', codex: '.codex' });
export const SHARED = Object.freeze({
  claude: Object.freeze(['settings.json', 'settings.local.json', 'CLAUDE.md', 'projects', 'skills', 'agents', 'commands', 'plugins', 'hooks', 'output-styles', 'rules', 'workflows', 'plans', 'todos', 'file-history', 'history.jsonl', 'keybindings.json']),
  codex: Object.freeze(['config.toml', 'AGENTS.md', 'AGENTS.override.md', 'skills', 'prompts', 'rules', 'memories', 'sessions', 'archived_sessions', 'history.jsonl']),
});
// Made in the normal home when missing, so a session started on one account is found when a
// later turn resumes it on another.
const SESSIONS = Object.freeze({ claude: 'projects', codex: 'sessions' });

const isLoginVendor = vendor => LOGIN_VENDORS.includes(vendor);
const stateFile = () => path.join(personalDirectory(), 'logins.json');
const vendorRoot = vendor => path.join(personalDirectory(), 'logins', vendor);
// The folder of an added account: <personal>/logins/<vendor>/<id>/.claude (or .codex). The
// last name is the vendor's own, so the vendor reads it as its home folder.
export function loginFolder(vendor, id) {
  if (!isLoginVendor(vendor) || !ID.test(String(id))) refuse('That is not an account ELU added.');
  return path.join(vendorRoot(vendor), id, FOLDER[vendor]);
}
// The vendor's normal home: where its own sign-in, settings and memory live.
export function normalHome(vendor, env = process.env) {
  const named = env[LOGIN_ENV[vendor]];
  return typeof named === 'string' && path.isAbsolute(named) ? named : path.join(typeof env.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : os.homedir(), FOLDER[vendor]);
}
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
// logins.json: per vendor, the accounts added (an id and when) and the one in use. Never an
// email, a token or a path.
function readState() {
  let value = {};
  try { const file = stateFile(); noSymlinks(file); if (fs.existsSync(file)) value = readJson(file) ?? {}; } catch { value = {}; }
  return Object.fromEntries(LOGIN_VENDORS.map(vendor => {
    const row = value[vendor] && typeof value[vendor] === 'object' ? value[vendor] : {};
    const added = (Array.isArray(row.added) ? row.added : []).filter(item => ID.test(String(item?.id))).map(item => ({ id: item.id, addedAt: iso(item.addedAt) })).slice(0, 20);
    const active = added.some(item => item.id === row.active) ? row.active : DEFAULT_LOGIN;
    return [vendor, { active, added }];
  }));
}
function change(edit) {
  let release;
  try {
    release = lock({ state: personalDirectory() }, 'logins');
    const next = readState(); edit(next);
    atomic(stateFile(), { version: 1, ...next });
    return next;
  } finally { try { release?.(); } catch { /* Lock cleanup is optional. */ } }
}
// The accounts of a vendor in the order they were added: the owner's own first, then each
// added one whose folder is still there.
export function listLogins(vendor) {
  if (!isLoginVendor(vendor)) return [DEFAULT_LOGIN];
  return [DEFAULT_LOGIN, ...readState()[vendor].added.filter(item => { try { return fs.lstatSync(loginFolder(vendor, item.id)).isDirectory(); } catch { return false; } }).map(item => item.id)];
}
// The account a new run of this vendor starts with.
export function activeLogin(vendor) {
  if (!isLoginVendor(vendor)) return DEFAULT_LOGIN;
  const { active } = readState()[vendor];
  return listLogins(vendor).includes(active) ? active : DEFAULT_LOGIN;
}
export function useLogin(vendor, id) {
  if (!isLoginVendor(vendor) || !listLogins(vendor).includes(id)) refuse('That account is not signed in here.');
  change(state => { state[vendor].active = id; });
}
// What a run of this vendor on this account adds to its environment: nothing for the owner's
// own sign-in, the account's folder for an added one.
export function loginEnv(vendor, id = activeLogin(vendor)) {
  if (!isLoginVendor(vendor) || id === DEFAULT_LOGIN) return {};
  return { [LOGIN_ENV[vendor]]: loginFolder(vendor, id) };
}
// Lays a link in the account's folder to each shared entry of the normal home. An entry the
// account already has of its own is left alone; a link of ours that points elsewhere is
// pointed back. Called when the account is added and before each run on it, so an entry the
// normal home gained since is shared too.
export function linkShared(vendor, id, env = process.env) {
  const dir = loginFolder(vendor, id), home = normalHome(vendor, env);
  if (within(path.resolve(home), path.resolve(dir)) || within(path.resolve(dir), path.resolve(home))) refuse('An account folder cannot hold the normal home, or sit inside it.');
  noSymlinks(dir);
  try { if (!fs.existsSync(path.join(home, SESSIONS[vendor]))) fs.mkdirSync(path.join(home, SESSIONS[vendor]), { recursive: true, mode: 0o700 }); } catch { /* A home that cannot be written to keeps its sessions per account. */ }
  for (const name of SHARED[vendor]) {
    const source = path.join(home, name), target = path.join(dir, name);
    if (!fs.existsSync(source)) continue;
    let held = null; try { held = fs.lstatSync(target); } catch { /* Not there yet. */ }
    if (held && !held.isSymbolicLink()) continue;
    if (held) { if (fs.readlinkSync(target) === source) continue; fs.unlinkSync(target); }
    try { fs.symlinkSync(source, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return dir;
}
// A new account's folder, before its sign-in: made, with the shared links laid, and not yet
// listed. finishLogin lists it once the vendor's sign-in wrote an account there; removeLogin
// takes it away when none did.
export function newLogin(vendor, env = process.env) {
  if (!isLoginVendor(vendor)) refuse('Accounts are added for Claude Code and Codex.');
  mkdir(vendorRoot(vendor));
  const listed = new Set(readState()[vendor].added.map(item => item.id));
  // A folder a sign-in left behind (ELU closed during it) is cleared on the way.
  for (const name of fs.readdirSync(vendorRoot(vendor))) {
    const old = path.join(vendorRoot(vendor), name);
    try { if (ID.test(name) && !listed.has(name) && Date.now() - fs.lstatSync(old).mtimeMs > 3600000) fs.rmSync(old, { recursive: true, force: true }); } catch { /* Another window's, or gone. */ }
  }
  for (let tries = 0; tries < 16; tries++) {
    const id = Array.from(crypto.randomBytes(8), byte => 'abcdefghijklmnopqrstuvwxyz0123456789'[byte % 36]).join('');
    if (id === DEFAULT_LOGIN || listed.has(id)) continue;
    try { fs.mkdirSync(path.join(vendorRoot(vendor), id), { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    fs.mkdirSync(loginFolder(vendor, id), { mode: 0o700 });
    linkShared(vendor, id, env);
    return { id, dir: loginFolder(vendor, id) };
  }
  refuse('No folder could be made for another account.');
}
export function finishLogin(vendor, id) {
  loginFolder(vendor, id);
  change(state => { if (!state[vendor].added.some(item => item.id === id)) state[vendor].added.push({ id, addedAt: new Date().toISOString() }); });
}
// Forgets an added account: ELU's folder for it goes, and with it that copy of the sign-in.
// Nothing is signed out, so no token is revoked. The links in the folder are removed as links;
// what they point to stays. A forgotten account in use hands over to the owner's own.
export function removeLogin(vendor, id) {
  const dir = path.dirname(loginFolder(vendor, id));
  change(state => { state[vendor].added = state[vendor].added.filter(item => item.id !== id); if (state[vendor].active === id) state[vendor].active = DEFAULT_LOGIN; });
  noSymlinks(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}
// The vendor's own command that signs a new account in, run in the terminal with the
// account's folder as its home. Never a sign-out.
export const SIGN_IN = Object.freeze({ claude: ['auth', 'login'], codex: ['login'] });
// The sign-in on a computer with no browser, where the vendor has a device code one: a link
// and a one-time code the owner enters on any computer. Claude Code has none (`claude auth
// login --help`), so it keeps its own sign-in, whose link the owner opens by hand.
export const DEVICE_SIGN_IN = Object.freeze({ codex: ['login', '--device-auth'] });
// Whether the vendor's sign-in can open a browser on this computer: not over SSH, and on Linux
// and other Unix systems only with a display.
export function hasBrowser(env = process.env, platform = process.platform) {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return false;
  if (platform === 'darwin' || platform === 'win32') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}
