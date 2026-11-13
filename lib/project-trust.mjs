import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomic, hash, isObject, mkdir, noSymlinks, personalDirectory, refuse } from './util.mjs';

// A project's settings and instructions come with its folder: from Git, from a teammate, by
// hand, or from a model that edited them. They count as the owner's only when the owner
// approved that exact content on this machine. What was approved, and what was turned down,
// is recorded here by hash in ELU's own folder, which the launch rules keep a session's
// file tools out of: never in the project, which a session edits. Anything else is not used
// and is never sent to a model. The text he approved last is kept with the record and stays
// in force until he approves a change, so changing, removing or replacing a file never drops
// his settings back to the defaults by itself.
export const TRUST_FILES = Object.freeze(['config.yaml', 'instructions.md', 'context.md']);
// How many answers are kept for one file, so moving between branches does not ask again.
const KEEP = 32;
// What the record holds for "the file is not there": approving it is the owner's yes to
// going without the file. It counts only while it is his latest approval: once he approves
// a text again, a file that goes missing is asked about again.
const GONE = '0'.repeat(64);
const wentWithout = row => row.approved.at(-1) === GONE;
// Tests keep ELU's folder in a temporary place. One that reached the owner's own would
// write approvals for its throwaway projects into his record, so it is refused.
function storeFile() {
  if (process.env.NODE_TEST_CONTEXT && !process.env.XDG_CONFIG_HOME) refuse('A test must set XDG_CONFIG_HOME before it uses a project: the record of approved project files is never a test\'s to write.');
  return path.join(personalDirectory(), 'project-trust.json');
}
// A project is known by its real path: the same folder reached through a link is the same
// project, and a copy or a moved folder is a new one.
const keyOf = root => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } };

// The file as it is now, read once: the text a session would use and the hash of its bytes.
// null when there is none. One over the limit is not read: it is known by its size and time,
// so it is asked about once and not again until it changes. A symbolic link on the way is refused.
function current(root, name) {
  const file = path.join(root, '.elu-code', name); noSymlinks(file);
  let bytes;
  try {
    const stat = fs.statSync(file); if (!stat.isFile()) return null;
    bytes = fs.readFileSync(file);
  } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
  return { text: bytes.toString('utf8'), hash: hash(bytes) };
}

