import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseWhen, splitWhen, nextRun, saveSchedule, listSchedules, runDue, runScheduleNow, pauseSchedule, removeSchedule, installScheduler, uninstallScheduler, schedulerFiles } from '../lib/schedules.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { saveBot, removeBot } from '../lib/bots.mjs';
import { scheduleTick, setBotSchedule } from '../lib/bot-schedules.mjs';
import { repository } from '../lib/git.mjs';
import { registerProject, projectSnapshot } from '../lib/projects.mjs';
import { readTask, saveTask, taskDir } from '../lib/state.mjs';
import { enqueue, conductorStatus } from '../lib/conductor.mjs';
import { pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { project, fakeClis, CLI } from './helpers.mjs';
import { standIn } from './login-item-helpers.mjs';
import { liveTask } from './peer-helpers.mjs';
import { saveDefaultMode } from '../lib/modes.mjs';
import { processIdentity } from '../lib/process.mjs';

// Local times, so the tests hold in any time zone. 2026-11-09 is a Monday.
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute);
function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-schedules-'))), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('When reads days, times, intervals, and one-time runs in local time', () => {
  const now = at(9, 13, 30);
  const cases = [
    ['daily 9:00', 'daily 9:00', at(10, 9)], ['9am', 'daily 9:00', at(10, 9)], ['every day at 9:30pm', 'daily 21:30', at(9, 21, 30)],
    ['weekdays 9am', 'weekdays 9:00', at(10, 9)], ['weekends 10', 'weekends 10:00', at(14, 10)],
    ['mon,thu 14:30', 'every Mon, Thu 14:30', at(9, 14, 30)], ['mon wed fri 9:00', 'every Mon, Wed, Fri 9:00', at(11, 9)], ['tues-thurs 8:15', 'every Tue, Wed, Thu 8:15', at(10, 8, 15)],
    ['every 2h', 'every 2h', at(9, 15, 30)], ['every 30 minutes', 'every 30m', at(9, 14)], ['hourly', 'every 1h', at(9, 14, 30)],
    ['tomorrow 15:00', 'once Tue Nov 10 15:00', at(10, 15)], ['2026-12-01 9:00', 'once Tue Dec 1 9:00', new Date(2026, 11, 1, 9)], ['in 45m', 'once Mon Nov 9 14:15', at(9, 14, 15)],
  ];
  for (const [text, label, next] of cases) {
    const when = parseWhen(text, now);
    assert.equal(when.label, label, text); assert.equal(nextRun(when, now).getTime(), next.getTime(), text);
  }
  assert.equal(parseWhen('now', now), null); assert.equal(parseWhen('', now), null);
  assert.throws(() => parseWhen('every 5m', now), /every 15m to every 7d/);
  assert.throws(() => parseWhen('daily', now), /Add a time, for example daily 9:00/);
  assert.throws(() => parseWhen('today 9:00', now), /has passed/);
  for (const text of ['fri 25:00', 'yesterday 9', '2026-02-30 9:00', 'sometimes']) assert.throws(() => parseWhen(text, now), /Could not read/, text);
});

test('/schedule reads the longest start that is a time, and the rest is the message', () => {
  const now = at(9, 13, 30), read = text => { const value = splitWhen(text, now); return [value.when.label, value.text, value.rest]; };
  assert.deepEqual(read('in 1h check the build'), ['once Mon Nov 9 14:30', 'in 1h', 'check the build']);
  assert.deepEqual(read('daily 9:00 triage new issues'), ['daily 9:00', 'daily 9:00', 'triage new issues']);
  assert.deepEqual(read('weekdays 9 am  write the notes'), ['weekdays 9:00', 'weekdays 9 am', 'write the notes']);
  assert.deepEqual(read('mon,thu 14:30 5 tests to fix'), ['every Mon, Thu 14:30', 'mon,thu 14:30', '5 tests to fix'], 'a number after the time stays in the message');
  assert.deepEqual(read('every 2h'), ['every 2h', 'every 2h', ''], 'a time alone waits for the message');
  assert.deepEqual(read("in 5m don't stop\nsecond line"), ['once Mon Nov 9 13:35', 'in 5m', "don't stop\nsecond line"], 'the message is kept as typed');
  // A message that starts with at or on keeps it: the time does not take that word.
  assert.deepEqual(read('in 1h at least check the build'), ['once Mon Nov 9 14:30', 'in 1h', 'at least check the build']);
  assert.deepEqual(read('daily 9:00 on main, run the tests'), ['daily 9:00', 'daily 9:00', 'on main, run the tests']);
  assert.deepEqual(read('in 2h on second thought, skip'), ['once Mon Nov 9 15:30', 'in 2h', 'on second thought, skip']);
  assert.deepEqual(read('every day at 9:30pm wrap up'), ['daily 21:30', 'every day at 9:30pm', 'wrap up'], 'at inside the time still reads');
  // An hour alone is a time only with am or pm, or after the days.
  assert.deepEqual(read('9am triage'), ['daily 9:00', '9am', 'triage']); assert.deepEqual(read('daily 9 triage'), ['daily 9:00', 'daily 9', 'triage']);
  // No start reads as a time: the forms that work are named. A time that is refused says why.
  assert.throws(() => splitWhen('check the build', now), { message: 'Could not read when it runs. Start with when it runs, such as in 30m, every 2h, daily 9:00, weekdays 9am or tomorrow 15:00, then your message.' });
  assert.throws(() => splitWhen('now check the build', now), /Could not read when it runs\./);
  for (const text of ['5 tests to fix', 'at 5 tests to fix']) assert.throws(() => splitWhen(text, now), { message: /^Could not read when it runs\./ }, text);
  // A time in two parts would be read as its first part, with the rest put in the message.
  for (const text of ['in 1h 30m later', 'in 1 hour 30 minutes check', 'every 1h 30m ping']) assert.throws(() => splitWhen(text, now), { message: 'Use one unit for the time, such as in 90m, then your message.' }, text);
  assert.throws(() => splitWhen('every 5m ping', now), /Choose every 15m to every 7d\./);
  assert.throws(() => splitWhen('daily triage', now), /Add a time, for example daily 9:00\./);
  assert.throws(() => splitWhen('today 9:00 report', now), /That time has passed/);
});

