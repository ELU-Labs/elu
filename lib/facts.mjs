import fs from 'node:fs';
import path from 'node:path';
import { inFolders, isObject, mkdir, noSymlinks, personalDirectory, personalDirectoryNames, refuse, within } from './util.mjs';
import { scanSecrets } from './peer/secrets.mjs';

// What the overseeing bot learned about the organization, one fact at a time: a claim in one
// sentence, where it came from, and the exact words there that say so. No model writes this
// file. ELU's code does, when the bot calls its tool for it (lib/orchestrator-actions.mjs),
// and only after the checks here: a fact with no source or no quote is not a fact. The file is
// read on demand, a few facts at a time, and is never sent whole to a model. It stays on this
// computer, in ELU's own folder, which a session's file tools are kept out of.
//
// <personal>/orchestrator/facts.jsonl, one JSON object a line, only ever added to:
//   { id, claim, topic, source: { kind, … }, quote, checked, date, replaces? }   a fact
//   { withdraw: id, date }                                                       one taken back
// A fact is never edited: a newer one names the one it replaces, and one taken back stays in
// the file. What a fact is now (active, replaced or withdrawn) is read from the lines after it.
// Ids are f1, f2, … in the order saved, on this computer alone: the same id on another
// computer is another fact. Each line is added in one write and none is ever rewritten, so
// the file needs no lock: see saveFact for two turns that save at the same moment.
export const FACT_TOPICS = Object.freeze(['business', 'market', 'tech', 'evals', 'team']);
// Where a fact came from, by kind: what must be named there (needs), what else may be (may),
// and, of some, one of which must be (one). web: a page. elu: an answer of the ELU server.
// file: a file of the project. session: a session on this computer. source: a connected
// source, by its server and tool. owner: the owner said so himself.
const SOURCES = Object.freeze({
  web: { needs: ['url'], may: [] },
  elu: { needs: ['tool'], may: ['question', 'issue', 'session', 'url'], one: ['question', 'issue', 'session'] },
  file: { needs: ['path'], may: [] },
  session: { needs: ['session'], may: ['project'] },
  source: { needs: ['server', 'tool'], may: ['question', 'ref', 'url'] },
  owner: { needs: [], may: ['session', 'project'] },
});
export const FACT_KINDS = Object.freeze(Object.keys(SOURCES));
const NAMES = { url: 'the address of the page (url)', tool: 'the tool that answered (tool)', path: 'the file (path)', session: 'the session (session)', server: 'the server (server)', question: 'the question asked (question)', issue: 'the issue (issue)' };
const FROM = { web: 'the web', elu: 'ELU', file: 'a file', session: 'a session', source: 'a connected source', owner: 'the owner' };
const ID = /^f[1-9]\d*$/, CLAIM = 300, QUOTE = 1000, QUOTE_LEAST = 8, WHERE = 500, ADDRESS = 2000, FILE = 2 * 1024 * 1024;
// An email address anywhere in a text. A person's address is never stored, and code cannot
// tell a person's from a team's, so a fact holds none.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
export const holdsEmail = text => EMAIL.test(String(text ?? ''));

// Tests keep ELU's folder in a temporary place. One that reached the owner's own would write
// its made-up facts into what his bot knows, so it is refused.
function folder() {
  if (process.env.NODE_TEST_CONTEXT && !process.env.XDG_CONFIG_HOME) refuse('A test must set XDG_CONFIG_HOME before it uses the facts: the owner\'s own are never a test\'s to read or write.');
  return path.join(personalDirectory(), 'orchestrator');
}
export const factsFile = () => path.join(folder(), 'facts.jsonl');

// Text on one line: no control characters, one space between words.
const flat = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
const number = id => Number(id.slice(1));
const real = target => { try { return fs.realpathSync(target); } catch { return null; } };

