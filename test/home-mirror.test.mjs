import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mirrorHome, TOOL_HOMES } from '../lib/home-mirror.mjs';
import { temp } from './helpers.mjs';

// The home a vendor with settings under ~ gets in Full access: a folder of links to the
// owner's own home. A stand-in owner home with sign-ins, a folder for every coding tool, and
// ELU's own settings folder for the vendor.
function world(t) {
  const dir = fs.realpathSync(temp(t)), home = path.join(dir, 'owner'), state = path.join(dir, 'state'), mirror = path.join(state, 'vendor-home-full'), settings = path.join(state, 'vendor-home', '.grok');
  const put = (file, text, mode = 0o600) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode }); };
  put(path.join(home, '.npmrc'), '//registry.npmjs.org/:_authToken=owner-npm-token\n');
  put(path.join(home, '.config', 'gcloud', 'credentials.db'), 'owner-cloud-token\n');
  put(path.join(home, '.ssh', 'id_ed25519'), 'owner-key\n'); put(path.join(home, '.aws', 'credentials'), '[default]\n'); put(path.join(home, '.docker', 'config.json'), '{}\n'); put(path.join(home, '.kube', 'config'), 'kind: Config\n');
  put(path.join(home, '.gitconfig'), '[user]\n\tname = Owner\n'); put(path.join(home, 'Documents', 'notes.txt'), 'notes\n'); put(path.join(home, 'dotfiles', 'zshrc'), 'export A=1\n');
  fs.symlinkSync('dotfiles/zshrc', path.join(home, '.zshrc'));
  for (const name of TOOL_HOMES) { if (name.endsWith('.json')) put(path.join(home, name), '{"mcpServers":{}}\n'); else put(path.join(home, name, 'settings.json'), `{"owner":"${name}"}\n`); }
  put(path.join(settings, 'config.toml'), '# Written by ELU\n');
  const sync = () => mirrorHome({ home, mirror, own: { '.grok': settings } });
  return { dir, home, state, mirror, settings, put, sync };
}
// Every entry under a folder: what it is, where a link points, and what a file holds.
function snapshot(dir) {
  const rows = [];
  const walk = folder => { for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(folder, entry.name), name = path.relative(dir, file);
    if (entry.isSymbolicLink()) rows.push(`${name} -> ${fs.readlinkSync(file)}`);
    else if (entry.isDirectory()) { rows.push(`${name}/`); walk(file); }
    else rows.push(`${name} ${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')} ${(fs.statSync(file).mode & 0o777).toString(8)}`);
  } };
  walk(dir); return rows;
}
const isLink = file => { try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; } };
const real = file => fs.realpathSync(file);

test('every entry at the top of the owner\'s home is his own file through the mirror, except the folders of coding tools; nothing of his is copied or changed', t => {
  const w = world(t), before = snapshot(w.home);
  assert.equal(w.sync(), w.mirror); assert.equal(fs.statSync(w.mirror).mode & 0o777, 0o700);
  for (const name of ['.npmrc', '.config', '.ssh', '.aws', '.docker', '.kube', '.gitconfig', 'Documents', 'dotfiles', '.zshrc']) { assert.ok(isLink(path.join(w.mirror, name)), name); assert.equal(real(path.join(w.mirror, name)), real(path.join(w.home, name)), name); }
  assert.equal(fs.readFileSync(path.join(w.mirror, '.npmrc'), 'utf8'), '//registry.npmjs.org/:_authToken=owner-npm-token\n');
  assert.equal(fs.readFileSync(path.join(w.mirror, '.config', 'gcloud', 'credentials.db'), 'utf8'), 'owner-cloud-token\n');
  assert.equal(fs.readFileSync(path.join(w.mirror, '.zshrc'), 'utf8'), 'export A=1\n', 'a link of his own is followed as his terminal follows it');
  // The folders of coding tools are not there: a vendor would load them as settings of its own.
  for (const name of TOOL_HOMES.filter(name => name !== '.grok')) assert.equal(fs.existsSync(path.join(w.mirror, name)), false, name);
  // The vendor's own folder is the one ELU wrote, never the owner's.
  assert.equal(fs.readlinkSync(path.join(w.mirror, '.grok')), w.settings); assert.equal(fs.readFileSync(path.join(w.mirror, '.grok', 'config.toml'), 'utf8'), '# Written by ELU\n');
  assert.deepEqual(fs.readdirSync(w.mirror).sort(), [...fs.readdirSync(w.home).filter(name => !TOOL_HOMES.includes(name)), '.grok'].sort());
  assert.deepEqual(snapshot(w.home), before, 'making the mirror wrote nothing in his home');
  // A command that writes under ~/.config writes his file, and a second run changes nothing.
  fs.writeFileSync(path.join(w.mirror, '.config', 'gcloud', 'from-run'), 'written\n'); fs.appendFileSync(path.join(w.mirror, '.npmrc'), 'email=o@example.invalid\n');
  assert.equal(fs.readFileSync(path.join(w.home, '.config', 'gcloud', 'from-run'), 'utf8'), 'written\n'); assert.match(fs.readFileSync(path.join(w.home, '.npmrc'), 'utf8'), /owner-npm-token\nemail=/);
  const links = snapshot(w.mirror); w.sync(); assert.deepEqual(snapshot(w.mirror), links);
});

