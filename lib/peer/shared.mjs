import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { atomic, findBin, hash, isObject, noSymlinks, personalDirectory, readJson, refuse } from '../util.mjs';
import { registeredProjects, savedProjectName } from '../projects.mjs';
import { peerFile } from './paths.mjs';
import { sanitize } from './peerdata.mjs';
import { loadIdentity } from './identity.mjs';
import { teams } from './roster.mjs';
import { bothMine } from './mine.mjs';
import { boardOffRoots, cloneAddress, normalizeRemote, remoteAddress, repoId, shares, sharedWith } from './shares.mjs';
import { cleanBox } from './status.mjs';
import { DONE_MS, remoteBoards, remotePlans } from './plans.mjs';
import { KEEP_MS, SHOWN_MAX, savedCards } from './cards.mjs';

// The projects teammates share with a team (docs/peer-network.md, "Projects"). Each machine
// tells the members of a team which projects it shares with that team: the share's handle,
// the project's name, its repository id and, when it has one, the git address of its origin
// remote, so a teammate who does not have the project sees it in Projects, can open its
// team board, write to whoever shares it, and bring it to their own computer. A project this
// machine already has (the same repository) is never listed twice: the local one is the row.
// What a teammate sent is text to show: every field is checked on the way in and out.
export const TOLD_MAX = 20;             // projects in one elu.status, and kept for one teammate
export const NAME_MAX = 60;
const HEX64 = /^[0-9a-f]{64}$/, HANDLE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const line = (value, max) => typeof value === 'string' ? sanitize(value, max * 8).replace(/\s+/g, ' ').trim().slice(0, max).trimEnd() : '';
const when = value => { const at = typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN; return Number.isFinite(at) ? new Date(at).toISOString() : null; };
const activeOn = (team, key) => team.members.some(m => m.key === key && !m.removed);

// One shared project as it travels and as it is kept: {handle, name, repoId, address, teams}.
// An address is kept only when it is a network address of that same repository (its
// normalised form hashes to repoId), so a teammate cannot name one repository and have
// another cloned.
export function cleanShared(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, TOLD_MAX).flatMap(row => {
    if (!isObject(row) || !HANDLE.test(row.handle ?? '') || seen.has(row.handle) || !Array.isArray(row.teams)) return [];
    const ids = [...new Set(row.teams.slice(0, 32).filter(id => typeof id === 'string' && HEX64.test(id)))];
    if (!ids.length) return [];
    const id = typeof row.repoId === 'string' && HEX64.test(row.repoId) ? row.repoId : null, address = id ? cloneAddress(row.address) : null, same = address ? normalizeRemote(address) : null;
    seen.add(row.handle);
    return [{ handle: row.handle, name: line(row.name, NAME_MAX) || row.handle, repoId: id, address: same && hash(same) === id ? address : null, teams: ids }];
  });
}
// A project's git address, read again at most every 30 s.
const addresses = new Map();
function addressOf(root, now = Date.now()) {
  const kept = addresses.get(root); if (kept && now - kept.at < 30000 && now >= kept.at) return kept.address;
  let address = null; try { address = remoteAddress(root); } catch { address = null; }
  if (addresses.size > 500) addresses.clear();
  addresses.set(root, { at: now, address }); return address;
}
// What this machine tells one teammate (teamIds: the teams we are both on): each project it
// shares with one of those teams, with or without an origin remote. One turned off with
// /share off is told to nobody until /share on, so it leaves their Projects.
export function toldProjects(teamIds, now = Date.now()) {
  let rows = [], off = []; try { rows = shares(); off = boardOffRoots(); } catch { return []; }
  return cleanShared(rows.filter(row => sharedWith(row, teamIds) && !off.includes(row.root)).slice(0, TOLD_MAX).map(row => ({
    handle: row.handle, name: savedProjectName(row.root) ?? path.basename(row.root), repoId: row.repoId, address: row.repoId ? addressOf(row.root, now) : null, teams: teamIds.filter(id => sharedWith(row, [id])),
  })));
}

