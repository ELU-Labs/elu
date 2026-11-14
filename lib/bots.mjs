// Bots: a bot is a name, a vendor, an optional model and effort, and instructions. The
// owner uses it in any chat, in any project. It reads and answers; it never edits. Bots
// live in the personal folder (bots.json), not in a project. In a chat a bot answers a
// message written to it and reviews the session's edits; a shared bot also answers
// teammates. Five bots come with the app (BUILT_IN_BOTS); the owner makes the rest.
// A bot may also run by itself: schedule says when, in the words /schedule takes, and mcp
// names the owner's Claude Code MCP servers it uses (lib/bot-schedules.mjs runs it). Such
// a bot works: on its schedule and when written to it may edit files and run commands,
// within the session's permissions, and it does not review. works says the same of a bot
// with no schedule: it works when written to and never by itself. subagents names the
// model of the helpers such a bot hands work to (Claude Code only); a working bot that
// names none may start helpers on its own model (botHelpers). color is the colour its
// name and the bar beside its replies show in, on this machine only.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_BOTS, LAST_BOT, RETIRED_BOTS, REVISED_BOTS } from './default-bots.mjs';
import { atomic, personalDirectory, readJson } from './util.mjs';
import { CAPS, EFFORTS, OWN_MODEL, VENDORS, VENDOR_EFFORTS } from './vendors.mjs';

export const BOT_NAME = /^[a-z][a-z0-9-]{0,29}$/;
// Effort levels a bot may ask for. Not every vendor takes each one: see botEfforts.
export { EFFORTS };
// Instructions hold a whole skill file. Long ones run to about 100,000 characters.
export const BOTS_MAX = 30, ABOUT_MAX = 120;
// How many bots one chat holds.
export const CHAT_BOTS_MAX = 5;
// The colours a bot can show in: tones of the terminal's theme (PALETTE in
// lib/terminal-visuals.mjs). You are blue in every chat, so blue is not one of them, and
// orange is the session's model's unless the owner gives it to a bot.
export const BOT_COLORS = Object.freeze(['violet', 'gold', 'pink', 'lime', 'aqua', 'rose', 'orange']);
// The ones a bot is given when the owner names none.
const PICKED = BOT_COLORS.filter(color => color !== 'orange');
// What saveBot would say about a colour on its own, or null. None is fine: one is picked.
export function botColorProblem(value) {
  if (value == null || value === '') return null;
  return BOT_COLORS.includes(String(value).trim().toLowerCase()) ? null : `A bot's color is one of: ${BOT_COLORS.join(', ')}.`;
}
// Names that already mean something after an @ or in a chat.
const RESERVED = ['team', 'general', 'you', 'me', 'all', 'everyone', 'here', 'channel', 'model'];
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,79}$/;
// What saveBot would say about a model on its own, or null when it is fine. No model is the
// vendor's default. The Model step asks this before it goes on, so the line never shows
// under another field.
export function botModelProblem(vendor, value) {
  if (value == null || value === '') return null;
  if (!MODEL.test(String(value).trim())) return 'A model name has no spaces: up to 80 letters, digits, dots, colons, slashes or dashes.';
  return CAPS[vendor]?.model === 'none' ? `${vendor} does not take a model.` : null;
}

// What saveBot would say about a bot's subagents on their own, or null. The value is the
// model its helpers run on, checked like a bot's own model; none means no helpers. Helpers
// start on Claude Code only.
export function botSubagentsProblem(vendor, value) {
  if (value == null || value === '') return null;
  return vendor === 'claude' ? botModelProblem(vendor, value) : `Subagents start on claude only. This bot runs on ${vendor}.`;
}

