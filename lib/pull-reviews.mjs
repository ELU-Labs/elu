import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EluCodeError, atomic, isObject, noSymlinks, readJson } from './util.mjs';
import { lock, readTask, saveTask, taskDir, waitLock } from './state.mjs';

// The pull requests a session opens or updates, from any folder: its own worktree, a helper
// worktree under /tmp, a helper agent of the lead's. Its reviewing bots review each one at its
// latest head commit (lib/runner.mjs sweepPulls), as they review the session's own change.
//
// Found in what the lead's turn ran (pullsInLog): the output of gh pr create, gh pr edit, gh pr
// ready and gh pr reopen, and the pull request such a command names; in a pull request URL the
// lead's reply gives (pullsIn); and asked for by the lead (elu sessions ask NAME review URL).
// Once found, a pull request is looked at again at the end of each of the lead's turns, and
// while a long turn works: a push to its branch from anywhere is a new head, reviewed again.
//
// Kept beside the session's record, which a turn holds while it works:
// <session>/pulls.json = { version: 1, pulls: { url: { url, owner, repo, number, title, state,
//   head, firstAt, unread, reviews: { bot: { head, at, outcome, summary, comments, notReviewed,
//   mustFix, suggestions, parts, failed } } } }, rows, runs, midTurn }
//   rows: what the chat shows of these reviews (pullEntries), the newest ROWS_KEPT;
//   runs: the bots' runs, until the session's record takes them (foldPulls);
//   midTurn: the head of the session's own folder its bots reviewed while a long turn worked.
export const ROWS_KEPT = 200, PULLS_KEPT = 30;
export const PULL_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,9})(?![0-9])/g;
const SHORT_REF = /(?<![\w./-])([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#([1-9][0-9]{0,9})(?![0-9])/g;
// The gh commands that open or change a pull request, and the one they name by its address.
export const PULL_COMMAND = /\bgh\s+pr\s+(?:create|edit|ready|reopen)\b/;
const NAMED = /\bgh\s+pr\s+(?:edit|ready|reopen)\s+(https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/[1-9][0-9]{0,9})/g;

const pullRow = (owner, repo, number) => ({ url: `https://github.com/${owner}/${repo.replace(/\.git$/, '')}/pull/${Number(number)}`, owner, repo: repo.replace(/\.git$/, ''), number: Number(number) });
// The pull requests a text names by address, and with short also as owner/repo#N.
export function pullsIn(text, { short = false } = {}) {
  const found = new Map(), value = typeof text === 'string' ? text : '';
  for (const match of value.matchAll(PULL_URL)) { const row = pullRow(match[1], match[2], match[3]); found.set(row.url, row); }
  if (short) for (const match of value.matchAll(SHORT_REF)) { const row = pullRow(match[1], match[2], match[3]); found.set(row.url, row); }
  return [...found.values()];
}
// Whether the lead's question to a bot asks it to review pull requests: their addresses, or null.
export function pullsAsked(text) {
  const value = typeof text === 'string' ? text : '';
  if (!/\breview/i.test(value)) return null;
  const found = pullsIn(value);
  return found.length ? found : null;
}

// Whether such an ask says to review again whatever was reviewed (once more, again, re-review).
// Its addresses are no words of it, and "no need to review it again" asks for the opposite.
export function reviewAgain(text) {
  const value = typeof text === 'string' ? text.replace(PULL_URL, 'it') : '';
  return value.split(/[.!?\n]+/).some(said => /\b(?:again|once more|afresh|regardless|re-?review)\b/i.test(said) && /\breview|\bre-?review/i.test(said) && !/\b(?:not|never|no need|don['’]?t)\b[^,;:]{0,30}\b(?:again|once more|re-?review)/i.test(said));
}
// The review a bot's record holds of that head, as the lead is given it again: { at, value }, or
// null. ELU up to 0.1.50 kept no findings: what the chat showed of that review stands for them.
export function reviewKept(pull, bot, head, rows = []) {
  const review = pull?.reviews?.[bot];
  if (!review || review.head !== head || review.failed || review.outcome !== 'done') return null;
  if (Array.isArray(review.comments)) return { at: review.at, value: { outcome: review.outcome, summary: review.summary, comments: review.comments, ...(review.notReviewed?.length ? { notReviewed: review.notReviewed } : {}) } };
  const at = Date.parse(review.at), shown = rows.findLast(row => row.bot === bot && row.pull === pull.number && !row.failed && Math.abs(Date.parse(row.at) - at) < 1000);
  return shown ? { at: review.at, value: { outcome: review.outcome, findings: shown.text, findingsNote: 'An earlier ELU kept these findings only as the chat showed them: a long one is cut short, and suggestions are counted, not listed.' } } : null;
}

// What a vendor's log says a command was, in any of the shapes the vendors write: Codex's
// command_execution item, a Claude Code tool_use's input, an ACP tool call's rawInput.
const commandOf = node => {
  for (const value of [node.command, node.cmd, node.input?.command, node.rawInput?.command, node.arguments?.command]) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(String).join(' ');
  }
  return null;
};
const idOf = node => [node.id, node.call_id, node.callId, node.toolCallId].find(value => typeof value === 'string' && value) ?? null;
const answerTo = node => [node.tool_use_id, node.toolCallId, node.call_id, node.callId].find(value => typeof value === 'string' && value) ?? null;
// What such a command printed, where the same entry carries it.
const outputOf = node => [node.aggregated_output, node.output, node.stdout, node.stderr, node.content, node.rawOutput, node.result].filter(value => value !== undefined && value !== null).map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n');
// A log is read from where the last read stopped (as lib/run-activity.mjs reads one), so a long
// turn's log is read once however often it is looked at.
const reads = new Map(), READS_KEPT = 100, CHUNK = 8 * 1024 * 1024;
export function pullsInLog(file) {
  if (typeof file !== 'string' || !file) return [];
  let stat; try { stat = fs.lstatSync(file); } catch { reads.delete(file); return []; }
  if (!stat.isFile()) return [];
  let entry = reads.get(file);
  if (!entry || entry.ino !== stat.ino || stat.size < entry.offset) entry = { ino: stat.ino, offset: 0, carry: '', calls: new Set(), found: new Map() };
  const add = (text, short) => { for (const row of pullsIn(text, { short })) entry.found.set(row.url, row); };
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 16) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    const command = commandOf(node);
    if (command && PULL_COMMAND.test(command)) {
      const id = idOf(node); if (id) entry.calls.add(id);
      for (const match of command.matchAll(NAMED)) add(match[1], false);
      add(outputOf(node), true);
    } else { const to = answerTo(node); if (to && entry.calls.has(to)) add(outputOf(node), true); }
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value, depth + 1);
  };
  let fd; try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); } catch { return [...entry.found.values()]; }
  try {
    while (entry.offset < stat.size) {
      const bytes = Buffer.alloc(Math.min(CHUNK, stat.size - entry.offset)), got = fs.readSync(fd, bytes, 0, bytes.length, entry.offset);
      if (!got) break;
      entry.offset += got;
      const text = entry.carry + bytes.subarray(0, got).toString('utf8'), end = text.lastIndexOf('\n');
      if (end < 0) { entry.carry = text; continue; }
      entry.carry = text.slice(end + 1);
      for (const line of text.slice(0, end).split('\n')) {
        if (!line.includes('gh') && !entry.calls.size) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        walk(row, 0);
      }
    }
  } finally { fs.closeSync(fd); }
  reads.delete(file); reads.set(file, entry);
  if (reads.size > READS_KEPT) reads.delete(reads.keys().next().value);
  return [...entry.found.values()];
}

