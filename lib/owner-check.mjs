import fs from 'node:fs';
import path from 'node:path';
import { refuse, tempFolder } from './util.mjs';
import { changed, git, notesSpec, publishable } from './git.mjs';
import { headNow } from './task-head.mjs';
import { readTask, sessionGoal, taskTitle } from './state.mjs';
import { approveDone, readBoard, sessionDetail, sessionPlace, setDone, waitsCheck } from './kanban.mjs';
import { sessionChecklist } from './checklist.mjs';
import { checkProposal, markChecked, readGoal, sessionTasks, setGoal } from './plan.mjs';
import { OLDER_COPY, conductorTakesCopies, enqueue, tellChecked } from './conductor.mjs';
import { MODES, capMode, checkFolders, foldersBelowFull } from './modes.mjs';
import { checkModel } from './models.mjs';
import { sessionModel } from './projects.mjs';
import { sessionBots } from './bots.mjs';

// The owner's check of a session that ended (README, "Kanban"): its Task's goal and each
// objective, with the agent's own mark and its line of evidence, then his answer. Done moves
// it to Done; a new goal keeps it open and its work goes on at once, as a message of his; a
// copy with a new goal starts a new session from where this one ended and moves this one to
// Done. Only the owner answers it: his key or his /done, here or from another computer of his
// (lib/peer/remote.mjs). A model's turn, a bot, a schedule, a teammate and elu sessions never
// move a session to Done. A session at work takes a new goal from him too, and only that: its
// turn is not stopped, and is told of it (keepOpen).

