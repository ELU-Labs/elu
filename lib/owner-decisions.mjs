import { isObject, refuse } from './util.mjs';
import { changeSettings, readTask } from './state.mjs';
import { sessionTasks, setGoal } from './plan.mjs';
import { scanSecrets } from './peer/secrets.mjs';

// The owner's standing decisions for one session: a short list every turn of that session reads,
// its lead's and its bots' (lib/runner.mjs ownerDecisionsPart), under DECISIONS_HEADING. The bot
// that oversees his sessions keeps it for him at Full (session_update_task, lib/orchestrator-actions.mjs),
// on this computer or from one of his own computers (lib/peer/remote.mjs elu.remote.decisions);
// never in a teammate's session. It may also add to the goal of the session's Task.
//
// Kept with the session's settings (lib/state.mjs changeSettings), so a change made while a turn
// works is kept and read from its next turn:
//   ownerDecisions: ['…', …]           the decisions, in the owner's words, oldest first
//   decisionChanges: [{ at, text, by }] the chat's line for each change ("updated the task: …")
// by: the bot that made the change for him.

export const DECISIONS_MAX = 40, DECISION_MAX = 500, GOAL_ADD_MAX = 4000, CHANGES_KEPT = 100;
export const DECISIONS_HEADING = "Your owner's decisions for this session";
// What a turn is told above them.
export const DECISIONS_NOTE = 'The owner set these for this session. Follow each of them in every turn, as his own instructions, until he changes them.';
const BOT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const plain = value => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();
const cut = (value, most) => value.length > most ? `${value.slice(0, most - 1)}…` : value;

// The decisions of a session, as kept: plain one-line texts.
/** @returns {string[]} */
export function ownerDecisions(task) {
  return (Array.isArray(task?.ownerDecisions) ? task.ownerDecisions : []).filter(row => typeof row === 'string').map(plain).filter(Boolean).slice(0, DECISIONS_MAX);
}
// The lines a turn of the session reads, or none.
export function decisionsBlock(task) {
  const list = ownerDecisions(task);
  return list.length ? [`${DECISIONS_HEADING}:`, DECISIONS_NOTE, ...list.map((text, at) => `${at + 1}. ${text}`)].join('\n') : '';
}
// The chat's lines for the changes, as the owner's: "You · via @orchestrator".
export function decisionLines(task) {
  return (Array.isArray(task?.decisionChanges) ? task.decisionChanges : []).filter(row => isObject(row) && typeof row.text === 'string' && typeof row.at === 'string' && BOT_NAME.test(row.by ?? ''))
    .map(row => ({ role: `You · via @${row.by}`, at: row.at, text: row.text, line: true, via: true }));
}

