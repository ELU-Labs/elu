import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { CLI } from './helpers.mjs';
import { withHome, registeredProject, answeringClis } from './peer-helpers.mjs';
import { savePeerSettings } from '../lib/peer/settings.mjs';
import * as peer from '../lib/peer/index.mjs';
import { saveBot } from '../lib/bots.mjs';

// End to end through the CLI: two homes (XDG_CONFIG_HOME values), each with its own
// detached peer daemon started by `elu peer on`, on a local hyperdht testnet. B
// answers with the fake vendor CLIs from a shared project.
const require = createRequire(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 120000) {
  const started = Date.now();
  for (;;) {
    let value; try { value = await check(); } catch { value = null; }
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await pause(250);
  }
}
// The CLI runs asynchronously: the testnet lives in this process and must keep serving.
function cli(home, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, '--json'], { cwd: os.tmpdir(), env: { ...process.env, ...env, XDG_CONFIG_HOME: home.dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.once('error', reject);
    child.once('exit', () => {
      clearTimeout(timer);
      let json; try { json = JSON.parse(out); } catch { return reject(new Error(`elu ${args[0]}: invalid output ${out}\n${err}`)); }
      resolve(json);
    });
  });
}
async function ok(home, args, env) {
  const json = await cli(home, args, env);
  if (!json.success) throw new Error(`elu ${args.join(' ')}: ${json.message}\n${log(home)}`);
  return json;
}
const read = (home, ...parts) => { try { return JSON.parse(fs.readFileSync(path.join(home.dir, 'elu-code', ...parts), 'utf8')); } catch { return null; } };
const log = home => { try { return fs.readFileSync(path.join(home.dir, 'elu-code', 'peer', 'daemon.log'), 'utf8').slice(-3000); } catch { return ''; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function command(home, value, timeout = 120000) {
  const { id } = withHome(home.dir, () => peer.sendPeerCommand(value));
  const result = await until(() => read(home, 'peer', 'commands', `${id}.result.json`), `${value.type} result`, timeout);
  if (!result.ok) throw new Error(result.error);
  return result.result;
}
const items = home => withHome(home.dir, () => peer.peerItems());

test('two homes team up, ask, answer, route a local A2A call through the CLI, share a channel and ask a shared bot', { timeout: 600000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-e2e-')));
  const homes = { a: { dir: path.join(root, 'a') }, b: { dir: path.join(root, 'b') } };
  let net = null;
  // Registered first, so it runs before the project folders' own cleanup: daemons and
  // conductors stop, then the testnet goes, then the homes are removed.
  t.after(async () => {
    for (const home of Object.values(homes)) {
      await cli(home, ['peer', 'off']).catch(() => {}); await cli(home, ['conductor', 'stop']).catch(() => {});
    }
    const pids = Object.values(homes).flatMap(home => [read(home, 'peer', 'state.json')?.pid, read(home, 'peer', 'peer.lock')?.pid, read(home, 'conductor', 'state.json')?.pid, read(home, 'conductor.lock')?.pid]).filter(Number.isInteger);
    await until(() => pids.every(pid => !alive(pid)), 'daemons to exit', 15000).catch(() => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* Gone. */ } } });
    if (net) await Promise.race([net.destroy(), pause(10000)]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const createTestnet = require('hyperdht/testnet.js');
  net = await createTestnet(3, { host: '127.0.0.1' });
  const bootstrap = net.bootstrap.map(node => `${node.host}:${node.port}`);
  for (const home of Object.values(homes)) withHome(home.dir, () => savePeerSettings({ bootstrap }));
  withHome(homes.a.dir, () => savePeerSettings({ localA2A: true }));
  // B's project, registered in B's home, answered by the fake CLIs on B's PATH.
  const side = withHome(homes.b.dir, () => registeredProject(t));
  const fake = answeringClis(side.parent), env = { PATH: fake.env.PATH };

  // Identities, a team, an invite and a network join.
  const a = (await ok(homes.a, ['id', '--name', 'a'])).identity, b = (await ok(homes.b, ['id', '--name', 'b'])).identity;
  const team = (await ok(homes.a, ['team', 'create', 'core'])).team;
  await ok(homes.a, ['peer', 'on']);
  const { invite } = await ok(homes.a, ['invite', '--hours', '1']);
  assert.match(invite.code, /^elu-team:v1:/); assert.equal(invite.project, null, 'A invites from outside a project');
  // B joins from its project, which becomes the team's project on B.
  const joined = await ok(homes.b, ['join', invite.code, '--project', side.root]);
  assert.deepEqual(joined.team, { id: team.id, name: 'core', project: 'sample-app' });
  // The daemon's heartbeat shows the new member within a tick.
  await until(async () => (await ok(homes.a, ['team'])).teams[0].members.map(m => m.name).join() === 'a,b', 'b on a\'s roster');

  // B shares the project and comes online; A asks.
  const shared = await ok(homes.b, ['share', side.root, '--as', 'app']);
  assert.equal(shared.share.handle, 'app'); assert.deepEqual(read(homes.b, 'peer', 'team-projects.json'), { [team.id]: 'app' }, 'the rename follows');
  await ok(homes.b, ['peer', 'on'], env);
  await until(async () => (await ok(homes.a, ['peers'])).peer.teams[0].members.find(m => m.key === b.key)?.online, 'b online at a');
  // The ask names no project: B answers about the team's project.
  const asked = await ok(homes.a, ['ask', '@b', 'Where is coupon normalization?']);
  assert.match(asked.askId, /^[a-f0-9-]{36}$/);

  // B accepts through a facade command; the reply goes back into the thread with no second step.
  const incoming = await until(() => items(homes.b).find(row => row.kind === 'incoming'), 'incoming ask at b');
  assert.equal(incoming.name, 'a'); assert.equal(incoming.project, 'app');
  await command(homes.b, { type: 'accept', id: incoming.id });
  const replied = await until(() => items(homes.b).find(row => row.kind === 'replied'), `reply sent at b\n${log(homes.b)}`, 240000);
  assert.match(replied.text, /add multiple agents/);

  // A sees the answer.
  const answer = await until(async () => (await ok(homes.a, ['peers'])).items.find(row => row.kind === 'answer'), 'answer at a', 240000);
  assert.equal(answer.name, 'b'); assert.match(answer.text, /add multiple agents/);

  // A's local A2A endpoint turns a SendMessage at /a2a/peer/b into an ask and returns a Task.
  const local = await until(() => read(homes.a, 'peer', 'local-a2a.json'), 'local A2A state');
  const response = await fetch(`http://127.0.0.1:${local.port}/a2a/peer/b`, {
    method: 'POST', headers: { authorization: `Bearer ${local.token}`, 'content-type': 'application/json', 'a2a-version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { role: 'ROLE_USER', messageId: 'local-1', parts: [{ text: 'Is the coupon test flaky?' }] } } }),
  });
  assert.equal(response.status, 200);
  const rpc = await response.json();
  assert.equal(rpc.id, 1); assert.ok(rpc.result?.task, JSON.stringify(rpc));
  assert.match(rpc.result.task.id, /^[a-f0-9-]{36}$/);
  assert.equal(rpc.result.task.status.state, 'TASK_STATE_SUBMITTED');
  const forwarded = await until(() => items(homes.b).find(row => row.kind === 'incoming' && row.text === 'Is the coupon test flaky?'), 'local A2A ask at b');
  assert.equal(forwarded.name, 'a');

  // A makes a channel with B. It is a signed roster change, so B's machine gets it, and a question in it arrives with its room.
  const { id: channel } = await command(homes.a, { type: 'channelSet', team: team.id, name: 'design', members: [a.key, b.key] });
  assert.match(channel, /^[0-9a-f]{16}$/);
  await until(() => withHome(homes.b.dir, () => peer.peerStatus()).teams[0].channels?.some(row => row.id === channel && row.name === 'design' && row.members.length === 2), `the channel at b\n${log(homes.b)}`);
  await command(homes.a, { type: 'teamAsk', text: 'Which tokens does the header use?', team: team.id, channel });
  const roomed = await until(() => items(homes.b).find(row => row.kind === 'incoming' && row.text === 'Which tokens does the header use?'), 'channel question at b');
  assert.deepEqual(roomed.room, { team: team.id, channel }); assert.equal(roomed.team, true);
  assert.deepEqual(withHome(homes.a.dir, () => peer.peerItems()).find(row => row.text === 'Which tokens does the header use?')?.room, { team: team.id, channel }, 'A keeps the thread in its channel');

  // B names its machine and shares a bot while both are connected: A hears it within a few ticks. A asks that bot, and B's waiting question says which bot it is for.
  const bOf = home => withHome(home.dir, () => peer.peerStatus()).teams[0].members.find(m => m.key === b.key);
  assert.deepEqual(bOf(homes.a).bots, [], 'nothing is shared yet');
  withHome(homes.b.dir, () => { savePeerSettings({ box: 'b-studio' }); saveBot({ name: 'reviewer', about: 'Reviews a diff.', instructions: 'Review the diff you are given.', shared: true }); saveBot({ name: 'private', instructions: 'Only for B.' }); });
  const seen = await until(() => { const member = bOf(homes.a); return member.box === 'b-studio' && member.bots.length && member; }, `b's bot at a\n${log(homes.a)}`);
  assert.deepEqual(seen.bots, [{ name: 'reviewer', about: 'Reviews a diff.' }]); assert.equal(seen.online, true);
  assert.equal(withHome(homes.b.dir, () => peer.peerStatus()).box, 'b-studio'); assert.deepEqual(bOf(homes.b).bots, seen.bots);
  await command(homes.a, { type: 'ask', to: 'b', text: 'Is this diff safe to merge?', bot: 'reviewer' });
  const forBot = await until(() => items(homes.b).find(row => row.kind === 'incoming' && row.text === 'Is this diff safe to merge?'), `bot question at b\n${log(homes.b)}`);
  assert.equal(forBot.bot, 'reviewer'); assert.equal(forBot.name, 'a');
  assert.equal(items(homes.a).find(row => row.text === 'Is this diff safe to merge?')?.bot, 'reviewer', 'A keeps which bot it asked');
  // A bot B keeps private is refused, with the reason in A's thread.
  await command(homes.a, { type: 'ask', to: 'b', text: 'And yours?', bot: 'private' });
  const refused = await until(() => items(homes.a).find(row => row.kind === 'rejected' && row.question === 'And yours?'), 'the refusal at a');
  assert.equal(refused.text, 'That bot is not shared with teammates.'); assert.equal(refused.bot, 'private');
});
