import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.mjs';
import { unitArgument, unitEnvironment } from '../lib/unit-file.mjs';
import { installScheduler } from '../lib/schedules.mjs';
import { installService } from '../lib/peer/index.mjs';

// What systemd does to one word of a unit file: the quotes come off and the escapes are
// undone, a doubled percent sign becomes one, and on a command line a doubled dollar sign
// becomes one. A percent or dollar sign left single would be expanded, and an escape systemd
// does not know would stay in the value, so the reader fails on either.
function read(word, command) {
  let text = '';
  if (word.startsWith('"')) {
    assert.ok(word.length > 1 && word.endsWith('"'), `the quotes close: ${word}`);
    const inner = word.slice(1, -1), known = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' };
    for (let at = 0; at < inner.length; at += 1) {
      if (inner[at] === '"') assert.fail(`a quote inside the word is escaped: ${word}`);
      if (inner[at] !== '\\') { text += inner[at]; continue; }
      at += 1; assert.ok(inner[at] in known, `only escapes systemd knows: ${word}`); text += known[inner[at]];
    }
  } else { assert.match(word, /^[^\s"'\;]+$/, `a bare word holds nothing to quote: ${word}`); text = word; }
  assert.doesNotMatch(word, /[\n\r]/, 'a word stays on one line');
  assert.doesNotMatch(text.replace(/%%/g, ''), /%/, `every percent sign is doubled: ${word}`); text = text.replace(/%%/g, '%');
  if (command) { assert.doesNotMatch(text.replace(/\$\$/g, ''), /\$/, `every dollar sign is doubled: ${word}`); text = text.replace(/\$\$/g, '$'); }
  return text;
}

test('a word in a unit file reads back as the text that was given', () => {
  const values = ['/usr/bin/node', '/opt/my node/bin', '/srv/100%/bin', '%h/bin', '/a/$HOME/b', '${PATH}', 'say "hi"', "it's", 'back\\slash', 'tick`s', 'two\nlines', 'tab\there', '%%', '$$', 'a;b', ''];
  for (const value of values) {
    assert.equal(read(unitArgument(value), true), value);
    const line = unitEnvironment('NAME', value);
    assert.ok(line.startsWith('Environment='));
    assert.equal(read(line.slice('Environment='.length), false), `NAME=${value}`);
  }
  assert.equal(unitArgument('/usr/bin/node'), '/usr/bin/node', 'a plain path is written bare');
  assert.equal(unitArgument('/srv/100%/bin'), '"/srv/100%%/bin"');
  assert.equal(unitArgument('/a/$HOME/b'), '"/a/$$HOME/b"', 'a dollar sign on a command line is doubled, never given a backslash');
  assert.equal(unitEnvironment('PATH', '/a b:/c$d:/e%f'), 'Environment="PATH=/a b:/c$d:/e%%f"', 'a dollar sign in a value is plain text');
});

test('both login services write a PATH that holds a space, a percent sign, a dollar sign and a quote', t => {
  const dir = temp(t), run = () => {};
  const PATH = ['/opt/my tools/bin', '/opt/100%/bin', '/opt/$x/bin', '/opt/q"uote/bin'].join(':');
  const expected = 'Environment="PATH=/opt/my tools/bin:/opt/100%%/bin:/opt/$x/bin:/opt/q\\"uote/bin"';
  const scheduler = installScheduler({ platform: 'linux', home: dir, env: { PATH, HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'config') }, run, lasting: true });
  const service = fs.readFileSync(scheduler.files[0], 'utf8').split('\n');
  assert.ok(service.includes(expected), service.join('\n'));
  const peer = installService({ platform: 'linux', home: dir, env: { PATH, XDG_CONFIG_HOME: path.join(dir, 'peer-config') }, run, lasting: true });
  const unit = fs.readFileSync(peer.file, 'utf8').split('\n');
  assert.ok(unit.includes(expected), unit.join('\n'));
  for (const text of [service, unit]) {
    const start = text.find(line => line.startsWith('ExecStart='));
    for (const word of start.slice('ExecStart='.length).split(' ')) if (!word.startsWith('"')) read(word, true);
    assert.doesNotMatch(text.join('\n'), /\\[$`]/, 'no backslash before a dollar sign or a backtick');
  }
});
