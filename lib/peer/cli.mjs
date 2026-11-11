import os from 'node:os';
import path from 'node:path';
import { refuse } from '../util.mjs';
import * as peer from './index.mjs';
import { loadIdentity, validName } from './identity.mjs';
import { appendOp, makeOp, teams } from './roster.mjs';
import { peerFile } from './paths.mjs';
import { teammate } from './asks.mjs';
import { sanitize } from './peerdata.mjs';

// The peer commands of bin/elu-code.mjs (README, "Teammates"). Each returns a
// result with a message and display lines; --json prints the whole result instead.
const live = () => peer.peerStatus().running;
async function daemonCall(command, timeoutMs = 30000) {
  if (!live()) refuse('The peer daemon is not running. Run elu peer on.');
  return peer.awaitCommand(peer.sendPeerCommand(command).id, timeoutMs);
}
const myTeams = me => teams().filter(state => state.members.some(m => m.key === me.key && !m.removed));
// --team takes an id, an id prefix of 8 or more characters, or a name; without it there must be one team.
function chooseTeam(me, value, { admin = false } = {}) {
  const mine = myTeams(me).filter(state => !admin || state.members.some(m => m.key === me.key && m.role === 'admin'));
  if (!mine.length) refuse(admin ? 'You are not an admin of any team.' : 'Create a team first with elu team create NAME.');
  if (value === undefined) { if (mine.length > 1) refuse('Choose a team with --team.'); return mine[0]; }
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
async function peerMode(words) {
  const action = words[1] ?? 'status';
  if (action === 'on') {
    peer.startPeer();
    // Wait for the first heartbeat, so a start failure shows here and not only in the log.
    for (let until = Date.now() + 20000; Date.now() < until && !live();) await new Promise(resolve => setTimeout(resolve, 200));
    if (!live()) refuse(`The peer daemon did not start. See ${peerFile('daemon.log')}.`);
    return { peer: peer.peerStatus(), message: 'Peer mode is on.' };
  }
  if (action === 'off') { peer.stopPeer(); return { message: 'Peer mode is off.' }; }
  if (action === 'status') {
    const status = peer.peerStatus(), settings = peer.peerSettings();
    return { peer: status, settings, message: `Peer mode is ${settings.enabled ? 'on' : 'off'}; the daemon is ${status.running ? 'running' : 'stopped'}.`, lines: [...status.error ? [`Error: ${status.error}`] : [], ...memberLines(status)] };
  }
  if (action === 'install') return { service: peer.installService(), message: 'The peer daemon now starts at login.' };
  if (action === 'uninstall') return { service: peer.uninstallService(), message: 'The peer daemon no longer starts at login.' };
  if (action === 'trust' || action === 'untrust') return trustCommand(action, words);
  refuse(`Unknown command: peer ${action}. Use elu peer on|off|status|install|uninstall|trust @NAME|untrust @NAME.`);
}

export async function peerCli(words, flags) {
  const [command] = words;
  if (command === 'id') return idCommand(flags);
  if (command === 'peer') return peerMode(words);
  if (command === 'team') {
    if (words[1] === 'create') {
      const name = words.slice(2).join(' ');
      const made = peer.createTeam(name);
      return { team: { id: made.id, name: made.name }, message: `Team ${made.name} created. Add a teammate with elu invite.` };
    }
    if (words[1]) refuse(`Unknown command: team ${words[1]}. Use elu team create NAME.`);
    const status = peer.peerStatus();
    return { teams: status.teams, message: status.teams.length ? `${status.teams.length} team${status.teams.length === 1 ? '' : 's'}.` : 'No team yet. Create one with elu team create NAME.', lines: memberLines(status) };
  }
  if (command === 'invite') {
    const me = peer.identity(), state = chooseTeam(me, flags.team, { admin: true }), hours = flags.hours === undefined ? 24 : Number(flags.hours);
    const shared = teamShare(state.id, flags);
    if (shared.error) refuse(shared.error);
    const code = peer.createInvite(state.id, { hours });
    return { invite: { code, team: state.id, hours, project: shared.row?.handle ?? null }, message: `Invite to ${state.name}. It works once, within ${hours} h.${askAbout(shared)}${live() ? '' : ' Turn on peer mode (elu peer on) so they can join.'}`, lines: [code, 'Your teammate runs it in the project you can ask about: elu join <code>'] };
  }
  if (command === 'join') {
    if (!words[1] || words.length > 2) refuse('Use elu join CODE.');
    const joined = await peer.joinTeam(words[1]), shared = teamShare(joined.id, flags);
    return { team: { ...joined, project: shared.row?.handle ?? null }, message: `Joined ${joined.name}.${askAbout(shared)}${live() ? '' : ' Run elu peer on to talk to your teammates.'}` };
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
    const status = peer.peerStatus(), items = peer.peerItems(), agents = peer.teamAgents();
    const lines = [...memberLines(status), ...items.map(item => `${item.kind}  @${item.name}  ${item.text ?? ''}`.slice(0, 160))];
    return { peer: status, items, agents, message: `The daemon is ${status.running ? 'running' : 'stopped'}. ${items.length} peer item${items.length === 1 ? '' : 's'}.`, lines };
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
