import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { atomic, isObject, noSymlinks, readJson } from '../util.mjs';
import { peerFile } from './paths.mjs';
import { peerBox, peerSettings } from './settings.mjs';
import { teams } from './roster.mjs';
import { PAIRED_BY_GITHUB, autoMarkMine, autoUnmarkMine, mineRows, pairedByGithub } from './mine.mjs';

// Pairing by GitHub account (docs/peer-network.md, "Your other computers"). Two machines on a
// team together that are signed in to GitHub (with gh) as the same account mark each other as
// mine with no step. Each keeps its public peer key and box name in one secret gist of that
// account, described GIST; a key that account's gist holds is one the account vouches for.
// Only gh talks to api.github.com: this never reads the token. Nothing here blocks the daemon:
// each gh call is a child process with a 10 s limit, a check runs at most once a minute (at
// start, when a teammate is admitted, every 15 minutes), and a failure changes nothing.
export const GIST = 'ELU Code computers';
export const HINT = 'Sign in to GitHub with gh auth login on both computers to pair them by themselves, or type /mine @name on each.';
export const EVERY_MS = 15 * 60000, GAP_MS = 60000, CALL_MS = 10000;
const HEX64 = /^[0-9a-f]{64}$/, FILE = /^([0-9a-f]{64})\.json$/, GIST_ID = /^[A-Za-z0-9]{1,64}$/, LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const OUT_MAX = 16 * 1024 * 1024, ERR_MAX = 64 * 1024;
const yes = value => typeof value === 'string' && value !== '' && value !== '0' && value.toLowerCase() !== 'false';

// Why GitHub pairing does not run here, or null when it does: ELU_NO_GITHUB_PAIRING, /mine
// auto off (githubPairing false in peer/settings.json), or a test or CI run that did not ask
// for it with ELU_GITHUB_PAIRING=1.
export function pairingOff(env = process.env) {
  if (yes(env.ELU_NO_GITHUB_PAIRING)) return 'env';
  if (peerSettings().githubPairing === false) return 'setting';
  if ((yes(env.CI) || env.NODE_TEST_CONTEXT) && env.ELU_GITHUB_PAIRING !== '1') return 'test';
  return null;
}

// One gh call: {code, stdout, stderr}, missing when there is no gh, timeout when it took too long.
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

// What a failed call means for the owner: no gh, signed out, no gist scope, or anything else.
class Failed extends Error { constructor(state, text) { super(text); this.state = state; } }
function failed(result, what) {
  if (result.missing) return new Failed('nogh', 'gh is not installed');
  if (result.timeout) return new Failed('error', `${what} took over ${CALL_MS / 1000} s`);
  const text = String(result.stderr ?? '').trim().split('\n').at(-1)?.slice(0, 200) ?? '';
  if (result.code === 4 || /gh auth login|HTTP 401/.test(result.stderr ?? '')) return new Failed('signedout', 'gh is not signed in');
  return new Failed('error', `${what}: ${text || `gh exited ${result.code}`}`);
}
const json = text => { try { return JSON.parse(text); } catch { return null; } };

// gh api -i user: the account and, for an OAuth token, its scopes (null when gh does not say).
function readUser(stdout) {
  const split = stdout.search(/\r?\n\r?\n/), head = split < 0 ? '' : stdout.slice(0, split), body = json(split < 0 ? stdout : stdout.slice(split).trim());
  const scopes = /^x-oauth-scopes:[ \t]*(.*)$/im.exec(head)?.[1];
  if (!isObject(body) || !Number.isSafeInteger(body.id) || !LOGIN.test(body.login ?? '')) return null;
  return { id: body.id, login: body.login, scopes: scopes == null ? null : scopes.split(',').map(scope => scope.trim()).filter(Boolean) };
}

// What GitHub pairing last found, for /mine and elu mine: peer/github.json = {state, at, login?}.
// state is ok, off, nogh, signedout, noscope or error.
const statusFile = () => peerFile('github.json');
export function githubStatus() {
  try { const file = statusFile(); noSymlinks(file); if (!fs.existsSync(file)) return null; const value = readJson(file); return isObject(value) && typeof value.state === 'string' ? value : null; } catch { return null; }
}
function saveStatus(value) { try { atomic(statusFile(), { ...value, at: new Date().toISOString() }); } catch { /* Read again next check. */ } }
// The line /mine adds while GitHub pairing cannot work here, else null.
export function pairingHint(status = githubStatus()) { return ['nogh', 'signedout', 'noscope', 'error'].includes(status?.state) ? HINT : null; }

