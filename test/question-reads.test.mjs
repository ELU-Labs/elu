import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, vendorPath } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { ProjectController, registerProject } from '../lib/projects.mjs';
import { pendingRequests, projectFolder } from '../lib/workspace.mjs';
import { Conductor, enqueue } from '../lib/conductor.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import { CAPS, questionRefusal } from '../lib/vendors.mjs';

// A teammate's question reads the shared project and nothing else: the files Git tracks there,
// never its Git folder, a file Git does not track, or a file outside it (lib/adapters/claude.mjs
// compile with peer). Only Claude Code's launch keeps every one of those reads out, so only it
// answers teammates' questions; the refusal on each other vendor says which read its launch lets
// through (lib/vendors.mjs questionRefusal). Here each vendor is the only one on the computer, and
// its stand-in reads the same four files as the launch it is given lets it (reads in fake.json,
// each recorded in reads.jsonl beside it with whether it was read), and a key in the owner's
// ~/.ssh, which every launch here denies: so a read a launch keeps out shows as not read.
const RELEASE = { grok: '1.0.77', agy: '1.5.4' };
const LIVE = new WeakMap();
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function setup(t, vendor) {
  // The conductors stop before the folder goes: hooks run in the order they were registered.
  LIVE.set(t, []); t.after(async () => { for (const conductor of LIVE.get(t)) await conductor.stop(); });
  const p = project(t);
  const files = { tracked: path.join(p.root, 'src', 'coupon.mjs'), git: path.join(p.root, '.git', 'HEAD'), untracked: path.join(p.root, 'notes.txt'), outside: path.join(p.parent, 'elsewhere.txt'), secret: path.join(p.parent, '.ssh', 'id_ed25519') };
  fs.writeFileSync(files.untracked, 'Notes the owner keeps out of Git.\n'); fs.writeFileSync(files.outside, 'A file beside the project.\n');
  fs.mkdirSync(path.dirname(files.secret), { mode: 0o700 }); fs.writeFileSync(files.secret, 'not a real key\n', { mode: 0o600 });
  const fake = fakeClis(p.parent, { mode: 'answer', reads: Object.values(files) }), only = vendorPath(p.parent, fake.dir, [vendor]);
  environment(t, { ...fake.env, PATH: only.PATH, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  if (vendor === 'grok') { fs.mkdirSync(path.join(p.parent, '.grok')); fs.writeFileSync(path.join(p.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 }); }
  // Its one-time check has passed here, so it runs in Read only.
  if (CAPS[vendor].conformance) atomic(path.join(personalDirectory(), 'conformance', `${vendor}.json`), { v: 1, bin: fs.realpathSync(path.join(only.dir, vendor)), version: RELEASE[vendor], steps: Object.fromEntries(ADAPTERS[vendor].conformance.map(step => [step.id, 'pass'])), relay: vendor === 'grok', at: new Date().toISOString() });
  const repo = repository(p.root); registerProject(repo);
  const log = path.join(only.dir, 'reads.jsonl');
  // Whether any run since the last clear read each file.
  const reads = () => {
    const rows = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    assert.ok(rows.length, `${vendor}: its stand-in was asked to read`);
    return Object.fromEntries(Object.entries(files).map(([name, file]) => [name, rows.some(row => row.path === file && row.read)]));
  };
  return { ...p, repo, reads, clear: () => fs.rmSync(log, { force: true }) };
}
async function until(check, label, timeout = 60000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test("a teammate's question on Claude Code reads the files Git tracks in the shared project, and nothing else", async t => {
  const p = setup(t, 'claude'), conductor = new Conductor({ tickMs: 20 }).start(); LIVE.get(t).push(conductor);
  const origin = { kind: 'ask', peer: 'b'.repeat(64), name: 'sara', a2aTaskId: 'task-1', threadId: 'thread-1', hop: 1 };
  const row = enqueue(p.root, 'Answer the question from @sara (shown in the peer data block) using this repository. Do not edit files.', { origin, readOnly: true, context: 'What do the notes say?' });
  await until(() => pendingRequests(p.root).find(one => one.id === row.id)?.state === 'done', 'the question');
  assert.deepEqual(p.reads(), { tracked: true, git: false, untracked: false, outside: false, secret: false });
});

// Codex reads a file only by running a command: its Read only launch has none and reads nothing,
// so it could not answer from the project at all. The launch it runs commands in reads anywhere
// its read-only sandbox lets it. Grok Build's Read only launch has no rule that keeps a read
// inside the project. Antigravity keeps reads inside its workspace but has no read deny.
test("Codex, Antigravity and Grok Build read what a teammate's question may not, and the refusal on each says what", async t => {
  const SAYS = { inside: /^Only Claude Code answers a teammate's question\. \S+(?: Build)? cannot keep its reads inside the shared project\. Choose a Claude model with \/model default to answer them\.$/, git: /^Only Claude Code answers a teammate's question\. \S+ cannot keep its reads out of the project's Git folder and the files Git does not track\. Choose a Claude model with \/model default to answer them\.$/ };
  const SEEN = { codex: { tracked: true, git: true, untracked: true, outside: true, secret: false }, agy: { tracked: true, git: true, untracked: true, outside: false, secret: false }, grok: { tracked: true, git: true, untracked: true, outside: true, secret: false } };
  for (const vendor of ['codex', 'agy', 'grok']) {
    await t.test(vendor, async t => {
      const p = setup(t, vendor), controller = new ProjectController(projectFolder(p.root));
      const locked = await controller.ask('What do the notes say?', null, { readOnly: true }).finished;
      assert.equal(locked.error, null, JSON.stringify(locked.error)); assert.equal(locked.state, 'answered');
      assert.ok(locked.runs.every(run => run.vendor === vendor));
      if (vendor === 'codex') {
        assert.deepEqual(p.reads(), { tracked: false, git: false, untracked: false, outside: false, secret: false }, 'Read only on Codex reads nothing');
        p.clear();
        const asked = await controller.ask('What do the notes say?', null, { permissions: 'ask' }).finished;
        assert.equal(asked.error, null, JSON.stringify(asked.error)); assert.equal(asked.state, 'answered');
      }
      const seen = p.reads();
      assert.deepEqual(seen, SEEN[vendor], vendor);
      // The read its launch lets through is the one its refusal names, to the owner and to the asker.
      assert.match(questionRefusal(vendor), seen.outside ? SAYS.inside : SAYS.git, vendor);
    });
  }
});
