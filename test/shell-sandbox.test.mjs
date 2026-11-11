import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shellSandbox, shellSandboxLine } from '../lib/sandbox.mjs';

// A folder of stand-in tools to put on PATH.
function tools(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elu-tools-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text, { mode: 0o755 });
  return dir;
}
const NONE = 'No OS sandbox here: commands ask you (Ask) or are reviewed (Approve for me).';
const BLOCKED = 'The OS sandbox cannot start here, so commands ask you (Ask) or are reviewed (Approve for me). See https://github.com/ELU-Labs/elu/blob/main/docs/permissions.md#linux';

test('on Linux the sandbox tool is really started: installed and unable to start is told apart from not installed', t => {
  // A stand-in bwrap writes its arguments here each time it is started.
  const log = path.join(tools(t, {}), 'started'), started = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  const bwrap = code => `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexit ${code}\n`, there = '#!/bin/sh\nexit 0\n';
  const on = dir => ({ platform: 'linux', env: { PATH: dir } });
  // Installed, and the system stops it from starting, as Ubuntu 24.04 does without a profile for it.
  const blocked = tools(t, { bwrap: bwrap(1), socat: there });
  assert.equal(shellSandbox(on(blocked)), 'blocked'); assert.deepEqual(shellSandboxLine(shellSandbox(on(blocked))), [BLOCKED]);
  assert.deepEqual(started(), Array(2).fill('--unshare-net --ro-bind / / /bin/sh -c :'), 'bwrap was started, around a command that does nothing');
  // Installed and able to start: nothing to say.
  const works = tools(t, { bwrap: bwrap(0), socat: there });
  assert.equal(shellSandbox(on(works)), 'ok'); assert.deepEqual(shellSandboxLine('ok'), []); assert.equal(started().length, 3);
  // Not installed: neither tool, or only one of the two. Nothing is started.
  assert.equal(shellSandbox(on(tools(t, {}))), 'missing'); assert.equal(shellSandbox(on(tools(t, { bwrap: bwrap(0) }))), 'missing'); assert.equal(shellSandbox(on(tools(t, { socat: there }))), 'missing');
  assert.deepEqual(shellSandboxLine('missing'), [NONE]); assert.equal(started().length, 3);
  // Anywhere else the vendor's sandbox is the system's own: nothing is started and nothing is said.
  assert.equal(shellSandbox({ platform: 'darwin', env: { PATH: blocked } }), 'ok'); assert.equal(started().length, 3);
});
