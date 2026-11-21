import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { temp } from './helpers.mjs';
import { historyFiles, newestEntries, removeFolder, scratchFolder, SCRATCH } from '../lib/turn-files.mjs';
import { changed, notesSpec } from '../lib/git.mjs';

const git = (cwd, ...args) => { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
function repoWithCommit(t) {
  const dir = temp(t);
  git(dir, 'init', '-q'); fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
  git(dir, 'add', 'README.md'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  return { dir, base: git(dir, 'rev-parse', 'HEAD').trim() };
}
// A long chat, oldest first, the owner's newest message to the bot near its end.
const chat = [
  ...Array.from({ length: 600 }, (_, index) => ({ at: new Date(Date.UTC(2026, 10, 18) + index * 60000).toISOString(), from: index % 2 ? 'agent' : 'owner', text: `entry ${index} ${'x'.repeat(2000)}` })),
  { at: '2026-11-21T02:44:00.000Z', from: 'owner → @advisor', text: 'Reply with one line, "advisor ready on <your model name>".' },
  { at: '2026-11-21T02:44:01.000Z', from: 'ELU', text: 'Handoff: Gemini 4 Hydrogen takes over @advisor from its next turn.' },
];

test('a long chat goes to a file in the working folder, and the owner\'s newest message stays in the prompt', t => {
  const { dir } = repoWithCommit(t);
  const files = historyFiles(dir, { chat, source: { files: [] } });
  t.after(() => removeFolder(files.folder));
  assert.ok(files.folder.startsWith(path.join(dir, SCRATCH)));
  const { file, entries, first, last, newest } = files.context.chat;
  assert.equal(file, path.join(files.folder, 'chat.jsonl'));
  assert.equal(entries, chat.length);
  assert.equal(first, chat[0].at); assert.equal(last, chat.at(-1).at);
  // Every entry is in the file, one a line, oldest first.
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines, chat);
  // The message the turn answers, and ELU's line after it, are in the prompt.
  assert.deepEqual(newest, chat.slice(-2));
  // What is not history stays as it was, and the prompt stays small.
  assert.deepEqual(files.context.source, { files: [] });
  assert.ok(JSON.stringify(files.context).length < 2000);
  assert.match(files.note, /chat is a file in your working folder/);
  assert.match(files.note, /read it yourself/);
});

test('a list of one entry stays in the prompt, and nothing is written for it', t => {
  const { dir } = repoWithCommit(t);
  assert.equal(historyFiles(dir, { messages: [chat[0]], task: { title: 'x' } }), null);
  assert.equal(fs.existsSync(path.join(dir, '.elu-code')), false);
});

test('the newest entries start at the owner\'s newest message; a list without one gives its last entry', () => {
  assert.deepEqual(newestEntries([{ text: 'a' }, { from: 'agent', text: 'b' }, { text: 'c' }, { from: 'ELU', text: 'd' }]), [{ text: 'c' }, { from: 'ELU', text: 'd' }]);
  assert.deepEqual(newestEntries([{ from: 'Fable 5.2', text: 'a' }, { from: 'Opus 5.5', text: 'b' }]), [{ from: 'Opus 5.5', text: 'b' }]);
});

test('the folder never shows in git status, git add, or a session\'s change, wherever the session works', t => {
  const { dir, base } = repoWithCommit(t);
  const files = historyFiles(dir, { chat });
  t.after(() => removeFolder(files.folder));
  fs.writeFileSync(path.join(dir, 'work.txt'), 'the session\'s own change\n');
  assert.equal(git(dir, 'status', '--porcelain'), '?? work.txt\n');
  assert.equal(git(dir, 'add', '-A', '-n'), "add 'work.txt'\n");
  for (const kind of ['worktree', 'here']) {
    const task = { place: { kind } };
    assert.deepEqual(changed(dir, base, { ignored: kind !== 'here', exclude: notesSpec(task) }).paths, ['work.txt'], kind);
  }
});

test('a launch\'s folder is removed with what ELU made for it; the owner\'s own files there stay', t => {
  const { dir } = repoWithCommit(t);
  const one = scratchFolder(dir), two = scratchFolder(dir);
  removeFolder(one);
  assert.equal(fs.existsSync(one), false); assert.equal(fs.existsSync(two), true);
  removeFolder(two);
  assert.equal(fs.existsSync(path.join(dir, '.elu-code')), false);
  fs.mkdirSync(path.join(dir, '.elu-code'), { recursive: true }); fs.writeFileSync(path.join(dir, '.elu-code', 'config.yaml'), 'version: 1\n');
  removeFolder(scratchFolder(dir));
  assert.equal(fs.existsSync(path.join(dir, SCRATCH)), false);
  assert.equal(fs.readFileSync(path.join(dir, '.elu-code', 'config.yaml'), 'utf8'), 'version: 1\n');
});

test('a folder a launch left behind a day ago is removed by the next launch', t => {
  const { dir } = repoWithCommit(t);
  const old = scratchFolder(dir), day = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(old, day, day);
  const next = scratchFolder(dir);
  t.after(() => removeFolder(next));
  assert.equal(fs.existsSync(old), false);
});
