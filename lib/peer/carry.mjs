import fs from 'node:fs';
import crypto from 'node:crypto';
import { EluCodeError, atomic, isObject, noSymlinks, readJson, refuse } from '../util.mjs';
import { peerFile } from './paths.mjs';
import { MISSING } from './transport.mjs';
import { bothMine } from './mine.mjs';
import { sharedTeams } from './intake.mjs';
import { openInvites, openRelays, relayKeys, sealRelays } from './invite.mjs';
import { NOT_FOUND, NO_ANSWER, noRoute } from './join-text.mjs';

// Passing a connection along (docs/peer-network.md, "When two computers cannot connect").
// Two computers whose networks will not connect directly reach each other through a third
// that both can reach: a teammate's daemon, or another computer of one's own. That daemon
// runs a blind relay for the one pair it was asked for. It forwards bytes it cannot read,
// and lets in those two keys only, on a key pair made for the pair, so neither can use it to
// reach anyone else and nobody else can use it at all.
const HEX64 = /^[0-9a-f]{64}$/, isKey = value => typeof value === 'string' && HEX64.test(value);
// A grant lasts CARRY_MS unless it is asked for again; whoever asked does that every RENEW_MS.
// One daemon carries at most CARRY_MAX pairs, CARRY_EACH for one teammate, and asks HELPERS computers.
export const CARRY_MS = 10 * 60000, RENEW_MS = 3 * 60000, CARRY_MAX = 16, CARRY_EACH = 6, HELPERS = 2;

// The side that carries. grant(by, a, b) -> the key of the relay that lets a and b in.
// A grant that ran out lets nobody new in; a connection already flowing ends when either
// side hangs up, and only then is its relay closed.
export function createCarrier(node, seed) {
  const grants = new Map(), ending = new Map(); let BlindRelay = null;
  const end = (id, row) => { grants.delete(id); const closed = Promise.allSettled([row.relay.close(), row.server?.close()]).then(() => { if (ending.get(id) === closed) ending.delete(id); }); ending.set(id, closed); };
  const sweep = (now = Date.now()) => { for (const [id, row] of grants) if (row.until <= now && !row.sockets.size) end(id, row); };
  return {
    grants, sweep,
    async grant(by, a, b, now = Date.now()) {
      sweep(now);
      const [x, y] = [a, b].sort(), id = x + y;
      await ending.get(id);
      let row = grants.get(id);
      if (!row) {
        if (grants.size >= CARRY_MAX || [...grants.values()].filter(grant => grant.by === by).length >= CARRY_EACH) refuse('This computer is passing along as many connections as it can.');
        try { BlindRelay ??= (await import('blind-relay')).default; } catch { refuse(MISSING); }
        if (grants.has(id)) return this.grant(by, a, b, now);
        const keyPair = node.keyPair(crypto.createHash('sha256').update('elu-code carry\0').update(seed).update(id).digest());
        const relay = new BlindRelay.Server({ createStream: opts => node.dht.createRawStream({ ...opts, framed: true }) });
        row = { by, a: x, b: y, key: keyPair.publicKey.toString('hex'), relay, sockets: new Set(), until: now + CARRY_MS, server: null, ready: null };
        row.server = node.dht.createServer({ firewall: remote => { const key = Buffer.from(remote).toString('hex'); return !(row.until > Date.now() && (key === x || key === y)); } }, socket => {
          row.sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => row.sockets.delete(socket));
          relay.accept(socket, { id: socket.remotePublicKey }).on('error', () => {});
        });
        grants.set(id, row);
        row.ready = row.server.listen(keyPair);
        row.ready.catch(() => { if (grants.get(id) === row) end(id, row); });
      }
      row.until = now + CARRY_MS; row.by = by;
      await row.ready;
      return row.key;
    },
  };
}