const fail = message => { throw new Error(message); };
// The bots the app comes with (lib/default-bots.mjs), in the order they are listed. Each is
// saved into bots.json once and is an ordinary bot from then on: the owner can edit or
// remove it, and a removed one does not come back.
export const BUILT_IN_BOTS = Object.freeze(DEFAULT_BOTS.map(bot => Object.freeze({ vendor: 'claude', model: null, effort: null, shared: false, schedule: null, mcp: [], merge: false, ...bot })));
export const botsFile = () => path.join(personalDirectory(), 'bots.json');
// Vendors a bot can run on: the ones that may answer read-only.
export const botVendors = () => VENDORS.filter(vendor => CAPS[vendor]?.reviewer);
export const botEfforts = vendor => VENDOR_EFFORTS[vendor] ?? [];
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
// The MCP servers a bot names, each once: a list, or names split by commas or spaces. They
// are the names claude mcp list shows.
export const BOT_MCP_MAX = 8, SCHEDULE_MAX = 60;
const SERVER = /^[A-Za-z0-9_.-]{1,64}$/;
export function botServers(value) {
  const names = [...new Set((Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/)).map(name => String(name ?? '').trim()).filter(Boolean))];
  const bad = names.find(name => !SERVER.test(name));
  if (bad) fail(`${bad.slice(0, 40)} is not an MCP server name. Use the names claude mcp list shows.`);
  if (names.length > BOT_MCP_MAX) fail(`A bot uses up to ${BOT_MCP_MAX} MCP servers.`);
  return names;
}
// What saveBot would say about a bot's MCP servers, or null when they are fine.
export function botServersProblem(value) { try { botServers(value); return null; } catch (error) { return error.message; } }

const plainName = value => String(value ?? '').trim().replace(/^@/, '');
// What is wrong with a name on its own, or null.
function nameProblem(name) {
  if (!BOT_NAME.test(name)) return 'Name a bot with 1 to 30 lowercase letters, digits or -, starting with a letter.';
  return RESERVED.includes(name) ? `${name} is taken. Choose another name.` : null;
}
// Returns the bot in its saved shape, or throws with a line the owner can act on.
function clean(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('A bot needs a name and instructions.');
  const name = plainName(input.name), problem = nameProblem(name);
  if (problem) fail(problem);
  const vendor = String(input.vendor ?? 'claude');
  if (!botVendors().includes(vendor)) fail(`A bot runs on one of: ${botVendors().join(', ')}.`);
  const model = input.model == null || input.model === '' ? null : String(input.model).trim();
  const modelProblem = botModelProblem(vendor, input.model); if (modelProblem) fail(modelProblem);
  const effort = input.effort == null || input.effort === '' ? null : String(input.effort).trim().toLowerCase();
  if (effort !== null && !botEfforts(vendor).includes(effort)) fail(botEfforts(vendor).length ? `Effort on ${vendor} is one of: ${botEfforts(vendor).join(', ')}.` : `${vendor} has no effort setting.`);
  const instructions = String(input.instructions ?? '').trim();
  if (!instructions) fail('Write what the bot does in its instructions.');
  const about = oneLine(input.about || instructions.split('\n').find(line => line.trim()) || '').slice(0, ABOUT_MAX);
  // When it runs by itself, as typed (botScheduleProblem in lib/bot-schedules.mjs reads it), or null.
  const schedule = oneLine(input.schedule) || null;
  if (schedule && schedule.length > SCHEDULE_MAX) fail(`Keep the schedule under ${SCHEDULE_MAX} characters, such as every 1h.`);
  const subagents = input.subagents == null || input.subagents === '' ? null : String(input.subagents).trim();
  const helpersProblem = botSubagentsProblem(vendor, subagents); if (helpersProblem) fail(helpersProblem);
  // A saved colour this build does not know reads as none, so the bot stays listed; saveBot
  // refuses one the owner types.
  const given = String(input.color ?? '').trim().toLowerCase(), color = BOT_COLORS.includes(given) ? given : null;
  return { name, vendor, model, effort, about, instructions, shared: input.shared === true, schedule, mcp: botServers(input.mcp), merge: input.merge === true, works: input.works === true, subagents,
    shadow: input.shadow === true, color };
}
const usable = bot => { try { clean(bot); return true; } catch { return false; } };

