import path from 'node:path';
import { execute, refuse, hash, safeText } from './util.mjs';
import { git, head, assertTaskGitSafe, taskChanges, publishable, assertPublishingHooks, snapshotHooks, hooksSnapshotDigest } from './git.mjs';
import { findSandboxHelper } from './sandbox.mjs';
import { evidenceCurrent, pinnedConfig } from './checks.mjs';
import { saveTask, event } from './state.mjs';
import { botKey, botReviews, getBot, sessionBots } from './bots.mjs';

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
export function destination(repo, task) {
  assertBranch(task);
  const url = git(repo.root, ['remote', 'get-url', '--push', 'origin']).stdout.trim();
  const urls = git(repo.root, ['remote', 'get-url', '--push', '--all', 'origin']).stdout.trim().split('\n');
  if (urls.length !== 1) refuse('origin has more than one push destination.');
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  if (!match) refuse('The draft PR publisher currently supports an explicit GitHub origin only.');
  const name = match[1];
  const data = JSON.parse(gh(repo.root, ['repo', 'view', name, '--json', 'nameWithOwner,defaultBranchRef,url']));
  if (!data.defaultBranchRef?.name) refuse('The remote needs an existing default branch before ELU Code can propose a pull request.');
  if (task.branch === data.defaultBranchRef.name || ['main', 'master'].includes(task.branch)) refuse('Publishing directly to a default branch is forbidden.');
  const prs = JSON.parse(gh(repo.root, ['pr', 'list', '--repo', name, '--head', task.branch, '--state', 'all', '--json', 'number,state,headRefName,baseRefName,isDraft,url']));
  if (prs.length > 1 || prs.some((pr) => pr.state !== 'OPEN' || pr.baseRefName !== data.defaultBranchRef.name || !pr.isDraft)) refuse('The branch has a closed, merged, non-draft, or incompatible pull request.');
  return { url, name, ref: `refs/heads/${task.branch}`, base: data.defaultBranchRef.name, existingPr: prs[0] ?? null };
}
// Checked before anything is committed, so a `here` task on main never gets a commit it cannot push.
function assertBranch(task) {
  if (typeof task.branch !== 'string' || !task.branch) refuse('Check out a branch before publishing.');
  if (['main', 'master'].includes(task.branch)) refuse('Publishing directly to a default branch is forbidden.');
}
export async function preparePublish(repo, task) {
  if (task.mode === 'automatic' && task.localChanges?.length) refuse('This workspace includes pre-existing local edits. Keep or commit those edits separately, then start a clean task before publishing. Nothing was pushed.');
  assertBranch(task); assertReady(task); assertTaskGitSafe(repo,task);
  if (task.mode === 'automatic' && !task.hooksDirectory) {
    const { config } = pinnedConfig(repo, task.base, { task });
    task.hooksDirectory = snapshotHooks(repo, task, findSandboxHelper(config)); task.hooksSnapshotDigest = hooksSnapshotDigest(task.hooksDirectory); saveTask(repo, task);
  }
  assertPublishingHooks(repo,task);
  if (head(task.worktree) !== (task.commit ?? task.base)) refuse('The task worktree HEAD changed outside ELU Code.');
  if (!task.commit || git(task.worktree, ['status', '--porcelain']).stdout.trim()) {
    // Only what Git would commit: an ignored file, dependency folders and build output are never published.
    const files = publishable(taskChanges(task));
    git(task.worktree, ['-c',`core.hooksPath=${task.hooksDirectory}`,'add', '--', ...files]);
    git(task.worktree, ['-c',`core.hooksPath=${task.hooksDirectory}`, 'commit', '-m', 'Update task implementation']);
    task.commit = head(task.worktree); saveTask(repo, task);
  }
  if (head(task.worktree) !== task.commit || git(task.worktree, ['status', '--porcelain']).stdout.trim()) refuse('The task changed after its commit.');
  const dest = destination(repo, task);
  const body = prBody(task);
  const title = redact(task.goal).split('\n')[0].slice(0, 120);
  const confirmationId = hash(JSON.stringify({ commit: task.commit, destination: dest, title, body, digest: task.evidence.digest }));
  task.pendingPush = { confirmationId, destination: dest, title, body }; saveTask(repo, task);
  // fullAccess: the owner sees that this task ran without the cap and protected-path checks.
  return { needsConfirmation: true, confirmationId, commit: task.commit, destination: dest, title, body, fullAccess: task.permissions === 'full', nextCommand:`elu run ${task.id} --publish --approve-push ${confirmationId}`, message: 'Publishing uses a vetted absolute hooks snapshot, preserving pre-push guards. Approval is required for every push.' };
}
export async function publish(repo, task, confirmationId) {
  const previous = task.pendingPush;
  if (!previous || previous.confirmationId !== confirmationId) refuse('There is no matching push approval. Preview publication first.');
  assertReady(task); assertTaskGitSafe(repo,task);
  assertPublishingHooks(repo,task);
  if (head(task.worktree) !== task.commit || git(task.worktree, ['status', '--porcelain']).stdout.trim()) refuse('The task changed after approval.');
  const currentDestination = destination(repo, task);
  const title = redact(task.goal).split('\n')[0].slice(0, 120);
  const digest = hash(JSON.stringify({ commit: task.commit, destination: currentDestination, title, body: prBody(task), digest: task.evidence.digest }));
  if (digest !== confirmationId) refuse('The destination, PR, or evidence changed. Preview publication again.');
  task.pendingPush = null; saveTask(repo, task);
  git(task.worktree, ['-c',`core.hooksPath=${task.hooksDirectory}`, 'push','--no-follow-tags', 'origin', `${task.commit}:${currentDestination.ref}`], { timeout: 120000 });
  task.pushedCommit = task.commit; saveTask(repo, task); event(repo, 'pushed', { taskId: task.id, commit: task.commit });
  const bodyFile = path.join(repo.state, 'tasks', task.id, 'pr-body.md');
  const { atomic } = await import('./util.mjs'); atomic(bodyFile, prBody(task));
  if (currentDestination.existingPr) gh(repo.root, ['pr', 'edit', String(currentDestination.existingPr.number), '--repo', currentDestination.name, '--body-file', bodyFile]);
  else gh(repo.root, ['pr', 'create', '--repo', currentDestination.name, '--draft', '--base', currentDestination.base, '--head', task.branch, '--title', title, '--body-file', bodyFile]);
  const pr = JSON.parse(gh(repo.root, ['pr', 'view', task.branch, '--repo', currentDestination.name, '--json', 'url,isDraft,headRefOid']));
  if (!pr.isDraft || pr.headRefOid !== task.commit) refuse('The resulting PR does not match the approved draft head.');
  task.pr = pr.url; saveTask(repo, task);
  return { commit: task.commit, pushed: true, pr: task.pr, merged: false, deployed: false };
}
