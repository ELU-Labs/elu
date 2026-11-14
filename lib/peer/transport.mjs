import { createRequire } from 'node:module';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { atomic, noSymlinks, readJson, refuse } from '../util.mjs';
import { peerFile } from './paths.mjs';

// The binding's transport (docs/peer-network.md, "Binding"): Hyperswarm with the
// identity seed as the Noise key pair, NDJSON frames of at most 1 MiB, and the team's
// relay keys as an array. hyperswarm and hyperdht are optional, so they load here only.
export const FRAME_MAX = 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
export const MISSING = 'Teammates need the optional networking packages. Reinstall with optional dependencies.';
export async function loadNetwork() {
  try {
    const [swarm, dht] = await Promise.all([import('hyperswarm'), import('hyperdht')]);
    return { Hyperswarm: swarm.default, DHT: dht.default };
  } catch { refuse(MISSING); }
}
export function parseBootstrap(list) {
  if (list == null) return undefined;
  if (!Array.isArray(list) || list.length > 32) refuse('Bootstrap nodes must be a list of host:port.');
  return list.map(item => {
    const match = typeof item === 'string' && /^([A-Za-z0-9.-]{1,253}|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(item);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) refuse('Bootstrap nodes must be a list of host:port.');
    return { host: match[1].replace(/^\[|\]$/g, ''), port: Number(match[2]) };
  });
}
function savedNodes() {
  try {
    const file = peerFile('routing.json'); noSymlinks(file); if (!fs.existsSync(file)) return undefined;
    const rows = readJson(file);
    const nodes = Array.isArray(rows) ? rows.filter(row => typeof row?.host === 'string' && row.host.length < 256 && Number.isInteger(row.port) && row.port > 0 && row.port < 65536).slice(0, 256).map(({ host, port }) => ({ host, port })) : [];
    return nodes.length ? nodes : undefined;
  } catch { return undefined; }
}

// Splits a stream into JSON frames. A line over FRAME_MAX, or one that is not JSON,
// is a violation: the caller closes the connection.
export function frames(socket, onFrame, onViolation) {
  let chunks = [], size = 0, stopped = false;
  const stop = reason => { if (!stopped) { stopped = true; chunks = []; onViolation(reason); } };
  socket.on('data', data => {
    if (stopped) return;
    let start = 0, index;
    while ((index = data.indexOf(10, start)) !== -1) {
      const part = data.subarray(start, index); start = index + 1;
      if (size + part.length > FRAME_MAX) return stop('frame too large');
      const line = chunks.length ? Buffer.concat([...chunks, part]).toString('utf8') : part.toString('utf8');
      chunks = []; size = 0;
      if (!line.trim()) continue;
      let value; try { value = JSON.parse(line); } catch { return stop('invalid JSON'); }
      onFrame(value); if (stopped) return;
    }
    const rest = data.subarray(start);
    if (size + rest.length > FRAME_MAX) return stop('frame too large');
    if (rest.length) { chunks.push(rest); size += rest.length; }
  });
}
export function writeFrame(socket, value) {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > FRAME_MAX) refuse('A peer message is larger than 1 MiB.');
  if (!socket.destroyed) socket.write(line);
}

