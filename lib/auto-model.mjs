// Auto model: ELU picks the model for each step of a session. A plan goes to the top model of
// the session's vendor, an edit to its work model, and a simple lookup question to a fast one
// that only reads, beside the session. This file decides and says; it starts nothing. It holds
// the step of a message from the session's state (stepOf), the text half of the quick rule
// (quickText), each vendor's models by class (classNames), the route of a step (routeFor),
// which requests are the owner's own typed words (ownerWords), this computer's settings
// (auto-model.json in the personal folder) and every sentence the feature shows (LINES).
// No program is run here and nothing uses the network: what is installed, signed in and at a
// limit is read from what ELU and the vendors already keep on disk, so each answer is a
// forecast. A turn that meets a limit says so itself.
//
// With Auto model off for a session (autoOn false) nothing here is asked about it.
//
// This file imports lib/models.mjs and, through lib/conformance.mjs, most of the app. A file
// on that path that imports this one must use its exports inside functions only: a name read
// while the modules still load is not set yet. This file treats theirs the same way, and only
// lib/util.mjs and lib/vendors.mjs, which import nothing of the app, are read at the top.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, findBin, isObject, noSymlinks, onDiskPath, personalDirectory, readJson, refuse } from './util.mjs';
import { CAPS, EFFORTS, VENDORS, VENDOR_EFFORTS, VENDOR_NAMES } from './vendors.mjs';
import { changeSettings, waitLock } from './state.mjs';
import { saysYes } from './plan.mjs';
import { writtenByElu } from './elu-sent.mjs';
import { isPeerRun } from './modes.mjs';
import { installedEfforts } from './claude-catalog.mjs';
import { WAITS_FOR, dayClock, readSwitch } from './claude-switch.mjs';
import { claudeModelFree } from './claude-accounts.mjs';
import { accountOf, savedSignIn } from './usage.mjs';
import { DEFAULT_LOGIN, activeLogin, loginFolder } from './logins.mjs';
import { modeBlock } from './conformance.mjs';
import { grokHome, signInFile } from './adapters/grok.mjs';
import { keptModels } from './bot-models.mjs';
import { modelName, ownsPolicy, vendorShort } from './models.mjs';

// The name on screen, always in full: a bare "Auto" already names a permission badge, team
// access and Auto-continue. AUTO_WORD is what the owner types after /model; a model saved by
// that name is typed vendor:auto.
export const AUTO_NAME = 'Auto model';
export const AUTO_WORD = 'auto';
export const isAutoWord = word => typeof word === 'string' && word.trim().toLowerCase() === AUTO_WORD;
// On for a session: the mark on its record, absent when off (a setting of lib/state.mjs).
export const autoOn = task => task?.auto === true;

// ---- This computer's settings ----

