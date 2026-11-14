import fs from 'node:fs';
import { isObject, linesOf } from './util.mjs';
import { taskTitle } from './state.mjs';
import { claudeId, modelName, vendorShort } from './models.mjs';
import { botOfKey, getBot } from './bots.mjs';
import { sanitize } from './peer/peerdata.mjs';
import { columns, head, padEnd, padStart } from './width.mjs';
import { listCost } from './prices.mjs';

// What each agent spent: per run, the tokens and the cost of that run alone (runSpends, read
// from the run's own log where its record does not hold them); per agent in a session, those
// runs added up for today or the last seven days (agentSpend); and the Usage tab's rows
// (agentTable). A cost is the vendor's own figure; where the vendor reported tokens and no
// cost, it is those tokens at the model's API list price (lib/prices.mjs). A run with neither,
// or on a model with no known price, adds nothing to a cost and marks it partial.

export const TOP_AGENTS = 10;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const money = value => Number.isFinite(value) && value >= 0 ? value : null;
// Tokens of one run or one agent: input (not read from the cache), output, cache read, cache
// write. null when the vendor reported none of them.
export function cleanTokens(value) {
  if (!isObject(value)) return null;
  const row = { input: count(value.input), output: count(value.output), cacheRead: count(value.cacheRead), cacheWrite: count(value.cacheWrite) };
  return Object.values(row).some(item => item !== null) ? { input: row.input ?? 0, output: row.output ?? 0, cacheRead: row.cacheRead ?? 0, cacheWrite: row.cacheWrite ?? 0 } : null;
}
const addTokens = (a, b) => !a ? b : !b ? a : { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
const lessTokens = (a, b) => ({ input: a.input - b.input, output: a.output - b.output, cacheRead: a.cacheRead - b.cacheRead, cacheWrite: a.cacheWrite - b.cacheWrite });
const sameTokens = (a, b) => Boolean(a && b) && a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;
const NONE = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const lines = text => String(text ?? '').split('\n').flatMap(line => { try { const row = JSON.parse(line); return isObject(row) ? [row] : []; } catch { return []; } });
// The JSON object rows of a log, one at a time: a text, or its lines (linesOf in lib/util.mjs).
function* rowsOf(text) { for (const line of linesOf(text ?? '')) { try { const row = JSON.parse(line); if (isObject(row)) yield row; } catch { /* Not a row. */ } } }
// Claude Code's result: its own model's tokens (usage), the tokens and cost of every model it
// called (modelUsage, the smaller ones too) and its total cost.
function claudeResult(row) {
  const models = isObject(row.modelUsage) ? Object.fromEntries(Object.entries(row.modelUsage).filter(([id, value]) => isObject(value) && id.length <= 100).map(([id, value]) => [id, { tokens: cleanTokens({ input: value.inputTokens, output: value.outputTokens, cacheRead: value.cacheReadInputTokens, cacheWrite: value.cacheCreationInputTokens }) ?? NONE, costUsd: money(value.costUSD) ?? 0 }])) : null;
  const usage = isObject(row.usage) ? cleanTokens({ input: row.usage.input_tokens, output: row.usage.output_tokens, cacheRead: row.usage.cache_read_input_tokens, cacheWrite: row.usage.cache_creation_input_tokens }) : null;
  return { total: money(row.total_cost_usd), usage, models: models && Object.keys(models).length ? models : null, session: typeof row.session_id === 'string' ? row.session_id : null };
}
const sumModels = models => Object.values(models).reduce((sum, row) => addTokens(sum, row.tokens), null);
// The model that cost the most, else the first one named.
const topModel = models => { const top = Object.entries(models ?? {}).sort(([, a], [, b]) => b.costUsd - a.costUsd)[0]?.[0]; return typeof top === 'string' ? top : null; };
// The tokens an ACP turn ended with, on the answer to session/prompt. The protocol's own
// `usage` names input apart from the cache; its thought tokens are added to the output only
// where the total shows they are counted apart from it. Grok Build sends `_meta.usage`, whose
// inputTokens is the whole prompt, cache included. `_meta.quota.token_count` holds input and
// output alone. None of them: null. The context meter (usage_update) is not what a turn spent.
function acpTokens(result) {
  const own = result.usage, meta = isObject(result._meta) ? result._meta : {}, sent = meta.usage, quota = meta.quota?.token_count;
  if (isObject(own)) {
    const thought = count(own.thoughtTokens) ?? 0, rest = [own.inputTokens, own.outputTokens, own.cachedReadTokens, own.cachedWriteTokens].reduce((sum, value) => sum + (count(value) ?? 0), 0);
    return cleanTokens({ input: own.inputTokens, output: count(own.outputTokens) !== null && own.totalTokens === rest + thought ? own.outputTokens + thought : own.outputTokens, cacheRead: own.cachedReadTokens, cacheWrite: own.cachedWriteTokens });
  }
  if (isObject(sent)) {
    const read = count(sent.cachedReadTokens) ?? count(sent.cacheReadTokens) ?? count(sent.cacheReadInputTokens), write = count(sent.cacheCreationTokens) ?? count(sent.cachedWriteTokens) ?? count(sent.cacheCreationInputTokens);
    return cleanTokens({ input: count(sent.inputTokens) === null ? null : Math.max(0, sent.inputTokens - (read ?? 0) - (write ?? 0)), output: sent.outputTokens, cacheRead: read, cacheWrite: write });
  }
  return isObject(quota) ? cleanTokens({ input: quota.input_tokens, output: quota.output_tokens }) : null;
}
// Codex's counts, as runUsage keeps them. Its input_tokens hold the tokens read from the cache
// and the ones written to it (its input_tokens_details: cached_tokens, cache_write_tokens);
// input here is input_tokens less the cached ones, as Codex's own non_cached_input counts it,
// so the written ones are still in it, as the runner has always kept them, and pricedSpend
// takes them out. null when it reported none.
export function codexTokens(usage) {
  if (!isObject(usage)) return null;
  const cached = count(usage.cached_input_tokens) ?? 0, input = count(usage.input_tokens);
  return cleanTokens({ input: input === null ? null : Math.max(0, input - cached), output: usage.output_tokens, cacheRead: usage.cached_input_tokens, cacheWrite: usage.cache_write_input_tokens });
}
// What one run's log says it used, as its vendor reported it: { tokens, model, models? }, each
// null when not reported; models, { id: tokens }, only for a Grok Build result that names more
// than one, whose tokens are then priced each at its own model's price.
// Claude Code: the last result event, every model it called. Codex: its last turn.completed
// event, which holds what the run's thread has used so far (ownRunSpend takes out what it had
// used before the run), the thread its thread.started line names, and the model and the
// thread's file a turn run through lib/codex-live.mjs names there (codexTokens: how its counts
// read). Grok Build: its one JSON result, or its end event, which cover every turn that run
// made and none of an earlier run of its session (Grok's headless docs), so a resumed
// session's run reports its own. A run over ACP (Antigravity, Grok Build): every turn's
// answer, each the turn's own. incomplete: Grok said its count may miss a model call
// (usage_is_incomplete, cost_is_partial, usageIsIncomplete); such a run is not priced.
// Headless Antigravity reports none.
// The log is gone through a row at a time and only the rows that count are kept, so a log of
// any size is read.
export function runUsage(vendor, text) {
  const none = { tokens: null, model: null };
  try {
    let turns = null, acp = false, last = null, incomplete = false;
    // Grok Build: the json object, or a streaming-json run's end event, which carries the same spend.
    const wanted = vendor === 'claude' ? item => item.type === 'result' : vendor === 'grok' ? item => (typeof item.text === 'string' && typeof item.stopReason === 'string') || item.type === 'end' : () => false;
    for (const row of rowsOf(text)) {
      if (row.jsonrpc === '2.0' && isObject(row.result) && typeof row.result.stopReason === 'string') { acp = true; turns = addTokens(turns, acpTokens(row.result)); incomplete ||= row.result._meta?.usage?.usageIsIncomplete === true; }
      if (wanted(row)) last = row;
    }
    if (acp) return { tokens: turns, model: null, ...(incomplete && turns ? { incomplete: true } : {}) };
    if (vendor === 'claude' || vendor === 'grok') {
      if (!last) return none;
      const { usage, models } = claudeResult(last);
      const tokens = models ? sumModels(models) : usage, partly = vendor === 'grok' && tokens && (last.usage_is_incomplete === true || last.cost_is_partial === true);
      return { tokens, model: topModel(models), ...(vendor === 'grok' && models && Object.keys(models).length > 1 ? { models: Object.fromEntries(Object.entries(models).map(([id, row]) => [id, row.tokens])) } : {}), ...(partly ? { incomplete: true } : {}) };
    }
    if (vendor === 'codex') {
      let tokens = null, model = null, thread = null, file = null;
      for (const row of rowsOf(text)) {
        if (row.type === 'thread.started') {
          if (typeof row.model === 'string' && row.model && row.model.length <= 100) model = row.model;
          if (typeof row.thread_id === 'string' && row.thread_id && row.thread_id.length <= 100) thread = row.thread_id;
          if (typeof row.path === 'string' && row.path.length <= 4096) file = row.path;
        }
        if (row.type === 'turn.completed') tokens = codexTokens(row.usage) ?? tokens;
      }
      return { tokens, model, ...(thread ? { thread } : {}), ...(file ? { file } : {}) };
    }
  } catch { /* A log that cannot be read reports nothing. */ }
  return none;
}

// A run's log, read for its spend once per change of the file: { started, ...what its vendor
// reported }. started: the vendor wrote anything at all (Claude Code writes its first line
// before it asks the model anything). A Claude Code log is read at its start (the model it
// began with) and its end (the result), so a long one costs little; any other is read whole.
// One that ends before its result (a turn that was stopped, or cut short) is read whole for
// the tokens it had reported by then. null when there is no log to read; a symbolic link is
// never followed.
const HEAD = 64 * 1024, TAIL = 1024 * 1024, WHOLE = 16 * 1024 * 1024;
const summaries = new Map();
function readPart(fd, at, length) { const bytes = Buffer.alloc(length), got = fs.readSync(fd, bytes, 0, length, at); return bytes.subarray(0, got).toString('utf8'); }
// A Claude Code log with no result at its end, read whole, a part at a time, so one of any size
// is: { result, tokens }. result: its result row after all (one longer than the end that was
// read). tokens: what the turn had used by then, the usage of each answer it had got, once (an
// answer is written again for each part of it, with the same id); null when it reported none.
function claudeWhole(fd, size) {
  const answers = new Map(), decoder = new TextDecoder(); let rest = '', result = null;
  const take = line => {
    if (!line.includes('"assistant"') && !line.includes('"result"')) return;
    for (const row of lines(line)) { if (row.type === 'result') result = row; else if (row.type === 'assistant' && isObject(row.message?.usage)) answers.set(typeof row.message.id === 'string' ? row.message.id : answers.size, row.message.usage); }
  };
  for (let at = 0; at < size; at += TAIL) {
    const bytes = Buffer.alloc(Math.min(TAIL, size - at)), got = fs.readSync(fd, bytes, 0, bytes.length, at), parts = (rest + decoder.decode(bytes.subarray(0, got), { stream: true })).split('\n');
    rest = parts.pop(); parts.forEach(take);
  }
  take(rest);
  return { result, tokens: [...answers.values()].reduce((sum, usage) => addTokens(sum, cleanTokens({ input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens })), null) };
}
export function logSpend(file, vendor) {
  if (typeof file !== 'string' || !file) return null;
  let stat; try { stat = fs.lstatSync(file); } catch { return null; }
  if (!stat.isFile()) return null;
  const sig = `${stat.ino}:${stat.size}:${stat.mtimeMs}`, id = `${vendor}\0${file}`, hit = summaries.get(id);
  if (hit?.sig === sig) return hit.value;
  let value = null;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const size = fs.fstatSync(fd).size;
      if (vendor === 'claude') {
        const head = readPart(fd, 0, Math.min(size, HEAD)), tail = size > HEAD ? readPart(fd, Math.max(HEAD, size - TAIL), Math.min(size - HEAD, TAIL)) : '';
        const init = lines(head.slice(0, head.lastIndexOf('\n') + 1 || head.length)).find(row => row.type === 'system' && row.subtype === 'init');
        const end = lines(`${head}\n${tail}`).findLast(row => row.type === 'result'), whole = end ? null : claudeWhole(fd, size), result = end ?? whole.result;
        value = { started: size > 0, model: typeof init?.model === 'string' && init.model.length <= 100 ? init.model : null, result: result ? claudeResult(result) : null, ...(!result && whole.tokens ? { tokens: whole.tokens } : {}) };
      } else {
        const text = size > WHOLE ? readPart(fd, size - WHOLE, WHOLE) : readPart(fd, 0, size);
        value = { started: size > 0, ...runUsage(vendor, text) };
      }
    } finally { fs.closeSync(fd); }
  } catch { value = null; }
  summaries.delete(id); summaries.set(id, { sig, value });
  if (summaries.size > 4000) summaries.delete(summaries.keys().next().value);
  return value;
}

