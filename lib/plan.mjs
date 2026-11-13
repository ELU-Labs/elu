import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomic, dataBlock, isObject, noSymlinks, readJson, refuse } from './util.mjs';
import { taskDir, titleFromTask, waitLock } from './state.mjs';

// A session's Task: what its owner agrees to before the work starts. A request that
// changes files, or needs planning, comes back from the model as a proposed Task: a
// title, a description, the goal, the objectives that say when it is done, a priority and
// a severity, the success criteria that show it is done, and the model's estimate of the
// minutes the work takes. The owner approves or rejects it, and ELU starts an editing
// turn only for an approved Task. After approval the model splits the work into subtasks and
// changes them as it likes; the goal and the objectives are the owner's, and change only
// through a new proposal.
// Tasks are kept in plan.json beside the session record, written whole under a lock of
// their own. A turn holds the session record for its whole length and writes it back at
// its end, so an approval kept there would be overwritten; here it never is.

export const PRIORITIES = Object.freeze(['urgent', 'high', 'medium', 'low']);
export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
export const TASK_LIMITS = Object.freeze({ title: 80, description: 2000, goal: 500, objective: 300, objectives: 8, criterion: 200, criteria: 8, minutes: 10080, subtask: 200, subtasks: 30, kept: 20 });
const STATES = ['proposed', 'approved', 'rejected', 'done'], STEPS = ['todo', 'doing', 'done'];
// Control characters, and the marks that reorder or hide text on a screen.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;
// Where a session's Tasks are kept.
export const planFile = (repo, id) => path.join(taskDir(repo, id), 'plan.json');
const file = planFile;
const stored = row => isObject(row) && typeof row.id === 'string' && typeof row.title === 'string' && STATES.includes(row.state) && Array.isArray(row.objectives) && Array.isArray(row.subtasks) && Array.isArray(row.met);

// Every Task of a session, oldest first. An unreadable file reads as none, so it never
// stops a turn; with none, the next request is planned again.
export function sessionTasks(repo, id) {
  try {
    const target = file(repo, id); noSymlinks(target);
    if (!fs.existsSync(target)) return [];
    const value = readJson(target);
    return Array.isArray(value?.tasks) ? value.tasks.filter(stored) : [];
  } catch { return []; }
}
// The Task a session shows: its newest one.
export const currentTask = (repo, id) => sessionTasks(repo, id).at(-1) ?? null;
// The Task whose work is going on: the newest approved one.
export const openTask = rows => rows.findLast(row => row.state === 'approved') ?? null;
// The Task the session's work was agreed under: the open one, or else the newest when it is
// done (a finished Task opens again for more work inside its goal, reopenTask).
export const agreedTask = rows => openTask(rows) ?? (rows.at(-1)?.state === 'done' ? rows.at(-1) : null);
// The Task that waits for the owner: only ever the newest.
export const waitingTask = rows => rows.at(-1)?.state === 'proposed' ? rows.at(-1) : null;
function change(repo, id, edit) {
  const release = waitLock(repo, `plan-${id}`, 200);
  try { const rows = sessionTasks(repo, id), result = edit(rows); atomic(file(repo, id), { version: 1, tasks: rows.slice(-TASK_LIMITS.kept) }); return result; }
  finally { release(); }
}

