import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomic, hash, homeOrAbove, isObject, mkdir, noSymlinks, readJson } from '../util.mjs';
import { firstWords, readTask, sessionGoal } from '../state.mjs';
import { redact } from '../publish.mjs';
import { readBoard, sessionPlace } from '../kanban.mjs';
import { standupOpen } from '../standup.mjs';
import { openTask, sessionTasks } from '../plan.mjs';
import { folderRemote, sessionFolders } from '../kanban-repos.mjs';
import { registeredProjects } from '../projects.mjs';
import { nearbyRepositories } from '../workspace.mjs';
import { peerFile } from './paths.mjs';
import { sanitize } from './peerdata.mjs';
import { redactPaths, scanSecrets } from './secrets.mjs';
import { teams } from './roster.mjs';
import { boardOff, shares } from './shares.mjs';
import { cleanBox } from './status.mjs';
import { firstCommit } from './plans.mjs';

// Every session on the Kanban of everyone on the team who has the same repository
// (docs/peer-network.md, "Kanban"). Each machine tells its teammates about each session it
// runs in a repository they also have: its title, its column, who started it, and when it
// last moved. Nothing else: no chat, no file, no diff, no path. It needs no /share; /share
// off in a project keeps that project's sessions to itself, and its board to its own.
//
// Who has which repository is proven, never just named. Each machine sends each teammate one
// proof per repository it has: sha256 of both machines' keys, the repository's id and its
// first commit. Only someone with a clone of that repository can make the proof that matches,
// and it is good for that pair alone, so it cannot be passed on. A card goes only to a
// teammate whose proof matches this machine's clone, and is taken only from one whose proof
// matches the receiver's: a repository the other side does not have is never sent or kept.
export const CARDS_MAX = 100;           // cards in one message, and kept for one teammate
export const SHOWN_MAX = 40;            // cards of one teammate on one board
export const REPOS_MAX = 200;           // repositories proven to one teammate
export const TITLE_MAX = 80, NAME_MAX = 40;
export const BYTES_MAX = 256 * 1024;    // one elu.cards message
export const KEEP_MS = 48 * 3600000;    // a teammate's cards stay this long after they were last connected
const DONE_TOLD = 20;                   // finished sessions told for each repository, the newest
const HEX64 = /^[0-9a-f]{64}$/, CARD_ID = /^[0-9a-f]{16}$/, PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, REMOTE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COLUMNS = ['progress', 'needs', 'done'];
// One line of untrusted text: no control characters, escapes or invisible characters, one
// space for each run of white space, cut to max.
const line = (value, max) => typeof value === 'string' ? sanitize(value, max * 8).replace(/\s+/g, ' ').trim().slice(0, max).trimEnd() : '';
const when = value => { const at = typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN; return Number.isFinite(at) ? new Date(at).toISOString() : null; };

// The proof that `from` has a clone of repoId whose first commit is commit, for `to` alone.
export const repoProof = (from, to, repoId, commit) => hash(`elu-board-repo\0${from}\0${to}\0${repoId}\0${commit}`);
export function cleanProofs(value) {
  return Array.isArray(value) ? [...new Set(value.slice(0, REPOS_MAX).filter(row => typeof row === 'string' && HEX64.test(row)))] : [];
}

// One card as it travels and as it is kept: only these fields, each within its limit.
// remote: the session's id on the computer that started it, sent only to that computer.
export function cleanCard(value) {
  if (!isObject(value) || !HEX64.test(value.repoId ?? '') || !CARD_ID.test(value.id ?? '') || !COLUMNS.includes(value.column)) return null;
  const title = line(value.title, TITLE_MAX), at = when(value.at); if (!title || !at) return null;
  return { repoId: value.repoId, id: value.id, title, column: value.column, by: line(value.by, NAME_MAX) || null, at,
    ...(typeof value.plan === 'string' && PLAN_ID.test(value.plan) ? { plan: value.plan } : {}), ...(typeof value.remote === 'string' && REMOTE_ID.test(value.remote) ? { remote: value.remote } : {}),
    ...(typeof value.standup === 'boolean' ? { standup: value.standup } : {}) };
}
export function cleanCards(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, CARDS_MAX).flatMap(row => { const card = cleanCard(row), key = card && `${card.repoId}/${card.id}`; if (!card || seen.has(key)) return []; seen.add(key); return [card]; });
}
export function fitCards(rows) {
  const out = rows.slice(0, CARDS_MAX);
  while (out.length && Buffer.byteLength(JSON.stringify(out)) > BYTES_MAX) out.pop();
  return out;
}

