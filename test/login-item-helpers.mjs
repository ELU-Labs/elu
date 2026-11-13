import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installScheduler, uninstallScheduler, schedulerFiles } from '../lib/schedules.mjs';

const FAKE = fileURLToPath(new URL('./fakes/login-item.mjs', import.meta.url));
// The real installer for one system, with the stand-in launchctl and systemctl first on
// PATH and a scratch home: what a test hands the app as its login item. files: the login
// item's files that exist. loaded: what the stand-in holds as loaded. calls: every call it got.
export function standIn(t, platform = 'darwin') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-login-item-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), store = path.join(dir, 'store'), home = path.join(dir, 'home');
  for (const folder of [bin, store, home]) fs.mkdirSync(folder);
  for (const name of ['launchctl', 'systemctl']) fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${fs.readFileSync(FAKE, 'utf8')}`, { mode: 0o755 });
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  const run = (name, args, { allowFailure = false } = {}) => {
    const result = spawnSync(name, args, { encoding: 'utf8', timeout: 15000, env: { ...process.env, ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_LOGIN_ITEM_STORE: store } });
    if (result.status !== 0 && !allowFailure) throw new Error(`${name} could not load the scheduler: ${(result.stderr || result.error?.message || '').trim()}`);
  };
  const options = { platform, home, env, run };
  const read = (name, parse) => { try { return parse(fs.readFileSync(path.join(store, name), 'utf8')); } catch { return []; } };
  return {
    home, env, run,
    install: (more = {}) => installScheduler({ ...options, lasting: true, ...more }),
    uninstall: () => uninstallScheduler(options),
    files: () => schedulerFiles(options).filter(target => fs.existsSync(target)),
    loaded: () => read('loaded.json', JSON.parse),
    calls: () => read('calls.jsonl', text => text.trim().split('\n').map(line => JSON.parse(line))),
  };
}
