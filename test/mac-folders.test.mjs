import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { temp, project, fakeClis, autoApprove, readRole } from './helpers.mjs';
import * as claude from '../lib/adapters/claude.mjs';
import * as codex from '../lib/adapters/codex.mjs';
import * as agy from '../lib/adapters/agy.mjs';
import * as grok from '../lib/adapters/grok.mjs';
import { ProjectController, registerProject } from '../lib/projects.mjs';
import { createFolder, createFolderPlan, projectFolder, pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';
import { assertGitSafe, git, repository } from '../lib/git.mjs';
import { claudeAccount, codexAccount } from '../lib/usage.mjs';
import { installScheduler, listSchedules, parseWhen, runDue, saveSchedule, schedulerFiles } from '../lib/schedules.mjs';
import { readablePictures } from '../lib/pictures.mjs';
import { attachPictures } from '../lib/peer/pictures.mjs';
import { checkInbox, inboxRoot } from '../lib/peer/files.mjs';
import { servicePath } from '../lib/peer/index.mjs';
import { standupReply } from '../lib/standup.mjs';
import { shimsBase, writeShims } from '../lib/never-shims.mjs';
import { atomic, mkdir, noSymlinks, onDiskPath, personalDirectory, personalDirectoryNames, readJson, systemTemp, systemTempNames, tempFolder } from '../lib/util.mjs';

// macOS keeps /var and /tmp as links to /private/var and /private/tmp, and its temp folder is
// /var/folders/…/T/. ELU refuses a link in a path it writes, so every folder it is handed is
// read as it is on disk first: the temp folder, the folder for its state, a folder the owner
// names. These tests run ELU on folders laid out as a Mac's.

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// A Mac's folders under one real folder: var and tmp are links into private, the home folder
// is no link, and the temp folder is var/folders/xy/T (TMPDIR names it with a slash at its end).
function mac(t) {
  const root = temp(t), on = (...parts) => path.join(root, ...parts);
  fs.mkdirSync(on('private', 'var', 'folders', 'xy', 'T'), { recursive: true }); fs.mkdirSync(on('private', 'tmp'));
  fs.symlinkSync(path.join('private', 'var'), on('var')); fs.symlinkSync(path.join('private', 'tmp'), on('tmp'));
  fs.mkdirSync(on('Users', 'me'), { recursive: true });
  return { root, on, home: on('Users', 'me'), tmp: on('tmp'), temp: on('var', 'folders', 'xy', 'T'), tempOnDisk: on('private', 'var', 'folders', 'xy', 'T') };
}
const GIT = { GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' };
const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(64, 7)]);
const picture = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, PNG); return file; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const inputs = parent => fs.existsSync(path.join(parent, 'inputs.jsonl')) ? fs.readFileSync(path.join(parent, 'inputs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
// The conductor's part of a standup: each session asked answers once its turn is over.
function answering(controller, done) {
  const handled = new Set();
  return (async () => {
    while (!done()) {
      for (const row of pendingRequests(controller.repo.root).filter(value => value.standupFor && value.state === 'queued' && !handled.has(value.id))) {
        if (['running', 'preparing'].includes(readTask(controller.repo, row.continuationTaskId).state)) continue;
        handled.add(row.id); updateRequest(controller.repo.root, row.id, { state: 'running' });
        await controller.ask(row.goal, row.continuationTaskId, { standupFor: row.standupFor }).finished;
        updateRequest(controller.repo.root, row.id, { state: 'done', reason: 'Finished.' });
      }
      await sleep(20);
    }
  })();
}
// Every file under a folder, for a search of what ELU wrote.
function everyFile(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'objects') everyFile(full, out); } else if (entry.isFile()) out.push(full);
  }
  return out;
}
const saysLink = dir => everyFile(dir).filter(file => { try { return fs.statSync(file).size < 4 * 1024 * 1024 && /symbolic link/i.test(fs.readFileSync(file, 'utf8')); } catch { return false; } });

