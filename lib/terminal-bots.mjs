// The Bots tab: its list rows and its dialogs, and the @name that sends a message to a bot.
// The terminal hands in its own dialogs, so nothing here touches the screen.
import { BOT_COLORS, botColor, botVendors, botEfforts, botNameProblem, botModelProblem, botServers, botServersProblem, botRoomProblem, botWorks, getBot, listBots, pickBotColor, saveBot, removeBot, botRuns, botShadows, SCHEDULE_MAX } from './bots.mjs';
import { botModels, matchModels, ownEffort } from './bot-models.mjs';
import { botScheduleProblem, botScheduleSpec } from './bot-schedules.mjs';
import { claudeServers } from './mcp.mjs';
import { VENDOR_NAMES } from './vendors.mjs';
import { botHere } from './models.mjs';
import { ink, fitWords, wrapText } from './terminal-visuals.mjs';

export const NO_BOTS = 'No bots yet. A bot is a model with instructions you write once and use in any chat. Press n to make one.';
// Text in whole words; nothing when there is no room for a couple of them.
const words = (text, room) => room >= Math.min(text.length, Math.max(16, text.split(' ', 1)[0].length + 1)) ? fitWords(text, room) : '';

// When a bot runs by itself, as /schedule reads it: "weekdays 9:00". The saved text when it
// can no longer be read, and null when the bot has no schedule.
const scheduleText = bot => botScheduleSpec(bot)?.label ?? bot.schedule ?? null;
// "elu and github": names in a sentence.
const listed = names => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? '';
// What is said of MCP servers a bot names that Claude Code does not have, or null for none.
const notSetUp = names => names.length ? `${listed(names)} ${names.length > 1 ? 'are' : 'is'} not set up in Claude Code yet.` : null;
const onlyClaude = vendor => `MCP servers reach Claude runs only. This bot runs on ${vendor}.`;

