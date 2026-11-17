import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { atomic, isObject, mkdir, noSymlinks, personalDirectory, readJson, refuse, tempFolder } from './util.mjs';
import { readTask, taskDir, waitLock } from './state.mjs';

// A session's artifacts: what the owner asked to see as its work goes, such as an eval's
// scores against their target. They are part of its Task (lib/plan.mjs): each one a short
// title, what it shows, and how often it refreshes, or not at all. The model writes them into
// the Task when he says in the chat what he wants to see, so they go through the same approval
// as the goal, and every turn is given them with the Task. The model fills them and never draws
// them: it sends data with elu artifacts set (lib/session-commands.mjs), in a small fixed set of
// kinds (score, bars, trend, chart, table and note), and ELU draws them on the session's Artifacts
// tab (lib/terminal-artifacts.mjs). Every update is kept, so a trend builds; one equal to the last
// adds nothing. An artifact with an interval gets a refresh script, written once by the model
// and kept with the session's records, never in the repository: ELU runs it on that interval
// with no model turn, in the sandbox the project's checks run in, and draws what it prints
// (runRefresh). It is not a schedule: no turn starts and nothing shows as a schedule.

// No number of ours limits how many artifacts, blocks, rows, bars, columns or points there are,
// or how long a label or a note is: what does not fit the tab scrolls. One update's size (data)
// and plain text are what the data needs to be safe.
export const ARTIFACT_LIMITS = Object.freeze({ title: 60, shows: 300, data: 16000, kept: 60, script: 8000, seconds: 60, minutes: 10080 });
export const KINDS = Object.freeze(['score', 'bars', 'trend', 'chart', 'table', 'note']);
const BETTER = ['higher', 'lower'];
// Control characters, and the marks that reorder or hide text on a screen (as lib/plan.mjs).
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;

// The artifacts of a Task as the model or the owner wrote them: [{ title, shows, every }],
// every in minutes or null. A Task from before artifacts has none.
export const artifactKey = title => String(title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
export function everyText(every) {
  if (!Number.isInteger(every) || every < 1) return 'no refresh';
  if (every % 1440 === 0) return `every ${every / 1440} d`;
  if (every % 60 === 0) return `every ${every / 60} h`;
  return `every ${every} min`;
}
const line = (value, max, label) => {
  if (typeof value !== 'string') refuse(`Each artifact needs ${label}.`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) refuse(`Each artifact needs ${label}.`);
  if (CONTROL.test(text)) refuse(`An artifact's text holds control characters. Write ${label} as plain text.`);
  if (text.length > max) refuse(`Write each artifact's ${label} in at most ${max} characters.`);
  return text;
};
// owner: his own words (a new goal's Artifact: lines), which no length of ours limits but the title's.
export function checkArtifacts(value, { owner = false } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) refuse('artifacts is a list of { title, shows, everyMinutes }.');
  const rows = value.map(row => {
    if (!isObject(row)) refuse('Each artifact is { title, shows, everyMinutes }.');
    const every = row.everyMinutes ?? row.every ?? null;
    if (every !== null && !(Number.isInteger(every) && every >= 1 && every <= ARTIFACT_LIMITS.minutes)) refuse(`An artifact refreshes every 1 to ${ARTIFACT_LIMITS.minutes} minutes, or everyMinutes is null.`);
    return { title: line(row.title, ARTIFACT_LIMITS.title, 'a title of one line'), shows: line(row.shows, owner ? Infinity : ARTIFACT_LIMITS.shows, 'what it shows'), every };
  });
  if (new Set(rows.map(row => artifactKey(row.title))).size !== rows.length) refuse('Give each artifact a title of its own.');
  return rows;
}
// The artifacts a Task has, read as kept: a row that does not read is left out.
export function taskArtifacts(task) {
  if (!Array.isArray(task?.artifacts)) return [];
  return task.artifacts.flatMap(row => isObject(row) && typeof row.title === 'string' && row.title.trim() ? [{ title: row.title, shows: typeof row.shows === 'string' ? row.shows : '', every: Number.isInteger(row.every) && row.every >= 1 ? row.every : null }] : []);
}
// A new goal's line that names an artifact, as the owner types it in the Task's New goal and
// elu sessions goal: Artifact: <title> · <what it shows> · every 10 min. "Artifact: none" removes
// them all. null for a line that is no artifact. known: the Task's artifacts now. A line the New
// goal box wrote for one of them (artifactText) is that one; else a title of one of them that
// starts the line is its title, whatever it holds, and any other title ends at the first ·, colon
// or dash. The interval is the line's last part (every 10 min, no refresh); with none there,
// every N min (s, h, d) anywhere in it.
const ARTIFACT_LINE = /^\s*artifacts?\s*:\s*/i;
export const artifactLine = text => ARTIFACT_LINE.test(String(text ?? ''));
const EVERY = '(?:refresh(?:ed|es)?\\s+)?every\\s+(\\d+)\\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\\b\\.?';
const LAST_EVERY = new RegExp(`(?:(?:^|\\s*[·,;—-]\\s*|\\s+)${EVERY}|(?:^|\\s*[·,;—-]\\s*)no\\s+refresh\\.?)\\s*$`, 'i'), ANY_EVERY = new RegExp(`[·,;-]?\\s*\\b${EVERY}`, 'i');
const minutesOf = (count, unit) => { const n = Number(count), u = unit[0].toLowerCase(); return Math.min(ARTIFACT_LIMITS.minutes, Math.max(1, Math.ceil(u === 's' ? n / 60 : u === 'h' ? n * 60 : u === 'd' ? n * 1440 : n))); };
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export function readArtifactLine(text, known = []) {
  const rest = oneLine(String(text ?? '').replace(ARTIFACT_LINE, ''));
  if (!rest || /^none\.?$/i.test(rest)) return { none: true };
  const rows = Array.isArray(known) ? known.filter(row => row && typeof row.title === 'string' && row.title.trim()) : [];
  const same = rows.find(row => oneLine(artifactText(row).replace(ARTIFACT_LINE, '')) === rest);
  if (same) return { title: same.title, shows: same.shows || same.title, every: Number.isInteger(same.every) && same.every >= 1 ? same.every : null };
  let every = null, without = rest;
  const last = LAST_EVERY.exec(rest);
  if (last) { every = last[1] ? minutesOf(last[1], last[2]) : null; without = rest.slice(0, last.index); }
  else without = rest.replace(ANY_EVERY, (_, count, unit) => { every = minutesOf(count, unit); return ' '; });
  without = without.replace(/\s*[·,;]\s*$/, '').trim();
  const lower = without.toLowerCase(), title = rows.map(row => oneLine(row.title)).sort((a, b) => b.length - a.length).find(name => lower === name.toLowerCase() || lower.startsWith(name.toLowerCase()) && /^\s*(?:·|:|—)\s/.test(`${without.slice(name.length)} `));
  const at = title ? title.length : without.search(/\s·\s|:\s|\s—\s/), named = (at < 0 ? without : without.slice(0, at)).trim(), shows = (at < 0 ? '' : without.slice(at).replace(/^\s*(?:·|:|—)\s*/, '')).trim();
  return { title: named.slice(0, ARTIFACT_LIMITS.title), shows: shows || named, every };
}
// How a new goal's text shows an artifact, for the owner to change: the line readArtifactLine
// reads back. One whose title or what it shows names an interval says it has none.
export const artifactText = row => `Artifact: ${row.title}${row.shows && row.shows !== row.title ? ` · ${row.shows}` : ''}${row.every ? ` · ${everyText(row.every)}` : ANY_EVERY.test(`${row.title} ${row.shows ?? ''}`) ? ' · no refresh' : ''}`;

