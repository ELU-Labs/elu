import fs from 'node:fs';
import path from 'node:path';
import { registeredProjects } from '../projects.mjs';
import { team, teams } from './roster.mjs';
import { loadIdentity } from './identity.mjs';
import { toldTeamProject } from './team-name.mjs';
import { teamAccess } from './access.mjs';
import { boardOffRoots, keepTeamRoot, keptTeamRoots, shareFor, shares, sharedWith, teamFolders, teamProjects } from './shares.mjs';

// A shared project (docs/peer-network.md, "A shared project"). An invite shares the project it
// was made in, and each computer that joins with it takes the folder it joined in as that
// project. The team is what makes them one project: each computer knows its own folder of it,
// and says which of the team's projects one of its is when it lists its sessions and sends its
// notes, so the others match it to theirs, whatever folder, repository or name each has.
// Everyone on the team sees its sessions and has its instructions, context and lessons, on
// every computer that has it. A project not shared with a team, or kept off with /share off,
// stays on its computer: nothing of it is listed or sent.
//
// A team holds every project shared with it. Each is named on the wire by a slot: the team's
// id for its first project (all an ELU up to 0.1.30 knows), and "<team id>:<id>" for each other
// one (shares.mjs, team-folders.json), which an older ELU does not read and so never takes for
// its first. A computer has one folder for each slot it joined, and only that folder is it.
export const SLOT = /^[0-9a-f]{64}(?::[0-9a-f]{16})?$/;
export const teamOf = slot => String(slot).slice(0, 64);
const same = (a, b) => path.resolve(a) === path.resolve(b);
const active = (team, key) => team.members.some(member => member.key === key && !member.removed);
// The teams both keys are active members of.
export const commonTeams = (me, key) => teams().filter(team => active(team, me) && active(team, key)).map(team => team.id);
// The teams this computer is on.
export const ownTeams = me => teams().filter(team => active(team, me)).map(team => team.id);
// Whether anyone but me is on team id: until then nobody sees its project, so it is not kept yet.
export const othersOn = (me, teamId) => teams().some(team => team.id === teamId && team.members.some(member => member.key !== me && !member.removed));
// The folders here that are team id's other projects.
const otherFolders = teamId => (teamFolders()[teamId] ?? []).map(row => row.root);
// The folder that is team id's first project here, as it is kept, or null: the one kept once
// someone else was on the team (shares.mjs keepTeamRoot); else, on a team nobody joined yet or
// one from before 0.1.30, the folder teammates' messages run in (the first invite and the join
// set it), else the share the team's questions go to. A later /share or invite in another
// project never moves it (0.1.29 moved the share, so that one comes last). A computer that
// joined the team through another of its projects has none: its folders are those projects,
// and nothing kept, set or shared later makes one of them the first. What it shows with when
// none was set is teamRoot's (onlyProject).
export function teamFolder(teamId) {
  const others = otherFolders(teamId), kept = keptTeamRoots()[teamId];
  if (kept) return others.some(root => same(root, kept)) ? null : kept;
  if (others.length) return null;
  const access = teamAccess(teamId)?.root;
  if (access) return access;
  const handle = teamProjects()[teamId], row = handle ? shareFor(handle) : null;
  return row && sharedWith(row, [teamId]) ? row.root : null;
}
// A computer that joined the team and whose join set no folder (ELU 0.1.19 set none, and a join
// in the home folder sets none), or whose folder is gone, is on the team all the same: with one
// project, that one is the team's project here, kept so a project added later never moves it.
// Not kept in the first minute after joining, while the join still says its folder. Never one
// that is another team's project here, nor on a computer that joined only another project of
// the team. With several projects, none is taken: the team's project shows without a folder
// here until a session there says which it is (the app asks). The computer that made the team
// shares its project by an invite, and one it never shared stays its own. Only once a teammate
// told this computer of the team's project: on a team nobody shared a project with, the one
// project here is never taken, so nothing of it reaches the team.
const JOINING_MS = 60000;
function onlyProject(teamId) {
  const projects = registeredProjects(); if (projects.length !== 1 || otherFolders(teamId).length) return null;
  const root = projects[0].root;
  let me = null; try { me = loadIdentity()?.key ?? null; } catch { me = null; }
  // This team's log alone first: every team's is read only for a computer that joined this one.
  let state = null; try { state = me ? team(teamId) : null; } catch { state = null; }
  const mine = state?.members.find(member => member.key === me && !member.removed);
  if (!state || !mine || state.founder === me || !state.members.some(member => member.key !== me && !member.removed) || !toldTeamProject(teamId, state)) return null;
  const taken = teams().filter(other => other.id !== teamId && active(other, me)).some(other => [teamFolder(other.id), ...otherFolders(other.id)].some(folder => folder && same(folder, root)));
  if (taken) return null;
  if (Date.now() - (Number(mine.joinedAt) || 0) < JOINING_MS) return root;
  try { keepTeamRoot(teamId, root); } catch { /* Kept at a later read. */ }
  return keptTeamRoots()[teamId] ?? root;
}
// A folder as a team project here: null when it is not a project here any more, or it is kept
// off (/share off, or shared with status off).
function inUse(root) {
  if (!root || boardOffRoots().includes(root)) return null;
  if (shares().some(row => same(row.root, root) && !row.status)) return null;
  const found = registeredProjects().find(project => same(project.root, root));
  return found ? found.root : null;
}
// The folder here that is team id's first project, or null: the one set, while it is there
// (one set by a join and not opened in ELU yet is waited for), else onlyProject's. One kept
// stays it.
export function teamRoot(teamId) {
  const folder = teamFolder(teamId);
  if (folder && (keptTeamRoots()[teamId] || fs.existsSync(folder))) return inUse(folder);
  return inUse(onlyProject(teamId));
}
// Every project of team id here, the first one first: [{ slot, root }].
export function teamSlots(teamId) {
  const out = [], first = teamRoot(teamId);
  if (first) out.push({ slot: teamId, root: first });
  for (const row of teamFolders()[teamId] ?? []) {
    const root = inUse(row.root);
    if (root && !out.some(kept => same(kept.root, root))) out.push({ slot: `${teamId}:${row.id}`, root });
  }
  return out;
}
// The folder here of one slot, or null.
export const slotRoot = slot => SLOT.test(slot ?? '') ? teamSlots(teamOf(slot)).find(row => row.slot === slot)?.root ?? null : null;
// The id of the other project of team teamId that the folder root is here, or null when it is
// the team's first or none of its projects; kept off or not, as an invite made in it names it.
export function otherProject(teamId, root) {
  if (!root) return null;
  const first = teamFolder(teamId);
  if (first && same(first, root)) return null;
  return (teamFolders()[teamId] ?? []).find(row => same(row.root, root))?.id ?? null;
}
// Each project here that is a project of a team me and key are both on: root → [slots].
export function sharedRoots(me, key) {
  const out = new Map();
  for (const id of commonTeams(me, key)) for (const { slot, root } of teamSlots(id)) out.set(root, [...out.get(root) ?? [], slot]);
  return out;
}
// The projects here a teammate's computer is told of and sent anything of: those of sharedRoots
// whose slot it says it has a folder of too (has, a Set), so a project of the team reaches only
// the computers that joined it. For a team it says no folder of (an ELU before 0.1.31 says none,
// as it knows no other), the team's first project, as before.
export function toldRoots(me, key, has = null) {
  const out = new Map(), says = new Set([...has ?? []].map(teamOf));
  for (const [root, slots] of sharedRoots(me, key)) {
    const kept = slots.filter(slot => says.has(teamOf(slot)) ? has.has(slot) : slot.length === 64);
    if (kept.length) out.set(root, kept);
  }
  return out;
}
// The slots of the teams this computer is on with key that it has a folder of, kept off or not,
// which it says to that computer so it is told what it has (toldRoots).
export function slotsWith(me, key) {
  const out = [];
  for (const id of commonTeams(me, key)) {
    if (teamFolder(id) || teamRoot(id)) out.push(id);
    for (const row of teamFolders()[id] ?? []) out.push(`${id}:${row.id}`);
  }
  return out;
}
// Every team project here, for this computer's own teams: slot → root.
export function teamRoots(me) {
  const out = new Map();
  for (const id of ownTeams(me)) for (const { slot, root } of teamSlots(id)) out.set(slot, root);
  return out;
}
