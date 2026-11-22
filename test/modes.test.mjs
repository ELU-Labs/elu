import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODES, PROFILES, LABELS, BADGES, DEFAULT_MODE, checkMode, checkPlace, checkFolders, capMode, defaultMode, saveDefaultMode, runProfile, isPeerRun, fromMyComputer, fromTeammate, myComputer, myComputersLoaded } from '../lib/modes.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { createTeam } from '../lib/peer/roster.mjs';
import { createInvite, redeemCode } from '../lib/peer/invite.mjs';
import { markMyComputer, unmarkMyComputer } from '../lib/peer/my-computers.mjs';
import { onDisk, onDiskUp, personalDirectory } from '../lib/util.mjs';

// A temp folder with its own ELU personal directory (XDG_CONFIG_HOME) for the test.
function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-modes-'))), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('modes and places are checked by name, and here needs Full access', () => {
  assert.deepEqual(MODES, ['ask', 'auto', 'full']); assert.deepEqual(PROFILES, ['locked', ...MODES]);
  for (const mode of PROFILES) assert.ok(LABELS[mode] && BADGES[mode], mode);
  for (const mode of MODES) assert.equal(checkMode(mode), mode);
  for (const value of ['locked', 'Full', '', null, 1, ['ask']]) assert.throws(() => checkMode(value), /Choose ask, auto, or full/, String(value));
  // A schedule takes Full access too (lib/schedules.mjs keeps it for a mode the owner picked).
  assert.equal(checkMode('full', { allowFull: false }), 'full', 'the old option no longer narrows it');
  assert.deepEqual(checkPlace(null), { kind: 'worktree' }); assert.deepEqual(checkPlace('worktree'), { kind: 'worktree' }); assert.deepEqual(checkPlace({ kind: 'worktree' }), { kind: 'worktree' });
  assert.deepEqual(checkPlace('branch:feat/x-1.2', { mode: 'ask' }), { kind: 'branch', branch: 'feat/x-1.2' });
  assert.deepEqual(checkPlace({ kind: 'branch', branch: 'main' }), { kind: 'branch', branch: 'main' });
  assert.deepEqual(checkPlace('here', { mode: 'full' }), { kind: 'here' }); assert.deepEqual(checkPlace({ kind: 'here' }, { mode: 'full' }), { kind: 'here' });
  for (const mode of ['ask', 'auto', 'locked', undefined]) assert.throws(() => checkPlace('here', { mode }), /Here needs Full access/, String(mode));
  for (const branch of ['', '-x', 'a..b', 'a//b', '.hidden', 'dir/.hidden', 'x.lock', 'a/', '/a', 'a@{1}', 'sp ace', 'x'.repeat(201)]) assert.throws(() => checkPlace(`branch:${branch}`), /plain branch name/, branch);
  assert.throws(() => checkPlace({ kind: 'branch' }), /plain branch name/);
  assert.throws(() => checkPlace({ kind: 'worktree', branch: 'x' }), /Only a branch place names a branch/);
  for (const value of ['elsewhere', ['here'], 5, { kind: 'repo' }]) assert.throws(() => checkPlace(value), /Choose worktree, branch, or here/, String(value));
  assert.equal(capMode('full', 'auto'), 'auto'); assert.equal(capMode('ask', 'full'), 'ask'); assert.equal(capMode('auto', 'locked'), 'locked'); assert.equal(capMode('auto', 'auto'), 'auto');
  assert.throws(() => capMode('open', 'auto'), /Choose ask, auto, or full/);
});

test('a path is known by what it is on disk: a link is what it leads to, a missing path is nothing, and the folders above it are known the same way', t => {
  const dir = home(t), real = path.join(dir, 'a', 'b'), link = path.join(dir, 'link');
  fs.mkdirSync(real, { recursive: true }); fs.symlinkSync(real, link); fs.mkdirSync(path.join(dir, 'c'));
  assert.match(onDisk(real), /^\d+:\d+$/); assert.equal(onDisk(link), onDisk(real)); assert.equal(onDisk(`${real}/`), onDisk(real));
  assert.notEqual(onDisk(path.join(dir, 'c')), onDisk(real)); assert.equal(onDisk(path.join(dir, 'missing')), null);
  const up = onDiskUp(real), parts = real.split(path.sep).length;
  assert.equal(up.length, parts); assert.deepEqual(up.slice(0, 3), [onDisk(real), onDisk(path.join(dir, 'a')), onDisk(dir)]); assert.equal(up.at(-1), onDisk(path.parse(real).root));
  assert.deepEqual(onDiskUp(path.join(real, 'missing')).slice(0, 2), [null, onDisk(real)]);
});