// The data an artifact draws, as elu artifacts set and a refresh script give it: a JSON object
// with blocks, a list of blocks, or one block. Each block is one of KINDS. Anything else is
// refused, saying exactly what is wrong and where, so the model can send it again.
const shownValue = value => { const text = JSON.stringify(value); return text === undefined ? String(value) : text.length > 40 ? `${text.slice(0, 39)}…` : text; };
const FIELDS = {
  score: ['kind', 'label', 'value', 'unit', 'target', 'better'],
  bars: ['kind', 'label', 'unit', 'target', 'better', 'max', 'rows'],
  trend: ['kind', 'label', 'unit', 'target', 'better', 'value', 'rows'],
  chart: ['kind', 'label', 'unit', 'target', 'better', 'min', 'max', 'x', 'series'],
  table: ['kind', 'label', 'columns', 'rows'],
  note: ['kind', 'label', 'text'],
};
function dataText(value, where, { required = true, lines = false } = {}) {
  if (value === undefined || value === null) { if (required) refuse(`${where} is missing: it is text.`); return undefined; }
  if (typeof value !== 'string') refuse(`${where} is ${shownValue(value)}, not text.`);
  const text = lines ? value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').trim() : value.replace(/\s+/g, ' ').trim();
  if (CONTROL.test(lines ? text.replace(/\n/g, ' ') : text)) refuse(`${where} holds control characters: write it as plain text.`);
  if (!text && required) refuse(`${where} is empty.`);
  return text || undefined;
}
function dataNumber(value, where, { required = true } = {}) {
  if (value === undefined || value === null) { if (required) refuse(`${where} is missing: it is a number.`); return undefined; }
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e15) {
    const unit = typeof value === 'string' && /^\s*-?\d[\d,.]*\s*\S{1,12}\s*$/.test(value) ? ' Write the number alone, and its unit in unit.' : '';
    refuse(`${where} is ${shownValue(value)}, not a number.${unit}`);
  }
  return value;
}
function keysOf(block, kind, where) {
  const extra = Object.keys(block).filter(key => !FIELDS[kind].includes(key));
  if (extra.length) refuse(`${where} has ${extra.map(key => `"${key}"`).join(', ')}, which a ${kind} does not take. A ${kind} takes ${FIELDS[kind].join(', ')}.`);
}
// What is measured: its unit, the target to reach and whether higher or lower is better.
function measure(block, where) {
  const out = {};
  const unit = dataText(block.unit, `${where}.unit`, { required: false }); if (unit) out.unit = unit;
  const target = dataNumber(block.target, `${where}.target`, { required: false }); if (target !== undefined) out.target = target;
  if (block.better !== undefined && block.better !== null) { if (!BETTER.includes(block.better)) refuse(`${where}.better is ${shownValue(block.better)}: it is "higher" or "lower".`); if (block.better === 'lower') out.better = 'lower'; }
  return out;
}
function namedRows(rows, where) {
  if (!Array.isArray(rows)) refuse(`${where} is ${shownValue(rows)}, not a list of { "label": ..., "value": ... }.`);
  if (!rows.length) refuse(`${where} is empty.`);
  const seen = new Set();
  return rows.map((row, index) => {
    const at = `${where}[${index}]`;
    if (!isObject(row)) refuse(`${at} is ${shownValue(row)}, not { "label": ..., "value": ... }.`);
    const extra = Object.keys(row).filter(key => !['label', 'value', 'target'].includes(key));
    if (extra.length) refuse(`${at} has ${extra.map(key => `"${key}"`).join(', ')}: a row takes label, value and target.`);
    const label = dataText(row.label, `${at}.label`), value = dataNumber(row.value, `${at}.value`), target = dataNumber(row.target, `${at}.target`, { required: false });
    if (seen.has(label)) refuse(`${at}.label "${label}" is in ${where} twice: give each row its own label.`);
    seen.add(label);
    return { label, value, ...(target !== undefined ? { target } : {}) };
  });
}
// A chart's points: x, the label of each point in order (each run's date and time, say), and
// series, one line each, with a value for every x label, null where that point has none. min and
// max fix the range of the axis; without them ELU takes it from the values and the target.
function chartPoints(block, named) {
  if (!Array.isArray(block.x) || !block.x.length) refuse(`${named}.x is ${shownValue(block.x)}: it is a list of the points' labels, such as each run's date and time.`);
  const x = block.x.map((value, at) => dataText(typeof value === 'number' && Number.isFinite(value) ? String(value) : value, `${named}.x[${at}]`));
  if (!Array.isArray(block.series) || !block.series.length) refuse(`${named}.series is ${shownValue(block.series)}: it is a list of lines, each { "label": ..., "values": [...] }.`);
  const seen = new Set();
  const series = block.series.map((row, index) => {
    const at = `${named}.series[${index}]`;
    if (!isObject(row)) refuse(`${at} is ${shownValue(row)}, not { "label": ..., "values": [...] }.`);
    const extra = Object.keys(row).filter(key => !['label', 'values'].includes(key));
    if (extra.length) refuse(`${at} has ${extra.map(key => `"${key}"`).join(', ')}: a line takes label and values.`);
    const label = dataText(row.label, `${at}.label`);
    if (seen.has(label)) refuse(`${at}.label "${label}" is in ${named}.series twice: give each line its own label.`);
    seen.add(label);
    if (!Array.isArray(row.values)) refuse(`${at}.values is ${shownValue(row.values)}: it is a list of ${x.length} numbers, null where a point has none.`);
    if (row.values.length !== x.length) refuse(`${at}.values has ${row.values.length} values and ${named}.x ${x.length} labels: give one value for each, null where there is none.`);
    return { label, values: row.values.map((value, n) => value === null ? null : dataNumber(value, `${at}.values[${n}]`)) };
  });
  const min = dataNumber(block.min, `${named}.min`, { required: false }), max = dataNumber(block.max, `${named}.max`, { required: false });
  if (min !== undefined && max !== undefined && min >= max) refuse(`${named}.min is ${min} and max ${max}: min is below max.`);
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), x, series };
}
function checkBlock(block, index) {
  const where = `blocks[${index}]`;
  if (!isObject(block)) refuse(`${where} is ${shownValue(block)}, not a block: { "kind": "score", ... }.`);
  if (!KINDS.includes(block.kind)) refuse(`${where}.kind is ${shownValue(block.kind)}: it is one of ${KINDS.join(', ')}.`);
  const kind = block.kind, named = `${where} (${kind})`;
  keysOf(block, kind, named);
  const label = dataText(block.label, `${named}.label`, { required: false }), head = { kind, ...(label ? { label } : {}) };
  if (kind === 'note') return { ...head, text: dataText(block.text, `${named}.text`, { lines: true }) };
  if (kind === 'score') return { ...head, value: dataNumber(block.value, `${named}.value`), ...measure(block, named) };
  if (kind === 'bars') {
    const max = dataNumber(block.max, `${named}.max`, { required: false });
    if (max !== undefined && max <= 0) refuse(`${named}.max is ${max}: it is above 0.`);
    return { ...head, ...measure(block, named), ...(max !== undefined ? { max } : {}), rows: namedRows(block.rows, `${named}.rows`) };
  }
  if (kind === 'trend') {
    const one = block.value !== undefined && block.value !== null, many = block.rows !== undefined && block.rows !== null;
    if (one === many) refuse(`${named} has ${one ? 'both value and rows' : 'neither value nor rows'}: give value for one line, or rows for one line each.`);
    return { ...head, ...measure(block, named), ...(one ? { value: dataNumber(block.value, `${named}.value`) } : { rows: namedRows(block.rows, `${named}.rows`) }) };
  }
  if (kind === 'chart') return { ...head, ...measure(block, named), ...chartPoints(block, named) };
  // table
  if (!Array.isArray(block.columns) || !block.columns.length) refuse(`${named}.columns is ${shownValue(block.columns)}: it is a list of column names, each text or { "label", "unit", "target", "better" }.`);
  const columns = block.columns.map((column, at) => {
    const spot = `${named}.columns[${at}]`;
    if (typeof column === 'string') return { label: dataText(column, spot) };
    if (!isObject(column)) refuse(`${spot} is ${shownValue(column)}: it is text, or { "label", "unit", "target", "better" }.`);
    const extra = Object.keys(column).filter(key => !['label', 'unit', 'target', 'better'].includes(key));
    if (extra.length) refuse(`${spot} has ${extra.map(key => `"${key}"`).join(', ')}: a column takes label, unit, target and better.`);
    return { label: dataText(column.label, `${spot}.label`), ...measure(column, spot) };
  });
  if (!Array.isArray(block.rows)) refuse(`${named}.rows is ${shownValue(block.rows)}: it is a list of rows, each a list of ${columns.length} cells.`);
  const rows = block.rows.map((row, at) => {
    const spot = `${named}.rows[${at}]`;
    if (!Array.isArray(row)) refuse(`${spot} is ${shownValue(row)}: a row is a list of ${columns.length} cells.`);
    if (row.length !== columns.length) refuse(`${spot} has ${row.length} cells and the table ${columns.length} columns.`);
    return row.map((cell, n) => cell === null ? null : typeof cell === 'number' ? dataNumber(cell, `${spot}[${n}]`) : dataText(cell, `${spot}[${n}]`, { required: false }) ?? null);
  });
  return { ...head, columns, rows };
}
export function checkData(value) {
  const blocks = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.blocks) ? value.blocks : isObject(value) && typeof value.kind === 'string' ? [value] : null;
  if (!blocks) refuse('The data is a JSON object with blocks, a list of blocks, or one block, such as {"blocks":[{"kind":"score","label":"Answered","value":86.2,"unit":"%","target":85}]}. elu artifacts --help shows every kind.');
  if (isObject(value) && Array.isArray(value.blocks)) { const extra = Object.keys(value).filter(key => key !== 'blocks'); if (extra.length) refuse(`The data has ${extra.map(key => `"${key}"`).join(', ')} beside blocks: put everything in a block.`); }
  if (!blocks.length) refuse('The data has no blocks.');
  const data = { blocks: blocks.map(checkBlock) };
  if (JSON.stringify(data).length > ARTIFACT_LIMITS.data) refuse(`The data takes ${JSON.stringify(data).length} characters: at most ${ARTIFACT_LIMITS.data} in one update. Send fewer rows.`);
  return data;
}
// Text as the command or a script gave it: the JSON whole, or else its last line that reads.
export function readData(text) {
  const said = String(text ?? '').trim();
  if (!said) refuse('No data was given: it is JSON, such as {"blocks":[{"kind":"note","text":"..."}]}.');
  let value, problem;
  try { value = JSON.parse(said); } catch (error) {
    problem = error.message;
    const last = said.split('\n').map(row => row.trim()).filter(Boolean).at(-1);
    try { value = last && last !== said ? JSON.parse(last) : undefined; } catch { value = undefined; }
  }
  if (value === undefined) refuse(`The data is not JSON: ${problem}.`);
  return checkData(value);
}

