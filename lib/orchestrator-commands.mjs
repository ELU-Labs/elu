import { atomic, refuse } from './util.mjs';
import { readTask } from './state.mjs';
import * as orchestratorSettings from './orchestrator-settings.mjs';
import { orchestratorLines, undoAction } from './orchestrator-actions.mjs';
import * as mandateStore from './orchestrator-mandates.mjs';
import { DECISIONS_MAX, DECISION_MAX, GOAL_MAX, NAME_MAX, joinMandate, mandateById, mandateFor, mandates, mandatesFile, saveMandate } from './orchestrator-mandates.mjs';
import { LEVEL_FULL, LEVEL_FULL_NAME } from './orchestrator-seams.mjs';
import { isMyComputer, markMyComputer, myComputers, unmarkMyComputer } from './peer/my-computers.mjs';
import { computers } from './peer/session-tools.mjs';
import { peerStatus } from './peer/index.mjs';
import { scanSecrets } from './peer/secrets.mjs';
import { botOversees, listBots } from './bots.mjs';
import { botChatSession } from './bot-schedules.mjs';
import { ownSession } from './session-commands.mjs';
import { applySessionSettings, projectName, registeredProjects } from './projects.mjs';
import { COMPUTERS_USAGE, ORCHESTRATOR_USAGE } from './orchestrator-words.mjs';

// The owner's commands for the bot that oversees his sessions at the Full level
// (lib/orchestrator-seams.mjs): /orchestrator with its levels, Full among them, and his mandates,
// and /computers, which marks which of the computers on his projects are his own. Only the
// owner types them, in ELU: no turn reaches this file, and nothing here is a tool of the bot's.
//
// The terminal calls orchestratorCommand(args, ctx) for /orchestrator and computersCommand(args,
// ctx) for /computers. Each returns { line } for the status line or { title, text } for a page
// to read, and throws with the sentence to show when it refuses. ctx, every field optional:
//   text   what was typed after the command name, as typed (the words are split from it)
//   yes    async (title, question, keys) => boolean: the terminal's own question
//   root   the open project's folder, for a session named by its number
//   open   the open session: { root, id } here, or { computer, project, session } on another
//          computer of the owner's (lib/orchestrator-mandates.mjs MandateSession)
//   settings  a stand-in for lib/orchestrator-settings.mjs, for tests

// The usages, the /computers row for the command list (lib/terminal-commands.mjs COMMANDS), and
// the words each command offers after its name, in a file of their own the command list reads.
export { COMPUTERS_COMMAND, COMPUTERS_USAGE, COMPUTERS_WORDS, ORCHESTRATOR_USAGE, ORCHESTRATOR_WORDS } from './orchestrator-words.mjs';

const SESSION_NUMBER = /^[1-9][0-9]{0,9}$/, MANDATE_ID = /^m[1-9][0-9]{0,5}$/i;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const plain = value => String(value ?? '').trim().replace(/^@/, '').replace(/\s+/g, '').toLowerCase();
// The words typed after the command's name: from the text as typed when there is one.
const wordsOf = (args, ctx) => typeof ctx.text === 'string' ? ctx.text.trim().split(/\s+/).filter(Boolean) : (Array.isArray(args) ? args : []).map(String);
const restOf = (ctx, words) => typeof ctx.text === 'string' ? ctx.text.trim().replace(/^\S+\s*/, '') : words.slice(1).join(' ');
const or = list => list.length > 1 ? `${list.slice(0, -1).join(', ')} or ${list.at(-1)}` : list.join('');