test('folders are existing directories inside the home, never secrets or ELU state, at most eight', t => {
  const dir = home(t), h = path.join(dir, 'home'), work = path.join(h, 'work'), state = path.join(h, 'state');
  process.env.XDG_CONFIG_HOME = state;
  fs.mkdirSync(path.join(work, 'a'), { recursive: true }); fs.mkdirSync(path.join(h, '.ssh')); fs.mkdirSync(personalDirectory(), { recursive: true });
  fs.writeFileSync(path.join(h, 'file.txt'), ''); fs.symlinkSync(path.join(h, '.ssh'), path.join(work, 'keys'));
  assert.deepEqual(checkFolders(null, { home: h }), []); assert.deepEqual(checkFolders([], { home: h }), []);
  assert.deepEqual(checkFolders([work, path.join(work, 'a'), `${work}/`, work], { home: h }), [work, path.join(work, 'a')]);
  assert.throws(() => checkFolders('work', { home: h }), /list of paths/); assert.throws(() => checkFolders([1], { home: h }), /list of paths/);
  assert.throws(() => checkFolders(['relative/work'], { home: h }), /absolute paths/);
  assert.throws(() => checkFolders([`${work}\n`], { home: h }), /absolute paths/);
  assert.throws(() => checkFolders([path.join(h, 'missing')], { home: h }), /Folder not found/);
  assert.throws(() => checkFolders([path.join(h, 'file.txt')], { home: h }), /Folder not found/);
  assert.throws(() => checkFolders([h], { home: h }), /not your home itself/);
  assert.throws(() => checkFolders([dir], { home: h }), /inside your home/);
  assert.throws(() => checkFolders([path.join(h, '.ssh')], { home: h }), /secrets or ELU state/);
  assert.throws(() => checkFolders([path.join(work, 'keys')], { home: h }), /secrets or ELU state/, 'a symlink to a secret folder');
  assert.throws(() => checkFolders([personalDirectory()], { home: h }), /secrets or ELU state/);
  assert.throws(() => checkFolders([state], { home: h }), /secrets or ELU state/, 'a parent of the state folder');
  // A closed folder is closed by what it is on disk, however its path is written. One whose own name is a link is closed
  // where it leads, by either path, with what is in it and the folder above it; a folder beside it stays open. The same
  // folder in other letter case is closed too, on a disk that does not tell case apart.
  fs.mkdirSync(path.join(h, 'vault', 'aws', 'deep'), { recursive: true }); fs.mkdirSync(path.join(h, 'vault', 'notes')); fs.symlinkSync(path.join(h, 'vault', 'aws'), path.join(h, '.aws'));
  for (const folder of [path.join(h, '.aws'), path.join(h, 'vault', 'aws'), path.join(h, 'vault', 'aws', 'deep'), path.join(h, 'vault')]) assert.throws(() => checkFolders([folder], { home: h }), /secrets or ELU state/, folder);
  assert.deepEqual(checkFolders([path.join(h, 'vault', 'notes')], { home: h }), [path.join(h, 'vault', 'notes')]);
  if (fs.existsSync(path.join(h, '.SSH'))) assert.throws(() => checkFolders([path.join(h, '.SSH')], { home: h }), /secrets or ELU state/, 'other letter case');
  const many = Array.from({ length: 9 }, (_, i) => { const folder = path.join(work, `f${i}`); fs.mkdirSync(folder); return folder; });
  assert.throws(() => checkFolders(many, { home: h }), /at most 8/);
  assert.equal(checkFolders(many.slice(0, 8), { home: h }).length, 8);
});