// Where a session's artifacts are kept, beside its Task: each artifact's updates (oldest first,
// the last ARTIFACT_LIMITS.kept), its refresh script and how its last refresh went, by its key
// (artifactKey), so a revised Task that keeps a title keeps its data. seenAt: when the owner
// last looked at the tab here, for the dot on it.
export const storeFile = (repo, id) => path.join(taskDir(repo, id), 'artifacts.json');
const blank = () => ({ version: 1, items: {}, seenAt: null });
export function readStore(repo, id) {
  try {
    const file = storeFile(repo, id); noSymlinks(file);
    if (!fs.existsSync(file)) return blank();
    const value = readJson(file);
    return { version: 1, items: isObject(value?.items) ? value.items : {}, seenAt: typeof value?.seenAt === 'string' ? value.seenAt : null };
  } catch { return blank(); }
}
function changeStore(repo, id, edit) {
  const release = waitLock(repo, `artifacts-${id}`, 200);
  try { const store = readStore(repo, id), result = edit(store); atomic(storeFile(repo, id), store); return result; }
  finally { release(); }
}
const itemOf = (store, key) => { store.items[key] ??= { updates: [] }; if (!Array.isArray(store.items[key].updates)) store.items[key].updates = []; return store.items[key]; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// An update keeps in data the blocks of the kinds ELU 0.1.33 draws, the first with artifacts, and
// a block of a kind added since (a chart) beside it in newer, with its place among them: that ELU
// draws the rest and skips it, on this computer and on a teammate's. whole() puts them together
// again, leaving out a kind this ELU does not know, as a later ELU may write one.
// sent: for another computer. One on 0.1.33 checks data against the limits it had (OLD) and drops
// the whole update over one block beyond them, so such a block and every block after its twelfth
// go in newer too: it draws the others, and this ELU reads all of them.
const FIRST_KINDS = ['score', 'bars', 'trend', 'table', 'note'];
const OLD = { blocks: 12, rows: 40, bars: 20, columns: 12, label: 80, unit: 12, cell: 80, note: 2000 };
function oldTakes(block) {
  const short = (value, max) => value === undefined || value.length <= max, rows = block.rows ?? [];
  if (!short(block.label, OLD.label) || !short(block.unit, OLD.unit)) return false;
  if (block.kind === 'note') return block.text.length <= OLD.note;
  if (block.kind !== 'table') return rows.length <= OLD.bars && rows.every(row => short(row.label, OLD.label));
  return block.columns.length <= OLD.columns && rows.length <= OLD.rows && block.columns.every(column => short(column.label, OLD.label) && short(column.unit, OLD.unit)) && rows.every(row => row.every(cell => typeof cell !== 'string' || cell.length <= OLD.cell));
}
export function storedData(data, { sent = false } = {}) {
  const newer = []; let taken = 0;
  const blocks = data.blocks.filter((block, index) => FIRST_KINDS.includes(block.kind) && (!sent || oldTakes(block) && taken++ < OLD.blocks) || !newer.push({ index, block }));
  return { data: { blocks }, ...(newer.length ? { newer } : {}) };
}
export function whole(update) {
  const known = block => isObject(block) && KINDS.includes(block.kind), blocks = (Array.isArray(update?.data?.blocks) ? update.data.blocks : []).filter(known);
  const newer = Array.isArray(update?.newer) ? update.newer.filter(row => isObject(row) && Number.isSafeInteger(row.index) && row.index >= 0 && known(row.block)).sort((a, b) => a.index - b.index) : [];
  for (const row of newer) blocks.splice(Math.min(row.index, blocks.length), 0, row.block);
  return { blocks };
}
// Adds an update to an artifact: the data is checked (checkData) by the caller. One equal to the
// last adds nothing. by: model, script or owner. Returns { added, at }.
export function addUpdate(repo, id, title, data, { by = 'model', at = new Date().toISOString() } = {}) {
  return changeStore(repo, id, store => {
    const item = itemOf(store, artifactKey(title));
    item.title = title;
    if (item.updates.length && same(whole(item.updates.at(-1)), data)) return { added: false, at: item.updates.at(-1).at };
    item.updates = [...item.updates, { at, by, ...storedData(data) }].slice(-ARTIFACT_LIMITS.kept);
    return { added: true, at };
  });
}
// A refresh script as ELU keeps it, or why it cannot be kept.
export function checkScript(text) {
  const script = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!script.trim()) refuse('The script is empty.');
  if (script.length > ARTIFACT_LIMITS.script) refuse(`The script has ${script.length} characters: at most ${ARTIFACT_LIMITS.script}.`);
  if (/\u0000/.test(script)) refuse('The script holds a NUL character: it is text.');
  return script;
}
export function saveScript(repo, id, title, text) {
  const script = text === null ? null : checkScript(text);
  return changeStore(repo, id, store => {
    const item = itemOf(store, artifactKey(title));
    item.title = title;
    if (script === null) { delete item.script; delete item.run; return null; }
    item.script = { text: script, savedAt: new Date().toISOString() };
    delete item.run;
    return item.script;
  });
}
// What a new goal's Artifact: lines are read by (readArtifactLine known): the Task's artifacts
// now, then the titles whose data or script ELU still keeps for the session, so one removed and
// named again is the same one.
export function knownArtifacts(repo, id, task) {
  let kept = []; try { kept = Object.values(readStore(repo, id).items ?? {}).flatMap(item => isObject(item) && typeof item.title === 'string' && item.title.trim() ? [{ title: item.title, shows: '', every: null }] : []); } catch { kept = []; }
  return [...taskArtifacts(task), ...kept];
}
export function markSeen(repo, id, at = new Date().toISOString()) {
  try { return changeStore(repo, id, store => { store.seenAt = at; return at; }); } catch { return null; }
}
// The artifacts of a session to show: the Task's own, in its order, each with its updates, its
// script and its last refresh. task: the Task they are of (lib/plan.mjs), or null for none.
export function artifactRows(task, store) {
  return taskArtifacts(task).map(row => {
    const item = store.items[artifactKey(row.title)] ?? {};
    const updates = Array.isArray(item.updates) ? item.updates.filter(update => isObject(update) && isObject(update.data) && typeof update.at === 'string').map(update => ({ ...update, data: whole(update) })) : [];
    return { ...row, key: artifactKey(row.title), updates, script: typeof item.script?.text === 'string' ? item.script.text : null, scriptAt: item.script?.savedAt ?? null, run: isObject(item.run) ? item.run : null };
  });
}
// When the newest data came, of all of them, or null: the tab's dot shows while it is later than seenAt.
export const latestAt = rows => rows.reduce((last, row) => { const at = row.updates.at(-1)?.at; return at && (!last || at > last) ? at : last; }, null);
export const unseen = (rows, seenAt) => { const last = latestAt(rows); return Boolean(last) && (!seenAt || last > seenAt); };

