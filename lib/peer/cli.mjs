import os from 'node:os';
import path from 'node:path';
import { refuse } from '../util.mjs';
import * as peer from './index.mjs';
import { loadIdentity, validName } from './identity.mjs';
import { appendOp, makeOp, teams } from './roster.mjs';
import { teammate } from './asks.mjs';
import { sanitize } from './peerdata.mjs';

// The peer commands of bin/elu-code.mjs (README, "Teammates"). Each returns a
// result with a message and display lines; --json prints the whole result instead.
const NO_TEAM = 'No team yet. Create one with elu team create NAME, or join one with elu join CODE.';
// On no team nothing should run. A daemon an older version left running (0.1.5 started it
// before a join, which may have failed) is stopped: restartStale starts none on no team.
const stopStray = () => peer.restartStale().catch(() => false);
// The daemon is started when it is not running: it runs while this machine is on a team.
async function daemonCall(command, timeoutMs = 30000) {
  if (!peer.onTeam()) { await stopStray(); refuse(NO_TEAM); }
  await peer.ensurePeer();
  return peer.awaitCommand(peer.sendPeerCommand(command).id, timeoutMs);
}
// What the daemon is doing, for elu peers.
const daemonText = status => status.running ? 'The peer daemon is running.' : peer.onTeam() ? 'The peer daemon is not running. It starts when you open ELU Code, invite or ask.' : 'No team yet, so nothing runs.';
const myTeams = me => teams().filter(state => state.members.some(m => m.key === me.key && !m.removed));
// --team takes an id, an id prefix of 8 or more characters, or a name; without it there must be one team.
function chooseTeam(me, value, { admin = false, none = 'Create a team first with elu team create NAME.', which = 'Choose a team with --team.' } = {}) {
  const mine = myTeams(me).filter(state => !admin || state.members.some(m => m.key === me.key && m.role === 'admin'));
  if (!mine.length) refuse(admin ? 'You are not an admin of any team.' : none);
  if (value === undefined) { if (mine.length > 1) refuse(which); return mine[0]; }
  const found = mine.filter(state => state.id === value || (value.length >= 8 && state.id.startsWith(value)) || state.name === value);
  if (found.length !== 1) refuse(found.length ? 'More than one team matches. Use its id.' : 'No team of yours matches --team.');
  return found[0];
}
const shown = me => ({ name: me.name, key: me.key, fingerprint: me.fingerprint, createdAt: me.createdAt });
// When a teammate is added, the project they can ask about is chosen too: --project PATH, else
// this folder when it can be shared. Only a --project that fails is an error.
function teamShare(teamId, flags) {
  const where = flags.project === undefined ? process.cwd() : path.resolve(String(flags.project));
  try { return { row: peer.share(where, { teams: [teamId] }) }; }
  catch (error) { return { error: flags.project === undefined ? null : error.message }; }
}
const askAbout = ({ row, error }) => row ? ` Your teammates can ask about ${row.handle}, the folder ${row.root}.` : error ? ` Not shared: ${error}` : ' Run elu share in a project so your teammates can ask about it.';
function memberLines(status) {
  const lines = [];
  for (const state of status.teams) {
    lines.push(`${state.name} (${state.id.slice(0, 8)}, ${state.role})`);
    for (const m of state.members) lines.push(`  ${m.key === status.key ? '●' : m.online ? '●' : '○'} ${m.name}  ${m.role}  ${m.key === status.key ? 'you' : m.online ? m.path ?? 'direct' : 'offline'}${m.key !== status.key && peer.peerPolicy(m.key).trusted ? '  trusted' : ''}`);
  }
  return lines;
}
// elu peer trust|untrust @NAME: writes peers.json directly; the daemon
// reads trust per send, so no restart is needed.
function trustCommand(action, words) {
  if (!words[2] || words.length > 3) refuse(`Use elu peer ${action} @NAME.`);
  const member = teammate(peer.identity(), words[2]), name = sanitize(member.name, 40).replace(/[\s@]+/g, '') || member.key.slice(0, 8);
  const { trusted } = peer.savePeerPolicy(member.key, { trusted: action === 'trust' });
  return { peer: { key: member.key, name: member.name, trusted }, message: trusted ? `Trusted @${name}. Paths go out as they are. Their text shows as sent.` : `@${name} is no longer trusted. Paths go out as [path].` };
}

