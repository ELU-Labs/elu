import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomic, cleanPath, mkdir, noSymlinks, readJson, refuse, isObject } from '../util.mjs';
import { isInstalled, BY_HAND } from '../install.mjs';
import { processIdentity } from '../process.mjs';
import { peerDir, peerFile } from './paths.mjs';
import { sanitize } from './peerdata.mjs';
import * as ids from './identity.mjs';
import * as roster from './roster.mjs';
import * as invites from './invite.mjs';
import { TaskState } from './a2a.mjs';
import { records, thread } from './taskstore.mjs';
import { asks, drafts } from './asks.mjs';
import { cleanBots, cleanBox, overlaps, remoteStatus, thisMachine } from './status.mjs';
import { boardBy, planSharing, teammatePlans } from './plans.mjs';
import { projectOff, savedLocalRepos, savedProjectClones, teammateSessions as cardsIn } from './cards.mjs';
export { boardWho } from './plans.mjs';
import { MISSING } from './transport.mjs';
import { unitArgument, unitEnvironment } from '../unit-file.mjs';
import { attachPictures, countText, sizeText, unsentLine } from './pictures.mjs';
import { REMOTE_COMMANDS } from './remote.mjs';
import { collectFiles, namedPaths, offerLine, pathsInText, stageFiles as stageCollected } from './files.mjs';
// Sessions on your other computers, and which machines are yours: files only, as everything here.
export { remoteSessions, remoteMachines, mineRows } from './remote.mjs';
// What GitHub pairing last found ({state, login}), and the line /mine adds while it cannot work.
export { githubStatus, pairingHint } from './github.mjs';
// The repository a project's folder belongs to (its origin remote), or null: Sessions shows the
// sessions of my other computers in projects of the same repository.
export function projectRepoId(root) { return shareStore.repoId(root); }

