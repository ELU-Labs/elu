import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomic, cleanPath, mkdir, noSymlinks, readJson, refuse } from './util.mjs';
import { isInstalled, BY_HAND } from './install.mjs';
import { waitLock } from './state.mjs';
import { personalDirectory } from './usage.mjs';
import { enqueue, startConductor } from './conductor.mjs';
import { pendingRequests } from './workspace.mjs';
import { MODES, checkMode } from './modes.mjs';
import { checkModel } from './models.mjs';
import { unitArgument, unitEnvironment } from './unit-file.mjs';

// Schedules send a message to a project's lead at set times. Each run is a queued
// request, like a message typed in Tasks, so it ends at "ready" and nothing is pushed.
// A login item checks every minute, so runs happen while the computer is awake even
// with ELU Code closed. Times are the computer's local time.

const FULL_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MIN_EVERY = 15, MAX_EVERY = 7 * 24 * 60;
export const WHEN_HELP = 'Examples:  daily 9:00   weekdays 9am   mon,thu 14:30   every 2h   tomorrow 15:00   2026-12-01 9:00';

const file = () => path.join(personalDirectory(), 'schedules.json');
const pad = value => String(value).padStart(2, '0');
export const clockText = (hour, minute) => `${hour}:${pad(minute)}`;

function parseTime(word) {
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(word ?? '');
  if (!match) return null;
  let hour = Number(match[1]); const minute = match[2] ? Number(match[2]) : 0, half = match[3];
  if (minute > 59) return null;
  if (half) { if (hour < 1 || hour > 12) return null; hour = hour % 12 + (half === 'pm' ? 12 : 0); }
  else if (hour > 23) return null;
  return { hour, minute };
}
function parseDays(word) {
  const days = new Set();
  for (const part of word.split(',').filter(Boolean)) {
    const range = part.split('-');
    const index = name => name.length >= 3 ? FULL_DAYS.findIndex(day => day.startsWith(name)) : -1;
    if (range.length === 2) {
      const from = index(range[0]), to = index(range[1]); if (from < 0 || to < 0) return null;
      for (let day = from; ; day = (day + 1) % 7) { days.add(day); if (day === to) break; }
    } else { const day = index(part); if (day < 0) return null; days.add(day); }
  }
  return days.size ? [...days].sort((a, b) => a - b) : null;
}
function duration(count, unit) {
  const value = Number(count);
  if (/^(m|min|mins|minute|minutes)$/.test(unit)) return value;
  if (/^(h|hr|hrs|hour|hours)$/.test(unit)) return value * 60;
  if (/^(d|day|days)$/.test(unit)) return value * 24 * 60;
  return null;
}
// Reads "daily 9:00", "weekdays 9am", "mon,thu 14:30", "every 2h", "in 30m",
// "tomorrow 15:00" or "2026-12-01 9:00". "now" or nothing means not scheduled.
export function parseWhen(text, now = new Date()) {
  const value = String(text ?? '').trim().toLowerCase().replace(/\s+(am|pm)\b/g, '$1').replace(/\b(at|on)\b/g, ' ').replace(/,\s+/g, ',').replace(/\s+/g, ' ').trim();
  if (!value || value === 'now') return null;
  const fail = () => refuse(`Could not read "${String(text).trim()}" as a time. ${WHEN_HELP}`);
  if (value === 'hourly') return describe({ kind: 'every', minutes: 60 });
  let match = /^every (\d+) ?([a-z]+)$/.exec(value);
  if (match) {
    const minutes = duration(match[1], match[2]); if (minutes === null) fail();
    if (minutes < MIN_EVERY || minutes > MAX_EVERY) refuse(`Choose every 15m to every 7d.`);
    return describe({ kind: 'every', minutes });
  }
  match = /^in (\d+) ?([a-z]+)$/.exec(value);
  if (match) {
    const minutes = duration(match[1], match[2]); if (minutes === null || minutes < 1) fail();
    return describe({ kind: 'once', at: new Date(now.getTime() + minutes * 60000).toISOString() });
  }
  const words = value.replace(/^(every|each) /, '').split(' ');
  const time = parseTime(words.at(-1)), head = words.slice(0, -1).join(' ');
  if (!time) { if (words.length === 1 && (parseDays(words[0]) || ['daily', 'day', 'weekdays', 'weekday', 'weekends', 'today', 'tomorrow'].includes(words[0]))) refuse(`Add a time, for example ${words[0]} 9:00.`); fail(); }
  if (!head || ['daily', 'day', 'everyday'].includes(head)) return describe({ kind: 'days', days: [0, 1, 2, 3, 4, 5, 6], ...time });
  if (['weekdays', 'weekday'].includes(head)) return describe({ kind: 'days', days: [1, 2, 3, 4, 5], ...time });
  if (['weekends', 'weekend'].includes(head)) return describe({ kind: 'days', days: [0, 6], ...time });
  const once = date => {
    if (date <= now) refuse('That time has passed. Choose a later one.');
    return describe({ kind: 'once', at: date.toISOString() });
  };
  if (head === 'today' || head === 'tomorrow') return once(new Date(now.getFullYear(), now.getMonth(), now.getDate() + (head === 'tomorrow' ? 1 : 0), time.hour, time.minute));
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(head);
  if (match) {
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), time.hour, time.minute);
    if (date.getMonth() !== Number(match[2]) - 1) fail();
    return once(date);
  }
  const days = parseDays(head.replace(/ /g, ',')); if (!days) fail();
  return describe({ kind: 'days', days, ...time });
}
function describe(spec) {
  let label;
  if (spec.kind === 'every') label = spec.minutes % 1440 === 0 ? `every ${spec.minutes / 1440}d` : spec.minutes % 60 === 0 ? `every ${spec.minutes / 60}h` : `every ${spec.minutes}m`;
  else if (spec.kind === 'once') label = `once ${dateText(new Date(spec.at))}`;
  else {
    const key = spec.days.join(), at = clockText(spec.hour, spec.minute);
    label = key === '0,1,2,3,4,5,6' ? `daily ${at}` : key === '1,2,3,4,5' ? `weekdays ${at}` : key === '0,6' ? `weekends ${at}` : `every ${spec.days.map(day => DAY_NAMES[day]).join(', ')} ${at}`;
  }
  return { ...spec, label };
}
export function dateText(date) { return `${DAY_NAMES[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()} ${clockText(date.getHours(), date.getMinutes())}`; }
// The first run strictly after `after`, or null when a one-time run has passed.
export function nextRun(spec, after = new Date()) {
  if (spec.kind === 'every') return new Date(after.getTime() + spec.minutes * 60000);
  if (spec.kind === 'once') { const at = new Date(spec.at); return at > after ? at : null; }
  for (let offset = 0; offset <= 8; offset++) {
    const date = new Date(after.getFullYear(), after.getMonth(), after.getDate() + offset, spec.hour, spec.minute);
    if (date > after && spec.days.includes(date.getDay())) return date;
  }
  return null;
}
// "in 25m", "in 3h", "Tue 9:00": short enough for the Tasks clock column where possible.
export function untilText(value, now = Date.now()) {
  const at = Date.parse(value); if (!Number.isFinite(at)) return '-';
  const minutes = Math.max(0, Math.round((at - now) / 60000));
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 24 * 60) return `in ${Math.round(minutes / 60)}h`;
  return `in ${Math.round(minutes / 1440)}d`;
}

