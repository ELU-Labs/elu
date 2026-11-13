// The stand-in for launchctl and systemctl that the login item tests put first on PATH
// (standIn in test/login-item-helpers.mjs copies it there under both names). A scratch HOME
// does not keep the real ones away from the real login items, so no test calls them.
// It answers only the calls lib/schedules.mjs makes, as the real programs do:
//   launchctl bootstrap gui/UID FILE   loads it; exit 5 when FILE is missing or already loaded
//   launchctl bootout gui/UID FILE     unloads it; exit 5 when it is not loaded
//   launchctl bootout gui/UID/LABEL    unloads what was loaded with that Label; exit 3 when nothing is
//   systemctl --user daemon-reload        reads every unit file again
//   systemctl --user enable --now UNIT    exit 1 when the unit file does not exist; links it under timers.target.wants
//   systemctl --user disable --now UNIT   exit 1 when the unit file does not exist, and the unit stays loaded
//   systemctl --user stop UNIT            unloads it, with or without its file; exit 5 when it is not loaded
// (Checked against systemd 255: a timer whose files were deleted goes on starting its service,
// disable --now fails on it and changes nothing, stop ends it.)
// systemd acts on a unit file as it last read it, which is when it first loads the unit and at
// each daemon-reload: units.json holds that text for each unit. job in the helpers reads it
// when a run ends, to do what systemd does with the processes the run left.
// A bootout also ends the login item's job when one runs, as launchd does: SIGTERM to its
// whole process group, so a job that asks for its own bootout ends there, and the launchctl
// it waits for with it. Disabling a unit ends a job of that unit the same way; a timer has
// none, so its service runs on.
// What is loaded is kept in $FAKE_LOGIN_ITEM_STORE/loaded.json, the Label of each loaded
// file in labels.json, and every call is appended to calls.jsonl. jobs.json names the job
// that runs now, { LABEL or UNIT: its process group }; job in the helpers writes it. A call
// made from inside that process group is marked fromJob: the real program would be ended
// with the job, which is why the login item's own bootout is started in a group of its own.
// FAKE_LOGIN_ITEM_HOLD names a file: while it is there, a call waits before it acts, having
// recorded itself, so a test can do something while the real program would still be at work.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const name = path.basename(process.argv[1]), args = process.argv.slice(2), store = process.env.FAKE_LOGIN_ITEM_STORE;
const fail = (code, text) => { process.stderr.write(`${text}\n`); process.exit(code); };
if (!store) fail(64, 'FAKE_LOGIN_ITEM_STORE is not set.');
const read = (file, empty) => { try { return JSON.parse(fs.readFileSync(path.join(store, file), 'utf8')); } catch { return empty; } };
const write = (file, value) => fs.writeFileSync(path.join(store, file), JSON.stringify(value));
const loaded = () => read('loaded.json', []);
const save = rows => write('loaded.json', rows);
const endJob = key => { const group = read('jobs.json', {})[key]; if (Number.isInteger(group)) { try { process.kill(-group, 'SIGTERM'); } catch { /* It has ended. */ } } };
const jobs = Object.values(read('jobs.json', {})), fromJob = jobs.length > 0 && jobs.includes(Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout));
fs.appendFileSync(path.join(store, 'calls.jsonl'), `${JSON.stringify({ name, args, ...(fromJob ? { fromJob } : {}) })}\n`);
if (process.env.FAKE_LOGIN_ITEM_HOLD) while (fs.existsSync(process.env.FAKE_LOGIN_ITEM_HOLD)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);

if (name === 'launchctl') {
  const [verb, domain, target] = args, labels = read('labels.json', {});
  // The job is ended last: it may be the one that asked, and this process with it.
  const unload = file => { const label = labels[file]; delete labels[file]; write('labels.json', labels); save(loaded().filter(row => row !== file)); endJob(label); process.exit(0); };
  const label = verb === 'bootout' && !target ? /^gui\/\d+\/([^/]+)$/.exec(domain ?? '')?.[1] : null;
  if (label) {
    const file = loaded().find(row => labels[row] === label);
    if (!file) fail(3, 'Boot-out failed: 3: No such process');
    unload(file);
  }
  if (!/^gui\/\d+$/.test(domain ?? '') || !target) fail(64, 'Usage: launchctl bootstrap | bootout <domain-target> <service-path>');
  if (verb === 'bootstrap') {
    if (!fs.existsSync(target)) fail(5, `${target}: No such file or directory\nBootstrap failed: 5: Input/output error`);
    if (loaded().includes(target)) fail(5, 'Bootstrap failed: 5: Input/output error');
    write('labels.json', { ...labels, [target]: /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(fs.readFileSync(target, 'utf8'))?.[1] ?? null });
    save([...loaded(), target]); process.exit(0);
  }
  if (verb === 'bootout') {
    if (!loaded().includes(target)) fail(5, 'Boot-out failed: 5: Input/output error');
    unload(target);
  }
  fail(64, `Unrecognized subcommand: ${verb}`);
}
if (name === 'systemctl') {
  if (args[0] !== '--user') fail(1, 'The stand-in answers systemctl --user only.');
  const units = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
  // again: every file is read again. Without it only units that are not held yet are read.
  const readUnits = again => {
    const held = again ? {} : read('units.json', {}); let names = []; try { names = fs.readdirSync(units); } catch { /* No unit files. */ }
    for (const name of names) { if (/\.(service|timer)$/.test(name) && !(name in held)) held[name] = fs.readFileSync(path.join(units, name), 'utf8'); }
    write('units.json', held);
  };
  if (args[1] === 'daemon-reload') { readUnits(true); process.exit(0); }
  if (args[1] === 'stop' && args[2]) {
    if (!loaded().includes(args[2])) fail(5, `Failed to stop ${args[2]}: Unit ${args[2]} not loaded.`);
    save(loaded().filter(row => row !== args[2])); endJob(args[2]); process.exit(0);
  }
  const [, verb, now, unit] = args, link = path.join(units, 'timers.target.wants', unit ?? '');
  if (!['enable', 'disable'].includes(verb) || now !== '--now' || !unit) fail(1, `Unknown command verb ${verb}.`);
  if (!fs.existsSync(path.join(units, unit))) fail(1, `Failed to ${verb} unit: Unit file ${unit} does not exist.`);
  if (verb === 'enable') { readUnits(false); fs.mkdirSync(path.dirname(link), { recursive: true }); fs.rmSync(link, { force: true }); fs.symlinkSync(path.join(units, unit), link); }
  else fs.rmSync(link, { force: true });
  save(verb === 'enable' ? [...new Set([...loaded(), unit])] : loaded().filter(row => row !== unit));
  if (verb === 'disable') endJob(unit);
  process.exit(0);
}
fail(64, `The stand-in is not ${name}.`);
