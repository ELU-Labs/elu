import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { peerHome, newHome, withHome, makeTeam, registeredProject } from './peer-helpers.mjs';
import { git, keyLike } from './helpers.mjs';
import { registerProject } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { canonical, sign, verify, publicKeyHex, base32, unbase32 } from '../lib/peer/canonical.mjs';
import { createIdentity, loadIdentity, identity, renameIdentity, exportIdentity, importIdentity } from '../lib/peer/identity.mjs';
import { makeOp, validateOp, opProblem, fold, createTeam, readLog, team, teams, appendOp, head, merge, opsMissing, teamPath, setChannel, leaveOp, removeOp, latestAdmit } from '../lib/peer/roster.mjs';
import { RETRY_MS, SCRYPT, admitProven, checkInviterProof, checkJoinerProof, createInvite, inviteKeys, inviteKeysAsync, inviterProof, joinerProof, openInvites, parseInvite, redeemCode, redeemInvite } from '../lib/peer/invite.mjs';
import { ALPHABET, newCode, readCode } from '../lib/peer/invite-code.mjs';
import { shares, share, unshare, repoId, shareFor, normalizeRemote, teamProjects, setTeamProject, teamShare, forgetTeam } from '../lib/peer/shares.mjs';
import { scanSecrets, redactPaths, prepareOutgoing } from '../lib/peer/secrets.mjs';
import { DEFAULT_PEER_POLICY, DEFAULT_PEER_SETTINGS, defaultBox, peerBox, peerPolicy, peerSettings, savePeerPolicy, savePeerSettings } from '../lib/peer/settings.mjs';

const mode = file => fs.statSync(file).mode & 0o777;
// A signer without an identity file, for building other people's ops.
const signer = (name = 'x') => { const seed = crypto.randomBytes(32); return { name, key: publicKeyHex(seed), seed }; };
// Builds an op at an exact time with the documented id/sig formula, independent of makeOp.
function opAt(who, teamId, type, body, at) {
  const id = crypto.createHash('sha256').update(canonical({ teamId: type === 'create' ? '' : teamId, type, by: who.key, at, body })).digest('hex');
  const op = { id, teamId: type === 'create' ? id : teamId, type, by: who.key, at, body };
  return { ...op, sig: sign(who.seed, op) };
}
const invite = () => crypto.randomBytes(32).toString('hex');
const admit = (by, teamId, who, at, role = 'member') => opAt(by, teamId, 'admit', { key: who.key, name: who.name, role, invite: invite() }, at);
// A channel op by one signer; channel ids are 16 hex characters.
const hex16 = n => n.toString(16).padStart(16, '0');
const channelOp = (by, teamId, id, name, members, at) => opAt(by, teamId, 'channel', { id, name, members: members.map(m => m.key) }, at);
const refusal = (state, op) => state.rejected.find(r => r.id === op.id)?.reason ?? null;
const shuffle = list => { const out = [...list]; for (let i = out.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; } return out; };
const view = state => ({ ...state, rejected: state.rejected.map(r => r.id).sort() });

// canonical.mjs

