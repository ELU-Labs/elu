import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stringifyYaml } from '../lib/yaml.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { answerTrust, unusedTrust } from '../lib/project-trust.mjs';
import { approveTask, currentTask } from '../lib/plan.mjs';

// What the owner's y does to the Task a request for an edit comes back with: it is approved
// and its work starts, in the same promise the test awaits. Tests of the editing machinery
// use it; test/plan.test.mjs covers the waiting, the keys and a rejection.
export function autoApprove(controller) {
  if (controller.approvesTasks) return controller;
  const ask = controller.ask.bind(controller); controller.approvesTasks = true;
  controller.ask = (text, id, options) => {
    const run = ask(text, id, options);
    return { id: run.id, finished: run.finished.then(task => {
      if (currentTask(controller.repo, run.id)?.state !== 'proposed') return task;
      const plan = approveTask(controller.repo, run.id);
      return ask(`Approved the Task: ${plan.title}`, run.id, { approved: true }).finished;
    }) };
  };
  return controller;
}
// The same for every project a test's conductor runs.
export function approvingConductor(conductor) {
  const make = conductor.controller.bind(conductor);
  conductor.controller = repo => autoApprove(make(repo));
  return conductor;
}

export const CLI = fileURLToPath(new URL('../bin/elu-code.mjs', import.meta.url));
// A test string shaped like a provider's key is joined from parts when the test runs, so no
// file here holds one whole and a scanner for leaked keys finds nothing to report.
export const keyLike = (...parts) => parts.join('');
export function temp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
// The read-only role a review runs with: what a config's reviewer entry held before bots
// did the reviews, and what a bot's turn is given now (botRole in lib/bots.mjs).
export const readRole = (vendor = 'claude') => ({ vendor, access: 'read', network: 'off', commands: [], writablePaths: [], timeoutSeconds: 300, maxCostUsd: null });
export function command(bin, args, cwd, env = {}) {
  return spawnSync(bin, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
}
export function git(root, args) {
  const r = command('git', ['-C', root, ...args], root);
  if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim();
}
export function project(t) {
  const parent = temp(t); const root = path.join(parent, 'sample app'); fs.mkdirSync(root);
  git(root, ['init', '--initial-branch=main']); git(root, ['config', 'user.name', 'Test Owner']); git(root, ['config', 'user.email', 'owner@example.invalid']);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/coupon.mjs'), 'export const normalize = (value) => value;\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sample', type: 'module', scripts: { test: 'node --test', build: 'node --check src/coupon.mjs' } }));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test/coupon.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {normalize} from '../src/coupon.mjs'; test('case',()=>assert.equal(normalize('save'),'SAVE'));\n");
  git(root, ['add', '.']); git(root, ['commit', '-m', 'Add sample']);
  return { parent, root };
}
export function cli(root, args, env = {}) {
  const r = command(process.execPath, [CLI, ...args, '--json'], root, env);
  let json;
  try { json = JSON.parse(r.stdout); } catch { throw new Error(`Invalid output: ${r.stdout}\n${r.stderr}`); }
  return { ...r, json };
}
// What the owner does when ELU asks about a project's own settings and instructions:
// he says use them. A test that writes such a file by hand, or moves the folder, says so
// before it expects the file in force. env: where that owner's record is kept, when it is
// not this process's own (a test that runs the command line in its own environment).
export function approveProjectFiles(root, env = {}) {
  const previous = process.env.XDG_CONFIG_HOME;
  if (env.XDG_CONFIG_HOME) process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  try { for (const row of unusedTrust(root)) answerTrust(root, row, true); }
  finally { if (env.XDG_CONFIG_HOME) { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; } }
}
export function config(root, edit = (x) => x) {
  const value = edit(defaultConfig());
  fs.mkdirSync(path.join(root, '.elu-code'), { recursive: true });
  fs.writeFileSync(path.join(root, '.elu-code/config.yaml'), stringifyYaml(value));
  return value;
}
// The fake vendor CLIs from test/fakes/, one per registry vendor, installed in a bin folder
// with this node as their shebang. fake.json beside them carries the test's mode and the
// files they record to (calls.jsonl, inputs.jsonl); agy and grok are stubs that only exit 2.
export const FAKES = fileURLToPath(new URL('./fakes/', import.meta.url));
// name: what the fake vendors answer when a reply is asked to name its session; without it they name nothing.
// commands: what the fake Codex runs in a turn, each in a plain shell with its own environment.
// replay: a file of what a real Codex launch printed, which the fake Codex gives back as it came.
// badReply: 'once' or 'lost', a first reply of the fake Claude Code that cannot be read (see the fake).
// install: what an editing turn of the fake Claude Code leaves beside its edit (see the fake).
// insert: lines an editing turn of the fake Claude Code also puts in a file (see the fake).
// tooLong: the reviews the fake Claude Code and Codex refuse as too long for the model (see the fakes).
export function fakeClis(parent, { mode = 'normal', sandboxBin = null, name = undefined, commands = undefined, replay = undefined, note = undefined, permissionMode = undefined, badReply = undefined, asks = undefined, intent = undefined, network = undefined, models = undefined, noCredits = undefined, fence = undefined, byMode = undefined, wait = undefined, blocked = undefined, install = undefined, insert = undefined, tooLong = undefined, learned = undefined, accounts = undefined, steps = undefined, stepMs = undefined } = {}) {
  const dir = path.join(parent, 'bin'); fs.mkdirSync(dir, { recursive: true });
  const calls = path.join(parent, 'calls.jsonl');
  fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify({ mode, calls, inputs: path.join(parent, 'inputs.jsonl'), repository: path.join(parent, 'repository.txt'), sandboxBin, name, commands, replay, note, permissionMode, badReply, asks, intent, network, models, noCredits, fence, byMode, wait, blocked, install, insert, tooLong, learned, accounts , steps, stepMs }));
  for (const vendor of ['claude', 'codex', 'agy', 'grok']) {
    fs.writeFileSync(path.join(dir, vendor), `#!${process.execPath}\n${fs.readFileSync(path.join(FAKES, `${vendor}.mjs`), 'utf8')}`, { mode: 0o755 });
  }
  // CLAUDE_CONFIG_DIR keeps the lead from picking up the real MCP servers of whoever runs the tests.
  return { env: { PATH: `${dir}${path.delimiter}${process.env.PATH}`, XDG_CONFIG_HOME: path.join(parent, 'personal'), XDG_DATA_HOME: path.join(parent, 'data'), CLAUDE_CONFIG_DIR: path.join(parent, 'claude'), ...(sandboxBin ? { ELU_CODE_SANDBOX_HELPER: sandboxBin } : {}) }, calls, dir };
}
