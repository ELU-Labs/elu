import fs from 'node:fs';
import path from 'node:path';
import { atomic, isObject, mkdir, noSymlinks, personalDirectory, readJson, refuse } from './util.mjs';

// The owner's mandates for the Orchestrator at Full (lib/orchestrator-seams.mjs): one goal each,
// with his standing decisions for it and the sessions that work on it. Inside a mandate the
// Orchestrator's messages, answers and approvals are the owner's word; outside one they stay
// notes. Only the owner makes or changes one (/orchestrator mandate, or yes to mandate_propose).
// A turn never writes this file: the Orchestrator's own Edit, Write and Bash are denied it.
//
// <personal>/orchestrator/mandates.json =
//   { version: 1, top, mandates: [{ id: "m1", name, goal, decisions: [], sessions: [{ computer, project,
//     session }], createdAt, by: "owner" }] }
// top: the highest id given so far. A session the bot started here under a mandate is named by
// its request (request-…) until it has a number, and by its number from then on
// (lib/orchestrator-actions.mjs).
// computer: another computer's key, or null for this one. project: the project's id there
// (lib/peer/remote.mjs projectKey). session: the session's id there, or its remote id.

/** @typedef {{ computer: string|null, project: string, session: string }} MandateSession */
/** @typedef {{ id: string, name: string, goal: string, decisions: string[], sessions: MandateSession[], createdAt: string, by: 'owner' }} Mandate */

const ID = /^m[1-9]\d{0,5}$/, HEX64 = /^[0-9a-f]{64}$/, REF = /^[A-Za-z0-9._-]{1,80}$/;
export const NAME_MAX = 80, GOAL_MAX = 2000, DECISION_MAX = 500, DECISIONS_MAX = 40;
// Tests keep ELU's folder in a temporary place: one that reached the owner's own would hand his
// word to made-up sessions.
function folder() {
  if (process.env.NODE_TEST_CONTEXT && !process.env.XDG_CONFIG_HOME) refuse("A test must set XDG_CONFIG_HOME before it uses the orchestrator's mandates: the owner's own are never a test's to read or write.");
  return path.join(personalDirectory(), 'orchestrator');
}
export const mandatesFile = () => path.join(folder(), 'mandates.json');
const text = (value, most) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b-\x1f]/g, '').trim().slice(0, most) : '';
const cleanSession = row => isObject(row) && (row.computer == null || HEX64.test(row.computer)) && REF.test(row.project ?? '') && REF.test(row.session ?? '')
  ? { computer: row.computer ?? null, project: row.project, session: row.session } : null;
function clean(row) {
  if (!isObject(row) || !ID.test(row.id ?? '') || row.by !== 'owner') return null;
  const name = text(row.name, NAME_MAX);
  if (!name) return null;
  return { id: row.id, name, goal: text(row.goal, GOAL_MAX), decisions: (Array.isArray(row.decisions) ? row.decisions : []).map(d => text(d, DECISION_MAX)).filter(Boolean).slice(0, DECISIONS_MAX),
    sessions: (Array.isArray(row.sessions) ? row.sessions : []).map(cleanSession).filter(Boolean), createdAt: typeof row.createdAt === 'string' ? row.createdAt : '', by: 'owner' };
}
// Every mandate in force. None, or a file that cannot be read, is [], which is today's behaviour.
/** @returns {Mandate[]} */
export function mandates() {
  try {
    const file = mandatesFile(); noSymlinks(file);
    if (!fs.existsSync(file)) return [];
    const value = readJson(file);
    return isObject(value) && value.version === 1 && Array.isArray(value.mandates) ? value.mandates.map(clean).filter(Boolean) : [];
  } catch { return []; }
}
const sameSession = (a, b) => (a.computer ?? null) === (b.computer ?? null) && a.project === b.project && a.session === b.session;
// The mandate a session is in, or null.
/** @param {MandateSession} ref @returns {Mandate|null} */
export function mandateFor(ref) {
  const want = cleanSession(ref);
  return want ? mandates().find(m => m.sessions.some(row => sameSession(row, want))) ?? null : null;
}
export const mandateById = id => mandates().find(m => m.id === id) ?? null;
// The highest id a mandate ever had here (top), so an ended mandate's id is never given to a new
// one: a log line that names it keeps meaning the one it meant.
const idNumber = m => Number(m.id.slice(1));
function topId() {
  try { const file = mandatesFile(); noSymlinks(file); if (!fs.existsSync(file)) return 0; const value = readJson(file); return Number.isSafeInteger(value?.top) && value.top > 0 ? value.top : 0; } catch { return 0; }
}
function write(list) { const top = Math.max(topId(), ...list.map(idNumber), 0); mkdir(folder()); atomic(mandatesFile(), { version: 1, top, mandates: list }); }
// The owner makes or changes a mandate. by must be 'owner': a turn's call is refused.
// Given an id, that mandate is replaced; else a new one gets the next id.
/** @param {{ id?: string, name: string, goal?: string, decisions?: string[], sessions?: MandateSession[] }} given @param {{ by: string }} who @returns {Mandate} */
export function saveMandate(given, { by } = {}) {
  if (by !== 'owner') refuse('Only the owner makes or changes a mandate.');
  const list = mandates(), id = given?.id ?? `m${list.reduce((most, m) => Math.max(most, idNumber(m)), topId()) + 1}`;
  const row = clean({ ...given, id, by: 'owner', createdAt: list.find(m => m.id === id)?.createdAt ?? new Date().toISOString() });
  if (!row) refuse('A mandate needs a name.');
  write([...list.filter(m => m.id !== id), row]);
  return row;
}
// The owner ends a mandate, named by its id (m1), its name or its goal. by must be 'owner': a
// turn's call is refused. Returns the mandate that ended, or null when none is named so. Its
// sessions take the bot's words as notes again from the next one.
/** @param {string} which @param {{ by: string }} who @returns {Mandate|null} */
export function removeMandate(which, { by } = {}) {
  if (by !== 'owner') refuse('Only the owner makes or changes a mandate.');
  const wanted = text(which, GOAL_MAX).toLowerCase();
  if (!wanted) refuse('Name the mandate.');
  const list = mandates(), found = list.find(m => m.id === wanted) ?? list.find(m => m.name.toLowerCase() === wanted) ?? list.find(m => m.goal && m.goal.toLowerCase() === wanted) ?? null;
  if (found) write(list.filter(m => m.id !== found.id));
  return found;
}
// A session joins a mandate: when the Orchestrator starts it under one (session_start with
// mandate, a start the owner's mandate allows) or when the owner adds it.
/** @param {string} id @param {MandateSession} ref @param {{ by: string }} who @returns {Mandate} */
export function joinMandate(id, ref, { by } = {}) {
  if (!['owner', 'start'].includes(by)) refuse('Only the owner, or a start under the mandate, adds a session to it.');
  const mandate = mandateById(id) ?? refuse('No such mandate.'), row = cleanSession(ref) ?? refuse('Name the session.');
  if (mandate.sessions.some(s => sameSession(s, row))) return mandate;
  return saveMandate({ ...mandate, sessions: [...mandate.sessions, row] }, { by: 'owner' });
}
// The block that goes into the starting task text of every session started under a mandate:
// a session acts on its starting text more reliably than on later messages.
/** @param {Mandate} mandate @returns {string} */
export function decisionsBlock(mandate) {
  if (!mandate?.decisions?.length) return '';
  return [`Owner's decisions (mandate ${mandate.name}):`, ...mandate.decisions.map(d => `- ${d}`)].join('\n');
}