// auto-model.json in the personal folder: { version: 1, effort, quick, default, hold }.
// effort: the one effort of plans and edits. quick: where quick questions go: null (by the
// order of quickVendor), a vendor, 'home' (the session's own vendor only) or 'off'.
// default: new sessions the owner starts on this computer begin with Auto model.
// hold: { vendor: until (ms) }, a fast vendor that failed and is passed over until then;
// holdSignIn: { vendor: stamp }, for one that failed on its sign-in, which is passed over only
// while that sign-in is the one it failed with (signInStamp).
// Nothing about Auto model is kept in the project's config or in a session's saved policy.
export const AUTO_EFFORT = 'xhigh';
export const QUICK_WORDS = Object.freeze(['home', 'off']);
const HOLD_MS = 15 * 60000, LIMIT_HOLD_MS = 60 * 60000, AUTH_HOLD_MS = 24 * 60 * 60000, SAID_MS = 24 * 60 * 60000;
// The personal folder an environment names: this process's own for the app, so a caller that
// passes another environment (a test) never reads or writes the owner's.
const homeOf = env => typeof env?.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
const personalOf = env => env === process.env ? personalDirectory() : path.join(onDiskPath(typeof env?.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : path.join(homeOf(env), '.config')), 'elu-code');
export const autoSettingsFile = (env = process.env) => path.join(personalOf(env), 'auto-model.json');
// Vendors that have a fast route at all (fastOf): what quick may name beside home and off.
const quickWord = value => QUICK_WORDS.includes(value) || (VENDORS.includes(value) && value !== 'agy');
// The file is the owner's to edit, so nothing in it is taken as it is; a hold past its time says nothing.
function clean(value, now) {
  const row = isObject(value) ? value : {};
  const hold = Object.fromEntries(Object.entries(isObject(row.hold) ? row.hold : {}).filter(([vendor, until]) => VENDORS.includes(vendor) && Number.isFinite(until) && until > now));
  const signIn = Object.fromEntries(Object.entries(isObject(row.holdSignIn) ? row.holdSignIn : {}).filter(([vendor, stamp]) => Object.hasOwn(hold, vendor) && typeof stamp === 'string' && stamp.length <= 400));
  return { effort: EFFORTS.includes(row.effort) ? row.effort : AUTO_EFFORT, quick: quickWord(row.quick) ? row.quick : null, default: row.default === true, hold, ...(Object.keys(signIn).length ? { holdSignIn: signIn } : {}) };
}
// { effort, quick, default, hold }. Never throws: a file that is missing or cannot be read gives the defaults.
export function autoSettings({ env = process.env, now = Date.now() } = {}) {
  try { const file = autoSettingsFile(env); noSymlinks(file); return clean(fs.existsSync(file) ? readJson(file) : null, now); }
  catch { return clean(null, now); }
}
// Merges a change into the settings and writes them, under a lock that waits for another
// process's change. change: the values to set, or a function given the settings as they read
// under the lock that returns them. An effort or a quick target that is none is refused with
// the sentence that names the ones there are. Returns the settings as saved.
export function saveAutoSettings(change, { env = process.env, now = Date.now() } = {}) {
  const release = waitLock({ state: personalOf(env) }, 'auto-model', 200);
  try {
    const was = autoSettings({ env, now }), given = typeof change === 'function' ? change(was) : change, patch = isObject(given) ? given : {};
    if (Object.hasOwn(patch, 'effort') && !EFFORTS.includes(patch.effort)) refuse(LINES.effortUse);
    if (Object.hasOwn(patch, 'quick') && patch.quick !== null && !quickWord(patch.quick)) refuse(patch.quick === 'agy' ? LINES.quickNone('agy') : LINES.quickUse);
    const next = clean({ ...was, ...patch }, now);
    atomic(autoSettingsFile(env), { version: 1, ...next });
    return next;
  } finally { try { release(); } catch { /* Lock cleanup is optional. */ } }
}
// Turns Auto model on or off for a session, whether or not a turn holds it (changeSettings).
// On is refused, with the sentences a change of model is refused with, for a session that
// cannot change model, and with homeProblem's when the caller names the session's vendor and
// it has no top and work model. Off also takes away the effort Auto model ran with; the
// owner's own effort (leadEffort) was never touched. Returns the session as it reads after.
export function setSessionAuto(repo, id, on, { vendor = null, env = process.env, codexModels = null } = {}) {
  return changeSettings(repo, id, task => {
    // Off also forgets which conversation each model had: turns with it off go on in the
    // session's one conversation, so what was kept here is stale when it is turned on again.
    if (!on) { delete task.auto; delete task.autoEffort; delete task.autoSessions; return; }
    if (isPeerRun(task.origin)) refuse(LINES.keepsTeammate);
    if (!ownsPolicy(task)) refuse(LINES.keepsCommit);
    const problem = vendor ? homeProblem(vendor, { env, codexModels }) : null; if (problem) refuse(problem);
    task.auto = true;
  });
}

// ---- Whose words a request is ----

// Whether a request is the owner's own words, typed in this session on this computer now.
// Only such a request picks a step; any other turn runs on the model the session ran last.
// Not his words: a turn ELU starts by itself (keep going, a job that ended, carry on, a
// helper's turn, the continuation after a mode was raised: writtenByElu), a retry and the
// restart after a limit, a schedule, a bot's turn, a Standup, a teammate's message or its
// answer, a message from his other computer, a copy, a helper session, a text ELU wrote that
// went through a typed path (byElu), and the retry key (retried): the turn it starts again
// runs on the model the failed one ran on.
// His approval of a Task (the y key, or the mode he set approving it) counts: the edit it
// starts is the step he chose, though ELU wrote the text. So does a new goal he types in
// the Done check on this computer: the work it reopens is a step like any other.
export const ownerWords = row => isObject(row) && row.typed === true
  && !row.origin && !row.scheduled && !row.scheduleId && !row.botChat && row.bot == null
  && !row.standup && !row.standupFor && !row.readOnly
  && typeof row.computer !== 'string' && !row.adds
  && !(row.attempts > 0) && row.waitsFor !== WAITS_FOR
  && !row.copied && !row.helps
  && row.byElu !== true && row.retried !== true && !writtenByElu(row.goal);

// ---- The step of a message ----