// --- The repositories this machine has ---
// A project kept off the board (/share off), or shared from here with status off, has none.
const kept = root => { try { if (boardOff(root)) return true; const own = shares().find(row => row.root === root); return Boolean(own && !own.status); } catch { return true; } };
export const projectOff = kept;
// The clones a project holds: itself when it is one, else those in its folder (a parent folder,
// the home folder), found without opening hidden folders, at most 60, looked for again every 10 minutes.
const scans = new Map();
export function clonesIn(repo, now) {
  if (repo.common) return [repo.root];
  const saved = scans.get(repo.root); if (saved && now - saved.at < 600000 && now >= saved.at) return saved.list;
  let list = []; try { list = nearbyRepositories({ home: repo.root, depth: homeOrAbove(repo.root) ? 4 : 3, limit: 60, budgetMs: 1000 }); } catch { list = []; }
  scans.set(repo.root, { at: now, list }); return list;
}
// Session folders of a project that were active within two weeks (a session's own repository).
function recentSessions(repo, now) {
  const folder = path.join(repo.state, 'tasks'); noSymlinks(folder);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(id => /^[1-9][0-9]*$/.test(id)).flatMap(id => {
    try { const at = fs.statSync(path.join(folder, id, 'task.json')).mtimeMs; return now - at < 15 * 86400000 ? [id] : []; } catch { return []; }
  });
}
// Each task record, read again only when its files changed, with the id of the Task a
// teammate's machine may also be told of (lib/peer/plans.mjs): the approved one, else the last finished.
const records = new Map();
function record(repo, id) {
  const dir = path.join(repo.state, 'tasks', id), stamp = ['task.json', 'name.json', 'settings.json', 'plan.json'].map(name => { try { const stat = fs.statSync(path.join(dir, name)); return `${stat.mtimeMs}:${stat.size}`; } catch { return '-'; } }).join('|');
  const key = `${repo.state}\0${id}`, saved = records.get(key); if (saved?.stamp === stamp) return saved.task;
  // Its current Task goes with it as plan, as on the owner's own board (lib/projects.mjs), so a
  // proposed Task waiting for the owner puts the session in Needs you here too.
  let task = null; try { task = readTask(repo, id); const rows = sessionTasks(repo, id), told = openTask(rows) ?? rows.findLast(row => row.state === 'done'); if (task) task = { ...task, ...(rows.length ? { plan: rows.at(-1) } : {}), ...(told ? { toldTask: told.id } : {}) }; } catch { task = null; }
  if (records.size > 5000) records.clear();
  records.set(key, { stamp, task }); return task;
}
// A clone's repository as the board knows it: { repoId, name, commit }, or null.
function cloneOf(folder, now) {
  const found = folderRemote(folder, now); if (!found) return null;
  const commit = firstCommit(folder, now); return commit ? { ...found, commit } : null;
}
export const repoKey = (repoId, commit) => `${repoId}/${commit}`;
// Every repository this machine has, from its projects that are not kept off:
// Map(repoKey -> { repoId, name, commit, roots: [project roots] }). Two clones with the same
// origin but another first commit are two entries. A clone with no commit yet, no origin
// remote, or that is the home folder or above has none.
export function localRepos(now = Date.now()) {
  const out = new Map();
  const add = (folder, root) => {
    const found = cloneOf(folder, now); if (!found) return;
    const key = repoKey(found.repoId, found.commit), row = out.get(key) ?? { ...found, roots: [] };
    if (!row.roots.includes(root)) row.roots.push(root);
    out.set(key, row);
  };
  let repos = []; try { repos = registeredProjects(); } catch { repos = []; }
  for (const repo of repos) {
    if (kept(repo.root)) continue;
    for (const clone of clonesIn(repo, now)) add(clone, repo.root);
    let ids = []; try { ids = recentSessions(repo, now); } catch { ids = []; }
    const folders = new Set(sessionFolders(repo, ids.map(id => record(repo, id)).filter(Boolean), { clones: clonesIn(repo, now), now }).values());
    for (const folder of folders) if (folder) add(folder, repo.root);
  }
  return out;
}
// What the daemon wrote last: the same map, for the app, which never looks for clones itself.
const localFile = () => peerFile('repos.json');
export function saveLocalRepos(map) { atomic(localFile(), [...map.values()].slice(0, 1000)); }
export function savedLocalRepos() {
  try {
    const target = localFile(); noSymlinks(target); if (!fs.existsSync(target)) return new Map();
    const rows = readJson(target); if (!Array.isArray(rows)) return new Map();
    return new Map(rows.filter(row => isObject(row) && HEX64.test(row.repoId ?? '') && typeof row.commit === 'string' && Array.isArray(row.roots)).map(row => [repoKey(row.repoId, row.commit), { repoId: row.repoId, name: line(row.name, 60) || 'repository', commit: row.commit, roots: row.roots.filter(root => typeof root === 'string' && path.isAbsolute(root)) }]));
  } catch { return new Map(); }
}
// The clones each project not kept off holds, for the app's boards, which never looks for
// them itself: { root: [folders] }, written by the daemon to clones.json.
const clonesFile = () => peerFile('clones.json');
export function projectClones(now = Date.now()) {
  const out = {}; let repos = []; try { repos = registeredProjects(); } catch { repos = []; }
  for (const repo of repos) if (!kept(repo.root)) out[repo.root] = clonesIn(repo, now);
  return out;
}
export function saveProjectClones(value) { atomic(clonesFile(), value); }
export function savedProjectClones(root) {
  try {
    const target = clonesFile(); noSymlinks(target); if (typeof root !== 'string' || !fs.existsSync(target)) return [];
    const value = readJson(target), list = isObject(value) && Object.hasOwn(value, root) ? value[root] : null;
    return Array.isArray(list) ? list.filter(folder => typeof folder === 'string' && path.isAbsolute(folder)).slice(0, 60) : [];
  } catch { return []; }
}
// The proofs this machine sends teammate `to`.
export const proofsFor = (me, to, repos) => [...repos.values()].slice(0, REPOS_MAX).map(row => repoProof(me, to, row.repoId, row.commit));
// Whether teammate `key` proved it has this machine's clone (a localRepos entry).
export function teammateHas(key, me, row, proofs) {
  return Boolean(row) && proofs.includes(repoProof(key, me, row.repoId, row.commit));
}
// Whether they proved it for any of this machine's clones of repoId (only those of one project, with root).
const provenFor = (key, me, repos, repoId, proofs, root = null) => [...repos.values()].some(row => row.repoId === repoId && (!root || row.roots.includes(root)) && teammateHas(key, me, row, proofs));