test('the next run has what the owner added since and no longer has what he removed', t => {
  const w = world(t); w.sync();
  w.put(path.join(w.home, '.terraformrc'), 'credentials {}\n'); fs.mkdirSync(path.join(w.home, 'Projects')); fs.rmSync(path.join(w.home, '.kube'), { recursive: true }); fs.rmSync(path.join(w.home, '.gitconfig'));
  assert.equal(fs.existsSync(path.join(w.mirror, '.terraformrc')), false, 'not before the next run');
  w.sync();
  assert.equal(fs.readFileSync(path.join(w.mirror, '.terraformrc'), 'utf8'), 'credentials {}\n'); assert.ok(isLink(path.join(w.mirror, 'Projects')));
  assert.equal(isLink(path.join(w.mirror, '.kube')), false); assert.equal(isLink(path.join(w.mirror, '.gitconfig')), false);
  assert.equal(fs.existsSync(path.join(w.home, '.kube')), false, 'a link whose entry is gone is dropped, and nothing is put back in his home');
});

test('a file or folder a command made at the top of ~ is moved to the owner\'s home when the run ends, and is a link from then on', t => {
  const w = world(t); w.sync();
  // npm login on a computer that had no ~/.yarnrc, a tool that makes ~/.newtool, a script that makes a link.
  fs.writeFileSync(path.join(w.mirror, '.yarnrc'), 'token "from-run"\n', { mode: 0o600 });
  fs.mkdirSync(path.join(w.mirror, '.newtool', 'cache'), { recursive: true }); fs.writeFileSync(path.join(w.mirror, '.newtool', 'cache', 'token'), 'made-in-run\n', { mode: 0o640 });
  fs.symlinkSync(path.join(w.mirror, 'dotfiles', 'zshrc'), path.join(w.mirror, '.bashrc')); fs.symlinkSync('dotfiles/zshrc', path.join(w.mirror, '.profile'));
  w.sync();
  assert.equal(fs.lstatSync(path.join(w.home, '.yarnrc')).isFile(), true); assert.equal(fs.readFileSync(path.join(w.home, '.yarnrc'), 'utf8'), 'token "from-run"\n'); assert.equal(fs.statSync(path.join(w.home, '.yarnrc')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(w.home, '.newtool', 'cache', 'token'), 'utf8'), 'made-in-run\n'); assert.equal(fs.statSync(path.join(w.home, '.newtool', 'cache', 'token')).mode & 0o777, 0o640);
  for (const name of ['.yarnrc', '.newtool', '.bashrc', '.profile']) { assert.ok(isLink(path.join(w.mirror, name)), name); assert.equal(real(path.join(w.mirror, name)), real(path.join(w.home, name)), name); }
  // The link he gets names his home, not ELU's folder; a relative one is kept as written.
  assert.equal(fs.readlinkSync(path.join(w.home, '.bashrc')), path.join(w.home, 'dotfiles', 'zshrc')); assert.equal(fs.readlinkSync(path.join(w.home, '.profile')), 'dotfiles/zshrc');
  assert.equal(fs.readFileSync(path.join(w.mirror, '.bashrc'), 'utf8'), 'export A=1\n');
  assert.equal(fs.existsSync(`${w.mirror}-aside`), false);
});

