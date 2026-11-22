import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash } from './util.mjs';
import { SESSION_TAG } from './process.mjs';
import { VENDORS } from './vendors.mjs';

// The helpers a session's agents started outside ELU jobs (a lead's `setsid nohup codex exec …
// &`, a `claude -p` in the background), for the session's Agents tab (lib/session-agents.mjs).
// Every turn's environment names its session and project (lib/process.mjs SESSION_TAG, set by
// lib/runner.mjs sessionTag), and every process it starts keeps them, detached or not. A helper
// is a vendor's program run headless (codex exec, claude -p or --print, agy or grok -p) that
// carries this session's two names, and that is not the turn ELU itself started: not the run's
// own process (its process.json), nor one ELU's own process started (a turn, a bot's, a job).
//
// Read from the process table: on Linux /proc (cmdline, stat, environ, and fd/1 and cwd for
// where it writes and works), on macOS ps (the table, then -E for the environment of the vendor
// programs alone) and lsof (fd 1 and cwd of the helpers alone). Only when asked (the Agents tab
// open, session_agents, elu.remote.agents), and at most once every PROCESS_READ_MS: the table is
// kept that long. Only the session's two names are kept of a process's environment.
//
// A helper that ended is kept as done for DONE_KEPT_MS when what it wrote is known (its output
// file, or Codex's --output-last-message), so the tab can still say what it did.

