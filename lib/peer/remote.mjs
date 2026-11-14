import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EluCodeError, atomic, fileLines, hash, homeOrAbove, isObject, mkdir, noSymlinks, readJson, refuse, within } from '../util.mjs';
import { firstWords, ownCommitStop, readTask, setTitle, taskDir, taskTitle, tasks } from '../state.mjs';
import { finished } from '../task-head.mjs';
import { inTimeOrder, runSteps, endedSteps } from '../run-activity.mjs';
import { conductorStatus, enqueue, sendCommand } from '../conductor.mjs';
import { addToRequest, pendingRequests, projectFolder, removeRequest, supersededRequests, typedRequest, typedFront, sendTypedNow } from '../workspace.mjs';
import { activity, conversationEntries, wroteIt, modelLabel, projectSnapshot, registerProject, registeredProjects, learnArchived, reportedModels, savedProjectName, sessionModel, sessionWire } from '../projects.mjs';
import { sessionChanges } from '../diff.mjs';
import { pullsStamp } from '../pulls.mjs';
import { listSchedules } from '../schedules.mjs';
import { repoId } from './shares.mjs';
import { clonesIn } from './cards.mjs';
import { cleanWait, sessionWait, waitOf } from '../waiting.mjs';
import { folderRemote, ownFolder, sessionFolders, withNewestOwned } from '../kanban-repos.mjs';
import { pendingApprovals, answerApproval } from '../approvals.mjs';
import { keepOffer, keepRule, usesSavedRules } from '../permission-rules.mjs';
import { approveTask, approvesTasks, currentTask, readMinutes, rejectTask, sessionTasks, sharedTask, waitingTask } from '../plan.mjs';
import { CHAT_BOTS_MAX, BOT_NAME, botOfKey, getBot, sessionBots } from '../bots.mjs';
import { checkMode, checkPlace } from '../modes.mjs';
import { checkModel, modelWords, setSessionModel } from '../models.mjs';
import { readAllModels } from '../bot-models.mjs';
import { peerFile } from './paths.mjs';
import { sanitize } from './peerdata.mjs';
import { remoteError } from './failure.mjs';
import { EDIT_UPDATE } from './reach-text.mjs';
import { teams } from './roster.mjs';
import { teamAccess } from './access.mjs';
import { PAIRED_BY_GITHUB, bothMine, markMine, markedMine, mineRows, noteTheirs, ownNames, pairedByGithub, pairedMine, unmarkMine } from './mine.mjs';
import { takeMineOffer } from './invite.mjs';
import { getRecord, records, updateRecord } from './taskstore.mjs';
import { isTerminal } from './a2a.mjs';
import { longText, stagedText } from './texts.mjs';
import { addFolder } from '../runner.mjs';
import { cleanTopAgents, topAgentsWire } from '../agent-spend.mjs';
import { PIECE, checkInbox, dropOutgoingFiles, filesLine, landFiles, landedText, pieces, stagedFiles, takePiece } from './files.mjs';
import { hostStandup, hostStandupRead, hostStandupStop, readWhole } from './standup.mjs';
import { closeSession, heldBySession, lastActivity, readBoard, reopenSession, rowSince, sessionClosed } from '../kanban.mjs';
import { deleteSession, unpushedWork } from '../session-delete.mjs';
import { standupOpen } from '../standup.mjs';