test('a file saved by rename in place of a link replaces the owner\'s when it is newer; an older one, or a folder, is set aside and his stays', t => {
  const w = world(t); w.sync();
  const swap = (name, make) => { fs.unlinkSync(path.join(w.mirror, name)); make(path.join(w.mirror, name)); };
  // A tool that saves ~/.npmrc as a new file and renames it into place.
  swap('.npmrc', file => fs.writeFileSync(file, '//registry.npmjs.org/:_authToken=new-token\n', { mode: 0o600 }));
  const later = new Date(Date.now() + 5000); fs.utimesSync(path.join(w.mirror, '.npmrc'), later, later);
  w.sync();
  assert.equal(fs.readFileSync(path.join(w.home, '.npmrc'), 'utf8'), '//registry.npmjs.org/:_authToken=new-token\n'); assert.ok(isLink(path.join(w.mirror, '.npmrc')));
  assert.equal(fs.existsSync(`${w.mirror}-aside`), false);
  // The owner saved his own after the run's: his is kept, the run's is beside the mirror.
  swap('.gitconfig', file => fs.writeFileSync(file, '[user]\n\tname = From Run\n'));
  const earlier = new Date(Date.now() - 60000); fs.utimesSync(path.join(w.mirror, '.gitconfig'), earlier, earlier);
  // rm -rf ~/.docker && mkdir ~/.docker took the link away, not his folder.
  swap('.docker', file => { fs.mkdirSync(file); fs.writeFileSync(path.join(file, 'config.json'), '{"from":"run"}\n'); });
  w.sync();
  assert.equal(fs.readFileSync(path.join(w.home, '.gitconfig'), 'utf8'), '[user]\n\tname = Owner\n'); assert.equal(fs.readFileSync(path.join(w.home, '.docker', 'config.json'), 'utf8'), '{}\n');
  for (const name of ['.gitconfig', '.docker']) { assert.ok(isLink(path.join(w.mirror, name)), name); assert.equal(real(path.join(w.mirror, name)), real(path.join(w.home, name)), name); }
  const aside = fs.readdirSync(`${w.mirror}-aside`).sort();
  assert.deepEqual(aside.map(name => name.replace(/^\d+-/, '')), ['.docker', '.gitconfig']);
  assert.equal(fs.readFileSync(path.join(`${w.mirror}-aside`, aside.find(name => name.endsWith('.gitconfig'))), 'utf8'), '[user]\n\tname = From Run\n');
  assert.equal(fs.readFileSync(path.join(`${w.mirror}-aside`, aside.find(name => name.endsWith('.docker')), 'config.json'), 'utf8'), '{"from":"run"}\n');
});

test('removing a link at the top of ~ changes nothing of the owner\'s and the next run links his entry again; renaming one renames his entry', t => {
  const w = world(t); w.sync(); const before = snapshot(w.home);
  // rm ~/.ssh takes the link away, not his folder.
  fs.unlinkSync(path.join(w.mirror, '.ssh')); w.sync();
  assert.deepEqual(snapshot(w.home), before); assert.equal(real(path.join(w.mirror, '.ssh')), real(path.join(w.home, '.ssh')));
  // mv ~/.npmrc ~/.npmrc.old and mv ~/Documents ~/Papers: his file and his folder have the new names.
  fs.renameSync(path.join(w.mirror, '.npmrc'), path.join(w.mirror, '.npmrc.old')); fs.renameSync(path.join(w.mirror, 'Documents'), path.join(w.mirror, 'Papers'));
  w.sync();
  assert.equal(fs.readFileSync(path.join(w.home, '.npmrc.old'), 'utf8'), '//registry.npmjs.org/:_authToken=owner-npm-token\n'); assert.equal(fs.readFileSync(path.join(w.home, 'Papers', 'notes.txt'), 'utf8'), 'notes\n');
  for (const name of ['.npmrc', 'Documents']) { assert.equal(fs.existsSync(path.join(w.home, name)), false, name); assert.equal(isLink(path.join(w.mirror, name)), false, name); }
  for (const name of ['.npmrc.old', 'Papers']) { assert.equal(fs.readlinkSync(path.join(w.mirror, name)), `${w.home}${path.sep}.${path.sep}${name}`, name); assert.equal(real(path.join(w.mirror, name)), real(path.join(w.home, name)), name); }
  assert.equal(fs.existsSync(`${w.mirror}-aside`), false);
});

test('a file kept under another name before a new one is written keeps both: mv ~/.gitconfig ~/.gitconfig.bak, then a new ~/.gitconfig', t => {
  const w = world(t); w.sync();
  fs.renameSync(path.join(w.mirror, '.gitconfig'), path.join(w.mirror, '.gitconfig.bak')); fs.writeFileSync(path.join(w.mirror, '.gitconfig'), '[user]\n\tname = From Run\n');
  w.sync();
  assert.equal(fs.readFileSync(path.join(w.home, '.gitconfig.bak'), 'utf8'), '[user]\n\tname = Owner\n'); assert.equal(fs.readFileSync(path.join(w.home, '.gitconfig'), 'utf8'), '[user]\n\tname = From Run\n');
  for (const name of ['.gitconfig', '.gitconfig.bak']) { assert.ok(isLink(path.join(w.mirror, name)), name); assert.equal(real(path.join(w.mirror, name)), real(path.join(w.home, name)), name); }
  assert.equal(fs.existsSync(`${w.mirror}-aside`), false);
});

