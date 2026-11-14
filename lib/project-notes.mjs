import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, hash, isObject, mkdir, noSymlinks, personalDirectory, readJson } from './util.mjs';
import { LEARNED_HEADING, changingSettings, learnedSection, saveContext, savedText, syncText } from './project-settings.mjs';
import { trustedText } from './project-trust.mjs';
import { learnedKey } from './project-learnings.mjs';

// A project's instructions and context are the owner's on every computer of his that has the
// project, as its tasks are: every model and bot there reads the same (lib/runner.mjs). His
// computers send them to each other (lib/peer/notes.mjs); this is each computer's own side of
// that: what it remembers of the two, how its version and another's are put together, and
// where the text that lost is kept.
//
// Each has two parts: his own text (the instructions, and the context above its "Learned from
// you" section), and the learned lines of that section (lib/project-learnings.mjs). His own text
// is one text: when only one computer changed it since the two last agreed, that change is
// taken; when both did, the newer edit wins and the other text is kept in the project's
// .elu-code/history/. The learned lines are a set of dated lines: a line saved on any computer
// is on all of them, and so is a line he took out. Only text in force here is ever sent: text he
// approved on this computer, which an edit on another computer of his is (syncText).
//
// project-notes.json in ELU's folder: { version, projects: { <project folder>: { sig,
// instructions: { hash, at }, own: { hash, at }, learned: { <key>: { line, since, at, on } },
// agreed: { <computer key>: { instructions, own } }, kept: [hash] } } }. at and since are
// milliseconds: when that text or line came to be (when this computer first saw it, or the time
// the computer it came from gave it), and since, when a line was first learned, which orders
// the section. agreed holds the hashes both computers last had alike.
const FILE = () => path.join(personalDirectory(), 'project-notes.json');
const KEPT = 200;
const realRoot = root => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } };
function readStore() {
  try { const file = FILE(); noSymlinks(file); if (!fs.existsSync(file)) return { version: 1, projects: {} }; const value = readJson(file); return isObject(value) && isObject(value.projects) ? value : { version: 1, projects: {} }; }
  catch { return { version: 1, projects: {} }; }
}
const stamp = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
function rowOf(store, root) {
  const row = isObject(store.projects[root]) ? store.projects[root] : {};
  const part = value => isObject(value) && typeof value.hash === 'string' ? { hash: value.hash, at: stamp(value.at) } : null;
  const learned = {};
  for (const [key, value] of Object.entries(isObject(row.learned) ? row.learned : {})) if (isObject(value) && typeof value.line === 'string') learned[key] = { line: value.line, since: stamp(value.since), at: stamp(value.at), on: value.on === true };
  return { sig: typeof row.sig === 'string' ? row.sig : null, instructions: part(row.instructions), own: part(row.own), learned, agreed: isObject(row.agreed) ? row.agreed : {}, kept: Array.isArray(row.kept) ? row.kept.filter(item => typeof item === 'string') : [] };
}

// The context in its two parts: the owner's own text, and each line of the learned section
// that holds anything, with the key it is known by on every computer. The own text goes
// without the section and without blank lines at its end.
export function splitContext(text) {
  const { lines, start, end } = learnedSection(text);
  const own = (start < 0 ? lines : [...lines.slice(0, start), ...lines.slice(end)]).join('\n').replace(/\s+$/, '');
  const learned = start < 0 ? [] : lines.slice(start + 1, end).filter(line => line.trim()).map(line => ({ key: learnedKey(line), line: line.trimEnd() })).filter(row => row.key);
  return { own, learned };
}
// The context again: his own text, then the section with the lines in their order.
export function composeContext(own, lines) {
  const top = String(own ?? '').replace(/\s+$/, '');
  if (!lines.length) return top ? `${top}\n` : '';
  return `${top ? `${top}\n\n` : ''}${LEARNED_HEADING}\n\n${lines.join('\n')}\n`;
}
const textHash = text => hash(`notes\0${text}`);
// When a line dated YYYY-MM-DD was learned, that day; else the time given.
function dayOf(line, otherwise) {
  const match = /^\s*(?:[-*•]\s+)?(\d{4})-(\d{2})-(\d{2}):/.exec(line);
  const at = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() : NaN;
  return Number.isFinite(at) ? at : otherwise;
}
const fileTime = (root, name) => { try { return Math.floor(fs.statSync(path.join(root, '.elu-code', name)).mtimeMs); } catch { return null; } };

