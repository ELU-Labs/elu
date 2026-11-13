import { isObject } from './util.mjs';
import { taskTitle } from './state.mjs';
import { modelName, vendorShort } from './models.mjs';
import { botOfKey } from './bots.mjs';
import { sanitize } from './peer/peerdata.mjs';

// What each agent spent: per run, the tokens and the model the vendor reported (runUsage, kept
// on task.runs[] by the runner); per agent in a session, those runs added up for today or the
// last seven days (agentSpend); and the Usage tab's rows (agentTable). A cost is only ever the
// vendor's own figure. A run whose vendor reported none adds nothing to a cost and marks it
// partial, and an agent none of whose runs reported one has no cost at all.

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
const lines = text => String(text ?? '').split('\n').flatMap(line => { try { const row = JSON.parse(line); return isObject(row) ? [row] : []; } catch { return []; } });
// Claude Code's and Grok Build's result: modelUsage per model when it is there (it also counts
// the smaller models a run called), else usage.
function resultTokens(row) {
  const models = isObject(row.modelUsage) ? Object.entries(row.modelUsage).filter(([, value]) => isObject(value)) : [];
  const fromModels = models.reduce((sum, [, value]) => addTokens(sum, cleanTokens({ input: value.inputTokens, output: value.outputTokens, cacheRead: value.cacheReadInputTokens, cacheWrite: value.cacheCreationInputTokens })), null);
  const usage = isObject(row.usage) ? cleanTokens({ input: row.usage.input_tokens, output: row.usage.output_tokens, cacheRead: row.usage.cache_read_input_tokens, cacheWrite: row.usage.cache_creation_input_tokens }) : null;
  // The model that cost the most, else the first one named.
  const top = [...models].sort(([, a], [, b]) => (money(b.costUSD) ?? 0) - (money(a.costUSD) ?? 0))[0]?.[0];
  return { tokens: fromModels ?? usage, model: typeof top === 'string' && top.length <= 100 ? top : null };
}
// What one run's log says it used, as its vendor reported it: { tokens, model }, each null when
// not reported. Claude Code: the last result event. Codex: every turn.completed event, whose
// input_tokens include the cached ones. Grok Build: its one JSON result. Antigravity reports none.
export function runUsage(vendor, text) {
  const none = { tokens: null, model: null };
  try {
    const rows = lines(text);
    if (vendor === 'claude') { const row = rows.findLast(item => item.type === 'result'); return row ? resultTokens(row) : none; }
    if (vendor === 'grok') { const row = rows.findLast(item => typeof item.text === 'string' && typeof item.stopReason === 'string'); return row ? resultTokens(row) : none; }
    if (vendor === 'codex') {
      const tokens = rows.filter(row => row.type === 'turn.completed' && isObject(row.usage)).reduce((sum, { usage }) => {
        const cached = count(usage.cached_input_tokens) ?? 0, input = count(usage.input_tokens);
        return addTokens(sum, cleanTokens({ input: input === null ? null : Math.max(0, input - cached), output: usage.output_tokens, cacheRead: usage.cached_input_tokens, cacheWrite: usage.cache_write_input_tokens }));
      }, null);
      return { tokens, model: null };
    }
  } catch { /* A log that cannot be read reports nothing. */ }
  return none;
}