// --- This machine's sessions, as cards ---
// Who started a session: the teammate whose message started it, else the owner.
// A teammate's answer to the owner's own question continues the owner's work.
const startedBy = (task, owner) => task.origin?.peer && !['mine', 'answer'].includes(task.origin.kind) ? line(task.origin.name, NAME_MAX) || 'teammate' : line(owner, NAME_MAX) || null;
// A title as it leaves this machine, from the first line of the whole text before it is cut:
// one with a secret in it is only "Session", and every absolute or ~/ path in it reads [path].
export function outgoingTitle(text) {
  const first = String(text ?? '').split('\n').find(row => row.trim()) ?? '';
  if (scanSecrets(first).length) return 'Session';
  return line(firstWords(redactPaths(redact(first, 4000)), TITLE_MAX), TITLE_MAX) || 'Session';
}
// A random secret of this machine's, kept in the peer folder, so a card's id stays the same
// here and says nothing to anyone else about the session or the folder it names.
const secrets = new Map();
function cardSecret() {
  const target = peerFile('card-secret'), saved = secrets.get(target); if (saved) return saved;
  const read = () => { try { noSymlinks(target); const value = fs.readFileSync(target, 'utf8').trim(); return HEX64.test(value) ? value : null; } catch { return null; } };
  let value = read();
  if (!value) {
    mkdir(path.dirname(target)); if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    try { fs.writeFileSync(target, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    value = read(); if (!value) throw new Error('The card secret could not be kept.');
  }
  secrets.set(target, value); return value;
}
// The ids of the teams where both this machine and key are members.
const teamIdsWith = (me, key) => { try { return teams().filter(team => [me, key].every(k => team.members.some(m => m.key === k && !m.removed))).map(team => team.id); } catch { return []; } };

// Every session of a project not kept off, in a repository this machine has, where its own
// board shows it: [{ repo (its localRepos key), card, mine, origin, root, taskId }] (mine: the key of my other computer that started it,
// which alone is told its id there). Newest first; for each repository at most DONE_TOLD finished.
export function sessionCards({ owner, repos = localRepos(), now = Date.now() } = {}) {
  const out = [];
  let projects = []; try { projects = registeredProjects(); } catch { projects = []; }
  for (const repo of projects) {
    if (kept(repo.root)) continue;
    let board; try { board = readBoard(repo); } catch { continue; }
    let ids = []; try { ids = recentSessions(repo, now); } catch { continue; }
    // A session moved to Done long ago is still Done there: those the board keeps in Done count too.
    for (const id of board.done.slice(-200)) if (/^[1-9][0-9]*$/.test(id) && !ids.includes(id)) ids.push(id);
    // Each session's repository (lib/kanban-repos.mjs): a conversation in a folder above its
    // clones goes with the project's main repository from its first message.
    const tasks = ids.map(id => record(repo, id)).filter(Boolean), folders = sessionFolders(repo, tasks, { clones: clonesIn(repo, now), now });
    for (const task of tasks) {
      const folder = folders.get(task.id), found = folder && cloneOf(folder, now), row = found && repos.get(repoKey(found.repoId, found.commit)); if (!row) continue;
      const column = sessionPlace(board, task, now); if (!column) continue;
      const linked = board.cards.find(card => card.taskId === task.id && card.column !== 'todo');
      const title = outgoingTitle(linked ? String(linked.text) : (typeof task.title === 'string' && task.title.trim()) || sessionGoal(task));
      const times = [task.createdAt, ...(task.runs ?? []).map(run => run.at), ...(task.messages ?? []).map(message => message.at), board.closed?.[task.id]].map(value => Date.parse(value ?? '')).filter(Number.isFinite);
      const at = new Date(times.length ? Math.max(...times) : now).toISOString();
      // standup: whether a teammate's standup asks it (lib/standup.mjs), whatever column it is in.
      const card = cleanCard({ repoId: row.repoId, id: hash(`${cardSecret()}\0${repo.root}\0${task.id}`).slice(0, 16), title, column, by: startedBy(task, owner), at, plan: task.toldTask,
        remote: task.origin?.kind === 'mine' ? task.origin.remoteId : undefined, standup: standupOpen(board, task, now) });
      // origin: the teammate whose message started it, and the teams it came through.
      const origin = task.origin?.peer && task.origin.kind !== 'mine' ? { peer: task.origin.peer, teams: Array.isArray(task.origin.teams) && task.origin.teams.length ? task.origin.teams : null } : null;
      // root and taskId, for a teammate's standup (lib/peer/standup.mjs) to find the session by,
      // are not enumerable: what turns a row into JSON never carries the path.
      if (card) out.push(Object.defineProperties({ repo: repoKey(row.repoId, row.commit), card, mine: task.origin?.kind === 'mine' && HEX64.test(task.origin.machine ?? '') ? task.origin.machine : null, origin }, { root: { value: repo.root }, taskId: { value: task.id } }));
    }
  }
  out.sort((a, b) => b.card.at.localeCompare(a.card.at));
  const done = new Map();
  return out.filter(row => row.card.column !== 'done' || (done.set(row.repo, (done.get(row.repo) ?? 0) + 1), done.get(row.repo) <= DONE_TOLD));
}
// The cards one teammate is told: only for repositories they proved they have; a session's
// id on my other computer only to that computer. A session a teammate's message started keeps
// to the teams that message came through: anyone else, on teamIds (the teams this machine
// shares with key) alone, sees only that a teammate started a session, not what or who.
export function cardsFor(key, me, rows, repos, proofs, teamIds = teamIdsWith(me, key)) {
  const known = new Map(), teamsOf = peer => known.get(peer) ?? known.set(peer, teamIdsWith(me, peer)).get(peer);
  const inTeam = origin => key === origin.peer || (origin.teams ?? teamsOf(origin.peer)).some(id => teamIds.includes(id));
  return fitCards(rows.filter(row => teammateHas(key, me, repos.get(row.repo), proofs)).map(row => {
    const { remote, plan, ...rest } = row.card;
    // A withheld session says nothing more about itself, whether a standup asks it neither.
    if (row.origin && !inTeam(row.origin)) { const { standup: _unused, ...plainCard } = rest; return { ...plainCard, title: 'Session', by: 'teammate' }; }
    return row.mine === key || !remote ? row.card : { ...rest, ...(plan ? { plan } : {}) };
  }));
}

// --- What teammates told this machine ---
const proofFile = key => peerFile('board-repos', `${key}.json`);
const cardFile = key => peerFile('cards', `${key}.json`);
export function saveProofs(key, list, now = Date.now()) { if (HEX64.test(key ?? '')) atomic(proofFile(key), { at: new Date(now).toISOString(), proofs: cleanProofs(list) }); }
export function savedProofs(key) {
  try { if (!HEX64.test(key ?? '')) return []; const target = proofFile(key); noSymlinks(target); return fs.existsSync(target) ? cleanProofs(readJson(target)?.proofs) : []; }
  catch { return []; }
}
// Each message replaces what that teammate said before. Only cards of a repository this
// machine has and the teammate proved to have are kept; each field is checked on the way in.
export function saveCards(key, me, list, { repos = savedLocalRepos(), proofs = savedProofs(key), now = Date.now() } = {}) {
  if (!HEX64.test(key ?? '') || !HEX64.test(me ?? '')) return [];
  const cards = cleanCards(list).filter(card => provenFor(key, me, repos, card.repoId, proofs));
  atomic(cardFile(key), { at: new Date(now).toISOString(), cards }); return cards;
}
export function savedCards(key) {
  try { if (!HEX64.test(key ?? '')) return null; const target = cardFile(key); noSymlinks(target); if (!fs.existsSync(target)) return null; const value = readJson(target); return { at: when(value?.at), cards: cleanCards(value?.cards) }; }
  catch { return null; }
}
// A teammate who disconnects was heard from until now.
export function heardCards(key, now = Date.now()) {
  const saved = savedCards(key); if (saved) atomic(cardFile(key), { at: new Date(now).toISOString(), cards: saved.cards });
}
// Drops what was kept for anyone no longer a teammate; cards also 48 hours after they were last connected.
export function pruneCards({ teammates = [], online = [], now = Date.now() } = {}) {
  for (const folder of [peerFile('board-repos'), peerFile('cards')]) {
    noSymlinks(folder); if (!fs.existsSync(folder)) continue;
    for (const name of fs.readdirSync(folder)) {
      const key = name.replace(/\.json$/, ''), target = path.join(folder, name);
      if (!name.endsWith('.json') || !HEX64.test(key) || !teammates.includes(key)) { fs.rmSync(target, { force: true }); continue; }
      if (folder.endsWith('cards') && !online.includes(key)) { const at = Date.parse(savedCards(key)?.at ?? ''); if (!Number.isFinite(at) || now - at > KEEP_MS) fs.rmSync(target, { force: true }); }
    }
  }
}

// Teammates' sessions for one of this machine's projects: { repos: [{repoId, name, at}],
// people: [{ peer, name, box, online, heardAt, sessions }] }. Only from a teammate on a team
// with this machine, only for a repository of this project (one of its clones, or one its
// sessions work in) that this machine has and they proved to have, and never in a project kept off.
export function teammateSessions(root, now = Date.now()) {
  const none = { repos: [], people: [] };
  let state = null; try { const target = peerFile('state.json'); noSymlinks(target); if (fs.existsSync(target)) state = readJson(target); } catch { state = null; }
  const me = state?.key; if (typeof me !== 'string' || !HEX64.test(me) || kept(root)) return none;
  const repos = savedLocalRepos(), here = [...repos.values()].filter(row => row.roots.includes(root));
  if (!here.length) return none;
  let all = []; try { all = teams(); } catch { return none; }
  const at = typeof state.at === 'number' ? state.at : Date.parse(state.at), live = state.running === true && now - at < 15000;
  const listed = new Map((Array.isArray(state.teams) ? state.teams : []).flatMap(team => Array.isArray(team?.members) ? team.members.filter(m => isObject(m) && typeof m.key === 'string').map(m => [m.key, m]) : []));
  const people = new Map();
  for (const team of all) if (team.members.some(m => m.key === me && !m.removed)) for (const m of team.members) if (!m.removed && m.key !== me && !people.has(m.key)) people.set(m.key, m);
  const out = [], used = new Map();
  for (const [key, member] of people) {
    const saved = savedCards(key), heard = Date.parse(saved?.at ?? ''); if (!saved || !Number.isFinite(heard)) continue;
    const online = live && listed.get(key)?.online === true;
    if (!online && now - heard > KEEP_MS) continue;
    const proofs = savedProofs(key), sessions = saved.cards.filter(card => provenFor(key, me, repos, card.repoId, proofs, root)).slice(0, SHOWN_MAX);
    if (!sessions.length) continue;
    for (const card of sessions) used.set(card.repoId, Math.max(used.get(card.repoId) ?? 0, Date.parse(card.at)));
    out.push({ peer: key, name: sanitize(member.name, 64).replace(/\s+/g, ' ').trim() || key.slice(0, 8), box: cleanBox(listed.get(key)?.box), online, heardAt: saved.at, sessions });
  }
  return { repos: [...used].map(([repoId, last]) => ({ repoId, name: here.find(row => row.repoId === repoId).name, at: new Date(last).toISOString() })), people: out.sort((a, b) => a.name.localeCompare(b.name)) };
}
