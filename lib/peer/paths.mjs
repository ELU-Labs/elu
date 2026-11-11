import path from 'node:path';
import { personalDirectory } from '../usage.mjs';

// Every peer file lives under $XDG_CONFIG_HOME/elu-code/peer (see docs/peer-network.md).
export const peerDir = () => path.join(personalDirectory(), 'peer');
export const peerFile = (...parts) => path.join(peerDir(), ...parts);
export const peerRepo = () => ({ state: peerDir() }); // for lock()/waitLock() from state.mjs