// A Task is the model's text, so it is checked like any other: plain text of a stated
// length, a priority and a severity from the lists. Markup is shown as typed, never run.
function words(value, max, label, { lines = false } = {}) {
  if (typeof value !== 'string') refuse(`The Task needs ${label}.`);
  const text = lines ? value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').split('\n').map(row => row.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim() : value.replace(/\s+/g, ' ').trim();
  if (!text) refuse(`The Task needs ${label}.`);
  if (CONTROL.test(text)) refuse(`The Task's text holds control characters. Write ${label} as plain text.`);
  if (text.length > max) refuse(`Write ${label} in at most ${max} characters.`);
  return text;
}
// Minutes of work, as the model estimates them: a whole number up to a week, else none.
export const readMinutes = (value, { zero = false } = {}) => Number.isInteger(value) && value >= (zero ? 0 : 1) && value <= TASK_LIMITS.minutes ? value : null;
export function checkProposal(raw) {
  if (!isObject(raw)) refuse('The Task is an object with a title, a description, a goal, objectives, a priority and a severity.');
  if (!Array.isArray(raw.objectives) || raw.objectives.length < 1 || raw.objectives.length > TASK_LIMITS.objectives) refuse(`A Task has 1 to ${TASK_LIMITS.objectives} objectives.`);
  if (!PRIORITIES.includes(raw.priority)) refuse(`A Task's priority is one of: ${PRIORITIES.join(', ')}.`);
  if (!SEVERITIES.includes(raw.severity)) refuse(`A Task's severity is one of: ${SEVERITIES.join(', ')}.`);
  // The success criteria and the estimate are asked for, never required: a Task without them reads as not set.
  const criteria = Array.isArray(raw.criteria) ? raw.criteria.filter(row => typeof row !== 'string' || row.trim()) : [];
  if (criteria.length > TASK_LIMITS.criteria) refuse(`A Task has at most ${TASK_LIMITS.criteria} success criteria.`);
  return {
    title: words(raw.title, TASK_LIMITS.title, 'a title of one line'), description: words(raw.description, TASK_LIMITS.description, 'a description', { lines: true }), goal: words(raw.goal, TASK_LIMITS.goal, 'a goal'),
    objectives: raw.objectives.map(row => words(row, TASK_LIMITS.objective, 'each objective as one line')), priority: raw.priority, severity: raw.severity,
    criteria: criteria.map(row => words(row, TASK_LIMITS.criterion, 'each success criterion as one line')), estimateMinutes: readMinutes(raw.estimateMinutes),
  };
}
// Subtasks are the model's own business: a row that does not read is left out, never refused.
function readSubtasks(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, TASK_LIMITS.subtasks).flatMap(row => { const text = typeof row?.text === 'string' ? row.text.replace(/\s+/g, ' ').trim().slice(0, TASK_LIMITS.subtask) : ''; return text && !CONTROL.test(text) ? [{ text, state: STEPS.includes(row.state) ? row.state : 'todo' }] : []; })
    .map((row, index) => ({ id: `s${index + 1}`, ...row }));
}

