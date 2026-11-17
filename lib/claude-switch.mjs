import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, noSymlinks, personalDirectory, readJson } from './util.mjs';
import { waitLock } from './state.mjs';
import { DEFAULT_LOGIN, listLogins, loginFolder } from './logins.mjs';

// Claude accounts that take over from each other. With two or more Claude accounts signed in
// here (the owner's own and those he added in Usage), Claude work moves by itself to another
// one when the account in use reaches its five-hour or weekly limit (lib/claude-relay.mjs, and
// the runner's switch-and-resume when the relay could not help). What the switching keeps
// between turns and between ELU's processes is here, in claude-switch.json beside logins.json:
//   auto        false turns the switching off; absent is on.
//   extraUsage  true lets an account at its limit go on with paid extra usage; absent is off.
//   threshold   the share of a window at which an account counts as spent (0.98).
//   order       the owner's order of the accounts (u in Usage), by their ids.
//   spent       per account: which limit it reached, until when, and for which model when the
//               limit was one model's own.
//   signIn      per account: when its sign-in was found lapsed. It is left out until signed in.
//   picked      the account the owner last chose by hand in Usage, and when.
//   wake        when something changed that may let a session waiting for a reset go on now.
//   lastMove    the last move, by account ids, for the status line.
// Never an email, a token or a path. logins.json keeps its own shape, which an ELU before this
// rewrites with its known fields only, so nothing new goes there.
export const THRESHOLD = 0.98;
const ID = /^(?:default|[a-z0-9]{8})$/;
const WINDOWS = Object.freeze(['fiveHour', 'weekly', 'model', 'billing', 'signIn']);
const FAMILY = /^[a-z][a-z0-9-]{0,30}$/;
const file = () => path.join(personalDirectory(), 'claude-switch.json');
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null;
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function clean(value) {
  const row = isObject(value) ? value : {}, out = { version: 1 };
  if (typeof row.auto === 'boolean') out.auto = row.auto;
  if (typeof row.extraUsage === 'boolean') out.extraUsage = row.extraUsage;
  if (Number.isFinite(row.threshold) && row.threshold >= 0.5 && row.threshold <= 1) out.threshold = row.threshold;
  if (Array.isArray(row.order)) { const order = [...new Set(row.order.filter(id => ID.test(String(id))))].slice(0, 30); if (order.length) out.order = order; }
  const spent = isObject(row.spent) ? Object.fromEntries(Object.entries(row.spent).filter(([id, mark]) => ID.test(id) && isObject(mark) && WINDOWS.includes(mark.window) && iso(mark.until)).slice(0, 30).map(([id, mark]) => [id, { window: mark.window, until: iso(mark.until), ...(typeof mark.model === 'string' && FAMILY.test(mark.model) ? { model: mark.model } : {}) }])) : {};
  if (Object.keys(spent).length) out.spent = spent;
  const signIn = isObject(row.signIn) ? Object.fromEntries(Object.entries(row.signIn).filter(([id, at]) => ID.test(id) && iso(at)).slice(0, 30).map(([id, at]) => [id, iso(at)])) : {};
  if (Object.keys(signIn).length) out.signIn = signIn;
  if (isObject(row.picked) && ID.test(String(row.picked.id)) && iso(row.picked.at)) out.picked = { id: row.picked.id, at: iso(row.picked.at) };
  if (iso(row.wake)) out.wake = iso(row.wake);
  if (isObject(row.lastMove) && ID.test(String(row.lastMove.from)) && ID.test(String(row.lastMove.to)) && iso(row.lastMove.at) && WINDOWS.includes(row.lastMove.why)) out.lastMove = { at: iso(row.lastMove.at), from: row.lastMove.from, to: row.lastMove.to, why: row.lastMove.why, ...(typeof row.lastMove.model === 'string' && FAMILY.test(row.lastMove.model) ? { model: row.lastMove.model } : {}) };
  return out;
}
// Read again only when the file changed: the relay asks on every request.
let kept = null;
export function readSwitch() {
  let stamp = '-';
  try { const target = file(); noSymlinks(target); const stat = fs.statSync(target); stamp = `${target}:${stat.mtimeMs}:${stat.size}`; } catch { stamp = `${personalDirectory()}:-`; }
  if (kept?.stamp === stamp) return kept.value;
  let value = {}; try { if (!stamp.endsWith(':-')) value = readJson(file()); } catch { value = {}; }
  kept = { stamp, value: clean(value) };
  return kept.value;
}
// One change, under a lock that waits for another process's change to end. Returns the new value.
export function changeSwitch(edit) {
  const release = waitLock({ state: personalDirectory() }, 'claude-switch', 200);
  try {
    kept = null;
    const next = structuredClone(readSwitch()); edit(next);
    const value = clean(next); atomic(file(), value); kept = null;
    return value;
  } finally { try { release(); } catch { /* Lock cleanup is optional. */ } }
}
export const threshold = (state = readSwitch()) => state.threshold ?? THRESHOLD;