// testing: {dht: extra DHT options, connect: extra connect options for peer dials,
// noServerPunch} lets the relay test force relaying; found: the same for dials to peers found
// on a topic (a join), for the first foundFails of them; only: the keys connect and found
// apply to (every key without it). Production passes none of these.
export async function createNode({ identity, bootstrap, relays = [], nodes, testing = {} } = {}) {
  const { Hyperswarm, DHT } = await loadNetwork();
  const keyPair = DHT.keyPair(identity.seed), relayKeys = [...new Set(relays)].filter(key => HEX64.test(key)).slice(0, 16);
  // The DHT carries the identity key pair too, so relay connections present it and a
  // relay can admit team members only. The node stays ephemeral: it never joins other
  // nodes' routing tables, so strangers' lookups, announcements and connections are not
  // routed through it, however long it runs. It still announces its key and connects.
  const dht = new DHT({ keyPair, bootstrap: parseBootstrap(bootstrap), nodes: nodes ?? savedNodes(), ephemeral: true, ...testing.dht });
  const node = new EventEmitter(), sockets = new Set(), connect = dht.connect.bind(dht), peers = new Set();
  const counters = { direct: 0, relayed: 0, failed: 0 };
  // routes: the relays that carry a peer the networks do not reach directly (carry.mjs).
  // aliases: a relay this machine is let into under another key pair. dials: how the swarm's
  // last dial to each key went, so a join can say what happened and when to try again.
  const routes = new Map(), aliases = new Map(), dials = new Map(); let foundDials = 0;
  const forced = hex => !Array.isArray(testing.only) || testing.only.includes(hex);
  // hyperdht opens a socket of its own to a relay for each connection it relays, and pairs
  // that connection's stream on it. The pairing is remembered, so a stream is known as
  // relayed by the relay socket that carries it. The copy of blind-relay is hyperdht's own.
  let Relay = null; try { Relay = createRequire(import.meta.resolve('hyperdht'))('blind-relay'); } catch { /* A stream's path is then told by its address alone. */ }
  const pairedOn = new WeakMap();
  const watchRelay = socket => queueMicrotask(() => { try { Relay?.Client.from(socket).on('pair', (initiator, token, stream) => pairedOn.set(stream, socket)); } catch { /* Not a relay socket. */ } });
  // Every socket hyperdht opens goes through here, including its own relay sockets. Those
  // come without options; a dial of the swarm's always names relayThrough.
  dht.connect = (key, opts = {}) => {
    const hex = Buffer.from(key).toString('hex'), peer = peers.has(hex);
    let options = peer && forced(hex) ? { ...opts, ...testing.connect } : opts, dial = null;
    if (aliases.has(hex)) options = { ...options, keyPair: aliases.get(hex) };
    if (Object.hasOwn(opts, 'relayThrough')) {
      const info = swarm.peers.get(hex), via = routes.get(hex);
      // A peer found on a topic is dialled again when the join looks again, at its pace, not by the swarm's timers.
      if (!peer) { info?.reconnect(false); if (testing.found && forced(hex) && foundDials++ < (testing.foundFails ?? Infinity)) options = { ...options, ...testing.found }; }
      const tries = (dials.get(hex)?.tries ?? 0) + 1;
      // hyperdht takes one relay a try. Each try takes the next of the list, so one that has gone away does not hold the others up.
      if (via?.length && !options.relayThrough) options = { ...options, relayThrough: Buffer.from(via[(tries - 1) % via.length], 'hex') };
      dial = { topics: (info?.topics ?? []).map(topic => Buffer.from(topic).toString('hex')), tries, startedAt: Date.now(), endedAt: null, code: null, open: false, relay: Boolean(options.relayThrough), remote: null, local: null, socket: null };
      // hyperdht asks before it punches, with what kind of network each side is behind (0 unknown, 1 open, 2 consistent, 3 random).
      const punch = options.holepunch ?? (() => true);
      options = { ...options, holepunch: (remote, local, ...rest) => { dial.remote = remote; dial.local = local; return punch(remote, local, ...rest); } };
      dials.delete(hex); dials.set(hex, dial); if (dials.size > 64) dials.delete(dials.keys().next().value);
    }
    const socket = connect(key, options);
    sockets.add(socket); let opened = false;
    if (dial) dial.socket = socket; else watchRelay(socket);
    socket.on('open', () => { opened = true; if (dial) dial.open = true; });
    socket.on('error', error => { if (opened) return; if (peer) counters.failed++; if (dial) dial.code = error?.code ?? 'ERROR'; });
    socket.on('close', () => { sockets.delete(socket); if (dial) { dial.endedAt = Date.now(); dial.socket = null; } });
    return socket;
  };
  const swarm = new Hyperswarm({ dht, keyPair, firewall: () => false, ...(relayKeys.length ? { relayThrough: relayKeys.map(key => Buffer.from(key, 'hex')) } : {}) });
  if (testing.noServerPunch) swarm.server.holepunch = () => false;
  // A relayed stream is connected to the same UDP socket and address as the relay socket it
  // was paired on; a direct one is not. This is re-checked on every read, because a relayed
  // connection can later upgrade to direct. Sharing an address with some relay socket is not
  // enough: a teammate's daemon that passes connections along (carry.mjs) answers on one address.
  // The relay a stream runs through (its key), or null for a direct one.
  const relayOf = socket => {
    const raw = socket.rawStream; if (!raw || socket.destroyed) return undefined;
    const sameWay = other => { const o = other.rawStream; return Boolean(o) && !other.destroyed && o.socket === raw.socket && o.remoteHost === raw.remoteHost && o.remotePort === raw.remotePort && Boolean(other.remotePublicKey); };
    if (Relay) { const other = pairedOn.get(raw); return other && sameWay(other) ? other.remotePublicKey.toString('hex') : null; }
    for (const other of sockets) if (other !== socket && sameWay(other) && !other.remotePublicKey.equals(socket.remotePublicKey)) return other.remotePublicKey.toString('hex');
    return null;
  };
  const pathOf = socket => { const relay = relayOf(socket); return relay === undefined ? null : relay ? 'relayed' : 'direct'; };
  const connections = new Map();
  swarm.on('connection', (socket, info) => {
    const key = socket.remotePublicKey.toString('hex'), row = { socket, since: Date.now(), lastSeen: Date.now() };
    Object.defineProperty(row, 'path', { enumerable: true, get: () => pathOf(socket) });
    Object.defineProperty(row, 'via', { get: () => relayOf(socket) || null });
    connections.set(key, row); counters[row.path === 'relayed' ? 'relayed' : 'direct']++;
    socket.on('data', () => { row.lastSeen = Date.now(); });
    socket.on('error', () => {});
    socket.on('close', () => { if (connections.get(key) === row) connections.delete(key); });
    // info.topics: the topics this peer was found on, when this side looked it up.
    node.emit('connection', socket, key, info);
  });
  Object.assign(node, {
    key: keyPair.publicKey.toString('hex'), swarm, dht, connections, counters,
    listen: () => swarm.listen(),
    dial(key) { if (!HEX64.test(key) || key === node.key) return; peers.add(key); swarm.joinPeer(Buffer.from(key, 'hex')); swarm.peers.get(key)?.reconnect(true); },
    leave(key) { if (!peers.delete(key)) return; swarm.leavePeer(Buffer.from(key, 'hex')); },
    // An invite's topic: the inviter announces on it (server), the joiner looks it up (client).
    // Returns the discovery, whose refresh() looks again.
    joinTopic(topic, { server = false, client = false } = {}) { return HEX64.test(topic) ? swarm.join(Buffer.from(topic, 'hex'), { server, client }) : null; },
    leaveTopic(topic) { if (HEX64.test(topic)) swarm.leave(Buffer.from(topic, 'hex')).catch(() => {}); },
    // After sleep: announce again and dial every peer afresh.
    async refresh() { swarm.server?.refresh?.(); for (const key of [...peers]) { swarm.leavePeer(Buffer.from(key, 'hex')); swarm.joinPeer(Buffer.from(key, 'hex')); } },
    saveRouting() { const rows = dht.toArray({ limit: 256 }); if (rows.length) atomic(peerFile('routing.json'), rows); },
    // The swarm's dials to the peers it found on a topic: [{key, tries, pending, open, code, relay, remote, local, startedAt, endedAt}].
    dialsOn(topic) { return [...dials].filter(([, dial]) => dial.topics.includes(topic)).map(([key, { socket, topics, ...dial }]) => ({ key, ...dial, pending: !dial.open && dial.endedAt === null })); },
    // The relays that carry a peer from now on; none clears them.
    route(key, relayList = []) { const list = [...new Set(relayList)].filter(relay => typeof relay === 'string' && HEX64.test(relay)).slice(0, 4); if (list.length) routes.set(key, list); else routes.delete(key); },
    routeOf: key => routes.get(key) ?? [],
    // A relay that lets this machine in under the key pair of seed, not its own.
    relayAs(relay, seed) { if (typeof relay === 'string' && HEX64.test(relay)) aliases.set(relay, DHT.keyPair(seed)); },
    // Ends a dial that has not connected, so the next look dials afresh.
    redial(key) { const dial = dials.get(key); if (dial && !dial.open) dial.socket?.destroy(); },
    // How the swarm's last dial to a peer went, as dialsOn gives it; null before the first.
    dialOf(key) { const dial = dials.get(key); if (!dial) return null; const { socket, topics, ...rest } = dial; return { ...rest, pending: !dial.open && dial.endedAt === null }; },
    // Whether a direct connection to a peer works now: one try with no relay, closed as soon
    // as it opens. The other side's swarm takes it for this machine connecting again and
    // lets the connection it had go, so the caller connects afresh when this says true.
    probe(key, { timeoutMs = 45000 } = {}) {
      return new Promise(resolve => {
        if (!HEX64.test(key) || !peers.has(key)) return resolve(false);
        let done = false; const end = value => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(value); };
        const socket = connect(Buffer.from(key, 'hex'), { keyPair, ...(forced(key) ? testing.connect : null) }), timer = setTimeout(() => end(false), timeoutMs);
        socket.on('open', () => end(true)); socket.on('error', () => end(false)); socket.on('close', () => end(false));
      });
    },
    // Drops the connection to a peer and dials it again at once.
    reconnect(key) {
      const socket = connections.get(key)?.socket;
      if (!socket || socket.destroyed) return node.dial(key);
      socket.once('close', () => { if (peers.has(key)) node.dial(key); }); socket.destroy();
    },
    keyPair: seed => DHT.keyPair(seed),
    // A small signed record on the DHT, under the key pair of seed: the newest one wins.
    async putRecord(seed, value) { await dht.mutablePut(DHT.keyPair(seed), value, { seq: Date.now() }); },
    async getRecord(seed) { return (await dht.mutableGet(DHT.keyPair(seed).publicKey, { latest: true }))?.value ?? null; },
    // Whether this machine reached the network at all: once the first lookup is over, no node
    // having answered means it is not connected, and so does the DHT saying it went offline.
    network() { return { bootstrapped: dht.bootstrapped === true, online: dht.online !== false, answers: dht.stats?.requests?.responses ?? null }; },
    async destroy() { try { node.saveRouting(); } catch { /* The cache is optional. */ } await swarm.destroy(); },
  });
  return node;
}
