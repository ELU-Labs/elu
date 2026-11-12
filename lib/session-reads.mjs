import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { personalDirectory, within } from './util.mjs';
import { HOME_SECRETS } from './vendors.mjs';
import { SENSITIVE, secretReads, untrackedListing } from './adapters/claude.mjs';

// Whether a session may read a file, as its launch says (lib/adapters/claude.mjs, modeArgs):
// for a tool of ELU Code's own that reads files for the session, such as sending them to
// another computer of the owner's. Nothing here is new: these are the read denials every
// launch with permissions carries, and the folders it reads.
//   - ELU Code's state, the home's secret folders and ELU Code's records in the repository's
//     Git folder are closed in every mode (stateDirs, HOME_SECRETS, gitUnread).
//   - A file whose name may hold a secret is closed where Git does not track it, by its path in
//     a work tree, else by its name (secretRules: SENSITIVE).
//   - Outside its folders (its workspace, its project, the home its lead reads, the folders
//     added with /permissions folders) Approve for me asks a reviewer; this tool, which cannot,
//     refuses. Ask for approval asks the owner for the whole call, and Full access reads it.
// session: { cwd, root, folders, mode, common }. Returns why it may not, or null.
const spellings = file => { const resolved = path.resolve(file); let real = resolved; try { real = fs.realpathSync(resolved); } catch { /* Missing: as written. */ } return [...new Set([resolved, real])]; };
const nameTest = name => new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
export function sessionReads({ cwd, root = null, folders = [], mode, common = null, home = os.homedir() }) {
  const closed = [personalDirectory(), ...HOME_SECRETS.map(name => path.join(home, name)), ...(common ? [path.join(common, 'elu-code')] : [])].flatMap(spellings);
  // The untracked secrets of the workspace, as its deny rules list them: a path, or a name inside a folder.
  const listing = cwd ? untrackedListing(cwd) : null, denied = cwd ? secretReads(cwd, SENSITIVE, listing) : [];
  const exact = new Set(denied.filter(entry => !entry.includes('*')).flatMap(spellings));
  const patterns = denied.filter(entry => entry.includes('*')).map(entry => { const at = entry.lastIndexOf('/**/'); return at >= 0 ? { dir: entry.slice(0, at), test: nameTest(entry.slice(at + 4)) } : { dir: cwd, test: nameTest(entry.replace(/^\*\*\//, '')) }; });
  const open = [home, cwd, root, ...(Array.isArray(folders) ? folders : [])].filter(Boolean).flatMap(spellings);
  return (file, shown = file) => {
    const forms = spellings(file);
    if (forms.some(form => closed.some(dir => within(dir, form)))) return `${shown} is in a folder this session may not read (secrets, or ELU Code's own files).`;
    if (forms.some(form => exact.has(form) || patterns.some(row => row.dir && within(path.resolve(row.dir), form) && row.test.test(path.basename(form))))) return `${shown} may hold a secret and Git does not track it, so this session may not read it.`;
    if (mode === 'auto' && !forms.some(form => open.some(dir => within(dir, form)))) return `${shown} is outside the folders this session reads. /permissions folders add can open its folder, or Full access reads it.`;
    if (!['ask', 'auto', 'full'].includes(mode)) return `${shown} can't be read by this session.`;
    return null;
  };
}