// The fields a reply carries, added to the schema every vendor is already given. Only
// constructs the result schema already uses: a list of objects, strings, enums.
// propose: the reply may hold a Task (a list of one, or empty). progress: it reports
// subtasks and the objectives that are met.
const TASK_SCHEMA = () => ({ type: 'object', additionalProperties: false, properties: {
  title: { type: 'string', maxLength: TASK_LIMITS.title }, description: { type: 'string', maxLength: TASK_LIMITS.description }, goal: { type: 'string', maxLength: TASK_LIMITS.goal },
  objectives: { type: 'array', maxItems: TASK_LIMITS.objectives, items: { type: 'string', maxLength: TASK_LIMITS.objective } }, priority: { type: 'string', enum: [...PRIORITIES] }, severity: { type: 'string', enum: [...SEVERITIES] },
  criteria: { type: 'array', maxItems: TASK_LIMITS.criteria, items: { type: 'string', maxLength: TASK_LIMITS.criterion } }, estimateMinutes: { type: 'integer' },
}, required: ['title', 'description', 'goal', 'objectives', 'priority', 'severity', 'criteria', 'estimateMinutes'] });
export function planSchema(schema, { propose = false, progress = false } = {}) {
  if (propose) { schema.properties.task = { type: 'array', maxItems: 1, items: TASK_SCHEMA() }; schema.required.push('task'); }
  if (progress) {
    schema.properties.subtasks = { type: 'array', maxItems: TASK_LIMITS.subtasks, items: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', maxLength: TASK_LIMITS.subtask }, state: { type: 'string', enum: [...STEPS] } }, required: ['text', 'state'] } };
    schema.properties.objectivesMet = { type: 'array', maxItems: TASK_LIMITS.objectives, items: { type: 'integer' } };
    schema.properties.etaMinutes = { type: ['integer', 'null'] };
    schema.required.push('subtasks', 'objectivesMet', 'etaMinutes');
  }
  return schema;
}
// Takes the Task fields off a reply before the result's own check, which accepts no other
// key. strict: a Task that does not read is refused, so the model is asked for it once
// more; the second time it is left out and the reply is kept as a plain answer.
export function readPlanReply(value, { propose = false, progress = false, strict = true } = {}) {
  if (!isObject(value)) return { rest: value, reply: null };
  const { task, subtasks, objectivesMet, etaMinutes, ...rest } = value, reply = {};
  const given = Array.isArray(task) ? task : task == null ? [] : [task];
  if (propose && given.length) {
    try { if (given.length > 1) refuse('Return one Task at most.'); reply.proposal = checkProposal(given[0]); }
    catch (error) { if (strict) throw error; reply.unread = true; }
  }
  if (progress) {
    const steps = readSubtasks(subtasks), met = Array.isArray(objectivesMet) ? [...new Set(objectivesMet.filter(row => Number.isInteger(row) && row >= 1 && row <= TASK_LIMITS.objectives))].sort((a, b) => a - b) : [];
    if (steps.length) reply.subtasks = steps;
    if (met.length) reply.met = met;
    const eta = readMinutes(etaMinutes, { zero: true });
    if (eta !== null) reply.eta = eta;
  }
  return { rest, reply: Object.keys(reply).length ? reply : null };
}

const newId = () => `t-${crypto.randomBytes(4).toString('hex')}`;
// Records what the model proposed. A Task that already waits is replaced by this one as
// its next revision. startedBy says who started the work: the owner, who approves it first;
// a schedule, which has nobody to approve; or a teammate's handoff the owner chose to work
// on. The last two are recorded as approved at once, and a Task that waits for the owner
// stays the one on the card.
// edit: what approval starts ({ intent, repository, bot, request }); it stays on this machine.
export function proposeTask(repo, id, fields, { by = 'lead', startedBy = 'owner', edit = null } = {}) {
  const now = new Date().toISOString();
  return nameSession(repo, id, change(repo, id, rows => {
    const waiting = waitingTask(rows), blank = { id: newId(), session: String(id), revision: 1, ...fields, state: 'proposed', startedBy, by, proposedAt: now, approvedAt: null, rejectedAt: null, doneAt: null, subtasks: [], met: [], edit };
    if (startedBy !== 'owner') {
      const task = { ...blank, state: 'approved', approvedAt: now, edit: null };
      rows.splice(waiting ? rows.length - 1 : rows.length, 0, task); return task;
    }
    if (waiting) return Object.assign(waiting, fields, { revision: waiting.revision + 1, by, proposedAt: now, edit });
    rows.push(blank); return blank;
  }));
}
// A session is named after its approved Task, unless the owner named it (lib/state.mjs).
// The name is cosmetic: a session that cannot take it keeps the name it shows.
function nameSession(repo, id, task) {
  if (task.state === 'approved') { try { titleFromTask(repo, id, task.title); } catch { /* The session keeps the name it shows. */ } }
  return task;
}
export function approveTask(repo, id) {
  return nameSession(repo, id, change(repo, id, rows => Object.assign(waitingTask(rows) ?? refuse('No Task waits for your approval in this session.'), { state: 'approved', approvedAt: new Date().toISOString() })));
}
export function rejectTask(repo, id) {
  return change(repo, id, rows => Object.assign(waitingTask(rows) ?? refuse('No Task waits for your approval in this session.'), { state: 'rejected', rejectedAt: new Date().toISOString() }));
}
// What may leave this machine or be shown to someone else: the Task and its progress,
// never edit, which names a repository path and the owner's own message. A Task from before
// success criteria and estimates carries none: no criteria, and no estimate.
export const sharedTask = task => task ? { id: task.id, session: task.session, revision: task.revision, title: task.title, description: task.description, goal: task.goal, objectives: [...task.objectives], priority: task.priority, severity: task.severity,
  state: task.state, startedBy: task.startedBy, by: task.by, proposedAt: task.proposedAt, approvedAt: task.approvedAt, rejectedAt: task.rejectedAt, doneAt: task.doneAt, subtasks: task.subtasks.map(({ id, text, state }) => ({ id, text, state })), met: [...task.met],
  criteria: Array.isArray(task.criteria) ? [...task.criteria] : [], estimateMinutes: readMinutes(task.estimateMinutes), etaMinutes: readMinutes(task.etaMinutes, { zero: true }), etaAt: typeof task.etaAt === 'string' ? task.etaAt : null } : null;
// When the work is expected to be done, in ms, or null when nobody estimated it. The model's
// last revision (etaMinutes from etaAt) wins over its first estimate, which counts from approval,
// else from the proposal. Takes a Task as it is kept, shared or told.
export function taskEta(task) {
  const from = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : null; };
  const revised = readMinutes(task?.etaMinutes, { zero: true }), revisedAt = from(task?.etaAt);
  if (revised !== null && revisedAt !== null) return revisedAt + revised * 60000;
  const estimate = readMinutes(task?.estimateMinutes), start = from(task?.approvedAt) ?? from(task?.proposedAt);
  return estimate !== null && start !== null ? start + estimate * 60000 : null;
}
// The approved Task whose work has not started yet, or null.
export function taskToStart(repo, id) {
  const task = openTask(sessionTasks(repo, id));
  return task?.edit && task.edit.started !== true ? task : null;
}
export function markStarted(repo, id) {
  return change(repo, id, rows => { const task = openTask(rows); if (task?.edit) task.edit.started = true; return task; });
}
// What the model reports while it works. The goal and the objectives are not among the
// fields a report can carry. eta: the minutes it now thinks are left, kept with when it said so.
export function reportProgress(repo, id, { subtasks, met, eta = null } = {}) {
  if (!subtasks && !met && eta === null) return null;
  return change(repo, id, rows => {
    const task = openTask(rows); if (!task) return null;
    if (subtasks) task.subtasks = subtasks;
    if (met) task.met = met.filter(row => row <= task.objectives.length);
    if (eta !== null) Object.assign(task, { etaMinutes: eta, etaAt: new Date().toISOString() });
    return task;
  });
}
// A finished Task opens again when the owner sends more work inside its goal.
export function reopenTask(repo, id) {
  return change(repo, id, rows => { const task = rows.at(-1); if (task?.state === 'done') Object.assign(task, { state: 'approved', doneAt: null }); return task ?? null; });
}
// Done: the model reports every objective met, and the turn that did the work has ended.
export function finishTask(repo, id) {
  const open = openTask(sessionTasks(repo, id));
  if (!open || open.met.length < open.objectives.length) return null;
  return change(repo, id, rows => { const task = openTask(rows); if (task && task.met.length >= task.objectives.length) Object.assign(task, { state: 'done', doneAt: new Date().toISOString() }); return task; });
}