// A change as a call gives it: { add: [text], change: [{ number, text }], remove: [number], goal: text }.
// Each part optional, at least one given. Numbers are 1-based, as the turn's list shows them.
// Checked whole before anything is kept. Returns { add, change, remove, goal }.
export function checkChange(given) {
  if (!isObject(given)) refuse('Say what to change: add, change, remove or goal.');
  const texts = (value, what) => {
    if (value == null) return [];
    if (!Array.isArray(value) || value.some(row => typeof row !== 'string')) refuse(`Give ${what} as a list of sentences.`);
    return value.map(plain).filter(Boolean);
  };
  const add = texts(given.add, 'the decisions to add');
  const change = given.change == null ? [] : Array.isArray(given.change) ? given.change.map(row => {
    if (!isObject(row) || !Number.isSafeInteger(Number(row.number)) || typeof row.text !== 'string' || !plain(row.text)) refuse('Give each change as { number, text }: the number of the decision as the list shows it, and its new words.');
    return { number: Number(row.number), text: plain(row.text) };
  }) : refuse('Give the changes as a list of { number, text }.');
  const remove = given.remove == null ? [] : Array.isArray(given.remove) && given.remove.every(n => Number.isSafeInteger(Number(n))) ? [...new Set(given.remove.map(Number))] : refuse('Give the decisions to remove as a list of their numbers.');
  const goal = given.goal == null || given.goal === '' ? null : typeof given.goal === 'string' && given.goal.trim() ? given.goal.trim() : refuse('Write what the goal gets as text.');
  if (!add.length && !change.length && !remove.length && goal === null) refuse('Say what to change: add, change, remove or goal.');
  const long = [...add, ...change.map(row => row.text)].find(text => text.length > DECISION_MAX);
  if (long) refuse(`Keep each decision to ${DECISION_MAX} characters. One has ${long.length}.`);
  if (goal && goal.length > GOAL_ADD_MAX) refuse(`Keep what the goal gets to ${GOAL_ADD_MAX} characters.`);
  if (scanSecrets([...add, ...change.map(row => row.text), goal ?? ''].join('\n')).length) refuse('That may hold a secret, so nothing was changed.');
  return { add, change, remove, goal };
}
// The list after the change, and the words of what changed, for the chat and the log.
export function applyChange(list, { add = [], change = [], remove = [] }) {
  const next = [...list], said = [];
  for (const row of change) {
    if (row.number < 1 || row.number > list.length) refuse(`There is no decision ${row.number}: this session has ${list.length}.`);
    next[row.number - 1] = row.text; said.push(`changed ${row.number}: "${cut(row.text, 120)}"`);
  }
  for (const number of remove) if (number < 1 || number > list.length) refuse(`There is no decision ${number}: this session has ${list.length}.`);
  const kept = next.filter((_, at) => !remove.includes(at + 1));
  if (remove.length) said.push(`removed ${remove.sort((a, b) => a - b).map(n => `${n} ("${cut(list[n - 1], 60)}")`).join(', ')}`);
  for (const text of add) { if (!kept.includes(text)) kept.push(text); said.push(`added "${cut(text, 120)}"`); }
  if (kept.length > DECISIONS_MAX) refuse(`A session holds up to ${DECISIONS_MAX} decisions. Remove some first.`);
  return { list: kept, said };
}
// The bot that oversees the owner's sessions updates one of his sessions' task for him: its
// decisions, and what its Task's goal gets. The caller has checked it is his session and the
// bot's level (Full). by: that bot's name. Returns { decisions, said, line, goal }.
// goal: the Task's goal gets these words as one more objective (lib/plan.mjs setGoal, as the
// owner's new goal is set), told to a turn at work at once (realign); with no Task yet it is
// refused: a message to the session gives it the work.
export function updateTask(repo, id, given, { by }) {
  if (!BOT_NAME.test(by ?? '')) refuse('Name the bot that updates the task.');
  const wanted = checkChange(given);
  const before = readTask(repo, String(id)), decisions = { add: wanted.add, change: wanted.change, remove: wanted.remove };
  const preview = applyChange(ownerDecisions(before), decisions), said = [...preview.said];
  let goal = null;
  if (wanted.goal) {
    const plan = sessionTasks(repo, String(id)).findLast(row => ['approved', 'done'].includes(row.state)) ?? null;
    if (!plan) refuse('This session has no agreed Task yet, so its goal cannot grow. Send the session the new work as a message instead.');
    goal = setGoal(repo, String(id), { goal: plan.goal, objectives: [...(Array.isArray(plan.objectives) && plan.objectives.length ? plan.objectives : [plan.goal]), wanted.goal] }, { realign: ['running', 'preparing'].includes(before.state) });
    said.push(`the goal gets "${cut(plain(wanted.goal), 160)}"`);
  }
  const line = `Updated the task: ${said.join('; ')}.`, at = new Date().toISOString();
  const saved = changeSettings(repo, String(id), task => {
    const now = applyChange(ownerDecisions(task), decisions).list;
    if (now.length) task.ownerDecisions = now; else delete task.ownerDecisions;
    task.decisionChanges = [...(Array.isArray(task.decisionChanges) ? task.decisionChanges : []), { at, text: line, by }].slice(-CHANGES_KEPT);
  });
  return { decisions: ownerDecisions(saved), said, line, ...(goal ? { goal: { task: goal.id, revision: goal.revision } } : {}) };
}
