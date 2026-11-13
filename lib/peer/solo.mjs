import fs from 'node:fs';
import path from 'node:path';
import { atomic, mkdir, noSymlinks, readJson } from '../util.mjs';
import { waitLock } from '../state.mjs';
import { peerFile, peerRepo } from './paths.mjs';
import { sanitize } from './peerdata.mjs';
import { loadIdentity } from './identity.mjs';
import { fold, readLog, teamPath, teams } from './roster.mjs';
import { forgetTeam } from './shares.mjs';
import { forgetTeamAccess } from './access.mjs';

// A team of one (docs/peer-network.md, "Roster"). The first /invite makes a team, so there
// is a code to send. When nobody uses it and this machine then joins someone else's team,
// its own team would stay beside that one: a second #general with only me in it.
//
// So a team of mine that nobody else was ever on is closed once I am on a team somebody
// else is on: by the daemon as a join lands, and by the app once as it opens, for a machine
// an earlier version left on both. Closed means its folder moves, whole, from peer/teams to
// peer/closed-teams. Nothing is deleted. No version of ELU reads it as a team any more, and
// its open invite codes stop working, since a code is answered only for a team this machine
// is on. Nobody is told, since nobody else ever had its log.
//
// Never closed: a team that has, or ever had, anyone else on it (a teammate, another
// computer of mine, someone who left or was removed), and my only team, however empty.

const HEX64 = /^[0-9a-f]{64}$/, closedPath = teamId => peerFile('closed-teams', teamId);
// Whether a team was closed here. The daemon's last heartbeat may still list one closed a moment ago.
export function teamClosed(teamId) { try { return HEX64.test(teamId ?? '') && fs.existsSync(closedPath(teamId)); } catch { return false; } }
// The team's state when I made it and its log holds nothing by anyone else and nobody's
// admit, else null. Read from the log itself, so someone who left or was removed counts.
function alone(me, teamId) {
  const { ops, bad } = readLog(teamId);
  if (!ops.length || bad.length || ops.some(op => op.type === 'admit' || op.by !== me.key)) return null;
  const state = fold(ops, teamId);
  if (state.founder !== me.key || state.members.length !== 1) return null;
  // A used invite admitted someone. Their admit is in the log, and a used row without one keeps the team too.
  try { const file = teamPath(teamId, 'invites.json'); noSymlinks(file); if (fs.existsSync(file) && readJson(file).some(row => row?.usedBy)) return null; } catch { return null; }
  return state;
}
// Under the locks an invite's admit takes, in its order, so nobody is admitted while the team is closed.
function close(me, teamId) {
  const held = [];
  try {
    for (const name of [`invites-${teamId}`, `team-${teamId}`]) held.push(waitLock(peerRepo(), name));
    const state = alone(me, teamId), to = closedPath(teamId);
    noSymlinks(to);
    if (!state || fs.existsSync(to)) return null;
    mkdir(path.dirname(to)); fs.renameSync(teamPath(teamId), to);
    return { id: teamId, name: sanitize(state.name, 60) };
  } finally { for (const release of held.reverse()) { try { release(); } catch { /* Released already. */ } } }
}
// once: the app's look as it opens. It is done one time on a machine (solo-check.json), so a
// team made on purpose later, with elu team create, stays until a join.
const checked = () => peerFile('solo-check.json');
// The teams it closed: [{id, name}].
export function closeSoloTeams({ once = false } = {}) {
  let me = null; try { me = loadIdentity(); } catch { /* No identity: on no team. */ }
  if (!me) return [];
  if (once) { try { noSymlinks(checked()); if (fs.existsSync(checked())) return []; } catch { return []; } }
  const mine = teams().filter(state => state.members.some(member => member.key === me.key && !member.removed)), closed = [];
  let held = false;
  // Only beside a team somebody else is on, or was: my only team stays.
  if (mine.some(state => state.members.length > 1)) {
    for (const state of mine.filter(row => row.members.length === 1)) {
      // A lock another command holds: the next join closes it, or the next start.
      let done = null; try { done = close(me, state.id); } catch { held = true; }
      if (!done) continue;
      closed.push(done);
      // As after a leave: no project of this machine is that team's, and its setting goes.
      try { forgetTeam(state.id); forgetTeamAccess(state.id); } catch { /* Nothing reads them for a team that is gone. */ }
    }
  }
  if (once && !held) { try { atomic(checked(), { at: new Date().toISOString() }); } catch { /* Looked at again at the next start. */ } }
  return closed;
}
// What the app and the shell say about it, in one sentence; empty when nothing was closed.
export function closedLine(closed) {
  const names = (Array.isArray(closed) ? closed : []).map(row => sanitize(row?.name, 40)).filter(Boolean);
  if (!names.length) return '';
  return names.length === 1 ? `Your own team ${names[0]} had only you in it, so it was closed.` : `Your own teams ${names.slice(0, -1).join(', ')} and ${names.at(-1)} had only you in them, so they were closed.`;
}
// After a join that leaves this machine on several teams: each has its own #general.
export const teamsLine = count => Number.isInteger(count) && count > 1 ? `You are on ${count} teams now, each with its own #general.` : '';