// --- What teammates told this machine ---
const file = key => peerFile('shared', `${key}.json`);
// Each elu.status replaces what that teammate said before. One from a build that sends no
// projects (list null) leaves nothing kept, and its rows come from its boards and handles.
export function saveTold(key, list, now = Date.now()) {
  if (!HEX64.test(key ?? '')) return;
  if (!Array.isArray(list)) { const target = file(key); noSymlinks(target); fs.rmSync(target, { force: true }); return; }
  atomic(file(key), { at: new Date(now).toISOString(), projects: cleanShared(list) });
}
export function told(key) {
  try { if (!HEX64.test(key ?? '')) return null; const target = file(key); noSymlinks(target); if (!fs.existsSync(target)) return null; const value = readJson(target); return { at: when(value?.at), projects: cleanShared(value?.projects) }; }
  catch { return null; }
}
// Drops what was kept for anyone who is no longer a teammate.
export function pruneTold({ teammates = [] } = {}) {
  const folder = peerFile('shared'); noSymlinks(folder);
  if (!fs.existsSync(folder)) return;
  for (const name of fs.readdirSync(folder)) if (!/^[0-9a-f]{64}\.json$/.test(name) || !teammates.includes(name.slice(0, 64))) fs.rmSync(path.join(folder, name), { force: true });
}
// What one teammate shares, as this machine knows it. A build that tells its projects is read
// from that. An older one (0.1.19 and earlier) still gives each project it shares: those with
// an origin remote from its boards (plans.mjs), and every handle its hello named (handles:
// what the daemon last heard, from state.json), which is all a project with no remote sends.
// teams null: the build did not say which teams, so every team both machines are on.
function saidBy(key, handles = []) {
  const kept = told(key); if (kept) return kept.projects.map(row => ({ ...row, older: false }));
  const boards = remoteBoards(key).map(row => ({ handle: row.handle, name: row.handle, repoId: row.repoId, address: null, teams: row.teams, older: true }));
  const named = (Array.isArray(handles) ? handles : []).filter(handle => typeof handle === 'string' && HANDLE.test(handle) && !boards.some(row => row.handle === handle)).slice(0, TOLD_MAX);
  return [...boards, ...named.map(handle => ({ handle, name: handle, repoId: null, address: null, teams: null, older: true }))];
}
// The repositories key says it shares with a team both machines are on: the cards of those
// are kept from it though this machine has no clone to prove (cards.mjs).
export function sharedRepos(me, key) {
  try {
    const ids = teams().filter(team => activeOn(team, me) && activeOn(team, key)).map(team => team.id);
    return new Set(saidBy(key).filter(row => row.repoId && (row.teams ?? ids).some(id => ids.includes(id))).map(row => row.repoId));
  } catch { return new Set(); }
}
function readState() { try { const target = peerFile('state.json'); noSymlinks(target); return fs.existsSync(target) ? readJson(target) : null; } catch { return null; } }
// The daemon's last word on each teammate: {key: member}, and whether it is running now.
function heard(state, me, now) {
  const mine = isObject(state) && state.key === me, at = mine ? typeof state.at === 'number' ? state.at : Date.parse(state.at) : NaN;
  const listed = new Map((mine && Array.isArray(state.teams) ? state.teams : []).flatMap(team => Array.isArray(team?.members) ? team.members.filter(m => isObject(m) && typeof m.key === 'string').map(m => [m.key, m]) : []));
  return { listed, live: mine && state.running === true && now - at < 15000 };
}
// The repositories this machine's own projects are clones of, read again every 30 s, and at
// once when the list of projects changes: a project opened or brought here takes its row then.
let local = { at: 0, stamp: '', ids: new Set() };
function localRepos(now) {
  let stamp = '-'; try { const stat = fs.statSync(path.join(personalDirectory(), 'projects.json')); stamp = `${stat.mtimeMs}:${stat.size}`; } catch { stamp = '-'; }
  if (stamp === local.stamp && now - local.at < 30000 && now >= local.at) return local.ids;
  const ids = new Set();
  try { for (const repo of registeredProjects()) { try { const id = repoId(repo.root); if (id) ids.add(id); } catch { /* No repository there. */ } } } catch { /* An unreadable registry names none. */ }
  local = { at: now, stamp, ids }; return ids;
}
const personName = (member, key) => sanitize(member?.name ?? '', 64).replace(/\s+/g, ' ').trim() || key.slice(0, 8);

