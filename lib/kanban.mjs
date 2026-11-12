import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomic, mkdir, noSymlinks, readJson, refuse } from './util.mjs';
import { waitLock, requestGoal, taskTitle } from './state.mjs';
import { botWork } from './bots.mjs';

// One Kanban board per project. Cards you write wait in To do; a started card follows
// its session (In progress while the lead works, Needs you when it stops), and Done
// is where you put finished work. Sessions typed elsewhere appear on the board too.
// The board lives with the project's sessions, not in its files, so it is never
// committed by accident.

export const COLUMNS = Object.freeze([['todo', 'To do'], ['progress', 'In progress'], ['needs', 'Needs you'], ['done', 'Done']]);
const DONE_SHOWN = 20, QUIET_DAYS = 14;
const file = repo => path.join(repo.state, 'kanban.json');
const time = value => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; };
const firstLine = value => String(value ?? '').split('\n').find(line => line.trim())?.trim() ?? '';

export function readBoard(repo) {
  const target = file(repo); noSymlinks(target);
  if (!fs.existsSync(target)) return { cards: [], done: [], closed: {}, archived: [] };
  const value = readJson(target);
  const closed = value?.closed && typeof value.closed === 'object' && !Array.isArray(value.closed) ? Object.fromEntries(Object.entries(value.closed).filter(([, at]) => typeof at === 'string')) : {};
  return {
    cards: Array.isArray(value?.cards) ? value.cards.filter(card => typeof card?.id === 'string' && typeof card.text === 'string' && ['todo', 'started', 'done'].includes(card.column)) : [],
    done: Array.isArray(value?.done) ? value.done.filter(id => typeof id === 'string') : [],
    closed,
    // The sessions the owner archived: they leave the board, while a session moved to Done on
    // the board stays in Done. A board saved before this list did not tell the two apart, so
    // every session it closed counts as archived.
    archived: Array.isArray(value?.archived) ? value.archived.filter(id => typeof id === 'string') : Object.keys(closed),
  };
}
const lastActivity = task => Math.max(time(task.createdAt), ...(task.runs ?? []).map(run => time(run.at)), ...(task.messages ?? []).map(row => time(row.at)));
// An archived session (or one moved to Done) stays closed until it has newer activity: a
// new message opens it again.
export function sessionClosed(board, task) {
  const at = board.done.includes(task.id) ? Date.parse(board.closed?.[task.id] ?? '') : NaN;
  return Number.isFinite(at) && lastActivity(task) <= at && !['running', 'preparing'].includes(task.state);
}
export function closeSession(repo, id) {
  return change(repo, board => { if (!board.done.includes(id)) board.done.push(id); if (!board.archived.includes(id)) board.archived.push(id); board.closed[id] = new Date().toISOString(); return id; });
}
// Brings an archived session back into the list.
export function reopenSession(repo, id) {
  return change(repo, board => { board.done = board.done.filter(row => row !== id); board.archived = board.archived.filter(row => row !== id); delete board.closed[id]; return id; });
}
function change(repo, edit) {
  mkdir(repo.state);
  const release = waitLock(repo, 'kanban', 200);
  try { const board = readBoard(repo), result = edit(board); atomic(file(repo), board); return result; }
  finally { release(); }
}
const find = (board, id) => board.cards.find(card => card.id === id) ?? refuse('That card no longer exists.');
const checkText = text => { const value = String(text ?? '').trim(); if (!value || value.length > 16000) refuse('Write a task of 1 to 16000 characters.'); return value; };

