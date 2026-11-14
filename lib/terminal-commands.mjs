import { refuse } from './util.mjs';
import { LABELS } from './modes.mjs';
import { BOT_COLORS } from './bots.mjs';

export const COMMANDS = Object.freeze([
  ['new', 'Start a new session', '/new'],
  ['schedule', 'Start a session later or on a schedule', '/schedule [when] [message]'],
  ['sessions', 'Show every session across your projects', '/sessions'],
  ['kanban', 'Show this project’s sessions, and your team’s in the same repository, by column', '/kanban'],
  ['chats', 'Channels, direct messages and threads', '/chats'],
  ['standup', "Ask every open session for an update: yours here and on your other computers, and your teammates' shared ones", '/standup'],
  ['bots', 'Show your bots, keep one in this chat, or stop its schedule here', '/bots [add|remove|run] [name] · /bots schedule [on|off] [name] · /bots color [name] [color|random]'],
  ['projects', 'Show your projects', '/projects'],
  ['takeover', 'Make changes in this window when another ELU window has this project', '/takeover'],
  ['usage', 'Show your accounts and their plan usage', '/usage'],
  ['model', 'Show or choose the model of this session', '/model [name|default <name>|add]'],
  ['agent', 'Add a model to this session as an agent, or take one out', '/agent [add <model>|remove <name>]'],
  ['agents', 'Show who is in this session', '/agents'],
  ['permissions', 'What the model may do this session: ask, auto or full, the folders it may read, and what runs without asking', '/permissions [ask|auto|full|default <mode>|folders add <path>|rules|rules remove N|rules on N]'],
  ['budget', 'What this session has spent; set a spending limit or remove it', '/budget [dollars|off]'],
  ['place', 'Where the new session runs: a new worktree, a branch, or here', '/place [worktree|branch <name>|here]'],
  ['mcp', 'Your Claude Code MCP servers: add one, remove one, or turn one on or off here', '/mcp [add|remove|on|off] [server]'],
  ['changes', 'Show what this session changed, in place of its chat', '/changes'],
  ['chat', 'Go back to this session’s chat', '/chat'],
  ['details', 'Checks, review, and log of this session', '/details'],
  ['publish', 'Review the exact push and draft PR', '/publish'],
  ['stop', 'Stop the running response; your waiting messages then go at once', '/stop [id]'],
  ['rename', 'Rename this session', '/rename [name]'],
  ['archive', 'Archive this session; a new message brings it back', '/archive'],
  ['archived', 'Show or hide archived sessions in the list', '/archived'],
  ['slots', 'Set how many sessions run at once', '/slots [1-16]'],
  ['peers', 'Show teammates and who is online', '/peers'],
  ['invite', 'Add a teammate to this channel, or make a code for someone new', '/invite [@teammate|team]'],
  ['join', 'Join a team; teammates’ messages start sessions in this project', '/join code'],
  ['access', 'What teammates’ messages can do here, and your rules for them', '/access'],
  ['mine', 'Your other computers: a session can start on one with @name', '/mine [@name] · /mine remove @name · /mine auto on|off'],
  ['send', 'Send files or folders from this computer to the session on your other computer', '/send path...'],
  ['leave', 'Leave a team', '/leave [team]'],
  ['remove', 'Remove a teammate from your team (admins)', '/remove @teammate [team]'],
  ['share', 'Share this project with your team', '/share [handle|off|on]'],
  ['setup', 'Optional setup for scripted workflows', '/setup'],
  ['update', 'How to update ELU', '/update'],
  ['help', 'Show commands and examples', '/help'],
  ['quit', 'Close ELU', '/quit'],
].map(([name, description, usage]) => Object.freeze({ name, description, usage })));