// ---------------------------------------------------------------------------------------
// /orchestrator
export async function orchestratorCommand(args = [], ctx = {}) {
  const words = wordsOf(args, ctx), first = words[0]?.toLowerCase(), settings = ctx.settings ?? orchestratorSettings;
  if (!words.length) return await orchestratorPage(settings);
  if (first === 'mandate' || first === 'mandates') return mandateCommand(restOf(ctx, words), ctx, settings);
  if (first === 'undo') {
    if (words.length !== 2) refuse('Use /orchestrator undo ID, as /orchestrator lists them.');
    let undone = undoAction(words[1]);
    // A line of the Organization section goes only after his yes, as it came.
    if (!undone.done) {
      if (!(typeof ctx.yes === 'function' && await ctx.yes(`Undo ${undone.id}`, undone.asks, 'y/N'))) return { line: `Nothing was undone: ${undone.id} stays.` };
      undone = undoAction(words[1], { confirmed: true });
    }
    return { line: `${undone.id}: ${undone.text}` };
  }
  if (words.length === 1 && (settings.LEVELS.includes(first) || first === LEVEL_FULL)) return levelCommand(first, settings);
  refuse(`Use ${ORCHESTRATOR_USAGE}.`);
}
// The owner sets the level. Full is his own typing of it (setLevel by: 'owner'); a turn never
// sets one. At Full the bot's own chats get Full access, which its turns there run with.
function levelCommand(level, settings) {
  if (!settings.LEVELS.includes(level)) refuse(`This ELU has no ${LEVEL_FULL_NAME} level yet.`);
  const now = settings.setLevel(level, { by: 'owner' });
  const chats = now.level === LEVEL_FULL ? fullChats() : 0;
  return { line: settings.levelLines(now)[0], level: now.level, chats };
}
// The chat of each bot that oversees, in every project here, in Full access. Returns how many changed.
function fullChats() {
  let bots = [], repos = [], count = 0;
  try { bots = listBots().filter(botOversees); repos = registeredProjects(); } catch { return 0; }
  for (const repo of repos) for (const bot of bots) {
    try {
      const chat = botChatSession(repo, bot.name);
      if (!chat?.id || readTask(repo, chat.id).permissions === 'full') continue;
      applySessionSettings(repo, chat.id, { access: 'full' }); count += 1;
    } catch { /* That chat keeps its access: /permissions full there gives it. */ }
  }
  return count;
}
// What /orchestrator shows: the level, the caps, the last actions, the mandates, and the commands.
async function orchestratorPage(settings) {
  let overseen = true; try { overseen = listBots().some(botOversees); } catch { /* Said as if one oversees. */ }
  const list = mandates(), names = await refNames();
  const levels = or(settings.LEVELS);
  return { title: 'Orchestrator', text: [
    ...orchestratorLines(), ...(overseen ? [] : ['', 'No bot of yours oversees your sessions now: these apply when one does.']),
    '', ...(list.length ? ['Mandates', ...list.map(m => `  ${mandateLine(m)}`)] : ['No mandates: its messages to your sessions are notes.']),
    '', `/orchestrator ${levels} sets the level. /orchestrator mandate NAME: decisions gives it your word for one goal. /orchestrator undo ID undoes one action.`,
  ].join('\n') };
  function mandateLine(m) { return [m.id, m.name, plural(m.decisions.length, 'decision'), m.sessions.length ? m.sessions.map(ref => sessionLabel(ref, names)).join(', ') : 'no sessions'].join(' · '); }
}

