import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, hash, isObject, noSymlinks, readJson, refuse } from '../util.mjs';
import { waitLock } from '../state.mjs';
import { registeredProjects, savedProjectName } from '../projects.mjs';
import { composeContext, localNotes, mergeNotes } from '../project-notes.mjs';
import { savedText } from '../project-settings.mjs';
import { learnedKey } from '../project-learnings.mjs';
import { peerFile, peerRepo } from './paths.mjs';
import { sanitize } from './peerdata.mjs';
import { repoId } from './shares.mjs';
import { projectKey } from './remote.mjs';
import { loadIdentity } from './identity.mjs';
import { SLOT, commonTeams, sharedRoots, teamOf } from './project-share.mjs';
import { putBackMixed } from './put-back.mjs';

// A project's instructions, context and lessons on every computer that has it
// (docs/peer-network.md, "Instructions and context" and "A shared project"). Each computer
// tells each other one, both ways, what its projects have (elu.notes): each project's id,
// name, repository, the slots of the teams it is a project of (project-share.mjs), and its
// instructions and context as lib/project-notes.mjs keeps them: the two texts, the learned
// lines, and, for a project that has any, the lines of its Organization section (org). An ELU
// from before that section reads past org. Each computer puts what came together with what it
// has, for each project that is the same on both, within seconds of a change, and on connect
// for one that was offline. Every computer, whoever owns it, is told only the projects shared
// with a team both are on, and only those are taken from it.
//
// Which project there is which here, with nothing to link or pair: the one of the same slot
// of a team, as the invite and the join made it (each project of a team has its own). A
// computer from before notes were sent sends nothing and is sent nothing.
//
// An ELU up to 0.1.28 also let the owner match two projects of his computers by hand. What
// that left is still read and sent as it was (links, below), so a match he made then holds on
// both sides, and nothing makes one any more: { here, there, at, on }, here the project on the
// computer that made it, there the one on the other, and the newer about a pair holds.
//
// peer/notes/links.json: { <computer key>: [link] }, those matches as this computer kept them.
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
  const lines = rows => (Array.isArray(rows) ? rows : []).filter(row => isObject(row) && typeof row.line === 'string' && learnedKey(row.line)).map(row => ({ line: row.line.replace(/[\r\n]+/g, ' ').trimEnd(), since: stamp(row.since), at: stamp(row.at), on: row.on === true }));
  const learned = lines(notes?.learned), org = lines(notes?.org);
  const teams = (Array.isArray(value.teams) ? value.teams : []).filter(id => typeof id === 'string' && SLOT.test(id)).slice(0, 64);
  return { id: value.id, name: sanitize(value.name, 60).replace(/[\r\n]+/g, ' ').trim() || value.id.slice(0, 6), repoId: HEX64.test(value.repoId ?? '') ? value.repoId : null, home: value.home === true, links, ...(teams.length ? { teams } : {}),
    notes: instructions && own ? { instructions, own, learned, ...(org.length ? { org } : {}) } : null };
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
// What key sent, kept until it sends again: only its projects of a team both are on, from
// every computer the same.
export function takeNotes(me, key, rows) {
  const teams = commonTeams(me, key);
  if (!teams.length) refuse('Only computers on a project with this one share its instructions and context.');
  const projects = joinRows(rows).filter(project => (project.teams ?? []).some(slot => teams.includes(teamOf(slot))));
  atomic(file('from', `${key}.json`), { key, at: Date.now(), older: false, theirs: true, projects });
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
  return { key, at: stamp(kept.at), older: kept.older === true, theirs: kept.theirs === true, projects: (Array.isArray(kept.projects) ? kept.projects : []).map(cleanProject).filter(Boolean) };
}
function computers() {
  let names = []; try { const folder = file('from'); noSymlinks(folder); names = fs.existsSync(folder) ? fs.readdirSync(folder) : []; } catch { names = []; }
  return names.filter(name => name.endsWith('.json') && HEX64.test(name.slice(0, -5))).map(name => fromComputer(name.slice(0, -5))).filter(Boolean);
}

