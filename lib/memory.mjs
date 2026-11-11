import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The owner's Claude Code memory for a folder: the notes Claude Code keeps in
// ~/.claude/projects/<folder>/memory and loads into a new session there, plus the owner's
// ~/.claude/CLAUDE.md and the folder's CLAUDE.md. The lead may not read ~/.claude, so a run
// gets a private read-only copy of the memory folder, removed when the run ends.
const LINES = 200, BYTES = 25000;
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const memorySlug = folder => folder.replace(/[^A-Za-z0-9]/g, '-');
export const memoryFolder = root => path.join(claudeDir(), 'projects', memorySlug(root), 'memory');
// Claude Code loads the first 200 lines of the index.
export function clipNotes(text) {
  const lines = String(text).split('\n'), kept = lines.slice(0, LINES).join('\n');
  const clipped = Buffer.byteLength(kept) > BYTES ? Buffer.from(kept).subarray(0, BYTES).toString('utf8').replace(/�$/, '') : kept;
  return clipped + (clipped.length < String(text).length ? '\n[Truncated.]' : '');
}
const readFile = file => { try { return fs.lstatSync(file).isFile() ? fs.readFileSync(file, 'utf8') : ''; } catch { return ''; } };
export function copyMemory(root) {
  const source = memoryFolder(root), user = readFile(path.join(claudeDir(), 'CLAUDE.md')), project = readFile(path.join(root, 'CLAUDE.md'));
  let names = [];
  try { names = fs.readdirSync(source, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => entry.name); } catch { /* No memory for this folder. */ }
  if (!names.length && !user.trim() && !project.trim()) return null;
  let folder = null, dir = null, index = '';
  if (names.length) {
    folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-memory-'))); fs.chmodSync(folder, 0o700);
    dir = path.join(folder, 'memory'); fs.mkdirSync(dir, { mode: 0o700 });
    try {
      for (const name of names) fs.writeFileSync(path.join(dir, name), readFile(path.join(source, name)), { mode: 0o600, flag: 'wx' });
      index = names.includes('MEMORY.md') ? fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8') : '';
    } catch (error) { fs.rmSync(folder, { recursive: true, force: true }); throw error; }
  }
  return { folder, dir, index, user, project };
}
