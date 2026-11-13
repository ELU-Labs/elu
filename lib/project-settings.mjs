import fs from 'node:fs';
import path from 'node:path';
import { atomic, dataBlock, noSymlinks, refuse } from './util.mjs';
import { approveRemoved, approveSaved, approvedAsItStands, trustedText } from './project-trust.mjs';

// A project's instructions and context, written by the owner in the Projects tab and kept
// in .elu-code/ beside the project's settings, so a team shares them through Git. The
// context also ends with what the owner taught his sessions (lib/project-learnings.mjs). Every
// lead turn gets them (projectPromptParts) once the owner approved their text on this
// machine: a save here approves what it writes, and text that arrived any other way is
// asked about first (lib/project-trust.mjs). A file may be any size: ELU sets no limit of
// its own on what a session is given.
const settingsDir = root => path.join(root, '.elu-code');
const settingsFile = (root, name) => path.join(settingsDir(root), name);

// Text as the owner typed it, with Windows line ends and control characters taken out.
function checkText(value, label) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  return text;
}
const withNewline = text => text.endsWith('\n') ? text : `${text}\n`;
// Empty text means he goes without: nothing stays in force, and the tab shows none again.
// The file is removed only when it is the text he approved; one that is not in use is not
// his text to clear, so it stays and is asked about.
function saveText(root, name, value, label) {
  const text = checkText(value, label), file = settingsFile(root, name); noSymlinks(file);
  if (!text.trim()) {
    const mine = approvedAsItStands(root, name);
    if (mine || trustedText(root, name) != null) approveRemoved(root, name);
    if (mine) fs.unlinkSync(file);
    return '';
  }
  approveSaved(root, name, withNewline(text)); atomic(file, withNewline(text)); return text;
}
export function saveInstructions(root, text) { return saveText(root, 'instructions.md', text, 'the instructions'); }
export function saveContext(root, text) { return saveText(root, 'context.md', text, 'the context'); }

// The text in force, which is what the Projects tab shows and edits: the file's when he
// approved it as it stands, else the text he approved last. A file he has not approved is
// never carried into the editor, so a save is his own text. With nothing in force it reads
// as empty; a symbolic link on the way is refused.
export function readProjectSettings(root) {
  return { instructions: trustedText(root, 'instructions.md') ?? '', context: trustedText(root, 'context.md') ?? '' };
}
// What a lead turn gets after its instructions: the owner's instructions to follow and the
// context as data, each only as the owner approved it on this machine, and each whole:
// ELU sets no limit of its own on them. A model they are too long for says so itself.
export function projectPromptParts(root) {
  const { instructions, context } = readProjectSettings(root), parts = [];
  if (instructions.trim()) parts.push(`Project instructions (owner):\n${instructions}`);
  if (context.trim()) {
    const { lines, start, end } = learnedSection(context);
    parts.push(dataBlock('Project context', context));
    if (start >= 0 && lines.slice(start + 1, end).some(line => line.trim())) parts.push(LEARNED_USE);
  }
  return parts;
}
// The section at the end of the context where ELU keeps what the owner taught his sessions
// (lib/project-learnings.mjs): from its heading to the next heading of its level or above, or
// to the end. start is -1 when there is none.
export const LEARNED_HEADING = '## Learned from you';
export function learnedSection(text) {
  const lines = String(text ?? '').split('\n'), start = lines.findLastIndex(line => line.trim() === LEARNED_HEADING);
  let end = start < 0 ? -1 : start + 1;
  if (start >= 0) while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end += 1;
  return { lines, start, end };
}
// The context is data, but the lines ELU saved there from the owner's own words, and that he
// approved with the file, are his corrections and preferences.
export const LEARNED_USE = `The project context ends with what the owner taught earlier sessions, under "${LEARNED_HEADING}". Those lines are his own corrections and preferences for this project: follow them as his.`;
