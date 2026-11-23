import fs from 'node:fs';
import { isObject, linesOf } from './util.mjs';
import { taskTitle } from './state.mjs';
import { claudeId, modelName, vendorShort } from './models.mjs';
import { botOfKey, getBot } from './bots.mjs';
import { sanitize } from './peer/peerdata.mjs';
import { columns, head, padEnd, padStart } from './width.mjs';
import { listCost, longPriceOf, priceOf } from './prices.mjs';
import { LINES as AUTO_LINES } from './auto-model.mjs';
import { QUICK_ROLE } from './message-aside.mjs';

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
// Antigravity CLI's headless result (-p --output-format json) ends with the run's turns
// (num_turns) and usage: input_tokens, output_tokens, thinking_tokens, cache_read_tokens and
// total_tokens. Its headless docs (antigravity.google/docs/cli/headless.md) print the cache read
// apart from the input (a turn of 278 input that read 30,214 from the cache) and leave it out of
// the total, which is the input and the output there. The total says whether the thinking is
// counted apart from the output, and it is output too then. Where the total leaves it out, as in
// the docs, it may be inside the output or apart, so the run is at least what its output costs
// (incomplete). A total that fits no reading, or none, says nothing for sure: null. All 0 is
// nothing spent only for a run that made no turn (one that could not sign in); with turns, it
// reported nothing. { tokens, incomplete? }, or null.
const agyResult = row => isObject(row) && isObject(row.usage) && ['num_turns', 'finished_reason', 'conversation_id', 'conversationId', 'structured_output'].some(key => Object.hasOwn(row, key));
function agyTokens(row) {
  const use = row.usage, input = count(use.input_tokens), output = count(use.output_tokens), thinking = count(use.thinking_tokens) ?? 0, read = count(use.cache_read_tokens) ?? 0, total = count(use.total_tokens);
  if (input === null || output === null) return null;
  if (input + output + thinking + read === 0) return row.num_turns === 0 ? { tokens: cleanTokens({ input: 0, output: 0 }) } : null;
  if (total === null) return null;
  // Each reading: its total, and whether it counts the thinking apart from the output.
  const fits = [[input + output + thinking + read, true], [input + output + thinking, true], [input + output + read, false], [input + output, false]].filter(([sum]) => sum === total);
  if (!fits.length) return null;
  const apart = thinking > 0 && fits.every(([, counted]) => counted);
  return { tokens: cleanTokens({ input, output: apart ? output + thinking : output, cacheRead: read, cacheWrite: 0 }), ...(thinking > 0 && !apart ? { incomplete: true } : {}) };
}
// What one run's log says it used, as its vendor reported it: { tokens, model, models? }, each
// null when not reported; models, { id: tokens }, only for a Grok Build result that names more
// than one, whose tokens are then priced each at its own model's price.
// Claude Code: the last result event, every model it called. Codex: its last turn.completed
// event, which holds what the run's thread has used so far (ownRunSpend takes out what it had
// used before the run), the thread its thread.started line names, and the model and the
// thread's file a turn run through lib/codex-live.mjs names there (codexTokens: how its counts
// read). Grok Build: its one JSON result, or its end event, which cover every turn that run
// made and none of an earlier run of its session (the headless guide in Grok Build's own
// repository, crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md: usage sums
// the tokens for the prompt, subagents included), so a resumed session's run reports its own.
// A run over ACP (Antigravity, Grok Build): every turn's answer, each the turn's own.
// incomplete: Grok's count leaves some of the run's model calls out, so its cost is at least
// what its tokens cost (pricedSpend): Grok said so (usage_is_incomplete, or usageIsIncomplete
// over ACP: subagents may be under-counted), or the run shows a call its usage leaves out:
// a compaction (an auto_compact_* event), which the guide says usage leaves out with the other
// side-model calls, or another of them: a memory flush (an LLM-written summary on its own
// flush_model, 13-memory.md), a memory capture (its generated content) or a Dream that ran (its
// model calls per batch, 26-config-reference.md), or a session summary or recap Grok generated
// (on its models.session_summary model, the same page). A Dream only queued, or a session saved,
// is none (SIDE_CALL: Grok Build's session updates, in the stream or over ACP, as its program names them).
// cost_is_partial says only that some calls had no cost: Grok then leaves every cost out,
// and the tokens are whole, so they are priced as any others. Headless Antigravity: its
// result's usage (agyTokens, incomplete where its thinking may be left out), printed on one
// line or several, with the conversation it ran in (thread) and how many turns that
// conversation has had (turns, its num_turns), by which its counters are read (ownAgySpend).
// The log is gone through a row at a time and only the rows that count are kept, so a log of
// any size is read.
const SIDE_CALL = /^(?:auto_compact_|memory_flush_|memory_capture|memory_dream_(?!queued)|session_summary_generated$|session_recap$)/;
export function runUsage(vendor, text) {
  const none = { tokens: null, model: null };
  try {
    let turns = null, acp = false, last = null, incomplete = false, side = false;
    // Grok Build: the json object, or a streaming-json run's end event, which carries the same spend.
    const wanted = vendor === 'claude' ? item => item.type === 'result' : vendor === 'grok' ? item => (typeof item.text === 'string' && typeof item.stopReason === 'string') || item.type === 'end' : () => false;
    for (const row of rowsOf(text)) {
      if (row.jsonrpc === '2.0' && isObject(row.result) && typeof row.result.stopReason === 'string') { acp = true; turns = addTokens(turns, acpTokens(row.result)); incomplete ||= row.result._meta?.usage?.usageIsIncomplete === true; }
      if (wanted(row)) last = row;
      side ||= vendor === 'grok' && SIDE_CALL.test(typeof row.type === 'string' ? row.type : typeof row.params?.update?.sessionUpdate === 'string' ? row.params.update.sessionUpdate : '');
    }
    incomplete ||= side;
    if (acp) return { tokens: turns, model: null, ...(incomplete && turns ? { incomplete: true } : {}) };
    if (vendor === 'claude' || vendor === 'grok') {
      if (!last) return none;
      const { usage, models } = claudeResult(last);
      const tokens = models ? sumModels(models) : usage, partly = vendor === 'grok' && tokens && (last.usage_is_incomplete === true || side);
      return { tokens, model: topModel(models), ...(vendor === 'grok' && models && Object.keys(models).length > 1 ? { models: Object.fromEntries(Object.entries(models).map(([id, row]) => [id, row.tokens])) } : {}), ...(partly ? { incomplete: true } : {}) };
    }
    if (vendor === 'agy') {
      let found = null;
      // A stream-json run (agy 1.5.13) prints it inside its last line, {"event":"result","result":{...}}.
      for (const row of rowsOf(text)) { const item = row?.event === 'result' && isObject(row.result) ? row.result : row; if (agyResult(item)) found = item; }
      if (!found && typeof text === 'string' && text.length <= 1 << 20) { try { const row = JSON.parse(text); if (agyResult(row)) found = row; } catch { /* Not one JSON value. */ } }
      if (!found) return none;
      const conversation = [found.conversation_id, found.conversationId].find(id => typeof id === 'string' && id && id.length <= 100) ?? null, turns = count(found.num_turns), used = agyTokens(found);
      return { tokens: used?.tokens ?? null, model: null, ...(conversation ? { thread: conversation } : {}), ...(turns !== null ? { turns } : {}), ...(used?.incomplete ? { incomplete: true } : {}) };
    }
    if (vendor === 'codex') {
      let tokens = null, model = null, thread = null, file = null, seen = null;
      for (const row of rowsOf(text)) {
        if (row.type === 'thread.started') {
          if (typeof row.model === 'string' && row.model && row.model.length <= 100) model = row.model;
          if (typeof row.thread_id === 'string' && row.thread_id && row.thread_id.length <= 100) thread = row.thread_id;
          if (typeof row.path === 'string' && row.path.length <= 4096) file = row.path;
        }
        if (row.type === 'turn.completed') tokens = codexTokens(row.usage) ?? tokens;
        if (row.type === 'thread.token_usage') seen = codexTokens(row.total) ?? seen;
      }
      return { tokens, model, ...(thread ? { thread } : {}), ...(file ? { file } : {}), ...(seen ? { threadTotal: seen } : {}) };
    }
  } catch { /* A log that cannot be read reports nothing. */ }
  return none;
}