// ---------------------------------------------------------------------------------------
// The record.
export const pullsFile = (repo, id) => path.join(taskDir(repo, id), 'pulls.json');
const empty = () => ({ version: 1, pulls: {}, rows: [], runs: [], midTurn: null });
export function readPulls(repo, id) {
  try {
    const file = pullsFile(repo, id); noSymlinks(file);
    if (!fs.existsSync(file)) return empty();
    const value = readJson(file);
    if (!isObject(value) || value.version !== 1) return empty();
    return { version: 1, pulls: isObject(value.pulls) ? value.pulls : {}, rows: Array.isArray(value.rows) ? value.rows : [], runs: Array.isArray(value.runs) ? value.runs : [], midTurn: isObject(value.midTurn) ? value.midTurn : null };
  } catch { return empty(); }
}
export function changePulls(repo, id, change) {
  const release = waitLock(repo, `pulls-${id}`, 300);
  try {
    const value = readPulls(repo, id), out = change(value) ?? value;
    out.rows = out.rows.slice(-ROWS_KEPT);
    const kept = Object.values(out.pulls).sort((a, b) => Date.parse(a.firstAt ?? 0) - Date.parse(b.firstAt ?? 0)).slice(-PULLS_KEPT);
    out.pulls = Object.fromEntries(kept.map(row => [row.url, row]));
    atomic(pullsFile(repo, id), out);
    return out;
  } finally { release(); }
}
// Pull requests found in the session: each kept once, from when it was first found.
export function notePulls(repo, id, found = []) {
  const fresh = found.filter(row => typeof row?.url === 'string');
  if (!fresh.length) return readPulls(repo, id);
  return changePulls(repo, id, value => {
    const at = new Date().toISOString();
    for (const row of fresh) if (!value.pulls[row.url]) value.pulls[row.url] = { url: row.url, owner: row.owner, repo: row.repo, number: row.number, firstAt: at, reviews: {} };
    return value;
  });
}
// The session's record takes the bots' runs, so its spend counts them, and a summary of where
// each pull request's reviews stand (pullReviews), which its Task and the Orchestrator's wake
// read. Only while no turn holds the record; a turn that does leaves them here until it ends.
const WORKING = ['running', 'preparing'];
export function foldPulls(repo, id) {
  let value = readPulls(repo, id);
  if (!value.runs.length && !Object.keys(value.pulls).length) return false;
  let release; try { release = lock(repo, `task-${id}`); } catch { return false; }
  try {
    const task = readTask(repo, id);
    if (WORKING.includes(task.state)) return false;
    return Boolean(changePulls(repo, id, current => {
      value = current;
      if (current.runs.length) task.runs = [...(task.runs ?? []), ...current.runs.map(run => ({ ...run, pullReview: true }))];
      const summary = pullSummary(current);
      if (Object.keys(summary).length) task.pullReviews = summary; else delete task.pullReviews;
      saveTask(repo, task);
      current.runs = [];
      return current;
    }));
  } catch { return false; } finally { release(); }
}
export function pullSummary(value) {
  return Object.fromEntries(Object.values(value.pulls).filter(row => row.head || row.unread).map(row => [row.url, { number: row.number, repo: `${row.owner}/${row.repo}`, head: row.head ?? null, state: row.state ?? null, ...(row.unread ? { unread: row.unread.reason } : {}),
    reviews: Object.fromEntries(Object.entries(row.reviews ?? {}).map(([bot, review]) => [bot, { head: review.head ?? null, ...(review.failed ? { failed: review.failed } : { mustFix: review.mustFix ?? 0 }) }])) }]));
}