// Every project a teammate shares with a team this machine is on, that this machine does not
// have, for the Projects tab: [{ id, name, handle, repoId, address, teams: [{id, name}],
// sharers: [{ key, name, box, online, mine, handle, title, older }] }]. One row for each repository,
// whoever shares it (a project with no origin remote is one row for each teammate who shares
// it, since no machine can tell two of those are the same). sharers: who shares it, the ones
// online first; mine: a computer of the owner's own (mine.mjs). Only from someone who is an
// active member of a team this machine is active on now, and only for those teams: after
// this machine leaves the team, or they do, or they stop sharing it, the row is gone.
export function teammateProjects(now = Date.now()) {
  let me = null, all = [];
  try { me = loadIdentity()?.key ?? null; all = me ? teams().filter(team => activeOn(team, me)) : []; } catch { return []; }
  if (!all.length) return [];
  const { listed, live } = heard(readState(), me, now), here = localRepos(now), rows = new Map();
  const people = new Map();
  for (const team of all) for (const m of team.members) if (!m.removed && m.key !== me && !people.has(m.key)) people.set(m.key, m);
  for (const [key, member] of [...people].sort((a, b) => personName(a[1], a[0]).localeCompare(personName(b[1], b[0])))) {
    const common = all.filter(team => activeOn(team, key)), ids = common.map(team => team.id);
    for (const claim of saidBy(key, listed.get(key)?.handles)) {
      const on = (claim.teams ?? ids).filter(id => ids.includes(id));
      if (!on.length || (claim.repoId && here.has(claim.repoId))) continue;
      const id = claim.repoId ?? `${key.slice(0, 16)}-${claim.handle}`;
      const row = rows.get(id) ?? rows.set(id, { id, name: claim.name, handle: claim.handle, repoId: claim.repoId, address: null, teams: [], sharers: [] }).get(id);
      row.address ??= claim.address;
      for (const team of common) if (on.includes(team.id) && !row.teams.some(kept => kept.id === team.id)) row.teams.push({ id: team.id, name: line(team.name, 40) || 'team' });
      let mine = false; try { mine = bothMine(me, key); } catch { mine = false; }
      row.sharers.push({ key, name: personName(member, key), box: cleanBox(listed.get(key)?.box), online: live && listed.get(key)?.online === true, mine, handle: claim.handle, title: claim.name, older: claim.older });
    }
  }
  // The name and the handle are those of whoever a message here goes to: the first sharer.
  for (const row of rows.values()) { row.sharers.sort((a, b) => b.online - a.online); row.handle = row.sharers[0].handle; row.name = row.sharers[0].title; }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
// The team board of one of those projects: what the members of the teams it is shared with
// told this machine about that repository. { row, plans: [{ peer, name, box, online, heardAt,
// tasks }], sessions: [{ peer, name, box, online, heardAt, sessions }] }, the shapes a local
// project's board takes (plans.mjs teammatePlans, cards.mjs teammateSessions). A project with
// no origin remote has no repository id, so nothing is told for it: both lists are empty.
export function sharedBoard(id, now = Date.now()) {
  const row = teammateProjects(now).find(value => value.id === id); if (!row) return null;
  const out = { row, plans: [], sessions: [] }; if (!row.repoId) return out;
  let me = null, all = []; try { me = loadIdentity()?.key ?? null; all = teams(); } catch { return out; }
  const { listed, live } = heard(readState(), me, now), on = new Set(row.teams.map(team => team.id)), people = new Map();
  for (const team of all) if (on.has(team.id) && activeOn(team, me)) for (const m of team.members) if (!m.removed && m.key !== me && !people.has(m.key)) people.set(m.key, m);
  for (const [key, member] of people) {
    const online = live && listed.get(key)?.online === true, base = { peer: key, name: personName(member, key), box: cleanBox(listed.get(key)?.box), online };
    const fresh = saved => { const at = Date.parse(saved?.at ?? ''); return Boolean(saved) && Number.isFinite(at) && (online || now - at <= KEEP_MS); };
    const plans = remotePlans(key);
    if (fresh(plans)) {
      const tasks = plans.tasks.filter(task => task.repoId === row.repoId && (task.state !== 'done' || task.doneAt && now - Date.parse(task.doneAt) < DONE_MS)).slice(0, 20);
      if (tasks.length) out.plans.push({ ...base, heardAt: plans.at, tasks });
    }
    let mine = false; try { mine = bothMine(me, key); } catch { mine = false; }
    const cards = savedCards(key, { mine });
    if (fresh(cards)) {
      const sessions = cards.cards.filter(card => card.repoId === row.repoId).slice(0, SHOWN_MAX);
      if (sessions.length) out.sessions.push({ ...base, heardAt: cards.at, sessions, ...(mine ? { mine: true } : {}) });
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  out.plans.sort(byName); out.sessions.sort(byName); return out;
}

// Brings a shared project to this computer: git clone of the address its sharer told, into
// a folder that does not exist yet or is empty. Git asks nothing: with no saved sign-in for
// that address it fails, and the last line it wrote is the reason. Resolves to the folder.
export function cloneProject(address, folder) {
  if (cloneAddress(address) !== address) refuse('This project has no git address to copy from.');
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) refuse('Choose a folder for the project.');
  if (fs.existsSync(folder) && (!fs.statSync(folder).isDirectory() || fs.readdirSync(folder).length)) refuse('That folder is not empty. Choose a new folder for the project.');
  const bin = findBin('git'); if (!bin) refuse('Git is not installed, so the project cannot be copied here.');
  fs.mkdirSync(path.dirname(folder), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['clone', '--quiet', '--', address, folder], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' } });
    let said = '';
    child.stderr.on('data', data => { said = (said + data).slice(-4000); });
    child.once('error', error => reject(new Error(`Git could not start: ${error.message}`)));
    child.once('exit', code => {
      if (code === 0) { resolve(folder); return; }
      const why = said.split('\n').map(text => line(text.replace(/^(?:fatal|error|remote):\s*/i, ''), 200)).filter(Boolean).at(-1);
      reject(new Error(why ? `Git could not copy it: ${why}` : 'Git could not copy it.'));
    });
  });
}
