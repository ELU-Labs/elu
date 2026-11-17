import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, hash, isObject, mkdir, noSymlinks, personalDirectory, readJson } from './util.mjs';
import { LEARNED_HEADING, changingSettings, learnedSection, saveContext, savedText, syncText } from './project-settings.mjs';
import { trustedText } from './project-trust.mjs';
import { learnedKey } from './project-learnings.mjs';
import { ORG_HEADING, ORG_NOTE, orgBody, orgSection } from './org-section.mjs';

// A project's instructions and context are the owner's on every computer of his that has the
// project, as its tasks are: every model and bot there reads the same (lib/runner.mjs). His
// computers send them to each other (lib/peer/notes.mjs); this is each computer's own side of
// that: what it remembers of the two, how its version and another's are put together, and
// where the text that lost is kept.
//
// Each has two parts: his own text (the instructions, and the context outside the sections ELU
// keeps), and the lines of those sections: what he taught his sessions, under "Learned from
// you" (lib/project-learnings.mjs), and the findings about the organization he accepted, under
// "Organization" (lib/org-section.mjs). His own text is one text: when only one computer
// changed it since the two last agreed, that change is taken; when both did, the newer edit
// wins and the other text is kept in the project's .elu-code/history/. The lines of each
// section are a set: a line saved on any computer is on all of them, and so is a line he took
// out. Only text in force here is ever sent: text he approved on this computer, which an edit
// on another computer of his is (syncText).
//
// project-notes.json in ELU's folder: { version, projects: { <project folder>: { sig,
// instructions: { hash, at }, own: { hash, at }, learned: { <key>: { line, since, at, on } },
// org: { <key>: { line, since, at, on } }, agreed: { <computer key>: { instructions, own } },
// kept: [hash] } } }. at and since are milliseconds: when that text or line came to be (when
// this computer first saw it, or the time the computer it came from gave it), and since, when
// a line was first saved, which orders its section. agreed holds the hashes both computers
// last had alike. A record from before the Organization section has no org: it is read again
// from the file once (look).
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
  const set = lines => { const out = {}; for (const [key, value] of Object.entries(isObject(lines) ? lines : {})) if (isObject(value) && typeof value.line === 'string') out[key] = { line: value.line, since: stamp(value.since), at: stamp(value.at), on: value.on === true }; return out; };
  return { sig: typeof row.sig === 'string' ? row.sig : null, instructions: part(row.instructions), own: part(row.own), learned: set(row.learned), org: isObject(row.org) ? set(row.org) : null, agreed: isObject(row.agreed) ? row.agreed : {}, kept: Array.isArray(row.kept) ? row.kept.filter(item => typeof item === 'string') : [] };
}

