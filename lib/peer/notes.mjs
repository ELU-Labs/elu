import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, hash, isObject, noSymlinks, readJson, refuse } from '../util.mjs';
import { waitLock } from '../state.mjs';
import { registeredProjects, savedProjectName } from '../projects.mjs';
import { localNotes, mergeNotes } from '../project-notes.mjs';
import { savedText } from '../project-settings.mjs';
import { learnedKey } from '../project-learnings.mjs';
import { peerFile, peerRepo } from './paths.mjs';
import { sanitize } from './peerdata.mjs';
import { repoId } from './shares.mjs';
import { bothMine, pairedMine } from './mine.mjs';
import { projectKey } from './remote.mjs';

// A project's instructions and context on every computer of the owner's (docs/peer-network.md,
// "Your other computers"). Each computer tells each other computer of his, both ways, what
// every project of its has (elu.notes): the project's id, name and repository, the links he
// made, and its instructions and context as lib/project-notes.mjs keeps them. Each computer
// puts what came together with what it has, for each project the two link, within seconds of
// a change, and on connect for one that was offline. A teammate's computer is never sent any
// and nothing from one is taken: only keys both computers marked as the owner's (mine.mjs).
//
// Which project there is which here: the one he linked it to (in the project's settings,
// Linked), else the one of the same repository when each computer has only one of it. A link
// is a fact either computer may make: { here, there, at, on }, here the project on the computer
// that made it, there the one on the other. The newer fact about a pair holds, on both sides.
// A computer from before this sends nothing and is sent nothing: the app says it needs an update.
//
// peer/notes/links.json: { <computer key>: [fact] }, the links made here.
// peer/notes/from/<key>.json: { key, at, older, projects: [project] }, what that computer said last.
// peer/notes/said.json: [{ at, text }], the lines the app says once (a text that lost, and where it is).
const PROJECT = /^[0-9a-f]{16}$/, HEX64 = /^[0-9a-f]{64}$/, CHUNK = 50000, SAID = 50;
const file = (...parts) => peerFile('notes', ...parts);
const read = (name, otherwise) => { try { noSymlinks(name); return fs.existsSync(name) ? readJson(name) : otherwise; } catch { return otherwise; } };
const stamp = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
const changing = fn => { const release = waitLock(peerRepo(), 'notes'); try { return fn(); } finally { release(); } };

// ---- What this computer has ----
// Every project here: { root, id, name, repoId, home }. Its repository is asked of git again
// every minute, not on every look.
const repos = new Map();
function repoOf(root, now = Date.now()) {
  const known = repos.get(root); if (known && Math.abs(now - known.at) < 60000) return known.id;
  let id = null; try { id = repoId(root); } catch { id = null; }
  repos.set(root, { id, at: now }); return id;
}
function projectsHere() {
  const home = path.resolve(os.homedir());
  let rows = []; try { rows = registeredProjects(); } catch { rows = []; }
  return rows.map(repo => ({ root: repo.root, id: projectKey(repo.root), name: savedProjectName(repo.root) ?? path.basename(repo.root), repoId: repoOf(repo.root), home: path.resolve(repo.root) === home }));
}
const factsFile = () => file('links.json');
function readFacts() {
  const all = read(factsFile(), {}), out = {};
  for (const [key, list] of Object.entries(isObject(all) ? all : {})) if (HEX64.test(key) && Array.isArray(list)) out[key] = list.filter(fact => isObject(fact) && PROJECT.test(fact.here ?? '') && PROJECT.test(fact.there ?? '')).map(fact => ({ here: fact.here, there: fact.there, at: stamp(fact.at), on: fact.on === true }));
  return out;
}