// A line of the file as a fact, or null when it is not one: a line that does not read is left
// out, and takes nothing else with it.
function asFact(value) {
  if (!isObject(value) || !ID.test(value.id ?? '') || typeof value.claim !== 'string' || !value.claim.trim() || !isObject(value.source) || !FACT_KINDS.includes(value.source.kind)) return null;
  const source = { kind: value.source.kind };
  for (const [name, text] of Object.entries(value.source)) if (name !== 'kind' && typeof text === 'string' && text) source[name] = text;
  return { id: value.id, claim: value.claim, topic: FACT_TOPICS.includes(value.topic) ? value.topic : 'business', source, quote: typeof value.quote === 'string' ? value.quote : '', checked: value.checked === true,
    date: typeof value.date === 'string' ? value.date : null, ...(ID.test(value.replaces ?? '') ? { replaces: value.replaces } : {}) };
}
// Every fact in the file, oldest first, each with what it is now: status, and for one that
// was replaced or taken back, replacedBy or withdrawn (when). Only the first line of an id is
// read. top: the highest id number in the file. first: the first line of each id, as written.
// ends: whether the file ends with a line end, so a line cut short by a crash is never joined
// with the next.
function readAll() {
  const file = factsFile(); noSymlinks(file);
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { facts: [], top: 0, first: new Map(), ends: true }; throw error; }
  const byId = new Map(), gone = new Map(), first = new Map(); let top = 0;
  for (const row of text.split('\n')) {
    if (!row.trim()) continue;
    let value; try { value = JSON.parse(row); } catch { continue; }
    // A line with an id that does not read as a fact here (a later ELU wrote it) still holds its id.
    if (isObject(value) && ID.test(value.id ?? '')) { top = Math.max(top, number(value.id)); if (!first.has(value.id)) first.set(value.id, row); }
    if (isObject(value) && ID.test(value.withdraw ?? '')) { if (!gone.has(value.withdraw)) gone.set(value.withdraw, typeof value.date === 'string' ? value.date : null); continue; }
    const fact = asFact(value); if (fact && !byId.has(fact.id)) byId.set(fact.id, { ...fact, status: 'active' });
  }
  for (const [id, date] of gone) { const fact = byId.get(id); if (fact) Object.assign(fact, { status: 'withdrawn', withdrawn: date }); }
  // A fact is replaced only while the one that replaced it stands: taking that one back puts it in force again.
  for (const fact of byId.values()) {
    const older = fact.replaces && fact.status !== 'withdrawn' ? byId.get(fact.replaces) : null;
    if (older && older.status !== 'withdrawn') Object.assign(older, { status: 'replaced', replacedBy: fact.id });
  }
  return { facts: [...byId.values()], top, first, ends: !text || text.endsWith('\n') };
}
function append(line, ends) {
  const file = factsFile(); mkdir(path.dirname(file)); noSymlinks(file);
  fs.appendFileSync(file, `${ends ? '' : '\n'}${line}\n`, { mode: 0o600 });
}

// Whether the words of quote are in the file, letter for letter. Line ends and runs of spaces
// between the words do not count: a quote copied from a wrapped line has lost them.
export function quoteInFile(file, quote) {
  const words = flat(quote); if (!words) return false;
  try {
    const stat = fs.statSync(file); if (!stat.isFile() || stat.size > FILE) return false;
    return flat(fs.readFileSync(file, 'utf8')).includes(words);
  } catch { return false; }
}
// The file a fact names, which must be one a session of the project could read itself: inside
// one of roots (the project's folder, a session's working folder), links followed, and not
// ELU's own files. The project's Memory and instructions are what the bot's findings are
// written into, so they are never the source of one. { file, root, path }: path from root.
function fileOf(given, roots) {
  const dirs = [...new Set(roots.map(real).filter(Boolean))];
  if (!dirs.length) refuse('A fact from a file can be saved only from a session of the project the file is in.');
  const file = path.isAbsolute(given) ? real(given) : dirs.map(dir => real(path.join(dir, given))).find(Boolean) ?? null;
  const root = file ? dirs.find(dir => dir !== file && within(dir, file)) : null;
  if (!root) refuse('A fact from a file names a file inside the project, by its path there.');
  const inner = path.relative(root, file);
  if (inner.split(path.sep).some(part => part.toLowerCase() === '.elu-code') || inFolders(personalDirectoryNames(), { caseless: true })(file)) refuse("ELU's own files are never the source of a fact.");
  return { file, root, path: inner };
}
// Where the fact came from, as it is kept: only the fields its kind has, each on one line.
function sourceOf(given, roots) {
  if (!isObject(given) || !FACT_KINDS.includes(given.kind)) refuse(`A fact names where it came from: source.kind is one of ${FACT_KINDS.join(', ')}.`);
  const shape = SOURCES[given.kind], source = { kind: given.kind };
  for (const name of [...shape.needs, ...shape.may]) {
    const text = flat(given[name]);
    if (!text) { if (shape.needs.includes(name)) refuse(`A fact from ${FROM[given.kind]} names ${NAMES[name]}.`); continue; }
    if (text.length > (name === 'url' ? ADDRESS : WHERE)) refuse(`That is too long for where a fact came from: keep source.${name} to ${name === 'url' ? ADDRESS : WHERE} characters.`);
    source[name] = text;
  }
  if (shape.one && !shape.one.some(name => source[name])) refuse(`A fact from ${FROM[given.kind]} names ${shape.one.slice(0, -1).map(name => NAMES[name]).join(', ')} or ${NAMES[shape.one.at(-1)]}.`);
  if (source.url) {
    let url = null; try { url = new URL(source.url); } catch { url = null; }
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) refuse('The address of a page starts with http:// or https:// and holds no sign-in.');
  }
  if (given.kind === 'file') { const found = fileOf(source.path, roots); return { source: { kind: 'file', path: found.path, root: found.root }, file: found.file }; }
  return { source, file: null };
}

