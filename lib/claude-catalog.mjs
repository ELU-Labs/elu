// The effort each Claude model runs with when Claude Code is given no --effort, and the efforts
// it takes, as the model catalog bundled in the installed Claude Code says them. The catalog is
// source text inside the program (a native build carries its JavaScript; an npm install is
// cli.js), one row a model:
//   {id:"claude-opus-5-5",family:"opus",…,context:{…},capabilities:[…],default_effort:"medium",…}
// The efforts a model takes are in its capabilities: "effort" for low, medium and high, and
// "xhigh_effort" and "max_effort" for the two above them (2.1.330).
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
const KEY = /\s*"?([A-Za-z_$][\w$]*)"?\s*:\s*/y, TEXT = /"([^"\\\n]{0,80})"/y, ITEM = /\s*"([^"\\\n]{0,80})"\s*([,\]])/y;
// The capability that brings each effort, lowest effort first.
const CAPABILITY_LEVELS = Object.freeze([['effort', ['low', 'medium', 'high']], ['xhigh_effort', ['xhigh']], ['max_effort', ['max']]]);
// The efforts a row's capabilities give: none when it has no "effort", and null when the row
// lists no capabilities, so nothing is known of it.
export function capabilityLevels(capabilities) {
  if (!Array.isArray(capabilities)) return null;
  if (!capabilities.includes('effort')) return [];
  return CAPABILITY_LEVELS.flatMap(([name, levels]) => capabilities.includes(name) ? levels : []);
}
// A list of texts that starts at `at` ([ "a", "b" ]): { items, end } with end the index after
// its ], or null when it is anything else, such as a list that holds something not a text.
function textList(text, at) {
  if (text[at] !== '[') return null;
  const items = []; let i = at + 1;
  if (/^\s*\]/.test(text.slice(i, i + 64))) return { items, end: text.indexOf(']', i) + 1 };
  for (;;) {
    ITEM.lastIndex = i; const item = ITEM.exec(text); if (!item) return null;
    items.push(item[1]); i = ITEM.lastIndex;
    if (item[2] === ']') return { items, end: i };
    if (items.length > 100) return null;
  }
}

// Where a quoted text that starts at `at` ends (the index after its closing quote), or -1.
function pastText(text, at, end) {
  const quote = text[at];
  for (let i = at + 1; i < end; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i + 1;
  }
  return -1;
}
// The id, default_effort and efforts (capabilityLevels) of the row whose { is at `at`: only keys
// of the row itself count, never one inside a nested object. null when the row is not a whole,
// well-formed one.
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
        } else if (key[1] === 'capabilities') {
          // A list it cannot read leaves the row's efforts unknown; the scan goes on into it.
          const list = textList(text, i);
          if (list) { if (Object.hasOwn(fields, 'capabilities')) return null; fields.capabilities = list.items; i = list.end; }
        }
        continue;
      }
    }
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { i = pastText(text, i, end); if (i < 0) return null; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; if (depth === 1) expectKey = true; }
    else if (c === '}' || c === ']' || c === ')') {
      depth--; if (depth < 0) return null;
      if (depth === 0) return c === '}' && typeof fields.id === 'string' ? { id: fields.id, effort: fields.default_effort ?? null, levels: capabilityLevels(fields.capabilities) } : null;
    } else if (c === ',' && depth === 1) expectKey = true;
    i++;
  }
  return null;
}
// Adds what one row says to found. An id given two different efforts is known by neither, and
// so is one given two different lists of the efforts it takes.
const sameLevels = (a, b) => a.length === b.length && a.every((level, index) => level === b[index]);
function take(found, row) {
  if (!row || !ID.test(row.id)) return;
  const effort = row.effort == null ? null : row.effort.trim().toLowerCase();
  if (effort && LEVELS.has(effort)) {
    if (!Object.hasOwn(found.efforts, row.id)) { if (Object.keys(found.efforts).length < MAX_MODELS) found.efforts[row.id] = effort; }
    else if (found.efforts[row.id] !== effort) found.efforts[row.id] = null;
  }
  if (Array.isArray(row.levels)) {
    if (!Object.hasOwn(found.levels, row.id)) { if (Object.keys(found.levels).length < MAX_MODELS) found.levels[row.id] = row.levels; }
    else if (found.levels[row.id] && !sameLevels(found.levels[row.id], row.levels)) found.levels[row.id] = null;
  }
}
const settled = found => Object.fromEntries(Object.entries(found).filter(([, value]) => value));
const newFound = () => ({ efforts: {}, levels: {} });
// Every row in one piece of text, read as bytes; only rows that start before `limit` count.
function scan(buffer, limit, found) {
  for (const start of STARTS) {
    for (let at = buffer.indexOf(start); at >= 0 && at < limit; at = buffer.indexOf(start, at + 1)) take(found, catalogRow(buffer.toString('latin1', at, Math.min(buffer.length, at + ROW))));
  }
}
// { efforts: { model id: effort }, levels: { model id: [efforts it takes] } } from a program's
// text (a string or bytes). Both {} when it holds no catalog.
export function catalogOf(source) {
  const buffer = Buffer.isBuffer(source) ? source : Buffer.from(String(source ?? ''), 'latin1'), found = newFound();
  scan(buffer, buffer.length, found); return { efforts: settled(found.efforts), levels: settled(found.levels) };
}
// { model id: effort } from a program's text. {} when it holds no catalog.
export const catalogEfforts = source => catalogOf(source).efforts;
// The same, read from a file a piece at a time, so a program of hundreds of MB is never held
// whole. Each piece runs one row's length into the next, so a row across a seam is read once.
export function fileCatalog(file) {
  const fd = fs.openSync(file, 'r'), found = newFound();
  try {
    const size = fs.fstatSync(fd).size; if (size > MAX_FILE) return { efforts: {}, levels: {} };
    const buffer = Buffer.alloc(Math.min(size, CHUNK + ROW));
    for (let offset = 0; offset < size; offset += CHUNK) {
      const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      scan(buffer.subarray(0, length), offset + CHUNK >= size ? length : Math.min(length, CHUNK), found);
    }
  } finally { fs.closeSync(fd); }
  return { efforts: settled(found.efforts), levels: settled(found.levels) };
}
export const fileEfforts = file => fileCatalog(file).efforts;

