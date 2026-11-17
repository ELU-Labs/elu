import { redact } from './publish.mjs';
import { columns as widthOf, head, tail, padEnd, padStart } from './width.mjs';
import { VENDOR_COMMANDS } from './vendors.mjs';
import { DEFAULT_LOGIN } from './logins.mjs';
import { THRESHOLD } from './claude-switch.mjs';
import { checkResult, failedText, uncheckedText } from './conformance.mjs';
import { clockTime } from './terminal-visuals.mjs';

// The Usage tab as lines: the accounts of every vendor with their limits, drawn by
// lib/terminal.mjs, which adds what was spent under them. All display text is untrusted.
const plain = value => redact(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
// The Usage tab's total under its table: what every computer shown spent in the period, at
// least that when a run's cost is not known. parts: [{ name, costUsd, partial, runs }], this
// computer ('here') first, then each computer of mine: one that is online and has not sent
// its list yet, is offline, or runs an ELU that sends none has a note instead of its figure.
// A part marked old is from a computer on a build before 0.1.20, whose costs can be too high.
export function usageTotal(parts, label = 'Today') {
  const known = parts.filter(part => !part.note && part.costUsd !== null && part.costUsd !== undefined), runs = parts.reduce((sum, part) => sum + (part.note ? 0 : part.runs ?? 1), 0);
  const costUsd = known.length ? known.reduce((sum, part) => sum + part.costUsd, 0) : runs === 0 ? 0 : null;
  return { label, costUsd, partial: costUsd !== null && parts.some(part => !part.note && (part.partial || (part.costUsd ?? null) === null && part.runs !== 0)), runs, parts };
}
export const USAGE_NAMES = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', grok: 'Grok Build' };
// A reset time is the clock when it is today, else the day and the clock.
const resetTime = (seconds, now) => { const at = new Date(seconds * 1000); return at.toDateString() === now.toDateString() ? at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : at.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', ''); };
// A reset's day, or its clock when it is today.
const resetDay = (seconds, now) => { const at = new Date(seconds * 1000); return at.toDateString() === now.toDateString() ? resetTime(seconds, now) : at.toLocaleString('en-US', { month: 'short', day: 'numeric' }); };
const dayText = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric' }) : 'unknown';
const pct = value => `${Math.round(value)}%`;
// Claude's usage is what Claude Code reports during a session, so none shows before one.
const CLAUDE_UNSEEN = 'Usage shows after your next session on Claude Code.';
const CLAUDE_ACCOUNT_UNSEEN = 'Usage shows after a session on this account.';

// How full a limit is, by the percent the tab shows for it. USAGE_LEVELS is the one place its
// thresholds are kept: tight from 75% used; FULL from the share at which ELU itself counts a
// Claude account as spent and moves on (THRESHOLD in lib/claude-switch.mjs, 98%), or when the
// vendor said the limit is reached; under 75% it is free. mid is where a free limit's bar turns
// from green to yellow. A limit with no percent and not reached has no level.
export const USAGE_LEVELS = Object.freeze({ mid: 50, tight: 75, full: Math.round(THRESHOLD * 100) });
export function usageLevel(limit) {
  if (limit?.reached) return 'full';
  if (limit?.usedPercent == null) return null;
  const percent = Math.round(limit.usedPercent);
  return percent >= USAGE_LEVELS.full ? 'full' : percent >= USAGE_LEVELS.tight ? 'tight' : 'free';
}
// Four colours: green, yellow from the middle, orange when tight, red when FULL. Never the
// colour alone: the bar and the percent say the same, and a FULL limit has the word.
const limitTone = limit => { const level = usageLevel(limit); return level === 'full' ? 'red' : level === 'tight' ? 'orange' : level === null ? 'muted' : Math.round(limit.usedPercent) >= USAGE_LEVELS.mid ? 'gold' : 'green'; };
const FULL = 'FULL', FILLED = '█', EMPTY = '░';
// How many of a bar's cells are filled: all of them only at 100% or when the limit is reached,
// and at least one once anything is used.
function filledCells(limit, size) {
  if (size <= 0) return 0;
  if (limit.reached) return size;
  if (limit.usedPercent == null) return 0;
  const percent = Math.round(limit.usedPercent);
  return percent >= 100 ? size : Math.min(size - 1, Math.max(percent > 0 ? 1 : 0, Math.round(percent * size / 100)));
}
const share = limit => limit.usedPercent == null ? '—' : pct(limit.usedPercent);
// The time left until a limit starts again: 4h 29m, 1d 18h, 18m. It is counted from the two
// times, so a reset tomorrow morning reads the same before and after midnight. None is left
// once it has started again.
const started = (row, now) => Boolean(row?.resetsAt) && row.resetsAt * 1000 <= now.getTime();
export function timeLeft(resetsAt, now = new Date()) {
  if (!resetsAt || started({ resetsAt }, now)) return '';
  const minutes = Math.floor((resetsAt * 1000 - now.getTime()) / 60000);
  if (minutes < 1) return '<1m';
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
// Every limit a vendor reported for one account, in the order the tab lists them: its 5-hour
// and weekly windows, then each limit that belongs to one model or model family, under the
// name the vendor gives it (Claude's family, capital first: Fable, Opus, Sonnet). A model's
// week alone has the name alone; one with both windows says which. A limit ELU holds a Claude
// account at (spent, lib/claude-switch.mjs) is reached until that time, whatever was read.
// A limit that has started again by now is left out, whenever it was read: the tab stays open
// across a reset, and what was read before it says nothing of the limit now.
// [{ key, label, usedPercent, resetsAt, reached }]
const title = id => id ? id[0].toUpperCase() + id.slice(1) : '';
const reported = row => row?.usedPercent != null || Boolean(row?.resetsAt);
export function accountLimits(item, now = new Date()) {
  const usage = item?.usage, out = [];
  // model: the model's name where the label has a window after it, so a narrow column cuts the name and keeps the window.
  const add = (key, label, row, model = null) => { if (reported(row) && !started(row, now)) out.push({ key, label, ...(model ? { model } : {}), usedPercent: row.usedPercent ?? null, resetsAt: row.resetsAt ?? null, reached: row.reached === true }); };
  add('fiveHour', '5h', usage?.fiveHour); add('weekly', 'wk', usage?.weekly);
  for (const model of usage?.models ?? []) {
    const name = plain(model.name ?? title(model.id));
    add(`${model.id}:fiveHour`, `${name} 5h`, model.fiveHour, name); add(`${model.id}:weekly`, model.fiveHour ? `${name} wk` : name, model.weekly, model.fiveHour ? name : null);
  }
  const spent = item?.spent, until = spent ? Math.ceil(spent.until / 1000) : null;
  const held = !spent || spent.until <= now.getTime() ? null : spent.window === 'model' && spent.model ? [`${spent.model}:weekly`, title(spent.model)] : spent.window === 'fiveHour' ? ['fiveHour', '5h'] : spent.window === 'weekly' ? ['weekly', 'wk'] : null;
  if (held) {
    const found = out.find(limit => limit.key === held[0]);
    if (found) Object.assign(found, { reached: true, resetsAt: until }); else out.push({ key: held[0], label: held[1], usedPercent: null, resetsAt: until, reached: true });
  }
  return out;
}
// The tightest limit: the fullest level, a reached one first, then the most used, and of two
// as used, the one that starts again last.
const RANK = { full: 3, tight: 2, free: 1 };
export const tightest = limits => [...limits].sort((a, b) => (RANK[usageLevel(b)] ?? 0) - (RANK[usageLevel(a)] ?? 0) || Number(b.reached) - Number(a.reached) || (b.usedPercent ?? -1) - (a.usedPercent ?? -1) || (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
// A limit in a few words, where there is no room for its line: Fable 99% FULL.
const limitWords = limit => [limit.label, ...(limit.usedPercent == null ? [] : [pct(limit.usedPercent)]), ...(usageLevel(limit) === 'full' ? [FULL] : [])].join(' ');

// A vendor that needs the one-time check: where it stands, after its sign-in. One that was
// never checked runs in Full access, which needs no check, and in no other mode until c or
// a message in another mode checked it.
const NEEDS_CHECK = 'Full access only (c checks it)';
const checkWord = row => row.running ? 'checking…' : row.check === 'ready' ? 'ready' : row.check === 'failed' ? 'Full access only (c checks again)' : NEEDS_CHECK;
// Words on lines of at most width characters, for what a check says under its vendor.
const wrapWords = (text, width) => plain(text).split(/\s+/).filter(Boolean).reduce((lines, word) => { const last = lines.at(-1); if (last !== undefined && widthOf(`${last} ${word}`) <= width) lines[lines.length - 1] = `${last} ${word}`; else lines.push(word); return lines; }, []);
const otherText = other => { const last = other.usage ? tightest(accountLimits(other, new Date(0))) : null; return [other.account, `last seen ${dayText(other.lastSeen)}`, ...(last?.usedPercent != null ? [`${last.label} ${pct(last.usedPercent)} then`] : [])].join(' · '); };
// The first text that fits room, else as many whole words of the last as do: only a pane too
// narrow for any of them.
function fitted(texts, room) {
  const whole = texts.find(text => widthOf(text) <= room);
  if (whole !== undefined) return whole;
  const [words = ''] = wrapWords(texts.at(-1) ?? '', Math.max(1, room));
  return widthOf(words) <= room ? words : '';
}
// A text too wide for its room keeps its start and its end, with … between: an account is
// told apart by both.
function cutMiddle(text, room) {
  if (widthOf(text) <= room) return text;
  if (room < 2) return head(text, Math.max(0, room));
  const front = Math.ceil((room - 1) / 2);
  return `${head(text, front)}…${tail(text, room - 1 - front)}`;
}
// The columns of the tab. An account's line starts with its vendor's column, then the account
// with its plan; a limit is its name, a bar filled to the share used, the percent and the time
// left, each in a column that is the same on every line of every vendor. A limit that is FULL
// has the word in its bar, which is filled, so it is read without colour too. An account with
// several limits is open or closed (the mark before it says which, as before a file in Changes,
// and f folds or unfolds it): open, each limit has a line of its own under the account; closed,
// its tightest limit stands on the account's own line. An account with one limit is that one
// line, and one with no reading says so in place of a limit.
//
// The account's column is as wide as the widest account would be in use, with its word
// active, so it stays where it is when another account is put in use. Where the pane is too
// narrow for that, the bar gets shorter first (20 cells down to 6); then an account's name is
// cut in its middle, its plan kept while the name keeps 8 columns, the word active always. The
// percent and the time left are never cut. In a pane too narrow to leave an account 12 columns
// beside its limit, the limit goes on the line under it.
const LEAD = 12, GAP = 2, PERCENT = 4, TIME = 7, BAR_MOST = 20, BAR_LEAST = 6, NAME_LEAST = 12, NAME_CUT = 8, ACTIVE = ' · active', OPEN = '▾', CLOSED = '▸';
const USED = 'used', LEFT = 'left';
function layAccounts(lines, width, now, opened) {
  const limited = lines.filter(line => line.limits.length), labelMost = width >= 100 ? 24 : 10;
  const label = Math.min(labelMost, Math.max(2, ...limited.flatMap(line => line.limits.map(limit => widthOf(limit.label)))));
  // How wide an account is in use: another account put in use moves nothing.
  const inUse = line => widthOf(line.name + line.rest) + (line.switchable && !line.active ? widthOf(ACTIVE) : 0), want = Math.max(0, ...lines.map(inUse));
  // What stands beside the account on a limit's line, the bar apart: the gap, the limit's name,
  // the percent and the time left.
  const after = 1 + PERCENT + GAP + TIME, beside = GAP + label + 1 + after;
  const least = Math.max(0, ...lines.filter(line => !line.limits.length).map(line => GAP + widthOf(line.texts.at(-1) ?? '')));
  const bar = limited.length ? Math.max(BAR_LEAST, Math.min(BAR_MOST, width - LEAD - want - beside)) : 0;
  const block = limited.length ? beside + bar : least, column = Math.max(0, Math.min(want, width - LEAD - block));
  const stacked = limited.length > 0 && column < Math.min(NAME_LEAST, want);
  // An account in room columns: whole; else its name cut in the middle, with its plan and the
  // word active after it, or the word alone where the plan leaves the name too little.
  const cell = (line, room) => {
    const whole = line.name + line.rest;
    if (widthOf(whole) <= room) return whole;
    const kept = [line.rest, line.word].find(text => room - widthOf(text) >= NAME_CUT);
    return kept === undefined ? cutMiddle(whole, room) : cutMiddle(line.name, room - widthOf(kept)) + kept;
  };
  // limit: the limit a line of its own is for. part: which of an account's lines it is (usageRowIds).
  const rowOf = (line, parts, more = {}, limit = null) => {
    // Nothing after the last thing a line says: its parts end where its text does.
    const kept = parts.filter((part, at) => at === 0 || part.text !== ''); while (kept.length > 1 && !kept.at(-1).text.trim()) kept.pop();
    kept[kept.length - 1] = { ...kept.at(-1), text: kept.at(-1).text.trimEnd() };
    const which = limit ? `limit:${limit.key}` : line.part;
    return { vendor: line.vendor, login: line.login, text: kept.map(part => part.text).join(''), tone: line.active ? 'orange' : line.tone, bold: line.active, parts: kept, ...more, ...(which ? { part: which } : {}) };
  };
  // The vendor's column, with the mark of an account that folds in its last place but one.
  const leadParts = (line, mark = '') => {
    const marked = mark && line.lead.endsWith('  '), tone = line.tone, bold = line.tone !== 'muted' && line.lead.trim() !== '';
    return marked ? [{ text: line.lead.slice(0, -2), tone, bold }, { text: `${mark} `, tone: 'muted', bold: false }] : [{ text: line.lead, tone, bold }];
  };
  const cellPart = (line, text) => ({ text, tone: line.active ? 'orange' : line.tone, bold: line.active });
  const blank = size => ({ text: ' '.repeat(size), tone: 'text', bold: false });
  // A limit's own columns: its name, bar, percent and the time left. FULL stands in the middle
  // of its bar, drawn as a part of it (inverse), or after the time left where there is no bar.
  const limitParts = (limit, size, wide = label) => {
    const filled = filledCells(limit, size), tone = limitTone(limit), full = usageLevel(limit) === 'full', inBar = full && size >= FULL.length + 2, before = Math.floor((size - FULL.length) / 2);
    // A model's name too long for the column is cut in its middle, the window after it kept.
    const kind = limit.model ? limit.label.slice(limit.model.length) : '', named = limit.model && wide - widthOf(kind) >= 3 ? cutMiddle(limit.model, wide - widthOf(kind)) + kind : cutMiddle(limit.label, wide);
    const cells = inBar ? [{ text: FILLED.repeat(before), tone, bold: false }, { text: FULL, tone, bold: true, inverse: true }, { text: FILLED.repeat(size - FULL.length - before), tone, bold: false }]
      : [{ text: FILLED.repeat(filled), tone, bold: false }, { text: EMPTY.repeat(size - filled), tone: 'dim', bold: false }];
    return [{ text: `${padStart(named, wide)} `, tone: 'muted', bold: false }, ...cells, { text: `${size ? ' ' : ''}${padStart(share(limit), PERCENT)}`, tone, bold: true },
      { text: `${' '.repeat(GAP)}${padStart(timeLeft(limit.resetsAt, now), TIME)}`, tone: 'text', bold: false }, { text: full && !inBar ? ` ${FULL}` : '', tone, bold: true }];
  };
  const drawn = new Map();
  for (const line of lines) {
    const level = usageLevel(line.limits.length ? tightest(line.limits) : null), flips = line.limits.length > 1 && line.login !== null;
    // Open: the account a vendor's next turn uses, and every account with room. f flips one.
    // An account with no sign-in of its own to choose (a vendor with one account) is always open.
    const chosen = flips ? opened?.get(`${line.vendor}\0${line.login}`) : undefined, open = flips ? chosen ?? (line.active || level === 'free' || level === null) : line.limits.length > 1;
    const more = line.limits.length ? { level, ...(flips ? { flips: true, open } : {}) } : {}, mark = flips ? open ? OPEN : CLOSED : '';
    line.level = line.limits.length ? level : null;
    if (!line.limits.length) {
      const tone = line.tone === 'muted' || line.quiet ? 'muted' : 'text', whole = line.name + line.rest;
      if (stacked) {
        // Too narrow for the limits' column: what it says after the account, or on the line under it.
        const named = cell(line, width - LEAD), same = line.texts.find(text => LEAD + widthOf(named) + GAP + widthOf(text) <= width), under = same === undefined ? fitted(line.texts, width - LEAD - GAP) : '';
        drawn.set(line, [rowOf(line, [...leadParts(line), cellPart(line, named), { text: same === undefined ? '' : ' '.repeat(GAP) + same, tone, bold: false }]), ...(under ? [rowOf(line, [blank(LEAD + GAP), { text: under, tone, bold: false }])] : [])]);
        continue;
      }
      // No reading: what it says in place of a limit, in the limits' column, or after an account wider than that.
      const wide = widthOf(whole) > column && LEAD + widthOf(whole) + least <= width;
      const shown = wide ? whole : padEnd(cell(line, column), column), said = fitted(line.texts, width - LEAD - widthOf(shown) - GAP);
      drawn.set(line, [rowOf(line, [...leadParts(line), cellPart(line, shown), { text: said ? ' '.repeat(GAP) + said : '', tone, bold: false }])]);
      continue;
    }
    const shown = open ? line.limits : [tightest(line.limits)];
    if (stacked) {
      // Too narrow for an account beside its limit: the account, then its limits under it, with
      // a bar where the pane has 6 columns for one, and a limit's name cut before a number is.
      const wide = Math.max(2, Math.min(label, width - after - 1 - FULL.length)), room = width - wide - 1 - after - 1;
      const size = room - LEAD >= BAR_LEAST ? Math.min(BAR_MOST, room - LEAD) : room >= BAR_LEAST ? BAR_LEAST : 0, need = wide + 1 + (size ? size + 1 : 1 + FULL.length) + after - 1;
      drawn.set(line, [rowOf(line, [...leadParts(line, mark), cellPart(line, cell(line, width - LEAD))], more),
        ...shown.map(limit => rowOf(line, [blank(Math.max(0, Math.min(LEAD, width - need))), ...limitParts(limit, size, wide)], more, limit))]);
      continue;
    }
    // On one line with its limit, the account has the columns up to that limit's own name,
    // which may be shorter than the column the limits' names have: wk beside Fable's. A name
    // longer than that column is whole while the account keeps 12 columns: the name says which
    // model's limit it is, and the account's own name is cut in its middle first.
    if (!open) {
      const need = widthOf(shown[0].label), least = Math.min(NAME_LEAST, widthOf(line.name + line.rest));
      const own = Math.min(need, Math.max(label, column + label - least)), room = column + label - own;
      drawn.set(line, [rowOf(line, [...leadParts(line, mark), cellPart(line, padEnd(cell(line, room), room) + ' '.repeat(GAP)), ...limitParts(shown[0], bar, own)], more)]);
      continue;
    }
    // Open: the account has its line to itself, so its name is whole wherever the pane has room
    // for it. So has each limit: a name longer than the column of names goes on to the left,
    // under the account, as far as it needs, and its bar stays under the others.
    const reach = LEAD - GAP + column + GAP + label;
    drawn.set(line, [rowOf(line, [...leadParts(line, mark), cellPart(line, cell(line, column + block))], more),
      ...shown.map(limit => { const wide = Math.max(label, Math.min(widthOf(limit.label), reach)); return rowOf(line, [blank(LEAD + column + GAP + label - wide), ...limitParts(limit, bar, wide)], more, limit); })]);
  }
  // Where the percent and the time left end, for the two words over them.
  const used = LEAD + column + GAP + label + 1 + bar + 1 + PERCENT, heads = limited.length && !stacked ? { used, left: used + GAP + TIME } : null;
  return { drawn, heads };
}
// The lines over everything: how many accounts are signed in here over every vendor, and how
// many of them are free, tight and FULL by their tightest limit; then those ELU has no reading
// for. A count of none is left out. Over the limits' columns it says what they are, once: the
// share used, and the time left until the limit starts again. In a pane too narrow for the
// counts on one line they go on to the next, a count never split.
function summaryRows(levels, heads, width) {
  if (!levels.length) return [];
  const count = level => levels.filter(item => item === level).length;
  const counts = [{ text: `${levels.length} account${levels.length === 1 ? '' : 's'}`, tone: 'text', bold: true }];
  for (const [level, word, tone] of [['free', 'free', 'green'], ['tight', 'tight', 'orange'], ['full', FULL, 'red'], [null, 'no reading', 'muted']]) if (count(level)) counts.push({ text: `${count(level)} ${word}`, tone, bold: level === 'full' });
  const rows = [[]], dot = { text: ' · ', tone: 'muted', bold: false }, wide = parts => widthOf(parts.map(part => part.text).join(''));
  for (const part of counts) { const last = rows.at(-1); if (!last.length) last.push(part); else if (wide([...last, dot, part]) <= width) last.push(dot, part); else rows.push([part]); }
  const said = wide(rows[0]);
  if (rows.length === 1 && heads && said + GAP <= heads.used - USED.length && heads.left <= width) rows[0].push({ text: `${' '.repeat(heads.used - USED.length - said)}${USED}${' '.repeat(heads.left - LEFT.length - heads.used)}${LEFT}`, tone: 'muted', bold: false });
  return rows.map(parts => ({ vendor: null, login: null, text: parts.map(part => part.text).join(''), tone: 'text', bold: false, parts, summary: true }));
}
// One block per vendor from usageTab() rows, under the summary line, a rule between the
// vendors. Claude and Codex list every account signed in here with its limits (layAccounts),
// the one new turns use marked active and drawn in the accent colour; then the two settings of
// Claude's accounts, the accounts seen before that are not signed in here, and the keys. Every
// line of an account names the account (login), so Enter on it uses it. Antigravity and Grok
// Build say where they stand with their one-time check after their sign-in; checks holds a
// check c started here, per vendor: { running, lines, current, error }, its lines shown under
// the vendor as the session shows them. width: the pane's (76 in an 80-column terminal).
// opened: the accounts f flipped, by vendor and login: true open, false closed.
export function usageBlocks(rows, { now = new Date(), checks = new Map(), reading = false, width = 76, opened = null } = {}) {
  const out = [], accounts = [], counted = [], rule = { vendor: null, login: null, text: '─'.repeat(width), tone: 'border', bold: false, rule: true };
  for (const row of rows) {
    out.push(rule);
    const name = (USAGE_NAMES[row.vendor] ?? row.vendor).padEnd(LEAD), indent = ' '.repeat(LEAD);
    const add = (text, tone = 'text', bold = false, login = null) => out.push({ vendor: row.vendor, login, text, tone, bold });
    // An account's line, laid out once every vendor's are known. status: what it says in
    // place of its limits (sign in again), unseen: what it says with none reported; each the
    // fullest first, the last the fewest words that still say it. switchable: Enter can put
    // it in use. seen: an account signed in here, which the summary counts.
    const account = (lead, [named, ...more], { login = null, active = false, switchable = false, item = null, status = null, unseen = [], tone = 'text', seen = true, part = null } = {}) => {
      const limits = status ? [] : accountLimits(item, now), words = more.filter(Boolean);
      // rest: its plan and the word active, as they stand after its name; word: that word alone.
      const line = { vendor: row.vendor, login, part, lead, name: named, rest: words.map(word => ` · ${word}`).join(''), word: words.at(-1) === 'active' ? ACTIVE : '', active, switchable, tone, limits, texts: limits.length ? null : status ?? unseen, quiet: !limits.length && !status };
      accounts.push(line); out.push(line); if (seen) counted.push(line);
    };
    const unseen = active => row.vendor !== 'claude' ? ['usage not reported'] : [active ? CLAUDE_UNSEEN : CLAUDE_ACCOUNT_UNSEEN, 'Usage shows after a session.', 'no usage yet'];
    const others = () => { for (const other of row.others ?? []) account(indent, [other.account, other.plan], { tone: 'muted', seen: false, part: `other:${other.account}`, status: [otherText(other).split(' · ').slice(1).join(' · '), `last seen ${dayText(other.lastSeen)}`] }); };
    if (!row.installed) { add(`${name}not installed`, 'muted'); continue; }
    if (row.check) {
      const run = checks.get(row.vendor), state = { ...row, running: run?.running === true }, notes = [];
      // Until it is ready its line is about its sign-in or its check, and names the command
      // after the vendor: the owner installed and types that, not this name.
      const named = VENDOR_COMMANDS[row.vendor] ? `${name}(${VENDOR_COMMANDS[row.vendor]}) ` : name;
      if (!row.signedIn && row.signInRead === false) add(`${named}${row.signedOutText ?? `not signed in. ${row.signInHint}`}`, 'muted');
      else if (!row.signedIn && row.unchecked && !row.runsHere) { add(`${named}this release cannot run here`, 'muted'); notes.push(row.signInReason); }
      // What the tab is waiting for while it reads the sign-in, and why a read gave no answer.
      else if (!row.signedIn && row.unchecked) { add(`${named}${reading ? 'reading its sign-in…' : row.signInReason ? 'sign-in not read' : 'sign-in not read yet'} · ${checkWord(state)}`, 'muted'); if (!reading) notes.push(row.signInReason); }
      // Signed in: an account of this vendor, with no limit ELU reads for it.
      else { add((checkWord(state) === 'ready' ? name : named) + [row.active?.account ?? 'signed in', row.active?.plan, checkWord(state)].filter(Boolean).join(' · '), 'text', true); counted.push({ level: null }); }
      // What its check found, in the words the chat got: what is not proven, and what else it loads here.
      if (!run?.error && !(run && row.check === 'ready')) notes.push(...(row.notes ?? (row.check === 'failed' ? [`Not proven: ${row.notProven}${row.more ? `, and ${row.more} more` : ''}.`] : [])));
      // What the check said: the lines it keeps, then the step it is on, or why it stopped.
      if (run) notes.push(...run.lines, run.running ? run.current : run.error);
      for (const note of notes.filter(Boolean)) for (const line of wrapWords(note, 76 - indent.length)) add(indent + line, 'muted');
      continue;
    }
    if (row.keysHint) {
      // Signed out on the account in use: that is said first, and the others are still listed.
      const listed = (row.accounts ?? []).filter(item => item.account && (row.signedIn || !item.active));
      let first = true; const lead = () => { const text = first ? name : indent; first = false; return text; };
      if (!row.signedIn) add(lead() + `not signed in. ${row.signInHint}`, 'muted');
      for (const item of listed) {
        // A Claude account whose sign-in lapsed says so, and one ELU holds for another reason
        // than a limit it reads (it could not be billed) says until when (lib/claude-switch.mjs).
        const until = item.spentUntil && !['fiveHour', 'weekly'].includes(item.spent?.window ?? 'weekly') ? Math.ceil(item.spentUntil / 1000) : null;
        const status = item.needsSignIn ? ['sign in again'] : until ? [`at its limit until ${resetTime(until, now)}`, `at its limit until ${resetDay(until, now)}`, `until ${resetTime(until, now)}`, `until ${resetDay(until, now)}`] : null;
        // An account ELU holds at a limit with no mark of which (a record of an ELU before this) is held at its week.
        const held = item.spentUntil && !item.spent ? { ...item, spent: { window: 'weekly', until: item.spentUntil } } : item;
        account(lead(), [item.account, item.plan, item.active ? 'active' : null], { login: item.login, active: item.active, switchable: true, item: held, status, unseen: unseen(item.active) });
      }
      // Two or more Claude accounts take over from each other: the two settings of that, each its value only.
      if (row.switches) for (const [setting, label, on] of [['auto', 'Switch accounts by itself', row.switches.auto], ['extraUsage', 'Use paid extra usage', row.switches.extraUsage]]) out.push({ vendor: row.vendor, login: null, setting, part: `setting:${setting}`, text: indent + label.padEnd(27) + (on ? 'on' : 'off'), tone: 'text', bold: false });
      if (row.signedIn && !listed.length) account(lead(), ['signed in', 'active'], { login: row.accounts?.find(item => item.active)?.login ?? DEFAULT_LOGIN, active: true, item: { usage: row.usage }, unseen: unseen(true) });
      others();
      out.push({ vendor: row.vendor, login: null, part: 'keys', text: indent + (listed.length ? row.keysHint : 'a add account'), tone: 'muted', bold: false });
      continue;
    }
    if (!row.signedIn) { add(`${name}${row.signedOutText ?? `not signed in. ${row.signInHint}`}`, 'muted'); continue; }
    account(name, [row.active?.account ?? 'signed in', row.active?.plan, 'active'], { active: true, item: { usage: row.usage }, unseen: unseen(true) });
    others();
  }
  // Each account's lines in their columns: the vendor's name in bold, the account in use in
  // the accent colour (its word active says so without colour), a limit's bar and percent in
  // the colour of how full it is, and what a line says in place of a limit muted. parts: how
  // a line is drawn when it fits the pane.
  const { drawn, heads } = layAccounts(accounts, width, now, opened);
  const summary = summaryRows(counted.map(line => line.level ?? null), heads, width);
  // The rule over the first vendor stands under the summary; with no account there is neither.
  return [...summary, ...out.slice(summary.length ? 0 : 1).flatMap(row => drawn.get(row) ?? [row])];
}
// Which line each line of the tab is, so the cursor stays on its line when a reading adds lines
// over it or takes some away: an agent's by its key; an account's by its vendor and sign-in,
// and a line of its own by its part (a limit, a setting, the line of keys, an account seen
// before); any other by its place among the lines like it (a vendor's notes, Top agents).
export function usageRowIds(rows) {
  const seen = new Map();
  return rows.map(row => {
    const kind = row.key ?? [row.vendor ?? '', row.login ?? '', row.part ?? (row.summary ? 'summary' : row.rule ? 'rule' : row.none ? 'none' : '')].join('\0');
    const place = seen.get(kind) ?? 0; seen.set(kind, place + 1);
    return `${kind}\0${place}`;
  });
}
// A limit's line in the details: its name, bar, percent, FULL when it is, and when it resets.
function limitLine(limit, wide, now) {
  const filled = filledCells(limit, 8);
  return [padEnd(limit.label, wide), ` ${FILLED.repeat(filled)}${EMPTY.repeat(8 - filled)}`, padStart(share(limit), PERCENT + 2), ...(usageLevel(limit) === 'full' ? [`  ${FULL}`] : []), `  ${limit.resetsAt ? `resets ${resetTime(limit.resetsAt, now)}` : limit.usedPercent == null ? 'not reported' : 'reset not reported'}`].join('');
}
// The details dialog for one vendor: when its usage was reported, each limit of the account in
// use with its reset, the other accounts.
// The keys of its lines work in the list, not here, where Enter closes it: it names none.
export function usageDetailLines(row, now = new Date()) {
  if (!row.installed) return ['Not installed.'];
  // Not checked yet: its sign-in as read, then what the check is and that c runs it.
  if (row.unchecked && !row.signedIn) return [row.signInRead === false ? row.signedOutDetail ?? `Not signed in. ${row.signInHint}` : row.signInReason ?? 'Sign-in not read yet. r reads it.', '', uncheckedText(row.vendor), ...(row.runsHere ? ['c runs it now.'] : [])];
  if (!row.signedIn) return [row.signedOutDetail ?? `Not signed in. ${row.signInHint}`];
  const failed = row.check === 'failed' ? checkResult(row.vendor, { bin: row.bin ?? null, version: row.release ?? null }) : null;
  if (failed?.failed.length) return ['Signed in.', '', failedText(row.vendor, failed, { next: false }), 'c runs the check again.'];
  if (row.check && row.check !== 'ready') return ['Signed in.', '', uncheckedText(row.vendor, { bin: row.bin ?? null, version: row.release ?? null }), row.check === 'failed' ? 'c runs it again.' : 'c runs it now.'];
  const lines = [[row.active?.account ?? 'signed in', row.active?.plan, row.active?.tier].filter(Boolean).join(' · ')], usage = row.usage;
  const limits = accountLimits({ usage, spent: row.accounts?.find(item => item.active)?.spent }, now), wide = Math.max(2, ...limits.map(limit => widthOf(limit.label)));
  if (!limits.length) lines.push('', row.vendor === 'claude' ? CLAUDE_UNSEEN : 'Usage not reported.');
  else lines.push(...(usage?.observedAt ? [`Reported ${clockTime(usage.observedAt)}`] : []), '', ...limits.map(limit => limitLine(limit, wide, now)));
  const signedIn = (row.accounts ?? []).filter(item => item.account && !item.active);
  if (signedIn.length) lines.push('', 'Also signed in', ...signedIn.map(item => { const limit = item.needsSignIn ? null : tightest(accountLimits(item, now)); return [item.account, item.plan, item.needsSignIn ? 'sign in again' : limit ? limitWords(limit) : null].filter(Boolean).join(' · '); }));
  if (row.others?.length) lines.push('', 'Other accounts', ...row.others.map(other => [other.account, other.plan, `first seen ${dayText(other.firstSeen)}`, otherText(other).split(' · ').slice(1).join(' · ')].filter(Boolean).join(' · ')));
  if (row.notes?.length) lines.push('', ...row.notes);
  return lines;
}
