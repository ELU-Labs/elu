// The request functions of ELU 0.1.19 (lib/workspace.mjs, as published; 0.1.18 has the same).
// Everything else is today's.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomic, hash, noSymlinks, readJson, refuse } from '../../../lib/util.mjs';
import { personalDirectory } from '../../../lib/usage.mjs';
import { waitLock } from '../../../lib/state.mjs';
import { olderConductor } from './conductor-files.mjs';
export * from '../../../lib/workspace.mjs';

const requestFile = root => path.join(personalDirectory(), 'requests', `${hash(root)}.json`);
// A conductor of 0.1.16 or earlier never hands its work over: until it is idle it starts every
// queued request in requestFile. While one runs, the queued requests wait in this file
// instead, which it never reads, and the conductor of this version starts them beside it
// (Conductor.take). Once it has exited, they go back with the rest.
const besideFile = root => path.join(personalDirectory(), 'requests', `${hash(root)}.beside.json`);
function readRequests(file) {
  noSymlinks(file);
  if (!fs.existsSync(file)) return [];
  const rows = readJson(file);
  if (!Array.isArray(rows) || rows.some(row => typeof row?.id !== 'string' || !/^request-[a-f0-9-]+$/.test(row.id) || typeof row.goal !== 'string')) refuse('Saved requests could not be read.');
  return rows;
}
export function pendingRequests(root) {
  const seen = new Set();
  // A request moves between the files main first, so a copy left in both by a crash is read once.
  return [...readRequests(requestFile(root)), ...readRequests(besideFile(root))].filter(row => !seen.has(row.id) && seen.add(row.id) && row.state !== 'cancelled');
}
// Writes a project's requests, every one of them, under its requests lock. While a conductor
// without handover runs, the queued ones go to besideFile, written first, so none is ever in
// neither file. Only a write with a queued request asks about it, so others start no process.
function writeRequests(root, rows) {
  const side = besideFile(root), queued = rows.filter(row => row.state === 'queued');
  const hold = queued.length > 0 && Boolean(olderConductor());
  if (hold) atomic(side, queued);
  atomic(requestFile(root), hold ? rows.filter(row => row.state !== 'queued') : rows);
  if (!hold) { noSymlinks(side); fs.rmSync(side, { force: true }); }
}
// Moves the queued requests a conductor without handover could start into besideFile, while
// one runs: those queued before the update, and its own retries. True when it moved any.
export function holdRequests(root) {
  // Read first without the lock, as most ticks find nothing to move.
  if (!readRequests(requestFile(root)).some(row => row.state === 'queued')) return false;
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    if (!readRequests(requestFile(root)).some(row => row.state === 'queued') || !olderConductor()) return false;
    writeRequests(root, pendingRequests(root)); return true;
  } finally { release(); }
}
const ownRequest = ({ origin, readOnly, context, ...row }) => row;
export function saveRequest(root, goal, id, update = {}) {
  if (typeof goal !== 'string' || !goal.trim() || goal.length > 16000) refuse('Enter a request of 1 to 16000 characters.');
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), found = id && rows.find(row => row.id === id);
    // An owner who rewrites a teammate's request makes it their own, so its peer fields go.
    const existing = found && found.goal !== goal ? ownRequest(found) : found;
    const row = { ...(existing ?? { id: `request-${crypto.randomUUID()}`, createdAt: new Date().toISOString() }), goal, state: 'waiting', reason: 'Ready to review and start.', ...update };
    writeRequests(root, [...rows.filter(value => value.id !== row.id), row]); return row;
  } finally { release(); }
}
// Adds a message to a request that has not started: its text goes after the request's own,
// a blank line apart, while the request is still queued and the whole stays one message's
// length. One step, so the conductor never starts the request with half of it. Returns the
// request, or null when it is no longer queued or would grow too long.
export function addToRequest(root, id, text) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), found = rows.find(row => row.id === id && row.state === 'queued');
    if (!found || found.goal.length + text.length + 2 > 16000) return null;
    const row = { ...found, goal: `${found.goal}\n\n${text}` };
    writeRequests(root, rows.map(value => value.id === id ? row : value)); return row;
  } finally { release(); }
}
export function removeRequest(root, id) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try { writeRequests(root, pendingRequests(root).filter(row => row.id !== id)); } finally { release(); }
}
// A blocked or saved message of the owner's to a session is spent once the owner moved on in
// that session: a newer message of his to it was queued, started, ran or finished, or the
// session took a message of his after this one stopped. A bot's scheduled turn, a schedule's
// run and a teammate's message are not his, and spend nothing. Returns their IDs. rows: every
// saved request, done ones included; tasks: the project's sessions. A teammate's message is
// theirs, so it is never spent here.
const HELD = ['blocked', 'waiting'];
const timeOf = value => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; };
export function supersededRequests(rows, tasks = []) {
  const list = Array.isArray(rows) ? rows : [];
  return list.filter(row => {
    if (!HELD.includes(row?.state) || row.origin || row.continuationTaskId == null) return false;
    const session = String(row.continuationTaskId), since = timeOf(row.blockedAt ?? row.createdAt);
    if (list.some(other => other !== row && String(other?.continuationTaskId) === session && ['queued', 'starting', 'running', 'done'].includes(other.state) && !other.origin && !other.scheduled && !other.scheduleId && timeOf(other.createdAt) > timeOf(row.createdAt))) return true;
    // A bot's reply, a teammate's message and a bot's scheduled turn are not the owner's.
    const task = (Array.isArray(tasks) ? tasks : []).find(value => String(value?.id) === session);
    return (task?.messages ?? []).some(message => !message?.bot && !message?.shadow && !message?.from && !message?.peer && !message?.scheduled && timeOf(message?.at) > since);
  }).map(row => row.id);
}
// Takes spent messages out of the queue, in one step. One that was retried or changed since is kept.
export function dropRequests(root, ids) {
  const gone = new Set(ids); if (!gone.size) return 0;
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), kept = rows.filter(row => !(gone.has(row.id) && HELD.includes(row.state)));
    if (kept.length !== rows.length) writeRequests(root, kept);
    return rows.length - kept.length;
  } finally { release(); }
}
// Takes back a message that still waits: it is removed only while it is queued, in one
// step, so a message the conductor has begun to start is never reported as taken back.
// Returns the removed request, or null when it is gone or already starting.
export function takeRequest(root, id) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), found = rows.find(row => row.id === id && row.state === 'queued');
    if (found) writeRequests(root, rows.filter(row => row.id !== id));
    return found ?? null;
  } finally { release(); }
}
// Joins waiting messages into the first of them, in the order given and a blank line
// apart, while each is still queued and the whole stays one message's length. One step, so
// a message taken back a moment ago is not sent. Returns the joined request, or null when
// the first is no longer queued.
export function joinRequests(root, ids) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), found = ids.map(id => rows.find(row => row.id === id && row.state === 'queued')).filter(Boolean);
    if (found[0]?.id !== ids[0]) return null;
    const joined = [found[0]]; let goal = found[0].goal;
    for (const row of found.slice(1)) { if (goal.length + row.goal.length + 2 > 16000) break; goal += `\n\n${row.goal}`; joined.push(row); }
    if (joined.length === 1) return found[0];
    const gone = new Set(joined.slice(1).map(row => row.id)), row = { ...found[0], goal };
    writeRequests(root, rows.filter(value => !gone.has(value.id)).map(value => value.id === row.id ? row : value)); return row;
  } finally { release(); }
}
// Changes a request only while it still exists in an expected state, so a request
// cancelled in one terminal cannot be revived by the conductor, or the reverse.
export function updateRequest(root, id, update, { from } = {}) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), existing = rows.find(row => row.id === id);
    if (!existing || from && !from.includes(existing.state)) return null;
    const row = { ...existing, ...update };
    writeRequests(root, rows.map(value => value.id === id ? row : value)); return row;
  } finally { release(); }
}