// routes.json: for each teammate this machine reaches only through a relay, {mine: [{helper,
// relay}], theirs: [relay], told: [{helper, relay}]}: the relays its own helpers gave it,
// which it asks for again, the ones the teammate told it, which the teammate asks for
// again, and which computer the teammate said runs each of those.
const file = () => peerFile('routes.json');
const pairs = list => (Array.isArray(list) ? list : []).filter(entry => isKey(entry?.helper) && isKey(entry?.relay)).slice(0, 4).map(({ helper, relay }) => ({ helper, relay }));
const cleanRow = row => ({ mine: pairs(row?.mine), theirs: (Array.isArray(row?.theirs) ? row.theirs : []).filter(isKey).slice(0, 4), told: pairs(row?.told) });
export function savedRoutes() {
  try { noSymlinks(file()); if (!fs.existsSync(file())) return {}; const all = readJson(file()); return isObject(all) ? Object.fromEntries(Object.entries(all).filter(([key]) => HEX64.test(key)).slice(0, 256).map(([key, row]) => [key, cleanRow(row)])) : {}; } catch { return {}; }
}
const relaysOf = row => [...new Set([...row.mine.map(entry => entry.relay), ...row.theirs])];
function change(d, key, update) {
  const all = savedRoutes(), next = update(all[key] ?? null);
  if (next) all[key] = cleanRow(next); else delete all[key];
  atomic(file(), all); fs.chmodSync(file(), 0o600);
  d.node.route?.(key, next ? relaysOf(all[key]) : []);
}
// At start: every saved route is used from the first dial.
export function applyRoutes(d) { for (const [key, row] of Object.entries(savedRoutes())) d.node.route?.(key, relaysOf(row)); }
// This machine reached key only through a relay: the route is kept, with the relays its own
// helpers gave for it, which the other side is told and which are asked for again from now on.
export function needRoute(d, key, mine = []) {
  change(d, key, row => ({ ...row, mine: mine.length ? mine : row?.mine ?? [], theirs: row?.theirs ?? [] })); d.carryAt = 0;
  const session = d.ctx.session(key); if (session) tellRoute(d, session);
}

// The teammates connected now that can carry, another computer of mine first. One this
// machine itself reaches only through a relay is not asked: its relay would be no nearer.
// near: only those on a team with that key, up to NEAR of them: each knows whether it reaches it.
const NEAR = 8;
function helpers(d, except, near = null) {
  return [...d.sessions.values()].filter(session => session.admitted && !session.departed && session.remoteHello?.carry === 1 && !except.includes(session.key) && !d.node.connections?.get(session.key)?.via && (!near || sharedTeams(session.key, near).length > 0))
    .sort((a, b) => Number(bothMine(d.me.key, b.key)) - Number(bothMine(d.me.key, a.key))).slice(0, near ? NEAR : HELPERS);
}
// Asks them to pass my connection with other along: [{helper, relay}], one for each that
// agreed, HELPERS at most. A helper on a team with other is asked to do it only while it
// reaches other itself (reach), so it makes no relay that could not work. team: only such
// helpers are asked, as for two teammates.
export async function askCarry(d, other, except = [other], { team = false } = {}) {
  const asked = await Promise.all(helpers(d, except, team ? other : null).map(async session => {
    const reach = team || sharedTeams(session.key, other).length > 0;
    try { const reply = await session.request('elu.carry', { with: other, ...(reach ? { reach: true } : {}) }, { timeoutMs: 20000 }); return isKey(reply?.relay) ? { helper: session.key, relay: reply.relay } : null; }
    catch (error) { d.log(`carry by ${session.key.slice(0, 8)}: ${error.message}`); return null; }
  }));
  return asked.filter(Boolean).slice(0, HELPERS);
}
// For a route that is kept: the computers on a team with that teammate that reach it, else
// any that agree (after a join, another computer of mine that is on no team with them).
const carriersFor = async (d, key) => { const near = await askCarry(d, key, [key], { team: true }); return near.length ? near : askCarry(d, key); };
// For a join: the relays that may carry it. This machine's helpers are asked to let the
// inviter in. The inviter's helpers are read from the record it published for the code;
// they let in the key pair the code gives, so that is the one this machine shows them.
export async function joinRelays(d, keys, inviter) {
  const secret = relayKeys(keys.prover);
  // Both at once: reading the record is a lookup on the DHT, and can take seconds.
  const [mine, theirs] = await Promise.all([askCarry(d, inviter), d.node.getRecord(secret.record).then(value => openRelays(secret.box, value), error => { d.log(`invite relays: ${error.message}`); return []; })]);
  for (const relay of theirs) d.node.relayAs(relay, secret.joiner);
  return { mine, theirs };
}
// Who carries, as the person joining reads it.
export function helperName(d, key) {
  if (!key) return 'a computer on their side';
  const clean = value => String(value ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 32), box = clean(d.machines.get(key)?.box), name = clean(d.name(key));
  return bothMine(d.me.key, key) ? `your computer ${box || name}` : `${name}'s computer`;
}

