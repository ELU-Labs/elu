import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EluCodeError, dataBlock, hash, homeOrAbove, isObject, mkdir, noSymlinks, personalDirectory, refuse } from './util.mjs';
import { nameProblem, readTask, sessionGoal, setTitle, taskDir, taskTitle, waitLock } from './state.mjs';
import { APPROVAL_WAIT_SECONDS, LABELS, MODES, PROFILES, capMode, checkFolders, checkPlace } from './modes.mjs';
import { SCRIPT_TOOL, SUMMARY_LIMIT, TOO_LONG, WHOLE_LIMIT, answerApproval, awaitDecision, ownersToAnswer, pendingApprovals, requestApproval } from './approvals.mjs';
import { addCard, closeSession, heldBySession, readBoard, removeCard, reopenSession, sessionArchived, sessionClosed, sessionPlace } from './kanban.mjs';
import { pendingRequests, removeRequest, takeRequest } from './workspace.mjs';
import { conversationEntries, projectName, projectSnapshot, registeredProjects } from './projects.mjs';
import { approveTask, currentTask, rejectTask } from './plan.mjs';
import { stopLine } from './stop-line.mjs';
import { archiveAsked, ownSession, subParent } from './session-commands.mjs';
import { BOT_NAME, botOversees, chatBots, getBot, sessionBots, sessionWorker } from './bots.mjs';
import { checkModel, modelText } from './models.mjs';
import { modelEfforts } from './bot-models.mjs';
import { runSteps } from './run-activity.mjs';
import { jobsWire } from './jobs.mjs';
import { agentThread, sessionAgents } from './session-agents.mjs';
import { DECISIONS_MAX, DECISION_MAX, GOAL_MAX, NAME_MAX, decisionsBlock, joinMandate, mandateById, mandateFor, mandates, saveMandate } from './orchestrator-mandates.mjs';
import { FULL_ASK_LIST, FULL_TOOLS, LEVEL_FULL } from './orchestrator-seams.mjs';
import { LOG_ROWS_DEFAULT, LOG_ROWS_MAX, TITLE_MAX, asOwnerMark } from './peer/remote-methods.mjs';
import { isMyComputer } from './peer/my-computers.mjs';
import { loadIdentity } from './peer/identity.mjs';
import { projectKey } from './peer/remote.mjs';
import { sentByElu } from './elu-sent.mjs';
import { scanSecrets } from './peer/secrets.mjs';
import { sanitize } from './peer/peerdata.mjs';
import { redact } from './publish.mjs';
import { compact, modelLabel, moneyText } from './agent-spend.mjs';
import { clock, proofText, readOverview, readSession, stateDigest } from './session-overview.mjs';
import { FACT_TOPICS, factText, factsElsewhere, findFacts, saveFact, withdrawFact } from './facts.mjs';
import { addOrgLine, checkOrgLine, findOrgLine, orgLines, removeOrgLine } from './org-section.mjs';
import { DEFAULT_CAPS, LEVEL_NAMES, capLines, levelLines, readSettings } from './orchestrator-settings.mjs';
import { awaitCommand, peerStatus, remoteMachines, remoteSessions, sendPeerCommand } from './peer/index.mjs';
import { computers } from './peer/session-tools.mjs';

// Everything the bot that oversees the owner's sessions does through ELU, it does through one
// function here: act. Its tools (lib/orchestrator-tools.mjs, served by lib/approval-server.mjs)
// are the only way it reads the sessions or changes them, and each call goes through the same
// steps, in this order:
//   1. the action is found (ACTIONS); a name that is not there is refused;
//   2. its hard rules, which no level lifts (each action's check);
//   3. the owner's level and caps, read anew from disk (lib/orchestrator-settings.mjs);
//   4. allowed, asked or refused by the level (LEVEL_TABLE);
//   5. the caps, counted from the action log;
//   6. where the level says ask: the owner is asked and his answer waited for. No answer in
//      time is "not answered", never a yes. A note or an answer to a session in Full access
//      asks him at every level that allows it, as an Organization line does;
//   7. the action, only when the log takes a line, and only when what it would do is what he
//      was shown: the same target, words and question, else nothing;
//   8. one line in the log, also for a refusal, a no and no answer;
//   9. plain text back to the model.
// Nothing here reads the session's mode to allow more: Full access lifts no rule, no level and
// no cap. The mode only lowers one thing, the mode of a session the bot starts.
//
// The level Full (lib/orchestrator-seams.mjs, docs: orchestrator full control) adds the session
// tools FULL_TOOLS: approve, stop, rename, archive, settings, log, agents and mandate_propose, and
// lets session_start choose everything a session starts with, on this computer or on one of the
// owner's own (lib/peer/my-computers.mjs). Inside one of his mandates
// (lib/orchestrator-mandates.mjs) a message, an answer, an approval and a start are his word: the
// request carries asOwner ({ bot, mandate, computer }, lib/peer/remote-methods.mjs) instead of
// the bot's own mark, and the log line says asOwner and the mandate. Outside a mandate they stay
// notes, as below. Below Full nothing of this exists, and each level does what it did.
//
// What it never does, at any level, and how that holds here (Full lifts the first only inside a
// mandate, through session_approve, and never for what the owner alone answers):
//   - Approve a Task or answer a permission request: no action does either. What it queues is
//     never marked typed, approved or picked, always carries its own mark (overseer), and is
//     taken back when the saved request does not hold that mark. It writes to no session whose
//     Task waits for the owner's approval.
//   - Move work to Done, delete a session, change a teammate's card: no action does. Its undo
//     of a session it started archives, never deletes, and a card is only ever added.
//   - Publish, merge or deploy: no action does, and its turn has no shell (lib/adapters/claude.mjs).
//   - Write to a session the owner stopped, archived or moved to Done, or one a teammate
//     started: writable below.
//   - Send anything out through a connected source without asking: that question is the
//     relay's (overseeingAnswer in lib/orchestrator-tools.mjs).
//
// The log: <personal>/orchestrator/actions.jsonl, one JSON object a line, only ever added to.
//   { id, at, bot, from: { root, session, run }, action, target, summary, level,
//     decision: 'allow' | 'deny' | 'timeout' | 'refused' | 'capped', by: 'level' | 'owner',
//     undo: { kind, … } | null, undoneAt: null, mark? }                          one call
//   { undid: id, at, how }                                                        one undone
// Ids are a1, a2, … on this computer. The caps are counted from this file and nowhere else.
// A call that spoke for the owner (at Full, inside a mandate) also has asOwner: true and mandate.