// The models of a Claude Code result less those of an earlier one: null when any count went
// down, or a model the earlier one had is missing (not the same session's totals carried on).
function grown(now, before) {
  const out = {};
  for (const [id, row] of Object.entries(now)) {
    const was = before[id], tokens = was ? lessTokens(row.tokens, was.tokens) : row.tokens, costUsd = row.costUsd - (was?.costUsd ?? 0);
    if (Object.values(tokens).some(value => value < 0) || costUsd < -1e-9) return null;
    out[id] = { tokens, costUsd: Math.max(0, costUsd) };
  }
  return Object.keys(before).every(id => now[id]) ? out : null;
}
// What one Claude Code run spent itself: { costUsd, tokens, carried }. A turn that resumes a
// session reports what the whole session has spent so far: Claude Code carries the session's
// totals over from its turn before. Its own share is then its totals less those its session's
// turn before it reported (base). The numbers say which it was: this turn's own model tokens
// (usage) are exactly how much that model's line in modelUsage grew when the totals were
// carried over, and exactly that line when they were not. When neither holds (helpers on the
// same model as the turn), totals that grew in every count were carried over.
// beyond: what the turn's own model's line (model, where known) holds over the turn's own
// tokens, null when it holds exactly those. A turn of the session that was stopped before this
// one never reported a result; when Claude Code kept what it used, it shows here (stopsCounted).
export function ownClaudeSpend(result, base = null, model = null) {
  const { total, usage, models } = result;
  if (!models) {
    const carried = Boolean(base && total !== null && base.total !== null && total >= base.total);
    return { costUsd: total === null ? null : carried ? total - base.total : total, tokens: usage, carried, beyond: null };
  }
  const more = base?.models ? grown(models, base.models) : null, exact = rows => Boolean(usage) && Object.values(rows).some(row => sameTokens(row.tokens, usage));
  const carried = more && exact(more) ? true : exact(models) ? false : Boolean(more);
  const own = carried ? more : models;
  const over = !usage || exact(own) ? [] : (own[model] ? [own[model]] : Object.values(own)).map(row => lessTokens(row.tokens, usage)).filter(left => Object.values(left).every(value => value >= 0));
  return { costUsd: total === null ? null : carried ? Math.max(0, total - (base.total ?? 0)) : total, tokens: sumModels(own), carried, beyond: over[0] ?? null };
}
const runModel = run => typeof run?.model === 'string' && run.model ? run.model : null;
// A run's spend as every place adds it up: its tokens in one shape for every
// vendor, input being neither read from nor written to the cache (a Codex run's written tokens
// come out of its input, runUsage), and, where its vendor reported tokens but no cost, those
// tokens at the model's API list price (lib/prices.mjs) on the day it ran. A model with no
// price there leaves the cost unknown, and so does a count its vendor said may be incomplete.
// Claude Code reports its own cost, so a Claude Code run with none (one stopped before its
// result) stays unknown.
export function pricedSpend(spend, at = Date.now()) {
  if (!spend) return spend;
  const codex = spend.vendor === 'codex' && spend.tokens, tokens = codex ? { ...spend.tokens, input: Math.max(0, spend.tokens.input - spend.tokens.cacheWrite) } : spend.tokens;
  const listed = spend.costUsd === null && spend.started !== false && spend.vendor !== 'claude' && spend.incomplete !== true ? listCost(spend.model, tokens, { models: spend.models ?? null, at }) : null;
  return { ...spend, tokens, ...(listed !== null ? { costUsd: listed } : {}) };
}
// What each run of a session spent itself, in the order of task.runs: { vendor, model, costUsd,
// tokens, started } or null for a row that is not a run. A run recorded since its record holds
// its own spend (ownCost) is taken as it is. An older one is read from its log: a Claude Code
// turn that carried its session's totals over counts only what it added, and a run from before
// runs kept their tokens gets them from its log. Each is then as pricedSpend gives it.
// read(file, vendor): logSpend, or a stand-in. wanted(index): the runs to read (the others are
// null); every run, unless said.
export function runSpends(task, read = logSpend, wanted = () => true) {
  const runs = Array.isArray(task?.runs) ? task.runs : [], logs = new Map();
  const logOf = index => { if (!logs.has(index)) { let value = null; try { value = isObject(runs[index]) ? read(runs[index].logFile, runs[index].vendor) : null; } catch { value = null; } logs.set(index, value); } return logs.get(index); };
  return runs.map((run, index) => {
    if (!isObject(run) || !wanted(index)) return null;
    const vendor = typeof run.vendor === 'string' ? run.vendor : null;
    const at = runTime(run, task);
    if (run.ownCost === true) return pricedSpend({ vendor, model: runModel(run) ?? run.asked ?? null, costUsd: money(run.costUsd), tokens: cleanTokens(run.tokens), started: run.started !== false }, at);
    return pricedSpend(ownRunSpend(runs, index, logOf), at);
  });
}
// What each run of a session cost by itself, in the order of task.runs: dollars, or null where
// none is known. Whatever adds a session's runs up reads this one (its budget, its stop line,
// its row, its reply to a teammate), so a run from before runs kept their own cost, whose
// record holds what its whole Claude Code session had spent, counts once there too.
export const runCosts = (task, read = logSpend) => runSpends(task, read).map(spend => spend ? spend.costUsd : null);
// What a Codex run used itself: { model, reported, tokens, thread, sessionTokens? }. Codex
// reports what its thread has used so far, begun from the thread's own record when a run
// resumes it (runUsage), and a session's next message resumes its thread. A run that went on
// with the thread of an earlier run used the thread's total less that run's (base): the total
// its log reported, else the one its record kept (sessionTokens, or tokens: a run recorded
// before 0.1.26 kept the total). A total smaller in any count than the base was begun again,
// and is the run's own. own: what Codex's own record of the run's turns says it used
// (lib/codex-rollout.mjs), taken where there is one. sessionTokens: the thread's total, where
// it is more than the run's own.
function ownCodexSpend(runs, index, logOf, own) {
  const run = runs[index], log = logOf(index), thread = log?.thread ?? (typeof run.session === 'string' && run.session ? run.session : null);
  const total = log?.tokens ?? cleanTokens(run.tokens);
  let base = null;
  for (let at = index - 1; at >= 0 && thread && total && !base; at--) {
    const before = runs[at];
    if (!isObject(before) || before.vendor !== 'codex') continue;
    const earlier = logOf(at);
    if ((earlier?.thread ?? before.session) !== thread) continue;
    base = earlier?.tokens ?? cleanTokens(before.sessionTokens) ?? cleanTokens(before.tokens);
  }
  const grew = base ? lessTokens(total, base) : null, tokens = cleanTokens(own) ?? (grew && Object.values(grew).every(value => value >= 0) ? grew : total);
  return { model: runModel(run) ?? run.asked ?? log?.model ?? null, reported: log?.model ?? null, tokens, ...(thread ? { thread } : {}), ...(total && tokens && !sameTokens(total, tokens) ? { sessionTokens: total } : {}) };
}
// One run's own spend, its log and the logs of the runs before it read through logOf(index).
// The runner keeps it with the run (ownCost); runSpends reads it for a run recorded before.
// reported: the model the vendor's result named for the run (the one that cost most), or null;
// model also falls back to what the run was asked for, for showing it. session: the vendor's
// own id of the session it reported; beyond: see ownClaudeSpend. record: for a Codex run, what
// Codex's own record of its thread says the run used (ownCodexSpend).
export function ownRunSpend(runs, index, logOf, { record = null } = {}) {
  const run = runs[index], vendor = typeof run.vendor === 'string' ? run.vendor : null, log = logOf(index);
  const recorded = { vendor, model: runModel(run) ?? run.asked ?? null, costUsd: money(run.costUsd), tokens: cleanTokens(run.tokens), started: true };
  if (vendor === 'codex' && (!log || log.started)) return { ...recorded, ...ownCodexSpend(runs, index, logOf, record?.tokens) };
  // No log to read (removed): the run as it was recorded.
  if (!log) return recorded;
  if (!log.started) return { ...recorded, model: recorded.model, costUsd: 0, tokens: null, started: false };
  if (vendor !== 'claude') return { ...recorded, model: recorded.model ?? log.model ?? null, reported: log.model ?? null, tokens: recorded.tokens ?? log.tokens ?? null, ...(log.models ? { models: log.models } : {}), ...(log.incomplete ? { incomplete: true } : {}) };
  const result = log.result;
  // A turn that ended before Claude Code wrote its result reported nothing.
  if (!result) return { ...recorded, model: recorded.model ?? log.model, costUsd: null, tokens: log.tokens ?? null };
  // The session's turn before this one: the last earlier run of this session that reported.
  const session = result.session ?? run.session ?? null;
  let base = null;
  for (let at = index - 1; at >= 0 && session && !base; at--) {
    const before = runs[at];
    if (!isObject(before) || before.vendor !== 'claude') continue;
    const earlier = logOf(at);
    if (earlier?.result && (earlier.result.session ?? before.session) === session) base = earlier.result;
  }
  const own = ownClaudeSpend(result, base, log.model);
  return { ...recorded, model: recorded.model ?? log.model ?? topModel(result.models), reported: topModel(result.models), costUsd: own.costUsd, tokens: own.tokens, session, beyond: own.beyond, ...(own.carried ? { sessionCostUsd: result.total } : {}) };
}
// A turn stopped while its vendor worked ended with no result, so it is no run of task.runs:
// the runner keeps it in task.stops, { role, vendor, logFile, session, at, asked?, model?,
// tokens?, started?, counted? }. stoppedSpend: what its log says it had used by then, for that
// record: the tokens its vendor had reported and its model. Its cost is not known, as a vendor
// says that when a turn ends. One stopped before its vendor wrote anything (started: false)
// spent nothing, and Usage leaves it out.
export function stoppedSpend(file, vendor) {
  let log = null; try { log = logSpend(file, vendor); } catch { log = null; }
  return { ...(log?.model ? { model: log.model } : {}), ...(log?.tokens ? { tokens: log.tokens } : {}), ...(log?.started ? {} : { started: false }) };
}
// The stopped turns whose spend a later run reported as part of its own: those of the vendor
// session it went on with (spent: that run's ownRunSpend), not counted yet, when the session's
// totals hold at least what they had reported over the run's own tokens. The runner marks them
// counted, and they add nothing more. When the totals hold exactly the run's own, Claude Code
// did not keep them: each stays a spend of its own, with no cost reported.
export function stopsCounted(stops, spent) {
  if (!spent?.session || !spent.beyond) return [];
  const mine = (Array.isArray(stops) ? stops : []).filter(stop => isObject(stop) && stop.session === spent.session && stop.counted !== true);
  const had = mine.reduce((sum, stop) => addTokens(sum, cleanTokens(stop.tokens)), null) ?? NONE;
  return Object.keys(NONE).every(key => spent.beyond[key] >= had[key]) ? mine : [];
}
const stopSpend = stop => ({ vendor: typeof stop.vendor === 'string' ? stop.vendor : null, model: runModel(stop) ?? stop.asked ?? null, costUsd: null, tokens: cleanTokens(stop.tokens), started: true });

