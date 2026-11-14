import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execute, refuse, hash, safeText, EluCodeError } from './util.mjs';
import { git, head, assertTaskGitSafe, taskChanges, publishable, assertPublishingHooks, snapshotHooks, hooksSnapshotDigest, notesSpec } from './git.mjs';
import { evidenceCurrent, pinnedConfig } from './checks.mjs';
import { saveTask, event, taskDir } from './state.mjs';
import { killGroup } from './process.mjs';
import { turnClock, pushStoppedLine } from './turn-limits.mjs';
import { botKey, botReviews, getBot, sessionBots } from './bots.mjs';
import { settleHead, workBranch } from './task-head.mjs';

export function redact(value, limit = 4000) {
  return safeText(value, limit).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[redacted]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '[redacted]');
}
const markdown = (value) => redact(value).replace(/[\[\]<>`*_!#|]/g, '\\$&').replace(/\n/g, ' ');
export function prBody(task) {
  const lines = [markdown(task.result?.summary??task.goal??'Changes prepared for owner review.'), '', '<!-- elu-code:evidence -->', 'Checks:', ...(task.evidence?.results ?? []).map((row) => `- ${markdown(row.name)}: ${row.status}`), `- changed lines: ${task.evidence?.changedLines ?? 'unknown'}`, `- review: ${task.reviewStatus ?? 'pending'}`, '', 'Review responses:'];
  if (!task.responses.length) lines.push('- No responses were needed.');
  for (const response of task.responses) lines.push(`- ${markdown(response.id)}: ${response.action} — ${markdown(response.reason)}`);
  lines.push('<!-- /elu-code:evidence -->');
  return `${lines.join('\n')}\n`;
}
export function assertReady(task) {
  if (task.state !== 'ready' || !evidenceCurrent(task)) refuse('Checks are missing, failed, or out of date. Run elu check before publishing.');
  if (!['passed', 'skipped'].includes(task.reviewStatus)) refuse('Review has not finished.');
  if (task.reviewStatus === 'passed' && task.reviews.at(-1)?.digest !== task.evidence.digest) refuse('Review is stale for the current change.');
  const lastRound = task.reviews.filter(row => row.round === task.reviews.at(-1)?.round);
  if (lastRound.some(review => review.result.comments.some(row => row.severity === 'must_fix'))) refuse('Must-fix review comments are still open.');
  // Every bot in the chat reviews before publishing. One that joined after the last review
  // has not; one that is no longer saved has nothing to say. A session from before bots did
  // every review has no list of its own, and its last review was saved under the name
  // reviewer: that review stands for @reviewer.
  const earlier = !Array.isArray(task.bots);
  // A bot that has a schedule works by itself and reviews nothing, so nothing waits for it.
  const waiting = sessionBots(task).find(name => botReviews(getBot(name)) && !lastRound.some(review => review.role === botKey(name) || earlier && review.role === name));
  if (waiting) refuse(`@${waiting} has not reviewed this change. It reviews after the next edit; or take @${waiting} out of the session.`);
  if (!publishable(taskChanges(task)).length) refuse('There are no changes to publish.');
}
function gh(root, args) { return execute('gh', args, { cwd: root, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }).stdout; }
// origin as GitHub names it (owner/name), and its one push address.
function origin(repo) {
  const url = git(repo.root, ['remote', 'get-url', '--push', 'origin']).stdout.trim();
  const urls = git(repo.root, ['remote', 'get-url', '--push', '--all', 'origin']).stdout.trim().split('\n');
  if (urls.length !== 1) refuse('origin has more than one push destination.');
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  if (!match) refuse('The draft PR publisher currently supports an explicit GitHub origin only.');
  return { url, name: match[1] };
}
const pullRequests = (repo, name, branch) => JSON.parse(gh(repo.root, ['pr', 'list', '--repo', name, '--head', branch, '--state', 'all', '--json', 'number,state,headRefName,baseRefName,isDraft,url,headRefOid']));
const clean = task => !git(task.worktree, ['status', '--porcelain', '--', ...notesSpec(task)]).stdout.trim();
// The session's work is already on GitHub with a pull request, as when its agent pushed it
// and opened one itself: nothing is left to push. Says which pull request; null when
// something is still to publish, or when GitHub cannot be asked (publishing says why).
export function alreadyPublished(repo, task) {
  try {
    const now = settleHead(repo, task), branch = workBranch(task);
    if (!now || now === task.base || !branch || !clean(task)) return null;
    const rows = pullRequests(repo, origin(repo).name, branch).filter(pr => pr.headRefOid === now);
    const pr = rows.find(row => row.state === 'OPEN') ?? rows[0];
    if (!pr) return null;
    const state = pr.state === 'OPEN' ? pr.isDraft ? 'draft' : 'open' : String(pr.state).toLowerCase();
    if (state !== 'closed' && (task.pr !== pr.url || task.committed?.pushed !== true)) { task.pr = pr.url; task.committed = { ...task.committed, pushed: true }; saveTask(repo, task); }
    return { needsConfirmation: false, published: true, commit: now, branch, pr: pr.url, state, message: `Already pushed: ${branch} at ${now.slice(0, 7)}. Pull request (${state}): ${pr.url}` };
  } catch { return null; }
}
export function destination(repo, task) {
  assertBranch(task);
  const branch = workBranch(task), { url, name } = origin(repo);
  const data = JSON.parse(gh(repo.root, ['repo', 'view', name, '--json', 'nameWithOwner,defaultBranchRef,url']));
  if (!data.defaultBranchRef?.name) refuse('The remote needs an existing default branch before ELU can propose a pull request.');
  if (branch === data.defaultBranchRef.name || ['main', 'master'].includes(branch)) refuse('Publishing directly to a default branch is forbidden.');
  const all = pullRequests(repo, name, branch).map(({ headRefOid: _head, ...pr }) => pr);
  // Below Full access ELU pushes only to a branch with no pull request, or with one draft it can
  // keep as a draft. In Full access nothing is refused: the pull request that is open for the
  // branch takes the push as it is, such as one the agent opened itself, and earlier ones
  // that are merged or closed do not matter.
  const prs = task.permissions === 'full' ? all.filter(pr => pr.state === 'OPEN') : all;
  if (prs.length > 1 || task.permissions !== 'full' && prs.some((pr) => pr.state !== 'OPEN' || pr.baseRefName !== data.defaultBranchRef.name || !pr.isDraft)) refuse('The branch has a closed, merged, non-draft, or incompatible pull request.');
  return { url, name, ref: `refs/heads/${branch}`, base: data.defaultBranchRef.name, existingPr: prs[0] ?? null };
}
// ELU's own draft: one it may rewrite the text of, and that must still be a draft after the push.
const ownDraft = (pr, base) => Boolean(pr) && pr.isDraft && pr.baseRefName === base;
// Checked before anything is committed, so a `here` task on main never gets a commit it cannot push.
function assertBranch(task) {
  const branch = workBranch(task);
  if (typeof branch !== 'string' || !branch) refuse('Check out a branch before publishing.');
  if (['main', 'master'].includes(branch)) refuse('Publishing directly to a default branch is forbidden.');
}
export async function preparePublish(repo, task) {
  if (task.mode === 'automatic' && task.localChanges?.length) refuse('This workspace includes pre-existing local edits. Keep or commit those edits separately, then start a clean task before publishing. Nothing was pushed.');
  // What the agent committed itself is published as it is. A HEAD that moved since ELU last
  // looked is taken in here; it is no reason to refuse.
  settleHead(repo, task);
  const there = alreadyPublished(repo, task); if (there) return there;
  assertBranch(task); assertReady(task); assertTaskGitSafe(repo,task);
  // The push guards run as the session's mode is now: with no sandbox in Full access, in one
  // otherwise. Guards kept while the mode was another, by an earlier version that stopped them
  // after two minutes, or with another quiet limit, are kept again from the same hooks
  // (snapshotHooks refuses changed ones).
  const full = task.permissions === 'full';
  if ((task.mode === 'automatic' && !task.hooksDirectory) || (task.hooksDirectory && (Boolean(task.hooksFull) !== full || task.hooksQuietSeconds !== turnClock.quietSeconds))) {
    if (task.mode === 'automatic') pinnedConfig(repo, task.base, { task });
    task.hooksDirectory = snapshotHooks(repo, task, { full }); task.hooksFull = full; task.hooksSnapshotDigest = hooksSnapshotDigest(task.hooksDirectory); saveTask(repo, task);
  }
  assertPublishingHooks(repo,task);
  if (!task.commit || !clean(task)) {
    // Only what Git would commit: an ignored file, dependency folders and build output are never published.
    const files = publishable(taskChanges(task));
    git(task.worktree, ['-c',`core.hooksPath=${task.hooksDirectory}`,'add', '--', ...files]);
    git(task.worktree, ['-c',`core.hooksPath=${task.hooksDirectory}`, 'commit', '-m', 'Update task implementation']);
    task.commit = head(task.worktree); saveTask(repo, task);
  }
  if (head(task.worktree) !== task.commit || !clean(task)) refuse('The task changed after its commit.');
  const dest = destination(repo, task);
  const body = prBody(task);
  const title = redact(task.goal).split('\n')[0].slice(0, 120);
  const confirmationId = hash(JSON.stringify({ commit: task.commit, destination: dest, title, body, digest: task.evidence.digest }));
  task.pendingPush = { confirmationId, destination: dest, title, body }; saveTask(repo, task);
  // fullAccess: the owner sees that this task ran without the cap and protected-path checks.
  return { needsConfirmation: true, confirmationId, commit: task.commit, destination: dest, title, body, fullAccess: task.permissions === 'full', nextCommand:`elu run ${task.id} --publish --approve-push ${confirmationId}`, message: 'Publishing uses a vetted absolute hooks snapshot, preserving pre-push guards. Approval is required for every push.' };
}
// A pre-push guard that failed, with a non-zero exit, in its own words: the last lines it
// printed, short and with no colours, and that nothing was pushed. record: what the guard
// dispatcher left (snapshotHooks in lib/git.mjs), { status, tail }.
export function guardFailedLine(record) {
  const lines = String(record?.tail ?? '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').split(/\r?\n|\r/).map(line => line.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(-3);
  const said = redact(lines.map(line => line.length > 160 ? `${line.slice(0, 159)}…` : line).join(' · '), 600);
  return `The pre-push guard failed, so nothing was pushed. ${said ? `It said: ${said}` : 'It printed nothing.'}`;
}
// The push has no time limit, as a turn has none: it is stopped only when it has printed
// nothing for the quiet limit (Git's progress counts). While the pre-push guards run, the file
// ELU_GUARD_MARK names exists and its clock waits, as each guard has its own and says when
// that stopped it (snapshotHooks in lib/git.mjs). A guard that fails says so in its own words
// (guardFailedLine). The app keeps drawing all the while.
function push(repo, task, args) {
  const mark = path.join(taskDir(repo, task.id), 'guard-running'), failed = `${mark}.failed`, quiet = turnClock.quietSeconds * 1000;
  fs.rmSync(mark, { force: true }); fs.rmSync(failed, { force: true });
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-pager', '-C', task.worktree, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ELU_GUARD_MARK: mark }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '', last = Date.now(), stopped = false;
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; last = Date.now(); });
    const timer = setInterval(() => {
      if (fs.existsSync(mark)) last = Date.now();
      else if (Date.now() - last >= quiet) { stopped = true; killGroup(child.pid, 'SIGKILL'); }
    }, Math.min(1000, quiet));
    child.on('exit', () => killGroup(child.pid, 'SIGKILL'));
    child.on('error', error => { clearInterval(timer); fs.rmSync(failed, { force: true }); reject(new EluCodeError('git could not finish.', { reason: error.message })); });
    child.on('close', code => {
      clearInterval(timer); fs.rmSync(mark, { force: true });
      let record = null; try { record = JSON.parse(fs.readFileSync(failed, 'utf8')); } catch { /* No guard failed. */ }
      fs.rmSync(failed, { force: true });
      if (code === 0 && !stopped) return resolve();
      const guard = /^Stopped the pre-push guard after .*$/m.exec(output)?.[0];
      reject(new EluCodeError(guard ?? (record ? guardFailedLine(record) : stopped ? pushStoppedLine(turnClock) : 'git could not finish.'), { exitCode: code, reason: output.trim().slice(-1000) }));
    });
  });
}
export async function publish(repo, task, confirmationId) {
  const previous = task.pendingPush;
  if (!previous || previous.confirmationId !== confirmationId) refuse('There is no matching push approval. Preview publication first.');
  assertReady(task); assertTaskGitSafe(repo,task);
  assertPublishingHooks(repo,task);
  if (head(task.worktree) !== task.commit || !clean(task)) refuse('The task changed after approval.');
  const currentDestination = destination(repo, task);
  const title = redact(task.goal).split('\n')[0].slice(0, 120);
  const digest = hash(JSON.stringify({ commit: task.commit, destination: currentDestination, title, body: prBody(task), digest: task.evidence.digest }));
  if (digest !== confirmationId) refuse('The destination, PR, or evidence changed. Preview publication again.');
  task.pendingPush = null; saveTask(repo, task);
  await push(repo, task, ['-c',`core.hooksPath=${task.hooksDirectory}`, 'push', '--progress', '--no-follow-tags', 'origin', `${task.commit}:${currentDestination.ref}`]);
  task.pushedCommit = task.commit; saveTask(repo, task); event(repo, 'pushed', { taskId: task.id, commit: task.commit });
  const bodyFile = path.join(repo.state, 'tasks', task.id, 'pr-body.md');
  const { atomic } = await import('./util.mjs'); atomic(bodyFile, prBody(task));
  // A pull request that is not ELU's own draft (Full access only) keeps its text and its state.
  const existing = currentDestination.existingPr, branch = workBranch(task), draft = !existing || ownDraft(existing, currentDestination.base);
  if (existing) { if (draft) gh(repo.root, ['pr', 'edit', String(existing.number), '--repo', currentDestination.name, '--body-file', bodyFile]); }
  else gh(repo.root, ['pr', 'create', '--repo', currentDestination.name, '--draft', '--base', currentDestination.base, '--head', branch, '--title', title, '--body-file', bodyFile]);
  const pr = JSON.parse(gh(repo.root, ['pr', 'view', existing && !draft ? String(existing.number) : branch, '--repo', currentDestination.name, '--json', 'url,isDraft,headRefOid']));
  if (draft && !pr.isDraft || pr.headRefOid !== task.commit) refuse('The resulting PR does not match the approved draft head.');
  task.pr = pr.url; saveTask(repo, task);
  return { commit: task.commit, pushed: true, pr: task.pr, merged: false, deployed: false };
}
