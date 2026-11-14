import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isObject } from './util.mjs';
import { cleanTokens, codexTokens } from './agent-spend.mjs';

// What Codex's own record of a thread says one run of it used. Codex keeps each thread in a
// rollout file under its home (CODEX_HOME, else ~/.codex):
// sessions/YYYY/MM/DD/rollout-<local time>-<thread>.jsonl, under the day the thread began
// (local time); a thread's id is a UUIDv7, whose first 48 bits are that time. Each line is
// { timestamp (UTC), type, payload }. codex-cli 0.167.0 writes a token_usage_record line for
// each request a turn made: that request's usage, and the turn's so far (turn_token_usage).
// A run is the lines between when it started and when it ended. A file Codex has put away
// compressed (.jsonl.zst), or none found, says nothing: null. A symbolic link is never followed.

const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86400000, CHUNK = 1 << 20, MOST = 64 << 20;

// The home a Codex run used, from the environment it was started with.
export const codexHome = (env = process.env) => typeof env?.CODEX_HOME === 'string' && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(typeof env?.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : os.homedir(), '.codex');

const plainFile = file => { try { return fs.lstatSync(file).isFile(); } catch { return false; } };
const pad = value => String(value).padStart(2, '0');
// The rollout file of a thread: the one Codex named (named, from lib/codex-live.mjs), else the
// one under the day the thread began, or (a thread id that does not say when) the days around
// near. The newest when there are several.
export function rolloutFile(thread, { home, named = null, near = Date.now() } = {}) {
  if (typeof thread !== 'string' || !THREAD.test(thread)) return null;
  if (typeof named === 'string' && path.isAbsolute(named) && named.endsWith('.jsonl') && path.basename(named).includes(thread) && plainFile(named)) return named;
  if (typeof home !== 'string' || !home) return null;
  const began = thread[14] === '7' ? parseInt(thread.slice(0, 8) + thread.slice(9, 13), 16) : NaN, days = new Set();
  for (const at of [began, near].filter(Number.isFinite)) for (const shift of [-1, 0, 1]) { const day = new Date(at + shift * DAY); days.add(path.join(home, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()))); }
  let found = null;
  for (const dir of days) {
    let names = []; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl') || !(name.endsWith(`-${thread}.jsonl`) || name.includes(`-${thread}_`))) continue;
      const file = path.join(dir, name); let stat; try { stat = fs.lstatSync(file); } catch { continue; }
      if (stat.isFile() && (!found || stat.mtimeMs > found.mtimeMs)) found = { file, mtimeMs: stat.mtimeMs };
    }
  }
  return found?.file ?? null;
}

// The lines of a file from its end, a part at a time, as Buffers; at most MOST bytes are read.
// done(): whether the whole file was.
function backwards(fd, size) {
  let end = size, rest = Buffer.alloc(0), read = 0;
  return {
    done: () => end === 0 && rest.length === 0,
    *[Symbol.iterator]() {
      while (end > 0 && read < MOST) {
        const start = Math.max(0, end - CHUNK), bytes = Buffer.alloc(end - start);
        fs.readSync(fd, bytes, 0, bytes.length, start); read += bytes.length; end = start;
        let buffer = Buffer.concat([bytes, rest]), cut;
        while ((cut = buffer.lastIndexOf(10)) >= 0) { yield buffer.subarray(cut + 1); buffer = buffer.subarray(0, cut); }
        rest = buffer;
        if (end === 0) { const first = rest; rest = Buffer.alloc(0); yield first; }
      }
    },
  };
}
const HEAD = /^\{"timestamp":"([^"]{10,40})"(?:,"ordinal":\d+)?,"type":"([a-z_]+)"/;
// What a run of thread used, read from its rollout file: the lines from from to to (times in
// ms). { tokens } as runUsage counts a Codex run's: the last turn_token_usage of each turn
// (Codex's own figure for the turn), added up; null when no request was recorded. null when
// the file cannot be read, or its lines of the run could not all be read.
export function rolloutRun(file, { thread, from, to }) {
  if (typeof file !== 'string' || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  let fd; try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); } catch { return null; }
  try {
    const stat = fs.fstatSync(fd); if (!stat.isFile()) return null;
    const lines = backwards(fd, stat.size), turns = new Map(); let before = false;
    for (const line of lines) {
      const head = HEAD.exec(line.subarray(0, 200).toString('utf8'));
      if (!head) continue;
      const at = Date.parse(head[1]);
      if (!Number.isFinite(at)) continue;
      if (at < from) { before = true; break; }
      if (at > to || head[2] !== 'token_usage_record') continue;
      let row; try { row = JSON.parse(line.toString('utf8')); } catch { continue; }
      const payload = isObject(row.payload) ? row.payload : {};
      if (typeof payload.thread_id === 'string' && thread && payload.thread_id !== thread) continue;
      const turn = typeof payload.turn_id === 'string' ? payload.turn_id : `#${turns.size}`;
      // Read from the end: a turn's first record seen is its last, which holds the turn so far.
      if (!turns.has(turn) && isObject(payload.turn_token_usage)) turns.set(turn, codexTokens(payload.turn_token_usage));
    }
    if (!before && !lines.done()) return null;
    const tokens = [...turns.values()].reduce((sum, used) => !used ? sum : !sum ? used : cleanTokens({ input: sum.input + used.input, output: sum.output + used.output, cacheRead: sum.cacheRead + used.cacheRead, cacheWrite: sum.cacheWrite + used.cacheWrite }), null);
    return { tokens };
  } catch { return null; } finally { fs.closeSync(fd); }
}

// What a Codex run used by Codex's own record of its thread (rolloutRun), its thread and the
// file named by its log (logSpend), found under the home it ran with (env). null when there is none.
export function codexRunRecord({ thread, named = null, env = process.env, from, to }) {
  const file = rolloutFile(thread, { home: codexHome(env), named, near: from });
  return file ? rolloutRun(file, { thread, from, to }) : null;
}
