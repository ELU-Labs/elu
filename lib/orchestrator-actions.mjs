import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EluCodeError, dataBlock, hash, homeOrAbove, isObject, mkdir, noSymlinks, personalDirectory, refuse } from './util.mjs';
import { readTask, sessionGoal, taskDir, taskTitle, waitLock } from './state.mjs';
import { APPROVAL_WAIT_SECONDS, LABELS, MODES, PROFILES, capMode } from './modes.mjs';
import { SUMMARY_LIMIT, TOO_LONG, WHOLE_LIMIT, awaitDecision, requestApproval } from './approvals.mjs';
import { addCard, closeSession, readBoard, removeCard, sessionArchived, sessionClosed, sessionPlace } from './kanban.mjs';
import { pendingRequests, takeRequest } from './workspace.mjs';
import { conversationEntries, projectName, projectSnapshot, registeredProjects } from './projects.mjs';
import { currentTask } from './plan.mjs';
import { stopLine } from './stop-line.mjs';
import { archiveAsked, ownSession } from './session-commands.mjs';
import { botOversees, sessionWorker } from './bots.mjs';
import { sentByElu } from './elu-sent.mjs';
import { scanSecrets } from './peer/secrets.mjs';
import { sanitize } from './peer/peerdata.mjs';
import { redact } from './publish.mjs';
import { compact, modelLabel, moneyText } from './agent-spend.mjs';
import { clock, proofText, readOverview, readSession, stateDigest } from './session-overview.mjs';
import { FACT_TOPICS, factText, factsElsewhere, findFacts, saveFact, withdrawFact } from './facts.mjs';
import { addOrgLine, checkOrgLine, findOrgLine, orgLines, removeOrgLine } from './org-section.mjs';
import { DEFAULT_CAPS, LEVEL_NAMES, capLines, levelLines, readSettings } from './orchestrator-settings.mjs';

