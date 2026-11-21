// Changing an agent of a session: its model (the one its next message goes to) or a bot in
// its chat, by model and effort. What a change does is said in one line before it is saved,
// and the chat keeps one line of each change.
//
// What a change does, as the code and the vendors behave:
// - Effort alone: the same conversation goes on, nothing is read again. The next turn is
//   started with the new level (Claude Code --effort, Codex model_reasoning_effort).
// - Another model of the same vendor, for the session's model: where its vendor session goes
//   on from turn to turn (all but Codex in Read only, which starts a new one every turn, as
//   exec resume takes no --sandbox), its next turn resumes the
//   same vendor session with the new model named (claude --resume ID --model, codex exec
//   resume ID --model, Antigravity session/resume then its model set, Grok Build -r ID
//   --model). The new model is sent that whole conversation again, and a prompt cache is
//   kept per model, so nothing of it is cached for the new one: the first turn reads it all.
//   ELU writes no summary of it.
// - Another vendor, for the session's model: that vendor session cannot go on, so the next
//   turn starts a new one. It is given the chat (the owner's messages, the bots' replies, his
//   ! commands), the Task, the project's notes, and, as a handoff, what the model before it
//   replied in this session (lib/runner.mjs handoffParts). The old model's own steps and
//   reasoning stay in its vendor session.
// - A bot, whatever the change: each of its turns starts from the chat (a working bot's
//   vendor session is not kept from one run to the next), so nothing is read again but the
//   chat it reads every time. Another vendor is still a handoff the owner confirms.
// - With Auto model on (lib/auto-model.mjs), a model or an effort the owner picks for the
//   session's model wins: Auto model is off for the session from then on, the model it runs
//   on now included, and the chat's line says so. A bot's change leaves it on.
import { CAPS, VENDOR_NAMES } from './vendors.mjs';
import { modelEfforts, vendorEfforts } from './bot-models.mjs';
import { changeSettings, lock } from './state.mjs';
import { refuse } from './util.mjs';
import { botModelProblem, getBot, saveBot, sessionBots } from './bots.mjs';
import { checkModel, modelName, setSessionModel } from './models.mjs';
import { isPeerRun } from './modes.mjs';
import { LINES, autoOn } from './auto-model.mjs';

const CHANGES_MAX = 200;
// One more line of ELU's in the session's chat, of the 200 newest it keeps.
const keepLine = (task, text, at) => { task.agentChanges = [...(Array.isArray(task.agentChanges) ? task.agentChanges : []), { at, text }].slice(-CHANGES_MAX); };
// Takes Auto model off a session, with the effort its plans and edits ran with. The owner's
// own effort (leadEffort) was never touched by it. Which conversation each model had
// (autoSessions) goes too: turns go on in the session's one conversation from here, so it is
// stale by the time Auto model is on again (setSessionAuto forgets it the same way). True
// when it was on.
function endAuto(task) {
  if (!autoOn(task)) return false;
  delete task.auto; delete task.autoEffort; delete task.autoSessions; return true;
}
// Keeps one line of ELU's in a session's chat, as each change of an agent does, whether or
// not a turn holds the session: the line that says Auto model was turned on.
export function noteChange(repo, taskId, text) {
  const at = new Date().toISOString();
  changeSettings(repo, taskId, task => { if (text) keepLine(task, text, at); });
}
// A model the owner gave the session by a path that keeps no line of its own (/model typed
// on his other computer) wins over Auto model as any pick of his does: it is off, and the
// chat says so. name: the model as the chat names it. Returns whether Auto model was on.
export function pickedOverAuto(repo, taskId, name) {
  const at = new Date().toISOString(); let was = false;
  changeSettings(repo, taskId, task => { was = endAuto(task); if (was) keepLine(task, LINES.picked(name), at); });
  return was;
}
// A saved effort as the vendor takes it, or null for one none of its models offers. A new
// choice is held to its own model's efforts (changeAgent, effortProblem).
export const effortOf = (vendor, effort) => typeof effort === 'string' && vendorEfforts(vendor).includes(effort) ? effort : null;
// What is said of an effort that model (or, for none, its vendor) does not take: the ones it does.
export function effortProblem(vendor, model = null) {
  const takes = modelEfforts(vendor, model), who = (model && modelName(model)) || VENDOR_NAMES[vendor] || vendor;
  return takes.length ? `Effort on ${who} is one of: ${takes.join(', ')}.` : `${who} has no effort setting.`;
}
const ownModel = value => value && typeof value === 'object' && !Array.isArray(value) && CAPS[value.vendor] && (value.model == null || typeof value.model === 'string') ? value : null;