// What this computer has now for the project at root, its record brought up to date first:
// a text that changed since the last look is dated now (on the first look, when its file was
// last written), a learned line that came is on from now, and one that went is off from now.
// { instructions: { text, hash, at }, own: { text, hash, at }, learned: [{ line, since, at, on }] }
function look(root, store, now) {
  const instructions = savedText(trustedText(root, 'instructions.md') ?? ''), context = savedText(trustedText(root, 'context.md') ?? '');
  const key = realRoot(root), row = rowOf(store, key), sig = textHash(`${instructions}\0${context}`), first = row.sig === null;
  const { own, learned } = splitContext(context);
  if (row.sig !== sig) {
    const ih = textHash(instructions), oh = textHash(own);
    if (row.instructions?.hash !== ih) row.instructions = { hash: ih, at: first ? fileTime(root, 'instructions.md') ?? now : now };
    if (row.own?.hash !== oh) row.own = { hash: oh, at: first ? fileTime(root, 'context.md') ?? now : now };
    const here = new Set();
    learned.forEach(({ key: name, line }, index) => {
      here.add(name);
      const kept = row.learned[name];
      if (!kept) { const since = dayOf(line, now) + index; row.learned[name] = { line, since, at: first ? since : now, on: true }; }
      else if (!kept.on) row.learned[name] = { ...kept, line, at: now, on: true };
    });
    for (const [name, kept] of Object.entries(row.learned)) if (kept.on && !here.has(name)) row.learned[name] = { ...kept, at: now, on: false };
    row.sig = sig; store.projects[key] = row; return { row, instructions, own, changed: true };
  }
  return { row, instructions, own, changed: false };
}
const save = store => atomic(FILE(), store);
export function localNotes(root, { now = Date.now() } = {}) {
  return changingSettings(() => {
    const store = readStore(), { row, instructions, own, changed } = look(root, store, now);
    if (changed) save(store);
    return { instructions: { text: instructions, ...row.instructions }, own: { text: own, ...row.own }, learned: Object.values(row.learned).map(item => ({ ...item })) };
  });
}

