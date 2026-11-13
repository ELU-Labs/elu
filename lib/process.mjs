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
export function recoverProcess(record) {
  if (!record?.pid || !record.identity) return 'interrupted';
  if (processIdentity(record.pid) !== record.identity) return 'interrupted';
  killGroup(record.pid, 'SIGKILL');
  return 'stopped';
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
// Reads what the process writes to its log as it comes, answers its control requests on its
// input, and closes the input after the result line. A request whose answer fails is
// answered as an error, so the process never waits on it.
function answerControl(child, logFile, control) {
  const fd = fs.openSync(logFile, 'r'), decoder = new StringDecoder('utf8');
  let offset = 0, carry = '', ended = false, stopped = false;
  const end = () => { if (!ended) { ended = true; child.stdin.end(); } };
  const send = row => { if (!ended && row) child.stdin.write(`${JSON.stringify(row)}\n`); };
  const failed = row => ({ type: 'control_response', response: { subtype: 'error', request_id: typeof row?.request_id === 'string' ? row.request_id : '', error: 'ELU could not answer this request.' } });
  const read = () => {
    let size; try { size = fs.fstatSync(fd).size; } catch { return; }
    while (offset < size) {
      const buffer = Buffer.alloc(Math.min(size - offset, 1 << 20)), count = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (!count) break; offset += count; carry += decoder.write(buffer.subarray(0, count));
    }
    const lines = carry.split('\n'); carry = lines.pop();
    for (const line of lines) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row?.type === 'result') end();
      else if (row?.type === 'control_request') Promise.resolve().then(() => control.answer(row)).then(send, () => send(failed(row)));
    }
  };
  const timer = setInterval(read, 100);
  return { stop() { if (stopped) return; stopped = true; clearInterval(timer); end(); try { fs.closeSync(fd); } catch { /* Closed already. */ } try { control.close?.(); } catch { /* Nothing left to stop. */ } } };
}
// What still runs under a process: its group and every process started below it, the
// process itself left out. Each is { pid, ppid, pgid, command }.
export function leftRunning(pid) {
  if (!Number.isInteger(pid) || pid < 2) return [];
  const r = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'command='], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  const rows = r.stdout.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(([, a, b, c, command]) => ({ pid: Number(a), ppid: Number(b), pgid: Number(c), command }));
  const below = new Set([pid]);
  for (let grew = true; grew;) { grew = false; for (const row of rows) if (!below.has(row.pid) && below.has(row.ppid)) { below.add(row.pid); grew = true; } }
  return rows.filter(row => row.pid !== pid && row.pid !== process.pid && (row.pgid === pid || below.has(row.pid)));
}
// The vendor wrote the row that ends its turn and is still there: it waits on something it
// left running. The turn is over, so that ends with it: its group and everything below it.
function endTurn(pid) {
  const left = leftRunning(pid), end = signal => { killGroup(pid, signal); for (const row of left) { try { process.kill(row.pid, signal); } catch { /* Ended already. */ } } };
  end('SIGTERM'); setTimeout(() => end('SIGKILL'), 2000).unref();
  return left;
}
export const afterResult = { graceSeconds: 3 };
// timeoutSeconds: the most the process may run. quietSeconds: when given, the process is
// also stopped once it has written nothing, to its log or its stderr, for that long. The
// result's stoppedBy says which ('cap' or 'quiet'); timedOut is true for either.
// hold: while it returns true (an approval is waiting for the owner) neither clock
// advances, and the quiet clock starts again after it; the output limit and abort still apply.
// control: a vendor that asks its questions on its own output and reads the answers on its
// input (Claude Code with stream-json input). Its input stays open after the prompt; each line
// it writes to the log is read back, a control_request is answered on its input with what
// control.answer returns, and the input is closed once the result line is written.
// control.close runs when the process ends.
// finished: true for a row of its output that ends the vendor's turn (its result). A process
// still running afterResult.graceSeconds after that row is ended with what it left running; the
// result then has code 0, endedAfterResult true and left, the commands that were still running.
export async function runProcess({ bin, args, cwd, env, input, logFile, processFile, timeoutSeconds, quietSeconds = null, onStart, signal, hold = null, control = null, finished = null }) {
  signal?.throwIfAborted();
  noSymlinks(logFile);
  const fd = fs.openSync(logFile, 'wx', 0o600);
  const stderrFile = `${logFile}.stderr`;
  noSymlinks(stderrFile);
  const stderrFd = fs.openSync(stderrFile, 'wx', 0o600);
  let child;
  try { child = spawn(bin, args, { cwd, env, detached: true, stdio: ['pipe', fd, stderrFd] }); }
  finally { fs.closeSync(fd); fs.closeSync(stderrFd); }
  if (child.pid) {
    const record = { pid: child.pid, identity: processIdentity(child.pid), bin: path.basename(bin) };
    if (processFile) atomic(processFile, record);
    onStart?.(record);
  }
  let timedOut = false, stoppedBy = null;
  let outputLimit = false;
  const expire = kind => { clearInterval(timer); timedOut = true; stoppedBy = kind; killGroup(child.pid, 'SIGKILL'); };
  let elapsed = 0, quiet = 0, last = Date.now(), written = -1;
  const held = () => { if (!hold) return false; try { return hold() === true; } catch { return false; } };
  const size = () => { try { return fs.statSync(logFile).size + fs.statSync(stderrFile).size; } catch { return written; } };
  let resultAt = null, ended = null, read = 0, carry = '';
  const decoder = new StringDecoder('utf8'), chunk = finished ? Buffer.alloc(1 << 16) : null;
  const timer = setInterval(() => {
    const now = Date.now(), step = now - last, total = size(); last = now;
    if (finished && resultAt === null && total !== written) {
      let reader = null;
      try { reader = fs.openSync(logFile, 'r'); for (let count; (count = fs.readSync(reader, chunk, 0, chunk.length, read)) > 0;) { read += count; carry += decoder.write(chunk.subarray(0, count)); } } catch { /* Read on the next tick. */ } finally { if (reader !== null) fs.closeSync(reader); }
      const lines = carry.split('\n'); carry = lines.pop();
      for (const line of lines) { try { if (finished(JSON.parse(line))) { resultAt = now; break; } } catch { /* Not a row. */ } }
    }
    if (resultAt !== null && !ended && now - resultAt >= afterResult.graceSeconds * 1000) ended = endTurn(child.pid);
    if (total !== written) { written = total; quiet = 0; }
    if (held()) { quiet = 0; return; }
    elapsed += step; quiet += step;
    if (Number.isFinite(timeoutSeconds) && elapsed >= timeoutSeconds * 1000) expire('cap');
    else if (Number.isFinite(quietSeconds) && quietSeconds > 0 && quiet >= quietSeconds * 1000) expire('quiet');
  }, 250);
  const outputTimer = setInterval(() => {
    if (fs.statSync(logFile).size + fs.statSync(stderrFile).size > 16 * 1024 * 1024) { outputLimit = true; killGroup(child.pid, 'SIGKILL'); }
  }, 500);
  const stop = () => killGroup(child.pid, 'SIGKILL');
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
  child.stdin.on('error', () => {});
  const answers = control ? answerControl(child, logFile, control) : null;
  if (answers) child.stdin.write(input ?? ''); else child.stdin.end(input ?? '');
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, error: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  answers?.stop();
  clearInterval(timer); clearInterval(outputTimer); stop();
  signal?.removeEventListener('abort', stop);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop);
  if (processFile) atomic(processFile, { pid: null, identity: null });
  signal?.throwIfAborted();
  if (ended && !timedOut && !outputLimit) return { code: 0, signal: null, endedAfterResult: true, left: ended.map(row => row.command), timedOut, stoppedBy, outputLimit, stderrFile };
  return { ...result, timedOut, stoppedBy, outputLimit, stderrFile };
}
