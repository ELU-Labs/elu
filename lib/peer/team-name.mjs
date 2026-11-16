import fs from 'node:fs';
import path from 'node:path';
import { isObject, noSymlinks, readJson } from '../util.mjs';
import { peerFile } from './paths.mjs';
import { team } from './roster.mjs';
import { loadIdentity } from './identity.mjs';
import { keptTeamRoots } from './shares.mjs';

// The name a team's project goes by on a computer whose folder of it has no name of its own
// (project-share.mjs): the name the team's founder gives it, as the founder's computer told it
// (shared.mjs). So /workspace on one computer and the home folder on another both read as ELU.
// A folder named here keeps its name, and the founder's computer keeps its own.
const HEX64 = /^[0-9a-f]{64}$/;
const named = value => { const name = typeof value === 'string' ? value.trim() : ''; return name && name.length <= 60 && !/[\u0000-\u001f\u007f-\u009f]/.test(name) ? name : null; };
// The team's first project as the computer key told this one of it (shared.mjs), or null.
function toldFirst(key, teamId) {
  if (!HEX64.test(key ?? '')) return null;
  const file = peerFile('shared', `${key}.json`); noSymlinks(file);
  const told = fs.existsSync(file) ? readJson(file) : null, rows = isObject(told) && Array.isArray(told.projects) ? told.projects : [];
  return rows.find(row => isObject(row) && Array.isArray(row.project) && row.project.includes(teamId)) ?? null;
}
// Read again at most every 10 s: Projects asks for every project on every draw.
const known = new Map();
function founderName(teamId, now) {
  const at = `${peerFile('shared')}\0${teamId}`, kept = known.get(at); if (kept && now - kept.at < 10000 && now >= kept.at) return kept.name;
  let name = null;
  try {
    const state = team(teamId), me = loadIdentity()?.key ?? null;
    if (state?.founder && state.founder !== me && state.members.some(member => member.key === me && !member.removed)) name = named(toldFirst(state.founder, teamId)?.name);
  } catch { name = null; }
  if (known.size > 50) known.clear();
  known.set(at, { at: now, name }); return name;
}
// The team's name for the folder root, when it is a team's project here; else null.
export function teamProjectName(root, now = Date.now()) {
  try {
    const found = Object.entries(keptTeamRoots()).find(([, folder]) => path.resolve(folder) === path.resolve(root));
    return found ? founderName(found[0], now) : null;
  } catch { return null; }
}
// Whether someone else on team id (state: its log, when read already) told this computer of
// the team's first project: someone shared a project with the team by an invite. A team nobody
// shared one with has none, so a computer that joined it has no project of it to take
// (project-share.mjs), and its own stay its own.
export function toldTeamProject(teamId, state = null) {
  try {
    const me = loadIdentity()?.key ?? null; state ??= team(teamId);
    if (!me || !state?.members.some(member => member.key === me && !member.removed)) return false;
    return state.members.some(member => member.key !== me && !member.removed && Boolean(toldFirst(member.key, teamId)));
  } catch { return false; }
}
