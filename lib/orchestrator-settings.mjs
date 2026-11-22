import fs from 'node:fs';
import path from 'node:path';
import { atomic, isObject, noSymlinks, personalDirectory, readJson, refuse } from './util.mjs';
import { LABELS } from './modes.mjs';
import { FULL_CAPS, LEVEL_FULL, LEVEL_FULL_MEANS, LEVEL_FULL_NAME } from './orchestrator-seams.mjs';

// How far the bot that oversees the owner's sessions may go by itself: one level for this
// computer, and the caps its actions are counted against (lib/orchestrator-actions.mjs reads
// both anew at every call). Only the owner changes them, with /orchestrator or by editing the
// file. Nothing here is ever written by a turn, so the level never rises by itself.
//
// <personal>/orchestrator.json:
//   { version: 1, level: 'full', levelBy?: 'owner', caps: { sessionsPerDay, messagesPerHour,
//     messagesInARow, cardsPerDay, startBudgetUsd, turnLimitUsd, eluCallsPerDay, startMode }, fullCaps? }
// fullCaps: the same caps at Full (lib/orchestrator-seams.mjs FULL_CAPS), kept apart so that
// a cap the owner set below Full never limits Full, nor the other way round.
// Full is the default level (DEFAULT_LEVEL): a computer with no file, and one whose file holds no
// level the owner chose, is at Full. levelBy: the level was set (/orchestrator LEVEL): it stays as
// set. A file from before levelBy holds a level the owner chose when it is not Suggest, the old
// default, which a cap change wrote with the level as it was; so Suggest without levelBy, and no
// level at all, are the default. A file that cannot be read, or that names a level this version
// does not know, gives Watch, the lowest: a damaged file must never give the bot more than the
// owner chose. A cap that does not read is its default, and one above its ceiling is the ceiling.
export const LEVELS = Object.freeze(['watch', 'suggest', 'act', 'run', LEVEL_FULL]);
export const LEVEL_NAMES = Object.freeze({ watch: 'Watch', suggest: 'Suggest', act: 'Act', run: 'Run', [LEVEL_FULL]: LEVEL_FULL_NAME });
export const DEFAULT_LEVEL = LEVEL_FULL;
// The default level before Full was, which a file from then may hold without the owner choosing it.
const OLD_DEFAULT = 'suggest';
// What each level means, in one or two sentences, for /orchestrator and the docs.
export const LEVEL_MEANS = Object.freeze({
  watch: 'It reads your sessions and saves cited facts. It adds, proposes, sends and starts nothing.',
  suggest: 'It adds To do cards by itself. It asks you before it writes to a session, answers one or starts one.',
  act: 'It adds To do cards, writes to your sessions and answers their questions by itself. It asks you before it starts a session.',
  run: 'It adds To do cards, writes to your sessions, answers their questions and starts sessions by itself.',
  [LEVEL_FULL]: LEVEL_FULL_MEANS,
});
// Said under every level but Watch: no level lifts these.
export const ALWAYS_ASKS = 'An Organization line is written or removed only after your yes, at every level.';
// Said under Full besides: what still asks him there (lib/orchestrator-seams.mjs FULL_ASK_LIST).
export const FULL_ASKS = "At Full, publishing, tags, releases, workflow runs, force-pushes, deleting a repository and rm -rf of your home folder still ask you. Its words count as yours in your own sessions, here and on your paired computers, never in a teammate's.";
// Each cap: its default, the most it may be set to, whether it is a count, and what it is in words.
const CAPS = Object.freeze({
  sessionsPerDay: { value: 3, most: 20, count: true, says: 'Sessions started a day' },
  messagesPerHour: { value: 6, most: 60, count: true, says: 'Messages and answers an hour' },
  messagesInARow: { value: 2, most: 10, count: true, says: 'Messages in a row to one session with no progress there' },
  cardsPerDay: { value: 20, most: 200, count: true, says: 'Cards added a day' },
  startBudgetUsd: { value: 5, most: 100, least: 0.01, says: 'Budget of a session it starts' },
  turnLimitUsd: { value: 2, most: 20, least: 0.01, says: 'Limit of one of its own turns' },
  // Counted by the approval relay as each question to ELU's own server goes (lib/approval-server.mjs eluCall).
  eluCallsPerDay: { value: 20, most: 200, count: true, says: 'Questions to ELU a day' },
});
// The mode of a session it starts is this at most, and never Full access below Full.
const START_MODES = Object.freeze(['ask', 'auto']);
export const DEFAULT_CAPS = Object.freeze({ ...Object.fromEntries(Object.entries(CAPS).map(([name, cap]) => [name, cap.value])), startMode: 'auto' });
export const CAP_NAMES = Object.freeze(Object.keys(DEFAULT_CAPS));
// The same caps at Full, with Full's own defaults and ceilings (FULL_CAPS). A budget there may
// be none (null): a session it starts has its own budget, and its own turn no limit of the bot's.
const FULL_TABLE = Object.freeze(Object.fromEntries(Object.entries(CAPS).map(([name, cap]) => [name, Object.hasOwn(FULL_CAPS, name) ? { ...cap, value: FULL_CAPS[name].value, ...(Number.isFinite(FULL_CAPS[name].most) ? { most: FULL_CAPS[name].most } : {}), ...(cap.count ? {} : { none: true }) } : cap])));
const FULL_START_MODES = Object.freeze(['ask', 'auto', 'full']);
export const FULL_DEFAULT_CAPS = Object.freeze({ ...Object.fromEntries(Object.entries(FULL_TABLE).map(([name, cap]) => [name, cap.value])), startMode: FULL_CAPS.startMode.value });
const tableOf = level => level === LEVEL_FULL ? FULL_TABLE : CAPS;
const modesOf = level => level === LEVEL_FULL ? FULL_START_MODES : START_MODES;
const defaultsOf = level => level === LEVEL_FULL ? FULL_DEFAULT_CAPS : DEFAULT_CAPS;

