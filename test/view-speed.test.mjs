import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, git, temp } from './helpers.mjs';
import { repository, currentBranch, git as runGit } from '../lib/git.mjs';
import { projectSnapshot, dashboardSnapshot, registerProject } from '../lib/projects.mjs';
import { saveTask } from '../lib/state.mjs';

// Records every Git process the code starts, then runs the real Git.
function countGit(t) {
  const dir = temp(t), log = path.join(dir, 'git-calls'), real = runGit(dir, ['--exec-path']).stdout.trim();
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${path.join(real, 'git')}" "$@"\n`, { mode: 0o755 });
  const previous = { PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`; process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
}
function conversation(repo, id, text) {
  const dir = path.join(repo.state, 'tasks', String(id)); fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'lead-1.log'), at = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(logFile, `${JSON.stringify({ type: 'result', structured_output: { summary: text } })}\n`);
  const task = { id: String(id), kind: 'conversation', base: null, branch: null, worktree: repo.root, goal: 'question', state: 'answered', activeRole: null, createdAt: at, runs: [{ role: 'lead', vendor: 'claude', logFile, code: 0, at, costUsd: 0.01 }], sessions: {}, reviews: [], responses: [], messages: [] };
  saveTask(repo, task); return { task, logFile };
}

test('redraws read saved state without starting Git again', t => {
  const calls = countGit(t), p = project(t), repo = repository(p.root);
  conversation(repo, 1, 'First reply'); registerProject(repo);
  dashboardSnapshot(); projectSnapshot(repo);
  const before = calls();
  for (let index = 0; index < 5; index++) { dashboardSnapshot(); projectSnapshot(repo); }
  assert.equal(calls() - before, 0);
  assert.equal(dashboardSnapshot().projects[0].branch, 'main');
});

test('cached views show task and log changes as soon as files change', t => {
  countGit(t); const p = project(t), repo = repository(p.root);
  const { task, logFile } = conversation(repo, 1, 'First reply');
  const first = projectSnapshot(repo);
  assert.equal(first.tasks[0].state, 'answered');
  assert.match(first.activity.at(-1).text, /First reply/);
  assert.throws(() => { first.tasks[0].state = 'changed'; }, TypeError);
  saveTask(repo, { ...task, state: 'needs_input' });
  fs.appendFileSync(logFile, `${JSON.stringify({ type: 'result', structured_output: { summary: 'Second reply' } })}\n`);
  const second = projectSnapshot(repo);
  assert.equal(second.tasks[0].state, 'needs_input');
  assert.match(second.activity.at(-1).text, /Second reply/);
  conversation(repo, 2, 'Another chat');
  assert.deepEqual(projectSnapshot(repo).tasks.map(row => row.id), ['1', '2']);
});

test('the newest activity across many logs keeps time order', t => {
  countGit(t); const p = project(t), repo = repository(p.root);
  for (let id = 1; id <= 3; id++) {
    const { task, logFile } = conversation(repo, id, `reply ${id}`);
    fs.writeFileSync(logFile, Array.from({ length: 80 }, (_, row) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `task ${id} row ${row}` }] } })).join('\n') + '\n');
    saveTask(repo, { ...task, runs: [{ ...task.runs[0], at: new Date(Date.UTC(2026, 0, 1, 0, 4 - id)).toISOString() }] });
  }
  const rows = projectSnapshot(repo).activity.map(row => row.text);
  assert.equal(rows.length, 100);
  assert.match(rows[0], /task 2 row 60/); assert.match(rows.at(-1), /task 1 row 79/);
});

test('the branch read from HEAD matches Git for checkouts, worktrees and detached heads', t => {
  const p = project(t), linked = path.join(p.parent, 'linked');
  git(p.root, ['worktree', 'add', '-b', 'feature/view', linked]);
  assert.equal(currentBranch(p.root), 'main');
  assert.equal(currentBranch(linked), 'feature/view');
  git(linked, ['checkout', '--detach']);
  assert.equal(currentBranch(linked), git(linked, ['branch', '--show-current']));
  assert.equal(currentBranch(linked), '');
});
