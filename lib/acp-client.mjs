import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { EluCodeError, atomic, noSymlinks, refuse } from './util.mjs';
import { killGroup, processIdentity } from './process.mjs';

// Newline-delimited JSON-RPC 2.0 over a child's stdio, as the ACP vendors speak it. No
// dependencies. The child's lines are appended to logFile, so a run's log reads like a
// vendor's stream; stderr goes to <logFile>.stderr. The same logFile, processFile, signal
// and hold plumbing as runProcess, and `exit` resolves to the shape runProcess returns.
// timeoutSeconds caps the run; quietSeconds, when given, stops it once the child has written
// no line for that long (stoppedBy: 'cap' or 'quiet').
const OUTPUT_LIMIT = 16 * 1024 * 1024, LINE_LIMIT = 4 * 1024 * 1024, REQUEST_TIMEOUT_MS = 60000;
const rpcError = (message, code) => Object.assign(new EluCodeError(message, { code }), { code });

export async function startAcp({ bin, args = [], cwd, env, logFile, processFile, signal, hold = null, timeoutSeconds = null, quietSeconds = null }) {
  signal?.throwIfAborted();
  if (typeof bin !== 'string' || !bin) refuse('An ACP client needs a program to start.');
  noSymlinks(logFile);
  const fd = fs.openSync(logFile, 'wx', 0o600), stderrFile = `${logFile}.stderr`;
  noSymlinks(stderrFile);
  const stderrFd = fs.openSync(stderrFile, 'wx', 0o600);
  let child;
  try { child = spawn(bin, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', stderrFd] }); }
  finally { fs.closeSync(stderrFd); }
  const pending = new Map(), handlers = new Map();
  let next = 0, written = 0, timedOut = false, outputLimit = false, closed = false, elapsed = 0, quiet = 0, heard = false, stoppedBy = null;
  const stop = () => killGroup(child.pid, 'SIGKILL');
  const send = value => { if (child.stdin.destroyed || closed) return false; child.stdin.write(`${JSON.stringify(value)}\n`); return true; };
  const log = line => { heard = true; written += line.length + 1; if (written > OUTPUT_LIMIT) { outputLimit = true; stop(); return; } fs.writeSync(fd, `${line}\n`); };
  const failAll = reason => { for (const [id, entry] of pending) { pending.delete(id); clearTimeout(entry.timer); entry.reject(rpcError(reason, -32001)); } };
  if (child.pid) {
    const record = { pid: child.pid, identity: processIdentity(child.pid), bin: path.basename(bin) };
    if (processFile) atomic(processFile, record);
  }
  // A held run (an approval waiting for the owner) spends neither clock, and its quiet clock
  // starts again after the wait.
  const expire = kind => { if (timedOut) return; timedOut = true; stoppedBy = kind; stop(); };
  const timer = timeoutSeconds || quietSeconds ? setInterval(() => {
    if (heard) { heard = false; quiet = 0; }
    if (hold?.()) { quiet = 0; return; }
    elapsed += 1; quiet += 1;
    if (timeoutSeconds && elapsed >= timeoutSeconds) expire('cap');
    else if (quietSeconds && quiet >= quietSeconds) expire('quiet');
  }, 1000) : null;
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, stop);
  child.stdin.on('error', () => {});
  const exit = new Promise(resolve => {
    child.once('error', error => resolve({ code: null, error: error.message }));
    child.once('close', (code, signalName) => resolve({ code, signal: signalName }));
  }).then(result => {
    closed = true; if (timer) clearInterval(timer); stop();
    signal?.removeEventListener('abort', stop);
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, stop);
    if (processFile) atomic(processFile, { pid: null, identity: null });
    fs.closeSync(fd);
    failAll(`${path.basename(bin)} exited.`);
    return { ...result, timedOut, stoppedBy, outputLimit, stderrFile, log: logFile };
  });
  // Each server line: a reply to one of our requests, a request we must answer, or a notification.
  async function receive(row) {
    if (row.id !== undefined && row.method === undefined) {
      const entry = pending.get(row.id); if (!entry) return;
      pending.delete(row.id); clearTimeout(entry.timer);
      if (row.error) entry.reject(rpcError(String(row.error.message ?? 'The vendor returned an error.').slice(0, 1000), Number.isInteger(row.error.code) ? row.error.code : -32000));
      else entry.resolve(row.result);
      return;
    }
    if (typeof row.method !== 'string') return;
    const handler = handlers.get(row.method);
    if (row.id === undefined) { if (handler) { try { await handler(row.params); } catch { /* A notification handler's failure is the handler's own. */ } } return; }
    if (!handler) { send({ jsonrpc: '2.0', id: row.id, error: { code: -32601, message: 'Method not found' } }); return; }
    try { send({ jsonrpc: '2.0', id: row.id, result: await handler(row.params) ?? null }); }
    catch (error) { send({ jsonrpc: '2.0', id: row.id, error: { code: Number.isInteger(error.code) ? error.code : -32000, message: String(error.message ?? 'The handler failed.').slice(0, 1000) } }); }
  }
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let chain = Promise.resolve();
  lines.on('line', line => {
    if (line.length > LINE_LIMIT) { outputLimit = true; stop(); return; }
    log(line);
    let row; try { row = JSON.parse(line); } catch { return; }
    if (!row || typeof row !== 'object') return;
    chain = chain.then(() => receive(row));
  });
  return {
    pid: child.pid, exit,
    request(method, params = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
      if (typeof method !== 'string' || !method) refuse('A request names its method.');
      if (closed) return Promise.reject(rpcError(`${path.basename(bin)} exited.`, -32001));
      const id = ++next;
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, timer: setTimeout(() => { if (pending.delete(id)) reject(rpcError(`No answer to ${method} within ${Math.round(timeoutMs / 1000)} seconds.`, -32002)); }, timeoutMs) };
        pending.set(id, entry);
        if (!send({ jsonrpc: '2.0', id, method, params })) { pending.delete(id); clearTimeout(entry.timer); reject(rpcError(`${path.basename(bin)} exited.`, -32001)); }
      });
    },
    notify(method, params = {}) { if (typeof method !== 'string' || !method) refuse('A notification names its method.'); return send({ jsonrpc: '2.0', method, params }); },
    on(method, handler) { if (typeof method !== 'string' || typeof handler !== 'function') refuse('on(method, handler) needs a method name and a function.'); handlers.set(method, handler); },
    close() {
      if (closed) return exit;
      try { child.stdin.end(); } catch { /* Already closed. */ }
      killGroup(child.pid, 'SIGTERM');
      const force = setTimeout(stop, 250);
      return exit.then(result => { clearTimeout(force); return result; });
    },
  };
}