// What may leave this computer with the Task, for the owner's other computers and teammates
// (lib/plan.mjs sharedTask): each artifact's newest update, so one with data never arrives with
// none; then their earlier ones, the newest first and each artifact in turn, while all of it fits
// SHARED_BYTES; and how its last refresh went. Never its script, which can name the owner's files.
// SHARED_NEWEST: the newest updates together stay well inside one message between two computers
// (lib/peer/transport.mjs FRAME_MAX).
const SHARED_UPDATES = 12, SHARED_BYTES = 48000, SHARED_NEWEST = 200000;
export function sharedArtifacts(rows) {
  let room = SHARED_BYTES, first = SHARED_NEWEST;
  const sent = rows.map(() => []);
  for (let back = 1; back <= SHARED_UPDATES; back++) rows.forEach((row, index) => {
    const update = row.updates.at(-back); if (!update || sent[index].length !== back - 1) return;
    const kept = storedData(update.data, { sent: true }), size = JSON.stringify(kept).length + 40;
    if (size > (back === 1 ? first : room)) return;
    first -= size; room -= size; sent[index].unshift({ at: update.at, ...kept });
  });
  return rows.map((row, index) => ({ title: row.title, shows: row.shows, every: row.every, updates: sent[index], script: Boolean(row.script), ...(row.run?.ok === false && typeof row.run.at === 'string' ? { failed: { at: row.run.at, error: String(row.run.error ?? '').slice(0, 200) } } : {}) }));
}
// The same, read back from another computer: every field checked, what does not read left out.
export function readSharedArtifacts(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    if (!isObject(row) || typeof row.title !== 'string' || !row.title.trim()) return [];
    const updates = (Array.isArray(row.updates) ? row.updates : []).slice(-SHARED_UPDATES).flatMap(update => { if (!isObject(update) || typeof update.at !== 'string' || !Number.isFinite(Date.parse(update.at))) return []; try { return [{ at: update.at, data: checkData(whole(update)) }]; } catch { return []; } });
    const failed = isObject(row.failed) && typeof row.failed.at === 'string' ? { ok: false, at: row.failed.at, error: String(row.failed.error ?? '').slice(0, 200) } : null;
    return [{ title: row.title.replace(/\s+/g, ' ').trim().slice(0, ARTIFACT_LIMITS.title), shows: typeof row.shows === 'string' ? row.shows.replace(/\s+/g, ' ').trim().slice(0, 2000) : '', every: Number.isInteger(row.every) && row.every >= 1 ? row.every : null, key: artifactKey(row.title), updates, script: row.script === true ? '' : null, run: failed }];
  });
}

