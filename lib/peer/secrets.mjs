import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { within } from '../util.mjs';

// Patterns for credentials that must never leave this machine in a reply. Order matters:
// when two matches overlap, the earlier, more specific kind is reported.
const VALUE = `(?!(?:process\\.env|os\\.environ|ENV\\b|getenv|null|undefined|true|false|none|changeme|example|your[-_]|xxx|\\*{3}|<|\\$|\\{))[^\\s"'\`;,)]{6,}`;
const PATTERNS = [
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj-)?(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}/g],
  ['slack-token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g],
  ['stripe-key', /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g],
  ['url-credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:[^\s/@'"`]+@/gi],
  // KEY=value: an upper-case variable name may take a bare value; any other name needs a quoted one.
  ['assignment', new RegExp(`\\b[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)\\s*[:=]\\s*["']?${VALUE}`, 'g')],
  ['assignment', new RegExp(`\\b[A-Za-z0-9_]*(?:password|passwd|secret|token|api_?key|private_?key|access_?key)\\s*[:=]\\s*["']${VALUE}`, 'gi')],
];
// "=" only as base64 padding, so in KEY=value the value is judged on its own.
const TOKEN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
const HARMLESS = [/^[0-9a-f]{40}$/i, /^[0-9a-f]{64}$/i, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i];
export function entropy(text) {
  const counts = new Map(); for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0; for (const count of counts.values()) { const p = count / text.length; bits -= p * Math.log2(p); }
  return bits;
}
// A generic token must look random: over 4 bits per character (which hex can never reach)
// and switching between lowercase, uppercase, digits and symbols on at least 40% of
// adjacent characters, with lowercase runs under 3.5 characters on average. Random base64
// switches on about 64% with runs near 1.7; camelCase names, words and paths have long
// lowercase runs and switch far less, so they are not flagged.
const charClass = char => /[a-z]/.test(char) ? 0 : /[A-Z]/.test(char) ? 1 : /[0-9]/.test(char) ? 2 : 3;
function switches(token) {
  let count = 0; for (let i = 1; i < token.length; i++) if (charClass(token[i]) !== charClass(token[i - 1])) count++;
  return count / (token.length - 1);
}
function lowerRun(token) { const runs = token.match(/[a-z]+/g) ?? []; return runs.length ? runs.join('').length / runs.length : 0; }
const randomLooking = token => !HARMLESS.some(re => re.test(token)) && entropy(token) > 4 && switches(token) >= 0.4 && lowerRun(token) < 3.5;
// In a file path each folder or file name is judged on its own, so temporary folders such as
// /var/folders/7k/xq2m3h1d5gs0qfz8r9t2wvbr0000gn/T or /tmp/su2-9SAVeT do not add up to one
// random-looking token; a key-long random name inside a path still does. A path starts with ~/
// or with a named folder (/tmp, /var, /Users) and not after a "+", so a base64 key that starts
// with "/" or holds "+/" is judged whole.
const pathSpans = value => [...value.matchAll(ABSOLUTE)].filter(m => /^\/\.?[A-Za-z][a-z]+\//.test(m[0]) && value[m.index - 1] !== '+').concat([...value.matchAll(HOME_PATH)])
  .map(m => ({ index: m.index, end: m.index + m[0].length }));
// A relative path (Support/CleanShot/media/media_8Qw4Rt2LmZ/CleanShot) is judged the same way. What
// tells it from a base64 key that holds a "/" is two plain words among its names (one can be a
// chance run of letters in a key), or a folder named like secrets. A URL is judged whole.
const WORD = /^[A-Za-z][a-z]{2,}(?:[A-Z][a-z]{2,})*$/;
const LINK = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi;
const linkSpans = value => [...value.matchAll(LINK)].map(m => ({ index: m.index, end: m.index + m[0].length }));
// Under a folder named like secrets, keys, tokens or credentials a base64 key may be split by its
// own "/" (config/secrets/wJalrXUt/K7MDENG/bPxRfiCY…). So there, from the first name that is not
// made of words and numbers (us-east-1, id_ed25519, README) or a hash, the rest is judged as one
// name, when such names make up at least half of it.
const NAMED = /^(?:(?:[A-Z]?[a-z]+|[A-Z]+)\d*|\d+)(?:[-_](?:(?:[A-Z]?[a-z]+|[A-Z]+)\d*|\d+))*$/;
const named = name => WORD.test(name) || NAMED.test(name), plain = name => name.length > 2 && named(name) || HARMLESS.some(re => re.test(name));
const vault = name => /(?:secret|key|token|credential|cred|password|passwd|vault)s?$/i.test(name) && named(name);
function tokenParts(m, paths, links) {
  const end = m.index + m[0].length, inside = spans => spans.some(p => m.index < p.end && end > p.index), names = m[0].split('/');
  const relative = () => names.length > 1 && !inside(links) && (names.filter(name => WORD.test(name)).length > 1 || names.some(vault));
  if (!inside(paths) && !relative()) return [{ text: m[0], index: m.index }];
  let index = m.index; const parts = names.map(text => { const part = { text, index }; index += text.length + 1; return part; });
  const folder = names.findIndex(vault), at = folder < 0 ? -1 : names.findIndex((name, i) => i > folder && name && !plain(name));
  if (at < 0) return parts;
  const rest = names.slice(at), text = rest.join('/');
  return rest.filter(name => !plain(name)).join('').length * 2 < text.length ? parts : [...parts.slice(0, at), { text, index: parts[at].index }];
}
export function scanSecrets(text) {
  const value = String(text ?? ''), found = [], paths = pathSpans(value), links = linkSpans(value);
  const overlaps = (start, end) => found.some(x => start < x.end && end > x.index);
  for (const [kind, re] of PATTERNS) {
    for (const m of value.matchAll(re)) if (!overlaps(m.index, m.index + m[0].length)) found.push({ kind, index: m.index, end: m.index + m[0].length });
  }
  for (const m of value.matchAll(TOKEN)) for (const { text: token, index } of tokenParts(m, paths, links)) {
    if (token.length >= 32 && !overlaps(index, index + token.length) && randomLooking(token)) found.push({ kind: 'high-entropy', index, end: index + token.length });
  }
  return found.sort((a, b) => a.index - b.index).map(({ kind, index }) => ({ kind, index }));
}
// Absolute paths of two or more segments that are not part of a URL or a relative path. A name
// may hold an escaped space ("Application\ Support") or a "~" (com~apple~CloudDocs).
const CHAR = '[\\w.@+~-]', NAME = `(?:${CHAR}|\\\\ )+`, START = '(?<![\\w:/.~\\u0000-])';
const ABSOLUTE = new RegExp(`${START}/${NAME}(?:/${NAME})+/?`, 'g');
const HOME_PATH = new RegExp(`${START}~/${NAME}(?:/${NAME})*/?`, 'g');
// A path with plain spaces in a folder or file name is cut whole in two shapes. In quotes, all of
// it. Without quotes, while each name after a space starts with a capital letter, a digit or
// "(1)", as such names do (a small word may come before a number: "at 10.14.07"), up to the last
// one that holds a "/" or ends in a known file ending: ~/Library/Application Support/CleanShot/
// media/media_8Qw4Rt2LmZ/CleanShot 2026-11-12 at 10.14.07@2x.png. Two lowercase words in a row
// read as a sentence, so "/srv/notes/billing and src/billing.mjs" loses only its first path.
const ENDING = 'png|jpe?g|gif|webp|heic|svg|bmp|tiff?|pdf|txt|md|rtf|docx?|xlsx?|pptx?|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|log|zip|gz|tgz|tar|dmg|pkg|app|mov|mp4|m4a|mp3|wav|key|pages|numbers|sketch|fig|psd|m?js|cjs|tsx?|jsx|py|rb|go|rs|sh|sql|env|plist|ipynb'
  .replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`);
const NEXT = '(?<![./])[ \\u00a0\\u202f](?:[a-z]{1,3} (?=\\d))?', REST = `(?:[A-Z0-9]|\\(\\d+\\))(?:${CHAR}|\\(\\d+\\))*(?:/${CHAR}+)*/?`;
const SPACED = `(?:(?:${NEXT}${REST})*${NEXT}(?=[\\w.@+~()-]*/|[\\w.@+~()/-]*\\.(?:${ENDING})(?![\\w@+/-]))${REST})?`;
const ABSOLUTE_SPACED = new RegExp(ABSOLUTE.source + SPACED, 'g'), HOME_SPACED = new RegExp(HOME_PATH.source + SPACED, 'g');
const QUOTED = new RegExp(`(['"\`])((?:~|/${NAME})/[^'"\`\\n]*)\\1`, 'g');
// A relative path is cut as well when it leads out of the project: it starts with "..", or its
// first folder is not in the project's root on this computer. It is cut plain (spaces and all, as
// above) or in quotes, and only when it reads as a file or folder: a known file ending, or a "/"
// at its end. So src/coupon.mjs in the project goes as written, and so do and/or, a branch such as
// feat/task-1 and a host such as github.com/... With no project folder here to look in, a
// relative path goes as written.
const RELATIVE = new RegExp(`${START}${NAME}(?:/${NAME})+/?${SPACED}`, 'g');
const QUOTED_RELATIVE = new RegExp(`(['"\`])(${NAME}/[^'"\`\\n]*)\\1`, 'g');
const FILE_LIKE = new RegExp(`(?:\\.(?:${ENDING})|/)$`), HOST = /^(?:[\w-]+\.)+[a-z]{2,}$/i;
function entriesOf(root) {
  if (!root) return null;
  try { return new Set(fs.readdirSync(path.resolve(root))); } catch { return null; }
}
function outside(found, entries) {
  const names = found.split('/').filter(Boolean), first = names[0] === '.' ? names[1] : names[0];
  if (!first || !FILE_LIKE.test(found)) return false;
  if (names.includes('..')) return true;
  return !(names[0] !== '.' && HOST.test(first)) && !entries.has(first);
}
function spellings(root) {
  if (!root) return [];
  const resolved = path.resolve(root); let real = resolved;
  try { real = fs.realpathSync(resolved); } catch { /* A missing root is matched as given. */ }
  return [...new Set([resolved, real])].filter(x => x !== path.parse(x).root).sort((a, b) => b.length - a.length);
}
export function redactPaths(text, { root } = {}) {
  const home = os.homedir(), roots = spellings(root), mark = `\u0000${crypto.randomBytes(6).toString('hex')}\u0000`;
  let value = String(text ?? '').replaceAll('\u0000', '');
  // The root may contain spaces, which the path pattern stops at, so it is masked first.
  for (const r of roots) value = value.replace(new RegExp(`${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.@+-])`, 'g'), mark);
  // A ~/ path in the text names a place in the owner's home, never the masked repository.
  const cut = match => {
    const found = match.replace(/\.+$/, ''), tail = match.slice(found.length);
    return (found.startsWith('/') && roots.some(r => within(r, found.replace(/\/$/, ''))) ? found : '[path]') + tail;
  };
  value = value.replace(QUOTED, (all, quote, body) => quote + cut(body) + quote).replace(ABSOLUTE_SPACED, cut).replace(HOME_SPACED, cut);
  const entries = entriesOf(root);
  if (entries) {
    const away = match => { const found = match.replace(/\.+$/, ''); return (outside(found, entries) ? '[path]' : found) + match.slice(found.length); };
    value = value.replace(QUOTED_RELATIVE, (all, quote, body) => quote + away(body) + quote).replace(RELATIVE, away);
  }
  if (roots.length) value = value.replaceAll(mark, path.resolve(root));
  return home && home !== '/' ? value.replaceAll(home, '~') : value;
}
// trusted: the text goes as written, paths and all; the secret scan still
// decides ok. pathsCut says a path became [path], so the owner can learn why a teammate
// could not find a file.
export function prepareOutgoing(text, { root, trusted = false } = {}) {
  const problems = scanSecrets(text), value = String(text ?? '');
  if (trusted) return { ok: problems.length === 0, text: value, problems, pathsCut: false };
  const redacted = redactPaths(value, { root });
  return { ok: problems.length === 0, text: redacted, problems, pathsCut: redacted.split('[path]').length > value.split('[path]').length };
}
