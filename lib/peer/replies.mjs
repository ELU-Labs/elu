import fs from 'node:fs';
import path from 'node:path';
import { homeOrAbove, noSymlinks, readJson, refuse, isObject } from '../util.mjs';
import { conductorStatus } from '../conductor.mjs';
import { pendingRequests } from '../workspace.mjs';
import { registeredProjects } from '../projects.mjs';
import { shares } from './shares.mjs';
import { peerFile } from './paths.mjs';
import { peerPolicy } from './settings.mjs';
import { failureFor } from './failure.mjs';
import { prepareOutgoing } from './secrets.mjs';
import { TaskState, artifact, isTerminal, withState } from './a2a.mjs';
import { audit, findByRequest, getRecord, records, updateRecord } from './taskstore.mjs';
import { accessTeams, queueRun, reconcile, sharedTeams, stopRequest } from './intake.mjs';

// The conductor writes outbox/<requestId>.json when a peer run ends. Each entry becomes
// a sent reply, or a held one (WORKING, substate awaiting-owner) when the owner holds this
// teammate's replies (holdReplies). A reply with a possible secret is held as blocked and
// never sent automatically.
// ctx: {me, push(peerKey, task), event(text), kick()}.
const HELD = { substate: 'awaiting-owner' };
const REQUEST = /^request-[a-f0-9-]+\.json$/;
const outboxDir = () => peerFile('outbox');
export function processOutbox(ctx) {
  noSymlinks(outboxDir()); if (!fs.existsSync(outboxDir())) return;
  for (const name of fs.readdirSync(outboxDir()).filter(name => REQUEST.test(name))) {
    const file = path.join(outboxDir(), name); let entry = null;
    try { noSymlinks(file); entry = readJson(file); } catch { /* A broken entry is dropped. */ }
    try { if (isObject(entry) && entry.requestId === name.slice(0, -5)) settle(ctx, entry); }
    catch (error) { ctx.event?.(`reply failed: ${error.message}`); continue; }
    fs.rmSync(file, { force: true });
  }
}
function settle(ctx, entry) {
  const found = findByRequest(entry.requestId); if (!found) return;
  // A cost the run could not report counts as all it reserved, so the daily caps still bind.
  const cost = reconcile(ctx.me.key, found.task.id, Number.isFinite(entry.costUsd) && entry.costUsd >= 0 ? entry.costUsd : null);
  const record = updateRecord(found.task.id, current => {
    const next = { ...current, costUsd: (current.costUsd ?? 0) + cost, localTaskId: entry.taskId ?? current.localTaskId, waiting: false };
    if (isTerminal(current.task.status.state)) return next;
    // The teammate is told why, and the one thing to do about it (failure.mjs).
    if (entry.outcome === 'failed' || entry.outcome === 'stopped' || typeof entry.text !== 'string' || !entry.text.trim()) {
      // why: the reason in the owner's own words, for his list. A question that was refused has no session to read it in.
      return { ...next, ...(typeof entry.error === 'string' && entry.error.trim() ? { why: entry.error.trim().slice(0, 400) } : {}), task: withState(current.task, TaskState.FAILED, { ext: null, message: failureFor(ctx, current, entry) }) };
    }
    const prepared = prepareOutgoing(entry.text, { root: current.root, trusted: peerPolicy(current.peer).trusted });
    next.reply = { text: prepared.text, problems: prepared.problems, blocked: !prepared.ok, pathsCut: prepared.pathsCut, outcome: entry.outcome, at: new Date().toISOString() };
    return { ...next, task: withState(current.task, TaskState.WORKING, { ext: HELD }) };
  });
  if (!record || isTerminal(record.task.status.state)) { if (record) ctx.push(record.peer, record.task); return; }
  audit(record.threadId, { dir: 'local', peer: record.peer, kind: record.reply.blocked ? 'blocked' : 'held', text: record.reply.text, cost: cost || null });
  if (!record.reply.blocked && !peerPolicy(record.peer).holdReplies) return void sendReply(ctx, record.task.id);
  ctx.event(record.reply.blocked ? `reply to @${record.name} blocked: possible secret` : `reply to @${record.name} ready`);
  ctx.push(record.peer, record.task);
}
const heldRecord = id => {
  const record = getRecord(id);
  if (!record?.reply || record.task.status.state !== TaskState.WORKING || record.task.metadata?.['urn:elu-code:a2a-ext:peer:v1']?.substate !== 'awaiting-owner') refuse('No reply is waiting for approval.');
  return record;
};
// text, when given, replaces the reply and is scanned again.
export function sendReply(ctx, id, { text } = {}) {
  const record = heldRecord(id);
  let body = record.reply.text, pathsCut = record.reply.pathsCut === true;
  if (text !== undefined) {
    const prepared = prepareOutgoing(String(text), { root: record.root, trusted: peerPolicy(record.peer).trusted });
    if (!prepared.ok) refuse('The edited reply still contains a possible secret.');
    body = prepared.text; pathsCut = prepared.pathsCut;
  } else if (record.reply.blocked) refuse('This reply contains a possible secret. Edit it before sending.');
  if (!body.trim()) refuse('The reply is empty.');
  const done = updateRecord(id, current => ({ ...current, reply: { ...current.reply, text: body, blocked: false, pathsCut, sentAt: new Date().toISOString() }, task: withState(current.task, TaskState.COMPLETED, { ext: null, artifacts: [artifact({ name: 'Answer', text: body })] }) }));
  audit(done.threadId, { dir: 'out', peer: done.peer, kind: 'answer', text: body, cost: done.costUsd });
  ctx.event(`reply sent to @${done.name}`); ctx.push(done.peer, done.task);
  return done.task;
}
export function discardReply(ctx, id) {
  heldRecord(id);
  const done = updateRecord(id, current => ({ ...current, reply: { ...current.reply, discarded: true }, task: withState(current.task, TaskState.REJECTED, { ext: null, message: 'The owner did not send a reply.' }) }));
  audit(done.threadId, { dir: 'out', peer: done.peer, kind: 'rejected', text: 'discarded' });
  ctx.push(done.peer, done.task); return done.task;
}
function waitingRecord(id) {
  const record = getRecord(id);
  if (!record?.waiting || record.task.status.state !== TaskState.SUBMITTED) refuse('No request is waiting for you.');
  return record;
}
// The owner's y or w. how: 'own' starts the session his own prompt would start (y on a
// message); 'answer' runs the read-only question run, whatever the wire kind (y on a
// question for a shared bot); 'work' runs it as the owner's own session in the mode, place
// and folders they picked. own and work have origin.kind handoff, so the summary goes back
// to the thread. Nothing was queued at intake: the goal is built and the request queued here.
// root: the project the owner has open, for a message that arrived with none; it must be
// one of his projects. home: he also answered y to HOME_QUESTION, so it may run in his home
// folder; without it, a message that would run there is refused with what to do.
export function acceptIncoming(ctx, id, { how = 'answer', permissions, place, folders, root, home = false } = {}) {
  const record = waitingRecord(id);
  if (root != null && (typeof root !== 'string' || !registeredProjects().some(repo => repo.root === root))) refuse('Open a project of yours to work on this message.');
  let queued = null;
  const done = updateRecord(id, current => {
    if (!current.waiting) return null;
    // A project picked now brings the setting and rules of its teams, as one chosen at intake does.
    // One that would run in the home folder, or above it, takes the project open now instead.
    const at = current.root && !homeOrAbove(current.root) ? {} : root ? { root, project: shares().find(row => row.root === root)?.handle ?? null, accessTeams: accessTeams(root, sharedTeams(ctx.me.key, current.peer).map(team => team.id)) } : {};
    queued = queueRun({ ...current, ...at }, { how, permissions, place, folders, byOwner: true, home: home === true });
    // It no longer waits for the owner, so its sender is no longer told that it does.
    return { ...current, ...at, waiting: false, requestId: queued.id, task: withState(current.task, TaskState.SUBMITTED) };
  });
  if (!queued) refuse('No request is waiting for you.');
  ctx.push?.(done.peer, done.task);
  ctx.event(`${how === 'answer' ? 'answering' : 'working on'} ${record.kind} from @${record.name}`);
  ctx.kick(); return done.task;
}
export function declineIncoming(ctx, id) {
  const record = waitingRecord(id);
  stopRequest(record);
  const done = updateRecord(id, current => ({ ...current, waiting: false, task: withState(current.task, TaskState.REJECTED, { ext: null, message: 'The owner declined this request.' }) }));
  reconcile(ctx.me.key, id);
  audit(done.threadId, { dir: 'out', peer: done.peer, kind: 'rejected', text: 'declined' });
  ctx.push(done.peer, done.task); return done.task;
}
// Moves served tasks along with their requests: WORKING once a run starts, REJECTED
// when the owner removed the request without a run. A request that waits on a conductor
// that is no longer running starts one, so its recovery and dispatch run.
export function syncRecords(ctx, now = Date.now()) {
  let stuck = false;
  for (const record of records()) {
    const state = record.task.status.state;
    if (isTerminal(state) || record.reply || !record.root || !record.requestId) continue;
    let row; try { row = pendingRequests(record.root).find(r => r.id === record.requestId); } catch { continue; }
    if (fs.existsSync(peerFile('outbox', `${record.requestId}.json`))) continue;
    if (!row) {
      const done = updateRecord(record.task.id, current => current.reply || isTerminal(current.task.status.state) ? null : { ...current, waiting: false, task: withState(current.task, TaskState.REJECTED, { ext: null, message: 'The owner declined this request.' }) });
      reconcile(ctx.me.key, record.task.id);
      ctx.push(done.peer, done.task); continue;
    }
    if (['queued', 'starting', 'running'].includes(row.state)) stuck = true;
    if (state === TaskState.SUBMITTED && ['queued', 'starting', 'running'].includes(row.state)) {
      if (row.state === 'running') { const done = updateRecord(record.task.id, current => ({ ...current, waiting: false, task: withState(current.task, TaskState.WORKING) })); ctx.push(done.peer, done.task); }
      else if (record.waiting) updateRecord(record.task.id, current => ({ ...current, waiting: false }));
    }
  }
  if (stuck && now - (ctx.kickedAt ?? 0) > 30000 && !conductorStatus(now).running) { ctx.kickedAt = now; ctx.kick(); }
}
