import fs from 'node:fs';
import path from 'node:path';
import { atomic, hash, noSymlinks, readJson, refuse, isObject } from '../util.mjs';
import { canonical } from './canonical.mjs';
import { waitLock } from '../state.mjs';
import { peerFile, peerRepo } from './paths.mjs';
import { isTerminal, validId, validateTask } from './a2a.mjs';

// Tasks this machine serves (incoming asks), one file each, so they survive restarts.
// A record is {task, peer, name, messageId, threadId, kind, project, root, requestId,
// text, waiting, reply, costUsd, localTaskId, createdAt}. The idempotency index maps
// (sender key, messageId) to the taskId that SendMessage returned the first time.
const HEX64 = /^[0-9a-f]{64}$/;
const INDEX_MAX = 20000;
const dir = () => peerFile('tasks');
const file = id => path.join(dir(), `${validId(id, 'Task id')}.json`);
const indexFile = () => peerFile('idempotency.json');
const locked = fn => { const release = waitLock(peerRepo(), 'tasks'); try { return fn(); } finally { release(); } };
export function getRecord(id) {
  let target; try { target = file(id); } catch { return null; }
  noSymlinks(target); if (!fs.existsSync(target)) return null;
  try { const record = readJson(target); return isObject(record) && record.task?.id === id ? record : null; } catch { return null; }
}
export function saveRecord(record) {
  if (!HEX64.test(record?.peer ?? '')) refuse('A served task needs the sender key.');
  record.task = validateTask(record.task);
  atomic(file(record.task.id), record); return record;
}
// Read-modify-write of one record under the store lock; fn returns the new record or null.
export function updateRecord(id, fn) {
  return locked(() => { const record = getRecord(id); if (!record) return null; const next = fn(record); return next ? saveRecord(next) : record; });
}
export function records() {
  noSymlinks(dir()); if (!fs.existsSync(dir())) return [];
  return fs.readdirSync(dir()).filter(name => name.endsWith('.json')).flatMap(name => { const record = getRecord(name.slice(0, -5)); return record ? [record] : []; });
}
export const findByRequest = requestId => records().find(record => record.requestId === requestId) ?? null;
function readIndex() {
  try { noSymlinks(indexFile()); if (!fs.existsSync(indexFile())) return {}; const value = readJson(indexFile()); return isObject(value) ? value : {}; } catch { return {}; }
}
const indexKey = (peer, messageId) => `${peer}:${messageId}`;
export function lookup(peer, messageId) { const row = readIndex()[indexKey(peer, messageId)]; return typeof row?.taskId === 'string' ? row.taskId : null; }
// With replace, an entry whose record is missing (a crash after remember) is repointed.
export function remember(peer, messageId, taskId, { replace = false } = {}) {
  return locked(() => {
    const index = readIndex(), key = indexKey(peer, messageId);
    if (index[key] && !(replace && !getRecord(index[key].taskId))) return index[key].taskId;
    index[key] = { taskId, at: Date.now() };
    const entries = Object.entries(index);
    // The oldest entries go first once the index is full; their tasks are long finished.
    const kept = entries.length > INDEX_MAX ? Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, INDEX_MAX)) : index;
    atomic(indexFile(), kept); return taskId;
  });
}

// threads/<threadId>.jsonl is the audit log of a thread, both directions. Each line is
// {at, dir, peer, kind, text, cost, prev, hash}: prev is the previous line's hash and
// hash is sha256 over the canonical line without it, so an edited line breaks the chain.
const THREAD = /^[A-Za-z0-9_-]{1,128}$/;
export const THREAD_MAX = 4 * 1024 * 1024;
// The last line of a thread file, read from its end so a long thread is never read whole.
function lastLine(target, size) {
  const length = Math.min(size, 2 * 1024 * 1024), buffer = Buffer.alloc(length), fd = fs.openSync(target, 'r');
  try { fs.readSync(fd, buffer, 0, length, size - length); } finally { fs.closeSync(fd); }
  return buffer.toString('utf8').trimEnd().split('\n').at(-1) || 'null';
}
// Lines are appended under the thread lock; a thread past THREAD_MAX records no more.
export function audit(threadId, { dir: direction, peer, kind, text = '', cost = null }) {
  if (!THREAD.test(threadId ?? '')) return null;
  const target = peerFile('threads', `${threadId}.jsonl`);
  const release = waitLock(peerRepo(), `thread-${threadId}`);
  try {
    noSymlinks(target);
    const size = fs.existsSync(target) ? fs.statSync(target).size : 0;
    if (size > THREAD_MAX) return null;
    let prev = null; try { prev = size ? JSON.parse(lastLine(target, size))?.hash ?? null : null; } catch { prev = null; }
    const line = { at: new Date().toISOString(), dir: direction, peer, kind, text: String(text).slice(0, 160000), cost, prev };
    line.hash = hash(canonical(line));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.appendFileSync(target, `${JSON.stringify(line)}\n`, { mode: 0o600 }); return line;
  } finally { release(); }
}
// Finished records and quiet threads older than RETAIN_MS are removed.
export const RETAIN_MS = 30 * 24 * 3600 * 1000;
export function prune(now = Date.now()) {
  for (const record of records()) {
    if (!isTerminal(record.task.status.state) || now - Date.parse(record.createdAt) <= RETAIN_MS) continue;
    fs.rmSync(file(record.task.id), { force: true });
    // The pictures a teammate sent with it (pictures.mjs) go with the record.
    if (HEX64.test(record.peer ?? '')) fs.rmSync(peerFile('pictures', 'kept', record.peer, record.task.id), { recursive: true, force: true });
  }
  const folder = peerFile('threads'); noSymlinks(folder); if (!fs.existsSync(folder)) return;
  for (const name of fs.readdirSync(folder).filter(name => THREAD.test(name.replace(/\.jsonl$/, '')))) {
    const target = path.join(folder, name);
    try { if (now - fs.lstatSync(target).mtimeMs > RETAIN_MS) fs.rmSync(target, { force: true }); } catch { /* Gone already. */ }
  }
}
export function thread(threadId) {
  if (!THREAD.test(threadId ?? '')) return [];
  const target = peerFile('threads', `${threadId}.jsonl`); noSymlinks(target);
  if (!fs.existsSync(target)) return [];
  return fs.readFileSync(target, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
export function verifyThread(lines) {
  let prev = null;
  for (const { hash: digest, ...line } of lines) { if (line.prev !== prev || hash(canonical(line)) !== digest) return false; prev = digest; }
  return true;
}