function validWhen(spec) {
  if (spec?.kind === 'every') return Number.isInteger(spec.minutes) && spec.minutes >= MIN_EVERY && spec.minutes <= MAX_EVERY;
  if (spec?.kind === 'once') return Number.isFinite(Date.parse(spec.at));
  return spec?.kind === 'days' && Array.isArray(spec.days) && spec.days.length && spec.days.every(day => Number.isInteger(day) && day >= 0 && day <= 6) && Number.isInteger(spec.hour) && spec.hour >= 0 && spec.hour <= 23 && Number.isInteger(spec.minute) && spec.minute >= 0 && spec.minute <= 59;
}
function readAll() {
  const target = file(); noSymlinks(target);
  if (!fs.existsSync(target)) return [];
  const value = readJson(target);
  if (!Array.isArray(value?.schedules)) refuse('The schedule file could not be read.');
  return value.schedules.filter(row => typeof row?.id === 'string' && typeof row.root === 'string' && typeof row.goal === 'string' && validWhen(row.when));
}
let cache = { stamp: null, rows: [] };
// Read on every Tasks redraw, so a file that has not changed is not parsed again.
export function listSchedules() {
  let stamp = null; try { const stat = fs.statSync(file()); stamp = `${stat.mtimeMs}:${stat.size}`; } catch { return []; }
  if (stamp !== cache.stamp) { try { cache = { stamp, rows: readAll() }; } catch { cache = { stamp, rows: [] }; } }
  return cache.rows;
}
function change(edit) {
  mkdir(personalDirectory());
  const release = waitLock({ state: personalDirectory() }, 'schedules', 200);
  try { const rows = readAll(), result = edit(rows); atomic(file(), { version: 1, schedules: rows }); return result; }
  finally { release(); }
}
// permissions: the mode each run gets, ask or auto; a schedule never runs with Full access.
// model: the model each run starts on, { vendor, model }; without one, the project's default at that time.
export function saveSchedule({ root, project, goal, when, permissions, model }, now = new Date()) {
  if (typeof goal !== 'string' || !goal.trim() || goal.length > 16000) refuse('Enter a task of 1 to 16000 characters.');
  if (!validWhen(when)) refuse(`Choose when it runs. ${WHEN_HELP}`);
  const mode = permissions === undefined || permissions === null ? null : checkMode(permissions, { allowFull: false });
  const next = nextRun(when, now); if (!next) refuse('That time has passed. Choose a later one.');
  const row = { id: `schedule-${crypto.randomUUID().slice(0, 8)}`, root, project: project ?? path.basename(root), goal, when: describe(when), enabled: true, createdAt: now.toISOString(), nextRunAt: next.toISOString(), lastRunAt: null, lastRequestId: null, lastTaskId: null, runs: 0, note: null, permissions: mode, ...(model ? { model: checkModel(model) } : {}) };
  return change(rows => { if (rows.length >= 50) refuse('Keep at most 50 schedules.'); rows.push(row); return row; });
}
export function removeSchedule(id) {
  return change(rows => { const index = rows.findIndex(row => row.id === id); if (index < 0) refuse('That schedule no longer exists.'); rows.splice(index, 1); return rows.length; });
}
export function pauseSchedule(id, paused, now = new Date()) {
  return change(rows => {
    const row = rows.find(value => value.id === id); if (!row) refuse('That schedule no longer exists.');
    if (!paused) { const next = nextRun(row.when, now); if (!next) refuse('That one-time run has passed. Delete it and schedule a new one.'); row.nextRunAt = next.toISOString(); }
    row.enabled = !paused; row.note = null; return row;
  });
}
// The run's task number, once the conductor has started it. Requests are deleted two
// minutes after they finish, so the schedule keeps the number itself.
function settle(row) {
  if (!row.lastRequestId || row.lastTaskId) return;
  try { const request = pendingRequests(row.root).find(value => value.id === row.lastRequestId); if (request?.taskId) row.lastTaskId = String(request.taskId); } catch { /* Read next time. */ }
}
function fire(row, at) {
  if (!fs.existsSync(row.root)) { row.note = 'The project folder is missing.'; return false; }
  let pending = null; try { pending = pendingRequests(row.root).find(value => value.scheduleId === row.id && value.state !== 'done'); } catch { /* Treated as none. */ }
  if (pending) { row.note = `Skipped ${dateText(at)}: the last run is ${pending.state}.`; return false; }
  const request = enqueue(row.root, row.goal, { priority: 1, scheduleId: row.id, ...(MODES.includes(row.permissions) && row.permissions !== 'full' ? { permissions: row.permissions } : {}), ...(row.model ? { model: row.model } : {}) });
  Object.assign(row, { lastRequestId: request.id, lastTaskId: null, lastRunAt: at.toISOString(), runs: row.runs + 1, note: null });
  return true;
}
// Queues every schedule that is due. A computer that slept through several runs gets
// one, then the next time is counted from now.
export function runDue(now = new Date(), { start = startConductor } = {}) {
  if (!fs.existsSync(file())) return 0;
  const fired = change(rows => {
    let count = 0;
    for (const row of rows) {
      settle(row);
      if (!row.enabled || !(Date.parse(row.nextRunAt) <= now.getTime())) continue;
      try { if (fire(row, now)) count++; } catch (error) { row.note = error.message; }
      const next = nextRun(row.when, now);
      if (row.when.kind === 'once' || !next) Object.assign(row, { enabled: false, nextRunAt: null }); else row.nextRunAt = next.toISOString();
    }
    return count;
  });
  if (fired) start();
  return fired;
}
export function runScheduleNow(id, now = new Date(), { start = startConductor } = {}) {
  const ok = change(rows => { const row = rows.find(value => value.id === id); if (!row) refuse('That schedule no longer exists.'); settle(row); if (!fire(row, now)) refuse(row.note); return true; });
  if (ok) start();
  return ok;
}