export const ANSWERS = Object.freeze(['done', 'goal', 'copy']);
export { readGoal };
const WORKING = ['running', 'preparing'];
const one = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const cut = (value, max) => value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
// The Task the check is about: the session's newest one that is not rejected.
const taskOf = (repo, id) => sessionTasks(repo, id).findLast(row => row.state !== 'rejected') ?? null;
function ended(task) {
  if (WORKING.includes(task.state)) refuse(`"${cut(one(taskTitle(task)), 40)}" is working. Check it when it stops.`);
}
// A key that moves a card to Done, on this computer's Kanban (Shift+→, /done) or from another
// computer of the owner's (lib/peer/remote-board.mjs elu.remote.boardAct): every such move comes
// here, so the rule holds for every way in. A session goes to Done only through its check
// (checkDone, from the check's Done), never straight from a key. A card whose session is gone
// has nothing to check: it moves at once.
export const CHECK_FIRST = 'Its check comes first: Shift+→ on it shows its goal and objectives, then Done.';
export function moveToDone(repo, item) {
  if (item.task) refuse(CHECK_FIRST);
  setDone(repo, item, true); return 'Moved to Done.';
}
// The Task's goal and its objectives, each with the agent's mark and its line of evidence.
const objectivesOf = plan => plan.objectives.map((text, index) => ({ text, met: plan.met.includes(index + 1), evidence: typeof plan.evidence?.[index] === 'string' && plan.evidence[index] ? plan.evidence[index] : null }));
// What the check shows: { title, ended, goal, objectives: [{ text, met, evidence }], checklist }
// for a session with a Task, else { title, ended, first, checklist } (first: its first message).
// checklist: what ELU's own records say of its work (lib/checklist.mjs). One at work with a
// Task shows the same, with working: its one answer is a new goal (keepOpen). One at work with
// none is refused before anything is asked, as its answer would be.
export function checkView(repo, task) {
  const plan = taskOf(repo, task.id);
  if (!plan || plan.state === 'proposed') ended(task);
  if (plan?.state === 'proposed') refuse('Its Task waits for your approval first.');
  const head = { title: taskTitle(task) || one(sessionGoal(task)), ended: sessionDetail(task) }, checklist = sessionChecklist(task);
  if (!plan) return { ...head, first: String(sessionGoal(task) ?? ''), checklist };
  return { ...head, goal: plan.goal, objectives: objectivesOf(plan), checklist, ...(WORKING.includes(task.state) ? { working: true } : {}) };
}
// The session's Task as its header's Task opens it, at any time: its goal and objectives (one
// with no Task of its own has its first message as its goal, and no objectives), the checklist
// of its work, and whether it waits for the owner's check now (waits) or its Task for his yes
// (proposed), or that its approved Task works (working: a new goal reaches it as it works,
// keepOpen). approvals: what its turn waits for him to allow.
export function taskView(repo, task, { approvals = [] } = {}) {
  const plan = taskOf(repo, task.id), checklist = sessionChecklist(task, { approvals });
  let waits = false; try { waits = waitsCheck(task) && plan?.state !== 'proposed' && sessionPlace(readBoard(repo), task) === 'needs'; } catch { waits = false; }
  const head = { title: taskTitle(task) || one(sessionGoal(task)), checklist, waits, ...(plan?.state === 'proposed' ? { proposed: true } : {}), ...(plan && plan.state !== 'proposed' && WORKING.includes(task.state) ? { working: true } : {}) };
  if (!plan) return { ...head, goal: String(sessionGoal(task) ?? ''), objectives: null };
  return { ...head, goal: plan.goal, objectives: objectivesOf(plan) };
}
// Done: the session moves to Done, and his check makes its Task done, saying when. A session a
// teammate's message started sends them its result now. root: the project's folder.
export function checkDone(repo, task, root = repo.project ?? repo.root) {
  ended(task);
  if (taskOf(repo, task.id)?.state === 'proposed') refuse('Its Task waits for your approval first.');
  const at = approveDone(repo, task);
  try { markChecked(repo, task.id, at); tellChecked(repo, root, task.id); } catch { /* The board holds it. */ }
  return at;
}
// Keep open: the Task takes the new goal, keeping what it was, and the session goes on at once
// in its own mode, as if he sent what he typed. A session with no Task gets the message alone.
// One in Done leaves it at once: it waits for his check again when the work ends.
// A session at work takes it too, at any time: the Task's goal and objectives change at once,
// and its turn goes on, not stopped. What he typed goes to it as his message (goalChange): a
// turn that takes messages reads it at its next step, told to align its work with the new goal
// (lib/runner.mjs inboxFeed); one that takes none reads it as the next message the moment it
// ends, and is never answered beside it (lib/conductor.mjs answerBeside). Either way that turn
// is judged by the new objectives (lib/plan.mjs reportProgress). working: it was at work. One
// at work with no Task is refused, as its check is: a message to it is typed in the session.
// root: the project's folder, where messages wait.
export function keepOpen(repo, root, task, text) {
  const said = String(text ?? '').trim(); if (!said) refuse('Write the new goal first.');
  const plan = taskOf(repo, task.id);
  if (!plan) ended(task);
  if (plan?.state === 'proposed') refuse('Its Task waits for your approval first.');
  const working = WORKING.includes(task.state), changed = plan ? setGoal(repo, task.id, readGoal(said), { realign: working }) : null;
  enqueue(root, said, { continuationTaskId: String(task.id), priority: 0, typed: true, ...(changed ? { goalChange: { task: changed.id, revision: changed.revision } } : {}) });
  const board = readBoard(repo);
  if (sessionPlace(board, task) === 'done') { const card = board.cards.find(row => row.taskId === task.id && row.column === 'done'); setDone(repo, card ? { card } : { task }, false); }
  return { task: Boolean(plan), ...(working ? { working: true } : {}) };
}
// What the copy of a Task keeps of the session it came from: its description, then what that
// session's goal was, what was met and what was not, the subtasks it finished and its last answer.
// All of it, however long his goals were.
function notes(plan, task) {
  const met = plan.objectives.filter((_, index) => plan.met.includes(index + 1)), open = plan.objectives.filter((_, index) => !plan.met.includes(index + 1));
  const steps = (plan.subtasks ?? []).filter(step => step.state === 'done').map(step => step.text), said = one((task.reply ?? task.result)?.summary);
  const before = [`Before, in "${cut(one(taskTitle(task)), 60)}":`, `Goal: ${one(plan.goal)}`, met.length ? `Met: ${met.join('; ')}` : '', open.length ? `Not met: ${open.join('; ')}` : '', steps.length ? `Done: ${steps.join('; ')}` : '', said ? `Last answer: ${said}` : ''].filter(Boolean).join('\n');
  return plain(`${String(plan.description ?? '').trim()}\n\n${before}`).trim();
}
// A Task's text holds no control character and no mark that reorders or hides text (lib/plan.mjs
// refuses them), and a session's name and its last answer may: they are taken out, a tab is a space.
const plain = value => String(value ?? '').replace(/\t/g, ' ').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '');
// The branch the copy starts on: a new one at the commit where this session's work ended,
// named after its branch. null where it has none of its own (a chat, a session in the
// checkout itself, one in a repository of the project's folder).
function branchAtEnd(repo, task) {
  if (task.kind === 'conversation' || !task.worktree || task.place?.kind === 'here' || task.repository) return null;
  let at = headNow(task) ?? task.commit ?? task.base; if (!at) return null;
  at = workAtEnd(task, at);
  const stem = String(task.branch || `feat/task-${task.id}`).replace(/-next(?:-\d+)?$/, '');
  for (let n = 1; n < 50; n++) {
    const name = n === 1 ? `${stem}-next` : `${stem}-next-${n}`;
    if (git(repo.root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { allowFailure: true }).status === 0) continue;
    return git(repo.root, ['branch', name, at], { allowFailure: true }).status === 0 ? name : null;
  }
  return null;
}
// ELU commits a session's work only when it publishes, so where it ended is its folder: what it
// changed there and did not commit becomes one commit on top of its own, which only the copy's
// branch holds. Its folder, its index and its branch stay as they were.
function workAtEnd(task, at) {
  if (!fs.existsSync(task.worktree)) return at;
  const files = publishable(changed(task.worktree, at, { ignored: task.place?.kind !== 'here', exclude: notesSpec(task) }));
  if (!files.length) return at;
  const dir = tempFolder('elu-copy-'), env = { GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    const step = args => { const result = git(task.worktree, args, { env, allowFailure: true }); if (result.status !== 0) refuse(`The copy could not take this session's work: ${String(result.stderr || result.error?.message || '').trim().split('\n')[0] || `git ${args[0]} failed`}`); return result.stdout.trim(); };
    step(['read-tree', at]); step(['add', '--', ...files]);
    const tree = step(['write-tree']);
    return tree === step(['rev-parse', `${at}^{tree}`]) ? at : step(['commit-tree', tree, '-p', at, '-m', `Work of session ${task.id} before its copy`]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// A copy with a new goal: a new session with a copy of the Task (its title, its context, the
// branch where this one ended, what this one did) and the goal he typed, approved as he wrote
// it, starts at once in this session's mode. done: this session moves to Done (his check);
// elu sessions copy leaves it where it is. most: the highest mode the copy may get (the mode
// of a session whose command asks for it). Returns the request that starts the copy.
export function copySession(repo, root, task, text, { done = true, most = null } = {}) {
  ended(task);
  const plan = taskOf(repo, task.id);
  if (!plan || plan.state === 'proposed') refuse('Only a session with a Task is copied. Keep it open with a new message instead.');
  const asked = readGoal(text); if (!asked) refuse('Write the new goal first.');
  // A conductor of an older build would start it as a plain message: nothing is made for it.
  if (!conductorTakesCopies()) refuse(OLDER_COPY);
  // The goal and the objectives are his, whole (owner).
  const fields = checkProposal({ title: plan.title, description: notes(plan, task), goal: asked.goal, objectives: asked.objectives.length ? asked.objectives : [asked.goal], priority: plan.priority, severity: plan.severity, criteria: [], estimateMinutes: null }, { owner: true });
  const own = MODES.includes(task.permissions) ? task.permissions : 'ask', mode = most ? capMode(own, most) : own;
  // Its model, and the folders it also works in as far as the copy's mode takes them.
  let model = null; try { model = checkModel(sessionModel(repo, task)); } catch { model = null; }
  const folders = (Array.isArray(task.folders) ? mode === 'full' ? task.folders : foldersBelowFull(task.folders) : []).filter(dir => { try { checkFolders([dir], { mode }); return true; } catch { return false; } });
  const branch = branchAtEnd(repo, task);
  const request = enqueue(root, String(text).trim(), { priority: 0, typed: true, permissions: mode, picked: true, ...(branch ? { place: { kind: 'branch', branch } } : {}), ...(Array.isArray(task.bots) ? { bots: sessionBots(task) } : {}), ...(model ? { model } : {}), ...(folders.length ? { folders } : {}), copied: { ...fields, from: { session: String(task.id), task: plan.id } } });
  if (done) checkDone(repo, readTask(repo, String(task.id)), root);
  return { request, branch };
}
// One answer, as the check and a computer of mine give it: done, goal (text: the new goal and
// its objectives, or a message for a session with no Task) or copy (text: the new goal).
export function answerCheck(repo, root, task, answer, text = '') {
  if (answer === 'done') return { answer, at: checkDone(repo, task, root) };
  if (answer === 'goal') return { answer, ...keepOpen(repo, root, task, text) };
  if (answer === 'copy') { const { branch } = copySession(repo, root, task, text); return { answer, ...(branch ? { branch } : {}) }; }
  refuse('Choose done, goal or copy.');
}