// ---- What another computer of his said ----
// The rows of one computer's list, joined again by project, each project as it is kept.
// Text and lines stay as typed: they are the owner's own, saved on a computer of his.
const cleanText = value => isObject(value) && typeof value.text === 'string' ? { text: savedText(value.text), at: stamp(value.at) } : null;
function cleanProject(value) {
  if (!isObject(value) || !PROJECT.test(value.id ?? '')) return null;
  const links = (Array.isArray(value.links) ? value.links : []).filter(fact => isObject(fact) && PROJECT.test(fact.there ?? '')).map(fact => ({ there: fact.there, at: stamp(fact.at), on: fact.on === true }));
  const notes = isObject(value.notes) ? value.notes : null, instructions = cleanText(notes?.instructions), own = cleanText(notes?.own);
  const learned = (Array.isArray(notes?.learned) ? notes.learned : []).filter(row => isObject(row) && typeof row.line === 'string' && learnedKey(row.line)).map(row => ({ line: row.line.replace(/[\r\n]+/g, ' ').trimEnd(), since: stamp(row.since), at: stamp(row.at), on: row.on === true }));
  return { id: value.id, name: sanitize(value.name, 60).replace(/[\r\n]+/g, ' ').trim() || value.id.slice(0, 6), repoId: HEX64.test(value.repoId ?? '') ? value.repoId : null, home: value.home === true, links,
    notes: instructions && own ? { instructions, own, learned } : null };
}
export function joinRows(rows) {
  const parts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isObject(row) || !PROJECT.test(row.id ?? '') || !Number.isInteger(row.seq) || !Number.isInteger(row.of) || row.seq < 0 || row.seq >= row.of || typeof row.data !== 'string') continue;
    const kept = parts.get(row.id) ?? { of: row.of, data: [] };
    if (kept.of !== row.of) continue;
    kept.data[row.seq] = row.data; parts.set(row.id, kept);
  }
  const projects = [];
  for (const { of, data } of parts.values()) {
    if (data.filter(item => typeof item === 'string').length !== of) continue;
    let value; try { value = JSON.parse(data.join('')); } catch { continue; }
    const project = cleanProject(value); if (project) projects.push(project);
  }
  return projects;
}
// What key sent, kept until it sends again. Only from a computer of the owner's.
export function takeNotes(me, key, rows) {
  if (!bothMine(me, key)) refuse('Only your own computers share instructions and context.');
  atomic(file('from', `${key}.json`), { key, at: Date.now(), older: false, projects: joinRows(rows) });
}
// A computer of his on a build from before this: it shares nothing, and the app says so.
export function noteOlder(key) {
  const kept = read(file('from', `${key}.json`), null);
  if (kept?.older === true) return;
  atomic(file('from', `${key}.json`), { key, at: Date.now(), older: true, projects: isObject(kept) && Array.isArray(kept.projects) ? kept.projects : [] });
}
function fromComputer(key) {
  const kept = read(file('from', `${key}.json`), null);
  if (!isObject(kept) || kept.key !== key) return null;
  return { key, at: stamp(kept.at), older: kept.older === true, projects: (Array.isArray(kept.projects) ? kept.projects : []).map(cleanProject).filter(Boolean) };
}
function computers() {
  let names = []; try { const folder = file('from'); noSymlinks(folder); names = fs.existsSync(folder) ? fs.readdirSync(folder) : []; } catch { names = []; }
  return names.filter(name => name.endsWith('.json') && HEX64.test(name.slice(0, -5))).map(name => fromComputer(name.slice(0, -5))).filter(Boolean);
}

// ---- Which project there is which here ----
// here: the projects here; there: what that computer said; facts: the links made here for it.
// Returns a map from each project id here to the id there it is linked to.
export function linksWith(here, there, facts = []) {
  const pairs = new Map(), at = (a, b) => `${a}\0${b}`;
  const add = (a, b, fact) => { const kept = pairs.get(at(a, b)); if (!kept || fact.at > kept.at || fact.at === kept.at && !fact.on && kept.on) pairs.set(at(a, b), { here: a, there: b, at: fact.at, on: fact.on }); };
  for (const fact of facts) add(fact.here, fact.there, fact);
  for (const project of there.projects) for (const fact of project.links) add(fact.there, project.id, fact);
  const ids = new Set(here.map(row => row.id)), theirs = new Set(there.projects.map(row => row.id)), linked = new Map(), taken = new Set();
  // The newest link first: a project is linked to one project at a time.
  for (const pair of [...pairs.values()].filter(pair => pair.on).sort((a, b) => b.at - a.at)) {
    if (!ids.has(pair.here) || !theirs.has(pair.there) || linked.has(pair.here) || taken.has(pair.there)) continue;
    linked.set(pair.here, pair.there); taken.add(pair.there);
  }
  // Then the same repository, when each computer has only one project of it and no link said otherwise.
  const one = (rows, id) => rows.filter(row => row.repoId === id).length === 1;
  for (const project of here) {
    if (linked.has(project.id) || !project.repoId || !one(here, project.repoId) || !one(there.projects, project.repoId)) continue;
    const match = there.projects.find(row => row.repoId === project.repoId);
    if (taken.has(match.id) || pairs.get(at(project.id, match.id))?.on === false) continue;
    linked.set(project.id, match.id); taken.add(match.id);
  }
  return linked;
}

