import fs from 'node:fs';
import os from 'node:os';
import { atomic, readJson, isObject, refuse } from '../util.mjs';
import { peerFile } from './paths.mjs';

export const DEFAULT_PEER_SETTINGS = Object.freeze({
  enabled: false, bootstrap: null, relays: [], peerSlots: 1, localA2A: false, box: null,
  caps: Object.freeze({ threadMessages: 8, hops: 2, threadUsd: 1, peerRunsPerDay: 20, peerUsdPerDay: 5, teamUsdPerDay: 10, runUsd: 0.5 }),
});
// holdReplies: I read each reply to this teammate before it goes. Off, a reply goes back into
// the thread when the run ends, unless the secret scan holds it. trusted: my
// text to them keeps its paths and their text shows as sent; the secret scan still applies.
// Trust is mine about them, never sent over the wire and never implied by a team role.
export const DEFAULT_PEER_POLICY = Object.freeze({ autoAccept: false, holdReplies: false, autoAsk: false, autoContinue: false, muted: false, trusted: false });
// autoSend (replies held unless it was on) became holdReplies; saved copies are dropped.
const policyOf = value => { const { autoSend, ...rest } = isObject(value) ? value : {}; return rest; };
const read = (name, fallback) => { const file = peerFile(name); try { return fs.existsSync(file) ? readJson(file) : fallback; } catch { return fallback; } };
export function peerSettings() {
  const saved = read('settings.json', {});
  return { ...DEFAULT_PEER_SETTINGS, ...saved, caps: { ...DEFAULT_PEER_SETTINGS.caps, ...saved.caps } };
}
export function savePeerSettings(update) {
  if (!isObject(update)) refuse('Peer settings must be an object.');
  const current = peerSettings(), next = { ...current, ...update, caps: { ...current.caps, ...update.caps } };
  if (!Number.isInteger(next.peerSlots) || next.peerSlots < 0 || next.peerSlots > 16) refuse('Peer slots must be 0 to 16.');
  if (update.box != null && !validBox(update.box)) refuse('Name this machine with 1 to 32 letters, digits, dots, - or _.');
  next.box ??= null;
  atomic(peerFile('settings.json'), next); return next;
}
// box: what this machine is called, told to teammates beside its owner's name. null is the
// default: the first label of the host name, without any character a box name cannot have.
export const BOX = /^[A-Za-z0-9._-]{1,32}$/;
const validBox = value => typeof value === 'string' && BOX.test(value);
const hostName = () => { try { return os.hostname(); } catch { return ''; } };
export const defaultBox = (host = hostName()) => String(host ?? '').split('.')[0].replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'box';
// The box name in use. A saved name that is no longer valid counts as none.
export function peerBox() { const { box } = peerSettings(); return validBox(box) ? box : defaultBox(); }
export function peerPolicy(key) { return { ...DEFAULT_PEER_POLICY, ...policyOf(read('peers.json', {})[key]) }; }
export function savePeerPolicy(key, update) {
  if (!/^[0-9a-f]{64}$/.test(key)) refuse('Choose a peer by its key.');
  const all = read('peers.json', {}), next = { ...DEFAULT_PEER_POLICY, ...policyOf(all[key]), ...update };
  for (const name of Object.keys(next)) if (!(name in DEFAULT_PEER_POLICY)) refuse(`Unknown teammate setting: ${name}.`);
  for (const name of Object.keys(DEFAULT_PEER_POLICY)) if (typeof next[name] !== 'boolean') refuse(`${name} must be true or false.`);
  atomic(peerFile('peers.json'), { ...all, [key]: next }); return next;
}