// The facade the TUI and CLI use. It reads files only
// and never loads hyperswarm or hyperdht; the daemon does the networking.
export { shares, unshare, teamProjects } from './shares.mjs';
import * as shareStore from './shares.mjs';
// Sharing a project makes it the project the chosen teams (by default all of yours) ask
// about when a question names none.
export function share(root, { teams: chosen, ...options } = {}) {
  const me = ids.loadIdentity(), mine = me ? roster.teams().filter(state => state.members.some(m => m.key === me.key && !m.removed)).map(state => state.id) : [];
  const teamIds = chosen ?? mine;
  // The share is kept with the teams it is for: only their members can ask about it.
  const row = shareStore.share(root, { ...options, teams: teamIds, mine });
  for (const id of teamIds) shareStore.setTeamProject(id, row.handle);
  // Shared with status on, it is on the team board again if it was kept off.
  if (row.status && shareStore.boardOff(row.root)) shareStore.setBoardOff(row.root, false);
  return row;
}
// The teams a project was joined through: the teams founded by someone else that have it
// as their project on this machine, while I am an active member of them. None for a
// project of my own. A project that a team I founded has as its project too is my own:
// a share is not kept per team, so it could not end for one team and stay for another.
export function joinedTeams(root) {
  const me = ids.loadIdentity(), row = me ? shareStore.shares().find(share => share.root === root) : null;
  if (!row) return [];
  const projects = shareStore.teamProjects();
  const using = roster.teams().filter(state => projects[state.id] === row.handle && state.members.some(member => member.key === me.key && !member.removed));
  return using.some(state => state.founder === me.key) ? [] : using.map(state => ({ id: state.id, name: state.name }));
}
// Leaving a joined project ends its share, so this machine no longer answers teammates
// about it. The team memberships stay. Returns the teams it was joined through.
export function leaveProject(root) {
  const teams = joinedTeams(root);
  if (!teams.length) refuse('This project was not joined through a team.');
  shareStore.unshare(shareStore.shares().find(share => share.root === root).handle);
  return teams;
}
export { peerSettings, savePeerSettings, peerPolicy, savePeerPolicy, peerBox } from './settings.mjs';
// What teammates can do here, per team (access.mjs). The daemon reads it with each message.
export { teamAccess, saveTeamAccess, accessRows, checkRules, checkRoot, DEFAULT_ACCESS, RULES_MAX } from './access.mjs';
import { forgetTeamAccess } from './access.mjs';
export { registeredProjects } from '../projects.mjs';
import { peerPolicy, savePeerSettings } from './settings.mjs';
const FRESH_MS = 15000;
function readState() { try { const file = peerFile('state.json'); noSymlinks(file); return fs.existsSync(file) ? readJson(file) : null; } catch { return null; } }
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
function live(now) {
  const state = readState(), at = typeof state?.at === 'number' ? state.at : Date.parse(state?.at);
  return state && state.running && !state.stopped && now - at < FRESH_MS && Number.isInteger(state.pid) && alive(state.pid) ? state : null;
}
// A daemon keeps the code it started with. One started by another copy, or before an update
// replaced this one's files, says another version in state.json (0.1.3 and earlier say none),
// and is restarted before it is asked to invite or join: it would not know the code.
// Read from package.json each time, since this is the copy a restart would start.
const thisVersion = () => { try { return readJson(fileURLToPath(new URL('../../package.json', import.meta.url))).version; } catch { return null; } };
const stale = state => Boolean(state) && state.version !== thisVersion();
export const STALE = 'The peer daemon of another version of ELU Code did not stop. Wait a moment, then try again.';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// The daemon runs while this machine is on a team: an active member of at least one, read
// from the rosters. An open invite is always for one of those teams. A machine that never
// made or joined a team is on none, so nothing starts and nothing connects.
export function onTeam() {
  try { const me = ids.loadIdentity(); return Boolean(me) && roster.teams().some(t => t.members.some(m => m.key === me.key && !m.removed)); } catch { return false; }
}
// A leave from a team that no teammate has heard yet (roster.mjs): the daemon keeps running
// for it on no team, until one of them has.
export function leaveUnheard() {
  try { const me = ids.loadIdentity(); return Boolean(me) && roster.unheardLeaves(me.key).length > 0; } catch { return false; }
}
// A command the daemon has not read yet, other than a shutdown: a join, say, which a daemon
// started for it handles before this machine is on any team.
function queued() {
  const folder = peerFile('commands');
  try { noSymlinks(folder); if (!fs.existsSync(folder)) return false; } catch { return false; }
  return fs.readdirSync(folder).some(name => { if (!name.endsWith('.json') || name.endsWith('.result.json')) return false; try { return readJson(path.join(folder, name))?.type !== 'shutdown'; } catch { return false; } });
}
// Whether a daemon starting now has anything to do. A login service started on a machine on
// no team, with no leave to deliver, exits at once, before it connects to anything.
export const peerWanted = () => onTeam() || leaveUnheard() || queued();
// 0.1.5 and earlier had peer mode on and off, and their daemon honours a shutdown only while
// the saved setting says off. It is written for them alone; this version never reads it.
const forOlderDaemons = () => { try { savePeerSettings({ enabled: false }); } catch { /* A newer daemon stops anyway. */ } };
// Stops a stale daemon and, while this machine is on a team or has a leave to deliver,
// starts this copy's. True when one was started.
export async function restartStale({ waitMs = 10000 } = {}) {
  if (!stale(live(Date.now()))) return false;
  forOlderDaemons(); sendPeerCommand({ type: 'shutdown' });
  for (const until = Date.now() + waitMs; Date.now() < until && (live(Date.now()) || lockHeld());) await pause(200);
  if (live(Date.now()) || lockHeld()) refuse(STALE);
  if (!onTeam() && !leaveUnheard()) return false;
  spawnDaemon(); return true;
}