// ---- The daemon's side ----
// Every few seconds: what each project here has now, put together with what each computer of
// his said for the project linked to it. A pair is put together again only when either side
// changed since. Returns the projects here with their notes, for the lists sent (notesRows).
// who(key): how the lines name that computer ("@devbox"). telling: a computer of his is
// connected and is sent the list; with none, and none that ever said anything, nothing is read.
const merged = new Map();
export function notesTick({ me, who = key => `@${key.slice(0, 8)}`, now = Date.now(), log = () => {}, telling = true }) {
  const peers = computers().filter(there => !there.older && bothMine(me, there.key));
  if (!telling && !peers.length) return [];
  const here = projectsHere(), notes = new Map();
  const look = project => { try { notes.set(project.id, localNotes(project.root, { now })); } catch (error) { notes.delete(project.id); log(`notes ${project.name}: ${error.message}`); } };
  here.forEach(look);
  const facts = readFacts(), said = [];
  for (const there of peers) {
    for (const [id, theirs] of linksWith(here, there, facts[there.key] ?? [])) {
      const project = here.find(row => row.id === id), them = there.projects.find(row => row.id === theirs);
      if (!project || !them?.notes || !notes.has(id)) continue;
      const pair = `${there.key}\0${id}\0${theirs}`, digest = hash(JSON.stringify([notes.get(id), them.notes]));
      if (merged.get(pair) === digest) continue;
      try {
        const result = mergeNotes(project.root, there.key, them.notes, { now, who: who(there.key), project: project.name });
        said.push(...result.said);
        if (result.changed) look(project);
        merged.set(pair, hash(JSON.stringify([notes.get(id), them.notes])));
      } catch (error) { log(`notes ${project.name}: ${error.message}`); }
    }
  }
  if (said.length) changing(() => atomic(file('said.json'), [...readSaid(), ...said.map(text => ({ at: now, text }))].slice(-SAID)));
  return here.filter(project => notes.has(project.id)).map(project => ({ ...project, notes: notes.get(project.id) }));
}
// The list for one computer of his: each project here in rows of at most CHUNK characters, so
// a long text never makes a row too long for a connection. ELU sets no limit on the text itself.
export function notesRows(key, projects) {
  const facts = readFacts()[key] ?? [];
  return projects.flatMap(project => {
    const value = JSON.stringify({ id: project.id, name: project.name, repoId: project.repoId, home: project.home, links: facts.filter(fact => fact.here === project.id).map(({ there, at, on }) => ({ there, at, on })), notes: project.notes });
    const of = Math.max(1, Math.ceil(value.length / CHUNK));
    return Array.from({ length: of }, (_, seq) => ({ id: project.id, seq, of, data: value.slice(seq * CHUNK, (seq + 1) * CHUNK) }));
  });
}
const readSaid = () => { const value = read(file('said.json'), []); return Array.isArray(value) ? value.filter(row => isObject(row) && typeof row.text === 'string' && Number.isFinite(row.at)) : []; };

// ---- The app's side ----
// For the project at root, each computer of his that said what it has: { key, older, linked,
// same, projects }. linked: the project there it is linked to, { id, name }, or null. same:
// with none linked, the one there of the same name that is linked to nothing here, which the
// app offers to link. projects: every project there, the ones of the same name first.
export function projectLinks(root) {
  const here = projectsHere(), project = here.find(row => path.resolve(row.root) === path.resolve(root)), facts = readFacts();
  if (!project) return [];
  return computers().filter(there => pairedMine(there.key)).map(there => {
    const links = linksWith(here, there, facts[there.key] ?? []), id = links.get(project.id), taken = new Set(links.values());
    const named = row => row.name.toLowerCase() === project.name.toLowerCase();
    const projects = [...there.projects.filter(named), ...there.projects.filter(row => !named(row))].map(row => ({ id: row.id, name: row.name, home: row.home }));
    const linked = id ? projects.find(row => row.id === id) ?? null : null;
    const same = linked ? null : there.projects.filter(row => named(row) && !taken.has(row.id));
    return { key: there.key, older: there.older, linked, same: same?.length === 1 ? { id: same[0].id, name: same[0].name } : null, projects };
  });
}
// Links the project at root to the project id on computer key, or to none (id null). It is
// the newer fact for that pair on both computers; the one it was linked to before is let go,
// so it is not linked again by its repository.
export function linkProject(root, key, id) {
  if (!HEX64.test(key ?? '') || !pairedMine(key)) refuse('Choose one of your computers.');
  if (id !== null && !PROJECT.test(id ?? '')) refuse('Choose a project.');
  const here = projectsHere(), project = here.find(row => path.resolve(row.root) === path.resolve(root)), there = fromComputer(key);
  if (!project) refuse('That project is not on this computer.');
  if (id !== null && !there?.projects.some(row => row.id === id)) refuse('That project is not on that computer now.');
  const now = Date.now(), before = there ? linksWith(here, there, readFacts()[key] ?? []) : new Map();
  changing(() => {
    const all = readFacts(), list = all[key] ?? [], was = before.get(project.id), held = [...before].find(([, theirs]) => theirs === id)?.[0];
    const next = [...list, ...(was && was !== id ? [{ here: project.id, there: was, at: now, on: false }] : []), ...(id ? [{ here: project.id, there: id, at: now, on: true }] : []),
      // The project here that had the one there lets it go too.
      ...(held && held !== project.id ? [{ here: held, there: id, at: now, on: false }] : [])];
    // Only the newest fact about each pair is kept.
    const newest = new Map(); for (const fact of next) { const at = `${fact.here}\0${fact.there}`, kept = newest.get(at); if (!kept || fact.at >= kept.at) newest.set(at, fact); }
    atomic(factsFile(), { ...all, [key]: [...newest.values()] });
  });
}
// The lines to say since after (milliseconds): [{ at, text }].
export const notesSaid = (after = 0) => readSaid().filter(row => row.at > after);
