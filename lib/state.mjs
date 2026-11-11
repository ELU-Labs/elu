import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomic, mkdir, readJson, noSymlinks, refuse } from './util.mjs';
import { processIdentity } from './process.mjs';
import { checkPlace } from './modes.mjs';

export function event(repo, type, data = {}) {
  mkdir(repo.state);
  const file = path.join(repo.state, 'events.jsonl'); noSymlinks(file);
  fs.appendFileSync(file, `${JSON.stringify({ id: crypto.randomUUID(), at: new Date().toISOString(), type, ...data })}\n`, { mode: 0o600 });
}
export function tasks(repo) {
  const folder = path.join(repo.state, 'tasks'); noSymlinks(folder);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((id) => /^[1-9][0-9]*$/.test(id)).map((id) => readTask(repo, id)).sort((a, b) => Number(a.id) - Number(b.id));
}
export function taskDir(repo, id) {
  if (!/^[1-9][0-9]*$/.test(String(id))) refuse('Task ID must be a positive integer.');
  const dir = path.join(repo.state, 'tasks', String(id)); noSymlinks(dir); return dir;
}
// A session's records stay with its project. Its edit can run in another repository the
// lead found; there, its folder and branch carry a project mark, so two projects editing
// one repository never collide. A repo object for such an edit has `project` set.
const worktreesOf = root => path.join(path.dirname(root), `${path.basename(root)}.elu-code`);
export const projectMark = root => crypto.createHash('sha256').update(root).digest('hex').slice(0, 6);
// place: a new worktree (default), a worktree with a named branch checked
// out, or `here`, the real checkout itself, whose branch is whatever is checked out.
export function taskPlace(repo, id, repository = null, place = null) {
  const project = repo.project ?? repo.root, kind = place?.kind ?? 'worktree';
  if (kind === 'here') return { worktree: repository ?? repo.root, branch: null };
  const own = !repository || repository === project, name = own ? String(id) : `${id}-${projectMark(project)}`;
  const worktree = path.join(own ? project === repo.root ? repo.worktrees : worktreesOf(project) : worktreesOf(repository), name);
  return { worktree, branch: kind === 'branch' ? place.branch : `feat/task-${name}` };
}
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
// What the owner sets for a session: its mode, spending limit, folders and bots. A turn
// holds the session for its whole length and writes its own copy of the record back at
// each step, so a setting changed meanwhile is kept in a small file beside the record.
// Every read lays that file over the record, and the next save takes it into the record
// and into the saver's own copy: the turn's, at the latest when it ends. null takes a
// value away.
const SETTINGS = ['permissions', 'permissionChanges', 'budgetUsd', 'folders', 'bots'];
const recordFile = (repo, id) => path.join(taskDir(repo, id), 'task.json');
export const settingsFile = (repo, id) => path.join(taskDir(repo, id), 'settings.json');
function waitingSettings(repo, id) {
  const file = settingsFile(repo, id); noSymlinks(file);
  if (!fs.existsSync(file)) return null;
  try { const value = readJson(file); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
}
function laySettings(task, waiting) {
  for (const key of SETTINGS) if (waiting && Object.hasOwn(waiting, key)) { if (waiting[key] === null) delete task[key]; else task[key] = waiting[key]; }
  return task;
}
// Changes a session's settings whether or not a turn holds it; no caller waits for a turn.
// change gets the session as it reads now and alters its settings. Returns the session as
// it reads after.
export function changeSettings(repo, taskId, change) {
  const release = waitLock(repo, `settings-${taskId}`);
  try {
    const task = readTask(repo, taskId), was = SETTINGS.map(key => JSON.stringify(task[key]));
    change(task);
    const changed = SETTINGS.filter((key, index) => JSON.stringify(task[key]) !== was[index]);
    if (!changed.length) return task;
    let turn = null;
    try { turn = lock(repo, `task-${taskId}`); } catch (error) { if (!error.message.includes('holds this lock')) throw error; }
    const file = settingsFile(repo, taskId); noSymlinks(file);
    if (!turn) { atomic(file, { ...waitingSettings(repo, taskId), ...Object.fromEntries(changed.map(key => [key, task[key] ?? null])) }); return task; }
    try { atomic(recordFile(repo, taskId), task); fs.rmSync(file, { force: true }); } finally { turn(); }
    return task;
  } finally { release(); }
}
// A record is read with what is kept beside it laid over it: the name, then the settings.
export function readTask(repo, id) { return laySettings(named(repo, record(repo, id)), waitingSettings(repo, id)); }
function record(repo, id) {
  const task = readJson(path.join(taskDir(repo, id), 'task.json'));
  if (task.kind === 'conversation') {
    if (task.id !== String(id) || task.worktree !== (repo.project ?? repo.root) || task.base !== null || task.branch !== null) refuse('Invalid conversation record.');
    return task;
  }
  if (task.repository !== undefined && (typeof task.repository !== 'string' || !path.isAbsolute(task.repository))) refuse('Invalid task record.');
  let place = null;
  if (task.place !== undefined) { try { place = checkPlace(task.place, { mode: 'full' }); } catch { refuse('Invalid task record.'); } }
  const expected = taskPlace(repo, id, task.repository, place);
  const branchOk = place?.kind === 'here' ? task.branch === null || typeof task.branch === 'string' && BRANCH.test(task.branch) : task.branch === expected.branch;
  if (task.id !== String(id) || task.worktree !== expected.worktree || !branchOk || !/^[0-9a-f]{40,64}$/.test(task.base ?? '')) refuse('Invalid task record.');
  return task;
}
export function saveTask(repo, task) {
  const waiting = settingsFile(repo, task.id); noSymlinks(waiting);
  if (!fs.existsSync(waiting)) { atomic(recordFile(repo, task.id), task); return; }
  const release = waitLock(repo, `settings-${task.id}`);
  try { laySettings(task, waitingSettings(repo, task.id)); atomic(recordFile(repo, task.id), task); fs.rmSync(waiting, { force: true }); } finally { release(); }
}
// A session's name in lists and titles: the one the owner gave it, else the title of its
// approved Task, else the short one the model chose in its first reply, else the first
// words of what was asked. The name is kept beside the record, in a file of its own, with
// who chose it. A running turn holds the record and its lock until it ends, and saves the
// record as it goes: a name in its own file is saved at once, and those saves never undo it.
export const TITLE_MAX = 60;
export const MODEL_TITLE_MAX = 40;
export const nameFile = (repo, id) => path.join(taskDir(repo, id), 'name.json');
// What the name file holds, or null when there is none. A file that cannot be read counts as none.
function savedName(repo, id) {
  try { const value = readJson(nameFile(repo, id)); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
}
// A name that was saved: the owner's, read back. Older versions took up to 120 characters.
const kept = value => { const name = typeof value === 'string' ? oneLine(value) : ''; return name && name.length <= 120 && !/[\x00-\x1f\x7f]/.test(name) ? name : null; };
// Puts the saved name on a record that was just read: title, and titleBy for who chose it,
// owner, task or model. Without a name file the record keeps the name older versions saved
// in it, which the owner chose.
function named(repo, task) {
  const name = savedName(repo, task.id);
  if (!name) return task;
  const owner = kept(name.owner), plan = owner ? null : planTitle(name.task), model = owner ?? plan ? null : modelTitle(name.model), title = owner ?? plan ?? model;
  delete task.title; delete task.titleBy;
  if (title) { task.title = title; task.titleBy = owner ? 'owner' : plan ? 'task' : 'model'; }
  return task;
}
// What the name file holds, to change one part of it. A name older versions saved in the
// record is carried over as the owner's; a copy a turn saved there of a name that someone
// else chose is not.
function nameParts(repo, id) {
  const saved = record(repo, id), before = saved.titleBy && saved.titleBy !== 'owner' ? null : kept(saved.title);
  return savedName(repo, id) ?? (before ? { owner: before } : {});
}
const UNSEEN = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
// The first words of a request, in one row: cut at a word boundary, with … for the rest.
function firstWords(value, width) {
  const text = oneLine(value);
  if (text.length <= width) return text;
  // A cut that falls right after a word keeps that word.
  const cut = text.slice(0, width - 1), space = cut.lastIndexOf(' '), whole = /[\s,;:.!?]/.test(text[width - 1]);
  return `${(whole || space <= 0 ? cut : cut.slice(0, space)).replace(/[\s,;:.!?-]+$/, '')}…`;
}
// A name the model gave is untrusted text. It is taken only as 2 to 6 plain words on one
// line, of up to MODEL_TITLE_MAX characters: no control or invisible characters, no markup,
// no address, no file path. A word with a slash is two plain words joined by it, as in
// read/write. Anything else is not a name: null, and the session keeps the one it shows.
export function modelTitle(value) {
  if (typeof value !== 'string' || UNSEEN.test(value.trim())) return null;
  const name = value.trim().replace(/^["'“”‘’]+|["'“”‘’.]+$/g, '').replace(/ +/g, ' ').trim(), words = name ? name.split(' ') : [];
  if (name.length > MODEL_TITLE_MAX || words.length > 6 || !/[\p{L}\p{N}]/u.test(name)) return null;
  // One word is a name only in a script that writes without spaces.
  if (words.length < 2 && /^[\x20-\u024f]*$/.test(name)) return null;
  if (/[<>{}[\]`*|\\~]|^#|:\/\//.test(name)) return null;
  if (words.some(word => word.includes('/') && !/^\p{L}+\/\p{L}+$/u.test(word))) return null;
  return name;
}
// true when the session has a name that someone chose: the owner, an approved Task or the model.
export function hasTitle(repo, taskId) { return Boolean(readTask(repo, taskId).title); }
// Saves the name the model chose, once. It never replaces the owner's name, which stays
// the one that shows, nor an earlier name of its own. false when it is not a name or the
// session has one from the model already.
export function suggestTitle(repo, taskId, value) {
  const name = modelTitle(value);
  if (!name) return false;
  const release = waitLock(repo, `name-${taskId}`);
  try {
    const saved = nameParts(repo, taskId);
    if (modelTitle(saved.model)) return false;
    atomic(nameFile(repo, taskId), { ...saved, model: name }); return true;
  } finally { release(); }
}
// A Task's title as a session name: one line, cut at a word to TITLE_MAX. null when it is
// empty or holds a control or invisible character.
function planTitle(value) { const name = typeof value === 'string' ? firstWords(value, TITLE_MAX) : ''; return name && !UNSEEN.test(name) ? name : null; }
// Names a session after its approved Task, whatever the session is doing. It replaces the
// title of an earlier Task and shows in place of the model's short name, and never in place
// of a name the owner set: that one stays until the owner takes it away. An empty title
// takes the Task's away again. false, and nothing changes, when the title is not plain text.
export function titleFromTask(repo, taskId, title) {
  const name = planTitle(title);
  if (!name && String(title ?? '').trim()) return false;
  const release = waitLock(repo, `name-${taskId}`);
  try {
    const saved = nameParts(repo, taskId); delete saved.task;
    atomic(nameFile(repo, taskId), name ? { ...saved, task: name } : saved); return true;
  } finally { release(); }
}
// Why a typed name is not taken, or null.
export function nameProblem(value) {
  const name = oneLine(value), rule = `A session name is one line of up to ${TITLE_MAX} characters.`;
  return /[\x00-\x1f\x7f]/.test(name) ? rule : name.length > TITLE_MAX ? `${rule} This one is ${name.length}.` : null;
}
export function taskTitle(task) {
  const name = typeof task?.title === 'string' ? task.title.trim() : '';
  return name || firstWords(String(task?.goal ?? '').split('\n').find(line => line.trim()) ?? '', TITLE_MAX);
}
// Renames a session, whatever it is doing. An empty name takes the owner's name away again.
export function setTitle(repo, taskId, title) {
  const name = oneLine(title), problem = nameProblem(name);
  if (problem) refuse(problem);
  record(repo, taskId);
  const release = waitLock(repo, `name-${taskId}`);
  try { atomic(nameFile(repo, taskId), { ...savedName(repo, taskId), owner: name || null }); } finally { release(); }
  return readTask(repo, taskId);
}
// A lock is written whole under another name and then linked to its own, so a process that
// finds it never reads half of one, and the first to link wins.
const NO_LINKS = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'], HALF_AGE_MS = 5000, GONE = Symbol('gone'), HALF = Symbol('half');
function claim(file, text) {
  const draft = `${file}.${process.pid}.tmp`;
  fs.rmSync(draft, { force: true });
  fs.writeFileSync(draft, text, { flag: 'wx', mode: 0o600 });
  try { fs.linkSync(draft, file); }
  catch (error) {
    if (!NO_LINKS.includes(error.code)) throw error;
    // A file system without hard links: written in place, as before.
    fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
  } finally { fs.rmSync(draft, { force: true }); }
}
// Who holds the lock that was found. It may be released between the two looks, and where
// there are no hard links it may be half written: by its holder now, or by one that died,
// whose half is removed once it is old.
function holder(file) {
  try { return readJson(file); }
  catch (error) {
    if (error.code === 'ENOENT') return GONE;
    if (!(error instanceof SyntaxError)) throw error;
    try { if (Date.now() - fs.statSync(file).mtimeMs < HALF_AGE_MS) return HALF; } catch { return GONE; }
    fs.rmSync(file, { force: true }); return GONE;
  }
}
export function lock(repo, name = 'allocate') {
  mkdir(repo.state);
  const file = path.join(repo.state, `${name}.lock`); noSymlinks(file);
  const text = JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) });
  let stale = 0;
  // A lock that was released, or removed as half written, between the two looks is tried for again.
  for (let look = 0; stale < 2 && look < 50; look++) {
    try { claim(file, text); return () => { noSymlinks(file); fs.unlinkSync(file); }; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const previous = holder(file);
    if (previous === GONE) continue;
    if (previous === HALF || !previous?.identity || processIdentity(previous.pid) === previous.identity) refuse('Another ELU Code command holds this lock.');
    fs.rmSync(file, { force: true }); stale++;
  }
  refuse(stale ? 'Could not take the repository lock.' : 'Another ELU Code command holds this lock.');
}
export function waitLock(repo, name, attempts = 60) {
  for (let attempt = 0; ; attempt++) {
    try { return lock(repo, name); }
    catch (error) { if (attempt >= attempts || !error.message.includes('holds this lock')) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
  }
}
