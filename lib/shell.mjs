import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killGroup } from './process.mjs';
import { taskDir } from './state.mjs';
import { dataBlock, noSymlinks } from './util.mjs';
import { redact } from './publish.mjs';

// Commands the owner runs from the message box with ! (README, "Commands").
// A command typed in an open session is saved beside it, one JSON line per command:
//   {at, command, cwd, output, code, signal, stopped, error}
//   whole: all the output kept while it ran, when output is shorter
// The chat shows these rows with output, OUTPUT_MAX characters at most, and the lead gets them
// with the owner's next message, every command with whole. Possible secrets in the output are
// masked before a row is saved. While a command runs, ELU holds the first HEAD and the last
// TAIL characters of what it prints, so a command that prints without end cannot fill memory.
export const OUTPUT_MAX = 8000, TIME_LIMIT_MS = 10 * 60000;
// The chat reads the newest ROWS rows from the last FILE_MAX bytes of the file, room for ROWS
// rows with whole output each.
const HEAD = 100000, TAIL = 300000, ROWS = 20, FILE_MAX = 16 * 1024 * 1024;

// Output as plain text: no colour codes or cursor moves, and a line redrawn with a
// carriage return keeps its last state.
export function plainOutput(value) {
  return String(value ?? '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n').split('\n').map(line => line.slice(line.lastIndexOf('\r') + 1)).join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
// A long output loses its middle, so the start and the end both stay.
export function fitOutput(text, max = OUTPUT_MAX) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  return `${text.slice(0, head)}\n[… ${text.length - max} characters cut …]\n${text.slice(head - max)}`;
}
// Runs one command in the user's shell, with no input and no terminal of its own.
// done resolves (never rejects) with {output, code, signal, stopped, error}; tail() is the
// end of the output so far; stop() ends the command and everything it started.
export function runShell(command, { cwd, env = process.env, onOutput = () => {}, limitMs = TIME_LIMIT_MS } = {}) {
  let head = '', tail = '', dropped = 0, stopped = null, child = null, timer = null, settle = null;
  const all = () => plainOutput(dropped ? `${head}\n[… ${dropped} characters cut …]\n${tail}` : head + tail);
  const take = text => {
    const room = HEAD - head.length;
    head += text.slice(0, Math.max(0, room)); tail += text.slice(Math.max(0, room));
    if (tail.length > TAIL) { dropped += tail.length - TAIL; tail = tail.slice(-TAIL); }
    onOutput();
  };
  const stop = (reason = 'stopped') => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    stopped ??= reason;
    const kill = signal => { if (process.platform === 'win32') child.kill(signal); else killGroup(child.pid, signal); };
    kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 2000).unref();
  };
  const done = new Promise(resolve => {
    let finished = false;
    const finish = (code, signal, error = null) => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(settle);
      const text = all().trimEnd(), whole = text.length > OUTPUT_MAX ? { whole: redact(text, Infinity) } : {};
      resolve({ output: redact(fitOutput(text), OUTPUT_MAX + 200), ...whole, code, signal, stopped, error });
    };
    try { child = spawn(command, { cwd, env, shell: process.env.SHELL || true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true }); }
    catch (error) { finish(null, null, error.message); return; }
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding('utf8'); stream.on('data', take); stream.on('error', () => {}); }
    child.on('error', error => finish(null, null, error.message));
    child.on('close', (code, signal) => finish(code, signal));
    // A command that leaves something running in the background ends when its shell does.
    child.on('exit', (code, signal) => { settle = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code, signal); }, 500); });
    timer = setTimeout(() => stop('time'), limitMs);
  });
  return { done, stop, tail: (max = 4000) => plainOutput((head + tail).slice(-max)) };
}

const file = (repo, id) => path.join(taskDir(repo, id), 'shell.jsonl');
export const shellFile = file;
export function recordShell(repo, id, row) {
  const target = file(repo, id); noSymlinks(target);
  fs.appendFileSync(target, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}
// The newest rows of a session, oldest first; limit Infinity reads every row. A torn or
// foreign line is skipped.
export function shellRows(repo, id, limit = ROWS) {
  let text;
  try {
    const target = file(repo, id); noSymlinks(target);
    const size = fs.statSync(target).size, fd = fs.openSync(target, 'r');
    try { const buffer = Buffer.alloc(limit === Infinity ? size : Math.min(size, FILE_MAX)); fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length); text = buffer.toString('utf8'); }
    finally { fs.closeSync(fd); }
  } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    try { const row = JSON.parse(line); if (row && typeof row.command === 'string' && typeof row.at === 'string') rows.push(row); } catch { /* Skipped. */ }
  }
  return rows.slice(-limit);
}
// How a finished command reads, in the chat and to the lead: the command, its output, and how it ended.
const shellEnd = row => row.error ? `could not start: ${row.error}` : row.stopped === 'time' ? 'stopped: it ran for 10 minutes' : row.stopped ? 'stopped' : row.signal ? `ended by ${row.signal}` : row.code ? `exit ${row.code}` : '';
export function shellText(row) {
  return [`$ ${row.command}`, typeof row.output === 'string' ? row.output : '', shellEnd(row)].filter(Boolean).join('\n');
}
// A finished command as a model reads it. The command line is the owner's, and how it ended
// is the app's. What it printed is whatever the files and programs it touched put there, so
// it travels in a data block of its own and is never read as the owner's words. All of it
// that was kept; short (the model said the prompt is too long): the chat's OUTPUT_MAX.
export function shellForModel(row, { short = false } = {}) {
  const output = !short && typeof row.whole === 'string' ? row.whole : typeof row.output === 'string' ? row.output : '';
  return { text: [`$ ${row.command}`, shellEnd(row)].filter(Boolean).join('\n'), ...(output ? { output: dataBlock('Output of this command', output) } : {}) };
}
// The lead's copy of a session's commands, as messages in time order with the owner's own:
// every command; short, the newest ROWS.
export function shellMessages(repo, id, { short = false } = {}) {
  return shellRows(repo, id, short ? ROWS : Infinity).map(row => { const { text, output } = shellForModel(row, { short }); return { at: row.at, shell: true, text: `The owner ran this in ${row.cwd ?? 'the project'}:\n${text}`, ...(output ? { output } : {}) }; });
}
