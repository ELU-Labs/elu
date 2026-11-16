import { isObject, refuse } from '../util.mjs';
import { requestGoal, sessionGoal } from '../state.mjs';
import { projectSnapshot } from '../projects.mjs';
import { enqueue } from '../conductor.mjs';
import { defaultMode } from '../modes.mjs';
import { sharedTask } from '../plan.mjs';
import { COLUMNS, addCard, boardColumns, editCard, lastActivity, linkCards, readBoard, removeCard, setDone, startCard } from '../kanban.mjs';
import { cleanTold } from './plans.mjs';
import { sanitize } from './peerdata.mjs';
import { FRAME_MAX } from './transport.mjs';
import { moveToDone } from '../owner-check.mjs';
import { listSchedules, runSchedule } from '../schedules.mjs';

// The Kanban of a project on another computer of the owner's (docs/peer-network.md, "Your
// other computers"). That computer reads its board with its own code (boardOf) and does what
// the owner does to it from here (boardAct), as its own Kanban would: a computer that is his on
// both sides asks (elu.remote.board, elu.remote.boardAct), and a teammate's never does.
const short = (value, max) => sanitize(value, max).replace(/\s+/g, ' ').trim();
const firstLine = value => String(value ?? '').split('\n').find(line => line.trim())?.trim() ?? '';
const ITEMS = 300;

// The project's board as its own Kanban has it: its four columns, the cards, the sessions and their Tasks.
function columnsOf(repo, now) {
  let board = readBoard(repo);
  const snapshot = projectSnapshot(repo);
  if (board.cards.some(card => card.requestId && !card.taskId) && linkCards(repo, snapshot.queue ?? [])) board = readBoard(repo);
  return { name: snapshot.name, columns: boardColumns(board, snapshot, now), board };
}
// One card as it goes: what it shows, and what opens it there (ref: the session's place).
// check: it waits for the owner's check, and its card says so as on this board.
// timed: a schedule here runs it, so the card has the schedule's mark there too, grey while the
// schedule is paused (timedPaused). A build from before 0.1.31 neither sends nor reads them.
function wireItem(project, item, root = null, schedules = []) {
  const task = item.task, request = item.request, job = task ? root && runSchedule(root, task, schedules) : request?.scheduleId ? schedules.find(row => row.id === request.scheduleId) : null;
  let plan = null; try { plan = item.plan ? sharedTask(item.plan) : null; } catch { plan = null; }
  return { key: item.key, column: item.column, title: short(item.title, 200), detail: short(item.detail, 200),
    ...(item.card ? { card: { id: item.card.id, column: item.card.column, text: short(item.card.text, 2000) } } : {}),
    ...(task ? { ref: `${project}:${task.id}`, state: task.state, first: short(firstLine(sessionGoal(task)), 400), at: new Date(lastActivity(task) || Date.now()).toISOString() } : {}),
    ...(!task && request ? { requestState: request.state, first: short(firstLine(requestGoal(request)), 400), at: request.createdAt } : {}),
    ...(plan ? { plan } : {}), ...(item.check === true ? { check: true } : {}), ...(job ? { timed: true, ...(job.enabled ? {} : { timedPaused: true }) } : {}) };
}
// The reply fits one peer message (transport.mjs). While it is too long, a busy board leaves
// out the Tasks of its Done cards and then those cards, the oldest first; then the same in the
// other columns, from the end of each.
export const BOARD_BYTES = FRAME_MAX - 64 * 1024;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function fitBoard(reply) {
  let size = bytes(reply);
  for (const names of [['done'], ['todo', 'needs', 'progress']]) {
    const columns = reply.columns.filter(column => names.includes(column.column));
    for (const column of columns) for (let index = column.items.length - 1; index >= 0 && size > BOARD_BYTES; index--) {
      const { plan, ...rest } = column.items[index];
      if (plan) { size -= bytes(column.items[index]) - bytes(rest); column.items[index] = rest; }
    }
    for (const column of columns) while (column.items.length && size > BOARD_BYTES) size -= bytes(column.items.pop()) + 1;
  }
  return reply;
}
// elu.remote.board: the board of the project here whose id is project.
export function boardOf(repo, project, now = Date.now()) {
  const { name, columns } = columnsOf(repo, now);
  let schedules = []; try { schedules = listSchedules(); } catch { schedules = []; }
  return fitBoard({ project, name: short(name, 60), columns: columns.map(column => ({ column: column.column, items: column.items.slice(0, ITEMS).map(item => wireItem(project, item, repo.root, schedules)) })) });
}
// elu.remote.boardAct: what the owner did to a card there, as his Kanban here does it:
// add, edit, remove, forward (Shift+→) and back (Shift+←). A session under Needs you is not moved
// by forward: its check does that (moveToDone). kick: starts the conductor.
export function boardAct(repo, params, { kick = () => {}, now = Date.now() } = {}) {
  if (!isObject(params)) refuse('Choose a card.');
  if (params.act === 'add') { addCard(repo, params.text); return { said: 'Added to To do. Shift+→ on it starts it.' }; }
  if (!['edit', 'remove', 'forward', 'back'].includes(params.act)) refuse('Choose what to do with the card.');
  const { columns, board } = columnsOf(repo, now), column = columns.find(row => row.items.some(item => item.key === params.key)), item = column?.items.find(row => row.key === params.key);
  if (!item) refuse('That card is no longer on the board there.');
  if (params.act === 'edit') {
    if (item.card?.column !== 'todo') refuse('Only a To do task can be edited. Its session has the conversation.');
    editCard(repo, item.card.id, params.text); return { said: 'Saved.' };
  }
  if (params.act === 'remove') {
    if (!item.card) refuse('Shift+→ checks it instead. Its session stays in Sessions.');
    removeCard(repo, item.card.id); return { said: 'Removed from the board.' };
  }
  if (params.act === 'forward') {
    if (column.column === 'todo') {
      const request = enqueue(repo.root, item.card.text, { priority: 0, permissions: defaultMode() }); startCard(repo, item.card.id, request.id); kick();
      return { said: 'Started. It moves to Needs you when the model stops.' };
    }
    if (column.column === 'progress') refuse('It is being worked on. It moves to Needs you when the model stops.');
    if (column.column === 'needs') {
      if (!item.card && !item.task) refuse('Enter opens it: send it again, or /stop cancels it.');
      // Done waits for the owner's check (moveToDone): a session is refused here, and his other
      // computer shows its check instead (elu.remote.check).
      return { said: moveToDone(repo, item) };
    }
    refuse('Done is the last column. Shift+← reopens it.');
  }
  if (column.column === 'done') {
    if (!item.card && !board.done.includes(item.task.id)) refuse('Answered questions and published work stay in Done.');
    setDone(repo, item, false); return { said: 'Reopened.' };
  }
  if (column.column === 'todo') refuse('To do is the first column.');
  refuse('A started task stays with its session. Enter opens it; Shift+→ checks it.');
}

