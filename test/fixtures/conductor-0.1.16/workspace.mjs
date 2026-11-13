// The request functions of ELU 0.1.16 (lib/workspace.mjs, as published): they read and write
// only the one request file of a project. Everything else is today's.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomic, hash, noSymlinks, readJson, refuse } from '../../../lib/util.mjs';
import { personalDirectory } from '../../../lib/usage.mjs';
import { waitLock } from '../../../lib/state.mjs';
export * from '../../../lib/workspace.mjs';

const requestFile = root => path.join(personalDirectory(), 'requests', `${hash(root)}.json`);
export function pendingRequests(root) {
  const file = requestFile(root); noSymlinks(file);
  if (!fs.existsSync(file)) return [];
  const rows = readJson(file);
  if (!Array.isArray(rows) || rows.some(row => typeof row?.id !== 'string' || !/^request-[a-f0-9-]+$/.test(row.id) || typeof row.goal !== 'string')) refuse('Saved requests could not be read.');
  return rows.filter(row => row.state !== 'cancelled');
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
    atomic(requestFile(root), [...rows.filter(value => value.id !== row.id), row]); return row;
  } finally { release(); }
}
export function removeRequest(root, id) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try { atomic(requestFile(root), pendingRequests(root).filter(row => row.id !== id)); } finally { release(); }
}
export function joinRequests(root, ids) {
  const release = waitLock({ state: personalDirectory() }, `requests-${hash(root)}`);
  try {
    const rows = pendingRequests(root), found = ids.map(id => rows.find(row => row.id === id && row.state === 'queued')).filter(Boolean);
    if (found[0]?.id !== ids[0]) return null;
    const joined = [found[0]]; let goal = found[0].goal;
    for (const row of found.slice(1)) { if (goal.length + row.goal.length + 2 > 16000) break; goal += `\n\n${row.goal}`; joined.push(row); }
    if (joined.length === 1) return found[0];
    const gone = new Set(joined.slice(1).map(row => row.id)), row = { ...found[0], goal };
    atomic(requestFile(root), rows.filter(value => !gone.has(value.id)).map(value => value.id === row.id ? row : value)); return row;
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
    atomic(requestFile(root), rows.map(value => value.id === id ? row : value)); return row;
  } finally { release(); }
}