// Each member's machine: its box name and the bots its owner shares. Mine are read here;
// a teammate's are what the daemon last heard, which stay in state.json after it stops. A
// teammate on a build from before bots, or never heard from, has no box name and no bots.
function machines(me) {
  const saved = readState(), heard = new Map(), mine = thisMachine();
  if (me && saved?.key === me.key) for (const t of Array.isArray(saved.teams) ? saved.teams : []) for (const m of Array.isArray(t?.members) ? t.members : []) if (typeof m?.key === 'string') heard.set(m.key, { box: cleanBox(m.box), bots: cleanBots(m.bots) });
  return { mine, of: key => key === me?.key ? mine : heard.get(key) ?? { box: null, bots: [] } };
}
export function peerStatus(now = Date.now()) {
  const state = live(now), me = (() => { try { return ids.loadIdentity(); } catch { return null; } })(), machine = machines(me);
  const offline = () => roster.teams().filter(t => me && t.members.some(m => m.key === me.key && !m.removed)).map(t => ({ id: t.id, name: t.name, founder: t.founder, role: t.members.find(m => m.key === me.key)?.role ?? 'member',
    members: t.members.filter(m => !m.removed).map(m => ({ key: m.key, fingerprint: m.key.slice(0, 8), name: sanitize(m.name, 64), role: m.role, online: false, path: null, lastSeen: null })),
    channels: t.channels.filter(row => row.members.includes(me.key)).map(row => ({ id: row.id, name: row.name, members: row.members })) }));
  return {
    running: Boolean(state), stale: stale(state), pid: state?.pid ?? null, key: me?.key ?? null, fingerprint: me?.fingerprint ?? null, name: me?.name ?? null, box: machine.mine.box, error: state?.error ?? null,
    teams: (state?.teams ?? offline()).map(t => ({ ...t, members: (t.members ?? []).map(m => ({ ...m, ...machine.of(m.key) })) })), counters: state?.counters ?? { direct: 0, relayed: 0, failed: 0 },
  };
}
const nameOf = key => sanitize(roster.teams().flatMap(t => t.members).find(m => m.key === key)?.name ?? key.slice(0, 8), 64);
const short = text => sanitize(text, 400);
const team = record => record.team ? { team: true } : {};
// Whether I trust a teammate, read once per key per listing; the TUI shows a
// trusted sender's text without secret masking. Trust is about display and paths only.
function trustLookup() {
  const seen = new Map();
  return key => { if (typeof key !== 'string' || !key) return false; if (!seen.has(key)) seen.set(key, peerPolicy(key).trusted === true); return seen.get(key); };
}
// Questions I answered stay in Chats for a week.
const RECENT_MS = 7 * 24 * 3600 * 1000;
// A thread as chat messages, oldest first: {from: 'me' | 'peer' | 'note', peer, name, kind, text, at, trusted}.
// A team ask sent to several teammates is one message; a held reply shows until it is sent.
export function threadMessages(threadId) {
  const lines = thread(threadId), out = [], trusted = trustLookup(), mine = new Map(), theirs = new Map();
  // A message that came or went with pictures names them under its text.
  for (const ask of asks()) if (ask.threadId === threadId && ask.pictures) mine.set(ask.text, sentPictures(ask).pictures);
  for (const record of records()) if (record.threadId === threadId && record.pictures?.length) theirs.set(record.text, gotPictures(record).pictures);
  lines.forEach((line, index) => {
    const text = sanitize(line.text, 160000), base = { peer: line.peer ?? null, name: line.peer ? nameOf(line.peer) : null, kind: line.kind, at: line.at, trusted: trusted(line.peer) };
    if (line.dir === 'local') { if (!lines.slice(index + 1).some(next => next.dir !== 'local')) out.push({ ...base, from: 'me', held: true, blocked: line.kind === 'blocked', text }); return; }
    if (line.kind === 'rejected') { out.push({ ...base, from: 'note', text: line.dir === 'out' ? text === 'discarded' ? 'You did not send a reply.' : 'You declined.' : 'Declined.' }); return; }
    const from = line.dir === 'out' ? 'me' : 'peer', last = out.at(-1);
    const pictures = ['ask', 'handoff'].includes(line.kind) ? (from === 'me' ? mine : theirs).get(line.text) : null;
    const body = pictures ? `${text}\n${pictures.unsent ? `Pictures not sent: ${pictures.text}\n${pictures.unsent}` : `Pictures: ${pictures.text}`}` : text;
    if (from === 'me' && last?.from === 'me' && !last.held && last.kind === line.kind && last.text === body) return;
    out.push({ ...base, from, text: body, ...(pictures ? { pictures } : {}) });
  });
  return out;
}
// The pictures of a message for a row and a thread: {list: [{name, size}], count: '2 pictures',
// size: '1.5 MB' (all of them), text: 'a.png (1.2 MB), b.png (340 KB)'}, and on one I sent,
// unsent: why they did not go.
function pictureRows(list) {
  const rows = (Array.isArray(list) ? list : []).slice(0, 8).map(row => ({ name: sanitize(row?.name, 120), size: Number.isFinite(row?.size) ? row.size : 0 }));
  return { list: rows, count: countText(rows.length), size: sizeText(rows.reduce((sum, row) => sum + row.size, 0)), text: rows.map(row => `${row.name} (${sizeText(row.size)})`).join(', ') };
}
const sentPictures = ask => { const unsent = ask.pictures ? unsentLine(ask.pictures, ask.name) : null; return ask.pictures?.list?.length ? { pictures: { ...pictureRows(ask.pictures.list), ...(unsent ? { unsent } : {}) } } : {}; };
const gotPictures = record => record.pictures?.length ? { pictures: pictureRows(record.pictures) } : {};
// A message from the message box with the pictures it names copied for the daemon
// (pictures.mjs). Only these three commands carry pictures, and only through here: the
// command line, a model's draft and the local A2A endpoint never attach a file. A message
// over a limit is refused with one line before anything is sent.
export function withPictures(command) {
  if (!isObject(command) || !['ask', 'handoff', 'teamAsk'].includes(command.type) || typeof command.text !== 'string') return command;
  const { text, pictures } = attachPictures(command.text);
  return pictures ? { ...command, text, pictures } : command;
}
// Files from this computer for a session on another computer of mine (files.mjs). A message
// typed to that session that names files or folders here offers to send them with it:
// { entries, count, bytes, keys, line }, or { entries, refused } when they are over a limit or
// cannot be read, or null when it names none. /send names them one by one (offerPaths). The
// owner may send anything he can read: both computers are his. stageFiles copies them for the
// daemon once he said yes, and returns what the remoteFiles command takes.
export function offerFiles(text) {
  const entries = pathsInText(text);
  if (!entries.length) return null;
  try { const found = collectFiles(entries); return { entries, count: found.files.length, bytes: found.bytes, keys: found.keys, line: offerLine(found) }; }
  catch (error) { return { entries, refused: error.message }; }
}
export function offerPaths(list) {
  const entries = namedPaths(list), found = collectFiles(entries);
  return { entries, count: found.files.length, bytes: found.bytes, keys: found.keys, line: offerLine(found, { message: false }) };
}
export const stageFiles = offer => stageCollected(collectFiles(offer.entries));
// Peer items for the board and the Team view, newest first. Each carries trusted
// for the teammate it is with, request (the wire kind) for a message I received, and
// bot when the question is for a shared bot: theirs on one I sent, mine on one I received.
export function peerItems() {
  const items = [], trusted = trustLookup();
  for (const record of records()) {
    const state = record.task.status.state, base = { peer: record.peer, name: sanitize(record.name ?? nameOf(record.peer), 64), project: record.project, threadId: record.threadId, root: record.root, requestId: record.requestId, taskId: record.task.id, state, request: record.kind, trusted: trusted(record.peer), ...(record.room ? { room: record.room } : {}), ...(record.bot ? { bot: record.bot } : {}), ...gotPictures(record) };
    if (state === TaskState.SUBMITTED && record.waiting) items.push({ id: `incoming:${record.task.id}`, kind: 'incoming', text: short(record.text), at: record.createdAt, ...(record.team ? { team: true } : {}), ...base });
    else if (state === TaskState.WORKING && record.reply && !record.reply.discarded) items.push({ id: `held:${record.task.id}`, kind: 'held', text: short(record.reply.text), question: short(record.text), at: record.reply.at, blocked: record.reply.blocked, pathsCut: record.reply.pathsCut === true, problems: record.reply.problems.map(p => p.kind), ...base });
    // A message I took stays in its thread, a handoff I work on too: my agent
    // on it, my reply, or a run that failed.
    else if ([TaskState.SUBMITTED, TaskState.WORKING].includes(state) && !record.waiting) items.push({ id: `answering:${record.task.id}`, kind: 'answering', text: short(record.text), at: record.createdAt, ...team(record), ...base });
    else if (Date.now() - Date.parse(record.createdAt) > RECENT_MS) continue;
    else if (state === TaskState.COMPLETED && record.reply?.sentAt) items.push({ id: `replied:${record.task.id}`, kind: 'replied', text: short(record.reply.text), question: short(record.text), at: record.reply.sentAt, pathsCut: record.reply.pathsCut === true, ...team(record), ...base });
    else if (state === TaskState.FAILED) items.push({ id: `failed:${record.task.id}`, kind: 'failed', text: short(record.text), at: record.task.status.timestamp ?? record.createdAt, ...team(record), ...base });
    else if (state === TaskState.REJECTED) items.push({ id: `declined:${record.task.id}`, kind: 'declined', text: short(record.text), at: record.task.status.timestamp ?? record.createdAt, ...team(record), ...base });
  }
  for (const draft of drafts().filter(row => row.state === 'draft')) {
    items.push({ id: `draft:${draft.id}`, kind: 'draft', peer: null, name: sanitize(draft.to, 64), project: draft.project ?? null, text: short(draft.question), at: draft.createdAt, state: 'draft', threadId: draft.threadId ?? null, root: draft.root ?? null, taskId: draft.taskId ?? null, trusted: false });
  }
  const pushAsk = ask => {
    const base = { peer: ask.to, name: sanitize(ask.name, 64), project: ask.project, at: ask.createdAt, state: ask.state, threadId: ask.threadId, root: ask.root ?? undefined, taskId: ask.chatTaskId ?? undefined, trusted: trusted(ask.to), ...(ask.pathsCut ? { pathsCut: true } : {}), ...(ask.room ? { room: ask.room } : {}), ...(ask.bot ? { bot: ask.bot } : {}), ...sentPictures(ask) };
    if (['pending', 'submitted', 'working', 'held'].includes(ask.state)) items.push({ id: `asked:${ask.id}`, kind: 'asked', text: short(ask.text), ...base });
    else if (ask.state === 'answered' && !ask.continued) items.push({ id: `answer:${ask.id}`, kind: 'answer', text: short(ask.answer?.text), question: short(ask.text), ...base, at: ask.answer?.at ?? ask.createdAt });
    else if (ask.state === 'expired') items.push({ id: `expired:${ask.id}`, kind: 'expired', text: short(ask.text), ...base });
    else if (['rejected', 'failed'].includes(ask.state)) items.push({ id: `rejected:${ask.id}`, kind: 'rejected', text: short(ask.reason ?? ask.text), question: short(ask.text), ...base });
  };
  const groups = new Map();
  for (const ask of asks().filter(row => !row.dismissed)) {
    if (ask.group) groups.set(ask.group, [...(groups.get(ask.group) ?? []), ask]); else pushAsk(ask);
  }
  // A team ask is one thread until a teammate takes it, then that teammate's.
  for (const [group, rows] of groups) {
    const taken = rows.filter(row => ['working', 'held', 'answered'].includes(row.state));
    if (taken.length) { taken.forEach(pushAsk); continue; }
    const first = rows[0], open = rows.filter(row => ['pending', 'submitted'].includes(row.state));
    const base = { id: `team:${group}`, peer: null, name: 'team', team: true, ...(first.room ? { room: first.room } : {}), project: first.project, at: first.createdAt, threadId: first.threadId, root: first.root ?? undefined, taskId: first.chatTaskId ?? undefined, trusted: false, ...sentPictures(first) };
    if (open.length) items.push({ ...base, kind: 'asked', text: short(first.text), state: open.some(row => row.state === 'submitted') ? 'submitted' : 'pending' });
    else if (rows.every(row => row.state === 'expired')) items.push({ ...base, kind: 'expired', text: short(first.text), state: 'expired' });
    else items.push({ ...base, kind: 'rejected', text: short(rows.map(row => row.reason).find(Boolean) ?? first.text), question: short(first.text), state: 'rejected' });
  }
  return items.sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0));
}
// Teammates' Tasks for one of this machine's projects, and whether its own are told (plans.mjs).
export const teammateTasks = (root, now = Date.now()) => teammatePlans(root, now);
// Teammates' sessions in the repositories of one of this machine's projects (cards.mjs):
// { repos: [{repoId, name, at}], people: [{ peer, name, box, online, heardAt, sessions }] }.
export const teammateSessions = (root, now = Date.now()) => cardsIn(root, now);
// The clones a project's folder holds, as the daemon last found them (cards.mjs).
export const projectClones = root => savedProjectClones(root);
// The repositories a project's Kanban boards are for, as the daemon last found them (cards.mjs):
// the clones its folder holds and those its recent sessions work in, by repository id.
export const projectRepoIds = root => [...new Set([...savedLocalRepos().values()].filter(row => row.roots.includes(root)).map(row => row.repoId))];
// Whether a project is kept off the team board (/share off, or a share from here with status off).
export const boardKeptOff = root => projectOff(root);
export const taskSharing = root => planSharing(root);
// For a project whose Tasks reach a board through someone else's share: { team, by }, else null.
export const taskBoardBy = root => boardBy(root);
// /share off keeps a project's Tasks off the team board, though a teammate shares the same
// repository; /share on puts it back. A project shared from here has its status switched too.
export function taskBoard(root, on) {
  if (typeof on !== 'boolean') refuse('Say on or off.');
  return shareStore.setBoardOff(root, !on);
}
export function teamAgents(now = Date.now()) {
  const state = live(now), status = peerStatus(now), mine = Array.isArray(state?.rows) ? state.rows : [], seen = new Map();
  for (const t of status.teams) for (const m of t.members) if (m.key !== status.key && !seen.has(m.key)) seen.set(m.key, m);
  // A teammate's saved rows are shown only while they are connected; they resend on connect.
  return [...seen.values()].map(m => ({ peer: m.key, name: m.name, online: m.online, rows: m.online ? overlaps(mine, remoteStatus(m.key)?.rows ?? []) : [] }));
}

