import fs from 'node:fs';
import path from 'node:path';
import { atomic, isObject, noSymlinks, personalDirectory, readJson, refuse } from './util.mjs';
import { LABELS } from './modes.mjs';

// How far the bot that oversees the owner's sessions may go by itself: one level for this
// computer, and the caps its actions are counted against (lib/orchestrator-actions.mjs reads
// both anew at every call). Only the owner changes them, with /orchestrator or by editing the
// file. Nothing here is ever written by a turn, so the level never rises by itself.
//
// <personal>/orchestrator.json:
//   { version: 1, level: 'suggest', caps: { sessionsPerDay, messagesPerHour, messagesInARow,
//     cardsPerDay, startBudgetUsd, turnLimitUsd, eluCallsPerDay, startMode } }
// A computer with no file is at Suggest. A file that cannot be read, or that names a level
// this version does not know, gives Watch, the lowest: a damaged file must never give the bot
// more than the owner chose. A cap that does not read is its default, and one above its
// ceiling is the ceiling.
export const LEVELS = Object.freeze(['watch', 'suggest', 'act', 'run']);
export const LEVEL_NAMES = Object.freeze({ watch: 'Watch', suggest: 'Suggest', act: 'Act', run: 'Run' });
export const DEFAULT_LEVEL = 'suggest';
// What each level means, in one or two sentences, for /orchestrator and the docs.
export const LEVEL_MEANS = Object.freeze({
  watch: 'It reads your sessions and saves cited facts. It adds, proposes, sends and starts nothing.',
  suggest: 'It adds To do cards by itself. It asks you before it writes to a session, answers one or starts one.',
  act: 'It adds To do cards, writes to your sessions and answers their questions by itself. It asks you before it starts a session.',
  run: 'It adds To do cards, writes to your sessions, answers their questions and starts sessions by itself.',
});
// Said under every level but Watch: no level lifts these.
export const ALWAYS_ASKS = 'An Organization line is written or removed only after your yes, at every level.';
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
// The mode of a session it starts is this at most, and never Full access.
const START_MODES = Object.freeze(['ask', 'auto']);
export const DEFAULT_CAPS = Object.freeze({ ...Object.fromEntries(Object.entries(CAPS).map(([name, cap]) => [name, cap.value])), startMode: 'auto' });
export const CAP_NAMES = Object.freeze(Object.keys(DEFAULT_CAPS));

// Tests keep ELU's folder in a temporary place: one that reached the owner's own would change
// how far his bot may go.
function folder() {
  if (process.env.NODE_TEST_CONTEXT && !process.env.XDG_CONFIG_HOME) refuse("A test must set XDG_CONFIG_HOME before it uses the orchestrator's settings: the owner's own are never a test's to read or write.");
  return personalDirectory();
}
export const settingsFile = () => path.join(folder(), 'orchestrator.json');

function capOf(name, given) {
  if (name === 'startMode') return START_MODES.includes(given) ? given : DEFAULT_CAPS.startMode;
  const cap = CAPS[name], ok = typeof given === 'number' && Number.isFinite(given) && given >= (cap.least ?? 0) && (!cap.count || Number.isInteger(given));
  return ok ? Math.min(given, cap.most) : cap.value;
}
const capsOf = given => Object.fromEntries(CAP_NAMES.map(name => [name, capOf(name, isObject(given) ? given[name] : undefined)]));
// The settings in force now: { version, level, caps, saved, problem }. saved: the file is
// there. problem: one sentence when the file gave Watch because it could not be used.
export function readSettings() {
  const file = settingsFile(); noSymlinks(file);
  if (!fs.existsSync(file)) return { version: 1, level: DEFAULT_LEVEL, caps: { ...DEFAULT_CAPS }, saved: false, problem: null };
  let value = null; try { value = readJson(file); } catch { value = null; }
  if (!isObject(value)) return { version: 1, level: 'watch', caps: { ...DEFAULT_CAPS }, saved: true, problem: 'The orchestrator settings could not be read, so the level is Watch until you set it again.' };
  const known = LEVELS.includes(value.level);
  return { version: 1, level: known ? value.level : 'watch', caps: capsOf(value.caps), saved: true, problem: known ? null : 'The orchestrator settings name a level this version of ELU does not know, so the level is Watch until you set it again.' };
}
const write = (level, caps) => { atomic(settingsFile(), { version: 1, level, caps }); return readSettings(); };
// The owner sets the level, by its word in any case. The caps stay as they are.
export function setLevel(word) {
  const level = String(word ?? '').trim().toLowerCase();
  if (!LEVELS.includes(level)) refuse(`Choose a level: ${LEVELS.slice(0, -1).join(', ')} or ${LEVELS.at(-1)}.`);
  return write(level, readSettings().caps);
}
// The owner sets one cap. A count is a whole number from 0 up; a budget is in dollars, from a
// cent up; startMode is ask or auto. The level stays as it is.
export function setCap(name, value) {
  if (!CAP_NAMES.includes(name)) refuse(`There is no cap named ${String(name ?? '').slice(0, 40)}. The caps are ${CAP_NAMES.join(', ')}.`);
  const now = readSettings();
  if (name === 'startMode') { if (!START_MODES.includes(value)) refuse(`A session it starts has ${LABELS.ask} or ${LABELS.auto} at most: write ask or auto.`); }
  else {
    const cap = CAPS[name], number = typeof value === 'string' && value.trim() ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < (cap.least ?? 0) || cap.count && !Number.isInteger(number) || number > cap.most) refuse(cap.count ? `${cap.says}: a whole number from 0 to ${cap.most}.` : `${cap.says}: dollars from ${cap.least} to ${cap.most}.`);
    value = number;
  }
  // The level is written as it reads now: a file that gave Watch because it was damaged stays at Watch.
  return write(now.level, { ...now.caps, [name]: value });
}
const dollars = value => `$${Number(value.toFixed(2))}`;
// The caps as the lines /orchestrator shows, in the order of the design's table.
export function capLines(caps = readSettings().caps) {
  return [...Object.entries(CAPS).map(([name, cap]) => `${cap.says}: ${cap.count ? caps[name] : dollars(caps[name])}`), `Mode of a session it starts: ${LABELS[caps.startMode]} at most`];
}
// The level as /orchestrator shows it: its name, what it means, and what no level lifts.
export function levelLines(settings = readSettings()) {
  return [`Level: ${LEVEL_NAMES[settings.level]}. ${LEVEL_MEANS[settings.level]}`, ...(settings.level === 'watch' ? [] : [ALWAYS_ASKS]), ...(settings.problem ? [settings.problem] : [])];
}
