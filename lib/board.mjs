import { relativeTime, remote, peerName, threadWho, fitWords } from './terminal-visuals.mjs';
import { untilText } from './schedules.mjs';
import { botWork } from './bots.mjs';
import { requestGoal, sessionGoal, taskTitle } from './state.mjs';
import { fromTeammate } from './modes.mjs';
import { HOME_QUESTION } from './util.mjs';
import { stopLine } from './stop-line.mjs';
import { waitMark, waitOf, waitShort } from './waiting.mjs';
import { committedLine, finished } from './task-head.mjs';
import { heldBySession, lastActivity, rowSince } from './kanban.mjs';
import { startsAt } from './workspace.mjs';
import { runCosts } from './agent-spend.mjs';
import { columns, cut, head, padEnd, padStart } from './width.mjs';

// One row per agent run, waiting question, queued request, or recent result, across
// every project. Rows needing the owner come first, then live work, then the queue.
const FINISHED = ['answered', 'ready', 'unverified', 'blocked', 'stopped'];
const DAY = 24 * 60 * 60 * 1000;
const time = value => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; };
const clock = ms => { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 3600 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}` : `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}`; };
const firstLine = value => String(value ?? '').split('\n').find(line => line.trim())?.trim() ?? '';
// A row's time as text, from where it counts (rowSince, lib/kanban.mjs): a turn that works
// counts up, anything else says how long ago. For a session here and for one on another
// computer of the owner's.
export const rowTime = (since, now = Date.now()) => since.run ? clock(now - time(since.at)) : relativeTime(since.at, now);
// What a session's runs cost, each run's own cost once (runCosts), as text: $1.20, ≥$1.20 when a
// run reported none, or -. It is worked out when it is read, not for every session each time
// the list is built: a run recorded before 0.1.20 is read from its log for it.
const cost = task => ({
  toString() {
    const costs = runCosts(task), known = costs.filter(Number.isFinite);
    return known.length ? `${known.length < costs.length ? '≥' : ''}$${known.reduce((sum, value) => sum + value, 0).toFixed(2)}` : '-';
  },
  toJSON() { return this.toString(); },
});
// The newest thing a session did: its latest activity row that carries a step.
function latestStep(project, id) {
  for (let index = project.activity.length - 1; index >= 0; index--) {
    const row = project.activity[index];
    if (typeof row.step === 'string' && String(row.taskId) === String(id)) return firstLine(row.step);
  }
  return '';
}
function working(task) {
  if (task.state === 'preparing') return { agent: 'lead', label: 'preparing' };
  if (!task.activeRole) return { agent: 'checks', label: 'checks' };
  if (task.activeRole === 'lead') return { agent: 'lead', label: task.kind === 'conversation' ? 'answering' : 'editing' };
  return botWork(task) ?? { agent: task.activeRole, label: 'reviewing' };
}
function outcome(task) {
  const checks = task.evidence?.results, passed = checks?.filter(row => ['passed', 'noted'].includes(row.status)).length;
  if (task.state === 'ready') return `checks ${checks ? `${passed}/${checks.length}` : '-'} · review ${task.reviewStatus ?? '-'}`;
  // A session that committed all of its own work has finished: its answer, or where the work is.
  if (task.state === 'unverified') return stopLine(task)?.text ?? (finished(task) ? firstLine((task.reply ?? task.result)?.summary) || committedLine(task) : 'edits not verified · /publish runs the checks first');
  if (task.state === 'answered') return firstLine((task.reply ?? task.result)?.summary) || firstLine(sessionGoal(task));
  // A session that stopped says why and the one thing to do, as its chat does.
  return stopLine(task)?.text ?? (firstLine(task.error?.message) || firstLine(sessionGoal(task)));
}
// Peer work that needs the owner sits with the questions in group 0. An incoming message
// (question, review or task) waits in the peer daemon's files and arrives through
// peerItems(); an older one may still be a saved request (state waiting, with an origin).
// Held replies and agent drafts live only with the daemon.
// Asks and reviews from a teammate; a handoff becomes a session of its own.
export const peerQuestion = origin => ['ask', 'review'].includes(origin?.kind);
const ORIGIN = { ask: ['ASK', 'Question'], review: ['REVIEW', 'Review their diff'], handoff: ['TASK', 'Task'] };
function incoming(project, request, item, now, called = peerName) {
  const who = called(request.origin.name, request.origin.peer), [label, lead] = ORIGIN[request.origin.kind] ?? ORIGIN.ask;
  // One that waits for the owner's y to run in his home folder says so.
  const text = request.reason === HOME_QUESTION ? HOME_QUESTION : request.origin.kind === 'review' ? '' : remote(request.context ?? item?.text, 400, { trusted: item?.trusted === true });
  return { kind: 'request', root: project.root, project: project.name, id: '', request, item, agent: who, label: `${label} ${who}`, group: 0, order: time(request.createdAt), now: text ? `${lead} · ${text}` : lead, text: text || lead, time: relativeTime(request.createdAt, now), cost: '-' };
}
function peerRow(item, online, now) {
  const who = threadWho(item), text = remote(item.text, 400, { trusted: item.trusted === true }), at = time(item.at);
  const base = { kind: 'peer', item, root: typeof item.root === 'string' ? item.root : '', project: remote(item.project, 40) || '-', id: '', agent: who, cost: '-', time: relativeTime(item.at, now) };
  if (item.kind === 'incoming') { const [label, lead] = ORIGIN[item.request ?? item.origin?.kind] ?? ORIGIN.ask; return { ...base, label: `${label} ${who}`, group: 0, order: at, now: text ? `${lead} · ${text}` : lead, text: text || lead }; }
  // A teammate's standup (lib/peer/standup.mjs) that waits for the owner: y asks his sessions, n declines.
  if (item.kind === 'standup') return { ...base, label: `STANDUP ${who}`, group: 0, order: at, now: `${who} ${text} · ${item.sessions} ${item.sessions === 1 ? 'session' : 'sessions'}`, text: `${who} ${text}` };
  if (item.kind === 'held') return { ...base, label: `${item.result ? 'RESULT' : 'REPLY'} ${who}`, group: 0, order: at, now: `${item.result ? 'Result' : 'Reply'} ready to send · ${text}`, text };
  if (item.kind === 'draft') return { ...base, label: `SEND ${who}?`, group: 0, order: at, now: `Your model wants to ask · ${text}`, text };
  if (item.kind === 'asked') return { ...base, label: 'asked', group: 2, order: 3e13 + at, now: item.team || online.has(item.peer) ? text : `${who} offline · will retry` };
  // An answer or a result the chat already went on with is in that session; its thread stays in Chats.
  if (item.kind === 'answer' && item.continued === true) return null;
  // A message of mine that failed on the teammate's computer says failed, with the reason that computer sent (lib/peer/failure.mjs); rejected is the owner there declining it.
  const ended = item.kind === 'rejected' && item.state === 'failed' ? 'failed' : item.kind;
  if (['answer', 'expired', 'rejected'].includes(item.kind) && now - at < DAY) return { ...base, label: ended, group: 3, order: -at, now: item.kind === 'answer' ? `${item.result ? 'Result' : 'Answer'} · ${text}` : text || `Ask ${ended}`, text: text || `Ask ${ended}` };
  return null;
}
export const peerDecision = row => row && (row.kind === 'peer' ? ['incoming', 'held', 'draft', 'standup'].includes(row.item.kind) : row.kind === 'request' && Boolean(row.request.origin) && row.request.state === 'waiting');
// An incoming message from a teammate: y accepts it, n declines.
export const peerIncoming = row => peerDecision(row) && (row.kind === 'request' || ['incoming', 'standup'].includes(row.item.kind));
// A live approval the lead waits on: its summary reads "Run: npm install".
// The row says "wants to run: npm install".
const wants = summary => String(summary ?? '').replace(/^(Run|Edit|Open|Search|Use)\b/, verb => verb.toLowerCase());
function approvalRow(approval, projects, now) {
  const root = typeof approval.root === 'string' ? approval.root : '', name = projects.find(project => project.root === root)?.name ?? (root ? root.split('/').filter(Boolean).at(-1) : null) ?? '-';
  const text = wants(approval.summary) || 'use a tool';
  return { kind: 'approval', root, project: name, id: approval.taskId ?? '', approval, agent: approval.role ?? 'lead', label: 'WANTS', group: 0, order: time(approval.at), now: text, text, time: relativeTime(approval.at, now), cost: '-' };
}
// A session started from here on another computer of the owner's (lib/peer/remote.mjs),
// as this machine last heard it. It is listed as a session is, and says where it runs:
// machine is that computer's name. Its approvals and its Task wait under Needs you here
// as they do there.
const LIVE = ['starting', 'preparing', 'running'];
export function remoteRow(view, machine, now = Date.now()) {
  const last = time(view.lastAt ?? view.createdAt), approval = view.approvals?.[0] ?? null, live = LIVE.includes(view.state);
  // The row counts from where that computer's own row counts (rowSince), which it sends with
  // its list and with the session's state, when that is for the state shown here. One on an
  // earlier version sends none: a turn that works then counts from the start of its run when
  // this machine follows it, and from when the session was made when it does not.
  const told = view.since && time(view.since.at) && (view.state === 'starting' || Boolean(view.since.run) === live) ? view.since : null;
  const since = rowTime(told ?? (live ? { run: true, at: (view.runs ?? []).findLast(run => !run.at && time(run.startedAt))?.startedAt ?? view.createdAt } : { at: new Date(last).toISOString() }), now);
  const base = { kind: 'remote', root: `remote:${view.machine}`, project: '-', id: view.id, remote: view, machine, agent: 'lead', cost: '-' };
  if (approval) { const text = wants(approval.summary) || 'use a tool'; return { ...base, agent: !approval.role || approval.role === 'lead' ? 'lead' : approval.role.startsWith('bot:') ? `@${approval.role.slice(4)}` : approval.role, label: 'WANTS', approval, group: 0, order: time(approval.at), now: text, text, time: rowTime({ at: approval.at }, now) }; }
  if (view.plan?.state === 'proposed' && !live) return { ...base, label: 'TASK', group: 0, order: last, now: `Task to approve: ${view.plan.title}`, time: since };
  if (view.state === 'needs_input') return { ...base, label: 'WAITING YOU', group: 0, order: last, now: firstLine(view.question) || view.title, time: since };
  if (live) return { ...base, label: view.state === 'starting' ? 'starting' : 'working', group: 1, order: time(view.createdAt), now: firstLine(view.steps?.at(-1)?.text) || view.title, time: since };
  return { ...base, label: view.state, group: 3, order: -last, now: view.error || view.title, time: since };
}
// Finished work stays listed for `recent` ms (a day by default); peer threads for a day.
// approvals: pendingApprovals() rows, each waiting for y or n.
// archived: also list the sessions the owner archived, last, under their own heading.
// remote: remoteRow() rows, for sessions on the owner's other computers.
// called: the @name a peer shows under (name, key): the app's, which names another computer of the owner's as Sessions does.
export function boardRows(projects, now = Date.now(), { items = [], online = new Set(), recent: window = DAY, schedules = [], approvals = [], archived = false, timed = {}, remote = [], called = peerName } = {}) {
  // Finished ones stay as long as finished sessions here do.
  const rows = [...remote.filter(row => row?.kind === 'remote' && (row.group !== 3 || now + row.order < window))], matched = new Set();
  items = Array.isArray(items) ? items.filter(item => item && typeof item === 'object' && typeof item.id === 'string') : [];
  // A lead that waits for an allow or deny is not working. Its session's own row moves to
  // Needs you and says what it wants: the session is listed once, with no spinner, and
  // keeps its place under the cursor. An approval with no session row gets a row of its own.
  const pending = (Array.isArray(approvals) ? approvals : []).filter(approval => approval && typeof approval.id === 'string'), held = new Set();
  for (const project of projects) {
    if (project.unavailable) continue;
    // A blocked or saved message to a session shows on that session's row, newest first: the
    // session is listed once. One the session's row does not show keeps a row of its own.
    const waitingFor = heldBySession(project.queue), folded = new Set();
    for (const task of project.tasks ?? []) {
      // A teammate's question is answered in its Chats thread, not as a session.
      if (peerQuestion(task.origin)) continue;
      if (project.closed?.includes(task.id)) {
        if (!archived) continue;
        const at = lastActivity(task);
        rows.push({ kind: 'task', root: project.root, project: project.name, id: task.id, task, cost: cost(task), agent: '-', label: 'archived', archived: true, group: 5, order: -at, now: outcome(task), time: relativeTime(new Date(at).toISOString(), now) });
        continue;
      }
      // timed: the bots of this session that run on a schedule (botSchedulesShown), when it has any.
      const base = { kind: 'task', root: project.root, project: project.name, id: task.id, task, cost: cost(task), ...(fromTeammate(task.origin) ? { agent: called(task.origin.name, task.origin.peer) } : {}), ...(timed[project.root]?.[task.id] ? { timed: timed[project.root][task.id] } : {}) };
      // A standup it answered (lib/standup.mjs) leaves it where it was.
      const last = lastActivity(task);
      const asked = ['running', 'preparing'].includes(task.state) ? pending.filter(approval => String(approval.taskId) === String(task.id) && (!approval.root || approval.root === project.root)) : [];
      const waits = waitingFor.get(String(task.id)) ?? [], [request] = waits;
      for (const value of waits) folded.add(value.id);
      // The row's time, as this computer's list tells it to the owner's other computers.
      const age = rowTime(rowSince(task, { approval: asked[0], request }), now);
      if (asked.length) {
        for (const approval of asked) held.add(approval.id);
        const [approval] = asked, text = wants(approval.summary) || 'use a tool';
        // The age is how long the approval has waited, not how long the session has run.
        rows.push({ ...base, agent: approval.role ?? 'lead', label: 'WANTS', approval, group: 0, order: time(approval.at), now: text, text, time: age });
      } else if (['running', 'preparing'].includes(task.state)) {
        const since = time(task.activeSince) || time(task.createdAt);
        rows.push({ ...working(task), ...base, group: 1, order: since, now: latestStep(project, task.id) || firstLine(sessionGoal(task)), time: age });
      } else if (request) {
        // A message of yours that did not run waits for you, like a question.
        const text = request.state === 'blocked' ? `${firstLine(requestGoal(request))} — ${firstLine(request.reason)}` : firstLine(requestGoal(request));
        rows.push({ agent: request.origin ? called(request.origin.name, request.origin.peer) : '-', ...base, request, requests: waits, label: request.state === 'blocked' ? 'blocked' : 'saved', group: 0, order: time(request.createdAt), now: text, text, time: age });
      } else if (task.plan?.state === 'proposed') {
        // A Task that waits for the owner's yes (lib/plan.mjs) needs them like a question does.
        rows.push({ agent: 'lead', ...base, label: 'TASK', group: 0, order: last, now: `Task to approve: ${task.plan.title}`, time: age });
      } else if (task.state === 'needs_input') {
        const response = task.reply?.outcome === 'needs_input' ? task.reply : task.result;
        rows.push({ agent: 'lead', ...base, label: 'WAITING YOU', group: 0, order: last, now: firstLine(response?.question) || firstLine(sessionGoal(task)), time: age });
      } else if (FINISHED.includes(task.state) && now - last < window) {
        rows.push({ agent: '-', ...base, label: task.state, group: 3, order: -last, now: outcome(task), time: age });
      }
    }
    for (const request of project.queue ?? []) {
      if (!['queued', 'starting', 'blocked', 'waiting'].includes(request.state) || folded.has(request.id)) continue;
      if (request.origin) { matched.add(request.id); if (request.state === 'waiting') { rows.push(incoming(project, request, items.find(item => item.requestId === request.id), now, called)); continue; } if (peerQuestion(request.origin)) continue; }
      const delay = time(startsAt(request)) - now;
      const label = request.state === 'queued' ? delay > 0 ? `retry ${Math.ceil(delay / 1000)}s` : 'queued' : request.state === 'waiting' ? 'saved' : request.state;
      const text = request.state === 'blocked' ? `${firstLine(requestGoal(request))} — ${firstLine(request.reason)}` : firstLine(requestGoal(request));
      // A blocked or saved request waits for the owner, like a question.
      const owner = ['blocked', 'waiting'].includes(request.state);
      rows.push({ kind: 'request', root: project.root, project: project.name, id: request.continuationTaskId ?? '', request, agent: request.origin ? called(request.origin.name, request.origin.peer) : '-', label, group: owner ? 0 : 2, order: owner ? time(request.createdAt) : (request.priority ?? 1) * 1e13 + time(request.queuedAt ?? request.createdAt), now: text, time: relativeTime(request.queuedAt ?? request.createdAt, now), cost: '-' });
    }
  }
  for (const approval of pending) if (!held.has(approval.id)) rows.push(approvalRow(approval, projects, now));
  for (const item of items) if (!(item.kind === 'incoming' && matched.has(item.requestId))) { const row = peerRow(item, online, now); if (row) rows.push(row); }
  // Schedules come last: they wait for their time, not for the owner.
  for (const schedule of schedules) {
    const name = projects.find(project => project.root === schedule.root)?.name ?? schedule.project ?? '-';
    const next = schedule.enabled ? time(schedule.nextRunAt) : 0;
    rows.push({ kind: 'schedule', root: schedule.root, project: name, id: '', schedule, agent: 'lead', label: schedule.when.label, group: 4, order: schedule.enabled ? next : 9e15 + time(schedule.createdAt),
      now: firstLine(schedule.goal), text: schedule.note ? `${firstLine(schedule.goal)} — ${firstLine(schedule.note)}` : firstLine(schedule.goal), time: schedule.enabled ? untilText(schedule.nextRunAt, now) : schedule.nextRunAt || schedule.when.kind !== 'once' ? 'paused' : 'done' });
  }
  const recent = rows.filter(row => row.group === 3).sort((a, b) => a.order - b.order).slice(0, 30);
  // A live approval blocks its lead right now, so it leads Needs you.
  return [...rows.filter(row => row.group !== 3), ...recent].sort((a, b) => a.group - b.group || Number(Boolean(b.approval)) - Number(Boolean(a.approval)) || a.order - b.order)
    .map(row => ({ ...row, key: `${row.root}\0${row.kind}\0${row.kind === 'task' ? row.id : row.kind === 'remote' ? row.keyId ?? row.id : row.kind === 'peer' ? row.item.id : row.kind === 'schedule' ? row.schedule.id : row.kind === 'approval' ? row.approval.id : row.request.id}` }));
}
const fit = (value, width) => padEnd(cut(value, width), width);
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
// An incoming row reads "@name question", "@name review" or "@name task".
const PEER_VERB = { ask: ['?', 'question'], review: ['◇', 'review'], handoff: ['⇄', 'task'] };
// What a row shows first: an icon and tone for its state, and who does what. A session is
// known by its title; its number is never shown.
export function rowBadge(row, now = Date.now()) {
  // A row is short in the list: the session's model is not named, a bot or a reviewer is.
  const who = row.agent === 'lead' ? '' : `${row.agent} `;
  if (row.kind === 'remote') return remoteBadge(row, who, now);
  if (row.approval) return { icon: '?', tone: 'orange', title: `${who}wants to` };
  if (row.kind === 'task') {
    const state = row.task.state;
    if (row.archived) return { icon: '▫', tone: 'muted', title: 'archived' };
    if (row.request) return row.request.state === 'blocked' ? { icon: '✗', tone: 'red', title: 'blocked' } : { icon: '!', tone: 'orange', title: 'saved' };
    if (row.group === 1) return { icon: SPINNER[Math.floor(now / 100) % SPINNER.length], tone: 'blue', title: `${who}${row.label}` };
    if (row.group === 0 && row.task.plan?.state === 'proposed') return { icon: '?', tone: 'orange', title: 'Task to approve' };
    if (state === 'needs_input') return { icon: '?', tone: 'orange', title: 'asks you' };
    if (state === 'ready') return { icon: '✓', tone: 'green', title: 'ready to publish' };
    if (state === 'answered') return { icon: '✓', tone: 'green', title: 'answered' };
    if (state === 'unverified') return finished(row.task) ? { icon: '✓', tone: 'green', title: 'committed' } : { icon: '!', tone: 'orange', title: 'not verified' };
    if (state === 'blocked') return { icon: '✗', tone: 'red', title: 'blocked' };
    return { icon: '■', tone: 'muted', title: state };
  }
  if (row.kind === 'schedule') return { icon: '◷', tone: row.schedule.enabled ? 'blue' : 'muted', title: row.label };
  if (row.kind === 'request') {
    if (row.group === 0 && row.request.origin && row.request.state === 'waiting') { const [icon, verb] = PEER_VERB[row.request.origin.kind] ?? PEER_VERB.ask; return { icon, tone: 'orange', title: `${row.agent} ${verb}` }; }
    const state = row.request.state, peer = row.agent !== '-' ? ` · ${row.agent}` : '';
    if (state === 'blocked') return { icon: '✗', tone: 'red', title: `blocked${peer}` };
    if (state === 'waiting') return { icon: '!', tone: 'orange', title: `saved${peer}` };
    if (state === 'starting') return { icon: '›', tone: 'blue', title: `starting${peer}` };
    return { icon: '·', tone: 'muted', title: `${row.label}${peer}` };
  }
  const kind = row.item.kind;
  if (kind === 'incoming') { const [icon, verb] = PEER_VERB[row.item.request ?? row.item.origin?.kind] ?? PEER_VERB.ask; return { icon, tone: 'orange', title: `${row.agent} ${verb}` }; }
  if (kind === 'standup') return { icon: '?', tone: 'orange', title: `${row.agent} asks for a standup` };
  if (kind === 'held') return { icon: '↩', tone: 'orange', title: `${row.item.result ? 'result for' : 'reply to'} ${row.agent}` };
  if (kind === 'draft') return { icon: '✎', tone: 'orange', title: `ask ${row.agent}?` };
  if (kind === 'asked') return { icon: '→', tone: 'blue', title: `asked ${row.agent}` };
  if (kind === 'answer') return { icon: '←', tone: 'green', title: row.item.result ? `result from ${row.agent}` : `${row.agent} answered` };
  // One that failed on the teammate's computer says failed; rejected is the owner there declining it.
  return { icon: '·', tone: 'muted', title: `ask ${kind === 'rejected' && row.item.state === 'failed' ? 'failed' : kind} · ${row.agent}` };
}
function remoteBadge(row, who, now) {
  const where = `on ${row.machine}`, state = row.remote.state;
  if (row.approval) return { icon: '?', tone: 'orange', title: `${where} · ${who}wants to` };
  if (row.label === 'TASK') return { icon: '?', tone: 'orange', title: `${where} · Task to approve` };
  if (state === 'needs_input') return { icon: '?', tone: 'orange', title: `${where} · asks you` };
  // One that has not started there because it waits (lib/waiting.mjs) reads as a queued row, not as one at work.
  if (state === 'starting' && row.remote.waits) return { icon: '·', tone: 'muted', title: `${where} · queued` };
  if (row.group === 1) return { icon: SPINNER[Math.floor(now / 100) % SPINNER.length], tone: 'blue', title: `${where} · ${row.label}` };
  if (row.remote.finished) return { icon: '✓', tone: 'green', title: `${where} · committed` };
  if (['ready', 'answered'].includes(state)) return { icon: '✓', tone: 'green', title: `${where} · ${state}` };
  if (['blocked', 'gone'].includes(state)) return { icon: '✗', tone: 'red', title: `${where} · ${state}` };
  return { icon: '■', tone: 'muted', title: `${where} · ${state}` };
}
// The Sessions bar, beside the open session. A session reads "Trim coupon codes"; any
// other row reads as its badge and its text.
// A session at rest with a bot on a schedule shows when that bot runs next, in place of its age.
const nextTimed = row => row.group === 3 ? (row.timed ?? []).filter(value => value.on && value.nextRunAt).map(value => value.nextRunAt).sort()[0] ?? null : null;
const ageText = (row, now = Date.now()) => nextTimed(row) ? untilText(nextTimed(row), now) : String(row.time ?? '').replace('just now', 'now').replace(/ ago$/, '');
// Cut at a word, as fitWords does. The bar is narrow, so a word that ends exactly at the edge
// stays, and a cut never ends on the dot between two parts.
const fitBar = (value, width) => {
  const text = String(value ?? '').replace(/\s/g, ' ').trimEnd(), start = width > 1 && columns(text) > width ? head(text, width - 1) : '';
  return (start && columns(start) === width - 1 && text[start.length] === ' ' ? `${start.trimEnd()}…` : fitWords(text, width)).replace(/ ·…$/, '…');
};
// The one thing to do about a session on another computer that stopped, in a few words:
// the last sentence of the line that computer sent (lib/peer/failure.mjs), without where
// (the row says it) and without sending the message again.
function remoteShort(error) {
  const last = String(error ?? '').trim().split(/(?<=[.!?])\s+/).at(-1)?.replace(/[.!?]+$/, '') ?? '';
  const short = last.replace(/^On @[\w.-]+: /, '').replace(/ on @[\w.-]+/g, '').replace(/,? (?:then|or) send it again$/i, '');
  return short.replace(/^[A-Z](?=[a-z])/, letter => letter.toLowerCase());
}
// A run whose program did not start says so in three words where the one thing to do does
// not fit (lib/stop-line.mjs CHECK, and the same said for another computer, lib/peer/failure.mjs).
const notStarted = text => { const command = /\bCheck that (\S+) runs in your terminal\b/.exec(String(text ?? ''))?.[1]; return command ? `${command} did not start` : null; };
// Its name and why, where both fit; else why first: a row that says only ✗ and its name says nothing.
const startFailed = (name, why, room) => columns(`${name} · ${why}`) <= room ? `${name} · ${why}` : `${why} · ${name}`;
// room: how wide the title may be, when the row is drawn.
export function rowTitle(row, now = Date.now(), room = Infinity) {
  // A session that stopped and waits for the owner keeps its name, then the one thing to do
  // where the row has room for all of it. The name is never cut for it: it is how the
  // session is found. One whose program did not start says that much, at least.
  if (row.kind === 'task' && !row.approval) {
    const name = taskTitle(row.task), stop = row.group === 3 ? stopLine(row.task) : null, full = stop ? `${name} · ${stop.short}` : name;
    if (columns(full) > room && notStarted(stop?.action)) return startFailed(name, notStarted(stop.action), room);
    return columns(full) <= room ? full : name;
  }
  // A session on another computer of yours says where it runs, then what it waits for.
  // The list is narrow: where it runs comes first, so it shows however short the row is.
  // Under its computer's own heading (grouped) it needs no "on": it reads as a session here does.
  if (row.kind === 'remote') {
    const wanted = row.approval ? row.agent === 'lead' ? `wants to ${row.text}` : `${row.agent} wants to ${row.text}` : null, title = row.remote.title || 'Session';
    const named = row.grouped ? [title, wanted].filter(Boolean).join(' · ') : [`on ${row.machine}`, wanted ?? title].join(' · ');
    // One that stopped there and waits ends with the one thing to do, as a session here
    // does, where the row has room for all of it.
    const stop = !wanted && row.group === 3 ? remoteShort(row.remote.error) : '', full = stop ? `${named} · ${stop}` : named;
    if (full.length > room && stop && notStarted(row.remote.error)) return startFailed(named, notStarted(row.remote.error), room);
    return full.length <= room ? full : named;
  }
  // A request of yours is the message you wrote; one that waits to retry says so first, and
  // so does one that waits for its session's turn or a teammate slot, where the row has room
  // for that and the start of the message.
  if (row.kind === 'request' && !peerIncoming(row)) {
    const text = firstLine(requestGoal(row.request)), retry = row.label.startsWith('retry'), first = retry ? row.label : waitMark(waitOf(row.request, now));
    return first && (retry || first.length + 3 + Math.min(text.length, 8) <= room) ? `${first} · ${text}` : text;
  }
  const title = rowBadge(row, now).title, text = row.kind === 'schedule' ? row.now : row.text ?? row.now;
  // A session that waits on an approval keeps its name, then what is wanted. When the row
  // is too narrow for the name and the start of the approval, the name is cut first, at a
  // word; a name that would be left with one word keeps the row instead.
  if (row.kind === 'task') {
    const want = row.agent === 'lead' ? text : `${title} ${text}`, name = taskTitle(row.task), short = Number.isFinite(room) && columns(name) + 3 + Math.min(columns(want), 9) > room ? fitBar(name, Math.max(8, room - 12)) : name;
    return `${short.includes(' ') ? short : name} · ${want}`;
  }
  return row.approval ? `${title} ${text}` : [title, text].filter(Boolean).join(' · ');
}
// The bar's project column, when its rows come from more than one project: as wide as the
// longest name as it will show, cut at a word to about a quarter of the row. The ages then
// share a width too, so the names line up.
export function barColumns(rows, width) {
  const roots = new Set(rows.map(row => row.root).filter(Boolean)), names = rows.map(row => row.project).filter(name => name && name !== '-'), most = Math.max(7, Math.floor(width * 0.28));
  if (roots.size < 2 || !names.length) return { project: 0, clock: 0 };
  return { project: Math.max(...names.map(name => columns(fitBar(name, most)))), clock: Math.min(6, Math.max(...rows.map(row => ageText(row).length))) };
}
// One row as coloured cells that add up to exactly `width` columns: the state's icon,
// the title cut at a word, the project when asked for, and the age at the right edge.
// A row too narrow for both keeps the title and leaves the project out.
export function barCells(row, width, now = Date.now(), { project = 0, clock = 0 } = {}) {
  const badge = rowBadge(row, now), quiet = row.group === 3 || badge.tone === 'muted', age = padStart(fit(ageText(row, now), Math.min(ageText(row, now).length, 6)), clock);
  const named = project && width - 2 - (project + 1) - (age.length + 1) >= 12 ? project : 0, room = Math.max(1, width - 2 - (named ? named + 1 : 0) - (age.length + 1));
  return [
    { text: `${badge.icon} `, tone: badge.tone, bold: true },
    { text: padEnd(fitBar(rowTitle(row, now, room), room), room), tone: quiet ? 'muted' : 'text', bold: row.group === 0 },
    ...(named ? [{ text: ` ${padEnd(fitBar(row.project === '-' ? '' : row.project, named), named)}`, tone: 'muted' }] : []),
    { text: ` ${age}`, tone: nextTimed(row) ? 'blue' : 'muted' },
  ];
}
// What a row that is not a session shows beside the list: its badge and project, its whole
// text, and the keys that act on it.
export function rowCard(row, now = Date.now()) {
  const badge = rowBadge(row, now), keys = rowActions(row).map(([key, label]) => `${key} ${label}`).join(' · ');
  // A schedule the owner gave Full access says so, since its runs have nobody watching.
  const text = row.kind === 'schedule' ? [row.text, row.schedule.enabled ? `Next run ${row.time}.` : row.time === 'paused' ? 'Paused.' : 'It has run.', ...(row.schedule.permissions === 'full' && row.schedule.picked === true ? ['Each run has Full access.'] : [])].join('\n') : row.kind === 'approval' ? `${row.agent === 'lead' ? 'The model' : row.agent} wants to ${row.text}` : row.now;
  return { title: [`${badge.icon} ${badge.title}`, row.project === '-' ? '' : row.project].filter(Boolean).join(' · '), tone: badge.tone === 'muted' ? 'text' : badge.tone, text, keys };
}
export const BOARD_GROUPS = [['Needs you', 'orange'], ['Running', 'blue'], ['Queued', 'text'], ['Recent', 'green'], ['Scheduled', 'blue'], ['Archived', 'muted']];
// Board lines: a heading per non-empty group, a blank line between groups, then the rows.
// Queued says what its sessions wait for when that is a free slot (said: "4 of 4 running",
// then shorter), from the one that starts first.
export function boardSections(rows, now = Date.now()) {
  const lines = [];
  BOARD_GROUPS.forEach(([name, tone], group) => {
    const part = rows.filter(row => row.group === group);
    if (!part.length) return;
    if (lines.length) lines.push({ spacer: true });
    const said = group === 2 ? waitShort(part.map(row => row.kind === 'request' ? waitOf(row.request, now) : null).find(wait => wait?.on === 'slot')) : null;
    lines.push({ header: name, tone, count: part.length, ...(said ? { said } : {}) });
    for (const row of part) lines.push({ row });
  });
  return lines;
}
// The keys that act on a row, most useful first; the key bar shows the first three.
export function rowActions(row) {
  if (!row) return [];
  // One its computer lists stays as long as it is there; one only started from here can be taken off this list.
  // d shows what it changed, in its own tab beside the list, as for a session here.
  if (row.kind === 'remote') return [...(row.approval ? [['y', 'allow'], ['n', 'deny'], ...(row.approval.always ? [['a', 'always']] : []), ['enter', 'open']] : row.label === 'TASK' ? [['y', 'approve'], ['n', 'reject'], ['enter', 'open']] : row.group === 1 ? [['enter', 'open'], ['s', 'stop']] : row.listed ? [['enter', 'open']] : [['enter', 'open'], ['c', 'remove']]), ['d', 'changes']];
  if (row.approval) return [['y', 'allow'], ['n', 'deny'], ['enter', 'open']];
  if (peerDecision(row)) return row.kind === 'peer' && ['held', 'draft'].includes(row.item.kind) ? [['y', 'send'], ['n', 'discard'], ...(row.item.kind === 'held' ? [['e', 'edit']] : []), ['enter', 'read'], ['c', 'discard']] : [['y', 'accept'], ['n', 'decline'], ['enter', row.kind === 'peer' ? 'read' : 'open'], ['c', 'decline']];
  if (row.kind === 'peer') return [['enter', 'read'], ['n', row.item.kind === 'asked' ? 'cancel' : 'dismiss']];
  if (row.kind === 'schedule') return [['r', 'run now'], ['p', row.schedule.enabled ? 'pause' : 'resume'], ['x', 'delete'], ['enter', 'last run']];
  // c takes away whatever the list shows: a message of yours that waits is removed.
  if (row.kind === 'request') return ['blocked', 'waiting'].includes(row.request.state) ? [['enter', 'open'], ['r', 'retry'], ['c', 'remove']] : [['enter', 'open'], ['c', 'remove']];
  if (row.archived) return [['enter', 'open'], ['u', 'unarchive'], ['e', 'rename']];
  // A session whose message of yours did not run: r sends it again, s removes it, c archives the session with it.
  if (row.request) return [['enter', 'open'], ['r', 'retry'], ['s', 'remove'], ['e', 'rename'], ['c', 'archive']];
  if (row.group === 1) return [['enter', 'open'], ['s', 'stop'], ['d', 'changes'], ['e', 'rename']];
  if (row.group === 0 && row.task.plan?.state === 'proposed') return [['y', 'approve'], ['n', 'reject'], ['enter', 'open'], ['e', 'rename'], ['c', 'archive']];
  const state = row.task.state;
  if (state === 'needs_input') return [['enter', 'open'], ['a', 'answer'], ['d', 'changes'], ['e', 'rename'], ['c', 'archive']];
  if (state === 'ready') return [['enter', 'open'], ['p', 'publish'], ['d', 'changes'], ['e', 'rename'], ['c', 'archive']];
  if (state === 'answered') return [['enter', 'open'], ['a', 'follow up'], ['e', 'rename'], ['c', 'archive']];
  // Committed work has nothing to try again.
  if (finished(row.task)) return [['enter', 'open'], ['a', 'follow up'], ['d', 'changes'], ['e', 'rename'], ['c', 'archive']];
  return [['enter', 'open'], ['r', 'retry'], ['d', 'changes'], ['e', 'rename'], ['c', 'archive']];
}
