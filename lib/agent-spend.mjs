import fs from 'node:fs';
import { isObject, linesOf } from './util.mjs';
import { taskTitle } from './state.mjs';
import { modelName, vendorShort } from './models.mjs';
import { botOfKey, getBot } from './bots.mjs';
import { sanitize } from './peer/peerdata.mjs';
import { columns, cut, head, padEnd, padStart } from './width.mjs';

// What each agent spent: per run, the tokens and the cost of that run alone (runSpends, read
// from the run's own log where its record does not hold them); per agent in a session, those
// runs added up for today or the last seven days (agentSpend); and the Usage tab's rows
// (agentTable). A cost is only ever the vendor's own figure. A run whose vendor reported none
// adds nothing to a cost and marks it partial, and says which vendor that was.

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
// What one run's log says it used, as its vendor reported it: { tokens, model }, each null when
// not reported. Claude Code: the last result event, every model it called. Codex: every
// turn.completed event, whose input_tokens include the cached ones. Grok Build: its one JSON
// result, or its end event. A run over ACP (Antigravity, Grok Build): every turn's answer.
// Headless Antigravity reports none.
// The log is gone through a row at a time and only the rows that count are kept, so a log of
// any size is read.
export function runUsage(vendor, text) {
  const none = { tokens: null, model: null };
  try {
    let turns = null, acp = false, last = null;
    // Grok Build: the json object, or a streaming-json run's end event, which carries the same spend.
    const wanted = vendor === 'claude' ? item => item.type === 'result' : vendor === 'grok' ? item => (typeof item.text === 'string' && typeof item.stopReason === 'string') || item.type === 'end' : () => false;
    for (const row of rowsOf(text)) {
      if (row.jsonrpc === '2.0' && isObject(row.result) && typeof row.result.stopReason === 'string') { acp = true; turns = addTokens(turns, acpTokens(row.result)); }
      if (wanted(row)) last = row;
    }
    if (acp) return { tokens: turns, model: null };
    if (vendor === 'claude' || vendor === 'grok') {
      if (!last) return none;
      const { usage, models } = claudeResult(last);
      return { tokens: models ? sumModels(models) : usage, model: topModel(models) };
    }
    if (vendor === 'codex') {
      let tokens = null;
      for (const row of rowsOf(text)) {
        if (row.type !== 'turn.completed' || !isObject(row.usage)) continue;
        const usage = row.usage, cached = count(usage.cached_input_tokens) ?? 0, input = count(usage.input_tokens);
        tokens = addTokens(tokens, cleanTokens({ input: input === null ? null : Math.max(0, input - cached), output: usage.output_tokens, cacheRead: usage.cached_input_tokens, cacheWrite: usage.cache_write_input_tokens }));
      }
      return { tokens, model: null };
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
// What each run of a session spent itself, in the order of task.runs: { vendor, model, costUsd,
// tokens, started } or null for a row that is not a run. A run recorded since its record holds
// its own spend (ownCost) is taken as it is. An older one is read from its log: a Claude Code
// turn that carried its session's totals over counts only what it added, and a run from before
// runs kept their tokens gets them from its log. read(file, vendor): logSpend, or a stand-in.
// wanted(index): the runs to read (the others are null); every run, unless said.
export function runSpends(task, read = logSpend, wanted = () => true) {
  const runs = Array.isArray(task?.runs) ? task.runs : [], logs = new Map();
  const logOf = index => { if (!logs.has(index)) { let value = null; try { value = isObject(runs[index]) ? read(runs[index].logFile, runs[index].vendor) : null; } catch { value = null; } logs.set(index, value); } return logs.get(index); };
  return runs.map((run, index) => {
    if (!isObject(run) || !wanted(index)) return null;
    const vendor = typeof run.vendor === 'string' ? run.vendor : null;
    if (run.ownCost === true) return { vendor, model: runModel(run) ?? run.asked ?? null, costUsd: money(run.costUsd), tokens: cleanTokens(run.tokens), started: run.started !== false };
    return ownRunSpend(runs, index, logOf);
  });
}
// What each run of a session cost by itself, in the order of task.runs: dollars, or null where
// none is known. Whatever adds a session's runs up reads this one (its budget, its stop line,
// its row, its reply to a teammate), so a run from before runs kept their own cost, whose
// record holds what its whole Claude Code session had spent, counts once there too.
export const runCosts = (task, read = logSpend) => runSpends(task, read).map(spend => spend ? spend.costUsd : null);
// One run's own spend, its log and the logs of the runs before it read through logOf(index).
// The runner keeps it with the run (ownCost); runSpends reads it for a run recorded before.
// reported: the model the vendor's result named for the run (the one that cost most), or null;
// model also falls back to what the run was asked for, for showing it. session: the vendor's
// own id of the session it reported; beyond: see ownClaudeSpend.
export function ownRunSpend(runs, index, logOf) {
  const run = runs[index], vendor = typeof run.vendor === 'string' ? run.vendor : null, log = logOf(index);
  const recorded = { vendor, model: runModel(run) ?? run.asked ?? null, costUsd: money(run.costUsd), tokens: cleanTokens(run.tokens), started: true };
  // No log to read (removed): the run as it was recorded.
  if (!log) return recorded;
  if (!log.started) return { ...recorded, model: recorded.model, costUsd: 0, tokens: null, started: false };
  if (vendor !== 'claude') return { ...recorded, model: recorded.model ?? log.model ?? null, reported: log.model ?? null, tokens: recorded.tokens ?? log.tokens ?? null };
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
// A model as the row shows it: opus 5.5, gpt-6.1-sol, or the vendor's name for its own default.
export const shortModel = (model, vendor) => (modelName(model) ?? (vendor ? vendorShort(vendor) : '') ?? '').toLowerCase().slice(0, 24);
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
// Why a cost is at least the figure shown: the runs that reported none, by what ran them.
// claude: a Claude Code run that ended before it wrote its result.
export const UNPRICED = Object.freeze({
  codex: 'Codex reports tokens but no cost, so its runs add no dollars.',
  agy: 'Antigravity reports no cost, and tokens only for a turn over ACP.',
  grok: 'Grok Build reported no cost for a run.',
  claude: 'a Claude Code run stopped before it reported its cost.',
});
const unpricedOf = vendor => Object.hasOwn(UNPRICED, vendor) ? vendor : null;
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
  // A session deleted for good counts as it did before (removed, lib/session-delete.mjs).
  for (const project of projects ?? []) for (const task of [...(project?.tasks ?? []), ...(Array.isArray(project?.removed) ? project.removed : [])]) {
    const list = Array.isArray(task?.runs) ? task.runs : [], stops = (Array.isArray(task?.stops) ? task.stops : []).filter(stop => isObject(stop) && stop.counted !== true && stop.started !== false);
    const within = run => isObject(run) && inPeriod(runTime(run, task), now, days, dayStart);
    if (![...list, ...stops].some(within)) continue;
    const spends = [...runSpends(task, read, index => within(list[index])), ...stops.map(stop => within(stop) ? stopSpend(stop) : null)];
    [...list, ...stops].forEach((run, index) => {
      const at = runTime(run, task), spend = spends[index];
      if (!spend || !inPeriod(at, now, days, dayStart)) return;
      runs++;
      if (spend.model) known.push({ vendor: spend.vendor, model: spend.model });
      const cost = spend.costUsd, why = cost === null ? unpricedOf(spend.vendor) : null;
      if (cost === null) { partial = true; if (why) unpriced.add(why); } else costUsd = (costUsd ?? 0) + cost;
      const role = typeof run.role === 'string' && run.role ? run.role : 'lead', key = `${project.root}\0${task.id}\0${role}`;
      const row = rows.get(key) ?? { root: project.root, project: project.key ?? null, taskId: String(task.id), task, role, models: [], tokens: null, costUsd: null, partial: false, unpriced: [], started: false, at: 0, ...(task.removed === true ? { removed: true } : {}) };
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
// What agents spent, as the spend line says it: at least that much when a run reported no cost.
// No run at all spent nothing; runs none of which reported a cost are not reported.
export const spendText = spend => spend.costUsd === null ? spend.runs === 0 ? '$0.00' : 'not reported' : `${spend.partial ? 'at least ' : ''}$${spend.costUsd.toFixed(2)}`;

// What a computer of mine sends with its sessions list (elu.remote.list, optional field
// topAgents): its top agents today and in the last seven days, and what each period cost.
// dayStart: the start of today where it is shown, when the viewer said. own: each cost is a
// run's own (since 0.1.20). A build before that sends no such word: it added what a whole
// session had spent again for each of its turns, so its costs can be too high, and the viewer
// says so under the table (OLD_COUNT) and beside that computer's part of the spend line.
export function topAgentsWire(projects, now = Date.now(), dayStart = null) {
  const period = days => {
    const spend = agentSpend(projects, { now, days, dayStart });
    return { costUsd: spend.costUsd, partial: spend.partial, runs: spend.runs, unpriced: spend.unpriced, rows: topRows(spend.rows.filter(row => row.project)).map(row => ({ ref: `${row.project}:${row.taskId}`, agent: row.agent, title: row.title, model: row.model, tokens: row.tokens, costUsd: row.costUsd, partial: row.partial, unpriced: row.unpriced, started: row.started, at: row.at })) };
  };
  return { own: true, today: period(1), week: period(7) };
}
export const OLD_COUNT = name => `${name}: older ELU, its costs may be too high. Update ELU there.`;
const REF = /^[0-9a-f]{16}:[1-9][0-9]{0,9}$/;
const text = (value, max) => sanitize(String(value ?? '').replace(/\s+/g, ' '), max).trim();
// An agent's name: @<bot>, or the models a session's own agent ran on (Opus 5.5 + Codex).
const AGENT = /^(?:@[A-Za-z0-9_-]{1,30}|[A-Za-z0-9][A-Za-z0-9 .+_:/-]{0,47})$/;
const cleanUnpriced = value => (Array.isArray(value) ? value : []).filter(item => Object.hasOwn(UNPRICED, item)).filter((item, at, all) => all.indexOf(item) === at);
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
// A row's tokens; one with none says why in words.
export const tokensText = (tokens, row = {}) => tokens ? `${compact(tokens.input)} · ${compact(tokens.output)} · ${compact(tokens.cacheRead)}` : row.started === false ? 'did not start' : 'not reported';
// A row's cost; one that is at least its figure names what reported no cost (UNPRICED).
export function costText(row) {
  const why = row.unpriced?.length ? row.unpriced.map(item => vendorShort(item).toLowerCase()).join(', ') : null;
  if (row.costUsd === null || row.costUsd === undefined) return 'not reported';
  const figure = `$${row.costUsd.toFixed(2)}`;
  return row.partial ? why ? `${figure} + ${why}` : `≥${figure}` : figure;
}
export function shareText(row, total) {
  if (row.costUsd === null || row.costUsd === undefined || !(total > 0)) return '—';
  const share = row.costUsd / total * 100;
  return share > 0 && share < 1 ? '<1%' : `${Math.round(share)}%`;
}
// The section's table, as plain lines no wider than width: a header, then one line per row.
// rows: [{ agent, title, where, model, tokens, costUsd, partial, unpriced, started }]. The
// session title gives room first, down to a few letters; then, until it fits: the share goes,
// the cost header says only Cost, the model goes (a session's agent is named by it), the tokens
// go, and where it ran goes. The cost stays the longest. A line never wraps.
const COSTS = ['Cost (API price)', 'Cost'];
const pad = (value, width, right = false) => { const text = cut(value, width); return right ? padStart(text, width) : padEnd(text, width); };
export function agentTable(rows, { width = 80, total = 0 } = {}) {
  const cells = rows.map(row => ({ agent: row.agent, title: row.title || '-', where: row.where ?? '', model: row.model || '-', tokens: tokensText(row.tokens, row), cost: costText(row), share: shareText(row, total) }));
  const widest = (key, header = '') => Math.max(header.length, ...cells.map(cell => columns(cell[key])));
  // The tokens header says which number is which; it is as wide as the numbers allow.
  const tokensWidth = widest('tokens', 'Tokens');
  const tokensHeader = ['Tokens in · out · cache', 'in · out · cache', 'Tokens'].find(header => header.length <= tokensWidth);
  const cost = { key: 'cost', header: COSTS[0], width: widest('cost', COSTS[0]), right: true };
  let shown = [
    { key: 'agent', header: 'Agent', width: Math.min(20, widest('agent', 'Agent')), min: Math.min(10, widest('agent', 'Agent')) },
    // A session's title keeps 12 columns before the tokens or where it ran give way to it.
    { key: 'title', header: 'Session', flex: true, min: Math.min(12, widest('title', 'Session')), max: Math.min(48, widest('title', 'Session')) },
    ...(cells.some(cell => cell.where) ? [{ key: 'where', header: '', width: Math.min(18, widest('where')) }] : []),
    { key: 'model', header: 'Model', width: Math.min(24, widest('model', 'Model')) },
    { key: 'tokens', header: tokensHeader, width: tokensWidth, right: true },
    cost,
    { key: 'share', header: 'Share', width: widest('share', 'Share'), right: true },
  ];
  const GAP = 2, fixed = list => list.reduce((sum, column) => sum + (column.flex ? column.min : column.width), 0) + GAP * (list.length - 1);
  // A narrow pane drops the share, labels the cost Cost, cuts a long agent name (two models) to
  // 10 columns, then drops the model, the tokens, where it ran and the cost, in that order.
  const agent = shown[0], agentWidth = agent.width;
  const steps = [() => { shown = shown.filter(column => column.key !== 'share'); }, () => { cost.header = COSTS[1]; cost.width = widest('cost', COSTS[1]); }, () => { agent.width = agent.min; },
    ...['model', 'tokens', 'where', 'cost'].map(key => () => { shown = shown.filter(column => column.key !== key); })];
  for (const step of steps) { if (fixed(shown) <= width) break; step(); }
  // What is left goes to the session's title, then back to the agent's name.
  const title = shown.find(column => column.flex), spare = Math.max(0, width - fixed(shown));
  title.width = Math.min(title.max, title.min + spare);
  agent.width = Math.min(agentWidth, agent.width + spare - (title.width - title.min));
  const line = values => head(shown.map(column => pad(values[column.key] ?? '', column.width, column.right)).join(' '.repeat(GAP)).trimEnd(), width);
  return [line(Object.fromEntries(shown.map(column => [column.key, column.header]))), ...cells.map(line)];
}
