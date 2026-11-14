// When a bot runs by itself. A bot's schedule is text in the words /schedule takes, such as
// "every 1h" or "weekdays 9am". It repeats; a single date is not a bot's schedule.
// The schedule is on in every session whose chat lists the bot, from the moment the bot is
// added there or written to. Whether it is on in one session is kept with that session and
// never in the bot, so turning it off in one session leaves the others as they are, and
// editing the bot turns nothing back on.
import fs from 'node:fs';
import path from 'node:path';
import { atomic, noSymlinks, personalDirectory, readJson, refuse } from './util.mjs';
import { parseWhen, nextRun, dateText, untilText, listSchedules, runDue, renewScheduler, uninstallScheduler } from './schedules.mjs';
import { refreshAwake } from './awake.mjs';
import { readTask, taskDir, waitLock } from './state.mjs';
import { registeredProjects } from './projects.mjs';
import { pendingRequests } from './workspace.mjs';
import { readBoard, sessionClosed } from './kanban.mjs';
import { enqueue, startConductor } from './conductor.mjs';
import { botScheduled, botWorks, getBot, listBots, needBot } from './bots.mjs';
import { isPeerRun } from './modes.mjs';

const REPEATS = "A bot's schedule repeats. Write every 1h, daily 9:00 or weekdays 9am.";
// What is wrong with a bot's schedule text, or null. Empty means the bot has no schedule.
export function botScheduleProblem(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  let spec; try { spec = parseWhen(value); } catch (error) { return error.message; }
  return !spec || spec.kind === 'once' ? REPEATS : null;
}
// The schedule as /schedule reads it ({ kind, ..., label }), or null when the bot has none
// or its text can no longer be read. Never throws.
export function botScheduleSpec(bot) {
  const value = String(bot?.schedule ?? '').trim();
  if (!value || botScheduleProblem(value)) return null;
  try { return parseWhen(value); } catch { return null; }
}

// A session's bot schedules live beside its record, in a file of their own: a running turn
// holds the record and saves it whole, and the owner must be able to turn a schedule off
// while the bot is at work. One row per bot: { on, schedule, nextRunAt, lastRunAt,
// lastRequestId, runs, note }. schedule is the bot's text when the row was counted, so a
// changed schedule is counted again from now.
const stateFile = (repo, id) => path.join(taskDir(repo, id), 'bot-schedules.json');
function readState(repo, id) {
  try { const value = readJson(stateFile(repo, id)); return value?.bots && typeof value.bots === 'object' && !Array.isArray(value.bots) ? value.bots : {}; }
  catch { return {}; }
}
const writeState = (repo, id, bots) => atomic(stateFile(repo, id), { version: 1, bots });
// The open app and the login item both tick, and the owner's switch can land between a
// tick's read and its write: one lock for all of them.
function locked(run, attempts = 200) {
  const release = waitLock({ state: personalDirectory() }, 'bot-schedules', attempts);
  try { return run(); } finally { release(); }
}
// first: the bot just joined the session, so its first run is due now. since is when it
// joined: a message the owner writes to it after that is its start instead.
const row = (bot, spec, now, old = null, { first = false } = {}) => ({ on: old?.on !== false, schedule: bot.schedule, nextRunAt: (first ? now : nextRun(spec, now)).toISOString(), lastRunAt: old?.lastRunAt ?? null, lastRequestId: old?.lastRequestId ?? null, runs: old?.runs ?? 0, note: null, ...(first ? { first: true, since: now.toISOString() } : {}) });
// When each bot of a session was last written to, by the owner or by its schedule:
// { name: time }. A message with no readable time counts as old as the session.
function askedAt(task) {
  const asked = {};
  for (const value of Array.isArray(task?.messages) ? task.messages : []) {
    if (typeof value?.to !== 'string' || value.from) continue;
    const name = value.to.replace(/^@/, ''), at = Number.isFinite(Date.parse(value.at)) ? value.at : Number.isFinite(Date.parse(task.createdAt)) ? task.createdAt : new Date(0).toISOString();
    if (!asked[name] || Date.parse(at) > Date.parse(asked[name])) asked[name] = at;
  }
  return asked;
}
// Whether a bot that has no row in a session yet starts there at once: not when the owner
// already wrote to it there, which was its start. Unknown (a row read by an older version) is no.
const startsAtOnce = (task, name) => Boolean(task?.asked) && !task.asked[name] && task.botChat !== name;
const BUSY = 'The session was busy.', ASKING = 'The session was waiting for your answer.', WHEN_FREE = 'Starts when the session is free.';
// The bots the owner put in a session's chat. A session saved with no list reviews with
// @reviewer, but nobody added a bot to it, so no schedule runs there.
const chatList = task => Array.isArray(task?.bots) ? task.bots : [];
// A bot's schedule runs in its session's mode. A session that edits the owner's checkout in
// place needs Full access for every turn, so its bots' schedules wait while it has less.
const inPlace = task => (task?.place?.kind ?? task?.place) === 'here' && task?.permissions !== 'full';
export const IN_PLACE = "This session edits your checkout in place, which needs Full access. Its bots' schedules run here while it has Full access.";
const scheduledText = label => `Scheduled run (${label}).`;
const RUN_NOW = 'Run now (asked with /bots run).';

