import fs from 'node:fs';
import os from 'node:os';
import { atomic, readJson, isObject, refuse } from '../util.mjs';
import { BUILT_IN_BOTS, botsFile } from '../bots.mjs';
import { peerFile } from './paths.mjs';

// There is no on or off: the daemon runs while this machine is on a team (index.mjs). An
// enabled field saved by 0.1.5 and earlier stays in the file and means nothing.
export const DEFAULT_PEER_SETTINGS = Object.freeze({
  bootstrap: null, relays: [], peerSlots: 1, localA2A: false, box: null,
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
// This computer's name and whether its owner gave it (named) or it is the host name's.
export function computerName() { const { box } = peerSettings(); return validBox(box) ? { box, named: true } : { box: defaultBox(), named: false }; }
// The owner names this computer: /computer name NAME in the app, elu id --computer NAME on the
// command line. Nothing, or default, goes back to the host name. A leading @ is not part of the
// name. others: the other computers on his teams, as peerStatus lists them ({ box, bots }).
// The name one of them goes by is taken, so @name still finds one computer. A bot's name is
// taken too, since on his other computers @name finds the bot first: the bots ELU comes with
// (every computer has them, even where one was removed here), the ones saved here and the ones
// the others share. Teammates hear the new name from the daemon, which reads it again on every
// tick (status.mjs, thisMachine).
export const BOX_RULE = "A computer's name is 1 to 32 letters, digits, dots, - or _.";
const MEANS = new Set(['here', 'model', 'everyone']);
// The names of the bots saved here. Read only: the bots file is never written for this.
const savedBots = () => { try { const saved = readJson(botsFile())?.bots; return Array.isArray(saved) ? saved.map(bot => bot?.name) : []; } catch { return []; } };
const same = (name, box) => typeof name === 'string' && name.toLowerCase() === box.toLowerCase();
export function nameComputer(value, { others = [] } = {}) {
  const typed = String(value ?? '').trim();
  if (!typed || typed.toLowerCase() === 'default') { savePeerSettings({ box: null }); return computerName(); }
  const box = typed.replace(/^@/, '');
  if (!validBox(box)) refuse(BOX_RULE);
  if (MEANS.has(box.toLowerCase())) refuse(`@${box.toLowerCase()} already means something in ELU. Choose another name.`);
  const bots = [...BUILT_IN_BOTS.map(bot => bot.name), ...savedBots(), ...others.flatMap(other => Array.isArray(other?.bots) ? other.bots.map(bot => bot?.name) : [])];
  if (bots.some(name => same(name, box))) refuse(`@${box.toLowerCase()} is the name of a bot. Choose another name.`);
  if (others.some(other => same(other?.box, box))) refuse(`Another computer on your team is called ${box}.`);
  savePeerSettings({ box }); return { box, named: true };
}
export function peerPolicy(key) { return { ...DEFAULT_PEER_POLICY, ...policyOf(read('peers.json', {})[key]) }; }
export function savePeerPolicy(key, update) {
  if (!/^[0-9a-f]{64}$/.test(key)) refuse('Choose a peer by its key.');
  const all = read('peers.json', {}), next = { ...DEFAULT_PEER_POLICY, ...policyOf(all[key]), ...update };
  for (const name of Object.keys(next)) if (!(name in DEFAULT_PEER_POLICY)) refuse(`Unknown teammate setting: ${name}.`);
  for (const name of Object.keys(DEFAULT_PEER_POLICY)) if (typeof next[name] !== 'boolean') refuse(`${name} must be true or false.`);
  atomic(peerFile('peers.json'), { ...all, [key]: next }); return next;
}
