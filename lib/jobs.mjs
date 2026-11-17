// A session's long jobs (docs/jobs.md): commands ELU runs apart from the turn that
// started them, so they outlive it. An agent of the session starts one with
// elu jobs start NAME -- COMMAND and ends its turn; ELU tells the session when the job ends
// (lib/long-work.mjs). A command a turn leaves running in the background ends with the turn.
//
// Each job has a folder beside the session's records, <session>/jobs/<name>/: job.json (what
// ELU keeps of it), output.log (what the command printed), and the files its runner writes
// (lib/job-runner.mjs): pid.json and, once, exit.json. A job runs in the session's folder
// under the mode the turn that started it had, never more: with the owner's environment and
// no sandbox in Full access, and in ELU's sandbox for checks below it, with no network and
// the files to write that the turn that started it has (jobLimits): never one that turn is
// kept from. It carries a mark of its own, not the turn's, so the end of the turn leaves it,
// and a stop finds everything it started.
//
// A job that still runs, or ended and was not yet told, is also named in one small file of
// the owner's own folder (jobs/), so what looks for them reads those few files and never
// every session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomic, hash, mkdir, noSymlinks, personalDirectory, quote, readJson, refuse } from './util.mjs';
import { taskDir, waitLock } from './state.mjs';
import { RUN_MARK, agentEnv, endRun, processRecord, sameProcess } from './process.mjs';
import { sandboxCommand, usableSandbox } from './sandbox.mjs';
import { assertNoCodexProjectConfig, protectedFiles } from './policy.mjs';
import { assertTaskGitSafe, tracked } from './git.mjs';
import { LABELS, MODES } from './modes.mjs';
import { conductorFolder } from './conductor-files.mjs';

export const JOB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const NAME_RULE = 'Name the job in letters, digits, dots, dashes and underscores, 60 at most.';
const RUNNER = fileURLToPath(new URL('./job-runner.mjs', import.meta.url));
// The conductor a runner starts when its job has ended and none runs: only a job the
// conductor itself started names one, so nothing a test or a command starts brings one up.
const DAEMON = process.argv.includes('conductor') && process.argv.includes('--daemon') && typeof process.argv[1] === 'string' ? [process.execPath, process.argv[1], 'conductor', '--daemon'] : null;
export const jobsDir = (repo, id) => path.join(taskDir(repo, id), 'jobs');
const folderOf = (dir, name) => path.join(dir, name);
const recordFile = (dir, name) => path.join(dir, name, 'job.json');
export const jobLog = (dir, name) => path.join(dir, name, 'output.log');
const exitFile = (dir, name) => path.join(dir, name, 'exit.json');
const pidFile = (dir, name) => path.join(dir, name, 'pid.json');
const pointers = () => path.join(personalDirectory(), 'jobs');
const pointerFile = (dir, name) => path.join(pointers(), `${hash(`${dir}\0${name}`).slice(0, 40)}.json`);
const iso = () => new Date().toISOString();
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const there = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const read = file => { try { noSymlinks(file); return readJson(file); } catch { return null; } };