// How a dial ends when the other computer answered but the two could not connect.
const BLOCKED = new Set(['HOLEPUNCH_ABORTED', 'HOLEPUNCH_DOUBLE_RANDOMIZED_NATS', 'HOLEPUNCH_PROBE_TIMEOUT', 'CANNOT_HOLEPUNCH', 'REMOTE_NOT_HOLEPUNCHABLE', 'REMOTE_NOT_HOLEPUNCHING', 'REMOTE_ABORTED', 'RELAY_ABORTED']);
// hyperdht lets a network that gives each connection a new port punch once every 20 s, and
// waits 10 to 20 s itself before it tries one again. A try that was refused waits the same.
const punchWait = () => 10000 + Math.round(Math.random() * 10000);
// A join's way to whoever announces its code (daemon.mjs, joinShort). step() runs twice a
// second and returns {look, stage, via, error}. look: look the topic up now, which is also
// what dials a found computer again. stage and via: what the app shows. error: what to give
// up with, once it is time. Nobody found gives up after timeoutMs. A computer that was found
// and answered, but could not be connected to, is tried again for connectMs in all: directly
// at the pace above, and through every relay there is as soon as one direct try has failed
// or taken 4 s.
export function joinWay(d, keys, { timeoutMs, connectMs, started = Date.now() }) {
  const seen = new Map(), routed = new Set(); let relays = null, asking = false, askedAt = 0, lookAt = 0;
  const due = (now, ms) => { if (now < lookAt) return false; lookAt = now + ms; return true; };
  const names = () => relays ? [...relays.mine.map(entry => helperName(d, entry.helper)), ...(relays.theirs.length ? [helperName(d, null)] : [])] : [];
  return {
    routed, relays: () => relays,
    step(now = Date.now()) {
      for (const dial of d.node.dialsOn?.(keys.topic) ?? []) {
        // A try of an earlier join with this code says nothing about who is there now.
        if (dial.startedAt < started) continue;
        const row = seen.get(dial.key) ?? { key: dial.key, blocked: null, opened: false, nextAt: 0, ended: null };
        seen.delete(dial.key); seen.set(dial.key, row); row.dial = dial; row.opened ||= dial.open;
        if (dial.endedAt === null || dial.open || row.ended === dial.endedAt) continue;
        row.ended = dial.endedAt;
        if (BLOCKED.has(dial.code)) row.blocked = { remote: dial.remote ?? row.blocked?.remote ?? null, local: dial.local ?? row.blocked?.local ?? null };
        row.nextAt = dial.endedAt + (BLOCKED.has(dial.code) ? d.testing.join?.retryMs ?? punchWait() : 0);
        d.log(`invite join: found ${dial.key.slice(0, 8)}, try ${dial.tries}${dial.relay ? ' through a relay' : ''} failed: ${dial.code ?? 'ended'}`);
      }
      const rows = [...seen.values()], waited = now - started;
      if (!rows.length) return { look: due(now, 3000), stage: 'looking', via: null, error: waited >= timeoutMs ? new EluCodeError(NOT_FOUND) : null };
      // The computer to reach: one that answered, else the one found last.
      const target = rows.findLast(row => row.blocked) ?? rows.at(-1), dial = target.dial;
      if (!asking && now - askedAt >= 15000 && !(relays?.key === target.key && names().length)) {
        asking = true; askedAt = now;
        joinRelays(d, keys, target.key).then(got => { relays = { key: target.key, ...got }; }, error => d.log(`invite relays: ${error.message}`)).finally(() => { asking = false; });
      }
      const all = relays?.key === target.key ? [...new Set([...relays.mine.map(entry => entry.relay), ...relays.theirs])] : [];
      if (all.length && !routed.has(target.key) && !dial.open && (dial.endedAt !== null || now - dial.startedAt >= 4000)) {
        routed.add(target.key); d.node.route(target.key, all); d.node.redial(target.key); target.nextAt = 0; lookAt = 0;
        d.log(`invite join: trying ${target.key.slice(0, 8)} through ${names().join(' and ')}`);
      }
      const look = !dial.pending && !dial.open && now >= target.nextAt && due(now, 3000);
      const stage = routed.has(target.key) ? 'relay' : target.ended ? 'retrying' : 'connecting', opened = rows.some(row => row.opened), blocked = rows.findLast(row => row.blocked)?.blocked;
      // One that connected and still did not join is the code's doing (used, or not this code): a minute, as when nobody is found.
      const error = waited < (blocked && !opened ? connectMs : timeoutMs) ? null
        : new EluCodeError(opened ? NOT_FOUND : blocked ? noRoute({ theirs: blocked.remote, mine: blocked.local, tried: names() }) : NO_ANSWER);
      return { look, stage, via: stage === 'relay' ? names()[0] : null, error };
    },
    // Who carried the connection to key, by the relay it runs through; null for a direct one.
    carried(key) {
      const relay = d.node.connections?.get(key)?.via; if (!relay) return null;
      const mine = relays?.mine.find(entry => entry.relay === relay);
      return { name: helperName(d, mine?.helper ?? null), mine: relays?.key === key ? relays.mine : [] };
    },
  };
}

