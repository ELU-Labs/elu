import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME_SECRETS } from './vendors.mjs';
import { EluCodeError, refuse, systemTemp } from './util.mjs';

// A picture the owner names in a message, when it lies in a part of the home folder no
// session may read. Screenshot tools save there (CleanShot keeps its captures under
// ~/Library), so a pasted path would be refused. The picture is copied to a folder of its
// own in the temporary directory and the message names the copy. Nothing else is opened
// up: the file must be one the owner wrote out in full, and must really be a picture or a
// PDF, which its first bytes show, not its name.

const NAMED = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|pdf)$/i, SIZE_MAX = 25 * 1024 * 1024;
// A path in single quotes, in double quotes, or bare with its spaces escaped, as a terminal
// pastes a dropped file.
export const PICTURE_PATHS = /'((?:~\/|\/)[^'\n]+)'|"((?:~\/|\/)[^"\n]+)"|((?:~\/|\/)(?:\\.|[^\s\\'"])+)/g;

function pictureBytes(file) {
  const head = Buffer.alloc(12); let fd = null;
  try { fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, 12, 0); } catch { return false; } finally { if (fd !== null) fs.closeSync(fd); }
  const text = head.toString('latin1');
  return text.startsWith('\x89PNG') || text.startsWith('\xff\xd8\xff') || text.startsWith('GIF8') || text.startsWith('%PDF') || text.startsWith('BM')
    || text.startsWith('II*\x00') || text.startsWith('MM\x00*') || text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP' || text.slice(4, 8) === 'ftyp';
}
// The real file behind a path from a message when it is a picture no session may read, else null.
function hidden(written, home) {
  const given = written.startsWith('~/') ? path.join(home, written.slice(2)) : written;
  if (!NAMED.test(given)) return null;
  let real; try { real = fs.realpathSync(given); if (!fs.statSync(real).isFile() || fs.statSync(real).size > SIZE_MAX) return null; } catch { return null; }
  const closed = HOME_SECRETS.map(name => path.join(home, name)).some(folder => real === folder || real.startsWith(folder + path.sep));
  return closed && NAMED.test(real) && pictureBytes(real) ? real : null;
}
// The message with each such picture replaced by a copy the session can read:
// { text, copied: [{ from, to }] }. A message that names none comes back as it was.
export function readablePictures(text, { home = os.homedir(), folder = systemTemp() } = {}) {
  const copied = [];
  if (typeof text !== 'string' || !/[~/]/.test(text)) return { text, copied };
  let base; try { base = fs.realpathSync(home); } catch { return { text, copied }; }
  const out = text.replace(PICTURE_PATHS, (whole, single, double, bare) => {
    const real = hidden(single ?? double ?? bare.replace(/\\(.)/g, '$1'), base);
    if (!real) return whole;
    try {
      const target = path.join(fs.realpathSync(folder), 'elu-code-pictures'); fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      // The temp folder can be shared with other users. A folder of that name that is a link,
      // or someone else's, is not used: its owner could read or swap what is put there.
      const made = fs.lstatSync(target);
      if (!made.isDirectory() || (process.getuid && made.uid !== process.getuid())) return whole;
      if ((made.mode & 0o777) !== 0o700) fs.chmodSync(target, 0o700);
      const to = path.join(target, `${crypto.randomUUID().slice(0, 8)}-${path.basename(real).replace(/[^A-Za-z0-9._@-]+/g, '-')}`);
      fs.copyFileSync(real, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, 0o600);
      copied.push({ from: real, to });
      return to;
    } catch { return whole; }
  });
  return { text: out, copied };
}

// The kinds of picture a teammate can be sent, told by a file's first bytes:
// [media type, file ending], or null for anything else.
export function pictureKind(head) {
  const text = Buffer.from(head.subarray(0, 12)).toString('latin1');
  if (text.startsWith('\x89PNG\r\n\x1a\n')) return ['image/png', 'png'];
  if (text.startsWith('\xff\xd8\xff')) return ['image/jpeg', 'jpg'];
  if (text.startsWith('GIF87a') || text.startsWith('GIF89a')) return ['image/gif', 'gif'];
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return ['image/webp', 'webp'];
  return null;
}
// ELU's own pictures folder in the temporary directory: a real folder of this user,
// closed to everyone else. null when it cannot be had.
export function picturesRoot(folder = systemTemp()) {
  try {
    const target = path.join(fs.realpathSync(folder), 'elu-code-pictures'); fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const made = fs.lstatSync(target);
    if (!made.isDirectory() || (process.getuid && made.uid !== process.getuid())) return null;
    if ((made.mode & 0o777) !== 0o700) fs.chmodSync(target, 0o700);
    return target;
  } catch { return null; }
}
// The one folder a teammate's question run may read beside the shared project: the copies
// of the pictures sent with that question (lib/peer/pictures.mjs). It must be a real folder
// directly inside the pictures folder above, with no link anywhere in its path, this
// user's and closed to others, and hold nothing but pictures under generated names.
const RUN_FOLDER = /^q-[0-9a-f]{16}$/, RUN_FILE = /^[1-9]\.(png|jpg|gif|webp)$/;
export function checkRunPictures(folder, { temp = systemTemp() } = {}) {
  const bad = () => refuse("A teammate's pictures must be in ELU's own pictures folder.");
  const closed = (stat, mode) => (!process.getuid || stat.uid === process.getuid()) && (process.platform === 'win32' || (stat.mode & 0o777) === mode);
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || !RUN_FOLDER.test(path.basename(folder))) bad();
  try {
    const root = path.join(fs.realpathSync(temp), 'elu-code-pictures');
    if (path.dirname(folder) !== root || fs.realpathSync(folder) !== folder) bad();
    for (const dir of [root, folder]) { const stat = fs.lstatSync(dir); if (!stat.isDirectory() || !closed(stat, 0o700)) bad(); }
    const names = fs.readdirSync(folder);
    if (!names.length || names.length > 4) bad();
    for (const name of names) {
      const file = path.join(folder, name), stat = fs.lstatSync(file), head = Buffer.alloc(12);
      if (!RUN_FILE.test(name) || !stat.isFile() || !closed(stat, 0o600)) bad();
      const fd = fs.openSync(file, 'r'); try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
      if (!pictureKind(head)) bad();
    }
  } catch (error) { if (error instanceof EluCodeError) throw error; bad(); }
  return folder;
}
