// The stand-in for launchctl and systemctl that the login item tests put first on PATH
// (standIn in test/login-item-helpers.mjs copies it there under both names). A scratch HOME
// does not keep the real ones away from the real login items, so no test calls them.
// It answers only the calls lib/schedules.mjs makes, as the real programs do:
//   launchctl bootstrap gui/UID FILE   loads it; exit 5 when FILE is missing or already loaded
//   launchctl bootout gui/UID FILE     unloads it; exit 5 when it is not loaded
//   systemctl --user daemon-reload
//   systemctl --user enable --now UNIT    exit 1 when the unit file does not exist
//   systemctl --user disable --now UNIT   exit 1 when the unit file does not exist
// What is loaded is kept in $FAKE_LOGIN_ITEM_STORE/loaded.json, and every call is appended
// to $FAKE_LOGIN_ITEM_STORE/calls.jsonl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const name = path.basename(process.argv[1]), args = process.argv.slice(2), store = process.env.FAKE_LOGIN_ITEM_STORE;
const fail = (code, text) => { process.stderr.write(`${text}\n`); process.exit(code); };
if (!store) fail(64, 'FAKE_LOGIN_ITEM_STORE is not set.');
const file = path.join(store, 'loaded.json');
const loaded = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } };
const save = rows => fs.writeFileSync(file, JSON.stringify(rows));
fs.appendFileSync(path.join(store, 'calls.jsonl'), `${JSON.stringify({ name, args })}\n`);

if (name === 'launchctl') {
  const [verb, domain, target] = args;
  if (!/^gui\/\d+$/.test(domain ?? '') || !target) fail(64, 'Usage: launchctl bootstrap | bootout <domain-target> <service-path>');
  if (verb === 'bootstrap') {
    if (!fs.existsSync(target)) fail(5, `${target}: No such file or directory\nBootstrap failed: 5: Input/output error`);
    if (loaded().includes(target)) fail(5, 'Bootstrap failed: 5: Input/output error');
    save([...loaded(), target]); process.exit(0);
  }
  if (verb === 'bootout') {
    if (!loaded().includes(target)) fail(5, 'Boot-out failed: 5: Input/output error');
    save(loaded().filter(row => row !== target)); process.exit(0);
  }
  fail(64, `Unrecognized subcommand: ${verb}`);
}
if (name === 'systemctl') {
  if (args[0] !== '--user') fail(1, 'The stand-in answers systemctl --user only.');
  if (args[1] === 'daemon-reload') process.exit(0);
  const [, verb, now, unit] = args, units = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
  if (!['enable', 'disable'].includes(verb) || now !== '--now' || !unit) fail(1, `Unknown command verb ${verb}.`);
  if (!fs.existsSync(path.join(units, unit))) fail(1, `Failed to ${verb} unit: Unit file ${unit} does not exist.`);
  save(verb === 'enable' ? [...new Set([...loaded(), unit])] : loaded().filter(row => row !== unit)); process.exit(0);
}
fail(64, `The stand-in is not ${name}.`);