test('a schedule keeps its bots and branch and each run starts with them; an older schedule without them still runs', t => {
  const dir = home(t), p = project(t), start = () => true;
  // A schedule saved before bots and places were kept: no such fields in the file.
  fs.mkdirSync(path.join(dir, 'personal', 'elu-code'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'personal', 'elu-code', 'schedules.json'), JSON.stringify({ version: 1, schedules: [{ id: 'schedule-0a1b2c3d', root: p.root, project: 'old', goal: 'Old schedule', when: parseWhen('every 1h', at(9, 8)), enabled: true, createdAt: at(9, 8).toISOString(), nextRunAt: at(9, 9).toISOString(), lastRunAt: null, lastRequestId: null, lastTaskId: null, runs: 0, note: null, permissions: null }] }));
  saveBot({ name: 'nightly', instructions: 'Check the nightly build.' });
  const row = saveSchedule({ root: p.root, goal: 'Check the build', when: parseWhen('in 2m', at(9, 8)), permissions: 'auto', picked: true, bots: ['reviewer', 'nightly'], place: { kind: 'branch', branch: 'nightly-checks' } }, at(9, 8));
  assert.deepEqual([row.bots, row.place], [['reviewer', 'nightly'], { kind: 'branch', branch: 'nightly-checks' }]);
  assert.deepEqual(listSchedules().find(value => value.id === row.id).bots, ['reviewer', 'nightly']);
  // A new worktree is what every run gets anyway, so it is not stored. Your checkout as it is needs Full access, which a schedule never has.
  assert.equal('place' in saveSchedule({ root: p.root, goal: 'Plain', when: parseWhen('every 1h', at(9, 8)), bots: [], place: { kind: 'worktree' } }, at(9, 8)), false);
  assert.throws(() => saveSchedule({ root: p.root, goal: 'Here', when: parseWhen('every 1h', at(9, 8)), place: { kind: 'here' } }, at(9, 8)), /never runs in your checkout as it is/);
  // Worktrees stay after a run, and a branch is checked out in one, so only a one-time schedule keeps a branch.
  assert.throws(() => saveSchedule({ root: p.root, goal: 'Nightly', when: parseWhen('every 1h', at(9, 8)), place: { kind: 'branch', branch: 'nightly-checks' } }, at(9, 8)), { message: 'A branch is checked out in one place at a time, so a repeating schedule runs in a new worktree. Set Runs in to New worktree, or schedule it once.' });
  assert.throws(() => saveSchedule({ root: p.root, goal: 'Gone', when: parseWhen('every 1h', at(9, 8)), bots: ['nobody'] }, at(9, 8)), /There is no bot named nobody/);
  assert.equal(listSchedules().length, 3, 'the older schedule loads beside them');
  assert.equal(runDue(at(9, 10), { start }), 3);
  const requests = pendingRequests(p.root), of = goal => requests.find(request => request.goal === goal);
  assert.deepEqual([of('Check the build').bots, of('Check the build').place, of('Check the build').permissions], [['reviewer', 'nightly'], { kind: 'branch', branch: 'nightly-checks' }, 'auto']);
  assert.deepEqual(of('Plain').bots, [], 'no bots, as the form had none');
  assert.equal('bots' in of('Old schedule'), false); assert.equal('place' in of('Old schedule'), false);
  // A bot deleted since is left out of the next run; the run still starts.
  for (const request of requests) updateRequest(p.root, request.id, { state: 'done' });
  removeBot('nightly');
  assert.equal(runScheduleNow(row.id, at(9, 11), { start }), true);
  assert.deepEqual(pendingRequests(p.root).find(request => request.goal === 'Check the build' && request.state === 'queued').bots, ['reviewer']);
  // A bot with its own schedule is kept by the schedule but left out of its runs, so no run starts that bot's schedule.
  for (const request of pendingRequests(p.root)) updateRequest(p.root, request.id, { state: 'done' });
  saveBot({ name: 'nightly', instructions: 'Check the nightly build.', schedule: 'every 1h' });
  assert.equal(runScheduleNow(row.id, at(9, 12), { start }), true);
  assert.deepEqual(listSchedules().find(value => value.id === row.id).bots, ['reviewer', 'nightly']);
  assert.deepEqual(pendingRequests(p.root).find(request => request.goal === 'Check the build' && request.state === 'queued').bots, ['reviewer']);
});

test('a due schedule queues one run, skips while it is still pending, and catches up once after sleep', t => {
  home(t); const p = project(t), starts = [];
  const start = () => { starts.push(1); return true; };
  const row = saveSchedule({ root: p.root, goal: 'Check dependencies for updates', when: parseWhen('daily 9:00', at(9, 8)) }, at(9, 8));
  assert.equal(Date.parse(row.nextRunAt), at(9, 9).getTime());
  assert.equal(runDue(at(9, 8, 59), { start }), 0);
  assert.equal(runDue(at(9, 9), { start }), 1); assert.equal(starts.length, 1);
  const [request] = pendingRequests(p.root);
  assert.equal(request.goal, 'Check dependencies for updates'); assert.equal(request.scheduleId, row.id); assert.equal(request.state, 'queued'); assert.equal(request.priority, 1);
  assert.equal(runDue(at(9, 9, 1), { start }), 0, 'the next run is tomorrow');
  // Asleep for three days, and the last run never started: skipped, with a note.
  assert.equal(runDue(at(12, 10), { start }), 0);
  let saved = listSchedules()[0];
  assert.match(saved.note, /Skipped .*the last run is queued/); assert.equal(Date.parse(saved.nextRunAt), at(13, 9).getTime());
  // The conductor picks the run up and finishes it; the schedule keeps its task number.
  updateRequest(p.root, request.id, { state: 'running', taskId: '7' }); runDue(at(12, 11), { start });
  assert.equal(listSchedules()[0].lastTaskId, '7');
  updateRequest(p.root, request.id, { state: 'done' });
  assert.equal(runDue(at(15, 12), { start }), 1, 'one run after sleeping through two');
  saved = listSchedules()[0];
  assert.equal(saved.runs, 2); assert.equal(saved.note, null); assert.equal(Date.parse(saved.nextRunAt), at(16, 9).getTime()); assert.equal(starts.length, 2);
});

