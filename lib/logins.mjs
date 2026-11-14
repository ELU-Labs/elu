import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomic, findBin, mkdir, noSymlinks, personalDirectory, readJson, refuse, within } from './util.mjs';
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
// settings an organization sends its accounts). The owner's own MCP servers are shared too
// (shareServers): Codex keeps them in config.toml, a link; Claude Code keeps them in
// .claude.json, so ELU writes them into each account's own.
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
// Linked even before the normal home has it: Codex's config.toml, which holds the owner's MCP
// servers. Codex reads a link to a missing file as no settings, and writes through a link to
// the file it names, so a server the owner adds later, from either folder, is in both.
const LINKED_ALWAYS = Object.freeze({ claude: Object.freeze([]), codex: Object.freeze(['config.toml']) });

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
// Lays a link in the account's folder to each shared entry of the normal home, and writes the
// owner's MCP servers into it (shareServers). An entry the account already has of its own is
// left alone; a link of ours that points elsewhere is pointed back. Called when the account
// is added and before each run on it, so an entry the normal home gained since is shared too.
export function linkShared(vendor, id, env = process.env) {
  const dir = layLinks(vendor, id, env);
  shareServers(vendor, id, env);
  return dir;
}
function layLinks(vendor, id, env) {
  const dir = loginFolder(vendor, id), home = normalHome(vendor, env);
  if (within(path.resolve(home), path.resolve(dir)) || within(path.resolve(dir), path.resolve(home))) refuse('An account folder cannot hold the normal home, or sit inside it.');
  noSymlinks(dir);
  try { if (!fs.existsSync(path.join(home, SESSIONS[vendor]))) fs.mkdirSync(path.join(home, SESSIONS[vendor]), { recursive: true, mode: 0o700 }); } catch { /* A home that cannot be written to keeps its sessions per account. */ }
  for (const name of SHARED[vendor]) {
    const source = path.join(home, name), target = path.join(dir, name);
    if (!fs.existsSync(source) && !LINKED_ALWAYS[vendor].includes(name)) continue;
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
export function newLogin(vendor, env = process.env, { platform = process.platform } = {}) {
  if (!isLoginVendor(vendor)) refuse('Accounts are added for Claude Code and Codex.');
  mkdir(vendorRoot(vendor));
  const listed = new Set(readState()[vendor].added.map(item => item.id));
  // A folder a sign-in left behind (ELU closed during it) is cleared on the way, with the
  // Keychain items that sign-in made.
  for (const name of fs.readdirSync(vendorRoot(vendor))) {
    const old = path.join(vendorRoot(vendor), name);
    try { if (ID.test(name) && !listed.has(name) && Date.now() - fs.lstatSync(old).mtimeMs > 3600000) { if (vendor === 'claude') forgetKeychain(loginFolder(vendor, name), { platform }); fs.rmSync(old, { recursive: true, force: true }); } } catch { /* Another window's, or gone. */ }
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
  shareServers(vendor, id);
}
// Forgets an added account: ELU's folder for it goes, and with it that copy of the sign-in,
// and on macOS the Keychain items Claude Code keeps for that folder. Nothing is signed out, so
// no token is revoked. The links in the folder are removed as links; what they point to stays.
// A forgotten account in use hands over to the owner's own. keychainLeft: the first item a
// locked or refusing Keychain kept, for the owner to delete in Keychain Access, or null.
export function removeLogin(vendor, id, { platform = process.platform } = {}) {
  const dir = path.dirname(loginFolder(vendor, id));
  change(state => { state[vendor].added = state[vendor].added.filter(item => item.id !== id); if (state[vendor].active === id) state[vendor].active = DEFAULT_LOGIN; });
  noSymlinks(dir);
  const left = vendor === 'claude' ? forgetKeychain(loginFolder(vendor, id), { platform }) : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { keychainLeft: left[0] ?? null };
}

// Claude Code on macOS keeps a sign-in in the login Keychain, not in its folder (Claude Code
// 2.1.323, read from its code). Each is a generic password whose account is $USER (the login
// name without it; "claude-code-user" when that has other characters than letters, digits,
// . _ and -) and whose service is "Claude Code", then its OAuth suffix (none for its own
// sign-in; -custom-oauth, -staging-oauth or -local-oauth), then "-credentials" for the
// sign-in (nothing for an API key it saved), then, when CLAUDE_CONFIG_DIR is set, "-" and the
// first eight hex digits of the SHA-256 of that value as given, in NFC. Every run of an added
// account is given its folder as CLAUDE_CONFIG_DIR, so these names are that folder's alone:
// the owner's own sign-in (no CLAUDE_CONFIG_DIR, or his own) and every other account's differ.
const OAUTH_SUFFIXES = Object.freeze(['', '-custom-oauth', '-staging-oauth', '-local-oauth']);
export function keychainItems(dir) {
  const hash = crypto.createHash('sha256').update(String(dir).normalize('NFC')).digest('hex').slice(0, 8);
  return OAUTH_SUFFIXES.flatMap(suffix => [`Claude Code${suffix}-credentials-${hash}`, `Claude Code${suffix}-${hash}`]);
}
export function keychainAccount(env = process.env) {
  let name; try { name = env.USER || os.userInfo().username; } catch { name = ''; }
  return /^[a-zA-Z0-9._-]+$/.test(name ?? '') ? name : 'claude-code-user';
}
// Deletes those items with macOS's own security command, each until none is left (it deletes
// one a call; 44 is its "not found"). Nothing else is ever deleted. Returns the items a locked
// or refusing Keychain kept: after the first such answer nothing more is tried, so a Keychain
// that waits for its password holds up the forget once at most.
function forgetKeychain(dir, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'darwin') return [];
  const security = findBin('security', env) ?? '/usr/bin/security', account = keychainAccount(env), items = keychainItems(dir);
  for (const [at, service] of items.entries()) {
    for (let tries = 0; tries < 8; tries++) {
      const done = spawnSync(security, ['delete-generic-password', '-a', account, '-s', service], { env, stdio: 'ignore', timeout: 5000 });
      if (done.status === 44) break;
      if (done.status !== 0) return items.slice(at);
    }
  }
  return [];
}

// The owner's own MCP servers in every account he added: Claude Code reads its user-scope
// servers from the .claude.json of the folder it runs with, which also names the account, so
// that file is never linked. ELU writes the mcpServers of his own .claude.json into each
// account's, as they are, and nothing else of his file: no sign-in, no account, no setting.
// The OAuth tokens of a server live in the sign-in's store, so an account signs in to such a
// server once on its own. A server ELU did not put there (one added in the account's folder)
// stays, and his wins over one of the same name. The names ELU put there are kept beside the
// folder, in servers.json, so one he removes goes from every account too. Codex keeps its
// servers in config.toml, which every account links (LINKED_ALWAYS): nothing to write.
// waitMs: how long a lock of Claude Code's on the account's file is waited for; the open app
// looks every few seconds and does not wait. true when the account's file is as his now.
export function claudeJsonFile(env = process.env) {
  const named = env.CLAUDE_CONFIG_DIR, home = typeof env.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
  return path.join(typeof named === 'string' && named ? named : home, '.claude.json');
}
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// His servers, or null when his file cannot be read: an account is then left as it is.
function ownServers(env) {
  try { const value = readJson(claudeJsonFile(env)); return isObject(value) ? (isObject(value.mcpServers) ? value.mcpServers : {}) : null; } catch { return null; }
}
const sharedNamesFile = id => path.join(path.dirname(loginFolder('claude', id)), 'servers.json');
function sharedNames(id) {
  try { const names = readJson(sharedNamesFile(id))?.names; return Array.isArray(names) ? names.filter(name => typeof name === 'string') : []; } catch { return []; }
}
// Claude Code's own lock on a .claude.json: a folder beside it, made to take it, refreshed
// while held, and stale after 10 s. A save of Claude Code's reads the file again under it, so
// what ELU writes under it is kept.
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function underClaudeLock(file, waitMs, work) {
  const held = `${file}.lock`, until = Date.now() + waitMs;
  for (;;) {
    try { fs.mkdirSync(held); break; } catch (error) {
      if (error.code !== 'EEXIST') return false;
      let age = null; try { age = Date.now() - fs.statSync(held).mtimeMs; } catch { /* Let go meanwhile. */ }
      if (age !== null && age > 10000) { try { fs.rmdirSync(held); } catch { /* Taken again meanwhile. */ } }
      else if (Date.now() >= until) return false;
      else sleep(25);
    }
  }
  try { return work(); } finally { try { fs.rmdirSync(held); } catch { /* Gone already. */ } }
}
export function shareServers(vendor, id, env = process.env, { waitMs = 3000, own = ownServers(env) } = {}) {
  if (vendor !== 'claude') return true;
  // With no file of his there is nothing to give; one he cannot read is looked at again.
  if (!own) return !fs.existsSync(claudeJsonFile(env));
  // An account not signed in yet has no file: its sign-in makes it, and finishLogin shares then.
  const file = path.join(loginFolder('claude', id), '.claude.json');
  try { noSymlinks(file); if (!fs.lstatSync(file).isFile()) return false; } catch (error) { return error.code === 'ENOENT'; }
  return underClaudeLock(file, waitMs, () => {
    let account; try { account = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
    if (!isObject(account)) return false;
    const before = isObject(account.mcpServers) ? account.mcpServers : {}, given = sharedNames(id), names = Object.keys(own);
    const next = { ...Object.fromEntries(Object.entries(before).filter(([name]) => !given.includes(name) || Object.hasOwn(own, name))), ...own };
    const changed = JSON.stringify(next) !== JSON.stringify(before), listed = JSON.stringify([...given].sort()) !== JSON.stringify([...names].sort());
    if (!changed && !listed) return true;
    // The names are kept first with both lists, so a stop between the two writes loses none.
    atomic(sharedNamesFile(id), { names: [...new Set([...given, ...names])] });
    if (changed) atomic(file, `${JSON.stringify({ ...account, mcpServers: next }, null, 2)}\n`);
    atomic(sharedNamesFile(id), { names });
    return true;
  });
}
// Every account: its links laid again and his servers written, as before a run on it. The
// open app calls it every few seconds and after /mcp add and /mcp remove; it does nothing
// while neither his files nor the accounts changed since its last look.
let lastShared = null;
const stamp = file => { try { const stat = fs.lstatSync(file); return `${stat.mtimeMs}:${stat.size}`; } catch { return '-'; } };
function looked(env, added) {
  return JSON.stringify([personalDirectory(), stamp(claudeJsonFile(env)), stamp(path.join(normalHome('codex', env), 'config.toml')), ...added.map(([vendor, id]) => [vendor, id, stamp(path.join(loginFolder(vendor, id), vendor === 'claude' ? '.claude.json' : 'config.toml'))])]);
}
export function shareServersAll(env = process.env, { waitMs = 0 } = {}) {
  const added = LOGIN_VENDORS.flatMap(vendor => listLogins(vendor).filter(id => id !== DEFAULT_LOGIN).map(id => [vendor, id]));
  if (looked(env, added) === lastShared) return true;
  const own = ownServers(env);
  let all = true;
  for (const [vendor, id] of added) { try { layLinks(vendor, id, env); if (!shareServers(vendor, id, env, { waitMs, own })) all = false; } catch { all = false; } }
  // A look that could not write what it had to (an account's file held by Claude Code, or his
  // own unreadable) is taken again the next time.
  lastShared = all ? looked(env, added) : null;
  return all;
}
// The vendor's own command that signs a new account in, run in the terminal with the
// account's folder as its home. Never a sign-out.
export const SIGN_IN = Object.freeze({ claude: ['auth', 'login'], codex: ['login'] });
// The sign-in on a computer with no browser, where the vendor has a device code one: a link
// and a one-time code the owner enters on any computer. Claude Code has none (`claude auth
// login --help`): its own sign-in prints a link to open on a computer with a browser and
// waits for the code that page shows, pasted here.
export const DEVICE_SIGN_IN = Object.freeze({ codex: ['login', '--device-auth'] });
export { hasBrowser } from './vendors.mjs';