// Everything the bot that oversees the owner's sessions does, it does through one function
// here: act. Its ten tools (lib/orchestrator-tools.mjs, served by lib/approval-server.mjs) are
// the only way it reads the sessions or changes anything, and each call goes through the same
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
// What it never does, at any level, and how that holds here:
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
const levels = (watch, suggest, act, run) => Object.freeze({ watch, suggest, act, run });
export const LEVEL_TABLE = Object.freeze({
  sessions_list: levels(YES, YES, YES, YES),
  session_read: levels(YES, YES, YES, YES),
  facts_find: levels(YES, YES, YES, YES),
  connections_list: levels(YES, YES, YES, YES),
  fact_save: levels(YES, YES, YES, YES),
  card_add: levels(NO, YES, YES, YES),
  org_propose: levels(NO, ASK, ASK, ASK),
  session_message: levels(NO, ASK, YES, YES),
  session_answer: levels(NO, ASK, YES, YES),
  session_start: levels(NO, ASK, ASK, YES),
});
export const decide = (level, name) => { const answer = Object.hasOwn(LEVEL_TABLE, name) ? LEVEL_TABLE[name][level] : null; return answer === YES ? 'allow' : answer === ASK ? 'ask' : 'refuse'; };
const NOT_AT_WATCH = { card_add: 'adds no card', org_propose: 'proposes no Organization line', session_message: 'writes to no session', session_answer: 'answers no session', session_start: 'starts no session' };
const atLevel = (name, level) => `The owner set the level to ${LEVEL_NAMES[level] ?? 'Watch'}, where the bot ${NOT_AT_WATCH[name] ?? 'does not do this'}. Say in your reply what you would do and why. Only the owner changes the level, with /orchestrator.`;
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
    decision: value.decision, by: value.by === 'owner' ? 'owner' : 'level', undo: isObject(value.undo) && typeof value.undo.kind === 'string' ? value.undo : null, undoneAt: null, undone: null, ...(typeof value.mark === 'string' ? { mark: value.mark } : {}) };
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
const READS = ['sessions_list', 'session_read', 'facts_find', 'connections_list', 'ask_elu'];
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
const UNDO_WORDS = { message: 'undo takes it back while it waits', card: 'undo removes it while it is in To do', session: 'undo takes it back before it starts, and archives it after', fact: 'undo withdraws it', org: 'undo removes the line, after your yes' };
// One logged call as a line for /orchestrator: its id, when, who, what, how it ended, and how it is undone.
export function actionLine(row, now = Date.now()) {
  const how = row.decision === 'allow' ? row.by === 'owner' ? 'done after your yes' : 'done' : HOW[row.decision];
  const undo = row.undoneAt ? `undone (${row.undone})` : row.decision === 'allow' && row.undo ? UNDO_WORDS[row.undo.kind] ?? null : null;
  return [row.id, time(row.at) ? clock(time(row.at), now) : null, row.bot ? `@${row.bot}` : null, row.summary || row.action, how, undo].filter(Boolean).join(' · ');
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
// Where a session stands, as one short mark: its Task and how far that is, what it committed
// and published, and how many messages the owner himself wrote there. Two marks that are the
// same mean nothing moved in between: a reply alone is not progress.
function progressMark(task, plan) {
  const steps = Array.isArray(plan?.subtasks) ? plan.subtasks.filter(row => row?.state === 'done').length : 0, met = Array.isArray(plan?.met) ? plan.met.length : 0;
  const own = (Array.isArray(task.messages) ? task.messages : []).filter(row => isObject(row) && !row.bot && !row.from && !row.scheduled && !row.overseer && !row.computer && !row.line && !row.standup && !row.update && !row.loop && !sentByElu(row.text)).length;
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
  if (NOTES.includes(name)) {
    const sent = within(HOUR).filter(row => NOTES.includes(row.action)).length;
    if (sent >= caps.messagesPerHour) return `The owner's cap is ${plural(caps.messagesPerHour, 'message')} and answers an hour, and you sent ${sent} in the last hour. Say it in your reply instead.`;
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
function sessionFor(given, env) {
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
function writable({ repo, task, id, label }, env) {
  if (repo.root === env.repo.root && id === String(env.task.id)) refuse('That is the session you are in. Say it in your reply.');
  if (!ownSession(task.origin)) refuse(`${label} was started from another computer or by a teammate. Only the owner writes to it.`);
  if (task.standup) refuse(`${label} is a Standup session. Its rounds are the owner's to ask for.`);
  if (task.botChat) refuse(`${label} is the owner's own chat with @${one(task.botChat, 30)}. Only the owner writes there.`);
  let board = null; try { board = readBoard(repo); } catch { board = null; }
  if (!board) refuse(`The board of ${projectLabel(repo)} could not be read, so ELU cannot tell whether ${label} is archived or in Done. Nothing was sent.`);
  if (sessionArchived(board, task) || archiveAsked(repo, id)) refuse(`${label} is archived. Only the owner brings it back.`);
  let place = null; try { place = sessionPlace(board, task, env.now); } catch { place = null; }
  if (sessionClosed(board, task) || place === 'done') refuse(`${label} is in Done. The owner checked it, and only he opens it again.`);
  if (ownerStopped(task)) refuse(`The owner stopped ${label}. It goes on when he says so.`);
  let plan = null; try { plan = currentTask(repo, id); } catch { plan = null; }
  if (plan?.state === 'proposed') refuse(`The Task of ${label} waits for the owner's approval. Only he approves a Task: say what you see in your reply.`);
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
const questionOf = task => { const reply = task.reply?.outcome === 'needs_input' ? task.reply : task.result; return task.state === 'needs_input' && typeof reply?.question === 'string' ? reply.question.trim() : ''; };
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
function queue(root, text, options, deps, needs) {
  const row = deps.enqueue(root, text, { priority: 1, ...options });
  const kept = isObject(row) && Object.entries(needs).every(([name, value]) => row[name] === value) && !row.typed && !row.approved && !row.picked;
  if (!kept) { try { if (row?.id) takeRequest(root, row.id); } catch { /* It stays for the owner to see in the queue. */ } refuse(UNMARKED); }
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
      const view = readOverview({ now: env.now, except: env.task.botChat ? { root: env.repo.root, id: String(env.task.id) } : null }), digest = stateDigest(view);
      if (!digest.total) return { text: 'No session on this computer is open: each one is in Done or archived, or there is none.' };
      return { text: `The sessions on this computer that are not in Done, what needs the owner first${digest.left ? `: ${digest.rows.length} of ${digest.total}` : ''}. As of ${clock(env.now, env.now)}. Name one by its project and the number after #.\n${dataBlock('Sessions', digest.lines)}` };
    },
  },
  session_read: {
    says: 'Read a session',
    check(given, env) { const target = sessionFor(given, env); return { ...target, target: { root: target.repo.root, session: target.id }, summary: `Read ${target.titled}` }; },
    run({ repo, task, id, label }, env) {
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
      const target = sessionFor(given, env), plan = writable(target, env), text = written(given.text, 'the note', NOTE_CHARS), title = asking(`Send a note to ${target.titled}: `, text);
      return { ...target, text, mark: progressMark(target.task, plan), target: { root: target.repo.root, session: target.id }, summary: title, title, whole: text, owner: fullAccess(target.task) };
    },
    cap: true, load: queueing,
    run({ repo, task, id, titled, text }, env, deps) {
      // A note about the work goes to who works there: the bot the session works with, else its model.
      let worker = null; try { worker = sessionWorker(task, { waiting: pendingRequests(repo.root) }); } catch { worker = null; }
      const row = queue(repo.root, text, { continuationTaskId: id, overseer: env.name, ...(worker ? { bot: worker } : {}) }, deps, { overseer: env.name });
      return { text: `Sent to ${titled}. It waits its turn there and shows under your name, as a note and not as the owner's word.`, target: { root: repo.root, session: id, request: row.id }, undo: { kind: 'message', root: repo.root, request: row.id } };
    },
  },
  session_answer: {
    says: 'Answer a session',
    check(given, env) {
      const target = sessionFor(given, env), plan = writable(target, env), question = questionOf(target.task);
      if (!question) refuse(`${target.label} asks no question now. A Task to approve and a permission request are the owner's alone to answer.`);
      const text = written(given.text, 'the answer', NOTE_CHARS), title = asking(`Answer ${target.titled}, which asks "${one(firstLine(question), 50)}": `, text);
      return { ...target, text, mark: progressMark(target.task, plan), target: { root: target.repo.root, session: target.id }, summary: title, title, whole: text, asks: questionMark(target.task), owner: fullAccess(target.task) };
    },
    cap: true, load: queueing,
    run({ repo, task, id, titled, text, asks }, env, deps) {
      let worker = null; try { worker = sessionWorker(task, { waiting: pendingRequests(repo.root) }); } catch { worker = null; }
      // It names the question it answers: if the session asks another by its turn, it is not given.
      const row = queue(repo.root, text, { continuationTaskId: id, overseer: env.name, asks, ...(worker ? { bot: worker } : {}) }, deps, { overseer: env.name, asks });
      return { text: `Answered ${titled}. The answer shows under your name, and the session goes on with it when its turn comes.`, target: { root: repo.root, session: id, request: row.id }, undo: { kind: 'message', root: repo.root, request: row.id } };
    },
  },
  session_start: {
    says: 'Start a session',
    check(given, env) {
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
    run({ repo, goal, mode, budget }, env, deps) {
      // A new worktree, no extra folders, no bots; not typed, so it waits for a free slot as a schedule's run does.
      const row = queue(repo.root, goal, { permissions: mode, place: { kind: 'worktree' }, folders: [], bots: [], overseer: env.name, budgetUsd: budget }, deps, { overseer: env.name, budgetUsd: budget, permissions: mode });
      return { text: `Started a session in ${projectLabel(repo)} with ${LABELS[mode]} and a ${dollars(budget)} budget: "${one(firstLine(goal), 80)}". It works in a new worktree with no bots, starts when a slot is free, and shows in Sessions as started by you.`,
        target: { root: repo.root, request: row.id }, undo: { kind: 'session', root: repo.root, request: row.id, goal: hash(goal).slice(0, 16) } };
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
  const end = (decision, by, text, { target = null, summary = '', undo = null, mark = null } = {}) => {
    let row = null, note = '';
    try { row = logAction({ at: iso(now), bot: env.name, from, action: one(tool, 60), target, summary: one(summary || `Use ${tool}`, SUMMARY_LIMIT), level: env.settings.level, decision, by, undo, undoneAt: null, ...(mark ? { mark } : {}) }); }
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
  const settle = (by, shown = null) => {
    const { prepared, verdict } = pass(shown);
    if (shown && shownAs(prepared) !== shownAs(shown)) throw new Stop('refused', CHANGED, shown);
    if (verdict === 'ask' && by !== 'owner') throw new Stop('refused', 'The owner changed the level while this waited. Nothing was done: try it once more.', prepared);
    const out = action.run(prepared, env, deps, given);
    return end('allow', by, out.text, { ...about(prepared), ...(out.target ? { target: out.target } : {}), undo: out.undo ?? null });
  };
  if (READS.includes(tool)) { try { return settle('level'); } catch (error) { return stopped(error); } }
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
  try { return settle(by, shown); } catch (error) { return stopped(error); } finally { try { release(); } catch { /* Released already. */ } }
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
  let waiting = []; try { waiting = pendingRequests(root).filter(row => typeof row.overseer === 'string' && row.state === 'queued' && String(row.continuationTaskId) === String(session)); } catch { return 0; }
  const taken = [];
  for (const request of waiting) { try { if (takeRequest(root, request.id)) taken.push(request.id); } catch { /* The rest are still taken back. */ } }
  try { noteTakenBack(taken, now); } catch { /* Taken back all the same. */ }
  return taken.length;
}
