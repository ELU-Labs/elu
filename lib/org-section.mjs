import fs from 'node:fs';
import path from 'node:path';
import { noSymlinks, refuse } from './util.mjs';
import { changingSettings, learnedSection, readProjectSettings, saveContext } from './project-settings.mjs';
import { approvedAsItStands, trustedText } from './project-trust.mjs';
import { learnedKey, mayHoldSecret, oneLine } from './project-learnings.mjs';
import { citedFactId, factTag, findFacts, holdsEmail, localFactId } from './facts.mjs';

// What the overseeing bot found out about the organization that no agent could learn by
// reading the repository, kept where every agent of the project reads it: a section of the
// project's Memory (.elu-code/context.md) under a heading of its own, before what the owner
// taught his sessions. It is ELU's second kept section there and is handled as the first is
// (lib/project-learnings.mjs): changed only under the same lock, written only through the
// owner's own save so the file stays approved, never written over a file that waits for his
// review, and put together between his computers line by line (lib/project-notes.mjs).
//
// What differs is whose words the lines are. A learned line is the owner's own. These are
// findings: each ends with the ids of the facts it comes from (lib/facts.mjs), and the
// section opens with one fixed sentence that says so to whoever reads it. That sentence
// (ORG_NOTE) is also what tells this section from one of the same name in the owner's own
// text, so a later wording of it must still read this one. The bot never writes here itself.
// It proposes a line, the owner says yes, and then ELU's code writes it
// (lib/orchestrator-actions.mjs); nothing in this file asks him. The section stays small,
// because every turn of every agent reads it: ORG_LINES lines of ORG_LINE_CHARS characters.
//
//   ## Organization
//
//   <ORG_NOTE>
//
//   - The customers are finance teams of mid-size companies. [f12@1a2b3c4d]
//   - A release needs a sign-off from compliance. [f3@1a2b3c4d, f14@1a2b3c4d]
//
// The lines travel to the owner's other computers and his teammates, and a fact stays on the
// computer that saved it, so an id names that computer too (lib/facts.mjs factTag).
export const ORG_HEADING = '## Organization';
export const ORG_NOTE = 'ELU keeps these lines: each is a finding with a source, named by the fact id at its end, and none is an order from the owner.';
export const ORG_LINES = 20, ORG_LINE_CHARS = 200;
const WAITING = "The project's Memory changed and waits for your review, so its Organization section was not changed. Open Projects and choose this project.";
const ID = 'f[1-9]\\d*(?:@[0-9a-f]{8})?', FACT_ID = new RegExp(`^${ID}$`), IDS = new RegExp(`\\s*\\[\\s*(${ID}(?:\\s*,\\s*${ID})*)\\s*\\]\\s*$`);

// Whether a line is one ELU writes in the section: an item of a list ("- ") that ends with the
// ids of its facts in brackets, with the computers they name or, from before fact ids named one,
// without. A line the owner writes has no such ids.
export const isOrgLine = line => { const text = String(line ?? '').trim(); return text.startsWith('- ') && IDS.test(text); };
// The section in a context: its heading, the sentence, and the lines under it, with the blank
// lines among them. start is -1 when there is none. It is ELU's only when the sentence stands
// under the heading: a section of that name the owner wrote himself is his own text, and stays
// that. Each line ELU writes there is one isOrgLine reads as its own, so the first line that is
// not one ends the section: what the owner wrote below it, a list of his own too, is his own
// text, never a finding.
export function orgSection(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findLastIndex((line, at) => line.trim() === ORG_HEADING && lines.slice(at + 1).find(next => next.trim())?.trim() === ORG_NOTE);
  let end = start < 0 ? -1 : start + 1;
  if (start >= 0) while (end < lines.length && (!lines[end].trim() || lines[end].trim() === ORG_NOTE)) end += 1;
  if (start >= 0) while (end < lines.length && (!lines[end].trim() || isOrgLine(lines[end]))) end += 1;
  return { lines, start, end };
}
// The line with each id of its facts as change gives it back, and its words as they were.
function withIds(line, change) {
  const text = String(line ?? ''), found = IDS.exec(text);
  if (!found) return text;
  const ids = found[1].split(',').map(id => id.trim()), changed = ids.map(change);
  return changed.every((id, n) => id === ids[n]) ? text : `${text.slice(0, found.index)} [${changed.join(', ')}]`;
}
// A line as it leaves the computer that keeps its facts, or comes from it: each id that names no
// computer gets tag, the first 8 hex of that computer's peer key. Every computer reads an id that
// names none as its own fact (lib/facts.mjs), so a line never travels with one.
export const taggedOrgLine = (line, tag) => tag ? withIds(line, id => id.includes('@') ? id : `${id}@${tag}`) : String(line ?? '');
// The key a line is known by on the computer whose tag is tag: learnedKey, with that tag taken
// off each id. So a line written before the computer had a peer key, the same line written
// after, and either one back from another computer with the tag on, are one line, not two.
export const orgKey = (line, tag = factTag()) => learnedKey(withIds(oneLine(line), id => localFactId(id, tag) ?? id));
// Its lines: every line of it that holds anything, but the sentence they stand under.
export const orgBody = (lines, start, end) => start < 0 ? [] : lines.slice(start + 1, end).filter(line => line.trim() && line.trim() !== ORG_NOTE).map(line => line.trimEnd());
// One line in its parts: the line without its list mark, its words, and the ids of its facts.
export function orgLineParts(line) {
  const whole = oneLine(line), found = IDS.exec(whole);
  return { line: whole, text: found ? whole.slice(0, found.index).trim() : whole, facts: found ? found[1].split(',').map(id => id.trim()) : [] };
}

