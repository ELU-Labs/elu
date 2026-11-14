import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { newHome, withHome, makeTeam } from './peer-helpers.mjs';
import { bothMine, markMine, markedMine, mineRows, noteTheirs, takeVouches, unmarkMine, vouches } from '../lib/peer/mine.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { createInvite, redeemCode } from '../lib/peer/invite.mjs';
import { head, merge, readLog } from '../lib/peer/roster.mjs';
import { verify } from '../lib/peer/canonical.mjs';
import { BINDING } from '../lib/peer/a2a.mjs';
import { PeerDaemon } from '../lib/peer/daemon.mjs';

// The owner's three computers on one team, mac, devbox and grokbox, and sara, a teammate.
// mac and devbox are his on both sides already; grokbox is new and marks nothing yet.
function threeComputers(t) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ana' });
  const side = (home, identity, name) => ({ home, identity, key: identity.key, name });
  const mac = side(team.founder.home, team.founder.identity, 'mac'), devbox = side(team.member.home, team.member.identity, 'devbox');
  const grokHome = newHome(t), saraHome = newHome(t);
  const grokbox = side(grokHome, withHome(grokHome, () => createIdentity({ name: 'ana' })), 'grokbox'), sara = side(saraHome, withHome(saraHome, () => createIdentity({ name: 'sara' })), 'sara');
  const log = withHome(mac.home, () => { for (const one of [grokbox, sara]) redeemCode(createInvite(mac.identity, team.teamId, { hours: 1 }), one.key, one.identity.name); return readLog(team.teamId).ops; });
  for (const one of [devbox, grokbox, sara]) withHome(one.home, () => { const { rejected } = merge(team.teamId, log); if (rejected.length) throw new Error(rejected[0].reason); });
  for (const [a, b] of [[mac, devbox], [devbox, mac]]) withHome(a.home, () => { markMine(a.key, b.key); noteTheirs(b.key, true); });
  return { team, mac, devbox, grokbox, sara };
}
const on = (side, fn) => withHome(side.home, fn);
// elu.mine: what one side says about the other, as each connection says it.
const said = (from, to) => { const mine = on(from, () => markedMine(to.key)); on(to, () => noteTheirs(from.key, mine)); };
// elu.own: what one of his computers tells another, signed by it, as the daemon sends it.
const message = (from, to) => on(from, () => vouches(from.identity, to.key));
const tell = (from, to, sent = message(from, to)) => on(to, () => takeVouches(to.key, from.key, sent));
const row = (side, other) => on(side, () => mineRows().find(item => item.key === other.key) ?? null);
const paired = (a, b) => on(a, () => bothMine(a.key, b.key)) && on(b, () => bothMine(b.key, a.key));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('one /mine on a new computer and one agreement on another of his makes it his on all three, with no step on the third', t => {
  const { mac, devbox, grokbox } = threeComputers(t);
  // On grokbox: /mine @mac. Mac hears it, and its row says grokbox says it is yours.
  on(grokbox, () => markMine(grokbox.key, mac.key)); said(grokbox, mac);
  assert.deepEqual([row(mac, grokbox).mine, row(mac, grokbox).theirs], [false, true]);
  // Not his on both sides yet: grokbox tells mac nothing, and mac takes nothing from it.
  assert.throws(() => tell(grokbox, mac), { message: 'Only your own computers say which computers are yours.' });
  // On mac: Enter agrees.
  on(mac, () => markMine(mac.key, grokbox.key)); said(mac, grokbox);
  assert.equal(paired(mac, grokbox), true);
  // Mac tells each computer of his what it knows: devbox to grokbox, grokbox to devbox.
  assert.deepEqual(tell(mac, grokbox), { marked: [devbox.key], unmarked: [] });
  assert.deepEqual(tell(mac, devbox), { marked: [grokbox.key], unmarked: [] });
  // Each says so to the other on their own connection: no step on devbox.
  said(grokbox, devbox); said(devbox, grokbox);
  assert.equal(paired(devbox, grokbox), true, 'devbox and grokbox are his on both sides');
  assert.deepEqual([row(devbox, grokbox).auto, row(devbox, grokbox).by], ['vouch', mac.key], 'marked because mac said so');
  // Told again, nothing changes; and what any of them tells another now changes nothing.
  for (const [a, b] of [[mac, devbox], [devbox, grokbox], [grokbox, devbox], [grokbox, mac], [devbox, mac]]) assert.deepEqual(tell(a, b), { marked: [], unmarked: [] }, `${a.name} to ${b.name}`);
});