function idCommand(flags) {
  if (flags.import) return { identity: shown(peer.importIdentity(flags.import)), message: 'Identity imported.' };
  let me = loadIdentity(), message = 'This is your peer identity.';
  if (!me) {
    const name = flags.name ?? os.userInfo().username.replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 40);
    if (!validName(name)) refuse('Choose a name with --name.');
    me = peer.identity({ create: true, name }); message = 'Peer identity created.';
  } else if (flags.name !== undefined) { me = peer.identity({ name: flags.name }); message = 'Name changed.'; }
  const result = { identity: shown(me), message, lines: [`${me.name}  ${me.fingerprint}`, `Key: ${me.key}`] };
  if (flags.export) { result.code = peer.exportIdentity(); result.lines.push('Export code. Anyone with it can act as you; keep it secret:', result.code); }
  return result;
}
// There is no on or off: the daemon runs while this machine is on a team. What is left
// under peer: starting it at login, and trusting a teammate. peer --daemon is the daemon
// itself (bin/elu-code.mjs).
async function peerMode(words) {
  const action = words[1];
  if (action === 'install' && words.length === 2) return { service: peer.installService(), message: 'The peer daemon now starts at login while you are on a team.' };
  // It also stops the daemon, from any folder. That lasts until ELU Code opens, or an elu peer
  // command runs, while this machine is on a team; leaving the teams stops it for good.
  if (action === 'uninstall' && words.length === 2) {
    const service = peer.uninstallService(), peerStopped = peer.stopPeer();
    return { service, peerStopped, message: `The peer daemon no longer starts at login${peerStopped ? ', and it stopped' : ''}.` };
  }
  if (action === 'trust' || action === 'untrust') return trustCommand(action, words);
  refuse(`Unknown command: ${words.join(' ')}. Use elu peer install|uninstall or elu peer trust|untrust @NAME.`);
}

// elu team leave [TEAM]. A member's leave goes to the teammates online now; the team of the
// person who made it leaves their machine, and stays with the teammates. On no team after
// it, the peer daemon stops.
async function leaveCommand(value) {
  const me = peer.identity(), state = chooseTeam(me, value, { none: 'You are not on a team.', which: `You are on ${myTeams(me).length} teams. Use elu team leave TEAM.` });
  const name = sanitize(state.name, 60), result = await peer.teamLeave(state.id);
  const how = result.founder ? `You made ${name}, so it stays with your teammates and is gone from this machine.` : `You left ${name}.${result.told === false ? ' Your teammates were not told, since the peer daemon could not start.' : ''}`;
  return { team: { id: state.id, name: state.name }, founder: result.founder === true, message: `${how}${peer.onTeam() ? '' : ' You are on no team now, so the peer daemon stops.'}` };
}