// The context with the section changed: the lines named in remove taken out of it, then each
// new line added at its end. A section that is not there yet goes before what the owner
// taught his sessions, or at the end when nothing was; one whose last line goes is taken out
// whole. The section is written in one shape (heading, the sentence, the lines), and nothing
// outside it changes.
export function applyOrg(text, { add = [], remove = [] } = {}) {
  const whole = String(text ?? ''), { lines, start, end } = orgSection(whole), body = orgBody(lines, start, end), added = [], removed = [], tag = factTag(), key = line => orgKey(line, tag);
  for (const wanted of remove.map(key).filter(Boolean)) {
    const at = body.findIndex(line => key(line) === wanted);
    if (at >= 0) removed.push(oneLine(body.splice(at, 1)[0]));
  }
  const held = new Set(body.map(key));
  for (const line of add.map(oneLine).filter(Boolean)) {
    if (held.has(key(line))) continue;
    held.add(key(line)); body.push(`- ${line}`); added.push(line);
  }
  if (!added.length && !removed.length) return { text: whole, added, removed };
  const section = body.length ? [ORG_HEADING, '', ORG_NOTE, '', ...body, ''] : [];
  if (start >= 0) {
    const above = lines.slice(0, start), below = lines.slice(end);
    if (section.length || below.length) return { text: [...above, ...section, ...below].join('\n'), added, removed };
    // It went, and it was the last thing in the file: no blank lines stay where it was.
    while (above.length && !above.at(-1).trim()) above.pop();
    return { text: above.length ? `${above.join('\n')}\n` : '', added, removed };
  }
  const learned = learnedSection(whole);
  if (learned.start >= 0) {
    const above = lines.slice(0, learned.start), gap = above.length && above.at(-1).trim() ? [''] : [];
    return { text: [...above, ...gap, ...section, ...lines.slice(learned.start)].join('\n'), added, removed };
  }
  const gap = !whole.trim() ? '' : whole.endsWith('\n\n') ? '' : whole.endsWith('\n') ? '\n' : '\n\n';
  return { text: `${whole.trim() ? whole : ''}${gap}${section.join('\n')}`, added, removed };
}