// builtIn in the file names the built-in bots this store was already offered, so each is
// added once and a removed one stays removed.
// defaults numbers the set of built-in bots the store was last brought up to.
const DEFAULTS = 2;
const write = (bots, offered) => atomic(botsFile(), { version: 1, defaults: DEFAULTS, builtIn: offered, bots });
const fingerprint = text => createHash('sha256').update(String(text ?? '').trim()).digest('hex').slice(0, 16);
// A store from before this set, brought up to it: a bot an earlier build came with and the
// owner never edited is removed when this build no longer has it, and gets this build's
// instructions when it does.
function upgraded(rows, now) {
  return rows.filter(row => !(RETIRED_BOTS[row?.name] && RETIRED_BOTS[row.name] === fingerprint(row.instructions))).map(row => {
    const old = REVISED_BOTS[row?.name], next = old?.text === fingerprint(row?.instructions) ? BUILT_IN_BOTS.find(bot => bot.name === row.name) : null;
    return next ? { ...row, instructions: next.instructions, about: row.about === old.about ? next.about : row.about, model: row.model ?? next.model, updatedAt: now } : row;
  });
}
// The order bots are listed in: the ones the app comes with as BUILT_IN_BOTS has them,
// then the owner's own by name, and LAST_BOT after all of them.
const place = name => { const at = BUILT_IN_BOTS.findIndex(bot => bot.name === name); return name === LAST_BOT ? BUILT_IN_BOTS.length + 1 : at < 0 ? BUILT_IN_BOTS.length : at; };
const inOrder = (a, b) => place(a.name) - place(b.name) || a.name.localeCompare(b.name);
// The store as saved: its rows as they are, and the built-in names it was offered. A
// built-in bot the store was never offered is added on this read, unless a saved row has
// its name or there is no room for it; either way it is not offered again.
function store() {
  let value = null;
  try { value = readJson(botsFile()); }
  catch (error) { if (error.code !== 'ENOENT') fail(`${botsFile()} could not be read. Fix it or remove it.`); }
  const saved = Array.isArray(value?.bots) ? value.bots : [], offered = Array.isArray(value?.builtIn) ? value.builtIn.filter(name => typeof name === 'string') : [];
  const now = new Date().toISOString(), current = value?.defaults === DEFAULTS, rows = current ? saved : upgraded(saved, now);
  const fresh = BUILT_IN_BOTS.filter(bot => !offered.includes(bot.name));
  if (current && !fresh.length) return { rows, offered };
  const room = Math.max(0, BOTS_MAX - rows.filter(usable).length);
  const added = fresh.filter(bot => !rows.some(row => row?.name === bot.name)).slice(0, room).map(bot => ({ ...bot, createdAt: now, updatedAt: now }));
  const next = { rows: [...rows, ...added], offered: [...offered, ...fresh.map(bot => bot.name)] };
  // A folder that cannot be written still lists them, and the next read tries again.
  try { write(next.rows, next.offered); } catch { /* Listing never fails on a save. */ }
  return next;
}
const listed = rows => rows.filter(usable).map(bot => ({ ...clean(bot), createdAt: bot.createdAt ?? null, updatedAt: bot.updatedAt ?? null })).sort(inOrder);
// Every saved bot, in the order above. A row that is no longer valid is left out, never fixed up.
export function listBots() { return listed(store().rows); }
// The colour a bot shows in. One saved before bots had colours shows in the colour the
// built-in of its name comes with, or in a pick from its name that never changes.
export function botColor(bot) {
  if (BOT_COLORS.includes(bot?.color)) return bot.color;
  const name = String(bot?.name ?? '');
  return BUILT_IN_BOTS.find(row => row.name === name)?.color ?? PICKED[parseInt(fingerprint(name).slice(0, 8), 16) % PICKED.length];
}
// A colour for a bot the owner gave none: at random, from the ones the fewest other bots
// show in, so one no other bot has while there is one. not: a colour to leave out, so
// asking again gives another.
export function pickBotColor(bots = listBots(), { not = null } = {}) {
  const open = PICKED.filter(color => color !== not), count = color => bots.filter(bot => botColor(bot) === color).length;
  const least = Math.min(...open.map(count)), pool = open.filter(color => count(color) === least);
  return pool[Math.floor(Math.random() * pool.length)];
}
export function getBot(name) { const wanted = String(name ?? '').replace(/^@/, ''); return listBots().find(bot => bot.name === wanted) ?? null; }
// The saved bot, or the line the owner sees when a message or a chat names one that is not saved.
export function needBot(name) { return getBot(name) ?? fail(`There is no bot named ${String(name ?? '').replace(/^@/, '').slice(0, 40)}. Open the Bots tab to make one.`); }
// The bots of one chat: saved names, each once, at most five.
export function chatBots(names) {
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) fail('Bots are a list of names.');
  const bots = [...new Set(names.map(name => needBot(name).name))];
  if (bots.length > CHAT_BOTS_MAX) fail(`A chat holds up to ${CHAT_BOTS_MAX} bots.`);
  return bots;
}
// Teammates' questions run on a vendor that can keep them inside the shared files (CAPS.peer).
export const canShare = vendor => CAPS[vendor]?.peer === true;
// The shared bot a teammate asked for. One that is gone, not shared, or on a vendor that
// cannot answer teammates gets the same line, so a teammate learns nothing more about it.
export function sharedBot(name) {
  let bot = null; try { bot = getBot(name); } catch { /* An unreadable file shares nothing. */ }
  if (!bot?.shared || !canShare(bot.vendor)) fail(`The bot ${String(name ?? '').replace(/^@/, '').slice(0, 40)} is no longer shared with teammates.`);
  return bot;
}
// What saveBot would say about a name, or null when it is fine: a name that is not allowed,
// is reserved, or belongs to another bot. previous is the bot's saved name when it is being
// renamed. With no previous the name is for a new bot, so any saved bot's name is taken.
export function botNameProblem(value, { previous = null } = {}) {
  const name = plainName(value);
  return nameProblem(name) ?? (name !== plainName(previous) && listBots().some(bot => bot.name === name) ? `A bot named ${name} exists.` : null);
}
// What saveBot would say when there is no room for one more bot, or null. A new bot asks
// this before its first question.
export const botRoomProblem = (bots = listBots()) => bots.length >= BOTS_MAX ? `You can keep up to ${BOTS_MAX} bots. Remove one first.` : null;

