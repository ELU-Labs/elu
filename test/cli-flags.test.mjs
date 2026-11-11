import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CLI, command, project, temp } from './helpers.mjs';

const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const run = (cwd, ...args) => command(process.execPath, [CLI, ...args], cwd);

test('--version prints the package version and nothing else', (t) => {
  const cwd = temp(t);
  const plain = run(cwd, '--version');
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, `${version}\n`);
  assert.equal(plain.stderr, '');

  const json = run(cwd, '--version', '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { success: true, version });

  // After a command too, so no command is started by a question about the version.
  const after = run(cwd, 'status', '--version');
  assert.equal(after.status, 0, after.stderr);
  assert.equal(after.stdout, `${version}\n`);
});

test('-h prints the help --help prints, alone or straight after a command', (t) => {
  const cwd = temp(t);
  const long = run(cwd, '--help');
  assert.equal(long.status, 0, long.stderr);
  assert.match(long.stdout, /Options:\n {2}--help, -h\n {2}--version\n/);

  for (const args of [['-h'], ['run', '-h'], ['-h', 'peers']]) {
    const short = run(cwd, ...args);
    assert.equal(short.status, 0, short.stderr);
    assert.equal(short.stdout, long.stdout, args.join(' '));
    assert.equal(short.stderr, '');
  }

  // Inside the words of a goal or a question it stays a word.
  const { parent, root } = project(t);
  const word = command(process.execPath, [CLI, 'nosuchcommand', 'the', '-h', 'flag'], root, { XDG_CONFIG_HOME: path.join(parent, 'personal') });
  assert.equal(word.status, 1);
  assert.match(word.stderr, /^Unknown command: nosuchcommand the -h flag\./);
});

test('an option nobody defined is refused with exit code 1', (t) => {
  const cwd = temp(t);
  for (const option of ['--versions', '--version=1', '--h']) {
    const refused = run(cwd, option);
    assert.equal(refused.status, 1, option);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /^Unknown option /);
  }
});