// ---------------------------------------------------------------------------------------
// What the chat shows, the lead is told, the Task lists and the Orchestrator's wake reads.
const shortHead = sha => typeof sha === 'string' ? sha.slice(0, 7) : 'its head';
export const pullName = row => `PR #${row.number}`;
// The chat's entries for these reviews, as conversationEntries (lib/projects.mjs) shows them.
export function pullEntries(repo, id) {
  return readPulls(repo, id).rows.filter(row => typeof row?.text === 'string' && typeof row.at === 'string').map(row => row.bot
    ? { role: `@${row.bot}`, bot: row.bot, at: row.at, text: row.text, review: true, ...(row.pull ? { pull: row.pull } : {}), ...(row.failed ? { failed: true } : {}) }
    : { role: 'ELU', at: row.at, text: row.text, line: true, ...(row.pull ? { pull: row.pull } : {}), ...(row.failed ? { failed: true } : {}) });
}
const and = list => list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
// Where each pull request's reviews stand, one sentence each, for the lead.
export function pullStatus(value, names = []) {
  return Object.values(value.pulls).filter(row => row.state !== 'MERGED' && row.state !== 'CLOSED').map(row => {
    const at = row.head ? ` at ${shortHead(row.head)}` : '', said = names.map(name => {
      const review = row.reviews?.[name];
      if (!review || !row.head || review.head !== row.head) return `@${name} has not reviewed its latest head yet`;
      if (review.failed) return `@${name} could not review it: ${review.failed}`;
      return `@${name} reviewed it${review.mustFix ? ` (${review.mustFix} must-fix)` : ''}`;
    });
    return `${pullName(row)} (${row.owner}/${row.repo})${at}: ${row.unread ? `ELU could not read it: ${row.unread.reason}. ` : ''}${and(said)}.`;
  });
}
// What the lead of a session with reviewing bots is told of pull requests (lib/runner.mjs).
export function pullRule(names = [], value = null) {
  const list = and(names.map(name => `@${name}`)), status = value ? pullStatus(value, names) : [];
  return [`ELU has ${list} review every pull request this session opens or updates, from any folder or helper: it finds one in what gh pr create, gh pr edit or gh pr ready prints, and in a pull request URL your reply gives, and reviews it again when its head commit moves. The findings come to you in a later message of ELU's, each marked with the pull request's number; to have a bot review one now, run elu sessions ask NAME "review URL". Before you call a pull request ready, mark it ready for review or merge it, each of ${list} must have reviewed its latest head commit, or ELU must have said it could not review it: say which in your reply.`,
    ...(status.length ? [`Pull requests of this session, as their reviews stand now: ${status.join(' ')}`] : [])].join(' ');
}
// The Task's rows (lib/checklist.mjs): each pull request the session's bots reviewed or could not.
export function pullChecklist(task, row) {
  const pulls = isObject(task?.pullReviews) ? Object.values(task.pullReviews) : [];
  return pulls.filter(pull => isObject(pull) && Number.isSafeInteger(pull.number) && pull.state !== 'MERGED' && pull.state !== 'CLOSED').map(pull => {
    const reviews = Object.entries(isObject(pull.reviews) ? pull.reviews : {}), current = reviews.filter(([, review]) => review?.head === pull.head);
    const failed = current.filter(([, review]) => review.failed), fixes = current.reduce((sum, [, review]) => sum + (review.mustFix ?? 0), 0);
    const said = [
      ...current.filter(([, review]) => !review.failed).map(([bot, review]) => `@${bot}: ${review.mustFix ? `${review.mustFix} must-fix` : 'passed'}`),
      ...failed.map(([bot, review]) => `@${bot} could not review it: ${review.failed}`),
      ...reviews.filter(([, review]) => review?.head !== pull.head).map(([bot]) => `@${bot} has not reviewed its latest head`),
    ];
    const met = !pull.unread && reviews.length > 0 && current.length === reviews.length && !failed.length && !fixes;
    return row(`PR #${pull.number} reviewed`, met, pull.unread ? `ELU could not read it: ${pull.unread}` : `${pull.repo} at ${shortHead(pull.head)}: ${said.join('; ') || 'not reviewed yet'}.`);
  });
}
// What the Orchestrator's wake says of a session whose work a bot could not review: one line each.
export function unreviewedLines(task) {
  const own = Object.entries(isObject(task?.unreviewed) ? task.unreviewed : {}).map(([key, row]) => `@${String(key).replace(/^bot:/, '')} could not review: ${row?.reason ?? 'it failed'}`);
  const pulls = Object.values(isObject(task?.pullReviews) ? task.pullReviews : {}).flatMap(pull => Object.entries(isObject(pull?.reviews) ? pull.reviews : {}).filter(([, review]) => review?.failed && review.head === pull.head).map(([bot, review]) => `@${bot} could not review PR #${pull.number}: ${review.failed}`));
  return [...own, ...pulls];
}

