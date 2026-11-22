import fs from 'node:fs';
import path from 'node:path';
import { atomic, isObject, mkdir, noSymlinks, personalDirectory, readJson, refuse } from './util.mjs';
import { lock, readTask, taskDir, taskTitle } from './state.mjs';
import { lastActivity, readBoard, sessionClosed } from './kanban.mjs';
import { pendingRequests } from './workspace.mjs';
import { pendingApprovals } from './approvals.mjs';
import { botOversees, listBots } from './bots.mjs';
import { isPeerRun } from './modes.mjs';
import { usesSavedRules } from './permission-rules.mjs';
import { readSettings } from './orchestrator-settings.mjs';
import { LEVEL_FULL } from './orchestrator-seams.mjs';
import { isMyComputer } from './peer/my-computers.mjs';
import { remoteMachines } from './peer/remote.mjs';
import { computers } from './peer/session-tools.mjs';
import { WAKE_HEAD } from './elu-sent.mjs';
import { unreviewedLines } from './pull-reviews.mjs';

// The Orchestrator wakes by itself (the bot that oversees the owner's sessions, at the Full
// level, lib/orchestrator-settings.mjs). Below Full it runs when the owner writes to it, or on a
// schedule he gives it (lib/bot-schedules.mjs, which skips a run when nothing changed). At Full
// it also takes a turn of its own whenever one of the owner's sessions, on this computer or on a
// computer paired as his (lib/peer/my-computers.mjs isMyComputer):
//   - finishes a turn (turn);
//   - asks a question (asks), waits for its Task to be approved (task) or for a permission (approval);
//   - stops on an error (error) or is stopped (stopped);
//   - has been working with no log activity for IDLE_MS (idle).
// ELU reads its own records for it, with no model call: this computer's session records and the
// lists the paired computers keep here (lib/peer/remote.mjs remoteMachines). The conductor looks
// every WAKE_LOOK_MS (lib/long-work.mjs) and so does the peer daemon (lib/peer/daemon.mjs), the
// one for this computer's sessions and the other for those on his other computers.
//
// What changed is kept per session, newest first, until the Orchestrator's own chat can take a
// turn: one message (wakeText) lists each session once with its newest event. It is sent at most
// once every WAKE_GAP_MS, never while its chat works or has a message waiting, and only into the
// chat the owner already talks to it in here (lib/bot-schedules.mjs botChatSession): a computer
// where he never opened that chat wakes nothing, so his two computers do not both act on the same
// session. What its chat's last turn could read already (an event older than that turn's start)
// is dropped. The message is ELU's, never the owner's (lib/elu-sent.mjs WAKE_HEAD).
//
// Never: its own chat, any bot's own chat, a Standup, a teammate's session or his question (a
// session the owner's own computers did not start, lib/permission-rules.mjs usesSavedRules), an
// archived session, or a session whose record did not change since the last look (one it just
// wrote to with nothing new there). A session seen for the first time is only counted, unless it
// was made after this check first ran here: an update never wakes it for old sessions.
//
// <personal>/orchestrator/wake.json = { version: 1, since, seen: { key: { word, mark, at } },
//   pending: { key: { word, label, detail, at, root, id, computer } }, wokeAt, wakes }
// It is under the Orchestrator's own folder, which its own turns may not write.

export const IDLE_MS = 15 * 60000;
export const WAKE_GAP_MS = 5 * 60000;
export const WAKE_LOOK_MS = 20000;
export const WAKE_SESSIONS_MOST = 12;
// An event that waited this long for a chat that could take it is dropped.
export const PENDING_KEPT_MS = 6 * 3600000;
// A session not seen for this long leaves the file.
const SEEN_KEPT_MS = 30 * 86400000;
export const WAKE_EVENTS = Object.freeze({
  turn: 'finished a turn',
  asks: 'asks a question',
  task: 'waits for its Task to be approved',
  approval: 'waits for a permission',
  error: 'stopped on an error',
  stopped: 'was stopped',
  idle: `has been working with no log activity for ${IDLE_MS / 60000} minutes`,
  unreviewed: 'has work a bot could not review',
});
const WORKING = ['running', 'preparing', 'queued', 'starting'];

