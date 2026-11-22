import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { atomic, isObject, noSymlinks, readJson } from '../util.mjs';
import { peerFile } from './paths.mjs';

// The owner's computers, paired by his GitHub account with no step of his (lib/peer/my-computers.mjs).
// Each computer signed in to GitHub with gh keeps its public peer key in one secret gist of that
// account, described GIST, and reads the others' from it. A key in a gist of the account this
// computer is signed in as was written by someone who can write to that account: the owner, from
// another computer of his. Each computer reads the gist for itself; nothing about it goes over the
// peer link, so a teammate's computer can never claim to be his.
//
// Only gh talks to api.github.com: this never reads the token. Each gh call is a child process
// with a 10 s limit, a check runs at start and every 15 minutes (pairingTick in the daemon), and
// a failure keeps what the last good check found, for a day. Off under ELU_NO_GITHUB_PAIRING=1,
// and in a test or CI run unless it asks with ELU_GITHUB_PAIRING=1.
//
// <personal>/peer/github-pairing.json = { version: 1, state, at, login?, account?, keys: [<key>], okAt? }
// state: ok, off, nogh, signedout, noscope or error. keys: the other computers the account vouches for.
// The gist ELU up to 0.1.33 kept is the same one (GIST), so a computer from then is read too.
export const GIST = 'ELU Code computers';
export const EVERY_MS = 15 * 60000, CALL_MS = 10000, KEPT_MS = 24 * 3600000;
const HEX64 = /^[0-9a-f]{64}$/, FILE = /^([0-9a-f]{64})\.json$/, GIST_ID = /^[A-Za-z0-9]{1,64}$/, LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const OUT_MAX = 16 * 1024 * 1024, ERR_MAX = 64 * 1024;
const yes = value => typeof value === 'string' && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
const json = text => { try { return JSON.parse(text); } catch { return null; } };

// Why GitHub pairing does not run here, or null when it does.
export function pairingOff(env = process.env) {
  if (yes(env.ELU_NO_GITHUB_PAIRING)) return 'env';
  if ((yes(env.CI) || env.NODE_TEST_CONTEXT) && env.ELU_GITHUB_PAIRING !== '1') return 'test';
  return null;
}