test('a one-time schedule turns off after it runs; pause, run now, and delete', t => {
  home(t); const p = project(t), start = () => true;
  const once = saveSchedule({ root: p.root, goal: 'Release notes draft', when: parseWhen('tomorrow 15:00', at(9, 12)) }, at(9, 12));
  assert.equal(runDue(at(10, 15), { start }), 1);
  assert.equal(listSchedules()[0].enabled, false); assert.equal(listSchedules()[0].nextRunAt, null);
  assert.throws(() => pauseSchedule(once.id, false, at(10, 16)), /has passed/);
  const daily = saveSchedule({ root: p.root, goal: 'Triage new issues', when: parseWhen('weekdays 9:00', at(10, 16)) }, at(10, 16));
  pauseSchedule(daily.id, true);
  assert.equal(runDue(at(11, 9), { start }), 0, 'paused');
  assert.equal(Date.parse(pauseSchedule(daily.id, false, at(11, 10)).nextRunAt), at(12, 9).getTime());
  // The one-time run is still pending, so only the daily schedule can run now.
  assert.throws(() => runScheduleNow(once.id, at(11, 10), { start }), /last run is queued/);
  assert.equal(runScheduleNow(daily.id, at(11, 10), { start }), true);
  assert.equal(pendingRequests(p.root).filter(row => row.scheduleId === daily.id).length, 1);
  assert.equal(removeSchedule(once.id), 1); assert.equal(removeSchedule(daily.id), 0);
  assert.throws(() => removeSchedule(daily.id), /no longer exists/);
  assert.throws(() => enqueue(p.root, 'x', { scheduleId: '../evil' }), /Invalid schedule ID/);
});

test('a schedule runs with the mode picked for it; Full access only when the owner picked it', t => {
  home(t); const p = project(t), start = () => true, when = () => parseWhen('every 1h', at(9, 8));
  assert.throws(() => saveSchedule({ root: p.root, goal: 'Lint', when: when(), permissions: 'full' }, at(9, 8)), /Full access only when you pick it/);
  assert.throws(() => saveSchedule({ root: p.root, goal: 'Lint', when: when(), permissions: 'full', picked: false }, at(9, 8)), /Full access only when you pick it/);
  assert.throws(() => saveSchedule({ root: p.root, goal: 'Lint', when: when(), permissions: 'full', picked: true, place: { kind: 'here' } }, at(9, 8)), /never runs in your checkout/);
  assert.throws(() => saveSchedule({ root: p.root, goal: 'Lint', when: when(), permissions: 'locked' }, at(9, 8)), /Choose ask, auto, or full/);
  const row = saveSchedule({ root: p.root, goal: 'Lint', when: when(), permissions: 'auto', picked: true }, at(9, 8));
  assert.equal(row.permissions, 'auto'); assert.equal(listSchedules()[0].permissions, 'auto'); assert.equal(listSchedules()[0].picked, true);
  const plain = saveSchedule({ root: p.root, goal: 'Plain', when: when() }, at(9, 8));
  assert.equal(plain.permissions, null); assert.equal('picked' in plain, false);
  assert.throws(() => saveSchedule({ root: p.root, goal: 'Lint', when: when(), permissions: 'auto', picked: 'yes' }, at(9, 8)), /picked is true or false/);
  assert.equal(runDue(at(9, 10), { start }), 2);
  const requests = pendingRequests(p.root), run = requests.find(request => request.scheduleId === row.id);
  // A picked mode is kept on the run, above the default (Ask for approval here).
  assert.equal(run.permissions, 'auto'); assert.equal(run.picked, true);
  assert.equal('permissions' in requests.find(request => request.scheduleId === plain.id), false);
});

// The owner picked Full access for this schedule, so each run starts in it, whatever the
// default says; the file keeps it for the next run and for a restart.
test('a schedule the owner gave Full access keeps it, and each run starts in it', t => {
  home(t); const p = project(t), start = () => true;
  saveDefaultMode('ask');
  const row = saveSchedule({ root: p.root, goal: 'Triage the backlog', when: parseWhen('every 3h', at(9, 8)), permissions: 'full', picked: true }, at(9, 8));
  assert.equal(row.permissions, 'full'); assert.equal(row.picked, true);
  assert.deepEqual([listSchedules()[0].permissions, listSchedules()[0].picked], ['full', true]);
  assert.equal(runDue(at(9, 11, 1), { start }), 1);
  const run = pendingRequests(p.root).find(request => request.scheduleId === row.id);
  assert.equal(run.permissions, 'full'); assert.equal(run.picked, true);
  updateRequest(p.root, run.id, { state: 'done' });
  assert.equal(runScheduleNow(row.id, at(9, 12), { start }), true);
  assert.equal(pendingRequests(p.root).find(request => request.scheduleId === row.id && request.state !== 'done').permissions, 'full', 'r runs it in Full access too');
});

// The previous version's scheduler and app run beside this one, and a schedule file may come
// from either. One without a mode, or with ask or auto, runs as before; a mode this version
// does not know is refused, never read as something wider; and Full access that was not
// picked, which no version saves, runs with no mode, read only, as it did before.
test('schedule files from other versions: old rows run as before, an unknown mode is refused', t => {
  home(t); const p = project(t), start = () => true, now = at(9, 8);
  saveDefaultMode('full');
  const base = { root: p.root, project: 'p', when: parseWhen('every 1h', now), enabled: true, createdAt: now.toISOString(), nextRunAt: at(9, 9).toISOString(), lastRunAt: null, lastRequestId: null, lastTaskId: null, runs: 0, note: null };
  const rows = [
    { ...base, id: 'schedule-0000000a', goal: 'No mode' },
    { ...base, id: 'schedule-0000000b', goal: 'Auto, not picked', permissions: 'auto' },
    { ...base, id: 'schedule-0000000c', goal: 'Unknown mode', permissions: 'yolo', picked: true },
    { ...base, id: 'schedule-0000000d', goal: 'Full, not picked', permissions: 'full' },
    { ...base, id: 'schedule-0000000e', goal: 'Locked', permissions: 'locked', picked: true },
  ];
  atomic(path.join(personalDirectory(), 'schedules.json'), { version: 1, schedules: rows });
  assert.equal(listSchedules().length, 5, 'every row still reads');
  assert.equal(runDue(at(9, 9), { start }), 3);
  const of = id => pendingRequests(p.root).find(request => request.scheduleId === id);
  assert.equal('permissions' in of('schedule-0000000a'), false, 'no mode: as before');
  assert.equal(of('schedule-0000000b').permissions, 'auto'); assert.equal('picked' in of('schedule-0000000b'), false);
  assert.equal('permissions' in of('schedule-0000000d'), false, 'Full that nobody picked runs read only, as before');
  for (const id of ['schedule-0000000c', 'schedule-0000000e']) {
    assert.equal(of(id), undefined, `${id} did not run`);
    assert.match(listSchedules().find(row => row.id === id).note, /permissions cannot be read by this version/);
    assert.ok(Date.parse(listSchedules().find(row => row.id === id).nextRunAt) > at(9, 9).getTime(), 'its next time still moves on');
  }
  assert.throws(() => runScheduleNow('schedule-0000000c', at(9, 10), { start }), /permissions cannot be read/);
});