const TYPES = ['ask', 'teamAsk', 'channelSet', 'teamLeave', 'teamRemove', 'review', 'handoff', 'approve', 'discard', 'accept', 'work', 'continue', 'mute', 'unmute', 'trust', 'untrust', 'join', 'mineAuto', 'shutdown', ...REMOTE_COMMANDS];
export function sendPeerCommand(command) {
  if (!isObject(command) || !TYPES.includes(command.type)) refuse('Unknown peer command.');
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  atomic(peerFile('commands', `${id}.json`), { ...command, at: new Date().toISOString() });
  return { id };
}
export async function awaitCommand(id, timeoutMs = 30000) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id ?? '')) refuse('Unknown command.');
  const file = peerFile('commands', `${id}.result.json`), until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    noSymlinks(file);
    if (fs.existsSync(file)) { const result = readJson(file); fs.rmSync(file, { force: true }); if (!result.ok) refuse(result.error); return result.result; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  refuse('The peer daemon did not answer. Check elu peers.');
}

export function identity({ create = false, name } = {}) {
  if (create) return ids.createIdentity({ name });
  if (name !== undefined) return ids.renameIdentity(name);
  return ids.identity();
}
export const exportIdentity = () => ids.exportIdentity();
export const importIdentity = (code, options) => ids.importIdentity(code, options);
export const createTeam = name => roster.createTeam(ids.identity(), name);
// Leaving a team and removing a teammate, written to the log here, for when the daemon cannot
// start (no networking packages). The daemon tells teammates when it next connects to them: a
// leave is noted as unheard, so the daemon runs for it once it can. Otherwise the app and CLI
// send the teamLeave and teamRemove commands, so they are told at once.
export function leaveTeam(teamId) {
  const { op, team: state } = roster.leaveOp(ids.identity(), teamId); shareStore.forgetTeam(teamId); forgetTeamAccess(teamId);
  roster.noteUnheard(teamId, op.id);
  return { team: state.id, name: state.name };
}
export function removeMember(teamId, key) {
  const { team: state, member } = roster.removeOp(ids.identity(), teamId, key);
  return { team: state.id, name: state.name, key: member.key, member: sanitize(member.name, 64) };
}
// For the CLI and the app. This machine is on the team, so the daemon is started for it when
// it is not running (a stale one is restarted), and the teammates online now are told at once.
// told is false when no teammate took a leave (the daemon keeps running until one does), and
// for any change written here because the daemon could not start (daemon is false then).
// Once this machine is on no team with nothing left to tell, the daemon stops: stopping is
// true then.
export async function teamChange(command) {
  if (!isObject(command) || !['teamLeave', 'teamRemove'].includes(command.type)) refuse('Unknown team change.');
  let up = false;
  try { await ensurePeer(); up = true; } catch (error) { if (error.message === STALE) throw error; }
  if (up) return { told: true, ...await awaitCommand(sendPeerCommand(command).id, 30000), daemon: true };
  const done = command.type === 'teamLeave' ? leaveTeam(command.team) : removeMember(command.team, command.key);
  return { ...done, told: false, daemon: false, stopping: !onTeam() && !leaveUnheard() && stopPeer() };
}
// The daemon runs from here on: started, or a stale one restarted, and waited for, so the
// one running announces the code's topic and whoever reports the invite sees it running.
export async function createInvite(teamId, options) {
  await ensurePeer();
  return invites.createInvite(ids.identity(), teamId, options);
}
// Through the daemon. With none running, one is started for the join and keeps running
// once this machine is on the team; when the join fails it stops by itself.
export async function joinTeam(code, { timeoutMs = 60000 } = {}) {
  invites.parseInvite(code);
  if (!networkInstalled()) refuse(MISSING);
  ids.identity();
  const restarted = await restartStale(), { id } = sendPeerCommand({ type: 'join', code });
  if (!restarted && !live(Date.now()) && !lockHeld()) { dropShutdowns(); spawnDaemon(); }
  return awaitCommand(id, timeoutMs + 25000);
}

