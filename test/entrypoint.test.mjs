import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CLI, command, temp } from './helpers.mjs';

test('the installed command runs through npm-style package and executable links', (t) => {
  const prefix = path.join(temp(t), 'user prefix');
  const scope = path.join(prefix, 'lib/node_modules/@elu-labs');
  const bin = path.join(prefix, 'bin');
  fs.mkdirSync(scope, { recursive: true });
  fs.mkdirSync(bin);
  fs.symlinkSync(path.dirname(path.dirname(CLI)), path.join(scope, 'elu'));
  const executable = path.join(bin, 'elu');
  fs.symlinkSync('../lib/node_modules/@elu-labs/elu/bin/elu-code.mjs', executable);

  const direct = command(process.execPath, [CLI, '--help'], prefix);
  const installed = command(executable, ['--help'], prefix);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /ELU/);
  assert.equal(installed.stdout, direct.stdout);
  assert.equal(installed.stderr, '');

  const json = command(executable, ['--help', '--json'], prefix);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).success, true);
  assert.match(JSON.parse(json.stdout).help, /Commands:/);
});
