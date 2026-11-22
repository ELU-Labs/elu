import { peerName } from './terminal-visuals.mjs';

// What the lists show while a project is active: that project's own, and nothing of another.
// Sessions lists its sessions, approvals, schedules and teammates' messages about it (boardRows
// with only), and those of my other computers in it (lib/terminal-remote.mjs, by the project
// both computers share, never by its name). Chats lists the teams it is a project of (and those
// no project here is), their channels and people, the threads with them, and the chats with my
// bots started in it.
// Kanban shows its boards only. All projects, last in the Projects tab while there is anything
// else to show, shows every project's again, as before.
export const ALL_PROJECTS = 'All projects';
// What belongs to another project is left out; what belongs to none here yet shows in every
// project, so nothing is out of reach: a team that is no project's here, a teammate's message
// before the owner says where it runs.
// The scope of the active project at root, or null for every project. teams: the ids of the
// teams it is a project of here, claimed: those any project here is (lib/peer/project-share.mjs
// teamSlots). Its teams (teams) are those, and the ones of status (the peer status) that no
// project here is. peers: the keys of the people on them, others: of those on another
// project's team only; names and elsewhere: the names they go by here, as a draft names its
// teammate (lib/peer/index.mjs peerItems).
export function projectScope(root, { teams = [], claimed = [], status = null } = {}) {
  if (typeof root !== 'string' || !root) return null;
  const all = Array.isArray(status?.teams) ? status.teams : [], taken = new Set([...claimed, ...teams]), ids = new Set(teams);
  for (const team of all) if (typeof team?.id === 'string' && !taken.has(team.id)) ids.add(team.id);
  const peers = new Set(), names = new Set(), others = new Set(), elsewhere = new Set();
  for (const team of all) {
    const ours = ids.has(team?.id);
    for (const member of Array.isArray(team?.members) ? team.members : []) if (typeof member?.key === 'string' && member.key !== status.key && !member.removed) { (ours ? peers : others).add(member.key); (ours ? names : elsewhere).add(peerName(member.name, member.key)); }
  }
  for (const key of peers) others.delete(key);
  for (const name of names) elsewhere.delete(name);
  return { root, teams: ids, claimed: taken, peers, names, others, elsewhere };
}
// Whether a teammate's message, or mine to one (a peer item), is the project's: true, another
// project's: false, or no project's here: null. By the project it runs in or was sent from here,
// else by its channel's team, else by who it is with (a draft names them by name only): on one
// of the project's teams, or only on teams another project here is.
export function ofProject(item, scope) {
  if (!scope) return true;
  if (!item || typeof item !== 'object') return false;
  if (typeof item.root === 'string' && item.root) return item.root === scope.root;
  const by = (ours, theirs, value) => ours.has(value) ? true : theirs.has(value) ? false : null;
  if (typeof item.room?.team === 'string') return by(scope.teams, scope.claimed, item.room.team);
  if (typeof item.peer === 'string' && item.peer) return by(scope.peers, scope.others, item.peer);
  return item.kind === 'draft' ? by(scope.names, scope.elsewhere, peerName(item.name)) : null;
}
// Sessions and Chats list a message unless it is another project's.
export const itemInScope = (item, scope) => ofProject(item, scope) !== false;
// What of boardRows's inputs is the project's: the project itself, and the approvals,
// schedules and messages of it. An approval that names no project is kept: it is matched to
// its session by its id, as before.
export function scopeBoard(scope, { projects = [], items = [], approvals = [], schedules = [] } = {}) {
  if (!scope) return { projects, items, approvals, schedules };
  const ours = root => root === scope.root;
  return {
    projects: (Array.isArray(projects) ? projects : []).filter(project => ours(project?.root)),
    items: (Array.isArray(items) ? items : []).filter(item => itemInScope(item, scope)),
    approvals: (Array.isArray(approvals) ? approvals : []).filter(approval => !approval?.root || ours(approval.root)),
    schedules: (Array.isArray(schedules) ? schedules : []).filter(schedule => ours(schedule?.root)),
  };
}
// The names of my bots that have a chat in a project (snapshot: its tasks, closed and queue),
// as botChatSession (lib/bot-schedules.mjs) finds one: a session of its chat that is not
// archived or done, or the message that starts one.
export function botChats(snapshot) {
  const names = new Set(), closed = new Set((Array.isArray(snapshot?.closed) ? snapshot.closed : []).map(String));
  for (const task of Array.isArray(snapshot?.tasks) ? snapshot.tasks : []) if (typeof task?.botChat === 'string' && !closed.has(String(task.id))) names.add(task.botChat);
  for (const request of Array.isArray(snapshot?.queue) ? snapshot.queue : []) if (request?.botChat === true && typeof request.bot === 'string' && !request.continuationTaskId && request.state !== 'done') names.add(request.bot);
  return names;
}
// Whether I am on a team of another project: Chats would show more with All projects.
export function otherTeams(scope, status) {
  return Boolean(scope) && (Array.isArray(status?.teams) ? status.teams : []).some(team => !scope.teams.has(team?.id));
}
// What Chats draws (the app's peer frame) for the project: its teams only, the threads and the
// live sessions of the people on them, and my bots with a chat in it (chats, botChats). The
// teammates' own bots come with them. scoped tells the bar a project with no team is not "no
// team" while I am on one (onTeam), and lists those bots then too.
export function scopeChats(frame, scope, chats = new Set()) {
  if (!scope || !frame?.status) return frame;
  const all = Array.isArray(frame.status.teams) ? frame.status.teams : [], teams = all.filter(team => scope.teams.has(team?.id));
  return { ...frame, scoped: true, onTeam: all.length > 0, status: { ...frame.status, teams },
    ...(Array.isArray(frame.items) ? { items: frame.items.filter(item => itemInScope(item, scope)) } : {}),
    ...(Array.isArray(frame.agents) ? { agents: frame.agents.filter(mate => scope.peers.has(mate?.peer)) } : {}),
    ...(Array.isArray(frame.bots) ? { bots: frame.bots.filter(bot => chats.has(bot?.name)) } : {}) };
}
