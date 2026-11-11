import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWhen, nextRun, saveSchedule, listSchedules, runDue, runScheduleNow, pauseSchedule, removeSchedule, installScheduler, uninstallScheduler } from '../lib/schedules.mjs';
import { enqueue } from '../lib/conductor.mjs';
import { pendingRequests, updateRequest } from '../lib/workspace.mjs';
import { project } from './helpers.mjs';

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

test('a schedule runs with Ask or Approve for me, never Full access', t => {
  home(t); const p = project(t), start = () => true, when = () => parseWhen('every 1h', at(9, 8));
  assert.throws(() => saveSchedule({ root: p.root, goal: 'Lint', when: when(), permissions: 'full' }, at(9, 8)), /Approve for me at most/);
  assert.throws(() => saveSchedule({ root: p.root, goal: 'Lint', when: when(), permissions: 'locked' }, at(9, 8)), /Choose ask, auto, or full/);
  const row = saveSchedule({ root: p.root, goal: 'Lint', when: when(), permissions: 'auto' }, at(9, 8));
  assert.equal(row.permissions, 'auto'); assert.equal(listSchedules()[0].permissions, 'auto');
  assert.equal(saveSchedule({ root: p.root, goal: 'Plain', when: when() }, at(9, 8)).permissions, null);
  assert.equal(runDue(at(9, 10), { start }), 2);
  const requests = pendingRequests(p.root);
  assert.equal(requests.find(request => request.scheduleId === row.id).permissions, 'auto');
  assert.equal('permissions' in requests.find(request => request.scheduleId !== row.id), false);
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