// What every turn is told, with the Task, when it has artifacts (lib/plan.mjs planPrompt), and
// what a proposal says of them (FIELDS there).
export const ARTIFACT_FIELD = 'in artifacts what the owner asked to see while the work goes on, when he asked (metrics, an eval\'s scores, test results): for each a short title, in shows what it shows, and in everyMinutes how often it refreshes, or null; else an empty list';
export const ARTIFACT_RULES = 'The owner watches the artifacts of this Task (artifacts in the Task below): they say what he judges the work by, so work toward them. Fill each with numbers you have: elu artifacts set N \'JSON\' in your shell, where N is its number; ELU draws it, you never draw it. You may fill one before the Task is approved, by its title, so the owner sees the numbers when he decides. For one with a refresh interval and no refresh script yet (script none), write the script once to a file and run elu artifacts script N FILE. Outside Full access the owner reads it and allows it before ELU keeps it. ELU runs it on that interval with no turn, in the session\'s folder where your work turns run, and draws what it prints, the same JSON. The script only reads results that already exist there: it never starts an eval, a build, a deploy, or anything that costs money or changes files. A history you already have, such as each run\'s scores, goes in one chart block, with the runs\' dates and times as its x: a trend only builds from later updates. elu artifacts --help shows the JSON. To add, change or remove an artifact, return the whole revised Task in task.';
// The artifacts as a turn is given them with its Task: numbered as elu artifacts set takes them.
export const promptArtifacts = (task, store = null) => taskArtifacts(task).map((row, index) => {
  const item = store?.items?.[artifactKey(row.title)] ?? null, last = Array.isArray(item?.updates) ? item.updates.at(-1)?.at ?? null : null;
  return { number: index + 1, title: row.title, shows: row.shows, refresh: everyText(row.every), script: row.every ? (item?.script ? 'saved' : 'none') : 'not needed', lastFilled: last ?? 'never' };
});

