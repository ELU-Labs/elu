import { EluCodeError } from './util.mjs';
import { adapterFor } from './adapters/index.mjs';

// A review always fits the vendor of the bot that makes it. Each adapter declares the longest
// input its vendor takes, in characters (inputChars: Codex 1,048,576, Claude by its model's
// context window, Grok Build 768,000, Antigravity what it keeps of a prompt). A review is cut
// before it is sent so that each part, with the rest of its prompt, stays at most HEADROOM of
// that: by files, and a file whose diff alone is longer by its hunks, and a hunk by its lines.
// The parts' findings are one review (mergeParts). A vendor that still says a part is too long
// has it split again (reviewInParts), never a failure: only a piece too small to split is left.
//
// Tests give a vendor a smaller limit here (fitClock.limits: { codex: 40000 }); nothing else does.
export const fitClock = { limits: null };
export const HEADROOM = 0.7;
// A piece of a diff this short is not split again: the vendor that refuses it is refusing
// something else of the prompt.
export const PIECE_MIN = 2000;
// What a prompt holds besides the change: ELU's rules, the project's instructions, the schema.
export const PROMPT_REST = 40000;

export function inputLimit(vendor, model = null) {
  const given = fitClock.limits?.[vendor];
  if (Number.isSafeInteger(given) && given > 0) return given;
  try { const value = adapterFor(vendor).inputChars?.(model ?? null); return Number.isSafeInteger(value) && value > 0 ? value : Infinity; } catch { return Infinity; }
}
// The characters a review's change may take of that limit, after rest: what else its context
// holds (the checks, earlier reviews, the answers to them, the session's goal).
export function reviewBudget(limit, rest = 0) {
  if (!Number.isFinite(limit)) return Infinity;
  return Math.max(PIECE_MIN, Math.floor(limit * HEADROOM) - PROMPT_REST - Math.max(0, rest));
}
export const OVER_LIMIT = "This part is longer than the bot's vendor takes, so it was not sent.";
export const overLimit = () => new EluCodeError(OVER_LIMIT, { cause: 'too-long', unsent: true });