export function carryMethods(d) {
  return {
    // A teammate asks this machine to pass along its connection with one other key.
    'elu.carry': async (params, session) => {
      if (!d.teammateKeys().includes(session.key)) refuse('You are not on a team with this machine.');
      if (!isObject(params) || !isKey(params.with) || params.with === session.key || params.with === d.me.key) refuse('Name the other computer by its key.');
      // online: this machine reaches the other one itself, directly. reach: the teammate wants
      // the relay only then, as for two teammates, so both keys it lets in are on a team with this machine.
      const online = Boolean(d.ctx.session(params.with)) && !d.node.connections?.get(params.with)?.via;
      if (params.reach === true && !online) return { relay: null, online };
      const fresh = !d.carrier?.grants.has([session.key, params.with].sort().join(''));
      const relay = await (d.carrier ??= createCarrier(d.node, d.me.seed)).grant(session.key, session.key, params.with);
      // Asked again every few minutes: said once for each pair.
      if (fresh) d.log(`passing along ${session.key.slice(0, 8)} and ${params.with.slice(0, 8)}`);
      return { relay, ms: CARRY_MS, online };
    },
    // A teammate says which relays its helpers run for the two of us.
    'elu.route': (params, session) => {
      if (!session.admitted || !d.teammateKeys().includes(session.key) || !isObject(params) || !Array.isArray(params.relays)) return null;
      const theirs = params.relays.filter(isKey).slice(0, 4), had = savedRoutes()[session.key];
      // by: the computer that runs each one, in the same order, for the name the roster shows.
      const told = pairs(theirs.map((relay, index) => ({ relay, helper: Array.isArray(params.by) ? params.by[index] : null })));
      // Told again at every upkeep: only a change is written.
      if (JSON.stringify([had?.theirs, had?.told]) !== JSON.stringify([theirs, told])) change(d, session.key, row => ({ mine: row?.mine ?? [], theirs, told }));
      return null;
    },
  };
}
// The relays of mine for a teammate, told to them when they connect, when they change and at each upkeep.
export function tellRoute(d, session) {
  const row = savedRoutes()[session.key];
  if (row?.mine.length && session.remoteHello?.carry === 1) session.notify('elu.route', { relays: row.mine.map(entry => entry.relay), by: row.mine.map(entry => entry.helper) });
}
// Which computer carries the connection to a teammate, as the roster names it; null for a direct one.
export function carrierName(d, key, routes = savedRoutes()) {
  const relay = d.node.connections?.get(key)?.via; if (!relay) return null;
  const row = routes[key], helper = row?.mine.find(entry => entry.relay === relay)?.helper ?? row?.told.find(entry => entry.relay === relay)?.helper ?? null;
  if (helper && d.teammateKeys().includes(helper)) return helperName(d, helper);
  // A relay someone runs for the team (elu relay), or one of a computer this machine does not know.
  return d.myTeams().some(state => state.relays.includes(relay)) ? 'a relay' : 'another computer';
}