// Who picks a model or an effort the bot does not name: its vendor's own command line.
const own = vendor => `${VENDOR_NAMES[vendor] ?? vendor}'s own`;
// A bot's model and effort as its page names them, never the word default. named(bot) is
// the name a session shows that model by; for a bot that names no model it is the model
// the bot's latest run reported, or null before one did. An effort the bot does not name
// is the one the vendor's model list gives that model. Where a value was never read, the
// row says who picks it.
export const botModelText = (bot, named = () => null) => named(bot) ?? bot.model ?? own(bot.vendor);
export function botEffortText(bot) {
  if (bot.effort) return bot.effort;
  return botEfforts(bot.vendor).length ? ownEffort(bot.vendor, bot.model) ?? own(bot.vendor) : 'no setting';
}
// The model a bot's helpers run on, by the name a session shows that model by, or none.
export const botSubagentsText = (bot, named = () => null) => bot.subagents ? named({ vendor: 'claude', model: bot.subagents }) ?? bot.subagents : 'none';
// One row per bot: @name in its colour, what it runs on (vendor, model by name, effort when it names
// one), its helpers' model, its schedule or that it works when written to, its MCP servers
// (two names, then +N), whether it shadows, whether teammates can use it, then what it is for.
// A bot whose vendor is not installed here shows what it runs on here instead (botHere).
export function botLines(bots, width, colour, named = () => null) {
  if (!bots.length) return wrapText(NO_BOTS, width - 1).map(line => ink(` ${line}`, 'muted', colour));
  const column = Math.max(...bots.map(bot => bot.name.length)) + 3;
  return bots.map(bot => {
    const mcp = bot.mcp ?? [], servers = mcp.length ? `mcp ${mcp.slice(0, 2).join(' ')}${mcp.length > 2 ? ` +${mcp.length - 2}` : ''}` : null;
    const here = botHere(bot), on = [here === bot ? bot.vendor : `${here.vendor} here`, named(here) ?? here.model, here.effort ? `${here.effort} effort` : null].filter(Boolean).join(' · ');
    const helpers = here.subagents ? `${botSubagentsText(here, named)} helpers` : null, works = scheduleText(bot) ?? (bot.works ? 'works when written to' : null);
    const runs = fitWords([on, helpers, works, servers, botShadows(bot) ? 'shadows' : null, bot.shared ? 'teammates can use it' : null].filter(Boolean).join(' · '), width - column), about = words(bot.about, width - column - runs.length - 2);
    return ink(`@${bot.name}`.padEnd(column), botColor(bot), colour, true) + ink(runs, 'text', colour) + (about ? ink(`  ${about}`, 'muted', colour) : '');
  });
}
// "@sec @docs +2": the bots in a chat, as many whole names as fit, for the message box's label.
export function botNames(names, room = 28) {
  const shown = [];
  for (const name of names) {
    const rest = names.length - shown.length - 1, text = [...shown, `@${name}`].join(' ') + (rest ? ` +${rest}` : '');
    if (shown.length && text.length > room) break;
    shown.push(`@${name}`);
  }
  return shown.join(' ') + (shown.length < names.length ? ` +${names.length - shown.length}` : '');
}
// A message that starts with @name, where name is a saved bot: the bot and the text for it.
// null when the first word is not a bot, so the message goes where it went before.
export function botMessage(text, bots) {
  const match = /^@([A-Za-z][A-Za-z0-9-]{0,29})(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  const bot = match && bots.find(row => row.name === match[1].toLowerCase());
  return bot ? { bot, text: (match[2] ?? '').trim() } : null;
}

// What the page of a bot says under its rows: where its schedule runs, the MCP servers that
// will not reach it, and what it was saved to do that no row shows: its helpers, that it
// may merge pull requests, that it speaks after each turn. servers are the names Claude
// Code has.
export function botNotes(bot, servers) {
  const missing = bot.mcp.filter(name => !servers.includes(name)), here = botHere(bot);
  return [
    here === bot ? null : `${VENDOR_NAMES[bot.vendor] ?? bot.vendor} is not installed here, so this bot runs on ${VENDOR_NAMES[here.vendor] ?? here.vendor}${here.model ? ` (${here.model})` : ''}.`,
    bot.subagents ? botWorks(bot) ? "Its helpers work under the session's permissions, as the bot does." : 'Its helpers start only when the bot works. Give it a schedule to make it work.' : null,
    botScheduleSpec(bot) ? `Runs by itself in each session it is in. /bots schedule off ${bot.name} stops it in one session.` : botScheduleProblem(bot.schedule),
    bot.mcp.length && bot.vendor !== 'claude' ? onlyClaude(bot.vendor) : null,
    missing.length ? `${notSetUp(missing)}${missing.includes('elu') ? ` npx -y @elu-labs/cli --offer=promo connects ${missing.length > 1 ? 'elu' : 'it'}: it signs you up, or in, adds ELU to your web app and connects your AI tools.` : ''}` : null,
    bot.merge ? 'It may merge pull requests. Ask for approval mode still asks you before each merge.' : null,
    bot.shadow ? botShadows(bot) ? SHADOW_NOTE : 'This bot works in its sessions, so it does not speak after each turn.' : null,
  ].filter(Boolean);
}

const SCHEDULE_HINT = 'When this bot runs by itself. Empty means it never does.';
// What a bot saved to speak after each turn does, as its page says it.
const SHADOW_NOTE = 'After a turn that changes no files it reads that turn and says what it would challenge. It reads only, and it still reviews each change.';
const SCHEDULES = [{ name: 'every 1h', note: 'each hour' }, { name: 'daily 9:00', note: 'every day at 9:00' }, { name: 'weekdays 9am', note: 'Monday to Friday at 9:00' }];
const serversHint = vendor => `The MCP servers this bot may use, by the names claude mcp list shows. Separate several with commas or spaces. Empty means none.${vendor === 'claude' ? '' : `\n${onlyClaude(vendor)}`}`;

// The dialogs, built on the terminal's own: prompt (one line), listDialog (rows), editSetting
// (the instructions editor), yes (a confirm) and setMessage (the status line). root gives
// the open project's folder, whose Claude Code MCP servers are offered with the owner's own.
// named: the name a bot's model is shown by (see botModelText).
export function botDialogs({ prompt, listDialog, editSetting, yes, setMessage, colour, root = () => null, named = () => null }) {
  const tone = (value, name = 'text', bold = false) => ink(value, name, colour, bold);
  const first = value => fitWords(String(value ?? '').split('\n').find(line => line.trim()) ?? '', 48) || 'none';
  // The vendor list is skipped when there is one vendor, the effort list when the vendor has
  // no such setting. Each gives undefined when it is closed with Esc.
  async function pickVendor(current = null) {
    const vendors = botVendors();
    if (vendors.length === 1) return vendors[0];
    const picked = await listDialog('Runs on', vendors.map(vendor => tone(vendor.padEnd(8), 'text', true) + tone(VENDOR_NAMES[vendor], 'muted')), { selected: Math.max(0, vendors.indexOf(current)) });
    return picked ? vendors[picked.index] : undefined;
  }
  // The first choice names no effort: the vendor's own, with the level when it is known.
  async function pickEffort(vendor, current = null, model = null) {
    const efforts = botEfforts(vendor);
    if (!efforts.length) return null;
    const theirs = ownEffort(vendor, model);
    const picked = await listDialog('Effort', [tone(theirs ? `${theirs} · ${own(vendor)}` : own(vendor)), ...efforts.map(effort => tone(effort))], { selected: efforts.indexOf(current) + 1 });
    return picked ? picked.index ? efforts[picked.index - 1] : null : undefined;
  }
  // The colour a bot's name shows in. The first choice names none: one is picked at random.
  async function pickColor(current = null) {
    const picked = await listDialog('Color', [tone('random'.padEnd(8), 'text', true) + tone('one no other bot has, while there is one', 'muted'), ...BOT_COLORS.map(color => tone(color, color, true))], { selected: BOT_COLORS.indexOf(current) + 1 });
    return picked ? picked.index ? BOT_COLORS[picked.index - 1] : null : undefined;
  }
  // picked: the model the vendor's own choice turned out to be, when a run has reported it.
  const modelHint = (vendor, picked = null) => `A model ${vendor} knows by name. Empty uses ${own(vendor)}${picked ? `: ${picked}` : ''}.`;
  // The Model step checks a name the way the store does, so a name that cannot be saved is
  // refused here and never under the instructions. It lists the names the vendor's own
  // command line reports, narrowed to what is typed. A name that is not listed is asked
  // about once and taken on a second Enter: a list goes stale, and a full model name must
  // stay possible. The saved name is never asked about. A vendor with no known names has
  // no list.
  function modelStep(vendor, saved = '') {
    const models = botModels(vendor), check = text => botModelProblem(vendor, text.trim());
    if (!models.length) return { check };
    const fine = name => !name || name === saved || models.some(row => row.name === name);
    return { check, suggest: text => matchModels(models, text), warn: text => fine(text.trim()) ? null : `${text.trim()} is not a model ${vendor} lists.` };
  }
  // The Schedule step refuses a text /schedule cannot read, one that does not repeat, and
  // one too long for the store, each with the store's own line. It lists three examples.
  function scheduleStep() {
    const long = text => text.trim().replace(/\s+/g, ' ').length > SCHEDULE_MAX ? `Keep the schedule under ${SCHEDULE_MAX} characters, such as every 1h.` : null;
    return { check: text => botScheduleProblem(text) ?? long(text), suggest: text => matchModels(SCHEDULES, text) };
  }
  // The MCP servers step lists the servers Claude Code has, narrowed to the name being
  // typed. Taking one keeps the names before it, and a name already typed is not listed
  // again. A badly formed name is refused here. A name Claude Code does not have is asked
  // about once and taken on a second Enter: the server may be set up later. A saved name is
  // never asked about.
  function serversStep(saved = []) {
    const known = Object.keys(claudeServers(root())).map(name => ({ name, note: '' }));
    const names = text => { try { return botServers(text); } catch { return []; } };
    const step = { check: text => botServersProblem(text), warn: text => notSetUp(names(text).filter(name => !saved.includes(name) && !known.some(row => row.name === name))) };
    if (!known.length) return step;
    return { ...step, suggest: text => {
      const [, head = '', last] = /^(.*[\s,])?([^\s,]*)$/.exec(text), taken = names(head);
      return matchModels(known.filter(row => !taken.includes(row.name)), last).map(row => ({ ...row, value: head + row.name }));
    } };
  }
  // One line, asked again with the reason above it until the save is taken. Esc changes nothing.
  async function line(title, body, value, save, options = {}) {
    for (let note = ''; ;) {
      const answer = await prompt(title, note + body, value, options);
      if (answer === null) return;
      try { save(answer.trim()); return; } catch (error) { note = `${error.message}\n\n`; value = answer; }
    }
  }
  // n or + New bot: a name, where it runs, its model and effort, when it runs by itself, its
  // MCP servers and its colour, then its instructions. A bot made here works when it is
  // written to; what it does with the work is in its instructions.
  async function create() {
    // A full store is said before anything is asked, not after the instructions are written.
    const full = botRoomProblem(); if (full) throw new Error(full);
    const name = (await prompt('New bot', 'Lowercase letters, digits or -, starting with a letter.\nYou write @name to ask it.', ''))?.trim().replace(/^@/, '');
    if (!name) return null;
    // A name the store would refuse is refused here, before anything else is asked.
    const problem = botNameProblem(name); if (problem) throw new Error(problem);
    const vendor = await pickVendor(); if (vendor === undefined) return null;
    const model = await prompt('Model', modelHint(vendor), '', modelStep(vendor)); if (model === null) return null;
    const effort = await pickEffort(vendor, null, model.trim() || null); if (effort === undefined) return null;
    const schedule = await prompt('Schedule', SCHEDULE_HINT, '', scheduleStep()); if (schedule === null) return null;
    const servers = await prompt('MCP servers', serversHint(vendor), '', serversStep()); if (servers === null) return null;
    // random, the first choice, saves no colour: the store picks one.
    const color = await pickColor(); if (color === undefined) return null;
    let saved = null;
    // A refused save keeps the editor open with the reason, and the status line says it too.
    await editSetting(`Instructions · @${name}`, '', text => { try { saved = saveBot({ name, vendor, model: model.trim() || null, effort, works: true, schedule: schedule.trim() || null, mcp: servers, color, instructions: text }); } catch (error) { setMessage(error.message); throw error; } });
    if (saved) setMessage(`Made @${name}. Write @${name} in a session to ask it.`);
    return saved;
  }
  async function remove(name) {
    if (!await yes(`Remove @${name}`, 'Its name and instructions are deleted.', 'y/N')) return false;
    removeBot(name); setMessage(`Removed @${name}.`); return true;
  }
  // Enter on a bot: each row changes one thing and saves it.
  async function open(name) {
    const row = (label, value) => tone(label.padEnd(14), 'muted') + tone(value);
    for (let selected = 0; ;) {
      const bot = getBot(name); if (!bot) return;
      const save = (change, options) => saveBot({ ...bot, ...change }, options), runs = saved => setMessage(`@${saved.name} runs on ${botRuns(saved)}.`);
      const rows = [tone('Name'.padEnd(14), 'muted') + tone(bot.name, botColor(bot), true), row('Runs on', bot.vendor), row('Model', first(botModelText(bot, named))), row('Effort', botEffortText(bot)), row('Schedule', first(scheduleText(bot))), row('MCP servers', first(bot.mcp.join(', '))), row('About', first(bot.about)), row('Instructions', first(bot.instructions)), tone('Teammates can use it  ', 'muted') + tone(bot.shared ? 'yes' : 'no'), tone('Remove')];
      // Color sits just above Remove, the last row.
      const colorRow = rows.length - 1; rows.splice(colorRow, 0, tone('Color'.padEnd(14), 'muted') + tone(botColor(bot), botColor(bot), true));
      const picked = await listDialog(`Bot @${bot.name}`, rows, { selected, notes: botNotes(bot, Object.keys(claudeServers(root()))) });
      if (!picked) return;
      selected = picked.index;
      // A change the store refuses is said in the status line, and the bot stays open as it was.
      try {
        if (selected === colorRow) {
          const color = await pickColor(botColor(bot));
          if (color !== undefined) { const saved = save({ color: color ?? pickBotColor(listBots().filter(row => row.name !== bot.name), { not: botColor(bot) }) }); setMessage(`@${saved.name} is ${saved.color} now.`); }
          continue;
        }
        if (selected === 0) await line(`Rename @${bot.name}`, 'Lowercase letters, digits or -, starting with a letter.', bot.name, value => {
          const next = value.replace(/^@/, ''); if (next === bot.name) return;
          const problem = botNameProblem(next, { previous: bot.name }); if (problem) throw new Error(problem);
          save({ name: next }, { previous: bot.name }); name = next; setMessage(`@${bot.name} is now @${next}.`);
        });
        else if (selected === 1) {
          // A model and an effort belong to their vendor, so a new vendor starts with its own.
          // Helpers start on claude only, so a saved helpers model goes with the old vendor.
          const vendor = await pickVendor(bot.vendor);
          if (vendor && vendor !== bot.vendor) runs(save({ vendor, model: null, effort: null, subagents: null }));
        } else if (selected === 2) await line('Model', modelHint(bot.vendor, bot.model ? null : named(bot)), bot.model ?? '', value => runs(save({ model: value || null })), modelStep(bot.vendor, bot.model ?? ''));
        else if (selected === 3) {
          if (!botEfforts(bot.vendor).length) { setMessage(`${bot.vendor} has no effort setting.`); continue; }
          const effort = await pickEffort(bot.vendor, bot.effort, bot.model);
          if (effort !== undefined) runs(save({ effort }));
        } else if (selected === 4) await line('Schedule', SCHEDULE_HINT, bot.schedule ?? '', value => {
          const saved = save({ schedule: value || null });
          setMessage(saved.schedule ? `@${saved.name} runs by itself ${scheduleText(saved)}.` : `@${saved.name} does not run by itself.`);
        }, scheduleStep());
        else if (selected === 5) await line('MCP servers', serversHint(bot.vendor), bot.mcp.join(', '), value => {
          const saved = save({ mcp: value });
          setMessage(saved.mcp.length ? `@${saved.name}'s MCP servers: ${saved.mcp.join(', ')}.` : `@${saved.name} has no MCP servers.`);
        }, serversStep(bot.mcp));
        else if (selected === 6) await line('About', `One line on what @${bot.name} is for. Empty uses the first line of its instructions.`, bot.about, value => { save({ about: value }); setMessage('Saved.'); });
        else if (selected === 7) await editSetting(`Instructions · @${bot.name}`, bot.instructions, text => save({ instructions: text }));
        else if (selected === 8) { const saved = save({ shared: !bot.shared }); setMessage(saved.shared ? `Teammates can use @${bot.name}.` : `Only you can use @${bot.name}.`); }
        else if (await remove(bot.name)) return;
      } catch (error) { setMessage(error.message); }
    }
  }
  return { create, open, remove };
}
