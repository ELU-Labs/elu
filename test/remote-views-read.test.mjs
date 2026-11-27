import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { peerHome } from './peer-helpers.mjs';
import { remoteSessions } from '../lib/peer/remote.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { atomic } from '../lib/util.mjs';

const MACHINE = 'a'.repeat(64);
const view = (id, title, lastAt) => ({ id, machine: MACHINE, createdAt: '2026-11-26T10:00:00.000Z', lastAt, seq: 1, state: 'idle', title, entries: [{ role: 'You', at: lastAt, text: title }] });
const save = row => atomic(peerFile('remote', 'view', `${row.id}.json`), row);
const byId = rows => new Map(rows.map(row => [row.id, row]));

test('the app reads a remote view again only when its file changed, and still sees every change, removal and refusal', t => {
  peerHome(t);
  const one = crypto.randomUUID(), two = crypto.randomUUID();
  save(view(one, 'first', '2026-11-26T11:00:00.000Z'));
  save(view(two, 'second', '2026-11-26T12:00:00.000Z'));

  const before = remoteSessions();
  assert.deepEqual(before.map(row => row.title), ['second', 'first'], 'newest first');
  const again = byId(remoteSessions());
  assert.equal(again.get(one), byId(before).get(one), 'an unchanged view is not parsed again');
  assert.equal(again.get(two), byId(before).get(two));

  // A save is a new file: the changed view is read again, the other is kept.
  save(view(one, 'first, renamed', '2026-11-26T13:00:00.000Z'));
  const changed = remoteSessions();
  assert.deepEqual(changed.map(row => row.title), ['first, renamed', 'second']);
  assert.equal(byId(changed).get(two), again.get(two));

  // A removed view is gone, and a broken one is left out until it is whole again.
  fs.rmSync(peerFile('remote', 'view', `${two}.json`));
  assert.deepEqual(remoteSessions().map(row => row.id), [one]);
  fs.writeFileSync(peerFile('remote', 'view', `${one}.json`), '{"id":');
  assert.deepEqual(remoteSessions(), []);
  save(view(one, 'whole again', '2026-11-26T14:00:00.000Z'));
  assert.deepEqual(remoteSessions().map(row => row.title), ['whole again']);

  // A view swapped for a link is refused, as a fresh read refuses it.
  const elsewhere = path.join(path.dirname(peerFile('remote')), 'elsewhere.json');
  fs.writeFileSync(elsewhere, JSON.stringify(view(one, 'linked', '2026-11-26T15:00:00.000Z')));
  fs.rmSync(peerFile('remote', 'view', `${one}.json`));
  fs.symlinkSync(elsewhere, peerFile('remote', 'view', `${one}.json`));
  assert.deepEqual(remoteSessions(), []);
});