test('a path is read as it is on disk before a link check: one above what ELU writes is followed, one inside it is still refused', t => {
  const m = mac(t);
  assert.equal(onDiskPath(m.temp), m.tempOnDisk);
  assert.equal(onDiskPath(`${m.temp}/`), m.tempOnDisk, 'TMPDIR ends in a slash on a Mac');
  assert.equal(onDiskPath(path.join(m.tmp, 'not', 'made', 'yet')), m.on('private', 'tmp', 'not', 'made', 'yet'), 'what is missing keeps its name after the folder that is there');
  assert.equal(onDiskPath(m.home), m.home, 'a path with no link is itself');
  environment(t, { TMPDIR: `${m.temp}/` });
  assert.equal(os.tmpdir(), m.temp);
  assert.equal(systemTemp(), m.tempOnDisk); assert.deepEqual(systemTempNames(), [m.temp, m.tempOnDisk]);
  const made = tempFolder('elu-code-test-own-'); t.after(() => fs.rmSync(made, { recursive: true, force: true }));
  assert.equal(path.dirname(made), m.tempOnDisk);
  assert.doesNotThrow(() => { mkdir(path.join(made, 'a')); atomic(path.join(made, 'a', 'b.json'), { ok: true }); });
  assert.deepEqual(readJson(path.join(made, 'a', 'b.json')), { ok: true });
  // A link planted inside the folder is refused as before, and so is one left hanging.
  fs.symlinkSync(m.home, path.join(made, 'planted')); fs.symlinkSync(path.join(made, 'nowhere'), path.join(made, 'hanging'));
  assert.throws(() => noSymlinks(path.join(made, 'planted', 'file')), /Refusing a symbolic link/);
  assert.throws(() => atomic(path.join(onDiskPath(path.join(made, 'hanging')), 'file'), 'x'), /Refusing a symbolic link/);
  // As written, the same folder is refused: the reason every folder ELU is handed is read first.
  assert.throws(() => noSymlinks(path.join(m.temp, 'x')), /Refusing a symbolic link/);
});