// Every gist of the account described GIST, oldest first, with its files. Several can exist
// when two machines made one at the same moment: all are read, and the oldest is written to.
async function accountGists(gh) {
  const list = await gh(['api', '--paginate', 'gists', '--jq', `.[] | select(.description == ${JSON.stringify(GIST)}) | {id, created_at}`]);
  if (list.code !== 0) throw failed(list, 'listing gists');
  const found = list.stdout.split('\n').map(json).filter(row => isObject(row) && GIST_ID.test(row.id ?? ''));
  const out = [];
  for (const row of found) {
    const got = await gh(['api', `gists/${row.id}`]);
    if (got.code !== 0) throw failed(got, 'reading a gist');
    const gist = json(got.stdout);
    if (isObject(gist)) out.push(gistOf(gist, row.created_at));
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
const gistOf = (gist, createdAt = gist.created_at) => ({ id: String(gist.id), createdAt: typeof createdAt === 'string' ? createdAt : '', files: isObject(gist.files) ? gist.files : {} });
// The keys the gists vouch for: each file <key>.json whose content says that same key.
function vouched(gists) {
  const keys = new Set();
  for (const gist of gists) for (const [name, file] of Object.entries(gist.files)) {
    const key = FILE.exec(name)?.[1], value = key && isObject(file) && file.truncated !== true ? json(file.content) : null;
    if (key && isObject(value) && value.key === key) keys.add(key);
  }
  return keys;
}
// This machine's file is in the oldest gist, with its name as it is now. Only that one file is
// sent; the other machines' files are never touched. A new gist is secret.
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

const teammates = me => [...new Set(teams().filter(state => state.members.some(m => m.key === me && !m.removed)).flatMap(state => state.members.filter(m => !m.removed && m.key !== me).map(m => m.key)))];
const tell = (ctx, key, mine) => { const session = ctx.session?.(key); if (session?.remoteHello?.remote === 1) session.notify('elu.mine', { mine }); };
const named = (ctx, key) => `@${String(ctx.box?.(key) || ctx.name?.(key) || key.slice(0, 8)).replace(/[\s@]+/g, '')}`;
// Each teammate the account vouches for is marked mine and told so; each GitHub mark whose key
// it no longer vouches for, or that another account made, goes and is told so.
export function reconcile(ctx, account, keys) {
  const me = ctx.me.key, marked = [], gone = [];
  for (const key of teammates(me)) if (keys.has(key) && autoMarkMine(me, key, { account: account.id, login: account.login })) { marked.push(key); tell(ctx, key, true); }
  for (const row of mineRows()) if (row.auto === 'github' && row.mine && (!keys.has(row.key) || row.account !== account.id) && autoUnmarkMine(row.key)) { gone.push(row.key); tell(ctx, row.key, false); }
  for (const key of marked) if (pairedByGithub(key)) ctx.event?.(PAIRED_BY_GITHUB(named(ctx, key), account.login));
  for (const key of gone) ctx.event?.(`${named(ctx, key)} is no longer yours: the two computers are not signed in to the same GitHub account any more.`);
  return { marked, gone };
}

// One check: read the account, find or make the gist, keep this machine's file in it, and mark
// the teammates it vouches for. Returns the state saved in peer/github.json.
export async function checkGithub(ctx, { env = process.env, run = runGh, name = peerBox() } = {}) {
  const off = pairingOff(env);
  // A test run that did not ask for it leaves no trace.
  if (off) { if (off !== 'test') saveStatus({ state: 'off', why: off }); return { state: 'off', why: off }; }
  const gh = (args, input = null) => run(args, { env, input, timeoutMs: CALL_MS });
  try {
    const got = await gh(['api', '-i', 'user']);
    if (got.code !== 0) throw failed(got, 'reading the account');
    const account = readUser(got.stdout);
    if (!account) throw new Failed('error', 'gh did not say which account is signed in');
    if (account.scopes && !account.scopes.includes('gist')) throw new Failed('noscope', 'the gh sign-in has no gist scope');
    const gists = await writeOwn(gh, await accountGists(gh), ctx.me.key, name);
    const keys = vouched(gists); keys.delete(ctx.me.key);
    const { marked, gone } = reconcile(ctx, account, keys);
    const status = { state: 'ok', login: account.login, account: account.id, gist: gists[0]?.id ?? null, vouched: keys.size };
    saveStatus(status);
    return { ...status, marked, gone };
  } catch (error) {
    const state = error instanceof Failed ? error.state : 'error';
    saveStatus({ state });
    return { state, error: error.message };
  }
}

// The daemon's side: checks at start, every 15 minutes, and soon after a teammate is admitted
// or the owner turns it on, never two at once and never more than once a minute.
export function githubPairing(ctx, { env = process.env, run = runGh, everyMs = EVERY_MS, gapMs = GAP_MS } = {}) {
  let lastAt = 0, running = null, timer = null, again = false, stopped = false, said = null;
  const go = () => {
    if (stopped) return null;
    if (running) { again = true; return running; }
    lastAt = Date.now();
    running = checkGithub(ctx, { env, run, name: ctx.boxName?.() ?? peerBox() }).then(result => {
      // A failure is logged when it changes, not on every check.
      const line = result.state === 'ok' ? null : `github pairing: ${result.state === 'off' ? `off (${result.why})` : result.error}`;
      if (line && line !== said) ctx.log?.(line);
      said = line; return result;
    }, error => { ctx.log?.(`github pairing: ${error.message}`); return { state: 'error' }; }).finally(() => { running = null; if (again) { again = false; soon(); } });
    return running;
  };
  function soon() {
    if (stopped || timer) return;
    if (running) { again = true; return; }
    timer = setTimeout(() => { timer = null; go(); }, Math.max(0, lastAt + gapMs - Date.now()));
    timer.unref?.();
  }
  return {
    start: go, soon, check: go,
    tick(now = Date.now()) { if (!running && !timer && now - lastAt >= everyMs) go(); },
    stop() { stopped = true; clearTimeout(timer); timer = null; },
    get running() { return running; },
  };
}
