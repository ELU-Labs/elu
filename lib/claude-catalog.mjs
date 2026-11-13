// The effort each Claude model runs with when Claude Code is given no --effort, as the model
// catalog bundled in the installed Claude Code says it. The catalog is source text inside the
// program (a native build carries its JavaScript; an npm install is cli.js), one row a model:
//   {id:"claude-opus-5-5",family:"opus",…,context:{…},capabilities:[…],default_effort:"medium",…}
// The program is only read, never run, and nothing here uses the network. What a file gives is
// kept in memory and in claude-catalog.json in the personal folder, by the file's path, size
// and modification time, so a new release is read once. A file with no catalog gives {}.
import fs from 'node:fs';
import path from 'node:path';
import { atomic, personalDirectory, readJson } from './util.mjs';

const LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const ID = /^claude-[a-z0-9]+(?:-[a-z0-9]+){0,8}$/;
// A row starts where its id is the first key, written as JavaScript or as JSON.
const STARTS = [Buffer.from('{id:"claude-'), Buffer.from('{"id":"claude-')];
// A row is read for this many bytes at most; one that has not closed by then is not a row.
const ROW = 64 * 1024, CHUNK = 8 * 1024 * 1024, MAX_FILE = 2 * 1024 * 1024 * 1024, MAX_MODELS = 200, KEPT = 8;
const KEY = /\s*"?([A-Za-z_$][\w$]*)"?\s*:\s*/y, TEXT = /"([^"\\\n]{0,80})"/y;

// Where a quoted text that starts at `at` ends (the index after its closing quote), or -1.
function pastText(text, at, end) {
  const quote = text[at];
  for (let i = at + 1; i < end; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i + 1;
  }
  return -1;
}
// The id and default_effort of the row whose { is at `at`: only keys of the row itself count,
// never one inside a nested object. null when the row is not a whole, well-formed one.
export function catalogRow(text, at = 0) {
  if (text[at] !== '{') return null;
  const end = Math.min(text.length, at + ROW), fields = {};
  let depth = 0, expectKey = false;
  for (let i = at; i < end;) {
    if (depth === 1 && expectKey) {
      expectKey = false; KEY.lastIndex = i; const key = KEY.exec(text);
      if (key) {
        i = KEY.lastIndex;
        if (key[1] === 'id' || key[1] === 'default_effort') {
          TEXT.lastIndex = i; const value = TEXT.exec(text);
          if (!value) return null;
          if (Object.hasOwn(fields, key[1])) return null;
          fields[key[1]] = value[1]; i = TEXT.lastIndex;
        }
        continue;
      }
    }
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { i = pastText(text, i, end); if (i < 0) return null; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; if (depth === 1) expectKey = true; }
    else if (c === '}' || c === ']' || c === ')') {
      depth--; if (depth < 0) return null;
      if (depth === 0) return c === '}' && typeof fields.id === 'string' ? { id: fields.id, effort: fields.default_effort ?? null } : null;
    } else if (c === ',' && depth === 1) expectKey = true;
    i++;
  }
  return null;
}
// Adds what one row says to found. An id given two different efforts is known by neither.
function take(found, row) {
  if (!row || !ID.test(row.id) || row.effort == null) return;
  const effort = row.effort.trim().toLowerCase(); if (!LEVELS.has(effort)) return;
  if (!Object.hasOwn(found, row.id)) { if (Object.keys(found).length < MAX_MODELS) found[row.id] = effort; }
  else if (found[row.id] !== effort) found[row.id] = null;
}
const settled = found => Object.fromEntries(Object.entries(found).filter(([, effort]) => effort));
// Every row in one piece of text, read as bytes; only rows that start before `limit` count.
function scan(buffer, limit, found) {
  for (const start of STARTS) {
    for (let at = buffer.indexOf(start); at >= 0 && at < limit; at = buffer.indexOf(start, at + 1)) take(found, catalogRow(buffer.toString('latin1', at, Math.min(buffer.length, at + ROW))));
  }
}
// { model id: effort } from a program's text (a string or bytes). {} when it holds no catalog.
export function catalogEfforts(source) {
  const buffer = Buffer.isBuffer(source) ? source : Buffer.from(String(source ?? ''), 'latin1'), found = {};
  scan(buffer, buffer.length, found); return settled(found);
}
// The same, read from a file a piece at a time, so a program of hundreds of MB is never held
// whole. Each piece runs one row's length into the next, so a row across a seam is read once.
export function fileEfforts(file) {
  const fd = fs.openSync(file, 'r'), found = {};
  try {
    const size = fs.fstatSync(fd).size; if (size > MAX_FILE) return {};
    const buffer = Buffer.alloc(Math.min(size, CHUNK + ROW));
    for (let offset = 0; offset < size; offset += CHUNK) {
      const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      scan(buffer.subarray(0, length), offset + CHUNK >= size ? length : Math.min(length, CHUNK), found);
    }
  } finally { fs.closeSync(fd); }
  return settled(found);
}

export const catalogFile = () => path.join(personalDirectory(), 'claude-catalog.json');
const clean = value => Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).filter(([id, effort]) => ID.test(id) && LEVELS.has(effort)).slice(0, MAX_MODELS));
function savedRows(file) {
  try { const value = readJson(file); return Array.isArray(value?.programs) ? value.programs.filter(row => typeof row?.file === 'string' && Number.isFinite(row.size) && Number.isFinite(row.mtimeMs)) : []; } catch { return []; }
}
const memory = new Map();
// { model id: effort } for the Claude Code program at bin, as its own catalog says. {} when the
// file cannot be read or holds no catalog. Never throws.
export function installedEfforts(bin, { cache = catalogFile() } = {}) {
  let file, stat;
  try { file = fs.realpathSync(bin); stat = fs.statSync(file); if (!stat.isFile()) return {}; } catch { return {}; }
  const key = `${file}\0${stat.size}\0${stat.mtimeMs}`, same = row => row.file === file && row.size === stat.size && row.mtimeMs === stat.mtimeMs;
  if (memory.has(key)) return memory.get(key);
  const rows = cache ? savedRows(cache) : [], saved = rows.find(same);
  if (saved) { const efforts = clean(saved.efforts); memory.set(key, efforts); return efforts; }
  let efforts; try { efforts = fileEfforts(file); } catch { return {}; }
  memory.set(key, efforts);
  if (cache) {
    const programs = [...rows.filter(row => row.file !== file), { file, size: stat.size, mtimeMs: stat.mtimeMs, efforts }].slice(-KEPT);
    try { atomic(cache, { version: 1, programs }); } catch { /* The next app start reads the program again. */ }
  }
  return efforts;
}
// Forgets what was read in this process, for tests.
export const forgetCatalogs = () => memory.clear();