const BIN = fileURLToPath(new URL('../../bin/elu-code.mjs', import.meta.url));
const daemonArgs = (bin = BIN) => [process.execPath, bin, 'peer', '--daemon'];
// Starts the daemon detached, the same way startConductor does, while this machine is on a
// team or has a leave no teammate has heard; it keeps running when the app closes, so teammates can reach this machine. A daemon
// of another version is restarted. True when one was started. Resolving, not importing,
// keeps the networking packages out of the TUI process.
const networkInstalled = () => { try { import.meta.resolve('hyperswarm'); import.meta.resolve('hyperdht'); return true; } catch { return false; } };
export async function startPeer() {
  if (!networkInstalled()) refuse(MISSING);
  ids.identity();
  if (await restartStale()) return true;
  if (!onTeam() && !leaveUnheard()) return false;
  dropShutdowns();
  if (live(Date.now()) || lockHeld()) return false;
  spawnDaemon(); return true;
}
// startPeer, then waits for the daemon's first heartbeat, so a start failure shows here and
// not only in the log.
export async function ensurePeer({ waitMs = 20000 } = {}) {
  const started = await startPeer();
  for (const until = Date.now() + waitMs; Date.now() < until && !live(Date.now());) await pause(200);
  if (!live(Date.now())) refuse(onTeam() || leaveUnheard() ? `The peer daemon did not start. See ${peerFile('daemon.log')}.` : 'No team yet. Create one with elu team create NAME, or join one with elu join CODE.');
  return started;
}
function spawnDaemon(bin = BIN) {
  mkdir(peerDir());
  const log = peerFile('daemon.log'); noSymlinks(log);
  if (fs.existsSync(log) && fs.statSync(log).size > 1024 * 1024) fs.truncateSync(log, 0);
  const out = fs.openSync(log, 'a', 0o600);
  try { const [node, ...args] = daemonArgs(bin); spawn(node, args, { cwd: os.homedir(), env: process.env, detached: true, stdio: ['ignore', out, out] }).unref(); }
  finally { fs.closeSync(out); }
}
// A stop a moment ago may have left a shutdown the daemon has not read yet.
function dropShutdowns() {
  const folder = peerFile('commands');
  try { noSymlinks(folder); if (!fs.existsSync(folder)) return; } catch { return; }
  for (const name of fs.readdirSync(folder).filter(name => name.endsWith('.json') && !name.endsWith('.result.json'))) {
    try { const file = path.join(folder, name); if (readJson(file)?.type === 'shutdown') fs.rmSync(file, { force: true }); } catch { /* Read by the daemon already. */ }
  }
}
function lockHeld() {
  try { const file = peerFile('peer.lock'); noSymlinks(file); if (!fs.existsSync(file)) return false; const record = readJson(file); return Boolean(record.identity) && processIdentity(record.pid) === record.identity; } catch { return false; }
}
// Stops the daemon, for elu uninstall and elu peer uninstall. It starts again when the app
// opens, or an elu peer command runs, on a machine that is still on a team. True when one was
// running.
export function stopPeer() {
  const state = live(Date.now());
  if (!state && !lockHeld()) return false;
  if (stale(state)) forOlderDaemons();
  sendPeerCommand({ type: 'shutdown' }); return true;
}