// Sessions on your other computer (docs/peer-network.md, "Your other computers"). One of
// your machines (the viewer, a laptop say) starts a session on another of yours (the host,
// a devbox), which runs it as its own owner's session and sends back what happens in it as
// numbered events. The viewer folds them into one file per session and the app draws that.
// Everything here is taken only from, and sent only to, a key both machines marked as mine.
export const UPDATE = name => `${name} needs to update ELU to run sessions from here.`;
// A computer of mine on a build that cannot list its sessions yet.
export const UPDATE_LIST = name => `Update ELU on ${name} to see its sessions here.`;
export const NOT_MINE = 'Only your own computers can do this. Mark each other with /mine on both of them.';
// A computer of mine on a build that cannot take a message longer than one line on the link.
export const LONG_UPDATE = name => `${name} needs to update ELU to get a message this long.`;
// A computer of mine on a build that cannot take files yet.
export const FILES_UPDATE = name => `${name} needs to update ELU to receive files.`;
// A computer of mine on a build that reads no model's name in a message: it would send the whole text as one and keep the old model.
export const MODEL_UPDATE = name => `Update ELU on ${name} to change its model from here.`;
// Files go only to the owner's own sessions there, never to a teammate's.
export const NOT_OWN_SESSION = "That session is a teammate's. Files from your other computers go only to your own sessions.";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A session there that has not started: there is nothing to rename or archive yet.
const NOT_STARTED = 'This session has not started yet. Try again once it has.';
const HEX64 = /^[0-9a-f]{64}$/;
// A message to a session on another computer of mine is of any length. One that fits one line
// on the link travels in its request; a longer one (longText in texts.mjs) goes ahead of it in
// elu.text.put pieces, and the request names it (longText: { id, size, sha256 }). ELU 0.1.19
// and earlier took 16000 characters. A chat entry and the diff of a session there reach the
// computer that follows it whole: one event carries at most CHUNK characters of text, a longer
// text goes on in the events after it (entry+, diff+), and a notification or an answer holds
// at most BATCH_BYTES of events, the rest being asked for by seq. STEP_MAX is one line of the
// activity list, as this computer shows it too.
const CHUNK = 60000, STEP_MAX = 400, BATCH_BYTES = 400 * 1024;
// How much the host keeps of each session's events, and how much a viewer keeps of its chat.
const EVENTS_KEPT = 4000, ENTRIES_KEPT = 200, STEPS_KEPT = 60, SEEN_KEPT = 600;
// What a turn did (lib/run-activity.mjs): the newest runs of the session, each with its steps.
const RUNS_KEPT = 20, PLAN_MAX = 50;
// A viewer is sent a session's newest FIRST_LOOK entries, and keeps its newest ENTRIES_KEPT.
// Neither is the end of the chat: each entry says its place in the chat (n, from 1), so the
// viewer knows how many come before its oldest one, and when its owner pages up to that one
// it asks for the OLDER_PAGE before it (elu.remote.older). They go out as the events of the
// next look, like any entry, and the viewer lets none go from then on, so paging up reaches
// the first one. An ELU from before this says no place and knows no older: what it shows is
// what it has.
const FIRST_LOOK = 80, OLDER_PAGE = 80;
// The diff of a working session is read again every DIFF_MS, and a long one less often: about
// DIFF_RATE characters of it a millisecond go over the link.
const DIFF_RATE = 25;
const PUSH_MS = 1500, DIFF_MS = 10000, KEPT_MS = 7 * 24 * 3600000, VIEWS_MAX = 200;
// The owner's messages to a session that have not run yet (held): how many a viewer is told
// of, how much of each it shows while it waits (the session gets it whole), and how long one
// may wait with no conductor running before it is said, and one is started again.
const HELD_MAX = 20, HELD_TEXT = 4000, STUCK_MS = 15000, KICK_MS = 30000;
const HELD = ['turn', 'queued', 'starting', 'stuck', 'blocked'];
// What a running turn does with a message sent to it (takes), and the states of its answer beside the turn (lib/message-aside.mjs).
const TAKES = ['step', 'command', 'now', 'fixed', 'beside', 'soon', 'end'], ASIDE_STATES = ['running', 'answered', 'failed'];

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
const projectFor = (me, key) => whereFor(me, key).repo;
// The same, and whether a team setting chose it (team).
function whereFor(me, key) {
  const repos = registeredProjects();
  for (const state of teams()) {
    if (![me, key].every(k => state.members.some(m => m.key === k && !m.removed))) continue;
    const root = teamAccess(state.id)?.root;
    const repo = root && repos.find(row => row.root === root);
    if (repo) return { repo, team: true, repos };
  }
  if (repos.length === 1) return { repo: repos[0], team: false, repos };
  if (repos.length) return { repo: repos.map(repo => ({ repo, at: newestSession(repo) })).reduce((best, row) => row.at > best.at ? row : best).repo, team: false, repos };
  refuse('No project is open there yet. Open ELU once on that computer, in the folder to work in, then send it again.');
}
// While the home folder is a project here and no team setting decides, the owner picks the
// folder a session from his other computer works in (elu.remote.folders): every project here,
// the home folder too, then each Git repository in the home folder, as a session's lead finds
// them. The one it would run in is said (root). A repository he picks becomes a project here,
// as opening it here would (pickedProject).
const realHome = () => { try { return fs.realpathSync(os.homedir()); } catch { return path.resolve(os.homedir()); } };
const homeLabel = (dir, home = realHome()) => dir === home ? '~' : within(home, dir) ? `~/${path.relative(home, dir)}` : dir;
const FOLDER = /^\/[^\u0000-\u001f\u007f]{0,4095}$/;
const PICK_LISTED = 'Pick one of the folders listed.';
function folderChoices(repos, now = Date.now()) {
  const home = realHome(), seen = new Set(), out = [];
  const add = (dir, project) => { if (!FOLDER.test(dir ?? '') || seen.has(dir)) return; seen.add(dir); out.push({ path: dir, label: short(homeLabel(dir, home), 200), name: short(projectName(dir), 60), project }); };
  for (const repo of repos) add(repo.root, true);
  const top = repos.find(repo => homeOrAbove(repo.root));
  if (top) for (const dir of clonesIn(top, now)) if (!homeOrAbove(dir)) add(dir, false);
  return out;
}
function pickedProject(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || !FOLDER.test(folder)) refuse(PICK_LISTED);
  let real; try { real = fs.realpathSync(folder); } catch { refuse(`${homeLabel(folder)} is not on this computer any more. ${PICK_LISTED}`); }
  const found = registeredProjects().find(row => row.root === real);
  if (found) return found;
  // Else a Git repository in the home folder, in its own folder: never the home folder or one
  // above it, a folder inside a repository, or a linked worktree (one of ELU's own among them).
  let repo = null; try { repo = homeOrAbove(real) || !within(realHome(), real) || !fs.lstatSync(path.join(real, '.git')).isDirectory() ? null : projectFolder(real); } catch { repo = null; }
  if (!repo?.common || repo.root !== real) refuse(`${homeLabel(real)} is not a project or a Git repository in the home folder here. ${PICK_LISTED}`);
  registerProject(repo);
  return registeredProjects().find(row => row.root === real) ?? repo;
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
  // A long session keeps its newest events; a viewer that was away longer catches up from the
  // oldest kept. The file is copied a line at a time: it may be larger than one string.
  if (row.seq - (row.first ?? 1) > EVENTS_KEPT * 1.5) {
    const from = row.seq - EVENTS_KEPT + 1, tmp = `${file}.${crypto.randomUUID()}.tmp`, fd = fs.openSync(tmp, 'wx', 0o600);
    let first = null;
    try { for (const line of fileLines(file)) { const seq = seqOf(line); if (seq === null || seq < from) continue; first ??= seq; fs.writeSync(fd, `${line}\n`); } } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    row.first = first ?? row.seq + 1;
  }
  return out;
}
// Each line of the events file starts with its seq (appendEvents), read without parsing the line.
const seqOf = line => { const seq = Number(/^\{"seq":(\d{1,15})[,}]/.exec(line)?.[1] ?? NaN); return Number.isSafeInteger(seq) ? seq : null; };
// The events of a session after seq `after`, oldest first, one at a time.
function* eventsAfter(row, after = 0) {
  const file = hostFile(row.id, 'jsonl');
  try { noSymlinks(file); } catch { return; }
  for (const line of fileLines(file)) {
    const seq = seqOf(line);
    if (seq === null || seq <= after) continue;
    try { const value = JSON.parse(line); if (isObject(value) && value.seq === seq) yield value; } catch { /* A line cut by a crash: left out. */ }
  }
}
// A text as the events that carry it: the first in an event of its own kind, the rest in the
// ones after it. No piece ends between the two halves of one character.
function chunks(text) {
  const out = [];
  for (let at = 0; at < text.length;) { let end = Math.min(text.length, at + CHUNK); const code = text.charCodeAt(end - 1); if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--; out.push(text.slice(at, end)); at = end; }
  return out.length ? out : [''];
}
function spread(type, item, field) {
  const [head, ...rest] = chunks(String(item[field] ?? ''));
  return [{ type, ...item, [field]: head, ...(rest.length ? { more: true } : {}) }, ...rest.map((text, index) => ({ type: `${type}+`, [field]: text, ...(index < rest.length - 1 ? { more: true } : {}) }))];
}
// What the viewer shows about the session now: its state and the parts that are compared
// with what was sent before. Entries and steps are sent once each, by a key of their own.
function hostView(row, now, previous) {
  const repo = repoOf(row.root);
  if (!repo) return { state: { state: 'gone', error: 'The project is no longer open on that computer.' } };
  const { taskId, request } = taskOf(row);
  if (taskId && !row.taskId) row.taskId = String(taskId);
  if (!taskId) {
    // One that waits to start says what for (lib/waiting.mjs): a free slot here, or a time. A
    // schedule's run goes by the name it takes, as the list says.
    const title = short(runTitle(request, row.text), 80);
    const waits = waitOf(request, now); if (waits) return { state: { state: 'starting', error: null, title, waits, since: { at: request.queuedAt ?? request.createdAt } } };
    const waiting = request && ['blocked'].includes(request.state);
    return { state: { state: request ? waiting ? 'blocked' : 'starting' : 'stopped', error: waiting ? short(remoteError(null, request.reason), 400) : null, title, ...(request ? { since: { at: request.queuedAt ?? request.createdAt } } : {}) } };
  }
  // A session deleted here (lib/session-delete.mjs) is gone, as one whose project closed is.
  if (!fs.existsSync(taskDir(repo, taskId))) return { state: { state: 'gone', error: 'The session was deleted on that computer.' } };
  const task = readTask(repo, taskId), plan = currentTask(repo, taskId);
  const reply = task.state === 'needs_input' ? task.reply?.outcome === 'needs_input' ? task.reply : task.result : null;
  // From the newest FIRST_LOOK entries, or from the place the viewer paged up to (row.from).
  const every = conversationEntries(repo, task, { all: true }), start = Math.max(0, Math.min(every.length - FIRST_LOOK, Number.isSafeInteger(row.from) ? row.from - 1 : Infinity));
  // model: the model its next message goes to, named as this computer's own message box names it.
  const model = (() => { try { const choice = sessionModel(repo, task); return choice ? short(modelLabel(choice, reportedModels([task])), 40) : null; } catch { return null; } })();
  const state = { state: task.state, title: short(taskTitle(task), 80), mode: task.permissions ?? null, place: task.place?.kind ?? 'worktree', bots: sessionBots(task), activeRole: task.activeRole ?? null, ...(model ? { model } : {}),
    error: task.error?.message ? short(remoteError(task), 400) : null, question: reply?.question ? short(reply.question, 2000) : null, choices: Array.isArray(reply?.choices) ? reply.choices.slice(0, 8).map(choice => short(choice, 200)) : [],
    // finished: all of its work is committed (lib/task-head.mjs); the viewer lists it as done.
    ...(finished(task) ? { finished: true } : {}) };
  // held: the owner's messages that wait while this turn works: on its input for its next step
  // (lib/runner.mjs inboxFeed), or for the turn to end. The viewer's Enter sends them now
  // (elu.remote.stop, now). during: a message that went to the turn while it worked.
  let held = 0;
  try { if (['running', 'preparing'].includes(task.state)) held = pendingRequests(row.root).filter(item => item.state === 'queued' && String(item.continuationTaskId) === String(task.id) && typedRequest(item)).length; } catch { held = 0; }
  // waits: what the next message to it waits for before its turn starts (lib/waiting.mjs), such
  // as a free slot here, while it does not work. The viewer says it in this computer's own words.
  if (!held) { try { const waits = sessionWait(pendingRequests(row.root), task.id, now); if (waits) state.waits = waits; } catch { /* Said at the next look. */ } }
  if (held) state.held = held;
  const entries = every.slice(start).map((entry, index) => ({ n: start + index + 1, role: short(entry.role, 80), at: entry.at ?? null, text: short(entry.text, Infinity), ...(entry.lead ? { lead: true } : {}), ...(entry.bot ? { bot: short(entry.bot, 30) } : {}), ...(entry.failed ? { failed: true } : {}), ...(entry.quiet ? { quiet: true } : {}), ...(entry.shell ? { shell: true } : {}), ...(entry.during ? { during: true } : {}), ...(entry.aside && entry.line ? { line: true } : {}), ...(entry.aside && entry.update ? { update: true } : {}), ...(entry.beside ? { beside: true } : {}), ...wroteIt(entry) }));
  // beside: how many of its newest rows marked beside were answered beside the turn that works
  // now (lib/message-aside.mjs). An entry is sent once, so its own mark outlives that turn; this count does not.
  const besideNow = entries.filter(entry => entry.beside).length;
  if (besideNow) state.beside = besideNow;
  // A review of a bot is part of what the session shows: its summary and what it found, at the
  // time it was given. One saved before reviews kept their time (ELU up to 0.1.19) goes at the
  // end of the bot's run that gave it, where that bot's runs and reviews pair one to one; else
  // with none, and the viewer puts it after the entry before it.
  const reviewAt = review => { if (review.at) return review.at; const theirs = (task.reviews ?? []).filter(row => row.role === review.role), runs = (task.runs ?? []).filter(run => run.role === review.role); return theirs.length === runs.length ? runs[theirs.indexOf(review)]?.at ?? null : null; };
  for (const review of task.reviews ?? []) {
    const who = String(review.role ?? '').startsWith('bot:') ? review.role.slice(4) : null, result = review.result ?? {};
    const comments = (result.comments ?? []).map(comment => `${comment.severity ?? 'note'}: ${comment.body ?? ''}`);
    if (who && (result.summary || comments.length)) entries.push({ role: `@${who} · review ${review.round ?? ''}`.trim(), at: reviewAt(review), text: short([result.summary ?? '', ...comments].filter(Boolean).join('\n'), Infinity), bot: who, ...wroteIt(review) });
  }
  const steps = activity(repo, [task], 80).filter(item => String(item.taskId) === String(task.id)).map(item => ({ at: item.at ?? null, text: short(item.text, STEP_MAX) }));
  // Each run of the model and its bots, the one in progress too, with what it did. A turn the
  // owner stopped is among them (task.stops, lib/runner.mjs). A run that ended is sent as it
  // ended: a call it left running was cut there.
  const dir = taskDir(repo, task.id), ended = run => Date.parse(run.at ?? '') || 0;
  const own = [...(task.runs ?? []), ...(task.stops ?? []).map(run => ({ ...run, stopped: true }))].filter(run => typeof run.logFile === 'string' && path.dirname(run.logFile) === dir && !run.standup && (run.role === 'lead' || String(run.role).startsWith('bot:'))).sort((a, b) => ended(a) - ended(b));
  const runs = own.map(run => ({ run: runKey(run.logFile), role: short(run.role, 40), startedAt: run.startedAt ?? null, at: run.at ?? null, ...(run.stopped ? { stopped: true } : {}), steps: endedSteps(runSteps(run.logFile, { cwd: task.worktree }), Date.parse(run.at ?? '')) }));
  // silent: the run in progress prints only when it ends (lib/runner.mjs activeSilent), named by its program.
  const silent = task.activeSilent?.log && task.activeSilent.log === task.activeLog ? short(task.activeSilent.name ?? '', 40) || 'This program' : null;
  if (task.state === 'running' && task.activeLog && path.dirname(task.activeLog) === dir && !own.some(run => run.logFile === task.activeLog)) runs.push({ run: runKey(task.activeLog), role: short(task.activeRole ?? 'lead', 40), startedAt: task.activeSince ?? null, at: null, ...(silent ? { silent } : {}), steps: runSteps(task.activeLog, { cwd: task.worktree }) });
  // always: the rule a would keep on this computer, in words, where a is offered (lib/permission-rules.mjs).
  const approvals = (() => { try { return pendingApprovals({ taskId: String(task.id) }).filter(item => !item.root || item.root === row.root).map(item => { const kept = keepOffer(item, task.origin)?.summary; return { id: item.id, role: item.role ?? 'lead', summary: short(item.summary, 200), at: item.at, ...(kept ? { always: short(kept, 200) } : {}) }; }); } catch { return []; } })();
  const shared = plan ? sharedTask(plan) : null;
  // While its turn works, where its row in Sessions here counts from, as the list says it
  // (summary): the start of the turn. At rest the list alone says it, so a new message is one event.
  if (['running', 'preparing'].includes(task.state)) state.since = rowSince(task);
  // The diff is read again at most every DIFF_MS while the session works (a long one less
  // often, as all of it is sent), and once when it stops. It is what this computer's own
  // Changes view shows: what the session itself changed, branch by branch, whole, new files
  // too. Where this process cannot hold a new file, each one over 64,000 bytes goes as its
  // end, and says so. It is read once more when a pull request of the session becomes known,
  // and once by an ELU whose rule for what a session changed is newer than the one that read
  // it last (the 2 the mark starts with): what the other computer holds is then the old count.
  const mark = `2:${task.state}:${task.runs?.length ?? 0}:${task.activeRole ?? ''}:${task.kind === 'conversation' ? 0 : pullsStamp(task.worktree)}`;
  let diff = previous?.diff ?? null;
  if (task.kind !== 'conversation' && (mark !== row.diffMark || (task.state === 'running' && now - (row.diffAt ?? 0) > Math.max(DIFF_MS, (row.diffSize ?? 0) / DIFF_RATE)))) {
    try {
      const read = whole => short(sessionWire(repo, task.id, { whole }), Infinity);
      let text; try { text = read(true); } catch { text = read(false); }
      diff = { summary: diffSummary(text), patch: text }; row.diffSize = text.length;
    }
    catch { diff = previous?.diff ?? null; }
    row.diffAt = now; row.diffMark = mark;
  }
  return { state, entries, steps, runs: runs.slice(-RUNS_KEPT), approvals, plan: shared, diff, waiting: heldMessages(row.root, task, now) };
}
// The owner's messages to a session here that have not run yet, oldest first, as its chat
// shows them on this computer, so the computer they were sent from never shows nothing:
// state turn (it works), starting, queued (with the conductor's reason, such as no free slot),
// stuck (no conductor runs to take it) or blocked (with why). One sent while it works also
// says what its running turn does with it (takes): step (the turn reads it at its next step),
// command (it is on the turn's input behind a running command), now (being sent now), fixed
// (the turn has it), beside (the turn takes no message, so it is answered beside the turn,
// lib/message-aside.mjs), soon (the turn has not said yet whether it takes messages) or end
// (it starts when the turn ends); stops when sending it now
// stops the running command; and aside, the answer beside the turn as its request keeps it.
// A blocked one he moved on from, with a newer message to the session, is spent and not shown,
// as on this computer (supersededRequests). Each project's requests are read once a look
// (hostTick), however many sessions of it are followed.
const queues = new Map();
function heldMessages(root, task, now) {
  if (!queues.has(root)) { let all = []; try { all = pendingRequests(root); } catch { all = []; } queues.set(root, all); }
  const rows = queues.get(root), own = rows.filter(row => String(row.continuationTaskId) === String(task.id) && !row.origin && !row.standupFor && !row.scheduled && ['queued', 'starting', 'blocked'].includes(row.state));
  if (!own.length) return [];
  const spent = new Set(supersededRequests(rows, [task])), mine = own.filter(row => !spent.has(row.id));
  const working = ['running', 'preparing'].includes(task.state);
  let conducted = true; try { conducted = working || conductorStatus(now).running; } catch { conducted = true; }
  return mine.slice(0, HELD_MAX).map(row => {
    const text = `${row.bot ? `@${row.bot} ` : ''}${row.goal ?? ''}`, state = row.state !== 'queued' ? row.state : working ? 'turn' : !conducted && now - time(row.queuedAt ?? row.createdAt) > STUCK_MS ? 'stuck' : 'queued';
    // Once its turn is over, what the request says of that turn (after an answer beside it) no longer holds.
    const reason = state === 'blocked' || state === 'queued' && row.reason && row.reason !== 'Waiting to start.' && !isObject(row.aside) ? short(row.reason, 300) : null;
    const speaker = task.state === 'running' && typedRequest(row) && !row.back && (row.bot ?? null) === (botOfKey(task.activeRole ?? '') ?? null);
    const mine = typedRequest(row) && !row.back && (row.bot ?? null) === (botOfKey(task.activeRole ?? '') ?? null);
    const takes = state !== 'turn' ? null : speaker && task.activeInbox === true ? row.turn ? row.now ? 'now' : row.fixed ? 'fixed' : 'command' : 'step' : speaker && task.activeDeaf === true ? 'beside' : mine && task.activeInbox !== true && task.activeDeaf !== true ? 'soon' : 'end';
    const aside = takes && isObject(row.aside) && ASIDE_STATES.includes(row.aside.state) ? { state: row.aside.state, ...(row.aside.state === 'answered' ? { text: short(row.aside.text, HELD_TEXT), who: short(row.aside.who ?? '', 80), at: stamp(row.aside.at) } : {}), ...(row.aside.state === 'failed' ? { error: short(row.aside.error ?? '', 300) } : {}) } : null;
    return { at: typeof row.createdAt === 'string' ? row.createdAt : null, text: short(text.length > HELD_TEXT ? `${text.slice(0, HELD_TEXT)}…` : text, HELD_TEXT + 1), state, ...(reason ? { reason } : {}), ...(takes ? { takes } : {}), ...(takes === 'now' && row.reason ? { reason: short(row.reason, 300) } : {}), ...(takes && task.activeNowStops === true ? { stops: true } : {}), ...(aside ? { aside } : {}) };
  });
}
// A run goes by its log's name, never its path on this computer.
const runKey = file => hash(path.basename(file)).slice(0, 16);
// One step as it goes to the viewer. since: when a call that still runs started, by this
// computer's clock; the viewer counts on from it.
const wireStep = step => ({ kind: step.kind, text: short(step.text, Infinity), ...(step.status ? { status: step.status } : {}), ...(step.note ? { note: short(step.note, 40) } : {}), ...(step.sub ? { sub: true } : {}),
  ...(step.entries ? { entries: step.entries.slice(0, PLAN_MAX).map(entry => ({ text: short(entry.text, 400), state: entry.state })) } : {}),
  ...(Number.isFinite(step.since) ? { since: Math.round(step.since) } : {}), ...(Number.isFinite(step.seconds) ? { seconds: step.seconds } : {}),
  ...(Number.isFinite(step.tokens) ? { tokens: step.tokens, ...(step.live ? { live: true } : {}) } : {}),
  ...(step.kind === 'background' ? { count: step.count, ...(step.tasks ? { tasks: true } : {}) } : {}) });