// ---- What this computer takes from the other one ----
// Its board, each field within its limit and cleaned, as text to show only. A card's Task is
// one my other computer sends (cleanTold), so it may still wait for approval.
const KEY = /^[A-Za-z0-9:_./-]{1,80}$/, REF = /^[0-9a-f]{16}:[1-9][0-9]{0,9}$/, STATES = /^[a-z_]{1,24}$/;
const when = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
export function cleanBoard(value) {
  if (!isObject(value) || !Array.isArray(value.columns)) return null;
  const columns = COLUMNS.map(([column, name]) => {
    const told = value.columns.find(row => isObject(row) && row.column === column), items = [];
    for (const item of (Array.isArray(told?.items) ? told.items : []).slice(0, ITEMS)) {
      if (!isObject(item) || !KEY.test(item.key ?? '')) continue;
      const card = isObject(item.card) && /^card-[0-9a-f]{8}$/.test(item.card.id ?? '') && ['todo', 'started', 'done'].includes(item.card.column) ? { id: item.card.id, column: item.card.column, text: sanitize(item.card.text, 2000) } : null;
      const plan = item.plan ? cleanTold(item.plan, ['proposed', 'approved', 'done']) : null;
      items.push({ key: item.key, column, title: short(item.title, 200) || 'Session', detail: short(item.detail, 200),
        ...(card ? { card } : {}), ...(REF.test(item.ref ?? '') ? { ref: item.ref } : {}), ...(STATES.test(item.state ?? '') ? { state: item.state } : {}), ...(STATES.test(item.requestState ?? '') ? { requestState: item.requestState } : {}),
        first: short(item.first, 400), at: when(item.at), ...(plan ? { plan } : {}), ...(column === 'needs' && item.check === true ? { check: true } : {}), ...(item.timed === true ? { timed: true, ...(item.timedPaused === true ? { timedPaused: true } : {}) } : {}) });
    }
    return { column, name, items };
  });
  return { name: short(value.name, 60), columns };
}
