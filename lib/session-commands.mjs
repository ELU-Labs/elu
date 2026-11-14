// ELU's own commands, for the owner's shell and for a session's: elu sessions and elu schedules
// (README, "ELU from a session"). They change what the app shows through the app's own code,
// files and locks: closeSession, reopenSession and setTitle for a session, enqueue for a new one,
// saveSchedule and the rest for schedules. The app shows each change at its next redraw.
//
// A turn of the owner's own session gets them on its PATH (ownCommandsEnv, lib/runner.mjs),
// and is told so in two lines (OWN_COMMANDS). There elu hands each command to ELU outside the
// vendor's sandbox, through a folder of the turn's own (openPlace), and ELU checks it and runs
// it with the same code (serveRequests, runOwnCommand). A teammate's question or review never
// gets them, and a command run from one is refused.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomic, noSymlinks, quote, refuse, tempFolder } from './util.mjs';
import { readTask, setTitle, taskDir, taskTitle, sessionGoal } from './state.mjs';
import { closeSession, heldBySession, readBoard, reopenSession, sessionClosed } from './kanban.mjs';
import { findRepository } from './git.mjs';
import { pendingRequests, projectFolder, removeRequest } from './workspace.mjs';
import { LABELS, MODES, capMode, checkMode, defaultMode, isPeerRun } from './modes.mjs';
import { SUMMARY_LIMIT } from './approvals.mjs';

export const TEAMMATE_REFUSAL = "A teammate's message cannot change your sessions.";
// What the model of the owner's own session is told, with its other ELU guidance, in every
// vendor's prompt (lib/runner.mjs).
export const OWN_COMMANDS = [
  'ELU\'s own commands work in this session\'s shell, for when the owner asks about ELU itself: elu sessions lists this project\'s sessions, and elu sessions archive N|this, unarchive N, rename N|this "name" and new "message" change them; this is the session you are in, archived once this turn ends.',
  'elu schedules lists the schedules, and elu schedules add <when> <message> (as /schedule takes it, such as every 3h check the build), pause N, resume N, delete N and run N change them.',
];
export const SESSIONS_HELP = `elu sessions: this project's sessions, as Sessions in ELU shows them.

  elu sessions [--all] [--json]          List them; --all adds the archived ones.
  elu sessions archive N|this            Archive one. this is the session the command runs in,
                                         archived when its turn ends.
  elu sessions unarchive N               Bring an archived one back.
  elu sessions rename N|this NAME        Rename one; an empty name gives back ELU's own.
  elu sessions new MESSAGE [--mode ask|auto|full]
                                         Start a new session now, as if you typed MESSAGE.

Inside a session a new one gets that session's mode, or a lower one with --mode.
A teammate's question or review cannot run these.
`;
export const SCHEDULES_HELP = `elu schedules: this project's schedules, as /schedule makes them.

  elu schedules [--all] [--json]         List them; --all lists every project's.
  elu schedules add WHEN MESSAGE [--mode ask|auto|full]
                                         The words /schedule takes, such as
                                         elu schedules add every 3h check the build
  elu schedules pause|resume|delete|run N

N is a number from the list, or a schedule's id.
`;

// The session a turn asked to archive once it ends. The conductor archives it there (lib/conductor.mjs).
const ARCHIVE_FILE = 'archive.json';
const archiveFile = (repo, id) => path.join(taskDir(repo, id), ARCHIVE_FILE);
const running = task => ['running', 'preparing'].includes(task?.state);
export function archiveAsked(repo, id) { try { const file = archiveFile(repo, id); noSymlinks(file); return fs.existsSync(file); } catch { return false; } }
// The owner's messages that a session holds and did not run go with it, as with c in the app.
// A teammate's stays: his app takes it away with its thread.
function dropHeld(root, id) {
  for (const request of heldBySession(pendingRequests(root)).get(String(id)) ?? []) if (!request.origin) removeRequest(root, request.id);
}
function archiveNow(repo, root, id) {
  closeSession(repo, String(id)); dropHeld(root, id);
  fs.rmSync(archiveFile(repo, id), { force: true });
}
// Called when a turn ends: the session it asked to archive is archived now. false when there
// was nothing to do or the session still runs.
export function archiveAfterTurn(repo, root, id) {
  if (!archiveAsked(repo, id)) return false;
  if (running(readTask(repo, id))) return false;
  archiveNow(repo, root, id); return true;
}