// A run's log, read for its spend once per change of the file: { started, ...what its vendor
// reported }. started: the vendor wrote anything at all (Claude Code writes its first line
// before it asks the model anything). A Claude Code log is read at its start (the model it
// began with) and its end (the result), so a long one costs little; any other is read whole,
// or its last 16MB when it is longer, and then a Codex log's start too, for the thread its
// first line names (thread.started).
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
        let used = runUsage(vendor, text);
        if (vendor === 'codex' && size > WHOLE && !used.thread) {
          const start = readPart(fd, 0, Math.min(HEAD, size - WHOLE)), first = runUsage(vendor, start.slice(0, start.lastIndexOf('\n') + 1));
          used = { ...used, model: used.model ?? first.model, ...(first.thread ? { thread: first.thread } : {}), ...(!used.file && first.file ? { file: first.file } : {}) };
        }
        value = { started: size > 0, ...used };
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
// price there leaves the cost unknown. longTokens: the part of the tokens its requests over the
// model's long-context size used, priced at that rate; there (even all 0), its vendor said how
// big each request's prompt was (ownCodexSpend). Claude Code reports its own cost, so a Claude
// Code run with none (one stopped before its result) stays unknown.
// atLeast: the cost may be too low, so it is shown as at least that (≥). Its count leaves some
// of its model calls out (incomplete: its vendor said so, or it shows one its count leaves out),
// or its vendor did not say how big each request was and its prompts add up to a model's
// long-context size, so one of them may have been over it and billed at the long rate. Prompts
// that add up to less cannot have been.
const promptOf = used => used.input + used.cacheRead + used.cacheWrite;
export function pricedSpend(spend, at = Date.now()) {
  if (!spend) return spend;
  const own = used => used && spend.vendor === 'codex' ? { ...used, input: Math.max(0, used.input - used.cacheWrite) } : used;
  const tokens = own(spend.tokens), long = tokens ? own(cleanTokens(spend.longTokens)) : null;
  const listed = spend.costUsd === null && spend.started !== false && spend.vendor !== 'claude' ? listCost(spend.model, tokens, { models: spend.models ?? null, at, long }) : null;
  const models = spend.models && Object.keys(spend.models).length ? Object.entries(spend.models) : [[spend.model, tokens]];
  const unsized = listed !== null && !long && models.some(([id, used]) => { const from = longPriceOf(id, at)?.from, counted = cleanTokens(used); return Boolean(from && counted) && promptOf(counted) >= from; });
  const atLeast = (listed ?? spend.costUsd ?? null) !== null && (spend.incomplete === true || unsized);
  return { ...spend, tokens, ...(long ? { longTokens: long } : {}), ...(listed !== null ? { costUsd: listed } : {}), ...(atLeast ? { atLeast: true } : {}) };
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
    if (run.ownCost === true) return pricedSpend({ vendor, model: runModel(run) ?? run.asked ?? null, costUsd: money(run.costUsd), tokens: cleanTokens(run.tokens), longTokens: cleanTokens(run.longTokens), started: run.started !== false, ...(run.incomplete === true || reviewed(run) ? { incomplete: true } : {}) }, at);
    return pricedSpend(ownRunSpend(runs, index, logOf), at);
  });
}
// What each run of a session cost by itself, in the order of task.runs: dollars, or null where
// none is known. Whatever adds a session's runs up reads this one (its budget, its stop line,
// its row, its reply to a teammate), so a run from before runs kept their own cost, whose
// record holds what its whole Claude Code session had spent, counts once there too.
export const runCosts = (task, read = logSpend) => runSpends(task, read).map(spend => spend ? spend.costUsd : null);
// What a run is charged against what was held for it (reserved), as a teammate's spend here
// counts it: its own cost, all of what was held where its cost is not known, and at least that
// where its cost may be more (atLeast).
export const chargedCost = (spend, reserved) => !Number.isFinite(spend?.costUsd) ? reserved : spend.atLeast ? Math.max(spend.costUsd, reserved) : spend.costUsd;
// What a Codex run used itself: { model, reported, tokens, thread, sessionTokens? }. Codex
// reports what its thread has used so far, begun from the thread's own record when a run
// resumes it (runUsage), and a session's next message resumes its thread. A run that went on
// with the thread of an earlier run used the thread's total less the last total reported
// before it (base): what a run's log reported, else what its record kept (sessionTokens, or
// tokens of a run recorded before 0.1.26, which kept the total there). Only a total is taken
// out that way. A run that reported none (it failed, or was stopped) and kept its own share
// from Codex's record (ownCost) is taken out too, as that share is in the thread's total; the
// run is then at least what is left (incomplete), since that share may not have been, and a
// share that does not fit leaves the run's own unknown. Without such a share, a total smaller
// in any count than the base was begun again, and is the run's own. record: what Codex's own
// record of the run's turns says (lib/codex-rollout.mjs): what they used, taken where there is
// one, and the model they ran on, which a run on Codex's own default names nowhere else, and
// each request's prompt, by which the part of them over the model's long-context size
// (longTokens, all 0 when none was) is priced at that rate; only when it names every request's.
// sessionTokens: the thread's total whenever it is known, which the next run on the thread
// counts from. resumed: the thread the run was launched to go on with, for a log that names
// none; the runner gives it, as the run's record names ELU's own launch id until the run's
// answer is read. A run in Approve for me (permissions auto) may have had Codex's reviewer
// judge its actions, in a session of its own whose tokens neither the run's count nor its
// record holds, and no line says whether it ran: it is at least what it shows.
const reviewed = run => run?.vendor === 'codex' && run.permissions === 'auto';
function ownCodexSpend(runs, index, logOf, record, resumed = null) {
  const run = runs[index], log = logOf(index), thread = log?.thread ?? (typeof resumed === 'string' && resumed ? resumed : null) ?? (typeof run.session === 'string' && run.session ? run.session : null);
  const total = log?.tokens ?? cleanTokens(run.tokens);
  let base = null, kept = null;
  for (let at = index - 1; at >= 0 && thread && total && !base; at--) {
    const before = runs[at];
    if (!isObject(before) || before.vendor !== 'codex') continue;
    const earlier = logOf(at);
    if ((earlier?.thread ?? before.session) !== thread) continue;
    base = earlier?.tokens ?? cleanTokens(before.sessionTokens) ?? (before.ownCost === true ? null : cleanTokens(before.tokens));
    if (!base && before.ownCost === true) kept = addTokens(kept, cleanTokens(before.tokens));
  }
  const from = kept ? addTokens(base ?? NONE, kept) : base, grew = from ? lessTokens(total, from) : null, fits = Boolean(grew) && Object.values(grew).every(value => value >= 0);
  // A run that reported nothing (it failed before an answer), whose window in Codex's record holds
  // no request, used nothing Codex recorded: it is at least nothing, as a request cut off before
  // its answer is in no record.
  const none = !total && Array.isArray(record?.requests) && !record.requests.length && !cleanTokens(record.tokens);
  const own = none ? { ...NONE } : cleanTokens(record?.tokens), tokens = own ?? (!from ? total : fits ? grew : kept ? null : total), atLeast = none || !own && Boolean(kept) && fits;
  const named = log?.model ?? (typeof record?.model === 'string' && record.model ? record.model : null), model = runModel(run) ?? run.asked ?? named;
  const sized = own && Array.isArray(record.requests) && record.requests.length > 0 && record.requests.every(request => isObject(request) && Number.isSafeInteger(request.prompt));
  const band = sized ? longPriceOf(model, Date.parse(run.at))?.from : null;
  const long = band ? record.requests.filter(request => request.prompt >= band).reduce((sum, request) => addTokens(sum, cleanTokens(request.tokens)), { ...NONE }) : null;
  return { model, reported: named, tokens, ...(long ? { longTokens: long } : {}), ...(thread ? { thread } : {}), ...(total ? { sessionTokens: total } : {}), ...(atLeast || reviewed(run) ? { incomplete: true } : {}) };
}
// What a Codex thread had used when this session last ran on it: the thread's total that its
// last run or stopped turn there reported, from its log (turn.completed, else the last total the
// app-server sent, lib/codex-live.mjs) or its record (sessionTokens, or tokens of a run recorded
// before 0.1.26). null when that one says nothing, as an earlier total would leave its requests
// out. The live meter reads it (lib/budget.mjs liveSpend).
export function codexThreadTotal(task, thread, read = logSpend) {
  if (typeof thread !== 'string' || !thread) return null;
  let latest = null, when = -Infinity;
  for (const run of [...(Array.isArray(task?.runs) ? task.runs : []), ...(Array.isArray(task?.stops) ? task.stops : [])]) {
    if (!isObject(run) || run.vendor !== 'codex' || run.started === false) continue;
    let log = null; try { log = read(run.logFile, 'codex'); } catch { log = null; }
    const at = Date.parse(run.at ?? '');
    if ((log?.thread ?? run.session) !== thread || (Number.isFinite(at) && at < when)) continue;
    if (Number.isFinite(at)) when = at;
    latest = log?.tokens ?? log?.threadTotal ?? cleanTokens(run.sessionTokens) ?? (run.ownCost === true ? null : cleanTokens(run.tokens));
  }
  return latest;
}
// What a headless Antigravity run used itself: { tokens, thread, sessionTokens?, turns? }.
// Antigravity's headless docs (antigravity.google/docs/cli/headless.md): num_turns is the number
// of user turns in the conversation, and in a session that takes more than one prompt the
// counters (turns, duration, usage) track the whole session. They do not say so of a run that
// resumes a conversation (--conversation), which a session's next message does; such a run
// whose num_turns goes on from the run before it is taken to report what the conversation has
// used so far (sessionTokens), as that session does, and its own share is that less what the
// conversation's turn before it had reported: the last earlier run on the conversation, from its
// log or its record (sessionTokens, conversationTurns). The first turn's count is its own. Where
// that turn before is not known (it ran over ACP, which reports each turn's own, or outside this
// session, or its count is gone), or a count went down, the run's own is unknown, never the
// conversation's count again.
const headless = log => Boolean(log) && (typeof log.thread === 'string' || Number.isSafeInteger(log.turns));
function ownAgySpend(runs, index, logOf) {
  const run = runs[index], log = logOf(index), thread = log?.thread ?? (typeof run.session === 'string' && run.session ? run.session : null), turns = log?.turns ?? null, total = log?.tokens ?? null;
  let before = null;
  for (let at = index - 1; at >= 0 && thread && !before; at--) {
    const earlier = runs[at], seen = logOf(at);
    if (!isObject(earlier) || earlier.vendor !== 'agy' || earlier.started === false || (seen && !seen.started) || (seen?.thread ?? earlier.session) !== thread) continue;
    before = headless(seen) ? { tokens: seen.tokens, turns: seen.turns ?? null } : isObject(earlier.sessionTokens) ? { tokens: cleanTokens(earlier.sessionTokens), turns: count(earlier.conversationTurns) } : { tokens: null, turns: null };
  }
  const grew = total && before?.tokens && (turns === null || before.turns === null || before.turns === turns - 1) ? lessTokens(total, before.tokens) : null;
  const tokens = !total ? null : turns !== null && turns <= 1 ? total : !before ? (turns === null ? total : null) : grew && Object.values(grew).every(value => value >= 0) ? grew : null;
  return { tokens, ...(thread ? { thread } : {}), ...(total ? { sessionTokens: total } : {}), ...(turns !== null ? { turns } : {}) };
}
// One run's own spend, its log and the logs of the runs before it read through logOf(index).
// The runner keeps it with the run (ownCost); runSpends reads it for a run recorded before.
// reported: the model the vendor's result named for the run (the one that cost most), or null;
// model also falls back to what the run was asked for, for showing it. session: the vendor's
// own id of the session it reported; beyond: see ownClaudeSpend. record: for a Codex run, what
// Codex's own record of its thread says the run used, and thread, the one it resumed
// (ownCodexSpend). incomplete: its vendor said its count may miss some of its calls, in its
// log or in its record (the runner keeps it).
export function ownRunSpend(runs, index, logOf, { record = null, thread = null } = {}) {
  const run = runs[index], vendor = typeof run.vendor === 'string' ? run.vendor : null, log = logOf(index);
  const recorded = { vendor, model: runModel(run) ?? run.asked ?? null, costUsd: money(run.costUsd), tokens: cleanTokens(run.tokens), started: true, ...(run.incomplete === true ? { incomplete: true } : {}) };
  if (vendor === 'codex' && (!log || log.started)) return { ...recorded, ...ownCodexSpend(runs, index, logOf, record, thread) };
  // No log to read (removed): the run as it was recorded.
  if (!log) return recorded;
  if (!log.started) return { ...recorded, model: recorded.model, costUsd: 0, tokens: null, started: false };
  // A headless Antigravity run recorded since runs keep the conversation's count apart
  // (sessionTokens) keeps its own share in tokens; an older one kept the conversation's there.
  if (vendor === 'agy' && headless(log)) {
    const own = ownAgySpend(runs, index, logOf), kept = isObject(run.sessionTokens) || Number.isSafeInteger(run.conversationTurns);
    return { ...recorded, ...own, model: recorded.model ?? log.model ?? null, reported: log.model ?? null, tokens: kept ? recorded.tokens : own.tokens, ...(log.incomplete ? { incomplete: true } : {}) };
  }
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
// Auto model's quick answers (role quick, lib/runner.mjs runAutoAnswer) are a row of their own.
export function agentName(role, task, models = []) {
  if (role === QUICK_ROLE) return AUTO_LINES.usageRow;
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
// What a run of task.runs cost as far as is known: its own cost (spend, runSpends), else what it
// had spent when ELU stopped it at a limit (stoppedAtUsd), the least it cost, as /budget counts it
// (lib/budget.mjs roleSpend); null when neither is known.
export const leastCost = (spend, run) => Number.isFinite(spend?.costUsd) ? spend.costUsd : isObject(run) && Number.isFinite(run.stoppedAtUsd) && run.stoppedAtUsd >= 0 ? run.stoppedAtUsd : null;
// Every agent's spend on this computer in a period (days 1: today, 7: the last seven days),
// most cost first: { rows, costUsd, partial, runs, unpriced }. projects: [{ root, key?, tasks }];
// key is the project's id a computer of mine is told (lib/peer/remote.mjs). costUsd is the sum
// of every run's own known cost (null when none reported one), partial says some did not, or
// some may be more (atLeast, pricedSpend), and unpriced which vendors had no cost. A row:
// { root, project, taskId, role, agent, title, model, vendor, tokens, costUsd, partial,
// unpriced, started, at }; started is false when none of its runs started (they spent
// nothing). A turn that was stopped after its vendor began (task.stops) counts as a run with
// no cost reported, until a later run of its session reported its spend (counted).
export function agentSpend(projects, { now = Date.now(), days = 1, dayStart = null, read = logSpend } = {}) {
  const rows = new Map(), unpriced = new Set(); let costUsd = null, partial = false, runs = 0;
  const known = [];
  // A session deleted for good counts as it did before (removed, lib/session-delete.mjs).
  for (const project of projects ?? []) for (const task of [...(project?.tasks ?? []), ...(Array.isArray(project?.removed) ? project.removed : [])]) {
    const list = Array.isArray(task?.runs) ? task.runs : [], stops = (Array.isArray(task?.stops) ? task.stops : []).filter(stop => isObject(stop) && stop.counted !== true && stop.started !== false);
    const within = run => isObject(run) && inPeriod(runTime(run, task), now, days, dayStart);
    if (![...list, ...stops].some(within)) continue;
    const spends = [...runSpends(task, read, index => within(list[index])), ...stops.map(stop => within(stop) ? pricedSpend(stopSpend(stop), runTime(stop, task)) : null)];
    [...list, ...stops].forEach((run, index) => {
      const at = runTime(run, task), spend = spends[index];
      if (!spend || !inPeriod(at, now, days, dayStart)) return;
      runs++;
      if (spend.model) known.push({ vendor: spend.vendor, model: spend.model });
      // A run ELU stopped at a limit with no cost reported counts what it had spent then, at least.
      const own = spend.costUsd, cost = leastCost(spend, index < list.length ? run : null), why = own === null ? unpricedOf(spend.vendor) : null;
      if (own === null) { partial = true; if (why) unpriced.add(why); }
      if (cost !== null) costUsd = (costUsd ?? 0) + cost;
      // A cost that may be too low makes the total at least that too.
      if (spend.atLeast) partial = true;
      const role = typeof run.role === 'string' && run.role ? run.role : 'lead', key = `${project.root}\0${task.id}\0${role}`;
      const row = rows.get(key) ?? { root: project.root, project: project.key ?? null, taskId: String(task.id), task, role, models: [], tokens: null, costUsd: null, partial: false, unpriced: [], started: false, at: 0, ...(task.removed === true ? { removed: true } : {}) };
      if (own === null) { row.partial = true; if (why && !row.unpriced.includes(why)) row.unpriced.push(why); }
      if (cost !== null) row.costUsd = (row.costUsd ?? 0) + cost;
      if (spend.atLeast) row.partial = true;
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
// The models of rows whose cost is not all known that have no price here (lib/prices.mjs), so
// Top agents can say why a cost is a dash or at least: a row here names its models, one from
// another computer its model. Claude Code reports its own cost, so its models are left out.
export function unpricedModels(rows) {
  const out = new Set();
  for (const row of rows) {
    if (!row.partial && row.costUsd !== null && row.costUsd !== undefined) continue;
    const models = Array.isArray(row.models) ? row.models.filter(item => item.vendor !== 'claude').map(item => item.model) : [row.model];
    for (const model of models) if (typeof model === 'string' && model && !/^claude-/i.test(model) && !priceOf(model)) out.add(model.toLowerCase());
  }
  return [...out].sort();
}
// Dollars as the table shows them: $9.57, ≥$9.57 when some run's cost is not known (it is at
// least that), a dash when none is known. No run at all (runs 0) spent nothing: $0.00. A cost
// above zero that rounds to no cent is <$0.01. One that may be more and rounds to no cent says
// nothing it could not say of any cost (≥$0.00): it is a dash too, as a cost that is not known.
export const moneyText = (costUsd, partial = false, runs = null) => costUsd === null || costUsd === undefined ? runs === 0 ? '$0.00' : '—'
  : costUsd.toFixed(2) === '0.00' ? partial ? '—' : costUsd > 0 ? '<$0.01' : '$0.00' : `${partial ? '≥' : ''}$${costUsd.toFixed(2)}`;
// The title of the quick answers' row of a session: Quick answers · Fix the build. One that
// came over the wire has it already, and is not given it twice.
function quickTitle(title) {
  const label = `${AUTO_LINES.usageRow} · `, text = String(title ?? '');
  return text.startsWith(label) ? text : `${label}${text || '-'}`;
}

// What a computer of mine sends with its sessions list (elu.remote.list, optional field
// topAgents): its top agents today and in the last seven days, and what each period cost.
// dayStart: the start of today where it is shown, when the viewer said. own: each cost is a
// run's own (since 0.1.20). A build before that sends no such word: it added what a whole
// session had spent again for each of its turns, so its costs can be too high, and the viewer
// says so beside that computer's part of the total. The quick answers' row goes with its
// label in its title (quickTitle): a build before Auto model shows a row whose name is not an
// @name by its title alone, so it says Quick answers there too.
export function topAgentsWire(projects, now = Date.now(), dayStart = null) {
  const period = days => {
    const spend = agentSpend(projects, { now, days, dayStart });
    return { costUsd: spend.costUsd, partial: spend.partial, runs: spend.runs, unpriced: spend.unpriced, rows: topRows(spend.rows.filter(row => row.project)).map(row => ({ ref: `${row.project}:${row.taskId}`, agent: row.agent, title: row.agent === AUTO_LINES.usageRow ? quickTitle(row.title) : row.title, model: row.model, tokens: row.tokens, costUsd: row.costUsd, partial: row.partial, unpriced: row.unpriced, started: row.started, at: row.at })) };
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
// A row's share of the total; a dash where its cost shows as one.
export function shareText(row, total) {
  if (row.costUsd === null || row.costUsd === undefined || !(total > 0) || costText(row) === '—') return '—';
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
// build) and the quick answers' row named so (Quick answers · Fix the build, quickTitle);
// Computer, only when a row ran on another computer; Model; In, Out and Cache (tokens
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
    return { session: row.agent === AUTO_LINES.usageRow ? quickTitle(row.title) : `${bot}${row.title || '-'}`, after: row.started === false ? ' (did not start)' : '', computer: row.where || 'here', model: modelLabel(row.model) || '—',
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