// The words of a short plain message, or [] for one with a question mark or anything but
// plain letters: the same reading as the plain yes of lib/plan.mjs.
function plainWords(text) {
  const typed = String(text ?? '').trim();
  if (!typed || typed.includes('?') || !/^[\x20-\x7e’]*$/.test(typed)) return [];
  return typed.toLowerCase().replace(/[’']/g, '').replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
}
// An acknowledgement: a plain yes (lib/plan.mjs), or thanks, thank you, ty, nice, great, cool,
// got it, ok, okay, alone or together. It asks for nothing, so with nothing waiting it picks
// no step. While a Task waits a plain yes is the approval it always was (stepOf).
const ACK = new Set(['thanks', 'thank', 'ty', 'nice', 'great', 'cool', 'got', 'ok', 'okay']), WITH_ACK = new Set(['you', 'it']);
export function isAck(text) {
  if (typeof text !== 'string') return false;
  if (saysYes(text)) return true;
  const words = plainWords(text);
  return words.length > 0 && words.length <= 6 && words.some(word => ACK.has(word)) && words.every(word => ACK.has(word) || WITH_ACK.has(word));
}
// The word that sends the question of the quick answer just given to the top model, typed alone.
export const isThink = text => typeof text === 'string' && text.trim().toLowerCase() === 'think';

// The text half of the quick rule. A message is a quick question only when it is plain
// English letters in one paragraph of at most 120 characters, starts with one of the openers,
// does not speak to the model, has none of the words that ask for a judgment or for work, and
// none that points into the conversation or at the state of the work. Whole words
// only: "explain" is not "plan". Each word is listed with its other forms (fails, failed,
// failure), since the same question is asked with any of them. When in doubt the message is
// not quick: a wrong guess that way costs money, never quality.
const OPENERS = Object.freeze(['what is', "what's", 'what are', 'what does', 'where is', 'where are', 'which file', 'which command', 'how do i', 'how to']);
const SPOKEN = new Set(['you', 'your', 'yours', 'yourself', 'please']);
const DEPTH = new Set(['why',
  'cause', 'causes', 'caused', 'causing', 'because',
  'wrong', 'wrongly',
  'fail', 'fails', 'failed', 'failing', 'failure', 'failures',
  'broken', 'break', 'breaks', 'broke', 'breaking',
  'error', 'errors',
  'bug', 'bugs', 'buggy',
  'safe', 'safer', 'safest', 'safely', 'safety', 'unsafe',
  'secure', 'secured', 'securely', 'security', 'insecure',
  'race', 'races', 'racing', 'racy',
  'deadlock', 'deadlocks', 'deadlocked',
  'leak', 'leaks', 'leaked', 'leaking', 'leaky',
  'correct', 'correctly', 'correctness', 'incorrect', 'incorrectly',
  'right', 'better', 'best', 'worse', 'worst',
  'risk', 'risks', 'risky', 'riskier',
  'should', 'shouldn',
  'compare', 'compares', 'compared', 'comparing', 'comparison',
  'design', 'designs', 'designed', 'designing',
  'plan', 'plans', 'planned', 'planning',
  'review', 'reviews', 'reviewed', 'reviewing',
  'think', 'thinks', 'thinking', 'thought',
  // Asking how to mend something is asking what is wrong with it.
  'fix', 'fixes', 'fixed', 'fixing', 'debug', 'debugs', 'debugging', 'solve', 'solves', 'solving', 'repair', 'repairs', 'resolve', 'resolves', 'diagnose',
  'slow', 'slower', 'slowly', 'hang', 'hangs', 'hanging', 'stuck', 'crash', 'crashes', 'crashed', 'crashing', 'flaky',
  // The same questions in other words: what is behind something, and what follows from it.
  'reason', 'reasons', 'problem', 'problems', 'issue', 'issues', 'regression', 'regressions', 'coming',
  'happen', 'happens', 'happened', 'happening', 'going', 'mean', 'means', 'meant', 'meaning',
  'impact', 'consequence', 'consequences', 'implication', 'implications', 'outcome', 'outcomes',
  'tradeoff', 'tradeoffs', 'trade', 'downside', 'downsides', 'upside', 'upsides', 'pros', 'cons', 'edge',
  'difference', 'differences', 'different', 'differ', 'versus', 'vs', 'instead', 'alternative', 'alternatives',
  'approach', 'approaches', 'cleanest', 'simplest', 'easiest', 'ideal', 'recommend', 'recommended', 'good', 'bad', 'worth', 'enough',
  'priority', 'priorities', 'important', 'blocking', 'blocked', 'blocker', 'blockers', 'missing', 'covered', 'concern', 'concerns',
  'faster', 'fastest', 'performance', 'improve', 'improves', 'improvement', 'improvements', 'optimize', 'optimal', 'scale', 'scales',
  // Asking how to do a piece of work is asking for the work.
  'roll', 'rollback', 'revert', 'undo', 'migrate', 'refactor', 'handle', 'avoid', 'prevent', 'reproduce', 'verify',
  'configurable', 'downtime', 'concurrent', 'concurrency', 'grow', 'grows', 'growing', 'growth']);
// A word that points into the conversation or at the state of the work: only the session's
// own model knows what it points at. that points only where it ends the question or follows
// the opener ("what is that"); in "the file that sets the port" it joins two parts.
const POINTS = new Set(['this', 'these', 'those', 'it', 'here', 'we', 'us', 'our', 'now', 'left', 'remaining', 'next', 'status', 'progress', 'done', 'step', 'steps', 'yet', 'still', 'already']);
const DEPTH_PHRASE = /\bwhat if\b|\bwhat happens if\b|\b(source|origin|root) of\b/;
export function quickText(text) {
  if (typeof text !== 'string') return false;
  const typed = text.trim().replace(/’/g, "'");
  if (!typed || typed.length > 120 || !/^[\x20-\x7e]+$/.test(typed)) return false;
  const low = typed.toLowerCase().replace(/ +/g, ' ');
  // An opener ends where its last word does: "what isn't" does not start with "what is".
  const opener = OPENERS.find(opener => low.startsWith(opener) && !/[a-z0-9']/.test(low[opener.length] ?? ' '));
  if (!opener) return false;
  if (DEPTH_PHRASE.test(low)) return false;
  // "shouldn't" reads shouldn and t, "you're" reads you and re: each is caught by its first part.
  const words = low.split(/[^a-z0-9]+/).filter(Boolean), after = low.slice(opener.length).split(/[^a-z0-9]+/).filter(Boolean);
  if (after[0] === 'that' || words.at(-1) === 'that') return false;
  return !words.some(word => SPOKEN.has(word) || DEPTH.has(word) || POINTS.has(word));
}

// The step a message of the owner's gets, from the session's state as plain data:
//   'plan'   the top model: a new session, no Task open, a Task that waits and anything but
//            a plain yes, or a new ask after the work ended
//   'edit'   the work model: a plain yes to a waiting Task, or the approved Task's work is
//            starting, going on, or stopped on a question, a block or his stop
//   'quick'  a simple lookup question, with the session idle and not waiting on him
//   'stay'   no step: the model that ran last. An acknowledgement with nothing waiting, and
//            a message to a bot, which its own model answers.
// Only for a request that is the owner's words (ownerWords) and no retry. state:
//   first      the message starts the session
//   approved   the request is his approval of a Task (the key, or the mode he set), whatever its text
//   waiting    a Task waits for approval
//   yes        the text is a plain yes (read from the text when not given)
//   work       'starting' (approved, not begun), 'going', 'stopped' (on a question, a block
//              or his stop), or null
//   met, objectives   how many objectives the open Task reports met, and how many it has
//              (null with no Task open). The work ended when every one is reported met.
//   asked      the session asked him something and waits for the answer
//   toBot, toModel    the message is written to a bot, or to @model
//   idle, replied     no turn is working, and the session has a reply
//   quick      a quick route exists now (routeFor('quick', …) is not null)
export function stepOf(text, state = {}) {
  const at = isObject(state) ? state : {};
  if (at.toBot === true) return 'stay';
  if (at.approved === true) return 'edit';
  if (at.first === true) return 'plan';
  if (at.waiting === true) return (typeof at.yes === 'boolean' ? at.yes : saysYes(text)) ? 'edit' : 'plan';
  if (at.work === 'starting' || at.work === 'stopped') return 'edit';
  // A quick question never goes where the session waits on him: the returns above took a Task
  // that waits and work that is starting or stopped, and asked is a question it put to him.
  if (at.idle === true && at.replied === true && at.asked !== true && at.toModel !== true && at.quick === true && quickText(text)) return 'quick';
  const counted = Number.isFinite(at.met) && Number.isFinite(at.objectives), ended = counted && at.met >= at.objectives;
  if (!ended && (counted || at.work === 'going')) return 'edit';
  return isAck(text) ? 'stay' : 'plan';
}

// ---- Each vendor's models, by class ----

// Claude Code names its top and work model by alias, which follows the newest of each. It has
// no alias for the fast one, so that is the newest Haiku in the catalog of the Claude Code
// installed here (lib/claude-catalog.mjs, read from the program's file, never run), else the
// one named below. Codex's names carry versions: the family word is matched and the highest
// version it lists is taken. Sonnet and GPT Terra are in no class. Antigravity and Grok Build
// have none; Grok Build's own default model is its fast one (FAST_OWN).
const CLAUDE_FAST = 'claude-haiku-5-5', CLAUDE_ID = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?$/;
const CODEX_NAME = /^gpt-(\d+)(?:\.(\d+))?-(astra|sol|terra|luna)$/, CODEX_CLASS = Object.freeze({ astra: 'top', sol: 'work', luna: 'fast' });
const FAST_OWN = Object.freeze(['grok']);
const newer = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];
// The newest id the installed Claude Code lists for a family (opus reads claude-opus-5-5), or null.
function newestClaude(family, env) {
  const bin = findBin('claude', env); let best = null;
  for (const id of bin ? Object.keys(installedEfforts(bin)) : []) {
    const found = CLAUDE_ID.exec(id); if (!found || found[1] !== family) continue;
    const version = [Number(found[2]), Number(found[3] ?? 0)];
    if (!best || newer(version, best.version)) best = { id, version };
  }
  return best?.id ?? null;
}
// { top, work, fast } for a vendor, each the name its --model takes, or null where it has none.
// codexModels: Codex's names when the caller has them ([name] or [{ name }]); else the ones
// last read here or by an earlier start (lib/bot-models.mjs keptModels), which starts no
// program. With no names known Codex has no class yet.
export function classNames(vendor, { env = process.env, codexModels = null } = {}) {
  if (vendor === 'claude') return { top: 'fable', work: 'opus', fast: newestClaude('haiku', env) ?? CLAUDE_FAST };
  const best = {};
  if (vendor === 'codex') {
    for (const row of codexModels ?? keptModels('codex', { env })) {
      const name = typeof row === 'string' ? row : row?.name, found = typeof name === 'string' ? CODEX_NAME.exec(name) : null, kind = found ? CODEX_CLASS[found[3]] : null;
      if (!kind) continue;
      const version = [Number(found[1]), Number(found[2] ?? 0)];
      if (!best[kind] || newer(version, best[kind].version)) best[kind] = { name, version };
    }
  }
  return { top: best.top?.name ?? null, work: best.work?.name ?? null, fast: best.fast?.name ?? null };
}
// A model of a route as the chat names it: an alias by the newest release the installed
// Claude Code lists for it (fable reads Fable 5.2), any other name as a reply's header reads
// it, and a vendor's own default by the vendor (Grok Build).
export function routeName(vendor, model, { env = process.env } = {}) {
  if (!model) return vendorShort(vendor);
  const full = vendor === 'claude' && /^[a-z]+$/.test(model) ? newestClaude(model, env) : null;
  return modelName(full ?? model) ?? model;
}
// Why Auto model cannot be on for a session of this vendor, or null when it can. Plans and
// edits never leave the session's own vendor, so it needs a top and a work model of its own.
export function homeProblem(vendor, options = {}) {
  // Claude Code's two are aliases it always takes: nothing is read for them.
  if (vendor === 'claude') return null;
  if (vendor !== 'codex') return LINES.needsHome;
  const { top, work } = classNames(vendor, options);
  return top && work ? null : LINES.noClasses(vendor);
}

// ---- Whether a vendor can take a quick question now ----

const fileStamp = file => { try { const stat = fs.statSync(file); return `${stat.mtimeMs}:${stat.size}`; } catch { return '-'; } };
// What tells one sign-in of a vendor from the next, read from files only: who is signed in
// and when the file that holds the sign-in last changed. A vendor held off after its sign-in
// failed is tried again when this changes.
function signInStamp(vendor, env) {
  try {
    const home = homeOf(env);
    if (vendor === 'grok') return [fileStamp(path.join(home, '.grok', 'auth.json')), fileStamp(path.join(grokHome(), 'auth.json'))].join('|');
    if (vendor === 'claude' || vendor === 'codex') {
      const login = activeLogin(vendor), own = login === DEFAULT_LOGIN, named = name => typeof env[name] === 'string' && path.isAbsolute(env[name]) ? env[name] : null;
      const file = vendor === 'claude' ? path.join(own ? named('CLAUDE_CONFIG_DIR') ?? path.join(home, '.claude') : loginFolder(vendor, login), '.credentials.json') : path.join(own ? named('CODEX_HOME') ?? path.join(home, '.codex') : loginFolder(vendor, login), 'auth.json');
      return [login, accountOf(vendor, login, { env })?.email ?? '-', fileStamp(file), vendor === 'claude' ? readSwitch().signIn?.[login] ?? '-' : '-'].join('|');
    }
    const read = savedSignIn(vendor); return read ? `${read.signedIn}:${read.at}` : '-';
  } catch { return '-'; }
}
// Signed in: true, false, or null when no file says. Claude Code and Codex name an account or
// do not, and only their own programs know whether that sign-in still works, so a named
// account is true and none is not known; a Claude account marked as waiting for a sign-in is
// false. Grok Build is its token file. Antigravity is what the Usage tab last read of this program.
function signedInNow(vendor, bin, env) {
  if (vendor === 'claude' || vendor === 'codex') {
    const login = activeLogin(vendor);
    if (vendor === 'claude' && readSwitch().signIn?.[login]) return false;
    return accountOf(vendor, login, { env }) ? true : null;
  }
  if (vendor === 'grok') return signInFile({ env });
  const read = savedSignIn(vendor); return read && read.bin === bin ? read.signedIn : null;
}
function heldOff(vendor, kept, env, now) {
  const until = kept.hold?.[vendor]; if (!Number.isFinite(until) || until <= now) return false;
  const stamp = kept.holdSignIn?.[vendor]; return stamp === undefined || stamp === signInStamp(vendor, env);
}
// What is known about a vendor here, with no program run: { vendor, installed, signedIn (true,
// false or null), block, held, ready }. block: why a turn in this mode cannot start on it
// (lib/conformance.mjs modeBlock: its one-time check has not passed, or it would load what
// the owner has not allowed), or null. held: it failed a quick question and is passed over
// for now (holdVendor). ready: installed, signed in not false, no block, not held.
// mode: the mode the run would have; a quick question is always read-only ('locked').
export function vendorState(vendor, { env = process.env, now = Date.now(), mode = 'locked', settings = null } = {}) {
  const bin = CAPS[vendor] ? findBin(vendor, env) : null;
  if (!bin) return { vendor, installed: false, signedIn: null, block: null, held: false, ready: false };
  let signedIn = null, block = null;
  try { signedIn = signedInNow(vendor, bin, env); } catch { signedIn = null; }
  // A record that cannot be read is no proof: the vendor is not ready.
  try { block = modeBlock(vendor, { bin, mode }); } catch { block = `${VENDOR_NAMES[vendor]} could not be read on this machine.`; }
  const held = heldOff(vendor, settings ?? autoSettings({ env, now }), env, now);
  return { vendor, installed: true, signedIn, block, held, ready: signedIn !== false && !block && !held };
}
export const vendorReady = (vendor, options) => vendorState(vendor, options).ready;
// A fast vendor failed a quick question: it is passed over for 15 minutes, for an hour after
// a limit (cause 'quota'), and after a sign-in that failed (cause 'auth') until that sign-in
// changes, a day at most. cause: as the vendor's adapter classified the failure. Never
// throws: the message goes to the top model whether or not this could be kept. Returns the
// settings as saved, or null.
export function holdVendor(vendor, cause, { env = process.env, now = Date.now() } = {}) {
  if (!VENDORS.includes(vendor)) return null;
  const auth = cause === 'auth', until = now + (auth ? AUTH_HOLD_MS : cause === 'quota' ? LIMIT_HOLD_MS : HOLD_MS);
  try {
    const stamp = auth ? signInStamp(vendor, env) : null;
    return saveAutoSettings(was => { const signIn = { ...was.holdSignIn }; if (stamp) signIn[vendor] = stamp; else delete signIn[vendor]; return { hold: { ...was.hold, [vendor]: until }, holdSignIn: signIn }; }, { env, now });
  } catch { return null; }
}
// The fast route of a vendor, { vendor, model } (model null for the vendor's own default), or null when it has none.
function fastOf(vendor, options) {
  if (FAST_OWN.includes(vendor)) return { vendor, model: null };
  const model = classNames(vendor, options).fast; return model ? { vendor, model } : null;
}
// The vendor a quick question goes to, or null when it goes nowhere and the message is not
// quick. With no vendor set: Grok Build, then the fast model of the session's own vendor. With
// one set: that vendor, then the session's own, and never a second vendor he did not name.
// Each only when it has a fast route and is ready for a read-only run (vendorReady), so a
// quick question never starts a vendor's one-time check. Set to home, only the session's own
// vendor; set to off, none. home: the session's vendor.
export function quickVendor({ home = null, settings = null, env = process.env, now = Date.now(), codexModels = null } = {}) {
  const kept = settings ?? autoSettings({ env, now });
  if (kept.quick === 'off') return null;
  const order = kept.quick === 'home' ? [home] : VENDORS.includes(kept.quick) ? [kept.quick, home] : ['grok', home];
  return [...new Set(order)].find(vendor => CAPS[vendor] && fastOf(vendor, { env, codexModels }) && vendorReady(vendor, { env, now, mode: 'locked', settings: kept })) ?? null;
}

// ---- The route of a step ----

// Where a step runs. For 'plan' and 'edit': { step, vendor, model, effort } on the session's
// own vendor: the top model for a plan, the work model for an edit, at this computer's Auto
// model effort (null for a vendor that takes none). For 'quick': { step, vendor, model, name },
// model null for the vendor's own default and name as the answer's header says it. null when
// there is none: a step that is no route ('stay'), a vendor Auto model cannot be on for, a
// quick question with nowhere to go, or an edit a working bot does on its own model (worker).
//
// A plan or an edit takes the other model when its own cannot run and the other can; the
// route then carries instead: { from (the model passed over), why, until }.
//   why 'plan'   the top model is not on the owner's plan (task.autoNoTop): the work model
//                answers in this session
//   why 'limit'  the model is at its limit until then (ms, or null when not known)
// insteadLine gives the sentence for it, and sayOnce keeps it to one line a limit.
// ctx: { home, task, settings, env, now, codexModels, worker, free }. home: the session's
// vendor. free(model): whether a model can run now, { free: true } or { free: false, until };
// when not given, Claude's is read from what is kept of each account (lib/claude-accounts.mjs
// claudeModelFree) and any other vendor's model is free, since nothing reads its own limit.
export function routeFor(step, ctx = {}) {
  if (step !== 'plan' && step !== 'edit' && step !== 'quick') return null;
  const given = isObject(ctx) ? ctx : {}, { home = null, task = null, env = process.env, now = Date.now(), codexModels = null, worker = null } = given;
  if ((step === 'edit' && worker) || homeProblem(home, { env, codexModels })) return null;
  const settings = given.settings ?? autoSettings({ env, now });
  if (step === 'quick') {
    const fast = fastOf(quickVendor({ home, settings, env, now, codexModels }), { env, codexModels });
    return fast ? { step, vendor: fast.vendor, model: fast.model, name: routeName(fast.vendor, fast.model, { env }) } : null;
  }
  const names = classNames(home, { env, codexModels }), want = step === 'plan' ? 'top' : 'work', other = want === 'top' ? 'work' : 'top';
  const effort = (VENDOR_EFFORTS[home] ?? []).includes(settings.effort) ? settings.effort : null;
  const made = (kind, instead = null) => ({ step, vendor: home, model: names[kind], effort, ...(instead ? { instead } : {}) });
  const noTop = task?.autoNoTop === true;
  if (noTop && want === 'top') return made('work', { from: names.top, why: 'plan', until: null });
  const ask = typeof given.free === 'function' ? given.free : model => home === 'claude' ? claudeModelFree(model, { now, env }) : { free: true };
  // What cannot be read is taken as free: the turn itself then says what stands in its way.
  const free = model => { try { return ask(model) ?? { free: true }; } catch { return { free: true }; } };
  const own = free(names[want]);
  if (own.free === false && !(noTop && other === 'top') && free(names[other]).free === true) return made(other, { from: names[want], why: 'limit', until: Number.isFinite(own.until) ? own.until : null });
  return made(want);
}
// The sentence for a route that took the other model, or null for one that did not.
export function insteadLine(route, { env = process.env, now = Date.now() } = {}) {
  const swap = route?.instead; if (!swap) return null;
  const from = routeName(route.vendor, swap.from, { env }), to = routeName(route.vendor, route.model, { env });
  return swap.why === 'plan' ? LINES.noTop({ from, to }) : LINES.limit({ from, to, until: swap.until, now, step: route.step });
}
// One line a limit, not one a turn: true the first time a key is said, false until its time
// has passed. key: what the line is about ('limit:fable', 'no-top'). until: when it may be
// said again (ms); a day from now when not given. Kept on the session as autoSaid, which the
// caller saves with the record it holds.
export function sayOnce(task, key, { until = null, now = Date.now() } = {}) {
  const said = Object.fromEntries(Object.entries(isObject(task.autoSaid) ? task.autoSaid : {}).filter(([, at]) => Number.isFinite(at) && at > now));
  const first = !Object.hasOwn(said, key);
  if (first) said[key] = Number.isFinite(until) && until > now ? until : now + SAID_MS;
  task.autoSaid = said;
  return first;
}
// The key sayOnce keeps a route's line by.
export const insteadKey = route => route?.instead ? route.instead.why === 'plan' ? 'no-top' : `limit:${route.instead.from}` : null;
// "Plans: Fable 5.2 xhigh · Edits: Opus 5.5 xhigh · Quick questions: Grok Build": the routes
// as they would be picked now, so a model at its limit is not named. A working bot that does
// the session's work edits on its own model and is named instead (worker: its name). The part
// for quick questions is left out when they go nowhere. ctx: as routeFor's.
export function routesLine(ctx = {}) {
  const given = isObject(ctx) ? ctx : {}, env = given.env ?? process.env, worker = given.worker ?? null;
  // The settings are read once for the three routes.
  const all = { ...given, settings: given.settings ?? autoSettings({ env, now: given.now ?? Date.now() }) };
  const said = route => [routeName(route.vendor, route.model, { env }), route.effort].filter(Boolean).join(' ');
  const plan = routeFor('plan', all), edit = worker ? null : routeFor('edit', all), quick = routeFor('quick', all);
  return [plan ? `Plans: ${said(plan)}` : null, worker ? `Edits: @${worker}` : edit ? `Edits: ${said(edit)}` : null, quick ? `Quick questions: ${quick.name}` : null].filter(Boolean).join(' · ');
}

// ---- What the owner types after /model auto ----

// Nothing, or the word on, turns Auto model on. The word off turns it off: the session stays
// on the model it has. Exactly one effort word sets the effort of plans and edits on this
// computer. Exactly quick and a vendor, home or off sets where quick questions go. Anything
// else is a message, sent with Auto model on. text: what follows the word auto.
// Returns { kind: 'on' }, { kind: 'off' }, { kind: 'effort', effort }, { kind: 'quick', quick } or { kind: 'message', text }.
export function autoWords(text) {
  const typed = String(text ?? '').trim(), words = typed.split(/\s+/).filter(Boolean).map(word => word.toLowerCase());
  if (!words.length || words.length === 1 && words[0] === 'on') return { kind: 'on' };
  if (words.length === 1 && words[0] === 'off') return { kind: 'off' };
  if (words.length === 1 && EFFORTS.includes(words[0])) return { kind: 'effort', effort: words[0] };
  if (words.length === 2 && words[0] === 'quick' && (VENDORS.includes(words[1]) || QUICK_WORDS.includes(words[1]))) return { kind: 'quick', quick: words[1] };
  return { kind: 'message', text: typed };
}

// ---- Every sentence the feature shows ----

const withStop = line => /[.!?]$/.test(line) ? line : `${line}.`;
export const LINES = Object.freeze({
  // The first row of the /model list: the word auto, then this beside it.
  listNote: 'ELU picks the model for each step',
  // When turned on, with the routes (routesLine).
  on: routes => routes ? `${AUTO_NAME} is on. ${routes}` : `${AUTO_NAME} is on.`,
  off: `${AUTO_NAME} is off.`,
  // The message box of a session with Auto model on. mode: the mode's label (Approve for me).
  box: mode => `Message ${AUTO_NAME} · ${mode}`,
  // A model the owner picks wins. name: the model picked.
  picked: name => `Model of this session: ${name}. ${AUTO_NAME} is off.`,
  // Any other change of his that turns it off (an effort): the change's own line, then this.
  offAfter: line => `${withStop(String(line).trim())} ${AUTO_NAME} is off.`,
  // Over a quick answer, and when the top model takes the message instead. name: who answered.
  quickFrom: name => `${name} · quick answer`,
  handUp: name => `${name} answers this one: it needs more than a quick answer.`,
  quickStopped: 'Stopped the quick answer.',
  // ELU ended while a quick answer was being written: under the question that got none.
  quickCut: 'The quick answer was cut off. Send your question again.',
  // The row of quick answers in Usage.
  usageRow: 'Quick answers',
  // The other model takes a step. from: the model passed over; to: the one that runs.
  limit: ({ from, to, until = null, now = Date.now(), step = 'plan' }) => {
    const does = step === 'edit' ? 'edits' : 'answers';
    return Number.isFinite(until) && until > now ? `${from} is at its limit until ${dayClock(until, now)}, so ${to} ${does} until then.` : `${from} is at its limit, so ${to} ${does} for now.`;
  },
  noTop: ({ from, to }) => `${from} is not on your plan, so ${to} answers in this session.`,
  // Why Auto model cannot be on.
  needsHome: `${AUTO_NAME} needs Claude Code or Codex for this session.`,
  // The same for /model computer auto, which is about every session started here.
  needsHomeHere: `${AUTO_NAME} needs Claude Code or Codex on this computer.`,
  noClasses: vendor => `${AUTO_NAME} needs a top model and a work model, and ${VENDOR_NAMES[vendor] ?? vendor} does not list both on this computer.`,
  // The two sentences a change of model is refused with (lib/models.mjs), word for word.
  keepsTeammate: "A teammate's question keeps the model it started with.",
  keepsCommit: 'This session keeps the model of the commit it started from.',
  otherComputer: `${AUTO_NAME} is set on the computer that runs the session.`,
  // While the background conductor is the build from before the update.
  older: `ELU still runs its sessions on the build from before your update, which has no ${AUTO_NAME}. It moves to the new build once they end; try again then.`,
  // /model default auto: the default is the project's shared setting, and Auto model is this computer's.
  defaultHint: `${AUTO_NAME} is set for this computer: /model computer auto.`,
  computerOn: `New sessions you start on this computer begin with ${AUTO_NAME}.`,
  computerOff: `New sessions you start on this computer no longer begin with ${AUTO_NAME}.`,
  // The word auto is taken.
  reserved: `auto turns ${AUTO_NAME} on. A model saved by that name is typed vendor:auto.`,
  effortSet: level => `${AUTO_NAME} plans and edits at ${level} on this computer.`,
  effortUse: `Effort for ${AUTO_NAME} is one of: ${EFFORTS.join(', ')}.`,
  // Where quick questions go on this computer. target: a vendor, home or off.
  quickSet: target => target === 'off' ? 'Quick questions are off on this computer.' : target === 'home' ? "Quick questions go to the session's own vendor on this computer." : `Quick questions go to ${VENDOR_NAMES[target] ?? target} on this computer.`,
  quickUse: 'Quick questions go to claude, codex, grok, home or off: /model auto quick grok.',
  quickNone: vendor => `${VENDOR_NAMES[vendor] ?? vendor} has no fast model for quick questions.`,
  // The vendor he set cannot take one yet (not installed, not signed in, or its one-time check has not passed).
  // now: the vendor that answers them meanwhile (quickVendor), or null when none does.
  quickWaits: (vendor, now = null) => `${VENDOR_NAMES[vendor] ?? vendor} is not ready for quick questions on this computer yet. Until it is, ${now ? `${VENDOR_NAMES[now] ?? now} answers them` : 'no quick answer is given'}.`,
});