// A mode the owner did not pick follows the default at each run, so a lower default reaches
// a schedule saved before it. A schedule saved before picks were kept counts as not picked.
test('a schedule whose mode was not picked runs with no more access than the default now', t => {
  home(t); const p = project(t), start = () => true, when = () => parseWhen('every 1h', at(9, 8));
  saveDefaultMode('auto');
  const row = saveSchedule({ root: p.root, goal: 'Lint', when: when(), permissions: 'auto', picked: false }, at(9, 8));
  assert.equal('picked' in row, false);
  assert.equal(runDue(at(9, 10), { start }), 1);
  assert.equal(pendingRequests(p.root).find(request => request.scheduleId === row.id).permissions, 'auto', 'the default allows it');
  saveDefaultMode('ask');
  for (const request of pendingRequests(p.root)) updateRequest(p.root, request.id, { state: 'done' });
  assert.equal(runDue(at(9, 11, 1), { start }), 1);
  const runs = pendingRequests(p.root).filter(request => request.scheduleId === row.id && request.state !== 'done');
  assert.equal(runs.length, 1); assert.equal(runs[0].permissions, 'ask'); assert.equal('picked' in runs[0], false);
  // And it never goes above Approve for me, whatever the default.
  saveDefaultMode('full');
  for (const request of pendingRequests(p.root)) updateRequest(p.root, request.id, { state: 'done' });
  assert.equal(runDue(at(9, 12, 2), { start }), 1);
  assert.equal(pendingRequests(p.root).find(request => request.scheduleId === row.id && request.state !== 'done').permissions, 'auto');
});

test('a schedule whose project folder is gone is noted, not run', t => {
  home(t); const p = project(t);
  saveSchedule({ root: path.join(p.root, 'gone'), goal: 'Lint', when: parseWhen('every 1h', at(9, 8)) }, at(9, 8));
  assert.equal(runDue(at(9, 9), { start: () => true }), 0);
  assert.equal(listSchedules()[0].note, 'The project folder is missing.');
});

test('the login item checks every minute and keeps only lasting PATH entries', t => {
  const dir = home(t), calls = [], run = (bin, args) => calls.push([bin, ...args]);
  const env = { PATH: `${path.join(os.tmpdir(), 'terminal-shims', 'abc')}:/opt/homebrew/bin:/Users/me/.local/bin:relative`, HOME: dir };
  const mac = installScheduler({ platform: 'darwin', home: dir, env, run, lasting: true });
  const plist = fs.readFileSync(mac.files[0], 'utf8');
  assert.match(plist, /<key>StartInterval<\/key><integer>60<\/integer>/); assert.match(plist, /<string>schedule<\/string><string>tick<\/string>/);
  assert.match(plist, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/Users\/me\/.local\/bin<\/string>/);
  assert.deepEqual(calls.map(row => row.slice(0, 2)), [['launchctl', 'bootout'], ['launchctl', 'bootstrap']]);
  assert.equal(installScheduler({ platform: 'darwin', home: dir, env, run, lasting: true }).changed, false); assert.equal(calls.length, 2, 'unchanged files are not reloaded');
  assert.equal(uninstallScheduler({ platform: 'darwin', home: dir, env, run }).removed, true); assert.equal(fs.existsSync(mac.files[0]), false);
  calls.length = 0;
  const linux = installScheduler({ platform: 'linux', home: dir, env: { ...env, XDG_CONFIG_HOME: path.join(dir, 'config') }, run, lasting: true });
  assert.match(fs.readFileSync(linux.files[1], 'utf8'), /OnCalendar=\*-\*-\* \*:\*:00/); assert.match(fs.readFileSync(linux.files[0], 'utf8'), /Type=oneshot/);
  assert.deepEqual(calls.at(-1), ['systemctl', '--user', 'enable', '--now', 'elu-code-scheduler.timer']);
  assert.equal(installScheduler({ platform: 'win32', home: dir, env, run }).installed, false);
  // The real loader refuses inside the test runner, so no test can load a login item.
  assert.throws(() => installScheduler({ platform: 'darwin', home: path.join(dir, 'other'), env }), /Tests must not install login items/);
  assert.equal(fs.existsSync(path.join(dir, 'other')), false, 'refused before writing anything');
});

