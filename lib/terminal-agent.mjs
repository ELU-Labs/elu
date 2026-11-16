// The page of an agent of a session: its model and its effort, each picked from what its
// vendor offers, and for a bot whether the change is for this session or every one. Built
// on the terminal's own dialogs, as the Bots tab's page is (lib/terminal-bots.mjs), so
// nothing here touches the screen. The change itself is lib/agent-change.mjs.
import { changeKind, changeLine, changeWarning } from './agent-change.mjs';
import { botEfforts } from './bots.mjs';
import { knownEffort } from './bot-models.mjs';
import { VENDOR_NAMES } from './vendors.mjs';
import { ink } from './terminal-visuals.mjs';

// An effort as a row shows it: the level, never where it came from. One the agent does not
// name is the level the vendor's model list gives its model, else the vendor's own.
export function effortText({ vendor, model = null, effort = null }) {
  if (effort) return effort;
  if (!botEfforts(vendor).length) return 'no setting';
  return knownEffort(vendor, model) ?? `${VENDOR_NAMES[vendor] ?? vendor}'s own`;
}
// listDialog, yes, setMessage, colour: the terminal's own. pickModel(current, said): the Model
// picker of /model, a { vendor, model } or null. pickEffort(vendor, current, model): the
// effort list of a bot's page, a level, null for the vendor's own, undefined when closed.
// nameOf(choice): a model as the chat names it. save(agent, to, every, line): saves the
// change and returns { later, line }.
export function agentDialogs({ listDialog, yes, setMessage, colour, pickModel, pickEffort, nameOf, save }) {
  const tone = (value, name = 'text', bold = false) => ink(value, name, colour, bold);
  const row = (label, value) => tone(label.padEnd(14), 'muted') + tone(value);
  // The line the chat keeps, and the one said before a model change, for this change.
  const said = (agent, to, every) => {
    const kind = changeKind(agent, to), names = [nameOf(agent), nameOf(to)];
    // The effort is said when the level changes; each vendor's own level is no change to say.
    const model = kind === 'vendor' || kind === 'model' ? names : null, effort = (agent.effort ?? null) !== (to.effort ?? null) ? [effortText(agent), effortText(to)] : null;
    // The session's own model is named by the model: its new one is said as "Model of this session".
    const who = model && !agent.bot ? 'this session' : agent.who;
    return { kind, warning: changeWarning(kind, { bot: agent.bot, from: names[0], to: names[1], fresh: Boolean(agent.fresh) }), line: later => changeLine({ who, model, effort, later, every }) };
  };
  // Saves a change: one to another vendor only once the owner says yes to the handoff.
  // Returns true when saved, false when nothing changed, null when the handoff was declined.
  async function apply(agent, to, every = false) {
    const { kind, warning, line } = said(agent, to, every);
    if (kind === 'none' && !every) { setMessage(`${agent.who} already runs on ${nameOf(to)}, ${effortText(to)}.`); return false; }
    if (kind === 'vendor' && !await yes(`Hand ${agent.who} to ${nameOf(to)}`, warning, 'Hand it off? [y/N]')) return null;
    const saved = save(agent, to, every, line);
    // The chat keeps the change; another model of the same vendor says under the box what it does.
    setMessage(kind === 'model' && warning ? warning : saved.line ?? `${agent.who} runs on ${nameOf(to)}.`);
    return true;
  }
  // agent: { who (@name, or the model's name), bot (a bot's name, null for the session's
  // model), vendor, model, effort, fresh (lib/agent-change.mjs changeWarning) }. Returns true when a change was saved.
  async function open(agent) {
    let to = { vendor: agent.vendor, model: agent.model ?? null, effort: agent.effort ?? null }, every = false;
    for (let selected = 0; ;) {
      const { warning } = said(agent, to, every);
      const rows = [row('Model', nameOf(to)), row('Effort', effortText(to)), ...(agent.bot ? [row('For', every ? 'every session' : 'this session')] : []), tone('Save'), tone('Cancel')];
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
          const effort = await pickEffort(to.vendor, to.effort, to.model);
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
