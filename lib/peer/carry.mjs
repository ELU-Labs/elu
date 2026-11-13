import fs from 'node:fs';
import crypto from 'node:crypto';
import { EluCodeError, atomic, isObject, noSymlinks, readJson, refuse } from '../util.mjs';
import { peerFile } from './paths.mjs';
import { MISSING } from './transport.mjs';
import { bothMine } from './mine.mjs';
import { openInvites, openRelays, relayKeys, sealRelays } from './invite.mjs';
import { NOT_FOUND, NO_ANSWER, noRoute } from './join-text.mjs';

// Passing a connection along (docs/peer-network.md, "When two computers cannot connect").
// Two computers whose networks will not connect directly reach each other through a third
// that both can reach: a teammate's daemon, or another computer of one's own. That daemon
// runs a blind relay for the one pair it was asked for. It forwards bytes it cannot read,
// and lets in those two keys only, on a key pair made for the pair, so neither can use it to
// reach anyone else and nobody else can use it at all.
const HEX64 = /^[0-9a-f]{64}$/;
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
// relay}], theirs: [relay]}: the relays its own helpers gave it, which it asks for again,
// and the ones the teammate told it, which the teammate asks for again.
const file = () => peerFile('routes.json');
const cleanRow = row => ({
  mine: (Array.isArray(row?.mine) ? row.mine : []).filter(entry => HEX64.test(entry?.helper ?? '') && HEX64.test(entry?.relay ?? '')).slice(0, 4).map(({ helper, relay }) => ({ helper, relay })),
  theirs: (Array.isArray(row?.theirs) ? row.theirs : []).filter(relay => HEX64.test(relay ?? '')).slice(0, 4),
});
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
  change(d, key, row => ({ mine: mine.length ? mine : row?.mine ?? [], theirs: row?.theirs ?? [] })); d.carryAt = 0;
  const session = d.ctx.session(key); if (session) tellRoute(d, session);
}

// The teammates connected now that can carry, another computer of mine first. One this
// machine itself reaches only through a relay is not asked: its relay would be no nearer.
function helpers(d, except) {
  return [...d.sessions.values()].filter(session => session.admitted && !session.departed && session.remoteHello?.carry === 1 && !except.includes(session.key) && !d.node.connections?.get(session.key)?.via)
    .sort((a, b) => Number(bothMine(d.me.key, b.key)) - Number(bothMine(d.me.key, a.key))).slice(0, HELPERS);
}
// Asks them to pass my connection with other along: [{helper, relay}], one for each that agreed.
export async function askCarry(d, other, except = [other]) {
  const asked = await Promise.all(helpers(d, except).map(async session => {
    try { const reply = await session.request('elu.carry', { with: other }, { timeoutMs: 20000 }); return HEX64.test(reply?.relay ?? '') ? { helper: session.key, relay: reply.relay } : null; }
    catch (error) { d.log(`carry by ${session.key.slice(0, 8)}: ${error.message}`); return null; }
  }));
  return asked.filter(Boolean);
}
// For a join: the relays that may carry it. This machine's helpers are asked to let the
// inviter in. The inviter's helpers are read from the record it published for the code;
// they let in the key pair the code gives, so that is the one this machine shows them.
export async function joinRelays(d, keys, inviter) {
  const mine = await askCarry(d, inviter), secret = relayKeys(keys.prover); let theirs = [];
  try { theirs = openRelays(secret.box, await d.node.getRecord(secret.record)); } catch (error) { d.log(`invite relays: ${error.message}`); }
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
      if (!isObject(params) || !HEX64.test(params.with ?? '') || params.with === session.key || params.with === d.me.key) refuse('Name the other computer by its key.');
      const relay = await (d.carrier ??= createCarrier(d.node, d.me.seed)).grant(session.key, session.key, params.with);
      d.log(`passing along ${session.key.slice(0, 8)} and ${params.with.slice(0, 8)}`);
      return { relay, ms: CARRY_MS };
    },
    // A teammate says which relays its helpers run for the two of us.
    'elu.route': (params, session) => {
      if (!session.admitted || !d.teammateKeys().includes(session.key) || !isObject(params) || !Array.isArray(params.relays)) return null;
      const theirs = params.relays.filter(relay => HEX64.test(relay ?? '')).slice(0, 4);
      change(d, session.key, row => ({ mine: row?.mine ?? [], theirs }));
      return null;
    },
  };
}
// The relays of mine for a teammate, told to them when they connect, when they change and at each upkeep.
export function tellRoute(d, session) {
  const row = savedRoutes()[session.key];
  if (row?.mine.length && session.remoteHello?.carry === 1) session.notify('elu.route', { relays: row.mine.map(entry => entry.relay) });
}

// Every RENEW_MS, and at once when a helper connects, an invite is made or a join went
// through a relay: grants this machine gave are swept; each teammate it reaches through a
// relay is asked for again and told; each open invite's relays are asked for and published
// for whoever holds its code.
export async function carryTick(d, now = Date.now()) {
  d.carrier?.sweep(now);
  if (d.carrying || now < (d.carryAt ?? 0) || !d.node?.route) return;
  d.carrying = true; d.carryAt = now + (d.testing.join?.carryMs ?? RENEW_MS);
  try {
    const mates = new Set(d.teammateKeys());
    for (const [key, row] of Object.entries(savedRoutes())) {
      // A route to someone who is no longer a teammate is dropped.
      if (!mates.has(key)) { change(d, key, () => null); continue; }
      const mine = await askCarry(d, key);
      if (mine.length && JSON.stringify(mine) !== JSON.stringify(row.mine)) change(d, key, kept => ({ mine, theirs: kept?.theirs ?? [] }));
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