export async function peerCli(words, flags) {
  const [command] = words;
  if (command === 'id') return idCommand(flags);
  if (command === 'peer') return peerMode(words);
  if (command === 'team') {
    if (words[1] === 'create') {
      const name = words.slice(2).join(' ');
      const made = peer.createTeam(name);
      // On a team now, so the daemon starts. A missing networking package is said here; the team stays.
      let note = ''; try { await peer.startPeer(); } catch (error) { note = ` ${error.message}`; }
      return { team: { id: made.id, name: made.name }, message: `Team ${made.name} created. Add a teammate with elu invite.${note}` };
    }
    if (words[1] === 'leave') return leaveCommand(words.length > 2 ? words.slice(2).join(' ') : flags.team);
    if (words[1]) refuse(`Unknown command: team ${words[1]}. Use elu team create NAME or elu team leave [TEAM].`);
    const status = peer.peerStatus();
    return { teams: status.teams, message: status.teams.length ? `${status.teams.length} team${status.teams.length === 1 ? '' : 's'}.` : 'No team yet. Create one with elu team create NAME.', lines: memberLines(status) };
  }
  if (command === 'invite') {
    const me = peer.identity(), state = chooseTeam(me, flags.team, { admin: true }), hours = flags.hours === undefined ? 24 : Number(flags.hours);
    const shared = teamShare(state.id, flags);
    if (shared.error) refuse(shared.error);
    const code = await peer.createInvite(state.id, { hours });
    return { invite: { code, team: state.id, hours, project: shared.row?.handle ?? null, fingerprint: me.fingerprint }, message: `Invite to ${state.name}. It works once, within ${hours} h.${askAbout(shared)} Stay online until they join.`,
      lines: [code, `Your teammate runs this in the project you can ask about: elu join ${code}`] };
  }
  if (command === 'join') {
    // A code pasted with spaces or line breaks in it, or with a second "elu join" in front, comes in several words.
    if (!words[1]) refuse('Use elu join CODE.');
    // Joining shares nothing of the joiner's: elu share does that, whenever they want.
    const joined = await peer.joinTeam(words.slice(1).join(' ')), who = sanitize(joined.inviter?.name, 40);
    return { team: { ...joined, project: null }, message: `Joined ${joined.name}${who ? ` with ${who}` : ''}.` };
  }
  if (command === 'share') {
    if (words.length > 2) refuse('Use elu share [PATH] [--as HANDLE] [--no-status].');
    const row = peer.share(path.resolve(words[1] ?? process.cwd()), { handle: flags.as, status: !flags['no-status'] });
    return { share: row, message: `Shared ${row.root} with your teams as ${row.handle}. Questions that name no project go to it.` };
  }
  if (command === 'unshare') {
    if (words.length !== 2) refuse('Use elu unshare HANDLE.');
    const row = peer.unshare(words[1]);
    return { share: row, message: `Stopped sharing ${row.handle}.` };
  }
  if (command === 'peers') {
    if (!peer.onTeam()) await stopStray();
    const status = peer.peerStatus(), items = peer.peerItems(), agents = peer.teamAgents();
    const lines = [...memberLines(status), ...items.map(item => `${item.kind}  @${item.name}  ${item.text ?? ''}`.slice(0, 160))];
    return { peer: status, items, agents, message: `${daemonText(status)} ${items.length} peer item${items.length === 1 ? '' : 's'}.`, lines: [...status.error ? [`Error: ${status.error}`] : [], ...lines] };
  }
  if (command === 'ask') {
    const to = words[1] ?? '', text = words.slice(2).join(' ');
    // No @NAME: every teammate gets it, and the first to take it answers.
    if (to && !to.startsWith('@')) {
      const { askIds } = await daemonCall({ type: 'teamAsk', project: flags.project ?? null, text: words.slice(1).join(' ') });
      return { askIds, message: `Asked your team (${askIds.length}). The first teammate to take it answers; see elu peers.` };
    }
    if (!/^@[^\s@/\\]{1,64}$/.test(to) || !text.trim()) refuse('Use elu ask [@NAME] [--project H] TEXT.');
    const { askId } = await daemonCall({ type: 'ask', to: to.slice(1), project: flags.project ?? null, text });
    return { askId, message: `Asked ${to}. The answer shows in elu peers.` };
  }
  refuse(`Unknown command: ${words.join(' ')}. Use elu --help.`);
}

// elu relay: serves the chosen team (or every team), and as an admin adds its key to that
// team's roster so teammates' daemons use it after their next start.
export async function startRelay(flags) {
  const me = peer.identity(), chosen = flags.team === undefined ? null : chooseTeam(me, flags.team);
  const { runRelay } = await import('./relay.mjs');
  const relay = await runRelay({ identity: me, bootstrap: peer.peerSettings().bootstrap, teams: chosen ? [chosen.id] : null });
  const added = [];
  for (const state of chosen ? [chosen] : myTeams(me)) {
    if (!state.members.some(m => m.key === me.key && m.role === 'admin') || state.relays.includes(relay.key) || state.relays.length >= 16) continue;
    appendOp(state.id, makeOp(me, state.id, 'relays', { keys: [...state.relays, relay.key] })); added.push(state.name);
  }
  const result = { relay: { key: relay.key, teams: chosen ? [chosen.id] : myTeams(me).map(state => state.id) }, message: `Relay running. Key: ${relay.key}`, lines: [added.length ? `Added to the roster of ${added.join(', ')}.` : 'A team admin adds this key to the roster.', 'Press Ctrl-C to stop.'] };
  return { relay, result };
}