test("on a Mac's folders a new project under /tmp, a turn, its review, a standup, an attached screenshot and a schedule tick all work", { timeout: 240000 }, async t => {
  const m = mac(t), fake = fakeClis(m.home, { mode: 'normal' });
  environment(t, { ...fake.env, ...GIT, HOME: m.home, TMPDIR: `${m.temp}/` });
  assert.equal(os.tmpdir(), m.temp); assert.equal(fs.lstatSync(m.on('var')).isSymbolicLink(), true); assert.equal(fs.lstatSync(m.on('tmp')).isSymbolicLink(), true);

  // + New project, with the folder typed as /tmp/notes: it was refused as "a symbolic link: /tmp".
  const plan = createFolderPlan(path.join(m.tmp, 'notes'));
  assert.equal(plan.root, m.on('private', 'tmp', 'notes'));
  assert.equal(createFolder(plan).root, m.on('private', 'tmp', 'notes')); assert.ok(fs.statSync(path.join(m.tmp, 'notes')).isDirectory());
  assert.throws(() => createFolderPlan(path.join(m.tmp, 'notes')), /already exists/);
  // A link left hanging where the new folder would go is refused: nothing is made through it.
  fs.symlinkSync(path.join(m.tmp, 'nowhere'), path.join(m.tmp, 'hanging'));
  assert.throws(() => createFolderPlan(path.join(m.tmp, 'hanging', 'notes')), /Refusing a symbolic link/);

  // A project he opens as /tmp/sample app.
  const sample = project(t); fs.cpSync(sample.root, path.join(m.tmp, 'sample app'), { recursive: true });
  const controller = autoApprove(new ProjectController(projectFolder(path.join(m.tmp, 'sample app'))));
  registerProject(controller.repo);
  assert.equal(controller.repo.root, m.on('private', 'tmp', 'sample app'));

  // A turn that edits in a worktree beside the project, the checks, and the reviewing bot's review.
  const edit = await controller.ask('Normalize coupon codes').finished;
  assert.equal(edit.state, 'ready', JSON.stringify(edit.error)); assert.equal(edit.error, null);
  assert.equal(edit.reviewStatus, 'passed'); assert.deepEqual(edit.reviews.map(review => review.role), ['bot:reviewer']);
  assert.ok(edit.worktree.startsWith(m.on('private', 'tmp') + path.sep), edit.worktree);
  assert.ok(edit.evidence.results.length > 0 && edit.evidence.results.every(row => row.status === 'passed'), JSON.stringify(edit.evidence.results));

  // A screenshot he attaches: CleanShot keeps its captures under ~/Library, and a screenshot
  // dragged from its thumbnail lies in the temp folder, /var/folders/…/T/TemporaryItems.
  fakeClis(m.home, { mode: 'answer' });
  const kept = picture(path.join(m.home, 'Library', 'Application Support', 'CleanShot', 'media', 'media_n8', 'CleanShot 2026-11-13 at 10.38.28@2x.png'));
  const dragged = picture(path.join(m.temp, 'TemporaryItems', 'NSIRD_screencaptureui_a1', 'Screenshot 2026-11-13 at 10.38.28.png'));
  const typed = `This screen looks wrong '${kept}' and ${dragged.replace(/ /g, '\\ ')}`;
  const seen = readablePictures(typed);
  assert.equal(seen.copied.length, 1, 'the one under ~/Library is copied where a session reads it'); assert.equal(seen.copied[0].from, kept);
  assert.equal(path.dirname(seen.copied[0].to), path.join(m.tempOnDisk, 'elu-code-pictures')); assert.deepEqual(fs.readFileSync(seen.copied[0].to), PNG);
  assert.ok(seen.text.includes(dragged.replace(/ /g, '\\ ')), 'the one in the temp folder is named as he wrote it');
  const asked = await controller.ask(seen.text).finished;
  assert.equal(asked.error ?? null, null); assert.equal(asked.state, 'answered');
  assert.ok(inputs(m.home).at(-1).input.includes(seen.copied[0].to), 'the turn was given the copy');
  // The same message to a teammate carries both pictures.
  const sent = attachPictures(typed);
  assert.deepEqual(sent.pictures.list.map(row => row.type), ['image/png', 'image/png']); assert.ok(!sent.text.includes(m.root), sent.text);

  // A standup: every open session is asked, each answers, and the Standup's model sums it up.
  let over = false; const loop = answering(controller, () => over);
  const standup = await controller.ask('/standup', null, { standup: true }).finished;
  over = true; await loop;
  assert.equal(standup.messages.filter(row => row.summary).length, 1, JSON.stringify(standup.messages.slice(-3)));
  assert.ok(standupReply(readTask(controller.repo, asked.id), standup.standup.rounds[0].round), 'the session answered the standup');

  // A schedule tick: the due schedule queues its run, and the login item is written as a Mac's.
  const now = new Date(2026, 10, 9, 8), row = saveSchedule({ root: controller.repo.root, goal: 'Check dependencies for updates', when: parseWhen('every 1h', now) }, now);
  let started = 0;
  assert.equal(runDue(new Date(2026, 10, 9, 10), { start: () => { started++; return true; } }), 1); assert.equal(started, 1);
  const queued = pendingRequests(controller.repo.root).find(request => request.scheduleId === row.id);
  assert.equal(queued?.state, 'queued'); assert.equal(listSchedules().find(value => value.id === row.id).note, null);
  const ran = await controller.ask(queued.goal, null, { scheduleId: row.id }).finished;
  assert.equal(ran.error ?? null, null);
  const calls = [], shims = path.join(m.temp, 'terminal-shims', 'abc'), shimsOnDisk = path.join(m.tempOnDisk, 'other-shims');
  const item = installScheduler({ platform: 'darwin', home: m.home, env: { ...process.env, PATH: [shims, shimsOnDisk, '/usr/bin', '/bin'].join(path.delimiter) }, run: (bin, args) => calls.push([bin, ...args]), lasting: true });
  assert.equal(item.installed, true); assert.deepEqual(item.files, [path.join(m.home, 'Library', 'LaunchAgents', 'dev.elu-code.scheduler.plist')]);
  const plist = fs.readFileSync(item.files[0], 'utf8');
  assert.ok(plist.includes('<string>/usr/bin:/bin</string>'), 'a PATH entry in the temp folder is left out under either of its names');
  assert.ok(calls.some(call => call[0] === 'launchctl' && call[1] === 'bootstrap'));

  // Nothing ELU wrote says a link was refused, and nothing of a run is left in the temp folder.
  assert.deepEqual(saysLink(personalDirectory()), []); assert.deepEqual(saysLink(controller.repo.state), []);
  for (const task of [edit, asked, standup, ran]) assert.doesNotMatch(JSON.stringify(readTask(controller.repo, task.id)), /symbolic link/i);
  assert.deepEqual(fs.readdirSync(m.tempOnDisk).filter(name => name.startsWith('elu-code-') && !/^elu-code-(pictures$|test-)/.test(name)), [], 'but the pictures folder and this test\'s own sample');
});