// Creates a bot, or changes one. previous is the saved name when it is being renamed.
export function saveBot(input, { previous = null } = {}) {
  const unknown = botColorProblem(input?.color); if (unknown) fail(unknown);
  const bot = clean(input), { rows, offered } = store(), bots = listed(rows), old = previous ?? bot.name, current = bots.find(row => row.name === old);
  if (bot.shared && !canShare(bot.vendor)) fail(`A bot on ${bot.vendor} cannot be shared: teammates' questions run on ${botVendors().filter(canShare).join(', ')} only.`);
  if (previous !== null && !current) fail(`There is no bot named ${previous}.`);
  const taken = botNameProblem(bot.name, { previous: old });
  if (taken) fail(taken);
  const full = current ? null : botRoomProblem(bots); if (full) fail(full);
  // No colour given: a saved bot keeps the one it shows in, and a new bot gets one picked.
  const color = bot.color ?? (current ? botColor(current) : pickBotColor(bots));
  const now = new Date().toISOString(), saved = { ...bot, color, createdAt: current?.createdAt ?? now, updatedAt: now };
  write([...bots.filter(row => row.name !== old), saved].sort(inOrder), offered);
  return saved;
}
export function removeBot(name) {
  const { rows, offered } = store(), bots = listed(rows), wanted = String(name ?? '').replace(/^@/, '');
  if (!bots.some(bot => bot.name === wanted)) return false;
  write(bots.filter(bot => bot.name !== wanted), offered); return true;
}
// "claude · opus · high effort": what a bot runs on, for a list row.
export function botRuns(bot) { return [bot.vendor, bot.model, bot.effort ? `${bot.effort} effort` : null].filter(Boolean).join(' · '); }
// The bots teammates may use, as they are told about them: a name and what it is for.
export function sharedBots() { return listBots().filter(bot => bot.shared && canShare(bot.vendor)).map(bot => ({ name: bot.name, about: bot.about })); }

