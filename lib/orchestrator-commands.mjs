import { refuse } from './util.mjs';
import { readTask } from './state.mjs';
import * as orchestratorSettings from './orchestrator-settings.mjs';
import { orchestratorLines, undoAction } from './orchestrator-actions.mjs';
import { LEVEL_FULL, LEVEL_FULL_NAME } from './orchestrator-seams.mjs';
import { isMyComputer, markMyComputer, myComputers, unmarkMyComputer } from './peer/my-computers.mjs';
import { computers } from './peer/session-tools.mjs';
import { peerStatus } from './peer/index.mjs';
import { botOversees, listBots } from './bots.mjs';
import { botChatSession } from './bot-schedules.mjs';
import { applySessionSettings, registeredProjects } from './projects.mjs';
import { COMPUTERS_USAGE, ORCHESTRATOR_USAGE } from './orchestrator-words.mjs';

// The owner's commands for the bot that oversees his sessions (lib/orchestrator-seams.mjs):
// /orchestrator with its levels, Full the default among them, and /computers, which says which of
// the computers on his projects are his own: the paired ones, and any he marks here. He needs
// neither to start: the level is Full and his paired computers are his. Only the owner types
// them, in ELU: no turn reaches this file, and nothing here is a tool of the bot's.
//
// The terminal calls orchestratorCommand(args, ctx) for /orchestrator and computersCommand(args,
// ctx) for /computers. Each returns { line } for the status line or { title, text } for a page
// to read, and throws with the sentence to show when it refuses. ctx, every field optional:
//   text   what was typed after the command name, as typed (the words are split from it)
//   yes    async (title, question, keys) => boolean: the terminal's own question
//   settings  a stand-in for lib/orchestrator-settings.mjs, for tests

// The usages, the /computers row for the command list (lib/terminal-commands.mjs COMMANDS), and
// the words each command offers after its name, in a file of their own the command list reads.
export { COMPUTERS_COMMAND, COMPUTERS_USAGE, COMPUTERS_WORDS, ORCHESTRATOR_USAGE, ORCHESTRATOR_WORDS } from './orchestrator-words.mjs';

const plain = value => String(value ?? '').trim().replace(/^@/, '').replace(/\s+/g, '').toLowerCase();
// The words typed after the command's name: from the text as typed when there is one.
const wordsOf = (args, ctx) => typeof ctx.text === 'string' ? ctx.text.trim().split(/\s+/).filter(Boolean) : (Array.isArray(args) ? args : []).map(String);
const or = list => list.length > 1 ? `${list.slice(0, -1).join(', ')} or ${list.at(-1)}` : list.join('');

