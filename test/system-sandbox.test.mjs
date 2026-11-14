import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { checkSandbox, usableSandbox, checksCanRun, noSandboxLine, blockedSandboxLine, bwrapStarts, sandboxRun, probeSandbox, sandboxCommand, openRun } from '../lib/sandbox.mjs';
import { findBin } from '../lib/util.mjs';
import { repository, assertGitSafe, snapshotHooks, hooksSnapshotDigest, assertPublishingHooks } from '../lib/git.mjs';
import { temp, git, project } from './helpers.mjs';

// The sandbox a check runs in where Codex is not installed is the system's own: bubblewrap on
// Linux, sandbox-exec on macOS, with the limits Codex's sandbox gives. Each case runs with each
// of them that is here and starts.
const bwrap = process.platform === 'linux' ? findBin('bwrap') : null;
const SYSTEM = {
  bwrap: bwrap && bwrapStarts(bwrap) ? { kind: 'bwrap', bin: bwrap } : null,
  seatbelt: process.platform === 'darwin' && findBin('sandbox-exec') ? { kind: 'seatbelt', bin: findBin('sandbox-exec') } : null,
};
const HERE = Object.values(SYSTEM).find(Boolean) ?? null;
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// PATH as it is, without the named programs: each folder that holds one is replaced by a folder
// of links to the rest of it.
function pathWithout(t, names) {
  const parent = temp(t);
  return process.env.PATH.split(path.delimiter).filter(Boolean).map((folder, index) => {
    if (!names.some(name => fs.existsSync(path.join(folder, name)))) return folder;
    const links = path.join(parent, `without-${index}`); fs.mkdirSync(links);
    for (const name of fs.readdirSync(folder)) if (!names.includes(name)) { try { fs.symlinkSync(path.join(folder, name), path.join(links, name)); } catch { /* Left out. */ } }
    return links;
  }).join(path.delimiter);
}
// A folder of stand-in programs.
function tools(t, files) {
  const dir = temp(t);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text, { mode: 0o755 });
  return dir;
}