// ---- Which project there is which here ----
// here: the projects here, each with the teams it is the project of (teams); there: what that
// computer said; facts: the links made here for it. byTeam: only the same team's project (a
// teammate's computer). Returns a map from each project id here to the id there that is it.
export function linksWith(here, there, facts = [], { byTeam = false } = {}) {
  const linked = new Map(), taken = new Set();
  // The same team's project first: what the invite and the join made one.
  for (const project of here) {
    const match = (project.teams ?? []).length ? there.projects.find(row => !taken.has(row.id) && (row.teams ?? []).some(id => project.teams.includes(id))) : null;
    if (match && !linked.has(project.id)) { linked.set(project.id, match.id); taken.add(match.id); }
  }
  if (byTeam) return linked;
  const pairs = new Map(), at = (a, b) => `${a}\0${b}`;
  const add = (a, b, fact) => { const kept = pairs.get(at(a, b)); if (!kept || fact.at > kept.at || fact.at === kept.at && !fact.on && kept.on) pairs.set(at(a, b), { here: a, there: b, at: fact.at, on: fact.on }); };
  for (const fact of facts) add(fact.here, fact.there, fact);
  for (const project of there.projects) for (const fact of project.links) add(fact.there, project.id, fact);
  const ids = new Set(here.map(row => row.id)), theirs = new Set(there.projects.map(row => row.id));
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
  // Then the same name, when each computer has only one project of it and both are of the same
  // repository, or both of none: two repositories of one name are two projects.
  const named = (rows, name) => rows.filter(row => row.name.toLowerCase() === name).length === 1;
  for (const project of here) {
    const name = project.name.toLowerCase();
    if (linked.has(project.id) || project.home || !named(here, name) || !named(there.projects, name)) continue;
    const match = there.projects.find(row => row.name.toLowerCase() === name);
    if (match.home || (match.repoId ?? null) !== (project.repoId ?? null) || taken.has(match.id) || pairs.get(at(project.id, match.id))?.on === false) continue;
    linked.set(project.id, match.id); taken.add(match.id);
  }
  return linked;
}
// The projects here as key is matched with them: the projects shared with it alone.
function hereFor(me, key, here) {
  const shared = sharedRoots(me, key);
  return here.filter(row => shared.has(row.root)).map(row => ({ ...row, teams: shared.get(row.root) }));
}

// The lessons the other computers' copies of the project at root have, as each said last: their
// keys (put-back.mjs).
function heldElsewhere(me, root) {
  const here = projectsHere(), project = here.find(row => path.resolve(row.root) === path.resolve(root)), keys = new Set();
  if (!project) return keys;
  const facts = readFacts();
  for (const there of computers()) {
    const id = linksWith(hereFor(me, there.key, here), there, facts[there.key] ?? [], { byTeam: true }).get(project.id);
    for (const row of (id ? there.projects.find(item => item.id === id)?.notes?.learned : null) ?? []) { const key = row.on ? learnedKey(row.line) : null; if (key) keys.add(key); }
  }
  return keys;
}
// The slots of the teams' projects key said last it has (project-share.mjs): only those
// projects' notes go to a teammate's computer. null while it said nothing yet.
const saidSlots = key => { const said = fromComputer(key); return said ? new Set(said.projects.flatMap(row => row.teams ?? [])) : null; };
// Whether a computer that said what it has (has: saidSlots) gets the notes of the project of
// slot: one it has too; and a team's first project when it has no folder of that team at all,
// as its sessions reach it (project-share.mjs toldRoots), so the team's project shows its
// instructions and memory there before a folder of it is chosen. One that joined only another
// project of the team is not sent the first one's.
const getsNotes = (has, slot) => Boolean(has) && (has.has(slot) || slot.length === 64 && ![...has].some(kept => teamOf(kept) === slot));

