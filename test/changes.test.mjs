import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import blessed from 'blessed';
import { project, git, command, keyLike } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { saveTask } from '../lib/state.mjs';
import { taskPatch } from '../lib/projects.mjs';
import { buildChanges, sessionChanges } from '../lib/diff.mjs';
import { changeCounts, changeRows, changeSummary } from '../lib/changes.mjs';
import { parseDiff, LIMITS } from '../lib/diff.mjs';
import { visible } from '../lib/terminal-visuals.mjs';

// Git as it is installed, without the settings of whoever runs the tests.
function raw(root, args) {
  const run = command('git', ['-C', root, ...args], root, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  assert.equal(run.status, 0, run.stderr); return run.stdout;
}
const patchOf = (root, extra = []) => raw(root, [...extra, 'diff', '--find-renames', 'HEAD', '--']);
function write(root, files) {
  for (const [name, text] of Object.entries(files)) { const full = path.join(root, name); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); }
}
// A repository with one commit that holds `files` beside the sample project.
function fixture(t, files = {}) {
  const { root } = project(t);
  git(root, ['config', 'core.autocrlf', 'false']); git(root, ['config', 'core.precomposeunicode', 'true']);
  write(root, files); git(root, ['add', '-A']); git(root, ['commit', '--allow-empty', '-m', 'Add fixtures']);
  return root;
}
// Git's own count for every changed file: path -> { added, removed, binary, from }.
function counted(root) {
  const parts = raw(root, ['diff', '--find-renames', '--numstat', '-z', 'HEAD', '--']).split('\0'), out = new Map();
  for (let index = 0; index < parts.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(parts[index]); if (!match) continue;
    const moved = match[3] === '', name = moved ? parts[index + 2] : match[3];
    out.set(name.normalize('NFC'), { added: Number(match[1]) || 0, removed: Number(match[2]) || 0, binary: match[1] === '-', from: moved ? parts[index + 1] : null });
    if (moved) index += 2;
  }
  return out;
}
// The parsed files must agree with Git's count, and every line must sit where its numbers
// say: new numbers in the working file, old numbers in the last commit. links: paths whose
// content is a link's target, which a read of the path would follow.
function assertFaithful(root, files, links = []) {
  const known = counted(root);
  assert.deepEqual(files.map(file => file.path.normalize('NFC')).sort(), [...known.keys()].sort());
  for (const file of files) {
    const row = known.get(file.path.normalize('NFC'));
    assert.deepEqual({ added: file.added, removed: file.removed, binary: file.binary, from: file.from }, row, file.path);
    assert.equal(file.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind === 'add').length, file.added, file.path);
    assert.equal(file.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind === 'del').length, file.removed, file.path);
    if (file.binary || links.includes(file.path)) continue;
    const now = file.status === 'deleted' ? null : fs.readFileSync(path.join(root, file.path), 'utf8').split('\n');
    const before = file.status === 'added' ? null : raw(root, ['show', `HEAD:${file.from ?? file.path}`]).split('\n');
    for (const line of file.hunks.flatMap(hunk => hunk.lines)) {
      assert.equal(line.kind, line.old === null ? 'add' : line.now === null ? 'del' : 'context');
      if (line.now !== null) assert.equal(now[line.now - 1], line.text, `${file.path} new line ${line.now}`);
      if (line.old !== null) assert.equal(before[line.old - 1], line.text, `${file.path} old line ${line.old}`);
    }
  }
}
const numbered = (count, text = index => `line ${index}`) => Array.from({ length: count }, (_, index) => `${text(index + 1)}\n`).join('');
const BLOCKS = Array.from({ length: 6 }, (_, index) => `export function part${index}(value) {\n  const first = value + ${index};\n  const second = first * 2;\n\n  const third = second - 1;\n  const fourth = third / 3;\n  const fifth = fourth + 4;\n  return fifth;\n}\n`).join('\n');