for (const [kind, sandbox] of Object.entries(SYSTEM)) {
  const skip = !sandbox && `${kind} is not here`;
  test(`${kind}: a check cannot write outside its folder, read the owner's files, reach the network, or change what is protected`, { skip }, async t => {
    const root = temp(t), cwd = path.join(root, 'worktree'); fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(cwd, '.elu-code')); fs.writeFileSync(path.join(cwd, '.elu-code/config.yaml'), 'sealed\n');
    fs.mkdirSync(path.join(cwd, 'deep')); fs.writeFileSync(path.join(cwd, 'deep/.env'), 'SECRET=1\n'); fs.writeFileSync(path.join(cwd, 'key.pem'), 'synthetic\n');
    fs.mkdirSync(path.join(root, '.ssh')); fs.writeFileSync(path.join(root, '.ssh/sentinel'), 'synthetic sentinel, not a credential\n');
    git(cwd, ['init', '--initial-branch=main']);
    const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'untouched\n');
    const server = net.createServer(socket => socket.end('forbidden'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const shared = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'].filter(dir => fs.existsSync(dir)).map(dir => path.join(dir, `elu-code-probe-${process.pid}`));
    t.after(() => { for (const file of shared) fs.rmSync(file, { force: true }); });
    const cases = [
      ...shared.map(file => [`shared-temp ${file}`, `require('fs').writeFileSync(${JSON.stringify(file)},'bad')`]),
      ['outside-write', `require('fs').writeFileSync(${JSON.stringify(outside)},'bad')`],
      ['outside-read', `require('fs').readFileSync(${JSON.stringify(outside)})`],
      ['ssh-read', `require('fs').readFileSync(${JSON.stringify(path.join(root, '.ssh/sentinel'))})`],
      ['check-edit', "require('fs').writeFileSync('.elu-code/config.yaml','bad')"],
      ['git-edit', "require('fs').writeFileSync('.git/config','bad')"],
      ['git-read', "require('fs').readFileSync('.git/config')"],
      ['env-read', "if(!require('fs').readFileSync('deep/.env','utf8').includes('SECRET'))process.exit(3)"],
      ['env-write', "require('fs').writeFileSync('deep/.env','bad')"],
      ['pem-read', "if(!require('fs').readFileSync('key.pem','utf8').includes('synthetic'))process.exit(3)"],
      ['network', `const s=require('net').connect(${server.address().port},'127.0.0.1');s.on('error',()=>process.exit(7));s.on('connect',()=>process.exit(0))`],
      ['planted-curl', `const r=require('child_process').spawnSync('curl',['--connect-timeout','1','http://127.0.0.1:${server.address().port}']);process.exit(r.status===0?0:8)`],
    ];
    for (const [name, script] of cases) {
      const r = await sandboxRun({ sandbox, cwd, protectedPaths: ['.elu-code', '.git'], program: process.execPath, args: ['-e', script], logFile: path.join(root, `${name.replace(/\W+/g, '-')}.log`), timeoutSeconds: 20 });
      assert.notEqual(r.code, 0, `${name} escaped the sandbox`); assert.equal(r.timedOut, false, name);
    }
    assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched\n'); assert.equal(fs.readFileSync(path.join(cwd, '.elu-code/config.yaml'), 'utf8'), 'sealed\n');
    assert.equal(fs.readFileSync(path.join(cwd, 'deep/.env'), 'utf8'), 'SECRET=1\n');
    for (const file of shared) assert.equal(fs.existsSync(file), false, file);
    // What it may do: write in its folder and its own temporary folder, and start a shell that finds node.
    const positive = await sandboxRun({ sandbox, cwd, protectedPaths: ['.elu-code', '.git'], program: '/bin/sh', args: ['-c', `node -e "require('fs').writeFileSync('allowed.txt','yes');require('fs').writeFileSync(require('path').join(process.env.TMPDIR,'owned'),'yes')"`], logFile: path.join(root, 'positive.log'), timeoutSeconds: 20 });
    assert.equal(positive.code, 0, fs.readFileSync(positive.stderrFile, 'utf8')); assert.equal(fs.readFileSync(path.join(cwd, 'allowed.txt'), 'utf8'), 'yes');
  });

  test(`${kind}: a worktree inside shared temp cannot write a sibling; a read-only one can read its source but only write private temp`, { skip }, async t => {
    const parent = fs.realpathSync(fs.mkdtempSync('/tmp/elu-code-sandbox-')); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const cwd = path.join(parent, 'worktree'); fs.mkdirSync(cwd); git(cwd, ['init', '--initial-branch=main']);
    const sibling = path.join(parent, 'sibling');
    const denied = await sandboxRun({ sandbox, cwd, program: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sibling)},'bad')`], logFile: path.join(parent, 'sibling.log') });
    assert.notEqual(denied.code, 0); assert.equal(fs.existsSync(sibling), false);
    const allowed = await sandboxRun({ sandbox, cwd, program: process.execPath, args: ['-e', "require('fs').writeFileSync(require('path').join(process.env.TMPDIR,'owned'),'yes');require('fs').writeFileSync('owned.txt','yes')"], logFile: path.join(parent, 'private-temp.log') });
    assert.equal(allowed.code, 0, fs.readFileSync(allowed.stderrFile, 'utf8')); assert.equal(fs.readFileSync(path.join(cwd, 'owned.txt'), 'utf8'), 'yes');
    const source = path.join(cwd, 'source.txt'); fs.writeFileSync(source, 'read-only source');
    const script = `const fs=require('fs'),path=require('path');if(fs.readFileSync('source.txt','utf8')!=='read-only source')process.exit(4);let denied=false;try{fs.writeFileSync(${JSON.stringify(source)},'bad')}catch{denied=true}if(!denied)process.exit(5);fs.writeFileSync(path.join(process.env.TMPDIR,'owned'),'yes');`;
    const run = await sandboxRun({ sandbox, cwd, writablePaths: [], program: process.execPath, args: ['-e', script], logFile: path.join(parent, 'read-only.log') });
    assert.equal(run.code, 0, fs.readFileSync(run.stderrFile, 'utf8')); assert.equal(fs.readFileSync(source, 'utf8'), 'read-only source');
  });

  test(`${kind}: it passes the proof every task starts with, and lets the network through when it is on`, { skip }, async t => {
    const result = await probeSandbox({}, sandbox); assert.equal(result.working, true); assert.equal(result.networkDenied, true);
    const root = temp(t), cwd = path.join(root, 'worktree'); fs.mkdirSync(cwd);
    const server = net.createServer(socket => socket.end('ok')); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
    const on = await sandboxRun({ sandbox, cwd, network: 'on', program: process.execPath, args: ['-e', `const s=require('net').connect(${server.address().port},'127.0.0.1');s.on('error',()=>process.exit(7));s.on('connect',()=>process.exit(0))`], logFile: path.join(root, 'on.log'), timeoutSeconds: 20 });
    assert.equal(on.code, 0, fs.readFileSync(on.stderrFile, 'utf8'));
  });
}

test('the sandbox is Codex where it is installed, else the system\'s own; with none, the line says so and how to get one', t => {
  const stub = '#!/bin/sh\nexit 0\n', node = fs.realpathSync(process.execPath);
  const both = tools(t, { codex: stub, bwrap: stub, 'sandbox-exec': stub }), system = tools(t, { bwrap: stub, 'sandbox-exec': stub }), none = tools(t, {});
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(checkSandbox({ PATH: both }, platform), { kind: 'codex', bin: fs.realpathSync(path.join(both, 'codex')) }, platform);
    assert.deepEqual(checkSandbox({ PATH: none, ELU_CODE_SANDBOX_HELPER: process.execPath }, platform), { kind: 'codex', bin: node }, 'the helper the owner names');
    assert.equal(checkSandbox({ PATH: none }, platform), null, platform);
  }
  assert.deepEqual(checkSandbox({ PATH: system }, 'linux'), { kind: 'bwrap', bin: fs.realpathSync(path.join(system, 'bwrap')) });
  assert.deepEqual(checkSandbox({ PATH: system }, 'darwin'), { kind: 'seatbelt', bin: fs.realpathSync(path.join(system, 'sandbox-exec')) });
  assert.throws(() => checkSandbox({ PATH: none, ELU_CODE_SANDBOX_HELPER: path.join(none, 'missing') }, 'linux'), /configured sandbox helper is missing/);
  // The line names the one step, in this computer's own package manager.
  assert.equal(noSandboxLine({ platform: 'linux', env: { PATH: tools(t, { dnf: stub }) } }), "This computer has no sandbox for the project's checks. Install bubblewrap: sudo dnf install bubblewrap, then type continue.");
  assert.equal(noSandboxLine({ platform: 'linux', env: { PATH: tools(t, { 'apt-get': stub }) } }), "This computer has no sandbox for the project's checks. Install bubblewrap: sudo apt install bubblewrap, then type continue.");
  assert.equal(noSandboxLine({ platform: 'darwin', what: "the project's pre-push hooks", then: 'try again' }), "This computer has no sandbox for the project's pre-push hooks. Install Codex: npm install --global @openai/codex, then try again.");
  assert.equal(blockedSandboxLine(), "Bubblewrap cannot start on this computer, so the project's checks cannot run in its sandbox. Load the AppArmor profile in ELU's docs/permissions.md (Linux), then type continue.");
});

test('a bubblewrap the system stops is told apart from none, and starts at the next try once fixed', { skip: process.platform !== 'linux' && 'bubblewrap is the Linux sandbox' }, t => {
  const dir = tools(t, { bwrap: '#!/bin/sh\nexit 1\n' }), env = { PATH: dir };
  assert.throws(() => usableSandbox({}, env), error => error.message === blockedSandboxLine());
  fs.writeFileSync(path.join(dir, 'bwrap'), '#!/bin/sh\nexit 0\n');
  assert.deepEqual(usableSandbox({}, env), { kind: 'bwrap', bin: fs.realpathSync(path.join(dir, 'bwrap')) }, 'a failed start is not kept');
});

test('checks in Full access, or no checks, need no sandbox; outside Full access a computer with none refuses before any work, plainly', async t => {
  environment(t, { PATH: pathWithout(t, ['codex', 'bwrap', 'sandbox-exec']), ELU_CODE_SANDBOX_HELPER: '' });
  const config = { checks: [{ name: 'test', command: ['npm', 'test'] }] };
  assert.equal(await checksCanRun(config, { mode: 'full', probe: true }), null);
  assert.equal(await checksCanRun({ checks: [] }, { mode: 'ask', probe: true }), null);
  for (const mode of ['locked', 'ask', 'auto']) await assert.rejects(checksCanRun(config, { mode }), error => error.message === noSandboxLine(), mode);
  // The same check in Full access runs as the owner's terminal would run it.
  const root = temp(t), cwd = path.join(root, 'worktree'); fs.mkdirSync(cwd);
  const run = await openRun({ cwd, program: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(root, 'outside'))},'mine')`], logFile: path.join(root, 'full.log') });
  assert.equal(run.code, 0, fs.readFileSync(run.stderrFile, 'utf8')); assert.equal(fs.readFileSync(path.join(root, 'outside'), 'utf8'), 'mine');
});