test('on macOS the login item is loaded and unloaded through launchctl, which a stand-in first on PATH answers', t => {
  home(t); const item = standIn(t, 'darwin'), plist = path.join(item.home, 'Library', 'LaunchAgents', 'dev.elu-code.scheduler.plist');
  const verbs = () => item.calls().map(call => `${call.name} ${call.args[0]}`);
  // Nothing is loaded yet, so the real bootout fails here too; the install goes on to load it.
  assert.deepEqual(item.install(), { installed: true, changed: true, files: [plist] });
  assert.deepEqual(item.loaded(), [plist]); assert.deepEqual(verbs(), ['launchctl bootout', 'launchctl bootstrap']);
  assert.deepEqual(item.calls()[1].args, ['bootstrap', `gui/${process.getuid()}`, plist]);
  assert.equal(item.install().changed, false); assert.equal(item.calls().length, 2, 'the same files are not loaded again');
  // Removed: unloaded first, then the file goes. A second removal finds nothing and calls nothing.
  assert.deepEqual(item.uninstall(), { removed: true, files: [plist] });
  assert.deepEqual(item.loaded(), []); assert.deepEqual(item.files(), []); assert.equal(verbs().at(-1), 'launchctl bootout');
  assert.deepEqual(item.uninstall(), { removed: false }); assert.equal(item.calls().length, 3);
  // Asked for again, it is loaded again. One whose text changed is unloaded and loaded once.
  assert.equal(item.install().changed, true); assert.deepEqual(item.loaded(), [plist]);
  assert.equal(item.install({ env: { ...item.env, LANG: 'en_US.UTF-8' } }).changed, true);
  assert.deepEqual(item.loaded(), [plist]); assert.deepEqual(verbs().slice(-2), ['launchctl bootout', 'launchctl bootstrap']);
  // A file that vanished while it was loaded: bootout is still asked for by install, so it loads.
  fs.rmSync(plist); assert.deepEqual(item.uninstall(), { removed: false });
  assert.equal(item.install().changed, true); assert.deepEqual(item.loaded(), [plist]);
  assert.ok(item.calls().every(call => call.name === 'launchctl'), 'every call went to the stand-in');
});

test('on Linux the login item is enabled and disabled through systemctl --user, which a stand-in first on PATH answers', t => {
  home(t); const item = standIn(t, 'linux'), units = path.join(item.home, '.config', 'systemd', 'user');
  const files = [path.join(units, 'elu-code-scheduler.service'), path.join(units, 'elu-code-scheduler.timer')];
  assert.deepEqual(item.install(), { installed: true, changed: true, files });
  assert.deepEqual(item.loaded(), ['elu-code-scheduler.timer']);
  assert.deepEqual(item.calls().map(call => call.args), [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'elu-code-scheduler.timer']]);
  assert.deepEqual(item.uninstall(), { removed: true, files });
  assert.deepEqual(item.loaded(), []); assert.deepEqual(item.files(), []);
  assert.deepEqual(item.calls().at(-1).args, ['--user', 'disable', '--now', 'elu-code-scheduler.timer']);
  assert.equal(item.install().changed, true); assert.deepEqual(item.loaded(), ['elu-code-scheduler.timer']);
});

const until = async (check, what, ms = 10000) => { for (const started = Date.now(); !check();) { if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 10)); } };
// A one-time schedule that is due now: saved ten minutes ago for five minutes later.
const dueOnce = (root, goal = 'Check the build') => { const then = new Date(Date.now() - 10 * 60000); return saveSchedule({ root, goal, when: parseWhen('in 5m', then) }, then); };

test('elu schedule tick, run as the login item runs it while ELU is closed, queues the last one-time run and then removes the login item', { skip: !['darwin', 'linux'].includes(process.platform) && 'This system has no login item.' }, async t => {
  home(t); const p = project(t), item = standIn(t, process.platform, { config: process.env.XDG_CONFIG_HOME });
  // A conductor counts as running, since this process holds its lock: the tick starts none for the run it queues.
  fs.mkdirSync(personalDirectory(), { recursive: true }); fs.writeFileSync(path.join(personalDirectory(), 'conductor.lock'), JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) }));
  const row = dueOnce(p.root);
  item.install(); assert.ok(item.files().length); assert.equal(item.loaded().length, 1);
  const ran = await item.job([process.execPath, CLI, 'schedule', 'tick']);
  // What it has to say is out before the removal, which ends the run on macOS. On Linux the service runs to its end.
  assert.deepEqual([ran.stdout, ran.stderr], ['Queued 1 scheduled task.\n', '']);
  assert.ok(ran.status === 0 || process.platform === 'darwin' && ran.signal === 'SIGTERM', `it ended with ${ran.status ?? ran.signal}`);
  assert.equal(pendingRequests(p.root).filter(request => request.scheduleId === row.id).length, 1, 'the run was queued first');
  assert.equal(listSchedules()[0].enabled, false, 'a one-time schedule is off once it ran');
  await until(() => !item.loaded().length, 'the login item to be unloaded');
  assert.deepEqual(item.files(), [], 'no schedule is on, so its files are gone');
  // On macOS the bootout comes from outside the job, which it ends. On Linux the service itself disables its timer.
  assert.deepEqual(item.calls().at(-1), process.platform === 'darwin' ? { name: 'launchctl', args: ['bootout', `gui/${process.getuid()}/dev.elu-code.scheduler`] } : { name: 'systemctl', args: ['--user', 'disable', '--now', 'elu-code-scheduler.timer'], fromJob: true });
  // Run by hand with no login item left, it queues nothing, says nothing and ends well.
  assert.deepEqual(await item.job([process.execPath, CLI, 'schedule', 'tick']), { status: 0, signal: null, stdout: '', stderr: '' });
});

// A script in place of the login item's command, so its run is on the system the test names
// whatever system the test itself is on. tick: what elu schedule tick does, then what comes after.
const lib = name => JSON.stringify(new URL(`../lib/${name}`, import.meta.url).href);
const script = (item, name, lines) => { const file = path.join(item.home, name); fs.writeFileSync(file, `${lines.join('\n')}\n`); return [process.execPath, file]; };
const tickScript = (item, platform, after) => script(item, 'tick.mjs', [
  `import { scheduleTick } from ${lib('bot-schedules.mjs')};`,
  `const { fired, last } = scheduleTick(new Date(), { start: () => false, item: { platform: '${platform}' } });`,
  'process.stdout.write(`fired ${fired}\\n`);',
  'last?.();',
  after,
]);

