// Runs one peer daemon for test/peer-net.test.mjs in its own process, so each side has
// its own XDG_CONFIG_HOME. argv[2] is JSON: {tickMs, statusMs, idleMs, conductor: true|false,
// noPunch, firewalled, abortFound, join, dropProveReply, github: {gapMs, everyMs} for GitHub pairing}. noPunch: no
// direct connection to a teammate or to anyone found on a join's topic. firewalled: this node
// is not reachable without a punch. abortFound: N direct tries of a join fail before one may
// work. join: {connectMs, retryMs, carryMs} for a join's waits. A home on no team waits for its join, so by default it does not
// stop by itself within the test (idleMs an hour). It prints {"ready":true,"key":...} once listening and stops when stdin
// closes or on SIGTERM.
import { PeerDaemon } from '../lib/peer/daemon.mjs';
import { Conductor } from '../lib/conductor.mjs';

const options = JSON.parse(process.argv[2] ?? '{}');
let conductor = null, stopping = null;
// The conductor runs in this process, so the test can stop everything by stopping this one.
const startConductor = () => { if (options.conductor !== false && !conductor) conductor = new Conductor({ tickMs: 100, idleMs: 3600000 }).start(); };
const closed = { quickFirewall: false, ephemeral: true }, punchless = { holepunch: () => false, localConnection: false, fastOpen: false };
const testing = { ...options.noPunch ? { dht: closed, connect: punchless, found: punchless, noServerPunch: true } : {}, ...options.firewalled ? { dht: closed } : {}, ...options.abortFound ? { dht: closed, found: punchless, foundFails: options.abortFound } : {},
  ...options.join ? { join: options.join } : {}, ...options.dropProveReply ? { dropProveReply: true } : {}, ...options.github ? { github: options.github } : {} };
const daemon = new PeerDaemon({ tickMs: options.tickMs ?? 200, statusMs: options.statusMs ?? 500, idleMs: options.idleMs ?? 3600000, conductor: startConductor, testing, onExit: () => shutdown() });
async function shutdown() {
  stopping ??= (async () => { await daemon.stop().catch(() => {}); await conductor?.stop().catch(() => {}); process.exit(0); })();
  return stopping;
}
process.on('SIGTERM', shutdown);
process.stdin.on('end', shutdown); process.stdin.resume();
try { await daemon.start(); }
catch (error) { process.stdout.write(`${JSON.stringify({ ready: false, error: error.message })}\n`); process.exit(1); }
startConductor();
process.stdout.write(`${JSON.stringify({ ready: true, key: daemon.me.key })}\n`);