// A run counts on the day it ran (a run from before runs had a time: the day its session started).
const runTime = (run, task) => Date.parse(run?.at ?? task?.createdAt ?? '');
const startOfDay = now => { const day = new Date(now); day.setHours(0, 0, 0, 0); return day.getTime(); };
// In a period: today, or the last seven days, by this computer's clock, or from dayStart, the
// start of today where the Usage tab is shown (a computer of mine in another time zone asks).
export const inPeriod = (at, now, days = 1, dayStart = null) => Number.isFinite(at) && (Number.isFinite(dayStart) ? at >= dayStart - (days - 1) * 86400000 && at <= now + 60000
  : days === 1 ? new Date(at).toDateString() === new Date(now).toDateString() : at >= startOfDay(now) - (days - 1) * 86400000 && at <= now + 60000);
// Who a run was, as the chat names it: a session's own agent by its model (Opus 5.5, or Opus
// 5.5 + Codex when it ran on both), a bot by @name. The lead of a chat with one bot is that bot.
export function agentName(role, task, models = []) {
  const bot = botOfKey(role);
  if (bot) return `@${bot}`;
  if (role === 'lead' && typeof task?.botChat === 'string' && task.botChat) return `@${task.botChat}`;
  if (role === 'lead' || !role) return models.map(row => modelName(row.model) ?? vendorShort(row.vendor ?? 'model')).filter((name, at, all) => all.indexOf(name) === at).join(' + ') || 'Model';
  return `@${role}`;
}
// A model as the row keeps it: a Claude model by its name (opus 5.5), another vendor's as it
// named it (gpt-6.1-sol, gemini-3-flash), or the vendor's name for its own default.
export function shortModel(model, vendor) {
  const id = typeof model === 'string' ? model.trim() : '', claude = claudeId(id);
  return (claude ? modelName(claude) : id || (vendor ? vendorShort(vendor) : '')).toLowerCase().slice(0, 40);
}
// A model a bot was saved with by its short name (opus) reads as the one its vendor ran for that
// name here (opus 5.5), when a run reported one. So does a run that never said its model (one
// that did not start, a turn that was stopped): only a name with its version stands for it,
// never another run's short name.
const family = id => (modelName(id) ?? '').split(' ')[0].toLowerCase();
const versioned = model => /\d/.test(model);
function fullModel(model, vendor, known) {
  if (!model || versioned(model)) return model;
  return known.findLast(row => row.vendor === vendor && versioned(row.model) && family(row.model) === family(model))?.model ?? model;
}
// The vendors whose runs can leave a cost unknown, which agentSpend names in unpriced and a
// computer of mine sends: claude, a Claude Code run that ended before it wrote its result;
// codex, agy and grok, a run with no tokens, or on a model with no known price.
export const UNPRICED = new Set(['codex', 'agy', 'grok', 'claude']);
const unpricedOf = vendor => UNPRICED.has(vendor) ? vendor : null;
// Every agent's spend on this computer in a period (days 1: today, 7: the last seven days),
// most cost first: { rows, costUsd, partial, runs, unpriced }. projects: [{ root, key?, tasks }];
// key is the project's id a computer of mine is told (lib/peer/remote.mjs). costUsd is the sum
// of every run's own known cost (null when none reported one), partial says some did not, and
// unpriced which vendors those were. A row: { root, project, taskId, role, agent, title, model,
// vendor, tokens, costUsd, partial, unpriced, started, at }; started is false when none of its
// runs started (they spent nothing). A turn that was stopped after its vendor began
// (task.stops) counts as a run with no cost reported, until a later run of its session
// reported its spend (counted).
export function agentSpend(projects, { now = Date.now(), days = 1, dayStart = null, read = logSpend } = {}) {
  const rows = new Map(), unpriced = new Set(); let costUsd = null, partial = false, runs = 0;
  const known = [];
  for (const project of projects ?? []) for (const task of project?.tasks ?? []) {
    const list = Array.isArray(task?.runs) ? task.runs : [], stops = (Array.isArray(task?.stops) ? task.stops : []).filter(stop => isObject(stop) && stop.counted !== true && stop.started !== false);
    const within = run => isObject(run) && inPeriod(runTime(run, task), now, days, dayStart);
    if (![...list, ...stops].some(within)) continue;
    const spends = [...runSpends(task, read, index => within(list[index])), ...stops.map(stop => within(stop) ? pricedSpend(stopSpend(stop), runTime(stop, task)) : null)];
    [...list, ...stops].forEach((run, index) => {
      const at = runTime(run, task), spend = spends[index];
      if (!spend || !inPeriod(at, now, days, dayStart)) return;
      runs++;
      if (spend.model) known.push({ vendor: spend.vendor, model: spend.model });
      const cost = spend.costUsd, why = cost === null ? unpricedOf(spend.vendor) : null;
      if (cost === null) { partial = true; if (why) unpriced.add(why); } else costUsd = (costUsd ?? 0) + cost;
      const role = typeof run.role === 'string' && run.role ? run.role : 'lead', key = `${project.root}\0${task.id}\0${role}`;
      const row = rows.get(key) ?? { root: project.root, project: project.key ?? null, taskId: String(task.id), task, role, models: [], tokens: null, costUsd: null, partial: false, unpriced: [], started: false, at: 0 };
      if (cost === null) { row.partial = true; if (why && !row.unpriced.includes(why)) row.unpriced.push(why); } else row.costUsd = (row.costUsd ?? 0) + cost;
      row.tokens = addTokens(row.tokens, spend.tokens);
      row.started ||= spend.started;
      // The models it ran on, in the order it first ran on each; a bot's run that never started names the model it was asked for.
      let model = spend.model;
      if (!model && !spend.started && botOfKey(role)) { try { model = getBot(botOfKey(role))?.model ?? null; } catch { model = null; } }
      if (spend.vendor && !row.models.some(item => item.vendor === spend.vendor && item.model === model)) row.models.push({ vendor: spend.vendor, model });
      if (at >= row.at) row.at = at;
      rows.set(key, row);
    });
  }
  const list = [...rows.values()].map(({ task, models, ...row }) => {
    const named = models.map(item => ({ ...item, model: fullModel(item.model, item.vendor, known) }));
    // A vendor's own default is left out when the same vendor also named a model.
    const shown = named.filter(item => item.model || !named.some(other => other.vendor === item.vendor && other.model));
    const model = shown.map(item => shortModel(item.model, item.vendor)).filter((name, at, all) => name && all.indexOf(name) === at).join(' + ');
    return { ...row, agent: agentName(row.role, task, shown), title: taskTitle(task), model, vendor: shown.at(-1)?.vendor ?? null, partial: row.partial && row.costUsd !== null, at: new Date(row.at).toISOString() };
  });
  return { rows: list.sort(byCost), costUsd, partial: partial && costUsd !== null, runs, unpriced: [...unpriced] };
}
const tokenSum = tokens => tokens ? tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite : -1;
// Most cost first; one with no cost after every one with a cost; then most tokens, then latest.
export const byCost = (a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || tokenSum(b.tokens) - tokenSum(a.tokens) || String(b.at).localeCompare(String(a.at));
// The rows the section shows: the ones that cost most, and every agent that did not start,
// however busy the day. A failure costs nothing, so it would be the first to drop off the list.
export function topRows(rows, limit = TOP_AGENTS) {
  const sorted = [...rows].sort(byCost), failed = sorted.filter(row => row.started === false).slice(0, limit);
  return [...sorted.filter(row => row.started !== false).slice(0, limit - failed.length), ...failed].sort(byCost);
}
// Dollars as the table shows them: $9.57, ≥$9.57 when some run's cost is not known (it is at
// least that), a dash when none is known. No run at all (runs 0) spent nothing: $0.00.
export const moneyText = (costUsd, partial = false, runs = null) => costUsd === null || costUsd === undefined ? runs === 0 ? '$0.00' : '—' : `${partial ? '≥' : ''}$${costUsd.toFixed(2)}`;

// What a computer of mine sends with its sessions list (elu.remote.list, optional field
// topAgents): its top agents today and in the last seven days, and what each period cost.
// dayStart: the start of today where it is shown, when the viewer said. own: each cost is a
// run's own (since 0.1.20). A build before that sends no such word: it added what a whole
// session had spent again for each of its turns, so its costs can be too high, and the viewer
// says so beside that computer's part of the total.
export function topAgentsWire(projects, now = Date.now(), dayStart = null) {
  const period = days => {
    const spend = agentSpend(projects, { now, days, dayStart });
    return { costUsd: spend.costUsd, partial: spend.partial, runs: spend.runs, unpriced: spend.unpriced, rows: topRows(spend.rows.filter(row => row.project)).map(row => ({ ref: `${row.project}:${row.taskId}`, agent: row.agent, title: row.title, model: row.model, tokens: row.tokens, costUsd: row.costUsd, partial: row.partial, unpriced: row.unpriced, started: row.started, at: row.at })) };
  };
  return { own: true, today: period(1), week: period(7) };
}
const REF = /^[0-9a-f]{16}:[1-9][0-9]{0,9}$/;
const text = (value, max) => sanitize(String(value ?? '').replace(/\s+/g, ' '), max).trim();
// An agent's name: @<bot>, or the models a session's own agent ran on (Opus 5.5 + Codex).
const AGENT = /^(?:@[A-Za-z0-9_-]{1,30}|[A-Za-z0-9][A-Za-z0-9 .+_:/-]{0,47})$/;
const cleanUnpriced = value => (Array.isArray(value) ? value : []).filter(item => UNPRICED.has(item)).filter((item, at, all) => all.indexOf(item) === at);
// What a computer of mine sent, every field checked: it is my computer, but titles come from
// models and teammates. id(ref): the id this computer knows that session by. null when it sent
// none (a build from before it did). A build from before 0.1.20 names every session's agent @lead.
// own: it said each cost is a run's own; false for a build that counts the old way.
export function cleanTopAgents(value, id = () => null) {
  if (!isObject(value)) return null;
  const period = item => {
    if (!isObject(item)) return { costUsd: null, partial: false, runs: null, unpriced: [], rows: [] };
    const rows = (Array.isArray(item.rows) ? item.rows : []).slice(0, TOP_AGENTS).filter(row => isObject(row) && REF.test(row.ref ?? '')).map(row => {
      const agent = text(row.agent, 48);
      return { ref: row.ref, id: id(row.ref), agent: AGENT.test(agent) ? agent : 'Model', title: text(row.title, 80), model: text(row.model, 48).toLowerCase(), tokens: cleanTokens(row.tokens), costUsd: money(row.costUsd), partial: row.partial === true && money(row.costUsd) !== null, unpriced: cleanUnpriced(row.unpriced), started: row.started !== false, at: Number.isFinite(Date.parse(row.at ?? '')) ? new Date(Date.parse(row.at)).toISOString() : new Date(0).toISOString() };
    });
    return { costUsd: money(item.costUsd), partial: item.partial === true && money(item.costUsd) !== null, runs: count(item.runs), unpriced: cleanUnpriced(item.unpriced), rows };
  };
  return { own: value.own === true, today: period(value.today), week: period(value.week) };
}

// Tokens compact: 950, 1.2k, 34k, 1.2M, 12M, 1.1B.
export function compact(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return String(Math.round(value));
  for (const [size, unit] of [[1e3, 'k'], [1e6, 'M'], [1e9, 'B']]) {
    const scaled = value / size, shown = scaled < 9.95 ? scaled.toFixed(1).replace(/\.0$/, '') : String(Math.round(scaled));
    if (Number(shown) < 1000 || unit === 'B') return `${shown}${unit}`;
  }
  return String(value);
}
// A row's cost: $9.57, ≥$9.57 when some of its runs' cost is not known, a dash when none is.
export const costText = row => moneyText(row.costUsd, row.partial);
export function shareText(row, total) {
  if (row.costUsd === null || row.costUsd === undefined || !(total > 0)) return '—';
  const share = row.costUsd / total * 100;
  return share > 0 && share < 1 ? '<1%' : `${Math.round(share)}%`;
}
// A model as the table shows it, by its display name: Opus 5.5 (from claude-opus-5-5 or opus
// 5.5), GPT-6.1 Sol (gpt-6.1-sol), Grok 4.6, Gemini 3.1 Pro High; a vendor's own default by the
// vendor (Codex). Two models: both, joined by +.
const WORDS = { gpt: 'GPT', oss: 'OSS' };
const word = part => WORDS[part.toLowerCase()] ?? (/^[a-z]+$/i.test(part) ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part);
export function modelLabel(text) {
  return String(text ?? '').split(' + ').map(one => {
    const name = one.trim(), claude = claudeId(name);
    if (!name) return '';
    if (claude) return modelName(claude);
    if (/\s/.test(name)) return name.split(/\s+/).map(word).join(' ');
    const id = name.slice(name.lastIndexOf('/') + 1);
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return name;
    const [first, ...rest] = id.split(/[-_]/);
    return first.toLowerCase() === 'gpt' && /^\d/.test(rest[0] ?? '') ? [`GPT-${rest[0]}`, ...rest.slice(1).map(word)].join(' ') : [first, ...rest].map(word).join(' ');
  }).filter(Boolean).join(' + ');
}
// A text cut to width columns with … at its end, no space before it.
const ellipsis = (text, width) => columns(text) <= width ? text : width < 1 ? '' : `${head(text, width - 1).trimEnd()}…`;
// The section's table, as plain lines no wider than width: { head, rule, rows, foot }.
// rows: [{ agent, title, where, model, tokens, costUsd, partial, started }], where being 'here'
// or the computer it ran on. Its columns: Session, a bot's name first (@reviewer Fix the
// build); Computer, only when a row ran on another computer; Model; In, Out and Cache (tokens
// read from the cache); Cost; Share of total. Every number is right-aligned under its header.
// When the session would have fewer than SESSION columns (or than it needs), Cache, In, Out and
// Computer go, in that order, and the session then takes the room left, cut with ….
// foot: { label, costUsd, partial, runs, parts: [{ name, costUsd, partial, runs, note?, old? }] }:
// the total of the period, ending where Cost ends, and under it each computer's part, when
// there is more than one. A line never wraps.
const SESSION = 40, GAP = 2, DROPS = ['cache', 'in', 'out', 'computer'];
const partText = part => `${part.name} ${part.note ?? moneyText(part.costUsd, part.partial, part.runs)}${part.old ? ' (older ELU)' : ''}`;
export function agentTable(rows, { width = 80, total = 0, foot = null } = {}) {
  const cells = rows.map(row => {
    const tokens = row.tokens, bot = /^@/.test(row.agent ?? '') ? `${row.agent} ` : '';
    return { session: `${bot}${row.title || '-'}`, after: row.started === false ? ' (did not start)' : '', computer: row.where || 'here', model: modelLabel(row.model) || '—',
      in: tokens ? compact(tokens.input) : '—', out: tokens ? compact(tokens.output) : '—', cache: tokens ? compact(tokens.cacheRead) : '—', cost: costText(row), share: shareText(row, total) };
  });
  const widest = (key, header) => Math.max(columns(header), ...cells.map(cell => columns(cell[key])));
  const column = (key, header, right, cap = Infinity) => ({ key, header, right, width: Math.min(cap, widest(key, header)) });
  const needs = Math.max(columns('Session'), ...cells.map(cell => columns(cell.session + cell.after)));
  let shown = [
    ...(cells.some(cell => cell.computer !== 'here') ? [column('computer', 'Computer', false, 16)] : []),
    column('model', 'Model', false, 22), column('in', 'In', true), column('out', 'Out', true), column('cache', 'Cache', true), column('cost', 'Cost', true), column('share', 'Share', true),
  ];
  // The room the session has: the width less every other column and the gap before it.
  const room = () => width - shown.reduce((sum, item) => sum + GAP + item.width, 0);
  for (const key of DROPS) { if (room() >= Math.min(SESSION, needs)) break; shown = shown.filter(item => item.key !== key); }
  // A pane narrower still cuts the model's name, then drops the share, then the model.
  const model = shown.find(item => item.key === 'model'), least = 4;
  if (model && room() < least) model.width = Math.max(least, model.width - (least - room()));
  for (const key of ['share', 'model']) if (room() < least) shown = shown.filter(item => item.key !== key);
  const session = { key: 'session', header: 'Session', width: Math.max(1, Math.min(needs, room())) }, all = [session, ...shown];
  const sessionText = cell => {
    const whole = cell.session + cell.after;
    if (columns(whole) <= session.width) return whole;
    return cell.after && session.width - columns(cell.after) >= 8 ? ellipsis(cell.session, session.width - columns(cell.after)) + cell.after : ellipsis(whole, session.width);
  };
  const line = text => head(all.map(item => { const value = ellipsis(text(item), item.width); return item.right ? padStart(value, item.width) : padEnd(value, item.width); }).join(' '.repeat(GAP)).trimEnd(), width);
  const tableWidth = Math.min(width, all.reduce((sum, item) => sum + item.width, 0) + GAP * (all.length - 1));
  // Where the cost column ends: the total's right end.
  const cost = all.findIndex(item => item.key === 'cost'), costEnd = cost < 0 ? tableWidth : all.slice(0, cost + 1).reduce((sum, item) => sum + item.width, 0) + GAP * cost;
  const under = text => columns(text) >= costEnd ? ellipsis(text, width) : `${' '.repeat(costEnd - columns(text))}${text}`;
  const parts = foot?.parts ?? [];
  return {
    head: line(item => item.header),
    rule: '─'.repeat(tableWidth),
    rows: cells.map(cell => line(item => item.key === 'session' ? sessionText(cell) : cell[item.key])),
    foot: foot ? [under(`${foot.label}  ${moneyText(foot.costUsd, foot.partial, foot.runs)}`), ...(parts.length > 1 ? [under(parts.map(partText).join(' · '))] : [])] : [],
  };
}