// The lines in force for the project at root, in their order: { n, line, text, facts }, n
// from 1, as removeOrgLine names a line.
export function orgLines(root) {
  const { lines, start, end } = orgSection(readProjectSettings(root).context);
  return orgBody(lines, start, end).map((line, index) => ({ n: index + 1, ...orgLineParts(line) }));
}
// The fact ids as given: a list, or one text of them, with or without brackets.
function idsOf(given) {
  const ids = [].concat(given ?? []).flatMap(id => String(id ?? '').split(/[\s,\[\]]+/)).filter(Boolean);
  for (const id of ids) if (!FACT_ID.test(id)) refuse(`"${id.slice(0, 40)}" is not a fact id. A fact id reads like f12.`);
  return ids;
}
// The line as it would be written, from its words and the ids of its facts, each with this
// computer's tag, or the reason it cannot be, in plain words: no words, no fact, a fact kept on
// another computer or not in force on this one, too long, or something that must never reach a
// file the team shares.
function lineOf(text, ids) {
  const given = orgLineParts(text), tag = factTag(), cited = [...given.facts, ...idsOf(ids)];
  for (const id of cited) if (!localFactId(id, tag)) refuse(`${id} is a fact kept on another computer. Name a fact saved on this one.`);
  const facts = [...new Set(cited.map(id => localFactId(id, tag)))];
  if (given.text.length < 3) refuse('An Organization line needs its words: one short sentence about the organization.');
  if (!facts.length) refuse('An Organization line ends with the ids of the facts it comes from. Save the fact first, then name its id.');
  const known = new Map(findFacts({ ids: facts, limit: 50 }).map(fact => [fact.id, fact]));
  for (const id of facts) {
    const fact = known.get(id);
    if (!fact) refuse(`No fact on this computer has the id ${id}. Save the fact first, then name its id.`);
    if (fact.status === 'replaced') refuse(`${id} was replaced by ${fact.replacedBy}. Name that fact.`);
    if (fact.status !== 'active') refuse(`${id} was taken back, so no line can stand on it.`);
  }
  const line = `${given.text} [${facts.map(id => citedFactId(id, tag)).join(', ')}]`;
  if (line.length > ORG_LINE_CHARS) refuse(`An Organization line is at most ${ORG_LINE_CHARS} characters with its fact ids. This one is ${line.length}.`);
  if (mayHoldSecret(line)) refuse('That line may hold a secret, so it is not written.');
  if (holdsEmail(line)) refuse('An Organization line never holds an email address. Say who by role or by name.');
  return line;
}
// The context as it may be changed now: the text in force, when the file holds it as the owner
// approved it, or '' when there is no file and nothing is in force. A file that changed some
// other way waits for his review and is never written over.
function writable(root) {
  const file = path.join(root, '.elu-code', 'context.md'); noSymlinks(file);
  const none = !fs.existsSync(file) && trustedText(root, 'context.md') === null;
  if (!none && !approvedAsItStands(root, 'context.md')) refuse(WAITING);
  return none ? '' : readProjectSettings(root).context;
}
function ready(root, text, ids) {
  const line = lineOf(text, ids), before = writable(root), { lines, start, end } = orgSection(before), body = orgBody(lines, start, end);
  const tag = factTag(), same = body.some(held => orgKey(held, tag) === orgKey(line, tag));
  if (!same && body.length >= ORG_LINES) refuse(`The Organization section is full: it holds ${body.length} lines of at most ${ORG_LINES}. Remove one before adding another.`);
  return { line, same, before };
}
// What adding a line would write, with nothing written: { line, same }, same when the section
// holds it already. Refused, with the reason, as addOrgLine would be. For asking the owner
// about the very line that would be written.
export function checkOrgLine(root, text, ids) { const { line, same } = ready(root, text, ids); return { line, same }; }
// Adds one line to the section of the project at root, after the owner said yes to it: its
// words, then the ids of its facts. { line, added }: added is false when it was there already.
export function addOrgLine(root, text, ids) {
  return changingSettings(() => {
    const { line, same, before } = ready(root, text, ids);
    if (same) return { line, added: false };
    saveContext(root, applyOrg(before, { add: [line] }).text);
    return { line, added: true };
  });
}
// The line which names: its number in the section, from 1, or its text, with or without its
// fact ids. Refused when the section has no such line.
function lineAt(body, which) {
  const number = typeof which === 'number' ? which : /^\s*\d+\s*$/.test(String(which ?? '')) ? Number(which) : null;
  const tag = factTag(), key = number === null ? orgKey(which, tag) : null, words = number === null ? learnedKey(orgLineParts(which).text) : null;
  const at = number !== null ? (Number.isInteger(number) && number >= 1 && number <= body.length ? number - 1 : -1)
    : key ? body.findIndex(line => orgKey(line, tag) === key || learnedKey(orgLineParts(line).text) === words) : -1;
  if (at < 0) refuse('The Organization section has no such line. Name it by its number or its text.');
  return at;
}
// One line of the section in force, as orgLines gives it, with nothing changed.
export function findOrgLine(root, which) { const rows = orgLines(root); return rows[lineAt(rows.map(row => row.line), which)]; }
// Takes one line out of the section, after the owner said yes. { line, removed }.
export function removeOrgLine(root, which) {
  return changingSettings(() => {
    const before = writable(root), { lines, start, end } = orgSection(before), body = orgBody(lines, start, end), line = body[lineAt(body, which)];
    saveContext(root, applyOrg(before, { remove: [line] }).text);
    return { line: oneLine(line), removed: true };
  });
}