// The context in its parts: the owner's own text, and each line that holds anything of the
// learned section (learned) and of the Organization section (org), with the key it is known by
// on every computer. The own text goes without the two sections and without blank lines at
// its end.
export function splitContext(text) {
  const { lines, start, end } = learnedSection(text), kept = orgSection(text);
  const inside = at => (start >= 0 && at >= start && at < end) || (kept.start >= 0 && at >= kept.start && at < kept.end);
  const own = lines.filter((line, at) => !inside(at)).join('\n').replace(/\s+$/, '');
  const rows = list => list.map(line => ({ key: learnedKey(line), line: line.trimEnd() })).filter(row => row.key);
  return { own, learned: start < 0 ? [] : rows(lines.slice(start + 1, end).filter(line => line.trim())), org: rows(orgBody(kept.lines, kept.start, kept.end)) };
}
// The context again: his own text, then the Organization section when it has lines (org),
// under the sentence that says what they are, then the learned section with its lines.
export function composeContext(own, lines, org = []) {
  const top = String(own ?? '').replace(/\s+$/, ''), parts = top ? [top] : [];
  if (org.length) parts.push(`${ORG_HEADING}\n\n${ORG_NOTE}\n\n${org.join('\n')}`);
  if (lines.length) parts.push(`${LEARNED_HEADING}\n\n${lines.join('\n')}`);
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}
// His own text as another computer sent it, without an Organization section: an ELU from
// before that section keeps it inside his text, and here it is a section of its own.
function ownOnly(text) {
  const { lines, start, end } = orgSection(text);
  return (start < 0 ? String(text ?? '') : [...lines.slice(0, start), ...lines.slice(end)].join('\n')).replace(/\s+$/, '');
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
// last written), a line of a kept section that came is on from now, and one that went is off
// from now. A record with no org yet is brought up to date even when nothing changed.
// { instructions: { text, hash, at }, own: { text, hash, at }, learned: [{ line, since, at, on }], org: the same }
function look(root, store, now) {
  const instructions = savedText(trustedText(root, 'instructions.md') ?? ''), context = savedText(trustedText(root, 'context.md') ?? '');
  const key = realRoot(root), row = rowOf(store, key), sig = textHash(`${instructions}\0${context}`), first = row.sig === null;
  const { own, learned, org } = splitContext(context);
  if (row.sig !== sig || row.org === null) {
    const ih = textHash(instructions), oh = textHash(own);
    if (row.instructions?.hash !== ih) row.instructions = { hash: ih, at: first ? fileTime(root, 'instructions.md') ?? now : now };
    if (row.own?.hash !== oh) row.own = { hash: oh, at: first ? fileTime(root, 'context.md') ?? now : now };
    row.org ??= {};
    for (const [held, found] of [[row.learned, learned], [row.org, org]]) {
      const here = new Set();
      found.forEach(({ key: name, line }, index) => {
        here.add(name);
        const kept = held[name];
        if (!kept) { const since = dayOf(line, now) + index; held[name] = { line, since, at: first ? since : now, on: true }; }
        else if (!kept.on) held[name] = { ...kept, line, at: now, on: true };
      });
      for (const [name, kept] of Object.entries(held)) if (kept.on && !here.has(name)) held[name] = { ...kept, at: now, on: false };
    }
    row.sig = sig; store.projects[key] = row; return { row, instructions, own, changed: true };
  }
  return { row, instructions, own, changed: false };
}
const save = store => atomic(FILE(), store);
export function localNotes(root, { now = Date.now() } = {}) {
  return changingSettings(() => {
    const store = readStore(), { row, instructions, own, changed } = look(root, store, now);
    if (changed) save(store);
    // A project with no Organization line, kept or taken out, says nothing of that section.
    const org = Object.values(row.org).map(item => ({ ...item }));
    return { instructions: { text: instructions, ...row.instructions }, own: { text: own, ...row.own }, learned: Object.values(row.learned).map(item => ({ ...item })), ...(org.length ? { org } : {}) };
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
// A line of a kept section as two computers have it: the newer change of the two (on or off)
// holds, a line taken out wins a tie, and the line keeps the words and the date it was first
// saved with.
function mergeLine(here, there) {
  if (!here) return { ...there };
  const first = there.since < here.since || (there.since === here.since && there.line < here.line) ? there : here;
  const newer = there.at > here.at || (there.at === here.at && !there.on && here.on) ? there : here;
  return { line: first.line, since: Math.min(here.since, there.since), at: newer.at, on: newer.on };
}
const ordered = lines => Object.entries(lines).filter(([, row]) => row.on).sort(([a, x], [b, y]) => x.since - y.since || (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row.line);

// What another computer of the owner's sent for this project, put together with what this one
// has, and written here. peer: that computer's key; theirs: its { instructions, own, learned,
// org? } (cleanNotes); who: how the lines name it ("@devbox"). Returns the lines to say: one for
// each text that both changed, naming where the one that lost is kept; and whether anything changed.
export function mergeNotes(root, peer, theirs, { now = Date.now(), who = 'another computer', project = path.basename(root) } = {}) {
  return changingSettings(() => {
    const store = readStore(), here = look(root, store, now), row = here.row, agreed = isObject(row.agreed[peer]) ? { ...row.agreed[peer] } : {}, said = [];
    const mine = { instructions: { text: here.instructions, ...row.instructions }, own: { text: here.own, ...row.own } };
    const next = {};
    for (const part of ['instructions', 'own']) {
      // His own text is read as this computer reads its own (splitContext): with no blank end,
      // so the same text is the same on both and is never taken for a change made on both.
      const text = part === 'own' ? ownOnly(theirs[part].text) : theirs[part].text;
      const there = { text, hash: textHash(text), at: theirs[part].at };
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
      const what = part === 'instructions' ? 'Instructions' : 'Memory', place = file ? ` The other is in ${tilde(file)}.` : '';
      said.push(`${what} of ${project} changed here and on ${who}: the newer, ${take ? `from ${who}` : "this computer's"}, is in use.${place}`);
    }
    const lines = { ...row.learned }, found = { ...row.org };
    for (const item of theirs.learned) { const key = learnedKey(item.line); if (key) lines[key] = mergeLine(lines[key], item); }
    for (const item of Array.isArray(theirs.org) ? theirs.org : []) { const key = learnedKey(item.line); if (key) found[key] = mergeLine(found[key], item); }
    // What changes on disk: each text that is not what is in force now.
    const instructions = next.instructions.text, context = composeContext(next.own.text, ordered(lines), ordered(found));
    const before = savedText(trustedText(root, 'instructions.md') ?? ''), was = savedText(trustedText(root, 'context.md') ?? '');
    let changed = false;
    if (savedText(instructions) !== before) { syncText(root, 'instructions.md', instructions); changed = true; }
    // The same own text and the same lines, in another order, is the same context: it is left as it is.
    const held = splitContext(was), sorted = list => [...list].sort(), alike = (rows, list) => JSON.stringify(sorted(rows.map(item => item.line))) === JSON.stringify(sorted(list));
    const same = held.own === next.own.text && alike(held.learned, ordered(lines)) && alike(held.org, ordered(found));
    if (savedText(context) !== was && !same) { syncText(root, 'context.md', context); changed = true; }
    // The record holds what is in force now, each part with the time its text came to be.
    Object.assign(row, { instructions: { hash: next.instructions.hash, at: next.instructions.at }, own: { hash: next.own.hash, at: next.own.at }, learned: lines, org: found });
    row.agreed = { ...row.agreed, [peer]: agreed };
    row.sig = textHash(`${savedText(trustedText(root, 'instructions.md') ?? '')}\0${savedText(trustedText(root, 'context.md') ?? '')}`);
    store.projects[realRoot(root)] = row; save(store);
    return { said, changed };
  });
}

const tilde = file => { const home = os.homedir(); return file === home || file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file; };

// The computers the project at root traded its instructions and context with: their keys.
export function notesAgreed(root) {
  return Object.keys(rowOf(readStore(), realRoot(root)).agreed).filter(key => /^[0-9a-f]{64}$/.test(key));
}
// Lessons that are not the project at root's (remove: [{ key, line }]) taken out of its context,
// and note added at the end of the owner's own text when it is not there yet; nothing else of
// his text changes, and the Organization section stays as it is. Written as a text from
// another computer of his is (syncText), so a file that waits for his review is not written
// over. One it does not have is kept as taken out from now (on: false), so it does not come to
// it from another computer that still has it, and that one takes it out too. Returns the
// lines taken out.
export function putBackContext(root, { remove = [], note = null, now = Date.now() } = {}) {
  return changingSettings(() => {
    const was = savedText(trustedText(root, 'context.md') ?? ''), { own, learned, org } = splitContext(was), out = new Set(remove.map(item => item.key));
    const kept = learned.filter(item => !out.has(item.key)), noted = note && !own.includes(note) ? `${own ? `${own}\n\n` : ''}${note}` : own;
    if (kept.length !== learned.length || noted !== own) syncText(root, 'context.md', composeContext(noted, kept.map(item => item.line), org.map(item => item.line)));
    const store = readStore(), key = realRoot(root), row = rowOf(store, key), had = new Set(learned.map(item => item.key));
    const missing = remove.filter(item => !had.has(item.key) && !row.learned[item.key]);
    if (missing.length) { for (const item of missing) row.learned[item.key] = { line: item.line, since: dayOf(item.line, now), at: now, on: false }; store.projects[key] = row; save(store); }
    return learned.filter(item => out.has(item.key)).map(item => item.line);
  });
}

// An edit of the context the owner saves in the Projects tab, made from the text he opened
// (before), and saved as any save there is (saveContext). Lines learned while he edited, here
// or on another computer of his, are not taken out by it: they are added after his. Only the
// learned lines he took out himself go. The same holds for the lines of the Organization
// section. Returns the text saved.
export function saveContextEdit(root, before, after) {
  return changingSettings(() => {
    const opened = splitContext(savedText(before)), edited = splitContext(savedText(after)), now = splitContext(savedText(trustedText(root, 'context.md') ?? ''));
    const meanwhile = part => { const had = new Set(opened[part].map(item => item.key)), held = new Set(edited[part].map(item => item.key)); return now[part].filter(item => !had.has(item.key) && !held.has(item.key) && held.add(item.key)); };
    const learned = meanwhile('learned'), org = meanwhile('org'), lines = (rows, more) => [...rows, ...more].map(item => item.line);
    if (!learned.length && !org.length) return saveContext(root, after);
    return saveContext(root, composeContext(edited.own, lines(edited.learned, learned), lines(edited.org, org)));
  });
}