export function addCard(repo, text) {
  const value = checkText(text), now = new Date().toISOString();
  return change(repo, board => { if (board.cards.length >= 500) refuse('Keep at most 500 cards.'); const card = { id: `card-${crypto.randomUUID().slice(0, 8)}`, text: value, column: 'todo', requestId: null, taskId: null, createdAt: now, movedAt: now }; board.cards.push(card); return card; });
}
export function editCard(repo, id, text) {
  const value = checkText(text);
  return change(repo, board => { const card = find(board, id); if (card.column !== 'todo') refuse('Only a To do task can be edited. Its session has the conversation.'); card.text = value; return card; });
}
export function removeCard(repo, id) {
  return change(repo, board => { const card = find(board, id); if (card.column === 'started') refuse('Move it to Done instead. Its session stays in Sessions.'); board.cards = board.cards.filter(value => value !== card); return card; });
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
// Done and back. A card that never started goes back to To do.
export function setDone(repo, item, done) {
  return change(repo, board => {
    if (item.card) { const card = find(board, item.card.id); card.column = done ? 'done' : card.requestId || card.taskId ? 'started' : 'todo'; card.movedAt = new Date().toISOString(); return card; }
    board.done = board.done.filter(id => id !== item.task.id); board.archived = board.archived.filter(id => id !== item.task.id); delete board.closed[item.task.id];
    if (done) { board.done.push(item.task.id); board.closed[item.task.id] = new Date().toISOString(); }
    return null;
  });
}

function sessionColumn(task) {
  if (['running', 'preparing'].includes(task.state)) return 'progress';
  // A Task that waits for the owner's yes needs them, though its session rests as an answer leaves it.
  if (task.plan?.state === 'proposed') return 'needs';
  if (task.pr || task.kind === 'conversation' && task.state === 'answered') return 'done';
  return 'needs';
}
const requestColumn = request => ['queued', 'starting', 'running'].includes(request.state) ? 'progress' : 'needs';
function sessionDetail(task) {
  if (task.state === 'running' || task.state === 'preparing') return botWork(task) ? `${botWork(task).agent} ${botWork(task).label}` : task.activeRole && task.activeRole !== 'lead' ? `${task.activeRole} reviewing` : 'working';
  if (task.state === 'needs_input') return 'asks you';
  if (task.state === 'ready') return 'ready to publish';
  if (task.pr) return 'published';
  return task.state.replace('_', ' ');
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
const taskDetail = (plan, task, column) => [column === 'needs' && plan.state !== 'proposed' ? sessionDetail(task) : '', taskStands(plan, true), plan.priority, plan.severity].filter(Boolean).join(' · ');
// The whole of it, for the row under the board while the card is selected.
function taskNote(plan, task) {
  const name = taskTitle(task), doing = plan.state === 'proposed' || task.state === 'answered' ? '' : sessionDetail(task);
  return [`Task · ${taskStands(plan, false)}`, `${plan.priority} priority`, `${plan.severity} severity`, name && name !== plan.title ? `session: ${name}` : '', doing].filter(Boolean).join(' · ');
}
// As much of a Task card's detail as fits beside its title: whole parts from the start,
// never half a word.
export function fitDetail(detail, room) {
  let text = '';
  for (const part of String(detail ?? '').split(' · ')) { const next = text ? `${text} · ${part}` : part; if (next.length > room) break; text = next; }
  return text;
}
// A title cut to its room: at a word, unless that leaves more than a third of the room
// empty (a long word after a short one): then inside the word.
function cutTitle(text, room) {
  if (room < 2) return text.slice(0, Math.max(0, room));
  const cut = text.slice(0, room - 1), space = cut.lastIndexOf(' '), words = space > 0 ? cut.slice(0, space).trimEnd() : cut;
  return `${(words.length + 1) * 3 >= room * 2 ? words : cut.trimEnd()}…`;
}
// A Task's card in the width its column has, the title first. Whole parts of the detail go
// beside the whole title as far as they fit, and a title that fits is never cut for them.
// Only a title longer than the width is cut: the first part stays beside it while the title
// keeps at least three fifths of the width, and otherwise the title has the line to itself.
export function fitCard(title, detail, width) {
  const text = String(title ?? '').replace(/\s/g, ' ').trimEnd();
  if (text.length <= width) return { title: text, detail: fitDetail(detail, width - text.length - 2) };
  const first = String(detail ?? '').split(' · ')[0], room = width - first.length - 2;
  return first && room * 5 >= width * 3 ? { title: cutTitle(text, room), detail: first } : { title: cutTitle(text, width), detail: '' };
}
// A teammate's card says whose it is: their name, and their machine's when it has one.
const short = (value, max) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
export const teammateLabel = person => `${short(person?.name, 24) || 'teammate'}${person?.box ? ` on ${short(person.box, 24)}` : ''}`;
// A teammate's card keeps their name beside the title whatever the width: the title is cut
// for it first. keep: how many parts of the detail count as the name (a session's is the
// person and the machine).
export function fitTeammateCard(title, detail, width, keep = 1) {
  const card = fitCard(title, detail, width), first = String(detail ?? '').split(' · ').slice(0, keep).join(' · ');
  if (!first || card.detail.split(' · ').slice(0, keep).join(' · ') === first) return card;
  const name = first.length > Math.floor(width / 2) ? `${first.slice(0, Math.max(1, Math.floor(width / 2) - 1))}…` : first;
  const text = String(title ?? '').replace(/\s/g, ' ').trimEnd(), room = Math.max(2, width - name.length - 2);
  return { title: text.length <= room ? text : cutTitle(text, room), detail: name };
}
// A teammate's Task (lib/peer/plans.mjs) as a card: approved is In progress, done is Done.
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
  if (card) { const column = sessionColumn(task); return card.column === 'done' ? 'done' : column === 'done' ? 'needs' : column; }
  if ((board.archived ?? []).includes(task.id) && sessionClosed(board, task)) return null;
  const reopened = board.done.includes(task.id) && board.closed?.[task.id] && !sessionClosed(board, task);
  const column = board.done.includes(task.id) && !reopened ? 'done' : sessionColumn(task);
  return column !== 'progress' && column !== 'done' && now - lastActivity(task) > QUIET_DAYS * 86400000 ? null : column;
}
// A teammate's session (lib/peer/cards.mjs) as a card: its column as their board has it, then
// who started it and on which machine. Its Task, when they also told it, opens with it.
const COLUMN_NAMES = Object.fromEntries(COLUMNS);
function teammateSession(person, session, plan) {
  const by = `@${short(session.by, 24) || short(person?.name, 24) || 'teammate'}`, box = short(person?.box, 24), at = time(session.at);
  return { key: `peer-${person.peer}/session/${session.id}`, column: session.column, title: session.title, detail: [by, box, person.online === false ? 'offline' : ''].filter(Boolean).join(' · '), teammate: person, session, ...(plan ? { shared: plan } : {}),
    note: [`${by}'s session${box ? ` on ${box}` : ''}`, COLUMN_NAMES[session.column], plan ? `Task: ${plan.title}` : '', person.online === false ? 'offline' : '', 'read-only'].filter(Boolean).join(' · '), order: session.column === 'done' ? -at : at };
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
    const task = card.taskId && tasks.find(value => value.id === card.taskId), request = !task && card.requestId && queue.find(value => value.id === card.requestId);
    const column = card.column === 'todo' ? 'todo' : card.column === 'done' ? 'done' : task ? sessionColumn(task) === 'done' ? 'needs' : sessionColumn(task) : request ? requestColumn(request) : 'needs';
    // A card the owner wrote keeps its own words as the title; its session's Task shows beside them.
    const plan = card.column === 'todo' ? null : taskOf(task);
    const detail = card.column === 'todo' ? '' : plan ? taskDetail(plan, task, column) : task ? sessionDetail(task) : request ? request.state : card.column === 'done' ? 'done' : 'not started';
    items.push({ key: card.id, column, title: firstLine(card.text), detail, card, task: task || null, request: request || null, ...(plan ? { plan, note: taskNote(plan, task) } : {}), order: column === 'done' ? -time(card.movedAt) : time(card.createdAt) });
  }
  for (const task of tasks) {
    if (linked.has(task.id)) continue;
    // An archived session is on no column, Done included, until a new message opens it again.
    if ((board.archived ?? []).includes(task.id) && sessionClosed(board, task)) continue;
    const last = Math.max(time(task.createdAt), ...(task.runs ?? []).map(run => time(run.at)), ...(task.messages ?? []).map(row => time(row.at)));
    const reopened = board.done.includes(task.id) && board.closed?.[task.id] && !sessionClosed(board, task);
    let column = board.done.includes(task.id) && !reopened ? 'done' : sessionColumn(task);
    if (column !== 'progress' && now - last > QUIET_DAYS * 86400000 && column !== 'done') continue;
    const plan = taskOf(task);
    items.push({ key: `task-${task.id}`, column, title: plan ? plan.title : taskTitle(task), detail: plan ? taskDetail(plan, task, column) : sessionDetail(task), task, ...(plan ? { plan, note: taskNote(plan, task) } : {}), order: column === 'done' ? -last : last });
  }
  // A request whose session has begun is that session's card: one session, one card.
  const begun = new Set((snapshot.tasks ?? []).map(task => String(task.id)));
  for (const request of queue) {
    if (requested.has(request.id) || request.continuationTaskId || request.taskId != null && begun.has(String(request.taskId))) continue;
    items.push({ key: request.id, column: requestColumn(request), title: firstLine(requestGoal(request)), detail: request.state === 'blocked' ? `blocked · ${firstLine(request.reason)}` : request.state, request, order: time(request.createdAt) });
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
    return { column, name, items: column === 'done' ? rows.slice(0, DONE_SHOWN) : rows };
  });
}
