import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readablePictures } from '../lib/pictures.mjs';

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
