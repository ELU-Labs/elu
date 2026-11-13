import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomic, noSymlinks, readJson, refuse, isObject } from '../util.mjs';
import { waitLock } from '../state.mjs';
import { enqueue } from '../conductor.mjs';
import { repository } from '../git.mjs';
import { registeredProjects, taskDetails } from '../projects.mjs';
import { BOT_NAME } from '../bots.mjs';
import { peerFile, peerRepo } from './paths.mjs';
import { peerPolicy } from './settings.mjs';
import { plainName, sanitize } from './peerdata.mjs';
import { teams } from './roster.mjs';
import { prepareOutgoing, scanSecrets } from './secrets.mjs';
import { PEER_EXT, TEXT_MAX, TaskState, isTerminal, message, task, textPart, validateTask } from './a2a.mjs';
import { dropOutgoing, pushPictures, sizeText } from './pictures.mjs';
import { LONG_MAX, longText, pushText } from './texts.mjs';
import { audit } from './taskstore.mjs';

// Asks this machine sent (docs/peer-network.md):
// asks/<id>.json = {id, to, name, messageId, threadId, taskId|null, kind, project, text,
// state, attempts, nextAt, createdAt, expiresAt, answer|null, root, chatTaskId, reason, group?, bot?, pictures?}.
// pictures: {set, list: [{id, n, name, size, type, sha256}], sentAt?, unsent?, reason?, kept?} for a
// message the owner typed that named pictures (pictures.mjs); nothing else carries any.
// A team ask is one ask per teammate sharing a group id and a thread. bot is the teammate's
// shared bot a question is for; only a question to one teammate names one.
// state: pending (not delivered), submitted, working, held, answered, rejected, failed,
// canceled, expired. ctx: {me: identity, session(key), dial(key), event(text), kick()}.
const DAY = 24 * 3600 * 1000;
const ID = /^[a-f0-9-]{36}$/;
const OPEN = ['pending', 'submitted', 'working', 'held'];
const dir = () => peerFile('asks');
const file = id => { if (!ID.test(id ?? '')) refuse('Choose an ask.'); return path.join(dir(), `${id}.json`); };
const locked = fn => { const release = waitLock(peerRepo(), 'asks'); try { return fn(); } finally { release(); } };
export function getAsk(id) {
  try { const target = file(id); noSymlinks(target); if (!fs.existsSync(target)) return null; const value = readJson(target); return isObject(value) && value.id === id ? value : null; } catch { return null; }
}
export function asks() {
  noSymlinks(dir()); if (!fs.existsSync(dir())) return [];
  return fs.readdirSync(dir()).filter(name => ID.test(name.slice(0, -5)) && name.endsWith('.json')).flatMap(name => { const ask = getAsk(name.slice(0, -5)); return ask ? [ask] : []; });
}
const saveAsk = ask => { atomic(file(ask.id), ask); return ask; };
const updateAsk = (id, fn) => locked(() => { const ask = getAsk(id); if (!ask) return null; const next = fn(ask); return next ? saveAsk(next) : ask; });