// For elu update: stops the running daemon and, once it has exited, starts the one in bin, the
// copy just installed, while this machine is on a team or has a leave to deliver. It waits:
// a daemon still running ignores a second one, and startPeer drops a shutdown the daemon has
// not read yet, so a start right after a stop would leave the old code running.
// Returns 'restarted', 'stopped' (nothing to run now), 'none' (none was running) or 'stuck'.
export async function restartPeer({ bin = BIN, waitMs = 20000 } = {}) {
  const state = live(Date.now());
  if (!state && !lockHeld()) return 'none';
  forOlderDaemons(); sendPeerCommand({ type: 'shutdown' });
  for (const until = Date.now() + waitMs; Date.now() < until && (live(Date.now()) || lockHeld());) await pause(200);
  if (live(Date.now()) || lockHeld()) return 'stuck';
  if (!onTeam() && !leaveUnheard()) return 'stopped';
  dropShutdowns(); spawnDaemon(bin); return 'restarted';
}

// Login service. run(bin, args) loads or unloads it; tests pass their own and never load.
const LABEL = 'dev.elu-code.peer';
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const runDefault = (bin, args) => { const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 15000 }); if (r.status !== 0) refuse(`${bin} could not load the service.`); };
export function servicePath({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  if (platform === 'linux') return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', 'elu-code-peer.service');
  refuse('Starting at login works on macOS and Linux only.');
}
export function installService({ platform = process.platform, home = os.homedir(), env = process.env, run = runDefault, lasting = isInstalled({ env, home }) } = {}) {
  const file = servicePath({ platform, home, env }), args = daemonArgs();
  // A login service names this copy's files, so it is written only by the installed command.
  // A copy a package runner fetched (npx and the like) sits in a cache that gets cleared.
  if (!lasting) refuse(`Install ELU Code first, then start it at login: ${BY_HAND}`);
  const keep = Object.fromEntries(['PATH', 'XDG_CONFIG_HOME', 'HOME'].filter(name => env[name]).map(name => [name, name === 'PATH' ? cleanPath(env[name]) : env[name]]));
  if (platform === 'darwin') {
    const log = peerFile('daemon.log');
    atomic(file, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${LABEL}</string>\n  <key>ProgramArguments</key>\n  <array>\n${args.map(arg => `    <string>${xml(arg)}</string>`).join('\n')}\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(keep).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}\n  </dict>\n  <key>RunAtLoad</key><true/>\n  <key>StandardOutPath</key><string>${xml(log)}</string>\n  <key>StandardErrorPath</key><string>${xml(log)}</string>\n</dict>\n</plist>\n`);
    run('launchctl', ['bootstrap', `gui/${process.getuid()}`, file]);
  } else {
    atomic(file, `[Unit]\nDescription=ELU Code peer network\n\n[Service]\nExecStart=${args.map(unitArgument).join(' ')}\n${Object.entries(keep).map(([k, v]) => unitEnvironment(k, v)).join('\n')}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`);
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', 'elu-code-peer.service']);
  }
  return { file };
}
export function uninstallService({ platform = process.platform, home = os.homedir(), env = process.env, run = runDefault } = {}) {
  const file = servicePath({ platform, home, env });
  noSymlinks(file); if (!fs.existsSync(file)) return { file, removed: false };
  try {
    if (platform === 'darwin') run('launchctl', ['bootout', `gui/${process.getuid()}`, file]);
    else run('systemctl', ['--user', 'disable', '--now', 'elu-code-peer.service']);
  } catch { /* It may not be loaded; the file still goes. */ }
  fs.rmSync(file, { force: true }); return { file, removed: true };
}