// The bots of a session. A list is the owner's choice, and an empty one means no bots. A
// session saved without the field (one from before every review was a bot's, or one made
// by a path that passes none) has @reviewer while a bot of that name is saved.
export function sessionBots(task) {
  if (Array.isArray(task?.bots)) return task.bots;
  return getBot('reviewer') ? ['reviewer'] : [];
}
// The key a bot runs under in a session (task.runs[].role, task.sessions, task.activeRole),
// so @reviewer is never taken for the reviewer that older sessions saved under that name.
export const botKey = name => `bot:${name}`;
export const botOfKey = key => typeof key === 'string' && key.startsWith('bot:') ? key.slice(4) : null;
// What a bot is doing in a running session, for a status row: it answers the message the
// owner just wrote to it, it works when its schedule started it or when it goes on from its
// own reply to edit, and otherwise it reviews. A shadow bot's turn after the agent's is
// shadowing. null when no bot is at work.
export function botWork(task) {
  const bot = botOfKey(task?.activeRole), last = task?.messages?.at(-1);
  if (!bot) return null;
  if (task.shadowing?.bot === bot) return { agent: `@${bot}`, label: 'shadowing' };
  // A review the owner asked for, and the review lines of the loop, are reviewing.
  if (last?.review) return { agent: `@${bot}`, label: 'reviewing' };
  return { agent: `@${bot}`, label: last?.bot === bot || last?.to === `@${bot}` && last.scheduled ? 'working' : last?.to === `@${bot}` ? 'answering' : 'reviewing' };
}
// What a bot runs with: it reads and answers, under the default turn limits (a turn that
// prints nothing for ten minutes stops; lib/turn-limits.mjs) and with no dollar budget of
// its own, plus the model and effort the owner chose.
export function botRole(bot) {
  return { vendor: bot.vendor, access: 'read', network: 'off', commands: [], writablePaths: [], timeoutSeconds: 600, maxCostUsd: null, ...(bot.model ? { model: bot.model } : {}), ...(bot.effort ? { effort: bot.effort } : {}) };
}
// A bot with a schedule works by itself and when written to; one with works on and no
// schedule works when written to, and never by itself. Neither is one of the session's
// reviewers: the other bots review what it changes.
export const botScheduled = bot => Boolean(bot?.schedule);
export const botWorks = bot => bot?.works === true || botScheduled(bot);
export const botReviews = bot => Boolean(bot) && !botWorks(bot);
// A shadow bot is a second pair of eyes on the agent that works in a session: it reviews
// each change as any reviewing bot does, and after a turn that changed no files it reads
// that turn and says what it would challenge. It reads only. A bot that works does its own
// work instead, so it never shadows.
export const botShadows = bot => bot?.shadow === true && !botWorks(bot);
// What a working bot runs with: the limits the project gives its own model (time, dollars,
// commands, paths), on the bot's vendor, model and effort. A vendor that cannot enforce a
// command list or a dollar budget gets none, as a model on that vendor would.
export function botWorkRole(bot, lead, access = 'edit') {
  const { model, ...limits } = lead, caps = CAPS[bot.vendor] ?? {}, edit = access === 'edit';
  return { ...limits, vendor: bot.vendor, access, commands: edit && caps.commands ? lead.commands : [], writablePaths: edit ? lead.writablePaths : [], maxCostUsd: caps.budget ? lead.maxCostUsd : null, ...(bot.model ? { model: bot.model } : {}), ...(bot.effort ? { effort: bot.effort } : {}) };
}
// The model of the helpers a working bot may start in a session with these permissions, or
// null: helpers start on Claude Code, and never in a read-only (locked) session. A bot
// saved with a helpers model leads with helpers on that model. Any other working bot may
// start them on its own model (OWN_MODEL), so its instructions decide whether it does. One
// that may merge pull requests and names no helpers model starts none: a helper runs under
// the deny rules of its bot's turn, and that turn's rules allow a merge.
export const botHelpers = (bot, mode) => bot?.vendor !== 'claude' || mode === 'locked' ? null : bot.subagents || (botWorks(bot) && bot.merge !== true ? OWN_MODEL : null);
// What a bot that has helpers is told in each of its working turns. edit: files of the
// repository may change in this turn. A bot whose helpers run on its own model is told
// only that it can start one, and to do so when it is asked to. full: the turn runs with
// Full access, where a helper is limited to nothing: no kind is the only one, and a helper
// may start helpers of its own.
function helpersNote(model, { edit, full = false }) {
  const kind = full ? 'subagent_type executor is the helper set up for this work' : 'always with subagent_type executor, the only kind there is here';
  const under = `${full ? "Executors work with this session's Full access, as you do." : "Executors work under this session's permissions, as you do, and they cannot start helpers of their own."}${edit ? '' : ' The rule of this turn holds for them too: they read and run commands, and change no file of a repository.'}`;
  if (model === OWN_MODEL) return [
    `You can hand a piece of this work to a helper, and only when the owner's instructions for you, or the message you are answering, ask you to use helpers; otherwise do the work yourself. The Agent tool starts one: ${kind}. An executor runs on the model you run on, starts with nothing but the task you write for it, and reports back to you alone. Check what it returns before you build on it: you answer for the result.`,
    under,
  ].join(' ');
  return [
    `You lead this work, and you do not have to do all of it yourself. The Agent tool starts a helper: ${kind}. Each executor runs on ${model}, starts with nothing but the task you write for it, and reports back to you alone.`,
    'Plan the work first. Hand each piece that can be carried out on its own to an executor, with everything it needs: the goal, the files and folders, what done looks like, and what it must leave alone. Check what each one returns before you build on it: read what it changed and run what proves it. You answer for the result; what an executor did is your work.',
    under,
  ].join(' ');
}
// The owner's instructions for a bot, as every one of its turns carries them.
const brief = bot => `Instructions from the owner for @${bot.name}:\n${bot.instructions}`;
// What the model and a working bot are told about repeating work, in the turns that answer
// the owner, plan or do the work: only the owner makes a schedule, with /schedule.
export const SCHEDULE_NOTE = 'The owner repeats work on a schedule by typing /schedule, a time such as every 3h, and the message (for example /schedule every 3h check the build); each run is a new session with the model, mode (Full access too, when he picks it for the schedule) and bots of the new session form, and you cannot create schedules or cron jobs yourself, so when asked to repeat something, give the owner the exact /schedule line to type.';
// Which of its MCP servers a working bot has in this run. missing are the ones its
// instructions may count on and it starts without.
function serversNote(bot, { on = [], missing = [] } = {}) {
  return [
    on.length ? `MCP servers on for you (tools named mcp__NAME__*): ${on.join(', ')}.` : '',
    missing.length ? bot.vendor === 'claude' ? `These MCP servers are named for you but are not set up in Claude Code on this computer, so you start without them: ${missing.join(', ')}. Say so when your work needs one.` : `MCP servers reach a bot that runs on claude only, so you have none of: ${missing.join(', ')}. Say so when your work needs one.` : '',
  ].filter(Boolean).join(' ');
}
// A working bot's first turn: its schedule started it, or the owner wrote to it. It may
// read, run commands and use its MCP servers as the session's permissions allow; files of
// a repository change in a second turn, in the session's editing workspace. edit is false
// where the session can no longer be edited. ask is true when the owner wrote the message:
// only then may the bot turn its own schedule off or on for this session. helpers: the model
// its executor helpers run on in this turn (botHelpers), or null when it has none.
export function botWorkInstructions(bot, { scheduled = false, label = null, servers = {}, edit = true, ask = false, helpers = null, full = false } = {}) {
  return [
    `You are @${bot.name}, a bot the owner keeps in this session to do work. ${scheduled ? `Nobody wrote the last message of the chat: your schedule${label ? ` (${label})` : ''} started this turn, and the owner may not be here. Do what your instructions say for a run.` : 'The owner wrote the last message of the chat to you. Do what it asks, the way your instructions say.'} The chat so far, and the session's edits when it has any, are in the context below. You never speak for the agent working in this session.`,
    `You may read files, run commands and use your MCP tools as far as this session's permissions allow. ${edit ? 'Do not edit files of a repository in this turn. When files must change, say what you will change and set intent to edit: ELU then prepares the editing workspace of this session and starts you there, and the session\'s other bots review your change. With intent edit, set repository to the Git repository to change, as an absolute path, a path relative to your working directory, or . for the working directory; the Repositories list in the context names the ones in the owner\'s home folder. Otherwise set intent to answer and repository to an empty string.' : 'The edits of this session are published, so nothing more can be changed here: set intent to answer, and say what you would change in a new session.'} Reply in plain text for the owner to read later.`,
    helpers ? helpersNote(helpers, { edit: false, full }) : '',
    serversNote(bot, servers),
    ask ? `The owner may tell you to stop, or to start again, running on your schedule in this session. Only then set schedule to off or on. Otherwise set it to keep.` : '',
    SCHEDULE_NOTE,
    brief(bot),
  ].filter(Boolean).join('\n\n');
}
// The turn that follows intent edit: the bot makes its change where the agent working in
// this session would.
export function botEditInstructions(bot, { servers = {}, helpers = null, full = false } = {}) {
  return [`You are @${bot.name}, a bot the owner keeps in this session to do work. You are now in the editing workspace of this session. Make the change you described in your last message of the chat, and nothing else; the session's goal and the chat are context. Return your result, with an empty comments array and any review responses. The session's other bots review your change before it can be published.`, helpers ? helpersNote(helpers, { edit: true, full }) : '', serversNote(bot, servers), SCHEDULE_NOTE, brief(bot)].filter(Boolean).join('\n\n');
}
// After a review of the bot's own change.
export function botFixInstructions(bot, { helpers = null, full = false } = {}) {
  return [`You are @${bot.name}. Address the review and the failed checks of the change you made in this session. Return one response per review finding with its ID, fixed or disputed, and the reason.`, helpers ? helpersNote(helpers, { edit: true, full }) : '', brief(bot)].filter(Boolean).join('\n\n');
}
// A message the owner wrote to a bot in a session.
export function botChatInstructions(bot) {
  return `You are @${bot.name}, a bot in a chat between the owner and the agent that works in this session, whose entries in the chat are from agent. The owner wrote the last message of the chat to you; the chat so far, and the session's edits when it has any, are in the context below. Answer the owner in plain text and set intent to answer. You read and answer; you never edit files, and you never speak for that agent. ${SCHEDULE_NOTE}\n\n${brief(bot)}`;
}
// A shadow bot's turn. It follows a turn of the agent that works in the session, one that
// changed no files. by names that agent as the chat does: lead for the session's model,
// @name for a bot that works.
export function botShadowInstructions(bot, { by = 'lead' } = {}) {
  const agent = by === 'lead' ? "the session's model, whose entries in the chat are from agent" : `${by}, a bot that works in this session`;
  return [
    `You are @${bot.name}, a bot the owner keeps in this session to shadow the agent that works in it: a second engineer who reads each turn and pushes back. That agent is ${agent}. It just finished a turn that changed no files, and nobody wrote to you. The chat so far, and the session's edits when it has any, are in the context below; the agent's turn is its last entry in the chat.`,
    'Check that turn: read the files of the project it relies on when that helps. Then do one of three things. Challenge what is wrong or risky in it, and say why. Offer a better approach, and say what it gains. Or, when you would do the same, say in one line that you have nothing to add.',
    'Be brief: the most important point first, a few lines in all, no summary of the turn and no praise. The owner and the agent both read your reply in the chat, and the agent reads it on its next turn. Nobody answers you now, so ask no questions. You read and never edit files or run commands, and you never speak for the agent or for the owner. Reply in plain text and set intent to answer.',
    brief(bot),
  ].join('\n\n');
}
// A bot's review of the session's edits. owner: what the owner wrote to this bot about the
// change, when his message started this review (reviewRequest); it guides the review.
// shown: the sentence that says the change is given in part, when the bot's model could not take it whole.
export function botReviewInstructions(bot, { owner = null, shown = null } = {}) {
  // Fix turns run under the session's approved Task, so new work is never a must-fix finding.
  const asked = owner ? `\n\nThe owner wrote this to you about the change. Let it guide this review; the agent fixes or disputes each must_fix finding of yours. Use must_fix only for a defect in this change within the session's approved Task; new work beyond that Task is at most a suggestion, never must_fix:\n${owner}` : '';
  return `Review as @${bot.name}, a bot the owner added to this chat. ${shown ? `Review the supplied diff and changed files. ${shown}` : 'Review the supplied full changed-file contents and diff.'} Put actionable findings in comments. Use must_fix for a blocking defect. Do not execute tools or edit files. Acknowledge whether prior fixes resolved earlier findings.${asked}\n\n${brief(bot)}`;
}
// What the agent that edits is told of the loop after its turn: ELU runs the checks,
// the session's reviewing bots, by name, review the change, and their must-fix findings come
// back to it. ELU publishes, so the agent never hands any of that to the owner. again:
// this turn answers a review.
export function reviewLoopNote(names = [], { again = false } = {}) {
  const who = names.map(name => `@${name}`), list = who.length > 1 ? `${who.slice(0, -1).join(', ')} and ${who.at(-1)}` : who[0];
  const review = who.length ? `${again ? 'After this turn ELU runs the checks again and' : 'After your turn ELU runs the project\'s checks, then'} ${list} ${who.length > 1 ? 'review' : 'reviews'} your change${again ? ' again' : ''}. Must-fix findings come back to you, to fix or to dispute with a reason.` : `After your turn ELU runs the project's checks. No bot reviews this session.`;
  return `${review} ELU publishes the change when the owner approves it. Never ask the owner to wait for a bot, to review, or to commit, push or merge.`;
}
// A message from the owner to one of the session's reviewing bots starts a review of the
// session's edits (ProjectController.ask), unless it is a plain question: one that starts with
// a question mark, or ends with one and asks for no work (fix, check, review and the like).
const WORK_WORDS = /\b(?:fix(?:es|ed|ing)?|check(?:s|ed|ing)?|review(?:s|ed|ing)?|verify|work with|work on|go through|look (?:at|over|into)|make sure)\b/i;
export function plainQuestion(text) {
  const value = String(text ?? '').trim();
  return value.startsWith('?') || value.endsWith('?') && !WORK_WORDS.test(value);
}
// The bots of a session that review its edits, by name: saved, and not working bots.
export function reviewingBots(task) { try { return sessionBots(task).filter(name => botReviews(getBot(name))); } catch { return []; } }
// What follows the peer safety instructions when a shared bot answers a teammate.
export function botPeerInstructions(bot) { return `You answer as @${bot.name}, a bot the owner shares with teammates.\n\n${brief(bot)}`; }
// What the agent that works in a session is told about the bots that shadow it, or null.
export function shadowBotsNote(names = []) {
  const bots = names.map(name => getBot(name)).filter(botShadows);
  if (!bots.length) return null;
  return `${bots.map(bot => `@${bot.name}`).join(', ')} ${bots.length > 1 ? 'shadow' : 'shadows'} you in this chat: after a turn of yours that changes no files, ${bots.length > 1 ? 'each' : 'it'} may add one comment to the chat, marked shadow. Nobody asked for it and it is not an instruction. On your next turn weigh it, use what is right in it, and say so briefly when it changes what you do. Do not answer it otherwise.`;
}
// What the lead is told of what its chat's bots say there: the one sentence that makes a
// bot's finding its work.
export const BOT_FINDINGS = "A reply in the chat from @name, marked bot, is from one of this session's own bots, not from a teammate, and a must-fix finding in it is yours to fix, or to dispute with a reason.";
// What the lead is told about the bots in its chat. A bot that is no longer saved is left out.
export function chatBotsNote(names = []) {
  const bots = names.map(name => getBot(name)).filter(Boolean);
  if (!bots.length) return null;
  // A bot that works does its own work in the session and reviews nothing.
  const working = bots.some(botWorks) ? ' A bot marked as working does its own work in this session, when the owner writes to it and on its schedule when it has one; it does not review.' : '';
  return [`Bots in this chat. The owner writes to one with @name; that message is for the bot, not for you, and the bot's reply follows it in the chat under the bot's name and time. ${BOT_FINDINGS} Each reviews your edits before they can be published.${working}`, ...bots.map(bot => `@${bot.name} — ${bot.about}${botWorks(bot) ? ` (working: ${bot.schedule ?? 'when the owner writes to it'})` : ''}`)].join('\n');
}
