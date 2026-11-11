import fs from 'node:fs';
import crypto from 'node:crypto';
import { atomic, isObject, noSymlinks, readJson, refuse } from '../util.mjs';
import { waitLock } from '../state.mjs';
import { peerFile, peerRepo } from './paths.mjs';
import { base32, canonical, publicKeyHex, unbase32 } from './canonical.mjs';

// One ed25519 identity per install. The seed is the team signing key and, through
// hyperdht, the transport key.
// The fingerprint is the first 8 hex characters of the public key, for people to compare.
const file = () => peerFile('identity.json');
const EXPORT_PREFIX = 'elu-id:v1:';
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/;
// A display name: 1 to max printable characters, no controls, bidi overrides or zero-width.
export function validName(value, max = 40) {
  return typeof value === 'string' && value === value.trim() && [...value].length >= 1 && [...value].length <= max
    && !/[\x00-\x1f\x7f-\x9f]/.test(value) && !INVISIBLE.test(value);
}
function checkName(name) { if (!validName(name)) refuse('Choose a name of 1 to 40 printable characters.'); return name; }
function seedOf(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const seed = Buffer.from(value, 'base64'); return seed.length === 32 && seed.toString('base64') === value ? seed : null;
}
function save(record) { atomic(file(), record); fs.chmodSync(file(), 0o600); }
// The seed is non-enumerable, so JSON output, spreads and console logging of an
// identity never carry it by accident.
function derive(record) {
  const seed = seedOf(record.seed), key = publicKeyHex(seed), out = { name: record.name, key, fingerprint: key.slice(0, 8), createdAt: record.createdAt };
  Object.defineProperty(out, 'seed', { value: seed });
  return Object.freeze(out);
}
// A file or code written by an earlier build may carry a field this build does not use.
// It is accepted, and dropped the next time the identity is saved.
const FIELDS = ['version', 'name', 'seed', 'createdAt'], UNUSED = ['nostrSecret'];
const kept = record => Object.fromEntries(Object.entries(record).filter(([key]) => FIELDS.includes(key)));
function validRecord(value) {
  return isObject(value) && Object.keys(value).every(key => FIELDS.includes(key) || UNUSED.includes(key))
    && value.version === 1 && validName(value.name) && seedOf(value.seed)
    && typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt));
}
export function loadIdentity() {
  noSymlinks(file());
  if (!fs.existsSync(file())) return null;
  let value; try { value = readJson(file()); } catch { refuse('The peer identity file is unreadable.'); }
  if (!validRecord(value)) refuse('The peer identity file is invalid.');
  return derive(value);
}
export function identity() { return loadIdentity() ?? refuse('Create your peer identity first with elu id --name NAME.'); }
function locked(fn) { const release = waitLock(peerRepo(), 'identity'); try { return fn(); } finally { release(); } }
export function createIdentity({ name } = {}) {
  checkName(name);
  return locked(() => {
    if (loadIdentity()) refuse('A peer identity already exists.');
    save({ version: 1, name, seed: crypto.randomBytes(32).toString('base64'), createdAt: new Date().toISOString() });
    return identity();
  });
}
export function renameIdentity(name) {
  checkName(name);
  return locked(() => { identity(); save({ ...kept(readJson(file())), name }); return identity(); });
}
export function exportIdentity() {
  const id = identity();
  return EXPORT_PREFIX + base32(Buffer.from(canonical({ seed: id.seed.toString('base64'), name: id.name })));
}
export function parseIdentityCode(code) {
  const bad = () => refuse('This identity code is not valid.');
  if (typeof code !== 'string' || code.length > 800 || !code.startsWith(EXPORT_PREFIX)) bad();
  const bytes = unbase32(code.slice(EXPORT_PREFIX.length)); if (!bytes) bad();
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { bad(); }
  if (!isObject(value) || !['name,seed', 'name,nostrSecret,seed'].includes(Object.keys(value).sort().join()) || !seedOf(value.seed) || !validName(value.name) || canonical(value) !== bytes.toString('utf8')) bad();
  return value;
}
export function importIdentity(code, { replace = false } = {}) {
  const value = parseIdentityCode(code);
  return locked(() => {
    if (!replace && loadIdentity()) refuse('A peer identity already exists. Replace it explicitly to import another.');
    save({ version: 1, name: value.name, seed: value.seed, createdAt: new Date().toISOString() });
    return identity();
  });
}