// Where a text that lost goes: .elu-code/history/<name>-<date>-<time>.md in the project,
// which Git leaves alone (the folder ignores itself). The path, or null when it could not be kept.
function keep(root, name, text, now) {
  const at = new Date(now), two = n => String(n).padStart(2, '0');
  const folder = path.join(root, '.elu-code', 'history'), base = `${name}-${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  try {
    mkdir(folder);
    const ignore = path.join(folder, '.gitignore'); noSymlinks(ignore);
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n', { mode: 0o600 });
    for (let n = 0; ; n++) {
      const file = path.join(folder, `${base}${n ? `-${n}` : ''}.md`); noSymlinks(file);
      try { fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' }); return file; } catch (error) { if (error.code !== 'EEXIST' || n > 99) throw error; }
    }
  } catch { return null; }
}
// One of his own two texts, this computer's and the other's: same, take theirs, keep this one,
// or both changed since they last agreed (over), when the newer edit wins. A computer that never
// agreed with the other takes its text when it has none, and gives its own when the other has none.
function decide(here, there, agreed) {
  if (there.hash === here.hash) return 'same';
  if (agreed === here.hash) return 'take';
  if (agreed === there.hash) return 'keep';
  if (agreed === undefined && !here.text.trim()) return 'take';
  if (agreed === undefined && !there.text.trim()) return 'keep';
  return there.at > here.at || (there.at === here.at && there.hash > here.hash) ? 'take over' : 'keep over';
}
// A learned line as two computers have it: the newer change of the two (on or off) holds, a
// line taken out wins a tie, and the line keeps the words and the date it was first learned with.
function mergeLine(here, there) {
  if (!here) return { ...there };
  const first = there.since < here.since || (there.since === here.since && there.line < here.line) ? there : here;
  const newer = there.at > here.at || (there.at === here.at && !there.on && here.on) ? there : here;
  return { line: first.line, since: Math.min(here.since, there.since), at: newer.at, on: newer.on };
}
const ordered = lines => Object.entries(lines).filter(([, row]) => row.on).sort(([a, x], [b, y]) => x.since - y.since || (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row.line);

// What another computer of the owner's sent for this project, put together with what this one
// has, and written here. peer: that computer's key; theirs: its { instructions, own, learned }
// (cleanNotes); who: how the lines name it ("@devbox"). Returns the lines to say: one for each
// text that both changed, naming where the one that lost is kept; and whether anything changed.
export function mergeNotes(root, peer, theirs, { now = Date.now(), who = 'your other computer', project = path.basename(root) } = {}) {
  return changingSettings(() => {
    const store = readStore(), here = look(root, store, now), row = here.row, agreed = isObject(row.agreed[peer]) ? { ...row.agreed[peer] } : {}, said = [];
    const mine = { instructions: { text: here.instructions, ...row.instructions }, own: { text: here.own, ...row.own } };
    const next = {};
    for (const part of ['instructions', 'own']) {
      const there = { text: theirs[part].text, hash: textHash(theirs[part].text), at: theirs[part].at };
      const choice = decide(mine[part], there, typeof agreed[part] === 'string' ? agreed[part] : undefined);
      if (choice === 'same') { agreed[part] = there.hash; next[part] = { text: mine[part].text, hash: there.hash, at: Math.max(mine[part].at, there.at) }; continue; }
      const take = choice === 'take' || choice === 'take over';
      next[part] = take ? there : mine[part];
      if (take) agreed[part] = there.hash;
      if (!choice.endsWith('over')) continue;
      // Both changed it: the text that lost is kept once, and said once.
      const lost = take ? mine[part] : there;
      if (!lost.text.trim() || row.kept.includes(lost.hash)) continue;
      const file = keep(root, part === 'instructions' ? 'instructions' : 'context', part === 'own' ? `${lost.text}\n` : lost.text, now);
      row.kept = [...row.kept, lost.hash].slice(-KEPT);
      const what = part === 'instructions' ? 'Instructions' : 'Context', place = file ? ` The other is in ${tilde(file)}.` : '';
      said.push(`${what} of ${project} changed here and on ${who}: the newer, ${take ? `from ${who}` : "this computer's"}, is in use.${place}`);
    }
    const lines = { ...row.learned };
    for (const item of theirs.learned) { const key = learnedKey(item.line); if (key) lines[key] = mergeLine(lines[key], item); }
    // What changes on disk: each text that is not what is in force now.
    const instructions = next.instructions.text, context = composeContext(next.own.text, ordered(lines));
    const before = savedText(trustedText(root, 'instructions.md') ?? ''), was = savedText(trustedText(root, 'context.md') ?? '');
    let changed = false;
    if (savedText(instructions) !== before) { syncText(root, 'instructions.md', instructions); changed = true; }
    // The same own text and the same lines, in another order, is the same context: it is left as it is.
    const held = splitContext(was), sorted = list => [...list].sort();
    const same = held.own === next.own.text && JSON.stringify(sorted(held.learned.map(item => item.line))) === JSON.stringify(sorted(ordered(lines)));
    if (savedText(context) !== was && !same) { syncText(root, 'context.md', context); changed = true; }
    // The record holds what is in force now, each part with the time its text came to be.
    Object.assign(row, { instructions: { hash: next.instructions.hash, at: next.instructions.at }, own: { hash: next.own.hash, at: next.own.at }, learned: lines });
    row.agreed = { ...row.agreed, [peer]: agreed };
    row.sig = textHash(`${savedText(trustedText(root, 'instructions.md') ?? '')}\0${savedText(trustedText(root, 'context.md') ?? '')}`);
    store.projects[realRoot(root)] = row; save(store);
    return { said, changed };
  });
}

const tilde = file => { const home = os.homedir(); return file === home || file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file; };

// An edit of the context the owner saves in the Projects tab, made from the text he opened
// (before), and saved as any save there is (saveContext). Lines learned while he edited, here
// or on another computer of his, are not taken out by it: they are added after his. Only the
// learned lines he took out himself go. Returns the text saved.
export function saveContextEdit(root, before, after) {
  return changingSettings(() => {
    const opened = new Set(splitContext(savedText(before)).learned.map(item => item.key)), edited = splitContext(savedText(after));
    const held = new Set(edited.learned.map(item => item.key)), lines = edited.learned.map(item => item.line);
    const meanwhile = splitContext(savedText(trustedText(root, 'context.md') ?? '')).learned.filter(item => !opened.has(item.key) && !held.has(item.key) && held.add(item.key));
    if (!meanwhile.length) return saveContext(root, after);
    return saveContext(root, composeContext(edited.own, [...lines, ...meanwhile.map(item => item.line)]));
  });
}
