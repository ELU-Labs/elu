import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomic, hash, mkdir, noSymlinks, personalDirectory, readJson, refuse } from './util.mjs';
import { waitLock, requestGoal, requestTitle, taskTitle } from './state.mjs';
import { botWork, getBot } from './bots.mjs';
import { finished, plainState, stateText } from './task-head.mjs';
import { reopenTask } from './plan.mjs';
import { columns, cut, head } from './width.mjs';
import { endJobs, jobsDir } from './jobs.mjs';

// One Kanban board per project. Cards you write wait in To do; a started card follows
// its session (In progress while the lead works, Needs you when it stops), and Done
// is where you put finished work: a session that ended waits under Needs you until the
// owner checks it (approveDone). Sessions typed elsewhere appear on the board too.
// The board lives with the project's sessions, not in its files, so it is never
// committed by accident.

export const COLUMNS = Object.freeze([['todo', 'To do'], ['progress', 'In progress'], ['needs', 'Needs you'], ['done', 'Done']]);
const QUIET_DAYS = 14;
const file = repo => path.join(repo.state, 'kanban.json');
const time = value => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; };
const firstLine = value => String(value ?? '').split('\n').find(line => line.trim())?.trim() ?? '';

// When this computer first waited for the owner's check before Done, in ms: written once, by
// the first build that waits. A session that went to Done by itself before then stays there
// when it was quiet for 14 days by then (sessionColumn). A stamp that does not read counts from
// when it was written; with none that can be read or written, nothing goes to Done by itself (0).
const sinceFiles = new Map();
export function checksSince() {
  let target = null;
  try {
    target = path.join(personalDirectory(), 'kanban-checks.json');
    const saved = sinceFiles.get(target); if (saved) return saved;
    const read = () => { try { noSymlinks(target); const at = Date.parse(readJson(target)?.since ?? ''); return Number.isFinite(at) ? at : null; } catch { return null; } };
    let at = read();
    if (at === null) {
      mkdir(path.dirname(target));
      try { fs.writeFileSync(target, `${JSON.stringify({ since: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      at = read();
    }
    if (at === null) { try { noSymlinks(target); at = fs.statSync(target).mtimeMs || null; } catch { at = null; } }
    if (at !== null) sinceFiles.set(target, at);
    return at ?? 0;
  } catch { return 0; }
}
// What a Standup's model moved to Done on this board while it still could (ELU 0.1.25 let it;
// lib/standup-kanban.mjs keeps each move beside its Standup session): when, by card id or
// session:N. Only the owner moves anything to Done now, so such a move is not his check
// (movedByModel). Read again only when the board changed, from the Standups of every project here.
const MOVED = /^Moved '.*' to Done$/s, movesRead = new Map();
function modelMoves(repo, stamp) {
  const kept = movesRead.get(repo.state); if (kept?.stamp === stamp) return kept.moves;
  const moves = {}, key = hash(`standup-board\0${repo.root}`).slice(0, 12), states = [repo.state];
  try { const list = path.join(personalDirectory(), 'projects.json'); noSymlinks(list); const rows = readJson(list); if (Array.isArray(rows)) for (const row of rows) if (typeof row?.common === 'string') states.push(path.join(row.common, 'elu-code')); } catch { /* This project's own Standups still count. */ }
  for (const state of new Set(states)) {
    let ids = []; try { ids = fs.readdirSync(path.join(state, 'tasks')).filter(id => /^[1-9][0-9]*$/.test(id)); } catch { continue; }
    for (const id of ids) {
      let text = ''; try { const log = path.join(state, 'tasks', id, 'standup-kanban.jsonl'); noSymlinks(log); text = fs.readFileSync(log, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        let row = null; try { row = JSON.parse(line); } catch { continue; }
        const item = typeof row?.card === 'string' ? row.card : typeof row?.session === 'string' ? `session:${row.session}` : null, at = time(row?.at);
        if (row?.board === key && typeof row.text === 'string' && MOVED.test(row.text) && item && at) (moves[item] ??= []).push(at);
      }
    }
  }
  movesRead.set(repo.state, { stamp, moves }); return moves;
}
// A card or a session in Done since at, which a Standup's model moved there and the owner never
// checked: the move was then. One older than the 14 days before this computer waited for his
// check stays in Done, as one that went there by itself (sessionColumn).
const movedByModel = (board, item, at) => Boolean(at) && !(board.since && at < board.since - QUIET_DAYS * 86400000) && (board.moved?.[item] ?? []).some(moved => Math.abs(moved - at) < 60000);
export function readBoard(repo) {
  const target = file(repo); noSymlinks(target);
  if (!fs.existsSync(target)) return { cards: [], done: [], closed: {}, archived: [], checked: {}, since: checksSince() };
  const value = readJson(target);
  let moved = {}; try { moved = modelMoves(repo, fs.statSync(target).mtimeMs); } catch { moved = {}; }
  const closed = value?.closed && typeof value.closed === 'object' && !Array.isArray(value.closed) ? Object.fromEntries(Object.entries(value.closed).filter(([, at]) => typeof at === 'string')) : {};
  const checked = value?.checked && typeof value.checked === 'object' && !Array.isArray(value.checked) ? Object.fromEntries(Object.entries(value.checked).filter(([, at]) => typeof at === 'string')) : {};
  return {
    cards: Array.isArray(value?.cards) ? value.cards.filter(card => typeof card?.id === 'string' && typeof card.text === 'string' && ['todo', 'started', 'done'].includes(card.column)) : [],
    done: Array.isArray(value?.done) ? value.done.filter(id => typeof id === 'string') : [],
    closed,
    // The sessions the owner archived: they leave the board, while a session moved to Done on
    // the board stays in Done. A board saved before this list did not tell the two apart, so
    // every session it closed counts as archived.
    archived: Array.isArray(value?.archived) ? value.archived.filter(id => typeof id === 'string') : Object.keys(closed),
    // When the owner checked a session and moved it to Done himself, by session (approveDone).
    checked,
    since: checksSince(),
    moved,
  };
}
// A standup's question and answer (lib/standup.mjs) are not activity: they leave a session
// where it stood, on the board and in Sessions too.
export const lastActivity = task => Math.max(time(task.createdAt), ...(task.runs ?? []).filter(run => !run.standup).map(run => time(run.at)), ...(task.messages ?? []).filter(row => !row.standup).map(row => time(row.at)));
// The owner's messages to a session that did not run (blocked) or wait for him (saved), by
// session, newest first: the session's row in Sessions shows the newest (lib/board.mjs).
export function heldBySession(queue) {
  const held = new Map();
  for (const request of queue ?? []) {
    if (!['blocked', 'waiting'].includes(request.state) || request.continuationTaskId == null || request.origin && (request.state === 'waiting' || ['ask', 'review'].includes(request.origin.kind))) continue;
    const id = String(request.continuationTaskId);
    held.set(id, [request, ...(held.get(id) ?? [])].sort((a, b) => time(b.createdAt) - time(a.createdAt)));
  }
  return held;
}
// Where a session's row in Sessions counts from, and how: a turn that works counts up from
// its start (run), anything else says how long ago. approval: the approval its turn waits
// on; request: the message of the owner's its row shows (heldBySession). It decides the time
// of a row here (lib/board.mjs), and it is what this computer sends with its list to the
// owner's other computers (lib/peer/remote.mjs), so a row there shows the same time.
export function rowSince(task, { approval = null, request = null } = {}) {
  const live = ['running', 'preparing'].includes(task.state), iso = value => new Date(value).toISOString();
  if (live && approval?.at) return { at: approval.at };
  if (live) return { run: true, at: iso(time(task.activeSince) || time(task.createdAt)) };
  if (request?.createdAt) return { at: request.createdAt };
  return { at: iso(lastActivity(task)) };
}
// An archived session (or one moved to Done) stays closed until it has newer activity: a
// new message opens it again. One a Standup's model moved to Done never was (movedByModel).
export function sessionClosed(board, task) {
  const at = board.done.includes(task.id) ? Date.parse(board.closed?.[task.id] ?? '') : NaN;
  return Number.isFinite(at) && lastActivity(task) <= at && !['running', 'preparing'].includes(task.state) && !movedByModel(board, `session:${task.id}`, at);
}
// Archived: closed, and on the board's archived list. One the owner checked Done is closed too,
// but it is in Done, not archived: /archived never lists it and a clean-up never deletes it.
// A board saved before that list counts every session it closed as archived (readBoard).
export const sessionArchived = (board, task) => (board.archived ?? []).includes(task.id) && sessionClosed(board, task);
// Where a card stands. A started one in Done comes back to its column when its session worked
// since it went there, as a session with no card does (sessionClosed), or when a Standup's model
// moved it there (movedByModel): it waits for the owner's check again. One that never started
// has nothing to check, and stays where it was put.
export function cardColumn(board, card, task = null) {
  if (card.column !== 'done' || !card.requestId && !card.taskId) return card.column;
  const at = time(card.movedAt), worked = Boolean(task) && (['running', 'preparing'].includes(task.state) || lastActivity(task) > at);
  return worked || movedByModel(board, card.id, at) ? 'started' : 'done';
}
export function closeSession(repo, id) {
  // Its long jobs end with it (lib/jobs.mjs).
  try { endJobs(jobsDir(repo, id), { by: 'archive' }); } catch { /* Archived all the same. */ }
  return change(repo, board => { if (!board.done.includes(id)) board.done.push(id); if (!board.archived.includes(id)) board.archived.push(id); board.closed[id] = new Date().toISOString(); return id; });
}
// Brings an archived session back into the list. One the owner had checked Done comes back
// out of Done, as Shift+← brings it (setDone): its Task, which his check made done, is open
// again, and so is a card that followed it into Done.
export function reopenSession(repo, id) {
  let checked = false; try { checked = Boolean(readBoard(repo).checked[id]); } catch { checked = false; }
  if (checked) { try { reopenTask(repo, String(id)); } catch { /* The board still brings it back. */ } }
  return change(repo, board => {
    board.done = board.done.filter(row => row !== id); board.archived = board.archived.filter(row => row !== id); delete board.closed[id];
    if (board.checked[id]) {
      delete board.checked[id];
      for (const card of board.cards) if (card.taskId === id && card.column === 'done') Object.assign(card, { column: 'started', movedAt: new Date().toISOString() });
    }
    return id;
  });
}
// A session deleted for good leaves the board: its Done and archived marks, and every card
// that followed it or one of its messages (requests: their IDs).
export function forgetSession(repo, id, requests = []) {
  return change(repo, board => {
    board.done = board.done.filter(row => row !== id); board.archived = board.archived.filter(row => row !== id); delete board.closed[id];
    const before = board.cards.length; board.cards = board.cards.filter(card => card.taskId !== id && !(card.requestId && requests.includes(card.requestId)));
    return before - board.cards.length;
  });
}
function change(repo, edit) {
  mkdir(repo.state);
  const release = waitLock(repo, 'kanban', 200);
  // since and moved are this computer's, not the board's: they are not written with it.
  try { const { since: _since, moved: _moved, ...board } = readBoard(repo), result = edit(board); if (!Object.keys(board.checked ?? {}).length) delete board.checked; atomic(file(repo), board); return result; }
  finally { release(); }
}
const find = (board, id) => board.cards.find(card => card.id === id) ?? refuse('That card no longer exists.');
const checkText = text => { const value = String(text ?? '').trim(); if (!value) refuse('Write the task first.'); return value; };

// from: where a card a Standup's model added came from (lib/standup-kanban.mjs), such as
// "@billing on @kim"; the card shows it under its title.
export function addCard(repo, text, { from = null } = {}) {
  const value = checkText(text), now = new Date().toISOString(), source = typeof from === 'string' ? from.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  return change(repo, board => { if (board.cards.length >= 500) refuse('Keep at most 500 cards.'); const card = { id: `card-${crypto.randomUUID().slice(0, 8)}`, text: value, column: 'todo', requestId: null, taskId: null, createdAt: now, movedAt: now, ...(source ? { from: source } : {}) }; board.cards.push(card); return card; });
}
export function editCard(repo, id, text) {
  const value = checkText(text);
  return change(repo, board => { const card = find(board, id); if (card.column !== 'todo') refuse('Only a To do task can be edited. Its session has the conversation.'); card.text = value; return card; });
}
// todo: only a card that still waits in To do goes, looked at under the board's own lock: the
// undo of a card the overseeing bot added (lib/orchestrator-actions.mjs), which must never
// take away one the owner has since started or put in Done.
export function removeCard(repo, id, { todo = false } = {}) {
  return change(repo, board => { const card = find(board, id); if (card.column === 'started') refuse('Move it to Done instead. Its session stays in Sessions.'); if (todo && card.column !== 'todo') refuse('That card left To do, so it stays where you put it.'); board.cards = board.cards.filter(value => value !== card); return card; });
}
// A started card remembers the request that started it; its session number arrives later.
export function startCard(repo, id, requestId) {
  return change(repo, board => { const card = find(board, id); if (card.column !== 'todo') refuse('Only a To do task can be started.'); Object.assign(card, { column: 'started', requestId, movedAt: new Date().toISOString() }); return card; });
}
export function linkCards(repo, requests) {
  const board = readBoard(repo);
  const missing = board.cards.filter(card => card.requestId && !card.taskId && requests.some(row => row.id === card.requestId && row.taskId));
  if (!missing.length) return false;
  change(repo, current => { for (const card of current.cards) { const row = card.requestId && !card.taskId && requests.find(value => value.id === card.requestId); if (row?.taskId) card.taskId = String(row.taskId); } });
  return true;
}
// Done and back. A card that never started goes back to To do. Only the owner's own check
// moves a session to Done (approveDone); this moves a card or a session back out of it, and
// its Task, which his check made done, is open again.
export function setDone(repo, item, done) {
  const id = item.card?.taskId ?? item.task?.id ?? null;
  if (!done && id) { try { reopenTask(repo, String(id)); } catch { /* The board still moves it. */ } }
  return change(repo, board => {
    const id = item.card?.taskId ?? item.task?.id ?? null;
    if (id) delete board.checked[id];
    if (item.card) { const card = find(board, item.card.id); card.column = done ? 'done' : card.requestId || card.taskId ? 'started' : 'todo'; card.movedAt = new Date().toISOString(); if (done && id) board.checked[id] = card.movedAt; return card; }
    board.done = board.done.filter(row => row !== item.task.id); board.archived = board.archived.filter(row => row !== item.task.id); delete board.closed[item.task.id];
    if (done) { board.done.push(item.task.id); board.closed[item.task.id] = board.checked[item.task.id] = new Date().toISOString(); }
    return null;
  });
}
// The owner checked a session's goal and objectives and moved it to Done himself: the card
// that follows it, else the session, recorded with when (checked). Nothing else moves one there.
export function approveDone(repo, task) {
  const card = readBoard(repo).cards.find(row => row.taskId === task.id && row.column !== 'todo');
  setDone(repo, card ? { card } : { task }, true);
  return readBoard(repo).checked[task.id] ?? new Date().toISOString();
}

// What went to Done by itself before ELU waited for the owner's check: an answered question,
// a pull request, work its agent committed and pushed.
const wentDone = task => Boolean(task.pr || task.kind === 'conversation' && task.state === 'answered' || finished(task) && task.committed.pushed === true);
// since: when this computer first waited for his check (checksSince).
// How many long jobs of a session still run (lib/jobs.mjs; a snapshot's session carries them as
// jobs): while one does the session is at work, on the board as in the list, and it waits for
// no check until they have ended. One that asks the owner, or whose Task waits for his yes,
// needs him all the same: it is under Needs you here as it is in Sessions (lib/board.mjs).
const jobsRunning = task => Array.isArray(task?.jobs) ? task.jobs.filter(job => job?.state === 'running').length : 0;
function sessionColumn(task, since = Date.now()) {
  if (['running', 'preparing'].includes(task.state)) return 'progress';
  // A Task that waits for the owner's yes needs them, though its session rests as an answer leaves it.
  if (task.plan?.state === 'proposed') return 'needs';
  if (jobsRunning(task)) return task.state === 'needs_input' ? 'needs' : 'progress';
  // One that went to Done by itself and was quiet for 14 days before then stays there.
  if (wentDone(task) && lastActivity(task) < since - QUIET_DAYS * 86400000) return 'done';
  // Every other one that ended waits for the owner to check it.
  return 'needs';
}
const requestColumn = request => ['queued', 'starting', 'running'].includes(request.state) ? 'progress' : 'needs';
// A session that ended waits for the owner's check: not one that works, asks him, or whose Task waits for his yes.
export const waitsCheck = task => Boolean(task) && !['running', 'preparing', 'needs_input'].includes(task.state) && task.plan?.state !== 'proposed' && !jobsRunning(task);
// What a session's card says under Needs you: how it ended, and that it waits for his check.
export const CHECK_IT = 'check it';
export const needsDetail = task => waitsCheck(task) ? `${sessionDetail(task)} · ${CHECK_IT}` : sessionDetail(task);
export function sessionDetail(task) {
  if (task.state === 'running' || task.state === 'preparing') { const bot = botWork(task, { find: getBot }); return bot ? `${bot.agent} ${bot.label}` : task.activeRole && task.activeRole !== 'lead' ? `${task.activeRole} reviewing` : 'working'; }
  if (task.state === 'needs_input') return 'asks you';
  { const jobs = jobsRunning(task); if (jobs) return jobs === 1 ? '1 job running' : `${jobs} jobs running`; }
  if (task.state === 'ready') return 'ready to publish';
  if (task.pr) return 'published';
  return stateText(task);
}
// A session with a Task (lib/plan.mjs) is on the board as that Task: its title, then where
// it stands with the count of what is done, its priority and its severity. Under Needs you
// what the session waits for comes first. A rejected Task leaves the session's own card.
// The title is the model's text, and the screen shows it as typed.
const taskOf = task => task?.plan && task.plan.state !== 'rejected' ? task.plan : null;
function taskStands(plan, short) {
  const steps = plan.subtasks?.length ?? 0, done = (plan.subtasks ?? []).filter(row => row.state === 'done').length, met = plan.met?.length ?? 0, goals = plan.objectives?.length ?? 0;
  if (plan.state === 'proposed') return short ? 'to approve' : 'waits for your approval';
  if (plan.state === 'done') return short ? `done ${met}/${goals}` : `done · ${met} of ${goals} objectives reported met`;
  if (!steps) return short ? 'approved' : 'approved · no subtasks yet';
  return short ? `${done}/${steps}` : `approved · ${done} of ${steps} subtasks done`;
}
// A session in Done ended: its card says how (answered, committed, published, stopped), never
// where its Task stood while it worked, unless that Task was reported done.
const endedTask = (plan, column) => column === 'done' && plan.state !== 'done';
const taskDetail = (plan, task, column) => endedTask(plan, column) ? [sessionDetail(task), plan.priority, plan.severity].filter(Boolean).join(' · ')
  : [column === 'needs' && plan.state !== 'proposed' ? needsDetail(task) : '', taskStands(plan, true), plan.priority, plan.severity].filter(Boolean).join(' · ');
// The whole of it, for the row under the board while the card is selected. One that waits for
// the owner's check says so first, where a narrow screen still shows it.
function taskNote(plan, task, column) {
  const name = taskTitle(task), ended = endedTask(plan, column), doing = ended || plan.state === 'proposed' ? '' : column === 'needs' ? needsDetail(task) : task.state === 'answered' ? '' : sessionDetail(task), first = column === 'needs' && doing && waitsCheck(task);
  return [first ? doing : '', `Task · ${ended ? sessionDetail(task) : taskStands(plan, false)}`, `${plan.priority} priority`, `${plan.severity} severity`, name && name !== plan.title ? `session: ${name}` : '', first ? '' : doing].filter(Boolean).join(' · ');
}
// As much of a Task card's detail as fits beside its title: whole parts from the start,
// never half a word.
export function fitDetail(detail, room) {
  let text = '';
  for (const part of String(detail ?? '').split(' · ')) { const next = text ? `${text} · ${part}` : part; if (columns(next) > room) break; text = next; }
  return text;
}
// A title cut to its room: at a word, unless that leaves more than a third of the room
// empty (a long word after a short one): then inside the word.
function cutTitle(text, room) {
  if (room < 2) return head(text, room);
  const start = head(text, room - 1), space = start.lastIndexOf(' '), words = space > 0 ? start.slice(0, space).trimEnd() : start;
  return `${(columns(words) + 1) * 3 >= room * 2 ? words : start.trimEnd()}…`;
}
// A Task's card in the width its column has, the title first. Whole parts of the detail go
// beside the whole title as far as they fit, and a title that fits is never cut for them.
// Only a title longer than the width is cut: the first part stays beside it while the title
// keeps at least three fifths of the width, and otherwise the title has the line to itself.
export function fitCard(title, detail, width) {
  const text = String(title ?? '').replace(/\s/g, ' ').trimEnd();
  if (columns(text) <= width) return { title: text, detail: fitDetail(detail, width - columns(text) - 2) };
  const first = String(detail ?? '').split(' · ')[0], room = width - columns(first) - 2;
  return first && room * 5 >= width * 3 ? { title: cutTitle(text, room), detail: first } : { title: cutTitle(text, width), detail: '' };
}
// A card that waits for the owner's check says "check it" beside its title where it fits: how it
// ended goes with it as far as it fits, and a title too long for the width is cut for it, as for
// the first part of a Task's detail. A title that fits is never cut for it: null then, for the
// card as it is otherwise. keep: how many parts of the detail stay before it (you, on a session
// of mine on my other computer, whose title is cut for them as for the name it carries).
export function fitCheckCard(title, detail, width, keep = 0) {
  const card = fitCard(title, detail, width);
  if (card.detail.split(' · ').includes(CHECK_IT)) return card;
  const said = [...String(detail ?? '').split(' · ').slice(0, keep), CHECK_IT].join(' · '), text = String(title ?? '').replace(/\s/g, ' ').trimEnd(), room = width - columns(said) - 2;
  if (columns(text) <= room) return { title: text, detail: said };
  if (keep) return fitTeammateCard(text, said, width, keep + 1);
  return columns(text) > width && room * 5 >= width * 3 ? { title: cutTitle(text, room), detail: said } : null;
}
// A teammate's card says whose it is: their name, and their machine's when it has one.
const short = (value, max) => cut(String(value ?? '').replace(/\s+/g, ' ').trim(), max);
export const teammateLabel = person => `${short(person?.name, 24) || 'teammate'}${person?.box ? ` on ${short(person.box, 24)}` : ''}`;
// A teammate's card keeps their name beside the title whatever the width: the title is cut
// for it first. keep: how many parts of the detail count as the name (a session's is the
// person and the machine).
export function fitTeammateCard(title, detail, width, keep = 1) {
  const card = fitCard(title, detail, width), first = String(detail ?? '').split(' · ').slice(0, keep).join(' · ');
  if (!first || card.detail.split(' · ').slice(0, keep).join(' · ') === first) return card;
  const name = cut(first, Math.max(2, Math.floor(width / 2)));
  const text = String(title ?? '').replace(/\s/g, ' ').trimEnd(), room = Math.max(2, width - columns(name) - 2);
  return { title: columns(text) <= room ? text : cutTitle(text, room), detail: name };
}
// A teammate's Task (lib/peer/plans.mjs) as a card: approved is In progress, done is Done. A
// build that waits for its owner's check makes a Task done only at his check.
function teammateItem(person, shared) {
  const column = shared.state === 'done' ? 'done' : 'progress', by = teammateLabel(person);
  const steps = shared.subtasks.length, done = shared.subtasks.filter(row => row.state === 'done').length, met = shared.met.length, goals = shared.objectives.length;
  const stands = shared.state === 'done' ? `done ${met}/${goals}` : steps ? `${done}/${steps}` : 'approved';
  const long = shared.state === 'done' ? `done · ${met} of ${goals} objectives reported met` : steps ? `approved · ${done} of ${steps} subtasks done` : 'approved · no subtasks yet';
  const at = column === 'done' ? time(shared.doneAt ?? shared.updatedAt) : time(shared.approvedAt ?? shared.updatedAt);
  return { key: `peer-${person.peer}/${shared.id}`, column, title: shared.title, detail: [by, stands, shared.priority, shared.severity].join(' · '), teammate: person, shared,
    note: [`${by}'s Task · ${long}`, `${shared.priority} priority`, `${shared.severity} severity`, `worked on by ${shared.who}`, person.online === false ? 'offline' : '', 'read-only'].filter(Boolean).join(' · '), order: column === 'done' ? -at : at };
}
// Where one session stands on its owner's board: its column, or null when the board shows it
// nowhere (a teammate's question, an archived session, one quiet for 14 days). The column a
// teammate's board shows it in (lib/peer/cards.mjs); boardColumns places it the same way.
export function sessionPlace(board, task, now = Date.now()) {
  if (['ask', 'review'].includes(task.origin?.kind)) return null;
  const card = board.cards.find(row => row.taskId === task.id && row.column !== 'todo');
  if (card) { const column = sessionColumn(task, board.since ?? now); return cardColumn(board, card, task) === 'done' ? 'done' : column === 'done' ? 'needs' : column; }
  if ((board.archived ?? []).includes(task.id) && sessionClosed(board, task)) return null;
  const reopened = board.done.includes(task.id) && board.closed?.[task.id] && !sessionClosed(board, task);
  const column = board.done.includes(task.id) && !reopened ? 'done' : sessionColumn(task, board.since ?? now);
  return quiet(column, task, now) ? null : column;
}
// A session that has not moved for 14 days leaves the board, unless it is at work, in Done, or
// waits for the owner's check where Done had it before (wentDone): that one stays as long.
const quiet = (column, task, now) => column !== 'progress' && column !== 'done' && !(column === 'needs' && wentDone(task)) && now - lastActivity(task) > QUIET_DAYS * 86400000;
// How a session in Done on its owner's board ended while its Task is approved and not done: the
// words of its Done card (sessionDetail: replied, stopped, published, ready to publish), which
// the Task block in its chat says too (lib/terminal-plan.mjs taskCard), here and on another
// computer of the owner's that views it. An archived session is in Done as well. One under Needs
// you that waits for his check says so too (needsDetail). '' for one the board has anywhere
// else, one at work, one that a message of the owner's is about to start again
// (requests: the project's pending requests), and a Task that waits, is done or was rejected.
export function endedAs(board, task, { plan = task?.plan, requests = [] } = {}) {
  if (plan?.state !== 'approved' || ['running', 'preparing'].includes(task.state)) return '';
  if (requests.some(row => String(row.continuationTaskId) === String(task.id) && ['queued', 'starting'].includes(row.state) && !row.standupFor)) return '';
  const place = sessionPlace(board, task), done = place === 'done' || (board.archived ?? []).includes(task.id) && sessionClosed(board, task);
  return done ? sessionDetail(task) : place === 'needs' && waitsCheck(task) ? needsDetail(task) : '';
}
// A teammate's session (lib/peer/cards.mjs) as a card: its column as their board has it, then
// who started it and on which machine. Its Task, when they also told it, opens with it.
// One of the owner's own on another computer of his (session.own, lib/peer/cards.mjs) says
// "you", whichever of his computers started it, and is not read-only: it opens in Sessions. Such
// a session brings its Task on the card itself.
const COLUMN_NAMES = Object.fromEntries(COLUMNS);
// One of mine that waits for my check there (check: how it ended) says so after where it is,
// and in the row under the board in place of its column.
function teammateSession(person, session, told) {
  const plan = told ?? session.task ?? null, by = session.own === true ? 'you' : `@${short(session.by, 24) || short(person?.name, 24) || 'teammate'}`, box = short(person?.box, 24), at = time(session.at);
  const check = session.own === true && session.column === 'needs' && typeof session.check === 'string' && session.check ? `${short(session.check, 40)} · check it` : '';
  return { key: `peer-${person.peer}/session/${session.id}`, column: session.column, title: session.title, detail: [by, box, person.online === false ? 'offline' : '', check].filter(Boolean).join(' · '), teammate: person, session, ...(plan ? { shared: plan } : {}), ...(check ? { check: true } : {}),
    note: [session.own === true ? `Your session${box ? ` on ${box}` : ''}` : `${by}'s session${box ? ` on ${box}` : ''}`, check || COLUMN_NAMES[session.column], plan ? `Task: ${plan.title}` : '', person.online === false ? 'offline' : '', session.own === true ? '' : 'read-only'].filter(Boolean).join(' · '), order: session.column === 'done' ? -at : at };
}
// The board's four columns for one project snapshot: { key, column, title, detail, card?, task?, request?, plan?, note?, teammate?, shared?, session? }.
// Teammates' Tasks in this project ([{ peer, name, box, online, tasks }]) and their sessions
// ([{ peer, name, box, online, sessions }]) are cards on the same columns, each with the
// teammate's name; no key changes them. A Task whose session is on the board goes with that card.
export function boardColumns(board, snapshot, now = Date.now(), teammates = [], sessions = []) {
  // A teammate's question lives in its Chats thread; a handoff is a card like any session.
  const tasks = (snapshot.tasks ?? []).filter(task => !['ask', 'review'].includes(task.origin?.kind)), queue = (snapshot.queue ?? []).filter(row => !row.origin && row.state !== 'done');
  const linked = new Set(board.cards.flatMap(card => card.taskId ? [card.taskId] : [])), requested = new Set(board.cards.flatMap(card => card.requestId ? [card.requestId] : []));
  const items = [];
  for (const card of board.cards) {
    const task = card.taskId && tasks.find(value => value.id === card.taskId), request = !task && card.requestId && queue.find(value => value.id === card.requestId), placed = cardColumn(board, card, task || null);
    const column = placed === 'todo' ? 'todo' : placed === 'done' ? 'done' : task ? sessionColumn(task, board.since ?? now) === 'done' ? 'needs' : sessionColumn(task, board.since ?? now) : request ? requestColumn(request) : 'needs';
    // A card the owner wrote keeps its own words as the title; its session's Task shows beside them.
    const plan = placed === 'todo' ? null : taskOf(task);
    // A card that never started says where it came from, when a Standup added it.
    const from = typeof card.from === 'string' && card.from ? `from ${card.from}` : '';
    const detail = placed === 'todo' ? from : plan ? taskDetail(plan, task, column) : task ? column === 'needs' ? needsDetail(task) : sessionDetail(task) : request ? plainState(request.state) : placed === 'done' ? from || 'done' : 'not started';
    items.push({ key: card.id, column, title: firstLine(card.text), detail, card, task: task || null, request: request || null, ...(plan ? { plan, note: taskNote(plan, task, column) } : {}), ...(column === 'needs' && waitsCheck(task) ? { check: true } : {}), order: column === 'done' ? -time(card.movedAt) : time(card.createdAt) });
  }
  for (const task of tasks) {
    if (linked.has(task.id)) continue;
    // An archived session is on no column, Done included, until a new message opens it again.
    if ((board.archived ?? []).includes(task.id) && sessionClosed(board, task)) continue;
    const last = lastActivity(task);
    const reopened = board.done.includes(task.id) && board.closed?.[task.id] && !sessionClosed(board, task);
    let column = board.done.includes(task.id) && !reopened ? 'done' : sessionColumn(task, board.since ?? now);
    if (quiet(column, task, now)) continue;
    const plan = taskOf(task);
    items.push({ key: `task-${task.id}`, column, title: plan ? plan.title : taskTitle(task), detail: plan ? taskDetail(plan, task, column) : column === 'needs' ? needsDetail(task) : sessionDetail(task), task, ...(plan ? { plan, note: taskNote(plan, task, column) } : {}), ...(column === 'needs' && waitsCheck(task) ? { check: true } : {}), order: column === 'done' ? -last : last });
  }
  // A request whose session has begun is that session's card: one session, one card.
  const begun = new Set((snapshot.tasks ?? []).map(task => String(task.id)));
  for (const request of queue) {
    if (requested.has(request.id) || request.continuationTaskId || request.taskId != null && begun.has(String(request.taskId))) continue;
    items.push({ key: request.id, column: requestColumn(request), title: requestTitle(request), detail: request.state === 'blocked' ? `blocked · ${firstLine(request.reason)}` : plainState(request.state), request, order: time(request.createdAt) });
  }
  const told = new Map((Array.isArray(teammates) ? teammates : []).map(person => [person?.peer, Array.isArray(person?.tasks) ? person.tasks : []])), withSession = new Set();
  for (const person of Array.isArray(sessions) ? sessions : []) for (const session of Array.isArray(person?.sessions) ? person.sessions : []) {
    const plan = session.plan ? (told.get(person.peer) ?? []).find(task => task.id === session.plan) : null;
    if (plan) withSession.add(`${person.peer}/${plan.id}`);
    items.push(teammateSession(person, session, plan));
  }
  for (const person of Array.isArray(teammates) ? teammates : []) for (const shared of Array.isArray(person?.tasks) ? person.tasks : []) if (!withSession.has(`${person.peer}/${shared.id}`)) items.push(teammateItem(person, shared));
  return COLUMNS.map(([column, name]) => {
    const rows = items.filter(item => item.column === column).sort((a, b) => a.order - b.order);
    // Done holds every finished card, newest first: its list scrolls, and its count is all of them.
    return { column, name, items: rows };
  });
}