test('a save by rename whose new file was already moved to the owner\'s home still replaces his file; a copied link and a rename onto his folder change nothing of his', t => {
  const w = world(t); w.sync();
  // One run ends while another's tool has written ~/.npmrc.tmp and not yet renamed it into place.
  fs.writeFileSync(path.join(w.mirror, '.npmrc.tmp'), '//registry.npmjs.org/:_authToken=new-token\n', { mode: 0o600 }); w.sync();
  assert.ok(isLink(path.join(w.mirror, '.npmrc.tmp'))); fs.renameSync(path.join(w.mirror, '.npmrc.tmp'), path.join(w.mirror, '.npmrc'));
  w.sync();
  assert.equal(fs.readFileSync(path.join(w.home, '.npmrc'), 'utf8'), '//registry.npmjs.org/:_authToken=new-token\n'); assert.equal(fs.existsSync(path.join(w.home, '.npmrc.tmp')), false);
  assert.equal(fs.readlinkSync(path.join(w.mirror, '.npmrc')), `${w.home}${path.sep}.${path.sep}.npmrc`); assert.equal(isLink(path.join(w.mirror, '.npmrc.tmp')), false);
  // cp -P ~/.gitconfig ~/.gitconfig.copy copies the link: his file keeps its name and no copy is made.
  const before = snapshot(w.home);
  fs.symlinkSync(fs.readlinkSync(path.join(w.mirror, '.gitconfig')), path.join(w.mirror, '.gitconfig.copy'));
  // A link renamed onto the name of a folder of his, and one renamed to a coding tool's name.
  fs.unlinkSync(path.join(w.mirror, '.kube')); fs.renameSync(path.join(w.mirror, '.aws'), path.join(w.mirror, '.kube')); fs.renameSync(path.join(w.mirror, 'dotfiles'), path.join(w.mirror, '.cursor'));
  w.sync();
  assert.deepEqual(snapshot(w.home), before);
  for (const name of ['.gitconfig', '.aws', '.kube', 'dotfiles']) assert.equal(real(path.join(w.mirror, name)), real(path.join(w.home, name)), name);
  for (const name of ['.gitconfig.copy', '.cursor']) assert.equal(isLink(path.join(w.mirror, name)) || fs.existsSync(path.join(w.mirror, name)), false, name);
});

test('a coding tool\'s folder a run made under the mirror is set aside: the vendor never loads it, and the owner\'s own vendor folders are never written', t => {
  const w = world(t), before = snapshot(w.home); w.sync();
  // A command that makes ~/.claude or ~/.cursor, and a vendor that swaps ELU's link for a folder of its own.
  for (const name of ['.claude', '.cursor', '.agents']) { fs.mkdirSync(path.join(w.mirror, name)); fs.writeFileSync(path.join(w.mirror, name, 'made-in-run'), 'x\n'); }
  fs.writeFileSync(path.join(w.mirror, '.claude.json'), '{"mcpServers":{"from":"run"}}\n');
  fs.unlinkSync(path.join(w.mirror, '.grok')); fs.mkdirSync(path.join(w.mirror, '.grok')); fs.writeFileSync(path.join(w.mirror, '.grok', 'config.toml'), 'not ELU\'s\n');
  w.sync();
  assert.deepEqual(snapshot(w.home), before);
  for (const name of ['.claude', '.claude.json', '.cursor', '.agents']) assert.equal(fs.existsSync(path.join(w.mirror, name)), false, name);
  assert.equal(fs.readlinkSync(path.join(w.mirror, '.grok')), w.settings, 'the vendor reads the settings ELU wrote again');
  assert.equal(fs.readFileSync(path.join(w.mirror, '.grok', 'config.toml'), 'utf8'), '# Written by ELU\n');
  const aside = fs.readdirSync(`${w.mirror}-aside`);
  assert.deepEqual(aside.map(name => name.replace(/^\d+-/, '')).sort(), ['.agents', '.claude', '.claude.json', '.cursor', '.grok']);
  assert.equal(fs.readFileSync(path.join(`${w.mirror}-aside`, aside.find(name => name.endsWith('.cursor')), 'made-in-run'), 'utf8'), 'x\n', 'what the run made is kept');
  // An owner with no such folder gets none from a run either.
  fs.rmSync(path.join(w.home, '.cursor'), { recursive: true }); fs.mkdirSync(path.join(w.mirror, '.cursor')); w.sync();
  assert.equal(fs.existsSync(path.join(w.home, '.cursor')), false); assert.equal(fs.existsSync(path.join(w.mirror, '.cursor')), false);
});

