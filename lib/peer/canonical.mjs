import crypto from 'node:crypto';
import { isObject, refuse } from '../util.mjs';

// Canonical JSON: object keys sorted (by UTF-16 code units) at every level, no whitespace.
// Only JSON values are accepted, so a signature never covers something JSON would drop
// or rewrite (undefined, functions, NaN, Dates, Buffers, sparse arrays).
const MAX_DEPTH = 32;
function encode(value, depth) {
  if (depth > MAX_DEPTH) refuse('Signed data is nested too deeply.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) refuse('Signed data has a number JSON cannot hold.'); return JSON.stringify(value); }
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) { if (!(i in value)) refuse('Signed data has an empty array slot.'); out.push(encode(value[i], depth + 1)); }
    return `[${out.join(',')}]`;
  }
  const proto = isObject(value) ? Object.getPrototypeOf(value) : undefined;
  if (proto !== Object.prototype && proto !== null) refuse('Signed data must be plain JSON.');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${encode(value[key], depth + 1)}`).join(',')}}`;
}
export const canonical = value => encode(value, 0);

// Keys are raw 32-byte ed25519 values. Node takes them only as DER, so the fixed
// PKCS#8 and SPKI prefixes for ed25519 are prepended. hyperdht's DHT.keyPair(seed)
// derives the same public key from the same seed, so one seed is also the transport key.
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const HEX64 = /^[0-9a-f]{64}$/;
function seedBytes(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) refuse('A signing seed must be 32 bytes.');
  return seed;
}
export const privateKey = seed => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, seedBytes(seed)]), format: 'der', type: 'pkcs8' });
export function publicKey(key) {
  if (typeof key !== 'string' || !HEX64.test(key)) refuse('A public key must be 64 hex characters.');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(key, 'hex')]), format: 'der', type: 'spki' });
}
export function publicKeyHex(seed) {
  return crypto.createPublicKey(privateKey(seed)).export({ format: 'der', type: 'spki' }).subarray(SPKI.length).toString('hex');
}
export const sign = (seed, value) => crypto.sign(null, Buffer.from(canonical(value)), privateKey(seed)).toString('hex');
// Never throws: a malformed key, signature or value is simply not verified.
export function verify(key, value, sig) {
  try {
    if (typeof sig !== 'string' || !/^[0-9a-f]{128}$/.test(sig)) return false;
    return crypto.verify(null, Buffer.from(canonical(value)), publicKey(key), Buffer.from(sig, 'hex'));
  } catch { return false; }
}

// RFC 4648 base32, lowercase and unpadded, for codes people paste.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  return bits ? out + ALPHABET[(value << (5 - bits)) & 31] : out;
}
// Strict: only the lowercase alphabet, no padding, and no stray trailing bits, so each
// byte string has exactly one accepted spelling.
export function unbase32(text) {
  if (typeof text !== 'string' || !/^[a-z2-7]*$/.test(text) || [1, 3, 6].includes(text.length % 8)) return null;
  let bits = 0, value = 0; const out = [];
  for (const char of text) {
    value = (value << 5) | ALPHABET.indexOf(char); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    value &= (1 << bits) - 1;
  }
  return value === 0 ? Buffer.from(out) : null;
}