// How long, in words a row has room for: 45s, 43m, 2h 3m.
export function ranText(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
// The command as one line: a single word is a line for the shell as it is; several words are
// one command and its arguments, each kept whole.
const lineOf = command => command.length === 1 ? command[0] : command.map(word => /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : quote(word)).join(' ');

// The runner of a job that says it runs is looked at by its process number each time, and by
// what the system says of that process (a number can be given again) at most every 20 s.
const checked = new Map();
function runs(record) {
  const runner = record?.runner;
  if (!runner || !Number.isInteger(runner.pid)) return Date.now() - Date.parse(record?.startedAt ?? 0) < 15000;
  if (!there(runner.pid)) { checked.delete(runner.pid); return false; }
  const kept = checked.get(runner.pid), now = Date.now();
  if (kept && kept.born === runner.born && now - kept.at < 20000) return true;
  const same = sameProcess(runner);
  if (same) { if (checked.size > 500) checked.clear(); checked.set(runner.pid, { born: runner.born, at: now }); }
  return same;
}
// A job as every view reads it, from its files, changing none:
// { name, state: 'running' | 'ended', line, mode, by, startedAt, endedAt, ranMs, code, signal,
//   error, lost, stopped, told, log, dir }. lost: it ended with no word from its runner (the
// computer restarted, or it was ended from outside), so it has no exit code. null: no such job.
export function readJob(dir, name) {
  const record = read(recordFile(dir, name));
  if (!record || typeof record !== 'object' || record.name !== name) return null;
  const base = { name, line: String(record.line ?? ''), mode: record.mode ?? null, ...(record.writes === false ? { reads: true } : {}), by: record.by ?? null, startedAt: record.startedAt ?? null, log: jobLog(dir, name), dir, stopped: record.stopped ?? null, told: record.told ?? null, session: record.session ?? null, root: record.root ?? null };
  const from = Date.parse(record.startedAt ?? '') || Date.now();
  let end = record.ended ?? null;
  if (!end) { const exit = read(exitFile(dir, name)); if (exit && typeof exit === 'object') end = { at: exit.endedAt ?? iso(), code: Number.isInteger(exit.code) ? exit.code : null, signal: typeof exit.signal === 'string' ? exit.signal : null, ...(typeof exit.error === 'string' ? { error: exit.error } : {}), ...(Number.isFinite(exit.ranMs) ? { ranMs: exit.ranMs } : {}) }; }
  if (!end && runs(record)) return { ...base, state: 'running', ranMs: Date.now() - from };
  if (!end) { let at = null; try { at = fs.statSync(jobLog(dir, name)).mtime.toISOString(); } catch { at = record.startedAt ?? iso(); } end = { at, code: null, signal: null, lost: true }; }
  return { ...base, state: 'ended', endedAt: end.at, ranMs: Number.isFinite(end.ranMs) ? end.ranMs : Math.max(0, (Date.parse(end.at) || from) - from), code: end.code ?? null, signal: end.signal ?? null, ...(end.error ? { error: end.error } : {}), ...(end.lost ? { lost: true } : {}), settled: Boolean(record.ended) };
}
const names = dir => { try { noSymlinks(dir); return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && JOB_NAME.test(entry.name)).map(entry => entry.name); } catch { return []; } };
// A session's jobs, oldest first. dir: the session's jobs folder (jobsDir).
export function listJobs(dir) {
  return names(dir).map(name => readJob(dir, name)).filter(Boolean).sort((a, b) => Date.parse(a.startedAt ?? 0) - Date.parse(b.startedAt ?? 0));
}
// What ELU keeps of a job changes in one step, whoever changes it (the conductor, a window,
// a command). change gets the record and alters it. Returns the job as it reads after.
function change(dir, name, alter) {
  const release = waitLock({ state: folderOf(dir, name) }, 'job', 300);
  try {
    const file = recordFile(dir, name), record = read(file);
    if (!record) return null;
    alter(record); atomic(file, record);
  } finally { release(); }
  return readJob(dir, name);
}
// How a job ended is kept with it once it is known, so its time and its exit code never change.
function settle(dir, name) {
  const row = readJob(dir, name);
  if (!row || row.state !== 'ended' || row.settled) return row;
  return change(dir, name, record => { record.ended ??= { at: row.endedAt, code: row.code, signal: row.signal, ranMs: row.ranMs, ...(row.error ? { error: row.error } : {}), ...(row.lost ? { lost: true } : {}) }; });
}
const point = (dir, name, value) => { try { mkdir(pointers()); atomic(pointerFile(dir, name), value); } catch { /* Found again by its session. */ } };
const unpoint = (dir, name) => { try { fs.rmSync(pointerFile(dir, name), { force: true }); } catch { /* Read as told at the next look. */ } };