// ---------------------------------------------------------------------------------------
// GitHub, through the owner's own gh, and Git where gh gives no diff.
export const ghClock = { ms: 120000 };
const MOST = 512 * 1024 * 1024;
function run(bin, args, { cwd, ms = ghClock.ms, signal = null } = {}) {
  return new Promise(resolve => {
    // Never a prompt: gh and Git answer, or fail, with no one there to type.
    const env = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' };
    let child; try { child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { resolve({ code: 127, stdout: '', stderr: error.message }); return; }
    const out = [], err = []; let size = 0, done = false;
    const end = result => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener?.('abort', stop); resolve(result); };
    const stop = () => { try { child.kill('SIGKILL'); } catch { /* Gone. */ } end({ code: 130, stdout: '', stderr: 'Stopped.' }); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* Gone. */ } end({ code: 124, stdout: '', stderr: `${bin} took longer than ${Math.round(ms / 1000)} s` }); }, ms);
    signal?.addEventListener?.('abort', stop, { once: true });
    child.stdout.on('data', chunk => { size += chunk.length; if (size > MOST) { try { child.kill('SIGKILL'); } catch { /* Gone. */ } return; } out.push(chunk); });
    child.stderr.on('data', chunk => { if (err.length < 64) err.push(chunk); });
    child.once('error', error => end({ code: 127, stdout: '', stderr: error.code === 'ENOENT' ? `${bin} is not installed or not on your PATH` : error.message }));
    child.once('close', code => end({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}
const firstLine = text => String(text ?? '').split('\n').map(line => line.trim()).find(Boolean)?.slice(0, 300) ?? '';
// Where a pull request stands on GitHub: its head commit, its branches, its title and state.
export async function pullFacts(pull, { cwd, signal = null } = {}) {
  const r = await run('gh', ['pr', 'view', pull.url, '--json', 'number,title,state,url,headRefOid,headRefName,baseRefName,baseRefOid'], { cwd, signal });
  if (r.code !== 0) throw new EluCodeError(`gh pr view failed: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}`);
  let value; try { value = JSON.parse(r.stdout); } catch { throw new EluCodeError('gh pr view printed no pull request.'); }
  if (!isObject(value) || typeof value.headRefOid !== 'string' || !/^[0-9a-f]{40}$/i.test(value.headRefOid)) throw new EluCodeError('gh pr view named no head commit.');
  return { ...pull, title: typeof value.title === 'string' ? value.title.slice(0, 300) : '', state: typeof value.state === 'string' ? value.state : null, head: value.headRefOid, headRef: value.headRefName ?? null, base: value.baseRefName ?? null, baseHead: typeof value.baseRefOid === 'string' ? value.baseRefOid : null };
}
// Its diff, as gh pr diff gives it. GitHub gives none for a pull request too large for it (gh
// says the diff exceeded its maximum): then Git fetches the two branches from the repository's
// own remote into this folder's objects, with no ref and no FETCH_HEAD changed, and diffs them.
export async function pullDiff(facts, { cwd, signal = null } = {}) {
  const r = await run('gh', ['pr', 'diff', facts.url, '--color', 'never'], { cwd, signal });
  if (r.code === 0 && r.stdout.trim()) return r.stdout;
  const local = await gitDiff(facts, { cwd, signal }).catch(() => null);
  if (local) return local;
  throw new EluCodeError(`gh pr diff failed: ${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}`);
}
async function gitDiff(facts, { cwd, signal }) {
  if (!facts.base || !facts.baseHead || !cwd) return null;
  const remotes = await run('git', ['-C', cwd, 'remote', '-v'], { cwd, signal });
  const own = new RegExp(`github\\.com[:/]${facts.owner.replace(/[.]/g, '\\.')}/${facts.repo.replace(/[.]/g, '\\.')}(?:\\.git)?(?:\\s|$)`, 'i');
  const remote = remotes.code === 0 ? remotes.stdout.split('\n').find(line => own.test(line))?.split(/\s+/)[0] : null;
  if (!remote) return null;
  const fetched = await run('git', ['-C', cwd, 'fetch', '--no-tags', '--quiet', '--no-write-fetch-head', remote, `refs/pull/${facts.number}/head`, `refs/heads/${facts.base}`], { cwd, signal });
  if (fetched.code !== 0) return null;
  const d = await run('git', ['-C', cwd, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', `${facts.baseHead}...${facts.head}`], { cwd, signal });
  return d.code === 0 && d.stdout.trim() ? d.stdout : null;
}