// The counts in a line, for a computer on an ELU that shows only this line: the files and
// the lines of every branch, as the Changes view counts them.
function diffSummary(text) {
  const changes = sessionChanges(text), files = changes.files.length;
  return files ? `${files} file${files === 1 ? '' : 's'} · +${changes.added} −${changes.removed}` : 'No changes';
}
const keyOf = value => hash(JSON.stringify(value)).slice(0, 24);
const NONE_HELD = keyOf([]);
// An entry's key leaves out the model and effort that wrote it and its place in the chat, so
// an entry sent by an older ELU, which had none of them, is not sent again. It leaves out that
// it was answered beside a turn too, which stops being so when that turn ends: the row is the same one.
const entryKey = item => { const { model: _model, effort: _effort, n: _n, beside: _beside, ...keyed } = item; return keyOf(keyed); };
// The events that tell what changed since the last look.
function diffView(row, view) {
  const seen = row.seen ??= {}, events = [];
  const digest = value => keyOf(value ?? null);
  if (digest(view.state) !== seen.state) { seen.state = digest(view.state); events.push({ type: 'state', ...view.state }); }
  // The viewer paged up past what it holds (elu.remote.older): the entries before the place
  // row.resend go out, whether or not they went once. It keeps the ones it lacks.
  if (Number.isSafeInteger(row.resend) && view.entries) {
    const again = new Set(view.entries.filter(item => item.n < row.resend).map(entryKey));
    seen.entries = (seen.entries ?? []).filter(key => !again.has(key)); delete row.resend;
  }
  for (const [kind, items] of [['entry', view.entries ?? []], ['step', view.steps ?? []]]) {
    const field = kind === 'entry' ? 'entries' : 'steps', known = new Set(seen[field] ?? []);
    for (const item of items) { const key = kind === 'entry' ? entryKey(item) : keyOf(item); if (known.has(key)) continue; known.add(key); events.push(...(kind === 'entry' ? spread('entry', item, 'text') : [{ type: kind, ...item }])); }
    // Every entry in view stays known, however far the viewer paged up, so none is sent twice.
    seen[field] = [...known].slice(-Math.max(SEEN_KEPT, items.length + 200));
  }
  // A run is sent with its first step and again when it ends; each step once, and again
  // whenever it changes (a tool call that finished, a thought still arriving).
  if (view.runs) {
    const marks = seen.runs ?? {}, kept = {};
    for (const run of view.runs) {
      const mark = marks[run.run] ?? { meta: null, steps: [] }, meta = { run: run.run, role: run.role, startedAt: run.startedAt, at: run.at, count: run.steps.length, ...(run.stopped ? { stopped: true } : {}), ...(run.silent ? { silent: run.silent } : {}) };
      const changed = run.steps.map(wireStep).flatMap((step, n) => { const key = keyOf(step); if (mark.steps[n] === key) return []; mark.steps[n] = key; return [{ type: 'act', run: run.run, n, ...step }]; });
      mark.steps.length = run.steps.length;
      if (changed.length || digest(meta) !== mark.meta) { mark.meta = digest(meta); events.push({ type: 'run', ...meta }, ...changed); }
      kept[run.run] = mark;
    }
    seen.runs = kept;
  }
  if (view.approvals && digest(view.approvals) !== seen.approvals) { seen.approvals = digest(view.approvals); events.push({ type: 'approvals', list: view.approvals }); }
  if (view.entries && digest(view.plan) !== seen.plan) { seen.plan = digest(view.plan); events.push({ type: 'plan', plan: view.plan }); }
  if (view.diff && digest(view.diff) !== seen.diff) { seen.diff = digest(view.diff); events.push(...spread('diff', view.diff, 'patch')); }
  // What waits to run is said when it changes; a session with none says nothing until it has had one.
  if (view.waiting && digest(view.waiting) !== (seen.waiting ?? NONE_HELD)) { seen.waiting = digest(view.waiting); events.push({ type: 'waiting', list: view.waiting }); }
  return events;
}
// Each tick: every session hosted here is looked at, what changed becomes events, and the
// computer that started it gets them at once when it is connected. One that is not catches
// up when it next connects (elu.remote.since).
const views = new Map(), looked = new Map();
// A session quiet for 10 minutes is looked at every 30 s; a message to it wakes it at once (wake).
const QUIET_MS = 600000, QUIET_LOOK_MS = 30000;
// For 30 s after that it is looked at every time: what a message to it waits for is noted a
// moment after the message is saved (lib/conductor.mjs), and is said where it was sent from.
const woke = new Map();
export const wake = id => { looked.delete(id); woke.set(id, null); };
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
  const out = new Map(); queues.clear();
  for (const row of hosted()) {
    if (now - Date.parse(row.updatedAt ?? row.createdAt) > KEPT_MS) { for (const ext of ['json', 'jsonl']) fs.rmSync(hostFile(row.id, ext), { force: true }); views.delete(row.id); looked.delete(row.id); continue; }
    if (woke.has(row.id)) { if (woke.get(row.id) === null) woke.set(row.id, now); else if (now - woke.get(row.id) > QUIET_LOOK_MS) woke.delete(row.id); }
    if (!woke.has(row.id) && now - Date.parse(row.updatedAt ?? row.createdAt) > QUIET_MS && now - (looked.get(row.id) ?? 0) < QUIET_LOOK_MS) continue;
    looked.set(row.id, now);
    let view; try { view = hostView(row, now, views.get(row.id)); } catch (error) { ctx.log?.(`remote ${row.id.slice(0, 8)}: ${error.message}`); continue; }
    // Only the diff is compared with the next look: the chat is not held here between looks.
    views.set(row.id, { diff: view.diff ?? null });
    // A message that waits with no conductor running starts one, as a teammate's does (replies.mjs).
    if (view.waiting?.some(item => item.state === 'stuck') && now - (ctx.kickedAt ?? 0) > KICK_MS) { ctx.kickedAt = now; ctx.kick?.(); }
    const before = JSON.stringify([row.seq, row.seen, row.taskId, row.diffAt, row.resend]), events = appendEvents(row, diffView(row, view));
    if (events.length) row.updatedAt = new Date(now).toISOString();
    if (JSON.stringify([row.seq, row.seen, row.taskId, row.diffAt, row.resend]) !== before) saveHosted(row);
    if (events.length) out.set(row.machine, [...out.get(row.machine) ?? [], { id: row.id, events, last: row.seq }]);
  }
  for (const [key, items] of out) {
    const session = ctx.session(key);
    if (!session || !bothMine(ctx.me.key, key) || session.remoteHello?.remote !== 1) continue;
    session.notify('elu.remote.events', { items: batch(items) });
  }
}
// The size of an event on the link, and the events that fit one notification or answer: at
// least the first, then those that keep it within BATCH_BYTES.
const bytesOf = event => Buffer.byteLength(JSON.stringify(event));
// One notification stays well under the frame limit. What it does not hold is not sent after
// it: each session says its newest seq (last), and the viewer asks for what it lacks.
function batch(items) {
  let size = 0;
  return items.map(item => {
    const events = [];
    for (const event of item.events) { const length = bytesOf(event); if (size && size + length > BATCH_BYTES) break; events.push(event); size += length; }
    if (events.length < item.events.length) size = Infinity;
    return { id: item.id, events, last: item.last };
  });
}
// The message of a request from my other computer: in the request, or sent ahead of it in
// pieces and named by it (texts.mjs). { text, drop() }: drop() once the message was taken.
function messageOf(params, session) {
  return isObject(params?.longText) ? stagedText(session.key, params.longText) : { text: params?.text, drop() {} };
}
function checkStart(params) {
  if (!isObject(params) || !ID.test(params.id ?? '')) refuse('A session needs an id.');
  if (typeof params.text !== 'string' || !params.text.trim()) refuse('Write the message first.');
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
// A run here that waits to start and has no session yet, such as a schedule's run that waits
// for a free slot, is listed by its request (QREF): r and a hash of the request's id. An ELU
// from before this reads no such row and lists nothing for it.
const QREF = /^[0-9a-f]{16}:r[0-9a-f]{16}$/;
const requestRef = (project, id) => `${project}:r${hash(`request\0${id}`).slice(0, 16)}`;
export const projectKey = root => hash(`project\0${root}`).slice(0, 16);
// The id both machines give a watched session: from the viewer's key, the host's key and the session.
export function watchId(viewer, host, ref) {
  const h = hash(`watch\0${viewer}\0${host}\0${ref}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
// What a run that waits to start is called: a schedule's run takes the name the owner gave its
// latest run (title, lib/schedules.mjs), and anything else the first line of its message (text).
const runTitle = (request, text = request?.goal) => request?.scheduleId && typeof request.title === 'string' && request.title ? request.title : firstLine(String(text ?? ''));
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
// A session such a handoff started carries the id that computer follows it by, so it is one
// session there: its hosted row's, or else the one its handoff record kept (origin.a2aTaskId).
function handoffId(origin) {
  let record = null; try { record = typeof origin.a2aTaskId === 'string' ? getRecord(origin.a2aTaskId) : null; } catch { record = null; }
  return record?.kind === 'handoff' && record.peer === origin.peer && ID.test(record.remoteId ?? '') ? record.remoteId : undefined;
}
function summary(root, project, task, approvals, timed, own = () => false, adopted = new Map(), held = null) {
  // A standup it answered (lib/standup.mjs) is not activity here either.
  const last = Math.max(time(task.activeSince), lastActivity(task));
  const asked = ['running', 'preparing'].includes(task.state) ? approvals.filter(item => String(item.taskId) === String(task.id) && (!item.root || item.root === root)) : [];
  const reply = task.state === 'needs_input' ? task.reply?.outcome === 'needs_input' ? task.reply : task.result : null, origin = task.origin;
  // A message from another computer of the owner's started a session of his own, as one that
  // computer started directly: it lists as mine. Asked on every list, so one started before the
  // two were paired lists as mine once they are. Its mode stays what it was. As his own kind of
  // session or in a mode he picked there (w), it is his (usesSavedRules), and takes his files.
  const handoff = origin?.mine !== true && origin?.kind === 'handoff' && HEX64.test(origin.peer ?? '') && own(origin.peer);
  // A schedule's run names its schedule from its start (scheduleId); one an earlier version
  // started is known only once the schedule has kept its number (lastTaskId).
  const by = origin?.mine === true || handoff ? 'mine' : origin ? 'teammate' : task.botChat ? 'bot' : typeof task.scheduleId === 'string' || timed.some(row => row.root === root && String(row.lastTaskId) === String(task.id)) ? 'schedule' : 'you';
  // named: somebody chose its name (the owner, its Task, the model), which /rename there opens with.
  return { ref: `${project}:${task.id}`, project, title: short(taskTitle(task), 80), ...(task.titleBy ? { named: true } : {}), state: task.state, at: new Date(last || Date.now()).toISOString(), createdAt: typeof task.createdAt === 'string' ? task.createdAt : null,
    question: reply?.question ? short(firstLine(reply.question), 200) : null, error: task.error?.message ? short(remoteError(task), 300) : null, ...(finished(task) ? { finished: true } : {}), plan: task.plan?.state === 'proposed' ? { state: 'proposed', title: short(task.plan.title, 80) } : null,
    approvals: asked.slice(0, 10).map(item => { const kept = keepOffer(item, origin)?.summary; return { id: item.id, role: item.role ?? 'lead', summary: short(item.summary, 200), at: item.at, ...(kept ? { always: short(kept, 200) } : {}) }; }), by, who: by === 'teammate' ? short(origin.name, 40) : by === 'bot' ? short(task.botChat, 30) : null,
    ...(origin?.mine === true ? { from: origin.machine, remoteId: origin.remoteId } : handoff ? { from: origin.peer, remoteId: adopted.get(`${origin.peer}\0${root}\0${task.id}`) ?? handoffId(origin) } : {}),
    // since: where its row in Sessions here counts from (rowSince), so its row there shows the same time. held: the message of the owner's its row here shows.
    since: rowSince(task, { approval: asked[0], request: held }) };
}
// Every session on this computer, newest first, read at most every 2 s.
function hostSessions(now = Date.now()) {
  if (listed && now - listed.at < LIST_CACHE_MS && now >= listed.at) return listed;
  let approvals = [], timed = [];
  try { approvals = pendingApprovals(); } catch { /* None can be read. */ }
  try { timed = listSchedules(); } catch { /* None can be read. */ }
  const projects = [], sessions = [], spent = [];
  const owners = new Map(), own = key => owners.get(key) ?? owners.set(key, pairedMine(key)).get(key);
  // A handoff that computer follows already has an id there (adoptHandoffs): sent with it, so it is one session there.
  // So does a run that computer followed while it waited to start (a watched request, queued): the session it started is that one.
  const rows = hosted(), adopted = new Map(rows.filter(row => row.handoff && row.taskId).map(row => [`${row.machine}\0${row.root}\0${row.taskId}`, row.id]));
  const followed = new Map(rows.filter(row => row.queued && row.taskId).map(row => [`${row.root}\0${row.taskId}`, row])), waiting = rows.filter(row => row.queued && !row.taskId);
  for (const repo of registeredProjects()) {
    let snap; try { snap = projectSnapshot(repo); } catch { continue; }
    const id = projectKey(repo.root);
    spent.push({ root: repo.root, key: id, tasks: snap.tasks, removed: snap.removed ?? [] });
    projects.push({ id, name: short(snap.name, 60), repoId: repoIdOf(repo.root, now), home: path.resolve(repo.root) === path.resolve(os.homedir()) });
    // A teammate's question is answered in its Chats thread there, not as a session. An
    // archived one is listed as archived for the week after its last activity, as any other,
    // and only to a computer that asks for archived sessions (elu.remote.list).
    const kept = [], held = heldBySession(snap.queue);
    // One that started since its watch last looked is known by its request.
    for (const row of waiting) { const request = row.root === repo.root ? snap.queue?.find(value => value.id === row.requestId && value.taskId) : null; if (request) followed.set(`${repo.root}\0${request.taskId}`, row); }
    // standup: false marks one a standup would not ask here (lib/standup.mjs), so the asker leaves it out.
    let board = null; try { board = readBoard(repo); } catch { board = null; }
    for (const task of snap.tasks) {
      if (['ask', 'review'].includes(task.origin?.kind)) continue;
      const archived = snap.closed?.includes(task.id) === true;
      // Only what a viewer shows: what works or waits now, and what changed in the last week. One older leaves the list (gone).
      const row = summary(repo.root, id, task, approvals, timed, own, adopted, held.get(String(task.id))?.[0] ?? null), watcher = !row.from && followed.get(`${repo.root}\0${task.id}`);
      if (watcher) Object.assign(row, { from: watcher.machine, remoteId: watcher.id });
      if (archived) row.archived = true;
      if (archived ? now - time(row.at) < KEPT_MS : ['starting', 'preparing', 'running', 'needs_input'].includes(row.state) || row.plan || row.approvals.length || now - time(row.at) < KEPT_MS) kept.push([task, row]);
    }
    // What waits to start here with no session yet, as Queued lists it here: a schedule's run
    // that waits for a free slot, a bot's chat, a teammate's handoff. Each says what it waits
    // for (lib/waiting.mjs) and its message, so my other computer shows it as this one does.
    // A teammate's question is answered in its Chats thread, and a message to a session is
    // that session's. A standup never asks it.
    for (const request of snap.queue ?? []) {
      if (!['queued', 'starting'].includes(request.state) || request.taskId || request.continuationTaskId != null || request.standupFor || ['ask', 'review'].includes(request.origin?.kind)) continue;
      const at = new Date(time(request.queuedAt ?? request.createdAt) || now).toISOString(), waits = request.state === 'queued' ? waitOf(request, now) : null, from = request.mine ?? null;
      const theirs = request.origin && !(request.origin.kind === 'handoff' && HEX64.test(request.origin.peer ?? '') && own(request.origin.peer));
      const by = from || request.origin && !theirs ? 'mine' : theirs ? 'teammate' : request.botChat ? 'bot' : request.scheduleId ? 'schedule' : 'you', text = String(request.goal ?? '');
      sessions.push({ ref: requestRef(id, request.id), project: id, title: short(runTitle(request), 80), text: short(text.length > HELD_TEXT ? `${text.slice(0, HELD_TEXT)}…` : text, HELD_TEXT + 1), state: 'starting', at, createdAt: typeof request.createdAt === 'string' ? request.createdAt : at,
        question: null, error: null, plan: null, approvals: [], by, who: by === 'teammate' ? short(request.origin.name, 40) : by === 'bot' ? short(request.bot ?? '', 30) || null : null, repoId: null, standup: false, since: { at }, ...(waits ? { waits } : {}),
        ...(from && HEX64.test(from.machine ?? '') && ID.test(from.remoteId ?? '') ? { from: from.machine, remoteId: from.remoteId } : {}) });
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
  // What its agents spent today and this week, for a viewer's Usage tab: every session counts, listed or not.
  let topAgents = null; try { topAgents = topAgentsWire(spent, now); } catch { topAgents = null; }
  listed = { at: now, projects, sessions, topAgents, spent };
  return listed;
}
// The next list is read from the files again (tests, and a session this daemon just changed).
export const relist = () => { listed = null; };
// What a viewer is sent of one: the origin of a session started from it, and from no other machine.
const wireRow = (row, key) => { const { from, remoteId, ...rest } = row; return from === key ? { ...rest, remoteId } : rest; };
const later = (row, after) => row.at < after.at || (row.at === after.at && row.ref > after.ref);
// A message for a hosted session, as typed here: @name first writes to that bot of this computer.
// typed: the owner typed it there himself (lib/terminal-remote.mjs says so), so it starts
// whatever the number of sessions running here. One a session's tool sent there
// (send_to_session), or a build there from before it said so, starts by itself: it waits for
// a slot (enqueue in lib/conductor.mjs).
function deliver(ctx, row, taskId, text, typed = false) {
  const match = /^@([A-Za-z][A-Za-z0-9-]{0,29})(?:\s+([\s\S]*))?$/.exec(text.trim()), bot = match && getBot(match[1].toLowerCase());
  if (bot && !(match[2] ?? '').trim()) refuse(`Write your message after @${bot.name}.`);
  wake(row.id); enqueue(row.root, bot ? match[2].trim() : text.trim(), { continuationTaskId: String(taskId), priority: 0, ...(bot ? { bot: bot.name } : {}), ...(typed ? { typed: true } : {}) }); ctx.kick?.(); ctx.soon?.();
}
// Sends whose files are in, by sender and send, for a last piece sent again.
const landed = new Map(), LANDED_MS = 10 * 60000;
export function hostMethods(ctx) {
  // The lessons run of a clean-up asked from a computer of mine, by that computer's key: one at a time, stopped on request.
  const cleaning = new Map();
  // A run listed while it waits to start (QREF) is watched by its request: its row says what
  // it waits for until its session starts, and is that session from then on (taskOf). What the
  // owner types there goes with its message and starts it (elu.remote.send), and /stop there
  // cancels it (elu.remote.stop).
  function watchRequest(ref, session) {
    const repo = registeredProjects().find(row => projectKey(row.root) === ref.split(':')[0]);
    let request = null; try { request = repo ? pendingRequests(repo.root).find(row => requestRef(projectKey(repo.root), row.id) === ref && ['queued', 'starting', 'running'].includes(row.state)) : null; } catch { request = null; }
    if (!request) refuse('That session is not on this computer.');
    const id = watchId(session.key, ctx.me.key, ref), existing = readRow(hostFile(id)), now = new Date().toISOString();
    if (existing && existing.machine !== session.key) refuse('That session id is taken.');
    saveHosted(existing ? { ...existing, updatedAt: now } : { id, machine: session.key, root: repo.root, requestId: request.id, taskId: request.taskId ? String(request.taskId) : null, ref, watched: true, queued: true, text: short(request.goal, 400), createdAt: now, updatedAt: now, seq: 0, first: 1, seen: {} });
    wake(id); ctx.soon?.();
    return { id, project: projectName(repo.root), title: short(runTitle(request), 80) };
  }
  // A message to a session there that has not started: it goes after the message it waits
  // with, as one typed here into that run goes (lib/terminal.mjs). typed: the owner typed it
  // there, so the run starts now, whatever number of sessions runs here (ownerTyped). A
  // teammate's message, and a message to a session, stay theirs. One for another bot than
  // the run's own cannot go with it.
  function addToWaiting(row, request, params, session) {
    const later = 'This session has not started yet. Send this once it has.';
    if (request?.state === 'starting') refuse('This session is still starting. Send this again in a moment.');
    if (params?.model === true || request?.state !== 'queued' || request.continuationTaskId != null || request.origin) refuse(later);
    const message = messageOf(params, session);
    if (typeof message.text !== 'string' || !message.text.trim()) refuse('Write the message first.');
    const match = /^@([A-Za-z][A-Za-z0-9-]{0,29})(?:\s+([\s\S]*))?$/.exec(message.text.trim()), bot = match && getBot(match[1].toLowerCase());
    if (bot && !(match[2] ?? '').trim()) refuse(`Write your message after @${bot.name}.`);
    if (bot && bot.name !== (request.bot ?? null)) refuse(later);
    const typed = params.typed === true, joined = addToRequest(row.root, request.id, bot ? match[2].trim() : message.text.trim(), { typed });
    if (!joined) refuse('This session is still starting. Send this again in a moment.');
    message.drop(); wake(row.id); ctx.kick?.(); ctx.soon?.();
    return { id: row.id, added: true, ...(typed ? { starts: true } : {}) };
  }
  // The session a rename or an archive from my other computer is about: by its place here
  // (ref), else by the id of a session that computer follows (hostedFor). One that has not
  // started yet has nothing to rename or archive.
  function sessionHere(session, params) {
    if (isObject(params) && QREF.test(params.ref ?? '')) refuse(NOT_STARTED);
    if (isObject(params) && params.ref != null) {
      if (!REF.test(params.ref)) refuse('Choose a session.');
      const [project, taskId] = params.ref.split(':'), repo = registeredProjects().find(row => projectKey(row.root) === project);
      let task = null; try { task = repo ? readTask(repo, taskId) : null; } catch { task = null; }
      if (!task || ['ask', 'review'].includes(task.origin?.kind)) refuse('That session is not on this computer.');
      return { repo, task };
    }
    const row = hostedFor(session, params?.id), { taskId } = taskOf(row), repo = repoOf(row.root);
    if (!taskId || !repo) refuse(NOT_STARTED);
    return { repo, task: readTask(repo, taskId) };
  }
  // What changed is listed at once, and every computer that follows the session is sent it.
  function edited(repo, task) {
    relist();
    for (const row of hosted()) if (row.root === repo.root && String(row.taskId) === String(task.id)) wake(row.id);
    ctx.soon?.();
  }
  return {
    // Every session here, a page at a time. since: the cursor of an earlier answer, for only
    // what changed after it; one from before this daemon started, or older than it remembers
    // what left, lists everything again (full).
    'elu.remote.list': (params, session) => {
      needMine(ctx, session);
      const p = isObject(params) ? params : {}, limit = Number.isSafeInteger(p.limit) && p.limit > 0 ? Math.min(p.limit, LIST_PAGE) : LIST_PAGE;
      const { at, projects, sessions, topAgents: here, spent } = hostSessions();
      // Today is the viewer's: from the start of its day (dayStart), when it says, within a day and a half of this one's.
      const dayStart = Number.isSafeInteger(p.dayStart) && Math.abs(p.dayStart - Date.now()) <= 36 * 3600000 ? p.dayStart : null;
      let topAgents = here; if (dayStart !== null) { try { topAgents = topAgentsWire(spent, Date.now(), dayStart); } catch { topAgents = here; } }
      let since = Number.isSafeInteger(p.since) && p.since >= 0 ? p.since : null;
      const full = since === null || since < SINCE_BOOT || at - since > GONE_KEPT_MS;
      if (full) since = null;
      let rows = full ? sessions : sessions.filter(row => (changed.get(row.ref)?.at ?? 0) > since);
      // archived: the viewer lists archived sessions (ELU 0.1.26 and later). To one from before,
      // an archived session is not listed, and one archived since its cursor left its list.
      const hidden = p.archived === true ? [] : rows.filter(row => row.archived);
      if (hidden.length) rows = rows.filter(row => !row.archived);
      const after = typeof p.after === 'string' && /^[^|]{1,40}\|[0-9a-f]{16}:(?:[0-9]{1,10}|r[0-9a-f]{16})$/.test(p.after) ? { at: p.after.split('|')[0], ref: p.after.split('|')[1] } : null;
      if (after) rows = rows.filter(row => later(row, after));
      const page = rows.slice(0, limit);
      // mineByPeer: each row's by was decided from the key its message came from, so the viewer
      // reads none of them as its own by name (cleanListed).
      return { full, cursor: at, projects, sessions: page.map(row => wireRow(row, session.key)), gone: full ? [] : [...[...left].filter(([, when]) => when > since).map(([ref]) => ref), ...hidden.map(row => row.ref)].slice(0, 1000),
        next: rows.length > limit ? `${page.at(-1).at}|${page.at(-1).ref}` : null, mineByPeer: true, ...(topAgents ? { topAgents } : {}) };
    },
    // Watch one of them: from now on it sends its events as a session started from there does.
    'elu.remote.watch': (params, session) => {
      needMine(ctx, session);
      if (isObject(params) && QREF.test(params.ref ?? '')) return watchRequest(params.ref, session);
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
    // Where a session from my other computer would run here, and, while the home folder is a
    // project here and no team setting decides, the folders it may run in instead (pick).
    'elu.remote.folders': (params, session) => {
      needMine(ctx, session);
      let where = null; try { where = whereFor(ctx.me.key, session.key); } catch { where = null; }
      if (!where) return { pick: false, root: null, project: null, folders: [] };
      const pick = !where.team && where.repos.some(repo => homeOrAbove(repo.root));
      return { pick, root: where.repo.root, project: short(projectName(where.repo.root), 60), folders: pick ? folderChoices(where.repos) : [] };
    },
    // A session from my other computer, in the project of the team we share, as if typed here.
    // folder: the one the owner picked there, from elu.remote.folders.
    'elu.remote.start': (params, session) => {
      needMine(ctx, session);
      // Asked again (its answer was lost), the session it started is named, whatever became of its text.
      const known = isObject(params) && ID.test(params.id ?? '') ? readRow(hostFile(params.id)) : null;
      if (known) { if (known.machine !== session.key) refuse('That session id is taken.'); return { id: known.id, project: projectName(known.root) }; }
      const message = messageOf(params, session), wanted = checkStart({ ...params, text: message.text });
      const repo = params.folder == null ? projectFor(ctx.me.key, session.key) : pickedProject(params.folder);
      const request = enqueue(repo.root, wanted.text, { priority: 0, permissions: wanted.permissions, place: wanted.place, folders: [], bots: wanted.bots, ...(wanted.model ? { model: wanted.model } : {}), mine: { machine: session.key, name: short(ctx.name?.(session.key) ?? session.key.slice(0, 8), 64).replace(/["<>\t\n]/g, '').trim() || session.key.slice(0, 8), remoteId: wanted.id } });
      message.drop();
      const now = new Date().toISOString();
      saveHosted({ id: wanted.id, machine: session.key, root: repo.root, requestId: request.id, taskId: null, text: short(wanted.text, 400), createdAt: now, updatedAt: now, seq: 0, first: 1, seen: {} });
      ctx.event?.(`${called(ctx, session.key)} started a session here`); ctx.kick?.(); ctx.soon?.();
      return { id: wanted.id, project: projectName(repo.root) };
    },
    // A message typed into it there continues it here, as a message typed here would. With
    // model: true (/model NAME there) its first words name a model as this computer knows its
    // own: the session runs on it from this message on, and with no words after the name only
    // the model changes. The answer names the model as it is shown here.
    'elu.remote.send': (params, session) => {
      needMine(ctx, session);
      const row = hostedFor(session, params?.id), { taskId, request } = taskOf(row);
      if (!taskId) return addToWaiting(row, request, params, session);
      const message = messageOf(params, session);
      if (typeof message.text !== 'string' || !message.text.trim()) refuse('Write the message first.');
      // working: it is in a turn now; the sender is told at once, with what that turn does with
      // the message (takes): turn (it reads it at its next step), beside (it takes none, so the
      // message is answered beside it, lib/message-aside.mjs) or soon (the turn is starting).
      let working = false, takes = 'soon';
      try { const task = readTask(repoOf(row.root), taskId); working = ['running', 'preparing'].includes(task.state); if (task.state === 'running') takes = task.activeInbox === true ? 'turn' : task.activeDeaf === true ? 'beside' : 'soon'; } catch { working = false; }
      const typed = params.typed === true;
      if (params.model !== true) { deliver(ctx, row, taskId, message.text, typed); message.drop(); return { id: row.id, ...(working ? { working: true, takes } : {}) }; }
      const repo = repoOf(row.root); if (!repo) refuse('That session is not on this computer.');
      const label = choice => modelLabel(choice, reportedModels(tasks(repo)));
      const take = () => {
        let named; try { named = modelWords(message.text.trim().split(/\s+/), { label }); } catch (error) { refuse(error.message); }
        let text = message.text.trimStart(); for (let word = 0; word < named.count; word += 1) text = text.replace(/^\S+\s*/, '');
        setSessionModel(repo, taskId, named.choice);
        if (text.trim()) deliver(ctx, row, taskId, text, typed);
        message.drop();
        return { id: row.id, model: label(named.choice), sent: Boolean(text.trim()), ...(working && text.trim() ? { working: true, takes } : {}) };
      };
      // A name no list here has yet may be one a vendor's own list names: each list is read
      // beside this program (lib/bot-models.mjs), which is never held for it, and the name is
      // looked for once more.
      try { return take(); } catch (error) {
        if (!/^No model named /.test(error.message)) throw error;
        return readAllModels().then(fresh => { if (!fresh) throw error; return take(); }, () => { throw error; });
      }
    },
    // Files from my other computer for this session, in pieces, with the message they go with
    // on the last piece. They land in the session's inbox, which the session may read in every
    // mode, and the message continues the session as one typed here, each path it named
    // pointing where that file or folder landed. Only a session of the owner's own takes them:
    // a teammate's, such as their handoff accepted here, answers in that teammate's thread, so
    // what it reads would reach him (usesSavedRules says whose it is).
    'elu.remote.files': (params, session) => {
      needMine(ctx, session);
      const row = hostedFor(session, params?.id);
      if (params.last === true && typeof params.text !== 'string' && !isObject(params.longText)) refuse('Write the message as text.');
      const known = landed.get(`${session.key}:${params.send}`);
      // The last piece sent again, its answer lost: the files are in already.
      if (known && params.last === true) return known;
      const { taskId } = taskOf(row), repo = repoOf(row.root);
      if (!taskId || !repo) refuse('This session has not started yet. Send the files once it has.');
      let task = null; try { task = readTask(repo, taskId); } catch { task = null; }
      if (!task || !usesSavedRules(task.origin)) refuse(NOT_OWN_SESSION);
      // Where they would land is checked before the first piece is taken, and again once all are in.
      if (params.seq === 0) checkInbox();
      // A long message with them is read before the last piece is taken, so one that is not here is said first.
      const message = params.last === true ? messageOf(params, session) : null;
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
      const text = [landedText(message.text, got.items, dir).trim(), filesLine(from, got.count, got.bytes, dir)].filter(Boolean).join('\n\n');
      deliver(ctx, row, taskId, text, params.typed === true); message.drop();
      ctx.event?.(`${from} sent ${got.count === 1 ? '1 file' : `${got.count} files`} to a session here`);
      const result = { id: row.id, files: got.count, bytes: got.bytes, dir };
      landed.set(`${session.key}:${params.send}`, result); setTimeout(() => landed.delete(`${session.key}:${params.send}`), LANDED_MS).unref?.();
      return result;
    },
    'elu.remote.stop': (params, session) => {
      needMine(ctx, session);
      const row = hostedFor(session, params?.id), { taskId, request } = taskOf(row);
      // A teammate's message that waits here is theirs: it is cancelled here, where its thread is told.
      if (!taskId && row.queued && request?.origin) refuse("A teammate's message is cancelled on the computer it was sent to.");
      if (!taskId) { if (request && ['queued', 'blocked', 'waiting'].includes(request.state)) removeRequest(row.root, request.id); ctx.soon?.(); return { stopping: Boolean(request) }; }
      const repo = repoOf(row.root), task = repo ? readTask(repo, taskId) : null;
      if (!task || !['running', 'preparing'].includes(task.state)) refuse('That session is not running.');
      // now: the viewer sends what waits there now. A turn that takes its messages and can be
      // told to take one now is told, and goes on (lib/runner.mjs inboxFeed); any other stops.
      if (params?.now === true && task.state === 'running' && task.activeSendNow === true) {
        const bot = botOfKey(task.activeRole ?? '') ?? null, rows = pendingRequests(row.root), waiting = rows.filter(item => item.state === 'queued' && String(item.continuationTaskId) === String(task.id) && typedRequest(item));
        const front = new Set(typedFront(rows, task.id, bot).filter(item => !item.back).map(item => item.id));
        if (waiting.length && waiting.every(item => front.has(item.id))) { wake(row.id); return { stopping: false, now: sendTypedNow(row.root, String(task.id), bot) }; }
      }
      wake(row.id); sendCommand({ type: 'stop', root: row.root, taskId: String(taskId) }); ctx.kick?.();
      return { stopping: true };
    },
    // A session here renamed from my other computer, as /rename and e rename it here
    // (setTitle): the same rule for a name, and an empty one takes the owner's name away.
    // title: the name it chose, or null; titleBy: who chose it; shown: what lists show.
    'elu.remote.rename': (params, session) => {
      needMine(ctx, session);
      if (typeof params?.title !== 'string') refuse('Write the new name.');
      const { repo, task } = sessionHere(session, params), saved = setTitle(repo, String(task.id), params.title);
      edited(repo, saved);
      return { title: saved.title ?? null, titleBy: saved.titleBy ?? null, shown: short(taskTitle(saved), 80) };
    },
    // A session here archived from my other computer, or brought back (archived: false), as
    // /archive, c and u do here: one at work is not archived, and the owner's messages to it
    // that did not run go with it. A new message brings it back, as here.
    'elu.remote.archive': (params, session) => {
      needMine(ctx, session);
      const { repo, task } = sessionHere(session, params), id = String(task.id), shown = short(taskTitle(task), 80);
      if (params?.archived === false) { reopenSession(repo, id); edited(repo, task); return { archived: false, shown }; }
      if (['running', 'preparing'].includes(task.state)) refuse(`"${firstWords(taskTitle(task), 40)}" is running. Stop it first with /stop.`);
      closeSession(repo, id);
      try { for (const request of heldBySession(pendingRequests(repo.root)).get(id) ?? []) if (!request.origin) removeRequest(repo.root, request.id); } catch { /* What did not run stays, as it was. */ }
      edited(repo, task);
      return { archived: true, shown };
    },
    // Archived sessions here deleted for good from my other computer, as x deletes them here
    // (lib/session-delete.mjs), by their place here (refs). check: only what each would lose
    // that is on no remote. learn: first the lessons run here, on the project's model, saved to
    // its context as here (projects.mjs learnArchived); when that does not work, nothing is
    // deleted. The run stops when that computer asks (stop) or its connection closes. keep:
    // work on no remote stays in its folder and on its branch.
    'elu.remote.delete': (params, session) => {
      needMine(ctx, session);
      if (params?.stop === true) { const run = cleaning.get(session.key); run?.abort(); return { stopping: Boolean(run) }; }
      const refs = Array.isArray(params?.refs) ? params.refs : [];
      if (!refs.length || !refs.every(ref => typeof ref === 'string' && REF.test(ref))) refuse('Choose a session.');
      const found = [...new Set(refs)].map(ref => { const { repo, task } = sessionHere(session, { ref }); return { ref, repo, task, shown: short(taskTitle(task), 80) }; });
      for (const row of found) {
        const named = `"${firstWords(taskTitle(row.task), 40)}"`;
        if (['running', 'preparing'].includes(row.task.state)) refuse(`${named} is running. Stop it first with /stop.`);
        let board = null; try { board = readBoard(row.repo); } catch { board = null; }
        if (!board || !sessionClosed(board, row.task)) refuse(`${named} is not archived. Archive it first.`);
      }
      if (params.check === true) return { sessions: found.map(row => ({ ref: row.ref, shown: row.shown, ...unpushedWork(row.repo, row.task) })) };
      const remove = (lines = []) => {
        const deleted = [], failed = [];
        for (const row of found) {
          try { const result = deleteSession(row.repo, String(row.task.id), { keep: params.keep === true }); deleted.push({ ref: row.ref, shown: row.shown, ...(result.kept ? { kept: { branch: short(result.kept.branch ?? '', 200) || null } } : {}) }); }
          catch (error) { failed.push(`"${firstWords(row.shown, 40)}": ${firstLine(error?.message)}`); }
        }
        // What watched a deleted session here goes with it.
        const gone = new Set(found.filter(row => deleted.some(item => item.ref === row.ref)).map(row => `${row.repo.root}\0${row.task.id}`));
        for (const row of hosted()) if (gone.has(`${row.root}\0${row.taskId}`)) for (const ext of ['json', 'jsonl']) fs.rmSync(hostFile(row.id, ext), { force: true });
        relist(); ctx.soon?.();
        return { lines, deleted, failed };
      };
      if (params.learn !== true) return remove();
      if (cleaning.has(session.key)) refuse('A clean-up from that computer is still reading its sessions.');
      const stopper = new AbortController(), closed = () => stopper.abort();
      cleaning.set(session.key, stopper); session.once?.('close', closed);
      return (async () => {
        const lines = [];
        try { for (const root of new Set(found.map(row => row.repo.root))) { const part = found.filter(row => row.repo.root === root); lines.push(...await learnArchived(part[0].repo, part.map(row => String(row.task.id)), { signal: stopper.signal })); } }
        catch (error) { refuse(stopper.signal.aborted ? 'Stopped before the lessons were saved.' : firstLine(error?.message) || 'The lessons run did not work.'); }
        finally { cleaning.delete(session.key); session.off?.('close', closed); }
        return remove(lines);
      })();
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
    // More of the chat: the viewer's owner paged up to the oldest entry it holds, the one at
    // the place before. The next look sends the entries from the place from up to that one,
    // and every look after it starts there.
    // places: the viewer followed this session from before entries said their place (an ELU
    // up to 0.1.19 on either side then): the entries of the next look go out again, with it.
    'elu.remote.older': (params, session) => {
      needMine(ctx, session);
      const row = hostedFor(session, params?.id);
      if (params.places === true) { row.resend = Number.MAX_SAFE_INTEGER; saveHosted(row); wake(row.id); ctx.soon?.(); return { from: row.from ?? null }; }
      if (!Number.isSafeInteger(params.from) || params.from < 1 || !Number.isSafeInteger(params.before) || params.before <= params.from) refuse('Say which entries to show.');
      row.from = Math.min(row.from ?? Infinity, params.from); row.resend = params.before; saveHosted(row);
      wake(row.id); ctx.soon?.();
      return { from: row.from };
    },
    // Catch-up: the events after a seq, as many as fit; more says there are others.
    'elu.remote.since': (params, session) => {
      needMine(ctx, session);
      const row = hostedFor(session, params?.id), after = Number.isSafeInteger(params.after) && params.after >= 0 ? params.after : 0;
      const events = []; let size = 0, more = false;
      for (const event of eventsAfter(row, after)) { const length = bytesOf(event); if (events.length && size + length > BATCH_BYTES) { more = true; break; } events.push(event); size += length; }
      return { id: row.id, events, more, last: row.seq, first: row.first ?? 1 };
    },
  };
}

// ---- Viewer: the machine the owner started the session from ----

const viewed = () => list(peerFile('remote', 'view')).map(id => readRow(viewFile(id))).filter(row => row && ID.test(row.id ?? '') && HEX64.test(row.machine ?? ''));
const saveView = row => { mkdir(peerFile('remote', 'view')); atomic(viewFile(row.id), row); };
const cleanEntry = event => ({ ...(Number.isSafeInteger(event.n) && event.n > 0 ? { n: event.n } : {}), role: short(event.role, 80), at: typeof event.at === 'string' ? event.at : null, text: short(event.text, Infinity), ...(event.lead === true ? { lead: true } : {}), ...(typeof event.bot === 'string' && BOT_NAME.test(event.bot) ? { bot: event.bot } : {}), ...(event.failed === true ? { failed: true } : {}), ...(event.quiet === true ? { quiet: true } : {}), ...(event.shell === true ? { shell: true } : {}), ...(event.during === true ? { during: true } : {}), ...(event.line === true ? { line: true } : {}), ...(event.update === true ? { update: true } : {}), ...(event.beside === true ? { beside: true } : {}), ...entryModel(event) });
// The model and effort that wrote an entry, from a computer whose ELU sends them; one that
// does not read as a model name or an effort is left out.
const entryModel = event => ({ ...(typeof event.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,79}$/.test(event.model) ? { model: event.model } : {}), ...(typeof event.effort === 'string' && /^[a-z]{1,12}$/.test(event.effort) ? { effort: event.effort } : {}) });
const STATES = ['starting', 'preparing', 'running', 'needs_input', 'answered', 'ready', 'unverified', 'blocked', 'stopped', 'gone'];
// An entry joins the ones kept: the newest ENTRIES_KEPT. Once the owner paged up (row.paged)
// none is let go, so what he loaded stays while the chat goes on; earlier entries then arrive
// after later ones, so they are put in time order, and one already here is not kept twice.
// The place of the oldest entry held, 1 when it is the first of the chat or says no place.
export const firstPlace = row => (row?.entries ?? []).reduce((least, entry) => Number.isSafeInteger(entry.n) && entry.n < least ? entry.n : least, Infinity);
function keepEntry(row, entry) {
  // One held without a time is the same entry when it comes again with one (a review from before 0.1.20).
  const held = row.entries ?? [], same = held.findIndex(item => (item.at === entry.at || !item.at) && item.role === entry.role && item.text === entry.text);
  // Sent again, an entry is kept once, and takes the place and the time it now says.
  if (same >= 0) { if (entry.n && held[same].n !== entry.n || entry.at && !held[same].at) row.entries = held.map((item, index) => index === same ? entry : item); return; }
  row.entries = row.paged ? inTimeOrder([...held, entry]) : [...held, entry].slice(-ENTRIES_KEPT);
}
// A session whose work is all committed has finished, and its computer says so (finished). A
// computer on a version up to 0.1.20 stopped such a session for its own commit and sent that
// refusal as its error: here it reads as finished too, never as one to send again. Any other
// error is kept as it came.
const ownCommitRow = row => ownCommitStop(row?.error) ? { ...row, state: 'unverified', error: null, finished: true } : row;
// Where a session's row counts from on its own computer (rowSince, lib/kanban.mjs), as it sent it.
const cleanSince = value => isObject(value) && time(value.at) ? { ...(value.run === true ? { run: true } : {}), at: new Date(time(value.at)).toISOString() } : null;
// One event folded into the session as the viewer keeps it. Every field is checked: the
// other side is my own computer, but what it sends is a model's output.
function apply(row, event) {
  switch (event.type) {
    case 'state':
      // What waits there: how many messages for the working turn (held), or what the next one waits for before it starts (waits).
      { const held = Number.isInteger(event.held) && event.held > 0 ? Math.min(event.held, 999) : 0, waits = cleanWait(event.waits); if (held) row.held = held; else delete row.held; if (waits) row.waits = waits; else delete row.waits; }
      Object.assign(row, { state: STATES.includes(event.state) ? event.state : 'stopped', title: short(event.title ?? row.title, 80), mode: ['ask', 'auto', 'full'].includes(event.mode) ? event.mode : null, place: ['worktree', 'branch', 'here'].includes(event.place) ? event.place : 'worktree',
        bots: Array.isArray(event.bots) ? event.bots.filter(name => typeof name === 'string' && BOT_NAME.test(name)).slice(0, CHAT_BOTS_MAX) : [], activeRole: typeof event.activeRole === 'string' ? short(event.activeRole, 40) : null,
        error: event.error ? short(event.error, 400) : null, question: event.question ? short(event.question, 2000) : null, choices: Array.isArray(event.choices) ? event.choices.slice(0, 8).map(choice => short(choice, 200)) : [],
      });
      if (event.finished === true) row.finished = true; else delete row.finished;
      Object.assign(row, ownCommitRow(row));
      if (typeof event.model === 'string' && event.model) row.model = short(event.model, 40); else delete row.model;
      if (cleanSince(event.since)) row.since = cleanSince(event.since); else delete row.since;
      // How many of its newest rows marked beside were answered beside the turn that works there now.
      if (Number.isSafeInteger(event.beside) && event.beside > 0) row.beside = Math.min(event.beside, ENTRIES_KEPT); else delete row.beside;
      break;
    // An entry or a diff longer than one event carries arrives in several (entry+, diff+): it
    // is kept apart until its last one is here, and only then shown, whole.
    case 'entry':
      delete row.partial;
      if (event.more === true) row.partial = { ...event, text: String(event.text ?? '') };
      else keepEntry(row, cleanEntry(event));
      break;
    case 'entry+':
      if (!row.partial) break;
      row.partial.text += String(event.text ?? '');
      if (event.more !== true) { keepEntry(row, cleanEntry(row.partial)); delete row.partial; }
      break;
    case 'step': row.steps = [...row.steps ?? [], { at: typeof event.at === 'string' ? event.at : null, text: short(event.text, STEP_MAX) }].slice(-STEPS_KEPT); break;
    // A run of the model or a bot there, and each of its steps by its place in the run.
    case 'run': {
      const run = runOf(row, event.run); if (!run) break;
      Object.assign(run, { role: event.role === 'lead' || (typeof event.role === 'string' && event.role.startsWith('bot:') && BOT_NAME.test(event.role.slice(4))) ? event.role : run.role, startedAt: stamp(event.startedAt), at: stamp(event.at), ...(event.stopped === true ? { stopped: true } : {}) });
      if (Number.isSafeInteger(event.count) && event.count >= 0 && event.count < run.steps.length) run.steps.length = event.count;
      // A run there that prints only when it ends, while it works: the name of its program.
      if (typeof event.silent === 'string' && event.silent.trim() && !run.at) run.silent = short(event.silent, 40); else delete run.silent;
      break;
    }
    case 'act': {
      const run = runOf(row, event.run), step = cleanStep(event); if (!run || !step || !Number.isSafeInteger(event.n) || event.n < 0 || event.n > run.steps.length) break;
      run.steps[event.n] = step; break;
    }
    case 'approvals': row.approvals = (Array.isArray(event.list) ? event.list : []).slice(0, 10).filter(item => isObject(item) && /^[A-Za-z0-9_-]{1,160}$/.test(item.id ?? '')).map(item => ({ id: item.id, role: short(item.role ?? 'lead', 40), summary: short(item.summary, 200), at: typeof item.at === 'string' ? item.at : null, ...(typeof item.always === 'string' && item.always.trim() ? { always: short(item.always, 200) } : {}) })); break;
    case 'plan': row.plan = isObject(event.plan) ? cleanPlan(event.plan) : null; break;
    case 'waiting': row.waiting = (Array.isArray(event.list) ? event.list : []).filter(isObject).slice(0, HELD_MAX).map(item => ({ at: typeof item.at === 'string' ? item.at : null, text: short(item.text, HELD_TEXT + 1), state: HELD.includes(item.state) ? item.state : 'queued', ...(item.reason ? { reason: short(item.reason, 300) } : {}), ...(TAKES.includes(item.takes) ? { takes: item.takes } : {}), ...(item.stops === true ? { stops: true } : {}),
      ...(isObject(item.aside) && ASIDE_STATES.includes(item.aside.state) ? { aside: { state: item.aside.state, ...(item.aside.state === 'answered' ? { text: short(item.aside.text, HELD_TEXT + 1), who: short(item.aside.who ?? '', 80), at: stamp(item.aside.at) } : {}), ...(item.aside.state === 'failed' ? { error: short(item.aside.error ?? '', 300) } : {}) } } : {}) })); break;
    case 'diff':
      delete row.partialDiff;
      if (event.more === true) row.partialDiff = { summary: event.summary, patch: String(event.patch ?? '') };
      else row.diff = { summary: short(event.summary, 80), patch: short(event.patch, Infinity) };
      break;
    case 'diff+':
      if (!row.partialDiff) break;
      row.partialDiff.patch += String(event.patch ?? '');
      if (event.more !== true) { row.diff = { summary: short(row.partialDiff.summary, 80), patch: short(row.partialDiff.patch, Infinity) }; delete row.partialDiff; }
      break;
    default: break;
  }
}
function cleanPlan(plan) {
  const words = (value, max) => short(value ?? '', max);
  return { title: words(plan.title, 80), description: words(plan.description, 2000), goal: words(plan.goal, 500), objectives: (Array.isArray(plan.objectives) ? plan.objectives : []).slice(0, 8).map(text => words(text, 300)),
    priority: words(plan.priority, 10), severity: words(plan.severity, 10), state: ['proposed', 'approved', 'rejected', 'done'].includes(plan.state) ? plan.state : 'proposed',
    // Who let its work start when the owner's own yes did not: a schedule, a handoff, or the session's mode.
    ...(['schedule', 'handoff'].includes(plan.startedBy) ? { startedBy: plan.startedBy } : {}), ...(approvesTasks(plan.approvedBy) ? { approvedBy: plan.approvedBy } : {}),
    subtasks: (Array.isArray(plan.subtasks) ? plan.subtasks : []).slice(0, 30).map(step => ({ text: words(step?.text, 200), state: ['todo', 'doing', 'done'].includes(step?.state) ? step.state : 'todo' })),
    met: (Array.isArray(plan.met) ? plan.met : []).filter(Number.isInteger).slice(0, 8), proposedAt: stamp(plan.proposedAt), rejectedAt: stamp(plan.rejectedAt),
    // From a build before success criteria and estimates: none, read as not set.
    approvedAt: stamp(plan.approvedAt), doneAt: stamp(plan.doneAt), criteria: (Array.isArray(plan.criteria) ? plan.criteria : []).slice(0, 8).map(text => words(text, 200)).filter(Boolean),
    estimateMinutes: readMinutes(plan.estimateMinutes), etaMinutes: readMinutes(plan.etaMinutes, { zero: true }), etaAt: stamp(plan.etaAt) };
}
const stamp = value => typeof value === 'string' && value.length <= 40 ? value : null;
// The run a run or act event names, made when it is new; the newest RUNS_KEPT are kept.
function runOf(row, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return null;
  row.runs = Array.isArray(row.runs) ? row.runs : [];
  let run = row.runs.find(item => item.run === id);
  if (!run) { run = { run: id, role: 'lead', startedAt: null, at: null, steps: [] }; row.runs = [...row.runs, run].slice(-RUNS_KEPT); }
  return run;
}
const STEP_KINDS = ['thinking', 'tool', 'text', 'plan', 'background'], STEP_STATES = ['running', 'ok', 'failed', 'stopped'], PLAN_STATES = ['todo', 'doing', 'done'];
const count = value => Number.isSafeInteger(value) && value >= 0;
function cleanStep(event) {
  if (!STEP_KINDS.includes(event.kind)) return null;
  return { kind: event.kind, text: short(event.text, Infinity), ...(STEP_STATES.includes(event.status) ? { status: event.status } : {}), ...(event.note ? { note: short(event.note, 40) } : {}), ...(event.sub === true ? { sub: true } : {}),
    ...(event.kind === 'plan' ? { entries: (Array.isArray(event.entries) ? event.entries : []).slice(0, PLAN_MAX).filter(isObject).map(entry => ({ text: short(entry.text, 400), state: PLAN_STATES.includes(entry.state) ? entry.state : 'todo' })) } : {}),
    ...(count(event.since) ? { since: event.since } : {}), ...(count(event.seconds) ? { seconds: event.seconds } : {}),
    ...(count(event.tokens) ? { tokens: event.tokens, ...(event.live === true ? { live: true } : {}) } : {}),
    ...(event.kind === 'background' ? { count: count(event.count) && event.count > 0 ? event.count : 1, ...(event.tasks === true ? { tasks: true } : {}) } : {}) };
}
// Events in seq order. A gap means some were missed: the rest waits for a catch-up.
// over: a watch made again (rewatch), whose events start over: what the view showed stays
// until its first event comes, and then gives way to what that computer sends.
function take(row, events, { first = null } = {}) {
  let changed = false;
  // The older events are gone there: what was half here is dropped with them.
  if (Number.isSafeInteger(first) && first > row.seq + 1) { row.seq = first - 1; delete row.partial; delete row.partialDiff; changed = true; }
  for (const event of [...events].filter(isObject).sort((a, b) => a.seq - b.seq)) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= row.seq) continue;
    if (event.seq !== row.seq + 1) { row.behind = true; break; }
    if (row.over) delete row.waiting;
    if (row.over) { Object.assign(row, { entries: [], steps: [], approvals: [], plan: null, diff: null }); delete row.over; }
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
        // row here yet: it gets one, and catches up from its first event. So does a watch whose
        // view here was let go while that computer still sends its events: it keeps the place
        // its computer listed, so it stays the one session listed there.
        const existing = readRow(viewFile(item.id)), listed = existing ? null : listedAs(session.key, item.id);
        const row = existing ?? (viewed().length < VIEWS_MAX ? { id: item.id, machine: session.key, createdAt: listed?.createdAt ?? new Date().toISOString(), seq: 0, state: listed?.state ?? 'starting', title: listed?.title || 'Your handoff', text: '', project: listed?.project ?? null, entries: [], steps: [], approvals: [], plan: null, diff: null, bots: [], mode: null, ...(listed ? { ref: listed.ref } : { handoff: true }), behind: true } : null);
        if (!row || row.machine !== session.key) continue;
        const changed = take(row, Array.isArray(item.events) ? item.events.slice(0, 2000) : []);
        // The notification did not hold everything that computer has for it: the rest is asked for.
        if (Number.isSafeInteger(item.last) && item.last > row.seq) row.behind = true;
        if (changed || row.behind) saveView(row);
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
// A session started here while its computer was offline (unsent) goes once that computer is
// connected, as it would have then: started there by its id, which a start sent again names
// (elu.remote.start). One that computer refuses keeps the reason here, in place of a session.
// One that could not go for now (busy, no answer in time) goes again a few seconds later.
// Returns when each that went is answered; it never fails.
const UNSENT_RETRY_MS = 5000;
function sendUnsent(ctx, rows, now) {
  ctx.unsending ??= new Set();
  const sends = [];
  for (const row of rows) {
    if (!isObject(row.unsent) || ctx.unsending.has(row.id) || now - (row.unsent.triedAt ?? 0) < UNSENT_RETRY_MS) continue;
    const session = ctx.session(row.machine);
    if (!session || !bothMine(ctx.me.key, row.machine)) continue;
    ctx.unsending.add(row.id);
    const failed = error => { const kept = readRow(viewFile(row.id)); if (!kept?.unsent) return; const { unsent: _unsent, ...rest } = kept; saveView({ ...rest, state: 'blocked', error: short(error, 400) }); };
    sends.push((async () => {
      // A build there from before sessions from other computers cannot take it until it updates.
      if (session.remoteHello?.remote !== 1) return failed(UPDATE(called(ctx, row.machine)));
      const { at: _at, triedAt: _tried, ...start } = row.unsent;
      const result = await ask(ctx, row.machine, 'elu.remote.start', { id: row.id, ...await carried(ctx, row.machine, row.text ?? ''), ...start });
      const kept = readRow(viewFile(row.id)); if (!kept?.unsent) return;
      const { unsent: _unsent, ...rest } = kept;
      saveView({ ...rest, project: short(result?.project, 60) || null, behind: true });
      ctx.event?.(`Your message went to ${called(ctx, row.machine)} now that it is connected`);
    })().catch(error => {
      const busy = !error.details?.rpc || error.details.rpc.code === -32000;
      if (!busy) return failed(error.message);
      const kept = readRow(viewFile(row.id)); if (kept?.unsent) saveView({ ...kept, unsent: { ...kept.unsent, triedAt: Date.now() } });
    }).catch(error => ctx.log?.(`unsent ${row.id.slice(0, 8)}: ${error.message}`)).finally(() => ctx.unsending.delete(row.id)));
  }
  return sends.length ? Promise.all(sends) : null;
}
// Each tick: what waited for its computer to connect, then catch-up.
export function viewTick(ctx, now = Date.now()) {
  const rows = viewed();
  let sending = null; try { sending = sendUnsent(ctx, rows, now); } catch (error) { ctx.log?.(`unsent: ${error.message}`); }
  const caught = catchUp(ctx, rows, now);
  return sending && caught ? Promise.all([sending, caught]) : sending ?? caught;
}
// Catch-up for sessions that missed events: a few at a time, within the budget.
function catchUp(ctx, rows, now) {
  if (ctx.catching) return;
  const due = [];
  for (const row of rows) {
    if (due.length >= 3) break;
    // One not sent yet has nothing there to catch up with.
    if (!row.behind || row.unsent) continue;
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
      // A session the other side no longer has stops asking. A watch that computer let go, of
      // a session it still lists, is made again in place (rewatch). One it no longer lists
      // either (a week with nothing new there) is let go here too: opened again, it is watched again.
      if (/not on this computer/.test(error.message)) {
        const now = readRow(viewFile(row.id));
        if (now?.ref && listedAs(now.machine, now.id)?.ref === now.ref) await rewatch(ctx, now).catch(failed => ctx.log?.(`watch ${row.id.slice(0, 8)}: ${failed.message}`));
        else if (now?.ref) fs.rmSync(viewFile(row.id), { force: true });
        else if (now) { now.behind = false; now.state = 'gone'; now.error = 'That computer no longer has this session.'; saveView(now); }
      }
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
  if (!isObject(row) || !(REF.test(row.ref ?? '') || QREF.test(row.ref ?? '')) || !PROJECT.test(row.project ?? '') || row.ref.split(':')[0] !== row.project) return null;
  // A run there that waits to start, with no session yet (QREF): what it waits for, and its message.
  const queued = QREF.test(row.ref), waits = queued ? cleanWait(row.waits) : null;
  const extra = queued ? { queued: true, text: short(row.text, HELD_TEXT + 1), ...(waits ? { waits } : {}) } : {};
  const at = time(row.at) ? new Date(time(row.at)).toISOString() : null, who = row.who ? short(row.who, 40).replace(/[\s@]+/g, '') || null : null;
  const by = BY.includes(row.by) ? row.by : 'you', mine = by === 'teammate' && Boolean(who) && ours.has(who.toLowerCase());
  return ownCommitRow({ id: watchId(me, key, row.ref), ref: row.ref, project: row.project, title: short(row.title, 80), state: STATES.includes(row.state) ? row.state : 'stopped', ...(row.finished === true ? { finished: true } : {}), at, createdAt: time(row.createdAt) ? new Date(time(row.createdAt)).toISOString() : at,
    question: row.question ? short(row.question, 200) : null, error: row.error ? short(row.error, 300) : null, plan: isObject(row.plan) && row.plan.state === 'proposed' ? { state: 'proposed', title: short(row.plan.title, 80) } : null,
    approvals: (Array.isArray(row.approvals) ? row.approvals : []).slice(0, 10).filter(item => isObject(item) && /^[A-Za-z0-9_-]{1,160}$/.test(item.id ?? '')).map(item => ({ id: item.id, role: short(item.role ?? 'lead', 40), summary: short(item.summary, 200), at: typeof item.at === 'string' ? item.at : null, ...(typeof item.always === 'string' && item.always.trim() ? { always: short(item.always, 200) } : {}) })),
    by: mine ? 'mine' : by, who: mine ? null : who, repoId: HEX64.test(row.repoId ?? '') ? row.repoId : null, ...(ID.test(row.remoteId ?? '') ? { remoteId: row.remoteId } : {}), ...(row.standup === false || queued ? { standup: false } : {}), ...(cleanSince(row.since) ? { since: cleanSince(row.since) } : {}),
    ...(row.archived === true && !queued ? { archived: true } : {}), ...(row.named === true && !queued ? { named: true } : {}), ...extra });
}
const cleanProject = row => isObject(row) && PROJECT.test(row.id ?? '') ? { id: row.id, name: short(row.name, 60) || row.id.slice(0, 6), repoId: HEX64.test(row.repoId ?? '') ? row.repoId : null, home: row.home === true } : null;
// One page of one computer's list. The pages of one list are kept in ctx.paging until the
// last: a full answer then replaces what is kept; any other is merged.
async function listOne(ctx, key, kept, now) {
  const session = ctx.session(key);
  const state = ctx.paging.get(key) ?? { full: !Number.isSafeInteger(kept.cursor) || !kept.fullAt, since: kept.cursor, after: null, pages: 0, whole: false, cursor: null, projects: kept.projects ?? [], got: [], gone: [] };
  state.at = now;
  // dayStart: the start of today here, so its top agents today are of this computer's day.
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  // archived: its archived sessions too, which /archived lists here; a build from before them sends none.
  const result = await session.request('elu.remote.list', { since: state.full ? null : state.since, after: state.after, limit: 100, dayStart: dayStart.getTime(), archived: true });
  if (!isObject(result)) { ctx.paging.delete(key); return; }
  if (state.pages === 0) { state.whole = result.full === true || state.full; state.cursor = Number.isSafeInteger(result.cursor) ? result.cursor : null; }
  if (Array.isArray(result.projects)) state.projects = result.projects.slice(0, 200).map(cleanProject).filter(Boolean);
  // Its top agents, on every page; a build from before it sent them sends none (null).
  state.topAgents = cleanTopAgents(result.topAgents, ref => watchId(ctx.me.key, key, ref));
  const ours = result.mineByPeer === true ? new Set() : ownNames(ctx.me.key, [ctx.me.name, ...mineRows().filter(row => bothMine(ctx.me.key, row.key)).map(row => ctx.name?.(row.key))]);
  state.got.push(...(Array.isArray(result.sessions) ? result.sessions.slice(0, 100) : []).map(row => cleanListed(ctx.me.key, key, row, ours)).filter(Boolean));
  state.gone.push(...(Array.isArray(result.gone) ? result.gone.filter(ref => REF.test(ref ?? '') || QREF.test(ref ?? '')).slice(0, 1000) : []));
  state.pages++; state.after = typeof result.next === 'string' && result.next.length <= 80 ? result.next : null;
  if (state.after && state.pages < PAGES) { ctx.paging.set(key, state); return; }
  ctx.paging.delete(key);
  const now2 = readRow(machineFile(key)) ?? kept, mine = new Map(state.whole ? [] : (now2.sessions ?? []).map(row => [row.ref, row]));
  for (const ref of state.gone) mine.delete(ref);
  for (const row of state.got) mine.set(row.ref, row);
  const sessions = [...mine.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, LISTED_MAX);
  // edit: its hello says it renames, archives and unarchives its sessions from here.
  saveMachine({ key, listedAt: new Date(now).toISOString(), cursor: state.cursor, fullAt: state.whole ? now : kept.fullAt ?? 0, older: false, error: null, projects: state.projects, sessions, standup: session.remoteHello?.standup === 1, edit: session.remoteHello?.edit === 1, clean: session.remoteHello?.clean === 1, topAgents: state.topAgents ?? null });
  placeListed(key, sessions, state.projects);
  listedAhead(key, sessions, now);
}
// One session as a computer of mine last listed it, by the id both machines give it or the
// one a handoff from here has (remoteId), with its project's name:
// { ref, project, title, state, createdAt }, or null.
function listedAs(key, id) {
  const kept = readRow(machineFile(key)), row = (kept?.sessions ?? []).find(item => item.id === id || item.remoteId === id);
  if (!row?.ref) return null;
  const project = (kept.projects ?? []).find(item => item.id === row.project)?.name ?? null;
  return { ref: row.ref, project, title: row.title ?? null, state: row.state ?? null, createdAt: row.createdAt ?? null };
}
// A view here with no place there whose id is a listed session's (a watch its events made
// again here, or a handoff from here, by its remoteId) takes that place: commands, catch-ups
// and Sessions then treat it as that session.
function placeListed(key, sessions, projects) {
  const byId = new Map(sessions.map(row => [row.id, row])), byRemote = new Map(sessions.filter(row => row.remoteId).map(row => [row.remoteId, row]));
  for (const row of viewed()) {
    const item = row.machine === key && !row.ref ? byId.get(row.id) ?? (row.handoff ? byRemote.get(row.id) : null) : null;
    if (!item?.ref) continue;
    const now = readRow(viewFile(row.id)); if (!now || now.ref) continue;
    now.ref = item.ref; now.project ??= projects.find(project => project.id === item.project)?.name ?? null; delete now.handoff;
    saveView(now);
  }
}
// A view whose listing shows a change more than 2 minutes after its last event has events on
// their way (a session quiet there for 10 minutes is looked at every 30 s, and listed every 3 s,
// so the listing often shows its next change first), missed events it never saw a gap for (a
// notification lost on the way, refused, or cut from its batch), or its watch there was let go
// (a week with nothing new), so that computer sends it nothing more.
// Either way the view is kept and catches up (viewTick): the events it missed, or, of a watch
// let go, the whole session again from the watch made again in place. checkedAt: the listed
// change that asked last, so one change asks once, also when it sent no event.
function listedAhead(key, sessions, now) {
  const at = new Map(sessions.map(row => [row.ref, time(row.at)]));
  for (const row of viewed()) {
    if (row.machine !== key || !row.ref || row.behind || !at.has(row.ref)) continue;
    const listed = at.get(row.ref);
    if (!(listed > Math.max(time(row.lastAt), time(row.watchedAt)) + STALE_MS && listed > time(row.checkedAt) && now - time(row.watchedAt) > STALE_MS)) continue;
    const kept = readRow(viewFile(row.id)); if (!kept || kept.behind) continue;
    saveView({ ...kept, behind: true, checkedAt: new Date(listed).toISOString() });
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
  if (!HEX64.test(key ?? '') || !(REF.test(ref ?? '') || QREF.test(ref ?? ''))) refuse('Choose a session.');
  const id = watchId(ctx.me.key, key, ref), existing = readRow(viewFile(id));
  if (existing && existing.machine === key) return existing;
  if (cursor && ctx.session(key) && used(ctx, key).length >= BUDGET_WATCH) refuse(`${called(ctx, key)} is busy. It opens in a moment.`);
  const result = await ask(ctx, key, 'elu.remote.watch', { ref });
  if (result?.id !== id) refuse(`${called(ctx, key)} answered for another session.`);
  const listedRow = (readRow(machineFile(key))?.sessions ?? []).find(row => row.ref === ref);
  // A run that waits to start there keeps its message and what it waits for, as listed, until its events say more.
  const queued = QREF.test(ref) ? { queued: true, text: listedRow?.text ?? '', ...(listedRow?.waits ? { waits: listedRow.waits } : {}) } : {};
  const row = { id, machine: key, ref, createdAt: listedRow?.createdAt ?? new Date().toISOString(), watchedAt: new Date().toISOString(), seq: 0, state: listedRow?.state ?? 'stopped', title: short(result.title, 80) || listedRow?.title || 'Session', project: short(result.project, 60) || null, entries: [], steps: [], approvals: listedRow?.approvals ?? [], plan: null, diff: null, bots: [], mode: null, behind: true, ...queued };
  saveView(row);
  return row;
}
// A watch that computer let go (a week with nothing new there) is made again in place, under
// the same id: its events start over there, so the view here starts over too (over, in take),
// with its place, title and project kept, and catches up from its first event. That computer
// answering "not on this computer" to the watch itself means the session is gone there: only
// then does its view here go.
async function rewatch(ctx, row) {
  let result;
  try { result = await ask(ctx, row.machine, 'elu.remote.watch', { ref: row.ref }); }
  catch (error) { if (/not on this computer/.test(error.message)) fs.rmSync(viewFile(row.id), { force: true }); throw error; }
  if (result?.id !== row.id) refuse(`${called(ctx, row.machine)} answered for another session.`);
  const kept = readRow(viewFile(row.id)) ?? row;
  const again = { ...kept, watchedAt: new Date().toISOString(), seq: 0, title: short(result.title, 80) || kept.title || 'Session', project: short(result.project, 60) || kept.project || null, behind: true, over: true };
  saveView(again);
  return again;
}
// The session a command is about: one this machine has a view of, by id, or one of a computer of mine by its ref.
const target = (ctx, command) => command.ref != null ? watched(ctx, command.to, command.ref) : viewOf(command.id);
// A command about one session, sent to its computer. A watch that computer let go is made
// again once, in place (rewatch), and the command sent again: "not on this computer" then
// means it really is gone.
async function onSession(ctx, command, method, params = {}) {
  const row = await target(ctx, command);
  try { return { row, result: await ask(ctx, row.machine, method, { id: row.id, ...params }) }; }
  catch (error) {
    if (!row.ref || !/not on this computer/.test(error.message)) throw error;
    const again = await rewatch(ctx, row);
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
  // What to type there names this machine as that one shows it: by its box name, else its owner's.
  if (!bothMine(ctx.me.key, key)) refuse(`${WAITING(name)} On it, run /mine @${String(ctx.boxName?.() || ctx.me.name || '').replace(/[\s@]+/g, '') || ctx.me.fingerprint}.`);
  // A model's name goes with a message only to a computer whose hello says it reads one: nothing is sent to an older one.
  if (method === 'elu.remote.send' && params?.model && session.remoteHello?.model !== 1) refuse(MODEL_UPDATE(name));
  // A rename or an archive goes only to a computer whose hello says it does them (ELU 0.1.26 and later).
  const edit = method === 'elu.remote.rename' ? 'rename' : method === 'elu.remote.archive' ? params?.archived === false ? 'unarchive' : 'archive' : method === 'elu.remote.delete' ? 'delete' : null;
  // Deleting archived sessions there needs a hello that says it deletes them (clean).
  if (edit && session.remoteHello?.[edit === 'delete' ? 'clean' : 'edit'] !== 1) refuse(EDIT_UPDATE(name, edit));
  // What the owner does is never held back, but it counts: the lists and catch-ups wait for it.
  used(ctx, key).push(Date.now());
  try { return await session.request(method, params, options); }
  catch (error) {
    if (error.details?.rpc?.code === -32601) refuse(method === 'elu.remote.files' ? FILES_UPDATE(name) : method === 'elu.text.put' ? LONG_UPDATE(name) : edit ? EDIT_UPDATE(name, edit) : UPDATE(name));
    throw new EluCodeError(`${name}: ${error.message}`, error.details);
  }
}
// The pieces of one send, paced within what this machine asks that computer on its own: a
// piece waits while the lists, catch-ups and watches of the last 10 s used their share, and
// one the other side found too many at once is sent again shortly.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function piece(ctx, key, method, params) {
  for (let tries = 0; ; tries++) {
    for (let waited = 0; used(ctx, key).length >= BUDGET_WATCH && waited < 30000; waited += 250) await pause(250);
    try { return await ask(ctx, key, method, params, { timeoutMs: 60000 }); }
    catch (error) {
      const busy = error.details?.rpc?.code === -32000 || /Too many requests|still on their way/.test(error.message) || error.details?.timeout === true;
      if (busy && tries < 8) { await pause(1000 * (tries + 1)); continue; }
      throw error;
    }
  }
}
// A message as its request carries it: { text }, or for one too long for one line on the link
// { longText: { id, size, sha256 } } once its pieces are there (elu.text.put, texts.mjs). It is
// never cut to fit: a computer that cannot take the pieces is said to need an update.
async function carried(ctx, key, text) {
  if (!longText(text)) return { text };
  const bytes = Buffer.from(text, 'utf8'), id = crypto.randomUUID(), sha256 = hash(bytes), count = Math.ceil(bytes.length / PIECE);
  for (let seq = 0; seq < count; seq++) await piece(ctx, key, 'elu.text.put', { id, seq, last: seq === count - 1, size: bytes.length, sha256, data: bytes.subarray(seq * PIECE, (seq + 1) * PIECE).toString('base64') });
  return { longText: { id, size: bytes.length, sha256 } };
}
async function sendFiles(ctx, row, staged, text, typed = false) {
  const key = row.machine, session = ctx.session(key), name = called(ctx, key);
  // A computer of mine on a build from before files says so in its hello: nothing is sent to it.
  if (session && session.remoteHello?.remote === 1 && session.remoteHello?.files !== 1) refuse(FILES_UPDATE(name));
  const send = crypto.randomUUID(), last = Math.max(0, Math.ceil(staged.total / PIECE) - 1);
  let seq = 0, result = null;
  for (const data of pieces(staged)) {
    // The message goes on the last piece; a long one is sent ahead of it, once the files are there.
    result = await piece(ctx, key, 'elu.remote.files', { id: row.id, send, seq, last: seq === last, size: staged.total, data: data.toString('base64'), ...(seq === last ? { ...await carried(ctx, key, text), ...(typed ? { typed: true } : {}) } : {}) });
    seq++;
  }
  return result;
}
const viewOf = id => { const row = ID.test(id ?? '') ? readRow(viewFile(id)) : null; if (!row) refuse('That session is gone.'); return row; };
// A rename or an archive of one session of a computer of mine (to): by its place there (ref),
// else, for one started from here that it has not listed yet, by the id both machines give it.
// Nothing is watched for it. What that computer answers is written here at once, in its list
// and in the chat followed here, so Sessions shows it before the next listing.
async function editThere(ctx, command) {
  const known = ID.test(command.id ?? '') ? readRow(viewFile(command.id)) : null;
  const key = HEX64.test(command.to ?? '') ? command.to : known?.machine, ref = command.ref != null ? command.ref : known?.ref ?? null;
  if (!HEX64.test(key ?? '')) refuse('Choose a session.');
  // One kept here until that computer connects, or that waits to start there, has nothing there yet.
  if (known?.unsent || QREF.test(ref ?? '')) refuse(NOT_STARTED);
  if (ref != null && !REF.test(ref)) refuse('Choose a session.');
  if (ref == null && !known) refuse('That session is gone.');
  const where = ref != null ? { ref } : { id: known.id };
  if (command.type === 'remoteRename') {
    if (typeof command.title !== 'string' || command.title.length > 4000) refuse('Write the new name.');
    const result = await ask(ctx, key, 'elu.remote.rename', { ...where, title: command.title });
    const title = typeof result?.title === 'string' ? short(result.title, 80) || null : null, shown = short(result?.shown, 80) || title || null;
    noteEdit(ctx, key, ref, known?.id, row => ({ ...row, ...(shown ? { title: shown } : {}), named: Boolean(title) }));
    return { title, titleBy: ['owner', 'task', 'model'].includes(result?.titleBy) ? result.titleBy : null, shown };
  }
  const archived = command.archived !== false, result = await ask(ctx, key, 'elu.remote.archive', { ...where, archived });
  const shown = short(result?.shown, 80) || null;
  noteEdit(ctx, key, ref, known?.id, row => ({ ...row, archived }));
  return { archived, shown };
}
// The longest a request may wait (setTimeout's limit): a lessons run takes as long as the
// model does, and it ends with the connection all the same.
const LONGEST = 2 ** 31 - 1;
// Archived sessions of a computer of mine deleted for good there (elu.remote.delete), by their
// place there (refs). check: what each would lose; stop: its lessons run there stops. What is
// deleted there leaves this computer's list of it at once, and so does its chat followed here.
async function cleanThere(ctx, command) {
  const key = command.to;
  if (!HEX64.test(key ?? '')) refuse('Choose a session.');
  if (command.stop === true) return ask(ctx, key, 'elu.remote.delete', { stop: true });
  const refs = Array.isArray(command.refs) ? command.refs : [];
  if (!refs.length || !refs.every(ref => typeof ref === 'string' && REF.test(ref))) refuse('Choose a session.');
  if (command.check === true) {
    const result = await ask(ctx, key, 'elu.remote.delete', { refs, check: true });
    return { sessions: (Array.isArray(result?.sessions) ? result.sessions : []).filter(row => isObject(row) && REF.test(row.ref ?? '')).map(row => ({ ref: row.ref, shown: short(row.shown, 80), commits: Number.isSafeInteger(row.commits) && row.commits > 0 ? row.commits : 0, edits: Number.isSafeInteger(row.edits) && row.edits > 0 ? row.edits : 0 })) };
  }
  const learn = command.learn === true, result = await ask(ctx, key, 'elu.remote.delete', { refs, keep: command.keep === true, learn }, { timeoutMs: learn ? LONGEST : 60000 });
  const deleted = (Array.isArray(result?.deleted) ? result.deleted : []).filter(row => isObject(row) && refs.includes(row.ref)).map(row => ({ ref: row.ref, shown: short(row.shown, 80), ...(isObject(row.kept) ? { kept: { branch: short(row.kept.branch, 200) || null } } : {}) }));
  const gone = new Set(deleted.map(row => row.ref)), kept = readRow(machineFile(key));
  if (kept && (kept.sessions ?? []).some(row => gone.has(row.ref))) saveMachine({ ...kept, sessions: kept.sessions.filter(row => !gone.has(row.ref)) });
  for (const ref of gone) fs.rmSync(viewFile(watchId(ctx.me.key, key, ref)), { force: true });
  const lines = value => (Array.isArray(value) ? value : []).filter(line => typeof line === 'string').map(line => short(line, 600));
  return { lines: lines(result?.lines), deleted, failed: lines(result?.failed) };
}
// change(row): the session as this computer now holds it, in its computer's list (by ref) and
// in the chat followed here (by id). named and archived are kept only when true, as listed.
function noteEdit(ctx, key, ref, id, change) {
  const tidy = row => { const out = change(row); for (const field of ['named', 'archived']) if (out[field] !== true) delete out[field]; return out; };
  const kept = ref ? readRow(machineFile(key)) : null;
  if (kept && (kept.sessions ?? []).some(row => row.ref === ref)) saveMachine({ ...kept, sessions: kept.sessions.map(row => row.ref === ref ? tidy(row) : row) });
  const view = readRow(viewFile(id ?? (ref ? watchId(ctx.me.key, key, ref) : '')));
  if (view && view.machine === key) { const { title } = tidy({ title: view.title }); saveView({ ...view, ...(title ? { title } : {}) }); }
}
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
      if (typeof command.text !== 'string' || !command.text.trim()) refuse('Write the message first.');
      const id = crypto.randomUUID(), now = new Date().toISOString();
      const row = { id, machine: command.to, createdAt: now, seq: 0, state: 'starting', title: short(firstLine(command.text), 80), text: short(command.text, Infinity), project: null, entries: [], steps: [], approvals: [], plan: null, diff: null, bots: Array.isArray(command.bots) ? command.bots.filter(name => typeof name === 'string' && BOT_NAME.test(name)) : [], mode: command.permissions ?? null };
      // Checked here first, so a refusal leaves no row behind. folder: the one the owner picked
      // from remoteFolders; with none, the start is what an older build there expects.
      if (command.folder != null && !FOLDER.test(command.folder)) refuse(PICK_LISTED);
      const start = { permissions: command.permissions, place: command.place ?? null, model: command.model ?? null, bots: command.bots ?? [], ...(command.folder != null ? { folder: command.folder } : {}) };
      // A computer of mine that is offline gets it as soon as it connects (sendUnsent), as a
      // message to it in Chats does: the session is kept here until then (unsent).
      if (!ctx.session(command.to) && markedMine(command.to) && bothMine(ctx.me.key, command.to)) { saveView({ ...row, unsent: { ...start, at: now } }); return { id, project: null, unsent: true }; }
      await ask(ctx, command.to, 'elu.remote.start', { id, ...await carried(ctx, command.to, command.text), ...start }).then(result => { row.project = short(result?.project, 60) || null; });
      // What it sent before this row existed is caught up at once.
      saveView({ ...row, behind: true });
      return { id, project: row.project };
    }
    // Where a new session would run on that computer, and the folders the owner may pick from
    // (elu.remote.folders). A build from before the choice is not asked: it starts as it did.
    case 'remoteFolders': {
      if (!HEX64.test(command.to ?? '')) refuse('Choose one of your computers.');
      const session = ctx.session(command.to);
      if (session?.remoteHello?.remote === 1 && session.remoteHello.folders !== 1) return { pick: false, root: null, project: null, folders: [], older: true };
      const result = await ask(ctx, command.to, 'elu.remote.folders', {});
      const root = FOLDER.test(result?.root ?? '') ? result.root : null;
      const folders = (Array.isArray(result?.folders) ? result.folders : []).filter(row => isObject(row) && FOLDER.test(row.path ?? '')).map(row => ({ path: row.path, label: short(row.label, 200) || row.path, name: short(row.name, 60), project: row.project === true }));
      return { pick: result?.pick === true && folders.length > 0, root, project: short(result?.project, 60) || null, folders };
    }
    case 'remoteWatch': { const row = await watched(ctx, command.to, command.ref, { cursor: command.cursor === true }); return { id: row.id }; }
    // model: true when the text starts with a model's name; that computer says which model it took it for.
    // typed: true when the owner typed it in the app here; it is said there with the message (deliver).
    case 'remoteSend': {
      if (typeof command.text !== 'string' || !command.text.trim()) refuse('Write the message first.');
      // A long message goes ahead in pieces to the session's computer, which the request then names.
      const at = await target(ctx, command);
      // One not sent yet, its computer offline: this goes with its message, as soon as it connects.
      if (at.unsent && command.model !== true) { const kept = readRow(viewFile(at.id)); if (kept?.unsent) { saveView({ ...kept, text: `${kept.text ?? ''}\n\n${command.text.trim()}` }); return { id: kept.id, added: true, unsent: true }; } }
      const { row, result } = await onSession(ctx, command, 'elu.remote.send', { ...await carried(ctx, at.machine, command.text), ...(command.model === true ? { model: true } : {}), ...(command.typed === true ? { typed: true } : {}) });
      // added: it went with the message of a run that had not started there; starts: that run starts now.
      return { id: row.id, ...(command.model === true ? { model: short(result?.model, 60) || 'that model', sent: result?.sent === true } : {}), ...(result?.working === true ? { working: true, ...(['turn', 'beside', 'soon'].includes(result.takes) ? { takes: result.takes } : {}) } : {}), ...(result?.added === true ? { added: true, ...(result.starts === true ? { starts: true } : {}) } : {}) };
    }
    // Files staged by the app or a session's tool (files.mjs), with a message or none.
    case 'remoteFiles': {
      const text = typeof command.text === 'string' ? command.text : '';
      const staged = stagedFiles(command.files);
      try {
        let row = await target(ctx, command), result;
        try { result = await sendFiles(ctx, row, staged, text, command.typed === true); }
        catch (error) {
          // A watch that computer let go is made again once, in place, as for any command.
          if (!row.ref || !/not on this computer/.test(error.message)) throw error;
          row = await rewatch(ctx, row);
          result = await sendFiles(ctx, row, staged, text, command.typed === true);
        }
        return { id: row.id, files: Number.isSafeInteger(result?.files) ? result.files : staged.count, bytes: Number.isSafeInteger(result?.bytes) ? result.bytes : staged.bytes };
      } finally { dropOutgoingFiles(staged.set); }
    }
    case 'remoteStop': {
      // One not sent yet is never sent: it leaves this list, and nothing reaches its computer.
      const kept = command.id != null && command.ref == null && ID.test(command.id) ? readRow(viewFile(command.id)) : null;
      if (kept?.unsent) { fs.rmSync(viewFile(kept.id), { force: true }); return { stopping: false, cancelled: true }; }
      return (await onSession(ctx, command, 'elu.remote.stop', command.now === true ? { now: true } : {})).result;
    }
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
      // A read takes every update whole, the parts of a long one joined (readWhole in standup.mjs).
      if (command.type === 'remoteStandupRead') return readWhole(params => ask(ctx, command.to, method, params), { key: command.to, round: command.round, id: 'ref', only: Array.isArray(command.refs) ? command.refs : null });
      return ask(ctx, command.to, method, { round: command.round, ...(Array.isArray(command.refs) ? { refs: command.refs } : {}), ...(command.type === 'remoteStandup' && typeof command.question === 'string' ? { question: command.question } : {}) });
    }
    // The owner paged up to the oldest entry kept here: its computer is asked for a page of
    // the ones before it. This machine lets none go from now on, set before they arrive.
    case 'remoteOlder': {
      const held = viewOf(command.id), before = firstPlace(held);
      // Entries from before they said their place: its computer is asked to say them, once it can.
      if (!Number.isFinite(before) && (held.entries ?? []).length >= FIRST_LOOK) { await onSession(ctx, command, 'elu.remote.older', { places: true }); return { places: true }; }
      if (!Number.isFinite(before) || before <= 1) return { from: null };
      const from = Math.max(1, before - OLDER_PAGE);
      saveView({ ...held, paged: true });
      await onSession(ctx, command, 'elu.remote.older', { from, before });
      return { from };
    }
    // Takes it out of this machine's Sessions. It keeps running, and stays, on the other computer.
    case 'remoteForget': { const row = viewOf(command.id); fs.rmSync(viewFile(row.id), { force: true }); return { id: row.id }; }
    // /rename, /archive, e, c and u on a session of my other computer: done there, by that
    // computer's own code (elu.remote.rename, elu.remote.archive), and shown here at once.
    case 'remoteRename': case 'remoteArchive': return editThere(ctx, command);
    // x on archived sessions of my other computer: deleted there, by that computer's own code.
    case 'remoteClean': return cleanThere(ctx, command);
    default: refuse('Unknown peer command.');
  }
}
export const REMOTE_COMMANDS = ['mine', 'unmine', 'remoteStart', 'remoteFolders', 'remoteWatch', 'remoteSend', 'remoteFiles', 'remoteStop', 'remoteAnswer', 'remoteTask', 'remoteOlder', 'remoteForget', 'remoteStandup', 'remoteStandupRead', 'remoteStandupStop', 'remoteRename', 'remoteArchive', 'remoteClean'];

// ---- Reads for the app and the CLI (files only) ----

// The sessions started from here on my other computers, newest first.
export function remoteSessions() {
  return viewed().map(ownCommitRow).sort((a, b) => String(b.lastAt ?? b.createdAt).localeCompare(String(a.lastAt ?? a.createdAt)));
}
// Each computer of mine as it last listed its sessions: {key, listedAt, older, projects, sessions, topAgents}.
export function remoteMachines() {
  return list(peerFile('remote', 'machines'), HEX64).map(key => readRow(machineFile(key))).filter(row => row && HEX64.test(row.key ?? '')).map(row => Array.isArray(row.sessions) ? { ...row, sessions: row.sessions.map(ownCommitRow) } : row);
}
export { mineRows };
