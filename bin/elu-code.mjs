#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { repository, findRepository } from '../lib/git.mjs';
import { initPlan, applyInit, uninstallPlan, applyUninstall } from '../lib/init.mjs';
import { runPlan, runTask } from '../lib/runner.mjs';
import { readTask, saveTask, taskDir, tasks, lock } from '../lib/state.mjs';
import { runChecks } from '../lib/checks.mjs';
import { policyReport, assertPolicy } from '../lib/policy.mjs';
import { unsupportedVendors } from '../lib/detect.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import { preparePublish, publish, prBody } from '../lib/publish.mjs';
import { refuse, quote, readJson, noSymlinks } from '../lib/util.mjs';
import { recoverProcess, addUserBin } from '../lib/process.mjs';
import {formatResult}from'../lib/format.mjs';
import {botKey}from'../lib/bots.mjs';
import { sweepServers } from '../lib/mcp.mjs';

addUserBin();
// MCP settings a run could not remove because its process died (lib/mcp.mjs).
sweepServers();
// Peer commands load lib/peer/ only when used; it never imports the optional packages at load time.
const PEER_COMMANDS = new Set(['id', 'team', 'invite', 'join', 'access', 'share', 'unshare', 'peers', 'peer', 'ask', 'relay', 'mine']);
const HELP = `ELU — terminal coding workspace\n\nRun elu anywhere to open the terminal app.\nThe first start asks for a project name; later starts open your last project.\nSessions lists every session; type a message to start one.\nKanban shows the open project's tasks. Chats holds your channels and direct messages. Type / for commands and help.\nEditing workspaces are prepared automatically. Pushes require separate approval.\n\nCommands:\n  update\n  conductor [stop]\n  schedule [list]\n  dashboard\n  init [--yes] [--dry-run]\n  run <goal> [--yes] [--dry-run] [--permissions auto|full] [--place here|branch:NAME] [--folder PATH]...\n  run <id> --publish [--approve-push <confirmationId>]\n  status [id] [--recover]\n  open <id> [--bot NAME] [--exec]\n  check <id>\n  policy show\n  permissions [list|remove N|on N]\n  allow-home <session>\n  uninstall [--yes] [--dry-run]\n\nSessions and schedules (in your shell, and in a session's):\n  sessions [--all] | sessions archive N|this | sessions unarchive N\n  sessions rename N|this NAME | sessions new MESSAGE [--mode ask|auto|full]\n  sessions delete N|archived [--learn]\n  schedules [--all] | schedules add WHEN MESSAGE [--mode ask|auto|full]\n  schedules pause|resume|delete|run N\n\nMCP servers (Claude Code's own; a key is asked for, never an argument):\n  mcp [list]\n  mcp add NAME URL [--header NAME] | mcp add NAME [--env NAME] -- COMMAND [ARGS]...\n  mcp remove NAME [--yes]\n\nPeer network:\n  id [--name N] [--export] [--import CODE]\n  team create NAME | team | team leave [TEAM] | team remove NAME [--team ID]\n  invite [--team ID] [--hours N] [--project PATH] [--auto|--manual] [--rules TEXT] [--mine]\n  join CODE [--project PATH] [--auto|--manual] [--rules TEXT] [--mine]\n  access [--team ID] [--auto|--manual] [--rules TEXT] [--project PATH]\n  mine [@NAME | remove @NAME | auto on|off]\n  share [PATH] [--as HANDLE] [--no-status] | unshare HANDLE\n  peers\n  peer off | peer install|uninstall | peer trust|untrust @NAME\n  ask [@NAME] [--project H] TEXT\n  relay [--team ID]\n\nEvery command accepts --json. --dry-run prints the proposed task setup;\nit does not execute the task or verify the resulting implementation.\n`;
function argumentsOf(argv) {
  const flags = {}; const words = [];
  const boolean = new Set(['json', 'yes', 'dry-run', 'publish', 'recover', 'exec', 'help', 'version', 'daemon', 'export', 'no-status', 'auto', 'manual', 'mine']);
  const values = new Set(['role', 'bot', 'approve-push', 'name', 'import', 'team', 'hours', 'as', 'project', 'permissions', 'place', 'rules']);
  const repeatable = new Set(['folder']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // -h alone or straight after a command; inside a goal or a question it is a word of the text.
    if (arg === '-h' && (i === 0 || (i === 1 && argv.length === 2))) { flags.help = true; continue; }
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const [name, inline] = arg.slice(2).split('=', 2);
    if (Object.hasOwn(flags, name) && !repeatable.has(name)) refuse(`Duplicate option --${name}.`);
    if (boolean.has(name) && inline === undefined) flags[name] = true;
    else if (values.has(name) || repeatable.has(name)) {
      const value = inline ?? argv[++i];
      if (!value || value.startsWith('--')) refuse(`--${name} needs a value.`);
      if (repeatable.has(name)) (flags[name] ??= []).push(value); else flags[name] = value;
    } else refuse(`Unknown option ${arg}.`);
  }
  return { flags, words };
}
async function confirm(plan, flags) {
  if (flags['dry-run']) return false;
  if (flags.yes) return true;
  if (flags.json || !process.stdin.isTTY) return false;
  process.stdout.write(formatResult(plan));
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  const closed=new Promise(resolve=>prompt.once('close',()=>resolve('')));
  try { const answer=await Promise.race([prompt.question('Make these writes? [y/N] ').catch(error=>{if(error.code==='ERR_USE_AFTER_CLOSE'||error.code==='ABORT_ERR')return'';throw error;}),closed]);return /^y(?:es)?$/i.test(answer.trim()); }
  finally { prompt.close(); }
}
// elu mcp reads its own arguments: what follows its -- is a command's, untouched.
const mcpAt = argv => { const at = argv.findIndex(arg => !arg.startsWith('--')); return argv[at] === 'mcp' ? at : -1; };
// elu sessions and elu schedules read theirs too (lib/session-commands.mjs): after -- is the message.
const ownAt = argv => { const at = argv.findIndex(arg => !arg.startsWith('-')); return ['sessions', 'schedules'].includes(argv[at]) ? at : -1; };
const ownArgs = argv => (mcpAt(argv) >= 0 || ownAt(argv) >= 0) && argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
export async function main(argv = process.argv.slice(2)) {
  if (ownAt(argv) >= 0) {
    const commands = await import('../lib/session-commands.mjs'), at = ownAt(argv), rest = [...argv.slice(0, at), ...argv.slice(at + 1)];
    return argv[at] === 'sessions' ? commands.sessionsCli(rest) : commands.schedulesCli(rest);
  }
  // Your Claude Code MCP servers: the key is asked for with echo off, or read from stdin.
  if (mcpAt(argv) >= 0) {
    const { mcpArguments, mcpCli } = await import('../lib/mcp.mjs'), at = mcpAt(argv), { flags, words } = mcpArguments([...argv.slice(0, at), ...argv.slice(at + 1)]);
    if (flags.help) return { help: HELP };
    return mcpCli(words, flags, { root: findRepository(process.cwd())?.root ?? null });
  }
  const { flags, words } = argumentsOf(argv);
  if (flags.help || words[0] === 'help') return { help: `${HELP}\nOptions:\n  --help, -h\n  --version\n` };
  if (flags.version) return { version: readJson(fileURLToPath(new URL('../package.json', import.meta.url))).version };
  if (words[0] === 'schedule') {
    const schedules = await import('../lib/schedules.mjs');
    // The login item runs this every minute. It prints only when something happens.
    // Bots that have a schedule are counted with the schedules made with /schedule.
    // last: with no schedule left on, the login item removes itself, after the output.
    if (words[1] === 'tick') { const { fired, last } = (await import('../lib/bot-schedules.mjs')).scheduleTick(); return { ...(fired ? { message: `Queued ${fired} scheduled task${fired === 1 ? '' : 's'}.` } : { quiet: true }), ...(last ? { last } : {}) }; }
    if (words[1] === 'list' || !words[1]) return { schedules: schedules.listSchedules(), message: schedules.listSchedules().map(row => `${row.enabled ? row.when.label : 'paused'}  ${row.project}  ${row.goal.split('\n')[0]}${row.nextRunAt ? `  next ${schedules.dateText(new Date(row.nextRunAt))}` : ''}`).join('\n') || 'No schedules. In ELU, set When in + New task.' };
    refuse(`Unknown command: schedule ${words[1]}. Use elu schedule [list|tick].`);
  }
  if (words[0] === 'conductor') {
    const conductor = await import('../lib/conductor.mjs');
    if (flags.daemon) {
      const owner = new conductor.Conductor({ onExit: () => close() });
      let closing = false; const close = async () => { if (closing) return; closing = true; await owner.stop(); process.exit(0); };
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, close);
      owner.start(); return new Promise(() => {});
    }
    if (words[1] === 'stop') {
      if (!conductor.conductorRunning()) return { message: 'The conductor is not running.' };
      // Kept as the owner's own stop: what is still queued then waits until work is queued,
      // and neither opening ELU nor the login item starts it (startQueued).
      conductor.ownerStop(); conductor.sendCommand({ type: 'shutdown' }); return { message: 'The conductor stops its runs, keeps their history, and exits. It starts again when work is queued.' };
    }
    if (words[1]) refuse(`Unknown command: conductor ${words[1]}. Use elu conductor [stop].`);
    if (flags.json || !process.stdin.isTTY || !process.stdout.isTTY) { const { dashboardSnapshot } = await import('../lib/projects.mjs'); const { boardRows } = await import('../lib/board.mjs'); return { conductor: conductor.conductorStatus(), agents: boardRows(dashboardSnapshot().projects).map(({ task, request, key, order, ...row }) => row) }; }
    const { launchTerminal } = await import('../lib/terminal.mjs'); return launchTerminal();
  }
  if (words[0] === 'peer' && flags.daemon) {
    // Started by the app, the CLI or a login service. On no team, with no join waiting, it
    // has nothing to do and exits before it connects to anything.
    if (!(await import('../lib/peer/index.mjs')).peerWanted()) return { quiet: true };
    const { PeerDaemon } = await import('../lib/peer/daemon.mjs');
    const owner = new PeerDaemon({ onExit: () => close() });
    let closing = false; const close = async () => { if (closing) return; closing = true; await owner.stop(); process.exit(0); };
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, close);
    await owner.start(); return new Promise(() => {});
  }
  if (words[0] === 'relay') {
    const { startRelay } = await import('../lib/peer/cli.mjs');
    const { relay, result } = await startRelay(flags);
    let closing = false; const close = async () => { if (closing) return; closing = true; await relay.close(); process.exit(0); };
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, close);
    process.stdout.write(flags.json ? `${JSON.stringify({ success: true, ...result })}\n` : formatResult(result));
    return new Promise(() => {});
  }
  if (words[0] === 'team' && !words[1] && !flags.json && process.stdin.isTTY && process.stdout.isTTY) { const { launchTerminal } = await import('../lib/terminal.mjs'); return launchTerminal({ team: true, repo: findRepository(process.cwd()) }); }
  if (PEER_COMMANDS.has(words[0])) { const { peerCli } = await import('../lib/peer/cli.mjs'); return peerCli(words, flags); }
  // What runs without asking: the defaults and the rules kept with a (lib/permission-rules.mjs).
  if (words[0] === 'permissions') {
    const rules = await import('../lib/permission-rules.mjs');
    if (words.length === 1 || words[1] === 'list' && words.length === 2) { const rows = rules.listEntries(); return { permissions: rows.map(({ rule, ...row }) => ({ ...row, ...(rule ? { rule } : {}) })), lines: ['Allowed without asking:', ...rows.map(rules.entryLine), rows.some(row => row.kind === 'rule') ? 'elu permissions remove N removes a rule or turns a default off.' : 'No rules of yours yet: press a when a session asks.'] }; }
    if (['remove', 'on'].includes(words[1]) && words.length === 3 && /^[0-9]+$/.test(words[2])) return { message: words[1] === 'remove' ? rules.removeEntry(Number(words[2])) : rules.turnOnEntry(Number(words[2])) };
    refuse('Use elu permissions [list|remove N|on N].');
  }
  // The owner's y to "This session's project is your home folder. Let it run here?", for a
  // teammate's session in a project at the home folder, from the command line. A message the
  // question held goes again.
  if (words[0] === 'allow-home') {
    if (words.length !== 2 || !/^[1-9][0-9]*$/.test(words[1])) refuse('Use elu allow-home <session>.');
    const id = words[1], { registeredProjects } = await import('../lib/projects.mjs'), { homeOrAbove, HOME_QUESTION, isHomeRefusal } = await import('../lib/util.mjs');
    const { allowHome } = await import('../lib/runner.mjs'), { pendingRequests } = await import('../lib/workspace.mjs'), { retryRequest, startConductor } = await import('../lib/conductor.mjs');
    const found = registeredProjects().filter(repo => homeOrAbove(repo.root) && fs.existsSync(path.join(taskDir(repo, id), 'task.json')));
    if (found.length !== 1) refuse(found.length ? `More than one project at your home folder has a session ${id}. Answer y in the session instead.` : `No session ${id} in a project at your home folder.`);
    allowHome(found[0], id);
    const held = pendingRequests(found[0].root).filter(row => row.continuationTaskId === id && (row.reason === HOME_QUESTION || isHomeRefusal(row.reason)) && retryRequest(found[0].root, row.id));
    if (held.length) startConductor();
    return { message: `Session ${id} may run in your home folder now.${held.length ? ' Its message is on its way.' : ' Send your message again.'}` };
  }
  // The latest version from npm, installed where the elu command is (lib/update.mjs).
  if (words[0] === 'update') {
    if (words.length > 1) refuse('Use elu update.');
    const { runUpdate } = await import('../lib/update.mjs');
    return runUpdate({ write: flags.json ? () => {} : text => process.stdout.write(text) });
  }
  if (words[0] === 'dashboard') {
    if (flags.json) { const { dashboardSnapshot } = await import('../lib/projects.mjs'); return dashboardSnapshot(); }
    const { launchTerminal } = await import('../lib/terminal.mjs'); return launchTerminal();
  }
  if (!words.length && !flags.json && (!process.stdin.isTTY || !process.stdout.isTTY)) return { help: HELP };
  if (!words.length) {
    const repo = findRepository(process.cwd());
    if (flags.json) { const { projectSnapshot, dashboardSnapshot } = await import('../lib/projects.mjs'); return repo ? projectSnapshot(repo) : { welcome: true, directory: process.cwd(), ...dashboardSnapshot() }; }
    const { launchTerminal } = await import('../lib/terminal.mjs'); return launchTerminal({ repo, startDirectory: process.cwd(), askProject: true });
  }
  const repo = repository(process.cwd());
  const command = words[0];
  if (command === 'init') {
    const plan = await initPlan(repo);
    if (plan.initialized) return plan;
    return await confirm(plan, flags) ? applyInit(repo, plan) : { ...plan, needsConfirmation: !flags['dry-run'] };
  }
  if (command === 'policy' && words[1] === 'show') {
    // The policy as it stands in this folder: .elu-code/config.yaml as it is now, committed or
    // not, once approved on this machine; with no file, the one new sessions get. A file that
    // is not what the last commit holds is said, since elu run takes only a committed one.
    const { baseFile } = await import('../lib/git.mjs'), { parseConfig, defaultConfig } = await import('../lib/config.mjs'), { NOT_APPROVED, trustedText } = await import('../lib/project-trust.mjs');
    const file = path.join(repo.root, '.elu-code', 'config.yaml'); noSymlinks(file);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, approved = trustedText(repo.root, 'config.yaml');
    if (text !== null && approved !== text) refuse(NOT_APPROVED);
    const committed = baseFile(repo.root, 'HEAD', '.elu-code/config.yaml', { optional: true });
    const config = text !== null ? parseConfig(text) : approved !== null ? parseConfig(approved) : defaultConfig();
    const note = text === null ? `No .elu-code/config.yaml here, so this is ${approved !== null ? 'the one you approved last' : 'the default policy'}. elu init writes one.`
      : committed === null ? 'This is .elu-code/config.yaml as it is now. It is not committed yet: elu run needs it committed.'
        : committed !== text ? 'This is .elu-code/config.yaml as it is now. It differs from the last commit: elu run needs it committed.' : null;
    // Only the lead entry runs. Bots do the reviews, read-only, whatever an older config lists.
    const role = config.roles.lead; let refusal = null; try { assertPolicy(role); } catch (e) { refusal = e.message; }
    // The table names the OS sandbox among what enforces a rule; where it cannot start, say so.
    const { shellSandboxLine } = await import('../lib/sandbox.mjs'), lines = [...(note ? [note] : []), ...shellSandboxLine()];
    return { ...(lines.length ? { lines } : {}), committed: text !== null && committed === text, roles: [{ name: 'lead', ...policyReport(role), refusal }], unsupportedVendors: unsupportedVendors().map(({ bin, ...value }) => value) };
  }
  if (command === 'run') {
    if (flags.publish) {
      if (flags.yes || flags['dry-run']) refuse('Publication uses its own exact push confirmation.');
      const task = readTask(repo, words[1]); const release = lock(repo, `task-${task.id}`);
      try { return flags['approve-push'] ? await publish(repo, task, flags['approve-push']) : await preparePublish(repo, task); }
      finally { release(); }
    }
    if (flags['approve-push']) refuse('--approve-push requires --publish.');
    // A scripted run picks a mode too; ask needs someone at the terminal to answer.
    if (flags.permissions === 'ask') refuse('Ask needs the terminal app.');
    const session = { ...(flags.permissions !== undefined ? { permissions: flags.permissions } : {}), ...(flags.place !== undefined ? { place: flags.place } : {}), ...(flags.folder ? { folders: flags.folder.map(dir => path.resolve(dir)) } : {}) };
    const release = lock(repo);
    let plan;
    try { plan = await runPlan(repo, words.slice(1).join(' '), session); } finally { release(); }
    if(flags['dry-run'])return{...plan,preview:true,needsConfirmation:false,message:'Review this task preview. Nothing ran and no model credit was used.'};
    const approved = await confirm(plan, flags);
    if (!approved) return { ...plan, needsConfirmation: true };
    const task = await runTask(repo, plan);
    return { ...task, draftPrBody: prBody(task), published: false, message: 'Local work finished. Use run <id> --publish to review the exact commit and push destination.' };
  }
  if (command === 'status') {
    let values = words[1] ? [readTask(repo, words[1])] : tasks(repo);
    if (flags.recover) {
      values = values.map((task) => {
        const release = lock(repo, `task-${task.id}`);
        try {
          const file = path.join(taskDir(repo, task.id), 'process.json');
          const record = fs.existsSync(file) ? readJson(file) : null;
          if (task.state !== 'running' && !record?.pid) return task;
          if (record) recoverProcess(record);
          task.state = 'blocked'; task.error = { message: 'The controlling process ended. Review the worktree and rerun checks; nothing was restarted.' }; saveTask(repo, task); return task;
        } finally { release(); }
      });
    }
    return { tasks: values.map(({ goal, runs, responses, reviews, ...task }) => ({ ...task, goal, runs: runs.map(({ logFile, ...run }) => run), responses, reviewRounds: reviews.length })) };
  }
  if (command === 'check') {
    const task = readTask(repo, words[1]); const release = lock(repo, `task-${task.id}`);
    try { return await runChecks(repo, task); } finally { release(); }
  }
  if (command === 'open') {
    // --bot opens what one of the session's bots saved. --role still reads a name an earlier run saved under.
    const task = readTask(repo, words[1]); const bot = flags.bot === undefined ? null : String(flags.bot).replace(/^@/, '');
    const role = bot !== null ? botKey(bot) : flags.role ?? 'lead';
    const session = Object.hasOwn(task.sessions, role) ? task.sessions[role] : null;
    if (!session || !/^[a-f0-9-]{36}$/i.test(session.id)) refuse(bot !== null ? `@${bot} has no saved session in task ${task.id}.` : 'There is no saved session to open.');
    if (task.state === 'running') refuse('Wait for the headless run to finish before opening its session.');
    // The adapter names its resume command; a vendor with a private HOME names it in env.
    const adapter = ADAPTERS[session.vendor];
    const plan = adapter?.interactive?.({ session: session.id, cwd: task.worktree }) ?? { bin: session.vendor, args: session.vendor === 'codex' ? ['resume', session.id] : ['--resume', session.id] };
    const prefix = Object.entries(plan.env ?? {}).map(([key, value]) => `${key}=${quote(value)} `).join('');
    const info = { command: `cd ${quote(task.worktree)} && ${prefix}${plan.bin} ${plan.args.map(quote).join(' ')}`, message: "Opening uses the vendor's interactive CLI and your own approvals. ELU's headless policy does not apply." };
    if (flags.exec) {
      if (flags.json || !process.stdin.isTTY) refuse('Interactive opening needs a terminal. Use the printed command.');
      process.stdout.write(`${info.message}\n`);
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync(plan.bin, plan.args, { cwd: task.worktree, env: plan.env ? { ...process.env, ...plan.env } : process.env, stdio: 'inherit' });
      return { ...info, exitCode: result.status };
    }
    return info;
  }
  if (command === 'uninstall') {
    const plan = uninstallPlan(repo);
    if (!await confirm(plan, flags)) return { ...plan, needsConfirmation: !flags['dry-run'] };
    const done = applyUninstall(repo, plan);
    // The peer daemon stops too. It starts again when ELU opens on a machine still on a team.
    let peerStopped = false; try { peerStopped = (await import('../lib/peer/index.mjs')).stopPeer(); } catch { /* No peer files. */ }
    return peerStopped ? { ...done, peerStopped, message: `${done.message} The peer daemon stopped.` } : done;
  }
  refuse(`Unknown command: ${words.join(' ')}. Use elu --help.`);
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await main(), own = ownArgs(process.argv.slice(2));
    if (own.includes('--json')) process.stdout.write(`${JSON.stringify({ success: true, ...result })}\n`);
    else if (result.help) process.stdout.write(result.help);
    else if (own.includes('--version')) process.stdout.write(`${result.version}\n`);
    else if (result.quiet) { /* Nothing to report. */ }
    else process.stdout.write(formatResult(result,process.argv[2]));
    if (result.results?.some((row) => row.status !== 'passed') || result.state === 'blocked'||result.sandboxHelper?.working===false||result.success===false) process.exitCode = 1;
    // What a command leaves for the very end. Nothing may follow it: it can end this process.
    if (typeof result.last === 'function') { try { result.last(); } catch { /* The login item's next run tries again. */ } }
  } catch (error) {
    const output = { success: false, message: error.message, ...error.details };
    if (ownArgs(process.argv.slice(2)).includes('--json')) process.stdout.write(`${JSON.stringify(output)}\n`);
    else process.stderr.write(`${error.message}\n${error.details&&Object.keys(error.details).length?Object.entries(error.details).map(([key,value])=>`${key}: ${typeof value==='object'?JSON.stringify(value):value}`).join('\n')+'\n':''}`);
    process.exitCode = 1;
  }
}
