import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { picturesElsewhere, readablePictures } from '../lib/pictures.mjs';
import { isCommand, startsWithPath } from '../lib/terminal-commands.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
function scratch(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-pictures-test-'))), home = path.join(base, 'home'), folder = path.join(base, 'tmp');
  fs.mkdirSync(path.join(home, 'Library'), { recursive: true }); fs.mkdirSync(path.join(home, '.ssh')); fs.mkdirSync(path.join(home, 'Desktop')); fs.mkdirSync(folder);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, home, folder };
}

test('a picture in a folder no session may read is copied to a private folder; nothing else is', t => {
  const { home, folder } = scratch(t), shot = path.join(home, 'Library', 'shot 1.png');
  fs.writeFileSync(shot, PNG); fs.writeFileSync(path.join(home, 'Library', 'token.png'), 'not a picture'); fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'key');
  fs.writeFileSync(path.join(home, 'Desktop', 'open.png'), PNG); fs.symlinkSync(path.join(home, '.ssh', 'id_rsa'), path.join(home, 'Library', 'link.png'));
  const { text, copied } = readablePictures(`see ${shot.replace(/ /g, '\\ ')} and '${path.join(home, 'Library', 'token.png')}' and ${path.join(home, '.ssh', 'id_rsa')} and ${path.join(home, 'Desktop', 'open.png')} and ${path.join(home, 'Library', 'link.png')}`, { home, folder });
  assert.equal(copied.length, 1); assert.equal(copied[0].from, shot); assert.ok(text.includes(copied[0].to)); assert.ok(!text.includes('shot\\ 1.png'));
  const target = path.join(folder, 'elu-code-pictures');
  assert.equal(path.dirname(copied[0].to), target); assert.equal(fs.statSync(target).mode & 0o777, 0o700); assert.equal(fs.statSync(copied[0].to).mode & 0o777, 0o600);
  assert.ok(fs.readFileSync(copied[0].to).equals(PNG)); assert.deepEqual(fs.readdirSync(target).length, 1);
  for (const kept of ['token.png', 'id_rsa', 'open.png', 'link.png']) assert.ok(text.includes(kept), kept);
});

test('a copy folder that is a link, or open to others, is not trusted as it is', t => {
  const { base, home, folder } = scratch(t), shot = path.join(home, 'Library', 'shot.png'), target = path.join(folder, 'elu-code-pictures'), elsewhere = path.join(base, 'elsewhere');
  fs.writeFileSync(shot, PNG); fs.mkdirSync(elsewhere); fs.symlinkSync(elsewhere, target);
  const linked = readablePictures(`see ${shot}`, { home, folder });
  assert.deepEqual(linked.copied, []); assert.equal(linked.text, `see ${shot}`); assert.deepEqual(fs.readdirSync(elsewhere), []);
  fs.rmSync(target); fs.mkdirSync(target); fs.chmodSync(target, 0o777);
  const open = readablePictures(`see ${shot}`, { home, folder });
  assert.equal(open.copied.length, 1); assert.equal(fs.statSync(target).mode & 0o777, 0o700);
});

// A file dropped on a terminal is pasted as its path. A message that starts with one is a
// message, not a command: its first word has a second slash, or names something here.
test('a message that starts with a path is no command; a command, a lone / and an unknown /word still are', () => {
  const dropped = '/Users/someone/Library/Application\\ Support/Shots/shot\\ 1.png', here = fs.realpathSync(os.tmpdir());
  for (const text of [dropped, `${dropped} this is stuck`, '  /Users/someone/shot.png', '/Model/notes.md please', here, `${here} is full`])
    assert.ok(startsWithPath(text) && !isCommand(text), text);
  for (const text of ['/model', '/model opus fix it', '/permissions folders add /some/path', '/send /Users/someone/shot.png', '/TASKS', '/close', '/foo', '/foo bar', '/', '/ nothing'])
    assert.ok(!startsWithPath(text) && isCommand(text), text);
  // Quoted, or from the home folder, it never started with /.
  for (const text of [`'/Users/someone/Library/Application Support/Shots/shot 1.png'`, '"/Users/someone/shot.png" see', '~/Desktop/shot.png', 'look at /Users/someone/shot.png'])
    assert.ok(!isCommand(text), text);
  // A name with no second slash is a path only when it is there.
  assert.equal(startsWithPath('/nothing-here-at-all', { exists: () => false }), false);
  assert.equal(startsWithPath('/srv', { exists: file => file === '/srv' }), true);
});

test('the pictures a message names that are not on this computer are named by their files', t => {
  const { home } = scratch(t), shot = path.join(home, 'Library', 'shot 1.png'); fs.writeFileSync(shot, PNG);
  const away = '/Users/someone/Library/Application\\ Support/Shots/shot\\ 2.png';
  assert.deepEqual(picturesElsewhere(`${shot.replace(/ /g, '\\ ')} and ${away}.`, { home }), ['shot 2.png']);
  assert.deepEqual(picturesElsewhere(`'/Users/someone/a b.jpg' "/Users/someone/c.webp", ~/Library/shot\\ 1.png ~/Desktop/d.png`, { home }), ['a b.jpg', 'c.webp', 'd.png']);
  assert.deepEqual(picturesElsewhere('/Users/someone/notes.txt and /Users/someone/folder', { home }), [], 'only pictures');
  assert.deepEqual(picturesElsewhere(`${away} ${away}`, { home }), ['shot 2.png'], 'once each');
});

// A path starts the message or a word. In a project's path or a link the / is inside a word:
// public/images/hero.png is no /images/hero.png, and a link is no //example.com/... path.
test('a project path or a link is never a picture on the other computer; a path after a space, a quote or a bracket is', t => {
  const { home } = scratch(t);
  for (const text of ['the hero in public/images/hero.png is blurry', 'fix the hero image in public/images/hero.png please', 'the logo at https://example.com/img/logo.png is blurry',
    'see src/assets/icon.svg and docs/shot.jpg', 'open file:///Users/someone/shot.png', 'a/Users/someone/shot.png', 'name=/Users/someone/shot.png'])
    assert.deepEqual(picturesElsewhere(text, { home }), [], text);
  assert.deepEqual(picturesElsewhere('(/Users/someone/a.png) and "/Users/someone/b.png",\t/Users/someone/c.png [/Users/someone/d.png]', { home }), ['a.png', 'b.png', 'c.png', 'd.png']);
  assert.deepEqual(picturesElsewhere('/Users/someone/Library/Application\\ Support/Shots/shot\\ 2.png in public/images/hero.png', { home }), ['shot 2.png']);
});
