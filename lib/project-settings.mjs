import fs from 'node:fs';
import path from 'node:path';
import { atomic, dataBlock, noSymlinks, refuse } from './util.mjs';
import { clipNotes } from './memory.mjs';
import { approveRemoved, approveSaved, approvedAsItStands, trustedText } from './project-trust.mjs';

// A project's instructions and context, written by the owner in the Projects tab and kept
// in .elu-code/ beside the project's settings, so a team shares them through Git. Every
// lead turn gets them (projectPromptParts) once the owner approved their text on this
// machine: a save here approves what it writes, and text that arrived any other way is
// asked about first (lib/project-trust.mjs). Each file is at most 100 KB; a bigger save is
// refused with one line.
export const LIMIT = 100 * 1024;
const settingsDir = root => path.join(root, '.elu-code');
const settingsFile = (root, name) => path.join(settingsDir(root), name);

// Text as the owner typed it, with Windows line ends and control characters taken out.
function checkText(value, label) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  if (Buffer.byteLength(withNewline(text)) > LIMIT) refuse(`Keep ${label} under 100 KB.`);
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
// context as data, each only as the owner approved it on this machine. Long text is
// clipped the way Claude Code memory is.
export function projectPromptParts(root) {
  const { instructions, context } = readProjectSettings(root), parts = [];
  if (instructions.trim()) parts.push(`Project instructions (owner):\n${clipNotes(instructions)}`);
  if (context.trim()) parts.push(dataBlock('Project context', clipNotes(context)));
  return parts;
}
