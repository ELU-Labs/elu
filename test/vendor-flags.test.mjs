import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeVersion } from '../lib/detect.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';

// A stand-in program: prints its version, prints help on the stream given, takes the flags it lists
// plus `takes`, and exits 2 on any other flag (as Grok Build does).
function program(t, { version, help, stream, takes = [], loose = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elu-flags-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tool');
  fs.writeFileSync(file, `#!${process.execPath}
const args = process.argv.slice(2), help = ${JSON.stringify(help)}, takes = ${JSON.stringify(takes)};
if (args.includes('--help')) { process.${stream}.write(help); process.exit(0); }
for (const arg of args) if (arg !== '--version' && !takes.includes(arg) && !help.includes(arg) && !${loose}) { process.stderr.write('error: unexpected argument ' + arg + '\\n'); process.exit(2); }
if (args.includes('--version')) { process.stdout.write(${JSON.stringify(version)} + '\\n'); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
  return { file, cwd: dir };
}
const listing = (flags) => `Usage:\n${flags.map((flag) => `  ${flag} <value>\n`).join('')}`;

test('Antigravity CLI help printed on stderr is read: 1.5.8 has every required flag', (t) => {
  const { file, cwd } = program(t, { version: '1.5.8', help: listing(ADAPTERS.agy.meta.flags), stream: 'stderr', loose: true });
  const row = probeVersion('agy', file, cwd, process.env, { check: true });
  assert.equal(row.supported, true, row.reason);
  assert.equal(row.release, '1.5.8');
  assert.equal(row.versionStatus, 'untested version');
});

test('Antigravity CLI help still lacking a flag on either stream is reported missing', (t) => {
  const { file, cwd } = program(t, { version: '1.5.8', help: listing(ADAPTERS.agy.meta.flags.filter((flag) => flag !== '--print-timeout')), stream: 'stderr', loose: true });
  const row = probeVersion('agy', file, cwd, process.env, { check: true });
  assert.equal(row.supported, false);
  assert.match(row.reason, /missing required flags: --print-timeout\.$/);
});

test('Grok Build 1.0.77 takes --no-auto-update without listing it in its help', (t) => {
  const listed = ADAPTERS.grok.meta.flags.filter((flag) => flag !== '--no-auto-update');
  const { file, cwd } = program(t, { version: 'grok 1.0.77 (50ca579fa996)', help: listing(listed), stream: 'stdout', takes: ['--no-auto-update'] });
  const row = probeVersion('grok', file, cwd, process.env, { check: true });
  assert.equal(row.supported, true, row.reason);
  assert.equal(row.release, '1.0.77');
});

test('a Grok Build that refuses --no-auto-update is still reported missing it', (t) => {
  const listed = ADAPTERS.grok.meta.flags.filter((flag) => flag !== '--no-auto-update');
  const { file, cwd } = program(t, { version: 'grok 1.0.99 (x)', help: listing(listed), stream: 'stdout' });
  const row = probeVersion('grok', file, cwd, process.env, { check: true });
  assert.equal(row.supported, false);
  assert.match(row.reason, /missing required flags: --no-auto-update\.$/);
});

test('only a flag named unlisted is tried by running it: another missing Grok flag stays missing', (t) => {
  const listed = ADAPTERS.grok.meta.flags.filter((flag) => flag !== '--prompt-file' && flag !== '--no-auto-update');
  const { file, cwd } = program(t, { version: 'grok 1.0.77 (x)', help: listing(listed), stream: 'stdout', takes: ['--no-auto-update', '--prompt-file'] });
  const row = probeVersion('grok', file, cwd, process.env, { check: true });
  assert.equal(row.supported, false);
  assert.match(row.reason, /missing required flags: --prompt-file\.$/);
});