// A bot as it runs in this session: the model and effort the owner gave it here (botModels),
// else as it is saved. A bot moved to a vendor other than Claude Code starts no helpers.
export function sessionBot(task, bot) {
  const own = bot ? ownModel(task?.botModels?.[bot.name]) : null;
  if (!own) return bot;
  const { model: _model, effort: _effort, ...rest } = bot, effort = effortOf(own.vendor, own.effort);
  return { ...rest, vendor: own.vendor, ...(own.model ? { model: own.model } : {}), ...(effort ? { effort } : {}), ...(own.vendor !== 'claude' ? { subagents: null } : {}) };
}
// The effort the session's model runs with in this session, on this vendor, or null for the vendor's own.
export const leadEffort = (task, vendor) => effortOf(vendor, task?.leadEffort);

// What a change is: 'none', 'effort' (alone), 'model' (another of the same vendor), 'vendor'.
export function changeKind(from, to) {
  if (from.vendor !== to.vendor) return 'vendor';
  if ((from.model ?? null) !== (to.model ?? null)) return 'model';
  return (from.effort ?? null) !== (to.effort ?? null) ? 'effort' : 'none';
}
// The one line said before a model change is saved; null for an effort alone, which needs none.
// bot: the bot's name, null for the session's model. from and to: the models as the chat names them.
// fresh: the session's model starts a new vendor session every turn here (Codex in Read only:
// exec resume takes no --sandbox), so another model of it reads nothing more than the chat.
export function changeWarning(kind, { bot = null, from, to, fresh = false }) {
  if (kind === 'model' && !bot && fresh) return `${to} starts its next turn from this chat, as every turn here does: nothing more is read.`;
  if (kind === 'model') return bot ? `@${bot} starts each turn from the chat, so ${to} takes over with nothing to read again.` : `${to} reads this session's conversation again on its next turn: the first turn is slower and costs more.`;
  if (kind === 'vendor') return bot ? `Handoff: ${to} takes over @${bot} from its next turn, from this session's chat.` : `Handoff: ${to} starts a new conversation, given this chat, the replies so far and the Task, not the steps taken to make them.`;
  return null;
}
// The chat's line for a change: "Model of @lead: Fable 5.2 → Opus 5.5", "Effort of GPT-5.5:
// low → high". who: @name or the model's name. model, effort: [before, after] as shown, or null.
// later: a turn was running, so the change starts with the next. every: saved for every session.
export function changeLine({ who, model = null, effort = null, later = false, every = false }) {
  const parts = model ? [`Model of ${who}: ${model[0]} → ${model[1]}`, ...(effort ? [`effort ${effort[0]} → ${effort[1]}`] : [])] : effort ? [`Effort of ${who}: ${effort[0]} → ${effort[1]}`] : [];
  if (!parts.length) return null;
  return `${parts.join(', ')}${every ? ', in every session' : ''}${later ? '. It applies from the next turn.' : ''}`;
}
// What a bot's change for every session saves with the bot: the model and the effort the owner
// changed now, each alone, so one he gave it for this session only stays this session's. With
// neither changed (every session alone), the bot as this session runs it. saved: the bot as it
// is saved; here: as this session ran it (sessionBot); to: as chosen. Each { vendor, model, effort }.
export function everyBot(saved, here, to) {
  const model = here.vendor !== to.vendor || (here.model ?? null) !== (to.model ?? null), effort = (here.effort ?? null) !== (to.effort ?? null), all = !model && !effort;
  const vendor = model || all ? to.vendor : saved.vendor;
  return { vendor, model: (model || all ? to.model : saved.model) ?? null, effort: effortOf(vendor, effort || all ? to.effort : saved.effort) };
}
// Whether a turn holds the session now.
export function turnRunning(repo, taskId) {
  let release; try { release = lock(repo, `task-${taskId}`); } catch (error) { if (String(error.message).includes('holds this lock')) return true; throw error; }
  release(); return false;
}
// Saves a change to an agent of the session. bot: a bot's name, or null for the session's
// model. to: { vendor, model, effort } as chosen (model and effort null for the vendor's own).
// every: a bot's change is saved with the bot, for every session (everyBot); this session
// keeps the bot as chosen where that is not how it is saved. line(later): the chat's line,
// given whether a turn was running. Returns { later, line }.
export function changeAgent(repo, taskId, { bot = null, to, every = false, line = () => null }) {
  const vendor = to?.vendor, model = to?.model == null || to.model === '' ? null : String(to.model).trim();
  if (!CAPS[vendor]) refuse(`Choose a supported vendor: ${String(vendor ?? '').slice(0, 20)}.`);
  const effort = to.effort == null ? null : modelEfforts(vendor, model).includes(to.effort) ? to.effort : refuse(effortProblem(vendor, model));
  if (every && !bot) refuse('Every session is for a bot. /model default <name> sets what new sessions start with.');
  const later = turnRunning(repo, taskId), text = line(later), at = new Date().toISOString();
  const noted = task => { if (text) keepLine(task, text, at); };
  if (bot) {
    const problem = botModelProblem(vendor, model); if (problem) refuse(problem);
    const owned = task => {
      if (isPeerRun(task.origin)) refuse("A teammate's question keeps the agents it started with.");
      if (!sessionBots(task).includes(bot)) refuse(`@${bot} is not in this session.`);
    };
    // The bot's saved model changes only once the session is known to have it.
    let after = null;
    if (every) {
      let own = null; changeSettings(repo, taskId, task => { owned(task); own = task.botModels?.[bot] ?? null; });
      const saved = getBot(bot) ?? refuse(`There is no bot named ${bot}.`);
      after = everyBot(saved, sessionBot({ botModels: { [bot]: own } }, saved), { vendor, model, effort });
      saveBot({ ...saved, ...after, ...(after.vendor !== saved.vendor ? { subagents: null } : {}) });
    }
    changeSettings(repo, taskId, task => {
      owned(task);
      const rest = task.botModels && typeof task.botModels === 'object' && !Array.isArray(task.botModels) ? { ...task.botModels } : {}; delete rest[bot];
      const kept = after && changeKind(after, { vendor, model, effort }) === 'none' ? rest : { ...rest, [bot]: { vendor, ...(model ? { model } : {}), ...(effort ? { effort } : {}) } };
      task.botModels = Object.keys(kept).length ? kept : undefined;
      noted(task);
    });
    return { later, line: text };
  }
  checkModel({ vendor, model });
  // The model first: one this session cannot take refuses the change before its effort is kept.
  setSessionModel(repo, taskId, { vendor, model });
  // His pick is the session's model from here on: Auto model no longer picks one for it.
  changeSettings(repo, taskId, task => { task.leadEffort = effort ?? undefined; endAuto(task); noted(task); });
  return { later, line: text };
}
// The words of /agent change after the agent's name: model <name...>, effort <level> and
// --every-session, in any order. A model may be named by several words (opus 5.5): they run
// to the next keyword. Returns { model: words or null, effort, every }.
export const CHANGE_USAGE = 'Use /agent change <name> [model <model>] [effort <level>] [--every-session].';
export function changeWords(words) {
  const out = { model: null, effort: null, every: false };
  for (let at = 0; at < words.length;) {
    const word = words[at].toLowerCase();
    if (word === '--every-session' && !out.every) { out.every = true; at += 1; continue; }
    if (word === 'effort' && out.effort === null && words[at + 1] && !KEYWORDS.has(words[at + 1].toLowerCase())) { out.effort = words[at + 1].toLowerCase(); at += 2; continue; }
    if (word === 'model' && out.model === null) {
      let end = at + 1; while (end < words.length && !KEYWORDS.has(words[end].toLowerCase())) end += 1;
      if (end === at + 1) refuse(CHANGE_USAGE);
      out.model = words.slice(at + 1, end); at = end; continue;
    }
    refuse(CHANGE_USAGE);
  }
  return out;
}
const KEYWORDS = new Set(['model', 'effort', '--every-session']);
