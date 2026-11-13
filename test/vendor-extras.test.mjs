import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.mjs';
import { EXTRA_TEXT, takesExtra, refuseExtra } from '../lib/vendor-extras.mjs';
import { personalDirectory } from '../lib/util.mjs';

// The option that makes a vendor's run show its work is given only to a program that holds
// its text. `claude <any flag> --version` exits 0 for a made-up flag (seen on 2.1.322), so a
// program cannot be asked: its file is read, once for each program.
function home(t) {
  const dir = temp(t), previous = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  return dir;
}
// A program file as a vendor ships one: megabytes that are not text, with its option names in it.
const filler = size => Buffer.alloc(size, 0x41);
const program = (file, parts) => { fs.writeFileSync(file, Buffer.concat(parts.map(part => typeof part === 'string' ? Buffer.from(part) : part)), { mode: 0o755 }); return file; };
const kept = () => JSON.parse(fs.readFileSync(path.join(personalDirectory(), 'vendor-extras.json'), 'utf8'));

test('a program is given its vendor\'s option only when its own file holds the text, wherever in the file that is', t => {
  const dir = home(t);
  for (const [vendor, text] of Object.entries(EXTRA_TEXT)) {
    assert.equal(takesExtra(vendor, program(path.join(dir, `${vendor}-with`), [filler(300000), text, filler(1000)])), true, `${vendor}: the text is there`);
    assert.equal(takesExtra(vendor, program(path.join(dir, `${vendor}-without`), [filler(300000), text.slice(0, -1), filler(1000)])), false, `${vendor}: all but its last letter is not the text`);
  }
  // The text across two pieces of a file read in pieces (4 MB each), and at its very end.
  const piece = 4 * 1024 * 1024;
  assert.equal(takesExtra('claude', program(path.join(dir, 'across'), [filler(piece - 9), '--thinking-display', filler(piece)])), true, 'across two pieces');
  assert.equal(takesExtra('claude', program(path.join(dir, 'at-end'), [filler(2 * piece + 77), '--thinking-display'])), true, 'at the end');
  assert.equal(takesExtra('claude', program(path.join(dir, 'large-without'), [filler(2 * piece + 77)])), false, 'a large program without it');
  // A script that starts the program from somewhere else cannot say: the option is given,
  // and a run that ends over it settles it (below). A long script is the program itself.
  assert.equal(takesExtra('claude', program(path.join(dir, 'launcher'), ['#!/bin/sh\nexec node "$(dirname "$0")/../lib/cli.js" "$@"\n'])), true, 'a launcher');
  assert.equal(takesExtra('claude', program(path.join(dir, 'script'), ['#!/usr/bin/env node\n', filler(300000)])), false, 'a program that is one long script');
  // Reached by a link, it is the program the link names.
  fs.symlinkSync(path.join(dir, 'claude-without'), path.join(dir, 'link'));
  assert.equal(takesExtra('claude', path.join(dir, 'link')), false);
  // Nothing to read, or a vendor with no such option: no option, and no error.
  assert.equal(takesExtra('claude', path.join(dir, 'missing')), false);
  assert.equal(takesExtra('claude', dir), false, 'a folder');
  assert.equal(takesExtra('agy', path.join(dir, 'claude-with')), false);
  assert.equal(takesExtra('claude', null), false);
});

test('a program is read once: the answer is kept for that file, and a new release is read again', t => {
  const dir = home(t), bin = program(path.join(dir, 'claude'), [filler(300000), '--thinking-display']), written = new Date(Date.UTC(2026, 10, 13, 10, 0, 0));
  fs.utimesSync(bin, written, written);
  assert.equal(takesExtra('claude', bin), true);
  const row = kept().claude; assert.deepEqual(Object.keys(row).sort(), ['has', 'mtimeMs', 'program', 'size']); assert.equal(row.program, bin); assert.equal(row.has, true);
  // The same size and time is the same program: its file is not read again.
  program(bin, [filler(300000), '--thinking-displaX']); fs.utimesSync(bin, written, written);
  assert.equal(takesExtra('claude', bin), true, 'kept');
  // An update writes a new file: read anew.
  fs.utimesSync(bin, written, new Date(written.getTime() + 5000));
  assert.equal(takesExtra('claude', bin), false, 'the new release does not hold it');
  assert.equal(kept().claude.has, false);
  // Each vendor has its own row, and a file that cannot be kept changes no answer.
  assert.equal(takesExtra('codex', program(path.join(dir, 'codex'), [filler(300000), 'model_reasoning_summary'])), true);
  assert.deepEqual(Object.keys(kept()).sort(), ['claude', 'codex']);
  fs.rmSync(personalDirectory(), { recursive: true }); fs.writeFileSync(personalDirectory(), 'not a folder');
  assert.equal(takesExtra('codex', path.join(dir, 'codex')), true); assert.equal(takesExtra('claude', bin), false);
  assert.doesNotThrow(() => refuseExtra('codex', path.join(dir, 'codex')));
});

test('a program that ended a run over the option is not given it again, until it is another program', t => {
  const dir = home(t), bin = program(path.join(dir, 'grok'), ['#!/bin/sh\nexec grok-real "$@"\n']);
  assert.equal(takesExtra('grok', bin), true, 'a launcher is given it');
  refuseExtra('grok', bin);
  assert.equal(takesExtra('grok', bin), false); assert.equal(kept().grok.refused, true);
  assert.equal(takesExtra('grok', bin), false, 'and stays so');
  // The next release is a new file.
  const stat = fs.statSync(bin); fs.utimesSync(bin, stat.atime, new Date(stat.mtimeMs + 5000));
  assert.equal(takesExtra('grok', bin), true); assert.equal(kept().grok.refused, undefined);
  // Refused before it was ever read: kept all the same.
  const other = program(path.join(dir, 'codex'), [filler(300000), 'model_reasoning_summary']);
  refuseExtra('codex', other); assert.equal(takesExtra('codex', other), false);
});