// A command needs an argument when its usage names one outside [brackets], such as /join code.
// A usage with several forms, set apart by " · ", needs one only when every form does.
export function needsArgument(command) {
  return command.usage.split(' · ').every(form => form.replace(/\[[^\]]*\]/g, '').trim().split(/\s+/).length > 1);
}
// The command the box starts with, once a space follows its name, or null: its usage then
// shows in the key bar, so no command looks as if it takes nothing.
export function typedCommand(text) {
  const match = /^\/(\S+)\s/.exec(String(text ?? '').trimStart()); if (!match) return null;
  const typed = `/${match[1].toLowerCase()}`, name = ALIASES[typed] ?? typed;
  return COMMANDS.find(command => `/${command.name}` === name) ?? null;
}
// The times /schedule offers first. Each fills in the time; the message follows it.
export const SCHEDULE_PRESETS = Object.freeze([
  ['in 5m', 'once, in 5 minutes'], ['in 1h', 'once, in an hour'], ['in 1d', 'once, this time tomorrow'],
  ['every 1h', 'every hour'], ['every 1d', 'every day at this time'], ['daily 9:00', 'every day at 9:00'], ['weekdays 9am', 'Monday to Friday at 9:00'],
]);
export function commandMatches(text) {
  if (!/^\/[^\s]*$/.test(text)) return [];
  const prefix = text.slice(1).toLowerCase();
  return COMMANDS.filter(command => command.name.startsWith(prefix));
}
// What a command's next word can be, so the command list keeps helping after the name:
// /model shows the models to choose, /mcp on the servers that are off. ctx holds what only
// the app knows, read lazily: models() [{name, vendor, note, current}], servers() {all, on},
// bots() [{name, about, here, scheduled, color}] where here means the bot is in the open
// chat, scheduled that it has a schedule, so it works by itself, and color is the one it shows in.
// invitees() {channel, people: [{name, online}]}: the teammates who can join the open
// channel, or null where no channel is open.
// A vendor's state in one line: what it does here, then why it cannot run yet, if anything.
// A vendor that needs its one-time check gets it by itself, on the owner's next message to it.
export const FIRST_CHECK = 'checked on your next message to it';
export const vendorText = row => [row.support, !row.available ? 'not installed' : row.support === 'not supported yet' ? '' : row.conformant === false && row.version === null ? FIRST_CHECK : !row.supported ? 'not supported' : !row.signedIn ? 'not signed in' : row.conformant === false ? row.fullOnly ? 'Full access only' : FIRST_CHECK : 'ready'].filter(Boolean).join(' · ');
const MODE_TEXT = { ask: "Edits the session's files; asks you for the rest and the internet.", auto: "Edits the session's files; a reviewer model, not you, decides the rest.", full: 'Any file, any command, the internet.' };
function nextWords(command, done, ctx) {
  const word = (value, description, more = false) => ({ word: value, description, more });
  const models = () => { let rows = []; try { rows = ctx.models?.() ?? []; } catch { /* None listed. */ } return rows.map(row => word(row.name, [row.vendor, row.note, row.current ? 'in use' : ''].filter(Boolean).join(' · '))); };
  const modes = () => Object.entries(MODE_TEXT).map(([name, text]) => word(name, `${LABELS[name]}: ${text}`));
  if (command === 'model') {
    if (!done.length) return [...models(), word('default', 'Set the model new sessions start with', true), word('add', 'Add a model by its name')];
    if (done.length === 1 && done[0] === 'default') return models();
    return [];
  }
  // /agent add offers the models /model offers; /agent remove the bots of this session.
  if (command === 'agent' || command === 'agents') {
    if (!done.length) return [word('add', 'Put a model in this session as an agent: add <model> [what it does] [--name NAME]', true), word('remove', 'Take an agent out of this session', true)];
    if (done.length === 1 && done[0] === 'add') return models().map(row => ({ ...row, description: row.description.replace(/ · in use$|^in use$/, '') }));
    if (done.length === 1 && done[0] === 'remove') return bots(ctx).filter(row => row.here).map(row => word(row.name, row.about));
    return [];
  }
  if (command === 'permissions') {
    if (!done.length) return [...modes(), word('default', 'Set the mode new sessions start with', true), word('folders', 'Let the model read another folder this session', true), word('rules', 'What runs without asking: the defaults and your rules')];
    if (done.length === 1 && done[0] === 'default') return modes();
    if (done.length === 1 && done[0] === 'folders') return [word('add', 'Add a folder the model may read this session', true)];
    if (done.length === 1 && done[0] === 'rules') return [word('remove', 'Remove a rule, or turn a default off: remove N', true), word('on', 'Turn a default on again: on N', true)];
    return [];
  }
  if (command === 'place' && !done.length) return [word('worktree', 'A copy of this repo on a new branch'), word('branch', 'This repo on a branch you name', true), word('here', 'This checkout, as it is. Full access only')];
  if (command === 'mcp') {
    if (!done.length) return [word('add', 'Add a server; its key stays out of the chat'), word('remove', 'Remove one of your servers', true), word('on', 'Turn a server on for this project', true), word('off', 'Turn a server off for this project', true)];
    let list = { all: [], on: [] }; try { list = ctx.servers?.() ?? list; } catch { /* None listed. */ }
    if (done.length === 1 && done[0] === 'remove') return list.all.map(name => word(name, ''));
    if (done.length === 1 && ['on', 'off'].includes(done[0])) return list.all.filter(name => list.on.includes(name) === (done[0] === 'off')).map(name => word(name, done[0] === 'on' ? 'off now' : 'on now'));
    return [];
  }
  if (command === 'invite' && !done.length) {
    let open = null; try { open = ctx.invitees?.() ?? null; } catch { /* None listed. */ }
    return [...(open?.people ?? [])].sort((a, b) => Number(b.online) - Number(a.online)).map(row => word(`@${row.name}`, `add to #${open.channel} · ${stateOf(row, row.online ? 'online' : 'offline')}`));
  }
  if (command === 'bots') {
    if (!done.length) return [word('add', 'Keep a bot in this chat', true), word('remove', 'Take a bot out of this chat', true), word('schedule', 'Turn a bot\'s schedule off or on in this session', true), word('run', 'Tell a scheduled bot to work now', true), word('color', 'Give a bot a color, or a new random one', true)];
    if (done.length === 1 && ['add', 'remove'].includes(done[0])) return bots(ctx).filter(row => Boolean(row.here) === (done[0] === 'remove')).map(row => word(row.name, row.about));
    if (done.length === 1 && done[0] === 'schedule') return [word('off', 'Stop it running by itself in this session', true), word('on', 'Let it run by itself here again', true)];
    if (done.length === 1 && done[0] === 'color') return bots(ctx).map(row => word(row.name, row.color ? `${row.color} now` : row.about, true));
    if (done.length === 2 && done[0] === 'color') return [word('random', 'A new one, picked for you'), ...BOT_COLORS.map(color => word(color, color === 'orange' ? 'the color of the session\'s model' : ''))];
    // Only a bot of this chat that has a schedule can be run or switched.
    if (done.length === 1 && done[0] === 'run' || done.length === 2 && done[0] === 'schedule' && ['on', 'off'].includes(done[1])) return bots(ctx).filter(row => row.here && row.scheduled).map(row => word(row.name, row.about));
    return [];
  }
  return [];
}
// Teammates by @name, online first. teammates() gives [{name, online, path, mine, waiting}] without you;
// mine marks another computer of the owner's, which every row calls your computer, never a teammate.
const people = ctx => { let rows = []; try { rows = ctx.teammates?.() ?? []; } catch { /* None listed. */ } return [...rows].sort((a, b) => Number(b.online) - Number(a.online)); };
// What says a peer is another computer of the owner's, or '' for a teammate (no row). One that
// has not marked this computer back yet (waiting) is not his yet, and says it waits.
export const yourComputer = (row, between = ' · ') => !row ? '' : row.waiting ? `your computer${between}waiting for it to confirm` : 'your computer';
// What a row says after a name: whether they are online (on), after the words for another
// computer of the owner's. One that waits says so in place of whether it is online.
const stateOf = (row, on, teammate = '') => !row.mine ? `${teammate}${on}` : row.waiting ? yourComputer(row) : `${yourComputer(row)} · ${on}`;
function teammates(ctx) {
  return people(ctx).map(row => ({ word: `@${row.name}`, description: stateOf(row, row.online ? `online · ${row.path || 'direct'}` : 'offline'), more: true }));
}
const bots = ctx => { try { return ctx.bots?.() ?? []; } catch { return []; } };
const startsWith = (word, partial) => word.startsWith(partial) || (word.startsWith('@') && word.slice(1).startsWith(partial));
export function argumentMatches(text, ctx = {}) {
  const match = /^\/(\S+)\s+([^\n]*)$/.exec(text); if (!match) return [];
  // A time is more than one word, so /schedule matches what is typed as a whole: /schedule in offers in 5m, in 1h and in 1d.
  if (match[1].toLowerCase() === 'schedule') { const typed = match[2].replace(/\s+/g, ' ').toLowerCase(); return SCHEDULE_PRESETS.filter(([when]) => when.startsWith(typed)).map(([when, description]) => ({ word: when, description, more: true, value: `/schedule ${when}` })); }
  const command = match[1].toLowerCase(), words = match[2].split(/\s+/), partial = words.pop().toLowerCase(), done = words;
  return nextWords(command, done, ctx).filter(row => startsWith(row.word.toLowerCase(), partial)).map(row => ({ ...row, value: `/${command} ${[...done, row.word].join(' ')}` }));
}
// Typing @ in Chats > Internal names a teammate: @dev offers @devbox.
export function mentionMatches(text, ctx = {}) {
  const match = /^@([^\s@]*)$/.exec(text); if (!match) return [];
  return teammates(ctx).filter(row => startsWith(row.word, `@${match[1].toLowerCase()}`)).map(row => ({ ...row, value: row.word }));
}
// Typing @ in a session names a saved bot: @se offers @sec.
export function botMatches(text, ctx = {}) {
  const match = /^@([^\s@]*)$/.exec(text); if (!match) return [];
  return bots(ctx).filter(row => row.name.startsWith(match[1].toLowerCase())).map(row => ({ word: `@${row.name}`, description: row.about, more: true, value: `@${row.name}` }));
}
// Typing @ in a session offers the saved bots, the session's model, then teammates; each row says which it is.
// @name is the bot's when a teammate has the same name, so that teammate is not offered
// here: Chats reaches them.
export function sessionMentions(text, ctx = {}) {
  const match = /^@([^\s@]*)$/.exec(text); if (!match) return [];
  const partial = match[1].toLowerCase(), taken = new Set(bots(ctx).map(row => row.name));
  // @model is the session's own model: a message goes back to it after the owner wrote to a bot.
  const model = ctx.model?.() ?? null, own = model && 'model'.startsWith(partial) ? [{ word: '@model', description: `${model} · the model of this session`, more: true, value: '@model' }] : [];
  if (own.length) taken.add('model');
  return [...botMatches(text, ctx), ...own, ...people(ctx).filter(row => !taken.has(row.name) && row.name.toLowerCase().startsWith(partial)).map(row => ({ word: `@${row.name}`, description: stateOf(row, row.online ? 'online' : 'offline', 'teammate · '), more: true, value: `@${row.name}` }))];
}
export function commandWords(text) {
  const words = []; let word = '', quote = null, escaped = false, started = false;
  for (const ch of text) {
    if (escaped) { word += ch; escaped = false; started = true; }
    else if (ch === '\\' && quote !== "'") { escaped = true; started = true; }
    else if (quote) { if (ch === quote) quote = null; else word += ch; }
    else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) { if (started) { words.push(word); word = ''; started = false; } }
    else { word += ch; started = true; }
  }
  if (quote || escaped) refuse('Close the quote or finish the escaped character.');
  if (started) words.push(word); return words;
}
// Free text (what an agent is for, a schedule's message) may hold apostrophes, so it is kept as typed.
const FREE = ['agent', 'agents', 'schedule'];
// Older names keep working.
const ALIASES = { '/tasks': '/sessions', '/close': '/archive' };
export function parseCommand(text) {
  if (!text.trimStart().startsWith('/')) return null;
  const raw = text.trim(), first = raw.split(/\s/, 1)[0], free = COMMANDS.find(command => FREE.includes(command.name) && `/${command.name}` === first.toLowerCase());
  if (free) { const rest = raw.slice(first.length).trim(); return { ...free, args: rest ? rest.split(/\s+/) : [], text: rest }; }
  const [name, ...args] = commandWords(raw);
  const typed = name.toLowerCase(), command = COMMANDS.find(command => `/${command.name}` === (ALIASES[typed] ?? typed));
  if (!command) refuse(`Unknown command: ${name}. Type / to see commands.`);
  return { ...command, args };
}
