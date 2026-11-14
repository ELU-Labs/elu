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
// The line ps prints for a process: its start, then its command. 0.1.19 and earlier compare
// this text itself, so every record still carries it for them. ps prints the start in the
// time zone and language of the process that asks, and cuts the line to its COLUMNS: an app
// in a terminal and a daemon that a login item started do not read the same text for one
// process. This version compares born (sameProcess).
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
// The process as ps shows it to every process alike: asked in UTC and in English, the whole
// line. start is in seconds. null when ps gives no answer, false when the process is gone, or
// has ended and only waits for its parent to ask how.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SEEN = new RegExp(String.raw`^(\S+)\s+[A-Z][a-z]{2} (${MONTHS.join('|')}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})(?:\s+(.*))?$`, 's');
function seen(pid) {
  const r = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'stat=', '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC0', LC_ALL: 'C' } });
  if (r.status !== 0) return r.status === 1 ? false : null;
  const m = SEEN.exec(r.stdout.trim());
  if (!m) return null;
  if (m[1].startsWith('Z')) return false;
  return { start: Date.UTC(Number(m[7]), MONTHS.indexOf(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) / 1000, command: m[8] ?? '' };
}
// When a process started, in milliseconds, whatever time zone and language asks: null when it
// is gone or ps gives no answer.
export function processStarted(pid) {
  const now = Number.isInteger(pid) && pid > 1 ? seen(pid) : null;
  return now ? now.start * 1000 : null;
}
// When a process started, as every process on this computer reads it, whatever its time zone
// and language. Linux counts it from the computer's own start, which has an id. Elsewhere it
// is the second ps gives. A process that got the number of another never has the same one.
// null when it cannot be read, false when the process is gone.
let boot = null, mine = null;
function born(pid, platform = process.platform) {
  if (platform !== 'linux') { const now = seen(pid); return now ? String(now.start) : now; }
  let text; try { text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch (error) { return ['ENOENT', 'ESRCH'].includes(error.code) ? false : null; }
  // The name in brackets may hold spaces and brackets, so the fields are counted after it.
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  if (!/^\d+$/.test(fields[19] ?? '')) return null;
  if (['Z', 'X'].includes(fields[0])) return false;
  if (boot === null) { try { boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { boot = ''; } }
  return `${boot}/${fields[19]}`;
}
// What a lock, a session or a started agent's file says of its process. identity is for
// 0.1.19 and earlier, which read nothing else.
export function processRecord(pid = process.pid, platform = process.platform) {
  const self = pid === process.pid, stamp = self && mine ? mine : born(pid, platform) || null;
  if (self && stamp) mine = stamp;
  return { pid, identity: processIdentity(pid), ...(stamp ? { born: stamp } : {}) };
}
// A record of 0.1.19 and earlier holds only the line ps printed for its writer. Every time
// zone is a whole number of quarter hours from every other, so the written start is the real
// one when its minute and second are the real ones, quarter hours apart. The command is
// compared as far as it reads the same in every language (ps prints other letters as they
// are, as ? or with \) and as far as the writer's COLUMNS left it. A start written in another
// language is not read: there the same command is enough.
const WRITTEN = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:(\d\d):(\d\d) \d{4}(?:\s+|$)/;
const plain = text => /^[\x20-\x3e\x40-\x5b\x5d-\x7e]*/.exec(text)[0];
function written(pid, text) {
  const now = seen(pid); if (!now) return now;
  const m = WRITTEN.exec(text), head = plain(now.command);
  if (!m) return head !== '' && text.includes(` ${head}`);
  const apart = ((Number(m[1]) * 60 + Number(m[2]) - now.start) % 900 + 900) % 900;
  return (apart <= 2 || apart >= 898) && head.startsWith(plain(text.slice(m[0].length)));
}
// Whether the process a record names still runs: that one, not another that got its number.
// null when that cannot be read.
export function sameProcess(record, platform = process.platform) {
  const pid = record?.pid;
  if (!Number.isInteger(pid) || pid < 2) return false;
  if (typeof record.born === 'string' && record.born) {
    const now = pid === process.pid && mine ? mine : born(pid, platform);
    return now === null ? null : now === record.born;
  }
  if (typeof record.identity !== 'string' || !record.identity) return false;
  return pid === process.pid && own?.identity === record.identity ? true : written(pid, record.identity);
}
// A record that says which process it means. One that does not is never compared.
export const namesProcess = record => Boolean(record?.identity || record?.born);
export function recoverProcess(record) {
  if (!sameProcess(record)) return 'interrupted';
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
// watch (from feed): row(row) is given every line the process writes, and while hold() is true
// the input stays open past a result line: a message written to it still waits to be taken,
// and the process takes it as one more turn of the same run.
function answerControl(child, logFile, control) {
  let ended = false, stopped = false, resulted = false, watch = null;
  const held = () => { try { return watch?.hold?.() === true; } catch { return false; } };
  const end = () => { if (!ended) { ended = true; child.stdin.end(); } };
  const send = row => { if (!ended && row) child.stdin.write(`${JSON.stringify(row)}\n`); };
  // write: a line for the running turn (a message the owner sent while it works). False once
  // the input is closed, when the line was not written.
  const write = row => { if (ended || !row) return false; child.stdin.write(`${JSON.stringify(row)}\n`); return true; };
  const failed = row => ({ type: 'control_response', response: { subtype: 'error', request_id: typeof row?.request_id === 'string' ? row.request_id : '', error: 'ELU could not answer this request.' } });
  const rows = logRows(logFile, row => {
    try { watch?.row?.(row); } catch { /* The line is still read here. */ }
    if (row?.type === 'result') resulted = true;
    else if (row?.type === 'control_request' && !stopped) Promise.resolve().then(() => control.answer(row)).then(send, () => send(failed(row)));
  });
  const read = () => { rows.read(); if (resulted && !held()) end(); };
  const timer = setInterval(read, 100);
  // drain: the process has ended, and what it wrote last is read before the watch is closed.
  // held: a message on the input still waits for its answer, so a result line is not the end of the run.
  return { write, open: () => !ended, held, watch(value) { watch = value; }, drain() { if (!stopped) { stopped = true; clearInterval(timer); read(); } },
    stop() { this.drain(); end(); rows.close(); try { control.close?.(); } catch { /* Nothing left to stop. */ } } };
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
// were still running. A result row is not the end of the run while a message on the input still
// waits for its answer (feed's hold): the run takes it as one more turn, with a result row of
// its own, and the wait starts again from that one, or from when nothing is held any more.
// feed: with control, called once the prompt is written with { write, open }: write(row) puts
// one more line on the input while it is open and says whether it did; open() says whether it
// still is. It returns what to run when the process ends, or { close, row, hold }: close is
// that, row(row) is given each line the process writes, and hold() keeps the input open past a
// result line while it is true.
export async function runProcess({ bin, args, cwd, env, input, logFile, processFile, timeoutSeconds, quietSeconds = null, onStart, signal, hold = null, control = null, working = null, onEnded = null, finished = null, feed = null }) {
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
    const record = { ...processRecord(child.pid), bin: path.basename(bin) };
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
  let resultAt = null, ended = null, answers = null;
  const watched = working || finished ? logRows(logFile, row => {
    if (working) { try { working.see(row); } catch { /* A row it cannot read changes nothing. */ } }
    if (finished) { try { if (finished(row)) resultAt = Date.now(); } catch { /* Not that row. */ } }
  }) : null;
  const running = () => { if (!working) return false; watched.read(); try { return working.running() === true; } catch { return false; } };
  // The vendor wrote the row that ends its turn and is still there: it waits on something it
  // left running. The turn is over, so that ends with it, by the one helper that ends a run
  // (endRun): asked to end first, and ended two seconds later. Returns what was still running.
  // What only was asked is ended for certain (endLeft): at the two seconds, before the turn
  // returns, or as ELU exits, whichever comes first.
  let endBy = null, endTimer = null;
  const endLeft = () => { if (endBy === null) return; endBy = null; clearTimeout(endTimer); process.off('exit', endLeft); endRun(child.pid, mark); };
  const endTurn = () => {
    const left = runProcesses(child.pid, mark);
    endRun(child.pid, mark, 'SIGTERM'); endBy = Date.now() + 2000; endTimer = setTimeout(endLeft, 2000); endTimer.unref(); process.once('exit', endLeft);
    return left;
  };
  const timer = setInterval(() => {
    const now = Date.now(), step = now - last, total = size(); last = now;
    if (finished && !ended && total !== written) watched.read();
    // One more turn of this run is still owed its answer: the row that ended the turn before it ends nothing.
    if (resultAt !== null && answers?.held()) resultAt = now;
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
  answers = control ? answerControl(child, logFile, control) : null;
  if (answers) child.stdin.write(input ?? ''); else child.stdin.end(input ?? '');
  let unfeed = null;
  try { const fed = answers && feed ? feed({ write: answers.write, open: answers.open }) : null; unfeed = typeof fed === 'function' ? fed : fed?.close ?? null; if (fed && typeof fed === 'object') answers.watch(fed); } catch { unfeed = null; }
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, error: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  answers?.drain();
  try { unfeed?.(); } catch { /* Nothing more goes to the turn. */ }
  answers?.stop(); watched?.close();
  clearInterval(timer); clearInterval(outputTimer); stop();
  // The vendor has gone: what it left has the rest of its two seconds, and is gone before the turn is.
  while (endBy !== null && Date.now() < endBy && runProcesses(child.pid, mark).length) await new Promise(resolve => setTimeout(resolve, 100));
  endLeft();
  signal?.removeEventListener('abort', abort);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop);
  if (processFile) atomic(processFile, { pid: null, identity: null });
  signal?.throwIfAborted();
  if (ended && !timedOut && !outputLimit) return { code: 0, signal: null, endedAfterResult: true, left: ended.map(row => row.command), timedOut, stoppedBy, outputLimit, stderrFile };
  return { ...result, timedOut, stoppedBy, outputLimit, stderrFile };
}
