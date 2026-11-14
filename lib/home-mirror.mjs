import fs from 'node:fs';
import path from 'node:path';
import { mkdir } from './util.mjs';

// Grok Build and Antigravity read their own settings from ~, so each runs under a home of
// ELU's. In Full access that home is a mirror of the owner's: every entry at the top of his
// home is a link there, so ~/.npmrc, ~/.config, ~/.ssh and the rest are his own files and a
// command signs in as one he types does. The folders of coding tools are not linked: the
// vendor would load them as settings of its own. The real Grok Build 1.0.77 with HOME set to
// a home holding them, GROK_HOME elsewhere and every switch for another tool's files off,
// lists that home's Claude and Cursor instructions, rules, skills and MCP servers as switched
// off, and still loads its Claude agents, a Claude plugin with its hook, the permission rules
// of its Claude settings file, its .agents skills and its ~/.grok agents
// (test/grok-real.test.mjs).
export const TOOL_HOMES = Object.freeze(['.claude', '.claude.json', '.codex', '.cursor', '.gemini', '.grok', '.agents']);

const lstat = file => { try { return fs.lstatSync(file); } catch { return null; } };
const names = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
// A link of ELU's names its target as <home>/./<name>, which no command writes: that tells
// it from a link a command made, whatever home it was made for.
const linkTo = (home, name) => `${home}${path.sep}.${path.sep}${name}`;
const ours = target => path.isAbsolute(target) && path.dirname(target).endsWith(`${path.sep}.`);
// Moves a file, a folder or a link itself. Across filesystems it is copied, then removed.
function move(from, to) {
  try { fs.renameSync(from, to); return; } catch (error) { if (error.code !== 'EXDEV') throw error; }
  const part = `${to}.elu-${process.pid}`;
  fs.cpSync(from, part, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  fs.renameSync(part, to); fs.rmSync(from, { recursive: true, force: true });
}
// Beside the mirror, never deleted: what a run left that has no place in the owner's home.
function setAside(at, { mirror, name }) { const aside = `${mirror}-aside`; mkdir(aside); move(at, path.join(aside, `${Date.now()}-${name}`)); }
// What a command left at the top of ~ goes where it would be had the owner typed the command:
// into his home. A new file or folder is moved there. A file written in place of a link
// (a save by rename) replaces his file when it is newer. Anything else that meets an entry
// of his is set aside, and his entry is linked again.
function settle(at, stat, { home, mirror, name }) {
  const target = path.join(home, name), theirs = lstat(target);
  if (stat.isSymbolicLink()) {
    // A link a command made to a place under ~ names the mirror; in his home it names his home.
    const to = fs.readlinkSync(at);
    if (!theirs && path.isAbsolute(to) && (to === mirror || to.startsWith(mirror + path.sep))) { fs.symlinkSync(path.join(home, path.relative(mirror, to)), target); fs.unlinkSync(at); return; }
  }
  if (!theirs || (stat.isFile() && theirs.isFile() && stat.mtimeMs > theirs.mtimeMs)) move(at, target);
  else setAside(at, { mirror, name });
}
// A link of ELU's under another name is an entry a command renamed (mv ~/a ~/b, or a save by
// rename whose new file an earlier run's end had moved to his home): his entry is renamed the
// same way, to a name he does not have or a file onto a file. A copy of a link, whose first
// name still has its link, is not a rename.
function renamed(to, { home, mirror, name, hidden }) {
  const from = path.basename(to), first = path.join(mirror, from), source = path.join(home, from), target = path.join(home, name);
  if (path.dirname(to) !== `${home}${path.sep}.` || hidden(from)) return;
  if (lstat(first)?.isSymbolicLink() && fs.readlinkSync(first) === to) return;
  const stat = lstat(source), theirs = lstat(target);
  if (stat && (!theirs || (stat.isFile() && theirs.isFile()))) fs.renameSync(source, target);
}
// Brings the mirror up to date with the owner's home, before and after every Full access run.
// own: the entries that stay ELU's there, each a link to a folder under ELU's state (the
// vendor's own settings folder). Nothing in the owner's home is copied, and nothing of his
// is changed but what a command itself made, replaced or renamed at the top of ~. A link a
// command removed is not a removal of his entry: it is linked again. An entry that cannot be
// read or moved is left as it is; the rest is still mirrored.
export function mirrorHome({ home, mirror, own = {} }) {
  mkdir(mirror);
  const hidden = name => TOOL_HOMES.includes(name) || Object.hasOwn(own, name);
  const linked = name => { const at = path.join(mirror, name); if (!lstat(at)?.isSymbolicLink()) return null; const to = fs.readlinkSync(at); return ours(to) ? to : null; };
  // Renames first: what a command then made under the first name is settled after them.
  for (const name of names(mirror)) {
    try { const to = linked(name); if (to && !hidden(name) && to !== linkTo(home, name)) renamed(to, { home, mirror, name, hidden }); } catch { /* His entry keeps its name. */ }
  }
  for (const name of names(mirror)) {
    const at = path.join(mirror, name), stat = lstat(at);
    if (!stat || Object.hasOwn(own, name)) continue;
    try {
      const mine = stat.isSymbolicLink() && ours(fs.readlinkSync(at));
      // A link of ELU's whose entry the owner removed, or that has another name now, goes.
      if (mine) { if (hidden(name) || fs.readlinkSync(at) !== linkTo(home, name) || !lstat(path.join(home, name))) fs.unlinkSync(at); }
      // A coding tool's folder a run made here is set aside: the vendor would load it on the
      // next run, and the owner's own folder of that name is never written.
      else if (hidden(name)) setAside(at, { mirror, name });
      else settle(at, stat, { home, mirror, name });
    } catch { /* This entry stays as it is. */ }
  }
  for (const [name, folder] of Object.entries(own)) {
    const at = path.join(mirror, name), stat = lstat(at);
    // Not caught: without this link the vendor would start on settings that are not ELU's.
    if (stat?.isSymbolicLink() && fs.readlinkSync(at) === folder) continue;
    if (stat?.isSymbolicLink()) fs.unlinkSync(at); else if (stat) setAside(at, { mirror, name });
    fs.symlinkSync(folder, at);
  }
  for (const name of names(home)) {
    if (hidden(name) || lstat(path.join(mirror, name))) continue;
    try { fs.symlinkSync(linkTo(home, name), path.join(mirror, name)); } catch { /* Left out of this run. */ }
  }
  return mirror;
}