// The record is read again only when its file changed. One that cannot be read approves nothing.
let cache = { sig: null, store: null };
function readStore() {
  const file = storeFile(); noSymlinks(file);
  let stat; try { stat = fs.statSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const sig = `${file}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}`;
  if (cache.sig === sig) return cache.store;
  let store; try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { store = null; }
  if (!isObject(store) || !isObject(store.projects)) store = { version: 1, projects: {} };
  cache = { sig, store }; return store;
}
const hashes = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
function entryOf(store, key, name) {
  const project = Object.hasOwn(store.projects, key) && isObject(store.projects[key]) ? store.projects[key] : {};
  const row = Object.hasOwn(project, name) && isObject(project[name]) ? project[name] : {};
  const text = typeof row.text === 'string' ? row.text : null;
  return { approved: hashes(row.approved), declined: hashes(row.declined), text, at: text !== null && typeof row.at === 'string' ? row.at : null };
}
// use: the text approved now is the one in force from here on, with when it was approved.
// Approving that the file is gone ends that. Turning content down changes neither.
function answer(store, root, name, { hash: value, text = null }, use) {
  const key = keyOf(root), row = entryOf(store, key, name), without = list => list.filter(item => item !== value);
  row.approved = without(row.approved); row.declined = without(row.declined);
  (use ? row.approved : row.declined).push(value);
  row.approved = row.approved.slice(-KEEP); row.declined = row.declined.slice(-KEEP);
  if (use) { row.text = value !== GONE && typeof text === 'string' ? text : null; row.at = row.text === null ? null : new Date().toISOString(); }
  if (!Object.hasOwn(store.projects, key) || !isObject(store.projects[key])) store.projects[key] = {};
  store.projects[key][name] = row.text === null ? { approved: row.approved, declined: row.declined } : row;
}
function listedProjects() {
  try {
    const file = path.join(personalDirectory(), 'projects.json'); noSymlinks(file);
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(rows) ? rows.map(row => row?.root).filter(root => typeof root === 'string') : [];
  } catch { return []; }
}
// The first start with no record yet takes the projects already in the owner's list as
// approved, as they stand, once. A project added later gets no such pass: adding one makes
// the record first, from the list as it was (registerProject). The record is written whole
// beside its place and linked in, so of two first starts one record wins and both read it.
// That pass is given once: a mark beside the record says it was used. A record that goes
// missing after that is made again empty, so every file is asked about and the loss
// approves nothing.
function loadStore() {
  const saved = readStore(); if (saved) return saved;
  const store = { version: 1, projects: {} }, file = storeFile(), mark = path.join(path.dirname(file), 'project-trust.once'); noSymlinks(mark);
  if (!fs.existsSync(mark)) for (const root of listedProjects()) for (const name of TRUST_FILES) {
    let now = null; try { now = current(root, name); } catch { /* A file that cannot be read is asked about later. */ }
    if (now) answer(store, root, name, now, true);
  }
  const part = `${file}.${crypto.randomUUID()}.tmp`; mkdir(path.dirname(file));
  fs.writeFileSync(part, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { fs.linkSync(part, file); } catch (error) { if (error.code !== 'EEXIST') throw error; } finally { fs.unlinkSync(part); }
  try { fs.writeFileSync(mark, '', { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return readStore();
}
export function ensureTrustStore() { loadStore(); }

// What is in force for one file. Its text as it stands, when the owner approved exactly that
// content. Otherwise the text he approved last: a file that changed, that he turned down
// or that is gone changes nothing until he approves the change. null
// when he never approved any text, or approved going without the file.
function inForce(store, root, name) {
  const now = current(root, name), row = entryOf(store, keyOf(root), name);
  if (now && row.approved.includes(now.hash)) return { text: now.text, asItStands: true };
  if (!now && wentWithout(row)) return null;
  return row.text === null ? null : { text: row.text, asItStands: false };
}
// Every one of the project's files there is something to say about, with what the owner said
// about it as it stands: approved, declined, new (never asked about this file) or changed
// (asked before, about other content). A file that is gone is listed while a text he
// approved is in force in its place (gone). A file of any size is asked about and used.
// before and at: the text in force in its place and when he approved it; null when nothing is.
export function trustRows(root) {
  const store = loadStore(), key = keyOf(root);
  return TRUST_FILES.flatMap(name => {
    let now; try { now = current(root, name); } catch { return []; }
    const row = entryOf(store, key, name);
    if (!now) { if (row.text === null || wentWithout(row)) return []; now = { gone: true, hash: GONE, text: null }; }
    const state = !now.gone && row.approved.includes(now.hash) ? 'approved' : row.declined.includes(now.hash) ? 'declined' : row.approved.length || row.declined.length ? 'changed' : 'new';
    const kept = state !== 'approved' && row.text !== null;
    return [{ name, state, hash: now.hash, text: now.text, before: kept ? row.text : null, at: kept ? row.at : null, ...(now.gone ? { gone: true } : {}) }];
  });
}
// The files waiting for an answer, and all the files that are not in use as they stand.
export const pendingTrust = root => trustRows(root).filter(row => row.state === 'new' || row.state === 'changed');
export const unusedTrust = root => trustRows(root).filter(row => row.state !== 'approved');
const known = name => { if (!TRUST_FILES.includes(name)) refuse('That is not a project file ELU reads.'); };
// The text in force for this file, else null: the file's own when the owner approved exactly
// that content on this machine, otherwise the text he approved last. For the file as it
// stands, the text returned is the text that was hashed, so what is used is what was approved.
export function trustedText(root, name) { known(name); return inForce(loadStore(), root, name)?.text ?? null; }
// Whether the file as it stands is the owner's approved text: only then is it his to remove.
export function approvedAsItStands(root, name) { known(name); return inForce(loadStore(), root, name)?.asItStands === true; }
// Records the owner's answer for the content he was shown (row, from trustRows), whatever
// the file holds by now: a file changed since then is asked about again. Only text that can
// be reviewed is ever approved, whoever asks.
export function answerTrust(root, row, use) {
  if (!TRUST_FILES.includes(row?.name) || !/^[a-f0-9]{64}$/.test(row.hash ?? '')) refuse('That is not a project file ELU reads.');
  if (use === true && row.hash !== GONE && typeof row.text !== 'string') refuse('That file has no text to approve.');
  const store = structuredClone(loadStore()); answer(store, root, row.name, row, use === true);
  atomic(storeFile(), store);
}
// What ELU itself writes on the owner's action is approved by that save. Call it
// before the write, so no session starts in between and finds the new file unapproved.
export function approveSaved(root, name, text) { answerTrust(root, { name, hash: hash(text), text }, true); }
// The owner cleared the text, or took the file out, through ELU: he goes without it and
// nothing stays in force.
export function approveRemoved(root, name) { answerTrust(root, { name, hash: GONE }, true); }

const day = at => Number.isFinite(Date.parse(at ?? '')) ? new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
// " on Nov 10, 2026", or nothing when the record holds no date.
export const approvedOn = at => day(at) ? ` on ${day(at)}` : '';
const WHY = { gone: ['is gone', 'are gone'], changed: ['has changed since', 'have changed since'] };
// What a session is told when some of these files are not in use as they stand: which it
// ran without, and which it ran on as approved earlier. key changes with their content.
export function unapprovedNote(root) {
  const rows = unusedTrust(root); if (!rows.length) return null;
  const list = files => { const names = files.map(row => `.elu-code/${row.name}`); return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]; };
  const without = rows.filter(row => row.before === null), many = without.length > 1, said = [], kept = new Map();
  if (without.length) said.push(`Running without this project's ${list(without)}: you have not approved ${many ? 'them' : 'it'} on this machine.`);
  // Files approved on the same day and set aside for the same reason share a sentence.
  for (const row of rows.filter(row => row.before !== null)) { const key = `${approvedOn(row.at)}\0${row.gone ? 'gone' : 'changed'}`; kept.set(key, [...(kept.get(key) ?? []), row]); }
  for (const [key, files] of kept) { const [on, why] = key.split('\0'); said.push(`Running on the ${list(files)} you approved${on}: the file${files.length > 1 ? 's' : ''} ${WHY[why][files.length > 1 ? 1 : 0]}.`); }
  return { key: hash(JSON.stringify(rows.map(row => [row.name, row.hash]))), text: `${said.join(' ')} To review ${rows.length > 1 ? 'them' : 'it'}, open Projects and choose this project.` };
}
export const NOT_APPROVED = "This project's settings (.elu-code/config.yaml) are not approved on this machine. Open ELU in this folder, answer its question about them, then run this again.";

// What the owner is shown before he answers. Nothing in the file is hidden: a character that
// would not show, or would move the text around, is written out as its code.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u115f\u1160\u2800\u3164\uffa0]/gu;
const shown = line => line.replace(/\t/g, '    ').replace(HIDDEN, ch => `<U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
const linesOf = text => { const lines = text.replace(/\r\n/g, '\n').split('\n'); if (lines.at(-1) === '') lines.pop(); return lines; };
// A long run of empty lines is named, so padding cannot push text out of sight.
function wholeText(text) {
  const out = []; let blank = 0;
  const flush = () => { if (blank > 2) out.push(`(${blank} empty lines)`); else for (let i = 0; i < blank; i++) out.push(''); blank = 0; };
  for (const line of linesOf(text).map(shown)) { if (line.trim()) { flush(); out.push(line); } else blank += 1; }
  flush();
  return out.length ? out : ['(the file is empty)'];
}
// The lines that differ between two texts: "- " was removed, "+ " is new, "…" stands for
// lines that stayed. null when the texts are too long to compare.
function changedLines(before, after) {
  const a = linesOf(before), b = linesOf(after), m = a.length, n = b.length;
  if (m * n > 1_000_000) return null;
  const table = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out = []; let i = 0, j = 0, kept = false;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) { i += 1; j += 1; kept = out.length > 0; continue; }
    if (kept) { out.push('…'); kept = false; }
    if (i < m && (j === n || table[i + 1][j] >= table[i][j + 1])) out.push(`- ${shown(a[i++])}`); else out.push(`+ ${shown(b[j++])}`);
  }
  // A long run of empty lines that came or went is named, like in a whole text.
  const brief = [], empty = line => /^[+-]\s*$/.test(line);
  for (let at = 0; at < out.length;) {
    let end = at; while (end < out.length && empty(out[end]) && out[end][0] === out[at][0]) end += 1;
    if (end - at > 2) { brief.push(`${out[at][0]} (${end - at} empty lines)`); at = end; } else brief.push(out[at++]);
  }
  return brief;
}
// One line for a text that would take very many pages to step through: how long it is, and
// where to read all of it. The choice is then offered at once (reviewProjectFiles in lib/terminal.mjs).
export function longNote(row) {
  const text = (row.gone ? row.before : row.text) ?? '', lines = linesOf(text).length.toLocaleString('en-US'), bytes = Buffer.byteLength(text);
  const size = bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
  return row.gone ? `The text you approved is long: ${lines} lines (${size}).` : `This file is long: ${lines} lines (${size}). Open .elu-code/${row.name} to read all of it.`;
}
const KIND = { 'config.yaml': 'settings', 'instructions.md': 'instructions', 'context.md': 'notes' };
const USE = { 'config.yaml': 'They set the model, the commands the model may run, and the checks ELU runs.', 'instructions.md': 'The model follows them as yours.', 'context.md': 'The model reads them.' };
// row: one of trustRows. The first line says what the file is and why he is asked. While a
// text he approved is in force in the file's place, it says so: the change waits for him.
export function reviewLines(row) {
  const kind = KIND[row.name], use = USE[row.name], kept = typeof row.before === 'string', on = approvedOn(row.at);
  const version = `The version you approved${on} stays in use until you choose otherwise.`;
  if (row.gone) return [`This project's ${kind} file is gone. ${version} It reads:`, '', ...wholeText(row.before)];
  if (!kept) {
    if (row.state === 'declined') return [`You chose not to use this project's ${kind}. ${use} The file reads:`, '', ...wholeText(row.text)];
    if (row.state !== 'changed') return [`This project came with ${kind}. ${use} They are used only if you say so.`, '', ...wholeText(row.text)];
    return [`This project's ${kind} changed. ${use} The file now reads:`, '', ...wholeText(row.text)];
  }
  const lines = changedLines(row.before, row.text);
  const first = row.state === 'declined' ? `You kept the ${kind} you approved${on}. The file in the folder is different.` : `This project's ${kind} changed since you approved them${on}. The approved version stays in use until you choose otherwise.`;
  if (lines?.length) return [`${first} Lines with - were removed and lines with + are new.`, '', ...lines];
  return [`${first} The file now reads:`, '', ...wholeText(row.text)];
}