// --- Two teammates who cannot connect directly (docs/peer-network.md, "When two computers
// cannot connect"). ways: for each teammate, what the tries to reach it said.
// - Not connected, and the last dial said their computer answered but the two could not
//   connect (BLOCKED): every computer on a team with them that this machine reaches
//   directly is asked whether it reaches them too, and to carry. With a relay the route is
//   kept (needRoute) and the teammate is dialled again at once. Each of those dials is a
//   direct try too. It is done again after WAY_MS, then twice as long each time up to
//   WAY_MAX_MS, and at once when a computer that can carry connects.
// - Connected through a relay: the side with the smaller key tries a direct connection
//   every DIRECT_MS (probe), and connects afresh when one works; hyperdht then moves the
//   new connection to the direct path.
export const WAY_MS = 15000, WAY_MAX_MS = 5 * 60000, DIRECT_MS = 5 * 60000, DIRECT_MAX_MS = 60 * 60000;
export function teamTick(d, now = Date.now()) {
  if (!d.node?.dialOf) return;
  const ways = d.ways ??= new Map(), mates = d.teammateKeys(), woke = d.wayWoke === true; d.wayWoke = false;
  const pace = d.testing.join?.wayMs ?? WAY_MS, direct = d.testing.join?.directMs ?? DIRECT_MS;
  for (const key of [...ways.keys()]) if (!mates.includes(key)) ways.delete(key);
  for (const key of mates) {
    const row = ways.get(key) ?? { blocked: null, noWay: false, seenAt: 0, kicked: false, nextAt: 0, wait: 0, throughAt: 0, busy: false, kept: false, probeAt: 0, probeWait: 0 }; ways.set(key, row);
    const conn = d.node.connections.get(key);
    if (conn && d.ctx.session(key)) {
      Object.assign(row, { blocked: null, noWay: false, seenAt: now, kicked: false, nextAt: 0, wait: 0, throughAt: 0 });
      const via = conn.via;
      if (!via) { row.probeAt = 0; row.probeWait = 0; row.kept = false; continue; }
      // The other side dialled through a relay of its own helper: this side keeps the route
      // too, and asks its own helpers, so either can find the other again.
      if (!row.kept) { row.kept = true; if (!d.node.routeOf(key).includes(via) && !d.myTeams().some(state => state.relays.includes(via))) { try { needRoute(d, key); } catch (error) { d.log(`route: ${error.message}`); } } }
      if (d.me.key > key || row.busy) continue;
      if (!row.probeAt) { row.probeWait = row.probeWait ? Math.min(row.probeWait * 2, DIRECT_MAX_MS) : direct; row.probeAt = now + row.probeWait; continue; }
      if (now < row.probeAt) continue;
      row.busy = true; row.probeAt = 0;
      d.node.probe(key).then(works => { if (works && !d.closed) { d.log(`a direct connection to ${key.slice(0, 8)} works again: connecting afresh`); d.node.reconnect(key); } }, () => {}).finally(() => { row.busy = false; });
      continue;
    }
    row.kept = false; row.probeAt = 0;
    const dial = d.node.dialOf(key), since = row.seenAt;
    // What a try made since the two were last connected said: blocked, or their computer is not there.
    if (dial && !dial.pending && !dial.open && dial.startedAt >= since) {
      row.blocked = BLOCKED.has(dial.code) ? { remote: dial.remote ?? row.blocked?.remote ?? null, local: dial.local ?? row.blocked?.local ?? null } : null;
      // A try through a relay that ended the same way: no computer got it through.
      if (row.blocked && row.throughAt && dial.startedAt >= row.throughAt) row.noWay = true;
      if (!row.blocked) Object.assign(row, { noWay: false, nextAt: 0, wait: 0, throughAt: 0 });
    } else if (since && !row.kicked && !dial?.pending && now - since >= 3000) {
      // The connection went and this machine has not tried since (the other side had dialled): one try now.
      row.kicked = true; d.node.dial(key);
    }
    if (!row.blocked || row.busy || dial?.pending || (now < row.nextAt && !woke)) continue;
    row.wait = row.wait ? Math.min(row.wait * 2, WAY_MAX_MS) : pace; row.nextAt = now + row.wait; row.busy = true;
    askCarry(d, key, [key], { team: true }).then(mine => {
      if (d.closed || d.ctx.session(key)) return;
      const names = mine.map(entry => helperName(d, entry.helper)).join(' and ');
      if (mine.length) {
        if (JSON.stringify(savedRoutes()[key]?.mine) !== JSON.stringify(mine)) needRoute(d, key, mine);
        row.throughAt = Date.now();
      } else row.noWay = true;
      const said = mine.length ? `through ${names}` : 'no computer on the team reaches both';
      if (row.said !== said) { row.said = said; d.log(`${key.slice(0, 8)} is there but cannot be connected to directly: ${said}`); }
      d.node.dial(key);
    }, error => d.log(`way: ${error.message}`)).finally(() => { row.busy = false; });
  }
}
// Why a teammate that is not connected is not: 'blocked' when their computer is there, the
// two cannot connect directly, and no computer on the team got it through.
export const reachOf = (d, key) => { const row = d.ways?.get(key); return row?.blocked && row.noWay ? 'blocked' : null; };

