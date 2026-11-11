import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { atomic, noSymlinks, readJson, refuse } from '../util.mjs';
import { peerFile } from './paths.mjs';

// The binding's transport (docs/peer-network.md, "Binding"): Hyperswarm with the
// identity seed as the Noise key pair, NDJSON frames of at most 1 MiB, and the team's
// relay keys as an array. hyperswarm and hyperdht are optional, so they load here only.
export const FRAME_MAX = 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
export const MISSING = 'Peer mode needs the optional networking packages. Reinstall with optional dependencies.';
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
// noServerPunch} lets the relay test force relaying; production passes none of these.
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
  // Every socket hyperdht opens goes through here, including its own relay sockets.
  dht.connect = (key, opts = {}) => {
    const hex = Buffer.from(key).toString('hex'), peer = peers.has(hex);
    const socket = connect(key, peer ? { ...opts, ...testing.connect } : opts);
    sockets.add(socket); let opened = false;
    socket.on('open', () => { opened = true; });
    socket.on('error', () => { if (!opened && peer) counters.failed++; });
    socket.on('close', () => sockets.delete(socket));
    return socket;
  };
  const swarm = new Hyperswarm({ dht, keyPair, firewall: () => false, ...(relayKeys.length ? { relayThrough: relayKeys.map(key => Buffer.from(key, 'hex')) } : {}) });
  if (testing.noServerPunch) swarm.server.holepunch = () => false;
  // A relayed stream is connected to the same UDP socket and address as hyperdht's own
  // socket to the relay; a direct one is not. This is re-checked on every read, because a
  // relayed connection can later upgrade to direct.
  const pathOf = socket => {
    const raw = socket.rawStream; if (!raw || socket.destroyed) return null;
    for (const other of sockets) {
      const o = other.rawStream;
      if (other !== socket && o && o.socket === raw.socket && o.remoteHost === raw.remoteHost && o.remotePort === raw.remotePort && other.remotePublicKey && !other.remotePublicKey.equals(socket.remotePublicKey)) return 'relayed';
    }
    return 'direct';
  };
  const connections = new Map();
  swarm.on('connection', socket => {
    const key = socket.remotePublicKey.toString('hex'), row = { socket, since: Date.now(), lastSeen: Date.now() };
    Object.defineProperty(row, 'path', { enumerable: true, get: () => pathOf(socket) });
    connections.set(key, row); counters[row.path === 'relayed' ? 'relayed' : 'direct']++;
    socket.on('data', () => { row.lastSeen = Date.now(); });
    socket.on('error', () => {});
    socket.on('close', () => { if (connections.get(key) === row) connections.delete(key); });
    node.emit('connection', socket, key);
  });
  Object.assign(node, {
    key: keyPair.publicKey.toString('hex'), swarm, dht, connections, counters,
    listen: () => swarm.listen(),
    dial(key) { if (!HEX64.test(key) || key === node.key) return; peers.add(key); swarm.joinPeer(Buffer.from(key, 'hex')); },
    leave(key) { if (!peers.delete(key)) return; swarm.leavePeer(Buffer.from(key, 'hex')); },
    // After sleep: announce again and dial every peer afresh.
    async refresh() { swarm.server?.refresh?.(); for (const key of [...peers]) { swarm.leavePeer(Buffer.from(key, 'hex')); swarm.joinPeer(Buffer.from(key, 'hex')); } },
    saveRouting() { const rows = dht.toArray({ limit: 256 }); if (rows.length) atomic(peerFile('routing.json'), rows); },
    async destroy() { try { node.saveRouting(); } catch { /* The cache is optional. */ } await swarm.destroy(); },
  });
  return node;
}