test('parseDiff reads changed, new and deleted files from real git diff output', t => {
  const root = fixture(t, { 'src/long.mjs': BLOCKS, 'docs/notes.txt': 'alpha\n', 'old.txt': 'one\ntwo\nthree\n' });
  write(root, { 'src/long.mjs': BLOCKS.replace('value + 0', 'value + 100').replace('fourth + 4;\n  return fifth;\n}\n\nexport function part5', 'fourth + 4;\n  console.log(fifth);\n  return fifth;\n}\n\nexport function part5'), 'docs/notes.txt': 'beta\n', 'src/new file.mjs': 'export const fresh = true;\nexport const more = 1;\n' });
  git(root, ['rm', '-q', 'old.txt']); git(root, ['add', 'src/new file.mjs']);
  const files = parseDiff(patchOf(root));
  assert.deepEqual(files.map(file => [file.path, file.status, file.from, file.binary, file.note]), [
    ['docs/notes.txt', 'modified', null, false, null], ['old.txt', 'deleted', null, false, null], ['src/long.mjs', 'modified', null, false, null], ['src/new file.mjs', 'added', null, false, null],
  ]);
  assertFaithful(root, files);
  // One changed line: Git leaves the counts out of the header.
  assert.equal(files[0].hunks[0].header, '@@ -1 +1 @@');
  assert.deepEqual(files[0].hunks[0].lines, [{ kind: 'del', old: 1, now: null, text: 'alpha' }, { kind: 'add', old: null, now: 1, text: 'beta' }]);
  // Two places far apart are two hunks, the second with the function it sits in.
  assert.equal(files[2].hunks.length, 2);
  assert.match(files[2].hunks[1].header, /^@@ -\d+,\d+ \+\d+,\d+ @@ export function part4\(value\) \{$/);
  assert.deepEqual(files[2].hunks[0].lines.slice(0, 3), [
    { kind: 'context', old: 1, now: 1, text: 'export function part0(value) {' }, { kind: 'del', old: 2, now: null, text: '  const first = value + 0;' }, { kind: 'add', old: null, now: 2, text: '  const first = value + 100;' },
  ]);
  assert.deepEqual(files[1].hunks[0].lines.map(line => [line.kind, line.old, line.now]), [['del', 1, null], ['del', 2, null], ['del', 3, null]]);
  assert.deepEqual(files[3].hunks[0].lines.map(line => [line.kind, line.old, line.now]), [['add', null, 1], ['add', null, 2]]);
  // Git may write an empty context line with no leading space. The result is the same.
  assert.deepEqual(parseDiff(patchOf(root, ['-c', 'diff.suppressBlankEmpty=true'])), files);
});

test('parseDiff reads renames, with and without changes to the content', t => {
  const root = fixture(t, { 'a.txt': numbered(12), 'big.txt': numbered(30) });
  fs.mkdirSync(path.join(root, 'moved'));
  git(root, ['mv', 'a.txt', 'moved/a.txt']); git(root, ['mv', 'big.txt', 'moved/big renamed.txt']);
  write(root, { 'moved/big renamed.txt': numbered(30).replace('line 7\n', 'line seven\n') });
  const files = parseDiff(patchOf(root));
  assert.deepEqual(files.map(file => [file.path, file.status, file.from, file.added, file.removed, file.hunks.length]), [
    ['moved/a.txt', 'renamed', 'a.txt', 0, 0, 0], ['moved/big renamed.txt', 'renamed', 'big.txt', 1, 1, 1],
  ]);
  assertFaithful(root, files);
});

test('parseDiff reads mode changes, binary files and paths with spaces', t => {
  const root = fixture(t, { 'dir with space/run me.sh': '#!/bin/sh\nexit 0\n', 'logo.bin': Buffer.from([0, 1, 2, 3, 0, 255]), 'tool.sh': '#!/bin/sh\nexit 1\n' });
  fs.chmodSync(path.join(root, 'dir with space/run me.sh'), 0o755);
  fs.chmodSync(path.join(root, 'tool.sh'), 0o755); write(root, { 'tool.sh': '#!/bin/sh\nexit 2\n' }); fs.chmodSync(path.join(root, 'tool.sh'), 0o755);
  write(root, { 'logo.bin': Buffer.from([9, 0, 9, 0]), 'new art.bin': Buffer.from([0, 0, 7]), 'empty.txt': '' }); fs.symlinkSync('tool.sh', path.join(root, 'link'));
  git(root, ['add', 'new art.bin', 'empty.txt', 'link']);
  const files = parseDiff(patchOf(root));
  assert.deepEqual(files.map(file => [file.path, file.status, file.binary, file.note, file.hunks.length]), [
    ['dir with space/run me.sh', 'modified', false, 'mode 100644 → 100755', 0], ['empty.txt', 'added', false, 'empty file', 0], ['link', 'added', false, 'symbolic link', 1], ['logo.bin', 'modified', true, 'binary file', 0],
    ['new art.bin', 'added', true, 'binary file', 0], ['tool.sh', 'modified', false, 'mode 100644 → 100755', 1],
  ]);
  assertFaithful(root, files, ['link']);
  // Git shows a link it tracks as one line: where the link points.
  assert.deepEqual(files[2].hunks[0].lines, [{ kind: 'add', old: null, now: 1, text: 'tool.sh', eol: false }]);
});

test('parseDiff marks a last line without a newline', t => {
  const root = fixture(t, { 'open.txt': 'one\ntwo', 'closed.txt': 'one\ntwo\n', 'gains.txt': 'one\ntwo' });
  write(root, { 'open.txt': 'one\nTWO', 'closed.txt': 'one\ntwo\nthree', 'gains.txt': 'one\ntwo\n' });
  const files = parseDiff(patchOf(root));
  assert.deepEqual(files.map(file => file.path), ['closed.txt', 'gains.txt', 'open.txt']);
  assertFaithful(root, files);
  assert.deepEqual(files[0].hunks[0].lines.at(-1), { kind: 'add', old: null, now: 3, text: 'three', eol: false });
  assert.deepEqual(files[1].hunks[0].lines.slice(-2), [{ kind: 'del', old: 2, now: null, text: 'two', eol: false }, { kind: 'add', old: null, now: 2, text: 'two' }]);
  assert.deepEqual(files[2].hunks[0].lines.slice(-2), [{ kind: 'del', old: 2, now: null, text: 'two', eol: false }, { kind: 'add', old: null, now: 2, text: 'TWO', eol: false }]);
});

test('parseDiff reads quoted paths', t => {
  const accent = 'caf\u00e9 menu.txt', odd = 'we"ird\tname.txt', script = 'd\u00e9j\u00e0 vu.sh';
  const root = fixture(t, { [accent]: 'one\n', [odd]: 'one\n', [script]: 'exit 0\n' });
  write(root, { [accent]: 'two\n', [odd]: 'two\n' }); fs.chmodSync(path.join(root, script), 0o755);
  const text = patchOf(root), files = parseDiff(text);
  // Git writes these names in quotes, with escapes.
  assert.match(text, /^diff --git "a\/caf\\303\\251 menu\.txt" "b\/caf\\303\\251 menu\.txt"$/m); assert.match(text, /^\+\+\+ "b\/we\\"ird\\tname\.txt"\t?$/m);
  assert.deepEqual(files.map(file => file.path.normalize('NFC')).sort(), [accent, script, odd].sort());
  assert.equal(files.find(file => file.path.normalize('NFC') === script).note, 'mode 100644 → 100755');
  assertFaithful(root, files);
  // The same names when Git is told not to escape them.
  assert.deepEqual(parseDiff(patchOf(root, ['-c', 'core.quotePath=false'])), files);
});

test('parseDiff keeps Windows line ends and is not misled by content that looks like a header', t => {
  const tricky = ['-- a/tricky.txt', '++ b/tricky.txt', 'diff --git a/x b/x', '@@ -1,2 +1,2 @@', '\\ No newline at end of file', 'index 123..456 100644', 'keep'];
  const root = fixture(t, { 'win.txt': 'a\r\nb\r\nc\r\n', 'tricky.txt': `${tricky.join('\n')}\n` });
  write(root, { 'win.txt': 'a\r\nB\r\nc\r\n', 'tricky.txt': `${['++ b/other', ...tricky.slice(2, 4), '-- a/other', 'rename to elsewhere', 'keep', 'diff --git a/y b/y'].join('\n')}\n` });
  const files = parseDiff(patchOf(root));
  assert.deepEqual(files.map(file => [file.path, file.status, file.from]), [['tricky.txt', 'modified', null], ['win.txt', 'modified', null]]);
  assertFaithful(root, files);
  assert.deepEqual(files[1].hunks[0].lines.map(line => line.text), ['a\r', 'b\r', 'B\r', 'c\r']);
});

test('parseDiff returns nothing for empty text and for text that is not a diff', () => {
  assert.deepEqual(parseDiff(''), []); assert.deepEqual(parseDiff(undefined), []);
  assert.deepEqual(parseDiff('warning: something else\n* Unmerged path a.txt\n'), []);
  // A conflicted file has a format of its own. It is listed, and its lines are left out.
  assert.deepEqual(parseDiff('diff --cc src/a b.txt\nindex 1,2..3\n--- a/src/a b.txt\n+++ b/src/a b.txt\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< HEAD\n +one\n'), [
    { path: 'src/a b.txt', from: null, status: 'modified', binary: false, added: 0, removed: 0, hunks: [], note: 'merge conflict, not shown', hidden: 0 },
  ]);
});

// A session with a real worktree, as the runner makes it.
function session(t, files = {}) {
  const root = fixture(t, files), repo = repository(root), base = git(root, ['rev-parse', 'HEAD']), worktree = path.join(repo.worktrees, '1');
  fs.mkdirSync(repo.worktrees, { recursive: true }); git(root, ['worktree', 'add', '-b', 'feat/task-1', worktree, base]);
  saveTask(repo, { id: '1', goal: 'Normalize coupons', state: 'ready', worktree, branch: 'feat/task-1', base, createdAt: new Date().toISOString(), runs: [], reviews: [], messages: [], sessions: {} });
  return { root, repo, base, worktree };
}
const linesOf = file => file.hunks.flatMap(hunk => hunk.lines);

test('taskPatch lists the tracked and the new files of a session', t => {
  const { root, repo, base, worktree } = session(t), secret = path.join(path.dirname(root), 'outside.txt'), marker = path.join(path.dirname(root), 'driver-ran');
  // Settings that change how Git prints a diff, and a diff program that must never run.
  const driver = path.join(path.dirname(root), 'driver.sh'); fs.writeFileSync(driver, `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
  for (const [key, value] of [['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['color.ui', 'always'], ['color.diff', 'always'], ['diff.external', driver], ['diff.renames', 'false']]) git(root, ['config', key, value]);
  fs.writeFileSync(secret, 'TOP-SECRET\n');
  write(worktree, { 'src/coupon.mjs': 'export const normalize = (value) => value.trim();\n', 'notes/new file.txt': 'one\ntwo\n', 'blob.bin': Buffer.from([1, 0, 2]), 'open.txt': 'no newline' });
  git(worktree, ['mv', 'test/coupon.test.mjs', 'test/renamed.test.mjs']);
  fs.symlinkSync(secret, path.join(worktree, 'link.txt'));
  fs.mkdirSync(path.join(worktree, 'nested')); git(path.join(worktree, 'nested'), ['init', '-q']);
  const changes = taskPatch(repo, '1');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(changes.base, base); assert.equal(changes.branch, 'feat/task-1'); assert.equal(changes.cut, false);
  assert.deepEqual(changes.files.map(file => [file.path, file.status, file.from, file.binary, file.added, file.removed, file.note]), [
    ['src/coupon.mjs', 'modified', null, false, 1, 1, null], ['test/renamed.test.mjs', 'renamed', 'test/coupon.test.mjs', false, 0, 0, null],
    ['blob.bin', 'added', null, true, 0, 0, 'binary file'], ['link.txt', 'added', null, false, 0, 0, 'symbolic link, not opened'],
    ['nested/', 'added', null, false, 0, 0, 'not a regular file'], ['notes/new file.txt', 'added', null, false, 2, 0, null], ['open.txt', 'added', null, false, 1, 0, null],
  ]);
  assert.deepEqual([changes.added, changes.removed], [4, 1]);
  assert.deepEqual(changes.files[0].hunks, [{ header: '@@ -1 +1 @@', lines: [{ kind: 'del', old: 1, now: null, text: 'export const normalize = (value) => value;' }, { kind: 'add', old: null, now: 1, text: 'export const normalize = (value) => value.trim();' }] }]);
  assert.deepEqual(changes.files[5].hunks, [{ header: '@@ -0,0 +1,2 @@', lines: [{ kind: 'add', old: null, now: 1, text: 'one' }, { kind: 'add', old: null, now: 2, text: 'two' }] }]);
  assert.deepEqual(changes.files[6].hunks, [{ header: '@@ -0,0 +1 @@', lines: [{ kind: 'add', old: null, now: 1, text: 'no newline', eol: false }] }]);
  // The link is named and never followed.
  assert.doesNotMatch(JSON.stringify(changes), /TOP-SECRET/);
  assert.equal(changeSummary(changes), 'Changes 7');
});

test('taskPatch holds a huge change to its limits and counts what it leaves out', t => {
  const { repo, worktree } = session(t);
  write(worktree, { 'src/coupon.mjs': numbered(2300), 'a-big.txt': numbered(2500) });
  for (let index = 0; index < 9; index++) write(worktree, { [`fill-${index}.txt`]: numbered(2000) });
  for (let index = 0; index < 300; index++) write(worktree, { [`z-${String(index).padStart(3, '0')}.txt`]: 'x\n' });
  const changes = taskPatch(repo, '1'), kept = changes.files.map(file => linesOf(file).length);
  assert.deepEqual(LIMITS, { files: 300, fileLines: 2000, lines: 20000, lineChars: 2000, previewBytes: 64000 });
  assert.equal(changes.files.length, 300); assert.equal(changes.hiddenFiles, 11); assert.equal(changes.cut, true); assert.equal(changes.uncounted, true);
  assert.equal(Math.max(...kept), 2000); assert.equal(kept.reduce((sum, value) => sum + value, 0), 20000);
  // The totals count every line that was read, shown or not.
  assert.deepEqual([changes.added, changes.removed], [2300 + 2500 + 9 * 2000 + 289, 1]);
  assert.equal(changes.hiddenLines, changes.added + changes.removed - 20000);
  assert.deepEqual([changes.files[0].path, changes.files[0].added, changes.files[0].removed, changes.files[0].note], ['src/coupon.mjs', 2300, 1, '301 more lines not shown']);
  assert.deepEqual([changes.files[1].path, changes.files[1].added, changes.files[1].note], ['a-big.txt', 2500, '500 more lines not shown']);
  // Past 20,000 lines a file is still listed, with its count and no lines.
  assert.deepEqual([changes.files[10].path, changes.files[10].added, changes.files[10].hunks.length, changes.files[10].note], ['fill-8.txt', 2000, 0, '2,000 more lines not shown']);
  assert.deepEqual([changes.files[299].added, changes.files[299].note], [1, '1 more line not shown']);
  assert.equal(changeSummary(changes), 'Changes 311');
  const rows = changeRows(changes, 100, false);
  assert.match(shown(rows[0]), /^[0-9a-f]{8}\.\.\.feat\/task-1 · 311 files changed · \+23,089 −1$/);
  // What is left out is said under the summary, on as many rows as the sentence needs.
  assert.deepEqual(rows.slice(1, 4).map(row => row.kind), ['note', 'note', 'blank']);
  assert.equal(rows.slice(1, 3).map(shown).join(' '), 'Not shown: 11 files · 3,090 changed lines. The totals leave out new files that were not read in full.');
});

test('taskPatch cuts the preview of a large new file and still counts its lines', t => {
  const { repo, worktree } = session(t);
  write(worktree, { 'wide.txt': numbered(3000, index => `${String(index).padStart(6, '0')} ${'x'.repeat(32)}`) });
  const changes = taskPatch(repo, '1'), [file] = changes.files;
  assert.equal(fs.statSync(path.join(worktree, 'wide.txt')).size, 120000);
  assert.deepEqual([file.added, linesOf(file).length, file.note, file.hunks[0].header], [3000, 1600, 'preview cut at 64,000 bytes · 1,400 more lines not shown', '@@ -0,0 +1,3000 @@']);
  assert.deepEqual([changes.added, changes.cut, changes.uncounted, changes.hiddenLines], [3000, true, false, 1400]);
  assert.equal(linesOf(file).at(-1).text, `001600 ${'x'.repeat(32)}`);
  // A new file too large to read whole is counted only as far as its preview, and says so.
  write(worktree, { 'giant.txt': numbered(100000, index => `${String(index).padStart(6, '0')} ${'y'.repeat(42)}`) });
  const next = taskPatch(repo, '1'), giant = next.files[0];
  assert.equal(fs.statSync(path.join(worktree, 'giant.txt')).size, 5000000);
  assert.deepEqual([giant.path, giant.added, linesOf(giant).length, giant.note], ['giant.txt', 1280, 1280, 'preview cut at 64,000 bytes']);
  assert.deepEqual([next.added, next.cut, next.uncounted], [4280, true, true]);
  assert.match(changeRows(next, 80, false).filter(row => row.kind === 'note' && row.file === null).map(shown).join(' '), /^Not shown: 1,400 changed lines\. The totals leave out new files that were not read in full\.$/);
});

test('taskPatch takes its totals from Git when the patch is too large to hold', t => {
  const { repo, worktree } = session(t);
  // About 18 MB of new lines: more than one Git answer may hold.
  write(worktree, { 'src/coupon.mjs': `${'data '.repeat(11)}\n`.repeat(320000), 'zz later.txt': 'new\n' }); git(worktree, ['add', 'zz later.txt']);
  const changes = taskPatch(repo, '1');
  assert.deepEqual(changes.files.map(file => [file.path, file.status, file.added, file.removed, linesOf(file).length, file.note]), [
    ['src/coupon.mjs', 'modified', 320000, 1, 2000, '318,001 more lines not shown'], ['zz later.txt', 'added', 1, 0, 0, '1 more line not shown'],
  ]);
  assert.deepEqual([changes.added, changes.removed, changes.cut, changes.hiddenFiles, changes.hiddenLines], [320001, 1, true, 0, 318002]);
});

test('taskPatch answers an empty list for a conversation', t => {
  const { repo, root } = session(t);
  saveTask(repo, { id: '2', kind: 'conversation', worktree: root, base: null, branch: null, goal: 'A question', state: 'answered', createdAt: new Date().toISOString(), runs: [], reviews: [], messages: [], sessions: {} });
  const changes = taskPatch(repo, '2');
  assert.deepEqual({ base: changes.base, branch: changes.branch, files: changes.files, added: changes.added, removed: changes.removed, cut: changes.cut }, { base: null, branch: null, files: [], added: 0, removed: 0, cut: false });
  assert.deepEqual(changeRows(changes, 80, false).map(row => [row.kind, row.text]), [['summary', 'No changes yet.']]);
  assert.equal(changeSummary(changes), 'Changes');
  // A session with a worktree and no edits reads the same.
  assert.deepEqual(taskPatch(repo, '1').files, []);
});

test('buildChanges applies its limits and takes the totals from Git when the patch is cut short', t => {
  const root = fixture(t, { 'a.txt': numbered(10), 'b.txt': numbered(10), 'c.txt': numbered(10) });
  write(root, { 'a.txt': numbered(10, index => `changed ${index}`), 'b.txt': `${'y'.repeat(50)}\n${numbered(10)}`, 'c.txt': numbered(12), 'd new.txt': 'fresh\n' }); git(root, ['add', 'd new.txt']);
  const patch = patchOf(root), counts = raw(root, ['diff', '--find-renames', '--raw', '--numstat', '-z', 'HEAD', '--']);
  const small = buildChanges({ base: 'main', branch: 'topic', patch }, { files: 2, fileLines: 4, lines: 6, lineChars: 20, previewBytes: 64000 });
  assert.deepEqual(small.files.map(file => [file.path, file.added, file.removed, linesOf(file).length, file.hidden, file.note]), [['a.txt', 10, 10, 4, 16, '16 more lines not shown'], ['b.txt', 1, 0, 2, 2, '2 more lines not shown']]);
  assert.deepEqual([small.added, small.removed, small.cut, small.hiddenFiles, small.hiddenLines, small.uncounted], [14, 10, true, 2, 19, false]);
  assert.deepEqual(linesOf(small.files[1])[0], { kind: 'add', old: null, now: 1, text: 'y'.repeat(20), more: 30 });
  // Half a patch, as Git hands it over when the whole one is too large to hold.
  const half = buildChanges({ patch: patch.slice(0, patch.indexOf(`+${'y'.repeat(50)}`) + 20), counts });
  assert.deepEqual(half.files.map(file => [file.path, file.status, file.added, file.removed, file.note]), [['a.txt', 'modified', 10, 10, null], ['b.txt', 'modified', 1, 0, '1 more line not shown'], ['c.txt', 'modified', 2, 0, '2 more lines not shown'], ['d new.txt', 'added', 1, 0, '1 more line not shown']]);
  assert.deepEqual([half.added, half.removed, half.cut, half.hiddenFiles, half.hiddenLines], [14, 10, true, 0, 4]);
  assert.deepEqual(linesOf(half.files[1]), []);
  // New files are read one at a time, and not at all once the list is full.
  const asked = [], full = buildChanges({ untracked: ['one.txt', 'gone.txt', 'two.txt', 'three.txt'], read: name => { asked.push(name); return name === 'gone.txt' ? null : { bytes: Buffer.from('a\nb\n'), size: 4 }; } }, { ...LIMITS, files: 2 });
  assert.deepEqual(asked, ['one.txt', 'gone.txt', 'two.txt']);
  assert.deepEqual([full.files.map(file => file.path), full.hiddenFiles, full.added, full.cut, full.uncounted], [['one.txt', 'two.txt'], 1, 4, true, true]);
});

// What a row shows: the terminal library reads its tags, with every style taken as a style.
const shown = row => blessed.helpers.parseTags(row.text, { program: { _attr: () => '' } });
// How wide a row is, by the app's own measure.
const widthOf = row => blessed.unicode.strWidth(visible(row.text));
// A file header: the name at the left, the counts at the right edge.
const edge = (left, right, width = 80) => left + ' '.repeat(width - blessed.unicode.strWidth(left) - blessed.unicode.strWidth(right)) + right;
const LONG = `  const note = '${'long text '.repeat(30)}end';`;
// The lines of a file as they read once their rows are joined. A row with a sign or a number
// starts a line; the rows after it stand under the line's own first character.
function joined(rows, width, gutter = 8) {
  const out = [];
  let hang = 0;
  for (const text of rows.map(shown)) {
    if (text.slice(0, gutter).trim()) { const body = text.slice(gutter); hang = Math.min(body.length - body.trimStart().length, (width - gutter) >> 1); out.push(body); }
    else out[out.length - 1] += text.slice(gutter + hang);
  }
  return out;
}
const PATCH = [
  'diff --git a/src/coupon.mjs b/src/coupon.mjs', 'index 1111111..2222222 100644', '--- a/src/coupon.mjs', '+++ b/src/coupon.mjs', '@@ -8,4 +8,5 @@ export function normalize(value) {',
  ' \tconst text = String(value);', '-\treturn text;', '+\treturn text.trim() // {bold}not a tag{/bold} {red-fg}', `+  const note = '${'long text '.repeat(30)}end';`, '+ab\tc\x1b[31m red \x07 bell', ' }',
  'diff --git a/docs/old name.md b/docs/guides/a much longer new name.md', 'similarity index 90%', 'rename from docs/old name.md', 'rename to docs/guides/a much longer new name.md', 'index 3333333..4444444 100644',
  '--- a/docs/old name.md', '+++ b/docs/guides/a much longer new name.md', '@@ -998,3 +998,3 @@', ' context', '-日本語のテキスト old', '+日本語のテキスト new e\u0301', ' last', '\\ No newline at end of file',
  'diff --git a/logo.png b/logo.png', 'index 5555555..6666666 100644', 'Binary files a/logo.png and b/logo.png differ', '',
].join('\n');
const sample = () => buildChanges({ base: 'a1b2c3d4'.repeat(5), branch: 'feat/task-3', patch: PATCH, untracked: ['notes/new.txt'], read: () => ({ bytes: Buffer.from('one\ntwo\n'), size: 8 }) });

test('changeRows draws the summary, each file, its hunks and its numbered lines', () => {
  const rows = changeRows(sample(), 80, false);
  assert.deepEqual(rows.slice(0, 9).map(shown), [
    'a1b2c3d4...feat/task-3 · 4 files changed · +6 −2',
    '',
    edge('▾ src/coupon.mjs', '+3 −1'),
    // The hunk says where it is in words: the file, the line of its first change, the function.
    'src/coupon.mjs · line 9 · export function normalize(value) {',
    ' 8  8       const text = String(value);',
    ' 9    -     return text;',
    '    9 +     return text.trim() // {bold}not a tag{/bold} {red-fg}',
    `   10 + ${LONG.slice(0, 71)}`,
    `          ${LONG.slice(71, 141)}`,
  ]);
  assert.deepEqual(rows.slice(0, 9).map(row => [row.kind, row.file]), [['summary', null], ['blank', null], ['file', 0], ['hunk', 0], ['context', 0], ['del', 0], ['add', 0], ['add', 0], ['add', 0]]);
  // Content is shown as it is written: braces are text, never a style.
  assert.equal(rows[6].text, '    9 +     return text.trim() // {open}bold{close}not a tag{open}/bold{close} {open}red-fg{close}');
  // A tab goes to the next multiple of 4, and a control character becomes a visible sign.
  const odd = rows.find(row => shown(row).includes('bell'));
  assert.equal(shown(odd), '   11 + ab  c␛[31m red ␇ bell');
  for (const row of rows) assert.doesNotMatch(row.text, /[\x00-\x1f\x7f-\x9f]/);
  // A long line goes on under its own first character, ends each row after a word, and loses nothing.
  const long = rows.filter((row, index) => row.kind === 'add' && index >= 7 && index < rows.findIndex(row => row === odd));
  assert.equal(long.length, 5);
  assert.deepEqual(joined(long, 80), [LONG]);
  for (const row of long.slice(1)) assert.match(shown(row), /^ {10}\S/);
  for (const row of long.slice(0, -1)) assert.match(shown(row), / $/);
  // Numbers are as wide as the largest one in their file.
  const second = rows.filter(row => row.file === 1).map(shown);
  assert.deepEqual(second, [
    edge('▾ docs/old name.md → docs/guides/a much longer new name.md', '+1 −1'),
    'docs/guides/a much longer new name.md · line 999',
    ' 998  998   context',
    ' 999      - 日本語のテキスト old',
    '      999 + 日本語のテキスト new e\u0301',
    '1000 1000   last',
    '            \\ No newline at end of file',
  ]);
  assert.deepEqual(rows.filter(row => row.file === 2).map(row => [row.kind, shown(row)]), [['file', edge('▾ logo.png', 'binary')]]);
  assert.deepEqual(rows.filter(row => row.file === 3).map(shown), [edge('▾ notes/new.txt', 'new  +2 −0'), 'notes/new.txt · line 1', '  1 + one', '  2 + two']);
  // Nothing of Git's own header reaches the view.
  for (const row of rows) assert.doesNotMatch(shown(row), /^(?:diff --git|index [0-9a-f]|--- |\+\+\+ |@@ )/);
  assert.equal(rows.filter(row => row.kind === 'blank').length, 4);
});

test('changeRows folds files and keeps every row inside the width', () => {
  const changes = sample();
  assert.deepEqual(changeRows(changes, 80, false, { open: new Set() }).map(shown), [
    'a1b2c3d4...feat/task-3 · 4 files changed · +6 −2', '',
    edge('▸ src/coupon.mjs', '+3 −1'), edge('▸ docs/old name.md → docs/guides/a much longer new name.md', '+1 −1'), edge('▸ logo.png', 'binary'), edge('▸ notes/new.txt', 'new  +2 −0'),
  ]);
  const one = changeRows(changes, 80, false, { open: new Set([3]) });
  assert.deepEqual(one.map(row => row.kind), ['summary', 'blank', 'file', 'file', 'file', 'file', 'hunk', 'add', 'add']);
  assert.deepEqual(one.filter(row => row.kind === 'file').map(row => shown(row)[0]), ['▸', '▸', '▸', '▾']);
  // A path that does not fit loses its middle and keeps the file name. A rename keeps both ends.
  const narrow = changeRows({ ...changes, files: [{ ...changes.files[0], path: 'packages/storefront/src/components/checkout/CouponField.tsx', status: 'deleted' }, changes.files[1]] }, 40, false, { open: new Set() });
  assert.deepEqual(narrow.slice(1).map(shown), ['', '▸ packa…/CouponField.tsx  deleted  +3 −1', '▸ d…/old name.md → …r new name.md  +1 −1']);
  assert.equal(shown(changeRows({ ...changes, files: [{ ...changes.files[0], status: 'deleted' }] }, 60, false, { open: new Set() })[2]), edge('▸ src/coupon.mjs', 'deleted  +3 −1', 60));
  for (const colour of [true, false]) for (const open of [undefined, new Set(), new Set([0, 2])]) for (let width = 40; width <= 300; width++) {
    const rows = changeRows(changes, width, colour, { open });
    for (const row of rows) assert.ok(widthOf(row) <= width, `${width}: ${shown(row)}`);
    // The counts sit at the right edge.
    for (const row of rows.filter(row => row.kind === 'file')) assert.equal(widthOf(row), width, `${width}: ${shown(row)}`);
    // Whatever the width, the lines of a file read the same once their rows are joined.
    if (!open && !colour) assert.deepEqual(joined(rows.filter(row => row.file === 0 && row.kind === 'add'), width), ['    return text.trim() // {bold}not a tag{/bold} {red-fg}', LONG, 'ab  c␛[31m red ␇ bell']);
  }
});

test('changeRows colours added and removed lines, and reads the same without colour', () => {
  const changes = sample(), coloured = changeRows(changes, 80, true), bare = changeRows(changes, 80, false);
  assert.deepEqual(coloured.map(shown), bare.map(shown));
  assert.deepEqual(coloured.map(row => [row.kind, row.file]), bare.map(row => [row.kind, row.file]));
  // Green for added, red for removed, grey for the lines around them, and the numbers dimmer than all three.
  assert.equal(coloured[6].text, '{241-fg}    9{/} {79-fg}+     return text.trim() // {open}bold{close}not a tag{open}/bold{close} {open}red-fg{close}{/}');
  assert.equal(coloured[5].text, '{241-fg} 9   {/} {203-fg}-     return text;{/}');
  assert.equal(coloured[4].text, '{241-fg} 8  8{/} {247-fg}      const text = String(value);{/}');
  // The place of a hunk is blue, the function around it grey.
  assert.equal(coloured[3].text, '{75-fg}src/coupon.mjs · line 9{/}{247-fg} · export function normalize(value) {open}{/}');
  assert.match(coloured[2].text, /^\{247-fg\}▾\{\/\} \{255-fg\}\{bold\}src\/coupon\.mjs\{\/bold\}\{\/\} +\{79-fg\}\+3\{\/\} \{203-fg\}−1\{\/\}$/);
  assert.match(coloured[0].text, /\{79-fg\}\+6\{\/\} \{203-fg\}−2\{\/\}$/);
  // Without colour the signs carry the meaning.
  for (const row of bare) assert.doesNotMatch(row.text, /-fg\}|-bg\}/);
  assert.deepEqual(bare.filter(row => row.file === 3 && row.kind === 'add').map(row => row.text), ['  1 + one', '  2 + two']);
  assert.equal(bare[5].text, ' 9    -     return text;');
});

test('changeRows masks secrets, hides Windows line ends and says what a limit left out', () => {
  const key = [keyLike('-----BEGIN RSA ', 'PRIVATE KEY-----'), 'MIIEowIBAAKCAQEAsecretsecretsecret', 'c2VjcmV0c2VjcmV0c2VjcmV0', '-----END RSA PRIVATE KEY-----', 'after the key'];
  const file = (name, lines) => ({ path: name, from: null, status: 'added', binary: false, added: lines.length, removed: 0, hunks: [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: lines.map((text, index) => ({ kind: 'add', old: null, now: index + 1, text })) }], note: null, hidden: 0 });
  const text = rows => rows.filter(row => row.kind === 'add').map(row => shown(row).replace(/^\s*\d+ \+ /, ''));
  assert.deepEqual(text(changeRows({ files: [file('id_rsa', [...key, `const token = "${keyLike('sk-', 'abcdefghijklmnopqrstuvwx')}";`])], added: 6, removed: 0 }, 80, false)), ['[redacted]', '[redacted]', '[redacted]', '[redacted]', 'after the key', 'const [redacted];']);
  // A file with Windows line ends shows no mark for them. A change of line ends shows each one.
  assert.deepEqual(text(changeRows({ files: [file('win.txt', ['a\r', 'b\r'])], added: 2, removed: 0 }, 80, false)), ['a', 'b']);
  assert.deepEqual(text(changeRows({ files: [file('mixed.txt', ['a\r', 'b', 'x\u202ey'])], added: 3, removed: 0 }, 80, false)), ['a␍', 'b', 'x<U+202E>y']);
  // A very long line keeps its start and says how much is missing.
  const clipped = buildChanges({ untracked: ['min.js'], read: () => ({ bytes: Buffer.from(`${'z'.repeat(5000)}\n`), size: 5001 }) }), rows = changeRows(clipped, 120, false);
  assert.equal(clipped.cut, true); assert.equal(linesOf(clipped.files[0])[0].more, 3000);
  assert.deepEqual(rows.filter(row => row.kind === 'note').map(shown), ['Parts of some files are not shown. Each file says what is missing.', '      … 3,000 more characters not shown']);
  assert.equal(rows.filter(row => row.kind === 'add').map(row => shown(row).slice(6)).join(''), 'z'.repeat(2000));
  // The summary uses separators, one file is singular, and a path cannot draw a style or a control.
  const big = changeRows({ base: 'origin/main', branch: 'feat/task-2', files: [{ ...file('a{bold}\x1b[2J.txt', ['x']), added: 2468, removed: 177 }], added: 2468, removed: 177, cut: false }, 80, false, { open: new Set() });
  assert.deepEqual(big.map(shown), ['origin/main...feat/task-2 · 1 file changed · +2,468 −177', '', edge('▸ a{bold}␛[2J.txt', 'new  +2,468 −177')]);
  assert.equal(changeSummary({ files: new Array(24).fill(null) }), 'Changes 24'); assert.equal(changeSummary({ files: [], hiddenFiles: 1200 }), 'Changes 1,200'); assert.equal(changeSummary(null), 'Changes');
});

// What a session's computer sends of its changes (taskDetails): Git's patch, then each file
// Git does not track under its name.
const SENT = [PATCH.replace(/similarity index 90%\n/, ''), 'New file: docs/changes.md\n# Changes\n\n- one\n', 'New file: bin/tool\n(binary content)', 'New file: notes/open.txt\nno line end', 'New path: pipes/in (not a regular file)',
  'New file: logs/big.log\nline 9,998\nline 9,999\n\n[File preview truncated.]', 'New file: empty.txt\n', 'New file: last.txt\nNew files end here\n'].join('\n');

test('sessionChanges reads what a session sends: the patch, then every new file, whole, with no limit of the view', () => {
  const changes = sessionChanges(SENT);
  assert.deepEqual(changes.files.map(file => [file.path, file.status, file.binary, file.added, file.removed, file.note]), [
    ['src/coupon.mjs', 'modified', false, 3, 1, null], ['docs/guides/a much longer new name.md', 'renamed', false, 1, 1, null], ['logo.png', 'modified', true, 0, 0, 'binary file'],
    ['docs/changes.md', 'added', false, 3, 0, null], ['bin/tool', 'added', true, 0, 0, 'binary file'], ['notes/open.txt', 'added', false, 1, 0, null], ['pipes/in', 'added', false, 0, 0, 'not a regular file'],
    ['logs/big.log', 'added', false, 2, 0, 'only the end of this file was sent'], ['empty.txt', 'added', false, 0, 0, 'empty file'], ['last.txt', 'added', false, 1, 0, null],
  ]);
  assert.deepEqual([changes.added, changes.removed, changes.hiddenFiles, changes.hiddenLines, changes.base, changes.branch], [11, 2, 0, 0, null, null]);
  // A new file's lines are numbered from 1, and one that does not end with a line break says so.
  assert.deepEqual(linesOf(changes.files[3]), [{ kind: 'add', old: null, now: 1, text: '# Changes' }, { kind: 'add', old: null, now: 2, text: '' }, { kind: 'add', old: null, now: 3, text: '- one' }]);
  assert.deepEqual(linesOf(changes.files[5]), [{ kind: 'add', old: null, now: 1, text: 'no line end', eol: false }]);
  assert.deepEqual(linesOf(changes.files[9]), [{ kind: 'add', old: null, now: 1, text: 'New files end here' }]);
  // Only the end of a large new file is sent: its lines have no numbers, and the totals say they are short.
  assert.deepEqual(linesOf(changes.files[7]).map(line => [line.now, line.text]), [[null, 'line 9,998'], [null, 'line 9,999']]);
  assert.deepEqual([changes.cut, changes.uncounted], [true, true]);
  assert.equal(shown(changeRows(changes, 80, false, { open: new Set([7]) }).find(row => row.kind === 'hunk')), 'logs/big.log · the end of the file');
  // A line of the patch that reads like the start of a new file is a line of its hunk.
  const tricky = sessionChanges(['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1,2 +1,2 @@', '-New file: old.txt', '+New file: new.txt', ' New file: kept.txt', 'New file: real.txt', 'one', ''].join('\n'));
  assert.deepEqual(tricky.files.map(file => [file.path, file.added, file.removed, linesOf(file).map(line => line.text)]), [['a.txt', 1, 1, ['New file: old.txt', 'New file: new.txt', 'New file: kept.txt']], ['real.txt', 1, 0, ['one']]]);
  // New files alone, as for a session that only added some, and no text at all.
  assert.deepEqual(sessionChanges('\nNew file: only.txt\nfirst\nsecond\n').files.map(file => [file.path, file.added]), [['only.txt', 2]]);
  assert.deepEqual([sessionChanges('').files, sessionChanges(null).files, sessionChanges('').cut], [[], [], false]);
  // Nothing is left out for its size: 300 files of 100 lines, a file of 30,000 lines, a line of 50,000 characters.
  const many = Array.from({ length: 300 }, (_, file) => [`diff --git a/src/f${file}.mjs b/src/f${file}.mjs`, `--- a/src/f${file}.mjs`, `+++ b/src/f${file}.mjs`, '@@ -1,100 +1,100 @@', ...Array.from({ length: 100 }, (_, line) => `-old ${line}`), ...Array.from({ length: 100 }, (_, line) => `+new ${line}`)].join('\n')).join('\n');
  const large = sessionChanges([many, `New file: big.txt\n${numbered(30000)}`, `New file: wide.txt\n${'w'.repeat(50000)}\n`].join('\n'));
  assert.deepEqual([large.files.length, large.added, large.removed, large.cut, large.hiddenFiles, large.hiddenLines], [302, 60001, 30000, false, 0, 0]);
  assert.equal(linesOf(large.files[300]).length, 30000); assert.equal(linesOf(large.files[300]).at(-1).text, 'line 30000');
  assert.deepEqual([linesOf(large.files[301])[0].text.length, linesOf(large.files[301])[0].more], [50000, undefined]);
  assert.ok(large.files.every(file => !file.hidden && !file.note));
  // Where the changes are only named: the files and the lines, as the view's own summary counts them.
  assert.equal(changeCounts(changes, false), '10 files · +11 −2'); assert.equal(changeCounts(large, false), '302 files · +60,001 −30,000'); assert.equal(changeCounts({ files: [{}], added: 1, removed: 0 }, false), '1 file · +1 −0');
  assert.equal(changeCounts(changes, true), '{255-fg}10 files{/}{241-fg} · {/}{79-fg}+11{/} {203-fg}−2{/}');
});

// The line the owner could not read in the chat: one template literal of about 400 characters,
// changed inside a function far down its file.
const WIDE = tail => `    lines.push(\`\\nMatching orders with the same coupon on this page (\${d.matchingOrders.length} returned; \${Math.min(d.matchingOrders.length, 5)} shown; \${Math.max(0, d.matchingOrders.length - 5)} omitted; may include this order's own sample; matched by page + coupon code, not by customer — some may belong to a different customer, so do not report their dates, totals${tail} as this order's):\`);`;
const REPORT = ['diff --git a/src/report/format.mjs b/src/report/format.mjs', 'index 1111111..2222222 100644', '--- a/src/report/format.mjs', '+++ b/src/report/format.mjs', '@@ -644,9 +644,15 @@ function formatOrderDetail(d, ctx = {}) {',
  '     // so this list can hold orders from a DIFFERENT customer.', '     // Calling them "the same order" made two reports mix up these dates.', `-${WIDE(' or buyers')}`, `+${WIDE(', buyers or notes')}`, '     d.matchingOrders.slice(0, 5).forEach((o, i) => {',
  "       lines.push(`  ${i + 1}. ${ctx.user?.(o.buyer) ?? o.buyer} on ${o.placedAt} — ${o.total ?? 'unknown total'}`);", '+      // Each row carries its own stored title, so a reply that', '+      // describes one order quotes it instead of the caveat above.', "+      // The header forbids reporting these as this order's.",
  '+      if (o.title) lines.push(`     ${o.title}`);', '+      if (o.note) lines.push(`     note: ${o.note}`);', "+      if (o.refunded) lines.push('     refunded');", '     });', '   }', "   return lines.join('\\n');", ''].join('\n');

test('changeRows makes a very long line readable at every width: the sign and the numbers keep their columns, and the line goes on under its own text', () => {
  assert.deepEqual([WIDE(' or buyers').length, WIDE(', buyers or notes').length], [400, 407]);
  const changes = sessionChanges(REPORT);
  assert.deepEqual([changes.files.length, changes.added, changes.removed], [1, 7, 1]);
  // 72 columns, about what the pane has beside the list in a terminal 120 wide.
  const rows = changeRows(changes, 72, false).map(shown);
  assert.deepEqual(rows.slice(0, 20), [
    '1 file changed · +7 −1',
    '',
    edge('▾ src/report/format.mjs', '+7 −1', 72),
    'src/report/format.mjs · line 646 · function formatOrderDetail(d, ctx = …',
    '644 644       // so this list can hold orders from a DIFFERENT customer.',
    '645 645       // Calling them "the same order" made two reports mix up ',
    '              these dates.',
    '646     -     lines.push(`\\nMatching orders with the same coupon on ',
    '              this page (${d.matchingOrders.length} returned; ',
    '              ${Math.min(d.matchingOrders.length, 5)} shown; ',
    '              ${Math.max(0, d.matchingOrders.length - 5)} omitted; may ',
    "              include this order's own sample; matched by page + coupon ",
    '              code, not by customer — some may belong to a different ',
    '              customer, so do not report their dates, totals or buyers ',
    "              as this order's):`);",
    '    646 +     lines.push(`\\nMatching orders with the same coupon on ',
    '              this page (${d.matchingOrders.length} returned; ',
    '              ${Math.min(d.matchingOrders.length, 5)} shown; ',
    '              ${Math.max(0, d.matchingOrders.length - 5)} omitted; may ',
    "              include this order's own sample; matched by page + coupon ",
  ]);
  for (const colour of [true, false]) for (let width = 24; width <= 200; width++) {
    const drawn = changeRows(changes, width, colour), lines = drawn.filter(row => ['context', 'add', 'del'].includes(row.kind)), texts = lines.map(shown);
    for (const row of drawn) assert.ok(widthOf(row) <= width, `${width}: ${shown(row)}`);
    // Git's own header rows are never shown, and the place of the hunk is said in words.
    for (const row of drawn) assert.doesNotMatch(shown(row), /^(?:diff --git|index [0-9a-f]|--- |\+\+\+ |@@ )/, `${width}`);
    assert.match(shown(drawn.find(row => row.kind === 'hunk')), width >= 40 ? /format\.mjs · line 646/ : /format\.mjs/, `${width}`);
    // The first row of a line holds its numbers and its sign; the rows after it hold neither,
    // and start under the line's first character, so the sign's column reads + or - or nothing.
    for (const text of texts) assert.match(text, /^(?:\d{3}| {3}) (?:\d{3}| {3}) [-+ ] /, `${width}: ${text}`);
    assert.deepEqual(texts.filter(text => text.slice(0, 8).trim()).map(text => text.slice(0, 10)), ['644 644   ', '645 645   ', '646     - ', '    646 + ', '647 647   ', '648 648   ', '    649 + ', '    650 + ', '    651 + ', '    652 + ', '    653 + ', '    654 + ', '649 655   ', '650 656   ', '651 657   '], `${width}`);
    for (const text of texts.filter(text => !text.slice(0, 8).trim())) assert.match(text, /^ {10} *\S/, `${width}: ${text}`);
    // Nothing of the line is lost or added, whatever the width.
    if (!colour) assert.deepEqual(joined(lines, width, 10).slice(2, 4), [WIDE(' or buyers'), WIDE(', buyers or notes')], `${width}`);
    // Where a row has room for words, no word is cut in two.
    if (width >= 60) texts.forEach((text, at) => { const next = texts[at + 1] ?? 'x'; assert.ok(next.slice(0, 8).trim() || !(/\w$/.test(text) && /^\w/.test(next.trimStart())), `${width}: cut inside a word: ${text}`); });
  }
  // Coloured, the sign and the text of an added row are green, of a removed row red, and a row that goes on keeps its colour.
  const coloured = changeRows(changes, 72, true).map(row => row.text);
  assert.equal(coloured[7], '{241-fg}646    {/} {203-fg}-     lines.push(`\\nMatching orders with the same coupon on {/}');
  assert.equal(coloured[8], '              {203-fg}this page (${open}d.matchingOrders.length{close} returned; {/}');
  assert.equal(coloured[15], '{241-fg}    646{/} {79-fg}+     lines.push(`\\nMatching orders with the same coupon on {/}');
  assert.equal(coloured[16], '              {79-fg}this page (${open}d.matchingOrders.length{close} returned; {/}');
  assert.equal(coloured[4], '{241-fg}644 644{/} {247-fg}      // so this list can hold orders from a DIFFERENT customer.{/}');
  // One line of a megabyte is cut into rows as fast as the same text in many lines.
  const line = 'const value = compute(first, second); '.repeat(28000), mega = sessionChanges(`New file: min.js\n${line}\n`), started = Date.now(), wide = changeRows(mega, 100, false);
  assert.ok(Date.now() - started < 3000, `a line of a megabyte took ${Date.now() - started} ms`);
  assert.ok(line.length > 1000000); assert.equal(joined(wide.filter(row => row.kind === 'add'), 100, 6)[0], line);
});