test('a scratch home made in the temp folder, as mktemp -d gives on a Mac, runs ELU: its state, stand-in commands, inbox and login items are under /var, which is a link', { timeout: 120000 }, async t => {
  const m = mac(t), scratch = path.join(m.temp, 'tmp.scratchhome'), onDisk = path.join(m.tempOnDisk, 'tmp.scratchhome');
  fs.mkdirSync(scratch);
  const fake = fakeClis(scratch, { mode: 'answer' });
  environment(t, { ...fake.env, ...GIT, HOME: scratch, TMPDIR: `${m.temp}/` });
  // ELU's state: before, every read and write of it ended "Refusing a symbolic link: …/var".
  const sample = project(t); fs.cpSync(sample.root, path.join(scratch, 'sample app'), { recursive: true });
  const controller = new ProjectController(projectFolder(path.join(scratch, 'sample app')));
  registerProject(controller.repo);
  const answered = await controller.ask('How are coupons normalized?').finished;
  assert.equal(answered.state, 'answered', JSON.stringify(answered.error));
  const state = path.join(onDisk, 'personal', 'elu-code'), named = path.join(scratch, 'personal', 'elu-code');
  assert.equal(personalDirectory(), state); assert.deepEqual(personalDirectoryNames(), [state, named]);
  // No session reads ELU's state, by either of the folder's names.
  const cwd = controller.repo.root, session = crypto.randomUUID();
  atomic(path.join(state, 'conformance', 'grok.json'), { v: 1, bin: path.join(fake.dir, 'grok'), version: '1.0.77', steps: Object.fromEntries(grok.conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });
  const launches = {
    claude: claude.compile({ mode: 'locked', role: readRole('claude'), cwd, protectedPaths: ['.git'], commonDir: controller.repo.common, session }),
    codex: codex.compile({ mode: 'ask', role: readRole('codex'), cwd, protectedPaths: ['.git'], commonDir: controller.repo.common, schemaFile: path.join(cwd, 'schema.json') }),
    agy: [JSON.stringify(agy.settingsFor('ask', { cwd, protectedPaths: ['.git'], commonDir: controller.repo.common }))],
    grok: grok.compile({ mode: 'ask', role: readRole('grok'), cwd, protectedPaths: ['.git'], session, runDir: path.join(onDisk, 'run') }),
  };
  for (const [vendor, args] of Object.entries(launches)) for (const dir of [state, named]) assert.ok(args.join('\n').includes(dir), `${vendor} closes ${dir}`);
  // A link inside ELU's own state is refused as before.
  fs.symlinkSync(m.home, path.join(personalDirectory(), 'planted'));
  assert.throws(() => atomic(path.join(personalDirectory(), 'planted', 'x.json'), {}), /Refusing a symbolic link/);
  // A schedule tick.
  const now = new Date(2026, 10, 9, 8), row = saveSchedule({ root: controller.repo.root, goal: 'Check dependencies for updates', when: parseWhen('every 1h', now) }, now);
  assert.equal(runDue(new Date(2026, 10, 9, 10), { start: () => true }), 1);
  assert.equal(listSchedules().find(value => value.id === row.id).note, null);
  assert.equal(pendingRequests(controller.repo.root).find(request => request.scheduleId === row.id)?.state, 'queued');
  // The stand-in commands of the never list, the inbox for files a teammate sends, and the login items.
  assert.equal(shimsBase(), path.join(onDisk, 'data', 'elu-code', 'never-list'));
  assert.ok(writeShims().startsWith(path.join(onDisk, 'data') + path.sep));
  assert.equal(inboxRoot(), path.join(onDisk, 'data', 'elu-code', 'inbox')); assert.equal(checkInbox(), inboxRoot());
  for (const platform of ['darwin', 'linux']) {
    const env = { ...process.env, PATH: '/usr/bin:/bin' }, files = schedulerFiles({ platform, home: scratch, env });
    assert.ok(files.every(file => file.startsWith(onDisk + path.sep)), files.join(' '));
    assert.equal(installScheduler({ platform, home: scratch, env, run: () => {}, lasting: true }).installed, true, platform);
    assert.ok(servicePath({ platform, home: scratch, env }).startsWith(onDisk + path.sep));
  }
  assert.deepEqual(saysLink(personalDirectory()), []);
});

// Grok Build and Antigravity in Full access run under a mirror of the owner's home, a folder of
// links kept in ELU's state (lib/home-mirror.mjs). A home made with mktemp -d on a Mac, ELU's
// state in it and the temp folder all lie under /var, which is a link.
for (const [vendor, name, version, say] of [['grok', 'Grok Build', '1.0.77', script => `Run the command ${script} then reply done with the summary "ran it".`], ['agy', 'Antigravity', '1.5.4', script => `Run this command: ${script}. Reply with the summary "headless".`]]) {
  test(`a home and a temp folder under /var, which is a link: a Full access command on ${name} reads the owner's sign-in under ~, and what it makes there is in his home`, { timeout: 120000 }, async t => {
    const m = mac(t), scratch = path.join(m.temp, 'tmp.scratchhome'), onDisk = path.join(m.tempOnDisk, 'tmp.scratchhome');
    fs.mkdirSync(scratch);
    const fake = fakeClis(scratch, { mode: 'answer' });
    environment(t, { ...fake.env, ...GIT, HOME: scratch, TMPDIR: `${m.temp}/` });
    fs.mkdirSync(path.join(scratch, '.grok')); fs.writeFileSync(path.join(scratch, '.grok', 'auth.json'), '{}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(scratch, '.npmrc'), 'owner-npm-token\n', { mode: 0o600 }); fs.mkdirSync(path.join(scratch, '.claude')); fs.writeFileSync(path.join(scratch, '.claude', 'CLAUDE.md'), 'his instructions\n');
    const sample = project(t); fs.cpSync(sample.root, path.join(scratch, 'sample app'), { recursive: true });
    const controller = new ProjectController(projectFolder(path.join(scratch, 'sample app'))); Object.assign(controller.draftConfig.roles.lead, { vendor, maxCostUsd: null });
    const state = path.join(onDisk, 'personal', 'elu-code'), named = path.join(scratch, 'personal', 'elu-code');
    assert.deepEqual(personalDirectoryNames(), [state, named]);
    atomic(path.join(state, 'conformance', `${vendor}.json`), { v: 1, bin: fs.realpathSync(path.join(fake.dir, vendor)), version, steps: Object.fromEntries({ grok, agy }[vendor].conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });
    // Before a Full access run has made Grok Build's mirror, a mode with rules closes it under both of the folder's names.
    if (vendor === 'grok') {
      const rules = grok.compile({ mode: 'ask', role: readRole('grok'), cwd: controller.repo.root, protectedPaths: ['.git'], session: crypto.randomUUID(), runDir: path.join(onDisk, 'run') });
      for (const dir of [state, named]) assert.equal(rules[rules.indexOf(`Read(${path.join(dir, 'grok-home-full')}/**)`) - 1], '--deny', dir);
    }
    const script = path.join(scratch, 'see.sh'), out = path.join(scratch, 'see.out');
    fs.writeFileSync(script, `#!/bin/sh\ncd ~ || exit 1\n{ cat .npmrc; printf '%s\\n' "$HOME"; [ -e .claude ] && echo "sees ~/.claude"; echo made > .made-in-run; } > ${JSON.stringify(out)} 2>&1\n`, { mode: 0o700 });
    const full = await controller.ask(say(script), null, { permissions: 'full' }).finished;
    assert.equal(full.state, 'answered', JSON.stringify(full.error));
    // ~ was the mirror, in ELU's state as it is on disk; his npm sign-in was read there and his Claude Code folder was not there.
    const [token, home, ...more] = fs.readFileSync(out, 'utf8').trim().split('\n');
    assert.equal(token, 'owner-npm-token'); assert.deepEqual(more, []);
    assert.ok(vendor === 'grok' ? home === path.join(state, 'grok-home-full') : home.startsWith(path.join(state, 'agy-home') + path.sep) && home.endsWith('-full'), home);
    assert.equal(fs.readlinkSync(path.join(home, '.npmrc')), `${scratch}${path.sep}.${path.sep}.npmrc`, 'each entry is a link to his, by the name his home has');
    // What the command made at the top of ~ is a file in his home once the run has ended, and a link in the mirror.
    assert.equal(fs.lstatSync(path.join(onDisk, '.made-in-run')).isFile(), true); assert.equal(fs.readFileSync(path.join(scratch, '.made-in-run'), 'utf8'), 'made\n');
    assert.equal(fs.lstatSync(path.join(home, '.made-in-run')).isSymbolicLink(), true);
    // Nothing ELU wrote says a link was refused.
    assert.deepEqual(saysLink(personalDirectory()), []); assert.deepEqual(saysLink(controller.repo.state), []);
    assert.doesNotMatch(JSON.stringify(readTask(controller.repo, full.id)), /symbolic link/i);
  });
}

test('what the owner set up through a link is read where it is: his Git hooks folder and a vendor\'s home', t => {
  const m = mac(t), { root } = project(t);
  environment(t, { HOME: m.home, XDG_CONFIG_HOME: path.join(m.home, '.config'), TMPDIR: `${m.temp}${path.sep}` });
  // His Git configuration names a hooks folder outside the project, through /tmp.
  const hooks = path.join(m.tmp, 'githooks'), onDisk = m.on('private', 'tmp', 'githooks');
  fs.mkdirSync(hooks); fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  git(root, ['config', 'core.hooksPath', hooks]);
  const repo = repository(root), safe = assertGitSafe(repo);
  assert.deepEqual(safe.hooks, [path.join(onDisk, 'pre-commit')]);
  assert.equal(assertGitSafe(repo, { expectedHooks: safe.hookDigest }).hookDigest, safe.hookDigest);
  // A link inside that folder is refused, and so is a hooks folder of the project that is a link.
  fs.symlinkSync(path.join(onDisk, 'pre-commit'), path.join(onDisk, 'pre-push'));
  assert.throws(() => assertGitSafe(repo), /Refusing a symbolic link: .*pre-push/);
  fs.unlinkSync(path.join(onDisk, 'pre-push'));
  fs.symlinkSync(onDisk, path.join(root, '.githooks')); git(root, ['config', 'core.hooksPath', '.githooks']);
  assert.throws(() => assertGitSafe(repo), /Refusing a symbolic link: .*\.githooks/);
  git(root, ['config', 'core.hooksPath', path.join(root, '.githooks')]);
  assert.throws(() => assertGitSafe(repo), /Refusing a symbolic link: .*\.githooks/);
  // A vendor's home kept under /var, and one that is a link to where he keeps his settings.
  const token = Buffer.from(JSON.stringify({ email: 'owner@example.invalid', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } })).toString('base64url');
  const claudeHome = path.join(m.temp, 'claude-home'), kept = path.join(m.home, 'settings', 'codex'), codexHome = path.join(m.home, '.codex');
  fs.mkdirSync(claudeHome); fs.writeFileSync(path.join(claudeHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'owner@example.invalid', planDisplayName: 'Max' } }));
  fs.mkdirSync(kept, { recursive: true }); fs.writeFileSync(path.join(kept, 'auth.json'), JSON.stringify({ tokens: { id_token: `x.${token}.y` } })); fs.symlinkSync(kept, codexHome);
  assert.equal(claudeAccount({ env: { HOME: m.home, CLAUDE_CONFIG_DIR: claudeHome } })?.email, 'owner@example.invalid');
  assert.deepEqual(codexAccount({ env: { HOME: m.home } }), { email: 'owner@example.invalid', plan: 'Pro' });
  // The file itself as a link is not read.
  fs.renameSync(path.join(kept, 'auth.json'), path.join(kept, 'elsewhere.json')); fs.symlinkSync(path.join(kept, 'elsewhere.json'), path.join(kept, 'auth.json'));
  assert.equal(codexAccount({ env: { HOME: m.home } }), null);
});
test('no file of ELU reads the temp folder but the one helper', () => {
  // os.tmpdir() is /var/folders/… on a Mac, a path with a link in it. lib/util.mjs reads it and
  // hands out the folder as it is on disk (systemTemp, tempFolder, systemTempNames).
  const root = fileURLToPath(new URL('..', import.meta.url)), found = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (/\.(mjs|cjs|js)$/.test(entry.name)) found.push(full); } };
  walk(path.join(root, 'lib')); walk(path.join(root, 'bin'));
  const reads = /\btmpdir\s*\(|\benv\.TMPDIR\b|\benv\[\s*['"]TMPDIR['"]\s*\]/;
  const lines = found.filter(file => path.relative(root, file) !== path.join('lib', 'util.mjs')).flatMap(file => fs.readFileSync(file, 'utf8').split('\n').map((line, index) => reads.test(line) ? `${path.relative(root, file)}:${index + 1}` : null).filter(Boolean));
  assert.deepEqual(lines, [], 'use systemTemp() or tempFolder(prefix) from lib/util.mjs');
});
