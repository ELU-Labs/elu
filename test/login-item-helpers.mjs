import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installScheduler, uninstallScheduler, schedulerFiles } from '../lib/schedules.mjs';

const FAKE = fileURLToPath(new URL('./fakes/login-item.mjs', import.meta.url));
// What the stand-in knows a running job by: the Label of the plist, the service of the timer.
const JOB = { darwin: 'dev.elu-code.scheduler', linux: 'elu-code-scheduler.service' };
// The real installer for one system, with the stand-in launchctl and systemctl first on
// PATH and a scratch home: what a test hands the app as its login item. files: the login
// item's files that exist. loaded: what the stand-in holds as loaded. calls: every call it got.
// options: what the installer takes to work there, for code that calls it by itself.
// config: the XDG_CONFIG_HOME the login item is given, when its runs must find what the test saved.
export function standIn(t, platform = 'darwin', { config = null } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-login-item-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), store = path.join(dir, 'store'), home = path.join(dir, 'home');
  for (const folder of [bin, store, home]) fs.mkdirSync(folder);
  for (const name of ['launchctl', 'systemctl']) fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${fs.readFileSync(FAKE, 'utf8')}`, { mode: 0o755 });
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: config ?? path.join(home, '.config') };
  const mine = () => ({ ...process.env, ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_LOGIN_ITEM_STORE: store });
  const run = (name, args, { allowFailure = false } = {}) => {
    const result = spawnSync(name, args, { encoding: 'utf8', timeout: 15000, env: mine() });
    if (result.status !== 0 && !allowFailure) throw new Error(`${name} could not load the scheduler: ${(result.stderr || result.error?.message || '').trim()}`);
  };
  // Started and not waited for, as the login item's own removal starts its bootout.
  const detached = (name, args) => { spawn(name, args, { detached: true, stdio: 'ignore', env: mine() }).unref(); };
  const options = { platform, home, env, run, detached };
  const read = (name, parse) => { try { return parse(fs.readFileSync(path.join(store, name), 'utf8')); } catch { return []; } };
  // One run of the login item, started the way launchd and systemd start it: in a process
  // group of its own, with the environment its file gives it and no more (the time zone and
  // locale are this test's, so a lock held here reads the same there). The stand-ins are
  // first on its PATH, and while it runs they know it as the login item's job, so its bootout
  // ends it as launchd would. command: what the item's file names, or a script in its place.
  // Gives how it ended and what it printed. Only for a run that leaves no task schedule on:
  // nothing here keeps a Mac from starting its real caffeinate for one (lib/awake.mjs).
  const job = command => new Promise((resolve, reject) => {
    const place = Object.fromEntries(['TZ', 'LANG', 'LC_ALL', 'COLUMNS'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
    const child = spawn(command[0], command.slice(1), { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...place, ...env, PATH: `${bin}${path.delimiter}${env.PATH}`, FAKE_LOGIN_ITEM_STORE: store } });
    fs.writeFileSync(path.join(store, 'jobs.json'), JSON.stringify({ [JOB[platform]]: child.pid }));
    let stdout = '', stderr = ''; child.stdout.on('data', text => { stdout += text; }); child.stderr.on('data', text => { stderr += text; });
    child.once('error', reject);
    child.once('close', (status, signal) => { fs.rmSync(path.join(store, 'jobs.json'), { force: true }); resolve({ status, signal, stdout, stderr }); });
  });
  return {
    home, env, run, detached, job, options,
    install: (more = {}) => installScheduler({ ...options, lasting: true, ...more }),
    uninstall: (more = {}) => uninstallScheduler({ ...options, ...more }),
    files: () => schedulerFiles(options).filter(target => fs.existsSync(target)),
    loaded: () => read('loaded.json', JSON.parse),
    calls: () => read('calls.jsonl', text => text.trim().split('\n').map(line => JSON.parse(line))),
  };
}