// Saves one fact and returns it, with its id. given: { claim, topic, source: { kind, … },
// quote, replaces? }. roots: the folders a fact from a file may name a file in. Refused, with
// the reason in plain words, when: there is no claim or it is not one of the topics; the
// source does not say where; there is no quote and the owner is not the source; a claim or
// quote holds an email address or what may be a secret; the quote of a file is not in that
// file; or it replaces a fact that is not in force. A quote from a file is checked here, so
// checked is true for it. A quote from anywhere else is kept as given and checked is false:
// ELU did not read that page, answer or message itself.
export function saveFact(given, { roots = [], now = new Date() } = {}) {
  if (!isObject(given)) refuse('A fact is a claim, its topic, where it came from and the words there that say so.');
  const claim = flat(given.claim), quote = flat(given.quote), topic = flat(given.topic).toLowerCase();
  if (!claim) refuse('A fact needs its claim: one sentence.');
  if (claim.length > CLAIM) refuse(`Keep the claim to one sentence of at most ${CLAIM} characters.`);
  if (!FACT_TOPICS.includes(topic)) refuse(`A fact has one topic: ${FACT_TOPICS.slice(0, -1).join(', ')} or ${FACT_TOPICS.at(-1)}.`);
  const { source, file } = sourceOf(given.source, roots);
  if (!quote && source.kind !== 'owner') refuse('No quote, no fact: give the exact words of the source that say so. Only what the owner said himself needs none.');
  if (quote && quote.length < QUOTE_LEAST) refuse('That quote is too short to say anything: give the words that support the claim.');
  if (quote.length > QUOTE) refuse(`Keep the quote to the words that support the claim: at most ${QUOTE} characters.`);
  // A folder on this computer (a file's root, a session's project) is where the source is, not
  // something the fact says: a folder a drive names after its account is no address kept.
  const place = ([name, text]) => name === 'root' || name === 'project' && path.isAbsolute(text) && real(text) !== null;
  if ([claim, quote, ...Object.entries(source).filter(entry => !place(entry)).map(([, text]) => text)].some(holdsEmail)) refuse('A fact never holds an email address. Say who by role or by name.');
  if (scanSecrets(claim).length || scanSecrets(quote).length) refuse('That may hold a secret, so it is not saved as a fact.');
  if (file && !quoteInFile(file, quote)) refuse(`Those words are not in ${source.path}. Quote the file's own words, letter for letter.`);
  const replaces = given.replaces == null || given.replaces === '' ? null : String(given.replaces).trim();
  if (replaces !== null && !ID.test(replaces)) refuse('A fact that replaces another names it by its id, such as f12.');
  // The next id is the one after the highest in the file. Two turns that save at the same
  // moment may both take it: the line that reached the file first keeps it, and the other is
  // written once more under the next id. Its first line stays where it is and is never read.
  for (let tries = 0; tries < 50; tries++) {
    const { facts, top, ends } = readAll();
    if (replaces) {
      const older = facts.find(fact => fact.id === replaces);
      if (!older) refuse(`No fact has the id ${replaces}.`);
      if (older.status === 'withdrawn') refuse(`${replaces} was taken back, so there is nothing to replace. Save this as a new fact.`);
      if (older.status === 'replaced') refuse(`${replaces} was already replaced by ${older.replacedBy}. Replace that one.`);
    }
    const row = { id: `f${top + 1}`, claim, topic, source, quote, checked: Boolean(file), date: now.toISOString(), ...(replaces ? { replaces } : {}) }, line = JSON.stringify(row);
    append(line, ends);
    if (readAll().first.get(row.id) === line) return { ...row, status: 'active' };
  }
  refuse('That fact was not saved: too many turns are saving facts at this moment. Save it again.');
}
// A newer fact in place of the one with this id: the old one stays in the file, named by the new one.
export const replaceFact = (id, given, options) => saveFact({ ...given, replaces: id }, options);
// Takes a fact back by its id. It stays in the file and is found by its id, marked withdrawn,
// so a line that cites it still says where it came from and that it no longer holds. A fact
// it had replaced is in force again. { fact, withdrawn }: withdrawn is false when it already was.
export function withdrawFact(id, { now = new Date() } = {}) {
  const wanted = String(id ?? '').trim(), { facts, ends } = readAll(), fact = ID.test(wanted) ? facts.find(row => row.id === wanted) : null;
  if (!fact) refuse(`No fact has the id ${wanted || 'given'}.`);
  if (fact.status === 'withdrawn') return { fact, withdrawn: false };
  const date = now.toISOString(); append(JSON.stringify({ withdraw: fact.id, date }), ends);
  const { replacedBy, ...rest } = fact;
  return { fact: { ...rest, status: 'withdrawn', withdrawn: date }, withdrawn: true };
}

