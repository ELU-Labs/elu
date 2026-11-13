import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as claude from '../lib/adapters/claude.mjs';
import * as codex from '../lib/adapters/codex.mjs';
import * as agy from '../lib/adapters/agy.mjs';
import * as grok from '../lib/adapters/grok.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { readRole } from './helpers.mjs';
import { picturesRoot } from '../lib/pictures.mjs';

// The locked profile is the Read only launch. fixtures/argv-locked.json was computed from the
// adapters before permission modes existed, with every machine path replaced by a token;
// compile({ mode: 'locked' }) must still produce it, argument for argument, with five changes
// since: every run asks for the model's thinking in words, for the steps the chat shows while
// it works (Claude Code's --thinking-display summarized, Codex's model_reasoning_summary);
// every run, the owner's too, is denied ELU's own state folder; the file tools of
// every run are denied ELU's records in the repository's Git folder; a sandboxed
// command reads the rest of that folder, so git works there (a teammate's question reads none
// of the folder, with the file tools or from a command); and in a Git work tree the owner's
// runs are kept from the secret-looking files Git does not track, by path, not from every
// file of those names, so a tracked .npmrc reads as any other file (this repository has
// none untracked, so no such rule shows; a teammate's question keeps the names). A config of
// that time gave the model a $3 limit and named a reviewer, and a read-only run with no limit
// of its own got $1. A run has no limit now unless the owner sets one, so the limits of
// that time are set here by hand.
test('compile in the locked profile is byte-identical to the launch before modes existed', (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-argv-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'repo'), personal = path.join(base, 'personal'), memory = path.join(base, 'memory'), mcpFile = path.join(base, 'mcp.json');
  fs.mkdirSync(cwd); fs.mkdirSync(personal); fs.mkdirSync(memory); fs.writeFileSync(mcpFile, '{"mcpServers":{}}');
  const previous = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = personal;
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  const git = args => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
  git(['init', '-q', '--initial-branch=main']); git(['config', 'user.name', 'T']); git(['config', 'user.email', 't@example.invalid']);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n'); git(['add', '.']); git(['commit', '-qm', 'init']);
  const home = fs.realpathSync(os.homedir()), session = '12345678-1234-4234-8234-123456789abc';
  const lead = { ...defaultConfig().roles.lead, maxCostUsd: 3 }, reviewer = { ...readRole('claude'), maxCostUsd: 1 };
  const common = path.join(cwd, '.git'), schemaFile = path.join(cwd, 'schema.json'), locked = { mode: 'locked' };
  const cases = {
    'claude lead': () => claude.compile({ ...locked, role: lead, cwd, protectedPaths: ['.elu-code', '.git', 'package.json'], commonDir: common, session }),
    'claude lead with commands': () => claude.compile({ ...locked, role: { ...lead, commands: ['npm test'] }, cwd, protectedPaths: ['.elu-code', '.git'], commonDir: common, session }),
    'claude lead resumed': () => claude.compile({ ...locked, role: lead, cwd, protectedPaths: ['.git'], commonDir: common, session, resume: session }),
    'claude reviewer': () => claude.compile({ ...locked, role: reviewer, cwd, protectedPaths: ['.git'], commonDir: common, session }),
    'claude peer': () => claude.compile({ ...locked, role: reviewer, cwd, protectedPaths: ['.git'], commonDir: common, session, peer: true }),
    'claude owner home mcp memory': () => claude.compile({ ...locked, role: reviewer, cwd, protectedPaths: ['.git'], commonDir: common, session, home: true, mcp: { file: mcpFile, names: ['elu'] }, memory }),
    'codex reviewer': () => codex.compile({ ...locked, role: readRole('codex'), cwd, schemaFile }),
  };
  const tokens = [[fs.realpathSync(personal), '<personal>'], [cwd, '<cwd>'], [memory, '<memory>'], [mcpFile, '<mcp>'], [home, '<home>']];
  const tokenise = value => tokens.reduce((text, [from, to]) => text.split(from).join(to), value);
  const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/argv-locked.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(cases), Object.keys(expected));
  for (const [name, run] of Object.entries(cases)) assert.deepEqual(run().map(tokenise), expected[name], name);
  // A teammate's question that came with pictures is the recorded peer launch with one
  // --add-dir, the folder of that question's pictures, and nothing else changed.
  const tmp = path.join(base, 'tmp'), before = process.env.TMPDIR; fs.mkdirSync(tmp); process.env.TMPDIR = tmp;
  t.after(() => { if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before; });
  const shown = path.join(picturesRoot(tmp), 'q-0123456789abcdef'); fs.mkdirSync(shown, { mode: 0o700 });
  fs.writeFileSync(path.join(shown, '1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), { mode: 0o600 });
  const withPictures = claude.compile({ ...locked, role: reviewer, cwd, protectedPaths: ['.git'], commonDir: common, session, peer: true, pictures: shown });
  const at = withPictures.indexOf('--add-dir');
  assert.equal(withPictures[at + 1], shown); assert.equal(withPictures.filter(arg => arg === '--add-dir').length, 1);
  assert.deepEqual([...withPictures.slice(0, at), ...withPictures.slice(at + 2)].map(tokenise), expected['claude peer']);
  assert.throws(() => claude.compile({ ...locked, role: reviewer, cwd, protectedPaths: ['.git'], commonDir: common, session, pictures: shown }), /Only a teammate's question run is given a pictures folder/);
  assert.throws(() => claude.compile({ ...locked, role: reviewer, cwd, protectedPaths: ['.git'], commonDir: common, session, peer: true, pictures: home }), /must be in ELU's own pictures folder/);
  // The state folder (identity, approvals, other projects' records) is denied to the file tools and
  // to the shell in every Claude launch, wherever XDG_CONFIG_HOME points.
  for (const name of Object.keys(cases).filter(name => name.startsWith('claude'))) {
    const settings = JSON.parse(expected[name][expected[name].indexOf('--settings') + 1]);
    assert.ok(['Read(/<personal>/elu-code)', 'Read(/<personal>/elu-code/**)'].every(rule => settings.permissions.deny.includes(rule)), name);
    assert.ok(settings.sandbox.filesystem.denyRead.includes('<personal>/elu-code'), name);
  }
  // With no limit set, the same launch names no budget: the arguments are the recorded ones without the two budget words.
  const free = role => claude.compile({ ...locked, role, cwd, protectedPaths: ['.git'], commonDir: common, session }).map(tokenise);
  const unbudgeted = name => expected[name].filter((arg, i, all) => arg !== '--max-budget-usd' && all[i - 1] !== '--max-budget-usd');
  assert.deepEqual(free(readRole('claude')), unbudgeted('claude reviewer')); assert.equal(free(defaultConfig().roles.lead).includes('--max-budget-usd'), false);
  // The default is the locked profile. A Claude mode needs the approval relay (conformance-claude
  // tests its argv); a Codex mode compiles its own launch (conformance-codex tests it); an
  // unpinned vendor refuses until its one-time check passed on this machine (none has, under <personal>).
  assert.deepEqual(claude.compile({ role: lead, cwd, protectedPaths: ['.git'], commonDir: common, session }), claude.compile({ ...locked, role: lead, cwd, protectedPaths: ['.git'], commonDir: common, session }));
  assert.deepEqual(codex.compile({ role: readRole('codex'), cwd, schemaFile }), cases['codex reviewer']());
  for (const mode of ['ask', 'auto', 'full']) {
    assert.throws(() => claude.compile({ mode, role: lead, cwd, protectedPaths: ['.git'], commonDir: common, session }), /approval relay/);
    const argv = codex.compile({ mode, role: readRole('codex'), cwd, schemaFile });
    assert.notDeepEqual(argv, cases['codex reviewer'](), mode); assert.ok(argv.some(arg => /^(sandbox_mode|default_permissions)=/.test(arg)), mode);
    assert.throws(() => grok.compile({ mode, role: lead, cwd, session, runDir: cwd }), /Grok Build has not been checked on this machine yet\. Your first message to it runs the check\./);
    assert.throws(() => agy.compile({ mode, role: lead, cwd, schemaFile }), /Antigravity CLI has not been checked on this machine yet\. Your first message to it runs the check\./);
  }
});