// The same at the end of a turn, where a Task that cannot be closed never fails the turn.
export function closeTask(repo, id) { try { return finishTask(repo, id); } catch { return null; } }

// What one turn is told about Tasks and may return. first: the turn that answers a
// message; work: an editing turn, which reports progress and proposes nothing.
// covered: the session has a Task the owner approved, so work inside its goal may go on.
// unattended: what started the turn when its Task waits for nobody (schedule or handoff), else false.
export function turnPlan(repo, id, { work = false, unattended = false } = {}) {
  const rows = sessionTasks(repo, id), open = openTask(rows);
  if (work) return open ? { propose: false, progress: true, work: true, open } : null;
  const agreed = agreedTask(rows);
  return { propose: true, progress: Boolean(agreed), waiting: waitingTask(rows), open: agreed, covered: Boolean(agreed), unattended };
}
const shown = task => ({ title: task.title, description: task.description, goal: task.goal, objectives: task.objectives.map((text, index) => `${index + 1}. ${text}`), priority: task.priority, severity: task.severity, state: task.state, revision: task.revision, subtasks: task.subtasks.map(({ text, state }) => ({ text, state })), objectivesMet: task.met,
  criteria: Array.isArray(task.criteria) ? task.criteria : [], estimateMinutes: readMinutes(task.estimateMinutes), ...(readMinutes(task.etaMinutes, { zero: true }) !== null ? { etaMinutes: task.etaMinutes } : {}) });