// Every fact, oldest first; only those in force unless all.
export const allFacts = ({ all = false } = {}) => readAll().facts.filter(fact => all || fact.status === 'active');
// One fact by its id, whatever it is now, or null.
export const factById = id => readAll().facts.find(fact => fact.id === String(id ?? '').trim()) ?? null;
// Facts on demand. ids: exactly those, in that order, whatever they are now (a citation must
// resolve even to a fact that was taken back). Otherwise the facts in force (all: every one)
// of the topic, when one is given, that hold any of the words, the ones holding most of them
// first and the newest first among those; with no words, the newest first. At most limit.
export function findFacts({ words = '', topic = null, ids = null, all = false, limit = 20 } = {}) {
  const { facts } = readAll(), most = Math.max(1, Math.min(50, Number.isInteger(limit) ? limit : 20));
  if (ids != null) { const wanted = [...new Set([].concat(ids).map(id => String(id ?? '').trim()))]; return wanted.map(id => facts.find(fact => fact.id === id)).filter(Boolean).slice(0, most); }
  const asked = [...new Set(String(words ?? '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
  const text = fact => [fact.claim, fact.quote, fact.topic, ...Object.values(fact.source)].join(' ').toLowerCase();
  return facts.filter(fact => (all || fact.status === 'active') && (!topic || fact.topic === topic))
    .map(fact => { const held = text(fact); return { fact, score: asked.filter(word => held.includes(word)).length }; })
    .filter(row => !asked.length || row.score > 0)
    .sort((a, b) => b.score - a.score || number(b.fact.id) - number(a.fact.id))
    .slice(0, most).map(row => row.fact);
}

const day = date => { const at = new Date(date ?? NaN); return Number.isFinite(at.getTime()) ? `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}` : null; };
const question = source => source.question ? `, asked "${source.question}"` : '';
// Where a fact came from, in words.
export function sourceText(source) {
  if (source.kind === 'web') return `the web, ${source.url}`;
  if (source.kind === 'elu') return `ELU, ${source.tool}${question(source)}${source.issue ? `, issue ${source.issue}` : ''}${source.session ? `, session ${source.session}` : ''}${source.url ? `, ${source.url}` : ''}`;
  if (source.kind === 'file') return `the file ${source.path}`;
  if (source.kind === 'session') return `session ${source.session}${source.project ? ` of ${path.basename(source.project)}` : ''}`;
  if (source.kind === 'source') return `${source.server}, ${source.tool}${question(source)}${source.ref ? `, ${source.ref}` : ''}${source.url ? `, ${source.url}` : ''}`;
  return `the owner, who said so himself${source.session ? ` in session ${source.session}` : ''}`;
}
// A fact as two lines of plain text, for a tool's answer: the id, topic and claim, with what
// became of it when it is no longer in force; then the source, the day it was read, whether
// ELU found the quote in the source, and the quote.
export function factText(fact) {
  const now = fact.status === 'replaced' ? ` (replaced by ${fact.replacedBy})` : fact.status === 'withdrawn' ? ` (withdrawn${day(fact.withdrawn) ? ` ${day(fact.withdrawn)}` : ''})` : '';
  const quote = !fact.quote ? 'no quote' : `${fact.checked ? 'quote found in the file by ELU' : 'quote not checked by ELU'}: "${fact.quote}"`;
  return `${fact.id} [${fact.topic}] ${fact.claim}${fact.replaces ? ` (replaces ${fact.replaces})` : ''}${now}\n  Source: ${sourceText(fact.source)}${day(fact.date) ? ` · read ${day(fact.date)}` : ''} · ${quote}`;
}
