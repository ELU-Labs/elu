import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, hash, isObject, noSymlinks, readJson, refuse, within } from '../util.mjs';
import { waitLock } from '../state.mjs';
import { git } from '../git.mjs';
import { registeredProjects } from '../projects.mjs';
import { peerFile, peerRepo } from './paths.mjs';

// A share lets teammates ask about one registered project by its handle. repoId lets two
// machines recognise the same repository without sending paths.
const HANDLE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const file = () => peerFile('shares.json');
const validRow = row => isObject(row) && HANDLE.test(row.handle ?? '') && typeof row.root === 'string' && path.isAbsolute(row.root)
  && (row.repoId === null || HEX64.test(row.repoId ?? '')) && typeof row.status === 'boolean' && typeof row.createdAt === 'string'
  && (row.teams === undefined || Array.isArray(row.teams) && row.teams.every(id => typeof id === 'string' && HEX64.test(id)));
export function shares() {
  noSymlinks(file());
  if (!fs.existsSync(file())) return [];
  let rows; try { rows = readJson(file()); } catch { return []; }
  return Array.isArray(rows) ? rows.filter(validRow) : [];
}
// git@host:owner/repo, ssh://user@host:22/owner/repo.git and https://user:token@Host/owner/repo
// all become host/owner/repo: no credentials, scheme, port or trailing .git, host lowercased.
export function normalizeRemote(url) {
  const text = typeof url === 'string' ? url.trim() : '';
  if (!text || text.length > 2048 || /[\x00-\x20\x7f]/.test(text)) return null;
  let host, rest;
  const scp = !text.includes('://') && /^(?:[^@/:]+@)?([^/:]+):(.*)$/.exec(text);
  if (scp) [host, rest] = [scp[1], scp[2]];
  else if (text.startsWith('/')) [host, rest] = ['file', text];
  else {
    let parsed; try { parsed = new URL(text); } catch { return null; }
    host = parsed.protocol === 'file:' ? 'file' : parsed.hostname;
    try { rest = decodeURIComponent(parsed.pathname); } catch { return null; }
  }
  rest = rest.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return host && rest ? `${host.toLowerCase()}/${rest}` : null;
}
export function repoId(root) {
  const result = git(root, ['config', '--get', 'remote.origin.url'], { allowFailure: true });
  const remote = result.status === 0 ? normalizeRemote(result.stdout) : null;
  return remote ? hash(remote) : null;
}
const defaultHandle = root => path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
// A share is for the teams it was shared with (teams), and a question from any other team
// cannot reach it, by name or otherwise. A share saved before teams were kept with it stays
// open to every team of the owner's, as it was, until it is shared again.
const projectTeams = handle => Object.entries(teamProjects()).filter(([, value]) => value === handle).map(([id]) => id);
export function sharedWith(row, teamIds) {
  return Array.isArray(row?.teams) ? row.teams.some(id => teamIds.includes(id)) : teamIds.length > 0;
}
// A project shared again keeps its handle, status and teams; teams named now are added. One
// saved before teams were kept is tied then to every team of the owner's (mine) as well, so
// no team loses it, and a team joined after that is not included.
export function share(root, { handle, status, teams, mine } = {}) {
  for (const list of [teams, mine]) if (list !== undefined && (!Array.isArray(list) || list.some(id => typeof id !== 'string' || !HEX64.test(id)))) refuse('Choose the teams to share with.');
  if (status !== undefined && typeof status !== 'boolean') refuse('Share status must be true or false.');
  if (handle !== undefined && (typeof handle !== 'string' || !HANDLE.test(handle))) refuse('A share handle is 1 to 40 lowercase letters, digits or dashes.');
  let resolved; try { resolved = fs.realpathSync(path.resolve(String(root ?? ''))); } catch { refuse('That folder does not exist.'); }
  // The home folder holds every other project and the owner's own files. It is never shared
  // from here on; a share of it made before this still answers until it is unshared.
  let home = os.homedir(); try { home = fs.realpathSync(home); } catch { /* Compared as given. */ }
  if (within(resolved, home)) refuse('Your home folder cannot be shared. Open the project\'s own folder and share that.');
  // Only the folder that was named is shared: a folder inside a project never stands for the
  // whole project, so a share cannot reach further than what was asked.
  const projects = registeredProjects(), project = projects.find(p => p.root === resolved);
  if (!project) refuse(projects.some(p => within(p.root, resolved)) ? 'This folder is inside a project but is not one. Share the project from its own folder, or open this folder as a project first.' : 'Open this project in ELU Code before sharing it.');
  const id = repoId(project.root);
  const release = waitLock(peerRepo(), 'shares');
  try {
    const rows = shares(), existing = rows.find(row => row.root === project.root);
    const name = handle ?? existing?.handle ?? defaultHandle(project.root);
    if (!HANDLE.test(name)) refuse('A share handle is 1 to 40 lowercase letters, digits or dashes.');
    if (rows.some(row => row.handle === name && row.root !== project.root)) refuse(`The handle ${name} is already shared.`);
    const known = teams ? [...new Set([...(existing ? existing.teams ?? mine ?? projectTeams(existing.handle) : []), ...teams])] : existing?.teams;
    const row = { handle: name, root: project.root, repoId: id, status: status ?? existing?.status ?? true, createdAt: existing?.createdAt ?? new Date().toISOString(), ...(known ? { teams: known } : {}) };
    atomic(file(), [...rows.filter(x => x.root !== project.root), row]);
    // A renamed share stays the project of the teams that had it.
    if (existing && existing.handle !== name && fs.existsSync(teamFile())) atomic(teamFile(), Object.fromEntries(Object.entries(teamProjects()).map(([id, value]) => [id, value === existing.handle ? name : value])));
    return row;
  } finally { release(); }
}
export function unshare(handle) {
  const release = waitLock(peerRepo(), 'shares');
  try {
    const rows = shares(), row = rows.find(x => x.handle === handle);
    if (!row) refuse(`No share is named ${String(handle).slice(0, 40)}.`);
    atomic(file(), rows.filter(x => x !== row));
    const projects = teamProjects(); atomic(teamFile(), Object.fromEntries(Object.entries(projects).filter(([, value]) => value !== row.handle)));
    return row;
  } finally { release(); }
}
// Each team's project on this machine: the share a teammate's question goes to when it names
// none. It is chosen when the teammate is added (/invite and /join in a project), and /share
// in another project moves it there. team-projects.json = {teamId: handle}.
const teamFile = () => peerFile('team-projects.json');
export function teamProjects() {
  noSymlinks(teamFile());
  let value; try { value = fs.existsSync(teamFile()) ? readJson(teamFile()) : {}; } catch { return {}; }
  return isObject(value) ? Object.fromEntries(Object.entries(value).filter(([id, handle]) => HEX64.test(id) && typeof handle === 'string' && HANDLE.test(handle))) : {};
}
export function setTeamProject(teamId, handle) {
  if (typeof teamId !== 'string' || !HEX64.test(teamId)) refuse('Choose a team.');
  const release = waitLock(peerRepo(), 'shares');
  try {
    if (!shares().some(row => row.handle === handle)) refuse(`No share is named ${String(handle).slice(0, 40)}.`);
    atomic(teamFile(), { ...teamProjects(), [teamId]: handle });
  } finally { release(); }
}
// After leaving a team, or before coming back to it: no project of this machine is that
// team's any more, so joining again shares nothing until the owner shares again.
export function forgetTeam(teamId) {
  if (typeof teamId !== 'string' || !HEX64.test(teamId)) refuse('Choose a team.');
  const release = waitLock(peerRepo(), 'shares');
  try {
    const rows = shares();
    if (rows.some(row => row.teams?.includes(teamId))) atomic(file(), rows.map(row => row.teams?.includes(teamId) ? { ...row, teams: row.teams.filter(id => id !== teamId) } : row));
    const projects = teamProjects();
    if (projects[teamId]) atomic(teamFile(), Object.fromEntries(Object.entries(projects).filter(([id]) => id !== teamId)));
  } finally { release(); }
}
// Projects kept off the team board (/share off): their Tasks are told to nobody, even when a
// teammate shares the same repository with the team. board-off.json = [root].
const offFile = () => peerFile('board-off.json');
export function boardOffRoots() {
  noSymlinks(offFile());
  let value; try { value = fs.existsSync(offFile()) ? readJson(offFile()) : []; } catch { return []; }
  return Array.isArray(value) ? value.filter(root => typeof root === 'string' && path.isAbsolute(root)).slice(0, 1000) : [];
}
export const boardOff = root => boardOffRoots().includes(root);
// Off or back on. A project shared from here has its status switched with it, since that is
// what keeps a shared project's Tasks and status rows to itself.
export function setBoardOff(root, off) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) refuse('Open a project first.');
  const release = waitLock(peerRepo(), 'shares');
  try {
    const roots = boardOffRoots().filter(value => value !== root);
    atomic(offFile(), off ? [...roots, root] : roots);
    const rows = shares(), row = rows.find(value => value.root === root);
    if (row && row.status === off) atomic(file(), rows.map(value => value === row ? { ...row, status: !off } : value));
    return row ?? null;
  } finally { release(); }
}
export function teamShare(teamIds) {
  const projects = teamProjects();
  for (const id of teamIds) { const row = projects[id] ? shareFor(projects[id]) : null; if (row) return row; }
  return null;
}
export function shareFor(handleOrRepoId) {
  if (typeof handleOrRepoId !== 'string') return null;
  return shares().find(row => row.handle === handleOrRepoId || (HEX64.test(handleOrRepoId) && row.repoId === handleOrRepoId)) ?? null;
}