// What the tick needs of each session of a project. A record is parsed again only after it
// changes: the open app asks every 30 seconds and the login item every minute, each in
// every project. What was read is kept in one small file, so a new process reads only the
// records that changed since.
const seenFile = () => path.join(personalDirectory(), 'bot-schedule-sessions.json');
let seen = null, changed = false;
function sessions(repo) {
  if (!seen) { try { seen = new Map(Object.entries(readJson(seenFile()).files)); } catch { seen = new Map(); } }
  const folder = path.join(repo.state, 'tasks'); noSymlinks(folder);
  const rows = [], found = new Set();
  for (const id of fs.existsSync(folder) ? fs.readdirSync(folder) : []) {
    if (!/^[1-9][0-9]*$/.test(id)) continue;
    const file = path.join(folder, id, 'task.json');
    try {
      const stat = fs.lstatSync(file), sig = `${stat.ino}:${stat.size}:${stat.mtimeMs}`, hit = seen.get(file);
      found.add(file);
      // A row read by an earlier version has no mode: read again.
      if (hit?.sig === sig && 'permissions' in hit.row) { rows.push(hit.row); continue; }
      const task = readTask(repo, id), times = [...(task.runs ?? []), ...(task.messages ?? [])].map(value => Date.parse(value.at)).filter(Number.isFinite);
      // runs holds only the latest activity: enough for sessionClosed to tell an archived session.
      const slim = { id: task.id, state: task.state, createdAt: task.createdAt, runs: times.length ? [{ at: new Date(Math.max(...times)).toISOString() }] : [], messages: [], bots: chatList(task), peer: isPeerRun(task.origin), place: task.place ?? null, permissions: task.permissions ?? null, botChat: task.botChat ?? null, asked: askedAt(task) };
      seen.set(file, { sig, row: slim }); changed = true; rows.push(slim);
    } catch { /* A record that cannot be read runs no schedule. */ }
  }
  // A session that was deleted leaves the file.
  for (const file of seen.keys()) if (path.dirname(path.dirname(file)) === folder && !found.has(file)) { seen.delete(file); changed = true; }
  return rows;
}
function keepSeen() {
  if (!changed) return;
  try { atomic(seenFile(), { version: 1, files: Object.fromEntries(seen) }); changed = false; } catch { /* Read again next time. */ }
}
// Queues one turn for the bot in the session, or returns why it does not: a sentence for
// the owner. busy: a turn the schedule starts gives way to a session that is at work.
function queueRun(repo, task, bot, entry, at, pending, text, { busy = true } = {}) {
  if (inPlace(task)) return IN_PLACE;
  if (busy && ['running', 'preparing'].includes(task.state)) return BUSY;
  // A question to the owner stays open: a run would put its own result in its place.
  if (busy && task.state === 'needs_input') return ASKING;
  const last = pending.find(value => value.scheduled && value.bot === bot.name && value.continuationTaskId === task.id && value.state !== 'done');
  if (last) return `The last run is ${last.state}.`;
  const request = enqueue(repo.root, text, { continuationTaskId: task.id, bot: bot.name, scheduled: true, priority: 1 });
  Object.assign(entry, { lastRunAt: at.toISOString(), lastRequestId: request.id, runs: (entry.runs ?? 0) + 1, note: null });
  return null;
}
const requests = repo => { try { return pendingRequests(repo.root); } catch { return []; } };

