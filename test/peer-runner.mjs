// Runs one peer daemon for test/peer-net.test.mjs in its own process, so each side has
// its own XDG_CONFIG_HOME. argv[2] is JSON: {tickMs, statusMs, conductor: true|false,
// noPunch, dropProveReply}. It prints {"ready":true,"key":...} once listening and stops when stdin
// closes or on SIGTERM.
import { PeerDaemon } from '../lib/peer/daemon.mjs';
import { Conductor } from '../lib/conductor.mjs';

const options = JSON.parse(process.argv[2] ?? '{}');
let conductor = null, stopping = null;
// The conductor runs in this process, so the test can stop everything by stopping this one.
const startConductor = () => { if (options.conductor !== false && !conductor) conductor = new Conductor({ tickMs: 100, idleMs: 3600000 }).start(); };
const testing = { ...options.noPunch ? { dht: { quickFirewall: false, ephemeral: true }, connect: { holepunch: () => false, localConnection: false, fastOpen: false }, noServerPunch: true } : {}, ...options.dropProveReply ? { dropProveReply: true } : {} };
const daemon = new PeerDaemon({ tickMs: options.tickMs ?? 200, statusMs: options.statusMs ?? 500, conductor: startConductor, testing, onExit: () => shutdown() });
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
