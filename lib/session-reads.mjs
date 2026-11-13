import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inFolders, onDisk, personalDirectory } from './util.mjs';
import { HOME_SECRETS } from './vendors.mjs';
import { SENSITIVE, secretReads, untrackedListing } from './adapters/claude.mjs';

// Whether a session may read a file, as its launch says (lib/adapters/claude.mjs, modeArgs):
// for a tool of ELU's own that reads files for the session, such as sending them to
// another computer of the owner's. Nothing here is new: these are the read denials every
// launch with permissions carries, and the folders it reads.
//   - ELU's state, the home's secret folders and ELU's records in the repository's
//     Git folder are closed in every mode (stateDirs, HOME_SECRETS, gitUnread).
//   - A file whose name may hold a secret is closed where Git does not track it, by its path in
//     a work tree, else by its name (secretRules: SENSITIVE).
//   - Outside its folders (its workspace and the folders its turn adds with --add-dir: the home
//     when the turn reads across it, and the folders added with /permissions folders) Approve
//     for me asks a reviewer; this tool, which cannot, refuses. Ask for approval asks the owner
//     for the whole call, and Full access reads it.
// Every path is compared by what it is on disk as well as by how it is written, and the closed
// ones and secret names without case: on a disk that does not tell case apart, ~/.SSH/id_rsa
// is ~/.ssh/id_rsa and .ENV is .env (inFolders).
// session: { cwd, folders, mode, common }. Returns why it may not, or null.
const nameTest = name => new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
const realOf = file => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
export function sessionReads({ cwd, folders = [], mode, common = null, home = os.homedir() }) {
  const closed = inFolders([personalDirectory(), ...HOME_SECRETS.map(name => path.join(home, name)), ...(common ? [path.join(common, 'elu-code')] : [])], { caseless: true });
  // The untracked secrets of the workspace, as its deny rules list them: a path, or a name inside a folder.
  const listing = cwd ? untrackedListing(cwd) : null, denied = cwd ? secretReads(cwd, SENSITIVE, listing) : [];
  const secretName = file => SENSITIVE.some(name => nameTest(name).test(path.basename(file)));
  const exactPaths = [...denied.filter(entry => !entry.includes('*')), ...(listing?.files ?? []).filter(secretName)];
  const exact = new Set(exactPaths.flatMap(file => [path.resolve(file), realOf(file)]).map(file => file.toLowerCase())), exactIds = new Set(exactPaths.map(onDisk).filter(Boolean));
  const byDir = new Map();
  for (const entry of denied.filter(item => item.includes('*'))) {
    const at = entry.lastIndexOf('/**/'), dir = at >= 0 ? entry.slice(0, at) : cwd, name = at >= 0 ? entry.slice(at + 4) : entry.replace(/^\*\*\//, '');
    if (!dir) continue;
    if (!byDir.has(dir)) byDir.set(dir, { inside: inFolders([dir], { caseless: true }), tests: [] });
    byDir.get(dir).tests.push(nameTest(name));
  }
  const open = inFolders([cwd, ...(Array.isArray(folders) ? folders : [])].filter(Boolean));
  return (file, shown = file) => {
    const real = realOf(file), names = [path.basename(path.resolve(file)), path.basename(real)];
    if (closed(file)) return `${shown} is in a folder this session may not read (secrets, or ELU's own files).`;
    const id = onDisk(real);
    if (exact.has(path.resolve(file).toLowerCase()) || exact.has(real.toLowerCase()) || (id && exactIds.has(id)) || [...byDir.values()].some(row => row.tests.some(test => names.some(name => test.test(name))) && row.inside(file))) return `${shown} may hold a secret and Git does not track it, so this session may not read it.`;
    if (mode === 'auto' && !open(file)) return `${shown} is outside the folders this session reads. /permissions folders add can open its folder, or Full access reads it.`;
    if (!['ask', 'auto', 'full'].includes(mode)) return `${shown} can't be read by this session.`;
    return null;
  };
}