// The place a turn's own commands go through: a folder of the run's, made by ELU outside any
// sandbox and removed when the turn ends. bin holds the turn's elu, which names the folder,
// the session and the mode in its own line, so nothing depends on the environment a sandbox
// may drop (Codex below Full access keeps only a few variables). requests is the one folder
// there a command writes: Codex's sandbox is given it to write (lib/adapters/codex.mjs), and
// nothing more of ELU's. Claude Code runs the commands outside its sandbox, and Grok Build
// and Antigravity over ACP run every command outside one.
const CLIENT = fileURLToPath(new URL('./command-client.mjs', import.meta.url));
export function openPlace({ taskId, mode }) {
  checkMode(mode);
  const root = tempFolder('elu-code-own-');
  try {
    const bin = path.join(root, 'bin'), requests = path.join(root, 'requests');
    fs.mkdirSync(bin, { mode: 0o700 }); fs.mkdirSync(requests, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'elu'), `#!/bin/sh\n# ELU's own commands in this turn, handed to ELU, which answers (lib/command-client.mjs).\nexec ${quote(process.execPath)} ${quote(CLIENT)} ${quote(requests)} ${quote(String(taskId))} ${quote(mode)} "$@"\n`, { mode: 0o700 });
    return { root, bin, requests, taskId: String(taskId), mode };
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
export function closePlace(place) { if (place) fs.rmSync(place.root, { recursive: true, force: true }); }
// The turn's environment, changed in place: its elu first on PATH (place), and for the owner's
// own elu, where a shell finds that one first (a login shell in Full access), the session and
// project the turn runs in, as before. Without a place, none of it, whatever the environment
// it came from held. Claude Code builds PATH again for each command and then runs the file in
// CLAUDE_ENV_FILE: that one puts the folder first, then runs the file that was there (the never
// list's stand-ins).
export function ownCommandsEnv(env, { place = null, taskId, project, vendor }) {
  delete env.ELU_SESSION; delete env.ELU_PROJECT; delete env.ELU_COMMAND_FOLDER;
  if (!place) return env;
  env.PATH = [place.bin, ...(env.PATH ? [env.PATH] : [])].join(path.delimiter);
  env.ELU_SESSION = String(taskId); env.ELU_PROJECT = project; env.ELU_COMMAND_FOLDER = place.bin;
  if (vendor === 'claude') {
    const file = path.join(place.root, 'path.sh');
    fs.writeFileSync(file, `export PATH=${quote(place.bin)}:"$PATH"\n${env.CLAUDE_ENV_FILE ? `. ${quote(env.CLAUDE_ENV_FILE)}\n` : ''}`, { mode: 0o600 });
    env.CLAUDE_ENV_FILE = file;
  }
  return env;
}

// ELU's side of the place, outside the sandbox: each request is taken (moved, so it is seen
// once), read as data, given to handle(request, signal, waits), and answered in a file the
// command is waiting for. One at a time, in the order they came. waits(): the command that
// wrote it still waits for the answer (it touches id.wait while it does). waiting(): a request
// is being handled, an approval for it among others, so the turn's quiet limit waits too.
// close() stops it when the turn ends; what was being handled is aborted.
const REQUEST = /^([a-f0-9]{24})\.request\.json$/, REQUEST_BYTES = 65536, GONE_MS = 5000;
export function serveRequests(place, handle, { pollMs = 100 } = {}) {
  const stop = new AbortController();
  let busy = false;
  const take = id => {
    const taken = path.join(place.requests, `${id}.taken`);
    fs.renameSync(path.join(place.requests, `${id}.request.json`), taken);
    try {
      // Written by the sandboxed command: a link, a folder or a large file is no request.
      const fd = fs.openSync(taken, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try { const stat = fs.fstatSync(fd); return stat.isFile() && stat.size <= REQUEST_BYTES ? fs.readFileSync(fd, 'utf8') : ''; } finally { fs.closeSync(fd); }
    } catch { return ''; } finally { fs.rmSync(taken, { force: true }); }
  };
  const answer = (id, value) => {
    const file = path.join(place.requests, `${id}.answer.json`), draft = path.join(place.requests, `.${id}.answer.${process.pid}`);
    fs.writeFileSync(draft, JSON.stringify({ code: value.code, ...(value.out ? { out: value.out } : {}), ...(value.err ? { err: value.err } : {}) }), { mode: 0o600 });
    fs.renameSync(draft, file);
  };
  const look = async () => {
    if (busy || stop.signal.aborted) return;
    busy = true;
    try {
      let names = [];
      try { names = fs.readdirSync(place.requests).filter(name => REQUEST.test(name)).map(name => ({ name, at: fs.lstatSync(path.join(place.requests, name)).mtimeMs })).sort((a, b) => a.at - b.at).map(row => row.name); } catch { return; }
      for (const name of names) {
        if (stop.signal.aborted) return;
        const id = REQUEST.exec(name)[1];
        let text; try { text = take(id); } catch { continue; }
        let value;
        const waits = () => { try { const stat = fs.lstatSync(path.join(place.requests, `${id}.wait`)); return stat.isFile() && Date.now() - stat.mtimeMs < GONE_MS; } catch { return false; } };
        try { value = await handle(readRequest(text), stop.signal, waits); } catch (error) { value = { code: 1, err: `${error.message}\n` }; }
        try { answer(id, value); } catch { /* The command or its turn is gone. */ }
      }
    } finally { busy = false; }
  };
  const timer = setInterval(() => { look().catch(() => { /* The next look tries again. */ }); }, pollMs);
  return { waiting: () => busy, close() { clearInterval(timer); stop.abort(); } };
}
// A request as the command wrote it, read as data: { session, mode, argv }.
const UNREAD = 'ELU could not read this request. Nothing was changed.';
export function readRequest(text) {
  let value; try { value = JSON.parse(text); } catch { refuse(UNREAD); }
  if (!value || typeof value !== 'object' || value.v !== 1 || typeof value.session !== 'string' || typeof value.mode !== 'string' || !Array.isArray(value.argv) || value.argv.length > 200 || value.argv.some(arg => typeof arg !== 'string' || arg.length > 8192)) refuse(UNREAD);
  return { session: value.session, mode: value.mode, argv: value.argv };
}
// What ELU holds a request to, from the place it came through: its own session, and that
// session's mode at most. A request that names another session or a higher mode was not
// written by the turn's elu, and nothing of it runs. The mode it runs with is returned.
const shownWord = value => JSON.stringify(String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 40));
export function checkRequest(request, { taskId, mode }) {
  if (request.session !== String(taskId)) refuse(`This request names session ${shownWord(request.session)}, not the session it came from. Nothing was changed.`);
  if (!MODES.includes(request.mode)) refuse(`This request names a mode ELU does not know, ${shownWord(request.mode)}. Nothing was changed.`);
  if (!MODES.includes(mode) || MODES.indexOf(request.mode) > MODES.indexOf(mode)) refuse(`This request asks for ${LABELS[request.mode]}, more than this session's ${LABELS[mode] ?? LABELS.locked}. Nothing was changed.`);
  if (!['sessions', 'schedules'].includes(request.argv[0])) refuse('In a session, elu has elu sessions and elu schedules.');
  return request.mode;
}
// The command line a request stands for, as the owner reads it when he is asked.
export const commandLine = argv => ['elu', ...argv].map(arg => /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : quote(arg)).join(' ');
// Asking for the help changes nothing; what follows -- is words.
export const helpOnly = argv => { const own = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv; return own[1] === 'help' || own.includes('-h') || own.includes('--help'); };
// Whether the vendor's own relay already put this command to the owner in this turn and he, or
// one of his rules, allowed it (rows: the run's approval log). Claude Code runs the commands
// outside its sandbox, so it asks before one runs; Grok Build and Antigravity over ACP ask for
// every command. Each command of an allowed line answers one request, once: a line of two
// (a && b) answers both. Quotes do not count, nor a redirection after the command; any other
// difference is a command the owner was not asked about. used: what was answered so far, by row.
// The rows ELU writes for these commands itself (id ...-own-N) answer nothing here.
const plain = text => String(text ?? '').replace(/^Run:?\s+/, '').replace(/ outside the sandbox$/, '').replace(/["'\\]/g, '').replace(/\s+/g, ' ').trim();
const covers = (part, line) => part === line || part.startsWith(`${line} `) && /^(?:[0-9]?>|<|&>)/.test(part.slice(line.length + 1));
export function allowedFirst(rows, argv, used) {
  const line = plain(['elu', ...argv].join(' '));
  for (const row of rows) {
    if (row?.decision !== 'allow' || typeof row.id !== 'string' || /-own-[0-9]+$/.test(row.id)) continue;
    const said = plain(row.summary), parts = said.split(/\s*(?:&&|\|\||;|\|)\s*/), taken = used.get(row.id) ?? new Set();
    // A summary is cut at SUMMARY_LIMIT: there the last command it shows may go on past its verb.
    const at = parts.findIndex((part, index) => !taken.has(index) && (covers(part, line) || said.length >= SUMMARY_LIMIT - 10 && index === parts.length - 1 && part.split(' ').length > 2 && line.startsWith(part)));
    if (at < 0) continue;
    taken.add(at); used.set(row.id, taken); return true;
  }
  return false;
}
// A request ELU took from a turn's place, run as the owner's shell runs it, with the session
// it came from: the CLI's own output and exit code, { code, out, err }. mode: the most the
// session's mode gives a session or schedule it starts (checkRequest).
export async function runOwnCommand(argv, { repo, taskId, mode }) {
  const own = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv, json = own.includes('--json');
  try {
    let session; try { session = readTask(repo, String(taskId)); } catch { refuse(`Session ${taskId} is not one of this project's sessions.`); }
    if (isPeerRun(session.origin)) refuse(TEAMMATE_REFUSAL);
    const given = { repo, session: { ...session, permissions: capMode(MODES.includes(session.permissions) ? session.permissions : 'ask', mode) } };
    const result = argv[0] === 'sessions' ? await sessionsCli(argv.slice(1), given) : argv[0] === 'schedules' ? await schedulesCli(argv.slice(1), given) : refuse('In a session, elu has elu sessions and elu schedules.');
    if (json) return { code: 0, out: `${JSON.stringify({ success: true, ...result })}\n` };
    const { formatResult } = await import('./format.mjs');
    return { code: 0, out: formatResult(result, argv[0]) };
  } catch (error) {
    return json ? { code: 1, out: `${JSON.stringify({ success: false, message: error.message })}\n` } : { code: 1, err: `${error.message}\n` };
  }
}

// --json, --all, --mode and --help; what follows -- is words, whatever it looks like.
export function commandArguments(argv) {
  const flags = {}, words = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { words.push(...argv.slice(i + 1)); break; }
    if (arg === '-h' || arg === '--help') { flags.help = true; continue; }
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const at = arg.indexOf('='), name = at < 0 ? arg.slice(2) : arg.slice(2, at), inline = at < 0 ? undefined : arg.slice(at + 1);
    if (['json', 'all'].includes(name) && inline === undefined) { flags[name] = true; continue; }
    if (name === 'mode') { const value = inline ?? argv[++i]; if (!value || value.startsWith('--')) refuse('--mode needs ask, auto or full.'); flags.mode = value; continue; }
    refuse(`Unknown option ${arg}.`);
  }
  return { flags, words };
}

// Where the command runs: the session's project and the session itself (ELU_SESSION), or the
// registered project the current folder is in. given: { repo, session } of a request ELU took
// from a turn (runOwnCommand), read by ELU itself and never from the environment.
async function place(given = null) {
  const { registeredProjects, savedProjectName } = await import('./projects.mjs');
  if (given) return { repo: given.repo, root: given.repo.project ?? given.repo.root, name: savedProjectName(given.repo.root) ?? path.basename(given.repo.root), session: given.session };
  // A turn's own elu folder is not the owner's elu: what this starts (the login item) looks along PATH.
  const own = process.env.ELU_COMMAND_FOLDER;
  if (own) process.env.PATH = String(process.env.PATH ?? '').split(path.delimiter).filter(dir => dir && dir !== own).join(path.delimiter);
  const named = process.env.ELU_PROJECT, id = process.env.ELU_SESSION;
  let projects; try { projects = registeredProjects(); } catch (error) { closed(error); }
  let repo = null;
  if (named) repo = projects.find(row => row.root === named) ?? (() => { try { return projectFolder(named); } catch (error) { closed(error); } })();
  else {
    const cwd = (() => { try { return fs.realpathSync(process.cwd()); } catch { return process.cwd(); } })(), found = findRepository(cwd);
    const inside = (dir, folder) => Boolean(folder) && (dir === folder || dir.startsWith(`${folder}${path.sep}`));
    const matches = projects.filter(row => inside(cwd, row.root) || inside(cwd, row.worktrees) || (found?.common && row.common === found.common));
    repo = matches.sort((a, b) => b.root.length - a.root.length)[0] ?? null;
    if (!repo) refuse('Run this in a project folder of ELU, or inside one of its sessions.');
  }
  let session = null;
  if (id) {
    try { session = readTask(repo, id); } catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') closed(error); refuse(`Session ${id} is not one of ${path.basename(repo.root)}'s sessions.`); }
    if (isPeerRun(session.origin)) refuse(TEAMMATE_REFUSAL);
  }
  return { repo, root: repo.project ?? repo.root, name: savedProjectName(repo.root) ?? path.basename(repo.root), session };
}
// A sandboxed command cannot read ELU's own files: said so, so it is run again outside.
function closed(error) {
  if (error?.code === 'EPERM' || error?.code === 'EACCES') refuse("This command needs ELU's own files, which the sandbox keeps from it. Run it again outside the sandbox.");
  throw error;
}
const firstWords = (text, max = 60) => { const line = String(text ?? '').split('\n').find(value => value.trim())?.trim() ?? ''; return line.length > max ? `${line.slice(0, max - 1)}…` : line; };
const shown = task => `"${firstWords(taskTitle(task))}"`;
const number = (value, what) => { if (!/^[1-9][0-9]*$/.test(String(value ?? ''))) refuse(`Name the ${what} by its number${what === 'session' ? ', or this' : ''}.`); return String(value); };

// The schedule that started each session, when it is known: the session's own field where its
// version keeps one, the request that ran it while it is kept, or the schedule's last run.
function scheduleOf(task, { requests, schedules }) {
  const own = typeof task.scheduleId === 'string' ? task.scheduleId : null;
  const id = own ?? requests.find(row => row.scheduleId && String(row.taskId) === task.id)?.scheduleId ?? schedules.find(row => String(row.lastTaskId) === task.id)?.id ?? null;
  if (!id) return null;
  const row = schedules.find(value => value.id === id);
  return { id, label: row ? row.when.label : null };
}
function sessionRows(at, all) {
  const { repo, root, session } = at;
  const tasks = (() => { try { return at.projects.projectSnapshot(repo); } catch (error) { closed(error); } })();
  const board = (() => { try { return readBoard(repo); } catch { return null; } })();
  const requests = pendingRequests(root), schedules = at.schedules.filter(row => row.root === root);
  const rows = [];
  for (const task of tasks.tasks) {
    if (['ask', 'review'].includes(task.origin?.kind)) continue;
    // A session that asked to be archived and is no longer running is archived now.
    if (!running(task) && archiveAsked(repo, task.id)) { try { archiveNow(repo, root, task.id); } catch { /* Shown as asked. */ } }
    const archived = Boolean(board && sessionClosed(readBoard(repo), task));
    if (archived && !all) continue;
    rows.push({ id: task.id, name: taskTitle(task) || firstWords(sessionGoal(task), 60), state: String(task.state ?? '').replace(/_/g, ' '), archived, ...(archiveAsked(repo, task.id) ? { archiving: true } : {}), schedule: scheduleOf(task, { requests, schedules }), ...(session?.id === task.id ? { this: true } : {}), mode: MODES.includes(task.permissions) ? task.permissions : null });
  }
  // A new session that has not started yet.
  const starting = requests.filter(row => !row.continuationTaskId && !row.taskId && !row.origin && ['queued', 'starting', 'waiting', 'blocked'].includes(row.state)).map(row => ({ request: row.id, name: firstWords(row.goal, 60), state: row.state === 'blocked' ? 'blocked' : 'starting', schedule: row.scheduleId ? { id: row.scheduleId, label: schedules.find(value => value.id === row.scheduleId)?.when.label ?? null } : null }));
  return { rows, starting };
}
function sessionLine(row) {
  const notes = [row.archived ? 'archived' : null, row.archiving ? 'archived when its turn ends' : null, row.schedule ? `from schedule ${row.schedule.label ?? row.schedule.id}` : null, row.this ? 'this session' : null].filter(Boolean);
  return `${String(row.id ?? '-').padStart(3)}  ${row.state.padEnd(11)} "${firstWords(row.name, 60)}"${notes.length ? `  · ${notes.join(' · ')}` : ''}`;
}

export async function sessionsCli(argv, given = null) {
  const { flags, words } = commandArguments(argv);
  if (flags.help || words[0] === 'help') return { help: SESSIONS_HELP };
  const verb = words[0] ?? 'list', at = await place(given);
  at.projects = await import('./projects.mjs');
  at.schedules = (await import('./schedules.mjs')).listSchedules();
  const { repo, root, session } = at;
  const which = value => value === 'this' ? (session ? session.id : refuse('this is the session the command runs in: use it inside a session, or name the session by its number.')) : number(value, 'session');
  const load = id => { try { return readTask(repo, id); } catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') closed(error); refuse(`No session ${id} in ${at.name}.`); } };
  if (verb === 'list') {
    if (words.length > 1) refuse('Use elu sessions [--all].');
    const { rows, starting } = sessionRows(at, flags.all === true);
    const lines = [`Sessions in ${at.name}${flags.all ? ', archived ones too' : ''}:`, ...rows.map(sessionLine), ...starting.map(sessionLine)];
    if (!rows.length && !starting.length) lines.push(flags.all ? 'None yet.' : 'None open. elu sessions --all lists the archived ones.');
    return { project: at.name, sessions: rows, starting, lines };
  }
  if (verb === 'archive') {
    if (words.length !== 2) refuse('Use elu sessions archive N, or this.');
    const id = which(words[1]), task = load(id), self = session?.id === id;
    if (sessionClosed(readBoard(repo), task)) return { id, message: `Session ${id} ${shown(task)} is archived already. elu sessions unarchive ${id} brings it back.` };
    if (running(task)) {
      atomic(archiveFile(repo, id), { at: new Date().toISOString() });
      return { id, archiving: true, message: `Session ${id} ${shown(task)} is archived when ${self ? 'this' : 'its'} turn ends.` };
    }
    archiveNow(repo, root, id);
    return { id, archived: true, message: `Archived session ${id} ${shown(task)}. elu sessions unarchive ${id} brings it back.` };
  }
  if (verb === 'unarchive') {
    if (words.length !== 2) refuse('Use elu sessions unarchive N.');
    const id = number(words[1], 'session'), task = load(id), asked = archiveAsked(repo, id);
    fs.rmSync(archiveFile(repo, id), { force: true });
    if (!sessionClosed(readBoard(repo), task)) return { id, message: asked ? `Session ${id} ${shown(task)} stays in the list.` : `Session ${id} ${shown(task)} is not archived.` };
    reopenSession(repo, id);
    return { id, message: `Session ${id} ${shown(task)} is back in the list.` };
  }
  if (verb === 'rename') {
    if (words.length < 2) refuse('Use elu sessions rename N "name", or this for this session.');
    const id = which(words[1]); load(id);
    const saved = setTitle(repo, id, words.slice(2).join(' '));
    return { id, name: taskTitle(saved), message: saved.titleBy === 'owner' ? `Renamed session ${id} to ${saved.title}.` : saved.title ? `Session ${id} is named ${saved.title} again.` : `Session ${id} is named after its first message again.` };
  }
  if (verb === 'new') {
    const message = words.slice(1).join(' ').trim();
    if (!message) refuse('Use elu sessions new "message".');
    const asked = flags.mode === undefined ? null : checkMode(flags.mode);
    // Inside a session, its own mode is the most a session it starts gets.
    const most = session ? (MODES.includes(session.permissions) ? session.permissions : 'ask') : null;
    const mode = most ? capMode(asked ?? most, most) : asked ?? defaultMode();
    const { enqueue, startConductor } = await import('./conductor.mjs'), { sessionBots } = await import('./bots.mjs');
    let bots = []; try { bots = sessionBots(null); } catch { /* An unreadable bots file gives none, as in the app. */ }
    const request = enqueue(root, message, { priority: 0, typed: true, permissions: mode, place: { kind: 'worktree' }, folders: [], bots, ...(asked && !session ? { picked: true } : {}) });
    startAway(startConductor);
    const lowered = asked && mode !== asked ? ` This session has ${LABELS[most]}, so that is the most it gives.` : '';
    return { request: request.id, mode, message: `Started a new session with ${LABELS[mode]}: "${firstWords(message)}". It shows in Sessions.${lowered}` };
  }
  refuse(`Unknown command: elu sessions ${verb}. Use elu sessions --help.`);
}
// The conductor is started with the owner's environment, never with the session's own marks.
function startAway(start) {
  const kept = {}; for (const name of ['ELU_SESSION', 'ELU_PROJECT', 'ELU_COMMAND_FOLDER']) { kept[name] = process.env[name]; delete process.env[name]; }
  try { start(); } finally { for (const [name, value] of Object.entries(kept)) if (value !== undefined) process.env[name] = value; }
}

export async function schedulesCli(argv, given = null) {
  const { flags, words } = commandArguments(argv);
  if (flags.help || words[0] === 'help') return { help: SCHEDULES_HELP };
  const verb = words[0] ?? 'list', schedules = await import('./schedules.mjs');
  const at = await place(given), { root, session } = at;
  const all = schedules.listSchedules(), mine = flags.all && verb === 'list' ? all : all.filter(row => row.root === root);
  const line = (row, index) => `${String(index + 1).padStart(3)}  ${(row.enabled ? row.when.label : row.nextRunAt ? 'paused' : 'done').padEnd(14)}${row.enabled && row.nextRunAt ? ` next ${schedules.dateText(new Date(row.nextRunAt))} ` : ' '} "${firstWords(row.goal)}"  · ${LABELS[row.permissions] ?? LABELS.locked}${flags.all ? `  · ${row.project}` : ''}  · ${row.id}${row.note ? `  · ${row.note}` : ''}`;
  const pick = value => {
    if (/^schedule-[a-f0-9]{8}$/.test(String(value ?? ''))) { const row = mine.find(item => item.id === value); if (!row) refuse(`No schedule ${value} in ${at.name}.`); return row; }
    if (!/^[1-9][0-9]*$/.test(String(value ?? ''))) refuse('Name the schedule by its number in elu schedules, or its id.');
    const row = mine[Number(value) - 1]; if (!row) refuse(`No schedule ${value} in ${at.name}: elu schedules lists them.`); return row;
  };
  if (verb === 'list') {
    if (words.length > 1) refuse('Use elu schedules [--all].');
    return { schedules: mine, lines: [flags.all ? 'Schedules:' : `Schedules in ${at.name}:`, ...mine.map(line), ...(mine.length ? [] : ['None. elu schedules add every 3h check the build makes one.'])] };
  }
  if (verb === 'add') {
    const text = words.slice(1).join(' ').trim();
    if (!text) refuse('Use elu schedules add <when> <message>, such as elu schedules add every 3h check the build.');
    const split = schedules.splitWhen(text);
    if (!split.rest) refuse(`Write the message after when it runs: elu schedules add ${split.text} check the build.`);
    const asked = flags.mode === undefined ? null : checkMode(flags.mode);
    // A schedule made inside a session runs in that session's mode, or a lower one; made from the
    // owner's own shell, in the mode he names, else as /schedule saves one.
    const most = session ? (MODES.includes(session.permissions) ? session.permissions : 'ask') : null;
    const mode = most ? capMode(asked ?? most, most) : asked ?? capMode(defaultMode(), 'auto'), picked = Boolean(most) || Boolean(asked);
    const { sessionBots, getBot } = await import('./bots.mjs');
    let bots = []; try { bots = sessionBots(session).filter(name => getBot(name)); } catch { /* An unreadable bots file gives none. */ }
    const row = schedules.saveSchedule({ root, project: at.name, goal: split.rest, when: { ...split.when, text: split.text }, permissions: mode, picked, bots, place: { kind: 'worktree' } });
    let note = '';
    try { const result = schedules.installScheduler(); if (!result.installed) note = ` ${result.reason}`; }
    catch (error) { note = ` It runs only while ELU is open: ${error.message}`; }
    return { schedule: row, message: `Scheduled ${row.when.label}${row.when.kind === 'once' ? '' : `, next ${schedules.dateText(new Date(row.nextRunAt))}`}: "${firstWords(row.goal)}", with ${LABELS[mode]}.${note}` };
  }
  if (['pause', 'resume', 'delete', 'run'].includes(verb)) {
    if (words.length !== 2) refuse(`Use elu schedules ${verb} N.`);
    const row = pick(words[1]);
    if (verb === 'pause') { schedules.pauseSchedule(row.id, true); return { id: row.id, message: `Paused the schedule "${firstWords(row.goal)}".` }; }
    if (verb === 'resume') { const next = schedules.pauseSchedule(row.id, false); return { id: row.id, message: `The schedule "${firstWords(row.goal)}" runs ${next.when.label} again, next ${schedules.dateText(new Date(next.nextRunAt))}.` }; }
    if (verb === 'delete') { schedules.removeSchedule(row.id); return { id: row.id, message: `Deleted the schedule "${firstWords(row.goal)}".` }; }
    const { startConductor } = await import('./conductor.mjs');
    schedules.runScheduleNow(row.id, new Date(), { start: () => startAway(startConductor) });
    return { id: row.id, message: `The schedule "${firstWords(row.goal)}" runs now, in a new session.` };
  }
  refuse(`Unknown command: elu schedules ${verb}. Use elu schedules --help.`);
}