// ---------------------------------------------------------------------------------------
// Mandates (lib/orchestrator-mandates.mjs): the owner's word for one goal. Only he makes, changes
// or removes one, here; the bot may only propose one, and he says yes.
//   mandate                         the list (also: mandates)
//   mandate NAME                    one mandate
//   mandate NAME: d1; d2            make it, or give it these decisions
//   mandate NAME add [N]            session N of this project, or the open session, joins it
//   mandate NAME drop [N]           the same session leaves it
//   mandate remove NAME             remove it
const MANDATE_USE = 'Use /orchestrator mandate NAME: decision; decision, /orchestrator mandate NAME add N, or /orchestrator mandate remove NAME.';
async function mandateCommand(rest, ctx, settings) {
  const text = rest.trim(), colon = text.indexOf(':');
  if (!text) return await mandateList();
  if (colon >= 0) return saveDecisions(text.slice(0, colon).trim(), text.slice(colon + 1), settings);
  const removing = /^(?:remove|delete)\s+(.+)$/i.exec(text);
  if (removing) return removeCommand(findMandate(removing[1]));
  const joining = /^(.+?)\s+(add|drop)(?:\s+(\S+))?$/i.exec(text);
  if (joining) return sessionCommand(findMandate(joining[1]), joining[2].toLowerCase(), joining[3] ?? null, ctx);
  const found = findMandate(text, { quiet: true });
  if (!found) refuse(`No mandate is named ${text.slice(0, NAME_MAX)}. ${MANDATE_USE}`);
  return { title: `Mandate ${found.id}`, text: mandateText(found, await refNames()).join('\n') };
}
function findMandate(word, { quiet = false } = {}) {
  const wanted = String(word ?? '').trim();
  const found = MANDATE_ID.test(wanted) ? mandateById(wanted.toLowerCase()) : mandates().find(m => m.name.toLowerCase() === wanted.toLowerCase()) ?? null;
  if (!found && !quiet) refuse(`No mandate is named ${wanted.slice(0, NAME_MAX)}. /orchestrator mandates lists them.`);
  return found;
}
// The words before the colon are the goal, and name the mandate (cut to NAME_MAX); an id there
// (m1) names one that is made already. The decisions are set apart by semicolons.
function saveDecisions(goalText, decisionsText, settings) {
  if (!goalText) refuse(MANDATE_USE);
  const decisions = decisionsText.split(/[;\n]/).map(line => line.trim()).filter(Boolean);
  if (goalText.length > GOAL_MAX) refuse(`Keep a mandate's goal to ${GOAL_MAX} characters. This one has ${goalText.length}.`);
  if (decisions.length > DECISIONS_MAX) refuse(`A mandate holds up to ${DECISIONS_MAX} decisions. This one has ${decisions.length}.`);
  const long = decisions.find(line => line.length > DECISION_MAX);
  if (long) refuse(`Keep each decision to ${DECISION_MAX} characters. One has ${long.length}.`);
  // Its decisions go into the starting text of every session it starts.
  if (scanSecrets([goalText, ...decisions].join('\n')).length) refuse('That may hold a secret, so it was not saved.');
  const byId = MANDATE_ID.test(goalText) ? mandateById(goalText.toLowerCase()) : null;
  if (MANDATE_ID.test(goalText) && !byId) refuse(`No mandate has the id ${goalText}. /orchestrator mandates lists them.`);
  const name = goalText.length <= NAME_MAX ? goalText : `${goalText.slice(0, NAME_MAX - 1).replace(/\s+\S*$/, '')}…`;
  const before = byId ?? mandates().find(m => m.name.toLowerCase() === name.toLowerCase()) ?? null;
  // The goal stays as it was written first unless other words are given for it.
  const goal = byId || before?.goal.toLowerCase() === goalText.toLowerCase() ? before.goal : goalText;
  const saved = saveMandate(before ? { ...before, goal, decisions } : { name, goal, decisions, sessions: [] }, { by: 'owner' });
  const counted = plural(saved.decisions.length, 'decision');
  const atFull = settings.LEVELS.includes(LEVEL_FULL) && settings.readSettings().level !== LEVEL_FULL ? ` It gives your word at ${LEVEL_FULL_NAME} only: /orchestrator full.` : '';
  return { line: before ? `Mandate ${saved.id} ${saved.name} has ${counted} now.${atFull}` : `Mandate ${saved.id} ${saved.name}: ${counted}. Sessions started under it join it, and /orchestrator mandate ${saved.id} add N adds one.${atFull}`, mandate: saved };
}
// No seam removes a mandate yet: one that comes (removeMandate) is used, else the file is
// written as its own writer writes it, without that mandate.
function removeCommand(found) {
  if (typeof mandateStore.removeMandate === 'function') mandateStore.removeMandate(found.id, { by: 'owner' });
  else atomic(mandatesFile(), { version: 1, mandates: mandates().filter(m => m.id !== found.id) });
  return { line: `Removed mandate ${found.id} ${found.name}. In its sessions the Orchestrator's messages are notes again.` };
}
const sameRef = (a, b) => (a.computer ?? null) === (b.computer ?? null) && a.project === b.project && a.session === b.session;
async function sessionCommand(found, verb, word, ctx) {
  const { ref, label } = await sessionRef(word, ctx);
  if (verb === 'drop') {
    if (!found.sessions.some(row => sameRef(row, ref))) return { line: `${label} is not in mandate ${found.id} ${found.name}.` };
    saveMandate({ ...found, sessions: found.sessions.filter(row => !sameRef(row, ref)) }, { by: 'owner' });
    return { line: `${label} left mandate ${found.id} ${found.name}.` };
  }
  if (found.sessions.some(row => sameRef(row, ref))) return { line: `${label} is in mandate ${found.id} ${found.name} already.` };
  // A session is in one mandate at a time: one it was in lets it go.
  const other = mandateFor(ref);
  if (other && other.id !== found.id) saveMandate({ ...other, sessions: other.sessions.filter(row => !sameRef(row, ref)) }, { by: 'owner' });
  joinMandate(found.id, ref, { by: 'owner' });
  return { line: `${label} joined mandate ${found.id} ${found.name}${other && other.id !== found.id ? `, and left ${other.id} ${other.name}` : ''}.` };
}
// The session a mandate command names: N of the open project, else the open session. One a
// teammate's message started here, or one on a computer not marked as the owner's, is never his.
async function sessionRef(word, ctx) {
  const open = ctx.open ?? null;
  if (word || open?.root) {
    const id = word ?? String(open.id ?? ''), root = word ? ctx.root : open.root;
    if (!SESSION_NUMBER.test(id)) refuse('Name the session by its number in this project.');
    const repo = typeof root === 'string' ? registeredProjects().find(row => row.root === root) : null;
    if (!repo) refuse('Open a project first: the number names one of its sessions.');
    let task; try { task = readTask(repo, id); } catch { refuse(`No session ${id} in ${projectName(repo.root)}.`); }
    if (!ownSession(task.origin)) refuse("A session a teammate's message started is never in a mandate.");
    const { projectKey } = await import('./peer/remote.mjs');
    return { ref: { computer: null, project: projectKey(repo.root), session: id }, label: `Session ${id}` };
  }
  if (!open) refuse('Open a session, or name it by its number: /orchestrator mandate NAME add N.');
  const ref = { computer: open.computer ?? null, project: String(open.project ?? ''), session: String(open.session ?? '') }, named = (await refNames()).computers.get(ref.computer);
  if (ref.computer && !isMyComputer(ref.computer)) refuse(`That session's computer is not marked as yours here. /computers mine ${named ?? 'NAME'} marks it.`);
  return { ref, label: ref.computer ? `Session ${ref.session} on @${named ?? ref.computer.slice(0, 8)}` : `Session ${ref.session}` };
}
async function mandateList() {
  const list = mandates();
  if (!list.length) return { line: 'No mandates yet. /orchestrator mandate NAME: decision; decision makes one.' };
  const names = await refNames();
  return { title: 'Mandates', text: [...list.flatMap(m => [...mandateText(m, names), '']), MANDATE_USE].join('\n') };
}
function mandateText(m, names) {
  return [`${m.id} · ${m.name} · ${plural(m.decisions.length, 'decision')} · ${plural(m.sessions.length, 'session')}`,
    ...(m.goal && m.goal.toLowerCase() !== m.name.toLowerCase() ? [`  Goal: ${m.goal}`] : []), ...m.decisions.map(line => `  - ${line}`),
    ...(m.sessions.length ? [`  Sessions: ${m.sessions.map(ref => sessionLabel(ref, names)).join(', ')}`] : [])];
}
// What a mandate's sessions are called here: projects by name, computers by their @name.
async function refNames() {
  const projects = new Map(), named = new Map();
  try { const { projectKey } = await import('./peer/remote.mjs'); for (const repo of registeredProjects()) projects.set(projectKey(repo.root), projectName(repo.root)); } catch { /* Here, unnamed. */ }
  try { for (const row of myComputers()) named.set(row.key, row.name); } catch { /* By key. */ }
  try { for (const row of computers()) named.set(row.key, row.name); } catch { /* By key. */ }
  return { projects, computers: named };
}
function sessionLabel(ref, names) {
  if (ref.computer == null) { const project = names.projects.get(ref.project); return project ? `${ref.session} in ${project}` : `${ref.session} here`; }
  return `${ref.session} on @${names.computers.get(ref.computer) ?? ref.computer.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------------------
// /computers: which computers on the owner's projects are his own, as this computer knows them
// (lib/peer/my-computers.mjs). The mark is made here, by him, for each computer: what a marked
// one sends for him counts as his own words here. Each computer marks the other for itself.
export async function computersCommand(args = [], ctx = {}) {
  const words = wordsOf(args, ctx), verb = words[0]?.toLowerCase();
  if (!words.length) return { line: computersLine() };
  if (!['mine', 'unmine'].includes(verb) || words.length < 2) refuse(`Use ${COMPUTERS_USAGE}.`);
  const named = words.slice(1).join(' ');
  if (verb === 'unmine') {
    const row = findComputer(named, { marked: true });
    return { line: unmarkMyComputer(row.key) ? `@${row.name} is not yours here now: what it sends counts as a teammate's again.` : `@${row.name} was not marked as yours here.`, key: row.key };
  }
  const row = findComputer(named);
  if (isMyComputer(row.key)) return { line: `@${row.name} is yours here already.`, key: row.key };
  let me = null; try { me = peerStatus(); } catch { me = null; }
  // A computer that goes by another person's name on the team is asked about first: marked,
  // it could start sessions here with Full access and answer for him.
  if (row.person && me?.name && plain(row.person) !== plain(me.name) && typeof ctx.yes === 'function'
    && !await ctx.yes(`Mark @${row.name} as yours`, `@${row.name} is ${row.person}'s on your team. Marked, what it sends for you counts as your own words here: it can start sessions with Full access and answer for you.`, 'y/N')) return { line: 'Nothing was marked.' };
  const saved = markMyComputer(row.key, row.name), here = me?.box ? `@${plain(me.box)}` : 'this computer';
  return { line: `@${saved.name} is yours here: what it sends for you counts as your own words. On @${saved.name}, /computers mine ${here} marks this one too.`, key: row.key };
}
function computersLine() {
  let listed = [], marks = [];
  try { listed = computers(); } catch { listed = []; }
  try { marks = myComputers(); } catch { marks = []; }
  const mine = listed.filter(row => isMyComputer(row.key)), others = listed.filter(row => !mine.includes(row)), gone = marks.filter(mark => !listed.some(row => row.key === mark.key));
  if (!listed.length && !gone.length) return 'No other computer shares a project with this one. /invite in a project shares it.';
  const names = rows => rows.map(row => `@${row.name}`).join(', ');
  return [mine.length ? `Yours here: ${names(mine)}.` : 'None is marked as yours here.', others.length ? `Not marked: ${names(others)}.` : null,
    gone.length ? `Marked, on none of your projects now: ${names(gone)}.` : null, others.length ? '/computers mine NAME marks one.' : null].filter(Boolean).join(' ');
}
// A computer on the owner's projects by its @name, its person's name, or the start of its key
// (8 characters at least). marked: one marked here that is on none of them now counts too.
function findComputer(word, { marked = false } = {}) {
  const wanted = plain(word);
  if (!wanted) refuse(`Use ${COMPUTERS_USAGE}.`);
  let listed = []; try { listed = computers().map(row => ({ key: row.key, name: row.name, person: row.person ?? null })); } catch { listed = []; }
  let saved = []; try { saved = marked ? myComputers().filter(row => !listed.some(item => item.key === row.key)).map(row => ({ key: row.key, name: row.name, person: null })) : []; } catch { saved = []; }
  const all = [...listed, ...saved];
  const byName = all.filter(row => plain(row.name) === wanted), byKey = /^[0-9a-f]{8,64}$/.test(wanted) ? all.filter(row => row.key.startsWith(wanted)) : [];
  const found = byName.length ? byName : byKey.length ? byKey : all.filter(row => row.person && plain(row.person) === wanted);
  if (!found.length) refuse(`No computer on your projects goes by @${wanted.slice(0, 40)}. /computers lists them.`);
  if (found.length > 1) refuse(`${found.length} computers go by @${wanted.slice(0, 40)}: name one by the start of its key, ${found.map(row => row.key.slice(0, 8)).join(' or ')}.`);
  return found[0];
}