const time = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : 0; };
const iso = ms => new Date(ms).toISOString();
const short = (value, most) => { const line = String(value ?? '').split('\n').find(part => part.trim())?.trim().replace(/\s+/g, ' ') ?? ''; return line.length > most ? `${line.slice(0, most - 1)}…` : line; };

// Tests keep ELU's folder in a temporary place.
function folder() {
  if (process.env.NODE_TEST_CONTEXT && !process.env.XDG_CONFIG_HOME) refuse("A test must set XDG_CONFIG_HOME before it uses the orchestrator's wake: the owner's own are never a test's to read or write.");
  return path.join(personalDirectory(), 'orchestrator');
}
export const wakeFile = () => path.join(folder(), 'wake.json');
export function readWake() {
  try {
    const file = wakeFile(); noSymlinks(file);
    const value = fs.existsSync(file) ? readJson(file) : null;
    if (isObject(value) && value.version === 1) return { version: 1, since: typeof value.since === 'string' ? value.since : null, seen: isObject(value.seen) ? value.seen : {}, pending: isObject(value.pending) ? value.pending : {}, wokeAt: typeof value.wokeAt === 'string' ? value.wokeAt : null, wakes: Number.isSafeInteger(value.wakes) ? value.wakes : 0 };
  } catch { /* Started again. */ }
  return { version: 1, since: null, seen: {}, pending: {}, wokeAt: null, wakes: 0 };
}

// ---------------------------------------------------------------------------------------
// Where a session stands, as a word and a mark: two looks with the same mark mean nothing
// happened there. working has no event; every other word is one when its mark is new.