// What a job below Full access may write in its folder: what the turn that starts it may, and
// never more. given: that turn's own limits (lib/runner.mjs: the paths its role writes, the
// files it is kept from). With none (elu jobs from the owner's own shell) they are the
// session's: a chat works in the project folder itself and changes nothing there below Full
// access, so its job reads the folder; a session with a folder of its own writes it, less the
// files a turn and a check of it are kept from (lib/checks.mjs).
const paths = value => Array.isArray(value) ? value.filter(file => typeof file === 'string' && file) : [];
function jobLimits(repo, task, cwd, mode, given) {
  if (given && typeof given === 'object') return { writablePaths: paths(given.writablePaths), protectedPaths: paths(given.protectedPaths) };
  if (task.kind === 'conversation' || task.worktree !== cwd || !task.base) return { writablePaths: [], protectedPaths: [] };
  return { writablePaths: ['.'], protectedPaths: [...protectedFiles(tracked(cwd, task.base), { mode }), ...assertTaskGitSafe(repo, task).protectedPaths] };
}
// Starts a job of a session and returns it. repo: the project's (its state); task: the
// session; root: the project's folder, where its messages wait; command: the words after --;
// mode: the mode of the turn that asked (never more than the session's); by: who asked;
// limits: what that turn may write (jobLimits).
const NO_READ_ONLY = 'A Read only session starts no job.';
export async function startJob({ repo, task, root, name, command, mode, by = null, limits = null }) {
  if (typeof name !== 'string' || !JOB_NAME.test(name)) refuse(`${NAME_RULE} elu jobs start NAME -- COMMAND.`);
  if (!Array.isArray(command) || !command.length || command.some(word => typeof word !== 'string') || !command.join('').trim()) refuse('Say what the job runs: elu jobs start NAME -- COMMAND.');
  if (!MODES.includes(mode) || mode === 'locked') refuse(NO_READ_ONLY);
  const dir = jobsDir(repo, task.id), folder = folderOf(dir, name), earlier = readJob(dir, name);
  if (earlier?.state === 'running') refuse(`A job named ${name} is running. elu jobs stop ${name} ends it, or give this one another name.`);
  const cwd = typeof task.worktree === 'string' && task.worktree ? task.worktree : root;
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error('not a folder'); } catch { refuse("The session's folder is gone, so a job cannot start in it."); }
  const line = lineOf(command), mark = crypto.randomUUID();
  // Below Full access a job gets what a check of the session gets: no network, nothing of the
  // owner's own files, and in its folder what its turn may write. Where this computer has no
  // sandbox, none starts.
  const box = mode === 'full' ? null : usableSandbox({ what: 'a long job', then: 'start the job again' });
  if (box?.kind === 'codex') assertNoCodexProjectConfig(cwd);
  const may = box ? jobLimits(repo, task, cwd, mode, limits) : null;
  // A job started again under a name starts over: its log and what was kept of the last one go.
  if (earlier) { unpoint(dir, name); fs.rmSync(folder, { recursive: true, force: true }); }
  mkdir(folder);
  let program = '/bin/sh', args = ['-c', line], env, sandbox = null;
  if (!box) env = agentEnv(process.env, [], {}, { full: true });
  else {
    const scratch = path.join(folder, 'tmp'), temporary = path.join(scratch, 'tmp'), helperHome = box.kind === 'codex' ? path.join(scratch, 'codex-home') : null;
    mkdir(temporary); if (helperHome) mkdir(helperHome);
    const built = sandboxCommand({ sandbox: box, cwd, writablePaths: may.writablePaths, protectedPaths: may.protectedPaths, scratch, program, args, network: 'off', env: { ...agentEnv(), ...(helperHome ? { CODEX_HOME: helperHome } : {}), OPENSSL_CONF: '/dev/null', TMPDIR: temporary, npm_config_cache: path.join(scratch, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' } });
    program = built.bin; args = built.args; env = built.env; sandbox = box.kind;
  }
  // Its own mark, in place of the turn's: the end of the turn leaves it, and a stop finds all of it.
  env = { ...env, [RUN_MARK]: mark, ELU_JOB: name };
  for (const key of ['ELU_COMMAND_FOLDER', 'CLAUDE_ENV_FILE']) delete env[key];
  if (mode === 'full') { env.ELU_SESSION = String(task.id); env.ELU_PROJECT = root; } else { delete env.ELU_SESSION; delete env.ELU_PROJECT; }
  const startedAt = iso(), record = { v: 1, name, session: String(task.id), root, command, line, cwd, mode, ...(sandbox ? { sandbox, writes: may.writablePaths.length > 0 } : {}), ...(by ? { by } : {}), startedAt, mark, runner: null };
  atomic(recordFile(dir, name), record);
  point(dir, name, { root, state: repo.state, taskId: String(task.id), name, dir });
  const spec = path.join(folder, 'spec.json');
  atomic(spec, { program, args, cwd, log: jobLog(dir, name), pidFile: pidFile(dir, name), exitFile: exitFile(dir, name), wake: DAEMON, wakeCwd: os.homedir(), unless: path.join(conductorFolder(), 'owner-stop.json') });
  // The runner keeps ELU's own environment, less the turn's mark: a turn that ends ends
  // everything that carries its mark. The command's environment goes to it on its input.
  const own = { ...process.env }; delete own[RUN_MARK];
  let child;
  try {
    child = spawn(process.execPath, [RUNNER, spec], { cwd: os.homedir(), env: own, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    await new Promise((resolve, reject) => { child.once('error', reject); child.stdin.on('error', () => resolve()); child.stdin.end(JSON.stringify(env), resolve); });
  } catch (error) {
    unpoint(dir, name); fs.rmSync(folder, { recursive: true, force: true });
    refuse(`The job could not be started: ${error.code ?? error.message}.`);
  }
  child.unref();
  const runner = processRecord(child.pid);
  return change(dir, name, kept => { kept.runner = runner; });
}
// Asks each of these jobs to end, gives them two seconds together, and ends what is left of
// them. by: 'command' (elu jobs stop), 'stop', 'archive' or 'delete' (the owner's). A job the
// owner's stop ended is told to nobody: he ended it.
function endRows(rows, by) {
  const running = rows.filter(row => row.state === 'running'), at = iso();
  const records = running.map(row => ({ row, record: read(recordFile(row.dir, row.name)) })).filter(value => value.record);
  for (const { row } of records) change(row.dir, row.name, record => { record.stopped ??= { at, by }; });
  // Its runner, or, when that is gone already, what is left of the job under its mark and its group.
  const signal = (record, how) => { const pid = record.runner?.pid; if (Number.isInteger(pid) && (sameProcess(record.runner) || !there(pid))) endRun(pid, record.mark, how); };
  for (const { record } of records) signal(record, 'SIGTERM');
  const until = Date.now() + 2000, left = () => records.some(({ row }) => !fs.existsSync(exitFile(row.dir, row.name)) && there(read(recordFile(row.dir, row.name))?.runner?.pid ?? -1));
  while (left() && Date.now() < until) sleep(50);
  for (const { record } of records) signal(record, 'SIGKILL');
  const ended = [];
  for (const { row } of records) {
    const now = change(row.dir, row.name, record => {
      const exit = read(exitFile(row.dir, row.name)), from = Date.parse(record.startedAt ?? '') || Date.now();
      record.ended ??= exit ? { at: exit.endedAt ?? at, code: Number.isInteger(exit.code) ? exit.code : null, signal: exit.signal ?? null, ranMs: Number.isFinite(exit.ranMs) ? exit.ranMs : Date.now() - from } : { at: iso(), code: null, signal: 'SIGKILL', ranMs: Date.now() - from };
      record.told ??= { at: iso(), how: 'none' };
    });
    unpoint(row.dir, row.name);
    if (now) ended.push(now);
  }
  return ended;
}
export function stopJob(dir, name, { by = 'command' } = {}) {
  const row = readJob(dir, name);
  if (!row) refuse(`No job named ${name} in this session. elu jobs lists them.`);
  if (row.state !== 'running') return { ...row, already: true };
  return endRows([row], by)[0] ?? readJob(dir, name);
}
// Every job of a session that still runs ends: the owner stopped the session, archived it or
// deleted it. Returns the jobs it ended.
export function endJobs(dir, { by }) {
  const ended = endRows(listJobs(dir), by);
  // What his stop or his archive ended is kept for the session's chat (stoppedNotes), whatever becomes of the jobs.
  if (ended.length && ['stop', 'archive'].includes(by)) { try { const kept = read(stopsFile(dir)); atomic(stopsFile(dir), [...(Array.isArray(kept) ? kept : []), { at: iso(), by, names: ended.map(job => job.name) }]); } catch { /* The jobs ended all the same. */ } }
  return ended;
}
// The line a session's chat keeps for the jobs a stop or an archive of the owner's ended, as it
// keeps one for the commands of a turn his stop ended: [{ at, by, text }] (by: stop or archive).
const stopsFile = dir => path.join(dir, '.stops.json');
export function stoppedNotes(dir) {
  const kept = read(stopsFile(dir));
  return (Array.isArray(kept) ? kept : []).filter(row => row && typeof row.at === 'string' && Array.isArray(row.names) && row.names.length && row.names.every(name => typeof name === 'string' && JOB_NAME.test(name)))
    .map(row => ({ at: row.at, by: row.by === 'archive' ? 'archive' : 'stop', text: `${row.by === 'archive' ? 'Archiving' : 'Stopping'} also ended ${row.names.length === 1 ? 'a job' : `${row.names.length} jobs`} the agent started: ${row.names.join(', ')}.` }));
}
// The same by the project's folder and the session's number, as a stop names a session.
export function endSessionJobs(root, taskId, { by }) {
  const dirs = [...new Set(pointed().filter(row => row.root === root && String(row.taskId) === String(taskId)).map(row => row.dir))];
  return dirs.flatMap(dir => endJobs(dir, { by }));
}
// The end of a job's log: its last lines, read from the last 64 KiB of it.
export function lastLines(file, count = 20) {
  let fd;
  try {
    noSymlinks(file); fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, length = Math.min(size, 64 * 1024), buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
    if (length < size) lines.shift();
    return lines.slice(-count);
  } catch { return []; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Closed. */ } } }
}
// The jobs the owner's folder names: each still runs, or ended and was not yet told.
function pointed() {
  let files = []; try { const dir = pointers(); noSymlinks(dir); files = fs.readdirSync(dir).filter(name => /^[0-9a-f]{40}\.json$/.test(name)); } catch { return []; }
  const rows = [];
  for (const name of files) {
    const value = read(path.join(pointers(), name));
    if (value && typeof value.root === 'string' && typeof value.dir === 'string' && typeof value.name === 'string' && JOB_NAME.test(value.name) && /^[1-9][0-9]*$/.test(String(value.taskId))) rows.push({ root: value.root, state: typeof value.state === 'string' ? value.state : null, taskId: String(value.taskId), name: value.name, dir: value.dir, file: path.join(pointers(), name) });
  }
  return rows;
}
// The same with each job as it reads now: [{ root, state, taskId, dir, jobs }], a session a
// row. A job whose folder is gone (its session was deleted) is forgotten here.
export function waitingJobs() {
  const sessions = new Map();
  for (const row of pointed()) {
    const job = readJob(row.dir, row.name);
    if (!job || job.told) { try { fs.rmSync(row.file, { force: true }); } catch { /* Next look. */ } continue; }
    const key = `${row.root}\0${row.taskId}`, kept = sessions.get(key) ?? { root: row.root, state: row.state, taskId: row.taskId, dir: row.dir, jobs: [] };
    kept.jobs.push(job); sessions.set(key, kept);
  }
  for (const value of sessions.values()) value.jobs.sort((a, b) => Date.parse(a.startedAt ?? 0) - Date.parse(b.startedAt ?? 0));
  return [...sessions.values()];
}
// What every view draws of them, read at most every second: the jobs of one session that
// still run, or ended and wait to be told, oldest first.
let shown = { at: 0, rows: [] };
export function sessionJobsNow(root, taskId, { fresh = false } = {}) {
  if (fresh || Date.now() - shown.at > 1000) { try { shown = { at: Date.now(), rows: waitingJobs() }; } catch { shown = { at: Date.now(), rows: [] }; } }
  return shown.rows.find(row => row.root === root && row.taskId === String(taskId))?.jobs ?? [];
}
// Whether any job runs, or waits to be told: the conductor stays for them, and one starts for them.
export function jobsWait() { try { return pointed().length > 0; } catch { return false; } }
// A job's end was told to its session (how: 'turn'), or needs no telling ('none').
export function markTold(dir, name, how) { const row = settle(dir, name); if (!row) { unpoint(dir, name); return null; } const now = change(dir, name, record => { record.told ??= { at: iso(), how }; }); unpoint(dir, name); return now; }
export { settle as settleJob };

// The line a session's chat and its row in Sessions say while its jobs run:
// "2 jobs running · nightly-gates 43m", the one that has run longest named.
export function jobsLine(jobs, now = Date.now()) {
  const running = (jobs ?? []).filter(job => job.state === 'running');
  if (!running.length) return '';
  const first = running[0], ran = ranText(now - (Date.parse(first.startedAt ?? '') || now));
  return `${running.length === 1 ? '1 job running' : `${running.length} jobs running`} · ${first.name} ${ran}`;
}
// A session's running jobs as its computer lists them to the owner's other computers and to
// teammates on its project (lib/peer/remote.mjs): each one's name and start, to read. A build
// from before 0.1.35 sends none, and drops them when it is sent some.
export const jobsWire = jobs => (Array.isArray(jobs) ? jobs : []).filter(job => job?.state === 'running' && JOB_NAME.test(job.name ?? '')).slice(0, 20).map(job => ({ name: job.name, startedAt: job.startedAt }));
export const cleanJobsWire = value => (Array.isArray(value) ? value : []).slice(0, 20).filter(job => job && typeof job === 'object' && !Array.isArray(job) && typeof job.name === 'string' && JOB_NAME.test(job.name) && Number.isFinite(Date.parse(job.startedAt ?? ''))).map(job => ({ name: job.name, state: 'running', startedAt: new Date(Date.parse(job.startedAt)).toISOString() }));
// How a job ended, in one sentence.
export function endedSentence(job) {
  const ran = ranText(job.ranMs);
  if (job.error) return `Job ${job.name} did not run: ${job.error.replace(/[.\s]+$/, '')}.`;
  if (job.lost) return `Job ${job.name} ended with no exit code after about ${ran}: this computer restarted, or its process was ended from outside.`;
  if (job.stopped) return `Job ${job.name} was stopped after ${ran}.`;
  if (job.code === null && job.signal) return `Job ${job.name} was ended by ${job.signal} after ${ran}.`;
  return `Job ${job.name} ended with exit code ${job.code ?? 'unknown'} after ${ran}.`;
}
// A job as a row of the session's checklist (lib/checklist.mjs).
export function jobChecklistRow(job, now = Date.now()) {
  if (job.state === 'running') return { text: `Job ${job.name}`, met: false, evidence: `Running for ${ranText(now - (Date.parse(job.startedAt ?? '') || now))}. Log: ${job.log}` };
  return { text: `Job ${job.name}`, met: job.code === 0 && !job.lost && !job.stopped, evidence: `${endedSentence(job).replace(/^Job \S+ /, '').replace(/^\w/, letter => letter.toUpperCase())} Log: ${job.log}` };
}

export const JOBS_HELP = `elu jobs: long commands ELU runs for a session, apart from the turn that started them.

  elu jobs [--json]                 List this session's jobs: state, time and log.
  elu jobs start NAME -- COMMAND    Start one. It runs in the session's folder, under the
                                    session's mode, and outlives the turn. Below Full
                                    access it changes only files its turn may change.
                                    ELU starts the session again when it ends, with its
                                    exit code, how long it ran and its last lines.
  elu jobs stop NAME                End one.
  elu jobs log NAME                 Print the end of its log; the whole log is the file
                                    the list names.

A command left running in the background of a turn ends when the turn ends:
start anything that must outlive it here, then end the turn.
The owner's Stop, an archive and a delete of the session end its jobs.
`;
// What a turn is told of a job that may change nothing in its folder, as the turn itself may not.
const READS_ONLY = 'It reads this folder and writes only its own temporary folder ($TMPDIR): below Full access a job changes no file its turn may not change.';
// What every turn with a shell is told, in two lines (lib/runner.mjs).
export const JOB_RULES = [
  'A command you leave running in the background ends when your turn ends.',
  'Start anything that must outlive the turn with elu jobs start NAME -- COMMAND, then end the turn: ELU starts you again when it finishes, with its exit code and its last lines. elu jobs lists them, elu jobs log NAME prints the end of a log and elu jobs stop NAME ends one.',
];
const jobLine = (job, now) => job.state === 'running' ? `${job.name}  running  ${ranText(now - (Date.parse(job.startedAt ?? '') || now))}  ${job.log}` : `${job.name}  ${job.stopped ? 'stopped' : job.lost ? 'ended (no exit code)' : job.error ? 'did not run' : `exit ${job.code ?? job.signal ?? '?'}`}  ${ranText(job.ranMs)}  ${job.log}`;
const wire = job => ({ name: job.name, state: job.state, command: job.line, mode: job.mode, startedAt: job.startedAt, ...(job.state === 'ended' ? { endedAt: job.endedAt, code: job.code, signal: job.signal, ...(job.lost ? { lost: true } : {}), ...(job.stopped ? { stopped: true } : {}), ...(job.error ? { error: job.error } : {}) } : {}), seconds: Math.round((job.ranMs ?? 0) / 1000), log: job.log });
// elu jobs, as a session's turn and the owner's shell run it. at: { repo, root, session } (the
// session the command runs in, or null in a project folder with none); mode: the most the
// turn that asked may have; words, flags: the command's own (lib/session-commands.mjs).
export async function jobsCommand({ at, words, flags, command = null, mode = null, by = null, limits = null }) {
  if (flags.help || words[0] === 'help') return { help: JOBS_HELP };
  const verb = words[0] ?? 'list', session = at.session;
  if (!session) refuse('elu jobs works inside a session: its turn has it in its shell.');
  const dir = jobsDir(at.repo, session.id), now = Date.now();
  if (verb === 'list') {
    if (words.length > 1) refuse('Use elu jobs, elu jobs start NAME -- COMMAND, elu jobs stop NAME or elu jobs log NAME.');
    const jobs = listJobs(dir);
    return { jobs: jobs.map(wire), lines: jobs.length ? jobs.map(job => jobLine(job, now)) : ['No jobs in this session. elu jobs start NAME -- COMMAND starts one.'] };
  }
  if (verb === 'start') {
    if (words.length !== 2 || !command?.length) refuse('Use elu jobs start NAME -- COMMAND.');
    // The session's own mode, and never more than the turn that asked has.
    const own = MODES.includes(session.permissions) ? session.permissions : 'ask', allowed = MODES.includes(mode) && MODES.indexOf(mode) < MODES.indexOf(own) ? mode : own;
    const job = await startJob({ repo: at.repo, task: session, root: at.root, name: words[1], command, mode: allowed, by, limits });
    return { job: wire(job), message: `Started job ${job.name} (${LABELS[allowed]}). Its log: ${job.log}\n${job.reads ? `${READS_ONLY}\n` : ''}End your turn when you have nothing else to do: ELU starts this session again when the job ends.` };
  }
  if (verb === 'stop') {
    if (words.length !== 2) refuse('Use elu jobs stop NAME.');
    if (!JOB_NAME.test(words[1])) refuse(NAME_RULE);
    const job = stopJob(dir, words[1]);
    return { job: wire(job), message: job.already ? `${endedSentence(job)} Nothing was running under that name.` : `Stopped job ${job.name} after ${ranText(job.ranMs)}.` };
  }
  if (verb === 'log') {
    if (words.length !== 2) refuse('Use elu jobs log NAME.');
    if (!JOB_NAME.test(words[1])) refuse(NAME_RULE);
    const job = readJob(dir, words[1]);
    if (!job) refuse(`No job named ${words[1]} in this session. elu jobs lists them.`);
    const lines = lastLines(job.log, 200);
    return { job: wire(job), lines: lines.length ? lines : ['Its log is empty so far.'] };
  }
  refuse('Use elu jobs, elu jobs start NAME -- COMMAND, elu jobs stop NAME or elu jobs log NAME.');
}