test('a link a command made is told from ELU\'s own, also when its target has a dot folder in it', t => {
  const w = world(t); w.sync();
  fs.symlinkSync('./dotfiles/./zshrc', path.join(w.mirror, '.zprofile')); fs.symlinkSync(path.join(w.home, 'dotfiles', '.', 'zshrc'), path.join(w.mirror, '.zlogin'));
  w.sync();
  assert.equal(fs.readlinkSync(path.join(w.home, '.zprofile')), './dotfiles/./zshrc'); assert.equal(fs.readFileSync(path.join(w.mirror, '.zprofile'), 'utf8'), 'export A=1\n');
  assert.equal(fs.readFileSync(path.join(w.home, '.zlogin'), 'utf8'), 'export A=1\n'); assert.equal(fs.lstatSync(path.join(w.home, '.zlogin')).isSymbolicLink(), true);
});

test('a mirror made for another home is made again for this one, and nothing of the first is carried over', t => {
  const w = world(t); w.sync();
  const second = path.join(w.dir, 'second'); w.put(path.join(second, '.npmrc'), 'second-token\n'); fs.mkdirSync(path.join(second, '.config'));
  const before = snapshot(second);
  mirrorHome({ home: second, mirror: w.mirror, own: { '.grok': w.settings } });
  assert.deepEqual(snapshot(second), before);
  assert.deepEqual(fs.readdirSync(w.mirror).sort(), ['.config', '.grok', '.npmrc']); assert.equal(fs.readFileSync(path.join(w.mirror, '.npmrc'), 'utf8'), 'second-token\n');
});

test('a home reached through a linked folder, as /var is on macOS, mirrors the same', t => {
  const w = world(t), link = path.join(w.dir, 'var'); fs.symlinkSync(w.dir, link);
  const home = path.join(link, 'owner');
  mirrorHome({ home, mirror: w.mirror, own: { '.grok': w.settings } });
  assert.equal(fs.readFileSync(path.join(w.mirror, '.npmrc'), 'utf8'), '//registry.npmjs.org/:_authToken=owner-npm-token\n');
  fs.writeFileSync(path.join(w.mirror, '.made'), 'new\n'); mirrorHome({ home, mirror: w.mirror, own: { '.grok': w.settings } });
  assert.equal(fs.readFileSync(path.join(w.home, '.made'), 'utf8'), 'new\n'); assert.ok(isLink(path.join(w.mirror, '.made')));
});

test('ELU\'s folder on another disk than the home: what a command made is still moved to the owner\'s home', t => {
  // /dev/shm is another filesystem than the temp folder on Linux; elsewhere there is none to test with.
  let other = null; try { if (fs.statSync('/dev/shm').dev !== fs.statSync(fs.realpathSync(temp(t))).dev) other = fs.mkdtempSync('/dev/shm/elu-code-test-'); } catch { /* No second filesystem here. */ }
  if (!other) return t.skip('no second filesystem on this computer');
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const w = world(t), mirror = path.join(other, 'vendor-home-full');
  const sync = () => mirrorHome({ home: w.home, mirror, own: { '.grok': w.settings } }); sync();
  fs.writeFileSync(path.join(mirror, '.yarnrc'), 'token "from-run"\n', { mode: 0o600 }); fs.mkdirSync(path.join(mirror, '.newtool')); fs.writeFileSync(path.join(mirror, '.newtool', 'token'), 'made-in-run\n');
  fs.unlinkSync(path.join(mirror, '.npmrc')); fs.writeFileSync(path.join(mirror, '.npmrc'), 'new-token\n'); const later = new Date(Date.now() + 5000); fs.utimesSync(path.join(mirror, '.npmrc'), later, later);
  sync();
  assert.equal(fs.readFileSync(path.join(w.home, '.yarnrc'), 'utf8'), 'token "from-run"\n'); assert.equal(fs.statSync(path.join(w.home, '.yarnrc')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(w.home, '.newtool', 'token'), 'utf8'), 'made-in-run\n'); assert.equal(fs.readFileSync(path.join(w.home, '.npmrc'), 'utf8'), 'new-token\n');
  for (const name of ['.yarnrc', '.newtool', '.npmrc']) assert.ok(isLink(path.join(mirror, name)), name);
  assert.deepEqual(fs.readdirSync(w.home).filter(name => name.includes('.elu-')), [], 'no half-moved copy is left in his home');
});