// Every RENEW_MS, and at once when a helper connects, an invite is made or a join went
// through a relay: grants this machine gave are swept; each teammate it reaches through a
// relay is asked for again and told; each open invite's relays are asked for and published
// for whoever holds its code.
export async function carryTick(d, now = Date.now()) {
  d.carrier?.sweep(now);
  try { teamTick(d, now); } catch (error) { d.log(`way: ${error.message}`); }
  if (d.carrying || now < (d.carryAt ?? 0) || !d.node?.route) return;
  d.carrying = true; d.carryAt = now + (d.testing.join?.carryMs ?? RENEW_MS);
  try {
    const mates = new Set(d.teammateKeys());
    for (const [key, row] of Object.entries(savedRoutes())) {
      // A route to someone who is no longer a teammate is dropped.
      if (!mates.has(key)) { change(d, key, () => null); continue; }
      const mine = await carriersFor(d, key);
      if (mine.length && JSON.stringify(mine) !== JSON.stringify(row.mine)) change(d, key, kept => ({ ...kept, mine, theirs: kept?.theirs ?? [] }));
      // Told every time, so a teammate that missed it once has it by the next.
      const session = d.ctx.session(key); if (session) tellRoute(d, session);
    }
    d.published ??= new Map();
    // An invite stays open here as long as its topic is announced: 10 minutes after it is used, for a reply that was lost.
    let open = []; try { open = openInvites(d.myTeams().map(state => state.id), now, { retries: true }); } catch (error) { d.log(`invites: ${error.message}`); }
    // Used or expired: its record is replaced with an empty one, and its relays are asked for no more.
    for (const [topic, said] of d.published) if (!open.some(row => row.topic === topic)) {
      d.published.delete(topic);
      if (said.relays) d.node.putRecord(said.secret.record, sealRelays(said.secret.box, [])).catch(error => d.log(`invite relays: ${error.message}`));
    }
    for (const row of open) {
      const secret = relayKeys(row.prover), joiner = d.node.keyPair(secret.joiner).publicKey.toString('hex');
      const relays = (await askCarry(d, joiner, [])).map(entry => entry.relay).sort().join(''), said = d.published.get(row.topic);
      // Published when the relays change, and again every half hour, since DHT nodes come and go.
      if (relays === (said?.relays ?? '') && (!relays || now - said.at < 30 * 60000)) continue;
      await d.node.putRecord(secret.record, sealRelays(secret.box, relays.match(/.{64}/g) ?? []));
      d.published.set(row.topic, { relays, at: now, secret });
      d.log(`invite ${row.topic.slice(0, 8)}: ${relays.length / 64} relay${relays.length === 64 ? '' : 's'} published`);
    }
  } catch (error) { d.log(`carry: ${error.message}`); }
  finally { d.carrying = false; }
}
