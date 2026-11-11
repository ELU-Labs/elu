import crypto from 'node:crypto';
import { refuse } from '../util.mjs';
import { teams as allTeams } from './roster.mjs';
import { loadNetwork, parseBootstrap, MISSING } from './transport.mjs';

// A blind relay for teammates whose NATs cannot holepunch (docs/peer-network.md, "Layers").
// It forwards encrypted bytes it cannot read. hyperdht's createServer firewall sees the
// connecting key, and peer daemons dial relays with their identity key, so only active
// members of the served teams get a session. Sessions are capped; bytes are not.
export async function runRelay({ identity, bootstrap, teams = null, maxSessions = 64, testing = {} } = {}) {
  const { DHT } = await loadNetwork();
  let BlindRelay; try { BlindRelay = (await import('blind-relay')).default; } catch { refuse(MISSING); }
  const served = () => allTeams().filter(team => !teams || teams.includes(team.id));
  if (!served().length) refuse('Join or create a team before running a relay.');
  // A key of its own, so the relay can run beside this machine's peer daemon.
  const keyPair = DHT.keyPair(crypto.createHash('sha256').update('elu-code relay\0').update(identity.seed).digest());
  const dht = new DHT({ keyPair, bootstrap: parseBootstrap(bootstrap), ...testing.dht });
  const relay = new BlindRelay.Server({ createStream: opts => dht.createRawStream({ ...opts, framed: true }) });
  const member = key => served().some(team => team.members.some(m => m.key === key && !m.removed));
  let sessions = 0;
  const server = dht.createServer({ firewall: remotePublicKey => !member(Buffer.from(remotePublicKey).toString('hex')) }, socket => {
    if (sessions >= maxSessions) return void socket.destroy();
    sessions++; socket.on('error', () => {}); socket.on('close', () => { sessions--; });
    relay.accept(socket, { id: socket.remotePublicKey }).on('error', () => {});
  });
  await server.listen(keyPair);
  return {
    key: keyPair.publicKey.toString('hex'), stats: () => ({ ...relay.stats, live: sessions }),
    async close() { await relay.close().catch(() => {}); await server.close().catch(() => {}); await dht.destroy(); },
  };
}
