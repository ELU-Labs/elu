import fs from 'node:fs';
import { atomic, noSymlinks, readJson, isObject } from '../util.mjs';
import { tasks } from '../state.mjs';
import { sessionFiles } from '../session-work.mjs';
import { registeredProjects } from '../projects.mjs';
import { ABOUT_MAX, BOT_NAME, botOfKey, sharedBots } from '../bots.mjs';
import { peerFile } from './paths.mjs';
import { sanitize } from './peerdata.mjs';
import { BOX, peerBox } from './settings.mjs';
import { shares } from './shares.mjs';

// Status rows (docs/peer-network.md, "Status"): one per live editing task in
// a project shared with status on. Overlap is computed here, never asked for.
const LIVE = ['preparing', 'running', 'ready', 'needs_input'];
const HEX64 = /^[0-9a-f]{64}$/;
const HANDLE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FILES_MAX = 200, ROWS_MAX = 50;
const firstLine = (value, max) => sanitize(String(value ?? '').split('\n')[0], max).trim();
// The files a session itself changed (lib/session-work.mjs), as the Changes view counts them.
const changedFiles = task => sessionFiles(task).slice(0, FILES_MAX);
// Who is at work, as a teammate reads it. A bot the owner shares is @name; any other bot is
// only "bot", since teammates are not told its name.
const working = (role, shared) => { const bot = botOfKey(role); return bot === null ? role : shared.has(bot) ? `@${bot}` : 'bot'; };
export function statusRows() {
  const repos = registeredProjects(), rows = [];
  let shared = new Set(); try { shared = new Set(sharedBots().map(bot => bot.name)); } catch { /* An unreadable bots file shares nothing. */ }
  for (const share of shares().filter(row => row.status && row.repoId)) {
    const repo = repos.find(row => row.root === share.root); if (!repo) continue;
    let values = []; try { values = tasks(repo); } catch { continue; }
    for (const task of values.filter(task => task.kind !== 'conversation' && LIVE.includes(task.state))) {
      if (rows.length >= ROWS_MAX) return rows;
      let files = []; try { files = changedFiles(task); } catch { files = []; }
      rows.push({ repoId: share.repoId, handle: share.handle, taskId: task.id, label: firstLine(task.goal, 80), now: firstLine(task.activeRole ? `${task.state} · ${working(task.activeRole, shared)}` : task.state, 80), files });
    }
  }
  return rows;
}
const plainFile = value => typeof value === 'string' && value.length <= 512 && !value.startsWith('/') && !/[\x00-\x1f\x7f\\]/.test(value) && !value.split('/').some(part => part === '..' || part === '.' || !part);
// Rows from another machine: anything malformed is dropped, text is sanitized.
export function cleanRows(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, ROWS_MAX).flatMap(row => {
    if (!isObject(row) || !HEX64.test(row.repoId ?? '') || !HANDLE.test(row.handle ?? '') || !/^[1-9][0-9]{0,9}$/.test(String(row.taskId ?? '')) || !Array.isArray(row.files)) return [];
    return [{ repoId: row.repoId, handle: row.handle, taskId: String(row.taskId), label: firstLine(row.label, 80), now: firstLine(row.now, 80), files: row.files.filter(plainFile).slice(0, FILES_MAX) }];
  });
}
export function saveRemoteStatus(key, rows) {
  if (!HEX64.test(key)) return;
  atomic(peerFile('status', `${key}.json`), { at: new Date().toISOString(), rows: cleanRows(rows) });
}
export function remoteStatus(key) {
  try { const file = peerFile('status', `${key}.json`); noSymlinks(file); if (!HEX64.test(key) || !fs.existsSync(file)) return null; const value = readJson(file); return { at: value.at, rows: cleanRows(value.rows) }; } catch { return null; }
}
// elu.status also says what the machine is called (box) and which bots its owner lets
// teammates use (bots: [{name, about}], at most BOTS_TOLD). A build from before bots reads
// only the rows and sends neither, which reads here as no box name and no bots.
export const BOTS_TOLD = 20;
// From another machine each field stands alone: a box name that is not one is null, a bot
// with a bad name or an about that is not text is dropped, an about is cut to one plain line.
export const cleanBox = value => typeof value === 'string' && BOX.test(value) ? value : null;
export function cleanBots(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, BOTS_TOLD).flatMap(bot => {
    if (!isObject(bot) || typeof bot.name !== 'string' || !BOT_NAME.test(bot.name) || typeof bot.about !== 'string' || seen.has(bot.name)) return [];
    seen.add(bot.name);
    return [{ name: bot.name, about: sanitize(bot.about, 2000).replace(/\s+/g, ' ').trim().slice(0, ABOUT_MAX).trimEnd() }];
  });
}
// This machine as teammates are told of it. A bots file that cannot be read shares none.
export function thisMachine() {
  let bots = []; try { bots = sharedBots(); } catch { /* Nothing is shared until the file is fixed. */ }
  return { box: peerBox(), bots: cleanBots(bots) };
}
// Each teammate row gains overlap: files it shares with my live rows of the same repoId.
export function overlaps(mine, theirs) {
  return theirs.map(row => {
    const local = new Set(mine.filter(m => m.repoId === row.repoId).flatMap(m => m.files));
    return { ...row, overlap: row.files.filter(file => local.has(file)) };
  });
}