// A session of this computer: slim, what its record says (slimOf); approvals, the permission
// requests that wait for it now; logAt, when its active log last grew.
export function localWord(slim, { approvals = [], logAt = 0, now = Date.now(), idleMs = IDLE_MS } = {}) {
  const turns = `${slim.runs}:${slim.last}`;
  if (slim.plan?.state === 'proposed') return { word: 'task', mark: `task:${turns}`, detail: short(slim.plan.title, 120) };
  if (approvals.length) return { word: 'approval', mark: `approval:${approvals.map(row => row.id).sort().join(',')}`, detail: short(approvals[0].summary, 120) };
  if (slim.state === 'needs_input') return { word: 'asks', mark: `asks:${turns}`, detail: short(slim.question, 160) };
  if (WORKING.includes(slim.state)) {
    const from = Math.max(logAt || 0, time(slim.activeSince), slim.last);
    return now - from >= idleMs ? { word: 'idle', mark: `idle:${from}`, detail: '' } : { word: 'working', mark: 'working', detail: '' };
  }
  if (slim.error) return /\b(?:stopped|aborted)\b/i.test(slim.error) || slim.state === 'stopped' ? { word: 'stopped', mark: `stopped:${turns}`, detail: short(slim.error, 160) } : { word: 'error', mark: `error:${turns}`, detail: short(slim.error, 160) };
  // A bot could not review its work (lib/pull-reviews.mjs unreviewedLines): each turn that ends so says which, and why.
  if (slim.unreviewed?.length) return { word: 'unreviewed', mark: `unreviewed:${turns}:${slim.unreviewed.join('|').slice(0, 400)}`, detail: short(slim.unreviewed.join('; '), 200) };
  return { word: 'turn', mark: `turn:${turns}`, detail: '' };
}
// A session on another computer, as that computer listed it here (lib/peer/remote.mjs summary).
// Its log is not here: working with no new activity on its record for idleMs is idle.
export function remoteWord(row, { now = Date.now(), idleMs = IDLE_MS } = {}) {
  const at = time(row.at);
  if (row.plan?.state === 'proposed') return { word: 'task', mark: `task:${at}`, detail: short(row.plan.title, 120) };
  const approvals = Array.isArray(row.approvals) ? row.approvals.filter(isObject) : [];
  if (approvals.length) return { word: 'approval', mark: `approval:${approvals.map(item => item.id).sort().join(',')}`, detail: short(approvals[0].summary, 120) };
  if (row.question) return { word: 'asks', mark: `asks:${at}`, detail: short(row.question, 160) };
  const jobs = Array.isArray(row.jobs) ? row.jobs.length : 0;
  if (row.queued || WORKING.includes(row.state) || jobs) return !jobs && !row.queued && now - at >= idleMs ? { word: 'idle', mark: `idle:${at}`, detail: '' } : { word: 'working', mark: 'working', detail: '' };
  if (row.kept) return { word: 'stopped', mark: `kept:${at}`, detail: 'ELU stopped starting it: its last turns made no progress' };
  if (row.error) return ['stopped', 'gone'].includes(row.state) ? { word: 'stopped', mark: `stopped:${at}`, detail: short(row.error, 160) } : { word: 'error', mark: `error:${at}`, detail: short(row.error, 160) };
  if (['stopped', 'gone'].includes(row.state)) return { word: 'stopped', mark: `stopped:${at}`, detail: '' };
  const unreviewed = Array.isArray(row.unreviewed) ? row.unreviewed.filter(line => typeof line === 'string') : [];
  if (unreviewed.length) return { word: 'unreviewed', mark: `unreviewed:${at}:${unreviewed.join('|').slice(0, 400)}`, detail: short(unreviewed.join('; '), 200) };
  return { word: 'turn', mark: `turn:${at}:${row.state ?? ''}`, detail: '' };
}
// What a look needs of a session record: read again only when it changed.
export function slimOf(task) {
  const question = task.state === 'needs_input' ? (task.reply?.outcome === 'needs_input' ? task.reply.question : task.result?.question) ?? null : null;
  return { id: String(task.id), state: task.state ?? null, origin: task.origin ?? null, botChat: task.botChat ?? null, standup: Boolean(task.standup), title: short(taskTitle(task), 80),
    plan: task.plan?.state === 'proposed' ? { state: 'proposed', title: short(task.plan.title, 120) } : null, runs: Array.isArray(task.runs) ? task.runs.length : 0, last: lastActivity(task),
    activeLog: typeof task.activeLog === 'string' ? task.activeLog : null, activeSince: task.activeSince ?? null, error: task.error?.message ? String(task.error.message) : null, question,
    runAt: Math.max(0, ...(Array.isArray(task.runs) ? task.runs : []).map(run => time(run?.at))), unreviewed: unreviewedLines(task).slice(0, 4) };
}
// Whether the Orchestrator wakes for this session at all: one of the owner's own, not a chat
// with a bot (its own among them) and not a Standup. Read at each look: a computer he unpairs
// makes the sessions it started a teammate's again.
export const wakesFor = slim => !slim.botChat && !slim.standup && !isPeerRun(slim.origin) && usesSavedRules(slim.origin);

// ---------------------------------------------------------------------------------------
// The look.