// A repository's push guard, which runs the source the agent may have edited.
function guarded(t) {
  const { root, parent } = project(t), repo = repository(root);
  fs.mkdirSync(path.join(root, '.githooks')); fs.writeFileSync(path.join(root, '.githooks/pre-push'), `#!/bin/sh\n${JSON.stringify(process.execPath)} src/guard.mjs\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'src/guard.mjs'), 'process.exit(0);\n'); git(root, ['config', 'core.hooksPath', '.githooks']); git(root, ['add', '.']); git(root, ['commit', '-m', 'Add a source hook']);
  const outside = path.join(parent, 'outside');
  fs.writeFileSync(path.join(root, 'src/guard.mjs'), `import fs from 'node:fs';fs.writeSync(2,'hook-write-attempted\\n');try{fs.writeFileSync(${JSON.stringify(outside)},'bad')}catch{process.exit(17)}\n`);
  const task = { id: '1', worktree: root, hookDigest: assertGitSafe(repo).hookDigest };
  const push = () => spawnSync(path.join(task.hooksDirectory, 'pre-push'), [], { cwd: root, input: '', encoding: 'utf8' });
  return { root, repo, task, outside, push };
}

test("without Codex, a push guard runs in the system's sandbox; in Full access with none", { skip: !HERE && 'no system sandbox here' }, t => {
  environment(t, { PATH: pathWithout(t, ['codex']), ELU_CODE_SANDBOX_HELPER: '' });
  const sandboxed = guarded(t);
  sandboxed.task.hooksDirectory = snapshotHooks(sandboxed.repo, sandboxed.task); sandboxed.task.hooksSnapshotDigest = hooksSnapshotDigest(sandboxed.task.hooksDirectory);
  assertPublishingHooks(sandboxed.repo, sandboxed.task);
  const denied = sandboxed.push();
  assert.match(denied.stderr, /hook-write-attempted/); assert.equal(denied.status, 17, denied.stderr); assert.equal(fs.existsSync(sandboxed.outside), false);
  const full = guarded(t);
  full.task.hooksDirectory = snapshotHooks(full.repo, full.task, { full: true }); full.task.hooksSnapshotDigest = hooksSnapshotDigest(full.task.hooksDirectory);
  const ran = full.push();
  assert.equal(ran.status, 0, ran.stderr); assert.equal(fs.readFileSync(full.outside, 'utf8'), 'bad', 'Full access runs the guard as Git would');
});

test('with no sandbox on the computer, a push guard outside Full access is refused plainly; a repository with none is not', t => {
  environment(t, { PATH: pathWithout(t, ['codex', 'bwrap', 'sandbox-exec']), ELU_CODE_SANDBOX_HELPER: '' });
  const { repo, task } = guarded(t);
  assert.throws(() => snapshotHooks(repo, task), error => error.message === noSandboxLine({ what: "the project's pre-push hooks", then: 'try again' }));
  const plain = project(t), plainRepo = repository(plain.root), plainTask = { id: '1', worktree: plain.root, hookDigest: assertGitSafe(plainRepo).hookDigest };
  plainTask.hooksDirectory = snapshotHooks(plainRepo, plainTask); plainTask.hooksSnapshotDigest = hooksSnapshotDigest(plainTask.hooksDirectory);
  assert.equal(assertPublishingHooks(plainRepo, plainTask), plainTask.hooksDirectory);
  assert.equal(spawnSync(path.join(plainTask.hooksDirectory, 'pre-push'), [], { cwd: plain.root, input: '', encoding: 'utf8' }).status, 0);
});

test('the command for each sandbox: Codex as before; the system\'s own finds the node ELU runs on last on PATH', t => {
  const root = temp(t), cwd = path.join(root, 'worktree'); fs.mkdirSync(cwd);
  const env = { PATH: '/nowhere' }, runtime = path.dirname(fs.realpathSync(process.execPath));
  const codex = sandboxCommand({ sandbox: { kind: 'codex', bin: process.execPath }, cwd, program: process.execPath, env });
  assert.equal(codex.args[0], 'sandbox'); assert.ok(codex.args.some(arg => arg.includes('network={enabled=false}'))); assert.equal(codex.env, env);
  for (const kind of ['bwrap', 'seatbelt']) {
    const command = sandboxCommand({ sandbox: { kind, bin: '/x' }, cwd, program: process.execPath, args: ['-v'], env });
    assert.equal(command.env.PATH, `/nowhere${path.delimiter}${runtime}`, kind); assert.deepEqual(command.args.slice(-2), [process.execPath, '-v'], kind);
  }
  assert.throws(() => sandboxCommand({ sandbox: { kind: 'other', bin: '/x' }, cwd, program: process.execPath }), /Choose a sandbox/);
  const profile = sandboxCommand({ sandbox: { kind: 'seatbelt', bin: '/x' }, cwd, program: process.execPath }).args[1];
  assert.match(profile, /^\(version 1\)\n\(allow default\)\n\(deny network\*\)\n/); assert.match(profile, /\(deny file-write\* \(require-not/);
  assert.doesNotMatch(sandboxCommand({ sandbox: { kind: 'seatbelt', bin: '/x' }, cwd, program: process.execPath, network: 'on' }).args[1], /deny network/);
  assert.ok(sandboxCommand({ sandbox: { kind: 'bwrap', bin: '/x' }, cwd, program: process.execPath }).args.includes('--unshare-net'));
  assert.ok(!sandboxCommand({ sandbox: { kind: 'bwrap', bin: '/x' }, cwd, program: process.execPath, network: 'on' }).args.includes('--unshare-net'));
});