export const ARTIFACTS_HELP = `elu artifacts: what this session's Task shows on its Artifacts tab.

  elu artifacts [--json]                 List them, with when each was last filled.
  elu artifacts set N|TITLE JSON         Fill one. N is its number in the Task.
  elu artifacts set N|TITLE --file FILE  The same, from a file; - reads standard input.
  elu artifacts script N|TITLE FILE      Save the script that refreshes it; - reads standard input.
  elu artifacts script N|TITLE --remove  Remove its script.

The data is JSON: {"blocks": [BLOCK, ...]}, each BLOCK one of
  {"kind":"score","label":"Answered","value":86.2,"unit":"%","target":85}
  {"kind":"bars","label":"By surface","unit":"%","target":85,"rows":[{"label":"Chat","value":91}]}
  {"kind":"trend","label":"Answered","unit":"%","rows":[{"label":"Chat","value":91}]}
  {"kind":"chart","label":"By run","unit":"%","target":85,"x":["Nov 1 9:40 PM","Nov 2 8:15 AM"],
   "series":[{"label":"Accuracy","values":[78,84]},{"label":"Success rate","values":[40,null]}]}
  {"kind":"table","columns":["Surface",{"label":"Median","unit":"s","target":20,"better":"lower"}],
   "rows":[["Chat",14.2]]}
  {"kind":"note","text":"Last run 9:40 PM, 120 cases."}
target is the value to reach; better is "higher" (the default) or "lower". A score shows its
change since the last update; a trend draws its values over the updates ELU keeps. A chart draws
a history you have at once: a line for each series over the x labels, null where a point has
none; min and max fix its axis. An update equal to the last one adds nothing. One update holds
at most ${ARTIFACT_LIMITS.data} characters; there is no limit on blocks, rows or points.

A refresh script runs on the Task's interval in the session's folder (where its work turns
run), in the sandbox the project's checks run in, for at most ${ARTIFACT_LIMITS.seconds} seconds, and prints the
same JSON. It only reads results that already exist there: it never starts an eval, a build,
a deploy, or anything that costs money or changes files. A script that starts with #! runs as
itself; any other with sh.
`;