// The Claude accounts signed in here, as Usage lists them: the owner's own, then each one he
// added, each with the email and account id its .claude.json names. An account whose file names
// no one is not signed in, and is left out.
const homeOf = env => typeof env.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
export function accountFile(id, env = process.env) {
  if (id !== DEFAULT_LOGIN) return path.join(loginFolder('claude', id), '.claude.json');
  return path.join(typeof env.CLAUDE_CONFIG_DIR === 'string' && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : homeOf(env), '.claude.json');
}
const label = (value, max) => typeof value === 'string' && value.trim() && !/[\x00-\x1f\x7f]/.test(value) ? value.trim().slice(0, max) : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const people = new Map();
export function claudeAccountOf(id, env = process.env) {
  let target; try { target = accountFile(id, env); } catch { return null; }
  let stamp = '-'; try { const stat = fs.statSync(target); stamp = `${stat.mtimeMs}:${stat.size}`; } catch { return null; }
  const held = people.get(target);
  if (held?.stamp === stamp) return held.value;
  let row = null; try { row = JSON.parse(fs.readFileSync(target, 'utf8'))?.oauthAccount; } catch { row = null; }
  const email = isObject(row) ? label(row.emailAddress, 254) : null;
  const value = email ? { id, email, uuid: UUID.test(String(row.accountUuid)) ? String(row.accountUuid) : null, org: UUID.test(String(row.organizationUuid)) ? String(row.organizationUuid) : null, plan: label(row.planDisplayName, 40), extraUsage: row.hasExtraUsageEnabled === true } : null;
  if (people.size > 50) people.clear();
  people.set(target, { stamp, value });
  return value;
}
export function claudeAccounts(env = process.env) {
  return listLogins('claude').map(id => claudeAccountOf(id, env)).filter(Boolean);
}
// On by default once two or more Claude accounts are signed in here; auto false turns it off.
export function switchOn(env = process.env, state = readSwitch()) {
  return state.auto !== false && claudeAccounts(env).length >= 2;
}

