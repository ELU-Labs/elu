import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomic, findBin, mkdir, noSymlinks, onDiskPath, readJson, personalDirectory } from './util.mjs';
import { lock } from './state.mjs';
import { agentEnv, killGroup } from './process.mjs';
import { CAPS, SIGNS_IN_IN_ELU, VENDORS, hasBrowser, signInCommand } from './vendors.mjs';
import { DEFAULT_LOGIN, LOGIN_VENDORS, activeLogin, listLogins, loginEnv, loginFolder, removeLogin } from './logins.mjs';
import { readSwitch, spentMark } from './claude-switch.mjs';

export { personalDirectory };
const cacheFile = () => path.join(personalDirectory(), 'usage.json');
const timestamp = value => Number.isSafeInteger(value) && value > 0 && value < 8640000000000 ? value : null;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const label = (value, max = 40) => typeof value === 'string' && value.trim() && !/[\x00-\x1f\x7f]/.test(value) ? value.trim().slice(0, max) : null;
// One limit as a vendor reported it: the share used and when it starts again. reached: the
// vendor refused a request for this limit, whatever share it last gave; it holds until the
// reset the refusal named, so one without a reset is not kept.
function window(value) {
  if (!value || typeof value !== 'object') return null;
  const usedPercent = Number.isFinite(value.usedPercent) && value.usedPercent >= 0 && value.usedPercent <= 100 ? value.usedPercent : null;
  const resetsAt = timestamp(value.resetsAt);
  return usedPercent === null && resetsAt === null ? null : { usedPercent, resetsAt, ...(value.reached === true && resetsAt !== null ? { reached: true } : {}) };
}
// The limits that belong to one model or model family, beside the account's own windows:
// [{ id, name, fiveHour, weekly }]. id is the vendor's own (Claude: the family of 7d_<family>,
// Codex: the limit's id), name what the vendor calls it when it says. A window that has reset
// (now given) is gone, and a row with none left is too.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
function modelRows(value, now = null) {
  const rows = new Map(), fresh = row => row?.resetsAt && now !== null && row.resetsAt * 1000 <= now ? null : row;
  for (const row of (Array.isArray(value) ? value : []).slice(0, 200)) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !MODEL_ID.test(row.id)) continue;
    const fiveHour = fresh(window(row.fiveHour)), weekly = fresh(window(row.weekly)), name = label(row.name);
    if (fiveHour || weekly) rows.set(row.id, { id: row.id, ...(name ? { name } : {}), ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) });
  }
  return [...rows.values()].slice(-20);
}
// Whether a reading says anything: a window of the account, or one of a model.
const hasReading = usage => Boolean(usage?.fiveHour || usage?.weekly || usage?.models?.length);
// A model's limit that a new reading does not name is kept from the one before until it resets:
// Claude names one only in the answers that touch it, and it runs for its whole week. One kept
// with no reset would never go, so it is not carried over. A reading that names only a model's
// limit says nothing of the account's two windows, which stay as kept while they run.
// before: the reading kept for the same account, never another's.
function keepModels(usage, before, now = Date.now()) {
  if (!usage) return usage;
  const running = row => row?.resetsAt && row.resetsAt * 1000 > now ? row : undefined;
  const older = modelRows(before?.models).map(row => ({ ...row, fiveHour: running(row.fiveHour), weekly: running(row.weekly) }));
  const models = modelRows([...older, ...(usage.models ?? [])], now), { models: _, ...rest } = usage;
  const windows = usage.fiveHour || usage.weekly ? {} : Object.fromEntries([['fiveHour', running(before?.fiveHour)], ['weekly', running(before?.weekly)]].filter(([, row]) => row));
  return { ...rest, ...windows, ...(models.length ? { models } : {}) };
}
// models false: Claude's reading in usage.json, which has the two windows only (keepClaudeUsage).
function report(value, now, { models: named = true } = {}) {
  if (!value || !Number.isFinite(Date.parse(value.observedAt)) || Date.parse(value.observedAt) > now + 60000) return null;
  const current = name => { const row = window(value[name]); return row?.resetsAt && row.resetsAt * 1000 <= now ? null : row; };
  const models = named ? modelRows(value.models, now) : [];
  return { observedAt: value.observedAt, fiveHour: current('fiveHour'), weekly: current('weekly'), ...(models.length ? { models } : {}) };
}
function readCache() {
  try { const file = cacheFile(); noSymlinks(file); return fs.existsSync(file) ? readJson(file) : {}; }
  catch { return {}; }
}
// The sign-in of a vendor still waiting for its one-time check, as the Usage tab last read it
// (lib/vendor-check.mjs): the program it asked, yes, no or not known, whether that release can
// run here at all, why the answer is not known, and when.
function signInRead(value) {
  if (!value || typeof value !== 'object' || typeof value.bin !== 'string' || !path.isAbsolute(value.bin) || /[\x00-\x1f]/.test(value.bin) || !iso(value.at)) return null;
  return { bin: value.bin, signedIn: typeof value.signedIn === 'boolean' ? value.signedIn : null, supported: value.supported !== false, reason: label(value.reason, 200), at: value.at };
}
const signIns = value => Object.fromEntries(VENDORS.filter(vendor => CAPS[vendor]?.conformance).map(vendor => [vendor, signInRead(value?.[vendor])]).filter(([, row]) => row));
// Everything personal state may hold about usage: numeric windows, times and those sign-in
// reads. A patch goes through here before it is written, so nothing else can get in.
const normalize = (cache, now) => ({ version: 1, claude: report(cache.claude, now, { models: false }), codex: report(cache.codex, now), codexCheckedAt: iso(cache.codexCheckedAt), checkedAt: iso(cache.checkedAt), signIns: signIns(cache.signIns) });
export const savedSignIn = vendor => signIns(readCache().signIns)[vendor] ?? null;
export function saveSignIn(vendor, value) {
  const row = signInRead({ ...value, at: value?.at ?? new Date().toISOString() });
  if (!row || !CAPS[vendor]?.conformance) return;
  // Read again under the lock save takes: another window may have saved another vendor's.
  save({ signIns: { ...signIns(readCache().signIns), [vendor]: row } });
}
export function usageSnapshot(now = Date.now()) {
  const cache = readCache();
  return { claude: report(cache.claude, now, { models: false }), codex: report(cache.codex, now) };
}
// patch: the fields to change, or what gives them from what is kept now.
function save(patch) {
  let release;
  try {
    release = lock({ state: personalDirectory() }, 'usage');
    const kept = readCache();
    atomic(cacheFile(), normalize({ ...kept, ...(typeof patch === 'function' ? patch(kept) : patch) }, Date.now()));
  } catch { /* Optional usage must never block a task or write through an unsafe path. */ }
  finally { try { release?.(); } catch { /* Cache cleanup is optional. */ } }
}
// What a Claude Code log says of the account's limits: its 5-hour and weekly windows, and a
// limit of one model's own week. Claude Code names that one as the limit an event is about
// (rateLimitType seven_day_<family>), with the share used when it gives one, the reset, and
// whether the request was refused for it (status rejected): { fiveHour, weekly, models }.
export function claudeUsage(text) {
  const result = {}, models = new Map();
  const share = (row, fraction) => fraction ? (typeof row?.utilization === 'number' ? row.utilization * 100 : null) : row?.used_percentage;
  const add = (name, row, fraction = false) => {
    const parsed = window({ usedPercent: share(row, fraction), resetsAt: row?.resetsAt ?? row?.resets_at });
    if (parsed) result[name] = parsed;
  };
  for (const line of text.split('\n')) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'rate_limit_event') {
      const info = row.rate_limit_info, type = String(info?.rateLimitType ?? ''), refused = info?.status === 'rejected';
      add('fiveHour', info?.unifiedWindows?.five_hour, true); add('weekly', info?.unifiedWindows?.seven_day, true);
      if (['five_hour', 'seven_day'].includes(type)) {
        const name = type === 'five_hour' ? 'fiveHour' : 'weekly';
        if (!info.unifiedWindows?.[type]) add(name, info, true);
        // Refused for this window: it is reached until the reset the refusal names.
        if (refused) { const reached = window({ usedPercent: result[name]?.usedPercent, resetsAt: result[name]?.resetsAt ?? info.resetsAt, reached: true }); if (reached) result[name] = reached; }
      }
      const family = /^seven_day_([a-z][a-z0-9]{0,30})$/.exec(type)?.[1];
      if (family) { const parsed = window({ usedPercent: share(info, true), resetsAt: info.resetsAt, reached: refused }); if (parsed) models.set(family, { id: family, weekly: parsed }); }
    }
    if (row.rate_limits) { add('fiveHour', row.rate_limits.five_hour); add('weekly', row.rate_limits.seven_day); }
  }
  if (models.size) result.models = [...models.values()];
  return Object.keys(result).length ? result : null;
}
// One Claude account's limits as last seen, kept with that account in accounts.json. The two
// windows of the owner's own sign-in also go to usage.json, as before. A model's limit never
// does: it is carried over from one reading to the next for up to a week, the owner's own
// sign-in can change to another account (claude /login), and usage.json does not say whose
// reading it has. A reading with neither window leaves the two in usage.json as they are.
export function keepClaudeUsage(login, value) {
  if (login === DEFAULT_LOGIN && (value?.fiveHour || value?.weekly)) save({ claude: value });
  const account = accountOf('claude', login); if (account) recordAccount('claude', account.email, account.plan, value);
}
// login: the account the run is on. relay: whether ELU's Claude relay (lib/claude-relay.mjs)
// took the run's requests, which keeps each account's windows itself then: a turn it moved to
// another account reports that account's, which are not the run's own account's.
export function observeClaudeLog(file, { login = DEFAULT_LOGIN, relay = () => false } = {}) {
  let offset = 0, partial = '', windows = {}, previous = '';
  const keep = value => { if (!relay()) keepClaudeUsage(login, value); };
  const read = () => {
    let fd;
    try {
      noSymlinks(file); if (!fs.existsSync(file)) return;
      fd = fs.openSync(file, 'r'); const size = Math.min(fs.fstatSync(fd).size, 16 * 1024 * 1024);
      while (offset < size) {
        const buffer = Buffer.alloc(Math.min(size - offset, 65536)); const count = fs.readSync(fd, buffer, 0, buffer.length, offset); if (!count) break;
        offset += count; partial += buffer.subarray(0, count).toString('utf8');
        const end = partial.lastIndexOf('\n'); if (end < 0) { if (partial.length > 1048576) partial = ''; continue; }
        const parsed = claudeUsage(partial.slice(0, end)); partial = partial.slice(end + 1);
        if (parsed) windows = keepModels({ ...windows, ...parsed }, windows);
      }
      const serialized = JSON.stringify(windows);
      if (Object.keys(windows).length && serialized !== previous) { previous = serialized; keep({ ...windows, observedAt: new Date().toISOString() }); }
    } catch { /* Incomplete output or an unavailable cache does not affect the run. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  const timer = setInterval(read, 500); timer.unref();
  return () => { clearInterval(timer); read(); };
}
// What Codex's app-server says of the account's limits (account/rateLimits/read): its own
// 5-hour and weekly windows, from the limit with the id codex, and every other limit the answer
// lists by id (rateLimitsByLimitId), each a model's own, with the name Codex gives it
// (limitName): { fiveHour, weekly, models }.
export function codexUsage(result) {
  const windowsOf = limits => {
    const found = {};
    for (const row of [limits?.primary, limits?.secondary]) {
      const name = row?.windowDurationMins === 300 ? 'fiveHour' : row?.windowDurationMins === 10080 ? 'weekly' : null;
      const value = window(row); if (name && value) found[name] = value;
    }
    return found;
  };
  const byId = result?.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object' ? result.rateLimitsByLimitId : {};
  const parsed = windowsOf(byId.codex ?? result?.rateLimits);
  const models = modelRows(Object.entries(byId).filter(([id]) => id !== 'codex').map(([id, limits]) => ({ id, name: limits?.limitName, ...windowsOf(limits) })));
  if (models.length) parsed.models = models;
  return Object.keys(parsed).length ? parsed : null;
}
export function codexUsageArgs() {
  // App-server has different flags from exec. No thread or turn is ever started.
  return ['app-server', '--listen', 'stdio://', ...['mcp_servers={}', 'features.hooks=false', 'features.apps=false', 'features.plugins=false', 'features.code_mode=false', 'features.multi_agent=false', 'analytics.enabled=false'].flatMap(value => ['-c', value])];
}
// The app-server is told which ELU asks: the version in package.json.
let packageVersion;
const version = () => packageVersion ??= readJson(fileURLToPath(new URL('../package.json', import.meta.url))).version;
export async function readCodexUsage({ bin = findBin('codex'), cwd, signal, timeoutMs = 10000, env = agentEnv(), onInitialized } = {}) {
  if (!bin || signal?.aborted) return null;
  const clientInfo = { name: 'elu_code', title: 'ELU', version: version() };
  const child = spawn(bin, codexUsageArgs(), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const closed = new Promise(resolve => { child.once('error', resolve); child.once('close', resolve); });
  let pending = '', total = 0, stop;
  child.stdin.on('error', () => {}); child.stderr.resume();
  const result = await new Promise(resolve => {
    let finished = false;
    const send = value => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n'); };
    const finish = value => { if (finished) return; finished = true; clearTimeout(timer); resolve(value); };
    stop = () => finish(null);
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
    child.once('error', stop); child.once('close', stop);
    child.stdout.on('data', chunk => {
      total += chunk.length; if (total > 1048576) { stop(); return; }
      pending += chunk.toString('utf8'); let newline;
      while ((newline = pending.indexOf('\n')) >= 0 && !finished) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        let row; try { row = JSON.parse(line); } catch { stop(); return; }
        if (row.id === 1) {
          if (row.error) { stop(); return; }
          onInitialized?.();
          send({ method: 'initialized', params: {} }); send({ id: 2, method: 'account/rateLimits/read', params: {} });
        } else if (row.id === 2) finish(row.error ? null : codexUsage(row.result));
        else if (row.id !== undefined && row.method) send({ id: row.id, error: { code: -32601, message: 'Client method not supported' } });
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo, capabilities: { experimentalApi: true } } });
  });
  signal?.removeEventListener('abort', stop); child.stdin.end(); killGroup(child.pid, 'SIGTERM');
  const cleanup = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 250);
  await closed; clearTimeout(cleanup); killGroup(child.pid, 'SIGKILL');
  return result;
}
// force: the owner asked for it now; the one-minute cache is skipped.
export async function refreshCodexUsage({ signal, force = false } = {}) {
  let release, scratch;
  try {
    if (signal?.aborted) return;
    release = lock({ state: personalDirectory() }, 'usage-refresh');
    const checkedAt = Date.parse(readCache().codexCheckedAt ?? ''), elapsed = Date.now() - checkedAt;
    if (!force && elapsed >= 0 && elapsed < 60000) return;
    mkdir(personalDirectory()); scratch = fs.mkdtempSync(path.join(personalDirectory(), 'usage-'));
    const result = await readCodexUsage({ cwd: scratch, signal });
    if (!signal?.aborted) save({ codex: result ? { ...result, observedAt: new Date().toISOString() } : null, codexCheckedAt: new Date().toISOString() });
  } catch { /* Missing, signed-out, or incompatible CLIs show not reported. */ }
  finally {
    try { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* An optional metadata check must not stop the view. */ }
    try { release?.(); } catch { /* Cache cleanup is optional. */ }
  }
}

// Accounts. Who each CLI is signed in as comes from the vendor's own files. Claude Code's
// sign-in is never read: its account is named in ~/.claude.json, or in the .claude.json of
// its folder. Codex's is decoded from the id token in its auth.json, and nothing below sends,
// writes or shows a token.
const homeOf = env => typeof env.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
// A vendor's home is where the owner keeps it, and is read as it is on disk; the file itself as a link is not read.
const readText = file => { const real = path.join(onDiskPath(path.dirname(file)), path.basename(file)); noSymlinks(real); return fs.readFileSync(real, 'utf8'); };
const parse = (readFile, file) => { try { return JSON.parse(readFile(file)); } catch { return null; } };
const codexHome = env => typeof env.CODEX_HOME === 'string' && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(homeOf(env), '.codex');
const title = value => value ? value[0].toUpperCase() + value.slice(1) : null;
// ~/.claude.json names the account Claude Code is signed in as; with CLAUDE_CONFIG_DIR set,
// Claude Code keeps that file in it, as it does in an added account's folder (dir).
const claudeFolder = env => typeof env.CLAUDE_CONFIG_DIR === 'string' && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : homeOf(env);
export function claudeAccount({ env = process.env, readFile = readText, dir = null } = {}) {
  const row = parse(readFile, path.join(dir ?? claudeFolder(env), '.claude.json'))?.oauthAccount;
  const email = row && typeof row === 'object' ? label(row.emailAddress, 254) : null;
  if (!email) return null;
  return { email, org: label(row.organizationName, 80), plan: label(row.planDisplayName), tier: label(row.userRateLimitTier, 60), extraUsage: row.hasExtraUsageEnabled === true };
}
// The ChatGPT account from the id_token's payload: base64url JSON, read and not verified.
export function codexAccount({ env = process.env, readFile = readText, dir = null } = {}) {
  const tokens = parse(readFile, path.join(dir ?? codexHome(env), 'auth.json'))?.tokens;
  const parts = typeof tokens?.id_token === 'string' ? tokens.id_token.split('.') : [];
  if (parts.length < 2) return null;
  let payload; try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  const email = label(payload?.email, 254);
  return email ? { email, plan: title(label(payload['https://api.openai.com/auth']?.chatgpt_plan_type)) } : null;
}
// Who one of the sign-ins here is signed in as (lib/logins.mjs): the owner's own from the
// vendor's normal files, an added one from its folder. null when it names no account.
export function accountOf(vendor, login = DEFAULT_LOGIN, { env = process.env, readFile } = {}) {
  if (!['claude', 'codex'].includes(vendor)) return null;
  let dir = null;
  if (login !== DEFAULT_LOGIN) { try { dir = loginFolder(vendor, login); } catch { return null; } }
  return vendor === 'claude' ? claudeAccount({ env, readFile, dir }) : codexAccount({ env, readFile, dir });
}
// accounts.json: every account seen per vendor, with the usage last seen for it. An email,
// a plan name, two times and numeric windows; never a token or an account id.
const accountsFile = () => path.join(personalDirectory(), 'accounts.json');
function accountRow(row) {
  if (!row || typeof row !== 'object' || !VENDORS.includes(row.vendor)) return null;
  const account = label(row.account, 254), lastSeen = iso(row.lastSeen);
  if (!account || !lastSeen) return null;
  const models = modelRows(row.usage?.models);
  const usage = row.usage && typeof row.usage === 'object' ? { fiveHour: window(row.usage.fiveHour), weekly: window(row.usage.weekly), ...(models.length ? { models } : {}), observedAt: iso(row.usage.observedAt) } : null;
  return { vendor: row.vendor, account, plan: label(row.plan), firstSeen: iso(row.firstSeen) ?? lastSeen, lastSeen, usage: hasReading(usage) ? usage : null };
}
export function readAccounts() {
  try {
    const file = accountsFile(); noSymlinks(file);
    const rows = fs.existsSync(file) ? readJson(file)?.rows : [];
    return (Array.isArray(rows) ? rows : []).map(accountRow).filter(Boolean).slice(0, 100);
  } catch { return []; }
}
export function recordAccount(vendor, account, plan, usage, now = Date.now()) {
  if (!VENDORS.includes(vendor) || !label(account, 254)) return;
  let release;
  try {
    release = lock({ state: personalDirectory() }, 'accounts');
    const at = new Date(now).toISOString(), rows = readAccounts(), previous = rows.find(row => row.vendor === vendor && row.account === account);
    // Claude's reading names a model's limit only when an answer touched it; Codex's is whole each time.
    const seen = usage && vendor === 'claude' ? keepModels(usage, previous?.usage, now) : usage;
    const next = accountRow({ vendor, account, plan: plan ?? previous?.plan, firstSeen: previous?.firstSeen ?? at, lastSeen: at, usage: seen ? { fiveHour: seen.fiveHour, weekly: seen.weekly, models: seen.models, observedAt: seen.observedAt ?? at } : previous?.usage });
    atomic(accountsFile(), { version: 1, rows: [...rows.filter(row => row !== previous), next] });
  } catch { /* An account list that cannot be written only hides past accounts. */ }
  finally { try { release?.(); } catch { /* Lock cleanup is optional. */ } }
}
// The Usage tab checks again when its last check is older than this.
export function usageStale({ now = Date.now(), maxAgeMs = 120000 } = {}) {
  const elapsed = now - Date.parse(readCache().checkedAt ?? '');
  return !(elapsed >= 0 && elapsed < maxAgeMs);
}
// When the accounts or the account in use last changed: the tab reads its rows again then.
export function accountsStamp() {
  return ['accounts.json', 'logins.json', 'claude-switch.json'].map(name => { try { const stat = fs.lstatSync(path.join(personalDirectory(), name)); return `${stat.mtimeMs}:${stat.size}`; } catch { return '-'; } }).join(',');
}
// The Usage tab's check: Codex through its app-server, once for each account signed in here,
// then the account each one names, recorded with the usage last seen. Claude's usage is never
// asked for: it is what Claude Code last reported in a session here (observeClaudeLog). null
// when the last check is fresh and the owner did not ask.
export async function refreshUsage({ force = false, env = process.env, readFile, signal, now = Date.now() } = {}) {
  if (!force && !usageStale({ now })) return null;
  await refreshCodexUsage({ signal, force });
  if (signal?.aborted) return null;
  const seen = usageSnapshot(), claude = claudeAccount({ env, readFile }), codex = codexAccount({ env, readFile });
  if (claude) recordAccount('claude', claude.email, claude.plan, hasReading(seen.claude) ? seen.claude : null);
  if (codex) recordAccount('codex', codex.email, codex.plan, seen.codex);
  for (const vendor of LOGIN_VENDORS) {
    for (const login of listLogins(vendor).filter(id => id !== DEFAULT_LOGIN)) {
      if (signal?.aborted) return null;
      const account = accountOf(vendor, login, { env, readFile });
      if (!account) continue;
      let usage = null;
      if (vendor === 'codex') {
        let scratch;
        try { mkdir(personalDirectory()); scratch = fs.mkdtempSync(path.join(personalDirectory(), 'usage-')); const read = await readCodexUsage({ cwd: scratch, signal, env: agentEnv(process.env, [], loginEnv('codex', login)) }); usage = read ? { ...read, observedAt: new Date().toISOString() } : null; }
        catch { usage = null; }
        finally { try { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* Optional. */ } }
      }
      recordAccount(vendor, account.email, account.plan, usage);
    }
  }
  const at = new Date().toISOString(); save({ checkedAt: at });
  return { at };
}
// Forgets an account ELU added: its folder, its Keychain items on macOS, and its row here.
// Never a sign-out. keychainLeft: an item a locked Keychain kept, for the owner to delete.
export function forgetAccount(vendor, login, { env = process.env, readFile, platform = process.platform } = {}) {
  if (login === DEFAULT_LOGIN) return null;
  const account = accountOf(vendor, login, { env, readFile });
  const { keychainLeft } = removeLogin(vendor, login, { platform });
  if (account && !listLogins(vendor).some(id => accountOf(vendor, id, { env, readFile })?.email === account.email)) forgetRow(vendor, account.email);
  return keychainLeft ? { ...account, keychainLeft } : account;
}
function forgetRow(vendor, account) {
  let release;
  try {
    release = lock({ state: personalDirectory() }, 'accounts');
    atomic(accountsFile(), { version: 1, rows: readAccounts().filter(row => !(row.vendor === vendor && row.account === account)) });
  } catch { /* The row stays as an account seen before. */ }
  finally { try { release?.(); } catch { /* Lock cleanup is optional. */ } }
}
// A window that has reset says nothing about now.
const current = (usage, now) => {
  if (!usage) return null;
  const keep = row => row?.resetsAt && row.resetsAt * 1000 <= now ? null : row ?? null;
  const fiveHour = keep(usage.fiveHour), weekly = keep(usage.weekly), models = modelRows(usage.models, now);
  return fiveHour || weekly || models.length ? { observedAt: usage.observedAt ?? null, fiveHour, weekly, ...(models.length ? { models } : {}) } : null;
};
// The keys of a vendor's accounts, on the line under them. Enter and x act on an account's own
// line; on this one Enter opens the vendor's details, so the line says where they work.
// It fits an 80-column terminal, so u, which moves a Claude account up the owner's order when
// there are two or more, is named in the key bar only.
export const ACCOUNT_KEYS = 'enter on an account uses it · x forgets it · a adds one';
// Antigravity CLI and Grok Build run under a HOME of ELU's own, so they are signed in from
// ELU: s on their line runs the vendor's own sign-in there (lib/terminal.mjs). Antigravity's
// sign-in for ELU is the one agy uses in the owner's terminal on macOS (shareKeychain), but
// it is read under ELU's HOME, so the line says for ELU. Claude Code and Codex use the owner's
// own sign-in, which he runs in his terminal: on a computer with no browser, the command with
// the vendor's device code sign-in where it has one (signInCommand).
const signedOutWords = (vendor, browser) => SIGNS_IN_IN_ELU.includes(vendor)
  ? { signInHint: 's signs in', signedOutText: 'not signed in for ELU · s signs in', signedOutDetail: 'Not signed in for ELU. s signs it in.', signsInHere: true }
  : { signInHint: `Run: ${signInCommand(vendor, browser)}`, signedOutText: `not signed in. Run: ${signInCommand(vendor, browser)}`, signedOutDetail: `Not signed in. Run: ${signInCommand(vendor, browser)}`, signsInHere: false };
// What the Usage tab shows per vendor: installed and signed in from detect rows, and for
// Claude Code and Codex every account signed in here (accounts), each with the usage its own
// runs reported and whether new runs use it, then the accounts seen before that are not
// signed in here (others). active and usage are the account in use.
export function usageTab({ vendors = [], env = process.env, readFile, now = Date.now(), browser = hasBrowser() } = {}) {
  const cache = normalize(readCache(), now), history = readAccounts();
  let switching = {}; try { switching = readSwitch(); } catch { switching = {}; }
  const seen = (vendor, email) => current(history.find(item => item.vendor === vendor && item.account === email)?.usage, now);
  return VENDORS.map(vendor => {
    const row = vendors.find(item => item?.vendor === vendor), several = LOGIN_VENDORS.includes(vendor);
    const inUse = several ? activeLogin(vendor) : DEFAULT_LOGIN, own = accountOf(vendor, DEFAULT_LOGIN, { env, readFile });
    const installed = row ? row.available === true : findBin(vendor) !== null;
    const live = vendor === 'claude' ? (hasReading(cache.claude) ? cache.claude : null) : vendor === 'codex' ? cache.codex : null;
    // The owner's own account, then each one added here, as its folder names it.
    const accounts = !several || !installed ? [] : listLogins(vendor).map(login => {
      const account = login === DEFAULT_LOGIN ? own : accountOf(vendor, login, { env, readFile }), kept = account ? seen(vendor, account.email) : null;
      // The owner's own sign-in: its reading in usage.json, and for Claude each model's limit
      // from the record of the account it names now, the only place one is kept (keepClaudeUsage).
      const usage = login === DEFAULT_LOGIN && live ? (vendor === 'claude' && kept?.models ? { ...live, models: kept.models } : live) : kept;
      // A Claude account at its limit says until when, and one whose sign-in lapsed says so (lib/claude-switch.mjs).
      const mark = vendor === 'claude' ? spentMark(switching, login, { now }) : null;
      // spent: the limit ELU holds the account at, whichever it is: a window of the account, or
      // one model's own week (model), which leaves the account in use for every other model.
      const held = vendor === 'claude' ? switching.spent?.[login] : null, spent = held && Date.parse(held.until) > now ? { window: held.window, until: Date.parse(held.until), ...(held.model ? { model: held.model } : {}) } : null;
      return { login, account: account?.email ?? null, plan: account?.plan ?? null, tier: account?.tier ?? null, active: login === inUse, usage, ...(mark && mark.window !== 'model' ? { spentUntil: Date.parse(mark.until) } : {}), ...(spent ? { spent } : {}), ...(vendor === 'claude' && switching.signIn?.[login] ? { needsSignIn: true } : {}) };
    }).filter(item => item.account || item.active);
    // In the owner's order, when he set one (u): the order the switching tries them in.
    if (vendor === 'claude' && switching.order?.length) { const rank = item => { const at = switching.order.indexOf(item.login); return at < 0 ? switching.order.length : at; }; accounts.sort((a, b) => rank(a) - rank(b)); }
    const using = accounts.find(item => item.active) ?? null;
    // A vendor still waiting for its one-time check is not run by detect(), not even for its
    // sign-in: the tab reads that itself and hands it in as beforeCheck, { signedIn: true |
    // false | null, supported, reason }, with checkState, where the vendor stands with its check
    // (withCheck in lib/vendor-check.mjs). null is not read yet, which is not signed out.
    const unchecked = installed && row?.conformant === false && row.version === null, before = unchecked ? row.beforeCheck ?? null : null;
    const check = installed && row?.checkState ? row.checkState : { check: null, notProven: null, more: 0 };
    // Signed in: the account in use is. detect() read it with the folder of that account.
    const signedIn = unchecked ? before?.signedIn === true : installed && (row ? row.signedIn === true : Boolean(several ? using?.account : own));
    const names = new Set(accounts.map(item => item.account).filter(Boolean));
    const others = history.filter(item => item.vendor === vendor && !names.has(item.account) && item.account !== own?.email).sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
    const active = signedIn && using?.account ? { account: using.account, plan: using.plan, tier: using.tier } : signedIn && !several && own ? { account: own.email, plan: own.plan, tier: own.tier ?? null } : null;
    // signInRead: what the sign-in read said, null when it said nothing yet.
    const signInRead = unchecked ? typeof before?.signedIn === 'boolean' ? before.signedIn : null : signedIn;
    // Two or more Claude accounts take over from each other: the two settings of that, and u.
    const switches = vendor === 'claude' && accounts.filter(item => item.account).length >= 2 ? { auto: switching.auto !== false, extraUsage: switching.extraUsage === true } : null;
    return { vendor, installed, bin: installed ? row?.bin ?? null : null, release: installed ? row?.release ?? null : null, signedIn, signInRead, signInReason: before?.reason ?? null, runsHere: before?.supported !== false, unchecked, ...check, accounts, active, usage: signedIn ? using ? using.usage : live : null, others, ...signedOutWords(vendor, browser), keysHint: several ? ACCOUNT_KEYS : null, ...(switches ? { switches } : {}) };
  });
}