export const PROCESS_READ_MS = 5000, DONE_KEPT_MS = 10 * 60000;
const SEEN_SESSIONS = 64, SEEN_PER_SESSION = 40, ANCESTORS = 16;
const BINS = new Set(VENDORS);
const NODE = /(?:^|\/)(?:node|nodejs|bun)[\d.]*$/;
const ELU_PROGRAM = /(?:^|\/)(?:elu-code\.mjs|elu-code|elu|elu\.cjs|elu\.mjs)$/;
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const unquote = value => String(value ?? '').replace(/^['"]|['"]$/g, '');
const base = word => path.basename(String(word ?? ''));

/**
 * One process, as a table reader gives it.
 * @typedef {{ pid: number, ppid: number, start: number|null, argv: string[],
 *   env: Record<string, string>|null,   // the session's two names (SESSION_TAG), read for vendor programs only
 *   out: string|null, cwd: string|null  // the file its output goes to, and where it works, when known
 * }} ProcessRow
 */

// The vendor a command line runs, and where its program word is: its program (codex, claude, agy,
// grok, by its file's name), or node running one. null for anything else.
export function vendorOf(argv) {
  const words = Array.isArray(argv) ? argv : [], first = words[0] ?? '';
  if (BINS.has(base(first))) return { vendor: base(first), at: 0 };
  if (NODE.test(first)) { const at = words.findIndex((word, index) => index > 0 && !String(word).startsWith('-')); if (at > 0 && BINS.has(base(words[at]))) return { vendor: base(words[at]), at }; }
  return null;
}
// How each of the four programs runs headless, as its --help says: Claude Code -p or --print;
// Codex exec; Grok Build -p (--single), --prompt-file or --prompt-json; Antigravity -p, --print or
// --prompt. A long flag may carry its value after =.
const HEADLESS = Object.freeze({ claude: ['-p', '--print'], grok: ['-p', '--single', '--prompt', '--prompt-file', '--prompt-json'], agy: ['-p', '--print', '--prompt'] });
const isFlag = (word, flag) => word === flag || (flag.startsWith('--') && word.startsWith(`${flag}=`));
const headless = (vendor, rest) => vendor === 'codex' ? rest.includes('exec') : rest.some(word => (HEADLESS[vendor] ?? []).some(flag => isFlag(word, flag)));
// The words that name the effort: Claude Code and Antigravity --effort, Grok Build
// --reasoning-effort (or its alias --effort), Codex -c model_reasoning_effort=.
const EFFORT_FLAGS = Object.freeze(['--effort', '--reasoning-effort']);
// What a helper's command line says of it: { vendor, model, effort, folder, lastMessage }, or
// null when it is no vendor's program run headless. model from -m or --model (or -c model=),
// effort from --effort, --reasoning-effort or -c model_reasoning_effort=, folder from -C or
// --cd, and for Codex the file its last message goes to (-o, --output-last-message).
export function agentArgs(argv) {
  const found = vendorOf(argv); if (!found) return null;
  const rest = argv.slice(found.at + 1).map(String);
  if (!headless(found.vendor, rest)) return null;
  let model = null, effort = null, folder = null, lastMessage = null;
  rest.forEach((word, at) => {
    const next = rest[at + 1] === undefined ? null : unquote(rest[at + 1]);
    if (['-m', '--model'].includes(word) && next) model = next;
    else if (word.startsWith('--model=')) model = unquote(word.slice(8));
    else if (EFFORT_FLAGS.includes(word) && next) effort = next;
    else if (EFFORT_FLAGS.some(flag => word.startsWith(`${flag}=`))) effort = unquote(word.slice(word.indexOf('=') + 1));
    else if (['-c', '--config'].includes(word) && next) {
      const pair = /^([a-z_]+)=(.*)$/.exec(next);
      if (pair?.[1] === 'model') model = unquote(pair[2]);
      if (pair?.[1] === 'model_reasoning_effort') effort = unquote(pair[2]);
    } else if (['-C', '--cd'].includes(word) && next) folder = next;
    else if (word.startsWith('--cd=')) folder = unquote(word.slice(5));
    else if (found.vendor === 'codex' && ['-o', '--output-last-message'].includes(word) && next) lastMessage = next;
  });
  return { vendor: found.vendor, model: model && model.length <= 100 ? model : null, effort: effort && /^[a-z]{1,12}$/.test(effort) ? effort : null, folder: folder && folder.length <= 4096 ? folder : null, lastMessage: lastMessage && lastMessage.length <= 4096 ? lastMessage : null };
}
// A helper a shell command of a turn started (its command line as the turn's log has it):
// { vendor, model, effort } for one of the four programs run headless, or null. Each part of a
// list or a pipe is read on its own, its words unquoted.
export function commandAgent(commandLine) {
  for (const part of String(commandLine ?? '').split(/[;&|]+|\$\(|`/)) {
    const words = part.trim().split(/\s+/).map(unquote), at = words.findIndex(word => BINS.has(base(word)));
    const found = at >= 0 ? agentArgs(words.slice(at)) : null;
    if (found) return { vendor: found.vendor, model: found.model, effort: found.effort };
  }
  return null;
}
// The session's two names among a process's environment (KEY=value words), the last of each.
function tagsOf(words) {
  const out = {};
  for (const word of words) for (const name of Object.values(SESSION_TAG)) if (typeof word === 'string' && word.startsWith(`${name}=`)) out[name] = word.slice(name.length + 1);
  return Object.keys(out).length ? out : null;
}
// A file a process writes to, as fd 1 names it: only a file by its full path, never a terminal,
// a pipe, a socket or /dev/null.
const fileTarget = value => typeof value === 'string' && path.isAbsolute(value) && !value.startsWith('/dev/') && !/ \(deleted\)$/.test(value) ? value : null;

// ---- Linux: /proc ----
/** @returns {ProcessRow[]} */
export function linuxTable({ proc = '/proc' } = {}) {
  let names = []; try { names = fs.readdirSync(proc).filter(name => /^[0-9]+$/.test(name)); } catch { return []; }
  let boot = null; try { const at = Number(/^btime\s+([0-9]+)/m.exec(fs.readFileSync(path.join(proc, 'stat'), 'utf8'))?.[1]); boot = Number.isFinite(at) && at > 0 ? at * 1000 : null; } catch { boot = null; }
  const link = file => { try { return fs.readlinkSync(file); } catch { return null; } };
  const rows = [];
  for (const name of names) {
    const dir = path.join(proc, name);
    let argv, stat;
    try { argv = fs.readFileSync(path.join(dir, 'cmdline'), 'utf8').split('\0').filter(Boolean); stat = fs.readFileSync(path.join(dir, 'stat'), 'utf8'); } catch { continue; }
    // After the name in parentheses: state, ppid, … starttime (the 22nd field), in clock ticks since boot (100 a second).
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' '), ppid = Number(after[1]), ticks = Number(after[19]);
    const row = { pid: Number(name), ppid: Number.isInteger(ppid) ? ppid : 0, start: boot !== null && Number.isFinite(ticks) ? boot + ticks * 10 : null, argv, env: null, out: null, cwd: null };
    if (vendorOf(argv)) {
      try { row.env = tagsOf(fs.readFileSync(path.join(dir, 'environ'), 'utf8').split('\0')); } catch { row.env = null; }
      if (row.env && agentArgs(argv)) { row.out = fileTarget(link(path.join(dir, 'fd', '1'))); row.cwd = fileTarget(link(path.join(dir, 'cwd'))); }
    }
    rows.push(row);
  }
  return rows;
}

// ---- macOS: ps and lsof ----
const runText = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 3000, env: { ...process.env, LC_ALL: 'C' } });
  return !r.error && typeof r.stdout === 'string' && (r.status === 0 || r.stdout.trim()) ? r.stdout : null;
};
const LSTART = /^\s*([0-9]+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4})\s+(.*)$/;
// Where each helper writes and works, by its process: kept for the process (its number and
// start), since neither changes while it runs, so lsof is asked only of new ones.
const places = new Map();
/** @param {{ run?: (bin: string, args: string[]) => string|null }} [options] @returns {ProcessRow[]} */
export function psTable({ run = runText } = {}) {
  const table = run('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'command=']);
  if (typeof table !== 'string') return [];
  const rows = table.split('\n').map(line => /^\s*([0-9]+)\s+([0-9]+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), start: null, argv: command.trim().split(/\s+/), env: null, out: null, cwd: null }));
  const vendors = rows.filter(row => vendorOf(row.argv));
  if (!vendors.length) return rows;
  const byPid = new Map(rows.map(row => [row.pid, row]));
  // -E puts the environment after the command: the session's names are found among its words.
  for (const line of (run('ps', ['-E', '-ww', '-o', 'pid=', '-o', 'lstart=', '-o', 'command=', '-p', vendors.map(row => row.pid).join(',')]) ?? '').split('\n')) {
    const m = LSTART.exec(line), row = m ? byPid.get(Number(m[1])) : null;
    if (!row) continue;
    const at = Date.parse(m[2]); row.start = Number.isFinite(at) ? at : null;
    row.env = tagsOf(m[3].split(/\s+/));
  }
  const helpers = vendors.filter(row => row.env && agentArgs(row.argv)), fresh = helpers.filter(row => !places.has(`${row.pid}:${row.start}`));
  if (fresh.length) {
    const found = new Map(); let pid = null, fd = null;
    for (const line of (run('lsof', ['-a', '-d', 'cwd,1', '-Fpfn', '-p', fresh.map(row => row.pid).join(',')]) ?? '').split('\n')) {
      if (line.startsWith('p')) { pid = Number(line.slice(1)); fd = null; if (!found.has(pid)) found.set(pid, { out: null, cwd: null }); }
      else if (line.startsWith('f')) fd = line.slice(1);
      else if (line.startsWith('n') && found.has(pid)) { if (fd === '1') found.get(pid).out = fileTarget(line.slice(1)); else if (fd === 'cwd') found.get(pid).cwd = fileTarget(line.slice(1)); }
    }
    for (const row of fresh) { places.set(`${row.pid}:${row.start}`, found.get(row.pid) ?? { out: null, cwd: null }); if (places.size > 400) places.delete(places.keys().next().value); }
  }
  for (const row of helpers) Object.assign(row, places.get(`${row.pid}:${row.start}`) ?? {});
  return rows;
}

// ---- the table, kept PROCESS_READ_MS ----
let lister = null, kept = null;
// A stand-in for the table, for a test: lister() returns ProcessRow[]. Returns what puts it back.
export function useProcessLister(fn) { const before = lister; lister = typeof fn === 'function' ? fn : null; kept = null; return () => { lister = before; kept = null; }; }
/** @returns {ProcessRow[]} */
export function processTable({ now = Date.now() } = {}) {
  if (kept && now - kept.at < PROCESS_READ_MS && now >= kept.at) return kept.rows;
  let rows = [];
  try { rows = lister ? lister() : process.platform === 'linux' ? linuxTable() : process.platform === 'darwin' ? psTable() : []; } catch { rows = []; }
  kept = { at: now, rows: Array.isArray(rows) ? rows.filter(row => row && Number.isInteger(row.pid)) : [] };
  return kept.rows;
}

// ---- a session's helpers ----
// The id a session's project goes by in every turn's environment (lib/peer/remote.mjs projectKey).
export const projectIdOf = repo => hash(`project\0${repo?.project ?? repo?.root}`).slice(0, 16);
// One of ELU's own processes: this one, or ELU's program (a window, the conductor, a job's runner).
function eluProcess(row) {
  if (row.pid === process.pid) return true;
  const argv = Array.isArray(row.argv) ? row.argv : [], program = NODE.test(argv[0] ?? '') ? argv.find((word, index) => index > 0 && !String(word).startsWith('-')) ?? '' : argv[0] ?? '';
  return ELU_PROGRAM.test(program) || program.startsWith(PACKAGE_ROOT + path.sep) || program.includes(`${path.sep}@elu-labs${path.sep}elu${path.sep}`);
}
// Whether child is the vendor's own binary that its node launcher (parent) started: the same
// vendor, run by node above, with the same words after the program.
function launched(parent, child) {
  const above = vendorOf(parent.argv ?? []), below = vendorOf(child.argv ?? []);
  return Boolean(above && below) && above.at > 0 && above.vendor === below.vendor && parent.argv.slice(above.at + 1).join('\0') === child.argv.slice(below.at + 1).join('\0');
}
// What was seen of each session's helpers: { pid, start, argv, args, by, log, cwd, endedAt, firstSeen }.
const seen = new Map();
/**
 * The helpers of a session now, oldest first, each { pid, start, argv, args, by, log, cwd,
 * state: 'working'|'done', endedAt, firstSeen }. by: 'run' when it was started below the turn ELU
 * runs now (runPid), the number of another helper it was started below, else null (its starter
 * left it). A helper that ended stays, done, for DONE_KEPT_MS when what it wrote is known.
 * @param {object} repo @param {object} task @param {{ now?: number, runPid?: number|null }} [options]
 */
export function sessionProcesses(repo, task, { now = Date.now(), runPid = null } = {}) {
  if (!repo || !task || !/^[1-9][0-9]*$/.test(String(task.id ?? ''))) return [];
  const session = String(task.id), project = projectIdOf(repo), rows = processTable({ now }), byPid = new Map(rows.map(row => [row.pid, row]));
  const ours = row => Boolean(row?.env) && row.env[SESSION_TAG.session] === session && row.env[SESSION_TAG.project] === project;
  const found = [];
  for (const row of rows) {
    if (!ours(row) || row.pid === runPid) continue;
    const args = agentArgs(row.argv ?? []); if (!args) continue;
    const parent = byPid.get(row.ppid);
    // A vendor's program below its own launcher (Codex's node script and the binary it starts with
    // the same words) is one agent.
    if (parent && ours(parent) && launched(parent, row)) continue;
    // Up the chain: below the turn ELU runs, below another vendor program of the session (a helper,
    // or a lead that ELU runs as a server), or below ELU itself, which makes it a turn or a job of ELU's.
    let by = null, elu = false;
    for (let at = parent, hops = 0; at && hops < ANCESTORS; at = byPid.get(at.ppid), hops++) {
      if (at.pid === runPid) { by = 'run'; break; }
      if (ours(at) && vendorOf(at.argv ?? [])) { by = at.pid; break; }
      if (eluProcess(at)) { elu = true; break; }
      if (at.pid <= 1 || at.ppid === at.pid) break;
    }
    if (!elu) found.push({ row, args, by });
  }
  const key = `${project}\0${session}`;
  let known = seen.get(key);
  if (!known) { known = new Map(); seen.set(key, known); if (seen.size > SEEN_SESSIONS) seen.delete(seen.keys().next().value); }
  const live = new Set();
  for (const { row, args, by } of found) {
    const id = `${row.pid}:${row.start ?? ''}`, had = known.get(id); live.add(id);
    known.set(id, { pid: row.pid, start: row.start ?? null, argv: row.argv, args, by: typeof by === 'number' && found.some(item => item.row.pid === by) ? by : by === 'run' ? 'run' : null, log: row.out ?? had?.log ?? null, cwd: row.cwd ?? had?.cwd ?? null, endedAt: null, firstSeen: had?.firstSeen ?? now });
  }
  for (const [id, value] of known) {
    if (live.has(id)) continue;
    if (value.endedAt === null) value.endedAt = now;
    if (!(value.log || value.args.lastMessage) || now - value.endedAt > DONE_KEPT_MS) known.delete(id);
  }
  while (known.size > SEEN_PER_SESSION) known.delete(known.keys().next().value);
  return [...known.values()].map(value => ({ ...value, state: value.endedAt === null ? 'working' : 'done' })).sort((a, b) => (a.start ?? a.firstSeen) - (b.start ?? b.firstSeen));
}