test('on macOS the login item removes itself in the one order launchd lets it finish: its file first, then its bootout by label, asked for last from a process group of its own', async t => {
  home(t); const p = project(t), item = standIn(t, 'darwin', { config: process.env.XDG_CONFIG_HOME }), plist = path.join(item.home, 'Library', 'LaunchAgents', 'dev.elu-code.scheduler.plist');
  const byLabel = { name: 'launchctl', args: ['bootout', `gui/${process.getuid()}/dev.elu-code.scheduler`] };
  // The stand-in ends a job that boots itself out, as launchd does. So the order the app uses,
  // bootout and then the file, never reaches the file from inside the job: it would load again at the next login.
  item.install();
  let ran = await item.job(script(item, 'app-order.mjs', [`import { uninstallScheduler } from ${lib('schedules.mjs')};`, "uninstallScheduler({ platform: 'darwin' });", "process.stdout.write('after its bootout\\n');"]));
  assert.deepEqual(ran, { status: null, signal: 'SIGTERM', stdout: '', stderr: '' }); assert.deepEqual(item.loaded(), []); assert.deepEqual(item.files(), [plist]);
  assert.deepEqual(item.calls().at(-1), { name: 'launchctl', args: ['bootout', `gui/${process.getuid()}`, plist], fromJob: true }, 'a launchctl the job waits for is in its process group, and ends with it');
  // The tick's own order. Its script has more to do after the removal, and is ended before it gets there.
  item.uninstall(); dueOnce(p.root); item.install(); assert.deepEqual(item.loaded(), [plist]);
  const tick = tickScript(item, 'darwin', "setTimeout(() => process.stdout.write('after its bootout\\n'), 20000);");
  ran = await item.job(tick);
  assert.deepEqual(ran, { status: null, signal: 'SIGTERM', stdout: 'fired 1\n', stderr: '' });
  assert.deepEqual(item.files(), [], 'the file went before the bootout ended the job'); assert.deepEqual(item.loaded(), []);
  assert.deepEqual(item.calls().at(-1), byLabel, 'by label, and from outside the job: its launchctl outlives it');
  // The bootout was waited for with the lock held, and the tick ended there: nothing could load the login item again before it was out.
  assert.equal(JSON.parse(fs.readFileSync(path.join(personalDirectory(), 'login-item.lock'), 'utf8')).identity === processIdentity(process.pid), false, 'the lock is still the ended tick\'s');
  // A login item whose file went without it is still loaded. Its next run with nothing on ends it too.
  item.install(); fs.rmSync(plist); assert.deepEqual(item.loaded(), [plist]);
  ran = await item.job(tick);
  assert.deepEqual(ran, { status: null, signal: 'SIGTERM', stdout: 'fired 0\n', stderr: '' }); assert.deepEqual(item.loaded(), []); assert.deepEqual(item.calls().at(-1), byLabel);
});

test('on Linux the login item disables its own timer from within its service, which runs on to its end', async t => {
  home(t); const p = project(t), item = standIn(t, 'linux', { config: process.env.XDG_CONFIG_HOME });
  dueOnce(p.root); item.install(); assert.equal(item.files().length, 2); assert.deepEqual(item.loaded(), ['elu-code-scheduler.timer']);
  const before = item.calls().length, ran = await item.job(tickScript(item, 'linux', "process.stdout.write('ran to its end\\n');"));
  assert.deepEqual(ran, { status: 0, signal: null, stdout: 'fired 1\nran to its end\n', stderr: '' });
  assert.deepEqual(item.files(), []); assert.deepEqual(item.loaded(), []);
  assert.deepEqual(item.calls().slice(before).map(call => call.args), [['--user', 'disable', '--now', 'elu-code-scheduler.timer']], 'the timer only: the service that runs is never stopped');
});

test("the tick leaves the login item while a schedule is on, a task's or a bot's, and has it removed once none is", async t => {
  home(t); const p = project(t), repo = repository(p.root), item = standIn(t, 'darwin'), plist = path.join(item.home, 'Library', 'LaunchAgents', 'dev.elu-code.scheduler.plist');
  registerProject(repo);
  const tick = () => scheduleTick(new Date(), { start: () => true, item: item.options }), there = () => item.files().length === 1 && item.loaded().length === 1;
  const gone = async () => { await until(() => !item.loaded().length, 'the bootout'); return !item.files().length; };
  dueOnce(p.root); const hourly = saveSchedule({ root: p.root, goal: 'Lint', when: parseWhen('every 1h') });
  item.install();
  // The one-time run fires and is off; the hourly one is still on.
  let ran = tick(); assert.equal(ran.fired, 1); assert.equal(ran.last, null); assert.ok(there());
  // A paused schedule is not on. The removal is handed to the caller, to run after everything else.
  pauseSchedule(hourly.id, true); ran = tick(); assert.equal(ran.fired, 0); assert.ok(there(), 'nothing is removed before the caller is done');
  assert.deepEqual(ran.last(), { removed: true, files: [plist] }); assert.ok(await gone());
  // A bot's schedule that is on in a session keeps the login item; turned off there, it goes.
  saveBot({ name: 'nightly', instructions: 'Check the nightly build.', schedule: 'every 1h' });
  liveTask(p.root, { id: '4', goal: 'Trim coupon codes', state: 'answered' }); saveTask(repo, { ...readTask(repo, '4'), bots: ['nightly'] });
  fs.writeFileSync(path.join(taskDir(repo, '4'), 'bot-schedules.json'), JSON.stringify({ version: 1, bots: { nightly: { on: true, schedule: 'every 1h', nextRunAt: new Date(Date.now() + 3600000).toISOString(), lastRunAt: null, lastRequestId: null, runs: 0, note: null } } }));
  item.install(); ran = tick(); assert.equal(ran.fired, 0); assert.equal(ran.last, null); assert.ok(there());
  setBotSchedule(repo, '4', 'nightly', false); ran = tick(); assert.equal(typeof ran.last, 'function'); ran.last(); assert.ok(await gone());
  // The real unloaders are refused inside the test runner, for the tick's own removal too.
  assert.throws(() => scheduleTick(new Date(), { start: () => true, item: { platform: 'darwin', home: item.home } }).last(), /Tests must not install login items/);
});

// What 0.1.19 wrote as the service file: the same text without the KillMode line.
const from019 = text => text.replace('KillMode=process\n', '');
// A repeating schedule that is due now and stays on after it runs: saved two hours ago.
const dueHourly = (root, goal = 'Check the build') => { const then = new Date(Date.now() - 2 * 3600000); return saveSchedule({ root, goal, when: parseWhen('every 1h') }, then); };