// ---------------------------------------------------------------------------------------
// /orchestrator
export async function orchestratorCommand(args = [], ctx = {}) {
  const words = wordsOf(args, ctx), first = words[0]?.toLowerCase(), settings = ctx.settings ?? orchestratorSettings;
  if (!words.length) return orchestratorPage(settings);
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
// The owner sets the level. Full is his own typing of it (setLevel by: 'owner'), or the default; a
// turn never sets one. At Full the bot's own chats get Full access, which its turns there run with.
function levelCommand(level, settings) {
  if (!settings.LEVELS.includes(level)) refuse(`This ELU has no ${LEVEL_FULL_NAME} level yet.`);
  const now = settings.setLevel(level, { by: 'owner' });
  const chats = now.level === LEVEL_FULL ? fullChats() : 0;
  return { line: settings.levelLines(now)[0], level: now.level, chats };
}
// The chat of each bot that oversees, in every project here, in Full access. Returns how many
// changed. The terminal gives a chat Full access the same way when the owner writes to it at Full.
export function fullChats() {
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
// What /orchestrator shows: the level, the caps, the last actions, and the commands.
function orchestratorPage(settings) {
  let overseen = true; try { overseen = listBots().some(botOversees); } catch { /* Said as if one oversees. */ }
  const levels = or(settings.LEVELS);
  return { title: 'Orchestrator', text: [
    ...orchestratorLines(), ...(overseen ? [] : ['', 'No bot of yours oversees your sessions now: these apply when one does.']),
    '', `Talk to @orchestrator to have it run your sessions. /orchestrator ${levels} sets the level. /orchestrator undo ID undoes one action.`,
  ].join('\n') };
}

// ---------------------------------------------------------------------------------------
// /computers: which computers on the owner's projects are his own, as this computer knows them
// (lib/peer/my-computers.mjs): the ones paired with this one as his (GitHub pairing, or /mine on
// both), and any he marks here. unmine says one is not his here, paired or not, until he marks it
// again. What one of his sends for him counts as his own words here.
export async function computersCommand(args = [], ctx = {}) {
  const words = wordsOf(args, ctx), verb = words[0]?.toLowerCase();
  if (!words.length) return { line: computersLine() };
  if (!['mine', 'unmine'].includes(verb) || words.length < 2) refuse(`Use ${COMPUTERS_USAGE}.`);
  const named = words.slice(1).join(' ');
  if (verb === 'unmine') {
    const row = findComputer(named, { marked: true });
    const was = unmarkMyComputer(row.key, row.name);
    return { line: was ? `@${row.name} is not yours here now, paired or not: what it sends counts as a teammate's again. /computers mine ${row.name} makes it yours again.` : `@${row.name} is not yours here.`, key: row.key };
  }
  const row = findComputer(named);
  if (isMyComputer(row.key)) return { line: `@${row.name} is yours here already.`, key: row.key };
  let me = null; try { me = peerStatus(); } catch { me = null; }
  // A computer that goes by another person's name on the team is asked about first: marked,
  // it could start sessions here with Full access and answer for him.
  if (row.person && me?.name && plain(row.person) !== plain(me.name) && typeof ctx.yes === 'function'
    && !await ctx.yes(`Mark @${row.name} as yours`, `@${row.name} is ${row.person}'s on your team. Marked, what it sends for you counts as your own words here: it can start sessions with Full access and answer for you.`, 'y/N')) return { line: 'Nothing was marked.' };
  const saved = markMyComputer(row.key, row.name), here = me?.box ? `@${plain(me.box)}` : 'this computer';
  return { line: `@${saved.name} is yours here: what it sends for you counts as your own words. Unless the two are paired, on @${saved.name} /computers mine ${here} makes this one its too.`, key: row.key };
}
function computersLine() {
  let listed = [], marks = [];
  try { listed = computers(); } catch { listed = []; }
  try { marks = myComputers(); } catch { marks = []; }
  const mine = listed.filter(row => isMyComputer(row.key)), others = listed.filter(row => !mine.includes(row)), gone = marks.filter(mark => !mark.paired && !listed.some(row => row.key === mark.key));
  if (!listed.length && !gone.length) return 'No other computer shares a project with this one. /invite in a project shares it.';
  const names = rows => rows.map(row => `@${row.name}`).join(', ');
  return [mine.length ? `Yours here: ${names(mine)}.` : 'None is yours here yet: a computer signed in to the same GitHub account is paired as yours.', others.length ? `Not yours: ${names(others)}.` : null,
    gone.length ? `Marked, on none of your projects now: ${names(gone)}.` : null, others.length ? '/computers mine NAME makes one yours.' : null].filter(Boolean).join(' ');
}
// A computer on the owner's projects by its @name, its person's name, or the start of its key
// (8 characters at least). marked: one marked here that is on none of them now counts too.
function findComputer(word, { marked = false } = {}) {
  const wanted = plain(word);
  if (!wanted) refuse(`Use ${COMPUTERS_USAGE}.`);
  let listed = []; try { listed = computers().map(row => ({ key: row.key, name: row.name, person: row.person ?? null })); } catch { listed = []; }
  let saved = []; try { saved = marked ? myComputers().filter(row => !row.paired && !listed.some(item => item.key === row.key)).map(row => ({ key: row.key, name: row.name, person: null })) : []; } catch { saved = []; }
  const all = [...listed, ...saved];
  const byName = all.filter(row => plain(row.name) === wanted), byKey = /^[0-9a-f]{8,64}$/.test(wanted) ? all.filter(row => row.key.startsWith(wanted)) : [];
  const found = byName.length ? byName : byKey.length ? byKey : all.filter(row => row.person && plain(row.person) === wanted);
  if (!found.length) refuse(`No computer on your projects goes by @${wanted.slice(0, 40)}. /computers lists them.`);
  if (found.length > 1) refuse(`${found.length} computers go by @${wanted.slice(0, 40)}: name one by the start of its key, ${found.map(row => row.key.slice(0, 8)).join(' or ')}.`);
  return found[0];
}
