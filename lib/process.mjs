import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
// login shells. ELU Code started by tmux, ssh, launchd or systemd would not find the lead. The
// folder is appended, so anything earlier on PATH still wins. Every process ELU Code starts
// (conductor, peer daemon, agent runs) inherits it.
export function addUserBin(env = process.env, home = os.homedir()) {
  const folder = path.join(home, '.local', 'bin'), parts = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (!path.isAbsolute(folder) || parts.includes(folder)) return false;
  try { if (!fs.statSync(folder).isDirectory()) return false; } catch { return false; }
  env.PATH = [...parts, folder].join(path.delimiter); return true;
}
// The environment an agent gets: a fixed allow-list, plus a vendor's own named keys
// (meta.envKeys) and overrides it sets, such as a private HOME under ELU Code's state.
const KEPT = /^(PATH|HOME|USER|LOGNAME|LANG|LC_ALL|LC_CTYPE|TERM|SHELL|TMPDIR|CODEX_HOME|CLAUDE_CONFIG_DIR|XDG_CONFIG_HOME|XDG_RUNTIME_DIR|SSL_CERT_FILE|SSL_CERT_DIR)$/;
const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
export function agentEnv(env = process.env, extraKeys = [], overrides = {}) {
  if (!Array.isArray(extraKeys) || extraKeys.some(key => !NAME.test(key))) refuse('Extra environment names must be upper-case words.');
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => KEPT.test(key) || extraKeys.includes(key)));
  for (const [key, value] of Object.entries(overrides)) {
    if (!NAME.test(key) || typeof value !== 'string' || /[\x00-\x1f]/.test(value)) refuse('Environment overrides must be upper-case names with plain text values.');
    if (key === 'HOME' && (!path.isAbsolute(value) || !within(path.resolve(personalDirectory()), path.resolve(value)))) refuse("A private HOME must be inside ELU Code's personal directory.");
    result[key] = value;
  }
  return result;
}
// hold: while it returns true (an approval is waiting for the owner) the role
// time limit does not advance; the output limit and abort still apply.
export async function runProcess({ bin, args, cwd, env, input, logFile, processFile, timeoutSeconds, onStart, signal, hold = null }) {
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
  let timedOut = false;
  let outputLimit = false;
  const expire = () => { timedOut = true; killGroup(child.pid, 'SIGKILL'); };
  let elapsed = 0, last = Date.now();
  const held = () => { try { return hold() === true; } catch { return false; } };
  const timer = hold ? setInterval(() => { const now = Date.now(); if (!held()) elapsed += now - last; last = now; if (elapsed >= timeoutSeconds * 1000) { clearInterval(timer); expire(); } }, 250) : setTimeout(expire, timeoutSeconds * 1000);
  const outputTimer = setInterval(() => {
    if (fs.statSync(logFile).size + fs.statSync(stderrFile).size > 16 * 1024 * 1024) { outputLimit = true; killGroup(child.pid, 'SIGKILL'); }
  }, 500);
  const stop = () => killGroup(child.pid, 'SIGKILL');
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
  child.stdin.on('error', () => {});
  child.stdin.end(input ?? '');
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, error: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer); clearInterval(timer); clearInterval(outputTimer); stop();
  signal?.removeEventListener('abort', stop);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop);
  if (processFile) atomic(processFile, { pid: null, identity: null });
  signal?.throwIfAborted();
  return { ...result, timedOut, outputLimit, stderrFile };
}
