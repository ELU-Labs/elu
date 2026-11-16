import { changeBase, changed, notesSpec, publishable, taskChanges, targetBranch } from './git.mjs';
import { headNow, published, pushStopNote, workBranch } from './task-head.mjs';
import { stopLine } from './stop-line.mjs';
import { waitText } from './waiting.mjs';

// The checklist of a session's work, beside its Task's objectives: what ELU's own records say
// of it, never what the agent said. Each row is { text, met, evidence }: met is true when the
// row is done (shown ✓), and evidence is one line that says how ELU knows, or what is left,
// whole however long (the screen wraps it). Shown in the session's Task (its header's Task) and
// in the owner's check.
// What a session's state means is said here, in rows: whether its edits are committed, the
// project's checks, the review, the push and the pull request, and anything that waits (an
// answer, an approval, a stop). The stored state itself is never shown.

const one = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const firstLine = value => String(value ?? '').split('\n').find(line => line.trim())?.trim() ?? '';
const short = commit => String(commit ?? '').slice(0, 7);
const row = (text, met, evidence = '') => ({ text, met: met === true, evidence: one(evidence) || null });
// Some names and how many more: "a.js, b.js and 3 more".
function named(list, most = 3) {
  const shown = list.slice(0, most).join(', '), more = list.length - most;
  return more > 0 ? `${shown} and ${more} more` : shown;
}
const and = list => list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
// A check that does not stop the work (lib/checks.mjs checkPassed).
const passed = check => check?.status === 'passed' || check?.status === 'noted';
// The project's own checks among the results: each ran a command with a log, or was skipped
// for a structural failure. ELU's structural checks run in every project.
const ownCheck = check => typeof check?.logFile === 'string' || check?.status === 'skipped';
const editing = task => task.kind !== 'conversation' && typeof task.base === 'string' && typeof task.worktree === 'string';
const working = task => ['running', 'preparing'].includes(task.state);
// What ELU reads from the session's folder: what changed (all), measured as the checks measured
// it (their from), else as its pull request would hold it (lib/git.mjs changeBase); what of it
// is not committed (open); whether its HEAD moved from the base (moved); whether it is measured
// from the branch its pull request goes to (target); and the digest the checks compare, of the
// folder from its base (lib/checks.mjs changeDigest). null where the folder cannot be read.
function folder(task) {
  try {
    const checked = task.evidence && typeof task.evidence === 'object' ? typeof task.evidence.from === 'string' ? task.evidence.from : task.base : undefined;
    const from = checked ?? changeBase(task), change = taskChanges(task, from), now = headNow(task) ?? task.base, moved = now !== task.base;
    const open = moved ? publishable(changed(task.worktree, now, { ignored: task.place?.kind !== 'here', exclude: notesSpec(task) })) : publishable(change);
    const digest = checked === undefined ? null : from === task.base ? change.digest : taskChanges(task, task.base).digest;
    return { all: publishable(change), open, moved, target: checked !== undefined && checked !== task.base, digest };
  } catch { return null; }
}
// The branch its pull request goes to, by name, where it can be read.
const targetName = task => { try { return targetBranch(task); } catch { return null; } };
// The rows that wait on something: a turn that works, a question, an approval, a stop.
// approvals: what the session's turn waits for the owner to allow.
function waitRows(task, approvals) {
  const rows = [];
  if (working(task)) {
    const role = String(task.activeRole ?? 'lead');
    rows.push(row('Working now', false, task.activeRole === 'checks' ? 'The checks are running.' : role.startsWith('bot:') ? `@${role.slice(4)} is working on it.` : role !== 'lead' ? `${role} is reviewing it.` : 'The model is working on it.'));
  }
  if (approvals.length) rows.push(row('Needs your approval', false, `It wants to ${firstLine(approvals[0]?.summary) || 'use a tool'}.`));
  if (task.state === 'needs_input') {
    const reply = task.reply?.outcome === 'needs_input' ? task.reply : task.result;
    rows.push(row('Needs your answer', false, firstLine(reply?.question) || firstLine(task.error?.message) || 'It asks you something in its chat.'));
  }
  const stop = task.state === 'needs_input' ? null : stopLine(task);
  if (stop) rows.push(row(task.state === 'blocked' ? 'Blocked' : task.state === 'stopped' ? 'Stopped' : 'Could not go on', false, stop.text));
  else if (['blocked', 'stopped'].includes(task.state)) rows.push(row(task.state === 'blocked' ? 'Blocked' : 'Stopped', false, firstLine(task.error?.message) || 'Type continue to carry on.'));
  return rows;
}
// The checks row: passed, failed, not set for this project, or not run since the last edit.
// Check names are the project's own ("test", "npm test"), so the line starts with a word of ELU's.
function checksRow(task, seen) {
  const evidence = task.evidence && typeof task.evidence === 'object' ? task.evidence : null, results = Array.isArray(evidence?.results) ? evidence.results : null;
  if (!results) return row('Checks passed', false, working(task) ? 'They run when the model is done.' : 'Not run since the last edit. /publish runs them first.');
  let current = evidence.base === task.base;
  if (current && seen) current = seen.digest === evidence.digest;
  if (!current) return row('Checks passed', false, 'Not run since the last edit. /publish runs them first.');
  const failed = results.filter(check => !passed(check) && !['skipped', 'not-configured'].includes(check?.status)).map(check => one(check.name));
  if (failed.length) return row('Checks passed', false, `Failed: ${named(failed)}.`);
  const own = results.filter(ownCheck).map(check => one(check.name));
  if (!own.length) return row('Checks passed', false, 'Not set for this project: no test or build command checks the edits.');
  return row('Checks passed', true, `Passed: ${and(own.slice(0, 3))}${own.length > 3 ? ` and ${own.length - 3} more` : ''}.`);
}
// The review row, for a session its bots review: passed, or the fixes it still asks for.
// A change no bot reviewed (skipped: its bots could not take it, each too large for its
// model, and the chat said so; or it has none now) has no row, as in a session no bot
// reviews, whatever reviews came before it: publishing waits for none (lib/publish.mjs).
function reviewRow(task) {
  const reviews = Array.isArray(task.reviews) ? task.reviews : [];
  if (task.reviewStatus === 'skipped') return null;
  if (!['passed', 'blocked'].includes(task.reviewStatus) && !reviews.length) return null;
  const round = Math.max(0, ...reviews.map(review => Number(review?.round) || 0)), last = reviews.filter(review => (Number(review?.round) || 0) === round);
  const who = [...new Set(last.map(review => String(review?.role ?? '')).filter(role => role.startsWith('bot:')).map(role => `@${role.slice(4)}`))];
  if (task.reviewStatus === 'passed') return row('Review passed', true, who.length ? `${and(who)} asked for no fixes.` : 'No fixes asked for.');
  if (task.reviewStatus === 'blocked') {
    const fixes = last.flatMap(review => review?.result?.comments ?? []).filter(comment => comment?.severity === 'must_fix').length;
    return row('Review passed', false, fixes ? `It still asks for ${fixes} ${fixes === 1 ? 'fix' : 'fixes'}.` : 'It still asks for fixes.');
  }
  return row('Review passed', false, working(task) ? 'The review is not finished yet.' : 'Not reviewed since the last edit.');
}
// The rows of a session's work. approvals: the approvals its turn waits on (the app's own list).
export function sessionChecklist(task, { approvals = [] } = {}) {
  if (!task || typeof task !== 'object') return [];
  const rows = waitRows(task, Array.isArray(approvals) ? approvals : []);
  // A chat has no edits: it replied, or what it waits on says why not. The reply's own words are
  // the agent's, so the line says only where it is.
  if (!editing(task)) {
    if (task.state === 'answered') rows.push(row('Replied', true, 'Its reply is in the chat.'));
    return rows;
  }
  const seen = folder(task), work = task.committed && typeof task.committed === 'object' ? task.committed : null, committed = Boolean(work) || seen?.moved === true;
  // No edits at all: nothing to commit, check, push or publish. Said from its folder, whatever
  // its reply claims it changed.
  if (seen && !seen.all.length && !committed) {
    if (task.state === 'answered' || !rows.length) rows.push(row('No edits', true, 'It changed no files.'));
    return rows;
  }
  // Its work is all in the branch its pull request goes to, as its checks measured it: its pull
  // request would hold nothing, so nothing is left to check, push or publish (lib/runner.mjs).
  if (seen && !seen.all.length && seen.target) {
    if (task.state === 'answered' || !rows.length) rows.push(row('Nothing to publish', true, `Its work is in ${targetName(task) ?? 'the branch its pull request goes to'} already.`));
    return rows;
  }
  // Committed: what the folder holds now, else ELU's last look at it (lib/task-head.mjs).
  const left = seen ? seen.open : work?.clean === false ? null : [];
  const where = [workBranch(task) ? `on ${workBranch(task)}` : '', typeof task.commit === 'string' && work ? `at ${short(task.commit)}` : ''].filter(Boolean).join(' ');
  if (left === null) rows.push(row('Edits committed', false, 'Some edits are not committed: /changes shows them.'));
  else if (left.length) rows.push(row('Edits committed', false, `Not committed: ${named(left)}. ${committed ? '/changes shows them.' : '/publish commits them.'}`));
  else rows.push(row('Edits committed', committed, committed ? where ? `Committed ${where}.` : 'Committed.' : '/publish commits them.'));
  rows.push(checksRow(task, seen));
  const review = reviewRow(task); if (review) rows.push(review);
  const pushed = work?.pushed === true || published(task), stop = pushStopNote(task);
  rows.push(row('Pushed', pushed, pushed ? `${workBranch(task) ? `${workBranch(task)} is` : 'It is'} on the remote.` : stop ?? (committed && !left?.length ? '/publish pushes it.' : '/publish commits and pushes it.')));
  const pr = typeof task.pr === 'string' && task.pr ? task.pr : null;
  rows.push(row('Pull request', Boolean(pr), pr ?? '/publish opens a draft pull request.'));
  return rows;
}
// The checklist of a session on another computer of mine whose ELU does not send one (before
// 0.1.26), or of a run there that has not started: what its list and its chat told, the rest
// left out. view: what it told. there: that computer, as its chat names it ("@box-one").
export function toldChecklist(view, { there = null, now = Date.now() } = {}) {
  const v = view && typeof view === 'object' ? view : {}, rows = [];
  // A run kept here until that computer is online, or one that waits there to start, says what
  // for in the words its chat says it (lib/waiting.mjs).
  if (v.unsent === true) rows.push(row('Not sent yet', false, 'It is kept here until that computer is online.'));
  else if (v.queued === true) rows.push(row('Waiting to start', false, waitText(v.waits, now, { there }) || 'It starts there when it can.'));
  else if (['running', 'preparing', 'starting'].includes(v.state)) rows.push(row('Working now', false, v.state === 'starting' ? 'It is starting.' : 'The model is working on it.'));
  if (Array.isArray(v.approvals) && v.approvals.length) rows.push(row('Needs your approval', false, `It wants to ${firstLine(v.approvals[0]?.summary) || 'use a tool'}.`));
  if (v.state === 'needs_input') rows.push(row('Needs your answer', false, firstLine(v.question) || 'It asks you something in its chat.'));
  if (['blocked', 'stopped', 'gone'].includes(v.state)) rows.push(row(v.state === 'blocked' ? 'Blocked' : v.state === 'gone' ? 'Gone' : 'Stopped', false, firstLine(v.error) || ''));
  if (v.state === 'answered') rows.push(row('Replied', true, 'Its reply is in the chat.'));
  if (v.finished === true) rows.push(row('Edits committed', true, 'Its work is committed.'));
  else if (v.state === 'ready') rows.push(row('Checks passed', true, 'The checks and the review passed. It is ready to publish.'));
  else if (v.state === 'unverified') rows.push(row('Checks passed', false, firstLine(v.error) || 'Its edits are not verified yet.'));
  return rows;
}
// A checklist another computer sent, as this one keeps it: every row, each a line, whole.
export function cleanChecklist(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => item && typeof item === 'object' && one(item.text)).map(item => row(one(item.text), item.met === true, typeof item.evidence === 'string' ? item.evidence : ''));
}
