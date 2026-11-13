import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shellSandbox, shellSandboxLine } from '../lib/sandbox.mjs';
import { project, fakeClis, cli, git } from './helpers.mjs';

// A folder of stand-in tools to put on PATH.
function tools(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elu-tools-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text, { mode: 0o755 });
  return dir;
}
const NONE = 'No OS sandbox here: commands ask you (Ask) or are reviewed (Approve for me).';
// The link has a line of its own, so a narrow terminal never breaks it.
const BLOCKED = ['The OS sandbox cannot start here, so commands ask you (Ask) or are reviewed (Approve for me). See:', 'https://github.com/ELU-Labs/elu/blob/main/docs/permissions.md#linux'];
// bwrap is started as Claude Code's sandbox starts it on Linux: its own user, network and
// process namespaces, the disk read-only, /dev and /proc of its own; around a command that does nothing.
const TRIAL = '--unshare-user --unshare-net --unshare-pid --ro-bind / / --dev /dev --proc /proc /bin/sh -c :';
const there = '#!/bin/sh\nexit 0\n';
// A stand-in bwrap that writes its arguments to log each time it is started and ends code.
const bwrap = (log, code) => `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexit ${code}\n`;
// One that makes every namespace but a user namespace, as bwrap does where user namespaces are
// turned off but it can still make the others: run as root, or installed setuid.
const noUser = log => `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nfor arg in "$@"; do [ "$arg" = --unshare-user ] && { echo 'bwrap: No permission to create new namespace, likely because the kernel does not allow non-privileged user namespaces.' >&2; exit 1; }; done\nexit 0\n`;
const on = dir => ({ platform: 'linux', env: { PATH: dir } });
const reader = log => () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];

test('on Linux the sandbox tool is really started: installed and unable to start is told apart from not installed', t => {
  const log = path.join(tools(t, {}), 'started'), started = reader(log);
  // Installed, and the system stops it from starting, as Ubuntu 24.04 does without a profile for it.
  const blocked = tools(t, { bwrap: bwrap(log, 1), socat: there });
  assert.equal(shellSandbox(on(blocked)), 'blocked'); assert.deepEqual(shellSandboxLine(shellSandbox(on(blocked))), BLOCKED);
  assert.deepEqual(started(), [TRIAL], 'bwrap was started once, as the sandbox starts it, around a command that does nothing');
  // Installed and able to start: nothing to say.
  const works = tools(t, { bwrap: bwrap(log, 0), socat: there });
  assert.equal(shellSandbox(on(works)), 'ok'); assert.deepEqual(shellSandboxLine('ok'), []); assert.equal(started().length, 2);
  // Not installed: neither tool, or only one of the two. Nothing is started.
  assert.equal(shellSandbox(on(tools(t, {}))), 'missing'); assert.equal(shellSandbox(on(tools(t, { bwrap: bwrap(log, 0) }))), 'missing'); assert.equal(shellSandbox(on(tools(t, { socat: there }))), 'missing');
  assert.deepEqual(shellSandboxLine('missing'), [NONE]); assert.equal(started().length, 2);
  // Anywhere else the vendor's sandbox is the system's own: nothing is started and nothing is said.
  assert.equal(shellSandbox({ platform: 'darwin', env: { PATH: blocked } }), 'ok'); assert.equal(started().length, 2);
});

// Where user namespaces are turned off, bwrap may still make a network namespace (run as root,
// or installed setuid), so a trial without one started and the sandbox counted as working. Claude
// Code's sandbox always makes a user namespace, so there it cannot start and runs nothing fenced.
test('a bwrap that can make every namespace but a user namespace cannot start the sandbox', t => {
  const log = path.join(tools(t, {}), 'started'), dir = tools(t, { bwrap: noUser(log), socat: there });
  assert.equal(shellSandbox(on(dir)), 'blocked'); assert.deepEqual(shellSandboxLine(shellSandbox(on(dir))), BLOCKED);
  assert.deepEqual(reader(log)(), [TRIAL]);
});

// The answer is kept for each bwrap program: the Permissions picker and every turn ask, and bwrap
// is started once. Another bwrap, or a new one put in its place, is started again.
test('bwrap is started once per program, and again for another one or a new one in its place', t => {
  const log = path.join(tools(t, {}), 'started'), started = reader(log);
  const first = tools(t, { bwrap: bwrap(log, 1), socat: there });
  for (let n = 0; n < 3; n++) assert.equal(shellSandbox(on(first)), 'blocked');
  assert.equal(started().length, 1, 'asked three times, started once');
  // The same program reached through a link is the same program.
  const linked = tools(t, { socat: there }); fs.symlinkSync(path.join(first, 'bwrap'), path.join(linked, 'bwrap'));
  assert.equal(shellSandbox(on(linked)), 'blocked'); assert.equal(started().length, 1);
  // Another program is started.
  const second = tools(t, { bwrap: bwrap(log, 0), socat: there });
  assert.equal(shellSandbox(on(second)), 'ok'); assert.equal(started().length, 2);
  // A new bwrap where the first one was, as an upgrade leaves it, is started again.
  fs.rmSync(path.join(first, 'bwrap')); fs.writeFileSync(path.join(first, 'bwrap'), `${bwrap(log, 0)}# a newer release\n`, { mode: 0o755 });
  assert.equal(shellSandbox(on(first)), 'ok'); assert.equal(started().length, 3);
  // A bwrap that is not on PATH any more is not installed, whatever was kept for it.
  fs.rmSync(path.join(first, 'bwrap')); assert.equal(shellSandbox(on(first)), 'missing'); assert.equal(started().length, 3);
});

// elu policy show lists what enforces each rule, the OS sandbox among them. Where the sandbox
// cannot start it says so, in the picker's words, and says nothing where it starts.
test('elu policy show says when the OS sandbox cannot start here, and nothing where it starts', { skip: process.platform !== 'linux' }, t => {
  const p = project(t), f = fakeClis(p.parent);
  assert.equal(cli(p.root, ['init', '--yes'], f.env).status, 0); git(p.root, ['add', '.']); git(p.root, ['commit', '-m', 'Configure checks']);
  const log = path.join(tools(t, {}), 'started');
  const show = dir => { const result = cli(p.root, ['policy', 'show'], { ...f.env, PATH: `${dir}${path.delimiter}${f.env.PATH}` }); assert.equal(result.status, 0, result.stdout + result.stderr); return result.json; };
  assert.deepEqual(show(tools(t, { bwrap: noUser(log), socat: there })).lines, BLOCKED);
  assert.deepEqual(show(tools(t, { bwrap: bwrap(log, 1), socat: there })).lines, BLOCKED);
  assert.deepEqual(show(tools(t, { bwrap: bwrap(log, 0), socat: there })).lines ?? [], []);
});