// Whether this process has asked for the login item since it started.
let installed = false;
// Queues a turn for every bot whose schedule is due, in every session of every project.
// A bot that joins a session runs there at once, then on its schedule; where the owner
// already wrote to it, that was its start. A first run that finds the session busy stays
// due and is tried on every tick until the session is free. A computer that
// slept through several runs gets one, then the next time is counted from now. A bot that
// was removed, or whose schedule can no longer be read, queues nothing. install: the login
// item's installer, asked for when a schedule is first on (the app passes it; the login
// item itself does not). Returns how many turns were queued; never throws.
export function runBotSchedules(now = new Date(), { start = startConductor, install = null } = {}) {
  let fired = 0, waiting = false;
  try {
    // A bot that works with no schedule never runs by itself: the tick does not see it.
    const bots = new Map(listBots().filter(botScheduled).map(bot => [bot.name, bot]));
    if (!bots.size) return 0;
    let on = 0, fresh = 0;
    locked(() => {
      for (const repo of registeredProjects()) {
        let rows = [], board = null, pending = null;
        try { rows = sessions(repo); } catch { continue; }
        for (const task of rows) {
          const names = task.bots.filter(name => bots.has(name));
          if (task.peer || inPlace(task) || !names.length && !fs.existsSync(stateFile(repo, task.id))) continue;
          try {
            const state = readState(repo, task.id); let dirty = false, closed = null;
            // A bot that left the chat counts from the start when it comes back; its off switch stays.
            for (const [name, entry] of Object.entries(state)) if (!names.includes(name) && entry?.nextRunAt) { entry.nextRunAt = null; dirty = true; }
            for (const name of names) {
              const bot = bots.get(name), spec = botScheduleSpec(bot);
              if (!spec) continue;
              let entry = state[name];
              if (!entry || entry.schedule !== bot.schedule || !Number.isFinite(Date.parse(entry.nextRunAt))) {
                // New here, or back after it left: it starts now. A changed schedule counts again from now.
                const first = entry ? entry.on !== false && entry.schedule === bot.schedule : startsAtOnce(task, name);
                entry = state[name] = row(bot, spec, now, entry, { first }); dirty = true; if (entry.on) fresh++;
              }
              if (entry.on === false) continue;
              on++;
              if (!(Date.parse(entry.nextRunAt) <= now.getTime())) continue;
              // An archived session runs nothing; the time still moves on, so bringing it back does not start a run at once.
              if (closed === null) { try { board ??= readBoard(repo); closed = sessionClosed(board, task); } catch { closed = false; } }
              // The owner wrote to the bot after it joined: that was its start.
              const first = entry.first === true, begun = first && Date.parse(task.asked?.[name]) >= Date.parse(entry.since);
              if (!closed && !begun) {
                let skipped; try { skipped = queueRun(repo, task, bot, entry, now, pending ??= requests(repo), scheduledText(spec.label)); } catch (error) { skipped = error.message; }
                // A first run waits for the session, tick after tick; a later one gives way until its next time.
                if (first && [BUSY, ASKING].includes(skipped)) { if (entry.note !== WHEN_FREE) { entry.note = WHEN_FREE; dirty = true; } continue; }
                if (!skipped) fired++;
                else { waiting = true; entry.note = first ? null : `Skipped ${dateText(now)}: ${skipped}`; }
              } else if (first) entry.note = null;
              delete entry.first; delete entry.since;
              entry.nextRunAt = nextRun(spec, now).toISOString(); dirty = true;
            }
            if (dirty) writeState(repo, task.id, state);
          } catch { /* This session is tried again on the next tick. */ }
        }
      }
      keepSeen();
    }, 20);
    if (install && on && (fresh || !installed)) { installed = true; try { install(); } catch { /* Schedules still run while ELU is open. */ } }
  } catch { /* The next tick tries again. */ }
  // A run that is still queued may be waiting for a conductor that is not there.
  if (fired || waiting) { try { start(); } catch { /* The next queued message starts it. */ } }
  return fired;
}
// Whether a bot's schedule is on in some session, so the login item is kept while one is.
// It only reads. An archived session still counts: a new message brings it back.
export function botSchedulesOn() {
  try {
    const bots = new Map(listBots().filter(bot => botScheduleSpec(bot)).map(bot => [bot.name, bot]));
    if (!bots.size) return false;
    // A project that cannot be read does not hide a schedule that is on in another.
    return registeredProjects().some(repo => { try { return sessions(repo).some(task => !task.peer && !inPlace(task) && task.bots.some(name => bots.has(name) && readState(repo, task.id)[name]?.on !== false)); } catch { return false; } });
  } catch { return false; }
}
// Whether any schedule is on, a task's or a bot's. The login item is there exactly then.
export function schedulesOn() { return listSchedules().some(row => row.enabled) || botSchedulesOn(); }
// What the login item runs every minute (elu schedule tick): the bots that have a schedule,
// then the schedules made with /schedule. fired: how many turns it queued. last: set when no
// schedule is on any more, so the login item goes with the last one while ELU is closed too.
// It removes the login item, which on macOS ends this very run: the caller calls it after
// everything else. It asks again as it does: a schedule saved meanwhile keeps the login item.
// item: where the login item is and how it is unloaded, for tests.
export function scheduleTick(now = new Date(), { start = startConductor, item = {} } = {}) {
  // A login item an older version wrote is brought up to date first: what this run starts has to outlive it.
  try { renewScheduler(item); } catch { /* The next run tries again. */ }
  const fired = runBotSchedules(now, { start }) + runDue(now, { start });
  refreshAwake();
  return { fired, last: schedulesOn() ? null : () => uninstallScheduler({ ...item, own: true, wanted: schedulesOn }) };
}