export const catalogFile = () => path.join(personalDirectory(), 'claude-catalog.json');
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = value => Object.fromEntries(Object.entries(object(value)).filter(([id, effort]) => ID.test(id) && LEVELS.has(effort)).slice(0, MAX_MODELS));
const cleanLevels = value => Object.fromEntries(Object.entries(object(value)).filter(([id, levels]) => ID.test(id) && Array.isArray(levels) && levels.length <= LEVELS.size && levels.every(level => LEVELS.has(level))).slice(0, MAX_MODELS));
function savedRows(file) {
  try { const value = readJson(file); return Array.isArray(value?.programs) ? value.programs.filter(row => typeof row?.file === 'string' && Number.isFinite(row.size) && Number.isFinite(row.mtimeMs)) : []; } catch { return []; }
}
const memory = new Map(), NOTHING = Object.freeze({ efforts: {}, levels: {} });
// { efforts, levels } (catalogOf) for the Claude Code program at bin, as its own catalog says.
// Both {} when the file cannot be read or holds no catalog. Never throws. A reading kept by a
// build that did not read the efforts each model takes has no levels: until Claude Code
// changes, its models take every effort Claude Code does (modelEfforts in lib/bot-models.mjs).
function installedCatalog(bin, { cache = catalogFile() } = {}) {
  let file, stat;
  try { file = fs.realpathSync(bin); stat = fs.statSync(file); if (!stat.isFile()) return NOTHING; } catch { return NOTHING; }
  const key = `${file}\0${stat.size}\0${stat.mtimeMs}`, same = row => row.file === file && row.size === stat.size && row.mtimeMs === stat.mtimeMs;
  if (memory.has(key)) return memory.get(key);
  const rows = cache ? savedRows(cache) : [], saved = rows.find(same);
  if (saved) { const kept = { efforts: clean(saved.efforts), levels: cleanLevels(saved.levels) }; memory.set(key, kept); return kept; }
  let read; try { read = fileCatalog(file); } catch { return NOTHING; }
  memory.set(key, read);
  if (cache) {
    const programs = [...rows.filter(row => row.file !== file), { file, size: stat.size, mtimeMs: stat.mtimeMs, efforts: read.efforts, levels: read.levels }].slice(-KEPT);
    try { atomic(cache, { version: 1, programs }); } catch { /* The next app start reads the program again. */ }
  }
  return read;
}
// { model id: effort } for the Claude Code program at bin: the effort each model runs with when
// it is given none.
export const installedEfforts = (bin, options) => installedCatalog(bin, options).efforts;
// { model id: [efforts it takes] } for the Claude Code program at bin. A model its catalog lists
// with no capabilities is not in it.
export const installedLevels = (bin, options) => installedCatalog(bin, options).levels;
// Forgets what was read in this process, for tests.
export const forgetCatalogs = () => memory.clear();