// A diff, by file: each section from its "diff --git" line, keyed by the path it changes to
// (the path it had, for a deleted file). Sections Git writes for one path twice are joined.
export function patchesOf(diffText) {
  const out = new Map();
  for (const section of String(diffText ?? '').split(/^(?=diff --git )/m)) {
    if (!section.startsWith('diff --git ')) continue;
    const to = /^\+\+\+ b\/(.+)$/m.exec(section)?.[1], from = /^--- a\/(.+)$/m.exec(section)?.[1], head = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
    const file = (to && to !== '/dev/null' ? to : null) ?? (from && from !== '/dev/null' ? from : null) ?? head?.[2] ?? head?.[1];
    if (!file) continue;
    out.set(file, `${out.get(file) ?? ''}${section.endsWith('\n') ? section : `${section}\n`}`);
  }
  return out;
}
// One file's diff in pieces of at most budget characters each, every piece a diff of its own
// that starts with the file's header: whole hunks together, a hunk too long in pieces of its
// lines (each with its own @@ line, counted as Git counts it), and a line too long for any
// piece cut, with a mark that says how long it was. A diff with no hunk (a binary file, a mode
// change) is one piece.
export function splitPatch(patch, budget) {
  const text = String(patch ?? ''), lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const first = lines.findIndex(line => line.startsWith('@@'));
  if (first < 0) return [text];
  const header = `${lines.slice(0, first).join('\n')}\n`, room = Math.max(400, budget - header.length);
  const hunks = [];
  for (const line of lines.slice(first)) { if (line.startsWith('@@') || !hunks.length) hunks.push([line]); else hunks.at(-1).push(line); }
  const units = hunks.flatMap(hunk => { const whole = `${hunk.join('\n')}\n`; return whole.length <= room ? [whole] : hunkPieces(hunk, room); });
  const pieces = [];
  let body = '';
  for (const unit of units) { if (body && body.length + unit.length > room) { pieces.push(header + body); body = ''; } body += unit; }
  if (body) pieces.push(header + body);
  return pieces;
}
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
function hunkPieces(hunk, room) {
  const found = HUNK.exec(hunk[0]), tail = found?.[3] ?? '', most = room - 120, out = [];
  let old = Number(found?.[1] ?? 1), now = Number(found?.[2] ?? 1), rows = [], size = 0, from = { old, now }, counts = { old: 0, now: 0 };
  const flush = () => { if (!rows.length) return; out.push(`@@ -${from.old},${counts.old} +${from.now},${counts.now} @@${tail}\n${rows.join('\n')}\n`); rows = []; size = 0; from = { old, now }; counts = { old: 0, now: 0 }; };
  for (let line of hunk.slice(1)) {
    if (line.length > most) line = `${line.slice(0, Math.max(1, most - 80))} … (this line is cut here: it has ${line.length.toLocaleString('en-US')} characters)`;
    if (rows.length && size + line.length + 1 > most) flush();
    rows.push(line); size += line.length + 1;
    if (line.startsWith(' ')) { old++; now++; counts.old++; counts.now++; }
    else if (line.startsWith('-')) { old++; counts.old++; }
    else if (line.startsWith('+')) { now++; counts.now++; }
  }
  flush();
  return out;
}
// Files in parts of at most budget by cost(file), in order: a file longer than budget alone
// is a part of its own, which its diff's pieces then split (planParts).
export function packFiles(files, cost, budget) {
  const parts = [];
  let part = [], used = 0;
  for (const file of files) {
    const size = cost(file);
    if (part.length && used + size > budget) { parts.push(part); part = []; used = 0; }
    part.push(file); used += size;
  }
  if (part.length) parts.push(part);
  return parts;
}
// The parts a change is reviewed in before anything is sent, each { files, patch, piece }:
// packed by cost, and a file whose diff alone is longer than budget in pieces of its diff.
// piece: { at, of } of that file's pieces, for the note the bot is given.
// Packed to PACKED of budget: a part's text grows when it is written as JSON.
const PACKED = 0.85;
export function planParts(files, { patchOf, cost, budget }) {
  if (!Number.isFinite(budget)) return [{ files, patch: files.map(patchOf).join('') }];
  const room = Math.max(PIECE_MIN, Math.floor(budget * PACKED)), parts = [];
  // A file whole when it fits a part, else its diff alone.
  const sized = file => { const whole = cost(file); return whole <= room ? whole : patchOf(file).length + file.length + 64; };
  for (const list of packFiles(files, sized, room)) {
    const patch = list.map(patchOf).join('');
    if (list.length > 1 || patch.length <= room) { parts.push({ files: list, patch }); continue; }
    const pieces = splitPatch(patch, room);
    pieces.forEach((piece, at) => parts.push({ files: list, patch: piece, ...(pieces.length > 1 ? { piece: { at: at + 1, of: pieces.length } } : {}) }));
  }
  return parts;
}
// A list of files in two, in order, each about half of their size.
export function halves(list, size) {
  const sizes = list.map(size), total = sizes.reduce((sum, value) => sum + value, 0);
  let at = 1, sum = sizes[0];
  while (at < list.length - 1 && sum + sizes[at] <= total / 2) sum += sizes[at++];
  return [list.slice(0, at), list.slice(at)];
}
// review(part) for each part, in order, until one stops the review (an outcome other than
// done). A part its vendor says is too long is split again: its files in two, or one file's
// diff in two by its hunks and lines, until a piece is PIECE_MIN characters or less, which is
// then left (left: its paths). Returns { done, left, refused }: the results, the files no part
// of which could be reviewed, and the last refusal.
// A vendor that refuses part after part as too long is asked at most REFUSALS_MOST times in one
// review; a part it was not sent (unsent: longer than one it refused, or than its limit) counts none.
export const REFUSALS_MOST = 24;
export async function reviewInParts(parts, { review, patchOf, cost }) {
  const done = [], reviewed = new Set(), failedFiles = new Set();
  let stop = false, refused = null, refusals = 0;
  const attempt = async part => {
    if (stop) return;
    if (refusals >= REFUSALS_MOST) { for (const file of part.files) failedFiles.add(file); return; }
    try { const result = await review(part); done.push(result); for (const file of part.files) reviewed.add(file); stop = result.outcome !== 'done'; return; }
    catch (error) { if (error?.details?.cause !== 'too-long') throw error; refused = error; if (!error.details.unsent) refusals++; }
    if (part.files.length > 1) {
      const [one, two] = halves(part.files, cost);
      for (const list of [one, two]) await attempt({ files: list, patch: list.map(patchOf).join('') });
      return;
    }
    const pieces = part.patch.length > PIECE_MIN ? splitPatch(part.patch, Math.ceil(part.patch.length / 2)) : [];
    if (pieces.length > 1) { for (const piece of pieces) await attempt({ files: part.files, patch: piece, piece: { at: 0, of: 0, cut: true } }); return; }
    failedFiles.add(part.files[0]);
  };
  for (const part of parts) await attempt(part);
  return { done, left: [...failedFiles].filter(file => !reviewed.has(file)), refused };
}
// One review of the parts' results: each part's findings, numbered by part so no two share an
// ID; a part that stopped the review (needs_input, blocked) is the last, and its outcome is
// the review's.
export function mergeParts(done) {
  const last = done.at(-1), many = done.length > 1;
  return { ...done[0], outcome: last.outcome, summary: done.map(row => row.summary).filter(Boolean).join(' '), question: last.question ?? null, choices: last.choices ?? [],
    comments: done.flatMap((row, part) => (row.comments ?? []).map((comment, index) => many ? { ...comment, id: `part${part + 1}-${index + 1}` } : comment)), responses: done.flatMap(row => row.responses ?? []) };
}
// The note a part that is a piece of one file's diff carries.
export const pieceNote = (file, piece) => piece?.of > 1 ? `The diff of ${file} is too long for one part, so it is given in ${piece.of} pieces of whole hunks, or of a hunk's lines, each with its own @@ line; this is piece ${piece.at}.` : piece ? `The diff of ${file} is too long for one part, so it is given in pieces of whole hunks, or of a hunk's lines, each with its own @@ line; this is one of them.` : null;
