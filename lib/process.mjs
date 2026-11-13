import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { atomic, noSymlinks, personalDirectory, refuse, within } from './util.mjs';

export function killGroup(pid, signal = 'SIGTERM') {
  if (!Number.isInteger(pid) || pid < 2) return;
  try { process.kill(-pid, signal); } catch { /* The process group already ended. */ }
}
let own = null;
export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 2) return null;
  if (pid === process.pid && own?.pid === pid) return own.identity;
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' });
  const identity = r.status === 0 ? r.stdout.trim() : null;
  if (pid === process.pid && identity) own = { pid, identity };
  return identity;
}
// The terminal a process runs in, as ps names it (pts/4, ttys003), or null when it has none (ps says ? or ??).
export function processTerminal(pid) {
  if (!Number.isInteger(pid) || pid < 2) return null;
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'tty='], { encoding: 'utf8' }), name = r.status === 0 ? r.stdout.trim() : '';
  return /^[\w/.-]{1,40}$/.test(name) ? name : null;
}
export function recoverProcess(record) {
  if (!record?.pid || !record.identity) return 'interrupted';
  if (processIdentity(record.pid) !== record.identity) return 'interrupted';
  killGroup(record.pid, 'SIGKILL');
  return 'stopped';
}
// Everything a run started, read before any of it ends: the processes below it, those in a
// group or session of their own (a vendor's background command) among them, and those whose
// parent left them behind, found by the mark the run gave its environment (ELU_TURN). Each is
// { pid, ppid, pgid, command }; the run's own process and ELU are left out.
export const RUN_MARK = 'ELU_TURN';
function marked(mark) {
  const found = new Set(), needle = `${RUN_MARK}=${mark}`;
  if (process.platform === 'linux') {
    let names = []; try { names = fs.readdirSync('/proc').filter(name => /^[0-9]+$/.test(name)); } catch { /* No /proc. */ }
    for (const name of names) { try { if (fs.readFileSync(`/proc/${name}/environ`, 'latin1').split('\0').includes(needle)) found.add(Number(name)); } catch { /* Ended, or another user's. */ } }
  } else {
    const r = spawnSync('ps', ['-A', '-E', '-ww', '-o', 'pid=', '-o', 'command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
    for (const line of r.status === 0 ? r.stdout.split('\n') : []) { const pid = line.trim().match(/^([0-9]+)\s/)?.[1]; if (pid && line.split(/\s/).includes(needle)) found.add(Number(pid)); }
  }
  return found;
}
export function runProcesses(pid, mark = null) {
  if (!Number.isInteger(pid) || pid < 2) return [];
  const r = spawnSync('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const rows = r.status === 0 ? r.stdout.split('\n').map(line => line.trim().match(/^([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+(.*)$/)).filter(Boolean).map(([, a, b, c, command]) => ({ pid: Number(a), ppid: Number(b), pgid: Number(c), command })) : [];
  const ours = mark ? marked(mark) : new Set(), below = new Set([pid]);
  for (let grew = true; grew;) { grew = false; for (const row of rows) if (!below.has(row.pid) && (below.has(row.ppid) || row.pgid === pid || ours.has(row.pid))) { below.add(row.pid); grew = true; } }
  return rows.filter(row => below.has(row.pid) && row.pid !== pid && row.pid !== process.pid);
}
// Ends a run and everything it started (runProcesses), and returns what was running apart
// from the vendor's own group: the first process of each such command, so a loop is named
// once and not with every sleep it started.
export function endRun(pid, mark = null, signal = 'SIGKILL') {
  const found = runProcesses(pid, mark);
  killGroup(pid, signal);
  for (const row of found) { try { process.kill(row.pid, signal); } catch { /* Ended already. */ } }
  // One started in between is still marked.
  if (mark) for (const row of runProcesses(pid, mark)) { try { process.kill(row.pid, signal); } catch { /* Ended already. */ } }
  const apart = found.filter(row => row.pgid !== pid), pids = new Set(apart.map(row => row.pid));
  return apart.filter(row => !pids.has(row.ppid));
}
// Claude Code installs to ~/.local/bin, and Debian and Ubuntu put that folder on PATH only in
// login shells. ELU started by tmux, ssh, launchd or systemd would not find the lead. The
// folder is appended, so anything earlier on PATH still wins. Every process ELU starts
// (conductor, peer daemon, agent runs) inherits it.
export function addUserBin(env = process.env, home = os.homedir()) {
  const folder = path.join(home, '.local', 'bin'), parts = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (!path.isAbsolute(folder) || parts.includes(folder)) return false;
  try { if (!fs.statSync(folder).isDirectory()) return false; } catch { return false; }
  env.PATH = [...parts, folder].join(path.delimiter); return true;
}
// The environment an agent gets: a fixed allow-list, plus a vendor's own named keys
// (meta.envKeys) and overrides it sets, such as a private HOME under ELU's state.
const KEPT = /^(PATH|HOME|USER|LOGNAME|LANG|LC_ALL|LC_CTYPE|TERM|SHELL|TMPDIR|CODEX_HOME|CLAUDE_CONFIG_DIR|XDG_CONFIG_HOME|XDG_RUNTIME_DIR|SSL_CERT_FILE|SSL_CERT_DIR)$/;
const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
export function agentEnv(env = process.env, extraKeys = [], overrides = {}) {
  if (!Array.isArray(extraKeys) || extraKeys.some(key => !NAME.test(key))) refuse('Extra environment names must be upper-case words.');
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => KEPT.test(key) || extraKeys.includes(key)));
  for (const [key, value] of Object.entries(overrides)) {
    if (!NAME.test(key) || typeof value !== 'string' || /[\x00-\x1f]/.test(value)) refuse('Environment overrides must be upper-case names with plain text values.');
    if (key === 'HOME' && (!path.isAbsolute(value) || !within(path.resolve(personalDirectory()), path.resolve(value)))) refuse("A private HOME must be inside ELU's personal directory.");
    // An account ELU added (lib/logins.mjs) is a folder of its own state, never another place.
    if (['CLAUDE_CONFIG_DIR', 'CODEX_HOME'].includes(key) && (!path.isAbsolute(value) || !within(path.resolve(personalDirectory(), 'logins'), path.resolve(value)))) refuse("An account's folder must be inside ELU's personal directory.");
    result[key] = value;
  }
  return result;
}
// The JSON rows a process writes to its log, as they come: each read() hands on the
// complete lines written since the last one. A line that is not JSON is skipped.
function logRows(logFile, onRow) {
  const fd = fs.openSync(logFile, 'r'), decoder = new StringDecoder('utf8');
  let offset = 0, carry = '', closed = false;
  return {
    read() {
      if (closed) return;
      let size; try { size = fs.fstatSync(fd).size; } catch { return; }
      while (offset < size) {
        const buffer = Buffer.alloc(Math.min(size - offset, 1 << 20)), count = fs.readSync(fd, buffer, 0, buffer.length, offset);
        if (!count) break; offset += count; carry += decoder.write(buffer.subarray(0, count));
      }
      const lines = carry.split('\n'); carry = lines.pop();
      for (const line of lines) { let row; try { row = JSON.parse(line); } catch { continue; } onRow(row); }
    },
    close() { if (closed) return; closed = true; try { fs.closeSync(fd); } catch { /* Closed already. */ } },
  };
}
// Reads what the process writes to its log as it comes, answers its control requests on its
// input, and closes the input after the result line. A request whose answer fails is
// answered as an error, so the process never waits on it.
function answerControl(child, logFile, control) {
  let ended = false, stopped = false;
  const end = () => { if (!ended) { ended = true; child.stdin.end(); } };
  const send = row => { if (!ended && row) child.stdin.write(`${JSON.stringify(row)}\n`); };
  const failed = row => ({ type: 'control_response', response: { subtype: 'error', request_id: typeof row?.request_id === 'string' ? row.request_id : '', error: 'ELU could not answer this request.' } });
  const rows = logRows(logFile, row => {
    if (row?.type === 'result') end();
    else if (row?.type === 'control_request') Promise.resolve().then(() => control.answer(row)).then(send, () => send(failed(row)));
  });
  const timer = setInterval(rows.read, 100);
  return { stop() { if (stopped) return; stopped = true; clearInterval(timer); end(); rows.close(); try { control.close?.(); } catch { /* Nothing left to stop. */ } } };
}
// How long a vendor that wrote the row ending its turn may stay before ELU ends it (runProcess).
export const afterResult = { graceSeconds: 3 };
// timeoutSeconds: the most the process may run. quietSeconds: when given, the process is
// also stopped once it has written nothing, to its log or its stderr, for that long. The
// result's stoppedBy says which ('cap' or 'quiet'); timedOut is true for either.
// hold: while it returns true (an approval is waiting for the owner) neither clock
// advances, and the quiet clock starts again after it; the output limit and abort still apply.
// working: a reader of the vendor's stream (commandWatch in lib/turn-limits.mjs) fed each row
// the log gets. While it says a tool call is running, such as a long test run that prints
// nothing, the quiet clock does not advance; the cap still does.
// control: a vendor that asks its questions on its own output and reads the answers on its
// input (Claude Code with stream-json input). Its input stays open after the prompt; each line
// it writes to the log is read back, a control_request is answered on its input with what
// control.answer returns, and the input is closed once the result line is written.
// control.close runs when the process ends.
// onEnded: called on a stop, by signal or a limit, with what endRun ended apart from the vendor's own group.
// finished: true for a row of its output that ends the vendor's turn (its result). A process
// still running afterResult.graceSeconds after that row is ended with what it left running
// (endRun); the result then has code 0, endedAfterResult true and left, the commands that
// were still running.
export async function runProcess({ bin, args, cwd, env, input, logFile, processFile, timeoutSeconds, quietSeconds = null, onStart, signal, hold = null, control = null, working = null, onEnded = null, finished = null }) {
  signal?.throwIfAborted();
  noSymlinks(logFile);
  const fd = fs.openSync(logFile, 'wx', 0o600);
  const stderrFile = `${logFile}.stderr`;
  noSymlinks(stderrFile);
  const stderrFd = fs.openSync(stderrFile, 'wx', 0o600);
  let child;
  const mark = crypto.randomUUID();
  try { child = spawn(bin, args, { cwd, env: { ...(env ?? process.env), [RUN_MARK]: mark }, detached: true, stdio: ['pipe', fd, stderrFd] }); }
  finally { fs.closeSync(fd); fs.closeSync(stderrFd); }
  if (child.pid) {
    const record = { pid: child.pid, identity: processIdentity(child.pid), bin: path.basename(bin) };
    if (processFile) atomic(processFile, record);
    onStart?.(record);
  }
  let timedOut = false, stoppedBy = null;
  let outputLimit = false;
  // A stop, by the owner or a limit, ends everything the run started, its background commands among them.
  const abort = () => { const ended = endRun(child.pid, mark); if (ended.length) onEnded?.(ended); };
  const expire = kind => { clearInterval(timer); timedOut = true; stoppedBy = kind; abort(); };
  let elapsed = 0, quiet = 0, last = Date.now(), written = -1;
  const held = () => { if (!hold) return false; try { return hold() === true; } catch { return false; } };
  const size = () => { try { return fs.statSync(logFile).size + fs.statSync(stderrFile).size; } catch { return written; } };
  // One reader of the log tells both: which tool calls still run (working), and the row
  // that ends the turn (finished).
  let resultAt = null, ended = null;
  const watched = working || finished ? logRows(logFile, row => {
    if (working) { try { working.see(row); } catch { /* A row it cannot read changes nothing. */ } }
    if (finished && resultAt === null) { try { if (finished(row)) resultAt = Date.now(); } catch { /* Not that row. */ } }
  }) : null;
  const running = () => { if (!working) return false; watched.read(); try { return working.running() === true; } catch { return false; } };
  // The vendor wrote the row that ends its turn and is still there: it waits on something it
  // left running. The turn is over, so that ends with it, by the one helper that ends a run
  // (endRun): asked to end first, and ended two seconds later. Returns what was still running.
  const endTurn = () => {
    const left = runProcesses(child.pid, mark);
    endRun(child.pid, mark, 'SIGTERM'); setTimeout(() => endRun(child.pid, mark), 2000).unref();
    return left;
  };
  const timer = setInterval(() => {
    const now = Date.now(), step = now - last, total = size(); last = now;
    if (finished && resultAt === null && total !== written) watched.read();
    if (resultAt !== null && !ended && now - resultAt >= afterResult.graceSeconds * 1000) ended = endTurn();
    if (total !== written) { written = total; quiet = 0; }
    if (held()) { quiet = 0; return; }
    elapsed += step; quiet = running() ? 0 : quiet + step;
    if (Number.isFinite(timeoutSeconds) && elapsed >= timeoutSeconds * 1000) expire('cap');
    else if (Number.isFinite(quietSeconds) && quietSeconds > 0 && quiet >= quietSeconds * 1000) expire('quiet');
  }, 250);
  const outputTimer = setInterval(() => {
    if (fs.statSync(logFile).size + fs.statSync(stderrFile).size > 16 * 1024 * 1024) { outputLimit = true; killGroup(child.pid, 'SIGKILL'); }
  }, 500);
  const stop = () => killGroup(child.pid, 'SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
  child.stdin.on('error', () => {});
  const answers = control ? answerControl(child, logFile, control) : null;
  if (answers) child.stdin.write(input ?? ''); else child.stdin.end(input ?? '');
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, error: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  answers?.stop(); watched?.close();
  clearInterval(timer); clearInterval(outputTimer); stop();
  signal?.removeEventListener('abort', abort);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop);
  if (processFile) atomic(processFile, { pid: null, identity: null });
  signal?.throwIfAborted();
  if (ended && !timedOut && !outputLimit) return { code: 0, signal: null, endedAfterResult: true, left: ended.map(row => row.command), timedOut, stoppedBy, outputLimit, stderrFile };
  return { ...result, timedOut, stoppedBy, outputLimit, stderrFile };
}
