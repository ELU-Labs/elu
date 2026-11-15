// A session's /budget: what a role of it has spent, how that reads, and what a turn of a vendor
// that reports its usage while it works has spent so far, so the turn stops at the limit.
import { isObject } from './util.mjs';
import { codexTokens, cleanTokens, moneyText, pricedSpend, runSpends } from './agent-spend.mjs';
import { longPriceOf } from './prices.mjs';

// What a role's runs spent, from the run at index from on: { known, unknown, counted, partial,
// runs }. known: the dollars of the runs whose cost is known, with what a run ELU stopped at the
// limit had spent when it stopped it (stoppedAtUsd), the least that run cost. unknown: how many
// runs have no cost known at all. counted: those of them that count as all of a limit, the most
// they could have spent: the runner keeps each run whose cost it does not know so (costUnknown),
// and a run an ELU before 0.1.26 kept without it counts as it did there, as nothing. partial: some
// run's cost is not all known, or may be more (atLeast, lib/agent-spend.mjs pricedSpend). runs:
// how many there are.
export function roleSpend(task, role, { from = 0 } = {}) {
  let known = 0, unknown = 0, counted = 0, partial = false, runs = 0;
  runSpends(task).forEach((spend, index) => {
    const run = task.runs[index], cost = Number.isFinite(spend?.costUsd) ? spend.costUsd : null;
    if (index < from || !isObject(run) || run.role !== role) return;
    runs++;
    if (cost !== null) { known += cost; if (spend.atLeast === true) partial = true; return; }
    partial = true;
    if (Number.isFinite(run.stoppedAtUsd) && run.stoppedAtUsd >= 0) { known += run.stoppedAtUsd; return; }
    unknown++;
    if (run.costUnknown === true) counted++;
  });
  return { known, unknown, counted, partial, runs };
}
// What was spent, as /budget and a turn stopped at the limit say it, written as the Usage tab
// writes a cost (moneyText): $1.40 when every run's cost is known, ≥$1.40 when some run's is not
// or may be more, <$0.01 for a known cost under a cent, and null when no run's is (nothing is
// known yet). The Kanban card shows no cost; a session's own is in elu conductor --json
// (lib/board.mjs).
export function spentText({ known = 0, unknown = 0, partial = false, runs = 0 } = {}) {
  if (runs > 0 && unknown === runs) return null;
  return moneyText(known, partial);
}
// What /budget alone says. budget: the project's budget(id).
export function budgetMessage({ spent = 0, limit = null, unknown = 0, partial = false, runs = 0 } = {}) {
  const said = spentText({ known: spent, unknown, partial, runs }), money = value => `$${Number(value).toFixed(2)}`;
  if (limit) return said === null ? `What this session has spent is not known yet. Its limit is ${money(limit)}; /budget off removes the limit.` : `This session has spent ${said} of its ${money(limit)} limit. /budget off removes the limit.`;
  return said === null ? 'What this session has spent is not known yet. It has no limit; /budget NUMBER sets one.' : `This session has spent ${said}. It has no limit; /budget NUMBER sets one.`;
}