// Login item: runs `elu schedule tick` every minute. run(bin, args) loads it;
// tests pass their own, and the real one refuses inside the test runner.
const LABEL = 'dev.elu-code.scheduler';
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const runDefault = (bin, args, { allowFailure = false } = {}) => {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0 && !allowFailure) refuse(`${bin} could not load the scheduler: ${(result.stderr || result.error?.message || '').trim().slice(0, 200)}`);
};
// Session folders (such as a terminal's own shims under the temp folder) vanish later.
function keptPath(value = '') {
  const temp = [os.tmpdir(), fs.realpathSync.native?.(os.tmpdir()) ?? os.tmpdir()];
  return cleanPath(value).split(path.delimiter).filter(entry => entry && path.isAbsolute(entry) && !temp.some(root => entry.startsWith(root))).join(path.delimiter);
}
export function schedulerFiles({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return [path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)];
  if (platform === 'linux') { const dir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user'); return [path.join(dir, 'elu-code-scheduler.service'), path.join(dir, 'elu-code-scheduler.timer')]; }
  return [];
}
const guard = run => { if (run === runDefault && process.env.NODE_TEST_CONTEXT) refuse('Tests must not install login items.'); };
export function installScheduler({ platform = process.platform, home = os.homedir(), env = process.env, run = runDefault, lasting = isInstalled({ env, home }) } = {}) {
  guard(run);
  const files = schedulerFiles({ platform, home, env });
  if (!files.length) return { installed: false, reason: 'Schedules run only while ELU Code is open on this system.' };
  // A login item names this copy's files, so it is written only by the installed command. A
  // copy a package runner fetched (npx and the like) sits in a cache that gets cleared.
  if (!lasting) return { installed: false, reason: `Schedules run only while ELU Code is open until it is installed: ${BY_HAND}` };
  const args = [process.execPath, fileURLToPath(new URL('../bin/elu-code.mjs', import.meta.url)), 'schedule', 'tick'];
  const keep = Object.fromEntries([['PATH', keptPath(env.PATH)], ...['HOME', 'XDG_CONFIG_HOME', 'LANG', 'USER', 'LOGNAME', 'SHELL'].map(name => [name, env[name]])].filter(([, value]) => value));
  let contents;
  if (platform === 'darwin') {
    const log = path.join(personalDirectory(), 'scheduler.log');
    contents = [`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${LABEL}</string>\n  <key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>\n  <key>StartInterval</key><integer>60</integer>\n  <key>RunAtLoad</key><true/>\n  <key>ProcessType</key><string>Background</string>\n  <key>EnvironmentVariables</key><dict>${Object.entries(keep).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict>\n  <key>StandardOutPath</key><string>${xml(log)}</string>\n  <key>StandardErrorPath</key><string>${xml(log)}</string>\n</dict>\n</plist>\n`];
  } else {
    contents = [`[Unit]\nDescription=ELU Code schedules\n\n[Service]\nType=oneshot\nExecStart=${args.map(unitArgument).join(' ')}\n${Object.entries(keep).map(([key, value]) => unitEnvironment(key, value)).join('\n')}\n`,
      `[Unit]\nDescription=Check ELU Code schedules every minute\n\n[Timer]\nOnCalendar=*-*-* *:*:00\nAccuracySec=10s\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`];
  }
  const same = files.every((target, index) => { try { noSymlinks(target); return fs.readFileSync(target, 'utf8') === contents[index]; } catch { return false; } });
  if (same) return { installed: true, changed: false, files };
  for (const [index, target] of files.entries()) { mkdir(path.dirname(target)); atomic(target, contents[index]); }
  if (platform === 'darwin') {
    const domain = `gui/${process.getuid()}`;
    run('launchctl', ['bootout', domain, files[0]], { allowFailure: true });
    run('launchctl', ['bootstrap', domain, files[0]]);
  } else {
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', 'elu-code-scheduler.timer']);
  }
  return { installed: true, changed: true, files };
}
export function uninstallScheduler({ platform = process.platform, home = os.homedir(), env = process.env, run = runDefault } = {}) {
  guard(run);
  const files = schedulerFiles({ platform, home, env }).filter(target => { noSymlinks(target); return fs.existsSync(target); });
  if (!files.length) return { removed: false };
  try {
    if (platform === 'darwin') run('launchctl', ['bootout', `gui/${process.getuid()}`, files[0]], { allowFailure: true });
    else run('systemctl', ['--user', 'disable', '--now', 'elu-code-scheduler.timer'], { allowFailure: true });
  } catch { /* It may not be loaded; the files still go. */ }
  for (const target of files) fs.rmSync(target, { force: true });
  return { removed: true, files };
}