// elu artifacts, for a session's own turn and the owner's shell (lib/session-commands.mjs):
// at is { repo, session } there. Returns what formatResult prints. at.approveScript: for a
// turn's request outside Full access, asks the owner before a refresh script is kept, with the
// script whole ({ artifact, every, text }); it refuses with what the turn is told when he does
// not allow it, and nothing is kept.
// flags.text: the data or the script as text (a session's elu read its file or standard input,
// lib/command-client.mjs); flags.file and a script's FILE are read here only in the owner's own
// shell (readFile), never for a request a turn handed in.
export async function artifactsCli(words, flags, at, { readFile = null } = {}) {
  const { repo, session } = at;
  if (!session) refuse('elu artifacts works inside a session: its Task holds them.');
  const { sessionTasks } = await import('./plan.mjs');
  const id = String(session.id), task = sessionTasks(repo, id).findLast(row => row.state !== 'rejected') ?? null;
  const defined = taskArtifacts(task), verb = words[0] ?? 'list';
  const given = file => readFile ? readFile(file) : refuse('In a session, elu reads the file itself: run it again as elu artifacts with the file.');
  // An artifact by its number in the Task, or by its title: a title the Task does not have yet
  // may be filled too, so the numbers show once the Task that has it is written.
  const pick = (value, { anyTitle = false } = {}) => {
    const text = String(value ?? '').trim();
    if (!text) refuse('Name the artifact by its number in the Task, or its title.');
    if (/^[1-9][0-9]*$/.test(text)) return defined[Number(text) - 1] ?? refuse(defined.length ? `The Task has ${defined.length === 1 ? 'one artifact' : `${defined.length} artifacts`}: elu artifacts lists them.` : 'The Task has no artifacts yet: name one by its title, or ask the owner what to show.');
    const found = defined.find(row => artifactKey(row.title) === artifactKey(text));
    if (found) return found;
    if (!anyTitle) refuse(`The Task has no artifact "${text.slice(0, 60)}": elu artifacts lists them.`);
    if (text.length > ARTIFACT_LIMITS.title || CONTROL.test(text)) refuse(`Name an artifact in at most ${ARTIFACT_LIMITS.title} characters of plain text.`);
    return { title: text.replace(/\s+/g, ' '), shows: '', every: null, loose: true };
  };
  if (verb === 'list') {
    if (words.length > 1) refuse('Use elu artifacts, elu artifacts set N JSON or elu artifacts script N FILE.');
    const store = readStore(repo, id), rows = artifactRows(task, store);
    const lines = rows.length ? [`Artifacts of session ${id}'s Task:`, ...rows.map((row, index) => `${String(index + 1).padStart(3)}  "${row.title}" · ${everyText(row.every)} · ${row.updates.length ? `filled ${row.updates.at(-1).at}` : 'not filled yet'}${row.every ? ` · script ${row.script ? 'saved' : 'none'}` : ''}${row.run?.ok === false ? ` · last refresh failed: ${row.run.error}` : ''}`)] : [`Session ${id}'s Task has no artifacts. The owner says in the chat what he wants to see.`];
    return { artifacts: rows.map(row => ({ title: row.title, shows: row.shows, every: row.every, filled: row.updates.at(-1)?.at ?? null, script: Boolean(row.script) })), lines };
  }
  if (verb === 'set') {
    if (words.length < 2) refuse('Use elu artifacts set N \'JSON\', or --file FILE.');
    const row = pick(words[1], { anyTitle: true }), text = flags.text !== undefined ? flags.text : flags.file !== undefined ? given(flags.file) : words.length === 3 && words[2] === '-' ? given('-') : words.slice(2).join(' ');
    if ((flags.text !== undefined || flags.file !== undefined) && words.length > 2) refuse('Give the data once: as JSON after the artifact, or with --file.');
    const data = readData(text), added = addUpdate(repo, id, row.title, data, { by: at.by ?? 'model' });
    // A title the Task does not have: the data is kept, and the line says plainly that it is not in the Task.
    const where = row.loose ? ` The Task has no artifact "${row.title}", so it is not on the Artifacts tab: it shows once the Task has one. To add it, return the whole revised Task in task.` : '';
    return { title: row.title, added: added.added, message: added.added ? `Filled "${row.title}": ${data.blocks.length === 1 ? 'one block' : `${data.blocks.length} blocks`}.${where}` : `"${row.title}" shows this already: nothing was added.` };
  }
  if (verb === 'script') {
    if (words.length < 2) refuse('Use elu artifacts script N FILE, or - to read it from standard input.');
    const row = pick(words[1]);
    if (flags.remove) { saveScript(repo, id, row.title, null); return { title: row.title, message: `Removed the refresh script of "${row.title}".` }; }
    if (!row.every) refuse(`"${row.title}" has no refresh interval, so it needs no script: fill it with elu artifacts set.`);
    const text = checkScript(flags.text !== undefined ? flags.text : words[2] !== undefined && words.length === 3 ? given(words[2]) : refuse('Give the script as one file, or - to read it from standard input.'));
    if (at.approveScript) await at.approveScript({ artifact: row.title, every: row.every, text });
    saveScript(repo, id, row.title, text);
    try { listRefresh(repo, id, row.title); } catch { /* Read again the next time ELU looks. */ }
    return { title: row.title, message: `Saved the refresh script of "${row.title}". ELU runs it ${everyText(row.every)} while it runs on this computer, and draws what it prints.` };
  }
  refuse(`Unknown command: elu artifacts ${verb}. Use elu artifacts --help.`);
}