test("a teammate's computer can never vouch, and a list signed by another, or made for another computer, is not taken", t => {
  const { mac, devbox, grokbox, sara } = threeComputers(t);
  // Sara says grokbox is the owner's: mac takes nothing from her, even after he marked her by mistake.
  const fromSara = on(sara, () => vouches(sara.identity, mac.key, [{ key: grokbox.key, mine: true, at: new Date().toISOString() }]));
  assert.throws(() => tell(sara, mac, fromSara), { message: 'Only your own computers say which computers are yours.' });
  on(mac, () => markMine(mac.key, sara.key));
  assert.throws(() => tell(sara, mac, fromSara), { message: 'Only your own computers say which computers are yours.' });
  assert.equal(row(mac, grokbox), null, 'grokbox is not marked');
  // Sent over devbox's connection, but signed by sara: not taken.
  const facts = [{ key: grokbox.key, mine: true, at: new Date().toISOString() }];
  const forged = { ...on(sara, () => vouches(sara.identity, mac.key, facts)), by: devbox.key };
  assert.throws(() => tell(devbox, mac, forged), { message: 'That list is not signed by the computer that sent it.' });
  // Signed by devbox for grokbox, and sent on to mac: not taken.
  const elsewhere = on(devbox, () => vouches(devbox.identity, grokbox.key, facts));
  assert.throws(() => tell(devbox, mac, elsewhere), { message: 'That list is not signed by the computer that sent it.' });
  // Devbox vouching for sara, a key it does not hold as his: never sent; and a list that says
  // so anyway marks only keys on a team with mac.
  assert.deepEqual(on(devbox, () => vouches(devbox.identity, mac.key)).facts, [], 'devbox knows no other computer of his');
  const stranger = 'f'.repeat(64);
  assert.deepEqual(tell(devbox, mac, on(devbox, () => vouches(devbox.identity, mac.key, [{ key: stranger, mine: true, at: new Date().toISOString() }]))), { marked: [], unmarked: [] });
  assert.equal(row(mac, { key: stranger }), null);
});

test('/mine remove on one of his computers is carried to the others, and an older word does not bring it back', async t => {
  const { mac, devbox, grokbox } = threeComputers(t);
  on(grokbox, () => markMine(grokbox.key, mac.key)); said(grokbox, mac); on(mac, () => markMine(mac.key, grokbox.key)); said(mac, grokbox);
  const before = message(mac, devbox);
  tell(mac, devbox, before); tell(mac, grokbox); said(grokbox, devbox); said(devbox, grokbox);
  assert.equal(paired(devbox, grokbox), true);
  await wait(5);
  // On mac: /mine remove @grokbox.
  on(mac, () => unmarkMine(grokbox.key)); said(mac, grokbox);
  assert.deepEqual(tell(mac, devbox), { marked: [], unmarked: [grokbox.key] }, 'devbox is told');
  said(devbox, grokbox);
  assert.equal(paired(devbox, grokbox), false);
  assert.equal(paired(mac, grokbox), false);
  assert.deepEqual([row(devbox, grokbox).mine, row(devbox, grokbox).refused], [false, true]);
  // Grokbox is no longer his on either: it can tell them nothing.
  assert.throws(() => tell(grokbox, devbox), { message: 'Only your own computers say which computers are yours.' });
  // What mac said before, told again, does not mark it back: the removal is newer.
  assert.deepEqual(tell(mac, devbox, before), { marked: [], unmarked: [] });
  // Devbox tells mac it is not his either; mac knew. Then the owner marks it again on mac: newer, so it is carried.
  assert.deepEqual(tell(devbox, mac), { marked: [], unmarked: [] });
  await wait(5);
  on(mac, () => markMine(mac.key, grokbox.key));
  assert.deepEqual(tell(mac, devbox), { marked: [grokbox.key], unmarked: [] });
});