test('on Linux the service file has systemd leave what a tick started, and one from 0.1.19 is written and read again when ELU asks for the login item', t => {
  home(t); const item = standIn(t, 'linux'), [service, timer] = schedulerFiles(item.options);
  item.install();
  const text = fs.readFileSync(service, 'utf8'), timerText = fs.readFileSync(timer, 'utf8');
  assert.match(text, /^\[Unit\]\nDescription=ELU schedules\n\n\[Service\]\nType=oneshot\nKillMode=process\nExecStart=\S+ \S+ schedule tick\nEnvironment=/);
  assert.equal(item.units()['elu-code-scheduler.service'], text, 'systemd read it');
  // 0.1.19's file is on disk and loaded. Asked for again, as at each start with a schedule on, it is replaced and read again.
  fs.writeFileSync(service, from019(text)); item.run('systemctl', ['--user', 'daemon-reload']);
  assert.doesNotMatch(item.units()['elu-code-scheduler.service'], /KillMode/);
  const before = item.calls().length;
  assert.deepEqual(item.install(), { installed: true, changed: true, files: [service, timer] });
  assert.equal(fs.readFileSync(service, 'utf8'), text); assert.equal(fs.readFileSync(timer, 'utf8'), timerText);
  assert.deepEqual(item.calls().slice(before).map(call => call.args), [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'elu-code-scheduler.timer']]);
  assert.equal(item.units()['elu-code-scheduler.service'], text, 'systemd holds the new text'); assert.deepEqual(item.loaded(), ['elu-code-scheduler.timer']);
  assert.equal(item.install().changed, false); assert.equal(item.calls().length, before + 2);
  // The plist needs no such line: launchd ends only the rest of the job's process group.
  const mac = standIn(t, 'darwin'); mac.install(); assert.doesNotMatch(fs.readFileSync(mac.files()[0], 'utf8'), /AbandonProcessGroup/);
});

test('on Linux a tick that finds a service file from 0.1.19 adds the line and has systemd read the file again before it starts anything', async t => {
  home(t); const p = project(t), item = standIn(t, 'linux', { config: process.env.XDG_CONFIG_HOME }), [service, timer] = schedulerFiles(item.options);
  dueHourly(p.root); item.install();
  const text = fs.readFileSync(service, 'utf8'), timerText = fs.readFileSync(timer, 'utf8'), seen = path.join(item.home, 'seen.json'), held = path.join(path.dirname(item.home), 'store', 'units.json');
  fs.writeFileSync(service, from019(text)); item.run('systemctl', ['--user', 'daemon-reload']);
  const before = item.calls().length;
  // The tick's start of the conductor notes what the file says and what systemd holds at that moment.
  const tick = script(item, 'tick-order.mjs', [
    "import fs from 'node:fs';",
    `import { scheduleTick } from ${lib('bot-schedules.mjs')};`,
    `const start = () => { fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ file: fs.readFileSync(${JSON.stringify(service)}, 'utf8'), held: JSON.parse(fs.readFileSync(${JSON.stringify(held)}, 'utf8'))['elu-code-scheduler.service'] })); return true; };`,
    "const { fired, last } = scheduleTick(new Date(), { start, item: { platform: 'linux' } });",
    'process.stdout.write(`fired ${fired}, to remove: ${Boolean(last)}\\n`);',
  ]);
  assert.deepEqual(await item.job(tick), { status: 0, signal: null, stdout: 'fired 1, to remove: false\n', stderr: '' });
  assert.deepEqual(JSON.parse(fs.readFileSync(seen, 'utf8')), { file: text, held: text }, 'the line was there, and read, before the conductor was started');
  assert.deepEqual(item.calls().slice(before), [{ name: 'systemctl', args: ['--user', 'daemon-reload'], fromJob: true }], 'one reload, from within the service; the timer is not touched');
  assert.equal(fs.readFileSync(timer, 'utf8'), timerText); assert.deepEqual(item.loaded(), ['elu-code-scheduler.timer']);
  // It is now the file ELU itself writes, so the next start changes nothing; and the next tick asks for nothing.
  assert.equal(item.install().changed, false);
  fs.rmSync(seen); await item.job(tick); assert.equal(item.calls().length, before + 1); assert.equal(fs.existsSync(seen), false, 'nothing was due, so nothing was started');
});

// The exact case: ELU is closed, the login item's run queues the last one-time schedule,
// starts the conductor, removes the login item and ends. What the system then does with the
// processes that run left is what the stand-in does (see job in login-item-helpers.mjs).
for (const platform of ['linux', 'darwin']) {
  const system = platform === 'linux' ? 'systemd, from a service file 0.1.19 wrote' : 'launchd';
  // On a Mac the conductor would start the real caffeinate, and what a service leaves is found through /proc.
  test(`a schedule that fires while ELU is closed: the run its tick starts finishes after the tick has ended (${system})`, { timeout: 120000, skip: process.platform !== 'linux' && 'The stand-in follows the processes a run leaves on Linux only.' }, async t => {
    home(t); const p = project(t), repo = repository(p.root), item = standIn(t, platform, { config: process.env.XDG_CONFIG_HOME });
    registerProject(repo); fakeClis(path.dirname(item.home), { mode: 'answer' });
    const row = dueOnce(p.root); item.install();
    if (platform === 'linux') {
      const [service] = schedulerFiles(item.options);
      fs.writeFileSync(service, from019(fs.readFileSync(service, 'utf8'))); item.run('systemctl', ['--user', 'daemon-reload']);
      assert.doesNotMatch(item.units()['elu-code-scheduler.service'], /KillMode/, 'systemd holds the service as 0.1.19 wrote it');
    }
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms)), settled = async ms => { for (const started = Date.now(); item.left().length && Date.now() - started < ms;) await pause(50); return !item.left().length; };
    try {
      const tick = script(item, 'tick-real.mjs', [`import { scheduleTick } from ${lib('bot-schedules.mjs')};`, `const { fired, last } = scheduleTick(new Date(), { item: { platform: '${platform}' } });`, 'process.stdout.write(`fired ${fired}\\n`);', 'last?.();']);
      const ran = await item.job(tick);
      assert.equal(ran.stdout, 'fired 1\n'); assert.equal(ran.stderr, '');
      // On macOS its own bootout ended it; on Linux it disabled its timer and ran to its end.
      assert.deepEqual([ran.status, ran.signal], platform === 'darwin' ? [null, 'SIGTERM'] : [0, null]);
      await until(() => !item.loaded().length, 'the login item to be unloaded'); assert.deepEqual(item.files(), [], 'the last schedule ran, so the login item is gone: no later tick will start a conductor');
      // The tick is over and the system has ended what it does not leave. The run goes on to its answer.
      await until(() => projectSnapshot(repo).tasks[0]?.state === 'answered', 'the scheduled run to finish after its tick ended', 90000);
      assert.equal(String(pendingRequests(p.root).find(request => request.scheduleId === row.id)?.taskId), String(projectSnapshot(repo).tasks[0].id), 'it is the run the schedule queued');
      assert.ok(item.left().includes(conductorStatus().pid), 'the conductor that runs is the one the tick started');
    } finally {
      // That conductor is a real one. It is stopped before the test's folders go, whatever happened.
      spawnSync(process.execPath, [CLI, 'conductor', 'stop'], { env: item.jobEnv(), timeout: 30000 });
      if (!await settled(10000)) { for (const pid of item.left()) { try { process.kill(pid, 'SIGTERM'); } catch { /* It has ended. */ } } }
      if (!await settled(10000)) { for (const pid of item.left()) { try { process.kill(pid, 'SIGKILL'); } catch { /* It has ended. */ } } }
    }
  });
}