// Tests keep ELU's folder in a temporary place: one that reached the owner's own would change
// how far his bot may go.
function folder() {
  if (process.env.NODE_TEST_CONTEXT && !process.env.XDG_CONFIG_HOME) refuse("A test must set XDG_CONFIG_HOME before it uses the orchestrator's settings: the owner's own are never a test's to read or write.");
  return personalDirectory();
}
export const settingsFile = () => path.join(folder(), 'orchestrator.json');

function capOf(name, given, level) {
  if (name === 'startMode') return modesOf(level).includes(given) ? given : defaultsOf(level).startMode;
  const cap = tableOf(level)[name], ok = typeof given === 'number' && Number.isFinite(given) && given >= (cap.least ?? 0) && (!cap.count || Number.isInteger(given));
  // At Full a budget that is none in the file stays none.
  if (given === null && cap.none) return null;
  return ok ? Math.min(given, cap.most) : cap.value;
}
const capsOf = (given, level = null) => Object.fromEntries(CAP_NAMES.map(name => [name, capOf(name, isObject(given) ? given[name] : undefined, level)]));
// Whether the file's level is one the owner set: levelBy says so, and a file from before it
// holds one when its level is not the old default.
const BY = ['owner', 'set'];
const chosenIn = value => isObject(value) && LEVELS.includes(value.level) && (BY.includes(value.levelBy) || value.level !== OLD_DEFAULT);
// The settings in force now: { version, level, chosen, caps, saved, problem }. chosen: the owner
// set this level; else it is the default, Full. saved: the file is there. problem: one sentence
// when the file gave Watch because it could not be used.
export function readSettings() {
  const file = settingsFile(); noSymlinks(file);
  if (!fs.existsSync(file)) return { version: 1, level: DEFAULT_LEVEL, chosen: false, caps: { ...FULL_DEFAULT_CAPS }, saved: false, problem: null };
  let value = null; try { value = readJson(file); } catch { value = null; }
  if (!isObject(value)) return { version: 1, level: 'watch', chosen: false, caps: { ...DEFAULT_CAPS }, saved: true, problem: 'The orchestrator settings could not be read, so the level is Watch until you set it again.' };
  const known = LEVELS.includes(value.level), level = !known ? 'watch' : chosenIn(value) ? value.level : DEFAULT_LEVEL;
  // chosen, as /orchestrator says it: Full with no levelBy is said as the default.
  const chosen = BY.includes(value.levelBy) || known && level !== LEVEL_FULL;
  // At Full the caps are Full's own (fullCaps); below it the ones every level had before.
  return { version: 1, level, chosen, caps: level === LEVEL_FULL ? capsOf(value.fullCaps, LEVEL_FULL) : capsOf(value.caps), saved: true, problem: known ? null : 'The orchestrator settings name a level this version of ELU does not know, so the level is Watch until you set it again.' };
}
// The caps below Full and at Full as the file holds them now, each read as its level reads it.
function savedCaps() {
  let value = null; try { const file = settingsFile(); noSymlinks(file); value = fs.existsSync(file) ? readJson(file) : null; } catch { value = null; }
  return { caps: capsOf(isObject(value) ? value.caps : null), fullCaps: isObject(value) && isObject(value.fullCaps) ? capsOf(value.fullCaps, LEVEL_FULL) : null };
}
// levelBy: who set the level: 'owner', or 'set' for any other set of a level below Full, which
// stays as set too. null: the level is the default; the file still names it, for an older ELU.
const write = (level, caps, fullCaps = null, levelBy = null) => { atomic(settingsFile(), { version: 1, level, ...(levelBy ? { levelBy } : {}), caps, ...(fullCaps ? { fullCaps } : {}) }); return readSettings(); };
// Who set the level the file holds now, as write keeps it: none while it is the default.
function savedBy() {
  let value = null; try { const file = settingsFile(); noSymlinks(file); value = fs.existsSync(file) ? readJson(file) : null; } catch { value = null; }
  return isObject(value) && chosenIn(value) && BY.includes(value.levelBy) ? value.levelBy : null;
}
// The owner sets the level, by its word in any case. The caps stay as they are. Full is given
// only by the owner himself (by: 'owner', /orchestrator full) or by the default: a level that
// hands the bot a shell is never set in passing, and never by a turn. A level set stays as set.
export function setLevel(word, { by = null } = {}) {
  const level = String(word ?? '').trim().toLowerCase();
  if (!LEVELS.includes(level)) refuse(`Choose a level: ${LEVELS.slice(0, -1).join(', ')} or ${LEVELS.at(-1)}.`);
  if (level === LEVEL_FULL && by !== 'owner') refuse('Only you set the level to Full: type /orchestrator full yourself.');
  const { caps, fullCaps } = savedCaps();
  return write(level, caps, fullCaps, by === 'owner' ? 'owner' : 'set');
}
// The owner sets one cap, for the level in force: at Full, Full's own. A count is a whole
// number from 0 up; a budget is in dollars, from a cent up, and at Full also none; startMode is
// ask or auto, and at Full also full. The level stays as it is.
export function setCap(name, value) {
  if (!CAP_NAMES.includes(name)) refuse(`There is no cap named ${String(name ?? '').slice(0, 40)}. The caps are ${CAP_NAMES.join(', ')}.`);
  const now = readSettings(), full = now.level === LEVEL_FULL, table = tableOf(now.level);
  if (name === 'startMode') {
    if (!modesOf(now.level).includes(value)) refuse(full ? `A session it starts has ${LABELS.ask}, ${LABELS.auto} or ${LABELS.full} at most: write ask, auto or full.` : `A session it starts has ${LABELS.ask} or ${LABELS.auto} at most: write ask or auto.`);
  } else if (table[name].none && (value === null || typeof value === 'string' && value.trim().toLowerCase() === 'none')) value = null;
  else {
    const cap = table[name], number = typeof value === 'string' && value.trim() ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < (cap.least ?? 0) || cap.count && !Number.isInteger(number) || number > cap.most) refuse(cap.count ? `${cap.says}: a whole number from 0 to ${cap.most}.` : `${cap.says}: dollars from ${cap.least} to ${cap.most}${cap.none ? ', or none' : ''}.`);
    value = number;
  }
  // The level is written as it reads now: a file that gave Watch because it was damaged stays at Watch.
  const saved = savedCaps(), by = now.problem ? null : savedBy();
  return full ? write(now.level, saved.caps, { ...now.caps, [name]: value }, by) : write(now.level, { ...now.caps, [name]: value }, saved.fullCaps, by);
}
const dollars = value => `$${Number(value.toFixed(2))}`;
const NONE = { startBudgetUsd: "none: the session's own budget", turnLimitUsd: 'none' };
// The caps as the lines /orchestrator shows, in the order of the design's table.
export function capLines(caps = readSettings().caps) {
  return [...Object.entries(CAPS).map(([name, cap]) => `${cap.says}: ${cap.count ? caps[name] : caps[name] === null ? NONE[name] : dollars(caps[name])}`), `Mode of a session it starts: ${LABELS[caps.startMode]} at most`];
}
// The level as /orchestrator shows it: its name, what it means, and what no level lifts.
export function levelLines(settings = readSettings()) {
  const named = settings.level === LEVEL_FULL && settings.chosen === false && !settings.problem ? `${LEVEL_NAMES[settings.level]}, the default` : LEVEL_NAMES[settings.level];
  return [`Level: ${named}. ${LEVEL_MEANS[settings.level]}`, ...(settings.level === 'watch' ? [] : [ALWAYS_ASKS]), ...(settings.level === LEVEL_FULL ? [FULL_ASKS] : []), ...(settings.problem ? [settings.problem] : [])];
}
