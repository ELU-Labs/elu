// The page of an agent of a session: its model and its effort, each picked from what its
// vendor offers, and for a bot whether the change is for this session or every one. Built
// on the terminal's own dialogs, as the Bots tab's page is (lib/terminal-bots.mjs), so
// nothing here touches the screen. The change itself is lib/agent-change.mjs.
import { changeKind, changeLine, changeWarning, everyBot } from './agent-change.mjs';
import { botEfforts } from './bots.mjs';
import { knownEffort } from './bot-models.mjs';
import { VENDOR_NAMES } from './vendors.mjs';
import { ink } from './terminal-visuals.mjs';

// An effort as a row shows it: the level, never where it came from. One the agent does not
// name is the level its vendor runs that model with (own, as its replies' headings show it,
// else the vendor's model list), and only where that is not known here, the vendor's own.
export function effortText({ vendor, model = null, effort = null, own = null }) {
  if (effort) return effort;
  if (!botEfforts(vendor).length) return 'no setting';
  return own ?? knownEffort(vendor, model) ?? `${VENDOR_NAMES[vendor] ?? vendor}'s own`;
}
const sameModel = (a, b) => a.vendor === b.vendor && (a.model ?? null) === (b.model ?? null);
// A choice with the level its vendor runs it with when none is chosen, where the agent knows it.
const withOwn = (agent, value) => ({ ...value, own: (agent.ownOf ? agent.ownOf(value) : sameModel(agent, value) ? agent.own : null) ?? null });
const level = value => value.effort ?? value.own ?? null;
// listDialog, yes, setMessage, colour: the terminal's own. pickModel(current, said): the Model
// picker of /model, a { vendor, model } or null. pickEffort(vendor, current, model, own): the
// effort list of a bot's page, a level, null for the vendor's own, undefined when closed.
// nameOf(choice): a model as the chat names it. save(agent, to, every, line): saves the
// change and returns { later, line }.
export function agentDialogs({ listDialog, yes, setMessage, colour, pickModel, pickEffort, nameOf, save }) {
  const tone = (value, name = 'text', bold = false) => ink(value, name, colour, bold);
  const row = (label, value) => tone(label.padEnd(14), 'muted') + tone(value);
  // The line the chat keeps, and the one said before a model change, for this change. none:
  // nothing changes, here or in what is saved for every session.
  const said = (agent, to, every) => {
    const kind = changeKind(agent, to), names = [nameOf(agent), nameOf(to)];
    // The model is said when it changes. The effort is said when another is chosen and the
    // level changes with it: a vendor's own level on both sides, and the level the agent runs
    // with already, are no change to say.
    const parts = (from, target) => ({ model: sameModel(from, target) ? null : [nameOf(from), nameOf(target)], effort: (from.effort ?? null) !== (target.effort ?? null) && level(from) !== level(target) ? [effortText(from), effortText(target)] : null });
    // For every session the line says what the saved bot gets (lib/agent-change.mjs everyBot),
    // so a model the bot has in this session only is not in it. With the bot saved so already, what this session's gets.
    const bot = every && agent.saved ? parts(withOwn(agent, agent.saved), withOwn(agent, everyBot(agent.saved, agent, to))) : null;
    const { model, effort } = bot?.model || bot?.effort ? bot : parts(agent, withOwn(agent, to));
    // The session's own model is named by the model: its new one is said as "Model of this session".
    const who = model && !agent.bot ? 'this session' : agent.who;
    return { kind, none: !model && !effort, warning: changeWarning(kind, { bot: agent.bot, from: names[0], to: names[1], fresh: Boolean(agent.fresh) }), line: later => changeLine({ who, model, effort, later, every }) };
  };
  // Saves a change: one to another vendor only once the owner says yes to the handoff.
  // Returns true when saved, false when nothing changed, null when the handoff was declined.
  async function apply(agent, to, every = false) {
    const { kind, none, warning, line } = said(agent, to, every);
    if (none) { setMessage(`${agent.bot ? agent.who : 'This session'} already runs on ${nameOf(to)}, ${effortText(withOwn(agent, to))}.`); return false; }
    if (kind === 'vendor' && !await yes(`Hand ${agent.who} to ${nameOf(to)}`, warning, 'Hand it off? [y/N]')) return null;
    const saved = save(agent, to, every, line);
    // The chat keeps the change; another model of the same vendor says under the box what it does.
    setMessage(kind === 'model' && warning ? warning : saved.line ?? `${agent.who} runs on ${nameOf(to)}.`);
    return true;
  }
  // agent: { who (@name, or the model's name), bot (a bot's name, null for the session's
  // model), vendor, model, effort, fresh (lib/agent-change.mjs changeWarning), own (the level
  // its vendor runs that model with when none is chosen, where known; ownOf(choice): the same
  // for a model it could run), saved (a bot as it is saved: { vendor, model, effort }) }.
  // Returns true when a change was saved.
  async function open(agent) {
    let to = { vendor: agent.vendor, model: agent.model ?? null, effort: agent.effort ?? null }, every = false;
    for (let selected = 0; ;) {
      const { warning } = said(agent, to, every);
      const rows = [row('Model', nameOf(to)), row('Effort', effortText(withOwn(agent, to))), ...(agent.bot ? [row('For', every ? 'every session' : 'this session')] : []), tone('Save'), tone('Cancel')];
      const saveRow = rows.length - 2;
      const picked = await listDialog(`Agent ${agent.who}`, rows, { selected, notes: warning ? [warning] : [] });
      if (!picked || picked.index === rows.length - 1) return false;
      selected = picked.index;
      try {
        if (selected === 0) {
          const choice = await pickModel(to, `${agent.who} runs on ${nameOf(to)}.`);
          // A level the new vendor does not offer goes with the old one.
          if (choice) to = { vendor: choice.vendor, model: choice.model ?? null, effort: botEfforts(choice.vendor).includes(to.effort) ? to.effort : null };
        } else if (selected === 1) {
          if (!botEfforts(to.vendor).length) { setMessage(`${VENDOR_NAMES[to.vendor] ?? to.vendor} has no effort setting.`); continue; }
          const effort = await pickEffort(to.vendor, to.effort, to.model, withOwn(agent, to).own);
          if (effort !== undefined) to = { ...to, effort };
        } else if (agent.bot && selected === 2) every = !every;
        else if (selected === saveRow) {
          // A handoff declined leaves the page open as it was.
          const done = await apply(agent, to, every);
          if (done !== null) return done;
        }
      } catch (error) { setMessage(error.message); }
    }
  }
  return { open, apply };
}
