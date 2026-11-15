import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { findBin } from './util.mjs';
import { DEFAULT_LOGIN, activeLogin, useLogin } from './logins.mjs';
import { keepClaudeUsage } from './usage.mjs';
import { claudeAccountOf, claudeAccounts, markSpent, noteMove, readSwitch, spentMark, threshold } from './claude-switch.mjs';
import { firstFree, forgetAll, freshSignIn, limitOf, noteReading, pick, recheckSignIns, renew, signInFailed, signInsMarked, usable, whyLeft } from './claude-accounts.mjs';

// The Claude relay: a small server on this computer (127.0.0.1) that every Claude Code run ELU
// starts talks to instead of Anthropic, while two or more Claude accounts are signed in here.
// Claude Code sends all its requests to ANTHROPIC_BASE_URL, with its own sign-in; the relay
// sends each one on to Anthropic on the account the run should use, and reads every answer's
// rate limit headers (anthropic-ratelimit-unified-*). When the account reaches its five-hour or
// weekly limit, or Anthropic refuses it for one, the same request goes again on another account
// with room, and the run never sees the stop: the turn goes on. Read on Claude Code 2.1.325:
// - Any 429 that carries the unified headers ends its turn at once (usage_limit_reached), even
//   one for a per-minute slowdown. A 429 without them it tries again by itself, honouring
//   retry-after. So a slowdown is waited out here, and handed back without those headers.
// - A base URL may have a path: /elu/<launch token>/v1/messages reaches the relay, so the token
//   says which run is asking, and a request with no live token gets nothing.
// A run's requests go on its own account, with Claude Code's own sign-in passed on untouched,
// until that account is at its limit. Then they go to the account in use, or the next one with
// room (lib/claude-accounts.mjs pick), with that account's sign-in, read where Claude Code keeps
// it and held in memory only. The account in use (logins.json) moves with it, so new turns
// start there. Moving costs the prompt cache once.
const LIVE = 64, IDLE_MS = 5 * 60 * 1000, RAMP_MS = 30000, RAMP_STEP_MS = 250, INLINE_WAIT_MS = 15000, THROTTLE_WAIT_MS = 60000, BILLING_HOLD_MS = 5 * 60 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server = null, port = null, starting = null, idle = null, fresh = null;
const launches = new Map(), inFlight = new Map(), ramps = new Map(), written = new Map(), unsaved = new Map(), log = [];
// What the relay did, for a test: launch, account id, status, window and whether it moved.
// Never a header, a body or a sign-in.
const note = row => { log.push({ at: Date.now(), ...row }); if (log.length > 500) log.splice(0, log.length - 500); };
export const relayLog = () => log.map(row => ({ ...row }));
// Where requests go: Anthropic, or a stand-in API on this computer for a test.
function upstreamBase() {
  const named = process.env.ELU_TEST_ANTHROPIC_URL;
  if (named) { try { const url = new URL(named); if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol)) return url; } catch { /* Anthropic. */ } }
  return new URL('https://api.anthropic.com');
}
const agents = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) };
function ensureServer() {
  if (server && port) return Promise.resolve(port);
  starting ??= new Promise((resolve, reject) => {
    const made = http.createServer((req, res) => { handle(req, res).catch(() => { try { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json', 'x-should-retry': 'true' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'The ELU relay could not send this request.' } })); } else res.destroy(); } catch { /* Gone. */ } }); });
    made.on('clientError', (error, socket) => { try { socket.destroy(); } catch { /* Gone. */ } });
    made.once('error', error => { starting = null; reject(error); });
    made.listen(0, '127.0.0.1', () => {
      server = made; port = made.address().port; made.unref(); starting = null;
      // Every minute, a sign-in the relay holds that ends within five minutes is renewed.
      fresh = setInterval(() => { for (const { id } of claudeAccounts()) if (launches.size) freshSignIn(id, { bin: lastBin }).catch(() => {}); }, 60000); fresh.unref();
      resolve(port);
    });
  });
  return starting;
}
function closeWhenIdle() {
  clearTimeout(idle);
  if (launches.size) return;
  idle = setTimeout(() => { if (launches.size || !server) return; clearInterval(fresh); server.close(); server = null; port = null; }, IDLE_MS); idle.unref();
}
let lastBin = null;
// One Claude Code run: its environment points it at the relay, with a token of its own that
// ends when the run does. login: the account the run was started on. onMove({ from, to, why,
// model }): its requests moved to another account, said once each time.
export async function openLaunch({ login = DEFAULT_LOGIN, bin = findBin('claude'), onMove = null } = {}) {
  await ensureServer();
  if (bin) lastBin = bin;
  const token = crypto.randomBytes(32).toString('hex');
  const launch = { token, login, current: login, bin, onMove, moves: [], requests: 0 };
  launches.set(token, launch); clearTimeout(idle);
  // served: Claude Code sent its requests here. One that did not (its own settings name another
  // address) keeps reporting its account's use itself (lib/usage.mjs observeClaudeLog).
  // A run that ends leaves each account's last reading saved for Usage and ELU's other windows.
  return { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/elu/${token}` }, moves: launch.moves, current: () => launch.current, served: () => launch.requests > 0, close() { launches.delete(token); saveUsage(); closeWhenIdle(); } };
}
export const relayRunning = () => Boolean(server && port);

// The rate limit headers of one answer. Windows: five_hour (5h), seven_day (7d), and one model's
// own week (7d_<name>); utilization is a share (0..1), reset a time in seconds.
const H = 'anthropic-ratelimit-unified-';
function unifiedOf(headers) {
  const window = key => { const status = headers[`${H}${key}-status`], utilization = Number(headers[`${H}${key}-utilization`]), reset = Number(headers[`${H}${key}-reset`]); return status === undefined && !Number.isFinite(utilization) && !Number.isFinite(reset) ? null : { status: status ?? null, utilization: Number.isFinite(utilization) ? utilization : null, reset: Number.isFinite(reset) && reset > 0 ? reset : null }; };
  const models = Object.keys(headers).map(name => new RegExp(`^${H}(7d_[a-z0-9]+)-status$`).exec(name)?.[1]).filter(Boolean).map(key => ({ key, ...window(key) }));
  const any = Object.keys(headers).some(name => name.startsWith(H));
  return { any, status: headers[`${H}status`] ?? null, fiveHour: window('5h'), weekly: window('7d'), models, claim: headers[`${H}representative-claim`] ?? null, reset: Number(headers[`${H}reset`]) || null, overage: headers[`${H}overage-status`] ?? null };
}
// The family of the model a request asks for (fable, opus, sonnet, haiku), for a limit of one
// model's own: it moves only that model's requests.
const familyOf = model => /\b(fable|opus|sonnet|haiku)\b/i.exec(String(model ?? '').replace(/-/g, ' '))?.[1]?.toLowerCase() ?? null;
// The windows of an answer as Usage keeps them, saved at most every 30 seconds an account. One
// that comes sooner is saved when the 30 seconds are up, or when the run ends, whichever is
// first: the last reading of a turn is never lost.
let saveLater = null;
function keepUsage(id, unified, { now = Date.now(), force = false } = {}) {
  const row = value => value && value.utilization !== null ? { usedPercent: Math.min(100, Math.max(0, Math.round(value.utilization * 10000) / 100)), resetsAt: value.reset ? Math.round(value.reset) : null } : value?.reset ? { usedPercent: null, resetsAt: Math.round(value.reset) } : null;
  const windows = { ...(row(unified.fiveHour) ? { fiveHour: row(unified.fiveHour) } : {}), ...(row(unified.weekly) ? { weekly: row(unified.weekly) } : {}) };
  if (!Object.keys(windows).length) return;
  noteReading(id, windows);
  unsaved.set(id, { windows: { ...unsaved.get(id)?.windows, ...windows }, at: now });
  const since = now - (written.get(id) ?? 0);
  if (force || since >= 30000) return saveUsage(id);
  if (!saveLater) { saveLater = setTimeout(() => { saveLater = null; saveUsage(); }, 30000 - since); saveLater.unref(); }
}
// The readings not saved yet, of one account or of each.
function saveUsage(only = null) {
  for (const [id, { windows, at }] of [...unsaved]) {
    if (only && id !== only) continue;
    unsaved.delete(id); written.set(id, Date.now());
    try { keepClaudeUsage(id, { ...windows, observedAt: new Date(at).toISOString() }); } catch { /* Usage shows it next time. */ }
  }
}
// A refusal for the account's limit, not a slowdown: one of its windows (or the account as a
// whole) is rejected. Returns the mark it gets, or null for a slowdown.
function quotaOf(unified, model) {
  const rejected = [['fiveHour', unified.fiveHour], ['weekly', unified.weekly]].filter(([, row]) => row?.status === 'rejected');
  const ownModel = unified.models.filter(row => row.status === 'rejected');
  const until = (rows, fallback) => Math.max(...rows.map(row => (row.reset ?? 0) * 1000), fallback);
  const later = Date.now() + 60 * 60 * 1000;
  if (rejected.length) { const [window] = rejected.sort((a, b) => (b[1].reset ?? 0) - (a[1].reset ?? 0))[0]; return { window, until: until(rejected.map(([, row]) => row), unified.reset ? unified.reset * 1000 : later) }; }
  // Only a window that says rejected is a limit (as TeamClaude reads it): a refusal that rejects
  // the account as a whole while each of its windows allowed it is a slowdown.
  if (ownModel.length) return { window: 'model', model: familyOf(model) ?? 'opus', until: until(ownModel, unified.reset ? unified.reset * 1000 : later) };
  return null;
}
// An account at or over the threshold after an answer is spent until that window resets,
// unless the owner lets accounts go on with paid extra usage: then until Anthropic refuses it.
function overAfter(unified, state) {
  if (state.extraUsage === true) return null;
  const limit = threshold(state);
  const over = [['fiveHour', unified.fiveHour], ['weekly', unified.weekly]].filter(([, row]) => row?.utilization !== null && row?.utilization !== undefined && row.utilization >= limit && row.reset && row.reset * 1000 > Date.now());
  if (!over.length) return null;
  const [window, row] = over.sort((a, b) => b[1].reset - a[1].reset)[0];
  return { window, until: row.reset * 1000 };
}
// The answer a run gets when every account is at its limit and none is free within seconds:
// Anthropic's own refusal for the account's limit, naming when the first one resets, so Claude
// Code ends the turn with it and the runner waits for that time (lib/runner.mjs).
function allSpent(res, free) {
  const reset = Math.ceil((free?.at ?? Date.now() + 3600000) / 1000), weekly = !free || free.at - Date.now() > 5 * 60 * 60 * 1000, key = weekly ? '7d' : '5h';
  res.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false', [`${H}status`]: 'rejected', [`${H}${key}-status`]: 'rejected', [`${H}${key}-utilization`]: '1.0', [`${H}${key}-reset`]: String(reset), [`${H}representative-claim`]: weekly ? 'seven_day' : 'five_hour', [`${H}reset`]: String(reset), [`${H}overage-status`]: 'rejected' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Every Claude account signed in to ELU is at its limit.' } }));
}
// A slowdown handed back to Claude Code, which then tries again by itself: without the unified
// headers, which would end its turn.
function handBack(res, status, headers, body) {
  const kept = Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith(H) && !HOP.has(name) && name !== 'content-length' && name !== 'x-should-retry'));
  res.writeHead(status, { ...kept, 'x-should-retry': 'true', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
const readAll = stream => new Promise((resolve, reject) => { const parts = []; stream.on('data', part => parts.push(part)); stream.once('end', () => resolve(Buffer.concat(parts))); stream.once('error', reject); });
// Each account a run moves to takes requests slowly at first: one at a time, one more every
// quarter second, and as many as come after thirty seconds. A request never waits longer than
// that, and holds its place only until its answer's headers come.
async function ramp(id) {
  for (;;) {
    const since = ramps.get(id); if (!since) return;
    const age = Date.now() - since; if (age >= RAMP_MS) { ramps.delete(id); return; }
    if ((inFlight.get(id) ?? 0) < 1 + Math.floor(age / RAMP_STEP_MS)) return;
    await sleep(Math.min(50, RAMP_MS - age));
  }
}
// The request as it goes on another account than the run's own: that account's sign-in, and the
// account named in its metadata (a UUID, as long as the one it replaces).
function onAccount(body, id) {
  const uuid = claudeAccountOf(id)?.uuid;
  if (!uuid || !body.length) return body;
  let value; try { value = JSON.parse(body.toString('utf8')); } catch { return body; }
  const user = value?.metadata?.user_id;
  if (typeof user !== 'string') return body;
  let inner; try { inner = JSON.parse(user); } catch { return body; }
  if (!inner || typeof inner !== 'object' || typeof inner.account_uuid !== 'string') return body;
  value.metadata.user_id = JSON.stringify({ ...inner, account_uuid: uuid });
  return Buffer.from(JSON.stringify(value));
}
function send(base, rest, method, headers, body, id, abort) {
  return new Promise((resolve, reject) => {
    const url = new URL(rest, base), lib = url.protocol === 'https:' ? https : http;
    inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
    let released = false; const release = () => { if (!released) { released = true; inFlight.set(id, Math.max(0, (inFlight.get(id) ?? 1) - 1)); } };
    const out = lib.request(url, { method, headers: { ...headers, host: url.host, 'content-length': body.length, 'accept-encoding': 'identity' }, agent: agents[url.protocol] }, answer => { release(); resolve(answer); });
    out.once('error', error => { release(); reject(error); });
    abort.signal.addEventListener('abort', () => { release(); out.destroy(); }, { once: true });
    out.end(body);
  });
}
async function handle(req, res) {
  const found = /^\/elu\/([0-9a-f]{64})(\/.*)?$/.exec(req.url ?? ''), launch = found ? launches.get(found[1]) : null;
  const rest = found?.[2] ?? '';
  if (!launch || !rest.startsWith('/v1/')) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"not_found_error","message":"Not found."}}'); return; }
  launch.requests++;
  const body = await readAll(req), abort = new AbortController();
  res.once('close', () => { if (!res.writableFinished) abort.abort(); });
  let model = null; try { model = JSON.parse(body.toString('utf8'))?.model ?? null; } catch { model = null; }
  const family = familyOf(model), base = upstreamBase(), own = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP.has(name) && name !== 'content-length' && name !== 'accept-encoding'));
  let throttled = 0, bare = 0, waited = 0, tries = 0, rechecked = false, sent = null;
  const renewed = new Set(), skip = new Set();
  const pool = Math.max(1, claudeAccounts().length);
  // Whether this request may go to an account now. skip: one whose sign-in did not work for it.
  // The run's own account goes with Claude Code's own sign-in, which no mark speaks for.
  const fits = (account, state) => !skip.has(account) && usable(account, { model: family, state, signIn: account !== launch.login });
  // When every account is spent: the first that is free again, else when the run's own is.
  const free = () => firstFree({ model: family }) ?? (limitOf(launch.current, { model: family }) ? { id: launch.current, at: limitOf(launch.current, { model: family }) } : null);
  for (;;) {
    const state = readSwitch();
    let id = launch.current, move = null;
    // The run's account is at its limit: the account in use when it has room, else the next one.
    if (!fits(id, state)) {
      const inUse = activeLogin('claude'), left = skip.has(id) && !spentMark(state, id) ? { why: 'signIn', model: null } : whyLeft(id, { model: family, state });
      const next = inUse !== id && fits(inUse, state) ? inUse : pick({ exclude: [id, ...skip], model: family, state });
      if (!next) {
        // An account marked to sign in again is read again, once: one whose sign-in works now is back.
        if (!rechecked && signInsMarked(state)) { rechecked = true; if (await recheckSignIns({ bin: launch.bin ?? lastBin })) continue; }
        const first = free();
        // One that is free within seconds is waited for here; otherwise the run is told every
        // account is at its limit, and when the first one resets.
        if (first && first.at - Date.now() <= INLINE_WAIT_MS && waited < 2) { waited++; await sleep(Math.max(0, first.at - Date.now()) + 250); continue; }
        note({ launch: launch.token.slice(0, 8), account: id, status: 429, window: left.why, moved: false, spent: true });
        return allSpent(res, first);
      }
      move = { at: new Date().toISOString(), from: id, to: next, why: left.why, ...(left.model ? { model: left.model } : {}) };
      if (!ramps.has(next)) ramps.set(next, Date.now());
      id = next;
    }
    await ramp(id);
    if (abort.signal.aborted) return;
    // The run's own account: its own request, untouched. Another: that account's sign-in.
    let headers = own, payload = body;
    if (id !== launch.login) {
      const signedIn = await freshSignIn(id, { bin: launch.bin ?? lastBin });
      // None that works now: left out of this request (renew marks one that needs a sign-in).
      if (!signedIn) { skip.add(id); if (++tries > pool) return allSpent(res, free()); continue; }
      sent = signedIn.accessToken;
      headers = { ...Object.fromEntries(Object.entries(own).filter(([name]) => name !== 'x-api-key' && name !== 'authorization')), authorization: `Bearer ${signedIn.accessToken}` };
      if (!String(headers['anthropic-beta'] ?? '').includes('oauth-2025-04-20')) headers['anthropic-beta'] = [headers['anthropic-beta'], 'oauth-2025-04-20'].filter(Boolean).join(',');
      payload = onAccount(body, id);
    }
    // The move holds once the account it goes to has a sign-in for it. A limit of one model's own
    // leaves the account in use for every other model.
    if (move) {
      if (move.why !== 'model' && activeLogin('claude') !== move.to) {
        try { useLogin('claude', move.to); } catch { /* Another window was changing it: the next request moves it. */ }
        try { noteMove({ from: move.from, to: move.to, why: move.why, model: move.model ?? null }); } catch { /* The chat line says it. */ }
      }
      launch.current = move.to; launch.moves.push(move);
      try { launch.onMove?.(move); } catch { /* The move still happens. */ }
    }
    let answer;
    try { answer = await send(base, rest, req.method, headers, payload, id, abort); }
    catch {
      if (abort.signal.aborted) return;
      note({ launch: launch.token.slice(0, 8), account: id, status: 502, window: null, moved: id !== launch.login });
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json', 'x-should-retry': 'true' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'The ELU relay could not reach Anthropic.' } })); }
      return;
    }
    const unified = unifiedOf(answer.headers);
    if (unified.any) keepUsage(id, unified, { force: answer.statusCode === 429 });
    if (answer.statusCode === 429) {
      const said = await readAll(answer), quota = quotaOf(unified, model);
      if (quota) {
        // At its limit: it is held until that window resets, and the same request goes on the next account.
        try { markSpent(id, quota); } catch { /* The next request finds it again. */ }
        note({ launch: launch.token.slice(0, 8), account: id, status: 429, window: quota.window, moved: false });
        if (++tries > pool) return allSpent(res, free());
        continue;
      }
      // A slowdown: waited out on the same account when it says how long, and that is a minute
      // or less, three times; one that says nothing is tried once more after two seconds.
      const after = Number(answer.headers['retry-after']);
      if (Number.isFinite(after) && after >= 0 && after * 1000 <= THROTTLE_WAIT_MS && throttled < 3) { throttled++; note({ launch: launch.token.slice(0, 8), account: id, status: 429, window: 'throttle', moved: false }); await sleep(after * 1000); if (abort.signal.aborted) return; continue; }
      if (!unified.any && !Number.isFinite(after) && bare < 1) { bare++; await sleep(2000); if (abort.signal.aborted) return; continue; }
      note({ launch: launch.token.slice(0, 8), account: id, status: 429, window: 'throttle', moved: false, handedBack: true });
      return handBack(res, 429, answer.headers, said);
    }
    // A sign-in that no longer works, on an account whose sign-in the relay gave: renewed once by
    // Claude Code, then left out until it is signed in again. The run's own is Claude Code's.
    if (answer.statusCode === 401 && id !== launch.login) {
      await readAll(answer).catch(() => null);
      if (!renewed.has(id)) { renewed.add(id); await renew(id, { bin: launch.bin ?? lastBin }); continue; }
      signInFailed(id, sent); skip.add(id);
      if (++tries > pool) return allSpent(res, free());
      continue;
    }
    // Billing refused: the account rests five minutes, and the request goes on another.
    if (answer.statusCode === 402 || answer.statusCode === 400 && /billing|credit balance/i.test(String(answer.headers['x-error-type'] ?? ''))) {
      const said = await readAll(answer);
      if (answer.statusCode === 402 || /"type"\s*:\s*"billing_error"|credit balance is too low/i.test(said.toString('utf8'))) {
        try { markSpent(id, { window: 'billing', until: Date.now() + BILLING_HOLD_MS }); } catch { /* Found again. */ }
        if (++tries <= pool && pick({ exclude: [id], model: family })) continue;
      }
      return handBack(res, answer.statusCode, answer.headers, said);
    }
    // An answer: on to the run as it streams. An account now at its threshold is left for the next request.
    if (answer.statusCode < 300) { const over = overAfter(unified, readSwitch()); if (over) { try { markSpent(id, over); } catch { /* Found next time. */ } } }
    note({ launch: launch.token.slice(0, 8), account: id, status: answer.statusCode, window: null, moved: id !== launch.login });
    res.writeHead(answer.statusCode, Object.fromEntries(Object.entries(answer.headers).filter(([name]) => !HOP.has(name))));
    answer.pipe(res);
    answer.once('error', () => res.destroy());
    return;
  }
}
// For a test: the relay as it is now, and a way to stop it.
export function closeRelay() {
  for (const token of launches.keys()) launches.delete(token);
  clearTimeout(idle); clearInterval(fresh);
  if (server) server.close();
  clearTimeout(saveLater); saveLater = null;
  server = null; port = null; starting = null; ramps.clear(); inFlight.clear(); written.clear(); unsaved.clear(); log.length = 0; forgetAll();
  for (const agent of Object.values(agents)) agent.destroy();
}
export const LIVE_LAUNCHES = LIVE;
