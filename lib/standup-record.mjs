import fs from 'node:fs';
import { isObject } from './util.mjs';
import { lastActivity } from './kanban.mjs';
import { currentTask } from './plan.mjs';
import { finished } from './task-head.mjs';
import { conversationEntries, modelLabel, reportedModels, sessionModel } from './projects.mjs';
import { cleanText, firstLines, liveSteps, oneLine, standupAgent, standupWaits } from './standup.mjs';

// What ELU has on record for a session, read with no model run (README, "Standup"). A
// standup shows it at once for every session it asks, here and on the owner's other
// computers, so a session that works never makes it wait: its state (working and for how
// long, waiting for him and for what, blocked or stopped and why, finished), its Task and the
// subtasks done, the last things it said and did in the turn it is in (the newest lines of its
// live activity: its last text, its last command, the last file it changed), its pull request
// or branch, and when it last wrote anything. Another computer of his sends the same from its
// own records (lib/peer/standup.mjs). Each value is whole: what the owner reads of it is cut
// to a line where it is shown (recordLines), and the Standup's model reads it as it is.

const WORKING = ['running', 'preparing'];
const time = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : 0; };
const iso = ms => ms ? new Date(ms).toISOString() : null;
const COMMAND = /^Run: /, FILE = /^(?:Edit|Write): /;
// The newest of the turn's steps: what it wrote last, the last command it ran, the last file it
// changed, and its newest step of any kind.
function lastSteps(steps) {
  const main = steps.filter(step => !step.sub), tools = main.filter(step => step.kind === 'tool');
  const said = main.findLast(step => step.kind === 'text')?.text ?? null;
  const command = tools.findLast(step => COMMAND.test(step.text)), file = tools.findLast(step => FILE.test(step.text)), step = tools.at(-1);
  return { said, command: command ? command.text.replace(COMMAND, '') : null, file: file ? file.text.replace(FILE, '') : null, step: step && step !== command && step !== file ? step.text : null };
}
// The record of one session of this computer. waits: what it waits on its owner for
// (standupWaits). who: its model or bot, as the chat names it. said: its last reply, for a
// session that is in no turn.
export function sessionRecord(repo, task, { now = Date.now(), plan = undefined, approvals = [], waits = undefined, who = null, said = null } = {}) {
  let task0 = plan; if (task0 === undefined) { try { task0 = currentTask(repo, task.id); } catch { task0 = null; } }
  const waiting = waits === undefined ? standupWaits(task, { plan: task0, approvals }) : waits;
  const working = WORKING.includes(task.state), steps = working ? liveSteps(repo, task) : [], last = lastSteps(steps);
  // When it last wrote anything: its live log while it works (the start of its turn before the
  // first line), else its last run or message.
  let wrote = lastActivity(task);
  if (working) {
    let live = time(task.activeSince);
    try { if (typeof task.activeLog === 'string') live = Math.max(live, Math.round(fs.statSync(task.activeLog).mtimeMs)); } catch { /* Not started yet. */ }
    if (live) wrote = live;
  }
  const state = waiting ? 'waiting' : working ? 'working' : task.state === 'blocked' ? 'blocked' : task.state === 'stopped' ? 'stopped' : 'finished';
  const reason = ['blocked', 'stopped'].includes(state) && typeof task.error?.message === 'string' ? task.error.message : null;
  // A session whose agent committed all of its own work is finished with nothing left to verify (lib/task-head.mjs).
  const detail = state !== 'finished' ? null : finished(task) ? 'committed' : task.state === 'ready' ? 'ready to publish' : task.state === 'unverified' ? 'not verified' : null;
  const subtasks = Array.isArray(task0?.subtasks) ? task0.subtasks : [];
  return {
    state, ...(detail ? { detail } : {}), ...(working && task.activeSince ? { since: task.activeSince } : {}),
    ...(waiting ? { question: waiting.question } : {}), ...(reason ? { reason } : {}),
    ...(task0 ? { task: { title: task0.title, state: task0.state, done: subtasks.filter(row => row.state === 'done').length, of: subtasks.length, ...(subtasks.find(row => row.state === 'doing') ? { now: subtasks.find(row => row.state === 'doing').text } : {}) } } : {}),
    ...(working ? Object.fromEntries(Object.entries(last).filter(([, value]) => value)) : said ? { said } : {}),
    ...(typeof task.pr === 'string' && task.pr ? { pr: task.pr } : {}), ...(typeof task.branch === 'string' && task.branch ? { branch: task.branch } : {}),
    ...(wrote ? { at: iso(wrote) } : {}), ...(who ? { who } : {}),
  };
}
// The record of a session of this computer with who answers for it (its model, or the bot
// that works in it) and, for one in no turn, its last reply.
export function localRecord(repo, task, options = {}) {
  let who = null, said = null;
  try { const agent = standupAgent(task); who = agent.bot ? `@${agent.bot.name}` : modelLabel(sessionModel(repo, task) ?? { vendor: 'claude', model: null }, reportedModels([task])); } catch { who = null; }
  if (!WORKING.includes(task.state)) { try { said = conversationEntries(repo, task).findLast(entry => entry.lead || entry.bot)?.text ?? null; } catch { said = null; } }
  return sessionRecord(repo, task, { ...options, who, said });
}
// A record another computer sent, as this one keeps it: only the fields a record has, each
// with no escapes or controls. null when it is not one.
const STATES = ['working', 'waiting', 'finished', 'blocked', 'stopped'], TEXTS = ['detail', 'question', 'reason', 'said', 'command', 'file', 'step', 'pr', 'branch', 'who'];
export function cleanRecord(value) {
  if (!isObject(value) || !STATES.includes(value.state)) return null;
  const out = { state: value.state };
  for (const name of TEXTS) if (typeof value[name] === 'string' && value[name].trim()) out[name] = cleanText(value[name], Infinity);
  for (const name of ['since', 'at']) if (time(value[name])) out[name] = iso(time(value[name]));
  const task = value.task;
  if (isObject(task) && typeof task.title === 'string') out.task = { title: cleanText(task.title, Infinity), state: cleanText(String(task.state ?? ''), 20), done: Number.isSafeInteger(task.done) ? task.done : 0, of: Number.isSafeInteger(task.of) ? task.of : 0, ...(typeof task.now === 'string' && task.now.trim() ? { now: cleanText(task.now, Infinity) } : {}) };
  return out;
}
// A record made from what this computer last listed of a session on another one
// (lib/peer/remote.mjs), for the moment before that computer's own record is in, and for one
// whose ELU is too old to send it.
export function listedRecord(row) {
  const working = ['running', 'preparing', 'starting'].includes(row.state);
  const state = row.waits ? 'waiting' : working ? 'working' : row.state === 'blocked' ? 'blocked' : row.state === 'stopped' ? 'stopped' : 'finished';
  return { state, ...(state === 'finished' && row.state === 'committed' ? { detail: 'committed' } : {}), ...(row.waits ? { question: row.waits } : {}), ...(row.error && ['blocked', 'stopped'].includes(state) ? { reason: row.error } : {}), ...(row.at ? { at: iso(row.at) } : {}) };
}
// How long ago, or for how long: 45 s, 12 min, 1 h 40 min, 3 d.
export function span(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000)), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  if (seconds < 60) return `${seconds} s`;
  if (minutes < 60) return `${minutes} min`;
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
const TASK_STATES = { proposed: 'Task to approve', approved: 'Task', done: 'Task done', rejected: 'Task declined' };
// The record as the Standup chat shows it, a few plain lines: what it waits for first.
export function recordLines(record, now = Date.now()) {
  if (!record) return [];
  const ago = record.at ? ` · last wrote ${span(now - time(record.at))} ago` : '';
  const head = record.state === 'waiting' ? `Waiting for you: ${oneLine(record.question, 300) || 'it asks you'}`
    : record.state === 'working' ? `Working${record.since ? ` for ${span(now - time(record.since))}` : ''}`
    : record.state === 'blocked' ? `Blocked${record.reason ? `: ${oneLine(record.reason, 300)}` : ''}`
    : record.state === 'stopped' ? `Stopped${record.reason ? `: ${oneLine(record.reason, 300)}` : ''}`
    : `Finished${record.detail ? ` · ${record.detail}` : ''}`;
  const task = record.task, steps = task?.of ? ` · ${task.done} of ${task.of} subtasks done` : '';
  return [
    `${head}${ago}`,
    task && !(record.state === 'waiting' && task.state === 'proposed') ? `${TASK_STATES[task.state] ?? 'Task'}: ${oneLine(task.title, 120)}${steps}${task.now ? ` · now: ${oneLine(task.now, 120)}` : ''}` : '',
    record.said ? `Last said: ${firstLines(record.said, 2, 240)}` : '',
    record.command ? `Last command: ${oneLine(record.command, 200)}` : '',
    record.file ? `Last file: ${oneLine(record.file, 200)}` : '',
    record.step && !record.command && !record.file ? `Last step: ${oneLine(record.step, 200)}` : '',
    record.pr ? `Pull request: ${oneLine(record.pr, 200)}` : record.branch ? `Branch: ${oneLine(record.branch, 200)}` : '',
  ].filter(Boolean);
}