test('canonical JSON sorts keys at every level and has no whitespace', () => {
  assert.equal(canonical({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  assert.equal(canonical({ é: 'ü', a: 'line\n"q"' }), '{"a":"line\\n\\"q\\"","é":"ü"}');
  assert.equal(canonical([]), '[]'); assert.equal(canonical({}), '{}'); assert.equal(canonical(Object.create(null)), '{}');
});
test('canonical JSON refuses values JSON would drop or rewrite', () => {
  const deep = []; let cursor = deep; for (let i = 0; i < 40; i++) { const next = []; cursor.push(next); cursor = next; }
  for (const value of [undefined, () => 1, NaN, Infinity, -Infinity, 10n, Symbol('x'), new Date(), Buffer.from('a'), { a: undefined }, [1, , 3], { a: NaN }, new Map(), deep]) {
    assert.throws(() => canonical(value), /Signed data/, String(typeof value));
  }
});
test('ed25519 signatures verify and fail on any tampering', () => {
  const a = signer(), b = signer(), value = { x: 1, y: ['a'] }, sig = sign(a.seed, value);
  assert.match(sig, /^[0-9a-f]{128}$/);
  assert.equal(verify(a.key, value, sig), true);
  assert.equal(verify(a.key, { y: ['a'], x: 1 }, sig), true, 'key order does not matter');
  assert.equal(verify(a.key, { x: 2, y: ['a'] }, sig), false);
  assert.equal(verify(b.key, value, sig), false);
  assert.equal(verify(a.key, value, sig.replace(/^./, c => c === '0' ? '1' : '0')), false);
  for (const bad of [null, '', 'zz', sig.toUpperCase(), sig + '00']) assert.equal(verify(a.key, value, bad), false);
  assert.equal(verify('not-a-key', value, sig), false);
  assert.equal(verify(a.key, { x: undefined }, sig), false);
  assert.throws(() => sign(Buffer.alloc(31), value), /32 bytes/);
});
test('the signing seed gives the same public key as hyperdht', async (t) => {
  let DHT; try { DHT = (await import('hyperdht')).default; } catch { return t.skip('hyperdht is not installed'); }
  const seed = crypto.randomBytes(32);
  assert.equal(DHT.keyPair(seed).publicKey.toString('hex'), publicKeyHex(seed));
});
test('base32 matches RFC 4648 and decodes strictly', () => {
  const vectors = { '': '', f: 'my', fo: 'mzxq', foo: 'mzxw6', foob: 'mzxw6yq', fooba: 'mzxw6ytb', foobar: 'mzxw6ytboi' };
  for (const [plain, coded] of Object.entries(vectors)) { assert.equal(base32(Buffer.from(plain)), coded); assert.equal(unbase32(coded).toString(), plain); }
  const random = crypto.randomBytes(77); assert.deepEqual(unbase32(base32(random)), random);
  for (const bad of ['MZXW6', 'mzxw6===', 'mz', 'm', 'mzx', 'mzxw6y', 'mzxw1', 'mzxw 6', null]) assert.equal(unbase32(bad), null, String(bad));
});

// identity.mjs

test('an identity is created once, stored 0600, and never exposes the seed', (t) => {
  peerHome(t);
  assert.equal(loadIdentity(), null);
  assert.throws(() => identity(), /Create your peer identity/);
  const me = createIdentity({ name: 'ana' });
  assert.match(me.key, /^[0-9a-f]{64}$/); assert.equal(me.fingerprint, me.key.slice(0, 8)); assert.equal(me.name, 'ana');
  assert.equal(me.seed.length, 32);
  assert.equal(publicKeyHex(me.seed), me.key);
  const text = JSON.stringify(me), stored = JSON.parse(fs.readFileSync(peerFile('identity.json'), 'utf8'));
  assert.ok(!text.includes(stored.seed) && !('seed' in { ...me }));
  assert.deepEqual(Object.keys(stored).sort(), ['createdAt', 'name', 'seed', 'version']);
  assert.equal(stored.version, 1); assert.equal(Buffer.from(stored.seed, 'base64').length, 32);
  assert.equal(mode(peerFile('identity.json')), 0o600); assert.equal(mode(peerFile()), 0o700);
  assert.throws(() => createIdentity({ name: 'other' }), /already exists/);
  assert.equal(identity().key, me.key);
});
test('identity names are 1 to 40 printable characters', (t) => {
  peerHome(t);
  for (const name of ['', ' ana', 'ana ', 'a'.repeat(41), 'a\nb', 'a\x1b[31m', 'a‮b', 'a​b', 42, undefined]) assert.throws(() => createIdentity({ name }), /1 to 40 printable/, JSON.stringify(name));
  createIdentity({ name: 'Ünïcode name ✓' });
  const renamed = renameIdentity('sara k'); assert.equal(renamed.name, 'sara k'); assert.equal(identity().name, 'sara k');
  assert.equal(mode(peerFile('identity.json')), 0o600);
  assert.throws(() => renameIdentity('x'.repeat(41)), /1 to 40/);
});
test('a damaged identity file is refused, not used', (t) => {
  peerHome(t); createIdentity({ name: 'ana' });
  const file = peerFile('identity.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const broken of [{ ...saved, seed: 'short' }, { ...saved, version: 2 }, { ...saved, extra: 1 }]) {
    fs.writeFileSync(file, JSON.stringify(broken)); assert.throws(() => loadIdentity(), /invalid/);
  }
  // A file an earlier build saved carries a field this build does not use: it loads, and the next save drops the field.
  fs.writeFileSync(file, JSON.stringify({ ...saved, nostrSecret: 'ab'.repeat(32) })); assert.equal(loadIdentity().name, 'ana');
  renameIdentity('ana k'); assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['createdAt', 'name', 'seed', 'version']);
  fs.writeFileSync(file, '{nope'); assert.throws(() => loadIdentity(), /unreadable/);
  fs.rmSync(file); fs.symlinkSync(path.join(os.tmpdir(), 'elsewhere.json'), file);
  assert.throws(() => loadIdentity(), /symbolic link/);
});
test('an exported identity imports to the same keys on another machine', (t) => {
  const first = newHome(t), second = newHome(t);
  const { me, code } = withHome(first, () => { const me = createIdentity({ name: 'ana' }); return { me, code: exportIdentity() }; });
  assert.match(code, /^elu-id:v1:[a-z2-7]+$/);
  assert.ok(!code.includes(Buffer.from(me.seed).toString('base64')));
  withHome(second, () => {
    const imported = importIdentity(code);
    assert.equal(imported.key, me.key); assert.equal(imported.name, 'ana');
    assert.deepEqual(imported.seed, me.seed); assert.equal(mode(peerFile('identity.json')), 0o600);
    assert.throws(() => importIdentity(code), /already exists/);
  });
  withHome(first, () => {
    const other = withHome(newHome(t), () => { createIdentity({ name: 'sara' }); return exportIdentity(); });
    assert.equal(importIdentity(other, { replace: true }).name, 'sara');
  });
  const body = code.slice('elu-id:v1:'.length), flip = c => (c === 'a' ? 'b' : 'a');
  for (const bad of [code.toUpperCase(), `elu-id:v2:${body}`, `elu-id:v1:${body.slice(0, -3)}${flip(body.at(-3))}${body.slice(-2)}`, `elu-id:v1:${body}a`, 'elu-id:v1:',
    `elu-id:v1:${base32(Buffer.from(canonical({ seed: Buffer.alloc(32).toString('base64'), name: 'x', extra: 1 })))}`,
    `elu-id:v1:${base32(Buffer.from(JSON.stringify({ seed: crypto.randomBytes(32).toString('base64'), name: 'x' }, null, 1)))}`, 42]) {
    withHome(newHome(t), () => assert.throws(() => importIdentity(bad), /not valid/));
  }
  // A code an earlier build exported carries a field this build does not use: it still imports to the same key.
  const older = `elu-id:v1:${base32(Buffer.from(canonical({ seed: Buffer.from(me.seed).toString('base64'), nostrSecret: 'ab'.repeat(32), name: 'ana' })))}`;
  withHome(newHome(t), () => assert.equal(importIdentity(older).key, me.key));
});

// roster.mjs

test('a created team folds to its founder and stores one signed op per line', (t) => {
  peerHome(t);
  const me = createIdentity({ name: 'ana' }), state = createTeam(me, 'core');
  assert.match(state.id, /^[0-9a-f]{64}$/);
  assert.equal(state.name, 'core'); assert.equal(state.founder, me.key); assert.deepEqual(state.relays, []); assert.deepEqual(state.rejected, []);
  assert.deepEqual(state.members.map(m => [m.key, m.name, m.role, m.removed]), [[me.key, 'ana', 'admin', false]]);
  const lines = fs.readFileSync(teamPath(state.id, 'log.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const op = JSON.parse(lines[0]);
  assert.equal(op.id, state.id); assert.equal(op.teamId, state.id); assert.equal(op.type, 'create');
  assert.equal(op.id, crypto.createHash('sha256').update(canonical({ teamId: '', type: 'create', by: me.key, at: op.at, body: op.body })).digest('hex'));
  assert.equal(verify(me.key, { id: op.id, teamId: op.teamId, type: op.type, by: op.by, at: op.at, body: op.body }, op.sig), true);
  assert.deepEqual(teams().map(x => x.id), [state.id]);
  assert.deepEqual(head(state.id), { seq: 1, head: crypto.createHash('sha256').update(state.id).digest('hex') });
  assert.throws(() => createTeam(me, ''), /team name/);
});
test('tampered ops are rejected by validation and by the fold', () => {
  const founder = signer('ana'), create = opAt(founder, '', 'create', { name: 'core', founderName: 'ana' }, 1000), teamId = create.id;
  const good = admit(founder, teamId, signer('sara'), 2000);
  assert.equal(opProblem(good), null); assert.equal(validateOp(good), good);
  const tampered = {
    body: { ...good, body: { ...good.body, role: 'admin' } },
    at: { ...good, at: good.at + 1 },
    by: { ...good, by: signer().key },
    sig: { ...good, sig: sign(signer().seed, { x: 1 }) },
    id: { ...good, id: 'f'.repeat(64) },
    type: { ...good, type: 'remove' },
    extra: { ...good, note: 'hi' },
    missing: (({ sig, ...rest }) => rest)(good),
    teamId: { ...good, teamId: '../../etc' },
    createTeam: { ...create, teamId: 'a'.repeat(64) },
    body2: { ...good, body: { ...good.body, extra: true } },
    time: { ...good, at: -1 },
    huge: opAt(founder, teamId, 'admit', { key: signer().key, name: 'x'.repeat(5000), role: 'member', invite: invite() }, 3000),
  };
  for (const [name, op] of Object.entries(tampered)) {
    assert.notEqual(opProblem(op), null, name);
    assert.throws(() => validateOp(op), undefined, name);
  }
  for (const junk of [null, 1, 'x', [], { teamId }]) assert.notEqual(opProblem(junk), null);
  const state = fold([create, good, ...Object.values(tampered), null]);
  assert.equal(state.members.length, 2);
  assert.equal(state.rejected.length, Object.keys(tampered).length + 1);
});
test('the fold gives the same state for any order of the same ops', () => {
  const ana = signer('ana'), bob = signer('bob'), cat = signer('cat'), dan = signer('dan');
  const create = opAt(ana, '', 'create', { name: 'core', founderName: 'ana' }, 1000), id = create.id;
  const ops = [create, admit(ana, id, bob, 1100, 'admin'), admit(bob, id, cat, 1200), opAt(ana, id, 'relays', { keys: [dan.key] }, 1250),
    opAt(bob, id, 'role', { key: cat.key, role: 'admin' }, 1300), admit(cat, id, dan, 1400), opAt(dan, id, 'leave', {}, 1500), opAt(ana, id, 'remove', { key: bob.key }, 1500)];
  const expected = view(fold(ops));
  assert.deepEqual(expected.rejected, []);
  assert.deepEqual(expected.members.map(m => [m.name, m.role, m.removed]), [['ana', 'admin', false], ['bob', 'admin', true], ['cat', 'admin', false], ['dan', 'member', true]]);
  assert.deepEqual(expected.relays, [dan.key]);
  for (let i = 0; i < 20; i++) assert.deepEqual(view(fold(shuffle([...ops, ...ops.slice(0, 3)]))), expected);
  // Equal times are ordered by id, so concurrent ops still fold the same everywhere.
  const tie = [create, admit(ana, id, bob, 2000, 'admin'), opAt(ana, id, 'remove', { key: bob.key }, 3000), admit(bob, id, cat, 3000)];
  assert.deepEqual(view(fold(tie)), view(fold([...tie].reverse())));
});
test('authority: only admins change the roster and members may only leave', () => {
  const ana = signer('ana'), bob = signer('bob'), cat = signer('cat'), eve = signer('eve');
  const create = opAt(ana, '', 'create', { name: 'core', founderName: 'ana' }, 1000), id = create.id;
  const bobIn = admit(ana, id, bob, 1100);
  const rules = [
    [admit(bob, id, cat, 1200), 'not an admin'],
    [opAt(bob, id, 'role', { key: bob.key, role: 'admin' }, 1210), 'not an admin'],
    [opAt(bob, id, 'relays', { keys: [] }, 1220), 'not an admin'],
    [opAt(eve, id, 'leave', {}, 1230), 'not a member'],
    [admit(eve, id, eve, 1240, 'admin'), 'not a member'],
    [opAt(ana, id, 'remove', { key: ana.key }, 1250), 'founder cannot be removed'],
    [opAt(ana, id, 'role', { key: ana.key, role: 'member' }, 1260), 'founder cannot be given'],
    [opAt(ana, id, 'leave', {}, 1270), 'founder cannot leave'],
    [opAt(ana, id, 'remove', { key: eve.key }, 1280), 'not a member'],
    [admit(ana, id, bob, 1290), 'already a member'],
    [admit(ana, id, signer(), 900), 'does not exist yet'],
    [opAt(ana, '', 'create', { name: 'again', founderName: 'ana' }, 1300), 'another team'],
  ];
  const state = fold([create, bobIn, ...rules.map(([op]) => op)], id);
  for (const [op, reason] of rules) assert.match(state.rejected.find(r => r.id === op.id)?.reason ?? '', new RegExp(reason), reason);
  assert.deepEqual(state.members.map(m => m.name), ['ana', 'bob']);
  const left = fold([create, bobIn, opAt(bob, id, 'leave', {}, 1500)]);
  assert.equal(left.members[1].removed, true); assert.equal(left.members[1].left, true);
});
test('removal wins until an admin admits the key again, and nothing it signs while out applies', () => {
  const ana = signer('ana'), bob = signer('bob'), cat = signer('cat'), dan = signer('dan');
  const create = opAt(ana, '', 'create', { name: 'core', founderName: 'ana' }, 1000), id = create.id;
  const base = [create, admit(ana, id, bob, 1100, 'admin'), admit(ana, id, cat, 1150)];
  const removeBob = opAt(ana, id, 'remove', { key: bob.key }, 2000);
  // Out from 2000 to 3000: what bob signs dated in between does not apply, admin or not.
  const lateAdmit = admit(bob, id, dan, 2100), lateRemove = opAt(bob, id, 'remove', { key: cat.key }, 2200), lateChannel = channelOp(bob, id, hex16(1), 'out', [bob], 2900);
  const catLeaves = opAt(cat, id, 'leave', {}, 2500), catOut = channelOp(cat, id, hex16(2), 'gone', [cat], 2600);
  // A new admit brings each back: bob as a plain member now, cat as an admin.
  const readmit = admit(ana, id, bob, 3000), afterLeave = admit(ana, id, cat, 3100, 'admin');
  // Back, bob holds the role the new admit gave: a channel of his own applies, an admit does not.
  const bobChannel = channelOp(bob, id, hex16(3), 'back', [bob], 3200), bobAdmits = admit(bob, id, dan, 3300), catAdmits = admit(cat, id, dan, 3400);
  const ops = [...base, removeBob, lateAdmit, lateRemove, lateChannel, catLeaves, catOut, readmit, afterLeave, bobChannel, bobAdmits, catAdmits];
  const state = fold(ops);
  for (const op of [lateAdmit, lateRemove, lateChannel, catOut]) assert.match(refusal(state, op), /was removed/);
  assert.match(refusal(state, bobAdmits), /not an admin/);
  for (const op of [removeBob, catLeaves, readmit, afterLeave, bobChannel, catAdmits]) assert.equal(refusal(state, op), null);
  assert.deepEqual(state.members.map(m => [m.name, m.role, m.removed, m.left, m.joinedAt]), [['ana', 'admin', false, false, 1000], ['bob', 'member', false, false, 3000], ['cat', 'admin', false, false, 3100], ['dan', 'member', false, false, 3400]]);
  assert.deepEqual(state.channels.map(row => row.name), ['back']);
  // The same in any order.
  for (let i = 0; i < 10; i++) assert.deepEqual(view(fold(shuffle(ops))), view(state));
  // An admin's op made before the removal still applies, and so does it after a return.
  const early = admit(bob, id, dan, 1900);
  assert.ok(fold([...base, removeBob, early]).members.some(m => m.key === dan.key && !m.removed));
  assert.ok(fold([...base, removeBob, early, readmit]).members.some(m => m.key === dan.key && !m.removed));
  // Out again after coming back, and back again: the latest admit is the one that counts.
  const twice = [...ops, opAt(ana, id, 'remove', { key: bob.key }, 4000), admit(ana, id, bob, 5000, 'admin')];
  assert.deepEqual(fold(twice).members.find(m => m.key === bob.key), { key: bob.key, name: 'bob', role: 'admin', removed: false, left: false, joinedAt: 5000 });
  assert.equal(latestAdmit(twice, bob.key).at, 5000);
  // Still on the team: an admit of them is refused, and the founder can neither leave nor be removed.
  const again = fold([...base, admit(ana, id, bob, 1200), opAt(ana, id, 'remove', { key: ana.key }, 1300), opAt(ana, id, 'leave', {}, 1400)]);
  assert.deepEqual(again.rejected.map(row => row.reason), ['The key is already a member.', 'The founder cannot be removed.', 'The founder cannot leave the team.']);
});
test('merge: a returning member cannot backdate an op to before it went out, nor date one into the window', (t) => {
  const { teamId, founder, member } = makeTeam(t);
  // Times just ahead of the team's own ops, inside the 10 minutes merge allows.
  const T = Date.now() + 1000, sara = member.identity, ana = founder.identity;
  const at = (op) => withHome(founder.home, () => appendOp(teamId, op)).op;
  at(opAt(ana, teamId, 'role', { key: sara.key, role: 'admin' }, T));
  const removal = at(opAt(ana, teamId, 'remove', { key: sara.key }, T + 1000));
  // Out: nothing of hers is taken, whatever its date.
  const puppet = signer('puppet');
  for (const when of [T + 500, T + 1500, T + 9000]) assert.match(withHome(founder.home, () => merge(teamId, [admit(sara, teamId, puppet, when, 'admin')])).rejected[0].reason, /was removed/);
  at(opAt(ana, teamId, 'admit', { key: sara.key, name: 'sara', role: 'member', invite: invite() }, T + 5000));
  // Back as a member: an admin op dated to when she was an admin, one in the window, and one now as a member are all refused.
  const backdated = admit(sara, teamId, puppet, removal.at - 1, 'admin'), sameTime = admit(sara, teamId, puppet, removal.at, 'admin'), inside = admit(sara, teamId, puppet, T + 3000, 'admin');
  const now = admit(sara, teamId, puppet, T + 6000, 'admin');
  const result = withHome(founder.home, () => merge(teamId, [backdated, sameTime, inside, now]));
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.rejected.map(row => row.reason), ['The signer was removed from the team.', 'The signer was removed from the team.', 'The signer was removed from the team.', 'The signer is not an admin.']);
  assert.ok(!withHome(founder.home, () => team(teamId)).members.some(m => m.key === puppet.key));
  // What she may do as a member, she does.
  const own = channelOp(sara, teamId, hex16(9), 'mine', [sara], T + 7000);
  assert.equal(withHome(founder.home, () => merge(teamId, [own])).added.length, 1);
  // Her machine takes the whole log back: her own old ops are skipped, not refused, and she is on the team.
  const pulled = withHome(member.home, () => merge(teamId, withHome(founder.home, () => readLog(teamId).ops)));
  assert.deepEqual(pulled.rejected, []);
  assert.equal(withHome(member.home, () => team(teamId)).members.find(m => m.key === sara.key).removed, false);
});
test('leaving and removing: the founder can do neither to themselves, and only admins remove', (t) => {
  const { teamId, founder, member } = makeTeam(t);
  const sync = (from, to) => withHome(to.home, () => merge(teamId, withHome(from.home, () => readLog(teamId).ops)));
  withHome(founder.home, () => {
    assert.throws(() => leaveOp(founder.identity, teamId), /^.*You made core, so you cannot leave it\.$/);
    assert.throws(() => removeOp(founder.identity, teamId, founder.identity.key), /To leave the team yourself/);
    assert.throws(() => removeOp(founder.identity, teamId, signer().key), /That person is not on core\./);
  });
  withHome(member.home, () => assert.throws(() => removeOp(member.identity, teamId, founder.identity.key), /Only an admin of core can remove a teammate\./));
  withHome(founder.home, () => appendOp(teamId, makeOp(founder.identity, teamId, 'role', { key: member.identity.key, role: 'admin' })));
  sync(founder, member);
  withHome(member.home, () => assert.throws(() => removeOp(member.identity, teamId, founder.identity.key), /ana made core, so they cannot be removed\./));
  // The member leaves; their machine shows them off it, and so does the founder's once it has the op.
  withHome(member.home, () => { leaveOp(member.identity, teamId); assert.throws(() => leaveOp(member.identity, teamId), /You are not on that team\./); });
  sync(member, founder);
  assert.deepEqual(withHome(founder.home, () => team(teamId)).members.map(m => [m.name, m.removed, m.left]), [['ana', false, false], ['sara', true, true]]);
  // A new invite brings the same key back; an invite to someone still on the team is refused and stays unused.
  const back = withHome(founder.home, () => { const code = createInvite(founder.identity, teamId, { hours: 1 }); redeemCode(code, member.identity.key, 'sara'); return code; });
  assert.ok(back);
  withHome(founder.home, () => {
    const code = createInvite(founder.identity, teamId, { hours: 1 });
    assert.throws(() => redeemCode(code, member.identity.key, 'sara'), /You are already on this team\./);
    assert.equal(openInvites([teamId]).length, 1, 'the refused invite is still open');
  });
  sync(founder, member);
  assert.equal(withHome(member.home, () => team(teamId)).members.find(m => m.key === member.identity.key).removed, false);
  // The founder removes them, and a new invite brings them back again.
  withHome(founder.home, () => { removeOp(founder.identity, teamId, member.identity.key); redeemCode(createInvite(founder.identity, teamId, { hours: 1 }), member.identity.key, 'sara2'); });
  sync(founder, member);
  assert.deepEqual(withHome(member.home, () => team(teamId)).members.map(m => [m.name, m.role, m.removed]), [['ana', 'admin', false], ['sara2', 'member', false]]);
});
test('forgetting a team drops it from every share and from team-projects', (t) => {
  withHome(newHome(t), () => {
    const first = 'a'.repeat(64), second = 'b'.repeat(64), { root } = registeredProject(t);
    share(root, { handle: 'app', teams: [first, second] }); setTeamProject(first, 'app'); setTeamProject(second, 'app');
    forgetTeam(first);
    assert.deepEqual(shares().map(row => [row.handle, row.teams]), [['app', [second]]]);
    assert.deepEqual(teamProjects(), { [second]: 'app' });
    forgetTeam(first); forgetTeam(second);
    assert.deepEqual(shares().map(row => row.teams), [[]]); assert.deepEqual(teamProjects(), {});
    assert.throws(() => forgetTeam('x'), /Choose a team/);
  });
});
test('two admins acting at once converge to the same log, head and state', (t) => {
  const { teamId, founder, member } = makeTeam(t);
  withHome(founder.home, () => appendOp(teamId, makeOp(founder.identity, teamId, 'role', { key: member.identity.key, role: 'admin' })));
  withHome(member.home, () => merge(teamId, withHome(founder.home, () => readLog(teamId).ops)));
  const cat = signer('cat'), dan = signer('dan');
  // Both act before hearing from each other.
  withHome(founder.home, () => appendOp(teamId, makeOp(founder.identity, teamId, 'admit', { key: cat.key, name: 'cat', role: 'member', invite: invite() })));
  withHome(member.home, () => {
    appendOp(teamId, makeOp(member.identity, teamId, 'admit', { key: dan.key, name: 'dan', role: 'member', invite: invite() }));
    appendOp(teamId, makeOp(member.identity, teamId, 'relays', { keys: [cat.key] }));
  });
  const a = withHome(founder.home, () => readLog(teamId).ops), b = withHome(member.home, () => readLog(teamId).ops);
  assert.notDeepEqual(withHome(founder.home, () => head(teamId)), withHome(member.home, () => head(teamId)));
  const toMember = withHome(founder.home, () => opsMissing(teamId, b.map(op => op.id)));
  const toFounder = withHome(member.home, () => opsMissing(teamId, a.map(op => op.id)));
  assert.equal(toMember.length, 1); assert.equal(toFounder.length, 2);
  assert.equal(withHome(member.home, () => merge(teamId, toMember)).added.length, 1);
  assert.equal(withHome(founder.home, () => merge(teamId, toFounder)).added.length, 2);
  const left = withHome(founder.home, () => ({ head: head(teamId), team: team(teamId) }));
  const right = withHome(member.home, () => ({ head: head(teamId), team: team(teamId) }));
  assert.deepEqual(left, right);
  assert.equal(left.head.seq, 6);
  assert.deepEqual(left.team.members.map(m => m.name), ['ana', 'sara', 'cat', 'dan']);
  assert.deepEqual(left.team.relays, [cat.key]);
  // Merging again adds nothing.
  assert.deepEqual(withHome(founder.home, () => merge(teamId, toFounder)), { added: [], rejected: [] });
});
test('a concurrent removal also wins after both sides merge', (t) => {
  const { teamId, founder, member } = makeTeam(t);
  withHome(founder.home, () => appendOp(teamId, makeOp(founder.identity, teamId, 'role', { key: member.identity.key, role: 'admin' })));
  withHome(member.home, () => merge(teamId, withHome(founder.home, () => readLog(teamId).ops)));
  const cat = signer('cat');
  const removal = withHome(founder.home, () => appendOp(teamId, makeOp(founder.identity, teamId, 'remove', { key: member.identity.key }))).op;
  // The member's clock runs later, so its admit sorts after the removal.
  const late = opAt(member.identity, teamId, 'admit', { key: cat.key, name: 'cat', role: 'member', invite: invite() }, removal.at + 5000);
  withHome(member.home, () => appendOp(teamId, late));
  assert.match(withHome(founder.home, () => merge(teamId, [late])).rejected[0].reason, /was removed/);
  withHome(member.home, () => merge(teamId, [removal]));
  const a = withHome(founder.home, () => team(teamId)), b = withHome(member.home, () => team(teamId));
  assert.deepEqual(a.members, b.members);
  assert.equal(a.members.find(m => m.key === member.identity.key).removed, true);
  assert.ok(!a.members.some(m => m.key === cat.key));
  assert.ok(b.rejected.some(r => r.id === late.id));
  // The founder never stores the refused op, so the heads stay apart until it is gone.
  assert.ok(!withHome(founder.home, () => readLog(teamId).ops).some(op => op.id === late.id));
});
test('a removed admin cannot backdate ops, and a plain member cannot freeze or fill the log', (t) => {
  const { teamId, founder, member } = makeTeam(t);
  const ops = () => withHome(founder.home, () => readLog(teamId).ops);
  // A plain member: only their own leave would be stored.
  const junk = [opAt(member.identity, teamId, 'role', { key: member.identity.key, role: 'admin' }, Number.MAX_SAFE_INTEGER),
    ...Array.from({ length: 50 }, (_, i) => opAt(member.identity, teamId, 'relays', { keys: [] }, Date.now() + i))];
  const pushed = withHome(founder.home, () => merge(teamId, junk));
  assert.equal(pushed.added.length, 0); assert.equal(pushed.rejected.length, junk.length);
  // An admin's op from far in the future is refused too.
  withHome(founder.home, () => appendOp(teamId, makeOp(founder.identity, teamId, 'role', { key: member.identity.key, role: 'admin' })));
  const future = opAt(member.identity, teamId, 'relays', { keys: [] }, Date.now() + 3600000);
  assert.match(withHome(founder.home, () => merge(teamId, [future])).rejected[0].reason, /future/);
  // A future op already in a log does not freeze makeOp.
  withHome(founder.home, () => fs.appendFileSync(teamPath(teamId, 'log.jsonl'), `${JSON.stringify(opAt(founder.identity, teamId, 'relays', { keys: [] }, Number.MAX_SAFE_INTEGER - 1))}\n`));
  const removal = withHome(founder.home, () => appendOp(teamId, makeOp(founder.identity, teamId, 'remove', { key: member.identity.key }))).op;
  assert.ok(removal.at < Date.now() + 60000);
  // After the removal, an admit the removed admin dates before it is refused.
  const puppet = signer('puppet'), backdated = admit(member.identity, teamId, puppet, removal.at - 1, 'admin');
  assert.match(withHome(founder.home, () => merge(teamId, [backdated])).rejected[0].reason, /was removed/);
  assert.ok(!ops().some(op => op.id === backdated.id));
  assert.ok(!withHome(founder.home, () => team(teamId)).members.some(m => m.key === puppet.key));
});
test('merge drops invalid, foreign and stranger ops without writing them', (t) => {
  const { teamId, founder } = makeTeam(t);
  withHome(founder.home, () => {
    const before = fs.readFileSync(teamPath(teamId, 'log.jsonl'), 'utf8');
    const eve = signer('eve'), good = makeOp(founder.identity, teamId, 'admit', { key: signer().key, name: 'cat', role: 'member', invite: invite() });
    const other = opAt(eve, '', 'create', { name: 'evil', founderName: 'eve' }, Date.now());
    const incoming = [{ ...good, sig: '0'.repeat(128) }, other, opAt(eve, teamId, 'admit', { key: eve.key, name: 'eve', role: 'admin', invite: invite() }, Date.now()), 'junk', null, { ...good, body: { ...good.body, name: 'x' } }];
    const result = merge(teamId, incoming);
    assert.deepEqual(result.added, []); assert.equal(result.rejected.length, incoming.length);
    assert.equal(fs.readFileSync(teamPath(teamId, 'log.jsonl'), 'utf8'), before);
    assert.equal(merge(teamId, [good, good]).added.length, 1);
    assert.throws(() => merge(teamId, 'nope'), /list/);
    assert.throws(() => appendOp(teamId, opAt(eve, teamId, 'leave', {}, Date.now())), /not a member/);
    assert.throws(() => appendOp(teamId, other), /another team/);
    assert.deepEqual(appendOp(teamId, good), { added: false, op: good });
  });
  // A machine with no log accepts nothing without the create op.
  withHome(newHome(t), () => {
    const ops = withHome(founder.home, () => readLog(teamId).ops);
    assert.deepEqual(merge(teamId, ops.filter(op => op.type !== 'create')).added, []);
    assert.equal(merge(teamId, ops).added.length, ops.length);
  });
});
test('a damaged log is read around, not trusted, and team ids never leave the folder', (t) => {
  const { teamId, founder } = makeTeam(t);
  withHome(founder.home, () => {
    const file = teamPath(teamId, 'log.jsonl'), good = fs.readFileSync(file, 'utf8');
    const op = JSON.parse(good.split('\n')[1]);
    fs.writeFileSync(file, `${good}not json\n${JSON.stringify({ ...op, body: { ...op.body, role: 'admin' } })}\n${'x'.repeat(9000)}\n\n`);
    const { ops, bad } = readLog(teamId);
    assert.equal(ops.length, 2); assert.deepEqual(bad.map(b => b.line), [3, 4, 5]);
    assert.equal(team(teamId).members[1].role, 'member');
    assert.equal(team(teamId).bad.length, 3);
    for (const id of ['../x', `${teamId}/..`, teamId.toUpperCase(), '', null]) assert.throws(() => readLog(id), /team id/);
    assert.equal(team('a'.repeat(64)), null);
    fs.mkdirSync(peerFile('teams', 'not-a-team'));
    assert.deepEqual(teams().map(x => x.id), [teamId]);
  });
});
test('makeOp never goes back in time behind the local log', (t) => {
  const { teamId, founder } = makeTeam(t);
  withHome(founder.home, () => {
    const future = makeOp(founder.identity, teamId, 'relays', { keys: [] });
    const ahead = opAt(founder.identity, teamId, 'relays', { keys: [signer().key] }, future.at + 60000);
    appendOp(teamId, ahead);
    assert.equal(makeOp(founder.identity, teamId, 'relays', { keys: [] }).at, ahead.at + 1);
    assert.throws(() => makeOp(founder.identity, teamId, 'nope', {}), /Unknown/);
    assert.throws(() => makeOp(founder.identity, teamId, 'relays', { keys: ['x'] }), /body is invalid/);
  });
});
test('a member makes a channel with a teammate, and channels fold in the order they were made', () => {
  const ana = signer('ana'), bob = signer('bob'), cat = signer('cat');
  const create = opAt(ana, '', 'create', { name: 'core', founderName: 'ana' }, 1000), id = create.id;
  const base = [create, admit(ana, id, bob, 1100), admit(ana, id, cat, 1150)];
  assert.deepEqual(fold(base).channels, [], 'a log with no channel ops has no channels');
  const design = channelOp(bob, id, 'd'.repeat(16), 'design', [bob, cat], 1300), docs = channelOp(ana, id, 'a'.repeat(16), 'docs_2-x', [ana], 1200), ops = channelOp(cat, id, 'b'.repeat(16), 'ops', [cat], 1300);
  for (const op of [design, docs, ops]) assert.equal(opProblem(op), null);
  const state = fold([...base, design, docs, ops]);
  assert.deepEqual(state.rejected, []);
  assert.deepEqual(state.channels, [
    { id: 'a'.repeat(16), name: 'docs_2-x', members: [ana.key], createdBy: ana.key, createdAt: 1200 },
    { id: 'b'.repeat(16), name: 'ops', members: [cat.key], createdBy: cat.key, createdAt: 1300 },
    { id: 'd'.repeat(16), name: 'design', members: [bob.key, cat.key], createdBy: bob.key, createdAt: 1300 },
  ], 'oldest first, and by id when two were made at once');
  assert.deepEqual(state.members.map(m => [m.name, m.role, m.removed]), [['ana', 'admin', false], ['bob', 'member', false], ['cat', 'member', false]], 'a channel changes nobody on the team');
  for (let i = 0; i < 10; i++) assert.deepEqual(view(fold(shuffle([...base, design, docs, ops, design]))), view(state));
});
test('a new channel needs its creator in it and every member on the team', () => {
  const ana = signer('ana'), bob = signer('bob'), cat = signer('cat'), dan = signer('dan'), eve = signer('eve');
  const create = opAt(ana, '', 'create', { name: 'core', founderName: 'ana' }, 1000), id = create.id;
  const base = [create, admit(ana, id, bob, 1100), admit(ana, id, cat, 1110), admit(ana, id, dan, 1120), opAt(ana, id, 'remove', { key: dan.key }, 1200)];
  const rules = [
    [channelOp(bob, id, hex16(1), 'design', [cat], 1300), 'needs its creator as a member'],
    [channelOp(bob, id, hex16(2), 'design', [], 1310), 'needs its creator as a member'],
    [channelOp(ana, id, hex16(3), 'design', [bob, cat], 1320), 'needs its creator as a member'],
    [channelOp(bob, id, hex16(4), 'design', [bob, eve], 1330), 'channel member is not on the team'],
    [channelOp(bob, id, hex16(5), 'design', [bob, dan], 1340), 'channel member is not on the team'],
    [channelOp(bob, id, hex16(6), 'design', [bob, cat], 1105), 'channel member is not on the team'],
    [channelOp(cat, id, hex16(7), 'design', [cat], 1105), 'signer is not a member'],
    [channelOp(eve, id, hex16(8), 'design', [eve], 1350), 'signer is not a member'],
    [channelOp(dan, id, hex16(9), 'design', [dan], 1360), 'signer was removed'],
  ];
  const state = fold([...base, ...rules.map(([op]) => op)]);
  for (const [op, reason] of rules) assert.match(refusal(state, op) ?? '', new RegExp(reason), `${op.body.id}: ${reason}`);
  assert.deepEqual(state.channels, []);
  // What dan made while on the team stays, without dan.
  const early = channelOp(dan, id, hex16(10), 'early', [dan, bob], 1150), kept = fold([...base, early]);
  assert.equal(refusal(kept, early), null);
  assert.deepEqual(kept.channels, [{ id: hex16(10), name: 'early', members: [bob.key], createdBy: dan.key, createdAt: 1150 }]);
});
test('a channel member or a team admin changes a channel, and nobody else', () => {
  const ana = signer('ana'), bob = signer('bob'), cat = signer('cat'), dan = signer('dan'), room = 'c'.repeat(16);
  const create = opAt(ana, '', 'create', { name: 'core', founderName: 'ana' }, 1000), id = create.id;
  const log = [create, admit(ana, id, bob, 1100), admit(ana, id, cat, 1110), admit(ana, id, dan, 1120), channelOp(bob, id, room, 'design', [bob, cat], 1200)];
  const now = () => fold(log).channels.map(row => [row.name, row.members.map(key => [ana, bob, cat, dan].find(who => who.key === key).name).join(' ')]);
  const step = op => { log.push(op); return refusal(fold(log), op); };
  // dan is on the team but not in the channel: no adding himself, no renaming, no deleting.
  for (const [n, [name, members]] of [['design', [bob, cat, dan]], ['mine', [bob, cat]], ['design', []]].entries()) assert.equal(step(channelOp(dan, id, room, name, members, 1300 + n)), 'Only a channel member can change it.');
  assert.deepEqual(now(), [['design', 'bob cat']]);
  // cat is in it: she renames it and adds dan. It keeps who made it and when.
  assert.equal(step(channelOp(cat, id, room, 'ux', [bob, cat, dan], 1400)), null);
  assert.deepEqual(fold(log).channels, [{ id: room, name: 'ux', members: [bob.key, cat.key, dan.key], createdBy: bob.key, createdAt: 1200 }]);
  // dan is in it now and may drop its creator, who then cannot change it any more.
  assert.equal(step(channelOp(dan, id, room, 'ux', [cat, dan], 1500)), null);
  assert.equal(step(channelOp(bob, id, room, 'ux', [bob, cat, dan], 1600)), 'Only a channel member can change it.');
  assert.deepEqual(now(), [['ux', 'cat dan']]);
  // ana is an admin who was never in it, and bob can again once he is made an admin.
  assert.equal(step(channelOp(ana, id, room, 'ux', [cat], 1700)), null);
  assert.deepEqual(now(), [['ux', 'cat']]);
  log.push(opAt(ana, id, 'role', { key: bob.key, role: 'admin' }, 1800));
  assert.equal(step(channelOp(bob, id, room, 'ux', [bob, cat], 1900)), null);
  assert.deepEqual(fold(log).channels, [{ id: room, name: 'ux', members: [bob.key, cat.key], createdBy: bob.key, createdAt: 1200 }]);
});
test('a channel name is taken while its channel lives and free again once that channel is deleted', () => {
  const ana = signer('ana'), bob = signer('bob'), cat = signer('cat');
  const create = opAt(ana, '', 'create', { name: 'core', founderName: 'ana' }, 1000), id = create.id;
  const base = [create, admit(ana, id, bob, 1100), admit(ana, id, cat, 1110)];
  const first = channelOp(bob, id, hex16(1), 'design', [bob], 1200), clash = channelOp(cat, id, hex16(2), 'design', [cat], 1300);
  const docs = channelOp(cat, id, hex16(3), 'docs', [cat], 1310), rename = channelOp(cat, id, hex16(3), 'design', [cat], 1320), same = channelOp(bob, id, hex16(1), 'design', [bob, cat], 1330);
  const taken = fold([...base, first, clash, docs, rename, same]);
  assert.equal(refusal(taken, clash), 'A channel with that name exists.'); assert.equal(refusal(taken, rename), 'A channel with that name exists.');
  assert.equal(refusal(taken, same), null, 'a channel keeps its own name through a change');
  assert.deepEqual(taken.channels.map(row => [row.id, row.name, row.members.length]), [[hex16(1), 'design', 2], [hex16(3), 'docs', 1]]);
  // No members deletes it. The name is free for a new channel, and so is the id.
  const gone = channelOp(cat, id, hex16(1), 'design', [], 1400), again = channelOp(cat, id, hex16(2), 'design', [cat], 1500), reborn = channelOp(bob, id, hex16(1), 'ops', [bob], 1600);
  const missing = channelOp(bob, id, hex16(9), 'none', [], 1700);
  const freed = fold([...base, first, clash, docs, rename, same, gone, again, reborn, missing]);
  for (const op of [gone, again, reborn]) assert.equal(refusal(freed, op), null);
  assert.equal(refusal(freed, missing), 'A new channel needs its creator as a member.', 'there is nothing to delete');
  assert.deepEqual(freed.channels, [
    { id: hex16(3), name: 'docs', members: [cat.key], createdBy: cat.key, createdAt: 1310 },
    { id: hex16(2), name: 'design', members: [cat.key], createdBy: cat.key, createdAt: 1500 },
    { id: hex16(1), name: 'ops', members: [bob.key], createdBy: bob.key, createdAt: 1600 },
  ]);
  // Deleting is a change like any other: someone outside the channel cannot, an admin can.
  const kept = fold([...base, first, gone]);
  assert.equal(refusal(kept, gone), 'Only a channel member can change it.'); assert.deepEqual(kept.channels.map(row => row.name), ['design']);
  assert.deepEqual(fold([...base, first, opAt(ana, id, 'role', { key: cat.key, role: 'admin' }, 1350), gone]).channels, []);
});
test('someone removed from the team is out of its channels, and a channel nobody is left in is gone with its name', () => {
  const ana = signer('ana'), bob = signer('bob'), cat = signer('cat');
  const create = opAt(ana, '', 'create', { name: 'core', founderName: 'ana' }, 1000), id = create.id;
  const ops = [create, admit(ana, id, bob, 1100), admit(ana, id, cat, 1110),
    channelOp(bob, id, hex16(1), 'design', [bob, cat], 1200), channelOp(bob, id, hex16(2), 'solo', [bob], 1210), channelOp(cat, id, hex16(3), 'notes', [cat, ana], 1220)];
  const removal = opAt(ana, id, 'remove', { key: bob.key }, 1300), late = channelOp(bob, id, hex16(1), 'design', [bob], 1350);
  const removed = fold([...ops, removal, late]);
  assert.equal(refusal(removed, late), 'The signer was removed from the team.');
  assert.deepEqual(removed.channels, [
    { id: hex16(1), name: 'design', members: [cat.key], createdBy: bob.key, createdAt: 1200 },
    { id: hex16(3), name: 'notes', members: [cat.key, ana.key], createdBy: cat.key, createdAt: 1220 },
  ]);
  const left = fold([...ops, removal, opAt(cat, id, 'leave', {}, 1400)]);
  assert.deepEqual(left.channels, [{ id: hex16(3), name: 'notes', members: [ana.key], createdBy: cat.key, createdAt: 1220 }]);
  // The name design is cat's channel's until she leaves, and anyone's after.
  const taken = channelOp(ana, id, hex16(6), 'design', [ana], 1390), free = channelOp(ana, id, hex16(6), 'design', [ana], 1410);
  const departed = fold([...ops, removal, taken, opAt(cat, id, 'leave', {}, 1400), free]);
  assert.equal(refusal(departed, taken), 'A channel with that name exists.'); assert.equal(refusal(departed, free), null);
  assert.deepEqual(departed.channels.map(row => [row.id, row.name]), [[hex16(3), 'notes'], [hex16(6), 'design']]);
  // A channel that went with its last member no longer holds its name or its id.
  const reuse = channelOp(cat, id, hex16(4), 'solo', [cat], 1360), reborn = channelOp(cat, id, hex16(2), 'alone', [cat], 1370);
  const after = fold([...ops, removal, reuse, reborn]);
  assert.equal(refusal(after, reuse), null); assert.equal(refusal(after, reborn), null);
  assert.deepEqual(after.channels.map(row => [row.id, row.name, row.createdBy, row.createdAt]), [[hex16(1), 'design', bob.key, 1200], [hex16(3), 'notes', cat.key, 1220], [hex16(4), 'solo', cat.key, 1360], [hex16(2), 'alone', cat.key, 1370]]);
  // Nor a place among the team's 50: someone who filled them and was removed blocks nobody.
  const many = Array.from({ length: 50 }, (_, n) => channelOp(bob, id, hex16(100 + n), `room-${n}`, [bob], 1230 + n)), fresh = channelOp(cat, id, hex16(5), 'fresh', [cat], 1400);
  const emptied = fold([create, admit(ana, id, bob, 1100), admit(ana, id, cat, 1110), ...many, removal, fresh]);
  assert.equal(refusal(emptied, fresh), null); assert.deepEqual(emptied.channels.map(row => row.name), ['fresh']);
});
test('a channel op with a malformed id, name or member list is not a valid op', () => {
  const ana = signer('ana'), create = opAt(ana, '', 'create', { name: 'core', founderName: 'ana' }, 1000), id = create.id;
  const keys = n => Array.from({ length: n }, () => signer().key), body = (extra = {}) => ({ id: 'c'.repeat(16), name: 'design', members: [ana.key], ...extra });
  const without = name => { const value = body(); delete value[name]; return value; };
  for (const value of [body(), body({ members: [] }), body({ members: keys(20) }), body({ name: 'a' }), body({ name: `0${'_-'.repeat(14)}z` }), body({ id: '0123456789abcdef' })])
    assert.equal(opProblem(opAt(ana, id, 'channel', value, 2000)), null, JSON.stringify(value).slice(0, 80));
  const bad = {
    shortId: body({ id: 'c'.repeat(15) }), longId: body({ id: 'c'.repeat(17) }), upperId: body({ id: 'C'.repeat(16) }), notHexId: body({ id: 'g'.repeat(16) }), numberId: body({ id: 1234567890123456 }), noId: without('id'),
    general: body({ name: 'general' }), upperName: body({ name: 'Design' }), emptyName: body({ name: '' }), longName: body({ name: 'a'.repeat(31) }), dashFirst: body({ name: '-design' }), hash: body({ name: '#design' }),
    space: body({ name: 'de sign' }), numberName: body({ name: 7 }), noName: without('name'),
    tooMany: body({ members: keys(21) }), twice: body({ members: [ana.key, ana.key] }), notKeys: body({ members: ['ana'] }), upperKey: body({ members: ['A'.repeat(64)] }), notList: body({ members: ana.key }), noMembers: without('members'),
    extra: body({ topic: 'x' }),
  };
  const ops = Object.entries(bad).map(([name, value]) => [name, opAt(ana, id, 'channel', value, 2000)]);
  for (const [name, op] of ops) {
    assert.equal(opProblem(op), 'The channel op body is invalid.', name);
    assert.throws(() => validateOp(op), /channel op body is invalid/, name);
  }
  const state = fold([create, ...ops.map(([, op]) => op)]);
  assert.deepEqual(state.channels, []); assert.equal(state.rejected.length, ops.length);
});
test('a team holds 50 channels, and each signer changes channels 200 times', () => {
  const ana = signer('ana'), bob = signer('bob'), cat = signer('cat');
  const create = opAt(ana, '', 'create', { name: 'core', founderName: 'ana' }, 1000), id = create.id;
  const log = [create, admit(ana, id, bob, 1100), admit(ana, id, cat, 1110), ...Array.from({ length: 50 }, (_, n) => channelOp(bob, id, hex16(n), `room-${n}`, [bob], 2000 + n))];
  const over = channelOp(cat, id, hex16(50), 'room-50', [cat], 3000), change = channelOp(bob, id, hex16(7), 'room-7', [bob, cat], 3010);
  log.push(over, change);
  assert.equal(fold(log).channels.length, 50); assert.equal(refusal(fold(log), over), 'The team has too many channels.');
  assert.equal(refusal(fold(log), change), null, 'a full team still changes the channels it has');
  // Deleting one makes room for another.
  const drop = channelOp(bob, id, hex16(0), 'room-0', [], 3100), next = channelOp(cat, id, hex16(51), 'room-51', [cat], 3200);
  log.push(drop, next);
  assert.equal(refusal(fold(log), next), null); assert.equal(fold(log).channels.length, 50);
  // bob has made 52 changes. A refused one does not count, so 148 more apply and the one after is refused.
  const clash = channelOp(bob, id, hex16(1), 'room-2', [bob], 3500), renames = Array.from({ length: 148 }, (_, n) => channelOp(bob, id, hex16(1), `name-${n}`, [bob], 4000 + n));
  const last = channelOp(bob, id, hex16(1), 'last', [bob], 5000), other = channelOp(cat, id, hex16(51), 'mine', [cat], 5100);
  const state = fold([...log, clash, ...renames, last, other]);
  assert.equal(refusal(state, clash), 'A channel with that name exists.'); assert.ok(renames.every(op => refusal(state, op) === null));
  assert.equal(refusal(state, last), 'The signer changed channels too many times.'); assert.equal(refusal(state, other), null, 'the limit is each signer\'s own');
  assert.equal(state.channels.find(row => row.id === hex16(1)).name, 'name-147'); assert.equal(state.channels.find(row => row.id === hex16(51)).name, 'mine');
  assert.deepEqual(state.rejected.map(r => r.id).sort(), [over.id, clash.id, last.id].sort());
});
test('a plain member\'s channel op merges from a teammate, and their roster ops are still refused', (t) => {
  const { teamId, founder, member } = makeTeam(t), ana = founder.identity, sara = member.identity, eve = signer('eve');
  const made = withHome(member.home, () => setChannel(sara, teamId, { name: 'design', members: [sara.key, ana.key] }));
  const at = Date.now();
  const junk = [[admit(sara, teamId, eve, at), 'not an admin'], [opAt(sara, teamId, 'remove', { key: ana.key }, at), 'not an admin'], [opAt(sara, teamId, 'role', { key: sara.key, role: 'admin' }, at), 'not an admin'],
    [opAt(sara, teamId, 'relays', { keys: [eve.key] }, at), 'not an admin'], [channelOp(sara, teamId, hex16(2), 'guests', [sara, eve], at), 'channel member is not on the team'],
    [channelOp(eve, teamId, hex16(3), 'mine', [eve], at), 'signer is not a member'], [{ ...made.op, body: { ...made.op.body, name: 'general' } }, 'channel op body is invalid']];
  withHome(founder.home, () => {
    const before = readLog(teamId).ops;
    assert.deepEqual(team(teamId).channels, []);
    const result = merge(teamId, [...junk.map(([op]) => op), made.op]);
    assert.deepEqual(result.added, [made.op]);
    for (const [op, reason] of junk) assert.match(result.rejected.find(r => r.id === op.id)?.reason ?? '', new RegExp(reason), reason);
    assert.equal(result.rejected.length, junk.length);
    assert.deepEqual(readLog(teamId).ops, [...before, made.op], 'only the channel op is written');
    assert.deepEqual(team(teamId).channels, [{ id: made.id, name: 'design', members: [sara.key, ana.key], createdBy: sara.key, createdAt: made.op.at }]);
    assert.deepEqual(team(teamId).members.map(m => [m.name, m.role, m.removed]), [['ana', 'admin', false], ['sara', 'member', false]]);
    assert.deepEqual(merge(teamId, [made.op]), { added: [], rejected: [] });
  });
  assert.deepEqual(withHome(founder.home, () => head(teamId)), withHome(member.home, () => head(teamId)));
  // A change made on the other side comes back the same way, and both fold to the same channel.
  const changed = withHome(founder.home, () => setChannel(ana, teamId, { id: made.id, name: 'ux', members: [ana.key, sara.key] }));
  assert.deepEqual(withHome(member.home, () => merge(teamId, [changed.op])).added, [changed.op]);
  assert.deepEqual(withHome(member.home, () => team(teamId).channels), withHome(founder.home, () => team(teamId).channels));
  assert.deepEqual(withHome(member.home, () => team(teamId).channels.map(row => [row.name, row.createdBy])), [['ux', sara.key]]);
});
test('setChannel creates, changes and deletes a channel, and refuses a bad name, a channel that is gone and an unknown team', (t) => {
  const { teamId, founder, member } = makeTeam(t), ana = founder.identity, sara = member.identity;
  const docs = withHome(founder.home, () => {
    const count = () => readLog(teamId).ops.length, start = count();
    const made = setChannel(ana, teamId, { name: '#design', members: [ana.key, sara.key, ana.key] });
    assert.match(made.id, /^[0-9a-f]{16}$/); assert.equal(made.op.type, 'channel'); assert.equal(made.op.by, ana.key); assert.equal(opProblem(made.op), null);
    assert.deepEqual(made.op.body, { id: made.id, name: 'design', members: [ana.key, sara.key] }, 'no leading #, and each member once');
    assert.equal(count(), start + 1); assert.deepEqual(readLog(teamId).ops.at(-1), made.op);
    assert.deepEqual(team(teamId).channels, [{ id: made.id, name: 'design', members: [ana.key, sara.key], createdBy: ana.key, createdAt: made.op.at }]);
    // With an id it sets that channel, and keeps the name when none is given.
    const fewer = setChannel(ana, teamId, { id: made.id, members: [ana.key] });
    assert.equal(fewer.id, made.id); assert.deepEqual(fewer.op.body, { id: made.id, name: 'design', members: [ana.key] });
    setChannel(ana, teamId, { id: made.id, name: 'ux', members: [ana.key, sara.key] });
    assert.deepEqual(team(teamId).channels, [{ id: made.id, name: 'ux', members: [ana.key, sara.key], createdBy: ana.key, createdAt: made.op.at }]);
    const second = setChannel(ana, teamId, { name: 'docs', members: [ana.key] });
    assert.notEqual(second.id, made.id); assert.deepEqual(team(teamId).channels.map(row => row.name), ['ux', 'docs']);
    // A refusal writes nothing.
    const before = count(), NAME = /Name a channel with 1 to 30 lowercase letters, digits, - or _\. general is taken\./;
    for (const name of [undefined, null, '', 'general', '#general', 'Design', 'de sign', '-x', '##x', 'a'.repeat(31)]) assert.throws(() => setChannel(ana, teamId, { name, members: [ana.key] }), NAME, String(name));
    assert.throws(() => setChannel(ana, teamId, { id: made.id, name: 'general', members: [ana.key] }), NAME);
    assert.throws(() => setChannel(ana, teamId, { id: 'f'.repeat(16), name: 'ops', members: [ana.key] }), /That channel no longer exists\./);
    assert.throws(() => setChannel(ana, 'a'.repeat(64), { name: 'ops', members: [ana.key] }), /Unknown team\./);
    assert.throws(() => setChannel(ana, 'core', { name: 'ops', members: [ana.key] }), /team id must be 64 hex/);
    for (const members of [undefined, 'x', [ana.key, 'sara'], Array.from({ length: 21 }, () => signer().key)]) assert.throws(() => setChannel(ana, teamId, { name: 'ops', members }), /A channel holds up to 20 teammates\./);
    assert.throws(() => setChannel(ana, teamId, { name: 'ops', members: [sara.key] }), /needs its creator as a member/);
    assert.throws(() => setChannel(ana, teamId, { name: 'ops', members: [ana.key, signer().key] }), /channel member is not on the team/);
    assert.throws(() => setChannel(ana, teamId, { name: 'docs', members: [ana.key] }), /A channel with that name exists/);
    assert.throws(() => setChannel(ana, teamId, { id: second.id, name: 'ux', members: [ana.key] }), /A channel with that name exists/);
    assert.equal(count(), before);
    // No members deletes it: it is gone for the next change, and its name is free.
    assert.deepEqual(setChannel(ana, teamId, { id: made.id, members: [] }).op.body, { id: made.id, name: 'ux', members: [] });
    assert.deepEqual(team(teamId).channels.map(row => row.name), ['docs']);
    assert.throws(() => setChannel(ana, teamId, { id: made.id, members: [ana.key] }), /That channel no longer exists\./);
    assert.equal(setChannel(ana, teamId, { name: 'ux', members: [ana.key] }).op.body.name, 'ux');
    return second;
  });
  // A plain member makes one too, but cannot change one they are not in.
  withHome(member.home, () => {
    merge(teamId, withHome(founder.home, () => readLog(teamId).ops));
    const notes = setChannel(sara, teamId, { name: 'notes', members: [sara.key] });
    assert.deepEqual(team(teamId).channels.map(row => [row.name, row.createdBy]), [['docs', ana.key], ['ux', ana.key], ['notes', sara.key]]);
    assert.throws(() => setChannel(sara, teamId, { id: docs.id, members: [sara.key, ana.key] }), /Only a channel member can change it\./);
    assert.equal(readLog(teamId).ops.at(-1).id, notes.op.id);
  });
});

// invite-code.mjs and invite.mjs

const CODE = /^[2-9a-hjkmnp-z]{4}-[2-9a-hjkmnp-z]{4}-[2-9a-hjkmnp-z]{4}$/;
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const nonce = () => crypto.randomBytes(32).toString('hex');
test('an invite code is 12 characters in three groups, with no look-alike characters, each drawn evenly', () => {
  assert.equal(ALPHABET.length, 31); for (const ch of '01ilo') assert.equal(ALPHABET.includes(ch), false, ch);
  const codes = Array.from({ length: 2000 }, newCode);
  for (const code of codes) assert.match(code, CODE);
  assert.equal(new Set(codes).size, codes.length);
  const counts = new Map(); for (const ch of codes.join('').replace(/-/g, '')) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  // 24,000 characters over 31: about 774 each, give or take 27.
  assert.equal(counts.size, 31); for (const [ch, n] of counts) assert.ok(n > 600 && n < 950, `${ch}: ${n}`);
});
test('a pasted code is read whatever came with it: case, spaces, tabs, line breaks, dashes, quotes, and /join or elu join in front, even twice', () => {
  const code = 'k7qm-x2pd-9fhw';
  for (const text of [code, 'K7QM-X2PD-9FHW', 'k7qmx2pd9fhw', ' k7qm - x2pd - 9fhw ', 'k7qm-x2pd-\n9fhw', 'k7qm-x2pd-   \r\n9fhw  ', 'k7\tqm-x2pd-9f\nhw', '/join k7qm-x2pd-9fhw',
    '/join /join k7qm-x2pd-9fhw', '│   k7qm-x2pd-9fhw   │', '╭──╮\n│ k7qm-x2pd-9fhw │\n╰──╯', '/join\n/join k7qm-\nx2pd-9fhw', 'elu join k7qm-x2pd-9fhw', 'ELU JOIN elu join k7qm x2pd 9fhw', '`k7qm-x2pd-9fhw`', '"k7qm-x2pd-9fhw"', 'k7qm–x2pd—9fhw', 'k7qm-x2pd-9fhw​']) {
    assert.deepEqual(readCode(text), { short: code }, JSON.stringify(text));
  }
  for (const text of ['k7qm-x2pd-9fh', 'k7qm-x2pd-9fhwa', 'k7qm-x2pd-9fhl', 'k7qm-x2pd-9fh0', 'k7qm-x2pd-9fh1', 'k7qm-x2pd-9fho', 'k7qm-x2pd-9fhi', '/join', '', 'join k7qm-x2pd-9fhw', null, 7, 'k'.repeat(5000)]) {
    assert.equal(readCode(text), null, JSON.stringify(text)?.slice(0, 40));
  }
  assert.deepEqual(parseInvite('/join K7QM x2pd\r\n9fhw'), { short: code });
  assert.throws(() => parseInvite('k7qm-x2pd-9fh'), /not valid/);
});
test('a code derives its topic and proof keys with scrypt and HKDF, the same way every time, and the topic gives neither key', async () => {
  assert.deepEqual({ ...SCRYPT }, { N: 65536, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
  const a = inviteKeys('k7qm-x2pd-9fhw'), b = await inviteKeysAsync('K7QM X2PD\n9FHW'), c = await inviteKeysAsync('k7qm-x2pd-9fhx');
  assert.deepEqual({ ...b }, { ...a }); assert.deepEqual(b.seed, a.seed);
  // Computed here from the documented parameters (docs/peer-network.md, "Invites").
  const master = crypto.scryptSync('k7qmx2pd9fhw', 'elu-code invite code', 32, SCRYPT);
  const part = info => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `elu-code invite ${info}`, 32));
  assert.deepEqual({ ...a }, { topic: part('topic').toString('hex'), prover: part('inviter proof').toString('hex'), verifier: publicKeyHex(part('joiner proof')) });
  assert.deepEqual(a.seed, part('joiner proof'));
  assert.equal(new Set([a.topic, a.prover, a.verifier, c.topic, c.prover, c.verifier]).size, 6);
  // The seed never reaches JSON.
  assert.equal(JSON.stringify(a).includes(a.seed.toString('hex')), false);
  // Slow on purpose: one guess at a code costs a whole scrypt run.
  const started = process.hrtime.bigint(); crypto.scryptSync('aaaaaaaaaaaa', 'elu-code invite code', 32, SCRYPT);
  assert.ok(process.hrtime.bigint() - started > 10_000_000n, 'scrypt took under 10 ms');
  assert.throws(() => inviteKeys('nope'), /not valid/); await assert.rejects(inviteKeysAsync(`elu-team:v1:${'a'.repeat(40)}`), /not valid/);
});
test('invite proofs: the right code passes; a wrong code, a relay, a replay or the other side\'s proof fails', () => {
  const keys = inviteKeys('k7qm-x2pd-9fhw'), wrong = inviteKeys('k7qm-x2pd-9fhx'), ana = signer('ana'), kim = signer('kim'), relay = signer('relay');
  const fields = { topic: keys.topic, joinerNonce: nonce(), inviterNonce: nonce(), inviter: ana.key, joiner: kim.key };
  const inviter = inviterProof(keys.prover, fields), joiner = joinerProof(keys.seed, fields);
  assert.ok(checkInviterProof(keys.prover, fields, inviter)); assert.ok(checkJoinerProof(keys.verifier, fields, joiner));
  // A wrong code: neither proof is accepted.
  assert.equal(checkInviterProof(keys.prover, fields, inviterProof(wrong.prover, fields)), false);
  assert.equal(checkJoinerProof(keys.verifier, fields, joinerProof(wrong.seed, fields)), false);
  // A relay between them knows the topic, not the code. Each leg has the relay's own key on one side, so the real proofs passed along fail.
  const kimToRelay = { ...fields, inviter: relay.key }, relayToAna = { ...fields, joiner: relay.key };
  assert.equal(checkInviterProof(keys.prover, kimToRelay, inviterProof(keys.prover, relayToAna)), false);
  assert.equal(checkJoinerProof(keys.verifier, relayToAna, joinerProof(keys.seed, kimToRelay)), false);
  // A proof replayed on another connection meets the other side's fresh nonce.
  assert.equal(checkInviterProof(keys.prover, { ...fields, joinerNonce: nonce() }, inviter), false);
  assert.equal(checkJoinerProof(keys.verifier, { ...fields, inviterNonce: nonce() }, joiner), false);
  // One side's proof is not the other's, and junk is refused without throwing.
  assert.equal(checkJoinerProof(keys.verifier, fields, inviter), false); assert.equal(checkInviterProof(keys.prover, fields, joiner), false);
  for (const bad of [null, '', 'zz', inviter.toUpperCase(), 7, {}]) { assert.equal(checkInviterProof(keys.prover, fields, bad), false); assert.equal(checkJoinerProof(keys.verifier, fields, bad), false); }
  assert.equal(checkInviterProof(keys.prover, { ...fields, topic: 'x' }, inviter), false); assert.equal(checkJoinerProof(keys.verifier, { ...fields, joiner: null }, joiner), false);
});
test('an invite admits once, keeps neither the code nor what a joiner proves with, and retries return the same admit', (t) => {
  const { teamId, member, founder, code } = makeTeam(t);
  assert.match(code, CODE); assert.deepEqual(parseInvite(code), { short: code });
  withHome(founder.home, () => {
    const file = teamPath(teamId, 'invites.json'), text = fs.readFileSync(file, 'utf8'), keys = inviteKeys(code);
    assert.equal(mode(file), 0o600);
    for (const secret of [code, code.replace(/-/g, ''), keys.seed.toString('hex')]) assert.equal(text.includes(secret), false);
    const [row] = JSON.parse(text);
    assert.deepEqual(Object.keys(row).sort(), ['expiresAt', 'hash', 'prover', 'topic', 'usedAt', 'usedBy', 'verifier']);
    assert.deepEqual([row.topic, row.prover, row.verifier, row.hash, row.usedBy], [keys.topic, keys.prover, keys.verifier, sha256(`short:${keys.verifier}`), member.identity.key]);
    // 0.1.3 admits elu.join {secret} through any row whose hash is sha256(secret): no value in the row hashes to it.
    for (const value of [row.topic, row.prover, row.verifier]) assert.notEqual(sha256(value), row.hash);
    assert.ok(row.expiresAt > Date.now() + 3500 * 1000 && row.expiresAt <= Date.now() + 3600 * 1000);
    assert.deepEqual(openInvites([teamId]), [], 'a used invite is not open');
    // Its joiner may come back for RETRY_MS, in case the reply that admitted them was lost.
    assert.deepEqual(openInvites([teamId], Date.now(), { retries: true }).map(x => x.usedBy), [member.identity.key]);
    assert.deepEqual(openInvites([teamId], Date.parse(row.usedAt) + RETRY_MS + 1, { retries: true }), []);
    const again = admitProven({ teamId, ...row }, member.identity.key, 'sara');
    assert.equal(again.body.key, member.identity.key); assert.equal(again.body.invite, row.hash);
    assert.equal(readLog(teamId).ops.length, 2);
    assert.throws(() => admitProven({ teamId, ...row }, signer().key, 'eve'), /already used/);
    assert.throws(() => redeemCode(code, signer().key, 'eve'), /not valid/);
    assert.throws(() => redeemCode(newCode(), signer().key, 'eve'), /not valid/);
    assert.throws(() => admitProven({ teamId, ...row }, 'nope', 'eve'), /joiner key/);
    // A short invite is never redeemed as a long code's secret, whatever is sent.
    for (const secret of [row.topic, row.prover, row.verifier, keys.seed.toString('hex')]) assert.throws(() => redeemInvite(teamId, secret, signer().key, 'eve'), /not valid/);
  });
  withHome(member.home, () => {
    assert.deepEqual(team(teamId).members.map(m => [m.name, m.role]), [['ana', 'admin'], ['sara', 'member']]);
    assert.throws(() => createInvite(member.identity, teamId), /Only a team admin/);
  });
});
test('a retry of a used invite is answered only while the admit it made still stands', (t) => {
  const { teamId, member, founder } = makeTeam(t);
  withHome(founder.home, () => {
    const sara = member.identity.key, rowOf = digest => ({ teamId, ...JSON.parse(fs.readFileSync(teamPath(teamId, 'invites.json'), 'utf8')).find(row => row.hash === digest) });
    const [first] = JSON.parse(fs.readFileSync(teamPath(teamId, 'invites.json'), 'utf8')), row = { teamId, ...first };
    assert.equal(admitProven(row, sara, 'sara').body.key, sara, 'still on the team: the same admit');
    // Removed within the retry window: the old code brings nothing back, and writes nothing.
    removeOp(founder.identity, teamId, sara);
    const ops = readLog(teamId).ops.length;
    assert.throws(() => admitProven(row, sara, 'sara'), /This invite was already used\./);
    assert.equal(readLog(teamId).ops.length, ops);
    assert.ok(team(teamId).members.find(m => m.key === sara).removed);
    // Back by a new invite: the old code's retry is still refused, the new one's is answered.
    const code = createInvite(founder.identity, teamId, { hours: 1 }), back = redeemCode(code, sara, 'sara');
    assert.throws(() => admitProven(row, sara, 'sara'), /This invite was already used\./);
    assert.equal(admitProven(rowOf(back.body.invite), sara, 'sara').id, back.id);
    // Left after coming back: neither code answers.
    leaveOp(member.identity, teamId);
    assert.throws(() => admitProven(rowOf(back.body.invite), sara, 'sara'), /This invite was already used\./);
  });
});
test('expired invites are refused and not announced, and a refused admit leaves the invite unused', (t) => {
  peerHome(t);
  const me = createIdentity({ name: 'ana' }), { id } = createTeam(me, 'core');
  const expired = createInvite(me, id);
  const file = teamPath(id, 'invites.json');
  fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).map(row => ({ ...row, expiresAt: Date.now() - 1 }))));
  assert.deepEqual(openInvites([id]), []);
  assert.throws(() => redeemCode(expired, signer().key, 'sara'), /not valid/);
  const [old] = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.throws(() => admitProven({ teamId: id, ...old }, signer().key, 'sara'), /expired/);
  const bob = signer('bob'), first = createInvite(me, id, { hours: 2 });
  redeemCode(first, bob.key, 'bob');
  // Bob is still on the team, so an admit of him is refused.
  const second = createInvite(me, id);
  assert.throws(() => redeemCode(second, bob.key, 'bob'), /You are already on this team\./);
  assert.deepEqual(openInvites([id]).map(row => row.topic), [inviteKeys(second).topic], 'the refused admit left it open');
  assert.throws(() => redeemCode(second, signer().key, 'bad\nname'), /name is not valid/);
  for (const hours of [0, -1, 721, '24', NaN]) assert.throws(() => createInvite(me, id, { hours }), /hours/);
  assert.throws(() => createInvite(me, 'b'.repeat(64)), /not on this machine/);
});
test('a long code from 0.1.3 or earlier still parses, pasted messily, and redeems once', (t) => {
  peerHome(t);
  const me = createIdentity({ name: 'ana' }), { id } = createTeam(me, 'core'), secret = invite(), expiresAt = Date.now() + 3600 * 1000;
  fs.writeFileSync(teamPath(id, 'invites.json'), JSON.stringify([{ hash: sha256(secret), expiresAt, usedBy: null }]));
  const code = `elu-team:v1:${base32(Buffer.from(canonical({ teamId: id, inviter: me.key, secret, expiresAt })))}`;
  assert.ok(code.length > 400);
  assert.deepEqual(parseInvite(`/join /join ${code.slice(0, 100)}  \n${code.slice(100, 200)}\t${code.slice(200)}\r\n`), { teamId: id, inviter: me.key, secret, expiresAt });
  const bob = signer('bob'), op = redeemInvite(id, secret, bob.key, 'bob');
  assert.equal(op.body.invite, sha256(secret));
  assert.deepEqual(redeemInvite(id, secret, bob.key, 'bob'), op, 'a retry gets the same admit');
  assert.throws(() => redeemInvite(id, secret, signer().key, 'eve'), /already used/);
  assert.throws(() => redeemInvite(id, invite(), signer().key, 'eve'), /not valid/);
  assert.deepEqual(openInvites([id]), [], 'a long invite has no topic');
});
test('long invite codes are parsed strictly', () => {
  const value = { teamId: 'a'.repeat(64), inviter: 'b'.repeat(64), secret: 'c'.repeat(64), expiresAt: 1700000000000 };
  const code = `elu-team:v1:${base32(Buffer.from(canonical(value)))}`;
  assert.deepEqual(parseInvite(code), value);
  assert.deepEqual(parseInvite(`  ${code}\n`), value);
  assert.deepEqual(parseInvite(code.toUpperCase()), value, 'case is not part of a code');
  const encode = v => `elu-team:v1:${base32(Buffer.from(typeof v === 'string' ? v : canonical(v)))}`;
  for (const bad of [code.replace('v1', 'v2'), `${code}a`, code.slice(0, -4), encode({ ...value, extra: 1 }), encode({ ...value, teamId: '../x' }),
    encode({ ...value, expiresAt: '1' }), encode(JSON.stringify(value, null, 1)), encode('[1]'), `elu-team:v1:${'a'.repeat(500)}`, `elu-team:v1:${'a'.repeat(600)}`, null, 7]) {
    assert.throws(() => parseInvite(bad), /not valid/, String(bad).slice(0, 40));
  }
});