// Active teammates by name or key, across every team this machine is in.
export function teammate(me, who) {
  const seen = new Map();
  for (const team of teams()) {
    if (!team.members.some(m => m.key === me.key && !m.removed)) continue;
    for (const m of team.members) if (!m.removed && m.key !== me.key) seen.set(m.key, m);
  }
  // The TUI shows names without spaces or @, so that form and the 8-character fingerprint match too.
  const value = String(who ?? '').replace(/^@/, ''), plain = text => String(text).replace(/[\s@]+/g, '').toLowerCase();
  const exact = [...seen.values()].filter(m => m.key === value || m.name === value);
  const found = exact.length ? exact : [...seen.values()].filter(m => plain(m.name) === plain(value) && plain(value) || /^[0-9a-f]{8,63}$/.test(value) && m.key.startsWith(value));
  if (!found.length) refuse(`No teammate is named @${sanitize(value, 40)}.`);
  if (found.length > 1) refuse(`More than one teammate is named @${sanitize(value, 40)}. Use their key.`);
  return found[0];
}
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// kind result: the result of approved work in a session a teammate's message started, sent
// into that thread (sendResult). It is not listed as an ask of mine.
export function createAsk(ctx, { to, kind = 'ask', project = null, text, root = null, chatTaskId = null, threadId = null, group = null, room = null, bot = null, byOwner = false, pictures = null }) {
  if (!['ask', 'review', 'handoff', 'result'].includes(kind)) refuse('Choose ask, review or handoff.');
  if (kind === 'result' && (threadId == null || group || bot || pictures)) refuse('A result goes into the thread of one teammate.');
  // Only the daemon's own commands for a message the owner typed pass pictures (stagedPictures).
  if (pictures && (kind === 'review' || !byOwner)) refuse('Only a message you typed can carry pictures.');
  if (project != null && !PROJECT.test(project)) refuse('A project is a share handle.');
  if (bot != null && (typeof bot !== 'string' || !BOT_NAME.test(bot))) refuse('A bot name is 1 to 30 lowercase letters, digits or -, starting with a letter.');
  if (bot != null && (kind !== 'ask' || group)) refuse('Only a question to one teammate can name a bot.');
  // Any length goes: one too long for a line on the link goes ahead of its message in pieces.
  if (typeof text !== 'string' || !text.trim()) refuse('Write the message first.');
  if (Buffer.byteLength(text) > LONG_MAX) refuse(`A message to a teammate can be up to ${sizeText(LONG_MAX)}.`);
  if (threadId != null && !/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) refuse('Invalid thread.');
  const member = teammate(ctx.me, to), now = Date.now();
  // Agent drafts and local A2A callers write this text, so it is scanned like a reply.
  // What the owner typed, or a draft the owner sent by hand (byOwner), goes as written: the
  // owner decides what to tell a teammate, and a path or a long name is easily taken for a key.
  // A trusted teammate gets it with its paths; the scan still refuses a secret.
  const prepared = prepareOutgoing(text, { root, trusted: peerPolicy(member.key).trusted });
  if (!prepared.ok && !byOwner) refuse(`This ${kind} contains a possible secret. Remove it before sending.`);
  // A diff keeps its exact lines (--- /dev/null and all); other text loses paths outside the repository.
  if (kind !== 'review') text = prepared.text;
  const ask = saveAsk({ id: crypto.randomUUID(), to: member.key, name: sanitize(member.name, 64), messageId: crypto.randomUUID(), threadId: threadId ?? crypto.randomUUID(), taskId: null, kind, project, text,
    state: 'pending', attempts: 0, nextAt: now, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 7 * DAY).toISOString(), answer: null, root, chatTaskId: chatTaskId == null ? null : String(chatTaskId), reason: null, ...(group ? { group } : {}), ...(room ? { room } : {}), ...(bot ? { bot } : {}), ...(kind !== 'review' && prepared.pathsCut ? { pathsCut: true } : {}), ...(pictures ? { pictures } : {}), ...(kind === 'result' ? { dismissed: true } : {}) });
  audit(ask.threadId, { dir: 'out', peer: ask.to, kind, text });
  if (!group) ctx.event(`${kind} to @${ask.name}`);
  ctx.dial(ask.to); deliver(ctx, ask.id);
  return ask;
}
// A question with no @name goes to every teammate; with a team, to everyone on it
// (#general); with a channel too, to that channel's members. The first whose agent takes
// it (its run starts) answers; the others' copies are then withdrawn (withdrawOthers).
export const TEAM_MAX = 20;
export function teamAsk(ctx, { project = null, text, root = null, chatTaskId = null, team = null, channel = null, byOwner = false, pictures = null }) {
  const members = new Map(), mine = teams().filter(state => state.members.some(m => m.key === ctx.me.key && !m.removed));
  let room = null, where = 'the team';
  if (channel && !team) refuse('Name the team that channel is on.');
  if (team) {
    const state = mine.find(row => row.id === team); if (!state) refuse('You are not on that team.');
    const found = channel ? state.channels.find(row => row.id === channel) : null;
    if (channel && !found?.members.includes(ctx.me.key)) refuse('You are not in that channel.');
    for (const m of state.members) if (!m.removed && m.key !== ctx.me.key && (!found || found.members.includes(m.key))) members.set(m.key, m);
    if (found && !members.size) refuse(`No one else is in #${found.name}.`);
    room = { team: state.id, channel: found?.id ?? null }; where = `#${found?.name ?? 'general'}`;
  } else for (const state of mine) for (const m of state.members) if (!m.removed && m.key !== ctx.me.key) members.set(m.key, m);
  if (!members.size) refuse('No teammates yet. Use /invite to add one.');
  if (members.size > TEAM_MAX) refuse(`Your teams have more than ${TEAM_MAX} people. Ask one of them with @name.`);
  // Scanned once up front, so a secret refuses the whole ask before any copy is saved.
  if (!byOwner && typeof text === 'string' && !prepareOutgoing(text, { root }).ok) refuse('This ask contains a possible secret. Remove it before sending.');
  const group = crypto.randomUUID(), threadId = crypto.randomUUID();
  const sent = [...members.keys()].map(key => createAsk(ctx, { to: key, project, text, root, chatTaskId, threadId, group, room, byOwner, pictures }));
  ctx.event(`ask to ${where} (${sent.length})`);
  return sent;
}
const TAKEN = ['working', 'held', 'answered'];
function withdrawOthers(ctx, taken) {
  let withdrawn = 0;
  for (const other of asks().filter(row => row.group === taken.group && row.id !== taken.id && ['pending', 'submitted'].includes(row.state))) {
    const done = updateAsk(other.id, current => ['pending', 'submitted'].includes(current.state) ? { ...current, state: 'canceled', cancel: true, dismissed: true, reason: `@${taken.name} took it.` } : null);
    if (done?.state === 'canceled' && done.cancel) { withdrawn++; void cancel(ctx, done.id); }
  }
  if (withdrawn) ctx.event(`@${taken.name} took the team ask`);
}
// Dismissing a team ask dismisses every copy; open ones are cancelled with their teammates.
export function dismissTeam(ctx, group) {
  const rows = asks().filter(row => row.group === group && !row.dismissed);
  if (!rows.length) refuse('Choose an ask.');
  return rows.map(row => dismissAsk(ctx, row.id));
}
// The whole diff of a local editing task, new files and all, refused before sending only
// when it looks like it carries a secret.
export function reviewText(root, taskId) {
  const repo = registeredProjects().find(row => row.root === root) ?? repository(root);
  const details = taskDetails(repo, String(taskId), { whole: true });
  if (details.task.kind === 'conversation') refuse('Choose an editing task to review.');
  const diff = details.diff.trim();
  if (!diff) refuse('This task has no changes to review.');
  if (scanSecrets(diff).length) refuse('This diff contains a possible secret. Remove it before sending.');
  return diff;
}
const backoff = attempts => Math.min(5000 * 2 ** attempts, 10 * 60000);
const sending = new Set(), pushing = new Set();
// The teammate answers at most 20 requests per 10 s and closes the connection past 40, so
// this side sends asks, polls and cancels to one teammate at half that rate. Whatever is
// left waits for a later tick.
const PACE = 10, PACE_MS = 10000, sent = new Map();
function allow(key, now = Date.now()) {
  const recent = (sent.get(key) ?? []).filter(at => now - at < PACE_MS);
  if (recent.length >= PACE) { sent.set(key, recent); return false; }
  sent.set(key, [...recent, now]); return true;
}
// Sends a pending ask if its teammate is connected; otherwise it waits for a reconnect.
const paced = async key => { while (!allow(key)) await new Promise(resolve => setTimeout(resolve, 250)); };
// After the message went: what the teammate kept, and the copies for sending are removed
// once no other ask still waits to send them.
function settlePictures(id, sent, task) {
  const done = updateAsk(id, current => {
    if (!current.pictures) return null;
    const kept = task.metadata?.[PEER_EXT]?.pictures, pictures = { ...current.pictures };
    if (sent && Number.isInteger(kept) && kept < sent) Object.assign(pictures, { unsent: 'partly', kept });
    if (sent && !pictures.unsent) pictures.sentAt = new Date().toISOString();
    return { ...current, pictures };
  });
  if (done?.pictures && !asks().some(row => row.id !== id && row.state === 'pending' && row.pictures?.set === done.pictures.set)) dropOutgoing(done.pictures.set);
}
export async function deliver(ctx, id) {
  let ask = getAsk(id); if (!ask || ask.state !== 'pending' || sending.has(id)) return;
  // Pictures go first, in pieces, to one message per teammate at a time; the message then
  // names them. A teammate who cannot take them gets the text alone.
  const carries = Boolean(ask.pictures && !ask.pictures.unsent);
  if (carries && pushing.has(ask.to)) return;
  const session = ctx.session(ask.to); if (!session || !allow(ask.to)) return;
  sending.add(id); if (carries) pushing.add(ask.to);
  try {
    let files = [];
    if (carries) {
      const pushed = await pushPictures(session, ask.pictures, () => paced(ask.to));
      if (pushed.parts) files = pushed.parts;
      else { ask = updateAsk(id, current => ({ ...current, pictures: { ...current.pictures, unsent: pushed.unsent, ...(pushed.reason ? { reason: pushed.reason } : {}) } })) ?? ask; ctx.event(`pictures to @${ask.name} not sent (${pushed.unsent})`); }
      if (getAsk(id)?.state !== 'pending') return;
    }
    // A text too long for one line on the link goes first, in pieces. A teammate whose ELU
    // cannot take it is told to update; the text is never cut to fit.
    let head = textPart(ask.text);
    if (longText(ask.text)) {
      const pushed = await pushText(session, ask.text, () => paced(ask.to));
      if (pushed.unsent) { updateAsk(id, current => current.state === 'pending' ? { ...current, state: 'failed', reason: tooLongFor(ask.name, ask.to) } : null); ctx.event(`${ask.kind} to @${ask.name} failed`); return; }
      if (getAsk(id)?.state !== 'pending') return;
      head = pushed.part;
    }
    const params = { message: message({ parts: [head, ...files], contextId: ask.threadId, messageId: ask.messageId, ext: { kind: ask.kind, project: ask.project ?? null, hop: 1, from: { key: ctx.me.key, name: ctx.me.name.slice(0, 64) }, ...(ask.group ? { team: true } : {}), ...(ask.room ? { room: ask.room } : {}), ...(ask.bot ? { bot: ask.bot } : {}) } }) };
    const result = await session.request('SendMessage', params);
    if (!isObject(result?.task)) throw new Error('The teammate sent no task.');
    if (ask.pictures) settlePictures(id, files.length, result.task);
    applyTask(ctx, ask.to, result.task, id);
  } catch (error) {
    // Rate limits and internal errors (a disk or lock hiccup over there) are retried; refusals are final.
    const final = Number.isInteger(error.details?.rpc?.code) && ![-32000, -32603].includes(error.details.rpc.code);
    // ELU 0.1.19 and earlier refuse a text over 16000 characters, or 160000 for a review.
    const older = final && OLDER_LIMIT.test(error.message ?? '');
    updateAsk(id, current => current.state !== 'pending' ? null : final
      ? { ...current, state: 'failed', reason: older ? tooLongFor(current.name, current.to) : sanitize(error.message, 300) }
      : { ...current, attempts: current.attempts + 1, nextAt: Date.now() + backoff(current.attempts) });
    if (final) ctx.event(`${ask.kind === 'result' ? 'result' : 'ask'} to @${ask.name} failed`);
  } finally { sending.delete(id); if (carries) pushing.delete(ask.to); }
}
export const sendResult = (ctx, { to, text, root = null, threadId }) => createAsk(ctx, { to, kind: 'result', text, root, threadId });
// A result the owner checks before it goes: he holds his replies to this teammate, or the
// text may carry a secret. It waits with his held replies (peerItems) for y, an edit or n.
export function holdResult(ctx, { to, text, root = null, threadId, problems = [], blocked = false, pathsCut = false }) {
  const member = teammate(ctx.me, to), now = Date.now();
  const held = saveAsk({ id: crypto.randomUUID(), to: member.key, name: sanitize(member.name, 64), messageId: crypto.randomUUID(), threadId, taskId: null, kind: 'result', project: null, text,
    state: 'review', attempts: 0, nextAt: now, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 7 * DAY).toISOString(), answer: null, root, chatTaskId: null, reason: null, blocked: blocked === true, problems, ...(pathsCut ? { pathsCut: true } : {}) });
  audit(threadId, { dir: 'local', peer: held.to, kind: held.blocked ? 'blocked' : 'held', text });
  ctx.event(held.blocked ? `result for @${held.name} blocked: possible secret` : `result for @${held.name} ready`);
  return held;
}
const heldResult = id => { const held = getAsk(id); if (held?.kind !== 'result' || held.state !== 'review') refuse('No result is waiting for approval.'); return held; };
// text, when given, replaces the result and is scanned again.
export function sendHeldResult(ctx, id, { text } = {}) {
  const held = heldResult(id);
  if (text === undefined && held.blocked) refuse('This result contains a possible secret. Edit it before sending.');
  const sent = sendResult(ctx, { to: held.to, text: text === undefined ? held.text : String(text), root: held.root, threadId: held.threadId });
  updateAsk(id, current => ({ ...current, state: 'sent', dismissed: true }));
  return sent;
}
export function dropHeldResult(ctx, id) {
  const held = heldResult(id);
  updateAsk(id, current => ({ ...current, state: 'dropped', dismissed: true }));
  // The thread's note then says the result was not sent, not a reply (threadMessages).
  audit(held.threadId, { dir: 'out', peer: held.to, kind: 'rejected', text: 'result discarded' });
  return held;
}
// A teammate's result for a message this machine sent them: what the work their owner
// approved did. It goes into the thread that message started, as their reply does, and runs
// nothing. Only the teammate that message went to, still on a team with this machine, sends one.
export function takeResult(ctx, from, value) {
  const threadId = value.contextId ?? null, text = value.parts.filter(part => typeof part.text === 'string').map(part => part.text).join('\n\n');
  const mates = teams().some(state => state.members.some(m => m.key === ctx.me.key && !m.removed) && state.members.some(m => m.key === from && !m.removed));
  const sent = mates && threadId ? asks().filter(ask => ask.to === from && ask.threadId === threadId && ask.kind !== 'result') : [];
  if (!sent.length) refuse('No message of mine is in that thread.');
  if (!text.trim() || text.length > TEXT_MAX) refuse(`Write 1 to ${TEXT_MAX} characters.`);
  const done = task({ contextId: threadId, state: TaskState.COMPLETED });
  // Sent again after a lost answer: kept once.
  if (sent.some(ask => ask.results?.includes(value.messageId))) return done;
  const body = sanitize(text, TEXT_MAX), newest = sent.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  updateAsk(newest.id, ask => ({ ...ask, result: { text: body, at: new Date().toISOString() }, results: [...(ask.results ?? []), value.messageId].slice(-20) }));
  audit(threadId, { dir: 'in', peer: from, kind: 'result', text: body });
  ctx.event(`result from @${newest.name}`);
  // It continues the chat the message came from, as the answer does.
  const chat = sent.find(ask => ask.root && ask.chatTaskId);
  if (chat && peerPolicy(from).autoContinue) {
    try { continueResult(ctx, chat.id, body); if (chat.id !== newest.id) updateAsk(newest.id, ask => ({ ...ask, resultContinuedAt: new Date().toISOString() })); }
    catch (error) { ctx.event(`continue failed: ${error.message}`); }
  }
  return done;
}
// ELU 0.1.6 and earlier refuse a message when their owner shares no project; a newer
// one takes every message. The sender is told, in one line, what the teammate can do.
export const OLD_RECEIVER = /^They have not shared a project, so there is nothing of theirs to ask about yet\.?$/;
export const needsUpdate = name => `@${name} needs to update ELU to get messages: their version takes them only when they share a project.`;
const OLDER_LIMIT = /^(?:The text is longer than \d+ characters|Message part \d+ must be text of at most \d+ characters)\.$/;
export const tooLongFor = (name, key) => `@${sanitize(name, 64).replace(/[\s@]+/g, '') || key.slice(0, 8)} needs to update ELU to get a message this long.`;
const answerText = task => (task.artifacts ?? []).flatMap(item => item.parts).filter(part => typeof part.text === 'string').map(part => part.text).join('\n\n');
const statusText = task => task.status.message?.parts?.filter(part => typeof part.text === 'string').map(part => part.text).join(' ') ?? null;
// Applies a Task from GetTask, SendMessage or elu.taskUpdate. Only the teammate the ask
// went to can change it, and only for the task it returned.
export function applyTask(ctx, from, value, askId = null) {
  let current; try { current = validateTask(value); } catch { return null; }
  const target = askId ? getAsk(askId) : asks().find(ask => ask.taskId === current.id && ask.to === from);
  if (!target || target.to !== from || (target.taskId && target.taskId !== current.id)) return null;
  // Dismissed while SendMessage was in flight: keep the task id so the cancel can go out.
  if (!OPEN.includes(target.state)) { if (askId && target.cancel && !target.taskId) updateAsk(target.id, ask => ({ ...ask, taskId: current.id })); return null; }
  const state = current.status.state, held = current.metadata?.['urn:elu-code:a2a-ext:peer:v1']?.substate === 'awaiting-owner';
  const next = { [TaskState.SUBMITTED]: 'submitted', [TaskState.WORKING]: held ? 'held' : 'working', [TaskState.COMPLETED]: 'answered', [TaskState.REJECTED]: 'rejected', [TaskState.FAILED]: 'failed', [TaskState.CANCELED]: 'canceled' }[state] ?? 'working';
  const ask = updateAsk(target.id, ask => {
    if (!OPEN.includes(ask.state)) return null;
    const update = { ...ask, taskId: current.id, state: next };
    if (next === 'answered') update.answer = { text: sanitize(answerText(current), Infinity), at: new Date().toISOString() };
    if (isTerminal(state) && next !== 'answered') update.reason = sanitize(statusText(current) ?? '', 300) || null;
    if (next === 'rejected' && OLD_RECEIVER.test(update.reason ?? '')) update.reason = needsUpdate(sanitize(ask.name, 64).replace(/[\s@]+/g, '') || ask.to.slice(0, 8));
    return update;
  });
  if (!ask || ask.state === target.state || ask.kind === 'result') return ask;
  if (ask.group && TAKEN.includes(ask.state)) withdrawOthers(ctx, ask);
  if (ask.state === 'answered') {
    audit(ask.threadId, { dir: 'in', peer: ask.to, kind: 'answer', text: ask.answer.text });
    ctx.event(`answer from @${ask.name}`);
    if (ask.root && ask.chatTaskId && peerPolicy(ask.to).autoContinue) { try { continueAnswer(ctx, ask.id); } catch (error) { ctx.event(`continue failed: ${error.message}`); } }
  } else if (isTerminal(state)) ctx.event(`${ask.kind} to @${ask.name} ${ask.state}`);
  return ask;
}
// Queues a follow-up in the chat the ask came from, with the answer as peer data.
export function continueAnswer(ctx, id) {
  const ask = getAsk(id);
  if (!ask || ask.state !== 'answered' || !ask.answer) refuse('That ask has no answer yet.');
  if (!ask.root || !ask.chatTaskId) refuse('That ask did not come from a chat.');
  // A result that came after the answer is the newest word in the thread and what its row
  // shows (peerItems), so the chat goes on with that, also when the answer already continued it.
  const result = ask.result?.text && !ask.resultContinuedAt ? ask.result.text : null, now = new Date().toISOString();
  if (ask.continued && !result) refuse('That answer was already continued.');
  const name = ask.name.replace(/["<>\t\n]/g, '').trim() || ask.to.slice(0, 8);
  const row = enqueue(ask.root, `Continue with the ${result ? 'result' : 'answer'} from @${plainName(ask.name, ask.to)} shown in the peer data block.`, {
    continuationTaskId: ask.chatTaskId, priority: 0, readOnly: true,
    origin: { kind: 'answer', peer: ask.to, name, a2aTaskId: ask.taskId, threadId: ask.threadId, hop: 0 }, context: result ?? ask.answer.text,
  });
  updateAsk(id, current => ({ ...current, continued: true, continuedAt: now, ...(result ? { resultContinuedAt: now } : {}) }));
  ctx.kick(); return row;
}
// The same for a result that came later (takeResult): it is queued in that chat as peer data.
export function continueResult(ctx, id, text) {
  const ask = getAsk(id);
  if (!ask?.root || !ask.chatTaskId) refuse('That ask did not come from a chat.');
  const name = ask.name.replace(/["<>\t\n]/g, '').trim() || ask.to.slice(0, 8);
  const row = enqueue(ask.root, `Continue with the result from @${plainName(ask.name, ask.to)} shown in the peer data block.`, {
    continuationTaskId: ask.chatTaskId, priority: 0, readOnly: true,
    origin: { kind: 'answer', peer: ask.to, name, a2aTaskId: ask.taskId, threadId: ask.threadId, hop: 0 }, context: String(text).slice(0, TEXT_MAX),
  });
  updateAsk(id, current => ({ ...current, resultContinuedAt: new Date().toISOString() }));
  ctx.kick(); return row;
}
// Dismissing an open ask cancels it with the teammate, so it never runs on their budget.
export function dismissAsk(ctx, id) {
  const ask = updateAsk(id, current => ({ ...current, dismissed: true, ...(OPEN.includes(current.state) ? { state: 'canceled', cancel: true } : {}) }));
  if (!ask) refuse('Choose an ask.');
  if (ask.cancel) void cancel(ctx, ask.id);
  return ask;
}
// Sends CancelTask for an ask marked cancel (dismissed or expired). Done when the teammate
// cancels it, says it is finished or unknown, or never received it.
export async function cancel(ctx, id) {
  const ask = getAsk(id); if (!ask?.cancel || sending.has(id)) return;
  if (!ask.taskId) return void updateAsk(id, current => current.taskId ? null : { ...current, cancel: false });
  const session = ctx.session(ask.to); if (!session || !allow(ask.to)) return;
  sending.add(id);
  try { await session.request('CancelTask', { id: ask.taskId }); updateAsk(id, current => ({ ...current, cancel: false })); }
  catch (error) { if ([-32001, -32002].includes(error.details?.rpc?.code)) updateAsk(id, current => ({ ...current, cancel: false })); }
  finally { sending.delete(id); }
}
// Polls one open ask with GetTask. A rate limit or a timeout tries again later.
async function poll(ctx, ask) {
  const session = ctx.session(ask.to); if (!session || sending.has(ask.id) || !allow(ask.to)) return;
  sending.add(ask.id);
  try { applyTask(ctx, ask.to, await session.request('GetTask', { id: ask.taskId }), ask.id); updateAsk(ask.id, current => ({ ...current, pollAt: null, polls: 0 })); }
  catch (error) {
    if (error.details?.rpc?.code === -32001) updateAsk(ask.id, current => ({ ...current, state: 'failed', reason: 'The teammate no longer has this task.', pollAt: null }));
    else updateAsk(ask.id, current => ({ ...current, polls: (current.polls ?? 0) + 1, pollAt: Date.now() + backoff(current.polls ?? 0) }));
  } finally { sending.delete(ask.id); }
}
// On connect: what waits for this teammate goes out, and what they still hold is polled,
// at the paced rate; tickAsks sends the rest.
export async function reconnect(ctx, key) {
  for (const ask of asks().filter(ask => ask.to === key)) {
    if (ask.state === 'pending') updateAsk(ask.id, current => ({ ...current, nextAt: 0 }));
    else if (OPEN.includes(ask.state) && ask.taskId) updateAsk(ask.id, current => ({ ...current, pollAt: 0, polls: 0 }));
  }
  await pump(ctx, key);
}
async function pump(ctx, key, now = Date.now()) {
  for (const ask of asks().filter(ask => ask.to === key)) {
    if (!ctx.session(key) || (sent.get(key) ?? []).filter(at => now - at < PACE_MS).length >= PACE) return;
    if (ask.cancel) await cancel(ctx, ask.id);
    else if (ask.state === 'pending' && ask.nextAt <= now) await deliver(ctx, ask.id);
    else if (OPEN.includes(ask.state) && ask.taskId && ask.pollAt != null && ask.pollAt <= now) await poll(ctx, ask);
  }
}
export function tickAsks(ctx, now = Date.now()) {
  const keys = new Set();
  for (const ask of asks()) {
    if (ask.cancel) { if (ask.taskId) keys.add(ask.to); else cancel(ctx, ask.id); continue; }
    if (!OPEN.includes(ask.state)) continue;
    if (Date.parse(ask.expiresAt) <= now) { updateAsk(ask.id, current => OPEN.includes(current.state) ? { ...current, state: 'expired', cancel: true } : null); ctx.event(`${ask.kind} to @${ask.name} expired`); keys.add(ask.to); continue; }
    if (ask.state === 'pending' && ask.nextAt <= now) {
      // Offline: dial on the ask's own backoff; Hyperswarm retries in between.
      if (!ctx.session(ask.to)) { updateAsk(ask.id, current => ({ ...current, attempts: current.attempts + 1, nextAt: now + backoff(current.attempts) })); ctx.dial(ask.to); continue; }
      keys.add(ask.to);
    }
    if (ask.pollAt != null && ask.pollAt <= now) keys.add(ask.to);
  }
  for (const key of keys) if (ctx.session(key)) pump(ctx, key, now).catch(() => {});
}

// Agent drafts (drafts/<id>.json from the runner): approved ones, and drafts to
// teammates set to autoAsk, become asks.
const draftFile = id => { if (!ID.test(id ?? '')) refuse('Choose a draft.'); return peerFile('drafts', `${id}.json`); };
export function drafts() {
  const folder = peerFile('drafts'); noSymlinks(folder); if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(name => name.endsWith('.json') && ID.test(name.slice(0, -5))).flatMap(name => {
    try { const value = readJson(path.join(folder, name)); return isObject(value) && value.id === name.slice(0, -5) ? [value] : []; } catch { return []; }
  });
}
export function sendDraft(ctx, id, { byOwner = false } = {}) {
  const target = draftFile(id); noSymlinks(target);
  const release = waitLock(peerRepo(), 'drafts');
  let draft;
  try {
    draft = fs.existsSync(target) ? readJson(target) : null;
    if (!draft || draft.state !== 'draft') refuse('No draft is waiting.');
    atomic(target, { ...draft, state: 'sending' });
  } finally { release(); }
  try {
    const ask = createAsk(ctx, { to: draft.to, project: draft.project ?? null, text: String(draft.question ?? ''), root: draft.root ?? null, chatTaskId: draft.taskId ?? null, threadId: draft.threadId ?? null, byOwner });
    atomic(target, { ...draft, state: 'sent', askId: ask.id }); return ask;
  } catch (error) { atomic(target, { ...draft, state: 'draft', error: error.message }); throw error; }
}
export function discardDraft(id) {
  const target = draftFile(id); noSymlinks(target);
  if (!fs.existsSync(target)) refuse('No draft is waiting.');
  const draft = readJson(target); atomic(target, { ...draft, state: 'discarded' }); return draft;
}
export function autoDrafts(ctx) {
  for (const draft of drafts().filter(row => row.state === 'draft' && !row.error)) {
    let member; try { member = teammate(ctx.me, draft.to); } catch { continue; }
    if (peerPolicy(member.key).autoAsk) { try { sendDraft(ctx, draft.id); } catch { /* Kept as a draft with its error. */ } }
  }
}