const FIELDS = `a title (one line), a description of the work, the goal, the objectives that say when it is done (one line each), a priority (urgent, high, medium or low), a severity (critical, high, medium or low), the success criteria in criteria (1 to ${TASK_LIMITS.criteria} short statements, one line each, that can be checked to know the work is done) and in estimateMinutes your estimate of the minutes the work takes from approval to done`;
const PROGRESS = 'Break the work into subtasks as you see fit and change them freely; they need no approval. Put the list as it stands in subtasks, each todo, doing or done, or leave subtasks empty to keep the list as it is. In objectivesMet give the numbers of the objectives that are met now. In etaMinutes give the minutes of work you think are left until it is done, or null to keep the last estimate.';
// The rule as every vendor's model is told it. What ELU enforces is the gate in
// ProjectController.ask: an editing turn starts only for an approved Task.
export function planPrompt(plan) {
  if (!plan) return [];
  if (plan.work) return [`The owner approved the Task below, and this turn does its work. Meet every objective. ${PROGRESS} The goal and the objectives are the owner's: if one has to change, stop, return outcome needs_input and say what should change.`, dataBlock('Approved Task', shown(plan.open))];
  const parts = [`Plan first. When the owner asks for a change to code or files, or for work that needs planning, change nothing in this turn: read what you need, then put one Task in task with ${FIELDS}, and say in the summary what you found and how you would do it. ${plan.unattended === 'handoff' ? 'The owner chose to work on this handoff from a teammate: the Task is recorded as started by handoff and the work goes on.' : plan.unattended ? 'A schedule started this turn and nobody is there to approve: the Task is recorded as started by schedule and the work goes on.' : 'The owner approves or rejects the Task, and the work starts only after they approve.'} When you must ask the owner something before you can write the Task, ask it and leave task empty; the Task comes with a later reply. A question, an explanation or a greeting gets a plain answer and an empty task list.`];
  if (plan.waiting) parts.push('The Task below waits for the owner\'s approval. When their message asks for changes to it, return the whole Task again in task, revised. When it only asks about it, answer and leave task empty: the Task stays as it is. Only the owner approves it, with a key; do not start its work.', dataBlock('Task waiting for approval', shown(plan.waiting)));
  else if (plan.open) parts.push(`The owner approved the Task below. Work inside its goal needs no new Task: leave task empty. A new piece of work needs a Task of its own in task. To change the goal or an objective, return the whole revised Task in task; it needs the owner's approval again. ${PROGRESS}`, dataBlock('Approved Task', shown(plan.open)));
  return parts;
}
export const NEEDS_TASK = `A request that changes files needs a Task first. Change nothing, set intent to edit, and put one Task in task with ${FIELDS}.`;
const NO_TASK = 'No Task was read from this reply, so nothing was changed. Send your request again.';
const STILL_WAITS = 'The Task still waits for your approval, so nothing was changed.';
const asAnswer = (response, line) => { response.intent = 'answer'; delete response.repository; if (line) response.summary = `${response.summary.slice(0, 3800)}\n\n${line}`; };
// What a first turn's reply does to the session's Tasks. Returns held when the reply
// must not start an edit: a Task now waits for the owner, or none was read. The reply is
// then kept as an answer, so the session rests where an answer leaves it.
// message: the owner's request. by: who answered, lead or @name. bot: the working bot that would make the edit.
export function settleReply(repo, task, response, { plan, message, by = 'lead', bot = null } = {}) {
  const reply = response.plan ?? null; delete response.plan;
  const edit = response.intent === 'edit' && response.outcome === 'done';
  // A reply that asks the owner something first proposes nothing yet: its Task comes with the answer.
  const proposal = response.outcome === 'done' ? reply?.proposal ?? null : null;
  if (reply?.subtasks || reply?.met || reply?.eta != null) reportProgress(repo, task.id, reply);
  if (proposal) {
    if (plan.unattended) { proposeTask(repo, task.id, proposal, { by, startedBy: plan.unattended === 'handoff' ? 'handoff' : 'schedule' }); return null; }
    proposeTask(repo, task.id, proposal, { by, edit: { intent: response.intent, repository: response.repository ?? null, bot, request: message, started: false } });
    if (edit) asAnswer(response);
    return 'held';
  }
  if (!edit) return null;
  if (plan.waiting) { asAnswer(response, STILL_WAITS); return 'held'; }
  if (plan.covered) { reopenTask(repo, task.id); return null; }
  asAnswer(response, NO_TASK); return 'held';
}
// The model's own to-do list as its vendor prints it while the turn runs. Claude Code sends the
// whole list in a TodoWrite call, or one step at a time with TaskCreate and TaskUpdate (the
// step's number comes back in the call's result). Codex prints a todo_list item, which marks a
// step done or not: its first open step shows as the one in hand. An ACP vendor (Antigravity,
// Grok Build) sends a plan update. liveTodos() keeps one turn's steps and returns a reader: it
// takes a line and returns the subtasks the list now reads as, or null when the line changes
// nothing. A helper's list (parent_tool_use_id) is not the Task's.
const TODO_STATES = { pending: 'todo', in_progress: 'doing', completed: 'done' };
const resultText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n') : '';
export function liveTodos() {
  const steps = [];
  let next = 1;
  return row => {
    let list = null;
    const parts = !row?.parent_tool_use_id && Array.isArray(row?.message?.content) ? row.message.content : [];
    if (row?.type === 'assistant') for (const part of parts) {
      if (part?.type !== 'tool_use') continue;
      const input = part.input ?? {};
      if (part.name === 'TodoWrite' && Array.isArray(input.todos)) list = input.todos.map(todo => ({ text: todo?.content, state: TODO_STATES[todo?.status] ?? 'todo' }));
      else if (part.name === 'TaskCreate' && typeof input.subject === 'string') { steps.push({ id: String(next++), call: part.id, text: input.subject, state: 'todo' }); list = steps; }
      else if (part.name === 'TaskUpdate' && input.taskId != null) {
        const at = steps.findIndex(step => step.id === String(input.taskId));
        if (at < 0) continue;
        if (input.status === 'deleted') steps.splice(at, 1);
        else { if (TODO_STATES[input.status]) steps[at].state = TODO_STATES[input.status]; if (typeof input.subject === 'string' && input.subject.trim()) steps[at].text = input.subject; }
        list = steps;
      }
    } else if (row?.type === 'user') for (const part of parts) {
      // The number Claude Code gave a new step: later updates name the step by it.
      const step = part?.type === 'tool_result' && typeof part.tool_use_id === 'string' ? steps.find(step => step.call === part.tool_use_id) : null;
      const id = step ? row.tool_use_result?.task?.id ?? /Task #(\d+)/.exec(resultText(part.content))?.[1] : null;
      if (id != null) { step.id = String(id); if (Number(id) >= next) next = Number(id) + 1; }
    } else if (/^item\.(started|updated|completed)$/.test(row?.type ?? '') && row.item?.type === 'todo_list' && Array.isArray(row.item.items)) {
      const open = row.item.items.findIndex(item => item?.completed !== true);
      list = row.item.items.map((item, index) => ({ text: item?.text, state: item?.completed === true ? 'done' : index === open ? 'doing' : 'todo' }));
    } else if (row?.method === 'session/update' && row.params?.update?.sessionUpdate === 'plan' && Array.isArray(row.params.update.entries)) {
      list = row.params.update.entries.map(entry => ({ text: entry?.content, state: TODO_STATES[entry?.status] ?? 'todo' }));
    }
    const read = list ? readSubtasks(list) : [];
    return read.length ? read : null;
  };
}
// One line read on its own, with no steps kept from the lines before it.
export const liveSubtasks = row => liveTodos()(row);
// What an editing turn's reply reports. Returns the reply without the Task fields.
export function settleWork(repo, id, result) {
  const reply = result?.plan ?? null;
  if (result) delete result.plan;
  if (reply) { try { reportProgress(repo, id, reply); } catch { /* A report that cannot be kept never fails the work. */ } }
  return result;
}
// The owner's own short yes, typed instead of the key.
export const saysYes = text => /^(y|yes|ok|okay|approve|approved|go|go ahead|do it|lgtm)[.! ]*$/i.test(String(text ?? '').trim());
