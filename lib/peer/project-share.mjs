import path from 'node:path';
import { registeredProjects } from '../projects.mjs';
import { teams } from './roster.mjs';
import { teamAccess } from './access.mjs';
import { boardOffRoots, keptTeamRoots, shareFor, shares, sharedWith, teamProjects } from './shares.mjs';

// A shared project (docs/peer-network.md, "A shared project"). An invite shares the project it
// was made in, and each computer that joins the team takes the folder it joined in as that
// project. The team is what makes them one project: each computer knows its own folder of it,
// and says which team a project of its is when it lists its sessions and sends its notes, so
// the others match it to theirs by the team, whatever folder, repository or name each has.
// Everyone on the team sees its sessions and has its instructions, context and lessons, on
// every computer that has it. A project not shared with a team, or kept off with /share off,
// stays on its computer: nothing of it is listed or sent.
const active = (team, key) => team.members.some(member => member.key === key && !member.removed);
// The teams both keys are active members of.
export const commonTeams = (me, key) => teams().filter(team => active(team, me) && active(team, key)).map(team => team.id);
// The teams this computer is on.
export const ownTeams = me => teams().filter(team => active(team, me)).map(team => team.id);
// Whether anyone but me is on team id: until then nobody sees its project, so it is not kept yet.
export const othersOn = (me, teamId) => teams().some(team => team.id === teamId && team.members.some(member => member.key !== me && !member.removed));
// The folder that is team id's project here, as it is kept, or null: the one kept once someone
// else was on the team (shares.mjs keepTeamRoot); else, on a team nobody joined yet or one
// from before 0.1.30, the folder teammates' messages run in (the first invite and the join set
// it), else the share the team's questions go to. A later /share or invite in another project
// never moves it (0.1.29 moved the share, so that one comes last).
export function teamFolder(teamId) {
  const kept = keptTeamRoots()[teamId];
  if (kept) return kept;
  const access = teamAccess(teamId)?.root;
  if (access) return access;
  const handle = teamProjects()[teamId], row = handle ? shareFor(handle) : null;
  return row && sharedWith(row, [teamId]) ? row.root : null;
}
// The folder here that is team id's project: null when it has none, it is not a project here
// any more, or it is kept off (/share off, or shared with status off).
export function teamRoot(teamId) {
  const root = teamFolder(teamId);
  if (!root || boardOffRoots().includes(root)) return null;
  if (shares().some(row => path.resolve(row.root) === path.resolve(root) && !row.status)) return null;
  const projects = registeredProjects(), found = projects.find(project => path.resolve(project.root) === path.resolve(root));
  return found ? found.root : null;
}
// Each project here that is the project of a team me and key are both on: root → [team ids].
export function sharedRoots(me, key) {
  const out = new Map();
  for (const id of commonTeams(me, key)) { const root = teamRoot(id); if (root) out.set(root, [...out.get(root) ?? [], id]); }
  return out;
}
// Every team project here, for this computer's own teams: team id → root.
export function teamRoots(me) {
  const out = new Map();
  for (const id of ownTeams(me)) { const root = teamRoot(id); if (root) out.set(id, root); }
  return out;
}