test('0.1.25 beside 0.1.26: an older computer is told nothing and is noted, a teammate is told nothing, and what one of his says marks the computer and tells it', t => {
  const { team, mac, devbox, grokbox, sara } = threeComputers(t);
  on(grokbox, () => markMine(grokbox.key, mac.key)); said(grokbox, mac); on(mac, () => markMine(mac.key, grokbox.key)); said(mac, grokbox);
  on(mac, () => {
    const daemon = Object.assign(new PeerDaemon({ conductor: () => {} }), { me: mac.identity, node: { dial() {}, leave() {} } }); daemon.methods = daemon.extensions();
    assert.equal(daemon.hello(devbox.key).own, 1, 'this build says in its hello that it takes them');
    const connect = (key, extra) => {
      const wire = { out: '' }, socket = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; this.emit('close'); }, write: chunk => { wire.out += chunk; return true; } });
      daemon.attach(socket, key);
      socket.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'elu.hello', params: { binding: BINDING, a2aVersion: '1.0', name: 'ana', teams: [{ id: team.teamId, ...head(team.teamId), ops: [] }], handles: [], ...extra } })}\n`));
      const frames = method => wire.out.split('\n').flatMap(line => { try { const frame = JSON.parse(line); return frame.method === method ? [frame] : []; } catch { return []; } });
      return { frames, say: frame => socket.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)), close: () => socket.destroy() };
    };
    const NEW = { plans: true, remote: 1, lists: 1, notes: 1, own: 1 }, OLD = { plans: true, remote: 1, lists: 1, notes: 1 };
    // Devbox on this build: told grokbox is his, signed by mac.
    const toBox = connect(devbox.key, NEW);
    daemon.tellOwn();
    const sent = toBox.frames('elu.own').at(-1)?.params;
    assert.deepEqual([sent?.by, sent?.to, sent?.facts.map(fact => [fact.key, fact.mine])], [mac.key, devbox.key, [[grokbox.key, true]]]);
    assert.equal(verify(mac.key, { by: sent.by, to: sent.to, facts: sent.facts }, sent.sig), true);
    // Sara, a teammate on this build: told nothing.
    const toSara = connect(sara.key, NEW);
    daemon.tellOwn();
    assert.deepEqual(toSara.frames('elu.own'), []);
    // Devbox on 0.1.25: told nothing, and its row says it cannot take it.
    toBox.close();
    const older = connect(devbox.key, OLD);
    daemon.tellOwn();
    assert.deepEqual(older.frames('elu.own'), []);
    assert.equal(mineRows().find(item => item.key === devbox.key).older, true);
    older.close();
    // Grokbox connected, on this build. Devbox comes back updated and says a new computer is his: mac marks it and tells it.
    const toGrok = connect(grokbox.key, NEW), back = connect(devbox.key, NEW);
    daemon.tellOwn();
    assert.equal(mineRows().find(item => item.key === devbox.key).older, false, 'updated, it takes them');
    const fourth = withHome(newHome(t), () => createIdentity({ name: 'ana' }));
    redeemCode(createInvite(mac.identity, team.teamId, { hours: 1 }), fourth.key, 'ana');
    const word = withHome(devbox.home, () => vouches(devbox.identity, mac.key, [{ key: fourth.key, mine: true, at: new Date().toISOString() }]));
    const toFourth = connect(fourth.key, OLD);
    back.say({ method: 'elu.own', params: word });
    assert.equal(markedMine(fourth.key), true);
    assert.deepEqual(toFourth.frames('elu.mine').map(frame => frame.params.mine).at(-1), true, 'and tells it, on 0.1.25 too');
    // What sara says on her connection is not taken.
    toSara.say({ method: 'elu.own', params: withHome(sara.home, () => vouches(sara.identity, mac.key, [{ key: 'e'.repeat(64), mine: true, at: new Date().toISOString() }])) });
    assert.equal(markedMine('e'.repeat(64)), false);
    void toGrok;
    daemon.closed = true; clearInterval(daemon.timer);
  });
  // On grokbox, devbox on 0.1.25 marked because mac said so: it waits on devbox, which cannot take it.
  on(grokbox, () => takeVouches(grokbox.key, mac.key, withHome(mac.home, () => vouches(mac.identity, grokbox.key))));
  assert.deepEqual([row(grokbox, devbox).mine, row(grokbox, devbox).auto], [true, 'vouch']);
  // The one-by-one way still pairs them: /mine @grokbox on devbox.
  said(grokbox, devbox); on(devbox, () => markMine(devbox.key, grokbox.key)); said(devbox, grokbox);
  assert.equal(paired(devbox, grokbox), true);
});