test('the personal default mode is ask until saved, and never an unknown value', t => {
  home(t);
  assert.equal(DEFAULT_MODE, 'ask'); assert.equal(defaultMode(), 'ask');
  assert.equal(saveDefaultMode('auto'), 'auto'); assert.equal(defaultMode(), 'auto');
  const file = path.join(personalDirectory(), 'permissions.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, default: 'auto' });
  assert.throws(() => saveDefaultMode('locked'), /Choose ask, auto, or full/); assert.equal(defaultMode(), 'auto');
  fs.writeFileSync(file, '{"version":1,"default":"open"}'); assert.equal(defaultMode(), 'ask');
  fs.writeFileSync(file, 'not json'); assert.equal(defaultMode(), 'ask');
});

test("only the owner's lead gets a mode; teammates, reviewers and read-only turns run locked", () => {
  const task = { permissions: 'auto' };
  assert.equal(runProfile({ roleName: 'lead', task }), 'auto');
  assert.equal(runProfile({ roleName: 'reviewer', task }), 'locked'); assert.equal(runProfile({ roleName: 'security', task }), 'locked');
  assert.equal(runProfile({ roleName: 'lead', task, readOnly: true }), 'locked');
  for (const kind of ['ask', 'review']) assert.equal(runProfile({ roleName: 'lead', task, origin: { kind } }), 'locked', kind);
  assert.equal(runProfile({ roleName: 'lead', task, origin: { kind: 'handoff' } }), 'auto');
  assert.equal(runProfile({ roleName: 'lead', task: {} }), 'locked', 'a task from before modes existed');
  assert.equal(runProfile({ roleName: 'lead', task: { permissions: 'locked' } }), 'locked');
  assert.equal(runProfile({ roleName: 'lead', task: { permissions: 'root' } }), 'locked');
  assert.equal(isPeerRun({ kind: 'ask' }), true); assert.equal(isPeerRun({ kind: 'review' }), true);
  assert.equal(isPeerRun({ kind: 'handoff' }), false); assert.equal(isPeerRun(null), false); assert.equal(isPeerRun(undefined), false);
});

// A session another computer started here (origin.mine) is a teammate's, unless the owner marked
// that computer as his own on this one (/computers mine, lib/peer/my-computers.mjs): then it is his.
test('a session the owner\'s own computer started is not a teammate\'s; every other origin still is', async t => {
  home(t); await myComputersLoaded;
  const laptop = 'c'.repeat(64), sara = 'b'.repeat(64), me = createIdentity({ name: 'ana' }), team = createTeam(me, 'core');
  for (const [key, name] of [[laptop, 'laptop'], [sara, 'sara']]) redeemCode(createInvite(me, team.id, { hours: 1 }), key, name);
  const started = machine => ({ kind: 'mine', mine: true, machine, name: 'x', remoteId: '0f0e0d0c-0b0a-4908-8706-050403020100' });
  const others = [{ kind: 'handoff', peer: laptop, name: 'laptop', threadId: 't' }, { kind: 'ask', peer: laptop }, { kind: 'review', peer: laptop }, { ...started(laptop), peer: sara }, { ...started(laptop), mine: 'yes' }, { ...started(laptop), kind: 'handoff' }, { ...started(laptop), machine: 'C'.repeat(64) }, started(sara)];
  const check = (mine) => {
    assert.deepEqual([fromTeammate(started(laptop)), fromMyComputer(started(laptop))], [!mine, mine]);
    for (const origin of others) assert.deepEqual([fromTeammate(origin), fromMyComputer(origin)], [true, false], JSON.stringify(origin));
    for (const origin of [null, undefined]) assert.deepEqual([fromTeammate(origin), fromMyComputer(origin)], [false, false]);
  };
  check(false);
  markMyComputer(laptop, 'laptop'); assert.equal(myComputer(laptop), true); check(true);
  assert.equal(myComputer(me.key), false, 'never this computer itself'); assert.equal(myComputer('not a key'), false); assert.equal(myComputer(undefined), false);
  unmarkMyComputer(laptop); check(false);
});