// The family of a Claude model (fable, opus, sonnet, haiku), from its alias or its full id. A
// limit of one model's own week is named by it everywhere: in a mark here, in Anthropic's
// headers (7d_<family>), and in what Usage keeps with the account. The relay, which moves only
// that model's requests, and whoever asks whether a model has room (claudeModelFree in
// lib/claude-accounts.mjs) name families this one way.
export const familyOf = model => /\b(fable|opus|sonnet|haiku)\b/i.exec(String(model ?? '').replace(/-/g, ' '))?.[1]?.toLowerCase() ?? null;
// A mark is held until its time; one past it says nothing.
export function spentMark(state, id, { model = null, now = Date.now() } = {}) {
  const mark = state.spent?.[id];
  if (!mark || Date.parse(mark.until) <= now) return null;
  return mark.model && mark.model !== model ? null : mark;
}
export function markSpent(id, { window, until, model = null }) {
  if (!ID.test(String(id)) || !WINDOWS.includes(window) || !Number.isFinite(until)) return;
  changeSwitch(state => { const was = state.spent?.[id]; if (was && Date.parse(was.until) >= until && (was.model ?? null) === (model ?? null)) return; state.spent = { ...state.spent, [id]: { window, until: new Date(until).toISOString(), ...(model ? { model } : {}) } }; });
}
export function markSignIn(id, value = true) {
  changeSwitch(state => { const rest = { ...state.signIn }; if (value) rest[id] = new Date().toISOString(); else delete rest[id]; state.signIn = rest; });
}
// The owner chose this account in Usage: it is in use, whatever mark it had, and a session that
// waits for a reset is woken to try it.
export function notePicked(id) {
  changeSwitch(state => { const now = new Date().toISOString(); state.picked = { id, at: now }; state.wake = now; if (state.spent?.[id]) { const rest = { ...state.spent }; delete rest[id]; state.spent = rest; } if (state.signIn?.[id]) { const rest = { ...state.signIn }; delete rest[id]; state.signIn = rest; } });
}
export const wakeNow = () => changeSwitch(state => { state.wake = new Date().toISOString(); });
// An account marked to sign in again has a sign-in that works: it is back, and a session that
// waits for a reset is woken to try it.
export function signedInAgain(id) {
  changeSwitch(state => { if (!state.signIn?.[id]) return; const rest = { ...state.signIn }; delete rest[id]; state.signIn = rest; state.wake = new Date().toISOString(); });
}
// When a session waiting for a reset may go on before it: the latest change that could free an account.
export const wokenAt = (state = readSwitch()) => Math.max(Date.parse(state.wake ?? '') || 0, Date.parse(state.picked?.at ?? '') || 0);
export function noteMove({ from, to, why, model = null }) {
  changeSwitch(state => { state.lastMove = { at: new Date().toISOString(), from, to, why, ...(model ? { model } : {}) }; });
}
export const setAuto = on => changeSwitch(state => { state.auto = on === true; if (!on) state.wake = new Date().toISOString(); });
export const setExtraUsage = on => changeSwitch(state => { state.extraUsage = on === true; state.wake = new Date().toISOString(); });
// u: the account goes one place up the owner's order, which then names every account here.
export function moveUp(id, ids = listLogins('claude')) {
  return changeSwitch(state => {
    const order = [...(state.order ?? []).filter(item => ids.includes(item)), ...ids.filter(item => !(state.order ?? []).includes(item))];
    const at = order.indexOf(id);
    if (at > 0) [order[at - 1], order[at]] = [order[at], order[at - 1]];
    state.order = order;
  }).order;
}
// What a move says, by the limit the account left reached.
const WHY = { weekly: 'reached its weekly limit', fiveHour: 'reached its 5-hour limit', billing: 'could not be billed', signIn: 'needs to sign in again' };
export function whyText(why, model = null) {
  if (why === 'model') return `reached its weekly limit for ${model ? model[0].toUpperCase() + model.slice(1) : 'that model'}`;
  return WHY[why] ?? 'reached its limit';
}
// The chat line of a move, with the accounts as this computer names them. The row keeps the
// ids only (moveRow), so no email is kept with a session; without names it says the same plainly.
export function moveText(move, name = id => claudeAccountOf(id)?.email ?? null) {
  const to = name(move?.to), from = name(move?.from), why = whyText(move?.why, move?.model ?? null);
  if (to && from) return `Moved to ${to}: ${from} ${why}.`;
  if (to) return `Moved to ${to}: the account before it ${why}.`;
  return `Moved to another Claude account: the one before it ${why}.`;
}
export const MOVE_FALLBACK = 'Moved to another Claude account: the one before it reached its limit.';
export function moveRow({ from, to, why, model = null }, at = new Date().toISOString()) {
  return { at, text: MOVE_FALLBACK, from: 'ELU', line: true, sent: true, move: { vendor: 'claude', from, to, why, ...(model ? { model } : {}) } };
}
// The one line a session gets when every account is at its limit: which one resets first, and
// when. The session keeps it without the email (a session never keeps one); the chat names the
// account when it draws it (lib/stop-line.mjs). goesOn: the message waits in the queue to go on
// by itself then (lib/conductor.mjs); only then does the line say so. A teammate's message, a
// bot's scheduled turn or a standup's question is not kept to go on, and says only when.
const clock = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ');
export const dayClock = (ms, now = Date.now()) => new Date(ms).toDateString() === new Date(now).toDateString() ? clock(ms) : `${new Date(ms).toLocaleDateString('en-US', { weekday: 'short' })} ${clock(ms)}`;
export function waitLine(resetsAt, { email = null, now = Date.now(), goesOn = false } = {}) {
  const when = Number.isFinite(resetsAt) ? dayClock(resetsAt, now) : null;
  if (!when) return `Every Claude account is at its limit.${goesOn ? ' This session goes on when the first one resets.' : ''}`;
  return `Every Claude account is at its limit. ${email ?? 'The first'} resets at ${when}${goesOn ? '; this session goes on then' : ''}.`;
}
// Whether a session waits in the queue for a Claude account to reset (lib/conductor.mjs): its
// last turn stopped because every account was at its limit, and its message is queued to go
// on then. queue: its project's saved requests.
export function waitsForReset(task, queue = []) {
  return task?.error?.waitsFor === WAITS_FOR && Array.isArray(queue) && queue.some(row => row?.state === 'queued' && row.waitsFor === WAITS_FOR && String(row.continuationTaskId) === String(task.id));
}
// What the request of such a session says while it waits (lib/waiting.mjs adds when it tries again).
export const WAIT_REASON = 'Waiting for a Claude account to reset.';
export const WAITS_FOR = 'claude-limit';