// One bot's schedule in one session, for the screen: null when the bot has no schedule.
// here: the bot is in this session's chat. on: it runs by itself here. label: the schedule
// as /schedule would say it, or null when its text cannot be read.
export function botScheduleIn(repo, task, name, now = new Date()) {
  let bot = null; try { bot = getBot(name); } catch { /* An unreadable bots file shows no schedule. */ }
  if (!botScheduled(bot)) return null;
  const spec = botScheduleSpec(bot), here = chatList(task).includes(bot.name), entry = task ? readState(repo, task.id)[bot.name] ?? null : null;
  const on = Boolean(spec) && here && entry?.on !== false && !inPlace(task), counted = Boolean(entry) && entry.schedule === bot.schedule && Number.isFinite(Date.parse(entry.nextRunAt));
  // What the next tick does with a session it has not counted yet: the bot starts at once
  // when it is new here or back after it left, and one interval from now otherwise.
  let joins = false;
  if (on && !counted) {
    if (entry) joins = entry.schedule === bot.schedule;
    else { let full = task; if (!Array.isArray(task.messages)) { try { full = readTask(repo, task.id); } catch { full = null; } } joins = Boolean(full) && startsAtOnce({ asked: askedAt(full), botChat: full.botChat ?? null }, bot.name); }
  }
  const next = on ? counted ? entry.nextRunAt : (joins ? now : nextRun(spec, now)).toISOString() : null;
  // starting: its first run here has not been queued yet.
  return { name: bot.name, label: spec?.label ?? null, here, on, off: entry?.on === false, starting: on && (counted ? entry.first === true : joins), nextRunAt: next, lastRunAt: entry?.lastRunAt ?? null, note: inPlace(task) && here ? IN_PLACE : entry?.note ?? null };
}
// "@elu every 1h · next Tue Nov 10 19:04", "@elu every 1h · off in this session": one
// line per scheduled bot of a session, for /bots.
export function botScheduleLines(repo, task, now = new Date()) {
  return chatList(task).map(name => botScheduleIn(repo, task, name, now)).filter(Boolean).map(value => {
    const state = !value.label ? 'its schedule cannot be read' : value.off ? 'off in this session' : value.starting ? 'starts when the session is free' : value.on ? `next ${dateText(new Date(value.nextRunAt))}` : 'not running here';
    return `@${value.name} ${value.label ?? ''} · ${state}${value.note && !value.off && !value.starting ? ` · ${value.note}` : ''}`.replace(/\s+/g, ' ');
  });
}
// The scheduled bots of each session given, for the screen: { [session id]: [botScheduleIn
// value, ...] }, holding only the sessions that have one in their chat.
export function botSchedulesShown(repo, tasks, now = new Date()) {
  let names = []; try { names = listBots().filter(botScheduled).map(bot => bot.name); } catch { return {}; }
  const shown = {};
  for (const task of names.length ? tasks ?? [] : []) {
    if (isPeerRun(task.origin)) continue;
    let values = []; try { values = chatList(task).filter(name => names.includes(name)).map(name => botScheduleIn(repo, task, name, now)).filter(value => value?.here); } catch { /* A schedule that cannot be read shows nothing. */ }
    if (values.length) shown[task.id] = values;
  }
  return shown;
}
// One of those values in a few words, for the title line of its session: "@elu every 1h ·
// next in 52m", "@elu every 1h · off in this session".
export function botScheduleBrief(value, now = Date.now()) {
  const soon = value.on && Date.parse(value.nextRunAt) - now < 60000;
  const state = !value.label ? 'its schedule cannot be read' : value.off ? 'off in this session' : value.starting ? 'starts when the session is free' : soon ? 'starts within a minute' : value.on ? `next ${untilText(value.nextRunAt, now)}` : 'not running here';
  return `@${value.name} ${value.label ?? ''} · ${state}`.replace(/\s+/g, ' ');
}
// run: the owner asked for a run now, so a bot that works with no schedule is told how it starts.
function member(repo, taskId, name, { run = false } = {}) {
  const bot = needBot(name);
  if (!botScheduled(bot)) refuse(run && botWorks(bot) ? `@${bot.name} has no schedule to run. Write @${bot.name} and what to do, and it works.` : `@${bot.name} has no schedule. Give it one in the Bots tab.`);
  const task = readTask(repo, taskId);
  if (isPeerRun(task.origin)) refuse("Bots join your own sessions, not a teammate's question.");
  if (!chatList(task).includes(bot.name)) refuse(`@${bot.name} is not in this session. /bots add ${bot.name} adds it.`);
  return { bot, task };
}
// Turns a bot's schedule off or on in one session. Off stays off there until it is turned
// on again; on counts the next run from now.
export function setBotSchedule(repo, taskId, name, on, now = new Date()) {
  const { bot, task } = member(repo, taskId, name), spec = botScheduleSpec(bot);
  if (on && !spec) refuse(`The schedule of @${bot.name} cannot be read. ${botScheduleProblem(bot.schedule) ?? REPEATS}`);
  if (on && inPlace(task)) refuse(IN_PLACE);
  locked(() => {
    const state = readState(repo, task.id), old = state[bot.name] ?? null;
    state[bot.name] = on ? { ...row(bot, spec, now, old), on: true } : { ...(old ?? { schedule: bot.schedule, nextRunAt: null, lastRunAt: null, lastRequestId: null, runs: 0 }), on: false, note: null };
    writeState(repo, task.id, state);
  });
  return botScheduleIn(repo, task, bot.name, now);
}
// Runs a scheduled bot now, once, whether or not its schedule is on in this session. Its
// next scheduled time does not move. It waits for the session's current turn to end.
export function runBotNow(repo, taskId, name, now = new Date(), { start = startConductor } = {}) {
  const { bot, task } = member(repo, taskId, name, { run: true });
  locked(() => {
    const state = readState(repo, task.id), entry = state[bot.name] ??= { on: true, schedule: null, nextRunAt: null, lastRunAt: null, lastRequestId: null, runs: 0, note: null };
    const skipped = queueRun(repo, task, bot, entry, now, requests(repo), RUN_NOW, { busy: false });
    if (skipped) refuse(skipped === IN_PLACE ? skipped : `@${bot.name} is already on its way here. ${skipped}`);
    writeState(repo, task.id, state);
  });
  start();
  return true;
}
// The session that is a bot's own chat in a project: the one a message written to the bot
// in Chats continues. An archived one is left alone, and the next message starts another.
// starting is true while the first message of a new one is still on its way to a session.
export function botChatSession(repo, name) {
  let board = null; try { board = readBoard(repo); } catch { /* Nothing counts as archived. */ }
  const own = sessions(repo).filter(task => task.botChat === name && !(board && sessionClosed(board, task))).sort((a, b) => Number(b.id) - Number(a.id))[0];
  if (own) return { id: own.id, starting: false };
  return requests(repo).some(value => value.botChat === true && value.bot === name && !value.continuationTaskId && value.state !== 'done') ? { id: null, starting: true } : null;
}