// The server ELU's own tools come from (APPROVAL_SERVER, lib/mcp.mjs), as an approval names a tool.
const TOOL_PREFIX = 'mcp__elu-code-approval__';
const HOUR = 3600000, DAY = 24 * HOUR, LIVE = ['running', 'preparing'];
const NOTE_CHARS = 2000, GOAL_CHARS = 4000, CARD_CHARS = 500, READ_CHARS = 1500, READ_MESSAGES = 6;
const time = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : 0; };
const iso = ms => new Date(ms).toISOString();
const firstLine = value => String(value ?? '').split('\n').find(line => line.trim())?.trim() ?? '';
// Text a model or a page wrote, as one line: cleaned as the screen cleans it, a key in it masked.
const flat = value => redact(sanitize(String(value ?? '')), 20000).replace(/\s+/g, ' ').trim();
const cut = (text, max) => text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
const one = (value, max = 200) => cut(flat(value), max);
// The same, keeping its lines, for what a tool hands back of a chat.
const body = (value, max = READ_CHARS) => { const text = redact(sanitize(String(value ?? '')), 100000).trim(), mark = ' … (cut)'; return text.length > max ? `${text.slice(0, max - mark.length)}${mark}` : text; };
const dollars = value => `$${Number(Number(value).toFixed(2))}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------------------
// The level's table: what each level answers for each tool. yes: done at once. ask: the
// owner is asked first. no: refused. A level or a tool that is not in it is refused.
const YES = 'yes', ASK = 'ask', NO = 'no';
const levels = (watch, suggest, act, run, full) => Object.freeze({ watch, suggest, act, run, [LEVEL_FULL]: full });
export const LEVEL_TABLE = Object.freeze({
  sessions_list: levels(YES, YES, YES, YES, YES),
  session_read: levels(YES, YES, YES, YES, YES),
  facts_find: levels(YES, YES, YES, YES, YES),
  connections_list: levels(YES, YES, YES, YES, YES),
  fact_save: levels(YES, YES, YES, YES, YES),
  card_add: levels(NO, YES, YES, YES, YES),
  org_propose: levels(NO, ASK, ASK, ASK, ASK),
  session_message: levels(NO, ASK, YES, YES, YES),
  session_answer: levels(NO, ASK, YES, YES, YES),
  session_start: levels(NO, ASK, ASK, YES, YES),
  // Full's own (FULL_TOOLS): nothing below it. A mandate is made only after the owner's yes.
  session_approve: levels(NO, NO, NO, NO, YES),
  session_stop: levels(NO, NO, NO, NO, YES),
  session_rename: levels(NO, NO, NO, NO, YES),
  session_archive: levels(NO, NO, NO, NO, YES),
  session_settings: levels(NO, NO, NO, NO, YES),
  session_log: levels(NO, NO, NO, NO, YES),
  session_agents: levels(NO, NO, NO, NO, YES),
  mandate_propose: levels(NO, NO, NO, NO, ASK),
});
export const decide = (level, name) => { const answer = Object.hasOwn(LEVEL_TABLE, name) && Object.hasOwn(LEVEL_TABLE[name], level ?? '') ? LEVEL_TABLE[name][level] : null; return answer === YES ? 'allow' : answer === ASK ? 'ask' : 'refuse'; };
const NOT_AT_WATCH = { card_add: 'adds no card', org_propose: 'proposes no Organization line', session_message: 'writes to no session', session_answer: 'answers no session', session_start: 'starts no session',
  session_approve: 'approves nothing', session_stop: 'stops no session', session_rename: 'renames no session', session_archive: 'archives no session', session_settings: 'changes no session', session_log: 'reads no session\'s log', session_agents: 'reads no session\'s agents', mandate_propose: 'proposes no mandate' };
const atLevel = (name, level) => `The owner set the level to ${LEVEL_NAMES[level] ?? 'Watch'}, where the bot ${NOT_AT_WATCH[name] ?? 'does not do this'}${FULL_TOOLS.includes(name) ? ': that needs the level Full' : ''}. Say in your reply what you would do and why. Only the owner changes the level, with /orchestrator.`;
const DENIED = 'The owner said no, so it was not done. Do not ask for it again unless something changed.';
const notAnswered = seconds => `The owner did not answer within ${plural(Math.max(1, Math.round(seconds / 60)), 'minute')}, so it was not done. No answer is not a yes. Say in your reply what waits for him.`;
const BUSY = 'ELU is finishing another of your actions. Nothing was done: try it once more.';
const UNMARKED = 'This build of ELU cannot mark a message as yours, and an unmarked one would read as the owner\'s own. Nothing was sent.';
const CHANGED = 'What you were asked about changed while you were asked. Nothing was done: ask again.';
const UNLOGGED = 'The action log cannot be written, so nothing was done. Say so in your reply.';

// ---------------------------------------------------------------------------------------
// The action log.
// Tests keep ELU's folder in a temporary place: one that reached the owner's own would count
// its made-up actions against his caps.
function logFolder() {
  if (process.env.NODE_TEST_CONTEXT && !process.env.XDG_CONFIG_HOME) refuse("A test must set XDG_CONFIG_HOME before it uses the orchestrator's log: the owner's own is never a test's to read or write.");
  return path.join(personalDirectory(), 'orchestrator');
}
export const actionsFile = () => path.join(logFolder(), 'actions.jsonl');
const ACTION_ID = /^a[1-9]\d*$/, DECISIONS = ['allow', 'deny', 'timeout', 'refused', 'capped'];
// A line of the file as a logged call, or null when it is not one.
function asRow(value) {
  if (!ACTION_ID.test(value.id ?? '') || typeof value.action !== 'string' || !DECISIONS.includes(value.decision)) return null;
  const from = isObject(value.from) ? value.from : {};
  return { id: value.id, at: typeof value.at === 'string' ? value.at : null, bot: typeof value.bot === 'string' ? value.bot : null,
    from: { root: typeof from.root === 'string' ? from.root : null, session: typeof from.session === 'string' ? from.session : null, run: typeof from.run === 'string' ? from.run : null },
    action: value.action, target: isObject(value.target) ? value.target : null, summary: typeof value.summary === 'string' ? value.summary : '', level: typeof value.level === 'string' ? value.level : null,
    decision: value.decision, by: value.by === 'owner' ? 'owner' : 'level', undo: isObject(value.undo) && typeof value.undo.kind === 'string' ? value.undo : null, undoneAt: null, undone: null, ...(typeof value.mark === 'string' ? { mark: value.mark } : {}),
    ...(typeof value.mandate === 'string' && /^m[1-9]\d{0,5}$/.test(value.mandate) ? { mandate: value.mandate } : {}), ...(value.asOwner === true ? { asOwner: true } : {}) };
}
// Every logged call, oldest first, each with whether it was undone since (undoneAt, and how:
// undone). Only the first line of an id is read. top: the highest id number in the file.
// first: the first line of each id, as written. ends: whether the file ends with a line end,
// so a line a crash cut short is never joined with the next.
function readLog() {
  const file = actionsFile(); noSymlinks(file);
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { rows: [], top: 0, first: new Map(), ends: true }; throw error; }
  const byId = new Map(), undid = new Map(), first = new Map(); let top = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value; try { value = JSON.parse(line); } catch { continue; }
    if (!isObject(value)) continue;
    if (ACTION_ID.test(value.undid ?? '')) { if (!undid.has(value.undid)) undid.set(value.undid, { at: typeof value.at === 'string' ? value.at : null, how: typeof value.how === 'string' ? value.how : 'undone' }); continue; }
    if (!ACTION_ID.test(value.id ?? '')) continue;
    top = Math.max(top, Number(value.id.slice(1)));
    if (first.has(value.id)) continue;
    first.set(value.id, line);
    const row = asRow(value); if (row) byId.set(row.id, row);
  }
  for (const [id, mark] of undid) { const row = byId.get(id); if (row) Object.assign(row, { undoneAt: mark.at ?? row.at, undone: mark.how }); }
  return { rows: [...byId.values()], top, first, ends: !text || text.endsWith('\n') };
}
function append(line, ends) {
  const file = actionsFile(); mkdir(path.dirname(file)); noSymlinks(file);
  fs.appendFileSync(file, `${ends ? '' : '\n'}${line}\n`, { mode: 0o600 });
}
// One call's line. The next id is the one after the highest in the file. Two turns that log
// at the same moment may both take it: the line that reached the file first keeps it, and the
// other is written once more under the next id, as a saved fact is (lib/facts.mjs).
function logAction(fields) {
  for (let tries = 0; tries < 50; tries++) {
    const { top, ends } = readLog(), row = { id: `a${top + 1}`, ...fields }, line = JSON.stringify(row);
    append(line, ends);
    if (readLog().first.get(row.id) === line) return row;
  }
  refuse('Too many turns are writing the action log at this moment.');
}
const logUndo = (id, how, now) => append(JSON.stringify({ undid: id, at: iso(now), how }), readLog().ends);
// Throws when the log would not take a line now: an action it could not log would count
// against no cap and have no undo, so none is done.
function logWritable() {
  const file = actionsFile(), dir = path.dirname(file); mkdir(dir); noSymlinks(file);
  fs.accessSync(fs.existsSync(file) ? file : dir, fs.constants.W_OK);
}
// What the bot looked at is logged too, so the owner can see it. It is no action. ask_elu is
// a question to ELU's own server, logged by the relay (logEluQuestion).
const READS = ['sessions_list', 'session_read', 'facts_find', 'connections_list', 'ask_elu', 'session_log', 'session_agents'];
// One question of the bot's to ELU's own server, which the relay lets through
// (lib/approval-server.mjs eluCall): counted against cap, the owner's questions to ELU a day,
// and logged as one line, allow or capped, under the log's own lock so two turns never both
// pass the cap. Returns { id, over, asked }: asked is how many went in the last 24 hours.
export function logEluQuestion({ bot, from = {}, summary, level = null, cap, now = Date.now() }) {
  const release = waitLock({ state: logFolder() }, 'actions', 300);
  try {
    const asked = readLog().rows.filter(row => row.action === 'ask_elu' && row.decision === 'allow' && time(row.at) > now - DAY).length, over = asked >= cap;
    const row = logAction({ at: iso(now), bot, from: { root: from.root ?? null, session: from.session == null ? null : String(from.session), run: from.run ?? null }, action: 'ask_elu', target: { server: 'elu', tool: 'ask_elu' }, summary, level, decision: over ? 'capped' : 'allow', by: 'level', undo: null, undoneAt: null });
    return { id: row.id, over, asked };
  } finally { release(); }
}
// The logged calls, oldest first. reads: false leaves out what it only looked at.
export function readActions({ reads = true } = {}) { return readLog().rows.filter(row => reads || !READS.includes(row.action)); }
// The newest count things it did or tried, newest first, for /orchestrator.
export const lastActions = (count = 5) => readActions({ reads: false }).slice(-Math.max(0, count)).reverse();
const HOW = { allow: 'done', deny: 'you said no', timeout: 'not answered', refused: 'refused', capped: 'over a cap' };
const UNDO_WORDS = { message: 'undo takes it back while it waits', card: 'undo removes it while it is in To do', session: 'undo takes it back before it starts, and archives it after', fact: 'undo withdraws it', org: 'undo removes the line, after your yes', rename: 'undo gives it its name back', archive: 'undo brings it back', unarchive: 'undo archives it again' };
const undoWords = undo => undo.kind === 'archive' && undo.archived === false ? UNDO_WORDS.unarchive : UNDO_WORDS[undo.kind] ?? null;
// One logged call as a line for /orchestrator: its id, when, who, what, as whom, how it ended, and how it is undone.
export function actionLine(row, now = Date.now()) {
  const how = row.decision === 'allow' ? row.by === 'owner' ? 'done after your yes' : 'done' : HOW[row.decision];
  const undo = row.undoneAt ? `undone (${row.undone})` : row.decision === 'allow' && row.undo ? undoWords(row.undo) : null;
  let mandate = null; if (row.asOwner && row.mandate) { try { mandate = mandateById(row.mandate)?.name ?? null; } catch { mandate = null; } }
  return [row.id, time(row.at) ? clock(time(row.at), now) : null, row.bot ? `@${row.bot}` : null, row.summary || row.action, row.asOwner ? `as you, under the mandate ${one(mandate ?? row.mandate, 40)}` : null, how, undo].filter(Boolean).join(' · ');
}
// What /orchestrator shows: the level, the caps, and the last five things it did or tried.
export function orchestratorLines({ now = Date.now(), count = 5 } = {}) {
  const settings = readSettings(), rows = lastActions(count);
  return [...levelLines(settings), '', 'Caps', ...capLines(settings.caps).map(line => `  ${line}`), '', rows.length ? `Last ${rows.length === 1 ? 'action' : `${rows.length} actions`}` : 'It has done nothing yet.', ...rows.map(row => `  ${actionLine(row, now)}`)];
}

// ---------------------------------------------------------------------------------------
// Caps, counted from the log. A day is the last 24 hours and an hour the last 60 minutes, so
// a burst around midnight counts as one. A line written after now still counts, so a clock
// set back starts no cap again. What was taken back before anything read it does not count;
// a session that started and was archived by undo still does.
const counts = row => row.decision === 'allow' && !(row.undoneAt && row.undone !== 'archived');
const NOTES = ['session_message', 'session_answer'];
// What counts against the messages and answers an hour: the notes and answers, and at Full the
// approvals it gives for the owner (nothing below Full approves).
const HOURLY = [...NOTES, 'session_approve'];
// Where a session stands, as one short mark: its Task and how far that is, what it committed
// and published, and how many messages the owner himself wrote there. Two marks that are the
// same mean nothing moved in between: a reply alone is not progress.
function progressMark(task, plan) {
  const steps = Array.isArray(plan?.subtasks) ? plan.subtasks.filter(row => row?.state === 'done').length : 0, met = Array.isArray(plan?.met) ? plan.met.length : 0;
  // What it sent as the owner's word (asOwner) is its own, and no progress either.
  const own = (Array.isArray(task.messages) ? task.messages : []).filter(row => isObject(row) && !row.bot && !row.from && !row.scheduled && !row.overseer && !row.asOwner && !row.computer && !row.line && !row.standup && !row.update && !row.loop && !sentByElu(row.text)).length;
  return hash([plan?.id ?? '', plan?.state ?? '', steps, met, task.commit ?? '', task.pushedCommit ?? '', task.pr ?? '', task.implementedAt ?? '', own].join('\0')).slice(0, 16);
}
function overCap(name, prepared, env, rows) {
  const caps = env.settings.caps, within = span => rows.filter(row => counts(row) && time(row.at) > env.now - span);
  if (name === 'session_start') {
    const made = within(DAY).filter(row => row.action === 'session_start').length;
    if (made >= caps.sessionsPerDay) return `The owner's cap is ${plural(caps.sessionsPerDay, 'session')} started a day, and you started ${made} in the last 24 hours. Add a To do card instead, or tell the owner what you would start.`;
  }
  if (name === 'card_add') {
    const made = within(DAY).filter(row => row.action === 'card_add').length;
    if (made >= caps.cardsPerDay) return `The owner's cap is ${plural(caps.cardsPerDay, 'card')} added a day, and you added ${made} in the last 24 hours. Say the rest in your reply.`;
  }
  if (HOURLY.includes(name)) {
    const sent = within(HOUR).filter(row => HOURLY.includes(row.action)).length;
    if (sent >= caps.messagesPerHour) return `The owner's cap is ${plural(caps.messagesPerHour, 'message')} and answers an hour, and you sent ${sent} in the last hour. Say it in your reply instead.`;
  }
  if (NOTES.includes(name)) {
    // The newest of what it sent this session, back to the first one sent before something moved there.
    const here = rows.filter(row => counts(row) && NOTES.includes(row.action) && row.target?.root === prepared.target.root && row.target?.session === prepared.target.session);
    let row = 0; for (let at = here.length - 1; at >= 0 && here[at].mark === prepared.mark; at--) row++;
    if (row >= caps.messagesInARow) return `You wrote to ${prepared.label} ${row === 1 ? 'once' : `${row} times`} and nothing moved there since: the owner's cap is ${caps.messagesInARow} in a row. Leave it, and tell the owner what it needs.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Whom a call names: a project of this computer and one of its sessions.
const projectLabel = repo => one(projectName(repo.root), 40) || path.basename(repo.root);
function projectFor(given, env) {
  let all = []; try { all = env.projects(); } catch { all = []; }
  if (given == null || given === '') return all.find(repo => repo.root === env.repo.root) ?? env.repo;
  if (typeof given !== 'string') refuse('Name the project by its name, as sessions_list shows it.');
  const wanted = given.trim(), key = wanted.toLowerCase();
  const found = path.isAbsolute(wanted) ? all.filter(repo => repo.root === wanted || repo.root === path.resolve(wanted))
    : all.filter(repo => flat(projectName(repo.root)).toLowerCase() === key || path.basename(repo.root).toLowerCase() === key);
  if (found.length === 1) return found[0];
  if (!found.length) refuse(`No project on this computer is named "${one(wanted, 60)}". sessions_list shows each session's project.`);
  refuse(`${found.length} projects on this computer are named "${one(wanted, 60)}". Name it by its folder: ${found.map(repo => repo.root).join(' or ')}.`);
}
// archived: one the owner archived is found too (session_archive brings one back).
function sessionFor(given, env, { archived = false } = {}) {
  if (given.computer != null && given.computer !== '' && !namesHere(given.computer)) return remoteFor(given, env, { archived });
  const repo = projectFor(given.project, env), id = String(given.session ?? '').trim().replace(/^#/, '');
  if (!/^[1-9][0-9]{0,9}$/.test(id)) refuse('Name the session by its number, as sessions_list shows it after #.');
  let task = null; try { task = readTask(repo, id); } catch { task = null; }
  if (!task) refuse(`${projectLabel(repo)} has no session ${id}. sessions_list lists them.`);
  if (['ask', 'review'].includes(task.origin?.kind)) refuse("That is a teammate's question, answered in its own thread. It is not one of the owner's sessions.");
  const label = `${projectLabel(repo)} #${id}`;
  return { repo, task, id, label, titled: `${label} '${one(taskTitle(task), 40)}'` };
}
// Whether the owner stopped it himself and has not started it again, as its stop line reads
// (lib/stop-line.mjs); from the record alone when that cannot be read.
function ownerStopped(task) {
  if (LIVE.includes(task.state)) return false;
  try { return /^You stopped it\b/.test(stopLine(task)?.text ?? ''); }
  catch { const message = String(task.error?.message ?? '').trim(); return /^Stopped by the owner\.?$/i.test(message) || task.state === 'stopped' && /\baborted\b/i.test(message); }
}
// The sessions the bot never writes to, at any level: the one it is in, one started from
// another computer or by a teammate, a Standup, a bot's own chat, one the owner archived,
// moved to Done or stopped, and one whose Task waits for his approval. A board that cannot be
// read answers none of that, so nothing is sent.
// owner: what goes is the owner's word (at Full, inside a mandate): a session he stopped, or
// whose Task waits for his approval, takes it, as it takes what he types.
function writable(target, env, { owner = false } = {}) {
  if (target.repo.root === env.repo.root && target.id === String(env.task.id)) refuse('That is the session you are in. Say it in your reply.');
  return sessionRules(target, env.now, { owner });
}
// The same rules, without the session the bot is in: also what a computer that runs a session
// checks before it takes a note the bot sent from another computer (lib/peer/remote.mjs).
// Returns the session's Task, or null. A session another computer of the project started here
// (task.mine) has no origin, so it is the owner's as one typed here is.
export const noteRules = (target, now = Date.now()) => sessionRules(target, now);
function sessionRules({ repo, task, id, label }, now = Date.now(), { owner = false } = {}) {
  const env = { now };
  if (!ownSession(task.origin)) refuse(`${label} was started from another computer or by a teammate. Only the owner writes to it.`);
  if (task.standup) refuse(`${label} is a Standup session. Its rounds are the owner's to ask for.`);
  if (task.botChat) refuse(`${label} is the owner's own chat with @${one(task.botChat, 30)}. Only the owner writes there.`);
  let board = null; try { board = readBoard(repo); } catch { board = null; }
  if (!board) refuse(`The board of ${projectLabel(repo)} could not be read, so ELU cannot tell whether ${label} is archived or in Done. Nothing was sent.`);
  if (sessionArchived(board, task) || archiveAsked(repo, id)) refuse(`${label} is archived. Only the owner brings it back.`);
  let place = null; try { place = sessionPlace(board, task, env.now); } catch { place = null; }
  if (sessionClosed(board, task) || place === 'done') refuse(`${label} is in Done. The owner checked it, and only he opens it again.`);
  if (!owner && ownerStopped(task)) refuse(`The owner stopped ${label}. It goes on when he says so.`);
  let plan = null; try { plan = currentTask(repo, id); } catch { plan = null; }
  if (!owner && plan?.state === 'proposed') refuse(`The Task of ${label} waits for the owner's approval. Only he approves a Task: say what you see in your reply.`);
  return plan;
}
// Words the bot wrote for a session, a card or a goal: there, not too long, and with no key in them.
function written(value, what, most) {
  if (typeof value !== 'string') refuse(`Write ${what}.`);
  const text = sanitize(value).replace(/\r\n?/g, '\n').trim();
  if (!text) refuse(`Write ${what}.`);
  if (text.length > most) refuse(`Keep ${what} to ${most} characters. This one has ${text.length}.`);
  if (scanSecrets(text).length) refuse('That may hold a secret, so it goes nowhere.');
  return text;
}
// What the owner is asked, on one line that fits where it shows (a summary is cut at
// SUMMARY_LIMIT, lib/approvals.mjs): the words before, then as much of the text as fits, in
// quotes, and how long the whole is when it was cut.
function asking(lead, text) {
  const whole = flat(text), room = SUMMARY_LIMIT - 1;
  if (lead.length + whole.length + 2 <= room) return `${lead}"${whole}"`;
  const tail = `…" (${whole.length} characters in all)`;
  return `${lead}"${whole.slice(0, Math.max(0, room - lead.length - 1 - tail.length))}${tail}`;
}
// The session's own question, when it stopped to ask one.
export const questionOf = task => { const reply = task.reply?.outcome === 'needs_input' ? task.reply : task.result; return task.state === 'needs_input' && typeof reply?.question === 'string' ? reply.question.trim() : ''; };
// That question as a mark (16 hex characters), or null when it asks none. An answer of the bot
// carries the mark of the question it answers (asks, lib/conductor.mjs enqueue), and goes in as
// the answer only while the session still asks that one (lib/projects.mjs ask).
export const questionMark = task => { const question = isObject(task) ? questionOf(task) : ''; return question ? hash(question).slice(0, 16) : null; };
// A session the owner set to Full access runs its next turn with every tool, on the bot's
// words: a note or an answer to it waits for his yes at every level that allows one.
const fullAccess = task => task.permissions === 'full';

// A request the bot queues: never typed, approved or picked, behind what the owner typed
// (priority 1, as a schedule's), and with its mark. The conductor that saves it must keep
// the mark (and, for a new session, its budget): a request saved without them would read as
// the owner's own message, so it is taken back and nothing is sent.
// A field that is an object (asOwner, a place, a model) is kept when it is kept the same.
const canon = value => JSON.stringify(value, (key, item) => isObject(item) ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
function queue(root, text, options, deps, needs, unkept = UNMARKED) {
  const row = deps.enqueue(root, text, { priority: 1, ...options });
  const kept = isObject(row) && Object.entries(needs).every(([name, value]) => canon(row[name]) === canon(value)) && !row.typed && !row.approved && !row.picked;
  if (!kept) { try { if (row?.id) takeRequest(root, row.id); } catch { /* It stays for the owner to see in the queue. */ } refuse(unkept); }
  try { deps.start(); } catch { /* It starts when the conductor next looks. */ }
  return row;
}
// The conductor's own functions, read when a call first needs them: a turn that only reads
// never loads it. A stand-in for either comes with the call (ctx.enqueue, ctx.startConductor).
async function queueing(env) {
  const conductor = typeof env.enqueue === 'function' && typeof env.startConductor === 'function' ? null : await import('./conductor.mjs');
  const start = env.startConductor ?? conductor.startConductor;
  // The conductor is started with the owner's environment, never with a session's own marks.
  return { enqueue: env.enqueue ?? conductor.enqueue, start: () => { const kept = {}; for (const name of ['ELU_SESSION', 'ELU_PROJECT', 'ELU_COMMAND_FOLDER']) { kept[name] = process.env[name]; delete process.env[name]; } try { start(); } finally { for (const [name, value] of Object.entries(kept)) if (value !== undefined) process.env[name] = value; } } };
}

// ---------------------------------------------------------------------------------------
// Connections: which MCP servers Claude Code has for this project, by name alone. Nothing of
// a server's entry (its URL, its headers, its command, its keys) is ever read out.
const SERVER = /^[A-Za-z0-9_.-]{1,64}$/, REACHED = { connected: 'connected in the last run that had it', 'needs-auth': 'not signed in when a run last had it', failed: 'did not start when a run last had it', pending: 'was still starting when a run last had it' };
// The servers a run was started with and how each went: the first row of its log says so.
function runServers(file) {
  try {
    noSymlinks(file);
    const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(512 * 1024); let length = 0;
    try { length = fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
    for (const line of buffer.toString('utf8', 0, length).split('\n').slice(0, 40)) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row?.type === 'system' && row.subtype === 'init') return (Array.isArray(row.mcp_servers) ? row.mcp_servers : []).flatMap(server => typeof server?.name === 'string' && SERVER.test(server.name) ? [[server.name, typeof server.status === 'string' ? server.status : '']] : []);
    }
  } catch { /* A log that cannot be read says nothing. */ }
  return [];
}
// How each server went in the newest Claude run of the project that had it: Map name → status.
function reachedIn(repo) {
  const seen = new Map();
  let tasks = []; try { tasks = projectSnapshot(repo).tasks; } catch { return seen; }
  // Only a log in the session's own folder is read, as the chat reads them (lib/projects.mjs).
  const own = task => { try { const dir = taskDir(repo, task.id); return (Array.isArray(task.runs) ? task.runs : []).filter(run => run?.vendor === 'claude' && typeof run.logFile === 'string' && path.dirname(run.logFile) === dir); } catch { return []; } };
  const runs = tasks.flatMap(own).sort((a, b) => time(b.at) - time(a.at)).slice(0, 12);
  for (const run of runs) for (const [name, status] of runServers(run.logFile)) if (!seen.has(name)) seen.set(name, status);
  return seen;
}
// You are started with the servers your own row names, not with the project's: the last step.
const onPage = name => mine => mine.includes(name) ? `${name} is on your own list already, so you have it from your next turn.` : `The owner adds ${name} on your page in the Bots tab, under MCP servers. You are started with the servers named there, not with the project's.`;
// The three sources worth offering, and the steps that connect each, for the owner to do.
const COMMON = Object.freeze([
  { name: 'ELU', has: names => names.includes('elu'), steps: [
    'In a shell: npx -y @elu-labs/cli --offer=promo. It signs the owner up, or in, and adds the server named elu to Claude Code.',
    'The key that command saves can change things in ELU as well as read them. For a bot that can only read ELU, the owner connects it with a key of a Viewer.',
    onPage('elu'),
  ] },
  { name: 'Slack', has: names => names.some(name => name.toLowerCase().includes('slack')), steps: [
    `In a shell, not in ELU: claude mcp add-json --scope user slack '{"type":"http","url":"https://mcp.slack.com/mcp","oauth":{"clientId":"<the client ID from Slack's page>","callbackPort":3118}}'`,
    'Then: claude mcp login slack, and finish in the browser. A workspace admin may have to approve it.',
    'In ELU, /mcp then lists slack.',
    "Not Slack's plugin, and not /mcp add: that saves the server without its client ID, and the sign-in then has nothing to sign in with.",
    'With more than one Claude account in ELU, a server signed in this way is signed in per account: claude mcp login slack once for each.',
    onPage('slack'),
  ] },
  { name: 'Gmail', has: names => names.some(name => name.toLowerCase().includes('gmail')), steps: [
    'A Gmail MCP server that runs as a command on this computer works. In ELU: /mcp add, the name gmail, and the command that starts it.',
    'The Gmail connector of claude.ai does not reach a session ELU starts: ELU starts each run with only the servers it hands over.',
    onPage('gmail'),
  ] },
]);
function connections(env, servers) {
  const names = Object.keys(servers).filter(name => SERVER.test(name)).sort(), mine = Array.isArray(env.bot.mcp) ? env.bot.mcp.filter(name => typeof name === 'string') : [];
  let reached = new Map(); try { reached = typeof env.reached === 'function' ? env.reached(env.repo.root) : reachedIn(env.repo); } catch { reached = new Map(); }
  const went = name => REACHED[reached.get(name)] ?? (reached.has(name) ? 'a run had it, and how that went is not known' : 'no run has had it yet');
  const lines = [names.length ? 'MCP servers set up in Claude Code for this project, by name:' : 'No MCP server is set up in Claude Code for this project.',
    ...names.map(name => `- ${name} · ${mine.includes(name) ? 'yours to use' : 'not on your list'} · ${went(name)}`)];
  const absent = mine.filter(name => !names.includes(name));
  if (absent.length) lines.push(`On your list but not set up in Claude Code: ${absent.map(name => one(name, 64)).join(', ')}.`);
  const missing = COMMON.filter(source => !source.has(names));
  lines.push(missing.length ? `Not connected: ${missing.map(source => source.name).join(', ')}.` : 'ELU, Slack and Gmail are all set up.');
  for (const source of missing) lines.push('', `To connect ${source.name}, the owner does this:`, ...source.steps.map((step, at) => `${at + 1}. ${typeof step === 'function' ? step(mine) : step}`));
  if (missing.length) lines.push('', 'Offer one connection at a time, when you meet a gap it would fill, and say what you would read there. Never ask for a key in the chat.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------
// The sessions on the other computers of the owner's projects: his devbox, and a teammate's
// computer on a shared project. Each lists its sessions to this one, and keeps each session
// this one follows up to date here (lib/peer/remote.mjs), so the bot reads them from files here
// as it reads the sessions of this computer: no model and no network for a list. Reading one
// in full follows it first when nothing here follows it yet. A note goes only through that
// computer, which holds it to the same rules (noteRules) and keeps it as the note of its own bot
// that oversees the sessions, never as the owner's words; a computer whose ELU cannot is never
// sent one (OVERSEE_UPDATE). For a test: env.computers(), env.machines(), env.views(),
// env.peerCommand(command).
const REMOTE_ROWS = 20, REMOTE_CHARS = 2400, VIEW_WAIT_MS = 8000, NO_PEER = "ELU's connection to the other computers is not running on this one.";
const REMOTE_RANK = ['Needs approval', 'Asks you', 'Blocked', 'Stopped', 'Ready for your check', 'Working', 'Queued', 'Replied'];
const nameKey = value => String(value ?? '').trim().replace(/^@/, '').toLowerCase();
const readOr = (read, fallback) => { try { const value = read(); return value ?? fallback; } catch { return fallback; } };
const othersOf = env => readOr(env.computers ?? computers, []).filter(row => isObject(row) && typeof row.key === 'string' && typeof row.name === 'string');
const machinesOf = env => readOr(env.machines ?? remoteMachines, []).filter(isObject);
const viewsOf = env => readOr(env.views ?? remoteSessions, []).filter(isObject);
async function peerCommand(command, env, timeoutMs = 30000) {
  if (typeof env.peerCommand === 'function') return env.peerCommand(command);
  if (peerStatus().running !== true) refuse(NO_PEER);
  return awaitCommand(sendPeerCommand(command).id, timeoutMs);
}
// What a session there waits for or does, as its computer listed it: the same words Sessions uses here.
function remoteStatus(row) {
  const approvals = Array.isArray(row.approvals) ? row.approvals : [], jobs = Array.isArray(row.jobs) ? row.jobs.length : 0;
  if (row.plan?.state === 'proposed') return { word: 'Needs approval', why: `Task to approve: ${one(row.plan.title, 80)}` };
  if (approvals.length) return { word: 'Needs approval', why: `approval: ${approvals.map(item => one(item.summary, 80)).join('; ')}` };
  if (row.question) return { word: 'Asks you', why: one(row.question, 200) };
  if (row.queued) return { word: 'Queued', why: 'waits to start there' };
  if (['starting', 'preparing', 'running'].includes(row.state) || jobs) return { word: 'Working', why: jobs ? `${plural(jobs, 'long job')} running` : '' };
  if (row.kept) return { word: 'Stopped', why: 'ELU stopped starting it by itself: its last turns made no progress. A message starts it again.' };
  if (row.state === 'blocked' || row.error) return { word: 'Blocked', why: one(row.error, 200) };
  if (['stopped', 'gone'].includes(row.state)) return { word: 'Stopped', why: '' };
  if (row.check) return { word: 'Ready for your check', why: row.finished ? 'its work is committed' : '' };
  return { word: 'Replied', why: '' };
}
const BY_WORDS = { schedule: 'a schedule', bot: 'a bot', teammate: "a teammate's message", mine: 'another computer' };
// Every session the other computers listed here that is not archived, what needs the owner first.
function remoteRows(env) {
  const machines = machinesOf(env), rows = [], notes = [];
  for (const computer of othersOf(env)) {
    const kept = machines.find(row => row.key === computer.key);
    if (!kept) { notes.push(`@${computer.name} has not listed its sessions here yet${computer.online ? '' : ' (offline)'}.`); continue; }
    if (kept.older) { notes.push(`Update ELU on @${computer.name} to see its sessions here.`); continue; }
    const names = new Map((Array.isArray(kept.projects) ? kept.projects : []).filter(isObject).map(row => [row.id, row.name]));
    for (const row of Array.isArray(kept.sessions) ? kept.sessions : []) {
      if (!isObject(row) || row.archived === true || typeof row.ref !== 'string') continue;
      const n = row.ref.split(':')[1] ?? '', status = remoteStatus(row);
      rows.push({ computer, row, n, project: one(names.get(row.project), 40) || 'a project', listedAt: time(kept.listedAt), ...status, rank: REMOTE_RANK.indexOf(status.word) });
    }
  }
  rows.sort((a, b) => a.rank - b.rank || time(b.row.since?.at ?? b.row.at) - time(a.row.since?.at ?? a.row.at));
  return { rows, notes };
}
// Those sessions as lines for a model, at most REMOTE_ROWS of them and REMOTE_CHARS characters.
export function remoteDigest(env = {}) {
  const now = Number.isFinite(env.now) ? env.now : Date.now(), { rows, notes } = remoteRows(env), lines = [];
  for (const item of rows.slice(0, REMOTE_ROWS)) {
    const at = time(item.row.since?.at ?? item.row.at), by = BY_WORDS[item.row.by];
    lines.push([`${item.word}: ${item.project} on @${item.computer.name} #${item.n || '(not started)'} ${one(item.row.title, 60)}`.trim(), item.why, at ? `since ${clock(at, now)}` : '', by ? `started by ${by}` : '', item.computer.online ? '' : `@${item.computer.name} is offline: as it listed ${item.listedAt ? clock(item.listedAt, now) : 'last'}`].filter(Boolean).join(' · '));
    if (JSON.stringify([...lines, ...notes]).length > REMOTE_CHARS) { lines.pop(); break; }
  }
  const left = rows.length - lines.length;
  return { lines: [...lines, ...(left > 0 ? [`${left} more ${left === 1 ? 'session is' : 'sessions are'} not shown.`] : []), ...notes], total: rows.length };
}
// Whether a name the bot gave is this computer's own.
function namesHere(given) {
  const wanted = nameKey(given);
  if (!wanted) return true;
  let status = null; try { status = peerStatus(); } catch { status = null; }
  const mine = (status?.teams ?? []).flatMap(team => team.members ?? []).find(member => member.key === status?.key);
  return [status?.box, mine?.box, mine?.name, status?.name].some(name => typeof name === 'string' && nameKey(name).replace(/\s+/g, '') === wanted);
}
// The session a call names on another computer: by that computer's name, its project there and
// its number. The name of its identity (devbox for sam-devbox) names it too, when one computer has it.
const onlyOne = rows => rows.length === 1 ? rows[0] : undefined;
// The session a call names on another computer: by that computer's name, its project there and its number.
function remoteFor(given, env, { archived = false } = {}) {
  const wanted = nameKey(given.computer), others = othersOf(env), computer = others.find(row => nameKey(row.name) === wanted || row.key === wanted) ?? onlyOne(others.filter(row => nameKey(row.person) === wanted));
  if (!computer) refuse(`No other computer on the owner's projects is named @${one(wanted, 40)}. sessions_list names each session's computer.`);
  const id = String(given.session ?? '').trim().replace(/^#/, '');
  if (!/^[1-9][0-9]{0,9}$/.test(id)) refuse('Name the session by its number, as sessions_list shows it after #.');
  const kept = machinesOf(env).find(row => row.key === computer.key), names = new Map((Array.isArray(kept?.projects) ? kept.projects : []).filter(isObject).map(row => [row.id, row.name]));
  const project = given.project == null || given.project === '' ? null : nameKey(given.project);
  const found = (Array.isArray(kept?.sessions) ? kept.sessions : []).filter(row => isObject(row) && (archived || row.archived !== true) && typeof row.ref === 'string' && row.ref.split(':')[1] === id && (!project || nameKey(flat(names.get(row.project))) === project));
  if (!found.length) refuse(`@${computer.name} lists no open session ${id}${project ? ` in ${one(given.project, 40)}` : ''}. sessions_list lists them.`);
  if (found.length > 1) refuse(`@${computer.name} has a session ${id} in ${found.length} projects: name the project too.`);
  const row = found[0], label = `${one(names.get(row.project), 40) || 'a project'} on @${computer.name} #${id}`;
  return { remote: true, computer, row, id, label, titled: `${label} '${one(row.title, 40)}'`, view: viewsOf(env).find(view => view.id === row.id) ?? null };
}
// What the bot may not write to there, as far as this computer can tell: that computer checks the rest.
// owner: the owner's word goes (at Full, inside a mandate), which a Task that waits for him takes.
function remoteWritable({ computer, row, label }, { owner = false } = {}) {
  if (row.by === 'teammate') refuse(`${label} answers a teammate's message there. Only the owner writes to it.`);
  if (row.queued) refuse(`${label} has not started yet. Write to it once it has.`);
  if (!owner && row.plan?.state === 'proposed') refuse(`The Task of ${label} waits for the owner's approval. Only he approves a Task: say what you see in your reply.`);
  if (!computer.online) refuse(`@${computer.name} is offline, so nothing can reach it now. Say it in your reply.`);
}
// Where a session there stands, from what this computer knows of it: two marks that are the same mean nothing moved.
function remoteMark({ row, view }) {
  const plan = isObject(view?.plan) ? view.plan : row.plan, steps = Array.isArray(plan?.subtasks) ? plan.subtasks.filter(item => item?.state === 'done').length : 0, met = Array.isArray(plan?.met) ? plan.met.length : 0;
  return hash(['remote', plan?.state ?? '', steps, met, row.finished === true, row.check === true, row.question ?? ''].join('\0')).slice(0, 16);
}
// The view of a session there, followed from here first when nothing here follows it yet.
async function remoteView(target, env) {
  if (target.view) return { view: target.view, note: null };
  if (!target.computer.online) return { view: null, note: `@${target.computer.name} is offline, and no copy of this session is kept here: only what it last listed is known.` };
  try { await peerCommand({ type: 'remoteWatch', to: target.computer.key, ref: target.row.ref }, env); }
  catch (error) { return { view: null, note: `It could not be followed from here: ${one(error?.message, 200)}` }; }
  const until = Date.now() + (Number.isFinite(env.viewWaitMs) ? env.viewWaitMs : VIEW_WAIT_MS);
  for (;;) {
    const view = viewsOf(env).find(item => item.id === target.row.id) ?? null;
    if (view && (view.behind !== true || (Array.isArray(view.entries) && view.entries.length))) return { view, note: null };
    if (Date.now() >= until) return { view, note: view ? 'Its chat is still on the way from that computer: what came is below.' : 'Its chat did not come from that computer in time: only what it listed is known.' };
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
// One session there, as session_read gives one of this computer's.
async function remoteRead(target, env) {
  const { computer, row, id, label } = target, { view, note } = await remoteView(target, env), status = remoteStatus(row), plan = isObject(view?.plan) ? view.plan : null;
  const met = new Set(Array.isArray(plan?.met) ? plan.met : []), steps = Array.isArray(plan?.subtasks) ? plan.subtasks : [], since = time(row.since?.at ?? row.at);
  const value = {
    computer: `@${computer.name}${computer.online ? '' : ' (offline)'}`, project: label.split(' on @')[0], session: id, title: one(view?.title ?? row.title, 120), state: status.word, doing: status.why || null,
    since: since ? clock(since, env.now) : null, startedBy: BY_WORDS[row.by] ?? 'the owner', model: view?.model ? one(view.model, 40) : null, access: view?.mode ? LABELS[view.mode] ?? one(view.mode, 20) : null,
    task: plan && plan.state !== 'rejected' ? { title: one(plan.title, 120), state: plan.state, goal: one(plan.goal, 500) || null, objectives: (Array.isArray(plan.objectives) ? plan.objectives : []).slice(0, 8).map((text, at) => ({ text: one(text, 300), met: met.has(at + 1) })), steps: steps.length ? `${steps.filter(item => item?.state === 'done').length} of ${steps.length} done` : null, eta: Number.isFinite(plan.etaMinutes) ? `${plan.etaMinutes} minutes (the agent's own estimate)` : null } : row.plan ? { title: one(row.plan.title, 120), state: row.plan.state } : null,
    asks: row.question ? body(view?.question ?? row.question) : null,
    // At Full each with its id, for session_approve; below Full what it asks, and no more.
    approvals: (Array.isArray(row.approvals) ? row.approvals : []).filter(isObject).map(item => atFull(env) && typeof item.id === 'string' ? { id: one(item.id, 80), asks: one(item.summary, 200) } : one(item.summary, 200)),
    error: row.error ? one(row.error, 300) : null, ended: view?.ended ? one(view.ended, 120) : null,
    ...fullRead(target, env),
    messages: (Array.isArray(view?.entries) ? view.entries : []).filter(entry => isObject(entry) && typeof entry.text === 'string' && entry.text.trim() && !entry.shell).slice(-READ_MESSAGES).map(entry => ({ from: one(entry.role, 60), at: entry.at ?? null, text: body(entry.text) })),
    ...(note ? { note } : {}),
  };
  return dataBlock(`Session ${label}`, value);
}
// A note or an answer to a session there, through its computer: { overseer, waits }. word: at
// Full, inside a mandate, it goes as the owner's word (asOwner), which that computer honours only
// when it marks this one as the owner's own and says so (asOwner: true in its answer); a computer
// that does not keeps it as the note of its own bot that oversees (overseer), as before.
const remoteNote = (target, text, env, answers = null, word = null) => peerCommand({ type: 'remoteSend', to: target.computer.key, ref: target.row.ref, text, overseer: env.name, ...(answers ? { answers } : {}), ...(word ? { asOwner: word.mark } : {}) }, env);
function remoteSent(target, out, env, what, word = null) {
  if (word && out?.asOwner === true) return `${what} ${target.titled} as the owner's word, under his mandate ${one(word.mandate.name, 60)}. It shows there as his, via @${env.name}${out?.waits ? `, and waits there for his yes on @${target.computer.name}` : ''}.`;
  const note = `${what} ${target.titled}. It shows there under @${out?.overseer ?? env.name}, as a note and not as the owner's word${out?.waits ? `, and waits there for the owner's yes on @${target.computer.name}` : ''}.`;
  return word ? `${note} @${target.computer.name} did not take it as the owner's word: its ELU may need an update, or it does not mark this computer as his own.` : note;
}

// ---------------------------------------------------------------------------------------
// The level Full (lib/orchestrator-seams.mjs). What its tools share: whether a session is in one
// of the owner's mandates, and so takes the bot's words as his; the rules for a session it
// changes; and the checks of what a session it starts or changes is given.
const atFull = env => env.settings?.level === LEVEL_FULL;
// Whether another computer is one of the owner's own, as this computer marks it. A stand-in for a test: env.isMyComputer(key).
const mineThere = (env, key) => { try { return typeof env.isMyComputer === 'function' ? env.isMyComputer(key) === true : isMyComputer(key); } catch { return false; } };
// This computer's own key, for the mark of what it sends as the owner's word. A stand-in: env.myKey.
function thisKey(env) { if (typeof env.myKey === 'string') return env.myKey; try { const key = loadIdentity()?.key; return /^[0-9a-f]{64}$/.test(key ?? '') ? key : null; } catch { return null; } }
const notMine = computer => `@${computer.name} is not marked as one of the owner's own computers here, so the bot changes nothing there and its words are never his there. Only he marks one, with /computers mine on this computer.`;
// A session as a mandate names it (lib/orchestrator-mandates.mjs): the computer (null here), the project's id there, its number.
const localRef = (repo, id) => ({ computer: null, project: projectKey(repo.root), session: String(id) });
const remoteRef = target => ({ computer: target.computer.key, project: target.row.ref.split(':')[0], session: target.id });
// A session it started is found by what the start left: the request, while it is still in the
// queue, else the one session made after the call with its goal and its mark (overseer).
const startedBy = (task, row) => !task.origin && typeof task.goal === 'string' && hash(task.goal).slice(0, 16) === row.undo?.goal && time(task.createdAt) >= time(row.at) - 1000 && typeof row.bot === 'string' && task.overseer === row.bot;
function cameFrom(repo, task, row) {
  let waiting = null; try { waiting = pendingRequests(repo.root).find(request => request.id === row.undo.request) ?? null; } catch { waiting = null; }
  return waiting ? waiting.taskId != null && String(waiting.taskId) === String(task.id) : startedBy(task, row);
}
// The mandate a session of this computer is in, or null. One it started under a mandate joined
// it by its request (session_start), and joins it by its number the first time it is looked for.
function mandateOfLocal(repo, task) {
  const ref = localRef(repo, task.id), found = mandateFor(ref);
  if (found) return found;
  let rows = null;
  for (const mandate of mandates()) for (const row of mandate.sessions) {
    if (row.computer !== null || row.project !== ref.project || !row.session.startsWith('request-')) continue;
    rows ??= readLog().rows;
    const start = rows.find(value => value.action === 'session_start' && value.decision === 'allow' && value.undo?.kind === 'session' && value.undo.root === repo.root && `request-${value.undo.request}` === row.session);
    if (start && cameFrom(repo, task, start)) { try { return joinMandate(mandate.id, ref, { by: 'start' }); } catch { return mandate; } }
  }
  return null;
}
// The same for a session there: by its number, or, for one it started from here, by the id it was started with.
function mandateOfRemote(target) {
  const ref = remoteRef(target), found = mandateFor(ref);
  if (found) return found;
  const id = typeof target.row.remoteId === 'string' ? target.row.remoteId : null;
  const started = id ? mandates().find(mandate => mandate.sessions.some(row => row.computer === ref.computer && row.session === id)) ?? null : null;
  if (started) { try { return joinMandate(started.id, ref, { by: 'start' }); } catch { return started; } }
  return null;
}
// Whether what the bot sends this session is the owner's word: at Full, inside one of his
// mandates, and on this computer or one he marked as his own. { mandate, mark } or null.
function ownerWord(target, env) {
  if (!atFull(env)) return null;
  if (target.remote) {
    if (!mineThere(env, target.computer.key)) return null;
    const mandate = mandateOfRemote(target), me = mandate ? thisKey(env) : null, mark = me ? asOwnerMark({ bot: env.name, mandate: mandate.id, computer: me }) : null;
    return mark ? { mandate, mark } : null;
  }
  const mandate = mandateOfLocal(target.repo, target.task), mark = mandate ? asOwnerMark({ bot: env.name, mandate: mandate.id, computer: null }) : null;
  return mark ? { mandate, mark } : null;
}
// What session_read adds at Full: the permission requests that wait there, each with its id
// (this computer's; another's are in its listing), and the mandate it is in, if any.
function fullRead(target, env) {
  if (!atFull(env)) return {};
  let mandate = null; try { mandate = target.remote ? mineThere(env, target.computer.key) ? mandateOfRemote(target) : null : mandateOfLocal(target.repo, target.task); } catch { mandate = null; }
  const out = { mandate: mandate ? `${mandate.id} ${one(mandate.name, 60)}: your words there are the owner's` : null };
  if (!target.remote) {
    let rows = []; try { rows = pendingApprovals({ root: target.repo.root, taskId: target.id }); } catch { rows = []; }
    out.approvals = rows.map(item => ({ id: item.id, asks: one(item.summary, 200), ...(item.oversee === true || item.tool === SCRIPT_TOOL || ownersToAnswer(item) ? { owner: 'only the owner answers it' } : {}) }));
  }
  return out;
}
// A conductor that does not keep the owner's mark (asOwner) on a request sends nothing as his.
const NO_OWNER_MARK = "ELU on this computer does not keep the owner's mark on a request yet, so nothing was sent as his word. Say it in your reply: ELU here needs an update.";
// What the log says of a call that spoke for the owner.
const spoke = word => word ? { asOwner: true, mandate: word.mandate.id } : {};
// A session of this computer the bot changes at Full (stop, rename, archive, settings): one of
// the owner's own, never the one it is in, a Standup or his chat with a bot.
function controllable(target, env) {
  if (target.repo.root === env.repo.root && target.id === String(env.task.id)) refuse('That is the session you are in. Only the owner changes it.');
  const { task, label } = target;
  if (!ownSession(task.origin)) refuse(`${label} was started from another computer or by a teammate. Only the owner changes it.`);
  if (task.standup) refuse(`${label} is a Standup session. Only the owner changes it.`);
  if (task.botChat) refuse(`${label} is the owner's own chat with @${one(task.botChat, 30)}. Only he changes it.`);
}
// A session there: only on one of the owner's own computers, and never a teammate's.
function remoteControl({ computer, row, label }, env) {
  if (!mineThere(env, computer.key)) refuse(notMine(computer));
  if (row.by === 'teammate') refuse(`${label} answers a teammate's message there. Only the owner touches it.`);
  if (!computer.online) refuse(`@${computer.name} is offline, so nothing can reach it now. Say it in your reply.`);
}
const there = target => ({ root: `@${target.computer.key}`, session: target.row.ref });
const herePlace = target => ({ root: target.repo.root, session: target.id });
const whereOf = target => target.remote ? there(target) : herePlace(target);
// A model as a call gives it: { vendor, model, effort }, model and effort left out for the
// vendor's own. Checked here for a session of this computer; for one there, its computer checks it.
const PLAIN_MODEL = /^[A-Za-z0-9._:\/@-]{1,80}$/, PLAIN_EFFORT = /^[a-z]{1,20}$/;
function modelOf(value, what, { here = true } = {}) {
  if (!isObject(value) || typeof value.vendor !== 'string' || !value.vendor.trim()) refuse(`Give ${what} as { vendor, model, effort }: the vendor, with the model and the effort when not its own.`);
  const vendor = value.vendor.trim().toLowerCase(), model = value.model == null || value.model === '' ? null : String(value.model).trim(), effort = value.effort == null || value.effort === '' ? null : String(value.effort).trim().toLowerCase();
  if (!BOT_NAME.test(vendor) || model !== null && !PLAIN_MODEL.test(model) || effort !== null && !PLAIN_EFFORT.test(effort)) refuse(`ELU names no model that way: ${one(JSON.stringify(value), 80)}.`);
  if (!here) return { vendor, model, ...(effort ? { effort } : {}) };
  const checked = checkModel({ vendor, model });
  if (effort) { const takes = modelEfforts(checked.vendor, checked.model); if (!takes.includes(effort)) refuse(`${modelText(checked)} takes ${takes.length ? `the efforts ${takes.join(', ')}` : 'no effort setting'}, not ${effort}.`); }
  return { vendor: checked.vendor, model: checked.model, ...(effort ? { effort } : {}) };
}
const modelWords = choice => `${modelText(choice)}${choice.effort ? ` at ${choice.effort}` : ''}`;
// Bot names a call gives: saved bots of the owner's, never one that oversees (it is in no session).
function botNames(value, { here = true } = {}) {
  if (value == null || value === '') return [];
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string')) refuse('Name the bots as a list of their names.');
  const names = [...new Set(value.map(name => name.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
  for (const name of names) {
    if (!BOT_NAME.test(name)) refuse(`There is no bot named ${one(name, 40)}.`);
    if (!here) continue;
    const bot = getBot(name);
    if (!bot) refuse(`There is no bot named ${one(name, 40)}. The Bots tab lists the owner's.`);
    if (botOversees(bot)) refuse(`@${name} oversees the sessions: it joins none of them.`);
  }
  return here ? chatBots(names) : names;
}
// A model and effort for some of the session's bots: { name: { vendor, model, effort } }.
function botModelsOf(value, bots, { here = true } = {}) {
  if (value == null) return {};
  if (!isObject(value)) refuse('Give the bots\' models as { name: { vendor, model, effort } }.');
  const out = {};
  for (const [given, choice] of Object.entries(value).slice(0, 12)) {
    const name = given.trim().replace(/^@/, '').toLowerCase();
    if (!BOT_NAME.test(name)) refuse(`There is no bot named ${one(given, 40)}.`);
    if (bots && !bots.includes(name)) refuse(`@${name} is not one of the session's bots, so it has no model there.`);
    out[name] = modelOf(choice, `the model of @${name}`, { here });
  }
  return out;
}
// Extra folders a session it starts may read: absolute paths, at most eight. Checked here by
// what the session's mode allows; on another computer, by that computer.
function foldersOf(value, mode, { here = true } = {}) {
  if (value == null || value === '') return [];
  if (!Array.isArray(value) || value.some(dir => typeof dir !== 'string' || !path.isAbsolute(dir.trim()))) refuse('Name the folders as a list of absolute paths.');
  const dirs = [...new Set(value.map(dir => dir.trim()))];
  if (dirs.length > 8) refuse('A session reads at most eight extra folders.');
  return here ? checkFolders(dirs, { mode }) : dirs;
}
// The owner's name for a session: one line, at most TITLE_MAX characters, with no key in it.
function nameOf(value) {
  if (typeof value !== 'string') refuse('Write the name as text.');
  const name = sanitize(value).replace(/\s+/g, ' ').trim();
  if (!name) refuse('Write the name.');
  if (name.length > TITLE_MAX) refuse(`Keep the name to ${TITLE_MAX} characters. This one has ${name.length}.`);
  const problem = nameProblem(name); if (problem) refuse(problem);
  if (scanSecrets(name).length) refuse('That may hold a secret, so it goes nowhere.');
  return name;
}
// A mandate a call names, by its id (m1) or its name.
function mandateNamed(value) {
  if (typeof value !== 'string' || !value.trim()) refuse('Name the mandate by its id or its name.');
  const wanted = value.trim().toLowerCase(), all = mandates(), found = all.find(row => row.id === wanted) ?? all.find(row => row.name.toLowerCase() === wanted);
  if (!found) refuse(`The owner has no mandate named ${one(value, 60)}${all.length ? `. His mandates: ${all.map(row => `${row.id} ${one(row.name, 40)}`).join(', ')}` : ''}. Only he makes one; mandate_propose asks him.`);
  return found;
}
// Another computer of the owner's projects, by its name, as sessions_list names it after on @.
function computerNamed(given, env) {
  const wanted = nameKey(given), others = othersOf(env);
  const computer = others.find(row => nameKey(row.name) === wanted || row.key === wanted) ?? onlyOne(others.filter(row => nameKey(row.person) === wanted));
  if (!computer) refuse(`No other computer on the owner's projects is named @${one(wanted, 40)}. sessions_list names each session's computer.`);
  return computer;
}
const placeWords = place => place.kind === 'here' ? 'in its project folder itself' : place.kind === 'branch' ? `on the branch ${place.branch}` : 'in a new worktree';
const botWords = bots => bots.length ? bots.map(name => `@${name}`).join(' and ') : 'no bots';

// What a run's log says, as rows for the model: the newest last, each cleaned, a key masked, and
// one that may still hold a secret not shown (lib/peer/secrets.mjs).
const STEP_KINDS = ['thinking', 'tool', 'text', 'plan', 'background'], LOG_CHARS = 600;
function logText(value) {
  const text = body(value, LOG_CHARS);
  return scanSecrets(text).length ? '[not shown: it may hold a secret]' : text;
}
function logRow(step) {
  if (!isObject(step)) return null;
  const kind = STEP_KINDS.includes(step.kind) ? step.kind : 'text';
  const text = kind === 'plan' && Array.isArray(step.entries) ? step.entries.filter(isObject).map(row => `[${row.state === 'done' ? 'x' : row.state === 'doing' ? '>' : ' '}] ${String(row.text ?? '')}`).join('\n') : String(step.text ?? '');
  return { kind, text: logText(text), ...(typeof step.status === 'string' ? { status: one(step.status, 20) } : {}), ...(typeof step.note === 'string' && step.note ? { note: one(step.note, 80) } : {}), ...(step.sub ? { helper: true } : {}) };
}
function rowsWanted(value) {
  if (value == null || value === '') return LOG_ROWS_DEFAULT;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > LOG_ROWS_MAX) refuse(`Ask for 1 to ${LOG_ROWS_MAX} rows.`);
  return count;
}
// The role a call names: the session's model (lead), or one of its bots.
function roleWanted(value) {
  if (value == null || value === '' || value === 'lead' || value === '@lead') return 'lead';
  const name = String(value).trim().replace(/^bot:/, '').replace(/^@/, '').toLowerCase();
  if (!BOT_NAME.test(name)) refuse('Name the role as lead, or a bot as @name.');
  return `bot:${name}`;
}
// The log of the active run of that role, else of its last one. Only a log in the session's own folder is read.
function logOf(repo, task, role) {
  let dir; try { dir = taskDir(repo, task.id); } catch { return null; }
  const own = file => typeof file === 'string' && path.dirname(file) === dir;
  if (LIVE.includes(task.state) && (task.activeRole ?? 'lead') === role && own(task.activeLog)) return { file: task.activeLog, live: true };
  const run = (Array.isArray(task.runs) ? task.runs : []).filter(row => isObject(row) && (row.role ?? 'lead') === role && own(row.logFile)).sort((a, b) => time(b.at) - time(a.at))[0];
  return run ? { file: run.logFile, live: false, at: run.at ?? null, model: modelLabel(run.model) || null } : null;
}
// An agent row of the Agents tab (lib/session-agents.mjs), for the model: its words cleaned.
function agentRow(row) {
  if (!isObject(row) || typeof row.id !== 'string') return null;
  const plain = (value, max) => value == null ? null : one(value, max) || null;
  return { id: one(row.id, 120), kind: plain(row.kind, 20), name: plain(row.name, 80), parent: plain(row.parent, 120), model: plain([row.vendor, row.model].filter(Boolean).join(' · '), 80), effort: plain(row.effort, 20), state: plain(row.state, 20), since: plain(row.since, 40),
    spend: Number.isFinite(row.spend) ? dollars(row.spend) : null, summary: logText(row.summary ?? '') };
}
const entryRow = entry => isObject(entry) ? { at: typeof entry.at === 'string' ? one(entry.at, 40) : null, kind: one(entry.kind, 20) || 'note', text: logText(entry.text ?? ''), ...(typeof entry.tool === 'string' ? { tool: one(entry.tool, 60) } : {}) } : null;

// What still asks the owner at Full, as at every level: the commands of FULL_ASK_LIST, matched
// as Claude Code matches its rules, and also anywhere in a command line (after cd, inside bash -c,
// behind a variable), with the same words in other spellings: a force or tags push however it is
// written, npm's publish under yarn and pnpm, rm -r of the home folder. Asking more than the list
// says is safe; asking less never is.
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BEFORE = '(?:^|[\\s;&|(){}`\'"=])', AFTER = '(?=$|[\\s;&|(){}`\'"])';
const ASK_RULES = FULL_ASK_LIST.map(rule => {
  const inner = rule.replace(/^Bash\(/, '').replace(/\)$/, ''), prefix = inner.endsWith(':*'), text = prefix ? inner.slice(0, -2) : inner;
  const source = text.split('*').map(part => part.trim().split(/\s+/).filter(Boolean).map(escapeRe).join('\\s+')).join('.*');
  return new RegExp(`${BEFORE}${source}${prefix ? AFTER : ''}`);
});
const ASK_MORE = [
  /(?:^|[\s;&|(){}`'"=])(?:npm|pnpm|yarn|bun)\s+(?:[^\s;&|]+\s+)*publish(?=$|[\s;&|)'"`])/,
  /(?:^|[\s;&|(){}`'"=])git\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace)\s+\S+\s+|-\S+\s+)*push\b[^;&|\n]*\s(?:--force\b|--force-with-lease\b|-[a-zA-Z]*f[a-zA-Z]*\b|\+[^\s]+|--tags\b|--follow-tags\b|--mirror\b)/,
  /(?:^|[\s;&|(){}`'"=])git\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace)\s+\S+\s+|-\S+\s+)*tag\b/,
  /(?:^|[\s;&|(){}`'"=])gh\s+(?:release|repo\s+delete|workflow\s+run)\b/,
];
const homeTargets = () => { const home = os.homedir(), out = ['~', '$HOME', '${HOME}']; if (home) { out.push(home); try { out.push(fs.realpathSync(home)); } catch { /* The home as it is named. */ } } return [...new Set(out)]; };
// rm with a recursive flag, of the home folder itself or everything in it.
function removesHome(command) {
  const targets = homeTargets();
  for (const part of command.split(/[;&|\n]+/)) {
    const words = part.trim().split(/\s+/).map(word => word.replace(/^["']|["']$/g, ''));
    const at = words.findIndex(word => /(?:^|\/)rm$/.test(word));
    if (at < 0) continue;
    const rest = words.slice(at + 1), recursive = rest.some(word => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(word) || word === '--recursive');
    if (recursive && rest.some(word => targets.some(home => [home, `${home}/`, `${home}/*`, `${home}/.`, `${home}/..`].includes(word) || word.startsWith('~') && word.length <= 3))) return true;
  }
  return false;
}
// A deploy, as the design's ask list says (section 7): a deploy word where a command runs one
// (firebase deploy, gcloud run deploy, npm run deploy, make deploy, deploy:prod), terraform
// apply, kubectl apply, helm install or upgrade, docker push, vercel --prod. Looked for outside
// the text of a commit message or a pull request's, which only names one.
const DEPLOYS = [
  /(?:^|[\s;&|(){}`'"=:/])deploy(?:[:_-][\w.-]*)?(?=$|[\s;&|)'"`])/,
  /(?:^|[\s;&|(){}`'"=])(?:terraform|tofu)\s+(?:[^\s;&|]+\s+)*(?:apply|destroy)\b/,
  /(?:^|[\s;&|(){}`'"=])kubectl\s+(?:[^\s;&|]+\s+)*(?:apply|delete|rollout|scale|set)\b/,
  /(?:^|[\s;&|(){}`'"=])helm\s+(?:[^\s;&|]+\s+)*(?:install|upgrade|uninstall|rollback)\b/,
  /(?:^|[\s;&|(){}`'"=])docker\s+(?:[^\s;&|]+\s+)*push\b/,
  /(?:^|[\s;&|(){}`'"=])vercel\b[^;&|\n]*\s--prod\b/,
];
const WORDS_ONLY = /(?:^|\s)(?:-m|--message|--body|--title|-b|-t|--notes)(?:\s+|=)(?:"(?:[^"\\]|\\.)*"|'[^']*')/g;
export function askListed(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const text = command.replace(/\\\n/g, ' '), plain = text.replace(WORDS_ONLY, ' ');
  return ASK_RULES.some(rule => rule.test(text)) || ASK_MORE.some(rule => rule.test(text)) || removesHome(text) || DEPLOYS.some(rule => rule.test(plain));
}
// A permission request a session waits on that the bot never answers for the owner, even inside
// a mandate: the bot's own questions, a refresh script, what he reads whole (a source's tool, a
// long one, a removal) and what FULL_ASK_LIST holds.
function ownersAlone(item, label) {
  if (item.oversee === true) refuse('That is a question of the bot that oversees the sessions: only the owner answers it.');
  if (item.tool === SCRIPT_TOOL) refuse('A refresh script is allowed by the owner, who reads it whole. Say in your reply what waits for him.');
  if (ownersToAnswer(item) || /\bmcp__/.test(item.summary ?? '')) refuse(`The owner reads that request of ${label} whole and answers it himself. Say in your reply what waits for him.`);
  const command = item.tool === 'Bash' && typeof item.input?.command === 'string' ? item.input.command : '';
  if (askListed(command) || askListed(String(item.summary ?? '').replace(/^[A-Za-z ]+:\s*/, ''))) refuse('That publishes, tags, releases, runs a workflow, force-pushes or deletes: it is the owner\'s to answer, at every level.');
}

// A session archived by the bot at Full, as the owner's archive does (lib/session-commands.mjs):
// its long jobs end, and what the owner and the bot sent it that no turn read goes with it.
function archiveSession(repo, id, now) {
  closeSession(repo, String(id));
  try { for (const request of heldBySession(pendingRequests(repo.root)).get(String(id)) ?? []) if (!request.origin) removeRequest(repo.root, request.id); } catch { /* Archived all the same. */ }
  try { takeBackNotes(repo.root, id, { now }); } catch { /* Archived all the same. */ }
}
// The name the bot gave a session (session_rename) and nobody changed since: the bot may change it again.
function botNamed(target) {
  if (target.task.titleBy !== 'owner') return false;
  const row = readLog().rows.filter(value => value.action === 'session_rename' && value.decision === 'allow' && !value.undoneAt && value.target?.root === target.repo.root && value.target?.session === target.id).at(-1);
  return typeof row?.undo?.name === 'string' && row.undo.name === target.task.title;
}
// session_start at Full: everything a session starts with, on this computer or on one of the
// owner's own. Checked here as far as this computer can tell; that computer checks the rest.
// The mode is never more than this session and this turn have, nor than the owner's cap.
function fullStart(given, env) {
  const caps = env.settings.caps, goal = written(given.goal, 'the goal of the session', GOAL_CHARS);
  const remote = given.computer != null && given.computer !== '' && !namesHere(given.computer), here = !remote;
  const computer = remote ? computerNamed(given.computer, env) : null;
  if (computer) { if (!mineThere(env, computer.key)) refuse(notMine(computer)); if (!computer.online) refuse(`@${computer.name} is offline, so nothing can start there now. Say it in your reply.`); }
  const repo = remote ? null : projectFor(given.project, env);
  if (repo && homeOrAbove(repo.root)) refuse(`${projectLabel(repo)} is the owner's home folder. A session there reaches every file of his, so only he starts one.`);
  const project = remote && given.project != null && given.project !== '' ? one(given.project, 80) : null;
  const wanted = given.access == null || given.access === '' ? caps.startMode : String(given.access).trim().toLowerCase();
  if (!MODES.includes(wanted)) refuse('Set access to ask, auto or full.');
  const own = MODES.includes(env.task.permissions) ? env.task.permissions : 'ask', turn = PROFILES.includes(env.mode) ? env.mode : own;
  const mode = capMode(capMode(capMode(wanted, caps.startMode), own), turn);
  if (!MODES.includes(mode)) refuse('This session is Read only, and a session it starts would get no more. Nothing was started.');
  const place = checkPlace(given.place ?? null, { mode });
  const folders = foldersOf(given.folders, mode, { here }), bots = botNames(given.bots, { here }), botModels = botModelsOf(given.botModels, bots, { here });
  const model = given.model == null ? null : modelOf(given.model, 'the model of the session', { here });
  const title = given.title == null || given.title === '' ? null : nameOf(given.title);
  const mandate = given.mandate == null || given.mandate === '' ? null : mandateNamed(String(given.mandate));
  // A mandate's standing decisions go into the starting text: a session acts on it most reliably.
  const block = mandate ? decisionsBlock(mandate) : '', text = block ? `${goal}\n\n${block}` : goal;
  if (text.length > GOAL_CHARS + 4000) refuse('The goal and the mandate\'s decisions are too long together. Shorten the goal.');
  const budget = caps.startBudgetUsd ?? null, where = remote ? `on @${computer.name}${project ? ` in ${project}` : ''}` : `in ${projectLabel(repo)}`;
  const said = [`${LABELS[mode]}${mode !== wanted ? ` (the most it may give; ${LABELS[wanted]} was asked)` : ''}`, budget === null ? 'its own budget' : `a ${dollars(budget)} budget`, placeWords(place), model ? modelWords(model) : null, botWords(bots), folders.length ? `${plural(folders.length, 'extra folder')}` : null, mandate ? `under the mandate ${one(mandate.name, 40)}` : null].filter(Boolean);
  const head = `Start a session ${where}${title ? ` named "${one(title, 60)}"` : ''} with ${said.join(', ')}: `, asked = asking(head, goal);
  return { full: true, remote, computer, repo, project, goal, text, mode, place, folders, bots, botModels, model, mandate, budget, said, where, name: title,
    target: remote ? { computer: computer.key, ...(project ? { project } : {}) } : { root: repo.root }, summary: asked, title: asked, whole: text };
}
// The fields a start at Full gives the queue, and those it must find kept on the request: a
// conductor that drops one of them starts nothing, rather than a session with less than was said.
function localStart(prepared, env, deps) {
  const { repo, goal, text, mode, place, folders, bots, botModels, model, name, mandate, budget, said } = prepared;
  const parent = repo.root === env.repo.root && env.task?.id != null ? subParent(env.task) : null;
  const fields = { permissions: mode, place, folders, bots, overseer: env.name, ...(budget !== null ? { budgetUsd: budget } : {}), ...(name ? { title: name } : {}), ...(model ? { model } : {}), ...(Object.keys(botModels).length ? { botModels } : {}), ...(mandate ? { mandate: mandate.id } : {}) };
  const needs = { overseer: env.name, permissions: mode, place, ...(folders.length ? { folders } : {}), ...(bots.length ? { bots } : {}), ...(budget !== null ? { budgetUsd: budget } : {}), ...(name ? { title: name } : {}), ...(model ? { model } : {}), ...(Object.keys(botModels).length ? { botModels } : {}) };
  let row;
  try { row = queue(repo.root, text, { ...fields, ...(parent ? { parent } : {}) }, deps, needs, `ELU on this computer does not start a session with all of that yet (${said.join(', ')}). Nothing was started: start it with less, or tell the owner.`); }
  catch (error) { if (error instanceof EluCodeError) throw new EluCodeError(`Nothing was started: ${firstLine(error.message)}`); throw error; }
  if (mandate) { try { joinMandate(mandate.id, { computer: null, project: projectKey(repo.root), session: `request-${row.id}` }, { by: 'start' }); } catch { /* Joined by its number when it is first looked for. */ } }
  return { text: `Started a session in ${projectLabel(repo)}${name ? ` named "${one(name, 60)}"` : ''} with ${said.join(', ')}: "${one(firstLine(goal), 80)}". It starts when a slot is free, and shows in Sessions ${parent ? 'under this session' : 'as started by you'}.${mandate ? ` Inside it your words are the owner's, under his mandate ${one(mandate.name, 40)}.` : ''}`,
    target: { root: repo.root, request: row.id }, undo: { kind: 'session', root: repo.root, request: row.id, goal: hash(text).slice(0, 16) } };
}
// A project there, by its name, among the folders that computer lists for a new session (remoteFolders).
async function folderThere(prepared, env) {
  const listed = await peerCommand({ type: 'remoteFolders', to: prepared.computer.key }, env);
  if (listed?.older) refuse(`@${prepared.computer.name} starts a session only in the project it chooses: its ELU needs an update to be given one.`);
  const rows = (Array.isArray(listed?.folders) ? listed.folders : []).filter(row => isObject(row) && typeof row.path === 'string'), wanted = nameKey(prepared.project);
  const found = rows.filter(row => [row.name, row.label, path.basename(row.path)].some(value => nameKey(flat(value)) === wanted));
  const projects = found.filter(row => row.project), pick = projects.length === 1 ? projects[0] : found.length === 1 ? found[0] : null;
  if (!pick) refuse(`@${prepared.computer.name} lists ${found.length ? 'more than one folder' : 'no project'} named ${one(prepared.project, 60)}${rows.length ? `. It lists: ${rows.slice(0, 12).map(row => one(row.name || row.label, 40)).join(', ')}` : ''}.`);
  return pick.path;
}
async function remoteStart(prepared, env) {
  const { computer, goal, text, mode, place, folders, bots, botModels, model, name, mandate, budget, said, where } = prepared;
  const folder = prepared.project ? await folderThere(prepared, env) : null;
  const out = await peerCommand({ type: 'remoteStart', to: computer.key, text, permissions: mode, place, model: model ?? null, bots, ...(folder ? { folder } : {}), ...(name ? { title: name } : {}), ...(Object.keys(botModels).length ? { botModels } : {}), ...(folders.length ? { folders } : {}), ...(mandate ? { mandate: mandate.id } : {}), ...(budget !== null ? { budgetUsd: budget } : {}) }, env);
  if (mandate && typeof out?.id === 'string') { try { joinMandate(mandate.id, { computer: computer.key, project: /^[0-9a-f]{16}$/.test(out.projectId ?? '') ? out.projectId : 'started', session: out.id }, { by: 'start' }); } catch { /* It is said in the reply. */ } }
  return { text: `Started a session ${where}${out?.project ? ` (${one(out.project, 40)})` : ''}${name ? ` named "${one(name, 60)}"` : ''} with ${said.join(', ')}: "${one(firstLine(goal), 80)}".${out?.unsent ? ` @${computer.name} is not connected now: it goes there when it connects.` : out?.waits ? ` It waits there for the owner's yes on @${computer.name}.` : ''}`,
    target: { computer: computer.key, ...(typeof out?.id === 'string' ? { request: out.id } : {}) } };
}

// ---------------------------------------------------------------------------------------
// The ten actions. says: what the tool is, in a few words. check(input, env, shown): the hard
// rules, and what the call is about ({ target, summary, title, … }); it throws with one
// sentence. shown: after the owner's yes, what he was asked about, which the check holds to.
// title: what the owner is asked, which reads on after "@name wants to:". whole: the exact text
// a yes writes, sends or starts a session with, which he reads whole. asks: the mark of the
// question an answer answers. owner: he is asked at every level that allows it. cap: whether it
// is counted against a cap. load(env): what it needs that is read only when asked for.
// run(prepared, env, deps, input): the action itself, { text, undo?, target? }.
const ACTIONS = Object.freeze({
  sessions_list: {
    says: 'Read the sessions',
    check: () => ({ target: null, summary: 'Read the sessions' }),
    run(prepared, env) {
      // Its own chat is not one of the sessions it oversees.
      const view = readOverview({ now: env.now, except: env.task.botChat ? { root: env.repo.root, id: String(env.task.id) } : null }), digest = stateDigest(view), there = remoteDigest(env);
      const here = digest.total ? `The sessions on this computer that are not in Done, what needs the owner first${digest.left ? `: ${digest.rows.length} of ${digest.total}` : ''}. As of ${clock(env.now, env.now)}. Name one by its project and the number after #.\n${dataBlock('Sessions', digest.lines)}` : 'No session on this computer is open: each one is in Done or archived, or there is none.';
      if (!there.lines.length) return { text: here };
      return { text: `${here}\n\nThe sessions on the other computers of the owner's projects that are not archived, as each computer listed them, what needs the owner first. Name one by its computer (after on @), its project and the number after #.\n${dataBlock('Sessions on other computers', there.lines)}` };
    },
  },
  session_read: {
    says: 'Read a session',
    check(given, env) { const target = sessionFor(given, env); return { ...target, target: target.remote ? { computer: target.computer.key, session: target.row.ref } : { root: target.repo.root, session: target.id }, summary: `Read ${target.titled}` }; },
    run(prepared, env) {
      if (prepared.remote) return remoteRead(prepared, env).then(text => ({ text }));
      const { repo, task, id, label } = prepared;
      const found = readSession(repo.root, id, { now: env.now }), status = found?.status ?? null;
      let plan = null; try { plan = currentTask(repo, id); } catch { plan = null; }
      let entries = []; try { entries = conversationEntries(repo, task); } catch { entries = []; }
      const met = new Set(Array.isArray(plan?.met) ? plan.met : []), steps = Array.isArray(plan?.subtasks) ? plan.subtasks : [], stopped = status && ['Stopped', 'Blocked'].includes(status.word);
      const value = {
        project: projectLabel(repo), session: id, title: one(taskTitle(task), 120), state: status?.word ?? 'Not on the board', doing: status?.why ?? null,
        since: time(status?.since?.at) ? clock(time(status.since.at), env.now) : null, eta: status?.eta ? `${status.eta.text} (the agent's own estimate)` : null,
        goal: body(sessionGoal(task)),
        task: plan && plan.state !== 'rejected' ? { title: one(plan.title, 120), state: plan.state, goal: one(plan.goal, 500) || null, objectives: (Array.isArray(plan.objectives) ? plan.objectives : []).slice(0, 8).map((text, at) => ({ text: one(text, 300), met: met.has(at + 1) })), steps: steps.length ? `${steps.filter(row => row?.state === 'done').length} of ${steps.length} done` : null } : null,
        asks: questionOf(task) ? body(questionOf(task)) : null,
        stopped: stopped ? [status.why, status.action].filter(Boolean).join(' ') : null,
        proof: (status?.proof ?? []).map(row => ({ step: row.text, met: row.met, ...(row.evidence ? { evidence: one(row.evidence, 200) } : {}) })), proved: status ? proofText(status) : null,
        agents: (found?.agents ?? []).map(row => ({ agent: one(row.agent, 60), model: modelLabel(row.model) || null, in: row.tokens ? `${row.atMost ? '≤' : ''}${compact(row.tokens.input)}` : null, out: row.tokens ? `${row.atMost ? '≤' : ''}${compact(row.tokens.output)}` : null,
          cache: row.tokens ? `${row.atMost ? '≤' : ''}${compact(row.tokens.cacheRead)}` : null, cost: row.within ? `in ${row.within}` : moneyText(row.costUsd, row.partial) })),
        messages: entries.filter(row => !row.shell && typeof row.text === 'string' && row.text.trim()).slice(-READ_MESSAGES).map(row => ({ from: one(row.role, 60), at: row.at ?? null, text: body(row.text) })),
        ...fullRead(prepared, env),
      };
      return { text: dataBlock(`Session ${label}`, value) };
    },
  },
  facts_find: {
    says: 'Find facts',
    check(given) {
      const topic = given.topic == null || given.topic === '' ? null : String(given.topic).trim().toLowerCase();
      if (topic && !FACT_TOPICS.includes(topic)) refuse(`A fact has one topic: ${FACT_TOPICS.slice(0, -1).join(', ')} or ${FACT_TOPICS.at(-1)}.`);
      const ids = given.ids == null ? null : [].concat(given.ids).flatMap(id => String(id ?? '').split(/[\s,\[\]]+/)).filter(Boolean).slice(0, 20), words = typeof given.words === 'string' ? given.words.slice(0, 300) : '';
      return { target: null, summary: `Find facts${ids?.length ? `: ${one(ids.join(', '), 80)}` : words.trim() ? `: ${one(words, 80)}` : topic ? ` about ${topic}` : ''}`, topic, ids: ids?.length ? ids : null, words, all: given.all === true };
    },
    run({ topic, ids, words, all }) {
      const facts = findFacts({ words, topic, ids, all, limit: 10 }), away = ids ? factsElsewhere(ids) : '';
      if (!facts.length) return { text: away || (ids ? 'No saved fact has that id.' : 'No saved fact holds that. What is not saved with a source is not known: find it out, then save it with fact_save.') };
      return { text: `${plural(facts.length, 'saved fact')}, each with its source, when it was read, and whether ELU itself found the quote in the source.\n${dataBlock('Saved facts', facts.map(factText))}${away ? `\n${away}` : ''}` };
    },
  },
  connections_list: {
    says: 'List the connections',
    check: (given, env) => ({ target: { root: env.repo.root }, summary: 'List the connections' }),
    load: async env => ({ servers: typeof env.servers === 'function' ? env.servers : (await import('./mcp.mjs')).claudeServers }),
    run(prepared, env, deps) { let servers = {}; try { servers = deps.servers(env.repo.root) ?? {}; } catch { servers = {}; } return { text: connections(env, isObject(servers) ? servers : {}) }; },
  },
  fact_save: {
    says: 'Save a fact',
    check: given => ({ target: null, summary: asking('Save a fact: ', given.claim), title: asking('Save a fact: ', given.claim) }),
    run(prepared, env, deps, given) {
      // A fact from a file names a file a session of this project could read: its folder, and where this session works.
      const fact = saveFact({ claim: given.claim, topic: given.topic, source: given.source, quote: given.quote, replaces: given.replaces }, { roots: [env.repo.root, env.task.worktree, env.cwd].filter(dir => typeof dir === 'string' && dir), now: new Date(env.now) });
      return { text: `Saved.\n${factText(fact)}`, target: { fact: fact.id }, undo: { kind: 'fact', fact: fact.id } };
    },
  },
  card_add: {
    says: 'Add a To do card',
    check(given, env) {
      const repo = projectFor(given.project, env), text = written(given.text, 'the card', CARD_CHARS), title = `Kanban: add '${one(firstLine(text), 80)}' to To do on ${projectLabel(repo)}'s board`;
      return { repo, text, target: { root: repo.root }, summary: title, title, whole: text };
    },
    cap: true,
    run({ repo, text }, env) {
      const card = addCard(repo, text, { from: `@${env.name}` });
      return { text: `Added '${one(firstLine(card.text), 80)}' to To do on ${projectLabel(repo)}'s board. The owner starts it when he chooses.`, target: { root: repo.root, card: card.id }, undo: { kind: 'card', root: repo.root, card: card.id } };
    },
  },
  org_propose: {
    says: 'Propose an Organization line',
    check(given, env, shown = null) {
      const repo = projectFor(given.project, env), removing = given.remove != null && given.remove !== '';
      if (removing && given.line != null && given.line !== '') refuse('Propose one thing: a line to add (line and facts), or a line to remove (remove).');
      if (removing) {
        // After his yes, the very line he was asked about, by its whole text and wherever it stands now: never the line
        // that has its number by then, nor another with the same words.
        const found = shown ? orgLines(repo.root).find(row => row.line === shown.remove) ?? stop(CHANGED, shown) : findOrgLine(repo.root, given.remove), title = asking(`Remove from the Organization section of ${projectLabel(repo)}: `, found.line);
        return { repo, remove: found.line, at: found.n, target: { root: repo.root, line: found.line }, summary: title, title, whole: found.line };
      }
      const { line, same } = checkOrgLine(repo.root, given.line, given.facts);
      if (same) refuse(`The Organization section of ${projectLabel(repo)} holds that line already.`);
      const title = asking(`Add to the Organization section of ${projectLabel(repo)}: `, line);
      return { repo, line, facts: given.facts, target: { root: repo.root, line }, summary: title, title, whole: line };
    },
    run({ repo, line, remove, at }, env, deps, given) {
      if (remove) { const gone = removeOrgLine(repo.root, at); return { text: `The owner said yes. Removed from the Organization section of ${projectLabel(repo)}: "${gone.line}"` }; }
      const made = addOrgLine(repo.root, given.line, given.facts);
      return { text: `The owner said yes. ${made.added ? 'Added to' : 'It was already in'} the Organization section of ${projectLabel(repo)}, which every agent of the project reads: "${made.line}"`, ...(made.added ? { undo: { kind: 'org', root: repo.root, line: made.line } } : {}) };
    },
  },
  session_message: {
    says: 'Send a note to a session',
    check(given, env) {
      const target = sessionFor(given, env);
      // At Full, inside one of the owner's mandates, it goes as his word (ownerWord): nothing asks him for it.
      const word = ownerWord(target, env), lead = word ? `Send to ${target.titled} as your word (mandate ${one(word.mandate.name, 40)}): ` : `Send a note to ${target.titled}: `;
      if (target.remote) {
        remoteWritable(target, { owner: Boolean(word) });
        const text = written(given.text, 'the note', NOTE_CHARS), title = asking(lead, text);
        // What goes to another computer leaves this one: outside a mandate the owner is asked at every level that allows it.
        return { ...target, text, word, mark: remoteMark(target), target: there(target), summary: title, title, whole: text, owner: !word, ...spoke(word) };
      }
      const plan = writable(target, env, { owner: Boolean(word) }), text = written(given.text, 'the note', NOTE_CHARS), title = asking(lead, text);
      return { ...target, text, word, mark: progressMark(target.task, plan), target: herePlace(target), summary: title, title, whole: text, owner: word ? false : fullAccess(target.task), ...spoke(word) };
    },
    cap: true, load: queueing,
    run(prepared, env, deps) {
      const { word } = prepared;
      if (prepared.remote) return remoteNote(prepared, prepared.text, env, null, word).then(out => ({ text: remoteSent(prepared, out, env, 'Sent to', word), target: there(prepared), ...(word && out?.asOwner !== true ? { asOwner: false } : {}) }));
      const { repo, task, id, titled, text } = prepared;
      // A note about the work goes to who works there: the bot the session works with, else its model.
      let worker = null; try { worker = sessionWorker(task, { waiting: pendingRequests(repo.root) }); } catch { worker = null; }
      if (word) {
        // The owner's word carries its own mark (asOwner), never the bot's: kept, or nothing is sent.
        const row = queue(repo.root, text, { continuationTaskId: id, asOwner: word.mark, ...(worker ? { bot: worker } : {}) }, deps, { asOwner: word.mark }, NO_OWNER_MARK);
        return { text: `Sent to ${titled} as the owner's word, under his mandate ${one(word.mandate.name, 60)}. It shows there as his, via @${env.name}, and waits its turn.`, target: { root: repo.root, session: id, request: row.id }, undo: { kind: 'message', root: repo.root, request: row.id } };
      }
      const row = queue(repo.root, text, { continuationTaskId: id, overseer: env.name, ...(worker ? { bot: worker } : {}) }, deps, { overseer: env.name });
      return { text: `Sent to ${titled}. It waits its turn there and shows under your name, as a note and not as the owner's word.`, target: { root: repo.root, session: id, request: row.id }, undo: { kind: 'message', root: repo.root, request: row.id } };
    },
  },
  session_answer: {
    says: 'Answer a session',
    check(given, env) {
      const target = sessionFor(given, env), word = ownerWord(target, env);
      if (target.remote) {
        remoteWritable(target, { owner: Boolean(word) });
        const question = typeof target.row.question === 'string' ? target.row.question : '';
        if (!question) refuse(`${target.label} asks no question now. A Task to approve and a permission request are the owner's alone to answer${atFull(env) ? ', or session_approve\'s inside one of his mandates' : ''}.`);
        const text = written(given.text, 'the answer', NOTE_CHARS), title = asking(`Answer ${target.titled}${word ? ` as your word (mandate ${one(word.mandate.name, 40)})` : ''}, which asks "${one(question, 50)}": `, text);
        return { ...target, text, question, word, mark: remoteMark(target), target: there(target), summary: title, title, whole: text, asks: hash(question).slice(0, 16), owner: !word, ...spoke(word) };
      }
      const plan = writable(target, env, { owner: Boolean(word) }), question = questionOf(target.task);
      if (!question) refuse(`${target.label} asks no question now. A Task to approve and a permission request are the owner's alone to answer${atFull(env) ? ', or session_approve\'s inside one of his mandates' : ''}.`);
      const text = written(given.text, 'the answer', NOTE_CHARS), title = asking(`Answer ${target.titled}${word ? ` as your word (mandate ${one(word.mandate.name, 40)})` : ''}, which asks "${one(firstLine(question), 50)}": `, text);
      return { ...target, text, word, mark: progressMark(target.task, plan), target: herePlace(target), summary: title, title, whole: text, asks: questionMark(target.task), owner: word ? false : fullAccess(target.task), ...spoke(word) };
    },
    cap: true, load: queueing,
    run(prepared, env, deps) {
      const { word } = prepared;
      if (prepared.remote) return remoteNote(prepared, prepared.text, env, prepared.question, word).then(out => ({ text: remoteSent(prepared, out, env, 'Answered', word), target: there(prepared), ...(word && out?.asOwner !== true ? { asOwner: false } : {}) }));
      const { repo, task, id, titled, text, asks } = prepared;
      let worker = null; try { worker = sessionWorker(task, { waiting: pendingRequests(repo.root) }); } catch { worker = null; }
      if (word) {
        const row = queue(repo.root, text, { continuationTaskId: id, asOwner: word.mark, asks, ...(worker ? { bot: worker } : {}) }, deps, { asOwner: word.mark, asks }, NO_OWNER_MARK);
        return { text: `Answered ${titled} as the owner's word, under his mandate ${one(word.mandate.name, 60)}. It shows there as his, via @${env.name}, and the session goes on with it when its turn comes.`, target: { root: repo.root, session: id, request: row.id }, undo: { kind: 'message', root: repo.root, request: row.id } };
      }
      // It names the question it answers: if the session asks another by its turn, it is not given.
      const row = queue(repo.root, text, { continuationTaskId: id, overseer: env.name, asks, ...(worker ? { bot: worker } : {}) }, deps, { overseer: env.name, asks });
      return { text: `Answered ${titled}. The answer shows under your name, and the session goes on with it when its turn comes.`, target: { root: repo.root, session: id, request: row.id }, undo: { kind: 'message', root: repo.root, request: row.id } };
    },
  },
  session_start: {
    says: 'Start a session',
    check(given, env) {
      if (atFull(env)) return fullStart(given, env);
      const repo = projectFor(given.project, env), goal = written(given.goal, 'the goal of the session', GOAL_CHARS), caps = env.settings.caps;
      if (homeOrAbove(repo.root)) refuse(`${projectLabel(repo)} is the owner's home folder. A session there reaches every file of his, so only he starts one.`);
      // At most Approve for me, at most what the owner's cap says, and at most what this session and this turn have.
      const own = MODES.includes(env.task.permissions) ? env.task.permissions : 'ask', turn = PROFILES.includes(env.mode) ? env.mode : own;
      const mode = capMode(capMode(capMode(caps.startMode, 'auto'), own), turn);
      if (!MODES.includes(mode)) refuse('This session is Read only, and a session it starts would get no more. Nothing was started.');
      const title = asking(`Start a session in ${projectLabel(repo)} with ${LABELS[mode]} and a ${dollars(caps.startBudgetUsd)} budget: `, goal);
      return { repo, goal, mode, budget: caps.startBudgetUsd, target: { root: repo.root }, summary: title, title, whole: goal };
    },
    cap: true, load: queueing,
    run(prepared, env, deps) {
      if (prepared.full) return prepared.remote ? remoteStart(prepared, env) : localStart(prepared, env, deps);
      const { repo, goal, mode, budget } = prepared;
      // A new worktree, no extra folders, no bots; not typed, so it waits for a free slot as a schedule's run does.
      // In this session's own project it is a sub session of this one (lib/session-commands.mjs subParent), listed under it.
      const parent = repo.root === env.repo.root && env.task?.id != null ? subParent(env.task) : null;
      const row = queue(repo.root, goal, { permissions: mode, place: { kind: 'worktree' }, folders: [], bots: [], overseer: env.name, budgetUsd: budget, ...(parent ? { parent } : {}) }, deps, { overseer: env.name, budgetUsd: budget, permissions: mode });
      return { text: `Started a session in ${projectLabel(repo)} with ${LABELS[mode]} and a ${dollars(budget)} budget: "${one(firstLine(goal), 80)}". It works in a new worktree with no bots, starts when a slot is free, and shows in Sessions ${parent ? 'under this session' : 'as started by you'}.`,
        target: { root: repo.root, request: row.id }, undo: { kind: 'session', root: repo.root, request: row.id, goal: hash(goal).slice(0, 16) } };
    },
  },
  // ---- Full's own tools (FULL_TOOLS). Each is refused below Full by the level's table.
  session_approve: {
    says: 'Approve for the owner',
    check(given, env) {
      const target = sessionFor(given, env), word = ownerWord(target, env);
      if (!word) refuse(`${target.label} is in none of the owner's mandates${target.remote && !mineThere(env, target.computer.key) ? `, and @${target.computer.name} is not marked as one of his own computers here` : ''}. Outside a mandate only he approves: say in your reply what waits for him.`);
      const approval = given.approval == null || given.approval === '' ? null : String(given.approval).trim(), mandate = one(word.mandate.name, 40);
      if (approval) {
        const decision = given.decision == null || given.decision === '' ? 'allow' : String(given.decision).trim().toLowerCase();
        if (!['allow', 'deny'].includes(decision)) refuse('Answer a permission request with allow or deny.');
        let item = null;
        if (target.remote) { remoteControl(target, env); item = (Array.isArray(target.row.approvals) ? target.row.approvals : []).find(row => isObject(row) && row.id === approval) ?? null; }
        else { controllable(target, env); let rows = []; try { rows = pendingApprovals({ root: target.repo.root, taskId: target.id }); } catch { rows = []; } item = rows.find(row => row.id === approval) ?? null; }
        if (!item) refuse(`No permission request ${one(approval, 80)} waits in ${target.label} now. session_read lists the ones that wait, with their ids.`);
        ownersAlone(item, target.label);
        const title = `${decision === 'allow' ? 'Allow' : 'Deny'} for you in ${target.titled} (mandate ${mandate}): ${one(item.summary, 100)}`;
        return { ...target, word, approval: item.id, decision, target: { ...whereOf(target), approval: item.id }, summary: title, title, ...spoke(word) };
      }
      const decision = given.decision == null || given.decision === '' ? 'approve' : String(given.decision).trim().toLowerCase();
      if (!['approve', 'reject'].includes(decision)) refuse('Approve or reject the Task.');
      let plan = null;
      if (target.remote) { remoteControl(target, env); plan = target.row.plan?.state === 'proposed' ? target.row.plan : null; }
      else {
        controllable(target, env);
        if (LIVE.includes(target.task.state)) refuse(`${target.label} is at work. Answer its Task when it stops.`);
        try { plan = currentTask(target.repo, target.id); } catch { plan = null; }
        if (plan?.state !== 'proposed') plan = null;
      }
      if (!plan) refuse(`No Task waits for approval in ${target.label}.`);
      const title = `${decision === 'approve' ? 'Approve' : 'Reject'} for you the Task of ${target.titled} (mandate ${mandate}): "${one(plan.title, 80)}"`;
      return { ...target, word, decision, plan: { title: one(plan.title, 200) }, target: whereOf(target), summary: title, title, ...spoke(word) };
    },
    cap: true, load: queueing,
    async run(prepared, env, deps) {
      const { word, decision, titled } = prepared, mandate = one(word.mandate.name, 60);
      if (prepared.remote) {
        const out = prepared.approval ? await peerCommand({ type: 'remoteAnswer', to: prepared.computer.key, ref: prepared.row.ref, approval: prepared.approval, decision }, env) : await peerCommand({ type: 'remoteTask', to: prepared.computer.key, ref: prepared.row.ref, decision }, env);
        if (out?.answered !== true) return { text: `${titled} had nothing of that left to answer: it was answered already, or it is gone. Nothing was done.`, target: there(prepared), asOwner: false };
        return { text: `${prepared.approval ? `${decision === 'allow' ? 'Allowed' : 'Denied'} the request` : `${decision === 'approve' ? 'Approved' : 'Rejected'} the Task`} of ${titled} for the owner, under his mandate ${mandate}.`, target: there(prepared) };
      }
      const { repo, id } = prepared;
      if (prepared.approval) {
        if (!answerApproval(prepared.approval, decision)) return { text: `That request of ${titled} was answered already, or it is gone. Nothing was done.`, target: herePlace(prepared), asOwner: false };
        return { text: `${decision === 'allow' ? 'Allowed' : 'Denied'} the request of ${titled} for the owner, under his mandate ${mandate}.`, target: { ...herePlace(prepared), approval: prepared.approval } };
      }
      if (decision === 'reject') { rejectTask(repo, id); return { text: `Rejected the Task of ${titled} for the owner, under his mandate ${mandate}. Nothing of it starts.`, target: herePlace(prepared) }; }
      const plan = approveTask(repo, id);
      // Its work starts as when the owner approves it here: one message that says so. Marked as his, via the bot, where the conductor keeps that mark.
      try { deps.enqueue(repo.root, `Approved the Task: ${plan.title}`, { continuationTaskId: id, priority: 0, approved: true, asOwner: word.mark }); deps.start(); } catch { /* Approved all the same: its work starts with the next message. */ }
      return { text: `Approved the Task of ${titled} for the owner, under his mandate ${mandate}: "${one(plan.title, 80)}". Its work starts now.`, target: herePlace(prepared) };
    },
  },
  session_stop: {
    says: 'Stop a session',
    check(given, env) {
      const target = sessionFor(given, env);
      if (target.remote) { remoteControl(target, env); const title = `Stop ${target.titled}`; return { ...target, target: there(target), summary: title, title }; }
      controllable(target, env);
      const live = LIVE.includes(target.task.state), jobs = jobsWire(target.task.jobs).length;
      if (!live && !jobs) refuse(`${target.label} is not at work: there is nothing to stop.`);
      const title = `Stop ${target.titled}${live ? '' : `: its ${plural(jobs, 'long job')}`}`;
      return { ...target, live, target: herePlace(target), summary: title, title };
    },
    load: async env => ({ sendCommand: typeof env.sendCommand === 'function' ? env.sendCommand : (await import('./conductor.mjs')).sendCommand, stopLongWork: typeof env.stopLongWork === 'function' ? env.stopLongWork : (await import('./long-work.mjs')).stopLongWork }),
    async run(prepared, env, deps) {
      if (prepared.remote) {
        const out = await peerCommand({ type: 'remoteStop', to: prepared.computer.key, ref: prepared.row.ref }, env);
        return { text: out?.cancelled ? `${prepared.titled} had not started there: it is taken back.` : `Stopped ${prepared.titled}${Array.isArray(out?.jobs) && out.jobs.length ? `, and its long jobs ${out.jobs.map(name => one(name, 40)).join(', ')}` : ''}. It goes on when a message reaches it.`, target: there(prepared) };
      }
      const { repo, id, titled } = prepared;
      // As the owner's own stop (lib/conductor.mjs sendCommand): the turn ends, and so do its long jobs.
      if (prepared.live) { deps.sendCommand({ type: 'stop', root: repo.root, taskId: id }); return { text: `Stopped ${titled}, as the owner's own stop does: its turn ends, and its long jobs with it. It goes on when a message reaches it.`, target: herePlace(prepared) }; }
      const ended = deps.stopLongWork(repo.root, id);
      return { text: `Stopped the long jobs of ${titled}${Array.isArray(ended) && ended.length ? `: ${ended.map(job => one(job?.name ?? job, 40)).join(', ')}` : ''}.`, target: herePlace(prepared) };
    },
  },
  session_rename: {
    says: 'Rename a session',
    check(given, env) {
      const target = sessionFor(given, env), name = nameOf(given.title), title = `Rename ${target.titled} to "${one(name, 80)}"`;
      if (target.remote) {
        remoteControl(target, env);
        // Who chose a name there is not told here: one somebody chose is renamed only inside a mandate.
        if (target.row.named && !ownerWord(target, env)) refuse(`${target.label} has a name somebody chose there. Only the owner renames it, unless it is in one of his mandates.`);
        return { ...target, name, target: there(target), summary: title, title };
      }
      controllable(target, env);
      // The owner's own name for a session stays his: the bot renames it only inside one of his mandates.
      if (target.task.titleBy === 'owner' && !botNamed(target) && !ownerWord(target, env)) refuse(`The owner named ${target.label} himself. Only he renames it, unless it is in one of his mandates.`);
      return { ...target, name, before: target.task.titleBy === 'owner' && typeof target.task.title === 'string' ? target.task.title : null, target: herePlace(target), summary: title, title };
    },
    async run(prepared, env) {
      if (prepared.remote) { const out = await peerCommand({ type: 'remoteRename', to: prepared.computer.key, ref: prepared.row.ref, title: prepared.name }, env); return { text: `Renamed ${prepared.label} to "${one(out?.shown ?? prepared.name, 80)}".`, target: there(prepared) }; }
      const { repo, id, label, name, before } = prepared, saved = setTitle(repo, id, name);
      return { text: `Renamed ${label} to "${one(taskTitle(saved), 80)}".`, target: herePlace(prepared), undo: { kind: 'rename', root: repo.root, session: id, title: before, name: saved?.title ?? name } };
    },
  },
  session_archive: {
    says: 'Archive a session',
    check(given, env) {
      const target = sessionFor(given, env, { archived: true }), archived = given.archived !== false;
      const title = `${archived ? 'Archive' : 'Bring back'} ${target.titled}`;
      if (target.remote) {
        remoteControl(target, env);
        if (archived === (target.row.archived === true)) refuse(`${target.label} is ${archived ? 'archived already' : 'not archived'}.`);
        return { ...target, archived, target: there(target), summary: title, title };
      }
      controllable(target, env);
      let board = null; try { board = readBoard(target.repo); } catch { board = null; }
      if (!board) refuse(`The board of ${projectLabel(target.repo)} could not be read, so ELU cannot tell whether ${target.label} is archived. Nothing was done.`);
      const now = sessionArchived(board, target.task);
      if (archived) {
        if (now || archiveAsked(target.repo, target.id)) refuse(`${target.label} is archived already, or is archived when its turn ends.`);
        if (LIVE.includes(target.task.state)) refuse(`${target.label} is at work. Stop it first, then archive it.`);
      } else {
        if (archiveAsked(target.repo, target.id)) refuse(`${target.label} is archived when its turn ends, as its turn asked. Bring it back after that.`);
        if (!now) refuse(sessionClosed(board, target.task) ? `${target.label} is in Done, not archived. Only the owner opens it again.` : `${target.label} is not archived.`);
      }
      return { ...target, archived, target: herePlace(target), summary: title, title };
    },
    async run(prepared, env) {
      if (prepared.remote) { await peerCommand({ type: 'remoteArchive', to: prepared.computer.key, ref: prepared.row.ref, archived: prepared.archived }, env); return { text: prepared.archived ? `Archived ${prepared.titled}. Nothing was deleted.` : `Brought back ${prepared.titled}.`, target: there(prepared) }; }
      const { repo, id, titled, archived } = prepared;
      if (!archived) { reopenSession(repo, id); return { text: `Brought back ${titled}. It is in Sessions again.`, target: herePlace(prepared), undo: { kind: 'archive', root: repo.root, session: id, archived: false } }; }
      archiveSession(repo, id, env.now);
      return { text: `Archived ${titled}. Nothing was deleted: /archived lists it, and session_archive with archived false brings it back.`, target: herePlace(prepared), undo: { kind: 'archive', root: repo.root, session: id, archived: true } };
    },
  },
  session_settings: {
    says: 'Change a session',
    check(given, env) {
      const target = sessionFor(given, env), here = !target.remote, parts = {};
      if (given.access != null && given.access !== '') { const access = String(given.access).trim().toLowerCase(); if (!MODES.includes(access)) refuse('Set access to ask, auto or full.'); parts.access = access; }
      if (given.model != null) parts.model = modelOf(given.model, 'the model of the session', { here });
      if (given.bots != null) {
        if (!isObject(given.bots)) refuse('Give bots as { add: [names], remove: [names] }.');
        const add = botNames(given.bots.add, { here }), remove = botNames(given.bots.remove, { here: false });
        if (add.some(name => remove.includes(name))) refuse('Add a bot or remove it, not both.');
        if (add.length || remove.length) parts.bots = { add, remove };
      }
      if (given.botModels != null && (!isObject(given.botModels) || Object.keys(given.botModels).length)) parts.botModels = botModelsOf(given.botModels, null, { here: false });
      if (!Object.keys(parts).length) refuse('Name what to change: access, model, bots or botModels.');
      const said = [parts.access ? `access ${LABELS[parts.access]}` : null, parts.model ? `model ${modelWords(parts.model)}` : null, ...(parts.bots?.add ?? []).map(name => `add @${name}`), ...(parts.bots?.remove ?? []).map(name => `remove @${name}`), ...Object.entries(parts.botModels ?? {}).map(([name, choice]) => `@${name} on ${modelWords(choice)}`)].filter(Boolean);
      const title = `Change ${target.titled}: ${said.join(', ')}`;
      if (!here) { remoteControl(target, env); return { ...target, parts, said, target: there(target), summary: title, title }; }
      controllable(target, env);
      // The bots it will have, and the model of each that is given one: checked before anything changes.
      const has = sessionBots(target.task), next = [...new Set([...has.filter(name => !(parts.bots?.remove ?? []).includes(name)), ...(parts.bots?.add ?? [])])];
      for (const name of parts.bots?.remove ?? []) if (!has.includes(name)) refuse(`@${name} is not in ${target.label}.`);
      if (parts.bots) chatBots(next);
      if (parts.botModels) parts.botModels = botModelsOf(given.botModels, next, { here: true });
      return { ...target, parts, said, bots: next, target: herePlace(target), summary: title, title };
    },
    load: async env => ({ runner: env.runner ?? await import('./runner.mjs'), agents: env.agents ?? await import('./agent-change.mjs') }),
    async run(prepared, env, deps) {
      const { parts, said, titled } = prepared;
      if (prepared.remote) {
        const out = await peerCommand({ type: 'remoteSettings', to: prepared.computer.key, ref: prepared.row.ref, ...parts }, env);
        return { text: `Changed ${titled}: ${said.join(', ')}. Each applies from its next turn there.${typeof out?.said === 'string' && out.said ? ` @${prepared.computer.name} says: ${one(out.said, 300)}` : ''}`, target: there(prepared) };
      }
      const { repo, id } = prepared, line = what => () => `@${env.name} set ${what}.`, later = [];
      if (parts.access) deps.runner.setPermissions(repo, id, parts.access);
      if (parts.bots) deps.runner.setBots(repo, id, prepared.bots);
      if (parts.model) later.push(deps.agents.changeAgent(repo, id, { bot: null, to: parts.model, line: line(`the model to ${modelWords(parts.model)}`) })?.later === true);
      for (const [bot, to] of Object.entries(parts.botModels ?? {})) later.push(deps.agents.changeAgent(repo, id, { bot, to, line: line(`@${bot} to ${modelWords(to)}`) })?.later === true);
      return { text: `Changed ${titled}: ${said.join(', ')}. ${later.some(Boolean) ? 'A turn works there now, so each applies from its next turn.' : 'Each applies from its next turn.'} There is no undo: set it back the same way.`, target: herePlace(prepared) };
    },
  },
  session_log: {
    says: 'Read a session\'s log',
    check(given, env) {
      const target = sessionFor(given, env), rows = rowsWanted(given.rows), role = roleWanted(given.role);
      if (target.remote) remoteControl(target, env);
      return { ...target, rows, role, target: whereOf(target), summary: `Read the log of ${target.titled}${role === 'lead' ? '' : ` (@${role.slice(4)})`}` };
    },
    async run(prepared, env) {
      const { rows, role, label } = prepared;
      if (prepared.remote) {
        const out = await peerCommand({ type: 'remoteLog', to: prepared.computer.key, ref: prepared.row.ref, rows, role }, env), steps = Array.isArray(out?.rows) ? out.rows : Array.isArray(out?.steps) ? out.steps : [];
        return { text: steps.length ? dataBlock(`Log of ${label}`, { role, rows: steps.slice(-rows).map(logRow).filter(Boolean) }) : `${label} has no log of ${role === 'lead' ? 'its model' : `@${role.slice(4)}`} there yet.` };
      }
      const found = logOf(prepared.repo, prepared.task, role);
      if (!found) return { text: `${label} has no log of ${role === 'lead' ? 'its model' : `@${role.slice(4)}`} yet.` };
      let steps = []; try { steps = runSteps(found.file, { cwd: prepared.task.worktree ?? null }); } catch { steps = []; }
      return { text: dataBlock(`Log of ${label}`, { role, run: found.live ? 'the turn at work now' : `the last turn${found.at ? `, ${clock(time(found.at), env.now)}` : ''}`, ...(found.model ? { model: found.model } : {}), rows: steps.slice(-rows).map(logRow).filter(Boolean) }) };
    },
  },
  session_agents: {
    says: 'Read a session\'s agents',
    check(given, env) {
      const target = sessionFor(given, env), agent = given.agent == null || given.agent === '' ? null : String(given.agent).trim().slice(0, 160), rows = rowsWanted(given.rows);
      if (target.remote) remoteControl(target, env);
      return { ...target, agent, rows, target: whereOf(target), summary: agent ? `Read the thread of ${one(agent, 60)} in ${target.titled}` : `Read the agents of ${target.titled}` };
    },
    async run(prepared, env) {
      const { agent, rows, label } = prepared;
      if (prepared.remote) {
        const out = await peerCommand({ type: 'remoteAgents', to: prepared.computer.key, ref: prepared.row.ref, ...(agent ? { agent, rows } : {}) }, env);
        if (agent) { const entries = Array.isArray(out?.entries) ? out.entries : Array.isArray(out?.thread) ? out.thread : []; return { text: dataBlock(`Thread of ${one(agent, 60)} in ${label}`, entries.slice(-rows).map(entryRow).filter(Boolean)) }; }
        const agents = Array.isArray(out?.agents) ? out.agents : Array.isArray(out?.rows) ? out.rows : [];
        return { text: agents.length ? dataBlock(`Agents of ${label}`, agents.map(agentRow).filter(Boolean)) : `${label} lists no agents there.` };
      }
      if (agent) { let entries = []; try { entries = agentThread(prepared.repo, prepared.task, agent, { rows }); } catch { entries = []; } return { text: entries.length ? dataBlock(`Thread of ${one(agent, 60)} in ${label}`, entries.slice(-rows).map(entryRow).filter(Boolean)) : `${label} has no agent ${one(agent, 60)}, or it wrote nothing yet. session_agents with no agent lists them.` }; }
      let agents = []; try { agents = sessionAgents(prepared.repo, prepared.task); } catch { agents = []; }
      return { text: agents.length ? dataBlock(`Agents of ${label}`, agents.map(agentRow).filter(Boolean)) : `${label} lists no agents yet.` };
    },
  },
  mandate_propose: {
    says: 'Propose a mandate',
    check(given, env) {
      const changing = given.id == null || given.id === '' ? null : mandateNamed(String(given.id));
      const name = written(given.name ?? changing?.name, 'the name of the mandate', NAME_MAX), goal = written(given.goal ?? changing?.goal, 'the goal of the mandate', GOAL_MAX);
      if (!Array.isArray(given.decisions ?? changing?.decisions ?? [])) refuse('Give the decisions as a list of sentences.');
      const decisions = (given.decisions ?? changing?.decisions ?? []).map((text, at) => written(text, `decision ${at + 1}`, DECISION_MAX));
      if (decisions.length > DECISIONS_MAX) refuse(`A mandate holds at most ${DECISIONS_MAX} decisions.`);
      if (given.sessions != null && !Array.isArray(given.sessions)) refuse('Give the sessions as a list of { computer, project, session }.');
      // Each session as a mandate names it: this computer's by its project's id, one there by that computer's key.
      const sessions = (given.sessions ?? []).slice(0, 40).map(row => { const found = sessionFor(isObject(row) ? row : {}, env); return { ref: found.remote ? remoteRef(found) : localRef(found.repo, found.id), label: found.label }; });
      const whole = [`Mandate: ${name}`, `Goal: ${goal}`, 'Decisions:', ...(decisions.length ? decisions.map(text => `- ${text}`) : ['- none']), ...(sessions.length ? ['Sessions:', ...sessions.map(row => `- ${row.label}`)] : [])].join('\n');
      const title = asking(`${changing ? `Change the mandate ${one(changing.name, 40)}` : 'Make a mandate'}, in which the bot speaks for you: `, `${name}: ${goal}`);
      return { changing, name, goal, decisions, sessions, target: { mandate: changing?.id ?? null }, summary: title, title, whole, owner: true };
    },
    run({ changing, name, goal, decisions, sessions }) {
      const kept = changing?.sessions ?? [], added = sessions.map(row => row.ref).filter(ref => !kept.some(row => canon(row) === canon(ref)));
      // His yes makes it his: saved as the owner's (lib/orchestrator-mandates.mjs).
      const made = saveMandate({ ...(changing ? { id: changing.id } : {}), name, goal, decisions, sessions: [...kept, ...added] }, { by: 'owner' });
      return { text: `The owner said yes. The mandate ${made.name} (${made.id}) is in force${made.sessions.length ? ` for ${plural(made.sessions.length, 'session')}` : ''}: inside it your messages, answers and approvals are his word. Start a session under it with session_start and mandate ${made.id}.`, target: { mandate: made.id } };
    },
  },
});
export const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS));

// ---------------------------------------------------------------------------------------
// A stop on the way: refused by the level or over a cap, with what the call was about.
class Stop extends Error { constructor(decision, message, prepared = null) { super(message); this.decision = decision; this.prepared = prepared; } }
const stop = (message, prepared) => { throw new Stop('refused', message, prepared); };
// What the owner is shown of a call: on his yes, the same must be done, or nothing.
const shownAs = prepared => JSON.stringify([prepared?.target ?? null, prepared?.title ?? null, prepared?.whole ?? null, prepared?.asks ?? null]);
const settingsNow = () => { try { return readSettings(); } catch { return { version: 1, level: 'watch', caps: { ...DEFAULT_CAPS }, saved: true, problem: 'The orchestrator settings could not be read.' }; } };

async function askOwner(name, given, prepared, env) {
  const seconds = Number.isFinite(env.waitSeconds) && env.waitSeconds > 0 ? env.waitSeconds : APPROVAL_WAIT_SECONDS;
  const whole = typeof prepared.whole === 'string' ? prepared.whole : null;
  // A stand-in for the owner, for a test: it answers allow or deny, and anything else is no answer.
  if (typeof env.askOwner === 'function') { let answer = null; try { answer = await env.askOwner({ tool: name, input: given, title: prepared.title, whole, waitSeconds: seconds }); } catch { answer = null; } return ['allow', 'deny'].includes(answer) ? answer : 'timeout'; }
  // The question waits where every approval waits (lib/approvals.mjs), in the session the bot
  // is in. It is asked as @name, not under the role its turn runs with: the app answers what a
  // session's own roles ask once the session is set to Full access, and a level's question is
  // the owner's alone. It names an MCP tool, which the app never answers for him either, and it
  // is marked as the bot's (oversee). He reads whole what a yes writes, sends or starts.
  const id = `orch-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  let asked; try { asked = requestApproval({ id, root: env.repo.root, taskId: env.task.id, role: `@${env.name}`, vendor: typeof env.vendor === 'string' ? env.vendor : 'claude', tool: `${TOOL_PREFIX}${name}`, input: given, title: prepared.title, waitSeconds: seconds, oversee: true, whole }); } catch { return 'timeout'; }
  try { env.onAsk?.(asked.summary); } catch { /* The question waits all the same. */ }
  try { return await awaitDecision(id, { waitSeconds: seconds, signal: env.signal }); }
  catch { return 'timeout'; }
  finally { try { env.onAnswer?.(); } catch { /* Nothing to end. */ } }
}

// One call of one of the bot's tools. ctx: { repo, task, bot } of the session its turn runs in
// (orchSession in lib/orchestrator-tools.mjs), and what the relay knows of the turn: mode,
// vendor, run (its id), cwd, waitSeconds, signal, onAsk(summary) and onAnswer() around the
// wait for the owner. For a test: now, projects(), askOwner(question), enqueue, startConductor,
// servers(root), reached(root). Returns { id, decision, by, text, target, undo }: id is the
// log line's, decision as the log has it, and text what the model reads. Never throws for a
// refusal: that is a result, and it is logged.
export async function act(name, input, ctx = {}) {
  if (!isObject(ctx) || !botOversees(ctx.bot) || typeof ctx.bot.name !== 'string' || !isObject(ctx.repo) || typeof ctx.repo.root !== 'string' || !isObject(ctx.task)) return { id: null, decision: 'refused', by: 'level', text: 'These tools are for the bot that oversees the sessions, in a session of this computer.', target: null, undo: null };
  const now = ctx.now instanceof Date ? ctx.now.getTime() : Number.isFinite(ctx.now) ? ctx.now : Date.now(), given = isObject(input) ? input : {};
  const tool = typeof name === 'string' ? name : '', action = Object.hasOwn(ACTIONS, tool) ? ACTIONS[tool] : null;
  const env = { ...ctx, name: ctx.bot.name, now, projects: typeof ctx.projects === 'function' ? ctx.projects : registeredProjects, settings: settingsNow() };
  const from = { root: ctx.repo.root, session: String(ctx.task.id), run: typeof ctx.run === 'string' ? ctx.run.slice(0, 160) : null };
  const end = (decision, by, text, { target = null, summary = '', undo = null, mark = null, mandate = null } = {}) => {
    let row = null, note = '';
    // asOwner and the mandate: what it did as the owner's word (at Full, inside a mandate), and only what it did.
    try { row = logAction({ at: iso(now), bot: env.name, from, action: one(tool, 60), target, summary: one(summary || `Use ${tool}`, SUMMARY_LIMIT), level: env.settings.level, decision, by, undo, undoneAt: null, ...(mark ? { mark } : {}), ...(decision === 'allow' && mandate ? { asOwner: true, mandate } : {}) }); }
    catch (error) { note = ` The action log could not be written: ${firstLine(error.message)}`; }
    return { id: row?.id ?? null, decision, by, text: `${text}${note}`, target, undo };
  };
  if (!action) return end('refused', 'level', `There is no tool named ${one(tool, 40) || 'that'}.`, { summary: `Unknown tool ${one(tool, 40)}` });
  const about = prepared => prepared ? { target: prepared.target ?? null, summary: prepared.summary ?? '', mark: prepared.mark ?? null } : {};
  // A call its hard rules refused has no words of its own yet: the log says what it was and why not.
  const stopped = error => { if (error instanceof Stop) return end(error.decision, 'level', error.message, about(error.prepared)); const text = error instanceof EluCodeError ? error.message : `ELU could not do that: ${firstLine(error?.message)}`; return end('refused', 'level', text, { summary: `${action.says}, refused: ${text}` }); };
  // One look: the hard rules, then the level and the caps as they are on disk now, and whether
  // the log takes a line. shown: after the owner's yes, what he was asked about.
  const pass = (shown = null) => {
    env.settings = settingsNow();
    // A tool of Full below Full is refused by the level before anything is looked at.
    if (FULL_TOOLS.includes(tool) && decide(env.settings.level, tool) === 'refuse') throw new Stop('refused', atLevel(tool, env.settings.level), { target: null, summary: `${action.says}, refused at ${LEVEL_NAMES[env.settings.level] ?? 'Watch'}` });
    const prepared = action.check(given, env, shown);
    let verdict = decide(env.settings.level, tool);
    if (verdict === 'refuse') throw new Stop('refused', atLevel(tool, env.settings.level), prepared);
    if (verdict === 'allow' && prepared.owner === true) verdict = 'ask';
    const over = action.cap ? overCap(tool, prepared, env, readLog().rows) : null;
    if (over) throw new Stop('capped', over, prepared);
    if (!READS.includes(tool)) { try { logWritable(); } catch { throw new Stop('refused', UNLOGGED, prepared); } }
    return { prepared, verdict };
  };
  let deps = null; try { deps = action.load ? await action.load(env) : null; } catch (error) { return stopped(error); }
  // The last look, the action and its log line, with nothing awaited in between: two calls
  // of one turn never both pass a cap that has room for one. After the owner's yes, what is
  // done is what he was shown, or nothing.
  // A session on another computer is reached over the network: that one call is awaited, with
  // the log's lock still held, so no other call passes a cap in the meantime.
  const settle = async (by, shown = null) => {
    const { prepared, verdict } = pass(shown);
    if (shown && shownAs(prepared) !== shownAs(shown)) throw new Stop('refused', CHANGED, shown);
    if (verdict === 'ask' && by !== 'owner') throw new Stop('refused', 'The owner changed the level while this waited. Nothing was done: try it once more.', prepared);
    let out = action.run(prepared, env, deps, given);
    if (typeof out?.then === 'function') out = await out;
    return end('allow', by, out.text, { ...about(prepared), ...(out.target ? { target: out.target } : {}), undo: out.undo ?? null, mandate: prepared.asOwner === true && out.asOwner !== false ? prepared.mandate : null });
  };
  if (READS.includes(tool)) { try { return await settle('level'); } catch (error) { return stopped(error); } }
  let by = 'level', shown = null;
  let first; try { first = pass(); } catch (error) { return stopped(error); }
  if (first.verdict === 'ask') {
    // What he cannot read whole is never asked about.
    if (typeof first.prepared.whole === 'string' && first.prepared.whole.length > WHOLE_LIMIT) return end('refused', 'level', TOO_LONG, about(first.prepared));
    const answer = await askOwner(tool, given, first.prepared, env);
    if (answer !== 'allow') return end(answer === 'deny' ? 'deny' : 'timeout', 'owner', answer === 'deny' ? DENIED : notAnswered(Number.isFinite(env.waitSeconds) && env.waitSeconds > 0 ? env.waitSeconds : APPROVAL_WAIT_SECONDS), about(first.prepared));
    by = 'owner'; shown = first.prepared;
  }
  // Another turn of the bot, in another session, counts against the same caps: one at a time.
  let release = null; try { release = waitLock({ state: logFolder() }, 'actions', 300); } catch { return end('refused', 'level', BUSY); }
  try { return await settle(by, shown); } catch (error) { return stopped(error); } finally { try { release(); } catch { /* Released already. */ } }
}
// What a call is about, in the words the owner would be asked, with nothing done and nothing
// logged: for the relay's own record of the tool call.
export function actionSummary(name, input, ctx = {}) {
  const action = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : null;
  if (!action || !isObject(ctx.repo) || !isObject(ctx.task) || !isObject(ctx.bot)) return `Use ${one(name, 60) || 'a tool'}`;
  try { return action.check(isObject(input) ? input : {}, { ...ctx, name: ctx.bot.name, now: Date.now(), projects: typeof ctx.projects === 'function' ? ctx.projects : registeredProjects, settings: settingsNow() }).summary; }
  catch { return `Use ${one(name, 60)}`; }
}

// ---------------------------------------------------------------------------------------
// Undo, by the owner (/orchestrator undo a12), where the kind of action has one:
//   a message or an answer   taken back while it still waits; none once a turn read it
//   a card                   removed while it is in To do
//   a started session        taken back before it starts; archived after, never deleted
//   a fact                   withdrawn by its id
//   an Organization line     removed, after his yes (confirmed), as adding it was
// { done, id, how, text }, or { done: false, id, asks } for a line that waits for that yes.
// Refused, with the reason, when there is nothing to undo or it is too late.
const NO_UNDO = { org_propose: 'a removed line is proposed again to bring it back.' };
function startedSession(repo, row) {
  let tasks = []; try { tasks = projectSnapshot(repo).tasks; } catch { return null; }
  // A session keeps no word of the request that started it, so it is found by what the call
  // left: the one session of this computer with that goal, made after the call, whose record
  // says this bot started it (overseer). One the owner started himself, with the same goal, is
  // never taken for it. Two that fit are not guessed between.
  const found = tasks.filter(task => !task.origin && typeof task.goal === 'string' && hash(task.goal).slice(0, 16) === row.undo.goal && time(task.createdAt) >= time(row.at) - 1000 && typeof row.bot === 'string' && task.overseer === row.bot);
  return found.length === 1 ? found[0] : null;
}
export function undoAction(id, { confirmed = false, now = Date.now(), projects = registeredProjects } = {}) {
  const wanted = String(id ?? '').trim().toLowerCase(), row = readLog().rows.find(value => value.id === wanted);
  if (!row) refuse(`No logged action has the id ${one(wanted, 20) || 'given'}. /orchestrator lists the last ones.`);
  if (row.decision !== 'allow') refuse(`${row.id} was not done, so there is nothing to undo.`);
  if (row.undoneAt) refuse(`${row.id} was undone already.`);
  if (!row.undo) refuse(`${row.id} has no undo: ${NO_UNDO[row.action] ?? 'it changed nothing.'}`);
  const undo = row.undo, repoOf = root => projects().find(repo => repo.root === root) ?? refuse('That project is no longer on this computer.');
  const done = (how, text) => { logUndo(row.id, how, now); return { done: true, id: row.id, how, text }; };
  if (undo.kind === 'message') {
    if (!takeRequest(undo.root, undo.request)) refuse(`${row.id} cannot be taken back: a turn already read it, or it is starting now.`);
    return done('taken back', 'Taken back before a turn read it.');
  }
  if (undo.kind === 'card') {
    removeCard(repoOf(undo.root), undo.card, { todo: true });
    return done('removed', 'Removed the card from To do.');
  }
  if (undo.kind === 'session') {
    if (takeRequest(undo.root, undo.request)) return done('taken back', 'Taken back before it started.');
    const repo = repoOf(undo.root), waiting = pendingRequests(undo.root).find(request => request.id === undo.request);
    let task = null; try { task = waiting?.taskId ? readTask(repo, String(waiting.taskId)) : startedSession(repo, row); } catch { task = null; }
    if (!task) refuse(waiting ? 'It is starting now. Undo it again in a moment.' : 'ELU could not tell which session it became. Archive it in Sessions.');
    const label = `session ${task.id} of ${projectLabel(repo)}`;
    if (LIVE.includes(task.state)) refuse(`${label[0].toUpperCase()}${label.slice(1)} is at work. Stop it in Sessions, then undo it again.`);
    if (!sessionArchived(readBoard(repo), task)) closeSession(repo, String(task.id));
    return done('archived', `Archived ${label}. Nothing was deleted: /archived lists it.`);
  }
  if (undo.kind === 'rename') {
    const repo = repoOf(undo.root); let task = null; try { task = readTask(repo, String(undo.session)); } catch { task = null; }
    if (!task) refuse('That session is no longer on this computer.');
    if (task.titleBy !== 'owner' || task.title !== undo.name) refuse(`${row.id} cannot be undone: the session was renamed again since.`);
    setTitle(repo, String(undo.session), undo.title ?? '');
    return done('renamed back', undo.title ? `Gave session ${undo.session} its name back: "${one(undo.title, 80)}".` : `Took the bot's name away: session ${undo.session} shows its goal again.`);
  }
  if (undo.kind === 'archive') {
    const repo = repoOf(undo.root); let task = null; try { task = readTask(repo, String(undo.session)); } catch { task = null; }
    if (!task) refuse('That session is no longer on this computer.');
    const archived = sessionArchived(readBoard(repo), task), label = `session ${task.id} of ${projectLabel(repo)}`;
    if (undo.archived !== false) {
      if (!archived) refuse(`${row.id} cannot be undone: ${label} is not archived now.`);
      reopenSession(repo, String(task.id));
      return done('brought back', `Brought back ${label}. Messages it held when it was archived are not brought back.`);
    }
    if (archived) refuse(`${row.id} cannot be undone: ${label} is archived already.`);
    if (LIVE.includes(task.state)) refuse(`${label[0].toUpperCase()}${label.slice(1)} is at work. Stop it in Sessions, then undo it again.`);
    archiveSession(repo, task.id, now);
    return done('archived', `Archived ${label} again. Nothing was deleted: /archived lists it.`);
  }
  if (undo.kind === 'fact') {
    const { withdrawn } = withdrawFact(undo.fact, { now: new Date(now) });
    return done('withdrawn', withdrawn ? `Withdrew ${undo.fact}. It stays on file, marked withdrawn, so a line that cites it still says where it came from.` : `${undo.fact} was withdrawn already.`);
  }
  if (undo.kind === 'org') {
    const repo = repoOf(undo.root), found = findOrgLine(repo.root, undo.line);
    if (!confirmed) return { done: false, id: row.id, asks: `Remove from the Organization section of ${projectLabel(repo)}: "${found.line}"?` };
    removeOrgLine(repo.root, found.line);
    return done('removed', `Removed from the Organization section of ${projectLabel(repo)}: "${found.line}"`);
  }
  refuse(`${row.id} has no undo.`);
}
// Notes and answers of the bot that were taken out of the queue before a turn read them (the
// requests' ids): its log says so, so they count against no cap and no undo is offered for them.
export function noteTakenBack(requests, now = Date.now()) {
  const ids = new Set([].concat(requests ?? []).filter(id => typeof id === 'string'));
  if (!ids.size) return 0;
  let count = 0;
  for (const row of readLog().rows.filter(value => value.undo?.kind === 'message' && ids.has(value.undo.request) && !value.undoneAt)) { try { logUndo(row.id, 'taken back', now); count++; } catch { /* The rest are still said. */ } }
  return count;
}
// The owner stopped, archived or checked a session: what the bot sent it and no turn read yet,
// notes and answers alike, goes with it. Returns how many were taken back.
export function takeBackNotes(root, session, { now = Date.now() } = {}) {
  let waiting = []; try { waiting = pendingRequests(root).filter(row => (typeof row.overseer === 'string' || isObject(row.asOwner)) && row.state === 'queued' && String(row.continuationTaskId) === String(session)); } catch { return 0; }
  const taken = [];
  for (const request of waiting) { try { if (takeRequest(root, request.id)) taken.push(request.id); } catch { /* The rest are still taken back. */ } }
  try { noteTakenBack(taken, now); } catch { /* Taken back all the same. */ }
  return taken.length;
}