// One gh call: { code, stdout, stderr }, missing when there is no gh, timeout when it took too long.
export function runGh(args, { env = process.env, input = null, timeoutMs = CALL_MS } = {}) {
  return new Promise(resolve => {
    let child, out = '', err = '', done = false, timer = null;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    try { child = spawn('gh', args, { env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { return finish({ code: null, missing: error.code === 'ENOENT', stdout: '', stderr: String(error.message) }); }
    timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* Gone. */ } finish({ code: null, timeout: true, stdout: out, stderr: err }); }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', data => { if (out.length < OUT_MAX) out += data; });
    child.stderr.on('data', data => { if (err.length < ERR_MAX) err += data; });
    child.on('error', error => finish({ code: null, missing: error.code === 'ENOENT', stdout: out, stderr: String(error.message) }));
    child.on('close', code => finish({ code, stdout: out, stderr: err }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

class Failed extends Error { constructor(state, text) { super(text); this.state = state; } }
function failed(result, what) {
  if (result.missing) return new Failed('nogh', 'gh is not installed');
  if (result.timeout) return new Failed('error', `${what} took over ${CALL_MS / 1000} s`);
  const text = String(result.stderr ?? '').trim().split('\n').at(-1)?.slice(0, 200) ?? '';
  if (result.code === 4 || /gh auth login|HTTP 401/.test(result.stderr ?? '')) return new Failed('signedout', 'gh is not signed in');
  return new Failed('error', `${what}: ${text || `gh exited ${result.code}`}`);
}
// gh api -i user: the account and, for an OAuth token, its scopes (null when gh does not say).
function readUser(stdout) {
  const split = stdout.search(/\r?\n\r?\n/), head = split < 0 ? '' : stdout.slice(0, split), body = json(split < 0 ? stdout : stdout.slice(split).trim());
  const scopes = /^x-oauth-scopes:[ \t]*(.*)$/im.exec(head)?.[1];
  if (!isObject(body) || !Number.isSafeInteger(body.id) || !LOGIN.test(body.login ?? '')) return null;
  return { id: body.id, login: body.login, scopes: scopes == null ? null : scopes.split(',').map(scope => scope.trim()).filter(Boolean) };
}
const gistOf = (gist, createdAt = gist.created_at) => ({ id: String(gist.id), createdAt: typeof createdAt === 'string' ? createdAt : '', files: isObject(gist.files) ? gist.files : {} });
// Every gist of the account described GIST, oldest first, with its files.
async function accountGists(gh) {
  const list = await gh(['api', '--paginate', 'gists', '--jq', `.[] | select(.description == ${JSON.stringify(GIST)}) | {id, created_at}`]);
  if (list.code !== 0) throw failed(list, 'listing gists');
  const out = [];
  for (const row of list.stdout.split('\n').map(json).filter(item => isObject(item) && GIST_ID.test(item.id ?? ''))) {
    const got = await gh(['api', `gists/${row.id}`]);
    if (got.code !== 0) throw failed(got, 'reading a gist');
    const gist = json(got.stdout);
    if (isObject(gist)) out.push(gistOf(gist, row.created_at));
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
// The keys the gists vouch for: each file <key>.json whose content says that same key.
export function vouched(gists) {
  const keys = new Set();
  for (const gist of gists) for (const [name, file] of Object.entries(gist.files)) {
    const key = FILE.exec(name)?.[1], value = key && isObject(file) && file.truncated !== true ? json(file.content) : null;
    if (key && isObject(value) && value.key === key) keys.add(key);
  }
  return keys;
}
// This computer's file is in the oldest gist, with its name as it is now. Only that one file is
// sent; the other computers' files are never touched. A new gist is secret.
async function writeOwn(gh, gists, me, name) {
  const own = `${me}.json`, content = `${JSON.stringify({ key: me, name, at: new Date().toISOString() })}\n`;
  if (!gists.length) {
    const made = await gh(['api', '-X', 'POST', 'gists', '--input', '-'], JSON.stringify({ description: GIST, public: false, files: { [own]: { content } } }));
    if (made.code !== 0) { const error = failed(made, 'making the gist'); if (/HTTP 40[34]/.test(made.stderr ?? '')) error.state = 'noscope'; throw error; }
    const gist = json(made.stdout);
    return isObject(gist) && GIST_ID.test(String(gist.id ?? '')) ? [gistOf(gist)] : [];
  }
  const oldest = gists[0], saved = json(oldest.files[own]?.content);
  if (isObject(saved) && saved.key === me && saved.name === name) return gists;
  const patched = await gh(['api', '-X', 'PATCH', `gists/${oldest.id}`, '--input', '-'], JSON.stringify({ files: { [own]: { content } } }));
  if (patched.code !== 0) throw failed(patched, 'writing the gist');
  const gist = json(patched.stdout);
  return isObject(gist) ? [gistOf(gist, oldest.createdAt), ...gists.slice(1)] : gists;
}

const file = () => peerFile('github-pairing.json');
export function pairingStatus() {
  try { noSymlinks(file()); if (!fs.existsSync(file())) return null; const value = readJson(file()); return isObject(value) && value.version === 1 ? value : null; } catch { return null; }
}
// Whether the GitHub account this computer is signed in as vouches for key: its last good check
// found it, within a day.
export function githubPaired(key, now = Date.now()) {
  if (!HEX64.test(key ?? '')) return false;
  const status = pairingStatus(), okAt = Date.parse(status?.okAt ?? '');
  return Boolean(status) && Number.isFinite(okAt) && now - okAt <= KEPT_MS && Array.isArray(status.keys) && status.keys.includes(key);
}
function save(value) { try { atomic(file(), { version: 1, ...value, at: new Date().toISOString() }); } catch { /* Read again next check. */ } }

// One check: read the account, find or make the gist, keep this computer's file in it, and keep
// the keys it vouches for. me: this computer's key; name: its box name. Returns what was saved.
export async function checkGithub({ me, name = '', env = process.env, run = runGh } = {}) {
  const off = pairingOff(env);
  if (off) return { state: 'off', why: off };
  if (!HEX64.test(me ?? '')) return { state: 'error', error: 'no peer identity' };
  const gh = (args, input = null) => run(args, { env, input, timeoutMs: CALL_MS });
  const before = pairingStatus();
  try {
    const got = await gh(['api', '-i', 'user']);
    if (got.code !== 0) throw failed(got, 'reading the account');
    const account = readUser(got.stdout);
    if (!account) throw new Failed('error', 'gh did not say which account is signed in');
    if (account.scopes && !account.scopes.includes('gist')) throw new Failed('noscope', 'the gh sign-in has no gist scope');
    const keys = vouched(await writeOwn(gh, await accountGists(gh), me, String(name ?? '').slice(0, 64))); keys.delete(me);
    const status = { state: 'ok', login: account.login, account: account.id, keys: [...keys].sort(), okAt: new Date().toISOString() };
    save(status);
    return status;
  } catch (error) {
    const state = error instanceof Failed ? error.state : 'error';
    // A failure keeps what the last good check of the same account found, until it is a day old.
    save({ state, ...(before?.okAt ? { login: before.login, account: before.account, keys: before.keys ?? [], okAt: before.okAt } : { keys: [] }) });
    return { state, error: error.message };
  }
}

// The daemon's side: a check at start and every EVERY_MS, never two at once.
export function githubPairing(ctx, { env = process.env, run = runGh, everyMs = EVERY_MS } = {}) {
  let lastAt = 0, running = null, said = null;
  const go = () => {
    if (running) return running;
    lastAt = Date.now();
    running = checkGithub({ me: ctx.me?.key, name: ctx.boxName?.() ?? '', env, run }).then(result => {
      const line = result.state === 'ok' || result.state === 'off' ? null : `github pairing: ${result.error ?? result.state}`;
      if (line && line !== said) ctx.log?.(line);
      said = line; return result;
    }, error => { ctx.log?.(`github pairing: ${error.message}`); return { state: 'error' }; }).finally(() => { running = null; });
    return running;
  };
  return { start: go, check: go, tick(now = Date.now()) { if (!running && now - lastAt >= everyMs) go(); } };
}
