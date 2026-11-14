import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { baseFile, taskChanges, tracked, assertTaskGitSafe } from './git.mjs';
import { parseConfig } from './config.mjs';
import { protectedFiles, protectedPath, sensitive, pathAllowed } from './policy.mjs';
import { hash, noSymlinks, refuse } from './util.mjs';
import { sandboxRun } from './sandbox.mjs';
import { taskDir, saveTask, event } from './state.mjs';
import { MODES } from './modes.mjs';
import { checkSeconds, checkStoppedLine } from './turn-limits.mjs';
import { NOT_APPROVED, trustedText } from './project-trust.mjs';
import { settleHead } from './task-head.mjs';

// The session's mode decides which structural rules apply. A task without
// permissions is from before modes existed and keeps every rule.
const modeOf = task => MODES.includes(task?.permissions) ? task.permissions : 'locked';

export function pinnedConfig(repo, base, { current = true, task } = {}) {
  if (task?.mode === 'automatic' || task?.kind === 'conversation') {
    const file = path.join(taskDir(repo, task.id), 'policy.yaml'); noSymlinks(file);
    const text = fs.readFileSync(file, 'utf8');
    if (hash(text) !== task.configHash) refuse('The saved task policy changed.');
    return { config: parseConfig(text), configHash: hash(text) };
  }
  const text = baseFile(repo.root, base, '.elu-code/config.yaml');
  const file = path.join(repo.root, '.elu-code', 'config.yaml'); noSymlinks(file);
  if (current && text !== fs.readFileSync(file, 'utf8')) refuse('Commit policy changes before running a task.');
  // A new task takes its policy from the project's file only as the owner approved it on
  // this machine. Nobody is asked here, so it is refused with what to do.
  if (current && trustedText(repo.root, 'config.yaml') !== text) refuse(NOT_APPROVED);
  return { config: parseConfig(text), configHash: hash(text) };
}
// A check that does not stop the work: it passed, or it is a note of a Full access run.
export const checkPassed = row => row?.status === 'passed' || row?.status === 'noted';
export function structuralChecks(task, config, { mode = 'locked' } = {}) {
  const change = taskChanges(task);
  const results = [], full = mode === 'full', dependenciesOpen = ['auto', 'full'].includes(mode);
  const add = (name, pass, details = []) => results.push({ name, status: pass ? 'passed' : 'failed', details });
  // Full access is everything: no rule of ours fails its run. What these three find is still
  // kept, as a note the owner can read (status noted), and nothing waits on it.
  const note = (name, pass, details = []) => full ? results.push({ name, status: pass ? 'passed' : 'noted', details }) : add(name, pass, details);
  note('no-ignored-output', !change.ignored.length, change.ignored);
  // A change of any size passes: ELU sets no limit of its own on changed lines. A binary change still needs a person.
  if (!full) add('no-binary-changes', !change.binary, change.binary ? ['Binary changes require manual review.'] : []);
  const undeclared = change.paths.filter((file) => !pathAllowed(file, config.paths));
  note('declared-paths', !undeclared.length, undeclared);
  const protectedChanges = change.paths.filter(file=>protectedPath(file, { mode })||(task.hookProtectedPaths??[]).some(dir=>file===dir||file.startsWith(`${dir}/`)));
  if (!full) add('protected-paths', !protectedChanges.length, protectedChanges);
  const secrets = change.paths.filter(sensitive);
  if (!full) add('secret-paths', !secrets.length, secrets);
  const deletedTests = tracked(task.worktree, task.base).filter((file) => /(^|\/)(?:tests?|__tests__)(\/|$)|\.(?:test|spec)\.[^/]+$/.test(file) && !fs.existsSync(path.join(task.worktree, file)));
  note('no-deleted-tests', !deletedTests.length, deletedTests);
  const packages = change.paths.filter((file) => /(^|\/)package\.json$/.test(file));
  const scripts = []; const dependencies = [];
  for (const file of packages) {
    const before = JSON.parse(baseFile(task.worktree, task.base, file, { optional: true }) ?? '{}');
    const full = path.join(task.worktree, file); noSymlinks(full);
    const after = fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : {};
    if (JSON.stringify(before.scripts ?? {}) !== JSON.stringify(after.scripts ?? {})) scripts.push(file);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies', 'workspaces', 'packageManager']) {
      if (JSON.stringify(before[field] ?? {}) !== JSON.stringify(after[field] ?? {})) dependencies.push(`${file}: ${field}`);
    }
  }
  if (!full) add('unchanged-scripts', !scripts.length, scripts);
  if (!dependenciesOpen) add('no-dependency-changes', !dependencies.length, dependencies);
  return { change, results };
}
export async function runChecks(repo, task, { signal } = {}) {
  if (task.kind === 'conversation') refuse('This response has no code changes to verify.');
  signal?.throwIfAborted();
  const { config, configHash } = pinnedConfig(repo, task.base, { current: false, task });
  const hooks=assertTaskGitSafe(repo,task);
  if (task.configHash !== configHash) refuse('The pinned task policy changed.');
  // The checks run on what is in the session's folder now. What the agent committed in its
  // turn is already the session's commit; a HEAD that moved since is taken in here.
  settleHead(repo, task);
  const mode = modeOf(task);
  const { change, results } = structuralChecks(task, config, { mode });
  const protectedPaths = [...protectedFiles(tracked(task.worktree, task.base), { mode }),...hooks.protectedPaths];
  if (results.every(checkPassed)) {
    for (const check of config.checks) {
      const logFile = path.join(taskDir(repo, task.id), `check-${check.name}-${crypto.randomUUID()}.log`);
      const scratch = path.join(task.worktree, '.elu-code', 'tmp',crypto.randomUUID()); noSymlinks(scratch);
      let run;
      task.activeRole = 'checks'; task.activeLog = logFile; task.activeSince = new Date().toISOString(); saveTask(repo, task);
      event(repo, 'check-started', { taskId: task.id, name: check.name });
      // A check that prints nothing, such as a slow test suite, is working: it has no quiet
      // limit, only the cap of a turn, and the conductor leaves it to that (lib/turn-limits.mjs).
      const seconds = checkSeconds();
      try {
        run = await sandboxRun({ cwd: task.worktree, protectedPaths, scratch, program: check.command[0], args: check.command.slice(1), logFile, processFile: path.join(taskDir(repo, task.id), 'process.json'), timeoutSeconds: seconds,config,signal, network: mode === 'full' ? 'on' : 'off' });
      } finally {
        if (fs.existsSync(scratch)) fs.rmSync(scratch, { recursive: true });
        task.activeLog = null; task.activeRole = null; saveTask(repo, task);
      }
      results.push({ name: check.name, status: run.code === 0 && !run.timedOut ? 'passed' : 'failed', logFile, ...(run.timedOut ? { details: [checkStoppedLine(seconds)] } : {}) });
      event(repo, 'check-finished', { taskId: task.id, name: check.name, status: results.at(-1).status });
      const after = taskChanges(task);
      if (after.digest !== change.digest) {
        results.push({ name: 'checks-left-source-unchanged', status: 'failed', details: ['A check changed the source tree.'] }); break;
      }
    }
  } else {
    for (const check of config.checks) results.push({ name: check.name, status: 'skipped', details: ['Fix structural failures first.'] });
  }
  if (task.mode === 'automatic' && !config.checks.length) results.push({ name: 'project-checks', status: 'not-configured', details: ['No test or build command is configured. Edits have not been verified.'] });
  task.evidence = { base: task.base, digest: taskChanges(task).digest, changedLines: change.lines, results, checkedAt: new Date().toISOString() };
  saveTask(repo, task); event(repo, 'checked', { taskId: task.id, passed: results.every(checkPassed) });
  return task.evidence;
}
export function evidenceCurrent(task) {
  if (!task.evidence || task.evidence.base !== task.base || !task.evidence.results.every(checkPassed)) return false;
  return taskChanges(task).digest === task.evidence.digest;
}