// shares.mjs

test('remote URLs normalise to the same repository id', () => {
  const same = ['git@github.com:Owner/Repo.git', 'https://github.com/Owner/Repo', 'https://user:tok3n@GitHub.com/Owner/Repo.git', 'ssh://git@github.com:22/Owner/Repo.git/', 'git://github.com/Owner/Repo/', 'github.com:Owner/Repo', 'HTTPS://GITHUB.COM/Owner/Repo.git'];
  for (const url of same) assert.equal(normalizeRemote(url), 'github.com/Owner/Repo', url);
  assert.notEqual(normalizeRemote('https://github.com/owner/repo'), normalizeRemote('https://github.com/Owner/Repo'));
  assert.equal(normalizeRemote('/srv/git/app.git'), 'file/srv/git/app');
  assert.equal(normalizeRemote('file:///srv/git/app.git'), 'file/srv/git/app');
  for (const bad of ['', '   ', 'https://', 'git@host:', 'has space/x', null, 'a'.repeat(3000)]) assert.equal(normalizeRemote(bad), null, String(bad));
});
test('a share is the folder that was named: a folder inside a project shares nothing', (t) => {
  peerHome(t);
  const { root } = registeredProject(t), inner = path.join(root, 'work', 'client notes');
  fs.mkdirSync(inner, { recursive: true });
  for (const folder of [inner, path.join(root, 'work'), path.join(root, 'src')]) assert.throws(() => share(folder), /inside a project but is not one/, folder);
  assert.deepEqual(shares(), [], 'the enclosing project was not shared instead');
  assert.equal(share(root).root, root);
});
test('the home folder, or a folder that holds it, cannot be shared; a share of it made earlier still answers', (t) => {
  peerHome(t);
  const { parent } = registeredProject(t), top = fs.realpathSync(parent), home = path.join(top, 'home'), previous = process.env.HOME;
  fs.mkdirSync(path.join(home, 'work'), { recursive: true }); process.env.HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
  for (const folder of [home, top]) { git(folder, ['init', '--initial-branch=main']); registerProject(projectFolder(folder)); }
  for (const folder of [home, top]) assert.throws(() => share(folder, { handle: 'mine' }), /Your home folder cannot be shared\. Open the project's own folder and share that\./, folder);
  assert.throws(() => share(path.join(home, 'work')), /inside a project but is not one/);
  assert.deepEqual(shares(), []);
  const earlier = { handle: 'mine', root: home, repoId: null, status: true, createdAt: new Date(0).toISOString() };
  fs.mkdirSync(path.dirname(peerFile('shares.json')), { recursive: true }); fs.writeFileSync(peerFile('shares.json'), JSON.stringify([earlier]));
  assert.deepEqual(shareFor('mine'), earlier, 'the earlier share still answers');
  assert.throws(() => share(home), /Your home folder cannot be shared/);
  assert.equal(unshare('mine').root, home); assert.deepEqual(shares(), []);
});
test('a registered project is shared by handle with its repository id', (t) => {
  peerHome(t);
  const { root } = registeredProject(t, { origin: 'git@github.com:elu/app.git' });
  const row = share(root);
  assert.equal(row.handle, 'sample-app'); assert.equal(row.root, root); assert.equal(row.status, true);
  assert.equal(row.repoId, crypto.createHash('sha256').update('github.com/elu/app').digest('hex'));
  assert.equal(repoId(root), row.repoId);
  git(root, ['remote', 'set-url', 'origin', 'https://bot:secret@GitHub.com/elu/app']);
  assert.equal(repoId(root), row.repoId);
  assert.deepEqual(shares(), [row]);
  assert.deepEqual(shareFor('sample-app'), row); assert.deepEqual(shareFor(row.repoId), row); assert.equal(shareFor('nope'), null);
  assert.throws(() => share(path.join(root, 'src'), { handle: 'app' }), /inside a project but is not one/, 'a folder inside a project never shares the whole project');
  assert.deepEqual(shares(), [row]);
  const renamed = share(root, { handle: 'app', status: false });
  assert.equal(renamed.handle, 'app'); assert.equal(renamed.status, false); assert.equal(renamed.createdAt, row.createdAt);
  assert.deepEqual(share(root), renamed, 'sharing again keeps the handle and status');
  assert.equal(shares().length, 1);
  const other = registeredProject(t);
  assert.equal(share(other.root, { handle: 'other' }).repoId, null);
  assert.throws(() => share(other.root, { handle: 'app' }), /already shared/);
  for (const handle of ['App', '-x', 'a/b', '../x', 'x'.repeat(41), '', 7]) assert.throws(() => share(other.root, { handle }), /handle/, String(handle));
  assert.throws(() => share(other.root, { status: 'yes' }), /true or false/);
  assert.throws(() => share(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-unregistered-'))), /Open this project/);
  assert.throws(() => share(path.join(os.tmpdir(), 'missing-elu-folder')), /does not exist/);
  assert.equal(unshare('app').root, root);
  assert.deepEqual(shares().map(x => x.handle), ['other']);
  assert.throws(() => unshare('app'), /No share/);
  fs.writeFileSync(peerFile('shares.json'), JSON.stringify([{ handle: '../bad', root: '/x', repoId: null, status: true, createdAt: 'x' }, 'junk']));
  assert.deepEqual(shares(), []);
});

test('each team has one project here; a rename follows it and an unshare drops it', (t) => {
  peerHome(t);
  const core = 'a'.repeat(64), docs = 'b'.repeat(64);
  const app = registeredProject(t), site = registeredProject(t);
  share(app.root, { handle: 'app' }); share(site.root, { handle: 'site' });
  assert.deepEqual(teamProjects(), {}); assert.equal(teamShare([core]), null);
  setTeamProject(core, 'app'); setTeamProject(docs, 'site');
  assert.equal(teamShare([core]).handle, 'app'); assert.equal(teamShare(['c'.repeat(64), docs, core]).handle, 'site', 'the first team with a project wins');
  setTeamProject(core, 'site'); assert.equal(teamShare([core]).handle, 'site', 'a later choice moves it');
  assert.throws(() => setTeamProject(core, 'nope'), /No share is named nope/);
  for (const id of ['core', 'A'.repeat(64), null]) assert.throws(() => setTeamProject(id, 'app'), /Choose a team/);
  share(site.root, { handle: 'www' }); assert.deepEqual(teamProjects(), { [core]: 'www', [docs]: 'www' });
  unshare('www'); assert.deepEqual(teamProjects(), {}); assert.equal(teamShare([core, docs]), null);
  fs.writeFileSync(peerFile('team-projects.json'), JSON.stringify({ [core]: 'app', short: 'app', [docs]: '../x' }));
  assert.deepEqual(teamProjects(), { [core]: 'app' });
});

// secrets.mjs

test('secret scanning finds credentials', () => {
  const b64 = n => crypto.randomBytes(n).toString('base64').replace(/[+/=]/g, 'A');
  const jwt = keyLike('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');
  const begin = label => keyLike('-----BEGIN ', label, '-----'), sts = keyLike('ASIA', 'Y34FZKBOKMUTVV7A');
  const cases = [
    ['private-key', '', `${begin('OPENSSH PRIVATE KEY')}\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----`],
    ['private-key', '', begin('RSA PRIVATE KEY')], ['private-key', '', begin('PRIVATE KEY')],
    ['private-key', '', begin('ENCRYPTED PRIVATE KEY')], ['private-key', '', begin('PGP PRIVATE KEY BLOCK')],
    ['aws-access-key', 'key ', keyLike('AKIA', 'IOSFODNN7EXAMPLE')], ['aws-access-key', '', sts],
    ['github-token', '', `ghp_${'a1B2'.repeat(9)}`], ['github-token', '', `gho_${'Zz09'.repeat(9)}`], ['github-token', '', `ghs_${'Qq12'.repeat(9)}`],
    ['github-token', '', `ghu_${'Ww34'.repeat(9)}`], ['github-token', '', `github_pat_11ABCDEFG0${'x1_Y'.repeat(14)}`],
    ['anthropic-key', '', `sk-ant-api03-${b64(30)}`], ['openai-key', '', `sk-${b64(36)}1`], ['openai-key', '', `sk-proj-${b64(60)}9`],
    ['slack-token', '', keyLike('xoxb', '-1234567890-abcdefghij')], ['slack-token', '', keyLike('xoxp', '-123-456-789-abc')],
    ['google-api-key', '', `AIza${'Sy0_-'.repeat(7)}`], ['stripe-key', '', keyLike('sk_', 'live_4eC39HqLyjWDarjtT1zdp7dc')], ['stripe-key', '', keyLike('rk_', 'live_abcdefghijklmnop1234')],
    ['jwt', 'Bearer ', jwt], ['npm-token', '', `npm_${'Ab1'.repeat(12)}`],
    ['high-entropy', 'aws_secret=', keyLike('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY')], ['high-entropy', '', 'vAmVbhHlMdBWbegcq1jSMy0NM7XTN0nj5m_5p41Ww08'],
    ['high-entropy', 'password: ', 'Zx8+Qp3/Lm9kRt2wVb7Nc4Hs6Jd1Fg5Y'],
  ];
  for (const [kind, prefix, token] of cases) {
    const found = scanSecrets(`Here it is: ${prefix}${token}.`);
    assert.deepEqual(found, [{ kind, index: 'Here it is: '.length + prefix.length }], `${kind}: ${token}`);
  }
  assert.deepEqual(scanSecrets(`a ${sts} b ${jwt}`), [{ kind: 'aws-access-key', index: 2 }, { kind: 'jwt', index: 25 }]);
});
test('secret scanning leaves ordinary text alone', () => {
  const fine = [
    'Commit e3b0c44298fc1c149afbf4c8996fb92427ae41e4 fixed it; the blob is da39a3ee5e6b4b0d3255bfef95601890afd80709.',
    'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'Request 123e4567-e89b-12d3-a456-426614174000 and 6F9619FF-8B86-D011-B42D-00C04FC964FF.',
    'The coupon normaliser trims spaces, uppercases the code, and rejects anything longer than twenty characters. See src/coupon.mjs line 12.',
    'Short base64 aGVsbG8gd29ybGQ= is fine, so is dGVzdA==.',
    'Call getUserAccountSettingsForOrganization2 or useEffectHookForAuthenticationProviderV2Component.',
    'Files: lib/peer/identity/something/another/folderName2.mjs and node_modules/@a2a-js/sdk/dist/server/index.js',
    'Use risk-management-framework-2024-q1-final-version and the sk-learn option.',
    'A 32-char hex md5: 9e107d9d372bb6826bd81d3542a419d6. Long kebab: this-is-a-very-long-option-name-for-the-cli.',
  ];
  for (const text of fine) assert.deepEqual(scanSecrets(text), [], text);
  assert.deepEqual(scanSecrets(''), []); assert.deepEqual(scanSecrets(null), []);
});
test('a file path with random-named temp folders is not read as a secret, but a key-long random name in one is', () => {
  const temps = [
    '/var/folders/7k/xq2m3h1d5gs0qfz8r9t2wvbr0000gn/T/x',
    '/private/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/elu-Ab3xYz/r/x',
    '/tmp/su2-9SAVeT/x-link/tmp/elu-Qw8RtZ/project/notes/round.mjs',
    '/tmp/usage-signin-FnsHbp/x-link/tmp/elu-Qw8RtZ/a/src/billing.mjs',
    '~/Library/Caches/elu-Zx8Qp3Lm9kRt/T/su2-9SAVeT/round.mjs',
  ];
  for (const temp of temps) {
    assert.deepEqual(scanSecrets(`Fixing billing from ${temp} next.`), [], temp);
    assert.equal(prepareOutgoing(`Fixing billing from ${temp} next.`).ok, true, temp);
  }
  const key = 'vAmVbhHlMdBWbegcq1jSMy0NM7XTN0nj5m_5p41Ww08';
  assert.deepEqual(scanSecrets(`Read /run/secrets/${key} now.`), [{ kind: 'high-entropy', index: 'Read /run/secrets/'.length }]);
  assert.deepEqual(scanSecrets(`Key /${key.slice(0, 20)}/${key.slice(20)}.`), [{ kind: 'high-entropy', index: 4 }]);
});
test('a relative path with a random-looking name is not read as a secret, but a real secret in one is', () => {
  const relative = [
    'Support/CleanShot/media/media_8Qw4Rt2LmZ/CleanShot',
    '~/Library/Application Support/CleanShot/media/media_8Qw4Rt2LmZ/CleanShot 2026-11-12 at 10.14.07@2x.png',
    'private/var/folders/7k/xq2m3h1d5gs0qfz8r9t2wvbr0000gn/T/elu-Ab3xYz/r/x',
    './tmp/su2-9SAVeT/x-link/tmp/elu-Qw8RtZ/project/notes/round.mjs',
    '../build/cache-Zx8Qp3Lm9kRt/T/su2-9SAVeT/elu-Qw8RtZ/round.mjs',
    'Downloads/Zx8Qp3Lm9kRt2wVb7Nc4Hs6Jd1F/report-Qw8RtZ/notes',
  ];
  for (const file of relative) {
    assert.deepEqual(scanSecrets(`Fixing billing from ${file} next.`), [], file);
    assert.equal(prepareOutgoing(`Fixing billing from ${file} next.`).ok, true, file);
  }
  // A real secret inside such a path is still caught: a key-long random name, a token after = or :,
  // a named KEY=value, and a base64 key that holds a "/" (no plain word in it, so judged whole).
  const key = 'vAmVbhHlMdBWbegcq1jSMy0NM7XTN0nj5m_5p41Ww08', folder = 'Support/CleanShot/media/media_8Qw4Rt2LmZ';
  const caught = [
    ['high-entropy', `Read ${folder}/`, key], ['high-entropy', `Open ${folder}/upload?sig=`, key], ['high-entropy', `Open ${folder}/CleanShot:`, key],
    ['assignment', `In ${folder}/.env there is `, `API_KEY=${key.slice(0, 16)}`], ['high-entropy', 'Key ', `${key.slice(0, 20)}/${key.slice(20)}`],
    ['high-entropy', 'Key ', `${'wJalrXUtnFEMI/K7MDENG/'}${'bPxRfiCYEXAMPLEKEY'}`],
  ];
  for (const [kind, before, secret] of caught) assert.deepEqual(scanSecrets(`${before}${secret} now.`), [{ kind, index: before.length }], `${before}${secret}`);
  // A URL is judged whole, as before: a key split over its path is still caught.
  const hook = `https://hooks.example.com/services/T0A1B2C3D/B4E5F6G7H/${key.slice(0, 24)}`;
  assert.deepEqual(scanSecrets(`Post to ${hook} now.`).map(x => x.kind), ['high-entropy']);
});
test('a base64 key split by its own "/" under a folder named like secrets is caught, and names made of words are not', () => {
  const key = keyLike('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY');
  for (const folder of ['config/secrets/', '/run/secrets/', '~/.config/app/secrets/', 'secrets/', '.keys/', 'deploy/api-keys/', '/etc/app/tokens/', 'ops/credentials/', '~/vault/'])
    assert.deepEqual(scanSecrets(`Read ${folder}${key} now.`), [{ kind: 'high-entropy', index: `Read ${folder}`.length }], folder);
  // A plain folder between the two does not hide it, and the update is held.
  assert.deepEqual(scanSecrets(`Read config/secrets/prod/${key} now.`), [{ kind: 'high-entropy', index: 'Read config/secrets/prod/'.length }]);
  assert.equal(prepareOutgoing(`The key is in config/secrets/${key}.`).ok, false);
  const named = [
    'config/secrets/us-east-1/db-main-01/README-prod', 'infra/keys/eu-west-1/app-7f3a9c/id_ed25519-2024', 'lib/tokens/parser/lexer/index-v2/readme',
    '/etc/app/secrets/prod/us-east-1/db-main-01/password.txt', '~/.config/app/credentials/google-oauth2-client/web-2024-11/x86_64',
  ];
  for (const file of named) assert.deepEqual(scanSecrets(`See ${file} now.`), [], file);
  // No folder named like secrets: a macOS temporary folder is still a path, not a key.
  assert.deepEqual(scanSecrets('See /var/folders/7k/xq2m3h1d5gs0qfz8r9t2wvbr0000gn/T/elu-Ab3xYz/r/x now.'), []);
  assert.deepEqual(scanSecrets('See private/var/folders/7k/xq2m3h1d5gs0qfz8r9t2wvbr0000gn/T/elu-Ab3xYz/r/x now.'), []);
});
test('a base64 key that holds a "/" is caught even when a piece of it reads as a plain word or as the start of a path', () => {
  // One plain word among the pieces can be chance; a relative path has two or more.
  const keys = [keyLike('wJalrXUtnFEMI/', 'Kabc/bPxRfiCYEXAMPLEKEYzz9'), keyLike('Zx8Qp3Lm9kRt2wVb7Nc4/', 'Hsd/Jd1Fg5YwJalrXUtn'), keyLike('tmp/', 'Zx8Qp3Lm9kRt2wVb7Nc4Hs6Jd1Fg5Y+wJalr')];
  for (const key of keys) assert.deepEqual(scanSecrets(`Key ${key} now.`), [{ kind: 'high-entropy', index: 4 }], key);
  // A key that starts with "/" or holds "+/" is not a path: its first name is no folder such as /tmp or /Users.
  const slashed = [keyLike('/LdprlBuXLwOK/', 'fYFEKPjdGxsDFCLtSqn4mzSMNc'), keyLike('YhT8N9OMmxppoZWMocf2+/', 'dCy/7ZsIzReudniwD0'), keyLike('qKVd9oqm3iKT/5Cymr+/', 'BhIA/hc+BYzCGU7qjhkV')];
  for (const key of slashed) assert.deepEqual(scanSecrets(`Key ${key} now.`), [{ kind: 'high-entropy', index: 4 }], key);
});
test('paths are redacted outside the project and the home folder becomes ~', () => {
  const home = os.homedir(), root = path.join(home, 'work', 'sample app');
  const text = `Edit ${root}/src/coupon.mjs, not ${home}/.ssh/id_ed25519 or /etc/passwd or ${root}-old/x.js. See https://github.com/elu/app/blob/main/a.js, src/a/b.js, ~/notes/x and /ask @sara.`;
  assert.equal(redactPaths(text, { root }), 'Edit ~/work/sample app/src/coupon.mjs, not [path] or [path] or [path] app-old/x.js. See https://github.com/elu/app/blob/main/a.js, src/a/b.js, [path] and /ask @sara.');
  assert.equal(redactPaths('Read ~/.ssh/id_ed25519.'), 'Read [path].');
  assert.equal(redactPaths(`${home}/other/file.txt and /usr/local/bin/node`), '[path] and [path]');
  assert.equal(redactPaths('nul\u0000byte'), 'nulbyte');
});
test('a path with spaces in a folder or file name is cut whole, and a sentence after a path is kept', () => {
  const root = '/srv/shop', rest = 'Library/Application Support/CleanShot/media/media_8Qw4Rt2LmZ/CleanShot 2026-11-12 at 10.14.07@2x.png';
  const whole = [
    // In quotes, as a terminal writes a dropped file.
    [`Screenshot in '/Users/sam/${rest}' done.`, "Screenshot in '[path]' done."], [`Open "/Users/sam/${rest}".`, 'Open "[path]".'],
    [`See \`~/${rest}\` and src/a.js.`, 'See `[path]` and src/a.js.'], ["In '~/My Files/tax return 2025.pdf'.", "In '[path]'."],
    // With escaped spaces.
    [`Open /Users/sam/${rest.replaceAll(' ', '\\ ')} now.`, 'Open [path] now.'], ['Read ~/My\\ Files/notes.txt.', 'Read [path].'],
    // Without quotes: names after a space start with a capital letter or a digit, up to a known file ending or the last folder.
    [`Screenshot saved in ~/${rest}, tests next.`, 'Screenshot saved in [path], tests next.'], [`Done: fix in /Users/sam/${rest}.`, 'Done: fix in [path].'],
    ['The shots are in ~/Library/Application Support/CleanShot/media.', 'The shots are in [path].'], ['Look in /Users/sam/Library/Application Support/ first.', 'Look in [path] first.'],
    ['See ~/Desktop/Screenshot 2026-11-12 at 10.14.07 AM.png next.', 'See [path] next.'], ['See ~/Desktop/Screen Recording 2026-11-12 at 10.14.07 AM.MOV next.', 'See [path] next.'],
    ['Open /Applications/Visual Studio Code.app first.', 'Open [path] first.'], ['Kept in ~/Google Drive/My Drive/Q3 Plan/Budget 2026.xlsx.', 'Kept in [path].'],
    ['In /Users/sam/Library/Mobile Documents/com~apple~CloudDocs/Notes/Plan.md now.', 'In [path] now.'], ['Got ~/Downloads/report (1).pdf and ~/Downloads/Shot 2 (12).PNG.', 'Got [path] and [path].'],
    ['The shots (in ~/Library/Application Support/CleanShot/media) are new.', 'The shots (in [path]) are new.'],
  ];
  for (const [text, cut] of whole) {
    assert.equal(redactPaths(text, { root }), cut, text);
    assert.deepEqual(prepareOutgoing(text, { root }), { ok: true, text: cut, problems: [], pathsCut: true }, text);
  }
  const kept = [
    ['Working on /srv/notes/billing and src/billing.mjs, tests next.', 'Working on [path] and src/billing.mjs, tests next.'],
    ['Read ~/.ssh/config and wrote notes.md.', 'Read [path] and wrote notes.md.'], ['Run /usr/local/bin/node scripts/build.mjs twice.', 'Run [path] scripts/build.mjs twice.'],
    ['Saved it in ~/Downloads as Report.pdf.', 'Saved it in [path] as Report.pdf.'], ['Edit /etc/app/hosts and then README.md.', 'Edit [path] and then README.md.'],
    ['I read /var/log/syslog. Tests/a.mjs is next.', 'I read [path]. Tests/a.mjs is next.'], ['Fixed /srv/app/Makefile Then updated README.md.', 'Fixed [path] Then updated README.md.'],
    ['Moved /tmp/out/2024 and 3 files to src/a.js.', 'Moved [path] and 3 files to src/a.js.'], ["It's in /tmp/a/b and that's fine.", "It's in [path] and that's fine."],
  ];
  for (const [text, cut] of kept) assert.equal(redactPaths(text, { root }), cut, text);
  // A path inside the project is kept, spaces and quotes included; a quoted ~/ path never is.
  const home = os.homedir(), project = path.join(home, 'work', 'sample app');
  assert.equal(redactPaths(`Edit '${project}/src/My File.js' and '~/Other Notes/x.txt'.`, { root: project }), "Edit '~/work/sample app/src/My File.js' and '[path]'.");
  // The secret check still reads the text as written.
  const key = 'vAmVbhHlMdBWbegcq1jSMy0NM7XTN0nj5m_5p41Ww08';
  assert.equal(prepareOutgoing(`Open '/Users/sam/My Keys/${key}' now.`, { root }).ok, false);
});
test('outgoing text is blocked on any secret and redacted either way', () => {
  const root = path.join(os.homedir(), 'proj');
  const clean = prepareOutgoing(`Look at ${root}/src/a.js and /var/log/system.log.`, { root });
  assert.deepEqual(clean, { ok: true, text: 'Look at ~/proj/src/a.js and [path].', problems: [], pathsCut: true });
  const dirty = prepareOutgoing(`Token ghp_${'a1B2'.repeat(9)} in /etc/app/conf`, { root });
  assert.equal(dirty.ok, false); assert.deepEqual(dirty.problems, [{ kind: 'github-token', index: 6 }]);
  assert.equal(dirty.text.includes('/etc/app/conf'), false);
  for (const [text, kind] of [['Clone https://ana:Hunter2-prod@git.example.com/app.git', 'url-credentials'], ['Set DB_PASSWORD=Tr0ub4dor&3 first.', 'assignment'], ['password: "hunter22"', 'assignment']])
    assert.equal(prepareOutgoing(text, { root }).problems[0]?.kind, kind, text);
  for (const text of ['const API_KEY = process.env.API_KEY', 'apiKey: string;', 'SECRET_KEY_BASE=${SECRET}', 'Set TOKEN=<your token>', 'git@github.com:elu/app.git'])
    assert.equal(prepareOutgoing(text, { root }).ok, true, text);
});
test('a trusted peer gets paths as written, the secret scan still applies, and trust is a per-peer flag', (t) => {
  const home = os.homedir(), root = path.join(home, 'proj');
  const text = `Run ${home}/evals/run.json with ~/.ssh/config and ${root}/src/a.js.`;
  assert.deepEqual(prepareOutgoing(text, { root, trusted: true }), { ok: true, text, problems: [], pathsCut: false });
  const cut = prepareOutgoing(text, { root });
  assert.deepEqual(cut, { ok: true, text: 'Run [path] with [path] and ~/proj/src/a.js.', problems: [], pathsCut: true });
  assert.deepEqual(prepareOutgoing(text, { root, trusted: false }), cut, 'untrusted output is unchanged');
  assert.equal(prepareOutgoing(`See ${root}/src/a.js only.`, { root }).pathsCut, false, 'a path inside the repository is not a cut');
  assert.equal(prepareOutgoing('Nothing here, not even [path].', { root }).pathsCut, false);
  const secret = prepareOutgoing(`Token ghp_${'a1B2'.repeat(9)} in ${home}/x/y`, { root, trusted: true });
  assert.equal(secret.ok, false); assert.deepEqual(secret.problems, [{ kind: 'github-token', index: 6 }]); assert.ok(secret.text.endsWith(`${home}/x/y`));
  withHome(newHome(t), () => {
    const key = 'b'.repeat(64);
    assert.equal(peerPolicy(key).trusted, false); assert.equal(DEFAULT_PEER_POLICY.trusted, false);
    assert.equal(savePeerPolicy(key, { trusted: true }).trusted, true); assert.equal(peerPolicy(key).trusted, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(peerFile('peers.json'), 'utf8'))[key], { ...DEFAULT_PEER_POLICY, trusted: true });
    assert.throws(() => savePeerPolicy(key, { trusted: 'yes' }), /trusted must be true or false/);
    assert.equal(peerPolicy(key).trusted, true, 'a refused save changes nothing');
    assert.equal(savePeerPolicy(key, { trusted: false }).trusted, false);
  });
});

test('a machine is called the first label of its host name until its owner names it, and takes only a short plain name', (t) => {
  // The default: the first label, without any character a box name cannot have, cut at 32, and box when nothing is left.
  for (const [host, box] of [['Anas-MacBook-Pro.local', 'Anas-MacBook-Pro'], ['build_7.ci.example.com', 'build_7'], ['ana', 'ana'], ['Ana\u2019s Mac mini.lan', 'AnasMacmini'], ['b\u00f8x 1', 'bx1'],
    [`${'h'.repeat(40)}.local`, 'h'.repeat(32)], ['', 'box'], ['.local', 'box'], ['\u00e9\u00e8 !.lan', 'box'], [null, 'box']])
    assert.equal(defaultBox(host), box, JSON.stringify(host));
  assert.equal(defaultBox(), defaultBox(os.hostname())); assert.match(defaultBox(), /^[A-Za-z0-9_-]{1,32}$/);
  assert.equal(DEFAULT_PEER_SETTINGS.box, null);
  withHome(newHome(t), () => {
    assert.equal(peerSettings().box, null); assert.equal(peerBox(), defaultBox(), 'unnamed, it goes by the host name');
    for (const box of ['ana-mbp', 'Studio.2', 'a', '_', 'x'.repeat(32)]) { assert.equal(savePeerSettings({ box }).box, box); assert.equal(peerBox(), box); }
    assert.equal(JSON.parse(fs.readFileSync(peerFile('settings.json'), 'utf8')).box, 'x'.repeat(32));
    savePeerSettings({ box: 'ana-mbp' });
    for (const box of ['', 'x'.repeat(33), 'my box', 'b\u00f8x', 'a/b', 'a\nb', '@ana', 7, true, ['ana'], { name: 'ana' }])
      assert.throws(() => savePeerSettings({ box }), /Name this machine with 1 to 32 letters, digits, dots, - or _\./, JSON.stringify(box));
    assert.equal(peerBox(), 'ana-mbp', 'a refused name changes nothing');
    // Another setting saved leaves the name alone; null goes back to the host name.
    assert.equal(savePeerSettings({ peerSlots: 2 }).box, 'ana-mbp'); assert.equal(peerBox(), 'ana-mbp');
    assert.equal(savePeerSettings({ box: null }).box, null); assert.equal(peerBox(), defaultBox());
    // A name written into the file by hand that is not one counts as none, and does not block other settings.
    fs.writeFileSync(peerFile('settings.json'), JSON.stringify({ box: 'not a box name', peerSlots: 2 }));
    assert.equal(peerBox(), defaultBox()); assert.equal(savePeerSettings({ peerSlots: 3 }).peerSlots, 3);
  });
});