test('a schedule saved just as a tick is about to remove the login item keeps it', t => {
  home(t); const p = project(t), item = standIn(t, 'linux');
  dueOnce(p.root); item.install();
  // The tick fires the last one-time run. Nothing is on, so it hands back the removal, to run last.
  const ran = scheduleTick(new Date(), { start: () => true, item: item.options }); assert.equal(typeof ran.last, 'function');
  // In that instant ELU, open, saves a schedule and asks for the login item, which is still there.
  saveSchedule({ root: p.root, goal: 'Lint', when: parseWhen('every 1h') }); assert.equal(item.install().changed, false);
  const before = item.calls().length;
  assert.deepEqual(ran.last(), { removed: false }, 'asked again as it removes: a schedule is on');
  assert.equal(item.files().length, 2); assert.deepEqual(item.loaded(), ['elu-code-scheduler.timer']); assert.equal(item.calls().length, before, 'systemd was asked for nothing');
});

test('an install that comes while the login item is being removed waits for the removal, then loads it again', async t => {
  home(t); const p = project(t), item = standIn(t, 'linux', { config: process.env.XDG_CONFIG_HOME });
  dueOnce(p.root); item.install();
  // The tick's removal is held inside systemctl: it has looked, found no schedule on, and is at work.
  fs.writeFileSync(item.hold, '');
  const before = item.calls().length, running = item.job(tickScript(item, 'linux', ''));
  await until(() => item.calls().length > before, 'the tick to ask systemd to disable its timer');
  assert.deepEqual(item.calls().at(-1), { name: 'systemctl', args: ['--user', 'disable', '--now', 'elu-code-scheduler.timer'], fromJob: true });
  // ELU, open, saves a schedule now and asks for the login item. Its files are still there, the same as it would write.
  saveSchedule({ root: p.root, goal: 'Lint', when: parseWhen('every 1h') });
  spawn('sh', ['-c', 'sleep 0.3; rm -f "$0"', item.hold], { stdio: 'ignore' }).unref();
  assert.equal(item.install().changed, true, 'it did not take the files that were about to go for its own: it waited, then wrote and loaded them');
  assert.deepEqual(await running, { status: 0, signal: null, stdout: 'fired 1\n', stderr: '' });
  assert.equal(item.files().length, 2); assert.deepEqual(item.loaded(), ['elu-code-scheduler.timer']);
  assert.deepEqual(item.calls().slice(before).map(call => call.args[1]), ['disable', 'daemon-reload', 'enable'], 'the removal first, whole, then the install');
});

test('on Linux a timer that is still loaded after its files went is stopped by its own next run with nothing on', async t => {
  home(t); project(t); const item = standIn(t, 'linux', { config: process.env.XDG_CONFIG_HOME });
  item.install();
  const link = path.join(path.dirname(item.files()[1]), 'timers.target.wants', 'elu-code-scheduler.timer'), linked = () => { try { return fs.lstatSync(link).isSymbolicLink(); } catch { return false; } };
  assert.ok(linked(), 'enabling it linked it');
  // The files go without a disable. systemd still holds the timer, and goes on starting the service every minute.
  for (const file of item.files()) fs.rmSync(file);
  assert.deepEqual(item.loaded(), ['elu-code-scheduler.timer']); assert.ok(linked());
  // ELU, open, finds nothing to remove and asks systemd for nothing: the timer's own run ends it.
  const before = item.calls().length; assert.deepEqual(item.uninstall(), { removed: false }); assert.equal(item.calls().length, before);
  const tick = tickScript(item, 'linux', '');
  assert.deepEqual(await item.job(tick), { status: 0, signal: null, stdout: 'fired 0\n', stderr: '' });
  assert.deepEqual(item.calls().slice(before), [{ name: 'systemctl', args: ['--user', 'stop', 'elu-code-scheduler.timer'], fromJob: true }], 'stopped: disable fails on a unit with no file');
  assert.deepEqual(item.loaded(), []); assert.equal(linked(), false, 'the link that enabled it is gone too');
  // Run by hand with nothing loaded, the stop fails and the run still ends well. Asked for again, the login item loads.
  assert.deepEqual(await item.job(tick), { status: 0, signal: null, stdout: 'fired 0\n', stderr: '' });
  assert.equal(item.install().changed, true); assert.deepEqual(item.loaded(), ['elu-code-scheduler.timer']); assert.ok(linked());
});

test('a login item that could not be loaded leaves no files that would read as loaded, so the next ask loads it', t => {
  home(t);
  for (const [platform, verb] of [['darwin', 'bootstrap'], ['linux', 'enable']]) {
    const item = standIn(t, platform);
    const failing = (name, args, more) => { if (args.includes(verb)) throw new Error(`${name} could not load the scheduler: it is busy`); return item.run(name, args, more); };
    assert.throws(() => item.install({ run: failing }), /could not load the scheduler: it is busy/);
    assert.deepEqual(item.files(), [], `${platform}: nothing is left of the try`); assert.deepEqual(item.loaded(), []);
    assert.equal(item.install().changed, true, `${platform}: asked again, it is written and loaded`); assert.equal(item.loaded().length, 1);
  }
});
