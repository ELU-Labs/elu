import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomic, findBin, mkdir, noSymlinks, readJson, personalDirectory } from './util.mjs';
import { lock } from './state.mjs';
import { agentEnv, killGroup } from './process.mjs';
import { SIGN_IN_COMMAND, VENDORS } from './vendors.mjs';

export { personalDirectory };
const cacheFile = () => path.join(personalDirectory(), 'usage.json');
const timestamp = value => Number.isSafeInteger(value) && value > 0 && value < 8640000000000 ? value : null;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const label = (value, max = 40) => typeof value === 'string' && value.trim() && !/[\x00-\x1f\x7f]/.test(value) ? value.trim().slice(0, max) : null;
function window(value) {
  if (!value || typeof value !== 'object') return null;
  const usedPercent = Number.isFinite(value.usedPercent) && value.usedPercent >= 0 && value.usedPercent <= 100 ? value.usedPercent : null;
  const resetsAt = timestamp(value.resetsAt);
  return usedPercent === null && resetsAt === null ? null : { usedPercent, resetsAt };
}
function report(value, now) {
  if (!value || !Number.isFinite(Date.parse(value.observedAt)) || Date.parse(value.observedAt) > now + 60000) return null;
  const current = name => { const row = window(value[name]); return row?.resetsAt && row.resetsAt * 1000 <= now ? null : row; };
  return { observedAt: value.observedAt, fiveHour: current('fiveHour'), weekly: current('weekly') };
}
function readCache() {
  try { const file = cacheFile(); noSymlinks(file); return fs.existsSync(file) ? readJson(file) : {}; }
  catch { return {}; }
}
// Everything personal state may hold about usage: numeric windows and times. A patch goes
// through here before it is written, so nothing else can get in.
const normalize = (cache, now) => ({ version: 1, claude: report(cache.claude, now), codex: report(cache.codex, now), codexCheckedAt: iso(cache.codexCheckedAt), checkedAt: iso(cache.checkedAt) });
export function usageSnapshot(now = Date.now()) {
  const cache = readCache();
  return { claude: report(cache.claude, now), codex: report(cache.codex, now) };
}
function save(patch) {
  let release;
  try {
    release = lock({ state: personalDirectory() }, 'usage');
    atomic(cacheFile(), normalize({ ...readCache(), ...patch }, Date.now()));
  } catch { /* Optional usage must never block a task or write through an unsafe path. */ }
  finally { try { release?.(); } catch { /* Cache cleanup is optional. */ } }
}
export function claudeUsage(text) {
  const result = {};
  const add = (name, row, fraction = false) => {
    const parsed = window({ usedPercent: fraction ? (typeof row?.utilization === 'number' ? row.utilization * 100 : null) : row?.used_percentage, resetsAt: row?.resetsAt ?? row?.resets_at });
    if (parsed) result[name] = parsed;
  };
  for (const line of text.split('\n')) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'rate_limit_event') {
      const info = row.rate_limit_info;
      add('fiveHour', info?.unifiedWindows?.five_hour, true); add('weekly', info?.unifiedWindows?.seven_day, true);
      if (['five_hour', 'seven_day'].includes(info?.rateLimitType)) {
        const name = info.rateLimitType === 'five_hour' ? 'fiveHour' : 'weekly';
        if (!info.unifiedWindows?.[info.rateLimitType]) add(name, info, true);
      }
    }
    if (row.rate_limits) { add('fiveHour', row.rate_limits.five_hour); add('weekly', row.rate_limits.seven_day); }
  }
  return Object.keys(result).length ? result : null;
}
export function observeClaudeLog(file) {
  let offset = 0, partial = '', windows = {}, previous = '';
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
        if (parsed) windows = { ...windows, ...parsed };
      }
      const serialized = JSON.stringify(windows);
      if (Object.keys(windows).length && serialized !== previous) { previous = serialized; save({ claude: { ...windows, observedAt: new Date().toISOString() } }); }
    } catch { /* Incomplete output or an unavailable cache does not affect the run. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  const timer = setInterval(read, 500); timer.unref();
  return () => { clearInterval(timer); read(); };
}
export function codexUsage(result) {
  const limits = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  const rows = [limits?.primary, limits?.secondary]; const parsed = {};
  for (const row of rows) {
    const name = row?.windowDurationMins === 300 ? 'fiveHour' : row?.windowDurationMins === 10080 ? 'weekly' : null;
    const value = window(row); if (name && value) parsed[name] = value;
  }
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
// sign-in is never read: its account is named in ~/.claude.json. Codex's is decoded from
// the id token in its auth.json, and nothing below sends, writes or shows a token.
const homeOf = env => typeof env.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
const readText = file => { noSymlinks(file); return fs.readFileSync(file, 'utf8'); };
const parse = (readFile, file) => { try { return JSON.parse(readFile(file)); } catch { return null; } };
const codexHome = env => typeof env.CODEX_HOME === 'string' && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(homeOf(env), '.codex');
const title = value => value ? value[0].toUpperCase() + value.slice(1) : null;
// ~/.claude.json names the account Claude Code is signed in as.
export function claudeAccount({ env = process.env, readFile = readText } = {}) {
  const row = parse(readFile, path.join(homeOf(env), '.claude.json'))?.oauthAccount;
  const email = row && typeof row === 'object' ? label(row.emailAddress, 254) : null;
  if (!email) return null;
  return { email, org: label(row.organizationName, 80), plan: label(row.planDisplayName), tier: label(row.userRateLimitTier, 60), extraUsage: row.hasExtraUsageEnabled === true };
}
// The ChatGPT account from the id_token's payload: base64url JSON, read and not verified.
export function codexAccount({ env = process.env, readFile = readText } = {}) {
  const tokens = parse(readFile, path.join(codexHome(env), 'auth.json'))?.tokens;
  const parts = typeof tokens?.id_token === 'string' ? tokens.id_token.split('.') : [];
  if (parts.length < 2) return null;
  let payload; try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  const email = label(payload?.email, 254);
  return email ? { email, plan: title(label(payload['https://api.openai.com/auth']?.chatgpt_plan_type)) } : null;
}
// accounts.json: every account seen per vendor, with the usage last seen for it. An email,
// a plan name, two times and numeric windows; never a token or an account id.
const accountsFile = () => path.join(personalDirectory(), 'accounts.json');
function accountRow(row) {
  if (!row || typeof row !== 'object' || !VENDORS.includes(row.vendor)) return null;
  const account = label(row.account, 254), lastSeen = iso(row.lastSeen);
  if (!account || !lastSeen) return null;
  const usage = row.usage && typeof row.usage === 'object' ? { fiveHour: window(row.usage.fiveHour), weekly: window(row.usage.weekly), observedAt: iso(row.usage.observedAt) } : null;
  return { vendor: row.vendor, account, plan: label(row.plan), firstSeen: iso(row.firstSeen) ?? lastSeen, lastSeen, usage: usage?.fiveHour || usage?.weekly ? usage : null };
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
    const next = accountRow({ vendor, account, plan: plan ?? previous?.plan, firstSeen: previous?.firstSeen ?? at, lastSeen: at, usage: usage ? { fiveHour: usage.fiveHour, weekly: usage.weekly, observedAt: usage.observedAt ?? at } : previous?.usage });
    atomic(accountsFile(), { version: 1, rows: [...rows.filter(row => row !== previous), next] });
  } catch { /* An account list that cannot be written only hides past accounts. */ }
  finally { try { release?.(); } catch { /* Lock cleanup is optional. */ } }
}
// The Usage tab checks again when its last check is older than this.
export function usageStale({ now = Date.now(), maxAgeMs = 120000 } = {}) {
  const elapsed = now - Date.parse(readCache().checkedAt ?? '');
  return !(elapsed >= 0 && elapsed < maxAgeMs);
}
// The Usage tab's check: Codex through its app-server, then the account each CLI names now,
// recorded with the usage last seen. Claude's usage is never asked for: it is what Claude
// Code last reported in a session here (observeClaudeLog). null when the last check is
// fresh and the owner did not ask.
export async function refreshUsage({ force = false, env = process.env, readFile, signal, now = Date.now() } = {}) {
  if (!force && !usageStale({ now })) return null;
  await refreshCodexUsage({ signal, force });
  if (signal?.aborted) return null;
  const seen = usageSnapshot(), claude = claudeAccount({ env, readFile }), codex = codexAccount({ env, readFile });
  if (claude) recordAccount('claude', claude.email, claude.plan, seen.claude?.fiveHour || seen.claude?.weekly ? seen.claude : null);
  if (codex) recordAccount('codex', codex.email, codex.plan, seen.codex);
  const at = new Date().toISOString(); save({ checkedAt: at });
  return { at };
}
const SWITCH = { claude: 'claude, then /login', codex: 'codex login' };
// What the Usage tab shows per vendor: installed and signed in from detect rows, the
// account its CLI names now, this plan's usage, and the other accounts seen before.
// Claude's usage is null until a session on Claude Code has reported a window that is
// still current.
export function usageTab({ vendors = [], env = process.env, readFile, now = Date.now() } = {}) {
  const cache = normalize(readCache(), now), accounts = readAccounts();
  const current = { claude: claudeAccount({ env, readFile }), codex: codexAccount({ env, readFile }) };
  const claude = cache.claude?.fiveHour || cache.claude?.weekly ? cache.claude : null;
  return VENDORS.map(vendor => {
    const row = vendors.find(item => item?.vendor === vendor), account = current[vendor] ?? null;
    const installed = row ? row.available === true : findBin(vendor) !== null;
    const signedIn = installed && (row ? row.signedIn === true : Boolean(account));
    // A vendor still waiting for its one-time check was never run, not even to read its
    // sign-in (detect()): unknown, which is not signed out. The tab says what starts the check.
    const unchecked = installed && row?.conformant === false && row.version === null;
    const usage = vendor === 'claude' ? claude : vendor === 'codex' ? cache.codex : null;
    const others = accounts.filter(item => item.vendor === vendor && item.account !== account?.email).sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
    return { vendor, installed, signedIn, unchecked, active: signedIn && account ? { account: account.email, plan: account.plan, tier: account.tier ?? null } : null, usage: signedIn ? usage : null, others, signInHint: `Run: ${SIGN_IN_COMMAND[vendor]}`, switchHint: SWITCH[vendor] ? `Switch: ${SWITCH[vendor]}` : null };
  });
}
