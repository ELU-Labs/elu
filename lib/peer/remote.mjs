import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EluCodeError, atomic, hash, isObject, mkdir, noSymlinks, readJson, refuse } from '../util.mjs';
import { readTask, taskTitle, tasks } from '../state.mjs';
import { enqueue, sendCommand } from '../conductor.mjs';
import { pendingRequests, removeRequest } from '../workspace.mjs';
import { activity, conversationEntries, projectSnapshot, registeredProjects, savedProjectName, taskDetails } from '../projects.mjs';
import { listSchedules } from '../schedules.mjs';
import { repoId } from './shares.mjs';
import { clonesIn } from './cards.mjs';
import { folderRemote, ownFolder, sessionFolders, withNewestOwned } from '../kanban-repos.mjs';
import { pendingApprovals, answerApproval } from '../approvals.mjs';
import { keepOffer, keepRule, usesSavedRules } from '../permission-rules.mjs';
import { approveTask, currentTask, readMinutes, rejectTask, sessionTasks, sharedTask, waitingTask } from '../plan.mjs';
import { CHAT_BOTS_MAX, BOT_NAME, getBot, sessionBots } from '../bots.mjs';
import { checkMode, checkPlace } from '../modes.mjs';
import { checkModel } from '../models.mjs';
import { peerFile } from './paths.mjs';
import { sanitize } from './peerdata.mjs';
import { teams } from './roster.mjs';
import { teamAccess } from './access.mjs';
import { PAIRED_BY_GITHUB, bothMine, markMine, markedMine, mineRows, noteTheirs, ownNames, pairedByGithub, pairedMine, unmarkMine } from './mine.mjs';
import { takeMineOffer } from './invite.mjs';
import { records, updateRecord } from './taskstore.mjs';
import { isTerminal } from './a2a.mjs';
import { addFolder } from '../runner.mjs';
import { PIECE, checkInbox, dropOutgoingFiles, filesLine, landFiles, landedText, pieces, stagedFiles, takePiece } from './files.mjs';
import { hostStandup, hostStandupRead, hostStandupStop } from './standup.mjs';
import { lastActivity, readBoard } from '../kanban.mjs';
import { standupOpen } from '../standup.mjs';

// Sessions on your other computer (docs/peer-network.md, "Your other computers"). One of
// your machines (the viewer, a laptop say) starts a session on another of yours (the host,
// a devbox), which runs it as its own owner's session and sends back what happens in it as
// numbered events. The viewer folds them into one file per session and the app draws that.
// Everything here is taken only from, and sent only to, a key both machines marked as mine.
export const UPDATE = name => `${name} needs to update ELU Code to run sessions from here.`;
// A computer of mine on a build that cannot list its sessions yet.
export const UPDATE_LIST = name => `Update ELU Code on ${name} to see its sessions here.`;
export const NOT_MINE = 'Only your own computers can do this. Mark each other with /mine on both of them.';
// A computer of mine on a build that cannot take files yet.
export const FILES_UPDATE = name => `${name} needs to update ELU Code to receive files.`;
// Files go only to the owner's own sessions there, never to a teammate's.
export const NOT_OWN_SESSION = "That session is a teammate's. Files from your other computers go only to your own sessions.";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TEXT_MAX = 16000, ENTRY_MAX = 16000, STEP_MAX = 400, PATCH_MAX = 60000, BATCH_BYTES = 400 * 1024;
// How much the host keeps of each session's events, and how much a viewer keeps of its chat.
const EVENTS_KEPT = 4000, ENTRIES_KEPT = 200, STEPS_KEPT = 60, SEEN_KEPT = 600;
const PUSH_MS = 1500, DIFF_MS = 10000, KEPT_MS = 7 * 24 * 3600000, VIEWS_MAX = 200;

const hostFile = (id, ext = 'json') => peerFile('remote', 'host', `${id}.${ext}`);
const viewFile = id => peerFile('remote', 'view', `${id}.json`);
const readRow = file => { try { noSymlinks(file); if (!fs.existsSync(file)) return null; const value = readJson(file); return isObject(value) ? value : null; } catch { return null; } };
const list = (folder, named = ID) => { try { noSymlinks(folder); if (!fs.existsSync(folder)) return []; return fs.readdirSync(folder).filter(name => name.endsWith('.json') && named.test(name.slice(0, -5))).map(name => name.slice(0, -5)); } catch { return []; } };
const firstLine = value => String(value ?? '').split('\n').find(line => line.trim())?.trim() ?? '';
const short = (value, max) => sanitize(value, max);

// The name a machine goes by in lines on the other side: its box name, else its owner's name.
const called = (ctx, key) => `@${String(ctx.box?.(key) || ctx.name?.(key) || key.slice(0, 8)).replace(/[\s@]+/g, '')}`;
const myTeams = me => teams().filter(state => state.members.some(m => m.key === me && !m.removed)).map(state => state.id);
function needMine(ctx, session) { if (!session?.admitted || !bothMine(ctx.me.key, session.key)) refuse(NOT_MINE); }

// ---- Host: the machine the session runs on ----

