import crypto from 'node:crypto';

// The shape of an invite code, kept free of files and networking so the app can read a
// pasted code before it hands it on. A code is 12 characters in three groups of four, such
// as k7qm-x2pd-9fhw. The 31 characters are the digits 2 to 9 and the lowercase letters
// without i, l and o, so nothing reads as another: 31^12 codes, about 59.4 bits.
export const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const LENGTH = 12;
// Codes made by 0.1.3 and earlier: a prefix and base32 JSON naming the team and the inviter.
export const LONG_PREFIX = 'elu-team:v1:';
const SHORT = new RegExp(`^[${ALPHABET}]{${LENGTH}}$`);
export const formatCode = text => `${text.slice(0, 4)}-${text.slice(4, 8)}-${text.slice(8)}`;

// Each character comes from one random byte below 248 (8 × 31), so every character is equally likely.
export function newCode() {
  let out = '';
  while (out.length < LENGTH) for (const byte of crypto.randomBytes(LENGTH * 2)) if (byte < 248 && out.length < LENGTH) out += ALPHABET[byte % 31];
  return formatCode(out);
}

// A code as people paste it: from a wrapped window, a chat, or with the command still in
// front. Whitespace anywhere, case, dashes, quotes around it, and a /join or elu join (even
// twice) in front are not part of it. Returns {short: 'k7qm-x2pd-9fhw'}, {long: code} for a
// code made by 0.1.3 or earlier, or null.
const SPACE = /[\s​-‍⁠﻿]+/g, DASH = /[-‐-―−_.]/g, QUOTE = /^[`'"<“‘]+|[`'">”’]+$/g;
export function readCode(text) {
  if (typeof text !== 'string' || text.length > 4000) return null;
  let value = text.replace(SPACE, '').toLowerCase().replace(QUOTE, '');
  for (let match; (match = /^(\/join|elujoin)/.exec(value));) value = value.slice(match[0].length).replace(QUOTE, '');
  if (value.startsWith(LONG_PREFIX)) return value.length <= 600 ? { long: value } : null;
  value = value.replace(DASH, '');
  return SHORT.test(value) ? { short: formatCode(value) } : null;
}