// What this process read of each session record, by its folder: { sig, slim }.
const cache = new Map();
const stamp = files => files.map(file => { try { const stat = fs.statSync(file); return `${stat.ino}:${stat.size}:${stat.mtimeMs}`; } catch { return '-'; } }).join('|');
const logTime = file => { if (!file) return 0; try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
function localSessions(repo) {
  const tasks = path.join(repo.state, 'tasks'); noSymlinks(tasks);
  const ids = fs.existsSync(tasks) ? fs.readdirSync(tasks).filter(id => /^[1-9][0-9]*$/.test(id)) : [], rows = [];
  for (const id of ids) {
    const dir = taskDir(repo, id), sig = stamp(['task.json', 'settings.json'].map(name => path.join(dir, name)));
    let hit = cache.get(dir);
    if (!hit || hit.sig !== sig) { try { hit = { sig, slim: slimOf(readTask(repo, id)) }; } catch { continue; } if (cache.size > 20000) cache.clear(); cache.set(dir, hit); }
    rows.push(hit.slim);
  }
  return rows;
}
// Each change of this look: [{ key, word, label, detail, at, root?, id?, computer? }], and the
// marks seen, written into state.seen. first: the session is new to the file; it counts only
// when it was made after the check first ran here (since).
// A mark that holds keeps its time, renewed once a day, so a look that finds nothing new writes nothing.
const DAY_MS = 86400000;
function note(state, key, now, seen, changes, describe) {
  const before = isObject(state.seen[key]) ? state.seen[key] : null, first = !before, { word, mark, detail, made } = seen;
  if (before?.mark === mark && now - time(before.at) < DAY_MS) return;
  state.seen[key] = { word, mark, at: iso(now) };
  if (word === 'working' || before?.mark === mark) return;
  if (first && !(made > time(state.since))) return;
  changes.push({ key, word, detail, at: iso(now), ...describe() });
}
// For a test: machines, names (lib/peer/session-tools.mjs computers), mine (isMyComputer), approvals (pendingApprovals).
export function lookChanges(state, { projects = () => [], machines = remoteMachines, names = computers, mine = isMyComputer, approvals: waiting = pendingApprovals, local = true, remote = true, now = Date.now(), idleMs = IDLE_MS } = {}) {
  const changes = [];
  if (local) {
    let repos = []; try { repos = projects(); } catch { repos = []; }
    let approvals = []; try { approvals = waiting() ?? []; } catch { approvals = []; }
    for (const repo of repos) {
      let rows = []; try { rows = localSessions(repo); } catch { continue; }
      let board;
      const closed = slim => { if (board === undefined) { try { board = readBoard(repo); } catch { board = null; } } return Boolean(board) && sessionClosed(board, { id: slim.id, state: slim.state, createdAt: null, runs: [{ at: iso(slim.last) }], messages: [] }); };
      for (const slim of rows) {
        if (!wakesFor(slim)) continue;
        const key = `here:${repo.root}:${slim.id}`, asked = approvals.filter(row => String(row.taskId) === slim.id && (!row.root || row.root === repo.root));
        const at = localWord(slim, { approvals: asked, logAt: WORKING.includes(slim.state) ? logTime(slim.activeLog) : 0, now, idleMs });
        const before = changes.length;
        note(state, key, now, { ...at, made: slim.last }, changes, () => ({ label: `#${slim.id} in ${path.basename(repo.root)} on this computer "${slim.title}"`, root: repo.root, id: slim.id }));
        // An archived session is counted, never told.
        if (changes.length > before && closed(slim)) changes.pop();
      }
    }
  }
  if (remote) {
    let listed = []; try { listed = machines() ?? []; } catch { listed = []; }
    let named = new Map(); try { named = new Map(names().map(row => [row.key, row.name])); } catch { named = new Map(); }
    for (const machine of listed) {
      let his = false; try { his = typeof machine.key === 'string' && mine(machine.key) === true; } catch { his = false; }
      if (!isObject(machine) || machine.older || !his) continue;
      const projectNames = new Map((Array.isArray(machine.projects) ? machine.projects : []).filter(isObject).map(row => [row.id, row.name]));
      for (const row of Array.isArray(machine.sessions) ? machine.sessions : []) {
        if (!isObject(row) || typeof row.ref !== 'string' || row.archived === true || ['teammate', 'bot'].includes(row.by)) continue;
        const n = row.ref.split(':')[1] ?? '', key = `${machine.key}:${row.ref}`, at = remoteWord(row, { now, idleMs });
        note(state, key, now, { ...at, made: Math.max(time(row.createdAt), time(row.at)) }, changes, () => ({ label: `#${n || '(not started)'} in ${short(projectNames.get(row.project), 40) || 'a project'} on @${named.get(machine.key) ?? machine.key.slice(0, 8)} "${short(row.title, 80)}"`, computer: machine.key }));
      }
    }
  }
  return changes;
}

// The chat the owner talks to the Orchestrator in here: its newest open one, in any project.
// { repo, bot, slim } or null.
function orchestratorChat(repos) {
  let bots = []; try { bots = listBots().filter(botOversees); } catch { return null; }
  let best = null;
  for (const repo of repos) {
    let rows = []; try { rows = localSessions(repo); } catch { continue; }
    const chats = rows.filter(slim => bots.some(bot => bot.name === slim.botChat));
    if (!chats.length) continue;
    let board = null; try { board = readBoard(repo); } catch { board = null; }
    for (const slim of chats) {
      if (board && sessionClosed(board, { id: slim.id, state: slim.state, createdAt: null, runs: [{ at: iso(slim.last) }], messages: [] })) continue;
      if (!best || slim.last > best.slim.last) best = { repo, bot: bots.find(bot => bot.name === slim.botChat), slim };
    }
  }
  return best;
}
// Whether its chat is at work or has a message waiting: then no wake goes.
function chatBusy(chat) {
  if (WORKING.includes(chat.slim.state)) return true;
  let rows = []; try { rows = pendingRequests(chat.repo.root); } catch { return true; }
  return rows.some(row => String(row.continuationTaskId ?? '') === chat.slim.id && !['done', 'failed'].includes(row.state));
}
// The message, one line per session, the newest event first.
export function wakeText(events, now = Date.now()) {
  const rows = [...events].sort((a, b) => time(b.at) - time(a.at)), shown = rows.slice(0, WAKE_SESSIONS_MOST);
  const clock = at => new Date(time(at) || now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const lines = shown.map(row => `- ${row.label}: ${WAKE_EVENTS[row.word] ?? row.word}${row.detail ? `: ${row.detail}` : ''} (${clock(row.at)})`);
  const more = rows.length - shown.length;
  return [`${WAKE_HEAD(rows.length)}`, ...lines, ...(more > 0 ? [`- and ${more} more`] : []),
    'Read each of them now (session_read; session_log or session_agents when you need more), then act for the owner as your level allows: answer, approve, tell its agents what to do next, update its task, start, stop or archive. Tell him in one short line only what needs him.'].join('\n');
}
// One look: what changed goes into pending, and when the chat can take it, one wake goes.
// Returns { changed, woke }. enqueue: lib/conductor.mjs enqueue; start: starts the conductor
// for it (the daemon's look; the conductor's own needs none).
export function lookWake({ enqueue, projects = () => [], start = null, now = Date.now(), local = true, remote = true, gapMs = WAKE_GAP_MS, idleMs = IDLE_MS, level, ...seams } = {}) {
  let release = null; try { mkdir(folder()); release = lock({ state: folder() }, 'wake'); } catch { return { changed: 0, woke: false }; }
  try {
    const state = readWake(), before = JSON.stringify(state);
    state.since ??= iso(now);
    const changes = lookChanges(state, { projects, local, remote, now, idleMs, ...Object.fromEntries(['machines', 'names', 'mine', 'approvals'].filter(name => typeof seams[name] === 'function').map(name => [name, seams[name]])) });
    let full = false; try { full = (level ?? readSettings().level) === LEVEL_FULL; } catch { full = false; }
    // Below Full only the marks are kept, so a level raised later tells only what changes after.
    if (!full) state.pending = {};
    else for (const change of changes) state.pending[change.key] = change;
    for (const [key, row] of Object.entries(state.pending)) if (!isObject(row) || now - time(row.at) > PENDING_KEPT_MS) delete state.pending[key];
    for (const [key, row] of Object.entries(state.seen)) if (!isObject(row) || now - time(row.at) > SEEN_KEPT_MS) delete state.seen[key];
    let woke = false;
    if (full && Object.keys(state.pending).length && now - time(state.wokeAt) >= gapMs && typeof enqueue === 'function') {
      let repos = []; try { repos = projects(); } catch { repos = []; }
      const chat = orchestratorChat(repos);
      if (chat?.bot && !chatBusy(chat)) {
        // What its chat's last turn started after could be read there already.
        for (const [key, row] of Object.entries(state.pending)) if (time(row.at) <= chat.slim.runAt) delete state.pending[key];
        const events = Object.values(state.pending);
        if (events.length) {
          try {
            enqueue(chat.repo.root, wakeText(events, now), { continuationTaskId: chat.slim.id, priority: 1, bot: chat.bot.name });
            state.pending = {}; state.wokeAt = iso(now); state.wakes += 1; woke = true;
          } catch { /* Kept for the next look. */ }
        }
      }
    }
    if (JSON.stringify(state) !== before) atomic(wakeFile(), state);
    if (woke && typeof start === 'function') { try { start(); } catch { /* The next queued message starts it. */ } }
    return { changed: changes.length, woke };
  } finally { release(); }
}
