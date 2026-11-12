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
const daemonText = status => status.running ? 'The peer daemon is running.' : peer.onTeam() ? 'The peer daemon is not running. It starts when you open ELU Code, invite or ask.'
  : peer.leaveUnheard() ? 'The peer daemon is not running. It starts when you open ELU Code, to tell a former teammate you left.' : 'No team yet, so nothing runs.';
const myTeams = me => teams().filter(state => state.members.some(m => m.key === me.key && !m.removed));
// --team takes an id, an id prefix of 8 or more characters, or a name; without it there must be one team.
function chooseTeam(me, value, { admin = false, which = 'Choose a team with --team.' } = {}) {
  const mine = myTeams(me).filter(state => !admin || state.members.some(m => m.key === me.key && m.role === 'admin'));
  if (!mine.length) refuse(admin ? 'You are not an admin of any team.' : 'Create a team first with elu team create NAME.');
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
// What teammates can do here (access.mjs), from --auto or --manual, --rules and --project.
// The project is --project, else this folder.
function accessUpdate(flags, { defaults = false } = {}) {
  if (flags.auto && flags.manual) refuse('Choose --auto or --manual.');
  const update = {};
  if (flags.auto || flags.manual || defaults) update.handling = flags.manual ? 'manual' : 'auto';
  if (flags.rules !== undefined || defaults) update.rules = peer.checkRules(flags.rules ?? '');
  if (flags.project !== undefined || defaults) { try { update.root = peer.checkRoot(flags.project ?? process.cwd()); } catch (error) { if (flags.project !== undefined) throw error; } }
  return update;
}
const HANDLING = { auto: 'Auto: a teammate\'s message starts a session here, as if you typed it.', manual: 'Manual: each message waits for you to approve it.' };
function accessLines(state, access) {
  if (!access) return [`${state.name}: not set. Messages wait for you to approve them. Set it with elu access --auto or --manual.`];
  const known = access.root && peer.registeredProjects().some(repo => repo.root === access.root);
  return [`${state.name}`, `  ${HANDLING[access.handling]}`, `  Rules: ${access.rules ? access.rules.replace(/\n+/g, ' ') : 'none'}`,
    `  Project: ${access.root ? `${access.root}${known ? '' : ' (open it in ELU Code so sessions can start there)'}` : 'none yet; run elu access in the project'}`];
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

// elu team leave and elu team remove: one signed roster op each, sent through the daemon (started
// for it when it is not running) so teammates online now are told. A leave no teammate took
// keeps the daemon running until one has; otherwise, on no team after it, the daemon stops.
const leaveNote = result => result?.told === false && result.daemon === false ? ' Your teammates were not told, since the peer daemon could not start. It tells them once it can.'
  : result?.told === false ? ' No teammate was online, so the first one to connect is told.'
    : result?.stopping ? ' You are on no team now, so the peer daemon stops.' : '';
async function leaveCommand(value) {
  const me = peer.identity(), state = chooseTeam(me, value, { which: `You are on ${myTeams(me).length} teams. Use elu team leave TEAM.` });
  if (state.founder === me.key) refuse(`You made ${state.name}, so you cannot leave it. elu team remove NAME removes a teammate.`);
  const result = await peer.teamChange({ type: 'teamLeave', team: state.id });
  return { team: { id: state.id, name: state.name }, told: result?.told !== false, message: `You left ${state.name}.${leaveNote(result)}` };
}
async function removeCommand(words, flags) {
  const typed = String(words[2] ?? '').replace(/^@+/, '');
  if (!typed || words.length > 3) refuse('Use elu team remove NAME [--team TEAM].');
  const me = peer.identity(), scope = flags.team === undefined ? myTeams(me) : [chooseTeam(me, flags.team)];
  const plain = value => sanitize(value, 40).replace(/[\s@]+/g, '').toLowerCase();
  const found = scope.flatMap(state => state.members.filter(m => !m.removed && m.key !== me.key && (plain(m.name) === typed.toLowerCase() || (typed.length >= 8 && m.key.startsWith(typed)))).map(member => ({ state, member })));
  if (!found.length) refuse(`No teammate ${typed} on ${scope.length === 1 ? scope[0].name : 'your teams'}.`);
  if (found.length > 1) refuse(new Set(found.map(row => row.state.id)).size > 1 ? `${typed} is on more than one of your teams. Use --team.` : `Two teammates are called ${typed}. Use the first 8 characters of their key from elu peers --json.`);
  const [{ state, member }] = found, name = sanitize(member.name, 40);
  if (!state.members.some(m => m.key === me.key && !m.removed && m.role === 'admin')) refuse(`Only an admin of ${state.name} can remove a teammate.`);
  if (member.key === state.founder) refuse(`${name} made ${state.name}, so they cannot be removed.`);
  const result = await peer.teamChange({ type: 'teamRemove', team: state.id, key: member.key });
  return { team: { id: state.id, name: state.name }, removed: { key: member.key, name: member.name }, message: `Removed ${name} from ${state.name}.${result?.told === false ? ' They and your other teammates hear it once the peer daemon can start.' : ''} A new invite brings them back.` };
}

// elu mine: the teammates' machines that are yours. A machine counts as yours once both
// machines say so; elu mine @NAME on each does that, and elu mine remove @NAME on either ends it.
const machineName = row => sanitize(row?.box || row?.name || row?.key?.slice(0, 8) || '', 40).replace(/[\s@]+/g, '');
function machineOf(me, word) {
  const value = String(word ?? '').replace(/^@/, '').toLowerCase(), status = peer.peerStatus();
  const members = new Map(status.teams.flatMap(state => state.members).filter(m => m.key !== me.key).map(m => [m.key, m]));
  const byBox = [...members.values()].filter(m => typeof m.box === 'string' && m.box.toLowerCase() === value);
  if (byBox.length === 1) return byBox[0];
  const member = teammate(me, word); return members.get(member.key) ?? member;
}
async function mineCommand(words) {
  const me = peer.identity(), rows = peer.mineRows(), status = peer.peerStatus(), members = new Map(status.teams.flatMap(state => state.members).map(m => [m.key, m]));
  if (words.length === 1) {
    const shown = rows.filter(row => row.mine || row.theirs).map(row => ({ ...row, name: machineName(members.get(row.key) ?? { key: row.key }) }));
    const line = row => `@${row.name}  ${row.mine && row.theirs ? 'yours' : row.mine ? `waiting for @${row.name} to mark this computer too` : `marks this computer as theirs; run elu mine @${row.name} to agree`}`;
    return { mine: shown, message: shown.some(row => row.mine && row.theirs) ? 'Your computers.' : 'No other computer is yours yet. Run elu mine @NAME here and on that computer.', lines: shown.map(line) };
  }
  const remove = words[1] === 'remove';
  if (words.length !== (remove ? 3 : 2)) refuse('Use elu mine [@NAME | remove @NAME].');
  const member = machineOf(me, remove ? words[2] : words[1]), name = machineName(member);
  if (remove) {
    await daemonCall({ type: 'unmine', key: member.key });
    return { mine: { key: member.key, mine: false }, message: `@${name} is no longer yours. Neither computer can start sessions on the other now.` };
  }
  const { both } = await daemonCall({ type: 'mine', key: member.key });
  const here = sanitize(status.box, 40).replace(/[\s@]+/g, '') || sanitize(me.name, 40).replace(/[\s@]+/g, '');
  return { mine: { key: member.key, mine: true, both }, message: both ? `@${name} is yours. Start a session on it with @${name} first in the new session box.` : `Waiting for @${name} to mark this computer too. On it, run elu mine @${here}.` };
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
    if (words[1] === 'remove') return removeCommand(words, flags);
    if (words[1]) refuse(`Unknown command: team ${words[1]}. Use elu team create NAME, elu team leave [TEAM] or elu team remove NAME [--team TEAM].`);
    const status = peer.peerStatus();
    return { teams: status.teams, message: status.teams.length ? `${status.teams.length} team${status.teams.length === 1 ? '' : 's'}.` : 'No team yet. Create one with elu team create NAME.', lines: memberLines(status) };
  }
  if (command === 'mine') return mineCommand(words);
  if (command === 'invite') {
    // --mine: a code for another computer of yours. It works for an hour unless --hours says otherwise.
    const me = peer.identity(), state = chooseTeam(me, flags.team, { admin: true }), hours = flags.hours === undefined ? flags.mine ? 1 : 24 : Number(flags.hours);
    const shared = teamShare(state.id, flags);
    if (shared.error) refuse(shared.error);
    // The first invite for a team sets what teammates can do here, from the flags or the
    // defaults. A team that already has other members (one joined before this setting) is
    // never turned to Auto without --auto: their messages keep waiting for you.
    if (!peer.teamAccess(state.id)) {
      const others = state.members.some(m => m.key !== me.key && !m.removed), update = accessUpdate(flags, { defaults: true });
      if (others && !flags.auto && !flags.manual) update.handling = 'manual';
      peer.saveTeamAccess(state.id, { ...update, ...(shared.row ? { root: shared.row.root } : {}) });
    }
    const code = await peer.createInvite(state.id, { hours, ...(flags.mine ? { mine: true } : {}) });
    if (flags.mine) return { invite: { code, team: state.id, hours, mine: true, fingerprint: me.fingerprint }, message: `Code for another computer of yours. It works once, within ${hours} h. Stay online until it joins.`, lines: [code, `On your other computer, run: elu join ${code} --mine`, 'The two computers then count each other as yours: each can start sessions on the other.',
      ...(state.members.some(m => m.key !== me.key && !m.removed) ? ['Is that computer already on this team? Then run elu mine @NAME here and on it instead.'] : [])] };
    return { invite: { code, team: state.id, hours, project: shared.row?.handle ?? null, fingerprint: me.fingerprint }, message: `Invite to ${state.name}. It works once, within ${hours} h.${askAbout(shared)} Stay online until they join.`,
      lines: [code, `Your teammate runs this in the project you can ask about: elu join ${code}`, ...accessLines(state, peer.teamAccess(state.id)).slice(1).map(line => line.trim()), 'Change it with elu access.'] };
  }
  if (command === 'join') {
    // A code pasted with spaces or line breaks in it, or with a second "elu join" in front, comes in several words.
    if (!words[1]) refuse('Use elu join CODE.');
    // Joining shares no project of the joiner's: elu share does that, whenever they want. What
    // teammates can do here is set as it joins: Auto with no rules unless the flags say
    // otherwise, in this folder. It is read before joining, so a bad flag joins nothing.
    const update = accessUpdate(flags, { defaults: true });
    const joined = await peer.joinTeam(words.slice(1).join(' ')), who = sanitize(joined.inviter?.name, 40);
    const access = peer.saveTeamAccess(joined.id, update);
    // A code made for another computer of the inviter's own marks nothing by itself: only
    // --mine here, the person at this machine saying both are theirs, does.
    const at = sanitize(who, 40).replace(/[\s@]+/g, '') || joined.inviter?.fingerprint || 'NAME';
    let mine = '';
    if (joined.mineOffer && flags.mine) { await daemonCall({ type: 'mine', key: joined.mineOffer.key }); mine = ` ${who ? `${who}'s computer` : 'That computer'} and this one are yours: each can start sessions on the other.`; }
    else if (joined.mineOffer) mine = ` ${who || 'They'} made this code for another computer of theirs. Nothing was marked as yours. If you set up both computers, run elu mine @${at}.`;
    else if (flags.mine) mine = ' This was a teammate\'s invite, so nothing was marked as yours.';
    return { team: { ...joined, project: null }, access, message: `Joined ${joined.name}${who ? ` with ${who}` : ''}. ${HANDLING[access.handling]}${mine}`, lines: accessLines({ name: joined.name }, access).slice(1) };
  }
  if (command === 'access') {
    if (words.length > 1) refuse('Use elu access [--team ID] [--auto|--manual] [--rules TEXT] [--project PATH].');
    const me = peer.identity(), state = chooseTeam(me, flags.team), update = accessUpdate(flags);
    const access = Object.keys(update).length ? peer.saveTeamAccess(state.id, update) : peer.teamAccess(state.id);
    return { team: { id: state.id, name: state.name }, access, message: Object.keys(update).length ? 'Saved what teammates can do here.' : 'What teammates can do here.', lines: accessLines(state, access) };
  }
  if (command === 'share') {
    if (words.length > 2) refuse('Use elu share [PATH] [--as HANDLE] [--no-status].');
    const row = peer.share(path.resolve(words[1] ?? process.cwd()), { handle: flags.as, status: !flags['no-status'] });
    return { share: row, message: `Shared ${row.root} with your teams as ${row.handle}. Questions that name no project go to it.` };
  }
  if (command === 'unshare') {
    if (words.length !== 2) refuse('Use elu unshare HANDLE.');
    const row = peer.unshare(words[1]);
    // Someone else's share of the same repository can still keep its Tasks on their team's board.
    let board = null; try { board = peer.taskBoardBy?.(row.root) ?? null; } catch { board = null; }
    return { share: row, message: `Stopped sharing ${row.handle}.${board ? ` Its Tasks are still on ${peer.boardWho(board)}. /share off in that project keeps them off.` : ''}` };
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