// The sessions whose artifacts ELU refreshes, so it looks only at those: one list on this
// computer, of { root, id, key }. A row whose project or session is gone leaves it the next
// time ELU looks (refreshDue); one whose Task is done, waits for approval, or no longer has the
// artifact or its script stays and does not run, so a Task opened again refreshes again.
const listFile = () => path.join(personalDirectory(), 'artifact-refresh.json');
function readList() { try { const file = listFile(); noSymlinks(file); if (!fs.existsSync(file)) return []; const value = readJson(file); return Array.isArray(value?.rows) ? value.rows.filter(row => isObject(row) && typeof row.root === 'string' && typeof row.id === 'string' && typeof row.key === 'string') : []; } catch { return []; } }
function changeList(edit) {
  const release = waitLock({ state: personalDirectory() }, 'artifact-refresh', 200);
  try { const rows = readList(), next = edit(rows); atomic(listFile(), { version: 1, rows: next }); return next; }
  finally { release(); }
}
export function listRefresh(repo, id, title) {
  const root = repo.project ?? repo.root, key = artifactKey(title);
  return changeList(rows => rows.some(row => row.root === root && row.id === String(id) && row.key === key) ? rows : [...rows, { root, id: String(id), key }]);
}
// What one row of the list needs now: run (its refresh is due), drop (it refreshes no more), or wait.
// A refresh that started and did not end within twice the time limit counts as ended.
function refreshState(row, now) {
  let repo; try { repo = projectRepo(row.root); } catch { return { drop: true }; }
  if (!fs.existsSync(taskDir(repo, row.id))) return { drop: true };
  let session; try { session = readTask(repo, row.id); } catch { return { wait: true }; }
  const { tasks, kanban } = refreshDeps;
  const task = tasks.sessionTasks(repo, row.id).findLast(value => value.state !== 'rejected') ?? null;
  if (task?.state !== 'approved') return { wait: true };
  try { if (kanban.sessionArchived(kanban.readBoard(repo), session)) return { wait: true }; } catch { /* Read as not archived. */ }
  const artifact = taskArtifacts(task).find(value => artifactKey(value.title) === row.key);
  const item = readStore(repo, row.id).items[row.key];
  if (!artifact?.every || typeof item?.script?.text !== 'string') return { wait: true };
  const started = Date.parse(item.run?.startedAt ?? ''), last = Date.parse(item.run?.at ?? '');
  if (Number.isFinite(started) && now - started < ARTIFACT_LIMITS.seconds * 2000) return { wait: true };
  return Number.isFinite(last) && now - last < artifact.every * 60000 ? { wait: true } : { run: true, repo, session, task, artifact };
}
const refreshDeps = {};
let projectRepo = root => { throw new Error(`No project at ${root}`); };
async function loadDeps() {
  if (refreshDeps.tasks) return;
  refreshDeps.tasks = await import('./plan.mjs'); refreshDeps.kanban = await import('./kanban.mjs');
  const { projectFolder } = await import('./workspace.mjs'); projectRepo = root => projectFolder(root);
}
// ELU looks every so often, while it runs (lib/terminal.mjs): each refresh that is due starts
// in a process of its own (artifact-refresh.mjs), so nothing here waits for it. Returns how many started.
const RUNNER = fileURLToPath(new URL('./artifact-refresh.mjs', import.meta.url));
export async function refreshDue({ now = Date.now(), start = startRefresh } = {}) {
  const rows = readList(); if (!rows.length) return 0;
  await loadDeps();
  let started = 0; const gone = [];
  for (const row of rows) {
    let state; try { state = refreshState(row, now); } catch { state = { wait: true }; }
    if (state.drop) gone.push(row);
    else if (state.run) { try { start(row); started++; } catch { /* Tried again the next time. */ } }
  }
  if (gone.length) { try { changeList(list => list.filter(row => !gone.some(value => value.root === row.root && value.id === row.id && value.key === row.key))); } catch { /* Next time. */ } }
  return started;
}
export function startRefresh(row) {
  const child = spawn(process.execPath, [RUNNER, row.root, row.id, row.key], { stdio: 'ignore', detached: false, env: process.env });
  child.on('error', () => {}); child.unref();
}
// One refresh, in its own process: the script runs in the session's folder under the session's
// mode, with the time limit. Full access runs it as the owner's terminal would; every other mode
// in the sandbox this computer has for checks, which keeps it from writing anything but its own
// scratch folder and from the network. What it prints is checked as elu artifacts set checks it,
// and added; a run that fails keeps the last good data and says why in one line.
export async function runRefresh(root, id, key, { now = Date.now() } = {}) {
  await loadDeps();
  const state = refreshState({ root, id: String(id), key }, now);
  if (!state.run) return { ran: false };
  const { repo, session, artifact } = state;
  // Taken under the lock, so two windows never run the same refresh.
  const claimed = changeStore(repo, id, store => { const item = itemOf(store, key); const started = Date.parse(item.run?.startedAt ?? ''); if (Number.isFinite(started) && now - started < ARTIFACT_LIMITS.seconds * 2000) return false; item.run = { ...(item.run ?? {}), startedAt: new Date(now).toISOString() }; return true; });
  if (!claimed) return { ran: false };
  const script = readStore(repo, id).items[key]?.script?.text ?? '';
  // It runs in the session's folder, where its work is, and reads only what is there.
  const mode = ['ask', 'auto', 'full', 'locked'].includes(session.permissions) ? session.permissions : 'locked';
  const cwd = session.worktree && fs.existsSync(session.worktree) ? session.worktree : repo.project ?? repo.root;
  // Its scratch folder is where the checks keep theirs, the only place it may write.
  const scratch = path.join(cwd, '.elu-code', 'tmp', crypto.randomUUID()), logs = tempFolder('elu-artifact-log-');
  let result;
  try {
    noSymlinks(scratch); mkdir(scratch);
    const file = path.join(scratch, 'refresh'); fs.writeFileSync(file, script, { mode: 0o700 });
    const own = script.startsWith('#!'), program = own ? file : '/bin/sh', args = own ? [] : [file], logFile = path.join(logs, 'out.log');
    const { openRun, sandboxRun } = await import('./sandbox.mjs');
    let run;
    try {
      run = mode === 'full' ? await openRun({ cwd, program, args, logFile, timeoutSeconds: ARTIFACT_LIMITS.seconds })
        : await sandboxRun({ cwd, protectedPaths: [], writablePaths: [], scratch, program, args, logFile, timeoutSeconds: ARTIFACT_LIMITS.seconds });
    } catch (error) { result = { ok: false, error: String(error?.message ?? error) }; }
    if (!result) {
      const out = readSome(logFile), err = readSome(`${logFile}.stderr`), first = errorLine;
      if (run.timedOut) result = { ok: false, error: `It ran past ${ARTIFACT_LIMITS.seconds} seconds.` };
      else if (run.code !== 0) result = { ok: false, error: first(err) || first(out) || `It ended with code ${run.code}.` };
      else { try { const data = readData(out); addUpdate(repo, id, artifact.title, data, { by: 'script' }); result = { ok: true }; } catch (error) { result = { ok: false, error: `It printed what ELU cannot draw: ${first(error.message)}` }; } }
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); fs.rmSync(logs, { recursive: true, force: true }); }
  const at = new Date().toISOString();
  changeStore(repo, id, store => { const item = itemOf(store, key); item.run = { at, ok: result.ok, ...(result.ok ? {} : { error: String(result.error).replace(/\s+/g, ' ').trim().slice(0, 200) }) }; });
  return { ran: true, ...result };
}
// The line of what a script printed that says what went wrong: the first that names an error,
// else its first line. A runtime's own lines before it (where in its code it stopped) are passed over.
const ERROR_WORDS = /\b[A-Za-z]*(?:Error|Exception)\b|\berror\b|denied|not found|no such|cannot|can't|failed|refused/i;
export function errorLine(text) {
  const lines = String(text ?? '').split('\n').map(row => row.trim()).filter(Boolean);
  return lines.find(row => ERROR_WORDS.test(row)) ?? lines[0] ?? '';
}
const readSome = file => { try { const fd = fs.openSync(file, 'r'); try { const buffer = Buffer.alloc(65536), size = fs.readSync(fd, buffer, 0, buffer.length, 0); return buffer.subarray(0, size).toString('utf8'); } finally { fs.closeSync(fd); } } catch { return ''; } };
