import { ink, wrapText } from './terminal-visuals.mjs';
import { MODE_NAMES, taskEta } from './plan.mjs';

// How a session's Task (lib/plan.mjs) reads on screen: the card in its chat and the line
// in its status row. Every field is the model's text, so each goes through ink() as
// untrusted text: markup shows as typed.

const WAITS = 'waits for your approval';
const MARK = { todo: '[ ]', doing: '[~]', done: '[x]' };
const subtasksDone = plan => plan.subtasks.filter(row => row.state === 'done').length;
// approved · 2 of 5 subtasks done; or where the Task stands otherwise.
export function taskState(plan) {
  if (plan.state === 'proposed') return WAITS;
  if (plan.state === 'rejected') return 'rejected';
  if (plan.state === 'done') return `done · ${plan.met.length} of ${plan.objectives.length} objectives reported met`;
  const steps = plan.subtasks.length ? `${subtasksDone(plan)} of ${plan.subtasks.length} subtasks done` : plan.edit && plan.edit.started !== true ? 'starting' : 'no subtasks yet';
  return `approved · ${steps}`;
}
const TONE = { proposed: 'orange', approved: 'blue', done: 'green', rejected: 'muted' };
// Who let the Task's work start when it was not the owner's own yes: the session's mode
// (Approve for me, Full access), a schedule or a handoff. Empty for one he approved himself.
export const taskLetBy = plan => MODE_NAMES[plan?.approvedBy] ? `approved by ${MODE_NAMES[plan.approvedBy]}` : plan?.startedBy === 'schedule' ? 'started by schedule' : plan?.startedBy === 'handoff' ? 'started by a handoff' : '';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 9:40 PM today; Nov 14 9:40 PM on another day. Local time, as the clock on the screen.
export function clockTime(at, now = Date.now()) {
  const day = new Date(at), today = new Date(now), hours = day.getHours();
  const text = `${hours % 12 || 12}:${String(day.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
  return day.toDateString() === today.toDateString() ? text : `${MONTHS[day.getMonth()]} ${day.getDate()} ${text}`;
}
// 25 min, 2 h 5 min, 3 d 4 h.
export function minutesText(minutes) {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  const hours = Math.floor((minutes % 1440) / 60);
  return `${Math.floor(minutes / 1440)} d${hours ? ` ${hours} h` : ''}`;
}
// When the Task's work is expected done (lib/plan.mjs taskEta), as the ETA line reads it:
// 9:40 PM · in 25 min; 9:00 PM · overdue by 10 min; done 8:12 PM; not set.
export function etaText(plan, now = Date.now()) {
  if (plan.state === 'done') { const at = Date.parse(plan.doneAt ?? ''); return Number.isFinite(at) ? `done ${clockTime(at, now)}` : 'done'; }
  const at = taskEta(plan); if (at === null) return 'not set';
  const left = Math.round((at - now) / 60000);
  return `${clockTime(at, now)} · ${left > 0 ? `in ${minutesText(left)}` : left < 0 ? `overdue by ${minutesText(-left)}` : 'due now'}`;
}
// Where a session's Task card sits in its chat: after the reply that proposed it, before
// anything that came later. entries: the chat's entries, oldest first. Says how many of them
// come before the card. A bot's reply is noted a moment after its Task is, so the card follows
// what the bot said then. A Task that does not say when it was proposed comes after them all.
// An entry that says no time is as late as the one before it (inTimeOrder, lib/run-activity.mjs).
export function taskPlace(entries, plan) {
  const at = Date.parse(plan?.proposedAt ?? '');
  if (!Number.isFinite(at)) return entries.length;
  let last = -Infinity;
  let count = entries.map(entry => { const time = Date.parse(entry.at ?? ''); if (Number.isFinite(time)) last = time; return last; }).findLastIndex(time => !(time > at)) + 1;
  const bot = plan.by && plan.by !== 'lead' ? String(plan.by).replace(/^@/, '') : null;
  while (bot && count < entries.length && entries[count].bot === bot && Date.parse(entries[count].at ?? '') - at < 2000) count++;
  return count;
}
// approval: an approval of an action waits in the same session; y and n answer that one first.
export function taskCard(plan, { width, colour = true, approval = false, now = Date.now() } = {}) {
  const row = (text, tone, bold = false, indent = '') => wrapText(text, Math.max(8, width - indent.length)).map((line, index) => ink(`${index ? ' '.repeat(indent.length) : indent}${line}`, tone, colour, bold)).join('\n');
  if (plan.state === 'rejected') return row(`Task rejected: ${plan.title}`, 'muted');
  const who = [plan.by && plan.by !== 'lead' ? `proposed by ${plan.by}` : '', taskLetBy(plan)].filter(Boolean);
  const lines = [
    row(`Task · ${taskState(plan)}${plan.state === 'proposed' && plan.revision > 1 ? ` · revision ${plan.revision}` : ''}`, TONE[plan.state], true),
    row(plan.title, 'text', true),
    row([`${plan.priority} priority`, `${plan.severity} severity`, ...who].join(' · '), 'muted'),
    row(`ETA ${etaText(plan, now)}`, 'muted'),
  ];
  if (plan.state === 'proposed') lines.push(...plan.description.split('\n').map(text => text ? row(text, 'text') : ''));
  lines.push(row(`Goal: ${plan.goal}`, 'text'), ink('Objectives', 'muted', colour));
  plan.objectives.forEach((text, index) => { const met = plan.met.includes(index + 1); lines.push(row(`${index + 1}. ${text}`, met ? 'green' : 'text', false, plan.state === 'proposed' ? '  ' : met ? '  ✓ ' : '  · ')); });
  // A Task from before success criteria has none: not set.
  const criteria = Array.isArray(plan.criteria) ? plan.criteria : [];
  lines.push(ink(`Success criteria${criteria.length ? '' : ' · not set'}`, 'muted', colour));
  for (const text of criteria) lines.push(row(text, 'text', false, '  · '));
  if (plan.subtasks.length) { lines.push(ink('Subtasks', 'muted', colour)); for (const step of plan.subtasks) lines.push(row(step.text, step.state === 'done' ? 'muted' : step.state === 'doing' ? 'blue' : 'text', false, `  ${MARK[step.state] ?? MARK.todo} `)); }
  if (plan.state === 'proposed') lines.push(ink(approval ? 'y and n answer the approval below first. Then: y approve · n reject, Enter' : 'y approve · n reject, then Enter · or type what to change', 'muted', colour));
  return lines.join('\n');
}
// The status line of a session whose Task waits: its keys, then its name. The keys are never cut:
// the longest form that leaves the name twelve columns, else the longest that fits with no name,
// in fewer words down to the letters alone, so the row always ends at Enter.
const TASK_KEYS = ['? Needs you · y approve · n reject, then Enter', '? y approve · n reject, then Enter', '? y approve · n reject, Enter'], TASK_LETTERS = '? y · n, Enter';
export function taskNeedsYou(plan, width = Infinity) {
  const named = TASK_KEYS.find(form => width - form.length - 3 >= 12), keys = named ?? TASK_KEYS.find(form => form.length < width) ?? TASK_LETTERS;
  return named || keys === TASK_LETTERS && width - keys.length - 3 >= 12 ? `${keys} · Task: ${plan.title}` : keys;
}