// ---- The daemon's side ----
// Every few seconds: what each project here has now, put together with what each computer of
// his said for the project linked to it. A pair is put together again only when either side
// changed since. Returns the projects here with their notes, for the lists sent (notesRows).
// who(key): how the lines name that computer ("@devbox"). telling: a computer of his is
// connected and is sent the list; with none, and none that ever said anything, nothing is read.
const merged = new Map();
export function notesTick({ me, who = key => `@${key.slice(0, 8)}`, now = Date.now(), log = () => {}, telling = true }) {
  // Once, before anything is traded: what ELU 0.1.29 mixed (put-back.mjs).
  const putBack = putBackMixed({ me, log, now, held: root => heldElsewhere(me, root) });
  if (putBack.length) changing(() => atomic(file('said.json'), [...readSaid(), ...putBack.map(text => ({ at: now, text }))].slice(-SAID)));
  const peers = computers().filter(there => !there.older && commonTeams(me, there.key).length);
  if (!telling && !peers.length) return [];
  const here = projectsHere(), notes = new Map();
  const look = project => { try { notes.set(project.id, localNotes(project.root, { now })); } catch (error) { notes.delete(project.id); log(`notes ${project.name}: ${error.message}`); } };
  here.forEach(look);
  const facts = readFacts(), said = [];
  for (const there of peers) {
    for (const [id, theirs] of linksWith(hereFor(me, there.key, here), there, facts[there.key] ?? [], { byTeam: true })) {
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
// A teammate's computer is sent the projects shared with it alone; each project says the teams
// of both that it is a project of, and goes with its notes only once that computer said it has
// that project too (saidSlots): until then with none, so each says which it has without either
// waiting for the other, and a project of the team reaches only the computers that joined it.
export function notesRows(key, projects, me = loadIdentity()?.key) {
  const facts = readFacts()[key] ?? [], told = me ? hereFor(me, key, projects) : [], has = saidSlots(key);
  return told.flatMap(project => {
    const sent = (project.teams ?? []).some(slot => getsNotes(has, slot));
    const value = JSON.stringify({ id: project.id, name: project.name, repoId: project.repoId, home: project.home, links: facts.filter(fact => fact.here === project.id).map(({ there, at, on }) => ({ there, at, on })), ...(project.teams?.length ? { teams: project.teams } : {}), notes: sent ? project.notes : null });
    const of = Math.max(1, Math.ceil(value.length / CHUNK));
    return Array.from({ length: of }, (_, seq) => ({ id: project.id, seq, of, data: value.slice(seq * CHUNK, (seq + 1) * CHUNK) }));
  });
}
const readSaid = () => { const value = read(file('said.json'), []); return Array.isArray(value) ? value.filter(row => isObject(row) && typeof row.text === 'string' && Number.isFinite(row.at)) : []; };

// ---- The app's side ----
// For the project at root, each computer on a team with this one that has it:
// { key, older, linked, same, projects }. linked: the project there that
// is this one, { id, name }, or null. same: with none, the one there of the same name that is
// no project here (ELU up to 0.1.28 offered it). projects: every project there, the ones of the
// same name first. The app shows where else the project is (Also on).
export function projectLinks(root) {
  const all = projectsHere(), project = all.find(row => path.resolve(row.root) === path.resolve(root)), facts = readFacts(), me = loadIdentity()?.key;
  if (!project || !me) return [];
  return computers().filter(there => commonTeams(me, there.key).length).map(there => {
    const here = hereFor(me, there.key, all);
    const links = linksWith(here, there, facts[there.key] ?? [], { byTeam: true }), id = links.get(project.id), taken = new Set(links.values());
    const named = row => row.name.toLowerCase() === project.name.toLowerCase();
    const projects = [...there.projects.filter(named), ...there.projects.filter(row => !named(row))].map(row => ({ id: row.id, name: row.name, home: row.home }));
    const linked = id ? projects.find(row => row.id === id) ?? null : null;
    const same = linked ? null : there.projects.filter(row => named(row) && !taken.has(row.id));
    return linked ? { key: there.key, older: there.older, linked, same: same?.length === 1 ? { id: same[0].id, name: same[0].name } : null, projects } : null;
  }).filter(Boolean);
}
// Every project on another computer that a project here was linked to by hand (ELU up to
// 0.1.28): none is any more; a shared project is the same project everywhere.
export const linkedProjects = () => [];
// Linking a project here to one on another computer by hand (ELU up to 0.1.28) is gone: a
// project shared with a team is one project on every computer that has it.
export function linkProject() { refuse('A shared project is the same project on every computer: there is nothing to link.'); }
// The instructions and memory of team id's first project as the computers that have it said
// them last, newest first, for a computer that has no folder of it yet (the app shows them to
// read there): { instructions, memory }, each '' while none said any. Only from computers on
// that team with this one.
export function teamNotes(teamId) {
  const me = loadIdentity()?.key; if (!me || !HEX64.test(teamId ?? '')) return { instructions: '', memory: '' };
  let instructions = null, own = null; const learned = new Map(), org = new Map();
  for (const there of computers()) {
    if (!commonTeams(me, there.key).includes(teamId)) continue;
    for (const project of there.projects) {
      if (!(project.teams ?? []).includes(teamId) || !project.notes) continue;
      const { notes } = project;
      if (!instructions || notes.instructions.at > instructions.at) instructions = notes.instructions;
      if (!own || notes.own.at > own.at) own = notes.own;
      for (const [held, rows] of [[learned, notes.learned], [org, notes.org ?? []]]) for (const row of rows) { const key = learnedKey(row.line), kept = held.get(key); if (key && (!kept || row.at > kept.at)) held.set(key, row); }
    }
  }
  const lines = held => [...held.values()].filter(row => row.on).sort((a, b) => a.since - b.since).map(row => row.line);
  return { instructions: instructions?.text ?? '', memory: composeContext(own?.text ?? '', lines(learned), lines(org)) };
}
// The lines to say since after (milliseconds): [{ at, text }].
export const notesSaid = (after = 0) => readSaid().filter(row => row.at > after);
