import fs from 'node:fs';
import { hash, mkdir, noSymlinks, refuse } from './util.mjs';
import { readTask, taskDir } from './state.mjs';
import { addCard, boardColumns, editCard, readBoard, removeCard, setDone } from './kanban.mjs';
import { projectSnapshot, registeredProjects } from './projects.mjs';
import { kanbanChanges, kanbanChangesFile, oneLine, updateSource } from './standup.mjs';
import { teammateSessions } from './peer/cards.mjs';
import { pairedMine } from './peer/mine.mjs';

// The Standup agent's Kanban tools (lib/approval-server.mjs serves them, README "Standup").
// They read and change only this computer's boards, for the projects the round involved and
// the Standup session's own: never another computer's board, and never a teammate's card,
// which is not on this board at all. Each change is kept beside the Standup session's
// record, so its chat says what changed, and so a card can be removed only by the Standup
// that added it. A card added from an update says where it came from ("from @billing on
// @kim"), as ELU reads it from that update, never as the model words it.

export const KANBAN_TOOLS = Object.freeze(['kanban_list', 'kanban_add', 'kanban_edit', 'kanban_move', 'kanban_remove']);
const board = { type: 'string', description: 'A board id from kanban_list.' };
export const KANBAN_TOOL_DEFS = Object.freeze([
  { name: 'kanban_list', description: "Lists this computer's Kanban boards for the projects of this standup: each board's id and project, its columns with each card's id, title and detail, and the session it is; then the owner's sessions on his other computers (otherComputers) and teammates' cards (teammates), both read-only.", inputSchema: { type: 'object', properties: {} } },
  { name: 'kanban_add', description: 'Adds a To do card to one board. from: the id of the update it comes from (such as u3), so the card says where it came from.', inputSchema: { type: 'object', properties: { board, text: { type: 'string' }, from: { type: 'string' } }, required: ['board', 'text'] } },
  { name: 'kanban_edit', description: "Changes the text of a To do card. A started card's text is its session's.", inputSchema: { type: 'object', properties: { board, card: { type: 'string' }, text: { type: 'string' } }, required: ['board', 'card', 'text'] } },
  { name: 'kanban_move', description: 'Moves a card or a session (an id from kanban_list) to Done, with done true, or back to its column, with done false.', inputSchema: { type: 'object', properties: { board, id: { type: 'string' }, done: { type: 'boolean' } }, required: ['board', 'id', 'done'] } },
  { name: 'kanban_remove', description: 'Removes a To do card that this standup added.', inputSchema: { type: 'object', properties: { board, card: { type: 'string' } }, required: ['board', 'card'] } },
]);
export const READ_ONLY = "Another computer's board and a teammate's card stay read-only. Only this computer's boards for this standup change.";
const boardKey = root => hash(`standup-board\0${root}`).slice(0, 12);
// The Standup session this relay serves: { repo, task } of a session of this computer that is
// one, or null.
export function standupSession(root, taskId) {
  if (typeof root !== 'string' || !/^[1-9][0-9]*$/.test(String(taskId ?? ''))) return null;
  const repo = registeredProjects().find(row => row.root === root);
  if (!repo) return null;
  let task = null; try { task = readTask(repo, String(taskId)); } catch { return null; }
  return task.standup ? { repo, task } : null;
}
// The boards this Standup may read and change: its own project's, then each project of this
// computer the round asked a session in, while it is still a project here.
function boards(repo, task) {
  const roots = [...new Set([repo.root, ...(Array.isArray(task.standup?.projects) ? task.standup.projects : [])])], all = registeredProjects();
  return roots.flatMap(root => { const found = root === repo.root ? repo : all.find(row => row.root === root); return found ? [found] : []; });
}
const added = (repo, task) => new Set(kanbanChanges(repo, task.id).filter(row => row.added && row.card).map(row => row.card));
// What the Standup's model reads of each board: its columns as the Kanban tab shows them,
// each at most 40 cards; then the sessions of the owner's other computers on it, named by
// the computer, and teammates' sessions, named by who started them; each read-only, at most 40.
const plainName = value => oneLine(value, 40).replace(/[\s@]+/g, '');
const ownComputer = key => { try { return pairedMine(key); } catch { return false; } };
export function boardsFor(repo, task) {
  const mine = added(repo, task);
  return boards(repo, task).map(target => {
    const snapshot = projectSnapshot(target), columns = boardColumns(readBoard(target), snapshot);
    let people = []; try { people = teammateSessions(target.root).people ?? []; } catch { people = []; }
    const rows = (list, who) => list.flatMap(person => (person.sessions ?? []).map(card => ({ ...who(person, card), title: oneLine(card.title, 120), column: COLUMN_NAMES[card.column] ?? card.column }))).slice(0, 40);
    const computers = rows(people.filter(person => ownComputer(person.peer)), person => ({ computer: `@${plainName(person.box) || plainName(person.name) || person.peer.slice(0, 8)}` }));
    const theirs = rows(people.filter(person => !ownComputer(person.peer)), (person, card) => ({ who: `@${plainName(card.by) || oneLine(person.name, 40)}` }));
    return { board: boardKey(target.root), project: oneLine(snapshot.name, 60), columns: columns.map(column => ({ column: column.name, cards: column.items.slice(0, 40).map(item => ({ id: itemId(item), title: oneLine(item.title, 120), ...(item.detail ? { detail: oneLine(item.detail, 120) } : {}), ...(item.task ? { session: item.task.id } : {}), ...(item.card && mine.has(item.card.id) ? { added: true } : {}) })), ...(column.items.length > 40 ? { more: column.items.length - 40 } : {}) })), ...(computers.length ? { otherComputers: computers, otherComputersReadOnly: true } : {}), ...(theirs.length ? { teammates: theirs, teammatesReadOnly: true } : {}) };
  });
}
const COLUMN_NAMES = { todo: 'To do', progress: 'In progress', needs: 'Needs you', done: 'Done' };
// The source of a card from an update of this Standup's rounds: "@billing on @kim", or null.
function sourceOf(task, id) {
  if (id == null || id === '') return null;
  const row = (task.standup?.updates ?? []).find(value => value.id === id);
  if (!row) refuse('No update of this standup has that id. The ids are in the standup context, such as u3.');
  return updateSource(row);
}
const itemId = item => item.card ? item.card.id : item.task ? `session-${item.task.id}` : item.key;
function target(session, id) {
  const found = boards(session.repo, session.task).find(row => boardKey(row.root) === id);
  if (!found) refuse(`That board is not one of this standup's on this computer. ${READ_ONLY}`);
  return found;
}
// One card or session of a board, as kanban_list names it: { item, column }.
function find(repo, id) {
  if (typeof id !== 'string' || !id) refuse('Name a card or a session: an id from kanban_list.');
  if (id.startsWith('peer-')) refuse(`That is a teammate's card. ${READ_ONLY}`);
  for (const column of boardColumns(readBoard(repo), projectSnapshot(repo))) {
    const item = column.items.find(row => itemId(row) === id);
    if (item) return { item, column: column.name };
  }
  refuse('No card or session on that board has that id. kanban_list lists them.');
}
const quoted = text => `'${oneLine(String(text ?? '').split('\n').find(line => line.trim()) ?? '', 80)}'`;
function record(session, row) {
  const file = kanbanChangesFile(session.repo, session.task.id); mkdir(taskDir(session.repo, session.task.id)); noSymlinks(file);
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, { mode: 0o600 });
  return row.text;
}
// What the owner is asked about a change in Ask for approval.
export function kanbanTitle(name, input, session) {
  const where = (() => { try { const repo = target(session, input?.board); return ` on ${oneLine(projectSnapshot(repo).name, 40)}'s board`; } catch { return ''; } })();
  const what = (() => { try { return quoted(find(target(session, input?.board), input?.id ?? input?.card).item.title); } catch { return 'a card'; } })();
  if (name === 'kanban_add') { let from = null; try { from = sourceOf(session.task, input?.from); } catch { from = null; } return `Kanban: add ${quoted(input?.text)} to To do${where}${from ? `, from ${from}` : ''}`; }
  if (name === 'kanban_edit') return `Kanban: change ${what} to ${quoted(input?.text)}${where}`;
  if (name === 'kanban_move') return `Kanban: move ${what} ${input?.done === false ? 'back to its column' : 'to Done'}${where}`;
  if (name === 'kanban_remove') return `Kanban: remove ${what}${where}`;
  return 'Kanban: read the boards';
}
// Runs one tool for a Standup session ({ repo, task }) and returns what it says back.
export function kanbanTool(name, input = {}, session) {
  if (!session) refuse('This is not a Standup session.');
  if (name === 'kanban_list') return JSON.stringify({ boards: boardsFor(session.repo, session.task) }, null, 2);
  const repo = target(session, input.board);
  if (name === 'kanban_add') {
    const from = sourceOf(session.task, input.from), card = addCard(repo, input.text, { from });
    return record(session, { text: `Added ${quoted(card.text)} to To do${from ? `, from ${from}` : ''}`, board: input.board, card: card.id, added: true });
  }
  if (name === 'kanban_edit') {
    const { item } = find(repo, input.card);
    if (!item.card) refuse('Only a card has text to change. A session keeps its own title.');
    const card = editCard(repo, item.card.id, input.text);
    return record(session, { text: `Changed ${quoted(item.title)} to ${quoted(card.text)}`, board: input.board, card: card.id });
  }
  if (name === 'kanban_move') {
    if (typeof input.done !== 'boolean') refuse('Say done true to move it to Done, or false to move it back.');
    const { item } = find(repo, input.id);
    if (!item.card && !item.task) refuse('A waiting message is not a card. It moves once its session starts.');
    setDone(repo, item.card ? { card: item.card } : { task: item.task }, input.done);
    let now = 'its column'; try { now = find(repo, input.id).column; } catch { /* A quiet session leaves the board once out of Done. */ }
    return record(session, { text: input.done ? `Moved ${quoted(item.title)} to Done` : `Moved ${quoted(item.title)} back to ${now}`, board: input.board, ...(item.card ? { card: item.card.id } : { session: item.task.id }) });
  }
  if (name === 'kanban_remove') {
    const { item } = find(repo, input.card);
    if (!item.card || !added(session.repo, session.task).has(item.card.id)) refuse('Only a card this standup added can be removed here. Move another one to Done instead, or ask the owner.');
    removeCard(repo, item.card.id);
    return record(session, { text: `Removed ${quoted(item.title)}`, board: input.board, card: item.card.id });
  }
  refuse(`Unknown tool: ${oneLine(name, 40)}`);
}
