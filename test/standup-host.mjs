// Another computer of the owner's, for test/standup-now.test.mjs: a process of its own, so it
// has its own XDG_CONFIG_HOME, its own conductor and its own stand-in vendors. It runs the
// project in argv and answers, one JSON line each, what the link between two computers would
// carry for a standup (lib/peer/standup.mjs), and what the test asks about its sessions.
// argv[2] is JSON: { root, asker, slots }. It prints {"ready":true} once the conductor runs and
// stops when stdin closes.
import fs from 'node:fs';
import readline from 'node:readline';
import { Conductor, conductorStatus, enqueue, saveConductorSettings } from '../lib/conductor.mjs';
import { hostStandup, hostStandupRead, hostStandupStop } from '../lib/peer/standup.mjs';
import { registerProject } from '../lib/projects.mjs';
import { pendingRequests, projectFolder } from '../lib/workspace.mjs';
import { readTask, tasks } from '../lib/state.mjs';
import { hash } from '../lib/util.mjs';

const options = JSON.parse(process.argv[2] ?? '{}');
const repo = projectFolder(options.root); registerProject(repo);
saveConductorSettings({ maxAgents: options.slots ?? 1 });
const conductor = new Conductor({ tickMs: 50, idleMs: 3600000 }).start();
// A project's key as this computer's listing names it (lib/peer/remote.mjs).
const projectKey = root => hash(`project\0${root}`).slice(0, 16);
const log = task => { try { return task.activeLog ? fs.readFileSync(task.activeLog, 'utf8') : ''; } catch { return ''; } };
const answers = {
  key: () => projectKey(repo.root),
  start: ({ goal, permissions }) => enqueue(repo.root, goal, { permissions }).id,
  sessions: () => tasks(repo).map(task => ({ id: task.id, state: task.state, standupTurn: task.standupTurn ?? null, log: log(task), messages: task.messages ?? [], runs: task.runs ?? [] })),
  session: ({ id }) => { const task = readTask(repo, id); return { id: task.id, state: task.state, standupTurn: task.standupTurn ?? null, log: log(task), messages: task.messages ?? [], runs: task.runs ?? [] }; },
  requests: () => pendingRequests(repo.root),
  runs: () => conductorStatus().runs,
  remoteStandup: params => hostStandup(params, options.asker, { projectKey }),
  remoteStandupRead: params => hostStandupRead(params, options.asker),
  remoteStandupStop: params => hostStandupStop(params, options.asker),
};
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async line => {
  let id = null, out;
  try { const asked = JSON.parse(line); id = asked.id; out = { id, ok: true, result: await answers[asked.type](asked.params ?? {}) }; }
  catch (error) { out = { id, ok: false, error: error.message }; }
  process.stdout.write(`${JSON.stringify(out)}\n`);
});
lines.on('close', async () => { await conductor.stop().catch(() => {}); process.exit(0); });
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
