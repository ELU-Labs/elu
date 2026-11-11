import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.mjs';
import { clipNotes, copyMemory, memoryFolder, memorySlug } from '../lib/memory.mjs';
import { compile as claude } from '../lib/adapters/claude.mjs';
import { defaultConfig } from '../lib/config.mjs';

function claudeHome(t) {
  const folder = temp(t), previous = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = path.join(folder, 'claude');
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
  return folder;
}

test('memory folders are named the way Claude Code names them', () => {
  assert.equal(memorySlug('/Users/sam'), '-Users-sam');
  assert.equal(memorySlug('/private/tmp/scratch/-Users-sam/x.y z'), '-private-tmp-scratch--Users-sam-x-y-z');
});

test('a run gets a private copy of the memory notes, and nothing else from the folder', t => {
  const folder = claudeHome(t), root = path.join(folder, 'project'); fs.mkdirSync(root);
  assert.equal(copyMemory(root), null, 'no memory, no copy');
  const notes = memoryFolder(root); fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'MEMORY.md'), '- [A](a.md) — a\n'); fs.writeFileSync(path.join(notes, 'a.md'), 'note a\n');
  fs.writeFileSync(path.join(notes, 'secrets.json'), '{}'); fs.writeFileSync(path.join(folder, 'outside.md'), 'secret');
  fs.symlinkSync(path.join(folder, 'outside.md'), path.join(notes, 'linked.md')); fs.mkdirSync(path.join(notes, 'sub.md'));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'project rules\n');
  const copy = copyMemory(root); t.after(() => fs.rmSync(copy.folder, { recursive: true, force: true }));
  assert.deepEqual(fs.readdirSync(copy.dir).sort(), ['MEMORY.md', 'a.md']);
  assert.equal(fs.statSync(copy.folder).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(copy.dir, 'a.md')).mode & 0o777, 0o600);
  assert.equal(copy.dir, fs.realpathSync(copy.dir), 'a resolved path, so reads match the allowed folder');
  assert.equal(copy.index, '- [A](a.md) — a\n'); assert.equal(copy.project, 'project rules\n'); assert.equal(copy.user, '');
});

test('instructions alone still reach the lead, without a copy', t => {
  const folder = claudeHome(t), root = path.join(folder, 'project'); fs.mkdirSync(root);
  fs.mkdirSync(path.join(folder, 'claude')); fs.writeFileSync(path.join(folder, 'claude', 'CLAUDE.md'), 'owner rules\n');
  assert.deepEqual(copyMemory(root), { folder: null, dir: null, index: '', user: 'owner rules\n', project: '' });
});

test('the index is cut at 200 lines, as Claude Code loads it', () => {
  const text = Array.from({ length: 250 }, (_, index) => `- line ${index}`).join('\n'), clipped = clipNotes(text);
  assert.equal(clipped.split('\n').length, 201); assert.match(clipped, /- line 199\n\[Truncated\.\]$/);
  assert.equal(clipNotes('short\n'), 'short\n');
});

test('only the owner\'s read-only session gets the memory folder', t => {
  const cwd = temp(t), session = '12345678-1234-4234-8234-123456789abc', memory = path.join(cwd, 'memory');
  const role = { ...defaultConfig().roles.lead, access: 'read', commands: [], writablePaths: [], vendor: 'claude' };
  const args = claude({ role, cwd, session, memory });
  assert.equal(args[args.indexOf('--add-dir') + 1], memory);
  assert.throws(() => claude({ role, cwd, session, memory, peer: true }), /peer run reads only/);
  assert.throws(() => claude({ role: { ...role, access: 'edit', writablePaths: ['src'] }, cwd, session, memory }), /Only a read-only session may read across your home/);
});
