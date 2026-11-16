import test from 'node:test';
import assert from 'node:assert/strict';
import { errorLine, everyText, readArtifactLine, readData, readSharedArtifacts, sharedArtifacts } from '../lib/artifacts.mjs';

test('an artifact line reads its title, what it shows and its interval', () => {
  assert.deepEqual(readArtifactLine('Artifact: Chat eval · answered per surface · every 10 min'), { title: 'Chat eval', shows: 'answered per surface', every: 10 });
  assert.deepEqual(readArtifactLine('Artifact: none'), { none: true });
  assert.equal(everyText(120), 'every 2 h');
  assert.equal(everyText(null), 'no refresh');
});

test('data that ELU cannot draw is refused with what is wrong', () => {
  assert.deepEqual(readData('{"blocks":[{"kind":"score","label":"Answered","value":86.2,"unit":"%","target":85}]}').blocks[0].value, 86.2);
  assert.throws(() => readData('{"blocks":[{"kind":"score","label":"Answered","value":"86%"}]}'), /value is "86%", not a number/);
  assert.throws(() => readData('{"blocks":[{"kind":"pie"}]}'), /pie/);
  assert.throws(() => readData('not json'), /not JSON/);
});

test('a failed refresh says the line that names the error', () => {
  assert.equal(errorLine('node:fs:440\n    return binding.readFileUtf8(path, flags);\n\nError: ENOENT: no such file or directory'), 'Error: ENOENT: no such file or directory');
  assert.equal(errorLine('just one line'), 'just one line');
});

test('artifacts shared with another computer carry their data, never their script', () => {
  const rows = [{ title: 'Chat eval', shows: 'answered', every: 1, updates: [{ at: '2026-11-15T10:00:00.000Z', by: 'script', data: { blocks: [{ kind: 'note', text: 'Run 1' }] } }], script: '#!/bin/sh\ncat results.json', run: { at: '2026-11-15T10:01:00.000Z', ok: false, error: 'It ran past 60 seconds.' } }];
  const sent = sharedArtifacts(rows);
  assert.equal(sent[0].script, true);
  assert.ok(!JSON.stringify(sent).includes('results.json'));
  const read = readSharedArtifacts(JSON.parse(JSON.stringify(sent)));
  assert.equal(read[0].updates.length, 1);
  assert.equal(read[0].run.error, 'It ran past 60 seconds.');
});