const add = (a, b) => !a ? b : !b ? a : { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
const less = (a, b) => ({ input: a.input - b.input, output: a.output - b.output, cacheRead: a.cacheRead - b.cacheRead, cacheWrite: a.cacheWrite - b.cacheWrite });
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
// What a turn has spent so far, read from the rows its vendor writes while it works, in dollars at
// the model's list price, or null while nothing priced is known. see(row) takes each row and
// gives that. kind: codex, grok or acp.
// - Codex through its app-server (lib/codex-live.mjs): thread.token_usage, the thread's total
//   and the last request's. The turn's own is the total less what the thread had before its
//   first request. Codex sends the same numbers again when only its rate limits change, so a
//   request counts when the total grows; one whose prompt reached the model's long-context size
//   is at that rate. A turn that goes on with a thread may begin so (its usage limit reached, a
//   compaction), its last request the turn before's: a first total that is still what the
//   thread had used when this session last ran on it (before, lib/agent-spend.mjs
//   codexThreadTotal) is where the turn starts. Codex exec reports its tokens only when the turn ends.
// - Grok Build's streaming-json: a usage row for each model response, by its id, at the short
//   rate, as its run is priced (lib/agent-spend.mjs). Its json output reports only when the
//   turn ends. Its rows name no model: a turn on Grok's own asks find() for its session's
//   model at each row until it has one.
// - ACP: usage_update with the session's cost so far, in dollars. A new session starts from 0;
//   one that goes on starts from the first cost it reports, so its first request is not in it.
//   A vendor that sends no cost has nothing to read here.
// model: the model the turn was started with; for Codex, else the one its thread names.
// working(): the turn goes on, by the rows seen so far: a tool it called still runs (Codex's
// command, file change or other tool item; a Grok Build or ACP tool call), or its last response
// stopped to use one (Grok Build's tool_use). Otherwise the response that reported last may have
// been the turn's last, its answer written, and the turn may be ending.
const TOOL_ITEM = item => isObject(item) && typeof item.id === 'string' && !['agent_message', 'reasoning', 'error', 'todo_list'].includes(item.type);
const MORE = ['tool_use', 'pause_turn'];
export function liveSpend(kind, { model = null, fresh = false, at = Date.now(), find = null, before: had = null } = {}) {
  let spent = null;
  const price = (tokens, long, named) => {
    const dollars = pricedSpend({ vendor: kind, model: named, costUsd: null, tokens, longTokens: long, started: true }, at)?.costUsd;
    return Number.isFinite(dollars) ? dollars : null;
  };
  // The tool calls that run: started, and not ended.
  const tools = new Set();
  const tool = (id, ended) => { if (typeof id !== 'string' || !id) return; if (ended) tools.delete(id); else tools.add(id); };
  if (kind === 'codex') {
    let named = model, base = null, before = null, long = null;
    return { working: () => tools.size > 0, see(row) {
      if (!isObject(row)) return spent;
      if (row.type === 'thread.started' && !model && typeof row.model === 'string' && row.model) named = row.model;
      if (['item.started', 'item.updated', 'item.completed'].includes(row.type) && TOOL_ITEM(row.item)) tool(row.item.id, row.type === 'item.completed');
      if (row.type !== 'thread.token_usage') return spent;
      const total = codexTokens(row.total), last = codexTokens(row.last);
      if (!total) return spent;
      const same = (a, b) => Boolean(a && b) && ['input', 'output', 'cacheRead', 'cacheWrite'].every(key => a[key] === b[key]);
      if (!base) { if (same(total, cleanTokens(had))) base = total; else if (!last) return spent; else base = less(total, last); }
      const grew = !before || ['input', 'output', 'cacheRead', 'cacheWrite'].some(key => total[key] !== before[key]), from = longPriceOf(named, at)?.from;
      if (grew && last && from && count(row.last?.input_tokens) >= from) long = add(long, last);
      before = total;
      const own = less(total, base);
      if (Object.values(own).some(value => value < 0)) return spent;
      spent = price(own, long, named) ?? spent;
      return spent;
    } };
  }
  if (kind === 'grok') {
    const responses = new Map();
    let named = model, more = false;
    return { working: () => more || tools.size > 0, see(row) {
      if (isObject(row) && row.type === 'tool_call') tool(row.toolCallId, ['completed', 'failed'].includes(row.status));
      if (isObject(row) && row.type === 'tool_call_update' && ['completed', 'failed'].includes(row.status)) tool(row.toolCallId, true);
      if (isObject(row) && row.type === 'usage') more = MORE.includes(row.stopReason);
      if (!isObject(row) || row.type !== 'usage' || !isObject(row.usage)) return spent;
      const tokens = cleanTokens({ input: row.usage.input_tokens, output: row.usage.output_tokens, cacheRead: row.usage.cache_read_input_tokens, cacheWrite: row.usage.cache_creation_input_tokens });
      if (!tokens) return spent;
      responses.set(typeof row.messageId === 'string' ? row.messageId : responses.size, tokens);
      if (!named && find) { try { named = find() ?? null; } catch { named = null; } }
      let all = null;
      for (const used of responses.values()) all = add(all, used);
      spent = price(all, null, named) ?? spent;
      return spent;
    } };
  }
  if (kind === 'acp') {
    let base = fresh ? 0 : null;
    return { working: () => tools.size > 0, see(row) {
      const update = isObject(row) ? row.params?.update : null, cost = isObject(update) && update.sessionUpdate === 'usage_update' ? update.cost : null;
      if (isObject(update) && update.sessionUpdate === 'tool_call') tool(update.toolCallId, ['completed', 'failed'].includes(update.status));
      if (isObject(update) && update.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(update.status)) tool(update.toolCallId, true);
      if (!isObject(cost) || !Number.isFinite(cost.amount) || cost.amount < 0 || String(cost.currency ?? '').toUpperCase() !== 'USD') return spent;
      base ??= cost.amount;
      spent = Math.max(0, cost.amount - base);
      return spent;
    } };
  }
  return { working: () => false, see: () => spent };
}
