import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, noSymlinks, personalDirectory, readJson, refuse } from './util.mjs';
import { APPROVAL_WAIT_SECONDS } from './modes.mjs';

// The approval file protocol. A vendor relay (the Claude MCP server, an ACP client) writes
// a request under <personalDirectory()>/approvals and waits; the terminal answers it. Both
// files are written once, so the first writer wins and nothing is overwritten.
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const INPUT_LIMIT = 4096, POLL_MS = 300;
// A summary of this length was cut: what it asks cannot be read whole.
export const SUMMARY_LIMIT = 200;
// What ELU never answers for the owner, in any mode: a removal with rm or rmdir, an MCP
// tool, and an action too long to read whole. A vendor asks about some of these in Full
// access too, and that question is the owner's.
const REMOVAL = /(?:^|[\s;&|(`'"/=])(?:rm|rmdir)(?=$|[\s;&|)`'"])/;
export const ownersToAnswer = row => /^mcp__/.test(row.tool ?? '') || (row.summary ?? '').length >= SUMMARY_LIMIT || REMOVAL.test(row.summary ?? '');
const control = new RegExp(`[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f${String.fromCodePoint(0x200b)}-${String.fromCodePoint(0x200f)}${String.fromCodePoint(0x2028)}-${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x2060)}-${String.fromCodePoint(0x206f)}${String.fromCodePoint(0xfeff)}]`, 'g');
const clean = value => String(value ?? '').replace(control, '');
const checkId = id => { if (typeof id !== 'string' || !ID.test(id)) refuse('Invalid approval ID.'); return id; };

// The folder is made by whoever writes a request into it, for the owner alone. A look at
// what waits, an answer and a removal never make it: the app looks at every draw and the
// conductor at every tick, and a look that finds nothing must leave nothing behind, after a
// stop or after the folder above it is gone.
const folder = () => path.join(personalDirectory(), 'approvals');
const ownersAlone = dir => { if ((fs.statSync(dir).mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700); };
export function approvalsDir() {
  const dir = folder(); mkdir(dir); ownersAlone(dir);
  return dir;
}
const requestFile = id => path.join(folder(), `${id}.json`);
const answerFile = id => path.join(folder(), `${id}.answer.json`);
// A file is written whole under another name and then linked to its own, so a reader in
// another process never finds half of one, and the first writer still wins. The list
// skips the other name (it does not end in .json) and removes one a dead writer left.
const DRAFT = /^\.[A-Za-z0-9_.-]{1,180}\.[0-9a-f]{12}\.tmp$/, DRAFT_AGE_MS = 60000, NO_LINKS = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'];
function writeOnce(file, value) {
  noSymlinks(file);
  const text = `${JSON.stringify(value, null, 2)}\n`, draft = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(draft, text, { flag: 'wx', mode: 0o600 });
  try { fs.linkSync(draft, file); return true; }
  catch (error) {
    if (error.code === 'EEXIST') return false;
    if (!NO_LINKS.includes(error.code)) throw error;
    // A file system without hard links: written in place, as before.
    try { fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 }); return true; } catch (again) { if (again.code === 'EEXIST') return false; throw again; }
  } finally { remove(draft); }
}
// Model output is clipped before it reaches disk or a screen: 4 KB of input, 200 characters of summary.
function clip(input) {
  if (input === undefined) return null;
  const text = typeof input === 'string' ? input : JSON.stringify(input) ?? 'null';
  return text.length <= INPUT_LIMIT ? input : { clipped: true, text: text.slice(0, INPUT_LIMIT) };
}
const relativeToHome = (value, home) => { const root = home ?? os.homedir(); const text = String(value); return text === root ? '~' : text.startsWith(`${root}/`) ? `~/${text.slice(root.length + 1)}` : text; };
export function approvalSummary(tool, input, { home, title } = {}) {
  const field = name => typeof input?.[name] === 'string' ? input[name] : '';
  let text;
  if (title) text = String(title);
  else if (tool === 'Bash') text = `Run: ${field('command')}${input?.dangerouslyDisableSandbox === true ? ' outside the sandbox' : ''}`;
  else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) text = `Edit: ${relativeToHome(field('file_path') || field('notebook_path'), home)}`;
  else if (tool === 'WebFetch') text = `Open: ${field('url')}`;
  // Claude Code's question when a sandboxed command connects to a host (lib/permission-rules.mjs).
  else if (tool === 'SandboxNetworkAccess') text = `Network access to ${field('host')}`;
  else if (tool === 'WebSearch') text = `Search: ${field('query')}`;
  else text = `Use ${clean(tool) || 'a tool'}`;
  return clean(text).replace(/\s+/g, ' ').trim().slice(0, SUMMARY_LIMIT);
}
// cwd, access and rules say what the terminal may offer to keep as a rule (lib/permission-rules.mjs):
// the turn's workspace, whether it edits, and whether the session uses the owner's saved rules.
// sandboxed: the turn's commands really run in the vendor's sandbox.
const ACCESS = ['edit', 'read'], RULES = ['saved', 'defaults'];
export function requestApproval({ id, root, taskId, role, vendor, tool, input, title = null, waitSeconds = APPROVAL_WAIT_SECONDS, pid = process.pid, cwd = null, access = null, rules = null, sandboxed = false }) {
  checkId(id);
  if (typeof tool !== 'string' || !tool.trim() || tool.length > 120) refuse('An approval names its tool.');
  if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) refuse('An approval needs a positive wait.');
  const at = Date.now(), summary = approvalSummary(tool, input, { title });
  const record = { version: 1, id, root: root ?? null, taskId: taskId == null ? null : String(taskId), role: role ?? null, vendor: vendor ?? null, tool: clean(tool).slice(0, 120), input: clip(input), title: title == null ? null : clean(title).slice(0, SUMMARY_LIMIT), summary, pid, at: new Date(at).toISOString(), expiresAt: new Date(at + waitSeconds * 1000).toISOString(), ...(typeof cwd === 'string' && path.isAbsolute(cwd) ? { cwd: clean(cwd) } : {}), ...(ACCESS.includes(access) ? { access } : {}), ...(RULES.includes(rules) ? { rules } : {}), ...(sandboxed === true ? { sandboxed: true } : {}) };
  approvalsDir();
  if (!writeOnce(requestFile(id), record)) refuse('This approval was already requested.');
  return { id, summary };
}
// true when the answer was recorded; false when it was already answered or the request is gone.
export function answerApproval(id, decision) {
  checkId(id);
  if (!['allow', 'deny'].includes(decision)) refuse('Answer allow or deny.');
  const request = requestFile(id); noSymlinks(request);
  if (!fs.existsSync(request)) return false;
  return writeOnce(answerFile(id), { id, decision, at: new Date().toISOString() });
}
function readAnswer(id) {
  const file = answerFile(id); noSymlinks(file);
  if (!fs.existsSync(file)) return null;
  try { const value = readJson(file); return ['allow', 'deny'].includes(value?.decision) ? value.decision : 'deny'; } catch { return 'deny'; }
}
const remove = file => { try { fs.rmSync(file, { force: true }); } catch { /* Pruned already. */ } };
// Polls for the owner's answer, then removes both files, the request first: with the answer
// gone and the request still there, a list made in between would show it as waiting again.
// An abort stops the wait.
export async function awaitDecision(id, { waitSeconds = APPROVAL_WAIT_SECONDS, signal } = {}) {
  checkId(id);
  const until = Date.now() + waitSeconds * 1000;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const decision = readAnswer(id);
      if (decision) return decision;
      if (Date.now() >= until) return 'timeout';
      await new Promise(resolve => { const timer = setTimeout(resolve, Math.min(POLL_MS, Math.max(1, until - Date.now()))); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    }
  } finally { remove(requestFile(id)); remove(answerFile(id)); }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// Requests still waiting for the owner, oldest first. Entries whose relay died or whose
// wait has passed are removed, so a crashed run leaves nothing to answer.
export function pendingApprovals({ root, taskId } = {}) {
  const dir = folder(), now = Date.now(), rows = [];
  // No folder: nothing waits, and the look makes none.
  let names; try { ownersAlone(dir); names = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return rows; throw error; }
  for (const name of names.filter(name => DRAFT.test(name))) {
    try { if (now - fs.lstatSync(path.join(dir, name)).mtimeMs > DRAFT_AGE_MS) remove(path.join(dir, name)); } catch { /* Linked and removed by its writer. */ }
  }
  for (const name of names.filter(name => name.endsWith('.json') && !name.endsWith('.answer.json'))) {
    const id = name.slice(0, -5); if (!ID.test(id)) continue;
    let record; try { record = readJson(path.join(dir, name)); } catch { remove(path.join(dir, name)); continue; }
    if (!Number.isInteger(record?.pid) || !alive(record.pid) || !(Date.parse(record.expiresAt) > now)) { remove(path.join(dir, name)); remove(answerFile(id)); continue; }
    // Decided in the meantime: its request was removed after it was read above.
    if (fs.existsSync(answerFile(id)) || !fs.existsSync(path.join(dir, name))) continue;
    if (root !== undefined && record.root !== root) continue;
    if (taskId !== undefined && record.taskId !== String(taskId)) continue;
    rows.push({ id, root: record.root, taskId: record.taskId, role: record.role, vendor: record.vendor, tool: record.tool, summary: clean(record.summary).slice(0, SUMMARY_LIMIT), at: record.at, expiresAt: record.expiresAt, input: record.input ?? null, ...(typeof record.cwd === 'string' && path.isAbsolute(record.cwd) ? { cwd: record.cwd } : {}), ...(ACCESS.includes(record.access) ? { access: record.access } : {}), ...(RULES.includes(record.rules) ? { rules: record.rules } : {}), ...(record.sandboxed === true ? { sandboxed: true } : {}) });
  }
  return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
// A run's approval log: one JSON row per line, { id, tool, summary, decision, at }, and for one
// a rule or a default answered, by ('rule' or 'default') and rule (what it was), and for a
// network question the host. Bad lines are skipped.
export function readApprovalLog(file) {
  noSymlinks(file); if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n').slice(0, 1000)) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (row && typeof row === 'object' && !Array.isArray(row)) rows.push({ id: clean(row.id).slice(0, 160), tool: clean(row.tool).slice(0, 120), summary: clean(row.summary).slice(0, SUMMARY_LIMIT), decision: ['allow', 'deny', 'timeout'].includes(row.decision) ? row.decision : 'deny', at: typeof row.at === 'string' ? row.at : null, ...(['rule', 'default'].includes(row.by) && row.decision === 'allow' ? { by: row.by, rule: clean(row.rule).slice(0, SUMMARY_LIMIT) } : {}), ...(row.tool === 'SandboxNetworkAccess' && typeof row.host === 'string' && /^[a-z0-9.-]{1,253}$/.test(row.host) ? { host: row.host } : {}), ...(row.decision === 'timeout' && Number.isInteger(row.wait) && row.wait > 0 ? { wait: row.wait } : {}) }); } catch { /* Skipped. */ }
  }
  return rows;
}