const hosted = () => list(peerFile('remote', 'host')).map(id => readRow(hostFile(id))).filter(row => row && row.id && HEX64.test(row.machine ?? ''));
const saveHosted = row => { mkdir(peerFile('remote', 'host')); atomic(hostFile(row.id), row); };
function hostedFor(session, id) {
  if (!ID.test(id ?? '')) refuse('Choose a session.');
  const row = readRow(hostFile(id));
  // Another machine's session reads as no session at all.
  if (!row || row.machine !== session.key) refuse('That session is not on this computer.');
  return row;
}
// The project sessions from my other computers run in: the project this machine chose for a
// team it shares with that computer (/access, or the folder /join ran in), when it is a
// registered project. The first such team, in roster order, decides. With none, they run
// where my own sessions here run: the one registered project, or of several the one with
// the newest session. The home folder counts too, since these are my own sessions; the
// rule that keeps the home folder out is for teammates' sessions.
function projectFor(me, key) {
  const repos = registeredProjects();
  for (const state of teams()) {
    if (![me, key].every(k => state.members.some(m => m.key === k && !m.removed))) continue;
    const root = teamAccess(state.id)?.root;
    const repo = root && repos.find(row => row.root === root);
    if (repo) return repo;
  }
  if (repos.length === 1) return repos[0];
  if (repos.length) return repos.map(repo => ({ repo, at: newestSession(repo) })).reduce((best, row) => row.at > best.at ? row : best).repo;
  refuse('Open ELU Code once on this computer so it has a project.');
}
const when = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : 0; };
function newestSession(repo) {
  try { return Math.max(0, ...tasks(repo).map(task => Math.max(when(task.createdAt), when(task.activeSince)))); } catch { return 0; }
}
const projectName = root => savedProjectName(root) ?? path.basename(root);
const repoOf = root => registeredProjects().find(row => row.root === root) ?? null;
// The session's task id, once the conductor started its first message.
function taskOf(row) {
  if (row.taskId) return { taskId: row.taskId, request: null };
  let request = null; try { request = pendingRequests(row.root).find(value => value.id === row.requestId) ?? null; } catch { /* Read again next tick. */ }
  if (request?.taskId) return { taskId: request.taskId, request };
  // The conductor lets a finished request go after a while: the session's own record says which it was.
  if (!request) { try { const repo = repoOf(row.root), found = repo && tasks(repo).find(task => task.origin?.mine === true && task.origin.remoteId === row.id); if (found) return { taskId: found.id, request: null }; } catch { /* Read again next tick. */ } }
  return { taskId: null, request };
}
function appendEvents(row, events) {
  if (!events.length) return [];
  const file = hostFile(row.id, 'jsonl'), at = new Date().toISOString(), out = events.map(event => ({ seq: ++row.seq, at, ...event }));
  mkdir(peerFile('remote', 'host')); noSymlinks(file);
  fs.appendFileSync(file, out.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
  // A long session keeps its newest events; a viewer that was away longer catches up from the oldest kept.
  if (row.seq - (row.first ?? 1) > EVENTS_KEPT * 1.5) {
    const kept = readEvents(row).slice(-EVENTS_KEPT); atomic(file, ''); fs.writeFileSync(file, kept.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
    row.first = kept[0]?.seq ?? row.seq + 1;
  }
  return out;
}
function readEvents(row) {
  const file = hostFile(row.id, 'jsonl');
  try { noSymlinks(file); if (!fs.existsSync(file)) return []; } catch { return []; }
  return fs.readFileSync(file, 'utf8').split('\n').flatMap(line => { try { const value = JSON.parse(line); return isObject(value) && Number.isSafeInteger(value.seq) ? [value] : []; } catch { return []; } });
}
// What the viewer shows about the session now: its state and the parts that are compared
// with what was sent before. Entries and steps are sent once each, by a key of their own.
function hostView(row, now, previous) {
  const repo = repoOf(row.root);
  if (!repo) return { state: { state: 'gone', error: 'The project is no longer open on that computer.' } };
  const { taskId, request } = taskOf(row);
  if (taskId && !row.taskId) row.taskId = String(taskId);
  if (!taskId) {
    const waiting = request && ['blocked'].includes(request.state);
    return { state: { state: request ? waiting ? 'blocked' : 'starting' : 'stopped', error: waiting ? short(request.reason, 400) : null, title: short(firstLine(row.text), 80) } };
  }
  const task = readTask(repo, taskId), plan = currentTask(repo, taskId);
  const reply = task.state === 'needs_input' ? task.reply?.outcome === 'needs_input' ? task.reply : task.result : null;
  const state = { state: task.state, title: short(taskTitle(task), 80), mode: task.permissions ?? null, place: task.place?.kind ?? 'worktree', bots: sessionBots(task), activeRole: task.activeRole ?? null,
    error: task.error?.message ? short(task.error.message, 400) : null, question: reply?.question ? short(reply.question, 2000) : null, choices: Array.isArray(reply?.choices) ? reply.choices.slice(0, 8).map(choice => short(choice, 200)) : [] };
  const entries = conversationEntries(repo, task).map(entry => ({ role: short(entry.role, 80), at: entry.at ?? null, text: short(entry.text, ENTRY_MAX), ...(entry.lead ? { lead: true } : {}), ...(entry.bot ? { bot: short(entry.bot, 30) } : {}), ...(entry.failed ? { failed: true } : {}), ...(entry.quiet ? { quiet: true } : {}), ...(entry.shell ? { shell: true } : {}) }));
  // A review of a bot is part of what the session shows: its summary and what it found.
  for (const review of task.reviews ?? []) {
    const who = String(review.role ?? '').startsWith('bot:') ? review.role.slice(4) : null, result = review.result ?? {};
    const comments = (result.comments ?? []).slice(0, 20).map(comment => `${comment.severity ?? 'note'}: ${comment.body ?? ''}`);
    if (who && (result.summary || comments.length)) entries.push({ role: `@${who} · review ${review.round ?? ''}`.trim(), at: review.at ?? null, text: short([result.summary ?? '', ...comments].filter(Boolean).join('\n'), ENTRY_MAX), bot: who });
  }
  const steps = activity(repo, [task], 80).filter(item => String(item.taskId) === String(task.id)).map(item => ({ at: item.at ?? null, text: short(item.text, STEP_MAX) }));
  // always: the rule a would keep on this computer, in words, where a is offered (lib/permission-rules.mjs).
  const approvals = (() => { try { return pendingApprovals({ taskId: String(task.id) }).filter(item => !item.root || item.root === row.root).map(item => { const kept = keepOffer(item, task.origin)?.summary; return { id: item.id, role: item.role ?? 'lead', summary: short(item.summary, 200), at: item.at, ...(kept ? { always: short(kept, 200) } : {}) }; }); } catch { return []; } })();
  const shared = plan ? sharedTask(plan) : null;
  // The diff is read again at most every DIFF_MS while the session works, and once when it stops.
  const mark = `${task.state}:${task.runs?.length ?? 0}:${task.activeRole ?? ''}`;
  let diff = previous?.diff ?? null;
  if (task.kind !== 'conversation' && (mark !== row.diffMark || (task.state === 'running' && now - (row.diffAt ?? 0) > DIFF_MS))) {
    try { const text = taskDetails(repo, task.id).diff ?? ''; diff = { summary: diffSummary(text), patch: text.slice(0, PATCH_MAX) + (text.length > PATCH_MAX ? '\n[The rest of the diff is on the other computer.]' : '') }; }
    catch { diff = previous?.diff ?? null; }
    row.diffAt = now; row.diffMark = mark;
  }
  return { state, entries, steps, approvals, plan: shared, diff };
}
function diffSummary(text) {
  const files = new Set(), lines = String(text).split('\n');
  let added = 0, removed = 0;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) files.add(line);
    else if (line.startsWith('New file: ')) files.add(line);
    else if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return files.size ? `${files.size} file${files.size === 1 ? '' : 's'} · +${added} −${removed}` : 'No changes';
}
const keyOf = value => hash(JSON.stringify(value)).slice(0, 24);
// The events that tell what changed since the last look.
function diffView(row, view) {
  const seen = row.seen ??= {}, events = [];
  const digest = value => keyOf(value ?? null);
  if (digest(view.state) !== seen.state) { seen.state = digest(view.state); events.push({ type: 'state', ...view.state }); }
  for (const [kind, items] of [['entry', view.entries ?? []], ['step', view.steps ?? []]]) {
    const field = kind === 'entry' ? 'entries' : 'steps', known = new Set(seen[field] ?? []);
    for (const item of items) { const key = keyOf(item); if (known.has(key)) continue; known.add(key); events.push({ type: kind, ...item }); }
    seen[field] = [...known].slice(-SEEN_KEPT);
  }
  if (view.approvals && digest(view.approvals) !== seen.approvals) { seen.approvals = digest(view.approvals); events.push({ type: 'approvals', list: view.approvals }); }
  if (view.entries && digest(view.plan) !== seen.plan) { seen.plan = digest(view.plan); events.push({ type: 'plan', plan: view.plan }); }
  if (view.diff && digest(view.diff) !== seen.diff) { seen.diff = digest(view.diff); events.push({ type: 'diff', ...view.diff }); }
  return events;
}
// Each tick: every session hosted here is looked at, what changed becomes events, and the
// computer that started it gets them at once when it is connected. One that is not catches
// up when it next connects (elu.remote.since).
const views = new Map(), looked = new Map();
// A session quiet for 10 minutes is looked at every 30 s; a message to it wakes it at once (wake).
const QUIET_MS = 600000, QUIET_LOOK_MS = 30000;
export const wake = id => looked.delete(id);
// A message I handed off to this computer from another of mine, and worked on here as my own
// session, is followed from there like a session started there: its approvals, its question
// and its chat show where I am, and are answered from there. Each such session gets a hosted
// row once, while its message is in progress.
function adoptHandoffs(ctx, now) {
  for (const record of records()) {
    if (record.kind !== 'handoff' || record.remoteId || record.waiting || !record.root || !record.requestId || isTerminal(record.task.status.state)) continue;
    if (!bothMine(ctx.me.key, record.peer)) continue;
    const id = crypto.randomUUID(), at = new Date(now).toISOString();
    const kept = updateRecord(record.task.id, current => current.remoteId ? null : { ...current, remoteId: id });
    if (!kept) continue;
    saveHosted({ id, machine: record.peer, root: record.root, requestId: record.requestId, taskId: record.localTaskId ? String(record.localTaskId) : null, text: short(record.text, 400), createdAt: at, updatedAt: at, seq: 0, first: 1, seen: {}, handoff: true });
  }
}
export function hostTick(ctx, now = Date.now()) {
  try { adoptHandoffs(ctx, now); } catch (error) { ctx.log?.(`remote handoffs: ${error.message}`); }
  const out = new Map();
  for (const row of hosted()) {
    if (now - Date.parse(row.updatedAt ?? row.createdAt) > KEPT_MS) { for (const ext of ['json', 'jsonl']) fs.rmSync(hostFile(row.id, ext), { force: true }); views.delete(row.id); looked.delete(row.id); continue; }
    if (now - Date.parse(row.updatedAt ?? row.createdAt) > QUIET_MS && now - (looked.get(row.id) ?? 0) < QUIET_LOOK_MS) continue;
    looked.set(row.id, now);
    let view; try { view = hostView(row, now, views.get(row.id)); } catch (error) { ctx.log?.(`remote ${row.id.slice(0, 8)}: ${error.message}`); continue; }
    views.set(row.id, view);
    const before = JSON.stringify([row.seq, row.seen, row.taskId, row.diffAt]), events = appendEvents(row, diffView(row, view));
    if (events.length) row.updatedAt = new Date(now).toISOString();
    if (JSON.stringify([row.seq, row.seen, row.taskId, row.diffAt]) !== before) saveHosted(row);
    if (events.length) out.set(row.machine, [...out.get(row.machine) ?? [], { id: row.id, events }]);
  }
  for (const [key, items] of out) {
    const session = ctx.session(key);
    if (!session || !bothMine(ctx.me.key, key) || session.remoteHello?.remote !== 1) continue;
    for (const part of batches(items)) session.notify('elu.remote.events', { items: part });
  }
}
// Notifications stay well under the frame limit: a batch that would pass BATCH_BYTES is cut,
// and the viewer asks for the rest by seq.
function batches(items) {
  const out = []; let part = [], size = 0;
  for (const item of items) {
    const events = [];
    for (const event of item.events) { const length = JSON.stringify(event).length; if (size + length > BATCH_BYTES) break; events.push(event); size += length; }
    if (events.length) part.push({ id: item.id, events });
    if (events.length < item.events.length) break;
  }
  if (part.length) out.push(part);
  return out;
}
function checkStart(params) {
  if (!isObject(params) || !ID.test(params.id ?? '')) refuse('A session needs an id.');
  if (typeof params.text !== 'string' || !params.text.trim() || params.text.length > TEXT_MAX) refuse(`Write the message in 1 to ${TEXT_MAX} characters.`);
  const permissions = checkMode(params.permissions), place = checkPlace(params.place ?? null, { mode: permissions });
  const model = params.model == null ? null : checkModel(params.model);
  if (!Array.isArray(params.bots ?? []) || (params.bots ?? []).length > CHAT_BOTS_MAX || (params.bots ?? []).some(name => typeof name !== 'string' || !BOT_NAME.test(name))) refuse('Bots are a list of up to five names.');
  // The helpers are this computer's bots of those names. One it does not have is said plainly.
  for (const name of params.bots ?? []) if (!getBot(name)) refuse(`@${name} is not a bot on this computer. Make it there, or start without it.`);
  return { id: params.id, text: params.text.trim(), permissions, place, model, bots: [...new Set(params.bots ?? [])] };
}
// ---- Host: every session here, for my other computers ----
// A computer of mine sees every session on this one, whoever started it: the owner by hand,
// a schedule, a bot, a teammate's message, or another computer of mine. It lists them
// (elu.remote.list) and watches one (elu.remote.watch). A watched session is read,
// continued, stopped and answered as one started from there (elu.remote.since and the rest).
const REF = /^[0-9a-f]{16}:[1-9][0-9]{0,9}$/, PROJECT = /^[0-9a-f]{16}$/;
const projectKey = root => hash(`project\0${root}`).slice(0, 16);
// The id both machines give a watched session: from the viewer's key, the host's key and the session.
export function watchId(viewer, host, ref) {
  const h = hash(`watch\0${viewer}\0${host}\0${ref}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const LIST_PAGE = 100, LIST_CACHE_MS = 2000, GONE_KEPT_MS = 600000, REPO_MS = 60000, SINCE_BOOT = Date.now();
const time = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : 0; };
const repoIds = new Map();
function repoIdOf(root, now) {
  const known = repoIds.get(root);
  if (known && now - known.at < REPO_MS) return known.id;
  let id = null; try { id = repoId(root); } catch { id = null; }
  repoIds.set(root, { id, at: now }); return id;
}
// When each session last changed, as this daemon saw it, and the ones that left: a viewer's
// since cursor reads only those.
const changed = new Map(), left = new Map();
let listed = null;
// own(peer): whether peer is a computer of the owner's (both sides marked it, lib/peer/mine.mjs).
// adopted: the hosted rows of handoffs from those computers (adoptHandoffs), by computer, root and task.
function summary(root, project, task, approvals, timed, own = () => false, adopted = new Map()) {
  // A standup it answered (lib/standup.mjs) is not activity here either.
  const last = Math.max(time(task.activeSince), lastActivity(task));
  const asked = ['running', 'preparing'].includes(task.state) ? approvals.filter(item => String(item.taskId) === String(task.id) && (!item.root || item.root === root)) : [];
  const reply = task.state === 'needs_input' ? task.reply?.outcome === 'needs_input' ? task.reply : task.result : null, origin = task.origin;
  // A message from another computer of the owner's started a session of his own, as one that
  // computer started directly: it lists as mine. Asked on every list, so one started before the
  // two were paired lists as mine once they are. Its mode and rules stay what they were. Only
  // the owner's own kind of session (own, as usesSavedRules has it): one he took on there in a
  // mode he picked (w) is worked on as a teammate's, and its files are refused, so it stays one.
  const handed = origin?.mine !== true && origin?.own === true && origin.kind === 'handoff' && HEX64.test(origin.peer ?? '') && own(origin.peer);
  const by = origin?.mine === true || handed ? 'mine' : origin ? 'teammate' : task.botChat ? 'bot' : timed.some(row => row.root === root && String(row.lastTaskId) === String(task.id)) ? 'schedule' : 'you';
  return { ref: `${project}:${task.id}`, project, title: short(taskTitle(task), 80), state: task.state, at: new Date(last || Date.now()).toISOString(), createdAt: typeof task.createdAt === 'string' ? task.createdAt : null,
    question: reply?.question ? short(firstLine(reply.question), 200) : null, error: task.error?.message ? short(task.error.message, 200) : null, plan: task.plan?.state === 'proposed' ? { state: 'proposed', title: short(task.plan.title, 80) } : null,
    approvals: asked.slice(0, 10).map(item => { const kept = keepOffer(item, origin)?.summary; return { id: item.id, role: item.role ?? 'lead', summary: short(item.summary, 200), at: item.at, ...(kept ? { always: short(kept, 200) } : {}) }; }), by, who: by === 'teammate' ? short(origin.name, 40) : by === 'bot' ? short(task.botChat, 30) : null,
    ...(origin?.mine === true ? { from: origin.machine, remoteId: origin.remoteId } : handed ? { from: origin.peer, remoteId: adopted.get(`${origin.peer}\0${root}\0${task.id}`) } : {}) };
}
// Every session on this computer, newest first, read at most every 2 s.
function hostSessions(now = Date.now()) {
  if (listed && now - listed.at < LIST_CACHE_MS && now >= listed.at) return listed;
  let approvals = [], timed = [];
  try { approvals = pendingApprovals(); } catch { /* None can be read. */ }
  try { timed = listSchedules(); } catch { /* None can be read. */ }
  const projects = [], sessions = [];
  const owners = new Map(), own = key => owners.get(key) ?? owners.set(key, pairedMine(key)).get(key);
  // A handoff that computer follows already has an id there (adoptHandoffs): sent with it, so it is one session there.
  const adopted = new Map(hosted().filter(row => row.handoff && row.taskId).map(row => [`${row.machine}\0${row.root}\0${row.taskId}`, row.id]));
  for (const repo of registeredProjects()) {
    let snap; try { snap = projectSnapshot(repo); } catch { continue; }
    const id = projectKey(repo.root);
    projects.push({ id, name: short(snap.name, 60), repoId: repoIdOf(repo.root, now), home: path.resolve(repo.root) === path.resolve(os.homedir()) });
    // A teammate's question is answered in its Chats thread there, not as a session; an archived one is out of Sessions there.
    const kept = [];
    // standup: false marks one a standup would not ask here (lib/standup.mjs), so the asker leaves it out.
    let board = null; try { board = readBoard(repo); } catch { board = null; }
    for (const task of snap.tasks) {
      if (['ask', 'review'].includes(task.origin?.kind) || snap.closed?.includes(task.id)) continue;
      // Only what a viewer shows: what works or waits now, and what changed in the last week. One older leaves the list (gone).
      const row = summary(repo.root, id, task, approvals, timed, own, adopted);
      if (['starting', 'preparing', 'running', 'needs_input'].includes(row.state) || row.plan || row.approvals.length || now - time(row.at) < KEPT_MS) kept.push([task, row]);
    }
    // The repository each works in, as the Kanban puts it on a board (lib/kanban-repos.mjs), so
    // a viewer shows it under a project of its own that holds that repository. Read from caches
    // kept a minute, as the daemon's boards read them; the clones a project folder holds (kept
    // ten minutes) are looked for only when a session has no repository of its own. The main
    // repository such a session goes with is picked from every session of the project, archived
    // and older ones too, as the Kanban picks it.
    let folders = new Map();
    try {
      const tasks = kept.map(([task]) => task), loose = tasks.some(task => !ownFolder(repo, task, now)), clones = loose ? clonesIn(repo, now) : [];
      folders = sessionFolders(repo, clones.length > 1 ? withNewestOwned(repo, tasks, snap.tasks, now) : tasks, { clones, now });
    } catch { folders = new Map(); }
    for (const [task, row] of kept) { let found = null; try { found = folderRemote(folders.get(task.id) ?? null, now)?.repoId ?? null; } catch { found = null; } sessions.push({ ...row, repoId: found, ...(board && !standupOpen(board, task, now) ? { standup: false } : {}) }); }
  }
  sessions.sort((a, b) => b.at.localeCompare(a.at) || a.ref.localeCompare(b.ref));
  const seen = new Set();
  for (const row of sessions) { seen.add(row.ref); const digest = keyOf(row); if (changed.get(row.ref)?.digest !== digest) { changed.set(row.ref, { digest, at: now }); left.delete(row.ref); } }
  for (const ref of [...changed.keys()]) if (!seen.has(ref)) { changed.delete(ref); left.set(ref, now); }
  for (const [ref, at] of left) if (now - at > GONE_KEPT_MS) left.delete(ref);
  listed = { at: now, projects, sessions };
  return listed;
}
// The next list is read from the files again (tests, and a session this daemon just changed).
export const relist = () => { listed = null; };
// What a viewer is sent of one: the origin of a session started from it, and from no other machine.
const wireRow = (row, key) => { const { from, remoteId, ...rest } = row; return from === key ? { ...rest, remoteId } : rest; };
const later = (row, after) => row.at < after.at || (row.at === after.at && row.ref > after.ref);
// A message for a hosted session, as typed here: @name first writes to that bot of this computer.
function deliver(ctx, row, taskId, text) {
  const match = /^@([A-Za-z][A-Za-z0-9-]{0,29})(?:\s+([\s\S]*))?$/.exec(text.trim()), bot = match && getBot(match[1].toLowerCase());
  if (bot && !(match[2] ?? '').trim()) refuse(`Write your message after @${bot.name}.`);
  wake(row.id); enqueue(row.root, bot ? match[2].trim() : text.trim(), { continuationTaskId: String(taskId), priority: 0, ...(bot ? { bot: bot.name } : {}) }); ctx.kick?.(); ctx.soon?.();
}
// Sends whose files are in, by sender and send, for a last piece sent again.
const landed = new Map(), LANDED_MS = 10 * 60000;
export function hostMethods(ctx) {
  return {
    // Every session here, a page at a time. since: the cursor of an earlier answer, for only
    // what changed after it; one from before this daemon started, or older than it remembers
    // what left, lists everything again (full).
    'elu.remote.list': (params, session) => {
      needMine(ctx, session);
      const p = isObject(params) ? params : {}, limit = Number.isSafeInteger(p.limit) && p.limit > 0 ? Math.min(p.limit, LIST_PAGE) : LIST_PAGE;
      const { at, projects, sessions } = hostSessions();
      let since = Number.isSafeInteger(p.since) && p.since >= 0 ? p.since : null;
      const full = since === null || since < SINCE_BOOT || at - since > GONE_KEPT_MS;
      if (full) since = null;
      let rows = full ? sessions : sessions.filter(row => (changed.get(row.ref)?.at ?? 0) > since);
      const after = typeof p.after === 'string' && /^[^|]{1,40}\|[0-9a-f]{16}:[0-9]{1,10}$/.test(p.after) ? { at: p.after.split('|')[0], ref: p.after.split('|')[1] } : null;
      if (after) rows = rows.filter(row => later(row, after));
      const page = rows.slice(0, limit);
      // mineByPeer: each row's by was decided from the key its message came from, so the viewer
      // reads none of them as its own by name (cleanListed).
      return { full, cursor: at, projects, sessions: page.map(row => wireRow(row, session.key)), gone: full ? [] : [...left].filter(([, when]) => when > since).map(([ref]) => ref).slice(0, 1000),
        next: rows.length > limit ? `${page.at(-1).at}|${page.at(-1).ref}` : null, mineByPeer: true };
    },
    // Watch one of them: from now on it sends its events as a session started from there does.
    'elu.remote.watch': (params, session) => {
      needMine(ctx, session);
      if (!isObject(params) || !REF.test(params.ref ?? '')) refuse('Choose a session.');
      const [project, taskId] = params.ref.split(':'), repo = registeredProjects().find(row => projectKey(row.root) === project);
      let task = null; try { task = repo ? readTask(repo, taskId) : null; } catch { task = null; }
      if (!task || ['ask', 'review'].includes(task.origin?.kind)) refuse('That session is not on this computer.');
      const id = watchId(session.key, ctx.me.key, params.ref), existing = readRow(hostFile(id)), now = new Date().toISOString();
      if (existing && existing.machine !== session.key) refuse('That session id is taken.');
      // Watched again, it is kept another week from now.
      saveHosted(existing ? { ...existing, updatedAt: now } : { id, machine: session.key, root: repo.root, requestId: null, taskId: String(task.id), ref: params.ref, watched: true, text: short(task.goal, 400), createdAt: now, updatedAt: now, seq: 0, first: 1, seen: {} });
      wake(id); ctx.soon?.();
      return { id, project: projectName(repo.root), title: short(taskTitle(task), 80) };
    },
    // A session from my other computer, in the project of the team we share, as if typed here.
    'elu.remote.start': (params, session) => {
      needMine(ctx, session);
      const wanted = checkStart(params), existing = readRow(hostFile(wanted.id));
      if (existing) { if (existing.machine !== session.key) refuse('That session id is taken.'); return { id: existing.id, project: projectName(existing.root) }; }
      const repo = projectFor(ctx.me.key, session.key);
      const request = enqueue(repo.root, wanted.text, { priority: 0, permissions: wanted.permissions, place: wanted.place, folders: [], bots: wanted.bots, ...(wanted.model ? { model: wanted.model } : {}), mine: { machine: session.key, name: short(ctx.name?.(session.key) ?? session.key.slice(0, 8), 64).replace(/["<>\t\n]/g, '').trim() || session.key.slice(0, 8), remoteId: wanted.id } });
      const now = new Date().toISOString();
      saveHosted({ id: wanted.id, machine: session.key, root: repo.root, requestId: request.id, taskId: null, text: short(wanted.text, 400), createdAt: now, updatedAt: now, seq: 0, first: 1, seen: {} });
      ctx.event?.(`${called(ctx, session.key)} started a session here`); ctx.kick?.(); ctx.soon?.();
      return { id: wanted.id, project: projectName(repo.root) };
    },
    // A message typed into it there continues it here, as a message typed here would.
    'elu.remote.send': (params, session) => {
      needMine(ctx, session);
      const row = hostedFor(session, params?.id);
      if (typeof params.text !== 'string' || !params.text.trim() || params.text.length > TEXT_MAX) refuse(`Write the message in 1 to ${TEXT_MAX} characters.`);
      const { taskId } = taskOf(row);
      if (!taskId) refuse('This session has not started yet. Send this once it has.');
      deliver(ctx, row, taskId, params.text);
      return { id: row.id };
    },
    // Files from my other computer for this session, in pieces, with the message they go with
    // on the last piece. They land in the session's inbox, which the session may read in every
    // mode, and the message continues the session as one typed here, each path it named
    // pointing where that file or folder landed. Only a session of the owner's own takes them:
    // a teammate's, such as a handoff accepted here, answers in that teammate's thread, so
    // what it reads would reach him (usesSavedRules says whose it is).
    'elu.remote.files': (params, session) => {
      needMine(ctx, session);
      const row = hostedFor(session, params?.id);
      if (params.last === true && (typeof params.text !== 'string' || params.text.length > TEXT_MAX)) refuse(`Write the message in up to ${TEXT_MAX} characters.`);
      const known = landed.get(`${session.key}:${params.send}`);
      // The last piece sent again, its answer lost: the files are in already.
      if (known && params.last === true) return known;
      const { taskId } = taskOf(row), repo = repoOf(row.root);
      if (!taskId || !repo) refuse('This session has not started yet. Send the files once it has.');
      let task = null; try { task = readTask(repo, taskId); } catch { task = null; }
      if (!task || !usesSavedRules(task.origin)) refuse(NOT_OWN_SESSION);
      // Where they would land is checked before the first piece is taken, and again once all are in.
      if (params.seq === 0) checkInbox();
      const piece = takePiece(session.key, params);
      if (!piece.done) return { ok: true };
      let root; try { root = checkInbox(); } catch (error) { fs.rmSync(piece.file, { force: true }); throw error; }
      const from = called(ctx, session.key), inbox = path.join(root, `${projectKey(row.root)}-${taskId}`);
      let dir = path.join(inbox, `${new Date().toISOString().replace(/[:.]/g, '-')}-${from.slice(1).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 32) || 'computer'}`);
      for (let n = 2; fs.existsSync(dir); n++) dir = dir.replace(/(-\d+)?$/, `-${n}`);
      // The session may read its inbox from its next turn on, in every mode, as a folder added with /permissions folders.
      try { mkdir(inbox); addFolder(repo, taskId, inbox); }
      catch (error) { fs.rmSync(piece.file, { force: true }); refuse(`The files could not be given to this session: ${error.message}`); }
      const got = landFiles(piece.file, piece.size, dir);
      const text = [landedText(params.text, got.items, dir).trim(), filesLine(from, got.count, got.bytes, dir)].filter(Boolean).join('\n\n');
      deliver(ctx, row, taskId, text);
      ctx.event?.(`${from} sent ${got.count === 1 ? '1 file' : `${got.count} files`} to a session here`);
      const result = { id: row.id, files: got.count, bytes: got.bytes, dir };
      landed.set(`${session.key}:${params.send}`, result); setTimeout(() => landed.delete(`${session.key}:${params.send}`), LANDED_MS).unref?.();
      return result;
    },
    'elu.remote.stop': (params, session) => {
      needMine(ctx, session);
      const row = hostedFor(session, params?.id), { taskId, request } = taskOf(row);
      if (!taskId) { if (request && ['queued', 'blocked', 'waiting'].includes(request.state)) removeRequest(row.root, request.id); ctx.soon?.(); return { stopping: Boolean(request) }; }
      const repo = repoOf(row.root), task = repo ? readTask(repo, taskId) : null;
      if (!task || !['running', 'preparing'].includes(task.state)) refuse('That session is not running.');
      wake(row.id); sendCommand({ type: 'stop', root: row.root, taskId: String(taskId) }); ctx.kick?.();
      return { stopping: true };
    },
    // An action the session waits on there. The first answer wins, here or there.
    // always ('project' or 'all'): a was pressed there. The rule is kept on this computer,
    // where the session runs and its relay reads the rules, made here from the request itself.
    'elu.remote.answer': (params, session) => {
      needMine(ctx, session);
      const row = hostedFor(session, params?.id), { taskId } = taskOf(row);
      if (!['allow', 'deny'].includes(params.decision)) refuse('Answer allow or deny.');
      if (params.always != null && (!['project', 'all'].includes(params.always) || params.decision !== 'allow')) refuse('Keep the rule for this project or all your projects.');
      if (typeof params.approval !== 'string' || !taskId) refuse('That approval was already answered.');
      const waiting = pendingApprovals({ taskId: String(taskId) }).find(item => item.id === params.approval && (!item.root || item.root === row.root));
      if (!waiting) return { answered: false };
      wake(row.id);
      if (params.always) {
        const repo = repoOf(row.root), task = repo ? readTask(repo, taskId) : null;
        const sessionOf = item => { try { const at = repoOf(item.root); return at && item.taskId ? readTask(at, item.taskId) : null; } catch { return null; } };
        const kept = keepRule(waiting, task?.origin, params.always, { sessionOf }); ctx.soon?.();
        return { answered: kept.answered, kept: kept.summary };
      }
      const answered = answerApproval(waiting.id, params.decision); ctx.soon?.();
      return { answered };
    },
    // The session's Task: approved, its work starts; rejected, nothing changes.
    'elu.remote.task': (params, session) => {
      needMine(ctx, session);
      const row = hostedFor(session, params?.id), { taskId } = taskOf(row), repo = repoOf(row.root);
      if (!['approve', 'reject'].includes(params.decision)) refuse('Approve or reject the Task.');
      if (!taskId || !repo) refuse('No Task waits for your approval in this session.');
      const task = readTask(repo, taskId);
      if (['running', 'preparing'].includes(task.state)) refuse('This session is working. Answer its Task when it stops.');
      if (!waitingTask(sessionTasks(repo, taskId))) return { answered: false };
      wake(row.id); if (params.decision === 'reject') { rejectTask(repo, taskId); ctx.soon?.(); return { answered: true }; }
      const plan = approveTask(repo, taskId);
      wake(row.id); enqueue(row.root, `Approved the Task: ${plan.title}`, { continuationTaskId: String(taskId), priority: 0, approved: true }); ctx.kick?.(); ctx.soon?.();
      return { answered: true };
    },
    // A standup of my other computer (lib/peer/standup.mjs): the sessions here it names are
    // asked, each in its own read-only answer turn; their answers are read back, or waiting stops.
    'elu.remote.standup': (params, session) => { needMine(ctx, session); return hostStandup(params, session.key, { projectKey, kick: () => { ctx.kick?.(); ctx.soon?.(); } }); },
    'elu.remote.standupRead': (params, session) => { needMine(ctx, session); return hostStandupRead(params, session.key); },
    'elu.remote.standupStop': (params, session) => { needMine(ctx, session); return hostStandupStop(params, session.key); },
    // Catch-up: the events after a seq, as many as fit; more says there are others.
    'elu.remote.since': (params, session) => {
      needMine(ctx, session);
      const row = hostedFor(session, params?.id), after = Number.isSafeInteger(params.after) && params.after >= 0 ? params.after : 0;
      const events = readEvents(row).filter(event => event.seq > after), [part] = batches([{ id: row.id, events }]);
      const sent = part?.[0]?.events ?? [];
      return { id: row.id, events: sent, more: sent.length < events.length, last: row.seq, first: row.first ?? 1 };
    },
  };
}

// ---- Viewer: the machine the owner started the session from ----

const viewed = () => list(peerFile('remote', 'view')).map(id => readRow(viewFile(id))).filter(row => row && ID.test(row.id ?? '') && HEX64.test(row.machine ?? ''));
const saveView = row => { mkdir(peerFile('remote', 'view')); atomic(viewFile(row.id), row); };
const cleanEntry = event => ({ role: short(event.role, 80), at: typeof event.at === 'string' ? event.at : null, text: short(event.text, ENTRY_MAX), ...(event.lead === true ? { lead: true } : {}), ...(typeof event.bot === 'string' && BOT_NAME.test(event.bot) ? { bot: event.bot } : {}), ...(event.failed === true ? { failed: true } : {}), ...(event.quiet === true ? { quiet: true } : {}), ...(event.shell === true ? { shell: true } : {}) });
const STATES = ['starting', 'preparing', 'running', 'needs_input', 'answered', 'ready', 'unverified', 'blocked', 'stopped', 'gone'];
// One event folded into the session as the viewer keeps it. Every field is checked: the
// other side is my own computer, but what it sends is a model's output.
function apply(row, event) {
  switch (event.type) {
    case 'state':
      Object.assign(row, { state: STATES.includes(event.state) ? event.state : 'stopped', title: short(event.title ?? row.title, 80), mode: ['ask', 'auto', 'full'].includes(event.mode) ? event.mode : null, place: ['worktree', 'branch', 'here'].includes(event.place) ? event.place : 'worktree',
        bots: Array.isArray(event.bots) ? event.bots.filter(name => typeof name === 'string' && BOT_NAME.test(name)).slice(0, CHAT_BOTS_MAX) : [], activeRole: typeof event.activeRole === 'string' ? short(event.activeRole, 40) : null,
        error: event.error ? short(event.error, 400) : null, question: event.question ? short(event.question, 2000) : null, choices: Array.isArray(event.choices) ? event.choices.slice(0, 8).map(choice => short(choice, 200)) : [] });
      break;
    case 'entry': row.entries = [...row.entries ?? [], cleanEntry(event)].slice(-ENTRIES_KEPT); break;
    case 'step': row.steps = [...row.steps ?? [], { at: typeof event.at === 'string' ? event.at : null, text: short(event.text, STEP_MAX) }].slice(-STEPS_KEPT); break;
    case 'approvals': row.approvals = (Array.isArray(event.list) ? event.list : []).slice(0, 10).filter(item => isObject(item) && /^[A-Za-z0-9_-]{1,160}$/.test(item.id ?? '')).map(item => ({ id: item.id, role: short(item.role ?? 'lead', 40), summary: short(item.summary, 200), at: typeof item.at === 'string' ? item.at : null, ...(typeof item.always === 'string' && item.always.trim() ? { always: short(item.always, 200) } : {}) })); break;
    case 'plan': row.plan = isObject(event.plan) ? cleanPlan(event.plan) : null; break;
    case 'diff': row.diff = { summary: short(event.summary, 80), patch: short(event.patch, PATCH_MAX + 100) }; break;
    default: break;
  }
}
function cleanPlan(plan) {
  const words = (value, max) => short(value ?? '', max);
  return { title: words(plan.title, 80), description: words(plan.description, 2000), goal: words(plan.goal, 500), objectives: (Array.isArray(plan.objectives) ? plan.objectives : []).slice(0, 8).map(text => words(text, 300)),
    priority: words(plan.priority, 10), severity: words(plan.severity, 10), state: ['proposed', 'approved', 'rejected', 'done'].includes(plan.state) ? plan.state : 'proposed',
    subtasks: (Array.isArray(plan.subtasks) ? plan.subtasks : []).slice(0, 30).map(step => ({ text: words(step?.text, 200), state: ['todo', 'doing', 'done'].includes(step?.state) ? step.state : 'todo' })),
    met: (Array.isArray(plan.met) ? plan.met : []).filter(Number.isInteger).slice(0, 8), proposedAt: stamp(plan.proposedAt), rejectedAt: stamp(plan.rejectedAt),
    // From a build before success criteria and estimates: none, read as not set.
    approvedAt: stamp(plan.approvedAt), doneAt: stamp(plan.doneAt), criteria: (Array.isArray(plan.criteria) ? plan.criteria : []).slice(0, 8).map(text => words(text, 200)).filter(Boolean),
    estimateMinutes: readMinutes(plan.estimateMinutes), etaMinutes: readMinutes(plan.etaMinutes, { zero: true }), etaAt: stamp(plan.etaAt) };
}
const stamp = value => typeof value === 'string' && value.length <= 40 ? value : null;
// Events in seq order. A gap means some were missed: the rest waits for a catch-up.
function take(row, events, { first = null } = {}) {
  let changed = false;
  if (Number.isSafeInteger(first) && first > row.seq + 1) { row.seq = first - 1; changed = true; }
  for (const event of [...events].filter(isObject).sort((a, b) => a.seq - b.seq)) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= row.seq) continue;
    if (event.seq !== row.seq + 1) { row.behind = true; break; }
    apply(row, event); row.seq = event.seq; row.lastAt = typeof event.at === 'string' ? event.at : row.lastAt; changed = true;
  }
  return changed;
}
export function viewMethods(ctx) {
  return {
    // Each side's half of the pair: whether it marks the other machine as its own. A yes from
    // the machine one of my mine codes admitted is the answer that code waited for: this side
    // marks it back, once. Any other yes only waits for /mine here, or for GitHub pairing
    // (github.mjs), which looks again soon. Every connection says it, so a line is said only
    // when what that machine says changed.
    'elu.mine': (params, session) => {
      if (!session?.admitted || !isObject(params) || typeof params.mine !== 'boolean') return null;
      const changed = noteTheirs(session.key, params.mine);
      let accepted = false;
      try { accepted = params.mine && !markedMine(session.key) && takeMineOffer(myTeams(ctx.me.key), session.key); if (accepted) markMine(ctx.me.key, session.key); }
      catch (error) { accepted = false; ctx.log?.(`mine: ${error.message}`); }
      if (accepted) session.notify('elu.mine', { mine: true });
      const name = called(ctx, session.key), github = changed && params.mine ? pairedByGithub(session.key) : null;
      if (accepted) ctx.event?.(`${name} is yours now: type ${name} first in the new session box to start a session there`);
      else if (github) ctx.event?.(PAIRED_BY_GITHUB(name, github.login));
      else if (changed) ctx.event?.(`${name} ${params.mine ? 'marks' : 'no longer marks'} this computer as theirs`);
      if (changed && params.mine && !markedMine(session.key)) ctx.pairSoon?.();
      return null;
    },
    'elu.remote.events': (params, session) => {
      needMine(ctx, session);
      for (const item of Array.isArray(params?.items) ? params.items.slice(0, 64) : []) {
        if (!isObject(item) || !ID.test(item.id ?? '')) continue;
        // A session I handed off to that computer and work on there as my own arrives with no
        // row here yet: it gets one, and catches up from its first event.
        const row = readRow(viewFile(item.id)) ?? (viewed().length < VIEWS_MAX ? { id: item.id, machine: session.key, createdAt: new Date().toISOString(), seq: 0, state: 'starting', title: 'Your handoff', text: '', project: null, entries: [], steps: [], approvals: [], plan: null, diff: null, bots: [], mode: null, handoff: true, behind: true } : null);
        if (!row || row.machine !== session.key) continue;
        if (take(row, Array.isArray(item.events) ? item.events.slice(0, 2000) : []) || row.behind) saveView(row);
      }
      return null;
    },
  };
}
// On every connection with a teammate: each side says whether it marks the other as its own,
// and sessions started on that machine catch up from the last event this one has.
export function remoteConnected(ctx, session) {
  // A build from before this knows neither method: it is told nothing.
  if (session.remoteHello?.remote !== 1) return;
  session.notify('elu.mine', { mine: markedMine(session.key) });
  // Its sessions are listed again at once, all of them.
  ctx?.listedAt?.delete(session.key); ctx?.paging?.delete(session.key);
  const kept = readRow(machineFile(session.key)); if (kept && (kept.fullAt || kept.older)) saveMachine({ ...kept, fullAt: 0, olderAt: 0 });
  for (const row of viewed()) if (row.machine === session.key) { row.behind = true; saveView(row); }
}
// What this machine asks a computer of mine on its own (lists, catch-ups) and the watches the
// cursor makes all count against one budget per computer: a connection takes 20 requests in
// 10 s (more closes it). These use at most 8, and with watches at most 14, so status, Tasks and
// what the owner types always fit.
const BUDGET = 8, BUDGET_WATCH = 14, BUDGET_MS = 10000;
const used = (ctx, key, now = Date.now()) => { const sent = ctx.sent ??= new Map(), times = (sent.get(key) ?? []).filter(at => Math.abs(now - at) < BUDGET_MS); sent.set(key, times); return times; };
export function spend(ctx, key, { max = BUDGET, now = Date.now() } = {}) {
  const times = used(ctx, key, now);
  if (times.length >= max) return false;
  times.push(now); return true;
}
// Catch-up for sessions that missed events: a few at a time, within the budget.
export function viewTick(ctx, now = Date.now()) {
  if (ctx.catching) return;
  const due = [];
  for (const row of viewed()) {
    if (due.length >= 3) break;
    if (!row.behind) continue;
    const session = ctx.session(row.machine);
    if (session && session.remoteHello?.remote === 1 && bothMine(ctx.me.key, row.machine) && spend(ctx, row.machine, { now })) due.push(row);
  }
  if (!due.length) return;
  ctx.catching = true;
  return Promise.all(due.map(async row => {
    try {
      const result = await ctx.session(row.machine)?.request('elu.remote.since', { id: row.id, after: row.seq });
      const now = readRow(viewFile(row.id)) ?? row;
      now.behind = false;
      take(now, Array.isArray(result?.events) ? result.events : [], { first: Number.isSafeInteger(result?.first) ? result.first : null });
      if (result?.more === true || now.behind) now.behind = true;
      saveView(now);
    } catch (error) {
      ctx.log?.(`catch-up ${row.id.slice(0, 8)}: ${error.message}`);
      // A session the other side no longer has stops asking. One that was only watched is
      // let go here too: opened again, it is watched again.
      if (/not on this computer/.test(error.message)) { const now = readRow(viewFile(row.id)); if (now?.ref) fs.rmSync(viewFile(row.id), { force: true }); else if (now) { now.behind = false; now.state = 'gone'; now.error = 'That computer no longer has this session.'; saveView(now); } }
    }
  })).finally(() => { ctx.catching = false; });
}
// Every session on each computer of mine, as it last listed them (elu.remote.list), one
// file per computer: peer/remote/machines/<key>.json. A computer is asked for everything when
// it connects, then every few seconds for what changed since its last answer. A list of many
// pages takes one page a tick. One on a build that cannot list is marked older, and asked
// again in ten minutes.
const LIST_MS = 3000, PAGING_MS = 60000, OLDER_MS = 600000, PAGES = 10, LISTED_MAX = 1000, STALE_MS = 120000;
const machineFile = key => peerFile('remote', 'machines', `${key}.json`);
const saveMachine = row => { mkdir(peerFile('remote', 'machines')); atomic(machineFile(row.key), row); };
const BY = ['you', 'schedule', 'bot', 'teammate', 'mine'];
// What a computer of mine says about one session. It is my own computer, but what it says
// comes from models and teammates: every field is checked. ours: the names of this computer
// and of the others of mine (ownNames), for a host from before only. It lists a session that a
// message from one of them started as a teammate's, by that name: it is mine. A newer host
// decides that from the key the message came from, and lists a real teammate's as theirs
// whatever their name: for one, ours is empty.
function cleanListed(me, key, row, ours = new Set()) {
  if (!isObject(row) || !REF.test(row.ref ?? '') || !PROJECT.test(row.project ?? '') || row.ref.split(':')[0] !== row.project) return null;
  const at = time(row.at) ? new Date(time(row.at)).toISOString() : null, who = row.who ? short(row.who, 40).replace(/[\s@]+/g, '') || null : null;
  const by = BY.includes(row.by) ? row.by : 'you', mine = by === 'teammate' && Boolean(who) && ours.has(who.toLowerCase());
  return { id: watchId(me, key, row.ref), ref: row.ref, project: row.project, title: short(row.title, 80), state: STATES.includes(row.state) ? row.state : 'stopped', at, createdAt: time(row.createdAt) ? new Date(time(row.createdAt)).toISOString() : at,
    question: row.question ? short(row.question, 200) : null, error: row.error ? short(row.error, 200) : null, plan: isObject(row.plan) && row.plan.state === 'proposed' ? { state: 'proposed', title: short(row.plan.title, 80) } : null,
    approvals: (Array.isArray(row.approvals) ? row.approvals : []).slice(0, 10).filter(item => isObject(item) && /^[A-Za-z0-9_-]{1,160}$/.test(item.id ?? '')).map(item => ({ id: item.id, role: short(item.role ?? 'lead', 40), summary: short(item.summary, 200), at: typeof item.at === 'string' ? item.at : null, ...(typeof item.always === 'string' && item.always.trim() ? { always: short(item.always, 200) } : {}) })),
    by: mine ? 'mine' : by, who: mine ? null : who, repoId: HEX64.test(row.repoId ?? '') ? row.repoId : null, ...(ID.test(row.remoteId ?? '') ? { remoteId: row.remoteId } : {}), ...(row.standup === false ? { standup: false } : {}) };
}
const cleanProject = row => isObject(row) && PROJECT.test(row.id ?? '') ? { id: row.id, name: short(row.name, 60) || row.id.slice(0, 6), repoId: HEX64.test(row.repoId ?? '') ? row.repoId : null, home: row.home === true } : null;
// One page of one computer's list. The pages of one list are kept in ctx.paging until the
// last: a full answer then replaces what is kept; any other is merged.
async function listOne(ctx, key, kept, now) {
  const session = ctx.session(key);
  const state = ctx.paging.get(key) ?? { full: !Number.isSafeInteger(kept.cursor) || !kept.fullAt, since: kept.cursor, after: null, pages: 0, whole: false, cursor: null, projects: kept.projects ?? [], got: [], gone: [] };
  state.at = now;
  const result = await session.request('elu.remote.list', { since: state.full ? null : state.since, after: state.after, limit: 100 });
  if (!isObject(result)) { ctx.paging.delete(key); return; }
  if (state.pages === 0) { state.whole = result.full === true || state.full; state.cursor = Number.isSafeInteger(result.cursor) ? result.cursor : null; }
  if (Array.isArray(result.projects)) state.projects = result.projects.slice(0, 200).map(cleanProject).filter(Boolean);
  const ours = result.mineByPeer === true ? new Set() : ownNames(ctx.me.key, [ctx.me.name, ...mineRows().filter(row => bothMine(ctx.me.key, row.key)).map(row => ctx.name?.(row.key))]);
  state.got.push(...(Array.isArray(result.sessions) ? result.sessions.slice(0, 100) : []).map(row => cleanListed(ctx.me.key, key, row, ours)).filter(Boolean));
  state.gone.push(...(Array.isArray(result.gone) ? result.gone.filter(ref => REF.test(ref ?? '')).slice(0, 1000) : []));
  state.pages++; state.after = typeof result.next === 'string' && result.next.length <= 80 ? result.next : null;
  if (state.after && state.pages < PAGES) { ctx.paging.set(key, state); return; }
  ctx.paging.delete(key);
  const now2 = readRow(machineFile(key)) ?? kept, mine = new Map(state.whole ? [] : (now2.sessions ?? []).map(row => [row.ref, row]));
  for (const ref of state.gone) mine.delete(ref);
  for (const row of state.got) mine.set(row.ref, row);
  const sessions = [...mine.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, LISTED_MAX);
  saveMachine({ key, listedAt: new Date(now).toISOString(), cursor: state.cursor, fullAt: state.whole ? now : kept.fullAt ?? 0, older: false, error: null, projects: state.projects, sessions, standup: session.remoteHello?.standup === 1 });
  letGo(key, sessions, now);
}
// A watch that computer let go (a week with nothing new) sends nothing more. Its view here is
// dropped once its listing shows a change it never sent: the row shows what was listed, and
// opening it watches it again.
function letGo(key, sessions, now) {
  const at = new Map(sessions.map(row => [row.ref, time(row.at)]));
  for (const row of viewed()) {
    if (row.machine !== key || !row.ref || row.behind || !at.has(row.ref)) continue;
    if (at.get(row.ref) > Math.max(time(row.lastAt), time(row.watchedAt)) + STALE_MS && now - time(row.watchedAt) > STALE_MS) fs.rmSync(viewFile(row.id), { force: true });
  }
}
export function listTick(ctx, now = Date.now()) {
  ctx.listing ??= new Set(); ctx.listedAt ??= new Map(); ctx.paging ??= new Map();
  const due = [];
  for (const { key, mine, theirs } of mineRows()) {
    if (!mine || !theirs || !bothMine(ctx.me.key, key) || ctx.listing.has(key)) continue;
    const session = ctx.session(key), kept = readRow(machineFile(key)) ?? { key };
    if (!session) continue;
    // A build from before sessions on other computers: it can list nothing until it updates.
    if (session.remoteHello?.remote !== 1) { if (!kept.older) saveMachine({ ...kept, key, older: true, olderAt: now }); continue; }
    if (kept.older && now - (kept.olderAt ?? 0) < OLDER_MS) continue;
    // The next page of a list goes at the next tick; a new list every few seconds. One left half done for a minute starts again.
    const paging = ctx.paging.get(key);
    if (paging && Math.abs(now - paging.at) > PAGING_MS) ctx.paging.delete(key);
    if (!ctx.paging.has(key) && now - (ctx.listedAt.get(key) ?? 0) < LIST_MS) continue;
    if (!spend(ctx, key, { now })) continue;
    ctx.listedAt.set(key, now); ctx.listing.add(key); due.push([key, kept]);
  }
  return Promise.all(due.map(async ([key, kept]) => {
    try { await listOne(ctx, key, kept, now); }
    catch (error) {
      // A build that has sessions on other computers, but no list: it needs an update to show them here.
      // Any other failure asks for the same page again at a later tick.
      if (error.details?.rpc?.code === -32601) { ctx.paging.delete(key); saveMachine({ ...(readRow(machineFile(key)) ?? kept), key, older: true, olderAt: now }); }
      else ctx.log?.(`list ${key.slice(0, 8)}: ${error.message}`);
    } finally { ctx.listing.delete(key); }
  }));
}
// The view of a session of a computer of mine that this one did not start: watched there
// first, then caught up here as a session started from here is.
// cursor: a watch the cursor made, which waits when that computer was asked too much just now.
async function watched(ctx, key, ref, { cursor = false } = {}) {
  if (!HEX64.test(key ?? '') || !REF.test(ref ?? '')) refuse('Choose a session.');
  const id = watchId(ctx.me.key, key, ref), existing = readRow(viewFile(id));
  if (existing && existing.machine === key) return existing;
  if (cursor && ctx.session(key) && used(ctx, key).length >= BUDGET_WATCH) refuse(`${called(ctx, key)} is busy. It opens in a moment.`);
  const result = await ask(ctx, key, 'elu.remote.watch', { ref });
  if (result?.id !== id) refuse(`${called(ctx, key)} answered for another session.`);
  const listedRow = (readRow(machineFile(key))?.sessions ?? []).find(row => row.ref === ref);
  const row = { id, machine: key, ref, createdAt: listedRow?.createdAt ?? new Date().toISOString(), watchedAt: new Date().toISOString(), seq: 0, state: listedRow?.state ?? 'stopped', title: short(result.title, 80) || listedRow?.title || 'Session', project: short(result.project, 60) || null, entries: [], steps: [], approvals: listedRow?.approvals ?? [], plan: null, diff: null, bots: [], mode: null, behind: true };
  saveView(row);
  return row;
}
// The session a command is about: one this machine has a view of, by id, or one of a computer of mine by its ref.
const target = (ctx, command) => command.ref != null ? watched(ctx, command.to, command.ref) : viewOf(command.id);
// A command about one session, sent to its computer. A watch that computer let go is made
// again once, and the command sent again: "not on this computer" then means it really is gone.
async function onSession(ctx, command, method, params = {}) {
  const row = await target(ctx, command);
  try { return { row, result: await ask(ctx, row.machine, method, { id: row.id, ...params }) }; }
  catch (error) {
    if (!row.ref || !/not on this computer/.test(error.message)) throw error;
    fs.rmSync(viewFile(row.id), { force: true });
    const again = await watched(ctx, row.machine, row.ref);
    return { row: again, result: await ask(ctx, again.machine, method, { id: again.id, ...params }) };
  }
}
// A request to my other computer about one of its sessions. A build that does not know the
// method answers Method not found: it needs an update, which is said, and nothing else is tried.
export const WAITING = name => `Waiting for ${name} to mark this machine too.`;
async function ask(ctx, key, method, params, options) {
  const session = ctx.session(key), name = called(ctx, key);
  if (!markedMine(key)) refuse(`${name} is not one of your computers. Run /mine ${name} here and on it.`);
  if (!session) refuse(`${name} is offline. Try again once it is on.`);
  // A build from before sessions on other computers cannot mark this one: it needs an update first.
  if (session.remoteHello?.remote !== 1) refuse(UPDATE(name));
  if (!bothMine(ctx.me.key, key)) refuse(`${WAITING(name)} On it, run /mine @${String(ctx.me.name ?? '').replace(/[\s@]+/g, '') || ctx.me.fingerprint}.`);
  // What the owner does is never held back, but it counts: the lists and catch-ups wait for it.
  used(ctx, key).push(Date.now());
  try { return await session.request(method, params, options); }
  catch (error) {
    if (error.details?.rpc?.code === -32601) refuse(method === 'elu.remote.files' ? FILES_UPDATE(name) : UPDATE(name));
    throw new EluCodeError(`${name}: ${error.message}`, error.details);
  }
}
// The pieces of one send, paced within what this machine asks that computer on its own: a
// piece waits while the lists, catch-ups and watches of the last 10 s used their share, and
// one the other side found too many at once is sent again shortly.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function sendFiles(ctx, row, staged, text) {
  const key = row.machine, session = ctx.session(key), name = called(ctx, key);
  // A computer of mine on a build from before files says so in its hello: nothing is sent to it.
  if (session && session.remoteHello?.remote === 1 && session.remoteHello?.files !== 1) refuse(FILES_UPDATE(name));
  const send = crypto.randomUUID(), last = Math.max(0, Math.ceil(staged.total / PIECE) - 1);
  let seq = 0, result = null;
  for (const piece of pieces(staged)) {
    const params = { id: row.id, send, seq, last: seq === last, size: staged.total, data: piece.toString('base64'), ...(seq === last ? { text } : {}) };
    for (let tries = 0; ; tries++) {
      for (let waited = 0; used(ctx, key).length >= BUDGET_WATCH && waited < 30000; waited += 250) await pause(250);
      try { result = await ask(ctx, key, 'elu.remote.files', params, { timeoutMs: 60000 }); break; }
      catch (error) {
        const busy = error.details?.rpc?.code === -32000 || /Too many requests|still on their way/.test(error.message) || error.details?.timeout === true;
        if (busy && tries < 8) { await pause(1000 * (tries + 1)); continue; }
        throw error;
      }
    }
    seq++;
  }
  return result;
}
const viewOf = id => { const row = ID.test(id ?? '') ? readRow(viewFile(id)) : null; if (!row) refuse('That session is gone.'); return row; };
// The daemon's commands for /mine and for sessions on my other computers.
export async function remoteCommand(ctx, command) {
  switch (command.type) {
    case 'mine': {
      markMine(ctx.me.key, command.key);
      const session = ctx.session(command.key);
      if (session?.remoteHello?.remote === 1) session.notify('elu.mine', { mine: true });
      // older: connected, on a build that cannot mark this machine back until it updates.
      return { key: command.key, both: bothMine(ctx.me.key, command.key), older: Boolean(session) && session.remoteHello?.remote !== 1 };
    }
    case 'unmine': {
      unmarkMine(command.key);
      const session = ctx.session(command.key);
      if (session?.remoteHello?.remote === 1) session.notify('elu.mine', { mine: false });
      return { key: command.key };
    }
    case 'remoteStart': {
      if (!HEX64.test(command.to ?? '')) refuse('Choose one of your computers.');
      if (typeof command.text !== 'string' || !command.text.trim() || command.text.length > TEXT_MAX) refuse(`Write the message in 1 to ${TEXT_MAX} characters.`);
      const id = crypto.randomUUID(), now = new Date().toISOString();
      const row = { id, machine: command.to, createdAt: now, seq: 0, state: 'starting', title: short(firstLine(command.text), 80), text: short(command.text, ENTRY_MAX), project: null, entries: [], steps: [], approvals: [], plan: null, diff: null, bots: Array.isArray(command.bots) ? command.bots.filter(name => typeof name === 'string' && BOT_NAME.test(name)) : [], mode: command.permissions ?? null };
      // Checked here first, so a refusal leaves no row behind.
      await ask(ctx, command.to, 'elu.remote.start', { id, text: command.text, permissions: command.permissions, place: command.place ?? null, model: command.model ?? null, bots: command.bots ?? [] }).then(result => { row.project = short(result?.project, 60) || null; });
      // What it sent before this row existed is caught up at once.
      saveView({ ...row, behind: true });
      return { id, project: row.project };
    }
    case 'remoteWatch': { const row = await watched(ctx, command.to, command.ref, { cursor: command.cursor === true }); return { id: row.id }; }
    case 'remoteSend': { const { row } = await onSession(ctx, command, 'elu.remote.send', { text: command.text }); return { id: row.id }; }
    // Files staged by the app or a session's tool (files.mjs), with a message or none.
    case 'remoteFiles': {
      const text = typeof command.text === 'string' ? command.text : '';
      if (text.length > TEXT_MAX) refuse(`Write the message in up to ${TEXT_MAX} characters.`);
      const staged = stagedFiles(command.files);
      try {
        let row = await target(ctx, command), result;
        try { result = await sendFiles(ctx, row, staged, text); }
        catch (error) {
          // A watch that computer let go is made again once, as for any command.
          if (!row.ref || !/not on this computer/.test(error.message)) throw error;
          fs.rmSync(viewFile(row.id), { force: true }); row = await watched(ctx, row.machine, row.ref);
          result = await sendFiles(ctx, row, staged, text);
        }
        return { id: row.id, files: Number.isSafeInteger(result?.files) ? result.files : staged.count, bytes: Number.isSafeInteger(result?.bytes) ? result.bytes : staged.bytes };
      } finally { dropOutgoingFiles(staged.set); }
    }
    case 'remoteStop': return (await onSession(ctx, command, 'elu.remote.stop')).result;
    case 'remoteAnswer': {
      const always = ['project', 'all'].includes(command.always) ? command.always : null;
      const { row, result } = await onSession(ctx, command, 'elu.remote.answer', { approval: command.approval, decision: command.decision, ...(always ? { always } : {}) });
      // Gone from Needs you at once; the next events say what the session does with it.
      const now = readRow(viewFile(row.id)); if (now) { now.approvals = (now.approvals ?? []).filter(item => item.id !== command.approval); saveView(now); }
      return { answered: result?.answered === true, ...(always && typeof result?.kept === 'string' ? { kept: short(result.kept, 200) } : {}) };
    }
    case 'remoteTask': {
      const { result } = await onSession(ctx, command, 'elu.remote.task', { decision: command.decision });
      return { answered: result?.answered === true };
    }
    // A standup's question, its answers and its stop (lib/standup-round.mjs). A computer that is
    // not connected, or whose hello does not say it can answer one, is never sent it.
    case 'remoteStandup': case 'remoteStandupRead': case 'remoteStandupStop': {
      if (!HEX64.test(command.to ?? '')) refuse('Choose one of your computers.');
      const session = ctx.session(command.to);
      if (!session) return { offline: true };
      if (session.remoteHello?.remote !== 1 || session.remoteHello?.standup !== 1) return { older: true };
      const method = { remoteStandup: 'elu.remote.standup', remoteStandupRead: 'elu.remote.standupRead', remoteStandupStop: 'elu.remote.standupStop' }[command.type];
      return ask(ctx, command.to, method, { round: command.round, ...(Array.isArray(command.refs) ? { refs: command.refs.slice(0, 20) } : {}), ...(command.type === 'remoteStandup' && typeof command.question === 'string' ? { question: command.question } : {}) });
    }
    // Takes it out of this machine's Sessions. It keeps running, and stays, on the other computer.
    case 'remoteForget': { const row = viewOf(command.id); fs.rmSync(viewFile(row.id), { force: true }); return { id: row.id }; }
    default: refuse('Unknown peer command.');
  }
}
export const REMOTE_COMMANDS = ['mine', 'unmine', 'remoteStart', 'remoteWatch', 'remoteSend', 'remoteFiles', 'remoteStop', 'remoteAnswer', 'remoteTask', 'remoteForget', 'remoteStandup', 'remoteStandupRead', 'remoteStandupStop'];

// ---- Reads for the app and the CLI (files only) ----

// The sessions started from here on my other computers, newest first.
export function remoteSessions() {
  return viewed().sort((a, b) => String(b.lastAt ?? b.createdAt).localeCompare(String(a.lastAt ?? a.createdAt)));
}
// Each computer of mine as it last listed its sessions: {key, listedAt, older, projects, sessions}.
export function remoteMachines() {
  return list(peerFile('remote', 'machines'), HEX64).map(key => readRow(machineFile(key))).filter(row => row && HEX64.test(row.key ?? ''));
}
export { mineRows };