// A run counts on the day it ran (a run from before runs had a time: the day its session started).
const runTime = (run, task) => Date.parse(run?.at ?? task?.createdAt ?? '');
const startOfDay = now => { const day = new Date(now); day.setHours(0, 0, 0, 0); return day.getTime(); };
export const inPeriod = (at, now, days = 1) => Number.isFinite(at) && (days === 1 ? new Date(at).toDateString() === new Date(now).toDateString() : at >= startOfDay(now) - (days - 1) * 86400000 && at <= now + 60000);
// Who a run was: @lead, @reviewer, @<bot>. The lead of a chat with one bot is that bot.
export function agentName(role, task) {
  const bot = botOfKey(role);
  if (bot) return `@${bot}`;
  if (role === 'lead' && typeof task?.botChat === 'string' && task.botChat) return `@${task.botChat}`;
  return `@${typeof role === 'string' && role ? role : 'lead'}`;
}
// A model as the row shows it: opus 5.5, gpt-6.1-sol, or the vendor's name for its own default.
export const shortModel = (model, vendor) => (modelName(model) ?? (vendor ? vendorShort(vendor) : '') ?? '').toLowerCase().slice(0, 24);
// Every agent's spend on this computer in a period (days 1: today, 7: the last seven days),
// most cost first: { rows, costUsd, partial }. projects: [{ root, key?, tasks }]; key is the
// project's id a computer of mine is told (lib/peer/remote.mjs). costUsd is the sum of every
// run's known cost (null when none reported one) and partial says some did not, as the spend
// line says it. A row: { root, project, taskId, role, agent, title, model, vendor, tokens,
// costUsd, partial, at }.
export function agentSpend(projects, { now = Date.now(), days = 1 } = {}) {
  const rows = new Map(); let costUsd = null, partial = false;
  for (const project of projects ?? []) for (const task of project?.tasks ?? []) for (const run of Array.isArray(task?.runs) ? task.runs : []) {
    const at = runTime(run, task);
    if (!inPeriod(at, now, days)) continue;
    const cost = money(run.costUsd);
    if (cost === null) partial = true; else costUsd = (costUsd ?? 0) + cost;
    const role = typeof run.role === 'string' && run.role ? run.role : 'lead', key = `${project.root}\0${task.id}\0${role}`;
    const row = rows.get(key) ?? { root: project.root, project: project.key ?? null, taskId: String(task.id), role, agent: agentName(role, task), title: taskTitle(task), model: null, vendor: null, tokens: null, costUsd: null, partial: false, at: 0 };
    if (cost === null) row.partial = true; else row.costUsd = (row.costUsd ?? 0) + cost;
    row.tokens = addTokens(row.tokens, cleanTokens(run.tokens));
    // The model of its latest run that named one.
    if (at >= row.at) { row.at = at; row.vendor = run.vendor ?? row.vendor; if (run.model) row.model = run.model; }
    rows.set(key, row);
  }
  const list = [...rows.values()].map(row => ({ ...row, model: shortModel(row.model, row.vendor), partial: row.partial && row.costUsd !== null, at: new Date(row.at).toISOString() }));
  return { rows: list.sort(byCost), costUsd, partial: partial && costUsd !== null };
}
const tokenSum = tokens => tokens ? tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite : -1;
// Most cost first; one with no cost after every one with a cost; then most tokens, then latest.
export const byCost = (a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || tokenSum(b.tokens) - tokenSum(a.tokens) || String(b.at).localeCompare(String(a.at));
// The spend line: what this computer's agents spent, at least that much when a run reported no cost.
export const spendText = spend => spend.costUsd === null ? 'not reported' : `${spend.partial ? 'at least ' : ''}$${spend.costUsd.toFixed(2)}`;

// What a computer of mine sends with its sessions list (elu.remote.list, optional field
// topAgents): its top agents today and in the last seven days, and what each period cost.
export function topAgentsWire(projects, now = Date.now()) {
  const period = days => { const spend = agentSpend(projects, { now, days }); return { costUsd: spend.costUsd, partial: spend.partial, rows: spend.rows.slice(0, TOP_AGENTS).filter(row => row.project).map(row => ({ ref: `${row.project}:${row.taskId}`, agent: row.agent, title: row.title, model: row.model, tokens: row.tokens, costUsd: row.costUsd, partial: row.partial, at: row.at })) }; };
  return { today: period(1), week: period(7) };
}
const REF = /^[0-9a-f]{16}:[1-9][0-9]{0,9}$/;
const text = (value, max) => sanitize(String(value ?? '').replace(/\s+/g, ' '), max).trim();
// What a computer of mine sent, every field checked: it is my computer, but titles come from
// models and teammates. id(ref): the id this computer knows that session by. null when it sent
// none (a build from before it did).
export function cleanTopAgents(value, id = () => null) {
  if (!isObject(value)) return null;
  const period = item => {
    if (!isObject(item)) return { costUsd: null, partial: false, rows: [] };
    const rows = (Array.isArray(item.rows) ? item.rows : []).slice(0, TOP_AGENTS).filter(row => isObject(row) && REF.test(row.ref ?? '')).map(row => {
      const agent = text(row.agent, 31).replace(/[^@A-Za-z0-9_-]/g, '');
      return { ref: row.ref, id: id(row.ref), agent: /^@[A-Za-z0-9_-]{1,30}$/.test(agent) ? agent : '@lead', title: text(row.title, 80), model: text(row.model, 24).toLowerCase(), tokens: cleanTokens(row.tokens), costUsd: money(row.costUsd), partial: row.partial === true && money(row.costUsd) !== null, at: Number.isFinite(Date.parse(row.at ?? '')) ? new Date(Date.parse(row.at)).toISOString() : new Date(0).toISOString() };
    });
    return { costUsd: money(item.costUsd), partial: item.partial === true && money(item.costUsd) !== null, rows };
  };
  return { today: period(value.today), week: period(value.week) };
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
export const tokensText = tokens => tokens ? `${compact(tokens.input)} · ${compact(tokens.output)} · ${compact(tokens.cacheRead)}` : '—';
export const costText = row => row.costUsd === null || row.costUsd === undefined ? '—' : `${row.partial ? '≥' : ''}$${row.costUsd.toFixed(2)}`;
export function shareText(row, total) {
  if (row.costUsd === null || row.costUsd === undefined || !(total > 0)) return '—';
  const share = row.costUsd / total * 100;
  return share > 0 && share < 1 ? '<1%' : `${Math.round(share)}%`;
}
// The section's table, as plain lines no wider than width: a header, then one line per row.
// rows: [{ agent, title, where, model, tokens, costUsd, partial }]. The session title gives
// room first, down to a few letters; then whole columns go, the rightmost first. A line never
// wraps.
const COST = 'Cost (API price)';
const pad = (value, width, right = false) => { const cut = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value; return right ? cut.padStart(width) : cut.padEnd(width); };
export function agentTable(rows, { width = 80, total = 0 } = {}) {
  const cells = rows.map(row => ({ agent: row.agent, title: row.title || '-', where: row.where ?? '', model: row.model || '-', tokens: tokensText(row.tokens), cost: costText(row), share: shareText(row, total) }));
  const widest = (key, header = '') => Math.max(header.length, ...cells.map(cell => cell[key].length));
  // The tokens header says which number is which; it is as wide as the numbers allow.
  const tokensWidth = widest('tokens', 'Tokens');
  const tokensHeader = ['Tokens in · out · cache', 'in · out · cache', 'Tokens'].find(header => header.length <= tokensWidth);
  const columns = [
    { key: 'agent', header: 'Agent', width: Math.min(16, widest('agent', 'Agent')) },
    { key: 'title', header: 'Session', flex: true, min: 8, max: Math.min(48, widest('title', 'Session')) },
    ...(cells.some(cell => cell.where) ? [{ key: 'where', header: '', width: Math.min(18, widest('where')) }] : []),
    { key: 'model', header: 'Model', width: Math.min(16, widest('model', 'Model')) },
    { key: 'tokens', header: tokensHeader, width: tokensWidth, right: true },
    { key: 'cost', header: COST, width: widest('cost', COST), right: true },
    { key: 'share', header: 'Share', width: widest('share', 'Share'), right: true },
  ];
  const GAP = 2, fixed = list => list.reduce((sum, column) => sum + (column.flex ? column.min : column.width), 0) + GAP * (list.length - 1);
  while (columns.length > 2 && fixed(columns) > width) columns.pop();
  const title = columns.find(column => column.flex);
  title.width = Math.max(title.min, Math.min(title.max, width - fixed(columns) + title.min));
  const line = values => columns.map(column => pad(values[column.key] ?? '', column.width, column.right)).join(' '.repeat(GAP)).trimEnd().slice(0, width);
  return [line(Object.fromEntries(columns.map(column => [column.key, column.header]))), ...cells.map(line)];
}
