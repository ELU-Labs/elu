import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile as claude } from '../lib/adapters/claude.mjs';
import { compile as codex } from '../lib/adapters/codex.mjs';
import { settingsFor as agySettings } from '../lib/adapters/agy.mjs';
import * as grok from '../lib/adapters/grok.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { APPROVAL_TOOL } from '../lib/mcp.mjs';
import { HOME_SECRETS } from '../lib/vendors.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { temp } from './helpers.mjs';

// Full access is everything: a session started in it reaches ~/.claude, ~/.ssh, ~/.config and
// ELU's own folder like any other file, with every vendor. The lower modes keep their denies.
const SESSION = '12345678-1234-4234-8234-123456789abc';
const home = () => fs.realpathSync(os.homedir());
const ownFolder = () => path.resolve(personalDirectory());
// Every way a launch can name a home secret or ELU's own folder.
const closes = text => [...new Set([home(), os.homedir()])].flatMap(root => HOME_SECRETS.map(name => path.join(root, name))).concat(ownFolder()).some(dir => text.includes(dir.slice(1)));
function world(t) {
  const dir = temp(t), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  const cwd = path.join(dir, 'ws'); fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  fs.mkdirSync(ownFolder(), { recursive: true });
  const mcp = { file: path.join(dir, 'mcp.json'), names: ['elu-code-approval'] }; fs.writeFileSync(mcp.file, '{"mcpServers":{}}');
  const schemaFile = path.join(dir, 'schema.json'); fs.writeFileSync(schemaFile, '{}');
  const runDir = path.join(dir, 'run'); fs.mkdirSync(runDir);
  return { dir, cwd, mcp, schemaFile, runDir, commonDir: path.join(cwd, '.git'), role: defaultConfig().roles.lead };
}

test('Claude in Full access gets no deny rule and no sandbox list; Ask and Approve for me keep them', t => {
  const w = world(t);
  const launch = (mode, extra = {}) => claude({ role: w.role, mode, cwd: w.cwd, protectedPaths: ['.elu-code', '.git', 'package.json'], commonDir: w.commonDir, session: SESSION, mcp: w.mcp, approval: { tool: APPROVAL_TOOL }, ...extra });
  const settingsOf = args => JSON.parse(args[args.indexOf('--settings') + 1]);
  for (const extra of [{}, { home: true, memory: path.join(w.dir, 'memory') }]) {
    const full = launch('full', extra), settings = settingsOf(full);
    assert.deepEqual(settings.permissions.deny, [], 'nothing denied in Full access');
    assert.equal(settings.permissions.ask, undefined);
    assert.deepEqual(settings.sandbox, { enabled: false }, 'no denyRead or denyWrite');
    assert.equal(full.some(arg => closes(arg)), false, 'no home secret and no ELU folder anywhere in the Full access argv');
  }
  for (const mode of ['ask', 'auto']) {
    const settings = settingsOf(launch(mode));
    for (const name of ['.ssh', '.claude', '.config', '.claude.json']) assert.ok(settings.permissions.deny.includes(`Read(//${path.join(home(), name).slice(1)})`), `${mode} denies ${name}`);
    assert.ok(settings.permissions.deny.includes(`Write(//${ownFolder().slice(1)}/**)`), `${mode} keeps ELU's folder closed`);
    assert.ok(settings.sandbox.filesystem.denyRead.includes('~/.claude'), `${mode} keeps the sandbox list`);
  }
});

test('Codex, Antigravity CLI and Grok Build in Full access deny nothing; the lower modes keep their denies', t => {
  const w = world(t), lead = { ...w.role, writablePaths: ['.'] };
  // Codex: danger-full-access, no profile.
  const full = codex({ role: lead, mode: 'full', cwd: w.cwd, schemaFile: w.schemaFile, commonDir: w.commonDir });
  assert.equal(full.some(arg => /"deny"/.test(arg) || closes(arg)), false);
  assert.ok(codex({ role: lead, mode: 'ask', cwd: w.cwd, schemaFile: w.schemaFile, commonDir: w.commonDir }).some(arg => arg.includes(`${JSON.stringify(path.join(home(), '.ssh'))}="deny"`)));
  // Antigravity CLI: the settings it is launched with.
  const agyFull = agySettings('full', { cwd: w.cwd, commonDir: w.commonDir });
  assert.equal(agyFull.permissions.deny, undefined, 'no deny list in Full access');
  assert.equal(closes(JSON.stringify(agyFull)), false);
  for (const mode of ['ask', 'auto']) assert.ok(agySettings(mode, { cwd: w.cwd, commonDir: w.commonDir }).permissions.deny.some(rule => rule.startsWith(`write_file(${path.join(os.homedir(), '.ssh')}`)), mode);
  // Grok Build: the rules ride on the command line.
  atomic(path.join(personalDirectory(), 'conformance', 'grok.json'), { v: 1, bin: path.join(w.dir, 'grok'), version: '1.0.77', steps: Object.fromEntries(grok.conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });
  const grokRole = { vendor: 'grok', access: 'edit', writablePaths: ['.'], commands: [], network: 'off', maxCostUsd: null, timeoutSeconds: 120 };
  const grokFull = grok.compile({ role: grokRole, mode: 'full', cwd: w.cwd, session: SESSION, runDir: w.runDir });
  assert.equal(grokFull.includes('--deny'), false, 'no --deny in Full access');
  assert.equal(grokFull.some(arg => closes(arg)), false);
  for (const mode of ['ask', 'auto']) assert.ok(grok.compile({ role: grokRole, mode, cwd: w.cwd, session: SESSION, runDir: w.runDir }).includes(`Read(${path.join(home(), '.claude')}/**)`), mode);
});
