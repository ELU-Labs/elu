import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, git, command, temp } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { saveTask, readTask } from '../lib/state.mjs';
import { taskPatch, taskDetails, sessionWire } from '../lib/projects.mjs';
import { sessionChanges } from '../lib/diff.mjs';
import { NOTES, sessionFiles } from '../lib/session-work.mjs';
import { changeCounts, changeRows, changeSummary } from '../lib/changes.mjs';
import { visible } from '../lib/terminal-visuals.mjs';

// What a session itself changed (lib/session-work.mjs), in each way a session moves its
// folder. Every scene is a real repository: the owner's checkout on main, a remote beside it
// that other people land work on, and the session's own folder.
function write(root, files) {
  for (const [name, text] of Object.entries(files)) { const full = path.join(root, name); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); }
}
const commit = (root, files, message) => { write(root, files); git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', message]); return git(root, ['rev-parse', 'HEAD']); };
// place: worktree, as the runner makes one for a session, or here, the owner's own checkout.
function scene(t, { place = 'worktree' } = {}) {
  const { parent, root } = project(t), origin = path.join(parent, 'origin.git'), other = path.join(parent, 'other');
  git(parent, ['init', '-q', '--bare', '--initial-branch=main', origin]);
  git(root, ['remote', 'add', 'origin', origin]); git(root, ['push', '-q', 'origin', 'main']); git(root, ['fetch', '-q', 'origin']);
  git(parent, ['clone', '-q', origin, other]); git(other, ['config', 'user.name', 'Someone Else']); git(other, ['config', 'user.email', 'else@example.invalid']);
  const repo = repository(root), base = git(root, ['rev-parse', 'HEAD']), here = place === 'here', folder = here ? root : path.join(repo.worktrees, '1');
  if (!here) { fs.mkdirSync(repo.worktrees, { recursive: true }); git(root, ['worktree', 'add', '-q', '-b', 'feat/task-1', folder, base]); }
  saveTask(repo, { id: '1', goal: 'Normalize coupons', state: 'ready', worktree: folder, branch: here ? null : 'feat/task-1', base, createdAt: new Date().toISOString(), runs: [], reviews: [], messages: [], sessions: {}, ...(here ? { permissions: 'full', place: { kind: 'here' } } : {}) });
  // What other people land on main while the session works.
  const land = (files, message) => { git(other, ['pull', '-q', 'origin', 'main']); commit(other, files, message); git(other, ['push', '-q', 'origin', 'main']); };
  return { root, repo, base, folder, land, origin };
}
const names = changes => changes.files.map(file => file.path);
const counts = changes => [changes.files.length, changes.added, changes.removed];
const parts = changes => changes.parts.map(part => [part.branch, part.current, part.files, part.added, part.removed, part.compared]);
// What the session's own computer shows and what another computer is sent agree.
function sent(repo) {
  const changes = sessionChanges(sessionWire(repo, '1'));
  return { changes, names: names(changes), counts: counts(changes), parts: parts(changes) };
}
// The rule this replaces: the session's folder against the commit it started from.
const sinceBase = (folder, base) => git(folder, ['diff', '--name-only', base, '--']).split('\n').filter(Boolean);
const STARTED = 'main as it was when this session started', BRANCHED = 'main as it was when this session branched';

test('a session that edits and does not commit shows its edits, compared with main as it was when it started', t => {
  const { repo, base, folder } = scene(t);
  write(folder, { 'src/coupon.mjs': 'export const normalize = (value) => value.trim();\n', 'docs/notes.md': 'one\ntwo\n' });
  const changes = taskPatch(repo, '1');
  assert.deepEqual(names(changes), ['src/coupon.mjs', 'docs/notes.md']);
  assert.deepEqual(counts(changes), [2, 3, 1]);
  assert.deepEqual(parts(changes), [['feat/task-1', true, 2, 3, 1, STARTED]]);
  assert.deepEqual([changes.base, changes.branch, changes.compared, changes.note], [base, 'feat/task-1', STARTED, null]);
  assert.deepEqual([sent(repo).names, sent(repo).counts, sent(repo).parts], [names(changes), counts(changes), parts(changes)]);
  assert.equal(visible(changeRows(changes, 100, false)[0].text), `2 files changed · +3 −1 · compared with ${STARTED}`);
});

test('a session that commits its own work on its own branch shows its commits and what is not committed yet', t => {
  const { repo, folder } = scene(t);
  commit(folder, { 'src/coupon.mjs': 'export const normalize = (value) => value.trim();\n' }, 'Trim coupons');
  commit(folder, { 'src/cart.mjs': 'export const cart = [];\n' }, 'Add a cart');
  // An amended commit is still the session's.
  write(folder, { 'src/cart.mjs': 'export const cart = [];\nexport const size = () => cart.length;\n' }); git(folder, ['commit', '-q', '-a', '--amend', '--no-edit']);
  write(folder, { 'README.md': '# Sample\n' });
  const changes = taskPatch(repo, '1');
  assert.deepEqual(names(changes).sort(), ['README.md', 'src/cart.mjs', 'src/coupon.mjs']);
  assert.deepEqual(counts(changes), [3, 4, 1]);
  assert.deepEqual(parts(changes), [['feat/task-1', true, 3, 4, 1, STARTED]]);
  assert.equal(changes.note, null);
  assert.deepEqual(sent(repo).counts, [3, 4, 1]);
});

test('a session that fetches, moves to a newer main and commits there shows only its commits and its edits, never what others landed', t => {
  const { repo, base, folder, land } = scene(t);
  // Other people land 40 files on main after the session started.
  land(Object.fromEntries(Array.from({ length: 40 }, (_, at) => [`landed/file-${at}.txt`, `landed ${at}\n`.repeat(50)])), 'Land forty files');
  git(folder, ['fetch', '-q', 'origin']); git(folder, ['checkout', '-q', '-b', 'fix/rounding', 'origin/main']);
  commit(folder, { 'src/coupon.mjs': 'export const normalize = (value) => value.trim();\n', 'src/round.mjs': 'export const round = value => Math.round(value);\n' }, 'Round totals');
  write(folder, { 'docs/rounding.md': 'Totals are rounded.\n' });
  // The folder against the commit the session started from counts all 40.
  assert.equal(sinceBase(folder, base).length, 42);
  const changes = taskPatch(repo, '1');
  assert.deepEqual(names(changes), ['src/coupon.mjs', 'src/round.mjs', 'docs/rounding.md']);
  assert.deepEqual(counts(changes), [3, 3, 1]);
  assert.deepEqual(parts(changes), [['fix/rounding', true, 3, 3, 1, BRANCHED]]);
  assert.deepEqual([changes.branch, changes.note], ['fix/rounding', null]);
  // The tab, the line in the chat, what a teammate's board is told and what another computer is sent all say the same.
  assert.equal(changeSummary(changes), 'Changes 3');
  assert.equal(changeCounts(changes, false), '3 files · +3 −1');
  assert.deepEqual(sessionFiles(readTask(repo, '1')), ['docs/rounding.md', 'src/coupon.mjs', 'src/round.mjs']);
  assert.deepEqual([sent(repo).names, sent(repo).counts, sent(repo).parts], [names(changes), counts(changes), parts(changes)]);
  const details = taskDetails(repo, '1').diff;
  assert.match(details, /src\/round\.mjs/); assert.match(details, /New file: docs\/rounding\.md/); assert.doesNotMatch(details, /landed\//);
  // It pulls a still newer main onto its branch with nothing of its own to commit: still only its work.
  land({ 'landed/later.txt': 'later\n' }, 'Land one more');
  git(folder, ['stash', '-q', '-u']); git(folder, ['checkout', '-q', '-b', 'fix/next', 'origin/main']); git(folder, ['pull', '-q', 'origin', 'main']); git(folder, ['stash', 'pop', '-q']);
  const moved = taskPatch(repo, '1');
  assert.deepEqual(parts(moved), [['fix/next', true, 1, 1, 0, BRANCHED], ['fix/rounding', false, 2, 2, 1, BRANCHED]]);
  assert.doesNotMatch(JSON.stringify(names(moved)), /landed/);
});

// GitHub's program as the repository's stand-in plays it (test/fakes/gh.mjs), first on PATH:
// signed in, it lists the pull requests of a branch; signed out, it says so and fails.
function standInGh(t, pulls) {
  const dir = temp(t), bin = path.join(dir, 'bin'), store = path.join(dir, 'store'), before = { PATH: process.env.PATH, FAKE_GH_STORE: process.env.FAKE_GH_STORE, FAKE_GH_ACCOUNT: process.env.FAKE_GH_ACCOUNT };
  fs.mkdirSync(bin); fs.mkdirSync(store);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\n${fs.readFileSync(new URL('./fakes/gh.mjs', import.meta.url), 'utf8')}`, { mode: 0o755 });
  fs.writeFileSync(path.join(store, 'pulls.json'), JSON.stringify(pulls));
  Object.assign(process.env, { PATH: `${bin}${path.delimiter}${before.PATH}`, FAKE_GH_STORE: store, FAKE_GH_ACCOUNT: 'ana' });
  t.after(() => { for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  return { calls: () => { try { return fs.readFileSync(path.join(store, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).args); } catch { return []; } }, signOut: () => { delete process.env.FAKE_GH_ACCOUNT; } };
}

test('a session that made several branches in turn lists each with its own files and counts, the one checked out first, and its pull request', async t => {
  const { repo, base, folder, land } = scene(t);
  const gh = standInGh(t, { 'fix/one': [{ number: 12, state: 'MERGED', url: 'https://code.example.invalid/shop/pull/12' }], 'fix/two': [{ number: 9, state: 'CLOSED', url: 'https://code.example.invalid/shop/pull/9' }, { number: 13, state: 'OPEN', url: 'https://code.example.invalid/shop/pull/13' }] });
  for (const [branch, file] of [['fix/one', 'one'], ['fix/two', 'two'], ['fix/three', 'three']]) {
    land({ [`landed/${file}.txt`]: `landed before ${file}\n`.repeat(20) }, `Land before ${file}`);
    git(folder, ['fetch', '-q', 'origin']); git(folder, ['checkout', '-q', '-b', branch, 'origin/main']);
    commit(folder, { [`src/${file}.mjs`]: `export const ${file} = true;\n`, 'src/coupon.mjs': `export const normalize = (value) => value.${file}();\n` }, `Add ${file}`);
    if (branch !== 'fix/three') git(folder, ['push', '-q', 'origin', branch]);
  }
  write(folder, { 'notes.md': 'not committed\n' });
  assert.equal(sinceBase(folder, base).length, 5);
  // The first answer does not wait for GitHub; a later one has what it said, and the view is told to read again.
  let told = 0, changes = taskPatch(repo, '1', { changed: () => { told++; } });
  assert.deepEqual(changes.parts.map(part => part.pull), [null, null, null]);
  for (let tries = 0; tries < 200 && changes.parts.filter(part => part.pull).length < 2; tries++) { await new Promise(done => setTimeout(done, 50)); changes = taskPatch(repo, '1'); }
  assert.ok(told >= 1);
  assert.deepEqual(parts(changes), [['fix/three', true, 3, 3, 1, BRANCHED], ['fix/two', false, 2, 2, 1, BRANCHED], ['fix/one', false, 2, 2, 1, BRANCHED]]);
  assert.deepEqual(changes.parts.map(part => part.pull), [null, { number: 13, url: 'https://code.example.invalid/shop/pull/13' }, { number: 12, url: 'https://code.example.invalid/shop/pull/12' }]);
  assert.deepEqual(names(changes), ['src/coupon.mjs', 'src/three.mjs', 'notes.md', 'src/coupon.mjs', 'src/two.mjs', 'src/coupon.mjs', 'src/one.mjs']);
  assert.deepEqual(counts(changes), [7, 7, 3]);
  assert.deepEqual([changes.compared, changes.note], [null, null]);
  // One path changed on three branches is three files, each with its branch.
  assert.deepEqual(changes.files.filter(file => file.path === 'src/coupon.mjs').map(file => file.branch), ['fix/three', 'fix/two', 'fix/one']);
  const rows = changeRows(changes, 100, false, { open: new Set() }).map(row => visible(row.text).trimEnd());
  assert.equal(rows[0], `3 branches · 7 files changed · +7 −3 · each compared with ${BRANCHED}`);
  assert.deepEqual(rows.filter(text => /^fix\//.test(text)), ['fix/three · checked out · 3 files · +3 −1', 'fix/two · PR #13 · 2 files · +2 −1 · https://code.example.invalid/shop/pull/13', 'fix/one · PR #12 · 2 files · +2 −1 · https://code.example.invalid/shop/pull/12']);
  // Another computer is sent the same branches, counts and pull requests.
  const there = sent(repo);
  assert.deepEqual([there.names, there.counts, there.parts], [names(changes), counts(changes), parts(changes)]);
  assert.deepEqual(there.changes.parts.map(part => part.pull), changes.parts.map(part => part.pull));
  // GitHub was asked about the two branches the remote has, once each, and about nothing else.
  assert.deepEqual(gh.calls().map(args => args.join(' ')).sort(), ['fix/one', 'fix/two'].map(name => `pr list --head ${name} --state all --limit 20 --json number,url,state`));
  // With more files than a screen holds, the branches are listed under the summary before the first file, each thing in its column.
  write(folder, Object.fromEntries(Array.from({ length: 9 }, (_, at) => [`extra/file-${at}.txt`, 'x\n'])));
  const long = changeRows(taskPatch(repo, '1'), 110, false, { open: new Set() }).map(row => visible(row.text).trimEnd());
  assert.deepEqual(long.slice(0, 6), [`3 branches · 16 files changed · +16 −3 · each compared with ${BRANCHED}`, '  fix/three  checked out  12 files  +12 −1', '  fix/two    PR #13        2 files   +2 −1', '  fix/one    PR #12        2 files   +2 −1', '', 'fix/three · checked out · 12 files · +12 −1']);
  // A narrow pane, as beside the sessions of a terminal 80 columns across: a branch's name stays whole. The list leaves out how many
  // files, and a name or an address that does not fit beside the rest has a row to itself.
  const narrow = width => changeRows(taskPatch(repo, '1'), width, false, { open: new Set() }).map(row => visible(row.text).trimEnd());
  assert.deepEqual(narrow(40).slice(0, 7), ['3 branches · 16 files changed · +16 −3', 'each compared with main as it was when', 'this session branched', '  fix/three  checked out  +12 −1', '  fix/two    PR #13        +2 −1', '  fix/one    PR #12        +2 −1', '']);
  assert.deepEqual(narrow(40).filter(text => /^fix\/|^ {2}(?:checked|PR|https)/.test(text)), ['fix/three', '  checked out · 12 files · +12 −1', 'fix/two · PR #13 · 2 files · +2 −1', 'fix/one · PR #12 · 2 files · +2 −1']);
  assert.deepEqual(narrow(46).filter(text => /^fix\/|^ {2}(?:checked|PR|https)/.test(text)), ['fix/three · checked out · 12 files · +12 −1', 'fix/two · PR #13 · 2 files · +2 −1', '  https://code.example.invalid/shop/pull/13', 'fix/one · PR #12 · 2 files · +2 −1', '  https://code.example.invalid/shop/pull/12']);
  for (const width of [24, 30, 40, 46, 76, 94, 138]) for (const row of changeRows(taskPatch(repo, '1'), width, false)) assert.ok(visible(row.text).length <= width, `${width}: ${visible(row.text)}`);
  fs.rmSync(path.join(folder, 'extra'), { recursive: true });
  // A branch that was pushed and then deleted here is still the session's: the remote has it.
  git(folder, ['branch', '-q', '-D', 'fix/one']);
  assert.deepEqual(parts(taskPatch(repo, '1')).map(part => part[0]), ['fix/three', 'fix/two', 'fix/one']);
  // The pull request ELU opened for the session's own branch is known without asking GitHub.
  git(folder, ['stash', '-q', '-u']); git(folder, ['checkout', '-q', 'feat/task-1']); commit(folder, { 'src/own.mjs': 'export const own = 1;\n' }, 'Own work');
  saveTask(repo, { ...readTask(repo, '1'), pr: 'https://code.example.invalid/shop/pull/7' });
  const own = taskPatch(repo, '1');
  assert.deepEqual([own.parts[0].branch, own.parts[0].pull, own.parts[0].compared], ['feat/task-1', { number: 7, url: 'https://code.example.invalid/shop/pull/7' }, STARTED]);
  assert.deepEqual(own.parts.map(part => part.branch), ['feat/task-1', 'fix/three', 'fix/two', 'fix/one']);
});

test('signed out of GitHub, a branch the session pushed shows no pull request, and nothing waits for it or fails', async t => {
  const { repo, folder, land } = scene(t), gh = standInGh(t, { 'fix/one': [{ number: 12, state: 'OPEN', url: 'https://code.example.invalid/shop/pull/12' }] });
  gh.signOut();
  land({ 'landed/a.txt': 'a\n' }, 'Land a file');
  git(folder, ['fetch', '-q', 'origin']); git(folder, ['checkout', '-q', '-b', 'fix/one', 'origin/main']);
  commit(folder, { 'src/one.mjs': 'export const one = 1;\n' }, 'Add one'); git(folder, ['push', '-q', 'origin', 'fix/one']);
  assert.deepEqual(taskPatch(repo, '1').parts.map(part => [part.branch, part.files, part.pull]), [['fix/one', 1, null]]);
  for (let tries = 0; tries < 200 && !gh.calls().length; tries++) await new Promise(done => setTimeout(done, 50));
  await new Promise(done => setTimeout(done, 500));
  const changes = taskPatch(repo, '1');
  assert.deepEqual(changes.parts.map(part => [part.branch, part.files, part.pull]), [['fix/one', 1, null]]);
  assert.deepEqual(changeRows(changes, 100, false).map(row => visible(row.text)).filter(text => /PR #|pull/.test(text)), []);
  // It is asked once, and not again with every look.
  assert.equal(gh.calls().length, 1);
});

test('a session in here mode, in the owner\'s own folder, counts what was committed and edited there since it started, and says so', async t => {
  const { root, repo } = scene(t);
  // Before the session: the owner's own commit on another branch of this folder.
  git(root, ['checkout', '-q', '-b', 'side']);
  write(root, { 'side.txt': 'the owner made this long before\n' }); git(root, ['add', '-A']);
  assert.equal(command('git', ['-C', root, 'commit', '-q', '-m', 'Owner work on side'], root, { GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' }).status, 0);
  assert.equal(command('git', ['-C', root, 'checkout', '-q', 'main'], root, { GIT_COMMITTER_DATE: '2020-01-01T00:00:01Z' }).status, 0);
  // And what the owner had not committed there: an edit, a new file, and a file taken away.
  write(root, { 'package.json': '{ "name": "sample", "private": true }\n', 'owner/draft.md': 'the owner was writing this\n' }); fs.rmSync(path.join(root, 'test/coupon.test.mjs'));
  await new Promise(done => setTimeout(done, 30));
  const base = git(root, ['rev-parse', 'HEAD']);
  saveTask(repo, { id: '2', goal: 'Work here', state: 'ready', worktree: root, branch: null, base, createdAt: new Date().toISOString(), runs: [], reviews: [], messages: [], sessions: {}, permissions: 'full', place: { kind: 'here' } });
  write(root, { 'src/coupon.mjs': 'export const normalize = (value) => value.trim();\n' }); git(root, ['add', 'src/coupon.mjs']); git(root, ['commit', '-q', '-m', 'Trim coupons']);
  write(root, { 'docs/here.md': 'edited here\n' });
  const changes = taskPatch(repo, '2');
  assert.deepEqual(names(changes), ['src/coupon.mjs', 'docs/here.md']);
  assert.deepEqual(parts(changes), [['main', true, 2, 2, 1, STARTED]]);
  assert.equal(changes.note, NOTES.here);
  const rows = changeRows(changes, 120, false).map(row => visible(row.text));
  assert.deepEqual(rows.slice(0, 2), [`2 files changed · +2 −1 · compared with ${STARTED}`, 'This session works in your own folder, so changes anyone else made there since it started count too.']);
  // What the owner had not committed before the session started is not the session's: Git still lists it, the tab does not.
  assert.deepEqual(git(root, ['status', '--porcelain']).split('\n').map(line => line.trim().split(' ').pop()).sort(), ['docs/', 'owner/', 'package.json', 'test/coupon.test.mjs']);
  // What another computer is sent, what a teammate's board is told and what a review is shown leave it out the same.
  const there = sessionChanges(sessionWire(repo, '2'));
  assert.deepEqual([there.note, names(there), counts(there)], [NOTES.here, names(changes), counts(changes)]);
  assert.deepEqual(sessionFiles(readTask(repo, '2')), ['docs/here.md', 'src/coupon.mjs']);
  assert.doesNotMatch(taskDetails(repo, '2').diff, /package\.json|owner\/draft|coupon\.test/);
  // The owner's file is the session's once the session writes it.
  write(root, { 'owner/draft.md': 'the owner was writing this\nand the session went on\n' });
  assert.deepEqual(names(taskPatch(repo, '2')), ['src/coupon.mjs', 'docs/here.md', 'owner/draft.md']);
  fs.rmSync(path.join(root, 'owner'), { recursive: true });
  // It moves to the owner's older branch: that commit was made here before the session, so it is not the session's.
  git(root, ['stash', '-q', '-u']); git(root, ['checkout', '-q', 'side']); write(root, { 'side.txt': 'the owner made this long before\nand the session added this\n' });
  const moved = taskPatch(repo, '2');
  assert.deepEqual(moved.parts.map(part => [part.branch, part.files, part.added, part.removed]), [['side', 1, 1, 0], ['main', 1, 1, 1]]);
  assert.deepEqual(names(moved), ['side.txt', 'src/coupon.mjs']);
});

test('a session that merged main into its branch, or rebased onto it, still shows only its own changes', t => {
  const { repo, folder, land } = scene(t);
  commit(folder, { 'src/coupon.mjs': 'export const normalize = (value) => value.trim();\n' }, 'Trim coupons');
  land({ 'landed/a.txt': 'a\n'.repeat(30), 'landed/b.txt': 'b\n'.repeat(30) }, 'Land two files');
  git(folder, ['fetch', '-q', 'origin']); git(folder, ['merge', '-q', '--no-edit', 'origin/main']);
  commit(folder, { 'src/after.mjs': 'export const after = 1;\n' }, 'After the merge');
  const merged = taskPatch(repo, '1');
  assert.deepEqual(names(merged).sort(), ['src/after.mjs', 'src/coupon.mjs']);
  assert.deepEqual(parts(merged), [['feat/task-1', true, 2, 2, 1, 'main as it was when this session last merged it in']]);
  assert.equal(merged.note, null);
  assert.deepEqual(sent(repo).counts, [2, 2, 1]);
  // More lands, and the session rebases its branch onto it.
  land({ 'landed/c.txt': 'c\n'.repeat(30) }, 'Land a third');
  git(folder, ['fetch', '-q', 'origin']); git(folder, ['rebase', '-q', 'origin/main']);
  write(folder, { 'docs/rebased.md': 'after the rebase\n' });
  const rebased = taskPatch(repo, '1');
  assert.deepEqual(names(rebased).sort(), ['docs/rebased.md', 'src/after.mjs', 'src/coupon.mjs']);
  assert.deepEqual(parts(rebased), [['feat/task-1', true, 3, 3, 1, BRANCHED]]);
  // A fast-forward to a newer main, with no commit of its own, leaves only what is not committed.
  land({ 'landed/d.txt': 'd\n' }, 'Land a fourth');
  git(folder, ['stash', '-q', '-u']); git(folder, ['checkout', '-q', '-b', 'look', 'origin/main']); git(folder, ['fetch', '-q', 'origin']); git(folder, ['merge', '-q', '--ff-only', 'origin/main']);
  write(folder, { 'look.md': 'just looking\n' });
  const forward = taskPatch(repo, '1');
  assert.deepEqual(parts(forward), [['look', true, 1, 1, 0, BRANCHED], ['feat/task-1', false, 2, 2, 1, BRANCHED]]);
});

test('where ELU cannot tell which commits are the session\'s it says so in one line, and counts only what it can stand behind', t => {
  const { repo, folder, land, origin } = scene(t);
  land({ 'landed/a.txt': 'a\n'.repeat(30) }, 'Land a file');
  git(folder, ['fetch', '-q', 'origin']); git(folder, ['checkout', '-q', '-b', 'fix/one', 'origin/main']);
  commit(folder, { 'src/one.mjs': 'export const one = 1;\n' }, 'Add one');
  write(folder, { 'notes.md': 'not committed\n' });
  assert.deepEqual(counts(taskPatch(repo, '1')), [2, 2, 0]);
  // The folder's record of where HEAD went is gone: only what is not committed is certain.
  const log = path.resolve(folder, git(folder, ['rev-parse', '--git-path', 'logs/HEAD']));
  const kept = fs.readFileSync(log); fs.writeFileSync(log, '');
  const blind = taskPatch(repo, '1');
  assert.deepEqual([names(blind), counts(blind), blind.note], [['notes.md'], [1, 1, 0], NOTES.blind]);
  assert.deepEqual(changeRows(blind, 120, false).slice(0, 2).map(row => visible(row.text)), ['1 file changed · +1 −0 · compared with the last commit on fix/one', "ELU cannot tell which commits here are this session's, so this shows only what is not committed yet."]);
  assert.deepEqual([sent(repo).counts, sent(repo).changes.note], [[1, 1, 0], NOTES.blind]);
  // With nothing uncommitted the line is still said, on this computer and on another.
  fs.rmSync(path.join(folder, 'notes.md'));
  assert.deepEqual(changeRows(taskPatch(repo, '1'), 120, false).map(row => visible(row.text)), ['No changes yet.', "ELU cannot tell which commits here are this session's, so this shows only what is not committed yet."]);
  assert.equal(sessionChanges(sessionWire(repo, '1')).note, NOTES.blind);
  fs.writeFileSync(log, kept);
  // Another person pushes a branch that main does not have, and the session merges it into its own:
  // what the session changed since that merge is its own for certain.
  const far = path.join(path.dirname(origin), 'far');
  git(path.dirname(origin), ['clone', '-q', origin, far]); git(far, ['config', 'user.name', 'Far Away']); git(far, ['config', 'user.email', 'far@example.invalid']);
  git(far, ['checkout', '-q', '-b', 'feature', 'HEAD~1']); commit(far, { 'far/feature.txt': 'their feature\n'.repeat(10) }, 'Their feature'); git(far, ['push', '-q', 'origin', 'feature']);
  git(folder, ['checkout', '-q', 'fix/one']); git(folder, ['fetch', '-q', 'origin']); git(folder, ['merge', '-q', '--no-edit', 'origin/feature']);
  commit(folder, { 'src/two.mjs': 'export const two = 2;\n' }, 'Add two');
  const mixed = taskPatch(repo, '1');
  assert.equal(mixed.note, NOTES.merge('fix/one'));
  assert.deepEqual(names(mixed), ['src/two.mjs']);
  assert.deepEqual(mixed.parts.map(part => [part.branch, part.compared]), [['fix/one', 'fix/one after the last merge this session made']]);
  assert.doesNotMatch(JSON.stringify(names(mixed)), /far\/|landed\//);
});
